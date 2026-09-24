#!/usr/bin/env node
// jarvis/proofread.test.mjs — literal mistakes on the page.
//
// His words, 2026-09-23: "im conerned with layout issues and literal mistakes
// and grammar in the resume, 6 d0f should be 6-dof". The failing cases below
// are verbatim from the fifty most recently SENT resumes (proofread the same
// day); the passing ones are his current pool, which must stay clean because a
// mistake there repeats on every page that uses the bullet.
import { proofread, proofreadSpec } from './proofread.mjs';
import { loadPool, buildSpec } from './resume-variants.mjs';
import { checkRewrite } from './resume-tailor.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const flags = (name, text, re, opts) => {
  const got = proofread(text, opts);
  ok(name, got.some((p) => re.test(p)), `got: ${JSON.stringify(got)}`);
};
const clean = (name, text, opts) => {
  const got = proofread(text, opts);
  ok(name, got.length === 0, `got: ${JSON.stringify(got)}`);
};

console.log('🧪 proofread: what a proofreader would circle');

// ── what went out, and must not again ───────────────────────────────
flags('"6 DOF" is a compound modifier', 'Designed and built a 6 DOF robotic arm with serial-bus servos.', /hyphenated/);
flags('a bullet with no period, on a page where the rest have one',
  'Performed time studies and fault analysis on robotic assembly line; identified a magazine feeding issue reducing jams by 70%', /period/);
flags('…and the issue does not reduce the jams, its fix does',
  'Identified a magazine feeding issue reducing jams by 70%.', /say what the fix did/);
flags('…with a comma too', 'Identified a magazine feeding issue, reducing jams by 70%.', /say what the fix did/);
flags('a hyphen for a date range', 'GPA: 3.85 | Dean\'s List: Fall 2023 - Spring 2026', /en dash/, { kind: 'text' });
flags('a doubled word', 'Designed the the fixture in Autodesk Inventor.', /repeats a word/);
flags('a double space', 'Designed a fixture  in Autodesk Inventor.', /double space/);
flags('a space before a comma', 'Designed a fixture , then validated it.', /space before/);
flags('unbalanced parentheses', 'Deployed Autonomous Mobile Robots (AMRs for cleanroom handling.', /parentheses/);
flags('"a" before a vowel', 'Installed a UR robot into a automated leak-testing cell.', /"an automated"/);
flags('"an" before a consonant', 'Built an robotic arm.', /"a robotic"/);
flags('"a" before an acronym said with a vowel', 'Ran a FEA study on the piston.', /"an FEA"/);
flags('a lowercase start', 'designed a fixture in Autodesk Inventor.', /lowercase/);

// ── and what is right, which must not be flagged ────────────────────
clean('"a UR" is right — you-are', 'Installed a UR collaborative robot into an automated leak-testing cell.');
clean('"a Universal Robots" is right', 'Programmed and validated a Universal Robots collaborative robot in RoboDK.');
clean('"an IIoT" is right', 'Implemented an IIoT solution by integrating pressure-decay testers.');
clean('"a high-precision" is right', 'Machined a high-precision component within specified tolerances.');
clean('"a one-page" and "a user" are right', 'Wrote a one-page guide for a user of the machine.');
clean('an en dash range is right', 'Dean\'s List: Fall 2023 – Spring 2026', { kind: 'text' });
clean('the fixed jam bullet is right',
  'Performed time studies and fault analysis on a robotic assembly line; identified a magazine feeding issue whose fix reduced jams by 70%.');
clean('"6-DOF" is right', 'Designed and built a 6-DOF robotic arm with serial-bus servos.');
clean('a list is not a sentence', 'CAD/CAE: SolidWorks, Autodesk Inventor, AutoCAD', { kind: 'text' });

// ── his pool is clean, and every base built from it ─────────────────
const pool = loadPool();
const dirty = [];
for (const [o, org] of Object.entries(pool.orgs)) {
  for (const [k, b] of Object.entries(org.bullets)) {
    for (const f of ['text', 'short', 'long']) for (const p of b[f] ? proofread(b[f]) : []) dirty.push(`${o}.${k} ${f}: ${p}`);
  }
}
for (const [k, p] of Object.entries(pool.projects)) {
  for (const f of ['text', 'short']) for (const x of p[f] ? proofread(p[f]) : []) dirty.push(`project.${k} ${f}: ${x}`);
}
ok('every bullet in the pool is clean — a mistake there is on every page that uses it', dirty.length === 0, dirty.join('\n    '));
for (const fam of ['automation', 'manufacturing', 'mechanical', 'total-experience']) {
  const found = proofreadSpec(buildSpec(fam, pool));
  ok(`the ${fam} base is clean`, found.length === 0, found.map((f) => `${f.where}: ${f.problem}`).join('; '));
}

// ── the writer's rewrite is refused for one, and his wording stands ──
const src = 'Performed time studies and fault analysis on a robotic assembly line; identified a magazine feeding issue whose fix reduced jams by 70%.';
const bad = checkRewrite({ text: 'Performed time studies and fault analysis on a robotic assembly line; identified a magazine feeding issue reducing jams by 70%.', source: src });
ok('a rewrite with a literal mistake is refused', !bad.ok && bad.problems.some((p) => /fix did/.test(p)), JSON.stringify(bad.problems));
const good = checkRewrite({ text: src, source: src });
ok('…and a clean one is not', good.ok, JSON.stringify(good.problems));

// ── "commissioning": never the cobot or AMR work, fine elsewhere (2026-09-23) ──
const robo = 'Programmed and validated a Universal Robots collaborative robot in RoboDK for automated leak testing.';
const com = checkRewrite({ text: 'Programmed, validated and commissioned a Universal Robots collaborative robot in RoboDK for automated leak testing.', source: robo, label: 'amat.robodk' });
ok('the cobot work is never called commissioning', !com.ok && com.problems.some((p) => /commissioning/.test(p)), JSON.stringify(com.problems));
const amr = checkRewrite({ text: 'Supported commissioning of Autonomous Mobile Robots for cleanroom material handling.', source: 'Supported deployment and validation of Autonomous Mobile Robots for cleanroom material handling.', label: 'amat.amr' });
ok('…nor the AMR rollout', !amr.ok && amr.problems.some((p) => /commissioning/.test(p)), JSON.stringify(amr.problems));
const iiot = checkRewrite({ text: 'Supported commissioning of pressure-decay testers with Tulip Edge Devices.', source: 'Supported deployment of pressure-decay testers with Tulip Edge Devices.', label: 'amat.iiot' });
ok('…but other work may use the word', !iiot.problems.some((p) => /commissioning/.test(p)), JSON.stringify(iiot.problems));

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
