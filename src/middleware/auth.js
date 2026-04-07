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

  // Store the originally requested URL so we can redirect after login
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

module.exports = { requireAuth };
