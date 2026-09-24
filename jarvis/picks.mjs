// jarvis/picks.mjs — turn 150,000 postings into ~40 worth reading.
//
// The store holds 166k jobs and 7,400 of them score 70+. That is not a
// shortlist, it is a second haystack, and he has said so: "i just feel like i
// have to sift thru too much."
//
// This is the machine half of /jarvis-picks. It screens, de-duplicates and caps,
// then scores every survivor on TWO axes that the store does not already
// combine:
//
//   FIT          would he want it — the existing fit engine's answer, adjusted
//                for the handful of things it does not weigh (his salary floor,
//                whether the work is hands-on).
//   WINNABILITY  would he GET it — new-grad framing, sponsorship history,
//                how long the posting has been up, how much experience it asks
//                for. This axis did not exist anywhere before.
//
// It deliberately does NOT pick. Ranking is arithmetic and the arithmetic is
// visible here; choosing which ten a person should spend a week of attention on
// means reading the descriptions, and that is the skill's job.
//
// Usage:  node jarvis/picks.mjs [--limit 40] [--json] [--days 60] [--min-fit 70]

import { openDb, readDescription, getDictionary } from './db.mjs';
import { eligibility } from './eligibility.mjs';
import { loadPrefs, applyPrefs } from './prefs.mjs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DB_PATH = path.join(HERE, '..', 'data', 'jarvis', 'jobs.db');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

/**
 * Everything that is machine-disqualifiable, disqualified before any judgment
 * is spent on it — the shape /jarvis-longs uses, for the same reason: research
 * spent on a candidate that was never eligible is research not spent on one
 * that was.
 *
 * `f_hard_block` already carries the visa work (no_sponsorship, us_person,
 * clearance, perm_authorization, us_citizen — 130k of the store). It is the
 * single most important clause here and it is not negotiable: a role he cannot
 * legally hold is not a near miss, it is noise.
 */
const SCREEN = `
  gone_at IS NULL
  AND status = 'new'
  AND f_hard_block = 0
  -- THE COLUMN THAT CARRIES HIS OWN RULES.
  --
  -- fit.mjs runs applyPrefs() and writes the verdict here. "Structural Analyst
  -- - Aerospace & Defense" was fit_blocked = 1 with the reason recorded as
  -- 'Breaks your rule "never defense"' — and scored exactly 70, so it cleared
  -- the fit threshold while the one column that had already refused it was
  -- never consulted. f_hard_block covers the visa classifiers only.
  AND fit_blocked = 0
  AND f_senior = 0
  AND fit_score >= @minFit
  -- FULL-TIME NEW GRAD, NOT INTERNSHIPS.
  --
  -- His own rules said so and this screen did not read them. preferences.md:
  -- "He needs a full-time new-grad role", and a rule excluding co-op in the
  -- title. isDeck() has dropped internships all along. Five of the first
  -- thirteen curated picks were internships regardless, which is the same
  -- failure as the Master's roles one layer up: a screen optimised for
  -- eligibility while ignoring what he actually wants.
  --
  -- Pass --interns to put them back, for the case he asks for one.
  -- NEW-GRAD LANGUAGE IS NOT THE ONLY WAY A REQ IS FOR HIM (F-309).
  --
  -- f_newgrad fires on new-grad wording in the TITLE. The reqs he is most
  -- eligible for say "0+ years" or "College Grad" in the body: Intel College
  -- Grad reqs, Stryker "minimum 0 years", Lam "graduate eligible", a Zebra req
  -- that "is expected to start in Summer 2027". Measured 2026-09-03: the
  -- column alone left 95 rows and five picks from two employers; reading the
  -- wider screen produced 30 he could apply to, and not one carried
  -- f_newgrad = 1. So: new-grad wording, OR a non-internship asking for at
  -- most two years (or no stated years). Internships stay excluded.
  AND (f_newgrad = 1 OR (f_intern = 0 AND (level_years IS NULL OR level_years <= 2)) @internClause)
  -- A GRADUATION WINDOW HE FALLS OUTSIDE OF IS A BAR, NOT A PREFERENCE (F-467).
  --
  -- Applied Intuition "Mechanical Engineer - New Grad" — "open to candidates
  -- who graduated in summer 2026 or will graduate by the end of 2026" — ranked
  -- 99 fit / 89 winnability and sat near the top of a curated list. He
  -- graduates May 2027. triage() had already read that sentence and set
  -- f_grad_mismatch = 1; this screen simply never asked. Seven such rows were
  -- still admissible on 2026-09-17.
  --
  -- This is f_grad_mismatch, not the window itself: the flag is only set when
  -- the posting states a window AND his graduation falls outside it. Silence is
  -- not a restriction, and a posting with no window stays in.
  --
  -- Pass --grad-anyway to put them back, the same way --interns does.
  AND (f_grad_mismatch = 0 @gradClause)
  AND has_desc = 1
  -- Read in full and rejected once already. The reason is on the row.
  AND (pick_note IS NULL OR pick_note NOT LIKE 'Not curated%')
  AND (posted_at IS NULL OR posted_at >= date('now', @window))
`;

