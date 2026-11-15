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
import { chooseOption, WORK_AUTH_WORDS_RE } from './apply/_form.mjs';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'fs';
import path from 'path';
import { STORE_DIR } from './store.mjs';
import { isHarnessPage } from './harness-pages.mjs';

export const ANSWER_LOG = path.join(STORE_DIR, 'answer-log.jsonl');
const MAX_BYTES = 25 * 1024 * 1024;   // then rotated to answer-log.1.jsonl
const SEEN = new Map();                // a walk re-plans the same page; log each answer once per half hour
const SEEN_MS = 30 * 60 * 1000;

// NO APPLICATION LIVES ON THIS MACHINE (F-631). The extension test fills
// fixture pages served at localhost:4300/__jarvis_fixture_*, through the live
// dashboard, and every run wrote "First Name: Anna Maria Alex" rows into his log —
// rows that the replay counts and the past-answer reuse could hand back.
// F-1029: the harness's own posting address too, and any row marked harness
// (harness-pages.mjs holds the list the tests use).
function append(rows, file = ANSWER_LOG) {
  rows = rows.filter((r) => !isHarnessPage(r?.pageUrl) && r?.harness !== true);
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
 * HIS OWN ANSWERS, REUSED (2026-09-25). Intel's questionnaire asks the same
 * five questions on every Intel application — an Ernst & Young family member,
 * intellectual property, the Department of Defense, "if hired, do you
 * intend to…", citizenship countries — and no rule knows them. Each time the
 * engine left them and he typed the same answers again.
 *
 * So the answers he sent become the answer to the same question next time:
 * the answer-log's `final` rows where the form held HIS answer (he typed it,
 * or changed the engine's). Same employer first; another employer's answer
 * only when he gave that same answer at two or more employers. Never codes,
 * passwords, dates, signatures, files or prose. Always marked for review.
 *
 * @returns (label, company) => { answer, company, at } | null
 */
// Self-identification follows his profile's policy, never a past form (F-618).
// …AND SO DOES WORK AUTHORIZATION (his answer, 2026-11-04): "authorized to work
// … without restrictions?" is No, and his 2026-09-26 Yes on Intuitive's form
// must never come back as "your own earlier answer". Sponsorship, visa,
// citizenship and authorization questions follow the rules in _answers.mjs only.
const PAST_NEVER = new RegExp(`${/\b(otp|one[- ]time|verification|passcode|password|captcha|security\s+code|pin)\b|\bdate\b|\bsignature\b|\bsign\s+(here|below)\b|\bupload\b|\bresume\b|\bcover\s+letter\b|\bveteran|\bdisabilit|\bgender\b|\brace\b|\bethnic|\bhispanic|\blatin[oax]\b|\bsexual\s+orientation|\bpronoun|\btransgender|\bsex\b/.source}|${WORK_AUTH_WORDS_RE.source}`, 'i');
// (Review, 2026-11-04: narrow on purpose. "I authorize a background check",
// "any dietary or travel restrictions?" and "opt in to texts" are still his
// to have answered from a past form.)
// …and UKG's spellings of the same row boxes (F-800): "Company / Organization",
// "Year (YYYY)", "From month", "To year", "School Name", "Level of Education /
// Degree" were learned from UKG's own resume parse and put into every row.
const PAST_ENTRY = /^(title|job title|company|employer|employer name|company\s*\/\s*organi[sz]ation|organi[sz]ation|from|to|start|end|((from|to|start|end)(\s+date)?\s+)?(month|year|day)(\s*\(\s*(mm|yyyy|dd)\s*\))?|description|summary|experience summary|headline|location|office location|i currently (work|attend)[a-z ]*|school|school name|school location|degree|level of education(\s*\/\s*degree)?|field of study|major|minor|city|state|country|country code|date completed|gpa|industry|suffix)\s*\*?$/i;
const normQ = (s) => String(s || '').toLowerCase().replace(/[“”"'’]/g, '').replace(/\s+/g, ' ').replace(/^\s*\d+[a-z]?\)\s*\*?\s*/, '').trim();
const normCo = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/(inc|llc|corp|corporation|company|co|ltd|technologies|technology)$/, '');
let PAST = { file: '', rotStamp: '', size: 0, byQ: null, index: null };
// Words a question is made of that do not change what it asks.
const SHAPE_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'at', 'on', 'by', 'with', 'any', 'its', 'your', 'you', 'are', 'is', 'be', 'been', 'have', 'has', 'do', 'does', 'did', 'will', 'would', 'currently', 'please', 'this', 'that', 'our', 'us', 'we', 'company', 'organization', 'employer', 'select', 'one', 'following', 'which', 'if', 'as', 'from', 'all', 'apply', 'e', 'g', 'eg', 'ie', 'i']);
const NEGATION = /\b(not|never|no|without|non|nor|unable|cannot|can't|don't|haven't|won't|isn't)\b/g;
/** A question with its employer masked and its filler gone: the key, its words, negations, numbers. */
export function shapeOf(q, company = '') {
  let s = String(q || '').toLowerCase();
  const co = String(company || '').toLowerCase().replace(/[,.]?\s+(inc|llc|ltd|corp|corporation|company|co)\.?$/, '').trim();
  if (co.length >= 3) {
    s = s.split(co).join(' <co> ');
    for (const w of co.split(/[^a-z0-9]+/).filter((x) => x.length >= 4)) s = s.replace(new RegExp(`\\b${w}\\b`, 'g'), ' <co> ');
  }
  s = s.replace(/<co>(\s*<co>)+/g, '<co>');
  const neg = (s.match(NEGATION) || []).sort().join(',');
  const nums = (s.match(/\d+/g) || []).join(',');
  const tokens = [...new Set(s.replace(/[^a-z0-9<> ]+/g, ' ').split(/\s+/).filter((t) => t && (t === '<co>' || (t.length >= 3 && !SHAPE_STOP.has(t)))))].sort();
  return { key: tokens.length >= 3 ? tokens.join(' ') : '', tokens, neg, nums };
}
const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); let n = 0; for (const x of A) if (B.has(x)) n += 1; return n / (A.size + B.size - n || 1); };
/**
 * The bytes appended to `file` since `from`, up to the last whole line.
 * `end` is where the next read starts (a half-written last line waits);
 * `rest` is that unterminated line. Cut at a newline byte, so a character
 * of several bytes is never split.
 */
