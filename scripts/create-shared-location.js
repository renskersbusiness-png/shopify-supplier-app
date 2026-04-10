/**
 * scripts/create-shared-location.js
 * One-time setup: creates a single shared Shopify Fulfillment Service
 * (and its auto-linked Location) for use by all suppliers.
 *
 * Run once: node scripts/create-shared-location.js
 *
 * After running, copy the SHOPIFY_LOCATION_ID value into your Railway
 * environment variables and redeploy.
 */

require('dotenv').config();

const { createFulfillmentService } = require('../src/shopify/client');

const SERVICE_NAME = 'Zoomly Supplier Fulfillment';

(async () => {
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!domain || !process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
    console.error('❌  Missing required env vars: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET');
    process.exit(1);
  }

  console.log(`\nCreating shared fulfillment service on ${domain}…\n`);

  try {
    const { serviceId, locationId, name } = await createFulfillmentService(SERVICE_NAME);

    console.log('✅  Fulfillment service created successfully.\n');
    console.log('─────────────────────────────────────────────');
    console.log(`  Service name  : ${name}`);
    console.log(`  Service ID    : ${serviceId}`);
    console.log(`  Location ID   : ${locationId}`);
    console.log('─────────────────────────────────────────────');
    console.log('\n📋  Next step — set this in Railway env vars:\n');
    console.log(`  SHOPIFY_LOCATION_ID=${locationId}\n`);
    console.log('Then redeploy. All supplier inventory syncs will use this location.\n');
  } catch (err) {
    console.error('❌  Failed to create fulfillment service:', err.message);
    process.exit(1);
  }
})();