// WHERE IS THIS, AND WHAT IF THE STORE DOES NOT SAY.
//
// The store's own `location_bucket` is the primary answer and is consulted
// first in rank(). This is the fallback for the rows it bucketed 'unknown',
// and for the country named in a TITLE, which triage does not read.
//
// Full state names are matched case-insensitively. The two-letter codes are
// matched case-SENSITIVELY on purpose: with /i, "in", "or", "me", "ok", "hi",
// "de" and "la" all become states, and "Markham, ON, CA" already reads as
// California through the code list — a known cost, kept because the store's
// bucket catches it upstream.
const US_STATE_NAME = /\b(usa|u\.s\.a?\.?|united states|alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const US_STATE_CODE = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
// NAMES THAT ARE ALSO AMERICAN TOWNS ARE NOT ON THIS LIST. Gloucester is Applied
// Materials' Massachusetts site — 96 live rows, 29 of them at fit 70+, sent
// overseas by that one word. Vienna VA, Manchester NH, Bristol CT, Naples FL,
// Rome NY, Dublin OH, Paris TX, Oxford MS, Derby KS, Milan MI and Geneva IL
// went the same way. What remains is unambiguous.
const ELSEWHERE = /\b(singapore|malaysia|india|china|taiwan|korea|japan|philippines|vietnam|thailand|indonesia|germany|france|ireland|israel|mexico city|canada|brazil|poland|hungary|romania|czech|slovakia|netherlands|belgium|spain|italy|portugal|austria|switzerland|sweden|norway|denmark|finland|turkey|egypt|morocco|scotland|wales|england|united kingdom|emirates|australia|new zealand|argentina|chile|colombia|peru|dresden|munich|penang|kulim|bangalore|bengaluru|hyderabad|chennai|pune|noida|gurgaon|shanghai|beijing|shenzhen|suzhou|xi'?an|hsinchu|taipei|kaohsiung|tainan|taichung|seoul|incheon|tokyo|osaka|kyoto|manila|cebu|jakarta|bangkok|hanoi|ottawa|toronto|montreal|vancouver|calgary|belfast|glasgow|edinburgh|leeds|lyon|toulouse|grenoble|valbonne|sophia-antipolis|turin|pomigliano|barcelona|madrid|lisbon|porto|amsterdam|eindhoven|rotterdam|brussels|leuven|zurich|vienna, austria|prague|brno|budapest|warsaw|krakow|wroclaw|bucharest|stockholm|gothenburg|oslo|copenhagen|helsinki|tel aviv|haifa|dubai|abu dhabi|sydney|melbourne, australia|auckland|sao paulo|monterrey|guadalajara|juarez|tijuana|cwmbran|swansea|slough|basingstoke|baden|zug|winterthur|klagenfurt|villach|graz|linz|salzburg|tianjin|guangzhou|batu kawan|johor|chengdu|wuhan|dalian|nanjing|xiamen)\b/i;

/**
 * WHAT HIS OWN STORE ALREADY KNOWS ABOUT A PLACE (F-310).
 *
 * That entry's own instruction was "do not extend the city list — it will
 * never converge", and it is right: there is no end to the world's towns. But
 * the list does not have to be written, because 280,000 rows have already been
 * bucketed by `classifyLocation`, and a place word that appears in hundreds of
 * US-bucketed rows and no foreign ones is a US place. The evidence grows every
 * scan and needs no maintenance.
 *
 * Deliberately demanding: five sightings at minimum AND a five-to-one
 * majority. "Gloucester" is Applied Materials' Massachusetts site and also a
 * city in England — 5 against 6 in his store — so it stays unclear, which is
 * the honest answer rather than a coin toss.
 */
export function learnPlaces(db) {
  const seen = new Map();
  const rows = db.prepare(`
    SELECT location, location_bucket AS b, count(*) AS n FROM jobs
    WHERE location_bucket IN ('us', 'non-us') AND location <> ''
    GROUP BY location, location_bucket
  `).all();
  for (const r of rows) {
    for (const tok of String(r.location).toLowerCase().split(/[^a-z]+/)) {
      if (tok.length < 4) continue;
      if (!seen.has(tok)) seen.set(tok, { us: 0, non: 0 });
      seen.get(tok)[r.b === 'us' ? 'us' : 'non'] += r.n;
    }
  }
  return seen;
}

/** 'us' | 'elsewhere' | null — what the learned evidence says, if anything. */
export function learnedWhere(location, places) {
  if (!places) return null;
  let us = 0, non = 0;
  for (const tok of String(location || '').toLowerCase().split(/[^a-z]+/)) {
    const e = tok.length >= 4 && places.get(tok);
    if (!e) continue;
    us = Math.max(us, e.us); non = Math.max(non, e.non);
  }
  if (us >= 5 && us >= 5 * non) return 'us';
  if (non >= 5 && non >= 5 * us) return 'elsewhere';
  return null;
}

/** 'us' | 'elsewhere' | 'unclear' — never a silent drop. */
export function whereIsIt(location) {
  const s = String(location || '').trim();
  if (!s) return 'unclear';
  // A posting written in another script is not a US posting.
  if (/[　-鿿가-힯Ѐ-ӿ]/.test(s)) return 'elsewhere';
  // US evidence is checked FIRST. "Vienna, VA" and "Paris, TX" are American; a
  // foreign-city list consulted first called every one of them elsewhere.
  if (US_STATE_NAME.test(s) || US_STATE_CODE.test(s)) return 'us';
  if (ELSEWHERE.test(s)) return 'elsewhere';
  return 'unclear';
}

// HE IS A MECHANICAL ENGINEER. The fit engine scores on keyword overlap, so
// "Robotics - Software Development Engineer" and "ASIC Engineer Intern" came
// back at 85 — real roles, real companies, and not his degree. Semiconductor
// makes this genuinely hard to separate, because "Equipment Engineer" and
// "Process Engineer" ARE mechanical work at a fab while sitting in the same
// industry as circuit design. So: penalise the titles that are unambiguously
// somebody else's discipline, and leave everything else alone.
const NOT_HIS_DISCIPLINE = /\b(asic|rtl|verilog|vhdl|firmware|design\s+for\s+test|\bdft\b|physical design|analog design|circuit design|soc\b|software (development )?engineer|full[- ]stack|data (scientist|engineer)|machine learning engineer|cybersecurity|network engineer|cloud (hardware|infrastructure)|devops|\bsre\b)/i;

export function disciplineMiss(title) {
  return NOT_HIS_DISCIPLINE.test(String(title || ''));
}

// The sections every real posting has and a boilerplate stub does not. Any one
// of them is enough — boards phrase this a dozen ways, and the test is only
// meant to separate "a posting" from "a paragraph about the company".
const HAS_REQUIREMENTS = /\b(qualifications?|requirements?|what\s+you'?ll\s+(?:do|need|bring)|responsibilit\w*|who\s+you\s+are|about\s+(?:the\s+)?(?:role|job|position)|minimum|preferred|you\s+will\b|we'?re\s+looking\s+for|skills?\s*(?::|and\s+experience)|experience\s+(?:with|in)|degree\s+in|bachelor\w*|master'?s)\b/i;

/**
 * Is this stored body too thin to judge?
 *
 * Length is NOT the test, and an early version that used it got both ends
 * wrong: a terse 900-character posting stating a degree and three
 * requirements is perfectly judgeable, and 2,600 characters of culture copy
 * is not. The test is whether the body contains a requirements section at
 * all — because years, degree and work authorisation are all read out of one,
 * and with none present every verdict about the posting is a verdict about
 * text nobody fetched.
 */
export function isThinBody(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  return !HAS_REQUIREMENTS.test(s);
}

/**
 * The location as identity: its place words, whichever order and whatever
 * country suffix the board wrote them in (F-344). Lam lists "Mechanical
 * Engineer 2" as "US OR Tualatin" on one board and "Tualatin, OR,US, US"
 * on another — one opening, and the first-token rule saw "us or tualatin"
 * against "tualatin" and showed it twice.
 */
const COUNTRY_NOISE = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united', 'states', 'america', 'of']);
export const locationKey = (location) => [...new Set(String(location || '').toLowerCase()
  .split(/[^a-z.]+/).filter((t) => t && !COUNTRY_NOISE.has(t)))].sort().join(' ');

/** The same posting listed five times is one posting. */
export const dedupeKey = (j) => [
  (j.company || '').toLowerCase().trim(),
  (j.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    // Requisition noise: "(Fall 2026)", "- Job 12345", trailing roman numerals.
    .replace(/\b(job|req|requisition|id)\s*\d+/g, '')
    // Roman numerals used to be stripped as requisition noise. They are levels:
    // "Process Engineer" and "Process Engineer II" are different openings with
    // different bars, and folding them lost the one he could apply to.
    .trim(),
  // Location is part of identity — the same role in two states is two choices —
  // as its place words, so "Essex, VT,US, US", "Essex, VT" and "US VT Essex" agree.
  locationKey(j.location),
].join('|');

/**
 * Would he GET it. Nothing in the store measured this.
 *
 * Every term is a fact already in the row — no inference about him, and no
 * claim that reaches a human. Weights are deliberately coarse: this decides
 * READING ORDER, not whether he applies.
 */
export function winnability(j) {
  let s = 40;
  const why = [];
  if (j.f_newgrad) { s += 25; why.push('written for new grads'); }
  else if (j.f_intern) { s += 18; why.push('intern/co-op posting'); }
  // Sponsorship history is the single best predictor available for an F-1
  // candidate: it says this employer has actually done it before.
  if (j.sponsors_h1b === 1) { s += 20; why.push('has sponsored H-1B before'); }
  // …AND WHETHER THEY HAVE DONE IT IN HIS OWN FIELD, which is a different
  // question. Until 2026-09-12 this column was 24 hand-typed booleans; it is
  // now the Department of Labor's own record (F-454), and the record
  // distinguishes an employer that files three thousand software LCAs from one
  // that files for mechanical and industrial engineers.
  if (j.lca_eng_certified >= 3) { s += 8; why.push(`${j.lca_eng_certified} H-1B filings in his own field`); }
  // THE WAGE LEVEL IS A LOTTERY MULTIPLIER, not a salary note. Since
  // 2026-02-27 a Level I offer is entered in the cap draw once and a Level IV
  // four times, so two employers who both sponsor can be four times apart on
  // whether it ever becomes status. Small on purpose: it breaks ties between
  // employers, it does not outrank whether the job suits him.
  const lvl = j.lca_eng_modal_level || 0;
  if (lvl >= 3) { s += (lvl === 4 ? 8 : 5); why.push(`files at Level ${lvl === 4 ? 'IV' : 'III'} — ${lvl} lottery entries`); }
  else if (lvl === 1) { s -= 4; why.push('files at Level I — one lottery entry'); }
  if (j.f_visa_good === 1) { s += 8; why.push('posting is visa-friendly'); }
  if (j.f_stretch === 1) { s -= 25; why.push('stretch role'); }
  if (j.level_years != null) {
    if (j.level_years <= 1) { s += 12; why.push('asks ≤1 yr experience'); }
    else if (j.level_years <= 2) { s += 6; why.push('asks ≤2 yrs'); }
    else if (j.level_years >= 4) { s -= 18; why.push(`asks ${j.level_years} yrs`); }
  } else if (j.salary_min >= 190000 && (j.salary_interval || 'year') === 'year') {
    // WHAT A POSTING PAYS IS A SENIORITY STATEMENT WHEN IT STATES NO YEARS
    // (F-466). OpenAI "Mechanical Engineer, Dynamometer and Actuator Testing"
    // names no years requirement at all and pays $225–318K. A US mechanical
    // new-grad band tops out well below that, so the floor is the level the
    // employer is actually hiring at.
    //
    // It costs reading ORDER and nothing else — the row stays on the list, and
    // a genuine Bay Area new-grad band (which does not reach $190K) is
    // untouched. Only consulted when no years figure was stated: a posting
    // that says what it wants has already said it.
    s -= 15; why.push(`pays from $${Math.round(j.salary_min / 1000)}K — a level above new grad`);
  }
  // FRESHNESS IS WINNABILITY. A posting that has been up for three months has
  // been seen by everyone and is often already filled — the liveness check says
  // the page is up, not that the seat is.
  const age = j.posted_at ? Math.floor((Date.now() - Date.parse(j.posted_at)) / 86400000) : null;
  if (age != null) {
    if (age <= 7) { s += 15; why.push('posted this week'); }
    else if (age <= 21) { s += 8; why.push(`posted ${age}d ago`); }
    else if (age >= 60) { s -= 12; why.push(`up ${age} days`); }
  }
  if (j.tier === 'tracked') { s += 5; why.push('a company he tracks'); }
  return { score: Math.max(0, Math.min(100, Math.round(s))), why };
}

/**
 * Would he WANT it. The fit engine already answers most of this, so this only
 * adjusts for what it does not weigh — his floor, and whether the work is the
 * hands-on kind he keeps choosing.
 */
export function desirability(j) {
  let s = j.fit_score ?? 0;
  const why = [];
  if (j.role_kind === 'hands-on') { s += 6; why.push('hands-on'); }
  // $80K floor. Only judged when the posting states a number — most do not, and
  // absence is not evidence of a low number.
  if (j.salary_max != null && j.salary_max < 80000) { s -= 20; why.push(`tops out at $${Math.round(j.salary_max / 1000)}k`); }
  else if (j.salary_min != null && j.salary_min >= 80000) { s += 6; why.push(`from $${Math.round(j.salary_min / 1000)}k`); }
  return { score: Math.max(0, Math.min(100, Math.round(s))), why };
}

export function rank(rows, { perCompany = 3, limit = 40 } = {}) {
  const dropped = { duplicate: 0, overseas: 0, ineligible: 0, breaksRules: 0 };
  const ineligible = [], needsCheck = [], elsewhere = [];

  // SCORE EVERYTHING FIRST, THEN DE-DUPLICATE KEEPING THE BEST.
  //
  // Dedupe used to run first and keep whichever row SQL happened to return
  // first. At Applied Materials that was "Process Engineer II" (a `check`)
  // suppressing three "Process Engineer" rows that were clean `apply` — the
  // survivor was chosen by row order, and it was the worst one.
  const scoredAll = rows.map((j) => {
    const bucket = j.location_bucket;
    const read = bucket === 'non-us' ? 'elsewhere'
      : (bucket === 'us' || bucket === 'remote') ? 'us'
        : (whereIsIt(j.location) === 'elsewhere' || whereIsIt(j.title) === 'elsewhere') ? 'elsewhere'
          : whereIsIt(j.location);
    // A place no rule recognises, that his own store has bucketed hundreds of
    // times, is not unclear (F-310). Reno, Albany, Greenville and Stafford all
    // reached this line and were docked 15 points for being unrecognisable.
    const where = read === 'unclear' ? (j.learnedWhere || 'unclear') : read;
    const w = winnability(j), d = desirability(j);
    return {
      ...j,
      where,
      disciplineMiss: disciplineMiss(j.title),
      winnability: w.score,
      desirability: d.score,
      // A LOCATION NOBODY RECOGNISED RANKS BEHIND ONE THAT IS KNOWN (F-310).
      // "Yixing" (Jiangsu, China) reached #2 of 5 because `unclear` was
      // admitted at full score. The city list will never converge, so an
      // unverified location costs points and says so, and stays visible.
      combined: Math.round((w.score + d.score) / 2) - (disciplineMiss(j.title) ? 25 : 0) - (where === 'unclear' ? 15 : 0),
      why: [...d.why, ...w.why, ...(disciplineMiss(j.title) ? ['reads as EE/CS, not mechanical'] : []), ...(where === 'unclear' ? ['location not recognised — verify it is in the US'] : [])],
    };
  });

  // Among copies of one posting, the one he can actually apply to wins, then
  // the one that is in the US, then the highest score.
  const standing = (r) => {
    const e = r.eligible?.verdict;
    return (e === 'apply' ? 2 : e === 'check' ? 1 : 0) * 10000
      + (r.where === 'elsewhere' ? 0 : 1000)
      + (r.breaksRules?.length ? 0 : 500)
      + r.combined;
  };
  const best = new Map();
  for (const r of scoredAll) {
    const k = dedupeKey(r);
    const cur = best.get(k);
    if (!cur || standing(r) > standing(cur)) best.set(k, r);
  }
  dropped.duplicate = scoredAll.length - best.size;

  const scored = [];
  for (const row of best.values()) {
    if (row.where === 'elsewhere') { dropped.overseas++; elsewhere.push(row); continue; }
    // NOT ELIGIBLE IS NOT HIDDEN — it is set aside with its reason, so a wrong
    // call is visible and arguable rather than a job that silently vanished.
    if (row.eligible?.verdict === 'not-eligible') { dropped.ineligible++; ineligible.push(row); continue; }
    // A hard rule of his own is not a ranking penalty, it is a refusal.
    if (row.breaksRules?.length) { dropped.breaksRules++; ineligible.push({ ...row, why: row.breaksRules }); continue; }
    if (row.eligible?.verdict === 'check') { needsCheck.push(row); continue; }
    scored.push(row);
  }

  scored.sort((a, b) => b.combined - a.combined);

  // A LIST THAT IS HALF ONE EMPLOYER IS NOT A SHORTLIST. Measured: GlobalFoundries
  // and Micron were 187 of 362 survivors, and the top of the raw ranking was the
  // same GlobalFoundries posting five times over.
  //
  // The loop no longer breaks at the limit: everything past it is BENCHED and
  // counted, so "N more held back" is the true number rather than however many
  // rows the cap happened to reject before the limit was reached.
  const perCo = new Map();
  const out = [];
  const benched = [];
  for (const j of scored) {
    const c = (j.company || '').toLowerCase();
    const n = perCo.get(c) || 0;
    if (n >= perCompany || out.length >= limit) { benched.push(j); continue; }
    perCo.set(c, n + 1);
    out.push(j);
  }
  needsCheck.sort((a, b) => b.combined - a.combined);
  return {
    picks: out, benched, elsewhere, ineligible, needsCheck, dropped,
    considered: rows.length,
    // Survivors of de-duplication ONLY. The old value was survivors of every
    // screen, so the CLI's "171 → 18 after de-duplication (26 repeats)" did not
    // add up and 127 rows were invisible in the summary.
    deduped: best.size,
    eligible: scored.length,
  };
}

export function loadCandidates(dbPath = DB_PATH, { minFit = 70, days = 60, withDescriptions = true, interns = false, gradAnyway = false } = {}) {
  const db = openDb(dbPath);
  // THE DEPARTMENT'S RECORD, LEFT-JOINED. The two LCA tables are written by
  // `lca-import.mjs` and may not exist at all on a store that has never loaded
  // a disclosure file, so the join is optional and the columns come back NULL
  // — which `winnability()` reads as "no evidence", not as "no sponsorship".
  const hasLca = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lca_employers'").get();
  const lcaCols = hasLca
    ? ', e.eng_certified AS lca_eng_certified, e.eng_modal_level AS lca_eng_modal_level, e.eng_median_wage AS lca_eng_median_wage'
    : '';
  const lcaJoin = hasLca
    ? 'LEFT JOIN company_lca c ON c.company = jobs.company LEFT JOIN lca_employers e ON e.key = c.key'
    : '';
  // Built as a function of the one switch, so the "how many did that remove"
  // count below is the SAME screen asked twice rather than a string edited
  // afterwards — an edit that would silently report zero the day the SQL is
  // reformatted.
  const sqlFor = (withGrad) => `SELECT jobs.id, jobs.url, jobs.title, jobs.company, jobs.team, jobs.location, jobs.posted_at, jobs.first_seen,
      jobs.fit_score, jobs.fit_band, jobs.role_kind, jobs.level, jobs.level_years, jobs.tier, jobs.adapter, jobs.location_bucket,
      jobs.f_newgrad, jobs.f_intern, jobs.f_senior, jobs.f_stretch, jobs.f_visa_good, jobs.sponsors_h1b,
      jobs.salary_min, jobs.salary_max, jobs.salary_interval, jobs.desc_len${lcaCols}
    FROM jobs ${lcaJoin} WHERE ${SCREEN.replace('@minFit', String(Number(minFit) || 70)).replace('@window', `'-${Number(days) || 60} day'`)
    .replace('@internClause', interns ? 'OR f_intern = 1' : '')
    .replace('@gradClause', withGrad ? 'OR 1 = 1' : '')}`;
  const rows = db.prepare(sqlFor(gradAnyway)).all();
  // WHAT THE GRADUATION CLAUSE TOOK OUT, COUNTED AND REPORTED.
  //
  // Nothing in Jarvis disappears without saying so. The same screen run with
  // the clause relaxed gives the number, and the caller prints it with the
  // switch that puts them back.
  const gradExcluded = gradAnyway ? 0 : db.prepare(sqlFor(true)).all().length - rows.length;
  // What the store already knows about the places it could not parse (F-310).
  // Computed once per load, not per row.
  const places = learnPlaces(db);
  for (const r of rows) r.learnedWhere = learnedWhere(r.location, places);
  // ELIGIBILITY IS READ FROM THE POSTING, so the description has to come along.
  // One shared dictionary handle: pulling it per row turned a 300ms read into
  // half a minute on the first attempt.
  // HIS OWN RULES, APPLIED LIVE.
  //
  // preferences.md holds 161 hand-written rules and this screen was reading
  // none of them — it trusted `f_hard_block`, which is a STORED verdict from
  // whenever the row was last triaged. A rule added after that never reaches an
  // older row, so:
  //
  //   "Structural Analyst - Aerospace & Defense"   f_hard_block = 0
  //
  // reached a curated shortlist for a man on an F-1 visa, while
  // `never defense, defence, missile, munitions, warfare, weapons, hypersonic`
  // sat in his preferences and the comment above it named that exact posting as
  // one that had been "sitting unblocked in the deck".
  //
  // Evaluating the rules here costs nothing and does not depend on when the row
  // was last touched. It also catches the softer ones the stored flags never
  // carried: "no business operations, product operations, operations associate
  // in title" is why an Agave ops role kept surviving this screen.
  const rules = (() => { try { return loadPrefs(); } catch { return null; } })();
  // COMPANIES HE HAS HIDDEN ARE NOT CANDIDATES. He hid eleven with the ⊘
  // button — GlobalFoundries and Smith+Nephew among them — and two curated
  // roles at those employers went into his inbox anyway, where the view then
  // correctly hid them: a shortlist of seven that showed five, under a header
  // saying twenty-eight. The list lives in the store's meta table; read it here
  // so the ranker respects a decision he already made.
  const hidden = new Set((() => {
    try {
      const row = db.prepare("SELECT v FROM meta WHERE k = 'hiddenCompanies'").get();
      const v = row ? JSON.parse(row.v) : [];
      return Array.isArray(v) ? v.map((c) => String(c).toLowerCase().trim()) : [];
    } catch { return []; }
  })());
  if (withDescriptions) {
    const dict = getDictionary(db, 'description');
    for (const r of rows) {
      const text = readDescription(db, r.id, dict);
      // A BODY WITH NO REQUIREMENTS IN IT CANNOT BE JUDGED (F-467).
      //
      // Robust "Robotics Validation Engineer", Lumafield "Applications
      // Engineer" and Capstan Medical "Design Quality Engineer - Robot" (799
      // characters, fit 84) store 800–1,400 characters of company boilerplate
      // and no requirements section at all. They satisfy `has_desc = 1`, so
      // they arrive looking judged, and every verdict about them — years,
      // degree, visa — is a verdict about text that was never fetched.
      //
      // What they need is `npm run jarvis:enrich`, not an opinion. They stay
      // in the list, carrying the reason, and the caller prints the remedy.
      r.thin = isThinBody(text);
      r.eligible = eligibility(r, text);
      if (r.thin) {
        r.eligible = {
          ...r.eligible,
          verdict: 'unknown',
          reasons: ['the stored body has no requirements section — run jarvis:enrich'],
          evidence: `${(text || '').length} characters`,
        };
      }
      if (hidden.has(String(r.company || '').toLowerCase().trim())) {
        r.eligible = { ...r.eligible, verdict: 'not-eligible', reasons: ['you hid this company'], evidence: r.company };
      }
      if (rules) {
        try {
          // THE BODY TOO (F-311): a night or weekend schedule is written in the
          // description, never the title — Jabil's "Thursday–Saturday 6pm–6am"
          // ranked #16 as a clean mechanical req while the rules that name
          // shift work were only ever shown the title.
          const verdict = applyPrefs({ title: r.title, company: r.company, location: r.location, description: text }, rules);
          r.breaksRules = verdict?.hard || [];
        } catch { r.breaksRules = []; }
      }
    }
  }
  db.close?.();
  // The count rides on the array so the caller can report it without running
  // the screen twice. Non-enumerable: every consumer of this list JSON-encodes
  // it or iterates it, and neither should see a stray property.
  Object.defineProperty(rows, 'gradExcluded', { value: gradExcluded, enumerable: false });
  return rows;
}

// Guarded: `node -e "import(...)"` has no argv[1], and reading it unguarded
// crashed every programmatic import of this module, tests included.

/**
 * Put a set of postings in his inbox, with the reason each one earned its place.
 *
 * The inbox is a CURATED lane, not a filter: everything in it has been read,
 * checked against his degree and visa, and argued for. That is the difference
 * between "here are 7,401 jobs scoring 70+" and a shortlist, and it is the whole
 * point of the skill this belongs to.
 *
 * Deliberately additive and reversible: it only moves postings OUT of `new`, so
 * nothing he has already decided about is touched, and `--undo` puts them back.
 */
export function approve(ids, notes = {}, { dbPath = DB_PATH, undo = false, interns = false } = {}) {
  const db = openDb(dbPath);
  const now = new Date().toISOString();
  const set = db.prepare(
    `UPDATE jobs SET status = ?, status_changed_at = ?, pick_note = ?
       WHERE id = ? AND status IN ('new', 'inbox')`);

  // AN INTERNSHIP DOES NOT REACH THE CURATED INBOX, HOWEVER GOOD THE ARGUMENT.
  //
  // The SQL screen above has excluded internships since it was written, and
  // eleven of them were in his inbox anyway — they arrive through here, from a
  // curator that read one, found a case for it, and wrote the case into the
  // note. Two landed on 2026-09-20 and he answered both the same way:
  // "intern???????" and "internship??????".
  //
  // The arguments were not bad ones. Physical Intelligence's note reasons
  // about a Spring 2027 co-op term; ASM's quotes the posting inviting
  // international students. He graduates May 2027 and is not taking another
  // internship, and a screen that can be talked out of a standing decision by
  // a sufficiently good paragraph is not a screen.
  //
  // REFUSED, NEVER SILENTLY DROPPED. The ids come back so the caller says what
  // it left out, because triage flags and never drops — and `--interns` puts
  // them through for the day he asks for one.
  const refused = [];
  if (!interns && !undo) {
    const isIntern = db.prepare('SELECT f_intern FROM jobs WHERE id = ?');
    ids = ids.filter((id) => {
      if (isIntern.get(id)?.f_intern !== 1) return true;
      refused.push(id);
      return false;
    });
  }

  let moved = 0;
  for (const id of ids) {
    // A WITHDRAWAL KEEPS ITS REASON. Undoing used to set status back to `new`
    // and leave the old approval note, so a posting read in full and rejected
    // looked exactly like one never opened — and the next screen served it
    // straight back. Now the row says "Not curated — <why>", the ranker skips
    // it, and the reason is on the card if he ever goes looking.
    const note = undo
      ? (notes[id] ? `Not curated — ${notes[id]}` : null)
      : (notes[id] || null);
    const r = set.run(undo ? 'new' : 'inbox', now, note, id);
    moved += r.changes || 0;
  }
  db.close?.();
  return { moved, total: ids.length + refused.length, refused };
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const minFit = Number(arg('min-fit', 70));
  const days = Number(arg('days', 60));
  const limit = Number(arg('limit', 40));
  const rows = loadCandidates(DB_PATH, {
    minFit, days,
    interns: process.argv.includes('--interns'),
    gradAnyway: process.argv.includes('--grad-anyway'),
  });
  const r = rank(rows, { limit, perCompany: Number(arg('per-company', 3)) });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, benched: r.benched.length }, null, 1));
  } else {
    console.log(`\n${r.considered} passed the screen → ${r.deduped} after de-duplication `
      + `(${r.dropped.duplicate} repeats, ${r.dropped.overseas} outside the US) → showing ${r.picks.length}\n`);
    if (rows.gradExcluded > 0) {
      console.log(`  (${rows.gradExcluded} more state a graduation window you fall outside of `
        + `— run with --grad-anyway to see them)\n`);
    }
    // COUNTED ON THE ROWS THAT ARE STILL IN THE RUNNING. Many of the thin
    // bodies are the overseas postings rank() drops on the next line anyway
    // (Micron Hiroshima, Bosch Reutlingen, Littelfuse "Abteilungsleiter…"),
    // and several are thin only because they are not in English. Counting
    // those told him 45 postings needed attention when the real number, among
    // postings he could take, was far smaller.
    const thin = rows.filter((r) => r.thin && whereIsIt(r.location) !== 'elsewhere').length;
    if (thin > 0) {
      // Measured 2026-09-17: all 45 were re-fetched with `enrich --id <id>
      // --force` and NOT ONE came back readable. Lumafield's "Applications
      // Engineer" is 1,446 characters of "About Lumafield"; Last Energy's is
      // 423; Thermo Fisher's is 346. That is everything the board's API
      // returns, so telling him to run the enricher was telling him to wait
      // for something that will not arrive.
      console.log(`  (${thin} publish only a summary, with no requirements to judge them by `
        + `— their board returns nothing more, so open one to decide on it)\n`);
    }
    console.log('  fit  win  role'.padEnd(64) + 'company');
    for (const j of r.picks) {
      console.log(`  ${String(j.desirability).padStart(3)}  ${String(j.winnability).padStart(3)}  `
        + `${(j.title || '').slice(0, 46).padEnd(48)}${(j.company || '').slice(0, 18).padEnd(20)}`
        + `${(j.location || '?').slice(0, 20)}${j.where === 'unclear' ? ' ?loc' : ''}`);
    }
    console.log(`\n  ${r.benched.length} more held back by the per-company cap.`);
  }
}
