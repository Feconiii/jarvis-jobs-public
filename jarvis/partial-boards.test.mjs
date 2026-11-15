// A careers page that links a readable board AND one nothing here reads makes
// the employer partial, not tracked, so the LinkedIn sweep covers it.
// The shape is Bastian Solutions (2026-11-07): its page links the Toyota
// Automated Logistics Workday board it shares (no Greenfield postings on it)
// and an ADP MyJobs board; the ledger said "tracked" and nothing swept it.

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unreadableBoardIn, platformOf } from './branded-boards.mjs';
import * as ats from './discover-ats.mjs';
import * as H from './ats-holds.mjs';
import { openUniverse, ingest, record, sync, due, linkedinSweep, keyOf } from './universe.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const TAL = 'https://vanderlande.wd3.myworkdayjobs.com/TALExternalCareers';
const BASTIAN_PAGE = `<html><body><h1>Careers at Bastian Solutions</h1>
  <a href="${TAL}">Search jobs</a>
  <a href="https://myjobs.adp.com/talcareers/cx">Greenfield, Indiana openings</a></body></html>`;

console.log('\n🧪 partial boards: a second board nothing reads');
{
  check('ADP MyJobs is a board nothing reads', unreadableBoardIn(BASTIAN_PAGE), 'adp-myjobs');
  const a = (u) => `<a href="${u}">Jobs</a>`;
  check('a readable platform is not a second board (UKG, ADP Workforce Now, Paylocity)',
    ['https://recruiting.ultipro.com/X/JobBoard/1', 'https://workforcenow.adp.com/mascsr/x', 'https://recruiting.paylocity.com/recruiting/jobs/All/1'].map((u) => unreadableBoardIn(a(u))), ['', '', '']);
  check('…nor a refusal', unreadableBoardIn('cf-chl- challenge-platform'), '');
  check('a board embedded as a frame counts', unreadableBoardIn('<iframe src="https://myjobs.adp.com/talcareers/cx"></iframe>'), 'adp-myjobs');
  check('a tenant link counts (Paycom, Dayforce, Taleo)',
    ['https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=X', 'https://jobs.dayforcehcm.com/en-US/acme/CANDIDATEPORTAL', 'https://acme.taleo.net/careersection/2/jobsearch.ftl'].map((u) => unreadableBoardIn(a(u))),
    ['paycom', 'dayforce', 'taleo']);
  // First Mate's review: only what the page links, never what it loads or says.
  check('a "powered by Paycor" footer script is not a board',
    unreadableBoardIn('<footer>Powered by Paycor <script src="https://recruitingbypaycor.com/widget.js"></script></footer>'), '');
  check('…nor a "powered by" link to the vendor\'s own site', unreadableBoardIn(a('https://www.paycor.com/') + a('https://www.avature.net/') + a('https://www.taleo.net/')), '');
  check('…nor a Radancy/TalentBrew script or stylesheet',
    unreadableBoardIn('<script src="https://tbcdn.talentbrew.com/x.js"></script><link href="https://cdn.radancy.com/a.css" rel="stylesheet">'), '');
  check('…nor a vendor named in a script body', unreadableBoardIn('<script>var u = "https://myjobs.adp.com/x";</script>'), '');
  check('platformOf still names misses as before', platformOf('https://recruiting.ultipro.com/X'), 'ukg');
}

