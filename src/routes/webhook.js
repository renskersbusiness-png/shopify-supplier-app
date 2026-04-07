/**
 * routes/webhook.js
 * Handles incoming Shopify webhooks.
 *
 * IMPORTANT: This route must receive the RAW request body (not parsed JSON)
 * so we can verify the HMAC signature. Express raw body parsing is configured
 * in server.js specifically for this route.
 */

const crypto = require('crypto');
const express = require('express');
const router  = express.Router();

const { createOrder, getOrderByShopifyId, logActivity } = require('../db/orders');

// ── HMAC Verification Middleware ──────────────────────────────────────────────

function verifyShopifyWebhook(req, res, next) {
  // ── Debug logging (remove once webhook verification is confirmed working) ──
  console.log('[Webhook] rawBody exists:', !!req.rawBody);
  console.log('[Webhook] rawBody length:', req.rawBody ? req.rawBody.length : 0);

  const hmacHeader = (req.headers['x-shopify-hmac-sha256'] || '').trim();
  console.log('[Webhook] Received HMAC header:', hmacHeader || '(missing)');

  if (!hmacHeader) {
    console.warn('[Webhook] Missing HMAC header — rejecting request');
    return res.status(401).json({ error: 'Missing HMAC header' });
  }

  // Dev Dashboard apps: HMAC is signed with SHOPIFY_CLIENT_SECRET
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    console.error('[Webhook] SHOPIFY_CLIENT_SECRET is not set!');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (!req.rawBody) {
    console.error('[Webhook] req.rawBody is undefined — raw body middleware did not run');
    return res.status(500).json({ error: 'Raw body not captured' });
  }

  // Compute HMAC-SHA256 of the exact raw request body, base64-encoded
  const calculated = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody, 'utf8')
    .digest('base64');

  console.log('[Webhook] Calculated HMAC:  ', calculated);

  // Timing-safe comparison — both buffers must be the same length
  try {
    const calcBuf     = Buffer.from(calculated, 'utf8');
    const receivedBuf = Buffer.from(hmacHeader, 'utf8');

    const valid =
      calcBuf.length === receivedBuf.length &&
      crypto.timingSafeEqual(calcBuf, receivedBuf);

    console.log('[Webhook] HMAC valid:', valid);

    if (!valid) {
      console.warn('[Webhook] HMAC mismatch — rejecting request');
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }
  } catch (err) {
    console.warn('[Webhook] HMAC comparison error:', err.message);
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  next();
}

// ── orders/create ─────────────────────────────────────────────────────────────

router.post('/orders/create', verifyShopifyWebhook, (req, res) => {
  // Respond to Shopify immediately (within 5s) to prevent retries
  res.status(200).json({ received: true });

  // Process asynchronously after response
  processNewOrder(req.body).catch(err => {
    console.error('[Webhook] Error processing order:', err);
  });
});

async function processNewOrder(payload) {
  const shopifyOrderId = String(payload.id);

  // Deduplicate — Shopify may send the same webhook more than once
  const existing = getOrderByShopifyId(shopifyOrderId);
  if (existing) {
    console.log(`[Webhook] Order ${shopifyOrderId} already exists — skipping`);
    return;
  }

  const shippingAddress = payload.shipping_address || {};
  const billingAddress  = payload.billing_address  || {};

  // Prefer shipping address, fall back to billing
  const address = Object.keys(shippingAddress).length ? shippingAddress : billingAddress;

  const customer = payload.customer || {};
  const customerName = [
    address.first_name || customer.first_name,
    address.last_name  || customer.last_name,
  ].filter(Boolean).join(' ') || payload.email || 'Unknown';

  // Simplify line items — keep only what we need
  const lineItems = (payload.line_items || []).map(item => ({
    id:         item.id,
    title:      item.title,
    variant:    item.variant_title,
    sku:        item.sku,
    quantity:   item.quantity,
    price:      item.price,
  }));

  const result = createOrder({
    shopify_order_id:  shopifyOrderId,
    shopify_order_num: payload.name || `#${payload.order_number}`,
    customer_name:     customerName,
    customer_email:    payload.email || customer.email || null,
    customer_phone:    address.phone || payload.phone || null,
    shipping_address:  JSON.stringify(address),
    line_items:        JSON.stringify(lineItems),
    total_price:       payload.total_price || '0.00',
    currency:          payload.currency    || 'USD',
    raw_payload:       JSON.stringify(payload),
    shopify_created_at: payload.created_at || null,
  });

  const orderId = result.lastInsertRowid;
  logActivity(orderId, 'order_received', `Order ${payload.name} received from Shopify`);

  console.log(`[Webhook] ✅  New order saved: ${payload.name} (ID: ${orderId})`);
}

// ── Shopify webhook health check ──────────────────────────────────────────────
// Shopify sometimes sends a test ping
router.post('/ping', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ pong: true });
});

module.exports = router;
