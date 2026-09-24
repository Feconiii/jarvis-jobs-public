#!/usr/bin/env node
// jarvis/prune.mjs — reclaim the space dead postings take up.
//
//   node jarvis/prune.mjs                 # report what would go, write nothing
//   node jarvis/prune.mjs --write         # drop the bodies
//   node jarvis/prune.mjs --write --vacuum# …and shrink the file on disk
//   node jarvis/prune.mjs --days 90       # a different definition of "dead"
//
// A posting the scanner has stopped finding is gone from the employer's site.
// You cannot apply to it, so nothing needs re-deriving from its text — and the
// text is 87% of what it costs to keep. This drops the BODY and keeps
// everything else: the company, the title, the link, the dates, the score, the
// verdict and its verbatim quotes. The job still shows up in every list and
// every count; it simply has no description to open.
//
// What it will NOT touch:
//   - anything you decided on (interested / queued / applied / …). Those are
//     yours, and a body you might want to re-read is worth more than the space.
//   - live postings. A verdict is re-derived FROM the description, so dropping
//     a live job's body would mean a later triage fix could never un-block a
//     job it had wrongly blocked — the one direction of error the product laws
//     forbid. Blocked-and-live jobs keep their text for exactly that reason,
//     even though they are the biggest pile.
//
// Pruned jobs are marked, so the enrichment worker does not see "no
// description" and download them all over again.

import { db, dropDescription, count, DB_PATH } from './store.mjs';
import { statSync } from 'fs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  npm run jarvis:prune -- [options]
  
    Retire stale rows and reclaim space in the job store.
  
      --days <n>    how old a gone posting must be before it is dropped
      --vacuum      compact the database file afterwards
      --write       actually make the changes (otherwise it reports only)
      --help, -h    print this
`;

// F-162: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--days","--vacuum","--write"], valued: ["--days"] });


const args = process.argv.slice(2);
const write = args.includes('--write');
const vacuum = args.includes('--vacuum');
const daysFlag = args.indexOf('--days');
const DAYS = daysFlag !== -1 && args[daysFlag + 1] ? Number(args[daysFlag + 1]) : 45;

const MB = (b) => `${(b / 1048576).toFixed(0)} MB`;
const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString();

// Statuses that mean "I acted on this" — never pruned.
const DECIDED = ['interested', 'queued', 'applied', 'responded', 'interview', 'offer', 'rejected'];

const handle = db();
const where = `
  FROM jobs
  WHERE has_desc = 1
    AND body_pruned = 0
    AND last_seen < ?
    AND status NOT IN (${DECIDED.map(() => '?').join(', ')})`;
const params = [cutoff, ...DECIDED];

const target = handle.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(desc_len), 0) AS chars ${where}`).get(...params);
const packed = handle.prepare(
  `SELECT COALESCE(SUM(LENGTH(d.blob)), 0) AS bytes FROM descriptions d
   JOIN jobs ON jobs.id = d.id
   WHERE jobs.has_desc = 1 AND jobs.body_pruned = 0 AND jobs.last_seen < ?
     AND jobs.status NOT IN (${DECIDED.map(() => '?').join(', ')})`).get(...params);

const sizeBefore = statSync(DB_PATH).size;

console.log(`\n── Dead postings (not seen by a scan since ${cutoff.slice(0, 10)}, ${DAYS} days) ──`);
console.log(`  Bodies to drop : ${Number(target.n).toLocaleString()}`);
console.log(`  Text           : ${MB(Number(target.chars))} (${MB(Number(packed.bytes))} on disk, compressed)`);
console.log(`  Kept           : the job, its score, its verdict and every quote`);
console.log(`  Never touched  : ${count({ status: DECIDED }).toLocaleString()} jobs you decided on`);

if (!Number(target.n)) { console.log('\n  Nothing to prune.\n'); process.exit(0); }
if (!write) {
  console.log(`\n  (report only — run with --write to drop them, --vacuum to shrink the file)\n`);
  process.exit(0);
}

const ids = handle.prepare(`SELECT id ${where}`).all(...params).map(r => r.id);
handle.exec('BEGIN IMMEDIATE');
try {
  for (const id of ids) dropDescription(id);
  handle.exec('COMMIT');
} catch (err) {
  handle.exec('ROLLBACK');
  throw err;
}

// Deleting rows frees pages inside the file but does not shrink the file. That
// only matters when the space is wanted back on the disk rather than for the
// next few thousand postings, so it is opt-in.
if (vacuum) {
  console.log('\n  Rewriting the file to release the space (this reads and writes it once)…');
  handle.exec('VACUUM');
}
handle.exec('ANALYZE');

const sizeAfter = statSync(DB_PATH).size;
console.log(`\n  Dropped ${ids.length.toLocaleString()} bodies.`);
console.log(`  Store: ${MB(sizeBefore)} → ${MB(sizeAfter)}${vacuum ? '' : '  (free space is reused; --vacuum to hand it back to the disk)'}`);
console.log(`  Remaining bodies: ${count({ hasDesc: true }).toLocaleString()}\n`);
