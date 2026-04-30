/**
 * background.js — Focus Guard Service Worker
 * Handles tab tracking, time accumulation, break scheduling, and overlay triggering.
 * Runs as a Manifest V3 service worker (persistent via alarms).
 */

import { getEntitlements, resolveBreakScreen } from "./entitlements.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  breakInterval: 0.5,        // minutes before a break is triggered
  breakDuration: 0.5,        // minutes the break lasts
  allowSkip: true,          // show "Skip break" button in overlay
  breakScreen: "default",   // selected break overlay theme
  customDomains: []         // user-added domains
};

const BUILT_IN_DOMAINS = [
  "instagram.com",
  "facebook.com",
  "twitter.com",
  "x.com"
];

const TICK_INTERVAL_MS   = 1000;   // how often we update time (1s)
const TICK_INTERVAL_NAME = "focusguard_keepalive"; // alarm fires every minute just to keep SW alive
const LOG_PREFIX         = "[FocusGuard BG]";

// ─── State (in-memory; rebuilt from storage on SW wake) ──────────────────────

let state = {
  activeTabId:       null,   // currently focused tab id
  activeTabDomain:   null,   // domain of active tab (if blocked)
  lastTickTime:      Date.now(),   // Date.now() at last tick — initialized so first elapsed is valid
  breakActive:       false,  // is a break currently running?
  breakEndsAt:       null,   // epoch ms when break ends
  settings:          { ...DEFAULT_SETTINGS },
  usage:             {}      // { "instagram.com": totalMs, ... }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

/** Log chrome.runtime.lastError when present (e.g. after failed sendMessage). */
function logLastError(context) {
  try {
    const msg = chrome.runtime.lastError?.message;
    if (msg) log(context, "chrome.runtime.lastError:", msg);
  } catch {
    // ignore
  }
}

/** Return true if tab responds to PING (content script alive). */
async function pingContentScript(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return !!(resp && resp.ok === true);
  } catch (err) {
    logLastError(`pingContentScript tab ${tabId}`);
    log("pingContentScript: failed", tabId, err?.message || err);
    return false;
  }
}

/** Inject content.js + overlay.css into the tab (programmatic registration). */
async function injectContentScriptAndStyles(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (err) {
    logLastError(`injectContentScriptAndStyles executeScript tab ${tabId}`);
    log("injectContentScriptAndStyles: executeScript failed", tabId, err);
    throw err;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["overlay.css"]
    });
  } catch (err) {
    logLastError(`injectContentScriptAndStyles insertCSS tab ${tabId}`);
    log("injectContentScriptAndStyles: insertCSS failed (non-fatal)", tabId, err);
  }
}

/** Wait until PING succeeds or attempts exhausted. */
async function waitForContentScriptReady(tabId, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 40 : 90));
    if (await pingContentScript(tabId)) return true;
  }
  return false;
}

/**
 * Ensure the tab has our content script + overlay CSS (PING probe).
 * If PING fails, inject content.js and overlay.css, then verify with PING again.
 */
async function ensureContentScript(tabId) {
  if (tabId == null || tabId === chrome.tabs.TAB_ID_NONE) {
    log("ensureContentScript: invalid tabId");
    return false;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    log("ensureContentScript: tabs.get failed", tabId, err);
    return false;
  }

  const url = tab.url || "";
  if (!/^https?:\/\//i.test(url)) {
    log("ensureContentScript: skip non-http(s) tab", tabId, url.slice(0, 64));
    return false;
  }

  if (await pingContentScript(tabId)) return true;

  log("ensureContentScript: PING failed, injecting content.js + overlay.css", tabId);

  try {
    await injectContentScriptAndStyles(tabId);
  } catch {
    return false;
  }

  const ready = await waitForContentScriptReady(tabId);
  if (!ready) log("ensureContentScript: PING never succeeded after inject", tabId);
  return ready;
}

