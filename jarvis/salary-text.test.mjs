// Tests for reading pay out of description text. Every "real posting" case
// below is a verbatim string taken from the live store.

import { parseSalaryFromText, resolveSalary } from './salary-text.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const range = (t) => { const r = parseSalaryFromText(t); return r ? [r.min, r.max, r.currency] : null; };

console.log('\n🧪 salary-text: real posting formats');

check('KLA — "Base Pay Range: $105,900.00 - $180,000.00 Annually"',
  range('Base Pay Range: $105,900.00 - $180,000.00 Annually'), [105900, 180000, 'USD']);
check('Axcelis — bare range with decimals',
  range('Compensation for this role. $121,467.00 - $182,200.50'), [121467, 182200.5, 'USD']);
check('Boston Dynamics — "between $154,000 to $200,000 annually"',
  range('The pay range for this position is between $154,000 to $200,000 annually.'), [154000, 200000, 'USD']);
check('Intel — second bound has no dollar sign',
  range('Annual Salary Range for jobs which could be performed in the US: $133,800.00-255,200.00 USD'),
  [133800, 255200, 'USD']);
check('Rockwell — CAD is not USD',
  range('For this role, the Base Salary Compensation is $92,720 - $139,080.00 CAD Annually.'),
  [92720, 139080, 'CAD']);
check('Relativity — split across HTML spans',
  range('<div class="title">Hiring Range:</div><div class="pay-range"><span>$104,000</span><span class="divider">&mdash;</span><span>$156,000 USD</span></div>'),
  [104000, 156000, 'USD']);
check('Archer — "targeting a base pay between"',
  range('we are targeting a base pay between $160,000 - $220,000. Actual compensation offered'),
  [160000, 220000, 'USD']);

console.log('\n🧪 salary-text: hourly is annualised');

check('Formic — "$38–$46 per hour" (en dash)',
  range('This role is paid hourly with a posted range of $38–$46 per hour.'),
  [38 * 2080, 46 * 2080, 'USD']);
check('Entegris — "$22-24 hourly"',
  range('Compensation: $22-24 hourly range with actual pay dependent on candidate skills.'),
  [22 * 2080, 24 * 2080, 'USD']);
check('ASML — bare "$42.01-63.01" inferred hourly by magnitude',
  range('Pay range $42.01-63.01'), [42.01 * 2080, 63.01 * 2080, 'USD']);

console.log('\n🧪 salary-text: refuses numbers that are not pay');

// This is the case that matters most — a funding round read as a salary would
// silently rank the job as if it paid millions.
check('Hadrian — "$1.37B Series D at a $7.87B valuation"',
  parseSalaryFromText('Following our $1.37B Series D at a $7.87B valuation, Hadrian is expanding.'), null);
check('a savings figure is not a salary',
  parseSalaryFromText('delivered $57,000 - $80,000 in annual material savings'), null);
check('a 401(k) match is not a salary',
  parseSalaryFromText('We offer a 401(k) match up to $5,000 - $9,000 per year.'), null);
check('revenue is not a salary',
  parseSalaryFromText('The division drove revenue of $200,000 to $400,000 last quarter.'), null);
check('no numbers at all', parseSalaryFromText('Competitive salary and benefits.'), null);
check('empty input', parseSalaryFromText(''), null);
check('null input', parseSalaryFromText(null), null);

console.log('\n🧪 salary-text: sanity gates');

check('absurdly wide "ranges" are two unrelated numbers, not a band',
  parseSalaryFromText('salary $20,000 - $900,000'), null);
check('sub-minimum annual figures are rejected',
  parseSalaryFromText('annual salary of $900 - $1,200'), null);
check('reversed bounds are normalised',
  range('Base pay range: $180,000 - $105,900 annually'), [105900, 180000, 'USD']);
check('K suffix expands',
  range('Base salary range $120K - $150K per year'), [120000, 150000, 'USD']);

console.log('\n🧪 salary-text: prefers the pay-labelled range');
// A posting may mention other money; the one next to "salary"/"pay range" wins.
check('picks the labelled band over an unlabelled pair',
  range('Relocation support of $5,000 - $8,000 offered. The base salary range is $110,000 - $140,000 annually.'),
  [110000, 140000, 'USD']);

