#!/usr/bin/env node
/**
 * jarvis/setup.mjs: first run for a new person.
 *
 * Asks who they are and what they are looking for, then writes the files the
 * rest of Jarvis reads:
 *
 *   config/profile.yml              name, school, degree, graduation, work
 *                                   authorization, pay floor, cities, preset, AI
 *   data/jarvis/apply-profile.yml   form answers (from config/apply-profile.example.yml)
 *   portals.yml                     empty company list, ready for the board finder
 *   jarvis/preferences.md           the preset's starter rules
 *   cv.md                           copied from the file they point at, if any
 *
 * Two ways to run it:
 *
 *   npm run jarvis:setup                         asks in the terminal
 *   node jarvis/setup.mjs --answers <file.json>  no questions; an assistant
 *                                                interviewed them and wrote the file
 *
 * It never overwrites a file that exists unless --force is given, and then it
 * keeps the old one beside it as <name>.bak-<date>. `--update` re-runs on an
 * existing setup and keeps what was added since (updateAll). `--dry-run` prints
 * the summary of the answers and writes nothing, so they can confirm it first.
 *
 * After writing, `--find-boards` (or answering yes) runs the board finder on the
 * preset's starter companies so the first scan has something to read.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import yaml from 'js-yaml';

import { PRESETS, WORK_AUTH, AI_PLANS, USAGE, parseGradDate, personFrom } from './targeting.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const P = {
  profile: path.join(ROOT, 'config', 'profile.yml'),
  applyExample: path.join(ROOT, 'config', 'apply-profile.example.yml'),
  apply: path.join(ROOT, 'data', 'jarvis', 'apply-profile.yml'),
  portals: path.join(ROOT, 'portals.yml'),
  prefs: path.join(HERE, 'preferences.md'),
  cv: path.join(ROOT, 'cv.md'),
};
const DEFAULT_PATHS = P;

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const fullState = (s) => STATES[String(s || '').trim().toUpperCase()] || String(s || '').trim();

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);

const SENIORITY = ['internship', 'new_grad', 'entry', 'experienced'];
const WORK_MODES = ['onsite', 'hybrid', 'remote', 'any'];
const CHECK_INS = ['daily', 'few_times_a_week', 'weekly'];
const HELP_LEVELS = ['fill_only', 'fill_and_write'];

/** The questions, in order. `key` is the answers-file field. */
export const QUESTIONS = [
  { key: 'full_name', ask: 'Your name as you go by it (resume header)', required: true },
  { key: 'legal_first_name', ask: 'Legal first (given) name, as on your ID', def: (a) => a.full_name.split(/\s+/)[0] },
  { key: 'legal_last_name', ask: 'Legal last name', def: (a) => a.full_name.split(/\s+/).slice(-1)[0] },
  { key: 'email', ask: 'Email', required: true },
  { key: 'phone', ask: 'Phone' },
  { key: 'city', ask: 'City you live in' },
  { key: 'state', ask: 'State (e.g. WA)' },
  { key: 'postal_code', ask: 'ZIP code' },
  { key: 'linkedin', ask: 'LinkedIn URL (blank if none)' },
  { key: 'portfolio', ask: 'Portfolio / website (blank if none)' },
  { key: 'school', ask: 'School', required: true },
  { key: 'degree', ask: 'Degree (e.g. Bachelor of Science, Bachelor of Business Administration)', required: true },
  { key: 'degree_level', ask: 'Degree level: bachelor, master or phd', def: () => 'bachelor', choices: ['bachelor', 'master', 'phd'] },
  { key: 'major', ask: 'Major(s), comma separated', required: true },
  { key: 'graduation', ask: 'Graduation (e.g. May 2027)', required: true, check: (v) => !!parseGradDate(v) || 'write it like "May 2027"' },
  { key: 'gpa', ask: 'GPA (blank to leave it off)' },
  { key: 'preset', ask: `Field: ${Object.keys(PRESETS).join(' or ')}`, required: true, choices: Object.keys(PRESETS) },
  { key: 'target_roles', ask: 'Target job titles, comma separated', def: (a) => (PRESETS[a.preset]?.meta.defaultTargetRoles || []).join(', ') },
  { key: 'work_authorization', ask: `Work authorization: ${Object.keys(WORK_AUTH).join(', ')}`, required: true, choices: Object.keys(WORK_AUTH) },
  { key: 'citizenship_country', ask: 'Country of citizenship', def: (a) => (a.work_authorization === 'citizen' ? 'United States' : '') },
  { key: 'salary_minimum', ask: 'Lowest salary you would take (e.g. $70,000)', def: () => '$70,000' },
  { key: 'salary_target', ask: 'Salary you are aiming for', def: (a) => a.salary_minimum },
  { key: 'preferred_cities', ask: 'Cities you would most like, comma separated (blank = anywhere in the US)' },
  { key: 'relocate', ask: 'Willing to relocate? yes/no', def: () => 'yes', choices: ['yes', 'no'] },
  // The job they want, past the title (stored under `goals:` in config/profile.yml).
  { key: 'seniority', ask: 'Level you are applying at: internship, new_grad, entry or experienced', def: () => 'new_grad', choices: SENIORITY },
  { key: 'work_mode', ask: 'On-site, hybrid or remote: onsite, hybrid, remote or any', def: () => 'any', choices: WORK_MODES },
  { key: 'start_date', ask: 'When you want to start (e.g. June 2027, as soon as possible)' },
  { key: 'target_companies', ask: 'Companies you most want, comma separated (blank = none in particular)' },
  { key: 'avoid_companies', ask: 'Companies to stay away from, comma separated' },
  { key: 'dealbreakers', ask: 'Dealbreakers in your words (e.g. no night shifts, nothing in sales)' },
  // The assistant and its plan: the plan sets how much the AI runs (targeting.mjs AI_PLANS).
  { key: 'llm', ask: 'Which AI does this machine have: claude or codex', def: () => 'codex', choices: ['claude', 'codex'] },
  { key: 'ai_plan', ask: `Which plan you have for it: ${Object.keys(AI_PLANS).join(', ')}`,
    def: (a) => (a.llm === 'claude' ? 'claude-pro' : 'chatgpt-plus'), choices: Object.keys(AI_PLANS),
    check: (v, a) => { const p = AI_PLANS[String(v).toLowerCase()]; return !p || !p.llm || !a.llm || p.llm === a.llm || `${v} is a ${p.llm} plan, and the AI is ${a.llm}`; } },
  // How they want to work (stored under `working_style:`; the assistant reads it each session).
  { key: 'check_in', ask: 'How often you will look at new picks: daily, few_times_a_week or weekly', def: () => 'daily', choices: CHECK_INS },
  { key: 'applications_per_week', ask: 'Applications a week you are aiming for (blank = no goal)', check: (v) => /^\d{1,3}$/.test(String(v).trim()) || 'a number, like 10' },
  { key: 'help_level', ask: 'How much it writes for you: fill_only (fields and resume; you write the open questions) or fill_and_write (it drafts those too, for you to read)', def: () => 'fill_and_write', choices: HELP_LEVELS },
  { key: 'cv_path', ask: 'Path to your resume as text or Markdown (blank to add cv.md yourself later)' },
];

