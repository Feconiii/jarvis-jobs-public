#!/usr/bin/env node
// jarvis/unanswered.mjs — the questions this engine could not answer, kept.
//
// HIS OWN DIAGNOSIS, 2026-09-18: "whenever there is a question that can't be
// answered, the 'what's left for you' questions, it should be recorded with
// the multiple choice answers and recorded into an untackled questions log and
// see if it was answerable or not. A lot of times it's the same stuff cv.md
// already has but the question phrasing trips up the extension."
//
// His Micron run that morning is the argument in one screen. Four things were
// left for him, and two of them were facts the profile already holds:
//
//   "U.S. – Protected Veteran Self-Identification This Employer is a
//    Government contractor subject to the Vietnam Era Veterans…"
//        → `eeo.veteran` answers this. The legal paragraph welded onto the
//          label is what defeated the matcher.
//   "When would you be available if an offer was accepted?"
//        → he graduates May 2027.
//   "Employee ID (if applicable)"          → genuinely not his.
//   "Upload your resume"                   → the Eightfold drop-zone check.
//
// A leftover question that is reported once and then thrown away teaches
// nothing. The same wording will arrive on the next form from the same vendor,
// and the only record of it is a line he read a week ago. So every unknown is
// written down WITH ITS OPTIONS, grouped by what it is actually asking rather
// than by its exact characters, and counted.
//
// Nothing here answers anything. It is a ledger and a report: what was left,
// how often, at how many employers, and — the point — whether the engine can
// answer it once the phrasing is normalised.
//
// Usage:
//   npm run jarvis:unanswered            # the report, most frequent first
//   npm run jarvis:unanswered -- --all   # including the ones only seen once
//   npm run jarvis:unanswered -- --json

import { openDb } from './db.mjs';
import { dbPath as storeDbPath } from './store.mjs';

// ── what a question is actually asking ───────────────────────────────
//
// Every phrase below was cut off a real label. The compliance questions are
// the worst offenders: an employer pastes four sentences of statute into the
// <label> and the question itself is six words of it.
const BOILERPLATE = [
  // The veteran self-identification block, which is what beat the Micron run.
  /this employer is a government contractor[\s\S]*/i,
  /vietnam era veterans[\s\S]*/i,
  /section 503 of the rehabilitation act[\s\S]*/i,
  /why are you being asked[\s\S]*/i,
  /we are required to (?:ask|report|submit)[\s\S]*/i,
  /completion of this form is voluntary[\s\S]*/i,
  /your (?:answer|response) will not be[\s\S]*/i,
  /this information will be kept confidential[\s\S]*/i,
  /pursuant to (?:federal|state)[\s\S]*/i,
  /for (?:government )?reporting purposes[\s\S]*/i,
  /the employer's? (?:obligation|responsibilit)[\s\S]*/i,
  /omb control (?:no|number)[\s\S]*/i,
  /form cc-305[\s\S]*/i,
  /if you believe you belong to any of the categories[\s\S]*/i,
];

/** Furniture that carries no meaning: required markers, numbering, help text. */
const FURNITURE = /\*|\(required\)|\(optional\)|\(if applicable\)|\bplease select\b|\bselect one\b|\brequired\b$/gi;

/**
 * The question, reduced to what it asks.
 *
 * Deliberately lossy and deliberately NOT a match on the whole string: two
 * employers asking the same thing almost never write it the same way, and the
 * whole reason this file exists is that the difference is not meaningful.
 */
export function normaliseQuestion(label) {
  let s = String(label || '').replace(/\s+/g, ' ').trim();
  for (const re of BOILERPLATE) s = s.replace(re, ' ');
  s = s.replace(FURNITURE, ' ')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // An employer's own name inside the question is not part of the question:
  // "Have you ever worked for Micron?" and "…for Applied Materials?" are one.
  // Kept to the first twelve words, because the tail is where the prose is.
  return s.split(' ').slice(0, 12).join(' ');
}

