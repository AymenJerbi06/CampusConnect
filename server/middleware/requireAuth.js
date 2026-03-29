const jwt = require('jsonwebtoken');
const { queryOne } = require('../db');

module.exports = async function requireAuth(req, res, next) {
  // Accept cookie (web) or Authorization: Bearer <token> (mobile)
  const cookieToken  = req.cookies?.cc_token;
  const bearerHeader = req.headers.authorization;
  const bearerToken  = bearerHeader?.startsWith('Bearer ') ? bearerHeader.slice(7) : null;
  const token = cookieToken || bearerToken;

  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await queryOne('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (!user) return res.status(401).json({ success: false, message: 'User not found.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};
