# Focus Guard — Chrome Extension

A Manifest V3 Chrome extension that helps you take mindful breaks from social media.

## Features

- **Time tracking** per social media domain (Instagram, Facebook, Twitter/X)
- **Break intervals**: 30 min / 1 hr / 2 hr
- **Break durations**: 5 / 10 / 15 / 30 / 60 min
- **Full-screen overlay** with live countdown, page freeze, skip button
- **Custom domains** you can add yourself
- **Animation placeholder** (`#fg-animation-container`) ready for Lottie/pets
- All data stored locally via `chrome.storage.local`

## File Structure

```
social-blocker-extension/
├── manifest.json       — MV3 manifest
├── background.js       — Service worker: tab tracking, timers, break logic
├── content.js          — Injected into pages: overlay, freeze, countdown
├── overlay.css         — Styles for the in-page overlay
├── popup.html          — Extension popup HTML
├── popup.js            — Popup controller
├── styles.css          — Popup styles
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

## Installation (Developer Mode)

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `social-blocker-extension/` folder
5. The extension icon will appear in your toolbar

## Adding Custom Sites

In the popup → "Blocked sites" section → type a domain (e.g. `reddit.com`) → click **+** → **Save settings**.

## Architecture Notes

| Component | Responsibility |
|-----------|---------------|
| `background.js` | Alarm-based tick every 5s, tracks active tab, manages break state |
| `content.js` | Receives messages, injects overlay DOM, freezes events |
| `overlay.css` | Injected via manifest `content_scripts.css` |
| `popup.js` | UI bindings, reads/writes storage, polls status every 2s |

## Extending with Animations

Replace the breathing orb in `overlay.css` (`#fg-orb`) with any animation:

```js
// Inside content.js injectOverlay(), after overlay is appended:
const container = overlay.querySelector('#fg-animation-container');
// Load Lottie, a pet sprite, CSS animation, etc.
```

## Debugging

Open DevTools on any social media page → Console → filter by `[FocusGuard CS]`.  
Open `chrome://extensions/` → service worker "Inspect" → filter by `[FocusGuard BG]`.
