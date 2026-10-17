/**
 * FILL A LINKEDIN MESSAGE, LEANLY (2026-10-04, OUTREACH.md §2a as amended).
 *
 * He presses Send; this never does. For each saved contact whose message is
 * written and not yet sent, it prepares what a Claude in Chrome session runs
 * on that person's profile, so a fill is two tool calls and one small
 * screenshot instead of a dozen rounds of looking.
 *
 *   step 1, on the profile: opens its Message link, waits for the compose
 *     form, checks it is addressed to this person, sets the subject, PASTES
 *     the message (a typed newline can send it), adds a one-pixel file field.
 *   (between: `find` that field, `file_upload` the resume to it)
 *   step 2: moves the resume into LinkedIn's own document field, removes the
 *     temporary field, renames it "Alex Rivera Resume.pdf", waits for "Attached".
 *
 * Why the temporary field: the compose form lives either in
 * `#interop-outlet`'s shadow root (an Open Profile's free message, a pop-up)
 * or in a same-origin "preload" iframe (an InMail, a full page). The
 * extension's find/upload tools see neither; a file set on a field they CAN
 * see is copied across with a DataTransfer from the form's own window.
 *
 *   node jarvis/linkedin-fill.mjs                 every drafted, unsent message
 *   node jarvis/linkedin-fill.mjs --name riley   one person
 *   node jarvis/linkedin-fill.mjs --subject "…"   override the subject line
 */
import path from 'node:path';
import { guardArgs } from './cli.mjs';
import { fileURLToPath } from 'node:url';
import { allContacts } from './contacts.mjs';
import { person } from './targeting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:4300';
export const BRIDGE_LABEL = 'Jarvis resume bridge';

// Every document (the page and its same-origin iframes) and every
// #interop-outlet shadow root under them: where the compose form can be.
const ROOTS = `
  const roots = () => {
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
    const out = [];
    for (const d of docs) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) out.push(s); out.push(d); }
    return out;
  };
  const subjOf = () => roots().map((r) => r.querySelector('input[name="subject"], input[placeholder^="Subject"]')).find(Boolean);
  const win = (el) => el.ownerDocument.defaultView;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`;

/** Body of the async function (P) => …, P = { name, first, subject, message, bridge }. */
export const FILL_BODY = `${ROOTS}
  if (!subjOf()) {
    // Three compose layouts: the pop-up on the profile, /messaging/thread/new
    // (InMail) and /messaging/compose (Opera, 2026-10-04).
    if (/\\/messaging\\/(thread\\/new|compose)/.test(location.pathname)) {
      for (let i = 0; i < 25 && !subjOf(); i++) await sleep(300);
    } else {
      // Waits for the profile to finish loading (up to ~10 s) instead of a fixed pause.
      const find = () => [...document.querySelectorAll('main a, main button')].find((e) => e.innerText.trim() === 'Message' && e.offsetParent);
      let link = find();
      for (let i = 0; i < 33 && !link; i++) { await sleep(300); link = find(); }
      if (!link) return 'STOP: no Message button on this profile (not messageable, or the page never loaded)';
      // The link is the full-page compose; LinkedIn turns the click into a
      // pop-up (interop=msgOverlay), and a pop-up's text was gone when he
      // opened the tab (Riley, Shreyash, 2026-10-05) while full pages kept
      // theirs. So go to the page itself; step 1 runs again there.
      const href = link.getAttribute('href') || '';
      if (/\\/messaging\\/compose/.test(href)) { location.href = href.replace(/([?&])interop=msgOverlay&?/, '$1').replace(/[?&]$/, ''); return 'RETRY: opening the full-page compose; run step 1 again'; }
      link.click();
      for (let i = 0; i < 40 && !subjOf(); i++) await sleep(300);
      if (!subjOf()) return 'RETRY: Message was pressed and LinkedIn is opening the compose page; run step 1 again';
    }
  }
  const subj = subjOf();
  if (!subj) return 'STOP: the compose form did not open';
  // The nearest container holding both the subject and the message box, then
  // the nearest one above it that names the recipient (the full page puts the
  // name in a header above the form). Never the whole page.
  const up = (el, ok) => { for (let e = el, i = 0; e && i < 14; e = e.parentElement, i++) { if (/^(BODY|HTML)$/.test(e.tagName)) return null; if (ok(e)) return e; } return null; };
  const box = up(subj, (e) => e.querySelector('div[contenteditable="true"]'));
  if (!box) return 'STOP: no message box beside the subject';
  if (!up(box, (e) => e.innerText.includes(P.name) || e.innerText.includes(P.first))) return 'STOP: the compose form is not addressed to ' + P.name;
  const body = [...box.querySelectorAll('div[contenteditable="true"]')].pop();
  if (body.innerText.trim()) return 'STOP: the message box already has text; left it alone';
  const W = win(subj);
  const set = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value').set;
  subj.focus(); set.call(subj, P.subject);
  for (const t of ['input', 'change']) subj.dispatchEvent(new W.Event(t, { bubbles: true, composed: true }));
  body.focus();
  const dt = new W.DataTransfer(); dt.setData('text/plain', P.message);
  body.dispatchEvent(new W.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
  await sleep(700);
  document.querySelectorAll('input[aria-label="' + P.bridge + '"]').forEach((e) => e.remove());
  const bridge = document.createElement('input');
  bridge.type = 'file'; bridge.setAttribute('aria-label', P.bridge);
  bridge.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:2147483647';
  document.body.appendChild(bridge);
  const words = body.innerText.trim().split(/\\s+/).length;
  return 'FILLED: subject set, ' + words + ' words in the box; upload the resume to "' + P.bridge + '"';`;

