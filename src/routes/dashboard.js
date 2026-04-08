/**
 * routes/dashboard.js
 * Serves the HTML dashboard pages.
 * The actual UI is in public/index.html (single-page app).
 */

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  // Only skip the login form if the session has BOTH authenticated AND role.
  // Sessions created before the role-based system was introduced have
  // authenticated=true but no role — force those users to re-login so they
  // receive a proper role assignment. This was the root cause of "roles reversed".
  if (req.session?.authenticated && req.session?.role) return res.redirect('/');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Order Dashboard</title>
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
  </style>
</head>
<body>
  <div class="card">
    <h1>📦 Order Dashboard</h1>
    <p>Enter your password to access the order management dashboard.</p>
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password" autofocus required>
      <button type="submit">Sign in</button>
      ${req.query.error ? '<div class="error">Incorrect password. Try again.</div>' : ''}
    </form>
  </div>
</body>
</html>`);
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPw    = process.env.ADMIN_PASSWORD;
  const supplierPw = process.env.SUPPLIER_PASSWORD;

  if (!adminPw || !supplierPw) {
    return res.status(500).send('ADMIN_PASSWORD and SUPPLIER_PASSWORD must be configured.');
  }

  const crypto = require('crypto');

  // Constant-time comparison — always run both comparisons to prevent timing leaks
  function safeEq(input, expected) {
    try {
      const a = Buffer.from(input || '');
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }

  const isAdmin    = safeEq(password, adminPw);
  const isSupplier = !isAdmin && safeEq(password, supplierPw);

  const role = isAdmin ? 'admin' : isSupplier ? 'supplier' : null;

  if (!role) return res.redirect('/login?error=1');

  req.session.authenticated = true;
  req.session.role = role;
  const returnTo = req.session.returnTo || '/';
  delete req.session.returnTo;

  // Save session before redirecting — async write must complete first or the
  // next request will see an empty session and return 401.
  req.session.save((err) => {
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

// ── Dashboard (all routes served by single HTML page) ─────────────────────────

router.get('/', requireAuth, (req, res) => {
  res.sendFile('index.html', { root: require('path').join(__dirname, '../../public') });
});

module.exports = router;
