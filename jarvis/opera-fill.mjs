/**
 * FILL LINKEDIN MESSAGES IN HIS OPERA GX, IN ONE COMMAND (2026-10-04).
 *
 *   node jarvis/opera-fill.mjs --name riley,ethan [--subject "Riley=…|Owen=…"]
 *
 * He presses Send; this never does (OUTREACH.md §2a as he amended it: fill on
 * his word, for named people, a handful at a time). He chose Opera because it
 * is the browser he keeps open: Chrome alongside it starved the machine (0.4 GB
 * free) and Chrome's renderer froze mid-fill, and its Memory Saver wiped filled
 * tabs. Opera does neither.
 *
 * Opera must be running with its debugging port (HE starts it:
 *   "$LOCALAPPDATA/Programs/Opera GX/opera.exe" --remote-debugging-port=9222
 * and restarts it normally afterwards to close the port). This speaks the
 * DevTools protocol over a plain WebSocket — no Playwright, whose reconnect
 * stalled on Opera (F-709) — and opens one background tab per person.
 *
 * The page work is linkedin-fill.mjs's: step 1 opens the compose box, checks
 * the recipient, sets the subject and pastes the message; the resume goes onto
 * the temporary field with DOM.setFileInputFiles; step 2 hands it to
 * LinkedIn's own field as "Alex Rivera Resume - <Company> - <Role>.pdf".
 * No browser-tool tokens: the whole run is this command's output.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardArgs } from './cli.mjs';
import { person } from './targeting.mjs';
import { fillScript, attachScript, fillableContacts, peopleFor, BRIDGE_LABEL } from './linkedin-fill.mjs';

const PORT = Number(process.env.OPERA_DEBUG_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One WebSocket to the browser; commands to a tab go through its session id. */
export async function connect(port = PORT) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
  if (!v?.webSocketDebuggerUrl) throw new Error(`Opera is not listening on port ${port}. He starts it with --remote-debugging-port=${port} (Opera fully closed first).`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not open the DevTools socket')); });
  let next = 1;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (method, params = {}, sessionId, timeoutMs = 60000) => new Promise((res, rej) => {
    const id = next++;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (waiting.delete(id)) rej(new Error(`${method} timed out`)); }, timeoutMs);
  });
  return { send, browser: v.Browser, close: () => ws.close() };
}

/** Run one of linkedin-fill's steps ("await (async (P) => …)(…)") in the tab; its return value. */
async function run(cdp, sessionId, script) {
  const r = await cdp.send('Runtime.evaluate', { expression: script.replace(/^await /, ''), awaitPromise: true, returnByValue: true }, sessionId, 90000);
  if (r.exceptionDetails) return `ERROR: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`.slice(0, 300);
  return r.result?.value;
}

export async function fillOne(cdp, p, log = console.log, opened = []) {
  const { targetId } = await cdp.send('Target.createTarget', { url: p.profile, background: true });
  opened.push({ targetId, name: p.name });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  // A background tab is not focused: LinkedIn's editor and the paste need a
  // focused page, and its timers would be throttled. This tab only, his
  // current tab stays where it is.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
  for (let i = 0; i < 40; i++) {
    const s = await cdp.send('Runtime.evaluate', { expression: 'document.readyState + location.pathname', returnByValue: true }, sessionId).catch(() => null);
    if (/^complete\/in\//.test(s?.result?.value || '')) break;
    await sleep(500);
  }
  // A fresh tab may have no script context yet, and pressing Message on an
  // InMail profile replaces the page: both are "run it again", not failures.
  let out = '';
  for (let tries = 0; tries < 5; tries++) {
    out = await run(cdp, sessionId, fillScript(p)).catch((e) => `CONTEXT: ${e.message}`);
    if (!/^(RETRY|CONTEXT)|execution context|context was destroyed/i.test(out)) break;
    await sleep(2000);
  }
  if (!/^FILLED/.test(out)) return `${p.name}: ${out}`;
  const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('input[aria-label="${BRIDGE_LABEL}"]')` }, sessionId);
  if (!result?.objectId) return `${p.name}: STOP: the temporary file field is gone`;
  await cdp.send('DOM.setFileInputFiles', { files: [p.resume], objectId: result.objectId }, sessionId);
  const attached = await run(cdp, sessionId, attachScript(p.as));
  const kind = await creditLine(cdp, sessionId) || await kindOf(cdp, targetId);
  await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  log(`${p.name}: ${out.replace(/; upload.*/, '')} · ${attached} · ${kind}`);
  return `${p.name}: ${attached}`;
}

/**
 * What LinkedIn itself says above the box: "Free message" (Open Profile) or
 * "Use 1 of N InMail credits". The compose page's address does not tell.
 */
async function creditLine(cdp, sessionId) {
  const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const D = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)]; const R = []; for (const d of D) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) R.push(s.textContent || ''); R.push(d.body?.innerText || ''); } const t = R.join(' '); const m = t.match(/Use \\d+ of \\d+ InMail credits?/i); return m ? 'InMail: ' + m[0] : /Free message/i.test(t) ? 'free message' : ''; })()` }, sessionId).catch(() => null);
  return r?.result?.value || '';
}

