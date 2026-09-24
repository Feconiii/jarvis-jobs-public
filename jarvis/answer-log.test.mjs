#!/usr/bin/env node
// jarvis/answer-log.test.mjs — every answer a form gets is kept, with its cause.
//
// His ask, 2026-09-24: "all answers multiple chjocie and open ended is recorded
// so we can troubleshoot". The case that prompted it is the fixture below: the
// Intuitive Surgical sponsorship question, answered "No" by the visa-HISTORY
// rule (F-549) — a log that names the rule would have shown that in one line.
import fs, { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { logPlan, logWritten, logSnapshot, logReport, logRequest, readLog } from './answer-log.mjs';
import { whichRule } from './apply/_answers.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); } };

console.log('🧪 answer-log: every answer kept, with the rule that gave it');
const dir = mkdtempSync(path.join(tmpdir(), 'answer-log-'));
const file = path.join(dir, 'answer-log.jsonl');
try {
  const SPONSOR = 'Will you now or in the future require sponsorship for employment visa status (e.g./ H-1B visa status)?';
  const fields = [
    { label: 'What is your postal code?', type: 'text' },
    { label: SPONSOR, type: 'radio', options: ['Yes', 'No'] },
  ];
  const actions = [
    { label: fields[0].label, type: 'text', action: 'fill', value: '12345', at: 0 },
    { label: SPONSOR, type: 'radio', action: 'select', optionIndex: 0, value: 'Yes', intended: 'Yes', review: true, at: 1 },
  ];
  const job = { id: 'j1', company: 'Intuitive Surgical', title: 'Manufacturing Engineer' };
  const profile = { answers: { require_sponsorship: 'Yes', held_h1b: 'No' }, identity: { postal_code: '12345' } };
  const url = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Intuitive/publication/x';
  const n = logPlan({ pageUrl: url, job, fields, actions, explain: (l) => whichRule(l, profile), file, now: 1_000_000 });
  ok('one row per answered field', n === 2, `${n}`);

  const again = logPlan({ pageUrl: url, job, fields, actions, explain: (l) => whichRule(l, profile), file, now: 1_000_000 + 60_000 });
  ok('a walk re-planning the same page does not log the same answer twice', again === 0, `${again}`);

  const rows = readLog({ company: 'intuitive', file });
  const sp = rows.find((r) => /sponsorship/.test(r.label));
  ok('the question, its options and the answer are kept', sp && sp.answer === 'Yes' && sp.options.join('|') === 'Yes|No', JSON.stringify(sp));
  ok('…and WHICH RULE gave it — the sponsorship rule, not the visa-history one', sp && /sponsor/.test(sp.rule) && !/held/.test(sp.rule), sp?.rule);
  ok('the postal code is kept as answered', rows.some((r) => /postal/.test(r.label) && r.answer === '12345'));

  logWritten({ job, question: 'Why Intuitive?', text: 'Because the da Vinci line is where …', why: 'motivation', model: 'sonnet', file });
  const w = readLog({ grep: 'why intuitive', file });
  ok('an open-ended answer is kept in full, with the model', w.length === 1 && w[0].kind === 'written' && /da Vinci/.test(w[0].answer) && w[0].model === 'sonnet', JSON.stringify(w));
  ok('a filter that matches nothing returns nothing', readLog({ company: 'nobody', file }).length === 0);

  // ── WHAT WENT OUT AGAINST WHAT WAS PLANNED (his ask, 2026-09-24) ──
  const more = [
    { label: 'Are you 18 or older?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Current employer', type: 'text' },
    { label: 'Desired salary', type: 'text' },
    { label: 'I agree to the privacy policy', type: 'checkbox' },
  ];
  logPlan({ pageUrl: url, job, fields: more, file, now: 2_000_000, actions: [
    { label: more[0].label, action: 'select', optionIndex: 0, value: 'Yes', at: 0 },
    { label: more[1].label, action: 'fill', value: 'Applied Materials', at: 1 },
    { label: more[2].label, action: 'unknown', why: 'pay is yours', at: 2 },
    { label: more[3].label, action: 'check', at: 3 },
  ] });
  const sent = logSnapshot({ pageUrl: url, job, stage: 'submit', button: 'Submit application', by: 'you', file, now: 2_100_000, fields: [
    { label: SPONSOR, type: 'radio', value: 'Yes' },                 // kept
    { label: 'What is your postal code?', type: 'text', value: '99201' }, // changed
    { label: 'Are you 18 or older?', type: 'radio', value: 'Yes' },  // kept
    { label: 'Current employer', type: 'text', value: '' },          // cleared
    { label: 'Desired salary', type: 'text', value: '$85,000' },      // you answered
    { label: 'I agree to the privacy policy', type: 'checkbox', value: 'checked' }, // kept
    { label: 'Middle name', type: 'text', value: '' },               // not planned
  ] });
  ok('every field on the page is recorded as it went out', sent === 7, `${sent}`);
  const fin = Object.fromEntries(readLog({ file, last: 100 }).filter((r) => r.kind === 'final').map((r) => [r.label, r]));
  ok('an answer he left alone is KEPT', fin[SPONSOR]?.status === 'kept' && fin['Are you 18 or older?']?.status === 'kept', JSON.stringify(fin[SPONSOR]));
  ok('an answer he changed is CHANGED, with both values', fin['What is your postal code?']?.status === 'changed'
    && fin['What is your postal code?'].engine === '12345' && fin['What is your postal code?'].answer === '99201', JSON.stringify(fin['What is your postal code?']));
  ok('an answer he removed is CLEARED', fin['Current employer']?.status === 'cleared');
  ok('a question the engine left for him, which he answered, is YOU ANSWERED', fin['Desired salary']?.status === 'you answered', fin['Desired salary']?.status);
  ok('a ticked consent box is kept', fin['I agree to the privacy policy']?.status === 'kept');
  ok('a field the engine never planned says so', fin['Middle name']?.status === 'not planned');
  const diff = readLog({ file, changes: true, last: 100 });
  ok('--changes shows what differed and what was left for him, not what was kept',
    diff.some((r) => r.status === 'changed') && diff.some((r) => r.status === 'you answered') && !diff.some((r) => r.status === 'kept')
    && diff.some((r) => r.kind === 'plan' && r.action === 'unknown'), JSON.stringify(diff.map((r) => r.status || r.action)));

  // 2026-09-24, "are the logs recording everything?": every item a prompt was
  // given, and each run's own report of what it left for him.
  const f2 = path.join(dir, 'more.jsonl');
  logPlan({ pageUrl: 'https://x.wd1.myworkdayjobs.com/a', job: { id: 'j', company: 'Intel', title: 'T' }, file: f2,
    actions: [{ label: 'Type to Add Skills', action: 'prompt', value: 'PLC', values: ['PLC', 'Python', 'GD&T'] }] });
  logReport({ pageUrl: 'https://x.wd1.myworkdayjobs.com/a', job: { id: 'j', company: 'Intel' }, file: f2,
    body: { filled: 7, checked: 2, unanswered: ['step 2: Reading (nothing matched \"Fluent\" — the list offered: Two | Three)'] } });
  const loggedRows = fs.readFileSync(f2, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
  ok('the whole skills list is kept, not just the first', JSON.stringify(loggedRows[0].values) === JSON.stringify(['PLC', 'Python', 'GD&T']));
  ok('the run report is kept with what was left and why', loggedRows[1].kind === 'report' && loggedRows[1].filled === 7 && /the list offered/.test(loggedRows[1].left[0]));
  // "does the logs include what i say when i tell it to rewrite or tweak
  // resume/answers?" (2026-09-24) — they do now, in his words.
  const f3 = path.join(dir, 'asks.jsonl');
  logRequest({ job: { id: 'j', company: 'ABB' }, what: 'resume', request: 'lead with the cobot cell, drop Neuro-T', file: f3 });
  logRequest({ job: { id: 'j', company: 'ABB' }, what: 'answer', question: 'Why ABB?', request: 'shorter, less formal', previous: 'old text', file: f3 });
  logRequest({ job: { id: 'j' }, what: 'letter', request: '   ', file: f3 });
  logWritten({ job: { id: 'j' }, question: 'Why ABB?', text: 'new text', request: 'shorter, less formal', file: f3 });
  const asks = fs.readFileSync(f3, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
  ok('a resume change is kept in his words', asks[0].kind === 'request' && asks[0].what === 'resume' && /cobot cell/.test(asks[0].request));
  ok('an answer rewrite keeps the question, his note and what it replaced', asks[1].label === 'Why ABB?' && asks[1].previous === 'old text');
  ok('an empty request is not a row', asks.length === 3);
  ok('the rewritten answer carries the note that caused it', asks[2].kind === 'written' && asks[2].request === 'shorter, less formal');
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
