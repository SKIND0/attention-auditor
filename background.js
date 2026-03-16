console.log("BACKGROUND SCRIPT LOADED");

let currentSite = null;
let startTime = null;
let isIdle = false;

// Subdomains that should be kept distinct instead of merged to root domain
const KEEP_SUBDOMAIN = new Set([
  "mail.google.com",
  "docs.google.com",
  "drive.google.com",
  "sheets.google.com",
  "slides.google.com",
  "calendar.google.com",
  "meet.google.com",
  "maps.google.com",
  "news.google.com",
  "photos.google.com",
]);

const domainAliases = {
  "instructure.com": "touro.edu",
  "canvas.instructure.com": "touro.edu",
};

function getDomain(url) {
  try {
    if (
      !url ||
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("about:") ||
      url.startsWith("edge://")
    ) {
      return null;
    }

    const hostname = new URL(url).hostname;
    if (!hostname) return null;

    // Check alias map first (before any stripping)
    if (domainAliases[hostname]) {
      return domainAliases[hostname];
    }

    // Keep certain subdomains fully intact
    if (KEEP_SUBDOMAIN.has(hostname)) {
      return hostname;
    }

    // Default: strip to root domain (last two parts)
    const parts = hostname.split(".");
    const domain = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;

    // Check alias map again on the stripped domain
    if (domainAliases[domain]) {
      return domainAliases[domain];
    }

    return domain;
  } catch {
    return null;
  }
}

function getTodayKey() {
  const d = new Date();
  // YYYY-MM-DD in local time
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Saves elapsed seconds for currentSite into today's storage bucket.
// Does NOT reset currentSite/startTime — call those separately.
function saveElapsed() {
  if (!currentSite || !startTime) return;
  const seconds = Math.round((Date.now() - startTime) / 1000);
  if (seconds < 1) return;

  const todayKey = getTodayKey();
  const storageKey = `siteData_${todayKey}`;

  chrome.storage.local.get([storageKey], (result) => {
    const siteData = result[storageKey] || {};
    siteData[currentSite] = (siteData[currentSite] || 0) + seconds;
    chrome.storage.local.set({ [storageKey]: siteData });
    console.log(
      `Tracked ${seconds}s on ${currentSite} (Today total: ${siteData[currentSite]}s) [${todayKey}]`
    );
  });
}

function switchToSite(url) {
  if (!url) return;
  const domain = getDomain(url);
  if (!domain) return;
  if (domain === currentSite) return; // same site, nothing to do

  // Save time on the old site before switching
  saveElapsed();

  currentSite = domain;
  startTime = Date.now();
  console.log("Now tracking:", domain);
}

function pauseTracking(reason) {
  if (!currentSite) return;
  console.log(`Tracking paused: ${reason}`);
  saveElapsed();
  // Keep currentSite so we know what to resume, but null startTime
  startTime = null;
}

function resumeTracking() {
  if (!currentSite) return;
  if (startTime) return; // already running
  startTime = Date.now();
  console.log("Tracking resumed on:", currentSite);
}

// ─── Tab events ──────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isIdle) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab && tab.url) switchToSite(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isIdle) return;
  if (changeInfo.status === "complete" && tab.active && tab.url) {
    switchToSite(tab.url);
  }
});

// ─── Window focus ─────────────────────────────────────────────────────────────
// Use a short debounce so rapidly alt-tabbing back doesn't wipe data

let focusDebounce = null;

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Chrome lost focus — wait briefly before pausing in case user alt-tabs back
    if (focusDebounce) return; // already pending
    focusDebounce = setTimeout(() => {
      focusDebounce = null;
      pauseTracking("window lost focus");
    }, 3000); // 3-second grace period
  } else {
    // Chrome regained focus — cancel any pending pause
    if (focusDebounce) {
      clearTimeout(focusDebounce);
      focusDebounce = null;
    }

    if (!isIdle) {
      // Re-detect which site we're on
      chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
        if (tabs[0] && tabs[0].url) {
          const domain = getDomain(tabs[0].url);
          if (domain) {
            if (domain !== currentSite) {
              // Switched sites while focus was away
              currentSite = domain;
            }
            resumeTracking();
          }
        }
      });
    }
  }
});

// ─── Idle detection ───────────────────────────────────────────────────────────
// Requires "idle" permission in manifest.json

chrome.idle.setDetectionInterval(60); // mark idle after 60s of no input

chrome.idle.onStateChanged.addListener((state) => {
  console.log("Idle state changed:", state);
  if (state === "idle" || state === "locked") {
    isIdle = true;
    pauseTracking(`user ${state}`);
  } else if (state === "active") {
    isIdle = false;
    // Resume on the tab that's currently active
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url) {
        const domain = getDomain(tabs[0].url);
        if (domain) {
          if (domain !== currentSite) currentSite = domain;
          resumeTracking();
        }
      }
    });
  }
});

// ─── Daily reset ─────────────────────────────────────────────────────────────

function pruneOldDays() {
  // Keep only the last 30 days of data keys to avoid storage bloat
  chrome.storage.local.get(null, (allData) => {
    const today = getTodayKey();
    const keysToRemove = [];
    for (const key of Object.keys(allData)) {
      if (!key.startsWith("siteData_")) continue;
      const datePart = key.replace("siteData_", "");
      // Simple string compare works for YYYY-MM-DD
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
      if (datePart < cutoffKey) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove);
      console.log("Pruned old day keys:", keysToRemove);
    }
  });
}

// ─── Server sync ──────────────────────────────────────────────────────────────

function sendToServer() {
  const todayKey = getTodayKey();
  const storageKey = `siteData_${todayKey}`;

  chrome.storage.local.get([storageKey, "pendingData"], (result) => {
    const todayData = result[storageKey] || {};
    const pending = result.pendingData || {}; // data from previous failed sends

    // Merge pending + today
    const merged = { ...pending };
    for (const [domain, secs] of Object.entries(todayData)) {
      merged[domain] = (merged[domain] || 0) + secs;
    }

    const sites = Object.entries(merged)
      .filter(([, secs]) => secs > 0)
      .map(([domain, seconds]) => ({ domain, seconds }));

    if (sites.length === 0) return;

    fetch("http://127.0.0.1:5000/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sites, date: todayKey }),
    })
      .then((r) => r.json())
      .then((data) => {
        console.log("Sent to server:", data);
        // Only clear today's local data on success; wipe pending too
        chrome.storage.local.set({
          [storageKey]: {},
          pendingData: {},
        });
        pruneOldDays();
      })
      .catch((err) => {
        console.log("Server not available, will retry:", err.message);
        // Save what we tried to send as pendingData so it isn't lost
        chrome.storage.local.set({ pendingData: merged, [storageKey]: {} });
      });
  });
}

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.create("sendData", { periodInMinutes: 1 }); // single create

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sendData") {
    // Save current in-progress session before sending
    saveElapsed();
    if (startTime) startTime = Date.now(); // reset window so we don't double-count
    console.log("Alarm fired, sending data...");
    sendToServer();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed/refreshed");
  sendToServer();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Browser started");
  sendToServer();
});