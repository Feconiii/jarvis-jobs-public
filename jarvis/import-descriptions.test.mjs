// jarvis/import-descriptions.test.mjs — the assisted channel carries bodies (F-443).
//
// What these guard is not "the importer runs". It is the two ways this fix
// could be worse than the bug it replaces:
//
//   1. Writing a body that is not a body. `has_desc = 1` on a cookie banner is
//      strictly worse than `has_desc = 0`, because the second says "unread"
//      and the first lies.
//   2. Writing a body without rescoring it. A posting read for the first time
//      that keeps its title-only fit — and its `f_hard_block = 0` — is the
//      exact failure F-443 is about, recommitted through a new door.
//
// So the F-434-shaped lesson applies here too: assert what the gate must LEAVE
// ALONE, not only what it must catch. A test that only checks the happy path
// would have passed on an importer that silently overwrote every description
// in the store.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// A private store, so a test can never touch his data.
const DIR = mkdtempSync(path.join(tmpdir(), 'jarvis-impdesc-'));
process.env.JARVIS_DATA_DIR = DIR;

const { normalizeRow, importDescriptions, resolveReqId, resolveReqIds, MIN_DESCRIPTION } = await import('./import-descriptions.mjs');
const { upsertJobs, getJob, jobId, getDescription, closeDb } = await import('./store.mjs');
const { triage } = await import('./triage.mjs');

const LONG = 'Mechanical engineering role in a wafer fabrication facility. '.repeat(4);

test.after(() => { try { closeDb(); } catch {} rmSync(DIR, { recursive: true, force: true }); });

// ── normalizeRow ────────────────────────────────────────────────────

test('a url is turned into the same id the scanner would have written', () => {
  const url = 'https://www.tesla.com/careers/search/job/manufacturing-engineer-123';
  const n = normalizeRow({ url, description: LONG });
  assert.equal(n.id, jobId(url), 'a harvest must line up with rows the scan already wrote');
});

test('an explicit id wins over the url', () => {
  const n = normalizeRow({ id: 'abc123', url: 'https://x.test/y', description: LONG });
  assert.equal(n.id, 'abc123');
});

test('html comes in, text goes out', () => {
  const n = normalizeRow({ url: 'https://x.test/y', description: `<div><p>${LONG}</p></div>` });
  assert.ok(!n.description.includes('<p>'), 'markup must not reach the store');
  assert.ok(n.description.includes('Mechanical engineering role'));
});

test('body, text and description are all accepted spellings', () => {
  for (const key of ['description', 'body', 'text']) {
    const n = normalizeRow({ url: 'https://x.test/y', [key]: LONG });
    assert.ok(n.description, `${key} should be read as the body`);
  }
});

test('a short body is refused, not written', () => {
  const n = normalizeRow({ url: 'https://x.test/y', description: 'Apply now' });
  assert.equal(n.error, 'description too short to use');
});

test('the short-body floor matches the one enrich.mjs uses', () => {
  assert.equal(MIN_DESCRIPTION, 40, 'two floors that drift apart are two definitions of "read"');
  const justUnder = 'x'.repeat(MIN_DESCRIPTION - 1);
  const justOver = 'x'.repeat(MIN_DESCRIPTION);
  assert.ok(normalizeRow({ url: 'https://x.test/y', description: justUnder }).error);
  assert.ok(!normalizeRow({ url: 'https://x.test/y', description: justOver }).error);
});

test('a row with no id and no url is refused rather than guessed at', () => {
  assert.equal(normalizeRow({ description: LONG }).error, 'no id and no usable url');
});

test('a relative url is not treated as a url', () => {
  assert.equal(normalizeRow({ url: '/careers/job/1', description: LONG }).error, 'no id and no usable url');
});

test('junk rows cost themselves, not the run', () => {
  assert.equal(normalizeRow(null).error, 'not an object');
  assert.equal(normalizeRow('a string').error, 'not an object');
  assert.equal(normalizeRow({ url: 'https://x.test/y' }).error, 'no description');
});

test('corrections travel with the body when present, and only when present', () => {
  const bare = normalizeRow({ url: 'https://x.test/y', description: LONG });
  assert.ok(!('title' in bare), 'an absent title must not become an empty one');
  assert.ok(!('location' in bare));
  const full = normalizeRow({ url: 'https://x.test/y', description: LONG, title: ' Mfg Eng ', location: 'Austin, TX', team: 'Cell' });
  assert.equal(full.title, 'Mfg Eng', 'whitespace trimmed');
  assert.equal(full.location, 'Austin, TX');
  assert.equal(full.team, 'Cell');
});

