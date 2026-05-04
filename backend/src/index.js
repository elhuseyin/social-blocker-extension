/**
 * Focus Guard billing API — Stripe Checkout + webhooks + promo redemption.
 * Secret keys only in process.env (see .env.example).
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import * as db from "./db.js";
import { handleStripeEvent, verifyWebhook } from "./stripe-handlers.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_SUBSCRIPTION = process.env.STRIPE_PRICE_SUBSCRIPTION || "";
const STRIPE_PRICE_ONETIME = process.env.STRIPE_PRICE_ONETIME || "";
const BILLING_CLIENT_SECRET = process.env.BILLING_CLIENT_SECRET || "";

if (!STRIPE_SECRET_KEY) {
  console.warn("[billing] STRIPE_SECRET_KEY is missing — checkout will fail until set.");
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

db.ensurePromoSeed(process.env.PROMO_SEED_CODES || "");

const app = express();

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-FocusGuard-Client"]
  })
);

function requireClientSecret(req, res, next) {
  if (!BILLING_CLIENT_SECRET) return next();
  const sent = req.get("X-FocusGuard-Client");
  if (sent !== BILLING_CLIENT_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "focus-guard-billing" });
});

app.get("/api/entitlements/:extensionUserId", requireClientSecret, (req, res) => {
  const id = req.params.extensionUserId;
  if (!id || id.length > 128) {
    return res.status(400).json({ error: "invalid_id" });
  }
  res.json({ subscribed: db.isPremium(id) });
});

app.post("/api/checkout", checkoutLimiter, requireClientSecret, express.json(), async (req, res) => {
  try {
    const { extensionUserId, mode } = req.body || {};
    if (!extensionUserId || typeof extensionUserId !== "string" || extensionUserId.length > 128) {
      return res.status(400).json({ error: "invalid_extension_user_id" });
    }
    if (mode !== "subscription" && mode !== "payment") {
      return res.status(400).json({ error: "invalid_mode" });
    }

    const priceId =
      mode === "subscription" ? STRIPE_PRICE_SUBSCRIPTION : STRIPE_PRICE_ONETIME;
    if (!priceId) {
      return res.status(500).json({ error: "price_not_configured" });
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PUBLIC_BASE_URL}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/checkout/cancel`,
      client_reference_id: extensionUserId,
      metadata: { extension_user_id: extensionUserId },
      allow_promotion_codes: true,
      automatic_tax: { enabled: false }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing] checkout error:", err.message || err);
    res.status(500).json({ error: "checkout_failed" });
  }
});

app.post("/api/redeem-promo", redeemLimiter, requireClientSecret, express.json(), (req, res) => {
  const { extensionUserId, code } = req.body || {};
  if (!extensionUserId || !code) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const result = db.redeemPromo(code, extensionUserId);
  if (!result.ok) {
    const clientErr =
      result.error === "invalid_code" ||
      result.error === "expired" ||
      result.error === "exhausted" ||
      result.error === "invalid_request";
    const status = clientErr ? 400 : 409;
    return res.status(status).json({ error: result.error });
  }
  res.json({ ok: true, subscribed: true });
});

app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.warn("[billing] STRIPE_WEBHOOK_SECRET missing — webhook disabled");
      return res.status(500).send("webhook_not_configured");
    }
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = verifyWebhook(stripe, req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("[billing] webhook signature:", err.message || err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    void (async () => {
      try {
        await handleStripeEvent(stripe, event);
      } catch (e) {
        console.error("[billing] webhook handler:", e);
      }
    })();

    res.json({ received: true });
  }
);

app.get("/checkout/return", async (req, res) => {
  const sessionId = req.query.session_id;
  let paid = false;
  if (sessionId && STRIPE_SECRET_KEY) {
    try {
      const s = await stripe.checkout.sessions.retrieve(String(sessionId));
      paid = s.payment_status === "paid" || s.status === "complete";
    } catch {
      paid = false;
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Focus Guard</title>
<style>
  body{font-family:system-ui,sans-serif;background:#17181c;color:#f3f4f6;text-align:center;padding:48px 24px;}
  h1{font-size:1.25rem;font-weight:600}
  p{color:rgba(243,244,246,.65);max-width:420px;margin:16px auto;line-height:1.5}
</style></head><body>
  <h1>${paid ? "Payment received" : "Thanks!"}</h1>
  <p>You can close this tab and return to <strong>Focus Guard</strong>. Open the extension and tap <strong>Refresh premium status</strong> if Pro unlock doesn’t show immediately.</p>
</body></html>`);
});

app.get("/checkout/cancel", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Focus Guard</title>
<style>
  body{font-family:system-ui,sans-serif;background:#17181c;color:#f3f4f6;text-align:center;padding:48px 24px;}
  p{color:rgba(243,244,246,.65);max-width:420px;margin:16px auto;line-height:1.5}
</style></head><body>
  <h1>Checkout cancelled</h1>
  <p>No charge was made. You can close this tab.</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`[billing] listening on ${PORT} — public base ${PUBLIC_BASE_URL}`);
});
