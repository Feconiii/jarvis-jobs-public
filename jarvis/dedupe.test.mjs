#!/usr/bin/env node
// jarvis/dedupe.test.mjs — one posting, one card, and never two postings made
// into one (F-406).
//
// The whole risk in dedupe.mjs is the second direction. Merging two rows that
// are really one posting tidies his deck; merging two rows that are two
// postings makes a real job disappear, which this project calls the bug that
// must not exist. So most of this file is the cases that must NOT merge.
//
// Run: node jarvis/dedupe.test.mjs
import { reqIdOf, reqPlatformOf, failingCopyPointers, copyShaped, undoPlan, normReqId, duplicateGroups, linkedinCopyGroups, pathShape, placeKey, repostGroups, handledRoleGroups, employerOf, decisionRank, hidesHisDecision } from './dedupe.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  cond ? pass += 1 : fail += 1;
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

// The real requisition reader, loaded the way the dashboard loads it.
import vm from 'node:vm';
import { readFileSync } from 'fs';
const ctx = { URL, globalThis: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('./extension/ats.js', import.meta.url), 'utf-8'), ctx);
const reqToken = (u) => ctx.__jarvisAts.reqToken(u);

const row = (id, url, extra = {}) => ({
  id, url, company: 'Zipline', title: 'Mechanical Engineer, RF Systems',
  location: 'South San Francisco, California', lastSeen: '2026-09-07T00:00:00.000Z', status: 'new', ...extra,
});

console.log('🧪 the path, once the requisition is taken out of it');
eq('the two Zipline spellings are one path',
  [pathShape('https://www.zipline.com/open-roles?gh_jid=7868140003', 'greenhouse:7868140003'),
    pathShape('https://www.zipline.com/open-roles/7868140003?gh_jid=7868140003', 'greenhouse:7868140003')],
  ['open-roles', 'open-roles']);
ok('two Workday cities are two paths',
  pathShape('https://nvidia.wd5.myworkdayjobs.com/Site/job/Germany-Munich/X_JR2020552', 'workday:JR2020552')
  !== pathShape('https://nvidia.wd5.myworkdayjobs.com/Site/job/Switzerland-Remote/X_JR2020552', 'workday:JR2020552'));
eq('a URL that will not parse is left as itself', pathShape('not a url', 'x'), 'not a url');

console.log('\n🧪 what is ONE posting');
{
  const groups = duplicateGroups([
    row('a', 'https://www.zipline.com/open-roles?gh_jid=7868140003', { lastSeen: '2026-09-03T00:00:00.000Z' }),
    row('b', 'https://www.zipline.com/open-roles/7868140003?gh_jid=7868140003', { lastSeen: '2026-09-07T00:00:00.000Z' }),
  ], reqToken);
  eq('the board changed its URL shape, so this is one posting', groups.length, 1);
  eq('the row still being listed is the one kept', groups[0]?.keep.id, 'b');
  eq('…and the older spelling is the one pointed at it', groups[0]?.stale.map((r) => r.id), ['a']);
}

console.log('\n🧪 what is NOT one posting');
{
  // NVIDIA and KLA: one requisition, several cities. Two real choices.
  const nvidia = duplicateGroups([
    row('a', 'https://nvidia.wd5.myworkdayjobs.com/Site/job/Germany-Munich/Sales_JR2020552', { company: 'NVIDIA', title: 'Sales (2 Locations)', location: 'Multiple', lastSeen: '2026-08-04T00:00:00.000Z' }),
    row('b', 'https://nvidia.wd5.myworkdayjobs.com/Site/job/Switzerland-Remote/Sales_JR2020552', { company: 'NVIDIA', title: 'Sales (2 Locations)', location: 'Multiple', lastSeen: '2026-08-24T00:00:00.000Z' }),
  ], reqToken);
  eq('one requisition in two cities stays two rows', nvidia.length, 0);

  const titles = duplicateGroups([
    row('a', 'https://www.zipline.com/open-roles?gh_jid=1', { title: 'Mechanical Engineer', lastSeen: '2026-09-01T00:00:00.000Z' }),
    row('b', 'https://www.zipline.com/open-roles?gh_jid=2', { title: 'Mechanical Engineer', lastSeen: '2026-09-07T00:00:00.000Z' }),
  ], reqToken);
  eq('the same title with different requisitions stays two rows', titles.length, 0);

  const companies = duplicateGroups([
    row('a', 'https://www.zipline.com/open-roles?gh_jid=7868140003', { company: 'Zipline', lastSeen: '2026-09-01T00:00:00.000Z' }),
    row('b', 'https://www.zipline.com/open-roles?gh_jid=7868140003', { company: 'Somebody Else', lastSeen: '2026-09-07T00:00:00.000Z' }),
  ], reqToken);
  eq('two employers are never merged, whatever the id says', companies.length, 0);

  const noToken = duplicateGroups([
    row('a', 'https://careers.example.test/about-us', { lastSeen: '2026-09-01T00:00:00.000Z' }),
    row('b', 'https://careers.example.test/about-us-2', { lastSeen: '2026-09-07T00:00:00.000Z' }),
  ], reqToken);
  eq('no requisition, no claim', noToken.length, 0);

  const equallyFresh = duplicateGroups([
    row('a', 'https://www.zipline.com/open-roles?gh_jid=7868140003'),
    row('b', 'https://www.zipline.com/open-roles/7868140003?gh_jid=7868140003'),
  ], reqToken);
  eq('two rows the board listed on the same day are both left alone', equallyFresh.length, 0);
}

