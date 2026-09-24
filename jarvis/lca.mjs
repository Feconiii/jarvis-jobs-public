/**
 * DOL LCA DISCLOSURE DATA — who actually sponsors, and at what wage level.
 *
 * `sponsors_h1b` has been 24 hand-typed booleans covering 24 of 1,144 companies
 * (F-447). This replaces the typing with the Department of Labor's own record
 * of every Labor Condition Application it has ruled on, which is the closest
 * thing to ground truth that exists: an employer cannot file one without
 * intending to sponsor somebody.
 *
 * TWO NUMBERS COME OUT OF IT, and the second is the one nobody else computes.
 *
 *   1. **Do they sponsor at all**, and how recently. A company with zero
 *      certified LCAs in the last two years is not going to start for a new
 *      grad, whatever their careers page implies.
 *   2. **At which wage level.** The weighted H-1B lottery took effect
 *      2026-02-27: a Level I offer is entered in the draw ONCE, a Level IV is
 *      entered FOUR times. Two employers can both "sponsor" and be four times
 *      apart on whether the sponsorship ever turns into status. Under the
 *      proposed $103,265 cap-subject fee — which reaches F-1 change of status —
 *      the gap widens again, because the employers who pay it will be the ones
 *      already filing high.
 *
 * WHAT THIS IS NOT. It is not a promise: an employer who filed 400 LCAs may
 * still refuse this req, and a posting that says "no sponsorship" still says
 * it. The verdict on a POSTING stays with `visa.mjs` and its quote. This is
 * evidence about an EMPLOYER, and it is used to rank, never to block.
 *
 * Matching DOL's legal names to a careers-site's spelling is the part that can
 * be wrong, so it is deliberately conservative and every match records HOW it
 * was made — an exact normalised hit and a prefix hit are different levels of
 * confidence and the dashboard shows which.
 */
import { eachRow, cellDate } from './xlsx.mjs';

// ── employer names ──────────────────────────────────────────────────

/**
 * Legal furniture. Removed from the END only: "CORNING INC" and "INCORPORATED
 * TECHNOLOGIES" are not the same kind of word, and stripping "INC" wherever it
 * appears turns "PRINCETON" into "PRETON".
 */
const SUFFIX = /\b(?:inc|incorporated|corp|corporation|co|company|llc|l\.?l\.?c|lp|llp|plc|ltd|limited|gmbh|ag|nv|bv|sa|spa|pte|pty|kk|oy|ab|as|holdings?|group|intl|international|worldwide|global|enterprises?|industries|ventures|partners|usa|us|u\.?s\.?a?|america|americas|north america)\b/g;

