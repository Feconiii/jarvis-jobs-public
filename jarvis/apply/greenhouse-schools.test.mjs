/**
 * P3: the board's own spelling of his school. No network: every board answer
 * is a fixture shaped like the two live answers read on 2026-11-12
 * ({ items: [{ id, text }], meta }; an unknown board is a 404).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { greenhouseBoardToken, schoolTerms, matchSchool, boardSchoolSpelling, asksSchoolName, schoolKey } from './greenhouse-schools.mjs';
import { planForm } from '../apply-plan.mjs';

test('the board token, from every shape of a Greenhouse application URL', () => {
  assert.equal(greenhouseBoardToken('https://job-boards.greenhouse.io/acmerobotics/jobs/5415901008'), 'acmerobotics');
  assert.equal(greenhouseBoardToken('https://boards.greenhouse.io/AcmeRobotics/jobs/123?gh_src=x'), 'acmerobotics');
  assert.equal(greenhouseBoardToken('https://job-boards.greenhouse.io/embed/job_app?for=acmerobotics&token=99'), 'acmerobotics');
  assert.equal(greenhouseBoardToken('https://boards.greenhouse.io/embed/job_app?token=99'), null, 'an embed without `for` names no board');
  assert.equal(greenhouseBoardToken('https://acme.example/careers?gh_jid=123'), null, 'not a Greenhouse host');
  assert.equal(greenhouseBoardToken('not a url'), null);
});

test('search terms: his spelling, the name without its place, and the first word a search can use', () => {
  assert.deepEqual(schoolTerms('Lakeside University'), ['Lakeside University', 'lakeside']);
  assert.deepEqual(schoolTerms('University of Washington'), ['University of Washington', 'washington']);
  assert.deepEqual(schoolTerms('Lakeside University, Springfield, WA'), ['Lakeside University, Springfield, WA', 'Lakeside University', 'lakeside']);
  assert.deepEqual(schoolTerms(''), []);
});

test('the four tests, and the near misses that are different schools', () => {
  const list = ['University of Washington', 'Washington State University', 'Washington University in St. Louis', 'Lakeside University'];
  assert.equal(matchSchool('university of washington', list), 'University of Washington', '1: case aside');
  assert.equal(matchSchool('Univ. of Washington', list), 'University of Washington', '2: "Univ." and punctuation aside');
  assert.equal(matchSchool('The Lakeside University', list), 'Lakeside University', '2: a leading "The" aside');
  assert.equal(matchSchool('Texas A&M University', ['Texas A and M University']), 'Texas A and M University', '2: "&" is "and"');
  assert.equal(matchSchool('Lakeside University', ['Lakeside University - Springfield', 'Lakeside in Florence']), 'Lakeside University - Springfield', '3: the board adds a campus');
  assert.equal(matchSchool('Lakeside University, Springfield, WA', ['Lakeside University', 'Lakeside College High School']), null, 'his name with its place cut off is not a pick (only a search term)');
  assert.equal(matchSchool('Washington', list), null, 'one shared word is no school');
  assert.equal(matchSchool('Washington University', list), null, '"Washington University" is not "Washington University in St. Louis" by these tests, nor UW');
  assert.equal(matchSchool('Lakeside University', ['Lakeside University - Springfield', 'Lakeside University - Florence']), null, 'two campuses fit equally: not ours to choose');
  assert.equal(matchSchool('Lakeside University', []), null);
  assert.equal(schoolKey('  The  Univ of X & Y '), 'university of x and y');
});

test('a campus cut off his name is a different school: no umbrella pick (review 2026-11-12)', () => {
  const uc = ['University of California', 'University of California, Los Angeles', 'University of California, Davis'];
  assert.equal(matchSchool('University of California, Berkeley', uc), null, 'Berkeley is not the UC system');
  assert.equal(matchSchool('University of Washington, Tacoma', ['University of Washington', 'Washington State University']), null, 'Tacoma is not UW Seattle');
  assert.equal(matchSchool('University of California, Berkeley', [...uc, 'University of California, Berkeley']), 'University of California, Berkeley', 'the exact row still wins');
});

test('a campus row wins only from the board\'s whole answer, never from page 1 of several', () => {
  const page1 = ['Lakeside University - Springfield', 'Lakeside College High School'];
  assert.equal(matchSchool('Lakeside University', page1), 'Lakeside University - Springfield', 'whole answer: the campus row is his school');
  assert.equal(matchSchool('Lakeside University', page1, { complete: false }), null, 'a later page may hold "Lakeside University" itself');
  assert.equal(matchSchool('Lakeside University', ['Lakeside University', ...page1], { complete: false }), 'Lakeside University', 'an exact row on page 1 still wins');
});

/** A fake board: answers each term from `schools` the way the endpoint does (contains, case aside). */
function fakeBoard(schools, { status = 200, delayMs = 0, perPage = 100 } = {}) {
  const asked = [];
  const fetchImpl = async (url, { signal } = {}) => {
    asked.push(decodeURIComponent(new URL(url).searchParams.get('term')));
    if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    if (status !== 200) return { ok: false, status, json: async () => ({ status, error: 'Couldn\'t find JobBoard' }) };
    const term = decodeURIComponent(new URL(url).searchParams.get('term')).toLowerCase();
    const all = schools.filter((s) => s.toLowerCase().includes(term)).map((text, i) => ({ id: i + 1, text }));
    return { ok: true, status: 200, json: async () => ({ items: all.slice(0, perPage), meta: { total_count: all.length, per_page: perPage } }) };
  };
  return { fetchImpl, asked };
}

