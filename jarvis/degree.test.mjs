// Tests for the degree check — discipline AND level.
//
// The module exists because of one skip reason he wrote:
//   "it needs electrical engineering degree i am mechanical bruh
//    its instant rejection genuinely"
//
// A false mismatch hides a job he could have got, so the asymmetry runs one
// way: when in doubt, NOT a mismatch. The exception is the open-list rule,
// which was too generous in exactly one direction and cost 1,230 postings —
// see the section on that below.

import { checkDegree } from './degree.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const mism = (t) => checkDegree(t).mismatch;

console.log('\n🧪 degree: a closed list that excludes him');

check('the Micron req he actually skipped',
  mism('A completed BS or MS in Electrical Engineering and 0-2 years of full-time professional experience in semiconductor manufacturing'), true);
check('EE or CE only', mism('BS in Electrical Engineering or Computer Engineering required.'), true);
check('electrical only', mism("Bachelor's or Master's degree in Electrical Engineering"), true);
check('chemical only', mism('We want a BS in Chemical Engineering.'), true);
check('nursing', mism('Requires a degree in Nursing.'), true);
check('computer science only', mism('Bachelor of Science in Computer Science.'), true);

console.log('\n🧪 degree: his own disciplines are a match');

check('mechanical', mism('Bachelor of Science in Mechanical Engineering.'), false);
check('listed among alternatives', mism('BS in Mechanical, Electrical, or Industrial Engineering.'), false);
check('manufacturing', mism('Degree in Manufacturing Engineering.'), false);
check('aerospace', mism('BS in Aerospace Engineering.'), false);
check('mechatronics', mism('Bachelor degree in Mechatronics.'), false);
check('materials, at a level he has', mism('BS in Materials Science or Metallurgy.'), false);

console.log('\n🧪 degree: an open list only reaches him if it names something near him');

// The rule that cost 1,230 postings. Every ASIC/SoC/RFIC req says some version
// of "Computer Science, Electrical Engineering, Computer Engineering or
// related discipline". Treating any "or related" as unrestricted let all of
// them into the deck — but "related" means related TO WHAT WAS NAMED, and a
// mechanical engineer is not a discipline related to ASIC design.
check('EE + "or a related field" still excludes him',
  mism("Bachelor's degree in Electrical Engineering or a related field."), true);
check('CS + "closely related discipline" still excludes him',
  mism('Degree in Computer Science or a closely related discipline'), true);
check('EE/CE + "or similar field" still excludes him',
  mism('Bachelor degree in Electrical Engineering, Computer Engineering, or similar field'), true);
check('EE + "foreign equivalent" still excludes him',
  mism('BS in Electrical Engineering or foreign equivalent'), true);

// But an ADJACENT discipline plus an escape hatch genuinely does reach him. A
// fab process role asking for Chemical Engineering "or a related field" hires
// mechanical engineers, which is why this cannot just block every open list.
// GlobalFoundries puts the hatch after a comma, not after "or".
check('ChemE + "a related field" after a comma reaches him',
  mism('BS in Chemical Engineering, a related field, or a foreign equivalent'), false);
check('ChemE + "or equivalent experience" reaches him',
  mism('BS in Chemical Engineering or equivalent experience'), false);

// A generic container with an example is not a requirement list at all.
check('"a technical discipline such as EE" is an example, not a limit',
  mism('A degree in a technical discipline such as Electrical Engineering'), false);

console.log('\n🧪 degree: the level has to be reachable too');

// He is a BS graduating May 2027. Applied Materials publishes the level right
// in the title, and nothing was reading it — 74 Masters/PhD reqs sat in the
// deck, several of them scoring above 90.
check('Doctorate in the title',
  checkDegree('', 'Mechanical Engineer New College Grad Doctorate Degree').mismatch, true);
check('PhD in the title',
  checkDegree('', 'Mechanical Engineer Phd Early In Career').mismatch, true);
check('Masters in the title',
  checkDegree('', 'Mechanical Engineer New College Grad Masters Degree').mismatch, true);
check('Bachelor in the title is fine',
  checkDegree('', 'Mechanical Engineer New College Grad Bachelor Degree').mismatch, false);
check('a plain title is fine',
  checkDegree('', 'Manufacturing Engineer').mismatch, false);
check('the reason distinguishes level from discipline',
  checkDegree('', 'Mechanical Engineer Phd Early In Career').reason, 'level');

// "Master" is also a noun. These are trades and planning titles, not degrees.
check('Master Production Control Planner is not a degree level',
  checkDegree('', 'Master Production Control Planner').mismatch, false);
check('Master Scheduler is not a degree level',
  checkDegree('', 'Master Scheduler').mismatch, false);

// The level check has to survive a discipline match: right subject, wrong
// level is still unreachable.
check('a PhD in one of HIS subjects is still out of reach',
  mism('PhD in Robotics required for this role'), true);
check('a Masters-only req in his own subject is out',
  mism("Master's in Materials Science or Metallurgy."), true);
check('"BS or MS" offers a route he has',
  mism('BS or MS in Mechanical Engineering'), false);

console.log('\n🧪 degree: naming no discipline excludes nobody');

