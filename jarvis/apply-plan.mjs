/**
 * THE PLAN — every decision about a form, made outside the browser.
 *
 * The browser extension discovers what is on the page (labels, types, options)
 * and sends that here; this returns what to do with each field. Nothing about
 * WHAT to answer lives in the extension, for three reasons that all point the
 * same way:
 *
 *   - the answers come from data/jarvis/apply-profile.yml and cv.md, which are
 *     his files on his disk and have no business inside a browser extension;
 *   - the matching rules in jarvis/apply/_answers.mjs took twelve rounds against
 *     live forms to get right, and a second copy of them would drift;
 *   - a decision made here is testable, and a decision made in a content script
 *     is only observable by watching a real form.
 *
 * So the extension is hands and this is judgement. The Playwright driver already
 * works this way — it calls the same resolveLabel and the same chooseOption —
 * which is why swapping the hands does not mean rewriting the engine.
 *
 * THE SUBMIT RULE IS ENFORCED HERE TOO. No plan this file produces ever contains
 * an action that presses Submit. It is not a setting.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { resolveLabel, tidyLabel } from './apply/_answers.mjs';
import { chooseOption, polarityOf, CERT_RE, CERT_NOT_RE } from './apply/_form.mjs';
import { wdValue } from './apply/_workday-keys.mjs';
import { applyFamilyTitles, applyTitles } from './resume-variants.mjs';
import { workEntries, educationEntries, rankedSkills } from './apply/_experience.mjs';
import { isWrittenQuestion, answerKind, targetWords, groupSeries } from './apply/essay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROFILE_PATH = path.join(HERE, '..', 'data', 'jarvis', 'apply-profile.yml');

/**
 * Load the apply profile. Throws rather than exiting: this runs inside the
 * dashboard server, and a missing profile is a 500 on one request, not a reason
 * to take his job board down.
 */
export function loadApplyProfile(file = PROFILE_PATH) {
  if (!existsSync(file)) throw new Error(`apply-profile not found at ${file} — create it first`);
  return yaml.load(readFileSync(file, 'utf-8')) || {};
}

// The resume-slot test lives in apply/_form.mjs so the Playwright driver and
// the planner share ONE copy — see F-255. Re-exported here because that is
// where callers and tests have always imported it from.
//
// IMPORTED as well as re-exported, and the distinction is not cosmetic:
// `export { x } from '…'` forwards the binding WITHOUT creating a local one, so
// `planField`'s own call to `isResumeField` below threw
// `ReferenceError: isResumeField is not defined`. It surfaced inside the
// browser, because fill.test.mjs reaches planForm through `exposeFunction` —
// a Node bug wearing a page's clothes.
import { RESUME_FIELD_RE, NOT_RESUME_RE, PARSE_SLOT_RE, COVER_LETTER_FIELD_RE, isResumeField, isCoverLetterField } from './apply/_form.mjs';

export { RESUME_FIELD_RE, NOT_RESUME_RE, isResumeField, isCoverLetterField };

/**
 * How many items to add to a multi-select prompt.
 *
 * His skills list is thirty-odd entries. Each one is a click plus a wait for a
 * remote search, so adding all of them would take longer than the rest of the
 * application put together, and a skills box with thirty tags in it reads as
 * machine-filled to the human who opens it. The first dozen are the ones the
 * resume leads with anyway.
 */
export const MAX_MULTI = 8;

/**
 * The name a skills taxonomy (Workday's, LinkedIn's) files a skill under, when
 * it differs from how his resume writes it. Each is the SAME skill spelled
 * out, never a broader or different one: a search for "Lean" alone would
 * surface "Lean Six Sigma Black Belt", a certification he does not hold.
 */
const SKILL_SEARCH_NAMES = [
  [/^gd&t$/i, 'Geometric Dimensioning'],
  [/^fea$/i, 'Finite Element'],
  [/^dfm$/i, 'Design For Manufactur'],
  [/^dfa$/i, 'Design For Assembly'],
  [/^plc$/i, 'Programmable Logic'],
  [/^cnc machining$/i, 'CNC'],
  [/^excel vba$/i, 'Visual Basic For Applications'],
  [/^3-axis milling$/i, 'Milling'],
  [/^robotics integration$/i, 'Robotics'],
  [/^python$/i, 'Python (Programming'],
];
export function skillSearchName(skill) {
  const s = String(skill || '').trim();
  const hit = SKILL_SEARCH_NAMES.find(([re]) => re.test(s));
  return hit && hit[1].toLowerCase() !== s.toLowerCase() ? hit[1] : null;
}
/** …and how many a REQUIRED one may try, since a miss there costs the step. */
export const MAX_MULTI_REQUIRED = 40;

/**
 * Pick a BAND that contains a number — "3.85" against "3.7 - 4.0".
 *
 * `chooseOption` matches by text, so a GPA or a years-of-experience answer never
 * matched a banded option list and the question went unanswered on every form
 * that asks that way. Measured on Veeva: GPA 3.85 against
 * ["3.7 - 4.0", "3.3 - 3.69", "3.0 - 3.29", "2.7 - 2.99"] — an obvious answer no
 * text match can find.
 *
 * AMBIGUITY IS REFUSED, not guessed. "2 years" against ["0-2", "2-5"] sits on the
 * boundary of both, and picking one would be inventing a fact about his
 * experience. Returns -1 in that case, and the question stays his.
 */
export function chooseBand(want, options) {
  // The hyphen in "0-2" is a RANGE, not a minus sign. A leading `-?` swallowed
  // it and read the band as 0 to −2, so "1 year" fell outside "0-2" and inside
  // "2-5" — the exact opposite of the truth. The lookbehind keeps a sign only
  // where one can actually be.
  const NUM = /(?<![\d.])-?\d+(?:\.\d+)?/g;
  const first = (s) => { const m = String(s).match(NUM); return m ? parseFloat(m[0]) : null; };
  const value = first(want);
  if (value === null) return -1;

  // A NUMBER OFF THIS SCALE IS A NUMBER ABOUT SOMETHING ELSE.
  //
  // `first()` takes the leading figure out of the answer whatever it means, and
  // an open-ended top band accepts anything above its floor. So a graduation
  // date of "June 2027" read as 2027, cleared the floor of "6+ years", and
  // claimed SIX YEARS OF EXPERIENCE for a new grad — reported as filled, which
  // is the worst outcome this engine can produce. "$95,000" did the same, and
  // so did a bare "2027".
  //
  // The menu states its own scale: the largest figure printed on it. An answer
  // an order of magnitude past that is not an answer to this question, whatever
  // arithmetic says. A year is refused outright — a point in time is never a
  // quantity, even when it happens to land inside the span.
  const stated = options.reduce((max, opt) => {
    const nums = (String(opt).match(NUM) || []).map(parseFloat).map(Math.abs);
    return nums.length ? Math.max(max, ...nums) : max;
  }, 0);
  if (stated > 0 && Math.abs(value) > stated * 10) return -1;
  if (/\b(19|20)\d{2}\b/.test(String(want))) return -1;

  const hits = [];
  const bounds = {};
  options.forEach((opt, i) => {
    const t = String(opt);
    if (/select|choose|prefer not|decline|n\/?a\b/i.test(t)) return;
    const nums = (t.match(NUM) || []).map(parseFloat);

    // "10+" / "10 or more" / "over 10" / ">10" / "at least 10"
    if (nums.length === 1 && /\+|≥|>|\bor more\b|\bor higher\b|\bor above\b|\bover\b|\babove\b|\bmore than\b|\bat least\b|\bgreater than\b/i.test(t)) {
      if (value >= nums[0]) { hits.push(i); bounds[i] = { lo: nums[0], hi: Infinity }; }
      return;
    }
    // "under 2" / "less than 2" / "<2" — TSMC writes its bottom GPA tier
    // "One of my degrees is <3.299", and the symbol was not on this list, so
    // the option was skipped entirely rather than read as a band.
    if (nums.length === 1 && /≤|<|\bunder\b|\bless than\b|\bbelow\b|\bfewer\b|\bup to\b|\bat most\b|\bor less\b|\bor lower\b/i.test(t)) {
      if (value < nums[0]) { hits.push(i); bounds[i] = { lo: -Infinity, hi: nums[0] }; }
      return;
    }
    if (nums.length < 2) return;
    const [lo, hi] = [Math.min(nums[0], nums[1]), Math.max(nums[0], nums[1])];
    if (value >= lo && value <= hi) { hits.push(i); bounds[i] = { lo, hi }; }
  });

  if (hits.length === 1) return hits[0];
  // TIERED MENUS OVERLAP ON PURPOSE. TSMC offers "3.0- 3.299" and, below it,
  // "One of my degrees is <3.299" — a 3.1 is truthfully inside both, and the
  // form means the tightest statement that is true, which is how anyone
  // reading it picks. A band nested inside every other candidate wins.
  // Bands that merely straddle ("1-3" and "2-5" for a 2) name no tightest
  // answer and stay unanswered, which is the existing behaviour.
  if (hits.length > 1) {
    const within = (a, b) => a.lo >= b.lo && a.hi <= b.hi;
    const tightest = hits.filter((k) => hits.every((j) => j === k || within(bounds[k], bounds[j])));
    if (tightest.length === 1) return tightest[0];
  }
  return -1;   // none, or more than one — either way it is not ours to decide
}

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The inverse of `monthYear`: a parsed {month, year} written back out the way
 * his profile writes it ("May 2026"), for a free-text date box.
 *
 * `parseMonthYear` counts months from 1, not 0 — the opposite of `monthYear`
 * in this file and of `Date`. Getting that backwards would put an employment
 * date one month off on a real application, which nobody would catch by eye.
 * A bare year stays a bare year rather than gaining a guessed January.
 */
