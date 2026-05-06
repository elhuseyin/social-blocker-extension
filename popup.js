/**
 * popup.js — Focus Guard Popup Controller (ES module)
 * Manages the settings UI, reads/writes chrome.storage, and
 * communicates with the background service worker.
 */

import { getEntitlements, resolveBreakScreen } from "./entitlements.js";
import { getWeeklyUsageSummary } from "./usage-analytics.js";
import { renderWeeklyUsageChart } from "./weekly-analytics-chart.js";
import {
  ensureExtensionUserId,
  syncPremiumFromServer,
  createCheckoutSession,
  redeemPromoCode
} from "./billing-api.js";

const LOG_PREFIX = "[FocusGuard Popup]";

const DEFAULT_SETTINGS = {
  enabled:       true,
  breakInterval: 0.5,
  breakDuration: 10,
  allowSkip:     true,
  breakScreen:   "default",
  customDomains: [],
  disabledBuiltIns: []
};

/** Default blocked presets (same hostnames as background). Removing adds hostnames to `disabledBuiltIns`. */
const BUILTIN_PRESETS = [
  { id: "instagram", label: "instagram.com", icon: "📷", domains: ["instagram.com"] },
  { id: "facebook", label: "facebook.com", icon: "👥", domains: ["facebook.com"] },
  { id: "twitter", label: "x.com / twitter.com", icon: "𝕏", domains: ["twitter.com", "x.com"] }
];

/** Break theme row thumb images (extension root paths). Cat is free; others premium. */
const THEME_THUMB_IMAGE = {
  cat: "assets/cat-stretch-logo.png",
  night: "assets/dopamine-detox-logo.png",
  cooked: "assets/were-cooked-logo.png",
  forest: "assets/reset-mind-logo.png",
  space: "assets/astronaut-float.png",
  breath: "assets/breath-break-art.png"
};

const PREMIUM_LOCK_THUMB_HTML = `
<span class="fg-premium-lock">
  <span class="fg-premium-lock__shackle"></span>
  <span class="fg-premium-lock__body">
    <span class="fg-premium-lock__keyhole">
      <span class="fg-premium-lock__keyhole-circle"></span>
      <span class="fg-premium-lock__keyhole-slot"></span>
    </span>
  </span>
</span>`.trim();

// ─── Element refs ────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  toggleEnabled:     $("toggle-enabled"),
  breakInterval:     $("break-interval"),
  breakDuration:     $("break-duration"),
  toggleSkip:        $("toggle-skip"),

  statusBar:         $("status-bar"),
  statusDot:         $("status-dot"),
  statusText:        $("status-text"),

  usageDomain:       $("usage-domain"),
  usageTime:         $("usage-time"),
  usageBarFill:      $("usage-bar-fill"),
  usageBarLegend:    $("usage-bar-legend"),
  siteUsageList:     $("site-usage-list"),

  builtinList:       $("builtin-list"),
  customDomainList:  $("custom-domain-list"),
  customDomainInput: $("custom-domain-input"),
  addDomainBtn:      $("add-domain-btn"),
  domainError:       $("domain-error"),
  breakThemeList:    $("break-theme-list"),
  billingSectionNotPremium: $("billing-section-not-premium"),
  billingSectionPremium:    $("billing-section-premium"),
  subscribeMonthlyBtn:      $("subscribe-monthly-btn"),
  promoInput:               $("promo-input"),
  promoRedeemBtn:           $("promo-redeem-btn"),
  refreshPremiumBtn:        $("refresh-premium-btn"),
  refreshPremiumBtnPremium: $("refresh-premium-btn-premium"),
  devModeBadge:      $("dev-mode-badge"),

  saveBtn:           $("save-btn"),
  saveStatus:        $("save-status"),

  analyticsCanvas:   $("weekly-break-chart"),
  analyticsTooltip:  $("analytics-chart-tooltip"),
  analyticsGate:     $("analytics-premium-gate"),
  analyticsInner:    $("analytics-chart-inner"),
  analyticsWeekThis: $("analytics-week-this"),
  analyticsWeekLast: $("analytics-week-last"),
  analyticsUpgrade:  $("analytics-upgrade-btn")
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mins     = Math.floor(totalSec / 60);
  const secs     = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** Sum of all tracked usage entries (all tracked sites this session). */
