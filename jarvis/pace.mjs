// jarvis/pace.mjs — how many requests one service gets in a day.
//
// WHY THIS EXISTS (F-437). The per-service cap in `net-pool.mjs` bounds how
// many requests are in flight at once. It says nothing about how many are sent
// over an afternoon, and that is the limit these hosts actually enforce:
//
//   · Micron served 246 postings happily and then began answering 403 — a
//     single 400-row burst was enough.
//   · Every `*.icims.com` host started answering 405 to everything, sitemap
//     included, hours after serving 200s (F-432).
//   · Workday answered 122 × 429 across one 5,582-row pass (F-426).
//
// None of that is concurrency. It is volume per day, per service, and the
// concurrency cap cannot express it because it forgets everything the moment a
// request finishes.
//
// So this remembers. A small JSON file keyed by date and service, incremented
// as requests go out, reset by the calendar. When a service is spent, its rows
// are SKIPPED — not failed, not struck (F-429), not marked gone (F-427) —
// because "we chose not to ask today" is not a fact about the posting.
//
// The budget is deliberately generous for boards that have never complained
// and tight for the ones that have. It is a starting point measured from what
// actually happened today, not a guess about what these hosts allow.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

/**
 * Requests per service per day.
 *
 * The named entries are the services that actually pushed back, and the number
 * is set below where they broke rather than at it. Everything else gets
 * `default`, which is high enough that a normal run never notices.
 */
export const DAILY_BUDGET = {
  'myworkdayjobs.com': 1500,
  'icims.com': 300,
  'micron.com': 200,
  'lamresearch.com': 200,
  'eightfold.ai': 300,
  'appliedmaterials.com': 200,
  'recruitee.com': 400,
  // Workable throttles an IP after a few hundred requests (F-445); its posting
  // JSON became a detail source on 2026-10-08.
  'workable.com': 300,
  // Apple's own posting API (2026-11-03): one employer's site, read at 400 a day
  // (its ~1,375 open rows over about four days), not under the 5,000 default.
  'apple.com': 400,
  // Jobvite (2026-11-04): every employer behind one host, jobs.jobvite.com.
  // Its platform ceiling when settings.json has none (paceJobviteCeiling).
  'jobvite.com': 1000,
  default: 5000,
};

/** Where the running tally lives. One file, rewritten in place. */
export function pacePath(storeDir) {
  return path.join(storeDir, 'enrich-pace.json');
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Read today's tally. Any older day is dropped on load rather than accumulated
 * — the budget is per day, and keeping history would make the file grow
 * without ever being read.
 *
 * @param {string} file
 * @returns {Record<string, number>}
 */
export function loadPace(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && raw.date === today() && raw.counts && typeof raw.counts === 'object'
      ? { ...raw.counts }
      : {};
  } catch {
    return {};   // absent or unreadable: today has spent nothing
  }
}

/** @param {string} file @param {Record<string, number>} counts */
export function savePace(file, counts) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ date: today(), counts }, null, 2));
  } catch { /* best-effort: pacing must never break a run */ }
}

/** What a service is allowed today. */
export function budgetFor(service, limits = null) {
  const ceiling = limits?.ceilings?.[service];
  return ceiling ?? DAILY_BUDGET[service] ?? DAILY_BUDGET.default;
}

// ONE DAY PER EMPLOYER SITE ON THE SHARED PLATFORMS (F-979). Workday's 1,500 a
// day was one pool for every tenant, spent in minutes on whichever employers
// came first, while 3,558 waiting rows sat on others. Each tenant host
// (kla.wd1.myworkdayjobs.com, careers-x.icims.com, hdjq.fa.us2.oraclecloud.com)
// is a different employer's site: it gets `perTenant` a day, and the platform
// as a whole its ceiling. Every other service is counted as before.
export const TENANTED = {
  'myworkdayjobs.com': 'paceWorkdayCeiling',
  'icims.com': 'paceIcimsCeiling',
  'oraclecloud.com': 'paceOracleCeiling',
  'jobvite.com': 'paceJobviteCeiling',
};

// Platforms whose employers share ONE host and are told apart by the first
// path segment: jobs.jobvite.com/mini-circuits and jobs.jobvite.com/egnyte are
// two employer sites, so the tenant is "<host>/<slug>", not the host.
const TENANT_BY_PATH = new Set(['jobvite.com']);

/** The limits a pacer uses, from his settings (settings.mjs keys). */
export function paceLimits(settings = {}) {
  const ceilings = {};
  for (const [platform, key] of Object.entries(TENANTED)) if (Number.isFinite(settings[key])) ceilings[platform] = settings[key];
  return {
    perTenant: Number.isFinite(settings.pacePerTenant) ? settings.pacePerTenant : 150, ceilings,
    tenantConcurrency: Number.isFinite(settings.paceTenantConcurrency) ? settings.paceTenantConcurrency : 2,
    freshReservePct: Number.isFinite(settings.paceFreshReservePct) ? settings.paceFreshReservePct : FRESH_RESERVE_PCT,
    freshReleaseUtc: Number.isFinite(settings.paceFreshReleaseUtc) ? settings.paceFreshReleaseUtc : FRESH_RELEASE_UTC,
  };
}

