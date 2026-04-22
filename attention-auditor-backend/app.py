from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from openai import OpenAI
import mysql.connector
from datetime import date, datetime
from functools import wraps
import time
from collections import deque

app = Flask(__name__)

import os

def _parse_origins(value: str):
    return [o.strip() for o in (value or "").split(",") if o.strip()]

IS_DEBUG = os.environ.get("FLASK_DEBUG") == "1"

# CORS: allow only known dashboard origins (comma-separated).
# Note: CORS is NOT authentication; it only controls which browser origins can read responses.
cors_origins = _parse_origins(
    os.environ.get(
        "CORS_ORIGINS",
        "https://attention-auditor-production.up.railway.app,http://127.0.0.1:5000,http://localhost:5000",
    )
)
CORS(app, resources={r"/api/*": {"origins": cors_origins}})

# API key auth (optional): if ATTENTION_AUDITOR_API_KEY is set, protected endpoints require it.
API_KEY = os.environ.get("ATTENTION_AUDITOR_API_KEY")

AUTO_CATEGORIZE_ON_TRACK = os.environ.get("AUTO_CATEGORIZE_ON_TRACK") == "1"
MAX_NEW_DOMAINS_TO_CATEGORIZE_PER_TRACK = int(os.environ.get("MAX_NEW_DOMAINS_TO_CATEGORIZE_PER_TRACK", "5"))

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

def require_api_key(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not API_KEY:
            return fn(*args, **kwargs)

        header_key = request.headers.get("X-ATTENTION-AUDITOR-KEY")
        auth = request.headers.get("Authorization", "")
        bearer = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else None
        provided = header_key or bearer

        if provided != API_KEY:
            return jsonify({"error": "Unauthorized"}), 401
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
if not openai_api_key:
    if IS_DEBUG:
        openai_api_key = input("Enter OpenAI API key: ")
    else:
        raise RuntimeError("Missing OpenAI API key. Set OPENAI_API_KEY.")
openai_client = OpenAI(api_key=openai_api_key)

def get_db():
    return mysql.connector.connect(
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_password,
        database=db_name
    )
def categorize_domain(domain):
    """Check database first, then ask AI if unknown."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute("SELECT category FROM site_categories WHERE domain = %s", (domain,))
    row = cursor.fetchone()

    if row:
        cursor.close()
        conn.close()
        return row["category"]

    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=10,
        messages=[
            {"role": "system", "content": "Categorize this website domain as exactly one word: productive, distracting, or neutral. Productive means work, education, or professional development. Distracting means social media, entertainment, gaming, or news. Neutral means shopping, utilities, banking, or general purpose. Respond with only that one word."},
            {"role": "user", "content": domain}
        ]
    )

    category = response.choices[0].message.content.strip().lower()
    if category not in ("productive", "distracting", "neutral"):
        category = "neutral"

    cursor.execute(
        "INSERT INTO site_categories (domain, category, source) VALUES (%s, %s, 'ai')",
        (domain, category)
    )
    conn.commit()
    cursor.close()
    conn.close()
    return category


@app.route("/api/track", methods=["POST"])
@require_api_key
def track():
    data = request.get_json()
    if not data or "sites" not in data:
        return jsonify({"error": "No data provided"}), 400

    record_date_str = data.get("date")
    try:
        record_date = date.fromisoformat(record_date_str) if record_date_str else date.today()
    except ValueError:
        record_date = date.today()

    conn = get_db()
    cursor = conn.cursor()

    for site in data["sites"]:
        domain = site.get("domain")
        seconds = site.get("seconds", 0)
        if domain and seconds > 0:
            received_at = datetime.now()
            cursor.execute(
                "INSERT INTO browsing_data (domain, seconds_spent, recorded_at) VALUES (%s, %s, %s)",
                (domain, seconds, received_at)
            )
            cursor.execute(
                """INSERT INTO daily_summary (domain, total_seconds, visit_date)
                   VALUES (%s, %s, %s)
                   ON DUPLICATE KEY UPDATE total_seconds = total_seconds + %s""",
                (domain, seconds, record_date, seconds)
            )

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
                f"SELECT domain FROM site_categories WHERE domain IN ({placeholders})",
                tuple(incoming_domains),
            )
            categorized = {row[0] for row in cur.fetchall()}
            cur.close()
            conn.close()

            to_categorize = [d for d in incoming_domains if d not in categorized]
            to_categorize = to_categorize[:MAX_NEW_DOMAINS_TO_CATEGORIZE_PER_TRACK]

            for domain in to_categorize:
                try:
                    categorize_domain(domain)
                except Exception as e:
                    print(f"Could not categorize {domain}: {e}")

    return jsonify({"status": "ok"}), 200


@app.route("/api/stats", methods=["GET"])
@require_api_key
def stats():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    today_str = request.args.get("date", str(date.today()))

    cursor.execute(
        """SELECT d.domain, d.total_seconds, COALESCE(c.category, 'neutral') as category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.domain = c.domain
           WHERE d.visit_date = %s
           ORDER BY d.total_seconds DESC""",
        (today_str,)
    )
    today = cursor.fetchall()

    cursor.execute(
        """SELECT d.domain, SUM(d.total_seconds) as total_seconds, COALESCE(c.category, 'neutral') as category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.domain = c.domain
           GROUP BY d.domain, c.category
           ORDER BY total_seconds DESC"""
    )
    all_time = cursor.fetchall()

    cursor.close()
    conn.close()
    return jsonify({"today": today, "all_time": all_time}), 200

@app.route("/")
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/stats/weekly", methods=["GET"])
@require_api_key
def weekly_stats():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute(
        """SELECT visit_date, domain, total_seconds
           FROM daily_summary
           WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
           ORDER BY visit_date DESC, total_seconds DESC"""
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
           WHERE visit_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
           GROUP BY visit_date
           ORDER BY visit_date ASC"""
    )
    daily_totals = cursor.fetchall()
    for row in daily_totals:
        row["visit_date"] = str(row["visit_date"])

    cursor.close()
    conn.close()
    return jsonify({"by_day": weekly, "daily_totals": daily_totals}), 200


