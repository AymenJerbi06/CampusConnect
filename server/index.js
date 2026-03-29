require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ── Required environment variables ──────────────────────────────────────────
// Fail loudly at startup rather than silently misbehaving in production.
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`FATAL: missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const http         = require('http');
const express      = require('express');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const path         = require('path');
const { initSchema } = require('./db');
const { init: initSocket } = require('./socket');

const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const communityRoutes   = require('./routes/communities');
const courseRoutes      = require('./routes/courses');
const universityRoutes  = require('./routes/universities');
const friendRoutes      = require('./routes/friends');
const messageRoutes     = require('./routes/messages');
const visitRoutes       = require('./routes/visits');
const professorRoutes   = require('./routes/professors');
const requireAuth       = require('./middleware/requireAuth');
const { router: billingRouter, webhookHandler, revenuecatWebhookHandler } = require('./routes/billing');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  // Allow inline scripts/styles in our single-file HTML pages
  contentSecurityPolicy: false,
  // Allow Socket.IO to load from the same origin
  crossOriginEmbedderPolicy: false,
}));

// ── Stripe webhook — MUST come before express.json() ────────────────────────
// Stripe requires the raw body bytes for signature verification.
app.post(
  '/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  webhookHandler
);

// ── RevenueCat webhook — also needs raw body ─────────────────────────────────
app.post(
  '/api/billing/revenuecat-webhook',
  express.raw({ type: 'application/json' }),
  revenuecatWebhookHandler
);

// ── Body parsing + cookies ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ── Socket.IO ────────────────────────────────────────────────────────────────
initSocket(server);

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/users',        userRoutes);
app.use('/api/communities',  communityRoutes);
app.use('/api/courses',      courseRoutes);
app.use('/api/universities', universityRoutes);
app.use('/api/friends',      friendRoutes);
app.use('/api/messages',     messageRoutes);
app.use('/api/visits',       visitRoutes);
app.use('/api/professors',   professorRoutes);
app.use('/api/billing',      billingRouter);

// ── Protected pages ──────────────────────────────────────────────────────────
const protect = (page) => [requireAuth, (req, res) => res.sendFile(path.join(__dirname, '..', page))];
app.get('/home.html',          ...protect('home.html'));
app.get('/community.html',     ...protect('community.html'));
app.get('/course.html',        ...protect('course.html'));
app.get('/profile.html',       ...protect('profile.html'));
app.get('/my-profile.html',    ...protect('my-profile.html'));
app.get('/profile-setup.html', ...protect('profile-setup.html'));
app.get('/inbox.html',         ...protect('inbox.html'));
app.get('/messages.html',      ...protect('messages.html'));
app.get('/chat.html',          ...protect('chat.html'));
app.get('/visitors.html',      ...protect('visitors.html'));
app.get('/study.html',         ...protect('study.html'));
app.get('/professor.html',     ...protect('professor.html'));
app.get('/upgrade.html',       ...protect('upgrade.html'));

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const token = req.cookies?.cc_token;
  if (token) return res.redirect('/home.html');
  return res.sendFile(path.join(__dirname, '../index.html'));
});

// ── Static assets + catch-all ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..'), { index: false }));
app.use((req, res) => res.status(404).redirect('/'));

// ── Start ─────────────────────────────────────────────────────────────────────
initSchema()
  .then(() => server.listen(PORT, () => console.log(`✓ CampusConnect running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
