/**
 * MovieParty — Content Script
 *
 * Injected into every supported streaming site. Manages:
 *   • Video element detection + playback sync
 *   • WebSocket connection to the MovieParty server
 *   • Chat sidebar UI (injected overlay)
 *   • Party create / join / leave flows
 *
 * Change SERVER_URL below to point at your deployed server for remote parties.
 */

(function () {
  'use strict';

  // Prevent double-injection (e.g. on SPA navigations where the script reruns)
  if (window.__moviePartyLoaded) return;
  window.__moviePartyLoaded = true;

  // ═══════════════════════════════════════════════════════════════
  //  CONFIG
  // ═══════════════════════════════════════════════════════════════

  const SERVER_URL = 'ws://teleparty-production.up.railway.app:8080'; // ← change for production

  // ═══════════════════════════════════════════════════════════════
  //  STATE
  // ═══════════════════════════════════════════════════════════════

  let ws = null;
  let wsReconnectTimer = null;
  let pingInterval = null;

  let videoEl = null;
  let isSyncing = false;         // suppresses re-broadcast while applying remote sync
  let seekDebounceTimer = null;

  let isInParty = false;
  let myUserId = null;
  let myUsername = 'Guest';
  let currentRoomId = null;
  let partyMembers = [];
  let amIHost = false;

  let sidebarEl = null;
  let toggleBtnEl = null;
  let sidebarOpen = false;

  // ═══════════════════════════════════════════════════════════════
  //  VIDEO DETECTION
  // ═══════════════════════════════════════════════════════════════

  const PLATFORM_SELECTORS = {
    'youtube.com':       ['video.html5-main-video', '#movie_player video', 'video'],
    'netflix.com':       ['.VideoContainer video', '[data-videoplayer] video', 'video'],
    'primevideo.com':    ['.webPlayerElement video', '[data-testid*="player"] video', 'video'],
    'amazon.com':        ['.webPlayerElement video', '[data-testid*="player"] video', 'video'],
    'disneyplus.com':    ['.btm-media-client-element video', 'video'],
    'hulu.com':          ['.player-container video', 'video'],
    'max.com':           ['[class*="player"] video', 'video'],
    'tv.apple.com':      ['[class*="player"] video', 'video'],
    'peacocktv.com':     ['video'],
    'paramountplus.com': ['video'],
    'mubi.com':          ['video'],
    'crunchyroll.com':   ['video'],
    'discoveryplus.com': ['video'],
  };

  function getPlatformSelectors() {
    const host = window.location.hostname;
    for (const [domain, selectors] of Object.entries(PLATFORM_SELECTORS)) {
      if (host.includes(domain)) return selectors;
    }
    return ['video'];
  }

  function findVideoElement() {
    const selectors = getPlatformSelectors();

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el instanceof HTMLVideoElement && el.readyState >= 0) return el;
      } catch (_) {}
    }

    // Fallback: largest video by resolution
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    if (videos.length === 1) return videos[0];
    return videos.reduce((best, v) =>
      v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight ? v : best
    );
  }

  function detachVideoListeners() {
    if (!videoEl) return;
    videoEl.removeEventListener('play',   onVideoPlay);
    videoEl.removeEventListener('pause',  onVideoPause);
    videoEl.removeEventListener('seeked', onVideoSeeked);
  }

  function attachVideoListeners(video) {
    detachVideoListeners();
    videoEl = video;
    video.addEventListener('play',   onVideoPlay);
    video.addEventListener('pause',  onVideoPause);
    video.addEventListener('seeked', onVideoSeeked);
    addSystemMessage('🎬 Video player detected — ready to sync.');
  }

  function startVideoDetection() {
    const video = findVideoElement();
    if (video) { attachVideoListeners(video); return; }

    // Watch for video element appearing in the DOM
    const mo = new MutationObserver(() => {
      const v = findVideoElement();
      if (v && v !== videoEl) {
        attachVideoListeners(v);
        mo.disconnect();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Handle SPA URL changes (Netflix, Disney+, etc. navigate without full reload)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        detachVideoListeners();
        videoEl = null;
        setTimeout(() => {
          const v = findVideoElement();
          if (v) attachVideoListeners(v);
        }, 2000);
      }
    }, 1500);
  }

  // ═══════════════════════════════════════════════════════════════
  //  VIDEO EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════

  function onVideoPlay() {
    if (isSyncing || !isInParty) return;
    sendVideoSync('play', videoEl.currentTime);
  }

  function onVideoPause() {
    if (isSyncing || !isInParty) return;
    sendVideoSync('pause', videoEl.currentTime);
  }

  function onVideoSeeked() {
    if (isSyncing || !isInParty) return;
    clearTimeout(seekDebounceTimer);
    seekDebounceTimer = setTimeout(() => {
      sendVideoSync('seek', videoEl.currentTime);
    }, 300);
  }

  function sendVideoSync(action, currentTime) {
    sendWS({ type: 'video_sync', action, currentTime });
  }

  function applyVideoSync(action, currentTime, serverTimestamp) {
    if (!videoEl) return;
    isSyncing = true;

    try {
      // Compensate for network latency on play
      const latency = serverTimestamp ? (Date.now() - serverTimestamp) / 1000 : 0;
      const adjustedTime = action === 'play'
        ? currentTime + Math.min(latency, 3)
        : currentTime;

      const drift = Math.abs(videoEl.currentTime - adjustedTime);

      if (action === 'play') {
        if (drift > 0.5) videoEl.currentTime = adjustedTime;
        videoEl.play().catch(() => {});
      } else if (action === 'pause') {
        if (drift > 0.5) videoEl.currentTime = currentTime;
        videoEl.pause();
      } else if (action === 'seek') {
        videoEl.currentTime = currentTime;
      }
    } finally {
      setTimeout(() => { isSyncing = false; }, 600);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  WEBSOCKET
  // ═══════════════════════════════════════════════════════════════

  function connectWebSocket(onReady) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (onReady) onReady();
      return;
    }

    ws = new WebSocket(SERVER_URL);

    ws.addEventListener('open', () => {
      clearTimeout(wsReconnectTimer);
      startPing();
      if (onReady) onReady();
    });

    ws.addEventListener('message', (evt) => {
      try {
        handleServerMessage(JSON.parse(evt.data));
      } catch (_) {}
    });

    ws.addEventListener('close', () => {
      stopPing();
      if (isInParty) {
        showNotification('Connection lost — reconnecting…', 'warn');
        wsReconnectTimer = setTimeout(connectWebSocket, 3500);
      }
    });

    ws.addEventListener('error', () => {
      showNotification('Cannot reach MovieParty server. Is it running?', 'error');
    });
  }

  function sendWS(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function startPing() {
    stopPing();
    pingInterval = setInterval(() => sendWS({ type: 'ping' }), 25000);
  }

  function stopPing() {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARTY MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  function createParty() {
    myUsername = getUsernameInput();
    saveUsername(myUsername);
    connectWebSocket(() => {
      sendWS({ type: 'create_room', username: myUsername });
    });
  }

  function joinParty() {
    const roomInput = qs('#mp-room-input').value.trim().toUpperCase();
    if (!roomInput) { showNotification('Enter a Room ID first.', 'error'); return; }
    myUsername = getUsernameInput();
    saveUsername(myUsername);
    connectWebSocket(() => {
      sendWS({ type: 'join_room', roomId: roomInput, username: myUsername });
    });
  }

  function leaveParty() {
    isInParty = false;
    currentRoomId = null;
    partyMembers = [];
    amIHost = false;
    if (ws) { ws.close(); ws = null; }
    stopPing();
    leavePartyUI();
    showNotification('Left the party.');
  }

  // ═══════════════════════════════════════════════════════════════
  //  SERVER MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════

  function handleServerMessage(msg) {
    switch (msg.type) {

      case 'room_created':
        myUserId = msg.userId;
        currentRoomId = msg.roomId;
        partyMembers = msg.members || [];
        amIHost = true;
        isInParty = true;
        updatePartyUI();
        addSystemMessage(`🎉 Party created! Share Room ID: ${msg.roomId}`);
        break;

      case 'room_joined':
        myUserId = msg.userId;
        currentRoomId = msg.roomId;
        partyMembers = msg.members || [];
        amIHost = false;
        isInParty = true;
        updatePartyUI();
        addSystemMessage(`✅ Joined the party! Room: ${msg.roomId}`);
        // Request a sync nudge from the host
        sendWS({ type: 'video_sync', action: 'request_state' });
        break;

      case 'error':
        showNotification(msg.message || 'Something went wrong.', 'error');
        break;

      case 'member_joined':
        partyMembers = msg.members || [];
        renderMemberList();
        updateBadge();
        addSystemMessage(`👋 ${escHtml(msg.username)} joined the party.`);
        // If I'm host, sync current video state to the new member
        if (amIHost && videoEl) {
          setTimeout(() => {
            sendVideoSync(videoEl.paused ? 'pause' : 'play', videoEl.currentTime);
          }, 800);
        }
        break;

      case 'member_left':
        partyMembers = msg.members || [];
        if (msg.newHostId === myUserId) {
          amIHost = true;
          addSystemMessage('👑 You are now the host.');
        }
        renderMemberList();
        updateBadge();
        addSystemMessage(`👤 ${escHtml(msg.username)} left the party.`);
        break;

      case 'video_sync':
        if (!isInParty) break;
        applyVideoSync(msg.action, msg.currentTime, msg.serverTimestamp);
        showSyncIndicator(msg.action, msg.username);
        break;

      case 'chat_message':
        addChatMessage(msg.username, msg.message, false, msg.timestamp);
        break;

      case 'reaction':
        showFloatingReaction(msg.emoji, msg.username);
        break;

      case 'pong':
        // keep-alive acknowledged
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI — SIDEBAR SKELETON
  // ═══════════════════════════════════════════════════════════════

  function injectSidebar() {
    // Toggle button (always visible on right edge)
    toggleBtnEl = document.createElement('div');
    toggleBtnEl.id = 'mp-toggle';
    toggleBtnEl.title = 'MovieParty';
    toggleBtnEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round">
        <path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.875v6.25a1 1 0 0 1-1.447.894L15 14M3 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      </svg>
      <span id="mp-badge" class="mp-badge"></span>
    `;
    toggleBtnEl.addEventListener('click', toggleSidebar);
    document.body.appendChild(toggleBtnEl);

    // Sidebar panel
    sidebarEl = document.createElement('div');
    sidebarEl.id = 'mp-sidebar';
    sidebarEl.innerHTML = buildSidebarHTML();
    document.body.appendChild(sidebarEl);

    wireSidebarEvents();
    loadSavedUsername();
  }

  function buildSidebarHTML() {
    return /* html */ `
      <!-- Header -->
      <div class="mp-header">
        <div class="mp-brand">
          <svg class="mp-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 10l4.553-2.069A1 1 0 0 1 21 8.875v6.25a1 1 0 0 1-1.447.894L15 14M3 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
          <span>MovieParty</span>
        </div>
        <button id="mp-close" class="mp-icon-btn" title="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- ── NOT IN PARTY ── -->
      <div id="mp-join-section" class="mp-section">
        <div class="mp-field-group">
          <label class="mp-label">Your display name</label>
          <input id="mp-username" class="mp-input" type="text" placeholder="e.g. Alice" maxlength="24" spellcheck="false" />
        </div>

        <button id="mp-create-btn" class="mp-btn mp-btn-primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          Create Party
        </button>

        <div class="mp-or">— or join existing —</div>

        <div class="mp-row">
          <input id="mp-room-input" class="mp-input mp-input-code" type="text"
                 placeholder="Room ID" maxlength="8" spellcheck="false"
                 style="text-transform:uppercase;letter-spacing:2px" />
          <button id="mp-join-btn" class="mp-btn mp-btn-secondary">Join</button>
        </div>

        <div class="mp-platforms">
          Works on Netflix · Prime · Disney+ · Hulu · Max · YouTube · Peacock · Paramount+ · Apple TV+ · more
        </div>
      </div>

      <!-- ── IN PARTY ── -->
      <div id="mp-party-section" class="mp-section" style="display:none">
        <div class="mp-room-bar">
          <div>
            <div class="mp-room-label">Room ID</div>
            <div id="mp-room-display" class="mp-room-id"></div>
          </div>
          <button id="mp-copy-room" class="mp-icon-btn" title="Copy Room ID">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>

        <div id="mp-members" class="mp-members"></div>

        <!-- Chat -->
        <div class="mp-chat-wrapper">
          <div id="mp-messages" class="mp-messages"></div>

          <div class="mp-reactions-bar">
            <button class="mp-react-btn" data-emoji="😂">😂</button>
            <button class="mp-react-btn" data-emoji="😮">😮</button>
            <button class="mp-react-btn" data-emoji="❤️">❤️</button>
            <button class="mp-react-btn" data-emoji="👍">👍</button>
            <button class="mp-react-btn" data-emoji="🔥">🔥</button>
            <button class="mp-react-btn" data-emoji="😭">😭</button>
          </div>

          <div class="mp-chat-input-row">
            <input id="mp-chat-input" class="mp-input" type="text"
                   placeholder="Say something…" maxlength="300" />
            <button id="mp-send-btn" class="mp-icon-btn mp-send-icon" title="Send">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            </button>
          </div>
        </div>

        <button id="mp-leave-btn" class="mp-btn mp-btn-danger">Leave Party</button>
      </div>
    `;
  }

  function wireSidebarEvents() {
    qs('#mp-close').addEventListener('click', toggleSidebar);
    qs('#mp-create-btn').addEventListener('click', createParty);
    qs('#mp-join-btn').addEventListener('click', joinParty);
    qs('#mp-leave-btn').addEventListener('click', leaveParty);

    const chatInput = qs('#mp-chat-input');
    chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Don't trigger site keyboard shortcuts
      if (e.key === 'Enter' && !e.shiftKey) sendChatMsg();
    });
    qs('#mp-send-btn').addEventListener('click', sendChatMsg);

    qs('#mp-room-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') joinParty();
    });

    qs('#mp-username').addEventListener('keydown', (e) => e.stopPropagation());

    qs('#mp-copy-room').addEventListener('click', () => {
      if (!currentRoomId) return;
      navigator.clipboard.writeText(currentRoomId).catch(() => {});
      showNotification('Room ID copied to clipboard!');
    });

    sidebarEl.querySelectorAll('.mp-react-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const emoji = btn.dataset.emoji;
        showFloatingReaction(emoji, myUsername); // show own reaction immediately
        sendWS({ type: 'reaction', emoji });
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI — STATE TRANSITIONS
  // ═══════════════════════════════════════════════════════════════

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    sidebarEl.classList.toggle('mp-sidebar-open', sidebarOpen);
  }

  function updatePartyUI() {
    qs('#mp-join-section').style.display = 'none';
    qs('#mp-party-section').style.display = 'flex';
    qs('#mp-room-display').textContent = currentRoomId;
    renderMemberList();
    updateBadge();
    // Auto-open sidebar
    if (!sidebarOpen) toggleSidebar();
  }

  function leavePartyUI() {
    qs('#mp-join-section').style.display = 'flex';
    qs('#mp-party-section').style.display = 'none';
    qs('#mp-messages').innerHTML = '';
    updateBadge();
  }

  function renderMemberList() {
    const container = qs('#mp-members');
    if (!container) return;
    container.innerHTML = partyMembers.map((m) => `
      <div class="mp-member ${m.userId === myUserId ? 'mp-member-me' : ''}">
        <span class="mp-avatar">${escHtml(m.username.charAt(0).toUpperCase())}</span>
        <span class="mp-member-name">${escHtml(m.username)}</span>
        ${m.isHost ? '<span class="mp-crown" title="Host">👑</span>' : ''}
        ${m.userId === myUserId ? '<span class="mp-you-tag">you</span>' : ''}
      </div>
    `).join('');
  }

  function updateBadge() {
    const badge = qs('#mp-badge');
    if (!badge) return;
    const count = partyMembers.length;
    badge.textContent = count > 0 ? count : '';
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI — CHAT
  // ═══════════════════════════════════════════════════════════════

  function sendChatMsg() {
    const input = qs('#mp-chat-input');
    const text = input.value.trim();
    if (!text || !isInParty) return;
    input.value = '';

    // Optimistic: show own message immediately
    addChatMessage(myUsername, text, true, Date.now());
    sendWS({ type: 'chat_message', message: text });
  }

  function addChatMessage(username, text, isOwn, timestamp) {
    const msgs = qs('#mp-messages');
    if (!msgs) return;

    const time = timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    const div = document.createElement('div');
    div.className = `mp-msg ${isOwn ? 'mp-msg-own' : ''}`;
    div.innerHTML = `
      <div class="mp-msg-meta">
        <span class="mp-msg-user">${escHtml(username)}</span>
        <span class="mp-msg-time">${time}</span>
      </div>
      <div class="mp-msg-bubble">${escHtml(text)}</div>
    `;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addSystemMessage(text) {
    const msgs = qs('#mp-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'mp-system-msg';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI — REACTIONS & NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════

  function showFloatingReaction(emoji, username) {
    const div = document.createElement('div');
    div.className = 'mp-float-reaction';
    div.textContent = emoji;
    div.style.cssText = `left:${10 + Math.random() * 75}vw`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3200);

    addSystemMessage(`${escHtml(username)} reacted ${emoji}`);
  }

  function showSyncIndicator(action, username) {
    const icons = { play: '▶️', pause: '⏸️', seek: '⏩' };
    showNotification(`${icons[action] || '⚡'} ${escHtml(username)} ${action}d`, 'sync');
  }

  let notifTimer = null;
  function showNotification(text, type = 'info') {
    let notif = qs('#mp-notif');
    if (!notif) {
      notif = document.createElement('div');
      notif.id = 'mp-notif';
      document.body.appendChild(notif);
    }
    notif.className = `mp-notif mp-notif-${type}`;
    notif.textContent = text;
    notif.style.opacity = '1';

    clearTimeout(notifTimer);
    notifTimer = setTimeout(() => { notif.style.opacity = '0'; }, 2800);
  }

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════

  function qs(sel, root) { return (root || sidebarEl || document).querySelector(sel); }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
  }

  function getUsernameInput() {
    const val = qs('#mp-username')?.value.trim();
    return val || `Guest${Math.floor(Math.random() * 9000) + 1000}`;
  }

  function saveUsername(name) {
    try { chrome.storage.local.set({ mp_username: name }); } catch (_) {}
  }

  function loadSavedUsername() {
    try {
      chrome.storage.local.get(['mp_username'], (r) => {
        if (r.mp_username) {
          const el = qs('#mp-username');
          if (el) el.value = r.mp_username;
        }
      });
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════
  //  POPUP ↔ CONTENT BRIDGE
  // ═══════════════════════════════════════════════════════════════

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'get_status') {
        sendResponse({
          isInParty,
          roomId: currentRoomId,
          memberCount: partyMembers.length,
          username: myUsername,
        });
        return true;
      }
      if (msg.type === 'toggle_sidebar') {
        toggleSidebar();
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (_) {}

  // ═══════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════

  injectSidebar();
  startVideoDetection();
})();
