import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillOne } from './opera-fill.mjs';

// A fake DevTools connection: records every command, answers like Opera.
function fakeCdp({ fill = 'FILLED: subject set, 160 words in the box; upload the resume to "Jarvis resume bridge"', url = 'https://www.linkedin.com/messaging/thread/new/?x' } = {}) {
  const sent = [];
  const send = async (method, params = {}) => {
    sent.push({ method, params });
    if (method === 'Target.createTarget') return { targetId: 'T1' };
    if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'T1', url }] };
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
      if (/^document\.querySelector\('input\[aria-label/.test(params.expression)) return { result: { objectId: 'BRIDGE' } };
      if (/FILLED: subject set/.test(params.expression) && /ClipboardEvent/.test(params.expression)) return { result: { value: fill } };
      if (/ATTACHED: /.test(params.expression)) return { result: { value: 'ATTACHED: Alex Rivera Resume - Amazon - X.pdf' } };
    }
    return {};
  };
  return { send, sent };
}
const P = { name: 'Dana Lee', profile: 'https://www.linkedin.com/in/dana', message: 'Hi Dana', subject: 'S', resume: 'C:/r/a.pdf', as: 'Alex Rivera Resume - Amazon - X.pdf' };

test('one person: a background tab, the fill, the resume onto the temporary field, the attach', async () => {
  const cdp = fakeCdp();
  const lines = [];
  const out = await fillOne(cdp, P, (l) => lines.push(l));
  assert.match(out, /ATTACHED: Alex Rivera Resume - Amazon - X\.pdf/);
  const create = cdp.sent.find((s) => s.method === 'Target.createTarget');
  assert.equal(create.params.background, true, 'his current tab is never taken over');
  const files = cdp.sent.find((s) => s.method === 'DOM.setFileInputFiles');
  assert.deepEqual(files.params, { files: ['C:/r/a.pdf'], objectId: 'BRIDGE' });
  assert.match(lines[0], /InMail \(uses a credit\)/);
});

test('a STOP from the fill ends that person there: no file, no attach', async () => {
  const cdp = fakeCdp({ fill: 'STOP: the message box already has text; left it alone' });
  const out = await fillOne(cdp, P, () => {});
  assert.match(out, /STOP: the message box already has text/);
  assert.ok(!cdp.sent.some((s) => s.method === 'DOM.setFileInputFiles'));
});

