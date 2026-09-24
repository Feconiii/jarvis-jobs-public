// Tests for the plain-English preference rules.

import { parseRules, applyPrefs } from './prefs.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const job = (o) => ({ title: '', company: '', location: '', team: '', description: '', ...o });

console.log('\n🧪 prefs: parsing');

const rules = parseRules(`
# a comment is ignored
## so is a heading
- and so is a prose bullet
never 2nd shift, night shift
avoid travel 75%
prefer in location Austin, Seattle
no software engineer, web developer in title
want robotics
`);
check('parses only real rules', rules.length, 5);
check('never keeps all its terms', rules[0].terms, ['2nd shift', 'night shift']);
check('leading "in location" sets the field', rules.find(r => r.verb === 'prefer').field, 'location');
check('trailing "in title" sets the field', rules.find(r => r.verb === 'no').field, 'title');
check('trailing qualifier is stripped from the terms',
  rules.find(r => r.verb === 'no').terms, ['software engineer', 'web developer']);

console.log('\n🧪 prefs: hard rules become blockers, not point deductions');

const shift = applyPrefs(job({ title: 'Assembler 2 - 2nd Shift', description: 'x' }), rules);
check('a never rule reports a hard violation', shift.hard.length, 1);
check('the violation names the rule', shift.hard[0].includes('2nd shift'), true);

console.log('\n🧪 prefs: field scoping');

// The reason role exclusions are title-scoped: almost every engineering JD
// mentions a sales team or a recruiter somewhere in the body.
const bodyOnly = applyPrefs(job({
  title: 'Manufacturing Engineer',
  description: 'You will partner with our software engineer colleagues and a recruiter.',
}), rules);
check('a title-scoped rule ignores the description', bodyOnly.hard.length, 0);

const inTitle = applyPrefs(job({ title: 'Senior Software Engineer', description: '' }), rules);
check('a title-scoped rule fires on the title', inTitle.hard.length, 1);

const loc = applyPrefs(job({ title: 'Engineer', location: 'Austin, TX' }), rules);
check('a location-scoped preference matches the location', loc.delta > 0, true);
const locBody = applyPrefs(job({ title: 'Engineer', location: 'Boise, ID', description: 'our Austin office' }), rules);
check('a location-scoped rule ignores the description', locBody.delta, 0);

console.log('\n🧪 prefs: bounded influence');

// Uncapped, a pile of `want` lines pinned every posting at 100/100 and the
// ranking stopped discriminating at the top.
// Terms must be at least two characters — single letters would match far too
// much — so these use real-looking words.
const many = parseRules(['want aa', 'want bb', 'want cc', 'want dd', 'want ee', 'want ff', 'prefer gg', 'prefer hh'].join('\n'));
const all = applyPrefs(job({ title: 'aa bb cc dd ee ff gg hh' }), many);
check('positive influence is capped', all.delta <= 12, true);
check('…and is actually positive', all.delta > 0, true);

const penalties = parseRules(['avoid pp', 'avoid qq', 'avoid rr', 'avoid ss', 'avoid tt'].join('\n'));
const pen = applyPrefs(job({ title: 'pp qq rr ss tt' }), penalties);
check('all five penalties actually fired', pen.hits.length, 5);
check('soft penalties are floored at -30', pen.delta, -30);

console.log('\n🧪 prefs: word boundaries');

const wb = parseRules('avoid operator in title\nno sales in title');
check('"cooperative" does not match "operator"',
  applyPrefs(job({ title: 'Cooperative Programs Engineer' }), wb).delta, 0);
check('"wholesaler" does not match "sales"',
  applyPrefs(job({ title: 'Wholesaler Support' }), wb).hard.length, 0);
check('"Operator" does match', applyPrefs(job({ title: 'Machine Operator' }), wb).delta < 0, true);

console.log('\n🧪 prefs: a multi-site req is not blocked by one ruled-out site');

// An OpenAI PCBA Manufacturing Engineer at fit 92 sat in the Blocked band
// because its location read "Singapore · Seattle · United States ·
// San Francisco" and the Singapore rule matched the whole string. Three US
// sites were listed right beside it. A false negative is the expensive error.
const siteRules = parseRules('never in location Singapore, India, Malaysia, Japan');

