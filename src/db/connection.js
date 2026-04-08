/**
 * db/connection.js
 * Single shared database connection. Runs all schema migrations on first open.
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

function runMigrations(db) {
  // ── v2: financial_status on orders ───────────────────────────────────────────
  const orderCols = db.pragma('table_info(orders)').map(c => c.name);
  if (!orderCols.includes('financial_status')) {
    db.exec(`ALTER TABLE orders ADD COLUMN financial_status TEXT NOT NULL DEFAULT 'pending'`);
    db.exec(`UPDATE orders SET financial_status='paid' WHERE status IN ('processing','shipped','fulfilled')`);
    console.log('[DB] v2: added financial_status to orders');
  }

  // ── v3: suppliers table ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT    NOT NULL,
      notes        TEXT,
      access_token TEXT    NOT NULL UNIQUE,  -- UUID used for /s/:token auth
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── v3: assignment_rules table ────────────────────────────────────────────────
  // rule_type: 'sku' | 'vendor' | 'product_id' | 'order_tag'
  db.exec(`
    CREATE TABLE IF NOT EXISTS assignment_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type   TEXT    NOT NULL,
      rule_value  TEXT    NOT NULL,
      supplier_id INTEGER NOT NULL,
      priority    INTEGER NOT NULL DEFAULT 100,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    )
  `);

  // ── v3: line_item_assignments table ──────────────────────────────────────────
  // One row per Shopify line item per order. Supplier_id NULL = unassigned.
  // status: unassigned | assigned | tracking_added | fulfilled
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_item_assignments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id              INTEGER NOT NULL,
      shopify_line_item_id  TEXT    NOT NULL,
      title                 TEXT    NOT NULL,
      variant_title         TEXT,
      sku                   TEXT,
      vendor                TEXT,
      product_id            TEXT,
      quantity              INTEGER NOT NULL DEFAULT 1,
      price                 TEXT,
      currency              TEXT,
      supplier_id           INTEGER,
      assignment_rule_id    INTEGER,
      status                TEXT    NOT NULL DEFAULT 'unassigned',
      tracking_number       TEXT,
      tracking_carrier      TEXT,
      tracking_url          TEXT,
      shopify_fulfillment_id TEXT,
      notified_at           TEXT,
      notes                 TEXT,
      created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id)    REFERENCES orders(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    )
  `);

  // Index for fast supplier lookups
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lia_supplier ON line_item_assignments(supplier_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lia_order    ON line_item_assignments(order_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lia_status   ON line_item_assignments(status)`);

  // ── v3: trigger: auto-update updated_at on line_item_assignments ─────────────
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lia_updated_at
    AFTER UPDATE ON line_item_assignments
    BEGIN
      UPDATE line_item_assignments SET updated_at = datetime('now') WHERE id = NEW.id;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS suppliers_updated_at
    AFTER UPDATE ON suppliers
    BEGIN
      UPDATE suppliers SET updated_at = datetime('now') WHERE id = NEW.id;
    END
  `);

  console.log('[DB] Migrations complete');
}

module.exports = { getDb };
