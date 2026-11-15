// jarvis/salary-text.mjs — read a pay range out of a job description.
//
// Only Ashby publishes structured compensation. Everyone else writes the number
// into the description, so this file is the difference between a card that
// shows what a job pays and one that shows nothing.
//
// The formats are genuinely varied, all of these being real postings in the
// store, and every one of them was being DROPPED by the previous version:
//
//   Base Pay Range: $105,900.00 - $180,000.00 Annually        ← worked
//   The hourly range for this role is $33/hour - $36/hour     ← unit BETWEEN the bounds
//   pay range for this position is between $78,800 and $131,200   ← "and" as separator
//   The starting base pay is between $31/hr and $36/hr        ← both at once
//   The position pays $20/hr                                  ← no range at all
//   $92,720 - $139,080.00 CAD Annually
//   Annual Salary Range: $133,800.00-255,200.00 USD           ← 2nd bound has no $
//   <span>$104,000</span><span>&mdash;</span><span>$156,000 USD</span>
//
// The hard part is NOT the ranges, it is refusing numbers that look like pay:
//   "Following our $1.37B Series D at a $7.87B valuation…"
//   "$57,000 in annual material savings"     "401(k) match up to $5,000"
//   "5 to 7 years of experience"
// A funding round parsed as a salary is worse than no salary, because it
// silently ranks the job as if it paid millions.
//
// But the guard against those was itself too broad and was the biggest single
// cause of missing pay: it rejected any range with "401(k)" or "bonus" ANYWHERE
// in the surrounding 280 characters — which is where nearly every American
// posting puts its benefits sentence, immediately after the pay line. So the
// disqualifiers are now split by how catastrophic they are: corporate-finance
// words are fatal anywhere nearby, benefits words only within a few words of
// the number itself.

