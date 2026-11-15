// jarvis/requirements.mjs — how a posting states what it requires.
//
// ONE READER for two questions three screens ask:
//   · which section is this line in — required, preferred, or neither?
//     (degree.mjs, triage.mjs, prescreen.mjs)
//   · where does the posting ask for a number of years, and how many?
//     (triage.mjs classifyExperience, prescreen.mjs yearsBar)
// Each screen used to carry its own copy, and the copies disagreed: triage
// handled "roadmaps for 5+ years" and "graduated within the last 2 years",
// prescreen relearnt neither, and only degree.mjs knew that "Qualifications
// (Preferred):" opens a preferred section (F-724). A fix made here reaches all
// three. What each screen DOES with the answer stays its own — prescreen drops
// a posting unread, so it asks more of a line than triage does before acting.

// ── sections ──────────────────────────────────────────────────────────

// A heading with any of these words opens a preferred section, wherever the
// word sits in it: "Preferred Qualifications", "Qualifications (Preferred)",
// "Qualifications - Nice to have", "Bonus points".
const PREFERRED_HEAD_RE = /\b(?:preferred|preferences|desired|desirable|bonus|nice[- ]to[- ]haves?|good[- ]to[- ]haves?|plus(?:es)?|extra credit|stand out|sets? you apart|even better|ideal(?:ly)?)\b/i;
const REQUIRED_HEAD_RE = /\b(?:required|requirements?|minimum|basic|must[- ]haves?|qualifications|essentials?|you will have|what you(?:'|’)ll need|what we need|need to see|looking for|who you are|about you|what you bring|you(?:'|’)ll bring|you have|your (?:background|experience|skills)|(?:skills|knowledge) (?:and|&) experience|experience (?:and|&) (?:skills|qualifications))\b/i;
// Headings over the company talking about itself or its offer. Not proof that
// a figure under it is no ask: Amazon stores its qualification bullets below
// "About AWS" with no heading between.
const ABOUT_HEAD_RE = /\b(?:about (?:us|the company|[A-Z][\w&.-]*)|who we are|our (?:company|story|mission|culture|values)|benefits|perks|compensation|pay range|salary|why join|life at|equal (?:employment )?opportunity)\b/i;
// Headings that end a requirements block without opening another.
const OTHER_HEAD_RE = /\b(?:responsibilities|duties|what you(?:'|’)ll do|about (?:the|this) (?:role|team|job|position)|the role|overview|description)\b/i;
// "Master's degree preferred" is an inline preference on a line of its own,
// not a heading over the lines after it.
const TRAILING_PREF_RE = /\b(?:preferred|desired|a plus)\.?\s*$/i;
const BULLET_LEAD_RE = /^\s*(?:[•*·|>–—-]|o\s|\d+[.)])\s*/;
const LABEL_RE = /([A-Za-z][A-Za-z'’ ()/&-]{2,60})[:：]/g;

// "Preferences And Requirements", "Required & Preferred Qualifications": one
// heading over both kinds says nothing about any line under it. "Preferred
// Requirements" is one kind — preferred.
const PREF_W = String.raw`(?:preferred|preferences|desired|nice[- ]to[- ]haves?)`;
const REQ_W = String.raw`(?:required|requirements?|minimum|basic|must[- ]haves?)`;
const MIXED_HEAD_RE = new RegExp(String.raw`\b${PREF_W}\s*(?:and|&|\/|,)\s*${REQ_W}\b|\b${REQ_W}\s*(?:and|&|\/|,)\s*${PREF_W}\b`, 'i');

/** What a heading line opens: 'pref', 'req', 'mixed', 'other', 'about', or null when it is no heading. */
export function headingKind(raw) {
  const bulleted = BULLET_LEAD_RE.test(raw);
  const line = String(raw || '').replace(BULLET_LEAD_RE, '').trim();
  if (!line || line.length > 70) return null;
  const colon = /[:：]$/.test(line);
  const words = line.split(/\s+/).length;
  if (!(colon || (!bulleted && words <= 6 && !/[.,;]$/.test(line)))) return null;
  return labelKind(line, colon) ?? (colon ? 'other' : null);   // null: not a heading we know, keep looking up
}

function labelKind(label, colon = true) {
  if (MIXED_HEAD_RE.test(label)) return 'mixed';
  // A short line ending "… preferred" with no colon is a plain-text bullet.
  if (!colon && TRAILING_PREF_RE.test(label) && !/^\W*(?:preferred|desired|bonus|nice)/i.test(label)) return null;
  if (PREFERRED_HEAD_RE.test(label)) return 'pref';
  if (REQUIRED_HEAD_RE.test(label)) return 'req';
  if (OTHER_HEAD_RE.test(label)) return 'other';
  if (ABOUT_HEAD_RE.test(label)) return 'about';
  return null;
}

/**
 * The section `index` sits in: 'pref', 'req', 'about' (the company's own
 * blurb or offer), 'other' (under a heading that is none of those), or '' (no
 * heading above it, or one over both kinds).
 */
export function sectionAt(text, index) {
  const src = String(text || '');
  const before = src.slice(Math.max(0, index - 2500), index);
  const lines = before.split(/\r?\n/);
  const own = lines.pop();   // the line the requirement itself is on
  // "…BS in ME. Preferred Qualifications: 5+ years …" — a label on the same
  // line, before the figure. A label that is neither ("Experience: 3–7 years")
  // says nothing about the section, so the lines above decide.
  const inline = [...String(own).matchAll(new RegExp(LABEL_RE.source, 'g'))].pop();
  if (inline) {
    const k = labelKind(inline[1]);
    if (k) return k === 'mixed' ? '' : k;
  }
  if (lines.length) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const k = headingKind(lines[i]);
      if (k) return k === 'mixed' ? '' : k;
    }
    return '';
  }
  // Flattened body, no line breaks to read: the last "Label:" before it.
  let last = null, m;
  const re = new RegExp(LABEL_RE.source, 'g');
  while ((m = re.exec(before)) !== null) last = m[1];
  const k = last ? labelKind(last) ?? 'other' : '';
  return k === 'mixed' ? '' : k;
}

/** Is `index` under a preferred / nice-to-have heading? */
export const underPreferredHeading = (text, index) => sectionAt(text, index) === 'pref';

// ── years ─────────────────────────────────────────────────────────────

// "zero to two years" (Yaskawa, F-959) is a range from zero, so zero is a number too.
const WORD_NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export const toYears = (s) => (/^\d+$/.test(String(s)) ? Number(s) : WORD_NUM[String(s).toLowerCase()] ?? NaN);
const NUM = String.raw`(?:\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*\(\d{1,2}\))?`;

// F-466. A number of years is a requirement when it is written like one. The
// first number is the FLOOR: "3+ years", "3-5 years", "minimum 3 years" and
// "Three (3) or more years" all require three. The trailing "+" is allowed on
// both ends — Zipline writes "a minimum of 2-15+ years".
const YEARS_NUM = String.raw`\b(${NUM})\s*(?:\+|\s+plus)?\s*(?:(?:-|–|—|to)\s*${NUM}\s*\+?\s*)?(?:or\s+more\s+)?(?:years?|yrs?)`;
const YEARS_PATTERNS = [
  // 1. A figure and the word experience in the same sentence.
  //    Not across a line break: "must be 18 years or older\n- 2+ years of …
  //    experience" is two lines, and one match over both hid the second.
  new RegExp(`${YEARS_NUM}\\b[^.\\n]*?(?:experience|exp\\b|expertise|knowledge)`, 'i'),
  // 2. The figure carries its own object: "5+ years with a Bachelor's",
  //    "4+ years in electronics manufacturing", "2 to 5 years in hardware test".
  //    "program" is deliberately NOT here: "During this 2 year program" is
  //    Viavi's rotational scheme, a req written for exactly him.
  //    Any doing-word counts: "3+ years launching complex electro-mechanical
  //    products", "5+ years writing and shipping production software".
  new RegExp(`${YEARS_NUM}['’]?(?:\\s+or\\s+more)?\\s*\\)?\\s+(?:of|in|with|as|hands[- ]on|\\w{3,}ing|develop\\w*|design\\w*|support\\w*|integrat\\w*|lead\\w*|manag\\w*)\\b`, 'i'),
  //    …or stands in brackets after the work: "…first-author publications
  //    (5+ years)", "shipping embedded systems (around 10+ years)".
  new RegExp(`\\(\\s*(?:around|approximately|approx\\.?|about|~|min\\.?|minimum(?:\\s+of)?|at\\s+least)?\\s*${YEARS_NUM}\\s*\\)`, 'i'),
  // 3. Reversed: "Experience: 3–7 years", "Experience - 5 to 8 Yrs",
  //    "Experience Level: 5-10 Years", "related work experience of 5 years".
  new RegExp(`(?:experience|exp)\\b(?:\\s+(?:level|required|requirements?|needed))?\\s*[:\\-–—(,]?\\s*(?:of\\s+)?${YEARS_NUM}`, 'i'),
  // 4. A floor in words: "minimum of 2 years", "at least 3 years".
  new RegExp(`(?:minimum(?:\\s+of)?|at\\s+least|requires?)\\s+${YEARS_NUM}`, 'i'),
  // 5. …or after the figure: "Three (3) years minimum", "2 years required".
  new RegExp(`${YEARS_NUM}\\s+(?:minimum|min\\b|required)`, 'i'),
  // 6. A degree plus years: "BS + 6yrs or MS + 4yrs or PhD + 2yr in EE/CS",
  //    "Bachelor's with 5 years".
  new RegExp(`\\b(?:B\\.?S\\.?|M\\.?S\\.?|Ph\\.?D\\.?|bachelor\\w*|master\\w*|degree)\\s*(?:\\+|plus|and|with)\\s*${YEARS_NUM}`, 'i'),
];

// A number of years next to a noun that is not a requirement:
//   Viavi  "During this 2 year program you will…"      — a rotation he wants
//   Micron "strategic roadmaps for 5+ years in post probe wafer…" — a horizon
//   Zebra  "…a 4 year degree"                          — the degree, not a bar
// Read from the word "years" on, so "3+ years of programming" is no program.
// "…ten years of it yet" is about the field, not about him.
// Bunge (2026-10-20): a paid-time-off table, "0 – 9 years: 25 days", read as a
// range from zero and filed over a required 6-9 years.
const NOT_A_REQUIREMENT_AFTER = /^\W{0,3}(?:\d+\s*(?:days?|hours?|weeks?)|(?:of\s+)?(?:PTO|vacation|paid\s+time)|of (?:it|this|that|them|us|our)\b|programs?|degrees?|school|university|college|courses?|rotations?|contracts?(?!\s+(?:management|manufactur\w*|negotiat\w*|administration|engineering))|warrant(?:y|ies)|roadmaps?|plans?|leases?|old|age|running|in a row|of (?:growth|history|operation|excellence|innovation)|of service(?=\s*(?:[.,;)]|$|\s+(?:with|at|to|for|in|plus|and)\b)))\b/i;
// "…who graduated within the last 2 years" is new-grad INCLUSION (Medtronic, fit 94).
const RECENCY_BEFORE = /\b(?:with)?in\s+the\s+(?:last|past|previous)\s*$|\bgraduated\s+(?:with)?in\s+the\s+\w+\s*$/i;
// "Base Pay Range: $117,800.00 - $200,300.00" must not lend a digit to a match.
const PAY_BEFORE = /\$[\d,.]+\s*(?:-|–|—|to)?\s*[\d,.]*\s*$/;
// A span the ROLE looks ahead over ("roadmaps for 5+ years in …"), kept narrow:
// a looser rule that swallowed a bare "over" would skip "over 5 years of
// experience", which IS a bar.
const HORIZON_BEFORE = /\b(?:roadmaps?|horizons?|forecasts?|strateg(?:y|ies|ic)|visions?|outlooks?|pipelines?|planning)\b[^.\n]{0,20}$|\b(?:over|for|in|within)\s+the\s+next\s+$/i;

