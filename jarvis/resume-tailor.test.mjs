/**
 * The guard that replaced the verbatim lock.
 *
 * Every case here is a way a language model could quietly put something on
 * Alex's resume that cv.md does not support. If one of these starts passing when
 * it should fail, a tailored resume can carry an invented claim to a real
 * employer — so these are pinned harder than the rest of the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  tokens, numbersIn, entitiesIn, buildVocabulary,
  checkRewrite, applyRewrites, STOPWORDS, MAX_GROWTH, stem, LOCKED,
} from './resume-tailor.mjs';
import { buildSpec, loadPool } from './resume-variants.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A stand-in cv.md: small enough to reason about, real enough to be honest.
const CV = `
Designed inspection fixtures in Autodesk Inventor for wafer-handling components,
cutting inspection time 40% across 3,689 parts. Built a Neuro-T machine-vision
model. Assembled and validated AMR test runs. GD&T, DFM/DFA, 5-axis CNC.
`;
const VOCAB = buildVocabulary(CV);

test('stem meets in the middle on the pairs that broke it', () => {
  // Each pair must land on the same stem. "times"/"time" and
  // "processes"/"process" are the two a naive suffix strip gets wrong in
  // OPPOSITE directions, which is why they are pinned rather than trusted.
  for (const [a, b] of [
    ['time', 'times'], ['process', 'processes'], ['fixture', 'fixtures'],
    ['design', 'designed'], ['design', 'designing'], ['machine', 'machined'],
    ['component', 'components'], ['assembly', 'assemblies'],
  ]) {
    assert.equal(stem(a), stem(b), `"${a}" and "${b}" must stem alike`);
  }
  // Words that are genuinely different must NOT collide — an over-eager stem
  // would quietly let an invented term through the vocabulary net.
  assert.notEqual(stem('welding'), stem('wiring'));
  assert.notEqual(stem('design'), stem('designation'));
});

test('tokens keeps compound names whole', () => {
  const t = tokens('Applied GD&T and DFM/DFA on a 5-axis Node-RED rig, twice.');
  assert.ok(t.includes('GD&T'), 'GD&T must survive tokenising');
  assert.ok(t.includes('DFM/DFA'), 'DFM/DFA must survive tokenising');
  assert.ok(t.includes('5-axis'), '5-axis must survive tokenising');
  assert.ok(t.includes('Node-RED'), 'Node-RED must survive tokenising');
  assert.ok(!t.includes('twice.'), 'trailing punctuation is stripped');
});

test('numbersIn normalises thousands and keeps percent attached', () => {
  const n = numbersIn('cut 40% across 3,689 parts in 12.5 hours');
  assert.deepEqual([...n].sort(), ['12.5', '3689', '40%'].sort());
  assert.ok(!n.has('40'), '"40" and "40%" are different claims');
});

test('entitiesIn ignores the sentence-initial capital but catches real names', () => {
  const e = entitiesIn('Designed fixtures in Inventor using GD&T for SolidWorks parts');
  assert.ok(!e.has('designed'), 'a leading capital is grammar, not a name');
  assert.ok(e.has('inventor'));
  assert.ok(e.has('gd&t'));
  assert.ok(e.has('solidworks'));
});

test('stopwords are function words only — action verbs must face the check', () => {
  for (const w of ['designed', 'assembled', 'built', 'validated', 'machined', 'led']) {
    assert.ok(!STOPWORDS.has(w), `"${w}" is a claim about what he did and must not be waved through`);
  }
  for (const w of ['the', 'with', 'across', 'during']) assert.ok(STOPWORDS.has(w));
});

const SRC = 'Designed inspection fixtures in Autodesk Inventor for wafer-handling components, cutting inspection time 40%';

test('an honest rewording passes', () => {
  const r = checkRewrite({
    text: 'Designed wafer-handling inspection fixtures in Autodesk Inventor, cutting inspection time 40%',
    source: SRC, vocab: VOCAB,
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('REFUSES an invented figure', () => {
  const r = checkRewrite({ text: `${SRC.replace('40%', '75%')}`, source: SRC, vocab: VOCAB });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /figure "75%" is not in the source/);
});

test('REFUSES a tool the source never named — the JD-keyword trap', () => {
  const r = checkRewrite({
    text: 'Designed inspection fixtures in SolidWorks for wafer-handling components, cutting inspection time 40%',
    source: SRC, vocab: VOCAB,
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /"solidworks" is named in the rewrite but not in the source/);
});

test('REFUSES a lowercase invention that is neither a number nor a name', () => {
  const r = checkRewrite({
    text: 'Designed inspection fixtures in Autodesk Inventor for wafer-handling components using lean kaizen methods',
    source: SRC, vocab: VOCAB,
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /"lean" appears nowhere in cv\.md|"kaizen" appears nowhere in cv\.md/);
});

test('allows a word cv.md has elsewhere, even if this bullet lacks it', () => {
  // "validated" lives in another sentence of the CV. That is a wording choice
  // inside his own vocabulary, which is exactly what he asked to be allowed.
  const r = checkRewrite({
    text: 'Designed and validated inspection fixtures in Autodesk Inventor, cutting inspection time 40%',
    source: SRC, vocab: VOCAB,
  });
  assert.deepEqual(r.problems, []);
});

test('plurals and tenses are wording, not claims', () => {
  const r = checkRewrite({
    text: 'Designing inspection fixtures in Autodesk Inventor, cutting inspection times 40%',
    source: SRC, vocab: VOCAB,
  });
  assert.deepEqual(r.problems, []);
});

test('a dropped figure is a notice, not a refusal', () => {
  const r = checkRewrite({
    text: 'Designed wafer-handling inspection fixtures in Autodesk Inventor',
    source: SRC, vocab: VOCAB,
  });
  assert.equal(r.ok, true, 'dropping a detail is legal');
  assert.match(r.notices.join('\n'), /dropped the figure "40%"/);
});

test('REFUSES a rewrite that blows the page budget', () => {
  const r = checkRewrite({ text: `${SRC} ${SRC}`, source: SRC, vocab: VOCAB });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /page budget/);
});

test('REFUSES an empty rewrite instead of blanking the bullet', () => {
  assert.equal(checkRewrite({ text: '   ', source: SRC, vocab: VOCAB }).ok, false);
});

test('the short form counts as a source — both trace to a file he wrote', () => {
  const r = checkRewrite({
    text: 'Built a Neuro-T vision model',
    source: ['Built a Neuro-T machine-vision model for defect detection', 'Built a Neuro-T vision model'],
    vocab: VOCAB,
  });
  assert.deepEqual(r.problems, []);
});

// --- applyRewrites, against the REAL pool ------------------------------------

test('every experience bullet in every family carries provenance', () => {
  for (const family of ['total-experience', 'automation', 'manufacturing', 'mechanical']) {
    const spec = buildSpec(family);
    for (const entry of spec.experience) {
      for (const b of entry.bullets) {
        assert.match(b.provenanceKey || '', /^[a-z0-9-]+\.[a-z0-9-]+$/i,
          `${family}: a bullet reached the renderer with no provenance key`);
        assert.ok(b.source?.length, `${family}: ${b.provenanceKey} has no source to check a rewrite against`);
        assert.ok(b.source.includes(b.text), `${family}: ${b.provenanceKey} renders text that is not one of its approved forms`);
      }
    }
  }
});

test('applyRewrites keeps the original when a rewrite is refused', () => {
  const spec = buildSpec('automation');
  const target = spec.experience[0].bullets[0];
  const out = applyRewrites(spec, { [target.provenanceKey]: 'Delivered 900% throughput gains with Siemens PLM' }, { vocab: VOCAB });
  assert.equal(out.applied.length, 0);
  assert.equal(out.refused.length, 1);
  assert.equal(out.spec.experience[0].bullets[0].text, target.text, 'a refused rewrite must not damage the resume');
});

test('a REFUSED rewrite contributes no notices — it never shipped', () => {
  // A live run reported "dropped the figure 3" for a rewrite the guard had
  // thrown out, while the sentence actually on the resume still carried the 3.
  // A notice about a discarded sentence is worse than no notice: he reads these
  // to decide whether a bullet lost its point.
  const spec = buildSpec('automation');
  const target = spec.experience.flatMap((e) => e.bullets).find((b) => /\d/.test(b.source.join(' ')));
  assert.ok(target, 'the pool must have at least one bullet carrying a figure');
  const out = applyRewrites(spec, { [target.provenanceKey]: 'Delivered results with Kubernetes at scale' }, { vocab: VOCAB });
  assert.equal(out.refused.length, 1);
  assert.deepEqual(out.notices, [], 'a refused rewrite may not report what it would have dropped');
});

test('applyRewrites reports a key that matched nothing', () => {
  const spec = buildSpec('automation');
  const out = applyRewrites(spec, { 'nosuchorg.nosuchbullet': 'anything' }, { vocab: VOCAB });
  assert.deepEqual(out.unmatched, ['nosuchorg.nosuchbullet'],
    'a tailored resume that silently shipped untailored would read as a success');
});

test('applyRewrites applies a clean rewrite and records the diff', () => {
  const spec = buildSpec('automation');
  const target = spec.experience[0].bullets[0];
  const cv = readFileSync(path.join(HERE, '..', 'cv.md'), 'utf-8');
  const vocab = buildVocabulary(cv);
  // Shorten the real sentence to its own opening — no new words at all, so this
  // is the most conservative possible rewrite and must always be accepted.
  const trimmed = target.text.split(/,\s*/)[0];
  if (trimmed === target.text) return; // no comma to trim; nothing to prove here
  const out = applyRewrites(spec, { [target.provenanceKey]: trimmed }, { vocab, strict: true });
  assert.equal(out.applied.length, 1);
  assert.equal(out.applied[0].from, target.text);
  // It ships with a period: every bullet on his page ends with one (2026-09-23).
  assert.equal(out.applied[0].to, `${trimmed}.`);
  assert.equal(out.spec.experience[0].bullets[0].text, `${trimmed}.`);
});

