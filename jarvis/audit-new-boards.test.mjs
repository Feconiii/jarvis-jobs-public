// Tests for the new-board audit. Every "suspect" case here is a board that
// really was tracked by mistake, with the titles it really carried.

import { judgeBoard, isFieldTitle, isBambooPlaceholderRow } from './audit-new-boards.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const verdict = (titles) => judgeBoard(titles).verdict;

console.log('\n🧪 audit-new-boards: the boards that were tracked by mistake');

// F-508: "Figure" was Figure Technologies, the lender.
check('the crypto lender tracked as Figure', verdict([
  'Director, Digital Assets FinOps', 'Director of Treasury & Financial Operations',
  'Director, Partnerships - Banks & Credit Unions', 'Director, Revenue Accounting',
  'Post Close Operations Associate', 'Senior Product Counsel, Crypto',
  'Senior Manager of SEC Reporting & Technical Accounting', 'Senior Marketing Manager, ABM',
  'Site Operations Manager', 'Team Manager', 'Credit Risk Manager', 'Associate Originations & Distribution',
]), 'suspect');

// F-509: Raydar, a recruiting agency with a live 186-posting Workable board.
check('the recruiting agency tracked as Raydar', verdict([
  '(Confidential) Director of Marketing', 'Account Executive', 'Account Executive - Education',
  'Account Executive - Entity Management & Corporate Compliance', 'Account Executive - Mid Market',
  'Mechanical Design Engineer', 'Senior Software Engineer', 'Controller',
]), 'suspect');

console.log('\n🧪 audit-new-boards: real employers are left alone');

check('Lab37, the Pittsburgh robotics company', verdict([
  'Electro/Mechanical Technician', 'Triage & Applications Specialist', 'Senior Electrical Engineer - PCB Designer',
  'Robotics Product Manager', 'Mechanical Design Engineer', 'Global Supply Chain Manager',
  'Controls Engineer', 'Field Service Technician',
]), 'ok');
check('a three-person company hiring an office manager is not judged', verdict(['Office Manager', 'Chief of Staff', 'Recruiting Coordinator']), 'ok');
check('a big mixed board with some engineering on it', verdict([
  ...Array(20).fill('Senior Accountant'), 'Production Supervisor, Integration', 'Controls Sensors Project Manager',
  'Data Center Mechanical Engineer', 'Electrical Engineer',
]), 'ok');
check('a robotics company with a sales team is not an agency', verdict([
  'Account Executive', 'Account Executive, Enterprise', 'Account Executive, Mid-Market', 'Customer Success Manager',
  'Robotics Software Engineer (Perception & Localization)', 'Forward Deployed Robotics Engineer', 'Senior Machine Learning Engineer',
  'Mechanical Engineer', 'Hardware Engineer',
]), 'ok');
check('a board nothing was captured from is unscanned, never suspect', verdict([]), 'unscanned');

check('the reason is stated in numbers', judgeBoard(['Account Executive', 'Account Executive', 'Account Executive', 'Mechanical Engineer', 'Buyer']).why, '3 of 5 titles read like an agency or a sales floor');

// 2026-10-02: a same-name SOFTWARE company passed every check above.
check('engineers but no hardware title: suspect', verdict(['Software Engineer (Rust) - Backend', 'Software Engineer, Infrastructure', 'Forward Deployed Engineer', 'Strategic Operations', 'Software Engineer (Rust)', 'Product Designer']), 'suspect');
check('a robotics board with a sales team is still ok', verdict(['Customer Success Manager', 'Robotics Software Engineer (Perception)', 'Forward Deployed Robotics Engineer', 'Account Executive', 'Senior Machine Learning Engineer', 'Mechanical Engineer']), 'ok');
check('a small board is not judged on it', verdict(['Software Engineer', 'Designer', 'Founding Engineer']), 'ok');

console.log('\n🧪 audit-new-boards: the 2026-10-01 boards the audit passed (F-635, F-637)');

// PDDN INC. (SmartRecruiters, 10 postings): staffing wording on every row.
check('PDDN INC.: "W2 Hiring" / "Genuine Candidates Only" titles are an agency', verdict([
  'Mechanical Design Engineer W2 Hiring', 'Remote W2 Hiring Java Developer', 'Manufacturing Engineer - W2 Hiring',
  'Data Analyst - Genuine Candidates Only', 'Electrical Engineer Immediate Hiring', 'Quality Engineer C2C',
  'Process Engineer W2 Hiring', 'Test Engineer - Remote W2 Hiring', 'Controls Engineer W2 Hiring', 'Project Engineer',
]), 'suspect');
check('…and says why', judgeBoard(['Mechanical Engineer W2 Hiring', 'Remote W2 Hiring', 'Genuine Candidates Only']).why.startsWith('3 of 3 titles carry staffing-agency wording'), true);
check('one stray "W2" on a big real board is not an agency', verdict([
  'Mechanical Engineer', 'Manufacturing Engineer', 'Test Technician', 'Electrical Engineer', 'Buyer',
  'Production Supervisor', 'W2 Payroll Specialist',
]), 'ok');

