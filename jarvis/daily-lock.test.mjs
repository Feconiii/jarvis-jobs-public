// jarvis/daily-lock.test.mjs — one daily search at a time, and a run that cannot start says so (review of fresh-lane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { takeDailyLock, liveHolder, dailyLockPath, SKIPPED_FOR_LOCK } from './daily-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-daily-lock-'));
const file = dailyLockPath(dir);

// A fake clock: sleeping moves time on, and the holder can end at a chosen moment.
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('a scheduled run waits for a live holder and starts when it ends', async () => {
  writeFileSync(file, '111');
  const c = clock();
  const isAlive = (pid) => pid === 111 && c.now() < 5 * 60_000;     // the other run ends after 5 min
  const r = await takeDailyLock(file, { self: 222, isAlive, ...c });
  assert.deepEqual(r, { ok: true, stale: 111 });
  assert.equal(readFileSync(file, 'utf8'), '222');
  assert.ok(c.now() >= 5 * 60_000 && c.now() < 6 * 60_000, 'it waited about as long as the other run took');
});

test('a scheduled run gives up after 20 minutes on a holder that never ends', async () => {
  writeFileSync(file, '111');
  const c = clock();
  const r = await takeDailyLock(file, { self: 222, isAlive: (p) => p === 111, ...c });
  assert.deepEqual(r, { ok: false, held: 111 });
  assert.equal(c.now(), 20 * 60_000);
  assert.equal(readFileSync(file, 'utf8'), '111', 'the holder keeps its lock');
});

test('a trigger does not wait; a dead holder\'s lock is taken over and named', async () => {
  writeFileSync(file, '111');
  const c = clock();
  assert.deepEqual(await takeDailyLock(file, { trigger: true, self: 222, isAlive: () => true, ...c }), { ok: false, held: 111 });
  assert.equal(c.now(), 0);
  assert.deepEqual(await takeDailyLock(file, { self: 222, isAlive: () => false, ...c }), { ok: true, stale: 111 });
  assert.equal(liveHolder(file, { self: 222, isAlive: () => true }), null, 'our own pid is not another holder');
});

test('the command: a trigger that finds a live lock writes a skipped line and exits with its own code', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'jarvis-daily-lock-cli-'));
  writeFileSync(dailyLockPath(data), String(process.pid));   // this test process is alive
  const r = spawnSync(process.execPath, [path.join(HERE, 'curate.mjs'), '--daily', '--want', '10', '--target', '50', '--trigger', 'new postings read: 2', '--max-file', '10', '--days', '3'],
    { cwd: path.join(HERE, '..'), env: { ...process.env, JARVIS_DATA_DIR: data, JARVIS_DB_PATH: '' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, SKIPPED_FOR_LOCK, r.stderr);
  const log = path.join(data, 'curate-daily.jsonl');
  assert.ok(existsSync(log), 'an outcome line was written');
  const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
  assert.deepEqual([line.skipped, line.heldBy, line.trigger], [true, process.pid, 'new postings read: 2']);
  assert.match(line.why, new RegExp(`lock held by pid ${process.pid}`));
  assert.equal(readFileSync(dailyLockPath(data), 'utf8'), String(process.pid), 'the lock is left with its holder');
});

test('two claims at once: exactly one gets the lock (atomic, review 2026-11-04)', async () => {
  const f2 = dailyLockPath(mkdtempSync(path.join(tmpdir(), 'jarvis-daily-lock-race-')));
  const both = await Promise.all([1001, 1002].map((self) => takeDailyLock(f2, { trigger: true, self, isAlive: () => true })));
  assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both));
  const winner = both.findIndex((r) => r.ok) === 0 ? 1001 : 1002;
  assert.equal(readFileSync(f2, 'utf8'), String(winner), 'the file names the one that has it');
});