test('the lookup reads meta.total_count: a campus row on a partial page 1 is not taken', async () => {
  const schools = ['Lakeside University - Springfield', 'Lakeside College High School', 'Lakeside University'];
  const partial = fakeBoard(schools, { perPage: 1 });
  assert.equal(await boardSchoolSpelling('acme', 'Lakeside University', { fetchImpl: partial.fetchImpl, cache: new Map() }), null,
    'page 1 holds only the campus row; the exact school is on page 2');
  const whole = fakeBoard(schools.slice(0, 2));
  assert.equal(await boardSchoolSpelling('acme', 'Lakeside University', { fetchImpl: whole.fetchImpl, cache: new Map() }), 'Lakeside University - Springfield',
    'the whole answer has no exact row: the campus row is his school');
});

test('the board is asked term by term until one names his school, and the answer is cached', async () => {
  const board = fakeBoard(['University of Washington', 'Washington State University']);
  const cache = new Map();
  const got = await boardSchoolSpelling('acme', 'Univ. of Washington', { fetchImpl: board.fetchImpl, cache });
  assert.equal(got, 'University of Washington');
  assert.deepEqual(board.asked, ['Univ. of Washington', 'washington'], 'the full name found nothing, the distinctive word did');
  const again = await boardSchoolSpelling('acme', 'Univ. of Washington', { fetchImpl: board.fetchImpl, cache });
  assert.equal(again, 'University of Washington');
  assert.equal(board.asked.length, 2, 'the second plan asks nothing');
});

test('an unknown board, a slow board and a broken fetch all leave the plan alone', async () => {
  const gone = fakeBoard([], { status: 404 });
  assert.equal(await boardSchoolSpelling('nosuch', 'Lakeside University', { fetchImpl: gone.fetchImpl, cache: new Map() }), null);
  assert.equal(gone.asked.length, 1, 'a 404 is the board\'s answer: no further terms');
  const slow = fakeBoard(['Lakeside University'], { delayMs: 5000 });
  const t0 = Date.now();
  assert.equal(await boardSchoolSpelling('acme', 'Lakeside University', { fetchImpl: slow.fetchImpl, cache: new Map(), capMs: 300 }), null);
  assert.ok(Date.now() - t0 < 1500, 'the cap holds');
  assert.equal(await boardSchoolSpelling('acme', 'Lakeside University', { fetchImpl: async () => { throw new Error('offline'); }, cache: new Map() }), null);
  assert.equal(await boardSchoolSpelling('', 'Lakeside University', { fetchImpl: slow.fetchImpl }), null);
});

test('only a form that asks which school sends the board a question', () => {
  assert.equal(asksSchoolName([{ id: 'school--0', label: 'School' }]), true);
  assert.equal(asksSchoolName([{ label: 'School *' }]), true);
  assert.equal(asksSchoolName([{ label: 'Are you currently enrolled in school?' }, { label: 'School location' }]), false);
});

test('the plan types the board\'s spelling first and keeps his own after it', () => {
  const profile = { education: { school: 'Univ. of Washington' }, boardSchool: 'University of Washington' };
  const [a] = planForm([{ id: 'school--0', label: 'School', type: 'prompt', promptKind: 'combo', required: true }], profile).actions;
  assert.equal(a.action, 'prompt');
  assert.equal(a.value, 'University of Washington');
  assert.deepEqual(a.values, ['University of Washington', 'Univ. of Washington']);
  const [same] = planForm([{ id: 'school--0', label: 'School', type: 'prompt', promptKind: 'combo' }], { education: { school: 'Lakeside University' }, boardSchool: 'Lakeside University' }).actions;
  assert.equal(same.value, 'Lakeside University');
  assert.equal(same.values, undefined, 'the same spelling is one answer, not two');
  const [none] = planForm([{ id: 'school--0', label: 'School', type: 'prompt', promptKind: 'combo' }], { education: { school: 'Lakeside University' } }).actions;
  assert.equal(none.value, 'Lakeside University', 'no board answer: exactly as before');
});
