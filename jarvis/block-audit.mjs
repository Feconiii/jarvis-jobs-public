#!/usr/bin/env node
// jarvis/block-audit.mjs — which employers can he essentially never work for?
//
// WHY THIS EXISTS (F-442). The clearance gate in `discover-ats.mjs` has been
// extended one company at a time, and always because a NAME looked
// defence-shaped: True Anomaly, Chariot Defense, Mach Industries, Skydio. That
// finds only what someone thought to check, and it gets the answer wrong as
// often as right — measured on 2026-09-10, Mach Industries blocked 25 of 25
// while Mariana Minerals blocked 0 of 71, and the two names read identically.
//
// This asks the store instead. For every employer, of the postings actually
// READ, what share hard-block on work authorisation? No reputation, no
// guessing, just what their own descriptions say.
//
// WHAT IT IS NOT. A high rate is not automatically a reason to gate anyone.
// Two very different things produce 100%:
//
//   · ITAR and clearance — space and defence (Rocket Lab, Ursa Major, Varda).
//   · "must be authorised to work in the US without sponsorship" — ordinary US
//     manufacturers that simply do not sponsor (Analog Devices, 3M, John Deere).
//
// Both are closed to an F-1/OPT candidate, and BOTH ARE ALREADY HANDLED: triage
// hard-blocks those postings individually, with the quote, so they never reach
// his deck. Nothing here protects him further. What it measures is COST — scan
// time and store space spent on boards that cannot produce an applyable role.
//
// So this reports and proposes. It never edits `portals.yml`: hiding an
// employer is his decision, every time.
//
// Usage:
//   node jarvis/block-audit.mjs                 # the full picture
//   node jarvis/block-audit.mjs --min-read 20   # stricter evidence bar
//   node jarvis/block-audit.mjs --threshold 90  # only the near-total blockers

import { openDb } from './db.mjs';
import { STORE_DIR } from './store.mjs';
import path from 'path';
import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/block-audit.mjs [options]

  Rank employers by how often their READ postings hard-block on work
  authorisation. Reports only — never edits portals.yml.

    --min-read <n>    ignore employers with fewer postings read (default 8)
    --threshold <n>   list employers at or above this block % (default 60)
    --help, -h
`;
guardArgs({ usage: USAGE, flags: ['--min-read', '--threshold'], valued: ['--min-read', '--threshold'] });

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MIN_READ = arg('--min-read', 8);
const THRESHOLD = arg('--threshold', 60);

const db = openDb(path.join(STORE_DIR, 'jobs.db'));

const rows = db.prepare(`
  SELECT company,
         COUNT(*) AS read_n,
         SUM(CASE WHEN f_hard_block = 1 THEN 1 ELSE 0 END) AS blocked
  FROM jobs
  WHERE has_desc = 1 AND gone_at IS NULL
  GROUP BY company
  HAVING read_n >= ?
`).all(MIN_READ).map(r => ({ ...r, pct: (100 * r.blocked) / r.read_n }));

rows.sort((a, b) => b.pct - a.pct || b.read_n - a.read_n);
const flagged = rows.filter(r => r.pct >= THRESHOLD);

console.log(`\n${rows.length} employers with ${MIN_READ}+ postings read.`);
console.log(`${flagged.length} block ${THRESHOLD}% or more of what has been read.\n`);
console.log('  rate  blocked/read   employer');
for (const r of flagged) {
  console.log(`  ${r.pct.toFixed(0).padStart(3)}%  ${String(r.blocked).padStart(5)}/${String(r.read_n).padEnd(6)} ${r.company}`);
}

// The total blockers, costed — and costed HONESTLY, which means separating a
// row that was read and came back clear from one nobody has looked at. An
// unread row carries f_hard_block = 0 because it was never examined, and
// counting those as opportunities is the mistake this whole audit exists to
// avoid making at scale.
const total = rows.filter(r => r.blocked === r.read_n);
if (total.length) {
  const names = total.map(r => r.company);
  const ph = names.map(() => '?').join(',');
  const live = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE company IN (${ph}) AND gone_at IS NULL`).get(...names).c;
  const unread = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE company IN (${ph}) AND gone_at IS NULL AND (has_desc = 0 OR has_desc IS NULL)`).get(...names).c;
  const REL = `gone_at IS NULL AND f_hard_block = 0 AND location_bucket IN ('us','remote','unknown') AND relevance >= 12`;
  const clear = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE company IN (${ph}) AND ${REL} AND has_desc = 1`).get(...names).c;
  const unseen = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE company IN (${ph}) AND ${REL} AND (has_desc = 0 OR has_desc IS NULL)`).get(...names).c;

  console.log(`\n${total.length} employers block EVERY posting anyone has read.`);
  console.log(`  live postings they carry        : ${live}`);
  console.log(`  of those, never read            : ${unread}`);
  console.log(`  relevant AND read AND unblocked : ${clear}`);
  console.log(`  relevant but never examined     : ${unseen}   (f_hard_block = 0 means "nobody looked")`);
  if (clear === 0) {
    console.log(`\n  Across every posting read at these ${total.length} employers, not one`);
    console.log('  relevant role is open to him. Disabling them would cost scan time and');
    console.log('  nothing else — but that is a decision for Alex, not for this script.');
    console.log('  To act on it: set `enabled: false` on the entries you choose.');
  }
}
console.log('');
