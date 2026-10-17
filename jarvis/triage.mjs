// jarvis/triage.mjs — fast, deterministic, evidence-quoting triage.
//
// PHILOSOPHY (this is the whole point of Jarvis vs. the old system):
//   Jarvis is far more afraid of hiding a job Alex would have applied to than
//   of showing him a mediocre one. Browsing a so-so role costs seconds; hiding
//   a good one costs an opportunity. So triage FLAGS; it does not DROP.
//
//   The ONLY thing that hard-blocks a job is an explicit, unambiguous work-
//   authorization disqualifier (citizenship / clearance / "no sponsorship").
//   Everything else — seniority, years of experience, weak relevance — is a
//   label the dashboard shows. The user decides.
//
// Every visa signal carries the EXACT source sentence that triggered it, so a
// warning or block is auditable and never a black box.
//
// Zero AI, zero network. Pure string work over the title + description.

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Return the exact source wording that triggered `re`, as a readable window
 * around the match. Works off character offsets in the full text rather than a
 * sentence split, so abbreviations like "U.S." (whose period-space would break
 * a naive sentence splitter and drop the quote) are preserved verbatim — this
 * matters because visa blocks/warnings MUST carry their exact source sentence.
 */
function quoteFor(text, re) {
  const src = String(text || '').replace(/\r/g, '');
  // Clone as a non-global, case-insensitive search.
  const search = new RegExp(re.source, re.flags.replace(/[gy]/g, ''));
  const m = search.exec(src);
  if (!m) return null;
  const start = m.index;
  const end = m.index + m[0].length;
  // Expand outward to the nearest strong boundary (newline, or period/!/?/;
  // followed by a space and a capital — i.e. a real sentence break, not "U.S.").
  // A period is part of an abbreviation/initial (e.g. "U.S.", "U.") when the
  // char before it is a lone letter (no letter two back). Such periods must NOT
  // be treated as sentence boundaries, or a quote gets cut mid-clause.
  const isAbbrevDot = (i) =>
    src[i] === '.' && /[A-Za-z]/.test(src[i - 1] || '') && !/[A-Za-z]/.test(src[i - 2] || ' ');
  let from = 0;
  for (let i = start - 1; i > 0; i--) {
    if (src[i] === '\n') { from = i + 1; break; }
    if (/[.!?;]/.test(src[i]) && !isAbbrevDot(i) && /\s/.test(src[i + 1] || '') && /[A-Z]/.test(src[i + 2] || '')) { from = i + 1; break; }
  }
  let to = src.length;
  for (let i = end; i < src.length; i++) {
    if (src[i] === '\n') { to = i; break; }
    if (/[.!?;]/.test(src[i]) && !isAbbrevDot(i) && (/\s/.test(src[i + 1] || '') || i + 1 >= src.length)) { to = i + 1; break; }
  }
  let quote = src.slice(from, to).trim();
  if (quote.length > 300) {
    // Keep the match itself; clamp around it.
    const rel = start - from;
    const a = Math.max(0, rel - 120);
    quote = (a > 0 ? '…' : '') + quote.slice(a, a + 297).trim() + '…';
  }
  return quote || null;
}

// ── work authorization ──────────────────────────────────────────────
//
// This is the safety core, and it now lives in its own module. It is the ONLY
// place triage produces a hard block, so it is the only place that can cost an
// opportunity by being wrong — see visa.mjs for why it is a clause-scoped
// negation model rather than a list of employer phrasings, and for the two
// rules the user set explicitly (export control is not a clearance; "U.S.
// person" is not "citizen-only").
export { classifyVisa } from './visa.mjs';
import { classifyVisa } from './visa.mjs';
import { checkDegree } from './degree.mjs';
import { yearsMentions } from './requirements.mjs';
import { person, screen, DEFAULT_PERSON } from './targeting.mjs';

// The card's prose was written about one person ("he graduates May 2027").
// His own profile is not `isDefault` (that is the no-profile fallback), so the
// wording keys on the name; anyone else gets a neutral sentence.
const IS_HIM = person.fullName === DEFAULT_PERSON.fullName;


// ── experience level ────────────────────────────────────────────────

