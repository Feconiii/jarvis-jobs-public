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

import { resolveAtsApi, isAtsPosting, postingMetaFrom, definitelyGone, classifyEightfoldPosition, checkLivenessViaApi, workdayRequisition, oraclePosting, oracleMetaFrom } from '../liveness-api.mjs';
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
// A FORM NAMES ITS POSTING, and a state is written with an encoded comma
// (Solar Turbines, opened from Jack & Jill, 2026-09-25: "not a posting").
ok('the apply form maps to its posting, comma and all',
  apiUrl('https://cat.wd5.myworkdayjobs.com/en-US/SolarTurbines/job/San-Diego%2C-California/XMLNAME-2027-Entry-Level-Engineer-Rotation-Turbomachinery-Operations_R0000382939/apply/autofillWithResume?utm_source=jackandjill'),
  'https://cat.wd5.myworkdayjobs.com/wday/cxs/cat/SolarTurbines/job/San-Diego%2C-California/XMLNAME-2027-Entry-Level-Engineer-Rotation-Turbomachinery-Operations_R0000382939');
ok('…and a bare /apply too',
  apiUrl('https://kla.wd1.myworkdayjobs.com/Search/job/Milpitas-CA/NPI-Product-Engineer_2636601/apply'),
  'https://kla.wd1.myworkdayjobs.com/wday/cxs/kla/Search/job/Milpitas-CA/NPI-Product-Engineer_2636601');
ok('an encoded slash is still refused, beside the comma',
  ats('https://kla.wd1.myworkdayjobs.com/Search/job/Milpitas%2C%2FCA/Engineer_1'), null);
ok('Workday names no employer: the site does, when it is a name',
  postingMetaFrom('workday', { jobPostingInfo: { title: 'X' }, hiringOrganization: { name: '' } }, { tenant: 'cat', site: 'SolarTurbines' })?.company, 'Solar Turbines');
ok('…Samsung_Careers is Samsung',
  postingMetaFrom('workday', { jobPostingInfo: { title: 'X' } }, { tenant: 'sec', site: 'Samsung_Careers' })?.company, 'Samsung');
ok('…and a generic site falls back to the tenant',
  postingMetaFrom('workday', { jobPostingInfo: { title: 'X' } }, { tenant: 'intel', site: 'External' })?.company, 'Intel');
ok('…while a name Workday does give wins',
  postingMetaFrom('workday', { jobPostingInfo: { title: 'X' }, hiringOrganization: { name: 'Samsung Austin Semiconductor, LLC.' } }, { tenant: 'sec', site: 'Samsung_Careers' })?.company, 'Samsung Austin Semiconductor, LLC.');
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

// -- a Greenhouse posting on the company's own site (Lucid, 2026-09-25) ------
//
// lucidmotors.com/careers/search/<id>?gh_jid=<id> names no board, so it was
// never asked about, and a posting four days off Lucid's board was still in
// his picks. The embed page takes the id alone: 404 for a pulled job, a
// redirect to its own board for a live one — and only that exact redirect.
console.log('');
console.log("testing: gh_jid on a company's own domain");
{
  const JOB = 'https://lucidmotors.com/careers/search/5228239007?gh_jid=5228239007';
  ok('resolved to the embed page by id', apiUrl(JOB), 'https://boards.greenhouse.io/embed/job_app?token=5228239007');
  ok('a greenhouse.io link keeps its board route', apiUrl('https://boards.greenhouse.io/vast/jobs/4711403006?gh_jid=4711403006'), 'https://boards-api.greenhouse.io/v1/boards/vast/jobs/4711403006');
  ok('no gh_jid, no route', apiUrl('https://lucidmotors.com/careers/search'), null);
  ok('a non-numeric gh_jid is refused', apiUrl('https://x.com/?gh_jid=../../x'), null);
  const realFetch = globalThis.fetch;
  const run = async (status, location) => {
    globalThis.fetch = async () => ({ status, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) } });
    try { return await checkLivenessViaApi(JOB); } finally { globalThis.fetch = realFetch; }
  };
  ok('404 = gone', (await run(404))?.result, 'expired');
  ok('a redirect to its own board = live', (await run(302, 'https://job-boards.greenhouse.io/embed/job_app?for=lucidmotors&token=5228239007'))?.result, 'active');
  ok('a redirect anywhere else decides nothing', await run(302, 'https://job-boards.greenhouse.io/embed/job_board?for=&error=true'), null);
  ok('...nor a redirect to a different job', await run(302, 'https://job-boards.greenhouse.io/embed/job_app?for=lucidmotors&token=1'), null);
}

