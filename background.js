console.log("BACKGROUND SCRIPT LOADED");

let currentSite = null;
let startTime = null;
let isIdle = false;
let isWindowFocused = true;

const TRACKING_STATE_KEY = "trackingState";
const CLIENT_TOKEN_KEY = "clientToken";

/** One UUID per browser profile — identifies this user on the shared Railway backend. */
function ensureClientToken(callback) {
  chrome.storage.local.get([CLIENT_TOKEN_KEY], (r) => {
    let t = r[CLIENT_TOKEN_KEY];
    if (typeof t === "string" && /^[0-9a-f-]{36}$/i.test(t)) {
      callback(t);
      return;
    }
    t = crypto.randomUUID();
    chrome.storage.local.set({ [CLIENT_TOKEN_KEY]: t }, () => callback(t));
  });
}

function saveTrackingState() {
  chrome.storage.local.set({
    [TRACKING_STATE_KEY]: {
      currentSite,
      startTime,
      isIdle,
      isWindowFocused,
      savedAt: Date.now(),
    },
  });
}

function restoreTrackingState(cb) {
  chrome.storage.local.get([TRACKING_STATE_KEY], (result) => {
    const st = result[TRACKING_STATE_KEY];
    if (st) {
      currentSite = st.currentSite ?? currentSite;
      startTime = st.startTime ?? startTime;
      isIdle = Boolean(st.isIdle);
      isWindowFocused = st.isWindowFocused !== undefined ? Boolean(st.isWindowFocused) : true;
    }
    cb?.();
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "flushSession") {
    saveElapsed();
    if (startTime) startTime = Date.now(); // reset so we don't double-count
    saveTrackingState();
  }
});

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

// Minimal public-suffix handling for common multi-part TLDs.
// Full correctness requires the full Public Suffix List, but this covers the most common cases.
const MULTI_PART_SUFFIXES = new Set([
  // UK
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "net.uk",
  // AU
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  // JP
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  // BR
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
  // NZ
  "co.nz",
  "org.nz",
  "govt.nz",
  "ac.nz",
  // ZA
  "co.za",
  "org.za",
  "gov.za",
  // Common
  "com.cn",
  "net.cn",
  "org.cn",
  "com.sg",
  "com.hk",
  "com.tr",
]);

function registrableDomainFromHostname(hostname) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 1) return hostname;

  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");

  // If the TLD is multi-part (e.g. co.uk), registrable is last 3 labels.
  if (MULTI_PART_SUFFIXES.has(last2) && parts.length >= 3) {
    return last3;
  }

  // Default: registrable is last 2 labels.
  return last2;
}

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
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      return "localhost:5000";
    }
    if (domainAliases[hostname]) {
      return domainAliases[hostname];
    }

    // Keep certain subdomains fully intact
    if (KEEP_SUBDOMAIN.has(hostname)) {
      return hostname;
    }

    // Default: strip to registrable domain (handles common multi-part TLDs like co.uk)
    const domain = registrableDomainFromHostname(hostname);

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
    saveTrackingState();
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
  saveTrackingState();
}

function pauseTracking(reason) {
  if (!currentSite) return;
  console.log(`Tracking paused: ${reason}`);
  saveElapsed();
  // Keep currentSite so we know what to resume, but null startTime
  startTime = null;
  saveTrackingState();
}

function resumeTracking() {
  if (!currentSite) return;
  if (startTime) return; // already running
  startTime = Date.now();
  console.log("Tracking resumed on:", currentSite);
  saveTrackingState();
}

// ─── Tab events ──────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isIdle || !isWindowFocused) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab && tab.url) switchToSite(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isIdle || !isWindowFocused) return;
  if (changeInfo.status === "complete" && tab.active && tab.url) {
    switchToSite(tab.url);
  }
});

