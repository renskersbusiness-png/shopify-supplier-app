#!/usr/bin/env node
/**
 * scripts/test-assignment-email.js
 * Simulates the full order → assignment → email flow without a real Shopify webhook.
 * Uses the same logic as the orders/create webhook handler.
 *
 * Usage:
 *   node scripts/test-assignment-email.js
 *
 * This will:
 *  1. Insert a fake test order into the DB
 *  2. Run the assignment engine (same as webhook)
 *  3. Run notifySuppliers() to send the email
 *  4. Report the results
 */

require('dotenv').config();

const { createOrder, logActivity } = require('../src/db/orders');
const { getDb }                    = require('../src/db/connection');
const { assignOrderLineItems, getAssignedSupplierIds } = require('../src/services/assignment');
const { notifySuppliers }          = require('../src/services/notifications');

// ── Fake Shopify order payload ────────────────────────────────────────────────
// Uses the real SKUs from your existing test order so the rules will match.
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
      id:          999001,
      title:       'Ultra HD 4K Projector Pro X200',
      variant_title: 'Black / 4K',
      sku:         'PROJ-X200-BLK-4K',
      vendor:      'Test Vendor',
      product_id:  88881111,
      quantity:    1,
      price:       '249.00',
      price_set:   { shop_money: { amount: '249.00', currency_code: 'USD' } },
    },
    {
      id:          999002,
      title:       'HDMI Cable 3m',
      variant_title: null,
      sku:         'CABLE-HDMI-3M',
      vendor:      'Test Vendor',
      product_id:  88882222,
      quantity:    2,
      price:       '25.00',
      price_set:   { shop_money: { amount: '25.00', currency_code: 'USD' } },
    },
  ],
};

async function run() {
  const db = getDb();

  // Check DB has the required tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  console.log('[Test] Tables in DB:', tables.join(', '));

  if (!tables.includes('suppliers') || !tables.includes('assignment_rules')) {
    console.error('\n[Test] ERROR: suppliers or assignment_rules table missing.');
    console.error('Run migrations first by starting the app once, or run:');
    console.error('  node -e "require(\'./src/db/connection\').getDb()"');
    process.exit(1);
  }

  // Check suppliers exist
  const suppliers = db.prepare('SELECT id, name, email, access_token FROM suppliers WHERE active = 1').all();
  const rules     = db.prepare('SELECT id, rule_type, rule_value, supplier_id FROM assignment_rules WHERE active = 1').all();
  console.log(`\n[Test] Active suppliers: ${suppliers.length}`);
  suppliers.forEach(s => console.log(`  → ${s.name} <${s.email}>`));
  console.log(`[Test] Active rules: ${rules.length}`);
  rules.forEach(r => console.log(`  → ${r.rule_type} = "${r.rule_value}"`));

  if (!suppliers.length || !rules.length) {
    console.warn('\n[Test] WARNING: No active suppliers or rules. Assignments will be UNASSIGNED.');
  }

  // Remove any previous test order with this name to stay idempotent
  const existing = db.prepare("SELECT id FROM orders WHERE shopify_order_id = ?").get(String(fakePayload.id));
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
  const orderTags  = (fakePayload.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const order      = { id: orderId, shopify_order_id: String(fakePayload.id) };
  const assignments = assignOrderLineItems(order, fakePayload.line_items, orderTags);

  const assigned   = assignments.filter(a => a.supplierId);
  const unassigned = assignments.filter(a => !a.supplierId);

  console.log(`\n[Test] Assignment results:`);
  console.log(`  Assigned:   ${assigned.length}`);
  console.log(`  Unassigned: ${unassigned.length}`);
  assigned.forEach(a => console.log(`  → line item ${a.lineItemId} → supplier ${a.supplierId} via rule ${a.ruleId}`));
  unassigned.forEach(a => console.log(`  ✗ line item ${a.lineItemId} → UNASSIGNED (no rule matched)`));

  logActivity(orderId, 'assignment', `Test script: ${assigned.length}/${assignments.length} item(s) assigned`);

  // Send email notifications
  const supplierIds = getAssignedSupplierIds(assignments);
  if (!supplierIds.length) {
    console.log('\n[Test] No suppliers to notify (all items unassigned).');
    return;
  }

  if (!process.env.SMTP_HOST) {
    console.log('\n[Test] SMTP_HOST not set — skipping email send.');
    console.log('  Set SMTP_HOST in .env to test real email delivery.');
    return;
  }

  console.log(`\n[Test] Sending notifications to suppliers: ${supplierIds.join(', ')}`);
  try {
    await notifySuppliers(supplierIds);
    console.log('\n[Test] ✅  Email send complete. Check wout.renskers@gmail.com.');
  } catch (err) {
    console.error('\n[Test] ✗  Email failed:', err.message);
  }
}

run().catch(err => {
  console.error('[Test] Fatal error:', err);
  process.exit(1);
});
