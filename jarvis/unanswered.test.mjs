#!/usr/bin/env node
// jarvis/unanswered.test.mjs — the untackled questions log.
//
// His ask, 2026-09-18: record every question the engine could not answer, with
// its options, and say whether it was answerable. The value is entirely in the
// grouping and the verdict — a list that says "protected veteran" three times
// under three spellings, or that calls a blank fill an answer, is a chore
// rather than a work queue.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normaliseQuestion, questionKey, recordUnanswered, listUnanswered, answerability,
  teachesNothing, retireAnswered,
} from './unanswered.mjs';
import { planForm, loadApplyProfile } from './apply-plan.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)}\n    got      ${JSON.stringify(got)}`);
};
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); } };

// ── the statute is not the question ──────────────────────────────────
console.log('🧪 unanswered: the question, not the paragraph around it');

// Quoted from his real Micron form. The question is six words; the label is a
// paragraph of the Vietnam Era Veterans Readjustment Assistance Act.
const MICRON_VET = 'U.S. – Protected Veteran Self-Identification This Employer is a Government contractor '
  + 'subject to the Vietnam Era Veterans Readjustment Assistance Act of 1974, as amended, which requires '
  + 'Government contractors to take affirmative action to employ and advance in employment veterans';
eq('the statute is stripped', normaliseQuestion(MICRON_VET), 'u s protected veteran self identification');
ok('…and what is left is short', normaliseQuestion(MICRON_VET).split(' ').length <= 12);

// ── one question, however it is spelled ──────────────────────────────
console.log('\n🧪 unanswered: three spellings of one question are one row');
const spellings = [MICRON_VET, 'Protected Veteran Status*', 'Are you a protected veteran? (required)'];
eq('all three key to the same concept', [...new Set(spellings.map(questionKey))], ['concept:veteran']);
eq('disability is its own concept',
  questionKey('Voluntary Self-Identification of Disability Form CC-305 OMB Control Number 1250-0005'),
  'concept:disability');
eq('and so is the start date',
  questionKey('When would you be available if an offer was accepted?'), 'concept:start-date');
// A question with no concept keeps its own words, rather than being forced into one.
eq('an unknown question keeps its wording',
  questionKey('Which of our products have you used?'), 'which of our products have you used');

// A FILE INPUT KEYS SEPARATELY (F-537). "Please share links to GitHub,
// portfolio…" is a textarea and "Portfolio - File upload" is a file input; they
// share the concept word and merged into one row, which carries ONE kind. The
// file input was written last and won, so the whole row was judged as an upload
// and the links question stayed listed as unanswerable after it was fixed.
eq('a file upload does not merge with the text question beside it',
  questionKey('Portfolio - File upload', 'file'), 'upload:concept:portfolio');
eq('…while the text question keeps the plain concept key',
  questionKey('Please share links to GitHub, portfolio, publications, or hardware projects', 'textarea'),
  'concept:portfolio');
// NARROW ON PURPOSE: a select and a radio asking one question are still one
// question, which is the whole reason this key exists.
eq('a select and a radio still merge',
  questionKey('Protected Veteran Status*', 'radio'), questionKey('Protected Veteran Status*', 'select'));
eq('and a missing kind behaves as it always did',
  questionKey('Protected Veteran Status*'), 'concept:veteran');

// ── the ledger ───────────────────────────────────────────────────────
console.log('\n🧪 unanswered: counted per employer, never per re-run');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-unans-'));
  const dbPath = path.join(dir, 'jobs.db');
  const vet = {
    label: MICRON_VET, why: 'no answer for this question', kind: 'select',
    options: ['I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN',
      'I AM NOT A PROTECTED VETERAN', 'I DO NOT WISH TO ANSWER'],
  };
  eq('first sighting is recorded', recordUnanswered([vet], { company: 'Micron Technology', dbPath }), 1);
  // Opening the same form again is not a second sighting: a count inflated by
  // re-runs would rank the forms he re-opens above the questions that are common.
  eq('the same form again is not counted twice',
    recordUnanswered([vet], { company: 'Micron Technology', dbPath }), 0);
  eq('a second employer is a second sighting',
    recordUnanswered([{ ...vet, label: 'Protected Veteran Status*' }], { company: 'Lam Research', dbPath }), 1);

  const rows = listUnanswered({ dbPath });
  eq('one row for the concept', rows.length, 1);
  eq('seen twice', rows[0].times, 2);
  eq('at both employers', rows[0].companies.sort(), ['Lam Research', 'Micron Technology']);
  ok('both wordings are kept, because a fix has to match them',
    rows[0].wordings.length === 2, JSON.stringify(rows[0].wordings));
  ok('the options are kept — they are the answer to choose from',
    rows[0].options.includes('I AM NOT A PROTECTED VETERAN'));
  // Windows holds the SQLite file open for as long as the handle is cached, so
  // the tidy-up is best-effort: a temp directory left behind is harmless, and
  // failing the suite over it would be noise.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS still has it */ }
}

