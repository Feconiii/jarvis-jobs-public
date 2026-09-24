#!/usr/bin/env node
// jarvis/corpus-score.mjs — how close is the writer to the answers he KEPT?
//
// His ask, 2026-09-22: "report to me progress on matching claude's answer to
// chatgpt on open ended questions". This is that number, and it is measured
// rather than asserted.
//
// The corpus gives a rare thing: for 9 questions, the answer he kept AND the
// exact Claude answer he rejected, with the same facts available to both. So
// the rejected answers are a labelled negative set, and any metric worth having
// must separate them from the accepted ones WITHOUT being told which is which.
//
// WHAT THIS DOES NOT DO. It does not grade prose. Every measure here is a proxy
// his own commentary names — length, how much of the answer is technical
// inventory, whether the job description is speaking through him, whether the
// same project is reached for every time. A high score is not a good answer; a
// low score is reliably a bad one. That asymmetry is the whole value: it
// catches regressions, it does not certify quality.
//
// Usage:
//   node jarvis/corpus-score.mjs              # score the corpus itself (the baseline)
//   node jarvis/corpus-score.mjs --json
import { loadCorpus } from './apply/corpus.mjs';

// The detail nouns his commentary names as arriving "before the reader
// understands why they matter": "Ball plungers, dovetails, tolerance analysis,
// RoboDK, Teamcenter, RS232, Tulip, and machine-vision architecture".
const INVENTORY = [
  'ball plunger', 'dovetail', 'tolerance analysis', 'robodk', 'teamcenter', 'rs232',
  'tulip', 'neuro-t', 'din rail', 'bom', 'engineering drawing', 'autodesk inventor',
  'node-red', 'edge device', 'pressure decay', 'pressure-decay', 'ball plungers',
];

// Phrases that belong to a posting rather than to him — his "the job description
// starts talking through Alex".
const JD_VOICE = [
  'data driven', 'data-driven', 'systematic problem solving', 'speed and quality',
  'expanding capacity', 'end to end', 'end-to-end', 'cross-functional', 'world class',
  'world-class', 'fast paced', 'fast-paced', 'cutting edge', 'cutting-edge',
  'mission critical', 'mission-critical', 'scalable', 'leverage', 'best in class',
];

const count = (text, needles) => {
  const t = text.toLowerCase();
  return needles.reduce((n, w) => n + (t.split(w).length - 1), 0);
};

/**
 * Score one answer. Lower is better on every component; `score` is the sum, so
 * lower is better overall.
 */
