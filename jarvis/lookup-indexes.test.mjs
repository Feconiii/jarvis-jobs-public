// jarvis/lookup-indexes.test.mjs — the reader's per-posting checks SEARCH an index, not SCAN the store (2026-11-04).
//
// A temp store through the store's own openDb (its schema adds the indexes).
// The SQL is cut from curate.mjs itself, so this checks the queries the reader
// actually runs, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-lookup-idx-'));
process.env.JARVIS_DATA_DIR = dir;
delete process.env.JARVIS_DB_PATH;
const { openDb } = await import('./db.mjs');
const { priorRows, turnedDownAt } = await import('./curate.mjs');
const file = path.join(dir, 'jobs.db');
assert.ok(path.resolve(file).toLowerCase().startsWith(path.resolve(tmpdir()).toLowerCase()), 'a temp store, never his');
const db = openDb(file);

const src = readFileSync(new URL('./curate.mjs', import.meta.url), 'utf8');
// The three statements, as curate.mjs writes them.
const sqlAfter = (marker) => {
  const at = src.indexOf(marker);
  assert.ok(at > 0, `curate.mjs still has ${marker}`);
  const m = src.slice(at).match(/prepare\(`([^`]+)`\)/);
  return m[1];
};
const PRIOR = sqlAfter('export function priorRows');
const TURNED = sqlAfter('export function turnedDownAt');
const SAMEREQ = sqlAfter('const same = db.prepare');
const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) || []).length).fill('x')).map((r) => r.detail).join(' | ');

const add = (id, extra) => {
  const row = { id, url: `https://x.test/${id}`, title: 'Engineer', company: 'Acme', status: 'new', first_seen: '2026-11-01', last_seen: '2026-11-04', ...extra };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
};

test('the store has the two expression indexes', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'").all().map((r) => r.name);
  assert.ok(names.includes('jobs_company_lower'));
  assert.ok(names.includes('jobs_title_lower'));
});

test('all three reader checks SEARCH their index, none SCANs jobs', () => {
  for (const [name, sql, idx] of [['priorRows', PRIOR, 'jobs_company_lower'], ['turnedDownAt', TURNED, 'jobs_company_lower'], ['same requisition', SAMEREQ, 'jobs_title_lower']]) {
    const p = plan(sql);
    assert.match(p, new RegExp(`SEARCH jobs USING INDEX ${idx}`), `${name}: ${p}`);
    assert.doesNotMatch(p, /SCAN jobs\b/, `${name}: ${p}`);
  }
});

test('the answers do not change: any spelling of the company, case aside', () => {
  add('a1', { company: 'Acme Robotics', title: 'Mechanical Engineer', status: 'applied', applied_at: '2026-10-01', status_changed_at: '2026-10-01' });
  add('a2', { company: 'ACME ROBOTICS', title: 'Test Engineer', status: 'hidden', status_changed_at: '2026-10-02' });
  add('a3', { company: 'acme robotics', title: 'Design Engineer', status: 'new', pick_note: 'Not curated — wrong field: test only.', status_changed_at: '2026-10-03' });
  add('a4', { company: 'Other Co', title: 'Mechanical Engineer', status: 'applied', applied_at: '2026-10-01' });
  const prior = priorRows(db, { id: 'new1', company: 'Acme Robotics' }).map((r) => r.title).sort();
  assert.deepEqual(prior, ['Mechanical Engineer', 'Test Engineer'], 'what he did there, however the name is cased');
  const down = turnedDownAt(db, { id: 'new1', company: 'ACME robotics' }).map((r) => r.title);
  assert.deepEqual(down, ['Design Engineer']);
});
