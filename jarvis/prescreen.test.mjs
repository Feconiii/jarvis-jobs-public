// Tests for prescreen.mjs. Every line here is quoted from a real posting the
// reader judged (2026-10-07/08): the ones it turned down for years or field,
// and the KEEP / MAYBE ones the script must leave alone.

import { prescreen, yearsBar, disciplineBar, minYears, gradProgram, stretchYears, stretchEmployer } from './prescreen.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const drops = (text, title = 'Manufacturing Engineer') => !!prescreen({ title, text });

console.log('\n🧪 prescreen: reading the number');
{
  check('"2-5 years" asks for 2', minYears('2–5 years of experience in Manufacturing Engineering'), 2);
  check('"Three (3) years minimum" asks for 3', minYears('Three (3) years minimum in a manufacturing environment required;'), 3);
  check('"4+ years" asks for 4', minYears('Four (4) plus years of experience'), 4);
  check('"5+ years" asks for 5', minYears('• 5+ years of relevant experience'), 5);
}

console.log('\n🧪 prescreen: turned down without reading');
{
  check('a required 2-5 years (Acuity)', drops('Qualifications\n2–5 years of experience in Manufacturing Engineering, Process Engineering, Industrial Engineering, or Continuous Improvement within a manufacturing environment.\nBachelor of Science in Engineering'), true);
  check('"Three (3) years minimum … required" (Ralliant)', drops('What you need\n• Three (3) years minimum in a manufacturing environment required;\n• One (1) year electronics experience preferred.'), true);
  check('"Four (4) plus years … required" (PACCAR)', drops('Four (4) plus years of experience with engine testing hardware and software required.'), true);
  check('3+ preferred counts as required (his rule)', drops('Preferred Qualifications\n3-5 years’ relevant experience preferred'), true);
  check('an electrical title with nothing of his in it', disciplineBar('NERC Compliance Engineer -open to Texas, Midwest, East locations')?.word, 'NERC');
  check('…a transmission-line design title', !!disciplineBar('Design Engineer, Electric Transmission Line'), false);
  check('…a pure software title', !!disciplineBar('Senior Software Engineer, Platform'), true);
}

console.log('\n🧪 prescreen: left for the reader (each was a KEEP or MAYBE)');
{
  check('"0-5 years" is a way in (KION, KEEP)', drops('The successful candidate must have 0-5 years of mechanical design experience.'), false);
  check('First Solar\'s "3 or more years … or 6 …" is a choice of routes (KEEP)', drops('• 3 or more years of First Solar technical experience, or\n• 6 or more years of technical work experience in a Manufacturing setting.'), false);
  check('one year is the reader\'s call (Romac, MAYBE)', drops('• 1+ years of experience in mechanical engineering'), false);
  check('"1-3 years" starts at one (Banner, MAYBE)', drops('• 1 - 3 years of relevant experience'), false);
  check('"0–2 years … includes internships" (Crusoe, MAYBE)', drops('- Experience: 0–2 years of mechanical design experience (includes internships, co-ops, or relevant academic capstone projects).'), false);
  check('"0 – 10 years … preferred" (Hyundai, MAYBE)', drops('0 – 10 years job related experience in an engineering/industrial environment preferred'), false);
  check('"zero to two years" is a range from zero (Yaskawa, F-959)', drops('Bachelor of Science degree and zero to two years related experience in mechanical engineering.'), false);
  check('"zero (0) to two (2) years" too', drops('- BS in ME with zero (0) to two (2) years of experience required.'), false);
  check('"two to four years" still starts at two', minYears('- Two to four years of experience in manufacturing engineering required.'), 2);
  check('"Up to two (2) years" is a ceiling (Wabtec, MAYBE)', drops('• Up to two (2) years’ experience in industry related field.'), false);
  check('"Less than three years" is a ceiling (Toray, MAYBE)', drops('• Less than three years of experience working in composite materials, aerospace manufacturing industry'), false);
  check('"fresh graduates welcome" (Qualcomm)', drops('* Work Experience: 3+ years preferred ( fresh graduates welcome to apply )'), false);
  check('"includes all levels" (Sunday)', drops('2+ years of mechanical engineering experience (this post includes all levels)'), false);
  check('"in lieu of a degree" is another route (Hadrian)', yearsBar('- In lieu of a degree, at least 5-6+ years of experience in a high-intensity production environment may be considered'), null);
  check('"Typically suited for … approximately 2–5 years" is not a bar (Verustruct, KEEP)', drops('• Typically suited for candidates with approximately 2–5 years of relevant professional experience developing complex mechanical or electromechanical hardware.'), false);
  check('a company history is not a requirement (Banner)', drops('For over 50 years, Banner Engineering has been at the forefront of industrial automation.'), false);
  check('a long intro paragraph is not a requirement (viaPhoton)', drops('viaPhoton builds custom-engineered fiber optic solutions that power AI infrastructure, data centers, and 5G networks for some of the biggest names in tech. In our 20 years of experience we have grown from a small shop into a partner trusted by many of the largest network operators and hyperscalers across North America.'), false);
  check('"18 years of age" is not experience (Fuyao)', drops('Must be 18 years of age or older.'), false);
  check('a mechanical title in a civil-sounding list stays (Westinghouse, MAYBE)', !!disciplineBar('Engineer (EARLY CAREER) (Mechanical, Nuclear, Chemical, or Civil)'), false);
  check('an early-career hardware title stays (Amazon)', !!disciplineBar('Cloud Hardware Development Engineer, AWS - Early Career (2026)'), false);
  check('a data-center mechanical title stays', !!disciplineBar('Data Center Mechanical Engineer'), false);
}

