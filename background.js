/**
 * Attention Auditor — background service worker (MV3)
 * Version A: track time only when Chrome is focused, OS is active (or media
 * exception in focused window), and the active tab is a normal website.
 */
console.log("BACKGROUND SCRIPT LOADED (tracking v2)");

// ─── Config ───────────────────────────────────────────────────────────────────

const TRACKING_STATE_KEY = "trackingState";
const CLIENT_TOKEN_KEY = "clientToken";
const SCHEMA_VERSION = 2;
const IDLE_DETECTION_SEC = 60;
const HEARTBEAT_ALARM = "heartbeat";
const HEARTBEAT_PERIOD_MIN = 1; // Chrome minimum for repeating alarms
const MAX_SLICE_SEC = 90; // safety cap per commit (sleep / suspended worker)
const STALE_SEGMENT_MS = 2 * 60 * 1000;

// ─── In-memory session ────────────────────────────────────────────────────────

const session = {
  chromeFocused: false,
  osIdleState: "active",
  focusedWindowId: null,
  activeTabId: null,
  activeTabUrl: null,
  focusedWindowHasAudible: false,
};

/** @type {{ domain: string, startedAt: number, lastHeartbeatAt: number } | null} */
let openSegment = null;
let pauseReason = null;

// ─── Domain helpers ─────────────────────────────────────────────────────────

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

function filterJunkDomain(domain) {
  return domain && domain !== "0.1" && domain !== "localhost" && domain !== "localhost:5000";
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function buildTrackingStatePayload() {
  const domain = openSegment?.domain ?? getDomain(session.activeTabUrl);
  const mediaIdleOverride =
    session.osIdleState === "idle" && session.focusedWindowHasAudible && session.chromeFocused;

  return {
    schemaVersion: SCHEMA_VERSION,
    openSegment: openSegment ? { ...openSegment } : null,
    pauseReason,
    chromeFocused: session.chromeFocused,
    osIdleState: session.osIdleState,
    focusedWindowId: session.focusedWindowId,
    activeTabId: session.activeTabId,
    focusedWindowHasAudible: session.focusedWindowHasAudible,
    currentSite: domain || null,
    isWindowFocused: session.chromeFocused,
    isIdle:
      session.osIdleState === "locked" ||
      (session.osIdleState === "idle" && !mediaIdleOverride),
    isRunning: Boolean(openSegment),
    startTime: openSegment?.lastHeartbeatAt ?? null,
    savedAt: Date.now(),
  };
}

function persistTrackingState(done) {
  chrome.storage.local.set({ [TRACKING_STATE_KEY]: buildTrackingStatePayload() }, () => done?.());
}

function loadTrackingState(done) {
  chrome.storage.local.get([TRACKING_STATE_KEY], (result) => {
    const st = result[TRACKING_STATE_KEY];
    openSegment = null;
    pauseReason = null;

    if (!st) {
      done?.();
      return;
    }

    if (st.schemaVersion === SCHEMA_VERSION) {
      session.chromeFocused = Boolean(st.chromeFocused);
      session.osIdleState = st.osIdleState || "active";
      session.focusedWindowId = st.focusedWindowId ?? null;
      session.activeTabId = st.activeTabId ?? null;
      session.focusedWindowHasAudible = Boolean(st.focusedWindowHasAudible);
      pauseReason = st.pauseReason ?? null;

      if (st.openSegment?.domain && st.openSegment.lastHeartbeatAt) {
        const age = Date.now() - st.openSegment.lastHeartbeatAt;
        if (age <= STALE_SEGMENT_MS) {
          openSegment = {
            domain: st.openSegment.domain,
            startedAt: st.openSegment.startedAt || st.openSegment.lastHeartbeatAt,
            lastHeartbeatAt: st.openSegment.lastHeartbeatAt,
          };
        } else {
          console.log("Discarded stale open segment (>2m) without crediting");
        }
      }
      done?.();
      return;
    }

    // v1 migration — never restore old startTime (avoid gap spikes)
    console.log("Migrated tracking state from v1 → v2 (segment cleared)");
    done?.();
  });
}

function creditSeconds(domain, seconds, done) {
  if (!filterJunkDomain(domain) || seconds < 1) {
    done?.();
    return;
  }

  const storageKey = `siteData_${getTodayKey()}`;
  chrome.storage.local.get([storageKey], (result) => {
    const siteData = result[storageKey] || {};
    siteData[domain] = (siteData[domain] || 0) + seconds;
    chrome.storage.local.set({ [storageKey]: siteData }, () => {
      console.log(`+${seconds}s → ${domain} (total ${siteData[domain]}s)`);
      done?.();
    });
  });
}

// ─── Segment / heartbeat ──────────────────────────────────────────────────────

function commitSlice(finish) {
  if (!openSegment) {
    finish?.();
    return;
  }

  const now = Date.now();
  const raw = Math.round((now - openSegment.lastHeartbeatAt) / 1000);
  const seconds = Math.max(0, Math.min(raw, MAX_SLICE_SEC));

  if (seconds < 1) {
    openSegment.lastHeartbeatAt = now;
    finish?.();
    return;
  }

  const domain = openSegment.domain;
  creditSeconds(domain, seconds, () => {
    openSegment.lastHeartbeatAt = now;
    finish?.();
  });
}

function flushSegment(finish) {
  if (!openSegment) {
    finish?.();
    return;
  }
  commitSlice(() => {
    openSegment = null;
    finish?.();
  });
}

function openSegmentForDomain(domain) {
  const now = Date.now();
  openSegment = { domain, startedAt: now, lastHeartbeatAt: now };
  pauseReason = null;
  console.log("Segment opened:", domain);
}

// ─── Presence & rules (Version A) ─────────────────────────────────────────────

function mediaIdleException() {
  return (
    session.osIdleState === "idle" &&
    session.chromeFocused &&
    session.focusedWindowHasAudible
  );
}

function shouldAccumulate() {
  if (session.osIdleState === "locked") return false;
  if (!session.chromeFocused || session.focusedWindowId == null) return false;

  const domain = getDomain(session.activeTabUrl);
  if (!domain) return false;

  if (session.osIdleState === "active") return true;
  if (mediaIdleException()) return true;

  return false;
}

function derivePauseReason() {
  if (session.osIdleState === "locked") return "locked";
  if (!session.chromeFocused) return "unfocused";
  if (session.osIdleState === "idle" && !mediaIdleException()) return "os_idle";
  if (!getDomain(session.activeTabUrl)) return "untrackable";
  if (!session.activeTabUrl) return "no_active_tab";
  return "paused";
}

function refreshPresence(done) {
  chrome.idle.queryState(IDLE_DETECTION_SEC, (idleState) => {
    session.osIdleState = idleState || "active";

    chrome.windows.getLastFocused({ populate: false }, (win) => {
      if (chrome.runtime.lastError || !win?.id) {
        session.chromeFocused = false;
        session.focusedWindowId = null;
        session.activeTabId = null;
        session.activeTabUrl = null;
        session.focusedWindowHasAudible = false;
        done?.();
        return;
      }

      session.chromeFocused = true;
      session.focusedWindowId = win.id;

      chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
        const tab = tabs?.[0];
        session.activeTabId = tab?.id ?? null;
        session.activeTabUrl = tab?.url ?? null;

        chrome.tabs.query({ windowId: win.id, audible: true }, (audibleTabs) => {
          session.focusedWindowHasAudible = Boolean(
            audibleTabs?.some((t) => t.audible)
          );
          done?.();
        });
      });
    });
  });
}

