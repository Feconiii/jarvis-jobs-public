// Tests for the new-board audit. Every "suspect" case here is a board that
// really was tracked by mistake, with the titles it really carried.

import { judgeBoard } from './audit-new-boards.mjs';

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

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
