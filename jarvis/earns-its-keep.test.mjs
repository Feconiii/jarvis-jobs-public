#!/usr/bin/env node
// jarvis/earns-its-keep.test.mjs — the objective bar for a tailored resume.
//
// His instruction, 2026-09-22: "proceed until you find fixes that make a resume
// objectively perfect … everything on resume should earn its keep".
//
// The definition this module implements, and what these tests pin:
//
//   PERFECT = covers everything the posting names AND he can prove.
//
// What else the page carries is reported, never failed — his correction of
// 2026-09-23: "unrequested terms are not necessarily a bad thing". The part that makes it
// honest — and the part most likely to be "simplified" away by someone who does
// not know why it is there — is the THIRD category: a requirement the posting
// names that nothing in cv.md proves is reported as HIS gap and never counted
// against the page. Counting it would push the writer toward bridging to
// experience he does not have, which is the one thing this project must not do.
import { judge, keepReport, poolTerms } from './earns-its-keep.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

console.log('🧪 earns-its-keep: the bar, and why a gap in his CV is not a fault on the page');

const have = poolTerms();
ok('the pool yields a real vocabulary of what he can prove', have.size >= 25, `${have.size} terms`);
ok('…including things he has actually done', have.has('SolidWorks') && have.has('CNC machining'));

// A posting naming only things he can prove, and a page that proves them.
const JD_PROVABLE = 'You will use SolidWorks and GD&T, run CNC machining, and apply Six Sigma.';
const GOOD = 'Designed fixtures in SolidWorks with GD&T. CNC machining of precision parts. Six Sigma trained.';
const g = judge(JD_PROVABLE, GOOD);
ok('a page covering everything provable passes the first check', g.checks[0].ok, g.checks[0].detail);
eq('and nothing is missed', g.missed, []);

// The same posting, a page that leaves one out.
const THIN = 'Designed fixtures in SolidWorks with GD&T.';
const t = judge(JD_PROVABLE, THIN);
ok('a page that omits provable evidence FAILS', !t.checks[0].ok);
ok('…and names what it missed', t.missed.includes('CNC machining') || t.missed.includes('Six Sigma'), t.missed.join(', '));

// THE PART THAT KEEPS IT HONEST.
const JD_UNPROVABLE = 'You will program Allen-Bradley PLCs and configure TCP/IP networks, and use SolidWorks.';
const u = judge(JD_UNPROVABLE, 'Designed fixtures in SolidWorks.');
ok('a requirement nothing in cv.md proves is reported separately',
  u.unprovable.includes('PLC') || u.unprovable.includes('Networking'), u.unprovable.join(', '));
ok('…and is NOT counted as a miss on the page', !u.missed.includes('PLC') && !u.missed.includes('Networking'),
  `missed was: ${u.missed.join(', ')}`);
ok('so a page can still pass a posting he is only partly qualified for', u.checks[0].ok,
  'otherwise the writer is pushed to bridge to experience he does not have');
ok('and the report says whose gap it is', /not his to cover/.test(keepReport(JD_UNPROVABLE, 'Designed fixtures in SolidWorks.')));

// Excess is reported, not failed (2026-09-23).
const BLOATED = 'SolidWorks. GD&T. CNC machining. Six Sigma. '
  + 'Also RoboDK, Universal Robots, machine vision, Node-RED, Arduino, Linux, Python, '
  + 'welding, sheet metal, 3D printing, cleanroom, etch, deposition, thermal, FEA, Ansys.';
const b = judge(JD_PROVABLE, BLOATED);
ok('a page that covers the posting and carries more PASSES', b.ok, JSON.stringify(b.checks));
ok('…and the extra is still counted for him to read', b.unasked.length > 10, `${b.unasked.length}`);
ok('…and printed as information, not a failure', /also on the page, not named by the posting/.test(keepReport(JD_PROVABLE, BLOATED)));

// A page that covers nothing must never look perfect by carrying nothing.
const n = judge(JD_PROVABLE, 'I am a hard worker who values ownership.');
ok('covering nothing is not a pass', !n.ok, JSON.stringify(n.checks.map((c) => c.ok)));

// A posting with no checkable requirement has nothing to judge.
eq('a marketing posting produces no report', keepReport('We value impact and ownership.', GOOD), '');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
