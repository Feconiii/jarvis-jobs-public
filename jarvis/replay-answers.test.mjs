// jarvis/replay-answers.test.mjs — the judge that replays his sent answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { corpus, judge, replay } from './replay-answers.mjs';

const HIM = {
  identity: { full_name: 'Test Person', phone: '(509) 555-0100', portfolio: 'example.com' },
  answers: { authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', how_heard: 'LinkedIn' },
  eeo: { hispanic: 'No' },
};
const row = (over) => ({ kind: 'final', status: 'kept', host: 'x.example', company: 'Acme', type: 'text', options: [], ...over });

test('the same answer in the form\'s own words is a match', () => {
  assert.equal(judge(row({ label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Yes', 'No'], answer: 'Yes' }), HIM).verdict, 'match');
  assert.equal(judge(row({ label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Yes', 'No'], answer: 'No' }), HIM).verdict, 'differs');
});

test('a phone number is the same number however it is punctuated', () => {
  assert.equal(judge(row({ label: 'Phone Number', answer: '5095550100' }), HIM).verdict, 'match');
});

test('a question the engine leaves is "empty", not a match', () => {
  assert.equal(judge(row({ label: 'Quelle est votre couleur préférée ?', answer: 'Bleu' }), HIM).verdict, 'empty');
});

test('only his LAST answer to a question counts, and split-date parts are left out', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-'));
  const file = path.join(dir, 'answer-log.jsonl');
  const rows = [
    row({ at: '1', label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Yes', 'No'], answer: 'No', status: 'kept' }),
    row({ at: '2', label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Yes', 'No'], answer: 'Yes', status: 'changed' }),
    row({ at: '3', label: 'Date', answer: '24', status: 'changed' }),
    row({ at: '4', label: 'Resume', answer: '1 file(s) attached', status: 'you answered' }),
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c = corpus(file);
  assert.equal(c.length, 1, 'one question, the latest answer');
  assert.equal(c[0].answer, 'Yes');
  const r = replay({ file, profile: HIM });
  assert.equal(r.total, 1);
  assert.equal(r.match, 1);
  assert.equal(r.regressions, 0);
});

test('an answer that went out WRONG and is corrected now is not a regression (Viavi, 2026-09-26)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'replay-wrong-'));
  const file = path.join(dir, 'answer-log.jsonl');
  const q = 'Are you authorized to work in the United States? This does not include practical training.';
  writeFileSync(file, [
    row({ label: q, type: 'select', options: ['Yes', 'No'], answer: 'Yes', company: 'Viavi Solutions' }),
    row({ label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Yes', 'No'], answer: 'No' }),
  ].map((r) => JSON.stringify(r)).join('\n'));
  const r = replay({ file, profile: HIM });
  assert.equal(r.corrected, 1);
  assert.equal(r.regressions, 1, 'a kept answer the planner now contradicts is still a regression');
  assert.ok(r.items.find((i) => i.verdict === 'corrected').now.startsWith('No —'), 'the planner says No');
});