function sumUsageMs(usage) {
  return Object.values(usage || {}).reduce((acc, ms) => acc + (Number(ms) || 0), 0);
}

function showSaveStatus(msg, isError = false) {
  els.saveStatus.textContent = msg;
  els.saveStatus.className   = "save-status " + (isError ? "save-status--error" : "save-status--ok");
  const ms = isError ? 8000 : 2500;
  setTimeout(() => {
    els.saveStatus.textContent = "";
    els.saveStatus.className   = "save-status";
  }, ms);
}

// ─── Domain validation ────────────────────────────────────────────────────

const DOMAIN_REGEX = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i;

function validateDomain(raw) {
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!domain) return { ok: false, domain: null, error: "Please enter a domain." };
  if (!DOMAIN_REGEX.test(domain)) return { ok: false, domain: null, error: "Enter a valid domain (e.g. reddit.com)." };
  return { ok: true, domain, error: null };
}

// ─── Custom domain list UI ────────────────────────────────────────────────

function isBuiltinPresetRemoved(disabledBuiltIns, preset) {
  const dis = new Set(disabledBuiltIns || []);
  return preset.domains.every((d) => dis.has(d));
}

function renderBuiltinPresets(settings) {
  if (!els.builtinList) return;
  const disabled = settings.disabledBuiltIns || [];
  els.builtinList.innerHTML = "";

  BUILTIN_PRESETS.forEach((preset) => {
    if (isBuiltinPresetRemoved(disabled, preset)) return;

    const li = document.createElement("li");
    li.className = "domain-item domain-builtin";
    li.innerHTML = `
        <span class="domain-favicon" aria-hidden="true">${preset.icon}</span>
        <span class="domain-text">${escapeHtml(preset.label)}</span>
        <span class="domain-badge">built-in</span>
        <button type="button" class="btn-remove btn-remove-builtin" data-builtin-id="${escapeHtml(preset.id)}" aria-label="Remove ${escapeHtml(preset.label)} from tracked sites" title="Remove">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
      `;
    els.builtinList.appendChild(li);
  });
}

