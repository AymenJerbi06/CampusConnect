const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { query, queryOne, run } = require('../db');
const { isPremium, isCrossCampus } = require('../utils/plans');

// GET /api/users — list students with optional filters
router.get('/', requireAuth, async (req, res) => {
  const premium     = isPremium(req.user.plan);
  const crossCampus = isCrossCampus(req.user.plan);
  let { major, year, communityId, courseId, gender, search, limit = 40, offset = 0 } = req.query;

  // ── Plan-based guards (enforced server-side regardless of UI state) ──────────
  if (!premium) {
    // Gender filter: premium only, even during search
    if (gender !== undefined) {
      return res.status(403).json({ success: false, message: 'Premium plan required.' });
    }
    // Name-based search is intentionally plan-agnostic: free users can look up
    // any student by name without being restricted to their own major/year/course.
    // Category browsing (no search term) remains gated by plan.
    if (!search) {
      if (!communityId) {
        // Only lock the ONE dimension the user is browsing by, not both.
        // If the request has a year param → user is on "By Year" tab → lock year only.
        // Otherwise → user is on "By Major" tab → lock major only.
        if (year !== undefined) {
          year  = req.user.year  || null;
        } else {
          major = req.user.major || null;
        }
      }
      // Course browse: must be enrolled
      if (courseId) {
        const enrolled = await queryOne(
          'SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2',
          [req.user.id, courseId]
        );
        if (!enrolled) return res.status(403).json({ success: false, message: 'Premium plan required.' });
      }
    }
  }

  // Always default to the user's home university.
  // Cross-campus users can switch campus by passing ?uniId=X.
  const { uniId } = req.query;
  let uniFilter = req.user.university_id;
  if (crossCampus && uniId) uniFilter = parseInt(uniId, 10);
  const params = [uniFilter];
  let i = 2;
  let sql = `
    SELECT u.id, u.name, u.major, u.year, u.gender, u.photo_url, u.hide_community, u.is_online, u.last_seen,
           uni.short_name AS university
    FROM users u
    LEFT JOIN user_communities uc ON uc.user_id = u.id
    LEFT JOIN universities uni ON uni.id = u.university_id
    WHERE u.profile_complete = TRUE
      AND ($1::int IS NULL OR u.university_id = $1)
  `;

  if (major)       { sql += ` AND u.major = $${i++}`; params.push(major); }
  if (year)        { sql += ` AND u.year  = $${i++}`; params.push(year); }
  if (communityId) { sql += ` AND uc.community_id = $${i++}`; params.push(communityId); }
  if (courseId) {
    sql += ` AND u.id IN (SELECT user_id FROM enrollments WHERE course_id = $${i++})`;
    params.push(courseId);
  }
  if (gender) {
    sql += ` AND u.gender = $${i++}`;
    params.push(gender);
  }
  if (search) {
    // Full-name starts-with match — name only, no major.
    // Weak queries (no space, either word < 2 chars) are rejected: return nothing.
    const parts = search.trim().split(/\s+/);
    const isFullName = parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2;
    if (!isFullName) {
      return res.json([]);
    }
    sql += ` AND u.name ILIKE $${i++}`;
    params.push(`${search.trim()}%`);
  }

  sql += ` GROUP BY u.id, uni.short_name ORDER BY u.name LIMIT $${i++} OFFSET $${i++}`;
  params.push(parseInt(limit), parseInt(offset));

  let users = await query(sql, params);

  // ── Presence visibility ──────────────────────────────────────────────────
  // Premium users see everyone's presence; free users see only friends'.
  if (!premium && users.length) {
    const friendRows = await query(
      'SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END AS fid FROM friendships WHERE user1_id=$1 OR user2_id=$1',
      [req.user.id]
    );
    const friendSet = new Set(friendRows.map(f => f.fid));
    users = users.map(u => {
      if (!friendSet.has(u.id)) {
        const { is_online: _o, last_seen: _l, ...rest } = u;
        return rest;
      }
      return u;
    });
  }

  return res.json(users);
});

// GET /api/users/me — own full profile
router.get('/me', requireAuth, async (req, res) => {
  const user = req.user;
  const communities = await query(
    'SELECT c.* FROM communities c JOIN user_communities uc ON uc.community_id=c.id WHERE uc.user_id=$1',
    [user.id]
  );
  const courses = await query(
    'SELECT co.* FROM courses co JOIN enrollments e ON e.course_id=co.id WHERE e.user_id=$1 ORDER BY co.term, co.code',
    [user.id]
  );
  return res.json({ ...user, communities, courses });
});