// TestingXperts (SmartRecruiters, 179): IT consulting.
check('TestingXperts: an IT-testing consultancy is no hardware employer', verdict([
  'Middleware Server Admin', 'Oracle P6 Primavera', 'Big Data Hadoop', 'Cloud Azure Testing',
  'Software Test Engineer', 'QA Automation Engineer', 'Production Support Engineer', 'Site Reliability Engineer',
  'Salesforce Systems Engineer', 'Selenium Test Engineer',
]), 'suspect');
check('an IT title sharing a field word does not count as the field', [
  isFieldTitle('Software Test Engineer'), isFieldTitle('Production Support Engineer'), isFieldTitle('Site Reliability Engineer'),
], [false, false, false]);
check('…but a hardware word outranks the software one', [
  isFieldTitle('Embedded Software Engineer'), isFieldTitle('Test Engineer'), isFieldTitle('Manufacturing Test Engineer'), isFieldTitle('Hardware Test Automation Engineer'),
], [true, true, true, true]);

// The YC seed run: small software-only boards under one-word names.
check('a small board of "Software Engineer" and "Product Engineer" is software-only', verdict(['Software Engineer', 'Product Engineer', 'Head of Growth']), 'suspect');
check('a hardware startup with one software hire is fine', verdict(['Software Engineer', 'Mechanical Engineer', 'Operations Lead']), 'ok');

// Deploy: a Belgrade web agency on deploy.bamboohr.com for a YC hardware name.
check('Deploy: a one-word name whose board is all abroad is suspect', judgeBoard([
  { title: 'Senior Frontend Developer', location: 'Belgrade, Serbia', bucket: 'non-us' },
  { title: 'Project Manager', location: 'Belgrade, Serbia', bucket: 'non-us' },
  { title: 'UI/UX Designer', location: 'Novi Sad, Serbia', bucket: 'non-us' },
], { name: 'Deploy' }).why, 'every posting is outside the US (Belgrade, Novi Sad) — a one-word name may have resolved to a namesake');
check('…a two-word name abroad is left to the other checks', judgeBoard([
  { title: 'Mechanical Engineer', location: 'Munich, Germany', bucket: 'non-us' },
  { title: 'Test Engineer', location: 'Munich, Germany', bucket: 'non-us' },
], { name: 'Isar Aerospace' }).verdict, 'ok');
check('…and a one-word name with a US posting is fine', judgeBoard([
  { title: 'Mechanical Engineer', location: 'Berlin, Germany', bucket: 'non-us' },
  { title: 'Test Engineer', location: 'Austin, TX', bucket: 'us' },
], { name: 'Zoox' }).verdict, 'ok');
// Swish: Orlando event sales on swish.breezy.hr.
check('Swish: a one-word name with three postings and no engineer', judgeBoard(['Event Sales Representative', 'Inside Sales Associate', 'Event Coordinator'], { name: 'Swish' }).verdict, 'suspect');
check('…the same three under a full name stay unjudged', judgeBoard(['Event Sales Representative', 'Inside Sales Associate', 'Event Coordinator'], { name: 'Swish Event Partners' }).verdict, 'ok');

// F-637: BambooHR's placeholder board, as the store holds it.
check('a tracked BambooHR board serving the placeholder is suspect', judgeBoard([
  { title: 'IT Security Engineer', location: 'Mayfair, London, City of', url: 'https://xylem.bamboohr.com/careers/15' },
  { title: 'Software Engineer', location: 'Berlin', url: 'https://xylem.bamboohr.com/careers/20' },
  { title: 'Sales Development Representative', location: '', url: 'https://xylem.bamboohr.com/careers/21' },
  { title: 'Marketing Manager', location: 'Marseille', url: 'https://xylem.bamboohr.com/careers/22' },
], { name: 'Xylem' }).why.startsWith('BambooHR\'s placeholder demo board'), true);
check('a real #15 elsewhere is not the placeholder',
  isBambooPlaceholderRow({ title: 'IT Security Engineer', location: 'Denver, Colorado', url: 'https://acme.bamboohr.com/careers/15' }), false);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
