// jarvis/resolve-copies.test.mjs — LinkedIn-copy picks found on the employer's own board (F-1006).
//
// Runs against a temp store: JARVIS_DATA_DIR is set before store.mjs is loaded.
// The guard is the real one (dedupe.linkable → same-posting.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-resolve-copies-'));
process.env.JARVIS_DATA_DIR = dir;
delete process.env.JARVIS_DB_PATH;
const store = await import('./store.mjs');
assert.ok(path.resolve(store.dbPath()).toLowerCase().startsWith(path.resolve(tmpdir()).toLowerCase()), 'the test store, never his');
const { linkable, undoPlan } = await import('./dedupe.mjs');
const rc = await import('./resolve-copies.mjs');
const journal = path.join(dir, 'dedupe-runs.jsonl');

let n = 0;
const add = (extra) => {
  const id = extra.id || `r${++n}`;
  const row = { id, url: `https://boards.example/${id}`, source: 'greenhouse', title: 'Engineer', company: 'Acme', status: 'new', first_seen: '2026-11-01', last_seen: '2026-11-04', ...extra };
  const cols = Object.keys(row);
  store.db().prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
  return id;
};
const li = (extra) => add({ source: 'linkedin', url: `https://www.linkedin.com/jobs/view/${4480000000 + (++n)}/`, status: 'inbox', status_changed_at: '2026-11-03T10:00:00.000Z', pick_note: 'why he should apply', ...extra });
const col = (id, c) => store.db().prepare(`SELECT ${c} AS v FROM jobs WHERE id = ?`).get(id)?.v;
const run = (ids) => rc.resolveCopies({ handle: store.db(), linkable, ids });

test('places: towns and states as the boards spell them', () => {
  assert.equal(rc.townOf('US-TX-Denton'), 'denton');
  assert.equal(rc.townOf('Denton, TX, US, 76207-2198'), 'denton');
  assert.equal(rc.townOf('United States'), '');
  assert.equal(rc.townOf('Remote'), '');
  assert.equal(rc.stateOf('Devens, MA'), 'ma');
  assert.equal(rc.stateOf('Ayer, Massachusetts'), 'ma');
  assert.equal(rc.stateOf('US-TX-Denton'), 'tx');
  assert.ok(rc.placeAgrees('Denton, TX', 'Denton, TX, US, 76207-2198'));
  assert.ok(rc.placeAgrees('Beverly, MA', 'United States'), 'a side naming no town agrees');
  assert.ok(!rc.placeAgrees('Ann Arbor, MI', 'Phoenix, AZ'));
  assert.ok(rc.isLinkedInCopy({ source: 'linkedin', url: 'x' }));
  assert.ok(rc.isLinkedInCopy({ source: 'import', url: 'https://www.linkedin.com/jobs/view/1/' }));
  assert.ok(!rc.isLinkedInCopy({ source: 'greenhouse', url: 'https://boards.greenhouse.io/x/jobs/1' }));
});

test('found: the board row takes his decision, the copy points at it, journalled for dedupe --undo', async () => {
  const board = add({ company: 'Foundry Inc.', title: 'Manufacturing Engineer I', location: 'Portland, OR', url: 'https://job-boards.greenhouse.io/foundry/jobs/111' });
  add({ company: 'Foundry Inc.', title: 'Quality Technician', location: 'Portland, OR' });
  const copy = li({ company: 'Foundry', title: 'Manufacturing Engineer I', location: 'Portland, OR' });
  const [r] = await run([copy]);
  assert.equal(r.verdict, 'found');
  assert.equal(r.board.id, board);
  assert.equal(col(copy, 'superseded_by'), null, 'a report writes nothing');
  assert.equal(col(board, 'status'), 'new');

  const w = await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(w.linked.length, 1);
  assert.equal(col(copy, 'superseded_by'), board);
  assert.equal(col(board, 'status'), 'inbox');
  assert.equal(col(board, 'status_changed_at'), '2026-11-03T10:00:00.000Z', 'his decision keeps its date');
  assert.equal(col(board, 'pick_note'), 'why he should apply');
  const line = JSON.parse(readFileSync(journal, 'utf8').trim().split('\n').pop());
  assert.equal(line.runId, w.runId);
  assert.deepEqual(line.merges[0], { stale: copy, keep: board, carried: 'inbox', keepPrior: { status: 'new', statusChangedAt: null } });
  // dedupe's own undo would reverse exactly this.
  assert.deepEqual(undoPlan(line.merges[0], { stale: { superseded_by: board }, keep: { status: 'inbox' } }), { unmark: true, restore: true });
  // The copy has left the picks; a second write finds nothing.
  assert.equal((await run([copy])).length, 0);
});

