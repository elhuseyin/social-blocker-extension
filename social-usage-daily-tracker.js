/**
 * Persists time on tracked (blocked) social domains per calendar day (local time).
 * Used by the service worker when accumulating active-tab usage outside breaks.
 */

export const SOCIAL_USAGE_DAILY_KEY = "socialUsageDaily";

/** Drop entries older than this many local calendar days to bound storage. */
const MAX_RETENTION_DAYS = 120;

/** Monday 00:00 local for the ISO week containing `ts` (matches usage-analytics). */
function startOfIsoWeekMonday(ts = Date.now()) {
  const d = new Date(ts);
  const day = d.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + delta);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Earliest calendar day (YYYY-MM-DD) that must be kept for “This week” + “Last week” charts. */
function twoWeekChartFloorKey(nowTs = Date.now()) {
  const thisMonday = startOfIsoWeekMonday(nowTs);
  const lastWeekMondayMs = thisMonday - 7 * 24 * 60 * 60 * 1000;
  return localDateKey(lastWeekMondayMs);
}

export function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfNextLocalDay(ts) {
  const d = new Date(ts);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight (00:00) for the calendar day containing `ts` (epoch ms). */
export function startOfLocalDayMs(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pruneOldDates(/** @type {Record<string, Record<string, number>>} */ byDate, nowTs) {
  const cutoff = new Date(nowTs);
  cutoff.setDate(cutoff.getDate() - MAX_RETENTION_DAYS);
  const cutoffKey = localDateKey(cutoff.getTime());
  const chartFloorKey = twoWeekChartFloorKey(nowTs);
  // Never delete days on/after last ISO week's Monday (covers “This week” + “Last week” in the popup).
  // Among older keys, only remove those before the 120-day cap (lexical YYYY-MM-DD order matches time).
  const deleteBeforeKey = chartFloorKey < cutoffKey ? chartFloorKey : cutoffKey;
  for (const k of Object.keys(byDate)) {
    if (k < deleteBeforeKey) delete byDate[k];
  }
}

/**
 * Add milliseconds for `domain` across [startTs, endTs), splitting at local midnights.
 * @param {string} domain
 * @param {number} startTs
 * @param {number} endTs
 */
export async function addSocialUsageMsForSpan(domain, startTs, endTs) {
  if (!domain || typeof startTs !== "number" || typeof endTs !== "number") return;
  if (endTs <= startTs) return;

  /** @type {{ dateKey: string, ms: number }[]} */
  const chunks = [];
  let t = startTs;
  while (t < endTs) {
    const nextMidnight = startOfNextLocalDay(t);
    const chunkEnd = Math.min(endTs, nextMidnight);
    const ms = chunkEnd - t;
    if (ms >= 1) chunks.push({ dateKey: localDateKey(t), ms });
    t = chunkEnd;
  }
  if (!chunks.length) return;

  const data = await chrome.storage.local.get(SOCIAL_USAGE_DAILY_KEY);
  const raw = data[SOCIAL_USAGE_DAILY_KEY];
  /** @type {Record<string, Record<string, number>>} */
  const byDate =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};

  for (const { dateKey, ms } of chunks) {
    const prev = byDate[dateKey] || {};
    byDate[dateKey] = { ...prev, [domain]: (prev[domain] || 0) + ms };
  }

  pruneOldDates(byDate, endTs);
  await chrome.storage.local.set({ [SOCIAL_USAGE_DAILY_KEY]: byDate });
}
