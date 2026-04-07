/**
 * middleware/auth.js
 * Simple password-based protection for the dashboard.
 * This keeps the dashboard private — only you should access it.
 *
 * For production, you could replace this with proper OAuth/SSO.
 */

function requireAuth(req, res, next) {
  // Allow access if already authenticated via session
  if (req.session && req.session.authenticated) {
    return next();
  }

  // API routes must return JSON — never redirect to an HTML login page,
  // because the frontend fetch() would receive HTML and throw "Unexpected token '<'"
  if (req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Dashboard HTML routes: store the destination and redirect to login
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

module.exports = { requireAuth };
