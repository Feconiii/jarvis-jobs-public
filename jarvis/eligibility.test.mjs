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

  // F-756: an MBA can be preferred too.
  ok('"MBA preferred" is a preference', degreeBar('Degree in Finance or related field required, MBA preferred'), 'bachelors-ok');
  ok('"preferred: MBA"', degreeBar('Education: degree in Business required; preferred: MBA'), 'bachelors-ok');
  ok('…a required MBA is still advanced-only', degreeBar('Education: MBA degree from an accredited program'), 'advanced-only');
  // F-757: other spellings of a bachelor's.
  ok('"Four-year or Graduate Degree"',
    degreeBar('Four-year or Graduate Degree in Manufacturing Engineering, Mechanical Engineering, or any other related discipline'), 'bachelors-ok');
  ok('"Baccalaureate degree"',
    degreeBar("Required: Baccalaureate degree in Engineering or a Master's degree in Mechanical Engineering"), 'bachelors-ok');
  ok('…"post-baccalaureate experience" is not a bachelor route',
    degreeBar('Master’s degree in Chemical Engineering, a related field, or a foreign equivalent plus 2 years of post-baccalaureate experience'), 'advanced-only');
  // F-758: a title open to undergraduates and MBAs is not advanced-only.
  ok('title "Undergraduate & MBA" (Western Digital)',
    degreeBar("Currently pursuing a Bachelor's degree or MBA in Finance or Accounting", 'Summer 2027 Intern - Financial Analyst - Undergraduate & MBA'), 'bachelors-ok');
  ok('…MBA alone in the title still is', degreeBar('Currently pursuing a degree in Finance', 'Summer 2027 Intern - Financial Analyst - MBA'), 'advanced-only');

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

