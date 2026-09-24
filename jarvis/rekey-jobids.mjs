#!/usr/bin/env node
// jarvis/rekey-jobids.mjs — one-shot repair after the job-id fix.
//
//   node jarvis/rekey-jobids.mjs            # report what would change
//   node jarvis/rekey-jobids.mjs --write    # do it
//
// A job's id is a hash of its URL, and the hash used to throw the query string
// away. That is right for decoration (`?domain=micron.com` rides on every
// Eightfold sitemap URL) and wrong for identity: a Greenhouse board embedded on
// a company's own site serves every posting from ONE path and separates them
// only by `?gh_jid=`. So all of them hashed the same and each overwrote the
// last. Zipline kept 1 of 315 postings. Agility Robotics, Waymo and Nuro were
// showing exactly one job each.
//
// store.mjs now keeps identity-bearing parameters. Rows written before that
// still carry the old hash, so they are invisible to any lookup by URL and a
// re-scan would insert a duplicate beside them. This walks the affected rows
// and moves each to its correct id IN PLACE — the row keeps its status, its
// resume, its verdict and its dates, because those are the user's and a repair
// must never cost him one.
//
// Where an old row and a correct row both exist, the one carrying a decision
// wins; if neither was decided, the one seen most recently wins.

import { db, jobId, closeDb } from './store.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/rekey-jobids.mjs [options]

  Recompute job ids across the store.

    --write               
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--write"], valued: [] });


const write = process.argv.includes('--write');
const DECIDED = new Set(['interested', 'queued', 'applied', 'responded', 'interview', 'offer', 'rejected', 'hidden']);
const decided = (r) => !!(r && (DECIDED.has(r.status) || r.resume_path || r.applied_at || r.resume_sent));

const handle = db();
const rows = handle.prepare("SELECT id, url, status, resume_path, applied_at, resume_sent, last_seen FROM jobs WHERE url LIKE '%?%'").all();

const moves = [];
for (const r of rows) {
  const want = jobId(r.url);
  if (want !== r.id) moves.push({ from: r.id, to: want, row: r });
}

console.log(`\n── Job-id repair ──`);
console.log(`  Rows with a query string : ${rows.length}`);
console.log(`  Rows on the wrong id     : ${moves.length}`);

if (!moves.length) {
  console.log('\n  Nothing to repair.\n');
  closeDb();
  process.exit(0);
}

const byCompany = {};
for (const m of moves) {
  const c = handle.prepare('SELECT company FROM jobs WHERE id = ?').get(m.from)?.company || '(unknown)';
  byCompany[c] = (byCompany[c] || 0) + 1;
}
console.log('\n  By company:');
for (const [c, n] of Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`    ${String(n).padStart(5)}  ${c}`);
}

const kept = moves.filter((m) => decided(m.row)).length;
console.log(`\n  Carrying a decision (must survive): ${kept}`);

if (!write) {
  console.log('\n  (dry run — re-run with --write to apply)\n');
  closeDb();
  process.exit(0);
}

const getById = handle.prepare('SELECT id, status, resume_path, applied_at, resume_sent, last_seen FROM jobs WHERE id = ?');
const delJob = handle.prepare('DELETE FROM jobs WHERE id = ?');
const delDet = handle.prepare('DELETE FROM details WHERE id = ?');
const delDesc = handle.prepare('DELETE FROM descriptions WHERE id = ?');
const updJob = handle.prepare('UPDATE jobs SET id = ? WHERE id = ?');
const updDet = handle.prepare('UPDATE details SET id = ? WHERE id = ?');
const updDesc = handle.prepare('UPDATE descriptions SET id = ? WHERE id = ?');

let moved = 0, resolved = 0, skipped = 0;
handle.exec('BEGIN IMMEDIATE');
try {
  for (const m of moves) {
    const clash = getById.get(m.to);
    if (clash) {
      // Both ids exist. Keep whichever the user acted on; else the fresher row.
      const keepNew = decided(clash) || (!decided(m.row) && String(clash.last_seen || '') >= String(m.row.last_seen || ''));
      if (keepNew) {
        delDet.run(m.from); delDesc.run(m.from); delJob.run(m.from);
      } else {
        delDet.run(m.to); delDesc.run(m.to); delJob.run(m.to);
        updDet.run(m.to, m.from); updDesc.run(m.to, m.from); updJob.run(m.to, m.from);
      }
      resolved++;
      continue;
    }
    updDet.run(m.to, m.from); updDesc.run(m.to, m.from); updJob.run(m.to, m.from);
    moved++;
  }
  handle.exec('COMMIT');
} catch (err) {
  handle.exec('ROLLBACK');
  console.error(`\n  ✗ rolled back: ${err.message}\n`);
  closeDb();
  process.exit(1);
}

console.log(`\n  Moved to the correct id : ${moved}`);
console.log(`  Collisions resolved     : ${resolved}`);
if (skipped) console.log(`  Skipped                 : ${skipped}`);
console.log('\n  Re-scan the affected companies to pull the postings that were being overwritten.\n');
closeDb();
