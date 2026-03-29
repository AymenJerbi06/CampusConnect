const express   = require('express');
const router    = express.Router();
const jwt       = require('jsonwebtoken');
const argon2    = require('argon2');
const rateLimit = require('express-rate-limit');
const { queryOne, run } = require('../db');

// ─── Rate limiters ────────────────────────────────────────────────────────────
const makeLimit = (max, windowMin, msg) => rateLimit({
  windowMs: windowMin * 60 * 1000,
  max,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => res.status(429).json({ success: false, message: msg }),
});

const otpSendLimit    = makeLimit(5,  15, 'Too many code requests. Wait 15 minutes.');
const otpVerifyLimit  = makeLimit(10, 15, 'Too many attempts. Wait 15 minutes.');
const loginLimit      = makeLimit(10, 15, 'Too many login attempts. Wait 15 minutes.');
const setPasswordLimit= makeLimit(5,  15, 'Too many attempts. Wait 15 minutes.');

// ─── Argon2id config (OWASP recommended) ─────────────────────────────────────
const ARGON2_OPTIONS = {
  type:        argon2.argon2id,
  memoryCost:  65536,   // 64 MiB
  timeCost:    3,
  parallelism: 4,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOTPEmail(email, code, subject) {
  // Always log to terminal (useful during development)
  console.log(`\n[OTP] Email: ${email} | Code: ${code} | Purpose: ${subject}\n`);

  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'CampusConnect <noreply@campusconnect.app>',
      to: email,
      subject: subject || 'Your CampusConnect verification code',
      html: `<div style="font-family:sans-serif;max-width:400px;margin:40px auto;background:#13131a;color:#f0f0f5;padding:32px;border-radius:16px;border:1px solid #2a2a3a">
        <h2 style="color:#c8f04e;margin-top:0">CampusConnect</h2>
        <p>${subject || 'Your verification code is:'}</p>
        <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#c8f04e;padding:16px 0">${code}</div>
        <p style="color:#6b6b85;font-size:13px">This code expires in 10 minutes. Do not share it with anyone.</p>
      </div>`,
    });
  }
}

async function issueOTP(email, purpose) {
  // Invalidate any previous unused tokens for this email + purpose
  await run(
    'UPDATE otp_tokens SET used=TRUE WHERE email=$1 AND purpose=$2 AND used=FALSE',
    [email, purpose]
  );
  const code      = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await run(
    'INSERT INTO otp_tokens (email, code, expires_at, purpose) VALUES ($1,$2,$3,$4)',
    [email, code, expiresAt, purpose]
  );
  return code;
}

