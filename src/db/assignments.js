/**
 * db/assignments.js
 * DB queries for assignment_rules and line_item_assignments tables.
 */

const { getDb } = require('./connection');

// ── Assignment Rules ──────────────────────────────────────────────────────────

function getAllRules() {
  return getDb().prepare(`
    SELECT r.*, s.name as supplier_name
    FROM assignment_rules r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    ORDER BY r.priority ASC, r.id ASC
  `).all();
}

function getActiveRules() {
  return getDb().prepare(`
    SELECT r.*, s.name as supplier_name, s.active as supplier_active
    FROM assignment_rules r
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.active = 1 AND s.active = 1
    ORDER BY r.priority ASC, r.id ASC
  `).all();
}

function createRule({ rule_type, rule_value, supplier_id, priority = 100 }) {
  return getDb().prepare(`
    INSERT INTO assignment_rules (rule_type, rule_value, supplier_id, priority)
    VALUES (@rule_type, @rule_value, @supplier_id, @priority)
  `).run({ rule_type, rule_value: rule_value.trim(), supplier_id, priority });
}

function updateRule(id, { rule_type, rule_value, supplier_id, priority, active }) {
  const fields = [];
  const params = { id };
  if (rule_type   !== undefined) { fields.push('rule_type = @rule_type');     params.rule_type   = rule_type;   }
  if (rule_value  !== undefined) { fields.push('rule_value = @rule_value');   params.rule_value  = rule_value.trim(); }
  if (supplier_id !== undefined) { fields.push('supplier_id = @supplier_id'); params.supplier_id = supplier_id; }
  if (priority    !== undefined) { fields.push('priority = @priority');       params.priority    = priority;    }
  if (active      !== undefined) { fields.push('active = @active');           params.active      = active ? 1 : 0; }
  if (!fields.length) return;
  return getDb().prepare(`UPDATE assignment_rules SET ${fields.join(', ')} WHERE id = @id`).run(params);
}

function deleteRule(id) {
  return getDb().prepare('DELETE FROM assignment_rules WHERE id = ?').run(id);
}

// ── Line Item Assignments ─────────────────────────────────────────────────────

function createAssignment(data) {
  return getDb().prepare(`
    INSERT INTO line_item_assignments (
      order_id, shopify_line_item_id,
      title, variant_title, sku, vendor, product_id,
      quantity, price, currency,
      supplier_id, assignment_rule_id, status
    ) VALUES (
      @order_id, @shopify_line_item_id,
      @title, @variant_title, @sku, @vendor, @product_id,
      @quantity, @price, @currency,
      @supplier_id, @assignment_rule_id, @status
    )
  `).run({
    order_id:             data.order_id,
    shopify_line_item_id: String(data.shopify_line_item_id),
    title:                data.title,
    variant_title:        data.variant_title || null,
    sku:                  data.sku           || null,
    vendor:               data.vendor        || null,
    product_id:           data.product_id ? String(data.product_id) : null,
    quantity:             data.quantity,
    price:                data.price         || null,
    currency:             data.currency      || null,
    supplier_id:          data.supplier_id   || null,
    assignment_rule_id:   data.assignment_rule_id || null,
    status:               data.supplier_id ? 'assigned' : 'unassigned',
  });
}

function getAssignmentsByOrder(orderId) {
  return getDb().prepare(`
    SELECT a.*, s.name as supplier_name
    FROM line_item_assignments a
    LEFT JOIN suppliers s ON s.id = a.supplier_id
    WHERE a.order_id = ?
    ORDER BY a.id ASC
  `).all(orderId);
}

