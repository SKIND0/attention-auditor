# Attention Auditor

A Chrome browser extension that tracks your browsing habits, stores usage data in a cloud database, and uses AI to categorize sites and generate personalized motivational feedback.

**Live app:** Same URL for everyone’s backend — **each browser profile** gets its own **Device ID** (UUID). Paste that ID at **`/login`** once per browser; the dashboard then shows **only that profile’s** synced history.

---

## Multi-user (one Railway, private dashboards)

- **Extension:** Creates `clientToken` (UUID) on first run and sends **`X-Client-Token`** on every sync.
- **Dashboard:** Visit **`/login`**, paste the UUID from the extension popup → session cookie → **`/`** loads charts for **that user only**.
- **Categories:** Stored **per user** (`client_token` + `domain`), so classifications don’t leak between people on the shared database.

Treat the Device ID like a **password**: anyone with it can view that profile’s aggregates on your server until you rotate DB rows or they lose access.

---

## How It Works

1. The Chrome extension runs in the background and detects which sites you visit and how long you spend on each one.
2. Every minute, it sends that data to a Flask backend hosted on Railway (or your machine), tagged with your **Device ID**.
3. The backend stores everything in a MySQL database organized by day **per Device ID**.
4. New domains can be categorized as **productive**, **distracting**, or **neutral** using OpenAI's API (optional flows). Common sites can use hardcoded categories; you can manually override any categorization.
5. The web dashboard displays your stats with interactive charts, color-coded by category.
6. Click a personality button (Coach, Advisor, or Mentor) to get AI-generated feedback based on your browsing patterns.

---

## Local vs cloud (extension puzzle menu)

| Where | What you see |
|--------|----------------|
| **Extension popup** (puzzle icon → Attention Auditor) | **Always** today’s stats from **local storage** on this computer. Works when Railway is down or your Wi‑Fi is off. Sync errors appear under “Last error” but your local times still update while you browse. |
| **Web dashboard** (`/` after **`/login`**) | Reads **your** rows from MySQL (matching your Device ID session). Use **Log out** to switch users on the same computer. |

The popup **does not need an API key** to display local sites. Configure **Sync API key** only when the server sets `ATTENTION_AUDITOR_API_KEY`.

---

## Authentication

- **Device ID:** Extension sends **`X-Client-Token`** (UUID) with **`POST /api/track`**. Required for all uploads.
- **Dashboard session:** After **`/login`**, the browser cookie selects which user’s data **`GET /api/*`** returns. Same-origin / hostname checks still apply when `ATTENTION_AUDITOR_API_KEY` is set.
- **Automation:** **`ATTENTION_AUDITOR_API_KEY`** + **`X-Client-Token`** header can call dashboard JSON endpoints without a browser session.

**Railway / production:** set **`FLASK_SECRET_KEY`** (long random string) so login sessions can’t be forged. On HTTPS, set **`SESSION_COOKIE_SECURE=1`**.

Optional **`DASHBOARD_ORIGINS`**: extra allowed origins for browser API reads (rare).

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
│       ├── dashboard.html     # Web dashboard (after login)
│       └── login.html         # Paste Device ID
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
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    seconds_spent INT NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_client_recorded (client_token, recorded_at)
);

CREATE TABLE daily_summary (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    total_seconds INT NOT NULL,
    visit_date DATE NOT NULL,
    UNIQUE KEY uq_client_domain_day (client_token, domain, visit_date),
    INDEX idx_client_visit (client_token, visit_date)
);

CREATE TABLE site_categories (
    client_token VARCHAR(36) NOT NULL,
    domain VARCHAR(255) NOT NULL,
    category ENUM('productive', 'distracting', 'neutral') NOT NULL,
    source ENUM('default', 'ai', 'user') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (client_token, domain)
);
```

### Migrating an older single-tenant database

If you already have tables **without** `client_token`, run something like the following once (pick one legacy UUID for old rows, or truncate tables instead):

```sql
USE attention_auditor;

ALTER TABLE browsing_data ADD COLUMN client_token VARCHAR(36) NULL AFTER id;
ALTER TABLE daily_summary ADD COLUMN client_token VARCHAR(36) NULL FIRST;
ALTER TABLE site_categories ADD COLUMN client_token VARCHAR(36) NULL FIRST;

SET @legacy = '00000000-0000-4000-8000-000000000001';
UPDATE browsing_data SET client_token = @legacy WHERE client_token IS NULL;
UPDATE daily_summary SET client_token = @legacy WHERE client_token IS NULL;
UPDATE site_categories SET client_token = @legacy WHERE client_token IS NULL;

ALTER TABLE daily_summary DROP INDEX unique_domain_date;
ALTER TABLE browsing_data MODIFY client_token VARCHAR(36) NOT NULL;
ALTER TABLE daily_summary MODIFY client_token VARCHAR(36) NOT NULL;
ALTER TABLE site_categories MODIFY client_token VARCHAR(36) NOT NULL;
ALTER TABLE daily_summary ADD UNIQUE KEY uq_client_domain_day (client_token, domain, visit_date);

ALTER TABLE site_categories DROP PRIMARY KEY;
ALTER TABLE site_categories ADD PRIMARY KEY (client_token, domain);
```

If `site_categories` had only `PRIMARY KEY (domain)`, drop/add PK as above. Adjust index names if MySQL reports conflicts.

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

5. Set **`FLASK_SECRET_KEY`** in the environment (required when `FLASK_DEBUG` is not set).
6. Open **`http://127.0.0.1:5000/login`**, paste your extension **Device ID**, then open the dashboard.

### Extension Setup

1. **Optional:** Popup → **Server URL** → e.g. `http://127.0.0.1:5000` or your Railway URL → Save. Leave blank for the default in `background.js`.
2. Copy **Device ID** from the popup → open **`/login`** on that server → paste → submit.
3. **If your server uses `ATTENTION_AUDITOR_API_KEY`:** paste the same value under **Sync API key** and Save.
4. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → folder with `manifest.json`.
5. Pin the extension if you like.

---

## Deploying on Railway (checklist)

1. Provision **MySQL** with the **multi-user schema** above (or run migration SQL).
2. Set **`OPENAI_API_KEY`**, **`FLASK_SECRET_KEY`**, and optionally **`SESSION_COOKIE_SECURE=1`**.
3. Recommended: **`ATTENTION_AUDITOR_API_KEY`** + matching **Sync API key** in the extension.
4. **`CORS_ORIGINS`** includes your public HTTPS URL (and local URLs if you test that way).
5. Deploy; **`/login`** → Device ID → **`/`** → browse with extension → confirm charts fill for **that** ID only.

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/login` | Paste **Device ID** (UUID) → session |
| POST | `/api/track` | Extension upload; headers **`X-Client-Token`** + optional **`X-ATTENTION-AUDITOR-KEY`** |
| GET | `/api/stats` | Stats for **session user** (or API key + **`X-Client-Token`**) |
| GET | `/api/stats/weekly` | Last 7 days for that user |
| GET | `/api/feedback?personality=coach` | AI feedback for that user’s today |
| GET | `/api/categories` | That user’s categories |
| POST | `/api/categorize-all` | AI categorize gaps (**API key** + **`X-Client-Token`**) |
| POST | `/api/categories/update` | Override category (**API key** + **`X-Client-Token`**) |

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
