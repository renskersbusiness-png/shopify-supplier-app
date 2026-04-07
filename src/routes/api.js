/**
 * routes/api.js
 * REST API endpoints consumed by the dashboard frontend.
 * All routes require authentication.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const db = require('../db/orders');
const { createFulfillment } = require('../shopify/client');

// All API routes require login
router.use(requireAuth);

// ── GET /api/orders — list orders with optional filters ───────────────────────

router.get('/orders', (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit  = 25;
    const offset = (parseInt(page) - 1) * limit;

    const { orders, total } = db.getAllOrders({ status, search, limit, offset });

    // Parse JSON fields before sending to client
    const parsed = orders.map(parseOrderFields);

    res.json({
      orders: parsed,
      total,
      page:  parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[API] GET /orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ── GET /api/orders/:id — single order detail ─────────────────────────────────

router.get('/orders/:id', (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const log = db.getActivityLog(order.id);
    res.json({ order: parseOrderFields(order), log });
  } catch (err) {
    console.error('[API] GET /orders/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ── GET /api/stats — dashboard summary stats ──────────────────────────────────

router.get('/stats', (req, res) => {
  try {
    res.json(db.getStats());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── PATCH /api/orders/:id/status — update order status ───────────────────────

router.patch('/orders/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'processing', 'shipped', 'fulfilled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${validStatuses.join(', ')}` });
    }

    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    db.updateOrderStatus(order.id, status);
    db.logActivity(order.id, 'status_change', `Status changed to "${status}"`);

    res.json({ success: true, status });
  } catch (err) {
    console.error('[API] PATCH status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ── PATCH /api/orders/:id/tracking — add tracking info ───────────────────────

router.patch('/orders/:id/tracking', (req, res) => {
  try {
    const { tracking_number, tracking_carrier, tracking_url } = req.body;

    if (!tracking_number || !tracking_carrier) {
      return res.status(400).json({ error: 'tracking_number and tracking_carrier are required' });
    }

    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    db.updateTracking(order.id, { tracking_number, tracking_carrier, tracking_url });
    db.logActivity(
      order.id,
      'tracking_added',
      `Tracking added: ${tracking_carrier} — ${tracking_number}`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[API] PATCH tracking error:', err);
    res.status(500).json({ error: 'Failed to update tracking' });
  }
});

// ── POST /api/orders/:id/fulfill — push fulfillment to Shopify ───────────────

router.post('/orders/:id/fulfill', async (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (!order.tracking_number || !order.tracking_carrier) {
      return res.status(400).json({
        error: 'Please add tracking number and carrier before fulfilling'
      });
    }

    if (order.status === 'fulfilled') {
      return res.status(400).json({ error: 'Order is already fulfilled' });
    }

    console.log(`[Fulfill] Creating fulfillment for order ${order.shopify_order_num}...`);

    // Call Shopify API to create fulfillment + send tracking email to customer
    const fulfillment = await createFulfillment({
      shopifyOrderId:  order.shopify_order_id,
      trackingNumber:  order.tracking_number,
      trackingCarrier: order.tracking_carrier,
      trackingUrl:     order.tracking_url,
    });

    // Extract Shopify fulfillment ID from global ID (gid://shopify/Fulfillment/123)
    const fulfillmentId = fulfillment.id.split('/').pop();

    db.markFulfilled(order.id, fulfillmentId);
    db.logActivity(
      order.id,
      'fulfilled',
      `Fulfilled in Shopify (fulfillment ID: ${fulfillmentId}). Customer notified.`
    );

    console.log(`[Fulfill] ✅  Order ${order.shopify_order_num} fulfilled successfully`);

    res.json({
      success: true,
      fulfillment_id: fulfillmentId,
      message: 'Order fulfilled and customer notified',
    });
  } catch (err) {
    console.error('[API] POST fulfill error:', err);
    res.status(500).json({ error: err.message || 'Failed to fulfill order' });
  }
});

// ── PATCH /api/orders/:id/notes — save internal notes ────────────────────────

router.patch('/orders/:id/notes', (req, res) => {
  try {
    const { notes } = req.body;
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    db.updateNotes(order.id, notes || '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────

function parseOrderFields(order) {
  return {
    ...order,
    shipping_address: safeParseJSON(order.shipping_address),
    line_items:       safeParseJSON(order.line_items),
    // Don't send raw_payload to frontend (can be large)
    raw_payload: undefined,
  };
}

function safeParseJSON(str) {
  try {
    return JSON.parse(str || 'null');
  } catch {
    return null;
  }
}

module.exports = router;