function renderCustomDomains(domains) {
  els.customDomainList.innerHTML = "";

  if (!domains.length) return;

  domains.forEach(domain => {
    const li = document.createElement("li");
    li.className = "domain-item domain-custom";
    li.dataset.domain = domain;

    li.innerHTML = `
        <span class="domain-favicon" aria-hidden="true">🌐</span>
        <span class="domain-text">${escapeHtml(domain)}</span>
        <button class="btn-remove" data-domain="${escapeHtml(domain)}" aria-label="Remove ${escapeHtml(domain)}" title="Remove">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
      `;
    els.customDomainList.appendChild(li);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function domainIcon(domain) {
  if (domain.includes("instagram")) return "📷";
  if (domain.includes("facebook")) return "👥";
  if (domain.includes("twitter") || domain.includes("x.com")) return "𝕏";
  if (domain.includes("youtube")) return "📺";
  return "🌐";
}

// ─── State / Storage ──────────────────────────────────────────────────────

let currentSettings = { ...DEFAULT_SETTINGS };
/** Theme choice in the list (may differ from storage until Save). */
let breakScreenDraft = DEFAULT_SETTINGS.breakScreen;
let currentStatus   = null;
let entitlementsCache = { isSubscribed: false, devMode: false };

let weeklyChartTeardown = null;
let analyticsWeekOffset = 0;

function isPremiumUnlocked() {
  return entitlementsCache.isSubscribed;
}

/** Theme row thumbs: free cat logo; premium rows use asset or lock / lock over dimmed logo. */
function renderPremiumBreakThumbs() {
  if (!els.breakThemeList) return;

  const catThumb = els.breakThemeList.querySelector('.theme-item[data-theme="cat"] .theme-thumb');
  if (catThumb && THEME_THUMB_IMAGE.cat) {
    const src = chrome.runtime.getURL(THEME_THUMB_IMAGE.cat);
    catThumb.className = "theme-thumb theme-thumb--theme-logo";
    catThumb.innerHTML = `<img src="${src}" alt="" role="presentation" decoding="async" loading="lazy" />`;
  }

  els.breakThemeList.querySelectorAll(".theme-item[data-locked] .theme-thumb").forEach((thumb) => {
    const row = thumb.closest(".theme-item");
    const theme = row?.dataset.theme;
    if (!theme) return;

    const logoPath = THEME_THUMB_IMAGE[theme];

    if (!isPremiumUnlocked()) {
      if (logoPath) {
        const src = chrome.runtime.getURL(logoPath);
        thumb.className = "theme-thumb theme-thumb--locked theme-thumb--locked-with-logo";
        thumb.innerHTML = `
          <img class="theme-thumb-lock-bg" src="${src}" alt="" role="presentation" decoding="async" loading="lazy" />
          <span class="theme-thumb-lock-front" aria-hidden="true">${PREMIUM_LOCK_THUMB_HTML}</span>
        `;
      } else {
        thumb.className = "theme-thumb theme-thumb--locked";
        thumb.innerHTML = PREMIUM_LOCK_THUMB_HTML;
      }
      return;
    }

    if (logoPath) {
      thumb.className = "theme-thumb theme-thumb--premium-logo";
      thumb.innerHTML = `<img src="${chrome.runtime.getURL(logoPath)}" alt="" role="presentation" decoding="async" loading="lazy" />`;
    } else {
      thumb.className = "theme-thumb theme-thumb--premium-logo theme-thumb--premium-logo-placeholder";
      thumb.innerHTML = "";
    }
  });
}

function applyPremiumThemeState() {
  const options = els.breakThemeList?.querySelectorAll(".theme-item[data-locked]") || [];
  options.forEach((btn) => {
    btn.classList.toggle("theme-item--locked", !isPremiumUnlocked());
    const stateEl = btn.querySelector(".theme-state");
    if (stateEl) stateEl.textContent = isPremiumUnlocked() ? "Select" : "Locked";
    const subEl = btn.querySelector(".theme-subtitle");
    if (subEl) subEl.textContent = entitlementsCache.devMode ? "Premium (Dev)" : "Premium";
    btn.setAttribute("aria-disabled", isPremiumUnlocked() ? "false" : "true");
  });
  renderPremiumBreakThumbs();
}

function renderDevModeBadge() {
  if (!els.devModeBadge) return;
  els.devModeBadge.hidden = !entitlementsCache.devMode;
}

function updateBillingFooterVisibility() {
  const premium = isPremiumUnlocked();
  if (els.billingSectionNotPremium) {
    els.billingSectionNotPremium.hidden = premium;
  }
  if (els.billingSectionPremium) {
    els.billingSectionPremium.hidden = !premium;
  }
}

async function refreshEntitlementsUI(options = {}) {
  if (!options.skipBillingSync) {
    try {
      await ensureExtensionUserId();
      await syncPremiumFromServer();
    } catch (err) {
      log("Billing sync failed (offline or misconfigured API):", err?.message || err);
    }
  }

  const { isSubscribed, devMode } = await getEntitlements();
  entitlementsCache = { isSubscribed, devMode };
  applyPremiumThemeState();
  renderDevModeBadge();
  updateBillingFooterVisibility();
  breakScreenDraft = await resolveBreakScreen(
    currentSettings.breakScreenPending ?? currentSettings.breakScreen
  );
  setSelectedBreakTheme(breakScreenDraft);
  log("Entitlements:", entitlementsCache);
  void refreshWeeklyAnalytics();
}

/** Console helpers — same as chrome.storage.local.set({ devMode: true/false }). */
globalThis.enableDevEntitlements = () => chrome.storage.local.set({ devMode: true });
globalThis.disableDevEntitlements = () => chrome.storage.local.set({ devMode: false });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    void applySettingsToUI(currentSettings);
  }
  if (changes.devMode || changes.subscribed || changes.dev_mode || changes.settings) {
    void refreshEntitlementsUI();
  }
  if (changes.socialUsageDaily && isPremiumUnlocked()) {
    void refreshWeeklyAnalytics();
  }
});