@app.route("/api/categories", methods=["GET"])
@require_api_key
def get_categories():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT domain, category, source FROM site_categories ORDER BY category, domain")
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route("/api/categorize-all", methods=["POST"])
@require_api_key
@rate_limit(limit=CATEGORIZE_ALL_RATE_LIMIT_PER_HOUR, window_seconds=60 * 60, key_prefix="categorize_all")
def categorize_all():
    """Find all domains in browsing data that aren't categorized yet and categorize them."""
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute(
        """SELECT DISTINCT domain FROM daily_summary
           WHERE domain NOT IN (SELECT domain FROM site_categories)"""
    )
    uncategorized = cursor.fetchall()
    cursor.close()
    conn.close()

    results = {}
    for row in uncategorized:
        domain = row["domain"]
        category = categorize_domain(domain)
        results[domain] = category

    return jsonify({"categorized": results, "count": len(results)}), 200

@app.route("/api/categories/update", methods=["POST"])
@require_api_key
def update_category():
    data = request.get_json()
    domain = data.get("domain")
    category = data.get("category")

    if not domain or category not in ("productive", "distracting", "neutral"):
        return jsonify({"error": "Provide domain and category (productive/distracting/neutral)"}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """INSERT INTO site_categories (domain, category, source)
           VALUES (%s, %s, 'user')
           ON DUPLICATE KEY UPDATE category = %s, source = 'user'""",
        (domain, category, category)
    )
    conn.commit()
    cursor.close()
    conn.close()
    return jsonify({"domain": domain, "category": category, "source": "user"}), 200

@app.route("/api/feedback", methods=["GET"])
@require_api_key
@rate_limit(limit=FEEDBACK_RATE_LIMIT_PER_MINUTE, window_seconds=60, key_prefix="feedback")
def feedback():
    personality = request.args.get("personality", "coach")

    personalities = {
        "coach": "You are an encouraging productivity coach. Be motivational but honest. Use a supportive, energetic tone. Keep it to 3-4 sentences.",
        "advisor": "You are a direct, no-nonsense productivity advisor. Be blunt and straightforward about what needs to change. Keep it to 3-4 sentences.",
        "mentor": "You are a gentle, wise mentor. Be kind and understanding while nudging toward better habits. Use a calm, thoughtful tone. Keep it to 3-4 sentences."
    }

    system_prompt = personalities.get(personality, personalities["coach"])

    conn = get_db()
    cursor = conn.cursor(dictionary=True)

    cursor.execute(
        """SELECT d.domain, d.total_seconds, COALESCE(c.category, 'neutral') as category
           FROM daily_summary d
           LEFT JOIN site_categories c ON d.domain = c.domain
           WHERE d.visit_date = %s
           ORDER BY d.total_seconds DESC""",
        (date.today(),)
    )
    today = cursor.fetchall()

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


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG") == "1"
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=debug, port=port)