function readAppended(file, from, size) {
  if (size <= from) return { text: '', end: from, rest: '' };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    const got = buf.subarray(0, n);
    const nl = got.lastIndexOf(0x0a);
    if (nl < 0) return { text: '', end: from, rest: got.toString('utf-8') };
    return { text: got.subarray(0, nl).toString('utf-8'), end: from + nl + 1, rest: got.subarray(nl + 1).toString('utf-8') };
  } finally { closeSync(fd); }
}

/**
 * HIS ANSWERS, READ ONCE (S1, 2026-11-06). Every plan appends to this log, so
 * a cache keyed by its size was stale on every step and the whole log (15 MB,
 * ~100-150 ms, more when the machine pages) was parsed again per /api/plan.
 * Now only what was appended is read; a rotation reads both files again.
 */
export function pastAnswers({ file = ANSWER_LOG } = {}) {
  let st;
  try { st = statSync(file); } catch { return () => null; }
  const rotated = file.replace(/\.jsonl$/, '.1.jsonl');
  let rotStamp = '';
  try { const r = statSync(rotated); rotStamp = `${r.ino}|${r.mtimeMs}|${r.size}`; } catch { /* none yet */ }
  // THE SAME FILE, ONLY LONGER. The file id changes when the log is replaced
  // (NTFS gives a new one on a rename over it or a delete and re-create; its
  // birth time does not, Windows carries that over). A rewrite IN PLACE keeps
  // the id, so the bytes just before where the last read stopped must still be
  // the same bytes.
  let same = !!PAST.index && PAST.file === file && PAST.rotStamp === rotStamp && PAST.ino === st.ino && st.size >= PAST.size;
  if (same && st.size === PAST.size && st.mtimeMs === PAST.mtimeMs) return PAST.index;
  if (same && tailBefore(file, PAST.size) !== PAST.tail) same = false;
  const byQ = same ? PAST.byQ : new Map();   // normQ → Map(normCo → { answer, company, at })
  let grew = false;
  if (!same && existsSync(rotated)) {
    for (const line of readFileSync(rotated, 'utf-8').split('\n')) if (takePast(byQ, line)) grew = true;
  }
  const { text, end, rest } = readAppended(file, same ? PAST.size : 0, st.size);
  for (const line of text.split('\n')) if (takePast(byQ, line)) grew = true;
  // A whole read takes an unterminated last line when it is a complete record,
  // as the full parse always did; the offset stays before it, so the line is
  // read again once it ends. A read of what was appended waits for its newline.
  if (!same && rest && takePast(byQ, rest)) grew = true;
  const tail = tailBefore(file, end);
  if (same && !grew) { Object.assign(PAST, { size: end, mtimeMs: st.mtimeMs, tail }); return PAST.index; }
  PAST = { file, rotStamp, ino: st.ino, mtimeMs: st.mtimeMs, size: end, tail, byQ, index: indexOf(byQ) };
  return PAST.index;
}

