/**
 * routes/supplier.js
 * Supplier portal API — only accessible to authenticated suppliers.
 * Suppliers authenticate via /s/:token (see middleware/auth.js), which sets
 * session.role='supplier' and session.supplierId.
 */

const express = require('express');
const router  = express.Router();

const { requireSupplierSession } = require('../middleware/auth');
const asgDb = require('../db/assignments');
const { updateAssignmentTracking, markGroupFulfilled } = require('../db/assignments');
const { getOrderById, logActivity }     = require('../db/orders');
const { createFulfillmentForLineItems } = require('../shopify/client');

// All routes here require a supplier session
router.use(requireSupplierSession);

// Strip pricing fields — suppliers never see prices or order totals
function stripPricing(a) {
  const { price, currency, order_currency, ...rest } = a;
  return rest;
}
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── GET /api/supplier/me ──────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  res.json({
    supplierId:   req.session.supplierId,
    supplierName: req.session.supplierName,
  });
});

// ── GET /api/supplier/assignments — all items assigned to this supplier ───────

router.get('/assignments', (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const supplierId = req.session.supplierId;
    const limit      = 50;
    const offset     = (parseInt(page) - 1) * limit;

    const assignments = asgDb.getAssignmentsBySupplier(supplierId, { status, limit, offset })
      .map(stripPricing);
    const stats = asgDb.getAssignmentStats(supplierId);

    res.json({ assignments, stats, page: parseInt(page) });
  } catch (err) {
    console.error('[Supplier API] GET /assignments error:', err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ── GET /api/supplier/assignments/:id — single assignment detail ──────────────

router.get('/assignments/:id', (req, res) => {
  try {
    const assignment = asgDb.getAssignmentById(req.params.id);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    // Ensure this assignment belongs to this supplier
    if (assignment.supplier_id !== req.session.supplierId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Payment safety: supplier cannot view items from unpaid orders
    if (assignment.order_financial_status !== 'paid') {
      return res.status(403).json({ error: 'Order is not fully paid' });
    }

    res.json({ assignment: stripPricing(assignment) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch assignment' });
  }
});

// ── PATCH /api/supplier/tracking — add tracking for all items in an order ─────
// A supplier submits one tracking number per order (one shipment per supplier per order).

router.patch('/tracking', async (req, res) => {
  try {
    const { order_id, tracking_number, tracking_carrier, tracking_url } = req.body;
    const supplierId = req.session.supplierId;

    if (!order_id || !tracking_number || !tracking_carrier) {
      return res.status(400).json({ error: 'order_id, tracking_number, tracking_carrier are required' });
    }

    // Verify order is paid
    const order = getOrderById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.financial_status !== 'paid') {
      return res.status(403).json({ error: 'Order is not fully paid' });
    }

    // Verify supplier has items in this order
    const allAssignments = asgDb.getAssignmentsBySupplier(supplierId);
    const orderItems = allAssignments.filter(a => a.order_id === parseInt(order_id));
    if (!orderItems.length) {
      return res.status(403).json({ error: 'No items assigned to you for this order' });
    }

    // Update tracking in DB
    console.log(`[tracking] saving for order_id=${order_id} supplier=${supplierId} carrier=${tracking_carrier} number=${tracking_number}`);
    updateAssignmentTracking(order_id, supplierId, { tracking_number, tracking_carrier, tracking_url: tracking_url || null });

    logActivity(order.id, 'tracking_added',
      `Supplier ${supplierId} added tracking: ${tracking_carrier} — ${tracking_number}`);

    console.log(`[tracking] saved successfully for order_id=${order_id} (${orderItems.length} item(s))`);
    res.json({ success: true });
  } catch (err) {
    console.error('[tracking] failed →', err.message, err);
    res.status(500).json({ error: 'Failed to update tracking' });
  }
});

// ── POST /api/supplier/fulfill — push fulfillment to Shopify ─────────────────
// Supplier initiates fulfillment for their items in a specific order.

router.post('/fulfill', async (req, res) => {
  try {
    const { order_id } = req.body;
    const supplierId   = req.session.supplierId;

    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const order = getOrderById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Payment safety
    if (order.financial_status !== 'paid') {
      return res.status(403).json({ error: 'Order is not fully paid' });
    }

    // Get this supplier's items in the order with tracking info added
    const allAssignments = asgDb.getAssignmentsBySupplier(supplierId);
    const orderItems     = allAssignments.filter(
      a => a.order_id === parseInt(order_id) && a.status === 'tracking_added'
    );

    if (!orderItems.length) {
      return res.status(400).json({ error: 'No items with tracking ready to fulfill' });
    }

    const trackingNumber  = orderItems[0].tracking_number;
    const trackingCarrier = orderItems[0].tracking_carrier;
    const trackingUrl     = orderItems[0].tracking_url;

    if (!trackingNumber || !trackingCarrier) {
      return res.status(400).json({ error: 'Please add tracking before fulfilling' });
    }

    const lineItemIds = orderItems.map(a => a.shopify_line_item_id);

    console.log(`[fulfillment] sending to Shopify — order=${order.shopify_order_id} supplier=${supplierId} items=[${lineItemIds.join(',')}] carrier=${trackingCarrier} tracking=${trackingNumber}`);

    let fulfillment;
    try {
      fulfillment = await createFulfillmentForLineItems(
        order.shopify_order_id,
        lineItemIds,
        { trackingNumber, trackingCarrier, trackingUrl }
      );
    } catch (shopifyErr) {
      console.error(`[fulfillment] failed → Shopify error for order=${order.shopify_order_id}:`, shopifyErr.message);
      console.error(`[fulfillment] full Shopify error:`, shopifyErr);
      return res.status(502).json({ error: shopifyErr.message || 'Shopify fulfillment failed' });
    }

    const fulfillmentId = fulfillment.id.split('/').pop();
    markGroupFulfilled(order_id, supplierId, fulfillmentId);

    logActivity(order.id, 'fulfilled',
      `Supplier ${supplierId} fulfilled ${lineItemIds.length} item(s) in Shopify (fulfillment: ${fulfillmentId})`);

    console.log(`[fulfillment] success — fulfillment_id=${fulfillmentId} order=${order.shopify_order_id} supplier=${supplierId}`);
    res.json({ success: true, fulfillment_id: fulfillmentId });
  } catch (err) {
    console.error('[fulfillment] failed → unexpected error:', err.message, err);
    res.status(500).json({ error: err.message || 'Fulfillment failed' });
  }
});

module.exports = router;
