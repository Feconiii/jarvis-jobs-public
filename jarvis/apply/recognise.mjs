/**
 * A QUESTION IN WORDS NO RULE KNOWS, RECOGNISED — NOT ANSWERED — BY A MODEL.
 *
 * His diagnosis, 2026-09-18, and again 2026-09-24: "a lot of times it's the
 * same stuff cv.md already has but the question phrasing trips up the
 * extension." Every rule in _answers.mjs is a pattern, and every pattern has
 * met a wording it missed ("How did you FIRST hear", "LEARN about this
 * opportunity", "legally eligible for EMPLOYMENT in the country"). Adding the
 * next pattern after the next miss is the loop this breaks.
 *
 * What the model is allowed to do is deliberately small: say which of a fixed
 * list of known questions a leftover question IS, or "none". It never writes
 * an answer. The answer still comes from the rule that owns the known
 * question, out of his files, and passes the same checks every answer does —
 * including the basic-facts check (_facts.mjs), which reads the chosen words
 * against his stated facts. So a wrong recognition can at worst leave a field
 * for him; it cannot put an invented fact on a form.
 *
 * Cheap and bounded: Haiku (his rule for machine chores — never Opus), one
 * call per plan and only for wordings never seen before, a hard time cap, and
 * every verdict cached by wording so the same question costs nothing twice.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

import { resolveLabel } from './_answers.mjs';
import { chooseOption } from './_form.mjs';
import { contradicts } from './_facts.mjs';

/** The known questions, each in the plain wording its rule answers. */
export const TOPICS = [
  { id: 'work_authorization', q: 'Are you legally authorized to work in the United States?' },
  { id: 'sponsorship', q: 'Will you now or in the future require sponsorship for employment visa status?' },
  { id: 'age_18', q: 'Are you at least 18 years of age?' },
  { id: 'former_employee', q: 'Have you ever been employed by this company?' },
  { id: 'relatives', q: 'Do you have any relatives working in this company?' },
  { id: 'how_heard', q: 'How did you hear about us?' },
  { id: 'relocate', q: 'Are you willing to relocate?' },
  { id: 'travel', q: 'Are you willing to travel?' },
  { id: 'onsite', q: 'Are you open to working on-site?' },
  { id: 'start_date', q: 'What is your earliest available start date?' },
  { id: 'notice_period', q: 'What is your notice period?' },
  { id: 'salary', q: 'What are your salary expectations?' },
  { id: 'graduation_date', q: 'What is your expected graduation date?' },
  { id: 'degree', q: 'What is the highest level of education you have completed or are pursuing?' },
  { id: 'field_of_study', q: 'Field of Study' },
  { id: 'school', q: 'School or university attended' },
  { id: 'gpa', q: 'What is your GPA?' },
  { id: 'years_experience', q: 'How many years of relevant professional experience do you have?' },
  { id: 'non_compete', q: 'Are you bound by a non-compete agreement or any restrictive covenant?' },
  { id: 'essential_functions', q: 'Can you perform the essential functions of the job with or without reasonable accommodation?' },
  { id: 'future_contact', q: 'May we contact you about future job opportunities?' },
  { id: 'english', q: 'Do you meet the language requirements for this position (fluent in written and verbal English)?' },
  { id: 'linkedin', q: 'LinkedIn Profile' },
  { id: 'portfolio', q: 'Portfolio or personal website' },
  { id: 'phone', q: 'Phone Number' },
  { id: 'email', q: 'Email' },
  { id: 'city', q: 'City' },
  { id: 'state', q: 'State' },
  { id: 'country', q: 'Country' },
  { id: 'postal_code', q: 'Postal Code' },
  { id: 'current_location', q: 'Where are you currently located?' },
  // 2026-10-03 — the families that failed in other words on Eightfold,
  // Oracle, Paylocity and Workday (F-694..F-697): each wording below is one a
  // rule in _answers.mjs answers, so a rewording read as it is answered too.
  { id: 'f1_status', q: 'Are you currently in F-1 visa status?' },
  { id: 'daca', q: 'Are you a current recipient of Deferred Action for Childhood Arrivals (DACA)?' },
  { id: 'pay_type', q: 'Desired Salary Type' },
  { id: 'min_experience', q: 'Do you have the minimum number of years of experience for the job?' },
  { id: 'min_education', q: 'Do you have the minimum educational requirement for the job?' },
  { id: 'school_type', q: 'School Type' },
  { id: 'graduated', q: 'Did you graduate?' },
  { id: 'enrolled', q: 'Are you currently enrolled in a degree program?' },
  { id: 'recruiter_contact', q: 'A recruiter may contact me regarding opportunities.' },
  { id: 'contingent_supplier', q: 'Do you currently, or have you in the past, worked for a company that has supplied contingent workers to this company?' },
  { id: 'capacity_employed', q: 'In which capacity, if any, are you currently, or were you most recently employed at this company?' },
  { id: 'preferred_contact', q: 'What is your preferred method of communication?' },
  { id: 'sms_consent', q: 'Do you consent to receive text messages about your application?' },
];

