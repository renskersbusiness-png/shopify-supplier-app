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
const { updateAssignmentTracking, clearAssignmentTracking, markGroupFulfilled,
        markGroupSentTo3pl, unmarkGroupSentTo3pl } = require('../db/assignments');
const settingsDb = require('../db/settings');
const { getOrderById, logActivity }     = require('../db/orders');
const { getSupplierById }               = require('../db/suppliers');
const skuDb                             = require('../db/supplier_skus');
const { createFulfillmentForLineItems, setInventoryLevel, getInventoryLevels } = require('../shopify/client');

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

    // 3PL flow: when enabled, suppliers ship to 3PL warehouse instead of customer.
    // Toggleable via env var so we can revert easily.
    const threeplEnabled = process.env.THREEPL_FLOW === 'true';
    const threeplAddress = threeplEnabled ? settingsDb.getJson('threepl_address') : null;

    res.json({
      assignments,
      stats,
      page: parseInt(page),
      threepl_enabled: threeplEnabled,
      threepl_address: threeplAddress,
    });
  } catch (err) {
    console.error('[Supplier API] GET /assignments error:', err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ── POST /api/supplier/sent — mark order as sent to 3PL ───────────────────────
// 3PL flow: supplier marks that they've shipped the goods to the 3PL warehouse.
// Local-only state change, does NOT push to Shopify (3PL fulfills there).

router.post('/sent', (req, res) => {
  try {
    if (process.env.THREEPL_FLOW !== 'true') {
      return res.status(400).json({ error: '3PL flow is not enabled' });
    }
    const { order_id } = req.body;
    const supplierId   = req.session.supplierId;
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const order = getOrderById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.financial_status !== 'paid') {
      return res.status(403).json({ error: 'Order is not fully paid' });
    }

    const result = markGroupSentTo3pl(order_id, supplierId);
    logActivity(order.id, 'sent_to_3pl',
      `Supplier ${supplierId} marked ${result.changes} item(s) as sent to 3PL`);

    console.log(`[sent] order_id=${order_id} supplier=${supplierId} (${result.changes} items)`);
    res.json({ success: true, marked: result.changes });
  } catch (err) {
    console.error('[sent] failed →', err.message);
    res.status(500).json({ error: 'Failed to mark as sent' });
  }
});

// ── DELETE /api/supplier/sent — undo "Mark as Sent" ───────────────────────────

router.delete('/sent', (req, res) => {
  try {
    const { order_id } = req.body;
    const supplierId   = req.session.supplierId;
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const result = unmarkGroupSentTo3pl(order_id, supplierId);
    console.log(`[sent] reverted order_id=${order_id} supplier=${supplierId} (${result.changes} items)`);
    res.json({ success: true, reverted: result.changes });
  } catch (err) {
    console.error('[sent] revert failed →', err.message);
    res.status(500).json({ error: 'Failed to revert' });
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

// ── DELETE /api/supplier/tracking — remove tracking for an order ─────────────
// Reverts tracking_added assignments back to 'assigned'. Fulfilled items untouched.

router.delete('/tracking', (req, res) => {
  try {
    const { order_id } = req.body;
    const supplierId   = req.session.supplierId;

    if (!order_id) return res.status(400).json({ error: 'order_id is required' });

    const order = getOrderById(order_id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = clearAssignmentTracking(order_id, supplierId);
    logActivity(order.id, 'tracking_removed',
      `Supplier ${supplierId} removed tracking (${result.changes} item(s) reverted)`);

    console.log(`[tracking] removed for order_id=${order_id} supplier=${supplierId} (${result.changes} items)`);
    res.json({ success: true, reverted: result.changes });
  } catch (err) {
    console.error('[tracking] remove failed →', err.message);
    res.status(500).json({ error: 'Failed to remove tracking' });
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

// ── GET /api/supplier/inventory ───────────────────────────────────────────────
// Returns all SKUs for this supplier. If Shopify location is configured,
// fetches current stock levels from Shopify and updates the local DB first.

router.get('/inventory', async (req, res) => {
  try {
    const supplierId = req.session.supplierId;
    const supplier   = getSupplierById(supplierId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const locationId = process.env.SHOPIFY_LOCATION_ID;
    let dbSkus       = skuDb.getSkusForSupplier(supplierId);

    // Pull live stock from Shopify and refresh local DB
    if (locationId) {
      const linkedSkus = dbSkus.filter(s => s.shopify_inventory_item_id);
      if (linkedSkus.length) {
        try {
          const ids    = linkedSkus.map(s => s.shopify_inventory_item_id);
          const levels = await getInventoryLevels(ids, locationId);

          for (const s of linkedSkus) {
            const live = levels.get(String(s.shopify_inventory_item_id));
            if (live !== undefined && live !== s.stock_quantity) {
              skuDb.updateStock(s.id, live);
              console.log(`[inventory] refreshed sku=${s.sku} ${s.stock_quantity}→${live} (from Shopify)`);
            }
          }

          // Re-read from DB so we return the just-updated values
          dbSkus = skuDb.getSkusForSupplier(supplierId);
        } catch (shopifyErr) {
          // Non-fatal — return local data if Shopify fetch fails
          console.warn('[inventory] Shopify level fetch failed, returning local data:', shopifyErr.message);
        }
      }
    }

    const skus = dbSkus.map(s => ({
      id:                        s.id,
      sku:                       s.sku,
      product_title:             s.product_title,
      stock_quantity:            s.stock_quantity,
      shopify_inventory_item_id: s.shopify_inventory_item_id,
      last_synced_at:            s.last_synced_at,
      notes:                     s.notes,
    }));

    res.json({
      skus,
      has_shopify_location: !!locationId,
    });
  } catch (err) {
    console.error('[Supplier API] GET /inventory error:', err);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// ── PATCH /api/supplier/inventory/:id ─────────────────────────────────────────
// Supplier updates stock for a SKU. Saves locally and auto-syncs to Shopify
// if the SKU is linked and a location is configured.

router.patch('/inventory/:id', async (req, res) => {
  try {
    const supplierId = req.session.supplierId;
    const entry      = skuDb.getSkuById(req.params.id);

    if (!entry) return res.status(404).json({ error: 'SKU not found' });
    if (entry.supplier_id !== supplierId) return res.status(403).json({ error: 'Forbidden' });

    const { stock_quantity } = req.body;
    if (stock_quantity === undefined || stock_quantity === null) {
      return res.status(400).json({ error: 'stock_quantity is required' });
    }
    const qty = parseInt(stock_quantity, 10);
    if (isNaN(qty) || qty < 0) {
      return res.status(400).json({ error: 'stock_quantity must be a non-negative integer' });
    }

    const locationId = process.env.SHOPIFY_LOCATION_ID;
    let synced = false;
    let syncedAt = null;

    // Auto-push to Shopify if the SKU is linked
    if (locationId && entry.shopify_inventory_item_id) {
      await setInventoryLevel(entry.shopify_inventory_item_id, locationId, qty);
      syncedAt = new Date().toISOString();
      synced   = true;
      console.log(`[inventory] supplier=${supplierId} sku=${entry.sku} stock=${qty} → synced to Shopify`);
    } else {
      console.log(`[inventory] supplier=${supplierId} sku=${entry.sku} stock=${qty} (local only)`);
    }

    skuDb.updateStock(entry.id, qty, syncedAt);
    res.json({ success: true, sku: entry.sku, stock_quantity: qty, synced });
  } catch (err) {
    console.error('[Supplier API] PATCH /inventory/:id error:', err);
    res.status(500).json({ error: err.message || 'Failed to update stock' });
  }
});

// ── POST /api/supplier/inventory/:id/sync ─────────────────────────────────────
// Pushes the locally stored stock for one SKU to Shopify at the supplier's location.

router.post('/inventory/:id/sync', async (req, res) => {
  try {
    const supplierId = req.session.supplierId;
    const entry      = skuDb.getSkuById(req.params.id);

    if (!entry) return res.status(404).json({ error: 'SKU not found' });
    if (entry.supplier_id !== supplierId) return res.status(403).json({ error: 'Forbidden' });

    const locationId = process.env.SHOPIFY_LOCATION_ID;
    if (!locationId) {
      return res.status(400).json({ error: 'Inventory sync is not yet configured. Please contact your admin.' });
    }
    if (!entry.shopify_inventory_item_id) {
      return res.status(400).json({ error: 'This SKU has not been linked to a Shopify product yet. Ask an admin to run a lookup.' });
    }

    console.log(`[inventory] syncing sku=${entry.sku} qty=${entry.stock_quantity} → location=${locationId}`);

    await setInventoryLevel(
      entry.shopify_inventory_item_id,
      locationId,
      entry.stock_quantity
    );

    const syncedAt = new Date().toISOString();
    skuDb.updateStock(entry.id, entry.stock_quantity, syncedAt);

    console.log(`[inventory] synced successfully sku=${entry.sku} qty=${entry.stock_quantity}`);
    res.json({ success: true, sku: entry.sku, stock_quantity: entry.stock_quantity, synced_at: syncedAt });
  } catch (err) {
    console.error(`[inventory] sync failed → ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