test('strict mode throws rather than shipping a refused rewrite', () => {
  const spec = buildSpec('automation');
  const target = spec.experience[0].bullets[0];
  assert.throws(
    () => applyRewrites(spec, { [target.provenanceKey]: 'Achieved 999% yield using Kubernetes' }, { vocab: VOCAB, strict: true }),
    /tailoring refused/,
  );
});

test('THE FIXTURE BULLET SHIPS IN HIS OWN WORDS — a rewrite for it never lands', () => {
  // Alex, 2026-09-13: the tailored version "reads so bad… it mumbles then it
  // adds in the for pin inspection at the end". The rewrite was legal, which
  // is the point: the checker tests truth, not whether a sentence reads well.
  const spec = buildSpec('automation');
  const target = spec.experience
    .flatMap((e) => e.bullets)
    .find((b) => b.provenanceKey === 'amat.vision-fixture');
  assert.ok(target, 'the automation family must still carry the fixture bullet');
  // A rewrite the checker would otherwise ACCEPT — the sentence's own opening.
  const trimmed = target.text.split(/,\s*/)[0];
  const out = applyRewrites(spec, { 'amat.vision-fixture': trimmed }, { vocab: VOCAB, strict: true });
  assert.equal(out.applied.length, 0, 'a locked bullet must not be reworded');
  assert.equal(out.refused.length, 1, 'and the proposal must be reported, not swallowed');
  assert.equal(
    out.spec.experience.flatMap((e) => e.bullets).find((b) => b.provenanceKey === 'amat.vision-fixture').text,
    target.text,
  );
});

