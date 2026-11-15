// jarvis/dedupe-store.test.mjs — hiding a copy of a posting, end to end, on a
// throwaway store (F-1026, review 2026-11-06): his decision is never the thing
// hidden, every path goes through store.pointAt, a closed survivor gives way to
// its live copy, and an undo puts everything back.
// Run: node --test jarvis/dedupe-store.test.mjs
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-dedupe-'));
process.env.JARVIS_DATA_DIR = dir;                    // the journal goes here, not into his store
process.env.JARVIS_DB_PATH = path.join(dir, 'jobs.db');
const S = await import('./store.mjs');
const { dedupeStore, pointCopies, planMerges } = await import('./dedupe.mjs');
after(() => { try { S.db().close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });

// THE STORE'S OWN INVARIANT, after every test (review, 2026-11-06): no pointer
// leads to a row that is itself pointed, so no chains and no loops — every
// hidden copy has a survivor he can see. (Tests that build an old, broken
// state on purpose repair it before they end.)
afterEach(() => {
  const bad = S.db().prepare('SELECT s.id, s.superseded_by FROM jobs s JOIN jobs k ON k.id = s.superseded_by WHERE k.superseded_by IS NOT NULL').all();
  assert.deepEqual(bad, [], `pointers to a hidden row: ${JSON.stringify(bad)}`);
});

const row = (id) => S.db().prepare('SELECT status, superseded_by, pick_note, user_note, gone_at FROM jobs WHERE id = ?').get(id);
const idOf = (url) => S.getJobByUrl(url)?.id;
const quiet = () => {};
const OLD = '2026-10-01T00:00:00.000Z';
const NEW = '2026-11-01T00:00:00.000Z';
let n = 0;
/** Two spellings of one Ashby posting (his store has /Etched/ and /etched/), the first seen earlier. */
function pair(company, title, loc = 'Austin, TX') {
  n += 1;
  const uuid = `${String(n).padStart(8, '0')}-1111-4111-8111-aaaaaaaaaaaa`;
  const a = `https://jobs.ashbyhq.com/${company}/${uuid}`;
  const b = `https://jobs.ashbyhq.com/${company.toLowerCase()}/${uuid}`;
  S.upsertJobs([{ url: a, title, company, location: loc }], OLD);
  S.upsertJobs([{ url: b, title, company, location: loc }], NEW);
  return [idOf(a), idOf(b)];
}
const lastMergeRun = () => readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.runId && Array.isArray(l.merges)).pop();
const lastRun = () => readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.runId && (Array.isArray(l.merges) || Array.isArray(l.pointers))).pop();

test('his application on the older spelling is the survivor; the fresher inbox copy points at it', async () => {
  const [ia, ib] = pair('Etched', 'Build Engineer');
  S.setStatus(ia, 'applied');
  S.setStatus(ib, 'inbox');
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, null, 'the application is never hidden');
  assert.equal(row(ia).status, 'applied');
  assert.equal(row(ib).superseded_by, ia, 'the copy points at his application');
});

test('a rejected application on the older spelling is the survivor, not the fresher untouched copy', async () => {
  const [ia, ib] = pair('Also', 'Mechanical Hardware Test Engineer');
  S.setStatus(ia, 'rejected');
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, null, 'the rejected application stays on his board');
  assert.equal(row(ib).superseded_by, ia);
  assert.equal(row(ib).status, 'new', 'nothing is carried onto the copy');
});

test('the store refuses to hide a row holding more of his than the survivor, and says so — for every caller', () => {
  const [ia, ib] = pair('Capable', 'Hardware Engineer');
  S.setStatus(ia, 'applied');
  S.setStatus(ib, 'inbox');
  const before = S.POINT_REFUSALS.length;
  // The page fold and resolve-copies call pointAt directly; pointCopies goes through it too.
  assert.equal(S.pointAt(ia, ib), false, 'an application is never hidden behind an inbox card');
  assert.equal(row(ia).superseded_by, null);
  assert.match(S.POINT_REFUSALS.at(-1).line, new RegExp(`left alone: ${ia} \\[applied\\] would be hidden behind ${ib} \\[inbox\\]`));
  return pointCopies([{ stale: ia, keep: ib }], { write: true, log: quiet }).then(() => {
    assert.equal(row(ia).superseded_by, null, 'pointCopies is refused the same way');
    assert.ok(S.POINT_REFUSALS.length >= before + 2);
  });
});

