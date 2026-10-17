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
