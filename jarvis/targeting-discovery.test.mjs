// Company discovery follows the preset (jarvis/targeting.mjs).
//
// The default person (the hardware-engineering preset) must see exactly what
// the code did before the targeting moved into presets; the finance-data test
// person must get the finance values. The finance checks run in a child
// process, because the person is read once, when targeting.mjs is first
// imported, and this process is pinned to the default.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FINANCE_PROFILE = path.join(HERE, 'presets', 'finance-data', 'test-profile.yml');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

// ── what the probe asks, in either process ──────────────────────────
const PROBE = `
const u = (f) => ${JSON.stringify(pathToFileURL(HERE).href)} + '/' + f;
const t = await import(u('targeting.mjs'));
const hs = await import(u('hiring-signals.mjs'));
const li = await import(u('discover-linkedin.mjs'));
const so = await import(u('discover-sources.mjs'));
const ats = await import(u('discover-ats.mjs'));
const lca = await import(u('lca.mjs'));
const au = await import(u('audit-new-boards.mjs'));
const rb = await import(u('reboard.mjs'));
const titles = ['Financial Analyst', 'FP&A Analyst', 'Data Analyst', 'Business Analyst', 'Investment Banking Analyst',
  'Staff Accountant', 'Audit Associate', 'Mechanical Engineer', 'Manufacturing Engineer', 'Sales Associate',
  'Bank Teller', 'Financial Advisor', 'Software Engineer', 'HVAC Mechanical Engineer'];
const companies = ['JPMorgan Chase', 'Deloitte', 'PwC', 'Bank of America', 'GEICO', 'Armanino LLP', 'Accenture',
  'Jacobs', 'Lockheed Martin', 'Robert Half', 'CyberCoders', 'Insight Global', 'Primerica', 'Applied Materials'];
const sim = rb.simplifyBoards([
  { company_name: 'A', url: 'https://x/1', date_posted: Date.now() / 1000, locations: ['New York, NY'], category: 'Hardware' },
  { company_name: 'A', url: 'https://x/2', date_posted: Date.now() / 1000, locations: ['New York, NY'], category: 'Quant' },
  { company_name: 'A', url: 'https://x/3', date_posted: Date.now() / 1000, locations: ['New York, NY'], category: 'AI/ML/Data' },
], (n) => n.toLowerCase());
const out = {
  preset: t.person.preset,
  usPerson: t.person.usPerson,
  worth: Object.fromEntries(titles.map((x) => [x, hs.worthTracking(x)])),
  never: Object.fromEntries(companies.map((x) => [x, hs.NEVER_TRACK.test(x)])),
  gated: Object.fromEntries(['Lockheed Martin', 'Anduril', 'overland-ai.com', 'MosaicML', 'Goldman Sachs'].map((x) => [x, ats.isClearanceGated(x)])),
  soc: Object.fromEntries(['13-2051', '13-2051.00', '15-2051', '13-2011', '17-2141', '15-1252'].map((x) => [x, lca.HIS_SOCS.test(x)])),
  queries: li.DEFAULT_QUERIES.slice(0, 3),
  metros: li.METROS.slice(0, 3).map((m) => m.name),
  sourceQueries: so.SOURCE_QUERIES.slice(0, 2),
  muse: so.MUSE_CATEGORIES,
  ycHint: ['Financial Analysts', 'Mechanical Engineers'].map((x) => so.PHYSICAL_HINT_RE.test(x)),
  seedTags: ats.looksHardware({ tags: ['Fintech'] }) + '/' + ats.looksHardware({ tags: ['Robotics'] }),
  audit: au.judgeBoard(['Financial Analyst', 'Data Analyst', 'Staff Accountant', 'FP&A Analyst', 'Tax Associate', 'Audit Associate']).verdict,
  auditSoftware: au.judgeBoard(['Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Data Engineer', 'SRE', 'Product Manager']).verdict,
  simplifyField: sim.get('a').hardware,
  verdict: lca.verdictFor({ certified: 10, engCertified: 4, lastDecision: new Date().toISOString() }).line,
};
console.log(JSON.stringify(out));
`;

// A script file rather than `-e`: some of these modules read process.argv[1].
const PROBE_DIR = mkdtempSync(path.join(tmpdir(), 'targeting-discovery-'));
const PROBE_PATH = path.join(PROBE_DIR, 'probe.mjs');
writeFileSync(PROBE_PATH, PROBE);

