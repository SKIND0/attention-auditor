from flask import Flask, request, jsonify, render_template, session, redirect, url_for, g
from flask_cors import CORS
from openai import OpenAI
import mysql.connector
from datetime import date, datetime
from functools import wraps
import time
import uuid as uuid_mod
from collections import deque, defaultdict
from urllib.parse import urlparse, urlunparse
from werkzeug.middleware.proxy_fix import ProxyFix

from builtin_categories import BUILTIN_SITE_CATEGORIES

app = Flask(__name__)
# Railway terminates TLS in front of Gunicorn; trust forwarded Host / proto so request.host_url matches the browser.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1, x_prefix=1)

import os

IS_DEBUG = os.environ.get("FLASK_DEBUG") == "1"
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or (
    "dev-local-attention-auditor-not-for-production" if IS_DEBUG else None
)
if not app.secret_key:
    raise RuntimeError("Set FLASK_SECRET_KEY for production (required for login sessions).")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("SESSION_COOKIE_SECURE", "0") == "1"
# Prevent huge POST bodies (basic DoS protection for public deploys).
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_CONTENT_LENGTH", str(64 * 1024)))  # 64KB default

def _parse_origins(value: str):
    return [o.strip() for o in (value or "").split(",") if o.strip()]

# CORS: allow only known dashboard origins (comma-separated).
# Note: CORS is NOT authentication; it only controls which browser origins can read responses.
cors_origins = _parse_origins(
    os.environ.get(
        "CORS_ORIGINS",
        "https://attention-auditor-production.up.railway.app,http://127.0.0.1:5000,http://localhost:5000",
    )
)
CORS(app, resources={r"/api/*": {"origins": cors_origins}})

API_KEY = None  # Removed — Device ID + rate limiting is the security model

def _safe_redirect_path(raw_next):
    if (
        isinstance(raw_next, str)
        and raw_next.startswith("/")
        and not raw_next.startswith("//")
    ):
        return raw_next
    return "/"


def _normalize_client_token(raw):
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    try:
        uuid_mod.UUID(s)
        return s
    except (ValueError, AttributeError, TypeError):
        return None


AUTO_CATEGORIZE_ON_TRACK = os.environ.get("AUTO_CATEGORIZE_ON_TRACK") == "1"
MAX_NEW_DOMAINS_TO_CATEGORIZE_PER_TRACK = int(os.environ.get("MAX_NEW_DOMAINS_TO_CATEGORIZE_PER_TRACK", "5"))
MAX_SITES_PER_TRACK = int(os.environ.get("MAX_SITES_PER_TRACK", "250"))
MAX_SECONDS_PER_SITE = int(os.environ.get("MAX_SECONDS_PER_SITE", str(24 * 60 * 60)))  # 24h cap per post row
TRACK_RATE_LIMIT_PER_MINUTE = int(os.environ.get("TRACK_RATE_LIMIT_PER_MINUTE", "60"))

FEEDBACK_RATE_LIMIT_PER_MINUTE = int(os.environ.get("FEEDBACK_RATE_LIMIT_PER_MINUTE", "6"))
CATEGORIZE_ALL_RATE_LIMIT_PER_HOUR = int(os.environ.get("CATEGORIZE_ALL_RATE_LIMIT_PER_HOUR", "3"))

RATE_LIMIT_STORAGE = os.environ.get("RATE_LIMIT_STORAGE", "mysql").lower()  # mysql|memory
RATE_LIMIT_TABLE = os.environ.get("RATE_LIMIT_TABLE", "rate_limits")

_rate_state = {}  # memory fallback

def _client_ip():
    # Railway/most proxies: X-Forwarded-For is present. Take the first IP.
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or "unknown"