async function loadSettings() {
  const data = await chrome.storage.local.get("settings");
  currentSettings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  const resolved = await resolveBreakScreen(currentSettings.breakScreen);
  if (resolved !== currentSettings.breakScreen) {
    currentSettings = { ...currentSettings, breakScreen: resolved };
    await chrome.storage.local.set({
      settings: { ...(data.settings || {}), breakScreen: resolved }
    });
  }
  await applySettingsToUI(currentSettings);
  log("Settings loaded:", currentSettings);
}

async function applySettingsToUI(settings) {
  els.toggleEnabled.checked  = settings.enabled;
  els.breakInterval.value    = String(settings.breakInterval);
  els.breakDuration.value    = String(settings.breakDuration);
  els.toggleSkip.checked     = settings.allowSkip;
  renderBuiltinPresets(settings);
  renderCustomDomains(settings.customDomains || []);
  breakScreenDraft = await resolveBreakScreen(
    settings.breakScreenPending ?? settings.breakScreen
  );
  setSelectedBreakTheme(breakScreenDraft);
}

function collectSettingsFromUI() {
  return {
    enabled:       els.toggleEnabled.checked,
    breakInterval: parseInt(els.breakInterval.value, 10),
    breakDuration: parseInt(els.breakDuration.value, 10),
    allowSkip:     els.toggleSkip.checked,
    breakScreen:   breakScreenDraft || "default",
    customDomains: currentSettings.customDomains || [],
    disabledBuiltIns: currentSettings.disabledBuiltIns || []
  };
}

function setSelectedBreakTheme(themeName) {
  const options = els.breakThemeList?.querySelectorAll(".theme-item") || [];
  options.forEach((btn) => {
    const isLocked = !!btn.dataset.locked && !isPremiumUnlocked();
    const isSelected = btn.dataset.theme === themeName && !isLocked;
    btn.classList.toggle("is-selected", isSelected);
    const stateEl = btn.querySelector(".theme-state");
    if (stateEl) {
      if (isLocked) {
        stateEl.textContent = "Locked";
      } else {
        stateEl.textContent = isSelected ? "Selected" : "Select";
      }
    }
  });
}

async function saveSettings() {
  let status = currentStatus;
  try {
    status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  } catch {
    // BG might be restarting
  }
  const breakActive = Boolean(status?.breakActive);

  const resolvedDraft = await resolveBreakScreen(breakScreenDraft);
  const base = collectSettingsFromUI();

  if (breakActive) {
    base.breakScreen = currentSettings.breakScreen;
    if (resolvedDraft !== currentSettings.breakScreen) {
      base.breakScreenPending = resolvedDraft;
    } else {
      delete base.breakScreenPending;
    }
  } else {
    base.breakScreen = resolvedDraft;
    delete base.breakScreenPending;
  }

  await chrome.storage.local.set({ settings: base });
  currentSettings = base;

  try {
    await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED", settings: base });
  } catch {
    // BG might be restarting
  }

  log("Settings saved:", base);
  if (breakActive && base.breakScreenPending) {
    showSaveStatus("✓ Saved — break screen updates when this break ends");
  } else {
    showSaveStatus("✓ Settings saved");
  }
}

