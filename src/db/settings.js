/**
 * db/settings.js
 * Simple key-value store for app-wide config that admins can edit at runtime.
 * Currently used for the 3PL warehouse address (threepl_address — stored as JSON).
 */

const { getDb } = require('./connection');

// Default 3PL warehouse — used when no override is set in the settings table.
// Admins can override via PUT /api/settings/threepl.
const DEFAULT_THREEPL_ADDRESS = {
  name:          'Mr Deng 邓华(W) 收',
  address1:      '捷威工业园11栋202, 平吉大道57号',
  address2:      '平湖街道, 龙岗区',
  city:          '深圳市 (Shenzhen)',
  province_code: 'GD',
  zip:           '518000',
  country:       'China',
  phone:         '+86 18922840297',
};

function getThreeplAddress() {
  return getJson('threepl_address') || DEFAULT_THREEPL_ADDRESS;
}

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

module.exports = { getSetting, setSetting, getJson, setJson, getThreeplAddress, DEFAULT_THREEPL_ADDRESS };
