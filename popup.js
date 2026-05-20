const DEFAULT_SERVER_URL =
  "https://attention-auditor-production.up.railway.app";

const CLIENT_TOKEN_KEY = "clientToken";
const TRACKING_STATE_KEY = "trackingState";

/** Mirrors server built-ins for bar colors in the popup (neutral if unknown). */
const POPUP_CATEGORIES = {
  "railway.app": "productive",
  "github.com": "productive",
  "google.com": "neutral",
  "mail.google.com": "productive",
  "docs.google.com": "productive",
  "claude.ai": "productive",
  "chatgpt.com": "neutral",
  "openai.com": "neutral",
  "stackoverflow.com": "productive",
  "youtube.com": "distracting",
  "netflix.com": "distracting",
  "spotify.com": "distracting",
  "instagram.com": "distracting",
  "facebook.com": "distracting",
  "twitter.com": "distracting",
  "x.com": "distracting",
  "reddit.com": "distracting",
  "tiktok.com": "distracting",
  "pinterest.com": "distracting",
  "whatsapp.com": "distracting",
  "discord.com": "distracting",
  "twitch.tv": "distracting",
  "amazon.com": "neutral",
  "wikipedia.org": "productive",
  "notion.so": "productive",
  "canvas.instructure.com": "productive",
  "touro.edu": "productive",
};

function categoryForDomain(domain) {
  return POPUP_CATEGORIES[domain] || "neutral";
}