/** Only the topics his profile actually answers are offered to the model. */
export function answerableTopics(profile) {
  return TOPICS.filter((t) => {
    try { return resolveLabel(t.q, profile)?.kind === 'answer'; } catch { return false; }
  });
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const cacheKey = (label, options = []) => `${norm(label).slice(0, 300)}||${norm((options || []).slice(0, 6).join('|')).slice(0, 200)}`;

/** Not for the model: written answers, self-identification, and questions too long to be one question. */
export function worthAsking(label) {
  const q = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 4 || q.length > 300) return false;
  if (/\b(describe|explain|tell us|why|what (interests|excites|motivates)|cover letter|essay|in your own words)\b/i.test(q)) return false;
  if (/\b(gender|sex|race|ethnicity|hispanic|latin|veteran|disability|pronoun|sexual orientation|transgender)\b/i.test(q)) return false;
  if (/\b(password|social security|ssn|date of birth|birth ?date|driver'?s licen[cs]e number)\b/i.test(q)) return false;
  // LEGAL STATUS IS ANSWERED BY A RULE OR BY HIM, NEVER BY A LOOK-ALIKE.
  // Atomic Semi (2026-09-25): "I am one of the following: (a) a citizen of the
  // United States; (b) a lawful permanent resident …; or (c) … an asylee or
  // refugee" was read as "Are you legally authorized to work in the United
  // States?" and answered YES — telling an export-controlled employer he is a
  // U.S. person. Citizenship, residency, asylum, U.S.-person, export control,
  // clearance and criminal history never go to the recogniser.
  if (/\b(citizen\w*|nationality|permanent\s+resident\w*|green\s*card|asyl\w*|refugee|u\.?\s?s\.?\s+person|export|itar|ear\b|deemed\s+export|clearance|convict\w*|felon\w*)\b/i.test(q)) return false;
  // A FOLLOW-UP to another answer ("If you selected Other from the
  // State/Province list, please enter the name below") is not the question it
  // follows. Haiku read that one as State, live, 2026-09-24.
  if (/^\s*(\d+[a-z]?\)\*?\s*)?if\b|\bif\s+(you|your)\s+(selected|chose|answered|response|responded)\b|\bif\s+["“']?(yes|no|other)["”']?\b/i.test(q)) return false;
  // A form's own section or field names that are not questions at all.
  if (/^\s*(no selection|select|suffix|summary|headline|industry|description|from|to|end date|start date|c[A-Z]\w+)\s*$/.test(q)) return false;
  return true;
}

export function buildPrompt(questions, topics) {
  const menu = topics.map((t) => `${t.id}: ${t.q}`).join('\n');
  const list = questions.map((q, i) => `${i + 1}. ${q.label}${q.options?.length ? `  [options: ${q.options.slice(0, 8).join(' | ')}]` : ''}`).join('\n');
  return [
    'You match job-application questions to a fixed list of known questions.',
    'For each numbered question, reply with the id of the known question it is ASKING — the same fact, in other words — or "none".',
    'Say "none" unless it is plainly the same question. A question that only mentions a topic (a legal notice, a question about something else) is "none".',
    'Never invent an id. Reply with JSON only: an array of ids or "none", one per question, in order.',
    '',
    'Known questions:',
    menu,
    '',
    'Questions:',
    list,
  ].join('\n');
}

export function parseTopics(raw, n, topics) {
  const ids = new Set(topics.map((t) => t.id));
  const m = String(raw ?? '').match(/\[[\s\S]*\]/);
  if (!m) return Array(n).fill(null);
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return Array(n).fill(null); }
  if (!Array.isArray(arr)) return Array(n).fill(null);
  return Array.from({ length: n }, (_, i) => (ids.has(arr[i]) ? arr[i] : null));
}

function readCache(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {}; } catch { return {}; }
}
function writeCache(file, cache) {
  try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(cache, null, 1)); } catch { /* a cache, never a failure */ }
}

/**
 * Which known question is each of these? Returns an array of topic objects
 * (or null), in order. Cached answers first; the model only for the rest.
 */
const IN_FLIGHT = new Set();

/**
 * NEVER IN THE WAY OF A FILL. Haiku took 27 s for twelve questions on his
 * machine (2026-09-24): far too long to hold a plan for. So a plan uses the
 * verdicts already cached, and the wordings never seen go to the model AFTER
 * the plan has gone back — the next press, or the next form with the same
 * question, finds the verdict waiting.
 */