test('a decision carried across first makes the pointer allowed, and his notes move with it', () => {
  const [ia, ib] = pair('Anduril', 'Mechanical Engineer');
  S.setStatus(ia, 'interested');
  S.db().prepare("UPDATE jobs SET pick_note = 'the curator''s reason', user_note = 'his own words' WHERE id = ?").run(ia);
  assert.equal(S.pointAt(ia, ib), false, 'a heart behind an untouched row is refused');
  S.carryDecision(ib, { status: 'interested' });
  assert.equal(S.pointAt(ia, ib), true, 'carried first, then pointed');
  assert.deepEqual([row(ib).status, row(ib).pick_note, row(ib).user_note], ['interested', "the curator's reason", 'his own words'], 'his note and the inbox note are on the card he sees');
});

test('a repost may hide a closed list card on purpose, never an application', () => {
  const [ia, ib] = pair('Shield', 'Test Engineer');
  S.setStatus(ia, 'inbox');
  assert.equal(S.pointAt(ia, ib, { repost: true }), true);
  const [ic, id] = pair('Shield', 'Systems Engineer');
  S.setStatus(ic, 'applied');
  assert.equal(S.pointAt(ic, id, { repost: true }), false);
});

test('within one posting the strongest decision carries first, so an application is not refused behind a heart', () => {
  const g = { keep: { id: 'k', status: 'new' }, stale: [{ id: 'h', status: 'interested' }, { id: 'a', status: 'applied' }], linkedin: true };
  const plan = planMerges([g]);
  assert.deepEqual(plan.map((p) => [p.r.id, p.carry, p.refuse]), [['a', true, false], ['h', false, false]], 'applied carries; the heart is then behind an application, which hides nothing of his');
  const back = planMerges([{ ...g, stale: [...g.stale].reverse() }]);
  assert.deepEqual(back.map((p) => [p.r.id, p.carry, p.refuse]), [['a', true, false], ['h', false, false]], 'whatever order the rows came in');
});

test('his heart on a LinkedIn copy carries onto the untouched board row, and an undo of that run puts both back', async () => {
  const e = 'https://jobs.ashbyhq.com/Capable/dddddddd-4444-4444-8444-dddddddddddd';
  const f = 'https://www.linkedin.com/jobs/view/4300000001';
  S.upsertJobs([{ url: e, title: 'Controls Engineer', company: 'Capable', location: 'Austin, TX' }], NEW);
  S.upsertJobs([{ url: f, title: 'Controls Engineer', company: 'Capable', location: 'Austin, TX', source: 'linkedin' }], NEW);
  const [ie, iff] = [idOf(e), idOf(f)];
  S.setStatus(iff, 'interested');
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(iff).superseded_by, ie, 'the LinkedIn copy points at the board row');
  assert.equal(row(ie).status, 'interested', 'and his heart was carried onto it');
  const run = lastMergeRun();   // a write's recheck may journal its own line after this one
  assert.ok(run.merges.some((m) => m.stale === iff && m.carried === 'interested'), 'the carry is journalled');
  await dedupeStore({ undo: run.runId, log: quiet });
  assert.equal(row(iff).superseded_by, null, 'the undo clears the pointer');
  assert.equal(row(ie).status, 'new', 'and gives the board row back its own status');
  assert.equal(row(iff).status, 'interested', 'his heart is where he left it');
});

test('a survivor that closed gives way to its live copy, his card moving with it; an undo puts the pointer back', async () => {
  const [ia, ib] = pair('Hadrian', 'Manufacturing Engineer');
  S.setStatus(ia, 'inbox');
  assert.equal(S.pointAt(ib, ia), true, 'the fresher copy points at his inbox card');
  S.db().prepare('UPDATE jobs SET gone_at = ? WHERE id = ?').run('2026-11-05T00:00:00.000Z', ia);   // the old posting closed
  const said = [];
  await dedupeStore({ log: (l) => said.push(String(l)) });   // dry run
  assert.ok(said.some((l) => l.includes(`${ia} [inbox, closed] → ${ib} [new, live]`)), `the dry run names the swap: ${said.join(' | ').slice(0, 300)}`);
  await dedupeStore({ write: true, log: quiet });
  assert.deepEqual([row(ib).superseded_by, row(ib).status], [null, 'inbox'], 'the live posting is his card now');
  assert.equal(row(ia).superseded_by, ib, 'the closed one points at it');
  await dedupeStore({ undo: lastRun().runId, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ib).superseded_by, row(ib).status], [null, ia, 'new'], 'exactly as before');
});

test('an application on a closed survivor stays where it is: its record is on that row', async () => {
  const [ia, ib] = pair('Hadrian', 'Quality Engineer');
  S.setStatus(ia, 'applied');
  assert.equal(S.pointAt(ib, ia), true);
  S.db().prepare('UPDATE jobs SET gone_at = ? WHERE id = ?').run('2026-11-05T00:00:00.000Z', ia);
  await dedupeStore({ write: true, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ia).status, row(ib).superseded_by], [null, 'applied', ia]);
});