test('an unparseable postedAt is dropped rather than written as NaN', () => {
  const n = normalizeRow({ url: 'https://x.test/y', description: LONG, postedAt: 'not a date' });
  assert.ok(!('postedAt' in n));
  const ok = normalizeRow({ url: 'https://x.test/y', description: LONG, postedAt: '2026-09-01T00:00:00Z' });
  assert.equal(ok.postedAt, Date.parse('2026-09-01T00:00:00Z'));
});

// ── importDescriptions, against a real store ────────────────────────

const mkJob = (url, over = {}) => ({
  url,
  title: over.title || 'Manufacturing Engineer',
  company: over.company || 'Tesla',
  location: over.location || 'Austin, Texas',
  source: 'browser-assist',
  company_meta: { tier: 'tracked', careers_url: '', sponsors_h1b: false },
  triage: triage({ title: over.title || 'Manufacturing Engineer', description: '', location: over.location || 'Austin, Texas', url }),
  ...over,
});

test('a harvested body lands on the row and the row counts as read', async () => {
  const url = 'https://www.tesla.com/careers/search/job/mfg-eng-9001';
  upsertJobs([mkJob(url)]);
  const id = jobId(url);
  assert.equal(getJob(id).hasDesc, 0, 'precondition: the listing import leaves it unread');

  const stats = await importDescriptions([{ url, description: LONG }]);
  assert.equal(stats.written, 1);
  assert.equal(getJob(id).hasDesc, 1);
  assert.ok(getDescription(id).includes('wafer fabrication'));
});

test('reading a posting is what finds a work-authorisation wall', async () => {
  const url = 'https://www.tesla.com/careers/search/job/blocked-9002';
  upsertJobs([mkJob(url)]);
  const id = jobId(url);
  assert.ok(!getJob(id).triage?.flags?.hardBlock, 'precondition: a title-only row is not blocked');

  const stats = await importDescriptions([{
    url,
    description: 'Manufacturing engineering role. Applicants must be a U.S. Citizen or Permanent Resident. This position requires access to ITAR-controlled technical data and we will not sponsor applicants for work visas.',
  }]);
  assert.equal(stats.written, 1);
  assert.equal(stats.newBlocks, 1, 'the block must be counted, not just applied');
  assert.ok(getJob(id).triage.flags.hardBlock, 'the visa gate must run on the imported body');
});

test('the fit score is recomputed, not left at its title-only value', async () => {
  const url = 'https://www.tesla.com/careers/search/job/rescore-9003';
  upsertJobs([mkJob(url)]);
  const id = jobId(url);
  const before = getJob(id).fit;
  await importDescriptions([{ url, description: LONG + ' Requires CAD, GD&T, fixture design, cleanroom and process validation experience. ' }]);
  const after = getJob(id).fit;
  assert.ok(after, 'a read posting must carry a fit score');
  // Not asserting a direction — the point is that scoring RAN over the body,
  // which a title-only score cannot have done.
  assert.notDeepStrictEqual(after, before, 'a body that scoring never saw is a body that was not really read');
});

test('a description with no posting behind it creates nothing', async () => {
  const stats = await importDescriptions([{ url: 'https://www.tesla.com/careers/search/job/never-scanned-9', description: LONG }]);
  assert.equal(stats.written, 0);
  assert.equal(stats.unmatched, 1);
  assert.equal(getJob(jobId('https://www.tesla.com/careers/search/job/never-scanned-9')), null,
    'inventing a job from a stray body would put a posting in his deck no scan ever saw');
});

test('an already-read posting is left alone unless forced', async () => {
  const url = 'https://www.tesla.com/careers/search/job/already-9004';
  upsertJobs([mkJob(url)]);
  const id = jobId(url);
  await importDescriptions([{ url, description: LONG + ' first body. ' }]);

  const again = await importDescriptions([{ url, description: 'A totally different second body about something else entirely, long enough to pass.' }]);
  assert.equal(again.written, 0);
  assert.equal(again.alreadyRead, 1);
  assert.ok(getDescription(id).includes('first body'), 'a re-harvest must not silently clobber a good read');

  const forced = await importDescriptions([{ url, description: 'A totally different second body about something else entirely, long enough to pass.' }], { force: true });
  assert.equal(forced.written, 1);
  assert.ok(getDescription(id).includes('second body'), '--force is the way to overwrite, and the only way');
});

test('--company guards against a harvest run on the wrong tab', async () => {
  const url = 'https://www.tesla.com/careers/search/job/guard-9005';
  upsertJobs([mkJob(url)]);
  const stats = await importDescriptions([{ url, description: LONG }], { company: 'Joby Aviation' });
  assert.equal(stats.written, 0);
  assert.equal(stats.wrongCompany, 1, 'silently writing nothing would read like an empty board');
  assert.equal(getJob(jobId(url)).hasDesc, 0);
});

