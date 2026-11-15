// F-1036: his history with the employer a form belongs to — worked there,
// applied there before — and his own corrections of those answers.
// The shapes are the ones met: Applied Materials' Workday key (2026-10-20,
// 2026-11-07), Brooks Automation's mixed question (2026-10-16), and
// GlobalFoundries' six-month window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planForm, decide } from './apply-plan.mjs';
import { resolveLabel } from './apply/_answers.mjs';
import { wdValue } from './apply/_workday-keys.mjs';
import { employedAtApplyingTo, appliedHere, windowDays } from './apply/_history.mjs';
import { sameEmployer } from './same-posting.mjs';
import { pastAnswers } from './answer-log.mjs';

const base = () => ({
  identity: { first_name: 'Test', last_name: 'Person' },
  answers: { previously_employed_here: 'No', previously_applied_here: 'No' },
  work_experience: [{ company: 'Applied Materials' }, { company: 'Acme Steel Stud Company' }],
});
const AMAT_Q = 'Have you ever worked at Applied Materials as a regular employee, contingent worker, intern, etc.?';
const amatField = { label: AMAT_Q, type: 'radio', options: ['Yes', 'No'], key: 'formField-candidateIsPreviousWorker', required: true };
const one = (fields, profile, opts) => planForm(fields, profile, opts).actions[0];

test('Workday previous-worker key: Yes where he worked, from his work history', () => {
  const a = one([amatField], base(), { company: 'Applied Materials' });
  assert.equal(a.value, 'Yes', JSON.stringify(a));
  assert.equal(wdValue('formField-candidateIsPreviousWorker', { ...base(), applyingTo: 'AMAT' }), 'Yes', 'the short name he uses');
  assert.equal(wdValue('formField-candidateIsPreviousWorker', { ...base(), applyingTo: 'Applied Materials, Inc.' }), 'Yes');
});

test('…and No at an employer he never worked for', () => {
  const a = one([{ ...amatField, label: 'If you were formerly employed at Symbotic, please provide the information listed.' }], base(), { company: 'Symbotic' });
  assert.equal(a.value, 'No', JSON.stringify(a));
  assert.equal(employedAtApplyingTo({ ...base(), applyingTo: 'Applied Digital' }), null, 'a name sharing one word is not his employer');
});

test('the label rule agrees with the key: worked here, by label alone', () => {
  const r = resolveLabel(AMAT_Q, { ...base(), applyingTo: 'Applied Materials' });
  assert.equal([].concat(r.value)[0], 'Yes');
});

test('applied before: any earlier application at the employer is a Yes, on any posting', () => {
  const p = { ...base(), applyingTo: 'Brooks Automation', appliedHereBefore: true, appliedHereDates: ['2026-09-01T00:00:00Z'] };
  const r = resolveLabel('Have you ever applied or worked for Brooks Automation previously?', p);
  assert.equal([].concat(r.value)[0], 'Yes', 'the mixed question: the application decides it');
  const r2 = resolveLabel('Have you applied to Brooks Automation before?', p);
  assert.equal([].concat(r2.value)[0], 'Yes');
  const r3 = resolveLabel('Have you ever applied for a position at Brooks Automation?', p);
  assert.equal([].concat(r3.value)[0], 'Yes');
});

test('code review #1, 2026-11-13: an employment question that only MENTIONS an application is never Yes from an earlier one', () => {
  // "Have you been employed by Acme? This will not affect your application."
  // was answered "Yes, worked here" because the sentence held the word and he
  // had applied there before: a false claim of past employment.
  const p = { ...base(), applyingTo: 'Acme Robotics', appliedHereBefore: true, appliedHereDates: ['2026-09-01T00:00:00Z'] };
  for (const Q of [
    'Have you been employed by Acme Robotics? Your answer will not affect your application.',
    'Have you ever been employed by Acme Robotics? (This is not a condition of your application.)',
    'Are you currently or have you been employed by Acme Robotics at any of its locations? Please answer before you apply.',
    'Are you now or have you ever been an Acme Robotics employee? If you have applied before, answer for employment only.',
    // week-fixes J6: "previously/ever applied" inside an if-clause asks nothing.
    'Have you been employed by Acme Robotics? If you previously applied, list the date in the next question.',
    'Have you ever worked for Acme Robotics? If you have ever applied before, do not count it here.',
    'Have you been employed by Acme Robotics? (When you previously applied, your answer was kept on file.)',
  ]) {
    const v = [].concat(resolveLabel(Q, p).value)[0];
    assert.notEqual(v, 'Yes', `${Q} → ${JSON.stringify(resolveLabel(Q, p))}`);
  }
  // …while the mixed questions still are Yes from the application.
  for (const Q of ['Have you ever applied or worked for Acme Robotics previously?', 'Have you worked for or applied to Acme Robotics before?',
    'Have you been employed by Acme Robotics, or have you previously applied?',
    'Please indicate whether you have previously applied or worked for Acme Robotics.']) {
    assert.equal([].concat(resolveLabel(Q, p).value)[0], 'Yes', Q);
  }
});

