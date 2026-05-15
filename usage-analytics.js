/**
 * Weekly aggregation of per-day social usage (popup + chart).
 * Week = Monday 00:00 → next Monday 00:00 local time.
 */

import { SOCIAL_USAGE_DAILY_KEY } from "./social-usage-daily-tracker.js";

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

/** Start of local calendar day for `YYYY-MM-DD`, or null if invalid. */
export function parseLocalDateKeyMs(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
}

function weekdayLabelFromDateKey(dateKey) {
  const ts = parseLocalDateKeyMs(dateKey);
  if (ts == null) return WEEKDAY_ORDER[0];
  return WEEKDAY_ORDER[(new Date(ts).getDay() + 6) % 7];
}

function sumDomainMs(domains) {
  return Object.values(domains || {}).reduce((acc, ms) => acc + (Number(ms) || 0), 0);
}

/**
 * @param {Record<string, Record<string, number>>} byDate dateKey -> domain -> ms
 * @param {number} weekStart
 * @param {number} weekEndExclusive
 * @returns {Record<string, number>} hours per weekday label
 */
export function aggregateDailySocialToHoursByWeekday(byDate, weekStart, weekEndExclusive) {
  /** @type {Record<string, number>} */
  const hours = Object.fromEntries(WEEKDAY_ORDER.map((d) => [d, 0]));

  for (const [dateKey, domains] of Object.entries(byDate || {})) {
    const dayStart = parseLocalDateKeyMs(dateKey);
    if (dayStart == null || dayStart < weekStart || dayStart >= weekEndExclusive) continue;
    const totalMs = sumDomainMs(domains);
    if (totalMs < 500) continue;
    const label = weekdayLabelFromDateKey(dateKey);
    hours[label] += totalMs / (1000 * 60 * 60);
  }

  for (const k of WEEKDAY_ORDER) {
    hours[k] = Math.round(hours[k] * 100) / 100;
  }
  return hours;
}

/**
 * Build weekly summary from raw `socialUsageDaily` storage value (skips storage I/O when prefetched).
 * @param {unknown} rawSocialUsageDaily
 * @param {number} weekOffset
 */
export function buildWeeklySummaryFromRaw(rawSocialUsageDaily, weekOffset = 0) {
  const { start, end } = getWeekBounds(weekOffset);
  const byDate =
    rawSocialUsageDaily && typeof rawSocialUsageDaily === "object" && !Array.isArray(rawSocialUsageDaily)
      ? /** @type {Record<string, Record<string, number>>} */ (rawSocialUsageDaily)
      : {};
  const byDay = aggregateDailySocialToHoursByWeekday(byDate, start, end);
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

/**
 * @param {number} weekOffset
 * @param {unknown} [prefetchedSocialUsageDaily] if set, skips chrome.storage read (popup batch path).
 * @returns {Promise<{ byDay: Record<string, number>, totalHours: number, hasData: boolean, weekStart: number, weekEnd: number }>}
 */
export async function getWeeklyUsageSummary(weekOffset = 0, prefetchedSocialUsageDaily) {
  if (prefetchedSocialUsageDaily !== undefined) {
    return buildWeeklySummaryFromRaw(prefetchedSocialUsageDaily, weekOffset);
  }
  const data = await chrome.storage.local.get(SOCIAL_USAGE_DAILY_KEY);
  return buildWeeklySummaryFromRaw(data[SOCIAL_USAGE_DAILY_KEY], weekOffset);
}