export function spellMonthYear(parsed) {
  if (!parsed || !parsed.year) return '';
  const m = Number(parsed.month);
  return m >= 1 && m <= 12 ? `${MONTH_FULL[m - 1]} ${parsed.year}` : String(parsed.year);
}

/**
 * Read a month-and-year out of an answer: "June 2027", "05/2027", "2027-06".
 * Day precision is not wanted here and not trusted — these answers are written
 * as a month.
 */
export function monthYear(text) {
  const t = String(text == null ? '' : text);
  let m = /\b(\d{4})[-/](\d{1,2})\b/.exec(t);                     // 2027-06
  if (m) return { year: +m[1], month: +m[2] - 1 };
  m = /\b(\d{1,2})[-/](\d{4})\b/.exec(t);                          // 05/2027
  if (m) return { year: +m[2], month: +m[1] - 1 };
  m = new RegExp(`\\b(${MONTH_ABBR.join('|')})[a-z]*\\.?\\s+(\\d{4})\\b`, 'i').exec(t);
  if (m) return { year: +m[2], month: MONTH_ABBR.indexOf(m[1].toLowerCase()) };
  return null;
}

/**
 * Answer "When would you be available if an offer was accepted?" — a menu of
 * delays measured FROM THE OFFER, not a menu of dates.
 *
 * His profile holds a date ("June 2027"). The options hold offsets
 * ("Immediately", "1-2 months after offer"). No text matches, and feeding the
 * date to `chooseBand` is how "2027" once cleared the floor of the top band —
 * it now refuses that outright, which left this common question unanswered.
 *
 * So convert: his date minus today, in whole months, and THEN match the bands.
 * Only fires when the menu really is offer-relative — at least one option
 * naming an offer, a notice period or immediacy, and at least one carrying a
 * unit of time — so a menu of plain numbers can never be read this way.
 */
export function chooseDelay(want, options, now = new Date()) {
  const when = monthYear(want);
  if (!when) return -1;
  const live = options.filter((o) => o != null && String(o).trim());
  if (live.length < 2) return -1;
  const RELATIVE = /\bafter\b|\bfrom\b|\bnotice\b|\bimmediat|\bright away\b|\bas soon as\b|\bcurrently available\b/i;
  const TIMED = /\b(day|week|month|year)s?\b/i;
  if (!live.some((o) => RELATIVE.test(String(o)))) return -1;
  if (!live.some((o) => TIMED.test(String(o)))) return -1;

  const months = (when.year - now.getFullYear()) * 12 + (when.month - now.getMonth());
  if (months <= 0) {
    const soon = options.findIndex((o) => o != null && /\bimmediat|\bright away\b|\bas soon as\b|\bcurrently available\b/i.test(String(o)));
    if (soon >= 0) return soon;
  }

  // THE BANDS ARE NOT ALWAYS IN MONTHS, AND A NUMBER WITHOUT ITS UNIT IS WRONG.
  //
  // This computed a figure in MONTHS and handed it to `chooseBand`, which
  // matched it against whatever numbers the options happened to carry. On
  // Tesla's live form (2026-09-20) the menu was in WEEKS —
  //
  //   ["- Select -", "Immediately", "In 1-2 weeks", "In 3-4 weeks",
  //    "In 5-12 weeks", "More than 12 weeks"]
  //
  // — his availability is June 2027, that is 9 months out, and `9` fell
  // squarely inside "In 5-12 weeks". The truthful option, "More than 12
  // weeks", was sitting right beside it. It went onto TWO live Tesla
  // applications telling them he could start in about two months, and it was
  // not review-flagged, so he had no way to catch it.
  //
  // So the figure is converted into the unit the menu is actually written in.
  // The unit is taken from the options themselves, by majority: a menu mixing
  // "1-2 weeks" with "6 months" is read in the unit most of it uses, and a tie
  // keeps months, which is the unit this function has always spoken.
  const unit = (() => {
    const seen = { day: 0, week: 0, month: 0, year: 0 };
    for (const o of live) {
      const m = /\b(day|week|month|year)s?\b/i.exec(String(o));
      if (m) seen[m[1].toLowerCase()] += 1;
    }
    let best = 'month';
    for (const k of ['day', 'week', 'year']) if (seen[k] > seen[best]) best = k;
    return best;
  })();
  const PER_MONTH = { day: 30.44, week: 4.345, month: 1, year: 1 / 12 };
  const figure = Math.max(months, 0) * PER_MONTH[unit];
  // Rounded, because the bands are written in whole numbers and a figure of
  // 39.1 weeks must read as 39. Kept at one decimal for years, where rounding
  // 0.75 to 1 would claim a whole year he does not need.
  return chooseBand(String(unit === 'year' ? Math.round(figure * 10) / 10 : Math.round(figure)), options);
}

/** A residence question — "Are you currently living in the US or Canada?" */
const RESIDENCE_RE = /where\s+(are|do)\s+you\s+(currently\s+)?(located|based|live|reside)|are\s+you\s+(currently\s+)?(living|residing|located|based)\s+in|do\s+you\s+(currently\s+)?(live|reside)\s+in/i;

/** The ways a form writes the country he actually lives in. */
const US_RE = /^(us|u\.s\.?|usa|u\.s\.a\.?|united states( of america)?|america)$/i;

/**
 * Answer a residence question whose OPTIONS are places.
 *
 * "Are you currently living in the US or Canada?" offers US / Canada / Other,
 * and his country reads "United States of America" — no text match, so it went
 * unanswered on a form where the answer is not in doubt.
 *
 * Deliberately narrow. It answers only when an option IS the country or state he
 * lives in; it never answers a yes/no "do you reside in <city>?", because
 * getting that wrong in either direction is worse than leaving it, and it is one
 * field. Returns -1 when unsure, which leaves the question his.
 */
export function chooseResidence(label, options, profile) {
  if (!RESIDENCE_RE.test(String(label))) return -1;
  const mine = [profile?.identity?.country, profile?.identity?.state, profile?.identity?.city]
    .filter(Boolean).map((s) => String(s).toLowerCase());
  if (!mine.length) return -1;

  const iAmUS = mine.some((m) => US_RE.test(m) || /united states/i.test(m));
  let hit = -1;
  options.forEach((opt, i) => {
    const t = String(opt).trim();
    if (!t || /select|choose|prefer not|decline/i.test(t)) return;
    const isUS = US_RE.test(t);
    if ((isUS && iAmUS) || mine.some((m) => m === t.toLowerCase())) {
      if (hit === -1) hit = i;
    }
  });
  return hit;
}

/**
 * Decide a field's VALUE — by Workday's stable key first, then by its label.
 *
 * Measured on a live GlobalFoundries application: Workday's inputs carry no
 * usable label, name or automation-id of their own, so a label matcher alone was
 * leaving most of My Information blank. The wrapping `formField-*` id answers
 * exactly, and the table that maps those to his profile is the same one the
 * Playwright driver has always used (jarvis/apply/_workday-keys.mjs).
 *
 * `wdValue` may return an ARRAY — "How Did You Hear About Us?" offers truthful
 * alternatives because every tenant words that list differently — so the first
 * option the form actually has is the one taken.
 */
