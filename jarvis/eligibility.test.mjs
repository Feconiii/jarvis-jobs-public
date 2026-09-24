// jarvis/eligibility.test.mjs — can he actually apply to this.
//
// Every case below is wording taken from a posting in his real store, because
// every one of them was got wrong at least once while this was being built. The
// screen swung to over-blocking and back to under-blocking twice; these are the
// measurements that stopped it.

import { degreeBar, subjectFit, titleIsElsewhere, eligibility } from './eligibility.mjs';
import { whereIsIt } from './picks.mjs';

let pass = 0, fail = 0;
const ok = (name, got, expected) => {
  if (got === expected) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`);
};

console.log('\n🧪 the degree he will hold');
{
  // The one that started it: number one on the first shortlist ever produced.
  ok('title says Masters', degreeBar('', 'Mechanical Engineer New College Grad - Masters Degree'), 'advanced-only');
  ok('title says MBA', degreeBar('', 'MBA Internship – Ecosystem Development'), 'advanced-only');
  ok('title says BS/MS keeps him', degreeBar('BS or MS in Engineering', 'Engineer BS/MS'), 'bachelors-ok');

  ok('a real masters requirement',
    degreeBar('Education – Master’s degree in Chemical Engineering, a related field, or a foreign equivalent'),
    'advanced-only');
  ok('pursuing a masters',
    degreeBar('Minimum Qualifications: Currently pursuing a master’s degree in electrical engineering'),
    'advanced-only');

  // A BACHELOR'S NAMED AS SUFFICIENT ANSWERS THE QUESTION, whatever the posting
  // goes on to prefer. This exact line was excluded on the first version.
  ok('BS or higher, MS preferred',
    degreeBar('BS or higher in Engineering. Advanced MS degree preferred. Other degrees may be considered.'),
    'bachelors-ok');
  ok('bachelor or master', degreeBar("Bachelor's or Master's degree in Mechanical Engineering"), 'bachelors-ok');
  ok('masters preferred', degreeBar("Bachelor's degree required. Master's degree preferred."), 'bachelors-ok');

  // Both, in different places — a question, not a verdict in either direction.
  ok('mixed signals go to him',
    degreeBar('Bachelor’s degree\nQualifications: Master’s degree or foreign equivalent in Industrial Engineering'),
    'mixed');

  // "MASTER'S OR PHD" IS TWO ADVANCED OPTIONS, NOT AN ALTERNATIVE TO A
  // BACHELOR'S. Read as optional, this posting reached his curated inbox as a
  // role Claude said it stood behind — and the store's own older screen had it
  // right all along, which is the only reason the disagreement was visible.
  ok('masters or phd is not optional',
    degreeBar("Pursuing a Master's or PhD degree in Chemical Engineering, Chemistry, Mechanical Engineering, or Material Science"),
    'advanced-only');
  ok('silent posting', degreeBar('Join our team and build great things.'), 'unknown');
}

console.log('\n🧪 the degree subject');
{
  // The robotics internship this screen threw away on its first run — the most
  // on-target posting in the entire shortlist.
  ok('generic engineering is his',
    subjectFit('Education – A junior actively pursuing a Bachelor\'s – Majoring in Engineering or Computer Science/Computer Engineering or related field'),
    'his-field');
  ok('mechanical named outright',
    subjectFit('Bachelor’s degree in Mechanical Engineering or related field'), 'his-field');
  ok('manufacturing counts', subjectFit('Pursuing a degree in Manufacturing Engineering'), 'his-field');

  // …and the mirror: a list of other disciplines, with the noun attached to
  // each one, must NOT read as generic engineering.
  ok('an all-electrical list excludes him',
    subjectFit('Bachelor’s degree in Electrical Engineering, Computer Engineering, or Computer Science'),
    'excluded');
  ok('a related-field door is a question, not a no',
    subjectFit('Bachelor’s or Master’s degree in Electrical Engineering, Computer Science, or a related technical discipline'),
    'maybe-related');
  ok('no subject named', subjectFit('We are hiring engineers.'), 'unknown');
}

console.log('\n🧪 the title names the work');
{
  ok('asic is not his', titleIsElsewhere('ASIC Engineer Intern, Annapurna Labs'), true);
  ok('software engineer is not his', titleIsElsewhere('Robotics - Software Development Engineer Fall Intern'), true);
  ok('business analyst is not his', titleIsElsewhere('New College Grad Business Analyst'), true);
  ok('data scientist is not his', titleIsElsewhere('Entry-Level Data Scientist – Semiconductor'), true);

  // FAB STAGES, NOT WEB DEVELOPMENT. "front end" and "back end" name where in
  // the fab the work happens; reading them as job titles hid four real
  // manufacturing roles.
  ok('front-end processing is a fab stage', titleIsElsewhere('Test Manufacturing Engineer Front End Processing'), false);
  ok('back-end manufacturing is a fab stage', titleIsElsewhere('Test Back-End Manufacturing Engineer'), false);
  ok('equipment engineer is his', titleIsElsewhere('New College Grad - Equipment Engineer (RDA & Metrology)'), false);
  ok('fab automation is his', titleIsElsewhere('Fab Automation Engineer (2027 New College Graduate)'), false);
  ok('process engineer is his', titleIsElsewhere('New College Grad Diffusion Process Engineer'), false);
}

console.log('\n🧪 where the job is');
{
  ok('a state name', whereIsIt('Essex, VT,US, US'), 'us');
  ok('spelled out', whereIsIt('Santa Clara, CA, United States'), 'us');
  ok('a bare foreign city', whereIsIt('Kaohsiung'), 'elsewhere');
  ok('a foreign city with detail', whereIsIt('Sophia-Antipolis (Valbonne)'), 'elsewhere');
  ok('canada', whereIsIt('Ottawa'), 'elsewhere');
  // A posting written in another script is not a US posting, and none of the
  // country lists were reading that alphabet.
  ok('another script', whereIsIt('장비 엔지니어 신입채용'), 'elsewhere');
  // NEVER A SILENT DROP: an unknown location stays and carries the label.
  ok('a bare US city is unclear, not rejected', whereIsIt('Santa Clara'), 'unclear');
  ok('empty is unclear', whereIsIt(''), 'unclear');
}

console.log('\n🧪 the verdict as a whole');
{
  const v = (title, desc) => eligibility({ title }, desc).verdict;
  ok('a role he can take', v('Fab Automation Engineer (2027 New College Graduate)',
    'Bachelor’s degree in Mechanical Engineering or related field. Graduating 2027.'), 'apply');
  ok('a masters role', v('Process Engineer', 'Education – Master’s degree in Chemical Engineering'), 'not-eligible');
  ok('another discipline', v('ASIC Engineer Intern', 'Bachelor’s degree in Engineering'), 'not-eligible');
  ok('an open question', v('Test Engineer',
    'Bachelor’s degree in Electrical Engineering, Computer Science, or a related technical discipline'), 'check');
  // Evidence travels with a refusal, so a wrong call is arguable rather than
  // invisible.
  ok('a refusal quotes the posting',
    /Master/.test(eligibility({ title: 'Process Engineer' }, 'Education – Master’s degree in Chemical Engineering').evidence),
    true);
}


console.log('\n🧪 the audit: false exclusions that were already in his store');
{
  // Every case here was a live row carrying f_degree_mismatch = 1, hidden from
  // the deck, when an adversarial audit of this file found it.
  ok('MS is Mississippi in a title', degreeBar('', 'Field Service Engineer - Jackson, MS'), 'unknown');
  ok('MS is Mississippi in a body', degreeBar('Field service across Jackson, MS. Bachelor’s degree required.'), 'bachelors-ok');
  ok('Master Scheduler is a job, not a degree',
    degreeBar('Bachelor’s degree in Mechanical Engineering required.', 'Master Scheduler'), 'bachelors-ok');
  ok('Master Launch Welder is a job', degreeBar('High school diploma.', 'Master Launch Welder'), 'unknown');
  ok('BSc is a bachelor’s',
    degreeBar('B.Sc. in a relevant physical science or engineering discipline required; advanced degree strongly desired'),
    'bachelors-ok');
  ok('BSc or MSc keeps him', degreeBar('Have a BSc or MSc degree in Mechanical or a related engineering discipline'), 'bachelors-ok');
  ok('BS / MS with no degree word',
    degreeBar("BS / MS in Mechanical, Manufacturing, or Industrial engineering.\nMaster's degree in manufacturing, or mechanical engineering."),
    'mixed');
  ok('B.S. Degree is not split at the abbreviation',
    degreeBar('B.S. Degree in Engineering Discipline (Nuclear, Mechanical, Electrical, Chemical, or similar)'), 'bachelors-ok');
  ok('"desired" is a preference', degreeBar('Bachelor’s required. Master’s desired.'), 'bachelors-ok');

  // A softer word beside his own work must not win.
  ok('customer support + equipment engineer is his', titleIsElsewhere('Customer Support Engineer - Equipment Engineer'), false);
  ok('customer support + field service is his', titleIsElsewhere('Customer Support Engineer (Field Service)'), false);
  ok('mechanical engineer on ML hardware is his', titleIsElsewhere('Mechanical Engineer, Annapurna Labs, Machine Learning Hardware'), false);
  ok('…but a machine learning ENGINEER is not', titleIsElsewhere('Machine Learning Engineer for Digital Manufacturing'), true);
  ok('bare customer support is still not his', titleIsElsewhere('Customer Support Engineer'), true);

  // A title-only refusal quotes the title, not an empty string.
  ok('title refusals carry evidence',
    eligibility({ title: 'ASIC Engineer Intern' }, 'Bachelor’s degree in Engineering').evidence, 'ASIC Engineer Intern');
}

console.log('\n🧪 the audit: geography');
{
  ok('full state names, any case', whereIsIt('Austin, Texas'), 'us');
  ok('spelled-out country', whereIsIt('Santa Clara, California, United States of America'), 'us');
  // Gloucester is Applied Materials' Massachusetts site — 96 live rows.
  ok('Gloucester is not assumed to be England', whereIsIt('Gloucester'), 'unclear');
  ok('Vienna VA is American', whereIsIt('Vienna, VA'), 'us');
  ok('Paris TX is American', whereIsIt('Paris, TX'), 'us');
  ok('Vienna, Austria is not', whereIsIt('Vienna, Austria'), 'elsewhere');
  // Codes stay case-sensitive: "in", "or" and "me" are words, not states.
  ok('lowercase "in" is not Indiana', whereIsIt('work in the office'), 'unclear');
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
