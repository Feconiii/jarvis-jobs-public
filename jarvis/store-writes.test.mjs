// jarvis/store-writes.test.mjs — writes that used to bypass the store module, through it (F-968).
//
// Each runs against a temp store: JARVIS_DATA_DIR is set before store.mjs is loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-store-writes-'));
process.env.JARVIS_DATA_DIR = dir;
delete process.env.JARVIS_DB_PATH;
const store = await import('./store.mjs');
assert.equal(path.resolve(store.dbPath()), path.resolve(dir, 'jobs.db'), 'the test store, never his');
// …and under the system temp folder, whatever JARVIS_DATA_DIR was before (F-968 review follow-up).
assert.ok(path.resolve(store.dbPath()).toLowerCase().startsWith(path.resolve(tmpdir()).toLowerCase()), `the store is under ${tmpdir()}`);

const add = (id, extra = {}) => {
  const row = { id, url: `https://x.test/${id}`, title: 'Engineer', company: 'Acme', status: 'new', first_seen: '2026-11-01', last_seen: '2026-11-04', ...extra };
  const cols = Object.keys(row);
  store.db().prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
};
const col = (id, c) => store.db().prepare(`SELECT ${c} AS v FROM jobs WHERE id = ?`).get(id)?.v;

test('code review #4: foldCopy undoes the carried decision and notes when the store refuses the pointer (serve page fold)', () => {
  // He applied from the LinkedIn copy (it holds the application record); the
  // page's own row has none, so the store will not hide the copy behind it.
  add('li-applied', { source: 'linkedin', status: 'applied', status_changed_at: '2026-10-01T09:00:00.000Z', applied_at: '2026-10-01T09:00:00.000Z', pick_note: 'inbox reason', user_note: 'his note' });
  add('page-row', { status: 'new' });
  const col = (id, c) => store.db().prepare(`SELECT ${c} AS v FROM jobs WHERE id = ?`).get(id)?.v;
  const folded = store.foldCopy('li-applied', 'page-row', { status: 'applied', changedAt: '2026-10-01T09:00:00.000Z', note: 'inbox reason', userNote: 'his note' });
  assert.equal(folded, false, 'the pointer was refused');
  assert.equal(col('li-applied', 'superseded_by'), null, 'the copy stays visible');
  assert.equal(col('page-row', 'status'), 'new', 'the carried status was taken back');
  assert.equal(col('page-row', 'status_changed_at'), null);
  assert.equal(col('page-row', 'pick_note'), null, 'and the notes, or the posting shows twice with them');
  assert.equal(col('page-row', 'user_note'), null);
  // A fold the store allows: carried and pointed.
  add('li-inbox', { source: 'linkedin', status: 'inbox', status_changed_at: '2026-10-02T09:00:00.000Z', pick_note: 'why' });
  add('page-row2', { status: 'new' });
  assert.equal(store.foldCopy('li-inbox', 'page-row2', { status: 'inbox', changedAt: '2026-10-02T09:00:00.000Z', note: 'why' }), true);
  assert.equal(col('li-inbox', 'superseded_by'), 'page-row2');
  assert.equal(col('page-row2', 'status'), 'inbox');
  assert.equal(col('page-row2', 'pick_note'), 'why');
  store.clearPointer('li-inbox');   // the pointer tests below count every pointer in this store
  // The page fold goes through it.
  const serve = readFileSync(path.join(HERE, 'serve.mjs'), 'utf8');
  assert.match(serve, /foldCopy\(r\.id, String\(job\.id\), carry\)/);
  assert.doesNotMatch(serve, /carryDecision\(String\(job\.id\)/, 'no carry that a refusal leaves behind');
});

test('carryDecision gives the page\'s row his decision on its copy, with its date, and a note only where none is (serve page fold)', () => {
  add('pg1'); add('pg2', { pick_note: 'his own note' });
  assert.equal(store.carryDecision('pg1', { status: 'inbox', changedAt: '2026-10-20T09:00:00.000Z', note: 'the copy\'s reason' }), true);
  assert.deepEqual([col('pg1', 'status'), col('pg1', 'status_changed_at'), col('pg1', 'pick_note')], ['inbox', '2026-10-20T09:00:00.000Z', 'the copy\'s reason']);
  assert.equal(store.carryDecision('pg2', { status: 'applied', note: 'the copy\'s reason' }), true);
  assert.equal(col('pg2', 'pick_note'), 'his own note', 'a row\'s own note is kept');
  assert.ok(Date.now() - Date.parse(col('pg2', 'status_changed_at')) < 60_000, 'no date on the copy: now');
  assert.throws(() => store.carryDecision('pg1', { status: 'bogus' }), /invalid status/);
  assert.equal(store.carryDecision('nobody', { status: 'inbox' }), false);
});

test('isStoreFile names this store however it is spelled, and nothing else (mail, curate)', () => {
  store.db();   // the file exists, so its real path is read
  const real = path.resolve(store.dbPath());
  assert.equal(store.isStoreFile(real), true);
  if (process.platform === 'win32') assert.equal(store.isStoreFile(real.replace(/\\/g, '/').toUpperCase()), true);
  assert.equal(store.isStoreFile(path.join(dir, 'other.db')), false);
  assert.equal(store.isStoreFile(''), false);
});

test('copy pointers: point, keep an existing one, clear only while it points there, clear all', () => {
  add('p1'); add('p2'); add('p3');
  assert.equal(store.pointAt('p1', 'p2'), true);
  assert.equal(col('p1', 'superseded_by'), 'p2');
  assert.equal(store.pointAt('p1', 'p3', { onlyIfUnset: true }), false, 'a row that already points somewhere is left');
  assert.equal(store.pointAt('p1', 'p1'), false, 'never at itself');
  assert.equal(store.clearPointer('p1', { from: 'p3' }), false, 'it points at p2, not p3');
  assert.equal(store.clearPointer('p1', { from: 'p2' }), true);
  assert.equal(col('p1', 'superseded_by'), null);
  store.pointAt('p1', 'p2'); store.pointAt('p3', 'p2');
  assert.equal(store.clearAllPointers(), 2);
});

test('a carried status gets today\'s date; an undo puts back the exact status and date, null included', () => {
  add('s1', { status: 'new', status_changed_at: null });
  assert.equal(store.setStatus('s1', 'applied'), true);
  assert.ok(Date.now() - Date.parse(col('s1', 'status_changed_at')) < 60_000, 'status_changed_at is now');
  assert.equal(store.restoreStatus('s1', 'new', null), true);
  assert.deepEqual([col('s1', 'status'), col('s1', 'status_changed_at')], ['new', null]);
  assert.equal(store.restoreStatus('s1', 'inbox', '2026-10-01T12:00:00.000Z'), true);
  assert.equal(col('s1', 'status_changed_at'), '2026-10-01T12:00:00.000Z');
  assert.throws(() => store.restoreStatus('s1', 'nonsense', null), /invalid status/);
});

test('dedupe writes its pointers through the store, journalled, and its undo reverses them', async () => {
  const { pointCopies, clearPointers } = await import('./dedupe.mjs');
  add('c1', { company: 'Acme', title: 'Mechanical Engineer' }); add('k1', { company: 'Acme', title: 'Mechanical Engineer' });
  add('c2', { company: 'Acme', title: 'Mechanical Engineer' });
  const { pointed, runId } = await pointCopies([{ stale: 'c1', keep: 'k1' }, { stale: 'c2', keep: 'k1' }], { write: true, log: () => {} });
  assert.equal(pointed, 2);
  assert.deepEqual([col('c1', 'superseded_by'), col('c2', 'superseded_by')], ['k1', 'k1']);
  const journal = readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8');
  assert.match(journal, new RegExp(runId.replace(/[.]/g, '\\.')), 'the run is in the journal, so it can be undone');
  assert.equal((await clearPointers([{ stale: 'c2', keep: 'k1' }], { write: true, log: () => {} })).cleared, 1);
  assert.equal(col('c2', 'superseded_by'), null);
  // The undo is dedupe's own command, against this store.
  store.closeDb();
  const r = spawnSync(process.execPath, [path.join(HERE, 'dedupe.mjs'), '--undo', runId], { cwd: path.join(HERE, '..'), env: { ...process.env, JARVIS_DATA_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /undid dedupe run/);
  assert.equal(col('c1', 'superseded_by'), null, 'the pointer the run set is gone');
});

test('removeUntouched takes a disabled board\'s untouched rows and their bodies, never one he acted on (disable-board)', async () => {
  add('u1', { company: 'Gone Co' }); add('u2', { company: 'Gone Co', status: 'hidden' }); add('u3', { company: 'Gone Co' });
  const h = store.db();
  for (const id of ['u1', 'u2']) {
    h.prepare('INSERT INTO descriptions (id, codec, blob, len) VALUES (?, ?, ?, ?)').run(id, 'raw', Buffer.from('body'), 4);
    h.prepare('INSERT INTO details (id, codec, blob) VALUES (?, ?, ?)').run(id, 'raw', Buffer.from('{}'));
  }
  assert.equal(await store.removeUntouched(['u1', 'u2', 'u3', 'nobody']), 2, 'u1 and u3; u2 is his');
  const has = (t, id) => !!h.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id);
  assert.deepEqual([has('jobs', 'u1'), has('descriptions', 'u1'), has('details', 'u1'), has('jobs', 'u3')], [false, false, false, false]);
  assert.deepEqual([has('jobs', 'u2'), has('descriptions', 'u2'), has('details', 'u2')], [true, true, true], 'a row he acted on keeps everything');
});

test('sponsors_h1b comes from the disclosure links through the store, and lca-import --relink writes it (F-968 4/5)', () => {
  const relink = () => {
    store.closeDb();
    const r = spawnSync(process.execPath, [path.join(HERE, 'lca-import.mjs'), '--relink'], { cwd: path.join(HERE, '..'), env: { ...process.env, JARVIS_DATA_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.match(relink(), /nothing loaded to link against/, 'the first run creates the tables');
  add('a1', { company: 'Acme Robotics' }); add('a2', { company: 'Acme Robotics' }); add('o1', { company: 'Old Co' }); add('n1', { company: 'Nobody Inc', sponsors_h1b: 1 });
  const h = store.db();
  const filer = h.prepare('INSERT INTO lca_employers (key, name, certified, last_decision) VALUES (?, ?, ?, ?)');
  filer.run('acme robotics', 'Acme Robotics Inc', 12, '2026-06-01');
  filer.run('old co', 'Old Co LLC', 3, '2020-01-01');
  assert.match(relink(), /relinked \d+ companies/);
  assert.deepEqual(['a1', 'a2', 'o1', 'n1'].map((id) => col(id, 'sponsors_h1b')), [1, 1, 0, 0],
    'a recent filer sponsors; a stale one does not; a company linked to no filer is set back to 0');
  // The writer on its own: an older cutoff counts Old Co's 2020 filings.
  assert.ok(store.writeSponsorsFromLinks({ since: '2019-01-01' }) >= 4);
  assert.equal(col('o1', 'sponsors_h1b'), 1);
});

test('setApplyRoute writes the route LinkedIn states, under the store lock (curate, linkedin-route)', async () => {
  add('li1');
  assert.equal(await store.setApplyRoute('li1', 'easy-apply'), true);
  assert.equal(col('li1', 'apply_route'), 'easy-apply');
  assert.equal(await store.setApplyRoute('li1', 'offsite'), true);
  assert.equal(col('li1', 'apply_route'), 'offsite');
  assert.equal(await store.setApplyRoute('nobody', 'closed'), false, 'no row, nothing written');
  await assert.rejects(() => store.setApplyRoute('li1', 'maybe'), /invalid apply route/);
  assert.equal(col('li1', 'apply_route'), 'offsite', 'a bad value changes nothing');
});

test('removeUntouched also clears a copy\'s pointer at a removed row (F-968 review follow-up)', async () => {
  add('rk1', { company: 'Gone Two' }); add('rc1', { company: 'Gone Two', status: 'inbox', superseded_by: 'rk1' });
  add('rk2', { company: 'Kept Co' }); add('rc2', { company: 'Kept Co', superseded_by: 'rk2' });
  assert.equal(await store.removeUntouched(['rk1']), 1);
  assert.equal(col('rc1', 'superseded_by'), null, 'its copy is shown again as itself');
  assert.equal(col('rc2', 'superseded_by'), 'rk2', 'a pointer at a row still there is left');
});

test('a route writer refused for another jobs.db says so once; any other file says nothing (F-968 review follow-up)', async () => {
  const { storeRouteWriter, resetRouteWriterWarning } = await import('./curate.mjs');
  resetRouteWriterWarning();
  const said = [];
  const warn = (m) => said.push(m);
  const other = path.join(tmpdir(), 'another-checkout', 'data', 'jarvis', 'jobs.db');
  assert.equal(await storeRouteWriter(other, { warn }), null);
  assert.equal(await storeRouteWriter(other, { warn }), null);
  assert.equal(said.length, 1, 'once per run');
  assert.match(said[0], /apply routes not recorded/);
  resetRouteWriterWarning();
  assert.equal(await storeRouteWriter(path.join(tmpdir(), 'fixture.db'), { warn }), null);
  assert.equal(said.length, 1, 'a test fixture with another name is not a store');
  assert.equal(await storeRouteWriter(store.dbPath(), { warn }), store.setApplyRoute, 'the store itself gets its writer, no word');
  assert.equal(said.length, 1);
});

test('F-1007: a status set through updateJob keeps the date it is given (the after-Submit mark)', () => {
  store.upsertJobs([{ url: 'https://boards.greenhouse.io/acme/jobs/1007', title: 'Mechanical Engineer', company: 'Acme' }], '2026-10-01T00:00:00.000Z');
  const id = store.jobId('https://boards.greenhouse.io/acme/jobs/1007');
  store.setStatus(id, 'inbox');
  const at = new Date().toISOString();
  store.updateJob(id, { status: 'applied', statusChangedAt: at });
  const j = store.getJob(id);
  assert.equal(j.status, 'applied');
  assert.equal(j.statusChangedAt, at, 'the card reads applied today, not the day it was filed');
});
