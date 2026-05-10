# Attention Auditor

A Chrome browser extension that tracks your browsing habits, stores usage data in a cloud database, and uses AI to categorize sites and generate personalized motivational feedback.

**Live dashboard:** Use your deployed Railway URL (root `/`), for example `https://attention-auditor-production.up.railway.app`, or open `http://127.0.0.1:5000` when running the backend locally.

---

## How It Works

1. The Chrome extension runs in the background and detects which sites you visit and how long you spend on each one.
2. Every minute, it sends that data to a Flask backend hosted on Railway (or your machine).
3. The backend stores everything in a MySQL database organized by day.
4. New domains can be categorized as **productive**, **distracting**, or **neutral** using OpenAI's API (optional flows). Common sites can use hardcoded categories; you can manually override any categorization.
5. The web dashboard displays your stats with interactive charts, color-coded by category.
6. Click a personality button (Coach, Advisor, or Mentor) to get AI-generated feedback based on your browsing patterns.

---

## Local vs cloud (extension puzzle menu)

| Where | What you see |
|--------|----------------|
| **Extension popup** (puzzle icon → Attention Auditor) | **Always** today’s stats from **local storage** on this computer. Works when Railway is down or your Wi‑Fi is off. Sync errors appear under “Last error” but your local times still update while you browse. |
| **Web dashboard** (`/` on your backend) | Reads from the **database** (MySQL). Shows data only after the extension has successfully synced. Requires the backend and database to be up. |

The popup **does not need an API key** to display sites. You only need to configure **Sync API key** in the popup when your server sets `ATTENTION_AUDITOR_API_KEY` (see below).

---

## Authentication (dashboard vs extension)

- **Web dashboard:** Opening the dashboard **on the same host** as the API (e.g. `https://yourservice.up.railway.app/`) is enough to load charts and AI insights. You **do not** paste an API key into the webpage.
- **Extension upload (`POST /api/track`):** If `ATTENTION_AUDITOR_API_KEY` is set on the server, the extension must send the same value (popup → **Sync API key** → Save). If that env var is **unset**, uploads work without a key (fine for local dev; **not** recommended on a public URL).

Optional env **`DASHBOARD_ORIGINS`**: comma-separated list of extra allowed origins for dashboard API reads (only needed if your public URL differs from `CORS_ORIGINS` / the request host).

---

## Features

**Browsing Tracker**

- Tracks active tabs and calculates time per domain
- Merges subdomains (e.g., `www.zara.com` and `account.zara.com` → `zara.com`)
- Custom domain aliases (e.g., Canvas hosts → `touro.edu`)
- Filters Chrome internal pages
- Pauses when Chrome loses focus (debounced for split-screen use)
- Pauses when the computer is idle for 60+ seconds
- Stores data locally when the server is unavailable, sends when it reconnects

**AI Site Categorization**

- Hybrid approach: hardcoded defaults for common sites, OpenAI for unknown domains (when you run categorization)
- Categories: productive (green), distracting (red), neutral (yellow)
- Results cached in database — each domain only categorized once
- Manual override endpoint for corrections

**AI Motivational Feedback**

- Three personality styles: Coach (encouraging), Advisor (direct), Mentor (thoughtful)
- Analyzes today's browsing data including productive vs. distracting time
- References your actual sites and time spent in the response

**Web Dashboard**

- Today's breakdown with ranked site list and category badges
- Productive / distracting / neutral time summary
- Doughnut chart (top 10 sites, colored by category)
- Weekly trends line chart
- All-time usage bar chart
- AI Insights section with personality selector buttons

**Extension Popup**

- Quick view of today's stats from local storage
- Works even when the server is down (local totals still accumulate)

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Extension | JavaScript, HTML, CSS (Chrome Manifest V3) |
| Backend | Python, Flask, Flask-CORS |
| Database | MySQL (hosted on Railway or locally) |
| AI | OpenAI API (gpt-4o-mini) |
| Hosting | Railway |

---

## Project Structure

```
attention-auditor-private/
├── background.js              # Tab tracking, time calculation, server sync
├── manifest.json              # Extension config and permissions
├── popup.html                 # Extension popup UI
├── popup.js                   # Displays local stats and sync status
│
├── attention-auditor-backend/
│   ├── app.py                 # Flask server with all API endpoints
│   ├── requirements.txt       # Python dependencies
│   ├── Procfile               # Railway deployment config
│   ├── runtime.txt            # Python version for Railway
│   └── templates/
│       └── dashboard.html     # Web dashboard
│
└── README.md
```

