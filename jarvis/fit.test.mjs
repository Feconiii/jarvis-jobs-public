// Tests for the fit scorer. The scorer decides what Alex actually looks at,
// so the cases that matter are the ones where a naive keyword score gets it
// wrong: senior roles that read like perfect matches, unread postings, and
// aliases that collide with ordinary English.

import { scoreFit, bandFor, skillMentioned, loadProfile } from './fit.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// A fixed profile — never read from disk, so these tests do not change meaning
// when the real cv.md or profile.yml is edited.
const P = {
  primaryRoles: ['manufacturing engineer', 'automation engineer', 'robotics engineer'],
  secondaryRoles: ['process engineer', 'quality engineer'],
  archetypes: [],
  industries: ['semiconductor / semiconductor capital equipment', 'robotics / industrial automation'],
  excludedIndustries: ['automotive', 'software / cs (pure software roles)'],
  skills: new Set(['solidworks', 'cnc', 'gdt', 'robotics', 'cobot', 'vision', 'automation', 'fixture']),
  compTarget: 100000,
  compFloor: 80000,
  hubs: ['austin, tx (applied materials hq)', 'phoenix, az (intel, tsmc)'],
  sponsorshipNeeded: true,
};

const LONG = 'We are hiring. '.repeat(30);
const job = (o) => ({
  title: '', company: '', location: 'Austin, TX', description: LONG, salary: null,
  triage: { flags: {}, experience: { level: 'unknown', years: null }, visa: {}, locationBucket: 'us' },
  ...o,
});

console.log('\n🧪 fit: alias matching');

// These three collisions are why matching is boundary-anchored: each one would
// otherwise credit a skill the posting never mentions.
checkTrue('"across" does not match ROS', !skillMentioned({ a: ['ros'] }, 'work across teams'));
checkTrue('"camera" does not match CAM', !skillMentioned({ a: ['cam'] }, 'camera alignment rig'));
checkTrue('"fabricate" does not match FAB', !skillMentioned({ a: ['fab'] }, 'fabricate the bracket'));
checkTrue('real mentions still match', skillMentioned({ a: ['cnc'] }, 'operate CNC mills'));
checkTrue('inflections match', skillMentioned({ a: ['fixture'] }, 'design fixtures'));
checkTrue('stems match', skillMentioned({ a: ['rapid prototyp'] }, 'rapid prototyping'));

console.log('\n🧪 fit: seniority is not a keyword problem');

// The failure that motivated the whole module: by keyword relevance these two
// score identically, because the words are the same. Only one is applyable.
const grad = scoreFit(job({ title: 'Manufacturing Engineer I', description: LONG + ' solidworks cnc gd&t' }), P);
const staff = scoreFit(job({ title: 'Senior Staff Manufacturing Engineer', description: LONG + ' solidworks cnc gd&t' }), P);
checkTrue('entry-level outranks the senior twin', grad.score > staff.score);
checkTrue('senior title scores 0 on seniority',
  staff.breakdown.find(b => b.dimension === 'seniority').points === 0);

const tenYears = scoreFit(job({
  title: 'Manufacturing Engineer',
  triage: { flags: {}, experience: { level: 'exclude', years: 10 }, visa: {}, locationBucket: 'us' },
}), P);
checkTrue('10-years-required scores 0 on seniority',
  tenYears.breakdown.find(b => b.dimension === 'seniority').points === 0);

console.log('\n🧪 fit: unjudgeable dimensions leave the denominator');

// Scoring a missing dimension as zero would punish a job for its employer's
// disclosure policy rather than for being a bad match.
const noPay = scoreFit(job({ title: 'Manufacturing Engineer' }), P);
check('compensation is not judged without a salary',
  noPay.breakdown.find(b => b.dimension === 'compensation').judged, false);

const paidWell = scoreFit(job({ title: 'Manufacturing Engineer', salary: { min: 120000, max: 150000, currency: 'USD' } }), P);
const paidBadly = scoreFit(job({ title: 'Manufacturing Engineer', salary: { min: 40000, max: 55000, currency: 'USD' } }), P);
checkTrue('above-target pay beats below-floor pay', paidWell.score > paidBadly.score);
check('below-floor pay scores 0',
  paidBadly.breakdown.find(b => b.dimension === 'compensation').points, 0);