test('wrong role rejected: the same-posting guard refuses another level or another role, with the reason', async () => {
  add({ company: 'Guardco', title: 'Senior Mechanical Engineer', location: 'Austin, TX' });
  add({ company: 'Guardco', title: 'Mechanical Design Engineer', location: 'Austin, TX' });
  const copy = li({ company: 'Guardco', title: 'Mechanical Engineer', location: 'Austin, TX' });
  const [r] = await run([copy]);
  assert.equal(r.verdict, 'not-found');
  assert.equal(r.reason, 'no-match');
  assert.match(r.why, /none passes the same-posting guard/);
  assert.match(r.why, /level differs/);
  const w = await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(w.linked.length, 0);
  assert.equal(col(copy, 'superseded_by'), null);
});

test('wrong role rejected at write time: a result whose board row fails the guard is never linked', async () => {
  const board = add({ company: 'Forgery', title: 'Production Supervisor', location: 'Columbus, IN' });
  const copy = li({ company: 'Forgery', title: 'Production Engineer', location: 'Columbus, IN' });
  const forged = { verdict: 'found', copy: { id: copy }, board: { id: board } };
  const w = await rc.writeLinks([forged], { store, linkable, journal });
  assert.equal(w.linked.length, 0);
  assert.equal(col(copy, 'superseded_by'), null);
  assert.equal(col(board, 'status'), 'new');
});

test('not found: an employer with no board rows says so; another employer\'s same title is a hint, never a link', async () => {
  const parent = add({ company: 'Parentco', title: 'Mechanical Engineer- Powertrain & Aftertreatment', location: 'Denton, TX, US, 76207-2198' });
  const copy = li({ company: 'Division Motors Company', title: 'Mechanical Engineer- Powertrain & Aftertreatment', location: 'Denton, TX' });
  const [r] = await run([copy]);
  assert.equal(r.verdict, 'not-found');
  assert.equal(r.reason, 'untracked');
  assert.equal(r.hints?.[0]?.id, parent);
  assert.match(r.why, /Hint, not linked/);
  await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(col(copy, 'superseded_by'), null);
  assert.equal(col(parent, 'status'), 'new');
});

test('not found: a closed posting, and the same title only in another state', async () => {
  add({ company: 'Shutco', title: 'Test Engineer II', location: 'Reno, NV', gone_at: '2026-10-30T00:00:00Z' });
  const closed = li({ company: 'Shutco', title: 'Test Engineer II', location: 'Reno, NV' });
  add({ company: 'Farco', title: 'Process Engineer', location: 'Phoenix, AZ' });
  const far = li({ company: 'Farco', title: 'Process Engineer', location: 'Ann Arbor, MI' });
  const [a, b] = await run([closed, far]);
  assert.equal(a.reason, 'closed');
  assert.match(a.why, /closed/);
  assert.equal(b.reason, 'other-town');
});

test('a neighbouring town in the same state: the employer\'s only such row is the posting; two stay unlinked', async () => {
  const devens = add({ company: 'Formco', title: 'Associate NPI Equipment Engineer', location: 'Devens, MA', source: 'rippling' });
  const one = li({ company: 'Formco', title: 'Associate NPI Equipment Engineer', location: 'Ayer, MA' });
  const [r] = await run([one]);
  assert.equal(r.verdict, 'found');
  assert.equal(r.reason, 'found-nearby');
  assert.equal(r.board.id, devens);
  add({ company: 'Twinco', title: 'Controls Engineer', location: 'Boston, MA' });
  add({ company: 'Twinco', title: 'Controls Engineer', location: 'Lowell, MA' });
  const two = li({ company: 'Twinco', title: 'Controls Engineer', location: 'Ayer, MA' });
  assert.equal((await run([two]))[0].reason, 'other-town');
});

test('ambiguous: two live board rows pass in one town, nothing linked', async () => {
  add({ company: 'Doubleco', title: 'Robotics Engineer', location: 'Pittsburgh, PA' });
  add({ company: 'Doubleco', title: 'Robotics Engineer', location: 'Pittsburgh, PA' });
  const copy = li({ company: 'Doubleco', title: 'Robotics Engineer', location: 'Pittsburgh, PA' });
  const [r] = await run([copy]);
  assert.equal(r.verdict, 'ambiguous');
  await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(col(copy, 'superseded_by'), null);
});

