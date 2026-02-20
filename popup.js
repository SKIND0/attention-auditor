function formatTime(seconds) {
  if (seconds < 60) return seconds + "s";
  let minutes = Math.floor(seconds / 60);
  let secs = seconds % 60;
  if (minutes < 60) return minutes + "m " + secs + "s";
  let hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  return hours + "h " + minutes + "m";
}

chrome.storage.local.get(["siteData"], (result) => {
  let siteData = result.siteData || {};
  let container = document.getElementById("sites");

  let sites = Object.entries(siteData).sort((a, b) => b[1] - a[1]);

  if (sites.length === 0) {
    container.innerHTML = '<p class="empty">No data yet. Start browsing!</p>';
    return;
  }

  let totalSeconds = 0;

  sites.forEach(([domain, seconds], index) => {
    totalSeconds += seconds;
    let div = document.createElement("div");
    div.className = "site";
    div.innerHTML = `
      <span class="rank">#${index + 1}</span>
      <span class="domain">${domain}</span>
      <span class="time">${formatTime(seconds)}</span>
    `;
    container.appendChild(div);
  });

  document.getElementById("totalTime").textContent = formatTime(totalSeconds);
});