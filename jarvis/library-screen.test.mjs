// The whole-library screen (F-958): its verdicts on postings like the night's
// real drops and picks, judged from fixture text — the store is never read.
import { screenRow, rowKey, removalTable, STAGES } from './library-screen.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass += 1; return; }
  fail += 1; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
console.log('\n🧪 library-screen: removes on the posting\'s own words, never on a guess');

const base = { company: 'Acme Robotics', title: 'Manufacturing Engineer I', location: 'Boston, MA', location_bucket: 'us', fit_score: 80,
  level_years: null, f_newgrad: 0, desc_len: 3000, f_hard_block: 0, fit_blocked: 0, f_senior: 0, f_intern: 0, f_grad_mismatch: 0, pick_note: null };
const pad = 'About the role. You will design fixtures, run time studies and improve assembly lines for our robots. Responsibilities include root cause analysis and process documentation. '.repeat(4);
const body = (req) => `${pad}\nQualifications\n${req}\n`;
const ctx = { hidden: new Set(['hiddenco']), rules: null, taste: false };

const stage = (row, text) => screenRow({ ...base, ...row }, text, ctx).stage;
eq('ASM-like: "3+ years of experience in mechanical design" is a years drop',
  stage({ company: 'ASM', title: 'Engineer I, Mechanical Design' }, body('• Bachelor\'s in Mechanical Engineering\n• 3+ years of experience in mechanical design, drafting, or CAD modeling.')), 'years');
eq('TARGAN-like: "Minimum of 2 years" is a years drop',
  stage({ company: 'TARGAN', title: 'Manufacturing Engineer I - Commercialization' }, body('• Minimum of 2 years of hands-on experience in manufacturing engineering, product commercialization.')), 'years');
eq('Regal-like: a U.S.-person line is a clearance drop',
  stage({ company: 'Regal Rexnord', title: 'Design Engineer I' }, body("• Bachelor's in Mechanical Engineering\nThis position requires access to technology subject to ITAR; candidates must be a U.S. Person (U.S. citizen or permanent resident).")), 'clearance');
eq('Neogen-like: the visa classifier\'s block is a visa drop', stage({ f_hard_block: 1, block_key: 'no_sponsorship' }, body("• Bachelor's degree")), 'visa');
eq('a hidden company is out', stage({ company: 'HiddenCo' }, body("• Bachelor's")), 'employer');
// The top-up reads only this screen's survivors (curate daily, library stage), so these two hold for it too.
eq('the Tesla cap holds in the library screen (and so in the top-up)', screenRow({ ...base, company: 'Tesla' }, body("• Bachelor's in Mechanical Engineering"), ctx).reason, 'capped employer');
eq('his rules quote the stored reason (fit_blockers)',
  screenRow({ ...base, fit_blocked: 1, fit_blockers: JSON.stringify(['Not one of the roles you asked for (engineer…)']) }, body("• Bachelor's"), ctx).reason, 'Not one of the roles you asked for (engineer…)');
eq('…and a row written before the column still gets the generic one',
  screenRow({ ...base, fit_blocked: 1 }, body("• Bachelor's"), ctx).reason, 'blocked by his preferences');
eq('a posted top under the $80K floor is out', stage({ salary_max: 72000 }, body("• Bachelor's")), 'pay');
eq('a stored teaser waits on a body, it is not dropped', screenRow({ ...base, desc_len: 340 }, 'Join our team as an engineer.', ctx).verdict, 'waiting');
eq('…and neither is a row with no body at all', screenRow(base, '', ctx).stage, 'waiting-body');
eq('Ginkgo-like: "no years" entry mechatronics with a full body survives',
  stage({ company: 'Ginkgo Bioworks', title: 'Mechatronics Engineer I' }, body("• Bachelor's degree in Mechanical Engineering or related field\n• Experience designing a complex custom mechatronic system (academic projects count)")), 'survivor');
eq('Symbotic-like new grad survives', stage({ company: 'Symbotic', title: 'New Grad- Manufacturing Engineer', f_newgrad: 1 },
  body("• Bachelor's in Industrial Engineering, Mechanical Engineering, or a related engineering discipline.\n• Internship, co-op, academic project, or other hands-on exposure to manufacturing.")), 'survivor');