export function decide(field, label, profile) {
  const key = String(field?.key || '');
  if (key.startsWith('formField-')) {
    const v = wdValue(key, profile);
    // `null` from the table means "we know this field and it should stay empty"
    // — Phone Extension is the example. That is a decision, not a gap, and
    // reporting it as unanswered puts noise in the list he actually reads.
    if (v === null) return { kind: 'blank' };
    if (v !== undefined) {
      const picked = pickOffered(v, field);
      if (picked) return { ...picked, review: false };
    }
  }

  // THE SAME COURTESY FOR LABEL RULES.
  //
  // A rule may hand back alternatives too, and for one question it must: "How
  // did you hear about us?" is free text on some forms and a fixed list on
  // others, and the honest answer differs in shape. His profile carries both —
  // `how_heard: "LinkedIn"` and `heard_about_us: "Job Board or Social Media"` —
  // and only the first was reachable, so a form offering
  // ["Job Board or Social Media", "Employee Referral", …] came back
  // `no option matches "LinkedIn"` and went unanswered, with the matching
  // answer sitting in his profile the whole time.
  const r = resolveLabel(label, profile);
  if (r.kind === 'answer' && Array.isArray(r.value)) {
    const picked = pickOffered(r.value, field);
    return picked ? { ...r, ...picked } : { kind: 'unknown' };
  }
  return r;
}

/**
 * WHY A LIST WENT UNANSWERED, TRUTHFULLY.
 *
 * "no option matches X" is the right sentence when a list was read and X was
 * not in it. It is the WRONG sentence when the list arrived empty, and that is
 * the commoner case on the tenants that render a listbox from script: the
 * options exist only once the widget is opened, so the plan sees none.
 *
 * His Micron run, 2026-09-18, reported the veteran self-identification
 * question as "no option matches" while holding the answer — the form offers
 * "I AM NOT A PROTECTED VETERAN" and the engine wanted exactly that. Telling
 * him the answer was not on offer, when what happened is that nothing was on
 * offer yet, sends him looking for the wrong thing. Naming the value he needs
 * turns the line into an instruction he can act on in one click.
 */
function noChoiceWhy(value, options) {
  return (Array.isArray(options) && options.length)
    ? `no option matches "${value}"`
    : `this list sent no choices to pick from — open it and choose "${value}"`;
}

/**
 * Choose the first alternative this form will actually accept.
 *
 * Free text takes the first non-empty one. A list takes the first the list
 * offers, and falls back to the first non-empty so the answer is still reported
 * rather than silently dropped — `chooseOption` refusing it downstream is a
 * better outcome than pretending there was no answer.
 */
function pickOffered(value, field) {
  const options = Array.isArray(field?.options) ? field.options : [];
  const wanted = (Array.isArray(value) ? value : [value])
    .filter((w) => w != null && String(w).trim() !== '')
    .map((w) => String(w).trim());
  if (!wanted.length) return null;
  // NO LIST YET, SO KEEP EVERY ALTERNATIVE (F-551). A Workday prompt shows its
  // options only once opened, and collapsing the ladder to its first rung sent
  // Intel's language dropdowns the literal "Native or Bilingual" and nothing
  // else to try. The page tries them in order against the list it can see.
  if (!options.length) {
    return wanted.length > 1
      ? { kind: 'answer', value: wanted[0], alternatives: wanted }
      : { kind: 'answer', value: wanted[0] };
  }
  const offered = wanted.find((w) => chooseOption(w, options) >= 0);
  return { kind: 'answer', value: offered || wanted[0] };
}

/**
 * Decide one field.
 *
 * Returns an action the extension can execute without thinking:
 *   fill    put `value` in the input
 *   select  choose option index `optionIndex`
 *   check   tick it
 *   upload  attach the resume
 *   skip    policy says leave it alone (EEO self-ID, SSN, certifications)
 *   unknown we have no answer — leave blank and tell him
 */
