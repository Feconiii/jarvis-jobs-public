/**
 * SHARED ATS HOSTS THAT SAID NO, REMEMBERED ACROSS RUNS (F-634).
 *
 * Discovery used to end a refused run with "Re-run later", and the advice
 * could not work: every run fired its slug guesses at the same shared host in
 * a burst, tripped the same limit within the first few dozen companies, and
 * lost the same companies the same way.
 *
 * Two things live here, both in one small JSON file under data/jarvis/:
 *
 *  - HOLDS. Workable's 429 is a Cloudflare IP block with `Retry-After` near
 *    70,000 s (measured 2026-10-01), and a request inside it restarts it. It
 *    also locks the owner out of applying to Workable-hosted jobs from the same
 *    network. So a 429 like that is written down with its deadline, and no run
 *    sends to that host again until the deadline has passed.
 *
 *  - PENDING. The names that lost a probe to a refused service and could not
 *    be re-asked this run (the host is held, or the slow lane's budget ran
 *    out). The next run re-asks them, one request at a time.
 *
 * The slow lane itself is `runSlowLane`: one service at a time per host, one
 * request per PACE_MS, a 60 s back-off on a 403/429 (three at most), and a
 * hard stop on a held host. Measured in the 2026-10-01 scratch slowprobe:
 * 2.5 s Workable, 0.7 s Recruitee, 1.5 s iCIMS drew zero refusals over 12 names.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';

/** Seconds between requests to one host in the slow lane. */
export const PACE_MS = { 'workable.com': 2500, 'recruitee.com': 700, 'icims.com': 1500 };
export const DEFAULT_PACE_MS = 1500;

/**
 * Hosts whose SPECULATIVE guesses never go out in the fast pass at all — only
 * through the slow lane, and only for a name nothing else resolved. Workable is
 * here because its refusal is not a per-minute limit but a 20-hour IP block.
 */
export const SLOW_ONLY = new Set(['workable.com']);

/** A 429 whose Retry-After is at least this long is a block, not a limit. */
export const HOLD_MIN_SECONDS = 600;
/** Workable's 429 with no Retry-After: assume the measured block length. */
export const DEFAULT_HOLD_SECONDS = { 'workable.com': 72_000 };

/**
 * Requests per host per run in the slow lane. Workable's is small on purpose:
 * 2.5 s apart drew no refusal over a dozen names, but nobody has measured
 * where the 20-hour block starts, and that block also stops Alex applying to
 * Workable jobs. 150 is about six minutes a run. JARVIS_SLOW_LANE_BUDGET overrides.
 */
export const SLOW_LANE_BUDGET = { 'workable.com': 150, default: 600 };

export const PENDING_MAX = 3000;
export const PENDING_MAX_DAYS = 30;

/**
 * A Retry-After header in seconds. It may be delta-seconds or an HTTP date.
 * @returns {number|null}
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.round((t - now) / 1000));
  return null;
}

/**
 * Should this refusal hold the host across runs, and until when?
 * A Workable 429 always does. Any other 429 does only when its own
 * Retry-After says it is a long block.
 * @returns {string|null} ISO deadline, or null for an ordinary refusal
 */
export function holdDeadline(service, status, retryAfter, now = Date.now()) {
  if (status !== 429) return null;
  const secs = parseRetryAfter(retryAfter, now);
  if (SLOW_ONLY.has(service)) {
    const s = secs ?? DEFAULT_HOLD_SECONDS[service] ?? 72_000;
    return new Date(now + s * 1000).toISOString();
  }
  if (secs != null && secs >= HOLD_MIN_SECONDS) return new Date(now + secs * 1000).toISOString();
  return null;
}

export function emptyState() { return { holds: {}, pending: [] }; }

export function loadState(file) {
  if (!file || !existsSync(file)) return emptyState();
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { holds: j && typeof j.holds === 'object' && j.holds ? j.holds : {}, pending: Array.isArray(j?.pending) ? j.pending : [] };
  } catch { return emptyState(); }
}

export function saveState(file, state) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, file);
}

/** The deadline a host is held until, or '' when it is free to ask. */
export function heldUntil(state, service, now = Date.now()) {
  const h = state?.holds?.[service];
  if (!h?.until) return '';
  return Date.parse(h.until) > now ? h.until : '';
}

/** Hold a host; a later deadline never shortens to an earlier one. */
export function hold(state, service, until, { status = 429, at = new Date().toISOString() } = {}) {
  const prev = state.holds[service];
  if (prev?.until && Date.parse(prev.until) >= Date.parse(until)) return prev;
  state.holds[service] = { until, status, at };
  return state.holds[service];
}

const itemKey = (i) => `${String(i.name).toLowerCase()}|${i.provider}|${i.cand?.slug}`;

