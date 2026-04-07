# Shopify Supplier App

> Order management middleware for Shopify dropshipping.
> Receives orders via webhook → stores in dashboard → lets you add tracking → fulfills back to Shopify.

---

## Architecture

```
Customer orders on Shopify
     ↓
Shopify fires orders/create webhook
     ↓
This app receives + stores order
     ↓
You review in dashboard
     ↓
You process order with supplier (email/manual)
     ↓
Supplier ships → you receive tracking number
     ↓
You enter tracking in dashboard
     ↓
App pushes fulfillment to Shopify via GraphQL API
     ↓
Customer receives shipping notification email
```

---

## Quick Start

### 1. Clone & install

```bash
git clone <your-repo>
cd shopify-supplier-app
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id_here
SHOPIFY_CLIENT_SECRET=your_client_secret_here
DASHBOARD_PASSWORD=pick_a_strong_password
SESSION_SECRET=pick_a_long_random_string
NODE_ENV=development
```

See [Setting Up Shopify](#setting-up-shopify) below for where to find `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.

### 3. Initialize the database

```bash
npm run setup-db
```

### 4. Start the server

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

Open http://localhost:3000 — you'll see the login page.

---

## Setting Up Shopify

This app uses the **OAuth 2.0 client credentials grant** as supported by apps created in the **Shopify Dev Dashboard**. It fetches an Admin API access token automatically at startup — no manual token generation or copy-pasting required.

> **Dev Dashboard vs Custom App**: This is _not_ a Shopify Admin custom app (Settings → Apps → Develop apps). Those use a static access token. This app requires a Dev Dashboard app, which issues a `client_id` and `client_secret` and supports the `client_credentials` grant.

### Step 1: Create an app in the Shopify Dev Dashboard

1. Go to the [Shopify Dev Dashboard](https://shopify.dev/dashboard) and sign in
2. Select your Partner organisation (or create one)
3. Click **Create app** → give it a name (e.g. "Supplier Middleware")
4. Under **App setup**, note the **Client ID** and **Client secret** — you will need these in Step 4

### Step 2: Configure Admin API scopes

In your app's settings, open **Configuration** → **Admin API integration** and enable:

- `read_orders`
- `write_orders`
- `read_fulfillments`
- `write_fulfillments`

Click **Save**.

### Step 3: Install the app on your store

1. In your app's settings, go to **Test on development store** (or **Select store**)
2. Choose your store and click **Install app**
3. Approve the requested permissions

### Step 4: Copy your credentials into `.env`

From your app's **API credentials** page:

- **Client ID** → `SHOPIFY_CLIENT_ID`
- **Client secret** → `SHOPIFY_CLIENT_SECRET`

The app calls `POST /admin/oauth/access_token` with `grant_type=client_credentials` on startup to obtain a token. No token needs to be copied manually.

### Step 5: Register the webhook

1. In your app settings, go to **Configuration** → **Webhooks**
2. Click **Create webhook** and set:
   - **Event**: `Order creation`
   - **Format**: JSON
   - **URL**: `https://your-deployed-app.railway.app/webhooks/orders/create`
   - **API version**: `2024-01` (matches the version used by this app's GraphQL client)
3. Click **Save**

> Webhook HMAC signatures are signed with your **Client secret** — no separate webhook signing secret is needed.

---

## Deployment

### Option A: Railway (Recommended)

1. Push your code to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo
4. Add environment variables in the Railway dashboard (same as `.env`)
5. Deploy — Railway will auto-detect Node.js and use `railway.toml`

Your webhook URL will be: `https://your-app.up.railway.app/webhooks/orders/create`

### Option B: Render

1. Push to GitHub
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your repo
4. Set:
   - **Build command**: `npm install`
   - **Start command**: `node src/db/setup.js && node src/server.js`
5. Add environment variables
6. Deploy

### Option C: Local (with ngrok for testing)

```bash
# Install ngrok
npm install -g ngrok

# Start your app
npm run dev

# In another terminal, expose it publicly
ngrok http 3000
```

Use the ngrok URL as your Shopify webhook URL.

---

## Testing

### Test the webhook manually

```bash
node scripts/test-webhook.js
```

This simulates a Shopify `orders/create` webhook, signing the payload with `SHOPIFY_CLIENT_SECRET`.

Or send a test from Shopify: Settings → Notifications → Webhooks → send test notification.

### Test fulfillment

1. Create a test order in your Shopify store
2. Wait for it to appear in the dashboard (should be instant)
3. Click the order → Mark as Processing
4. Add a fake tracking number (e.g. carrier: UPS, number: 1Z999AA10123456784)
5. Click "Fulfill in Shopify"
6. Check your Shopify admin — the order should show as fulfilled
7. Check the customer email — they should get a tracking notification

---

## Dashboard Walkthrough

| Feature | How to use |
|---------|-----------|
| View all orders | Homepage — sorted newest first |
| Filter by status | Click sidebar nav items or stat cards |
| Search | Type in search box (searches order #, name, email) |
| Mark processing | Open order → "Mark Processing" button |
| Add tracking | Open order → fill tracking form → Save |
| Fulfill in Shopify | Open order (must have tracking) → "Fulfill in Shopify" |
| Internal notes | Open order → Notes section → Save |
| Activity log | Open order → scroll to Activity Log |

---

## Project Structure

```
shopify-supplier-app/
├── src/
│   ├── server.js              # Express app entry point
│   ├── db/
│   │   ├── setup.js           # DB schema creation (run once)
│   │   ├── connection.js      # SQLite connection singleton
│   │   └── orders.js          # All DB queries
│   ├── routes/
│   │   ├── webhook.js         # Shopify webhook handler (HMAC verified)
│   │   ├── api.js             # REST API for dashboard
│   │   └── dashboard.js       # HTML page routes + login
│   ├── middleware/
│   │   └── auth.js            # Session-based dashboard auth
│   └── shopify/
│       ├── auth.js            # OAuth client credentials token flow
│       └── client.js          # Shopify GraphQL API client
├── public/
│   └── index.html             # Dashboard single-page app
├── scripts/
│   └── test-webhook.js        # Simulate a webhook locally
├── data/                      # SQLite DB lives here (auto-created)
├── .env.example               # Environment variable template
├── railway.toml               # Railway deployment config
└── package.json
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | Yes | `yourstore.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Yes | Client ID from Shopify Dev Dashboard → App → API credentials |
| `SHOPIFY_CLIENT_SECRET` | Yes | Client secret — used for token requests and webhook HMAC |
| `DASHBOARD_PASSWORD` | Yes | Password to log into the supplier dashboard |
| `SESSION_SECRET` | Yes | Long random string for signing session cookies |
| `NODE_ENV` | Optional | Set to `production` for secure HTTPS-only cookies |
| `PORT` | Optional | HTTP port (default: 3000) |
| `DB_PATH` | Optional | SQLite file path (default: `./data/orders.db`) |

---

## Authentication Flow

The app uses the **OAuth 2.0 client credentials grant** — no user login to Shopify required:

```
App starts → getAccessToken() called
     ↓
POST https://{shop}.myshopify.com/admin/oauth/access_token
{ client_id, client_secret, grant_type: "client_credentials" }
     ↓
Token cached in memory for process lifetime
     ↓
All GraphQL requests use cached token
If 401 received → cache cleared → token re-fetched once
```

Webhook HMAC verification uses `SHOPIFY_CLIENT_SECRET` directly — no separate webhook signing secret is needed.

---

## Phase 2 Roadmap

### Email automation
- Use `nodemailer` to auto-send order details to supplier on "Mark Processing"

### CSV export
- Add `/api/orders/export.csv` endpoint

### Google Sheets integration
- Write new orders to a shared sheet; read tracking back from it

### Supplier API
- Add `POST /api/orders/:id/send-to-supplier` when supplier exposes an API

### Scaling (100+ orders/day)
- Swap SQLite for PostgreSQL
- Add a job queue (BullMQ + Redis) for webhook processing

---

## Security Notes

- Webhook HMAC verification prevents fake webhook injection
- Dashboard password uses timing-safe comparison (no timing attacks)
- Session cookies are HttpOnly + Secure in production
- `.env` is gitignored — never commit your secrets