console.log('\n🧪 F-771: refusals from his deck that were wrong');
{
  // Each sentence is verbatim from a posting the screen refused.
  const notAdvanced = (name, text, expected = 'unknown') => ok(name, degreeBar(text), expected);
  notAdvanced('a bracketed "advanced degree … a plus" (Tesla, Line Design)',
    '• Degree in Industrial Engineering or a related field (advanced degree or relevant certifications are a plus), or equivalent industry experience and evidence of exceptional ability');
  notAdvanced('…the same in Mechanical (Tesla, Optimus Hand)',
    '• Degree in Mechanical Engineering or a related field (advanced degree or relevant certifications are a plus), or equivalent industry experience and evidence of exceptional ability');
  notAdvanced('"is a strong plus" (Matic)',
    '- Technical degree in mechanical engineering, materials science, or equivalent, with 2-5 years of experience in a reliability engineering position. An advanced degree in reliability, materials science, or a related field is a strong plus');
  notAdvanced('an experience route beside the Master’s (Panthalassa)',
    '• Master’s degree in mechanical engineering or related field, or additional industry experience');
  notAdvanced('"Engineering or master’s degree" (TE Connectivity)',
    'Engineering or master’s degree in industrial engineering or equivalent (Mechanical /Automation)');
  notAdvanced('a preference far from its degree (TSMC)',
    'Master’s degree in Industrial Engineering or a related fields are preferred.');
  notAdvanced('"(preferred)" at the end (Trimble)',
    '• Education: Master’s or PhD in Mechanical, Electrical, Aerospace, GNC, or a related engineering field (preferred).');
  notAdvanced('"P.E. certificate preferred" is not cut at "P.E." (PACCAR)',
    'Masters degree in business or engineering and P.E. certificate preferred');
  notAdvanced('"Master/Ph.D. degree preferred" (Onto)', 'Master/Ph.D. degree preferred, will consider experience versus degree');
  notAdvanced('a substitution (NYCHA)',
    'A masters degree in civil engineering from an accredited college or university, accredited by regional, national, professional or specialized agencies recognized as accrediting bodies by the U.S. Secretary of Education and by the Council for Higher Education Accreditation (CHEA) may be substituted for one year of the civil engineering experience required in “1" above.');
  notAdvanced('years first, the degree the other route (1X)',
    '- 5+ years of relevant industry experience, or an advanced degree plus equivalent hands-on experience');
  notAdvanced('"BSEE minimum" is a bachelor’s (NVIDIA)', '• BSEE minimum (or equivalent experience), MSEE or PhD', 'bachelors-ok');
  notAdvanced('under a "Nice-to-have" heading (Atomic Semi)',
    "- Degree in Mechanical Engineering, Electrical Engineering, Mechatronics, Automation, or Physics\n\nNice-to-have\n\n- Master's degree and 3+ years of relevant experience");
  // Mission Critical Group: the line the spot check marked "correct" sits
  // under "Preferred"; the requirement is a high-school diploma.
  ok('a Master’s under "Preferred" is no bar (Mission Critical Group)',
    eligibility({ title: 'Mechanical Engineer' }, "Preferred\n\n• Master's degree in Mechanical Engineering.\n• Professional Engineer (PE) license.\n\nEducation\n\n• High school diploma or GED, required").verdict !== 'not-eligible', true);

  // …and what still refuses.
  ok('bare "Master\'s degree in Mechanical Engineering." still refuses', degreeBar("• Master's degree in Mechanical Engineering."), 'advanced-only');
  ok('"Minimum Education Required: Master’s" (SiTime)', degreeBar('• Minimum Education Required: Master’s degree or foreign equivalent.'), 'advanced-only');
  ok('a bare "Master’s degree or higher" (Slip Robotics)',
    degreeBar('• Master’s degree or higher in Robotics, Controls, Mechanical Engineering, or a related field'), 'advanced-only');
  ok('…the same line under "Nice to Have" does not',
    degreeBar('Nice to Have\n\n• Master’s degree or higher in Robotics, Controls, Mechanical Engineering, or a related field'), 'unknown');
  ok('a bracketed PhD preference leaves the Master’s required (Solstice)',
    degreeBar('• Master’s degree (Ph.D. preferred) in Material Science, Chemical Engineering, Polymer Science, or Chemistry'), 'advanced-only');
  ok('"…related field, Ph.D. preferred" leaves the Master’s required (Lumilens)',
    degreeBar("- Master's degree in optical engineering or a related field, Ph.D. preferred."), 'advanced-only');
  ok('a PhD the candidates "must hold" (Purdue)',
    degreeBar('Successful candidates must hold a Ph.D. degree in Biomedical Engineering, Electrical and Computer Engineering, Mechanical Engineering, Industrial Engineering, Computer Science or a related discipline by the employment start date.'), 'advanced-only');
  ok('PhD preferred, Master’s the floor (Applied Materials)',
    degreeBar("Ph.D. in Physics, Electrical Engineering, Materials Science, or a related technical field preferred. (Master's degree with relevant industry experience may also be considered.)"), 'advanced-only');
  ok('"plus 2 years" is arithmetic, not a preference',
    degreeBar('Master’s degree in Chemical Engineering, a related field, or a foreign equivalent plus 2 years of experience'), 'advanced-only');

  // Subjects.
  ok('"relevant technical field, or equivalent practical experience" (General Robotics)',
    subjectFit("- Bachelor's degree in Robotics, Computer Science, Computer Engineering, Electrical Engineering, relevant technical field, or equivalent practical experience."), 'maybe-related');
  ok('"…or Equivalent" (Wolfspeed)', subjectFit('• BS in Electrical Engineering, Chemical Engineering, Materials Science, or Equivalent'), 'maybe-related');
  ok('"or another technical discipline" (Mitsubishi Chemical)',
    subjectFit("• Bachelor's or Master's degree in Chemical Engineering, Chemistry, Materials Science, or another technical discipline."), 'maybe-related');
  ok('a preferred subject (CMC)', subjectFit("• Bachelor's degree in Electrical Engineering preferred"), 'other-preferred');
  ok('a preferred subject (Agropur)', subjectFit('• Associate or Technical School Degree in Electrical Engineering or Automation preferred.'), 'other-preferred');
  ok('"required, preferably Electrical"', subjectFit('Bachelor’s degree is required, preferably Electrical engineering.'), 'other-preferred');
  ok('experience first, the degree the other route (Nimble Robotics)',
    subjectFit('• 0-5 years of experience in a production environment supporting and improving complex robotics systems, or a minimum of 2 years of experience combined with a Bachelor of Science degree in Computer Science, Software Engineering, or Robotics.'), 'maybe-related');
  ok('a bachelor’s route with no subject (Lam Research)',
    subjectFit("* Typically requires a Bachelor's degree and a minimum of 2 years of related experience, or a Master’s degree in Materials Science, Chemical Engineering, Chemistry, Physics."), 'maybe-related');
  ok('"ME" in a slash list (Periodic Labs)', subjectFit('- BS in EE/CS/ME/Controls or equivalent.'), 'his-field');
  ok('"Mechatronics" is his (Heron Power)',
    subjectFit('- Bachelor’s degree in Electrical Engineering, Computer Engineering, Mechatronics, or equivalent practical experience.'), 'his-field');
  ok('"a major milestone" is no degree (Nova Biomedical)',
    subjectFit('Advanced Instruments and Nova Biomedical are now united under one brand, Nova Biomedical, marking a major milestone in our journey to deliver greater value to our customers.'), 'unknown');
  ok('"No CS degree required." asks for nothing (SageOx)',
    subjectFit('- Technically fluent, with craft. At home in a codebase and in the terminal. You notice the empty state, the focus ring, and the error message. No CS degree required.'), 'unknown');
  ok('"Working towards a BS degree in Physics or any Engineer area" (Seagate)',
    subjectFit('Working towards a BS degree in Physics or any Engineer area.'), 'his-field');

  // …and what still excludes.
  ok('"relevant military training" opens nothing (Executive Alliance)',
    subjectFit('• Must have BSEE, electrical engineering degree or relevant military training and experience.'), 'excluded');
  ok('EE "with some Computer Science knowledge" (Hubbell)',
    subjectFit('Bachelor’s Degree in Electrical Engineering with some Computer Science knowledge'), 'excluded');
  ok('"B.S. Electrical Engineering" (Vicor)', subjectFit('• B.S. Electrical Engineering'), 'excluded');
  ok('"B.S. or higher in EE, Photonics, Physics…" (Nokia)',
    subjectFit('• B.S. or higher in Electrical Engineering, Photonics, Physics, or Materials Science with at least 2 years of semiconductor fab experience.'), 'excluded');
  ok('"Bachelor’s or Master’s" is one route, not two (Micron)',
    subjectFit('Bachelor’s or Master’s degree in Chemical Engineering, Electrical Engineering, Material Science, or Physics.'), 'excluded');
  ok('required subject, preferred advanced degree (Applied Materials)',
    subjectFit('Bachelor’s degree in Physics or Electrical Engineering required; advanced degree (Master’s or PhD) strongly preferred.'), 'excluded');
  ok('a line that says "required" is required under any heading (AMD)',
    subjectFit("PREFERRED EXPERIENCE:\n\n• Excellent technical documentation skills\n\nACADEMIC CREDENTIALS\n\n• Bachelor’s or master's degree in Electrical Engineering required"), 'excluded');
  ok('lowercase "me" is a word', subjectFit('Send me your resume if you have a Bachelor’s degree in Electrical Engineering'), 'excluded');
  ok('"BSEE required" names a subject', subjectFit('• BSEE required'), 'excluded');

  // The refusal quotes the line that decided it, not the job title.
  ok('evidence is the degree line (Vicor)',
    eligibility({ title: 'Associate Test Engineer' }, 'Requirements\n• B.S. Electrical Engineering').evidence, 'B.S. Electrical Engineering');

  // Titles.
  ok('Manufacturing Engineer (Supply Chain) is his (Apptronik)', titleIsElsewhere('Manufacturing Engineer (Supply Chain) - Electromechanical'), false);
  ok('Process Engineer … Reverse Logistics is his (Garmin)', titleIsElsewhere('Process Engineer 2 - Global Service/Reverse Logistics'), false);
  ok('Decision Engineer, Manufacturing & Supply Chain (Fluidstack)', titleIsElsewhere('Decision Engineer, Manufacturing & Supply Chain'), false);
  ok('bare supply chain is still not his', titleIsElsewhere('Supply Chain Planning Analyst'), true);
  // Amazon spells it "Software Dev Engineer"; the rule only knew "Software
  // Development Engineer", and "supply chain" was what refused these.
  ok('a software dev engineer is not his', titleIsElsewhere('Software Dev Engineer II, AWS Infra Supply Chain Automation'), true);
  const v = (title, desc) => eligibility({ title }, desc).verdict;
  ok('a soft title word gives way to his degree line', v('Customer Support Engineer', 'Bachelor’s degree in Mechanical Engineering required'), 'check');
  ok('…not on a title that is no engineering job', v('Customer Success Manager', "Bachelor's degree in Engineering or Business"), 'not-eligible');
  ok('…nor when the degree line is silent', v('Supply Chain Engineer', 'Five years of sourcing experience.'), 'not-eligible');
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
