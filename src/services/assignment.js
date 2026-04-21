/**
 * services/assignment.js
 * Rule engine: matches Shopify order line items to suppliers using assignment_rules.
 * Called when a new order webhook arrives or when manually triggered.
 */

const { getActiveRules, createAssignment, assignmentExistsForLineItem } = require('../db/assignments');

/**
 * matchLineItemToRule(lineItem, orderTags, rules)
 * Returns the first matching rule for a line item, or null if none match.
 * Rules must be pre-sorted by priority ASC (lowest number = highest priority).
 *
 * rule_types:
 *   'sku'        — matches lineItem.sku (case-insensitive)
 *   'vendor'     — matches lineItem.vendor (case-insensitive)
 *   'product_id' — matches lineItem.product_id (as string)
 *   'order_tag'  — matches any tag in the order's tags array
 */
function matchLineItemToRule(lineItem, orderTags, rules) {
  const sku       = (lineItem.sku       || '').toLowerCase().trim();
  const vendor    = (lineItem.vendor    || '').toLowerCase().trim();
  const productId = String(lineItem.product_id || '');
  const tags      = orderTags.map(t => t.toLowerCase().trim());

  for (const rule of rules) {
    const rv = (rule.rule_value || '').toLowerCase().trim();
    switch (rule.rule_type) {
      case 'sku':
        if (sku && sku === rv) return rule;
        break;
      case 'vendor':
        if (vendor && vendor === rv) return rule;
        break;
      case 'product_id':
        if (productId && productId === rv) return rule;
        break;
      case 'order_tag':
        if (tags.includes(rv)) return rule;
        break;
    }
  }
  return null;
}

/**
 * assignOrderLineItems(order)
 * Process all line items of an order through the rule engine.
 * Creates line_item_assignment rows.
 * Skips line items already assigned (idempotent).
 *
 * @param {Object} order        — row from `orders` table (must have .id and .shopify_order_id)
 * @param {Array}  lineItems    — Shopify line item objects from webhook or REST
 * @param {Array}  orderTags    — array of tag strings from Shopify order
 * @returns {Array}             — array of created assignment objects { lineItemId, supplierId, ruleId, status }
 */
function assignOrderLineItems(order, lineItems, orderTags = []) {
  const rules   = getActiveRules();
  const results = [];

  for (const item of lineItems) {
    // Idempotent: skip if already assigned
    if (assignmentExistsForLineItem(order.id, item.id)) {
      console.log(`[assign] line item ${item.id} already assigned — skipping`);
      continue;
    }

    const matchedRule = matchLineItemToRule(item, orderTags, rules);

    const data = {
      order_id:             order.id,
      shopify_line_item_id: item.id,
      title:                item.title,
      variant_title:        item.variant_title || null,
      sku:                  item.sku           || null,
      vendor:               item.vendor        || null,
      product_id:           item.product_id ? String(item.product_id) : null,
      quantity:             item.quantity,
      price:                item.price         || null,
      currency:             item.price_set?.shop_money?.currency_code || null,
      supplier_id:          matchedRule ? matchedRule.supplier_id : null,
      assignment_rule_id:   matchedRule ? matchedRule.id          : null,
    };

    const info = createAssignment(data);

    results.push({
      assignmentId: info.lastInsertRowid,
      lineItemId:   item.id,
      supplierId:   data.supplier_id,
      ruleId:       data.assignment_rule_id,
      status:       data.supplier_id ? 'assigned' : 'unassigned',
      sku:          data.sku,
      quantity:     data.quantity,
    });

    console.log(
      `[assign] line item ${item.id} (${item.title}) → ` +
      (matchedRule
        ? `supplier ${matchedRule.supplier_id} via rule ${matchedRule.id} (${matchedRule.rule_type}:${matchedRule.rule_value})`
        : 'UNASSIGNED')
    );
  }

  return results;
}

/**
 * reassignLineItem(assignmentId, supplierId, ruleId)
 * Convenience wrapper used by admin manual override — actual DB update
 * is handled in db/assignments.js; this just provides the service layer.
 * Kept here so routes don't import both service and db directly.
 */
const { updateAssignmentSupplier } = require('../db/assignments');
function reassignLineItem(assignmentId, supplierId, ruleId = null) {
  return updateAssignmentSupplier(assignmentId, supplierId, ruleId);
}

/**
 * getAssignedSupplierIds(results)
 * Returns unique supplier IDs from assignOrderLineItems results (assigned only).
 */
function getAssignedSupplierIds(results) {
  return [...new Set(results.filter(r => r.supplierId).map(r => r.supplierId))];
}

module.exports = {
  assignOrderLineItems,
  reassignLineItem,
  getAssignedSupplierIds,
  matchLineItemToRule, // exported for testing
};
