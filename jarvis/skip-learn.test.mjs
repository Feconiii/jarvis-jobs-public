// Tests for the skip learner.
//
// The property that matters most is restraint: it must not propose blocking
// "manufacturing" because his skips are full of manufacturing jobs. A word is
// only evidence when it appears in skips MORE than in the deck he chose from.

import { learnFromSkips, learnFromApplyForms } from './skip-learn.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const skip = (title, company = 'X', reasons = [], note = '') => ({ title, company, reasons, note });
const job = (title, company = 'X') => ({ title, company });

console.log('\n🧪 skip-learn: a word must beat the deck baseline');

// Every skip says "Manufacturing Engineer" — and so does the whole deck. The
// naive version proposes blocking his own target role.
const allMfg = {
  skips: Array.from({ length: 6 }, (_, i) => skip(`Manufacturing Engineer ${i}`)),
  deck: Array.from({ length: 60 }, (_, i) => job(`Manufacturing Engineer ${i}`)),
};
const r1 = learnFromSkips(allMfg.skips, allMfg.deck);
check('does not propose blocking his own target role',
  r1.proposals.some(p => p.target === 'manufacturing'), false);

// Now the same deck, but every skip is a night-shift posting. "night" is rare
// in the deck and common in the skips, so it is a real preference.
const nights = {
  skips: Array.from({ length: 5 }, (_, i) => skip(`Manufacturing Engineer Night Shift ${i}`)),
  deck: [
    ...Array.from({ length: 55 }, (_, i) => job(`Manufacturing Engineer ${i}`)),
    ...Array.from({ length: 5 }, (_, i) => job(`Process Engineer Night Shift ${i}`)),
  ],
};
const r2 = learnFromSkips(nights.skips, nights.deck);
check('proposes the word that is over-represented in skips',
  r2.proposals.some(p => p.target === 'night'), true);
check('…and still not the word they share with the deck',
  r2.proposals.some(p => p.target === 'manufacturing'), false);

console.log('\n🧪 skip-learn: a proposal carries its blast radius');

const p = r2.proposals.find(x => x.target === 'night');
check('the rule is a line he can paste', p.rule, 'no night in title');
check('it says how many postings it would remove', p.wouldRemove, 5);
check('it shows what they are', p.examples.length > 0, true);
check('it shows the skips that argue for it', p.evidence.length > 0, true);
check('it explains itself in numbers', /skips/.test(p.why), true);

console.log('\n🧪 skip-learn: repeated employers');

const co = {
  skips: [skip('Engineer A', 'Hermeus'), skip('Engineer B', 'Hermeus'), skip('Engineer C', 'Hermeus'), skip('Other', 'Jabil')],
  deck: [...Array.from({ length: 41 }, (_, i) => job(`Role ${i}`, 'Hermeus')), job('Good one', 'Jabil')],
};
const r3 = learnFromSkips(co.skips, co.deck);
const cp = r3.proposals.find(x => x.kind === 'company');
check('three skips at one employer becomes a proposal', cp?.target, 'Hermeus');
check('…and reports what hiding them costs', cp?.wouldRemove, 41);
check('one skip at an employer does not', r3.proposals.some(x => x.target === 'Jabil'), false);

console.log('\n🧪 skip-learn: the free text is surfaced, never parsed');

// "it needs electrical engineering degree i am mechanical bruh" was one line
// and became a whole module. Guessing at what he meant is how a scorer starts
// lying, so notes come back verbatim.
const withNotes = learnFromSkips([
  skip('Design Engineer', 'Micron', [], 'it needs electrical engineering degree i am mechanical bruh'),
  skip('Manufacturing Engineer', 'Hermeus', ['Company not interesting'], 'defense company cant work'),
], [job('Design Engineer', 'Micron')]);
check('notes come back', withNotes.notes.length, 2);
check('…verbatim', withNotes.notes[1].note, 'it needs electrical engineering degree i am mechanical bruh');
check('checkbox reasons are counted', withNotes.reasons[0], { reason: 'Company not interesting', n: 1 });

