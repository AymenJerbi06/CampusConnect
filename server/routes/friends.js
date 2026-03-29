const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { query, queryOne, run, withTransaction } = require('../db');
const { getIO }        = require('../socket');
const { sendExpoPush } = require('../utils/push');
const { isCrossCampus } = require('../utils/plans');

function pair(a, b) { return a < b ? [a, b] : [b, a]; }

// GET /api/friends — my friends list
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const friends = await query(`
      SELECT u.id, u.name, u.major, u.year, u.photo_url, u.is_online, u.last_seen
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
      WHERE f.user1_id=$1 OR f.user2_id=$1
      ORDER BY u.is_online DESC NULLS LAST, u.name
    `, [userId]);
    return res.json(friends);
  } catch (err) {
    console.error('GET /friends:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load friends.' });
  }
});

// GET /api/friends/requests — incoming pending requests
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const requests = await query(`
      SELECT fr.id, fr.sender_id, fr.created_at,
             u.name, u.major, u.year, u.photo_url
      FROM friend_requests fr
      JOIN users u ON u.id = fr.sender_id
      WHERE fr.receiver_id=$1 AND fr.status='pending'
      ORDER BY fr.created_at DESC
    `, [req.user.id]);
    return res.json(requests);
  } catch (err) {
    console.error('GET /friends/requests:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load requests.' });
  }
});

// GET /api/friends/status/:userId — relationship status with a specific user
router.get('/status/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = parseInt(req.params.userId);
    if (me === other) return res.json({ status: 'self' });

    const [u1, u2] = pair(me, other);
    if (await queryOne('SELECT 1 FROM friendships WHERE user1_id=$1 AND user2_id=$2', [u1, u2]))
      return res.json({ status: 'friends' });
    if (await queryOne("SELECT 1 FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'", [me, other]))
      return res.json({ status: 'sent' });
    if (await queryOne("SELECT 1 FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'", [other, me]))
      return res.json({ status: 'received' });

    return res.json({ status: 'none' });
  } catch (err) {
    console.error('GET /friends/status:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to get status.' });
  }
});

// POST /api/friends/request/:userId — send a friend request
router.post('/request/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = parseInt(req.params.userId);
    if (me === other) return res.status(400).json({ success: false, message: 'Cannot add yourself.' });

    // Cross-university friend requests require the cross_campus plan
    const otherUser = await queryOne('SELECT university_id FROM users WHERE id=$1', [other]);
    if (otherUser && otherUser.university_id !== req.user.university_id && !isCrossCampus(req.user.plan)) {
      return res.status(403).json({
        success: false,
        message: 'Cross-Campus Premium required to add friends from other universities.',
      });
    }

    await run(
      "INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1,$2,'pending') ON CONFLICT (sender_id, receiver_id) DO UPDATE SET status='pending'",
      [me, other]
    );

    // Real-time: update recipient's Friends / Requests screen instantly
    getIO()?.to(`user:${other}`).emit('friend:request', {
      sender_id: me,
      name:      req.user.name,
      major:     req.user.major  || null,
      year:      req.user.year   || null,
      photo_url: req.user.photo_url || null,
    });

    // Push notification to recipient (best-effort, non-blocking)
    queryOne('SELECT push_token FROM users WHERE id=$1', [other])
      .then(recipient => {
        if (recipient?.push_token) {
          sendExpoPush(
            recipient.push_token,
            req.user.name || 'Someone',
            'sent you a friend request',
            { type: 'friend_request', senderId: me }
          );
        }
      })
      .catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    console.error('POST /friends/request:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send request.' });
  }
});

// POST /api/friends/accept/:userId — accept incoming request
router.post('/accept/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = parseInt(req.params.userId);

    const pending = await queryOne(
      "SELECT id FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'",
      [other, me]
    );
    if (!pending) return res.status(400).json({ success: false, message: 'No pending request found.' });

    await run("UPDATE friend_requests SET status='accepted' WHERE id=$1", [pending.id]);
    const [u1, u2] = pair(me, other);
    await run('INSERT INTO friendships (user1_id, user2_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u1, u2]);

    // Real-time: notify both users that they're now friends
    const io = getIO();
    if (io) {
      io.to(`user:${me}`).emit('friend:accepted',    { otherId: other });
      io.to(`user:${other}`).emit('friend:accepted', { otherId: me });
    }

    return res.json({ success: true, status: 'friends' });
  } catch (err) {
    console.error('POST /friends/accept:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to accept request.' });
  }
});

// POST /api/friends/decline/:userId — decline incoming request
router.post('/decline/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = parseInt(req.params.userId);
    await run("UPDATE friend_requests SET status='declined' WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'", [other, me]);
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /friends/decline:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to decline request.' });
  }
});

// DELETE /api/friends/request/:userId — cancel a sent request
router.delete('/request/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = parseInt(req.params.userId);
    await run("DELETE FROM friend_requests WHERE sender_id=$1 AND receiver_id=$2 AND status='pending'", [me, other]);
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /friends/request:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to cancel request.' });
  }
});

// DELETE /api/friends/:userId — remove a friend (transactional: deletes friendship,
// friend requests, and the shared conversation + messages in one atomic operation)
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const me    = req.user.id;
    const other = parseInt(req.params.userId);
    const [u1, u2] = pair(me, other);

    await withTransaction(async (client) => {
      // Hard-delete the conversation (messages cascade via FK ON DELETE CASCADE)
      await client.query(
        'DELETE FROM conversations WHERE user1_id=$1 AND user2_id=$2',
        [u1, u2]
      );
      // Remove the friendship
      await client.query(
        'DELETE FROM friendships WHERE user1_id=$1 AND user2_id=$2',
        [u1, u2]
      );
      // Clean up any lingering friend requests between the two users
      await client.query(
        'DELETE FROM friend_requests WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)',
        [me, other]
      );
    });

    // Notify both users in real time so open chat/inbox pages update immediately
    const io = getIO();
    if (io) {
      io.to(`user:${me}`).emit('friend:removed',    { otherId: other });
      io.to(`user:${other}`).emit('friend:removed', { otherId: me });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /friends:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to remove friend.' });
  }
});

module.exports = router;
