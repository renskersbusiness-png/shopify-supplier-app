/**
 * shopify/client.js
 * All Shopify API communication.
 * Uses the Admin GraphQL API to create fulfillments and update tracking.
 *
 * Access tokens are obtained programmatically via the client credentials
 * grant (see shopify/auth.js) — SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET
 * are the only Shopify credentials required.
 */

const fetch  = require('node-fetch');
const { getAccessToken, clearTokenCache } = require('./auth');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const API_VERSION    = '2025-01'; // Quarterly stable release; bump annually

const GRAPHQL_URL = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

/**
 * Execute a GraphQL query/mutation against the Shopify Admin API.
 * Automatically fetches (and caches) the access token.
 * On a 401 the token cache is cleared and the request is retried once.
 */
async function shopifyGraphQL(query, variables = {}) {
  return _request(query, variables, false);
}

async function _request(query, variables, isRetry) {
  const token = await getAccessToken();

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  // If Shopify rejects the token, clear the cache and try one more time.
  if (res.status === 401 && !isRetry) {
    console.warn('[Shopify] 401 received — clearing token cache and retrying once.');
    clearTokenCache();
    return _request(query, variables, true);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors) {
    // Log the full error array — ACCESS_DENIED, scope issues, etc. all surface here
    console.error('[Shopify] GraphQL errors:', JSON.stringify(json.errors, null, 2));
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Get the fulfillment order ID for a given Shopify order
// (Required before creating a fulfillment)
//
// REQUIRED SHOPIFY APP SCOPES (configure in Partner Dashboard → App → Configuration):
//   read_merchant_managed_fulfillment_orders   ← needed to query fulfillmentOrders
//   write_merchant_managed_fulfillment_orders  ← needed to create fulfillments
//
// NOTE: Use the *merchant_managed* variants, NOT assigned_fulfillment_orders.
// assigned_fulfillment_orders is for 3PL / external fulfillment services only.
//
// If you get ACCESS_DENIED on this query, the app is missing these scopes.
// You MUST reinstall/reauthorize the app after adding scopes in the Partner Dashboard:
//   1. Add both scopes in Partner Dashboard → App → Configuration → Admin API access scopes
//   2. Uninstall the app from your Shopify store
//   3. Reinstall via the install URL (or Partner Dashboard → Test on development store)
// ─────────────────────────────────────────────────────────────────────────────

async function getFulfillmentOrders(shopifyOrderId) {
  const query = `
    query getFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        name
        fulfillmentOrders(first: 10) {
          nodes {
            id
            status
            lineItems(first: 30) {
              nodes {
                id
                remainingQuantity
                totalQuantity
                lineItem {
                  id
                  title
                  variantTitle
                  sku
                  originalUnitPriceSet {
                    shopMoney { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Shopify Global ID format: gid://shopify/Order/1234567890
  const globalId = `gid://shopify/Order/${shopifyOrderId}`;
  const data = await shopifyGraphQL(query, { id: globalId });
  return data.order?.fulfillmentOrders?.nodes || [];
}

/**
 * Returns only OPEN fulfillment order line items for an order.
 * Used by the supplier portal to show exactly what can be shipped —
 * skipping ON_HOLD or CLOSED items (e.g. unpaid upsell lines).
 */
async function getFulfillableItems(shopifyOrderId) {
  const fulfillmentOrders = await getFulfillmentOrders(shopifyOrderId);
  const openOrders = fulfillmentOrders.filter(fo => fo.status === 'OPEN');

  const items = [];
  for (const fo of openOrders) {
    for (const li of fo.lineItems.nodes) {
      if (li.remainingQuantity <= 0) continue;
      items.push({
        title:    li.lineItem?.title   || '—',
        variant:  li.lineItem?.variantTitle || null,
        sku:      li.lineItem?.sku     || null,
        quantity: li.remainingQuantity,
        price:    li.lineItem?.originalUnitPriceSet?.shopMoney?.amount || null,
        currency: li.lineItem?.originalUnitPriceSet?.shopMoney?.currencyCode || null,
      });
    }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Create a fulfillment with tracking info
// This marks the order as fulfilled in Shopify and sends the tracking email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createFulfillment — fulfills ALL open line items for an order.
 * Legacy / single-supplier path.
 */
async function createFulfillment({ shopifyOrderId, trackingNumber, trackingCarrier, trackingUrl }) {
  // First, get the fulfillment order IDs
  const fulfillmentOrders = await getFulfillmentOrders(shopifyOrderId);

  const openFulfillmentOrders = fulfillmentOrders.filter(fo => fo.status === 'OPEN');

  if (openFulfillmentOrders.length === 0) {
    throw new Error('No open fulfillment orders found — order may already be fulfilled.');
  }

  // Build the line items to fulfill (all remaining items)
  const fulfillmentOrderLineItems = openFulfillmentOrders.map(fo => ({
    fulfillmentOrderId: fo.id,
    fulfillmentOrderLineItems: fo.lineItems.nodes
      .filter(li => li.remainingQuantity > 0)
      .map(li => ({ id: li.id, quantity: li.remainingQuantity })),
  }));

  const mutation = `
    mutation fulfillmentCreate($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo {
            number
            url
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    fulfillment: {
      notifyCustomer: true,
      trackingInfo: {
        number:   trackingNumber,
        url:      trackingUrl || buildTrackingUrl(trackingCarrier, trackingNumber),
        company:  normalizeCarrier(trackingCarrier),
      },
      lineItemsByFulfillmentOrder: fulfillmentOrderLineItems,
    },
  };

  const data = await shopifyGraphQL(mutation, variables);
  const result = data.fulfillmentCreateV2;

  if (result.userErrors?.length > 0) {
    throw new Error(`Fulfillment errors: ${JSON.stringify(result.userErrors)}`);
  }

  return result.fulfillment;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map common carrier names to Shopify-recognised carrier strings.
 * https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentTrackingCompany
 */
function normalizeCarrier(carrier) {
  const map = {
    'dhl':      'DHL',
    'fedex':    'FedEx',
    'ups':      'UPS',
    'usps':     'USPS',
    '4px':      'FourPX',
    'yanwen':   'Yanwen',
    'sf':       'SF Express',
    'cainiao':  'Cainiao',
    'epacket':  'ePacket',
    'china post': 'China Post',
  };
  const key = (carrier || '').toLowerCase().trim();
  return map[key] || carrier;
}

/**
 * Build a tracking URL for common carriers if none is provided.
 */
function buildTrackingUrl(carrier, trackingNumber) {
  const urls = {
    'dhl':   `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    'fedex': `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
    'ups':   `https://www.ups.com/track?tracknum=${trackingNumber}`,
    'usps':  `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
  };
  const key = (carrier || '').toLowerCase().trim();
  return urls[key] || `https://parcelsapp.com/en/tracking/${trackingNumber}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup order sync
// Fetches the 5 most recent orders from the REST API and inserts any that
// are not already in the database. Runs once on server start so the dashboard
// shows real data immediately without waiting for a webhook.
// ─────────────────────────────────────────────────────────────────────────────

async function syncRecentOrders() {
  const { createOrder, getOrderByShopifyId, updateOrderStatus, updateFinancialStatus, logActivity } = require('../db/orders');

  console.log('[Sync] Initial order sync started');

  const token  = await getAccessToken();
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;

  const res = await fetch(
    `https://${domain}/admin/api/${API_VERSION}/orders.json?limit=50&status=any`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify orders fetch failed (${res.status}): ${text}`);
  }

  const { orders } = await res.json();
  console.log(`[Sync] Fetched ${orders.length} orders`);

  let inserted = 0;
  let refreshed = 0;

  for (const order of orders) {
    const shopifyOrderId     = String(order.id);
    const shopifyFinancial   = order.financial_status || 'pending';
    const existing           = getOrderByShopifyId(shopifyOrderId);

    if (existing) {
      // Refresh financial_status for any existing order whose stored value
      // differs from what Shopify currently reports. This fixes orders that
      // were synced before the financial_status column existed and received
      // the default 'pending' even though Shopify had them as partially_paid/paid.
      if (existing.financial_status !== shopifyFinancial) {
        updateFinancialStatus(existing.id, shopifyFinancial);
        console.log(`[Sync] Refreshed financial_status for ${order.name}: ${existing.financial_status} → ${shopifyFinancial}`);

        // Also advance workflow status if the order was stuck at pending
        // but Shopify confirms payment has been received
        if (existing.status === 'pending' &&
            (shopifyFinancial === 'paid' || shopifyFinancial === 'partially_paid' || shopifyFinancial === 'authorized')) {
          updateOrderStatus(existing.id, 'processing');
          logActivity(existing.id, 'status_change',
            `Status set to "processing" on startup sync (Shopify financial_status: ${shopifyFinancial})`);
          console.log(`[Sync] Advanced ${order.name} to processing (${shopifyFinancial})`);
        }

        refreshed++;
      }
      continue;
    }

    // New order — insert it
    const shippingAddress = order.shipping_address || {};
    const billingAddress  = order.billing_address  || {};
    const address = Object.keys(shippingAddress).length ? shippingAddress : billingAddress;

    const customer = order.customer || {};
    const customerName = [
      address.first_name || customer.first_name,
      address.last_name  || customer.last_name,
    ].filter(Boolean).join(' ') || order.email || 'Unknown';

    const lineItems = (order.line_items || []).map(item => ({
      id:         item.id,
      title:      item.title,
      variant:    item.variant_title   || null,
      sku:        item.sku             || null,
      vendor:     item.vendor          || null,
      product_id: item.product_id ? String(item.product_id) : null,
      quantity:   item.quantity,
    }));

    const result = createOrder({
      shopify_order_id:   shopifyOrderId,
      shopify_order_num:  order.name || `#${order.order_number}`,
      customer_name:      customerName,
      customer_email:     order.email || customer.email || null,
      customer_phone:     address.phone || order.phone  || null,
      shipping_address:   JSON.stringify(address),
      line_items:         JSON.stringify(lineItems),
      total_price:        order.total_price      || '0.00',
      currency:           order.currency         || 'USD',
      financial_status:   shopifyFinancial,
      raw_payload:        JSON.stringify(order),
      shopify_created_at: order.created_at       || null,
    });

    logActivity(result.lastInsertRowid, 'order_received', `Order ${order.name} synced on startup`);
    inserted++;
  }

  console.log(`[Sync] Inserted ${inserted} new orders, refreshed ${refreshed} existing`);
}

/**
 * Fetch a single order's current state from Shopify REST API.
 * Returns the raw Shopify order object, or null if not found.
 * Used by the admin "Sync from Shopify" endpoint to correct stale DB state.
 */
async function fetchOrderFromShopify(shopifyOrderId) {
  const token  = await getAccessToken();
  const domain = process.env.SHOPIFY_SHOP_DOMAIN;

  const res = await fetch(
    `https://${domain}/admin/api/${API_VERSION}/orders/${shopifyOrderId}.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify order fetch failed (${res.status}): ${text}`);
  }

  const { order } = await res.json();
  return order;
}

/**
 * createFulfillmentForLineItems — fulfills only the specified Shopify line items.
 * Used for per-supplier fulfillment in the multi-supplier flow.
 *
 * @param {string}   shopifyOrderId      — numeric Shopify order ID (as string)
 * @param {string[]} shopifyLineItemIds  — array of numeric Shopify line item IDs (as strings)
 * @param {Object}   tracking            — { trackingNumber, trackingCarrier, trackingUrl }
 */
async function createFulfillmentForLineItems(shopifyOrderId, shopifyLineItemIds, { trackingNumber, trackingCarrier, trackingUrl }) {
  const fulfillmentOrders = await getFulfillmentOrders(shopifyOrderId);
  const openOrders        = fulfillmentOrders.filter(fo => fo.status === 'OPEN');

  if (!openOrders.length) {
    throw new Error('No open fulfillment orders found.');
  }

  // Shopify line item IDs in fulfillment order nodes are global IDs:
  // gid://shopify/LineItem/1234567890
  // The shopifyLineItemIds we store are the numeric part.
  const targetSet = new Set(shopifyLineItemIds.map(String));

  const fulfillmentOrderLineItems = [];

  for (const fo of openOrders) {
    const matchedItems = fo.lineItems.nodes.filter(li => {
      // li.lineItem.id = "gid://shopify/LineItem/1234567890"
      const numericId = (li.lineItem?.id || '').split('/').pop();
      return targetSet.has(numericId) && li.remainingQuantity > 0;
    });

    if (matchedItems.length) {
      fulfillmentOrderLineItems.push({
        fulfillmentOrderId:        fo.id,
        fulfillmentOrderLineItems: matchedItems.map(li => ({
          id:       li.id,
          quantity: li.remainingQuantity,
        })),
      });
    }
  }

  if (!fulfillmentOrderLineItems.length) {
    throw new Error('None of the specified line items were found in open fulfillment orders.');
  }

  const mutation = `
    mutation fulfillmentCreate($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo { number url }
        }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    fulfillment: {
      notifyCustomer: true,
      trackingInfo: {
        number:  trackingNumber,
        url:     trackingUrl || buildTrackingUrl(trackingCarrier, trackingNumber),
        company: normalizeCarrier(trackingCarrier),
      },
      lineItemsByFulfillmentOrder: fulfillmentOrderLineItems,
    },
  };

  const data   = await shopifyGraphQL(mutation, variables);
  const result = data.fulfillmentCreateV2;

  if (result.userErrors?.length) {
    throw new Error(`Fulfillment errors: ${JSON.stringify(result.userErrors)}`);
  }

  return result.fulfillment;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fulfillment Service + Inventory management
//
// REQUIRED SHOPIFY APP SCOPES (add in Partner Dashboard → App → Configuration):
//   write_fulfillments   ← create / manage fulfillment services
//   read_products        ← look up product variants by SKU
//   read_inventory       ← read inventory levels
//   write_inventory      ← set inventory quantities at a location
//
// After adding scopes: uninstall and reinstall the app to reauthorize.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createFulfillmentService(supplierName)
 * Creates a Shopify Fulfillment Service for a supplier and returns the
 * service ID + the auto-created location ID.
 *
 * The location ID is what we reference when setting inventory levels.
 * inventory_management:false means Shopify will NOT poll our callback URL
 * for inventory data — we push inventory to Shopify instead.
 */
async function createFulfillmentService(supplierName) {
  const token    = await getAccessToken();
  const appUrl   = process.env.APP_URL || 'http://localhost:3000';
  const safeName = supplierName.trim().substring(0, 50);

  console.log(`[Shopify] Creating fulfillment service for "${safeName}"`);

  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/fulfillment_services.json`,
    {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fulfillment_service: {
          name:                     `${safeName} Warehouse`,
          callback_url:             `${appUrl}/webhooks/fulfillment-service`,
          inventory_management:     false, // we push inventory; Shopify won't poll us
          tracking_support:         false, // we push fulfillments via API directly
          requires_shipping_method: false,
          format:                   'json',
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify fulfillment service creation failed (${res.status}): ${text}`);
  }

  const { fulfillment_service } = await res.json();
  console.log(`[Shopify] Fulfillment service created: id=${fulfillment_service.id} location_id=${fulfillment_service.location_id}`);

  return {
    serviceId:  String(fulfillment_service.id),
    locationId: String(fulfillment_service.location_id),
    name:       fulfillment_service.name,
  };
}

/**
 * getInventoryItemBySku(sku)
 * Looks up the Shopify product variant and inventory item ID for a given SKU.
 * Returns null if no variant with that exact SKU exists.
 * Scope required: read_products
 */
async function getInventoryItemBySku(sku) {
  const query = `
    query findBySku($q: String!) {
      productVariants(first: 5, query: $q) {
        nodes {
          id
          sku
          displayName
          inventoryItem {
            id
          }
        }
      }
    }
  `;

  const data  = await shopifyGraphQL(query, { q: `sku:'${sku}'` });
  const nodes = data.productVariants?.nodes || [];

  // GraphQL search can return partial matches — enforce exact SKU comparison
  const exact = nodes.find(v => v.sku === sku);
  if (!exact) return null;

  return {
    variantId:        exact.id.split('/').pop(),
    productTitle:     exact.displayName || null,
    inventoryItemId:  exact.inventoryItem?.id?.split('/').pop() || null,
  };
}

/**
 * activateInventoryAtLocation(inventoryItemId, locationId)
 * Connects an inventory item to a location so it can be tracked there.
 * Must be called before setInventoryLevel for a new location.
 * Safe to call repeatedly — 422 (already connected) is treated as success.
 * Scope required: write_inventory
 */
async function activateInventoryAtLocation(inventoryItemId, locationId) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/inventory_levels/connect.json`,
    {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id:           Number(locationId),
        inventory_item_id:     Number(inventoryItemId),
        relocate_if_necessary: false,
      }),
    }
  );

  if (res.status === 422) {
    // Already connected — not an error
    console.log(`[Shopify] Inventory item ${inventoryItemId} already active at location ${locationId}`);
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to connect inventory item ${inventoryItemId} to location ${locationId} (${res.status}): ${text}`);
  }

  console.log(`[Shopify] Inventory item ${inventoryItemId} connected to location ${locationId}`);
}

/**
 * setInventoryLevel(inventoryItemId, locationId, quantity)
 * Sets the absolute "available" quantity for an inventory item at a location.
 * Automatically activates the item at the location if not already tracked.
 * Scope required: write_inventory
 */
async function setInventoryLevel(inventoryItemId, locationId, quantity) {
  // Ensure the item is tracked at this location first
  await activateInventoryAtLocation(inventoryItemId, locationId);

  const token = await getAccessToken();

  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/inventory_levels/set.json`,
    {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location_id:       Number(locationId),
        inventory_item_id: Number(inventoryItemId),
        available:         Number(quantity),
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to set inventory level (${res.status}): ${text}`);
  }

  const { inventory_level } = await res.json();
  console.log(`[Shopify] Inventory set: item=${inventoryItemId} location=${locationId} available=${inventory_level.available}`);
  return inventory_level;
}

module.exports = {
  shopifyGraphQL,
  getFulfillmentOrders,
  getFulfillableItems,
  createFulfillment,
  createFulfillmentForLineItems,
  syncRecentOrders,
  fetchOrderFromShopify,
  createFulfillmentService,
  getInventoryItemBySku,
  activateInventoryAtLocation,
  setInventoryLevel,
};
