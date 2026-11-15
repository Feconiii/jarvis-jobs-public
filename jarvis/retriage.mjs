#!/usr/bin/env node
// jarvis/retriage.mjs — recompute triage for every job already in the store.
//
// Triage is pure, deterministic and derived entirely from data already on the
// record (title, description, location), so it can be recomputed at any time.
// Whenever a classifier changes — a new visa pattern, a role-kind fix, the
// graduation-window check — the 26k jobs captured BEFORE that change still
// carry the old verdict. Without this they only get corrected if and when they
// happen to be re-scanned or enriched, which for most of the store is never.
//
// User statuses, resume paths, apply records and every other user-owned field
// are untouched: only `job.triage` is replaced.
//
// Usage:
//   node jarvis/retriage.mjs            # recompute all, report what changed
//   node jarvis/retriage.mjs --dry-run  # report only, write nothing
//   node jarvis/retriage.mjs --deck-only --budget 480 [--after <id>]
//   node jarvis/retriage.mjs --block-key no_sponsorship   # just those rows
//   node jarvis/retriage.mjs --grad-mismatch              # after a grad-window fix
//   node jarvis/retriage.mjs --degree-mismatch            # after a degree.mjs fix
//   node jarvis/retriage.mjs --location                   # after a geo.mjs fix: only rows
//                                                         # whose stored bucket the new reading changes
//
// `--block-key` exists because a visa fix that UN-blocks postings cannot be
// applied with --deck-only: the rows it would free are hard-blocked, so they
// are not in the deck. It is the cheap, targeted pass after a visa.mjs change —
// 6,879 rows instead of 268,000.
//
// The same pause/resume flags rescore.mjs carries, and for the same reason: a
// full pass over 150,000 postings outlives the patience of whatever is
// supervising it, and a half-finished pass leaves the store disagreeing with
// itself about which jobs are winnable.

import { ids, getJob, putJob, db } from './store.mjs';
import { bucketDrifted } from './geo.mjs';
import { triage } from './triage.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/retriage.mjs [options]

  Re-run triage across the store.

    --after <value>
    --grad-mismatch
    --block-key <value>
    --budget <value>
    --deck-only
    --degree-mismatch
    --location            only rows whose stored location bucket the current geo reading changes
    --dry-run
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--after","--block-key","--budget","--deck-only","--degree-mismatch","--dry-run","--grad-mismatch","--location"], valued: ["--after","--block-key","--budget"] });


const DRY = process.argv.includes('--dry-run');
const ARGV = process.argv.slice(2);
const argOf = (name) => { const i = ARGV.indexOf(name); return i !== -1 ? ARGV[i + 1] : undefined; };
const BUDGET_MS = argOf('--budget') ? Number(argOf('--budget')) * 1000 : Infinity;
const AFTER = argOf('--after') || '';
const DECK_ONLY = ARGV.includes('--deck-only');
const BLOCK_KEY = argOf('--block-key') || '';
// The same argument as --block-key, for the other classifier that HIDES rows.
// A graduation-window fix that widens a window frees postings which are, by
// definition, not in the deck, so --deck-only cannot reach them either.
const GRAD_MISMATCH = ARGV.includes('--grad-mismatch');
// And again for the degree check (F-507): a fix that stops reading a preferred
// "Advanced degree" as the requirement frees rows the deck pass cannot see.
const DEGREE_MISMATCH = ARGV.includes('--degree-mismatch');

const filter = BLOCK_KEY ? { blockKey: BLOCK_KEY } : GRAD_MISMATCH ? { gradMismatch: true } : DEGREE_MISMATCH ? { degreeMismatch: true } : DECK_ONLY ? { browsable: true } : {};

// Ids first, then one job at a time: this pass writes every row it reads, and
// a live query cannot be iterated while its rows are being updated.
// --location (2026-11-03): a geo.mjs change moves rows no flag names, so they
// are found by asking the current reading of every open row (read only; the
// writes below are this pass's own).
const LOCATION = ARGV.includes('--location');
const jobIds = (LOCATION
  ? db().prepare('SELECT id, location, title, url, location_bucket FROM jobs WHERE gone_at IS NULL').all().filter(bucketDrifted).map((r) => r.id)
  : ids(filter)).sort().filter(id => id > AFTER);
