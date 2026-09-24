#!/usr/bin/env node
/**
 * Read a DOL LCA disclosure file into the store.
 *
 *   node jarvis/lca-import.mjs <LCA_Disclosure_Data_FY2026_Q3.xlsx> [--dry-run]
 *   node jarvis/lca-import.mjs --report            # what is already loaded
 *
 * The file comes from
 * https://www.dol.gov/agencies/eta/foreign-labor/performance and has to be
 * downloaded in a BROWSER: dol.gov answers every non-browser request with a
 * 403 from Akamai, the same wall Tesla's careers site puts up, and for the
 * same reason. There is no API and no CSV. Point this at the .xlsx once it is
 * on disk.
 *
 * More than one file can be loaded: a later quarter's numbers REPLACE an
 * employer's row rather than adding to it, because each fiscal year's file is
 * cumulative within that year. Loading FY2025 after FY2026 would therefore
 * move an employer backwards, so the loaded file's label is kept on every row
 * and a smaller `certified` from an older file is refused.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';
import { dbPath as storeDbPath, db as storeDb } from './store.mjs';
import { aggregateLca, summarise, matchEmployers, verdictFor } from './lca.mjs';
import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/lca-import.mjs <file.xlsx> [options]

  Load the Department of Labor's LCA disclosure data. Download the .xlsx from
  https://www.dol.gov/agencies/eta/foreign-labor/performance in a browser first
  — dol.gov refuses every non-browser request.

    --dry-run             read and report, write nothing
    --report              show what is already loaded, read nothing
    --min-certified <n>   only keep employers with at least n certified filings (default 1)
    --help, -h
`;
guardArgs({ usage: USAGE, flags: ['--dry-run', '--report', '--min-certified'], valued: ['--min-certified'] });

const ARGV = process.argv.slice(2);
const arg = (n, d) => { const i = ARGV.indexOf(`--${n}`); return i === -1 ? d : ARGV[i + 1]; };
const DRY = ARGV.includes('--dry-run');
const REPORT = ARGV.includes('--report');
const MIN_CERT = Number(arg('min-certified', 1)) || 1;

const DDL = `
CREATE TABLE IF NOT EXISTS lca_employers (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  certified      INTEGER NOT NULL DEFAULT 0,
  denied         INTEGER NOT NULL DEFAULT 0,
  positions      INTEGER NOT NULL DEFAULT 0,
  last_decision  TEXT,
  l1 INTEGER NOT NULL DEFAULT 0, l2 INTEGER NOT NULL DEFAULT 0,
  l3 INTEGER NOT NULL DEFAULT 0, l4 INTEGER NOT NULL DEFAULT 0,
  modal_level    INTEGER NOT NULL DEFAULT 0,
  median_wage      INTEGER NOT NULL DEFAULT 0,
  -- HIS OWN OCCUPATIONAL FAMILY, KEPT APART. An employer that files 3,000
  -- software LCAs and has never filed for a mechanical engineer is a different
  -- proposition, and the aggregate would call them the same.
  eng_certified  INTEGER NOT NULL DEFAULT 0,
  e1 INTEGER NOT NULL DEFAULT 0, e2 INTEGER NOT NULL DEFAULT 0,
  e3 INTEGER NOT NULL DEFAULT 0, e4 INTEGER NOT NULL DEFAULT 0,
  eng_modal_level INTEGER NOT NULL DEFAULT 0,
  eng_median_wage   INTEGER NOT NULL DEFAULT 0,
  top_states     TEXT NOT NULL DEFAULT '',
  top_titles     TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS lca_cert ON lca_employers(certified DESC);
CREATE INDEX IF NOT EXISTS lca_eng  ON lca_employers(eng_certified DESC);

-- How one of HIS company spellings reaches a DOL legal name, and how confident
-- that link is. Kept apart from the data so a re-import does not have to
-- re-decide, and so a wrong link can be seen and corrected.
CREATE TABLE IF NOT EXISTS company_lca (
  company TEXT PRIMARY KEY,
  key     TEXT NOT NULL DEFAULT '',
  how     TEXT NOT NULL DEFAULT '',
  at      TEXT
);
`;

/**
 * Every column the DDL above declares on lca_employers — read out of the
 * lca_employers block ALONE. A regex over the whole DDL also collects
 * company_lca's columns, which lca_employers does not have, so the schema
 * check would find them "missing" and rebuild on every single run.
 */
const LCA_COLUMNS = (() => {
  const body = DDL.slice(DDL.indexOf('CREATE TABLE IF NOT EXISTS lca_employers'));
  const decl = body.slice(0, body.indexOf(');'));
  return [...decl.matchAll(/(?:^|,)\s*([a-z_0-9]+)\s+(?:TEXT|INTEGER)/gm)].map((m) => m[1]);
})();