// ─── Status / Usage UI ───────────────────────────────────────────────────

async function fetchStatus() {
  try {
    currentStatus = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    updateStatusUI();
  } catch (err) {
    log("Status fetch error:", err);
    els.statusText.textContent = "Extension inactive";
    els.statusDot.className    = "status-dot dot-inactive";
  }
}

function updateStatusUI() {
  if (!currentStatus) return;

  const { breakActive, breakEndsAt, usage, settings, activeDomain } = currentStatus;

  // Status bar
  if (!settings?.enabled) {
    els.statusDot.className  = "status-dot dot-inactive";
    els.statusText.textContent = "Extension disabled";
  } else if (breakActive) {
    const remaining = Math.max(0, breakEndsAt - Date.now());
    els.statusDot.className    = "status-dot dot-break";
    els.statusText.textContent = `Break active — ${formatMs(remaining)} remaining`;
  } else if (activeDomain) {
    els.statusDot.className    = "status-dot dot-active";
    els.statusText.textContent = `Tracking ${activeDomain}`;
  } else {
    els.statusDot.className    = "status-dot dot-idle";
    els.statusText.textContent = "No social site active";
  }

  // Usage card — big number = current (or primary) site; bar + legend = combined across all sites
  const domain       = activeDomain || (usage ? Object.keys(usage)[0] : null);
  const siteUsageMs  = domain && usage ? (usage[domain] || 0) : 0;
  const combinedMs   = sumUsageMs(usage);
  const intMs        = (settings?.breakInterval || 30) * 60 * 1000;
  const pctCombined  = Math.min(100, (combinedMs / intMs) * 100);

  els.usageDomain.textContent    = domain || "—";
  els.usageTime.textContent      = domain ? formatMs(siteUsageMs) : "—";
  els.usageBarFill.style.width   = `${pctCombined}%`;
  els.usageBarFill.className     = `usage-bar-fill ${pctCombined >= 90 ? "bar-danger" : pctCombined >= 60 ? "bar-warn" : ""}`;
  els.usageBarLegend.textContent = domain || combinedMs > 0
    ? `${formatMs(combinedMs)} / ${formatMs(intMs)}`
    : "Visit a social site to start tracking";

  renderSiteUsageList(usage, intMs);
}

function setAnalyticsWeekToggleUI() {
  if (!els.analyticsWeekThis || !els.analyticsWeekLast) return;
  els.analyticsWeekThis.classList.toggle("analytics-seg--active", analyticsWeekOffset === 0);
  els.analyticsWeekLast.classList.toggle("analytics-seg--active", analyticsWeekOffset === 1);
}

async function refreshWeeklyAnalytics() {
  if (!els.analyticsCanvas || !els.analyticsInner || !els.analyticsGate) return;

  const unlocked = isPremiumUnlocked();
  els.analyticsGate.hidden = unlocked;
  els.analyticsInner.classList.toggle("analytics-chart-inner--locked", !unlocked);

  if (weeklyChartTeardown) {
    weeklyChartTeardown();
    weeklyChartTeardown = null;
  }

  const s = await getWeeklyUsageSummary(analyticsWeekOffset);
  const byDay = s.byDay;

  weeklyChartTeardown = renderWeeklyUsageChart(els.analyticsCanvas, byDay, {
    onHoverLabel: (label) => {
      if (!els.analyticsTooltip) return;
      if (label) {
        els.analyticsTooltip.textContent = label;
        els.analyticsTooltip.classList.add("is-visible");
      } else {
        els.analyticsTooltip.textContent = "";
        els.analyticsTooltip.classList.remove("is-visible");
      }
    }
  });
}

