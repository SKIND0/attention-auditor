console.log("BACKGROUND SCRIPT LOADED");

let currentSite = null;
let startTime = null;

const domainAliases = {
  "instructure.com": "touro.edu"
};

function getDomain(url) {
  try {
    if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
      return null;
    }

    let hostname = new URL(url).hostname;
    if (!hostname) return null;

    let parts = hostname.split(".");
    let domain = parts.length >= 2 ? parts.slice(-2).join(".") : hostname;

    if (domainAliases[domain]) {
      domain = domainAliases[domain];
    }

    return domain;
  } catch {
    return null;
  }
}

function trackTime() {
  if (!currentSite || !startTime) return;
  let timeSpent = Date.now() - startTime;
  let seconds = Math.round(timeSpent / 1000);
  if (seconds < 1) return;

  chrome.storage.local.get(["siteData"], (result) => {
    let siteData = result.siteData || {};
    if (!siteData[currentSite]) {
      siteData[currentSite] = 0;
    }
    siteData[currentSite] += seconds;
    chrome.storage.local.set({ siteData: siteData });
    console.log(`Tracked ${seconds}s on ${currentSite} (Total: ${siteData[currentSite]}s)`);
  });
}

function handleTabChange(url) {
  if (!url) return;
  let domain = getDomain(url);
  if (!domain) return;
  if (domain === currentSite) return;

  trackTime();
  currentSite = domain;
  startTime = Date.now();
  console.log("Now tracking:", domain);
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab.url) {
      handleTabChange(tab.url);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    handleTabChange(tab.url);
  }
});

let focusTimeout = null;

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (focusTimeout) return;
    focusTimeout = setTimeout(() => {
      console.log("Chrome lost focus, paused tracking");
      let saveSite = currentSite;
      let saveTime = startTime;
      currentSite = null;
      startTime = null;
      focusTimeout = null;

      if (saveSite && saveTime) {
        let seconds = Math.round((Date.now() - saveTime) / 1000);
        if (seconds < 1) return;
        chrome.storage.local.get(["siteData"], (result) => {
          let siteData = result.siteData || {};
          if (!siteData[saveSite]) siteData[saveSite] = 0;
          siteData[saveSite] += seconds;
          chrome.storage.local.set({ siteData: siteData });
          console.log(`Tracked ${seconds}s on ${saveSite} (Total: ${siteData[saveSite]}s)`);
        });
      }
    }, 5000);
  } else {
    if (focusTimeout) {
      clearTimeout(focusTimeout);
      focusTimeout = null;
    }
    chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
      if (tabs[0] && tabs[0].url) {
        handleTabChange(tabs[0].url);
      }
    });
  }
});

function sendToServer() {
  chrome.storage.local.get(["siteData"], (result) => {
    let siteData = result.siteData || {};
    let sites = [];

    for (let domain in siteData) {
      if (siteData[domain] > 0) {
        sites.push({ domain: domain, seconds: siteData[domain] });
      }
    }

    if (sites.length === 0) return;

    fetch("http://127.0.0.1:5000/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sites: sites })
    })
    .then(response => response.json())
    .then(data => {
      console.log("Sent to server:", data);
      chrome.storage.local.set({ siteData: {} });
    })
    .catch(error => {
      console.log("Server not available:", error);
    });
  });
}

chrome.alarms.create("sendData", { periodInMinutes: 1 });
chrome.alarms.create("sendData", { periodInMinutes: 1 });
sendToServer();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sendData") {
    console.log("Alarm fired, sending data...");
    sendToServer();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed/refreshed, sending data...");
  sendToServer();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Browser started, sending data...");
  sendToServer();
});