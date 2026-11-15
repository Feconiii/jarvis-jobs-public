/**
 * THE FORM SAYS WHAT THE POSTING DOES NOT (F-455).
 *
 * General Matter's three New Grad roles sat in his inbox at fit 89-99 with a
 * clean work-authorisation check, because the check reads the description and
 * the description is silent. The application form — published by Greenhouse in
 * the same endpoint, one query parameter away — asks for an active security
 * clearance, Q clearance eligibility and US citizenship, all required.
 *
 * These tests pin the two halves of the fix: the right questions are carried
 * into the body, and the wrong ones are not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendGateQuestions, GATE_QUESTION, oracleDetailApi, detailSpec, localeVariant, byEmployerTaste, droppedByItsBoard, boardCanVouch } from './enrich.mjs';
import { classifyVisa } from './visa.mjs';

// General Matter's real form, 2026-09-13, in the order the API returns it.
const GENERAL_MATTER = [
  { label: 'First Name', required: true },
  { label: 'Resume/CV', required: true },
  { label: 'How did you hear about this job?', required: true },
  { label: 'Active Security Clearance(s)', required: true },
  { label: 'Are you eligible for a Q Security Clearance? ', required: true },
  { label: 'What is your GPA?', required: true },
  { label: 'This role is based out of our headquarters in the south bay area of Los Angeles. Are you willing to relocate or commute to our facilities on a daily basis? ', required: true },
  { label: 'Tell us about your proudest accomplishment', required: true },
  { label: 'Clearance Eligibility: This job may require a security clearance. To help us assess your clearance eligibility, are you a US citizen?', required: true },
  { label: 'Academic Transcript', required: true },
];

test('THE CLEARANCE QUESTIONS REACH THE GATE — and the gate blocks on them', () => {
  const body = appendGateQuestions('We are restoring America’s ability to produce nuclear fuel.', GENERAL_MATTER);
  const verdict = classifyVisa('Manufacturing Engineer (New Grad)', body);
  assert.ok(verdict.block, 'a required "Active Security Clearance(s)" question must hard-block');
  assert.equal(verdict.block.key, 'clearance');
  assert.match(verdict.block.quote || '', /Security Clearance/i,
    'the block quotes the employer, so he can see what he is being told');
});

test('NOTHING ELSE FROM THE FORM MOVES — GPA, relocation, "how did you hear"', () => {
  const body = appendGateQuestions('JD text.', GENERAL_MATTER);
  for (const noise of ['GPA', 'how did you hear', 'relocate', 'proudest accomplishment', 'Resume/CV', 'First Name']) {
    assert.ok(!new RegExp(noise, 'i').test(body.split('Application form questions')[1] || ''),
      `"${noise}" decides nothing about work authorisation and must stay out of the body`);
  }
});

test('a form that asks nothing of the kind leaves the body byte-for-byte alone', () => {
  // The overwhelming majority. Fit scores and tailoring read this text, so a
  // posting with an ordinary form must not move at all.
  const body = 'A perfectly ordinary manufacturing engineer posting.';
  const ordinary = [
    { label: 'First Name', required: true },
    { label: 'LinkedIn Profile', required: false },
    { label: 'Will you now or in the future require sponsorship for employment visa status?', required: true },
  ];
  assert.equal(appendGateQuestions(body, ordinary), body);
  assert.equal(appendGateQuestions(body, []), body);
  assert.equal(appendGateQuestions(body, null), body);
  assert.equal(appendGateQuestions(body, undefined), body);
});

test('THE UNIVERSAL SPONSORSHIP QUESTION IS NOT EVIDENCE', () => {
  // Every ATS asks it, of everyone, and the answer changes nothing about
  // whether the employer will sponsor. Treating it as a claim would block
  // most of the store.
  assert.equal(GATE_QUESTION.test('Will you now or in the future require sponsorship for employment visa status?'), false);
  assert.equal(GATE_QUESTION.test('Are you legally authorized to work in the United States?'), false);
});

test('the questions it DOES carry are the ones the gate knows how to read', () => {
  // Each of these is a real label from his store, 2026-09-13. Every one must
  // pass the filter and reach the gate — that is what this file is protecting.
  // What the gate then DOES with it split on 2026-09-19, when export control
  // stopped hiding jobs: the clearance question still hides one, because an F-1
  // cannot hold a clearance, while the U.S.-person questions are the standard
  // export-control screening every US application asks and are now reported
  // with their sentence instead. Asserting only "something happened" would let
  // a future change quietly turn either one into the other.
  const blocks = ['Active Security Clearance(s)'];
  const flags = [
    'Are you either a US Citizen or a Perm Resident)?',
    'Are you a U.S. citizen, a U.S. lawful permanent resident (i.e. green card holder), or a protected individual under 8 U.S.C. Sec. 1324b?',
    'Please confirm that you are either: (a) a U.S. citizen; (b) lawful permanent resident of the U.S. (green card holder)',
  ];
  const verdictFor = label =>
    classifyVisa('Manufacturing Engineer', appendGateQuestions('JD.', [{ label, required: true }]));

  for (const label of blocks) {
    assert.ok(GATE_QUESTION.test(label), `must be carried: ${label}`);
    assert.equal(verdictFor(label).block?.key, 'clearance', `must still block on: ${label}`);
  }

  for (const label of flags) {
    assert.ok(GATE_QUESTION.test(label), `must be carried: ${label}`);
    const verdict = verdictFor(label);
    assert.equal(verdict.block, null, `must no longer block on: ${label}`);
    const warned = verdict.warnings.find(w => w.key === 'us_person');
    assert.ok(warned, `must still be flagged as us_person: ${label}`);
    // The whole point of flagging rather than blocking is that he reads the
    // wording himself, so the wording has to come with it.
    assert.ok(warned.quote && /citizen/i.test(warned.quote), `the flag must carry the question: ${label}`);
  }
});

test('a duplicate label is carried once', () => {
  const body = appendGateQuestions('JD.', [
    { label: 'Active Security Clearance(s)', required: true },
    { label: 'Active Security Clearance(s)', required: false },
  ]);
  assert.equal((body.match(/Active Security Clearance/g) || []).length, 1);
});

console.log('enrich: form-question gate OK');

test('ORACLE DETAIL ENDPOINT from the posting URL or portals.yml — Cummins, 1,199 postings unread, 2026-10-02', () => {
  // On the real Oracle host: everything is in the URL.
  assert.equal(oracleDetailApi('https://fa-espx-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2435230', 'Cummins Inc.'),
    'https://fa-espx-saasfaprod1.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById%3BId%3D%222435230%22%2CsiteNumber%3D%22CX_1%22');
  // A vanity domain names no host: an unknown company gets nothing, never a guess.
  assert.equal(oracleDetailApi('https://careers.example.com/en/sites/CX_1/job/25016597', 'No Such Company 123'), null);
  // No requisition, no endpoint.
  assert.equal(oracleDetailApi('https://fa-espx-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs', 'Cummins Inc.'), null);
});

test('F-733: an Oracle body keeps the corporate block — where Emerson writes "not a position for which sponsorship will be provided"', async () => {
  const { classifyVisa } = await import('./visa.mjs');
  const spec = detailSpec({ source: 'oracle-orc', url: 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26011819', company: 'Emerson' });
  assert.ok(spec?.pick, 'Emerson\'s Oracle host is in the URL');
  const body = spec.pick({ items: [{
    ExternalDescriptionStr: '<p>Manufacturing Engineer. Bachelor of Science in Mechanical Engineering.</p>',
    CorporateDescriptionStr: '<p>Work Authorization Emerson will only employ those who are legally authorized to work in the United States. This is not a position for which sponsorship will be provided. Individuals with temporary visas such as E, F-1 (including those with OPT or CPT), H-1, H-2, L-1, B, J or TN, or who need sponsorship for work authorization now or in the future, are not eligible for hire.</p>',
  }] });
  assert.match(body, /not a position for which sponsorship will be provided/);
  assert.ok(classifyVisa('Manufacturing Engineer', body.replace(/<[^>]+>/g, ' ')).block, 'and the visa gate blocks it');
});

test("FREEFORM, 2026-10-02: a gate question's own note is kept — that is where its ITAR clause is", () => {
  const body = appendGateQuestions('We build metal 3D printers.', [{
    label: 'Citizenship Status', required: true,
    description: '<p>Export Compliance: Due to the nature of various Freeform customers, the person hired will have access to information and items controlled by the International Traffic in Arms Regulation (ITAR), and, therefore, must be a &ldquo;U.S. person&rdquo; as defined in the ITAR.</p>',
  }]);
  assert.match(body, /Citizenship Status — Export Compliance: .*International Traffic in Arms Regulation \(ITAR\)/);
  assert.match(body, /\(required\)/);
  // A note that is not about the gate is not copied in.
  assert.doesNotMatch(appendGateQuestions('x', [{ label: 'Citizenship Status', description: '<p>Choose one.</p>' }]), /Choose one/);
});

test('RELATIVITY SPACE, F-665: a question labelled only "EXPORT COMPLIANCE" is kept for its note', async () => {
  const { classifyVisa } = await import('./visa.mjs');
  // Verbatim from boards-api.greenhouse.io/v1/boards/relativity/jobs/8860290002?questions=true
  const questions = [
    { label: 'How did you hear about us?', required: true, description: '' },
    {
      label: 'EXPORT COMPLIANCE', required: true,
      description: '<p><!--StartFragment-->As defined in the ITAR, &ldquo;U.S. Persons&rdquo; include U.S. citizens, lawful permanent residents (i.e., Green Card holders), and certain protected individuals (e.g., refugees/asylees, American Samoans). Please consult with a knowledgeable advisor if you are unsure whether you are a &ldquo;U.S. Person.&rdquo;<br><br>The person hired will have access to information and items controlled by the International Traffic in Arms Regulation (ITAR), and, therefore, must either be a &ldquo;U.S. person&rdquo; as defined by those regulations or otherwise eligible for a federally issued export control license.</p>',
    },
  ];
  const body = appendGateQuestions('Manufacturing Engineer I, Structures. Build Terran R.', questions);
  assert.match(body, /EXPORT COMPLIANCE — As defined in the ITAR/);
  assert.match(body, /otherwise eligible for a federally issued export control license/);
  assert.doesNotMatch(body, /How did you hear/);
  const v = classifyVisa('Manufacturing Engineer I, Structures', body);
  assert.equal(v.block, null, 'a U.S.-person question is a caution, not a block');
  assert.ok(v.warnings.some(w => w.key === 'us_person'), 'and it is the U.S.-person caution the picks screen skips');
});

test('A PHENOM TEASER IS READ FROM THE EMPLOYER’S WORKDAY TENANT (F-673)', () => {
  const spec = detailSpec({ source: 'phenom', url: 'https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Florence-South-Carolina-USA/Process-Engineer_R-01346498' });
  assert.equal(spec?.api, 'https://thermofisher.wd5.myworkdayjobs.com/wday/cxs/thermofisher/ThermoFisherCareers/job/Florence-South-Carolina-USA/Process-Engineer_R-01346498');
});

test('A WORKABLE POSTING IS READ FROM ITS OWN JSON, ALL THREE PARTS (2026-10-08)', () => {
  const spec = detailSpec({ source: 'workable', url: 'https://apply.workable.com/new-flyer/jobs/view/CD00EADD50' });
  assert.equal(spec?.api, 'https://apply.workable.com/api/v2/accounts/new-flyer/jobs/CD00EADD50');
  assert.equal(detailSpec({ source: 'workable', url: 'https://apply.workable.com/acorn/j/AB12CD34EF' })?.api,
    'https://apply.workable.com/api/v2/accounts/acorn/jobs/AB12CD34EF', 'the short /j/ link too');
  const body = spec.pick({ description: '<p>Build buses.</p>', requirements: '<ul><li>BSME</li></ul>', benefits: '' });
  assert.match(body, /Build buses[\s\S]*Requirements[\s\S]*BSME/);
  assert.doesNotMatch(body, /Benefits/, 'an empty part is left out');
  assert.equal(detailSpec({ source: 'workable', url: 'https://example.com/jobs/view/X' }), null);
});

test('A PHENOM POSTING WITH NO WORKDAY LINK IS READ FROM ITS OWN PAGE, IN THE LOCALE ITS ID NAMES (2026-10-07)', () => {
  assert.equal(detailSpec({ source: 'phenom', url: 'https://careers.quest-global.com/us/en/job/QGRQGAGLOBALP122128EXTERNALENGLOBAL/ate-test-engineer' })?.html,
    'https://careers.quest-global.com/global/en/job/QGRQGAGLOBALP122128EXTERNALENGLOBAL/ate-test-engineer',
    '…EXTERNALENGLOBAL is served at /global/en/; the /us/en/ link redirects to the home page');
  assert.equal(detailSpec({ source: 'phenom', url: 'https://careers.emdgroup.com/us/en/job/MQAEGZUS304460EXTERNALENUS/process-engineer' })?.html,
    'https://careers.emdgroup.com/us/en/job/MQAEGZUS304460EXTERNALENUS/process-engineer');
  assert.equal(detailSpec({ source: 'phenom', url: 'https://careers.honda.com/us/en/job/AHMA12394' })?.html,
    'https://careers.honda.com/us/en/job/AHMA12394', 'an id with no locale keeps the path it came with');
  assert.equal(detailSpec({ source: 'phenom', url: 'https://example.com/apply?id=1' }), null, 'not a posting page');
});

test('A PHENOM ROW WHOSE LINK HAS NO READER IS READ FROM ITS PAGE ON THE PHENOM SITE (2026-11-12)', () => {
  const sf = 'https://career4.successfactors.com/career?company=bechtelP&career_job_req_id=287881';
  const page = 'https://jobs.bechtel.com/us/en/job/BECHUS287881EXTERNALENUS/mechanical-engineer';
  assert.equal(detailSpec({ source: 'phenom', url: sf })?.html, undefined, 'without its page a SuccessFactors link has no reader');
  assert.equal(detailSpec({ source: 'phenom', url: sf, detailApi: page })?.html, page);
  const wd = 'https://acme.wd1.myworkdayjobs.com/Careers/job/Austin/Process-Engineer_R1';
  assert.equal(detailSpec({ source: 'phenom', url: wd, detailApi: page })?.html, undefined, 'a Workday link is read as Workday, never the page');
  assert.ok(detailSpec({ source: 'phenom', url: wd, detailApi: page })?.api, '…through the Workday API');
  const own = 'https://jobs.bechtel.com/us/en/job/BECHUS1EXTERNALENUS/other';
  assert.equal(detailSpec({ source: 'phenom', url: own, detailApi: page })?.html, own, 'a link already on the Phenom site is read as it is');
  assert.equal(detailSpec({ source: 'phenom', url: sf, detailApi: 'http://jobs.bechtel.com/us/en/job/X1/a' }), null, 'only an https page');
  assert.equal(detailSpec({ source: 'phenom', url: sf, detailApi: 'https://evil.test/apply?x=1' }), null, 'only a page of the Phenom shape');
  const spec = detailSpec({ source: 'phenom', url: sf, detailApi: page });
  assert.deepEqual([spec.phenomGuess, spec.applyUrl], [true, sf], 'a built page is read as a guess, the apply link beside it');
  assert.equal(detailSpec({ source: 'phenom', url: own })?.phenomGuess, undefined, 'a link on the site is no guess');
});

test('A PHENOM PAGE UNDER A GUESSED LOCALE: THE SITE\'S OWN LOCALE IS TRIED, AND NOTHING FOUND IS NO STRIKE (F-1048 review)', async () => {
  const { readPhenomPage, phenomAlternates } = await import('./enrich.mjs');
  const posting = (title) => `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title, description: '<p>Design fixtures for the press line.</p>' })}</script></html>`;
  const guess = 'https://jobs.lanxess.com/us/en/job/LANX4471/process-engineer';
  const de = 'https://jobs.lanxess.com/de/de/job/LANX4471/process-engineer';
  // A redirect to the site's home page under its own locale: that locale is read next.
  let asked = [];
  let got = await readPhenomPage(guess, { fetchAt: async (u) => { asked.push(u); return u === guess ? { text: '<html>home</html>', url: 'https://jobs.lanxess.com/de/de/' } : { text: posting('Prozessingenieur'), url: u }; } });
  assert.deepEqual([asked, got?.jp?.title], [[guess, de], 'Prozessingenieur'], 'a redirect names the locale to read');
  // An empty page (no JobPosting, no redirect) and nothing else named: null, not a throw.
  asked = [];
  got = await readPhenomPage(guess, { fetchAt: async (u) => { asked.push(u); return { text: '<html></html>', url: u }; } });
  assert.deepEqual([asked, got], [[guess], null], 'an empty page with no other locale named is nothing found');
  // A 404, and the apply link asks for en_GB: gb/en is read.
  const gb = 'https://jobs.lanxess.com/gb/en/job/LANX4471/process-engineer';
  asked = [];
  got = await readPhenomPage(guess, { applyUrl: 'https://career5.successfactors.eu/career?company=lanxess&career_job_req_id=4471&lang=en_GB',
    fetchAt: async (u) => { asked.push(u); if (u === guess) { const e = new Error('HTTP 404'); e.httpStatus = 404; throw e; } return { text: posting('Process Engineer'), url: u }; } });
  assert.deepEqual([asked, got?.jp?.title], [[guess, gb], 'Process Engineer'], 'a 404 tries the locale the apply link asks for');
  // A refusal is not a missing page: it goes up to the refusal handling.
  await assert.rejects(readPhenomPage(guess, { fetchAt: async () => { const e = new Error('HTTP 403'); e.httpStatus = 403; throw e; } }), /403/);
  // Never another host, never the same locale twice.
  assert.deepEqual(phenomAlternates(guess, { landed: 'https://evil.test/de/de/' }), []);
  assert.deepEqual(phenomAlternates(guess, { landed: 'https://jobs.lanxess.com/us/en/', applyUrl: '?lang=en_US' }), []);
});

test('A PHENOM PAGE NOT FOUND WAITS A DAY BEFORE IT IS ASKED AGAIN (F-1048 follow-up)', async () => {
  const { phenomCooling, prunePhenomMisses, PHENOM_COOLDOWN_MS } = await import('./enrich.mjs');
  const now = Date.parse('2026-11-12T14:00:00Z');
  const misses = { a: '2026-11-12T13:00:00.000Z', b: '2026-11-11T13:59:00.000Z', c: 'not a date' };
  assert.equal(PHENOM_COOLDOWN_MS, 86_400_000);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => phenomCooling(id, misses, now)), [true, false, false, false],
    'a miss an hour ago cools; one over a day ago, an unreadable date and no miss do not');
  assert.deepEqual(prunePhenomMisses(misses, now), { a: '2026-11-12T13:00:00.000Z' }, 'only the misses still cooling are kept');
  assert.equal(phenomCooling('a', undefined, now), false, 'no record is no cooldown');
});

test('A LIST TEASER STILL NEEDS READING, A READ SHORT POSTING DOES NOT (F-761)', async () => {
  const { needsReading } = await import('./enrich.mjs');
  const teaser = 'x'.repeat(340);
  assert.equal(needsReading({ description: '' }), true, 'no body: read it');
  assert.equal(needsReading({ description: teaser }), true, 'a 340-character list summary nothing has read in full: read it');
  assert.equal(needsReading({ description: teaser, enrichedAt: '2026-10-18T00:00:00.000Z' }), false,
    'the same length after a full read is the real posting: do not read it again');
  assert.equal(needsReading({ description: 'x'.repeat(2400) }), false, 'a full body: leave it');
});

test('A HAND-PICKED LIST CAN ASK FOR BODIES READ TOO LONG AGO (F-627)', async () => {
  const { needsReading } = await import('./enrich.mjs');
  const now = Date.parse('2026-10-18T00:00:00.000Z');
  // GE Vernova R5052095: read 2026-09-11 at 2,071 characters; the posting
  // later grew the paragraph that refuses sponsorship.
  const ge = { description: 'x'.repeat(2071), enrichedAt: '2026-09-11T00:01:35.754Z' };
  assert.equal(needsReading(ge, undefined, now), false, 'without --refresh a full body is left alone');
  assert.equal(needsReading(ge, 7, now), true, 'read 37 days ago: re-read with --refresh 7');
  assert.equal(needsReading({ ...ge, enrichedAt: '2026-10-15T00:00:00.000Z' }, 7, now), false, 'read 3 days ago: not yet');
  assert.equal(needsReading({ description: 'x'.repeat(2071) }, 7, now), true, 'never dated: re-read');
});

test('a SuccessFactors requisition listed only in translation is read in English (F-937)', () => {
  assert.equal(localeVariant('https://join.example.com/job/Sioux-Falls-Test-Engineer-I-SD-57101/5708-it_IT/', 'en_US'),
    'https://join.example.com/job/Sioux-Falls-Test-Engineer-I-SD-57101/5708-en_US/');
  assert.equal(localeVariant('https://join.example.com/job/X/5708-fr_FR/?locale=en_US', 'en_US'), 'https://join.example.com/job/X/5708-en_US/');
  assert.equal(localeVariant('https://join.example.com/job/X/5708-en_US/', 'en_US'), null, 'already English');
  assert.equal(localeVariant('https://join.example.com/job/X/1370711455/', 'en_US'), null, 'not a locale-suffixed record');
  assert.deepEqual(detailSpec({ source: 'successfactors', url: 'https://join.example.com/job/X/1370711455/' }),
    { html: 'https://join.example.com/job/X/1370711455/', locale: 'en_US', pick: null });
});

test('the background reader skips ruled-out employers and reads his kind first (2026-11-01)', () => {
  const cls = { Star: 'star', Big: 'name', Listed: 'vc', Unknown: 'other', Ruled: 'out', Plant: 'backup' };
  const rows = ['Unknown', 'Ruled', 'Plant', 'Listed', 'Star', 'Unknown', 'Big'].map((company, i) => ({ id: String(i), company }));
  const got = byEmployerTaste(rows, 10, (c) => cls[c]).map((j) => `${j.company}${j.id}`);
  assert.deepEqual(got, ['Star4', 'Big6', 'Listed3', 'Unknown0', 'Unknown5', 'Plant2'], 'ruled out dropped; class order, pre-read order within a class');
  assert.equal(byEmployerTaste(rows, 2, (c) => cls[c]).length, 2, 'the limit holds');
  assert.deepEqual(byEmployerTaste(rows, 10, () => 'any').map((j) => j.id), ['0', '1', '2', '3', '4', '5', '6'], 'no taste gate: order unchanged');
});

test('new postings are read before the backlog, his kind of employer first among them (F-983)', async () => {
  const { freshFirst, FRESH_HOURS } = await import('./enrich.mjs');
  const cls = { Star: 'star', Unknown: 'other', Ruled: 'out' };
  const rows = [
    { id: 'old-star', company: 'Star', fresh: false }, { id: 'new-unknown', company: 'Unknown', fresh: true },
    { id: 'old-unknown', company: 'Unknown', fresh: false }, { id: 'new-star', company: 'Star', fresh: true }, { id: 'new-ruled', company: 'Ruled', fresh: true },
  ];
  assert.deepEqual(freshFirst(rows, 10, (c) => cls[c]).map((j) => j.id), ['new-star', 'new-unknown', 'old-star', 'old-unknown']);
  assert.deepEqual(freshFirst(rows, 1, (c) => cls[c]).map((j) => j.id), ['new-star'], 'the limit holds');
  // A board added today is all new for three days: it takes at most 60% of a batch (review, 2026-11-04).
  const flood = [...Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, company: 'Unknown', fresh: true })), ...Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, company: 'Unknown', fresh: false }))];
  const batch = freshFirst(flood, 10, (c) => cls[c]);
  assert.deepEqual([batch.length, batch.filter((j) => j.fresh).length], [10, 6], 'the backlog still gets four of ten');
  const fewOld = [...flood.slice(0, 20), { id: 'o0', company: 'Unknown', fresh: false }];
  assert.equal(freshFirst(fewOld, 10, (c) => cls[c]).filter((j) => j.fresh).length, 9, 'what the backlog cannot fill, new postings take');
  assert.ok(FRESH_HOURS >= 24 && FRESH_HOURS <= 96, 'fresh means the last few days');
});

// iCIMS answers a browser-looking client 405 and a plainly named one 200 (2026-11-03).
test('iCIMS hosts get the honest client name; other boards keep the default', async () => {
  const { userAgentFor, HONEST_UA } = await import('./enrich.mjs');
  assert.equal(userAgentFor('https://careers-sargentlundy.icims.com/jobs/28406/x/job?in_iframe=1'), HONEST_UA);
  assert.equal(userAgentFor('https://careers-dewberry.icims.com/jobs/1/y/job'), HONEST_UA);
  assert.notEqual(userAgentFor('https://hpe.wd5.myworkdayjobs.com/Jobsathpe/job/x'), HONEST_UA);
  assert.notEqual(userAgentFor('https://notreallyicims.com.evil.example/jobs/1'), HONEST_UA);
});

// Apple pages carry no JobPosting; its own API does (2026-11-03).
test('an Apple posting is read through its own jobDetails API', async () => {
  const { appleDetailApi } = await import('./enrich.mjs');
  const spec = appleDetailApi('https://jobs.apple.com/en-us/details/200632290-0240/data-center-product-design-engineer');
  assert.equal(spec.api, 'https://jobs.apple.com/api/v1/jobDetails/200632290-0240');
  const text = spec.pick({ res: { jobSummary: 'Summary.', minimumQualifications: 'BS in Mechanical Engineering', preferredQualifications: '2 years, or equivalent internship experience' } });
  assert.match(text, /Minimum Qualifications<\/h3>BS in Mechanical Engineering/);
  assert.match(text, /Preferred Qualifications/);
  assert.equal(appleDetailApi('https://example.com/details/123'), null);
});

test('a locked store is recognised by its SQLite code, not by wording', async () => {
  const { isLockError } = await import('./enrich.mjs');
  assert.equal(isLockError({ errcode: 5, message: 'database is locked' }), true);
  assert.equal(isLockError({ errcode: 6 }), true);
  assert.equal(isLockError({ code: 'SQLITE_BUSY' }), true);
  assert.equal(isLockError({ errcode: 1, message: 'no such column: busy' }), false);
});

test('THE SCREEN WAITING LIST SKIPS A ROW ITS BOARD STOPPED LISTING (2026-11-03)', () => {
  // Apple: listed 10-31, board read 11-03 → 404 (closed). Listed that morning → open.
  assert.equal(droppedByItsBoard('2026-10-31T06:00:00Z', '2026-11-03T06:00:00Z'), true);
  assert.equal(droppedByItsBoard('2026-11-03T05:00:00Z', '2026-11-03T06:00:00Z'), false);
  assert.equal(droppedByItsBoard('2026-10-31T06:00:00Z', null), false);   // no board record: read it
});

test('A BOARD THAT MAY HAVE STOPPED AT A CAP CANNOT SAY A ROW IS GONE (review, 2026-11-03)', () => {
  assert.equal(boardCanVouch('greenhouse', 120), true);
  assert.equal(boardCanVouch('icims-careers', 2000), false);   // at its page cap
  assert.equal(boardCanVouch('amazon-jobs', 50), false);       // read in shards
  assert.equal(boardCanVouch('sitemap-jobs', 1400), true);     // a sitemap lists everything
});

test('A READ BODY BRINGS THE POSTING\'S OWN TITLE (2026-11-03: Simplify renames postings)', () => {
  const wd = detailSpec({ source: 'workday', url: 'https://micron.wd1.myworkdayjobs.com/External/job/Boise-ID---Main-Site/SR-ENGINEER--DDEG-IP-DEVELOPMENT_JR115388' });
  assert.equal(wd.title({ jobPostingInfo: { title: 'New College Grad - ENGINEER, DDEG IP DEVELOPMENT' } }), 'New College Grad - ENGINEER, DDEG IP DEVELOPMENT');
});