console.log('\n🧪 skip-learn: degenerate inputs');

check('no skips → no proposals', learnFromSkips([], []).proposals.length, 0);
check('skips but no deck → no proposals', learnFromSkips([skip('A'), skip('B'), skip('C')], []).proposals.length, 0);
check('undefined does not throw', learnFromSkips().totals.skips, 0);
// Deduped to one: same employer, same (empty) title is the same opening.
check('a skip with no title does not throw',
  learnFromSkips([{ company: 'X' }, { company: 'X' }, { company: 'X' }], [job('A', 'X')]).totals.skips, 1);

console.log('\n🧪 skip-learn: one opening, one vote');

// Hiding a group of six duplicate reqs is ONE decision. Counting it six times
// manufactures a preference out of a single click.
const dupes = learnFromSkips(
  Array.from({ length: 6 }, () => skip('Semiconductor Manufacturing Engineer', 'GlobalFoundries')),
  [job('Something else', 'GlobalFoundries')],
);
check('six copies of one req count once', dupes.totals.skips, 1);
check('…so they cannot reach the employer threshold alone', dupes.proposals.length, 0);

console.log('\n🧪 skip-learn: it must never propose blocking his own field');

// Run against his real skips, the first version proposed "block
// manufacturing", "hide Applied Materials", "block mechanical" and "block
// semiconductor" — his target role, the employer he interned at and applied
// to, his degree, his industry. The statistics were right and the conclusion
// was backwards: he skips manufacturing jobs often because he is picky WITHIN
// his field.
const pickyInField = {
  skips: Array.from({ length: 8 }, (_, i) => skip(`Manufacturing Engineer ${i}`, 'Applied Materials')),
  deck: Array.from({ length: 100 }, (_, i) => job(`Process Engineer ${i}`, 'Applied Materials')),
};
const guarded = learnFromSkips(pickyInField.skips, pickyInField.deck, {
  protect: ['Manufacturing Engineer', 'Mechanical Engineering', 'semiconductor'],
  protectCompanies: ['Applied Materials'],
});
check('never proposes his target role', guarded.proposals.some(p => p.target === 'manufacturing'), false);
check('never proposes an employer he has said yes to',
  guarded.proposals.some(p => p.target === 'Applied Materials'), false);

console.log('\n🧪 skip-learn: years and places are not preferences');

// "2027" is his GRADUATION YEAR, and five skipped reqs carried it in the
// title. Micron and AMAT append the site to the title, so "santa" and "clara"
// looked like preferences — Santa Clara is one of his preferred hubs.
const noise = learnFromSkips(
  Array.from({ length: 5 }, (_, i) => ({ title: `Engineer ${i} 2027 Santa Clara`, company: `Co${i}`, location: 'Santa Clara' })),
  Array.from({ length: 50 }, (_, i) => ({ title: `Other Role ${i}`, company: `Co${i}`, location: 'Austin, TX' })),
);
check('a year is never proposed', noise.proposals.some(p => p.target === '2027'), false);
check('a city in the title is never proposed',
  noise.proposals.some(p => ['santa', 'clara'].includes(p.target)), false);

console.log('\n🧪 skip-learn: it proposes, it never acts');

// The whole contract. Nothing in the output mutates anything; `rule` is text.
const shape = r2.proposals[0];
check('every proposal is inert data', typeof shape.rule === 'string' || shape.action === 'hide-company', true);
check('and names the action for the UI to confirm', ['add-rule', 'hide-company'].includes(shape.action), true);

console.log('\n🧪 apply-forms: what the FORM gave away that the posting did not');

// Triage can only read what a posting says, and an ITAR employer routinely
// says nothing — the question only appears inside the form. The apply engine
// recorded these a month ago and nothing read them.
const prep = (company, title, labels) => ({ company, title, apply: { needsInput: labels.map(l => ({ label: l })), review: [] } });