const scope = LOCATION ? ' whose location bucket the current reading changes' : BLOCK_KEY ? ` blocked as ${BLOCK_KEY}` : GRAD_MISMATCH ? ' excluded on their graduation window' : DEGREE_MISMATCH ? ' excluded on their degree requirement' : DECK_ONLY ? ' in the deck' : '';
console.log(`Re-triaging ${jobIds.length.toLocaleString()} jobs${scope}${DRY ? ' (dry run)' : ''}…`);

// Count transitions on the fields that change what the user sees, so a
// classifier change reports its real-world blast radius instead of "done".
const before = { hardBlock: 0, handsOn: 0, internship: 0, newGrad: 0, gradMismatch: 0, degreeMismatch: 0 };
const after = { ...before };
const changed = { hardBlock: 0, handsOn: 0, internship: 0, newGrad: 0, gradMismatch: 0, degreeMismatch: 0, level: 0 };

// A SCAN HOLDING THE WRITE LOCK STOPS THE PASS CLEANLY, it does not crash it
// (F-483 in rescore.mjs; here F-727, 2026-10-13: the deck pass after F-724 died
// on its first write as a raw "database is locked" stack while the dashboard's
// scan ran). A lock is waited out briefly; one that holds is a clean stop at
// the row reached, with the command that resumes.
const writeJob = (job) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { putJob(job, { description: false }); return true; }
    catch (err) {
      if (!/lock|busy/i.test(String(err?.message || ''))) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * (attempt + 1));
    }
  }
  return false;
};

const STARTED = Date.now();
let cursor = AFTER, ranOut = false, lockedOut = false, seen = 0;
for (const id of jobIds) {
  if (Date.now() - STARTED > BUDGET_MS) { ranOut = true; break; }
  cursor = id; seen++;
  // Triage is computed FROM the description, so the body is read — but it has
  // not changed, so it is not written back.
  const job = getJob(id, { description: true });
  if (!job) continue;
  const old = job.triage || {};
  const oldFlags = old.flags || {};
  for (const k of Object.keys(before)) if (oldFlags[k]) before[k]++;

  // enrichedAt: a short body nothing has read in full is "not screened" (F-627).
  const next = triage({ title: job.title, description: job.description, location: job.location, url: job.url, enrichedAt: job.enrichedAt ?? null });
  const nextFlags = next.flags;
  for (const k of Object.keys(after)) if (nextFlags[k]) after[k]++;
  for (const k of Object.keys(changed)) {
    if (k === 'level') { if (old.experience?.level !== next.experience?.level) changed.level++; }
    else if (!!oldFlags[k] !== !!nextFlags[k]) changed[k]++;
  }

  if (!DRY) {
    job.triage = next;
    if (!writeJob(job)) { lockedOut = true; seen--; break; }
  }
}
// The row that could not be written is the one to start from.
const resumeAfter = lockedOut ? jobIds[jobIds.indexOf(cursor) - 1] || '' : cursor;

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('flag', 14)} ${pad('before', 8)} ${pad('after', 8)} changed`);
for (const k of Object.keys(before)) {
  console.log(`${pad(k, 14)} ${pad(before[k].toLocaleString(), 8)} ${pad(after[k].toLocaleString(), 8)} ${changed[k].toLocaleString()}`);
}
console.log(`${pad('experience', 14)} ${pad('', 8)} ${pad('', 8)} ${changed.level.toLocaleString()}`);
if (ranOut || lockedOut) {
  const flags = ARGV.filter((a, i) => a !== '--after' && ARGV[i - 1] !== '--after').join(' ');
  console.log(`\n${lockedOut ? 'Stopped: another process (a scan?) holds the store\'s write lock.' : 'Budget spent.'} ${seen.toLocaleString()} of ${jobIds.length.toLocaleString()} done. Resume with:`);
  console.log(`  node jarvis/retriage.mjs${flags ? ` ${flags}` : ''}${resumeAfter ? ` --after ${resumeAfter}` : ''}`);
}
console.log(DRY ? '\nDry run — nothing written.' : !seen ? '\nNothing written.' : lockedOut || ranOut ? '\nStore partly updated.' : '\nStore updated.');
if (lockedOut) process.exitCode = 2;
