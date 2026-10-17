// Tests for the screen half of targeting.mjs: the same screening code, run as
// the default person and as the made-up finance user in
// presets/finance-data/test-profile.yml (citizen, BBA Finance / Business
// Analytics, May 2026).
//
// This process is a *.test.mjs run, so it is pinned to the default person and
// the hardware preset. The finance user is checked in CHILD processes started
// with JARVIS_PROFILE pointing at the test profile, because `person` and
// `screen` are fixed when targeting.mjs is first imported.
//
// Run: node jarvis/targeting-screen.test.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { person, screen } from './targeting.mjs';
import { classifyExperience, scoreRelevance } from './triage.mjs';
import { eligibility, titleIsElsewhere } from './eligibility.mjs';
import { exportBar, disciplineMiss } from './picks.mjs';
import { promptFor, titleOut } from './curate.mjs';
import { disciplineBar } from './prescreen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FINANCE_PROFILE = path.join(HERE, 'presets', 'finance-data', 'test-profile.yml');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

// ── the postings ────────────────────────────────────────────────────

const FA = {
  title: 'Financial Analyst - New Grad',
  company: 'Acme Capital', location: 'Seattle, WA',
  description: `About the role
You will build financial models, run variance analysis and support the monthly forecast for the FP&A team.

Qualifications
• Bachelor's in Finance, Economics or related field.
• 0-2 years of experience; internships count.
• Advanced Microsoft Excel and financial modeling; SQL a plus.`,
};
const FPA = {
  title: 'FP&A Analyst I',
  company: 'Acme Corp', location: 'New York, NY',
  description: `Responsibilities
Own the annual operating plan, budgeting and forecasting for two business units, and present variance analysis to leadership.

Minimum Qualifications
• Bachelor's degree in Finance, Accounting, Economics or a related field.
• Proficiency in Excel and PowerPoint; experience with Anaplan or Adaptive Insights is a plus.`,
};
const DA = {
  title: 'Data Analyst, Early Career',
  company: 'Acme Analytics', location: 'Remote - US',
  description: `What you'll do
Write SQL against our Snowflake warehouse, build Tableau dashboards and run A/B testing analysis for the product team.

What we're looking for
• Bachelor's degree in Statistics, Mathematics, Economics, or a related quantitative field.
• Experience with SQL and Python or R through coursework or internships.`,
};
const ME = {
  title: 'Mechanical Engineer I',
  company: 'Acme Robotics', location: 'Fremont, CA',
  description: `Responsibilities
Design mechanical assemblies in SolidWorks, apply GD&T and run FEA on load-bearing parts.

Requirements
• Bachelor's degree in Mechanical Engineering.
• 0-2 years of experience.`,
};
const ITAR = 'This position requires access to technology subject to the International Traffic in Arms Regulations (ITAR); applicants must be U.S. persons.';

// ── the finance user, in a child process ────────────────────────────

const CHILD = `
import { person, screen } from './jarvis/targeting.mjs';
import { triage, classifyExperience, scoreRelevance, classifyProgram } from './jarvis/triage.mjs';
import { checkDegree } from './jarvis/degree.mjs';
import { eligibility, titleIsElsewhere } from './jarvis/eligibility.mjs';
import { scoreFit } from './jarvis/fit.mjs';
import { classifyField } from './jarvis/field.mjs';
import { prescreen, disciplineBar } from './jarvis/prescreen.mjs';
import { exportBar, disciplineMiss, winnability, desirability } from './jarvis/picks.mjs';
import { promptFor, titleOut, tierOf, CAPPED } from './jarvis/curate.mjs';
import { learnFromSkips } from './jarvis/skip-learn.mjs';
const jobs = JSON.parse(process.env.TS_JOBS);
const out = { person, preset: person.preset };
const profile = { primaryRoles: ['financial analyst', 'data analyst'], secondaryRoles: [], archetypes: [], industries: [],
  excludedIndustries: [], skills: new Set(['excel', 'sql']), compTarget: null, compFloor: null, hubs: [], sponsorshipNeeded: false };
for (const [k, j] of Object.entries(jobs)) {
  if (k === 'ITAR') continue;
  const t = triage(j);
  out[k] = {
    relevance: scoreRelevance(j.title, j.description).score,
    degree: checkDegree(j.description, j.title),
    eligible: eligibility(j, j.description).verdict,
    elsewhere: titleIsElsewhere(j.title),
    miss: disciplineMiss(j.title),
    prescreen: prescreen({ title: j.title, text: j.description }),
    disciplineBar: disciplineBar(j.title),
    field: classifyField(j).key,
    level: t.experience.level,
    roleKind: t.roleKind,
    fitRole: scoreFit({ ...j, triage: t }, profile).breakdown.find((b) => b.dimension === 'role').points,
  };
}
out.degreeEngOnly = checkDegree("Requirements: Bachelor's degree in Mechanical or Electrical Engineering required.", 'Analyst').mismatch;
out.exportBar = exportBar('Financial Analyst', jobs.ITAR);
out.staffAccountant = classifyExperience('Staff Accountant', 'Prepare journal entries and reconciliations.').level;
out.grad2026 = triage({ title: 'Analyst Program', description: 'Open to students graduating between December 2025 and June 2026.' }).program.gradEligible;
out.stretchNote = classifyExperience('Financial Analyst', 'Requirements\\n• 3+ years of experience in FP&A.').note;
const nonUs = scoreFit({ title: 'Financial Analyst', location: 'London, UK', triage: { locationBucket: 'non-us' } }, profile)
  .breakdown.find((b) => b.dimension === 'location');
out.nonUs = { points: nonUs.points, why: nonUs.why[0] };
const prompt = promptFor(jobs.FPA, jobs.FPA.description, 'CV', []);
out.prompt = { name: prompt.includes('Test Analyst'), grad: prompt.includes('May 2026'), visa: /visa|sponsor|ITAR|F-1|OPT|H-1B|green card/i.test(prompt) };
out.titleOut = { staffAccountant: titleOut('Staff Accountant'), senior: titleOut('Senior Financial Analyst'), summer: titleOut('Summer Analyst 2027') };
out.capped = CAPPED;
out.tierGS = tierOf('Goldman Sachs');
out.win = winnability({ sponsors_h1b: 1, f_visa_good: 1, lca_eng_certified: 40 }).score;
out.desire = desirability({ fit_score: 70, salary_max: 70000 }).score;
out.skipDefense = learnFromSkips([{ title: 'Analyst', company: 'Raytheon', note: 'defense company', reasons: [] }],
  [{ title: 'Financial Analyst', company: 'Raytheon' }]).proposals.length;
out.skipProtect = screen.skipProtect.includes('finance');
console.log(JSON.stringify(out));
`;

