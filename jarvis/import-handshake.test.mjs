// jarvis/import-handshake.test.mjs
//
// The input here is rendered text, not an API payload, so the parsing IS the
// program. Two failures matter more than the rest.
//
// Pay is a band with a unit — "$25-30/hr" is $52,000 and clears his floor,
// while the same numbers read as yearly are $25 and the posting disappears from
// every pay-aware view. Handshake writes the range with an EN DASH, which is a
// different character from a hyphen.
//
// And the work-authorization line is the best signal any source gives us. It
// has three states: open, not open, and never answered. Collapsing the third
// into the second hides jobs.
//
// The fixtures are real text captured from his logged-in session 2026-09-19.

import {
  parsePayBand, parseCard, parsePane, toStoreRow, selectImportable, jobUrl,
} from './import-handshake.mjs';

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.error(`  ✗ ${what}\n      got  ${a}\n      want ${b}`);
};
const ok = (what, cond) => check(what, !!cond, true);

console.log('🧪 import-handshake: the pay band');
check('an en-dashed K band', parsePayBand('$80–90K/yr'), { min: 80000, max: 90000, currency: 'USD' });
// The hyphen and the en dash are different characters and both appear.
check('a hyphenated K band', parsePayBand('$65-100K/yr'), { min: 65000, max: 100000, currency: 'USD' });
// The suffix on the first number governs the second when the second has none.
// Without that, "$80–90K/yr" reads as $80 to $90,000.
check('the K carries across the range', parsePayBand('$80–90K/yr').min, 80000);
check('a single figure has no maximum', parsePayBand('$100K/yr'), { min: 100000, max: null, currency: 'USD' });
check('hourly is annualised at 2080', parsePayBand('$25-30/hr'), { min: 52000, max: 62400, currency: 'USD' });
check('monthly × 12', parsePayBand('$8,000/mo'), { min: 96000, max: null, currency: 'USD' });
check('weekly × 52', parsePayBand('$2,000/wk'), { min: 104000, max: null, currency: 'USD' });
check('commas are not decimal points', parsePayBand('$120,000/yr').min, 120000);
check('no band at all', parsePayBand(''), null);
check('a number with no unit is not a salary', parsePayBand('$80–90K'), null);
check('unrelated text is not a salary', parsePayBand('Medical, dental, and vision coverage'), null);

console.log('🧪 import-handshake: the result card');
{
  const c = parseCard('Affiliated Engineers, Inc.\nMechanical Engineer I\n$80-90K/yr · Full-time\nSeattle, WA\n∙\n2wk ago');
  check('employer', c.employer, 'Affiliated Engineers, Inc.');
  check('title', c.title, 'Mechanical Engineer I');
  check('pay line', c.pay, '$80-90K/yr · Full-time');
  check('employment type is split off the pay line', c.employmentType, 'Full-time');
  check('location', c.location, 'Seattle, WA');
}
{
  // The pay line is optional. Counting line positions instead of reading their
  // shape puts "Full-time" in the location on every unpaid posting.
  const c = parseCard('Zeitview Technology\nFull Time Mechanical Engineer\nFull-time\nRolla, MO\n∙\n4d ago');
  check('title survives without a pay line', c.title, 'Full Time Mechanical Engineer');
  check('no pay', c.pay, '');
  check('employment type is still found', c.employmentType, 'Full-time');
  check('location is not the employment type', c.location, 'Rolla, MO');
}
{
  const c = parseCard('MIMiC\nMechanical Engineer\n$70-85K/yr · Full-time\nNewark, NJ + 1\n∙\n3wk ago');
  check('a multi-city location is kept whole', c.location, 'Newark, NJ + 1');
}

const PANE = `Affiliated Engineers, Inc.
Engineering & Construction
Mechanical Engineer I
Posted 2 weeks ago∙Apply by September 30, 2026 at 11:59 PM
Save
Share
Apply externally
Summary
Beta
At a glance
$80–90K/yr
Medical, dental, and vision coverage
Onsite, based in Seattle, WA
Work in person from the location
Job
Full-time
US work authorization required
Open to candidates with OPT/CPT
Job description
Join a Team Where Engineering Excellence Drives Opportunity

At Affiliated Engineers, Inc. we design mechanical systems.
Requires a BSME and load calculation experience.
What they're looking for
You match some qualifications.
Bachelors
Mechanical Engineering major`;

