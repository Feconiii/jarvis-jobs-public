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


// ── experience level ────────────────────────────────────────────────

const SENIOR_TITLE_RE = /\b(senior|sr\.?|staff|principal|lead|distinguished|manager|supervisor|superintendent|director|head\s+of|vp|vice\s+president|chief|architect)\b/i;
// `rotation program` and `development program` are here because Applied
// Materials' flagship new-grad req is "2027 Engineer Development Rotation
// Program … (E2)": the only entry signal the pattern knew was the adjective
// `rotational`, so the title read as level-neutral and its pay grade then
// classified it a stretch. A graduate programme outranks its own grade code.
const ENTRY_TITLE_RE = /\b(new\s+grad(uate)?|entry[-\s]?level|early\s+career|university\s+(hire|grad)|campus|associate|engineer\s+(i|1)\b|graduate\s+(engineer|program)|rotational|rotation\s+program|development\s+program|apprentice)\b/i;

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

// Headings that turn everything under them into a wish rather than a gate.
// Amazon splits every req into "BASIC QUALIFICATIONS" and "PREFERRED
// QUALIFICATIONS" and puts a second, higher years figure in the latter.
const PREFERRED_HEAD_RE = /\b(preferred\s+(?:qualification|skill|experience|requirement)s?|nice\s*[-\s]?to\s*[-\s]?have|bonus\s+points|desired\s+(?:qualification|skill|experience)s?|it'?s?\s+a\s+plus|pluses|preferred:|would\s+be\s+a\s+plus|ideal(?:ly)?\s+you)\b/i;
// …and headings that end that section, putting us back in required territory.
const REQUIRED_HEAD_RE = /\b(basic\s+qualification|minimum\s+qualification|required\s+qualification|requirements:|qualifications:|what\s+you'?ll\s+need|responsibilities:|about\s+the\s+role)\b/i;

/**
 * Is the match at `index` sitting under a "preferred / nice to have" heading?
 *
 * Looks backwards for the nearest of either heading kind. A years figure under
 * "Preferred Qualifications" is not something he fails to satisfy — treating
 * it as a requirement would hide jobs he could get.
 */
function inPreferredSection(text, index) {
  const before = text.slice(0, index);
  let lastPref = -1, lastReq = -1, m;
  const pre = new RegExp(PREFERRED_HEAD_RE.source, 'ig');
  while ((m = pre.exec(before)) !== null) lastPref = m.index;
  const req = new RegExp(REQUIRED_HEAD_RE.source, 'ig');
  while ((m = req.exec(before)) !== null) lastReq = m.index;
  return lastPref > lastReq;
}

// ── how a years requirement is actually written ─────────────────────
//
// F-466. The first version of this required the literal word "experience"
// within the same sentence, after the figure. Measured on his own store on
// 2026-09-17: of 2,770 rows the picks screen would admit, **139 state a years
// requirement this missed** — and they are the ones at the top of his list.
// 1X "Manufacturing Engineer, Hands" at fit 100 ("5+ years with a Bachelor's"),
// Standard Bots at 97 ("4+ years in electronics/PCBA manufacturing"), Applied
// Materials at 95 ("Experience: 3–7 years"), Gecko at 94 ("5+ years building
// production software"). About 60 of the ~110 he read by hand that week were
// out on years alone. Reading is what the screen is meant to save.
//
// Three shapes, all requirement-shaped rather than merely containing a number:
// The trailing "+" is allowed on BOTH ends: Zipline writes "a minimum of
// 2-15+ years", and a version that could not close that range read it at 15.
const YEARS_NUM = String.raw`(\d{1,2})\s*\+?\s*(?:(?:-|–|—|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)`;
const YEARS_PATTERNS = [
  // 1. The original: a figure and the word experience in the same sentence.
  new RegExp(`${YEARS_NUM}\\b[^.]*?(?:experience|exp\\b)`, 'i'),
  // 2. The figure carries its own object: "5+ years with a Bachelor's",
  //    "4+ years in electronics manufacturing", "5+ years building production
  //    software", "2 to 5 years in hardware test".
  //    "program" is deliberately NOT in this list: "During this 2 year program"
  //    is Viavi's rotational scheme, a req written for exactly him.
  new RegExp(`${YEARS_NUM}\\s*\\)?\\s+(?:of|in|with|as|building|working|develop\\w*|design\\w*|support\\w*|integrat\\w*|lead\\w*|manag\\w*|programming)\\b`, 'i'),
  // 3. Reversed, which is how the Indian and Israeli sites of the big
  //    equipment makers write it: "Experience: 3–7 years", "Experience - 5 to
  //    8 Yrs", "Experience (3-5 years)", "related work experience of 5 years".
  new RegExp(`(?:experience|exp)\\b\\s*[:\\-–—(]?\\s*(?:of\\s+)?${YEARS_NUM}`, 'i'),
  // 4. Stated as a floor in words: "minimum of 2 years", "at least 3 years".
  new RegExp(`(?:minimum(?:\\s+of)?|at\\s+least|requires?)\\s+${YEARS_NUM}`, 'i'),
];

// A number of years next to a noun that is not a requirement. Each of these
// was a false positive in the measurement, and each would have cost him a job
// he can actually get, which is the expensive direction:
//   Viavi  "During this 2 year program you will…"      — a rotation he wants
//   Micron "strategic roadmaps for 5+ years in post probe wafer…" — a horizon
//   Zebra  "…a 4 year degree"                          — the degree, not a bar
const NOT_A_REQUIREMENT_AFTER = /^\W{0,3}(program|degree|school|university|college|course|rotation|contract|warranty|roadmap|plan|lease|old\b|age\b|running|in a row|of (?:growth|history|operation))/i;
// "…who graduated within the last 2 years" is new-grad INCLUSION, and reading
// it as a two-year bar turns a req written for him into one he is filtered out
// of (Medtronic, fit 94).
const RECENCY_BEFORE = /\b(?:with)?in\s+the\s+(?:last|past|previous)\s*$|\bgraduated\s+(?:with)?in\s+the\s+\w+\s*$/i;
// Pay bands sit next to the qualifications block and carry their own numbers;
// "Base Pay Range: $117,800.00 - $200,300.00" must not lend a digit to a
// years match that starts inside it.
const PAY_BEFORE = /\$[\d,.]+\s*(?:-|–|—|to)?\s*[\d,.]*\s*$/;
// A span of years the ROLE looks ahead over, not one the candidate must have
// behind them: Micron's "Establish hardware strategic roadmaps for 5+ years in
// post probe wafer and die processing" is a duty, and reading it as a bar took
// a fit-89 req off his list.
// Kept narrow on purpose: a horizon noun within 20 characters, or the literal
// "over/for the next". A looser rule that swallowed a bare "over" would have
// skipped "over 5 years of experience", which IS a bar.
const HORIZON_BEFORE = /\b(?:roadmaps?|horizons?|forecasts?|strateg(?:y|ies|ic)|visions?|outlooks?|pipelines?|planning)\b[^.]{0,20}$|\b(?:over|for|in|within)\s+the\s+next\s+$/i;

/**
 * Is this match a requirement on the candidate, rather than a number that
 * happens to sit beside the word "years"?
 */
function isRequirementYears(text, m) {
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
  const before = text.slice(Math.max(0, m.index - 60), m.index);
  if (NOT_A_REQUIREMENT_AFTER.test(after)) return false;
  if (RECENCY_BEFORE.test(before)) return false;
  if (PAY_BEFORE.test(before)) return false;
  if (HORIZON_BEFORE.test(before)) return false;
  return true;
}

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
  let m;
  const hits = [];
  for (const yre of YEARS_PATTERNS) {
    const re = new RegExp(yre.source, 'gi');
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      // >15 years is company-history boilerplate ("KLA has 40 years of
      // experience in…"), not a candidate requirement — ignore it. Zero is
      // kept: "0+ years" and "0 to 2 years" are how the reqs written for him
      // say so, and dropping the figure would leave them level-unknown.
      if (Number.isNaN(n) || n > 15) continue;
      if (!isRequirementYears(text, m)) continue;
      hits.push({ at: m.index, end: m.index + m[0].length, n });
    }
  }

  // ONE PHRASE READ BY TWO PATTERNS IS ONE REQUIREMENT, AT ITS FLOOR.
  // Zipline's "worked for a minimum of 2-15+ years" is matched by the
  // "minimum of N" pattern at the 2 and by the "N years in <field>" pattern at
  // the 15. Keeping both and taking the larger read a two-year floor as
  // fifteen. Sorted by position, the earliest match wins its span — which is
  // the one that starts at the floor, because that is the order English
  // states a range in.
  hits.sort((a, b) => a.at - b.at || a.n - b.n);
  const kept = [];
  for (const h of hits) {
    if (kept.some((k) => h.at < k.end && k.at < h.end)) continue;
    kept.push(h);
  }

  let requiredYears = null, preferredYears = null;
  const firstHit = kept.length ? kept[0] : null;
  for (const h of kept) {
    if (inPreferredSection(text, h.at)) {
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
  } else if (maxYears != null) {
    if (maxYears <= 2) { level = 'entry'; note = `Asks for ~${maxYears}y experience — entry-friendly.`; }
    else if (maxYears <= 5) { level = 'stretch'; note = `Asks for ${maxYears}+ years — he graduates May 2027 with none, so this is a stretch.`; }
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

  return { level, years: maxYears, note, evidence: evidence.filter(Boolean) };
}

// ── relevance (informational only) ──────────────────────────────────
//
// A soft score to help SORTING, never filtering. Built from Alex's broad ME
// target space. A low score is displayed, not hidden.

const RELEVANCE_SIGNALS = [
  'mechanical', 'manufacturing', 'process engineer', 'industrial engineer', 'automation',
  'controls', 'semiconductor', 'equipment engineer', 'mechatronics', 'robotics',
  'design engineer', 'product engineer', 'npi', 'new product introduction', 'reliability',
  'test engineer', 'validation', 'quality engineer', 'supplier quality', 'applications engineer',
  'field service', 'field engineer', 'customer engineer', 'facilities', 'production',
  'operations', 'project engineer', 'sustaining', 'process integration', 'metrology',
  'cnc', 'additive', 'tooling', 'fixture', 'gd&t', 'solidworks', 'cad', 'fea',
  'thermal', 'fluid', 'vacuum', 'motion', 'actuator', 'yield', 'failure analysis',
  'assembly', 'fabrication', 'machining', 'wafer', 'fab ', 'cleanroom', 'hardware',
];
const MAJOR_SIGNALS = /\b(mechanical|manufacturing|industrial|electromechanical|mechatronic|aerospace|materials|engineering)\b/i;

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
  if (MAJOR_SIGNALS.test(title || '') || /accepts?\s+(all\s+)?engineering/i.test(hay)) score += 10;
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

const HANDS_ON_RE = /\b(technician|tech\b|operator|machinist|assembler|welder|fabricator|inspector|material\s+handler|warehouse|custodian|janitor|driver|production\s+(associate|worker)|line\s+(lead|worker)|installer|mechanic|apprentice(?!\s+engineer))\b/i;

/** 'hands-on' (technician/operator/trades) or 'professional'. */
export function classifyRoleKind(title) {
  const t = String(title || '');
  if (/\bengineer\b/i.test(t)) return 'professional';
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

// Alex's graduation. Kept here (not read from a file) so triage stays pure and
// synchronous — it runs over 26k jobs per scan. Change it here if his date moves.
const DEFAULT_GRAD_DATE = { year: 2027, month: 5 };

const INTERNSHIP_RE = /\b(intern|internship|co-?op|summer\s+(analyst|associate|program)|industrial\s+placement)\b/i;
// "New grad" naming varies by tenant: NVIDIA says "New College Graduate",
// Intel says "University Graduate", others say "Early Career" or "Rotational".
// NOTE on "rotational": matched only when followed by a program word.
// "Rotational molding" is a plastics process and "rotating/rotational
// equipment engineer" is a standard mechanical title — neither is a new-grad
// signal, and a bare \brotational\b would wrongly badge both.
const NEW_GRAD_RE = /\b(new\s+col?lege\s+grad(uate)?s?|new\s+grad(uate)?s?|recent\s+grad(uate)?s?|university\s+(grad(uate)?|hire|recruiting)|campus\s+hire|graduate\s+(program|scheme|engineer)|early\s+career|rotational\s+(?:\w+\s+)?program|leadership\s+development\s+program|class\s+of\s+20\d\d)\b/i;

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
  // Graduation defaults to Alex's own date so every existing caller keeps
  // working; pass opts.gradDate to triage for someone else.
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