// ── dedupe-rank-2 (review, 2026-11-06) ─────────────────────────────────────
const gone = (id, at = '2026-11-05T00:00:00.000Z') => S.db().prepare('UPDATE jobs SET gone_at = ? WHERE id = ?').run(at, id);
const live = (id) => S.db().prepare('UPDATE jobs SET gone_at = NULL WHERE id = ?').run(id);
const notes = (id, pick, user) => S.db().prepare('UPDATE jobs SET pick_note = ?, user_note = ? WHERE id = ?').run(pick, user, id);

test('a pair swapped once is not swapped back and forth when its liveness flips (7 days)', async () => {
  const [ia, ib] = pair('Flap', 'Mechanical Engineer');
  S.setStatus(ia, 'inbox');
  assert.equal(S.pointAt(ib, ia), true);
  gone(ia);
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, ib, 'swapped once');
  // The listing flips: the new address closes, the old one is live again.
  gone(ib); live(ia);
  const said = [];
  await dedupeStore({ write: true, log: (l) => said.push(String(l)) });
  assert.equal(row(ia).superseded_by, ib, 'not swapped back within the week');
  assert.ok(!said.some((l) => l.includes('closed survivor(s) swapped')), said.join(' | ').slice(0, 300));
});

test('an undo puts the survivor\'s notes back as they were, and undoing a swap copies no notes onto the old row', async () => {
  const [ia, ib] = pair('Notes', 'Test Engineer');
  notes(ia, 'curator: why', 'his: call Friday');
  notes(ib, 'curator: the new copy', null);
  await dedupeStore({ write: true, log: quiet });   // ia (older, new) points at ib; ia's notes merge into ib's
  assert.equal(row(ia).superseded_by, ib);
  assert.match(row(ib).pick_note, /curator: the new copy\n\n\[from the other copy of this posting\] curator: why/);
  assert.equal(row(ib).user_note, 'his: call Friday');
  await dedupeStore({ undo: lastRun().runId, log: quiet });
  assert.deepEqual([row(ib).pick_note, row(ib).user_note], ['curator: the new copy', null], 'the survivor\'s notes as they were');

  const [ic, idd] = pair('Notes', 'Quality Engineer');
  S.setStatus(ic, 'inbox'); notes(ic, null, null);
  notes(idd, 'the live copy\'s note', null);
  assert.equal(S.pointAt(idd, ic), true);
  const icNotesBefore = [row(ic).pick_note, row(ic).user_note];
  gone(ic);
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ic).superseded_by, idd, 'swapped');
  await dedupeStore({ undo: lastRun().runId, log: quiet });
  assert.equal(row(idd).superseded_by, ic, 'the old pointer is back');
  assert.deepEqual([row(ic).pick_note, row(ic).user_note], icNotesBefore, 'and the old row did not take the live copy\'s notes');
});

test('a reopened posting he applied to is named for the Overview, though his application keeps its row', async () => {
  const [ia, ib] = pair('Reopen', 'Controls Engineer');
  S.setStatus(ia, 'applied');
  assert.equal(S.pointAt(ib, ia), true);
  gone(ia);
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, null, 'the application stays where its record is');
  const listed = S.reopenedApplications();
  assert.ok(listed.some((x) => x.keepId === ia && x.liveId === ib && x.status === 'applied' && /reopen/i.test(x.liveUrl)), JSON.stringify(listed));
});

test('equal rank is not the same decision: a queued card behind an inbox one is refused, the same decision is hidden with both notes kept', () => {
  const [ia, ib] = pair('Equal', 'Robotics Engineer');
  S.setStatus(ia, 'queued'); S.setStatus(ib, 'inbox');
  assert.equal(S.pointAt(ia, ib), false, 'queued and inbox are two choices of his');
  const [ic, idd] = pair('Equal', 'Automation Engineer');
  S.setStatus(ic, 'inbox'); S.setStatus(idd, 'inbox');
  notes(ic, 'older note', 'his older words'); notes(idd, 'newer note', 'his newer words');
  assert.equal(S.pointAt(ic, idd), true, 'the same decision on both');
  assert.equal(row(idd).pick_note, 'newer note\n\n[from the other copy of this posting] older note');
  assert.equal(row(idd).user_note, 'his newer words\n\n[from the other copy of this posting] his older words');
});

