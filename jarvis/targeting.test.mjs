// jarvis/targeting.test.mjs — who the code is searching for, and the setup
// that writes it. Run: node --test jarvis/targeting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { person, DEFAULT_PERSON, personFrom, parseGradDate, PRESETS, screen, discovery, writing, meta, AI_PLANS, USAGE } from './targeting.mjs';
import { QUESTIONS, validate, withDefaults, profileYaml, applyProfileYaml, preferencesMd, summary, updateAll } from './setup.mjs';
import { parseRules } from './prefs.mjs';
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

// The interview's plan, goals and working style (2026-11-14).
const FULL = {
  ...ANSWERS, llm: 'claude', ai_plan: 'claude-api', seniority: 'entry', work_mode: 'remote',
  start_date: 'June 2026', target_companies: 'Acme Capital, Beta Bank', avoid_companies: 'Gamma Corp',
  dealbreakers: 'no night shifts', check_in: 'weekly', applications_per_week: '8', help_level: 'fill_only',
};

test('THE AI PLAN SETS HOW MUCH THE AI RUNS: usage, the model ladder, and never Opus', () => {
  const p = personFrom(yaml.load(profileYaml(withDefaults(FULL))));
  assert.equal(p.plan, 'claude-api');
  assert.equal(p.usage, 'light');
  assert.equal(p.models, 'haiku,sonnet', 'pay-per-use tries the cheaper model first');
  assert.equal(p.helpLevel, 'fill_only');
  assert.equal(personFrom(yaml.load(profileYaml(withDefaults({ ...FULL, ai_plan: 'claude-max' })))).usage, 'standard');
  assert.equal(personFrom({ targeting: { plan: 'claude-max', models: 'opus,sonnet' } }).models, 'sonnet', 'a hand-written Opus is dropped');
  // A profile from before plans existed runs exactly as before.
  const old = personFrom({ targeting: { preset: 'finance-data' } });
  assert.equal(old.usage, 'standard');
  assert.equal(old.models, '');
  assert.equal(old.helpLevel, 'fill_and_write');
  assert.deepEqual({ ...USAGE.standard }, { want: 20, target: 50, maxRead: 300, triggerMaxFile: 10 }, 'standard is the old fixed numbers');
  assert.ok(USAGE.light.want < USAGE.standard.want && USAGE.light.maxRead < USAGE.standard.maxRead);
  for (const [k, v] of Object.entries(AI_PLANS)) assert.ok(USAGE[v.usage], `${k} has a usage level`);
});

test('a plan for the other assistant is refused; a codex user defaults to a ChatGPT plan', () => {
  assert.ok(validate(withDefaults({ ...FULL, llm: 'codex', ai_plan: 'claude-max' })).some((e) => e.startsWith('ai_plan')));
  assert.equal(withDefaults(ANSWERS).ai_plan, 'chatgpt-plus');
  assert.deepEqual(validate(withDefaults(FULL)), []);
  assert.ok(validate(withDefaults({ ...FULL, applications_per_week: 'lots' })).some((e) => e.startsWith('applications_per_week')));
});