/**
 * Add names to the pending list: one entry per name/provider/slug, oldest kept
 * first, anything past PENDING_MAX_DAYS or PENDING_MAX dropped (the ledger still
 * brings those names back — it retries a refused run's misses in three days).
 */
export function addPending(state, items, now = Date.now()) {
  const seen = new Set(state.pending.map(itemKey));
  for (const i of items) {
    const k = itemKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    state.pending.push({ ...i, added: i.added || new Date(now).toISOString() });
  }
  return prunePending(state, now);
}

export function prunePending(state, now = Date.now()) {
  const cutoff = now - PENDING_MAX_DAYS * 86_400_000;
  const before = state.pending.length;
  state.pending = state.pending.filter((i) => !i.added || Date.parse(i.added) >= cutoff);
  // A LINKED PROBE IS NEVER CUT FOR A GUESS (2026-11-03). 2,989 of 3,000 held
  // probes were blind Workable slug guesses every name gets; a board the
  // company's own careers page linked to, added after them, was the one cut.
  // Linked ones first, then guesses, each oldest first; the cap trims guesses.
  if (state.pending.length > PENDING_MAX) {
    state.pending = [...state.pending.filter((i) => !i.speculative), ...state.pending.filter((i) => i.speculative)].slice(0, PENDING_MAX);
  }
  return before - state.pending.length;
}

/** Take pending entries out once a run has asked them (found or cleanly missed). */
export function removePending(state, items) {
  const done = new Set(items.map(itemKey));
  state.pending = state.pending.filter((i) => !done.has(itemKey(i)));
}

/**
 * The slow lane: re-ask each lost probe of one host, one at a time.
 *
 * @param {object[]} items  {name, provider, service, cand:{slug,strong}, speculative}
 * @param {object} deps
 *   probe(item)  → {hit, refused: '' | service, held: bool, status}  (one probe = one slug on one ATS)
 *   isHeld(service) → bool   (consulted before every request)
 *   sleep(ms)
 *   budget       → max probes per service this run: a number, or {service: n, default: n}
 *   backoffMs, maxBackoffs
 * @returns {{found: {item, hit}[], clean: object[], deferred: object[], sent: Record<string, number>}}
 */
export async function runSlowLane(items, {
  probe, isHeld = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  budget = SLOW_LANE_BUDGET, backoffMs = 60_000, maxBackoffs = 3, pace = PACE_MS, log = () => {},
} = {}) {
  const byService = new Map();
  // Linked probes are asked before blind guesses on each host: a budget of 150
  // Workable requests a run went to guesses while linked boards waited.
  for (const i of [...items.filter((x) => !x.speculative), ...items.filter((x) => x.speculative)]) {
    if (!byService.has(i.service)) byService.set(i.service, []);
    byService.get(i.service).push(i);
  }
  const found = [], clean = [], deferred = [];
  const sent = {};
  // Hosts are independent; within one host, strictly one request at a time.
  await Promise.all([...byService.entries()].map(async ([service, list]) => {
    const gap = pace[service] ?? DEFAULT_PACE_MS;
    let backoffs = 0;
    let first = true;
    const resolvedNames = new Set();
    for (let n = 0; n < list.length; n++) {
      const item = list[n];
      // A name this lane already resolved on another slug needs no more asking.
      if (resolvedNames.has(String(item.name).toLowerCase())) { clean.push(item); continue; }
      if (isHeld(service) || (sent[service] || 0) >= (typeof budget === "number" ? budget : (budget[service] ?? budget.default ?? 600))) { deferred.push(...list.slice(n)); break; }
      if (!first) await sleep(gap);
      first = false;
      sent[service] = (sent[service] || 0) + 1;
      const r = await probe(item);
      if (r?.refused) {
        // A held host stops here: no retry, no back-off, nothing more sent.
        if (r.held || isHeld(service)) { log(`  ⚠  ${service} is blocking us — slow lane stopped, ${list.length - n} name(s) held for a later run`); deferred.push(...list.slice(n)); break; }
        if (backoffs >= maxBackoffs) { log(`  ⚠  ${service} kept refusing (${backoffs} back-offs) — ${list.length - n} name(s) held for a later run`); deferred.push(...list.slice(n)); break; }
        backoffs++;
        log(`  · ${service} refused (HTTP ${r.status || '?'}) — waiting ${Math.round(backoffMs / 1000)} s`);
        await sleep(backoffMs);
        n--;          // the same probe, once more
        continue;
      }
      if (r?.hit?.entry) { found.push({ item, hit: r.hit }); resolvedNames.add(String(item.name).toLowerCase()); }
      else clean.push(item);
    }
  }));
  return { found, clean, deferred, sent };
}
