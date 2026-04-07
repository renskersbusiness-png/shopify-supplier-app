# 📦 Shopify Supplier App

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
SHOPIFY_ACCESS_TOKEN=shpat_...
SHOPIFY_WEBHOOK_SECRET=your_secret
DASHBOARD_PASSWORD=pick_a_strong_password
SESSION_SECRET=pick_a_long_random_string
```

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

### Step 1: Create a Custom App

1. Go to your Shopify Admin → **Settings** → **Apps and sales channels**
2. Click **Develop apps**
3. Click **Create an app**
4. Name it (e.g. "Supplier Middleware")
5. Click **Configure Admin API scopes**

### Step 2: Set Required API Scopes

Select these scopes:
- ✅ `read_orders` — read order data
- ✅ `write_orders` — update order status
- ✅ `read_fulfillments` — read fulfillment status
- ✅ `write_fulfillments` — create fulfillments (push tracking)

Click **Save**.

### Step 3: Install the App

1. Click **Install app**
2. Copy the **Admin API access token** → paste into `.env` as `SHOPIFY_ACCESS_TOKEN`
3. Copy your shop domain (e.g. `yourstore.myshopify.com`) → paste into `.env` as `SHOPIFY_SHOP_DOMAIN`

### Step 4: Configure Webhook

1. In your Shopify admin, go to **Settings** → **Notifications** → scroll to **Webhooks**
   - OR in your custom app → **Configuration** → **Webhooks**
2. Click **Create webhook**
3. Set:
   - **Event**: `Order creation`
   - **Format**: JSON
   - **URL**: `https://your-deployed-app.railway.app/webhooks/orders/create`
   - **Webhook API version**: `2024-01`
4. Click **Save**
5. Copy the **Signing secret** → paste into `.env` as `SHOPIFY_WEBHOOK_SECRET`

---

## Deployment

### Option A: Railway (Recommended — free tier available)

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
# You'll need your webhook secret to generate a valid HMAC
# Use this script to simulate an order webhook:

node scripts/test-webhook.js
```

Or send a test order from Shopify (Settings → Notifications → Webhooks → send test notification).

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
│       └── client.js          # Shopify GraphQL API client
├── public/
│   └── index.html             # Dashboard single-page app
├── data/                      # SQLite DB lives here (auto-created)
├── .env.example               # Environment variable template
├── railway.toml               # Railway deployment config
└── package.json
```

---

## Phase 2 Roadmap

When your order volume grows or your supplier gets more capabilities:

### Email automation
- Use `nodemailer` to auto-send order details to supplier on "Mark Processing"
- Template the email with order items, customer address, SKUs

### CSV export
- Add `/api/orders/export.csv` endpoint
- Auto-generate and email CSV to supplier daily/on-demand

### Google Sheets integration
- Use Google Sheets API to write new orders to a shared sheet
- Supplier can view/update sheet — you read tracking back from it

### Supplier API (when available)
- Add a `POST /api/orders/:id/send-to-supplier` endpoint
- Replace manual step with direct API call to supplier system
- Zero code changes to the rest of the app

### Scaling (100+ orders/day)
- Swap SQLite for PostgreSQL (change `better-sqlite3` to `pg`, minimal query changes)
- Add a job queue (BullMQ + Redis) for webhook processing
- Add email alerts for stuck orders (no tracking after N days)
- Add multi-user support (per-user sessions)

---

## Security Notes

- Webhook HMAC verification prevents fake webhook injection
- Dashboard password uses timing-safe comparison (no brute-force timing attacks)
- Session cookies are HttpOnly + Secure in production
- `.env` is gitignored — never commit your secrets
- Raw webhook body is stored in DB for debugging — consider purging old entries

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | ✅ | `yourstore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | ✅ | Admin API token from custom app |
| `SHOPIFY_WEBHOOK_SECRET` | ✅ | Webhook signing secret |
| `DASHBOARD_PASSWORD` | ✅ | Password to log into dashboard |
| `SESSION_SECRET` | ✅ | Long random string for session signing |
| `PORT` | Optional | Default: 3000 |
| `DB_PATH` | Optional | Default: `./data/orders.db` |
| `NODE_ENV` | Optional | Set to `production` for HTTPS cookies |
