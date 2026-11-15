// jarvis/rank-why.test.mjs — the "why this rank" line, from fit's own parts.
// Run: node jarvis/rank-why.test.mjs
import { rankWhy } from './rank-why.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const fit = { score: 100, breakdown: [
  { dimension: 'role', judged: true, points: 28, max: 28, why: ['Title is a primary target role (manufacturing engineer)'] },
  { dimension: 'skills', judged: true, points: 26, max: 26, why: ['Asks for 8 of his skills: autocad, catia, dfm'] },
  { dimension: 'seniority', judged: true, points: 15, max: 20, why: ['Asks ~2y experience — reachable with internships'] },
  { dimension: 'industry', judged: true, points: 5, max: 10, why: ['Industry not clearly one of his targets'] },
  { dimension: 'compensation', judged: false },
  { dimension: 'your rules', judged: true, points: 12, max: 0, adjustment: true, why: ['Matches what you want: manufacturing engineer', 'Matches what you want: fixture design', 'Matches what you want: DFM', 'Matches what you want: Austin'] },
] };
const line = rankWhy(fit);
console.log('🧪 rank-why');
eq('it names the score and the parts that carried it', line.startsWith('fit 100 — role 28/28 (a primary target role (manufacturing engineer))'), true);
eq('…what held it back', line.includes('held back by industry 5/10 (Industry not clearly one of his targets)'), true);
eq('…and his own lines that moved it', line.includes('your rules +12 (manufacturing engineer, fixture design, DFM)'), true);
eq('no fit, no line', rankWhy(null), null);
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
