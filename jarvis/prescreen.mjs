// jarvis/prescreen.mjs — the turn-downs a script can make before the model reads.
//
// WHY (2026-10-08). Of 1,235 postings read in full for one batch of picks,
// 1,199 were turned down, and two reasons were most of it: a required 2+ years
// (59%) and a title in another discipline (22%). Both are written on the
// posting in plain words; paying a model to read 3,000 words to find them is
// the expensive way. He asked: "cant we make a script for most of these
// problems?"
//
// ONE RULE ABOVE THE OTHERS: this may only turn down what the reader would
// turn down too. Anything it is unsure of goes to the reader. So it drops on
//   · a REQUIRED minimum of 2+ years of experience, stated on its own line,
//     with no lower path anywhere in the posting ("0-2 years", "new grad",
//     "internships count", an "or" alternative); or 3+ years PREFERRED, which
//     he counts as required ("if it says 3 yoe preferred 100% it means
//     mandatory"); and
//   · a title that names another discipline (electrical, civil, software …)
//     and no mechanical / manufacturing / robotics word at all.
// The thresholds are his years rule (curate.mjs promptFor, 2026-10-04): one
// year is a "worth a look", 1-2 only with internships counting, 2+ a drop.
//
// Backtested on every verdict the reader made (prescreen.test.mjs fixtures
// come from those postings): it must never drop a KEEP or a MAYBE.

import { yearsMentions } from './requirements.mjs';
import { screen } from './targeting.mjs';

// The smallest number of years a line asks for, or NaN. "2-5 years" → 2;
// "minimum of 3 years" → 3; "4+ years" → 4; "two (2) or more years" → 2.
// The same reading triage makes (requirements.mjs, F-724).
export function minYears(line) {
  return yearsMentions(line)[0]?.n ?? NaN;
}