test('--company matches case-insensitively', async () => {
  const url = 'https://www.tesla.com/careers/search/job/guard-9006';
  upsertJobs([mkJob(url)]);
  const stats = await importDescriptions([{ url, description: LONG }], { company: 'tesla' });
  assert.equal(stats.written, 1);
});

test('a dry run reports what it would do and changes nothing', async () => {
  const url = 'https://www.tesla.com/careers/search/job/dry-9007';
  upsertJobs([mkJob(url)]);
  const stats = await importDescriptions([{ url, description: LONG }], { dryRun: true });
  assert.equal(stats.written, 1, 'the count is a forecast');
  assert.equal(getJob(jobId(url)).hasDesc, 0, 'and nothing was written');
});

test('one bad row does not cost the good rows beside it', async () => {
  const good = 'https://www.tesla.com/careers/search/job/mixed-good-9008';
  const alsoGood = 'https://www.tesla.com/careers/search/job/mixed-good-9009';
  upsertJobs([mkJob(good), mkJob(alsoGood)]);
  const stats = await importDescriptions([
    { url: good, description: LONG },
    null,
    { url: 'https://x.test/nope', description: LONG },
    { description: LONG },
    { url: alsoGood, description: 'too short' },
    { url: alsoGood, description: LONG },
  ]);
  assert.equal(stats.written, 2);
  assert.equal(stats.unmatched, 1);
  assert.equal(stats.skipped, 3);
  assert.equal(getJob(jobId(good)).hasDesc, 1);
  assert.equal(getJob(jobId(alsoGood)).hasDesc, 1);
});

