/**
 * shopify/auth.js
 * Fetches and caches an Admin API access token using the OAuth 2.0
 * client credentials grant (for Dev Dashboard apps).
 *
 * Shopify endpoint (requires application/x-www-form-urlencoded, NOT JSON):
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *   grant_type=client_credentials&client_id=...&client_secret=...
 *
 * Tokens expire in 86 399 seconds (~24 hours). We track the expiry
 * and proactively refresh 5 minutes before it lapses so requests are
 * never sent with a stale token. On an unexpected 401 the caller can
 * call clearTokenCache() and retry once as a safety net.
 *
 * Refs:
 *   https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */

const fetch = require('node-fetch');

let cachedToken  = null;
let tokenExpiresAt = 0; // Unix timestamp in ms

async function getAccessToken() {
  const now = Date.now();
  // Return cached token if it still has more than 5 minutes of life left
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const domain       = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      'Missing required env vars: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET'
    );
  }

  // Shopify requires application/x-www-form-urlencoded, not JSON
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(
    `https://${domain}/admin/oauth/access_token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`Shopify token response missing access_token: ${JSON.stringify(data)}`);
  }

  cachedToken    = data.access_token;
  // expires_in is in seconds; default to 24 h if absent
  const expiresIn = (data.expires_in || 86399) * 1000;
  tokenExpiresAt  = Date.now() + expiresIn;

  console.log(
    `[Shopify Auth] Access token fetched and cached. ` +
    `Expires in ${Math.round(expiresIn / 60000)} minutes.`
  );
  return cachedToken;
}

function clearTokenCache() {
  cachedToken    = null;
  tokenExpiresAt = 0;
}

module.exports = { getAccessToken, clearTokenCache };
