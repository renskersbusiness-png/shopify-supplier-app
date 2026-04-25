/**
 * db/settings.js
 * Simple key-value store for app-wide config that admins can edit at runtime.
 * Currently used for the 3PL warehouse address (threepl_address — stored as JSON).
 */

const { getDb } = require('./connection');

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  return getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function getJson(key) {
  const raw = getSetting(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setJson(key, obj) {
  return setSetting(key, JSON.stringify(obj));
}

module.exports = { getSetting, setSetting, getJson, setJson };
