const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { query }   = require('../db');

// GET /api/visits — all users can see who viewed their profile.
// Premium users can browse anonymously (browse_privately=TRUE) and won't appear
// in others' visitor lists — that's the premium distinction, not seeing your own.
router.get('/', requireAuth, async (req, res) => {
  const visitors = await query(`
    SELECT u.id, u.name, u.major, u.year, u.photo_url,
           uni.short_name      AS university,
           MAX(pv.visited_at)  AS last_visit,
           COUNT(*)::int        AS visit_count
    FROM profile_visits pv
    JOIN users u        ON u.id  = pv.visitor_id
    LEFT JOIN universities uni ON uni.id = u.university_id
    WHERE pv.visited_user_id = $1
    GROUP BY u.id, u.name, u.major, u.year, u.photo_url, uni.short_name
    ORDER BY last_visit DESC
    LIMIT 100
  `, [req.user.id]);

  return res.json(visitors);
});

module.exports = router;