// ── was it answerable? ───────────────────────────────────────────────
console.log('\n🧪 unanswered: ours to fix, or genuinely his');
{
  const profile = loadApplyProfile();
  const verdict = (row) => answerability(row, { planForm, profile }).verdict;

  ok('the veteran question is ours — the profile answers it',
    verdict({ label: MICRON_VET, options: ['I AM NOT A PROTECTED VETERAN', 'I DO NOT WISH TO ANSWER'] }) !== 'his');
  // AN EMPTY ANSWER IS NOT AN ANSWER. The first version counted any action that
  // was not `unknown`, and called a field answerable because a rule planned a
  // fill with nothing in it — which IS the question being left.
  //
  // Probed against a profile with the key EMPTY rather than against his real
  // file: the example this guard was written for was "Employee ID(if
  // applicable)", and on 2026-09-20 he decided that one is a deliberate blank,
  // so it retires now for a different and correct reason. Tying the guard to a
  // synthetic profile keeps it about the code instead of about his answers.
  const noSite = { ...loadApplyProfile(), identity: { ...loadApplyProfile().identity, website: '', portfolio: '', github: '' } };
  eq('a blank fill is not an answer',
    answerability({ label: 'Portfolio Link', options: [] }, { planForm, profile: noSite }).verdict, 'his');

  // …and a question he has SETTLED is neither his nor a matcher bug: the answer
  // is nothing, on every form, forever (F-530).
  eq('a deliberate blank counts as answered', verdict({ label: 'Employee ID(if applicable)', options: [] }), 'answerable-now');
  eq('so does a middle-name box', verdict({ label: 'Legal Middle Name', options: [] }), 'answerable-now');

  // THE PROBE USES THE TYPE THE PAGE SENT. Inferring it from the option count
  // made the report lie: "Portfolio - File upload" is a `file` field, and
  // probed as text it answered with his portfolio URL and was ranked as a
  // matcher bug somebody could go and fix. Nobody can — a file input does not
  // take a URL — so the row belonged under "genuinely his" the whole time.
  eq('a file upload is not answered by a URL',
    verdict({ label: 'Portfolio - File upload', kind: 'file', options: [] }), 'his');
}

// ── a sighting that cannot teach anything ────────────────────────────
console.log('\n🧪 unanswered: noise never reaches the ledger');
{
  // The page sent a radio group whose option text did not extract, so the
  // group's LABEL became its first option. Four of these were in his real log
  // — "2024", "Spring", "Yes", "No Selection" — and no fix could ever match
  // them, because nothing about them names a question.
  ok('a control whose options all came back empty',
    teachesNothing({ label: '2024', options: ['', '', '', ''] }));
  ok('…however ordinary the label looks',
    teachesNothing({ label: 'Yes', options: ['', ''] }));
  ok('a password is never answered from a profile, by design',
    teachesNothing({ label: 'Choose Password:', options: [] }));
  // NARROW ON PURPOSE. A question wrongly dropped here is a gap that never
  // gets fixed, which is worse than a line he skims past.
  ok('a real question with real options is kept',
    !teachesNothing({ label: 'Are you a protected veteran?', options: ['Yes', 'No'] }));
  ok('a real question with no options at all is kept',
    !teachesNothing({ label: 'Name of Referrer', options: [] }));
  ok('"Yes"/"No" options are not an empty option list',
    !teachesNothing({ label: 'Have you ever held J-1 status?', options: ['Yes', 'No'] }));

  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-noise-'));
  const dbPath = path.join(dir, 'jobs.db');
  eq('noise is refused at the door',
    recordUnanswered([{ label: 'Spring', options: ['', '', ''] }], { company: 'TSMC', dbPath }), 0);
  eq('nothing was written', listUnanswered({ dbPath }).length, 0);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS still has it */ }
}

// ── a fixed question leaves the list ─────────────────────────────────
console.log('\n🧪 unanswered: a question that is now answered is retired');
{
  const profile = loadApplyProfile();
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-retire-'));
  const dbPath = path.join(dir, 'jobs.db');

  // One the planner answers today, one whose answer is a DELIBERATE BLANK, and
  // one that is still genuinely his.
  //
  // "Employee ID(if applicable)" used to be the genuine gap in this test. It is
  // not one any more, and the change is his: asked directly on 2026-09-20, he
  // said to leave it blank forever and stop flagging it, because an employee ID
  // only exists for a current employee of the company reading the form. So it
  // now retires for the OTHER reason — settled, rather than answerable — and
  // the row kept here is one nothing can answer but him.
  recordUnanswered([{
    label: 'Have you ever held J-1 status?', kind: 'radio', options: ['Yes', 'No'],
  }], { company: 'Amazon', dbPath });
  recordUnanswered([{
    label: 'Employee ID(if applicable)', kind: 'text', options: [],
  }], { company: 'Micron Technology', dbPath });
  recordUnanswered([{
    label: 'Describe a time you disagreed with your manager.', kind: 'text', options: [],
  }], { company: 'Micron Technology', dbPath });
  eq('all three were recorded', listUnanswered({ dbPath }).length, 3);

  const dry = retireAnswered({ planForm, profile, dbPath, dryRun: true });
  eq('the answered one and the settled one are both identified',
    dry.retired.slice().sort(), ['concept:employee-id', 'have you ever held j 1 status']);
  eq('a dry run deletes nothing', listUnanswered({ dbPath }).length, 3);

  retireAnswered({ planForm, profile, dbPath });
  const left = listUnanswered({ dbPath });
  eq('only the question that is genuinely his is left',
    left.map((r) => r.key).filter((k) => !/^concept:employee-id$/.test(k)).length, 1);
  eq('and the deliberate blank is gone',
    left.some((r) => r.key === 'concept:employee-id'), false);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS still has it */ }
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
