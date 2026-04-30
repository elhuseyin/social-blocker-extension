/**
 * Shared entitlement checks — popup, background (module), content (dynamic import).
 * devMode in chrome.storage.local unlocks premium for local testing only (default off).
 */

const PREMIUM_BREAK_SCREENS = new Set(["forest", "night", "space", "cooked"]);

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
    devMode: Boolean(devMode)
  };
}

/** Premium overlay themes — require subscription or devMode. */
export function isPremiumBreakScreen(screen) {
  return PREMIUM_BREAK_SCREENS.has(screen || "");
}

export async function resolveBreakScreen(screen) {
  const { isSubscribed } = await getEntitlements();
  const id = screen || "default";
  if (isPremiumBreakScreen(id) && !isSubscribed) return "default";
  return id;
}