def _ensure_rate_limit_table():
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {RATE_LIMIT_TABLE} (
            bucket_key VARCHAR(255) PRIMARY KEY,
            window_id BIGINT NOT NULL,
            count INT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_window_id (window_id)
        )
        """
    )
    conn.commit()
    cur.close()
    conn.close()

_rate_table_ready = False

def rate_limit(limit: int, window_seconds: int, key_prefix: str):
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            ip = _client_ip()
            now = time.time()

            if RATE_LIMIT_STORAGE == "mysql":
                global _rate_table_ready
                if not _rate_table_ready:
                    _ensure_rate_limit_table()
                    _rate_table_ready = True

                window_id = int(now // window_seconds)
                bucket_key = f"{key_prefix}:{ip}:{window_id}"

                conn = get_db()
                cur = conn.cursor()
                # Atomic increment per window bucket
                cur.execute(
                    f"""
                    INSERT INTO {RATE_LIMIT_TABLE} (bucket_key, window_id, count)
                    VALUES (%s, %s, 1)
                    ON DUPLICATE KEY UPDATE count = count + 1
                    """,
                    (bucket_key, window_id),
                )
                conn.commit()

                cur.execute(
                    f"SELECT count FROM {RATE_LIMIT_TABLE} WHERE bucket_key = %s",
                    (bucket_key,),
                )
                row = cur.fetchone()
                cur.close()
                conn.close()

                count = int(row[0]) if row else 1
                if count > limit:
                    # Retry after until next window
                    next_window_start = (window_id + 1) * window_seconds
                    retry_after = int(max(1, next_window_start - now))
                    return (
                        jsonify({"error": "Rate limit exceeded", "retry_after_seconds": retry_after}),
                        429,
                        {"Retry-After": str(retry_after)},
                    )

                return fn(*args, **kwargs)

            # Memory fallback (non-persistent)
            key = f"{key_prefix}:{ip}"
            dq = _rate_state.get(key)
            if dq is None:
                dq = deque()
                _rate_state[key] = dq

            cutoff = now - window_seconds
            while dq and dq[0] < cutoff:
                dq.popleft()

            if len(dq) >= limit:
                retry_after = int(max(1, (dq[0] + window_seconds) - now))
                return (
                    jsonify({"error": "Rate limit exceeded", "retry_after_seconds": retry_after}),
                    429,
                    {"Retry-After": str(retry_after)},
                )

            dq.append(now)
            return fn(*args, **kwargs)
        return wrapper
    return decorator

def _provided_api_key():
    header_key = request.headers.get("X-ATTENTION-AUDITOR-KEY")
    auth = request.headers.get("Authorization", "")
    bearer = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else None
    return header_key or bearer


def _api_key_matches():
    if not API_KEY:
        return True
    return _provided_api_key() == API_KEY


def _origin_scheme_variants(base: str):
    """Same host as both https:// and http:// so dashboard auth works behind TLS-terminated proxies."""
    out = set()
    raw = (base or "").strip().rstrip("/")
    if not raw:
        return out
    out.add(raw)
    try:
        if "://" not in raw:
            parsed = urlparse("https://" + raw)
        else:
            parsed = urlparse(raw)
        host = (parsed.netloc or "").strip()
        if not host:
            return out
        for scheme in ("https", "http"):
            out.add(urlunparse((scheme, host, "", "", "", "")).rstrip("/"))
    except Exception:
        pass
    return out


def _dashboard_allowed_origins():
    allowed = set()
    for o in _parse_origins(os.environ.get("DASHBOARD_ORIGINS", "")):
        allowed.update(_origin_scheme_variants(o))
    for o in cors_origins:
        if o:
            allowed.update(_origin_scheme_variants(o))
    allowed.update(_origin_scheme_variants(request.host_url.rstrip("/")))
    railway_dom = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
    if railway_dom:
        allowed.update(_origin_scheme_variants(f"https://{railway_dom}"))
    return allowed


def _request_hostname():
    h = (request.host or "").strip()
    if not h:
        return None
    return h.split(":")[0].lower()


def _url_hostname(url):
    if not url:
        return None
    try:
        u = url.strip()
        if not u:
            return None
        if "://" not in u:
            u = "https://" + u
        hn = urlparse(u).hostname
        return hn.lower() if hn else None
    except Exception:
        return None


