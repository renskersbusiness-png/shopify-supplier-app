/**
 * routes/api.js
 * Admin REST API — orders, suppliers, assignment rules, and assignments.
 * All routes require authentication. Admin-only routes are gated with role check.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const db       = require('../db/orders');
const suppDb   = require('../db/suppliers');
const asgDb    = require('../db/assignments');
const skuDb    = require('../db/supplier_skus');
const settingsDb = require('../db/settings');
const { reassignLineItem }             = require('../services/assignment');
const { notifySupplier }               = require('../services/notifications');
const { createFulfillmentForLineItems, fetchOrderFromShopify,
        createFulfillmentService, getInventoryItemBySku,
        setInventoryLevel }            = require('../shopify/client');

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

// ── POST /api/test-email ──────────────────────────────────────────────────────
// One-shot SMTP smoke test. Sends a plain email using the exact same transporter
// config as notifySupplier(). Does not touch the DB or assignments.
// Body (optional): { "to": "someone@example.com" }

router.post('/test-email', adminOnly, async (req, res) => {
  const nodemailer = require('nodemailer');

  const to = (req.body && req.body.to) || process.env.SMTP_USER || 'wout.renskers@gmail.com';

  if (!process.env.SMTP_HOST) {
    console.log('[email-test] skipped → SMTP_HOST not set');
    return res.status(500).json({ success: false, error: 'SMTP_HOST is not configured' });
  }

  const port   = Number(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === 'true';

  console.log(`[email-test] sending to=${to} host=${process.env.SMTP_HOST} port=${port} secure=${secure} user=${process.env.SMTP_USER}`);

  const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     15_000,
  });

  const TIMEOUT_MS = 15_000;
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`sendMail timed out after ${TIMEOUT_MS}ms — check SMTP host/port/secure settings`)), TIMEOUT_MS)
  );

  try {
    const info = await Promise.race([
      transport.sendMail({
        from:    process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: 'Test email from Shopify Supplier App',
        text:    'If you receive this, SMTP works.',
        html:    '<p>If you receive this, <strong>SMTP works</strong>.</p>',
      }),
      timeoutPromise,
    ]);

    console.log(`[email-test] sent successfully to ${to} (messageId=${info.messageId})`);
    return res.json({ success: true, to, messageId: info.messageId });
  } catch (err) {
    console.error(`[email-test] failed → ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

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
// SUPPLIER SHOPIFY LOCATION  (admin only)
// Creates a Shopify Fulfillment Service for the supplier, which auto-creates
// a linked Location. The location ID is stored on the supplier record and
// used for all inventory operations for that supplier.
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/suppliers/:id/create-location
// Idempotent — if the supplier already has a location ID we just return it.
router.post('/suppliers/:id/create-location', adminOnly, async (req, res) => {
  try {
    const supplier = suppDb.getSupplierById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    if (supplier.shopify_location_id) {
      console.log(`[API] Supplier ${supplier.id} already has location ${supplier.shopify_location_id}`);
      return res.json({
        already_exists:  true,
        shopify_location_id: supplier.shopify_location_id,
        shopify_service_id:  supplier.shopify_service_id,
      });
    }

    console.log(`[API] Creating Shopify fulfillment service for supplier "${supplier.name}"`);
    const { serviceId, locationId, name } = await createFulfillmentService(supplier.name);

    suppDb.updateSupplierShopifyIds(supplier.id, {
      shopify_service_id:  serviceId,
      shopify_location_id: locationId,
    });

    console.log(`[API] Supplier ${supplier.id} → location=${locationId} service=${serviceId}`);
    res.json({
      success:             true,
      shopify_location_id: locationId,
      shopify_service_id:  serviceId,
      service_name:        name,
    });
  } catch (err) {
    console.error('[API] POST /suppliers/:id/create-location error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPPLIER SKU CATALOG  (admin only)
// Manages which SKUs a supplier stocks. Separate from assignment_rules —
// these entries track inventory references and stock levels per supplier.
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/suppliers/:id/skus
router.get('/suppliers/:id/skus', adminOnly, (req, res) => {
  try {
    const supplier = suppDb.getSupplierById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json({ skus: skuDb.getSkusForSupplier(req.params.id) });
  } catch (err) {
    console.error('[API] GET /suppliers/:id/skus error:', err);
    res.status(500).json({ error: 'Failed to fetch SKUs' });
  }
});

// POST /api/suppliers/:id/skus — add a SKU to this supplier's catalog
router.post('/suppliers/:id/skus', adminOnly, (req, res) => {
  try {
    const supplier = suppDb.getSupplierById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const { sku, product_title, notes } = req.body;
    if (!sku?.trim()) return res.status(400).json({ error: 'sku is required' });

    // Prevent duplicates
    const existing = skuDb.getSkuBySupplierAndSku(req.params.id, sku.trim().toUpperCase());
    if (existing) return res.status(409).json({ error: `SKU "${sku}" is already assigned to this supplier` });

    const result = skuDb.createSupplierSku({
      supplier_id:   parseInt(req.params.id),
      sku,
      product_title: product_title || null,
      notes:         notes         || null,
    });
    const entry = skuDb.getSkuById(result.lastInsertRowid);
    res.status(201).json({ sku: entry });
  } catch (err) {
    console.error('[API] POST /suppliers/:id/skus error:', err);
    res.status(500).json({ error: 'Failed to add SKU' });
  }
});

// DELETE /api/suppliers/:id/skus/:skuId — remove a SKU from this supplier's catalog
router.delete('/suppliers/:id/skus/:skuId', adminOnly, (req, res) => {
  try {
    skuDb.deleteSupplierSku(req.params.skuId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete SKU' });
  }
});

// POST /api/suppliers/:id/skus/:skuId/lookup
// Looks up the Shopify variant + inventory item ID for this SKU and stores it.
// Must be called before inventory sync can work for a given SKU.
router.post('/suppliers/:id/skus/:skuId/lookup', adminOnly, async (req, res) => {
  try {
    const entry = skuDb.getSkuById(req.params.skuId);
    if (!entry) return res.status(404).json({ error: 'SKU entry not found' });

    console.log(`[API] Looking up Shopify variant for SKU "${entry.sku}"`);
    const info = await getInventoryItemBySku(entry.sku);

    if (!info) {
      return res.status(404).json({
        error: `No Shopify variant found with SKU "${entry.sku}". Check the SKU matches exactly in Shopify.`,
      });
    }

    skuDb.updateSupplierSku(entry.id, {
      product_title:             info.productTitle,
      shopify_variant_id:        info.variantId,
      shopify_inventory_item_id: info.inventoryItemId,
    });

    console.log(`[API] SKU "${entry.sku}" → variantId=${info.variantId} inventoryItemId=${info.inventoryItemId}`);
    res.json({ success: true, ...info });
  } catch (err) {
    console.error('[API] POST /suppliers/:id/skus/:skuId/lookup error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPPLIER INVENTORY SYNC  (admin only)
// Syncs all SKU stock quantities for a supplier to Shopify at their location.
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/suppliers/:id/inventory/sync
// Syncs every SKU for this supplier to the shared Shopify location (SHOPIFY_LOCATION_ID).
router.post('/suppliers/:id/inventory/sync', adminOnly, async (req, res) => {
  try {
    const supplier   = suppDb.getSupplierById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const locationId = process.env.SHOPIFY_LOCATION_ID;
    if (!locationId) {
      return res.status(400).json({
        error: 'SHOPIFY_LOCATION_ID is not configured. Set it in Railway env vars and redeploy.',
      });
    }

    const skus    = skuDb.getSkusForSupplier(supplier.id);
    const results = { synced: [], skipped: [], failed: [] };

    for (const entry of skus) {
      if (!entry.shopify_inventory_item_id) {
        results.skipped.push({ sku: entry.sku, reason: 'No inventory item ID — run Lookup first' });
        continue;
      }
      try {
        await setInventoryLevel(entry.shopify_inventory_item_id, locationId, entry.stock_quantity);
        skuDb.updateStock(entry.id, entry.stock_quantity, new Date().toISOString());
        results.synced.push({ sku: entry.sku, quantity: entry.stock_quantity });
        console.log(`[API] Synced inventory: ${entry.sku} = ${entry.stock_quantity} at location ${locationId}`);
      } catch (syncErr) {
        console.error(`[API] Inventory sync failed for SKU ${entry.sku}:`, syncErr.message);
        results.failed.push({ sku: entry.sku, error: syncErr.message });
      }
    }

    res.json({ success: true, supplier_id: supplier.id, ...results });
  } catch (err) {
    console.error('[API] POST /suppliers/:id/inventory/sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SHARED SHOPIFY LOCATION  (admin only)
// One location is shared across all suppliers. The location ID is stored as
// SHOPIFY_LOCATION_ID in the Railway environment variables.
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/inventory/location — returns whether SHOPIFY_LOCATION_ID is configured
router.get('/inventory/location', adminOnly, (_req, res) => {
  const locationId = process.env.SHOPIFY_LOCATION_ID;
  res.json({ configured: !!locationId, location_id: locationId || null });
});

// POST /api/inventory/setup-location
// Creates a single shared Shopify Fulfillment Service (and its linked Location).
// Run this once. Copy the returned location_id and set SHOPIFY_LOCATION_ID in Railway.
router.post('/inventory/setup-location', adminOnly, async (_req, res) => {
  try {
    if (process.env.SHOPIFY_LOCATION_ID) {
      return res.json({ already_configured: true, location_id: process.env.SHOPIFY_LOCATION_ID });
    }
    console.log('[API] Creating shared Shopify fulfillment service');
    const { serviceId, locationId, name } = await createFulfillmentService('Shared Supplier Warehouse');
    console.log(`[API] Shared location created: location_id=${locationId} service_id=${serviceId}`);
    res.json({
      success:      true,
      location_id:  locationId,
      service_id:   serviceId,
      service_name: name,
      next_step:    `Set SHOPIFY_LOCATION_ID=${locationId} in your Railway environment variables, then redeploy.`,
    });
  } catch (err) {
    console.error('[API] POST /inventory/setup-location error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS  (admin only) — 3PL address, feature flags
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/settings/threepl — returns the 3PL warehouse address.
// If no DB override is set, falls back to the hardcoded default.
router.get('/settings/threepl', adminOnly, (_req, res) => {
  const override = settingsDb.getJson('threepl_address');
  res.json({
    address:    settingsDb.getThreeplAddress(),
    is_default: !override,
  });
});

// PUT /api/settings/threepl — set or update the 3PL warehouse address
// Body: { name, address1, address2, city, province_code, zip, country, phone }
router.put('/settings/threepl', adminOnly, (req, res) => {
  try {
    const { name, address1, address2, city, province_code, zip, country, phone } = req.body || {};
    if (!name || !address1 || !city || !zip || !country) {
      return res.status(400).json({ error: 'name, address1, city, zip, country are required' });
    }
    const addr = {
      name:          String(name).trim(),
      address1:      String(address1).trim(),
      address2:      address2      ? String(address2).trim()      : null,
      city:          String(city).trim(),
      province_code: province_code ? String(province_code).trim() : null,
      zip:           String(zip).trim(),
      country:       String(country).trim(),
      phone:         phone         ? String(phone).trim()         : null,
    };
    settingsDb.setJson('threepl_address', addr);
    res.json({ success: true, address: addr });
  } catch (err) {
    console.error('[API] PUT /settings/threepl error:', err);
    res.status(500).json({ error: 'Failed to save 3PL address' });
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
