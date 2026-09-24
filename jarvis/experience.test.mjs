#!/usr/bin/env node
// jarvis/experience.test.mjs — golden tests for the Workday "My Experience"
// data layer (jarvis/apply/_experience.mjs).
//
// The DOM driving in workday.mjs can only be proven against a live tenant, so
// everything that CAN be tested without a browser is pulled into pure functions
// and pinned here: date parsing, the current-role rule, entry shaping, and the
// fallback that keeps older profiles working.
//
// Run: npm run jarvis:test:experience   (or node jarvis/experience.test.mjs)

import {
  parseMonthYear,
  isCurrent,
  tidyDescription,
  workEntries,
  educationEntries,
  hasAnyExperience,
} from './apply/_experience.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
}

function ok(name, cond) {
  check(name, !!cond, true);
}

// ── parseMonthYear ──────────────────────────────────────────────────
check('parse "May 2026"', parseMonthYear('May 2026'), { month: 5, year: 2026 });
check('parse lowercase "august 2025"', parseMonthYear('august 2025'), { month: 8, year: 2025 });
check('parse abbreviated "Sept 2024"', parseMonthYear('Sept 2024'), { month: 9, year: 2024 });
check('parse "Jan 2020"', parseMonthYear('Jan 2020'), { month: 1, year: 2020 });
check('parse ISO-ish "2026-05"', parseMonthYear('2026-05'), { month: 5, year: 2026 });
check('parse US "05/2026"', parseMonthYear('05/2026'), { month: 5, year: 2026 });
check('parse bare year "2027"', parseMonthYear('2027'), { month: null, year: 2027 });
check('parse empty → null', parseMonthYear(''), null);
check('parse undefined → null', parseMonthYear(undefined), null);
check('parse garbage → null', parseMonthYear('sometime last spring'), null);
check('parse invalid month number → null month', parseMonthYear('13/2026'), { month: null, year: 2026 });
check('parse nonsense month name → null', parseMonthYear('Smarch 2026'), null);

// ── isCurrent ───────────────────────────────────────────────────────
// Built with the local-time constructor on purpose: isCurrent() compares
// against getFullYear()/getMonth(), which are local, so a UTC literal like
// '2026-09-01T00:00:00Z' is August 31 west of Greenwich and would make these
// month-boundary cases pass or fail depending on the machine's timezone.
const JUL_2026 = new Date(2026, 6, 26);

ok('explicit current:true wins', isCurrent({ current: true, end: 'May 2020' }, JUL_2026));
ok('explicit current:false wins', isCurrent({ current: false, end: '' }, JUL_2026) === false);
ok('no end date → current', isCurrent({ start: 'August 2024', end: '' }, JUL_2026));
ok('past end date → not current', isCurrent({ end: 'August 2025' }, JUL_2026) === false);
ok('future end date → current', isCurrent({ end: 'August 2026' }, JUL_2026));
// The month-granularity rule: a role ending in the CURRENT month is still current.
ok('end in the current month → still current', isCurrent({ end: 'July 2026' }, JUL_2026));
ok('end last month → not current', isCurrent({ end: 'June 2026' }, JUL_2026) === false);
// ...and the same entry flips on its own once the date passes, with no edit.
ok('same entry is not current after the end date passes',
  isCurrent({ end: 'August 2026' }, new Date(2026, 8, 1)) === false);

// ── tidyDescription ─────────────────────────────────────────────────
check('folded YAML whitespace collapses',
  tidyDescription('  line one\n  line two   three\n'), 'line one line two three');
check('empty description → empty string', tidyDescription(undefined), '');
check('over-long description is truncated with an ellipsis',
  tidyDescription('x'.repeat(50), 10), `${'x'.repeat(9)}…`);

// ── workEntries ─────────────────────────────────────────────────────
const PROFILE = {
  work_experience: [
    {
      title: 'Manufacturing Engineer Intern (Automation)',
      company: 'Applied Materials',
      location: 'Austin, Texas',
      start: 'May 2026',
      end: 'August 2026',
      description: 'Deployed  AMRs\n  and vision fixtures.',
    },
    {
      title: 'Mechanical Engineering Intern',
      company: 'Acme Steel Stud Company',
      location: 'Springfield, Washington',
      start: 'May 2025',
      end: 'August 2025',
      description: 'Time studies.',
    },
    {
      title: 'Manufacturing Lead',
      company: 'State University - Makerspace Manufacturing Technology Center',
      location: 'Springfield, Washington',
      start: 'August 2024',
      end: '',
      current: true,
      description: 'Run the shop.',
    },
  ],
  education_entries: [
    {
      school: 'State University',
      degree: 'Bachelor of Science',
      field_of_study: 'Mechanical Engineering',
      gpa: '3.85',
      first_year: '',
      last_year: '2027',
    },
  ],
};

