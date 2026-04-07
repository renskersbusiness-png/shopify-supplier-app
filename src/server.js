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
    maxAge:   24 * 60 * 60 * 1000, // 24 hours
  },
}));

// ── Static files (dashboard CSS/JS) ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Routes ────────────────────────────────────────────────────────────────────

// 1. Shopify webhooks (no auth, but HMAC verified inside the route)
app.use('/webhooks', require('./routes/webhook'));

// 2. Dashboard API (auth required — handled inside the route)
app.use('/api', require('./routes/api'));

// 3. Dashboard HTML pages (login + main page)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────────┐
  │  📦  Shopify Supplier App running        │
  │  http://localhost:${PORT}                   │
  │                                          │
  │  Dashboard:  http://localhost:${PORT}       │
  │  Webhooks:   POST /webhooks/orders/create│
  │  Health:     GET  /health                │
  └──────────────────────────────────────────┘
  `);

  // Fetch recent orders so the dashboard is populated immediately on startup
  syncRecentOrders().catch(err => {
    console.error('[Sync] Initial order sync failed:', err.message);
  });
});

module.exports = app;
