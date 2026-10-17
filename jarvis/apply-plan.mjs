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

import { resolveLabel, tidyLabel, HIGHEST_PROFICIENCY, whichRule } from './apply/_answers.mjs';
import { chooseOption, polarityOf, CERT_RE, CERT_NOT_RE, PLACEHOLDER_OPTION_RE } from './apply/_form.mjs';
import { contradicts, polarity } from './apply/_facts.mjs';
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
  const profile = yaml.load(readFileSync(file, 'utf-8')) || {};
  // HIS CV, FOR "DO YOU HAVE EXPERIENCE WITH X?" ONLY (2026-09-26). ReLogic
  // asked "Do you have hands-on experience with robotic arms?" and the check
  // read only his skills and job descriptions — the 6-DOF arm he designed
  // and the 4-DOF one he built are projects, in cv.md. `experienceWith` is
  // the one reader; its whole-word matching is unchanged.
  try {
    const cv = path.join(HERE, '..', 'cv.md');
    if (existsSync(cv) && profile.cvText == null) profile.cvText = readFileSync(cv, 'utf-8');
  } catch { /* the profile alone, as before */ }
  return profile;
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
export function chooseBand(want, rawOptions) {
  // MONEY IN SHORTHAND (Hyve, 2026-09-27, F-621): "$90 - $100k" is ninety to a
  // hundred THOUSAND — the k covers the range — and "$90,000" is one number.
  // Read raw, the band topped out at 100 and his $90000 target was refused as
  // "off this scale" by the guard below.
  const money = (s) => {
    let t = String(s);
    while (/(\d),(\d{3})(?!\d)/.test(t)) t = t.replace(/(\d),(\d{3})(?!\d)/, '$1$2');
    if (/\d\s*k\b/i.test(t)) t = t.replace(/(?<![\d.])(\d+(?:\.\d+)?)(?:\s*k\b)?/gi, (m, n) => String(parseFloat(n) * 1000));
    return t;
  };
  const isMoney = /[$€£]|\d\s*k\b/i.test((rawOptions || []).map((o) => String(o?.text ?? o)).join(' '));
  const options = (rawOptions || []).map((o) => money(o?.text ?? o));
  want = money(want);
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
  // THE SAME OPTION TWICE IS ONE OPTION. SmartRecruiters' lists are read as
  // the option component and its inner row, so "3.5 and above" arrived twice
  // and two identical hits read as ambiguous (GPA, Western Digital,
  // 2026-09-24). Identical text → the first of them.
  if (hits.length > 1) {
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    const distinct = [...new Map(hits.map((i) => [norm(options[i]), i])).values()];
    if (distinct.length === 1) return Math.min(...hits);
    // TWO PAY BANDS SHARING AN EDGE, the target on it: "$80 - $90k" and "$90
    // - $100k" both hold $90,000. A pay band starts at its first figure, so the
    // one it opens wins — he chose "$90 - $100k" (Hyve, F-621). Pay only: a
    // count of years on an edge stays refused (the test below says why).
    if (isMoney && distinct.length === 2) {
      const opens = distinct.filter((i) => bounds[i]?.lo === value);
      const closes = distinct.filter((i) => bounds[i]?.hi === value);
      if (opens.length === 1 && closes.length === 1) return opens[0];
    }
  }
  // A VALUE IN THE ROUNDING GAP BETWEEN TWO BANDS takes the LOWER one. A menu
  // written to one decimal — "3.6-3.8", "3.9-4.0" — has no home for 3.85, and
  // Lexington's did exactly that (2026-09-24): the engine left it, and he
  // picked 3.6-3.8 himself. The lower band never overstates. Only a gap no
  // wider than the menu's own last digit counts; a real hole in the scale
  // stays his.
  if (!hits.length) {
    const closed = [];
    options.forEach((opt, i) => {
      const t = String(opt);
      if (/select|choose|prefer not|decline|n\/?a\b|\+|<|>|≤|≥|\bunder\b|\bover\b|\bless\b|\bmore\b|\bbelow\b|\babove\b/i.test(t)) return;
      const raw = t.match(NUM) || [];
      if (raw.length < 2) return;
      const nums = raw.map(parseFloat);
      const decimals = Math.max(...raw.map((r) => (r.split('.')[1] || '').length));
      closed.push({ i, lo: Math.min(nums[0], nums[1]), hi: Math.max(nums[0], nums[1]), step: 10 ** -decimals });
    });
    // The band above may be open-ended: "3.9 or above" beside "3.6-3.8" (the
    // Lexington co-op's own list, 2026-09-25 — the gap rule never fired).
    const openUp = [];
    options.forEach((opt, i) => {
      const t = String(opt);
      const raw = t.match(NUM) || [];
      if (raw.length !== 1 || !/\+|≥|>|\bor\s+(above|more|higher)\b|\band\s+(above|up|higher)\b|\bat\s+least\b/i.test(t)) return;
      openUp.push({ i, lo: parseFloat(raw[0]), step: 10 ** -((raw[0].split('.')[1] || '').length) });
    });
    const below = closed.filter((b) => b.hi < value).sort((a, b) => b.hi - a.hi)[0];
    const above = [...closed, ...openUp].filter((b) => b.lo > value).sort((a, b) => a.lo - b.lo)[0];
    if (below && above && above.lo - below.hi <= Math.max(below.step, above.step) + 1e-9) return below.i;
    // A LADDER OF MINIMUMS: "5+ years | 3+ years | 1 year | No experience"
    // (Re:Build's SolidWorks question, 2026-09-26). Beside "3+" and "5+", a
    // bare "1 year" is a step on the same ladder, and 2 years meets that step
    // and no higher one. The largest step he meets; never one he does not.
    // Only when the list states at least one open-ended minimum, so a list of
    // exact points ("1", "2", "4") is never read this way.
    if (openUp.length) {
      const steps = [...openUp];
      options.forEach((opt, i) => {
        const t = String(opt);
        const raw = t.match(NUM) || [];
        if (raw.length === 1 && !openUp.some((u) => u.i === i) && !/<|≤|\bunder\b|\bless\b|\bbelow\b|\bfewer\b|\bup\s+to\b|\bat\s+most\b|\bselect|\bchoose/i.test(t)) steps.push({ i, lo: parseFloat(raw[0]) });
      });
      const met = steps.filter((s) => s.lo <= value).sort((a, b) => b.lo - a.lo);
      if (steps.length >= 2 && met.length) return met[0].i;
    }
  }
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
/**
 * A month as a calendar picker's MM/DD/YYYY (Honda's react-datepicker,
 * 2026-10-02). His dates are months, so a start is the 1st and an end the
 * month's last day — never a day he did not give pretending to be one he did.
 * Accepts the parsed { month, year } or text ("May 2026", "05/2027").
 */
export function pickerDate(d, end = false) {
  // A parsed entry date counts months from 1; monthYear() counts from 0.
  const t = d && typeof d === 'object' ? null : monthYear(String(d || ''));
  const p = t ? { year: t.year, month: t.month + 1 } : d;
  const m = Number(p?.month), y = Number(p?.year);
  if (!(m >= 1 && m <= 12 && y > 1900)) return '';
  const day = end ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 1;
  return `${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}/${y}`;
}

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
  const band = chooseBand(String(unit === 'year' ? Math.round(figure * 10) / 10 : Math.round(figure)), options);
  if (band >= 0) return band;
  // LATER THAN EVERY TIMED OPTION, AND THE LIST SAYS WHAT TO DO THEN.
  // Orchard Robotics: "Immediately / Within 2 weeks of an offer / Within 1
  // month of an offer / Other (will discuss on call)" (audit, 2026-09-26): June
  // 2027 fits none of the timed rows, and "Other" is the true one. Only an
  // option that is not itself timed — never "three to six months", which
  // would understate him (Field AI's list has no such row and stays his).
  // Beyond the LONGEST timed option only: "Within 1 month" is true for a start
  // one month out, and must not lose to "Other".
  const longest = Math.max(0, ...live.map((o) => {
    const m = /(\d+(?:\.\d+)?)(?:\s*[-–to]+\s*(\d+(?:\.\d+)?))?\s*(day|week|month|year)s?\b/i.exec(String(o));
    if (!m) return 0;
    return Number(m[2] || m[1]) / PER_MONTH[m[3].toLowerCase()];
  }));
  if (months > longest) {
    const other = options.findIndex((o) => o != null && /^\s*other\b|\bwill\s+discuss\b|\bdiscuss\s+(on|in|during)\b|\bto\s+be\s+discussed\b|\bnegotiable\b|\blater\s+date\b/i.test(String(o)) && !TIMED.test(String(o)));
    if (other >= 0) return other;
  }
  return -1;
}

/** A residence question — "Are you currently living in the US or Canada?" */
// …and Waymo's "Please provide the state/region in which you currently reside"
// over [New York, Illinois, Another State in the US, APAC, EMEA, Other]
// (2026-09-24): the US option that is not another named state is his.
const RESIDENCE_RE = /where\s+(are|do)\s+you\s+(currently\s+)?(located|based|live|reside)|are\s+you\s+(currently\s+)?(living|residing|located|based)\s+in|do\s+you\s+(currently\s+)?(live|reside)\s+in|(state|region|country|location)[^?]{0,40}\b(in\s+which|where)\s+you\s+(currently\s+)?(live|reside|are\s+(located|based))/i;

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
  // HIS STATE IS NOT LISTED, BUT "ANOTHER US STATE" IS. Waymo: [New York,
  // Illinois, Another State in the US, APAC, EMEA, Other] — he is in
  // Washington (2026-09-24). Only the one option that says so; never "Other".
  if (hit === -1 && iAmUS) {
    const other = options.map((o, i) => [String(o || ''), i])
      .filter(([t]) => /\b(another|other)\b.{0,20}\b(state|us|u\.s\.?|united\s+states)\b/i.test(t) && /\bstate\b|\bus\b|\bu\.s\b|united\s+states/i.test(t));
    if (other.length === 1) hit = other[0][1];
  }
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
  const d = decideRaw(field, label, profile);
  // AN ARRAY IS ALTERNATIVES, never one answer. Nothing downstream reads an
  // array value, and String() of one is its items joined by commas — the
  // shape that put "…protected veterans" on HP's form (F-618).
  if (d?.kind === 'answer' && Array.isArray(d.value)) {
    const alts = (Array.isArray(d.alternatives) && d.alternatives.length ? d.alternatives : d.value).map(String);
    return { ...d, value: String(d.value[0] ?? ''), alternatives: alts };
  }
  return d;
}

