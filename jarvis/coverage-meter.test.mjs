// jarvis/coverage-meter.test.mjs — the outside sample, the matcher, the reasons.
// Run: node jarvis/coverage-meter.test.mjs
import { simplifySample, matchPosting, reasonFor, summarize, normUrl, slugTitle, boardOf, weeklySlice, sampleKeeps, inUs } from './coverage-meter.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const now = Date.parse('2026-11-03T12:00:00Z');
const li = (over = {}) => ({ active: true, is_visible: true, category: 'Hardware', company_name: 'Micron Technology', title: 'Manufacturing Engineer New Grad',
  url: 'https://micron.wd1.myworkdayjobs.com/External/job/Boise-ID/New-College-Grad---Manufacturing-Engineer_JR1?utm_source=Simplify', locations: ['Boise, ID'],
  date_posted: (now - 5 * 86_400_000) / 1000, sponsorship: 'Other', ...over });

console.log('🧪 coverage-meter: the sample is cut by its own words and his hard rules');
eq('a recent US new-grad role in his field is sampled', simplifySample([li()], { now }).length, 1);
eq('…not one posted 40 days ago', simplifySample([li({ date_posted: (now - 40 * 86_400_000) / 1000 })], { now }).length, 0);
eq('…not "U.S. Citizenship is Required"', simplifySample([li({ sponsorship: 'U.S. Citizenship is Required' })], { now }).length, 0);
eq('…not abroad', simplifySample([li({ locations: ['Remote in UK'] })], { now }).length, 0);
eq('…not software', simplifySample([li({ title: 'Software Engineer New Grad' })], { now }).length, 0);
eq('…not senior, not an internship', [sampleKeeps({ title: 'Senior Manufacturing Engineer' }), sampleKeeps({ title: 'Manufacturing Engineering Intern' })], [false, false]);
// Review (2026-11-03): not the library's rules, only his hard ones.
eq('a title the library might reject is still sampled', sampleKeeps({ title: 'Test Engineer 1', company: 'Acme' }), true);
eq('a defense prime is not (his clearance rule)', sampleKeeps({ title: 'Manufacturing Engineer', company: 'Northrop Grumman' }), false);
eq('a clearance in the title is not', sampleKeeps({ title: 'Manufacturing Engineer (Secret Clearance)', company: 'Acme' }), false);
eq('…nor an employer discovery never tracks (Leidos, Draper: his clearance rule)', [sampleKeeps({ title: 'Systems Engineer', company: 'Leidos' }), sampleKeeps({ title: 'Integration and Test Engineer', company: 'Draper' })], [false, false]);
eq('US places, read plainly', [inUs(['Boise, ID']), inUs(['Remote in USA']), inUs(['Remote in UK']), inUs(['Toronto, ON'])], [true, true, false, false]);

console.log('\n🧪 coverage-meter: found only on the URL, the requisition, or title AND place');
const rows = [
  { id: 's1', url: 'https://careers.micron.com/careers/job/42120395-new-college-grad-dram-design-engineer-boise-idaho?domain=micron.com', company: 'Micron Technology', title: 'New College Grad DRAM Design Engineer Boise Idaho United States Of America', location: 'Boise, ID,US, US', gone_at: null },
  { id: 's2', url: 'https://x.wd1.myworkdayjobs.com/External/job/Austin-TX/Process-Engineer_JR900001', company: 'Micron Technology', title: 'Process Engineer', location: 'Austin, TX', gone_at: null },
];
const idx = { byUrl: new Map(rows.map((r) => [normUrl(r.url), r])), byEmployer: new Map([['microntechnology', rows]]) };
const p = { company: 'Micron Technology', title: 'DRAM Design Engineer New Grad', location: 'Boise, ID', url: 'https://micron.wd1.myworkdayjobs.com/External/job/Boise-ID---Main-Site/New-College-Grad---DRAM-Design-Engineer_JR115580' };
eq('the URL title spells the employer\'s own title', slugTitle(p.url), 'new college grad dram design engineer');
eq('a Simplify-renamed posting is found by the title its URL carries, at its place', matchPosting(p, idx)?.row.id, 's1');
eq('the same title in ANOTHER place is another requisition, not a match',
  matchPosting({ company: 'Micron Technology', title: 'Process Engineer', location: 'Boise, ID', url: 'https://example.com/careers/abc' }, idx), null);