/** The last bytes before `end`, to tell an appended log from one rewritten in place. */
function tailBefore(file, end) {
  if (end <= 0) return '';
  const n = Math.min(64, end);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, end - n);
    return buf.subarray(0, got).toString('hex');
  } finally { closeSync(fd); }
}

/** One log line into the index; true when it added an answer. Later lines win, as in a full read. */
function takePast(byQ, line) {
      if (!line || !line.includes('"kind":"final"')) return false;
      let r; try { r = JSON.parse(line); } catch { return false; }
      if (!['you answered', 'changed'].includes(r.status)) return false;
      // "CHANGED" WHEN JARVIS PRESSED is not evidence he chose it: the menu's
      // own pick differs in wording from the plan, and a WRONG pick became
      // "his answer". HP's veteran question, answered by the export rule on
      // 2026-09-26, was picked as "…a veteran, just not a protected veteran",
      // then reused the next day and landed on "…protected veterans" (F-618).
      if (r.status === 'changed' && r.by !== 'you') return false;
      const answer = String(r.answer ?? '').trim();
      if (!answer || answer.length > 150 || answer === 'unchecked' || /file\(s\) attached/i.test(answer)) return false;
      if (PAST_NEVER.test(String(r.label || '')) || /^(file|upload)$/i.test(String(r.type || ''))) return false;
      // The rows of an employment or education entry belong to that entry
      // ("I currently work here" was ticked for one job, not for every job).
      if (PAST_ENTRY.test(String(r.label || '').trim())) return false;
      const q = normQ(r.label); if (q.length < 8) return false;
      const co = normCo(r.company || host(r.pageUrl));
      if (!byQ.has(q)) byQ.set(q, new Map());
      // A CORRECTION is his answer over the engine's (F-1036): the planner lets
      // it beat a rule next time, for his history questions at this employer.
      const corrected = r.status === 'changed' && r.by === 'you';
      byQ.get(q).set(co, { answer, company: r.company || host(r.pageUrl), at: r.at, ...(corrected ? { corrected: true, engine: r.engine ?? null } : {}) });
      return true;
}