function getAssignmentsBySupplier(supplierId, { status, limit = 100, offset = 0 } = {}) {
  const extraWhere = status ? 'AND a.status = ?' : '';
  const params     = status
    ? [supplierId, status, limit, offset]
    : [supplierId, limit, offset];
  return getDb().prepare(`
    SELECT a.*, o.shopify_order_num, o.customer_name, o.customer_email,
           o.customer_phone, o.shipping_address, o.financial_status as order_financial_status,
           o.shopify_created_at as order_created_at
    FROM line_item_assignments a
    JOIN orders o ON o.id = a.order_id
    WHERE a.supplier_id = ? ${extraWhere}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params);
}

function getAssignmentById(id) {
  return getDb().prepare(`
    SELECT a.*, o.shopify_order_id, o.shopify_order_num, o.customer_name,
           o.customer_email, o.customer_phone, o.shipping_address,
           o.financial_status as order_financial_status, o.currency as order_currency,
           s.name as supplier_name, s.email as supplier_email
    FROM line_item_assignments a
    JOIN orders o ON o.id = a.order_id
    LEFT JOIN suppliers s ON s.id = a.supplier_id
    WHERE a.id = ?
  `).get(id);
}

function assignmentExistsForLineItem(orderId, shopifyLineItemId) {
  return !!getDb().prepare(
    'SELECT 1 FROM line_item_assignments WHERE order_id = ? AND shopify_line_item_id = ?'
  ).get(orderId, String(shopifyLineItemId));
}

function updateAssignmentSupplier(id, supplierId, ruleId = null) {
  const status = supplierId ? 'assigned' : 'unassigned';
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET supplier_id = ?, assignment_rule_id = ?, status = ?, notified_at = NULL
    WHERE id = ?
  `).run(supplierId || null, ruleId, status, id);
}

function updateAssignmentTracking(orderId, supplierId, { tracking_number, tracking_carrier, tracking_url }) {
  // Updates ALL assignments for this supplier+order at once (one shipment per supplier per order)
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET tracking_number = ?, tracking_carrier = ?, tracking_url = ?,
        status = CASE WHEN status = 'fulfilled' THEN 'fulfilled' ELSE 'tracking_added' END
    WHERE order_id = ? AND supplier_id = ? AND status != 'fulfilled'
  `).run(tracking_number, tracking_carrier, tracking_url || null, orderId, supplierId);
}

/**
 * clearAssignmentTracking — remove tracking and revert status to 'assigned'.
 * Only affects items in 'tracking_added' state. Fulfilled items are untouched.
 */
function clearAssignmentTracking(orderId, supplierId) {
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET tracking_number = NULL, tracking_carrier = NULL, tracking_url = NULL,
        status = 'assigned'
    WHERE order_id = ? AND supplier_id = ? AND status = 'tracking_added'
  `).run(orderId, supplierId);
}

/**
 * markGroupSentTo3pl(orderId, supplierId, tracking?)
 * Marks supplier's items in an order as sent to 3PL. Local state only —
 * does NOT push anything to Shopify (3PL handles fulfillment there).
 * Only moves items from 'assigned' → 'sent_to_3pl'.
 *
 * Optional `tracking` param ({ tracking_number, tracking_carrier, tracking_url })
 * stores the supplier→3PL leg tracking info on the assignment rows.
 */
function markGroupSentTo3pl(orderId, supplierId, tracking = null) {
  if (tracking && (tracking.tracking_number || tracking.tracking_carrier)) {
    return getDb().prepare(`
      UPDATE line_item_assignments
      SET status = 'sent_to_3pl',
          tracking_number  = ?,
          tracking_carrier = ?,
          tracking_url     = ?
      WHERE order_id = ? AND supplier_id = ? AND status = 'assigned'
    `).run(
      tracking.tracking_number  || null,
      tracking.tracking_carrier || null,
      tracking.tracking_url     || null,
      orderId, supplierId
    );
  }
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET status = 'sent_to_3pl'
    WHERE order_id = ? AND supplier_id = ? AND status = 'assigned'
  `).run(orderId, supplierId);
}

/**
 * unmarkGroupSentTo3pl(orderId, supplierId)
 * Reverts a 'sent_to_3pl' group back to 'assigned' (mistake correction).
 */
function unmarkGroupSentTo3pl(orderId, supplierId) {
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET status = 'assigned'
    WHERE order_id = ? AND supplier_id = ? AND status = 'sent_to_3pl'
  `).run(orderId, supplierId);
}

