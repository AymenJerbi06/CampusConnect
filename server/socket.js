const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const { queryOne, run, query } = require('./db');

let io = null;

/**
 * How long to wait after a user's last socket closes before marking them
 * offline. Normal page navigation disconnects + reconnects in < 1 s, so
 * 8 s comfortably covers that without leaving stale online rows for users
 * who genuinely closed their browser.
 */
const OFFLINE_GRACE_MS = 8000;

/**
 * Per-user pending offline timers.
 * Key: userId (number) → Value: setTimeout handle.
 */
const offlineTimers = new Map();

function pair(a, b) { return a < b ? [a, b] : [b, a]; }

/**
 * Broadcast a presence change to every socket that is allowed to see it.
 *
 * Payload: { userId, online, last_seen }
 *  online    – true = green dot; false = gray dot / "Last active …"
 *  last_seen – ISO string when going offline, null when coming online
 */
async function _broadcastPresence(userId, online, last_seen) {
  if (!io) return;
  const payload = { userId, online, last_seen };

  // Premium users always see every user's presence
  io.to('premium-presence').emit('presence:change', payload);

  // Non-premium users see only their confirmed friends' presence
  try {
    const friends = await query(
      `SELECT CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END AS fid, u.plan
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
       WHERE f.user1_id=$1 OR f.user2_id=$1`,
      [userId]
    );
    for (const f of friends) {
      if (f.plan !== 'premium') {
        io.to(`user:${f.fid}`).emit('presence:change', payload);
      }
    }
  } catch (e) {}
}

function init(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', credentials: true },
  });

  // ── Auth middleware ─────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      // Accept token from cookie (web) or socket auth (mobile)
      let rawToken = socket.handshake.auth?.token;
      if (!rawToken) {
        const cookie = socket.handshake.headers.cookie || '';
        const match  = cookie.match(/(?:^|;\s*)cc_token=([^;]+)/);
        if (match) rawToken = match[1];
      }
      if (!rawToken) return next(new Error('Not authenticated'));
      const payload = jwt.verify(rawToken, process.env.JWT_SECRET || 'dev-secret');
      const user    = await queryOne('SELECT id, plan FROM users WHERE id=$1', [payload.userId]);
      if (!user) return next(new Error('User not found'));
      socket.userId   = user.id;
      socket.userPlan = user.plan;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection ──────────────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const userId = socket.userId;

    // Cancel any pending offline timer — the user navigated to a new page
    // and their socket reconnected before the grace period expired.
    if (offlineTimers.has(userId)) {
      clearTimeout(offlineTimers.get(userId));
      offlineTimers.delete(userId);
    }

    socket.join(`user:${userId}`);
    if (socket.userPlan === 'premium') socket.join('premium-presence');

    // Mark the TCP connection as alive but do NOT broadcast yet.
    // presence.js will emit presence:active immediately if the tab is visible,
    // which triggers the broadcast. This prevents a gray→green flicker on
    // every page navigation.
    try {
      await run('UPDATE users SET is_online=TRUE WHERE id=$1', [userId]);
    } catch (e) {}

    // ── Tab visible: user is actively on the app ──────────────────────────
    socket.on('presence:active', async () => {
      try {
        await run(
          'UPDATE users SET is_online=TRUE, is_active=TRUE, last_seen=NOW() WHERE id=$1',
          [userId]
        );
        await _broadcastPresence(userId, true, null);
      } catch (e) {}
    });

    // ── Tab hidden: app is backgrounded ───────────────────────────────────
    socket.on('presence:inactive', async () => {
      try {
        const now = new Date().toISOString();
        await run(
          'UPDATE users SET is_online=FALSE, is_active=FALSE, last_seen=$2 WHERE id=$1',
          [userId, now]
        );
        await _broadcastPresence(userId, false, now);
      } catch (e) {}
    });

    // ── Heartbeat: keep last_seen fresh while tab is visible ─────────────
    socket.on('presence:heartbeat', async () => {
      try {
        await run(
          'UPDATE users SET is_online=TRUE, is_active=TRUE, last_seen=NOW() WHERE id=$1',
          [userId]
        );
        // No broadcast — heartbeat is a keep-alive only, not a state change
      } catch (e) {}
    });

    // ── Logout: immediate clean offline ──────────────────────────────────
    socket.on('presence:logout', async () => {
      if (offlineTimers.has(userId)) {
        clearTimeout(offlineTimers.get(userId));
        offlineTimers.delete(userId);
      }
      try {
        const now = new Date().toISOString();
        await run(
          'UPDATE users SET is_online=FALSE, is_active=FALSE, last_seen=$2 WHERE id=$1',
          [userId, now]
        );
        await _broadcastPresence(userId, false, now);
      } catch (e) {}
    });

    // ── Disconnect: start grace period ────────────────────────────────────
    socket.on('disconnect', async () => {
      try {
        const remaining = await io.in(`user:${userId}`).allSockets();
        if (remaining.size > 0) return; // other tabs still open

        const timer = setTimeout(async () => {
          offlineTimers.delete(userId);
          try {
            const now = new Date().toISOString();
            await run(
              'UPDATE users SET is_online=FALSE, is_active=FALSE, last_seen=$2 WHERE id=$1',
              [userId, now]
            );
            await _broadcastPresence(userId, false, now);
          } catch (e) {}
        }, OFFLINE_GRACE_MS);

        offlineTimers.set(userId, timer);
      } catch (e) {}
    });

    // ── Conversation rooms ────────────────────────────────────────────────

    socket.on('join:conv', async (otherId) => {
      try {
        const [u1, u2] = pair(userId, parseInt(otherId));
        const isFriend = await queryOne(
          'SELECT 1 FROM friendships WHERE user1_id=$1 AND user2_id=$2', [u1, u2]
        );
        const hasConv = !isFriend && await queryOne(
          'SELECT 1 FROM conversations WHERE user1_id=$1 AND user2_id=$2', [u1, u2]
        );
        if (!isFriend && !hasConv && socket.userPlan !== 'premium') return;
        socket.join(`conv:${u1}:${u2}`);
      } catch (e) {}
    });

    socket.on('leave:conv', (otherId) => {
      const [u1, u2] = pair(userId, parseInt(otherId));
      socket.leave(`conv:${u1}:${u2}`);
    });

    socket.on('typing:start', (otherId) => {
      const [u1, u2] = pair(userId, parseInt(otherId));
      socket.to(`conv:${u1}:${u2}`).emit('typing:start');
    });

    socket.on('typing:stop', (otherId) => {
      const [u1, u2] = pair(userId, parseInt(otherId));
      socket.to(`conv:${u1}:${u2}`).emit('typing:stop');
    });
  });

  return io;
}

function getIO() { return io; }

module.exports = { init, getIO, pair, broadcastPresence: _broadcastPresence };
