// jarvis/unlisted.test.mjs — a pick its own board stopped listing (2026-09-24).
// Run: node jarvis/unlisted.test.mjs
import { unlistedPicks, revivedPicks, rotateGonePicks, readGoneListedAgain } from './unlisted.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const now = Date.parse('2026-09-24T12:00:00Z');
const boards = new Map([
  ['Zipline', { newest: '2026-09-24T06:00:00Z', recent: 343 }],
  ['Stale Co', { newest: '2026-09-20T06:00:00Z', recent: 50 }],
  ['Big Co', { newest: '2026-09-24T06:00:00Z', recent: 1000 }],
]);
const pick = (id, company, last_seen, extra = {}) => ({ id, company, last_seen, source: 'greenhouse', ...extra });
const ids = (rows) => unlistedPicks(rows, boards, { now }).map((u) => u.id);

console.log('🧪 unlisted: absence from a freshly read board retires a pick');
eq('20 days unlisted on a board read today is gone', ids([pick('a', 'Zipline', '2026-09-04T06:00:00Z')]), ['a']);
eq('listed yesterday is alive', ids([pick('b', 'Zipline', '2026-09-23T06:00:00Z')]), []);
eq('6 days is not yet enough', ids([pick('c', 'Zipline', '2026-09-18T07:00:00Z')]), []);
console.log('\n🧪 unlisted: and never on weak evidence');
eq('a board not read in the last day proves nothing', ids([pick('d', 'Stale Co', '2026-09-01T06:00:00Z')]), []);
eq('a board at its page cap proves nothing', ids([pick('e', 'Big Co', '2026-09-01T06:00:00Z')]), []);
eq('a LinkedIn row is never board-scanned', ids([pick('f', 'Zipline', '2026-09-01T06:00:00Z', { source: 'linkedin' })]), []);
eq('a posting he applied to keeps its record', ids([pick('g', 'Zipline', '2026-09-01T06:00:00Z', { applied_at: '2026-09-10' })]), []);

console.log('\n🧪 unlisted: a board that read short is not mass closure (2026-10-16)');
const short = new Map([['onsemi', { newest: '2026-09-24T06:00:00Z', recent: 2 }]]);
const three = ['h', 'i', 'j'].map((id) => pick(id, 'onsemi', '2026-09-01T06:00:00Z'));
eq('dropped 3 while listing 2: nothing retired', unlistedPicks(three, short, { now }).map((u) => u.id), []);
eq('dropped 2 while listing 2: both retired', unlistedPicks(three.slice(0, 2), short, { now }).map((u) => u.id), ['h', 'i']);
console.log('\n🧪 unlisted: a board is company AND source');
const keyed = new Map([['Acme\u0001greenhouse', { newest: '2026-09-10T06:00:00Z', recent: 40 }], ['Acme\u0001linkedin', { newest: '2026-09-24T06:00:00Z', recent: 5 }]]);
eq('a LinkedIn row today does not make a failed Greenhouse board fresh',
  unlistedPicks([pick('k', 'Acme', '2026-09-01T06:00:00Z', { board: 'Acme\u0001greenhouse' })], keyed, { now }).map((u) => u.id), []);

console.log('\n🧪 unlisted: a gone pick comes back only on the ATS saying active (2026-11-03)');
{
  const g = (id, last_seen) => pick(id, 'Zipline', last_seen, { gone_at: '2026-09-20T00:00:00Z' });
  const v = new Map([['r1', { result: 'active' }], ['r2', { result: 'active' }], ['r3', { result: 'expired' }], ['r4', null]]);
  const rows = [g('r1', '2026-09-24T05:00:00Z'), g('r2', '2026-09-01T06:00:00Z'), g('r3', '2026-09-24T05:00:00Z'), g('r4', '2026-09-24T05:00:00Z')];
  eq('active and still listed comes back; unlisted, expired or undecided stay closed', revivedPicks(rows, boards, v, { now }), ['r1']);
  const old = { ...g('r5', '2026-08-21T00:00:00Z'), company: 'Stale Co' };
  eq('active, but not listed since it was retired, stays closed', revivedPicks([old], boards, new Map([['r5', { result: 'active' }]]), { now }), []);
}

console.log('\n🧪 unlisted: gone picks are rechecked in rotation, least recently asked first');
{
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const checked = { a: '2026-11-03T10:00:00Z', b: '2026-11-01T10:00:00Z' };
  eq('never asked first, then the oldest', rotateGonePicks(rows, checked, 3).map((p) => p.id), ['c', 'd', 'b']);
  eq('asking those moves the window on', rotateGonePicks(rows, { ...checked, c: '2026-11-03T11:00:00Z', d: '2026-11-03T11:00:00Z', b: '2026-11-03T11:00:00Z' }, 2).map((p) => p.id), ['a', 'b']);
}

console.log('\n🧪 unlisted: any closed row its board listed again is asked again (2026-11-03)');
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE jobs (id TEXT, company TEXT, title TEXT, url TEXT, last_seen TEXT, source TEXT, applied_at TEXT, gone_at TEXT, status TEXT)');
  const ins = db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('e1', 'Electra', 'Airframe Design Engineer', 'u1', '2026-11-03T07:57:00Z', 'greenhouse', null, '2026-10-16T18:27:00Z', 'new');   // listed for 18 days since
  ins.run('e2', 'Electra', 'Old Role', 'u2', '2026-10-16T19:00:00Z', 'greenhouse', null, '2026-10-16T18:27:00Z', 'new');              // not listed since
  ins.run('e3', 'Electra', 'His Pick', 'u3', '2026-11-03T07:57:00Z', 'greenhouse', null, '2026-10-16T18:27:00Z', 'inbox');           // the picks pass owns it
  eq('only a non-pick row listed again more than a day later', readGoneListedAgain(db).picks.map((p) => p.id), ['e1']);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
