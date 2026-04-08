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

const { createOrder, getOrderByShopifyId, updateOrderStatus, updateFinancialStatus, logActivity } = require('../db/orders');
const { assignOrderLineItems, getAssignedSupplierIds } = require('../services/assignment');
const { notifySuppliers } = require('../services/notifications');
const { cancelOrderAssignments, updateFulfillmentTracking } = require('../db/assignments');

// ── HMAC Verification Middleware ──────────────────────────────────────────────

function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = (req.headers['x-shopify-hmac-sha256'] || '').trim();
  if (!hmacHeader) {
    return res.status(401).json({ error: 'Missing HMAC header' });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[Webhook] SHOPIFY_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (!req.rawBody) {
    console.error('[Webhook] req.rawBody is undefined — raw body middleware did not run');
    return res.status(500).json({ error: 'Raw body not captured' });
  }

  const calculated = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody, 'utf8')
    .digest('base64');

  try {
    const calcBuf     = Buffer.from(calculated, 'utf8');
    const receivedBuf = Buffer.from(hmacHeader, 'utf8');
    const valid =
      calcBuf.length === receivedBuf.length &&
      crypto.timingSafeEqual(calcBuf, receivedBuf);
    if (!valid) {
      console.warn('[Webhook] HMAC mismatch — rejecting');
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }
  } catch (err) {
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

  // Simplify line items for storage. Keep vendor + product_id so the admin
  // "Re-assign items" endpoint can re-run the rule engine against the DB copy.
  const lineItems = (payload.line_items || []).map(item => ({
    id:         item.id,
    title:      item.title,
    variant:    item.variant_title   || null,
    sku:        item.sku             || null,
    vendor:     item.vendor          || null,
    product_id: item.product_id ? String(item.product_id) : null,
    quantity:   item.quantity,
  }));

  const result = createOrder({
    shopify_order_id:  shopifyOrderId,
    shopify_order_num: payload.name || `#${payload.order_number}`,
    customer_name:     customerName,
    customer_email:    payload.email || customer.email || null,
    customer_phone:    address.phone || payload.phone || null,
    shipping_address:  JSON.stringify(address),
    line_items:        JSON.stringify(lineItems),
    total_price:       payload.total_price    || '0.00',
    currency:          payload.currency       || 'USD',
    financial_status:  payload.financial_status || 'pending',
    raw_payload:       JSON.stringify(payload),
    shopify_created_at: payload.created_at   || null,
  });

  const orderId = result.lastInsertRowid;
  logActivity(orderId, 'order_received', `Order ${payload.name} received from Shopify`);
  console.log(`[Webhook] New order saved: ${payload.name} (ID: ${orderId})`);

  // ── Run assignment engine ─────────────────────────────────────────────────
  // Parse order tags (comma-separated string in Shopify payload)
  const orderTags = (payload.tags || '').split(',').map(t => t.trim()).filter(Boolean);

  try {
    const order       = { id: orderId, shopify_order_id: shopifyOrderId };
    const assignments = assignOrderLineItems(order, payload.line_items || [], orderTags);
    const assigned    = assignments.filter(a => a.supplierId);

    logActivity(orderId, 'assignment',
      `${assigned.length}/${assignments.length} line item(s) auto-assigned`);

    // Notify each affected supplier of their new items
    const supplierIds = getAssignedSupplierIds(assignments);
    if (supplierIds.length) {
      notifySuppliers(supplierIds).catch(err =>
        console.error('[Webhook] Notification error:', err.message)
      );
    }
  } catch (err) {
    console.error('[Webhook] Assignment engine error:', err.message);
  }
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
  updateFinancialStatus(order.id, 'paid');
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
  // Use financial_status (from Shopify) as the authoritative payment signal.
  if (order.financial_status === 'pending') {
    console.log(
      `[Webhook] fulfillments/create: order ${order.shopify_order_num} is still unpaid (financial_status=pending) — skipping`
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

// ── orders/updated ────────────────────────────────────────────────────────────
// Fired by Shopify whenever an order is modified (payment, line items, etc.).
// We use it to track financial_status changes, specifically to catch partial
// payments (partially_paid) which have no dedicated webhook topic.

router.post('/orders/updated', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ received: true });

  const shopifyOrderId  = String(req.body.id);
  const financialStatus = req.body.financial_status;

  if (!financialStatus) return; // nothing payment-related changed

  const order = getOrderByShopifyId(shopifyOrderId);
  if (!order) {
    console.log(`[Webhook] orders/updated: order ${shopifyOrderId} not in DB — skipping`);
    return;
  }

  // Always sync the latest financial_status from Shopify
  updateFinancialStatus(order.id, financialStatus);

  // Advance pending → processing for any confirmed or partial payment
  if (order.status === 'pending' && (financialStatus === 'paid' || financialStatus === 'partially_paid' || financialStatus === 'authorized')) {
    updateOrderStatus(order.id, 'processing');
    logActivity(
      order.id,
      'status_change',
      `Status set to "processing" (financial_status: ${financialStatus})`
    );
    console.log(`[Webhook] orders/updated: ${order.shopify_order_num} → processing (${financialStatus})`);
    return;
  }

  // For refunded/voided: log it but don't change workflow status
  if (financialStatus === 'refunded' || financialStatus === 'voided') {
    logActivity(order.id, 'status_change', `Payment ${financialStatus} — order hidden from supplier`);
    console.log(`[Webhook] orders/updated: ${order.shopify_order_num} financial_status → ${financialStatus}`);
  }
});