// The title words moved to the preset so a second user can run Jarvis
// (presets/<preset>/screen.mjs): "staff" is senior for an engineer and entry
// level for an accountant.
const SENIOR_TITLE_RE = screen.seniorTitle;
// `rotation program` and `development program` are in the hardware preset's
// pattern because Applied Materials' flagship new-grad req is "2027 Engineer
// Development Rotation Program … (E2)": the only entry signal the pattern knew
// was the adjective `rotational`, so the title read as level-neutral and its
// pay grade then classified it a stretch. A graduate programme outranks its
// own grade code.
const ENTRY_TITLE_RE = screen.entryTitle;

/**
 * A NUMBERED LEVEL ABOVE I IS A STRETCH, AND ONLY A STRETCH.
 *
 * "Engineer II, Process Engineering" scored 82 and was classified ENTRY: no
 * years anywhere in the body, a level-neutral title as far as the patterns
 * above were concerned, so nothing contradicted it. He skipped six of these as
 * "Too senior / wants more experience" (his own reason, six times over) while
 * 3,036 of them sat in the deck reading as entry-level.
 *
 * NOT AN EXCLUSION, and the store is what settles that: he has APPLIED to six
 * roles with this exact shape — Applied Materials "Manufacturing Engineer II
 * E2", Lam "Manufacturing Engineer 2" and "Mechanical Engineer 2" twice,
 * Amazon "Mechanical Engineer II" twice. Hiding the band would have cost him
 * every one of them. He is picky WITHIN it, which is not the same as being
 * barred from it, and frequency cannot tell those apart. So: labelled
 * honestly, ranked below entry, still shown.
 *
 * `E2E` is not a level — NVIDIA's "E2E Performance and Goodput" is end-to-end
 * — and the word boundary after the digit is what keeps it out. The roman and
 * arabic forms both appear, and Applied Materials writes its grade in
 * parentheses.
 */
const NUMBERED_LEVEL_TITLE_RE = /\b(?:engineer|scientist|specialist|analyst|developer|designer|technologist)\s*(?:I{2,3}|IV|V|[2-5])\b|\(\s*E[2-5]\s*\)/i;

/**
 * A BACHELOR'S IS A ROUTE IN WITH NO YEARS AT ALL (F-729, 2026-10-14).
 * First Solar's "Engineer- Manufacturing I" lists several routes in: an
 * Associate's plus 3 years, 6 years in manufacturing, 10 years as a skilled
 * technician, or "Bachelor's Degree … with no experience required". The
 * largest figure was read as the ask and the card said "likely too senior"
 * on a role he qualifies for as written. The degree route must sit on one line
 * with its "no experience required", and that line must name no years at all:
 * "4+ years with a Bachelor's, 3+ with a Master's, or no experience required
 * with a PhD" (Intel, Lam, AbbVie — measured on the store) waives the years
 * for the doctorate, not for him.
 */