test('--recheck-decisions turns round a pointer set before F-1026 (a rejected application behind an untouched copy), and clears one that is no longer one posting', async () => {
  const [ia, ib] = pair('Recheck', 'Mechanical Hardware Engineer');
  S.setStatus(ia, 'rejected');
  // As the old rule left it: the rejected row pointed at the untouched copy, set directly as the old code did.
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(ib, ia);
  // And one whose two rows are not one posting any more (another title).
  const [ic, idd] = pair('Recheck', 'Test Engineer');
  S.setStatus(ic, 'applied');
  S.db().prepare("UPDATE jobs SET title = 'Field Service Technician' WHERE id = ?").run(idd);
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(idd, ic);
  const said = [];
  await dedupeStore({ recheckDecisions: true, log: (l) => said.push(String(l)) });   // dry run
  const text = said.join('\n');
  assert.match(text, new RegExp(`${ia} \\[rejected\\] → ${ib} \\[new\\][^\\n]*\\n\\s+fix: ${ib} points at ${ia} instead`));
  assert.match(text, new RegExp(`${ic} \\[applied\\] → ${idd} \\[new\\][^\\n]*\\n\\s+fix: the pointer is cleared`));
  assert.equal(row(ia).superseded_by, ib, 'the dry run wrote nothing');
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ia).status, row(ib).superseded_by], [null, 'rejected', ia], 'his rejected application shows; the copy points at it');
  assert.equal(row(ic).superseded_by, null, 'the other is simply shown again');
  assert.deepEqual(S.POINT_REFUSALS.filter((x) => x.stale === ib), [], 'turning it round was allowed');
});

test('the store never points at a row that is itself pointed: the pointer that would close a loop is refused', () => {
  const [ia, ib] = pair('Loop', 'Build Engineer');
  S.setStatus(ia, 'applied'); S.setStatus(ib, 'applied');
  assert.equal(S.pointAt(ia, ib), true, 'one copy behind the other');
  assert.equal(S.pointAt(ib, ia), false, 'the other way round would hide both');
  assert.ok(S.POINT_REFUSALS.at(-1).chain, 'and it is logged as a chain/loop refusal');
  assert.equal(row(ib).superseded_by, null, 'his application shows');
});

test('--recheck-decisions breaks a loop the old rule made: his strongest decision shows, the rest point at it', async () => {
  // Seven of these on his store (2026-11-06): each row of the pair pointing at the other.
  const [ia, ib] = pair('LoopFix', 'Automation Engineer');
  S.setStatus(ia, 'applied'); S.setStatus(ib, 'applied');
  const [ic, idd] = pair('LoopFix', 'Mechanical Hardware Test Engineer');
  S.setStatus(ic, 'rejected');
  const set = (a, b) => S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(b, a);
  set(ia, ib); set(ib, ia); set(ic, idd); set(idd, ic);
  const said = [];
  await dedupeStore({ recheckDecisions: true, log: (l) => said.push(String(l)) });
  assert.ok(said.some((l) => l.startsWith('2 loop(s)')), said.join(' | ').slice(0, 400));
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  // Both applied: the one listed more recently shows.
  assert.deepEqual([row(ib).superseded_by, row(ia).superseded_by], [null, ib]);
  // The rejected application shows; the untouched copy points at it.
  assert.deepEqual([row(ic).superseded_by, row(idd).superseded_by], [null, ic]);
});

test('--recheck-decisions collapses a chain so every copy points straight at the row that shows', async () => {
  const [ia, ib] = pair('Chain', 'Controls Engineer');
  const uuid = 'cccccccc-9999-4999-8999-cccccccccccc';
  const third = `https://jobs.ashbyhq.com/CHAIN/${uuid}`;
  S.upsertJobs([{ url: third, title: 'Controls Engineer', company: 'Chain', location: 'Austin, TX' }], OLD);
  const ic = idOf(third);
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(ib, ia);
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(ia, ic);   // ic → ia → ib
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.deepEqual([row(ic).superseded_by, row(ia).superseded_by, row(ib).superseded_by], [ib, ib, null]);
});

const allPointers = () => Object.fromEntries(S.db().prepare('SELECT id, superseded_by FROM jobs ORDER BY id').all().map((r) => [r.id, r.superseded_by ?? null]));
const setPtr = (a, b) => S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(b, a);

test('a three-row loop and a five-row chain are put right: one row shows, every other points straight at it', async () => {
  const [ia, ib] = pair('Ring', 'Systems Engineer');
  const third = `https://jobs.ashbyhq.com/RING/rrrrrrrr-0000-4000-8000-rrrrrrrrrrrr`;
  S.upsertJobs([{ url: third, title: 'Systems Engineer', company: 'Ring', location: 'Austin, TX' }], OLD);
  const ic = idOf(third);
  S.setStatus(ib, 'interested');
  setPtr(ia, ib); setPtr(ib, ic); setPtr(ic, ia);   // a → b → c → a
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const u = `https://jobs.ashbyhq.com/Long/llllllll-000${i}-4000-8000-llllllllllll`;
    S.upsertJobs([{ url: u, title: 'Test Engineer', company: 'Long', location: 'Austin, TX' }], OLD);
    ids.push(idOf(u));
  }
  for (let i = 0; i < 4; i += 1) setPtr(ids[i], ids[i + 1]);   // 0 → 1 → 2 → 3 → 4
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.deepEqual([row(ib).superseded_by, row(ia).superseded_by, row(ic).superseded_by], [null, ib, ib], 'his heart shows; the other two point at it');
  assert.deepEqual(ids.map((id) => row(id).superseded_by), [ids[4], ids[4], ids[4], ids[4], null], 'every link of the chain points at its visible end');
});

