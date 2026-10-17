// Tests for prescreen.mjs. Every line here is quoted from a real posting the
// reader judged (2026-10-07/08): the ones it turned down for years or field,
// and the KEEP / MAYBE ones the script must leave alone.

import { prescreen, yearsBar, disciplineBar, minYears } from './prescreen.mjs';

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

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
