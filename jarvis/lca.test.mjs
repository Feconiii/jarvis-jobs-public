#!/usr/bin/env node
/**
 * The LCA reader, against a synthetic disclosure file in the real format.
 *
 * The fixture is built with the same ZIP writer the xlsx test uses, with the
 * Department of Labor's own column names in the Department's own order, so
 * what is under test is the whole path: archive → shared strings → header
 * mapping → aggregation → employer matching.
 *
 * THE MATCHING TESTS MATTER MOST. A false match tells him an employer sponsors
 * when it is a different company with a similar name, which is worse than
 * knowing nothing — so "Apple" must never match "Applebee's", and the pairs
 * below are the real spellings out of his own store and out of DOL's file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  normalizeEmployer, mapHeader, annualWage, wageLevel, aggregateLca,
  summarise, matchEmployers, verdictFor, HIS_SOCS,
} from './lca.mjs';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};

// ── 1. names ────────────────────────────────────────────────────────
console.log('🧪 lca: one employer, however it is spelled');

const N = normalizeEmployer;
check('a legal suffix comes off', N('APPLIED MATERIALS, INC.'), 'applied materials');
check('…and so does a stack of them', N('Acme Technologies Group Holdings LLC'), 'acme technologies');
check('a Workday entity number comes off', N('0001 Applied Materials, Inc'), 'applied materials');
check('the plain form is already normal', N('Applied Materials'), 'applied materials');
check('punctuation goes', N('Johnson & Johnson'), 'johnson johnson');
check('a DBA is dropped', N('SUNRISE SYSTEMS DBA SUNRISE TECH'), 'sunrise systems');
check('"USA" is furniture', N('ASML US, LLC'), 'asml');
// THE ONE THAT MUST NOT HAPPEN: stripping a suffix out of the middle of a word.
check('INC inside a word survives', N('Princeton Incubator'), 'princeton incubator');
check('CO inside a word survives', N('Corning'), 'corning');
check('a name that is only a suffix is not erased to nothing', N('The Company') !== '', true);

// ── 2. the small conversions ────────────────────────────────────────
console.log('🧪 lca: wages and levels');
check('an annual wage is itself', annualWage('135000', 'Year'), 135000);
check('an hourly wage is annualised', annualWage('65.00', 'Hour'), 135200);
check('a monthly wage is annualised', annualWage('9000', 'Month'), 108000);
check('currency formatting is tolerated', annualWage('$135,000', 'Year'), 135000);
check('a missing wage is zero, not NaN', annualWage('', 'Year'), 0);
check('"Level II" is 2', wageLevel('Level II'), 2);
check('a bare roman numeral works', wageLevel('IV'), 4);
check('a digit works', wageLevel('2'), 2);
check('a blank level is 0, meaning "not stated"', wageLevel(''), 0);
check('his own SOC is recognised', HIS_SOCS.test('17-2141'), true);
check('…and a software SOC is not', HIS_SOCS.test('15-1252'), false);

// ── 3. a disclosure file, read whole ────────────────────────────────
console.log('🧪 lca: a file in the Department\'s own format');

function zip(files) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const body = deflateRawSync(data);
    const crc = crc32(data);
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + body.length;
  }
  const cen = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cen.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, e]);
}

// DOL's real header, in DOL's real order, with columns between the ones we
// want — so a reader that counted positions instead of reading names fails.
const HEADER = ['CASE_NUMBER', 'CASE_STATUS', 'RECEIVED_DATE', 'DECISION_DATE', 'VISA_CLASS',
  'JOB_TITLE', 'SOC_CODE', 'SOC_TITLE', 'FULL_TIME_POSITION', 'BEGIN_DATE', 'END_DATE',
  'TOTAL_WORKER_POSITIONS', 'NEW_EMPLOYMENT', 'EMPLOYER_NAME', 'EMPLOYER_CITY', 'EMPLOYER_STATE',
  'WORKSITE_CITY', 'WORKSITE_STATE', 'WAGE_RATE_OF_PAY_FROM', 'WAGE_UNIT_OF_PAY',
  'PREVAILING_WAGE', 'PW_WAGE_LEVEL'];

const ROWS = [
  // employer,              status,    visa,  soc,       title,                    wage,     unit,   level, state, decided, positions
  ['APPLIED MATERIALS, INC.', 'Certified', 'H-1B', '17-2141', 'Mechanical Engineer', '112000', 'Year', 'Level II', 'CA', '2026-05-04', '2'],
  ['APPLIED MATERIALS, INC.', 'Certified', 'H-1B', '17-2141', 'Process Engineer', '118000', 'Year', 'Level II', 'TX', '2026-06-01', '1'],
  ['APPLIED MATERIALS, INC.', 'Certified', 'H-1B', '15-1252', 'Software Engineer', '168000', 'Year', 'Level IV', 'CA', '2026-06-02', '1'],
  ['APPLIED MATERIALS, INC.', 'Denied', 'H-1B', '17-2141', 'Mechanical Engineer', '99000', 'Year', 'Level I', 'CA', '2026-02-02', '1'],
  // An hourly filing, to prove annualisation reaches the mean.
  ['MICRON TECHNOLOGY, INC.', 'Certified', 'H-1B', '17-2112', 'Industrial Engineer', '60.00', 'Hour', 'Level I', 'ID', '2026-04-04', '1'],
  ['MICRON TECHNOLOGY, INC.', 'Certified-Withdrawn', 'H-1B', '17-2141', 'Equipment Engineer', '104000', 'Year', 'Level I', 'ID', '2026-04-05', '1'],
  // Another visa class entirely — must not count.
  ['MICRON TECHNOLOGY, INC.', 'Certified', 'E-3 Australian', '17-2141', 'Mechanical Engineer', '150000', 'Year', 'Level IV', 'ID', '2026-04-06', '1'],
  // An employer whose only filings are old.
  ['LEGACY FAB CORP', 'Certified', 'H-1B', '17-2141', 'Mechanical Engineer', '90000', 'Year', 'Level I', 'NY', '2019-03-03', '1'],
  // A company with a similar name to one of his, which must NOT be matched.
  ['APPLEBEES SERVICES INC', 'Certified', 'H-1B', '11-9051', 'Food Service Manager', '70000', 'Year', 'Level I', 'KS', '2026-01-01', '1'],
  // A subsidiary spelling, to exercise the prefix rule.
  ['LAM RESEARCH INTERNATIONAL SARL', 'Certified', 'H-1B', '17-2141', 'Mechanical Engineer', '141000', 'Year', 'Level III', 'OR', '2026-07-07', '3'],
];

const strings = [];
const sidx = new Map();
const S = (v) => { const k = String(v); if (!sidx.has(k)) { sidx.set(k, strings.length); strings.push(k); } return sidx.get(k); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

let sheet = '<?xml version="1.0"?><worksheet><sheetData>';
sheet += `<row r="1">${HEADER.map((h, i) => `<c r="${String.fromCharCode(65 + i)}1" t="s"><v>${S(h)}</v></c>`).join('')}</row>`;
ROWS.forEach((r, n) => {
  const [emp, status, visa, soc, title, wage, unit, level, state, decided, positions] = r;
  const cols = new Array(HEADER.length).fill('');
  cols[1] = status; cols[3] = decided; cols[4] = visa; cols[5] = title; cols[6] = soc;
  cols[11] = positions; cols[13] = emp; cols[15] = state; cols[17] = state;
  cols[18] = wage; cols[19] = unit; cols[21] = level;
  const row = cols.map((v, i) => (v === '' ? '' : `<c r="${String.fromCharCode(65 + i)}${n + 2}" t="s"><v>${S(v)}</v></c>`)).join('');
  sheet += `<row r="${n + 2}">${row}</row>`;
});
// THE PADDING DOL ACTUALLY SHIPS. FY2026 Q3 holds 437,496 applications and is
// then padded to row 1,032,736 with rows that carry a style and no value —
// 58% of the sheet. Counting those as "skipped" reads as though most of the
// Department's data had been thrown away, so they are counted as what they are.
const PAD = 60;
for (let i = 0; i < PAD; i++) {
  const r = ROWS.length + 2 + i;
  sheet += `<row r="${r}" spans="1:22"><c r="C${r}" s="1"/><c r="D${r}" s="1"/><c r="V${r}" s="11"/></row>`;
}
sheet += '</sheetData></worksheet>';
const sst = `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-lca-'));
const file = path.join(dir, 'LCA_Disclosure_Data_TEST.xlsx');
writeFileSync(file, zip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
  ['xl/sharedStrings.xml', sst],
  ['xl/worksheets/sheet1.xml', sheet],
]));

check('the header maps by NAME, not by position', mapHeader(HEADER).employer, 13);

const { byEmployer, rows, empty, dataRows, skipped } = await aggregateLca(file);
check('every data row is counted', dataRows, ROWS.length);
check('…and the padding is counted apart', empty, PAD);
check('…and "not H-1B" is its own number again', skipped, 1);
check('the row total is both together', rows, ROWS.length + PAD);

const amat = summarise('applied materials', byEmployer.get('applied materials'));
check('certified filings are counted', amat.certified, 3);
check('a denial is counted apart', amat.denied, 1);
check('positions are summed, not rows', amat.positions, 4);
check('THE ENGINEERING SOCs ARE KEPT APART FROM THE SOFTWARE ONE', amat.engCertified, 2);
check('…and so is their wage level', amat.engModalLevel, 2);
check('…while the overall modal level includes the Level IV software filing', amat.levels, [0, 2, 0, 1]);
check('the latest decision is the latest, not the last row', amat.lastDecision, '2026-06-02');
check('his own field has its own mean wage', amat.engMedianWage, 115000);

const micron = summarise('micron technology', byEmployer.get('micron technology'));
check('A CERTIFIED-WITHDRAWN FILING STILL COUNTS AS WILLINGNESS', micron.certified, 2);
check('AN E-3 FILING IS NOT AN H-1B FILING', micron.levels.reduce((a, b) => a + b, 0), 2);
check('an hourly wage reaches the mean annualised', micron.engMedianWage, (124800 + 104000) / 2);

// ── 4. matching, which is where a wrong answer costs him ────────────
console.log('🧪 lca: matching his companies to the Department\'s legal names');

const matched = matchEmployers(
  ['Applied Materials', '0001 Applied Materials, Inc', 'Micron Technology', 'Lam Research', 'Apple', 'Nowhere Systems'],
  byEmployer,
);
check('the plain spelling matches exactly', matched.get('Applied Materials').how, 'exact');
check('…and so does the Workday entity spelling', matched.get('0001 Applied Materials, Inc').key, 'applied materials');
check('a subsidiary is reached by prefix', matched.get('Lam Research').key, 'lam research international sarl');
check('…and the match records that it was a prefix', matched.get('Lam Research').how, 'prefix');
check('APPLE DOES NOT MATCH APPLEBEES', matched.get('Apple').how, 'none');
check('an employer with no filings is "none", not a guess', matched.get('Nowhere Systems').how, 'none');

// AN ACRONYM IS NOT AN IDENTITY — found on the first real run, where
// "ATI Inc." matched "ATI HOLDINGS, LLC" (Allegheny Technologies against a
// physical-therapy group) because both normalise to "ati". Short keys still
// match, because "3M" normalises to "3m" and there is only one 3M; they are
// labelled so a wrong one is visible instead of buried.
const acro = matchEmployers(['ATI Inc.'], new Map([['ati', { certified: 36 }]]));
check('a short key is labelled an acronym, not an exact match', acro.get('ATI Inc.').how, 'acronym');
check('…but it is still linked, because most of them are right', acro.get('ATI Inc.').key, 'ati');
const full = matchEmployers(['Applied Materials'], byEmployer);
check('a full-length name is still exact', full.get('Applied Materials').how, 'exact');

// A DISTINCTIVE FIRST WORD, when exactly one employer owns it. "Marvell
// Technology" is his spelling and "MARVELL SEMICONDUCTOR, INC." is the
// Department's; neither is a prefix of the other.
const tokenMap = new Map([['marvell semiconductor', { certified: 269 }], ['applebees services', { certified: 1 }]]);
check('a unique first word links the company', matchEmployers(['Marvell Technology'], tokenMap).get('Marvell Technology').how, 'token');
// …and a word shared by two employers identifies neither.
const shared = new Map([['applied materials', { certified: 476 }], ['applied intuition', { certified: 12 }]]);
check('A WORD TWO EMPLOYERS SHARE LINKS NOTHING', matchEmployers(['Applied Widgets'], shared).get('Applied Widgets').how, 'none');

// A TRADE NAME AND A LEGAL ENTITY SHARE NOTHING, so the link is a recorded
// fact rather than a rule: onsemi files as Semiconductor Components Industries.
const aliased = matchEmployers(['onsemi'], new Map([['semiconductor components', { certified: 96 }]]));
check('a recorded alias links what no rule could', aliased.get('onsemi').how, 'alias');
check('…to the entity that actually files', aliased.get('onsemi').key, 'semiconductor components');
check('an alias for an employer not in the file is not invented',
  matchEmployers(['onsemi'], new Map([['something else', { certified: 1 }]])).get('onsemi').how, 'none');

// ── 5. the sentence he reads ────────────────────────────────────────
console.log('🧪 lca: the verdict is a sentence, not a score');
const now = new Date('2026-09-12T00:00:00Z');
const vAmat = verdictFor(amat, { now });
check('a live sponsor is named as one', vAmat.tier, 'yes');
check('…and the lottery entries are spelled out', /Level II \(2 lottery entries\)/.test(vAmat.line), true);
const vOld = verdictFor(summarise('legacy fab', byEmployer.get('legacy fab')), { now });
check('AN EMPLOYER WHO STOPPED FILING IS NOT A CURRENT SPONSOR', vOld.tier, 'lapsed');
check('…and it says when they stopped', /nothing since 2019/.test(vOld.line), true);
check('no filings at all says exactly that', verdictFor(null).tier, 'none');

try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
