chrome.runtime.sendMessage({ type: "flushSession" });

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

// Always load local data — it's always fresh
setTimeout(() => {
  const todayKey = getTodayKey();
  const storageKey = `siteData_${todayKey}`;

  chrome.storage.local.get([storageKey, "pendingData"], (result) => {
    const todayData = result[storageKey] || {};
    const pending = result.pendingData || {};

    const merged = { ...pending };
    for (const [domain, secs] of Object.entries(todayData)) {
      merged[domain] = (merged[domain] || 0) + secs;
    }

    const sites = Object.entries(merged)
      .filter(([domain]) => domain !== "0.1" && domain !== "localhost")
      .map(([domain, total_seconds]) => ({ domain, total_seconds }));

    renderSites(sites);
  });
}, 100);