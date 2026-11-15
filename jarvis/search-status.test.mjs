// jarvis/search-status.test.mjs — the Inbox strip's facts and its alarm (F-974, F-981).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRuns, healthAlarms } from './search-status.mjs';

const NOW = new Date('2026-11-04T18:00:00Z');
const run = (at, o = {}) => JSON.stringify({ at, filed: 0, read: 10, failed: 0, goal: 20, ...o });

test('the strip reads the last run and the last one that filed', () => {
  const r = lastRuns([run('2026-11-04T07:30:00Z', { filed: 4, topup: 2 }), run('2026-11-04T17:10:00Z', { noop: true, why: 'inbox at target' })]);
  assert.deepEqual([r.last.noop, r.last.why, r.lastFiled.filed, r.lastFiled.topup], [true, 'inbox at target', 4, 2]);
});

test('a healthy search raises no alarm', () => {
  assert.deepEqual(healthAlarms([run('2026-11-04T07:30:00Z', { filed: 12 }), run('2026-11-04T17:10:00Z', { filed: 15 })], { now: NOW }), []);
});

test('two real runs in a row filing nothing raise one; no-ops between them do not count', () => {
  const lines = [run('2026-11-03T07:30:00Z'), run('2026-11-03T12:00:00Z', { noop: true }), run('2026-11-04T07:30:00Z'), run('2026-11-04T17:10:00Z', { goal: 0 })];
  const a = healthAlarms(lines, { now: NOW });
  assert.ok(a.includes('2 searches in a row filed nothing.'), a.join(' | '));
});

test('one zero after a filing run is not an alarm', () => {
  const a = healthAlarms([run('2026-11-04T07:30:00Z', { filed: 9 }), run('2026-11-04T17:10:00Z', { filed: 0, goal: 0 })], { now: NOW });
  assert.deepEqual(a, []);
});

test('over half the tried rows failing raises one', () => {
  const a = healthAlarms([run('2026-11-04T17:10:00Z', { filed: 12, read: 4, failed: 6 })], { now: NOW });
  assert.ok(a.some((x) => /60% of the postings the last 1 searches tried failed/.test(x)), a.join(' | '));
});

test('no run for 18 hours raises one', () => {
  const a = healthAlarms([run('2026-11-03T22:00:00Z', { filed: 12 })], { now: NOW });
  assert.ok(a.includes('No search has run for 20 hours (it is scheduled twice a day).'), a.join(' | '));
});

test('the overnight gap between the two scheduled runs is not an alarm', () => {
  // 4:10 PM to 6:30 AM is 14.3 h; a sleeping laptop adds more.
  assert.deepEqual(healthAlarms([run('2026-11-04T00:10:00Z', { filed: 12 })], { now: new Date('2026-11-04T16:00:00Z') }), []);
});

test('a goal over 100, and a run filing under half its goal, raise one each', () => {
  assert.ok(healthAlarms([run('2026-11-04T17:10:00Z', { filed: 200, goal: 500 })], { now: NOW }).some((x) => /goal was 500/.test(x)));
  assert.ok(healthAlarms([run('2026-11-04T17:10:00Z', { filed: 3, goal: 20 })], { now: NOW }).includes('The last search filed 3 of its goal of 20.'));
});

test('a run that crashed or stopped part-way raises one, with its reason (F-986)', () => {
  const lines = [run('2026-11-04T07:30:00Z', { filed: 9 }), JSON.stringify({ at: '2026-11-04T17:10:00Z', error: 'the run crashed: database disk image is malformed', code: 1 })];
  assert.ok(healthAlarms(lines, { now: NOW }).includes('The last search failed (the run crashed: database disk image is malformed).'));
  assert.equal(lastRuns(lines).last.error, 'the run crashed: database disk image is malformed');
});

test('a log that was never written says so', () => {
  assert.deepEqual(healthAlarms([], { now: NOW }), ['The daily search has never run.']);
});
