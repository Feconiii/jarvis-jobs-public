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
import { duplicateGroups, pathShape } from './dedupe.mjs';

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


console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