// ── orders/cancelled ──────────────────────────────────────────────────────────
// Fired by Shopify when an order is cancelled (by merchant or customer).
// Marks the order as cancelled and cancels all non-fulfilled assignments so
// suppliers cannot continue processing items for a cancelled order.

router.post('/orders/cancelled', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ received: true });

  const shopifyOrderId = String(req.body.id);
  const orderNum       = req.body.name || shopifyOrderId;

  console.log(`[Webhook] orders/cancelled received: ${orderNum} (shopify_id=${shopifyOrderId})`);

  const order = getOrderByShopifyId(shopifyOrderId);

  if (!order) {
    console.log(`[Webhook] orders/cancelled: ${orderNum} not found in DB — skipping`);
    return;
  }

  if (order.status === 'cancelled') {
    console.log(`[Webhook] orders/cancelled: ${orderNum} already cancelled — skipping`);
    return;
  }

  // Mark order cancelled
  updateOrderStatus(order.id, 'cancelled');

  // Sync financial_status if Shopify sends one (usually 'refunded' or 'voided')
  const financialStatus = req.body.financial_status;
  if (financialStatus && financialStatus !== order.financial_status) {
    updateFinancialStatus(order.id, financialStatus);
    console.log(`[Webhook] orders/cancelled: ${orderNum} financial_status → ${financialStatus}`);
  }

  // Cancel all open assignments — fulfilled ones stay as-is (shipment already sent)
  const result = cancelOrderAssignments(order.id);
  const cancelledCount = result.changes;

  logActivity(
    order.id,
    'order_cancelled',
    `Order cancelled by Shopify. ${cancelledCount} assignment(s) cancelled.`
  );

  console.log(`[Webhook] order cancelled: ${orderNum} — ${cancelledCount} assignment(s) cancelled`);
});

// ── fulfillments/update ───────────────────────────────────────────────────────
// Fired by Shopify when a fulfillment's status or tracking info changes.
// Common causes: carrier scans update the fulfillment to 'success', tracking
// number is edited in Shopify admin, or a fulfillment is cancelled.
//
// We sync tracking info to the DB so the supplier portal always reflects the
// latest data, and we advance the order to 'fulfilled' on a 'success' status.