async function consumeOTP(email, code, purpose) {
  const token = await queryOne(
    `SELECT * FROM otp_tokens
     WHERE email=$1 AND code=$2 AND purpose=$3 AND used=FALSE AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [email, code, purpose]
  );
  if (!token) return false;
  await run('UPDATE otp_tokens SET used=TRUE WHERE id=$1', [token.id]);
  return true;
}

function issueToken(userId, res) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  const token = jwt.sign({ userId }, secret, { expiresIn: '30d' });
  res.cookie('cc_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000,
  });
  return token; // returned so mobile clients can store it
}

// ─── SIGN-UP FLOW ─────────────────────────────────────────────────────────────
// Step 1: send OTP to verify university email

router.post('/send-otp', otpSendLimit, async (req, res) => {
  const { email, universityId } = req.body;
  if (!email || !universityId) {
    return res.status(400).json({ success: false, message: 'Email and university required.' });
  }

  const uni = await queryOne('SELECT * FROM universities WHERE id=$1', [universityId]);
  if (!uni) return res.status(400).json({ success: false, message: 'Invalid university.' });

  const emailLower = email.toLowerCase().trim();
  if (!emailLower.endsWith('@' + uni.email_domain)) {
    return res.status(400).json({ success: false, message: `Email must end with @${uni.email_domain}` });
  }

  // Prevent re-signup if account already has a password
  const existing = await queryOne('SELECT password_hash FROM users WHERE email=$1', [emailLower]);
  if (existing?.password_hash) {
    return res.status(409).json({ success: false, message: 'Account already exists. Please log in.' });
  }

  try {
    const code = await issueOTP(emailLower, 'signup');
    await sendOTPEmail(emailLower, code, 'Your CampusConnect verification code');
  } catch (err) {
    console.error('OTP send failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send email. Try again.' });
  }

  return res.json({ success: true, message: 'Verification code sent.' });
});

// Step 2: verify signup OTP — marks email as verified, does NOT issue JWT
router.post('/verify-otp', otpVerifyLimit, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ success: false, message: 'Email and code required.' });
  }

  const emailLower = email.toLowerCase().trim();
  const ok = await consumeOTP(emailLower, code, 'signup');
  if (!ok) return res.status(400).json({ success: false, message: 'Invalid or expired code.' });

  // Find or create user, mark email verified
  let user = await queryOne('SELECT * FROM users WHERE email=$1', [emailLower]);
  if (!user) {
    const uni = await queryOne(
      "SELECT id FROM universities WHERE $1 LIKE '%@' || email_domain",
      [emailLower]
    );
    const result = await run(
      'INSERT INTO users (email, university_id, email_verified_at) VALUES ($1,$2,NOW()) RETURNING *',
      [emailLower, uni?.id || null]
    );
    user = result.rows[0];
  } else {
    await run('UPDATE users SET email_verified_at=NOW() WHERE id=$1', [user.id]);
  }

  return res.json({ success: true, needsPassword: !user.password_hash });
});

// Step 3: set password after email verification
router.post('/set-password', setPasswordLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }

  const emailLower = email.toLowerCase().trim();
  const user = await queryOne('SELECT * FROM users WHERE email=$1', [emailLower]);
  if (!user) return res.status(400).json({ success: false, message: 'Email not found.' });

  // Require that email was verified recently (within 30 minutes)
  if (!user.email_verified_at ||
      Date.now() - new Date(user.email_verified_at).getTime() > 30 * 60 * 1000) {
    return res.status(400).json({ success: false, message: 'Email verification expired. Start over.' });
  }

  const hash = await argon2.hash(password, ARGON2_OPTIONS);
  await run(
    'UPDATE users SET password_hash=$1 WHERE id=$2',
    [hash, user.id]
  );

  const token = issueToken(user.id, res);
  return res.json({
    success:         true,
    token,
    profileComplete: user.profile_complete,
    redirect:        user.profile_complete ? '/home.html' : '/profile-setup.html',
  });
});

// ─── LOGIN FLOW ───────────────────────────────────────────────────────────────
// Step 1: verify email + password, then issue step-up OTP

router.post('/login', loginLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required.' });
  }

  const emailLower = email.toLowerCase().trim();
  const user = await queryOne('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [emailLower]);

  // Generic error — do not reveal whether email exists
  const FAIL = () => res.status(401).json({ success: false, message: 'Incorrect email or password.' });

  if (!user) return FAIL();

  // Account has no password — needs setup
  if (!user.password_hash) {
    return res.status(403).json({
      success: false,
      message: 'No password set for this account.',
      needsPasswordSetup: true,
    });
  }

  // Locked account check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    return res.status(423).json({
      success: false,
      message: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
    });
  }

  const passwordOk = await argon2.verify(user.password_hash, password);
  if (!passwordOk) {
    const attempts = (user.failed_login_attempts || 0) + 1;
    const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
    await run(
      'UPDATE users SET failed_login_attempts=$1, locked_until=$2 WHERE id=$3',
      [attempts, lockUntil, user.id]
    );
    return FAIL();
  }

  // Password correct — reset fail counter and send step-up OTP
  await run(
    'UPDATE users SET failed_login_attempts=0, locked_until=NULL WHERE id=$1',
    [user.id]
  );

  try {
    const code = await issueOTP(emailLower, 'login');
    await sendOTPEmail(emailLower, code, 'Your CampusConnect login code');
  } catch (err) {
    console.error('Login OTP send failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send login code. Try again.' });
  }

  return res.json({ success: true, step: 'otp' });
});

// Step 2: verify login step-up OTP, issue JWT
router.post('/verify-login-otp', otpVerifyLimit, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ success: false, message: 'Email and code required.' });
  }

  const emailLower = email.toLowerCase().trim();
  const ok = await consumeOTP(emailLower, code, 'login');
  if (!ok) return res.status(400).json({ success: false, message: 'Invalid or expired code.' });

  const user = await queryOne('SELECT * FROM users WHERE email=$1', [emailLower]);
  if (!user) return res.status(400).json({ success: false, message: 'User not found.' });

  await run('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);

  const token = issueToken(user.id, res);
  return res.json({
    success:         true,
    token,
    profileComplete: user.profile_complete,
    redirect:        user.profile_complete ? '/home.html' : '/profile-setup.html',
  });
});

// ─── PASSWORD RESET FLOW ──────────────────────────────────────────────────────
// Step 1: request reset — send OTP
router.post('/forgot-password', otpSendLimit, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required.' });

  const emailLower = email.toLowerCase().trim();
  const user = await queryOne(
    'SELECT id FROM users WHERE email=$1 AND password_hash IS NOT NULL AND deleted_at IS NULL',
    [emailLower]
  );

  if (!user) return res.json({ success: false, message: 'No account found with that email.' });

  try {
    const code = await issueOTP(emailLower, 'reset');
    await sendOTPEmail(emailLower, code, 'Reset your CampusConnect password');
  } catch (err) {
    console.error('Reset OTP send failed:', err.message);
  }

  return res.json({ success: true });
});

// Step 2: verify reset OTP + set new password
router.post('/reset-password', setPasswordLimit, async (req, res) => {
  const { email, code, password } = req.body;
  if (!email || !code || !password) {
    return res.status(400).json({ success: false, message: 'All fields required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }

  const emailLower = email.toLowerCase().trim();
  const ok = await consumeOTP(emailLower, code, 'reset');
  if (!ok) return res.status(400).json({ success: false, message: 'Invalid or expired code.' });

  const user = await queryOne('SELECT * FROM users WHERE email=$1', [emailLower]);
  if (!user) return res.status(400).json({ success: false, message: 'User not found.' });

  const hash = await argon2.hash(password, ARGON2_OPTIONS);
  await run(
    'UPDATE users SET password_hash=$1, failed_login_attempts=0, locked_until=NULL WHERE id=$2',
    [hash, user.id]
  );

  issueToken(user.id, res);
  return res.json({
    success:         true,
    profileComplete: user.profile_complete,
    redirect:        user.profile_complete ? '/home.html' : '/profile-setup.html',
  });
});

// ─── RESEND OTP ───────────────────────────────────────────────────────────────
// Works for signup / login / reset — 60-second cooldown enforced.
// Returns success=true even for unknown emails to prevent enumeration.
const OTP_COOLDOWN_MS = 60 * 1000;

router.post('/resend-otp', otpSendLimit, async (req, res) => {
  const { email, purpose } = req.body;
  if (!email || !['signup', 'login', 'reset'].includes(purpose)) {
    return res.status(400).json({ success: false, message: 'Invalid request.' });
  }

  const emailLower = email.toLowerCase().trim();

  // Enforce cooldown: check when the last OTP for this email+purpose was created
  const last = await queryOne(
    'SELECT created_at FROM otp_tokens WHERE email=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1',
    [emailLower, purpose]
  );
  if (last && Date.now() - new Date(last.created_at).getTime() < OTP_COOLDOWN_MS) {
    const waitSecs = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - new Date(last.created_at).getTime())) / 1000);
    return res.status(429).json({ success: false, message: `Wait ${waitSecs}s before requesting another code.` });
  }

  // For login and reset, silently ignore unknown / password-less accounts (enumeration-safe)
  if (purpose === 'login' || purpose === 'reset') {
    const user = await queryOne(
      'SELECT id, password_hash FROM users WHERE email=$1 AND deleted_at IS NULL',
      [emailLower]
    );
    if (!user?.password_hash) return res.json({ success: true });
  }

  const subjectMap = {
    signup: 'Your CampusConnect verification code',
    login:  'Your CampusConnect login code',
    reset:  'Reset your CampusConnect password',
  };

  try {
    const code = await issueOTP(emailLower, purpose);
    await sendOTPEmail(emailLower, code, subjectMap[purpose]);
  } catch (err) {
    console.error('Resend OTP failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send code. Try again.' });
  }

  return res.json({ success: true });
});

// ─── SHARED ───────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('cc_token');
  return res.json({ success: true });
});

router.get('/me', async (req, res) => {
  const token = req.cookies?.cc_token;
  if (!token) return res.json({ authenticated: false });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await queryOne(
      `SELECT id, email, name, major, year, photo_url, profile_complete,
              university_id, plan, browse_privately
       FROM users WHERE id=$1 AND deleted_at IS NULL`,
      [payload.userId]
    );
    if (!user) return res.json({ authenticated: false });
    return res.json({ authenticated: true, user });
  } catch {
    return res.json({ authenticated: false });
  }
});

module.exports = router;
