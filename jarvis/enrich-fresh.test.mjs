// jarvis/enrich-fresh.test.mjs — the reader leaves new postings' share of a site's day to them (F-1000).
//
// A temp store: JARVIS_DATA_DIR is set, and the day's tally and his settings
// written, before enrich.mjs loads (its pacer reads both once at load). The
// release hour is 24 so the answer does not depend on the clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-enrich-fresh-'));
process.env.JARVIS_DATA_DIR = dir;
delete process.env.JARVIS_DB_PATH;
writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ paceFreshReservePct: 40, paceFreshReleaseUtc: 24 }));
// Greenhouse's day is 5,000: 3,000 spent leaves only the new postings' 40%.
writeFileSync(path.join(dir, 'enrich-pace.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), counts: { 'greenhouse.io': 3000 } }));

const store = await import('./store.mjs');
assert.equal(path.resolve(store.dbPath()), path.resolve(dir, 'jobs.db'), 'the test store, never his');
const { screenWaiting, isNewPosting } = await import('./enrich.mjs');

const NOW = Date.now();
const iso = (hAgo) => new Date(NOW - hAgo * 3600e3).toISOString();
const add = (id, firstSeenHoursAgo) => {
  const row = { id, url: `https://boards.greenhouse.io/acme/jobs/${id.replace(/\D/g, '') || 1}`, title: 'Mechanical Engineer', company: 'Acme', source: 'greenhouse', status: 'new', first_seen: iso(firstSeenHoursAgo), last_seen: iso(1) };
  const cols = Object.keys(row);
  store.db().prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
};

test('isNewPosting: first seen inside 72 h, whichever spelling the row has', () => {
  assert.equal(isNewPosting({ firstSeen: iso(5) }, NOW), true);
  assert.equal(isNewPosting({ first_seen: iso(80) }, NOW), false);
  assert.equal(isNewPosting({}, NOW), false, 'no date: backlog');
});

test('with only the new postings\' share of the day left, the reader takes new rows and holds the backlog', () => {
  add('n101', 5); add('n102', 30); add('o201', 24 * 20); add('o202', 24 * 40);
  const file = path.join(dir, 'screen.db');
  const s = new DatabaseSync(file);
  s.exec('CREATE TABLE verdicts (id TEXT PRIMARY KEY, key TEXT, verdict TEXT, stage TEXT, reason TEXT, company TEXT, title TEXT, fit INTEGER, desc_len INTEGER, at TEXT, body_hash TEXT)');
  const put = s.prepare("INSERT INTO verdicts (id, stage, fit) VALUES (?, 'waiting-body', ?)");
  // The backlog has the better fit: order alone would read it first.
  put.run('o201', 90); put.run('o202', 85); put.run('n101', 60); put.run('n102', 55);
  s.close();
  const picked = screenWaiting({}, { file, now: NOW }).map((j) => j.id);
  assert.deepEqual(picked.sort(), ['n101', 'n102']);
});
