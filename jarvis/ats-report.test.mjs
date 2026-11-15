/**
 * The platform report: every posting lands on the right vendor, and a fault's
 * open/closed state is read from its own heading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vendorOf, faultStatuses, applicationRates } from './ats-report.mjs';

test('postings are classified by the page they are applied on', () => {
  const cases = [
    ['https://globalfoundries.wd1.myworkdayjobs.com/External/job/x', 'workday'],
    ['https://job-boards.greenhouse.io/anthropic/jobs/1', 'greenhouse'],
    ['https://careers.formlabs.com/job/7996435/apply/?gh_jid=7996435', 'greenhouse'],
    ['https://app.careerpuck.com/job-board/lyft/job/8779925002?gh_jid=8779925002', 'careerpuck'],
    ['https://jobs.smartrecruiters.com/oneclick-ui/company/WesternDigital/publication/x', 'smartrecruiters'],
    ['https://career10.successfactors.com/portalcareer?x=1', 'successfactors'],
    ['https://careers.micron.com/careers/job/1', 'eightfold'],
    ['https://jobs.ashbyhq.com/openai/1', 'ashby'],
    ['https://ats.rippling.com/cintal/jobs/x', 'rippling'],
    ['https://app.dover.com/apply/loombotic/x', 'dover'],
    ['https://wayve.firststage.co/jobs?gh_jid=8483422002', 'firststage'],
    ['https://www.amazon.jobs/en/jobs/1', 'amazon'],
  ];
  for (const [url, want] of cases) assert.equal(vendorOf(url), want, url);
  assert.equal(vendorOf('https://careers.veeco.com/job/x/1/', 'sitemap-jobs'), 'company-site', 'an unclaimed host falls back to its provider');
  assert.equal(vendorOf('https://example.test/x'), 'other');
});

test('a fault is open or closed by its own heading, the last one with that id winning', () => {
  const s = faultStatuses([
    '## F-1 · A thing · `major` · OPEN',
    '## F-2 · Another · `minor` · fixed 2026-09-24',
    '## F-3 · Radios · `major` · FIXED on a fixture, UNVERIFIED live',
    '## F-3 · Radios · `major` · fixed 2026-09-24, verified in his Chrome',
  ].join('\n'));
  assert.equal(s.get('F-1').open, true);
  assert.equal(s.get('F-2').open, false);
  assert.equal(s.get('F-3').open, false, 'the later heading supersedes');
});

test('F-841: rates per application, not per run — one upload and a clean last run make an application whole', () => {
  const r = applicationRates([
    // SmartRecruiters-shaped: the press uploads on step 1; the follow-along runs fill later steps.
    { jobId: 'a', at: '1', filled: 20, uploaded: true, left: [], stoppedBecause: 'the form stayed on this step — something required is still empty' },
    { jobId: 'a', at: '2', filled: 10, uploaded: false, left: [], stoppedBecause: 'reached the last step before Submit' },
    // ADP-shaped: sign-in retries, then the form.
    { jobId: 'b', at: '1', filled: 0, stoppedBecause: 'pressed Sign in with Google — the form fills by itself once you are back' },
    { jobId: 'b', at: '2', filled: 0, stoppedBecause: 'pressed Sign in with Google — the form fills by itself once you are back' },
    { jobId: 'b', at: '3', filled: 8, uploaded: true, left: ['step 1: years'], stoppedBecause: 'the form would not move on' },
    // Never past the sign-in.
    { jobId: 'c', at: '1', filled: 0, stoppedBecause: 'sign in here — the form fills by itself once you are in' },
  ]);
  assert.equal(r.applications, 3);
  assert.equal(r.seen, 2, 'two applications met the form');
  assert.equal(r.uploadPct, 100, 'both had the resume, though only 2 of 5 form runs attached it');
  assert.equal(r.cleanPct, 50, 'a ends clean at Submit; b still has a question left');
  assert.equal(r.walledPct, 33, 'only c never got past the sign-in');
});

test('every fault the registry cites exists in FAULTS.md', () => {
  const reg = JSON.parse(readFileSync(new URL('./ats-registry.json', import.meta.url), 'utf8'));
  const known = faultStatuses(readFileSync(new URL('./FAULTS.md', import.meta.url), 'utf8'));
  const missing = reg.vendors.flatMap((v) => (v.faults || []).filter((id) => !known.has(id)).map((id) => `${v.key}:${id}`));
  assert.deepEqual(missing, []);
});