export function validate(a) {
  const errors = [];
  for (const q of QUESTIONS) {
    const v = a[q.key];
    if (q.required && !String(v ?? '').trim()) errors.push(`${q.key} is required`);
    if (v && q.choices && !q.choices.includes(String(v).toLowerCase())) errors.push(`${q.key} must be one of ${q.choices.join(', ')}`);
    if (v && q.check) { const r = q.check(v, a); if (r !== true) errors.push(`${q.key}: ${r}`); }
  }
  return errors;
}

/** Fill defaults the same way the interactive run does. */
export function withDefaults(a) {
  const out = { ...a };
  for (const q of QUESTIONS) {
    if ((out[q.key] == null || out[q.key] === '') && q.def && out.full_name) out[q.key] = q.def(out);
    if (q.choices && out[q.key]) out[q.key] = String(out[q.key]).trim().toLowerCase();
  }
  return out;
}

export function profileYaml(a) {
  const auth = WORK_AUTH[a.work_authorization];
  const doc = {
    candidate: {
      full_name: a.full_name,
      email: a.email,
      phone: a.phone || '',
      location: [a.city, a.state].filter(Boolean).join(', '),
      linkedin: a.linkedin || '',
      portfolio_url: a.portfolio || '',
      github: '',
      photo: '',
    },
    education: {
      school: a.school,
      degree: a.degree,
      degree_level: a.degree_level,
      major: a.major,
      graduation: a.graduation,
      gpa: a.gpa || '',
    },
    // plan → usage (how much the daily search reads) and the writers' model ladder
    targeting: {
      preset: a.preset, llm: a.llm, plan: a.ai_plan || 'other',
      usage: AI_PLANS[a.ai_plan]?.usage || 'light',
      ...(AI_PLANS[a.ai_plan]?.models ? { models: AI_PLANS[a.ai_plan].models } : {}),
    },
    target_roles: { primary: list(a.target_roles), secondary: [] },
    goals: {
      seniority: a.seniority || '',
      work_mode: a.work_mode || 'any',
      start_date: a.start_date || '',
      target_companies: list(a.target_companies),
      avoid_companies: list(a.avoid_companies),
      dealbreakers: a.dealbreakers || '',
    },
    working_style: {
      check_in: a.check_in || 'daily',
      applications_per_week: a.applications_per_week ? Number(a.applications_per_week) : null,
      help_level: a.help_level || 'fill_and_write',
    },
    narrative: { headline: '', exit_story: '', superpowers: [], proof_points: [] },
    compensation: { target_range: a.salary_target || a.salary_minimum, currency: 'USD', minimum: a.salary_minimum },
    location: {
      country: 'United States',
      city: [a.city, a.state].filter(Boolean).join(', '),
      work_authorization: a.work_authorization,
      visa_status: auth.label,
      citizenship: a.citizenship_country || '',
      sponsorship_needed: auth.needsSponsorship,
      itar_eligible: auth.usPerson,
      relocation: a.relocate !== 'no',
      preferred_hubs: list(a.preferred_cities).map((s) => s.toLowerCase()),
    },
    cover_letter: { notice_period_days: 14, primary_domain: '' },
  };
  return `# Written by jarvis/setup.mjs on ${new Date().toISOString().slice(0, 10)}. Edit freely.\n`
    + `# narrative: fill headline / superpowers from cv.md; the cover-letter writer reads them.\n`
    + yaml.dump(doc, { lineWidth: 100 });
}

