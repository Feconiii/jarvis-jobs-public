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

import { appendGateQuestions, GATE_QUESTION } from './enrich.mjs';
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
