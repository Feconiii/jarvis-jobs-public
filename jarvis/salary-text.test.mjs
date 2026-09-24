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
