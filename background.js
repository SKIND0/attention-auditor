console.log("BACKGROUND SCRIPT LOADED");

let currentSite = null;
let startTime = null;
let isIdle = false;

const TRACKING_STATE_KEY = "trackingState";
const CLIENT_TOKEN_KEY = "clientToken";

// ─── Helper: find the active tab (works in MV3 service workers) ─────────────
function getActiveTab(callback) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0) {
      callback(tabs[0]);
      return;
    }
    chrome.tabs.query({ active: true }, (allTabs) => {
      if (allTabs && allTabs.length > 0) {
        callback(allTabs[0]);
      } else {
        callback(null);
      }
    });
  });
}

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
    }
    cb?.();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "flushSession") {
    saveElapsed(() => {
      if (startTime) startTime = Date.now();
      saveTrackingState();
      sendResponse({ ok: true });
    });
    return true;
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

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "co.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "gov.za",
  "com.cn", "net.cn", "org.cn", "com.sg", "com.hk", "com.tr",
]);

function registrableDomainFromHostname(hostname) {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 1) return hostname;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  if (MULTI_PART_SUFFIXES.has(last2) && parts.length >= 3) return last3;
  return last2;
}

function getDomain(url) {
  try {
    if (
      !url ||
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("chrome-devtools://") ||
      url.startsWith("devtools://") ||
      url.startsWith("about:") ||
      url.startsWith("edge://") ||
      url.startsWith("view-source:")
    ) {
      return null;
    }

    const hostname = new URL(url).hostname;
    if (!hostname) return null;

    if (hostname === "127.0.0.1" || hostname === "localhost") return "localhost:5000";
    if (domainAliases[hostname]) return domainAliases[hostname];
    if (KEEP_SUBDOMAIN.has(hostname)) return hostname;

    const domain = registrableDomainFromHostname(hostname);
    if (domainAliases[domain]) return domainAliases[domain];
    return domain;
  } catch {
    return null;
  }
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function saveElapsed(done) {
  const finish = typeof done === "function" ? done : () => {};
  if (!currentSite || !startTime) {
    finish();
    return;
  }
  const seconds = Math.round((Date.now() - startTime) / 1000);
  if (seconds < 1) {
    finish();
    return;
  }

  const todayKey = getTodayKey();
  const storageKey = `siteData_${todayKey}`;

  chrome.storage.local.get([storageKey], (result) => {
    const siteData = result[storageKey] || {};
    siteData[currentSite] = (siteData[currentSite] || 0) + seconds;
    chrome.storage.local.set({ [storageKey]: siteData }, () => {
      console.log(`Tracked ${seconds}s on ${currentSite} (Total: ${siteData[currentSite]}s)`);
      saveTrackingState();
      finish();
    });
  });
}

function isActiveTabAudible(callback) {
  getActiveTab((tab) => {
    callback(tab && tab.audible === true);
  });
}

function shouldAccumulateTime() {
  return !isIdle;
}

function switchToSite(url) {
  if (!url) return;
  const domain = getDomain(url);
  if (!domain) return;
  if (domain === currentSite) return;

  saveElapsed();
  currentSite = domain;
  startTime = shouldAccumulateTime() ? Date.now() : null;
  console.log("Now tracking:", domain);
  saveTrackingState();
}

function pauseTracking(reason) {
  if (!currentSite) return;
  saveElapsed();
  startTime = null;
  saveTrackingState();
}

function resumeTracking() {
  if (!currentSite) return;
  if (!shouldAccumulateTime()) return;
  if (startTime) return;
  startTime = Date.now();
  saveTrackingState();
}

// ─── Tab events ──────────────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isIdle) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab && tab.url) switchToSite(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isIdle) return;
  if (changeInfo.status === "complete" && tab.active && tab.url) {
    switchToSite(tab.url);
  }
});

// ─── Idle detection ───────────────────────────────────────────────────────────

chrome.idle.setDetectionInterval(60);

chrome.idle.onStateChanged.addListener((state) => {
  if (state === "idle" || state === "locked") {
    isActiveTabAudible((audible) => {
      if (audible) {
        console.log("System idle but media playing — continuing to track");
        return;
      }
      console.log("Idle detected — pausing tracking");
      isIdle = true;
      pauseTracking(`user ${state}`);
    });
  } else if (state === "active") {
    console.log("User active — resuming tracking");
    isIdle = false;
    getActiveTab((tab) => {
      if (tab && tab.url) {
        const domain = getDomain(tab.url);
        if (domain) {
          if (domain !== currentSite) currentSite = domain;
          resumeTracking();
        }
      }
    });
    saveTrackingState();
  }
});

// ─── Daily reset ─────────────────────────────────────────────────────────────

function pruneOldDays() {
  chrome.storage.local.get(null, (allData) => {
    const keysToRemove = [];
    for (const key of Object.keys(allData)) {
      let datePart = null;
      if (key.startsWith("siteData_")) datePart = key.replace("siteData_", "");
      else if (key.startsWith("lastSent_")) datePart = key.replace("lastSent_", "");
      else if (key.startsWith("pendingDelta_")) datePart = key.replace("pendingDelta_", "");
      else continue;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
      if (datePart < cutoffKey) keysToRemove.push(key);
    }
    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove);
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
      [storageKey, lastSentKey, pendingDeltaKey, "serverUrl"],
      (result) => {
        const todayData = result[storageKey] || {};
        const lastSent = result[lastSentKey] || {};
        const pendingDelta = result[pendingDeltaKey] || {};
        const baseUrl =
          (result.serverUrl && String(result.serverUrl).trim().replace(/\/+$/, "")) ||
          "https://attention-auditor-production.up.railway.app";
        const trackUrl = `${baseUrl}/api/track`;

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
          },
          body: JSON.stringify({ sites, date: todayKey }),
        })
          .then(async (r) => {
            let payload = null;
            try { payload = await r.json(); } catch { payload = null; }
            if (!r.ok) {
              const msg = (payload && (payload.error || payload.message)) || `HTTP ${r.status}`;
              const hint = payload && payload.hint ? ` ${payload.hint}` : "";
              throw new Error(`${msg}${hint}`);
            }
            return payload;
          })
          .then((data) => {
            console.log("Synced to server successfully");
            chrome.storage.local.set({
              [lastSentKey]: todayData,
              [pendingDeltaKey]: {},
              lastSyncAt: Date.now(),
              lastSyncError: "",
            });
            pruneOldDays();
          })
          .catch((err) => {
            console.log("Sync failed, will retry:", err.message);
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

chrome.alarms.create("sendData", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sendData") {
    restoreTrackingState(() => {
      chrome.idle.queryState(60, (state) => {
        if (state === "locked" || state === "idle") {
          if (!isIdle) {
            console.log("Alarm detected system is " + state + " — pausing");
            isIdle = true;
            isActiveTabAudible((audible) => {
              if (!audible) {
                pauseTracking("system " + state + " (detected on alarm tick)");
              }
            });
          }
          saveTrackingState();
          sendToServer();
          return;
        }

        isIdle = false;
        saveElapsed();
        if (startTime) startTime = Date.now();
        saveTrackingState();
        sendToServer();
      });
    });
  }
});

chrome.runtime.onSuspend.addListener(() => {
  try { saveElapsed(); } finally { saveTrackingState(); }
});

function initTrackingFromActiveTab() {
  restoreTrackingState(() => {
    if (isIdle) return;
    if (currentSite && startTime) return;
    getActiveTab((tab) => {
      if (tab && tab.url) {
        const domain = getDomain(tab.url);
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