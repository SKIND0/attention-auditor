function formatTime(seconds) {
  if (seconds < 60) return seconds + "s";
  let minutes = Math.floor(seconds / 60);
  let secs = seconds % 60;
  if (minutes < 60) return minutes + "m " + secs + "s";
  let hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  return hours + "h " + minutes + "m";
}

fetch("http://127.0.0.1:5000/api/stats")
  .then(response => response.json())
  .then(data => {
    let container = document.getElementById("sites");
    let sites = data.today;

    if (sites.length === 0) {
      container.innerHTML = '<p class="empty">No data yet. Start browsing!</p>';
      return;
    }

    let totalSeconds = 0;

    sites.forEach((site, index) => {
      totalSeconds += site.total_seconds;
      let div = document.createElement("div");
      div.className = "site";
      div.innerHTML = `
        <span class="rank">#${index + 1}</span>
        <span class="domain">${site.domain}</span>
        <span class="time">${formatTime(site.total_seconds)}</span>
      `;
      container.appendChild(div);
    });

    document.getElementById("totalTime").textContent = formatTime(totalSeconds);
  })
  .catch(error => {
    document.getElementById("sites").innerHTML = '<p class="empty">Server not available</p>';
  });