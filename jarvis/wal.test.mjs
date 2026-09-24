#!/usr/bin/env node
/**
 * jarvis/wal.test.mjs — the journal is capped, and it can be folded back in.
 *
 * F-522. Measured 2026-09-20: `jobs.db-wal` reached **418,971,072 bytes** beside
 * a 774 MB store — 48× the `wal_autocheckpoint` threshold — because two separate
 * things were true at once and only one of them is obvious.
 *
 *   `journal_size_limit` defaults to -1, which means "never shrink the file".
 *   A checkpoint could copy every page back into the database and the 199 MB
 *   file would still be 199 MB on disk, ready to be refilled.
 *
 *   A passive autocheckpoint cannot reset the WAL AT ALL while another
 *   connection holds an older read mark, and with the dashboard, a scan child
 *   and an apply run on this store there is nearly always one.
 *
 * So: the limit is asserted on the connection, and the explicit checkpoint is
 * asserted to shrink the file AND to lose nothing. The second half is the one
 * that matters — a checkpoint that dropped rows would be far worse than a large
 * journal.
 */
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)}\n    got      ${JSON.stringify(got)}`);
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
};

const walSize = (dbPath) => { try { return statSync(`${dbPath}-wal`).size; } catch { return 0; } };

console.log('🧪 store: the WAL is capped and can be folded back in');

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-wal-'));
const dbPath = path.join(dir, 'jobs.db');
process.env.JARVIS_DB_PATH = dbPath;

const S = await import('./store.mjs');
const h = S.db();

eq('the store is in WAL mode to begin with',
  String(h.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase(), 'wal');
// Per-CONNECTION, not stored in the file — which is why it is set on every open
// rather than once at creation.
eq("the journal limit is set, not left at SQLite's -1",
  Number(h.prepare('PRAGMA journal_size_limit').get()?.journal_size_limit), 67108864);

// Enough writes to put real pages in the journal.
const rows = [];
for (let i = 0; i < 500; i += 1) {
  rows.push({
    url: `https://example.test/wal/${i}`,
    title: `Manufacturing Engineer ${i}`,
    company: 'WalCo',
    location: 'Austin, TX',
  });
}
S.upsertJobs(rows);

const before = walSize(dbPath);
ok('the journal has something in it to fold back', before > 0, `wal was ${before} bytes`);

const r = S.checkpointWal();
ok('the checkpoint reports rather than throwing', r && typeof r.busy === 'boolean', JSON.stringify(r));

const after = walSize(dbPath);
ok('TRUNCATE actually shrank the file on disk', after < before, `${before} -> ${after}`);

// THE HALF THAT MATTERS. A checkpoint that shrank the file by losing rows would
// be a far worse fault than the one it fixes.
eq('every row survived', h.prepare('SELECT COUNT(*) n FROM jobs').get().n, 500);
eq('and the database is sound', String(h.prepare('PRAGMA quick_check').get()?.quick_check), 'ok');
ok('a row still reads back correctly',
  S.getJobByUrl('https://example.test/wal/250')?.title === 'Manufacturing Engineer 250');

// Closing checkpoints too — the moment this process releases its own read mark
// is when a checkpoint is most likely to succeed.
S.upsertJobs([{ url: 'https://example.test/wal/last', title: 'Last', company: 'WalCo', location: 'Austin, TX' }]);
S.closeDb();
ok('closing folds the journal back in as well', walSize(dbPath) === 0, `wal is ${walSize(dbPath)} bytes after close`);

// Calling it with no open handle is a no-op, never a throw: it runs from a
// shutdown path where the handle may already be gone.
eq('a checkpoint with no open handle is a no-op', S.checkpointWal(), null);

delete process.env.JARVIS_DB_PATH;
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows still has the file */ }

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
