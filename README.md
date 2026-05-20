# Attention Auditor

A Chrome browser extension that tracks your browsing habits, stores usage data in a cloud database, and uses AI to categorize sites and generate personalized productivity feedback.

Each browser profile gets its own **Device ID** (UUID). Paste that ID at `/login` once per browser — the dashboard then shows **only that profile's** data.

---

## How It Works

1. The Chrome extension runs in the background, detecting which sites you visit and how long you spend on each one.
2. Every minute, it sends that data to a Flask backend (hosted on Railway or self-hosted), tagged with your Device ID.
3. The backend stores everything in a MySQL database, organized by day and scoped per Device ID.
4. New domains are automatically categorized as **productive**, **distracting**, or **neutral** — first checked against 400+ built-in defaults, then OpenAI for anything unknown.
5. The web dashboard displays your stats with interactive charts, color-coded by category.
6. AI-powered features analyze your patterns: anomaly detection compares today to your 7-day average, personality-based feedback (Coach/Advisor/Mentor) gives motivational insights, and a weekly narrative report summarizes your browsing like a newspaper article.

---

## Multi-User System

- **Extension:** Generates a `clientToken` (UUID) on first install and sends it as `X-Client-Token` on every sync.
- **Dashboard:** Visit `/login`, paste the UUID from the extension popup → session cookie → `/` loads charts for that user only.
- **Categories:** Stored per user (`client_token` + `domain`), so classifications don't leak between users on a shared database.
- **Isolation:** All database queries are filtered by `client_token`. User A cannot see User B's data.

Treat the Device ID like a password — anyone with it can view that profile's browsing history on your server.

---

## Features

**Browsing Tracker**
- Tracks active tabs and calculates time per domain
- Merges subdomains (`www.zara.com` and `account.zara.com` → `zara.com`)
- Custom domain aliases (e.g., `touro.instructure.com` → `touro.edu`)
- Handles international TLDs (`.co.uk`, `.com.au`, etc.)
- Filters Chrome internal pages
- **Attention-based tracking:** counts time only when Chrome is the focused app, the active tab is a normal website, and you are present (OS active). Pauses when you lock the screen, switch to another app, or go idle (~60s with no input).
- **Movie/listen exception:** if a tab in the focused Chrome window is playing audio, idle does not pause tracking (hands off during a video is still counted).
- Heartbeat commits every minute plus instant saves on tab/focus changes; stale sessions are not credited after sleep/overnight gaps.
- Persists tracking state (`schemaVersion: 2`) to survive service worker suspension (MV3)
- Stores data locally when server is unavailable, syncs when it reconnects
- Delta-based sync — only sends new seconds, never double-counts

**AI Site Categorization**
- 400+ built-in domain categories seeded automatically for new users
- OpenAI (gpt-4o-mini) categorizes unknown domains on demand
- Categories: productive (green), distracting (red), neutral (yellow)
- Results cached per user — each domain categorized once
- Manual override via API endpoint

**AI Analytics**
- **Anomaly Detection:** Auto-compares today's browsing to 7-day average on dashboard load. Flags sites at 2-3x above normal, unusual productive/distracting ratios, and new sites.
- **Quick Feedback:** Three personality styles (Coach, Advisor, Mentor) generate 3-4 sentences referencing your actual sites and times.
- **Weekly Narrative Report:** AI generates a newspaper-style article with headline, biggest wins, biggest drains, best/worst days, and two experiments for next week.

**Web Dashboard**
- Stat strip: total tracked, productive, distracting, neutral, site count
- Today's breakdown: top 10 with "Show more" button, progress bars by category
- Anomaly detection card with color-coded flags and today vs. average comparison
- AI section with tabs for Quick Feedback and Weekly Report
- Weekly totals line chart (7-day window, missing days filled as zero)
- All-time usage bar chart (top 10)
- Login/logout system per Device ID

**Extension Popup**
- Always shows today's stats from local storage (works offline)
- Device ID display with copy button and dashboard login link
- Server URL configuration
- Live status: focus, idle, tracking state, sync telemetry

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Extension | JavaScript, HTML, CSS (Chrome Manifest V3) |
| Backend | Python, Flask, Flask-CORS |
| Database | MySQL |
| AI | OpenAI API (gpt-4o-mini) |
| Hosting | Railway |
| Charts | Chart.js |

---

## Project Structure

```
attention-auditor/
├── background.js                # Tab tracking, time calculation, server sync
├── manifest.json                # Extension config and permissions
├── popup.html                   # Extension popup UI
├── popup.js                     # Local stats display and settings
├── icon.svg                     # Extension icon
│
├── attention-auditor-backend/
│   ├── app.py                   # Flask server with all API endpoints
│   ├── builtin_categories.py    # 400+ default domain categorizations
│   ├── requirements.txt         # Python dependencies
│   ├── Procfile                 # Railway/gunicorn config
│   ├── runtime.txt              # Python version
│   └── templates/
│       ├── dashboard.html       # Web dashboard
│       └── login.html           # Device ID login page
│
└── README.md
```

---

## Self-Hosting Guide

### Prerequisites

