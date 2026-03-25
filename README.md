# Attention Auditor

A Chrome browser extension that tracks your browsing habits, stores usage data in a cloud database, and uses AI to categorize sites and generate personalized motivational feedback.

**Live Dashboard:** [attention-auditor-production.up.railway.app](https://attention-auditor-production.up.railway.app)

---

## How It Works

1. The Chrome extension runs in the background and detects which sites you visit and how long you spend on each one.
2. Every minute, it sends that data to a Flask backend hosted on Railway.
3. The backend stores everything in a MySQL database organized by day.
4. New domains are automatically categorized as **productive**, **distracting**, or **neutral** using OpenAI's API. Common sites have hardcoded categories, and you can manually override any categorization.
5. The web dashboard displays your stats with interactive charts, color-coded by category.
6. Click a personality button (Coach, Advisor, or Mentor) to get AI-generated feedback based on your actual browsing patterns.

---

## Features

**Browsing Tracker**
- Tracks active tabs and calculates time per domain
- Merges subdomains (e.g., `www.zara.com` and `account.zara.com` → `zara.com`)
- Custom domain aliases (e.g., `touro.instructure.com` → `touro.edu`)
- Filters Chrome internal pages
- Pauses when Chrome loses focus (15s debounce for split-screen use)
- Pauses when the computer is idle for 60+ seconds
- Stores data locally when the server is unavailable, sends when it reconnects

**AI Site Categorization**
- Hybrid approach: hardcoded defaults for common sites, OpenAI for unknown domains
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
- Always works, even when the server is down

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Extension | JavaScript, HTML, CSS (Chrome Manifest V3) |
| Backend | Python, Flask, Flask-CORS |
| Database | MySQL (hosted on Railway) |
| AI | OpenAI API (gpt-4o-mini) |
| Hosting | Railway |
| API Testing | Postman |

---

## Project Structure

```
attention-auditor/
├── background.js              # Tab tracking, time calculation, server sync
├── manifest.json              # Extension config and permissions
├── popup.html                 # Extension popup UI
├── popup.js                   # Displays local stats in popup
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

If you want to run this yourself instead of using the live deployment:

### Prerequisites

- Google Chrome
- Python 3.12+
- MySQL
- An OpenAI API key

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
4. It will ask for your MySQL password and OpenAI API key on first run.
5. The dashboard will be available at `http://127.0.0.1:5000`

### Extension Setup

1. If self-hosting, update the server URL in `background.js`:
   - Find `fetch("https://attention-auditor-production.up.railway.app/api/track"`
   - Replace with `fetch("http://127.0.0.1:5000/api/track"`
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. Pin the extension from the puzzle piece icon

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/track` | Receives browsing data from the extension |
| GET | `/api/stats` | Returns today's and all-time stats with categories |
| GET | `/api/stats/weekly` | Returns last 7 days of data grouped by day |
| GET | `/api/feedback?personality=coach` | AI-generated feedback (coach, advisor, or mentor) |
| GET | `/api/categories` | Lists all categorized domains |
| POST | `/api/categorize-all` | Categorizes any uncategorized domains using AI |
| POST | `/api/categories/update` | Manually override a domain's category |

---

## Privacy Note

This extension requires `tabs` and `<all_urls>` permissions to track browsing activity. It can see every URL you visit and how long you spend there. All data is stored in your own database (local or Railway-hosted). No data is shared with third parties other than OpenAI when you explicitly request AI feedback or when a new domain needs categorization.

This project was built in part to demonstrate how much data browser extensions can access with minimal user awareness.

---

## Built By

Sarah Kind
Semester Project — Spring 2026