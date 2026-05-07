/**
 * scripts/manual-fulfill-batch.js
 *
 * One-off script: fulfill specific Shopify orders for SKU 08720892501769
 * with the tracking numbers below. Used because the supplier couldn't add
 * them via the portal in time.
 *
 * Run on Railway so it picks up prod env vars:
 *   railway run node scripts/manual-fulfill-batch.js
 *
 * Safe to re-run: orders that are already fulfilled will skip cleanly.
 */

require('dotenv').config();

const fetch = require('node-fetch');
const { createFulfillmentForLineItems } = require('../src/shopify/client');
const { getAccessToken } = require('../src/shopify/auth');

const SKU = '08720892501769';

const FULFILLMENTS = [
  { name: 'Zoomly-1809', tracking: 'FF604300000049499', carrier: 'Other' },
  { name: 'Zoomly-1815', tracking: 'FF605050000051450', carrier: 'Other' },
  { name: 'Zoomly-1822', tracking: 'FF605050000051436', carrier: 'Other' },
  { name: 'Zoomly-1824', tracking: 'FF605050000051438', carrier: 'Other' },
  { name: 'Zoomly-1825', tracking: 'FF605050000051439', carrier: 'Other' },
  { name: 'Zoomly-1826', tracking: 'FF605050000051454', carrier: 'Other' },
  { name: 'Zoomly-1829', tracking: 'FF605050000051457', carrier: 'Other' },
  { name: 'Zoomly-1836', tracking: 'FF605060000051893', carrier: 'Other' },
  { name: 'Zoomly-1838', tracking: 'FF605060000051891', carrier: 'Other' },
];

const API_VERSION = '2025-01';

async function findOrderByName(name) {
  const token  = await getAccessToken();
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;
  // Shopify REST allows querying orders by name (e.g. "Zoomly-1793")
  const res = await fetch(
    `https://${domain}/admin/api/${API_VERSION}/orders.json?name=${encodeURIComponent(name)}&status=any&limit=1`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  if (!res.ok) throw new Error(`Order lookup failed (${res.status}): ${await res.text()}`);
  const { orders } = await res.json();
  return orders?.[0] || null;
}

(async () => {
  console.log(`\nManual fulfill batch — SKU ${SKU}\n${'─'.repeat(60)}\n`);

  let success = 0;
  let failed  = 0;

  for (const { name, tracking, carrier } of FULFILLMENTS) {
    try {
      console.log(`→ ${name}  ${carrier} ${tracking}`);

      const order = await findOrderByName(name);
      if (!order) { console.log(`   ✗ order not found`); failed++; continue; }

      const lineItem = (order.line_items || []).find(li => li.sku === SKU);
      if (!lineItem) { console.log(`   ✗ no line item with SKU ${SKU}`); failed++; continue; }

      // Skip if already fully fulfilled
      if (lineItem.fulfillment_status === 'fulfilled') {
        console.log(`   ↷ already fulfilled — skipping`); continue;
      }

      const fulfillment = await createFulfillmentForLineItems(
        String(order.id),
        [String(lineItem.id)],
        { trackingNumber: tracking, trackingCarrier: carrier }
      );

      const fid = fulfillment.id.split('/').pop();
      console.log(`   ✓ fulfilled — fulfillment_id=${fid}`);
      success++;
    } catch (err) {
      console.log(`   ✗ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(60)}\nDone. Success: ${success} · Failed: ${failed}\n`);
  process.exit(failed ? 1 : 0);
})();
