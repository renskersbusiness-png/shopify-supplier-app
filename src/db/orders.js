/**
 * db/orders.js
 * All database queries for orders.
 * Keeps SQL out of route handlers — clean separation.
 */

const { getDb } = require('./connection');

// ── Create ────────────────────────────────────────────────────────────────────

function createOrder(data) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO orders (
      shopify_order_id, shopify_order_num,
      customer_name, customer_email, customer_phone,
      shipping_address, line_items,
      total_price, currency,
      status, raw_payload, shopify_created_at
    ) VALUES (
      @shopify_order_id, @shopify_order_num,
      @customer_name, @customer_email, @customer_phone,
      @shipping_address, @line_items,
      @total_price, @currency,
      'pending', @raw_payload, @shopify_created_at
    )
  `);
  return stmt.run(data);
}

// ── Read ──────────────────────────────────────────────────────────────────────

function getAllOrders({ status, search, limit = 50, offset = 0 } = {}) {
  const db = getDb();

  let where = [];
  let params = {};

  if (status && status !== 'all') {
    where.push('status = @status');
    params.status = status;
  }

  if (search) {
    where.push(`(
      shopify_order_num LIKE @search
      OR customer_name   LIKE @search
      OR customer_email  LIKE @search
    )`);
    params.search = `%${search}%`;
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM orders
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM orders ${whereClause}
  `).get(params);

  return { orders: rows, total: total.count };
}

function getOrderById(id) {
  return getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function getOrderByShopifyId(shopifyOrderId) {
  return getDb()
    .prepare('SELECT * FROM orders WHERE shopify_order_id = ?')
    .get(shopifyOrderId);
}

// ── Update ────────────────────────────────────────────────────────────────────

function updateOrderStatus(id, status) {
  return getDb()
    .prepare('UPDATE orders SET status = ? WHERE id = ?')
    .run(status, id);
}

function updateTracking(id, { tracking_number, tracking_carrier, tracking_url }) {
  // Do not downgrade a fulfilled order — update tracking fields only.
  // For every other status, also advance to 'shipped'.
  return getDb().prepare(`
    UPDATE orders
    SET tracking_number = ?,
        tracking_carrier = ?,
        tracking_url = ?,
        status = CASE WHEN status = 'fulfilled' THEN 'fulfilled' ELSE 'shipped' END
    WHERE id = ?
  `).run(tracking_number, tracking_carrier, tracking_url || null, id);
}

function markFulfilled(id, shopifyFulfillmentId) {
  return getDb().prepare(`
    UPDATE orders
    SET status = 'fulfilled', shopify_fulfillment_id = ?
    WHERE id = ?
  `).run(shopifyFulfillmentId, id);
}

function updateNotes(id, notes) {
  return getDb()
    .prepare('UPDATE orders SET notes = ? WHERE id = ?')
    .run(notes, id);
}

// ── Stats (for dashboard header) ─────────────────────────────────────────────

function getStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'shipped'    THEN 1 ELSE 0 END) as shipped,
      SUM(CASE WHEN status = 'fulfilled'  THEN 1 ELSE 0 END) as fulfilled
    FROM orders
  `).get();
}

// ── Activity log ──────────────────────────────────────────────────────────────

function logActivity(orderId, action, detail) {
  return getDb().prepare(`
    INSERT INTO activity_log (order_id, action, detail)
    VALUES (?, ?, ?)
  `).run(orderId, action, detail);
}

function getActivityLog(orderId) {
  return getDb().prepare(`
    SELECT * FROM activity_log
    WHERE order_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(orderId);
}

module.exports = {
  createOrder,
  getAllOrders,
  getOrderById,
  getOrderByShopifyId,
  updateOrderStatus,
  updateTracking,
  markFulfilled,
  updateNotes,
  getStats,
  logActivity,
  getActivityLog,
};
