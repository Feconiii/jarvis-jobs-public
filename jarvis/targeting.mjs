/**
 * WHO THIS COPY OF JARVIS IS SEARCHING FOR.
 *
 * Jarvis was written for one person, and his targeting — the field words, the
 * degree check, the visa gate, the discovery searches, the curator's brief —
 * was written straight into the code. This module is the one place that
 * targeting now comes from, so a second person can run the same code:
 *
 *   person   who they are: name, school, degree, graduation, work
 *            authorization, pay floor. Read from config/profile.yml.
 *   screen   what counts as their kind of job (triage, degree, fit, picks,
 *            curation). From the PRESET the profile names.
 *   discovery  what the company-finding passes search for. Same preset.
 *   writing  per-preset wording for the writers (role emphasis, examples).
 *
 * The preset is chosen by `targeting.preset` in config/profile.yml. A profile
 * that names none gets `hardware-engineering`, which is the original
 * targeting moved here unchanged, so the original user sees no difference.
 *
 * TESTS NEVER READ THE PROFILE. The suite pins the default person and preset,
 * so its expectations hold on any machine, whoever's profile is installed.
 * `npm run jarvis:setup` writes the profile; nothing else does.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import hardwareEngineering from './presets/hardware-engineering/index.mjs';
import financeData from './presets/finance-data/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

export const PRESETS = {
  'hardware-engineering': hardwareEngineering,
  'finance-data': financeData,
};
export const DEFAULT_PRESET = 'hardware-engineering';

/** The person the code was written for. Tests run as him; so does a missing profile. */
export const DEFAULT_PERSON = Object.freeze({
  fullName: 'Alex Rivera',
  firstName: 'Alex',
  school: 'Lakeside University',
  degreeLevel: 'bachelor',
  major: 'Mechanical Engineering',
  gradDate: Object.freeze({ year: 2027, month: 5 }),
  gradLabel: 'May 2027',
  workAuth: 'f1',
  needsSponsorship: true,
  usPerson: false,
  salaryFloor: 80000,
  preset: DEFAULT_PRESET,
  llm: 'claude',
  plan: '',
  usage: 'standard',
  models: '',
  helpLevel: 'fill_and_write',
  isDefault: true,
});

/**
 * THE AI PLAN SETS HOW MUCH THE AI RUNS (2026-11-14). Setup asks which plan
 * the person has for their assistant and records it as `targeting.plan`. The
 * plan sets two things: the usage level (`targeting.usage`), which sizes the
 * daily search's reading, and for Claude the model ladder the writers try in
 * order (a spent model falls to the next). `JARVIS_CLI_MODEL` still overrides
 * the ladder for one run. A profile with no plan reads as `standard`, which is
 * what the code did before plans existed.
 */
export const AI_PLANS = Object.freeze({
  'claude-pro': { llm: 'claude', usage: 'light', models: 'sonnet,haiku', label: 'Claude Pro' },
  'claude-max': { llm: 'claude', usage: 'standard', models: 'sonnet,haiku', label: 'Claude Max (5x or 20x)' },
  'claude-api': { llm: 'claude', usage: 'light', models: 'haiku,sonnet', label: 'Claude Code on an API key (billed per use)' },
  'chatgpt-plus': { llm: 'codex', usage: 'light', models: '', label: 'ChatGPT Plus' },
  'chatgpt-pro': { llm: 'codex', usage: 'standard', models: '', label: 'ChatGPT Pro' },
  'chatgpt-business': { llm: 'codex', usage: 'standard', models: '', label: 'ChatGPT Business, Enterprise or Edu' },
  other: { llm: '', usage: 'light', models: '', label: 'another plan, or not sure' },
});

/**
 * What a usage level lets the daily search spend: `want` picks filed per run,
 * `target` open picks it tops up to, `maxRead` postings read at most per run,
 * `triggerMaxFile` picks a new-postings read files. `standard` is the values
 * the dashboard and the scheduled search used before levels existed.
 */
export const USAGE = Object.freeze({
  light: Object.freeze({ want: 10, target: 25, maxRead: 100, triggerMaxFile: 5 }),
  standard: Object.freeze({ want: 20, target: 50, maxRead: 300, triggerMaxFile: 10 }),
});

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTH_LABEL = (m) => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);

/** "May 2027", "2027-05", "5/2027" → { year, month }; anything else → null. */
export function parseGradDate(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2] };
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { year: +m[2], month: +m[1] };
  m = s.match(/^([a-z]+)\.?\s+(\d{4})$/);
  if (m) {
    const i = MONTHS.findIndex((n) => n.startsWith(m[1].slice(0, 3)));
    if (i >= 0) return { year: +m[2], month: i + 1 };
  }
  m = s.match(/^(\d{4})$/);
  if (m) return { year: +m[1], month: 5 };
  return null;
}