// WHAT IT IS ASKING, NOT HOW IT ASKS IT.
//
// Stripping the statute is not enough on its own. "U.S. – Protected Veteran
// Self-Identification…", "Protected Veteran Status*" and "Are you a protected
// veteran?" normalise to three different strings and are one question, so a
// ledger keyed on the words would list the same gap three times and rank each
// of them a third as urgent as it is.
//
// These are the questions that recur across employers. Anything not on the
// list keeps its wording as its key — the list is for the ones worth counting
// together, not a taxonomy of every form on the internet.
const CONCEPTS = [
  ['veteran', /\bveteran\b|\bprotected veteran\b/],
  ['disability', /\bdisabilit(y|ies)\b|\bcc 305\b/],
  ['race', /\brace\b|\bethnicit(y|ies)\b|\bhispanic\b/],
  ['gender', /\bgender\b|\bsex\b(?! offender)/],
  ['sponsorship', /\bsponsor\w*\b/],
  ['work-authorisation', /\bauthoriz\w+ to work\b|\blegally authoriz\w+\b|\bright to work\b|\bwork authoriz\w+\b/],
  ['start-date', /\bavailab\w+ (?:to )?(?:start|begin)\b|\bstart date\b|\bwhen (?:would|can) you (?:be available|start)\b|\bearliest start\b/],
  ['salary', /\bsalary\b|\bcompensation\b|\bpay (?:expectation|range|rate)\b|\bdesired (?:salary|pay)\b/],
  ['relocation', /\brelocat\w+\b|\bwilling to move\b/],
  ['referral', /\bhow did you hear\b|\breferr\w+\b|\bwho referred\b|\bemployee referral\b/],
  ['prior-employment', /\b(?:previously|ever) (?:work|employ)\w*\b|\bformer employee\b|\brehire\b/],
  ['employee-id', /\bemployee (?:id|number)\b/],
  ['clearance', /\bsecurity clearance\b|\bclearance level\b/],
  ['export-control', /\bexport control\b|\bitar\b|\bu s person\b/],
  ['criminal-history', /\bconvict\w+\b|\bcriminal\b|\bfelony\b/],
  ['drug-test', /\bdrug (?:test|screen)\w*\b/],
  ['notice-period', /\bnotice period\b|\bhow (?:much|long) notice\b/],
  ['linkedin', /\blinkedin\b/],
  ['portfolio', /\bportfolio\b|\bpersonal (?:web)?site\b|\bgithub\b/],
  ['cover-letter', /\bcover letter\b/],
  ['pronouns', /\bpronoun/],
  ['age-check', /\bat least 18\b|\bover 18\b|\bof legal working age\b/],
];

/**
 * A SIGHTING THAT CANNOT TEACH ANYTHING IS NOT WORTH KEEPING.
 *
 * This ledger exists to rank the gaps worth closing, so anything in it that no
 * fix could ever reach costs him attention for nothing. The 2026-09-20 read of
 * the log had eight such rows out of fifty-one — a sixth of the list.
 *
 * Two kinds, and only two. This is deliberately narrow: a question wrongly
 * dropped here is a gap that never gets fixed, which is far worse than a noisy
 * line he can skim past.
 *
 *   A CONTROL WHOSE OPTIONS ALL CAME BACK EMPTY. The page sent a radio group
 *   whose option text did not extract, so the group's LABEL became the first
 *   option — the log carried entries reading "2024", "Spring", "Yes" and "No
 *   Selection", each with `options: ["", "", ""]`. Nothing about them names a
 *   question, so nothing about them can be matched next time. The field is
 *   still reported to him on the form he is standing in front of; it is only
 *   the cross-employer ledger that skips it.
 *
 *   A CREDENTIAL. TSMC's board makes you create an account, and "Choose
 *   Password:" / "Retype Password:" went in as questions the engine had failed
 *   to answer. No profile will ever hold them, by design.
 */
export function teachesNothing(entry) {
  const label = String(entry?.label || '').trim();
  if (/\bpassword\b|\bpasscode\b|^\s*retype\b/i.test(label)) return true;
  const opts = Array.isArray(entry?.options) ? entry.options : [];
  if (opts.length && opts.every((o) => !String(o ?? '').trim())) return true;
  return false;
}