export function planField(field, profile) {
  const type = String(field?.type || 'text').toLowerCase();
  const options = Array.isArray(field?.options) ? field.options : [];
  // A QUESTION THAT IS ONLY ITS OPTIONS (2026-09-24). Workday's disability
  // self-identification asks "Please check one of the boxes below:" and the
  // word disability appears only in the boxes — so no rule knew it, and it was
  // left for him on all four Workday forms that night. The topic is read from
  // the options when the label does not name one.
  const rawLabel = String(field?.label || '').trim();
  const optText = options.map((o) => String(o?.text ?? o)).join(' | ');
  const label = !/disabilit|veteran/i.test(rawLabel) && /\b(have|had)\s+(had\s+)?a\s+disability\b|\bdo\s+not\s+have\s+a\s+disability\b/i.test(optText)
    ? `Disability — ${rawLabel}`
    : !/disabilit|veteran/i.test(rawLabel) && /\bprotected\s+veteran\b|\bnot\s+a\s+veteran\b/i.test(optText)
      ? `Veteran status — ${rawLabel}`
      : rawLabel;
  // No `selector`. It was on here from an early version, written in this one
  // place and read in none — `discover()` has never produced one, so every
  // action carried `selector: undefined`. Left alone it is the kind of thing
  // that gets trusted later: a field that looks like a way to find an element
  // and silently is not. Fields are matched by identity (label + type + name),
  // which is what content.js actually does.
  const base = { label, type, name: field?.name, id: field?.id };

  // A JOB BOARD'S OWN FILTERS ARE NOT AN APPLICATION FORM.
  //
  // Gradient Robotics' Ashby board put four of them in the leftover list in one
  // sighting (2026-09-20): `departmentId`, `locationId`, `workplaceType` and
  // `Employment`, each reported as a question he had failed to answer. They are
  // the dropdowns that narrow the LISTING — the page had no application on it
  // at all — so every one was noise in the only list he actually reads, and
  // they went into the cross-employer ledger as if they were questions
  // employers ask.
  //
  // Two signals together, never one. A lone "All Locations" is a legitimate
  // answer on a relocation question, and a lone "(8)" could be anything; a
  // select that offers BOTH an "All …" entry and an option carrying a result
  // count is a filter and nothing else. Requiring both is what keeps this from
  // eating a real question.
  if ((type === 'select' || type === 'radio') && options.length >= 2) {
    const opts = options.map((o) => String(o ?? ''));
    if (opts.some((o) => /^all\s+\w/i.test(o.trim())) && opts.some((o) => /\(\d+\)\s*$/.test(o.trim()))) {
      return { ...base, action: 'skip', why: 'a filter on the job board, not a question on the form' };
    }
  }

  // A CONDITIONAL FOLLOW-UP IS NOT A GAP.
  //
  // "If you checked any of the boxes above other than…" and "If you checked
  // either 'I am a Citizen or Legal…'" are on the live Torc Robotics form
  // beneath the export-control question. He ticked "None/Not applicable", so
  // neither applies to him and both are correctly blank — but they were
  // reported as "no answer for this question", which reads as the engine
  // failing on two questions it in fact handled.
  //
  // Still listed, never hidden: whether the condition was met is something
  // only he can confirm, and a follow-up quietly dropped is how a required
  // field goes missing.
  // `if your` is included, and it is not a nicety. Measured on the live
  // Relativity Space form, "If your location differs from the location posted…,
  // are you willing to commute and/or relocate?" was answered correctly — but
  // only by luck, because the rule that matched happened to be the right one.
  // Reworded to "If your disability requires accommodation, please describe
  // what you need", the same path answers "No, I do not have a disability".
  // Same fault as F-248, one word away from the pattern that catches it.
  if (/^\s*if\s+(you\s+(checked|selected|answered|indicated|are|have|marked)|your)\b/i.test(label)) {
    // ANSWER THE QUESTION, NEVER THE CONDITION.
    //
    // Skipping all of these was too blunt. Measured on the live Veeva form,
    // two follow-ups whose condition is TRUE of him were reported as not
    // applying:
    //
    //   "If you are a candidate with under 2 years of experience,
    //    please share your GPA"                    -> he is, and it is 3.85
    //   "If you are authorized to work in the US,
    //    what is your start date?"                 -> he is, June 2027
    //
    // But answering the whole label is worse than skipping it. Resolved as
    // one string, "If you have a disability, please describe any
    // accommodations you need" comes back "No, I do not have a disability" —
    // the EEO answer, matched off the CONDITION, pasted into a box asking
    // what help he needs. That is the fabrication-shaped failure this project
    // keeps finding, and on the most sensitive question on the form.
    //
    // So the condition is dropped and only what follows the comma is
    // resolved. "please describe any accommodations you need" answers to
    // nothing, which is correct; "please share your GPA" answers to 3.85,
    // which is also correct. The question is what gets answered either way.
    // …and with NO comma, split where the question starts (2026-09-24, ABB):
    // "If you are successful in this role what would be your notice period?"
    // is the notice-period question, and was left for him as a follow-up.
    const body = String(label).match(/^\s*if\s+your?\b[^,]{0,80},\s*(.+)$/is)?.[1]?.trim()
      || (() => { const m = String(label).match(/^\s*if\s+your?\b[^,?]{0,80}?\s((?:what|when|which|how|do|does|are|will|would|can|please)\b[^,]*\?)\s*$/is); return m ? m[1].trim() : null; })();
    // No comma means no separable question — "If you selected yes above" is
    // the whole label. Nothing to resolve, and the skip stands.
    if (body && !/^\s*if\s+you\b/i.test(body)) {
      const inner = planField({ ...field, label: body }, profile);
      // Only a real answer earns the fall-through. Anything still unknown
      // keeps the clearer explanation below.
      if (inner && inner.action !== 'unknown') {
        return { ...inner, label, why: `${inner.why || 'answered'} — only if the condition above applies to you`, review: true };
      }
    }
    return { ...base, action: 'unknown', why: 'only applies if the question above it applies to you' };
  }

  // A Workday prompt Workday has ALREADY filled correctly (from his candidate
  // profile) is the commonest case, and the right thing to do with it is
  // nothing. Typing into one replaces an opaque id with prose and breaks the
  // step — measured live as "Enter a valid format for Phone Number".
  if (type === 'prompt') {
    // WORKDAY'S PLACEHOLDER IS NOT AN ANSWER, and this branch must not depend
    // on the page having said so.
    //
    // "Select One" is what an UNTOUCHED Workday dropdown shows. Every read of
    // `current` below treats a non-empty value as "already answered", so a
    // placeholder made an untouched required question plan as `skip` — counted,
    // never surfaced, and absent from the list of what was left for him.
    // Measured on a live Jabil step: four required dropdowns, one reported.
    //
    // discover.js now strips it at source. This guard exists anyway because
    // Chrome serves an unpacked extension out of its own cache until it
    // reloads, so a stale copy keeps sending the placeholder for a while after
    // the fix ships — and the failure it causes is the silent kind.
    const shownNow = String(field.current || '').trim();
    const currentNow = /^(select one|select a value)$/i.test(shownNow) ? '' : shownNow;

    const decided = decide(field, label, profile);
    if (decided.kind === 'blank') return { ...base, action: 'skip', why: 'deliberately left blank' };
    if (decided.kind !== 'answer') {
      if (currentNow) return { ...base, action: 'skip', why: `already set to "${currentNow}"` };
      // A consent question rendered as a dropdown. His standing instruction is
      // yes to every consent and AI-screening question, and that rule only ever
      // reached CHECKBOXES — so "By selecting YES, I consent to receive
      // recruiting SMS messages…", a REQUIRED react-select on the live Astranis
      // form, blocked the application. Always review-flagged: he presses Submit
      // himself, and a consent answered on his behalf is one he still sees.
      if (CERT_RE.test(label) && !CERT_NOT_RE.test(label)) {
        return {
          ...base, action: 'prompt', value: 'Yes', current: '',
          promptKind: field.promptKind || 'single', review: true,
          why: 'consent — your standing answer is yes',
        };
      }
      return { ...base, action: 'unknown', why: 'a dropdown we have no answer for' };
    }
    // IS IT ALREADY ANSWERED? Asked with the matcher, not with `===`.
    //
    // A raw string compare only recognises the answer we would type, never the
    // option the form actually offers. Traced on a live Micron form:
    //
    //   pass 1  current=""              -> prompt "United States of America"
    //           the list offers "United States", it is chosen, field committed
    //   pass 2  current="United States" -> "united states" !== "united states of
    //           america", so NOT "same", so it prompts the SAME field again —
    //           and the retry destroyed the correct answer
    //
    // That is the whole of the Country bug I chased through five hypotheses,
    // and it is why the outcome varied run to run: whether the needless second
    // attempt happened to re-succeed or wipe the field was pure timing.
    //
    // `chooseOption` already knows "United States" answers "United States of
    // America" — it is the same call that picked the option in the first place.
    // Asking it here means a field is re-prompted only when it genuinely holds
    // something else.
    // …and a bare yes/no already on the form is the answer when his value
    // EXPRESSES that polarity. Measured on Lam (2026-09-04): pass 1 chose "No"
    // for Veteran from "I am not a Veteran."; pass 2 saw current="No", asked
    // chooseOption against the single option ["No"] — which needs both a yes
    // and a no to read a sentence by its negation — got -1, re-drove the
    // prompt, and the page ended up holding the typed sentence and an error.
    const current = currentNow;
    const same = current
      && (current.toLowerCase() === String(decided.value).trim().toLowerCase()
        || chooseOption(String(decided.value), [current]) >= 0
        || (/^(yes|no)$/i.test(current) && polarityOf(String(decided.value)) === current.toLowerCase()));
    if (same) return { ...base, action: 'skip', why: `already set to "${current}"` };

    // A MULTI prompt takes one item at a time. Workday's "Type to Add Skills"
    // was handed the whole comma-separated skills list as a single search term,
    // which matches nothing and silently adds none of them — on the field that
    // is pure ATS keyword value and is almost always left empty.
    const kind = field.promptKind || 'single';
    if (kind === 'multi' && String(decided.value).includes(',')) {
      // A REQUIRED list gets his whole list to try (F-370). Jabil's skills box
      // is required and its taxonomy has neither SolidWorks nor Inventor; the
      // first eight of his thirty skills were sent, the worker stopped at two
      // misses in a row, and the step could not move on. Required, the
      // worker keeps going down the list until something lands.
      const cap = field.required ? MAX_MULTI_REQUIRED : MAX_MULTI;
      const values = String(decided.value).split(',').map((s) => s.trim()).filter(Boolean).slice(0, cap);
      return { ...base, action: 'prompt', values, value: values[0], current: field.current || '', promptKind: kind, review: decided.review };
    }
    // A SINGLE prompt with alternatives (a proficiency ladder, "LinkedIn" or
    // "Job Board or Social Media") hands the page all of them; it stops at the
    // first one the list accepts (F-551).
    if (kind !== 'multi' && Array.isArray(decided.alternatives) && decided.alternatives.length > 1) {
      return { ...base, action: 'prompt', values: decided.alternatives, value: decided.value, current: field.current || '', promptKind: kind, review: decided.review };
    }
    return { ...base, action: 'prompt', value: decided.value, current: field.current || '', promptKind: kind, review: decided.review };
  }

  if (type === 'file') {
    // THE COVER LETTER GOES ON BY ITSELF, AS A FILE (F-410). It used to be
    // "attach it yourself": the letter existed only as text in the panel, so a
    // form with a cover-letter slot got nothing. The same never-on-top-of-
    // something rule as the resume — a slot that already holds a file is his.
    if (isCoverLetterField(field)) {
      if (Number(field?.attached) > 0) {
        return { ...base, action: 'skip', why: `${field.attached} file(s) already in the cover-letter slot — not adding another` };
      }
      return { ...base, action: 'upload-letter', why: 'cover letter' };
    }
    if (!isResumeField(field)) {
      // The parse slot is left alone on purpose (F-352), and that is a
      // decision, not a question he still has to answer: Becton Dickinson's
      // report listed "Easy Apply — Choose a file or drop it here" among the
      // things left for him on every walk (F-359).
      if (PARSE_SLOT_RE.test(label) || PARSE_SLOT_RE.test(String(field?.name || field?.id || ''))) {
        return { ...base, action: 'skip', why: 'the form\'s parse-a-resume slot — the resume is attached to its own slot' };
      }
      return { ...base, action: 'unknown', why: 'a file upload that is not the resume — attach it yourself' };
    }
    // Never attach on top of something already there. Resuming a Workday draft
    // once stacked three copies of the same PDF on a live application, and a
    // recruiter opening three identical resumes draws one conclusion.
    if (Number(field?.attached) > 0) {
      return { ...base, action: 'skip', why: `${field.attached} file(s) already attached — not adding another` };
    }
    return { ...base, action: 'upload', why: 'resume' };
  }

  // Consent and AI-screening boxes get ticked. His standing instruction, and the
  // reason it is checked BEFORE resolveLabel: "I certify that…" would otherwise
  // fall through as an unanswerable question and be left blank, which voids the
  // application more quietly than any wrong answer.
  if (type === 'checkbox' && CERT_RE.test(label) && !CERT_NOT_RE.test(label)) {
    return { ...base, action: 'check', why: 'consent / certification' };
  }

  // THE SAME CONSENT QUESTION, RENDERED AS A DROPDOWN.
  //
  // His standing instruction is yes to every consent and AI-screening question.
  // That was implemented for checkboxes only, so the identical question was
  // ticked as a checkbox, and SKIPPED as a `<select>` — because consent
  // phrasing also sits in DEFAULT_NEVER (which is there to stop it being
  // TEXT-filled) and that check ran first.
  //
  // Must sit above the `never` branch for the same reason the checkbox one
  // does. Always review-flagged: he presses Submit himself, and this is the
  // list he reads before he does.
  if ((type === 'select' || type === 'radio') && options.length && CERT_RE.test(label) && !CERT_NOT_RE.test(label)) {
    const idx = chooseOption('Yes', options);
    if (idx >= 0) {
      return {
        ...base, action: 'select', optionIndex: idx, value: options[idx],
        review: true, why: 'consent — your standing answer is yes',
      };
    }
  }

  const decided = decide(field, label, profile);
  if (decided.kind === 'never') return { ...base, action: 'skip', why: 'policy — never auto-filled' };
  if (decided.kind === 'blank') return { ...base, action: 'skip', why: 'deliberately left blank' };
  if (decided.kind === 'unknown') {
    // The answer table has no rule for "Are you currently living in the US or
    // Canada?", but the options themselves carry the answer. Checked here rather
    // than in the select branch below, because an unanswered question never
    // reaches that branch.
    if ((type === 'select' || type === 'radio') && options.length) {
      const idx = chooseResidence(label, options, profile);
      if (idx >= 0) return { ...base, action: 'select', optionIndex: idx, value: options[idx], review: true };
    }


    // "SAVE MY ANSWERS FOR FUTURE APPLICATIONS" IS NOT A CONSENT BOX.
    //
    // On the live Micron form it landed in the unanswered list as "no answer
    // for this question", which reads as a failure. It is not a question we
    // failed to understand — it asks whether a company may KEEP his personal
    // data on their system for later, and his standing yes-to-consent rule is
    // about consents that gate an application, not about data retention on a
    // third party. So it is left unticked, deliberately, and said so.
    if (/save (my )?(answers|information|details|profile)|remember (me|my)\b/i.test(label)) {
      return { ...base, action: 'skip', why: 'optional — whether they keep your answers for later is your call, so it is left unticked' };
    }

    // A WRITTEN QUESTION IS NOT AN UNKNOWN — IT IS A QUESTION WITH AN ANSWER
    // NOBODY HAD WRITTEN YET.
    //
    // "Tell us about a project you are proud of", "Why should we hire you",
    // "Describe a technical challenge" — the answer table has no rule for any
    // of them and never will, because the answer is prose about his own work
    // rather than a value out of his profile. Every one of them landed here as
    // "no answer for this question, and it is required", which is how a run
    // that filled thirty fields still handed him the form back.
    //
    // The plan only MARKS these. The text is written by jarvis/apply/essay.mjs
    // against cv.md and the posting, requested by the page while the rest of
    // the form fills, and checked before it is typed — the same shape the
    // resume and the cover letter already have.
    // THE EMPLOYER TRAVELS WITH THE QUESTION. Plenty of forms ask by name —
    // "Why Applied Intuition?" — and no general pattern can tell a company's
    // name from any other noun. `applyingTo` is already on the profile for
    // exactly this kind of thing (F-376).
    const applyingTo = String(profile?.applyingTo || '');
    if (isWrittenQuestion(field, { company: applyingTo })) {
      const found = answerKind(label, { company: applyingTo }) || { kind: 'other' };
      const target = targetWords(field, found.kind);
      return {
        ...base,
        action: 'essay',
        kind: found.kind,
        target,
        // The help text beside the box: a word limit, an example, the rest of
        // a question whose <label> only carries its first clause.
        context: String(field?.near || '').slice(0, 800),
        // The box's own limits travel with it, so the writer is held to them.
        maxLength: field?.maxLength || 0,
        placeholder: String(field?.placeholder || '').slice(0, 200),
        review: true,   // he reads every word that goes out under his name
        why: `a written question — answered from cv.md and this posting (${found.kind})`,
      };
    }

    // `decided.why` distinguishes "your profile leaves this blank" — the
    // question was understood and there is genuinely nothing to say — from
    // "this engine has no idea what this is". Both stay on the list he reads;
    // only one of them is a gap in the engine.
    // AN OPTIONAL FIELD LEFT BLANK IS NOT A FAULT, AND MUST NOT READ AS ONE.
    //
    // "Please specify" and "Additional Link" on the live Neuralink form are
    // both `required: false`. Both were reported with the same seven words used
    // for a required question the engine could not handle. Reading down a
    // column of those is exactly what makes a working run look like a list of
    // errors — and that impression is expensive, because it hides the ones that
    // genuinely need him among the ones that need nobody.
    //
    // Still listed, never hidden. Triage flags, it never drops, and that
    // applies to the report as much as to the deck: he may well WANT to add a
    // portfolio link. It just is not a failure that he has not.
    if (!field?.required) {
      return {
        ...base,
        action: 'unknown',
        optional: true,
        why: decided.why || 'optional — nothing in your profile answers this, so it stays blank',
      };
    }
    return { ...base, action: 'unknown', why: decided.why || 'no answer for this question, and it is required' };
  }

  if (type === 'select' || type === 'radio') {
    let idx = chooseOption(decided.value, options);
    // A banded list ("3.7 - 4.0") never matches by text; try containment.
    if (idx == null || idx < 0) idx = chooseBand(decided.value, options);
    // A DATE FOLDED INTO A BUCKET IS ALWAYS HIS TO CHECK.
    //
    // Everything else here matches a stated answer to an option that says the
    // same thing. This one computes — his date, minus TODAY, converted into
    // the menu's unit — so its answer depends on when the form was opened and
    // is the only one in this function that can be right in the morning and
    // wrong in the spring. Tesla got "In 5-12 weeks" for a June 2027
    // availability on two live applications with `review: false`, and there
    // was nowhere he could have caught it.
    let bucketedDate = false;
    if (idx == null || idx < 0) { idx = chooseDelay(decided.value, options); bucketedDate = idx >= 0; }
    // "US" is not a text match for "United States of America".
    if (idx == null || idx < 0) idx = chooseResidence(label, options, profile);
    // A form that offers only "Bachelor of Arts" and "Bachelor of Science"
    // cannot be answered with "Bachelor's", and chooseOption now refuses to
    // guess between them rather than claiming a degree he does not hold. But
    // the answer is not unknown — cv.md says "Bachelor of Science: Mechanical
    // Engineering" — so ask again with the full degree before giving up.
    if ((idx == null || idx < 0) && /education|degree/i.test(label) && profile?.education?.degree) {
      const full = chooseOption(profile.education.degree, options);
      if (full >= 0) {
        return { ...base, action: 'select', optionIndex: full, value: options[full], intended: profile.education.degree, review: decided.review };
      }
    }
    // A NATIVE <select> THAT WAS EMPTY WHEN THE PAGE WAS READ (F-485).
    //
    // `discover()` types a field `select` only for a real <select> element,
    // and takes its options straight off `el.options`. So `type: 'select'`
    // with an empty list means exactly one thing: the element had no <option>
    // children at that moment. Micron's veteran self-identification question
    // reached the plan that way, and was reported unanswerable while the
    // engine held the right answer and the form offered exactly that row.
    //
    // Those options arrive — on focus, on click, or just later in the page's
    // own time. So this is not a question to give up on: it is one to look at
    // again when the filler gets there. `optionIndex: -1` says "the list was
    // not readable yet; open it, read it, and choose this".
    //
    // Only when there IS an answer to look for. An empty list and nothing to
    // put in it is still his.
    if ((idx == null || idx < 0) && !options.length && String(decided.value || '').trim()) {
      return {
        ...base, action: 'select', optionIndex: -1, lateOptions: true,
        value: decided.value, intended: decided.value, review: decided.review,
      };
    }
    if (idx == null || idx < 0) {
      return { ...base, action: 'unknown', why: noChoiceWhy(decided.value, options), value: decided.value, options };
    }
    return {
      ...base, action: 'select', optionIndex: idx, value: options[idx],
      intended: decided.value, review: decided.review || bucketedDate,
    };
  }

  if (type === 'checkbox') {
    // A checkbox GROUP is a multiple-choice question, not a yes/no. Lever asks
    // "Are you willing to work in office or a remote only role?" as two
    // checkboxes; treating it as binary read his answer ("Open to on-site,
    // hybrid, or remote") as "not yes" and left the question blank.
    // COPIES OF ONE BOX ARE ONE BOX (F-369). Workday's "I am fluent in this
    // language." sits under every language he adds, and the two copies were
    // grouped by their shared label into a two-option "choice" whose options
    // read the same — so "Yes" matched neither and the box was left for him.
    // A group whose options all say the same thing is a yes/no, and a yes
    // ticks every copy.
    const distinct = new Set(options.map((o) => String(o || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean));
    if (options.length > 1 && distinct.size > 1) {
      let idx = chooseOption(decided.value, options);
      if (idx == null || idx < 0) idx = chooseBand(decided.value, options);
    if (idx == null || idx < 0) idx = chooseDelay(decided.value, options);
      // "No" against a list with no "No" on it — [Cuba, Iran, …, None/Not
      // applicable] — is handled inside chooseOption, so every field type gets
      // it rather than only checkbox groups. It lived here first and was moved
      // the moment a second caller needed it; two code paths for one behaviour
      // is the drift this project keeps paying for.
      if (idx == null || idx < 0) {
        return { ...base, action: 'unknown', why: noChoiceWhy(decided.value, options), value: decided.value, options };
      }
      return { ...base, action: 'select', optionIndex: idx, value: options[idx], intended: decided.value, review: decided.review };
    }
    return /^\s*(yes|true|1)\b/i.test(decided.value)
      ? { ...base, action: 'check', why: label, review: decided.review }
      : { ...base, action: 'skip', why: `answer is "${decided.value}" — leaving it unticked` };
  }

  // A RIGHT ANSWER IN THE WRONG SHAPE IS A BLANK FIELD. Both engines go through
  // here, so neither can learn this separately.
  const fmt = formatForType(decided.value, type);
  if (fmt.value === null) return { ...base, action: 'unknown', why: fmt.why };
  // A PHONE IS TEN DIGITS WITH DASHES, unless the field asks for the country
  // code. Measured live: Eightfold (Lam, Eaton) rejects "+1 (555) 000-0000"
  // with "only use digits, dashes or parentheses" and the field stays empty;
  // Workday's own key map has stripped the +1 for months (_workday-keys.mjs).
  // "555-000-0000" is the one shape every ATS met so far accepts.
  // Only a phone that still carries "+", spaces or parentheses. Ten bare
  // digits are the Workday key map's shape, proven live for months; leave them.
  const phoneField = type === 'tel' || (/phone|mobile|contact\s*number/i.test(label) && !/include|with|enter|provide|add|prefix/i.test(label));
  const asPhone = phoneField && /[^\d]/.test(String(fmt.value)) ? usPhone(fmt.value) : null;
  const fitted = fitToLength(asPhone || fmt.value, field?.maxLength);
  return { ...base, action: 'fill', value: fitted, review: decided.review || !!fmt.review };
}

/** "+1 (555) 000-0000" → "555-000-0000"; anything that is not a US number is left alone. */
export function usPhone(v) {
  const d = String(v || '').replace(/[^\d]/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d.length === 10 ? d : null;
  return ten ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : null;
}

/**
 * Plan a whole form.
 *
 * `familyKey` rewrites the profile's work-history TITLES to match the resume
 * about to be attached — the ATS shows the form and the PDF on one screen, and a
 * title that disagrees between them is the inconsistency a recruiter is
 * guaranteed to notice.
 */
/**
 * The extension build this server expects to be talking to.
 *
 * Chrome does NOT auto-update an unpacked extension. Every fix in this project
 * lands in the repo and stays invisible until he opens chrome://extensions and
 * presses reload — so a stale copy reproduces bugs that were fixed hours ago,
 * with nothing on screen to say so. Bump this whenever the extension changes in
 * a way that matters, and the panel will tell him to reload instead of letting
 * him conclude the tool is still broken.
 */
export const EXPECTED_EXTENSION = '1.47.0';

/** Compare "1.2.0"-style versions. Missing or unparseable counts as older. */
export function extensionIsStale(got, want = EXPECTED_EXTENSION) {
  const parts = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(got), parts(want)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) < (b[i] || 0)) return true;
    if ((a[i] || 0) > (b[i] || 0)) return false;
  }
  return false;
}