function parseMoney(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = String(s).replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? n * 1000 : n;
}

/** The work-authorization words setup writes, and what each one implies. */
export const WORK_AUTH = {
  citizen: { needsSponsorship: false, usPerson: true, label: 'U.S. citizen' },
  permanent_resident: { needsSponsorship: false, usPerson: true, label: 'U.S. permanent resident (green card)' },
  f1: { needsSponsorship: true, usPerson: false, label: 'F-1 student (OPT, then H-1B sponsorship)' },
  visa: { needsSponsorship: true, usPerson: false, label: 'on a work visa that needs sponsorship' },
  no_sponsorship_needed: { needsSponsorship: false, usPerson: false, label: 'authorized to work, no sponsorship needed' },
};

/**
 * Build the person from a parsed profile.yml. Exported for the setup script
 * and the tests; everything else reads `person`.
 */
export function personFrom(cfg) {
  if (!cfg || typeof cfg !== 'object') return DEFAULT_PERSON;
  const c = cfg.candidate || {};
  const ed = cfg.education || {};
  const loc = cfg.location || {};
  const t = cfg.targeting || {};
  const d = DEFAULT_PERSON;

  const fullName = String(c.full_name || '').trim() || d.fullName;
  const grad = parseGradDate(ed.graduation) || d.gradDate;

  // Work authorization: the explicit word setup writes wins; an older profile
  // that only has `sponsorship_needed` / `itar_eligible` is read from those.
  let workAuth = String(loc.work_authorization || '').trim().toLowerCase();
  if (!WORK_AUTH[workAuth]) {
    workAuth = loc.sponsorship_needed === false
      ? (loc.itar_eligible === true ? 'citizen' : 'no_sponsorship_needed')
      : 'f1';
  }
  const auth = WORK_AUTH[workAuth];
  const preset = PRESETS[t.preset] ? t.preset : d.preset;
  const llm = /^codex$/i.test(String(process.env.JARVIS_LLM || t.llm || '')) ? 'codex' : 'claude';
  const plan = AI_PLANS[t.plan] ? t.plan : '';
  const usage = USAGE[t.usage] ? t.usage : (AI_PLANS[plan]?.usage || 'standard');
  // Only Claude model names: the Codex runner ignores the ladder.
  const models = String(t.models || AI_PLANS[plan]?.models || '').split(',')
    .map((s) => s.trim().toLowerCase()).filter((s) => /^(sonnet|haiku)$/.test(s)).join(',');

  return Object.freeze({
    fullName,
    firstName: String(c.first_name || fullName.split(/\s+/)[0]),
    school: String(ed.school || '').trim() || (fullName === d.fullName ? d.school : ''),
    degreeLevel: String(ed.degree_level || '').trim().toLowerCase() || d.degreeLevel,
    major: String(ed.major || '').trim() || (fullName === d.fullName ? d.major : ''),
    gradDate: Object.freeze({ ...grad }),
    gradLabel: `${MONTH_LABEL(grad.month)} ${grad.year}`,
    workAuth,
    needsSponsorship: auth.needsSponsorship,
    usPerson: auth.usPerson,
    salaryFloor: parseMoney(cfg.compensation?.minimum) ?? d.salaryFloor,
    preset,
    llm,
    plan,
    usage,
    models,
    // fill_only: they write every open-ended answer themselves (serve.mjs /api/answer refuses).
    helpLevel: cfg.working_style?.help_level === 'fill_only' ? 'fill_only' : 'fill_and_write',
    isDefault: false,
  });
}

const IN_TEST = !!process.env.NODE_TEST_CONTEXT || /\.test\.mjs$/i.test(process.argv[1] || '');

function loadPerson() {
  if (IN_TEST && !process.env.JARVIS_PROFILE) return DEFAULT_PERSON;
  const file = process.env.JARVIS_PROFILE || path.join(ROOT, 'config', 'profile.yml');
  if (!existsSync(file)) return DEFAULT_PERSON;
  try {
    return personFrom(yaml.load(readFileSync(file, 'utf8')) || {});
  } catch {
    return DEFAULT_PERSON;
  }
}

export const person = loadPerson();
export const preset = PRESETS[person.preset];
export const screen = preset.screen;
export const discovery = preset.discovery;
export const writing = preset.writing;
export const meta = preset.meta;

/** "he"/"his" in the code's own prose was always about one person; prompts use the name. */
export const them = person.firstName;