test('an undo of a recheck run puts every pointer back exactly as it found them — loops and chains included', async () => {
  const [ia, ib] = pair('UndoRing', 'Process Engineer');
  S.setStatus(ia, 'applied'); S.setStatus(ib, 'applied');
  setPtr(ia, ib); setPtr(ib, ia);
  const [ic, idd] = pair('UndoRing', 'Quality Engineer');
  S.setStatus(ic, 'rejected');
  setPtr(ic, idd);                                   // a rejected application behind an untouched copy
  const [ie, iff] = pair('UndoRing', 'Test Engineer');
  const extra = `https://jobs.ashbyhq.com/UNDORING/eeeeeeee-0000-4000-8000-eeeeeeeeeeee`;
  S.upsertJobs([{ url: extra, title: 'Test Engineer', company: 'UndoRing', location: 'Austin, TX' }], OLD);
  const ig = idOf(extra);
  setPtr(ig, ie); setPtr(ie, iff);                   // a chain
  const broken = allPointers();
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.notDeepEqual(allPointers(), broken, 'the recheck changed them');
  await dedupeStore({ undo: lastRun().runId, log: quiet });
  assert.deepEqual(allPointers(), broken, 'exactly as before, loop and chain and all');
  // Put right again, so the store's own invariant holds for the next test.
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
});

test('after a recheck every row holding an application shows, or points at a row that holds one', async () => {
  // He applied, then hid or skipped it: still an application (applied_at), never hidden behind an inbox card.
  const [ia, ib] = pair('AppliedThenHid', 'Robotics Engineer');
  S.db().prepare("UPDATE jobs SET status = 'hidden', applied_at = '2026-10-04T00:00:00Z', status_changed_at = '2026-10-10T00:00:00Z' WHERE id = ?").run(ia);
  S.db().prepare("UPDATE jobs SET status = 'inbox', status_changed_at = '2026-10-20T00:00:00Z' WHERE id = ?").run(ib);
  setPtr(ia, ib);
  assert.equal(S.mayHide(row(ia) && { ...S.db().prepare('SELECT status, applied_at FROM jobs WHERE id = ?').get(ia) }, { status: 'inbox' }), false, 'the rule itself');
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  const bad = S.db().prepare(`SELECT s.id FROM jobs s JOIN jobs k ON k.id = s.superseded_by
    WHERE (s.applied_at IS NOT NULL OR s.status IN ('applied','rejected','responded','interview','offer'))
      AND NOT (k.applied_at IS NOT NULL OR k.status IN ('applied','rejected','responded','interview','offer'))`).all();
  assert.deepEqual(bad, [], 'no application hidden behind a row without one');
  assert.equal(row(ia).superseded_by, null);
});

test('an application behind a copy of the same job (employer, title and place all the same) is turned round; anything less shows both', async () => {
  // A board row the engine filled, hidden behind its LinkedIn copy: two addresses no dedupe key joins.
  const add = (url, extra) => { S.upsertJobs([{ url, title: 'Mechanical Engineer', company: 'Atomic Semi', location: 'San Francisco, CA', ...extra }], NEW); return idOf(url); };
  const board = add('https://jobs.ashbyhq.com/atomicsemi/aaaaaaaa-1234-4234-8234-aaaaaaaaaaaa');
  const copy = add('https://www.linkedin.com/jobs/view/4300000077');
  S.db().prepare("UPDATE jobs SET status = 'interested', applied_at = '2026-09-19T00:00:00Z' WHERE id = ?").run(board);
  S.setStatus(copy, 'interested');
  setPtr(board, copy);
  const elsewhere = add('https://jobs.ashbyhq.com/atomicsemi/bbbbbbbb-1234-4234-8234-bbbbbbbbbbbb', { title: 'Hardware Engineer', location: 'Austin, TX' });
  const elseCopy = add('https://www.linkedin.com/jobs/view/4300000078', { title: 'Hardware Engineer', location: 'San Francisco, CA' });
  S.db().prepare("UPDATE jobs SET status = 'interested', applied_at = '2026-09-19T00:00:00Z' WHERE id = ?").run(elsewhere);
  S.setStatus(elseCopy, 'interested');
  setPtr(elsewhere, elseCopy);
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.deepEqual([row(board).superseded_by, row(copy).superseded_by], [null, board], 'one job: his application shows, the copy points at it');
  assert.deepEqual([row(elsewhere).superseded_by, row(elseCopy).superseded_by], [null, null], 'another place: both show');
});

