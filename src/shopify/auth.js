/**
 * shopify/auth.js
 * Fetches and caches an Admin API access token using the OAuth 2.0
 * client credentials grant (for Dev Dashboard / Partner-created apps).
 *
 * Shopify endpoint:
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *   { client_id, client_secret, grant_type: "client_credentials" }
 *
 * The returned offline access token does not expire, so we cache it
 * in memory for the lifetime of the process. If we ever receive a 401
 * from the Admin API, the caller should call clearTokenCache() and
 * retry once to handle the rare case where Shopify rotates the token.
 */

const fetch = require('node-fetch');

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken) return cachedToken;

  const domain       = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      'Missing required env vars: SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET'
    );
  }

  const res = await fetch(
    `https://${domain}/admin/oauth/access_token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'client_credentials',
      }),
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

  cachedToken = data.access_token;
  console.log('[Shopify Auth] Access token fetched and cached.');
  return cachedToken;
}

function clearTokenCache() {
  cachedToken = null;
}

module.exports = { getAccessToken, clearTokenCache };