function open() {
  const db = openDb(storeDbPath());
  // `CREATE TABLE IF NOT EXISTS` DOES NOTHING TO A TABLE THAT ALREADY EXISTS —
  // db.mjs says so at the top of its own schema and it caught this file too.
  // The first import created `mean_wage`; switching to a median renamed it, and
  // the DDL then ran happily against a table that had neither.
  //
  // Every row here is DERIVED FROM THE FILE and owned by nobody, so the repair
  // is to rebuild rather than to migrate: no user decision lives in these two
  // tables, and a schema that drifts silently is how the next fiscal year's
  // extra column becomes a mystery.
  const have = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lca_employers'").get();
  if (have) {
    const cols = new Set(db.prepare('PRAGMA table_info(lca_employers)').all().map((c) => c.name));
    const missing = LCA_COLUMNS.filter((c) => !cols.has(c));
    if (missing.length) {
      console.log(`  schema changed (${missing.join(', ')}) — rebuilding the LCA tables, which are derived from the file`);
      db.exec('DROP TABLE IF EXISTS lca_employers');
    }
  }
  db.exec(DDL);
  return db;
}

// ── --report ────────────────────────────────────────────────────────
if (REPORT) {
  const db = open();
  const n = db.prepare('SELECT count(*) n FROM lca_employers').get().n;
  if (!n) {
    console.log('\n  Nothing loaded yet.\n  Download LCA_Disclosure_Data_FY2026_Q3.xlsx from');
    console.log('  https://www.dol.gov/agencies/eta/foreign-labor/performance (a browser — dol.gov 403s everything else)');
    console.log('  then:  node jarvis/lca-import.mjs <that file>\n');
    process.exit(0);
  }
  const src = db.prepare('SELECT DISTINCT source FROM lca_employers').all().map((r) => r.source).join(', ');
  const linked = db.prepare("SELECT count(*) n FROM company_lca WHERE key != ''").get().n;
  const total = db.prepare('SELECT count(*) n FROM company_lca').get().n;
  console.log(`\n  ${n.toLocaleString()} employers loaded from ${src}`);
  console.log(`  ${linked} of ${total} of his companies linked to one\n`);
  const rows = db.prepare(`SELECT c.company, e.* FROM company_lca c JOIN lca_employers e ON e.key = c.key
      WHERE e.eng_certified > 0 ORDER BY e.eng_certified DESC LIMIT 25`).all();
  console.log('  Best sponsors in HIS occupational family:\n');
  for (const r of rows) {
    const v = verdictFor({ ...r, engModalLevel: r.eng_modal_level, modalLevel: r.modal_level, lastDecision: r.last_decision, engCertified: r.eng_certified });
    console.log(`  ${String(r.company).slice(0, 30).padEnd(32)} ${v.line}`);
  }
  console.log('');
  process.exit(0);
}

// ── the import ──────────────────────────────────────────────────────
const file = ARGV.find((a) => /\.xlsx$/i.test(a));
if (!file) { console.error(USAGE); process.exit(1); }
if (!existsSync(file)) { console.error(`\n  No such file: ${file}\n`); process.exit(1); }

const label = path.basename(file);
const mb = (statSync(file).size / 1048576).toFixed(1);
console.log(`\n  Reading ${label} (${mb} MB)…`);
const started = Date.now();

const { byEmployer, rows, skipped, empty, dataRows, lastDataRow } = await aggregateLca(file, {
  onProgress: ({ rows: n, employers }) => {
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    process.stdout.write(`\r    ${n.toLocaleString()} rows · ${employers.toLocaleString()} employers · ${secs}s   `);
  },
});
process.stdout.write('\r' + ' '.repeat(78) + '\r');
console.log(`  ${dataRows.toLocaleString()} applications read · ${byEmployer.size.toLocaleString()} employers · ${skipped.toLocaleString()} not H-1B (E-3, H-1B1)`);
// AN EMPTY ROW IS NOT A SKIPPED ONE, and this file is 58% empty rows. Saying
// so is the difference between "we ignored most of the Department's data" and
// "Excel padded the sheet".
if (empty) console.log(`  the sheet is padded: data ends at row ${lastDataRow.toLocaleString()}, ${empty.toLocaleString()} trailing rows carry a style and no value`);

const kept = [];
for (const [key, rec] of byEmployer) {
  if (rec.certified < MIN_CERT) continue;
  kept.push(summarise(key, rec));
}
console.log(`  ${kept.length.toLocaleString()} employers with at least ${MIN_CERT} certified filing`);

// HIS companies, matched.
// `distinctCompanies()` in store.mjs returns the COUNT, not the names.
const companies = storeDb().prepare("SELECT DISTINCT company FROM jobs WHERE company != ''").all().map((r) => r.company);
const matches = matchEmployers(companies, byEmployer);
const byHow = {};
for (const m of matches.values()) byHow[m.how] = (byHow[m.how] || 0) + 1;
console.log(`  his ${companies.length} companies: ` + Object.entries(byHow).map(([k, v]) => `${v} ${k}`).join(' · '));

