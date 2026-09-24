#!/usr/bin/env node
// jarvis/assist-liveness.mjs — retire dead postings on boards no server can reach.
//
// WHY (F-447). `liveness-sweep.mjs` asks each posting's ATS whether it still
// exists. On a board that refuses non-browser HTTP that question cannot be
// asked at all, so those rows never expire: measured 2026-09-10, 296 of 1,000
// Tesla postings sampled were gone, and every one of them was still sitting in
// the store as live.
//
// The browser can ask, and it can ask ONCE for the whole board rather than
// once per posting. Tesla publishes its own listing feed
// (`/cua-api/apps/careers/state`, 8,089 reqs) to the page; one request names
// every requisition the employer still has open. Anything of theirs in the
// store that is not in that list is closed.
//
// EVIDENCE, NOT INFERENCE. This is the employer's own index, which is the same
// class of evidence `check-liveness.mjs` insists on and nothing like a search
// snippet. It was confirmed three ways before being trusted: the detail API
// 404s, the posting URL redirects to the careers search page, and the req is
// absent from the feed. All 296 agreed on all three.
//
// THE BREAKER. Marking live jobs dead is the one error this system does not
// tolerate — a false expiry makes him miss a real job and he never finds out.
// So a sweep that would retire an implausible share of a board refuses and
// says why, exactly as the mass-expiry breaker in enrich.mjs does. A truncated
// feed and an employer clearing its board look identical from here, and only
// one of them should be acted on.

import { db, getJob, updateJob, withStoreLock } from './store.mjs';
import { reqIdOf } from './req-id.mjs';

/** Nothing is retired if the feed would kill more than this share of a board. */
export const MAX_RETIRE_SHARE = 0.5;
/** Nor if the feed is too small to be a plausible index of the whole board. */
export const MIN_FEED = 25;

// Re-exported so existing callers and tests keep one import, but the rule
// itself lives in req-id.mjs — see F-449 for why it stopped living here.
export { reqIdOf };

/**
 * Decide what a live-id feed implies, WITHOUT writing anything.
 *
 * Separated from the write so the decision can be tested, printed and argued
 * with before any row is stamped.
 */
export function planSweep(company, liveReqIds, handle = db()) {
  const feed = new Set([...liveReqIds].map(String).filter(id => /^\d{2,}$/.test(id)));
  const rows = handle.prepare(
    'SELECT id, url, title FROM jobs WHERE company = ? AND gone_at IS NULL AND superseded_by IS NULL',
  ).all(company);

  const dead = [], keep = [], unkeyed = [];
  for (const r of rows) {
    const req = reqIdOf(r.url);
    // A row whose URL carries no requisition id cannot be judged by this feed.
    // Left alone, and counted out loud — silently treating "cannot tell" as
    // "still live" is fine here, but it must not read as "checked and live".
    if (!req) { unkeyed.push(r); continue; }
    (feed.has(req) ? keep : dead).push({ ...r, req });
  }

  const judged = dead.length + keep.length;
  const share = judged ? dead.length / judged : 0;
  const refusals = [];
  if (feed.size < MIN_FEED) {
    refusals.push(`the feed lists only ${feed.size} requisitions — too few to be this board's whole index`);
  }
  if (share > MAX_RETIRE_SHARE) {
    refusals.push(`it would retire ${dead.length} of ${judged} judged rows (${(100 * share).toFixed(0)}%) — that is a truncated feed, not an employer clearing its board`);
  }
  return {
    company, feedSize: feed.size, storeLive: rows.length,
    judged, keep: keep.length, dead, unkeyed: unkeyed.length,
    share, refusals, wouldRetire: refusals.length ? 0 : dead.length,
  };
}

/** Apply a plan. Returns the plan, with `retired` set to what was stamped. */
export async function sweep(company, liveReqIds, opts = {}) {
  const plan = planSweep(company, liveReqIds);
  plan.retired = 0;
  if (plan.refusals.length || opts.dryRun) return plan;
  await withStoreLock(async () => {
    const at = new Date().toISOString();
    for (const row of plan.dead) {
      // rederive so the row drops out of the deck the same way every other
      // retirement does — the score and the quotes stay, the card goes.
      if (getJob(row.id)) { updateJob(row.id, { goneAt: at }, { rederive: true }); plan.retired++; }
    }
  });
  return plan;
}