function renderSiteUsageList(usage, intervalMs) {
  if (!els.siteUsageList) return;
  const entries = Object.entries(usage || {})
    .filter(([, ms]) => ms >= 1000)
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    els.siteUsageList.innerHTML = `<li class="site-usage-empty">Visit tracked sites to start tracking.</li>`;
    return;
  }

  els.siteUsageList.innerHTML = entries.map(([domain, ms]) => {
    const pct = Math.min(100, (ms / intervalMs) * 100);
    const barClass = pct >= 90 ? "is-danger" : pct >= 60 ? "is-warn" : "is-ok";
    return `
        <li class="site-usage-item">
          <span class="site-usage-icon" aria-hidden="true">${domainIcon(domain)}</span>
          <span class="site-usage-domain">${escapeHtml(domain)}</span>
          <div class="site-usage-track" aria-hidden="true">
            <div class="site-usage-fill ${barClass}" style="width:${pct}%"></div>
          </div>
          <span class="site-usage-time">${formatMs(ms)}</span>
        </li>
      `;
  }).join("");
}

// ─── Event listeners ─────────────────────────────────────────────────────

/** Save button */
els.saveBtn.addEventListener("click", async () => {
  els.saveBtn.disabled = true;
  try {
    await saveSettings();
  } finally {
    els.saveBtn.disabled = false;
  }
});

/** Add custom domain */
async function addCustomDomain() {
  const raw = els.customDomainInput.value;
  const { ok, domain, error } = validateDomain(raw);

  if (!ok) {
    els.domainError.textContent = error;
    return;
  }

  els.domainError.textContent = "";

  const existing = currentSettings.customDomains || [];
  if (existing.includes(domain)) {
    els.domainError.textContent = "Domain already in list.";
    return;
  }

  currentSettings.customDomains = [...existing, domain];
  renderCustomDomains(currentSettings.customDomains);
  els.customDomainInput.value = "";
  log("Custom domain added:", domain);
}

els.addDomainBtn.addEventListener("click", addCustomDomain);

els.customDomainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCustomDomain();
});

/** Remove custom domain (event delegation) */
els.customDomainList.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-remove");
  if (!btn) return;
  const domain = btn.dataset.domain;
  currentSettings.customDomains = (currentSettings.customDomains || []).filter(d => d !== domain);
  renderCustomDomains(currentSettings.customDomains);
  log("Custom domain removed:", domain);
});

/** Remove built-in preset (still saved as default for new installs; this user disables those hostnames) */
if (els.builtinList) {
  els.builtinList.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-remove-builtin");
    if (!btn) return;
    const id = btn.dataset.builtinId;
    const preset = BUILTIN_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const disabled = new Set(currentSettings.disabledBuiltIns || []);
    preset.domains.forEach((d) => disabled.add(d));
    currentSettings.disabledBuiltIns = [...disabled];
    renderBuiltinPresets(currentSettings);
    log("Built-in preset removed:", id, preset.domains);
  });
}

if (els.breakThemeList) {
  els.breakThemeList.addEventListener("click", (e) => {
    const btn = e.target.closest(".theme-item");
    if (!btn) return;
    if (btn.dataset.locked && !isPremiumUnlocked()) {
      showSaveStatus("Premium screen. Unlock with subscription.", true);
      return;
    }
    breakScreenDraft = btn.dataset.theme || "default";
    setSelectedBreakTheme(breakScreenDraft);
    log("Break screen draft:", breakScreenDraft, "(click Save to apply)");
  });
}

function checkoutErrorMessage(error, detail) {
  const base =
    error === "network"
      ? "Could not reach billing server."
      : error === "price_not_configured"
        ? "Server missing STRIPE_PRICE_SUBSCRIPTION (and one-time price) in .env."
        : error === "unauthorized"
          ? "Billing API rejected the request — set BILLING_CLIENT_SECRET the same in billing-config.js and backend/.env, or clear it in both."
          : error === "checkout_failed"
            ? "Stripe rejected checkout — check STRIPE_SECRET_KEY and STRIPE_PRICE_SUBSCRIPTION in backend/.env (price must be a recurring subscription price)."
            : error === "no_checkout_url"
              ? "Server returned no checkout URL."
              : error === "invalid_extension_user_id" || error === "invalid_mode"
                ? "Invalid billing request."
                : error && String(error).startsWith("http_")
                  ? `Billing server error (${error.replace(/^http_/, "")}).`
                  : "Could not start checkout.";
  const d = detail ? String(detail).trim().slice(0, 160) : "";
  return d ? `${base} — ${d}` : base;
}