console.log('\n🧪 fit: evidence and blocking');

const titleOnly = scoreFit(job({ title: 'Manufacturing Engineer', description: '' }), P);
check('a title-only posting reports title-only confidence', titleOnly.confidence, 'title-only');
check('skills cannot be judged without a description',
  titleOnly.breakdown.find(b => b.dimension === 'skills').judged, false);
const read = scoreFit(job({ title: 'Manufacturing Engineer', description: LONG + ' solidworks cnc' }), P);
checkTrue('a fully-read posting outranks its title-only twin', read.score > titleOnly.score);

// A hard block is never folded into the number — it is stated.
const blocked = scoreFit(job({
  title: 'Manufacturing Engineer',
  triage: { flags: { hardBlock: true }, experience: { level: 'entry', years: null },
    visa: { block: { reason: 'ITAR: requires US person status' } }, locationBucket: 'us' },
}), P);
check('blocked jobs get the blocked band', blocked.band, 'blocked');
check('the blocker reason is surfaced verbatim', blocked.blockers, ['ITAR: requires US person status']);

// F-438. Applied Intuition "Mechanical Engineer - New Grad (December 2026)"
// carried f_grad_mismatch = 1 AND fit_score 99 / strong / not blocked at the
// same time, so the row he cannot be considered for sat at the top of his deck
// looking like the best thing in the store. A stated window he falls outside
// of is a bar of the same kind as a work-auth restriction.
const gradMiss = scoreFit(job({
  title: 'Mechanical Engineer - New Grad',
  triage: {
    flags: { gradMismatch: true }, experience: { level: 'entry', years: null },
    program: { gradNote: 'Posting states a graduation window you fall outside of (you: 5/2027).' },
    locationBucket: 'us',
  },
}), P);
check('a graduation mismatch bands as blocked', gradMiss.band, 'blocked');
check('…and says which window, in the posting\'s own terms',
  gradMiss.blockers, ['Posting states a graduation window you fall outside of (you: 5/2027).']);
// Silence is not a restriction: a posting that states no window is untouched.
const noWindow = scoreFit(job({
  title: 'Mechanical Engineer - New Grad',
  triage: { flags: {}, experience: { level: 'entry', years: null }, locationBucket: 'us' },
}), P);
check('a posting with no stated window is not blocked', noWindow.band === 'blocked', false);

console.log('\n🧪 fit: profile drives the ranking');

const excluded = scoreFit(job({ title: 'Manufacturing Engineer', company: 'Some Automotive Co',
  description: LONG + ' automotive assembly plant' }), P);
check('an excluded industry scores 0 on industry',
  excluded.breakdown.find(b => b.dimension === 'industry').points, 0);

// The exclusion asks what the ROLE IS, not what the employer sells. As a bare
// substring test over the whole description it caught 37% of the top 400 deck
// postings — every chip company writes "serving automotive, industrial and
// consumer markets", and every modern engineering JD mentions software — so
// Fab Automation Engineer and Manufacturing Engineer were scoring 0/10 on
// industry for boilerplate in a paragraph about end markets.
const endMarkets = scoreFit(job({ title: 'Fab Automation Engineer', company: 'GlobalFoundries',
  description: LONG + ' Our chips serve automotive, industrial and consumer markets. You will interface with software teams.' }), P);
check('end-market boilerplate is not an excluded industry',
  endMarkets.breakdown.find(b => b.dimension === 'industry').points > 0, true);

const reallySoftware = scoreFit(job({ title: 'Senior Software Engineer, Backend', company: 'Acme',
  description: LONG }), P);
check('a genuinely excluded ROLE still scores 0',
  reallySoftware.breakdown.find(b => b.dimension === 'industry').points, 0);

const reallyAuto = scoreFit(job({ title: 'Automotive Test Engineer', company: 'Acme', description: LONG }), P);
check('an excluded role is caught from the title',
  reallyAuto.breakdown.find(b => b.dimension === 'industry').points, 0);

