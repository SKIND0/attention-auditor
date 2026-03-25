from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from openai import OpenAI
import mysql.connector
from datetime import date

app = Flask(__name__)
CORS(app)

import os

db_host = os.environ.get("MYSQLHOST") or os.environ.get("MYSQL_HOST", "localhost")
db_port = int(os.environ.get("MYSQLPORT") or os.environ.get("MYSQL_PORT", 3306))
db_user = os.environ.get("MYSQLUSER") or os.environ.get("MYSQL_USER", "root")
db_password = os.environ.get("MYSQLPASSWORD") or os.environ.get("MYSQL_PASSWORD") or input("Enter MySQL password: ")
db_name = os.environ.get("MYSQLDATABASE") or os.environ.get("MYSQL_DATABASE", "attention_auditor")

openai_api_key = os.environ.get("OPENAI_API_KEY") or input("Enter OpenAI API key: ")
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
            cursor.execute(
                "INSERT INTO browsing_data (domain, seconds_spent, recorded_at) VALUES (%s, %s, %s)",
                (domain, seconds, record_date)
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

    # Auto-categorize any new domains in the background
    for site in data["sites"]:
        domain = site.get("domain")
        if domain:
            try:
                categorize_domain(domain)
            except Exception as e:
                print(f"Could not categorize {domain}: {e}")

    return jsonify({"status": "ok"}), 200


@app.route("/api/stats", methods=["GET"])
def stats():
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
def get_categories():
    conn = get_db()
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT domain, category, source FROM site_categories ORDER BY category, domain")
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return jsonify(rows), 200


@app.route("/api/categorize-all", methods=["POST"])
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
    app.run(debug=True, port=5000)