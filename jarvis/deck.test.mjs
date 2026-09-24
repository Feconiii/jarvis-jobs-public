// Tests for deck spreading — the fix for "ten Applied Materials cards in a row".

import { spreadRows, deckConcentration } from './deck.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const row = (company, field, score) => ({ company, field, fit_score: score, id: `${company}-${score}` });

console.log('\n🧪 deck: a permutation, never a filter');

// The real shape of the problem: one employer posts 10 near-identical reqs
// that all legitimately score at the top.
const amat = Array.from({ length: 10 }, (_, i) => row('Applied Materials', 'semiconductor', 90 - i));
const others = [
  row('Boston Dynamics', 'robotics', 88),
  row('Anthropic', 'ai-hardware', 87),
  row('Rocket Lab', 'space', 86),
  row('Medtronic', 'medical', 85),
];
const mixed = [...amat, ...others].sort((a, b) => b.fit_score - a.fit_score);

const spread = spreadRows(mixed);
check('every row survives', spread.length, mixed.length);
check('no row is duplicated', new Set(spread.map(r => r.id)).size, mixed.length);
check('the input set is unchanged',
  spread.map(r => r.id).slice().sort(), mixed.map(r => r.id).slice().sort());

console.log('\n🧪 deck: the streak is broken');

// Concentration is measured over the HEAD, because that is what he actually
// sees. When one employer holds most of the page the tail is unavoidably that
// employer — there is nothing left to interleave with, and pretending otherwise
// would mean dropping rows.
const realistic = [
  ...Array.from({ length: 9 }, (_, i) => row('GlobalFoundries', 'semiconductor', 99 - i)),
  ...Array.from({ length: 5 }, (_, i) => row('Micron', 'semiconductor', 94 - i)),
  row('Boston Dynamics', 'robotics', 93),
  row('Figure', 'robotics', 92),
  row('NVIDIA', 'ai-hardware', 91),
  row('Rocket Lab', 'space', 90),
  row('Medtronic', 'medical', 89),
  row('Tesla', 'energy', 88),
].sort((a, b) => b.fit_score - a.fit_score);

const rSpread = spreadRows(realistic);
const before = deckConcentration(realistic.slice(0, 12), 12);
const after = deckConcentration(rSpread.slice(0, 12), 12);

check('unspread, one employer runs long', before.longestRun >= 6, true);
check('spread, the longest run collapses', after.longestRun <= 2, true);
check('unspread, one employer owns most of the head', before.topCount >= 6, true);
check('spread, the head is shared out', after.topCount <= 4, true);
check('spread, the head spans more employers',
  new Set(rSpread.slice(0, 12).map(r => r.company)).size >
  new Set(realistic.slice(0, 12).map(r => r.company)).size, true);

console.log('\n🧪 deck: order within an employer is preserved');

// Nothing is demoted — a higher-scoring req of an employer still precedes that
// employer's lower-scoring ones. Spreading interleaves; it does not re-rank.
const amatOrder = spread.filter(r => r.company === 'Applied Materials').map(r => r.fit_score);
check('an employer\'s own reqs stay best-first',
  amatOrder, [...amatOrder].sort((a, b) => b - a));

console.log('\n🧪 deck: the best row still leads');
check('the top card is still the top score', spread[0].fit_score, mixed[0].fit_score);

console.log('\n🧪 deck: degenerate inputs');
check('empty stays empty', spreadRows([]), []);
check('one row is untouched', spreadRows([row('A', 'robotics', 9)]).length, 1);
check('two rows are untouched', spreadRows([row('A', 'x', 9), row('A', 'x', 8)]).length, 2);
check('all one employer still returns everything',
  spreadRows(amat).length, 10);
check('missing company/field does not throw',
  spreadRows([{ fit_score: 5 }, { fit_score: 4 }, { fit_score: 3 }]).length, 3);

console.log('\n🧪 deck: fields interleave too');

const fieldy = [
  row('A', 'robotics', 99), row('B', 'robotics', 98), row('C', 'robotics', 97),
  row('D', 'space', 96), row('E', 'ai-hardware', 95),
];
const fs = spreadRows(fieldy).map(r => r.field);
let sameFieldAdjacent = 0;
for (let i = 1; i < fs.length; i++) if (fs[i] === fs[i - 1]) sameFieldAdjacent++;
check('same field rarely lands back to back', sameFieldAdjacent <= 1, true);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
