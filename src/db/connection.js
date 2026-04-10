/**
 * db/connection.js
 * Single shared database connection. Runs all schema migrations on first open.
 * Works on a completely fresh (empty) database — no manual setup step required.
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/orders.db';

let _db = null;

function getDb() {
  if (!_db) {
    // Ensure the parent directory exists (important for fresh volume mounts)
    const dir = path.dirname(path.resolve(DB_PATH));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[DB] Created directory: ${dir}`);
    }

    _db = new Database(path.resolve(DB_PATH));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    runMigrations(_db);
  }
  return _db;
}

function runMigrations(db) {
  // ── v1: base schema ───────────────────────────────────────────────────────────
  // Always run with IF NOT EXISTS — safe on existing DBs, creates everything
  // from scratch on a fresh volume-backed DB.

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id       TEXT    NOT NULL UNIQUE,
      shopify_order_num      TEXT    NOT NULL,
      customer_name          TEXT,
      customer_email         TEXT,
      customer_phone         TEXT,
      shipping_address       TEXT,
      line_items             TEXT,
      total_price            TEXT,
      currency               TEXT    DEFAULT 'USD',
      financial_status       TEXT    NOT NULL DEFAULT 'pending',
      status                 TEXT    NOT NULL DEFAULT 'pending',
      tracking_number        TEXT,
      tracking_carrier       TEXT,
      tracking_url           TEXT,
      shopify_fulfillment_id TEXT,
      notes                  TEXT,
      raw_payload            TEXT,
      shopify_created_at     TEXT,
      created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER,
      action     TEXT    NOT NULL DEFAULT 'note',
      detail     TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS orders_updated_at
    AFTER UPDATE ON orders
    BEGIN
      UPDATE orders SET updated_at = datetime('now') WHERE id = NEW.id;
    END
  `);

  // ── v2: financial_status column (for DBs that pre-date v1 consolidated) ──────
  // On a fresh DB this column already exists from v1 above, so this is a no-op.
  // On an old DB (pre-v2) that already has the orders table without the column,
  // we add it. Guard with a column existence check so we never double-ALTER.
  const orderCols = db.pragma('table_info(orders)').map(c => c.name);
  if (!orderCols.includes('financial_status')) {
    db.exec(`ALTER TABLE orders ADD COLUMN financial_status TEXT NOT NULL DEFAULT 'pending'`);
    db.exec(`UPDATE orders SET financial_status = 'paid' WHERE status IN ('processing','shipped','fulfilled')`);
    console.log('[DB] v2: added financial_status column to existing orders table');
  }

  // ── v3: multi-supplier tables ─────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT    NOT NULL,
      notes        TEXT,
      access_token TEXT    NOT NULL UNIQUE,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS line_item_assignments (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id               INTEGER NOT NULL,
      shopify_line_item_id   TEXT    NOT NULL,
      title                  TEXT    NOT NULL,
      variant_title          TEXT,
      sku                    TEXT,
      vendor                 TEXT,
      product_id             TEXT,
      quantity               INTEGER NOT NULL DEFAULT 1,
      price                  TEXT,
      currency               TEXT,
      supplier_id            INTEGER,
      assignment_rule_id     INTEGER,
      status                 TEXT    NOT NULL DEFAULT 'unassigned',
      tracking_number        TEXT,
      tracking_carrier       TEXT,
      tracking_url           TEXT,
      shopify_fulfillment_id TEXT,
      notified_at            TEXT,
      notes                  TEXT,
      created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id)    REFERENCES orders(id),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_lia_supplier ON line_item_assignments(supplier_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lia_order    ON line_item_assignments(order_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lia_status   ON line_item_assignments(status)`);

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

  // ── v4: Shopify fulfillment service + supplier SKU catalog ────────────────
  // Add Shopify location/service columns to existing suppliers rows.
  // On a fresh DB these columns don't exist yet; guard with a column check.
  const supplierCols = db.pragma('table_info(suppliers)').map(c => c.name);
  if (!supplierCols.includes('shopify_location_id')) {
    db.exec(`ALTER TABLE suppliers ADD COLUMN shopify_location_id TEXT`);
    db.exec(`ALTER TABLE suppliers ADD COLUMN shopify_service_id  TEXT`);
    console.log('[DB] v4: added shopify_location_id, shopify_service_id to suppliers');
  }

  // supplier_skus: links each supplier to the SKUs they stock.
  // Separate from assignment_rules (which routes ORDERS) — this table is for
  // inventory management (what stock does a supplier hold per SKU).
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_skus (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id               INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      sku                       TEXT    NOT NULL,
      product_title             TEXT,
      shopify_variant_id        TEXT,
      shopify_inventory_item_id TEXT,
      stock_quantity            INTEGER NOT NULL DEFAULT 0,
      last_synced_at            TEXT,
      notes                     TEXT,
      created_at                TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(supplier_id, sku)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ss_supplier ON supplier_skus(supplier_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ss_sku      ON supplier_skus(sku)`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS supplier_skus_updated_at
    AFTER UPDATE ON supplier_skus
    BEGIN
      UPDATE supplier_skus SET updated_at = datetime('now') WHERE id = NEW.id;
    END
  `);

  console.log('[DB] Schema ready');
}

module.exports = { getDb };