/** Body of the async function (P) => …, P = { bridge }. */
export const ATTACH_BODY = `${ROOTS}
  const bridge = document.querySelector('input[aria-label="' + P.bridge + '"]');
  if (!bridge) return 'STOP: the temporary field is missing';
  if (!bridge.files.length) return 'STOP: nothing was uploaded to the temporary field';
  const subj = subjOf();
  if (!subj) return 'STOP: the compose form is gone';
  const target = [...subj.getRootNode().querySelectorAll('input[type="file"]')].find((i) => i !== bridge && /\\.pdf/.test(i.accept));
  if (!target) return 'STOP: LinkedIn has no document field here';
  const W = win(target);
  // Replace, never stack: an earlier attachment in THIS form is removed first.
  for (const x of subj.getRootNode().querySelectorAll('.msg-attachment-preview__remove-attachment')) { x.click(); await sleep(300); }
  // The recipient sees the file's name: "Alex Rivera Resume - <Company> - <Role>.pdf"
  // (his call, 2026-10-04), never the build's name with its resume family in it.
  const dt = new W.DataTransfer(); for (const f of bridge.files) dt.items.add(new W.File([f], P.as || f.name, { type: f.type || 'application/pdf' }));
  const name = dt.files[0].name;
  target.files = dt.files;
  target.dispatchEvent(new W.Event('change', { bubbles: true, composed: true }));
  bridge.remove();
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const box = target.closest('.msg-overlay-conversation-bubble, main') || target.ownerDocument.body;
    if (/Attached/.test(box.innerText) && box.innerText.includes(name.slice(0, 20))) return 'ATTACHED: ' + name + '. Ready for him to press Send';
  }
  return 'CHECK: the file was handed over but "Attached" never showed; look at the window';`;

/**
 * The two steps, each complete in itself: nothing is stored in the browser,
 * so nothing goes stale and no page's CSP matters. (The first version stored
 * the code once and sent short calls; LinkedIn's profile page forbids the
 * `new Function` that needed, 2026-10-04. ~5 KB a step is cheap; a step that
 * fails on one page is not.)
 */
export function fillScript({ name, subject, message }) {
  return `await (async (P) => {${compact(FILL_BODY)}
})(${JSON.stringify({ name, first: String(name).split(/\s+/)[0], subject, message, bridge: BRIDGE_LABEL })})`;
}
export function attachScript(as = '') {
  return `await (async (P) => {${compact(ATTACH_BODY)}
})(${JSON.stringify({ bridge: BRIDGE_LABEL, as })})`;
}

/**
 * What the browser gets: no comment lines, no indentation. Every step is typed
 * out in a tool call, so each byte here is a token spent per message. Only
 * whole-line comments go: a `//` inside a line may be in a string or a regex.
 */
export function compact(body) {
  return body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
}

/**
 * Everything for one run as browser_batch calls (2026-10-04, his plan "no. 2"),
 * pipelined: call k attaches person k's resume, then opens and fills person
 * k+1 and finds their file field. n people = n+1 calls. One call for everyone
 * timed out (five profile loads exceed the batch's time limit), so each call
 * carries one profile load. "TAB<n>" and "REF<n>" are filled in from the tabs
 * used and from the previous call's `find`.
 */
export function batchPlan(people) {
  const open = (p, i) => [
    { name: 'navigate', input: { tabId: `TAB${i + 1}`, url: p.profile } },
    { name: 'javascript_tool', input: { tabId: `TAB${i + 1}`, action: 'javascript_exec', text: fillScript(p) } },
    { name: 'find', input: { tabId: `TAB${i + 1}`, query: `${BRIDGE_LABEL} file input` } },
  ];
  const attach = (p, i) => [
    { name: 'file_upload', input: { tabId: `TAB${i + 1}`, ref: `REF${i + 1}`, paths: [p.resume] } },
    { name: 'javascript_tool', input: { tabId: `TAB${i + 1}`, action: 'javascript_exec', text: attachScript(p.as) } },
  ];
  const calls = [];
  for (let k = 0; k <= people.length; k++) {
    calls.push([...(k > 0 ? attach(people[k - 1], k - 1) : []), ...(k < people.length ? open(people[k], k) : [])]);
  }
  return calls;
}