const gates = learnFromApplyForms([
  prep('Machina Labs', 'Senior Industrial Automation Engineer', ['I am currently a "U.S. Person"']),
  prep('Machina Labs', 'Senior Mechanical Engineer', ['I am currently a "U.S. Person"']),
  prep('Hadrian', 'Applications Engineer', ['U.S. person. This ITAR/EAR status includes U.S. citizens, U.S. nationals, lawful permanent residents']),
  // Boilerplate at a large manufacturer is NOT a gate. Micron is a top target
  // and asks an export-control question on every req.
  prep('Micron Technology', 'Equipment Technician', ['All Micron sites must observe U.S. export control rules that control information']),
  prep('Jabil', 'Manufacturing Engineer', ['Are you legally authorized to work in the United States?']),
]);

check('an employer whose form demands US-Person status is surfaced',
  gates.some(g => g.target === 'Machina Labs'), true);
check('…and one that names ITAR', gates.some(g => g.target === 'Hadrian'), true);
check('a general export-control notice is not a gate',
  gates.some(g => g.target === 'Micron Technology'), false);
check('a plain work-authorisation question is not a gate',
  gates.some(g => g.target === 'Jabil'), false);

const ml = gates.find(g => g.target === 'Machina Labs');
check('it counts the postings affected', ml.wouldRemove, 2);
check('it quotes the question verbatim', /U\.S\. Person/.test(ml.evidence[0]), true);
check('it is a proposal, not an action', ml.action, 'hide-company');
check('no prepared applications → nothing', learnFromApplyForms([]).length, 0);
check('undefined does not throw', learnFromApplyForms().length, 0);

// ── a note that names an EMPLOYER-level reason ──────────────────────
//
// He skipped ONE Hermeus posting and wrote "defense company cant work". The
// frequency rule needs `minSkips` repeats, so it proposed nothing, and 31
// Hermeus reqs stayed in his deck at up to fit 88. No title rule can catch
// this: Hermeus posts "Structures Manufacturing Engineer".
console.log('\n\u{1F9EA} skip-learn: a note can carry company-level evidence');
{
  const skips = [{ company: 'Hermeus', title: 'Structures Manufacturing Engineer', note: 'defense company cant work', reasons: [] }];
  const deck = [
    { company: 'Hermeus', title: 'Avionics Manufacturing Engineer' },
    { company: 'Hermeus', title: 'Sheet Metal Manufacturing Engineer' },
  ];
  const r = learnFromSkips(skips, deck, {});
  const p = r.proposals.find(x => x.target === 'Hermeus');
  check('one skip with a defense note proposes hiding the employer', !!(!!p), true);
  check('it is a hide-company proposal', !!(p && p.action === 'hide-company'), true);
  check('it quotes his own note', !!(p && p.evidence.includes('defense company cant work')), true);
  check('it says what it would remove', !!(p && p.wouldRemove === 2), true);
}

{
  // The same note about an employer he has committed to must NOT propose.
  const skips = [{ company: 'Applied Materials', title: 'X', note: 'defense company cant work', reasons: [] }];
  const deck = [{ company: 'Applied Materials', title: 'Y' }];
  const r = learnFromSkips(skips, deck, { protectCompanies: ['Applied Materials'] });
  check('a protected employer is never proposed', !!(!r.proposals.some(x => x.target === 'Applied Materials')), true);
}

{
  // A note with no employer-level reason still needs repeats.
  const skips = [{ company: 'Acme', title: 'X', note: 'not interested in this one', reasons: [] }];
  const deck = [{ company: 'Acme', title: 'Y' }];
  const r = learnFromSkips(skips, deck, {});
  check('an ordinary note does not propose hiding a company', !!(!r.proposals.some(x => x.target === 'Acme')), true);
}

{
  // Nothing to remove means nothing to propose.
  const skips = [{ company: 'Gone Corp', title: 'X', note: 'defense company cant work', reasons: [] }];
  const r = learnFromSkips(skips, [], {});
  check('no deck postings → no proposal', !!(!r.proposals.some(x => x.target === 'Gone Corp')), true);
}

