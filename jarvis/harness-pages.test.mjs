// F-1029: a test harness driving the live dashboard leaves nothing in his logs,
// and what earlier runs left is taken out again with every line kept aside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HARNESS_PLAN_URL, isHarnessPage } from './harness-pages.mjs';
import { logPlan, logReport, pruneHarness } from './answer-log.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'harness-pages-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the pages the tests use are harness pages; a real posting is not', () => {
  assert.equal(isHarnessPage(HARNESS_PLAN_URL), true);
  assert.equal(isHarnessPage('http://localhost:4300/__jarvis_fixture_1'), true);
  assert.equal(isHarnessPage('http://127.0.0.1:61234/form.html'), true);
  assert.equal(isHarnessPage('https://boards.greenhouse.io/x/jobs/12'), false, 'another id is not the fixture');
  assert.equal(isHarnessPage('https://boards.greenhouse.io/anduril/jobs/1'), false);
  assert.equal(isHarnessPage('https://job-boards.greenhouse.io/x/jobs/1'), false);
});

test('the log writers keep nothing for a harness page', () => {
  const file = path.join(dir, 'writers.jsonl');
  const fields = [{ label: 'First Name', type: 'text' }];
  const actions = [{ label: 'First Name', type: 'text', action: 'fill', value: 'Alex', at: 0 }];
  assert.equal(logPlan({ pageUrl: HARNESS_PLAN_URL, fields, actions, file }), 0);
  logReport({ pageUrl: 'http://localhost:4300/__jarvis_fixture_2', body: { filled: 1 }, file });
  assert.equal(existsSync(file), false, 'nothing written');
  assert.ok(logPlan({ pageUrl: 'https://boards.greenhouse.io/acmeco/jobs/7', fields, actions, file }) > 0, 'a real page still is');
});

test('the prune takes out exactly the harness lines, keeps them aside, and leaves every other byte', () => {
  const d = mkdtempSync(path.join(dir, 'prune-'));
  const real = [
    { at: '2026-10-01T00:00:00Z', kind: 'plan', pageUrl: 'https://boards.greenhouse.io/anduril/jobs/5', label: 'First Name' },
    { at: '2026-10-02T00:00:00Z', kind: 'final', status: 'you answered', pageUrl: 'https://x.wd1.myworkdayjobs.com/a', label: 'Do you know anyone here?', answer: 'No' },
  ].map((r) => JSON.stringify(r));
  const fake = [
    { at: '2026-10-01T01:00:00Z', kind: 'plan', pageUrl: HARNESS_PLAN_URL, label: 'First Name' },
    { at: '2026-10-01T02:00:00Z', kind: 'report', pageUrl: 'http://localhost:4300/__jarvis_fixture_3' },
  ].map((r) => JSON.stringify(r));
  const log = [real[0], fake[0], 'not json', real[1], fake[1], ''].join('\r\n');
  writeFileSync(path.join(d, 'answer-log.jsonl'), log);
  writeFileSync(path.join(d, 'plans.jsonl'), `${fake[0]}\n${real[0]}\n`);
  const dry = pruneHarness({ dir: d });
  assert.equal(dry.removed, 3);
  assert.equal(readFileSync(path.join(d, 'answer-log.jsonl'), 'utf8'), log, 'a dry run changes nothing');
  const r = pruneHarness({ dir: d, write: true, now: new Date('2026-11-07T08:00:00Z') });
  assert.equal(r.removed, 3);
  assert.deepEqual(r.perFile, { 'answer-log.jsonl': { lines: 5, removed: 2 }, 'plans.jsonl': { lines: 2, removed: 1 } });
  assert.equal(readFileSync(path.join(d, 'answer-log.jsonl'), 'utf8'), [real[0], 'not json', real[1], ''].join('\r\n'), 'the rest byte for byte, line endings kept');
  assert.equal(readFileSync(path.join(d, 'plans.jsonl'), 'utf8'), `${real[0]}\n`);
  const kept = readFileSync(r.savedTo, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((k) => k.line).sort(), [fake[0], fake[1], fake[0]].sort(), 'every removed line is kept');
  assert.deepEqual(kept.map((k) => k.file).sort(), ['answer-log.jsonl', 'answer-log.jsonl', 'plans.jsonl']);
  assert.equal(pruneHarness({ dir: d, write: true }).removed, 0, 'a second run finds nothing');
});