check('every site ruled out → still blocked',
  applyPrefs(job({ location: 'Singapore' }), siteRules).hard.length, 1);
check('two ruled-out sites → still blocked',
  applyPrefs(job({ location: 'Tokyo, Japan | Bangalore, India' }), siteRules).hard.length, 1);
check('one surviving US site → not blocked',
  applyPrefs(job({ location: 'Singapore · Seattle · United States' }), siteRules).hard.length, 0);
check('…and the excluded site is still reported',
  applyPrefs(job({ location: 'Singapore · Seattle' }), siteRules).hits.some(h => /other sites still open/.test(h)), true);
check('slash-separated sites split too',
  applyPrefs(job({ location: 'Malaysia / Austin, TX' }), siteRules).hard.length, 0);
check('a title rule is unaffected by site splitting',
  applyPrefs(job({ title: 'Nurse', location: 'Austin · Seattle' }), parseRules('no nurse in title')).hard.length, 1);

console.log('\n🧪 prefs: `require` — naming what the job has to BE');

// Blocklisting stopped converging. Every pass through the deck turned up
// another profession nobody had anticipated — nurse practitioners billed as
// "Advanced Practice Provider", telehealth psychiatrists, medical coders, Okta
// engineers, yard hostlers, claims adjusters — because the tracked companies
// include Accenture, Amazon, Humana and Labcorp, who post their whole
// workforce. Labcorp alone had 161 postings in the deck and not one of them
// contained the word "engineer".
const req = parseRules('require engineer, engineering, mechanical designer, drafter in title');

check('a matching title passes', applyPrefs(job({ title: 'Manufacturing Engineer' }), req).hard.length, 0);
check('…including the non-engineer titles that are real',
  applyPrefs(job({ title: 'CAD Mechanical Designer' }), req).hard.length, 0);
check('…and a drafter', applyPrefs(job({ title: 'Drafter' }), req).hard.length, 0);

check('a title matching none of them is blocked',
  applyPrefs(job({ title: 'Telehealth Psychiatrist' }), req).hard.length, 1);
check('…however good it otherwise looks',
  applyPrefs(job({ title: 'Applied Scientist, Mobile Manipulation Robotics' }), req).hard.length, 1);
check('the reason names what was wanted',
  /roles you asked for/.test(applyPrefs(job({ title: 'Yard Hostler' }), req).hard[0]), true);

// It fires by NOT matching, the opposite of every other rule, so the field
// scoping has to be right or it blocks on the description instead.
const reqAll = parseRules('require robotics');
check('an unscoped require reads the whole document',
  applyPrefs(job({ title: 'Mechanical Engineer', description: 'you will work on robotics' }), reqAll).hard.length, 0);
check('…and still blocks when nothing matches anywhere',
  applyPrefs(job({ title: 'Mechanical Engineer', description: 'you will work on pumps' }), reqAll).hard.length, 1);

check('no require rule means no requirement',
  applyPrefs(job({ title: 'Telehealth Psychiatrist' }), parseRules('avoid pumps')).hard.length, 0);

console.log('\n🧪 prefs: empty config is harmless');
check('no rules → no effect', applyPrefs(job({ title: 'Anything' }), []), { delta: 0, hard: [], hits: [] });