test('a locked bullet never fails a build — strict mode passes over it', () => {
  const spec = buildSpec('automation');
  // The same call under strict: a lock is a decision, not a refused rewrite.
  assert.doesNotThrow(() => applyRewrites(spec, { 'amat.vision-fixture': 'Designed a fixture' }, { vocab: VOCAB, strict: true }));
  assert.ok(LOCKED.has('amat.vision-fixture'));
});

test('THE FRAMEWORKS THAT ARE A STUDY STAY OUT — DOE, SPC, Cpk, Gage R&R, belts', () => {
  // Alex opened the door to method names on 2026-09-13 and cv.md now carries
  // the ones that describe how he already worked. These are the other kind:
  // a claim to one is a claim to a data set, and the interviewer asking about
  // it ran one. cv.md is the whole allowed vocabulary, so the refusal lives in
  // FORBIDDEN and the words are deliberately absent from cv.md.
  const cv = readFileSync(path.join(HERE, '..', 'cv.md'), 'utf-8');
  const vocab = buildVocabulary(cv);
  const source = 'Performed dimensional analysis of 100+ steel stud samples with calipers.';
  for (const bad of [
    'Ran a design of experiments on 100+ steel stud samples',
    'Used SPC control charts on 100+ steel stud samples',
    'Held Cpk above target across 100+ steel stud samples',
    'Completed a Gage R&R on 100+ steel stud samples',
    'Authored the control plan for 100+ steel stud samples',
    'Six Sigma Green Belt applied to 100+ steel stud samples',
  ]) {
    const res = checkRewrite({ text: bad, source, vocab, label: 'acme.dimensional' });
    assert.equal(res.ok, false, `must refuse: ${bad}`);
  }
  // And the ones he CAN say still pass the vocabulary gate.
  for (const good of ['5 Whys', 'fishbone', 'Pareto', 'poka-yoke', 'kaizen', 'PDCA', 'DMAIC', 'PFMEA']) {
    assert.ok(cv.toLowerCase().includes(good.toLowerCase()), `cv.md must name "${good}" for the tailor to use it`);
  }
});

