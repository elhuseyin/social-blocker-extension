/**
 * Shared entitlement checks — popup, background (module), content (dynamic import).
 * devMode in chrome.storage.local unlocks premium for local testing only (default off).
 */

const PREMIUM_BREAK_SCREENS = new Set([
  "forest",
  "night",
  "space",
  "cooked",
  "breath",
  "mycat",
  "sleepingdog"
]);

/** Known break themes only — never pass arbitrary storage strings into DOM/class names. */
export const ALLOWED_BREAK_SCREENS = new Set([
  "default",
  "cat",
  ...PREMIUM_BREAK_SCREENS
]);

export function sanitizeBreakScreenId(screen) {
  const raw = typeof screen === "string" ? screen.trim() : "";
  if (!raw || !ALLOWED_BREAK_SCREENS.has(raw)) return "default";
  return raw;
}

/** One-time migration from legacy dev_mode key. */
async function migrateLegacyDevMode() {
  const { dev_mode } = await chrome.storage.local.get("dev_mode");
  if (dev_mode === true) {
    await chrome.storage.local.set({ devMode: true, dev_mode: false });
  }
}

export async function getEntitlements() {
  await migrateLegacyDevMode();

  const { subscribed, devMode } = await chrome.storage.local.get([
    "subscribed",
    "devMode"
  ]);

  return {
    isSubscribed: Boolean(subscribed) || Boolean(devMode),
    devMode: Boolean(devMode),
    /** True when `subscribed` is set in storage (Stripe or promo); false for devMode-only premium. */
    stripeSubscribed: Boolean(subscribed)
  };
}

/** Premium overlay themes — require subscription or devMode. */
export function isPremiumBreakScreen(screen) {
  return PREMIUM_BREAK_SCREENS.has(screen || "");
}

export async function resolveBreakScreen(screen) {
  const { isSubscribed } = await getEntitlements();
  let id = sanitizeBreakScreenId(screen);
  if (isPremiumBreakScreen(id) && !isSubscribed) return "default";
  return id;
}
