/**
 * routes/api.js
 * Admin REST API — orders, suppliers, assignment rules, and assignments.
 * All routes require authentication. Admin-only routes are gated with role check.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const db      = require('../db/orders');
const suppDb  = require('../db/suppliers');
const asgDb   = require('../db/assignments');
const { reassignLineItem }             = require('../services/assignment');
const { notifySupplier }               = require('../services/notifications');
const { createFulfillmentForLineItems, fetchOrderFromShopify } = require('../shopify/client');

// ── Global middleware ─────────────────────────────────────────────────────────

router.use(requireAuth);
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminOnly(req, res, next) {
  if (req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin only' });
}

function parseOrderFields(order) {
  return {
    ...order,
    shipping_address: safeJSON(order.shipping_address),
    line_items:       safeJSON(order.line_items),
    raw_payload:      undefined,
  };
}

function safeJSON(str) {
  try { return JSON.parse(str || 'null'); } catch { return null; }
}

// ── GET /api/me ───────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  res.json({
    role:         req.session.role || null,
    supplierId:   req.session.supplierId   || null,
    supplierName: req.session.supplierName || null,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ══════════════════════════════════════════════════════════════════════════════

router.get('/orders', (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit  = 25;
    const offset = (parseInt(page) - 1) * limit;
    const { orders, total } = db.getAllOrders({ status, search, limit, offset, supplierOnly: false });
    res.json({
      orders: orders.map(parseOrderFields),
      total,
      page:  parseInt(page),
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[API] GET /orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/orders/:id', (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const log         = db.getActivityLog(order.id);
    const assignments = asgDb.getAssignmentsByOrder(order.id);
    res.json({ order: parseOrderFields(order), log, assignments });
  } catch (err) {
    console.error('[API] GET /orders/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Force-refresh a single order from Shopify
router.post('/orders/:id/sync', adminOnly, async (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const shopifyOrder = await fetchOrderFromShopify(order.shopify_order_id);
    if (!shopifyOrder) return res.status(404).json({ error: 'Order not found in Shopify' });

    const shopifyFinancial = shopifyOrder.financial_status || 'pending';
    const changes = [];

    if (order.financial_status !== shopifyFinancial) {
      db.updateFinancialStatus(order.id, shopifyFinancial);
      changes.push(`financial_status: ${order.financial_status} → ${shopifyFinancial}`);
    }

    if (order.status === 'pending' &&
        (shopifyFinancial === 'paid' || shopifyFinancial === 'partially_paid' || shopifyFinancial === 'authorized')) {
      db.updateOrderStatus(order.id, 'processing');
      db.logActivity(order.id, 'status_change',
        `Status set to "processing" via manual sync (Shopify financial_status: ${shopifyFinancial})`);
      changes.push('status: pending → processing');
    }

    res.json({ success: true, shopify_financial_status: shopifyFinancial, changes });
  } catch (err) {
    console.error('[API] POST /orders/:id/sync error:', err);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

router.get('/stats', adminOnly, (req, res) => {
  try {
    res.json({
      orders:      db.getStats({ supplierOnly: false }),
      assignments: asgDb.getAllAssignmentStats(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.patch('/orders/:id/status', adminOnly, (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['pending', 'processing', 'shipped', 'fulfilled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be: ${valid.join(', ')}` });
    }
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'fulfilled') {
      return res.status(400).json({ error: 'Cannot change status of a fulfilled order' });
    }
    db.updateOrderStatus(order.id, status);
    db.logActivity(order.id, 'status_change', `Status changed to "${status}"`);
    res.json({ success: true, status });
  } catch (err) {
    console.error('[API] PATCH status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

router.patch('/orders/:id/notes', adminOnly, (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    db.updateNotes(order.id, req.body.notes || '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save notes' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPPLIERS  (admin only)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/suppliers', adminOnly, (req, res) => {
  try {
    res.json({ suppliers: suppDb.getAllSuppliers() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

router.post('/suppliers', adminOnly, (req, res) => {
  try {
    const { name, email, notes } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
    const result   = suppDb.createSupplier({ name, email, notes });
    const supplier = suppDb.getSupplierById(result.lastInsertRowid);
    res.status(201).json({ supplier });
  } catch (err) {
    console.error('[API] POST /suppliers error:', err);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

router.get('/suppliers/:id', adminOnly, (req, res) => {
  const supplier = suppDb.getSupplierById(req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
  const stats = asgDb.getAssignmentStats(supplier.id);
  res.json({ supplier, stats });
});

router.put('/suppliers/:id', adminOnly, (req, res) => {
  try {
    const { name, email, notes, active } = req.body;
    suppDb.updateSupplier(req.params.id, { name, email, notes, active });
    const supplier = suppDb.getSupplierById(req.params.id);
    res.json({ supplier });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

router.post('/suppliers/:id/rotate-token', adminOnly, (req, res) => {
  try {
    const supplier = suppDb.getSupplierById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    const token = suppDb.rotateToken(req.params.id);
    res.json({ access_token: token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate token' });
  }
});

router.delete('/suppliers/:id', adminOnly, (req, res) => {
  try {
    suppDb.deleteSupplier(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ASSIGNMENT RULES  (admin only)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/rules', adminOnly, (req, res) => {
  try {
    res.json({ rules: asgDb.getAllRules() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

router.post('/rules', adminOnly, (req, res) => {
  try {
    const { rule_type, rule_value, supplier_id, priority } = req.body;
    const validTypes = ['sku', 'vendor', 'product_id', 'order_tag'];
    if (!rule_type || !rule_value || !supplier_id) {
      return res.status(400).json({ error: 'rule_type, rule_value, supplier_id are required' });
    }
    if (!validTypes.includes(rule_type)) {
      return res.status(400).json({ error: `rule_type must be one of: ${validTypes.join(', ')}` });
    }
    const result = asgDb.createRule({ rule_type, rule_value, supplier_id, priority });
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error('[API] POST /rules error:', err);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

router.put('/rules/:id', adminOnly, (req, res) => {
  try {
    const { rule_type, rule_value, supplier_id, priority, active } = req.body;
    asgDb.updateRule(req.params.id, { rule_type, rule_value, supplier_id, priority, active });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

router.delete('/rules/:id', adminOnly, (req, res) => {
  try {
    asgDb.deleteRule(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LINE ITEM ASSIGNMENTS  (admin only)
// ══════════════════════════════════════════════════════════════════════════════

router.get('/assignments', adminOnly, (req, res) => {
  try {
    const { supplierId, status, orderId, page = 1 } = req.query;
    const limit  = 50;
    const offset = (parseInt(page) - 1) * limit;
    const { assignments, total } = asgDb.getAllAssignments({
      supplierId: supplierId ? parseInt(supplierId) : undefined,
      status,
      orderId: orderId ? parseInt(orderId) : undefined,
      limit,
      offset,
    });
    res.json({ assignments, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[API] GET /assignments error:', err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Admin manual override: reassign a line item to a different supplier (or unassign)
router.patch('/assignments/:id', adminOnly, async (req, res) => {
  try {
    const { supplier_id } = req.body;
    const assignment = asgDb.getAssignmentById(req.params.id);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    reassignLineItem(req.params.id, supplier_id || null, null);

    // Notify the new supplier if one was set
    if (supplier_id) {
      notifySupplier(supplier_id).catch(err =>
        console.error('[API] Notification error:', err.message)
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[API] PATCH /assignments/:id error:', err);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// Trigger assignment engine for a specific order (admin — for orders that arrived before rules were set)
router.post('/orders/:id/assign', adminOnly, (req, res) => {
  try {
    const order = db.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { assignOrderLineItems, getAssignedSupplierIds } = require('../services/assignment');
    const { notifySuppliers } = require('../services/notifications');

    // Use the stored line_items JSON as a proxy for line items
    const lineItems = safeJSON(order.line_items) || [];
    // Convert simplified format back to Shopify-like shape for the engine
    const shopifyItems = lineItems.map(li => ({
      id:            li.id,
      title:         li.title,
      variant_title: li.variant || null,
      sku:           li.sku    || null,
      vendor:        li.vendor || null,
      product_id:    li.product_id || null,
      quantity:      li.quantity,
      price:         li.price  || null,
    }));

    const assignments  = assignOrderLineItems(order, shopifyItems);
    const supplierIds  = getAssignedSupplierIds(assignments);
    notifySuppliers(supplierIds).catch(() => {});

    const assigned   = assignments.filter(a => a.supplierId).length;
    const unassigned = assignments.filter(a => !a.supplierId).length;
    db.logActivity(order.id, 'assignment', `Manual re-assign: ${assigned} assigned, ${unassigned} unassigned`);

    res.json({ success: true, assigned, unassigned, total: assignments.length });
  } catch (err) {
    console.error('[API] POST /orders/:id/assign error:', err);
    res.status(500).json({ error: err.message || 'Assignment failed' });
  }
});

// Admin: fulfill a supplier's line items via Shopify API
router.post('/assignments/fulfill', adminOnly, async (req, res) => {
  try {
    const { order_id, supplier_id, tracking_number, tracking_carrier, tracking_url } = req.body;
    if (!order_id || !supplier_id || !tracking_number || !tracking_carrier) {
      return res.status(400).json({ error: 'order_id, supplier_id, tracking_number, tracking_carrier are required' });
    }

    const order = db.getOrderById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.financial_status !== 'paid') {
      return res.status(400).json({ error: 'Order is not fully paid' });
    }

    // Update tracking in DB for all this supplier's items in this order
    asgDb.updateAssignmentTracking(order_id, supplier_id, { tracking_number, tracking_carrier, tracking_url });

    // Get all assigned (non-fulfilled) items for this supplier+order
    const supplierAssignments = asgDb.getAssignmentsBySupplier(supplier_id)
      .filter(a => a.order_id === parseInt(order_id) && a.status !== 'fulfilled');

    const lineItemIds = supplierAssignments.map(a => a.shopify_line_item_id);

    const fulfillment = await createFulfillmentForLineItems(
      order.shopify_order_id,
      lineItemIds,
      { trackingNumber: tracking_number, trackingCarrier: tracking_carrier, trackingUrl: tracking_url }
    );

    const fulfillmentId = fulfillment.id.split('/').pop();
    asgDb.markGroupFulfilled(order_id, supplier_id, fulfillmentId);

    db.logActivity(order.id, 'fulfilled',
      `Supplier ${supplier_id} items fulfilled in Shopify (fulfillment: ${fulfillmentId})`);

    res.json({ success: true, fulfillment_id: fulfillmentId });
  } catch (err) {
    console.error('[API] POST /assignments/fulfill error:', err);
    res.status(500).json({ error: err.message || 'Fulfillment failed' });
  }
});

module.exports = router;