export function scoreAnswer(text, { kind = '' } = {}) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 10);
  const inventory = count(text, INVENTORY);
  const jdVoice = count(text, JD_VOICE);

  // THE FIXTURE REACHED FOR REGARDLESS OF THE QUESTION. His first named failure
  // mode: "The writer repeatedly reaches for the Applied Materials machine-vision
  // fixture even when the question is about motivation, work ethic, failure,
  // personality, or culture."
  const fixture = /lift[- ]?pin|machine[- ]vision fixture|inspection fixture|heater assembly/i.test(text);
  const offTopicFixture = fixture && /other|character|motivation|why-company|excellence/.test(kind) ? 1 : 0;

  // A PERSONALITY QUESTION ANSWERED WITH A RESUME BULLET.
  //
  // His clearest example, and the one the counters above miss completely: asked
  // which empire inspires him, the rejected answer gave the Makerspace Manufacturing
  // Technology Center, 50+ students trained, and a closing pitch about owning
  // end-of-line test at Watney. It names no fixture and no tool, so it scored
  // zero — while being the worst answer in the file. *"The applicant appeared
  // unable to stop selling himself long enough to answer an unusual question
  // normally."*
  //
  // Counted for the kinds whose question is about HIM — `character` (work
  // ethic, failure, what he believes) and `other`. Naming an employer in a
  // "why us" answer is correct and must not be penalised, so those are exempt.
  //
  // `character` was added to essay.mjs on 2026-09-22 and this detector still
  // keyed on `other` alone, which silently switched it off for the empire
  // question — the very answer it was written for. A scorer that quietly stops
  // scoring is worse than no scorer.
  const EMPLOYERS = /\b(applied materials|acme|state university|makerspace|mars rover|manufacturing technology center)\b/gi;
  const WORK_NOUNS = /\b(intern(ship)?|production|tolerances?|machining|cnc|throughput|assembly line|material procurement|final inspection|train(ed|ing)? \d|students)\b/gi;
  //
  // NAMING THE SETTING ONCE IS NOT SELLING, and the first version of this
  // counter could not tell the difference. His own KEPT answer to "when was
  // the hardest you worked in your life" opens "The hardest I have worked was
  // during my internship at Applied Materials" — correct, and it scored 3
  // while the answer he REJECTED scored 1. The metric ranked his own writing
  // below the version he threw away.
  //
  // So the first two work references are free: that is where it happened. It
  // is the ACCUMULATION that marks an answer which cannot stop selling — the
  // rejected empire answer piles up Makerspace, production, procurement, inspection
  // and fifty students before pitching Watney.
  const sellingRaw = /^(other|character)$/.test(kind)
    ? (text.match(EMPLOYERS) || []).length + (text.match(WORK_NOUNS) || []).length
    : 0;
  const selling = Math.max(0, sellingRaw - 2);

  // Density of technical nouns per sentence — an inventory reads as a list
  // whatever its length.
  const perSentence = sentences.length ? inventory / sentences.length : inventory;

  return {
    words,
    sentences: sentences.length,
    inventory,
    inventoryPerSentence: Math.round(perSentence * 100) / 100,
    jdVoice,
    offTopicFixture,
    selling,
    // Weighted so the failures he wrote most about dominate.
    score: Math.round((inventory * 1.0 + jdVoice * 2.0 + offTopicFixture * 3.0
      + selling * 1.5 + Math.max(0, perSentence - 1) * 2.0) * 100) / 100,
  };
}

function main() {
  const json = process.argv.includes('--json');
  const corpus = loadCorpus();
  const pairs = corpus.filter((e) => e.accepted && e.rejected);
  const rows = [];
  for (const e of pairs) {
    const a = scoreAnswer(e.accepted, { kind: e.kind });
    const r = scoreAnswer(e.rejected, { kind: e.kind });
    rows.push({ n: e.n, company: e.company, kind: e.kind, accepted: a, rejected: r, separates: r.score > a.score });
  }
  if (json) { console.log(JSON.stringify({ pairs: rows }, null, 2)); return; }

  console.log(`\nSCORING HIS OWN CORPUS — ${pairs.length} matched pairs (lower is better)\n`);
  console.log('  #  company            kind          accepted   rejected   separates?');
  for (const r of rows) {
    console.log(`  ${String(r.n).padStart(2)} ${String(r.company).slice(0, 18).padEnd(18)} `
      + `${r.kind.padEnd(13)} ${String(r.accepted.score).padStart(8)}   ${String(r.rejected.score).padStart(8)}   `
      + `${r.separates ? 'yes' : 'NO'}`);
  }
  const ok = rows.filter((r) => r.separates).length;
  const avgA = rows.reduce((n, r) => n + r.accepted.score, 0) / rows.length;
  const avgR = rows.reduce((n, r) => n + r.rejected.score, 0) / rows.length;
  console.log(`\n  separates ${ok}/${rows.length} pairs`);
  console.log(`  mean accepted ${avgA.toFixed(2)}   mean rejected ${avgR.toFixed(2)}`);
  console.log(`\n  Also: accepted answers average `
    + `${(rows.reduce((n, r) => n + r.accepted.words, 0) / rows.length).toFixed(0)} words, `
    + `rejected ${(rows.reduce((n, r) => n + r.rejected.words, 0) / rows.length).toFixed(0)}.\n`);
  if (ok < rows.length) {
    console.log('  The pairs it does NOT separate are where the difference is pure judgment —');
    console.log('  information selection and what was left out — which no counter can see.\n');
  }
}

// `process.argv[1]` is undefined when this module is imported by `node -e`,
// and reading `.replace` on it threw — so importing the scorer to score one
// answer crashed before it could. The entry-point check must never be the
// reason a library import fails.
const entry = process.argv[1] ? `file:///${process.argv[1].replace(/\\/g, '/')}` : '';
if (entry && import.meta.url === entry) main();
