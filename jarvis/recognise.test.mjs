// jarvis/recognise.test.mjs — a leftover question recognised, never answered, by a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { recogniseLeftovers, recogniseQuestions, parseTopics, worthAsking, answerableTopics, cacheKey } from './apply/recognise.mjs';
import { planForm } from './apply-plan.mjs';

const HIM = {
  identity: { full_name: 'Test Person', first_name: 'Test', last_name: 'Person', email: 't@example.com', phone: '(509) 555-0100', city: 'Springfield', state: 'Washington', country: 'United States', portfolio: 'example.com', linkedin: 'linkedin.com/in/test' },
  answers: { authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', over_18: 'Yes', how_heard: 'LinkedIn', relocate: 'Yes', travel_ok: 'Yes', willing_onsite: 'Yes', notice_period: 'None', essential_functions: 'Yes' },
  eeo: { hispanic: 'No' },
};

test('the model may only name a known question, or none', () => {
  const topics = answerableTopics(HIM);
  assert.ok(topics.some((t) => t.id === 'sponsorship'));
  assert.deepEqual(parseTopics('["sponsorship", "made_up", "none"]', 3, topics), ['sponsorship', null, null]);
  assert.deepEqual(parseTopics('not json', 2, topics), [null, null]);
});

test('written answers, self-identification and credentials never go to the model', () => {
  assert.equal(worthAsking('Why do you want to work here?'), false);
  assert.equal(worthAsking('Please describe a project you are proud of'), false);
  assert.equal(worthAsking('What is your gender?'), false);
  assert.equal(worthAsking('Social Security Number'), false);
  assert.equal(worthAsking('Do you possess the legal right to take up employment here without a sponsor?'), true);
});

test('a recognised leftover is answered by the known question\'s rule, flagged for review', async () => {
  const fields = [{ label: 'Is there any chance you will need us to file immigration paperwork (e.g. an H-1B petition) for you?', type: 'select', options: ['Yes', 'No'] }];
  const plan = planForm(fields, HIM);
  assert.equal(plan.actions[0].action, 'unknown', 'no rule knows this wording');
  const took = await recogniseLeftovers(plan, fields, HIM, {}, { planForm, ask: async () => '["sponsorship"]' });
  assert.equal(took, 1);
  const a = plan.actions[0];
  assert.equal(a.action, 'select');
  assert.equal(a.value, 'Yes');
  assert.equal(a.review, true);
  assert.equal(a.recognisedAs, 'sponsorship');
  assert.equal(a.label, fields[0].label, 'the page still finds its own question');
  assert.equal(plan.unanswered.length, 0);
});

test('a WRONG recognition cannot put a contradiction on the form', async () => {
  // The model calls a sponsorship question "work authorization" — whose rule
  // answers Yes/"I require sponsorship". The facts check re-reads the
  // recognised question's words, so no sponsorship answer comes out "No".
  // "…WITHOUT sponsorship" is No for him. Read as plain work authorization,
  // its rule would say Yes; the check on the ORIGINAL words refuses that.
  const label = 'Are you able to work here without sponsorship?';
  const fields = [{ label, type: 'select', options: ['Yes', 'No'] }];
  const plan = { actions: [{ action: 'unknown', at: 0, label, type: 'select' }], unanswered: [{ label }] };
  const took = await recogniseLeftovers(plan, fields, HIM, {}, { planForm, ask: async () => '["work_authorization"]' });
  assert.equal(took, 0);
  assert.equal(plan.actions[0].action, 'unknown', 'left for him, not answered Yes');
});

test('"none" leaves the question for him, and every verdict is cached by wording', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recognise-'));
  const cacheFile = path.join(dir, 'topics.json');
  let calls = 0;
  const ask = async () => { calls += 1; return '["none"]'; };
  const q = [{ label: 'What colour is your favourite pen?', options: [] }];
  assert.deepEqual(await recogniseQuestions(q, HIM, { ask, cacheFile }), [null]);
  assert.deepEqual(await recogniseQuestions(q, HIM, { ask, cacheFile }), [null]);
  assert.equal(calls, 1, 'the second plan asks nobody');
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf-8'))[cacheKey(q[0].label, [])], null);
});

test('a model that never answers costs the plan nothing', async () => {
  const fields = [{ label: 'Do you possess the legal right to take up employment here without a sponsor?', type: 'select', options: ['Yes', 'No'] }];
  const plan = planForm(fields, HIM);
  const before = JSON.stringify(plan.actions);
  const took = await recogniseLeftovers(plan, fields, HIM, {}, { planForm, timeoutMs: 50, ask: () => new Promise(() => {}) });
  assert.equal(took, 0);
  assert.equal(JSON.stringify(plan.actions), before);
});

test('LATER: a plan never waits on the model; the verdict is there for the next plan', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recognise-later-'));
  const cacheFile = path.join(dir, 'topics.json');
  let release;
  const gate = new Promise((r) => { release = r; });
  const ask = async () => { await gate; return '["sponsorship"]'; };
  const fields = [{ label: 'Is there any chance you will need us to file immigration paperwork (e.g. an H-1B petition) for you?', type: 'select', options: ['Yes', 'No'] }];

  const first = planForm(fields, HIM);
  const took = await recogniseLeftovers(first, fields, HIM, {}, { planForm, ask, cacheFile, later: true });
  assert.equal(took, 0, 'the first plan went back without waiting');
  assert.equal(first.actions[0].action, 'unknown');

  release();
  await new Promise((r) => setTimeout(r, 50));
  const second = planForm(fields, HIM);
  assert.equal(await recogniseLeftovers(second, fields, HIM, {}, { planForm, ask, cacheFile, later: true }), 1);
  assert.equal(second.actions[0].value, 'Yes');
});

test('a follow-up to another answer never goes to the model', () => {
  assert.equal(worthAsking('If you selected Other from the State/Province list, please enter the name below.'), false);
  assert.equal(worthAsking('9a)*If your response to question 9 is “No”, please specify the country'), false);
  assert.equal(worthAsking('What is your State or Province?'), true);
});

test('legal status never goes to the recogniser (Atomic Semi, 2026-09-25: a U.S.-person list was read as work authorization and answered Yes)', () => {
  for (const q of [
    'I am one of the following: (a) a citizen of the United States; (b) a lawful permanent resident of the United States; or (c) a person admitted into the United States as an asylee or refugee:',
    'Are you a U.S. Person as defined by ITAR?',
    'Do you hold an active security clearance?',
    'Please select your country of citizenship',
    'Have you ever been convicted of a felony?',
  ]) assert.equal(worthAsking(q), false, q);
  assert.equal(worthAsking('When would you be able to start?'), true, 'ordinary questions still go');
});
