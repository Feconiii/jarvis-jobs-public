#!/usr/bin/env node
// jarvis/answer-log.mjs — every answer the engine gives a form, kept.
//
// His ask, 2026-09-24, after an Intuitive Surgical form said he would NOT need
// sponsorship and that he had no postal code: "lets make it so that, all
// answers multiple choice and open ended is recorded so we can troubleshoot".
// Until then the only record was plans.jsonl, which keeps the last twenty
// plans and is overwritten as a walk goes — the Intuitive plans survived by
// luck, and a dashboard restart loses the in-memory context entirely.
//
// One append-only file, one line per answer:
//   kind: 'plan'     — what the planner decided for a field: the question, its
//                      options, the action, the answer, and WHICH RULE gave it
//   kind: 'written'  — an open-ended answer the writer produced, in full
//   kind: 'final'    — the form as it stood when Next or Submit was pressed,
//                      each field beside the engine's answer: kept · changed ·
//                      cleared · you answered · left blank · edited · not planned
// Never fails a fill; a log that cannot be written is skipped.
//
// Reading it:
//   node jarvis/answer-log.mjs                       the last 40 answers
//   node jarvis/answer-log.mjs --changes             only what differed from the plan, or went unanswered
//   node jarvis/answer-log.mjs --company intuitive   one employer
//   node jarvis/answer-log.mjs --grep sponsor        questions matching a pattern
//   node jarvis/answer-log.mjs --since 2026-09-24 --last 200
import { chooseOption } from './apply/_form.mjs';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import { STORE_DIR } from './store.mjs';

export const ANSWER_LOG = path.join(STORE_DIR, 'answer-log.jsonl');
const MAX_BYTES = 25 * 1024 * 1024;   // then rotated to answer-log.1.jsonl
const SEEN = new Map();                // a walk re-plans the same page; log each answer once per half hour
const SEEN_MS = 30 * 60 * 1000;

function append(rows, file = ANSWER_LOG) {
  if (!rows.length) return 0;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return rows.length;
  } catch { return 0; }
}

const host = (u) => { try { return new URL(String(u)).host; } catch { return ''; } };

/**
 * One row per planned field. `explain(label)` names the rule that answered it
 * (apply/_answers.mjs whichRule), so a wrong answer points at its cause.
 */
export function logPlan({ pageUrl = '', job = null, fields = [], actions = [], explain = null, file = ANSWER_LOG, now = Date.now() } = {}) {
  const rows = [];
  for (const a of actions || []) {
    if (!a || !a.label) continue;
    const f = Number.isInteger(a.at) ? fields[a.at] : null;
    const options = Array.isArray(f?.options) ? f.options.slice(0, 25).map((o) => String(o?.text ?? o).slice(0, 80)) : [];
    const answer = a.value != null ? String(a.value)
      : (Number.isInteger(a.optionIndex) && options[a.optionIndex] != null ? options[a.optionIndex] : '');
    const sig = `${pageUrl}|${a.label}|${a.action}|${answer}`;
    if (SEEN.has(sig) && now - SEEN.get(sig) < SEEN_MS) continue;
    SEEN.set(sig, now);
    let rule = null;
    try { rule = explain ? explain(a.label) : null; } catch { rule = null; }
    rows.push({
      at: new Date(now).toISOString(), kind: 'plan', host: host(pageUrl), pageUrl: String(pageUrl).slice(0, 300),
      jobId: job?.id ?? null, company: job?.company || '', title: job?.title || '',
      label: String(a.label).slice(0, 400), type: a.type || f?.type || '', options,
      action: a.action || '', answer: answer.slice(0, 2000), intended: a.intended ?? null,
      // Every item or alternative a prompt was given (a skills list, a
      // fluency ladder), not just the first (2026-09-24: "are the logs
      // recording everything?").
      ...(Array.isArray(a.values) && a.values.length ? { values: a.values.slice(0, 40).map((v) => String(v).slice(0, 120)) } : {}),
      review: !!a.review, why: String(a.why || '').slice(0, 300), rule,
    });
  }
  return append(rows, file);
}

/**
 * WHAT THE RUN SAYS HAPPENED, once per fill (2026-09-24). The plan says what
 * the engine meant to do and the final snapshot what the form held when he
 * pressed on; this is the middle — how many landed, and every field it left
 * for him with the reason ("nothing matched … the list offered: A | B"). The
 * dashboard kept only the latest run's list, overwritten by the next.
 */
