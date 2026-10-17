// jarvis/unlisted.test.mjs — a pick its own board stopped listing (2026-09-24).
// Run: node jarvis/unlisted.test.mjs
import { unlistedPicks } from './unlisted.mjs';

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

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