/** Single decision point: flush, open, or pause. */
function recompute(done) {
  refreshPresence(() => {
    const domain = getDomain(session.activeTabUrl);
    const accumulating = shouldAccumulate();

    if (!accumulating) {
      if (openSegment) {
        return flushSegment(() => {
          pauseReason = derivePauseReason();
          persistTrackingState(done);
        });
      }
      pauseReason = derivePauseReason();
      persistTrackingState(done);
      return;
    }

    pauseReason = null;

    if (!openSegment) {
      openSegmentForDomain(domain);
      persistTrackingState(done);
      return;
    }

    if (openSegment.domain !== domain) {
      return flushSegment(() => {
        openSegmentForDomain(domain);
        persistTrackingState(done);
      });
    }

    persistTrackingState(done);
  });
}

// ─── Client token ───────────────────────────────────────────────────────────────

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

// ─── Messages ───────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "flushSession") {
    const afterFlush = () => {
      if (shouldAccumulate()) {
        const domain = getDomain(session.activeTabUrl);
        if (domain) {
          if (!openSegment || openSegment.domain !== domain) {
            openSegmentForDomain(domain);
          } else {
            openSegment.lastHeartbeatAt = Date.now();
          }
        }
      }
      persistTrackingState(() => sendResponse({ ok: true, state: buildTrackingStatePayload() }));
    };

    refreshPresence(() => {
      if (openSegment) flushSegment(afterFlush);
      else afterFlush();
    });
    return true;
  }

  if (message.type === "getTrackingState") {
    sendResponse(buildTrackingStatePayload());
    return false;
  }
});

