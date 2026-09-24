#!/usr/bin/env node
// jarvis/jd-terms.test.mjs — the second opinion on coverage.
//
// The tailor reports its own coverage: the model paraphrases the posting's
// requirements and then marks whether it met them. Over the 50 most recently
// SENT resumes that self-report claimed 83.7%; measured against the nouns the
// postings actually use it was 49%. This module is the measurement that cannot
// be talked up, so what it must never do is quietly stop measuring.
import { termsIn, coverage, coverageLine, TERMS } from './jd-terms.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

console.log('🧪 jd-terms: what the posting names, and what the page names back');

ok('the vocabulary is substantial', Object.keys(TERMS).length >= 60, `${Object.keys(TERMS).length} terms`);

// It must find the things a real posting names.
const JD = `We are hiring a Manufacturing Engineer. You will use SolidWorks and GD&T to
  design fixtures, run SPC and DOE on the line, program Allen-Bradley PLCs, and
  own IQ/OQ/PQ validation. Experience with CNC machining and cleanroom assembly
  preferred. You will drive yield improvement and work with suppliers.`;
const found = termsIn(JD);
for (const t of ['SolidWorks', 'GD&T', 'SPC', 'DOE', 'PLC', 'IQ/OQ/PQ', 'CNC machining', 'Cleanroom', 'Yield', 'Supplier / vendor', 'Fixture / tooling']) {
  ok(`it finds "${t}"`, found.has(t));
}

// VAGUENESS IS NOT A REQUIREMENT. The whole point is to count what can be
// checked — a posting saying "ownership" and "fast-paced" has named nothing.
const FLUFF = 'You are a self-starter who thrives in a fast-paced environment and takes ownership, collaborating cross-functionally to drive impact.';
eq('prose with no concrete noun names nothing', termsIn(FLUFF).size, 0);

// The two directions, which are the two halves of his instruction.
const RESUME = 'Designed fixtures in SolidWorks with GD&T. CNC machining and welding. Built a RoboDK cell.';
const c = coverage(JD, RESUME);
ok('it counts what the posting named', c.named >= 10, `${c.named}`);
ok('covered holds only what BOTH say', c.covered.every((t) => termsIn(JD).has(t) && termsIn(RESUME).has(t)));
ok('missing holds what the posting asked for and the page does not say',
  c.missing.includes('SPC') && c.missing.includes('PLC'), c.missing.join(', '));
ok('unmatched holds what the page carries and the posting never asked for',
  c.unmatched.includes('RoboDK'), c.unmatched.join(', '));
ok('the percentage is of what the POSTING named', c.pct === Math.round((c.covered.length / c.named) * 100));

// A MARKETING PAGE THAT NAMES NOTHING IS NOT 0% COVERED.
// Scoring it zero would put a false failure on a resume that may fit perfectly;
// 13 of the 50 audited postings were this kind of page.
eq('a posting that names nothing scores null, not zero', coverage(FLUFF, RESUME).pct, null);
eq('and produces no report line', coverageLine(FLUFF, RESUME), '');

ok('a real posting produces a line naming what is missing',
  /names \d+\/\d+ of the terms this posting uses/.test(coverageLine(JD, RESUME)));
ok('…and says how much the page carries unasked',
  /carries \d+ term\(s\) the posting never asks for/.test(coverageLine(JD, RESUME)));

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
