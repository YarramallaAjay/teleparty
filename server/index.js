/**
 * MovieParty WebSocket Server
 *
 * Deploy to any Node.js host (Railway, Render, Fly.io, etc.)
 * Set the PORT env var for production, defaults to 8080 locally.
 *
 * After deploying, update SERVER_URL in extension/content.js to point to your server.
 */

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// rooms: Map<roomId, Map<userId, MemberRecord>>
// MemberRecord: { ws, userId, username, isHost }
const rooms = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function getRoomMembers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.values()).map(({ userId, username, isHost }) => ({
    userId,
    username,
    isHost,
  }));
}

function broadcast(roomId, message, excludeUserId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  room.forEach((member) => {
    if (member.userId !== excludeUserId && member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(data);
    }
  });
}

function broadcastAll(roomId, message) {
  broadcast(roomId, message, null);
}

// ─── Connection Handler ───────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  // Per-connection state
  const userId = `u_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  let roomId = null;
  let username = 'Guest';
  let isHost = false;

  function send(message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendError(msg) {
    send({ type: 'error', message: msg });
  }

  // ─── Message Router ─────────────────────────────────────────────────────────

  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // ── Create a new room ──────────────────────────────────────────────────
      case 'create_room': {
        if (roomId) {
          sendError('Already in a room. Leave first.');
          return;
        }

        roomId = generateRoomId();
        username = String(msg.username || 'Host').trim().substring(0, 24) || 'Host';
        isHost = true;

        const room = new Map();
        room.set(userId, { ws, userId, username, isHost: true });
        rooms.set(roomId, room);

        send({
          type: 'room_created',
          roomId,
          userId,
          members: getRoomMembers(roomId),
        });

        console.log(`[${new Date().toISOString()}] Room ${roomId} created by "${username}"`);
        break;
      }

      // ── Join an existing room ──────────────────────────────────────────────
      case 'join_room': {
        if (roomId) {
          sendError('Already in a room. Leave first.');
          return;
        }

        const targetId = String(msg.roomId || '').trim().toUpperCase();
        if (!targetId) {
          sendError('Room ID is required.');
          return;
        }
        if (!rooms.has(targetId)) {
          sendError('Room not found. Check the ID and try again.');
          return;
        }

        roomId = targetId;
        username = String(msg.username || 'Guest').trim().substring(0, 24) || 'Guest';
        isHost = false;

        rooms.get(roomId).set(userId, { ws, userId, username, isHost: false });

        const members = getRoomMembers(roomId);

        send({
          type: 'room_joined',
          roomId,
          userId,
          members,
        });

        // Tell everyone else someone joined
        broadcast(
          roomId,
          { type: 'member_joined', userId, username, members },
          userId
        );

        console.log(`[${new Date().toISOString()}] "${username}" joined room ${roomId}`);
        break;
      }

      // ── Video playback sync event ─────────────────────────────────────────
      case 'video_sync': {
        if (!roomId) return;

        broadcast(roomId, {
          type: 'video_sync',
          action: msg.action,              // 'play' | 'pause' | 'seek'
          currentTime: Number(msg.currentTime) || 0,
          serverTimestamp: Date.now(),
          userId,
          username,
        }, userId);
        break;
      }

      // ── Chat message ──────────────────────────────────────────────────────
      case 'chat_message': {
        if (!roomId) return;
        const text = String(msg.message || '').trim().substring(0, 500);
        if (!text) return;

        // Exclude sender — they already show the message optimistically
        broadcast(roomId, {
          type: 'chat_message',
          message: text,
          userId,
          username,
          timestamp: Date.now(),
        }, userId);
        break;
      }

      // ── Emoji reaction ────────────────────────────────────────────────────
      case 'reaction': {
        if (!roomId) return;
        const emoji = String(msg.emoji || '').trim().substring(0, 8);
        if (!emoji) return;

        broadcast(roomId, {
          type: 'reaction',
          emoji,
          userId,
          username,
        }, userId);
        break;
      }

      // ── Ping / keep-alive ─────────────────────────────────────────────────
      case 'ping':
        send({ type: 'pong' });
        break;

      default:
        // Unknown message type — ignore
        break;
    }
  });

  // ─── Disconnect Handler ──────────────────────────────────────────────────

  ws.on('close', () => {
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.delete(userId);

    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`[${new Date().toISOString()}] Room ${roomId} closed (everyone left)`);
      return;
    }

    // If host left, promote the next member
    let newHostId = null;
    if (isHost) {
      const next = room.values().next().value;
      if (next) {
        next.isHost = true;
        newHostId = next.userId;
      }
    }

    const members = getRoomMembers(roomId);
    broadcastAll(roomId, {
      type: 'member_left',
      userId,
      username,
      newHostId,
      members,
    });

    console.log(`[${new Date().toISOString()}] "${username}" left room ${roomId} (${room.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error(`[WS Error] ${username || userId}: ${err.message}`);
  });
});

console.log(`\n🎬  MovieParty server  →  ws://localhost:${PORT}`);
console.log(`    Update SERVER_URL in extension/content.js for production use.\n`);