// "Nobody has ten years of it yet", "no one has 5 years in this": not an ask.
const NEGATED_BEFORE = /\b(?:nobody|no one|no-one|none of us)\b[^.\n]{0,30}$/i;
// A CEILING IS A RANGE THAT STARTS AT ZERO (F-766). Valmont's "Up to 3 years of
// experience in manufacturing engineering/machine design required" on "This
// entry-level role" was stored as a 3-year floor; Honda's "recent graduates or
// those with up to 2 years" as a 2-year one. The floor of "up to N" is zero.
// "No less than 3 years" is a floor, so it is not one of these.
const CEILING_BEFORE = /\b(?:up\s+to|no\s+more\s+than|not\s+more\s+than|(?<!\b(?:no|not)\s+)(?:less|fewer)\s+than|maximum\s+of|max\.?\s+of)\s*$/i;

function isRequirementYears(text, m) {
  const [num, numEnd] = m.indices[1];
  const word = /years?|yrs?/i.exec(text.slice(numEnd, m.index + m[0].length));
  const from = word ? numEnd + word.index + word[0].length : m.index + m[0].length;
  const after = text.slice(from, from + 48);
  const before = text.slice(Math.max(0, num - 60), num);
  return !NOT_A_REQUIREMENT_AFTER.test(after) && !RECENCY_BEFORE.test(before)
    && !PAY_BEFORE.test(before) && !HORIZON_BEFORE.test(before) && !NEGATED_BEFORE.test(before);
}