// POST /api/users/me/heartbeat — REST presence keep-alive for clients without Socket.IO
// Mobile apps send this while active (active=true) and when backgrounded (active=false).
router.post('/me/heartbeat', requireAuth, async (req, res) => {
  const active = req.body.active !== false; // default true
  try {
    if (active) {
      await run(
        'UPDATE users SET is_online=TRUE, last_seen=NOW() WHERE id=$1',
        [req.user.id]
      );
    } else {
      const now = new Date().toISOString();
      await run(
        'UPDATE users SET is_online=FALSE, last_seen=$2 WHERE id=$1',
        [req.user.id, now]
      );
      // Best-effort broadcast to Socket.IO clients (web users see mobile go offline)
      try {
        const { broadcastPresence } = require('../socket');
        broadcastPresence(req.user.id, false, now).catch(() => {});
      } catch {}
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /users/me/heartbeat:', err.message);
    return res.status(500).json({ success: false });
  }
});

// GET /api/users/:id — single student profile
router.get('/:id', requireAuth, async (req, res) => {
  const crossCampus = isCrossCampus(req.user.plan);
  // Cross-campus users can view any university's profile; others only their own.
  const user = await queryOne(
    `SELECT id, email, name, major, year, gender, bio, instagram, linkedin, photo_url,
            hide_community, is_online, last_seen, university_id
     FROM users
     WHERE id=$1 AND profile_complete=TRUE
       AND ($2::int IS NULL OR university_id = $2)`,
    [req.params.id, crossCampus ? null : req.user.university_id]
  );
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const viewerId  = req.user.id;
  const visitedId = parseInt(req.params.id);
  if (viewerId !== visitedId && !req.user.browse_privately) {
    run('INSERT INTO profile_visits (visitor_id, visited_user_id) VALUES ($1,$2)', [viewerId, visitedId])
      .catch(() => {});
  }

  const premium = isPremium(req.user.plan);
  if (!premium) {
    const [u1, u2] = [Math.min(viewerId, visitedId), Math.max(viewerId, visitedId)];
    const isFriend = await queryOne('SELECT 1 FROM friendships WHERE user1_id=$1 AND user2_id=$2', [u1, u2]);
    if (!isFriend) { user.is_online = null; user.last_seen = null; }
  }

  const communities = user.hide_community ? [] : await query(
    'SELECT c.* FROM communities c JOIN user_communities uc ON uc.community_id=c.id WHERE uc.user_id=$1',
    [user.id]
  );
  const courses = await query(
    'SELECT co.code, co.name, co.term FROM courses co JOIN enrollments e ON e.course_id=co.id WHERE e.user_id=$1 ORDER BY co.term DESC, co.code',
    [user.id]
  );
  return res.json({ ...user, communities, courses });
});

// POST /api/users/me/push-token — register or update Expo push token
router.post('/me/push-token', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'Token required.' });
  }
  try {
    await run('UPDATE users SET push_token=$1 WHERE id=$2', [token, req.user.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('POST /users/me/push-token:', err.message);
    return res.status(500).json({ success: false });
  }
});

// PATCH /api/users/me — update own profile
router.patch('/me', requireAuth, async (req, res) => {
  let { name, major, year, bio, instagram, linkedin, photo_url, communityIds, courseIds, hide_community, gender, browse_privately } = req.body;
  const userId = req.user.id;

  // ── Lock identity fields after initial onboarding ────────────────────────
  // Once profile_complete is TRUE, major / year / gender cannot be changed via
  // the normal edit-profile flow. Updates to those fields are silently ignored
  // and the existing values are preserved, preventing category-gaming abuse.
  if (req.user.profile_complete) {
    major  = req.user.major;
    year   = req.user.year;
    gender = req.user.gender;
  }

  try {
    await run(
      `UPDATE users SET name=$1, major=$2, year=$3, bio=$4, instagram=$5, linkedin=$6, photo_url=$7, hide_community=$8, gender=$9, browse_privately=$10, profile_complete=TRUE WHERE id=$11`,
      [name || null, major || null, year || null, bio || null, instagram || null, linkedin || null, photo_url || null, !!hide_community, gender || null, !!browse_privately, userId]
    );

    if (Array.isArray(communityIds)) {
      await run('DELETE FROM user_communities WHERE user_id=$1', [userId]);
      for (const cid of communityIds) {
        await run('INSERT INTO user_communities (user_id, community_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, cid]);
      }
    }

    if (Array.isArray(courseIds)) {
      await run('DELETE FROM enrollments WHERE user_id=$1', [userId]);
      for (const cid of courseIds) {
        await run('INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, cid]);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('PATCH /me error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save profile. Please try again.' });
  }
});

module.exports = router;