- Google Chrome
- Python 3.12+
- MySQL
- An OpenAI API key ([platform.openai.com](https://platform.openai.com))

### Database Setup

Run **`attention-auditor-backend/schema.sql`** once on your MySQL service (Railway → MySQL → Query / Connect). It creates all four tables, including `rate_limits` (otherwise the first sync after deploy runs `CREATE TABLE` on a live request).

```bash
# Or paste schema.sql in Railway's MySQL console
```

### Backend Setup

```bash
cd attention-auditor-backend
pip install -r requirements.txt
FLASK_DEBUG=1 python app.py
```

With `FLASK_DEBUG=1`, it prompts for MySQL password and OpenAI key if env vars aren't set. The dashboard will be at `http://localhost:5000`.

### Extension Setup

1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select the project root folder
2. Open the extension popup → copy your **Device ID**
3. Go to `http://localhost:5000/login` → paste the Device ID → submit
4. Optional: set **Server URL** in the popup if not using the default



### Using the Dashboard

Once logged in, the dashboard shows your browsing data with charts and AI features. At the bottom of the page:

- **Label Editor** — Click "Open Label Editor" to change any site's category. Type the domain (e.g., `github.com`), select productive/distracting/neutral, and click Save Override. Your personal label is applied immediately without reloading.
- **Log Out** — Click "Log Out" to end your session. Use this to switch to a different Device ID on the same computer.

---

## Deploying on Railway

1. Provision **MySQL** and run **`schema.sql`**
2. Set environment variables on the **web** service (Variables → reference MySQL vars or copy `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`):
   - `FLASK_SECRET_KEY` (long random string for session cookies)
   - `OPENAI_API_KEY` (optional; AI features disabled without it)
3. Optional: `SESSION_COOKIE_SECURE=1`, `CORS_ORIGINS` (your Railway URL + localhost), `RATE_LIMIT_STORAGE=memory` (fewer MySQL round-trips on every extension sync)
4. Deploy from GitHub; root directory **`attention-auditor-backend`**
5. If deploy hangs: set Railway health check path to **`/health`** (returns immediately, no DB)
6. Install extension → copy Device ID → paste at `/login` on your Railway URL

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/login` | Paste Device ID → session cookie |
| GET | `/logout` | Clear session |
| POST | `/api/track` | Extension upload (`X-Client-Token` + `X-ATTENTION-AUDITOR-KEY`) |
| GET | `/api/stats?date=YYYY-MM-DD` | Today's and all-time stats for session user |
| GET | `/api/stats/weekly` | Last 7 days for session user |
| GET | `/api/feedback?personality=coach` | AI feedback (coach, advisor, or mentor) |
| GET | `/api/anomalies?date=YYYY-MM-DD` | Anomaly detection vs 7-day average |
| GET | `/api/weekly-report` | AI-generated weekly narrative report |
| GET | `/api/categories` | User's categorized domains |
| POST | `/api/categorize-all` | AI-categorize all uncategorized domains |
| POST | `/api/categories/update` | Manually override a domain's category |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MYSQLHOST` | Yes | Database host |
| `MYSQLPORT` | Yes | Database port |
| `MYSQLUSER` | Yes | Database user |
| `MYSQLPASSWORD` | Yes | Database password |
| `MYSQLDATABASE` | Yes | Database name |
| `OPENAI_API_KEY` | Yes | OpenAI API key for categorization and feedback |
| `FLASK_SECRET_KEY` | Production | Secret for session cookies |
| `ATTENTION_AUDITOR_API_KEY` | Production | Required to protect write endpoints |
| `FLASK_DEBUG` | Dev only | Set to `1` for local development |
| `CORS_ORIGINS` | Optional | Comma-separated allowed origins |
| `SESSION_COOKIE_SECURE` | Optional | Set to `1` for HTTPS-only cookies |
| `AUTO_CATEGORIZE_ON_TRACK` | Optional | Set to `1` to auto-categorize on data upload |

---

## Known Limitations

- **Active tab only** — tracks the tab you're interacting with, not all visible tabs. Passive viewing (e.g., Zoom on a second monitor) won't be fully captured.
- **Focus detection** — tracking pauses when Chrome is not the OS-focused app (e.g. you are in Word or Slack). Chrome visible beside another app does not count until you focus Chrome again.
- **Media exception** — idle (no mouse/keyboard ~60s) does not pause while a tab in the focused Chrome window is playing audio.
- **Idle threshold** — 60 seconds of no input before pausing. Brief idle periods under 60 seconds are still counted.
- **Timezone** — the dashboard sends the browser's local date to avoid UTC mismatch with Railway, but the weekly chart date generation may still use UTC in some edge cases.

---

## Privacy Note

This extension requires `tabs` and `<all_urls>` permissions to track browsing activity. It can see every URL you visit and how long you spend there. All data is stored in your own database. No data is shared with third parties other than OpenAI when you request AI feedback or when a new domain needs categorization.

This project was built in part to demonstrate how much data browser extensions can access with minimal user awareness.

---

## Built By

Sarah Kind
Semester Project — Spring 2026