console.log('\n🧪 employers\' own application sites name their posting (R2)');
{
  const isAts = (u) => ctx.__jarvisAts.isAtsHost(u);
  // Shapes from his own store and answer log (2026-11-06).
  eq('Tesla: a posting page, its renamed slug, a bare id and the apply page are one posting',
    ['https://www.tesla.com/careers/search/job/automation-controls-development-engineer-software-optimus-terafab-268943',
      'https://www.tesla.com/careers/search/job/controls-software-engineer-268943',
      'https://www.tesla.com/careers/search/job/-268943',
      'https://www.tesla.com/careers/search/job/apply/268943',
      'https://www.tesla.com/careers/search/job/apply/268943?source=x'].map(reqToken),
    ['tesla:268943', 'tesla:268943', 'tesla:268943', 'tesla:268943', 'tesla:268943']);
  ok('…and two Tesla postings are two', reqToken('https://www.tesla.com/careers/search/job/apply/268943') !== reqToken('https://www.tesla.com/careers/search/job/apply/238852'));
  eq('Tesla pages that name no posting carry no id', ['https://www.tesla.com/modely', 'https://www.tesla.com/careers/search/?query=engineer', 'https://www.tesla.com/careers/search/job/apply/'].map(reqToken), [null, null, null]);
  eq('Paylocity: details and apply (with or without the company) are one posting',
    ['https://recruiting.paylocity.com/Recruiting/Jobs/Details/1051202', 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/1051202', 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/1051202/SYNCARDIA-SYSTEMS-LLC?source=y'].map(reqToken),
    ['paylocity:1051202', 'paylocity:1051202', 'paylocity:1051202']);
  eq('Google: both careers addresses, slugged or bare',
    ['https://careers.google.com/jobs/results/100005083189519046-distinguished-engineer/', 'https://www.google.com/about/careers/applications/jobs/results/100005083189519046', 'https://www.google.com/about/careers/applications/jobs/results/100005083189519046-distinguished-engineer'].map(reqToken),
    ['google:100005083189519046', 'google:100005083189519046', 'google:100005083189519046']);
  eq('…never a Google search or any other Google page', ['https://www.google.com/search?q=jobs+results+100005083189519046', 'https://www.google.com/maps'].map(reqToken), [null, null]);
  eq('Meta', reqToken('https://www.metacareers.com/jobs/4596319193960098'), 'meta:4596319193960098');
  // Not application SITES: the table that decides where Jarvis acts is unchanged.
  eq('none of these hosts counts as an application site', ['https://www.tesla.com/careers/search/job/apply/268943', 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/1051202', 'https://careers.google.com/jobs/results/100005083189519046-x/', 'https://www.metacareers.com/jobs/4596319193960098'].map(isAts), [false, false, false, false]);
  // The Tesla pair from his store (2026-11-06): one requisition under two slugs.
  const groups = duplicateGroups([
    row('t1', 'https://www.tesla.com/careers/search/job/controls-software-engineer-268943', { company: 'Tesla', title: 'Automation & Controls Development Engineer, Software, Optimus & Terafab', location: 'Austin, TX', lastSeen: '2026-09-20T00:00:00.000Z' }),
    row('t2', 'https://www.tesla.com/careers/search/job/automation-controls-development-engineer-software-optimus-terafab-268943', { company: 'Tesla', title: 'Automation & Controls Development Engineer, Software, Optimus & Terafab', location: 'Austin, TX', lastSeen: '2026-09-27T00:00:00.000Z' }),
  ], reqToken);
  eq('a Tesla posting under a renamed slug is one posting, the newer spelling kept', [groups.length, groups[0]?.keep.id, groups[0]?.stale.map((r) => r.id)], [1, 't2', ['t1']]);
  // NEVER TWO POSTINGS MADE ONE (review): same company, same title, ids one apart, near-identical addresses.
  const pair = (co, u1, u2) => duplicateGroups([
    row('x1', u1, { company: co, title: 'Mechanical Design Engineer', location: 'Austin, TX', lastSeen: '2026-09-20T00:00:00.000Z' }),
    row('x2', u2, { company: co, title: 'Mechanical Design Engineer', location: 'Austin, TX', lastSeen: '2026-09-27T00:00:00.000Z' }),
  ], reqToken).length;
  eq('Tesla, Google, Meta and Paylocity: adjacent ids are two postings, whatever else matches', [
    pair('Tesla', 'https://www.tesla.com/careers/search/job/mechanical-design-engineer-268943', 'https://www.tesla.com/careers/search/job/mechanical-design-engineer-268944'),
    pair('Google', 'https://careers.google.com/jobs/results/100005083189519046-mechanical-design-engineer/', 'https://careers.google.com/jobs/results/100005083189519047-mechanical-design-engineer/'),
    pair('Meta', 'https://www.metacareers.com/jobs/4596319193960098', 'https://www.metacareers.com/jobs/4596319193960099'),
    pair('Acme', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1051202', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/1051203'),
  ], [0, 0, 0, 0]);
  eq('a Tesla slug that ends in a year still gives the posting id, not the year',
    reqToken('https://www.tesla.com/careers/search/job/internship-mechanical-engineer-summer-2026-268943'), 'tesla:268943');
  eq('a Tesla slug ending in a year and no id gives none', reqToken('https://www.tesla.com/careers/search/job/internship-summer-2026'), null);
  eq('a Google number under six digits is not a posting id', reqToken('https://careers.google.com/jobs/results/12345-engineer/'), null);
  eq('a Paylocity id that is not a number is not one', reqToken('https://recruiting.paylocity.com/Recruiting/Jobs/Details/abc123'), null);
}

console.log('\n🧪 three spellings collapse to the newest, not to a chain');
{
  const groups = duplicateGroups([
    row('a', 'https://www.zipline.com/open-roles?gh_jid=7868140003', { lastSeen: '2026-08-01T00:00:00.000Z' }),
    row('b', 'https://www.zipline.com/open-roles/7868140003?gh_jid=7868140003', { lastSeen: '2026-09-07T00:00:00.000Z' }),
    row('c', 'https://www.zipline.com/open-roles/?gh_jid=7868140003', { lastSeen: '2026-08-20T00:00:00.000Z' }),
  ], reqToken);
  eq('one group', groups.length, 1);
  eq('kept', groups[0]?.keep.id, 'b');
  eq('both older spellings point at it', groups[0]?.stale.map((r) => r.id).sort(), ['a', 'c']);
}


console.log('');
console.log('🧪 the same requisition, bare and slugged, is ONE posting (F-451)');
// iCIMS publishes both. Before this, the slug segment made two shapes and 133
// Joby postings drew twice in his deck.
{
  const rows = [
    { id: 'a', url: 'https://careers-jobyaviation.icims.com/jobs/4895/job',
      company: 'Joby Aviation', title: 'Battery Module Senior Manufacturing Engineer',
      location: 'US-CA-San Carlos', lastSeen: '2026-09-09' },
    { id: 'b', url: 'https://careers-jobyaviation.icims.com/jobs/4895/battery-module-senior-manufacturing-engineer/job',
      company: 'Joby Aviation', title: 'Battery Module Senior Manufacturing Engineer',
      location: 'US-CA-San Carlos', lastSeen: '2026-09-10' },
  ];
  const groups = duplicateGroups(rows, (u) => (u.match(/\/jobs\/(\d+)\//) || [])[1] && 'icims:' + u.match(/\/jobs\/(\d+)\//)[1]);
  ok('one group', groups.length === 1, `got ${groups.length}`);
  ok('the row still listed wins', groups[0]?.keep.id === 'b', `kept ${groups[0]?.keep.id}`);
  ok('the bare spelling is the stale one', groups[0]?.stale.length === 1 && groups[0].stale[0].id === 'a');
}

console.log('');
console.log('🧪 …and a location segment is still NOT dropped');
// The whole risk in this file is merging two postings that are not the same
// one. Dropping the title slug must not weaken that: KLA lists one requisition
// in two cities and both are real choices for him.
{
  const rows = [
    { id: 'ann', url: 'https://kla.wd1.myworkdayjobs.com/en-US/Search/job/Ann-Arbor/Spares-Demand-Planner-2_2637175',
      company: 'KLA', title: 'Spares Demand Planner 2', location: 'Ann Arbor', lastSeen: '2026-09-10' },
    { id: 'phx', url: 'https://kla.wd1.myworkdayjobs.com/en-US/Search/job/Phoenix/Spares-Demand-Planner-2_2637175',
      company: 'KLA', title: 'Spares Demand Planner 2', location: 'Phoenix', lastSeen: '2026-09-10' },
  ];
  const groups = duplicateGroups(rows, () => 'workday:2637175');
  ok('two cities stay two postings', groups.length === 0, `got ${groups.length} group(s)`);
}

console.log('');
console.log('🧪 a segment that merely CONTAINS the title is kept');
// The filter is an equality test on purpose. "battery-module-engineer-munich"
// is not the title, it is a place, and dropping it would merge two cities.
{
  const shape = pathShape(
    'https://x.test/jobs/4895/battery-module-engineer-munich/job',
    'icims:4895',
    'Battery Module Engineer',
  );
  ok('the longer segment survives', shape.includes('munich'), `got ${shape}`);
}


console.log('');
console.log('🧪 one place, its words in another order (Lam, 2026-09-24)');
{
  const lam = (id, url, location, lastSeen) => ({ id, url, company: 'Lam Research', title: 'Mechanical Engineer 2', location, lastSeen });
  const groups = duplicateGroups([
    lam('old', 'https://careers.lamresearch.com/careers/job/1099555830739-mechanical-engineer-2-?domain=lamresearch.com', 'Tualatin, OR,US, US', '2026-08-29'),
    lam('new', 'https://careers.lamresearch.com/careers/job/1099555830739-mechanical-engineer-2-us-or-tualatin-1034-?domain=lamresearch.com', 'US OR Tualatin', '2026-09-25'),
  ], () => 'eightfold:1099555830739');
  ok('one requisition, two spellings of Tualatin: one posting', groups.length === 1 && groups[0].keep.id === 'new', JSON.stringify(groups));
  eq('placeKey ignores order and repeats', placeKey('Tualatin, OR,US, US'), placeKey('US OR Tualatin'));
  ok('…and two cities are still two', placeKey('Ann Arbor') !== placeKey('Phoenix'));
}

console.log('');
console.log('🧪 reposts: a closed card folds into the repost, and only then');
{
  const gf = (id, req, lastSeen, extra = {}) => ({
    id, url: `https://globalfoundries.wd1.myworkdayjobs.com/External/job/USA---New-York---Malta/Advanced-Manufacturing-Equipment-Engineer--2027-New-College-Graduate-_JR-${req}`,
    company: 'GlobalFoundries', title: 'Advanced Manufacturing Equipment Engineer (2027 New College Graduate)',
    location: 'USA - New York - Malta', lastSeen, status: 'interested', goneAt: '2026-09-01', ...extra,
  });
  const tok = (u) => 'workday:' + (u.match(/_(JR-?\d+)$/) || [])[1];
  const six = repostGroups([gf('a', 2604707, '2026-08-19'), gf('b', 2604703, '2026-08-24'), gf('c', 2604706, '2026-08-29'), gf('d', 2604770, '2026-08-21')], tok);
  ok('four closed reposts: one card left, the one seen last', six.length === 1 && six[0].keep.id === 'c' && six[0].stale.length === 3, JSON.stringify(six.map((g) => [g.keep.id, g.stale.map((r) => r.id)])));

  const live = repostGroups([gf('old', 2604707, '2026-08-19'), gf('new', 2604703, '2026-08-24', { goneAt: null })], tok);
  ok('a posting still listed is the one kept', live[0]?.keep.id === 'new' && live[0].stale[0].id === 'old');

  const bothLive = repostGroups([gf('x', 2604707, '2026-09-19', { goneAt: null }), gf('y', 2604703, '2026-09-24', { goneAt: null })], tok);
  ok('two live postings with one title are two jobs', bothLive.length === 0);

  const applied = repostGroups([gf('mine', 2604707, '2026-08-19', { status: 'applied' }), gf('new', 2604703, '2026-09-24', { goneAt: null })], tok);
  ok('a card he applied to is never folded away', applied.length === 0);

  const place = repostGroups([gf('ny', 2604707, '2026-08-19'), gf('vt', 2604703, '2026-09-24', { goneAt: null, location: 'USA - Vermont - Essex Junction', url: 'https://globalfoundries.wd1.myworkdayjobs.com/External/job/USA---Vermont---Essex-Junction/Advanced-Manufacturing-Equipment-Engineer--2027-New-College-Graduate-_JR-2604703' })], tok);
  ok('the same title in another city is another job', place.length === 0);

  const unseen = repostGroups([gf('mine', 2604707, '2026-08-19'), gf('repost', 2604703, '2026-09-24', { goneAt: null, status: 'new' })], tok);
  ok('one card of his beside a repost he never opened is not a duplicate', unseen.length === 0);

  const hidden = repostGroups([gf('hid', 2604707, '2026-08-19', { status: 'hidden' }), gf('a', 2604703, '2026-08-24'), gf('b', 2604706, '2026-09-24', { goneAt: null })], tok);
  ok('a hidden card is never folded (its reason trains the ranker)', hidden.length === 1 && hidden[0].stale.map((r) => r.id).join() === 'a', JSON.stringify(hidden));

  const kla = repostGroups([
    gf('rejected', 2636966, '2026-09-25', { goneAt: null, status: 'rejected' }),
    gf('newer-unseen', 2638462, '2026-09-25', { goneAt: null, status: 'new' }),
    gf('interested', 2635066, '2026-08-08'),
  ], tok);
  ok('the card that stays is his, not an unseen repost', kla[0]?.keep.id === 'rejected' && kla[0].stale[0].id === 'interested', JSON.stringify(kla));

  const noTok = repostGroups([gf('a', 1, '2026-08-19'), gf('b', 2, '2026-09-24', { goneAt: null })], () => '');
  ok('no requisition, no claim', noTok.length === 0);
}

console.log('\n🧪 his row survives, and no merge hides more of his than it keeps (review, 2026-11-06)');
{
  // Etched's /Etched/ and /etched/ spellings, from his store: he applied on the older one.
  const a = row('a', 'https://jobs.ashbyhq.com/Etched/4020db7a-1ec0-48e3-9bbd-f1337c63a403', { company: 'Etched', title: 'Build Engineer', location: 'San Jose, CA', status: 'applied', lastSeen: '2026-10-01T00:00:00.000Z' });
  const b = row('b', 'https://jobs.ashbyhq.com/etched/4020db7a-1ec0-48e3-9bbd-f1337c63a403', { company: 'Etched', title: 'Build Engineer', location: 'San Jose, CA', status: 'inbox', lastSeen: '2026-11-01T00:00:00.000Z' });
  const g = duplicateGroups([a, b], reqToken);
  eq('the applied spelling is the survivor, though the board lists the other more recently', [g[0]?.keep.id, g[0]?.stale.map((r) => r.id)], ['a', ['b']]);
  const same = duplicateGroups([{ ...a, status: 'new' }, { ...b, status: 'new' }], reqToken);
  eq('with nothing of his on either, the newest is kept as before', same[0]?.keep.id, 'b');
  const tie = duplicateGroups([{ ...a, status: 'applied', lastSeen: b.lastSeen }, b], reqToken);
  eq('seen equally recently, the row with less of his is still pointed at the one with more', [tie[0]?.keep.id, tie[0]?.stale.map((r) => r.id)], ['a', ['b']]);
  eq('decision ranks: the pipeline, then his lists, then a hide, then nothing',
    ['offer', 'interview', 'responded', 'applied', 'rejected', 'inbox', 'interested', 'queued', 'hidden', 'new', undefined].map(decisionRank), [9, 8, 7, 6, 5, 4, 4, 4, 1, 0, 0]);
  ok('a rejected application behind a new row is refused', hidesHisDecision('rejected', 'new'));
  ok('…and an applied one behind an inbox card', hidesHisDecision('applied', 'inbox'));
  ok('a decision carried across hides nothing', !hidesHisDecision('interested', 'new', { carried: 'interested' }));
  ok('the same decision, or a stronger one, on the survivor hides nothing', !hidesHisDecision('inbox', 'inbox') && !hidesHisDecision('inbox', 'applied'));
  ok('the same rank is not the same decision: an inbox card behind a heart is refused (review, 2026-11-06)', hidesHisDecision('inbox', 'interested') && hidesHisDecision('queued', 'inbox'));
  ok('a repost\'s closed list card is hidden on purpose', !hidesHisDecision('interested', 'new', { repost: true }));
  ok('…but never an application on a repost', hidesHisDecision('applied', 'new', { repost: true }));
}

console.log('\n🧪 requisition ids, and an undo of exactly one run (review, 2026-11-03)');
eq('ids are normalised, then compared exactly', ['R07540', 'JR-7540', 'REQ7540', 'R71234'].map(normReqId), ['7540', '7540', '7540', '71234']);
// A trailing "-1" is a repost marker only on Workday (review, 2026-11-03).
eq('Workday "_R7540-1" is R7540 posted again', reqIdOf('u', () => 'workday:Cell-Operator_R7540-1'), reqIdOf('u', () => 'workday:Cell-Operator_R7540'));
eq('two employers\' Workday tenants are two numberings', reqPlatformOf('https://acme.wd5.myworkdayjobs.com/External/job/X/Engineer_R123') === reqPlatformOf('https://other.wd5.myworkdayjobs.com/Site/job/X/Engineer_R123'), false);
eq('…one tenant is one numbering', reqPlatformOf('https://acme.wd5.myworkdayjobs.com/External/job/X/A_R1') === reqPlatformOf('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Y/B_R2'), true);
eq('two Greenhouse boards are two numberings', reqPlatformOf('https://job-boards.greenhouse.io/acme/jobs/4001') === reqPlatformOf('https://job-boards.greenhouse.io/other/jobs/4001'), false);
eq('hosts under one registrable domain are one numbering (careers.x.com, jobs.x.com)', reqPlatformOf('https://careers.x.com/job/1', () => null) === reqPlatformOf('https://jobs.x.com/job/2', () => null), true);
eq('…elsewhere "1234-1" is not "1234"', reqIdOf('u', () => 'smartrecruiters:1234-1') === reqIdOf('u', () => 'smartrecruiters:1234'), false);
{
  const m = { stale: 'S', keep: 'K', carried: 'interested', keepPrior: { status: 'new', statusChangedAt: null } };
  eq('a pointer this run set, still in place, is cleared; its carried status goes back',
    undoPlan(m, { stale: { superseded_by: 'K' }, keep: { status: 'interested' } }), { unmark: true, restore: true });
  eq('a pointer moved since is left alone', undoPlan(m, { stale: { superseded_by: 'OTHER' }, keep: { status: 'interested' } }).unmark, false);
  eq('a status he changed since is not overwritten', undoPlan(m, { stale: { superseded_by: 'K' }, keep: { status: 'applied' } }).restore, false);
  eq('a merge that carried nothing restores nothing', undoPlan({ ...m, carried: null, keepPrior: null }, { stale: { superseded_by: 'K' }, keep: { status: 'new' } }), { unmark: true, restore: false });
}

{
  const r = (id, source, url, title, location = 'US-CA-Santa Cruz') => ({ id, source, url, company: 'Joby Aviation', title, location });
  const pair = { stale: r('B', 'browser-assist', 'https://careers-jobyaviation.icims.com/jobs/3933/job', 'Performance Lead/DER'), keep: r('I', 'icims', 'https://careers-jobyaviation.icims.com/jobs/3933/performance-lead-der/job', 'Performance Lead Der') };
  eq('a pointer another rule set (titles differ) is not the copy rule\'s to judge', copyShaped(pair), false);
  const same = { stale: r('B2', 'browser-assist', 'https://careers-jobyaviation.icims.com/jobs/4850/job', 'Certification Project Engineer'), keep: r('I2', 'icims', 'https://careers-jobyaviation.icims.com/jobs/4850/x/job', 'Certification Project Engineer', 'Somewhere else') };
  eq('equal requisition ids prove the merge, even where the place check disagrees', failingCopyPointers([same]).length, 0);
  const wrong = { stale: r('B3', 'browser-assist', 'https://www.example.com/careers/open-positions/R7209', 'Cell Operator'), keep: r('W3', 'workday', 'https://x.wd5.myworkdayjobs.com/x/job/Y/Cell-Operator_R7540', 'Cell Operator') };
  eq('a pointer between two requisitions is flagged', failingCopyPointers([wrong]).map((p) => p.stale.id), ['B3']);
}

console.log('\n🧪 a LinkedIn copy of a posting its own board carries is pointed at the board row (F-674)');
{
  const li = (id, location, status = 'inbox') => ({ id, source: 'linkedin', url: `https://www.linkedin.com/jobs/view/x-${id}`, company: 'Brooks Automation', title: 'Controls Engineer', location, status });
  const board = (id, location, extra = {}) => ({ id, source: 'workday', url: `https://brooksauto.wd1.myworkdayjobs.com/x/${id}`, company: 'Brooks Automation', title: 'Controls Engineer', location, status: 'applied', ...extra });
  const g = linkedinCopyGroups([li('L1', 'Chelmsford, MA'), board('W1', 'Chelmsford MA')]);
  eq('the copy he could see is pointed at the board row he applied to', g.map((x) => [x.keep.id, x.stale.map((s) => s.id)]), [['W1', ['L1']]]);
  eq('another city is another opening, not a copy', linkedinCopyGroups([li('L2', 'Phoenix, AZ'), board('W2', 'Chelmsford MA')]).length, 0);
  eq('a board row that is gone still takes the copy (Phoenix Tailings)',
    linkedinCopyGroups([li('L3', 'Exeter, NH'), board('W3', 'Exeter, NH', { goneAt: '2026-10-02' })])[0]?.keep.id, 'W3');
  eq('a live board row is preferred to a gone one',
    linkedinCopyGroups([li('L4', 'Exeter, NH'), board('W4', 'Exeter, NH', { goneAt: '2026-10-02' }), board('W5', 'Exeter, NH', { lastSeen: '2026-10-03' })])[0]?.keep.id, 'W5');
  eq('two LinkedIn rows and no board row: nothing to point at', linkedinCopyGroups([li('L6', 'Exeter, NH'), li('L7', 'Exeter, NH')]).length, 0);
  // 2026-11-03: a browser-assist copy beside the employer's Workday row (Symbotic).
  const ba = { id: 'B1', source: 'browser-assist', url: 'https://www.symbotic.com/careers/x', company: 'Brooks Automation', title: 'Controls Engineer', location: 'Chelmsford, MA', status: 'new' };
  const sy = (id, url, source) => ({ id, source, url, company: 'Symbotic', title: 'Cell Operator', location: 'USA Manchester, PA', status: 'new' });
  eq('a copy with ANOTHER requisition id is another posting (Symbotic R7209 vs R7540)',
    linkedinCopyGroups([sy('B2', 'https://www.symbotic.com/careers/open-positions/R7209', 'browser-assist'), sy('W9', 'https://symbotic.wd504.myworkdayjobs.com/Symbotic/job/USA-Manchester-PA/Cell-Operator_R7540', 'workday')]).length, 0);
  eq('…and the same id is a copy',
    linkedinCopyGroups([sy('B3', 'https://www.symbotic.com/careers/open-positions/R7540', 'browser-assist'), sy('W9', 'https://symbotic.wd504.myworkdayjobs.com/Symbotic/job/USA-Manchester-PA/Cell-Operator_R7540', 'workday')]).map((x) => x.stale[0].id), ['B3']);
  // Review (2026-11-03): with no requisition id on the copy there is no proof — no merge.
  eq('a browser-assist copy with no requisition id is NOT merged', linkedinCopyGroups([ba, board('W8', 'Chelmsford, MA', { status: 'new' })]).length, 0);
  const jb = (id, url, source) => ({ id, source, url, company: 'Joby Aviation', title: 'Senior Industrial Designer', location: 'Santa Cruz, CA, USA', status: 'new' });
  eq('iCIMS 5054 on both sides is a copy (Joby)', linkedinCopyGroups([jb('B5', 'https://careers-jobyaviation.icims.com/jobs/5054/job', 'browser-assist'), jb('I5', 'https://careers-jobyaviation.icims.com/jobs/5054/senior-industrial-designer/job', 'icims')]).map((x) => x.stale[0].id), ['B5']);
  eq('…R71234 is not 1234 (exact ids, no suffix match)', linkedinCopyGroups([jb('B6', 'https://careers.example.com/open-positions/R71234', 'browser-assist'), jb('I6', 'https://careers-jobyaviation.icims.com/jobs/1234/senior-industrial-designer/job', 'icims')]).length, 0);
}

console.log('\n🧪 a role he already handled is not listed again (F-715)');
{
  const r = (id, status, extra = {}) => ({ id, status, url: `https://x.test/${id}`, source: 'workday', company: 'Amazon', title: 'Innovation and Design Engineer', location: 'Bellevue, Washington, USA', lastSeen: '2026-10-01', ...extra });
  const folds = (rows) => handledRoleGroups(rows, reqToken).map((g) => [g.stale[0].id, g.keep.id]);
  eq('the same title in the same city as one he applied to folds into it (Amazon, six in Bellevue)',
    folds([r('A', 'applied'), r('B', 'new'), r('C', 'inbox')]), [['B', 'A'], ['C', 'A']]);
  eq('another city is another opening', folds([r('A', 'applied'), r('B', 'new', { location: 'Austin, Texas, USA' })]), []);
  eq('a hidden role: the copy in the same city goes with it', folds([r('H', 'hidden'), r('B', 'new')]), [['B', 'H']]);
  eq('two board rows with no place at all are not assumed to be one', folds([r('A', 'applied', { location: '' }), r('B', 'new', { location: '' })]), []);
  eq('nothing he has not handled is folded', folds([r('A', 'interested'), r('B', 'new')]), []);
  eq('an applied row never folds into anything', folds([r('A', 'applied'), r('B', 'applied')]), []);
  eq('applied wins over hidden as the card that stays', folds([r('H', 'hidden'), r('A', 'applied'), r('B', 'new')]), [['B', 'A']]);
  // Wolfspeed 26-798: the form page Jarvis recorded, with a street for a place.
  const wolf = 'https://cree.wd108.myworkdayjobs.com/EXT/job/Durham-North-Carolina/Manufacturing-Engineer_26-798';
  eq('the form page of the posting he applied to, by its requisition ("26-798" is a Workday id)',
    folds([r('W', 'applied', { company: 'Wolfspeed', title: 'Manufacturing Engineer', url: wolf, location: 'Durham, North Carolina' }),
      r('E', 'interested', { company: 'Wolfspeed', title: 'Manufacturing Engineer', source: 'extension', location: 'US NC Silicon Drive, United States of America',
        url: 'https://cree.wd108.myworkdayjobs.com/en-US/EXT/job/Durham%2C-North-Carolina/Manufacturing-Engineer_26-798/apply/autofillWithResume' })]), [['E', 'W']]);
  eq('a LinkedIn copy under the employer\'s regional page name (Legrand)',
    folds([r('O', 'applied', { company: 'Legrand', title: 'Manufacturing Engineer', source: 'oracle-orc-manual', location: '' }),
      r('L', 'inbox', { company: 'Legrand, North & Central America', title: 'Manufacturing Engineer', source: 'linkedin', location: 'West Hartford, CT' })]), [['L', 'O']]);
  eq('…but a page copy in a clearly different city stays',
    folds([r('A', 'applied', { source: 'extension', location: 'Seattle, WA' }), r('B', 'new', { location: 'Austin, TX' })]), []);
  eq('"Wolfspeed, Inc." is Wolfspeed; "Legrand, North & Central America" is Legrand', [employerOf('Wolfspeed, Inc.'), employerOf('Legrand, North & Central America')], ['wolfspeed', 'legrand']);
}

// TWO ROLES ARE NEVER ONE COPY (review, 2026-11-04).
{
  const { linkable, driftedCopyPointers } = await import('./dedupe.mjs');
  const li = (company, title, n) => ({ id: `li${n}`, source: 'linkedin', company, title, url: `https://www.linkedin.com/jobs/view/${title.toLowerCase().replace(/\W+/g, '-')}-at-x-${n}` });
  const wd = (company, title, slug, n) => ({ id: `wd${n}`, source: 'workday', company, title, url: `https://hyve.wd5.myworkdayjobs.com/hyvecareers/job/Fremont-CA/${slug}_R${n}` });
  eq('Staff vs System Thermal Engineer at one employer: never one copy',
    linkable(li('Hyve Solutions', 'System Thermal Engineer', 1), wd('Hyve Solutions', 'Staff Thermal Engineer', 'Staff-Thermal-Engineer', 54176)), false);
  eq('Hardware Integration vs Radar Systems Integration: never one copy',
    linkable(li('SciTec', 'Radar Systems Integration Engineer', 2), { id: 'w', source: 'workable', company: 'SciTec', title: 'Hardware Integration Engineer', url: 'https://apply.workable.com/scitec/jobs/view/473615B72C' }), false);
  eq('…but a board row retitled after the link, whose URL still names the copy\'s title, still links',
    linkable(li('Hyve Solutions', 'System Thermal Engineer', 3), wd('Hyve Solutions', 'Staff Thermal Engineer', 'System-Thermal-Engineer---AI-and-Compute-Server-Development', 54176)), true);
  eq('another employer never links', linkable(li('Acme', 'Thermal Engineer', 4), wd('Other Co', 'Thermal Engineer', 'Thermal-Engineer', 5)), false);
  eq('a regional page name, a trailing "AI" and a misspelt word are the same posting',
    [linkable(li('Legrand, North & Central America', 'Manufacturing Engineer', 6), wd('Legrand', 'Manufacturing Engineer', 'Manufacturing-Engineer', 7)),
     linkable(li('Luma', 'Robotics Engineer', 8), wd('Luma AI', 'Robotics Engineer', 'Robotics-Engineer', 9)),
     linkable(li('Nokia', 'Principle Equipment Engineer', 10), wd('Nokia', 'Principal Equipment Engineer', 'Principal-Equipment-Engineer', 11))], [true, true, true]);
  eq('equal requisition ids link whatever the titles say',
    linkable({ source: 'simplify', company: 'Acme', title: 'Engineer', url: 'https://acme.wd1.myworkdayjobs.com/x/job/A/Old-Title_R100' }, { source: 'workday', company: 'Acme', title: 'Something Else', url: 'https://acme.wd1.myworkdayjobs.com/x/job/A/New-Title_R100' }), true);
  const pairs = [
    { stale: li('Qualus', 'Lead Engineer - Mechanical', 12), keep: wd('Qualus', 'Senior Engineer - Mechanical', 'Senior-Engineer-Mechanical', 13) },
    { stale: li('Acme', 'Test Engineer', 14), keep: wd('Acme', 'Test Engineer', 'Test-Engineer', 15) },
    { stale: { ...wd('Qualus', 'Lead Engineer', 'Lead-Engineer', 16), source: 'workday' }, keep: wd('Qualus', 'Other', 'Other', 17) },
  ];
  eq('the recheck clears a copy link between two roles, keeps a true copy, and leaves links other rules made', driftedCopyPointers(pairs).map((p) => p.stale.id), ['li12']);
}

// THE TITLE RULE IS STRICT (first mate's review, 2026-11-04).
{
  const { similarTitle, titleFromUrl, urlNamesTitle } = await import('./same-posting.mjs');
  eq('a level word on one side only is another role', similarTitle('Mechanical Engineer', 'Senior Mechanical Engineer'), false);
  eq('I is not II', similarTitle('Software Engineer I', 'Software Engineer II'), false);
  eq('"Sr." is Senior, "2" is II', [similarTitle('Sr. Process Engineer', 'Senior Process Engineer'), similarTitle('Process Engineer 2', 'Process Engineer II')], [true, true]);
  eq('an extra core word is another role', similarTitle('Mechanical Design Engineer', 'Mechanical Engineer'), false);
  eq('a one-word title matches nothing', similarTitle('Engineer', 'Engineer'), false);
  eq('a qualifier tail is not compared', [similarTitle('Manufacturing Engineer I - Austin', 'Manufacturing Engineer I'), similarTitle('Mechanical Engineer (New Grad 2027)', 'Mechanical Engineer')], [true, true]);
  eq('generic slugs are not titles', [titleFromUrl('https://jobs.lever.co/acme/bfe28852-4fab-41fb-a2eb-5365dc0fdc82/apply-now'), titleFromUrl('https://acme.com/careers/job-search')], ['', '']);
  eq('a URL names a title only with its level words too', [
    urlNamesTitle('System Thermal Engineer', 'https://synnex.wd5.myworkdayjobs.com/hyvecareers/job/Fremont-CA/System-Thermal-Engineer---AI-and-Compute-Server-Development_R54176'),
    urlNamesTitle('Senior System Thermal Engineer', 'https://synnex.wd5.myworkdayjobs.com/hyvecareers/job/Fremont-CA/System-Thermal-Engineer---AI-and-Compute-Server-Development_R54176')], [true, false]);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
