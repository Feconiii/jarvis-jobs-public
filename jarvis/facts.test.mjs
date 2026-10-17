// jarvis/facts.test.mjs — the second reading of the basic questions (_facts.mjs).
// Every "wrong" case below is an answer this engine really sent or planned.
import test from 'node:test';
import assert from 'node:assert/strict';

import { polarity, basicTopic, contradicts } from './apply/_facts.mjs';
import { planForm } from './apply-plan.mjs';

const HIM = {
  identity: { full_name: 'Test Person' },
  answers: { authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', over_18: 'Yes' },
  eeo: { hispanic: 'No', veteran: 'I am not a Veteran.' },
};

test('polarity reads Yes/No and statements, and refuses what it cannot read', () => {
  assert.equal(polarity('Yes'), true);
  assert.equal(polarity('No'), false);
  assert.equal(polarity('Yes, I will require sponsorship'), true);
  assert.equal(polarity('I will require sponsorship'), true);
  assert.equal(polarity('I will not require sponsorship'), false);
  assert.equal(polarity('I am not a protected veteran'), false);
  assert.equal(polarity('I decline to self-identify'), null);
  assert.equal(polarity('No Selection'), null, 'a menu placeholder is not a No');
  assert.equal(polarity('I am authorized to work in the U.S. and will not require sponsorship'), null, 'two clauses answer two questions');
  assert.equal(polarity('None'), null);
});

test('the topics are recognised, and a legal paragraph is not one of them', () => {
  assert.equal(basicTopic('Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?', HIM)?.key, 'sponsorship');
  assert.equal(basicTopic('Are you legally authorized to work in the United States?', HIM)?.key, 'authorized');
  assert.equal(basicTopic('Are you authorized to work in the U.S. without the need for sponsorship?', HIM)?.truth, false, 'authorized WITHOUT sponsorship is No for him');
  assert.equal(basicTopic('Are you at least 18 years of age?', HIM)?.key, 'age18');
  assert.equal(basicTopic('Are you Hispanic or Latino?', HIM)?.key, 'hispanic');
  assert.equal(basicTopic('This position requires the lawful ability to access technical data. Applicants who require sponsorship '.repeat(4), HIM), null);
  assert.equal(basicTopic('What is your phone number?', HIM), null);
});

test('PEAK ENERGY (F-572): sponsorship "No" is left for him, not sent', () => {
  const bad = contradicts('Will you now or in the future require employer sponsorship to work in the United States?', 'No', HIM);
  assert.equal(bad?.topic, 'sponsorship');
  assert.equal(bad?.want, 'Yes');
  assert.equal(contradicts('Will you now or in the future require employer sponsorship to work in the United States?', 'Yes', HIM), null);
});

test('the planner runs the check, and a right answer passes straight through it', () => {
  const plan = planForm([{ label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Select', 'Yes', 'No'] }],
    { ...HIM, answers: { ...HIM.answers } });
  const a = plan.actions[0];
  assert.equal(a.action, 'select');
  assert.equal(a.value, 'Yes', 'the right answer passes straight through');
});

test('an answer it cannot read is never removed', () => {
  assert.equal(contradicts('Are you a protected veteran?', 'I decline to self-identify', HIM), null);
  assert.equal(contradicts('Are you legally authorized to work in the United States?', 'Yes', HIM), null);
});

test('VIAVI (2026-09-26): authorization that excludes practical training is No for him, and a Yes is the contradiction', () => {
  const q = 'Are you authorized to work in the United States? This does not include practical training.';
  assert.equal(basicTopic(q, HIM)?.key, 'authorized-unrestricted');
  assert.equal(contradicts(q, 'No', HIM), null, 'his true answer passes');
  assert.equal(contradicts(q, 'Yes', HIM)?.want, 'No', 'the Yes he sent on 2026-09-24 is caught');
  assert.equal(basicTopic('Are you authorized to work in the U.S. without restrictions?', HIM)?.truth, false);
  assert.equal(basicTopic('Are you legally authorized to work in the United States?', HIM)?.key, 'authorized', 'the plain question is untouched');
  const plan = planForm([{ label: q, type: 'select', options: ['Select', 'Yes', 'No'] }], { ...HIM, answers: { ...HIM.answers } });
  assert.equal(plan.actions[0].action, 'select');
  assert.equal(plan.actions[0].value, 'No', 'planned, not left for him');
  const plain = planForm([{ label: 'Are you legally authorized to work in the United States?', type: 'select', options: ['Select', 'Yes', 'No'] }], { ...HIM, answers: { ...HIM.answers } });
  assert.equal(plain.actions[0].value, 'Yes');
});