/**
 * The entries to add on Workday's My Experience, per section the page
 * reported. Built from the same profile lists the Playwright driver enters
 * (`work_experience`, `education_entries`), with the resume's titles applied
 * first so the form says what the PDF says. A section already holding a
 * filled entry gets nothing — a second pass, a resumed draft and a tenant that
 * parsed the resume all look the same from here, and adding on top would
 * duplicate his history on a real application.
 */
export function planEntries(sections, profile) {
  const out = [];
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!s || s.filled) continue;
    if (s.kind === 'work') {
      const entries = workEntries(profile);
      if (entries.length) out.push({ kind: 'work', entries });
    } else if (s.kind === 'education') {
      const entries = educationEntries(profile);
      if (entries.length) out.push({ kind: 'education', entries });
    } else if (s.kind === 'language') {
      const entries = (Array.isArray(profile?.languages) ? profile.languages : []).filter((l) => l && (l.name || typeof l === 'string')).map((l) => (typeof l === 'string' ? { name: l } : l));
      if (entries.length) out.push({ kind: 'language', entries });
    } else if (s.kind === 'website') {
      // WORKDAY'S "WEBSITES" SECTION (F-553): empty until Add is pressed, so
      // his portfolio never went in. His rule, 2026-09-20: the portfolio for
      // every link field that is not LinkedIn. Bare domain, as he asked.
      const url = profile?.identity?.portfolio || profile?.identity?.website;
      if (url) out.push({ kind: 'website', entries: [{ url: String(url).trim() }] });
    }
  }
  return out;
}