export function applyProfileYaml(a, template) {
  const doc = yaml.load(template) || {};
  const auth = WORK_AUTH[a.work_authorization];
  const grad = parseGradDate(a.graduation);
  const state = fullState(a.state);
  const names = a.full_name.trim().split(/\s+/);
  Object.assign(doc.identity, {
    first_name: a.legal_first_name, last_name: a.legal_last_name,
    full_name: `${a.legal_first_name} ${a.legal_last_name}`.trim(),
    preferred_first_name: names[0], preferred_last_name: names.slice(-1)[0], preferred_full_name: a.full_name,
    initials: `${a.legal_first_name} ${a.legal_last_name}`.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase(),
    email: a.email, phone: a.phone || '',
    location: [a.city, state].filter(Boolean).join(', '),
    city: a.city || '', state, postal_code: a.postal_code || '',
    linkedin: a.linkedin || '', website: a.portfolio || '', portfolio: a.portfolio || '',
  });
  const level = { bachelor: "Bachelor's", master: "Master's", phd: 'Doctorate' }[a.degree_level];
  Object.assign(doc.education, {
    school: a.school, degree: a.degree, discipline: a.major, graduation: a.graduation,
    graduation_year: String(grad?.year || ''), gpa: a.gpa || '', degree_level: level,
  });
  doc.education_entries = [{ school: a.school, degree: a.degree, field_of_study: a.major, gpa: a.gpa || '', first_year: '', last_year: a.graduation }];
  Object.assign(doc.answers, {
    authorized_to_work_us: 'Yes',
    require_sponsorship: auth.needsSponsorship ? 'Yes' : 'No',
    us_person: auth.usPerson ? 'Yes' : 'No',
    visa_status_note: a.work_authorization === 'f1'
      ? `F-1 student graduating ${a.graduation}; eligible for OPT. Will require H-1B sponsorship thereafter.`
      : '',
    citizenship_country: a.citizenship_country || '',
    citizenship_status: auth.label,
    willing_to_relocate: a.relocate === 'no' ? 'No' : 'Yes',
    earliest_start: a.graduation ? `After graduating in ${a.graduation}` : '',
    currently_in_school: grad && (grad.year * 12 + grad.month) >= (new Date().getFullYear() * 12 + new Date().getMonth() + 1) ? 'Yes' : 'No',
    highest_education: `${level} degree`,
    field_of_study: a.major,
    salary_expectation: a.salary_target || '',
  });
  doc.documents.resume_path = `output/jarvis-resumes/total-experience/${a.full_name} Resume.pdf`;
  return `# Written by jarvis/setup.mjs from config/apply-profile.example.yml. REVIEW every answer,\n`
    + `# fill work_experience from cv.md, and set the eeo block yourself (blank = left for you).\n`
    + yaml.dump(doc, { lineWidth: 100 });
}