/**
 * FREE OR INMAIL, BEFORE A WORD IS WRITTEN (2026-10-05, his setup item 3: he
 * has few InMail credits). Opens the profile in a background tab, goes to the
 * page its Message link points to, reads LinkedIn's own line ("Free message"
 * or "Use 1 of N InMail credits"), closes the tab. Types nothing.
 */
export const MESSAGE_HREF = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = () => [...document.querySelectorAll('main a, main button')].find((e) => e.innerText.trim() === 'Message' && e.offsetParent);
  let link = find();
  for (let i = 0; i < 33 && !link; i++) { await sleep(300); link = find(); }
  if (!link) return 'NONE';
  const href = link.getAttribute('href') || '';
  return /\\/messaging\\//.test(href) ? new URL(href.replace(/([?&])interop=msgOverlay&?/, '$1').replace(/[?&]$/, ''), location.origin).href : 'BUTTON';
})()`;

export async function creditOf(cdp, profile) {
  const { targetId } = await cdp.send('Target.createTarget', { url: profile, background: true });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    let href = '';
    for (let i = 0; i < 20 && !href; i++) {
      await sleep(500);
      const r = await cdp.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `document.readyState === 'complete' && /^\\/in\\//.test(location.pathname) ? ${MESSAGE_HREF} : ''` }, sessionId).catch(() => null);
      href = r?.result?.value || '';
    }
    if (!href || href === 'NONE') return 'no Message button: not messageable without connecting first';
    if (href === 'BUTTON') return 'Message is a button, not a page: run the fill to see';
    await cdp.send('Page.navigate', { url: href }, sessionId);
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const line = await creditLine(cdp, sessionId);
      if (line) return line;
    }
    return 'no credit line shown (look at it before writing)';
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/**
 * WHAT IS IN EACH TAB AFTER A RUN (2026-10-05, his setup item 4): read back
 * from the page itself — who it is to, the subject, the message's length and
 * first line, the attachment, free or InMail — so "ready" is never a guess.
 */
/** The person's name as a regex fragment, for the attachment read-back ("Alex Rivera Resume - …pdf"). */
const NAME_RE = person.fullName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export const READ_BACK = `(() => {
  const D = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
  const R = []; for (const d of D) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) R.push(s); R.push(d); }
  const subj = R.map((r) => r.querySelector('input[name="subject"], input[placeholder^="Subject"]')).find(Boolean);
  if (!subj) return 'EMPTY: no compose box in this tab any more';
  let box = subj; for (let i = 0; i < 14 && box && !box.querySelector('div[contenteditable="true"]'); i++) box = box.parentElement;
  const body = box ? [...box.querySelectorAll('div[contenteditable="true"]')].pop().innerText.trim() : '';
  if (!body) return 'EMPTY: the message box is blank';
  const words = body.split(/\\s+/).filter(Boolean).length;
  // A shadow root has textContent; a document's is null, its body has the text.
  const root = subj.getRootNode();
  const pdf = (String(root.body ? root.body.innerText : root.textContent).match(/${NAME_RE} Resume[^\\n]*?\\.pdf/) || [''])[0];
  const att = subj.getRootNode().querySelectorAll('.msg-attachment-preview__remove-attachment').length;
  return body.split('\\n')[0] + ' | ' + subj.value + ' | ' + words + ' words | ' + (att === 1 ? pdf || '1 attachment' : att + ' attachments');
})()`;