function formatTime(seconds) {
  if (seconds < 60) return seconds + "s";
  let minutes = Math.floor(seconds / 60);
  let secs = seconds % 60;
  if (minutes < 60) return minutes + "m " + secs + "s";
  let hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  return hours + "h " + minutes + "m";
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderSites(sites) {
  const container = document.getElementById("sites");
  const countTag = document.getElementById("siteCountTag");
  container.innerHTML = "";

  if (!sites || sites.length === 0) {
    container.innerHTML =
      '<p class="empty">No browsing logged yet today.<br>Visit a few sites with Chrome focused.</p>';
    document.getElementById("totalTime").textContent = "0s";
    if (countTag) countTag.textContent = "0 sites";
    return;
  }

  sites.sort((a, b) => b.total_seconds - a.total_seconds);
  const maxSeconds = sites[0].total_seconds || 1;
  let totalSeconds = 0;

  sites.forEach((site, index) => {
    totalSeconds += site.total_seconds;
    const pct = Math.max(4, Math.round((site.total_seconds / maxSeconds) * 100));
    const cat = categoryForDomain(site.domain);
    const row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML = `
      <span class="rank">${index + 1}</span>
      <div class="bar-wrap">
        <div class="domain"></div>
        <div class="bar-track"><div class="bar-fill ${cat}" style="width:${pct}%"></div></div>
      </div>
      <span class="site-time"></span>
    `;
    row.querySelector(".domain").textContent = site.domain;
    row.querySelector(".site-time").textContent = formatTime(site.total_seconds);
    container.appendChild(row);
  });

  document.getElementById("totalTime").textContent = formatTime(totalSeconds);
  if (countTag) countTag.textContent = `${sites.length} site${sites.length === 1 ? "" : "s"}`;
}

function pauseReasonLabel(reason) {
  const labels = {
    locked: "Locked",
    unfocused: "Chrome unfocused",
    os_idle: "Away (idle)",
    untrackable: "Not a website",
    no_active_tab: "No tab",
    paused: "Paused",
  };
  return labels[reason] || reason || "Paused";
}

function renderStatus(trackingState) {
  const focusEl = document.getElementById("focusStatus");
  const idleEl = document.getElementById("idleStatus");
  const trackingEl = document.getElementById("trackingStatus");

  if (!focusEl || !trackingEl) return;

  const v2 = trackingState?.schemaVersion === 2;
  const chromeFocused = v2
    ? trackingState.chromeFocused
    : trackingState?.isWindowFocused;
  const isIdle = v2 ? trackingState.isIdle : trackingState?.isIdle;
  const currentSite = trackingState?.currentSite;
  const isRunning = v2 ? trackingState.isRunning : Boolean(trackingState?.startTime);
  const pauseReason = trackingState?.pauseReason;

  focusEl.className = "widget-value";
  if (chromeFocused === undefined) {
    focusEl.textContent = "--";
    focusEl.classList.add("muted");
  } else if (chromeFocused) {
    focusEl.textContent = "Yes";
    focusEl.classList.add("ok");
  } else {
    focusEl.textContent = "No";
    focusEl.classList.add("warn");
  }

  if (idleEl) {
    if (isIdle === undefined) {
      idleEl.textContent = "--";
    } else if (
      isIdle &&
      trackingState?.focusedWindowHasAudible &&
      trackingState?.osIdleState === "idle"
    ) {
      idleEl.textContent = "Watching";
    } else {
      idleEl.textContent = isIdle ? "Away" : "Active";
    }
  }

  trackingEl.className = "widget-value";
  if (!currentSite) {
    trackingEl.textContent = "—";
    trackingEl.classList.add("muted");
    return;
  }

  if (isRunning) {
    trackingEl.textContent = "Counting";
    trackingEl.classList.add("ok");
    trackingEl.title = currentSite;
  } else {
    trackingEl.textContent = pauseReasonLabel(pauseReason);
    trackingEl.classList.add("warn");
    trackingEl.title = currentSite;
  }
}

function formatDateTime(ms) {
  if (!ms) return "--";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString();
}

function renderSync(sync) {
  const atEl = document.getElementById("lastSyncAt");
  const errEl = document.getElementById("lastSyncError");
  if (!atEl) return;

  atEl.textContent = sync?.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "Never";
  if (errEl) {
    errEl.textContent = sync?.lastSyncError ? sync.lastSyncError : "None";
  }
}

function normalizeServerUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function effectiveServerBase(result) {
  const u = normalizeServerUrl(result.serverUrl);
  return u || DEFAULT_SERVER_URL;
}

function renderDevicePanel(result) {
  const tokenEl = document.getElementById("deviceId");
  const linkEl = document.getElementById("dashboardLoginLink");
  if (!tokenEl || !linkEl) return;

  const tok = result[CLIENT_TOKEN_KEY];
  tokenEl.value = typeof tok === "string" ? tok : "";
  const base = effectiveServerBase(result);
  linkEl.href = `${base}/login`;
  linkEl.textContent = "Open dashboard";
}

function initSettingsUI() {
  const serverUrlInput = document.getElementById("serverUrl");
  const saveBtn = document.getElementById("saveSettings");

  if (!serverUrlInput || !saveBtn) return;

  chrome.storage.local.get(["serverUrl", CLIENT_TOKEN_KEY], (result) => {
    serverUrlInput.value = result.serverUrl || "";
  });

  saveBtn.addEventListener("click", () => {
    const serverUrl = normalizeServerUrl(serverUrlInput.value) || "";
    chrome.storage.local.set({ serverUrl }, () => {
      chrome.storage.local.get(["serverUrl", CLIENT_TOKEN_KEY], renderDevicePanel);
      saveBtn.textContent = "Saved";
      setTimeout(() => (saveBtn.textContent = "Save"), 800);
    });
  });
}

document.getElementById("copyDeviceId")?.addEventListener("click", () => {
  const el = document.getElementById("deviceId");
  const v = el && el.value ? el.value : "";
  if (!v) return;
  navigator.clipboard.writeText(v).catch(() => {
    el.select();
    document.execCommand("copy");
  });
});

function loadAndRenderToday() {
  chrome.runtime.sendMessage({ type: "flushSession" }, () => {
    if (chrome.runtime.lastError) {
      console.warn("flushSession:", chrome.runtime.lastError.message);
    }

    const todayKey = getTodayKey();
    const storageKey = `siteData_${todayKey}`;

    chrome.storage.local.get(
      [
        storageKey,
        TRACKING_STATE_KEY,
        "lastSyncAt",
        "lastSyncUrl",
        "lastSyncError",
        CLIENT_TOKEN_KEY,
        "serverUrl",
      ],
      (result) => {
        const todayData = result[storageKey] || {};
        renderStatus(result[TRACKING_STATE_KEY]);
        renderSync({
          lastSyncAt: result.lastSyncAt,
          lastSyncUrl: result.lastSyncUrl,
          lastSyncError: result.lastSyncError,
        });
        renderDevicePanel(result);

        const sites = Object.entries(todayData)
          .filter(
            ([domain]) =>
              domain !== "0.1" && domain !== "localhost" && domain !== "localhost:5000"
          )
          .map(([domain, total_seconds]) => ({ domain, total_seconds }));

        renderSites(sites);
      }
    );
  });
}

loadAndRenderToday();
initSettingsUI();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const storageKey = `siteData_${getTodayKey()}`;
  if (
    changes[storageKey] ||
    changes[TRACKING_STATE_KEY] ||
    changes.trackingState ||
    changes.lastSyncAt ||
    changes.lastSyncUrl ||
    changes.lastSyncError ||
    changes[CLIENT_TOKEN_KEY] ||
    changes.serverUrl
  ) {
    loadAndRenderToday();
  }
});
