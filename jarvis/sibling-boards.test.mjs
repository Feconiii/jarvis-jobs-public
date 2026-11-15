// jarvis/sibling-boards.test.mjs — an employer's second, early-career board.
// Run: node jarvis/sibling-boards.test.mjs
import { siblingCandidates, namesEmployer, trackedBoards, siblingEntry } from './sibling-boards.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};

console.log('🧪 sibling-boards: Astera Labs');
const c = siblingCandidates('asteralabs', 'Astera Labs', 2026);
eq('the name\'s first word + "earlycareer" + next year is tried (asteraearlycareer2027)', c.includes('asteraearlycareer2027'), true);
eq('…and the tracked token + "university"', c.includes('asteralabsuniversity'), true);
eq('the tracked token itself is not a candidate', c.includes('asteralabs'), false);
eq('a board that names the employer is its own', namesEmployer('Astera Labs Early Career - North America 2027', 'Astera Labs'), true);
eq('a look-alike token of another company is not', namesEmployer('Astera Health Careers', 'Astera Labs'), false);
eq('whole words, not substrings: "Arm" is not an "Armada" board', namesEmployer('Armada Early Careers', 'Arm'), false);
eq('…while "Arm University" is', namesEmployer('Arm University Programs', 'Arm'), true);
eq('an Ashby page titled for the employer passes', namesEmployer('Morse Micro Jobs', 'Morse Micro'), true);
eq('…but a title with more company words is another company', namesEmployer('Morse Micro Systems Jobs', 'Morse Micro'), false);
eq('legal suffixes do not have to appear', namesEmployer('Acme Robotics University Recruiting', 'Acme Robotics, Inc.'), true);
eq('tracked Greenhouse and Ashby boards are read from portals entries',
  trackedBoards([{ name: 'Astera Labs', careers_url: 'https://job-boards.greenhouse.io/asteralabs' }, { name: 'X', careers_url: 'https://jobs.ashbyhq.com/xco' }, { name: 'Off', careers_url: 'https://job-boards.greenhouse.io/off', enabled: false }]).map((b) => `${b.ats}/${b.token}`),
  ['greenhouse/asteralabs', 'ashby/xco']);
const e = siblingEntry({ company: 'Astera Labs', ats: 'greenhouse' }, { token: 'asteraearlycareer2027', boardName: 'Astera Labs Early Career - North America 2027', count: 93 });
eq('the entry files its rows under the employer', /\n {4}company: "Astera Labs"\n/.test(e), true);
eq('…with its own name, so it is not refused as a duplicate', /- name: "Astera Labs \(Early Career - North America 2027\)"/.test(e), true);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