router.post('/fulfillments/update', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ received: true });

  const shopifyOrderId    = String(req.body.order_id);
  const shopifyFulfillId  = String(req.body.id);
  const fulfillmentStatus = (req.body.status || '').toLowerCase(); // success | failure | error | cancelled | pending

  console.log(`[Webhook] fulfillments/update received: fulfillment=${shopifyFulfillId} order=${shopifyOrderId} status=${fulfillmentStatus}`);

  const order = getOrderByShopifyId(shopifyOrderId);

  if (!order) {
    console.log(`[Webhook] fulfillments/update: order ${shopifyOrderId} not in DB — skipping`);
    return;
  }

  const orderNum = order.shopify_order_num;

  // ── Sync tracking info ────────────────────────────────────────────────────
  // Shopify may provide tracking_number / tracking_numbers (array) and
  // tracking_url / tracking_urls. Prefer the singular field; fall back to the
  // first element of the array for carriers that provide multiple numbers.
  const trackingNumber  = req.body.tracking_number
    || (req.body.tracking_numbers  || [])[0]
    || null;
  const trackingUrl     = req.body.tracking_url
    || (req.body.tracking_urls     || [])[0]
    || null;
  const trackingCarrier = req.body.tracking_company || null;

  if (trackingNumber || trackingCarrier || trackingUrl) {
    updateFulfillmentTracking(shopifyFulfillId, {
      tracking_number:  trackingNumber,
      tracking_carrier: trackingCarrier,
      tracking_url:     trackingUrl,
    });
    console.log(`[Webhook] fulfillments/update: tracking synced for fulfillment=${shopifyFulfillId} (${trackingCarrier} ${trackingNumber})`);
  }

  // ── Status transitions ────────────────────────────────────────────────────

  if (fulfillmentStatus === 'success') {
    // All items in this fulfillment are now delivered / confirmed shipped.
    // Advance the order to 'fulfilled' if not already there.
    if (order.status !== 'fulfilled') {
      updateOrderStatus(order.id, 'fulfilled');
      logActivity(
        order.id,
        'status_change',
        `Status set to "fulfilled" (Shopify fulfillment ${shopifyFulfillId} succeeded)`
      );
      console.log(`[Webhook] fulfillment updated: order ${orderNum} → fulfilled`);
    } else {
      console.log(`[Webhook] fulfillments/update: ${orderNum} already fulfilled — status unchanged`);
    }

  } else if (fulfillmentStatus === 'cancelled') {
    // A fulfillment was voided in Shopify admin. Revert the order to 'processing'
    // so it can be re-fulfilled. Only revert if currently shipped or fulfilled —
    // never downgrade past processing.
    if (order.status === 'shipped' || order.status === 'fulfilled') {
      updateOrderStatus(order.id, 'processing');
      logActivity(
        order.id,
        'status_change',
        `Shopify fulfillment ${shopifyFulfillId} was cancelled — order reverted to "processing"`
      );
      console.log(`[Webhook] fulfillments/update: ${orderNum} fulfillment cancelled → order reverted to processing`);
    } else {
      console.log(`[Webhook] fulfillments/update: fulfillment ${shopifyFulfillId} cancelled, order already at '${order.status}' — no change`);
    }
    logActivity(
      order.id,
      'fulfillment_cancelled',
      `Shopify fulfillment ${shopifyFulfillId} cancelled`
    );

  } else if (fulfillmentStatus === 'failure' || fulfillmentStatus === 'error') {
    // Carrier returned an error or the fulfillment failed. Log it but don't
    // change status automatically — a human should review before re-fulfilling.
    logActivity(
      order.id,
      'fulfillment_error',
      `Shopify fulfillment ${shopifyFulfillId} reported status: ${fulfillmentStatus}`
    );
    console.log(`[Webhook] fulfillments/update: ${orderNum} fulfillment ${shopifyFulfillId} → ${fulfillmentStatus} (logged, no automatic status change)`);

  } else {
    // pending or unknown — just log, no DB change
    console.log(`[Webhook] fulfillments/update: ${orderNum} fulfillment ${shopifyFulfillId} → ${fulfillmentStatus} (no action needed)`);
  }

  console.log(`[Webhook] fulfillment updated: order ${orderNum}`);
});

// ── Shopify webhook health check ──────────────────────────────────────────────
// Shopify sometimes sends a test ping
router.post('/ping', verifyShopifyWebhook, (req, res) => {
  res.status(200).json({ pong: true });
});

module.exports = router;
