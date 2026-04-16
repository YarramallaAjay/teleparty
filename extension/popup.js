// popup.js — Extension toolbar popup

const STREAMING_DOMAINS = [
  'netflix.com',
  'primevideo.com',
  'amazon.com',
  'disneyplus.com',
  'hulu.com',
  'max.com',
  'tv.apple.com',
  'youtube.com',
  'peacocktv.com',
  'paramountplus.com',
  'mubi.com',
  'crunchyroll.com',
  'discoveryplus.com',
];

function show(id) { document.getElementById(id).style.display = 'flex'; }
function hide(id) { document.getElementById(id).style.display = 'none'; }
function qs(sel)  { return document.querySelector(sel); }

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab) return;

  const onStreamingSite = STREAMING_DOMAINS.some((d) => tab.url?.includes(d));

  if (!onStreamingSite) {
    show('p-no-site');
    return;
  }

  // Query content script for party status
  chrome.tabs.sendMessage(tab.id, { type: 'get_status' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Content script not ready yet (page still loading)
      show('p-idle');
      wireIdleButtons(tab.id);
      return;
    }

    if (response.isInParty) {
      show('p-in-party');
      qs('#p-room-id').textContent = response.roomId || '';
      qs('#p-member-count').textContent =
        `${response.memberCount} member${response.memberCount !== 1 ? 's' : ''} in the party`;
      wirePartyButtons(tab.id, response.roomId);
    } else {
      show('p-idle');
      wireIdleButtons(tab.id);
    }
  });
});

function wireIdleButtons(tabId) {
  qs('#p-open-sidebar')?.addEventListener('click', () => {
    chrome.tabs.sendMessage(tabId, { type: 'toggle_sidebar' });
    window.close();
  });
}

function wirePartyButtons(tabId, roomId) {
  qs('#p-open-chat')?.addEventListener('click', () => {
    chrome.tabs.sendMessage(tabId, { type: 'toggle_sidebar' });
    window.close();
  });

  qs('#p-copy-id')?.addEventListener('click', () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).catch(() => {});
    qs('#p-copy-id').title = 'Copied!';
    setTimeout(() => { qs('#p-copy-id').title = 'Copy Room ID'; }, 1500);
  });
}