// -- Rippling redirects a pulled posting to its board (Aalo, 2026-09-25) -----
console.log('');
console.log('testing: a Rippling posting redirected as job_not_found');
{
  const JOB = 'https://ats.rippling.com/aalo-atomics/jobs/4863b7b1-39fc-47fe-94b0-6a5a9de5cfec';
  ok('resolved to its own page', apiUrl(JOB), JOB);
  const realFetch = globalThis.fetch;
  const run = async (status, location) => {
    globalThis.fetch = async () => ({ status, headers: { get: (h) => (h.toLowerCase() === 'location' ? location : null) } });
    try { return await checkLivenessViaApi(JOB); } finally { globalThis.fetch = realFetch; }
  };
  ok('a redirect marked job_not_found = gone', (await run(308, 'https://ats.rippling.com/aalo-atomics/jobs?rr_message=job_not_found'))?.result, 'expired');
  ok('any other redirect decides nothing', await run(302, 'https://ats.rippling.com/login'), null);
  ok('its page = live', (await run(200))?.result, 'active');
}

console.log('\n🧪 a LinkedIn copy is asked about, in LinkedIn\'s own words (F-674)');
{
  const url = 'https://www.linkedin.com/jobs/view/process-engineer-at-wd-4451253407';
  ok('the guest posting endpoint, by the id at the end of the slug', apiUrl(url), 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4451253407');
  ok('a search page is not a posting', ats('https://www.linkedin.com/jobs/search?keywords=engineer'), null);
  const { interpret } = resolveAtsApi(url);
  const page = (html) => interpret(new Response(html, { status: 200 }));
  ok('"No longer accepting applications" = gone',
    (await page('<h2 class="top-card-layout__title">Process Engineer</h2><figure class="closed-job"><figcaption>No longer accepting applications</figcaption></figure>'))?.code, 'linkedin_api_gone');
  ok('the posting card, still open = live', (await page('<h2 class="top-card-layout__title">Process Engineer</h2><button>Apply</button>'))?.result, 'active');
  ok('anything else (a sign-in wall, a throttle page) decides nothing', await page('<html>Sign in</html>'), null);
  // liveness-sweep's isDefinitelyGone() retires on a code ending `_api_gone`.
  ok('…in the shape the sweep retires on', /_api_gone$/.test('linkedin_api_gone'), true);
}

console.log('\n🧪 an Oracle form is named by its own tenant (F-714)');
{
  const form = 'https://iadugs.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/1246/apply/email';
  ok('tenant, site and number read off the form', JSON.stringify(oraclePosting(form)), JSON.stringify({ host: 'iadugs.fa.ocs.oraclecloud.com', site: 'CX_1001', id: '1246' }));
  ok('a vanity domain is not read as a tenant', oraclePosting('https://careers.ti.com/en/sites/CX_1/job/25016597'), null);
  ok('a search page is not a posting', oraclePosting('https://iadugs.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/jobs'), null);
  ok('not a liveness provider (an empty Oracle answer is unmeasured)', isAtsPosting(form), false);
  const item = { Title: 'Manufacturing Engineer', LegalEmployer: null, requisitionFlexFields: [{ Prompt: 'Employment type', Value: 'Regular' }, { Prompt: 'Brand', Value: 'Legrand' }] };
  ok('title, and the employer from the Brand field', JSON.stringify(oracleMetaFrom({ items: [item] })), JSON.stringify({ title: 'Manufacturing Engineer', company: 'Legrand', ats: 'oracle-orc' }));
  ok('no Brand: the legal employer', oracleMetaFrom({ items: [{ Title: 'X', LegalEmployer: 'Acme Corp', requisitionFlexFields: [] }] })?.company, 'Acme Corp');
  ok('no posting, no title invented', oracleMetaFrom({ items: [] }), null);
}

console.log('\n🧪 the direct rung for browser-assist rows (F-762)');
{
  const { classifyDirectStatus } = await import('../liveness-api.mjs');
  const { pickDirectRows, sweepHostDirect, holdWholeHost, urlShape } = await import('./liveness-sweep.mjs');
  ok('410 is gone', classifyDirectStatus(410)?.result, 'expired');
  ok('404 alone decides nothing', classifyDirectStatus(404), null);
  ok('404 beside a 200 from the same host is gone', classifyDirectStatus(404, { hostAnswers: true })?.result, 'expired');
  ok('403 is a refusal, never gone (Tesla)', JSON.stringify(classifyDirectStatus(403, { hostAnswers: true })), JSON.stringify({ refused: true }));
  ok('200 decides nothing (a soft 404 looks the same)', classifyDirectStatus(200), null);
  ok('a redirect decides nothing', classifyDirectStatus(302), null);

  const tesla = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, source: 'browser-assist', url: `https://www.tesla.com/careers/search/job/-${i}` }));
  const joby = Array.from({ length: 10 }, (_, i) => ({ id: `j${i}`, source: 'browser-assist', url: `https://careers-jobyaviation.icims.com/jobs/${3700 + i}/job` }));
  const sym = [
    { id: 's1', source: 'browser-assist', url: 'https://www.symbotic.com/careers/open-positions/R7179' },
    { id: 's2', source: 'browser-assist', url: 'https://www.symbotic.com/careers/open-positions/R6971' },
    { id: 's3', source: 'browser-assist', url: 'https://www.symbotic.com/careers/open-positions/R4962' },
  ];
  const picked = pickDirectRows([...tesla, ...joby, ...sym, { id: 'gh', source: 'greenhouse', url: 'https://boards.greenhouse.io/x/jobs/1' }], 6);
  ok('round-robin across hosts: Tesla cannot crowd out Joby and Symbotic', picked.map((j) => j.id[0]).join(''), 'tjstjs');
  ok('…and only browser-assist rows', picked.some((j) => j.id === 'gh'), false);

  const stub = (map) => { const asked = []; return { asked, status: async (u) => { asked.push(u); return map(u); } }; };
  const nap = async () => {};
  {
    const s = stub(() => 403);
    const r = await sweepHostDirect(tesla, { status: s.status, sleep: nap });
    ok('Tesla: 403 → asked once, then left alone', s.asked.length, 1);
    ok('Tesla: nothing retired', r.gone.length, 0);
  }
  {
    const s = stub(() => 410);
    const r = await sweepHostDirect(joby, { status: s.status, sleep: nap });
    ok('Joby: every posting 410 → every one gone', r.gone.length, 10);
    ok('Joby: a whole host of 410s is a shut-down board, not held', holdWholeHost(r.asked, r.gone), false);
  }
  {
    const s = stub((u) => (/R7179|R6971/.test(u) ? 404 : 200));
    const r = await sweepHostDirect(sym, { status: s.status, sleep: nap });
    ok('Symbotic: the two 404s beside a live 200 are gone', r.gone.map((g) => g.job.id).join(','), 's1,s2');
  }
  {
    // Symbotic, measured 2026-10-18: its own page for R6971 is dead while
    // Workday still lists the requisition. A 404 with nothing live beside it
    // at the same address pattern is never a verdict.
    const s = stub(() => 404);
    const r = await sweepHostDirect(sym.slice(0, 2), { status: s.status, sleep: nap });
    ok('lone 404s (no live posting at the same address pattern): nothing retired', r.gone.length, 0);
    const s2 = stub((u) => (u.includes('/R7179') ? 404 : 200));
    const r2 = await sweepHostDirect([sym[0], { id: 'x', source: 'browser-assist', url: 'https://www.symbotic.com/about/team' }], { status: s2.status, sleep: nap });
    ok('…and a 200 from a different kind of page does not count', r2.gone.length, 0);
    ok('the address pattern blanks the ids', urlShape('https://careers-jobyaviation.icims.com/jobs/3726/job'), 'careers-jobyaviation.icims.com/jobs/*/job');
  }
  {
    // A whole host 404ing with a 200 somewhere is still held when every one checked is dead.
    const dead = Array.from({ length: 9 }, (_, i) => ({ job: { id: `m${i}` }, verdict: { status: 404 } }));
    ok('every posting on a host 404ing is a URL bug: held', holdWholeHost(9, dead), true);
  }
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