/** Deliver a break-related message: ensure CS, send, force reinject + resend on failure. */
async function sendBreakMessageToTab(tabId, message) {
  let ready = await ensureContentScript(tabId);
  if (!ready) {
    log("sendBreakMessageToTab: ensureContentScript failed before send", tabId, message.type);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch (err) {
    logLastError(`sendBreakMessageToTab first send tab ${tabId} type ${message.type}`);
    log("sendBreakMessageToTab: first sendMessage failed, forcing reinject", tabId, err?.message || err);
  }

  try {
    await injectContentScriptAndStyles(tabId);
  } catch (err) {
    log("sendBreakMessageToTab: reinject failed", tabId, err);
    return;
  }

  ready = await waitForContentScriptReady(tabId);
  if (!ready) {
    log("sendBreakMessageToTab: tab not ready after reinject", tabId, message.type);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err2) {
    logLastError(`sendBreakMessageToTab second send tab ${tabId} type ${message.type}`);
    log("sendBreakMessageToTab: second sendMessage failed", tabId, err2?.message || err2);
  }
}

/** Extract eTLD+1-like domain from a URL string, or null. */
function extractDomain(url) {
  if (!url || !url.startsWith("http")) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname;
  } catch {
    return null;
  }
}

/** Return true if domain matches one of the blocked domains. */
function isBlockedDomain(domain) {
  if (!domain) return false;
  const all = [...BUILT_IN_DOMAINS, ...(state.settings.customDomains || [])];
  return all.some(blocked => domain === blocked || domain.endsWith("." + blocked));
}

/** Persist usage and break state to chrome.storage.local. */
async function persistState() {
  await chrome.storage.local.set({
    usage:       state.usage,
    breakActive: state.breakActive,
    breakEndsAt: state.breakEndsAt
  });
}

/** If stored break screen is premium and user is not entitled, persist `default`. */
async function normalizeBreakScreenInState() {
  const next = await resolveBreakScreen(state.settings?.breakScreen);
  if (!state.settings || state.settings.breakScreen === next) return;
  const newSettings = { ...state.settings, breakScreen: next };
  state.settings = newSettings;
  await chrome.storage.local.set({ settings: newSettings });
  log("Break screen normalized to:", next);
}

/** Load settings + usage + break state from storage. */
async function loadState() {
  const data = await chrome.storage.local.get(["settings", "usage", "breakActive", "breakEndsAt"]);
  state.settings    = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  await normalizeBreakScreenInState();
  state.usage       = data.usage       || {};
  state.breakActive = data.breakActive || false;
  state.breakEndsAt = data.breakEndsAt || null;
  log("State loaded from storage:", state.usage, "breakActive:", state.breakActive);
}

/** Get cumulative ms for a domain this session-period. */
function getUsageMs(domain) {
  return state.usage[domain] || 0;
}

/** Add ms to a domain's usage counter. */
function addUsageMs(domain, ms) {
  if (!domain) return;
  state.usage[domain] = (state.usage[domain] || 0) + ms;
}

/** Reset usage for a given domain. */
function resetUsage(domain) {
  if (!domain) return;
  state.usage[domain] = 0;
  log("Usage reset for:", domain);
}

/** Clear all usage so the next break interval counts from 0 for every site. */
function resetAllUsage() {
  state.usage = {};
  log("All usage reset (post-break).");
}

// ─── Break Management ─────────────────────────────────────────────────────────

/** Start a break: sets state, persists, and notifies all relevant tabs. */
async function startBreak() {
  const breakMs     = state.settings.breakDuration * 60 * 1000;
  state.breakActive = true;
  state.breakEndsAt = Date.now() + breakMs;
  await persistState();
  log("Break started. Ends at:", new Date(state.breakEndsAt).toISOString());
  const breakScreen = await resolveBreakScreen(state.settings.breakScreen);
  await notifyAllBlockedTabs("START_BREAK", {
    endsAt: state.breakEndsAt,
    allowSkip: state.settings.allowSkip,
    breakScreen
  });
}

