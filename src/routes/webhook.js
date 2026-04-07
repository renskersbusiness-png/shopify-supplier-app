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

const { createOrder, getOrderByShopifyId, updateOrderStatus, logActivity } = require('../db/orders');

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

  // Admin-created webhooks (Settings → Notifications → Webhooks) are signed
  // with the webhook signing secret shown on that page, NOT the app client secret.
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  console.log('[Webhook] SHOPIFY_WEBHOOK_SECRET exists:', !!secret);
  if (!secret) {
    console.error('[Webhook] SHOPIFY_WEBHOOK_SECRET is not set!');
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

// ── orders/paid ───────────────────────────────────────────────────────────────
// Fired by Shopify when payment is captured.
// Moves the order from 'pending' → 'processing'.
// Does nothing if the order is already further along (shipped/fulfilled).

router.post('/orders/paid', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ received: true });

  const shopifyOrderId  = String(req.body.id);
  const financialStatus = req.body.financial_status;

  // Verify the payload itself confirms payment — the webhook name alone is not
  // a guarantee (e.g. partial payments, refunds, or test payloads can fire it).
  if (financialStatus !== 'paid') {
    console.log(
      `[Webhook] orders/paid: order ${shopifyOrderId} financial_status="${financialStatus}" — not confirmed paid, skipping`
    );
    return;
  }

  const order = getOrderByShopifyId(shopifyOrderId);

  if (!order) {
    console.log(`[Webhook] orders/paid: order ${shopifyOrderId} not found in DB — skipping`);
    return;
  }

  // Only advance from pending → processing; never go backwards
  if (order.status !== 'pending') {
    console.log(`[Webhook] orders/paid: order ${order.shopify_order_num} already at '${order.status}' — skipping`);
    return;
  }

  updateOrderStatus(order.id, 'processing');
  logActivity(order.id, 'status_change', 'Status set to "processing" (payment confirmed by Shopify)');
  console.log(`[Webhook] orders/paid: ${order.shopify_order_num} → processing ✓`);
});

// ── fulfillments/create ───────────────────────────────────────────────────────
// Fired by Shopify when a fulfillment is created (from any source).
// Moves the order to 'shipped' unless it is already 'fulfilled'.
// Also stores the Shopify fulfillment ID if not already set.

router.post('/fulfillments/create', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ received: true });

  // Fulfillment payload uses order_id (not id) for the parent order
  const shopifyOrderId = String(req.body.order_id);
  const order = getOrderByShopifyId(shopifyOrderId);

  if (!order) {
    console.log(`[Webhook] fulfillments/create: order ${shopifyOrderId} not found in DB — skipping`);
    return;
  }

  // Block if the order has not been confirmed as paid yet.
  // pending = awaiting payment; only process confirmed-paid orders.
  if (order.status === 'pending') {
    console.log(
      `[Webhook] fulfillments/create: order ${order.shopify_order_num} is still pending (unpaid) — skipping`
    );
    return;
  }

  // Never downgrade a fulfilled order
  if (order.status === 'fulfilled') {
    console.log(`[Webhook] fulfillments/create: order ${order.shopify_order_num} already fulfilled — skipping`);
    return;
  }

  updateOrderStatus(order.id, 'shipped');
  logActivity(
    order.id,
    'status_change',
    `Status set to "shipped" (Shopify fulfillment ${req.body.id} created)`
  );
  console.log(`[Webhook] fulfillments/create: ${order.shopify_order_num} → shipped`);
});

// ── Shopify webhook health check ──────────────────────────────────────────────
// Shopify sometimes sends a test ping
router.post('/ping', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ pong: true });
});

module.exports = router;