test('his newer decision on the row that shows stands — but an application is never left hidden that way', async () => {
  const [ia, ib] = pair('Newer', 'Mechanical Systems Engineer');
  S.db().prepare("UPDATE jobs SET status = 'inbox', status_changed_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(ia);
  S.db().prepare("UPDATE jobs SET status = 'hidden', status_changed_at = '2026-10-20T00:00:00Z' WHERE id = ?").run(ib);
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(ib, ia);   // the JPL shape: an inbox copy behind a board row he hid later
  const [ic, idd] = pair('Newer', 'Manufacturing Engineer I');
  S.db().prepare("UPDATE jobs SET status = 'applied', applied_at = '2026-10-03T00:00:00Z', status_changed_at = '2026-10-03T00:00:00Z' WHERE id = ?").run(ic);
  S.db().prepare("UPDATE jobs SET status = 'hidden', status_changed_at = '2026-10-20T00:00:00Z' WHERE id = ?").run(idd);
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(idd, ic);   // an application behind a newer hide
  const said = [];
  await dedupeStore({ recheckDecisions: true, log: (l) => said.push(String(l)) });
  assert.ok(said.some((l) => l.includes(`${ia} [inbox]`) && l.includes('is newer than this one')), said.join(' | ').slice(0, 500));
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.equal(row(ia).superseded_by, ib, 'his later hide stands');
  assert.equal(row(ic).superseded_by, null, 'his application shows, whatever came after');
});

// F-1028 (2026-11-06): every scan's dedupe write ends with the recheck, and
// between two application rows the one holding the record (applied_at, on a
// board that listed it after he applied) shows.
const record = (id, appliedAt = '2026-09-20T00:00:00.000Z') => S.db().prepare("UPDATE jobs SET status = 'applied', applied_at = ?, status_changed_at = ? WHERE id = ?").run(appliedAt, appliedAt, id);
const carriedCopy = (id) => S.db().prepare("UPDATE jobs SET status = 'applied', applied_at = NULL, status_changed_at = '2026-11-07T00:52:30.000Z' WHERE id = ?").run(id);

test('a scan that lists only the copy\'s spelling leaves his application showing', async () => {
  const [ia, ib] = pair('OnlyCopy', 'Hardware Engineer');
  record(ia); carriedCopy(ib);
  await dedupeStore({ write: true, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ib).superseded_by], [null, ia], 'the copy points at his record');
  // The next scan sees only the copy's address: its pointer is cleared (F-406) and the pass judges it again.
  const b = S.db().prepare('SELECT url FROM jobs WHERE id = ?').get(ib).url;
  S.upsertJobs([{ url: b, title: 'Hardware Engineer', company: 'OnlyCopy', location: 'Austin, TX' }], '2026-11-08T00:00:00.000Z');
  assert.equal(row(ib).superseded_by, null, 'the scan cleared the copy\'s pointer');
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, null, 'his application still shows');
  assert.equal(row(ib).superseded_by, ia, 'the copy points at it again');
});

test('the old-loop shape (his record behind a copy carrying "applied") is turned round by an ordinary write', async () => {
  const [ia, ib] = pair('OldLoop', 'Automation Engineer');
  record(ia); carriedCopy(ib);
  setPtr(ia, ib);   // what the 00:52 run left: the record hidden behind the copy
  assert.equal(S.mayHide({ ...S.db().prepare('SELECT status, applied_at, last_seen FROM jobs WHERE id = ?').get(ia) }, { status: 'applied' }), false, 'the rule itself');
  await dedupeStore({ write: true, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ib).superseded_by], [null, ia]);
  // …and the recheck's own journal line undoes exactly.
  const run = lastRun();
  assert.ok(run.recheckDecisions, 'the recheck journalled its own run');
  await dedupeStore({ undo: run.runId, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ib).superseded_by], [ib, null], 'undo puts the old pointer back');
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.deepEqual([row(ia).superseded_by, row(ib).superseded_by], [null, ia]);
});

test('an apply-page copy no scan listed again stays behind the board row', async () => {
  const [board, stub] = pair('StubCo', 'Manufacturing Engineer');
  S.setStatus(board, 'applied');
  // The extension's row at the form's address: applied through, made by the extension, not a board.
  S.db().prepare("UPDATE jobs SET status = 'applied', source = 'extension', applied_at = '2026-11-03T00:00:00.000Z' WHERE id = ?").run(stub);
  assert.equal(S.isApplyPageCopy({ source: 'workday-manual' }), true, 'a manual add is one too');
  setPtr(stub, board);
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });
  assert.deepEqual([row(board).superseded_by, row(stub).superseded_by], [null, board], 'the card stays the board row');
});