/** End the break: resets usage, clears state, notifies tabs. */
async function endBreak(skipped = false) {
  log("Break ended. Skipped:", skipped);
  state.breakActive = false;
  state.breakEndsAt = null;

  // Fresh interval: count from 0 toward breakInterval again (all tracked sites).
  resetAllUsage();
  state.lastTickTime = Date.now();

  await persistState();
  await notifyAllBlockedTabs("END_BREAK", {});
}

/** Send a message to the content script of every tab on a blocked domain. */
async function notifyAllBlockedTabs(type, payload) {
  try {
    const tabs = await chrome.tabs.query({});
    const message = { type, ...payload };
    for (const tab of tabs) {
      const domain = extractDomain(tab.url);
      if (isBlockedDomain(domain)) {
        await sendBreakMessageToTab(tab.id, message);
      }
    }
  } catch (err) {
    log("notifyAllBlockedTabs error:", err);
  }
}

/** Notify the content script on a specific tab (START_BREAK / BREAK_TICK / END_BREAK). */
async function notifyTab(tabId, type, payload) {
  const message = { type, ...payload };
  await sendBreakMessageToTab(tabId, message);
}

// ─── Tick Logic (runs every TICK_INTERVAL_MS via alarm) ──────────────────────

async function onTick() {
  if (!state.settings.enabled) return;

  const now = Date.now();

  // ── Handle active break countdown ──────────────────────────────────────────
  if (state.breakActive) {
    if (state.breakEndsAt && now >= state.breakEndsAt) {
      await endBreak(false);
    }
    // Keep notifying the active tab so its countdown stays fresh after navigations
    if (state.breakActive && state.activeTabId && isBlockedDomain(state.activeTabDomain)) {
      const breakScreen = await resolveBreakScreen(state.settings.breakScreen);
      await notifyTab(state.activeTabId, "BREAK_TICK", {
        endsAt:    state.breakEndsAt,
        allowSkip: state.settings.allowSkip,
        breakScreen
      });
    }
    // Advance tick baseline during breaks so the first tick after break does not
    // add the entire break duration as "usage" (would instantly refill the bar).
    state.lastTickTime = now;
    return; // Don't accumulate usage during break
  }

  // ── Accumulate usage for active blocked tab ────────────────────────────────
  if (state.activeTabId !== null && state.activeTabDomain && state.lastTickTime) {
    const elapsed = now - state.lastTickTime;
    addUsageMs(state.activeTabDomain, elapsed);
    await persistState();

    const totalMs       = getUsageMs(state.activeTabDomain);
    const intervalMs    = state.settings.breakInterval * 60 * 1000;

    log(`Usage [${state.activeTabDomain}]: ${Math.round(totalMs / 1000)}s / ${state.settings.breakInterval * 60}s`);

    if (totalMs >= intervalMs) {
      await startBreak();
    }
  }

  state.lastTickTime = now;
}

// ─── Tab Event Handlers ───────────────────────────────────────────────────────

/** Called whenever we need to re-evaluate which tab is "active". */
async function handleTabChange(tabId, url) {
  const domain = extractDomain(url);
  const newBlockedDomain = isBlockedDomain(domain) ? domain : null;

  state.activeTabId     = tabId;
  state.activeTabDomain = newBlockedDomain;
  // Reset the tick baseline so we don't count time spent in other tabs
  state.lastTickTime    = Date.now();

  log("Active tab changed:", domain, "| blocked:", !!state.activeTabDomain);

  // If a break is already active and the user navigated to a blocked site, re-trigger overlay
  if (state.breakActive && state.activeTabDomain) {
    const breakScreen = await resolveBreakScreen(state.settings.breakScreen);
    await notifyTab(tabId, "START_BREAK", {
      endsAt:    state.breakEndsAt,
      allowSkip: state.settings.allowSkip,
      breakScreen
    });
  }
}