/** "--subject" is one subject for everyone, or "Riley=…|Owen=…" per first name. */
export function subjectFor(arg, name, fallback) {
  if (!arg) return fallback;
  if (!/=/.test(arg)) return arg;
  for (const pair of arg.split('|')) {
    const [who, ...rest] = pair.split('=');
    if (String(name).toLowerCase().includes(who.trim().toLowerCase())) return rest.join('=').trim();
  }
  return fallback;
}
/** Only the temporary file field, for swapping the resume on a message already filled. */
export function bridgeScript() {
  return `document.querySelectorAll('input[aria-label="${BRIDGE_LABEL}"]').forEach((e) => e.remove()); { const b = document.createElement('input'); b.type = 'file'; b.setAttribute('aria-label', '${BRIDGE_LABEL}'); b.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:2147483647'; document.body.appendChild(b); } 'BRIDGE: upload the resume to "${BRIDGE_LABEL}", then step2'`;
}

/**
 * The attachment's name, as the recipient sees it: "Alex Rivera Resume - Amazon -
 * Robotics Systems Engineer I, Tech Deployment.pdf". His call (2026-10-04): it
 * reads polished and tells him which is which; the resume family is dropped.
 * Built from the job, not the stored file, whose name can be cut mid-title.
 */
export function attachName(job) {
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = [`${person.fullName} Resume`, clean(job?.company), clean(job?.title)].filter(Boolean);
  return `${parts.join(' - ')}.pdf`;
}

/** The subject he used: "<Company> <role> Application". */
export function defaultSubject(job) {
  const title = String(job?.title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return `${job?.company || ''} ${title} Application`.replace(/\s+/g, ' ').trim();
}

async function resumeFor(jobId) {
  const r = await fetch(`${API}/api/outreach?id=${encodeURIComponent(jobId)}`).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json();
  const pick = j.job?.resume?.url || j.job?.resume?.choices?.[0]?.url;
  if (!pick) return { path: null, job: j.job };
  const u = new URL(pick, API);
  return { path: path.join(ROOT, 'output', 'jarvis-resumes', u.searchParams.get('dir') || '', path.basename(u.searchParams.get('file') || '')), job: j.job };
}

/** Saved, written, unsent messages with a profile, optionally only these first names. */
export function fillableContacts(only = []) {
  return allContacts().filter((c) => c.status === 'drafted' && !c.sent_at && c.draft && c.linkedin_url
    && (!only.length || only.some((o) => c.name.toLowerCase().includes(o))));
}

/** Everything a fill needs per person; a person with no resume is named and left out. */
export async function peopleFor(rows, subjectArg = '', log = console.log) {
  const people = [];
  for (const c of rows) {
    const res = await resumeFor(c.job_id);
    if (!res?.path) { log(`NO RESUME for ${c.name}: ask him which one; left out`); continue; }
    people.push({ id: c.id, name: c.name, profile: c.linkedin_url, message: c.draft, resume: res.path, as: attachName(res.job), subject: subjectFor(subjectArg, c.name, defaultSubject(res.job)) });
  }
  return people;
}

async function main() {
  guardArgs({ usage: 'usage: node jarvis/linkedin-fill.mjs [--name <a,b>] [--subject <text> | "<first>=<subject>|…"] [--batch]', flags: ['--name', '--subject', '--batch'], valued: ['--name', '--subject'] });
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  const only = opt('--name').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const rows = fillableContacts(only);
  if (!rows.length) { console.log('Nothing to fill: no written, unsent message with a LinkedIn profile.'); return; }
  if (args.includes('--batch')) {
    const people = await peopleFor(rows, opt('--subject'));
    const calls = batchPlan(people);
    console.log(people.map((p, i) => `TAB${i + 1} = ${p.name} · "${p.subject}" · ${p.as}`).join('\n'));
    calls.forEach((c, k) => console.log(`--- call ${k + 1} of ${calls.length}\n${JSON.stringify(c)}`));
    return;
  }
  // Plain text, not JSON: the steps are pasted into the javascript tool as
  // printed, and JSON would escape every quote in them.
  for (const c of rows) {
    const res = await resumeFor(c.job_id);
    const subject = subjectFor(opt('--subject'), c.name, defaultSubject(res?.job));
    console.log(`=== ${c.name} (${c.id})
profile: ${c.linkedin_url}
subject: ${subject}
resume: ${res?.path || 'NONE — ask him which resume'}
--- step1
${fillScript({ name: c.name, subject, message: c.draft })}
--- step2
${attachScript(attachName(res?.job))}
`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
