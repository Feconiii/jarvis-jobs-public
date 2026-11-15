// F-1027: the home tiles kept across a restart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeOverviewCache, writeKept, readKept, looksKept, KEPT_VERSION } from './overview-cache.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-ov-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const heavy = (n) => ({ stat: { total: n }, blockReasons: {}, bySource: {}, byCompanyCounts: {}, watchlistCompanies: [], byAdapter: {}, applyRuns: [], storage: {} });
const kept = (n, at = '2026-11-06T18:00:00.000Z') => ({ v: KEPT_VERSION, at, heavy: heavy(n) });
const never = () => new Promise(() => {});

test('a restart answers at once from the kept count, with its time, while the worker counts again', async () => {
  const file = path.join(dir, 'kept.json');
  writeKept(file, kept(41));
  const cache = makeOverviewCache({ file, recount: never });   // the worker is still counting
  const t = Date.now();
  const got = await cache.get();
  assert.ok(Date.now() - t < 200, 'no wait for the recount');
  assert.equal(got.heavy.stat.total, 41);
  assert.equal(got.asOf, '2026-11-06T18:00:00.000Z');
});

test('a recount is kept on disk with its version, and the next start reads it', async () => {
  const file = path.join(dir, 'fresh.json');
  let n = 0;
  const cache = makeOverviewCache({ file, recount: async () => heavy(++n), now: () => Date.parse('2026-11-06T19:00:00.000Z') });
  assert.equal((await cache.get()).heavy.stat.total, 1, 'no kept file: the first one waits once');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([onDisk.v, onDisk.at, onDisk.heavy.stat.total], [KEPT_VERSION, '2026-11-06T19:00:00.000Z', 1]);
  const next = makeOverviewCache({ file, recount: never });
  assert.equal((await next.get()).heavy.stat.total, 1);
});

test('a corrupt, half-written, wrong-shaped, unversioned or other-version file is not trusted: the first request waits once, as before', async () => {
  const noCompanies = kept(1); delete noCompanies.heavy.byCompanyCounts;
  const textStat = kept(1); textStat.heavy.stat.total = 'many';
  const cases = [
    ['corrupt', '{"v":1,"at":"2026-11-06T18:00:00.000Z","heavy":{"st'],
    ['shape', '{"v":1,"at":"yesterday","heavy":{}}'],
    ['empty', ''],
    ['unversioned', JSON.stringify({ at: '2026-11-06T18:00:00.000Z', heavy: heavy(1) })],
    ['other-version', JSON.stringify({ ...kept(1), v: KEPT_VERSION + 1 })],
    ['a field missing', JSON.stringify(noCompanies)],
    ['a count that is not a number', JSON.stringify(textStat)],
  ];
  for (const [name, body] of cases) {
    const file = path.join(dir, `${name.replace(/\W+/g, '-')}.json`);
    writeFileSync(file, body);
    const cache = makeOverviewCache({ file, recount: async () => heavy(7) });
    assert.equal((await cache.get()).heavy.stat.total, 7, name);
  }
  assert.equal(readKept(path.join(dir, 'missing.json')), null);
  assert.equal(looksKept(kept(3)), true, 'the shape the server writes is trusted');
});

test('the file is written whole or not at all (a temp file, then a rename)', () => {
  const file = path.join(dir, 'atomic.json');
  writeKept(file, kept(1));
  writeKept(file, kept(2, '2026-11-06T18:10:00.000Z'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).heavy.stat.total, 2);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('atomic.json.') && f.endsWith('.tmp')), [], 'no temp file left behind');
  // A write that cannot happen leaves the old file as it was.
  const blocked = path.join(dir, 'blocked.json');
  writeKept(blocked, kept(3));
  const circular = { v: KEPT_VERSION, at: '2026-11-06T18:20:00.000Z' }; circular.heavy = circular;
  assert.throws(() => writeKept(blocked, circular));
  assert.equal(JSON.parse(readFileSync(blocked, 'utf8')).heavy.stat.total, 3);
  assert.equal(existsSync(`${blocked}.${process.pid}.tmp`), false);
});

test('a rename Windows refuses for a moment (EPERM/EBUSY) is tried again; one that keeps failing leaves the old file and no temp', () => {
  const file = path.join(dir, 'locked.json');
  writeKept(file, kept(1));
  let refusals = 2;
  const flaky = (a, b) => { if (refusals-- > 0) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } renameSync(a, b); };
  writeKept(file, kept(2), { rename: flaky, waitMs: 1 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).heavy.stat.total, 2, 'written on the third try');
  const always = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
  assert.throws(() => writeKept(file, kept(3), { rename: always, waitMs: 1 }), /busy/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).heavy.stat.total, 2, 'the old file stands');
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
  const other = () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; };
  let tries = 0;
  assert.throws(() => writeKept(file, kept(4), { rename: (a, b) => { tries += 1; other(a, b); }, waitMs: 1 }), /no space/);
  assert.equal(tries, 1, 'only a lock is worth waiting out');
});

test('one recount at a time, and a failed recount keeps the last answer', async () => {
  const file = path.join(dir, 'once.json');
  writeKept(file, kept(5));
  let calls = 0; let fail = false;
  const cache = makeOverviewCache({ file, recount: async () => { calls += 1; if (fail) throw new Error('worker exited'); return heavy(6); } });
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(calls, 1);
  fail = true;
  await assert.rejects(cache.refresh(), /worker exited/);
  assert.equal((await cache.get()).heavy.stat.total, 6, 'the last good count stays');
});