/** The lookup over his answers: exact wording, then the same question's shape. */
function indexOf(byQ) {
  // THE SAME QUESTION IN OTHER WORDS (step 3 of "how do we make this robust",
  // 2026-10-03). Exact wording found 11 of his 320 hand answers from his
  // others: the employer's name sits inside most questions ("…worked for John
  // Deere?" / "…worked for Plug Power?"). So each question is also kept by its
  // SHAPE — the employer masked, small words and punctuation gone — and a
  // question with nearly the same words (same negations, same numbers) can
  // borrow, under the same bar as before: his own answer at this employer, or
  // one answer he gave at two or more employers.
  const shapes = new Map();   // shape → { tokens, at: Map(normCo → answer) }
  for (const [q, at] of byQ) {
    for (const [co, a] of at) {
      const k = shapeOf(q, a.company);
      if (!k.key) continue;
      if (!shapes.has(k.key)) shapes.set(k.key, { tokens: k.tokens, neg: k.neg, nums: k.nums, at: new Map() });
      shapes.get(k.key).at.set(co, a);
    }
  }
  // Measured 2026-10-03: where a near-identical question exists at another
  // employer, his answers agree 84% of the time, and every disagreement was
  // the menu's wording ("Company Career Site" / "ABB Careers Website", "N/A" /
  // "No") — which the form's own options settle downstream. So by SHAPE one
  // other employer is evidence enough… except for a question about his
  // relation to THIS employer: "Have you ever worked for <co>?" answered Yes at
  // Applied Materials is never an answer anywhere else.
  const RELATION = /\b(work|worked|working|employ\w*|intern\w*|contract\w*|relative\w*|related|family|applied|application|referr\w*|former|previous\w*|affiliat\w*|subsidiar\w*)\b/;
  const decideFrom = (at, company, { shape = null } = {}) => {
    const mine = at.get(normCo(company));
    if (mine) return mine;
    const answers = [...at.values()];
    const same = answers.length >= 2 && answers.every((a) => a.answer.toLowerCase() === answers[0].answer.toLowerCase());
    if (same) return { ...answers[answers.length - 1], company: `${answers.length} employers` };
    if (shape && answers.length === 1 && !(shape.tokens.includes('<co>') && RELATION.test(shape.tokens.join(' ')))) {
      return { ...answers[0], company: answers[0].company };
    }
    return null;
  };
  const index = (label, company) => {
    const at = byQ.get(normQ(label));
    const exact = at ? decideFrom(at, company) : null;
    if (exact) return exact;
    const k = shapeOf(normQ(label), company);
    if (!k.key) return null;
    // The same shape, then the closest near-shape.
    const pools = [];
    if (shapes.has(k.key)) pools.push(shapes.get(k.key).at);
    else {
      let best = null; let bestSim = 0;
      for (const s of shapes.values()) {
        if (s.neg !== k.neg || s.nums !== k.nums) continue;
        const sim = jaccard(k.tokens, s.tokens);
        if (sim > bestSim) { bestSim = sim; best = s; }
      }
      // 0.75: agreement measured the same (85%) from 0.6 to 0.8.
      if (best && bestSim >= 0.75) pools.push(best.at);
    }
    for (const p of pools) { const got = decideFrom(p, company, { shape: k }); if (got) return { ...got, fuzzy: true }; }
    return null;
  };
  return index;
}

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
      ...((a.key || f?.key) ? { key: String(a.key || f.key).slice(0, 120) } : {}),
      ...(a.datePart ? { datePart: a.datePart } : {}),
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
    // Why no resume went on, as the opener saw it (F-896).
    ...(body.resumeNote ? { resumeNote: String(body.resumeNote).slice(0, 400) } : {}),
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
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');
const hasWords = (hay, needle) => { const n = words(needle); return !!n && ` ${words(hay)} `.includes(` ${n} `); };

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
    // Keyed on the first 400 characters, as plan rows store them (F-631).
    const k = norm(String(r.label || '').slice(0, 400));
    const prev = out.get(k) || {};
    // A written answer is the text for an essay the plan only named.
    if (r.kind === 'written') { out.set(k, { ...prev, written: r.answer }); continue; }
    // EVERY FIELD OF ONE PASS THAT SHARES THIS LABEL, in page order (F-609).
    // Workday's Legal Name and Preferred Name both say "First Name"; keeping
    // only the last plan compared the legal field with "Alex", and its
    // "contains" test then called "Anna Maria Alex" kept. A newer pass replaces
    // the list; the same pass adds to it.
    const samePass = prev.plan && prev.plan.at === r.at;
    const plans = samePass ?[...(prev.plans || [prev.plan]), r] : [r];
    out.set(k, { ...prev, plan: r, plans });
  }
  return out;
}