const work = workEntries(PROFILE, { now: JUL_2026 });
check('three work entries built', work.length, 3);
check('order is preserved (newest first, as authored)',
  work.map((w) => w.company),
  ['Applied Materials', 'Acme Steel Stud Company', 'State University - Makerspace Manufacturing Technology Center']);

// The AMAT internship ends August 2026 — in July 2026 it is genuinely current,
// and Workday hides the end date once "I currently work here" is checked.
ok('in-progress internship is marked current', work[0].current === true);
check('current role carries no end date', work[0].end, null);
check('current role keeps its start date', work[0].start, { month: 5, year: 2026 });

ok('finished internship is not current', work[1].current === false);
check('finished role keeps its end date', work[1].end, { month: 8, year: 2025 });

ok('explicit current:true role is current', work[2].current === true);
check('description whitespace is collapsed', work[0].description, 'Deployed AMRs and vision fixtures.');

// Same profile, read after the internship ends — no edit required.
const workLater = workEntries(PROFILE, { now: new Date(2026, 9, 1) });
ok('internship stops being current once its end date passes', workLater[0].current === false);
check('...and its end date is then carried through', workLater[0].end, { month: 8, year: 2026 });

check('limit caps the number of entries', workEntries(PROFILE, { now: JUL_2026, limit: 2 }).length, 2);
check('missing work_experience → no entries', workEntries({}).length, 0);
check('entries with neither title nor company are dropped',
  workEntries({ work_experience: [{ location: 'Nowhere' }, { title: 'Real' }] }).length, 1);

// ── educationEntries ────────────────────────────────────────────────
const edu = educationEntries(PROFILE);
check('one education entry built', edu.length, 1);
check('education fields map across', edu[0], {
  school: 'State University',
  degree: 'Bachelor of Science',
  fieldOfStudy: 'Mechanical Engineering',
  gpa: '3.85',
  firstYear: null,
  lastYear: 2027,
  firstMonth: null,
  lastMonth: null,
});
ok('blank first_year stays null rather than being guessed', edu[0].firstYear === null);

// A profile that states the months carries them; a bare year carries none (F-358).
const dated = educationEntries({ education_entries: [{ school: 'State University', first_year: 'Aug 2023', last_year: 'May 2027' }] })[0];
check('a stated start month is carried', [dated.firstYear, dated.firstMonth], [2023, 8]);
check('a stated end month is carried', [dated.lastYear, dated.lastMonth], [2027, 5]);
const bare = educationEntries({ education_entries: [{ school: 'State University', first_year: '2023', last_year: '2027' }] })[0];
check('a bare year carries no month — never a guess', [bare.firstYear, bare.firstMonth, bare.lastMonth], [2023, null, null]);

// A profile written before education_entries existed must still clear the step.
const legacy = educationEntries({
  education: {
    school: 'State University',
    degree: 'Bachelor of Science',
    discipline: 'Mechanical Engineering',
    gpa: '3.85',
    graduation_year: '2027',
  },
});
check('legacy flat education block falls back to one entry', legacy.length, 1);
check('legacy fallback maps discipline → fieldOfStudy', legacy[0].fieldOfStudy, 'Mechanical Engineering');
check('legacy fallback derives last year from graduation_year', legacy[0].lastYear, 2027);
check('no education at all → no entries', educationEntries({}).length, 0);
check('entries without a school are dropped',
  educationEntries({ education_entries: [{ degree: 'BS' }] }).length, 0);

// ── hasAnyExperience ────────────────────────────────────────────────
ok('full profile has experience', hasAnyExperience(PROFILE, { now: JUL_2026 }));
ok('work-only profile has experience', hasAnyExperience({ work_experience: [{ title: 'X' }] }));
ok('education-only profile has experience', hasAnyExperience({ education: { school: 'X' } }));
ok('empty profile has none', hasAnyExperience({}) === false);

// ── report ──────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.error(`  FAIL: ${f}\n`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