/**
 * The key a question is counted under: its concept when it has one, its
 * wording when it does not.
 */
export function questionKey(label, kind = '') {
  const norm = normaliseQuestion(label);
  let key = norm;
  for (const [name, re] of CONCEPTS) if (re.test(norm)) { key = `concept:${name}`; break; }
  // A FILE INPUT IS NOT THE SAME QUESTION AS A TEXT BOX THAT SHARES ITS NOUN.
  //
  // Measured 2026-09-20: "Please share links to GitHub, portfolio, publications,
  // or hardware projects" (a textarea) and "Portfolio - File upload" (a file
  // input) both key to `concept:portfolio`, so they merged into one row. A row
  // carries ONE `kind`, the file input was written last and won, and the whole
  // row was judged on it — so the links question stayed reported as
  // unanswerable after it had been fixed, hidden inside a row that was right
  // about the other half.
  //
  // Only `file` is split out, not every type. A select and a radio asking the
  // same thing ARE one question and must keep merging, which is the entire
  // point of this key. A file input is the one case where no text answer can
  // ever apply, and the probe already treats it that way.
  return /^(file|upload)$/i.test(String(kind || '')) ? `upload:${key}` : key;
}

// ── the ledger ───────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS unanswered_questions (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT '',
  wordings   TEXT NOT NULL DEFAULT '',
  why        TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT '',
  options    TEXT NOT NULL DEFAULT '',
  companies  TEXT NOT NULL DEFAULT '',
  times      INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  verdict    TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS unanswered_times ON unanswered_questions(times DESC);
