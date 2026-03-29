const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { query, queryOne } = require('../db');
const { isCrossCampus } = require('../utils/plans');

// GET /api/communities
router.get('/', requireAuth, async (req, res) => {
  const { region, uniId } = req.query;
  const crossCampus = isCrossCampus(req.user.plan);
  // Always default to the user's home university.
  // Cross-campus users can switch campus by passing ?uniId=X.
  let uniFilter = req.user.university_id;
  if (crossCampus && uniId) uniFilter = parseInt(uniId, 10);

  let sql    = 'SELECT c.*, COUNT(uc.user_id) AS member_count FROM communities c LEFT JOIN user_communities uc ON uc.community_id=c.id';
  const params = [uniFilter];
  const wheres = ['($1::int IS NULL OR c.university_id = $1)'];

  if (region && region !== 'All') { wheres.push(`c.region=$${params.length + 1}`); params.push(region); }
  sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' GROUP BY c.id ORDER BY c.region, c.name';
  return res.json(await query(sql, params));
});

// GET /api/communities/:id
router.get('/:id', requireAuth, async (req, res) => {
  const crossCampus = isCrossCampus(req.user.plan);
  const uniFilter   = crossCampus ? null : req.user.university_id;

  const community = await queryOne(
    `SELECT c.*, COUNT(uc.user_id) AS member_count
     FROM communities c LEFT JOIN user_communities uc ON uc.community_id=c.id
     WHERE c.id=$1 AND ($2::int IS NULL OR c.university_id = $2)
     GROUP BY c.id`,
    [req.params.id, uniFilter]
  );
  if (!community) return res.status(404).json({ success: false, message: 'Community not found.' });

  // Members with optional major filter
  const { major } = req.query;
  let memberSql = `
    SELECT u.id, u.name, u.major, u.year, u.gender, u.photo_url, u.is_online, u.last_seen
    FROM users u JOIN user_communities uc ON uc.user_id=u.id
    WHERE uc.community_id=$1 AND u.profile_complete=TRUE AND u.hide_community=FALSE
  `;
  const params = [req.params.id];
  if (major) { memberSql += ' AND u.major=$2'; params.push(major); }
  memberSql += ' ORDER BY u.is_online DESC NULLS LAST, u.name';

  let members = await query(memberSql, params);

  // Presence visibility: free users see only friends' presence
  const { isPremium } = require('../utils/plans');
  const premium = isPremium(req.user.plan);
  if (!premium && members.length) {
    const friendRows = await query(
      'SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END AS fid FROM friendships WHERE user1_id=$1 OR user2_id=$1',
      [req.user.id]
    );
    const friendSet = new Set(friendRows.map(f => f.fid));
    members = members.map(u => {
      if (!friendSet.has(u.id)) {
        const { is_online: _o, last_seen: _l, ...rest } = u;
        return rest;
      }
      return u;
    });
  }

  return res.json({ ...community, members });
});

// POST /api/communities/:id/join
router.post('/:id/join', requireAuth, async (req, res) => {
  const communityId = parseInt(req.params.id);
  const community = await queryOne('SELECT id FROM communities WHERE id=$1', [communityId]);
  if (!community) return res.status(404).json({ success: false, message: 'Community not found.' });

  await query(
    'INSERT INTO user_communities (user_id, community_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [req.user.id, communityId]
  );
  return res.json({ success: true });
});

// POST /api/communities/:id/leave
router.post('/:id/leave', requireAuth, async (req, res) => {
  await query(
    'DELETE FROM user_communities WHERE user_id=$1 AND community_id=$2',
    [req.user.id, parseInt(req.params.id)]
  );
  return res.json({ success: true });
});

module.exports = router;
