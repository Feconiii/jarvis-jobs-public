// jarvis/inbox-reach-order.test.mjs — a reach pick is listed after the plain fits of its band (his call, 2026-11-04),
// and a reach card gets no tailored resume unless he asks (F-934 c).
//
// The Inbox's order lives in dashboard.html; this runs the page's own comparator
// code (cut from the file between its markers) against rows, so the test reads
// what the page runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isReachCard, resumeBuildFor, REACH_BASE_LINE } from './pick-fields.mjs';

const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const start = html.indexOf('const dead = (j) => (j.goneAt ? 1 : 0);');
const endMark = '|| byScore * ((band(b) - band(a)) || (reach(a) - reach(b))));';
const end = html.indexOf(endMark, start);
assert.ok(start > 0 && end > start, 'the Inbox comparator is where this test expects it');
const body = html.slice(start, end + endMark.length).replace('S.filtered = [...S.filtered].sort(', 'return [...rows].sort(');
const run = new Function('rows', 'S', 'filedToday', '$', body);
const order = (rows, sort = 'rel') => run(rows, { filedFirst: false }, () => false, () => ({ value: sort })).map((r) => r.id);

const row = (id, band, note = '', extra = {}) => ({ id, status: 'inbox', fit: { band }, pickNote: note, ...extra });

test('within a band the reach comes after the fits; between bands nothing changes', () => {
  const rows = [
    row('strong-reach', 'strong', 'Reach: degree. Worth a look: …'),
    row('strong-fit', 'strong', 'Keep: …'),
    row('good-fit', 'good', 'Keep: …'),
    row('good-reach', 'good', 'Reach: level. Keep: …'),
    row('good-fit-2', 'good'),
  ];
  assert.deepEqual(order(rows), ['strong-fit', 'strong-reach', 'good-fit', 'good-fit-2', 'good-reach']);
  assert.deepEqual(order(rows, 'fit'), ['strong-fit', 'strong-reach', 'good-fit', 'good-fit-2', 'good-reach']);
});

test('a stretch (a robotics role asking 1-2 years, his answer 2026-11-06) comes after the fits and the reaches of its band', () => {
  const rows = [
    row('good-stretch', 'good', 'Stretch: asks 1-2 yrs. Worth a look: …'),
    row('good-reach', 'good', 'Reach: level. Keep: …'),
    row('good-fit', 'good', 'Keep: …'),
    row('strong-stretch', 'strong', 'Stretch: asks 1-2 yrs. Keep: …'),
  ];
  assert.deepEqual(order(rows), ['strong-stretch', 'good-fit', 'good-reach', 'good-stretch']);
});

test('a strong reach still outranks a good fit, and dead and queued rows keep their places', () => {
  const rows = [
    row('good-fit', 'good'),
    row('strong-reach', 'strong', 'Reach: field.'),
    row('dead-strong', 'strong', '', { goneAt: '2026-11-01' }),
    row('queued-strong', 'strong', '', { status: 'queued' }),
  ];
  assert.deepEqual(order(rows), ['strong-reach', 'good-fit', 'queued-strong', 'dead-strong']);
});

test('"newest" and "company" sorts keep the server\'s order: no band grouping (review)', () => {
  const rows = [row('good-fit', 'good'), row('strong-reach', 'strong', 'Reach: field.'), row('strong-fit', 'strong')];
  for (const sort of ['new', 'company']) assert.deepEqual(order(rows, sort), ['good-fit', 'strong-reach', 'strong-fit'], sort);
});

test('a reach card opened gets the family base; any press or panel request tailors (F-934 c)', () => {
  const reachJob = { id: 'r1', pickNote: 'Reach: degree. Worth a look: …' };
  const fitJob = { id: 'f1', pickNote: 'Keep: …' };
  assert.equal(isReachCard(reachJob), true);
  assert.equal(isReachCard({ pick_note: 'Reach: level.' }), true, 'a store row too');
  assert.equal(isReachCard(fitJob), false);
  // The page said which job it is: not an ask.
  assert.deepEqual(resumeBuildFor(reachJob, null, { ask: false }), { start: { untailored: true } });
  assert.deepEqual(resumeBuildFor(fitJob, null, { ask: false }), { start: { untailored: false } }, 'a plain fit tailors as before');
  // A press or panel request: the base is replaced, a tailored build is kept.
  const base = { status: 'ready', untailored: true };
  const tailored = { status: 'ready', untailored: false };
  assert.deepEqual(resumeBuildFor(reachJob, base, { ask: true }), { start: { untailored: false } });
  assert.deepEqual(resumeBuildFor(reachJob, tailored, { ask: true }), { use: tailored });
  assert.deepEqual(resumeBuildFor(reachJob, base, { ask: false }), { use: base }, 'opening the page again keeps the base');
  assert.match(REACH_BASE_LINE, /^Reach card: base resume; press Build it again to tailor\.$/);
});

test('serve.mjs: page-open asks for the base, every press tailors, and the base is never kept for reuse (wiring)', () => {
  const src = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  assert.match(src, /resumeBuildFor\(job, null, \{ ask: false \}\)\.start/, '/api/apply-page: not an ask');
  assert.equal((src.match(/\{ ask: true \}/g) || []).length, 3, 'Apply press, /api/plan and the resume request all ask');
  assert.match(src, /if \(!untailored\) try \{\s*saveBuild\(/, 'an untailored base is not saved for reuse');
  assert.match(src, /tailor: async \(\) => \(\{ why: REACH_BASE_LINE, plan: null, rewrites: \{\} \}\)/, 'no tailoring call for the base');
});
