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

import { appendGateQuestions, GATE_QUESTION, oracleDetailApi, detailSpec } from './enrich.mjs';
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