const MONEY = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kK])?`;

// Currency and rate wording that may sit BETWEEN the two bounds of a range.
// "$33/hour - $36/hour" is one range, not two numbers, and the old pattern —
// which allowed only whitespace before the dash — could not see it.
const UNIT = String.raw`(?:\s*(?:USD|CAD|EUR|GBP|AUD|SGD|INR|MXN|JPY)\b)?(?:\s*(?:\/\s*(?:hr|hour|yr|year|mo|month)\b|per\s+(?:hour|year|annum|month)\b|hourly\b|annually\b|an\s+hour\b|a\s+year\b))?`;

// "Min: $40,000 – Max: $80,000" (Boeing) names its upper bound.
const SEP = String.raw`\s*(?:-|–|—|to|through|and)\s*(?:max(?:imum)?\s*:?\s*)?`;

// Contexts that mean "this number is pay".
const PAY_WORD = /\b(salary|salaries|pay|paid|pays|compensation|base pay|base salary|hiring range|pay range|pay rate|wage|earnings|remuneration|per hour|hourly|annually|per year|\/\s?(?:hr|yr))\b/i;

// FATAL anywhere in the wide window: a corporate-finance figure misread as pay
// puts a job at the top of the deck for a number that was never a salary.
const NOT_PAY_WIDE = /\b(series\s+[a-f]\b|valuation|raised|funding round|venture|market cap|billion|trillion|\barr\b|\bmrr\b)\b/i;

// Disqualifying only when they LEAD INTO the number — "401(k) match up to
// $5,000", "an annual bonus of $9,000". Everything here is a thing a company
// pays that is not the salary, and it is always named before the figure.
// Etched (F-959): "Housing subsidy of $2,500 per month" was stored as the pay
// on every posting of its board, so the pay floor failed jobs paying $150k+.
const NOT_PAY_BEFORE = /\b(savings|saved|budget|grant|scholarship|tuition|reimburs\w*|401\s?\(?k\)?|bonus|sign[- ]?on|signing|referral|stipend|allowance|subsid(?:y|ies|ized)|per diem|award|prize|match(?:ing)?\s+up\s+to|discount|equity|revenue|cost)\b/i;

// Disqualifying when they TRAIL the number — "$57,000 in annual material
// savings". Deliberately excludes "bonus": "$120,000 - $150,000 plus bonus" is
// a real salary followed by a real extra, and rejecting it would throw away the
// pay line over a word that confirms it.
const NOT_PAY_AFTER = /\b(savings|saved|in\s+revenue|cost\s+(reduction|avoidance)|grant|scholarship|award|budget|per\s+unit)\b/i;

// What the numbers are counting, when they are not counting money.
const COUNTED_THING = /^\s*(?:\+\s*)?(years?|yrs?|months?|weeks?|days?|hours?\s+per|hrs|hs|employees|people|associates|staff|workers|team\s+members|direct\s+reports|accounts|customers|patients|units|parts|products|shipments|orders|deliveries|satellites|components|assemblies|sites|locations|miles?|square\s+feet|sq\.?\s?ft|lbs?|pounds|kg|tons?|psi|rpm|mm|cm|inches|volts?|watts?|amps?)\b/i;

// What follows a range that was never a pair of amounts (F-629): a share
// ("travel 10-15% of the time", "15-25% of plant revenue"), a third number
// ("09-22-2026", "(22-29-35-44"), a compound ("8–10-hour shift", "10–12-point
// font"), an ordinal ("September 10-11th") or the rest of a number grouped with
// spaces ("73 500 - 110 250 PLN"). Each of these was stored as hourly pay.
const SHARE_OR_ORDINAL_AFTER = /^(?:\s*(?:%|percent\b|per\s?cent\b)|(?:th|st|nd|rd)\b)/i;
// Only for small bare numbers, and only unspaced: "$78,918 - $128,242-Annually",
// "$100,000 - $120,000 - depending on experience" and Ecolab's
// "53,600.00 - 66,900.00 - 80,300.00" are all real pay.
const DATE_OR_COMPOUND_AFTER = /^[-–][\da-z]/i;

// A range written with no currency anywhere near it has only its neighbours to
// say it is pay. "Summary pay range: 33.32 – 61.01" qualifies; a travel share
// three sentences away from the word "compensation" does not.
const CURRENCY_MARK = /[$€£¥₹]|\b(?:USD|CAD|EUR|GBP|AUD|SGD|INR|MXN|JPY|PLN|CHF)\b/;
const RATE_IN_MATCH = /\/\s*(?:hr|hour|yr|year|mo|month)\b|\bper\s+(?:hour|year|annum|month)\b|\b(?:hourly|annually)\b/i;

// Anything ending in B/M right after the digits is a corporate figure, never a wage.
const SCALE_SUFFIX = /\d\s?(?:B|M|bn|mm)\b/;

const CURRENCIES = [
  [/\bCAD\b|\bC\$/i, 'CAD'], [/\bEUR\b|€/i, 'EUR'], [/\bGBP\b|£/i, 'GBP'],
  [/\bAUD\b/i, 'AUD'], [/\bSGD\b/i, 'SGD'], [/\bINR\b|₹/i, 'INR'],
  [/\bMXN\b/i, 'MXN'], [/\bJPY\b|¥/i, 'JPY'], [/\bUSD\b|\$/i, 'USD'],
];

const HOURS_PER_YEAR = 2080;
const MONTHS = 12;

// Plausibility gates, applied AFTER annualising.
const MIN_ANNUAL = 15_000;
const MAX_ANNUAL = 2_000_000;
const MAX_HOURLY = 500;
const MIN_HOURLY = 7;

function num(raw, kSuffix) {
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return kSuffix ? n * 1000 : n;
}

function currencyIn(window) {
  for (const [re, code] of CURRENCIES) if (re.test(window)) return code;
  return 'USD';
}

/**
 * Decide the pay period for a pair of raw values.
 * Explicit words win; otherwise magnitude decides — nobody is paid $45/year
 * and nobody earns $150,000/hour.
 */
function intervalFor(window, lo) {
  if (/\b(per hour|hourly|\/\s?hr|an hour|hour\b)/i.test(window)) return 'hour';
  if (/\b(per month|monthly|\/\s?mo)\b/i.test(window)) return 'month';
  if (/\b(annually|per year|per annum|\/\s?yr|a year|annual)\b/i.test(window)) return 'year';
  if (lo < 1000) return 'hour';   // "$42.01-63.01", "$22-24"
  return 'year';
}

/**
 * The period word NEAREST the range, from the sentence around it. The old
 * order (hour, then month, then year anywhere in 280 characters) read Hyundai's
 * "$75,400 - $104,000 annual base salary / Monthly vehicle lease allowance" as
 * monthly, and ~250 open rows showed twelve times their pay (F-959). Inside
 * the match, intervalFor still decides.
 */
const PERIOD_WORDS = [
  ['hour', /\b(?:per hour|hourly|an hour|hour)\b|\/\s?hr\b/gi],
  ['month', /\b(?:per month|monthly)\b|\/\s?mo\b/gi],
  ['year', /\b(?:annually|per year|per annum|a year|annual|yearly)\b|\/\s?yr\b/gi],
];
function nearestInterval(plain, at, end, lo) {
  const from = Math.max(0, at - 140);
  const window = plain.slice(from, end + 140);
  let best = null;
  for (const [interval, re] of PERIOD_WORDS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(window));) {
      const s = from + m.index, e = s + m[0].length;
      // After the range is read slightly closer: "$X - $Y annual base salary".
      const d = e <= at ? at - e + 1 : s >= end ? s - end : 0;
      if (!best || d < best.d) best = { interval, d };
    }
  }
  if (best) return best.interval;
  return lo < 1000 ? 'hour' : 'year';
}

function annualise(v, interval) {
  if (interval === 'hour') return v * HOURS_PER_YEAR;
  if (interval === 'month') return v * MONTHS;
  return v;
}

/** Tags but not their content, entities decoded enough to keep numbers adjacent. */
function plainText(text) {
  return text
    .replace(/&mdash;|&ndash;|&#x2014;|&#x2013;/gi, ' — ')
    .replace(/&nbsp;|&#xa0;|&#160;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * A candidate survives only if something says it is money: a currency marker
 * inside the match itself, or pay wording next to it. Without this the parser
 * reads "10 and 20 years of experience" as a $20,800–$41,600 range, because
 * both numbers annualise into a plausible band.
 */
function looksLikeMoney(matchText, window) {
  return /[$€£¥₹]/.test(matchText) || /\b(USD|CAD|EUR|GBP|AUD|SGD|INR|MXN|JPY)\b/.test(window) || PAY_WORD.test(window);
}

/**
 * A FIGURE IS JUDGED BY ITS OWN CLAUSE (F-959 review, 2026-11-03). A fixed
 * 55-character look-back crossed sentence breaks ("Per diem of $75. Salary
 * range $90,000 - $110,000" lost the salary) and read one figure's words onto
 * the next ("$5,000 monthly stipend plus $90,000 base"). The clause runs from
 * the last sentence end, bullet, semicolon, "plus", "and" or comma before the
 * figure to the next one after it.
 * `lead`: the clause before the figure. `trail`: the clause after it.
 */
const CLAUSE_BREAK = /[.!?;•\n](?=\s|$)|,(?=\s)|\s(?:plus|and|with)\s/gi;
function ownClause(plain, at, end) {
  const back = plain.slice(Math.max(0, at - 80), at);
  let cut = 0;
  for (const m of back.matchAll(CLAUSE_BREAK)) cut = m.index + m[0].length;
  const fwd = plain.slice(end, end + 60);
  const stop = fwd.search(CLAUSE_BREAK);
  return { lead: back.slice(cut), trail: stop < 0 ? fwd : fwd.slice(0, stop) };
}
// Named right after a figure (a period word may sit between): "$500 per month
// credit", "$5,000 - $6,000 monthly stipend", "$9,000 bonus". Not "$90k - $110k
// Housing subsidy" or "$94,900 - $135,600 Bonus eligible: No" (Cardinal
// Health), where a capital letter begins the next item. Case-sensitive on purpose.
const NOT_PAY_TRAIL = /^\s*(?:(?:per\s+)?(?:month|monthly|year|yearly|annual|hour|hourly|week|weekly)\s+)?(?:stipend|subsid(?:y|ies)|allowance|credit|per\s+diem|reimbursement|bonus(?:es)?|sign[- ]?on|relocation|award|grant|scholarship)\b/;
// A pay word in the figure's own clause, after any not-pay word: "•
// Relocation assistance Salary: $65k-$90k base" (CaptiveAire) is the salary.
const BASE_WORD = /\b(?:base|salary|salaries|pay|compensation|wage|hiring range|pay range|earnings|remuneration)\b/i;
// What NOT_PAY_BEFORE names, plus money for a place to live or a move.
const NOT_PAY_LEAD = new RegExp(`${NOT_PAY_BEFORE.source}|\\b(?:housing|relocation|rent|commut\\w*)\\b`, 'gi');
function notPayClause(lead, trail, sentenceLead = lead) {
  // A pay word in the figure's own clause, or earlier in its sentence with no
  // other amount between, keeps it (review): "Base salary with housing
  // subsidy: $90k - $110k". "Housing subsidy of $2,500 per month" names no
  // pay; "Base salary $120k plus housing subsidy of $2,500" has its own figure.
  const before = [...lead.matchAll(NOT_PAY_LEAD)].pop();
  const saysPay = BASE_WORD.test(lead) || (BASE_WORD.test(sentenceLead) && !/[$€£¥₹]\s?\d/.test(sentenceLead));
  if (before && !saysPay) return true;
  return NOT_PAY_TRAIL.test(trail);
}

function rejected(matchText, plain, at, end) {
  if (SCALE_SUFFIX.test(matchText)) return true;
  const wide = plain.slice(Math.max(0, at - 140), end + 140);
  if (NOT_PAY_WIDE.test(wide)) return true;
  const { lead, trail } = ownClause(plain, at, end);
  const back = plain.slice(Math.max(0, at - 120), at);
  const sentenceLead = back.slice(Math.max(...[...back.matchAll(/[.!?;•\n](?=\s|$)/g)].map((m) => m.index + 1), 0));
  if (notPayClause(lead, trail, sentenceLead)) return true;
  if (NOT_PAY_AFTER.test(plain.slice(end, end + 45))) return true;
  // What follows the number tells you what it counted.
  if (COUNTED_THING.test(plain.slice(end, end + 24))) return true;
  return false;
}

/** Does the figure's own clause call it pay? */
function ownClauseSaysPay(plain, at, end) {
  const { lead, trail } = ownClause(plain, at, end);
  return BASE_WORD.test(lead) || BASE_WORD.test(trail);
}

/**
 * A range's own edges: is this really two amounts, or a slice of something
 * else? Starting mid-number ("10,50 - 12,43" read from "50") or running on into
 * a share, a date or a compound word all mean it is not.
 */
function notAmounts(matchText, plain, at, end) {
  const lead = matchText.match(/^\s*/)[0].length;
  const start = at + lead;
  const body = matchText.slice(lead);
  // "Level 4 $162,350" and "Zone 1 $48.75" start at a currency sign, so the
  // number before them is a label, not the front of this one.
  if (!/^[$€£¥₹]/.test(body)) {
    // Glued to letters, a dash or a slash, it is a code or a date: "PDX170",
    // "HR-023-33", "8/6/26 - 8/30/26".
    if (/[\d.,A-Za-z\-/#]$/.test(plain.slice(Math.max(0, start - 1), start))) return true;
    if (/\d\s$/.test(plain.slice(Math.max(0, start - 2), start))) return true;
  }
  const after = plain.slice(end, end + 12);
  if (SHARE_OR_ORDINAL_AFTER.test(after)) return true;
  // "73 500 -110 250 PLN": the second bound is only the front of a number.
  if (/(?:^|[^\d,.])\d{1,3}$/.test(body.trimEnd()) && /^\s\d{3}\b/.test(after)) return true;
  const small = !CURRENCY_MARK.test(body) && !/\d,\d{3}|\d\s?[kK]\b/.test(body);
  if (small && DATE_OR_COMPOUND_AFTER.test(after)) return true;
  // "50 to 75 to 120+ satellites", "40–50+ homes": a plus makes it a count.
  if (small && /^\+/.test(after)) return true;
  // "shift premium for hours worked between 19.00 - 22.00" is a clock.
  if (/\bhours\s+(?:worked\s+)?between\s*$/i.test(plain.slice(Math.max(0, start - 40), start))) return true;
  return false;
}

// Range wording that names pay without one of PAY_WORD's words:
// "The United States base range for this position is 164,448 - 234,926".
const RANGE_WORD = /\b(?:base|hiring|target|salary|starting)\s+range\b|\bOTE\b/i;

/**
 * A bare range needs a currency, a rate, or pay wording right beside it —
 * 80 characters before, or a pay noun within 25 after ("48k - 50k (DOE)
 * yearly salary"). Only a noun after: "200,000 shipments annually" is a count.
 */
function saysPayNearby(matchText, plain, at, end) {
  if (CURRENCY_MARK.test(matchText) || RATE_IN_MATCH.test(matchText)) return true;
  if (CURRENCY_MARK.test(plain.slice(Math.max(0, at - 15), at))) return true;
  const before = plain.slice(Math.max(0, at - 80), at);
  if (PAY_WORD.test(before) || RANGE_WORD.test(before)) return true;
  return /\b(salary|pay|compensation|wages?)\b/i.test(plain.slice(end, end + 25));
}

// "between 19.02 - 25.36 - 31.69 USD" and "53,600.00 - 66,900.00 - 80,300.00"
// are minimum, midpoint and maximum; the range is the outer two.
const THIRD_BOUND = new RegExp(String.raw`^${SEP}${MONEY}`, 'i');

/**
 * Extract an annualised pay range from free text.
 *
 * `min`/`max` are always annualised so the store can sort and filter on one
 * scale, and `interval` + `rate` carry the number as the posting actually
 * stated it — an hourly job should read "$34/hr", not a computed "$71k".
 *
 * @returns {{min:number,max:number,currency:string,interval:string,rate:{min:number,max:number},source:'description',raw:string}|null}
 */
export function parseSalaryFromText(text) {
  if (!text || typeof text !== 'string') return null;
  // Strip tags but keep the separators — several ATSs wrap each bound in its
  // own <span>, so the two numbers are only adjacent once the markup is gone.
  const plain = plainText(text);
  const candidates = [];

  const rangeRe = new RegExp(`${MONEY}${UNIT}${SEP}${MONEY}${UNIT}`, 'gid');
  for (let m; (m = rangeRe.exec(plain));) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const window = plain.slice(Math.max(0, at - 140), end + 140);
    if (!looksLikeMoney(m[0], window)) continue;
    if (rejected(m[0], plain, at, end)) continue;
    if (notAmounts(m[0], plain, at, end) || !saysPayNearby(m[0], plain, at, end)) {
      // The second bound may open the real range: "USA, OR, PDX170 - 30.00 -
      // 54.00 USD hourly" is refused as 170-30, and 30.00-54.00 is the pay.
      rangeRe.lastIndex = m.indices[3][0];
      continue;
    }

    let lo = num(m[1], m[2]);
    let hi = num(m[3], m[4]);
    if (lo == null || hi == null) continue;
    if (hi < lo) [lo, hi] = [hi, lo];
    let raw = m[0];
    const third = plain.slice(end, end + 40).match(THIRD_BOUND);
    if (third) {
      const top = num(third[1], third[2]);
      if (top != null && top > hi && top <= hi * 2) { hi = top; raw += third[0]; }
    }

    // The interval is read from the match FIRST — "$33/hour - $36/hour" states
    // it twice inside itself — and only then from the wider sentence.
    const fromMatch = intervalFor(m[0], lo);
    let interval = (fromMatch === 'year' && !/\/|per|hour|annual/i.test(m[0]))
      ? nearestInterval(plain, at, end, lo)
      : fromMatch;
    // The surrounding sentence is WEAKER evidence than the numbers themselves.
    // "This is a full-time, 40 hour per week position. The salary range for this
    // role is $95,000 - $120,000" puts the word "hour" inside the ±140-character
    // window, which flipped the interval to hourly and then discarded the whole
    // range as an impossible hourly rate — the posting showed no pay at all.
    // "24-hour operations" and "on-call hours" do the same thing. When a
    // window-derived interval cannot hold these magnitudes, believe the
    // magnitudes and fall back to inferring from them.
    if (interval !== fromMatch && interval === 'hour' && (lo < MIN_HOURLY || hi > MAX_HOURLY)) {
      interval = lo < 1000 ? 'hour' : 'year';
    }
    // The same for "per month" borrowed from a benefits line beside it
    // (Etched's housing subsidy): $250,000 a month is not a wage, and a range
    // starting at $20,000 with no period of its own is a year's pay.
    if (interval !== fromMatch && interval === 'month' && lo >= 20_000) {
      interval = lo < 1000 ? 'hour' : 'year';
    }
    if (interval === 'hour' && (lo < MIN_HOURLY || hi > MAX_HOURLY)) continue;

    const min = annualise(lo, interval);
    const max = annualise(hi, interval);
    if (min < MIN_ANNUAL || max > MAX_ANNUAL) continue;
    // A "range" spanning more than 6x is not one range; it is two unrelated
    // numbers that happened to sit either side of a dash.
    if (max > min * 6) continue;

    candidates.push({
      min, max, currency: currencyIn(window), interval,
      rate: { min: lo, max: hi },
      source: 'description', raw: raw.trim(),
      // A range sitting next to the words "salary"/"pay range" is far more
      // trustworthy than two bare numbers, so it wins ties.
      // Its own clause naming it pay beats pay words merely nearby (F-959 review).
      confident: ownClauseSaysPay(plain, at, end) ? 2 : PAY_WORD.test(window) ? 1 : 0,
    });
  }

  if (candidates.length) {
    const top = Math.max(...candidates.map(c => c.confident));
    const confident = candidates.filter(c => c.confident === top && top > 0);
    const pool = confident.length ? confident : candidates;
    // Widest plausible range wins: postings often quote a narrow location-
    // specific band first and the full band later.
    pool.sort((a, b) => (b.max - b.min) - (a.max - a.min));
    const { confident: _drop, ...best } = pool[0];
    return best;
  }

  // No range anywhere. A single stated rate is still compensation data, and
  // refusing to read it is why a posting that says "This position pays $20/hr"
  // showed no pay at all. It needs a currency symbol AND an explicit period,
  // so a lone "$5,000" in a benefits sentence can never qualify.
  const singleRe = new RegExp(
    String.raw`[$€£¥₹]\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kK])?(?:\s*(?:USD|CAD|EUR|GBP|AUD))?\s*(?:\/\s*(hr|hour|yr|year|mo|month)\b|per\s+(hour|year|annum|month)\b|(hourly|annually)\b)`,
    'gi',
  );
  const singles = [];
  for (const m of plain.matchAll(singleRe)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const window = plain.slice(Math.max(0, at - 140), end + 140);
    if (rejected(m[0], plain, at, end)) continue;
    const v = num(m[1], m[2]);
    if (v == null) continue;
    const interval = intervalFor(m[0], v);
    if (interval === 'hour' && (v < MIN_HOURLY || v > MAX_HOURLY)) continue;
    const annual = annualise(v, interval);
    if (annual < MIN_ANNUAL || annual > MAX_ANNUAL) continue;
    singles.push({
      min: annual, max: annual, currency: currencyIn(window), interval,
      rate: { min: v, max: v }, source: 'description', raw: m[0].trim(),
    });
  }
  // A LONE ANNUAL FIGURE ITS OWN CLAUSE CALLS PAY: "$5,000 monthly stipend
  // plus $90,000 base" (F-959 review). No period word is needed when the
  // clause says base/salary and the figure is a year's pay in size.
  // Labelled pairs the range pattern cannot see are spanned: "Minimum Salary:
  // $ 71500 Maximum Salary: $ 135800" (Boston Scientific), "Pay Range Max USD
  // $115,336.00 Pay Range Min USD $69,909.00" (CDM Smith), "between ($75,000)
  // and ($112,800)" (Boehringer). Figures within one passage of the first.
  if (!singles.length) {
    const found = [];
    for (const m of plain.matchAll(/[$€£¥₹]\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kK])?\b/g)) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      const v = num(m[1], m[2]);
      if (v == null || v < 20_000 || v > MAX_ANNUAL) continue;
      // One end of a range the range pass already turned down is not a lone figure.
      if (/^\s*(?:-|–|—|to|through|and)\s*[$€£¥₹\d]/i.test(plain.slice(end, end + 12))
        || /[\d$kK]\s*(?:-|–|—|to|through|and)\s*$/i.test(plain.slice(Math.max(0, at - 12), at))) continue;
      if (rejected(m[0], plain, at, end)) continue;
      if (found.length && at - found[0].at > 300) break;
      // The first figure must be called pay by its own clause; one after it in
      // the same sentence belongs to it ("between ($75,000) and ($112,800)").
      const sameSentence = found.length && !/[.!?](?=\s)/.test(plain.slice(found[found.length - 1].at, at));
      if (!ownClauseSaysPay(plain, at, end) && !sameSentence) continue;
      found.push({ at, v, raw: m[0].trim(), window: plain.slice(Math.max(0, at - 140), end + 140) });
    }
    if (found.length) {
      const lo = Math.min(...found.map((f) => f.v));
      const near = found.filter((f) => f.v <= lo * 3);
      const hi = Math.max(...near.map((f) => f.v));
      singles.push({ min: lo, max: hi, currency: currencyIn(found[0].window), interval: 'year', rate: { min: lo, max: hi }, source: 'description', raw: near.map((f) => f.raw).slice(0, 2).join(' … ') });
    }
  }
  if (!singles.length) return null;
  // Two lone rates in one posting are usually a floor and a ceiling written in
  // separate sentences ("starts at $30/hr" … "up to $38/hr"). Span them.
  if (singles.length > 1) {
    const sameUnit = singles.filter(s => s.interval === singles[0].interval);
    const lo = Math.min(...sameUnit.map(s => s.min));
    const hi = Math.max(...sameUnit.map(s => s.max));
    if (hi <= lo * 6) {
      const first = sameUnit[0];
      return {
        min: lo, max: hi, currency: first.currency, interval: first.interval,
        rate: { min: Math.min(...sameUnit.map(s => s.rate.min)), max: Math.max(...sameUnit.map(s => s.rate.max)) },
        source: 'description', raw: sameUnit.map(s => s.raw).slice(0, 2).join(' … '),
      };
    }
  }
  return singles[0];
}

/**
 * Structured compensation from the ATS always wins; text is the fallback.
 * Returns the salary object to store, or null.
 */
export function resolveSalary(job) {
  const stored = job?.salary;
  const hasStored = stored && Number.isFinite(stored.max);

  // A figure the ATS gave us is authoritative: it came out of a structured
  // field, not out of reading prose, so the text parser must never overwrite it.
  if (hasStored && stored.source !== 'description') return stored;

  // Anything THIS module parsed is re-derivable, and has to be re-derived
  // rather than trusted. The old rule short-circuited on any stored value,
  // which quietly made rescore.mjs incapable of ever correcting pay: an Amcor
  // req kept showing $465k-$651k a/yr from the bare digits "224-313" in a
  // sentence about project budgets, and 4,400 KLA-style rows kept displaying
  // "$52k-$89k" for postings that say "$25.15 - $42.75 Per Hour" — the exact
  // thing the interval/rate fields exist to prevent. A cached verdict from an
  // older parser is not evidence; the posting text is.
  const desc = job?.description || '';
  if (!desc) return hasStored ? stored : null;   // nothing to re-read — keep it
  return parseSalaryFromText(desc);
}
