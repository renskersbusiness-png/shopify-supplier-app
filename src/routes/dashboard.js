/**
 * routes/dashboard.js
 * Serves HTML pages and handles session-based auth.
 *
 * Auth flows:
 *  - Admin:    POST /login { password } → session role=admin → GET /admin.html
 *  - Supplier: GET  /s/:token           → session role=supplier → GET /supplier.html
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const crypto  = require('crypto');
const { requireAuth, authenticateSupplierToken } = require('../middleware/auth');

const PUBLIC = path.join(__dirname, '../../public');

// ── Supplier token auth (/s/:token) ──────────────────────────────────────────

router.get('/s/:token', authenticateSupplierToken);

// ── Admin login ───────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session?.authenticated && req.session?.role) {
    return res.redirect(req.session.role === 'admin' ? '/' : '/supplier.html');
  }

  const errorMsg = {
    invalid_token: 'Invalid or expired supplier link.',
    1: 'Incorrect password.',
  }[req.query.error] || '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Fulfillment Portal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 360px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #111; }
    p  { font-size: 14px; color: #666; margin-bottom: 28px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #374151; margin-bottom: 6px; }
    input[type="password"] {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }
    button {
      width: 100%;
      margin-top: 20px;
      padding: 11px;
      background: #6366f1;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #4f46e5; }
    .error {
      margin-top: 14px;
      padding: 10px 14px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      color: #dc2626;
      font-size: 13px;
    }
    .hint {
      margin-top: 20px;
      font-size: 12px;
      color: #9ca3af;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>📦 Fulfillment Portal</h1>
    <p>Admin login. Suppliers use their unique link.</p>
    <form method="POST" action="/login">
      <label for="password">Admin Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password" autofocus required>
      <button type="submit">Sign in</button>
      ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
    </form>
    <p class="hint">Supplier? Use the link sent to you by email.</p>
  </div>
</body>
</html>`);
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPw = process.env.ADMIN_PASSWORD;

  if (!adminPw) {
    return res.status(500).send('ADMIN_PASSWORD must be configured.');
  }

  function safeEq(input, expected) {
    try {
      const a = Buffer.from(input || '');
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }

  if (!safeEq(password, adminPw)) {
    return res.redirect('/login?error=1');
  }

  req.session.authenticated = true;
  req.session.role          = 'admin';
  const returnTo = req.session.returnTo || '/';
  delete req.session.returnTo;

  req.session.save(err => {
    if (err) {
      console.error('[Login] Session save failed:', err);
      return res.status(500).send('Login failed — please try again.');
    }
    res.redirect(returnTo);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Admin SPA ─────────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  if (req.session.role === 'supplier') return res.redirect('/supplier.html');
  res.sendFile('admin.html', { root: PUBLIC });
});

// ── Supplier SPA ──────────────────────────────────────────────────────────────

router.get('/supplier.html', requireAuth, (req, res) => {
  if (req.session.role !== 'supplier') return res.redirect('/');
  res.sendFile('supplier.html', { root: PUBLIC });
});

module.exports = router;