function markGroupFulfilled(orderId, supplierId, shopifyFulfillmentId) {
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET status = 'fulfilled', shopify_fulfillment_id = ?
    WHERE order_id = ? AND supplier_id = ? AND status = 'tracking_added'
  `).run(shopifyFulfillmentId, orderId, supplierId);
}

function getUnnotifiedAssignments(supplierId) {
  return getDb().prepare(`
    SELECT a.*, o.shopify_order_num, o.customer_name, o.shipping_address
    FROM line_item_assignments a
    JOIN orders o ON o.id = a.order_id
    WHERE a.supplier_id = ? AND a.status = 'assigned' AND a.notified_at IS NULL
  `).all(supplierId);
}

function markNotified(ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  return getDb().prepare(
    `UPDATE line_item_assignments SET notified_at = datetime('now') WHERE id IN (${placeholders})`
  ).run(...ids);
}

function getAssignmentStats(supplierId) {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'assigned'        THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN status = 'tracking_added'  THEN 1 ELSE 0 END) as tracking_added,
      SUM(CASE WHEN status = 'sent_to_3pl'     THEN 1 ELSE 0 END) as sent_to_3pl,
      SUM(CASE WHEN status = 'fulfilled'       THEN 1 ELSE 0 END) as fulfilled,
      SUM(CASE WHEN status = 'unassigned'      THEN 1 ELSE 0 END) as unassigned
    FROM line_item_assignments
    WHERE supplier_id = ?
  `).get(supplierId);
}

/**
 * cancelOrderAssignments(orderId)
 * Called when an order is cancelled. Marks all non-fulfilled assignments as
 * 'cancelled' so suppliers can no longer act on them.
 * Fulfilled assignments are left untouched — the shipment already went out.
 */
function cancelOrderAssignments(orderId) {
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET status = 'cancelled'
    WHERE order_id = ? AND status NOT IN ('fulfilled', 'cancelled')
  `).run(orderId);
}

/**
 * updateFulfillmentTracking(shopifyFulfillmentId, tracking)
 * Updates tracking info on all assignments that belong to a given Shopify
 * fulfillment ID. Called from the fulfillments/update webhook.
 */
function updateFulfillmentTracking(shopifyFulfillmentId, { tracking_number, tracking_carrier, tracking_url }) {
  return getDb().prepare(`
    UPDATE line_item_assignments
    SET tracking_number = ?, tracking_carrier = ?, tracking_url = ?
    WHERE shopify_fulfillment_id = ?
  `).run(tracking_number || null, tracking_carrier || null, tracking_url || null, String(shopifyFulfillmentId));
}

function getAllAssignmentStats() {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'assigned'       THEN 1 ELSE 0 END) as assigned,
      SUM(CASE WHEN status = 'tracking_added' THEN 1 ELSE 0 END) as tracking_added,
      SUM(CASE WHEN status = 'fulfilled'      THEN 1 ELSE 0 END) as fulfilled,
      SUM(CASE WHEN status = 'unassigned'     THEN 1 ELSE 0 END) as unassigned
    FROM line_item_assignments
  `).get();
}

// For admin overview — all assignments with filters
function getAllAssignments({ supplierId, status, orderId, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (supplierId) { where.push('a.supplier_id = ?'); params.push(supplierId); }
  if (status)     { where.push('a.status = ?');      params.push(status);     }
  if (orderId)    { where.push('a.order_id = ?');    params.push(orderId);    }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = getDb().prepare(`
    SELECT a.*, o.shopify_order_num, o.customer_name, o.financial_status as order_financial_status,
           s.name as supplier_name
    FROM line_item_assignments a
    JOIN orders o ON o.id = a.order_id
    LEFT JOIN suppliers s ON s.id = a.supplier_id
    ${clause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM line_item_assignments a
    JOIN orders o ON o.id = a.order_id
    LEFT JOIN suppliers s ON s.id = a.supplier_id
    ${clause}
  `).get(...params);

  return { assignments: rows, total: total.count };
}

module.exports = {
  getAllRules,
  getActiveRules,
  createRule,
  updateRule,
  deleteRule,
  createAssignment,
  getAssignmentsByOrder,
  getAssignmentsBySupplier,
  getAssignmentById,
  assignmentExistsForLineItem,
  updateAssignmentSupplier,
  updateAssignmentTracking,
  clearAssignmentTracking,
  markGroupFulfilled,
  markGroupSentTo3pl,
  unmarkGroupSentTo3pl,
  getUnnotifiedAssignments,
  markNotified,
  getAssignmentStats,
  getAllAssignmentStats,
  getAllAssignments,
  cancelOrderAssignments,
  updateFulfillmentTracking,
};
