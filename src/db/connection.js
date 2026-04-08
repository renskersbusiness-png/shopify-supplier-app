/**
 * db/connection.js
 * Single shared database connection for the app.
 * Import this wherever you need DB access.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/orders.db';

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(path.resolve(DB_PATH));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    runMigrations(_db);
  }
  return _db;
}

/**
 * Safe, additive schema migrations.
 * Each block is idempotent — it checks whether the column already exists
 * before attempting to add it, so re-running on an existing DB is harmless.
 */
function runMigrations(db) {
  const cols = db.pragma('table_info(orders)').map(c => c.name);

  // ── v2: financial_status — tracks Shopify payment state separately from
  //        our internal workflow status (pending/processing/shipped/fulfilled).
  //        Values mirror Shopify: pending, authorized, partially_paid, paid,
  //        partially_refunded, refunded, voided.
  if (!cols.includes('financial_status')) {
    db.exec(`ALTER TABLE orders ADD COLUMN financial_status TEXT NOT NULL DEFAULT 'pending'`);
    // Backfill existing rows: anything already past pending was paid
    db.exec(`
      UPDATE orders
      SET financial_status = 'paid'
      WHERE status IN ('processing', 'shipped', 'fulfilled')
    `);
    console.log('[DB] Migration v2: added financial_status column, backfilled existing orders');
  }
}

module.exports = { getDb };
