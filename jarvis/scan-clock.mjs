/**
 * WHEN THE NEXT SCAN IS DUE (F-1033, 2026-11-07).
 *
 * serve.mjs looked once, two minutes after boot, and otherwise ran a scan every
 * six hours counted from the boot. A restart 5 h 54 m after the last scan
 * (11:02Z, last scan 05:10Z) therefore moved the next one to 17:02Z, and every
 * restart inside the window did the same. The clock is the last scan's own
 * record: due once `everyMs` has passed since it, checked every few minutes.
 * Returns the ms still to wait (0 or less: due now). No record: due now.
 */
//
// A SCAN THAT DIED GETS A RETRY CAP (code review #3, 2026-11-13). scan.mjs
// writes its record last, so a run that dies leaves none and the old record
// stays due: every ten-minute look started another. `tries` are the times
// this server started a scan since then. With one or two that left no record,
// the next waits `retryMs` after the latest; after `maxTries`, a whole
// `everyMs`.
export function nextScanDelay({ lastAt = null, now = Date.now(), everyMs = 6 * 3600_000, tries = [], maxTries = 3, retryMs = 30 * 60_000 } = {}) {
  const at = lastAt ? Date.parse(lastAt) : NaN;
  const due = Number.isFinite(at) ? at + everyMs - now : 0;
  const died = tries.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && !(t <= at)).sort((a, b) => a - b);
  if (!died.length) return due;
  return Math.max(due, died.at(-1) + (died.length >= maxTries ? everyMs : retryMs) - now);
}

/**
 * ONLY A FULL SCAN SETS THE CLOCK (code review #3). An assisted import of one
 * careers page and `scan.mjs --company <name>` write scan records too; read as
 * the last scan, each put the next full sweep off six hours. scan.mjs now says
 * `full`; a record from before that is full unless every company in it came
 * from a browser-assist import.
 */
export function isFullScan(s) {
  if (!s) return false;
  if (typeof s.full === 'boolean') return s.full;
  const per = Array.isArray(s.perCompany) ? s.perCompany : [];
  return !(per.length && per.every((p) => p?.provider === 'browser-assist'));
}

/** The newest full scan's time, from records newest first (getScans). */
export function lastFullScanAt(scans = []) {
  return (scans || []).find(isFullScan)?.at ?? null;
}