def _dashboard_browser_allowed():
    """Allow GET /api/* reads from the hosted dashboard without pasting a key (same-origin)."""
    if not API_KEY:
        return True
    origin = (request.headers.get("Origin") or "").strip().rstrip("/")
    referer = (request.headers.get("Referer") or "").strip()

    allowed = _dashboard_allowed_origins()

    def matches_any(url):
        if not url:
            return False
        u = url.rstrip("/")
        for base in allowed:
            if not base:
                continue
            b = base.rstrip("/")
            if u == b or u.startswith(b + "/"):
                return True
        return False

    if origin and matches_any(origin):
        return True
    if referer and matches_any(referer):
        return True
    # Railway/public URL drift: trust requests whose Origin/Referer hostname equals this app's Host
    req_h = _request_hostname()
    if req_h:
        for cand in (origin, referer):
            if _url_hostname(cand) == req_h:
                return True
    # Navigate-from-URL-bar / strict browsers: same Host as request
    if request.host:
        host_only_origins = _origin_scheme_variants(request.host)
        if origin and origin in host_only_origins:
            return True
        if referer:
            try:
                ru = urlparse(referer)
                if ru.netloc == request.host:
                    return True
            except Exception:
                pass
    return False


def require_extension_client_token(fn):
    """Extension POST bodies must include X-Client-Token (UUID) — one logical user per browser profile."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        ct = _normalize_client_token(request.headers.get("X-Client-Token"))
        if not ct:
            return jsonify({"error": "Missing or invalid X-Client-Token (copy Device ID from the extension popup)"}), 400
        g.client_token = ct
        return fn(*args, **kwargs)

    return wrapper


def require_dashboard_data(fn):
    """Dashboard JSON APIs: session login stores client_token, or API key + X-Client-Token for automation."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        ct = _normalize_client_token(session.get("client_token"))
        hdr_ct = _normalize_client_token(request.headers.get("X-Client-Token"))
        if API_KEY and _api_key_matches() and hdr_ct:
            ct = hdr_ct
        if not ct:
            return jsonify({"error": "Login required", "login": "/login"}), 401

        if API_KEY:
            if not (_api_key_matches() or _dashboard_browser_allowed()):
                return jsonify({"error": "Unauthorized"}), 401
        else:
            if not _dashboard_browser_allowed():
                return jsonify({"error": "Unauthorized"}), 401

        g.client_token = ct
        return fn(*args, **kwargs)

    return wrapper


