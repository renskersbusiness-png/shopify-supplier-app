/**
 * server.js
 * Main application entry point.
 * Starts the Express server, configures middleware, and mounts routes.
 */

require('dotenv').config();

const express        = require('express');
const session        = require('express-session');
const path           = require('path');

const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
// Required on Railway (and any reverse-proxy host) so Express sees the real
// HTTPS protocol from X-Forwarded-Proto. Without this, secure:true cookies are
// silently dropped because Express thinks the connection is plain HTTP.
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ── Raw body capture for webhook HMAC verification ───────────────────────────
// IMPORTANT: This MUST come before express.json() / express.urlencoded()
//
// We read the stream directly rather than using express.raw() + verify because
// express.raw() only fires its verify callback when Content-Type matches exactly.
// Reverse proxies (Railway, Render, etc.) often append "; charset=utf-8" to the
// Content-Type header, which breaks the match and leaves req.rawBody undefined.
// Direct stream reading is Content-Type-agnostic and always works.
app.use('/webhooks', (req, res, next) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBuf  = Buffer.concat(chunks);
    req.rawBody   = rawBuf.toString('utf8');
    // Tell body-parser the body is already read so express.json() skips this request
    req._body     = true;
    try {
      req.body = JSON.parse(req.rawBody);
    } catch {
      req.body = {};
    }
    next();
  });
  req.on('error', next);
});

// ── Standard body parsers (for dashboard API routes) ─────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session (for dashboard login) ────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production', // HTTPS only in production
    sameSite: 'lax',
    maxAge:   24 * 60 * 60 * 1000, // 24 hours
  },
}));

// ── Static files (dashboard CSS/JS) ──────────────────────────────────────────
// index:false prevents express.static from serving public/index.html for GET /
// That request must fall through to the dashboard router so requireAuth runs.
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ── Routes ────────────────────────────────────────────────────────────────────

// 1. Shopify webhooks (no auth, but HMAC verified inside the route)
app.use('/webhooks', require('./routes/webhook'));

// 2. Supplier portal API — must come BEFORE the admin /api router so that
//    /api/supplier/* requests are not consumed by the admin router first.
app.use('/api/supplier', require('./routes/supplier'));

// 3. Admin API (auth required — handled inside the route)
app.use('/api', require('./routes/api'));

// 4. Dashboard HTML pages (login + admin SPA + supplier SPA)
app.use('/', require('./routes/dashboard'));

// ── Health check (used by Railway / Render uptime checks) ────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const { syncRecentOrders } = require('./shopify/client');

// Warn loudly if the DB is in the default ephemeral path on a cloud host.
// On Railway: create a Volume, mount it at /data, set DB_PATH=/data/orders.db
const dbPath = process.env.DB_PATH || './data/orders.db';
if (!process.env.DB_PATH && process.env.RAILWAY_ENVIRONMENT) {
  console.warn('');
  console.warn('⚠️  WARNING: DB_PATH is not set but running on Railway.');
  console.warn('   The database is stored in the container filesystem and will');
  console.warn('   be WIPED on every deploy, deleting all suppliers, rules, and');
  console.warn('   assignments. To fix this:');
  console.warn('   1. Create a Railway Volume');
  console.warn('   2. Mount it at /data');
  console.warn('   3. Set DB_PATH=/data/orders.db in Railway env vars');
  console.warn('');
}
console.log(`[DB] Path: ${path.resolve(dbPath)}`);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────────────┐
  │  📦  Shopify Fulfillment Portal running      │
  │  http://localhost:${PORT}                       │
  │                                              │
  │  Admin:      http://localhost:${PORT}/          │
  │  Supplier:   http://localhost:${PORT}/s/:token  │
  │  Webhooks:   POST /webhooks/orders/create    │
  │  Health:     GET  /health                    │
  └──────────────────────────────────────────────┘
  `);

  // Fetch recent orders so the dashboard is populated immediately on startup
  syncRecentOrders().catch(err => {
    console.error('[Sync] Initial order sync failed:', err.message);
  });
});

module.exports = app;
