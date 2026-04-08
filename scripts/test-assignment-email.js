#!/usr/bin/env node
/**
 * scripts/test-assignment-email.js
 * Simulates the full order → assignment → email flow without a real Shopify webhook.
 * Uses the same logic as the orders/create webhook handler.
 *
 * Usage:
 *   node scripts/test-assignment-email.js          # locally
 *   railway run node scripts/test-assignment-email.js  # via Railway CLI
 *
 * Environment-aware DB path:
 *   If DB_PATH points to an inaccessible directory (e.g. /data when running via
 *   `railway run` without a Volume mount), the script falls back to a local temp DB
 *   at ./data/test-email.db and seeds it with a test supplier + rules automatically.
 */

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

// ── Resolve a writable DB path before any module loads connection.js ──────────

function resolveDbPath() {
  const configured = process.env.DB_PATH || './data/orders.db';
  const dir = path.dirname(path.resolve(configured));

  // Try creating the directory. If it fails (e.g. /data on `railway run`),
  // fall back to a local temp path that we know we can write.
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { dbPath: configured, isFallback: false };
  } catch (err) {
    const fallback = path.resolve('./data/test-email.db');
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    console.log(`[Test] DB_PATH dir "${dir}" is not writable (${err.code}) — using fallback: ${fallback}`);
    return { dbPath: fallback, isFallback: true };
  }
}

const { dbPath, isFallback } = resolveDbPath();
process.env.DB_PATH = dbPath; // must be set before connection.js is required
console.log(`[Test] Using DB: ${dbPath}${isFallback ? ' (fallback)' : ''}`);

// ── Imports (after DB path is locked in) ──────────────────────────────────────

const { createOrder, logActivity } = require('../src/db/orders');
const { getDb }                    = require('../src/db/connection');
const { assignOrderLineItems, getAssignedSupplierIds } = require('../src/services/assignment');
const { notifySuppliers }          = require('../src/services/notifications');

// ── Fake Shopify order payload ─────────────────────────────────────────────────
// Uses real SKUs so existing rules (or the seeded fallback rules) will match.

const fakePayload = {
  id:               9999000001,
  name:             '#TEST-EMAIL-001',
  order_number:     5999,
  email:            'customer@example.com',
  total_price:      '274.00',
  currency:         'USD',
  financial_status: 'paid',
  tags:             '',
  created_at:       new Date().toISOString(),
  customer:         { first_name: 'Test', last_name: 'Customer' },
  shipping_address: {
    first_name: 'Test',
    last_name:  'Customer',
    address1:   '123 Test Street',
    city:       'Test City',
    country:    'US',
  },
  billing_address: {},
  line_items: [
    {
      id:            999001,
      title:         'Ultra HD 4K Projector Pro X200',
      variant_title: 'Black / 4K',
      sku:           'PROJ-X200-BLK-4K',
      vendor:        'Test Vendor',
      product_id:    88881111,
      quantity:      1,
      price:         '249.00',
      price_set:     { shop_money: { amount: '249.00', currency_code: 'USD' } },
    },
    {
      id:            999002,
      title:         'HDMI Cable 3m',
      variant_title: null,
      sku:           'CABLE-HDMI-3M',
      vendor:        'Test Vendor',
      product_id:    88882222,
      quantity:      2,
      price:         '25.00',
      price_set:     { shop_money: { amount: '25.00', currency_code: 'USD' } },
    },
  ],
};

// ── Seed a test supplier + rules if the DB is fresh or empty ──────────────────