// ─── Window focus ─────────────────────────────────────────────────────────────
// Use a short debounce so rapidly alt-tabbing back doesn't wipe data

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    isWindowFocused = false;
    saveTrackingState();
    // Strict attention: only count when Chrome is focused.
    pauseTracking("window lost focus");
  } else {
    isWindowFocused = true;
    saveTrackingState();

    if (!isIdle) {
      // Re-detect which site we're on
      chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
        if (tabs[0] && tabs[0].url) {
          const domain = getDomain(tabs[0].url);
          if (domain) {
            if (domain !== currentSite) currentSite = domain;
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
    if (isWindowFocused) {
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
    saveTrackingState();
  }
});

// ─── Daily reset ─────────────────────────────────────────────────────────────

function pruneOldDays() {
  // Keep only the last 30 days of data keys to avoid storage bloat
  chrome.storage.local.get(null, (allData) => {
    const keysToRemove = [];
    for (const key of Object.keys(allData)) {
      let datePart = null;
      if (key.startsWith("siteData_")) datePart = key.replace("siteData_", "");
      else if (key.startsWith("lastSent_")) datePart = key.replace("lastSent_", "");
      else if (key.startsWith("pendingDelta_")) datePart = key.replace("pendingDelta_", "");
      else continue;

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
  ensureClientToken((clientToken) => {
    const todayKey = getTodayKey();
    const storageKey = `siteData_${todayKey}`;
    const lastSentKey = `lastSent_${todayKey}`;
    const pendingDeltaKey = `pendingDelta_${todayKey}`;

    chrome.storage.local.get(
      [storageKey, lastSentKey, pendingDeltaKey, "apiKey", "serverUrl"],
      (result) => {
        const todayData = result[storageKey] || {};
        const lastSent = result[lastSentKey] || {};
        const pendingDelta = result[pendingDeltaKey] || {};
        const apiKey = result.apiKey || null;
        const baseUrl =
          (result.serverUrl && String(result.serverUrl).trim().replace(/\/+$/, "")) ||
          "https://attention-auditor-production.up.railway.app";
        const trackUrl = `${baseUrl}/api/track`;

        // Compute delta since last successful send, then merge any previously-failed delta.
        const delta = {};
        for (const [domain, total] of Object.entries(todayData)) {
          const last = lastSent[domain] || 0;
          const diff = total - last;
          if (diff > 0) delta[domain] = diff;
        }
        const mergedToSend = { ...pendingDelta };
        for (const [domain, secs] of Object.entries(delta)) {
          mergedToSend[domain] = (mergedToSend[domain] || 0) + secs;
        }

        const sites = Object.entries(mergedToSend)
          .filter(([, secs]) => secs > 0)
          .map(([domain, seconds]) => ({ domain, seconds }));

        if (sites.length === 0) return;

        chrome.storage.local.set({
          lastSyncUrl: trackUrl,
          lastSyncAttemptAt: Date.now(),
        });

        fetch(trackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-Token": clientToken,
            ...(apiKey ? { "X-ATTENTION-AUDITOR-KEY": apiKey } : {}),
          },
          body: JSON.stringify({ sites, date: todayKey }),
        })
          .then(async (r) => {
            let payload = null;
            try {
              payload = await r.json();
            } catch {
              payload = null;
            }
            if (!r.ok) {
              const msg =
                (payload && (payload.error || payload.message)) ||
                `HTTP ${r.status}`;
              const hint = payload && payload.hint ? ` ${payload.hint}` : "";
              throw new Error(`${msg}${hint}`);
            }
            return payload;
          })
          .then((data) => {
            console.log("Sent to server:", data);
            chrome.storage.local.set({
              [lastSentKey]: todayData,
              [pendingDeltaKey]: {},
              lastSyncAt: Date.now(),
              lastSyncError: "",
            });
            pruneOldDays();
          })
          .catch((err) => {
            console.log("Server not available, will retry:", err.message);
            chrome.storage.local.set({
              [pendingDeltaKey]: mergedToSend,
              lastSyncError: String(err?.message || err || "Unknown error"),
            });
          });
      }
    );
  });
}

// ─── Alarms ───────────────────────────────────────────────────────────────────

chrome.alarms.create("sendData", { periodInMinutes: 1 }); // single create

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sendData") {
    restoreTrackingState(() => {
      // Strict attention: only count while focused + active (not idle).
      if (!isIdle && isWindowFocused) {
        saveElapsed();
        if (startTime) startTime = Date.now(); // reset window so we don't double-count
      }
      saveTrackingState();
      console.log("Alarm fired, sending data...");
      sendToServer();
    });
  }
});

chrome.runtime.onSuspend.addListener(() => {
  try {
    saveElapsed();
  } finally {
    saveTrackingState();
  }
});

function initTrackingFromActiveTab() {
  restoreTrackingState(() => {
    if (isIdle || !isWindowFocused) return;
    if (currentSite && startTime) return;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url) {
        const domain = getDomain(tabs[0].url);
        if (!domain) return;
        currentSite = domain;
        startTime = Date.now();
        saveTrackingState();
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed/refreshed");
  ensureClientToken(() => {
    initTrackingFromActiveTab();
    sendToServer();
  });
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Browser started");
  ensureClientToken(() => {
    initTrackingFromActiveTab();
    sendToServer();
  });
});