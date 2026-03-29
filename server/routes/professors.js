const express        = require('express');
const router         = express.Router();
const rateLimit      = require('express-rate-limit');
const requireAuth    = require('../middleware/requireAuth');
const { query, queryOne, run, withTransaction } = require('../db');
const { isCrossCampus } = require('../utils/plans');

// Rate-limit: max 5 review submissions per hour per user
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => String(req.user?.id || req.ip),
  handler: (req, res) => res.status(429).json({ success: false, message: 'Too many reviews submitted. Try again later.' }),
  skip: () => false,
});

function sanitise(str, maxLen = 1000) {
  if (!str) return null;
  const s = String(str).trim().replace(/\s+/g, ' ');
  return s.length > maxLen ? s.slice(0, maxLen) : s || null;
}

// Per-university faculty lists — auto-seeded if a university has no departments yet.
// The schema.sql seed runs first; this is only a safety fallback for new universities.
const FACULTIES_BY_DOMAIN = {
  'sfu.ca': [
    'Faculty of Applied Sciences',
    'Faculty of Arts and Social Sciences',
    'Beedie School of Business',
    'Faculty of Communication, Art and Technology',
    'Faculty of Education',
    'Faculty of Environment',
    'Faculty of Graduate Studies',
    'Faculty of Health Sciences',
    'Faculty of Science',
    'School of Medicine',
  ],
  'ubc.ca': [
    'Faculty of Applied Science',
    'School of Architecture and Landscape Architecture',
    'Faculty of Arts',
    'School of Audiology and Speech Sciences',
    'Sauder School of Business',
    'School of Community and Regional Planning',
    'Faculty of Dentistry',
    'Faculty of Education',
    'Extended Learning',
    'Faculty of Forestry & Environmental Stewardship',
    'Graduate and Postdoctoral Studies',
    'School of Information',
    'School of Journalism, Writing, and Media',
    'School of Kinesiology',
    'Faculty of Land and Food Systems',
    'Peter A. Allard School of Law',
    'Faculty of Medicine',
    'School of Music',
    'School of Nursing',
    'Faculty of Pharmaceutical Sciences',
    'School of Population and Public Health',
    'School of Public Policy and Global Affairs',
    'Faculty of Science',
    'School of Social Work',
    'UBC Vantage College',
    'Vancouver School of Economics',
  ],
  'mcgill.ca': [
    'Faculty of Agricultural and Environmental Sciences',
    'Faculty of Arts',
    'Faculty of Dental Medicine and Oral Health Sciences',
    'Faculty of Education',
    'Faculty of Engineering',
    'Graduate and Postdoctoral Studies',
    'Faculty of Law',
    'Desautels Faculty of Management',
    'Faculty of Medicine and Health Sciences',
    'Schulich School of Music',
    'Faculty of Science',
    'School of Continuing Studies',
  ],
  'queensu.ca': [
    'Faculty of Arts and Science',
    'Smith School of Engineering and Applied Science',
    'Smith School of Business',
    'Faculty of Health Sciences',
    'Faculty of Education',
    'Faculty of Law',
    'School of Graduate Studies and Postdoctoral Affairs',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// FACULTIES  (must be defined before /:id to avoid Express param collision)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/professors/departments — list faculties with professor + review stats
// Cross-campus users may pass ?uniId=X to view another university's faculties.
router.get('/departments', requireAuth, async (req, res) => {
  const crossCampus = isCrossCampus(req.user.plan);
  const { uniId: uniIdParam } = req.query;
  let uniId = req.user.university_id;
  if (crossCampus && uniIdParam) uniId = parseInt(uniIdParam, 10);
  if (!uniId) return res.json([]);

  // Seed correct faculty list if none exist yet for this university
  const { n } = await queryOne('SELECT COUNT(*)::int AS n FROM departments WHERE university_id=$1', [uniId]);
  if (n === 0) {
    const uni = await queryOne('SELECT email_domain FROM universities WHERE id=$1', [uniId]);
    const faculties = (uni && FACULTIES_BY_DOMAIN[uni.email_domain]) || FACULTIES_BY_DOMAIN['sfu.ca'];
    for (const name of faculties) {
      await run(
        'INSERT INTO departments (name, university_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [name, uniId]
      );
    }
  }

  const rows = await query(`
    SELECT d.id, d.name,
           COUNT(DISTINCT p.id)::int                         AS professor_count,
           COUNT(DISTINCT pr.id)::int                        AS review_count,
           ROUND(AVG(pr.rating)::numeric, 1)::float          AS avg_rating
    FROM departments d
    LEFT JOIN professors p  ON p.department_id = d.id
    LEFT JOIN professor_reviews pr ON pr.professor_id = p.id
    WHERE d.university_id = $1
    GROUP BY d.id
    ORDER BY professor_count DESC, d.name
  `, [uniId]);

  return res.json(rows);
});

// POST /api/professors/rate — atomic find-or-create-professor + insert-review
// Single endpoint so both steps either succeed together or fail together.
router.post('/rate', requireAuth, reviewLimiter, async (req, res) => {
  const uniId      = req.user.university_id;
  const userId     = req.user.id;
  const profName   = sanitise(req.body.professor_name, 120);
  const deptId     = req.body.department_id ? parseInt(req.body.department_id) : null;
  const courseCode = sanitise(req.body.course_code, 20);
  const rating     = parseInt(req.body.rating);
  const comment    = sanitise(req.body.comment, 1000);
  const grade      = sanitise(req.body.grade_received, 5);

  if (!uniId)      return res.status(400).json({ success: false, message: 'University not found.' });
  if (!profName)   return res.status(400).json({ success: false, message: 'Professor name is required.' });
  if (!deptId)     return res.status(400).json({ success: false, message: 'Faculty is required.' });
  if (!courseCode) return res.status(400).json({ success: false, message: 'Course code is required.' });
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be 1–5.' });

  try {
    const result = await withTransaction(async (client) => {
      // 1. Verify faculty belongs to this university
      const dept = await client.query(
        'SELECT id, name FROM departments WHERE id=$1 AND university_id=$2',
        [deptId, uniId]
      );
      if (!dept.rows[0]) throw Object.assign(new Error('Invalid faculty.'), { status: 400 });

      // 2. Find or create professor — dedup by university + faculty + normalized name
      //    Scoping to department_id ensures a professor in Faculty A is a distinct
      //    record from one with the same name in Faculty B, so filtered lists stay correct.
      let prof = (await client.query(
        `SELECT id, name, department_id FROM professors
         WHERE university_id=$1 AND department_id=$2 AND LOWER(name)=LOWER($3)`,
        [uniId, deptId, profName]
      )).rows[0];

      if (!prof) {
        prof = (await client.query(
          `INSERT INTO professors (name, department_id, university_id) VALUES ($1,$2,$3)
           RETURNING id, name, department_id`,
          [profName, deptId, uniId]
        )).rows[0];
      }

      // 3. Insert review (unique constraint: user+professor+course)
      const review = (await client.query(
        `INSERT INTO professor_reviews (professor_id, user_id, course_code, rating, comment, grade_received)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, course_code, rating, comment, grade_received, created_at`,
        [prof.id, userId, courseCode.toUpperCase(), rating, comment, grade]
      )).rows[0];

      return { professor: { ...prof, department_name: dept.rows[0].name }, review };
    });

    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'You already reviewed this professor for that course.' });
    }
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('POST /professors/rate:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to submit review.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROFESSORS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/professors?department_id=&search= — list professors
router.get('/', requireAuth, async (req, res) => {
  const { search, department_id } = req.query;
  const uniId = req.user.university_id;
  if (!uniId) return res.json([]);

  const params = [uniId];
  let i = 2;
  let sql = `
    SELECT p.id, p.name, p.department_id,
           d.name AS department_name,
           ROUND(AVG(r.rating)::numeric, 1)::float AS avg_rating,
           COUNT(r.id)::int AS review_count
    FROM professors p
    LEFT JOIN departments d      ON d.id = p.department_id
    LEFT JOIN professor_reviews r ON r.professor_id = p.id
    WHERE p.university_id = $1
  `;
  if (department_id) { sql += ` AND p.department_id = $${i++}`; params.push(department_id); }
  if (search)        { sql += ` AND p.name ILIKE $${i++}`;      params.push(`%${search}%`); }
  sql += ' GROUP BY p.id, d.name ORDER BY p.name LIMIT 60';

  return res.json(await query(sql, params));
});

// POST /api/professors — find or create a professor
router.post('/', requireAuth, async (req, res) => {
  const uniId = req.user.university_id;
  if (!uniId) return res.status(400).json({ success: false, message: 'University not found.' });

  const name         = sanitise(req.body.name, 120);
  const department_id = req.body.department_id ? parseInt(req.body.department_id) : null;
  if (!name) return res.status(400).json({ success: false, message: 'Professor name is required.' });

  // Verify department belongs to same university
  if (department_id) {
    const dept = await queryOne('SELECT id FROM departments WHERE id=$1 AND university_id=$2', [department_id, uniId]);
    if (!dept) return res.status(400).json({ success: false, message: 'Invalid department.' });
  }

  // Dedup by name + university (case-insensitive)
  const existing = await queryOne(
    `SELECT p.id, p.name, p.department_id, d.name AS department_name
     FROM professors p LEFT JOIN departments d ON d.id = p.department_id
     WHERE p.university_id=$1 AND LOWER(p.name)=LOWER($2)`,
    [uniId, name]
  );
  if (existing) return res.json({ ...existing, created: false });

  const prof = await queryOne(
    `INSERT INTO professors (name, department_id, university_id)
     VALUES ($1,$2,$3)
     RETURNING id, name, department_id`,
    [name, department_id, uniId]
  );
  // Fetch department name for the response
  const deptName = department_id
    ? (await queryOne('SELECT name FROM departments WHERE id=$1', [department_id]))?.name
    : null;

  return res.status(201).json({ ...prof, department_name: deptName, created: true });
});

// GET /api/professors/:id — professor detail with reviews
router.get('/:id', requireAuth, async (req, res) => {
  const prof = await queryOne(`
    SELECT p.id, p.name, p.department_id, d.name AS department_name,
           ROUND(AVG(r.rating)::numeric, 1)::float AS avg_rating,
           COUNT(r.id)::int AS review_count
    FROM professors p
    LEFT JOIN departments d       ON d.id = p.department_id
    LEFT JOIN professor_reviews r ON r.professor_id = p.id
    WHERE p.id=$1 AND p.university_id=$2
    GROUP BY p.id, d.name
  `, [req.params.id, req.user.university_id]);
  if (!prof) return res.status(404).json({ success: false, message: 'Professor not found.' });

  const breakdown = await query(
    `SELECT rating, COUNT(*)::int AS count
     FROM professor_reviews WHERE professor_id=$1 GROUP BY rating ORDER BY rating DESC`,
    [req.params.id]
  );

  const courses = await query(
    'SELECT DISTINCT course_code FROM professor_reviews WHERE professor_id=$1 ORDER BY course_code',
    [req.params.id]
  );

  const { course } = req.query;
  let reviewSql = `
    SELECT pr.id, pr.course_code, pr.rating, pr.comment, pr.grade_received,
           pr.created_at, pr.user_id,
           u.name AS reviewer_name, u.photo_url AS reviewer_photo
    FROM professor_reviews pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.professor_id = $1
  `;
  const rParams = [req.params.id];
  if (course) { reviewSql += ' AND pr.course_code = $2'; rParams.push(course); }
  reviewSql += ' ORDER BY pr.created_at DESC LIMIT 100';

  const reviews = await query(reviewSql, rParams);
  const sanitisedReviews = reviews.map(r => ({
    ...r,
    is_mine:        r.user_id === req.user.id,
    reviewer_name:  r.user_id === req.user.id ? r.reviewer_name  : 'Anonymous',
    reviewer_photo: r.user_id === req.user.id ? r.reviewer_photo : null,
  }));

  return res.json({ ...prof, breakdown, courses: courses.map(c => c.course_code), reviews: sanitisedReviews });
});

// POST /api/professors/:id/reviews — submit a review
router.post('/:id/reviews', requireAuth, reviewLimiter, async (req, res) => {
  const profId     = parseInt(req.params.id);
  const userId     = req.user.id;
  const courseCode = sanitise(req.body.course_code, 20);
  const rating     = parseInt(req.body.rating);
  const comment    = sanitise(req.body.comment, 1000);
  const grade      = sanitise(req.body.grade_received, 5);

  if (!courseCode) return res.status(400).json({ success: false, message: 'Course code is required.' });
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be 1–5.' });

  const prof = await queryOne(
    'SELECT id FROM professors WHERE id=$1 AND university_id=$2',
    [profId, req.user.university_id]
  );
  if (!prof) return res.status(404).json({ success: false, message: 'Professor not found.' });

  try {
    const review = await queryOne(
      `INSERT INTO professor_reviews (professor_id, user_id, course_code, rating, comment, grade_received)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, course_code, rating, comment, grade_received, created_at`,
      [profId, userId, courseCode.toUpperCase(), rating, comment, grade]
    );
    return res.status(201).json({ success: true, review });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'You already reviewed this professor for that course.' });
    }
    console.error('POST /professors/:id/reviews:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to submit review.' });
  }
});

