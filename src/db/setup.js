/**
 * db/setup.js
 * Creates the SQLite database and tables.
 * Run once with: node src/db/setup.js
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const DB_PATH = process.env.DB_PATH || './data/orders.db';

// Make sure the data directory exists
const dir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Created directory: ${dir}`);
}

const Database = require('better-sqlite3');
const db = new Database(path.resolve(DB_PATH));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// ── Orders table ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Shopify identifiers
    shopify_order_id  TEXT    NOT NULL UNIQUE,
    shopify_order_num TEXT    NOT NULL,

    -- Customer info
    customer_name     TEXT,
    customer_email    TEXT,
    customer_phone    TEXT,

    -- Shipping address (stored as JSON for flexibility)
    shipping_address  TEXT,   -- JSON string

    -- Line items (stored as JSON array)
    line_items        TEXT,   -- JSON string

    -- Financials
    total_price       TEXT,
    currency          TEXT    DEFAULT 'USD',

    -- Workflow status
    -- pending → processing → shipped → fulfilled
    status            TEXT    NOT NULL DEFAULT 'pending',

    -- Supplier tracking
    tracking_number   TEXT,
    tracking_carrier  TEXT,
    tracking_url      TEXT,

    -- Shopify fulfillment ID (set after we push fulfillment back)
    shopify_fulfillment_id TEXT,

    -- Notes you add manually
    notes             TEXT,

    -- Raw Shopify webhook payload (useful for debugging)
    raw_payload       TEXT,

    -- Timestamps
    shopify_created_at TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Activity log table ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER,
    action     TEXT NOT NULL,   -- e.g. 'status_change', 'tracking_added', 'fulfilled'
    detail     TEXT,            -- human-readable detail
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
`);

// ── Trigger: auto-update updated_at on orders ─────────────────────────────────
db.exec(`
  CREATE TRIGGER IF NOT EXISTS orders_updated_at
  AFTER UPDATE ON orders
  BEGIN
    UPDATE orders SET updated_at = datetime('now') WHERE id = NEW.id;
  END;
`);

db.close();
console.log(`✅  Database ready at: ${path.resolve(DB_PATH)}`);
