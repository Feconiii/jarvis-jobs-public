import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillScript, attachScript, attachName, bridgeScript, defaultSubject, BRIDGE_LABEL } from './linkedin-fill.mjs';

const AsyncFunction = (async () => {}).constructor;
const embedded = (script) => JSON.parse(script.slice(script.lastIndexOf('})(') + 3, -1));

test('both snippets compile as the extension runs them', () => {
  assert.doesNotThrow(() => new AsyncFunction(fillScript({ name: 'Dana Lee', subject: 'S', message: 'M' })));
  assert.doesNotThrow(() => new AsyncFunction(attachScript()));
});

test('the message arrives exactly as written, quotes, backticks, ${} and line breaks included', () => {
  const message = 'Hi Dana,\n\nI\'m "applying" — `x` ${y} \\ </script>\n\nThank you!\nAlex';
  const s = fillScript({ name: 'Dana Lee', subject: 'Amazon Robotics Tech Deployment Application', message });
  assert.equal(embedded(s).message, message);
  assert.equal(embedded(s).first, 'Dana');
  assert.doesNotThrow(() => new AsyncFunction(s));
});

test('it pastes, never types: no key events, and it never clicks Send', () => {
  const s = fillScript({ name: 'Dana Lee', subject: 'S', message: 'M' }) + attachScript();
  assert.match(s, /ClipboardEvent\('paste'/);
  assert.doesNotMatch(s, /KeyboardEvent|keydown|keypress/i);
  assert.doesNotMatch(s, /send-button|msg-form__send|\.submit\(|innerText\.trim\(\) === 'Send'/i);
});

test('a box that already holds his writing is left alone', () => {
  assert.match(fillScript({ name: 'Dana Lee', subject: 'S', message: 'M' }), /already has text; left it alone/);
});

test('the temporary field and the upload step agree on its label', () => {
  assert.ok(fillScript({ name: 'A B', subject: 'S', message: 'M' }).includes(BRIDGE_LABEL));
  assert.ok(attachScript().includes(BRIDGE_LABEL));
});

test('the subject reads like his: company, role, Application', () => {
  assert.equal(defaultSubject({ company: 'Amazon', title: 'Robotics Systems Engineer I, Tech Deployment' }), 'Amazon Robotics Systems Engineer I, Tech Deployment Application');
  assert.equal(defaultSubject({ company: 'AWS', title: 'Cloud Hardware Development Engineer (2026)' }), 'AWS Cloud Hardware Development Engineer Application');
});


// The first version stored the code in localStorage and ran it with
// `new Function`; LinkedIn's profile page forbids that (no 'unsafe-eval' in its
// CSP, 2026-10-04). Each step now carries all of its code.
test('each step is complete in itself: no stored code, no eval', () => {
  const s = fillScript({ name: 'Dana Lee', subject: 'S', message: 'M' }) + attachScript();
  assert.doesNotMatch(s, /localStorage|new Function|\beval\(/);
});

// The recipient sees the attachment's file name. His call (2026-10-04):
// "Alex Rivera Resume - <Company> - <Role>.pdf" — polished, and he can tell them
// apart — with the resume family (automation, mechanical) dropped.
test('the resume reaches LinkedIn named for the company and role, replacing any earlier one', async () => {
  class FakeFile { constructor(parts, name, o) { this.name = name; this.type = o?.type; } }
  class FakeDT { constructor() { const list = []; this.items = { add: (f) => list.push(f) }; this.files = list; } }
  const W = { DataTransfer: FakeDT, File: FakeFile, Event: class { constructor(t) { this.type = t; } } };
  let handed = null;
  const target = { accept: '.pdf,.doc', ownerDocument: { defaultView: W, body: { innerText: '' } }, closest: () => null,
    set files(v) { handed = v; target.ownerDocument.body.innerText = `Attached ${v[0].name}`; }, get files() { return handed; }, dispatchEvent() {} };
  let removed = 0;
  const shadow = { querySelectorAll: (q) => (q.includes('remove-attachment') ? [{ click: () => { removed++; } }] : [target]) };
  const subj = { ownerDocument: target.ownerDocument, getRootNode: () => shadow };
  const bridge = { files: [{ name: 'Alex Rivera Resume - automation - Amazon - Robotics Systems Engineer I, Tech Deployment.pdf', type: 'application/pdf' }], remove() {} };
  globalThis.document = {
    querySelector: (q) => (q.includes(BRIDGE_LABEL) ? bridge : q === '#interop-outlet' ? { shadowRoot: { querySelector: () => subj } } : null),
    querySelectorAll: () => [],
  };
  try {
    const as = attachName({ company: 'Amazon', title: 'Robotics Systems Engineer I, Tech Deployment' });
    assert.equal(as, 'Alex Rivera Resume - Amazon - Robotics Systems Engineer I, Tech Deployment.pdf');
    const out = await new AsyncFunction(`return ${attachScript(as).replace(/^await /, '')}`)();
    assert.equal(handed[0].name, as);
    assert.equal(removed, 1, 'the earlier attachment is removed first');
    assert.match(out, /^ATTACHED: Alex Rivera Resume - Amazon - Robotics/);
  } finally { delete globalThis.document; }
});

test('the name is built from the job, never cut mid-title, and safe for a file', () => {
  assert.equal(attachName({ company: 'Amazon', title: 'Cloud Hardware Development Engineer, AWS - Early Career (2026)' }), 'Alex Rivera Resume - Amazon - Cloud Hardware Development Engineer, AWS - Early Career (2026).pdf');
  assert.equal(attachName({ company: 'A/B', title: 'Eng: "II"' }), 'Alex Rivera Resume - A B - Eng II.pdf');
  assert.doesNotThrow(() => new AsyncFunction(bridgeScript()));
});

// His plan "no. 2" (2026-10-04): the whole run in two browser batches, with
// the code trimmed — every byte is typed out in a tool call, per message.
test('the trimmed steps still compile and run the same checks, and are smaller', async () => {
  const { compact, FILL_BODY, ATTACH_BODY } = await import('./linkedin-fill.mjs');
  const f = fillScript({ name: 'Dana Lee', subject: 'S', message: 'M' });
  assert.doesNotThrow(() => new AsyncFunction(f));
  assert.doesNotThrow(() => new AsyncFunction(attachScript('x.pdf')));
  assert.ok(compact(FILL_BODY).length < FILL_BODY.length * 0.9, `${compact(FILL_BODY).length} of ${FILL_BODY.length}`);
  assert.doesNotMatch(compact(FILL_BODY + ATTACH_BODY), /^\s*\/\//m);
  assert.match(f, /already has text; left it alone/);
});

test('one plan for everyone: open, fill, find; then upload, attach', async () => {
  const { batchPlan, subjectFor } = await import('./linkedin-fill.mjs');
  const people = [
    { name: 'Dana Lee', profile: 'https://www.linkedin.com/in/dana', message: 'Hi Dana', resume: 'C:/r/a.pdf', as: 'Alex Rivera Resume - A - B.pdf', subject: 'S1' },
    { name: 'Sam Roe', profile: 'https://www.linkedin.com/in/sam', message: 'Hi Sam', resume: 'C:/r/b.pdf', as: 'Alex Rivera Resume - C - D.pdf', subject: 'S2' },
  ];
  // Pipelined, one profile load per call (five in one call timed out, 2026-10-04).
  const calls = batchPlan(people);
  const shape = calls.map((c) => c.map((a) => `${a.name}:${a.input.tabId}`).join(' '));
  assert.deepEqual(shape, [
    'navigate:TAB1 javascript_tool:TAB1 find:TAB1',
    'file_upload:TAB1 javascript_tool:TAB1 navigate:TAB2 javascript_tool:TAB2 find:TAB2',
    'file_upload:TAB2 javascript_tool:TAB2',
  ]);
  assert.equal(calls[2][0].input.ref, 'REF2');
  assert.ok(calls[2][1].input.text.includes('Alex Rivera Resume - C - D.pdf'));
  assert.ok(calls[1][3].input.text.includes('"Hi Sam"'));
  assert.equal(calls.flat().filter((a) => a.name === 'navigate').length, 2);
  assert.equal(subjectFor('Dana=Amazon Tech Deployment Application|Sam=Other', 'Sam Roe', 'fallback'), 'Other');
  assert.equal(subjectFor('One for all', 'Sam Roe', 'fallback'), 'One for all');
  assert.equal(subjectFor('', 'Sam Roe', 'fallback'), 'fallback');
});
