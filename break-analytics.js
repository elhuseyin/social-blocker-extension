/**
 * Weekly aggregation of break-session logs (popup + tests).
 * Week = Monday 00:00 → Sunday 23:59:59 local time.
 */

import { BREAK_SESSION_LOG_KEY } from "./break-session-tracker.js";

export const WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Monday 00:00 local for the ISO week containing `ts`. */
export function startOfIsoWeekMonday(ts = Date.now()) {
  const d = new Date(ts);
  const day = d.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + delta);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** @param {number} weekOffset 0 = this week, 1 = last week */
export function getWeekBounds(weekOffset = 0) {
  const thisMonday = startOfIsoWeekMonday();
  const start = thisMonday - weekOffset * 7 * 24 * 60 * 60 * 1000;
  const end = start + 7 * 24 * 60 * 60 * 1000;
  return { start, end };
}

function weekdayLabelFromTimestamp(ts) {
  const d = new Date(ts);
  return WEEKDAY_ORDER[((d.getDay() + 6) % 7)];
}

/**
 * @param {Array<{ startAt: number, endAt: number, durationMs?: number }>} sessions
 * @param {number} weekStart
 * @param {number} weekEndExclusive
 * @returns {Record<string, number>} hours per weekday label
 */
export function aggregateSessionsToHoursByWeekday(sessions, weekStart, weekEndExclusive) {
  /** @type {Record<string, number>} */
  const hours = Object.fromEntries(WEEKDAY_ORDER.map((d) => [d, 0]));

  for (const s of sessions) {
    if (!s || typeof s.startAt !== "number") continue;
    if (s.startAt < weekStart || s.startAt >= weekEndExclusive) continue;
    const dur = typeof s.durationMs === "number" ? s.durationMs : Math.max(0, s.endAt - s.startAt);
    if (dur < 500) continue;
    const label = weekdayLabelFromTimestamp(s.startAt);
    hours[label] += dur / (1000 * 60 * 60);
  }

  for (const k of WEEKDAY_ORDER) {
    hours[k] = Math.round(hours[k] * 100) / 100;
  }
  return hours;
}

/**
 * @param {number} weekOffset
 * @returns {Promise<{ byDay: Record<string, number>, totalHours: number, hasData: boolean, weekStart: number, weekEnd: number }>}
 */
export async function getWeeklyBreakSummary(weekOffset = 0) {
  const { start, end } = getWeekBounds(weekOffset);
  const data = await chrome.storage.local.get(BREAK_SESSION_LOG_KEY);
  const sessions = Array.isArray(data[BREAK_SESSION_LOG_KEY]) ? data[BREAK_SESSION_LOG_KEY] : [];
  const byDay = aggregateSessionsToHoursByWeekday(sessions, start, end);
  const totalHours = WEEKDAY_ORDER.reduce((acc, d) => acc + (byDay[d] || 0), 0);
  const hasData = totalHours > 0.001;

  return {
    byDay,
    totalHours: Math.round(totalHours * 100) / 100,
    hasData,
    weekStart: start,
    weekEnd: end
  };
}
