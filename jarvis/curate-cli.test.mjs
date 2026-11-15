// jarvis/curate-cli.test.mjs — the daily search, run the way the scheduled task runs it (F-986).
//
// The 2026-11-04 6:30 AM run, the first with --topup, never finished: "unsettled
// top-level await" and no line in curate-daily.jsonl. The command's code ran as
// curate.mjs's own top-level await, and the top-up path loads library-screen.mjs
// (and the reader sponsor-prior.mjs), which import curate.mjs back: each waited
// for the other to finish loading. Importing daily() in a test cannot see that,
// so this spawns the real command against an empty temp store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'curate.mjs');

function runDaily(dir, extra = []) {
  return spawnSync(process.execPath, [CLI, '--daily', '--want', '20', '--target', '0', '--topup', ...extra],
    { cwd: path.join(HERE, '..'), env: { ...process.env, JARVIS_DATA_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
}
const lines = (dir) => readFileSync(path.join(dir, 'curate-daily.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the top-up path runs to the end as a command and logs its outcome', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-daily-cli-'));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ dailyTopUp: 3 }));
  const r = runDaily(dir);
  assert.equal(r.error, undefined, `the command did not finish: ${r.error?.message}`);
  assert.doesNotMatch(r.stderr, /unsettled top-level await/i);
  assert.equal(r.status, 0, r.stderr);
  const last = lines(dir).at(-1);
  assert.equal(last.goal, 3, 'target 0 + top-up 3: the full-inbox top-up path');
  assert.equal(last.filed, 0, 'an empty store has nothing to file');
  assert.equal(last.error, undefined);
  assert.match(r.stdout, /daily search: 0 open, goal 3 \(top-up 3: 0 filed\)/);
  assert.equal(existsSync(path.join(dir, 'curate-daily.lock')), false, 'the lock is released');
});

// A Jarvis module loaded first, in a fresh process, against `dir`; prints what `body` returns.
function fresh(file, body, dir) {
  const url = new URL(file, import.meta.url).href;
  const code = `import(${JSON.stringify(url)}).then(async (m) => { process.stdout.write(JSON.stringify(await (${body})(m))); })`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(HERE, '..'), env: { ...process.env, JARVIS_DATA_DIR: dir }, encoding: 'utf8', timeout: 30_000 });
}

test('each module in the loop finishes loading when it is loaded first (F-986 follow-up)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-load-'));
  // The loop itself is gone: nothing curate.mjs loads during a run imports it back.
  for (const f of ['library-screen.mjs', 'sponsor-prior.mjs', 'employer-names.mjs', 'employer-taste.mjs', 'enrich.mjs']) {
    assert.doesNotMatch(readFileSync(path.join(HERE, f), 'utf8'), /from '\.\/curate\.mjs'|import\('\.\/curate\.mjs'\)/, `${f} imports curate.mjs again`);
  }
  for (const f of ['./curate.mjs', './library-screen.mjs', './sponsor-prior.mjs', './employer-names.mjs', './employer-taste.mjs']) {
    const r = fresh(f, '(m) => Object.keys(m).length', dir);
    assert.equal(r.error, undefined, `${f} did not finish loading`);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.ok(Number(r.stdout) > 0, `${f} exported nothing`);
  }
});

test('the taste rule counts the Department\'s engineering petitions, not the ledger\'s evidence (his call, 2026-11-04)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-dol-taste-'));
  const h = new DatabaseSync(path.join(dir, 'jobs.db'));
  h.exec('CREATE TABLE jobs (id TEXT, company TEXT); CREATE TABLE lca_employers (key TEXT, name TEXT, eng_certified INTEGER)');
  const job = h.prepare('INSERT INTO jobs VALUES (?, ?)');
  // The live store's sizes, 2026-11-04: HP Inc. 2,507 postings, Cummins 2,019.
  for (let i = 0; i < 2500; i++) job.run(`hp${i}`, 'HP Inc.');
  for (let i = 0; i < 2000; i++) job.run(`cu${i}`, 'Cummins Inc.');
  const filer = h.prepare('INSERT INTO lca_employers VALUES (?, ?, ?)');
  for (const [n, c] of [['HP Inc.', 7], ['CUMMINS INC.', 324]]) filer.run(n.toLowerCase(), n, c);
  h.close();
  const r = fresh('./curate.mjs', `(m) => ['HP Inc.', 'Cummins Inc.'].map((c) => [m.dolCount(c), m.employerVerdict({ company: c, title: 'Manufacturing Engineer' }, 'we build things')])`, dir);
  assert.equal(r.status, 0, r.stderr);
  const [[hpN, hp], [cuN, cu]] = JSON.parse(r.stdout);
  assert.equal(hpN, 7);
  assert.match(hp, /almost no H-1B record \(7 engineering petitions on file against 2500 postings\)/);
  assert.equal(cuN, 324);
  assert.equal(cu, null, 'a big name that sponsors at its size is read');
  // No disclosure file loaded: the count says nothing and the rule does not turn anyone down on it.
  const none = fresh('./curate.mjs', `(m) => [m.dolCount('HP Inc.'), m.employerVerdict({ company: 'HP Inc.', title: 'Manufacturing Engineer' }, 'x')]`, mkdtempSync(path.join(tmpdir(), 'jarvis-dol-none-')));
  assert.deepEqual(JSON.parse(none.stdout), [null, null]);
});

test('a dead run\'s lock leaves one {error} line, and none when its pid already has one', async () => {
  const { staleLockLine } = await import('./curate.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-stale-'));
  const file = path.join(dir, 'curate-daily.jsonl');
  writeFileSync(file, `${JSON.stringify({ at: '2026-11-04T17:00:00Z', filed: 3 })}\n`);
  assert.equal(staleLockLine(37592, { file }), true);
  const last = lines(dir).at(-1);
  assert.equal(last.error, 'the previous run (pid 37592) ended without an outcome (killed)');
  assert.equal(last.pid, 37592);
  assert.equal(staleLockLine(37592, { file }), false, 'the backstop (or an earlier takeover) already wrote it');
  assert.equal(lines(dir).length, 2);
});

test('a run that crashes still leaves an outcome line, with the reason', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-daily-cli-'));
  // A store file that is not a database: opening it throws.
  writeFileSync(path.join(dir, 'jobs.db'), 'not a database');
  const r = runDaily(dir);
  assert.notEqual(r.status, 0);
  const last = lines(dir).at(-1);
  assert.ok(last.error, 'an {error} line for the health alarm');
  assert.equal(last.code, r.status);
});