console.log('\n🧪 salary-text: the word "hour" near an annual range');
// The interval can be read from the surrounding ±140 characters when the match
// itself carries no unit. That window is wide enough to catch an unrelated
// "hour" — a shift description, on-call language, "24-hour operations" — which
// flipped the range to hourly and then discarded it as an impossible hourly
// rate. The posting showed no pay at all. The numbers are stronger evidence
// than a nearby word, so they win.
check('"40 hour per week" does not eat the annual range',
  range('This is a full-time, 40 hour per week position. The salary range for this role is $95,000 - $120,000 depending on experience.'),
  [95000, 120000, 'USD']);
check('"24-hour operations" does not either',
  range('Our facility runs 24-hour operations. Compensation: $88,000 - $105,000 annually.'),
  [88000, 105000, 'USD']);
check('an hourly range next to the word hour is still hourly',
  parseSalaryFromText('Pay range: $24.00 - $31.50 per hour.').interval, 'hour');
check('…and a self-stated hourly range is untouched',
  parseSalaryFromText('$33/hour - $36/hour').interval, 'hour');

console.log('\n🧪 salary-text: a bare range must be two amounts (F-629)');
// 88 stored jobs showed hourly pay read out of a travel share, and more out of
// dates, shift lengths and mileage. Each string below is from the store.
check('Tesla — "10-15% of travel" is not $10-15/hr',
  range('Ability to travel 10-15% for work on site on a regular basis. Compensation and Benefits: Along with competitive pay, as a full-time Tesla employee…'), null);
check('Avery Dennison — "10 - 20 percent of the time"',
  range('Travel Ability to travel 10 - 20 percent of the time. The hourly pay for this position is competitive.'), null);
check('Marble — "15-25% of plant revenue"',
  range('As a result, 15-25% of plant revenue (salary and equity offered)'), null);
check('the travel share does not hide the real pay beside it',
  range('Travel Requirements 25-50% Relocation Provided. Base salary range: $95,000 - $120,000.'), [95000, 120000, 'USD']);
check('CrowdStrike — a posting date is not pay',
  range('Salary will vary. The Date of Job Posting is:09-22-2026'), null);
check('Baker Hughes — "8–10-hour shift"',
  range('Pay is competitive. Stand and/or walk for most of an 8–10-hour shift, with additional overtime'), null);
check('Amcor — "10–12-point font"',
  range('Hourly pay; ability to read 10–12-point font at a distance'), null);
check('Ecolab — "400-500 mile radius"',
  range('Great pay! Delivery within a 400-500 mile radius from plant'), null);
check('Stryker — "80-100 miles/day"',
  range('Base salary plus commission; personal vehicle (drive 80-100 miles/day depending on territory)'), null);
check('Allegion — "20 to 40 hourly associates"',
  range('Salary range below. Lead a team of approximately 20 to 40 hourly associates to safely produce'), null);
check('Devon — "September 10-11th"',
  range('Paid travel to Oklahoma City on September 10-11th, 2026.'), null);
check('Gartner — "managing 10 – 20 large enterprise accounts", pay word far away',
  range('Competitive base salary and uncapped commissions. You will own a territory in the supply chain practice, delivering value in over, managing 10 – 20 large enterprise accounts'), null);
check('Smith+Nephew — space-grouped thousands are not a 500-110 range',
  range('The base salary range for this position is 73 500 -110 250 PLN annually.'), null);
check('Stryker PR — decimal commas are not read from the middle',
  range('Salary range verbal. Puerto Rico: 10,50 - 12,43 - 14,36 USD Hour'), null);
check('Boeing — no currency, but "pay range:" right before it',
  range('Summary pay range: 33.32 – 61.01 Language Requirements'), [33.32 * 2080, 61.01 * 2080, 'USD']);
check('Hadrian — "target salary range is 160k-190k"',
  range('The target salary range is 160k-190k (actual range may vary)'), [160000, 190000, 'USD']);
check('Ecolab — "35 - 37 / HR" with no pay word, the rate is in the range',
  range("Competitive pay for our CDL-A drivers, with home time every week and a strong safety culture. What's in it For You: • 35 - 37 / HR • Terminal Location"), [35 * 2080, 37 * 2080, 'USD']);
