/**
 * db/supplier_skus.js
 * DB queries for the supplier_skus table.
 *
 * supplier_skus stores which SKUs a supplier stocks and tracks their
 * Shopify inventory item references + local stock quantities.
 * This is separate from assignment_rules (which routes orders).
 */

const { getDb } = require('./connection');

// ── Read ──────────────────────────────────────────────────────────────────────

function getSkusForSupplier(supplierId) {
  return getDb().prepare(
    'SELECT * FROM supplier_skus WHERE supplier_id = ? ORDER BY sku ASC'
  ).all(supplierId);
}

function getSkuById(id) {
  return getDb().prepare('SELECT * FROM supplier_skus WHERE id = ?').get(id);
}

function getSkuBySupplierAndSku(supplierId, sku) {
  return getDb().prepare(
    'SELECT * FROM supplier_skus WHERE supplier_id = ? AND sku = ?'
  ).get(supplierId, sku);
}

// ── Create ────────────────────────────────────────────────────────────────────

function createSupplierSku({ supplier_id, sku, product_title, shopify_variant_id, shopify_inventory_item_id, notes }) {
  return getDb().prepare(`
    INSERT INTO supplier_skus
      (supplier_id, sku, product_title, shopify_variant_id, shopify_inventory_item_id, notes)
    VALUES
      (@supplier_id, @sku, @product_title, @shopify_variant_id, @shopify_inventory_item_id, @notes)
  `).run({
    supplier_id,
    sku:                       sku.trim().toUpperCase(),
    product_title:             product_title             || null,
    shopify_variant_id:        shopify_variant_id        || null,
    shopify_inventory_item_id: shopify_inventory_item_id || null,
    notes:                     notes                     || null,
  });
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * updateSupplierSku — update metadata fields (product title, Shopify refs, notes).
 * Use updateStock() specifically for stock quantity changes.
 */
function updateSupplierSku(id, fields) {
  const allowed = ['product_title', 'shopify_variant_id', 'shopify_inventory_item_id', 'notes'];
  const setClauses = [];
  const params     = { id };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      setClauses.push(`${key} = @${key}`);
      params[key] = fields[key] || null;
    }
  }
  if (!setClauses.length) return;
  return getDb().prepare(
    `UPDATE supplier_skus SET ${setClauses.join(', ')} WHERE id = @id`
  ).run(params);
}

/**
 * updateStock — set the local stock quantity and optionally record when it was
 * last synced to Shopify.
 */
function updateStock(id, stockQuantity, lastSyncedAt = null) {
  return getDb().prepare(`
    UPDATE supplier_skus
    SET stock_quantity = ?, last_synced_at = ?
    WHERE id = ?
  `).run(Number(stockQuantity), lastSyncedAt, id);
}

/**
 * decrementStock — subtract qty from stock_quantity for a specific supplier+sku.
 * Never goes below 0. Used by the order webhook to deduct sold items.
 */
function decrementStock(supplierId, sku, qty) {
  return getDb().prepare(`
    UPDATE supplier_skus
    SET stock_quantity = MAX(0, stock_quantity - ?)
    WHERE supplier_id = ? AND UPPER(sku) = UPPER(?)
  `).run(Number(qty), supplierId, sku);
}

// ── Delete ────────────────────────────────────────────────────────────────────

function deleteSupplierSku(id) {
  return getDb().prepare('DELETE FROM supplier_skus WHERE id = ?').run(id);
}

module.exports = {
  getSkusForSupplier,
  getSkuById,
  getSkuBySupplierAndSku,
  createSupplierSku,
  updateSupplierSku,
  updateStock,
  decrementStock,
  deleteSupplierSku,
};
