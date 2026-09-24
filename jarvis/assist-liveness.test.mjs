// jarvis/assist-liveness.test.mjs — retiring rows on a browser-only board (F-447).
//
// Marking a live posting dead is the one error this system does not tolerate:
// it makes him miss a real job and he never finds out. So most of what follows
// asserts REFUSALS — the cases where the honest answer is to leave every row
// exactly where it is — rather than the happy path where the feed is complete
// and everything lines up.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const DIR = mkdtempSync(path.join(tmpdir(), 'jarvis-alive-'));
process.env.JARVIS_DATA_DIR = DIR;

const { reqIdOf, planSweep, sweep, MAX_RETIRE_SHARE, MIN_FEED } = await import('./assist-liveness.mjs');
const { upsertJobs, getJob, jobId, closeDb } = await import('./store.mjs');
const { triage } = await import('./triage.mjs');

test.after(() => { try { closeDb(); } catch {} rmSync(DIR, { recursive: true, force: true }); });

// EACH TEST GETS ITS OWN EMPLOYER. They share one store, and the share
// breaker reasons about a whole board — so rows another test left behind are
// not clutter, they change the answer. The first run of this file failed for
// exactly that reason, which is the breaker working.
let seq = 0;
const CO = () => `TestCo${++seq}`;
const mk = (url, company = 'Tesla', title = 'Manufacturing Engineer') => ({
  url, title, company, location: 'Austin, Texas', source: 'browser-assist',
  company_meta: { tier: 'tracked', careers_url: '', sponsors_h1b: false },
  triage: triage({ title, description: '', location: 'Austin, Texas', url }),
});
const U = (n, slug = 'mfg-eng') => `https://www.tesla.com/careers/search/job/${slug}-${n}`;
/** A feed big enough to clear MIN_FEED, plus whatever ids the test cares about. */
const feed = (...ids) => [...Array.from({ length: MIN_FEED + 5 }, (_, i) => String(900000 + i)), ...ids.map(String)];

// ── reqIdOf ─────────────────────────────────────────────────────────

test('the requisition id is the trailing number of the posting url', () => {
  assert.equal(reqIdOf('https://www.tesla.com/careers/search/job/mfg-eng-273084'), '273084');
  assert.equal(reqIdOf('https://boards.example.com/jobs/44120'), '44120');
  assert.equal(reqIdOf('https://x.test/req_88231'), '88231');
});

test('a url with no trailing number yields nothing rather than a guess', () => {
  assert.equal(reqIdOf('https://x.test/careers/manufacturing-engineer'), '');
  assert.equal(reqIdOf('https://x.test/jobs/'), '');
  assert.equal(reqIdOf(''), '');
  assert.equal(reqIdOf(null), '');
  assert.equal(reqIdOf('https://x.test/job/7'), '', 'a single digit is not a requisition number');
});

// ── the breakers ────────────────────────────────────────────────────

test('a feed too small to be a whole board retires nothing', () => {
  const co = CO();
  upsertJobs([mk(U(100001), co), mk(U(100002), co)]);
  const plan = planSweep(co, ['999999']);
  assert.equal(plan.wouldRetire, 0);
  assert.ok(plan.refusals.some(r => r.includes('too few')), plan.refusals.join('; '));
});

test('a feed that would kill most of a board retires nothing', () => {
  const co = CO();
  const urls = Array.from({ length: 40 }, (_, i) => U(200000 + i));
  upsertJobs(urls.map(u => mk(u, co)));
  // Only two of the forty are still listed — that is a truncated feed.
  const plan = planSweep(co, feed(200000, 200001));
  assert.ok(plan.share > MAX_RETIRE_SHARE);
  assert.equal(plan.wouldRetire, 0);
  assert.ok(plan.refusals.some(r => r.includes('truncated feed')), plan.refusals.join('; '));
});