async function openStripeCheckout(mode) {
  showSaveStatus("Opening checkout…");
  const { url, error, detail } = await createCheckoutSession(mode);
  if (error || !url) {
    log("Checkout failed:", error, detail || "");
    showSaveStatus(checkoutErrorMessage(error, detail), true);
    return;
  }
  try {
    await chrome.tabs.create({ url });
    showSaveStatus("Complete payment in the new tab, then refresh status.");
  } catch (err) {
    log("Failed to open checkout:", err);
    showSaveStatus("Could not open browser tab.", true);
  }
}

if (els.subscribeMonthlyBtn) {
  els.subscribeMonthlyBtn.addEventListener("click", () => void openStripeCheckout("subscription"));
}

if (els.promoRedeemBtn && els.promoInput) {
  els.promoRedeemBtn.addEventListener("click", async () => {
    const code = els.promoInput.value.trim();
    if (!code) {
      showSaveStatus("Enter a code.", true);
      return;
    }
    const result = await redeemPromoCode(code);
    if (result.error) {
      const msg =
        result.error === "network"
          ? "Could not reach billing server."
          : result.error === "invalid_code"
            ? "Invalid code."
            : result.error === "expired"
              ? "Code expired."
              : result.error === "exhausted"
                ? "Code fully redeemed."
                : result.error === "already_redeemed"
                  ? "You already used this code."
                  : "Could not redeem code.";
      showSaveStatus(msg, true);
      return;
    }
    els.promoInput.value = "";
    showSaveStatus("Premium unlocked.");
    await refreshEntitlementsUI();
  });
}

async function manualRefreshPremium() {
  showSaveStatus("Syncing…");
  const r = await syncPremiumFromServer();
  if (r.skipped) {
    await refreshEntitlementsUI({ skipBillingSync: true });
    showSaveStatus("Premium (dev mode).");
    return;
  }
  if (r.error === "network" || (r.error && String(r.error).startsWith("http_"))) {
    showSaveStatus("Could not reach billing server.", true);
    return;
  }
  await refreshEntitlementsUI({ skipBillingSync: true });
  showSaveStatus(isPremiumUnlocked() ? "Premium active." : "No active subscription found.");
}

if (els.refreshPremiumBtn) {
  els.refreshPremiumBtn.addEventListener("click", () => void manualRefreshPremium());
}
if (els.refreshPremiumBtnPremium) {
  els.refreshPremiumBtnPremium.addEventListener("click", () => void manualRefreshPremium());
}

if (els.promoInput) {
  els.promoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && els.promoRedeemBtn) els.promoRedeemBtn.click();
  });
}

if (els.analyticsUpgrade) {
  els.analyticsUpgrade.addEventListener("click", () => void openStripeCheckout("subscription"));
}

if (els.analyticsWeekThis && els.analyticsWeekLast) {
  els.analyticsWeekThis.addEventListener("click", () => {
    analyticsWeekOffset = 0;
    setAnalyticsWeekToggleUI();
    void refreshWeeklyAnalytics();
  });
  els.analyticsWeekLast.addEventListener("click", () => {
    analyticsWeekOffset = 1;
    setAnalyticsWeekToggleUI();
    void refreshWeeklyAnalytics();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  setAnalyticsWeekToggleUI();
  await refreshEntitlementsUI();
  await fetchStatus();

  // Poll status every 2s while popup is open
  setInterval(fetchStatus, 2000);
}

void init();
