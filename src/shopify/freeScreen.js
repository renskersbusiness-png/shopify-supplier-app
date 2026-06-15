/**
 * shopify/freeScreen.js
 * SAFETY NET for the WC free-gift screen.
 *
 * Normal path: the AOV app adds the $0 "Free 120\" Projection Screen" to the
 * CART when a qualifying projector is present, so it flows to checkout + DSers.
 *
 * Edge case this covers: express Shop Pay launched DIRECTLY from the product
 * page bypasses the cart entirely, so AOV never runs and the order has the
 * projector but NO screen — DSers then can't fulfil the gift.
 *
 * This function checks an order: if it contains Pro Elite or Pro Ultra but the
 * screen is missing, it adds the $0 gift variant via Order Edit so DSers picks
 * it up. Idempotent (skips if a screen line is already present — normal cart
 * checkouts already have it, no double-add). Revenue-safe: the gift variant is
 * $0, so the order total is unchanged.
 */

const { shopifyGraphQL } = require('./client');

const FREE_SCREEN_VARIANT_GID = 'gid://shopify/ProductVariant/54202293911894'; // $0 "Free 120 Projection Screen" dupe
const QUALIFYING_PRODUCT_IDS  = [10319535178070, 10541128778070]; // Pro Elite, Pro Ultra
const SCREEN_PRODUCT_IDS      = [10860309348694, 10574046265686]; // free-gift dupe + original 120" screen

async function addFreeScreenIfMissing(shopifyOrderId, lineItems = []) {
  const productIds = (lineItems || []).map(li => Number(li.product_id)).filter(Boolean);
  const hasProjector = productIds.some(id => QUALIFYING_PRODUCT_IDS.includes(id));
  const hasScreen    = productIds.some(id => SCREEN_PRODUCT_IDS.includes(id));

  if (!hasProjector) return { skipped: 'no-qualifying-projector' };
  if (hasScreen)     return { skipped: 'screen-already-present' };

  const orderGID = `gid://shopify/Order/${shopifyOrderId}`;

  const begin = await shopifyGraphQL(
    `mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id } userErrors{ field message } } }`,
    { id: orderGID },
  );
  const calcId = begin.orderEditBegin && begin.orderEditBegin.calculatedOrder && begin.orderEditBegin.calculatedOrder.id;
  if (!calcId) {
    throw new Error('orderEditBegin failed: ' + JSON.stringify(begin.orderEditBegin && begin.orderEditBegin.userErrors));
  }

  const add = await shopifyGraphQL(
    `mutation($id:ID!,$v:ID!){ orderEditAddVariant(id:$id, variantId:$v, quantity:1, allowDuplicates:false){ calculatedOrder{ id } userErrors{ field message } } }`,
    { id: calcId, v: FREE_SCREEN_VARIANT_GID },
  );
  const addErr = add.orderEditAddVariant && add.orderEditAddVariant.userErrors;
  if (addErr && addErr.length) throw new Error('orderEditAddVariant: ' + JSON.stringify(addErr));

  const commit = await shopifyGraphQL(
    `mutation($id:ID!){ orderEditCommit(id:$id, notifyCustomer:false, staffNote:"Free 120 inch Projection Screen auto-added (express-checkout safety net)"){ order{ id } userErrors{ field message } } }`,
    { id: calcId },
  );
  const commitErr = commit.orderEditCommit && commit.orderEditCommit.userErrors;
  if (commitErr && commitErr.length) throw new Error('orderEditCommit: ' + JSON.stringify(commitErr));

  return { added: true, orderId: shopifyOrderId };
}

module.exports = { addFreeScreenIfMissing };