console.log('\n🧪 prescreen: the 2026-10-13 review (F-724)');
{
  // A company blurb above every heading is no requirement.
  check('"Our engineers bring 15+ years" in About us', drops('About us\nOur engineers bring 15+ years of industry experience to every program.\n\nQualifications\n• BS in Mechanical Engineering'), false);
  check('…and with no heading at all', drops('Our engineers bring 15+ years of industry experience to every program.'), false);
  check('"Acme has 12 years of experience" is the company', drops('Acme has 12 years of experience building conveyors.'), false);
  // A preferred heading that does not start with the word.
  check('"Qualifications (Preferred):" over a 2-year bullet', drops('Qualifications (Required):\n• BS in ME\nQualifications (Preferred):\n• 2+ years of experience in mechanical design'), false);
  check('"Qualifications - Nice to have" over a 2-year bullet', drops('Qualifications - Nice to have\n• 2+ years of experience in mechanical design'), false);
  check('"Preferred Requirements:" is preferred, so 3+ still counts', drops('Preferred Requirements:\n * 3+ years of technical experience in facilities operations'), true);
  // Still asks: no heading, under "About AWS" with nothing between, "we use".
  check('a bare bullet under no heading still drops', drops('- 3+ years of non-internship professional software development experience'), true);
  check('Amazon bullets below "About AWS" still drop', drops('About AWS\nWe are the cloud.\n\n- 5+ years of engineering, installation, or startup/commissioning of electrical and mechanical systems experience'), true);
  check('"(we use C++ 20)" is still an ask', drops('Requirements\n- 5+ years of hands-on experience developing performant modern C++ (we use C++ 20).'), true);
  // One line's figure is not hidden by the line above it.
  check('"18 years or older" does not swallow the next line', drops('Must be 18 years or older\n- 2+ years of data center engineering experience'), true);
  check('"CI/CD pipelines" above is no roadmap horizon', drops('Experience with CI/CD pipelines\n- 10+ years of engineering experience'), true);
  check('"or equivalent experience" above does not excuse the next line', drops('What we need to see:\nBachelor’s degree in Engineering, or equivalent experience\n\n2+ years of experience supporting production environments'), true);
}

console.log('\n🧪 prescreen: one reading of the years with triage (F-724)');
{
  const { classifyExperience } = await import('./triage.mjs');
  for (const line of ['• Three (3) years minimum in a manufacturing environment required;', 'Experience Level: 5-10 Years', '3+ years of programming in Python', '- BS + 6yrs or MS + 4yrs or PhD + 2yr in EE/CS']) {
    const t = classifyExperience('Engineer', line);
    check(`triage reads "${line.slice(0, 40)}…" too`, t.level !== 'unknown', true);
  }
  check('"Nobody has ten years of it yet" is no ask', classifyExperience('Automation Engineer', 'Nobody has ten years of it yet, so what you build becomes the standard.').level, 'unknown');
  check('"3+ years of programming" is not a program', minYears('3+ years of programming in Python'), 3);
}