test('MAX_GROWTH stays tight enough to protect the one-page layout', () => {
  assert.ok(MAX_GROWTH <= 1.5, 'all four resumes sit near a full page; a looser budget silently costs a second page');
});

test('the real pool survives a no-op tailor pass', () => {
  const pool = loadPool();
  const cv = readFileSync(path.join(HERE, '..', 'cv.md'), 'utf-8');
  const vocab = buildVocabulary(cv);
  for (const family of ['total-experience', 'automation', 'manufacturing', 'mechanical']) {
    const spec = buildSpec(family, pool);
    // Feed every bullet its own text back. Nothing should be refused — if the
    // guard cannot accept the resume's own sentences, it is miscalibrated.
    const rewrites = {};
    for (const e of spec.experience) for (const b of e.bullets) rewrites[b.provenanceKey] = b.text;
    const out = applyRewrites(spec, rewrites, { vocab });
    assert.deepEqual(out.refused, [], `${family}: the guard refused a sentence already on the resume`);
  }
});

test('A COMPOUND JOINED FROM APPROVED PIECES IS NOT A NEW NAME: "drawings/BOMs" from "drawings and BOM"; "drawings/PLCs" still is', () => {
  const src = 'Designed a fixture in Autodesk Inventor; created the engineering drawings and BOM, and released the design through Teamcenter.';
  const vocab = buildVocabulary(src);
  const ok = checkRewrite({ text: 'Designed a fixture in Autodesk Inventor; created drawings/BOMs and released the design through Teamcenter.', source: [src], vocab });
  assert.deepEqual(ok.problems, [], JSON.stringify(ok));
  const bad = checkRewrite({ text: 'Designed a fixture in Autodesk Inventor; created drawings/PLCs and released the design through Teamcenter.', source: [src], vocab });
  assert.ok(bad.problems.some((x) => /drawings\/plcs/i.test(x)), JSON.stringify(bad.problems));
});