`;
const SCHEMA_DONE = new Set();
function db(dbPath = storeDbPath()) {
  const h = openDb(dbPath);
  if (!SCHEMA_DONE.has(dbPath)) { h.exec(DDL); SCHEMA_DONE.add(dbPath); }
  return h;
}

/**
 * Record one question the plan could not answer.
 *
 * Idempotent per (question, company): the same form opened twice is one
 * sighting, because a count inflated by re-runs would rank the questions he
 * re-opens above the questions that are actually common.
 */
export function recordUnanswered(entries, { company = '', dbPath = storeDbPath(), now = new Date() } = {}) {
  const list = Array.isArray(entries) ? entries : [entries];
  const h = db(dbPath);
  const at = now.toISOString();
  const read = h.prepare('SELECT key, companies, times, options, wordings FROM unanswered_questions WHERE key = ?');
  const ins = h.prepare(`
    INSERT INTO unanswered_questions (key, label, wordings, why, kind, options, companies, times, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      label = excluded.label, wordings = excluded.wordings, why = excluded.why, kind = excluded.kind,
      options = CASE WHEN length(excluded.options) > length(unanswered_questions.options)
                     THEN excluded.options ELSE unanswered_questions.options END,
      companies = excluded.companies,
      times = unanswered_questions.times + excluded.times,
      last_seen = excluded.last_seen
  `);
  let recorded = 0;
  for (const e of list) {
    const label = String(e?.label || '').trim();
    if (!label) continue;
    if (teachesNothing(e)) continue;
    const key = questionKey(label, e?.kind || e?.type || '');
    if (!key || key.length < 3) continue;
    const prev = read.get(key);
    const seen = new Set(String(prev?.companies || '').split('|').filter(Boolean));
    const isNewCompany = company && !seen.has(company);
    if (prev && !isNewCompany) {
      // Seen at this employer already — refresh the wording, do not re-count.
      h.prepare('UPDATE unanswered_questions SET last_seen = ?, label = ?, why = ? WHERE key = ?')
        .run(at, label, String(e?.why || ''), key);
      continue;
    }
    if (company) seen.add(company);
    // EVERY PHRASING, KEPT. The count says how often the gap costs him; the
    // wordings are what a fix has to match, and they are the evidence that the
    // question really is one question.
    const wordings = new Set(String(prev?.wordings || '').split('␟').filter(Boolean));
    wordings.add(label.slice(0, 300));
    ins.run(key, label, [...wordings].slice(0, 8).join('␟'), String(e?.why || ''),
      String(e?.kind || e?.type || ''),
      JSON.stringify((e?.options || []).slice(0, 24)), [...seen].join('|'), at, at);
    recorded += 1;
  }
  return recorded;
}

/** Everything in the ledger, most frequent first. */
export function listUnanswered({ dbPath = storeDbPath(), min = 1 } = {}) {
  return db(dbPath).prepare(
    'SELECT * FROM unanswered_questions WHERE times >= ? ORDER BY times DESC, last_seen DESC',
  ).all(min).map((r) => ({
    ...r,
    options: (() => { try { return JSON.parse(r.options || '[]'); } catch { return []; } })(),
    companies: String(r.companies || '').split('|').filter(Boolean),
    wordings: String(r.wordings || '').split('␟').filter(Boolean),
  }));
}

/**
 * A QUESTION THAT HAS SINCE BEEN FIXED MUST LEAVE THE LIST.
 *
 * Nothing re-checked this ledger, so every row survived its own fix. Measured
 * 2026-09-20: five of the fifty-one rows answered correctly when replayed
 * against the planner as it stood that morning, and had done for weeks — they
 * were still being printed as outstanding work, and still inflating the
 * "51 distinct questions" headline he reads at the top.
 *
 * A retired row is DELETED rather than flagged. The count of sightings it
 * carried was evidence for a fix that has now happened; keeping it would mean
 * the next report has to explain why a row it calls answered is still there.
 * If the same question comes back it is recorded again from one, which is the
 * honest signal that the fix regressed.
 *
 * @returns {{retired:string[], kept:number}}
 */
export function retireAnswered({ planForm, profile, dbPath = storeDbPath(), dryRun = false } = {}) {
  const rows = listUnanswered({ dbPath });
  const retired = [];
  for (const r of rows) {
    // THE NOISE GUARD APPLIES BACKWARDS TOO. `recordUnanswered` refuses these
    // at the door now, but the rows written before it existed are still in the
    // ledger and no fix will ever reach them either.
    if (teachesNothing(r)) { retired.push(r.key); continue; }
    // Only ever retires on the row's OWN recorded type and options. Probing a
    // file upload as text is what made the old report claim it could answer
    // questions it cannot, and retiring on that basis would delete the record
    // of a real gap.
    const verdict = answerability(r, { planForm, profile });
    if (verdict.verdict === 'answerable-now') retired.push(r.key);
  }
  if (!dryRun && retired.length) {
    const h = db(dbPath);
    const del = h.prepare('DELETE FROM unanswered_questions WHERE key = ?');
    for (const k of retired) del.run(k);
  }
  return { retired, kept: rows.length - retired.length };
}

/** Record a judgement about one question, so the next report does not re-ask. */
export function judgeUnanswered(key, verdict, note = '', { dbPath = storeDbPath() } = {}) {
  db(dbPath).prepare('UPDATE unanswered_questions SET verdict = ?, note = ? WHERE key = ?')
    .run(String(verdict || ''), String(note || ''), String(key));
}

/**
 * COULD THE ENGINE HAVE ANSWERED THIS, if the phrasing had not got in the way?
 *
 * The test is the one he described: put the question back through the same
 * planner, with the boilerplate stripped, and see whether an answer appears.
 * When it does, the fault is the matcher's and it is fixable here; when it does
 * not, the question really is his.
 */
export function answerability(row, { planForm, profile }) {
  const raw = String(row.label || '');
  const clean = raw.replace(/\s+/g, ' ').trim();
  // THE TYPE THE PAGE ACTUALLY SENT, not a guess from the option count.
  //
  // This used to infer `options.length ? 'select' : 'text'`, and the inference
  // made the report lie in both directions. "Portfolio - File upload" is a
  // `file` field; probed as `text` it answered "alexrivera.example" and was
  // reported as a matcher bug the engine could already handle — it cannot, and
  // no amount of work on the matcher would have changed that. The reverse cost
  // more: a `radio` probed as a `select` takes a different branch, so real
  // matcher bugs were ranked as his work.
  //
  // `kind` is recorded with every sighting for exactly this reason. Falling
  // back to the old inference only when it is missing keeps rows written
  // before it existed readable.
  const kind = String(row.kind || '') || (row.options?.length ? 'select' : 'text');
  // AN EMPLOYMENT ROW-MATE CANNOT ANSWER ALONE, BY DESIGN (F-533).
  //
  // The planner fills "Title", "From Date", "End Date", "Work location" and
  // "Reason for Leaving" from his work history only when a company field sits on
  // the same form — a bare "Title" is otherwise a salutation, a publication or a
  // degree name, and a bare "End Date" is any of a dozen things. Probing one
  // label on an otherwise empty form therefore reports "still unanswered" for
  // five questions that the real form answers, because the real form had the
  // company field this probe left out.
  //
  // So the probe reconstructs the minimum context: the row-mate plus a company
  // field, and the verdict is read off the row-mate's own action. The company
  // field is prepended, so `* Company Name` takes row 1 and the label under test
  // stays in row 1 with it.
  const ROW_MATE_RE = /^\*?\s*((job|position)\s*)?title$|^\*?\s*(from|to|start(ing)?|end(ing)?)\s*date$|^\*?\s*work\s*location|^\*?\s*reason\s*for\s*leaving$/i;
  const field = (label) => {
    const probe = { id: 'probe', label, type: kind, options: row.options || [], required: false };
    if (!ROW_MATE_RE.test(String(label || '').trim())) return [probe];
    return [{ id: 'probe-company', label: '* Company Name', type: 'text', options: [], required: true }, probe];
  };
  const answered = (label) => {
    try {
      const list = field(label);
      const plan = planForm(list, profile, {});
      const act = (plan.actions || [])[list.length - 1];
      // THE PLANNER CALLS IT `action`, AND THIS READ `act.kind` (F-536).
      //
      // `planForm` has never returned a `kind` on a field, so all three of the
      // guards written against it were dead: `act.kind === 'unknown'` was
      // `undefined === 'unknown'`, always false. The empty-value check below was
      // doing the whole job by accident, which is why this went unnoticed — it
      // rejects an unknown, because an unknown carries no value.
      //
      // What it could NOT do is recognise a real answer that carries no value.
      // A ticked consent box and a finished upload both answer their question
      // with nothing, so five settled questions were reported as his work,
      // including Tesla's required consent checkbox and four job-board filters.
      const action = String(act.action || act.kind || '');
      if (!act || action === 'unknown') return null;
      // A DELIBERATE BLANK IS SETTLED, NOT OUTSTANDING (F-530).
      //
      // He was asked, and the answer is nothing on every form, forever — no
      // middle name, no Facebook, no employee ID at a company he has never
      // worked for. Those rows would otherwise sit here permanently, crowding
      // out the questions one line of YAML really would end.
      //
      // Checked BEFORE the empty-value guard below, which exists for the
      // opposite case: a rule that plans a fill with nothing in it because his
      // profile has a gap.
      // A SKIP THAT CARRIES A REASON IS A DECISION, and the reason says which.
      // A deliberate blank and a job-board filter are both settled — nothing
      // about them will ever change, so they are noise in his queue. A skip with
      // no reason is not claimed as an answer.
      if (action === 'skip') {
        const why = String(act.why || '');
        return /deliberately left blank|policy|a filter on the job board|not a question on the form/i.test(why)
          ? { kind: 'settled', value: '' }
          : null;
      }
      const value = act.value ?? act.option ?? act.optionIndex ?? '';
      // AN EMPTY ANSWER IS NOT AN ANSWER. The first version of this counted any
      // action that was not `unknown`, and reported "Employee ID(if
      // applicable)" as something the engine could already answer — it plans a
      // fill with nothing in it, which is exactly the question being left.
      //
      // A TICK AND AN UPLOAD ARE THE EXCEPTIONS: they answer their question
      // without carrying a value. Tesla's required consent checkbox is planned
      // `check`, and it was being reported as unanswered for that reason alone.
      if (action === 'check' || action === 'upload') return { kind: action, value: '' };
      return String(value).trim() ? { kind: action, value } : null;
    } catch { return null; }
  };
  const asIs = answered(clean);
  if (asIs) return { verdict: 'answerable-now', ...asIs };
  const stripped = normaliseQuestion(raw);
  const afterStrip = stripped && stripped !== clean.toLowerCase() ? answered(stripped) : null;
  if (afterStrip) return { verdict: 'phrasing', ...afterStrip };
  return { verdict: 'his' };
}

// ── the report ───────────────────────────────────────────────────────

/**
 * Print the ledger, most costly first, with a verdict on each.
 *
 * The verdict is the whole point of his idea: a list of things the engine
 * could not do is a chore, and a list split into "this one is ours to fix" and
 * "this one is genuinely yours" is a work queue.
 */
async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const rows = listUnanswered({ min: all ? 1 : 1 });
  if (!rows.length) {
    console.log('\nNothing recorded yet. The log fills as forms are planned.\n');
    return;
  }
  const { planForm, loadApplyProfile } = await import('./apply-plan.mjs');
  const profile = loadApplyProfile();

  // `--retire` deletes the rows the planner now answers. Not the default: the
  // report is read far more often than the ledger is cleaned, and a command
  // that quietly deletes evidence every time it prints is one he cannot trust
  // to just show him the list.
  if (args.includes('--retire')) {
    const { retired, kept } = retireAnswered({ planForm, profile });
    console.log(`\nRetired ${retired.length} question${retired.length === 1 ? '' : 's'} the engine now answers; ${kept} left.`);
    for (const k of retired) console.log(`  ✓ ${k}`);
    console.log('');
    return;
  }

  const judged = rows.map((r) => ({ ...r, answer: answerability(r, { planForm, profile }) }));
  if (args.includes('--json')) {
    console.log(JSON.stringify(judged, null, 1));
    return;
  }

  const ours = judged.filter((r) => r.answer.verdict !== 'his');
  const his = judged.filter((r) => r.answer.verdict === 'his');

  console.log(`\n── Questions left for him ──`);
  console.log(`${rows.length} distinct, ${rows.reduce((n, r) => n + r.times, 0)} sightings across `
    + `${new Set(rows.flatMap((r) => r.companies)).size} employers\n`);

  if (ours.length) {
    console.log(`  ${ours.length} the engine can already answer — these are matcher bugs, not his work:\n`);
    for (const r of ours) {
      console.log(`  ${String(r.times).padStart(3)}x  ${r.key}`);
      console.log(`       ${r.answer.verdict === 'phrasing'
        ? 'the PHRASING defeats it: it answers once the boilerplate is stripped'
        : 'it answers this label as it stands — something else dropped it'}`
        + (r.answer.value ? ` → "${String(r.answer.value).slice(0, 48)}"` : ''));
      for (const w of r.wordings.slice(0, 3)) console.log(`       seen as: "${w.slice(0, 96)}"`);
      if (r.options.length) console.log(`       options: ${r.options.slice(0, 6).map((o) => `"${String(o).slice(0, 24)}"`).join(', ')}`);
      console.log('');
    }
  }
  if (his.length) {
    console.log(`  ${his.length} genuinely his — no source in the profile answers them:\n`);
    for (const r of his) {
      console.log(`  ${String(r.times).padStart(3)}x  ${r.key}`);
      for (const w of r.wordings.slice(0, 2)) console.log(`       seen as: "${w.slice(0, 96)}"`);
      if (r.options.length) console.log(`       options: ${r.options.slice(0, 6).map((o) => `"${String(o).slice(0, 24)}"`).join(', ')}`);
      if (r.companies.length) console.log(`       at: ${r.companies.slice(0, 4).join(', ')}`);
      console.log('');
    }
  }
  console.log('  Answer one for good by teaching the matcher (jarvis/apply-plan.mjs) or by\n'
    + '  adding the fact to config/profile.yml — then it never reaches this list again.\n');
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