function ensureTestSupplier(db) {
  const count = db.prepare('SELECT COUNT(*) as n FROM suppliers').get().n;
  if (count > 0) return; // real data present — don't overwrite

  console.log('[Test] No suppliers found — seeding test supplier and rules for this run');

  // Resolve the supplier email: use SMTP_USER as a safe "to" address, or a
  // hardcoded fallback. This is only used for the email test, not production.
  const testEmail = process.env.SMTP_USER || 'wout.renskers@gmail.com';

  db.prepare(`
    INSERT INTO suppliers (name, email, access_token, active)
    VALUES ('Test Supplier', ?, 'test-token-email-script', 1)
  `).run(testEmail);

  const supplierId = db.prepare('SELECT id FROM suppliers WHERE access_token = ?')
    .get('test-token-email-script').id;

  db.prepare(`
    INSERT INTO assignment_rules (rule_type, rule_value, supplier_id, priority, active)
    VALUES ('sku', 'PROJ-X200-BLK-4K', ?, 10, 1)
  `).run(supplierId);

  db.prepare(`
    INSERT INTO assignment_rules (rule_type, rule_value, supplier_id, priority, active)
    VALUES ('sku', 'CABLE-HDMI-3M', ?, 10, 1)
  `).run(supplierId);

  console.log(`[Test] Seeded: Test Supplier <${testEmail}> with 2 SKU rules`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const db = getDb();

  // Verify schema
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  console.log('[Test] Tables:', tables.join(', '));

  if (!tables.includes('suppliers') || !tables.includes('assignment_rules')) {
    console.error('[Test] ERROR: required tables missing — schema migration may not have run');
    process.exit(1);
  }

  // Seed if this is a fresh/fallback DB
  ensureTestSupplier(db);

  // Report state
  const suppliers = db.prepare('SELECT id, name, email, active FROM suppliers WHERE active = 1').all();
  const rules     = db.prepare('SELECT rule_type, rule_value, supplier_id FROM assignment_rules WHERE active = 1').all();

  console.log(`\n[Test] Active suppliers: ${suppliers.length}`);
  suppliers.forEach(s => console.log(`  → ${s.name} <${s.email}>`));
  console.log(`[Test] Active rules: ${rules.length}`);
  rules.forEach(r => console.log(`  → ${r.rule_type} = "${r.rule_value}"`));

  if (!suppliers.length || !rules.length) {
    console.warn('[Test] WARNING: no active suppliers or rules — assignments will be unassigned and no email will send');
  }

  // Clean up any previous test order so the script is idempotent
  const existing = db.prepare('SELECT id FROM orders WHERE shopify_order_id = ?').get(String(fakePayload.id));
  if (existing) {
    db.prepare('DELETE FROM line_item_assignments WHERE order_id = ?').run(existing.id);
    db.prepare('DELETE FROM activity_log WHERE order_id = ?').run(existing.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(existing.id);
    console.log(`\n[Test] Cleaned up previous test order (id=${existing.id})`);
  }

  // Insert test order
  const lineItems = fakePayload.line_items.map(item => ({
    id:         item.id,
    title:      item.title,
    variant:    item.variant_title   || null,
    sku:        item.sku             || null,
    vendor:     item.vendor          || null,
    product_id: item.product_id ? String(item.product_id) : null,
    quantity:   item.quantity,
  }));

  const result  = createOrder({
    shopify_order_id:   String(fakePayload.id),
    shopify_order_num:  fakePayload.name,
    customer_name:      'Test Customer',
    customer_email:     fakePayload.email,
    customer_phone:     null,
    shipping_address:   JSON.stringify(fakePayload.shipping_address),
    line_items:         JSON.stringify(lineItems),
    total_price:        fakePayload.total_price,
    currency:           fakePayload.currency,
    financial_status:   fakePayload.financial_status,
    raw_payload:        JSON.stringify(fakePayload),
    shopify_created_at: fakePayload.created_at,
  });

  const orderId = result.lastInsertRowid;
  logActivity(orderId, 'order_received', `Test order ${fakePayload.name} created by test script`);
  console.log(`\n[Test] Inserted test order: ${fakePayload.name} (DB id=${orderId})`);

  // Run assignment engine
  const orderTags   = (fakePayload.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const order       = { id: orderId, shopify_order_id: String(fakePayload.id) };
  const assignments = assignOrderLineItems(order, fakePayload.line_items, orderTags);

  const assigned   = assignments.filter(a => a.supplierId);
  const unassigned = assignments.filter(a => !a.supplierId);

  console.log(`\n[Test] Assignment results:`);
  console.log(`  Assigned:   ${assigned.length}`);
  console.log(`  Unassigned: ${unassigned.length}`);
  assigned.forEach(a => console.log(`  → line item ${a.lineItemId} → supplier ${a.supplierId} via rule ${a.ruleId}`));
  unassigned.forEach(a => console.log(`  ✗ line item ${a.lineItemId} → UNASSIGNED (no rule matched)`));

  logActivity(orderId, 'assignment', `Test script: ${assigned.length}/${assignments.length} item(s) assigned`);

  // Send email notifications — always attempt even if SMTP_HOST is unset,
  // so the [email] log lines always appear and confirm the notification path.
  const supplierIds = getAssignedSupplierIds(assignments);
  if (!supplierIds.length) {
    console.log('\n[Test] No suppliers to notify (all items unassigned).');
    return;
  }

  console.log(`\n[Test] Calling notifySuppliers for supplier IDs: ${supplierIds.join(', ')}`);
  await notifySuppliers(supplierIds);
  console.log('\n[Test] Done.');
}

run().catch(err => {
  console.error('[Test] Fatal error:', err);
  process.exit(1);
});
