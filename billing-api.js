/**
 * Client for Focus Guard billing API (Stripe checkout + promo + entitlements).
 * Publishable Stripe key is not used here — only server creates Checkout Sessions.
 */

import { BILLING_API_BASE, BILLING_CLIENT_SECRET } from "./billing-config.js";

function billingHeaders(withJsonBody = false) {
  const h = {};
  if (withJsonBody) {
    h["Content-Type"] = "application/json";
  }
  if (BILLING_CLIENT_SECRET) {
    h["X-FocusGuard-Client"] = BILLING_CLIENT_SECRET;
  }
  return h;
}

export async function ensureExtensionUserId() {
  const { extensionUserId } = await chrome.storage.local.get("extensionUserId");
  if (extensionUserId && typeof extensionUserId === "string") {
    return extensionUserId;
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ extensionUserId: id });
  return id;
}

/**
 * Pull authoritative premium flag from server into chrome.storage.local.subscribed
 * (unless devMode is on — devMode still wins in getEntitlements).
 */
export async function syncPremiumFromServer() {
  const { devMode } = await chrome.storage.local.get("devMode");
  if (devMode) return { subscribed: true, skipped: true };

  const id = await ensureExtensionUserId();
  const url = `${BILLING_API_BASE}/api/entitlements/${encodeURIComponent(id)}`;
  let res;
  try {
    res = await fetch(url, { method: "GET", headers: billingHeaders(false) });
  } catch {
    return { subscribed: false, error: "network" };
  }
  if (!res.ok) {
    return { subscribed: false, error: `http_${res.status}` };
  }
  const data = await res.json();
  const subscribed = Boolean(data.subscribed);
  await chrome.storage.local.set({ subscribed });
  return { subscribed };
}

/**
 * @param {"subscription" | "payment"} mode
 * @returns {{ url?: string, error?: string }}
 */
export async function createCheckoutSession(mode) {
  const extensionUserId = await ensureExtensionUserId();
  let res;
  try {
    res = await fetch(`${BILLING_API_BASE}/api/checkout`, {
      method: "POST",
      headers: billingHeaders(true),
      body: JSON.stringify({ extensionUserId, mode })
    });
  } catch {
    return { error: "network" };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      error: data.error || `http_${res.status}`,
      detail: typeof data.detail === "string" ? data.detail : undefined
    };
  }
  if (!data.url) {
    return { error: "no_checkout_url" };
  }
  return { url: data.url };
}

/**
 * Opens the Stripe Customer Portal (cancel plan, update payment method, invoices).
 * Backend should call `stripe.billingPortal.sessions.create`, then return the session URL.
 *
 * Contract: `POST /api/billing-portal` with JSON `{ extensionUserId }` → `{ url: string }`.
 * @returns {{ url?: string, error?: string, detail?: string }}
 */
export async function createBillingPortalSession() {
  const { devMode } = await chrome.storage.local.get("devMode");
  if (devMode) return { error: "dev_mode" };

  const extensionUserId = await ensureExtensionUserId();
  let res;
  try {
    res = await fetch(`${BILLING_API_BASE}/api/billing-portal`, {
      method: "POST",
      headers: billingHeaders(true),
      body: JSON.stringify({ extensionUserId })
    });
  } catch {
    return { error: "network" };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      error: data.error || `http_${res.status}`,
      detail: typeof data.detail === "string" ? data.detail : undefined
    };
  }
  if (!data.url) {
    return { error: "no_portal_url" };
  }
  return { url: data.url };
}

/**
 * @returns {{ ok?: boolean, error?: string }}
 */
export async function redeemPromoCode(code) {
  const extensionUserId = await ensureExtensionUserId();
  let res;
  try {
    res = await fetch(`${BILLING_API_BASE}/api/redeem-promo`, {
      method: "POST",
      headers: billingHeaders(true),
      body: JSON.stringify({ extensionUserId, code: String(code || "").trim() })
    });
  } catch {
    return { error: "network" };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { error: data.error || `http_${res.status}` };
  }
  await chrome.storage.local.set({ subscribed: true });
  return { ok: true };
}
