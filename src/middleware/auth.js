/**
 * middleware/auth.js
 * Password-based protection for the dashboard.
 * Supports two roles: 'admin' and 'supplier', determined at login by which
 * password was entered (ADMIN_PASSWORD vs SUPPLIER_PASSWORD).
 */

function requireAuth(req, res, next) {
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

// Middleware factory — restricts a route to a specific role.
// Only used for routes that must be admin-only; most role logic lives in the
// route handlers themselves so they can return role-appropriate data.
function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.role === role) return next();
    if (req.originalUrl.startsWith('/api')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.redirect('/login');
  };
}

module.exports = { requireAuth, requireRole };
