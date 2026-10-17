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
import { duplicateGroups, linkedinCopyGroups, pathShape, placeKey, repostGroups, handledRoleGroups, employerOf } from './dedupe.mjs';

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

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