def require_category_write(fn):
    """Logged-in dashboard (same-origin) or extension: API key + X-Client-Token when key is set."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        hdr_ct = _normalize_client_token(request.headers.get("X-Client-Token"))
        sess_ct = _normalize_client_token(session.get("client_token"))

        if API_KEY:
            if _api_key_matches() and hdr_ct:
                g.client_token = hdr_ct
                return fn(*args, **kwargs)
            if sess_ct and _dashboard_browser_allowed():
                g.client_token = sess_ct
                return fn(*args, **kwargs)
            return (
                jsonify(
                    {
                        "error": "Unauthorized",
                        "hint": "Open /login in this browser, or send X-ATTENTION-AUDITOR-KEY and X-Client-Token.",
                    }
                ),
                401,
            )

        ct = hdr_ct or sess_ct
        if not ct:
            return jsonify({"error": "Login at /login or send X-Client-Token"}), 401
        g.client_token = ct
        return fn(*args, **kwargs)

    return wrapper


db_host = os.environ.get("MYSQLHOST") or os.environ.get("MYSQL_HOST", "localhost")
db_port = int(os.environ.get("MYSQLPORT") or os.environ.get("MYSQL_PORT", 3306))
db_user = os.environ.get("MYSQLUSER") or os.environ.get("MYSQL_USER", "root")
db_password = os.environ.get("MYSQLPASSWORD") or os.environ.get("MYSQL_PASSWORD")
if not db_password:
    if IS_DEBUG:
        db_password = input("Enter MySQL password: ")
    else:
        raise RuntimeError("Missing MySQL password. Set MYSQLPASSWORD or MYSQL_PASSWORD.")
db_name = os.environ.get("MYSQLDATABASE") or os.environ.get("MYSQL_DATABASE", "attention_auditor")

openai_api_key = os.environ.get("OPENAI_API_KEY")
openai_client = OpenAI(api_key=openai_api_key) if openai_api_key else None


def _openai_ready():
    return openai_client is not None

_AI_CATEGORY_SYSTEM = (
    "You label domains for a student productivity app. Answer with exactly one word: "
    "productive, distracting, or neutral.\n"
    "- productive: school, homework, coding, developer tools (GitHub, CI/CD, cloud dashboards, docs, package registries), "
    "email, calendar, class video calls, learning sites, research.\n"
    "- distracting: social feeds, short video, streaming TV, games, meme / gossip news.\n"
    "- neutral: shopping, banking, maps, generic search, travel booking, utilities when unclear.\n"
    "If unsure, answer neutral. Domain:"
)


def effective_category(domain, db_category):
    """DB row wins (user/ai/default); otherwise built-in map; else neutral."""
    if db_category is not None:
        return db_category
    return BUILTIN_SITE_CATEGORIES.get(domain, "neutral")


def enrich_site_rows(rows):
    for row in rows:
        row["category"] = effective_category(row["domain"], row.get("category"))
    return rows


def _upsert_builtin_category(cursor, client_token, domain):
    """Insert server default row if domain is in the built-in map; never overwrite user overrides."""
    if domain not in BUILTIN_SITE_CATEGORIES:
        return
    cat = BUILTIN_SITE_CATEGORIES[domain]
    cursor.execute(
        """INSERT INTO site_categories (client_token, domain, category, source)
           VALUES (%s, %s, %s, 'default')
           ON DUPLICATE KEY UPDATE
             category = IF(source = 'user', category, %s),
             source = IF(source = 'user', source, 'default')""",
        (client_token, domain, cat, cat),
    )


def get_db():
    return mysql.connector.connect(
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_password,
        database=db_name
    )
def categorize_domain(client_token, domain):
    """Per-user DB row first; else built-in list; else OpenAI."""
    conn = get_db()
    cur = conn.cursor(dictionary=True)

    cur.execute(
        "SELECT category FROM site_categories WHERE client_token = %s AND domain = %s",
        (client_token, domain),
    )
    row = cur.fetchone()

    if row:
        cur.close()
        conn.close()
        return row["category"]

    if domain in BUILTIN_SITE_CATEGORIES:
        cat = BUILTIN_SITE_CATEGORIES[domain]
        cur.close()
        cur2 = conn.cursor()
        _upsert_builtin_category(cur2, client_token, domain)
        conn.commit()
        cur2.close()
        conn.close()
        return cat

    cur.close()
    if not _openai_ready():
        # No OpenAI key configured — default unknown domains to neutral and cache it.
        category = "neutral"
        cur3 = conn.cursor()
        cur3.execute(
            "INSERT INTO site_categories (client_token, domain, category, source) VALUES (%s, %s, %s, 'default')",
            (client_token, domain, category),
        )
        conn.commit()
        cur3.close()
        conn.close()
        return category
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=12,
        messages=[
            {"role": "system", "content": _AI_CATEGORY_SYSTEM},
            {"role": "user", "content": domain},
        ],
    )

    category = response.choices[0].message.content.strip().lower()
    for token in ("productive", "distracting", "neutral"):
        if token in category:
            category = token
            break
    else:
        category = "neutral"

    cur3 = conn.cursor()
    cur3.execute(
        "INSERT INTO site_categories (client_token, domain, category, source) VALUES (%s, %s, %s, 'ai')",
        (client_token, domain, category),
    )
    conn.commit()
    cur3.close()
    conn.close()
    return category


@app.route("/login", methods=["GET", "POST"])
def login():
    err = None
    next_default = _safe_redirect_path(request.args.get("next"))
    if request.method == "POST":
        token = (request.form.get("client_token") or "").strip()
        ct = _normalize_client_token(token)
        next_url = _safe_redirect_path(request.form.get("next")) or next_default
        next_for_form = next_url
        if not ct:
            err = "Paste the UUID from your extension (Device ID)."
            return render_template("login.html", error=err, next=next_for_form)
        session["client_token"] = ct
        session.permanent = True
        return redirect(next_url)
    return render_template("login.html", error=err, next=next_default)


@app.route("/logout")
def logout():
    session.pop("client_token", None)
    return redirect(url_for("login"))


@app.route("/api/track", methods=["POST"])
@require_extension_client_token
@rate_limit(limit=TRACK_RATE_LIMIT_PER_MINUTE, window_seconds=60, key_prefix="track")
def track():
    data = request.get_json()
    if not data or "sites" not in data:
        return jsonify({"error": "No data provided"}), 400

    ct = g.client_token

    record_date_str = data.get("date")
    try:
        record_date = date.fromisoformat(record_date_str) if record_date_str else date.today()
    except ValueError:
        record_date = date.today()

    conn = get_db()
    cursor = conn.cursor()

    sites = data.get("sites") or []
    if not isinstance(sites, list):
        return jsonify({"error": "Invalid payload (sites must be a list)"}), 400
    if len(sites) > MAX_SITES_PER_TRACK:
        return jsonify({"error": f"Too many sites in one request (max {MAX_SITES_PER_TRACK})"}), 413

    tracked_domains = []
    seen_track = set()
    received_at = datetime.now()
    for site in sites:
        if not isinstance(site, dict):
            continue
        domain = (site.get("domain") or "").strip().lower()
        seconds = site.get("seconds", 0)
        try:
            seconds = int(seconds)
        except Exception:
            seconds = 0
        if not domain or seconds <= 0:
            continue
        if seconds > MAX_SECONDS_PER_SITE:
            seconds = MAX_SECONDS_PER_SITE

        if domain not in seen_track:
            seen_track.add(domain)
            tracked_domains.append(domain)

        cursor.execute(
            "INSERT INTO browsing_data (client_token, domain, seconds_spent, recorded_at) VALUES (%s, %s, %s, %s)",
            (ct, domain, seconds, received_at),
        )
        cursor.execute(
            """INSERT INTO daily_summary (client_token, domain, total_seconds, visit_date)
               VALUES (%s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE total_seconds = total_seconds + %s""",
            (ct, domain, seconds, record_date, seconds),
        )

    conn.commit()
    for dom in tracked_domains:
        _upsert_builtin_category(cursor, ct, dom)
    conn.commit()
    cursor.close()
    conn.close()

    # Avoid accidental OpenAI/cost work from normal tracking.
    # If explicitly enabled, only categorize domains that are truly uncategorized (capped).
    if AUTO_CATEGORIZE_ON_TRACK:
        incoming_domains = []
        for site in data["sites"]:
            d = (site.get("domain") or "").strip()
            if d:
                incoming_domains.append(d)
        # De-dup preserving order
        seen = set()
        incoming_domains = [d for d in incoming_domains if not (d in seen or seen.add(d))]

        if incoming_domains:
            conn = get_db()
            cur = conn.cursor()
            placeholders = ",".join(["%s"] * len(incoming_domains))
            cur.execute(
                f"SELECT domain FROM site_categories WHERE client_token = %s AND domain IN ({placeholders})",
                (ct, *incoming_domains),
            )
            categorized = {row[0] for row in cur.fetchall()}
            cur.close()
            conn.close()

            to_categorize = [d for d in incoming_domains if d not in categorized]
            to_categorize = to_categorize[:MAX_NEW_DOMAINS_TO_CATEGORIZE_PER_TRACK]

            for domain in to_categorize:
                try:
                    categorize_domain(ct, domain)
                except Exception as e:
                    print(f"Could not categorize {domain}: {e}")

    return jsonify({"status": "ok"}), 200


@app.route("/api/stats", methods=["GET"])
@require_dashboard_data
def stats():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    ct = g.client_token
    today_str = request.args.get("date", str(date.today()))

    cursor.execute(
        """SELECT d.domain, d.total_seconds, c.category AS category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.client_token = c.client_token AND d.domain = c.domain
           WHERE d.client_token = %s AND d.visit_date = %s
           ORDER BY d.total_seconds DESC""",
        (ct, today_str),
    )
    today = enrich_site_rows(cursor.fetchall())

    cursor.execute(
        """SELECT d.domain, SUM(d.total_seconds) AS total_seconds, MAX(c.category) AS category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.client_token = c.client_token AND d.domain = c.domain
           WHERE d.client_token = %s
           GROUP BY d.domain
           ORDER BY total_seconds DESC""",
        (ct,),
    )
    all_time = enrich_site_rows(cursor.fetchall())

    cursor.close()
    conn.close()
    return jsonify({"today": today, "all_time": all_time}), 200

@app.route("/")
def dashboard():
    if not _normalize_client_token(session.get("client_token")):
        return redirect(url_for("login", next="/"))
    return render_template("dashboard.html")


@app.route("/api/stats/weekly", methods=["GET"])
@require_dashboard_data
def weekly_stats():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    ct = g.client_token

    cursor.execute(
        """SELECT visit_date, domain, total_seconds
           FROM daily_summary
           WHERE client_token = %s
             AND visit_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
           ORDER BY visit_date DESC, total_seconds DESC""",
        (ct,),
    )
    rows = cursor.fetchall()

    weekly = {}
    for row in rows:
        day = str(row["visit_date"])
        if day not in weekly:
            weekly[day] = []
        weekly[day].append({
            "domain": row["domain"],
            "total_seconds": row["total_seconds"]
        })

    cursor.execute(
        """SELECT visit_date, SUM(total_seconds) as total
           FROM daily_summary
           WHERE client_token = %s
             AND visit_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
           GROUP BY visit_date
           ORDER BY visit_date ASC""",
        (ct,),
    )
    daily_totals = cursor.fetchall()
    for row in daily_totals:
        row["visit_date"] = str(row["visit_date"])

    cursor.close()
    conn.close()
    return jsonify({"by_day": weekly, "daily_totals": daily_totals}), 200


@app.route("/api/categories", methods=["GET"])
@require_dashboard_data
def get_categories():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        "SELECT domain, category, source FROM site_categories WHERE client_token = %s ORDER BY category, domain",
        (g.client_token,),
    )
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route("/api/categorize-all", methods=["POST"])
@require_extension_api_key
@require_extension_client_token
@rate_limit(limit=CATEGORIZE_ALL_RATE_LIMIT_PER_HOUR, window_seconds=60 * 60, key_prefix="categorize_all")
def categorize_all():
    """Find all domains in browsing data that aren't categorized yet and categorize them."""
    ct = g.client_token
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        """SELECT DISTINCT d.domain FROM daily_summary d
           WHERE d.client_token = %s
           AND NOT EXISTS (
             SELECT 1 FROM site_categories c
             WHERE c.client_token = d.client_token AND c.domain = d.domain
           )""",
        (ct,),
    )
    uncategorized = cursor.fetchall()
    cursor.close()
    conn.close()

    results = {}
    for row in uncategorized:
        domain = row["domain"]
        category = categorize_domain(ct, domain)
        results[domain] = category

    return jsonify({"categorized": results, "count": len(results)}), 200