export function portalsYaml() {
  return [
    '# Companies Jarvis scans. Gitignored: this is your list.',
    '# Add with: npm run jarvis:discover -- --names "Company A,Company B" --write',
    'tracked_companies: []',
    'watchlist: []',
    '',
  ].join('\n');
}

export function preferencesMd(a) {
  const m = PRESETS[a.preset].meta;
  return [
    `# ${a.full_name.split(/\s+/)[0]}'s job preferences`,
    '',
    'Plain English, one rule per line. The fit scorer reads this every time it runs.',
    'Start a line with `never`/`no` (hard rule), `avoid` (penalty), `prefer` (bonus) or',
    '`want`/`love` (strong bonus). Add `in title` or `in location` to narrow a rule.',
    'Lines starting with # are comments. After editing: npm run jarvis:rescore',
    '',
    '---',
    '',
    ...m.starterPreferences,
    ...goalRules(a),
    '',
  ].join('\n');
}

/** The rules the setup answers make, past the preset's starters. */
export function goalRules(a) {
  const out = [];
  if (list(a.preferred_cities).length) out.push(`prefer in location ${list(a.preferred_cities).join(', ')}`);
  if (a.work_mode === 'remote') out.push('prefer in location remote');
  if (list(a.target_companies).length) out.push(`want ${list(a.target_companies).join(', ')} in company`);
  // `avoid`, not `never`: a company they would rather skip is a taste, and stays visible.
  if (list(a.avoid_companies).length) out.push(`avoid ${list(a.avoid_companies).join(', ')} in company`);
  // Their own words are not rules yet: the assistant turns each into one with them.
  if (String(a.dealbreakers || '').trim()) out.push(`# Dealbreakers in their words (turn each into a never/avoid rule with them): ${String(a.dealbreakers).trim()}`);
  return out;
}

/** The answers in a few plain lines, for them to confirm before anything is written. */
export function summary(a) {
  const plan = AI_PLANS[a.ai_plan] || AI_PLANS.other;
  const pace = USAGE[plan.usage];
  const auth = WORK_AUTH[a.work_authorization];
  return [
    `${a.full_name} <${a.email}>, ${[a.city, a.state].filter(Boolean).join(', ') || 'no city given'}`,
    `${a.degree} in ${a.major}, ${a.school}, graduating ${a.graduation}${a.gpa ? `, GPA ${a.gpa}` : ''}`,
    `Field: ${PRESETS[a.preset]?.meta.label || a.preset}; roles: ${list(a.target_roles).join(', ') || 'the preset\'s defaults'}; level: ${a.seniority || 'not given'}`,
    `Work authorization: ${auth?.label || a.work_authorization}${auth?.needsSponsorship ? ' (needs sponsorship)' : ''}`,
    `Pay: at least ${a.salary_minimum}, aiming for ${a.salary_target || a.salary_minimum}; cities: ${list(a.preferred_cities).join(', ') || 'anywhere in the US'}; ${a.work_mode || 'any'}; relocate: ${a.relocate || 'yes'}`,
    `Start: ${a.start_date || 'not given'}; want: ${list(a.target_companies).join(', ') || 'none named'}; avoid: ${list(a.avoid_companies).join(', ') || 'none named'}`,
    `Dealbreakers: ${a.dealbreakers || 'none given'}`,
    `AI: ${a.llm} on ${plan.label}: the daily search files up to ${pace.want} picks a run and keeps ${pace.target} open${plan.models ? `; writers try ${plan.models.replace(',', ', then ')}` : ''}`,
    `Working: looks at picks ${String(a.check_in || 'daily').replace(/_/g, ' ')}; ${a.applications_per_week ? `${a.applications_per_week} applications a week` : 'no weekly goal'}; ${a.help_level === 'fill_only' ? 'it fills fields, they write the open questions' : 'it fills fields and drafts the open questions for them to read'}`,
  ].join('\n');
}