export function planForm(fields, profile, { familyKey = null, titles = null, extensionVersion = null, sections = [], company = null, jd = '' } = {}) {
  // A CREDENTIAL FORM IS NOT AN APPLICATION, and the server refuses the whole
  // thing rather than trusting the page to have noticed.
  //
  // Choosing "Apply Manually" on Workday while signed out lands on a Create
  // Account page: email, password, verifyPassword — carrying the same
  // `formField-*` wrappers a real step does. Signing in and creating accounts
  // are his, always, so there is nothing here to be clever about.
  const list = Array.isArray(fields) ? fields : [];
  // A ONE-TIME CODE IS A CREDENTIAL, AND IT ARRIVES IN HIS EMAIL (F-484).
  //
  // Read off his own Micron run, 2026-09-18: the plan came back holding six
  // fields called "Please enter OTP character 1" … "6", each a single box for
  // one digit. They are typed `text`, so the password guard below walked
  // straight past them, and the engine reported a verification wall as six
  // questions it could not answer. Nothing can answer them — the code is in
  // his inbox, it expires in minutes, and typing it is signing in.
  //
  // Matched on the shape as well as the words, because tenants label these
  // every way there is: several one-character boxes together is an OTP widget
  // whatever the label says.
  const otpLabelled = list.filter((f) => /\b(otp|one[\s-]?time (?:pass)?(?:code|password)|verification code|security code|confirmation code|passcode|2fa|two[\s-]factor)\b/i
    .test(String(f?.label || '')));
  const singleCharBoxes = list.filter((f) => Number(f?.maxLength) === 1
    && /^(?:text|tel|number)$/i.test(String(f?.type || 'text')));
  if (otpLabelled.length >= 1 || singleCharBoxes.length >= 4) {
    return {
      actions: [],
      titleChanges: [],
      summary: { fill: 0, select: 0, check: 0, upload: 0, letter: 0, essay: 0, skip: 0, unknown: 0 },
      review: [],
      unanswered: [],
      submit: false,
      credentialForm: true,
      submitNote: 'This is a one-time verification code, sent to your email and good for a few '
        + 'minutes. Type it yourself — it is a credential, and nothing here will guess at one.',
    };
  }
  if (list.some((f) => String(f?.type || '').toLowerCase() === 'password'
    || /^\s*(password|confirm password|verify password|new password)\s*$/i.test(String(f?.label || '')))) {
    return {
      actions: [],
      titleChanges: [],
      summary: { fill: 0, select: 0, check: 0, upload: 0, letter: 0, essay: 0, skip: 0, unknown: 0 },
      review: [],
      unanswered: [],
      submit: false,
      credentialForm: true,
      submitNote: 'This is a sign-in or account-creation form. Filling it is yours, not mine.',
    };
  }

  // WHO HE IS APPLYING TO, so a question about his history with them can be
  // answered from his history (F-376). Nothing else reads it.
  let effective = company ? { ...profile, applyingTo: String(company) } : profile;
  let titleChanges = [];
  // The titles the BUILT resume presents win over the family's defaults: the
  // per-posting plan may have chosen "Robotics Engineer Intern" where the
  // family says "Automation Engineer Intern", and the form must say what the
  // attached PDF says (Alex, 2026-09-03).
  if (titles && (Array.isArray(titles) ? titles.length : Object.keys(titles).length)) {
    const out = applyTitles(profile, new Map(Array.isArray(titles) ? titles : Object.entries(titles)));
    effective = out.profile;
    titleChanges = out.changed;
  } else if (familyKey) {
    const out = applyFamilyTitles(profile, familyKey);
    effective = out.profile;
    titleChanges = out.changed;
  }

  // Every action carries the identity of the field it was decided for, so the
  // page can match them up instead of trusting that two arrays stayed in step.
  // Measured the hard way: an action list one item longer than the field list
  // shifted everything after it, and "Washington" was typed into the phone-code
  // prompt on a live GlobalFoundries application. Position is not identity.
  // WHOSE END DATE IS THIS?
  //
  // Greenhouse's education block renders `school--0`, `degree--0`,
  // `discipline--0`, `end-month--0`, `end-year--0`. On the live Astranis form
  // both date halves came back unanswered, and they are his GRADUATION date —
  // the most load-bearing fact on a new-grad application.
  //
  // "End date" alone must never be answered from his graduation, because an
  // EMPLOYMENT row asks the same question about a job he left, and putting
  // May 2027 there is a false claim about his work history. The index is what
  // makes it safe: `end-month--0` is a graduation date only when a `school--0`
  // sits beside it on the same form. No context, no answer.
  const eduRows = new Set();
  for (const f of list) {
    const m = /^school--(\d+)$/.exec(String(f?.id || ''));
    if (m) eduRows.add(m[1]);
  }
  const graduationHalf = (f) => {
    const m = /^end-(month|year)--(\d+)$/.exec(String(f?.id || ''));
    return m && eduRows.has(m[2]) ? m[1] : null;
  };

  // AND THE START DATE OF THAT SAME ROW IS NOT HIS AVAILABILITY.
  //
  // Measured on a live Astranis form: "Start date month" and "Start date year"
  // sit in the education block, matched the start-date rule, and were answered
  // **"June 2027 (graduating May 2027)"** — his job availability written into
  // when he started university, and into a `number` field at that. A false
  // claim about his education, and one a registrar could check.
  //
  // His profile does not record when he started, so the honest answer is
  // nothing. Same row index as the graduation fix, opposite conclusion.
  const educationStart = (f) => {
    const m = /^start-(month|year)--(\d+)$/.exec(String(f?.id || ''));
    return !!(m && eduRows.has(m[2]));
  };

  // A FLAT EMPLOYMENT-HISTORY BLOCK, WHERE THE ROW NUMBER IS ONLY THE ORDER.
  //
  // Measured 2026-09-19 on a profile-builder form: `* Company Name`, `* Title`,
  // `From Date`, `End Date`, `* Work location (City)` and `* Reason for
  // Leaving` arrived as six flat labels carrying no id, no index and no
  // section — so every one was reported as a question nobody could answer,
  // while `work_experience` in his profile answered five of them outright.
  //
  // Workday's My Experience is not this shape and does not come through here;
  // `planEntries` above owns that, from the same profile list.
  //
  // THE ROW INDEX IS THE OCCURRENCE ORDER, and that is the whole reason this
  // lives in planForm instead of planField. A form with three employment rows
  // sends "Company Name" three times; answering each of them from his most
  // recent job would put Applied Materials on all three — false employment
  // history on a live application, which is far worse than a blank. The Nth
  // "Company Name" belongs to the Nth job, and when he has run out of jobs the
  // remaining rows get nothing.
  //
  // Same corroboration rule as eduRows above: a bare "Title" or "End Date" is
  // only employment history when a company field sits on the same form. No
  // context, no answer.
  const EMPLOYMENT_FIELDS = [
    ['company', /^(company|employer)(\s*name)?$/i],
    ['title', /^((job|position)\s*)?title$/i],
    ['start', /^(from|start(ing)?)\s*date$/i],
    ['end', /^(to|end(ing)?)\s*date$/i],
    ['location', /^work\s*location\s*\(?\s*(city)?\s*\)?$/i],
    ['reason', /^reason\s*for\s*leaving$/i],
  ];
  const employmentPart = (f) => {
    const bare = tidyLabel(String(f?.label || ''));
    if (!bare) return null;
    for (const [part, re] of EMPLOYMENT_FIELDS) if (re.test(bare)) return part;
    return null;
  };
  const jobs = workEntries(effective);
  const employmentRow = new Map();      // field index -> job index
  {
    const parts = list.map((f) => employmentPart(f));
    // The company field is what proves this is an employment block at all.
    // Without one, "Title" is a salutation, a publication or a degree name and
    // "End Date" is any of a dozen things.
    if (jobs.length && parts.includes('company')) {
      const seen = Object.create(null);
      list.forEach((f, i) => {
        const part = parts[i];
        if (!part) return;
        const row = (seen[part] = (seen[part] ?? -1) + 1);
        if (row < jobs.length) employmentRow.set(i, { row, part });
      });
    }
  }
  const employmentValue = (i) => {
    const hit = employmentRow.get(i);
    if (!hit) return null;
    const job = jobs[hit.row];
    if (!job) return null;
    const v = hit.part === 'company' ? job.company
      : hit.part === 'title' ? job.title
        : hit.part === 'location' ? job.location
          : hit.part === 'start' ? spellMonthYear(job.start)
            // A role he still holds has no end date and never gets a made-up
            // one — Workday hides the field entirely for a current job.
            : hit.part === 'end' ? (job.current ? '' : spellMonthYear(job.end))
              : hit.part === 'reason' ? (job.current
                ? effective?.answers?.current_employer_reason
                : effective?.answers?.reason_for_leaving)
                : null;
    const value = String(v ?? '').trim();
    return value ? { value, part: hit.part, row: hit.row } : null;
  };

  // A SKILLS TABLE, ONE SKILL PER ROW, RANKED FOR THIS POSTING.
  //
  // Same flat-form shape as the employment block above and from the same page:
  // `* Skill`, required, no index. His answer when asked, 2026-09-20: "Top ~10,
  // picked per posting" — so the Nth `Skill` box gets the Nth most relevant
  // skill for the job being applied to, and the pool is `answers.skills`, which
  // came from cv.md. A form with one skill row gets the single best match; one
  // with fifteen runs out at ten and leaves the rest alone rather than padding.
  const skillRows = [];
  list.forEach((f, i) => {
    const bare = tidyLabel(String(f?.label || ''));
    if (/^skills?$/i.test(bare) && String(f?.type || '').toLowerCase() !== 'textarea' && !f?.multiline) skillRows.push(i);
  });
  const skillFor = new Map();
  if (skillRows.length) {
    const ranked = rankedSkills(effective, { jd, limit: Math.max(10, skillRows.length) });
    skillRows.forEach((fieldIndex, n) => { if (ranked[n]) skillFor.set(fieldIndex, ranked[n]); });
  }

  const actions = (Array.isArray(fields) ? fields : []).map((f, i) => {
    const half = graduationHalf(f);
    const job = employmentValue(i);
    const skill = skillFor.get(i);
    const planned = job
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '',
          action: 'fill', value: job.value, review: true,
          why: `job ${job.row + 1} in your history — ${jobs[job.row].company || jobs[job.row].title}` }
      : skill
        ? { ...planField({ ...f, label: '' }, effective), label: f.label || '',
            action: 'fill', value: skill, review: true,
            why: jd ? 'one of your skills this posting asks for' : 'from your skills in cv.md' }
        : educationStart(f)
        ? { ...planField({ ...f, label: '' }, effective), label: f.label || '', action: 'unknown',
            why: 'when you started studying is not in your profile' }
        : half
          ? planField({ ...f, label: `Graduation ${half} — ${f.label || ''}` }, effective)
          : planField(f, effective);
    return {
      ...planned,
      at: i,
      key: f?.key || '',
      name: f?.name || '',
      fieldId: f?.id || '',
    };
  });
  // A SPLIT DATE GETS ITS PARTS (2026-09-24). "09/23/2026" typed into each of
  // Workday's month, day and year boxes left "9", "" and "23" on four forms.
  for (const a of actions) {
    const part = list[a.at]?.datePart;
    if (a.action !== 'fill' || !part) continue;
    const m = String(a.value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) continue;
    a.value = part === 'month' ? m[1].padStart(2, '0') : part === 'day' ? m[2].padStart(2, '0') : m[3];
    a.datePart = part;
  }
  // A SKILLS SEARCH BOX, RANKED FOR THIS POSTING (F-552, 2026-09-24).
  //
  // "struggles with skills too." Intel's "Type to Add Skills" was sent his
  // skills in profile order, SolidWorks and Inventor first; the taxonomy had
  // neither, and two misses ended the field with nothing in it. The box now
  // gets the skills this posting names first, and each carries the name a
  // skills taxonomy files it under, tried when the short form misses.
  for (const a of actions) {
    if (a.action !== 'prompt' || !Array.isArray(a.values) || a.promptKind !== 'multi') continue;
    if (!/skill/i.test(String(a.label || ''))) continue;
    const ranked = rankedSkills(effective, { jd, limit: a.values.length });
    if (ranked.length) { a.values = ranked; a.value = ranked[0]; }
    const alts = {};
    for (const s of a.values) { const alt = skillSearchName(s); if (alt) alts[s] = alt; }
    if (Object.keys(alts).length) a.searchAlts = alts;
    a.skills = true;
  }
  // ONE RESUME, ONE SLOT.
  //
  // Ashby renders two file inputs that both look like the resume: an optional
  // "Autofill from resume" parser at the top of the form and the real required
  // attachment lower down. Filling both is not just wasteful — the parser makes
  // Ashby read the PDF and write ITS guesses into the very fields we are about
  // to answer from his profile. That is the same hazard as Workday's "Autofill
  // with Resume", which this engine deliberately declines.
  //
  // So when several uploads survive, exactly one wins: required beats optional,
  // a resume-ish identifier beats none, and anything whose surrounding wording
  // says "autofill" loses outright.
  // ONE FILE PER KIND OF SLOT. The cover letter is grouped separately from the
  // resume (F-410): a Greenhouse form has one of each, and they must not
  // compete with one another — only with another slot of their own kind.
  for (const kind of ['upload', 'upload-letter']) {
    const uploads = actions.filter((a) => a.action === kind);
    if (uploads.length <= 1) continue;
    const wanted = kind === 'upload' ? RESUME_FIELD_RE : COVER_LETTER_FIELD_RE;
    const score = (a) => {
      const f = list[a.at] || {};
      if (/autofill|auto-fill|prefill|parse (your )?resume/i.test(String(f.near || ''))) return -1;
      return (f.required ? 2 : 0) + (wanted.test(`${f.id || ''} ${f.name || ''}`) ? 1 : 0);
    };
    const best = uploads.reduce((a, b) => (score(b) > score(a) ? b : a));
    for (const a of uploads) {
      if (a === best) continue;
      a.action = 'skip';
      a.why = kind === 'upload'
        ? 'a second resume slot on the same form — only one gets the file'
        : 'a second cover-letter slot on the same form — only one gets the file';
    }
  }

  const by = (a) => actions.filter((x) => x.action === a);
  return {
    actions,
    titleChanges,
    summary: {
      fill: by('fill').length,
      select: by('select').length,
      check: by('check').length,
      upload: by('upload').length,
      letter: by('upload-letter').length,
      essay: by('essay').length,
      skip: by('skip').length,
      unknown: by('unknown').length,
    },
    review: actions.filter((a) => a.review).map((a) => ({ label: a.label, value: a.value })),
    unanswered: by('unknown').map((a) => ({ label: a.label, why: a.why })),
    // The written questions, so the page can start them before it reaches
    // them: each takes a model call, and a form with three of them would
    // otherwise spend three waits in a row at the bottom of the walk.
    //
    // GROUPED FIRST. "Please provide three examples… First example:", "Second
    // example:", "Third example:" is one question asked three times, and the
    // second and third labels carry an ordinal and nothing else. Grouping
    // hands each of them the stem to answer and the siblings to differ from
    // (F-444); without it the model writes three answers to a question only
    // the first box was told, about the same piece of work.
    essays: groupSeries(by('essay').map((a) => ({
      label: a.label, kind: a.kind, target: a.target, context: a.context, maxLength: a.maxLength || 0, placeholder: a.placeholder || '',
    }))),
    // Workday My Experience entries, when the page reported its sections.
    entries: planEntries(sections, effective),
    // Said in the payload itself, not only in a comment, so anything reading a
    // plan can see the rule rather than having to know it.
    submit: false,
    submitNote: 'Fill everything. Submit nothing. Pressing Submit is his, every time.',
    // Loud, because a stale extension looks exactly like a bug that was fixed.
    staleExtension: extensionVersion && extensionIsStale(extensionVersion)
      ? `you are running extension ${extensionVersion}; this dashboard expects ${EXPECTED_EXTENSION}. Reload it at chrome://extensions — the fixes are not in the copy Chrome has.`
      : null,
  };
}


