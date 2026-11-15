// S6: each run's phases, kept as names and whole milliseconds only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanTimings, timingLine, keepTimings, cleanSites, waitReport } from './run-timings.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'run-timings-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const RUN = { total: 7912, inject: 412, discover: 640.4, plan: 1210, answers: 300, resume: 0, dropdowns: 3204, entries: 0, waits: 2100, slowest: 'dropdowns' };

test('only phase names and whole ms survive: no page, no employer, no answer', () => {
  const c = cleanTimings({ ...RUN, pageUrl: 'https://acme.com/apply', company: 'Acme', answer: 'Yes', label: 'Sponsorship?', discover: 640.4, plan: '1210', waits: -5, dropdowns: 1e12 });
  assert.deepEqual(Object.keys(c).sort(), ['answers', 'discover', 'entries', 'inject', 'plan', 'resume', 'slowest', 'total'].sort());
  assert.equal(c.discover, 640, 'whole ms');
  assert.equal(c.plan, 1210, 'a number written as text is still a number');
  assert.equal(c.waits, undefined, 'a negative is dropped');
  assert.equal(c.dropdowns, undefined, 'an absurd value is dropped');
  assert.equal(cleanTimings({ slowest: 'pageUrl' }), null, 'nothing known: nothing kept');
  assert.equal(cleanTimings({ ...RUN, slowest: '<script>' }).slowest, undefined);
  assert.equal(cleanTimings(null), null);
});

test('the serve.log line reads in seconds and names the slowest step', () => {
  assert.equal(timingLine(RUN), 'run timing: total 7.9 s · setup 0.4 · reading 0.6 · plan 1.2 · answers 0.3 · resume 0.0 · dropdowns 3.2 · experience/education 0.0 · fixed waits 2.1 · slowest: dropdowns');
  assert.equal(timingLine({ total: 1000, hidden: true, slowest: 'plan', plan: 900 }), 'run timing: total 1.0 s · plan 0.9 · slowest: plan (tab hidden)');
  assert.equal(timingLine({}), '');
});

test('each run is one line in run-timings.jsonl; the file rotates at 5 MB', () => {
  const file = path.join(dir, 'run-timings.jsonl');
  const row = keepTimings(file, { ...RUN, company: 'Acme' }, Date.parse('2026-11-07T12:00:00Z'));
  assert.equal(row.at, '2026-11-07T12:00:00.000Z');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(!/Acme|https?:/.test(lines[0]), lines[0]);
  assert.equal(keepTimings(file, { company: 'Acme' }), null, 'nothing known: no line');
  writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10));
  keepTimings(file, RUN);
  assert.ok(existsSync(file.replace(/\.jsonl$/, '.1.jsonl')), 'rotated');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
  // A second rotation over the first one's file (review: Windows refused the rename, and rotation stopped for good).
  writeFileSync(file, 'y'.repeat(5 * 1024 * 1024 + 10));
  assert.ok(keepTimings(file, RUN), 'the line is still written');
  assert.match(readFileSync(file.replace(/\.jsonl$/, '.1.jsonl'), 'utf8').slice(0, 5), /^y{5}$/, 'the newer file became the rotation');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1, 'and the log starts fresh again');
});

test('S5: each run names its longest waits by line, numbers only, and they add up across runs', () => {
  const sites = [[2941, 12300, 3000, 40, 9000], [1155, 5000, 5000, 1, 0]];
  const c = cleanTimings({ ...RUN, waitSites: [...sites, [0, 1, 1, 1, 1], [12, 'Acme', 1, 1, 0], [5, 1, 1], 'line 9'], v: '1.150.14' });
  assert.deepEqual(c.waitSites, sites, 'a bad entry is dropped, the rest kept as they came');
  assert.equal(c.v, '1.150.14');
  assert.equal(cleanTimings({ ...RUN, v: '<b>1</b>' }).v, undefined, 'a version is digits and dots');
  assert.equal(cleanSites(Array.from({ length: 20 }, (_, i) => [i + 1, 1, 1, 1, 0])).length, 12, 'twelve at most');
  assert.match(timingLine({ ...RUN, waitSites: sites }), / · longest waits: line 2941 12\.3 s\/40x \(asked 3\.0\), line 1155 5\.0 s\/1x \(asked 5\.0\)$/);
  const report = waitReport([{ ...RUN, v: '1.150.14', waitSites: sites }, { ...RUN, v: '1.150.14', waitSites: [[2941, 700, 300, 2, 0]] }, { ...RUN }]);
  assert.equal(report.runs, 2, 'a run from before S5 names no waits');
  assert.deepEqual(report.sites[0], { v: '1.150.14', line: 2941, spent: 13000, asked: 3300, n: 42, hidden: 9000, runs: 2 });
  assert.equal(report.sites[1].line, 1155);
});

test('S5: `node jarvis/run-timings.mjs --waits <file>` prints the summed waits, longest first, hidden time included', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const file = path.join(dir, 'cli-timings.jsonl');
  writeFileSync(file, [
    JSON.stringify({ ...RUN, v: '1.150.14', waitSites: [[2941, 12300, 3000, 40, 9000], [1155, 5000, 5000, 1, 0]] }),
    JSON.stringify({ ...RUN, v: '1.150.14', waitSites: [[2941, 700, 300, 2, 500]] }),
    JSON.stringify({ ...RUN }),   // from before S5: counted as a run, names no waits
    'not json',
  ].join('\n') + '\n');
  const script = fileURLToPath(new URL('./run-timings.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--waits', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split(/\r?\n/);
  assert.equal(out[0], '2 of 3 runs name their waits (1.150.14 and later).');
  assert.equal(out[1], '  1.150.14 line 2941: 13.0 s in 42 waits over 2 runs; asked 3.3 s; 9.5 s with the tab hidden');
  assert.equal(out[2], '  1.150.14 line 1155: 5.0 s in 1 waits over 1 runs; asked 5.0 s; 0.0 s with the tab hidden');
  assert.equal(out.length, 3);
  const none = spawnSync(process.execPath, [script, '--waits', path.join(dir, 'no-such.jsonl')], { encoding: 'utf8' });
  assert.equal(none.stdout.trim(), '0 of 0 runs name their waits (1.150.14 and later).', 'a missing file is no runs, not a crash');
});