@app.route("/api/categories/update", methods=["POST"])
@require_category_write
def update_category():
    data = request.get_json()
    domain = data.get("domain")
    category = data.get("category")

    if not domain or category not in ("productive", "distracting", "neutral"):
        return jsonify({"error": "Provide domain and category (productive/distracting/neutral)"}), 400

    ct = g.client_token
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """INSERT INTO site_categories (client_token, domain, category, source)
           VALUES (%s, %s, %s, 'user')
           ON DUPLICATE KEY UPDATE category = %s, source = 'user'""",
        (ct, domain, category, category),
    )
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"domain": domain, "category": category, "source": "user"}), 200

@app.route("/api/feedback", methods=["GET"])
@require_dashboard_data
@rate_limit(limit=FEEDBACK_RATE_LIMIT_PER_MINUTE, window_seconds=60, key_prefix="feedback")
def feedback():
    personality = request.args.get("personality", "coach")
    if not _openai_ready():
        return (
            jsonify(
                {
                    "feedback": "AI feedback is disabled (missing OPENAI_API_KEY). Set OPENAI_API_KEY to enable Coach/Advisor/Mentor output.",
                    "personality": personality,
                }
            ),
            200,
        )

    personalities = {
        "coach": "You are an encouraging productivity coach. Be motivational but honest. Use a supportive, energetic tone. Keep it to 3-4 sentences.",
        "advisor": "You are a direct, no-nonsense productivity advisor. Be blunt and straightforward about what needs to change. Keep it to 3-4 sentences.",
        "mentor": "You are a gentle, wise mentor. Be kind and understanding while nudging toward better habits. Use a calm, thoughtful tone. Keep it to 3-4 sentences."
    }

    system_prompt = personalities.get(personality, personalities["coach"])

    ct = g.client_token
    today_str = request.args.get("date", str(date.today()))

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute(
        """SELECT d.domain, d.total_seconds, c.category AS category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.client_token = c.client_token AND d.domain = c.domain
           WHERE d.client_token = %s AND d.visit_date = %s
           ORDER BY d.total_seconds DESC""",
        (ct, today_str),
    )
    today = enrich_site_rows(cursor.fetchall())

    cursor.close()
    conn.close()

    if not today:
        return jsonify({"feedback": "No browsing data for today yet. Go browse and come back!", "personality": personality}), 200

    productive_time = sum(s["total_seconds"] for s in today if s["category"] == "productive")
    distracting_time = sum(s["total_seconds"] for s in today if s["category"] == "distracting")
    neutral_time = sum(s["total_seconds"] for s in today if s["category"] == "neutral")

    summary = f"Today's browsing data:\n"
    summary += f"Productive time: {productive_time // 60} minutes\n"
    summary += f"Distracting time: {distracting_time // 60} minutes\n"
    summary += f"Neutral time: {neutral_time // 60} minutes\n\n"
    summary += "Sites visited (most time first):\n"
    for site in today[:10]:
        mins = site["total_seconds"] // 60
        summary += f"- {site['domain']}: {mins} min ({site['category']})\n"

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=200,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": summary}
        ]
    )

    feedback_text = response.choices[0].message.content.strip()

    return jsonify({"feedback": feedback_text, "personality": personality}), 200