check('plain "Engineering"', mism("Bachelor's degree in Engineering."), false);
check('"a technical degree"', mism('A technical degree is required.'), false);
check('no degree language at all', mism('No degree info here, just responsibilities and benefits.'), false);
check('empty', mism(''), false);
check('null does not throw', mism(null), false);
check('empty title does not throw', checkDegree('', '').mismatch, false);

console.log('\n🧪 degree: any satisfiable route wins');

// Multi-track reqs list one degree per track. One track he can take makes the
// posting winnable, wherever it appears in the text.
check('a second sentence rescues it',
  mism('BS in Electrical Engineering. Alternatively, a BS in Mechanical Engineering is acceptable.'), false);
check('…in either order',
  mism('BS in Mechanical Engineering. We also consider a BS in Electrical Engineering.'), false);

console.log('\n🧪 degree: the quote is the deciding sentence');

const q = checkDegree('You will own the process. * A completed BS or MS in Electrical Engineering and 0-2 years of experience * Strong communication skills');
check('a mismatch carries a quote', typeof q.quote === 'string' && q.quote.length > 0, true);
check('the quote names the discipline', /Electrical Engineering/.test(q.quote), true);
check('the quote is not the neighbouring bullet', /communication skills/.test(q.quote), false);
check('the wanted discipline is reported', /electrical/i.test(q.wanted.join(' ')), true);
check('a match carries no quote', checkDegree('BS in Mechanical Engineering.').quote, null);
check('a level mismatch quotes the title',
  checkDegree('', 'Mechanical Engineer Phd Early In Career').quote, 'Mechanical Engineer Phd Early In Career');

console.log('\n🧪 degree: a preference is not a requirement (F-507)');

// The Agility Robotics Mechanical Engineer req, Fremont, 0-3 years, fit 100.
// He found it on LinkedIn and not in his deck. Its stated minimum is a BS in
// his own discipline; "Advanced degree" sits under a Preferred heading.
const AGILITY = [
  'About you:',
  '• 0 - 3 years of mechanical design experience.',
  '• B.S. or M.S. in Mechanical Engineering or equivalent is a minimum requirement.',
  '• Expert CAD user and familiarity with either Solidworks, Siemens NX, Creo or Onshape.',
  'Preferred Skills and Experience:',
  '• Robotic design experience',
  '• Advanced degree in engineering or science or robotics',
  '• Jira/Confluence experience',
].join('\n\n');
check('the Agility req he found on LinkedIn', mism(AGILITY), false);

check('dotted B.S. is read as a bachelor route',
  mism('B.S. in Mechanical Engineering is a minimum requirement.'), false);
check('dotted B.S. in a far discipline still mismatches',
  mism('B.S. in Electrical Engineering is a minimum requirement.'), true);
check('dotted M.S. alone is still graduate-only',
  mism('M.S. in Mechanical Engineering is a minimum requirement.'), true);

check('an advanced degree under a Preferred heading',
  mism('Requirements:\n• 2 years of CAD experience\n\nPreferred Qualifications:\n• Advanced degree in engineering or robotics'), false);
check('…under Nice to have',
  mism('What you bring:\n• Strong CAD skills\n\nNice to have:\n• Master\'s degree in Mechanical Engineering'), false);
check('…under Bonus points',
  mism('Bonus points if you have:\n• PhD in Robotics'), false);
check('…said inline on the bullet itself',
  mism('Master\'s degree in Mechanical Engineering preferred.'), false);
check('…"is a plus"',
  mism('A PhD in Robotics is a plus.'), false);
check('a REQUIRED heading after a preferred one resets it',
  mism('Nice to have:\n• Jira experience\n\nMinimum Qualifications:\n• Master\'s degree in Mechanical Engineering'), true);
check('a required graduate degree still blocks',
  mism('Requirements:\n• Master\'s degree in Mechanical Engineering'), true);
// A level block stands only when no bachelor's route exists anywhere.
check('Micron: "B.S. with 3+ years will also be considered"',
  mism('Minimum Qualifications:\n* M.S. or Ph.D. in Electrical Engineering, Materials Science, Physics, Mechanical Engineering, or a related field\n* B.S. with 3+ years of semiconductor processing experience will also be considered'), false);
check('KLA: a bachelor-level route stated separately',
  mism("Qualifications: Master’s or Ph.D. degree in Mechanical Engineering, Physics, or a related field\nMinimum Qualifications\nMaster's Level Degree and 0 years related work experience; Bachelor's Level Degree and related work experience of 2 years"), false);
check('Intel: "Bachelor’s … OR a master’s or Ph.D."',
  mism('Minimum Qualifications:\n• Bachelor’s degree in Mechanical Engineering with 3+ years of experience;\nOR a master’s or Ph.D. degree in a related field'), false);
check('"B.Sc.or M.Sc." run together', mism('- B.Sc.or M.Sc. in Mechanical Engineering, Chemical Engineering, or Applied Physics'), false);
check('"B.S degree (or above), in mechanical engineering"',
  mism('3 years of experience or Masters Degree\nB.S degree (or above), in mechanical engineering, or relevant equivalent experience.'), false);
check('a PhD-only req with no bachelor anywhere still blocks',
  mism('Minimum Qualifications: Ph.D. in Robotics or Mechanical Engineering. Publications at top venues.'), true);
check('a preferred FAR discipline does not block either',
  mism('Requirements:\n• 2 years of test experience\n\nPreferred:\n• Degree in Electrical Engineering'), false);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