const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The value this input will actually KEEP, given its type.
 *
 * A right answer in the wrong shape is a blank field. `<input type="date">`
 * silently discards anything that is not YYYY-MM-DD, and `type="number"`
 * discards anything with a letter in it — so his real, correct answers
 *
 *     "June 2027 (graduating May 2027)"   -> start date, a date input
 *     "2 years"                           -> years of experience, a number
 *
 * were written, refused by the browser, and reported back as "the page did not
 * keep the value". Both are on nearly every form he touches.
 *
 * The driver already stripped digits for number fields at fill time; the
 * extension — the engine he actually uses — did not. Putting it in the PLAN is
 * what stops that being two behaviours again (F-223, F-254, F-255, all the same
 * shape).
 *
 * Returns `{ value: null, why }` rather than a guess when the answer holds
 * nothing the field can take. "Open — targeting market rate" into a number box
 * has no number in it, and inventing one would be inventing a salary.
 */
export function formatForType(value, type) {
  if (typeof value !== 'string' && typeof value !== 'number') return { value };
  const v = String(value).trim();
  if (!v) return { value: v };

  // WORKDAY WANTS THE www. Measured live on KLA: "Invalid LinkedIn URL" for
  // https://linkedin.com/in/…, accepted the moment it read
  // https://www.linkedin.com/in/…, and Save and Continue would not move until
  // it did. Every other ATS takes either. Same profile, one spelling.
  const li = v.match(/^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(in|pub)\/([^\s?#]+)/i);
  if (li) return { value: `https://www.linkedin.com/${li[1].toLowerCase()}/${li[2].replace(/\/+$/, '')}` };

  if (type === 'date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { value: v };
    let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return { value: iso(m[3], m[1], m[2]) };
    m = v.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()]) return { value: iso(m[3], MONTHS[m[1].toLowerCase()], m[2]) };
    // A MONTH IS NOT A DAY, and a date input has no way to say so. Filing the
    // first of the month is the conventional reading of "June 2027" and the
    // only one the control can hold — but it is more precise than he was, so it
    // is flagged for his eye rather than filed quietly.
    m = v.match(/([A-Za-z]{3,9})\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()]) return { value: iso(m[2], MONTHS[m[1].toLowerCase()], 1), review: true };
    m = v.match(/^(\d{4})-(\d{1,2})$/);
    if (m) return { value: iso(m[1], m[2], 1), review: true };
    return { value: null, why: `"${v}" is not a date this field can hold` };
  }

  if (type === 'number') {
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (!m) return { value: null, why: `this field only takes a number and your answer is "${v}"` };
    return { value: m[0], review: m[0] !== v };
  }

  return { value: v };
}

/**
 * The same value, spelled to fit — never a truncation.
 *
 * `maxlength="10"` on a phone box is common (it wants ten digits) and his
 * profile holds a formatted international number. Writing it produced a
 * truncated, WRONG phone number; the read-back caught that and reported the
 * field blank, which is safe and still leaves him typing it himself.
 *
 * Only spellings that are the same fact are offered: punctuation removed, then
 * the country code dropped for a US number. Anything that would change what the
 * value MEANS is refused, so a long address is left alone and reported rather
 * than quietly cut in half.
 */
export function fitToLength(value, max) {
  const v = String(value ?? '');
  if (!max || v.length <= max) return v;
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 15) {
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    for (const form of [digits, national]) if (form.length <= max) return form;
  }
  return v;
}
