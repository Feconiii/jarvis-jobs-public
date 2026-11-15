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
import { logPlan, logWritten, logSnapshot, logReport, logRequest, readLog, pastAnswers } from './answer-log.mjs';
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

  // F-631: a question longer than the 400 characters a plan row keeps
  // (Micron's veteran, sponsorship and terms notices) still meets its plan.
  const fl = path.join(dir, 'long.jsonl');
  const LONG = 'Will you now or in the future require sponsorship? ' + 'This includes H-1B, TN status and job flexibility benefits. '.repeat(10);
  logPlan({ pageUrl: url, job, fields: [{ label: LONG, type: 'prompt' }], file: fl, now: 5_000_000,
    actions: [{ label: LONG, action: 'prompt', value: 'Yes', at: 0 }] });
  logSnapshot({ pageUrl: url, job, stage: 'submit', button: 'Submit', by: 'you', file: fl, now: 5_100_000,
    fields: [{ label: LONG, type: 'prompt', value: 'Yes' }] });
  const longFinal = readLog({ file: fl, last: 10 }).find((r) => r.kind === 'final');
  ok('a question over 400 characters is matched to its plan, not "not planned"', longFinal?.status === 'kept', longFinal?.status);

  // F-820 / F-821: Jarvis's own resume and Lever's own spelling of the city are kept, not his answers.
  const fk = path.join(dir, 'kept.jsonl');
  const lurl = 'https://jobs.lever.co/x/1/apply';
  logPlan({ pageUrl: lurl, job, file: fk, now: 6_000_000, fields: [{ label: 'Resume', type: 'file' }, { label: 'Current location', type: 'text' }],
    actions: [{ label: 'Resume', type: 'file', action: 'upload', at: 0 }, { label: 'Current location', type: 'text', action: 'fill', value: 'Springfield, Washington', at: 1 }] });
  logSnapshot({ pageUrl: lurl, job, stage: 'submit', button: 'Submit application', by: 'you', file: fk, now: 6_100_000,
    fields: [{ label: 'Resume', type: 'file', value: '1 file(s) attached' }, { label: 'Current location', type: 'text', value: 'Springfield, WA, USA' }] });
  const kf = Object.fromEntries(readLog({ file: fk, last: 10 }).filter((r) => r.kind === 'final').map((r) => [r.label, r.status]));
  ok('F-820: the resume Jarvis attached is KEPT, not "you answered"', kf.Resume === 'kept', JSON.stringify(kf));
  ok('F-821: the suggestion row for the same city is KEPT, not "changed"', kf['Current location'] === 'kept', JSON.stringify(kf));
  const fg = path.join(dir, 'ladder.jsonl');
  const gurl = 'https://job-boards.greenhouse.io/x/jobs/1';
  logPlan({ pageUrl: gurl, job, file: fg, now: 7_000_000, fields: [{ label: 'Country', type: 'prompt' }, { label: 'Gender', type: 'prompt' }],
    actions: [{ label: 'Country', type: 'prompt', action: 'prompt', value: 'United States of America', values: ['United States of America', 'United States', 'USA', '+1'], at: 0 },
      { label: 'Gender', type: 'prompt', action: 'prompt', value: 'Male', values: ['Male', 'Man'], at: 1 }] });
  logSnapshot({ pageUrl: gurl, job, stage: 'submit', button: 'Submit application', by: 'you', file: fg, now: 7_100_000,
    fields: [{ label: 'Country', type: 'prompt', value: '+1' }, { label: 'Gender', type: 'prompt', value: 'Female' }] });
  const gf = Object.fromEntries(readLog({ file: fg, last: 10 }).filter((r) => r.kind === 'final').map((r) => [r.label, r.status]));
  ok('F-822: "+1", a spelling on the plan\'s own ladder, is KEPT', gf.Country === 'kept', JSON.stringify(gf));
  ok('F-822: …while a choice off the ladder is still CHANGED', gf.Gender === 'changed', JSON.stringify(gf));

  // F-631: the extension test's fixture pages on the local dashboard are not applications.
  const fx = path.join(dir, 'fixture.jsonl');
  logPlan({ pageUrl: 'http://localhost:4300/__jarvis_fixture_a', job: null, file: fx,
    actions: [{ label: 'First Name', action: 'fill', value: 'Anna Maria Alex' }] });
  ok('a page on localhost writes nothing to his log', !fs.existsSync(fx));

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
  // TWO "First Name" FIELDS ON ONE PAGE (F-609): Workday's Legal Name and
  // Preferred Name. Each final row must be judged against ITS plan — by key,
  // or by page order when the extension sent no key.
  {
    const wf = path.join(dir, 'names.jsonl');
    const wurl = 'https://kla.wd1.myworkdayjobs.com/x/apply';
    const wjob = { id: 'kla1', company: 'KLA', title: 'Engineer' };
    const nf = [
      { label: 'First Name', type: 'text', key: 'formField-legalName--firstName' },
      { label: 'First Name', type: 'text', key: 'formField-preferredName--firstName' },
    ];
    logPlan({ pageUrl: wurl, job: wjob, fields: nf, file: wf, now: 3_000_000, actions: [
      { label: 'First Name', type: 'text', action: 'fill', value: 'Anna Maria Alex', at: 0, key: nf[0].key },
      { label: 'First Name', type: 'text', action: 'fill', value: 'Alex', at: 1, key: nf[1].key },
    ] });
    const read = () => fs.readFileSync(wf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'final');
    logSnapshot({ pageUrl: wurl, job: wjob, stage: 'step', button: 'Save and Continue', by: 'you', file: wf, now: 3_100_000,
      fields: [{ ...nf[1], value: 'Alex' }, { ...nf[0], value: 'Alex' }] });
    const byKey = read();
    ok('by key: the preferred field is judged against "Alex" and kept', byKey.find((r) => r.key === nf[1].key)?.status === 'kept');
    ok('by key: "Alex" typed into the legal field is a change, not "kept" by containment',
      byKey.find((r) => r.key === nf[0].key)?.status === 'changed' && byKey.find((r) => r.key === nf[0].key)?.engine === 'Anna Maria Alex');
    logSnapshot({ pageUrl: wurl, job: wjob, stage: 'submit', button: 'Submit', by: 'you', file: wf, now: 3_200_000,
      fields: [{ label: 'First Name', type: 'text', value: 'Anna Maria Alex' }, { label: 'First Name', type: 'text', value: 'Alex' }] });
    const byOrder = read().filter((r) => r.stage === 'submit');
    ok('with no key, page order pairs them', byOrder.map((r) => `${r.engine}:${r.status}`).join(',') === 'Anna Maria Alex:kept,Alex:kept',
      byOrder.map((r) => `${r.engine}:${r.status}`).join(','));
  }
  {
    // A SPLIT DATE'S BOXES SHARE ONE KEY (F-618): HP's start date logged all
    // three parts against the month's "06", so the year's 2006 read as a
    // change from "06" rather than from "2027".
    const wf = path.join(dir, 'date-parts.jsonl');
    const wurl = 'https://hp.wd5.myworkdayjobs.com/apply/2';
    const wjob = { id: 'hp2', company: 'HP Inc.', title: 'Design Engineer' };
    const key = 'formField-003181317e521000b936f5c3a4410006';
    const label = 'When are you available to start?';
    const df = ['month', 'day', 'year'].map((datePart) => ({ label, type: 'text', key, datePart }));
    logPlan({ pageUrl: wurl, job: wjob, fields: df, file: wf, now: 4_000_000, actions: [
      { label, type: 'text', action: 'fill', value: '06', at: 0, key, datePart: 'month' },
      { label, type: 'text', action: 'fill', value: '01', at: 1, key, datePart: 'day' },
      { label, type: 'text', action: 'fill', value: '2027', at: 2, key, datePart: 'year' },
    ] });
    logSnapshot({ pageUrl: wurl, job: wjob, stage: 'step', button: 'Save and Continue', by: 'jarvis', file: wf, now: 4_100_000,
      fields: [{ ...df[0], value: '6' }, { ...df[1], value: '1' }, { ...df[2], value: '2006' }] });
    const rows = fs.readFileSync(wf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'final');
    const got = rows.map((r) => `${r.datePart}:${r.engine}>${r.answer}:${r.status}`).join(',');
    ok('each date part is judged against its own plan, "06" and "6" the same', got === 'month:06>6:kept,day:01>1:kept,year:2027>2006:changed', got);
  }
  {
    // WHAT COUNTS AS HIS ANSWER TO REUSE (F-618): not a menu's own pick that
    // Jarvis pressed past, and never a self-identification question.
    const pf = path.join(dir, 'past.jsonl');
    const row = (label, answer, status, by) => JSON.stringify({ at: '2026-09-26T10:36:37Z', kind: 'final', by, host: 'hp.wd5.myworkdayjobs.com', pageUrl: 'https://hp.wd5.myworkdayjobs.com/x', company: 'HP Inc.', label, type: 'prompt', answer, status });
    fs.writeFileSync(pf, [
      row('Are you a protected U.S. Military Veteran?', 'I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN', 'you answered', 'you'),
      row('What shift do you prefer to work?', 'Days', 'changed', 'jarvis'),
      row('Which office would you prefer to work from?', 'Palo Alto', 'changed', 'you'),
    ].join('\n') + '\n');
    const past = pastAnswers({ file: pf });
    ok('a veteran answer is never reused', past('Are you a protected U.S. Military Veteran?', 'HP Inc.') === null);
    ok('a change Jarvis pressed past is not his answer', past('What shift do you prefer to work?', 'HP Inc.') === null);
    ok('a change he pressed past is', past('Which office would you prefer to work from?', 'HP Inc.')?.answer === 'Palo Alto');
  }
  {
    // WORK AUTHORIZATION IS NEVER BORROWED (his answer, 2026-11-04): his
    // 2026-09-26 Yes on Intuitive's "without restrictions" must not come back.
    const pf = path.join(dir, 'auth.jsonl');
    const row = (label, answer) => JSON.stringify({ at: '2026-09-26T10:00:00Z', kind: 'final', by: 'you', host: 'jobs.smartrecruiters.com', pageUrl: 'https://jobs.smartrecruiters.com/Intuitive/x', company: 'Intuitive', label, type: 'prompt', answer, status: 'changed' });
    fs.writeFileSync(pf, [
      row('Are you legally authorized to work in the country where the job is located without restrictions?', 'Yes'),
      row('Will you now or in the future require sponsorship for employment visa status?', 'No'),
      row('Are you eligible to work in the US for any employer?', 'Yes'),
      row('Which office would you prefer to work from?', 'Sunnyvale'),
      row('Do you authorize us to conduct a background check?', 'Yes'),
      row('Do you have any dietary or travel restrictions?', 'None'),
      row('Would you like to opt in to text message updates?', 'Yes'),
    ].join('\n') + '\n');
    const past = pastAnswers({ file: pf });
    // …and the list stays narrow (review): these are not work authorization.
    ok('a background-check authorization is still his answer', past('Do you authorize us to conduct a background check?', 'Intuitive')?.answer === 'Yes');
    ok('dietary or travel restrictions still are', past('Do you have any dietary or travel restrictions?', 'Intuitive')?.answer === 'None');
    ok('an opt-in still is', past('Would you like to opt in to text message updates?', 'Intuitive')?.answer === 'Yes');
    ok('"without restrictions" Yes at Intuitive is never his answer again, even at Intuitive',
      past('Are you legally authorized to work in the country where the job is located without restrictions?', 'Intuitive') === null);
    ok('…nor a sponsorship answer', past('Will you now or in the future require sponsorship for employment visa status?', 'Intuitive') === null);
    ok('…nor "eligible to work for any employer"', past('Are you eligible to work in the US for any employer?', 'Intuitive') === null);
    ok('an ordinary question at the same employer still is', past('Which office would you prefer to work from?', 'Intuitive')?.answer === 'Sunnyvale');
  }
  {
    // …NOR EXPORT CONTROL, CITIZENSHIP OR CLEARANCE IN OTHER WORDS (week review
    // F1, 2026-11-13): the reader kept these, so an old Yes was his "answer".
    const pf = path.join(dir, 'auth2.jsonl');
    const Qs = ['Are you legally allowed to work in the U.S.?', 'Are you a U.S. person as defined by ITAR/EAR?', 'Are you a foreign national?',
      'Do you hold an active security clearance?', 'Will you have access to export-controlled technology?', 'What is your nationality?',
      'Do you have the right to work in the United States?',
      // week-fixes J2: two more ways forms ask it.
      'Do you have current employment authorization in the U.S.?', 'Are you eligible for employment in the United States?'];
    const row = (label, answer) => JSON.stringify({ at: '2026-09-26T10:00:00Z', kind: 'final', by: 'you', host: 'jobs.smartrecruiters.com', pageUrl: 'https://jobs.smartrecruiters.com/Intuitive/x', company: 'Intuitive', label, type: 'radio', answer, status: 'you answered' });
    fs.writeFileSync(pf, [...Qs.map((q) => row(q, 'Yes')), row('Do you hear about us from a friend?', 'No')].join('\n') + '\n');
    const past = pastAnswers({ file: pf });
    for (const q of Qs) ok(`never his answer again: ${q}`, past(q, 'Intuitive') === null, JSON.stringify(past(q, 'Intuitive')));
    ok('a question that only contains the letters "ear" still is', past('Do you hear about us from a friend?', 'Intuitive')?.answer === 'No');
  }
  {
    // THE SAME QUESTION IN OTHER WORDS (step 3, 2026-10-03): the employer's
    // name masked, nearly the same words — but never his relation to one
    // employer carried to another.
    const pf = path.join(dir, 'shape.jsonl');
    const row = (company, label, answer) => JSON.stringify({ at: '2026-10-03T10:00:00Z', kind: 'final', by: 'you', host: 'x', pageUrl: 'https://x.example/apply', company, label, type: 'radio', answer, status: 'you answered' });
    fs.writeFileSync(pf, [
      row('John Deere', 'Do you currently, or have you in the past, worked for a company that has supplied contingent workers to John Deere?', 'N/A'),
      row('Applied Materials', 'Have you ever worked for Applied Materials as an employee or intern?', 'Yes'),
      row('Flowserve', 'Are you open to business travel?', '25%'),
    ].join('\n') + '\n');
    const past = pastAnswers({ file: pf });
    ok('a supplier question names the employer and its relation, so it stays with John Deere',
      past('Do you currently or have you in the past worked for a company that supplied contingent workers to Plug Power?', 'Plug Power') === null);
    ok('"worked for <co>" Yes at Applied Materials is NEVER his answer at another employer',
      past('Have you ever worked for Plug Power as an employee or intern?', 'Plug Power') === null);
    ok('…and still his answer at Applied Materials itself',
      past('Have you ever worked for Applied Materials as an employee or intern?', 'Applied Materials')?.answer === 'Yes');
    ok('a plain question in nearly the same words borrows from one other employer',
      past('Are you open to business travel for this role?', 'Plug Power')?.answer === '25%');
    ok('a negated question never borrows from its positive twin',
      past('Are you not open to business travel?', 'Plug Power') === null);
  }
  {
    // READ ONCE (S1, 2026-11-06): every plan appends to the log, and the whole
    // 15 MB was parsed again per step. Only what was appended is read now.
    const pf = path.join(dir, 'grow.jsonl');
    const row = (label, answer) => JSON.stringify({ at: '2026-11-06T10:00:00Z', kind: 'final', by: 'you', host: 'x', pageUrl: 'https://x.example/apply', company: 'Acme', label, type: 'radio', answer, status: 'you answered' });
    fs.writeFileSync(pf, row('Which office would you prefer to work from?', 'Austin') + '\n');
    const first = pastAnswers({ file: pf });
    ok('the first read finds his answer', first('Which office would you prefer to work from?', 'Acme')?.answer === 'Austin');
    fs.appendFileSync(pf, JSON.stringify({ kind: 'plan', label: 'x' }) + '\n');
    ok('a plan line appended leaves the same index', pastAnswers({ file: pf }) === first);
    fs.appendFileSync(pf, row('What shift do you prefer to work?', 'Days') + '\n' + row('Which office would you prefer to work from?', 'Denver').slice(0, 40));
    const grown = pastAnswers({ file: pf });
    ok('an appended answer is found', grown('What shift do you prefer to work?', 'Acme')?.answer === 'Days');
    ok('a half-written line is not read yet', grown('Which office would you prefer to work from?', 'Acme')?.answer === 'Austin');
    fs.appendFileSync(pf, row('Which office would you prefer to work from?', 'Denver').slice(40) + '\n');
    ok('…and is read once it is whole, the later answer winning', pastAnswers({ file: pf })('Which office would you prefer to work from?', 'Acme')?.answer === 'Denver');
    // THE INCREMENTAL INDEX against a fresh read of the same bytes (review): many
    // appends, in pieces cut at odd places, one of them inside a character of
    // several bytes, some lines ending in CRLF.
    const qs = [];
    for (let i = 0; i < 12; i += 1) qs.push([`Which tool do you know best, number ${i}?`, `Tool ${i} ${i % 3 ? 'é' : '日本'}`]);
    const bytes = Buffer.from(qs.map(([q, a], i) => row(q, a) + (i % 2 ? '\r\n' : '\n')).join(''), 'utf-8');
    // One cut falls inside the 3-byte 日 of answer 3, whatever the row lengths are.
    const inside = bytes.indexOf(Buffer.from('日', 'utf-8'), bytes.indexOf(Buffer.from('number 3?', 'utf-8'))) + 1;
    const cuts = [...new Set([37, 300, inside, 999, Math.floor(bytes.length * 0.7), bytes.length])].filter((c) => c > 0 && c <= bytes.length).sort((a, b) => a - b);
    let inc = null;
    let at = 0;
    for (const c of cuts) {
      fs.appendFileSync(pf, bytes.subarray(at, c));
      at = c;
      inc = pastAnswers({ file: pf });   // the same file, read only past the last offset each time
    }
    const copy = path.join(dir, 'grow-copy.jsonl');
    fs.copyFileSync(pf, copy);
    const fresh = pastAnswers({ file: copy });
    const all = [['Which office would you prefer to work from?'], ['What shift do you prefer to work?'], ...qs];
    ok('incremental and fresh reads agree on every answer', all.every(([q]) => inc(q, 'Acme')?.answer === fresh(q, 'Acme')?.answer && fresh(q, 'Acme')),
      JSON.stringify(all.map(([q]) => [inc(q, 'Acme')?.answer, fresh(q, 'Acme')?.answer])));
    ok('a character of several bytes split across two reads arrives whole', inc(qs[3][0], 'Acme')?.answer === qs[3][1]);
    ok('a CRLF line is read', inc(qs[1][0], 'Acme')?.answer === qs[1][1]);
    // A rotation (the log moved to .1, a new one started) reads both again,
    // here with the new log already LONGER than where the last read stopped.
    const before = fs.statSync(pf).size;
    fs.renameSync(pf, pf.replace(/\.jsonl$/, '.1.jsonl'));
    fs.writeFileSync(pf, row('Are you open to business travel?', '10%') + '\n' + 'x'.repeat(before) + '\n');
    const rot = pastAnswers({ file: pf });
    ok('after a rotation the old answers are still there', rot('What shift do you prefer to work?', 'Acme')?.answer === 'Days');
    ok('…with the new log\'s, though it is longer than the old offset', rot('Are you open to business travel?', 'Acme')?.answer === '10%');
  }
  {
    // A LOG CUT SHORT OR REWRITTEN IN PLACE is read again from the start (review).
    const pf = path.join(dir, 'cut.jsonl');
    const row = (label, answer) => JSON.stringify({ at: '2026-11-06T10:00:00Z', kind: 'final', by: 'you', host: 'x', pageUrl: 'https://x.example/apply', company: 'Acme', label, type: 'radio', answer, status: 'you answered' });
    fs.writeFileSync(pf, row('Which office would you prefer to work from?', 'Austin') + '\n' + row('What shift do you prefer to work?', 'Days') + '\n');
    ok('read', pastAnswers({ file: pf })('What shift do you prefer to work?', 'Acme')?.answer === 'Days');
    fs.writeFileSync(pf, row('Are you open to business travel?', '5%') + '\n');   // shorter, same file id
    const cut = pastAnswers({ file: pf });
    ok('a truncated log (no rotation) forgets what it no longer holds', cut('What shift do you prefer to work?', 'Acme') === null);
    ok('…and holds what it does', cut('Are you open to business travel?', 'Acme')?.answer === '5%');
    // The same file, rewritten in place, as long or longer: a different first line.
    const longer = row('Are you open to relocation?', 'Yes, anywhere') + '\n' + row('What shift do you prefer to work?', 'Nights') + '\n';
    fs.writeFileSync(pf, longer);
    const re = pastAnswers({ file: pf });
    ok('a log rewritten in place at a larger size is read from the start, not from the old offset', re('Are you open to relocation?', 'Acme')?.answer === 'Yes, anywhere' && re('Are you open to business travel?', 'Acme') === null);
    // A complete last record with no newline (a write cut after the record).
    const nl = path.join(dir, 'no-newline.jsonl');
    fs.writeFileSync(nl, row('Which office would you prefer to work from?', 'Boston'));
    ok('a whole read takes a complete last record that has no newline', pastAnswers({ file: nl })('Which office would you prefer to work from?', 'Acme')?.answer === 'Boston');
    fs.appendFileSync(nl, '\n' + row('What shift do you prefer to work?', 'Swing') + '\n');
    const nl2 = pastAnswers({ file: nl });
    ok('…and once it ends, the next line is read after it', nl2('What shift do you prefer to work?', 'Acme')?.answer === 'Swing' && nl2('Which office would you prefer to work from?', 'Acme')?.answer === 'Boston');
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