// NEW POSTINGS KEEP A SHARE OF EVERY SITE'S DAY (F-1000, 2026-11-04). The day
// resets at 00:00 UTC and the backlog spent it in the hours after: Workday's
// 4,000 were gone by 10:00 UTC, so the rows the 15:24 scan found waited for
// the next day (about 180 of 250 new rows sat on a site already spent). Until
// `freshReleaseUtc` the backlog may spend only (100 − freshReservePct)% of a
// service's day and of each employer site's day; new rows may spend all of it.
// At the release hour whatever the new rows left goes to the backlog, so over
// a day the backlog loses only what new postings actually read.
// Both are his settings (paceFreshReservePct, paceFreshReleaseUtc).
export const FRESH_RESERVE_PCT = 40;
export const FRESH_RELEASE_UTC = 20;

/** Would a BACKLOG request dip into the new postings' share right now? */
export function backlogHeld(keys, counts, limits = null, now = Date.now()) {
  const { service, tenant } = keys || {};
  const pct = limits?.freshReservePct ?? 0;
  if (!service || !(pct > 0)) return false;
  if (new Date(now).getUTCHours() >= (limits?.freshReleaseUtc ?? 0)) return false;
  const keep = (cap) => Math.floor(cap * (1 - Math.min(100, pct) / 100));
  if ((counts[service] || 0) >= keep(budgetFor(service, limits))) return true;
  if (tenant && (counts[`${service}@${tenant}`] || 0) >= keep(limits?.perTenant ?? 150)) return true;
  return false;
}

/**
 * { service, tenant } for a URL: tenant is the host on a tenanted platform
 * (host plus first path segment where the employers share a host), else ''.
 */
export function paceKeys(url, serviceOf) {
  let host = '', first = '';
  try {
    const u = new URL(String(url));
    host = u.hostname.toLowerCase();
    first = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
  } catch { return { service: '', tenant: '' }; }
  const service = serviceOf(url);
  if (!TENANTED[service]) return { service, tenant: '' };
  return { service, tenant: TENANT_BY_PATH.has(service) && first ? `${host}/${first}` : host };
}

/**
 * Is there allowance left for this URL today, given the day's counts? A
 * backlog row (`{ backlog: true }`) also stops at the new postings' share.
 */
export function hasAllowance(keys, counts, limits = null, { backlog = false, now = Date.now() } = {}) {
  const { service, tenant } = keys || {};
  if (!service) return true;
  if (backlog && backlogHeld(keys, counts, limits, now)) return false;
  if ((counts[service] || 0) >= budgetFor(service, limits)) return false;
  if (tenant && (counts[`${service}@${tenant}`] || 0) >= (limits?.perTenant ?? 150)) return false;
  return true;
}

/**
 * A spender over one run.
 *
 * `take()` is called before a request and answers whether it may be sent. It
 * is deliberately a decision, not a wait: the alternative to spending here is
 * reading a DIFFERENT service's rows, not sleeping.
 *
 * @param {string} file
 */
/**
 * A HAND-PICKED LIST GETS ITS OWN SMALL ALLOWANCE (2026-10-18). The auto
 * worker spends Workday's 1,500 within minutes of the UTC reset, so a targeted
 * re-read (the 139 GE postings of F-627, `enrich --ids-file`) was paced out
 * every day it could run. A run that names its rows may spend this much more
 * per service per day, counted apart under "<service>#reserve".
 */
export const TARGETED_RESERVE = 300;

export function makePacer(file, { reserve = 0, limits = null } = {}) {
  const counts = loadPace(file);
  const spentThisRun = new Map();
  const blocked = new Set();
  const held = new Set();

  return {
    /**
     * May one more request go to this service? Counts it if so. Takes a
     * service name, or { service, tenant } from paceKeys for a tenanted
     * platform: both the tenant's day and the platform's ceiling must allow it.
     * `{ backlog: true }`: an older row, which leaves the new postings' share
     * alone until the release hour (F-1000).
     */
    take(keyOrService, { backlog = false, now = Date.now() } = {}) {
      const { service, tenant = '' } = typeof keyOrService === 'string' ? { service: keyOrService } : (keyOrService || {});
      if (!service) return true;                 // unknown host: not paced
      const tk = tenant ? `${service}@${tenant}` : '';
      if (backlog && backlogHeld({ service, tenant }, counts, limits, now)) { held.add(tenant || service); return false; }
      if (!hasAllowance({ service, tenant }, counts, limits)) {
        // The reserve lifts the platform's ceiling for a hand-picked list, never
        // one employer site's own day (review, 2026-11-04).
        if (tk && (counts[tk] || 0) >= (limits?.perTenant ?? 150)) { blocked.add(tenant); return false; }
        const rk = `${service}#reserve`;
        const usedReserve = counts[rk] || 0;
        if (usedReserve >= reserve) { blocked.add(tenant || service); return false; }
        counts[rk] = usedReserve + 1;
        spentThisRun.set(service, (spentThisRun.get(service) || 0) + 1);
        return true;
      }
      counts[service] = (counts[service] || 0) + 1;
      if (tk) counts[tk] = (counts[tk] || 0) + 1;
      spentThisRun.set(service, (spentThisRun.get(service) || 0) + 1);
      return true;
    },
    /** Without spending: is there allowance left for these keys? */
    allows(keys, opts) { return hasAllowance(keys, counts, limits, opts); },
    /** Services that ran out during this run, for the run's own report. */
    exhausted() { return [...blocked]; },
    /** Sites where backlog rows waited because the rest of the day is kept for new postings. */
    heldForNew() { return [...held]; },
    /** What this run spent, per service. */
    spent() { return [...spentThisRun.entries()].sort((a, b) => b[1] - a[1]); },
    /** Persist. Cheap enough to call once at the end of a run. */
    flush() { savePace(file, counts); },
    /** Today's totals, for reporting. */
    totals() { return { ...counts }; },
  };
}
