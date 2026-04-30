/**
 * popup.js — Focus Guard Popup Controller (ES module)
 * Manages the settings UI, reads/writes chrome.storage, and
 * communicates with the background service worker.
 */

import { getEntitlements, resolveBreakScreen } from "./entitlements.js";

const LOG_PREFIX = "[FocusGuard Popup]";
const SUBSCRIPTION_URL = "https://your-subscription-page.example.com";

const DEFAULT_SETTINGS = {
  enabled:       true,
  breakInterval: 0.5,
  breakDuration: 10,
  allowSkip:     true,
  breakScreen:   "default",
  customDomains: []
};

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

  customDomainList:  $("custom-domain-list"),
  customDomainInput: $("custom-domain-input"),
  addDomainBtn:      $("add-domain-btn"),
  domainError:       $("domain-error"),
  breakThemeList:    $("break-theme-list"),
  subscribeBtn:      $("subscribe-btn"),
  devModeBadge:      $("dev-mode-badge"),

  saveBtn:           $("save-btn"),
  resetBtn:          $("reset-btn"),
  saveStatus:        $("save-status")
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

/** Sum of all tracked usage entries (all blocked sites this session). */
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
let currentStatus   = null;
let entitlementsCache = { isSubscribed: false, devMode: false };

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
  setSelectedBreakTheme(currentSettings.breakScreen || "default");
  log("Entitlements:", entitlementsCache);
}

/** Console helpers — same as chrome.storage.local.set({ devMode: true/false }). */
globalThis.enableDevEntitlements = () => chrome.storage.local.set({ devMode: true });
globalThis.disableDevEntitlements = () => chrome.storage.local.set({ devMode: false });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    applySettingsToUI(currentSettings);
  }
  if (changes.devMode || changes.subscribed || changes.dev_mode || changes.settings) {
    void refreshEntitlementsUI();
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
  applySettingsToUI(currentSettings);
  log("Settings loaded:", currentSettings);
}

function applySettingsToUI(settings) {
  els.toggleEnabled.checked  = settings.enabled;
  els.breakInterval.value    = String(settings.breakInterval);
  els.breakDuration.value    = String(settings.breakDuration);
  els.toggleSkip.checked     = settings.allowSkip;
  renderCustomDomains(settings.customDomains || []);
  setSelectedBreakTheme(settings.breakScreen || "default");
}

function collectSettingsFromUI() {
  return {
    enabled:       els.toggleEnabled.checked,
    breakInterval: parseInt(els.breakInterval.value, 10),
    breakDuration: parseInt(els.breakDuration.value, 10),
    allowSkip:     els.toggleSkip.checked,
    breakScreen:   currentSettings.breakScreen || "default",
    customDomains: currentSettings.customDomains || []
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
  const settings = collectSettingsFromUI();
  await chrome.storage.local.set({ settings });
  currentSettings = settings;

  try {
    await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED", settings });
  } catch {
    // BG might be restarting
  }

  log("Settings saved:", settings);
  showSaveStatus("✓ Settings saved");
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

function renderSiteUsageList(usage, intervalMs) {
  if (!els.siteUsageList) return;
  const entries = Object.entries(usage || {})
    .filter(([, ms]) => ms >= 1000)
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    els.siteUsageList.innerHTML = `<li class="site-usage-empty">Visit blocked sites to start tracking.</li>`;
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

/** Reset usage */
els.resetBtn.addEventListener("click", async () => {
  if (!confirm("Reset all usage statistics?")) return;
  try {
    await chrome.runtime.sendMessage({ type: "RESET_USAGE" });
    showSaveStatus("Usage stats reset");
    await fetchStatus();
  } catch (err) {
    showSaveStatus("Error resetting usage", true);
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

if (els.breakThemeList) {
  els.breakThemeList.addEventListener("click", (e) => {
    const btn = e.target.closest(".theme-item");
    if (!btn) return;
    if (btn.dataset.locked && !isPremiumUnlocked()) {
      showSaveStatus("Premium screen. Unlock with subscription.", true);
      return;
    }
    currentSettings.breakScreen = btn.dataset.theme || "default";
    setSelectedBreakTheme(currentSettings.breakScreen);
    log("Break screen selected:", currentSettings.breakScreen);
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

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  await refreshEntitlementsUI();
  await fetchStatus();

  // Poll status every 2s while popup is open
  setInterval(fetchStatus, 2000);
}

void init();