eq('a row read before keeps its verdict', stage({ pick_note: 'Not curated — read by the daily curation — x' }, body('x')), 'read-before');
eq('taste ranks, it does not remove', screenRow({ ...base, company: 'Unknown Widget Co' }, body("• Bachelor's in Mechanical Engineering"), { ...ctx, taste: true }).verdict, 'survivor');

// Years come from the text, never from the stored column alone (review, 2026-11-03).
const yrs = (req, row = {}) => stage({ title: 'Manufacturing Engineer', ...row }, body(req));
eq('"0-2 years" survives', yrs('• 0-2 years of manufacturing experience'), 'survivor');
eq('"2+ years preferred" survives (preferred is not required)', yrs("• Bachelor's in Mechanical Engineering\nPreferred: 2+ years of experience in a production environment"), 'survivor');
// A floor of one is the reader's call (his rule: "1-2" is a MAYBE when internships count, "1-3" a drop), never the screen's.
eq('a required "1-3 years" goes to the reader', yrs('• 1-3 years of experience in manufacturing engineering required'), 'survivor');
eq('…a required "3+ years" does not', yrs('• 3+ years of experience in manufacturing engineering required'), 'years');
eq('"sponsorship available" survives', yrs("• Bachelor's in Mechanical Engineering\nVisa sponsorship is available for this position."), 'survivor');
eq('"Bachelor\'s or equivalent experience" survives', yrs("• Bachelor's degree in Engineering or equivalent experience"), 'survivor');
eq('ASML-like ladder "Bachelor’s degree and at least 5 years" is a years drop', yrs('• Bachelor’s degree and at least 5 years of relevant professional experience; or\n• Master’s degree and at least 3 years of relevant professional experience.'), 'years');
eq('Apple-like "3+ years in an engineering role" under minimum qualifications is a years drop', yrs('Minimum Qualifications\n• BS in Mechanical Engineering\n• 3+ years in an engineering role'), 'years');
eq('…"3+ years preferred" stays a drop (his rule: 3+ preferred counts as required)', yrs('Preferred Qualifications\n• 3+ years of experience preferred'), 'years');
eq('…"2+ years is a plus" does not', yrs("• Bachelor's in Mechanical Engineering\n• 2+ years of experience is a plus"), 'survivor');
eq('…nor "nice to have: 2 years"', yrs("• Bachelor's in Mechanical Engineering\nNice to have: 2 years of manufacturing experience"), 'survivor');
eq('…nor "1-2 years or equivalent internship experience"', yrs("• Bachelor's in Mechanical Engineering\n• 1-2 years of experience or equivalent internship experience"), 'survivor');
eq('KLA-like "5 years of related experience with a Bachelor’s degree" is a years drop', yrs('5 years of related experience with a Bachelor’s degree; or 1 years and a Master’s degree; or equivalent work experience.'), 'years');
eq('…but "0-3 years" is not', yrs('• 0-3 years of hands-on mechanical engineering experience'), 'survivor');
// Review of 46021fe6: ambiguous years go to the reader.
eq('"5 years or an equivalent combination of education and experience" goes to the reader', yrs("• Bachelor's in Mechanical Engineering\n• 5 years of related experience or an equivalent combination of education and experience"), 'survivor');
eq('Zipline-like "BS or MS in ME, Product Design, or a related field, with 4+ years" is a years drop', yrs("• BS or MS in Mechanical Engineering, Product Design Engineering, or a related field, with 4+ years of hands-on experience delivering physical products"), 'years');
eq('Helion-like "B.S. with 4+ years, or M.S. with 2+" is a years drop', yrs("• B.S. with 4+ years of relevant experience, or M.S. with 2+ years of relevant experience"), 'years');
eq('Micron-like "3+ years" with only its own level label (FAB Engineer 2) is a years drop', yrs("Job profile: FAB Engineer 2\n• 3+ years of experience in semiconductor process or equipment engineering required"), 'years');
eq('…but an Engineer II line beside an Engineer I line goes to the reader', yrs("• Engineer I: Bachelor's in Mechanical Engineering, new graduates welcome\n• Engineer II requires 3+ years of design experience."), 'survivor');
eq('"Bachelor\'s degree in ME. 3+ years of experience is a plus." is two sentences, not a rung', yrs("• Bachelor's degree in ME. 3+ years of experience is a plus."), 'survivor');
eq('"Bachelor\'s in ME required. Nice to have: 5 years of experience with CAD." is not a rung', yrs("• Bachelor's in ME required. Nice to have: 5 years of experience with CAD."), 'survivor');
eq('"Engineer II: 3+ years" in the body of a "Mechanical Engineer" posting goes to the reader', yrs("• Bachelor's in Mechanical Engineering\n• Engineer II: 3+ years of design experience"), 'survivor');
eq('PsiQuantum-like "3 plus years" is a number, not "a plus"', yrs("• 3 plus years of relevant mechanical design experience on a large-scale system required"), 'years');
eq('"5+ years …, ideally on robotic systems" — "ideally" names the domain, the years stand', yrs("• 5+ years of professional experience in mechanical engineering, ideally on robotic systems"), 'years');
eq('…but "ideally 3+ years" is a wish', yrs("• Bachelor's in Mechanical Engineering\n• Ideally 3+ years of design experience"), 'survivor');
eq('Amazon-like "4+ years of working in mechanical engineering or equivalent experience" is a years drop', yrs("Basic qualifications\n- 4+ years of working in mechanical engineering or equivalent experience\n- Bachelor's degree in mechanical engineering"), 'years');
eq('"3+ years … internship or co-op experience counts" goes to the reader', yrs("• Bachelor's in Mechanical Engineering\n• 3+ years of engineering experience required; internship or co-op experience counts toward this."), 'survivor');
eq('"Engineer II requires 3+ years" on a posting with no II in its title goes to the reader', yrs("• Bachelor's in Mechanical Engineering\n• Engineer II requires 3+ years of design experience."), 'survivor');
// His ladder rule judges the Bachelor's rung: "BS with 3 years, or MS with 1 year" asks HIM for 3.
eq('"BS with 3 years, or MS with 1 year" is a years drop (Bachelor rung)', yrs("• BS with 3 years of experience, or MS with 1 year of experience, in mechanical engineering"), 'years');
eq('"2+ years of non-internship … experience" is not internships counting', yrs("• Bachelor's in Mechanical Engineering\n• 2+ years of non-internship professional software development experience"), 'years');
eq('Abbott: "Bachelors Degree (± 16 years)" is schooling, not a rung', yrs("Education: Bachelors Degree (± 16 years)\nExperience: Internship or co-op experience in manufacturing"), 'survivor');
eq('…and Abbott\'s "Minimum 3 years" beside it is still the years drop', yrs("Education: Bachelors Degree (± 16 years)\nExperience: Minimum 3 years"), 'years');
eq('a ladder whose Bachelor\'s rung asks 4+ is a drop', yrs("• PhD, or MS with 2+ years, or BS with 4+ years of relevant experience"), 'years');
eq('…and "BS with 3+ years of experience" with an MS rung beside it', yrs("• BS with 3+ years of experience; MS with 1+ year; PhD with 0 years"), 'years');
eq('…but "BS with 0-2 years, or MS" is not', yrs("• BS with 0-2 years of experience, or MS in Mechanical Engineering"), 'survivor');
eq('…but a plain "minimum 3 years" is still a drop', yrs("• Bachelor's in Mechanical Engineering\n• Minimum 3 years of experience in manufacturing engineering"), 'years');
eq('a stored 2 with no body waits for the body, it is not dropped', screenRow({ ...base, level_years: 2 }, '', ctx).stage, 'waiting-body');
eq('…and a stored 2 over a 0-2 body survives', yrs('• 0-2 years of experience', { level_years: 2 }), 'survivor');

