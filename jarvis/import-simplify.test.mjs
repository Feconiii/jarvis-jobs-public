// jarvis/import-simplify.test.mjs — Simplify's listings as store rows.
// Run: node jarvis/import-simplify.test.mjs
import { simplifyRows, sourceFor } from './import-simplify.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const now = Date.parse('2026-11-03T12:00:00Z');
const li = (over = {}) => ({ active: true, is_visible: true, category: 'Hardware', company_name: 'Astera Labs', title: 'Digital Design Engineer New Grad',
  url: 'https://job-boards.greenhouse.io/asteraearlycareer2027/jobs/4740701005', locations: ['San Jose, CA'],
  date_posted: (now - 5 * 86_400_000) / 1000, sponsorship: 'Other', ...over });

console.log('🧪 import-simplify: only what his flags allow, nothing the store has');
eq('an active US hardware listing becomes a row', simplifyRows([li()], { now }).length, 1);
eq('…filed under the ATS its URL names, so the reader can read it', simplifyRows([li()], { now })[0].source, 'greenhouse');
eq('a closed listing is not imported', simplifyRows([li({ active: false })], { now }).length, 0);
eq('"Does Not Offer Sponsorship" is not', simplifyRows([li({ sponsorship: 'Does Not Offer Sponsorship' })], { now }).length, 0);
eq('"U.S. Citizenship is Required" is not', simplifyRows([li({ sponsorship: 'U.S. Citizenship is Required' })], { now }).length, 0);
eq('a listing abroad is not', simplifyRows([li({ locations: ['Remote in UK'] })], { now }).length, 0);
eq('an employer discovery never tracks is not (Leidos)', simplifyRows([li({ company_name: 'Leidos' })], { now }).length, 0);
eq('a URL the store already holds is not imported twice', simplifyRows([li()], { now, has: () => true }).length, 0);
// The category and the sponsorship labels follow the preset and the person (2026-11-14):
// a finance user's import reads Simplify's quant/data listings, not Hardware.
eq('the default preset does not import a software listing', simplifyRows([li({ category: 'Software Engineering' })], { now }).length, 0);
eq('another preset\'s category is read', simplifyRows([li({ category: 'Quantitative Finance' })], { now, categoryRe: /quant|data/i }).length, 1);
eq('…and Hardware is not, for that preset', simplifyRows([li()], { now, categoryRe: /quant|data/i }).length, 0);
eq('a preset with no Simplify category imports nothing', simplifyRows([li()], { now, categoryRe: null }).length, 0);
{
  const citizen = { usPerson: true, needsSponsorship: false };
  eq('a citizen can take a "U.S. Citizenship is Required" listing', simplifyRows([li({ sponsorship: 'U.S. Citizenship is Required' })], { now, who: citizen }).length, 1);
  eq('…and a "Does Not Offer Sponsorship" one', simplifyRows([li({ sponsorship: 'Does Not Offer Sponsorship' })], { now, who: citizen }).length, 1);
  const authorized = { usPerson: false, needsSponsorship: false };
  eq('authorized without sponsorship: no-sponsorship listings come in, citizens-only do not',
    [simplifyRows([li({ sponsorship: 'Does Not Offer Sponsorship' })], { now, who: authorized }).length,
      simplifyRows([li({ sponsorship: 'U.S. Citizenship is Required' })], { now, who: authorized }).length], [1, 0]);
}
{
  // Review (2026-11-03): the board copy is stored under ANOTHER URL (the scanner's
  // Workday spelling); the Simplify listing must not become a second row.
  const { matchPosting, normUrl } = await import('./coverage-meter.mjs');
  const stored = [{ id: 'w1', company: 'Micron Technology', title: 'New College Grad DRAM Design Engineer Boise Idaho United States Of America', location: 'Boise, ID,US, US',
    url: 'https://careers.micron.com/careers/job/42120395-new-college-grad-dram-design-engineer-boise-idaho?domain=micron.com', gone_at: null }];
  const idx = { byUrl: new Map(stored.map((r) => [normUrl(r.url), r])), byEmployer: new Map([['microntechnology', stored]]) };
  const sim = li({ company_name: 'Micron Technology', title: 'DRAM Design Engineer New Grad', locations: ['Boise, ID'],
    url: 'https://micron.wd1.myworkdayjobs.com/External/job/Boise-ID---Main-Site/New-College-Grad---DRAM-Design-Engineer_JR115580?utm_source=Simplify' });
  eq('a listing whose board copy is stored under another URL is not imported again',
    simplifyRows([sim], { now, held: (p) => !!matchPosting(p, idx) }).length, 0);
  eq('…the same role in another city is', simplifyRows([{ ...sim, locations: ['Manassas, VA'], url: 'https://example.com/careers/job/1' }], { now, held: (p) => !!matchPosting(p, idx) }).length, 1);
}
eq('an ATS with no reader files as "simplify"', [sourceFor('https://koch.avature.net/en_US/careers/JobDetail/196274'), sourceFor('https://nxp.wd3.myworkdayjobs.com/careers/job/x_R-1')], ['simplify', 'workday']);
eq('the row carries a triage verdict from title and place', typeof simplifyRows([li()], { now })[0].triage.locationBucket, 'string');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
