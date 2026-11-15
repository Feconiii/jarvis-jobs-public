// jarvis/lookup-indexes.mjs — build the reader's lookup indexes on the live store, once, at a quiet moment.
//
// The indexes are in the store's schema (db.mjs), so any open would build them;
// on 1,059,595 rows that takes the write lock for a while, so this command does
// it deliberately: only when no daily search, scan or enrichment is running,
// timed, with the file's size before and after and the three query plans.
//
//   node jarvis/lookup-indexes.mjs            build (refuses while anything is running)
//   node jarvis/lookup-indexes.mjs --check    plans and sizes only, nothing built
import { statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { guardArgs } from './cli.mjs';

guardArgs({
  usage: `  node jarvis/lookup-indexes.mjs [--check]
  Build jobs_company_lower and jobs_title_lower on the store (the reader's
  per-posting checks), only while nothing else is running. --check builds nothing.`,
  flags: ['--check'],
});
const check = process.argv.includes('--check');

const { STORE_DIR, dbPath } = await import('./store.mjs');
const file = dbPath();
const mb = (f) => (existsSync(f) ? Math.round(statSync(f).size / 1048576) : 0);
const sizes = () => ({ db: mb(file), wal: mb(`${file}-wal`) });
const PLANS = {
  priorRows: "SELECT title FROM jobs WHERE lower(company) = lower(?) AND id <> ? AND (applied_at IS NOT NULL OR status IN ('applied','inbox','interested','rejected','hidden')) ORDER BY status_changed_at DESC LIMIT 25",
  turnedDownAt: "SELECT title FROM jobs WHERE lower(company) = lower(?) AND id <> ? AND pick_note LIKE 'Not curated%' ORDER BY status_changed_at DESC LIMIT 25",
  sameRequisition: "SELECT company FROM jobs WHERE lower(title) = lower(?) AND id <> ? AND lower(company) <> lower(?) AND (applied_at IS NOT NULL OR status IN ('applied','inbox','interested','rejected','hidden'))",
};
const report = (label) => {
  const ro = new DatabaseSync(file, { readOnly: true });
  try {
    const have = ro.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('jobs_company_lower','jobs_title_lower')").all().map((r) => r.name);
    console.log(`${label}: indexes ${have.length ? have.join(', ') : 'none'}; jobs.db ${sizes().db} MB, wal ${sizes().wal} MB`);
    for (const [k, sql] of Object.entries(PLANS)) {
      const p = ro.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill('x')).map((r) => r.detail).join(' | ');
      const t0 = performance.now();
      ro.prepare(sql).all(...['Kimley-Horn', 'x', 'Kimley-Horn'].slice(0, (sql.match(/\?/g) || []).length));
      console.log(`  ${k.padEnd(16)} ${(performance.now() - t0).toFixed(1).padStart(8)} ms  ${p}`);
    }
    return have.length === 2;
  } finally { ro.close(); }
};

// Anything that writes the store, running now?
const busy = [];
try {
  const pid = Number(readFileSync(path.join(STORE_DIR, 'curate-daily.lock'), 'utf8')) || 0;
  if (pid) { try { process.kill(pid, 0); busy.push(`daily search pid ${pid}`); } catch (e) { if (e.code === 'EPERM') busy.push(`daily search pid ${pid}`); } }
} catch { /* no lock */ }
try { const { runningScanPid } = await import('./scan-pid.mjs'); const s = runningScanPid(); if (s) busy.push(`scan pid ${s}`); } catch { /* none */ }
try {
  const p = JSON.parse(readFileSync(path.join(STORE_DIR, 'enrich-progress.json'), 'utf8'));
  if (p.running && Date.now() - Date.parse(p.updatedAt || 0) < 10 * 60_000) busy.push('an enrichment run');
} catch { /* none */ }

const already = report('before');
if (check) process.exit(0);
if (already) { console.log('both indexes are already there; nothing to build'); process.exit(0); }
if (busy.length) { console.log(`not now: ${busy.join(', ')} — run again when nothing is writing the store`); process.exit(3); }

const { openDb } = await import('./db.mjs');
const before = sizes();
const t0 = Date.now();
const db = openDb(file);   // the store's schema: CREATE INDEX IF NOT EXISTS …
db.close?.();
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const after = sizes();
console.log(`built in ${secs} s; jobs.db ${before.db} → ${after.db} MB, wal ${before.wal} → ${after.wal} MB`);
if (!report('after')) { console.log('the indexes are not there: another process held the write lock (openDb skips the schema then); run again'); process.exit(1); }
