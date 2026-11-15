// jarvis/pick-fields.test.mjs — pay and catch read out of a pick's note.
// Run: node jarvis/pick-fields.test.mjs
import { catchFromNote, payFromNote, pickFields, reachFromNote } from './pick-fields.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};

console.log('🧪 pick-fields: the catch');
eq('"… is the catch" is the catch', catchFromNote('Worth a look: "1+ year of CAD experience" is the catch, and the role requires travel. His Inventor fixture work covers the drawing.'),
  '"1+ year of CAD experience" is the catch, and the role requires travel.');
eq('"Catch: …" loses its label', catchFromNote('Worth a look: Catch: the posting gives no company size. Overlap: his fixture work.'), 'the posting gives no company size.');
eq('a turn ("but … asks for …") counts when nothing is named', catchFromNote('Worth a look: The years line passes, but the required list also asks for gear machining, which he has not done. His CNC work fits.'),
  'The years line passes, but the required list also asks for gear machining, which he has not done.');
// F-934 review, 2026-11-04: a reach card's note opens with its label.
eq('a reach label is not part of the catch', catchFromNote('Reach: the core work is another discipline. Worth a look: Catch: sensor electronics. His fixture work fits.'), 'sensor electronics.');
eq('…and is read on its own', reachFromNote('Reach: his degree is not among the ones the posting lists. Worth a look: x'), 'his degree is not among the ones the posting lists');
eq('…a note without one has none', reachFromNote('Worth a look: Catch: second shift.'), null);
eq('a note with no catch gives none',catchFromNote('HighRes (lab automation robots), Beverly MA, $80K-$85K. BS ME, "0-2 years experience".'), null);

console.log('\n🧪 pick-fields: the pay');
eq('pay the note quotes is read', payFromNote('HighRes (lab automation robots), Beverly MA, $80K-$85K. BS ME.')?.max, 85000);
eq('a note with no pay gives none', payFromNote('Worth a look: his Applied Materials fixture work matches.'), null);
eq('the row\'s own pay wins: no note pay when the row has a salary', pickFields({ pickNote: 'x $80K-$85K salary', salary: { min: 1, max: 2 } }).pickPay, undefined);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
