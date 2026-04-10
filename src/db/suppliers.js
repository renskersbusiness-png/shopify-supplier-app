/**
 * db/suppliers.js
 * All DB queries for the suppliers table.
 */

const { getDb } = require('./connection');
const crypto    = require('crypto');

function generateToken() {
  return crypto.randomUUID();
}

function createSupplier({ name, email, notes = '' }) {
  return getDb().prepare(`
    INSERT INTO suppliers (name, email, notes, access_token)
    VALUES (@name, @email, @notes, @access_token)
  `).run({ name, email, notes, access_token: generateToken() });
}

function getAllSuppliers() {
  return getDb().prepare(`
    SELECT * FROM suppliers ORDER BY name ASC
  `).all();
}

function getSupplierById(id) {
  return getDb().prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

function getSupplierByToken(token) {
  return getDb().prepare('SELECT * FROM suppliers WHERE access_token = ? AND active = 1').get(token);
}

function updateSupplier(id, { name, email, notes, active }) {
  const fields = [];
  const params = { id };
  if (name    !== undefined) { fields.push('name = @name');       params.name    = name;    }
  if (email   !== undefined) { fields.push('email = @email');     params.email   = email;   }
  if (notes   !== undefined) { fields.push('notes = @notes');     params.notes   = notes;   }
  if (active  !== undefined) { fields.push('active = @active');   params.active  = active ? 1 : 0; }
  if (!fields.length) return;
  return getDb().prepare(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = @id`).run(params);
}

function rotateToken(id) {
  const token = generateToken();
  getDb().prepare('UPDATE suppliers SET access_token = ? WHERE id = ?').run(token, id);
  return token;
}

function deleteSupplier(id) {
  return getDb().prepare('DELETE FROM suppliers WHERE id = ?').run(id);
}

/**
 * updateSupplierShopifyIds — store the Shopify fulfillment service ID and
 * the linked location ID after a successful createFulfillmentService() call.
 */
function updateSupplierShopifyIds(id, { shopify_service_id, shopify_location_id }) {
  return getDb().prepare(`
    UPDATE suppliers
    SET shopify_service_id = ?, shopify_location_id = ?
    WHERE id = ?
  `).run(shopify_service_id || null, shopify_location_id || null, id);
}

module.exports = {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  getSupplierByToken,
  updateSupplier,
  rotateToken,
  deleteSupplier,
  updateSupplierShopifyIds,
};