const NO_EXPERIENCE_RE = /\bno\s+(?:prior\s+|previous\s+|work\s+|professional\s+)?experience\s+(?:is\s+)?(?:required|necessary|needed)/i;
const LINE_YEARS_RE = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b|\byears?\b|\byrs?\b/i;
const WAIVER_FOR_HIGHER_RE = /\b(?:with|and)\s+(?:an?\s+|the\s+)?(?:master|ph\.?\s?d|doctor)|\b(?:master(?:['’]?s)?|ph\.?\s?d\.?|doctorate)(?:\s+degree)?\s*(?:,\s*)?(?:and|with)\s+$/i;
// …AND "A BACHELOR'S … OR N+ YEARS" (2026-10-16). Providien's "A bachelor's
// degree in engineering/sciences or 5+ years of experience in a technical
// role" was read as a 5-year ask: "stretch 5y", and the pick screen never reads
// stretch. The years are the route for someone WITHOUT the degree. Only when
// the degree side names no years itself — "Bachelor's and 3 years, or 5 years"
// is still a 3-year ask.
const DEGREE_OR_YEARS_RE = /\bbachelor(?:['’]?s)?\b([^.\n;]{0,90}?)\bor\s+(?:an?\s+|the\s+)?(?:equivalent\s+)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(?:\(\d+\)\s*)?(?:or\s+more\s+)?(?:years?|yrs?)\b/i;
function degreeOrYears(line) {
  const s = String(line);
  const m = s.match(DEGREE_OR_YEARS_RE);
  if (!m) return false;
  if (LINE_YEARS_RE.test(m[1]) || /\bmaster|\bph\.?\s?d|\bdoctor/i.test(m[1])) return false;
  // "5+ years with a Bachelor's or 3+ years with a Master's" (1X): the years sit
  // BEFORE the degree, and the "or" years belong to another degree.
  const before = s.slice(Math.max(0, m.index - 40), m.index);
  if (/(?:\d|\byears?\b|\byrs?\b)[^.;]{0,25}$/i.test(before)) return false;
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 40);
  if (/^\s*[^.;]{0,15}\b(?:with|and)\s+(?:an?\s+)?(?:master|ph\.?\s?d|doctor|associate|bachelor)/i.test(after)) return false;
  return true;
}
function degreeNeedsNoYears(text) {
  for (const line of String(text || '').split('\n')) {
    if (degreeOrYears(line)) return line.trim();
    const m = line.match(NO_EXPERIENCE_RE);
    if (!m) continue;
    const before = line.slice(0, m.index);
    if (!/\bbachelor/i.test(before) || LINE_YEARS_RE.test(line)) continue;
    if (WAIVER_FOR_HIGHER_RE.test(line.slice(m.index + m[0].length, m.index + m[0].length + 30)) || WAIVER_FOR_HIGHER_RE.test(before.slice(-30))) continue;
    return line.trim();
  }
  return null;
}

// How a years figure is written, which section it sits in, and what is not a
// requirement at all (a 2-year program, a roadmap horizon, "graduated within
// the last 2 years", a pay band): requirements.mjs, shared with prescreen.mjs
// and degree.mjs so a fix reaches all three (F-724). F-466 in FAULTS.md is
// the history of each pattern.

/**
 * The sentence a match sits in — the evidence he reads on the card.
 *
 * `end` matters: several boards put the heading on its own line and the figure
 * under it ("Required Experience\n\n3+ years in vacuum systems…"). Scanning
 * forward from the START of the match stops at that newline and quotes the
 * word "Experience" on its own, which is evidence of nothing. The quote always
 * reaches past the matched text.
 */
function sentenceAround(text, index, end = index) {
  const src = String(text || '');
  let from = 0;
  for (let i = index - 1; i > 0; i--) {
    if (src[i] === '\n' || (/[.!?;•]/.test(src[i]) && /\s/.test(src[i + 1] || ''))) { from = i + 1; break; }
  }
  let to = src.length;
  for (let i = Math.max(index, end); i < src.length; i++) {
    if (src[i] === '\n' || (/[.!?;•]/.test(src[i]) && /\s/.test(src[i + 1] || ''))) { to = i + 1; break; }
  }
  const quote = src.slice(from, to).trim().replace(/\s+/g, ' ');
  return quote.length > 300 ? `${quote.slice(0, 297)}…` : (quote || null);
}

/**
 * Classify seniority / years-of-experience.
 * Returns a level in {entry, mid, stretch, exclude, unknown} plus evidence.
 * Years thresholds, read as the FLOOR of the stated ask:
 *   0–2y → entry (include), 3–5y → stretch (show), >5y → exclude (still shown,
 *   just clearly labeled — Jarvis never silently hides).
 *
 * The boundary sits at 2 rather than 3 because "3+ years" is the commonest
 * phrasing in the market and he has no industry years until May 2027.
 */
export function classifyExperience(title, description) {
  const text = `${title || ''}\n${description || ''}`;
  const evidence = [];

  // Years requirement — the captured number is the FLOOR of the ask: "3+
  // years", "3-5 years" and "minimum 3 years" all require three.
  //
  // That floor used to be banded as `<= 3 → entry`, which read the single most
  // common phrasing in the market — "3+ years" — as entry level. 779 postings
  // in his visible deck state a required 3+ years and sat at the TOP of it by
  // fit, wearing an "entry" label: Amazon Mechanical Engineer II at fit 98,
  // Neuralink at 93. His complaint, verbatim: "it all sounds good until you
  // read jd and find out i have no experience related to this."
  //
  // He graduates in May 2027 with internships and no industry years, so a
  // three-year floor is not entry-friendly — it is the same shape of instant
  // rejection as the EE-degree requirement in degree.mjs. This is F-32 again
  // (pay was scored on the ceiling of the band); an ask is judged by what it
  // demands at minimum, not by the friendliest reading of it.
  // Each figure is the FLOOR of its phrase, and one phrase read by two
  // patterns is one requirement (Zipline's "a minimum of 2-15+ years" is two,
  // not fifteen) — requirements.mjs yearsMentions.
  const kept = yearsMentions(text);

  let requiredYears = null, preferredYears = null;
  const firstHit = kept.length ? kept[0] : null;
  for (const h of kept) {
    if (h.section === 'pref') {
      if (preferredYears == null || h.n > preferredYears) preferredYears = h.n;
    } else if (requiredYears == null || h.n > requiredYears) {
      requiredYears = h.n;
    }
  }
  const maxYears = requiredYears != null ? requiredYears : preferredYears;
  if (maxYears != null && firstHit != null) {
    evidence.push(sentenceAround(text, firstHit.at, firstHit.end));
  }

  const titleSenior = SENIOR_TITLE_RE.test(title || '');
  const titleEntry = ENTRY_TITLE_RE.test(text);

  let level = 'unknown';
  let note = '';

  if (titleSenior) {
    level = 'exclude';
    note = 'Title signals senior/lead/management level — generally not a new-grad fit.';
    evidence.unshift(title);
  } else if (requiredYears == null && preferredYears != null && ENTRY_TITLE_RE.test(title || '')) {
    // Years appear only under "Preferred" / "Nice to have" on a req titled for
    // new grads. That is a wish, not a gate, and blocking on it would hide a
    // job he can get — the expensive error.
    level = 'entry';
    note = `Titled for new grads; ${preferredYears}y is listed as preferred, not required.`;
  } else if (kept.some((h) => h.section !== 'pref' && h.n === 0)) {
    // A REQUIRED RANGE THAT STARTS AT ZERO IS A WAY IN (2026-10-16). Therm-X's
    // "Mechanical Engineer I/II": "Level I: 0–2 years of relevant experience,
    // or strong internship and project work. Level II: 3+ years" — the
    // highest floor (3) was read as the ask and the card said "stretch" over
    // a quote that says otherwise. The curator already passes a zero range.
    const zero = kept.find((h) => h.section !== 'pref' && h.n === 0);
    level = 'entry';
    note = maxYears > 0 ? `A 0-year route is offered; the ${maxYears}-year figure is a higher level of the same role.` : 'Asks for 0+ years — entry-friendly.';
    evidence.unshift(sentenceAround(text, zero.at, zero.end));
  } else if (maxYears != null && degreeNeedsNoYears(text)) {
    level = 'entry';
    note = `A Bachelor's needs no experience here; the ${maxYears}-year figure is another route in.`;
    evidence.unshift(degreeNeedsNoYears(text).replace(/^[•*\-\s]+/, ''));
  } else if (maxYears != null) {
    if (maxYears <= 2) { level = 'entry'; note = `Asks for ~${maxYears}y experience — entry-friendly.`; }
    else if (maxYears <= 5) { level = 'stretch'; note = `Asks for ${maxYears}+ years — ${IS_HIM ? `he graduates ${person.gradLabel} with none` : `a new grad (${person.gradLabel}) has none`}, so this is a stretch.`; }
    else { level = 'exclude'; note = `Asks for ${maxYears}+ years — likely too senior, but shown so you can judge.`; }
  } else if (titleEntry) {
    level = 'entry';
    note = 'Title signals new-grad / entry level.';
  } else if (NUMBERED_LEVEL_TITLE_RE.test(title || '')) {
    // Checked AFTER the entry-title rule, so a req that calls itself a new-grad
    // role keeps that over its own grade code. Applied Materials does exactly
    // this: "2027 Engineer Development Rotation Program … (E2)" is a graduate
    // programme wearing a pay grade.
    level = 'stretch';
    note = 'Titled at level II or above — usually wants a couple of years, so this is a stretch rather than a bar.';
    evidence.unshift(title);
  } else {
    level = 'unknown';
    note = 'No explicit years requirement and title is level-neutral — inspect the posting.';
  }

  // The zero route's floor is the ask that matters ("entry 0y", never "entry 3y"),
  // and one sentence quoted twice is one quote.
  const years = level === 'entry' && kept.some((h) => h.section !== 'pref' && h.n === 0) ? 0 : maxYears;
  return { level, years, note, evidence: [...new Set(evidence.filter(Boolean))] };
}

// ── relevance (informational only) ──────────────────────────────────
//
// A soft score to help SORTING, never filtering. Built from the preset's
// target space (Alex's broad ME one by default). A low score is displayed, not
// hidden. The word lists moved to the preset so a second user can run Jarvis.

const RELEVANCE_SIGNALS = screen.relevanceSignals;
const MAJOR_SIGNALS = screen.majorSignals;
const ACCEPTS_ALL_RE = screen.relevanceAcceptsAll;

/**
 * Informational relevance score 0–100 and the signals that matched.
 * NOT a filter. Used only to sort the dashboard by likely interest.
 */
export function scoreRelevance(title, description) {
  const hay = `${title || ''} ${description || ''}`.toLowerCase();
  const matched = [];
  for (const s of RELEVANCE_SIGNALS) if (hay.includes(s)) matched.push(s);
  // Title matches count double — a signal in the title is a stronger relevance cue.
  const titleLower = (title || '').toLowerCase();
  let score = 0;
  for (const s of matched) score += titleLower.includes(s) ? 8 : 3;
  if (MAJOR_SIGNALS.test(title || '') || ACCEPTS_ALL_RE.test(hay)) score += 10;
  return { score: Math.min(100, score), matched };
}

// ── location (flag, never drop) ─────────────────────────────────────
//
// Alex is on F-1/OPT, so a role physically outside the US is genuinely
// ineligible — but per his rule Jarvis FLAGS rather than hides. The dashboard
// defaults to US + Remote + unknown and offers a toggle to reveal everything.
//
// The classifier itself moved to geo.mjs. It used to be a hand-written list of
// foreign city names right here, and that list leaked a new country every time
// the scanner reached one — Costa Rica got through four different ways at once.
// geo.mjs decides from the closed ISO country and US state tables instead.
// Re-exported so every existing importer of triage.mjs keeps working.
import { classifyLocation } from './geo.mjs';
export { classifyLocation };


// ── role kind (engineer track vs hands-on/trades track) ────────────
//
// Alex is building an engineering career — technician/operator/trades roles
// are a different track and are filtered out of the default view (toggle to
// reveal; flag-not-delete as always). "Engineer" in the title always wins:
// "Manufacturing Engineering Technician" is hands-on, "Test Engineer" is not.

// Both patterns are the preset's (a teller is the finance preset's hands-on track).
const HANDS_ON_RE = screen.handsOnTitle;
const PROFESSIONAL_RE = screen.professionalTitle;

/** 'hands-on' (technician/operator/trades) or 'professional'. */
export function classifyRoleKind(title) {
  const t = String(title || '');
  if (PROFESSIONAL_RE.test(t)) return 'professional';
  return HANDS_ON_RE.test(t) ? 'hands-on' : 'professional';
}

// ── program kind + graduation-window eligibility ────────────────────
//
// Alex graduates May 2027 and is NOT taking another internship or co-op — he
// has to graduate on time. So an internship posting is noise in his inbox, and
// a "New College Graduate" req is the single highest-probability target. Both
// are worth calling out explicitly rather than leaving buried in 8,000 rows.
//
// Graduation windows are the third piece and the most valuable: new-grad reqs
// routinely say "graduating between December 2026 and June 2027". When a
// posting states a window that excludes him, applying is wasted effort on both
// sides — the same reasoning as the visa guard. As always this FLAGS, never
// drops: a stated window is a strong signal but recruiters do make exceptions.

// The user's graduation, from config/profile.yml through targeting.mjs (read
// once at import, so triage stays synchronous over 26k jobs per scan). Tests
// get the default person's May 2027.
const DEFAULT_GRAD_DATE = person.gradDate;

// Plurals too (2026-09-26): "NVIDIA 2027 Internships: Hardware Engineering",
// "Interns (m/f/div) in the fields of…" — 141 live internships carried no
// flag and stayed in the deck he browses. His answer the same day: full-time
// roles only.
const INTERNSHIP_RE = /\b(interns?|internships?|co-?ops?|summer\s+(analyst|associate|program)|industrial\s+placement)\b/i;
// "New grad" naming varies by tenant: NVIDIA says "New College Graduate",
// Intel says "University Graduate", others say "Early Career" or "Rotational".
// NOTE on "rotational": matched only when followed by a program word.
// "Rotational molding" is a plastics process and "rotating/rotational
// equipment engineer" is a standard mechanical title — neither is a new-grad
// signal, and a bare \brotational\b would wrongly badge both.
// Moved to the preset ("graduate engineer" for one field, "analyst program" for another).
const NEW_GRAD_RE = screen.newGradTitle;

// The matcher above reads words and cannot see a negation in front of them.
// Applied Materials writes, in the body of a req that wants 5+ years:
//
//   "New College Graduate Applicants will NOT be considered"
//
// which matched "New College Graduate", set the new-grad flag, and promoted a
// posting that EXPLICITLY REJECTS him to the top of his Today slate — that
// view sorts new-grad reqs first. A posting saying he is ineligible is the
// strongest possible signal, and it was being read as the opposite.
//
// Deliberately narrow: only an explicit exclusion counts. "No prior experience
// required" and "Relocation Eligible: No" sit near these phrases constantly
// and mean nothing of the sort, so the negation has to name being considered,
// eligible or accepted.
const NEW_GRAD_NEGATED_RE = new RegExp([
  String.raw`\b(?:new\s+col?lege\s+grad(?:uate)?s?|new\s+grad(?:uate)?s?|recent\s+grad(?:uate)?s?)\b[^.\n]{0,60}?\b(?:will\s+)?(?:not|no longer)\s+be\s+(?:considered|accepted|eligible)`,
  String.raw`\bnot?\s+(?:open|available|applicable)\s+to\s+(?:new|recent)\s+(?:col?lege\s+)?grad(?:uate)?s?\b`,
  String.raw`\bthis\s+is\s+not\s+an?\s+entry[\s-]?level\s+(?:position|role|job)\b`,
  String.raw`\bnot\s+an?\s+entry[\s-]?level\s+(?:position|role|job)\b`,
].join('|'), 'i');

const MONTHS_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "December 2026" / "Dec 2026" / "2026" → a comparable year*12+month key. */
function monthKey(monthWord, year) {
  const m = monthWord ? MONTH_INDEX[String(monthWord).slice(0, 3).toLowerCase()] : null;
  return { year: Number(year), month: m, key: Number(year) * 12 + ((m || 1) - 1) };
}

/**
 * SEASONS, WHICH NEW-GRAD REQS USE CONSTANTLY AND THIS PARSER USED TO IGNORE.
 *
 * Radiant's 2027 new-grad req says "Graduating in December 2026 or Spring
 * 2027". The parser knew months but not seasons and did not treat "or" as a
 * range, so it read only "December 2026", set the window to that single month
 * and blocked a posting that names his class in its own title. Measured
 * 2026-09-19 on a live posting.
 *
 * The spans are deliberately GENEROUS at both ends. A window that is too wide
 * shows him a job he then reads and judges; one that is too narrow hides a job
 * he qualifies for and he never learns it existed. Only the second is
 * unrecoverable, so every boundary here rounds outward.
 */
const SEASON_SPAN = {
  spr: [3, 6],    // March – June
  sum: [6, 9],    // June – September
  fal: [9, 12],   // September – December
  aut: [9, 12],
  win: [-1, 3],   // December of the PREVIOUS year – March
};

/**
 * One term — a month, a season, or a bare year — as the span it covers.
 * @returns {{from: object, to: object}}
 */
function termSpan(word, year) {
  const y = Number(year);
  const w = word ? String(word).slice(0, 3).toLowerCase() : '';
  const season = SEASON_SPAN[w];
  if (season) {
    const [a, b] = season;
    // A negative start month means the season opens in the previous year.
    const from = a < 0 ? monthKey('dec', y - 1) : monthKey(monthNameOf(a), y);
    return { from, to: monthKey(monthNameOf(b), y) };
  }
  if (MONTH_INDEX[w]) {
    const k = monthKey(word, y);
    return { from: k, to: k };
  }
  // A bare year means the whole year is acceptable.
  return { from: monthKey('jan', y), to: monthKey('dec', y) };
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthNameOf = n => MONTH_NAMES[Math.min(12, Math.max(1, n)) - 1];

/**
 * Find a stated graduation window in the posting.
 *
 * Handles the shapes that actually appear in new-grad reqs:
 *   "graduating between December 2026 and June 2027"
 *   "graduation date between Dec 2026 - Jun 2027"
 *   "must graduate by May 2027"
 *   "graduating in 2027"
 *   "Class of 2027"
 * Returns null when the posting says nothing — silence is NOT a restriction.
 */
export function graduationWindow(text) {
  const src = String(text || '').replace(/\s+/g, ' ');
  // Seasons count as terms wherever a month can appear.
  const M = `${MONTHS_RE}|spring|summer|fall|autumn|winter`;

  // Ranged: "... between <Term> <Year> and/to/or/- <Term> <Year>"
  //
  // "or" belongs in this list. An employer writing "December 2026 or Spring
  // 2027" is naming two acceptable ends of one window, not one date — and
  // reading only the first is how a req that names his class came to be hidden
  // from him.
  let m = new RegExp(
    `graduat\\w*[^.]{0,40}?(?:between\\s+)?(${M})?\\.?\\s*(20\\d\\d)\\s*(?:and|to|or|-|–|—|through)\\s*(${M})?\\.?\\s*(20\\d\\d)`, 'i',
  ).exec(src);
  if (m) {
    return {
      from: termSpan(m[1], m[2]).from,
      to: termSpan(m[3], m[4]).to,
      quote: quoteFor(src, /graduat\w*/i),
    };
  }

  // The same two ends, written the other way round: "<Term> <Year> or <Term>
  // <Year> graduates" / "Spring 2027 or Fall 2027 grads".
  m = new RegExp(
    `(${M})\\.?\\s*(20\\d\\d)\\s*(?:and|to|or|-|–|—|through)\\s*(${M})?\\.?\\s*(20\\d\\d)[^.]{0,30}?grad`, 'i',
  ).exec(src);
  if (m) {
    return {
      from: termSpan(m[1], m[2]).from,
      to: termSpan(m[3], m[4]).to,
      quote: quoteFor(src, /grad/i),
    };
  }

  // Bounded one side: "must graduate by <Term> <Year>" / "graduating on or before"
  m = new RegExp(`graduat\\w*[^.]{0,30}?(?:by|before|no later than|prior to)\\s+(${M})?\\.?\\s*(20\\d\\d)`, 'i').exec(src);
  if (m) return { from: null, to: termSpan(m[1], m[2]).to, quote: quoteFor(src, /graduat\w*/i) };

  // The term written BEFORE the word: "Spring 2027 graduation", "May 2027
  // graduates". The patterns above all expect "graduating …" first, so this
  // shape returned nothing at all — harmless, since no window means no
  // restriction, but it threw away a stated fact we can use.
  m = new RegExp(`(${M})\\.?\\s*(20\\d\\d)\\s+grad`, 'i').exec(src);
  if (m) {
    const span = termSpan(m[1], m[2]);
    return { from: span.from, to: span.to, quote: quoteFor(src, /grad/i) };
  }

  // Single term: "graduating in 2027" / "graduating May 2027" / "Class of 2027"
  m = new RegExp(`(?:graduat\\w*[^.]{0,25}?|class\\s+of\\s+)(${M})?\\.?\\s*(20\\d\\d)`, 'i').exec(src);
  if (m) {
    const span = termSpan(m[1], m[2]);
    return { from: span.from, to: span.to, quote: quoteFor(src, /graduat\w*|class\s+of/i) };
  }
  return null;
}

/**
 * Classify a posting's program kind and check the stated graduation window
 * against the user's own graduation date.
 *
 * `gradDate` is {year, month} — the user's graduation (Alex: May 2027). When a
 * posting states a window he falls outside, `gradEligible` is false and the
 * quote is carried so the dashboard can show WHY, exactly like a visa block.
 */
export function classifyProgram(title, description, gradDate) {
  const text = `${title || ''}\n${description || ''}`;
  const t = String(title || '');

  // Title is authoritative for internships — a full-time req whose description
  // mentions "our internship program" is not an internship.
  const internship = INTERNSHIP_RE.test(t);
  // An explicit "new grads will not be considered" overrides the phrase match
  // that found the words. The title still wins over the body: a req TITLED for
  // new grads is one, whatever a boilerplate paragraph further down says.
  const excluded = NEW_GRAD_NEGATED_RE.test(text) && !NEW_GRAD_RE.test(t);
  const newGrad = NEW_GRAD_RE.test(t) || (!internship && !excluded && NEW_GRAD_RE.test(text));

  const win = graduationWindow(text);
  let gradEligible = null, gradNote = null;
  if (win && gradDate?.year) {
    const mine = Number(gradDate.year) * 12 + ((Number(gradDate.month) || 1) - 1);
    const afterStart = !win.from || mine >= win.from.key;
    const beforeEnd = !win.to || mine <= win.to.key;
    gradEligible = afterStart && beforeEnd;
    if (!gradEligible) {
      gradNote = `Posting states a graduation window you fall outside of (you: ${gradDate.month || '?'}/${gradDate.year}).`;
    }
  }

  return {
    internship,
    newGrad: !!newGrad && !internship,
    gradWindow: win ? { from: win.from, to: win.to, quote: win.quote } : null,
    gradEligible,
    gradNote,
  };
}

// ── top-level ───────────────────────────────────────────────────────

/**
 * Full triage for one job. Returns a plain object stored on the job record and
 * consumed by the dashboard. Nothing here decides visibility — that is the
 * dashboard's/user's job.
 */
export function triage(job, opts = {}) {
  const { title, description, location, url } = job;
  const visa = classifyVisa(title, description);
  const experience = classifyExperience(title, description);
  const relevance = scoreRelevance(title, description);
  // The URL is passed because the ATS writes the primary site into it, and
  // that is the only location evidence a "2 Locations" placeholder leaves.
  const locationBucket = classifyLocation(location, title, url);
  const roleKind = classifyRoleKind(title);
  // Graduation defaults to the user's own date (person.gradDate; Alex's May
  // 2027 by default) so every existing caller keeps working; pass
  // opts.gradDate to triage for someone else.
  const program = classifyProgram(title, description, opts.gradDate || DEFAULT_GRAD_DATE);
  // "it needs electrical engineering degree i am mechanical bruh its instant
  // rejection genuinely" — his own words, on a Micron req that scored 95.
  // Same shape as the graduation window: a stated requirement no amount of
  // fit can make winnable. Only a CLOSED list naming disciplines, none of
  // them his, counts; see degree.mjs for why the bar is that high.
  const degree = checkDegree(description, title);
  return {
    program,
    degree,
    visa,
    experience,
    relevance,
    locationBucket,
    roleKind,
    // A single convenience roll-up the dashboard can badge on quickly.
    flags: {
      hardBlock: !!visa.block,
      // CAUTION ONLY — not "unknown".
      //
      // Most postings say nothing about sponsorship, so `sponsorship_unmentioned`
      // fires on nearly all of them. Feeding it into this flag put an amber
      // "⚠ verify" on every single row of the list, which makes the column
      // worthless: a badge that is always on carries no information, and it
      // buried the cautions that matter (export control, a negative OPT
      // mention). Silence is still reported on the card, where there is room
      // to explain it; it no longer shouts from the table.
      visaWarning: visa.warnings.some(w => w.level === 'caution'),
      // Kept separate so the card and any future filter can still ask.
      visaSilent: visa.warnings.some(w => w.key === 'sponsorship_unmentioned'),
      // A hard block always wins: a posting can't be "sponsor-friendly" and
      // blocked at the same time.
      visaGood: !visa.block && visa.warnings.some(w => w.level === 'good'),
      senior: experience.level === 'exclude',
      stretch: experience.level === 'stretch',
      handsOn: roleKind === 'hands-on',
      // Not taking another internship/co-op — has to graduate on time.
      internship: program.internship,
      // The highest-probability target tier for a graduating senior.
      newGrad: program.newGrad,
      // Only true when the posting STATES a window he falls outside. Silence
      // is never a restriction, so this stays false for the vast majority.
      gradMismatch: program.gradEligible === false,
      // Only true when the posting NAMES disciplines and none are his.
      // Silence, "Engineering", and any "or related field" are all matches.
      degreeMismatch: degree.mismatch,
    },
  };
}