// -- launch employers --
// F-25 hid Boeing, Astro Mechanica, Ursa Major and Relativity by hand because
// their postings carry no description for a text rule to match. Nothing
// generalised it, so Rocket Lab walked back in at fit 81, title-only.
console.log('\n\u{1F9EA} skip-learn: launch employers are proposed, never hidden');
{
  const deck = [
    { company: 'Rocket Lab', title: 'Manufacturing Engineer I' },
    { company: 'Rocket Lab', title: 'Avionics Technician' },
    { company: 'Jabil', title: 'Manufacturing Engineer' },
  ];
  const r = learnFromSkips([], deck, {});
  const p = r.proposals.find(x => x.target === 'Rocket Lab');
  check('a launch employer in the deck is proposed', !!p, true);
  check('it is a proposal, not an action', !!(p && p.action === 'hide-company'), true);
  check('it says what it would remove', !!(p && p.wouldRemove === 2), true);
  check('it quotes his own decision', !!(p && /fuck off completely/.test(p.why)), true);
  check('a normal manufacturer is not proposed', !r.proposals.some(x => x.target === 'Jabil'), true);
}
{
  // An employer he has committed to is never proposed, whatever the list says.
  const r = learnFromSkips([], [{ company: 'Rocket Lab', title: 'X' }], { protectCompanies: ['Rocket Lab'] });
  check('a protected launch employer is not proposed', !r.proposals.some(x => x.target === 'Rocket Lab'), true);
}

// A DEAD POSTING IS NOT A PREFERENCE (2026-09-19).
//
// "Dead posting / no longer live" and "Already applied" were added to the
// reason list because they are the true reason he removes a lot of rows.
// Counting them would teach this to block the employers he applies to MOST and
// the roles that fill fastest — the exact inversion the protected-words block
// above exists to prevent.
{
  const dead = (company, title) => ({ company, title, reasons: ['Dead posting / no longer live'] });
  const applied = (company, title) => ({ company, title, reasons: ['Already applied'] });
  const deck = Array.from({ length: 30 }, (_, i) => ({ company: `Other ${i}`, title: 'Mechanical Engineer' }));
  const r = learnFromSkips([
    dead('Applied Materials', 'Mechanical Engineer'),
    dead('Applied Materials', 'Equipment Engineer'),
    dead('Applied Materials', 'Process Engineer'),
    applied('Micron', 'Shift Process Engineer'),
    applied('Micron', 'Equipment Engineer'),
    applied('Micron', 'Manufacturing Engineer'),
  ], deck, { minSkips: 3 });
  check('removing dead postings does not propose blocking that employer',
    !r.proposals.some(x => x.target === 'Applied Materials'), true);
  check('nor does having already applied there',
    !r.proposals.some(x => x.target === 'Micron'), true);

  // A REAL rejection at the same employer still counts, or the exclusion would
  // be a way of losing his actual decisions.
  const real = (company, title) => ({ company, title, reasons: ['Wrong kind of work'] });
  const deckPlus = [...deck, { company: 'Dullco', title: 'Mechanical Engineer' }, { company: 'Mixed', title: 'A' }];
  const r2 = learnFromSkips([
    real('Dullco', 'Mechanical Engineer'), real('Dullco', 'Equipment Engineer'),
    real('Dullco', 'Process Engineer'), dead('Dullco', 'Test Engineer'),
  ], deckPlus, { minSkips: 3 });
  check('a genuine rejection is still learned', r2.proposals.some(x => x.target === 'Dullco'), true);
  // A row carrying BOTH a real reason and a dead one is still a judgement.
  const r3 = learnFromSkips([
    { company: 'Mixed', title: 'A', reasons: ['Dead posting / no longer live', 'Pay too low'] },
    { company: 'Mixed', title: 'B', reasons: ['Pay too low'] },
    { company: 'Mixed', title: 'C', reasons: ['Pay too low'] },
  ], deckPlus, { minSkips: 3 });
  check('a mixed reason keeps its judgement', r3.proposals.some(x => x.target === 'Mixed'), true);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