test('week-fixes K1: only the QUESTION sentence decides whether applying is asked; instructions and if-clauses never do', async () => {
  const { asksApplied } = await import('./apply/_answers.mjs');
  const p = { ...base(), applyingTo: 'Acme Robotics', appliedHereBefore: true, appliedHereDates: ['2026-09-01T00:00:00Z'] };
  // Each is the employment question alone: answered from employment (No), never Yes from the application.
  for (const Q of [
    'Have you ever been employed by Acme Robotics? If you’ve previously applied, give the date.',   // curly apostrophe
    'Have you ever been employed by Acme Robotics? (Do not answer Yes if you already applied.)',
    'Have you ever been employed by Acme Robotics? Previously applied candidates need not answer the next question.',
    'Have you ever been employed by Acme Robotics? Answer No if you had previously applied but never worked here.',
    'Have you ever been employed by Acme Robotics? Answer for employment, even if you did previously apply.',
    // An instruction is not the question, even one that names applying and working.
    'Have you ever been employed by Acme Robotics? If you have previously applied or worked for us, answer Yes.',
  ]) {
    assert.equal(asksApplied(Q), false, Q);
    assert.equal([].concat(resolveLabel(Q, p).value)[0], 'No', `${Q} → ${JSON.stringify(resolveLabel(Q, p))}`);
  }
  // A label with no "?" is read by its first sentence, comma and all.
  assert.equal(asksApplied('If you have previously applied to Acme Robotics, or worked here, select Yes.'), true);
  assert.equal(asksApplied('Have you previously applied to Acme Robotics, or worked here?'), true);
  assert.equal(asksApplied('Have you ever applied or worked for Acme Robotics previously?'), true);
});

test('week-fixes K3: a label with no "?" drops the if-applied clause and its parenthetical too', async () => {
  const { asksApplied } = await import('./apply/_answers.mjs');
  const p = { ...base(), applyingTo: 'Acme Robotics', appliedHereBefore: true, appliedHereDates: ['2026-09-01T00:00:00Z'] };
  for (const Q of [
    'Prior employment with Acme Robotics (if you already applied, leave this blank)',
    'Employed by Acme Robotics before (do not answer Yes if you already applied)',
    'Prior employment with Acme Robotics, unless you have already applied',
  ]) {
    assert.equal(asksApplied(Q), false, Q);
    assert.notEqual([].concat(resolveLabel(Q, p).value)[0], 'Yes', `${Q} → ${JSON.stringify(resolveLabel(Q, p))}`);
  }
  // The whole parenthetical goes, not just the clause up to its semicolon. (resolveLabel is not asserted here:
  // the separate "applied before" history rule still reads this label raw — reported, not changed in K3.)
  assert.equal(asksApplied('Employed by Acme Robotics before (leave blank if you applied before; prior applications to Acme Robotics count separately)'), false);
  // …while a clause or parenthetical that names working there as well still asks.
  assert.equal(asksApplied('If you have previously applied to Acme Robotics, or worked here, select Yes.'), true);
  assert.equal(asksApplied('Prior relationship with Acme Robotics (if you have applied or worked here, select Yes)'), true);
  assert.equal(asksApplied('Please indicate whether you have previously applied or worked for Acme Robotics.'), true);
});

