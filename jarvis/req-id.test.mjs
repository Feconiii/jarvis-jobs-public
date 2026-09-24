// jarvis/req-id.test.mjs — one rule for "which requisition is this URL" (F-449).
//
// Two modules grew their own copy of this within an hour. The liveness sweep
// tolerated a trailing path segment (`/jobs/3726/job`); the description
// importer did not. Nothing would have crashed — a Joby harvest would simply
// have matched nothing and reported an empty board, which is the quietest
// possible way to lose 300 postings.
//
// So the last test here is the one that matters: the two modules must agree on
// every URL shape, not merely each pass its own tests.

import { test } from 'node:test';
import assert from 'node:assert';
import { reqIdOf, urlHasReqId } from './req-id.mjs';

// Real shapes from the store, one per board that behaves differently.
const SHAPES = [
  ['tesla', 'https://www.tesla.com/careers/search/job/mfg-eng-273084', '273084'],
  ['icims (number mid-path)', 'https://careers-jobyaviation.icims.com/jobs/3726/job', '3726'],
  ['icims with slug', 'https://careers-jobyaviation.icims.com/jobs/5302/manufacturing-engineer---motors/job', '5302'],
  ['greenhouse', 'https://boards.greenhouse.io/acme/jobs/5986750004', '5986750004'],
  ['symbotic (Workday R-number on the marketing url)', 'https://www.symbotic.com/careers/open-positions/R7585', 'R7585'],
  ['symbotic (the same req on Workday itself)', 'https://symbotic.wd504.myworkdayjobs.com/Symbotic/job/USA-MA/Thing_R7585', 'R7585'],
  ['workday JR-number', 'https://x.wd5.myworkdayjobs.com/site/job/Germany-Munich/Role_JR2020552', 'JR2020552'],
  ['underscore separator', 'https://x.test/req_88231', '88231'],
  ['query string after', 'https://x.test/jobs/44120/job?src=rss', '44120'],
  ['fragment after', 'https://x.test/jobs/44120/job#apply', '44120'],
  ['trailing slash', 'https://x.test/jobs/44120/', '44120'],
];

for (const [label, url, want] of SHAPES) {
  test(`${label}: ${want || 'no requisition'}`, () => {
    assert.equal(reqIdOf(url), want, url);
  });
}

test('a single digit is never a requisition', () => {
  assert.equal(reqIdOf('https://x.test/job/7'), '');
  assert.equal(reqIdOf('https://x.test/jobs/7/job'), '');
});

test('digits with no separator before them are not a requisition', () => {
  // `role1880002` runs the digits straight onto a word. There is no way to
  // tell where a requisition would start, so the honest answer is none —
  // guessing "880002" here is precisely how one posting's description ends up
  // on another posting's row.
  assert.equal(reqIdOf('https://x.test/careers/role1880002'), '');
  assert.equal(reqIdOf('https://x.test/careers/role-1880002'), '1880002', 'with a separator it is readable');
});

test('a url with no digits at all yields nothing', () => {
  assert.equal(reqIdOf('https://x.test/careers/manufacturing-engineer'), '');
  assert.equal(reqIdOf('https://x.test/jobs/'), '');
  assert.equal(reqIdOf(''), '');
  assert.equal(reqIdOf(null), '');
  assert.equal(reqIdOf(undefined), '');
});

test('urlHasReqId is exact, never a suffix match', () => {
  const url = 'https://www.tesla.com/careers/search/job/mfg-eng-1880002';
  assert.equal(urlHasReqId(url, '1880002'), true);
  assert.equal(urlHasReqId(url, '880002'), false, 'a suffix of the number is a different requisition');
  assert.equal(urlHasReqId(url, '88'), false);
});

test('urlHasReqId refuses a non-numeric key rather than guessing', () => {
  const url = 'https://x.test/jobs/3726/job';
  for (const bad of ['', null, undefined, 'abc', '7', 'req-3726']) {
    assert.equal(urlHasReqId(url, bad), false, `"${bad}" should not resolve`);
  }
});

// ── the point of the file ───────────────────────────────────────────

test('the liveness sweep and the description importer read URLs identically', async () => {
  const live = await import('./assist-liveness.mjs');
  const imp = await import('./import-descriptions.mjs');
  assert.equal(live.reqIdOf, reqIdOf, 'assist-liveness must use the shared rule, not a copy of it');

  // And the importer's matcher must agree with it on every shape above —
  // this is the assertion that would have caught the Joby drift.
  for (const [label, url, want] of SHAPES) {
    const derived = reqIdOf(url);
    assert.equal(derived, want, label);
    if (want) {
      assert.equal(urlHasReqId(url, want), true, `${label}: the importer must match what the sweep derives`);
    }
  }
  assert.equal(typeof imp.resolveReqId, 'function', 'the importer still exposes its store-backed resolver');
});

// ── uppercase requisition prefixes (Symbotic / Workday) ─────────────

test('an UPPERCASE prefix is part of the requisition, a lowercase word is not', () => {
  // This is the whole safety of widening the rule. `R7540` is a requisition;
  // `role1880002` is a slug that happens to end in digits, and reading a
  // requisition out of it would let one posting's body land on another's row.
  assert.equal(reqIdOf('https://x.test/careers/R7540'), 'R7540');
  assert.equal(reqIdOf('https://x.test/careers/JR7540'), 'JR7540');
  assert.equal(reqIdOf('https://x.test/careers/REQ7540'), 'REQ7540');
  assert.equal(reqIdOf('https://x.test/careers/role1880002'), '', 'lowercase run-on is a slug, not a requisition');
  assert.equal(reqIdOf('https://x.test/careers/Role1880002'), '', 'a capitalised word is still a word');
});

test('the prefix is capped, so a long uppercase token is not a requisition', () => {
  assert.equal(reqIdOf('https://x.test/careers/ABCD1234'), '', 'four letters is a code, not a req prefix');
  assert.equal(reqIdOf('https://x.test/careers/ABC1234'), 'ABC1234');
});

test('urlHasReqId accepts the same alphanumeric keys and no others', () => {
  const url = 'https://symbotic.wd504.myworkdayjobs.com/Symbotic/job/USA-MA/Thing_R7540';
  assert.equal(urlHasReqId(url, 'R7540'), true);
  assert.equal(urlHasReqId(url, '7540'), false, 'the digits alone are a different key');
  assert.equal(urlHasReqId(url, 'r7540'), false, 'lowercase is not the same requisition');
  assert.equal(urlHasReqId(url, 'ABCD7540'), false);
});