test('a chain onto a row that is then turned round is put right in one run (passes repeat)', async () => {
  const [ia, ib] = pair('KlaShape', 'Mechanical Design Engineer');
  record(ia); carriedCopy(ib);
  setPtr(ia, ib);
  S.upsertJobs([{ url: 'https://www.linkedin.com/jobs/view/4300000099', title: 'Mechanical Design Engineer', company: 'KlaShape', location: 'Austin, TX' }], NEW);
  const third = idOf('https://www.linkedin.com/jobs/view/4300000099');
  setPtr(third, ia);   // a chain: third → record → copy
  const said = [];
  await dedupeStore({ recheckDecisions: true, write: true, log: (l) => said.push(String(l)) });
  assert.equal(row(ia).superseded_by, null, 'his record shows');
  assert.equal(row(ib).superseded_by, ia);
  assert.equal(row(third).superseded_by, ia, 'the third copy points straight at the row that shows');
  assert.ok(said.some((l) => /\d pass\(es\)/.test(l)), said.join(' | ').slice(0, 400));
});

test('an application that closed before any scan listed it again stays visible over a copy carrying "applied"', async () => {
  const [ia, ib] = pair('ClosedEarly', 'Test Engineer');
  // Applied after its last listing, then closed: last_seen is BEFORE applied_at (review: not an apply-page copy).
  S.db().prepare("UPDATE jobs SET status = 'applied', applied_at = '2026-10-05T00:00:00.000Z', gone_at = '2026-10-20T00:00:00.000Z' WHERE id = ?").run(ia);
  carriedCopy(ib);
  assert.equal(S.mayHide({ ...S.db().prepare('SELECT status, source, applied_at FROM jobs WHERE id = ?').get(ia) }, { status: 'applied' }), false, 'the rule itself');
  assert.equal(S.mayHide({ status: 'applied', applied_at: '2026-10-05' }, { status: 'interview' }), true, 'a copy that moved further may still hide it');
  setPtr(ia, ib);
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, null, 'his application shows');
  assert.equal(row(ib).superseded_by, ia);
});

test('a recheck that never settles says so loudly and journals it', async () => {
  const { recheckWrite } = await import('./dedupe.mjs');
  // A forced oscillation: the plan always has one more pointer to fix, and fixing it changes nothing.
  const ghost = { id: 'no-such-row', superseded_by: 'nor-this', status: 'applied' };
  const plan = () => ({ loops: [], chains: [], failing: [{ s: ghost, k: { id: 'nor-this' }, fix: 'release' }], skipped: [] });
  const said = [];
  const r = await recheckWrite(S.db(), { plan, log: (l) => said.push(String(l)), quietWhenClean: true });
  assert.equal(r.settled, false);
  assert.equal(r.passes, 5);
  assert.ok(said.some((l) => l.includes('RECHECK DID NOT SETTLE')), said.join(' | '));
  const line = readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.equal(line.counts.settled, false, 'the journal says it too');
  assert.equal(line.counts.leftAfterCap, 1);
});

test('the pointers are read through their own index, not a pass over the table', () => {
  const plan = (sql) => S.db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  const p = plan('SELECT id, superseded_by FROM jobs WHERE superseded_by IS NOT NULL');
  assert.match(p, /idx_jobs_superseded/, p);
  assert.doesNotMatch(p, /^SCAN jobs$/m, p);
});

test('a clean recheck leaves a one-line heartbeat that no undo ever picks', async () => {
  const { recheckWrite } = await import('./dedupe.mjs');
  const empty = () => ({ loops: [], chains: [], failing: [], skipped: [] });
  const r = await recheckWrite(S.db(), { plan: empty, log: quiet, quietWhenClean: true });
  assert.equal(r.changes, 0);
  const lines = readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const beat = lines.pop();
  assert.equal(beat.recheckClean, true);
  assert.equal(typeof beat.ms, 'number');
  assert.equal(beat.runId, undefined, 'no runId: --undo never reverses a heartbeat');
  const said = [];
  await dedupeStore({ undo: true, yes: true, log: (l) => said.push(String(l)) });
  assert.ok(!said.some((l) => l.includes(beat.at)), said.join(' | '));
});