// Where it is (audit, 2026-11-03): only abroad is "not-us"; unknown is read again, never dropped silently.
{
  const places = new Map([['evendale', { us: 60, non: 0 }], ['atlanta', { us: 900, non: 2 }], ['penang', { us: 0, non: 300 }], ['suzhou', { us: 0, non: 500 }]]);
  const where = (row) => screenRow({ ...base, ...row }, body("• Bachelor's in Mechanical Engineering"), { ...ctx, places });
  eq('remote, US is US', where({ location_bucket: 'remote', location: 'Remote, US' }).stage, 'survivor');
  eq('"Des Moines, IA, United States, Remote" is US', where({ location_bucket: 'remote', location: 'Des Moines, IA, United States, Remote' }).stage, 'survivor');
  eq('remote in Germany is abroad', where({ location_bucket: 'remote', location: 'Remote, Germany' }).stage, 'not-us');
  eq('a US city with no state (learned) is US', where({ location_bucket: 'unknown', location: 'Evendale' }).stage, 'survivor');
  eq('a metro area is US', where({ location_bucket: 'unknown', location: 'Atlanta Metropolitan Area' }).stage, 'survivor');
  const blank = where({ location_bucket: 'unknown', location: '' });
  eq('a blank place survives…', blank.stage, 'survivor');
  eq('…marked "location unknown"', /location unknown/.test(blank.reason), true);
  eq('Penang stays abroad', where({ location_bucket: 'unknown', location: 'Bayan Lepas, Penang' }).stage, 'not-us');
  eq('Suzhou stays abroad', where({ location_bucket: 'unknown', location: 'Suzhou' }).stage, 'not-us');
  eq('a bucketed non-US row stays out', where({ location_bucket: 'non-us', location: 'Pune, IN' }).stage, 'not-us');
}

