# Focus Guard — billing API

Node.js service for **Stripe Checkout** (monthly subscription + one-time “lifetime”), **webhooks**, **SQLite** entitlements keyed by anonymous `extension_user_id`, and **promo codes**.

## Security

- **Never** put `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` in the extension. Only this server uses them.
- Copy `.env.example` → `.env` and keep `.env` out of git.
- Optional: set `BILLING_CLIENT_SECRET` and the same value in the extension `billing-config.js` (`X-FocusGuard-Client` header).
- Use **HTTPS** in production and a real `PUBLIC_BASE_URL` (your deployed API origin, no trailing slash).

## Local setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env: STRIPE_SECRET_KEY, STRIPE_PRICE_SUBSCRIPTION, STRIPE_PRICE_ONETIME,
# STRIPE_WEBHOOK_SECRET (after stripe listen), PUBLIC_BASE_URL
npm run dev
```

Default port: **8787**.

### Stripe Dashboard

1. Create two **Prices**: recurring (e.g. monthly) and one-time (lifetime).
2. Put Price IDs in `.env` as `STRIPE_PRICE_SUBSCRIPTION` and `STRIPE_PRICE_ONETIME`.
3. Webhooks: for local testing, run:

   ```bash
   stripe listen --forward-to localhost:8787/api/webhooks/stripe
   ```

   Paste the signing secret into `STRIPE_WEBHOOK_SECRET`.

4. For production, add endpoint `https://your-api.example.com/api/webhooks/stripe` and use that webhook secret.

### Extension

In `social-blocker-extension/billing-config.js`, set:

- `BILLING_API_BASE` to `http://127.0.0.1:8787` locally or your production API URL.

### Promo codes

- Seed on first empty DB: `PROMO_SEED_CODES=CODE1:100,CODE2:50` in `.env` (max redemptions after colon).
- Or insert manually:

  ```sql
  INSERT INTO promo_codes (code, max_redemptions, active) VALUES ('EARLYBIRD', 500, 1);
  ```

  (Use the SQLite file under `backend/data/billing.db`.)

## Production checklist

- Deploy API with TLS.
- Set `PUBLIC_BASE_URL` to that origin.
- Configure live Stripe keys and live webhook endpoint.
- Restrict CORS if needed (current config reflects `Origin` for browser calls).
- Back up `data/billing.db` or migrate to Postgres for multi-instance hosting.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| GET | `/api/entitlements/:extensionUserId` | `{ subscribed: boolean }` |
| POST | `/api/checkout` | Body: `{ extensionUserId, mode: "subscription" \| "payment" }` → `{ url }` |
| POST | `/api/redeem-promo` | Body: `{ extensionUserId, code }` |
| POST | `/api/webhooks/stripe` | Raw body, Stripe signature |

Checkout success/cancel pages: `GET /checkout/return`, `GET /checkout/cancel`.