// ─── Server sync ────────────────────────────────────────────────────────────────

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
    if (keysToRemove.length > 0) chrome.storage.local.remove(keysToRemove);
  });
}

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
          const diff = total - (lastSent[domain] || 0);
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
            try {
              payload = await r.json();
            } catch {
              payload = null;
            }
            if (!r.ok) {
              const msg = (payload && (payload.error || payload.message)) || `HTTP ${r.status}`;
              const hint = payload && payload.hint ? ` ${payload.hint}` : "";
              throw new Error(`${msg}${hint}`);
            }
            return payload;
          })
          .then(() => {
            chrome.storage.local.set({
              [lastSentKey]: todayData,
              [pendingDeltaKey]: {},
              lastSyncAt: Date.now(),
              lastSyncError: "",
            });
            pruneOldDays();
          })
          .catch((err) => {
            chrome.storage.local.set({
              [pendingDeltaKey]: mergedToSend,
              lastSyncError: String(err?.message || err || "Unknown error"),
            });
          });
      }
    );
  });
}

// ─── Heartbeat alarm ────────────────────────────────────────────────────────────

function onHeartbeat() {
  refreshPresence(() => {
    const domain = getDomain(session.activeTabUrl);

    if (shouldAccumulate() && openSegment) {
      if (openSegment.domain !== domain) {
        return recompute(() => sendToServer());
      }
      return commitSlice(() => {
        if (!shouldAccumulate()) {
          return flushSegment(() => {
            pauseReason = derivePauseReason();
            persistTrackingState(() => sendToServer());
          });
        }
        persistTrackingState(() => sendToServer());
      });
    }

    if (shouldAccumulate() && !openSegment && domain) {
      return recompute(() => sendToServer());
    }

    if (openSegment) {
      return flushSegment(() => {
        pauseReason = derivePauseReason();
        persistTrackingState(() => sendToServer());
      });
    }

    pauseReason = derivePauseReason();
    persistTrackingState(() => sendToServer());
  });
}

// ─── Chrome listeners ───────────────────────────────────────────────────────────

chrome.idle.setDetectionInterval(IDLE_DETECTION_SEC);

chrome.idle.onStateChanged.addListener((state) => {
  session.osIdleState = state;
  if (state === "locked") {
    return flushSegment(() => {
      pauseReason = "locked";
      persistTrackingState();
    });
  }
  recompute();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    session.chromeFocused = false;
    session.focusedWindowId = null;
    session.focusedWindowHasAudible = false;
    return flushSegment(() => {
      pauseReason = "unfocused";
      persistTrackingState();
    });
  }

  session.chromeFocused = true;
  session.focusedWindowId = windowId;
  recompute();
});

function onTabContextChanged(tab) {
  if (!tab?.windowId) return;
  if (session.focusedWindowId != null && tab.windowId !== session.focusedWindowId) return;
  if (!tab.active) return;

  session.activeTabId = tab.id ?? null;
  session.activeTabUrl = tab.url ?? tab.pendingUrl ?? session.activeTabUrl;

  chrome.tabs.query({ windowId: tab.windowId, audible: true }, (audibleTabs) => {
    session.focusedWindowHasAudible = Boolean(audibleTabs?.some((t) => t.audible));
    recompute();
  });
}

chrome.tabs.onActivated.addListener((info) => {
  chrome.tabs.get(info.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    onTabContextChanged(tab);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.audible != null && tab.windowId === session.focusedWindowId) {
    chrome.tabs.query({ windowId: tab.windowId, audible: true }, (audibleTabs) => {
      session.focusedWindowHasAudible = Boolean(audibleTabs?.some((t) => t.audible));
      if (tab.active) onTabContextChanged(tab);
      else recompute();
    });
    return;
  }
  if (tabId !== session.activeTabId && !tab.active) return;
  if (changeInfo.url || changeInfo.status === "complete") {
    onTabContextChanged(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== session.activeTabId) return;
  recompute();
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MIN });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) onHeartbeat();
});

chrome.runtime.onSuspend.addListener(() => {
  try {
    if (openSegment) {
      const now = Date.now();
      const raw = Math.round((now - openSegment.lastHeartbeatAt) / 1000);
      const seconds = Math.max(0, Math.min(raw, MAX_SLICE_SEC));
      if (seconds >= 1) {
        const storageKey = `siteData_${getTodayKey()}`;
        const siteData = {};
        siteData[openSegment.domain] = seconds;
        chrome.storage.local.get([storageKey], (result) => {
          const existing = result[storageKey] || {};
          existing[openSegment.domain] = (existing[openSegment.domain] || 0) + seconds;
          chrome.storage.local.set({
            [storageKey]: existing,
            [TRACKING_STATE_KEY]: buildTrackingStatePayload(),
          });
        });
        return;
      }
    }
    persistTrackingState();
  } catch (e) {
    console.warn("onSuspend:", e);
  }
});

function bootstrap() {
  loadTrackingState(() => {
    refreshPresence(() => recompute(() => sendToServer()));
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed/updated — tracking v2");
  ensureClientToken(bootstrap);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Browser started — tracking v2");
  ensureClientToken(bootstrap);
});

// Service worker restarted (not always followed by onStartup)
ensureClientToken(() => {
  loadTrackingState(() => refreshPresence(() => recompute()));
});