console.log('\n🧪 partial boards: the resolver says what else the page links');
{
  const realFetch = globalThis.fetch;
  const sent = [];
  const FOOTER_PAGE = `<html><body><a href="${TAL}">Search jobs</a>
    <footer>Powered by Paycor <script src="https://recruitingbypaycor.com/widget.js"></script></footer></body></html>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    sent.push(u);
    if (u.startsWith('https://bastiansolutions.com/careers')) return new Response(BASTIAN_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.startsWith('https://footerco.com/careers')) return new Response(FOOTER_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.includes('/wday/cxs/vanderlande/TALExternalCareers/jobs')) return new Response(JSON.stringify({ total: 57, jobPostings: [] }), { status: 200 });
    return new Response('', { status: 404 });
  };
  ats._configureHolds({ file: '', state: H.emptyState() });
  try {
    const hit = await ats.resolveViaCareersPage('https://bastiansolutions.com', 'Bastian Solutions', { authoritative: true });
    check('the shared Workday board is found', hit?.entry?.careers_url, TAL);
    check('…and the ADP MyJobs board beside it is named', hit?.alsoUnreadable, 'adp-myjobs');
    check('no request went to ADP MyJobs (nothing reads it)', sent.some((u) => u.includes('myjobs.adp.com')), false);
    const footer = await ats.resolveViaCareersPage('https://footerco.com', 'Footer Co', { authoritative: true });
    check('a shared board with only a "powered by Paycor" footer script: no second board…', [footer?.entry?.careers_url, footer?.alsoUnreadable], [TAL, undefined]);
    check('…so it stays a dupe (tracked through the shared board)', ats.settledOutcome(footer)[0], 'dupe');
  } finally {
    globalThis.fetch = realFetch;
    ats._configureHolds({ file: '', state: H.emptyState() });
  }
}

console.log('\n🧪 partial boards: how it is settled');
{
  const shared = { entry: { name: 'Bastian Solutions', careers_url: TAL }, provider: 'workday', count: 57, alsoUnreadable: 'adp-myjobs' };
  check('a board someone else owns, beside one nothing reads: partial',
    ats.settledOutcome(shared), ['partial', { provider: 'workday', url: TAL, also: 'adp-myjobs' }]);
  const plain = { ...shared, alsoUnreadable: undefined };
  check('the same board alone: still a dupe', ats.settledOutcome(plain)[0], 'dupe');
  check('gated stays gated', ats.settledOutcome(shared, { gated: true })[0], 'gated');
  check('its own new board: tracked, and the second board is recorded', ats.settledOutcome(shared, { admitted: true, write: true }),
    ['tracked', { provider: 'workday', url: TAL, count: 57, also: 'adp-myjobs' }]);
  check('a dry run: found', ats.settledOutcome(shared, { admitted: true })[0], 'found');
  check('a Workday tenant without its site: partial, as before',
    ats.settledOutcome({ partial: true, tenant: 'acme', instance: 'wd5' }), ['partial', { url: 'https://acme.wd5.myworkdayjobs.com/' }]);
  check('a miss names its platform, as before', ats.settledOutcome({ miss: true, platform: 'paycom' }), ['miss', { platform: 'paycom' }]);
}

console.log('\n🧪 partial boards: the ledger, and the sweep');
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'partial-boards-'));
  const db = openUniverse(path.join(dir, 'u.db'));
  try {
    const now = new Date('2026-11-07T00:00:00Z');
    ingest(db, [{ name: 'Bastian Solutions', titles: ['Mechanical Engineer'], count: 3 }], 'lca');
    // Today's row: settled as the shared board, "tracked".
    record(db, [{ name: 'Bastian Solutions', outcome: 'dupe', url: TAL, provider: 'workday' }], { now });
    const entries = [{ name: 'Toyota Automated Logistics', careers_url: TAL, enabled: true }];
    sync(db, entries);
    const key = keyOf('Bastian Solutions');
    const row = () => db.prepare('SELECT state, outcome, platform, next_attempt FROM employers WHERE key = ?').get(key);
    check('before: tracked through the shared board', row().state, 'tracked');
    check('…so it is never due again', due(db, { now: now.toISOString() }).map((r) => r.name), []);
    check('--recheck-shared asks it once more', due(db, { now: now.toISOString(), shared: true }).map((r) => r.name), ['Bastian Solutions']);
    // The recheck finds the ADP board beside it.
    record(db, [{ name: 'Bastian Solutions', outcome: 'partial', url: TAL, provider: 'workday', also: 'adp-myjobs' }], { now });
    sync(db, entries);
    const r = row();
    check('after: partial, named by the board nothing reads, and it stays partial through sync', [r.state, r.platform], ['partial', 'adp-myjobs']);
    check('…the outcome says why', /also links adp-myjobs/.test(r.outcome), true);
    const asked = [];
    const res = await linkedinSweep(db, {
      budget: 10, now, log: () => {},
      harvestImpl: async (terms) => { asked.push(terms[0]); return { postings: [{ company: 'Bastian Solutions', title: 'Mechanical Engineer' }] }; },
      importImpl: async () => {},
    });
    check('the LinkedIn sweep now reads it', asked.length === 1 && /^Bastian Solutions /.test(asked[0]), true);
    check('…and finds its postings', res.counts['hiring-hw'], 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