export async function readBack(cdp, opened) {
  const lines = [];
  for (const { targetId, name } of opened) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }).catch(() => ({}));
    if (!sessionId) { lines.push(`${name}: TAB GONE`); continue; }
    const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: READ_BACK }, sessionId).catch(() => null);
    const credit = await creditLine(cdp, sessionId);
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    lines.push(`${name}: ${r?.result?.value || 'no answer'}${credit ? ` | ${credit}` : ''}`);
  }
  return lines;
}

/** A pop-up compose on the profile is a free message; the full page is an InMail (a credit). */
async function kindOf(cdp, targetId) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const t = targetInfos.find((x) => x.targetId === targetId);
  if (/\/messaging\/thread\/new/.test(t?.url || '')) return 'InMail (uses a credit)';
  if (/\/messaging\/compose/.test(t?.url || '')) return 'compose page (check the credit line above the box)';
  return 'free message (pop-up)';
}

async function main() {
  guardArgs({ usage: 'usage: node jarvis/opera-fill.mjs --name <a,b> [--subject <text> | "<first>=<subject>|…"]  |  --credits <profile url,…>', flags: ['--name', '--subject', '--credits'], valued: ['--name', '--subject', '--credits'] });
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  if (args.includes('--credits')) {
    const urls = opt('--credits').split(',').map((s) => s.trim()).filter((u) => /linkedin\.com\/in\//.test(u));
    if (!urls.length) { console.log('usage: --credits <linkedin.com/in/… profile url,…>'); process.exitCode = 1; return; }
    const cdp = await connect().catch((e) => { console.log(e.message); process.exitCode = 1; return null; });
    if (!cdp) return;
    for (const u of urls) console.log(`${u.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '')}: ${await creditOf(cdp, u).catch((e) => `ERROR ${e.message}`)}`);
    cdp.close();
    return;
  }
  const only = opt('--name').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (!only.length) { console.log('Name the people (--name a,b): this fills only on his word, for named people.'); process.exitCode = 1; return; }
  const people = await peopleFor(fillableContacts(only), opt('--subject'));
  if (!people.length) { console.log('Nothing to fill: no written, unsent message for those names.'); return; }
  const cdp = await connect().catch((e) => { console.log(e.message); process.exitCode = 1; return null; });
  if (!cdp) return;
  console.log(`${cdp.browser} · ${people.length} to fill, one background tab each; nothing is sent`);
  // Opera's workspaces are not in the DevTools protocol: a new tab opens in
  // the workspace on screen. He keeps outreach in "Outreach" (2026-10-04 the
  // first run landed in Administrative), so a session asks him to switch first.
  console.log('Tabs open in the Opera workspace on screen (his: Outreach).');
  // Under memory pressure the browser discards background tabs, and a click
  // reloads a filled compose page empty (Benjamin, Riley: 0.5 GB free,
  // 2026-10-05). The Jarvis extension now pins compose tabs; say it anyway.
  const freeGb = os.freemem() / 2 ** 30;
  if (freeGb < 1.5) console.log(`Only ${freeGb.toFixed(1)} GB free: close Chrome and spare Opera tabs, and keep the Jarvis extension loaded in Opera (it stops these tabs being put to sleep).`);
  const opened = [];
  for (const p of people) {
    // fillOne prints a finished person itself; anything else is printed here.
    const out = await fillOne(cdp, p, console.log, opened).catch((e) => `${p.name}: ERROR ${e.message}`);
    if (!/ATTACHED: /.test(out)) console.log(out);
  }
  // Read back what each tab actually holds, after a pause for LinkedIn to settle.
  await sleep(3000);
  console.log(`\nREAD BACK (from the pages):\n${(await readBack(cdp, opened)).map((l) => `  ${l}`).join('\n')}`);
  cdp.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