console.log('\n🧪 prefs: a never rule names a kind of JOB, so it must match the job');
{
  // F-242, found on his own store. His rule "never shift technician" hid the
  // single best replacement for the six GlobalFoundries roles he had
  // shortlisted — "Advanced Manufacturing Process Engineer (2027 New College
  // Graduate)", Malta NY, scoring 80 — because one sentence of the description
  // reads "Create training materials and provide training for shift
  // technicians". That is an ENGINEER who trains shift technicians.
  const rules = parseRules('never shift technician, shift lead\nnever 2nd shift, night shift');

  const trainer = job({
    title: 'Advanced Manufacturing Process Engineer (2027 New College Graduate)',
    description: 'Create training materials and provide training for shift technicians. Own process control.',
  });
  check('a body mention does not block', applyPrefs(trainer, rules).hard.length, 0);
  check('but it does count against the posting', applyPrefs(trainer, rules).delta, -10);
  check('and it says exactly why, rather than going silent',
    /description but not the title/.test(applyPrefs(trainer, rules).hits[0] || ''), true);

  // THE OTHER HALF. A rule that stops blocking real shift work is worse than
  // the false block it replaced — he does not want these jobs.
  check('shift work named in the TITLE still blocks',
    applyPrefs(job({ title: '2nd Shift Process Engineer', description: 'Support the fab.' }), rules).hard.length, 1);
  check('and so does the role itself',
    applyPrefs(job({ title: 'Shift Technician', description: 'Operate tools.' }), rules).hard.length, 1);

  // An explicitly title-scoped rule is unchanged: it only ever read the title.
  check('an "in title" rule is untouched',
    applyPrefs(job({ title: 'Material Handler', description: 'x' }), parseRules('no packer, material handler in title')).hard.length, 1);
}

// ── `in company`: defense that is in the employer, not the posting (F-469) ──
//
// Icarus builds solar stratospheric ISR aircraft in El Segundo — YC industry
// "Defense", Army SBIR contracts, a CEO with TS/SCI — and advertises a plain
// "Manufacturing Engineer" that says nothing about any of it. His rule "never
// defense … in title" could not see it, `f_hard_block` was 0, and the
// extension filled the form on 2026-09-06.
{
  const rules = parseRules('never Icarus in company');
  check('the qualifier parses as a company rule', rules[0].field, 'company');
  const at = (company, title) => applyPrefs({ company, title, location: 'El Segundo', description: 'Build aircraft.' }, rules).hard.length;
  // A `never` is only HARD when the term is in the title, because a body
  // mention is not proof of what the job is. An employer is never in the
  // title, so a company rule has to be exempt or the qualifier does nothing.
  check('a company rule blocks whatever the title says', at('Icarus', 'Manufacturing Engineer'), 1);
  check('…and on every posting that employer has', at('Icarus', 'Flight Test Engineer'), 1);
  check('another employer is untouched', at('Applied Materials', 'Manufacturing Engineer'), 0);
  // The scope is the whole point: it must read the company and only the company.
  check('the same word in a TITLE at another employer does not block',
    at('Boston Dynamics', 'Icarus Program Engineer'), 0);
  check('a company rule does not fire on a description mention',
    applyPrefs({ company: 'Boston Dynamics', title: 'Mechanical Engineer', location: 'MA', description: 'We partner with Icarus on airframes.' }, rules).hard.length, 0);
}

// ── `except`: one word, two professions (F-540) ─────────────────────────
//
// "no cloud … in title" was written for cloud software and also hid AWS's
// "Cloud Hardware Development Engineer, AWS - Early Career (2026)" — the only
// mechanical early-career role Amazon had posted — and 50-odd hardware reqs
// named after their team ("Cloud AI/ML server teams").
{
  const rules = parseRules('no cloud in title except hardware, hw, mechanical');
  check('except terms are parsed off the rule', rules[0].except, ['hardware', 'hw', 'mechanical']);
  check('…and are not rule terms', rules[0].terms, ['cloud']);
  check('the field qualifier before except still parses', rules[0].field, 'title');
  const hard = (title) => applyPrefs(job({ title, description: 'x' }), rules).hard.length;
  check('cloud software is still blocked', hard('Cloud Migration Engineer'), 1);
  check('the hardware form is not', hard('Cloud Hardware Development Engineer, AWS - Early Career (2026)'), 0);
  check('the abbreviation is not', hard('Cloud HW engineer, SI/PI, Network Product Development'), 0);
  check('an except term in the DESCRIPTION does not save a title-scoped rule',
    applyPrefs(job({ title: 'Cloud DevOps Engineer', description: 'Deploys to hardware.' }), rules).hard.length, 1);
  check('a rule without except parses an empty list', parseRules('no devops in title')[0].except, []);
  check('the phrase "except" inside no rule line is left alone',
    parseRules('avoid travel 75%')[0].except, []);
}


console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