// The key changes when what the verdict depends on changes, and only then.
eq('the key is stable', rowKey(base, 'r1'), rowKey({ ...base }, 'r1'));
eq('…and moves with the body', rowKey(base, 'r1') === rowKey({ ...base, desc_len: 3001 }, 'r1'), false);
eq('…and with the rules', rowKey(base, 'r1') === rowKey(base, 'r2'), false);

// The table accounts for every open row.
const counts = Object.fromEntries(STAGES.map((k) => [k, 0]));
counts['not-us'] = 5; counts.years = 3; counts['waiting-body'] = 2; counts.survivor = 1;
const t = removalTable({ open: 11, screened: 11, reused: 0, bodiesRead: 4, counts, ms: 10 });
eq('the table names the waiting rows on their own line', /waiting-body/.test(t), true);
eq('…and ends at the survivors', /=\s+1\s+survivors/.test(t), true);

// A SHORT BODY THAT WILL NOT GET LONGER (F-979): read in full, or 500+ with no
// requirements section, it goes on to the reader marked low confidence.
{
  const short = 'Manufacturing Engineer I at Acme Robotics in Boston. You will improve our assembly lines and fixtures, working with production, quality and design teams on new robot builds. '.repeat(3).slice(0, 460);
  eq('a short body never read in full still waits for the enricher', screenRow({ ...base, desc_len: short.length, enriched_at: null }, short, ctx).stage, 'waiting-body');
  const done = screenRow({ ...base, desc_len: short.length, enriched_at: '2026-11-04T01:00:00Z' }, short, ctx);
  eq('read in full and still short: the reader gets it, low confidence', [done.verdict, /low confidence: short at the source/.test(done.reason)], ['survivor', true]);
  const longThin = `${short} ${short}`;
  eq('500+ with no requirements section is final too', screenRow({ ...base, desc_len: longThin.length, enriched_at: null }, longThin, ctx).verdict, 'survivor');
  eq('under 400 characters after a full read: counted as short at the source, not a survivor',
    screenRow({ ...base, desc_len: 120, enriched_at: '2026-11-04T01:00:00Z' }, 'Join our team as an engineer. Apply today to build robots with us in Boston.', ctx).stage, 'short-at-source');
  eq('…and from the columns alone, without reading the body', screenRow({ ...base, desc_len: 120, enriched_at: '2026-11-04T01:00:00Z' }, '', ctx).stage, 'short-at-source');
  eq('a stored 400+ body is read before it is judged', screenRow({ ...base, desc_len: 450, enriched_at: '2026-11-04T01:00:00Z' }, '', ctx).stage, 'waiting-body');
  eq('a full body is not marked low confidence', /low confidence/.test(screenRow(base, body("• Bachelor's in Mechanical Engineering"), ctx).reason), false);
  eq('the stage is in the removal table\'s order', STAGES.includes('short-at-source'), true);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