console.log('🧪 import-handshake: the detail pane');
{
  const p = parsePane(PANE);
  ok('the description is found', /design mechanical systems/.test(p.description));
  ok('the requirements line survives', /BSME and load calculation/.test(p.description));
  // "What they're looking for" is the profile-matching widget, not the posting.
  // Letting it into the body would put Handshake's own UI text through triage.
  ok('the match widget is cut off', !/You match some qualifications/.test(p.description));
  check('the pay band comes from the glance block', p.pay, '$80–90K/yr');
  check('the deadline', p.applyBy, 'September 30, 2026 at 11:59 PM');
  check('OPT/CPT is read as stated', p.optCpt, true);
  check('work authorization requirement is read', p.workAuthRequired, true);
}
{
  // Silence is the third state. An employer who never answered has not said no,
  // and recording that as "not open" would hide the job.
  const p = parsePane('Job description\nWe build robots.\n');
  check('unanswered OPT/CPT is null, not false', p.optCpt, null);
  check('unanswered work authorization is null', p.workAuthRequired, null);
  check('no glance block means no pay', p.pay, '');
  check('the description still comes through', p.description, 'We build robots.');
}
{
  const p = parsePane('Job description\nWe build robots.\nNot open to candidates with OPT/CPT\n');
  check('an explicit no is recorded as false', p.optCpt, false);
}
{
  // If the harvester failed to click "More", the body ends mid-sentence. Half a
  // description triaged as if whole is worse than none.
  const p = parsePane('Job description\nWe build rob\n...\nMore\nSave\n');
  check('a clamped body is trimmed at the ellipsis', p.description, 'We build rob');
}

console.log('🧪 import-handshake: the row it builds');
{
  const built = toStoreRow({
    posting_id: '11367671',
    card: 'Affiliated Engineers, Inc.\nMechanical Engineer I\n$80-90K/yr · Full-time\nSeattle, WA\n∙\n2wk ago',
    pane: PANE,
  });
  check('url is the posting page', built.url, 'https://app.joinhandshake.com/job-search/11367671');
  check('url helper agrees', jobUrl('11367671'), built.url);
  check('source', built.source, 'handshake');
  check('company', built.company, 'Affiliated Engineers, Inc.');
  check('title', built.title, 'Mechanical Engineer I');
  check('location', built.location, 'Seattle, WA');
  check('pay is annualised onto the row', built.salary, { min: 80000, max: 90000, currency: 'USD' });
  // The OPT/CPT answer has to reach the BODY, because that is where the visa
  // classifier reads. Left in a field nothing reads, the best signal Handshake
  // gives us would be wasted.
  ok('the OPT/CPT line is in the body', /open to candidates with OPT\/CPT/i.test(built.description));
  ok('the deadline is in the body', /Apply by September 30, 2026/.test(built.description));
  check('and it is flagged on the row', built.company_meta.sponsors_h1b, true);
  ok('triage ran', built.triage && built.triage.flags);
  ok('the note says the engine cannot fill it', /cannot fill/i.test(built.company_meta.notes));

  // A pane that never rendered yields no row at all, rather than a titled row
  // with an empty body that sails through triage looking like a clean fit.
  check('no description means no row', toStoreRow({ posting_id: '1', card: 'Co\nEngineer', pane: '' }), null);
  check('no title means no row', toStoreRow({ posting_id: '1', card: '', pane: PANE }), null);
}

console.log('🧪 import-handshake: what gets left out');
{
  const rows = [
    { posting_id: '1', card: 'Real Co\nMechanical Engineer I\nAustin, TX', pane: 'Job description\nA real body.' },
    { posting_id: '2', card: 'Aerotek\nMechanical Engineer\nAustin, TX', pane: 'Job description\nA real body.' },
    { posting_id: '3', card: 'Held Co\nProcess Engineer I\nBoise, ID', pane: 'Job description\nA real body.' },
    { posting_id: '4', card: 'Broken Co\nEngineer', pane: '' },
  ];
  const { take, skipped } = selectImportable(rows, { storeRows: [{ company: 'Held Co', title: 'Process Engineer 1' }] });
  check('only the genuinely new, readable posting survives', take.map(r => r.company), ['Real Co']);
  check('the agency is filtered', skipped.filtered, 1);
  check('the one we already hold is counted', skipped.alreadyHave, 1);
  check('the unreadable one is counted', skipped.unreadable, 1);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
