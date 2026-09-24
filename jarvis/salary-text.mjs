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

const SEP = String.raw`\s*(?:-|–|—|to|through|and)\s*`;

// Contexts that mean "this number is pay".
const PAY_WORD = /\b(salary|salaries|pay|paid|pays|compensation|base pay|base salary|hiring range|pay range|pay rate|wage|earnings|remuneration|per hour|hourly|annually|per year|\/\s?(?:hr|yr))\b/i;

// FATAL anywhere in the wide window: a corporate-finance figure misread as pay
// puts a job at the top of the deck for a number that was never a salary.
const NOT_PAY_WIDE = /\b(series\s+[a-f]\b|valuation|raised|funding round|venture|market cap|billion|trillion|\barr\b|\bmrr\b)\b/i;

// Disqualifying only when they LEAD INTO the number — "401(k) match up to
// $5,000", "an annual bonus of $9,000". Everything here is a thing a company
// pays that is not the salary, and it is always named before the figure.
const NOT_PAY_BEFORE = /\b(savings|saved|budget|grant|scholarship|tuition|reimburs\w*|401\s?\(?k\)?|bonus|sign[- ]?on|signing|referral|stipend|allowance|per diem|award|prize|match(?:ing)?\s+up\s+to|discount|equity|revenue|cost)\b/i;

// Disqualifying when they TRAIL the number — "$57,000 in annual material
// savings". Deliberately excludes "bonus": "$120,000 - $150,000 plus bonus" is
// a real salary followed by a real extra, and rejecting it would throw away the
// pay line over a word that confirms it.
const NOT_PAY_AFTER = /\b(savings|saved|in\s+revenue|cost\s+(reduction|avoidance)|grant|scholarship|award|budget|per\s+unit)\b/i;

// What the numbers are counting, when they are not counting money.
const COUNTED_THING = /^\s*(?:\+\s*)?(years?|yrs?|months?|weeks?|days?|hours?\s+per|employees|people|customers|patients|units|parts|products|sites|locations|square\s+feet|sq\.?\s?ft|lbs?|pounds|kg|tons?|psi|rpm|mm|cm|inches|volts?|watts?|amps?)\b/i;

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

function rejected(matchText, plain, at, end) {
  if (SCALE_SUFFIX.test(matchText)) return true;
  const wide = plain.slice(Math.max(0, at - 140), end + 140);
  if (NOT_PAY_WIDE.test(wide)) return true;
  // A few words either side, not a whole paragraph — the paragraph is where
  // every posting keeps its benefits sentence.
  if (NOT_PAY_BEFORE.test(plain.slice(Math.max(0, at - 55), at))) return true;
  if (NOT_PAY_AFTER.test(plain.slice(end, end + 45))) return true;
  // What follows the number tells you what it counted.
  if (COUNTED_THING.test(plain.slice(end, end + 24))) return true;
  return false;
}

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

  const rangeRe = new RegExp(`${MONEY}${UNIT}${SEP}${MONEY}${UNIT}`, 'gi');
  for (const m of plain.matchAll(rangeRe)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const window = plain.slice(Math.max(0, at - 140), end + 140);
    if (!looksLikeMoney(m[0], window)) continue;
    if (rejected(m[0], plain, at, end)) continue;

    let lo = num(m[1], m[2]);
    let hi = num(m[3], m[4]);
    if (lo == null || hi == null) continue;
    if (hi < lo) [lo, hi] = [hi, lo];

    // The interval is read from the match FIRST — "$33/hour - $36/hour" states
    // it twice inside itself — and only then from the wider sentence.
    const fromMatch = intervalFor(m[0], lo);
    let interval = (fromMatch === 'year' && !/\/|per|hour|annual/i.test(m[0]))
      ? intervalFor(window, lo)
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
      source: 'description', raw: m[0].trim(),
      // A range sitting next to the words "salary"/"pay range" is far more
      // trustworthy than two bare numbers, so it wins ties.
      confident: PAY_WORD.test(window),
    });
  }

  if (candidates.length) {
    const confident = candidates.filter(c => c.confident);
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
