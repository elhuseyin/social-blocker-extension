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

  /** Tear down GIPHY reaction on Skip (Dopamine detox) before removing overlay. */
  let giphySkipProximityTeardown = null;

  // ─── Skip-button hover reaction GIF (night / Dopamine detox only) ───────────

  const GIPHY_SKIP_REACTION_GIF_URL =
    "https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExMDY3bHN2MmF0MDl5ZHIxMnU1czllejVhdXRnajJuNmIwazJvN2xrMyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/7zJZgRRVrKfzo71lnR/giphy.gif";

  let giphySkipGifUrlCache = null;

  function getSkipReactionGifUrlOnce() {
    if (giphySkipGifUrlCache) return Promise.resolve(giphySkipGifUrlCache);
    giphySkipGifUrlCache = GIPHY_SKIP_REACTION_GIF_URL;
    return Promise.resolve(giphySkipGifUrlCache);
  }

  function teardownGiphySkipProximity() {
    if (typeof giphySkipProximityTeardown === "function") {
      try {
        giphySkipProximityTeardown();
      } catch (e) {
        log("GIPHY teardown error:", e);
      }
    }
    giphySkipProximityTeardown = null;
  }

  /**
   * Pointer on Skip only → funny cat GIF (Dopamine detox / night theme, skip allowed).
   * Uses Skip button hit-target so moving toward “Previous quote” does not trigger the GIF.
   */
  function setupNightGiphySkipProximity(overlayRoot, allowSkip) {
    teardownGiphySkipProximity();
    if (!overlayRoot || !allowSkip || activeBreakScreen !== "night") return;

    const skipBtn = overlayRoot.querySelector("#fg-skip-btn");
    if (!skipBtn) return;

    const img = document.createElement("img");
    img.id = "fg-giphy-reaction";
    img.className = "fg-giphy-reaction";
    img.alt = "";
    img.decoding = "async";
    img.setAttribute("aria-hidden", "true");
    overlayRoot.appendChild(img);

    void getSkipReactionGifUrlOnce();

    let pointerOnSkip = false;
    let offsetJX = 0;
    let offsetJY = 0;

    function skipCenter() {
      const r = skipBtn.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }

    function applyPosition() {
      const { cx, cy } = skipCenter();
      img.style.left = `${Math.round(cx - 60 + offsetJX)}px`;
      img.style.top = `${Math.round(cy - 110 + offsetJY)}px`;
    }

    function showGifNearSkip() {
      getSkipReactionGifUrlOnce().then((gifUrl) => {
        if (!gifUrl || !overlayEl || !img.isConnected) return;
        if (!pointerOnSkip) return;
        applyPosition();
        const reveal = () => {
          requestAnimationFrame(() => {
            if (img.isConnected && pointerOnSkip) img.classList.add("fg-giphy-reaction--visible");
          });
        };

        img.onerror = () => log("GIPHY image failed to load");
        if (img.src === gifUrl && img.complete && img.naturalWidth > 0) {
          reveal();
        } else {
          img.onload = reveal;
          img.src = gifUrl;
        }
      });
    }

    function onSkipEnter() {
      pointerOnSkip = true;
      offsetJX = (Math.random() - 0.5) * 28;
      offsetJY = (Math.random() - 0.5) * 20;
      showGifNearSkip();
    }

    function onSkipLeave() {
      pointerOnSkip = false;
      img.classList.remove("fg-giphy-reaction--visible");
    }

    function onSkipMove() {
      if (!pointerOnSkip) return;
      applyPosition();
    }

    skipBtn.addEventListener("mouseenter", onSkipEnter);
    skipBtn.addEventListener("mouseleave", onSkipLeave);
    skipBtn.addEventListener("mousemove", onSkipMove, { passive: true });

    giphySkipProximityTeardown = () => {
      skipBtn.removeEventListener("mouseenter", onSkipEnter);
      skipBtn.removeEventListener("mouseleave", onSkipLeave);
      skipBtn.removeEventListener("mousemove", onSkipMove);
      img.onload = null;
      img.onerror = null;
      img.remove();
    };
  }

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

  const COOKED_QUOTES = [
    { text: "Put the phone down. Now.", author: "" },
    { text: "This is stealing your time.", author: "" },
    { text: "You're doing it again.", author: "" },
    { text: "Nothing here is worth it.", author: "" },
    { text: "You know this ends badly.", author: "" },
    { text: "Stop pretending this is a break.", author: "" },
    { text: "This isn't what you planned.", author: "" },
    { text: "You lost control 10 minutes ago.", author: "" },
    { text: "You're feeding the habit.", author: "" },
    { text: "This is why you feel stuck.", author: "" },
    { text: "You don't even care about this content.", author: "" },
    { text: "You're just filling silence.", author: "" },
    { text: "You're avoiding something real.", author: "" },
    { text: "This loop doesn't end on its own.", author: "" },
    { text: "You've seen enough. Leave.", author: "" },
    { text: "This isn't helping. You know it.", author: "" },
    { text: "You're stuck. Admit it.", author: "" },
    { text: "You opened this without thinking.", author: "" },
    { text: "This is autopilot. Wake up.", author: "" },
    { text: "You're giving your time away.", author: "" },
    { text: "You're not choosing this anymore.", author: "" },
    { text: "The longer you stay, the worse it gets.", author: "" },
    { text: "This is how focus dies.", author: "" },
    { text: "You don't need another video.", author: "" },
    { text: "You're chasing nothing right now.", author: "" },
    { text: "You've already had enough.", author: "" },
    { text: "You're losing minutes you won't get back.", author: "" },
    { text: "You're not even enjoying this.", author: "" },
    { text: "You're just stuck in the loop.", author: "" },
    { text: "This isn't what discipline looks like.", author: "" },
    { text: "You're delaying your life.", author: "" },
    { text: "You're letting this control you.", author: "" },
    { text: "You're not resting. You're escaping.", author: "" },
    { text: "You're wasting energy, not recovering.", author: "" },
    { text: "This is empty. Leave it.", author: "" },
    { text: "You're trading goals for dopamine.", author: "" },
    { text: "You're still here. Why?", author: "" },
    { text: "You don't need this right now.", author: "" },
    { text: "You're going to regret this time.", author: "" },
    { text: "You've lost track again.", author: "" },
    { text: "You're not present. You're scrolling.", author: "" },
    { text: "This is a trap. Exit it.", author: "" },
    { text: "You're stuck in the same cycle.", author: "" },
    { text: "You didn't come here for this.", author: "" },
    { text: "You're letting this win.", author: "" },
    { text: "You're avoiding your priorities.", author: "" },
    { text: "This isn't moving you forward.", author: "" },
    { text: "You're not gaining anything here.", author: "" },
    { text: "This ends when you decide.", author: "" },
    { text: "Decide. Close it.", author: "" }
  ];

  const NIGHT_QUOTES = [
    { text: "You're not tired. You're overstimulated.", author: "" },
    { text: "One more scroll won't change how you feel.", author: "" },
    { text: "Your brain is asking for quiet, not more content.", author: "" },
    { text: "Nothing new is happening in the feed. Just noise.", author: "" },
    { text: "You already saw enough. Close it.", author: "" },
    { text: "This isn't rest. It's avoidance.", author: "" },
    { text: "The urge will pass faster than the video you're about to watch.", author: "" },
    { text: "Your attention is being spent, not saved.", author: "" },
    { text: "You don't need stimulation—you need recovery.", author: "" },
    { text: "Every swipe is training your focus to disappear.", author: "" },
    { text: "Still here? That's the habit talking, not you.", author: "" },
    { text: "Boredom isn't the enemy. Overstimulation is.", author: "" },
    { text: "You opened the app automatically. Not intentionally.", author: "" },
    { text: "Nothing in there is worth more than your next hour.", author: "" },
    { text: "The algorithm is endless. Your time isn't.", author: "" },
    { text: "Step away before you forget why you opened this.", author: "" },
    { text: "You're one decision away from getting your focus back.", author: "" },
    { text: "Less input. More clarity.", author: "" },
    { text: "Your mind feels loud because it hasn't rested.", author: "" },
    { text: "Closing this is the reset you've been postponing.", author: "" },
    { text: "Your brain needs silence more than stimulation.", author: "" },
    { text: "You're not missing out. You're overloaded.", author: "" },
    { text: "More content won't fix this feeling.", author: "" },
    { text: "Your focus is drained, not broken.", author: "" },
    { text: "You don't need more—you need less.", author: "" },
    { text: "Clarity comes when the noise stops.", author: "" },
    { text: "This isn't satisfying. It's numbing.", author: "" },
    { text: "Your mind is full. Give it space.", author: "" },
    { text: "You're not relaxing. You're flooding your brain.", author: "" },
    { text: "Nothing here is restoring you.", author: "" },
    { text: "You're chasing stimulation, not relief.", author: "" },
    { text: "This is input without purpose.", author: "" },
    { text: "Your brain can't reset while you keep scrolling.", author: "" },
    { text: "You've had enough input for now.", author: "" },
    { text: "Rest doesn't look like this.", author: "" },
    { text: "You're adding noise, not value.", author: "" },
    { text: "Your attention needs a break, not a feed.", author: "" },
    { text: "Silence will help more than this.", author: "" },
    { text: "You're overstaying in the noise.", author: "" },
    { text: "The calm you want isn't here.", author: "" },
    { text: "Your brain is asking you to stop.", author: "" },
    { text: "You don't need another hit of dopamine.", author: "" },
    { text: "This is keeping you wired, not rested.", author: "" },
    { text: "Peace starts when this stops.", author: "" },
    { text: "You're not recharging. You're draining.", author: "" },
    { text: "Your mind needs less, not more.", author: "" },
    { text: "This isn't helping your energy.", author: "" },
    { text: "You're feeding stimulation, not focus.", author: "" },
    { text: "You don't feel better because this isn't better.", author: "" },
    { text: "Close this. Let your mind reset.", author: "" }
  ];

  /**
   * Quote-capable break screens: same overlay (quote card, timer, “Previous quote”),
   * same rotation interval, and same history behavior. Add new quote themes here only.
   */
  const QUOTES_BY_BREAK_SCREEN = {
    forest: FOREST_QUOTES,
    cooked: COOKED_QUOTES,
    night: NIGHT_QUOTES
  };

  const QUOTE_ROTATION_MS = 15000;

  function isQuoteBreakTheme(screen) {
    return screen != null && Object.prototype.hasOwnProperty.call(QUOTES_BY_BREAK_SCREEN, screen);
  }

  /** Premium screens with an empty slot for future content (see overlay.css per theme). */
  const PREMIUM_PLACEHOLDER_THEMES = {
    mycat:       { wrapClass: "fg-mycat-wrap", slotId: "fg-mycat-slot", headline: "My cat" },
    sleepingdog: { wrapClass: "fg-sleepingdog-wrap", slotId: "fg-sleepingdog-slot", headline: "Sleeping dog" }
  };

  function getPremiumPlaceholderTheme(screen) {
    return PREMIUM_PLACEHOLDER_THEMES[screen] || null;
  }

  function quotesForActiveTheme() {
    return QUOTES_BY_BREAK_SCREEN[activeBreakScreen] || FOREST_QUOTES;
  }

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
    const allBuiltIns = ["instagram.com", "facebook.com", "twitter.com", "x.com"];
    const disabled = new Set(Array.isArray(settings.disabledBuiltIns) ? settings.disabledBuiltIns : []);
    const builtIn = allBuiltIns.filter((d) => !disabled.has(d));
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

  /** Premium “Breath in breath out” — full illustration (styles in overlay.css). */
  function getBreathScreenMarkup() {
    const breathArtSrc = chrome.runtime.getURL("assets/breath-break-art.png");
    return `
        <div id="fg-animation-container" class="fg-breath-wrap fg-breath-wrap--art-only" aria-hidden="true">
          <div class="fg-breath-art-wrap">
            <img class="fg-breath-art" src="${breathArtSrc}" alt="Meditation pose — breathe in, breathe out." width="640" height="640" decoding="async" />
          </div>
        </div>
      `;
  }

  function buildOverlay(endsAt, allowSkip, breakScreen) {
    const overlay = document.createElement("div");
    overlay.id = "fg-overlay";
    overlay.classList.add(`fg-theme-${breakScreen || "default"}`);
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Focus break in progress");

    const isCatTheme = breakScreen === "cat";
    const isSpaceTheme = breakScreen === "space";
    const isBreathTheme = breakScreen === "breath";
    const isQuotesTheme = isQuoteBreakTheme(breakScreen);
    const quoteScreenLogoSrc =
      breakScreen === "night"
        ? chrome.runtime.getURL("assets/dopamine-detox-logo.png")
        : breakScreen === "cooked"
          ? chrome.runtime.getURL("assets/were-cooked-logo.png")
          : "";
    const premiumPlaceholder = getPremiumPlaceholderTheme(breakScreen);
    const astronautSrc = isSpaceTheme ? chrome.runtime.getURL("assets/astronaut-float.png") : "";
    const catStretchLogoSrc = isCatTheme ? chrome.runtime.getURL("assets/cat-stretch-logo.png") : "";
    const catCssAnimMarkup = isCatTheme
      ? `
        <div id="fg-animation-container" class="fg-cat-wrap fg-cat-wrap--with-logo" aria-hidden="true">
          <div class="fg-cat-logo-wrap" aria-hidden="true">
            <img class="fg-cat-logo" src="${catStretchLogoSrc}" alt="" width="120" height="120" decoding="async" />
          </div>
          <div class="cat-container">
            <div class="cat">
              <div class="ear left"></div>
              <div class="ear right"></div>
              <div class="eye left"></div>
              <div class="eye right"></div>
              <div class="nose"></div>
              <div class="body"></div>
              <div class="tail"></div>
            </div>
          </div>
        </div>
      `
      : "";
    const animationMarkup = isCatTheme
      ? catCssAnimMarkup
      : isBreathTheme
      ? getBreathScreenMarkup()
      : isSpaceTheme
      ? ""
      : isQuotesTheme
      ? `
        <div id="fg-animation-container" class="fg-quote-wrap${quoteScreenLogoSrc ? " fg-quote-wrap--with-logo" : ""}">
          ${
            quoteScreenLogoSrc
              ? `<div class="fg-quote-screen-logo-wrap" aria-hidden="true"><img class="fg-quote-screen-logo" src="${quoteScreenLogoSrc}" alt="" width="200" height="260" decoding="async" /></div>`
              : ""
          }
          <figure id="fg-quote-card" aria-live="polite">
            <blockquote id="fg-quote-text"></blockquote>
            <figcaption id="fg-quote-author"></figcaption>
          </figure>
        </div>
      `
      : premiumPlaceholder
      ? `
        <div id="fg-animation-container" class="${premiumPlaceholder.wrapClass}" aria-hidden="true">
          <div id="${premiumPlaceholder.slotId}"></div>
        </div>
      `
      : `
        <div id="fg-animation-container" aria-hidden="true">
          <div id="fg-orb"></div>
        </div>
      `;

    const headline = isCatTheme
      ? "Cat break time"
      : isSpaceTheme
      ? "Space float"
      : "Time for a break";
    const subtext = isCatTheme
      ? "Stretch with your cat, breathe, and come back focused."
      : isSpaceTheme
      ? "Drift through this pause. When the timer ends, you'll land back on track."
      : "Step away, breathe. Your focus will thank you.";
    const contentTopMarkup = isQuotesTheme || isBreathTheme
      ? ""
      : premiumPlaceholder
      ? `
          <div id="fg-eyebrow">Focus Guard</div>
          <h1 id="fg-headline">${premiumPlaceholder.headline}</h1>
        `
      : `
          <div id="fg-eyebrow">Focus Guard</div>
          <h1 id="fg-headline">${headline}</h1>
          <p id="fg-subtext">${subtext}</p>
        `;
    const quoteControlsMarkup = isQuotesTheme
      ? `
          <div id="fg-quote-controls">
            <button id="fg-quote-prev" type="button" aria-label="Show previous quote">
              <span aria-hidden="true">←</span>
              Previous quote
            </button>
          </div>
        `
      : "";

    const timerInnerMarkup =
      '<div id="fg-timer-label">back in</div><div id="fg-countdown">00:00</div>';
    const timerMarkup = `
          <div id="fg-timer-wrapper" aria-live="polite" aria-label="Time remaining">
            ${timerInnerMarkup}
          </div>
        `;

    overlay.innerHTML = `
      <div id="fg-panel">

        ${animationMarkup}

        <div id="fg-content">
          ${contentTopMarkup}

          ${timerMarkup}

          ${quoteControlsMarkup}

          ${allowSkip ? `
          <button id="fg-skip-btn" type="button" aria-label="Skip this break">
            Skip break
          </button>
          ` : ""}
        </div>

      </div>
      ${
        isSpaceTheme
          ? `<img id="fg-space-astronaut" class="fg-space-float-tab" src="${astronautSrc}" alt="" decoding="async" width="240" height="240" aria-hidden="true" />`
          : ""
      }
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

    if (isQuotesTheme) {
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
    if (!isQuoteBreakTheme(activeBreakScreen) || !overlayEl) return;
    quoteRotationTimer = setInterval(() => {
      showNextQuote();
    }, QUOTE_ROTATION_MS);
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

    const list = quotesForActiveTheme();
    const quote = list[index];
    if (!quote) return;
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
    const list = quotesForActiveTheme();
    if (!list.length) return;
    const normalized = ((index % list.length) + list.length) % list.length;
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
    const list = quotesForActiveTheme();
    if (!list.length) return;
    const nextIndex = currentQuoteIndex < 0 ? Math.floor(Math.random() * list.length) : currentQuoteIndex + 1;
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
    if (!isQuoteBreakTheme(activeBreakScreen)) return;
    const quoteTextEl = document.getElementById("fg-quote-text");
    const quoteAuthorEl = document.getElementById("fg-quote-author");
    if (!quoteTextEl || !quoteAuthorEl || !quotesForActiveTheme().length) return;

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
    setupNightGiphySkipProximity(overlayEl, allowSkip);
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
    if (isQuoteBreakTheme(breakScreen)) {
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

    teardownGiphySkipProximity();

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
