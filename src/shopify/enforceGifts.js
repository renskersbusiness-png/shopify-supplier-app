/**
 * shopify/enforceGifts.js
 * SERVER-SIDE GUARANTEE for the free gifts (screen + remote).
 *
 * This is the single source of truth that makes the ORDER correct before
 * fulfilment, regardless of cart-side chaos (AOV + custom buy-now + races can
 * leave 0, 1 or 2 gifts in the cart). On orders/create we normalise via Order
 * Edit so the shipped order ALWAYS has exactly:
 *   - Free 120" Screen (variant 54202293911894): max 1 if a Pro Elite/Ultra is
 *     present, else 0.
 *   - Free Smart Remote (variant 54208001147222): 1 per Pro Max unit, else 0.
 *
 * Adds when missing (covers express Shop Pay that bypasses the cart) AND
 * removes/caps extras (covers the buy-now + AOV double-add). $0 variants, so
 * the order total never changes. Idempotent (no-op when already correct).
 *
 * Replaces freeScreen.js + freeRemote.js (which only added-if-missing).
 */

const { shopifyGraphQL } = require('./client');

const SCREEN_VARIANT_ID = 54202293911894;
const REMOTE_VARIANT_ID = 54208001147222;
const SCREEN_GID = `gid://shopify/ProductVariant/${SCREEN_VARIANT_ID}`;
const REMOTE_GID = `gid://shopify/ProductVariant/${REMOTE_VARIANT_ID}`;

const SCREEN_QUALIFIERS = [10319535178070, 10541128778070]; // Pro Elite, Pro Ultra
const PROMAX_QUALIFIERS = [9420182225238, 9414792085846];   // Pro Max (active + draft)
const REAL_SCREEN_PRODUCT = 10574046265686;                 // betaalde 120" screen (origineel)

const sum = (arr) => arr.reduce((s, n) => s + n, 0);

async function enforceGifts(shopifyOrderId, lineItems = []) {
  const items = lineItems || [];
  const units = (ids) => sum(items.filter(li => ids.includes(Number(li.product_id))).map(li => Number(li.quantity || 0)));
  const have  = (vid) => sum(items.filter(li => Number(li.variant_id) === vid).map(li => Number(li.quantity || 0)));

  // SUMMER SALE 2026 (2026-07-20): gratis 120" scherm VERVALLEN.
  // screenAllowed=0 → nooit een gift-scherm toevoegen, en een evt. door cart/AOV
  // toegevoegd gift-scherm (variant 54202293911894) wordt juist verwijderd, zodat
  // geen order meer met gratis scherm verzendt. Betaalde schermen (ander product) blijven.
  // De Smart Remote (Pro Max) blijft ongewijzigd. Herstel de oude if/else hieronder om
  // het gratis scherm te heractiveren:
  //   if (units(SCREEN_QUALIFIERS) === 0) screenAllowed = 0;
  //   else if (units([REAL_SCREEN_PRODUCT]) > 0) screenAllowed = Math.min(have(SCREEN_VARIANT_ID), 1);
  //   else screenAllowed = 1;
  const screenAllowed = 0;
  const remoteAllowed = units(PROMAX_QUALIFIERS);             // remote = 1 per Pro Max
  const screenHave = have(SCREEN_VARIANT_ID);
  const remoteHave = have(REMOTE_VARIANT_ID);

  if (screenHave === screenAllowed && remoteHave === remoteAllowed) {
    return { skipped: 'gifts-correct', screenHave, screenAllowed, remoteHave, remoteAllowed };
  }

  const orderGID = `gid://shopify/Order/${shopifyOrderId}`;
  const begin = await shopifyGraphQL(
    `mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id lineItems(first:100){ edges{ node{ id quantity variant{ id } } } } } userErrors{ field message } } }`,
    { id: orderGID },
  );
  const co = begin.orderEditBegin && begin.orderEditBegin.calculatedOrder;
  if (!co || !co.id) {
    throw new Error('orderEditBegin failed: ' + JSON.stringify(begin.orderEditBegin && begin.orderEditBegin.userErrors));
  }
  const calcId = co.id;
  const calcLines = ((co.lineItems && co.lineItems.edges) || []).map(e => e.node);

  const adds = []; // {variant, qty}
  const sets = []; // {lineId, qty}

  const plan = (gid, haveQty, allowed) => {
    if (allowed > haveQty) {
      adds.push({ variant: gid, qty: allowed - haveQty });
    } else if (allowed < haveQty) {
      let remaining = allowed;
      for (const ln of calcLines.filter(n => n.variant && n.variant.id === gid)) {
        const setTo = Math.min(ln.quantity, remaining);
        remaining -= setTo;
        if (setTo !== ln.quantity) sets.push({ lineId: ln.id, qty: setTo });
      }
    }
  };
  plan(SCREEN_GID, screenHave, screenAllowed);
  plan(REMOTE_GID, remoteHave, remoteAllowed);

  if (!adds.length && !sets.length) return { skipped: 'no-actions' };

  for (const a of adds) {
    const r = await shopifyGraphQL(
      `mutation($id:ID!,$v:ID!,$q:Int!){ orderEditAddVariant(id:$id, variantId:$v, quantity:$q, allowDuplicates:false){ userErrors{ field message } } }`,
      { id: calcId, v: a.variant, q: a.qty },
    );
    const e = r.orderEditAddVariant && r.orderEditAddVariant.userErrors;
    if (e && e.length) throw new Error('orderEditAddVariant: ' + JSON.stringify(e));
  }
  for (const s of sets) {
    const r = await shopifyGraphQL(
      `mutation($id:ID!,$l:ID!,$q:Int!){ orderEditSetQuantity(id:$id, lineItemId:$l, quantity:$q, restock:false){ userErrors{ field message } } }`,
      { id: calcId, l: s.lineId, q: s.qty },
    );
    const e = r.orderEditSetQuantity && r.orderEditSetQuantity.userErrors;
    if (e && e.length) throw new Error('orderEditSetQuantity: ' + JSON.stringify(e));
  }

  const commit = await shopifyGraphQL(
    `mutation($id:ID!){ orderEditCommit(id:$id, notifyCustomer:false, staffNote:"Gifts enforced (screen=max1 if Elite/Ultra, remote=1 per Pro Max) by supplier-app"){ order{ id } userErrors{ field message } } }`,
    { id: calcId },
  );
  const ce = commit.orderEditCommit && commit.orderEditCommit.userErrors;
  if (ce && ce.length) throw new Error('orderEditCommit: ' + JSON.stringify(ce));

  return { enforced: true, screenHave, screenAllowed, remoteHave, remoteAllowed, added: adds.length, capped: sets.length };
}

module.exports = { enforceGifts };
