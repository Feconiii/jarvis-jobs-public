// F-1021: background jobs wait while he is applying, and never for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApplyQuiet, APPLY_PATHS } from './apply-quiet.mjs';

function clock() {
  let t = 1_000_000; const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      t += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > t) break;
        timers.shift(); due.fn();
      }
    },
  };
}

test('a job asked for while nobody is applying starts at once', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c });
  let ran = 0;
  assert.equal(q.gate('enrich', () => { ran += 1; }), true);
  assert.equal(ran, 0, 'the caller starts it; nothing is held');
  assert.deepEqual(q.held(), []);
});

test('a held job asking again from its own release is let through, even while he is still applying', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c, quietMs: 600_000, maxHoldMs: 3_600_000 });
  let started = 0;
  const kick = () => { if (!q.gate('scan', kick)) return; started += 1; };
  q.touch(); kick();
  assert.equal(started, 0);
  for (let i = 0; i < 61; i += 1) { c.advance(60_000); q.touch(); }
  assert.equal(started, 1, 'the cap released it and its own gate let it start');
  kick();
  assert.equal(started, 1, 'a fresh ask while he is applying is held again');
});

test('a job asked for while he is applying waits until he has been quiet for the window', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c, quietMs: 600_000 });
  let ran = 0;
  q.touch();
  assert.equal(q.gate('enrich', () => { ran += 1; }), false);
  c.advance(300_000); q.touch();          // still filling forms
  c.advance(599_000); assert.equal(ran, 0);
  c.advance(2_000); assert.equal(ran, 1);
  assert.deepEqual(q.held(), []);
});

test('one held run per job, however often it is asked for', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c, quietMs: 60_000 });
  let ran = 0;
  q.touch();
  for (let i = 0; i < 5; i += 1) q.gate('enrich', () => { ran += 1; });
  c.advance(61_000);
  assert.equal(ran, 1);
});

test('a job is never held longer than the cap, even if he never stops', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c, quietMs: 600_000, maxHoldMs: 3_600_000 });
  let ran = 0;
  q.touch(); q.gate('scan', () => { ran += 1; });
  for (let i = 0; i < 70; i += 1) { c.advance(60_000); q.touch(); }
  assert.equal(ran, 1);
});

test('with no cap (the server\'s setting), nothing starts while he keeps applying, and it starts once he stops', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c, quietMs: 600_000, maxHoldMs: Infinity });
  let ran = 0;
  q.touch(); q.gate('discover', () => { ran += 1; });
  for (let i = 0; i < 300; i += 1) { c.advance(60_000); q.touch(); }   // five hours of forms
  assert.equal(ran, 0);
  c.advance(601_000);
  assert.equal(ran, 1);
});

test('the server holds with no cap', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8'), /makeApplyQuiet\(\{\s*maxHoldMs: Infinity,/);
});

test('running children are told when he starts and when he stops', () => {
  const c = clock(); const seen = [];
  const q = makeApplyQuiet({ ...c, quietMs: 60_000, onApplying: () => seen.push('applying'), onQuiet: () => seen.push('quiet') });
  q.touch(); q.touch(); c.advance(30_000); q.touch();
  assert.deepEqual(seen, ['applying']);
  c.advance(61_000);
  assert.deepEqual(seen, ['applying', 'quiet']);
});

test('held jobs start one at a time once he is quiet, a minute apart', () => {
  const c = clock(); const q = makeApplyQuiet({ ...c, quietMs: 60_000, staggerMs: 60_000 });
  const order = [];
  q.touch();
  for (const n of ['enrich', 'scan', 'mail']) q.gate(n, () => order.push(n));
  c.advance(61_000);
  assert.deepEqual(order, ['enrich']);
  c.advance(59_000);
  assert.deepEqual(order, ['enrich']);
  c.advance(2_000);
  assert.deepEqual(order, ['enrich', 'scan']);
  c.advance(61_000);
  assert.deepEqual(order, ['enrich', 'scan', 'mail']);
  assert.deepEqual(q.held(), []);
});

test('his form requests count as applying; heartbeats do not', () => {
  for (const p of ['/api/panel', '/api/filled', '/api/plan', '/api/answer']) assert.ok(APPLY_PATHS.has(p), p);
  for (const p of ['/api/extension', '/api/apply-status', '/api/person', '/api/jobs']) assert.ok(!APPLY_PATHS.has(p), p);
});