/**
 * Every place `text` asks for years, in order: `{ at, end, n, section }`.
 * `n` is the floor of the ask. Over 15 is company history ("KLA has 40 years
 * of experience in…") and left out; zero is kept, because "0-2 years" is how
 * the reqs written for him say so.
 *
 * One phrase read by two patterns is one requirement, at its floor: Zipline's
 * "a minimum of 2-15+ years" is matched at the 2 and at the 15, and the
 * earliest match wins its span — the one that starts at the floor.
 */
export function yearsMentions(text) {
  const src = String(text || '');
  const hits = [];
  for (const yre of YEARS_PATTERNS) {
    const re = new RegExp(yre.source, 'gid');
    let m;
    while ((m = re.exec(src)) !== null) {
      let n = toYears(m[1].replace(/\s*\(.*$/, ''));
      if (Number.isNaN(n) || n > 15 || !isRequirementYears(src, m)) continue;
      // …but "up to 8-15 years" names its own range, and its floor is the 8.
      const ranged = new RegExp(String.raw`^${NUM}\s*\+?\s*(?:-|–|—|to)\s*${NUM}`, 'i').test(src.slice(m.indices[1][0]));
      if (!ranged && CEILING_BEFORE.test(src.slice(Math.max(0, m.indices[1][0] - 24), m.indices[1][0]))) n = 0;
      // Anchored at the NUMBER: "Required Experience\n\n3+ years in …" matches
      // from the heading, but the requirement is the line the figure is on.
      hits.push({ at: m.indices[1][0], end: m.index + m[0].length, n });
    }
  }
  hits.sort((a, b) => a.at - b.at || a.n - b.n);
  const kept = [];
  for (const h of hits) if (!kept.some((k) => h.at < k.end && k.at < h.end)) kept.push(h);
  return kept.map((h) => ({ ...h, section: sectionAt(src, h.at) }));
}