console.log('\n🧪 prescreen: a role made for his graduating class never fails on years (his rule, 2026-11-06)');
{
  // The screen cuts a required 2+ (a "1-3" goes to the reader, whose brief and drop exception carry the rule too).
  const formlabs = 'Minimum Qualifications\n• 2+ years of experience in manufacturing engineering';
  check('a "May 2027 Graduates" role with a required 2+ years goes to the reader, not cut', drops(formlabs, 'Manufacturing Engineer - May 2027 Graduates'), false);
  check('…the same years line on an ordinary title is still cut', drops(formlabs, 'Manufacturing Engineer'), true);
  check('"New Grad- Robotics Reliability Engineer" is a program', gradProgram({ title: 'New Grad- Robotics Reliability Engineer' }), true);
  check('"Quality Engineering Graduate Program - September 2027" is one', gradProgram({ title: 'Quality Engineering Graduate Program - September 2027' }), true);
  check('"Early Career Mechanical Engineer" is one', gradProgram({ title: 'Early Career Mechanical Engineer' }), true);
  check('a body that calls itself a new grad program is one', gradProgram({ title: 'Process Engineer', text: 'This is a new grad program for students graduating in 2027.' }), true);
  check('"Graduate" alone in a degree line is not', gradProgram({ title: 'Process Engineer', text: "Bachelor's degree; graduate degree a plus." }), false);
  check('an ordinary title is not', gradProgram({ title: 'Mechanical Engineer II' }), false);
  // Review 2026-11-06.
  check('a new-grad title asking 3+ years is still cut (his earlier rule)', drops('Minimum Qualifications\n• 3+ years of experience in manufacturing engineering', 'New Grad Manufacturing Engineer'), true);
  check('"not designed for new grads" is no program', gradProgram({ title: 'Process Engineer', text: 'This role is not designed for new grads.' }), false);
  check('"NCG" is one', gradProgram({ title: 'NCG Mechanical Engineer' }), true);
  check('"Graduate Mechanical Engineer" is one', gradProgram({ title: 'Graduate Mechanical Engineer' }), true);
  check('"Engineering Rotational Program" is one', gradProgram({ title: 'Engineering Rotational Program' }), true);
}

console.log('\n🧪 prescreen: a degree\'s length is not experience (Fluor, 2026-11-06)');
{
  const fluor = 'Basic Job Requirements\n• Accredited four (4) year Bachelor\'s Degree in Chemical Engineering and no required years of experience';
  check('"four (4) year Bachelor\'s Degree" is no years bar', yearsBar(fluor), null);
  check('…nor "4-year degree in mechanical engineering"', yearsBar('Requirements\n• 4-year degree in mechanical engineering required'), null);
  check('…while "4+ years of experience" still is', !!yearsBar('Requirements\n• 4+ years of experience in process engineering'), true);
}

console.log('\n🧪 prescreen: at a robotics company a required 1-2 years is a stretch (his answer 2026-11-06, "5. ye")');
{
  const two = 'Minimum Qualifications\n• 2+ years of experience in mechanical engineering';
  const three = 'Minimum Qualifications\n• 3+ years of experience in mechanical engineering';
  check('Figure AI asking 2+ years goes to the reader', !!prescreen({ title: 'Mechanical Engineer, Arms', text: two, company: 'Figure AI' }), false);
  check('…the same line at a non-robotics employer is still cut', !!prescreen({ title: 'Mechanical Engineer', text: two, company: 'Acme Valves' }), true);
  check('…and 3+ at a robotics company is still cut', !!prescreen({ title: 'Mechanical Engineer', text: three, company: 'Figure AI' }), true);
  check('a 2+ years line at Agility is a stretch', stretchYears({ company: 'Agility Robotics', title: 'Mechanical Engineer II', text: two }), true);
  check('…so is a required "1-2 years of experience"', stretchYears({ company: 'Dexterity', title: 'Mechanical Engineer', text: 'Requirements\n• 1-2 years of industry experience' }), true);
  check('…but not 3+', stretchYears({ company: 'Agility Robotics', title: 'Mechanical Engineer', text: three }), false);
  check('…nor a role made for graduating students (its own rule)', stretchYears({ company: 'Formlabs', title: 'Manufacturing Engineer - May 2027 Graduates', text: two }), false);
  check('…nor a non-robotics employer', stretchYears({ company: 'Acme Valves', title: 'Mechanical Engineer', text: two }), false);
  check('Tesla stays capped: not on the robotics list', stretchEmployer('Tesla'), false);
  // Review 2026-11-06.
  check('"Figure Lending" is not Figure AI', stretchEmployer('Figure Lending'), false);
  check('"Agility Logistics" is not Agility Robotics', stretchEmployer('Agility Logistics'), false);
  check('"1X Technologies" and "Divergent Technologies, Inc." are', stretchEmployer('1X Technologies') && stretchEmployer('Divergent Technologies, Inc.'), true);
  check('a Field Engineer at Intuitive is no stretch', stretchYears({ company: 'Intuitive Surgical', title: 'Field Engineer', text: two }), false);
  check('…and is still cut before reading', !!prescreen({ title: 'Field Engineer', text: two, company: 'Intuitive Surgical' }), true);
  check('"0-1 years of experience" is a true fit, not a stretch', stretchYears({ company: 'Dexterity', title: 'Mechanical Engineer', text: 'Requirements\n• 0-1 years of experience' }), false);
  check('"within 1 year you will…" asks for nothing', stretchYears({ company: 'Dexterity', title: 'Mechanical Engineer', text: 'Within 1 year you will own the experience of our test cell.' }), false);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
