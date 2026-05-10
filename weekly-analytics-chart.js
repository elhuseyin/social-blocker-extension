/**
 * Lightweight canvas bar chart for weekly hours on social (no external deps).
 */

import { WEEKDAY_ORDER } from "./usage-analytics.js";

const COLORS = {
  bar: "rgba(167, 139, 250, 0.85)",
  barHover: "rgba(196, 181, 253, 0.98)",
  axis: "rgba(243, 244, 246, 0.2)",
  text: "rgba(243, 244, 246, 0.5)"
};

/** Chart `v` is decimal hours (same as storage aggregation). */
const USAGE_RED_OVER_HOURS = 1;
const USAGE_GREEN_UNDER_HOURS = 10 / 60;

const BAR_TIER = {
  red: {
    bar: "rgba(248, 113, 113, 0.9)",
    hover: "rgba(252, 165, 165, 0.98)"
  },
  green: {
    bar: "rgba(52, 211, 153, 0.88)",
    hover: "rgba(110, 231, 183, 0.98)"
  },
  purple: {
    bar: COLORS.bar,
    hover: COLORS.barHover
  }
};

/** @param {number} decimalHours */
function barTierColors(decimalHours) {
  const v = decimalHours;
  if (v > USAGE_RED_OVER_HOURS) return BAR_TIER.red;
  if (v < USAGE_GREEN_UNDER_HOURS) return BAR_TIER.green;
  return BAR_TIER.purple;
}

/** @param {number} decimalHours */
function totalMinutesFromDecimalHours(decimalHours) {
  return Math.round(Math.max(0, decimalHours) * 60);
}

/**
 * Y-axis tick: compact, same meaning as hover (MM = minutes past the hour when ≥1h).
 * @param {number} decimalHours
 */
function formatYAxisTick(decimalHours) {
  const totalMinutes = totalMinutesFromDecimalHours(decimalHours);
  if (totalMinutes <= 0) return "0";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}.${String(m).padStart(2, "0")}h`;
}

/**
 * Tooltip text from chart values stored as decimal hours.
 * Under 1 hour: "N minutes". At least 1 hour: "H.MM hours" (MM = minutes past the hour).
 * @param {number} decimalHours
 */
function formatHoverDuration(decimalHours) {
  const totalMinutes = totalMinutesFromDecimalHours(decimalHours);
  if (totalMinutes < 60) {
    if (totalMinutes <= 0) return "0 minutes";
    return totalMinutes === 1 ? "1 minute" : `${totalMinutes} minutes`;
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const mm = String(m).padStart(2, "0");
  const unit = h === 1 && m === 0 ? "hour" : "hours";
  return `${h}.${mm} ${unit}`;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Record<string, number>} byDay
 * @param {{ onHoverLabel?: (label: string | null, hours: number | null) => void }} opts
 * @returns {() => void} cleanup
 */
export function renderWeeklyUsageChart(canvas, byDay, opts = {}) {
  const onHoverLabel = typeof opts.onHoverLabel === "function" ? opts.onHoverLabel : () => {};

  const values = WEEKDAY_ORDER.map((k) => Math.max(0, byDay[k] || 0));
  const maxVal = Math.max(0.25, ...values);

  let hoverDay = null;
  /** @type {{ day: string, x: number, y: number, w: number, h: number, hours: number }[]} */
  let barRects = [];

  function draw() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 300;
    const cssH = canvas.clientHeight || 200;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;
    const padL = 40;
    const padR = 8;
    const padT = 12;
    const padB = 26;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const n = values.length;
    const gap = 5;
    const barW = (chartW - gap * (n - 1)) / n;

    function yForHours(hr) {
      return padT + chartH - (hr / maxVal) * chartH;
    }

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text;
    ctx.font = "10px DM Sans, sans-serif";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const hr = (maxVal * i) / ticks;
      const y = padT + chartH - (i / ticks) * chartH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
      ctx.fillText(formatYAxisTick(hr), 2, y + 3);
    }

    barRects = [];
    WEEKDAY_ORDER.forEach((day, i) => {
      const v = values[i];
      const x = padL + i * (barW + gap);
      const bh = (v / maxVal) * chartH;
      const y = padT + chartH - bh;
      barRects.push({ day, x, y, w: barW, h: bh, hours: v });
      const isH = hoverDay === day;
      const tier = barTierColors(v);
      ctx.fillStyle = isH ? tier.hover : tier.bar;
      const r = 4;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, barW, bh, r);
      } else {
        ctx.rect(x, y, barW, bh);
      }
      ctx.fill();
    });

    ctx.fillStyle = COLORS.text;
    ctx.font = "500 10px DM Mono, monospace";
    WEEKDAY_ORDER.forEach((day, i) => {
      const x = padL + i * (barW + gap) + barW / 2;
      ctx.fillText(day.slice(0, 3), x - 11, padT + chartH + 16);
    });
  }

  draw();

  function hit(mx, my) {
    for (const r of barRects) {
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return r;
    }
    return null;
  }

  function onMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const h = hit(mx, my);
    const next = h ? h.day : null;
    if (next !== hoverDay) {
      hoverDay = next;
      draw();
      if (h) onHoverLabel(`${h.day}: ${formatHoverDuration(h.hours)}`, h.hours);
      else onHoverLabel(null, null);
    }
  }

  function onLeave() {
    hoverDay = null;
    draw();
    onHoverLabel(null, null);
  }

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(canvas);

  return () => {
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("mouseleave", onLeave);
    if (ro) ro.disconnect();
  };
}
