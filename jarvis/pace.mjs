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
export function budgetFor(service) {
  return DAILY_BUDGET[service] ?? DAILY_BUDGET.default;
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
export function makePacer(file) {
  const counts = loadPace(file);
  const spentThisRun = new Map();
  const blocked = new Set();

  return {
    /** May one more request go to this service? Counts it if so. */
    take(service) {
      if (!service) return true;                 // unknown host: not paced
      const used = counts[service] || 0;
      if (used >= budgetFor(service)) { blocked.add(service); return false; }
      counts[service] = used + 1;
      spentThisRun.set(service, (spentThisRun.get(service) || 0) + 1);
      return true;
    },
    /** Services that ran out during this run, for the run's own report. */
    exhausted() { return [...blocked]; },
    /** What this run spent, per service. */
    spent() { return [...spentThisRun.entries()].sort((a, b) => b[1] - a[1]); },
    /** Persist. Cheap enough to call once at the end of a run. */
    flush() { savePace(file, counts); },
    /** Today's totals, for reporting. */
    totals() { return { ...counts }; },
  };
}