test('a refused sweep writes nothing at all', async () => {
  const co = CO();
  const url = U(300001);
  upsertJobs([mk(url, co)]);
  const plan = await sweep(co, ['999999']);
  assert.equal(plan.retired, 0);
  assert.equal(getJob(jobId(url)).goneAt, null, 'a refusal must leave every row exactly where it was');
});

// ── the working case ────────────────────────────────────────────────

test('a posting absent from the employer own index is retired', async () => {
  const co = CO();
  const alive = U(400001, 'still-open');
  const dead = U(400002, 'closed');
  upsertJobs([mk(alive, co), mk(dead, co)]);
  const plan = await sweep(co, feed(400001));
  assert.equal(plan.retired, 1);
  assert.equal(getJob(jobId(dead)).goneAt !== null, true, 'absent from the index means closed');
  assert.equal(getJob(jobId(alive)).goneAt, null, 'present in the index means open');
});

test('a row whose url carries no requisition id is left alone and counted', () => {
  const co = CO();
  const unkeyable = 'https://www.tesla.com/careers/search/job/manufacturing-engineer';
  upsertJobs([mk(unkeyable, co), mk(U(500001), co)]);
  const plan = planSweep(co, feed(500001));
  assert.ok(plan.unkeyed >= 1, 'the count must be reported, not folded into "still live"');
  assert.ok(!plan.dead.some(d => d.url === unkeyable), 'cannot-tell must never become dead');
});

test('another employer is never touched by one board sweep', async () => {
  const co = CO(), other = CO();
  const mine = U(600001);
  const theirs = 'https://jobs.joby.aero/careers/job/600001';
  upsertJobs([mk(mine, co), mk(theirs, other)]);
  await sweep(co, feed(700001, 700002, 700003));
  assert.equal(getJob(jobId(theirs)).goneAt, null, 'the same req number at another employer is a different job');
});

test('an already-retired row is not re-stamped', async () => {
  const co = CO();
  const url = U(800001);
  // Two rows, one listed, so the sweep retires half and the breaker holds.
  const kept = U(800002);
  upsertJobs([mk(url, co), mk(kept, co)]);
  await sweep(co, feed(800002));
  const first = getJob(jobId(url)).goneAt;
  assert.ok(first, 'precondition: retired on the first pass');
  const again = await sweep(co, feed(800002));
  assert.ok(!again.dead.some(d => d.url === url), 'a retired row is out of the candidate set entirely');
  assert.equal(getJob(jobId(url)).goneAt, first, 'and its timestamp is the date it actually closed');
});

test('a dry run reports the same plan and changes nothing', async () => {
  const co = CO();
  const url = U(810001);
  upsertJobs([mk(url, co), mk(U(810002), co)]);
  const plan = await sweep(co, feed(810002), { dryRun: true });
  assert.equal(plan.dead.length, 1, 'the plan still names it');
  assert.equal(plan.retired, 0);
  assert.equal(getJob(jobId(url)).goneAt, null);
});

test('the plan says what it judged and what it could not', () => {
  const co = CO();
  upsertJobs([
    mk(U(820001), co), mk(U(820002), co),
    mk('https://www.tesla.com/careers/search/job/no-number-here', co),
  ]);
  const plan = planSweep(co, feed(820001, 820002));
  assert.equal(plan.judged, plan.keep + plan.dead.length);
  assert.ok(plan.feedSize >= MIN_FEED);
  assert.ok(plan.storeLive >= plan.judged, 'unkeyed rows are live but unjudged, and the two numbers differ');
});

test('non-numeric junk in the feed is ignored rather than trusted', () => {
  const co = CO();
  upsertJobs([mk(U(830001), co)]);
  const plan = planSweep(co, ['abc', '', null, undefined, '7', ...feed(830001)]);
  assert.ok(plan.feedSize >= MIN_FEED, 'the real ids still count');
  assert.ok(!plan.dead.some(d => d.req === '830001'), 'a listed req stays listed');
});