---

## Self-Hosting Guide

### Prerequisites

- Google Chrome
- Python 3.12+
- MySQL
- An OpenAI API key (for AI feedback / categorization features)

### Database Setup

1. Open MySQL Workbench and connect to your local server.
2. Create the database and tables:

```sql
CREATE DATABASE attention_auditor;
USE attention_auditor;

CREATE TABLE browsing_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    domain VARCHAR(255) NOT NULL,
    seconds_spent INT NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE daily_summary (
    id INT AUTO_INCREMENT PRIMARY KEY,
    domain VARCHAR(255) NOT NULL,
    total_seconds INT NOT NULL,
    visit_date DATE NOT NULL
);

ALTER TABLE daily_summary ADD UNIQUE KEY unique_domain_date (domain, visit_date);

CREATE TABLE site_categories (
    domain VARCHAR(255) PRIMARY KEY,
    category ENUM('productive', 'distracting', 'neutral') NOT NULL,
    source ENUM('default', 'ai', 'user') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Backend Setup

1. Navigate to the `attention-auditor-backend/` folder.
2. Install dependencies:

```
pip install -r requirements.txt
```

3. Run the server:

```
python app.py
```

4. With `FLASK_DEBUG=1`, it can prompt for MySQL password and OpenAI API key if env vars are missing. For Railway, set variables in the dashboard instead.

5. The dashboard will be available at `http://127.0.0.1:5000`

### Extension Setup

1. **Optional:** Point the extension at your backend: open the popup → **Server URL** → e.g. `http://127.0.0.1:5000` or your Railway URL → Save. Leave blank to use the built-in default Railway URL in `background.js`.
2. **If your server uses `ATTENTION_AUDITOR_API_KEY`:** paste the same value under **Sync API key** in the popup and Save.
3. Open Chrome and go to `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** and select the **project folder** (the directory that contains `manifest.json`)
6. Pin the extension from the puzzle piece icon

---

## Deploying on Railway (checklist)

1. Provision **MySQL** and attach connection variables (`MYSQLHOST`, `MYSQLUSER`, etc.).
2. Set **`OPENAI_API_KEY`**.
3. Recommended: set **`ATTENTION_AUDITOR_API_KEY`** to a long random string; put the **same** string in the extension popup **Sync API key**.
4. Set **`CORS_ORIGINS`** to your public app URL (and `http://127.0.0.1:5000` if you still test locally against prod DB — rarely needed).
5. Deploy; open the **root URL** in a browser to verify the dashboard loads data after the extension has synced.

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/track` | Receives browsing data from the extension (**requires API key when configured**) |
| GET | `/api/stats` | Today's and all-time stats (dashboard same-origin **or** API key) |
| GET | `/api/stats/weekly` | Last 7 days of data grouped by day |
| GET | `/api/feedback?personality=coach` | AI-generated feedback (coach, advisor, or mentor) |
| GET | `/api/categories` | Lists all categorized domains |
| POST | `/api/categorize-all` | Categorizes uncategorized domains using AI (**requires API key when configured**) |
| POST | `/api/categories/update` | Manually override a domain's category (**requires API key when configured**) |

---

## Privacy Note

This extension requires `tabs` and `<all_urls>` permissions to track browsing activity. It can see every URL you visit and how long you spend there. All data is stored in your own database (local or Railway-hosted). No data is shared with third parties other than OpenAI when you explicitly request AI feedback or when categorization calls OpenAI.

This project was built in part to demonstrate how much data browser extensions can access with minimal user awareness.

---

## Known Limitations

- The extension tracks the **active tab** only — if a site is open but you're interacting with a different tab, that time is not captured. Passive viewing (like a Zoom call on a second monitor) won't be fully tracked.
- Only one browser profile should run the extension against one database at a time; otherwise totals mix without per-user separation.
- The idle detector pauses tracking after 60 seconds of no mouse or keyboard input. Short idle periods under 60 seconds are still counted.

---

## Built By

Sarah Kind  
Semester Project — Spring 2026
