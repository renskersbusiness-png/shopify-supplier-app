/**
 * scripts/test-webhook.js
 * Simulates a Shopify orders/create webhook for local testing.
 * Run with: node scripts/test-webhook.js
 *
 * Requires: .env file with SHOPIFY_CLIENT_SECRET set
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const crypto = require('crypto');
const http   = require('http');

const SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const PORT   = process.env.PORT || 3000;

if (!SECRET) {
  console.error('❌ Set SHOPIFY_CLIENT_SECRET in your .env file first');
  process.exit(1);
}

// Sample Shopify order payload
const payload = JSON.stringify({
  id: Date.now(), // unique ID each run
  name: `#TEST-${Math.floor(Math.random() * 9000) + 1000}`,
  order_number: Math.floor(Math.random() * 9000) + 1000,
  email: 'test.customer@example.com',
  total_price: '299.00',
  currency: 'USD',
  created_at: new Date().toISOString(),
  customer: {
    first_name: 'Test',
    last_name: 'Customer',
    email: 'test.customer@example.com',
  },
  shipping_address: {
    first_name: 'Test',
    last_name:  'Customer',
    address1:   '123 Main Street',
    address2:   'Apt 4B',
    city:       'New York',
    province:   'NY',
    zip:        '10001',
    country:    'United States',
    phone:      '+1 555-555-0123',
  },
  line_items: [
    {
      id:            123456789,
      title:         'Ultra HD 4K Projector Pro X200',
      variant_title: 'Black / 4K',
      sku:           'PROJ-X200-BLK-4K',
      quantity:      1,
      price:         '249.00',
    },
    {
      id:            987654321,
      title:         'HDMI Cable 3m',
      variant_title: null,
      sku:           'CABLE-HDMI-3M',
      quantity:      2,
      price:         '25.00',
    },
  ],
});

// Generate valid HMAC signature
const hmac = crypto
  .createHmac('sha256', SECRET)
  .update(payload, 'utf8')
  .digest('base64');

const options = {
  hostname: 'localhost',
  port:     PORT,
  path:     '/webhooks/orders/create',
  method:   'POST',
  headers:  {
    'Content-Type':               'application/json',
    'Content-Length':             Buffer.byteLength(payload),
    'X-Shopify-Hmac-Sha256':      hmac,
    'X-Shopify-Shop-Domain':      'test-store.myshopify.com',
    'X-Shopify-Topic':            'orders/create',
    'X-Shopify-Webhook-Id':       `test-${Date.now()}`,
  },
};

console.log(`\n🧪 Sending test webhook to http://localhost:${PORT}/webhooks/orders/create`);
console.log(`   HMAC: ${hmac.substring(0, 20)}…\n`);

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('✅ Webhook accepted! Check your dashboard for the new test order.');
    } else {
      console.error(`❌ Webhook rejected — HTTP ${res.statusCode}: ${data}`);
    }
  });
});

req.on('error', (err) => {
  console.error(`❌ Connection error: ${err.message}`);
  console.error('   Is your server running? (npm run dev)');
});

req.write(payload);
req.end();