/** Punctuation that is never part of the identity. */
const PUNCT = /[.,'’"“”()\[\]/\\&+-]/g;

/**
 * A comparable form of an employer name.
 *
 * "Applied Materials", "APPLIED MATERIALS, INC.", "0001 Applied Materials, Inc"
 * and "Applied Materials Inc." all have to land on the same string, and
 * "Applied Intuition" must not land there with them.
 */
export function normalizeEmployer(name) {
  let s = String(name || '').toLowerCase();
  // A leading requisition or entity number, which Workday tenants prepend:
  // his own store holds "0001 Applied Materials, Inc".
  s = s.replace(/^[\s#]*\d{2,6}\s+/, '');
  s = s.replace(/\bd\/?b\/?a\b.*$/, '');          // "ACME DBA WIDGETS" → "ACME"
  s = s.replace(PUNCT, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Suffixes come off repeatedly: "TECHNOLOGIES GROUP HOLDINGS LLC" is four.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(new RegExp(`(?:${SUFFIX.source})\\s*$`, 'g'), '').trim();
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** The tightest form, for a last-resort comparison. */
const squash = (s) => normalizeEmployer(s).replace(/[^a-z0-9]/g, '');

// ── the columns, found by name ──────────────────────────────────────

/**
 * The layout changes between fiscal years — columns are added, and FY2020 and
 * FY2026 do not agree on order. Reading by header name rather than by index is
 * the difference between a reader that survives the next release and one that
 * silently attributes wages to the wrong employer.
 */
const WANTED = {
  status: ['CASE_STATUS'],
  visa: ['VISA_CLASS'],
  employer: ['EMPLOYER_NAME'],
  employerState: ['EMPLOYER_STATE'],
  jobTitle: ['JOB_TITLE'],
  socCode: ['SOC_CODE'],
  socTitle: ['SOC_TITLE'],
  level: ['PW_WAGE_LEVEL'],
  wageFrom: ['WAGE_RATE_OF_PAY_FROM'],
  wageUnit: ['WAGE_UNIT_OF_PAY'],
  prevailing: ['PREVAILING_WAGE'],
  decision: ['DECISION_DATE'],
  positions: ['TOTAL_WORKER_POSITIONS'],
  worksiteState: ['WORKSITE_STATE'],
  newEmployment: ['NEW_EMPLOYMENT'],
};

export function mapHeader(headerRow) {
  const idx = {};
  const seen = new Map();
  headerRow.forEach((h, i) => seen.set(String(h || '').trim().toUpperCase(), i));
  for (const [key, names] of Object.entries(WANTED)) {
    for (const n of names) if (seen.has(n)) { idx[key] = seen.get(n); break; }
  }
  return idx;
}

/** The SOC families a mechanical engineering new grad competes in. */
export const HIS_SOCS = /^(?:17-2(?:141|112|199|111|131|051|072|061)|17-3(?:027|026|029)|11-3051|17-2011)/;

/**
 * A PLAUSIBLE annual salary. Outside this band the filing is a data-entry
 * error, not a job.
 *
 * Measured on the real file: Skyworks' mean engineering wage came out at
 * $5,144,794 because a handful of filings state an ANNUAL amount and tick the
 * HOURLY box — $150,000/hour annualises to $312 million and one of those drags
 * a mean of fifty-eight filings by five million. The Department publishes what
 * the employer typed; it does not correct it.
 */
export const WAGE_FLOOR = 15000;
export const WAGE_CEILING = 1500000;

/** Everything annualised, because a filing may state an hourly rate. */
export function annualWage(amount, unit) {
  const n = Number(String(amount || '').replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const u = String(unit || '').trim().toLowerCase();
  let v = n;
  if (u.startsWith('hour')) v = n * 2080;
  else if (u.startsWith('week')) v = n * 52;
  else if (u.startsWith('bi')) v = n * 26;
  else if (u.startsWith('month')) v = n * 12;
  v = Math.round(v);
  return v >= WAGE_FLOOR && v <= WAGE_CEILING ? v : 0;
}

/** The middle filing. A mean is not robust to a typo; a median is. */
export function median(list) {
  if (!list || !list.length) return 0;
  const a = Float64Array.from(list).sort();
  const mid = a.length >> 1;
  return Math.round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
}

/** "Level II" / "II" / "2" → 2. Blank means the employer did not state one. */
export function wageLevel(v) {
  const s = String(v || '').trim().toUpperCase();
  const m = s.match(/\b(IV|III|II|I|1|2|3|4)\b/);
  if (!m) return 0;
  return { I: 1, II: 2, III: 3, IV: 4, 1: 1, 2: 2, 3: 3, 4: 4 }[m[1]] || 0;
}

const blank = () => ({
  name: '', certified: 0, denied: 0, withdrawn: 0, positions: 0,
  lvl: [0, 0, 0, 0], engLvl: [0, 0, 0, 0], engCertified: 0,
  wages: [], engWages: [],
  lastDecision: '', states: new Map(), titles: new Map(),
});

/**
 * Fold the whole file into one record per employer.
 *
 * Nothing is kept per row. At roughly 700,000 rows and 200,000 employers the
 * map is tens of megabytes; holding the rows would be gigabytes.
 */
export async function aggregateLca(file, { onProgress = null, progressEvery = 100000, emptyRunLimit = 2000 } = {}) {
  const byEmployer = new Map();
  let idx = null;
  let rows = 0;
  let skipped = 0;
  let empty = 0;
  let emptyRun = 0;
  let lastDataRow = 0;

  await eachRow(file, (cells, rowNo) => {
    if (!idx) {
      idx = mapHeader(cells);
      if (idx.employer == null || idx.status == null) {
        throw new Error(`this file has no EMPLOYER_NAME/CASE_STATUS header — first row was: ${cells.slice(0, 8).join(' | ')}`);
      }
      return;
    }
    rows++;
    if (onProgress && rows % progressEvery === 0) onProgress({ rows, employers: byEmployer.size, empty });

    // THE SHEET IS PADDED, AND AN EMPTY ROW IS NOT A SKIPPED ONE.
    //
    // DOL's FY2026 Q3 file holds 437,496 rows of data and is then padded to
    // 1,032,736 with rows that carry only a style and no value:
    //
    //   <row r="437499" spans="1:98"><c r="C437499" s="1"/><c r="D437499" s="1"/>…</row>
    //
    // Excel writes these when number formats were applied to whole columns.
    // The first version of this counted all 595,239 of them as "skipped (not
    // H-1B, or no employer named)" — which reads as "we chose not to count
    // 59% of the Department's data" rather than "there was nothing there".
    // Same conflation as F-439, and worth naming rather than silently
    // subtracting.
    const raw = String(cells[idx.employer] || '').trim();
    if (!raw && !String(cells[idx.status] || '').trim()) {
      empty++;
      emptyRun++;
      // Once the padding starts it runs to the end of the sheet, and the rest
      // of the file is a gigabyte of nothing. Stopping saves the inflation.
      if (emptyRun >= emptyRunLimit) return false;
      return;
    }
    emptyRun = 0;
    lastDataRow = rowNo;

    const visa = String(cells[idx.visa] || '');
    // H-1B only. E-3 is Australians and H-1B1 is Chile/Singapore; neither says
    // anything about whether they would file for him.
    if (visa && !/^H-?1B$/i.test(visa.replace(/\s+/g, ''))) { skipped++; return; }

    if (!raw) { skipped++; return; }
    const key = normalizeEmployer(raw);
    if (!key) { skipped++; return; }

    let rec = byEmployer.get(key);
    if (!rec) { rec = blank(); rec.name = raw; byEmployer.set(key, rec); }

    const status = String(cells[idx.status] || '').toUpperCase();
    // "Certified-Withdrawn" was certified before it was withdrawn: the
    // employer was willing and the Department agreed, which is the question
    // being asked here.
    if (status.startsWith('CERTIFIED')) rec.certified++;
    else if (status.startsWith('DENIED')) rec.denied++;
    else rec.withdrawn++;

    const when = cellDate(cells[idx.decision]);
    if (when > rec.lastDecision) rec.lastDecision = when;

    if (!status.startsWith('CERTIFIED')) return;

    rec.positions += Number(cells[idx.positions]) || 1;
    const lvl = wageLevel(cells[idx.level]);
    if (lvl) rec.lvl[lvl - 1]++;

    const wage = annualWage(cells[idx.wageFrom], cells[idx.wageUnit]);
    if (wage > 0) rec.wages.push(wage);

    const st = String(cells[idx.worksiteState] || cells[idx.employerState] || '').trim().toUpperCase();
    if (st) rec.states.set(st, (rec.states.get(st) || 0) + 1);

    // HIS OWN FIELD, KEPT APART. An employer that files 3,000 software LCAs at
    // Level IV and has never filed for a mechanical engineer is a different
    // proposition from one that files ten a year in his own SOC — and the
    // aggregate would report them as the same.
    const soc = String(cells[idx.socCode] || '').trim();
    if (HIS_SOCS.test(soc)) {
      rec.engCertified++;
      if (lvl) rec.engLvl[lvl - 1]++;
      if (wage > 0) rec.engWages.push(wage);
      const t = String(cells[idx.jobTitle] || '').trim();
      if (t) rec.titles.set(t, (rec.titles.get(t) || 0) + 1);
    }
  });

  return { byEmployer, rows, skipped, empty, dataRows: rows - empty, lastDataRow };
}

const topOf = (m, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

/** The shape written to the store and shown on a card. */
export function summarise(key, rec) {
  const lvlTotal = rec.lvl.reduce((a, b) => a + b, 0);
  const engTotal = rec.engLvl.reduce((a, b) => a + b, 0);
  // The modal level, which is what a lottery entry count is drawn from.
  const modal = (arr) => {
    let best = 0, at = 0;
    arr.forEach((n, i) => { if (n > best) { best = n; at = i + 1; } });
    return at;
  };
  return {
    key,
    name: rec.name,
    certified: rec.certified,
    denied: rec.denied,
    positions: rec.positions,
    lastDecision: rec.lastDecision,
    levels: rec.lvl.slice(),
    modalLevel: modal(rec.lvl),
    medianWage: median(rec.wages),
    // His own occupational family.
    engCertified: rec.engCertified,
    engLevels: rec.engLvl.slice(),
    engModalLevel: modal(rec.engLvl),
    engMedianWage: median(rec.engWages),
    engLevelled: engTotal,
    levelled: lvlTotal,
    topStates: topOf(rec.states, 4),
    topTitles: topOf(rec.titles, 5),
  };
}

// ── matching his companies to DOL's ─────────────────────────────────

/**
 * A false match here is worse than no match: it would tell him an employer
 * sponsors when it is a different company with a similar name. So a match is
 * made only three ways, and the way is recorded.
 *
 *   exact   the normalised names are identical — trusted
 *   squash  identical once every non-letter is removed — trusted
 *   prefix  one normalised name begins with the other AND the shorter is at
 *           least twelve characters and two words. "applied materials" vs
 *           "applied materials south east asia" passes; "apple" vs
 *           "applebees" cannot, because "apple" is five characters.
 *
 * Nothing fuzzier. Edit distance on company names produces exactly the kind of
 * confident wrong answer this project keeps finding in other people's tools.
 */
/**
 * TRADE NAME vs LEGAL ENTITY, which no string comparison can bridge.
 *
 * "onsemi" files as "Semiconductor Components Industries, LLC". The two names
 * share nothing — not a word, not a letter pattern — and any rule loose enough
 * to connect them would connect a hundred wrong pairs as well. So these are
 * recorded facts, each verified against the file before being written here,
 * and each one says how it was confirmed.
 *
 * Keyed on the normalised form of HIS spelling; the value is the normalised
 * DOL key.
 */
export const ALIASES = new Map([
  // 96 certified filings, 40 in engineering, top state AZ — onsemi's
  // headquarters. Verified in LCA_Disclosure_Data_FY2026_Q3.
  ['onsemi', { key: 'semiconductor components', why: 'onsemi files as Semiconductor Components Industries, LLC' }],
]);

export function matchEmployers(companies, byEmployer, { aliases = ALIASES } = {}) {
  const bySquash = new Map();
  for (const key of byEmployer.keys()) {
    const s = key.replace(/[^a-z0-9]/g, '');
    if (s && !bySquash.has(s)) bySquash.set(s, key);
  }
  // Prefix candidates, longest first, so the most specific wins.
  const keys = [...byEmployer.keys()].sort((a, b) => b.length - a.length);
  // Which employers begin with each first word — the index the rarity test
  // below reads. A word owned by two employers identifies neither.
  const firstOf = new Map();
  for (const k of keys) {
    const w = k.split(' ')[0];
    if (!w) continue;
    const list = firstOf.get(w);
    if (list) { if (list.length < 3) list.push(k); }
    else firstOf.set(w, [k]);
  }

  const out = new Map();
  for (const company of companies) {
    const norm = normalizeEmployer(company);
    if (!norm) continue;
    // AN ACRONYM IS NOT AN IDENTITY. "ATI Inc." and "ATI HOLDINGS, LLC" both
    // normalise to "ati" once Inc/Holdings/LLC come off — and they are
    // Allegheny Technologies and a physical-therapy group. The length guard
    // below protected the prefix rule and not this one, so the first real run
    // matched them and reported 36 filings, none of them engineering, as
    // Allegheny's.
    //
    // Short keys are still MATCHED, because "3M" normalises to "3m" and there
    // is only one 3M. They are labelled instead, so a wrong one is visible in
    // the report rather than buried in a column.
    // A recorded fact beats every rule below it.
    const alias = aliases.get(norm);
    if (alias && byEmployer.has(alias.key)) { out.set(company, { key: alias.key, how: 'alias' }); continue; }

    const how = norm.replace(/[^a-z0-9]/g, '').length <= 4 ? 'acronym' : 'exact';
    if (byEmployer.has(norm)) { out.set(company, { key: norm, how }); continue; }
    const sq = squash(company);
    if (sq && bySquash.has(sq)) { out.set(company, { key: bySquash.get(sq), how: how === 'acronym' ? 'acronym' : 'squash' }); continue; }
    if (norm.length >= 12 && norm.split(' ').length >= 2) {
      // The DOL name that starts with his company's name, biggest filer first.
      let best = null, bestCert = -1;
      for (const k of keys) {
        if (!k.startsWith(`${norm} `)) continue;
        const c = byEmployer.get(k).certified;
        if (c > bestCert) { best = k; bestCert = c; }
      }
      if (best) { out.set(company, { key: best, how: 'prefix' }); continue; }
    }

    // A DISTINCTIVE FIRST WORD, when it belongs to exactly one employer.
    //
    // "Marvell Technology" is his spelling; the Department's is "MARVELL
    // SEMICONDUCTOR, INC." Neither is a prefix of the other and no amount of
    // suffix-stripping brings them together — but only one employer in 52,522
    // begins with "marvell", so the word itself identifies the company.
    //
    // The rarity test is the whole safety of this: "applied" begins both
    // Applied Materials and Applied Intuition, so it identifies nothing and no
    // match is made. A word has to be at least six characters AND unique
    // across the Department's entire file.
    const firstWord = norm.split(' ')[0];
    if (firstWord && firstWord.length >= 6) {
      const owners = firstOf.get(firstWord);
      if (owners && owners.length === 1) {
        out.set(company, { key: owners[0], how: 'token' });
        continue;
      }
    }
    out.set(company, { key: '', how: 'none' });
  }
  return out;
}

/**
 * The one-line verdict a card shows. Deliberately a sentence rather than a
 * score: "sponsors" is not a number, and the level is the part he has to act
 * on.
 */
export function verdictFor(s, { now = new Date() } = {}) {
  if (!s || !s.certified) return { tier: 'none', line: 'No certified H-1B filing in this data' };
  const year = Number(String(s.lastDecision || '').slice(0, 4)) || 0;
  const stale = year && (now.getUTCFullYear() - year) >= 2;
  const lvl = s.engModalLevel || s.modalLevel;
  const where = s.engCertified ? 'in mechanical/industrial engineering' : 'across all occupations';
  const levelPart = lvl
    ? `, usually at Level ${['I', 'II', 'III', 'IV'][lvl - 1]} (${lvl} lottery ${lvl === 1 ? 'entry' : 'entries'})`
    : '';
  return {
    tier: stale ? 'lapsed' : s.engCertified >= 3 ? 'strong' : 'yes',
    line: `${s.certified.toLocaleString()} certified H-1B filing${s.certified === 1 ? '' : 's'}`
      + `${s.engCertified ? `, ${s.engCertified} ${where}` : ''}${levelPart}`
      + `${stale ? ` — but nothing since ${year}` : ''}`,
  };
}
