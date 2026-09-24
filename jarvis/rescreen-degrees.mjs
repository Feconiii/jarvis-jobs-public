// jarvis/rescreen-degrees.mjs — put the eligibility verdict on every row.
//
// The store already had `f_degree_mismatch` and `degree_note`, and 13,767 rows
// carried them. They caught real things and missed the obvious ones: **"Mechanical
// Engineer New College Grad - Masters Degree"** and **"MBA Internship"** were
// both flagged 0, which is how they reached the top of a shortlist. His read was
// exactly right — "just basic screening stuff like that its failing".
//
// This walks the store with `eligibility()` and records what it finds, so the
// screen benefits the DASHBOARD too. A rule that only the picks skill consults
// leaves every other view showing him roles he cannot hold.
//
// Two deliberate limits:
//   ONLY ADDS.    An existing flag is never cleared. The old screen may know
//                 something this one does not, and un-flagging is the direction
//                 that puts an ineligible job back in front of him.
//   NEVER HIDES.  It sets a flag and writes the reason. Filtering is the view's
//                 decision, and this project's rule is that triage flags.
//
// Usage:  node jarvis/rescreen-degrees.mjs [--dry-run] [--limit N]

import { openDb, readDescription, getDictionary } from './db.mjs';
import { eligibility, titleIsHis } from './eligibility.mjs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_PATH = path.join(HERE, '..', 'data', 'jarvis', 'jobs.db');

export function rescreen(dbPath = DB_PATH, { dryRun = false, limit = 0, minFit = 0, reconcile = false } = {}) {
  const db = openDb(dbPath);
  const dict = getDictionary(db, 'description');
  const rows = db.prepare(
    `SELECT id, title, f_degree_mismatch, degree_note FROM jobs
       WHERE has_desc = 1 AND gone_at IS NULL AND fit_score >= ?
       ${limit ? 'LIMIT ' + Number(limit) : ''}`).all(Number(minFit) || 0);

  const set = db.prepare('UPDATE jobs SET f_degree_mismatch = 1, degree_note = ? WHERE id = ?');
  // CLEARING IS THE DIRECTION THAT MATTERS MOST, and the one held back longest.
  //
  // A degree flag removes the posting from the deck entirely, so a WRONG flag
  // hides a real job and he never learns it existed. The old screen put
  // "⛔ wants Computer Science" on the robotics and automation internship —
  // the single most on-target posting in the store — because the qualification
  // reads "Majoring in Engineering or Computer Science/Computer Engineering"
  // and it saw the second half. Only cleared where this screen finds his degree
  // named and his level sufficient, never on an ambiguous read.
  const clear = db.prepare("UPDATE jobs SET f_degree_mismatch = 0, degree_note = NULL WHERE id = ?");
  const stats = { scanned: 0, newlyFlagged: 0, alreadyFlagged: 0, cleared: 0, reasons: {} };

  // node:sqlite's DatabaseSync has no .transaction() helper — that is
  // better-sqlite3. One explicit transaction round the whole walk, so 150k
  // single-row updates do not become 150k fsyncs.
  if (!dryRun) db.exec('BEGIN');
  try {
    for (const r of rows) {
      stats.scanned++;
      const text = readDescription(db, r.id, dict);
      const e = eligibility(r, text);
      if (r.f_degree_mismatch === 1) {
        stats.alreadyFlagged++;
        if (reconcile && e.verdict === 'apply' && e.deg === 'bachelors-ok' && e.subj === 'his-field'
          && titleIsHis(r.title)) {
          stats.cleared++;
          if (!dryRun) clear.run(r.id);
        }
        continue;
      }
      if (e.verdict !== 'not-eligible') continue;
      stats.newlyFlagged++;
      for (const why of e.reasons) stats.reasons[why] = (stats.reasons[why] || 0) + 1;
      // Same JSON shape the triage writer uses, so the dashboard badge quotes
      // the posting rather than falling back to "wants another degree".
      if (!dryRun) set.run(JSON.stringify({ wanted: e.reasons, quote: e.evidence || '' }), r.id);
    }
    if (!dryRun) db.exec('COMMIT');
  } catch (err) {
    if (!dryRun) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } }
    throw err;
  }
  db.close?.();
  return stats;
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const dryRun = process.argv.includes('--dry-run');
  const li = process.argv.indexOf('--limit');
  const mf = process.argv.indexOf('--min-fit');
  const s = rescreen(DB_PATH, {
    dryRun,
    reconcile: process.argv.includes('--reconcile'),
    limit: li === -1 ? 0 : Number(process.argv[li + 1]),
    minFit: mf === -1 ? 0 : Number(process.argv[mf + 1]),
  });
  console.log(`\n${dryRun ? 'DRY RUN — nothing written' : 'written'}`);
  console.log(`  scanned          ${s.scanned}`);
  console.log(`  already flagged  ${s.alreadyFlagged}`);
  console.log(`  newly flagged    ${s.newlyFlagged}`);
  console.log(`  cleared          ${s.cleared}`);
  for (const [why, n] of Object.entries(s.reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(6)}  ${why}`);
  }
}
