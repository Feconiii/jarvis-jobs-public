// F-1032 review: the travelling-requisition answers and their worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeTravelLookup } from './travel-lookup.mjs';

/** A worker that answers what `answer(url)` says, when told to (or never). */
function fakeWorker({ answer = () => null, auto = true } = {}) {
  const w = new EventEmitter();
  w.posted = [];
  w.unref = () => {};
  w.postMessage = (m) => { w.posted.push(m); if (auto) setImmediate(() => w.emit('message', { seq: m.seq, id: answer(m.url), ms: 5 })); };
  w.reply = (i = 0, id = null) => w.emit('message', { seq: w.posted[i].seq, id, ms: 5 });
  return w;
}
const PAGE = 'https://www.acme.com/careers/job?gh_jid=7012345';
const WANT = 'greenhouse:7012345';

test('one lookup per key at a time: callers share it, and the answer is kept', async () => {
  let spawned = 0; let w;
  const found = [];
  const t = makeTravelLookup({ spawn: () => { spawned += 1; w = fakeWorker({ answer: () => 'gh-board', auto: false }); return w; }, onFound: (id) => found.push(id) });
  const a = t.lookup(PAGE, WANT); const b = t.lookup(PAGE, WANT);
  assert.equal(a, b, 'the same promise');
  assert.equal(w.posted.length, 1, 'one question to the worker');
  w.reply(0, 'gh-board');
  assert.deepEqual(await Promise.all([a, b]), ['gh-board', 'gh-board']);
  assert.equal(t.get(PAGE, WANT), 'gh-board');
  assert.deepEqual(found, ['gh-board'], 'a found answer is announced (serve clears its cached misses)');
  assert.equal(spawned, 1);
});

test('a "none" is kept 10 minutes, then asked again', async () => {
  let clock = 1000;
  const t = makeTravelLookup({ spawn: () => fakeWorker({ answer: () => null }), now: () => clock });
  assert.equal(await t.lookup(PAGE, WANT), null);
  assert.equal(t.get(PAGE, WANT), null);
  clock += 10 * 60_000 + 1;
  assert.equal(t.get(PAGE, WANT), undefined, 'stale: not asked');
});

test('a kept id whose row is gone is dropped (serve then asks again)', async () => {
  const t = makeTravelLookup({ spawn: () => fakeWorker({ answer: () => 'deleted-row' }) });
  await t.lookup(PAGE, WANT);
  assert.equal(t.get(PAGE, WANT), 'deleted-row');
  t.drop(PAGE, WANT);
  assert.equal(t.get(PAGE, WANT), undefined);
});

test('a lookup that gets no answer gives up, and its key is free again', async () => {
  let w;
  const t = makeTravelLookup({ spawn: () => { w = fakeWorker({ auto: false }); return w; }, timeoutMs: 30 });
  await assert.rejects(t.lookup(PAGE, WANT), /no answer in/);
  assert.deepEqual(t.sizes(), { kept: 0, pending: 0, waiting: 0 }, 'nothing pinned');
  const again = t.lookup(PAGE, WANT);
  assert.equal(w.posted.length, 2, 'asked afresh');
  w.reply(1, 'gh-board');
  assert.equal(await again, 'gh-board');
});

test('a worker that dies answers its waiters "not found", and none is started for the cooldown', async () => {
  let clock = 0; let spawned = 0; let w;
  const t = makeTravelLookup({ spawn: () => { spawned += 1; w = fakeWorker({ auto: false }); return w; }, now: () => clock, cooldownMs: 30_000 });
  const p = t.lookup(PAGE, WANT);
  w.emit('exit', 1);
  await assert.rejects(p);
  assert.deepEqual(t.sizes(), { kept: 0, pending: 0, waiting: 0 });
  clock += 1000;
  await assert.rejects(t.lookup(PAGE, WANT), /cooling down/);
  assert.equal(spawned, 1, 'no new worker during the cooldown');
  clock += 30_000;
  const q = t.lookup(PAGE, WANT);
  assert.equal(spawned, 2, 'after it, a new one');
  w.reply(0, 'gh-board');
  assert.equal(await q, 'gh-board');
});

test('an old worker\'s death does not touch its replacement', async () => {
  let clock = 0; const made = [];
  const t = makeTravelLookup({ spawn: () => { const w = fakeWorker({ auto: false }); made.push(w); return w; }, now: () => clock, cooldownMs: 10 });
  const p = t.lookup(PAGE, WANT);
  made[0].emit('error', new Error('boom'));
  await assert.rejects(p);
  clock += 20;
  const q = t.lookup('https://www.zeta.com/jobs?gh_jid=9999999', 'greenhouse:9999999');
  made[0].emit('exit', 1);   // the first worker's last word
  made[1].reply(0, 'zeta-row');
  assert.equal(await q, 'zeta-row', 'the replacement still answers');
});