/** The plan for this field: by Workday key, else the next one of its label in page order. */
function planForField(p, f, nth) {
  const plans = p.plans || (p.plan ? [p.plan] : []);
  if (!plans.length) return undefined;
  if (f.key) {
    // A split date's month, day and year share one key; the part tells them
    // apart, or all three were judged against the month (F-618: HP's year
    // logged "2006" beside a plan of "06").
    const byKey = (f.datePart && plans.find((x) => x.key === f.key && x.datePart === f.datePart)) || plans.find((x) => x.key === f.key);
    if (byKey) return byKey;
  }
  return plans[Math.min(nth, plans.length - 1)];
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
  const taken = new Map();
  for (const f of fields || []) {
    if (!f?.label) continue;
    const final = String(f.value ?? '').trim();
    // Plan rows keep a label's first 400 characters, so it is looked up by the
    // same 400: Micron's veteran, sponsorship and terms questions run longer,
    // and every one read "not planned" beside a plan that existed (F-631).
    const labelKey = norm(String(f.label).slice(0, 400));
    const p = planned.get(labelKey) || {};
    // Which field of this label this is, in page order.
    const nth = taken.get(labelKey) || 0;
    taken.set(labelKey, nth + 1);
    const plan = planForField(p, f, nth);
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
    // Only for a CHOICE: typed text is compared as text, or "Alex" in the
    // legal-name box reads as "Anna Maria Alex" kept (F-609).
    const choice = /^(select|radio|prompt|checkbox|combobox)$/i.test(String(f.type || plan?.type || ''));
    const same = (a, b) => { if (!choice) return false; try { return !!a && !!b && chooseOption(a, [b]) === 0; } catch { return false; } };
    if (!plan) status = 'not planned';
    else if (had != null && final && norm(final) === norm(had)) status = 'already there';
    // AN UPLOAD HAS NO TEXT ANSWER (F-820). The file Jarvis attached read back
    // as "1 file(s) attached" against an empty engine value and was logged
    // "you answered" — 21 of 22 Ashby "his corrections" were Jarvis's own
    // resume, and the platform's correction rate counted them.
    else if (/^upload/.test(String(plan.action || ''))) status = final ? 'kept' : 'cleared';
    // An untick (F-871: Paylocity's "Currently Working Here" on an ended job)
    // is kept when the box went out unticked.
    else if (plan.action === 'uncheck') status = !final || final === 'unchecked' ? 'kept' : 'changed';
    else if (plan.action === 'unknown' || plan.action === 'skip' || (!engine && plan.action !== 'check')) status = final && final !== 'unchecked' ? 'you answered' : 'left blank';
    // A ticked box reads as "checked" or, from an older extension, as its own
    // label; either is the tick the plan asked for.
    else if (plan.action === 'check') status = final === 'checked' || (final && final !== 'unchecked' && norm(final).includes(norm(plan.label || f.label).slice(0, 20))) ? 'kept' : (!final || final === 'unchecked' ? 'cleared' : 'changed');
    else if (!final) status = 'cleared';
    else if (plan.action === 'essay') status = norm(final).slice(0, 300) === norm(engine).slice(0, 300) ? 'kept' : 'edited';
    // A date part typed "06" reads back "6".
    else if (f.datePart && /^\d+$/.test(final) && /^\d+$/.test(engine)) status = Number(final) === Number(engine) ? 'kept' : 'changed';
    // A LOCATION BOX THAT SUGGESTS (F-821). Jarvis types "Springfield, Washington",
    // Lever's lookup offers "Springfield, WA, USA" and Jarvis takes it: the same
    // city in the list's words. Every Lever "correction" since 2026-09-30 was
    // that row, read back and compared as text.
    else if (/location|\bcity\b|where\b.{0,30}\b(live|located|based)/i.test(String(f.label || '')) && engine.includes(',')
      && norm(final.split(',')[0]) === norm(engine.split(',')[0])) status = 'kept';
    // …or any spelling on the plan's own ladder (F-822): Greenhouse's phone
    // country reads back "+1", which is on the ladder the plan offered
    // ("United States of America / United States / USA / +1").
    // Containment is by WHOLE WORDS (F-822): squashed, "female" contains
    // "male", and a Gender changed from Male to Female was logged as kept.
    else status = norm(final) === norm(engine) || hasWords(final, engine) && norm(engine).length > 2 || same(engine, final)
      || (choice && Array.isArray(plan.values) && plan.values.some((v) => norm(v) === norm(final))) ? 'kept' : 'changed';
    const sig = `final|${pageUrl}|${f.label}|${f.key || nth}|${f.datePart || ''}|${final}`;
    if (SEEN.has(sig) && now - SEEN.get(sig) < SEEN_MS) continue;
    SEEN.set(sig, now);
    rows.push({
      at: new Date(now).toISOString(), kind: 'final', stage, button: String(button).slice(0, 80), by,
      host: host(pageUrl), pageUrl: String(pageUrl).slice(0, 300),
      jobId: job?.id ?? null, company: job?.company || '', title: job?.title || '',
      label: String(f.label).slice(0, 400), type: f.type || '', options: Array.isArray(f.options) ? f.options.slice(0, 25) : [],
      ...(f.key ? { key: String(f.key).slice(0, 120) } : {}),
      ...(f.datePart ? { datePart: f.datePart } : {}),
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

/**
 * THE HARNESS'S LINES, TAKEN OUT AGAIN (F-1029). Lines a test wrote through
 * the live dashboard before its pages were refused (harness-pages.mjs): out of
 * the answer log, its rotation and plans.jsonl. Every removed line is kept,
 * with the file it came from, in `answer-log-pruned-<time>.jsonl`, so nothing
 * is lost. Each file is replaced whole (a temp file, then a rename), so run it
 * while the dashboard is stopped: a plan appended between the read and the
 * rename would be lost.
 */
export function pruneHarness({ dir = STORE_DIR, write = false, now = new Date() } = {}) {
  const names = ['answer-log.jsonl', 'answer-log.1.jsonl', 'plans.jsonl'];
  const removed = []; const perFile = {};
  const plans = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf-8');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const keep = []; let n = 0;
    for (const line of lines) {
      let r = null; if (line.trim()) { try { r = JSON.parse(line); } catch { r = null; } }
      if (r && (isHarnessPage(r.pageUrl) || r.harness === true)) { removed.push({ file: name, line }); n += 1; } else keep.push(line);
    }
    perFile[name] = { lines: lines.filter((l) => l.trim()).length, removed: n };
    if (n) plans.push({ file, body: keep.join(nl) });
  }
  const out = { removed: removed.length, perFile, savedTo: null };
  if (!write || !removed.length) return out;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  out.savedTo = path.join(dir, `answer-log-pruned-${stamp}.jsonl`);
  writeFileSync(out.savedTo, removed.map((x) => JSON.stringify(x)).join('\n') + '\n');   // first: the lines are safe before any file changes
  for (const p of plans) { writeFileSync(`${p.file}.prune-tmp`, p.body); renameSync(`${p.file}.prune-tmp`, p.file); }
  return out;
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` && process.argv.includes('--prune-harness')) {
  const r = pruneHarness({ write: process.argv.includes('--write') });
  for (const [f, c] of Object.entries(r.perFile)) console.log(`${f}: ${c.lines} lines, ${c.removed} from a test harness`);
  console.log(r.savedTo ? `removed ${r.removed}; every one is kept in ${r.savedTo}` : `${r.removed} would be removed. Re-run with --write, with the dashboard stopped.`);
} else if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
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
