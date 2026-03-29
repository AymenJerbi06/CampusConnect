const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { query, queryOne, run } = require('../db');
const { getIO, pair }          = require('../socket');
const { sendExpoPush }         = require('../utils/push');
const { isPremium, isCrossCampus } = require('../utils/plans');

async function areFriends(a, b) {
  const [u1, u2] = pair(a, b);
  return await queryOne('SELECT 1 FROM friendships WHERE user1_id=$1 AND user2_id=$2', [u1, u2]);
}

async function getOrCreateConv(a, b) {
  const [u1, u2] = pair(a, b);
  let conv = await queryOne('SELECT id FROM conversations WHERE user1_id=$1 AND user2_id=$2', [u1, u2]);
  if (!conv) {
    const r = await run('INSERT INTO conversations (user1_id, user2_id) VALUES ($1,$2) RETURNING id', [u1, u2]);
    conv = r.rows[0];
  }
  return conv.id;
}

// GET /api/messages — all conversations with last message preview
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const convs = await query(`
      SELECT
        c.id,
        CASE WHEN c.user1_id=$1 THEN c.user2_id ELSE c.user1_id END AS other_id,
        u.name, u.photo_url, u.major, u.is_online,
        m.content   AS last_message,
        m.created_at AS last_at,
        m.sender_id  AS last_sender_id,
        (SELECT COUNT(*) FROM messages
         WHERE conversation_id=c.id AND read=FALSE AND sender_id!=$1)::int AS unread_count
      FROM conversations c
      JOIN users u ON u.id = CASE WHEN c.user1_id=$1 THEN c.user2_id ELSE c.user1_id END
      -- No friendship JOIN: unfriending atomically deletes conversations, and premium users
      -- may have conversations with non-friends; showing all existing conversations is correct.
      LEFT JOIN LATERAL (
        SELECT content, created_at, sender_id FROM messages
        WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1
      ) m ON TRUE
      WHERE c.user1_id=$1 OR c.user2_id=$1
      ORDER BY COALESCE(m.created_at, c.created_at) DESC
    `, [userId]);
    return res.json(convs);
  } catch (err) {
    console.error('GET /messages:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load conversations.' });
  }
});

// GET /api/messages/:userId — messages in a conversation
router.get('/:userId', requireAuth, async (req, res) => {
  try {
    const me          = req.user.id;
    const other       = parseInt(req.params.userId);
    const premium     = isPremium(req.user.plan);
    const crossCampus = isCrossCampus(req.user.plan);
    const friends     = await areFriends(me, other);

    // Check cross-university access before anything else
    const otherUser = await queryOne('SELECT university_id FROM users WHERE id=$1', [other]);
    if (otherUser && otherUser.university_id !== req.user.university_id && !crossCampus) {
      // Allow if a conversation already exists (e.g. was started when user had cross_campus,
      // or the other party initiated it)
      const [u1, u2] = pair(me, other);
      const existing = await queryOne('SELECT id FROM conversations WHERE user1_id=$1 AND user2_id=$2', [u1, u2]);
      if (!existing) return res.status(403).json({ success: false, message: 'Cross-Campus Premium required to message students from other universities.' });
    }

    if (!friends && !premium) {
      // Non-premium, non-friends: allow only if a conversation already exists
      // (covers the recipient side of a premium-initiated DM)
      const [u1, u2] = pair(me, other);
      const existing = await queryOne(
        'SELECT id FROM conversations WHERE user1_id=$1 AND user2_id=$2', [u1, u2]
      );
      if (!existing) return res.status(403).json({ success: false, message: 'You must be friends to message.' });
    }

    const convId = await getOrCreateConv(me, other);

    // Mark incoming messages as read BEFORE fetching so unread counts drop immediately
    await run(
      'UPDATE messages SET read=TRUE WHERE conversation_id=$1 AND sender_id!=$2 AND read=FALSE',
      [convId, me]
    );

    const msgs = await query(
      'SELECT id, sender_id, content, read, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC',
      [convId]
    );

    // Notify the sender(s) that their messages were read
    const [u1, u2] = pair(me, other);
    getIO()?.to(`conv:${u1}:${u2}`).emit('message:read', { readBy: me });

    return res.json(msgs);
  } catch (err) {
    console.error('GET /messages/:userId:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load messages.' });
  }
});

// POST /api/messages/:userId — send a message
router.post('/:userId', requireAuth, async (req, res) => {
  try {
    const me          = req.user.id;
    const other       = parseInt(req.params.userId);
    const content     = (req.body.content || '').trim();
    const premium     = isPremium(req.user.plan);
    const crossCampus = isCrossCampus(req.user.plan);
    if (!content) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });

    // Cross-university messaging: require cross_campus plan (unless already in a conversation)
    const otherUser = await queryOne('SELECT university_id FROM users WHERE id=$1', [other]);
    if (otherUser && otherUser.university_id !== req.user.university_id && !crossCampus) {
      const [u1c, u2c] = pair(me, other);
      const existing = await queryOne('SELECT id FROM conversations WHERE user1_id=$1 AND user2_id=$2', [u1c, u2c]);
      if (!existing) return res.status(403).json({ success: false, message: 'Cross-Campus Premium required to message students from other universities.' });
    }

    if (!await areFriends(me, other) && !premium)
      return res.status(403).json({ success: false, message: 'You must be friends to message.' });

    const convId = await getOrCreateConv(me, other);
    const result = await run(
      'INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1,$2,$3) RETURNING *',
      [convId, me, content]
    );
    const msg = result.rows[0];

    const io = getIO();
    if (io) {
      const [u1, u2] = pair(me, other);
      // Real-time delivery to both participants if they have the chat open
      io.to(`conv:${u1}:${u2}`).emit('message:sent', msg);
      // Notification to recipient's personal room (updates message list badge on other pages)
      io.to(`user:${other}`).emit('message:notify', { conversationId: convId, senderId: me });
    }

    // Push notification to mobile recipient (best-effort, non-blocking)
    // Fetch recipient's push token and sender's name in parallel
    queryOne('SELECT push_token FROM users WHERE id=$1', [other])
      .then(recipient => {
        if (recipient?.push_token) {
          const preview = content.length > 100 ? content.slice(0, 97) + '…' : content;
          sendExpoPush(
            recipient.push_token,
            req.user.name || 'New message',
            preview,
            { type: 'message', senderId: me }
          );
        }
      })
      .catch(() => {});

    return res.json({ success: true, message: msg });
  } catch (err) {
    console.error('POST /messages/:userId:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
});

module.exports = router;
