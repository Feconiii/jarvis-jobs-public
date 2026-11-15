// jarvis/targeting.test.mjs — who the code is searching for, and the setup
// that writes it. Run: node --test jarvis/targeting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { person, DEFAULT_PERSON, personFrom, parseGradDate, PRESETS, screen, discovery, writing, meta } from './targeting.mjs';
import { QUESTIONS, validate, withDefaults, profileYaml, applyProfileYaml, preferencesMd } from './setup.mjs';
import { excluded, secrets, sharedTestScript, PERSONAL_TESTS, scrubText, forbiddenIn, SHARE_FILES } from './share-export.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FINANCE = path.join(HERE, 'presets', 'finance-data', 'test-profile.yml');

const asPerson = (profile, expr) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import * as t from './jarvis/targeting.mjs'; console.log(JSON.stringify(${expr}));`],
{ cwd: ROOT, env: { ...process.env, JARVIS_PROFILE: profile }, encoding: 'utf8' }));

test('A TEST RUN IS ALWAYS THE DEFAULT PERSON, whoever is set up on the machine', () => {
  assert.equal(person, DEFAULT_PERSON);
  assert.equal(person.preset, 'hardware-engineering');
  assert.equal(screen, PRESETS['hardware-engineering'].screen);
  assert.ok(discovery && writing && meta);
});

test('JARVIS_PROFILE loads a second person and their preset', () => {
  const p = asPerson(FINANCE, 't.person');
  assert.equal(p.fullName, 'Test Analyst');
  assert.equal(p.preset, 'finance-data');
  assert.equal(p.workAuth, 'citizen');
  assert.equal(p.needsSponsorship, false);
  assert.equal(p.usPerson, true);
  assert.deepEqual(p.gradDate, { year: 2026, month: 5 });
  assert.equal(p.gradLabel, 'May 2026');
  assert.equal(p.salaryFloor, 65000);
  assert.equal(p.llm, 'codex');
  assert.equal(asPerson(FINANCE, 't.meta.id'), 'finance-data');
});

test('an older profile with only sponsorship_needed / itar_eligible still reads right', () => {
  assert.equal(personFrom({ location: { sponsorship_needed: true } }).workAuth, 'f1');
  assert.equal(personFrom({ location: { sponsorship_needed: false, itar_eligible: true } }).workAuth, 'citizen');
  assert.equal(personFrom({ location: { sponsorship_needed: false } }).usPerson, false);
  assert.equal(personFrom({ targeting: { preset: 'no-such-preset' } }).preset, 'hardware-engineering');
});

test('graduation dates in the shapes people write them', () => {
  assert.deepEqual(parseGradDate('May 2027'), { year: 2027, month: 5 });
  assert.deepEqual(parseGradDate('Dec. 2026'), { year: 2026, month: 12 });
  assert.deepEqual(parseGradDate('2026-06'), { year: 2026, month: 6 });
  assert.deepEqual(parseGradDate('5/2026'), { year: 2026, month: 5 });
  assert.equal(parseGradDate('soon'), null);
});

test('every preset has the same shape', () => {
  const keys = (o) => Object.keys(o).sort();
  const [a, b] = Object.values(PRESETS);
  for (const area of ['screen', 'discovery', 'writing']) assert.deepEqual(keys(b[area]), keys(a[area]), `${area} keys differ`);
  for (const p of Object.values(PRESETS)) {
    assert.ok(p.meta.label && p.meta.defaultTargetRoles.length && p.meta.starterCompanies.length);
  }
});

const ANSWERS = {
  full_name: 'Test Analyst', email: 'analyst@example.com', phone: '+1 (555) 010-0000',
  city: 'Seattle', state: 'WA', school: 'Example State University',
  degree: 'Bachelor of Business Administration', major: 'Finance', graduation: 'May 2026',
  preset: 'finance-data', work_authorization: 'citizen', salary_minimum: '$65,000',
};

test('setup refuses an answers file missing what it needs', () => {
  const errs = validate(withDefaults({ full_name: 'X' }));
  assert.ok(errs.some((e) => e.startsWith('email')));
  assert.ok(errs.some((e) => e.startsWith('preset')));
  assert.ok(validate(withDefaults({ ...ANSWERS, graduation: 'eventually' })).some((e) => e.startsWith('graduation')));
  assert.ok(validate(withDefaults({ ...ANSWERS, work_authorization: 'maybe' })).some((e) => e.startsWith('work_authorization')));
  assert.deepEqual(validate(withDefaults(ANSWERS)), []);
  assert.ok(QUESTIONS.every((q) => q.key && q.ask));
});

test('the profile setup writes is read back as the same person', () => {
  const a = withDefaults(ANSWERS);
  const p = personFrom(yaml.load(profileYaml(a)));
  assert.equal(p.fullName, 'Test Analyst');
  assert.equal(p.preset, 'finance-data');
  assert.equal(p.usPerson, true);
  assert.equal(p.gradLabel, 'May 2026');
  assert.equal(p.llm, 'codex');
  assert.deepEqual(yaml.load(profileYaml(a)).target_roles.primary, PRESETS['finance-data'].meta.defaultTargetRoles);
});

test('the form answers setup writes say what the person said', () => {
  const tpl = readFileSync(path.join(ROOT, 'config', 'apply-profile.example.yml'), 'utf8');
  const doc = yaml.load(applyProfileYaml(withDefaults(ANSWERS), tpl));
  assert.equal(doc.identity.state, 'Washington');
  assert.equal(doc.identity.preferred_full_name, 'Test Analyst');
  assert.equal(doc.answers.require_sponsorship, 'No');
  assert.equal(doc.answers.us_person, 'Yes');
  assert.equal(doc.education.degree_level, "Bachelor's");
  assert.equal(doc.documents.resume_path, 'output/jarvis-resumes/total-experience/Test Analyst Resume.pdf');
  assert.deepEqual(doc.eeo, { gender: '', hispanic: '', race: '', veteran: '', disability: '' }, 'self-ID is never filled for them');
  const f1 = yaml.load(applyProfileYaml(withDefaults({ ...ANSWERS, work_authorization: 'f1' }), tpl));
  assert.equal(f1.answers.require_sponsorship, 'Yes');
  assert.match(f1.answers.visa_status_note, /F-1/);
});

test('the starter preferences are the preset’s', () => {
  const md = preferencesMd(withDefaults({ ...ANSWERS, preferred_cities: 'Seattle, New York' }));
  assert.match(md, /^# Test's job preferences/);
  assert.match(md, /prefer in location Seattle, New York/);
  for (const r of PRESETS['finance-data'].meta.starterPreferences) assert.ok(md.includes(r));
});

test('THE SHARE EXPORT LEAVES OUT HIS OWN MATERIAL', () => {
  for (const f of ['voice-dna.md', 'jarvis/preferences.md', 'jarvis/resume-pool.json', 'jarvis/FAULTS.md',
    'jarvis/RESUME-AUDIT-2026-09-22.md', 'portfolio/build.mjs', 'graphify-out/GRAPH_REPORT.md',
    '.claude/skills/outreach/SKILL.md', 'Piston.SLDPRT', 'CLAUDE.md', 'jarvis/COMMANDS.md', 'jarvis/COVERAGE.md',
    'jarvis/OUTREACH.md', 'jarvis/notes/discovery-progress.md']) assert.ok(excluded(f), f);
  for (const f of ['jarvis/triage.mjs', 'jarvis/presets/finance-data/screen.mjs', 'providers/greenhouse.mjs',
    'package.json', 'config/profile.example.yml', 'jarvis/RESUME-RULES.md']) assert.ok(!excluded(f), f);
});

const SCRIPTS = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
// In an exported copy the suite is already the shared one (and has no share script).
test('the exported suite drops only the tests that check his own files', { skip: !SCRIPTS['jarvis:share'] && 'this is an exported copy' }, () => {
  const script = SCRIPTS['jarvis:test'];
  const all = script.split('&&').map((s) => s.trim());
  const kept = sharedTestScript(script).split('&&').map((s) => s.trim());
  assert.equal(all.length - kept.length, PERSONAL_TESTS.length, 'every listed personal test is in the suite, once');
  assert.ok(kept.includes('node jarvis/triage.test.mjs'));
  assert.ok(kept.includes('node --test jarvis/targeting.test.mjs'));
  assert.ok(!kept.includes('node jarvis/resume.test.mjs'));
  assert.ok(kept.includes('node jarvis/resume-for-job.test.mjs') === false);
  for (const from of Object.keys(SHARE_FILES)) assert.ok(existsSync(path.join(ROOT, from)), `${from} is what the export writes`);
});

test('an exported copy that ships the LinkedIn MCP ships its read-only guard too', () => {
  if (!existsSync(path.join(ROOT, '.mcp.json')) || !/linkedin/.test(readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'))) return;
  // Here the share file; in an exported copy, the settings file it became.
  const from = SCRIPTS['jarvis:share'] ? Object.entries(SHARE_FILES).find(([, tos]) => tos.includes('.claude/settings.json'))?.[0] : '.claude/settings.json';
  assert.ok(from && existsSync(path.join(ROOT, from)), 'the export writes a .claude/settings.json');
  const hooks = JSON.parse(readFileSync(path.join(ROOT, from), 'utf8')).hooks?.PreToolUse || [];
  assert.ok(hooks.some((h) => h.matcher === 'mcp__linkedin__.*' && h.hooks.some((c) => c.command.includes('jarvis/linkedin-mcp-guard.mjs'))));
});

test('a public export renames by the rules, in order, and names what survived', () => {
  const scrub = {
    replace: [['Pat Example Jones', 'Sam Sample'], ['Pat', 'Sam']],
    regex: [[/\bJo\b/g, 'Lee']],
    forbid: [/pat(?! road)/i, /\bjo\b/i],
  };
  assert.equal(scrubText('Pat Example Jones wrote to Jo, and Pat again.', scrub), 'Sam Sample wrote to Lee, and Sam again.');
  assert.equal(scrubText('Joseph and Jones keep their names', scrub), 'Joseph and Jones keep their names');
  assert.deepEqual(forbiddenIn('Sam lives on pat road', scrub), []);
  assert.equal(forbiddenIn('signed, pat', scrub).length, 1);
});

test('the export reads the contact details to refuse from the user’s own files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-share-'));
  const cfg = path.join(dir, 'config'); const data = path.join(dir, 'data', 'jarvis');
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(cfg)},{recursive:true});require('fs').mkdirSync(${JSON.stringify(data)},{recursive:true})`]);
  writeFileSync(path.join(cfg, 'profile.yml'), 'candidate:\n  email: "someone@example.org"\n  phone: "+1 (206) 123-4567"\n');
  writeFileSync(path.join(data, 'apply-profile.yml'), 'identity:\n  address_line1: "1 Real Road"\n  phone: "+1 (555) 010-0000"\n');
  const s = secrets(dir);
  assert.ok(s.includes('someone@example.org'));
  assert.ok(s.includes('1 Real Road'));
  assert.ok(s.includes('phone:2061234567'));
  assert.ok(!s.some((x) => x.includes('5550100000')), 'a 555 placeholder is not a secret');
});
