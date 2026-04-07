/**
 * shopify/client.js
 * All Shopify API communication.
 * Uses the Admin GraphQL API to create fulfillments and update tracking.
 *
 * Access tokens are obtained programmatically via the client credentials
 * grant (see shopify/auth.js) — no hardcoded SHOPIFY_ACCESS_TOKEN needed.
 */

const fetch  = require('node-fetch');
const { getAccessToken, clearTokenCache } = require('./auth');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const API_VERSION    = '2024-01'; // Bump this annually

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
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Get the fulfillment order ID for a given Shopify order
// (Required before creating a fulfillment)
// ─────────────────────────────────────────────────────────────────────────────

async function getFulfillmentOrders(shopifyOrderId) {
  const query = `
    query getFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        name
        fulfillmentOrders(first: 5) {
          nodes {
            id
            status
            lineItems(first: 20) {
              nodes {
                id
                remainingQuantity
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

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Create a fulfillment with tracking info
// This marks the order as fulfilled in Shopify and sends the tracking email
// ─────────────────────────────────────────────────────────────────────────────

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

module.exports = {
  shopifyGraphQL,
  getFulfillmentOrders,
  createFulfillment,
};