test('the goals and working style are written, and the companies and remote become rules the scorer reads', () => {
  const doc = yaml.load(profileYaml(withDefaults(FULL)));
  assert.deepEqual(doc.goals, { seniority: 'entry', work_mode: 'remote', start_date: 'June 2026',
    target_companies: ['Acme Capital', 'Beta Bank'], avoid_companies: ['Gamma Corp'], dealbreakers: 'no night shifts' });
  assert.deepEqual(doc.working_style, { check_in: 'weekly', applications_per_week: 8, help_level: 'fill_only' });
  const md = preferencesMd(withDefaults(FULL));
  assert.match(md, /^want Acme Capital, Beta Bank in company$/m);
  assert.match(md, /^avoid Gamma Corp in company$/m, 'a company to skip is ranked down, never hidden');
  assert.match(md, /^prefer in location remote$/m);
  assert.match(md, /^# Dealbreakers in their words.*no night shifts/m, 'their words wait for a rule they agree to');
  const rules = parseRules(md);
  const company = rules.filter((r) => /company/.test(JSON.stringify(r)));
  assert.ok(company.length >= 2, `the company rules parse: ${JSON.stringify(rules.slice(-4))}`);
  assert.doesNotMatch(JSON.stringify(rules), /night shifts/, 'the comment is not a rule');
});

test('the summary they confirm says what the plan will do', () => {
  const s = summary(withDefaults(FULL));
  assert.match(s, /Claude Code on an API key/);
  assert.match(s, new RegExp(`up to ${USAGE.light.want} picks a run and keeps ${USAGE.light.target} open`));
  assert.match(s, /Acme Capital, Beta Bank/);
  assert.match(s, /8 applications a week/);
});

test('A RE-RUN WITH --update KEEPS WHAT WAS ADDED SINCE and backs up what it changes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-update-'));
  const paths = { profile: path.join(dir, 'profile.yml'), apply: path.join(dir, 'apply.yml'), prefs: path.join(dir, 'prefs.md'),
    portals: path.join(dir, 'portals.yml'), applyExample: path.join(ROOT, 'config', 'apply-profile.example.yml') };
  const first = withDefaults(ANSWERS);
  const prof = yaml.load(profileYaml(first));
  prof.narrative.headline = 'Analyst who reconciles';
  writeFileSync(paths.profile, yaml.dump(prof));
  const ap = yaml.load(applyProfileYaml(first, readFileSync(paths.applyExample, 'utf8')));
  ap.work_experience = [{ title: 'Intern', company: 'Somewhere' }];
  writeFileSync(paths.apply, yaml.dump(ap));
  writeFileSync(paths.prefs, `${preferencesMd(first)}never commission only\n`);
  updateAll(withDefaults({ ...FULL, city: 'Boston', state: 'MA' }), { paths, log: () => {} });
  const p2 = yaml.load(readFileSync(paths.profile, 'utf8'));
  assert.equal(p2.narrative.headline, 'Analyst who reconciles', 'narrative kept');
  assert.equal(p2.targeting.plan, 'claude-api', 'new answers in');
  assert.equal(p2.candidate.location, 'Boston, MA');
  const a2 = yaml.load(readFileSync(paths.apply, 'utf8'));
  assert.deepEqual(a2.work_experience, [{ title: 'Intern', company: 'Somewhere' }], 'work history kept');
  assert.equal(a2.identity.city, 'Boston');
  const md = readFileSync(paths.prefs, 'utf8');
  assert.match(md, /^never commission only$/m, 'a hand-added rule stays');
  assert.match(md, /^want Acme Capital, Beta Bank in company$/m);
  assert.equal(md.split('want Acme Capital').length, 2, 'a rule is never added twice');
  updateAll(withDefaults(FULL), { paths, log: () => {} });
  assert.equal(readFileSync(paths.prefs, 'utf8').split('want Acme Capital').length, 2);
  assert.ok(readdirSync(dir).some((f) => /^profile\.yml\.bak-/.test(f)) && readdirSync(dir).some((f) => /^apply\.yml\.bak-/.test(f)));
});

test('WITH NO PROFILE, A SESSION IS TOLD TO START THE INTERVIEW (the SessionStart hook)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-hook-'));
  mkdirSync(path.join(dir, 'jarvis'));
  copyFileSync(path.join(HERE, 'setup-check.mjs'), path.join(dir, 'jarvis', 'setup-check.mjs'));
  const out = execFileSync(process.execPath, [path.join(dir, 'jarvis', 'setup-check.mjs'), '--hook'], { encoding: 'utf8' });
  assert.match(out, /JARVIS FIRST RUN/);
  assert.match(out, /jarvis-setup\/SKILL\.md/);
  mkdirSync(path.join(dir, 'config'));
  writeFileSync(path.join(dir, 'config', 'profile.yml'), 'candidate:\n  full_name: Someone\n');
  const later = execFileSync(process.execPath, [path.join(dir, 'jarvis', 'setup-check.mjs'), '--hook'], { encoding: 'utf8' });
  assert.doesNotMatch(later, /FIRST RUN/);
  assert.match(later, /no AI plan recorded/, 'an older profile is asked for its plan');
  const settings = JSON.parse(readFileSync(path.join(ROOT, 'share', 'claude-settings.json'), 'utf8'));
  assert.match(JSON.stringify(settings.hooks.SessionStart), /setup-check\.mjs\\" --hook/, 'the shipped settings run it');
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