export function logReport({ pageUrl = '', job = null, body = {}, file = ANSWER_LOG, now = Date.now() } = {}) {
  const list = (x) => (Array.isArray(x) ? x : []);
  const row = {
    at: new Date(now).toISOString(), kind: 'report', host: host(pageUrl), pageUrl: String(pageUrl).slice(0, 300),
    jobId: job?.id ?? null, company: job?.company || '', title: job?.title || '',
    filled: Number(body.filled) || 0, checked: Number(body.checked) || 0, uploaded: !!body.uploaded,
    reachedReview: !!body.reachedReview,
    left: list(body.unanswered).map((u) => (typeof u === 'string' ? u : `${u.label || ''}${u.why ? ` — ${u.why}` : ''}`).slice(0, 600)),
    stoppedBecause: String(body.stoppedBecause || body.note || '').slice(0, 300),
  };
  return append([row], file);
}

/** One row per open-ended answer the writer finished — the full text. */
export function logWritten({ job = null, question = '', text = '', why = '', model = null, kind = null, pageUrl = '', request = '', file = ANSWER_LOG, now = Date.now() } = {}) {
  return append([{
    at: new Date(now).toISOString(), kind: 'written', host: host(pageUrl), pageUrl: String(pageUrl).slice(0, 300),
    jobId: job?.id ?? null, company: job?.company || '', title: job?.title || '',
    label: String(question).slice(0, 600), questionKind: kind, answer: String(text || ''), why: String(why || '').slice(0, 300), model,
    // What he asked for, when this answer was written because he asked.
    ...(String(request || '').trim() ? { request: String(request).trim().slice(0, 1200) } : {}),
  }], file);
}

/**
 * WHAT HE SAID WHEN HE ASKED FOR A REWRITE (2026-09-24: "does the logs include
 * what i say when i tell it to rewrite or tweak resume/answers?" — they did
 * not). One row per request, in his words, the moment he makes it: an answer
 * rewritten with a note, a resume rebuilt with "change the resume", a letter
 * redone with a request. Written before the rewrite runs, so a rewrite that
 * fails still leaves what he asked for.
 */
export function logRequest({ job = null, what = '', question = '', request = '', previous = '', pageUrl = '', file = ANSWER_LOG, now = Date.now() } = {}) {
  const said = String(request || '').trim();
  if (!said) return 0;
  return append([{
    at: new Date(now).toISOString(), kind: 'request', what: String(what || ''), host: host(pageUrl), pageUrl: String(pageUrl).slice(0, 300),
    jobId: job?.id ?? null, company: job?.company || '', title: job?.title || '',
    label: String(question || '').slice(0, 600), request: said.slice(0, 1200),
    ...(String(previous || '').trim() ? { previous: String(previous).slice(0, 4000) } : {}),
  }], file);
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The engine's last word on each question for this job or site, from the log's tail. */
function plannedFor({ job, pageUrl, file, now }) {
  const out = new Map();
  if (!existsSync(file)) return out;
  const text = readFileSync(file, 'utf-8');
  const tail = text.length > 4_000_000 ? text.slice(-4_000_000) : text;
  const h = host(pageUrl);
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  for (const line of tail.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.kind !== 'plan' && r.kind !== 'written') continue;
    if (String(r.at) < since) continue;
    const same = job?.id != null && r.jobId != null ? String(r.jobId) === String(job.id) : r.host === h;
    if (!same) continue;
    const k = norm(r.label);
    const prev = out.get(k) || {};
    // A written answer is the text for an essay the plan only named.
    out.set(k, r.kind === 'written' ? { ...prev, written: r.answer } : { ...prev, plan: r });
  }
  return out;
}

/**
 * WHAT WENT OUT AGAINST WHAT WAS PLANNED. His ask, 2026-09-24: "record which
 * questions were unasnwered/changed from what it answerred versus when i
 * submitted". The extension reads every field as Next or Submit is pressed;
 * each becomes a `final` row carrying the engine's answer beside his, and one
 * of: kept · changed · cleared · you answered · left blank · edited · not planned.
 */
