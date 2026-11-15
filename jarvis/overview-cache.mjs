/**
 * THE HOME TILES, KEPT ACROSS A RESTART (F-1027, 2026-11-06).
 *
 * The tiles' heavy aggregate (overview-worker.mjs heavyAggregates) is full
 * passes over the store: 104-119 s in its worker on 2026-11-06. It lived only
 * in memory, so the first /api/overview after every restart waited for a
 * whole recount (85 s, and a 90 s timeout at 17:55). Now the last answer is
 * kept on disk and served at once, with the time it was counted (`asOf`), while
 * the worker counts again behind it. The header's totals had the same fix in
 * F-1022 (header-counts.json).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** The kept file's layout. A file from another build is not read (review, 2026-11-06). */
export const KEPT_VERSION = 1;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait: try at once */ } };

/**
 * Write JSON so a crash mid-write never leaves half a file: a temp file, then a
 * rename over the old one. Windows refuses the rename for a moment while
 * something else holds the old file (EPERM/EBUSY): retried 3 times, 50 ms apart.
 */
export function writeKept(file, value, { tries = 4, waitMs = 50, rename = renameSync } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    for (let i = 1; ; i += 1) {
      try { rename(tmp, file); break; } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= tries) throw e;
        sleepSync(waitMs);
      }
    }
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** The kept value, or null when there is none, it does not parse, or it is not the right shape. */
export function readKept(file, valid = () => true) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return valid(v) ? v : null;
  } catch { return null; }
}

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
/**
 * Every field assembleOverview and overviewTail read, with its type (review):
 * a file from an older build missing one must not 500 /api/overview.
 */
export function looksKept(v) {
  if (!isObj(v) || v.v !== KEPT_VERSION || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))) return false;
  const h = v.heavy;
  return isObj(h) && isObj(h.stat) && Object.values(h.stat).every((n) => typeof n === 'number')
    && isObj(h.blockReasons) && isObj(h.bySource) && isObj(h.byCompanyCounts) && isObj(h.byAdapter)
    && Array.isArray(h.watchlistCompanies) && Array.isArray(h.applyRuns) && isObj(h.storage);
}

/**
 * WHEN THE FIRST RECOUNT AFTER A BOOT RUNS (F-1030). A recount is ~85-110 s of
 * reading the whole store; started 20 s after boot it met the first minutes of
 * his use, and the server's own thread stalled 17-23 s behind the disk
 * (2026-11-07 07:15). With the tiles kept on disk (F-1027), a kept answer under
 * an hour old is shown as it is and the 10-minute timer recounts it; an older
 * one, or none, is recounted 5 minutes after boot. Returns the wait in ms from
 * boot, or null for "no boot recount".
 */
export function bootRecountDelay({ asOf = null, now = Date.now(), freshMs = 3600_000, laterMs = 300_000 } = {}) {
  const at = asOf ? Date.parse(asOf) : NaN;
  if (Number.isFinite(at) && now - at >= 0 && now - at < freshMs) return null;
  return laterMs;
}

/**
 * THE HEADER'S TOTALS: IS A WORKER COUNT TOO OLD TO SHOW? (code review #7)
 * `startedAt` is this server's write count when the count began, `nowWrites`
 * the count now. A write of ours since then (his click) means the count does
 * not include it: it is not shown, and the next request counts again (at most
 * `max` times in a row, so a busy store still gets totals). This held only
 * while the kept totals named a write count: after a click whose rows could
 * not be read (`ours` null), or a restart, an older count erased the click.
 */
export function countOvertaken({ have = false, startedAt, nowWrites, overtaken = 0, max = 3 } = {}) {
  return !!have && nowWrites !== startedAt && overtaken < max;
}

/**
 * @param {object} o
 * @param {string} [o.file]   where the last answer is kept (none: memory only)
 * @param {() => Promise<object>} o.recount   the worker's heavy aggregate
 * @returns {{ get: () => Promise<{heavy: object, asOf: string}>, refresh: () => Promise<object>, asOf: () => string|null }}
 */
export function makeOverviewCache({ file = null, recount, now = Date.now, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, soonMs = 30_000 } = {}) {
  const kept = file ? readKept(file, looksKept) : null;
  let heavy = kept ? kept.heavy : null;
  let at = kept ? Date.parse(kept.at) : 0;
  let pending = null;
  let soonTimer = null;
  // Which of his writes a recount can include (code review #6): `writes`
  // counts soon() calls, `pendingSeq` is the count when the running recount began.
  let writes = 0, pendingSeq = -1;
  /** One recount at a time; every caller of a running one gets its answer. */
  function refresh() {
    if (pending) return pending;
    pendingSeq = writes;
    pending = Promise.resolve().then(() => recount()).then((h) => {
      heavy = h; at = now();
      if (file) { try { writeKept(file, { v: KEPT_VERSION, at: new Date(at).toISOString(), heavy: h }); } catch (e) { log(`could not keep the home tiles: ${e.message}`); } }
      return h;
    }).finally(() => { pending = null; });
    return pending;
  }
  /**
   * HIS OWN CLICKS SHOW SOON (review): applying or skipping changes the tiles
   * that count new and hearted postings. One recount, 30 s after the last of a
   * burst of his writes, instead of up to the 10-minute timer.
   */
  // A RECOUNT THAT BEGAN BEFORE HIS WRITE DOES NOT ANSWER IT (code review #6):
  // the timer joined whatever recount was running, and one the 10-minute timer
  // began just before his click counted the store without it; the click showed
  // ten minutes later. It waits for that one, then counts again.
  function refreshAfter(need) {
    const p = refresh();
    return pendingSeq >= need ? p : p.catch(() => {}).then(() => refreshAfter(need));
  }
  function soon() {
    writes += 1;
    const need = writes;
    if (soonTimer) clearTimer(soonTimer);
    soonTimer = setTimer(() => { soonTimer = null; refreshAfter(need).catch((e) => log(`could not recount the home tiles: ${e.message}`)); }, soonMs);
    soonTimer?.unref?.();
  }
  /** The last answer at once; only a store never counted waits for the first. */
  async function get() {
    if (!heavy) await refresh();
    return { heavy, asOf: new Date(at).toISOString() };
  }
  /** Forget an answer that could not be used, so the next get counts again. */
  function drop() { heavy = null; at = 0; }
  return { get, refresh, soon, drop, asOf: () => (heavy ? new Date(at).toISOString() : null) };
}