test('an empty harvest is a clean no-op, not an error', async () => {
  const stats = await importDescriptions([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.written, 0);
});

test('every skip carries a reason a human can act on', async () => {
  const stats = await importDescriptions([
    { url: 'https://x.test/a', description: 'short' },
    { description: LONG },
  ]);
  const reasons = [...stats.reasons.keys()];
  assert.ok(reasons.includes('description too short to use'));
  assert.ok(reasons.includes('no id and no usable url'));
  assert.ok(reasons.every(r => r && r.length > 8), 'a reason like "bad" is not a diagnosis');
});

test('a corrected title and location travel onto the row with the body', async () => {
  const url = 'https://www.tesla.com/careers/search/job/fix-9010';
  upsertJobs([mkJob(url, { title: 'Engineer', location: 'Unknown' })]);
  const id = jobId(url);
  await importDescriptions([{ url, description: LONG, title: 'Manufacturing Engineer, Cell', location: 'Austin, Texas' }]);
  const job = getJob(id);
  assert.equal(job.title, 'Manufacturing Engineer, Cell');
  assert.equal(job.location, 'Austin, Texas');
});

// ── requisition ids (F-446) ─────────────────────────────────────────
//
// A harvest that talks to an employer's detail API knows the req number and
// nothing else. Resolving that back to a row is the one step here that can
// write the WRONG posting's description onto a job, so these assert the
// refusals at least as hard as the matches.

test('a reqId row is accepted by normalizeRow and left for the store to resolve', () => {
  const n = normalizeRow({ reqId: '273084', description: LONG });
  assert.equal(n.reqId, '273084');
  assert.ok(!n.id, 'the id is not knowable without the store');
});

test('an id or url still wins over a reqId', () => {
  const n = normalizeRow({ reqId: '273084', url: 'https://x.test/y', description: LONG });
  assert.equal(n.id, jobId('https://x.test/y'));
  assert.ok(!('reqId' in n));
});

test('a reqId that is not a number is not a key', () => {
  for (const bad of ['', 'abc', '7', 'req-273084', '  ']) {
    assert.equal(normalizeRow({ reqId: bad, description: LONG }).error, 'no id and no usable url', `"${bad}" should not resolve`);
  }
});

test('a reqId resolves against the trailing number of the posting url', () => {
  const url = 'https://www.tesla.com/careers/search/job/mfg-eng-880001';
  upsertJobs([mkJob(url)]);
  assert.equal(resolveReqId('880001', 'Tesla'), jobId(url));
});

test('a longer number ending in the same digits is NOT a match', () => {
  // The failure this guards is silent and permanent: req 880002 written onto
  // req 1880002's row reads as a successful import.
  const other = 'https://www.tesla.com/careers/search/job/other-role-1880002';
  upsertJobs([mkJob(other)]);
  assert.equal(resolveReqId('880002', 'Tesla'), null, 'a suffix match on digits alone is a mismatch waiting to happen');
});

test('an ambiguous reqId returns nothing rather than picking one', () => {
  upsertJobs([
    mkJob('https://www.tesla.com/careers/search/job/role-a-990009'),
    mkJob('https://www.tesla.com/careers/search/job/role-b/990009'),
  ]);
  assert.equal(resolveReqId('990009', 'Tesla'), null, 'two candidates means the convention does not hold for this board');
});

test('the company scope keeps two employers reusing a number apart', () => {
  upsertJobs([
    mkJob('https://www.tesla.com/careers/search/job/tesla-role-770007'),
    mkJob('https://boards.example.com/jobs/770007', { company: 'Joby Aviation' }),
  ]);
  assert.equal(resolveReqId('770007', 'Tesla'), jobId('https://www.tesla.com/careers/search/job/tesla-role-770007'));
  assert.equal(resolveReqId('770007', 'Joby Aviation'), jobId('https://boards.example.com/jobs/770007'));
  assert.equal(resolveReqId('770007', null), null, 'unscoped, the same number at two employers is ambiguous');
});

test('an unresolvable reqId is reported by number, not as a generic miss', async () => {
  const stats = await importDescriptions([{ reqId: '111119', description: LONG }], { company: 'Tesla' });
  assert.equal(stats.written, 0);
  assert.equal(stats.unmatched, 1);
  assert.ok([...stats.reasons.keys()].some(r => r.includes('111119')), 'the reason should name the req that failed');
});

test('a reqId harvest writes the body onto the right row end to end', async () => {
  const url = 'https://www.tesla.com/careers/search/job/end-to-end-660006';
  upsertJobs([mkJob(url)]);
  const stats = await importDescriptions([{ reqId: '660006', description: LONG, title: 'Manufacturing Engineer, Cell' }], { company: 'Tesla' });
  assert.equal(stats.written, 1);
  const job = getJob(jobId(url));
  assert.equal(job.hasDesc, 1);
  assert.equal(job.title, 'Manufacturing Engineer, Cell');
});

// ── one requisition, several rows (F-449 follow-on) ─────────────────
//
// A board can carry the same posting under two URL spellings — Joby has both
// `/jobs/3726/job` and `/jobs/3726/systems-test-engineer/job`, live and
// un-superseded. Those are one job, so one harvested body belongs on both.
// The dangerous case stays refused: a number that resolves to a DIFFERENT
// requisition, or to two different employers.

test('one requisition writes to every row that names it', async () => {
  const co = 'DupCo';
  const bare = 'https://careers-dup.icims.com/jobs/7712/job';
  const slug = 'https://careers-dup.icims.com/jobs/7712/systems-test-engineer/job';
  upsertJobs([mkJob(bare, { company: co }), mkJob(slug, { company: co })]);

  const ids = resolveReqIds('7712', co);
  assert.equal(ids.length, 2, 'both spellings name requisition 7712');

  const stats = await importDescriptions([{ reqId: '7712', description: LONG }], { company: co });
  assert.equal(stats.written, 2, 'the body goes on both rows, because they are one job');
  assert.equal(getJob(jobId(bare)).hasDesc, 1);
  assert.equal(getJob(jobId(slug)).hasDesc, 1);
});

test('a near-miss number is still not a match, however many rows exist', () => {
  const co = 'DupCo2';
  upsertJobs([
    mkJob('https://careers-dup.icims.com/jobs/18812/job', { company: co }),
    mkJob('https://careers-dup.icims.com/jobs/18812/some-role/job', { company: co }),
  ]);
  assert.deepEqual(resolveReqIds('8812', co), [], 'a suffix of the number is a different requisition');
  assert.equal(resolveReqIds('18812', co).length, 2);
});

test('unscoped, one number at two employers still refuses', () => {
  upsertJobs([
    mkJob('https://a.test/jobs/60601/job', { company: 'AlphaCo' }),
    mkJob('https://b.test/jobs/60601/job', { company: 'BetaCo' }),
  ]);
  assert.deepEqual(resolveReqIds('60601', null), [], 'no way to tell whose body this is');
  assert.equal(resolveReqIds('60601', 'AlphaCo').length, 1);
});

test('a second harvest of a duplicated requisition does not rewrite either row', async () => {
  const co = 'DupCo3';
  upsertJobs([
    mkJob('https://careers-dup.icims.com/jobs/9911/job', { company: co }),
    mkJob('https://careers-dup.icims.com/jobs/9911/role/job', { company: co }),
  ]);
  await importDescriptions([{ reqId: '9911', description: LONG + ' first. ' }], { company: co });
  const again = await importDescriptions([{ reqId: '9911', description: LONG + ' second. ' }], { company: co });
  assert.equal(again.written, 0);
  assert.equal(again.alreadyRead, 2, 'both rows report as already read, not one');
});