test('handled: a board row he applied to keeps its status; the copy points at it and leaves his inbox', async () => {
  const board = add({ company: 'Appliedco', title: 'Systems Engineer', location: 'Beverly, MA', status: 'applied', status_changed_at: '2026-10-26T12:00:00Z' });
  const copy = li({ company: 'Appliedco', title: 'Systems Engineer', location: 'Beverly, MA' });
  const [r] = await run([copy]);
  assert.equal(r.verdict, 'handled');
  assert.match(r.why, /already "applied" since 2026-10-26/);
  const w = await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(w.linked.length, 1);
  assert.deepEqual(w.linked[0], { stale: copy, keep: board, carried: null, keepPrior: null });
  assert.equal(col(board, 'status'), 'applied');
  assert.equal(col(copy, 'superseded_by'), board);
});

test('a board row already in his inbox: the copy points at it, no status changes', async () => {
  const board = add({ company: 'Listedco', title: 'Hardware Engineer', location: 'Austin, TX', status: 'inbox', status_changed_at: '2026-11-01T00:00:00Z' });
  const copy = li({ company: 'Listedco', title: 'Hardware Engineer', location: 'Austin, TX' });
  const [r] = await run([copy]);
  assert.equal(r.reason, 'found-already-listed');
  const w = await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(w.linked[0].carried, null);
  assert.equal(col(board, 'status_changed_at'), '2026-11-01T00:00:00Z');
});

test('the resolver, for an untracked employer: its posting is reported, never written', async () => {
  const copy = li({ company: 'Freshco', title: 'Electromechanical Integration Engineer I', location: 'San Francisco, CA' });
  const asked = [];
  const resolveBoard = async (c) => { asked.push(c); return { board: 'ashby https://jobs.ashbyhq.com/freshco', jobs: [
    { title: 'Electromechanical Integration Engineer I', url: 'https://jobs.ashbyhq.com/freshco/1', location: 'San Francisco, CA' },
    { title: 'Senior Electromechanical Integration Engineer', url: 'https://jobs.ashbyhq.com/freshco/2', location: 'San Francisco, CA' },
  ] }; };
  const [r] = await rc.resolveCopies({ handle: store.db(), linkable, ids: [copy], resolveBoard });
  assert.deepEqual(asked, ['Freshco']);
  assert.equal(r.verdict, 'found-untracked');
  assert.equal(r.board.url, 'https://jobs.ashbyhq.com/freshco/1');
  const w = await rc.writeLinks([r], { store, linkable, journal });
  assert.equal(w.linked.length, 0);
  assert.equal(col(copy, 'superseded_by'), null);
  // A resolver that finds nothing, or fails, says so.
  const none = await rc.resolveCopies({ handle: store.db(), linkable, ids: [copy], resolveBoard: async () => null });
  assert.match(none[0].why, /resolver found no board/);
  const bad = await rc.resolveCopies({ handle: store.db(), linkable, ids: [copy], resolveBoard: async () => { throw new Error('429'); } });
  assert.match(bad[0].why, /resolver failed: 429/);
});

test('only LinkedIn-copy picks in his inbox are judged; the guard is required', async () => {
  add({ company: 'Boardonly', title: 'Engineer II', status: 'inbox' });
  li({ company: 'Gonepick', title: 'Engineer II', gone_at: '2026-11-01' });
  li({ company: 'Newrow', title: 'Engineer II', status: 'new' });
  const all = rc.copyPicks(store.db());
  assert.ok(all.every((r) => r.source === 'linkedin' && ['inbox', 'queued'].includes(r.status) && !r.gone_at));
  assert.throws(() => rc.judge({ company: 'X', title: 'Y' }, [], {}), /same-posting guard/);
  assert.ok(existsSync(journal));
});

test('F-1026 review: when the store refuses the pointer after his decision was carried, the carry is undone and both rows stay', async () => {
  const board = add({ company: 'Refusal Labs', title: 'Process Engineer', location: 'Austin, TX', url: 'https://job-boards.greenhouse.io/refusal/jobs/222' });
  const copy = li({ company: 'Refusal Labs', title: 'Process Engineer', location: 'Austin, TX' });
  const [r] = await run([copy]);
  assert.equal(r.verdict, 'found');
  // The real store allows this one (the carry makes the two equal); a store that refuses stands for any refusal.
  const refusing = { ...store, pointAt: () => false };
  const w = await rc.writeLinks([r], { store: refusing, linkable, journal });
  assert.equal(w.linked.length, 0, 'nothing linked');
  assert.equal(col(copy, 'superseded_by'), null, 'the copy stays visible');
  assert.equal(col(board, 'status'), 'new', 'the carried decision was taken back');
  assert.equal(col(board, 'status_changed_at'), null);
  // …and so were the notes the carry copied (code review #4): both rows stay
  // visible, so a note left on both would show twice.
  assert.equal(col(board, 'pick_note'), null, 'the copied inbox note was taken back');
  assert.equal(col(copy, 'pick_note'), 'why he should apply', 'the copy keeps its own');
});
