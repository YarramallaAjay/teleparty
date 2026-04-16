// background.js — Minimal service worker
// The WebSocket connection lives in content.js for MV3 compatibility.
// This service worker handles extension lifecycle and popup ↔ tab routing.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[MovieParty] Installed. Open a streaming site and click the extension icon!');
  }
});

// Forward messages from the popup to the active content script tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message._from === 'popup') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return sendResponse({ error: 'No active tab' });

      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });
    return true; // Keep channel open for async sendResponse
  }
});