// EVERY ACRONYM MATCH, LISTED. These are the ones that can be wrong in a way
// nothing else catches: a three-letter name is not an identity, and only he
// knows whether "ATI" means Allegheny Technologies or a physical-therapy group.
const acronyms = [...matches.entries()].filter(([, m]) => m.how === 'acronym');
if (acronyms.length) {
  console.log(`\n  ${acronyms.length} matched on a short name — check these, an acronym is not an identity:`);
  for (const [company, m] of acronyms) {
    const s = summarise(m.key, byEmployer.get(m.key));
    const eng = s.engCertified ? `${s.engCertified} in engineering` : 'NONE in engineering';
    console.log(`    ${company.slice(0, 26).padEnd(28)} → ${s.name.slice(0, 32).padEnd(34)} ${s.certified} filings, ${eng}`);
  }
}

if (DRY) {
  console.log('\n  Dry run — nothing written.\n');
  const sample = companies.filter((c) => matches.get(c)?.how !== 'none').slice(0, 15);
  for (const c of sample) {
    const m = matches.get(c);
    const s = summarise(m.key, byEmployer.get(m.key));
    console.log(`    ${c.slice(0, 28).padEnd(30)} → ${s.name.slice(0, 34).padEnd(36)} ${verdictFor(s).line}`);
  }
  console.log('');
  process.exit(0);
}

const db = open();
const now = new Date().toISOString();

const put = db.prepare(`INSERT INTO lca_employers
    (key,name,certified,denied,positions,last_decision,l1,l2,l3,l4,modal_level,median_wage,
     eng_certified,e1,e2,e3,e4,eng_modal_level,eng_median_wage,top_states,top_titles,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET
    name=excluded.name, certified=excluded.certified, denied=excluded.denied,
    positions=excluded.positions, last_decision=excluded.last_decision,
    l1=excluded.l1, l2=excluded.l2, l3=excluded.l3, l4=excluded.l4,
    modal_level=excluded.modal_level, median_wage=excluded.median_wage,
    eng_certified=excluded.eng_certified, e1=excluded.e1, e2=excluded.e2, e3=excluded.e3, e4=excluded.e4,
    eng_modal_level=excluded.eng_modal_level, eng_median_wage=excluded.eng_median_wage,
    top_states=excluded.top_states, top_titles=excluded.top_titles, source=excluded.source
  -- AN OLDER FILE NEVER OVERWRITES A NEWER ONE. Each fiscal year's file is
  -- cumulative within its own year, so loading FY2025 after FY2026 would move
  -- every employer backwards.
  WHERE excluded.last_decision >= lca_employers.last_decision`);

db.exec('BEGIN');
try {
  for (const s of kept) {
    put.run(s.key, s.name, s.certified, s.denied, s.positions, s.lastDecision,
      s.levels[0], s.levels[1], s.levels[2], s.levels[3], s.modalLevel, s.medianWage,
      s.engCertified, s.engLevels[0], s.engLevels[1], s.engLevels[2], s.engLevels[3],
      s.engModalLevel, s.engMedianWage, s.topStates.join(','), s.topTitles.join(' | '), label);
  }
  const link = db.prepare(`INSERT INTO company_lca (company,key,how,at) VALUES (?,?,?,?)
    ON CONFLICT(company) DO UPDATE SET key=excluded.key, how=excluded.how, at=excluded.at`);
  for (const [company, m] of matches) link.run(company, m.key, m.how, now);
  db.exec('COMMIT');
} catch (err) { db.exec('ROLLBACK'); throw err; }

// ── the column the ranker already reads ─────────────────────────────
//
// `sponsors_h1b` was 24 hand-typed booleans. It is now the Department's
// answer: certified filings, and not so long ago that they have plainly
// stopped. The ranker's +20 is unchanged; only the truth of the input is.
const cutoff = `${new Date().getUTCFullYear() - 2}-01-01`;
// COALESCE, because a link can point at an employer that was not KEPT.
// `matchEmployers` links on the name alone, and an employer whose every filing
// was denied or withdrawn has `certified = 0` and is filtered out by
// --min-certified — so the join finds nothing, the subquery returns NULL, and
// the column is NOT NULL. That is the correct answer spelled as a crash: a
// company whose only filings failed does not sponsor.
const upd = storeDb().prepare(`UPDATE jobs SET sponsors_h1b = COALESCE((
    SELECT CASE WHEN e.certified > 0 AND e.last_decision >= ? THEN 1 ELSE 0 END
      FROM company_lca c JOIN lca_employers e ON e.key = c.key
     WHERE c.company = jobs.company), 0)
  WHERE company IN (SELECT company FROM company_lca WHERE key != '')`);
const changed = upd.run(cutoff).changes;

const before = 24;
const nowSponsors = storeDb().prepare('SELECT count(DISTINCT company) n FROM jobs WHERE sponsors_h1b = 1').get().n;
console.log(`\n  Written. ${kept.length.toLocaleString()} employers, ${matches.size} company links.`);
console.log(`  sponsors_h1b: ${before} companies hand-typed → ${nowSponsors} from the Department's own record (${changed.toLocaleString()} postings touched)`);
console.log(`\n  node jarvis/lca-import.mjs --report   to see the best of them\n`);