function asFinance() {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: ROOT,
    env: { ...process.env, JARVIS_PROFILE: FINANCE_PROFILE, TS_JOBS: JSON.stringify({ FA, FPA, DA, ME, ITAR }) },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`finance child failed:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

console.log('\n🧪 targeting: the finance user');
{
  const f = asFinance();
  check('the profile is read: Test Analyst, finance-data, citizen', [f.person.fullName, f.preset, f.person.workAuth, f.person.usPerson], ['Test Analyst', 'finance-data', 'citizen', true]);
  for (const k of ['FA', 'FPA', 'DA']) {
    const j = f[k];
    check(`${k}: relevant (relevance ≥ 20)`, j.relevance >= 20, true);
    check(`${k}: degree OK`, j.degree.mismatch, false);
    check(`${k}: eligible`, j.eligible, 'apply');
    check(`${k}: the title is not another discipline's`, [j.elsewhere, j.miss, j.disciplineBar], [false, false, null]);
    check(`${k}: not screened out before reading`, j.prescreen, null);
    check(`${k}: entry level`, j.level, 'entry');
    check(`${k}: professional, not the front-line track`, j.roleKind, 'professional');
    check(`${k}: the role scores as a target discipline`, j.fitRole >= 16, true);
  }
  check('FP&A is filed under FP&A', f.FPA.field, 'fpa');
  check('the data analyst role is filed under data & analytics', f.DA.field, 'data-analytics');
  check('Mechanical Engineer: off-field (title is elsewhere, missed, barred)', [f.ME.elsewhere, f.ME.miss, !!f.ME.disciplineBar], [true, true, true]);
  check('Mechanical Engineer: not eligible', f.ME.eligible, 'not-eligible');
  check('Mechanical Engineer: less relevant than a financial analyst role', f.ME.relevance < f.FA.relevance, true);
  check('an engineering-only degree list is a mismatch for them', f.degreeEngOnly, true);
  check('exportBar does not block a citizen', f.exportBar, null);
  check('Staff Accountant is not read as senior', f.staffAccountant !== 'exclude', true);
  check('their own graduation date decides the window (May 2026)', f.grad2026, true);
  check('the stretch note does not speak about him', /he graduates|May 2027/.test(f.stretchNote), false);
  check('outside the US still scores 0, without the F-1 wording', [f.nonUs.points, /F-1/.test(f.nonUs.why)], [0, false]);
  check('the curator brief names them and their graduation, and never mentions visas', f.prompt, { name: true, grad: true, visa: false });
  check('curator titles: Staff Accountant passes, senior and summer analyst are out', f.titleOut, { staffAccountant: false, senior: true, summer: true });
  check('no employer is capped', f.capped, null);
  check('a frontier finance employer is read first', f.tierGS, 1);
  check('sponsorship history earns a citizen nothing', f.win, 40);
  check('their own pay floor ($65K): a $70K top is not docked', f.desire, 70);
  check('a defense note is not an employer-level reason for a citizen', f.skipDefense, 0);
  check('the finance preset protects its own words from the skip learner', f.skipProtect, true);
}

console.log('\n🧪 targeting: the default person is unchanged');
{
  check('this run is pinned to him and the hardware preset', [person.fullName, person.preset, screen.priorityFields], ['Alex Rivera', 'hardware-engineering', ['robotics', 'ai-hardware']]);
  check('the stretch note still speaks about him', classifyExperience('Process Engineer', 'Requirements\n• 3+ years of experience in manufacturing.').note,
    'Asks for 3+ years — he graduates May 2027 with none, so this is a stretch.');
  check('a Business Analyst title is still somebody else\'s work for him', titleIsElsewhere('Business Analyst'), true);
  check('…and a Mechanical Engineer one is his', [titleIsElsewhere(ME.title), disciplineMiss(ME.title), disciplineBar(ME.title)], [false, false, null]);
  check('a mechanical posting is still eligible for him', eligibility(ME, ME.description).verdict, 'apply');
  check('ITAR still bars his picks', !!exportBar('Mechanical Engineer', ITAR), true);
  check('his curator brief still carries his status line', promptFor(ME, ME.description, 'CV', []).includes('Status: F-1 student, will need OPT then H-1B sponsorship. Graduates May 2027, can start June 2027.'), true);
  check('Staff titles are still out for him', titleOut('Staff Mechanical Engineer'), true);
  check('relevance still reads mechanical work', scoreRelevance(ME.title, ME.description).score > scoreRelevance(FA.title, FA.description).score, true);
  check('the skip-protect list is the one serve.mjs used to hold', screen.skipProtect,
    ['mechanical', 'manufacturing', 'automation', 'robotics', 'design', 'process', 'quality', 'test', 'equipment', 'systems', 'production']);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
