/**
 * Persists completed break-overlay sessions for weekly analytics.
 * Used by the service worker only.
 */

export const BREAK_SESSION_LOG_KEY = "breakSessionLog";

/** Cap log size to keep storage and aggregation light. */
const MAX_SESSIONS = 2500;

/**
 * @param {{ startAt: number, endAt: number, skipped?: boolean }} session
 */
export async function recordBreakSession(session) {
  const { startAt, endAt, skipped } = session;
  if (typeof startAt !== "number" || typeof endAt !== "number") return;
  const durationMs = endAt - startAt;
  if (durationMs < 500) return;

  const data = await chrome.storage.local.get(BREAK_SESSION_LOG_KEY);
  const log = Array.isArray(data[BREAK_SESSION_LOG_KEY]) ? data[BREAK_SESSION_LOG_KEY] : [];
  const entry = {
    startAt,
    endAt,
    durationMs,
    durationMinutes: Math.round((durationMs / 60000) * 1000) / 1000,
    skipped: Boolean(skipped)
  };
  const next = [...log, entry].slice(-MAX_SESSIONS);
  await chrome.storage.local.set({ [BREAK_SESSION_LOG_KEY]: next });
}
