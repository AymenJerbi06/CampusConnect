const express     = require('express');
const router      = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { query, queryOne, run } = require('../db');
const { isPremium, isCrossCampus } = require('../utils/plans');

// GET /api/courses
router.get('/', requireAuth, async (req, res) => {
  const { term, uniId } = req.query;
  // Default to the user's own university; cross_campus users may pass any uniId.
  // If no uniId given and user is cross_campus, return all universities' courses.
  const crossCampus      = isCrossCampus(req.user.plan);
  const effectiveUniId   = uniId || (crossCampus ? null : req.user.university_id);

  let sql = `
    SELECT c.*, COUNT(e.user_id) AS student_count
    FROM courses c LEFT JOIN enrollments e ON e.course_id=c.id
  `;
  const params = [];
  const wheres = [];
  if (term)             { wheres.push(`c.term=$${params.length+1}`);          params.push(term); }
  if (effectiveUniId)   { wheres.push(`c.university_id=$${params.length+1}`); params.push(effectiveUniId); }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' GROUP BY c.id ORDER BY c.code';
  return res.json(await query(sql, params));
});

// GET /api/courses/terms — distinct terms
router.get('/terms', requireAuth, async (req, res) => {
  const terms = await query('SELECT DISTINCT term FROM courses ORDER BY term DESC');
  return res.json(terms.map(r => r.term));
});

// GET /api/courses/:id
router.get('/:id', requireAuth, async (req, res) => {
  const course = await queryOne(
    'SELECT c.*, COUNT(e.user_id) AS student_count FROM courses c LEFT JOIN enrollments e ON e.course_id=c.id WHERE c.id=$1 GROUP BY c.id',
    [req.params.id]
  );
  if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });

  // Free users must be enrolled to see classmates
  const premium = isPremium(req.user.plan);
  if (!premium) {
    const enrolled = await queryOne(
      'SELECT 1 FROM enrollments WHERE user_id=$1 AND course_id=$2',
      [req.user.id, req.params.id]
    );
    if (!enrolled) return res.json({ ...course, students: [], restricted: true });
  }

  let students = await query(
    'SELECT u.id, u.name, u.major, u.year, u.gender, u.photo_url, u.is_online, u.last_seen FROM users u JOIN enrollments e ON e.user_id=u.id WHERE e.course_id=$1 AND u.profile_complete=TRUE ORDER BY u.is_online DESC NULLS LAST, u.name',
    [req.params.id]
  );

  // Presence visibility: free users see only friends' presence
  if (!premium && students.length) {
    const friendRows = await query(
      'SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END AS fid FROM friendships WHERE user1_id=$1 OR user2_id=$1',
      [req.user.id]
    );
    const friendSet = new Set(friendRows.map(f => f.fid));
    students = students.map(u => {
      if (!friendSet.has(u.id)) {
        const { is_online: _o, last_seen: _l, ...rest } = u;
        return rest;
      }
      return u;
    });
  }

  return res.json({ ...course, students });
});

// POST /api/courses/:id/enroll
router.post('/:id/enroll', requireAuth, async (req, res) => {
  await run('INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
  return res.json({ success: true });
});

// DELETE /api/courses/:id/enroll
router.delete('/:id/enroll', requireAuth, async (req, res) => {
  await run('DELETE FROM enrollments WHERE user_id=$1 AND course_id=$2', [req.user.id, req.params.id]);
  return res.json({ success: true });
});

module.exports = router;