@app.route("/api/anomalies", methods=["GET"])
@require_dashboard_data
def anomalies():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    ct = g.client_token
    today_str = request.args.get("date", str(date.today()))

    cursor.execute(
        """SELECT d.domain, d.total_seconds, c.category AS category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.client_token = c.client_token AND d.domain = c.domain
           WHERE d.client_token = %s AND d.visit_date = %s
           ORDER BY d.total_seconds DESC""",
        (ct, today_str),
    )
    today = enrich_site_rows(cursor.fetchall())

    cursor.execute(
        """SELECT d.domain,
                  ROUND(AVG(d.total_seconds)) AS avg_seconds,
                  COUNT(DISTINCT d.visit_date) AS days_seen
           FROM daily_summary d
           WHERE d.client_token = %s
             AND d.visit_date >= DATE_SUB(%s, INTERVAL 7 DAY)
             AND d.visit_date < %s
           GROUP BY d.domain""",
        (ct, today_str, today_str),
    )
    averages = {row["domain"]: row for row in cursor.fetchall()}

    cursor.execute(
        """SELECT d.visit_date, d.domain, d.total_seconds, c.category AS category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.client_token = c.client_token AND d.domain = c.domain
           WHERE d.client_token = %s
             AND d.visit_date >= DATE_SUB(%s, INTERVAL 7 DAY)
             AND d.visit_date < %s""",
        (ct, today_str, today_str),
    )
    hist = cursor.fetchall()
    cursor.close()
    conn.close()

    per_day = defaultdict(lambda: {"productive": 0, "distracting": 0, "neutral": 0})
    for row in hist:
        cat = effective_category(row["domain"], row["category"])
        per_day[row["visit_date"]][cat] += row["total_seconds"]

    cat_avgs = {}
    if per_day:
        n = len(per_day)
        for cat in ("productive", "distracting", "neutral"):
            cat_avgs[cat] = int(sum(per_day[d][cat] for d in per_day) / n)

    # Find anomalies
    flags = []

    productive_today = sum(s["total_seconds"] for s in today if s["category"] == "productive")
    distracting_today = sum(s["total_seconds"] for s in today if s["category"] == "distracting")

    prod_avg = cat_avgs.get("productive", 0)
    dist_avg = cat_avgs.get("distracting", 0)

    if prod_avg > 0 and productive_today > prod_avg * 1.5:
        flags.append({"type": "positive", "message": f"Productive time is {productive_today // 60}min, {round(productive_today / prod_avg, 1)}x your average"})
    if prod_avg > 0 and productive_today < prod_avg * 0.5:
        flags.append({"type": "warning", "message": f"Productive time is only {productive_today // 60}min, well below your {prod_avg // 60}min average"})
    if dist_avg > 0 and distracting_today > dist_avg * 2:
        flags.append({"type": "alert", "message": f"Distracting time is {distracting_today // 60}min, {round(distracting_today / dist_avg, 1)}x your average"})

    for site in today:
        domain = site["domain"]
        seconds = site["total_seconds"]
        avg_data = averages.get(domain)
        if avg_data and avg_data["avg_seconds"] > 60:
            ratio = seconds / avg_data["avg_seconds"]
            if ratio >= 3:
                flags.append({"type": "alert", "message": f"{domain}: {seconds // 60}min today vs {avg_data['avg_seconds'] // 60}min average ({round(ratio, 1)}x)"})
            elif ratio >= 2:
                flags.append({"type": "warning", "message": f"{domain}: {seconds // 60}min today vs {avg_data['avg_seconds'] // 60}min average ({round(ratio, 1)}x)"})

    # New sites never seen before
    for site in today:
        if site["domain"] not in averages:
            if site["total_seconds"] > 120:
                flags.append({"type": "info", "message": f"New site: {site['domain']} ({site['total_seconds'] // 60}min)"})

    return jsonify({
        "flags": flags,
        "productive_today": productive_today,
        "distracting_today": distracting_today,
        "productive_avg": prod_avg,
        "distracting_avg": dist_avg
    }), 200