test('nothing it sends to the page can press Send', async () => {
  const cdp = fakeCdp({ url: 'https://www.linkedin.com/in/dana' });
  const lines = [];
  await fillOne(cdp, P, (l) => lines.push(l));
  const pageCode = cdp.sent.filter((s) => s.method === 'Runtime.evaluate').map((s) => s.params.expression).join('\n');
  assert.doesNotMatch(pageCode, /send-button|msg-form__send|\.submit\(|=== 'Send'|Input\.dispatchKeyEvent/i);
  assert.ok(!cdp.sent.some((s) => /^Input\./.test(s.method)), 'no synthetic keys or clicks from outside the page');
  assert.match(lines[0], /free message/);
});

// His setup items 3 and 4 (2026-10-05).
import { creditOf, readBack, READ_BACK, MESSAGE_HREF } from './opera-fill.mjs';
test('the read-back and the Message-link snippets compile', () => {
  assert.doesNotThrow(() => new Function(`return ${READ_BACK}`));
  assert.doesNotThrow(() => new Function(`return ${MESSAGE_HREF}`));
  assert.doesNotMatch(READ_BACK + MESSAGE_HREF, /\.click\(|dispatchEvent|ClipboardEvent/, 'reading only: nothing is pressed or typed');
});
test('credits: opens the profile, goes to the Message page, reads LinkedIn\'s own line, closes the tab', async () => {
  const sent = [];
  const cdp = { send: async (method, params = {}) => {
    sent.push({ method, params });
    if (method === 'Target.createTarget') return { targetId: 'T' };
    if (method === 'Target.attachToTarget') return { sessionId: 'S' };
    if (method === 'Runtime.evaluate' && /readyState/.test(params.expression)) return { result: { value: 'https://www.linkedin.com/messaging/compose/?profileUrn=X' } };
    if (method === 'Runtime.evaluate') return { result: { value: 'InMail: Use 1 of 3 InMail credits' } };
    return {};
  } };
  assert.equal(await creditOf(cdp, 'https://www.linkedin.com/in/kaiortiz'), 'InMail: Use 1 of 3 InMail credits');
  assert.equal(sent.find((s) => s.method === 'Page.navigate').params.url, 'https://www.linkedin.com/messaging/compose/?profileUrn=X');
  assert.ok(sent.some((s) => s.method === 'Target.closeTarget'), 'the tab is closed');
  assert.ok(!sent.some((s) => s.method === 'DOM.setFileInputFiles' || /ClipboardEvent/.test(s.params.expression || '')), 'nothing is filled');
});
test('read back says when a tab lost its message', async () => {
  const cdp = { send: async (method) => (method === 'Target.attachToTarget' ? { sessionId: 'S' } : method === 'Runtime.evaluate' ? { result: { value: 'EMPTY: the message box is blank' } } : {}) };
  const [line] = await readBack(cdp, [{ targetId: 'T', name: 'Riley' }]);
  assert.match(line, /^Riley: EMPTY/);
});

import { draftMarks, sentState, sessionRows, waitForSend, FRESH_DAYS } from './opera-fill.mjs';

const DRAFT = `Hi Sam,

I saw your post asking engineers to share their projects with you, so I wanted to send mine.

I recently applied for the Manufacturing Engineer role in Austin:
https://jobs.ashbyhq.com/fab2/71ad6a06

I'm a senior Mechanical Engineering student at Lakeside graduating in May 2027.

Portfolio: https://alexrivera.example
Resume attached.`;

test('draft marks are long prose lines, never links or the sign-off lines', () => {
  const m = draftMarks(DRAFT);
  assert.ok(m.length >= 2 && m.length <= 3);
  for (const x of m) {
    assert.ok(x.length >= 40 && x.length <= 60, x);
    assert.doesNotMatch(x, /https?:|^Portfolio|^Resume/);
  }
});

test('send states: waiting, sent, already sent, unclear', () => {
  assert.equal(sentState({ inBox: true, onPage: 0 }), 'waiting');
  assert.equal(sentState({ inBox: false, onPage: 2 }), 'sent');
  assert.equal(sentState({ inBox: true, onPage: 1 }), 'already');
  assert.equal(sentState({ inBox: false, onPage: 0 }), 'cleared');
});

test('a session takes recent drafts only, unless he names the person', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const rows = [
    { name: 'New', created_at: '2026-10-20T00:00:00Z' },
    { name: 'Old', created_at: '2026-09-15T00:00:00Z' },
  ];
  const s = sessionRows(rows, [], now);
  assert.deepEqual(s.rows.map((r) => r.name), ['New']);
  assert.deepEqual(s.stale.map((r) => r.name), ['Old']);
  assert.equal(sessionRows(rows, ['old'], now).rows.length, 2);
  assert.ok(FRESH_DAYS >= 14);
});

function sendCdp(states, { closeAfter = Infinity } = {}) {
  let i = 0;
  return {
    send: async (method) => {
      if (method === 'Target.getTargets') return { targetInfos: i >= closeAfter ? [] : [{ targetId: 'T' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'S' };
      if (method === 'Runtime.evaluate') return { result: { value: states[Math.min(i++, states.length - 1)] } };
      return {};
    },
  };
}

test('a send is seen once the box empties and the text is in the thread', async () => {
  const cdp = sendCdp([{ inBox: true, onPage: 0 }, { inBox: true, onPage: 0 }, { inBox: false, onPage: 3 }]);
  assert.equal(await waitForSend(cdp, 'T', ['x'], { everyMs: 1 }), 'sent');
});

test('a closed tab is a skip, never a send', async () => {
  const cdp = sendCdp([{ inBox: true, onPage: 0 }], { closeAfter: 2 });
  assert.equal(await waitForSend(cdp, 'T', ['x'], { everyMs: 1 }), 'closed');
});

test('an emptied box with no message in the thread is not marked sent', async () => {
  const cdp = sendCdp([{ inBox: false, onPage: 0 }]);
  assert.equal(await waitForSend(cdp, 'T', ['x'], { everyMs: 1 }), 'cleared');
});

test('no answer within the limit is a timeout, not a send', async () => {
  const cdp = sendCdp([{ inBox: true, onPage: 0 }]);
  assert.equal(await waitForSend(cdp, 'T', ['x'], { everyMs: 1, timeoutMs: 30 }), 'timeout');
});
