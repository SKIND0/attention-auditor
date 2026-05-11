const DEFAULT_SERVER_URL =
  "https://attention-auditor-production.up.railway.app";

const CLIENT_TOKEN_KEY = "clientToken";

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
  container.innerHTML = "";

  if (!sites || sites.length === 0) {
    container.innerHTML = '<p class="empty">No data yet. Start browsing!</p>';
    document.getElementById("totalTime").textContent = "0s";
    return;
  }

  sites.sort((a, b) => b.total_seconds - a.total_seconds);

  let totalSeconds = 0;
  sites.forEach((site, index) => {
    totalSeconds += site.total_seconds;
    const div = document.createElement("div");
    div.className = "site";
    div.innerHTML = `
      <span class="rank">#${index + 1}</span>
      <span class="domain">${site.domain}</span>
      <span class="time">${formatTime(site.total_seconds)}</span>
    `;
    container.appendChild(div);
  });

  document.getElementById("totalTime").textContent = formatTime(totalSeconds);
}

function renderStatus(trackingState) {
  const focusEl = document.getElementById("focusStatus");
  const idleEl = document.getElementById("idleStatus");
  const trackingEl = document.getElementById("trackingStatus");

  if (!focusEl || !idleEl || !trackingEl) return;

  const isFocused = trackingState?.isWindowFocused;
  const isIdle = trackingState?.isIdle;
  const currentSite = trackingState?.currentSite;
  const startTime = trackingState?.startTime;

  focusEl.textContent = isFocused === undefined ? "--" : isFocused ? "Focused" : "Unfocused";
  idleEl.textContent = isIdle === undefined ? "--" : isIdle ? "Idle" : "Active";

  if (!currentSite) {
    trackingEl.textContent = "--";
    return;
  }

  const running = Boolean(startTime);
  trackingEl.textContent = running ? `${currentSite} (running)` : `${currentSite} (paused)`;
}

function formatDateTime(ms) {
  if (!ms) return "--";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString();
}

function renderSync(sync) {
  const atEl = document.getElementById("lastSyncAt");
  const urlEl = document.getElementById("lastSyncUrl");
  const errEl = document.getElementById("lastSyncError");
  if (!atEl || !urlEl || !errEl) return;

  atEl.textContent = sync?.lastSyncAt ? formatDateTime(sync.lastSyncAt) : "--";
  urlEl.textContent = sync?.lastSyncUrl || "--";
  errEl.textContent = sync?.lastSyncError ? sync.lastSyncError : "None";
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
  // Flush open tracking into storage first, then read — otherwise the popup races and shows stale totals.
  chrome.runtime.sendMessage({ type: "flushSession" }, () => {
    if (chrome.runtime.lastError) {
      console.warn("flushSession:", chrome.runtime.lastError.message);
    }

    const todayKey = getTodayKey();
    const storageKey = `siteData_${todayKey}`;

    chrome.storage.local.get(
      [storageKey, "trackingState", "lastSyncAt", "lastSyncUrl", "lastSyncError", CLIENT_TOKEN_KEY, "serverUrl"],
      (result) => {
        const todayData = result[storageKey] || {};
        renderStatus(result.trackingState);
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

// Render immediately on open
loadAndRenderToday();
initSettingsUI();

// Live update while popup is open
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const storageKey = `siteData_${getTodayKey()}`;
  if (
    changes[storageKey] ||
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