function decideRaw(field, label, profile) {
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

  // A BARE "TITLE" WHOSE OPTIONS ARE COURTESY TITLES is the salutation. The
  // label rules refuse bare "Title" on purpose (it is his job title in an
  // employment row); the options are what give this one away. Oracle drew it
  // as seven radios — Capt., Doctor, Miss, Mr., Mrs., Ms., Rev. (Cummins,
  // 2026-10-02, left blank).
  {
    const opts = (field?.options || []).map((o) => String(o?.label ?? o?.text ?? o ?? '').trim().toLowerCase().replace(/\.$/, ''));
    const courtesy = opts.filter((o) => /^(mr|mrs|ms|miss|mx|dr|doctor|prof|rev|capt)$/.test(o)).length;
    if (/^\s*(title|salutation|prefix)\s*\*?\s*$/i.test(String(label || '')) && courtesy >= 3 && profile?.identity?.salutation) {
      const picked = pickOffered([profile.identity.salutation], field);
      if (picked) return { kind: 'answer', value: profile.identity.salutation, ...picked, review: false };
    }
    // …and a bare "Type" whose options are kinds of phone is the phone type
    // (iCIMS, Spirit AeroSystems 2026-10-02: "Type" — Home / Mobile, beside
    // "Number", required and left blank).
    const phoneKinds = opts.filter((o) => /^(mobile|cell|cellular|home|work|office|landline|fax|other)$/.test(o)).length;
    if (/^\s*(type|phone)\s*\*?\s*$/i.test(String(label || '')) && phoneKinds >= 2 && opts.some((o) => /^(mobile|cell)/.test(o)) && profile?.answers?.phone_type) {
      const picked = pickOffered([profile.answers.phone_type, 'Mobile', 'Cell'], field);
      if (picked) return { kind: 'answer', value: profile.answers.phone_type, ...picked, review: false };
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
  // NO RULE KNOWS IT, BUT HE HAS ANSWERED IT BEFORE (answer-log.mjs
  // pastAnswers, 2026-09-25): his own answer to the same question, at this
  // employer or consistently at several. Only where no rule spoke — a rule
  // that decided to leave a field for him (a conflict, a policy) is not
  // overridden — and always for his review.
  // …and where a rule DID answer but its answer fits none of the options:
  // Lexington Medical's GPA ranges are "3.9 or above | 3.6-3.8 | Below 3.6",
  // his 3.85 falls between them, and on that employer's form he chose
  // "3.6-3.8" himself (2026-09-25). Same employer only, for this case.
  if (r.kind === 'answer' && typeof r.value === 'string' && typeof profile?.pastAnswer === 'function') {
    const opts = (Array.isArray(field?.options) ? field.options : []).map((o) => o?.text ?? o);
    if (opts.length && chooseOption(r.value, opts) < 0) {
      const past = profile.pastAnswer(label, profile.applyingTo || '');
      if (past && !/employers$/.test(String(past.company)) && chooseOption(past.answer, opts) >= 0) {
        return { kind: 'answer', value: past.answer, review: true, rule: 'his-past-answer', past: `your own answer at ${past.company} (${String(past.at).slice(0, 10)})` };
      }
    }
  }
  // …and a PROMPT, whose options only the page sees (Lexington Medical's GPA
  // as a searchable list, 2026-09-25: "nothing matched 3.85"): his own answer
  // at this employer is tried after the rule's, same employer only.
  if (r.kind === 'answer' && typeof r.value === 'string' && String(field?.type || '').toLowerCase() === 'prompt'
    && !(Array.isArray(field?.options) && field.options.length) && typeof profile?.pastAnswer === 'function') {
    const past = profile.pastAnswer(label, profile.applyingTo || '');
    if (past && !/employers$/.test(String(past.company)) && String(past.answer).trim().toLowerCase() !== r.value.trim().toLowerCase()) {
      // ALTERNATIVES, not an array value: an array was stringified with its
      // comma and sent as one answer — HP's veteran prompt got "I am not a
      // Veteran.,I IDENTIFY AS A VETERAN, …" and the matcher picked the
      // protected-veteran row from the words (F-618).
      return { ...r, value: r.value, alternatives: [r.value, String(past.answer)], review: true, past: `your own answer at ${past.company} (${String(past.at).slice(0, 10)})` };
    }
  }
  if (r.kind === 'unknown' && !r.why && typeof profile?.pastAnswer === 'function') {
    const past = profile.pastAnswer(label, profile.applyingTo || '');
    if (past) {
      const opts = Array.isArray(field?.options) ? field.options : [];
      if (!opts.length || chooseOption(past.answer, opts.map((o) => o?.text ?? o)) >= 0) {
        return { kind: 'answer', value: past.answer, review: true, rule: 'his-past-answer', past: `your own answer at ${past.company} (${String(past.at).slice(0, 10)})` };
      }
    }
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
  // OPTIONS READ BARE (F-623 stress test): a non-breaking space inside
  // "More than 12 weeks" hid it from the start-date bands, and a bullet glyph
  // in front of "Never held a clearance" hid it from the clearance rule. Same
  // positions, so an index still names the page's own row.
  const bareOpt = (s) => String(s).replace(/[   ]/g, ' ').replace(/^\s*[○●•◦▪■□◯]\s*/, '').replace(/\s{2,}/g, ' ').trim();
  const options = (Array.isArray(field?.options) ? field.options : [])
    .map((o) => (o && typeof o === 'object' ? { ...o, text: bareOpt(o.text ?? '') } : bareOpt(o ?? '')));
  // eslint-disable-next-line no-param-reassign
  if (options.length) field = { ...field, options };
  // A QUESTION THAT IS ONLY ITS OPTIONS (2026-09-24). Workday's disability
  // self-identification asks "Please check one of the boxes below:" and the
  // word disability appears only in the boxes — so no rule knew it, and it was
  // left for him on all four Workday forms that night. The topic is read from
  // the options when the label does not name one.
  // A GROUP'S LABEL ENDS IN ITS FIRST OPTION ("Are you a citizen of the United
  // States? * — Yes", ReLogic's BambooHR form, 2026-09-26): the finder names a
  // radio group "question — option". The option is not part of the question,
  // and it made the citizenship rule miss and the on-site rule miss. Read
  // without it.
  const first = String(options[0]?.text ?? options[0] ?? '').trim();
  const rawLabel = String(field?.label || '').trim()
    // Only a bare Yes / No: an export-control list named "… — Cuba" is read by
    // the country rule through that name.
    .replace(new RegExp(`\\s+—\\s+${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), /^(yes|no|true|false|y|n)$/i.test(first) && /^(radio|checkbox)$/i.test(String(field?.type || '')) && options.length > 1 ? '' : '$&')
    .replace(/\s*[*✱]\s*$/, '');
  const optText = options.map((o) => String(o?.text ?? o)).join(' | ');
  // THE QUESTION WITHOUT ITS DECORATION (2026-09-27, F-623). Asking every
  // question in the log again with what real forms add — "* ", "3) ", "Question
  // 4: ", "(required)", a trailing colon, non-breaking spaces — changed the
  // answer for 150-odd of them: "* Why Relativity?" was no longer an essay,
  // "3) Are you a first generation college student?" got "Lakeside University".
  // The rules read the bare question; the action keeps the page's own label,
  // which is how the extension finds the field again.
  const bare = (s) => String(s)
    .replace(/[   ]/g, ' ')
    .replace(/^\s*(?:question|q)\s*\d{1,3}\s*[:.)\-]\s*/i, '')
    .replace(/^\s*\d{1,3}[a-z]?\s*[.)]\s*/i, '')
    .replace(/^[\s*✱＊]+/, '')
    .replace(/\s*\((?:required|optional|mandatory)\)\s*$/i, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s*[*✱]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || String(s).trim();
  const shownLabel = rawLabel;
  const frame = (rawLabel) => (!/disabilit|veteran/i.test(rawLabel) && /\b(have|had)\s+(had\s+)?a\s+disability\b|\bdo\s+not\s+have\s+a\s+disability\b/i.test(optText)
    ? `Disability — ${rawLabel}`
    : !/disabilit|veteran/i.test(rawLabel) && /\bprotected\s+veteran\b|\bnot\s+a\s+veteran\b/i.test(optText)
      ? `Veteran status — ${rawLabel}`
      // A RACE LIST LABELLED BY ITS FIRST OPTION (Penumbra's Lever form,
      // 2026-09-25): the group's label came through as "Hispanic or Latino —
      // A person of Cuban, Mexican…", so the Hispanic rule answered "No" to
      // a list of races. Two or more "(Not Hispanic or Latino)" options make
      // it the race question.
      : (optText.match(/\(not\s+hispanic\s+or\s+latino\)/gi) || []).length >= 2 && !/^\s*race\b/i.test(rawLabel)
        ? `Race — ${rawLabel}`
        // …and a race list whose label swallowed the Gender dropdown beside it
        // ("Race — GenderSelect ...MaleFemale… — Hispanic or Latino…",
        // Extreme Networks' Lever form, 2026-09-26): the gender rule matched
        // first and planned "Male" for a list of races. The options say what
        // it is.
        : (optText.match(/\(not\s+hispanic\s+or\s+latino\)/gi) || []).length >= 2 && /\bgender|\bsex\b/i.test(rawLabel)
          ? 'Race'
          : rawLabel);
  const label = frame(bare(rawLabel));
  // No `selector`. It was on here from an early version, written in this one
  // place and read in none — `discover()` has never produced one, so every
  // action carried `selector: undefined`. Left alone it is the kind of thing
  // that gets trusted later: a field that looks like a way to find an element
  // and silently is not. Fields are matched by identity (label + type + name),
  // which is what content.js actually does.
  const base = { label: frame(shownLabel), type, name: field?.name, id: field?.id };

  // A SELF-RATING LIST (Vast, 2026-09-25): "Please describe your experience
  // with CAD Software:" offering "CAD Software - Expert / - Intermediate /
  // - Beginner / - No experience". His own ratings, given directly, live in
  // `answers.skill_levels`; a skill he has not rated stays his.
  {
    const LEVEL = /\b(expert|advanced|proficient|intermediate|beginner|novice|basic|no\s+experience|none)\b/i;
    const opts = options.map((o) => String(o?.text ?? o));
    if (/^(radio|select|prompt)$/.test(type) && opts.filter((o) => LEVEL.test(o)).length >= 3 && profile?.answers?.skill_levels) {
      const SKILLS = {
        cad: /\bcad\b|solidworks|creo|autocad|\bnx\b|catia|inventor|fusion\s*360/i,
        gdt: /gd\s*&\s*t|\bgdt\b|geometric\s+dimension/i,
        ansys_fea: /ansys|\bfea\b|\bfem\b|finite\s+element/i,
        fluid_systems: /fluid|pressuri[sz]ed|hydraulic|pneumatic/i,
      };
      const text = `${label} ${opts[0] || ''}`;
      const hit = Object.entries(SKILLS).filter(([, re]) => re.test(text));
      const lvl = hit.length === 1 ? String(profile.answers.skill_levels[hit[0][0]] || '') : '';
      if (lvl) {
        const k = opts.findIndex((o) => new RegExp(`\\b${lvl}\\b`, 'i').test(o));
        if (k >= 0) return { ...base, action: type === 'prompt' ? 'prompt' : 'select', ...(type === 'prompt' ? { current: field.current || '', promptKind: field.promptKind || 'single' } : { optionIndex: k }), value: opts[k], review: true, why: `your own rating: ${lvl}` };
      }
    }
  }

  // A CLEARANCE LIST WITH A "NONE" IN IT (Astranis, 2026-09-26): "…let us
  // know if you currently hold one or would be open to obtaining one" over
  // Top Secret … Secret / Expired / Open to obtaining / Never held a
  // clearance. He holds none and, as a non-citizen, cannot obtain one — the
  // one true option is the "never held" one. Nothing else is ever ticked.
  if (/^(radio|select|checkbox)$/.test(type) && /\bclearance\b/i.test(label) && options.length >= 2) {
    const opts = options.map((o) => String(o?.text ?? o).trim());
    const k = opts.findIndex((o) => /^(never\s+held(\s+a)?(\s+(security\s+)?clearance)?|no(ne)?(\s+(active\s+)?(security\s+)?clearance)?|i\s+do\s+not\s+(hold|have)(\s+an?)?(\s+(active\s+)?(security\s+)?clearance)?|not\s+applicable)\.?$/i.test(o));
    if (k >= 0) return { ...base, action: 'select', optionIndex: k, value: opts[k], review: true, why: 'you have never held a clearance' };
  }

  // "WHICH LOCATION ARE YOU APPLYING FOR?" (TKDA, 2026-09-26: Duluth or
  // Bloomington, Minnesota). The posting names its own location — Duluth — so
  // the option that names it is the answer; when none or several do, it is his.
  // …and a list of ONE (Embraer, 2026-09-26: "Melbourne, FL" alone) when it
  // names the posting's city.
  if (/^(radio|select|prompt)$/.test(type) && options.length >= 1 && profile?.jobLocation
    && /\bwhich\s+(office\s+|work\s+)?location\b.*\bappl(y|ying)\b|\blocation\s+(are\s+)?you\s+(are\s+)?applying\s+(for|to)\b|\bapplying\s+(for|to)\s+which\s+location\b/i.test(label)) {
    const city = String(profile.jobLocation).split(/[,;|]/)[0].trim().toLowerCase();
    const opts = options.map((o) => String(o?.text ?? o).trim());
    const hits = city.length >= 3 ? opts.map((o, i) => [o, i]).filter(([o]) => o.toLowerCase().includes(city)) : [];
    if (hits.length === 1) {
      const [o, k] = hits[0];
      return type === 'prompt'
        ? { ...base, action: 'prompt', value: o, current: field.current || '', promptKind: field.promptKind || 'single', review: true, why: `the posting's own location (${profile.jobLocation})` }
        : { ...base, action: 'select', optionIndex: k, value: o, review: true, why: `the posting's own location (${profile.jobLocation})` };
    }
  }

  // LEVER'S "OTHER" LINK BOX, whatever the company typed as its label
  // (Capstan Medical named it "Capstan Medical, Inc.", 2026-09-26). His
  // LinkedIn and portfolio have their own boxes; another link is optional.
  if (/^urls\[other\]$/i.test(String(field?.name || '')) && !field?.required) {
    return { ...base, action: 'skip', why: 'another link — your LinkedIn and portfolio have their own boxes' };
  }

  // "WHAT IS YOUR LOCATION?" OVER A LIST OF COUNTRIES (Capstan Medical's
  // Lever form, 2026-09-26): no rule knew the wording, and the answer is the
  // country he lives in — never his citizenship, which the citizenship rules
  // own. Only a real country list (20+ names, the US among them).
  if (/^(radio|select)$/.test(type) && options.length >= 20
    // …"Country/Region of Residence", and "Education Country/Region" — his
    // school is in Springfield (2026-09-26).
    && /\b(your\s+)?(current\s+)?(location|(country|region)(\s*\/\s*(country|region))?\s+of\s+residence|education\s+(country|region)|country\s+of\s+(your\s+)?(school|university|education)|where\s+(are\s+you|do\s+you)\s+(currently\s+)?(located|based|live|reside))\b/i.test(label)
    && !/citizen|nationality|passport|birth|origin/i.test(label)) {
    const opts = options.map((o) => String(o?.text ?? o).trim());
    const k = opts.findIndex((o) => /^(united\s+states(\s+of\s+america)?|usa|us|u\.s\.a?\.?)$/i.test(o));
    const iAmUS = /united\s+states|^usa?$|^u\.s/i.test(String(profile?.identity?.country || ''));
    if (k >= 0 && iAmUS) return { ...base, action: 'select', optionIndex: k, value: opts[k], why: 'the country you live in' };
  }

  // IS HIS COUNTRY ON THE LIST THE FORM PRINTS (Atomic Semi, 2026-09-25)?
  // "If no, is your home country listed below?" with "Armenia, Azerbaijan, …,
  // Vietnam, Yemen" printed under it. Two facts decide it — his citizenship
  // (`answers.citizenship_country`) and the page's own list — so it is
  // answered, always for review; export control is a caution for him, never a
  // reason to hide it. A list that is not visibly a list of countries (fewer
  // than three comma-separated names) stays his.
  if (/^(radio|select|prompt)$/.test(type) && field?.near
    && /\b(home\s+country|country\s+of\s+(citizenship|nationality|origin)|your\s+country)\b/i.test(label)
    && /\b(listed|named|shown)\s+(below|above)|\bthe\s+following\s+countr/i.test(label)) {
    const mine = String(profile?.answers?.citizenship_country || '').trim();
    const printed = String(field.near).replace(label, ' ').replace(/\b(yes|no)\b/gi, ' ');
    const names = printed.split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter((s) => /^[A-Z][A-Za-z .'-]{2,40}$/.test(s));
    if (mine && names.length >= 3) {
      const spell = [mine, ...(/^viet\s*nam$/i.test(mine) ? ['Vietnam', 'Viet Nam'] : [])];
      const onIt = spell.some((c) => new RegExp(`(^|[^A-Za-z])${c.replace(/\s+/g, '\\s*')}([^A-Za-z]|$)`, 'i').test(printed));
      const want = onIt ? 'Yes' : 'No';
      const idx = type === 'prompt' ? -1 : chooseOption(want, options.map((o) => o?.text ?? o));
      if (type === 'prompt') return { ...base, action: 'prompt', value: want, current: field.current || '', promptKind: field.promptKind || 'single', review: true, why: `${mine} is ${onIt ? '' : 'not '}on the list the form prints` };
      if (idx >= 0) return { ...base, action: 'select', optionIndex: idx, value: options[idx]?.text ?? options[idx], intended: want, review: true, why: `${mine} is ${onIt ? '' : 'not '}on the list the form prints` };
    }
  }

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
  // A GRADUATE DEGREE HE DOES NOT HAVE (Eight Sleep, 2026-09-25). Its form
  // asks University / Major / GPA / Graduation Date twice, "(Undergraduate)"
  // and "(Graduate)", and the second set got his bachelor's major, GPA and
  // date — a claim to a graduate degree. His files hold one degree, a B.S.;
  // any field that names a graduate, master's or doctoral degree stays empty
  // unless the profile states one.
  if (/\(\s*(graduate|grad|masters?|ph\.?\s?d\.?|doctoral|doctorate)\s*(degree|school|studies)?\s*\)|^\s*(graduate|master'?s|ph\.?\s?d\.?|doctoral)\s+(school|university|institution|degree|major|field|gpa|program|graduation)/i.test(label)
    && !(Array.isArray(profile?.education_entries) && profile.education_entries.some((e) => /master|m\.?s\.?\b|ph\.?\s?d|doctor/i.test(String(e?.degree || ''))))) {
    return { ...base, action: 'skip', why: 'a graduate degree — you have one degree, a B.S., so this stays empty' };
  }
  // A BOARD'S OWN SEARCH BOX AND DEPARTMENT TREE (Aalo Atomics, 2026-09-25):
  // Rippling sends a removed posting to the company's job list, and its
  // "Search" box and "Tree" filter were reported as the application's two
  // questions. A label that is only one of these words is never a question.
  if (/^\s*(search|search\s+jobs|tree|filter|filters|sort|sort\s+by|keywords?)\s*$/i.test(label)) {
    return { ...base, action: 'skip', why: 'the job board\'s own search or filter, not a question on the form' };
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
  // "IF YES, please provide…" is the same shape (Western Digital, live
  // 2026-09-24: "If yes, please provide a list/details of the potential
  // conflict of interest:" went to the essay writer, which would have
  // described a conflict he does not have). The question above it is his.
  const ifYes = /^\s*if\s*["“']?\s*(yes|so|applicable|other)\s*["”']?\s*(to\s+the\s+(previous|above|prior)\s+question)?\s*[,:.;—–-]/i.test(label);
  // "If applicable, are you willing to relocate to the area where this position
  // is located?" (J&J, 2026-09-30) is a whole question with a hedge in front,
  // not a follow-up to one above: it went out blank on a required box. Only
  // "applicable" — "If yes, are you…" still hangs on the question before it.
  const hedgedQuestion = /^\s*if\s+applicable\s*[,:;—–-]\s*(are|do|will|would|can|could|have|is)\s+you\b[^?]*\?\s*\*?\s*$/i.test(label);
  if (ifYes && !hedgedQuestion) {
    return { ...base, action: 'unknown', optional: !field?.required, why: 'only applies if you answered yes above' };
  }
  // A RESIDENCY BOX: "If you are a California (CA) resident, or applying for a
  // position in CA, please check this box." (iCIMS, Werfen, 2026-09-24). Its
  // condition IS the question, and both halves are facts: where he lives, and
  // where the job is. Ticked when either is true — Werfen's job is in San
  // Luis — and left when neither is (the EU/UK version on Joby: never).
  // Ticking it is what reveals the privacy notice's "I accept".
  {
    const res = String(label).match(/^\s*if\s+you\s+are\s+an?\s+(.{2,60}?)\s+resident\b(?:[^.?]{0,20}?\bor\s+applying\s+(?:for|to)\s+an?\s+(?:position|job|role)\s+(?:based\s+)?in\s+(.{2,40}?))?\s*,\s*(?:please\s+)?(?:check|tick|select)\s+(?:this|the)\s+box/i);
    if (res && String(field?.type || '').toLowerCase() === 'checkbox') {
      // Place names only: "United" of United Kingdom must never match his
      // "United States", so the generic words go.
      const names = (s) => String(s || '').replace(/[()]/g, ' ').split(/\s+or\s+|\s*\/\s*|\s+/).map((w) => w.trim())
        .filter((w) => w.length >= 2 && !/^(united|union|states?|kingdom|european|republic|the|of|and|or|an?)$/i.test(w));
      const where = [...names(res[1]), ...names(res[2])];
      const inIt = (place) => { const p = String(place || ''); return where.some((w) => new RegExp(`(^|[\\s,(])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s,)])`, 'i').test(p)); };
      const lives = inIt(profile?.identity?.state) || inIt(profile?.identity?.location);
      const job = !!res[2] && inIt(profile?.jobLocation);
      return lives || job
        ? { ...base, action: 'check', value: 'checked', review: true, why: lives ? 'you live there' : `the job is there (${profile.jobLocation})` }
        : { ...base, action: 'skip', why: 'you do not live there' + (res[2] ? ', and the job is not there' : '') };
    }
  }
  // Any "If you…": Harbinger's "If you do not currently reside near the
  // location …, are you willing to relocate?" (2026-09-25) missed the verb
  // list and was read whole, which answered nothing.
  // …except a label that answers its own "no" ("If not, put N/A."), which is
  // a whole question.
  if (/^\s*if\s+(you|your)\b/i.test(label) && !/\bif\s+(not|no)\b|\botherwise\b/i.test(label) && !field?.conditionWeighed) {
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
    // A CONDITION ON HIS OWN PAY NUMBER can be checked (Hyve, 2026-09-27):
    // "If your total cash compensation expectation … is between $20k and
    // $100k, please select the applicable range below. If your expectation is
    // higher, please select Other". His target inside the range takes its
    // band; outside it, "Other". He chose "$90 - $100k" and "Other" (F-621).
    const payIf = String(label).match(/^\s*if\s+your\b[^.?]{0,40}\b(?:compensation|salary|pay)\b[^.?]{0,120}?\bbetween\s+\$?\s*(\d[\d,.]*)\s*(k)?\s*(?:and|-|to)\s+\$?\s*(\d[\d,.]*)\s*(k)?/i);
    if (payIf && (options.length || type === 'prompt')) {
      const num = (s, k) => Number(String(s).replace(/,/g, '')) * (k || Number(String(s).replace(/,/g, '')) < 1000 ? 1000 : 1);
      const lo = num(payIf[1], payIf[2] || payIf[4]);
      const hi = num(payIf[3], payIf[4]);
      const said = resolveLabel('What is your expected salary?', profile);
      const target = String(Array.isArray(said.value) ? said.value[0] : said.value ?? '');
      const want = said.kind === 'answer' ? Number(target.replace(/[^\d.]/g, '')) : NaN;
      if (Number.isFinite(want) && want > 0 && lo < hi) {
        const inside = want >= lo && want <= hi;
        const why = `your target, ${target}, ${inside ? 'is in this range' : `is outside $${lo / 1000}k–$${hi / 1000}k`}`;
        // A menu only the page sees: the target goes to the page's matcher,
        // which reads bands (chooseBand), or "Other".
        if (!options.length) return { ...base, action: 'prompt', value: inside ? target : 'Other', current: field.current || '', promptKind: field.promptKind || 'single', review: true, why };
        const idx = inside ? chooseBand(target, options) : options.findIndex((o) => /^\s*other\b/i.test(String(o?.text ?? o)));
        if (idx != null && idx >= 0) return { ...base, action: 'select', optionIndex: idx, value: String(options[idx]?.text ?? options[idx]), review: true, why };
      }
    }
    const body = String(label).match(/^\s*if\s+your?\b[^,]{0,80},\s*(.+)$/is)?.[1]?.trim()
      || (() => { const m = String(label).match(/^\s*if\s+your?\b[^,?]{0,80}?\s((?:what|when|which|how|do|does|are|will|would|can|please)\b[^,]*\?)\s*$/is); return m ? m[1].trim() : null; })();
    // No comma means no separable question — "If you selected yes above" is
    // the whole label. Nothing to resolve, and the skip stands.
    if (body && !/^\s*if\s+you\b/i.test(body)) {
      const inner = planField({ ...field, label: body }, profile);
      // Only a real answer earns the fall-through. Anything still unknown
      // keeps the clearer explanation below — and so does an ESSAY: writing
      // prose on the strength of a condition he may not meet ("If you have a
      // disability, please describe…") is inventing the condition.
      if (inner && inner.action !== 'unknown' && inner.action !== 'essay') {
        return { ...inner, label, why: `${inner.why || 'answered'} — only if the condition above applies to you`, review: true };
      }
    }
    // "If your portfolio is not available online, please attach it here"
    // (Formlabs, 2026-09-25): his is online, so the condition is false.
    if (type === 'file' && !field?.required && (profile?.identity?.portfolio || profile?.identity?.website)
      && /portfolio|work\s+samples?/i.test(label) && /\bnot\s+(available\s+)?online\b|\bno\s+(online|web)\b|\bnot\s+.{0,20}\b(link|url)\b/i.test(label)) {
      return { ...base, action: 'skip', why: 'optional — your portfolio is online, and its link goes in its own box' };
    }
    // A DELIBERATE BLANK READ OFF THE WHOLE LABEL (Archer, 2026-09-25): "If
    // you were referred, please provide the name of the employee." — he was
    // not referred, and the referrer rule says so; only a blank is taken this
    // way, never an answer matched off the condition.
    if (resolveLabel(label, profile).kind === 'blank') return { ...base, action: 'skip', why: 'deliberately left blank' };
    // A RULE WRITTEN FOR THE WHOLE CONDITIONAL SENTENCE answers it: its pattern
    // opens on the "if", so the condition was weighed when it was written —
    // Honda's "If you have an EAD under F-1 OPT, are you eligible for…?" (I do
    // not have OPT) and JPL's "If the position requires driving… select N/A"
    // (2026-10-02).
    if (/^(\\b|\^)?(\\s\*)?if\\s/.test(String(whichRule(label, profile) || ''))) {
      const whole = planField({ ...field, conditionWeighed: true }, profile);
      if (whole && whole.action !== 'unknown' && whole.action !== 'essay') return { ...whole, label, review: true };
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
    // "No Selection" (TSMC's SuccessFactors) is the empty entry too, not an
    // answer already given (2026-09-24: the second pass skipped it as one).
    const currentNow = /^(select one|select a value)$/i.test(shownNow) || PLACEHOLDER_OPTION_RE.test(shownNow) ? '' : shownNow;

    const decided = decide(field, label, profile);
    if (decided.kind === 'blank') return { ...base, action: 'skip', why: 'deliberately left blank' };
    // "AT LEAST 5 YEARS?" AS A DROPDOWN whose Yes / No only the page sees
    // (Pronto's Greenhouse form, 2026-09-26): the comparison, not the figure.
    if (decided.kind === 'answer' && !currentNow) {
      const need = String(label).match(/\b(?:at\s+least|minimum\s+(?:of\s+)?|more\s+than|over)\s+(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b|\b(\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)\b/i);
      const have = String(decided.value ?? '').match(/^\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)?\s*$/i);
      if (need && have && /^\s*(do|does|have|are|is)\b/i.test(label)) {
        const n = Number(need[1] ?? need[2]); const h = Number(have[1]);
        const ok = /\b(more\s+than|over)\b/i.test(need[0]) ? h > n : h >= n;
        return { ...base, action: 'prompt', value: ok ? 'Yes' : 'No', current: '', promptKind: field.promptKind || 'single', intended: decided.value, review: true, why: `you have ${decided.value}; it asks for ${need[0].trim()}` };
      }
    }
    if (decided.kind !== 'answer') {
      if (currentNow) return { ...base, action: 'skip', why: `already set to "${currentNow}"` };
      // A consent question rendered as a dropdown. His standing instruction is
      // yes to every consent and AI-screening question, and that rule only ever
      // reached CHECKBOXES — so "By selecting YES, I consent to receive
      // recruiting SMS messages…", a REQUIRED react-select on the live Astranis
      // form, blocked the application. Always review-flagged: he presses Submit
      // himself, and a consent answered on his behalf is one he still sees.
      if (CERT_RE.test(label) && !CERT_NOT_RE.test(label)) {
        // JPL's applicant statement offers "I accept. By making this selection,
        // you are applying your signature…" and no Yes (2026-10-02).
        return {
          ...base, action: 'prompt', value: 'Yes', values: ['Yes', 'I accept', 'I Accept', 'Accept', 'I agree', 'Agree'], current: '',
          promptKind: field.promptKind || 'single', review: true,
          why: 'consent — your standing answer is yes',
        };
      }
      return { ...base, action: 'unknown', why: decided.why || 'a dropdown we have no answer for' };
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
        // …or any of the rule's other spellings ("+1" for a country code box).
        || (Array.isArray(decided.alternatives) && decided.alternatives.some((v) => String(v).trim().toLowerCase() === current.toLowerCase() || chooseOption(String(v), [current]) >= 0))
        || (/^(yes|no)$/i.test(current) && polarityOf(String(decided.value)) === current.toLowerCase()));
    if (same) return { ...base, action: 'skip', why: `already set to "${current}"` };

    // A MULTI prompt takes one item at a time. Workday's "Type to Add Skills"
    // was handed the whole comma-separated skills list as a single search term,
    // which matches nothing and silently adds none of them — on the field that
    // is pure ATS keyword value and is almost always left empty.
    const kind = field.promptKind || 'single';
    // A rule's ALTERNATIVES are not a comma list to split: "San Jose, CA,
    // United States" split into "San Jose" and "CA" on Western Digital's
    // location menu (2026-09-24). Those go to the one-of branch below.
    const hasAlts = Array.isArray(decided.alternatives) && decided.alternatives.length > 1;
    if (kind === 'multi' && !hasAlts && String(decided.value).includes(',')) {
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
    if (Array.isArray(decided.alternatives) && decided.alternatives.length > 1) {
      // …and a MULTI widget answering ONE question (Workday's "How Did You Hear
      // About Us?") gets them too, marked `oneOf` so the page stops at the
      // first that lands instead of adding every one as another chip.
      return { ...base, action: 'prompt', values: decided.alternatives, value: decided.value, current: field.current || '', promptKind: kind, review: decided.review, ...(kind === 'multi' ? { oneOf: true } : {}) };
    }
    return { ...base, action: 'prompt', value: decided.value, current: field.current || '', promptKind: kind, review: decided.review };
  }

  if (type === 'file') {
    // A SLOT THAT SHOWS A FILE NAME HOLDS A FILE. Rippling keeps nothing in the
    // input's `files` after an upload; the slot's text simply becomes
    // "Alex Rivera - Cinta...pdf remove", so `attached` read 0 and the next pass
    // uploaded again and reported "the page did not keep the file" (2026-09-24).
    if (/[\w)\].-]\.(pdf|docx?|rtf|odt|txt)\b/i.test(label) && /\b(remove|delete|replace|change|clear)\b/i.test(label)) {
      return { ...base, action: 'skip', why: 'a file is already attached here' };
    }
    // Workable relabels a slot that holds a file "Replace file" (Slip Robotics,
    // 2026-09-25) — it was listed as a question left for him.
    if (/^\s*(replace|change|remove|delete)\s+(the\s+)?(file|resume|cv|document)\s*$/i.test(label)) {
      return { ...base, action: 'skip', why: 'a file is already attached here' };
    }
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
      // AN OPTIONAL PORTFOLIO FILE WHEN HIS PORTFOLIO IS ONLINE (Formlabs,
      // 2026-09-25): "If your portfolio is not available online, please attach
      // it here" was listed as left for him beside the link the form already
      // had. A required one still is.
      const site = profile?.identity?.portfolio || profile?.identity?.website;
      if (!field?.required && site && /portfolio|work\s+samples?/i.test(label)) {
        return { ...base, action: 'skip', why: 'optional — your portfolio is online, and its link goes in its own box' };
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
  // AN ARBITRATION AGREEMENT HE HAS TICKED HIMSELF, TWICE. CERT_NOT_RE keeps
  // "waive my right to sue" away from the consent rule, and that stays. But
  // Tesla's "I acknowledge and agree to be bound by Tesla's Arbitration
  // Agreement" and OpenAI's "…read, and understood the Arbitration Agreement"
  // were left for him on 2026-09-24 and he ticked both — it is a condition of
  // applying there, and his profile says yes (`arbitration_agreement`).
  // Review-flagged always; `arbitration_agreement: "No"` turns it off.
  if (type === 'checkbox' && /arbitrat/i.test(label) && /\bi\s+(?:[\w,]+[\s,]+){0,3}(acknowledge|agree|understand|accept)\b/i.test(label)
    && !/\b(citizen|sponsor|visa|pay|fee|unpaid)\b/i.test(label)
    && !/^\s*no\b/i.test(String(profile?.answers?.arbitration_agreement ?? 'Yes'))) {
    return { ...base, action: 'check', review: true, why: 'arbitration agreement — a condition of applying; your answer is yes' };
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

  // A LADDER OF DEGREES WHOSE LABEL IS ITS OWN FIRST RUNG. Penumbra's Lever
  // radio group arrived labelled "High school diploma or GED" — the question
  // text was lost and the first option stood in — so the school rule answered
  // "Lakeside University" (audit, 2026-09-26). When the label IS one of the
  // options and the options are education levels, the question is his level.
  if ((type === 'select' || type === 'radio') && options.length >= 3) {
    const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const ladder = options.filter((o) => /\b(high\s+school|ged|associate|bachelor|master|doctor|ph\.?\s?d)/i.test(String(o))).length >= 3;
    if (ladder && options.some((o) => n(o) === n(label))) {
      const level = String(profile?.education?.degree_level || profile?.education?.degree || '');
      for (const want of [level, profile?.education?.degree, "Bachelor's degree", "Bachelor's", 'Bachelors'].filter(Boolean)) {
        const idx = /bachelor/i.test(level) ? chooseOption(String(want), options) : -1;
        if (idx >= 0) return { ...base, action: 'select', optionIndex: idx, value: options[idx], intended: level, review: true, why: 'your degree level — the question text was missing, its first option stood in for it' };
      }
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
    // …and then he ticked it himself on Micron's form (2026-09-25, the answer
    // log's `final` row by him). His call, made: it is ticked. "Remember me"
    // on a sign-in screen is still his, and still left alone.
    // THE SITE'S SEARCH BOX IS NOT A QUESTION. Swisslog's posting page carries
    // its careers search, an <input type="search" name="q">, and the report
    // handed him "q" as a question left for him (stress round 19,
    // 2026-09-26). A search input, or a box named only "q" / "search".
    if (type === 'search' || /^\s*(q|query|search|keywords?|search\s+(jobs|careers|this\s+site|the\s+site))\s*$/i.test(label)) {
      return { ...base, action: 'skip', why: 'the site\'s search box — not part of the application' };
    }
    if (/save (my )?(answers|information|details|profile)/i.test(label) && type === 'checkbox') {
      return { ...base, action: 'check', value: 'checked', why: 'he ticks "save my answers" himself (Micron, 2026-09-25)' };
    }
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
    // The bare question, not the page's decoration (F-623): "* Why Relativity?"
    // is the same essay as "Why Relativity?".
    if (isWrittenQuestion({ ...field, label }, { company: applyingTo })) {
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
        // One line or many: the writer sizes the answer to the box (a one-line
        // "why us" gets two or three sentences).
        multiline: field?.multiline === true || String(field?.type || '').toLowerCase() === 'textarea',
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
    // "DO YOU HAVE AT LEAST 5 YEARS…?" OVER YES / NO (Pronto, 2026-09-26).
    // The experience rule answers with a figure ("2 years"), which no Yes/No
    // list holds — the answer is the comparison. His figure against the one
    // asked; review, like every experience answer.
    {
      const need = String(label).match(/\b(?:at\s+least|minimum\s+(?:of\s+)?|more\s+than|over)\s+(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b|\b(\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)\b/i);
      const have = String(decided.value ?? '').match(/^\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)?\s*$/i);
      const yn = options.map((o) => String(o?.text ?? o).trim());
      const yes = yn.findIndex((o) => /^yes\b/i.test(o)); const no = yn.findIndex((o) => /^no\b/i.test(o));
      if (need && have && yes >= 0 && no >= 0) {
        const n = Number(need[1] ?? need[2]); const h = Number(have[1]);
        const moreThan = /\b(more\s+than|over)\b/i.test(need[0]);
        const k = (moreThan ? h > n : h >= n) ? yes : no;
        return { ...base, action: 'select', optionIndex: k, value: yn[k], intended: decided.value, review: true, why: `you have ${decided.value}; it asks for ${need[0].trim()}` };
      }
    }
    let idx = chooseOption(decided.value, options);
    // A banded list ("3.7 - 4.0") never matches by text; try containment.
    let banded = false;
    if (idx == null || idx < 0) { idx = chooseBand(decided.value, options); banded = idx >= 0; }
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
      // A number placed in a band is his to look at: the gap rule can put 3.85
      // in "3.6-3.8", which the menu forces and his files do not say.
      intended: decided.value, review: decided.review || bucketedDate || banded,
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
    // HIS EARLIER ANSWER, REUSED, is what the box read when he sent it: the
    // log's "checked", or the box's own words — HP's second application was
    // handed "I am fluent in this language. | I am fluent in this language."
    // and left the box unticked (F-618).
    const own = [...distinct][0]?.replace(/\s*\*\s*$/, '');
    const saysTicked = /^\s*(yes|true|1|checked)\b/i.test(decided.value)
      || (distinct.size === 1 && !!own && String(decided.value).replace(/\s+/g, ' ').toLowerCase().includes(own));
    return saysTicked
      ? { ...base, action: 'check', why: label, review: decided.review }
      : { ...base, action: 'skip', why: `answer is "${decided.value}" — leaving it unticked` };
  }

  // A RIGHT ANSWER IN THE WRONG SHAPE IS A BLANK FIELD. Both engines go through
  // here, so neither can learn this separately.
  let fmt = formatForType(decided.value, type);
  // A TEXT BOX WHOSE PLACEHOLDER IS A DATE MASK takes a date in that shape.
  // BambooHR's "Date Available" is a text input reading "mm/dd/yyyy"
  // (Cornelis Networks, 2026-09-24); "June 2027 (graduating May 2027)" is not
  // a thing it can hold. Same first-of-the-month reading as a date input, and
  // flagged for the same reason.
  // A DATE PICKER'S "Pick date…" is the same thing (Atomic Semi's Ashby
  // "Ideal start date in office", 2026-09-25): measured live, it keeps
  // "06/01/2027" and cannot read "June 2027 (graduating May 2027)".
  const said = String(field?.placeholder || '').trim().toLowerCase();
  const mask = /^(pick|select|choose|enter)\s+(a\s+|the\s+)?date\b/.test(said) ? 'mm/dd/yyyy' : said.replace(/\s+/g, '');
  if (fmt.value && /^(mm|m)[/.-](dd|d)[/.-](yyyy|yy)$|^(mm|m)[/.-](yyyy|yy)$/.test(mask)) {
    const iso = formatForType(fmt.value, 'date');
    const m = iso.value && String(iso.value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const sep = mask.match(/[/.-]/)[0];
      const yy = /yyyy/.test(mask) ? m[1] : m[1].slice(2);
      fmt = { value: /(dd|d)/.test(mask) ? [m[2], m[3], yy].join(sep) : [m[2], yy].join(sep), review: true };
    }
  }
  if (fmt.value === null) return { ...base, action: 'unknown', why: fmt.why };
  // THE ANSWER MUST BE THE SHAPE THE BOX ASKS FOR (2026-10-03, "how do we make
  // this robust"). A bare Yes/No typed into a box that asks for WORDS — John
  // Deere's "…please explain your situation" got "No", AMAT's "tell us the
  // city, state and zip you'd be moving from" got "Yes" — is a rule that
  // matched a keyword and answered another question. Left as a leftover, so
  // the recogniser reads it as the question it is.
  // Never a question that is itself a yes/no ("Can you perform the essential
  // functions of the position for WHICH you are applying?") unless it also
  // asks for an explanation, and never an "If you…" box, where "No" says the
  // condition is not his (Spirit's "If you have previously worked at Boeing…,
  // please provide…" — he kept "No").
  const asksWords = /\b(explain|describe|detail|elaborate|tell\s+us|please\s+(list|specify|provide|enter|share|indicate|give)|which\s+(city|state|country|location|company|employer|school|program)|what\s+(city|state|country|location)|zip\s*code|postal\s*code|street\s+address|city\s*,\s*state)\b/i;
  const yesNoQuestion = /^\s*(are|can|could|do|does|did|have|has|had|is|will|would|were|was|may|shall)\b/i.test(label) && !/\b(explain|describe|detail|elaborate|tell\s+us)\b/i.test(label);
  if (/^\s*(yes|no)\s*\.?\s*$/i.test(String(fmt.value)) && asksWords.test(label) && !yesNoQuestion && !/^\s*if\b/i.test(label)
    && !/\b(yes\s*\/\s*no|yes\s+or\s+no|\(y\/n\)|type\s+(yes|no))\b/i.test(label)) {
    return { ...base, action: 'unknown', value: '', why: `a bare "${String(fmt.value).trim()}" for a question that asks for words` };
  }
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
  // AN ANSWER LONGER THAN ITS BOX. The page cuts it mid-word and the read-back
  // then calls the field unfilled — Rippling's salary box takes 50 characters
  // and his salary line is 54 (Cintal, 2026-09-24). The leading clause carries
  // the answer ("Open"), so that is what goes in, for him to review; with no
  // clause short enough the box is his, with the reason.
  // …except ONE PART OF A SPLIT DATE, which the post-pass in planForm cuts
  // down to its month, day or year. Refused here, Boom Supersonic's two-digit
  // month box turned "May 2027" into a question left for him (2026-09-25).
  if (field?.maxLength > 0 && fitted.length > field.maxLength && !field?.datePart) {
    const parts = fitted.split(/\s+[—–-]\s+|;\s+|,\s+|\.\s+/);
    const lead = parts[0]?.trim() || '';
    if (lead && lead.length <= field.maxLength && parts.length > 1) {
      return { ...base, action: 'fill', value: lead, review: true, why: `shortened to fit a ${field.maxLength}-character box — the full answer is "${fitted}"` };
    }
    return { ...base, action: 'unknown', value: '', why: `your answer is ${fitted.length} characters and this box takes ${field.maxLength}: "${fitted}"` };
  }
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
export const EXPECTED_EXTENSION = '1.106.0';

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
      // THE TOP RUNG, for every language he lists: his rule of 2026-09-06
      // for every proficiency question, which the rows' own field ignored.
      const entries = (Array.isArray(profile?.languages) ? profile.languages : []).filter((l) => l && (l.name || typeof l === 'string'))
        .map((l) => ({ ...(typeof l === 'string' ? { name: l } : l), proficiency: HIGHEST_PROFICIENCY[0], proficiencyAlts: HIGHEST_PROFICIENCY.slice(1) }));
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

export function planForm(fields, profile, { familyKey = null, titles = null, extensionVersion = null, sections = [], company = null, jd = '', location = null } = {}) {
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
  // …and WHERE the job is, for "Location Desired" (TSMC, 2026-09-24).
  // The store spells it "Phoenix, AZ, US, 85083"; a form wants "Phoenix, AZ".
  const place = String(location || '').split(/\s*[|;]\s*/)[0]
    .replace(/,\s*\d{5}(-\d{4})?\s*$/, '').replace(/,\s*(US|USA|United States( of America)?)\s*$/i, '').trim();
  if (place) effective = { ...effective, jobLocation: place };
  let titleChanges = [];
  // The titles the BUILT resume presents win over the family's defaults: the
  // per-posting plan may have chosen "Robotics Engineer Intern" where the
  // family says "Automation Engineer Intern", and the form must say what the
  // attached PDF says (Alex, 2026-09-03).
  //
  // FROM `effective`, NOT `profile` (2026-09-24). Rebuilding from the bare
  // profile threw away `applyingTo` and `jobLocation` on every application
  // with a built resume — which is every real one — so "have you worked at
  // <company>?" lost its company and Western Digital's location menu its city.
  if (titles && (Array.isArray(titles) ? titles.length : Object.keys(titles).length)) {
    const out = applyTitles(effective, new Map(Array.isArray(titles) ? titles : Object.entries(titles)));
    effective = out.profile;
    titleChanges = out.changed;
  } else if (familyKey) {
    const out = applyFamilyTitles(effective, familyKey);
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
  // His start is answered from `education_entries[].first_year` when that row
  // has one, and left empty when it does not — never his availability.
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
  // SmartRecruiters' experience block (Western Digital, 2026-09-24) labels its
  // dates a bare "From" and "To", has a "Description" box and an "I currently
  // work here" tick — all four were typed by him, row by row, while every
  // answer sat in `work_experience`. Bare From/To take MM/YYYY, which is what
  // he typed and what that date box accepts.
  const EMPLOYMENT_FIELDS = [
    ['company', /^(company|employer)(\s*name)?$/i],
    // SuccessFactors (Celestica, 2026-09-27) calls the title "Position" and
    // puts the city and country of each employer in their own boxes (F-623).
    ['title', /^((job|position)\s*)?title$|^position(\s*(held|name))?$/i],
    ['city', /^(company|employer|work)\s*city$/i],
    ['country', /^(company|employer|work)\s*country$/i],
    ['employerType', /^employer\s*type$/i],
    // Greenhouse splits each date in two — "Start date month" (a menu) and
    // "Start date year" (a box). Unrecognised, both went to the availability
    // rule and the year box got "June 2027 (graduating May 2027)" (Lyft,
    // 2026-09-24).
    ['startMonth', /^start(ing)?\s*date\s*month$/i],
    ['startYear', /^start(ing)?\s*date\s*year$/i],
    ['endMonth', /^end(ing)?\s*date\s*month$/i],
    ['endYear', /^end(ing)?\s*date\s*year$/i],
    ['start', /^(from|start(ing)?)(\s*date)?$/i],
    ['end', /^(to|end(ing)?)(\s*date)?$/i],
    ['location', /^(work|office|job)\s*location\s*\(?\s*(city)?\s*\)?$/i],
    ['reason', /^reason\s*for\s*leaving$/i],
    ['description', /^((job|role|position)\s+)?description$|^(responsibilities|duties|job\s+duties)$/i],
    // A tick box whose name picked up the box above it ("End date year* —
    // Current role", Greenhouse) is still the current-role box.
    ['current', /^i\s+(currently|still)\s+work\s+here$|^(this\s+is\s+my\s+)?current\s+(job|position|role|employer)$|^end(ing)?\s*date[^—]{0,12}—\s*current\s+(job|position|role)$/i],
  ];
  const employmentPart = (f) => {
    const bare = tidyLabel(String(f?.label || ''));
    if (!bare) return null;
    // HONDA'S "EMPLOYER" IS A CURRENT / PRIOR LIST (Phenom, 2026-10-02). Read
    // as a company box it opened a second row inside the first job, so the
    // title, dates and the list itself went to the wrong jobs — and "Acme Steel
    // Steel Stud Company" was typed into a menu of Current and Prior.
    const opts = (Array.isArray(f?.options) ? f.options : []).map((o) => String(o?.text ?? o).trim());
    if (/^(current\s+|present\s+)?employer(\s*(type|status))?$/i.test(bare)
      && opts.some((o) => /^current$/i.test(o)) && opts.some((o) => /^(prior|previous|former|past)$/i.test(o))) return 'employerType';
    if (/^(type\s+of\s+business|industry|business\s+type)$/i.test(bare)) return 'business';
    for (const [part, re] of EMPLOYMENT_FIELDS) if (re.test(bare)) return part;
    return null;
  };
  // What each employer does, in the words industry menus use. His three, from
  // cv.md: a semiconductor equipment maker, a steel framing manufacturer, and
  // the university's machine shop.
  const businessOf = (job) => {
    const co = String(job?.company || '');
    if (/university|college|school/i.test(co)) return ['Educational Services', 'Education', 'Higher Education'];
    if (/applied\s+materials|semiconductor|steel|stud|manufactur|robot/i.test(co)) return ['Manufacturing', 'Industrial Manufacturing'];
    return [];
  };
  const jobs = workEntries(effective);
  const employmentRow = new Map();      // field index -> job index
  const spareJobFields = [];            // boxes of a job row with no job left for it
  {
    const parts = list.map((f) => employmentPart(f));
    // The company field is what proves this is an employment block at all.
    // Without one, "Title" is a salutation, a publication or a degree name and
    // "End Date" is any of a dozen things.
    // ROWS, NOT OCCURRENCES (2026-09-24). A row starts at a Company or Title
    // box that the current row already has, and ends at an education box —
    // SmartRecruiters' education block uses the same bare "From"/"To", and
    // counting occurrences put his graduation into a job's dates. Each row is
    // then matched to the job it ALREADY NAMES (its Company or Title holds a
    // value: he typed it, or the page parsed the resume); only a row naming
    // nothing takes the next job not yet on the page. Western Digital's list
    // was in HIS order — Mars Rover, Makerspace, Acme Steel, Applied Materials — and
    // by position every row got a different job's description and dates.
    if (jobs.length && parts.includes('company')) {
      const EDU = /^(institution|school(\s*name)?|university|college|degree|major|field\s*of\s*study|discipline|school\s*location|i\s+currently\s+attend)$/i;
      const rows = [];
      let cur = null;
      list.forEach((f, i) => {
        const part = parts[i];
        if (EDU.test(tidyLabel(String(f?.label || '')))) { cur = null; return; }
        if (!part) return;
        // SuccessFactors puts "Employer Type" ABOVE "Company Name" (Celestica,
        // 2026-09-27), so it opens a row too (F-623).
        if (part === 'company' || part === 'title' || part === 'employerType') {
          if (!cur || cur.fields.some((x) => x.part === part)) { cur = { fields: [] }; rows.push(cur); }
        }
        if (cur) cur.fields.push({ i, part });
      });
      const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const holds = (row, part) => key(list[row.fields.find((x) => x.part === part)?.i]?.current);
      const used = new Set();
      const named = rows.map((row) => {
        const co = holds(row, 'company');
        const ti = holds(row, 'title');
        if (!co && !ti) return null;
        const byCo = co ? jobs.findIndex((j) => { const k = key(j.company); return k && (k === co || k.startsWith(co) || co.startsWith(k)); }) : -1;
        const hit = byCo >= 0 ? byCo : (ti ? jobs.findIndex((j) => key(j.title) === ti) : -1);
        if (hit >= 0) used.add(hit);
        return hit >= 0 ? hit : -1;        // -1: names something that is not his, leave it alone
      });
      rows.forEach((row, r) => {
        let job = named[r];
        if (job === null) {                  // an empty row takes the next job not already on the page
          job = jobs.findIndex((_, j) => !used.has(j));
          if (job >= 0) used.add(job);
          // …and one with no job left for it stays empty: Apple's fifth row got
          // his availability month as a Start Date (2026-10-16).
          else for (const { i } of row.fields) if (!String(list[i]?.current ?? '').trim()) spareJobFields.push(i);
        }
        if (job == null || job < 0) return;
        for (const { i, part } of row.fields) employmentRow.set(i, { row: job, part });
      });
    }
  }
  // …AND THE EDUCATION ROW'S OWN DATES. After an Institution/School box, a
  // bare "From" / "To" / "I currently attend" belongs to his degree:
  // education_entries holds "Aug 2023" and "May 2027", which he typed as
  // 08/2023 and 05/2027 on Western Digital (2026-09-24). A box already
  // holding something is left alone, like every other.
  const eduDate = new Map();            // field index -> value ('check' for the tick)
  {
    const edu = educationEntries(effective)[0];
    const monthNo = (m) => (Number(m) >= 1 && Number(m) <= 12 ? String(Number(m)).padStart(2, '0') : '');
    let inEdu = false;
    if (edu) {
      list.forEach((f, i) => {
        const bare = tidyLabel(String(f?.label || ''));
        // Honda's is "School/College/University" (2026-10-02).
        if (/^(institution|school(\s*name)?|university|college|school\s*\/\s*college(\s*\/\s*university)?)$/i.test(bare)) { inEdu = true; return; }
        if (/^(company|employer)(\s*name)?$|^((job|position)\s*)?title$/i.test(bare)) { inEdu = false; return; }
        if (!inEdu || String(f?.current ?? '').trim()) return;
        // Greenhouse's indexed ids (start-month--1) are matched to their own
        // education row by graduationHalf/educationStart; never here.
        if (/^(start|end)-(month|year)--\d+$/.test(String(f?.id || ''))) return;
        // "Start date" / "End date" too: Breezy's parsed education row labels
        // them so, and the start went to the availability rule ("June 2027").
        // …and Honda's "Education From Date" / "Education End Date", calendar
        // pickers that take MM/DD/YYYY (2026-10-02).
        const picker = f?.picker === 'mdy';
        if (/^(education\s+)?(from|start(ing)?)(\s*date)?$/i.test(bare) && edu.firstYear && edu.firstMonth) eduDate.set(i, picker ? pickerDate({ month: edu.firstMonth, year: edu.firstYear }) : `${monthNo(edu.firstMonth)}/${edu.firstYear}`);
        else if (/^(education\s+)?(to|end(ing)?)(\s*date)?$|^graduation\s*date$/i.test(bare) && edu.lastYear && edu.lastMonth) eduDate.set(i, picker ? pickerDate({ month: edu.lastMonth, year: edu.lastYear }, true) : `${monthNo(edu.lastMonth)}/${edu.lastYear}`);
        else if ((/^i\s+(currently\s+attend|am\s+currently\s+(enrolled|attending))/i.test(bare) || /\bstill\s+(a\s+)?student\??\s*$/i.test(bare)) && Number(edu.lastYear) >= new Date().getFullYear()) eduDate.set(i, 'check');
        // Greenhouse's split education dates: a month menu and a year box each
        // (Lyft, 2026-09-24 — they got his availability, "June 2027").
        else if (/^start(ing)?\s*date\s*month$/i.test(bare) && Number(edu.firstMonth) >= 1) eduDate.set(i, MONTH_FULL[Number(edu.firstMonth) - 1]);
        else if (/^start(ing)?\s*date\s*year$/i.test(bare) && edu.firstYear) eduDate.set(i, String(edu.firstYear));
        else if (/^end(ing)?\s*date\s*month$/i.test(bare) && Number(edu.lastMonth) >= 1) eduDate.set(i, MONTH_FULL[Number(edu.lastMonth) - 1]);
        else if (/^end(ing)?\s*date\s*year$/i.test(bare) && edu.lastYear) eduDate.set(i, String(edu.lastYear));
      });
    }
  }
  // A SECTION THAT ALREADY SHOWS AN ENTRY IS NOT EMPTY (F-562). SmartRecruiters'
  // experience section was reported with `count: 0` while it held entries, so
  // every pass pressed Add and entered his whole history again — nine entries
  // on Western Digital, which is the "refilling when I go back a page" he saw.
  // The page's own boxes are the evidence: a Title or Company box in the list
  // is an entry. Only the generic (non-Workday) sections; Workday counts its
  // panels itself.
  const hasWorkEntry = list.some((f) => /^(company|employer)(\s*name)?$|^((job|position)\s*)?title$/i.test(tidyLabel(String(f?.label || ''))) && String(f?.type || '').toLowerCase() !== 'file');
  const hasEduEntry = list.some((f) => /^(institution|school(\s*name)?|university)$/i.test(tidyLabel(String(f?.label || ''))));
  sections = (Array.isArray(sections) ? sections : []).map((s) => (s?.generic && !s.filled
    && ((s.kind === 'work' && hasWorkEntry) || (s.kind === 'education' && hasEduEntry))
    ? { ...s, filled: true, why: 'the page already shows an entry' } : s));
  const employmentValue = (i) => {
    const hit = employmentRow.get(i);
    if (!hit) return null;
    const job = jobs[hit.row];
    if (!job) return null;
    // A box that already holds something is his (or the page's) — never typed over.
    if (String(list[i]?.current ?? '').trim()) return null;
    const bareDate = /^(from|to)$/i.test(tidyLabel(String(list[i]?.label || '')));
    const mmYYYY = (d) => (d?.month && d?.year ? `${String(d.month).padStart(2, '0')}/${d.year}` : '');
    if (bareDate && (hit.part === 'start' || hit.part === 'end')) {
      const v = hit.part === 'start' ? mmYYYY(job.start) : (job.current ? '' : mmYYYY(job.end));
      return v ? { value: v, part: hit.part, row: hit.row } : null;
    }
    if (hit.part === 'current') return job.current ? { value: 'Yes', part: hit.part, row: hit.row } : null;
    if (/^(start|end)(Month|Year)$/.test(hit.part)) {
      const d = hit.part.startsWith('start') ? job.start : (job.current ? null : job.end);
      const m = Number(d?.month);
      const v = /Month$/.test(hit.part) ? (m >= 1 && m <= 12 ? MONTH_FULL[m - 1] : '') : String(d?.year || '');
      return v ? { value: v, part: hit.part, row: hit.row } : null;
    }
    // No semicolons: SmartRecruiters refuses a description holding one ("This
    // field cannot contain following characters: ;", F-356), and the refusal
    // kept Western Digital on step one (2026-09-24). A comma reads the same.
    const v = hit.part === 'description' ? String(job.description || '').replace(/\s*;\s*/g, ', ')
      : hit.part === 'company' ? job.company
      : hit.part === 'title' ? job.title
      : hit.part === 'city' ? String(job.location || '').split(',')[0]
      // Every employer of his is in the United States.
      : hit.part === 'country' ? (job.location ? 'United States' : '')
      : hit.part === 'employerType' ? (job.current ? 'Current' : 'Previous')
      : hit.part === 'business' ? (businessOf(job)[0] || '')
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

  // A CERTIFICATION ROW WHOSE BOXES ARE CALLED "Name" AND "Institution".
  //
  // TSMC, live 2026-09-24: `* Name`, `Description`, `Institution`, `Effective
  // Date`, `Expiration Date` in a row, no section on any of them. The dates
  // were left blank by the certification rule; `Name` was typed **"Anna Maria Alex
  // Ha"** and `Institution` **"Lakeside University"** — his name as a
  // certificate, his school as its issuer. The dates are what say whose row
  // this is, so a generic box within three places of one belongs to it, and
  // stays blank with the rest (his decision 2026-09-20: no certifications).
  const CERT_DATE_RE = /^(effective|expiration|expiry|issue|issued)\s*date$|^date\s*(acquired|issued|obtained)$/i;
  const CERT_PART_RE = /^(name|description|institution|issuer|issuing\s*(body|organi[sz]ation|authority)|number|licen[cs]e\s*number)$/i;
  const certDates = list.map((f, i) => (CERT_DATE_RE.test(tidyLabel(String(f?.label || ''))) ? i : -1)).filter((i) => i >= 0);
  const certRow = (i) => CERT_PART_RE.test(tidyLabel(String(list[i]?.label || '')))
    && certDates.some((d) => d > i && d - i <= 3);

  // "DATE LAST USED" UNDER A SKILL (TSMC, required). Every skill that goes in
  // comes from cv.md, and he uses them now, so the answer is today.
  const lastUsedOf = (i) => /^date\s*last\s*used$/i.test(tidyLabel(String(list[i]?.label || '')))
    && skillRows.some((r) => r < i && i - r <= 4 && skillFor.has(r));

  // A JOB HE STILL HOLDS HAS NO END DATE — that is an answer, not a gap. The
  // Makerspace row's End Date was reported as a question nobody could answer.
  const currentEnd = (i) => {
    const hit = employmentRow.get(i);
    return !!(hit && hit.part === 'end' && jobs[hit.row]?.current);
  };
  // "I currently work here" as a CHECKBOX: ticked for a job he holds, left
  // alone for one that ended — both are answers.
  const currentBox = (i) => {
    const hit = employmentRow.get(i);
    return !!(hit && hit.part === 'current' && String(list[i]?.type || '').toLowerCase() === 'checkbox');
  };

  // ONE ENTRY PER ROW, NOT ONE ANSWER PER BOX (2026-10-16). Apple's form reads
  // the resume into its own profile and leaves a second, empty education row
  // and a second Language row; every box was answered by its label alone, so
  // Lakeside went in twice and English twice — "a lot of duplication". Rows are
  // matched the way employment rows are: a row that already names one of his
  // entries uses it up, an empty row takes the next one not on the page, and
  // a row with nothing left for it stays empty.
  const entryOverride = new Map();     // field index -> { value } | { skip }
  for (const i of spareJobFields) entryOverride.set(i, { skip: true, why: 'an extra job row — every job you have is already on the page' });
  {
    const rowKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const groups = [
      { kind: 'education', anchor: /^(institution|school(\s*name)?|university|college|school\s*\/\s*college(\s*\/\s*university)?)$/i,
        member: /^(institution|school(\s*name)?|university|college|degree|major|field\s*of\s*study|discipline|graduated(\s*\/\s*completed)?|gpa|(start|end|from|to|graduation)(\s*date)?|year|month)$/i,
        names: educationEntries(effective).map((e) => e.school) },
      { kind: 'language', anchor: /^language$/i, member: /^(language|proficiency|\(optional\)|use as preferred language\??)$/i,
        names: (Array.isArray(effective?.languages) ? effective.languages : []).map((l) => l?.name).filter(Boolean) },
    ];
    for (const g of groups) {
      const rows = [];
      let cur = null;
      list.forEach((f, i) => {
        const bare = tidyLabel(String(f?.label || ''));
        if (g.anchor.test(bare)) { cur = { anchor: i, fields: [i] }; rows.push(cur); return; }
        if (cur && g.member.test(bare)) cur.fields.push(i);
        else if (cur && bare) cur = null;
      });
      // A single row is the ordinary form; the per-label rules already serve it.
      if (rows.length < 2 || !g.names.length) continue;
      const used = new Set();
      const named = rows.map((r) => {
        const held = rowKey(list[r.anchor]?.current);
        if (!held) return null;
        const k = g.names.findIndex((n) => { const m = rowKey(n); return m && (m === held || m.startsWith(held) || held.startsWith(m)); });
        if (k >= 0) used.add(k);
        return k;
      });
      rows.forEach((r, n) => {
        if (named[n] !== null) return;               // names something already: left as it is
        const k = g.names.findIndex((_, j) => !used.has(j));
        if (k >= 0) {
          used.add(k);
          // A language row is named outright; the first education entry is
          // what the per-label rules already give.
          if (g.kind === 'language') entryOverride.set(r.anchor, { value: g.names[k], why: `language ${k + 1} in your profile` });
          return;
        }
        for (const i of r.fields) {
          if (String(list[i]?.current ?? '').trim()) continue;
          entryOverride.set(i, { skip: true, why: `an extra ${g.kind} row — every ${g.kind} you have is already on the page` });
        }
      });
    }
  }

  const actions = (Array.isArray(fields) ? fields : []).map((f, i) => {
    if (entryOverride.has(i)) {
      const o = entryOverride.get(i);
      const base = { ...planField({ ...f, label: '' }, effective), label: f.label || '' };
      if (o.skip) return { ...base, action: 'skip', value: '', why: o.why };
      if (/^(select|radio)$/i.test(String(f?.type || '')) && Array.isArray(f?.options)) {
        const k = chooseOption(o.value, f.options);
        return k >= 0 ? { ...base, action: 'select', optionIndex: k, value: String(f.options[k]?.text ?? f.options[k]), review: true, why: o.why }
          : { ...base, action: 'unknown', value: '', why: `${o.why}: no "${o.value}" in its list` };
      }
      return { ...base, ...(String(f?.type || '').toLowerCase() === 'prompt'
        ? { action: 'prompt', promptKind: f.promptKind || 'single', current: f.current || '' } : { action: 'fill' }),
        value: o.value, review: true, why: o.why };
    }
    const half = graduationHalf(f);
    const job = employmentValue(i);
    const skill = skillFor.get(i);
    const planned = eduDate.has(i)
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '',
          ...(eduDate.get(i) === 'check' ? { action: 'check' }
            // A month MENU is picked, not typed (Greenhouse's education dates).
            : String(f?.type || '').toLowerCase() === 'prompt'
              ? { action: 'prompt', promptKind: f.promptKind || 'single', current: f.current || '', value: eduDate.get(i) }
              // A month or year <select> is chosen, never typed (Ashby's
              // education history, 2026-09-25).
              : /^(select|radio)$/i.test(String(f?.type || '')) && Array.isArray(f?.options)
                ? (() => { const k = chooseOption(eduDate.get(i), f.options); return k >= 0 ? { action: 'select', optionIndex: k, value: f.options[k] } : { action: 'unknown', value: '', why: `no "${eduDate.get(i)}" in its list` }; })()
              : { action: 'fill', value: String(f?.type || '').toLowerCase() === 'date' ? (formatForType(eduDate.get(i), 'date').value || eduDate.get(i)) : eduDate.get(i) }),
          review: true, why: 'your degree at ' + (educationEntries(effective)[0]?.school || 'school') }
      : certRow(i)
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '', action: 'skip',
          why: 'he does not list certifications on applications — the Skills table is filled instead' }
      : lastUsedOf(i)
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '', action: 'fill',
          value: new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
          review: true, why: 'a skill from cv.md that you use now' }
      : currentEnd(i)
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '', action: 'skip',
          why: `you still hold this job (${jobs[employmentRow.get(i).row].company}), so it has no end date` }
      : currentBox(i)
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '',
          ...(jobs[employmentRow.get(i).row]?.current
            ? { action: 'check', review: true }
            : { action: 'skip' }),
          why: `job ${employmentRow.get(i).row + 1} in your history — ${jobs[employmentRow.get(i).row].company}${jobs[employmentRow.get(i).row]?.current ? ', which you still hold' : ', which has ended'}` }
      : job && /^(select|radio)$/i.test(String(f?.type || '')) && Array.isArray(f?.options) && f.options.length
      ? (() => {
        // A LIST IN A JOB ENTRY IS PICKED FROM, never typed into (Honda's
        // Current / Prior, Type of Business and Country, 2026-10-02).
        const held = jobs[job.row];
        const cands = job.part === 'employerType' ? (held?.current ? ['Current', 'Present'] : ['Prior', 'Previous', 'Former', 'Past'])
          : job.part === 'business' ? businessOf(held)
            : job.part === 'country' ? ['United States', 'United States of America', 'USA']
              : [job.value];
        const b = { ...planField({ ...f, label: '' }, effective), label: f.label || '' };
        const why = `job ${job.row + 1} in your history — ${held?.company || held?.title}`;
        for (const c of cands) {
          const k = chooseOption(String(c), f.options);
          if (k >= 0) return { ...b, action: 'select', optionIndex: k, value: String(f.options[k]?.text ?? f.options[k]), review: true, why };
        }
        return { ...b, action: 'unknown', why: `${why}: none of ${cands.join(' / ')} is on its list` };
      })()
      : job
      ? { ...planField({ ...f, label: '' }, effective), label: f.label || '',
          // A search box (SmartRecruiters' Title and Company) is typed AND
          // picked, which is the prompt path; typed alone it did not stick.
          ...(String(f?.type || '').toLowerCase() === 'prompt'
            ? { action: 'prompt', promptKind: f.promptKind || 'single', current: f.current || '' }
            : { action: 'fill' }),
          // A <input type="date"> takes 2026-05-01, never "May 2026" (Breezy's
          // parsed work history, 2026-09-24: "the page did not keep the value").
          value: String(f?.type || '').toLowerCase() === 'date'
            ? (formatForType(job.value, 'date').value || job.value)
            // A calendar picker's box takes MM/DD/YYYY (Honda): the first of
            // the month he started, the last of the month he left.
            : f?.picker === 'mdy' && (job.part === 'start' || job.part === 'end')
              ? (pickerDate(job.part === 'start' ? jobs[job.row]?.start : jobs[job.row]?.end, job.part === 'end') || job.value)
              : fitToLength(job.value, f?.maxLength),
          review: true,
          why: `job ${job.row + 1} in your history — ${jobs[job.row].company || jobs[job.row].title}` }
      : skill
        ? { ...planField({ ...f, label: '' }, effective), label: f.label || '',
            action: 'fill', value: skill, review: true,
            why: jd ? 'one of your skills this posting asks for' : 'from your skills in cv.md' }
        : educationStart(f)
        ? (() => {
          // HIS START IS IN THE PROFILE WHEN HE HAS GIVEN IT (ASM, 2026-09-25):
          // `education_entries[].first_year` "Aug 2023", his own word, while
          // this row still said it was not there. Only a row without one is
          // left empty — never his availability, never a guess.
          const m = /^start-(month|year)--(\d+)$/.exec(String(f?.id || ''));
          const edu = educationEntries(effective)[Number(m[2]) || 0];
          const v = m[1] === 'year' ? (edu?.firstYear ? String(edu.firstYear) : '')
            : (Number(edu?.firstMonth) >= 1 ? MONTH_FULL[Number(edu.firstMonth) - 1] : '');
          const base = { ...planField({ ...f, label: '' }, effective), label: f.label || '' };
          if (!v) return { ...base, action: 'unknown', why: 'when you started studying is not in your profile' };
          return String(f?.type || '').toLowerCase() === 'prompt'
            ? { ...base, action: 'prompt', promptKind: f.promptKind || 'single', current: f.current || '', value: v, review: true, why: `your degree at ${edu.school || 'school'}` }
            : { ...base, action: 'fill', value: v, review: true, why: `your degree at ${edu.school || 'school'}` };
        })()
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
  // WHICH "FIRST NAME" IS WHICH, BY PAGE ORDER (F-621). Eightfold names no
  // field: Micron's form reads "First name" (contact), "First Name" (legal),
  // "I have a preferred name", "First Name" (preferred) — and all three were
  // planned "Anna Maria Alex". He changed the contact and the preferred ones to
  // "Alex" both times he applied (2026-09-25, 2026-09-27). After the preferred-
  // name box, a first name is the preferred one; before it, every first name
  // but the last (the legal one, just above the box) is the name he goes by.
  // Workday's keyed fields already tell these apart and are left alone.
  {
    const goesBy = String(profile?.identity?.preferred_full_name || '').trim().split(/\s+/)[0];
    const legal = String(profile?.identity?.first_name || '').trim();
    const pref = list.findIndex((f) => /\bi\s+(have|use)\s+a\s+preferred\s+name\b/i.test(String(f?.label || '')));
    const isFirst = (a) => a.action === 'fill' && !a.key && /^\s*first\s*name\s*\*?\s*$/i.test(String(list[a.at]?.label || a.label || ''));
    if (goesBy && legal && goesBy !== legal && pref >= 0) {
      const firsts = actions.filter(isFirst);
      const before = firsts.filter((a) => a.at < pref);
      for (const a of firsts.filter((x) => x.at > pref).slice(0, 1)) Object.assign(a, { value: goesBy, why: 'the preferred name — the one you go by' });
      for (const a of before.slice(0, -1)) Object.assign(a, { value: goesBy, why: 'the contact name above the legal-name section — the one you go by', review: true });
    }
    // THE CONTACT BOX ALONE (F-631). Micron rebuilds its form after reading
    // the resume, and the second pass met "Email, First name, Last name" with
    // the legal and preferred blocks not yet back — so the box he corrected to
    // "Alex" twice before went out "Anna Maria Alex" again (2026-10-01). Eightfold's
    // contact block is the one that asks Email FIRST; a first name right after
    // an email box is the contact name, the one he goes by.
    if (goesBy && legal && goesBy !== legal && pref < 0) {
      for (const a of actions.filter(isFirst)) {
        const prev = list[a.at - 1];
        const next = list[a.at + 1];
        const isEmail = prev && (String(prev.type || '').toLowerCase() === 'email' || /^\s*e-?mail(\s+address)?\s*\*?\s*$/i.test(String(prev.label || '')));
        const isLast = next && /^\s*last\s*name\s*\*?\s*$/i.test(String(next.label || ''));
        if (isEmail && isLast) Object.assign(a, { value: goesBy, why: 'the contact name — Micron asks it right after your email; the one you go by', review: true });
      }
    }
  }
  // A SPLIT DATE GETS ITS PARTS (2026-09-24). "09/23/2026" typed into each of
  // Workday's month, day and year boxes left "9", "" and "23" on four forms.
  for (const a of actions) {
    const part = list[a.at]?.datePart;
    if (a.action !== 'fill' || !part) continue;
    const v = String(a.value || '').trim();
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      a.value = part === 'month' ? m[1].padStart(2, '0') : part === 'day' ? m[2].padStart(2, '0') : m[3];
      a.datePart = part;
      continue;
    }
    // A MONTH AND A YEAR, NO DAY — "May 2027" or "05/2027" (his graduation,
    // Boom Supersonic's split graduation date, 2026-09-25). The month and year
    // go in; the day is not in his files, so it is his, and said so.
    // …and the same at the head of a longer answer: his start date reads
    // "June 2027 (graduating May 2027)", and that whole sentence went into
    // each of HP's three date boxes (2026-09-26).
    const my = v.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})(?=$|\s*[(,;—–-])/) || v.match(/^(\d{1,2})\/(\d{4})$/);
    if (!my) continue;
    const mon = /^\d+$/.test(my[1]) ? Number(my[1]) : (['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(my[1].slice(0, 3).toLowerCase()) + 1);
    if (!(mon >= 1 && mon <= 12)) continue;
    // AVAILABILITY FROM A MONTH IS FROM ITS FIRST DAY. "Available June 2027"
    // is a boundary, not a fact with a day missing, and on HP's form he
    // entered exactly 06 / 01 / 2027 himself. A graduation or any other date
    // keeps its day his.
    const startsFrom = /\b(start|begin|available|availability|join)\b/i.test(String(list[a.at]?.label || a.label || ''));
    const said = my[0].trim();
    if (part === 'day') {
      if (startsFrom) Object.assign(a, { value: '01', datePart: part, review: true, why: `available from ${said}: its first day` });
      else Object.assign(a, { action: 'unknown', value: '', why: `your files give ${said} and no day, and this date is taken whole — enter it yourself` });
    } else { a.value = part === 'month' ? String(mon).padStart(2, '0') : my[2]; a.datePart = part; }
  }
  // A DATE WITH NO DAY IS NOT HALF AN ANSWER (Rippling, Boom Supersonic,
  // measured live 2026-09-25). Its month / day / year boxes clear themselves
  // the moment the date is left incomplete — typed by hand, by keystroke or by
  // setter alike — so "05" and "2027" were reported as "filled, but the page
  // did not keep it", twice, beside the day. The day is his; the month and year
  // wait for it, and the one line he reads says why.
  for (const a of actions) {
    if (a.datePart || list[a.at]?.datePart !== 'day' || a.action !== 'unknown') continue;
    const label = list[a.at]?.label;
    for (const b of actions) {
      if (b !== a && b.datePart && (b.datePart === 'month' || b.datePart === 'year') && list[b.at]?.label === label && b.action === 'fill') {
        Object.assign(b, { action: 'skip', value: '', why: 'waits for the day — the date is entered whole' });
      }
    }
  }
  // AN "IF YES" UNDER A QUESTION ANSWERED NO DOES NOT APPLY (2026-09-25).
  // Western Digital's screening page listed six follow-ups as "left for you"
  // — "If yes, please provide their name(s)…", "If yes, … the potential
  // conflict of interest" — under questions the plan itself answered No, and
  // the real gaps drowned in them. Only when the nearest question ABOVE it on
  // this page (the one it follows) was planned No; any other case still lists
  // it for him, as the rule above says.
  for (let k = 0; k < actions.length; k++) {
    const a = actions[k];
    if (a.action !== 'unknown' || !/^only applies if you answered yes above$/.test(String(a.why || ''))) continue;
    let prev = null;
    for (let j = k - 1; j >= 0; j--) {
      if (/^only applies if/.test(String(actions[j].why || ''))) continue;
      prev = actions[j]; break;
    }
    const said = String(prev?.value ?? prev?.answer ?? '').trim();
    if (prev && /^(select|prompt|fill)$/.test(prev.action) && /^(no|n\/a|none|not applicable)\b/i.test(said)) {
      a.action = 'skip';
      a.why = `does not apply — the question above it is answered "${said}"`;
    }
  }
  // THE COMPANY BOX BESIDE A TITLE BOX (Celestica, Flexport, 2026-09-27):
  // `current_company` is "Lakeside University — Manufacturing Lead (student)",
  // his wording for a form that asks only for the company. Beside a "Current
  // Title" box answered "Manufacturing Lead" it repeated the title; the company
  // box then takes the employer part of his own words (F-623).
  {
    const CO = /^(current|present)(\s*\/\s*most\s+recent)?\s+(company|employer)(\s+name)?$/i;
    const TI = /^(current|present)(\s*\/\s*most\s+recent)?\s+(job\s+|position\s+)?title$/i;
    const hasTitle = actions.some((b) => TI.test(tidyLabel(String(b.label || ''))) && b.action === 'fill' && String(b.value || '').trim());
    for (const a of actions) {
      if (!hasTitle || a.action !== 'fill' || !CO.test(tidyLabel(String(a.label || '')))) continue;
      const m = String(a.value || '').match(/^(.+?)\s+[—–-]\s+.+$/);
      if (m) a.value = m[1].trim();
    }
  }
  // …AND "IF NO" UNDER A QUESTION ANSWERED YES (Celestica, 2026-09-27): "If
  // no, have you applied for work authorization in the Country…" sat under
  // "Can you provide proof of legal right to work…" answered Yes, and its own
  // words were answered — "Yes" — as if it applied (F-623).
  for (let k = 1; k < actions.length; k++) {
    const a = actions[k];
    if (!/^\s*\*?\s*if\s+(no|not)\b\s*[,:.-]/i.test(String(a.label || ''))) continue;
    let prev = null;
    for (let j = k - 1; j >= 0; j--) { if (/^\s*\*?\s*if\s+(yes|no|not)\b/i.test(String(actions[j].label || ''))) continue; prev = actions[j]; break; }
    const said = String(prev?.value ?? prev?.answer ?? '').trim();
    if (prev && /^(select|prompt|fill)$/.test(prev.action) && /^yes\b/i.test(said)) {
      Object.assign(a, { action: 'skip', value: '', why: `does not apply — the question above it is answered "${said}"` });
    }
  }
  // "IF YOU CHOSE X, Y OR Z, PLEASE SPECIFY" UNDER AN ANSWER THAT IS NONE OF
  // THEM (Applied Intuition, 2026-09-25): 'If you chose "search engine",
  // "conference", … or "other", please specify here.' followed the
  // how-did-you-hear list the plan answered LinkedIn, and was left for him.
  for (let k = 0; k < actions.length; k++) {
    const a = actions[k];
    if (a.action !== 'unknown') continue;
    const m = String(a.label || '').match(/^\s*if\s+you\s+(?:chose|selected|picked|answered|checked)\s+(.+?)\s*,?\s*(?:please\s+)?(?:specify|explain|describe|tell\s+us|list|elaborate)/i);
    // …and the short form, no quotes: "If other or referred please specify"
    // (Alexander Dennis's Workable form, 2026-09-26).
    const short = !m && String(a.label || '').match(/^\s*if\s+((?:other|referred|referral|yes|no|none|another|someone\s+else)(?:\s*(?:,|or|\/)\s*(?:other|referred|referral|another|someone\s+else))*)\s*,?\s*(?:please\s+)?(?:specify|explain|describe|tell\s+us|list|elaborate|provide)/i);
    // "If other, enter School/Institution Name" (Celestica, 2026-09-27): a
    // box for a name the list above did not have. Trusted only under a LIST,
    // since only a list has an Other row (F-623).
    const enter = !m && !short && String(a.label || '').match(/^\s*if\s+(other)\s*,?\s*(?:please\s+)?(?:enter|input|type|write|add)\b/i);
    if (!m && !short && !enter) continue;
    if (short && /^(yes|no)$/i.test(short[1].trim())) continue;   // "If yes…" has its own rule
    const split = (s) => s.split(/\s*(?:,|\bor\b|\/)\s*/i).map((x) => x.trim().toLowerCase()).filter(Boolean);
    // Quoted option names when there are quotes; the bare words otherwise —
    // "If you selected Agency or Other please specify:" (Celestica).
    const quoted = m ? [...m[1].matchAll(/["“']([^"”']{1,40})["”']/g)].map((x) => x[1].trim().toLowerCase()) : [];
    const named = m ? (quoted.length ? quoted : m[1].length <= 60 ? split(m[1]) : []) : split((short || enter)[1]);
    if (!named.length) continue;
    let prev = null;
    for (let j = k - 1; j >= 0; j--) { if (actions[j].action === 'unknown' && /^\s*if\s+you\b/i.test(String(actions[j].label || ''))) continue; prev = actions[j]; break; }
    const said = String(prev?.value ?? '').trim();
    if (!prev || !/^(select|prompt|fill)$/.test(prev.action) || !said) continue;
    if (enter && !/^(select|prompt)$/.test(prev.action)) continue;
    if (!named.some((n) => said.toLowerCase().includes(n) || n.includes(said.toLowerCase()))) {
      a.action = 'skip';
      a.why = `does not apply — the question above it is answered "${said}"`;
    }
  }
  // A SALARY WITH A CURRENCY LIST BESIDE IT (Sabanto's Breezy form,
  // 2026-09-25). "Desired Salary" came twice: a currency <select> (US Dollar,
  // Canadian Dollar, Euro, …) that "$90000/year" matched nothing in, and an
  // amount box that would not keep "$90000/year". The list gets his currency
  // — US dollars, the currency of his "$" figure — and the box the number.
  {
    const CUR = /\b(dollar|euro|pound|yen|yuan|rupee|franc|peso|dirham|won|krona|krone|real|rand)\b|\b(usd|eur|gbp|cad|aud|jpy|cny|inr)\b/i;
    const isCurrencyList = (f) => /^(select|prompt|radio)$/i.test(String(f?.type || '')) && (f.options || []).filter((o) => CUR.test(String(o?.text ?? o))).length >= 3;
    const money = String(profile?.answers?.salary_expectation || '').match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i);
    for (const a of actions) {
      const f = list[a.at];
      if (!/salary|compensation|pay\b|wage|currency/i.test(String(a.label || ''))) continue;
      // …and its period list (Hourly / Weekly / Monthly / Yearly): his figure
      // is per year.
      const PERIODS = /^(hourly|daily|weekly|bi-?weekly|monthly|yearly|annually|annual|per\s+(hour|day|week|month|year))$/i;
      if (a.action === 'unknown' && money && /\/\s*(yr|year)|per\s+year|annual/i.test(String(profile?.answers?.salary_expectation || ''))
        && (f?.options || []).filter((o) => PERIODS.test(String(o?.text ?? o).trim())).length >= 3) {
        const opts = (f.options || []).map((o) => String(o?.text ?? o).trim());
        const k = opts.findIndex((o) => /^(yearly|annually|annual|per\s+year)$/i.test(o));
        if (k >= 0) { Object.assign(a, { action: 'select', optionIndex: k, value: opts[k], review: true, why: 'your salary figure is per year' }); continue; }
      }
      if (isCurrencyList(f) && a.action === 'unknown' && money) {
        const opts = (f.options || []).map((o) => String(o?.text ?? o));
        const k = opts.findIndex((o) => /\bu\.?\s?s\.?\s*dollar|\busd\b|united\s+states\s+dollar/i.test(o));
        if (k >= 0) Object.assign(a, { action: 'select', optionIndex: k, value: opts[k], review: true, why: 'the currency of your salary figure' });
      } else if (!isCurrencyList(f) && money && a.action === 'fill' && /\$/.test(String(a.value || ''))
        && actions.some((b) => b !== a && b.label === a.label && isCurrencyList(list[b.at]))) {
        const n = Number(money[1].replace(/,/g, '')) * (money[2] ? 1000 : 1);
        if (n > 0) Object.assign(a, { value: String(n), review: true, why: `your salary figure as a number — the currency is chosen beside it` });
      }
    }
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
    // His whole list, ranked: the page stops at fifteen that land (he wants
    // 10-15, 2026-09-24), and a taxonomy that lacks the first ones needs the rest.
    const ranked = rankedSkills(effective, { jd, limit: Math.max(a.values.length, MAX_MULTI_REQUIRED) });
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
  // THE ONLY DOCUMENT SLOT ON THE FORM IS THE RESUME'S. Rippling labels its
  // resume input "Drop or select (.doc / .docx / .pdf)" and marks it only with
  // a test id (Cintal, driven 2026-09-24), so nothing called it a resume and
  // the application went without one. When no slot is recognised and exactly
  // one ordinary upload remains — not a letter, transcript, photo or parser —
  // that one is the resume's.
  // …never when the form HAS a resume slot that already holds his file: Honda's
  // "Additional Attachments" was given a second copy of the resume because the
  // real slot had been skipped as full (2026-10-03).
  if (!actions.some((a) => a.action === 'upload') && !list.some((f) => String(f?.type || '').toLowerCase() === 'file' && isResumeField(f))) {
    const lone = actions.filter((a) => a.type === 'file' && a.action === 'unknown'
      && !NOT_RESUME_RE.test(`${a.label} ${list[a.at]?.id || ''} ${list[a.at]?.name || ''}`)
      && !PARSE_SLOT_RE.test(String(a.label || '')));
    if (lone.length === 1 && Number(list[lone[0].at]?.attached || 0) === 0) {
      Object.assign(lone[0], { action: 'upload', why: 'resume — the only document upload on the form' });
    }
  }
  // …and a TEXT box carrying the same label as a file input is that uploader's
  // own bookkeeping (Rippling pairs one with its resume slot), not a question.
  {
    const fileLabels = new Set(list.filter((f) => String(f?.type || '').toLowerCase() === 'file').map((f) => String(f.label || '').trim()).filter(Boolean));
    for (const a of actions) {
      if (a.action === 'unknown' && a.type !== 'file' && fileLabels.has(String(a.label || '').trim())) {
        Object.assign(a, { action: 'skip', why: 'part of the file upload beside it' });
      }
    }
  }
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

  // WORKDAY'S DISABILITY FORM IS THREE CHECKBOXES under one line, "Please
  // check one of the boxes below:", each carrying one statement as its option
  // (Hyve, Viavi, USICO, 2026-09-24 — left for him every time, and he ticked
  // "No, I do not have a disability…"). The box whose statement says what his
  // profile says is ticked; a decline is never chosen for him.
  {
    const said = polarity(effective?.eeo?.disability);
    for (const a of actions) {
      const f = list[a.at] || {};
      if (String(f.type || '').toLowerCase() !== 'checkbox' || a.action === 'check') continue;
      const opts = (Array.isArray(f.options) ? f.options : []).map((o) => String(o?.text ?? o ?? ''));
      const stmt = opts[0] || '';
      if (!/\bdisabilit/i.test(stmt) || said == null) continue;
      // THE THREE BOXES READ AS ONE GROUP (Intel, 2026-09-26) are one choice,
      // not one statement: judged by the first alone ("Yes, I have…"), the
      // whole group was skipped as "not yours" (F-621).
      if (new Set(opts.map((o) => o.trim().toLowerCase())).size > 1) {
        const i = opts.findIndex((o) => /\bdisabilit/i.test(o) && polarity(o) === said);
        Object.assign(a, i >= 0
          ? { action: 'select', optionIndex: i, value: opts[i], why: 'the disability statement your profile makes' }
          : { action: 'unknown', why: 'no statement here says what your profile does' });
        continue;
      }
      const box = polarity(stmt);
      if (box == null) { Object.assign(a, { action: 'skip', why: 'the decline box — your profile answers this' }); continue; }
      Object.assign(a, box === said
        ? { action: 'check', value: 'checked', why: 'the disability statement your profile makes' }
        : { action: 'skip', why: 'the other disability statement — not yours' });
    }
  }

  // THE BASIC QUESTIONS, CHECKED A SECOND WAY (_facts.mjs). The words that
  // will actually go on the form — the option chosen, not the rule's value —
  // read against the facts he has stated. A contradiction is left for him.
  for (const a of actions) {
    if (!['fill', 'select', 'prompt'].includes(a.action)) continue;
    const f = list[a.at] || {};
    const options = Array.isArray(f.options) ? f.options.map(String) : [];
    const i = options.length ? chooseOption(String(a.value ?? ''), options) : -1;
    const chosen = i >= 0 ? options[i] : a.value;
    const bad = contradicts(a.label, chosen, effective);
    if (!bad) continue;
    Object.assign(a, {
      action: 'unknown',
      review: true,
      why: `left for you: the answer would have been "${String(bad.said).slice(0, 60)}", and your profile says ${bad.want} to this (${bad.topic})`,
    });
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
    // "05/2025" — the MM/YYYY the entry rows write, into a date input.
    m = v.match(/^(\d{1,2})\/(\d{4})$/);
    if (m) return { value: iso(m[2], m[1], 1), review: true };
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