test('his own writes ask for ONE recount, 30 s after the last of them', async () => {
  const timers = [];
  let calls = 0;
  const cache = makeOverviewCache({ recount: async () => { calls += 1; return heavy(calls); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
  cache.soon(); cache.soon(); cache.soon();
  const live = timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1, 'a burst of writes is one recount');
  assert.equal(live[0].ms, 30_000);
  live[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});

test('code review #6: a recount that began before his write does not answer it — the store is counted again after it', async () => {
  const timers = [];
  const runs = [];   // each recount, resolved by hand
  const cache = makeOverviewCache({ recount: () => new Promise((resolve) => runs.push(resolve)),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } });
  const tick = () => new Promise((r) => setImmediate(r));
  const early = cache.refresh();          // the 10-minute timer's recount, begun before his click
  await tick();
  assert.equal(runs.length, 1);
  cache.soon();                           // his click
  timers.filter((t) => !t.cleared)[0].fn();   // 30 s later, while the early one still runs
  await tick();
  assert.equal(runs.length, 1, 'one recount at a time');
  runs[0](heavy(1));                      // the early one ends: it counted the store without his click
  await early; await tick(); await tick();
  assert.equal(runs.length, 2, 'so the store is counted again');
  runs[1](heavy(2));
  await tick(); await tick();
  assert.equal((await cache.get()).heavy.stat.total, 2, 'the tiles show his click');
  // A recount that began AFTER his write answers it: no third.
  cache.soon();
  const p = cache.refresh();
  timers.filter((t) => !t.cleared).at(-1).fn();
  await tick();
  runs[2](heavy(3)); await p; await tick(); await tick();
  assert.equal(runs.length, 3);
});

test('code review #7: a header count his click overtook is not shown, even when the kept totals name no write count', async () => {
  const { countOvertaken } = await import('./overview-cache.mjs');
  // His click landed while the worker counted (writes 4 → 5): too old to show.
  assert.equal(countOvertaken({ have: true, startedAt: '4', nowWrites: '5', overtaken: 0 }), true);
  // Nothing of his since it began: shown.
  assert.equal(countOvertaken({ have: true, startedAt: '5', nowWrites: '5', overtaken: 0 }), false);
  // Nothing to show instead (the first count after a boot with no kept file): shown.
  assert.equal(countOvertaken({ have: false, startedAt: '4', nowWrites: '5', overtaken: 0 }), false);
  // Overtaken three times in a row: shown, so a busy store still gets totals.
  assert.equal(countOvertaken({ have: true, startedAt: '4', nowWrites: '5', overtaken: 3 }), false);
  // The server: the guard no longer depends on the kept totals naming a write count.
  const src = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function refreshHeavyCounts()'), src.indexOf('async function heavyCountsReady()'));
  assert.match(body, /countOvertaken\(\{ have: !!heavyTotals, startedAt: ours, nowWrites: ownWrites\(\), overtaken: heavyOvertaken \}\)/);
  assert.doesNotMatch(body, /heavyTotals\.ours !== null/);
});

test('an answer the page cannot be built from is dropped and counted again', async () => {
  let n = 10;
  const cache = makeOverviewCache({ recount: async () => heavy(++n) });
  assert.equal((await cache.get()).heavy.stat.total, 11);
  cache.drop();
  assert.equal(cache.asOf(), null);
  assert.equal((await cache.get()).heavy.stat.total, 12);
});

test('the server answers the Overview from this cache: no recount per request, a fallback when the kept one fails, and his writes recount soon', async () => {
  const src = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  assert.match(src, /makeOverviewCache\(\{\s*file: path\.join\(STORE_DIR, 'overview-heavy\.json'\)/);
  const body = src.slice(src.indexOf('async function overviewNow()'), src.indexOf('function assembleOverview('));
  assert.match(body, /OV_CACHE\.get\(\)/);
  assert.match(body, /asOf/);
  assert.doesNotMatch(body, /refreshOverviewHeavy|60_000/, 'a request never starts a recount');
  assert.match(body, /catch \(e\)[\s\S]*OV_CACHE\.drop\(\)/, 'a kept answer that fails is counted again');
  assert.match(src, /if \(seen !== null && now !== seen\) OV_CACHE\.soon\(\)/, 'his writes ask for a recount');
});

test('F-1030: no boot recount over a kept answer under an hour old; otherwise one, 5 minutes after boot', async () => {
  const { bootRecountDelay } = await import('./overview-cache.mjs');
  const now = Date.parse('2026-11-07T08:00:00Z');
  assert.equal(bootRecountDelay({ asOf: '2026-11-07T07:16:19Z', now }), null, '44 minutes old: shown as it is');
  assert.equal(bootRecountDelay({ asOf: '2026-11-07T06:59:00Z', now }), 300_000, 'over an hour old: recounted 5 minutes after boot');
  assert.equal(bootRecountDelay({ asOf: null, now }), 300_000, 'nothing kept');
  assert.equal(bootRecountDelay({ asOf: 'not a date', now }), 300_000);
  assert.equal(bootRecountDelay({ asOf: '2026-11-07T09:00:00Z', now }), 300_000, 'a kept time in the future is not trusted');
});