check('Ecolab — min-mid-max reads as min to max',
  range('Hourly Compensation Range: 53,600.00 - 66,900.00 - 80,300.00 USD Annual'), [53600, 80300, 'USD']);
check('Baker Hughes — hourly min-mid-max',
  (r => r && [r.rate.min, r.rate.max, r.interval])(parseSalaryFromText('The hourly pay scale for this position is between 19.02 - 25.36 - 31.69 USD. Candidates for this role')),
  [19.02, 31.69, 'hour']);
check('ICEYE — "from 50 to 75 to 120+ satellites per year" is a count',
  range('The production system is designed and operated to scale, from 50 to 75 to 120+ satellites per year, with competitive salary'), null);
check('GE Aerospace — "150,000-200,000 shipments annually" is a count',
  range('Competitive salary. Own site-level processes for approximately 150 locations and 150,000-200,000 shipments annually.'), null);
check('Boeing — "Level 4 $162,350-$219,650": the level number is a label',
  range('Summary pay range: Level 4 $162,350-$219,650 Language Requirements'), [162350, 219650, 'USD']);
check('PsiQuantum — "Zone 1 $48.75—$57.26 USD"',
  (r => r && [r.rate.min, r.rate.max, r.interval])(parseSalaryFromText('The estimated base salary range for this role is: Zone 1 $48.75—$57.26 USD')),
  [48.75, 57.26, 'hour']);
check('Rolls-Royce — "$78,918 - $128,242-Annually"',
  range('may vary from the posted range. $78,918 - $128,242-Annually Location: India'), [78918, 128242, 'USD']);
check('Outokumpu — "Salary range: USD. 106,100-145,900"',
  range('Salary range: USD. 106,100-145,900 plus bonus.'), [106100, 145900, 'USD']);
check('Spotify — "base range for this position is 164,448 - 234,926"',
  range('The United States base range for this position is 164,448 - 234,926 plus equity. Benefits include health insurance and the salary is reviewed yearly.'), [164448, 234926, 'USD']);
check('Ryder — pay word just after: "48k - 50k (DOE) yearly salary"',
  range('perks of joining our Ryder Team. • 48k - 50k (DOE) yearly salary + benefits'), [48000, 50000, 'USD']);
check('Amazon — a refused first pair does not hide the pair after it',
  (r => r && [r.rate.min, r.rate.max, r.interval])(parseSalaryFromText('benefits at https://amazon.jobs/en/benefits. USA, OR, PDX170 - 30.00 - 54.00 USD hourly')),
  [30, 54, 'hour']);
check('a trailing "- depending on experience" does not cost the range',
  range('Base pay: $100,000 - $120,000 - depending on experience'), [100000, 120000, 'USD']);

console.log('\n🧪 salary-text: resolveSalary decides what may be re-derived');
// This resolver is what rescore.mjs calls, and it used to short-circuit on ANY
// stored value — which meant no improvement to the parser could ever reach a
// job that already had a number. Found by replaying the store: 5,229 rows were
// frozen, including an Amcor req showing $465k-$651k annualised from the bare
// digits "224-313" in a sentence about project budgets, and 4,400 KLA-style
// rows displaying "$52k-$89k" for postings that say "$25.15 - $42.75 Per Hour".
check('an ATS-provided figure is authoritative and never re-parsed',
  resolveSalary({ salary: { min: 90000, max: 120000, currency: 'USD', interval: 'year' },
                  description: 'The range is $25.15 - $42.75 Per Hour.' }).min, 90000);
check('a value THIS module parsed is re-derived from the text',
  (r => [r.interval, r.rate.min, r.rate.max])(
    resolveSalary({ salary: { min: 52312, max: 88920, currency: 'USD', source: 'description' },
                    description: 'The range is $25.15 - $42.75 Per Hour for this role.' })),
  ['hour', 25.15, 42.75]);
check('with no description there is nothing to re-read, so the value is kept',
  resolveSalary({ salary: { min: 60000, max: 70000, source: 'description' }, description: '' }).max, 70000);
check('a stored value the parser can no longer reproduce is dropped, not shown',
  resolveSalary({ salary: { min: 465920, max: 651040, source: 'description', raw: '224-313' },
                  description: 'Projects range in size from 224-313 units per line.' }), null);
check('no salary anywhere', resolveSalary({ description: 'No pay stated.' }), null);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