// F-1034 (2026-11-07): a row the merge pass hides takes its incoming pointers with it.
test('F-1034: hiding a row that a copy points at moves the copy straight to the survivor — no chain, and the undo puts it back', async () => {
  const [ia, ib] = pair('ChainCo', 'Systems Engineer');   // A (older spelling) will be hidden behind B
  S.upsertJobs([{ url: 'https://www.linkedin.com/jobs/view/4300001234', title: 'Systems Engineer', company: 'ChainCo', location: 'Austin, TX' }], NEW);
  const ic = idOf('https://www.linkedin.com/jobs/view/4300001234');
  setPtr(ic, ia);   // a copy already pointing at A
  const said = [];
  await dedupeStore({ write: true, log: (l) => said.push(String(l)) });
  assert.equal(row(ia).superseded_by, ib, 'A is hidden behind B');
  assert.equal(row(ic).superseded_by, ib, 'and the copy points straight at B');
  assert.ok(!said.some((l) => /\d+ chain\(s\) collapsed/.test(l) && !/ 0 chain\(s\) collapsed/.test(l)), `the recheck found no chain to collapse: ${said.filter((l) => /chain/.test(l)).join(' | ')}`);
  const run = lastMergeRun();
  const m = run.merges.find((x) => x.stale === ia);
  assert.deepEqual(m.incoming, [{ id: ic, from: ia, to: ib }], 'the move is journalled on its merge');
  await dedupeStore({ undo: run.runId, log: quiet });
  assert.equal(row(ia).superseded_by, null, 'undo shows A again');
  assert.equal(row(ic).superseded_by, ia, 'and puts the copy back on A, exactly');
  await dedupeStore({ write: true, log: quiet });   // leave the store merged again for the tests after
});

test('F-1034: a copy holding more of his than the survivor is not moved behind it — it shows', async () => {
  const [ia, ib] = pair('ChainCo2', 'Test Engineer');
  S.upsertJobs([{ url: 'https://www.linkedin.com/jobs/view/4300005678', title: 'Test Engineer', company: 'ChainCo2', location: 'Austin, TX' }], NEW);
  const ic = idOf('https://www.linkedin.com/jobs/view/4300005678');
  S.setStatus(ic, 'interested');   // his heart on the copy
  setPtr(ic, ia);
  await dedupeStore({ write: true, log: quiet });
  assert.equal(row(ia).superseded_by, ib);
  assert.equal(row(ic).superseded_by, null, 'his heart is never hidden behind an untouched row: it shows');
  const m = lastMergeRun().merges.find((x) => x.stale === ia);
  assert.deepEqual(m.incoming, [{ id: ic, from: ia, to: null }]);
});

// Code review #5 (2026-11-13): every --write ends with a recheck journalled as
// its own run, so a bare --undo reversed the recheck and left the merge in place.
test('code review #5: --undo reverses a --write together with the recheck that ended it; a recheck that changed nothing is never "the last run"', async () => {
  const [ja, jb] = pair('UndoWrite', 'Controls Engineer');
  const [ie, iff] = pair('UndoWrite', 'Test Engineer');
  const extra = 'https://jobs.ashbyhq.com/UNDOWRITE/ffffffff-0000-4000-8000-ffffffffffff';
  S.upsertJobs([{ url: extra, title: 'Test Engineer', company: 'UndoWrite', location: 'Austin, TX' }], OLD);
  const ig = idOf(extra);
  setPtr(ig, ie); setPtr(ie, iff);                   // a chain the recheck at the end of --write collapses
  const before = allPointers();
  await dedupeStore({ write: true, log: quiet });
  assert.ok(row(ja).superseded_by || row(jb).superseded_by, 'the --write merged the pair');
  assert.equal(row(ig).superseded_by, iff, 'its recheck collapsed the chain');
  const said = [];
  await dedupeStore({ undo: true, log: (l) => said.push(String(l)) });
  const recheckRun = readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.follows).pop();
  assert.equal(recheckRun.follows, lastMergeRun().runId, 'the recheck names the --write it ended');
  assert.ok(said.some((l) => l.includes(`the --write ${lastMergeRun().runId} with its recheck ${recheckRun.runId}`)), `the prompt names the --write first: ${said.join(' | ')}`);
  await dedupeStore({ undo: true, yes: true, log: quiet });
  assert.deepEqual(allPointers(), before, 'a bare --undo puts back the merge and the recheck');
  await dedupeStore({ recheckDecisions: true, write: true, log: quiet });   // the store's invariant, for the next test
  // A recheck that could not settle but changed nothing keeps its journal line, and no bare --undo picks it.
  const { recheckWrite } = await import('./dedupe.mjs');
  const stuck = () => ({ loops: [], chains: [], failing: [{ s: { id: 'no-such-row', superseded_by: 'nor-this' }, k: { id: 'nor-this' }, fix: 'clear' }], skipped: [] });
  await recheckWrite(S.db(), { plan: stuck, maxPasses: 1, log: quiet });
  const stuckRun = readFileSync(path.join(dir, 'dedupe-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.equal(stuckRun.pointers.length, 0);
  const said2 = [];
  await dedupeStore({ undo: true, log: (l) => said2.push(String(l)) });
  assert.ok(!said2.some((l) => l.includes(stuckRun.runId)), said2.join(' | '));
});