export function recogniseLater(questions, profile, { ask, cacheFile, timeoutMs = 90000 } = {}) {
  if (typeof ask !== 'function' || !cacheFile) return null;
  const cache = readCache(cacheFile);
  const todo = questions.filter((q) => cache[cacheKey(q.label, q.options)] === undefined && !IN_FLIGHT.has(cacheKey(q.label, q.options)));
  if (!todo.length) return null;
  for (const q of todo) IN_FLIGHT.add(cacheKey(q.label, q.options));
  return recogniseQuestions(todo, profile, { ask, cacheFile, timeoutMs })
    .catch(() => null)
    .finally(() => { for (const q of todo) IN_FLIGHT.delete(cacheKey(q.label, q.options)); });
}

export async function recogniseQuestions(questions, profile, { ask, cacheFile, timeoutMs = 15000 } = {}) {
  const topics = answerableTopics(profile);
  const byId = new Map(topics.map((t) => [t.id, t]));
  const cache = cacheFile ? readCache(cacheFile) : {};
  const out = questions.map((q) => {
    const hit = cache[cacheKey(q.label, q.options)];
    return hit === undefined ? undefined : (hit && byId.get(hit)) || null;
  });
  const todo = questions.map((q, i) => ({ q, i })).filter(({ i }) => out[i] === undefined);
  if (todo.length && typeof ask === 'function' && topics.length) {
    let raw = '';
    let timer;
    try {
      raw = await Promise.race([
        ask(buildPrompt(todo.map((t) => t.q), topics)),
        // A timer that must never hold the process (or the server) open.
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      const ids = parseTopics(raw, todo.length, topics);
      todo.forEach(({ q, i }, k) => {
        out[i] = ids[k] ? byId.get(ids[k]) : null;
        cache[cacheKey(q.label, q.options)] = ids[k] || null;
      });
      if (cacheFile) writeCache(cacheFile, cache);
    } catch { /* slow or unreachable: this plan goes without, the next may not */ } finally { clearTimeout(timer); }
  }
  return out.map((t) => t || null);
}

/**
 * The plan's leftovers, asked again under the known wording. Mutates `plan`:
 * an action the rule for the recognised question can answer takes that answer,
 * flagged for review and saying which question it was read as. Everything
 * else is left exactly as it was.
 */
export async function recogniseLeftovers(plan, fields, profile, planOpts, { ask, cacheFile, planForm, timeoutMs, later = false } = {}) {
  const list = Array.isArray(fields) ? fields : [];
  const who = planOpts?.company ? { ...profile, applyingTo: String(planOpts.company) } : profile;
  // A QUESTION A RULE ALREADY KNOWS is not a leftover: it waits for his answer
  // (the rule's own "add answers.X" line). Celestica's "circumstances that
  // would prevent you from being granted entry" was re-read as "willing to
  // travel?" and answered Yes (F-623).
  const left = (plan?.actions || []).filter((a) => a.action === 'unknown'
    && !/^add `/.test(String(a.why || ''))
    && String(list[a.at]?.type || a.type || '').toLowerCase() !== 'file'
    && worthAsking(a.label));
  if (!left.length || typeof planForm !== 'function') return 0;
  const qs = left.map((a) => ({ label: a.label, options: Array.isArray(list[a.at]?.options) ? list[a.at].options.map(String) : [] }));
  // LATER: this plan takes what is cached; the rest is asked in the background.
  const topics = later
    ? await recogniseQuestions(qs, who, { cacheFile })
    : await recogniseQuestions(qs, who, { ask, cacheFile, timeoutMs });
  if (later) recogniseLater(qs, who, { ask, cacheFile });
  let took = 0;
  left.forEach((a, k) => {
    const t = topics[k];
    if (!t) return;
    const f = list[a.at] || {};
    const again = planForm([{ ...f, label: t.q }], profile, { ...planOpts, sections: [] })?.actions?.[0];
    if (!again || ['unknown', 'skip'].includes(again.action)) return;
    // A WRONG RECOGNITION IS CAUGHT ON THE ORIGINAL WORDS. "Can you work here
    // without sponsorship?" read as plain work authorization would answer Yes;
    // the facts check reads the question as it was asked and refuses it.
    const opts = Array.isArray(f.options) ? f.options.map(String) : [];
    const i = opts.length ? chooseOption(String(again.value ?? ''), opts) : -1;
    if (contradicts(a.label, i >= 0 ? opts[i] : again.value, who)) return;
    const keep = { at: a.at, key: a.key, name: a.name, fieldId: a.fieldId, label: a.label, type: a.type };
    Object.assign(a, again, keep, { review: true, recognisedAs: t.id, why: `read as "${t.q}" — ${again.why || 'answered by that question\'s rule'}` });
    took += 1;
  });
  if (took) {
    const by = (x) => plan.actions.filter((a) => a.action === x);
    plan.unanswered = by('unknown').map((a) => ({ label: a.label, why: a.why }));
    if (plan.summary) for (const k of Object.keys(plan.summary)) plan.summary[k] = by(k === 'letter' ? 'upload-letter' : k).length;
    plan.review = plan.actions.filter((a) => a.review).map((a) => ({ label: a.label, value: a.value }));
  }
  return took;
}