function stamp() { return new Date().toISOString().slice(0, 10); }

function writeGuarded(file, text, { force, log }) {
  if (existsSync(file)) {
    if (!force) { log(`  kept     ${path.relative(ROOT, file)} (exists; --force to replace)`); return false; }
    copyFileSync(file, `${file}.bak-${stamp()}`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  log(`  wrote    ${path.relative(ROOT, file)}`);
  return true;
}

/**
 * A RE-RUN UPDATES, IT DOES NOT START OVER (--update). The profile takes the
 * new answers and keeps what was written into it since (narrative, cover-letter
 * settings); the form answers are re-filled on top of the existing file, so
 * work history and everything else added by hand stays; the preferences keep
 * every rule and gain only the new answers' lines they do not have yet. Each
 * file changed is kept beside itself as <name>.bak-<date> first.
 */
/**
 * `fresh`'s answers over `old`, block by block, so a key added by hand inside
 * a block stays. A blank in `fresh` (a question not answered, or a key setup
 * only writes as a placeholder) never wipes a value already there.
 */
function deepMerge(old, fresh) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const blank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  const out = { ...old };
  for (const [k, v] of Object.entries(fresh)) {
    if (isObj(v) && isObj(old[k])) out[k] = deepMerge(old[k], v);
    else if (!(blank(v) && !blank(old[k]))) out[k] = v;
  }
  return out;
}

export function updateAll(a, { log = console.log, paths = {} } = {}) {
  const P = { ...DEFAULT_PATHS, ...paths };
  const backup = (file) => { if (existsSync(file)) copyFileSync(file, `${file}.bak-${stamp()}`); };
  const fresh = yaml.load(profileYaml(a));
  const old = existsSync(P.profile) ? (yaml.load(readFileSync(P.profile, 'utf8')) || {}) : {};
  backup(P.profile);
  mkdirSync(path.dirname(P.profile), { recursive: true });
  writeFileSync(P.profile, `# Updated by jarvis/setup.mjs --update on ${stamp()}. Edit freely.\n`
    + yaml.dump({ ...deepMerge(old, fresh), narrative: old.narrative || fresh.narrative, cover_letter: old.cover_letter || fresh.cover_letter }, { lineWidth: 100 }));
  log(`  updated  ${path.relative(ROOT, P.profile)}`);
  const base = existsSync(P.apply) ? readFileSync(P.apply, 'utf8') : readFileSync(P.applyExample, 'utf8');
  backup(P.apply);
  mkdirSync(path.dirname(P.apply), { recursive: true });
  writeFileSync(P.apply, applyProfileYaml(a, base));
  log(`  updated  ${path.relative(ROOT, P.apply)}`);
  if (!existsSync(P.prefs)) { writeFileSync(P.prefs, preferencesMd(a)); log(`  wrote    ${path.relative(ROOT, P.prefs)}`); }
  else {
    const have = readFileSync(P.prefs, 'utf8');
    const add = goalRules(a).filter((r) => !have.includes(r));
    if (add.length) {
      backup(P.prefs);
      writeFileSync(P.prefs, `${have.replace(/\s*$/, '\n')}${add.join('\n')}\n`);
      log(`  added    ${add.length} rule(s) to ${path.relative(ROOT, P.prefs)}`);
    } else log(`  kept     ${path.relative(ROOT, P.prefs)} (no new rules)`);
  }
  if (!existsSync(P.portals)) { writeFileSync(P.portals, portalsYaml()); log(`  wrote    ${path.relative(ROOT, P.portals)}`); }
}

export function writeAll(a, { force = false, log = console.log } = {}) {
  writeGuarded(P.profile, profileYaml(a), { force, log });
  writeGuarded(P.apply, applyProfileYaml(a, readFileSync(P.applyExample, 'utf8')), { force, log });
  writeGuarded(P.portals, portalsYaml(), { force: false, log });
  writeGuarded(P.prefs, preferencesMd(a), { force, log });
  if (a.cv_path) {
    const src = path.resolve(a.cv_path);
    if (!existsSync(src)) log(`  missing  ${a.cv_path} (cv.md not written)`);
    else writeGuarded(P.cv, readFileSync(src, 'utf8'), { force, log });
  } else if (!existsSync(P.cv)) {
    log('  todo     cv.md: put your resume there as Markdown; every resume and answer is written from it');
  }
  mkdirSync(path.join(ROOT, 'data', 'jarvis'), { recursive: true });
}

export function findBoards(a, { log = console.log } = {}) {
  const m = PRESETS[a.preset].meta;
  // The companies they named come first, then the field's starters.
  const names = [...new Set([...list(a.target_companies), ...m.starterCompanies])];
  log(`\nLooking for the job boards of ${names.length} companies (a few minutes)...`);
  const r = spawnSync(process.execPath, [path.join(HERE, 'discover-ats.mjs'), '--names', names.join(','), '--write'], { stdio: 'inherit', cwd: ROOT });
  return r.status === 0;
}

async function interview() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = {};
  console.log('\nJarvis setup. Press Enter to take the [default].\n');
  for (const q of QUESTIONS) {
    for (;;) {
      const def = q.def && a.full_name ? q.def(a) : '';
      const v = (await rl.question(`${q.ask}${def ? ` [${def}]` : ''}: `)).trim() || def;
      const one = { ...a, [q.key]: v };
      const errs = validate(one).filter((e) => e.startsWith(q.key));
      if (!errs.length) { a[q.key] = q.choices ? v.toLowerCase() : v; break; }
      console.log(`  ${errs[0]}`);
    }
  }
  const boards = /^y/i.test((await rl.question('\nFind job boards for the starter companies now? yes/no [yes]: ')).trim() || 'yes');
  rl.close();
  return { a, boards };
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const update = argv.includes('--update');
  const ai = argv.indexOf('--answers');
  let a; let boards = argv.includes('--find-boards');
  if (ai >= 0) {
    a = withDefaults(JSON.parse(readFileSync(argv[ai + 1], 'utf8')));
    const errs = validate(a);
    if (errs.length) { console.error(`Answers file has problems:\n  ${errs.join('\n  ')}`); process.exit(1); }
  } else {
    ({ a, boards } = await interview());
  }
  console.log(`\n${summary(a)}`);
  // --dry-run: the summary only, for them to confirm before anything is written.
  if (argv.includes('--dry-run')) { console.log('\n(dry run: nothing written)'); return; }
  console.log('');
  if (ai < 0) {
    // Kept so the next run (or the assistant) can change one answer and re-run with --update.
    const saved = path.join(ROOT, 'data', 'jarvis', 'setup-answers.json');
    mkdirSync(path.dirname(saved), { recursive: true });
    writeFileSync(saved, `${JSON.stringify(a, null, 2)}\n`);
  }
  if (update) updateAll(a); else writeAll(a, { force });
  const p = personFrom(yaml.load(profileYaml(a)));
  console.log(`\nSet up for ${p.fullName}: ${PRESETS[p.preset].meta.label}; graduating ${p.gradLabel}; `
    + `${p.needsSponsorship ? 'needs sponsorship' : 'no sponsorship needed'}; writers run on ${p.llm}.`);
  if (boards) findBoards(a);
  console.log([
    '',
    'Next:',
    '  1. Read data/jarvis/apply-profile.yml and fill work_experience and eeo.',
    '  2. Build your resume bullet pool from cv.md (see AGENTS.md, "Resume pool").',
    '  3. npm run jarvis:scan, then npm run jarvis:serve and open http://localhost:4300',
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
