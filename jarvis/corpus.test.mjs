#!/usr/bin/env node
// jarvis/corpus.test.mjs — his answer corpus, and the guard on the writer.
//
// The corpus is the only place that holds BOTH an answer he kept and the exact
// answer he rejected for the same question. Two things have to keep working:
// the file must keep parsing as he edits it, and the prompt must keep carrying
// the rejected half — which is the half that teaches, and the easiest thing to
// lose in a refactor without anything going red.
import { loadCorpus, loadObservations, corpusBlock, pickExemplars } from './apply/corpus.mjs';
import { scoreAnswer } from './corpus-score.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

console.log('🧪 corpus: his own answers, accepted and rejected');

const corpus = loadCorpus();
ok('the corpus parses', corpus.length >= 19, `${corpus.length} entries`);
ok('and most entries carry a real answer', corpus.filter((e) => e.accepted).length >= 18);

// THE REJECTED HALF IS THE POINT. Nine of his entries have one; a parser change
// that silently dropped them would leave the prompt with only good examples,
// which is the state that produced the rejected answers in the first place.
const pairs = corpus.filter((e) => e.accepted && e.rejected);
ok('the rejected answers survive parsing', pairs.length >= 8, `${pairs.length} pairs`);

// TWO SECTIONS ARE REJECTED-ONLY and were dropped by the first parser — which
// cost `excellence` its only negative examples, the kind he rejected most.
const excellence = corpus.filter((e) => e.kind === 'excellence');
ok('excellence has negative examples too',
  excellence.some((e) => e.rejected), `${excellence.length} excellence entries, ${excellence.filter((e) => e.rejected).length} with a rejection`);

ok('his global observations are found', loadObservations().length > 1500);

// The prompt block: same KIND as the question, and it must show a rejection.
for (const kind of ['why-company', 'excellence', 'challenge', 'other', 'project']) {
  const block = corpusBlock(kind);
  ok(`the ${kind} block is built`, block.length > 400, `${block.length} chars`);
  ok(`the ${kind} block shows an answer he threw away`, /HE REJECTED THIS/.test(block));
}
ok('a block stays inside its budget', corpusBlock('challenge', { maxChars: 3000 }).length <= 3200,
  `${corpusBlock('challenge', { maxChars: 3000 }).length} chars`);
ok('an exemplar of the right kind is preferred',
  pickExemplars('excellence')[0]?.kind === 'excellence');

// ── the scorer ───────────────────────────────────────────────────────
console.log('\n🧪 corpus: the score separates what he kept from what he threw away');

// NOT A PROSE GRADER. It counts the things his commentary names — technical
// inventory, the job description speaking through him, selling himself through
// a personality question. A LOW score does not mean a good answer; a HIGH one
// reliably means a bad one, and that asymmetry is what makes it a regression
// guard rather than a quality certificate.
const scored = pairs.map((e) => ({
  n: e.n,
  a: scoreAnswer(e.accepted, { kind: e.kind }).score,
  r: scoreAnswer(e.rejected, { kind: e.kind }).score,
}));
const separates = scored.filter((s) => s.r > s.a).length;
ok('it separates most pairs the right way round', separates >= 5,
  `${separates}/${scored.length}: ${scored.map((s) => `#${s.n} ${s.a}v${s.r}`).join(', ')}`);

const meanA = scored.reduce((n, s) => n + s.a, 0) / scored.length;
const meanR = scored.reduce((n, s) => n + s.r, 0) / scored.length;
ok('and rejected answers score clearly worse on average', meanR > meanA * 1.5,
  `accepted ${meanA.toFixed(2)}, rejected ${meanR.toFixed(2)}`);

// The two worst offenders he named, pinned individually.
const tsmc = pairs.find((e) => e.n === 2);
ok('the TSMC answer with the job description speaking through it scores worse',
  scoreAnswer(tsmc.rejected, { kind: tsmc.kind }).jdVoice > 0,
  'it contains "data driven" and "expanding capacity"');
const empire = pairs.find((e) => e.n === 15);
ok('the empire answer that turned into a resume bullet is caught',
  scoreAnswer(empire.rejected, { kind: empire.kind }).selling
    > scoreAnswer(empire.accepted, { kind: empire.kind }).selling,
  'a personality question answered with Makerspace and a Watney pitch');

// The measurement asks the writer HIS corpus questions. Without a hold-out the
// prompt showed it the answer he kept to that very question — an open-book
// test, which is how the 2026-09-22 run scored "level" (2026-09-23).
for (const e of pairs) {
  ok(`#${e.n} held out: its kept answer never reaches the prompt`,
    !corpusBlock(e.kind, { exclude: e.n }).includes(e.accepted.slice(0, 80)));
}
ok('without a hold-out the same kind does show it (so the check above can fail)',
  pairs.some((e) => corpusBlock(e.kind).includes(e.accepted.slice(0, 80))));

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

