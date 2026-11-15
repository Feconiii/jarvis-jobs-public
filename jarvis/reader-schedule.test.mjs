// jarvis/reader-schedule.test.mjs — the reader is deferred by a scan, never dropped (F-999), and the
// new-postings trigger is capped (C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReaderSchedule, TRIGGER_GAP_MS } from './reader-schedule.mjs';

const rig = () => {
  const state = { scan: false, reader: false, t: 0, started: [], log: [] };
  const s = makeReaderSchedule({
    start: (job) => { state.started.push(job); state.reader = true; },
    scanRunning: () => state.scan, readerRunning: () => state.reader,
    log: (l) => state.log.push(l), now: () => state.t,
  });
  return { s, state };
};

test('a kick during a scan is deferred, said in the log, and the reader runs when the scan ends (F-999)', () => {
  const { s, state } = rig();
  state.scan = true;
  assert.equal(s.kick('every 6 h'), 'deferred');
  assert.equal(state.started.length, 0, 'nothing starts beside a scan');
  assert.match(state.log[0], /reader deferred \(every 6 h\): a scan is running/);
  assert.equal(s.kick('every 6 h'), 'deferred');
  assert.equal(state.log.length, 1, 'one line per deferral, not one per kick');
  assert.equal(s.scanEnded(), 'waiting', 'the poll while the scan still runs changes nothing');
  state.scan = false;
  assert.equal(s.scanEnded(), 'started');
  assert.deepEqual(state.started, [{ reason: 'every 6 h, after the wait', trigger: false }]);
  assert.match(state.log.at(-1), /reader starting/);
  assert.equal(s.pending(), null);
});

test('the startup case: the 20-minute kick inside the startup scan still runs once that scan ends', () => {
  const { s, state } = rig();
  state.scan = true;
  s.kick('20 minutes after start');
  state.scan = false;
  s.poll();   // a scan another process ran has no exit event: the poll finds its end
  assert.equal(state.started.length, 1);
});

test('no scan: the kick starts at once; a reader already running is left alone', () => {
  const { s, state } = rig();
  assert.equal(s.kick(), 'started');
  assert.equal(s.kick(), 'running');
  assert.equal(state.started.length, 1);
});

test('new-postings trigger: starts a capped read, at most one per 2 h, never beside a reader or scan (C)', () => {
  const { s, state } = rig();
  assert.equal(s.newBodies(0), 'none', 'no new bodies, no read');
  assert.equal(s.newBodies(3), 'started');
  assert.deepEqual(state.started[0], { reason: 'new postings read: 3', trigger: true });
  state.reader = false;
  state.t += TRIGGER_GAP_MS - 1;
  assert.equal(s.newBodies(5), 'too-soon');
  state.t += 1;
  state.reader = true;
  assert.equal(s.newBodies(5), 'deferred', 'one run at a time: it waits for the reader that is running');
  assert.equal(s.idle(), 'waiting');
  state.reader = false;
  state.scan = true;
  assert.equal(s.newBodies(5), 'deferred');
  state.scan = false;
  assert.equal(s.scanEnded(), 'started');
  assert.equal(state.started.length, 2);
  assert.equal(state.started[1].trigger, true);
});

test('a daily search this server did not start (the lock\'s live pid) is busy: kicks and triggers wait for it (review)', () => {
  const state = { other: true, started: [], log: [] };
  const s = makeReaderSchedule({
    start: (job) => state.started.push(job), scanRunning: () => false, readerRunning: () => false,
    otherReaderRunning: () => state.other, log: (l) => state.log.push(l), now: () => 0,
  });
  assert.equal(s.kick('every 6 h'), 'deferred');
  assert.equal(s.newBodies(4), 'deferred');
  assert.match(state.log[0], /another daily search is running/);
  assert.equal(s.poll(), 'waiting');
  state.other = false;
  assert.equal(s.poll(), 'started');
  assert.deepEqual(state.started.map((j) => j.trigger), [false], 'the full run that waited, once');
});

test('a trigger that found the lock taken gives its 2-hour slot back (review)', () => {
  const { s, state } = rig();
  assert.equal(s.newBodies(2), 'started');
  state.reader = false;
  assert.equal(s.newBodies(2), 'too-soon');
  s.triggerSkipped();
  assert.equal(s.newBodies(2), 'started', 'the skipped one did not use the slot');
});

test('a full run waiting outranks a trigger waiting; a deferred trigger past its gap does not double up', () => {
  const { s, state } = rig();
  state.scan = true;
  s.newBodies(2);
  s.kick('every 6 h');
  assert.equal(s.pending().trigger, false, 'the full run replaces the waiting trigger');
  state.scan = false;
  s.scanEnded();
  assert.equal(state.started.length, 1);
  assert.equal(state.started[0].trigger, false);
  // A trigger deferred, then another trigger started directly in the meantime is impossible
  // (the scan blocks both), but a trigger that waited must still respect the 2 h gap from the last one.
  const r = rig();
  r.s.newBodies(1); r.state.reader = false;           // trigger at t=0
  r.state.t = TRIGGER_GAP_MS; r.state.scan = true;
  r.s.newBodies(1);                                    // deferred at the gap
  r.state.scan = false;
  assert.equal(r.s.scanEnded(), 'started', 'the gap had passed');
});

test('serve.mjs goes through the schedule: every reader kick, the scan\'s exit, and a poll (wiring)', async () => {
  // Importing serve.mjs starts a server, so its source is read instead.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("from './reader-schedule.mjs'"));
  assert.match(src, /scanChild\.on\('exit', \(\) => \{ scanChild = null; readerSchedule\.scanEnded\(\); \}\)/, 'a scan\'s end starts a deferred reader');
  assert.match(src, /function kickCurate\([^)]*\) \{\s*if \(!AUTO\) return;\s*readerSchedule\.kick\(/, 'the kick no longer returns in silence beside a scan');
  assert.match(src, /setInterval\(\(\) => readerSchedule\.poll\(\)/, 'a scan another process runs is noticed ending');
  assert.equal((src.match(/(?<!function )startCurate\(/g) || []).length, 1, 'only the schedule starts the reader');
});

test('while he applies the reader waits like it waits for a scan, and a full run is not swapped for a trigger (F-1021)', () => {
  const state = { applying: true, reader: false, started: [], log: [] };
  const s = makeReaderSchedule({
    start: (job) => { state.started.push(job); state.reader = true; },
    scanRunning: () => false, readerRunning: () => state.reader, applying: () => state.applying,
    log: (l) => state.log.push(l), now: () => 10 * TRIGGER_GAP_MS,
  });
  assert.equal(s.kick('every 6 h'), 'deferred');
  assert.match(state.log[0], /he is applying/);
  assert.equal(s.newBodies(5), 'deferred');
  assert.equal(s.pending().trigger, false, 'the full run still waits, not the capped trigger');
  assert.equal(s.idle(), 'waiting');
  state.applying = false;
  assert.equal(s.idle(), 'started');
  assert.equal(state.started[0].trigger, false);
});