export function logSnapshot({ pageUrl = '', job = null, stage = 'step', button = '', by = '', fields = [], file = ANSWER_LOG, now = Date.now() } = {}) {
  const planned = plannedFor({ job, pageUrl, file, now });
  const rows = [];
  for (const f of fields || []) {
    if (!f?.label) continue;
    const final = String(f.value ?? '').trim();
    const p = planned.get(norm(f.label)) || {};
    const plan = p.plan;
    let engine = plan ? String(plan.answer || '') : '';
    if (plan?.action === 'essay') engine = p.written || '';
    let status;
    // WORKDAY FILLED IT, NOT HIM (2026-09-24). A field the engine left alone
    // because it was "already set" read as "you answered" — Country, Phone
    // Device Type, Degree, Language on every Workday form — and the list of
    // mistakes looked three times longer than it was.
    const had = plan?.action === 'skip' ? String(plan.why || '').match(/already set to "(.*)"$/)?.[1] : null;
    // THE SAME ANSWER IN THE FORM'S WORDS. "No" chosen as "Not Hispanic or
    // Latino", "Native or Bilingual" as "5 - Fluent": the matcher that picked
    // the option is the judge of whether the option is the answer.
    const same = (a, b) => { try { return !!a && !!b && chooseOption(a, [b]) === 0; } catch { return false; } };
    if (!plan) status = 'not planned';
    else if (had != null && final && norm(final) === norm(had)) status = 'already there';
    else if (plan.action === 'unknown' || plan.action === 'skip' || (!engine && plan.action !== 'check')) status = final && final !== 'unchecked' ? 'you answered' : 'left blank';
    else if (plan.action === 'check') status = final === 'checked' ? 'kept' : (final === 'unchecked' ? 'cleared' : 'changed');
    else if (!final) status = 'cleared';
    else if (plan.action === 'essay') status = norm(final).slice(0, 300) === norm(engine).slice(0, 300) ? 'kept' : 'edited';
    else status = norm(final) === norm(engine) || norm(final).includes(norm(engine)) && norm(engine).length > 2 || same(engine, final) ? 'kept' : 'changed';
    const sig = `final|${pageUrl}|${f.label}|${final}`;
    if (SEEN.has(sig) && now - SEEN.get(sig) < SEEN_MS) continue;
    SEEN.set(sig, now);
    rows.push({
      at: new Date(now).toISOString(), kind: 'final', stage, button: String(button).slice(0, 80), by,
      host: host(pageUrl), pageUrl: String(pageUrl).slice(0, 300),
      jobId: job?.id ?? null, company: job?.company || '', title: job?.title || '',
      label: String(f.label).slice(0, 400), type: f.type || '', options: Array.isArray(f.options) ? f.options.slice(0, 25) : [],
      answer: final.slice(0, 4000), engine: engine.slice(0, 4000), engineAction: plan?.action || null,
      status, rule: plan?.rule || null,
    });
  }
  return append(rows, file);
}

/** Rows, newest last, filtered. */
export function readLog({ company = '', grep = '', since = '', last = 40, changes = false, file = ANSWER_LOG } = {}) {
  const lines = [];
  for (const f of [file.replace(/\.jsonl$/, '.1.jsonl'), file]) {
    if (existsSync(f)) lines.push(...readFileSync(f, 'utf-8').split('\n').filter(Boolean));
  }
  const re = grep ? new RegExp(grep, 'i') : null;
  const co = String(company).toLowerCase();
  const rows = [];
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (since && String(r.at) < since) continue;
    if (co && !String(r.company).toLowerCase().includes(co) && !String(r.host).toLowerCase().includes(co) && !String(r.pageUrl).toLowerCase().includes(co)) continue;
    if (re && !re.test(r.label) && !re.test(r.answer)) continue;
    // --changes: only what went out differently from the plan, or unanswered.
    if (changes && !(r.kind === 'final' ? r.status !== 'kept' : r.action === 'unknown')) continue;
    rows.push(r);
  }
  return rows.slice(-last);
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : ''; };
  const rows = readLog({ company: arg('--company'), grep: arg('--grep'), since: arg('--since'), last: Number(arg('--last')) || 40, changes: process.argv.includes('--changes') });
  if (!rows.length) { console.log('no answers recorded that match'); process.exit(0); }
  for (const r of rows) {
    const where = `${String(r.at).slice(0, 16).replace('T', ' ')}  ${r.company || r.host}${r.title ? ` — ${r.title}` : ''}`;
    console.log(`\n${where}`);
    console.log(`  Q: ${r.label}`);
    if (r.options?.length) console.log(`     options: ${r.options.join(' | ')}`);
    if (r.kind === 'final') {
      const cut = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 200) || '(blank)';
      console.log(`  ${String(r.status).toUpperCase()} at ${r.stage}${r.by ? ` (pressed by ${r.by})` : ''}`);
      console.log(`     Jarvis: ${r.engineAction === 'unknown' ? '(left for you)' : cut(r.engine)}`);
      console.log(`     sent:   ${cut(r.answer)}`);
      if (r.rule) console.log(`     rule: /${r.rule}/`);
      continue;
    }
    console.log(`  A: ${r.kind === 'written' ? r.answer.replace(/\s+/g, ' ').slice(0, 400) : (r.answer || `(${r.action})`)}${r.review ? '   [review]' : ''}`);
    if (r.rule) console.log(`     rule: /${r.rule}/`);
    else if (r.why) console.log(`     why: ${r.why}`);
  }
}
