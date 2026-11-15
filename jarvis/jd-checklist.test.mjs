// jarvis/jd-checklist.test.mjs — the posting's requirement sentences, numbered, and the checklist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirementLines, proofTarget, proofOnPage, checklist, checklistLine, citedKeys } from './jd-checklist.mjs';

const FIGURE = `Figure is an AI robotics company developing autonomous general-purpose humanoid robots.

We are looking for a Systems Integration Engineer to lead the bring-up of our hardware.

Responsibilities:

• Coordinate across mechanical, electrical, firmware, and technician teams to plan first article builds.

• Build and oversee the execution of benchtop validation.

Requirements:

• Relevant experience integrating custom mechatronic systems for real products.

• Excellent communication and planning skills.

Bonus Qualifications:

• Prior leadership experience with robotic manipulators.

The US base salary range for this full-time position is $170,000 to $250,000 per year.

The pay offered for this position may vary based on several individual factors.

Figure is an equal opportunity employer and does not discriminate.`;

test('every duty, must-have and nice-to-have is numbered; pay, legal text and company intro are not', () => {
  const lines = requirementLines(FIGURE);
  assert.deepEqual(lines.map((l) => l.need), ['duty', 'duty', 'must', 'must', 'nice']);
  assert.deepEqual(lines.map((l) => l.id), ['R1', 'R2', 'R3', 'R4', 'R5']);
  assert.ok(lines[0].text.startsWith('Coordinate across mechanical'));
  assert.ok(!lines.some((l) => /salary|pay offered|equal opportunity|is an AI robotics company/i.test(l.text)));
});

test('"Responsibilities" is a heading (the word boundary that hid every Figure duty)', () => {
  const lines = requirementLines('Responsibilities:\n- Design and build test fixtures for the robot arm.\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].need, 'duty');
});

test('a numbered "Position requires" list (Micron) is read as must-haves, markdown escapes stripped', () => {
  const jd = 'Position requires:\n\n1\\. SPC (Statistical Process Control) principles for monitoring process performance;\n\n2\\. Diagnosing equipment issues and addressing root cause;';
  const lines = requirementLines(jd);
  assert.deepEqual(lines.map((l) => l.need), ['must', 'must']);
  assert.ok(lines[0].text.startsWith('SPC'));
});

test('safety rules, lifting, shifts and company values are not requirements he proves on a page', () => {
  const jd = `Qualifications:
- BS in Engineering or Science (new grad)
- Required to frequently lift/push/pull a minimum of 35 lbs
- Work schedule is 5 days, 40 hrs per week, first shift.
Ensure adherence to company's values (ICARE) in all aspects of your position:
- Collaboration – Innovate Through the Sharing of Ideas`;
  const lines = requirementLines(jd);
  assert.deepEqual(lines.map((l) => l.text), ['BS in Engineering or Science (new grad)']);
});

test('a "preferred" sentence under a requirements heading is a nice-to-have', () => {
  const lines = requirementLines('Requirements:\n- Experience in high-level scripting for test automation. Python is preferred.');
  assert.equal(lines[0].need, 'nice');
});

test('proof targets: bullet key, project, skill, course, none', () => {
  assert.deepEqual(proofTarget('acme.fixture'), { kind: 'bullet', key: 'acme.fixture' });
  assert.deepEqual(proofTarget('project: cnc-cardholder'), { kind: 'project', key: 'cnc-cardholder' });
  assert.deepEqual(proofTarget('skills: Python'), { kind: 'skills', key: 'Python' });
  assert.deepEqual(proofTarget('coursework: Heat Transfer'), { kind: 'coursework', key: 'Heat Transfer' });
  assert.deepEqual(proofTarget('none'), { kind: 'none', key: null });
});

test('the checklist says which proofs made the finished page', () => {
  const spec = {
    experience: [{ orgKey: 'acme', bullets: [{ provenanceKey: 'acme.fixture', text: 'x' }] }],
    projects: [{ key: 'arm', lead: '6-DOF Robotic Arm' }],
    skills: [{ key: 'automation', lead: 'Automation/Software', text: 'Python, C++' }],
    education: [{ bullets: [{ lead: 'Relevant Coursework', text: 'Heat Transfer, Machine Design' }] }],
  };
  const lines = [{ id: 'R1', need: 'duty', text: 'a' }, { id: 'R2', need: 'must', text: 'b' }, { id: 'R3', need: 'nice', text: 'c' }, { id: 'R4', need: 'must', text: 'd' }, { id: 'R5', need: 'duty', text: 'e' }];
  const cov = [
    { id: 'R1', proof: 'acme.fixture', strength: 'direct' }, { id: 'R2', proof: 'skills: Python', strength: 'partial' }, { id: 'R3', proof: 'project: piston-fea' },
    { id: 'R4', proof: 'coursework: Heat Transfer', strength: 'direct' },
  ];
  const list = checklist(lines, cov, spec);
  assert.deepEqual(list.map((x) => x.onPage), [true, true, false, true, false]);
  assert.equal(list[4].proof, 'unanswered');
  assert.deepEqual(list.map((x) => x.strength), ['direct', 'partial', 'none', 'direct', 'none']);
  assert.equal(checklistLine(list), 'proves 2 of 5 requirement lines in the posting directly and 1 partly (2 of 4 duties and must-haves directly)');
  assert.ok(proofOnPage(proofTarget('project: arm'), spec));
});

test('cited keys: bullets and projects behind duties and must-haves, not nice-to-haves', () => {
  const k = citedKeys([{ need: 'duty', proof: 'acme.fixture' }, { need: 'must', proof: 'project: cnc' }, { need: 'nice', proof: 'acme.docs' }]);
  assert.deepEqual([...k.bullets], ['acme.fixture']);
  assert.deepEqual([...k.projects], ['cnc']);
});
