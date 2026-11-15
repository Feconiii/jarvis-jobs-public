// jarvis/curate-trigger.test.mjs — the dashboard's read of new postings (C, 2026-11-04):
// capped, new postings only, and its outcome line says it was a trigger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JARVIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-trigger-'));
delete process.env.JARVIS_DB_PATH;
const { daily, topUpToday } = await import('./curate.mjs');

// A pool of new postings and a reader that keeps everything it is given, up to stopAfter.
const rig = () => {
  const calls = { pool: [], library: 0, lines: [] };
  let n = 0;
  const pool = (_db, o) => { calls.pool.push(o); return Array.from({ length: o.limit }, () => ({ id: `j${++n}`, company: `Co ${n}`, title: 'Mechanical Engineer' })); };
  const library = async (_db, o) => { calls.library++; return Array.from({ length: o.limit }, () => ({ id: `l${++n}`, company: `Lib ${n}`, title: 'Mechanical Engineer' })); };
  const run = async ({ candidates, stopAfter }) => {
    const kept = candidates.slice(0, stopAfter).map((c) => ({ ...c, verdict: 'KEEP' }));
    return { kept, maybe: [], dropped: [], failed: [] };
  };
  return { calls, opts: { pool, library, run, log: (e) => calls.lines.push(e) } };
};

test('a trigger files at most --max-file, reads only the new-postings window, never the older windows or the library', async () => {
  const { calls, opts } = rig();
  const r = await daily({ ...opts, open: 30, want: 10, target: 50, trigger: 'new postings read: 4', maxFile: 10, days: 3 });
  assert.equal(r.filed, 10, 'room for 20, but a trigger files 10 at most');
  assert.ok(calls.pool.every((o) => o.days === 3), 'every read is inside the 3-day window');
  assert.ok(calls.pool.every((o) => o.days !== 120), 'not the 45-day-plus window');
  assert.equal(calls.library, 0, 'not the library');
  assert.equal(calls.lines.length, 1);
  assert.equal(calls.lines[0].trigger, 'new postings read: 4', 'health checks see it was a trigger');
});

test('a trigger with a full inbox and no top-up left files nothing and says so, as a trigger', async () => {
  const { calls, opts } = rig();
  const r = await daily({ ...opts, open: 67, want: 10, target: 50, trigger: 'new postings read: 2', maxFile: 10, days: 3, topUp: 20, topUpDay: { cap: 20, used: 20 } });
  assert.equal(r.noop, true);
  assert.equal(calls.pool.length, 0);
  assert.deepEqual([calls.lines[0].noop, calls.lines[0].trigger, calls.lines[0].topupToday], [true, 'new postings read: 2', { used: 20, cap: 20 }]);
  assert.match(calls.lines[0].why, /today's top-up \(20\) is spent/);
});

test('one top-up a day, shared: triggers and the two scheduled runs never file more than 20 past his target (first mate, 2026-11-04)', async () => {
  // His day, in local time: a trigger at 05:00, the 06:30 run, triggers at 09:00 and 13:00, the 16:10 run, a trigger at 20:00.
  const y = 2026, m = 10, d = 5;
  const day = [[5, 0, 'trigger'], [6, 30, 'scheduled'], [9, 0, 'trigger'], [13, 0, 'trigger'], [16, 10, 'scheduled'], [20, 0, 'trigger']];
  const lines = [{ at: new Date(y, m, d - 1, 16, 10).toISOString(), topup: 10 }];   // yesterday's run does not count
  const perRun = 10, open = 67, target = 50;
  for (const [h, min, kind] of day) {
    const now = new Date(y, m, d, h, min).getTime();
    const topUpDay = topUpToday(lines, { now, cap: 2 * perRun });
    const { opts } = rig();
    const r = await daily({ ...opts, open, target, want: kind === 'trigger' ? 10 : 20, topUpDay,
      topUp: kind === 'trigger' ? 2 * perRun : perRun,
      ...(kind === 'trigger' ? { trigger: 'new postings read: 3', maxFile: 10, days: 3 } : {}),
      log: (e) => lines.push({ ...e, at: new Date(now).toISOString() }) });
    assert.ok(r.topupToday, 'every line says the day\'s shared count');
  }
  const today = lines.slice(1);
  const total = today.reduce((n, e) => n + (e.topup || 0), 0);
  assert.equal(total, 20, 'the day files exactly the 20 it was allowed, no more');
  assert.deepEqual(today.map((e) => e.topup || 0), [10, 10, 0, 0, 0, 0], 'first come: the early trigger and the 06:30 run take it');
  assert.deepEqual(today.at(-1).topupToday, { used: 20, cap: 20 });
  assert.equal(topUpToday(lines, { now: new Date(y, m, d + 1, 6, 30).getTime(), cap: 20 }).left, 20, 'tomorrow starts full');
});

test('without a trigger nothing changes: no trigger field, no cap, the library read when topping up a full inbox', async () => {
  const { calls, opts } = rig();
  const r = await daily({ ...opts, open: 30, want: 20, target: 50 });
  assert.equal(r.filed, 20);
  assert.equal('trigger' in calls.lines[0], false);
  const b = rig();
  await daily({ ...b.opts, open: 67, target: 50, topUp: 10 });
  assert.equal(b.calls.library > 0, true, 'a scheduled top-up still reads the library');
});

test('no run fills past target plus what is left of the day\'s top-up (first mate, 2026-11-04: 45 open + want 20 was 65)', async () => {
  const a = rig();
  const r = await daily({ ...a.opts, open: 45, want: 20, target: 50, topUpDay: { cap: 20, used: 0 } });
  assert.deepEqual([r.goal, r.filed, r.refill, r.topup], [20, 20, 5, 15], 'five fill the room; the other 15 are top-up and counted');
  assert.deepEqual(r.topupToday, { used: 15, cap: 20 });
  const b = rig();
  const s = await daily({ ...b.opts, open: 45, want: 20, target: 50, topUp: 10, topUpDay: { cap: 20, used: 15 } });
  assert.deepEqual([s.goal, s.topup], [10, 5], 'with 5 left: the room plus 5, never 65 or 75');
  const c = rig();
  const t = await daily({ ...c.opts, open: 30, want: 20, target: 50, topUpDay: { cap: 20, used: 20 } });
  assert.deepEqual([t.goal, t.topup], [20, 0], 'room under target is always his; only what is past it is counted');
});