// ─── Chrome Event Listeners ───────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await handleTabChange(tabId, tab.url || "");
  } catch (err) {
    log("onActivated error:", err);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  // Only care about the currently active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || activeTab.id !== tabId) return;

  await handleTabChange(tabId, tab.url || "");
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // User switched to another app — stop counting
    state.activeTabId    = null;
    state.activeTabDomain = null;
    state.lastTickTime   = null;
    return;
  }
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab) await handleTabChange(activeTab.id, activeTab.url || "");
  } catch (err) {
    log("onFocusChanged error:", err);
  }
});

// ─── Messages from popup / content scripts ────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {

      case "SKIP_BREAK":
        if (state.breakActive) await endBreak(true);
        sendResponse({ ok: true });
        break;

      case "GET_STATUS": {
        const { isSubscribed, devMode } = await getEntitlements();
        sendResponse({
          breakActive:   state.breakActive,
          breakEndsAt:   state.breakEndsAt,
          usage:         state.usage,
          settings:      state.settings,
          activeDomain:  state.activeTabDomain,
          isSubscribed,
          devMode
        });
        break;
      }

      case "SETTINGS_UPDATED":
        state.settings = { ...DEFAULT_SETTINGS, ...message.settings };
        await normalizeBreakScreenInState();
        log("Settings updated:", state.settings);
        sendResponse({ ok: true });
        break;

      case "RESET_USAGE":
        state.usage = {};
        await persistState();
        log("All usage reset by user.");
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true; // keep channel open for async response
});

// ─── Storage change listener (settings updated from popup) ───────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    log("Settings synced from storage:", state.settings);
  }
  if (changes.settings || changes.devMode || changes.subscribed || changes.dev_mode) {
    void normalizeBreakScreenInState();
  }
});

// ─── Alarm (SW keepalive only — Chrome MV3 SWs die after ~30s of inactivity) ──
// The alarm fires every minute to keep the SW alive.
// Actual ticking is done by setInterval below, which runs as long as SW is alive.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_INTERVAL_NAME) {
    // MV3 service workers suspend; setInterval does not run while asleep.
    // When this alarm fires the worker wakes — flush elapsed time and break logic.
    log("Keepalive alarm fired — running tick.");
    void safeOnTick();
  }
});

/** Serialize ticks so alarm + setInterval never double-process the same window. */
let tickLock = false;
async function safeOnTick() {
  if (tickLock) return;
  tickLock = true;
  try {
    await onTick();
  } finally {
    tickLock = false;
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  log("Service worker starting…");
  await loadState();

  // ── Create keepalive alarm (minimum 1 minute — just prevents SW from dying) ──
  const existing = await chrome.alarms.get(TICK_INTERVAL_NAME);
  if (!existing) {
    chrome.alarms.create(TICK_INTERVAL_NAME, { periodInMinutes: 1 });
    log("Keepalive alarm created (1 min).");
  }

  // ── Real tick loop via setInterval (runs while SW is alive) ────────────────
  // SW stays alive as long as there's an active port or ongoing event.
  // The alarm above pings it every minute to restart it if it died.
  setInterval(() => void safeOnTick(), TICK_INTERVAL_MS);
  log("Tick interval started:", TICK_INTERVAL_MS / 1000, "s");

  // Resume break if it was active before SW was killed
  if (state.breakActive && state.breakEndsAt) {
    if (Date.now() >= state.breakEndsAt) {
      await endBreak(false); // break already over
    } else {
      log("Resuming active break from storage.");
      const breakScreen = await resolveBreakScreen(state.settings.breakScreen);
      await notifyAllBlockedTabs("START_BREAK", {
        endsAt:    state.breakEndsAt,
        allowSkip: state.settings.allowSkip,
        breakScreen
      });
    }
  }

  // Sync to current active tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) await handleTabChange(activeTab.id, activeTab.url || "");
  } catch {
    // No active tab yet
  }

  log("Init complete.");
}

init();