@app.route("/api/weekly-report", methods=["GET"])
@require_dashboard_data
@rate_limit(limit=3, window_seconds=60 * 60, key_prefix="weekly_report")
def weekly_report():
    if not _openai_ready():
        return jsonify({"report": "Weekly report is disabled (missing OPENAI_API_KEY)."}), 200
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    ct = g.client_token
    cursor.execute(
        """SELECT d.visit_date, d.domain, d.total_seconds, c.category AS category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.client_token = c.client_token AND d.domain = c.domain
           WHERE d.client_token = %s
             AND d.visit_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
           ORDER BY d.visit_date ASC, d.total_seconds DESC""",
        (ct,),
    )
    rows = enrich_site_rows(cursor.fetchall())

    cursor.close()
    conn.close()

    if not rows:
        return jsonify({"report": "No data from the past week to analyze."}), 200

    # Build summary for AI
    days = {}
    for row in rows:
        day = str(row["visit_date"])
        if day not in days:
            days[day] = {"productive": 0, "distracting": 0, "neutral": 0, "sites": []}
        days[day][row["category"]] += row["total_seconds"]
        days[day]["sites"].append(f"{row['domain']} ({row['total_seconds'] // 60}min, {row['category']})")

    summary = "Weekly browsing data:\n\n"
    total_productive = 0
    total_distracting = 0
    best_day = None
    best_ratio = -1
    worst_day = None
    worst_ratio = float('inf')

    for day, data in sorted(days.items()):
        prod = data["productive"]
        dist = data["distracting"]
        total_productive += prod
        total_distracting += dist
        total = prod + dist + data["neutral"]

        ratio = prod / max(dist, 1)
        if ratio > best_ratio:
            best_ratio = ratio
            best_day = day
        if ratio < worst_ratio:
            worst_ratio = ratio
            worst_day = day

        summary += f"{day}: productive={prod // 60}min, distracting={dist // 60}min, neutral={data['neutral'] // 60}min\n"
        summary += f"  Top sites: {', '.join(data['sites'][:5])}\n\n"

    summary += f"\nBest day (highest productive ratio): {best_day}\n"
    summary += f"Worst day (lowest productive ratio): {worst_day}\n"
    summary += f"Total productive: {total_productive // 60}min\n"
    summary += f"Total distracting: {total_distracting // 60}min\n"

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=400,
        messages=[
            {"role": "system", "content": "You are a productivity analyst writing a weekly browsing report. Write it like a brief newspaper article with a headline. Include: the biggest win of the week, the biggest time drain, the best and worst days with context, and 2 specific experiments to try next week. Be concise, data-driven, and reference actual sites and times. Keep a professional but slightly witty tone."},
            {"role": "user", "content": summary}
        ]
    )

    report_text = response.choices[0].message.content.strip()

    return jsonify({"report": report_text}), 200

if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG") == "1"
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=debug, port=port)