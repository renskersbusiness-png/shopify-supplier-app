/**
 * middleware/auth.js
 * Auth middleware for admin (password) and supplier (token-in-URL) sessions.
 *
 * Admin login:    POST /api/login  { password }  → session.role='admin'
 * Supplier login: GET  /s/:token               → session.role='supplier', session.supplierId
 */

const { getSupplierByToken } = require('../db/suppliers');

// ── Session-based auth (admin + supplier) ─────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated && req.session.role) {
    return next();
  }
  if (req.originalUrl.startsWith('/api')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

// Middleware factory — restricts route to a specific role
function requireRole(role) {
  return (req, res, next) => {
    if (req.session && req.session.role === role) return next();
    if (req.originalUrl.startsWith('/api')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.redirect('/login');
  };
}

// ── Token-based supplier auth (/s/:token) ─────────────────────────────────────

/**
 * authenticateSupplierToken
 * Used as a route handler for GET /s/:token.
 * Looks up the supplier by token, sets session, then redirects to /supplier.html.
 * If invalid, redirects to /login with ?error=invalid_token.
 */
function authenticateSupplierToken(req, res) {
  const { token } = req.params;
  const supplier  = getSupplierByToken(token);

  if (!supplier) {
    return res.redirect('/login?error=invalid_token');
  }

  req.session.authenticated = true;
  req.session.role          = 'supplier';
  req.session.supplierId    = supplier.id;
  req.session.supplierName  = supplier.name;

  res.redirect('/supplier.html');
}

/**
 * requireSupplierSession
 * Guards supplier API routes — must be authenticated with role=supplier.
 */
function requireSupplierSession(req, res, next) {
  if (req.session && req.session.role === 'supplier' && req.session.supplierId) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated as supplier' });
}

module.exports = {
  requireAuth,
  requireRole,
  authenticateSupplierToken,
  requireSupplierSession,
};
