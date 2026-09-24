// jarvis/liveness-api.test.mjs — the posting-URL → ATS-API mapping.
//
// Pure and offline: resolveAtsApi() does no I/O, so every case here is a fixed
// input and a fixed expected URL. That matters because the two ways this can be
// wrong are both silent.
//
//   Map too NARROWLY and the ATS is simply never checked — Workday carried 1,113
//   deck postings with no API rung at all, so its dead requisitions could only be
//   found by opening a browser, which in practice meant finding them during an
//   apply run. Two of four random Workday postings sampled were dead.
//
//   Map too LOOSELY and a posting URL steers the request. The SSRF property is
//   that no value from the URL reaches the request verbatim: hosts come from
//   fixed templates and every derived segment must pass SAFE_SEGMENT, which
//   forbids slashes, dots-dot and percent-encoding. The negative cases below are
//   that guard, and they matter more than the positive ones.

import { resolveAtsApi, isAtsPosting, postingMetaFrom, definitelyGone, classifyEightfoldPosition, checkLivenessViaApi, workdayRequisition } from '../liveness-api.mjs';
import { isSuspectWholeSource } from './liveness-sweep.mjs';

let pass = 0, fail = 0;
const ok = (name, got, expected) => {
  if (got === expected) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(got)}`);
};
const apiUrl = (u) => resolveAtsApi(u)?.apiUrl ?? null;
const ats = (u) => resolveAtsApi(u)?.ats ?? null;

console.log('\n🧪 Workday postings map to their CXS API');
// Verified against live requisitions: the dead Intel one answers 404, the live
// KLA one answers 200 with a jobPostingInfo body.
ok('intel external',
  apiUrl('https://intel.wd1.myworkdayjobs.com/External/job/US-New-Mexico-Albuquerque/Facilities-Chemical-Gas-System-Engineer_JR0285741'),
  'https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/job/US-New-Mexico-Albuquerque/Facilities-Chemical-Gas-System-Engineer_JR0285741');
ok('kla search site',
  apiUrl('https://kla.wd1.myworkdayjobs.com/Search/job/Milpitas-CA/NPI-Product-Engineer_2636601'),
  'https://kla.wd1.myworkdayjobs.com/wday/cxs/kla/Search/job/Milpitas-CA/NPI-Product-Engineer_2636601');
// A different data centre, and a tenant containing a digit.
ok('wd5 tenant',
  apiUrl('https://abbott.wd5.myworkdayjobs.com/abbottcareers/job/United-States---Minnesota---Roseville/Quality-Engineer-I_31159180'),
  'https://abbott.wd5.myworkdayjobs.com/wday/cxs/abbott/abbottcareers/job/United-States---Minnesota---Roseville/Quality-Engineer-I_31159180');
// Workday serves the same posting under a locale prefix.
ok('locale prefix is stripped',
  apiUrl('https://jabil.wd5.myworkdayjobs.com/en-US/Jabil_Careers/job/Claremont-NH/Manufacturing-Engineer_J2459834'),
  'https://jabil.wd5.myworkdayjobs.com/wday/cxs/jabil/Jabil_Careers/job/Claremont-NH/Manufacturing-Engineer_J2459834');
ok('workday is recognised as an ATS posting',
  isAtsPosting('https://kla.wd1.myworkdayjobs.com/Search/job/Milpitas-CA/NPI-Product-Engineer_2636601'), true);

console.log('\n🧪 …and nothing else is mistaken for one');
// The SSRF guard. Each of these must map to NOTHING rather than to a request.
ok('a lookalike host does not match', ats('https://myworkdayjobs.com.evil.test/x/job/a/b'), null);
ok('a bare tenant page is not a posting', ats('https://kla.wd1.myworkdayjobs.com/Search'), null);
ok('traversal in a segment is refused',
  ats('https://kla.wd1.myworkdayjobs.com/Search/job/..%2F..%2Fetc/passwd'), null);
ok('percent-encoding is refused',
  ats('https://kla.wd1.myworkdayjobs.com/Search/job/Milpitas%2FCA/Engineer_1'), null);
ok('http is refused', ats('http://kla.wd1.myworkdayjobs.com/Search/job/Milpitas-CA/Engineer_1'), null);
// Three segments after /job/ is a shape we have never seen; measured across the
// deck, all 1,113 Workday postings have exactly two. Unknown shape → no guess.
ok('an unexpected path shape is refused',
  ats('https://kla.wd1.myworkdayjobs.com/Search/job/a/b/c'), null);

console.log('\n🧪 the providers that were already there still map');
ok('greenhouse', ats('https://boards.greenhouse.io/relativity/jobs/8629044002'), 'greenhouse');
ok('lever', ats('https://jobs.lever.co/MachinaLabs/6f1242a2-d690-4ec6-af6f-18f9db2f561a'), 'lever');
ok('ashby', ats('https://jobs.ashbyhq.com/formenergy/ee3cbe4b-a59e-4dda-932a-7bbaca9f5d81'), 'ashby');

console.log('\n🧪 SmartRecruiters postings map to the public API, in both URL forms');
ok('canonical form',
  apiUrl('https://jobs.smartrecruiters.com/AbbVie/3743990014303856-sr-automation-engineer'),
  'https://api.smartrecruiters.com/v1/companies/AbbVie/postings/3743990014303856');
ok('the old /postings/ form the store still carries',
  apiUrl('https://jobs.smartrecruiters.com/abbvie/postings/3743990014303856'),
  'https://api.smartrecruiters.com/v1/companies/abbvie/postings/3743990014303856');
ok('a bare id, no title slug', ats('https://jobs.smartrecruiters.com/WesternDigital/744000139338269'), 'smartrecruiters');
ok('the company board is not a posting', ats('https://jobs.smartrecruiters.com/AbbVie'), null);
ok('a non-numeric id is not a posting', ats('https://jobs.smartrecruiters.com/AbbVie/abc-def'), null);

console.log('\n🧪 Eightfold postings on company hosts map to position_details');
// Measured 2026-09-04: Micron 43943566 (page: "No longer accepting applications")
// answers {status: 404}; Lam 1099554946737 (live) answers {status: 200,
// data.positionUserActions.applyAction.status: "allowed"}. Unauthenticated.
ok('micron',
  apiUrl('https://careers.micron.com/careers/job/43943566-amhs-equipment-engineer-id1-boise-idaho-united-states-of-america?domain=micron.com'),
  'https://careers.micron.com/api/pcsx/position_details?position_id=43943566&domain=micron.com&hl=en');
ok('lam, slug with trailing dash',
  apiUrl('https://careers.lamresearch.com/careers/job/1099554946737-manufacturing-engineer-2-us-ca-fremont-1003-?domain=lamresearch.com'),
  'https://careers.lamresearch.com/api/pcsx/position_details?position_id=1099554946737&domain=lamresearch.com&hl=en');
ok('eightfold is recognised as an ATS posting',
  isAtsPosting('https://careers.qualcomm.com/careers/job/446720251897-mechanical-engineer?domain=qualcomm.com'), true);
ok('no domain parameter, no guess', ats('https://careers.micron.com/careers/job/43943566-x'), null);
ok('a non-numeric id is not eightfold', ats('https://example.com/careers/job/abc?domain=example.com'), null);
ok('the apply page is not the posting', ats('https://careers.lamresearch.com/careers/apply?pid=1099554946737&domain=lamresearch.com'), null);
ok('a domain that is not a hostname is refused', ats('https://careers.micron.com/careers/job/43943566?domain=..%2Fetc'), null);
ok('closed → expired', classifyEightfoldPosition({ status: 404, error: 'not found' })?.result, 'expired');
ok('allowed → active', classifyEightfoldPosition({ status: 200, data: { positionUserActions: { applyAction: { status: 'allowed' } } } })?.result, 'active');
ok('listed but not applyable → expired', classifyEightfoldPosition({ status: 200, data: { positionUserActions: { applyAction: { status: 'closed' } } } })?.result, 'expired');
ok('a sign-in wall is not a closed posting (F-501)', classifyEightfoldPosition({ status: 200, data: { positionUserActions: { applyAction: { status: 'log_in' } } } })?.result, 'active');
ok('an unmeasured apply state is inconclusive, never expired', classifyEightfoldPosition({ status: 200, data: { positionUserActions: { applyAction: { status: 'something_new' } } } }), null);
ok('200 with no actions block → active (listed)', classifyEightfoldPosition({ status: 200, data: {} })?.result, 'active');
ok('an unexpected shape is inconclusive', classifyEightfoldPosition({ status: 500 }), null);
ok('junk is inconclusive', classifyEightfoldPosition('nope'), null);
// Amazon is deliberately ABSENT. It answers 404 to a plain server-side fetch
// even for a LIVE posting — verified on a req the browser check calls active —
// so a naive provider would report every Amazon posting expired and retire 278
// live ones. The browser rung handles Amazon.
ok('amazon is not API-checkable', ats('https://www.amazon.jobs/en/jobs/10382316/robotics-systems-engineer'), null);
ok('tesla is not API-checkable', ats('https://www.tesla.com/careers/search/job/mechanical-design-engineer-automation-261105'), null);

console.log('');
console.log('a source that is 100% dead is a bug report, not a liveness result');
// The guard that was missing when the sweep retired 123 LIVE SmartRecruiters
// postings whose URLs the scanner had built wrongly.
ok('all 123 dead is suspect', isSuspectWholeSource(123, 123), true);
ok('all 8 dead is suspect', isSuspectWholeSource(8, 8), true);
// AMD on jibeapply: 5 of 6 dead, and that is honest expiry - their URL format
// returns 200 on current requisitions. A high rate is not the signal.
ok('5 of 6 is not suspect', isSuspectWholeSource(6, 5), false);
ok('a high but partial rate is not suspect', isSuspectWholeSource(100, 97), false);
// Too few to mean anything: a tiny source can legitimately be all-dead.
ok('3 of 3 is too few to judge', isSuspectWholeSource(3, 3), false);
ok('a healthy source is not suspect', isSuspectWholeSource(50, 4), false);


// -- a posting's TITLE, which decides which resume it gets -----------
//
// `--url` on a posting the scanner has never seen used to build the work item
// with an EMPTY title, and familyFor decides from the title first -- so an
// untracked Mechanical Design Engineer posting silently got the all-rounder
// resume. Those runs are exactly the links someone sent him, which are the
// applications he cares most about.
//
// The payload shapes are what breaks when a vendor changes their API, so they
// are tested here rather than over the network.
console.log('\ntesting: a posting title is read from each ATS payload');
{
  const meta = (a, j, p) => postingMetaFrom(a, j, p);

  ok('greenhouse title',
    meta('greenhouse', { title: 'Systems Engineer I - Test Automation', company_name: 'Torc Robotics' }, { board: 'torcrobotics' })?.title,
    'Systems Engineer I - Test Automation');
  ok('greenhouse company', meta('greenhouse', { title: 'X', company_name: 'Torc Robotics' }, {})?.company, 'Torc Robotics');
  ok('greenhouse falls back to the board slug',
    meta('greenhouse', { title: 'X' }, { board: 'torc-robotics' })?.company, 'Torc Robotics');

  ok('lever title', meta('lever', { text: 'Manufacturing Engineer, New Grad' }, { slug: 'hermeus' })?.title,
    'Manufacturing Engineer, New Grad');
  ok('lever company from the slug', meta('lever', { text: 'X' }, { slug: 'hermeus' })?.company, 'Hermeus');

  // Ashby's endpoint is the whole ORG BOARD, so the right job has to be picked
  // out of it. Matching the wrong one would title the application after
  // somebody else's job.
  const board = { name: '1X', jobs: [
    { id: 'aaa', title: 'Software Engineer' },
    { id: 'bbb', title: 'Manufacturing Engineer, Hands' },
  ] };
  ok('ashby picks THIS posting from the board',
    meta('ashby', board, { org: '1x', jobId: 'bbb' })?.title, 'Manufacturing Engineer, Hands');
  ok('and not a neighbouring one',
    meta('ashby', board, { org: '1x', jobId: 'aaa' })?.title, 'Software Engineer');
  ok('an unlisted ashby id yields nothing rather than a guess',
    meta('ashby', board, { org: '1x', jobId: 'zzz' }), null);

  ok('workday title', meta('workday', { jobPostingInfo: { title: 'Equipment Automation Engineer I' } }, { tenant: 'abbott' })?.title,
    'Equipment Automation Engineer I');

  // No title is the case that started the fault. Inventing one would be worse
  // than admitting it -- the caller prints a warning instead of defaulting the
  // family in silence.
  ok('an empty payload yields null, never a blank title', meta('greenhouse', {}, { board: 'x' }), null);
  ok('a 403 body yields null', meta('workday', { errorCode: 'FORBIDDEN' }, { tenant: 'abbott' }), null);
  ok('an unknown ats yields null', meta('smartrecruiters', { title: 'X' }, {}), null);
  ok('whitespace in a title is collapsed',
    meta('lever', { text: '  Manufacturing   Engineer \n' }, { slug: 'h' })?.title, 'Manufacturing Engineer');
}


// -- refusing to tailor a resume for a posting that is gone ---------
//
// /api/apply used to open a tab and spend up to two minutes building a tailored
// PDF before he could see the posting was a 404. Two of the five jobs in his
// queue were exactly that -- Amazon's "Sorry, the job you're looking for isn't
// available."
//
// The whole design point is asymmetry: this may cost him time, never an
// opportunity. So ONLY a definitive 404/410 stops an application, and every
// ambiguous answer proceeds.
console.log('');
console.log('testing: only a definitive 404 stops an application');
{
  const realFetch = globalThis.fetch;
  const withStatus = async (status) => {
    globalThis.fetch = async () => ({ status });
    try { return await definitelyGone('https://www.amazon.jobs/en/jobs/1/x'); }
    finally { globalThis.fetch = realFetch; }
  };
  const withThrow = async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try { return await definitelyGone('https://www.amazon.jobs/en/jobs/1/x'); }
    finally { globalThis.fetch = realFetch; }
  };

  ok('404 is gone', !!(await withStatus(404)), true);
  ok('410 is gone', !!(await withStatus(410)), true);
  ok('200 proceeds', await withStatus(200), false);
  // Tesla answers automated visits with 403. Treating that as dead would hide a
  // live job, which is the expensive direction.
  ok('403 proceeds', await withStatus(403), false);
  ok('429 proceeds', await withStatus(429), false);
  ok('500 proceeds', await withStatus(500), false);
  ok('301 proceeds', await withStatus(301), false);
  // Unreachable is not the same as gone.
  ok('a network failure proceeds', await withThrow(), false);
}


// -- Workday's 403, and the control that makes it safe (F-397) --------
//
// Measured 2026-09-07 on a Jabil posting in his curated inbox: the page reads
// "The page you are looking for doesn't exist" in his own signed-in Chrome,
// and its CXS endpoint answers 403 while a LIVE posting on the same tenant
// answers 200 a second later. A 403 on its own is also exactly the shape of a
// bot block -- Tesla's, tested above -- so it is only ever read as "gone" when
// the tenant's own job list is answering us in the same breath.
console.log('');
console.log("testing: a Workday 403 is 'gone' only while the tenant is talking to us");
{
  const JOB = 'https://jabil.wd5.myworkdayjobs.com/Jabil_Careers/job/Some-City/Some-Role_J1';
  const realFetch = globalThis.fetch;
  const run = async (tenantStatus) => {
    globalThis.fetch = async (url, opts = {}) => {
      const isList = (opts.method || 'GET') === 'POST' && String(url).endsWith('/jobs');
      return { status: isList ? tenantStatus : 403 };
    };
    try { return await checkLivenessViaApi(JOB); } finally { globalThis.fetch = realFetch; }
  };
  const answering = await run(200);
  ok('403 + a tenant that answers = gone', answering && answering.result, 'expired');
  ok('...and it says which rung decided', answering && answering.code, 'workday_api_gone');
  ok('403 + a tenant blocking us decides nothing', await run(403), null);
  ok('403 + a tenant with a bad day decides nothing', await run(503), null);
}

// -- and the better control: the tenant's own board (F-403) -----------
//
// "Is this tenant talking to us" is weak evidence — it cannot tell a
// requisition that was pulled from one that is blocking this client in
// particular. Its own search can. Measured 2026-09-08 against the three
// Workday postings a sweep had just retired out of his shortlist: Stryker
// R571543 and KLA 2635066 answered `total: 0` from their own boards, while a
// live Intel posting came back with its exact path.
console.log('');
console.log("testing: a Workday 403 is checked against the tenant's own board");
{
  const JOB = 'https://stryker.wd1.myworkdayjobs.com/StrykerCareers/job/Irvine-California/R-D-Engineer_R571543-1';
  const realFetch = globalThis.fetch;
  const run = async (board) => {
    globalThis.fetch = async (url, opts = {}) => {
      const isList = (opts.method || 'GET') === 'POST' && String(url).endsWith('/jobs');
      if (!isList) return { status: 403 };
      if (board === 'blocked') return { status: 403 };
      return { status: 200, json: async () => board };
    };
    try { return await checkLivenessViaApi(JOB); } finally { globalThis.fetch = realFetch; }
  };

  const listed = await run({ total: 1, jobPostings: [{ externalPath: '/job/Irvine-California/R-D-Engineer_R571543-1' }] });
  ok('a posting still on the board is NEVER retired on a 403', listed, null);

  const absent = await run({ total: 0, jobPostings: [] });
  ok('a board that no longer carries it = gone', absent && absent.result, 'expired');
  ok('...and the reason names the evidence', /no longer lists this requisition/.test((absent || {}).reason || ''), true);

  const other = await run({ total: 1, jobPostings: [{ externalPath: '/job/Somewhere/Another-Role_R999999' }] });
  ok('someone ELSE\'s posting is not this one', other && other.result, 'expired');

  ok('a board that will not answer decides nothing', await run('blocked'), null);
}

// The requisition a slug carries, across the shapes his store actually holds
// — all 96,670 Workday rows yield one.
console.log('');
console.log('testing: the requisition read out of a Workday slug');
for (const [slug, want] of [
  ['R-D-Engineer_R571543-1', 'R571543'],
  ['Mechanical-Design-Engineer_2635066', '2635066'],
  ['Module-Development-Engineer_JR0286844-1', 'JR0286844'],
  ['XMLNAME-4742Process-Engineer-Sustaining-II_26-675', '26-675'],
  ['EXE-FLS-Production-Engineer---Mechanical-Competency_J-00350480-1', 'J-00350480'],
  ['Engineering---Career-Development--Rotational--Program--FY2027-_JR-2026-21950', 'JR-2026-21950'],
  ['Custom-Software-Engineering-Lead_ATCI-5678238-S2059457-1', 'ATCI-5678238-S2059457'],
  // A slug that is only a title has no id, and is never searched for as one:
  // a search for the wrong string finds nothing, and finding nothing is what
  // retires a posting.
  ['Some-Role-With-No-Id', ''],
  ['', ''],
]) ok(`${slug.slice(-34) || '(empty)'} -> ${want || '(none)'}`, workdayRequisition(slug), want);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
