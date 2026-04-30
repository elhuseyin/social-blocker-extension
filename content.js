/**
 * content.js — Focus Guard Content Script
 * Injected into blocked social media pages.
 * Responsibilities:
 *   - Listen for break start/end messages from the background service worker
 *   - Inject the full-screen overlay UI with countdown timer
 *   - Freeze/unfreeze page interaction (scroll, clicks, keyboard)
 *   - Update countdown every second
 *   - Send SKIP_BREAK to background when user clicks Skip
 */

(function () {
  "use strict";

  /** Prevent duplicate listeners when background programmatically reinjects this file. */
  const CS_INIT_KEY = "__FOCUS_GUARD_CONTENT_SCRIPT_V2__";
  if (globalThis[CS_INIT_KEY]) {
    return;
  }
  globalThis[CS_INIT_KEY] = true;

  const LOG_PREFIX = "[FocusGuard CS]";

  /** Shared entitlements (same module as popup / background); dynamic import for classic script injection. */
  let resolveBreakScreenFn = null;
  function loadEntitlementsOnce() {
    if (resolveBreakScreenFn) return Promise.resolve();
    return import(chrome.runtime.getURL("entitlements.js")).then((mod) => {
      resolveBreakScreenFn = mod.resolveBreakScreen;
    });
  }

  async function resolveBreakScreenSafe(screen) {
    await loadEntitlementsOnce();
    return resolveBreakScreenFn(screen);
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  let overlayEl       = null;   // DOM reference to the overlay root
  let countdownTimer  = null;   // setInterval id for live countdown
  let breakEndsAt     = null;   // epoch ms
  let activeBreakScreen = "default"; // currently selected break overlay theme
  let frozenListeners = [];     // cleanup list for event listeners
  let pausedMediaEls  = [];     // media elements paused by the extension
  let quoteRotationTimer = null;
  let currentQuoteIndex = -1;
  let quoteHistory = [];
  let quoteHistoryCursor = -1;

  const FOREST_QUOTES = [
    { text: "Do what you can, with what you have, where you are.", author: "Theodore Roosevelt" },
    { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
    { text: "Action is the foundational key to all success.", author: "Pablo Picasso" },
    { text: "Nothing will work unless you do.", author: "Maya Angelou" },
    { text: "Either you run the day or the day runs you.", author: "Jim Rohn" },
    { text: "Success is not final, failure is not fatal: it is the courage to continue.", author: "Winston Churchill" },
    { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
    { text: "Energy and persistence conquer all things.", author: "Benjamin Franklin" },
    { text: "You can never quit. Winners never quit.", author: "Ted Turner" },
    { text: "We may encounter defeats but we must not be defeated.", author: "Maya Angelou" },
    { text: "Whether you think you can or you think you can't, you're right.", author: "Henry Ford" },
    { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
    { text: "Act as if what you do makes a difference. It does.", author: "William James" },
    { text: "The only limit to our realization of tomorrow is our doubts of today.", author: "Franklin D. Roosevelt" },
    { text: "Life is 10% what happens to us and 90% how we react to it.", author: "Charles R. Swindoll" },
    { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
    { text: "Try not to become a person of success, but of value.", author: "Albert Einstein" },
    { text: "Opportunities don't happen, you create them.", author: "Chris Grosser" },
    { text: "Dream big and dare to fail.", author: "Norman Vaughan" },
    { text: "The best way to predict the future is to invent it.", author: "Alan Kay" },
    { text: "Everything you've ever wanted is on the other side of fear.", author: "George Addair" },
    { text: "Do one thing every day that scares you.", author: "Eleanor Roosevelt" },
    { text: "When something is important enough, you do it.", author: "Elon Musk" },
    { text: "The harder the conflict, the more glorious the triumph.", author: "Thomas Paine" },
    { text: "Out of difficulties grow miracles.", author: "Jean de La Bruyere" },
    { text: "Don't let yesterday take up too much of today.", author: "Will Rogers" },
    { text: "You miss 100% of the shots you don't take.", author: "Wayne Gretzky" },
    { text: "Pursue one great aim with determination.", author: "Carl von Clausewitz" },
    { text: "Don't wait. The time will never be just right.", author: "Napoleon Hill" },
    { text: "Focus on being productive instead of busy.", author: "" },
    { text: "The future belongs to those who believe in their dreams.", author: "Eleanor Roosevelt" },
    { text: "A goal is a dream with a deadline.", author: "Napoleon Hill" },
    { text: "Hardships prepare people for an extraordinary destiny.", author: "C. S. Lewis" },
    { text: "You are never too old to set another goal.", author: "C. S. Lewis" },
    { text: "Dreams don't work unless you do.", author: "John C. Maxwell" },
    { text: "Rules for happiness: something to do, someone to love, something to hope for.", author: "Immanuel Kant" },
    { text: "When something's uncomfortable, you're growing.", author: "Melinda French Gates" },
    { text: "Perfection is achieved when there is nothing left to take away.", author: "Antoine de Saint-Exupery" },
    { text: "Blessed are the hearts that can bend.", author: "Albert Camus" },
    { text: "Parents can guide, but you shape your character.", author: "Anne Frank" },
    { text: "Keep going.", author: "Sam Levenson" },
    { text: "Make it happen.", author: "Unknown attribution" },
    { text: "Stay hungry, stay foolish.", author: "Steve Jobs" },
    { text: "Make each day your masterpiece.", author: "John Wooden" },
    { text: "Start where you are.", author: "Arthur Ashe" },
    { text: "I have not failed. I've just found 10,000 ways that won't work.", author: "Thomas Edison" },
    { text: "If you fell down yesterday, stand up today.", author: "H. G. Wells" },
    { text: "Success usually comes to those who are too busy.", author: "Henry David Thoreau" },
    { text: "Don't be pushed by fear. Be led by dreams.", author: "Roy T. Bennett" },
    { text: "A dream doesn't become reality through magic.", author: "Colin Powell" }
  ];

  // ─── Logging ────────────────────────────────────────────────────────────────

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function extractDomain(url) {
    if (!url || !url.startsWith("http")) return null;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function isBlockedDomainForSettings(domain, settings) {
    if (!domain || !settings) return false;
    const builtIn = ["instagram.com", "facebook.com", "twitter.com", "x.com"];
    const custom = Array.isArray(settings.customDomains) ? settings.customDomains : [];
    const all = [...builtIn, ...custom];
    return all.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
  }

  /** True if event path includes our overlay (works with open shadow DOM / retargeting). */
  function eventTargetsOverlay(e) {
    if (!overlayEl) return false;
    if (overlayEl.contains(e.target)) return true;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n === overlayEl) return true;
      if (n && n.nodeType === 1 && overlayEl.contains(n)) return true;
    }
    return false;
  }

  /** Prevent all user interactions while overlay is active. */
  function freezePage() {
    const stopEvent = (e) => {
      if (eventTargetsOverlay(e)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };

    const interactionEvents = [
      "click", "mousedown", "mouseup", "mousemove", "dblclick", "contextmenu",
      "pointerdown", "pointerup", "pointermove", "pointercancel",
      "keydown", "keyup", "keypress",
      "touchstart", "touchend", "touchmove", "touchcancel",
      "wheel", "scroll"
    ];
    const roots = [document, window];
    roots.forEach((root) => {
      interactionEvents.forEach((evt) => {
        root.addEventListener(evt, stopEvent, { capture: true, passive: false });
        frozenListeners.push({ root, evt, fn: stopEvent });
      });
    });

    document.documentElement.style.overflow = "hidden";
    if (document.body) document.body.style.overflow = "hidden";
    log("Page frozen.");
  }

  /** Re-enable page interaction. */
  function unfreezePage() {
    frozenListeners.forEach(({ root, evt, fn }) => {
      (root || document).removeEventListener(evt, fn, { capture: true });
    });
    frozenListeners = [];

    document.documentElement.style.overflow = "";
    if (document.body) document.body.style.overflow = "";
    log("Page unfrozen.");
  }

  /** Pause currently playing media and remember what we paused. */
  function pausePageMedia() {
    pausedMediaEls = [];
    const mediaEls = document.querySelectorAll("video, audio");
    mediaEls.forEach((el) => {
      if (!el.paused && !el.ended) {
        try {
          el.pause();
          pausedMediaEls.push(el);
        } catch {
          // Ignore pause failures from site-level restrictions
        }
      }
    });
    if (pausedMediaEls.length) {
      log("Paused media elements:", pausedMediaEls.length);
    }
  }

  /** Resume only media elements that we paused during break start. */
  function resumePageMedia() {
    if (!pausedMediaEls.length) return;
    pausedMediaEls.forEach((el) => {
      try {
        if (el.isConnected && el.paused && !el.ended) {
          const result = el.play();
          if (result && typeof result.catch === "function") {
            result.catch(() => {
              // Autoplay may be blocked by browser policy; safe to ignore
            });
          }
        }
      } catch {
        // Ignore individual resume failures
      }
    });
    log("Attempted to resume media elements:", pausedMediaEls.length);
    pausedMediaEls = [];
  }

  // ─── Countdown ───────────────────────────────────────────────────────────────

  /** Format epoch ms remaining into MM:SS string. */
  function formatCountdown(endsAt) {
    const remaining = Math.max(0, endsAt - Date.now());
    const totalSec  = Math.ceil(remaining / 1000);
    const mins      = Math.floor(totalSec / 60);
    const secs      = totalSec % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function startCountdown(endsAt) {
    stopCountdown();
    const timerEl = document.getElementById("fg-countdown");
    if (!timerEl) return;

    timerEl.textContent = formatCountdown(endsAt);

    countdownTimer = setInterval(() => {
      if (!timerEl) return stopCountdown();
      const remaining = endsAt - Date.now();
      timerEl.textContent = formatCountdown(endsAt);

      // Pulse animation on the last 10 seconds
      if (remaining <= 10000) {
        timerEl.classList.add("fg-pulse");
      }

      if (remaining <= 0) {
        stopCountdown();
      }
    }, 1000);
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // ─── Overlay ─────────────────────────────────────────────────────────────────

  function buildOverlay(endsAt, allowSkip, breakScreen) {
    const overlay = document.createElement("div");
    overlay.id = "fg-overlay";
    overlay.classList.add(`fg-theme-${breakScreen || "default"}`);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Focus break in progress");

    const isCatTheme = breakScreen === "cat";
    const isForestTheme = breakScreen === "forest";
    const animationMarkup = isCatTheme
      ? `
        <div id="fg-animation-container" class="fg-cat-wrap" aria-hidden="true">
          <div class="fg-cat">🐱</div>
          <div class="fg-cat-shadow"></div>
        </div>
      `
      : isForestTheme
      ? `
        <div id="fg-animation-container" class="fg-quote-wrap">
          <figure id="fg-quote-card" aria-live="polite">
            <blockquote id="fg-quote-text"></blockquote>
            <figcaption id="fg-quote-author"></figcaption>
          </figure>
        </div>
      `
      : `
        <div id="fg-animation-container" aria-hidden="true">
          <div id="fg-orb"></div>
        </div>
      `;

    const headline = isCatTheme ? "Cat break time" : "Time for a break";
    const subtext = isCatTheme
      ? "Stretch with your cat, breathe, and come back focused."
      : "Step away, breathe. Your focus will thank you.";
    const contentTopMarkup = isForestTheme
      ? ""
      : `
          <div id="fg-eyebrow">Focus Guard</div>
          <h1 id="fg-headline">${headline}</h1>
          <p id="fg-subtext">${subtext}</p>
        `;
    const quoteControlsMarkup = isForestTheme
      ? `
          <div id="fg-quote-controls">
            <button id="fg-quote-prev" type="button" aria-label="Show previous quote">
              <span aria-hidden="true">←</span>
              Previous quote
            </button>
          </div>
        `
      : "";

    overlay.innerHTML = `
      <div id="fg-panel">

        ${animationMarkup}

        <div id="fg-content">
          ${contentTopMarkup}

          <div id="fg-timer-wrapper" aria-live="polite" aria-label="Time remaining">
            <div id="fg-timer-label">back in</div>
            <div id="fg-countdown">00:00</div>
          </div>

          ${quoteControlsMarkup}

          ${allowSkip ? `
          <button id="fg-skip-btn" type="button" aria-label="Skip this break">
            Skip break
          </button>
          ` : ""}
        </div>

      </div>
    `;

    // Skip button listener — isolated from frozen events by pointer-events CSS
    if (allowSkip) {
      const skipBtn = overlay.querySelector("#fg-skip-btn");
      if (skipBtn) {
        skipBtn.addEventListener("click", async (e) => {
          e.stopImmediatePropagation();
          log("Skip break clicked.");
          try {
            await chrome.runtime.sendMessage({ type: "SKIP_BREAK" });
          } catch (err) {
            log("Skip message error:", err);
          }
          removeOverlay();
        }, { capture: true });
      }
    }

    if (isForestTheme) {
      const prevBtn = overlay.querySelector("#fg-quote-prev");
      if (prevBtn) {
        prevBtn.addEventListener("click", (e) => {
          e.stopImmediatePropagation();
          showPreviousQuote();
        }, { capture: true });
      }
    }

    return overlay;
  }

  /** Mount overlay on body when possible so fixed positioning covers the full tab (SPAs, YouTube). */
  function mountOverlay(overlay) {
    const attach = () => {
      const parent = document.body || document.documentElement;
      try {
        parent.appendChild(overlay);
      } catch (err) {
        log("appendChild failed, retrying on documentElement:", err);
        document.documentElement.appendChild(overlay);
      }
    };
    const moveToBodyIfNeeded = () => {
      try {
        if (overlay.parentNode && document.body && overlay.parentNode !== document.body) {
          document.body.appendChild(overlay);
        }
      } catch (err) {
        log("Move overlay to body failed:", err);
      }
    };
    attach();
    if (document.body && overlay.parentNode !== document.body) {
      moveToBodyIfNeeded();
    } else if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", moveToBodyIfNeeded, { once: true });
    }
  }

  function stopQuoteRotation() {
    if (quoteRotationTimer) {
      clearInterval(quoteRotationTimer);
      quoteRotationTimer = null;
    }
  }

  function resetQuoteRotationTimer() {
    stopQuoteRotation();
    if (activeBreakScreen !== "forest" || !overlayEl) return;
    quoteRotationTimer = setInterval(() => {
      showNextQuote();
    }, 15000);
  }

  function updateQuoteNavState() {
    const prevBtn = document.getElementById("fg-quote-prev");
    if (!prevBtn) return;
    const canGoBack = quoteHistoryCursor > 0;
    prevBtn.disabled = !canGoBack;
    prevBtn.setAttribute("aria-disabled", canGoBack ? "false" : "true");
  }

  function renderQuote(index, useTransition = true) {
    const quoteTextEl = document.getElementById("fg-quote-text");
    const quoteAuthorEl = document.getElementById("fg-quote-author");
    const quoteCardEl = document.getElementById("fg-quote-card");
    if (!quoteTextEl || !quoteAuthorEl || !quoteCardEl) return;

    const quote = FOREST_QUOTES[index];
    const writeQuote = () => {
      quoteTextEl.textContent = `"${quote.text}"`;
      quoteAuthorEl.textContent = quote.author ? `- ${quote.author}` : "";
    };

    if (!useTransition) {
      writeQuote();
      return;
    }

    quoteCardEl.classList.add("fg-quote-switching");
    setTimeout(() => {
      if (!quoteCardEl.isConnected) return;
      writeQuote();
      requestAnimationFrame(() => {
        quoteCardEl.classList.remove("fg-quote-switching");
      });
    }, 140);
  }

  function showQuote(index, { recordHistory = true, useTransition = true } = {}) {
    if (!FOREST_QUOTES.length) return;
    const normalized = ((index % FOREST_QUOTES.length) + FOREST_QUOTES.length) % FOREST_QUOTES.length;
    currentQuoteIndex = normalized;

    if (recordHistory) {
      quoteHistory = quoteHistory.slice(0, quoteHistoryCursor + 1);
      quoteHistory.push(normalized);
      quoteHistoryCursor = quoteHistory.length - 1;
    }

    renderQuote(normalized, useTransition);
    updateQuoteNavState();
    resetQuoteRotationTimer();
  }

  function showNextQuote() {
    if (!FOREST_QUOTES.length) return;
    const nextIndex = currentQuoteIndex < 0 ? Math.floor(Math.random() * FOREST_QUOTES.length) : currentQuoteIndex + 1;
    showQuote(nextIndex, { recordHistory: true, useTransition: true });
  }

  function showPreviousQuote() {
    if (quoteHistoryCursor <= 0) return;
    quoteHistoryCursor -= 1;
    const prevIndex = quoteHistory[quoteHistoryCursor];
    currentQuoteIndex = prevIndex;
    renderQuote(prevIndex, true);
    updateQuoteNavState();
    resetQuoteRotationTimer();
  }

  function startQuoteRotation() {
    if (activeBreakScreen !== "forest") return;
    const quoteTextEl = document.getElementById("fg-quote-text");
    const quoteAuthorEl = document.getElementById("fg-quote-author");
    if (!quoteTextEl || !quoteAuthorEl || !FOREST_QUOTES.length) return;

    quoteHistory = [];
    quoteHistoryCursor = -1;
    currentQuoteIndex = -1;
    showNextQuote();
  }

  function injectOverlay(endsAt, allowSkip, breakScreen = "default") {
    // Don't inject twice
    if (overlayEl) {
      updateOverlay(endsAt, allowSkip, breakScreen);
      return;
    }

    breakEndsAt = endsAt;
    activeBreakScreen = breakScreen || "default";
    overlayEl   = buildOverlay(endsAt, allowSkip, activeBreakScreen);
    mountOverlay(overlayEl);
    document.documentElement.classList.add("fg-blocked");
    document.documentElement.style.overflow = "hidden";

    // Show overlay immediately so it always captures hits (opacity 0 can let clicks through).
    overlayEl.classList.add("fg-visible");

    freezePage();
    pausePageMedia();
    startCountdown(endsAt);
    startQuoteRotation();
    log("Overlay injected. Break ends at:", new Date(endsAt).toISOString());
  }

  /** Update an existing overlay with new end time (e.g. after SW restart). */
  function updateOverlay(endsAt, allowSkip, breakScreen = "default") {
    if (overlayEl && breakScreen !== activeBreakScreen) {
      // Theme changed while break is active; rebuild overlay with new theme.
      const hadOverlay = overlayEl;
      removeOverlay();
      if (hadOverlay) {
        injectOverlay(endsAt, allowSkip, breakScreen);
        return;
      }
    }
    breakEndsAt = endsAt;
    startCountdown(endsAt);
    if (breakScreen === "forest") {
      // BREAK_TICK runs every second; only initialize quote rotation once per overlay session.
      if (!quoteRotationTimer || currentQuoteIndex < 0) {
        startQuoteRotation();
      }
    } else {
      stopQuoteRotation();
    }
    log("Overlay updated. Break ends at:", new Date(endsAt).toISOString());
  }

  function removeOverlay() {
    if (!overlayEl) return;

    overlayEl.classList.remove("fg-visible");
    overlayEl.classList.add("fg-hiding");
    document.documentElement.classList.remove("fg-blocked");
    document.documentElement.style.overflow = "";

    // Remove after transition ends
    overlayEl.addEventListener("transitionend", () => {
      overlayEl?.remove();
      overlayEl = null;
    }, { once: true });


    setTimeout(() => {
      if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
      }
    }, 700); // match your CSS transition (0.6s)

    stopCountdown();
    stopQuoteRotation();
    quoteHistory = [];
    quoteHistoryCursor = -1;
    currentQuoteIndex = -1;
    unfreezePage();
    resumePageMedia();
    log("Overlay removed.");
  }

  // ─── Message Listener ────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      log("Message received:", message.type);
      try {
        switch (message.type) {
          case "PING":
            sendResponse({ ok: true });
            return;
          case "START_BREAK": {
            const screen = await resolveBreakScreenSafe(message.breakScreen || "default");
            injectOverlay(message.endsAt, message.allowSkip !== false, screen);
            sendResponse({ ok: true });
            return;
          }
          case "BREAK_TICK": {
            const screen = await resolveBreakScreenSafe(message.breakScreen || "default");
            if (!overlayEl) {
              injectOverlay(message.endsAt, message.allowSkip !== false, screen);
            } else {
              updateOverlay(message.endsAt, message.allowSkip !== false, screen);
            }
            sendResponse({ ok: true });
            return;
          }
          case "END_BREAK":
            removeOverlay();
            sendResponse({ ok: true });
            return;
          default:
            sendResponse({ ok: false });
        }
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  // ─── On Load — Check if break is already active ───────────────────────────

  (async function checkInitialBreakState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
      const currentDomain = extractDomain(window.location.href);
      const isBlockedHere = isBlockedDomainForSettings(currentDomain, response?.settings);
      if (response && isBlockedHere && response.breakActive && response.breakEndsAt) {
        log("Break already active on page load. Injecting overlay.");
        const screen = await resolveBreakScreenSafe(response.settings?.breakScreen || "default");
        injectOverlay(
          response.breakEndsAt,
          response.settings?.allowSkip !== false,
          screen
        );
      } else if (!isBlockedHere) {
        log("Current domain not blocked. Overlay inactive on this site.");
      }
    } catch (err) {
      log("Could not check initial break state:", err);
    }
  })();

  log("Content script loaded on:", window.location.hostname);
})();