// A years line that is about something other than his experience.
const NOT_EXPERIENCE = /\b(?:of age|old|older|legacy|history|founded|in business|for over|more than \d+ years,|tax credit|vacation|paid time|pto|holiday|service|tenure|employment|401|match|vest|bonus|per year|annual|salary|pay range|\$|warranty|lifespan|life cycle|anniversary|years? (?:ago|running|in a row)|to graduat\w*)\b/i;
// The company talking about itself: "Our engineers bring 15+ years of industry
// experience", "Acme's team has 12 years…" (F-724). "We are looking for 5+
// years" and "(we use C++ 20)" are still asks.
const COMPANY_VOICE = /\b(?:our|we(?:'ve)?)\s+(?:[\w-]+\s+){0,3}?(?:bring|brings|have|has|had|spent|served|built|been|delivered|operated|grown|pioneered|combined?)\b|\b(?:engineers|team|teams|company|employees|staff|experts|founders|leadership|we)\s+(?:bring|brings|has|have|combine)\s+(?:over\s+|more than\s+|nearly\s+|a combined\s+)?\d/i;
// "Acme has 12 years of experience in …": a named subject that HAS the years.
const NAMED_HAS = /(?:^|[.!?]\s+)(?!(?:You|Candidates?|Applicants?|Ideal|The|Must|Should)\b)[A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,3}\s+(?:has|have)\s+(?:over\s+|more than\s+|nearly\s+|almost\s+)?\d/;
// "Typically suited for … approximately 2–5 years" (Verustruct, a KEEP) is a
// description of who usually fits, not a bar — read like "preferred".
const PREFERRED = /\b(?:prefer\w*|nice to have|a plus|is a plus|bonus|ideal(?:ly)?|desired|desirable|advantageous|beneficial|helpful|typically|approximately|suited|usually|generally)\b/i;
const REQUIRED_WORD = /\b(?:required|requires?|requirement|minimum|at least|must|mandatory|necessary)\b/i;
// Any of these anywhere in the posting is a way in for a new graduate.
const LOWER_PATH = /\b(?:0|zero)\s*(?:\+|-|–|to)?\s*\d*\s*(?:years?|yrs?)|\bnew\s*(?:college\s*)?grad|\bentry[-\s]level\b|\brecent\s+(?:college\s+)?grad|\bearly[-\s]career\b|\b(?:internships?|co-?ops?)\b[^.\n]{0,60}\b(?:count|qualif|consider|accept|includ|apply)|\bincluding\s+(?:internships?|co-?ops?)|\bno\s+(?:prior\s+)?experience\s+(?:required|necessary)|\bwill\s+train\b|\bfresh\s+grad|\b(?:all|any)\s+(?:experience\s+|career\s+)?levels?\b|\bstudents?\s+(?:and|or)\s+(?:recent\s+)?grad/i;

/** The trimmed line around `index`, and its non-blank neighbours. */
function lineAround(body, index) {
  const from = body.lastIndexOf('\n', index - 1) + 1;
  const to = body.indexOf('\n', index);
  const line = body.slice(from, to < 0 ? body.length : to).trim();
  const prev = body.slice(0, from).split(/\n+/).map((l) => l.trim()).filter(Boolean).pop() || '';
  const next = (to < 0 ? '' : body.slice(to)).split(/\n+/).map((l) => l.trim()).find(Boolean) || '';
  return { line, prev, next };
}

/**
 * The years rule, applied to a posting's text. Returns the line that turns it
 * down, or null. Where the posting asks for years, and which section each ask
 * sits in, is triage's reading (requirements.mjs yearsMentions); what is here
 * is how much more a line must say before it may drop a posting unread.
 */
export function yearsBar(text) {
  const body = String(text || '');
  if (LOWER_PATH.test(body)) return null;
  const seen = new Set();
  for (const { at, n: y, section } of yearsMentions(body)) {
    const { line, prev, next } = lineAround(body, at);
    if (seen.has(line)) continue;
    // A DEGREE'S LENGTH IS NOT EXPERIENCE (2026-11-06): Fluor's new-grad
    // "Accredited four (4) year Bachelor's Degree … and no required years of
    // experience" was cut as "requires 4+ years".
    if (/^\W{0,3}[a-z0-9]*\)?\s*(?:\(\d+\)\s*)?[- ]?years?\s+(?:bachelor|undergraduate|college|university|degree|engineering\s+degree|program)/i.test(body.slice(at, at + 60))) continue;
    seen.add(line);
    if (!(/experience|\bexp\b|background|working|work(?:ed)?\s+(?:in|as|with)|environment|industry/i.test(line) || REQUIRED_WORD.test(line))) continue;
    // A requirement is a short line; an upper bound ("up to two years") is not a floor.
    // Not "under About us, skip": Amazon stores its qualification bullets below
    // "About AWS" with no heading between, and every one is a real ask.
    if (NOT_EXPERIENCE.test(line) || COMPANY_VOICE.test(line) || NAMED_HAS.test(line.replace(/^\W+/, '')) || line.length > 240) continue;
    if (/\b(?:less than|fewer than|up to|under|no more than|maximum of|or less)\b/i.test(line)) continue;
    // An alternative path ("… or 6 years …", an associate's-degree route) is
    // a choice, not a bar: the reader decides those.
    // Only an "or" that offers another number of years, or ends the line; "…Engineering,
    // or Continuous Improvement" is a list of fields, not a second route.
    const altRoute = /\bor\b[^.;]{0,25}\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b[^.;]{0,20}\b(?:years?|yrs?)\b/i.test(line) || /\bor\s*$/i.test(line);
    if (altRoute || /\bor\s*$/i.test(prev) || /^\s*or\b/i.test(next) || /\bin lieu\b|\bequivalent\b|\bassociate'?s?\b|\bmaster'?s?\b|\bph\.?d\b|\bhigh school\b|\bdiploma\b/i.test(line)) continue;
    if (y < 2) continue;
    const preferred = PREFERRED.test(line) || (section === 'pref' && !REQUIRED_WORD.test(line));
    if (preferred) {
      if (y >= 3) return { quote: line.slice(0, 220), years: y, preferred: true };
      continue;
    }
    // Anything else is required: said so on the line, under a required heading,
    // a bare "N+ years of … experience" bullet (which the reader treats as
    // required, F-622), or under no heading the reader would call preferred.
    return { quote: line.slice(0, 220), years: y, preferred: false };
  }
  return null;
}

// Title words that place a job outside his discipline, and words that bring it
// back in. Moved to the preset so a second user can run Jarvis.
const OTHER_DISCIPLINE = screen.otherDiscipline;
const OUR_DISCIPLINE = screen.ourDiscipline;

/** The title's discipline bar: the word that rules it out, or null. */
export function disciplineBar(title) {
  const t = String(title || '');
  const other = OTHER_DISCIPLINE.exec(t);
  if (!other || OUR_DISCIPLINE.test(t)) return null;
  return { word: other[0] };
}

/**
 * Is this a role made for a graduating class (new grad, university hire,
 * "<month> 2027 Graduates", early career)? The preset says which words count.
 */
export function gradProgram({ title, text } = {}) {
  const gp = screen.gradProgram;
  if (!gp) return false;
  return !!((gp.title && gp.title.test(String(title || ''))) || (gp.body && gp.body.test(String(text || ''))));
}

/** A robotics company, where a required 1-2 years is a stretch (his answer 2026-11-06). */
export function stretchEmployer(company) {
  return !!(screen.roboticsEmployers && screen.roboticsEmployers.test(String(company || '').trim()));
}

/**
 * A STRETCH: a robotics company's posting whose required years start at 1 or
 * 2 (his answer 2026-11-06, "5. ye"). A role made for his graduating class is
 * not a stretch, and 3+ is not either.
 */
export function stretchYears({ company, title, text } = {}) {
  if (!stretchEmployer(company) || gradProgram({ title, text }) || !stretchTitle(title)) return false;
  const y = yearsBar(text);
  if (y) return y.years <= (screen.stretchMaxYears ?? 2);
  // yearsBar leaves 1-year lines to the reader; a required "1+" / "1-2" / "1-3"
  // is a stretch too. Never a "0-1" (a zero start is a true fit) nor "within 1
  // year you will…" (review 2026-11-06): the 1 starts the line's number, and
  // the line asks for experience.
  return String(text || '').split('\n').some((line) => !/\b0\s*(?:-|–|to)\s*1\b/.test(line)
    && /(?<![\d.–-])\b(?:1|one)\s*(?:\(1\)\s*)?(?:\+|(?:-|–|to)\s*(?:2|3|two|three))?\s*\+?\s*years?\b[^.\n]{0,60}\bexperience\b/i.test(line)
    && !/\bwithin\s+(?:1|one)\s+years?\b/i.test(line));
}

/**
 * Titles that are never a stretch, whatever the years: field, service,
 * support, quality and customer-facing roles he has turned down (his earlier
 * no's; review 2026-11-06 widened it).
 */
const NOT_A_STRETCH_TITLE = /\b(?:field\s+(?:service|support|application|engineer|deployment)|service\s+engineer|technical\s+support|support\s+engineer|customer\s+(?:support|success)|applications?\s+engineer|sales\s+engineer|solutions?\s+engineer|technical\s+account|quality|technician)\b/i;
export function stretchTitle(title) { return !NOT_A_STRETCH_TITLE.test(String(title || '')); }

/**
 * Turn a posting down without a model, or return null to send it to the reader.
 * @returns {{verdict: 'DROP', why: string, rule: 'years'|'discipline'} | null}
 */
export function prescreen({ title, text, company = '' }) {
  const d = disciplineBar(title);
  if (d) return { verdict: 'DROP', rule: 'discipline', why: `screened before reading: the title names another discipline ("${d.word}") and no ${screen.disciplineWork}` };
  // A program for his graduating class is not cut on years it can meet with
  // internships (his rule, 2026-11-06): a line starting at 1 or 2 passes to
  // the reader. 3+ on a new-grad title is still mislabelled (his earlier rule).
  const y = yearsBar(text);
  if (y && gradProgram({ title, text }) && y.years <= (screen.gradProgramMaxYears ?? 2)) return null;
  // At a robotics company a required 1-2 years is a stretch, read (his answer 2026-11-06, "5. ye").
  if (y && stretchEmployer(company) && stretchTitle(title) && y.years <= (screen.stretchMaxYears ?? 2)) return null;
  if (y) {
    return { verdict: 'DROP', rule: 'years', why: y.preferred
      ? `screened before reading: ${y.years}+ years preferred, which counts as required — "${y.quote}"`
      : `screened before reading: requires ${y.years}+ years and offers no lower path — "${y.quote}"` };
  }
  return null;
}
