/**
 * Extension-origin player for My cat break (bypasses host-page media CSP).
 * Uses H.264 MP4 only (no .mov).
 *
 * Encode from an older .mov (once): ffmpeg -y -i assets/cat_lolo.mov -c:v libx264 -profile:v main
 *   -pix_fmt yuv420p -movflags +faststart -an assets/cat_lolo.mp4
 */
(function () {
  "use strict";

  const LOG = "[FocusGuard mycat-player]";
  const VIDEO_FILE = "assets/cat_lolo.mp4";
  const FALLBACK_IMAGE = "assets/dump-cat-logo.png";

  const video = document.getElementById("fg-mycat-embed-video");
  const fallbackImg = document.getElementById("fg-mycat-fallback-img");
  const failEl = document.getElementById("fg-mycat-fail");
  if (!video) {
    console.warn(LOG, "video element missing");
    return;
  }

  if (fallbackImg) {
    fallbackImg.src = chrome.runtime.getURL(FALLBACK_IMAGE);
    fallbackImg.alt = "Cat break";
  }

  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;

  let stallTimer = null;

  function clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function logMediaError(prefix) {
    const err = video.error;
    if (!err) {
      console.log(LOG, prefix, "video.error is null");
      return;
    }
    const codes = {
      1: "MEDIA_ERR_ABORTED",
      2: "MEDIA_ERR_NETWORK",
      3: "MEDIA_ERR_DECODE",
      4: "MEDIA_ERR_SRC_NOT_SUPPORTED"
    };
    console.error(
      LOG,
      prefix,
      codes[err.code] || "UNKNOWN",
      "code=",
      err.code,
      "message=",
      err.message || ""
    );
  }

  function logState(label) {
    console.log(
      LOG,
      label,
      "readyState=",
      video.readyState,
      "networkState=",
      video.networkState,
      "currentSrc=",
      video.currentSrc || "(none)",
      "size=",
      video.videoWidth + "x" + video.videoHeight
    );
  }

  function revealVideoLayer() {
    const hasDims = video.videoWidth > 0;
    const hasData = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!hasDims && !hasData) return;
    clearStallTimer();
    document.body.classList.remove("fg-mycat-loading");
    document.body.classList.add("fg-mycat-has-video");
  }

  /** First painted frame — most reliable when loadeddata/canplay fire late (extension iframe). */
  function scheduleFirstFrameReveal() {
    if (typeof video.requestVideoFrameCallback !== "function") return;
    video.requestVideoFrameCallback(() => {
      revealVideoLayer();
    });
  }

  function showFallbackMode(message) {
    clearStallTimer();
    document.body.classList.remove("fg-mycat-loading");
    document.body.classList.remove("fg-mycat-has-video");
    document.body.classList.add("fg-mycat-fallback-only");
    if (failEl && message) failEl.textContent = message;
    logState("fallback-mode");
  }

  function onVisibility() {
    if (!video.isConnected) return;
    if (document.hidden) {
      video.pause();
      logState("pause-tab-hidden");
    } else {
      void video.play().catch((e) => console.warn(LOG, "play on visible", e && e.message));
    }
  }

  document.body.classList.add("fg-mycat-loading");

  video.addEventListener("loadstart", () => {
    console.log(LOG, "loadstart");
    logState("after loadstart");
  });

  video.addEventListener("loadedmetadata", () => {
    console.log(LOG, "loadedmetadata");
    logState("after loadedmetadata");
    revealVideoLayer();
  });

  video.addEventListener("loadeddata", () => {
    console.log(LOG, "loadeddata");
    logState("after loadeddata");
    revealVideoLayer();
  });

  video.addEventListener("canplay", () => {
    console.log(LOG, "canplay");
    logState("after canplay");
    revealVideoLayer();
  });

  video.addEventListener("playing", () => {
    console.log(LOG, "playing");
    logState("after playing");
    revealVideoLayer();
  });

  video.addEventListener("error", () => {
    console.log(LOG, "error event");
    logState("after error");
    logMediaError("error");
    showFallbackMode(
      "Video could not play. Use H.264 + yuv420p in assets/cat_lolo.mp4, reload the extension, or run the ffmpeg command in mycat-player.js."
    );
  });

  document.addEventListener("visibilitychange", onVisibility);

  /** If playback advances, we definitely have decodable media — catches edge cases without rVFC. */
  function onTimeUpdateOnce() {
    if (video.currentTime > 0) {
      revealVideoLayer();
      video.removeEventListener("timeupdate", onTimeUpdateOnce);
    }
  }
  video.addEventListener("timeupdate", onTimeUpdateOnce);

  stallTimer = setTimeout(() => {
    if (document.body.classList.contains("fg-mycat-fallback-only")) return;
    if (document.body.classList.contains("fg-mycat-has-video")) return;
    if (video.videoWidth > 0) return;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    console.warn(LOG, "stall timeout — still no decoded frames");
    logState("stall-timeout");
    showFallbackMode(
      "Video did not become playable in time. Try a shorter/smaller H.264 MP4, or confirm assets/cat_lolo.mp4 exists and reload the extension."
    );
  }, 45000);

  const url = chrome.runtime.getURL(VIDEO_FILE);
  console.log(LOG, "loading", VIDEO_FILE, url);

  video.src = url;
  video.load();
  scheduleFirstFrameReveal();
  void video.play().catch((e) => {
    console.warn(LOG, "initial play() rejected:", e && e.message ? e.message : e);
    logMediaError("play() catch");
    showFallbackMode(
      "Autoplay was blocked or the MP4 is missing. Add assets/cat_lolo.mp4 (H.264), then reload the extension."
    );
  });

  window.addEventListener(
    "pagehide",
    () => {
      clearStallTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      video.removeEventListener("timeupdate", onTimeUpdateOnce);
      video.pause();
    },
    { once: true }
  );
})();