console.log('\n🧪 fit: pay is judged on what HE would be offered');

// A GlobalFoundries "2027 New College Graduate" req posting $58,000–$101,000
// scored 9/10 — "at or above target" — because only the top of the band was
// read. Those bands cover Engineer I through III; a May-2027 graduate lands at
// the bottom, which is $22k under his floor. Reading the ceiling as the offer
// is the same class of error as reading a funding round as a salary.
const payJob = (title, salary, newGrad) => job({
  title, description: LONG, salary,
  triage: { flags: { newGrad: !!newGrad }, experience: { level: newGrad ? 'entry' : 'unknown' }, visa: {}, locationBucket: 'us' },
});
const comp = (j) => scoreFit(j, P).breakdown.find(b => b.dimension === 'compensation');

check('a wide band on a new-grad req is judged at the bottom',
  comp(payJob('Manufacturing Engineer (2027 New College Graduate)', { min: 58000, max: 101000 }, true)).points, 0);
check('…and says the band starts low rather than quoting the ceiling',
  /band starts at \$58k/.test(comp(payJob('Manufacturing Engineer (2027 New College Graduate)', { min: 58000, max: 101000 }, true)).why[0]), true);
check('a genuinely good band still scores',
  comp(payJob('Manufacturing Engineer New College Grad', { min: 100000, max: 130000 }, true)).points >= 9, true);
check('a single stated figure is used as-is',
  comp(payJob('Manufacturing Engineer New College Grad', { min: 95000, max: 95000 }, true)).points, 5);
check('no pay stated leaves the dimension unjudged',
  scoreFit(job({ title: 'Manufacturing Engineer', description: LONG }), P)
    .breakdown.find(b => b.dimension === 'compensation').judged, false);

console.log('\n🧪 fit: the field rides along with the score');
const robo = scoreFit(job({ title: 'Robotics Engineer', company: 'Figure',
  description: LONG + ' humanoid manipulation, motion planning, end effector design' }), P);
check('a priority field is reported', robo.field, 'robotics');
check('…and scores full marks on industry',
  robo.breakdown.find(b => b.dimension === 'industry').points, 10);
const fab = scoreFit(job({ title: 'Process Engineer', company: 'GlobalFoundries',
  description: LONG + ' semiconductor wafer fab lithography etch cleanroom metrology' }), P);
check('a non-priority target industry scores 8',
  fab.breakdown.find(b => b.dimension === 'industry').points, 8);
check('…and is classified, just not prioritised', fab.field, 'semiconductor');

// The gap is deliberately small: two points out of a hundred. It breaks ties
// between comparable jobs; it must not let a weak robotics posting outrank a
// strong fab one, which is what the deck spread is for.
check('the priority edge is 2 points, not a thumb on the scale',
  robo.breakdown.find(b => b.dimension === 'industry').points
  - fab.breakdown.find(b => b.dimension === 'industry').points, 2);
check('an excluded role still reports its field', reallyAuto.field !== undefined, true);

const offshore = scoreFit(job({ title: 'Manufacturing Engineer', location: 'Penang, Malaysia',
  triage: { flags: {}, experience: { level: 'unknown', years: null }, visa: {}, locationBucket: 'non-us' } }), P);
check('a non-US location scores 0 on location',
  offshore.breakdown.find(b => b.dimension === 'location').points, 0);

const offTarget = scoreFit(job({ title: 'Staff Accountant', description: LONG }), P);
checkTrue('an unrelated role lands in the low band', offTarget.score < 40);

console.log('\n🧪 fit: bands');
check('96 is strong', bandFor(96).key, 'strong');
check('60 is good', bandFor(60).key, 'good');
check('45 is fair', bandFor(45).key, 'fair');
check('10 is low', bandFor(10).key, 'low');

console.log('\n🧪 fit: real profile loads');
const real = loadProfile();
checkTrue('skills are read from cv.md', real.skills.size > 10);
checkTrue('target roles are read from profile.yml', real.primaryRoles.length > 0);
checkTrue('a comp target is read from profile.yml', real.compTarget > 0);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
