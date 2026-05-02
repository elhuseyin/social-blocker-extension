/**
 * Lightweight canvas bar chart for weekly hours (no external deps).
 */

import { WEEKDAY_ORDER } from "./break-analytics.js";

const COLORS = {
  bar: "rgba(167, 139, 250, 0.85)",
  barHover: "rgba(196, 181, 253, 0.98)",
  axis: "rgba(243, 244, 246, 0.2)",
  text: "rgba(243, 244, 246, 0.5)"
};

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Record<string, number>} byDay
 * @param {{ onHoverLabel?: (label: string | null, hours: number | null) => void }} opts
 * @returns {() => void} cleanup
 */
export function renderWeeklyBreakChart(canvas, byDay, opts = {}) {
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
    const padL = 34;
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
      ctx.fillText(`${hr.toFixed(1)}h`, 2, y + 3);
    }

    barRects = [];
    WEEKDAY_ORDER.forEach((day, i) => {
      const v = values[i];
      const x = padL + i * (barW + gap);
      const bh = (v / maxVal) * chartH;
      const y = padT + chartH - bh;
      barRects.push({ day, x, y, w: barW, h: bh, hours: v });
      const isH = hoverDay === day;
      ctx.fillStyle = isH ? COLORS.barHover : COLORS.bar;
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
      if (h) onHoverLabel(`${h.day}: ${h.hours.toFixed(2)} hours`, h.hours);
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