test('K5: the "applied before" history rule never answers an employment label Yes from a side note', () => {
  const p = { ...base(), applyingTo: 'Acme Robotics', appliedHereBefore: true, appliedHereDates: ['2026-09-01T00:00:00Z'] };
  for (const Q of [
    'Employed by Acme Robotics before (leave blank if you applied before; prior applications to Acme Robotics count separately)',
    'Employed by Acme Robotics before (if you previously applied, give the date in the next question)',
    'Prior employment with Acme Robotics, unless you have previously applied',
  ]) {
    assert.notEqual([].concat(resolveLabel(Q, p)?.value)[0], 'Yes', `${Q} → ${JSON.stringify(resolveLabel(Q, p))}`);
  }
  // The applying question itself, with or without an aside of its own, is still Yes from the application.
  for (const Q of ['Have you previously applied to Acme Robotics?', 'Have you applied to Acme Robotics before?',
    'Have you previously applied to Acme Robotics? (If you previously applied, give the date.)']) {
    assert.equal([].concat(resolveLabel(Q, p).value)[0], 'Yes', Q);
  }
});

test('week-fixes K4 (his order, 11-13 13:02): applied and worked named together, in any order, asks about applying', async () => {
  const { asksApplied } = await import('./apply/_answers.mjs');
  const p = { ...base(), applyingTo: 'Acme Robotics', appliedHereBefore: true, appliedHereDates: ['2026-09-01T00:00:00Z'] };
  for (const Q of [
    'If you have applied to or worked for Acme Robotics before, select Yes.',
    'If you have applied to or worked for Acme Robotics before, select Yes',
    'Have you applied to or worked for Acme Robotics before?',
    'Have you applied for a position at or worked for Acme Robotics?',
    'Have you ever applied with, or been employed by, Acme Robotics?',
    'If you have worked for or applied to Acme Robotics before, select Yes.',
    'Have you worked for or applied to Acme Robotics before?',
  ]) {
    assert.equal(asksApplied(Q), true, Q);
    assert.equal([].concat(resolveLabel(Q, p).value)[0], 'Yes', `${Q} → ${JSON.stringify(resolveLabel(Q, p))}`);
  }
  // Never applied, never worked there: still No.
  const never = { ...base(), applyingTo: 'Acme Robotics', appliedHereBefore: false, appliedHereDates: [] };
  assert.equal([].concat(resolveLabel('If you have applied to or worked for Acme Robotics before, select Yes.', never).value)[0], 'No');
});

test('…never applied: No', () => {
  const p = { ...base(), applyingTo: 'Prysmian', appliedHereBefore: false, appliedHereDates: [] };
  assert.equal([].concat(resolveLabel('Have you ever applied or worked for Prysmian previously?', p).value)[0], 'No');
  assert.equal([].concat(resolveLabel('Have you previously applied for Prysmian?', p).value)[0], 'No');
  assert.equal([].concat(resolveLabel('Have you applied to Prysmian within the past 6 months?', p).value)[0], 'No');
});

test('a window is read from the application dates; an undated one leaves the box his', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  const Q = 'Have you applied to GLOBAL FOUNDRIES within the past 6 months?';
  const p = (dates) => ({ ...base(), applyingTo: 'GlobalFoundries', appliedHereBefore: dates.length > 0, appliedHereDates: dates, now });
  assert.equal(resolveLabel(Q, p(['2026-08-01T00:00:00Z'])).value, 'Yes');
  assert.equal(resolveLabel(Q, p(['2025-12-01T00:00:00Z'])).value, 'No', 'every application older than the window');
  const r = resolveLabel(Q, p(['2025-12-01T00:00:00Z', null]));
  assert.equal(r.kind, 'unknown', JSON.stringify(r));
  assert.match(r.why, /no date/);
  assert.equal(windowDays('in the last year'), 365.25);
  assert.equal(windowDays('within the past two years') > 700, true);
  assert.equal(windowDays('Have you applied before?'), null);
  assert.equal(appliedHere({ answers: {}, appliedHereBefore: null }, 'x'), undefined, 'employer unknown: the standing answer (none here)');
});

