/**
 * popup.js — Focus Guard Popup Controller (ES module)
 * Manages the settings UI, reads/writes chrome.storage, and
 * communicates with the background service worker.
 */

import { getEntitlements, resolveBreakScreen } from "./entitlements.js";
import { getWeeklyBreakSummary } from "./break-analytics.js";
import { renderWeeklyBreakChart } from "./weekly-analytics-chart.js";

const LOG_PREFIX = "[FocusGuard Popup]";
const SUBSCRIPTION_URL = "https://your-subscription-page.example.com";

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
  subscribeBtn:      $("subscribe-btn"),
  devModeBadge:      $("dev-mode-badge"),

  saveBtn:           $("save-btn"),
  saveStatus:        $("save-status"),

  analyticsCanvas:   $("weekly-break-chart"),
  analyticsTooltip:  $("analytics-chart-tooltip"),
  analyticsEmpty:    $("analytics-empty"),
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
  setTimeout(() => {
    els.saveStatus.textContent = "";
    els.saveStatus.className   = "save-status";
  }, 2500);
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
}

function renderDevModeBadge() {
  if (!els.devModeBadge) return;
  els.devModeBadge.hidden = !entitlementsCache.devMode;
}

async function refreshEntitlementsUI() {
  const { isSubscribed, devMode } = await getEntitlements();
  entitlementsCache = { isSubscribed, devMode };
  applyPremiumThemeState();
  renderDevModeBadge();
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
  if (changes.breakSessionLog && isPremiumUnlocked()) {
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

  const s = await getWeeklyBreakSummary(analyticsWeekOffset);
  const byDay = s.byDay;
  const hasData = s.hasData;
  /** @type {number | null} */
  const dailyAverage = hasData ? s.dailyAverage : null;

  if (els.analyticsEmpty) {
    els.analyticsEmpty.hidden = !unlocked || hasData;
  }

  weeklyChartTeardown = renderWeeklyBreakChart(els.analyticsCanvas, byDay, {
    dailyAverage,
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

if (els.subscribeBtn) {
  els.subscribeBtn.addEventListener("click", async () => {
    try {
      await chrome.tabs.create({ url: SUBSCRIPTION_URL });
    } catch (err) {
      log("Failed to open subscription page:", err);
      showSaveStatus("Could not open subscription page", true);
    }
  });
}

if (els.analyticsUpgrade) {
  els.analyticsUpgrade.addEventListener("click", async () => {
    try {
      await chrome.tabs.create({ url: SUBSCRIPTION_URL });
    } catch (err) {
      log("Failed to open subscription page:", err);
      showSaveStatus("Could not open subscription page", true);
    }
  });
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