function runAs(profile) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (profile) env.JARVIS_PROFILE = profile; else delete env.JARVIS_PROFILE;
  const r = spawnSync(process.execPath, [PROBE_PATH], { env, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) { console.log(r.stderr); throw new Error(`probe failed (${r.status})`); }
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// ── the default person, in this (pinned) process ────────────────────
console.log('\n🧪 discovery targeting: the default person is unchanged');
{
  const PROBE_FILE = `data:text/javascript,${encodeURIComponent(PROBE.replace('console.log(JSON.stringify(out));', 'export default out;'))}`;
  const d = (await import(PROBE_FILE)).default;
  check('default preset', d.preset, 'hardware-engineering');
  check('a mechanical title is worth tracking', d.worth['Mechanical Engineer'], true);
  check('…a manufacturing one too', d.worth['Manufacturing Engineer'], true);
  check('an HVAC title is not (building services)', d.worth['HVAC Mechanical Engineer'], false);
  check('a financial analyst is not', d.worth['Financial Analyst'], false);
  check('banks, insurers, LLPs and the Big Four are never tracked',
    ['JPMorgan Chase', 'Deloitte', 'PwC', 'Bank of America', 'GEICO', 'Armanino LLP'].map((c) => [c, d.never[c]]),
    [['JPMorgan Chase', false], ['Deloitte', true], ['PwC', true], ['Bank of America', true], ['GEICO', true], ['Armanino LLP', true]]);
  check('Accenture and AEC firms are never tracked', [d.never.Accenture, d.never.Jacobs], [true, true]);
  check('defense primes are never tracked', d.never['Lockheed Martin'], true);
  check('staffing agencies are never tracked', [d.never['Robert Half'], d.never.CyberCoders, d.never['Insight Global']], [true, true, true]);
  check('a real employer is kept', d.never['Applied Materials'], false);
  check('clearance gate: Lockheed, Anduril and the overland-ai.com domain', [d.gated['Lockheed Martin'], d.gated.Anduril, d.gated['overland-ai.com']], [true, true, true]);
  check('…but not MosaicML (F-440) or a bank', [d.gated.MosaicML, d.gated['Goldman Sachs']], [false, false]);
  check('his SOC families: 17-2141 yes, 13-2051 and 15-1252 no', [d.soc['17-2141'], d.soc['13-2051'], d.soc['15-1252']], [true, false, false]);
  check('LinkedIn queries start as before', d.queries, ['robotics engineer', 'mechanical engineer new grad', 'manufacturing engineer new grad']);
  check('metros start as before', d.metros, ['San Francisco Bay Area', 'Los Angeles Metropolitan Area', 'Greater Boston']);
  check('Built In / Climatebase queries as before', d.sourceQueries, ['mechanical engineer', 'robotics engineer']);
  check('The Muse: Science and Engineering', d.muse, ['Science and Engineering']);
  check('YC headline hint: physical work only', d.ycHint, [false, true]);
  check('seed tags: robotics yes, fintech no', d.seedTags, 'false/true');
  check('an all-finance board is suspect for him', d.audit, 'suspect');
  check('Simplify: only the Hardware category counts', d.simplifyField, 1);
  check('card verdict names his field', /4 in mechanical\/industrial engineering/.test(d.verdict), true);
}

// ── the finance test person, in a child process ─────────────────────
console.log('\n🧪 discovery targeting: the finance-data preset');
{
  const f = runAs(FINANCE_PROFILE);
  check('finance preset is active', [f.preset, f.usPerson], ['finance-data', true]);
  check('Financial Analyst is worth tracking', f.worth['Financial Analyst'], true);
  check('…FP&A, data, business, IB analysts, accountants, audit associates too',
    ['FP&A Analyst', 'Data Analyst', 'Business Analyst', 'Investment Banking Analyst', 'Staff Accountant', 'Audit Associate'].map((x) => f.worth[x]),
    [true, true, true, true, true, true]);
  check('Mechanical Engineer is not', f.worth['Mechanical Engineer'], false);
  check('nor sales, tellers, advisors or software', ['Sales Associate', 'Bank Teller', 'Financial Advisor', 'Software Engineer'].map((x) => f.worth[x]),
    [false, false, false, false]);
  check('JPMorgan Chase and Deloitte are no longer rejected', [f.never['JPMorgan Chase'], f.never.Deloitte], [false, false]);
  check('…nor PwC, Bank of America, GEICO, an LLP or Accenture',
    ['PwC', 'Bank of America', 'GEICO', 'Armanino LLP', 'Accenture'].map((x) => f.never[x]), [false, false, false, false, false]);
  check('staffing agencies are still rejected', [f.never['Robert Half'], f.never.CyberCoders, f.never['Insight Global']], [true, true, true]);
  check('commission-only recruiting shops are rejected', f.never.Primerica, true);
  check('a citizen is not clearance-gated', [f.gated['Lockheed Martin'], f.gated.Anduril], [false, false]);
  check('finance SOC families: 13-2051 (and with .00), 15-2051, 13-2011',
    [f.soc['13-2051'], f.soc['13-2051.00'], f.soc['15-2051'], f.soc['13-2011']], [true, true, true, true]);
  check('…not mechanical engineering or software', [f.soc['17-2141'], f.soc['15-1252']], [false, false]);
  check('LinkedIn queries are finance searches', f.queries, ['financial analyst', 'financial analyst new grad', 'FP&A analyst']);
  check('metros start with New York and Chicago', f.metros.slice(0, 2), ['New York City Metropolitan Area', 'Greater Chicago Area']);
  check('Built In queries are finance searches', f.sourceQueries, ['financial analyst', 'data analyst']);
  check('The Muse: finance, data and business categories', f.muse, ['Accounting and Finance', 'Data and Analytics', 'Business Operations']);
  check('YC headline hint: finance roles', f.ycHint, [true, false]);
  check('seed tags: fintech yes, robotics no', f.seedTags, 'true/false');
  check('an all-finance board is a real employer of analysts', f.audit, 'ok');
  check('a software-only board is suspect', f.auditSoftware, 'suspect');
  check('Simplify: Quant and data categories count, Hardware does not', f.simplifyField, 2);
  check('card verdict names the finance families', /4 in finance, accounting and data analysis/.test(f.verdict), true);
}

// ── an F-1 finance person is still clearance-gated ──────────────────
console.log('\n🧪 discovery targeting: the clearance gate follows work authorization');
{
  const f1 = path.join(PROBE_DIR, 'profile.yml');
  writeFileSync(f1, readFileSync(FINANCE_PROFILE, 'utf8').replace(/work_authorization: "citizen"/, 'work_authorization: "f1"'));
  const g = runAs(f1);
  check('F-1 finance person: usPerson false', [g.preset, g.usPerson], ['finance-data', false]);
  check('…so defense primes are gated again', [g.gated['Lockheed Martin'], g.gated.Anduril], [true, true]);
  check('…and a bank is not', g.gated['Goldman Sachs'], false);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