eq('the same requisition id in the same numbering is a match, whatever the title',
  matchPosting({ company: 'Micron Technology', title: 'Proc Eng', location: 'Anywhere', url: 'https://x.wd1.myworkdayjobs.com/en-US/External/job/Austin/Process-Engineer_JR900001' }, idx)?.how, 'requisition');
{
  // Review (2026-11-03): two requisitions in one numbering are two postings, even same title and city.
  const two = [{ id: 'w1', url: 'https://sym.wd5.myworkdayjobs.com/S/job/USA-Manchester-PA/Cell-Operator_R7540', company: 'Symbotic', title: 'Cell Operator', location: 'USA Manchester, PA', gone_at: null }];
  const ix = { byUrl: new Map(two.map((r) => [normUrl(r.url), r])), byEmployer: new Map([['symbotic', two]]) };
  eq('a second opening (another Workday id, same title, same city) is not a copy',
    matchPosting({ company: 'Symbotic', title: 'Cell Operator', location: 'Manchester, PA', url: 'https://sym.wd5.myworkdayjobs.com/S/job/USA-Manchester-PA/Cell-Operator_R7209' }, ix), null);
  eq('…while ids from two numberings fall back to title and place (the Micron case above)', matchPosting(p, idx)?.how, 'title and place');
}
eq('the same URL with tracking parameters is the same posting', normUrl('https://www.x.com/jobs/1/?utm_source=Simplify'), 'x.com/jobs/1');

console.log('\n🧪 coverage-meter: every posting has a reason');
eq('in store', reasonFor({ row: { gone_at: null } }), 'in store');
eq('what the library did with it is said', reasonFor({ row: { gone_at: null } }, null, 'title'), "in store, removed by the library's title rule");
eq('in store but closed', reasonFor({ row: { gone_at: '2026-10-16' } }), 'in store, marked closed');
eq('employer not in the ledger', reasonFor(null, null), 'employer not in the ledger');
eq('tracked and missed is the scan\'s fault', reasonFor(null, 'tracked'), 'employer tracked, posting not picked up');
eq('held = in the store and open, whatever the library then did',
  summarize([{ reason: 'in store' }, { reason: "in store, removed by the library's title rule" }, { reason: 'in store, marked closed' }, { reason: 'employer no-board' }]).pct, 50);
// First mate, 2026-11-04: a board disabled by an audit is a decision, not a miss.
eq('a disabled employer is its own bucket', reasonFor(null, 'disabled'), 'employer disabled on purpose');
{
  const s = summarize([{ reason: 'in store' }, { reason: 'employer no-board' }, { reason: 'employer disabled on purpose' }]);
  eq('…left out of the percentage, and counted', [s.sampled, s.found, s.pct, s.disabledOnPurpose], [2, 1, 50, 1]);
}
eq('a never-track employer is not sampled at all', sampleKeeps({ title: 'Systems Engineer', company: 'Booz Allen' }), false);
{
  const { trackable } = await import('./coverage-meter.mjs');
  const t = trackable([
    { reason: 'employer no-board', company: 'Nio', url: 'https://jobs.lever.co/nio-usa/a' },
    { reason: 'employer not in the ledger', company: 'Morse Micro', url: 'https://jobs.ashbyhq.com/morse-micro/b' },
    { reason: 'employer not in the ledger', company: 'Morse Micro', url: 'https://jobs.ashbyhq.com/morse-micro/c' },
    { reason: 'employer disabled on purpose', company: 'Star Mountain Capital', url: 'https://job-boards.greenhouse.io/starmountaincapital/jobs/1' },
    { reason: 'employer tracked, posting not picked up', company: 'Welo Global', url: 'https://jobs.lever.co/weloglobal/x' },
    { reason: 'employer not in the ledger', company: 'Leidos', url: 'https://leidos.wd5.myworkdayjobs.com/External/job/x' },
    { reason: 'in store', company: 'Acme', url: 'https://jobs.lever.co/acme/x' },
  ]);
  eq('--track asks only untracked employers it may track, one per employer, every link kept',
    t.map((c) => [c.name, c.urls.length]), [['Nio', 1], ['Morse Micro', 2]]);
}

console.log('\n🧪 coverage-meter: the rotating board samples');
eq('a Greenhouse board token', boardOf('greenhouse', 'https://job-boards.greenhouse.io/electraaero/jobs/4373464009'), { ats: 'greenhouse', token: 'electraaero' });
eq('…read from a Simplify URL with no source', boardOf('', 'https://job-boards.greenhouse.io/asteraearlycareer2027/jobs/4740701005'), { ats: 'greenhouse', token: 'asteraearlycareer2027' });
eq('a Lever board token', boardOf('lever', 'https://jobs.lever.co/shieldai/78842190'), { ats: 'lever', token: 'shieldai' });
const boards = Array.from({ length: 10 }, (_, i) => ({ ats: 'greenhouse', token: `b${i}` }));
eq('each week reads a different slice', weeklySlice(boards, 3, now).map((b) => b.token).join() !== weeklySlice(boards, 3, now + 7 * 86_400_000).map((b) => b.token).join(), true);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