// PATCH /api/professors/:id/reviews/:reviewId — edit own review
router.patch('/:id/reviews/:reviewId', requireAuth, async (req, res) => {
  const reviewId = parseInt(req.params.reviewId);
  const existing = await queryOne(
    'SELECT id, user_id FROM professor_reviews WHERE id=$1 AND professor_id=$2',
    [reviewId, req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, message: 'Review not found.' });
  if (existing.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your review.' });

  const rating  = parseInt(req.body.rating);
  const comment = sanitise(req.body.comment, 1000);
  const grade   = sanitise(req.body.grade_received, 5);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be 1–5.' });

  const updated = await queryOne(
    `UPDATE professor_reviews SET rating=$1, comment=$2, grade_received=$3, updated_at=NOW()
     WHERE id=$4 RETURNING id, course_code, rating, comment, grade_received, updated_at`,
    [rating, comment, grade, reviewId]
  );
  return res.json({ success: true, review: updated });
});

// DELETE /api/professors/:id/reviews/:reviewId — delete own review
router.delete('/:id/reviews/:reviewId', requireAuth, async (req, res) => {
  const reviewId = parseInt(req.params.reviewId);
  const existing = await queryOne(
    'SELECT id, user_id FROM professor_reviews WHERE id=$1 AND professor_id=$2',
    [reviewId, req.params.id]
  );
  if (!existing) return res.status(404).json({ success: false, message: 'Review not found.' });
  if (existing.user_id !== req.user.id) return res.status(403).json({ success: false, message: 'Not your review.' });

  await run('DELETE FROM professor_reviews WHERE id=$1', [reviewId]);
  return res.json({ success: true });
});

module.exports = router;