test('applying for a visa is not applying to the employer', () => {
  const r = resolveLabel('Have you applied for an H-1B visa?', { ...base(), applyingTo: 'Acme', appliedHereBefore: true });
  assert.notEqual([].concat(r.value)[0], 'Yes');
});

test('AMAT and Applied Materials are one employer in the store', () => {
  assert.equal(sameEmployer('AMAT', 'Applied Materials'), true);
  assert.equal(sameEmployer('Applied Materials, Inc.', 'Applied Materials'), true);
});

function logWith(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-history-'));
  const file = path.join(dir, 'answer-log.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return pastAnswers({ file });
}
const fin = (o) => ({ at: '2026-10-20T18:00:00Z', kind: 'final', type: 'radio', options: ['Yes', 'No'], ...o });

test('his correction is honoured next time, at the same employer, for a history question', () => {
  // A profile whose rules would say No (no work history), so only his correction can say Yes.
  const p = { ...base(), work_experience: [] };
  p.pastAnswer = logWith([fin({ by: 'you', status: 'changed', company: 'Applied Materials', label: AMAT_Q, answer: 'Yes', engine: 'No' })]);
  const a = one([amatField], p, { company: 'Applied Materials' });
  assert.equal(a.value, 'Yes', JSON.stringify(a));
  assert.equal(a.review, true, 'for his review');
  const d = decide(amatField, AMAT_Q, { ...p, applyingTo: 'Applied Materials' });
  assert.equal(d.rule, 'his-correction');
  assert.match(d.past || '', /correction at Applied Materials \(2026-10-20\) over the engine's "No"/);
  // …not at another employer…
  const b = one([{ ...amatField, label: AMAT_Q.replace('Applied Materials', 'Lam Research') }], p, { company: 'Lam Research' });
  assert.equal(b.value, 'No');
});

test('…an answer he typed where nothing was planned is not a correction of a rule', () => {
  const p = { ...base(), work_experience: [] };
  p.pastAnswer = logWith([fin({ by: 'you', status: 'you answered', company: 'Applied Materials', label: AMAT_Q, answer: 'Yes' })]);
  assert.equal(one([amatField], p, { company: 'Applied Materials' }).value, 'No');
});

test('…and work authorization, IDs and emails are never taken from a correction', () => {
  const SP = 'Will you now or in the future require sponsorship for employment visa status?';
  const ID = 'If you previously worked at Applied Materials, what was your employee ID number?';
  const p = { ...base() };
  p.pastAnswer = logWith([
    fin({ by: 'you', status: 'changed', company: 'Applied Materials', label: SP, answer: 'No', engine: 'Yes' }),
    fin({ by: 'you', status: 'changed', company: 'Applied Materials', label: ID, type: 'text', options: [], answer: '123456', engine: '' }),
  ]);
  const q = { ...p, applyingTo: 'Applied Materials' };
  assert.notEqual(decide({ label: SP, type: 'radio', options: ['Yes', 'No'] }, SP, q).rule, 'his-correction');
  assert.notEqual(decide({ label: ID, type: 'text' }, ID, q).rule, 'his-correction');
  // "Employment"-worded self-ID and sponsorship questions match the history
  // words, and a correction on them is still never reused.
  const VET = 'Prior to your employment with Applied Materials, did you serve as a protected veteran?';
  const SPE = 'Will your employment with Applied Materials require sponsorship now or in the future?';
  const p2 = { ...base(), applyingTo: 'Applied Materials' };
  // A stub, not the log: the log already drops these lines (PAST_NEVER), and
  // this pins the planner's own gate should one ever get through.
  p2.pastAnswer = () => ({ answer: 'Yes', company: 'Applied Materials', at: '2026-10-20T18:00:00Z', corrected: true, engine: 'No' });
  assert.notEqual(decide({ label: VET, type: 'radio', options: ['Yes', 'No'] }, VET, p2).rule, 'his-correction');
  assert.notEqual(decide({ label: SPE, type: 'radio', options: ['Yes', 'No'] }, SPE, p2).rule, 'his-correction');
  const [, id] = planForm([{ label: SP, type: 'radio', options: ['Yes', 'No'] }, { label: ID, type: 'text' }], p, { company: 'Applied Materials' }).actions;
  assert.notEqual(id.value, '123456');
});
