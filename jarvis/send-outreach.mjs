/**
 * START THE SEND SESSION FROM THE TERMINAL (2026-10-24).
 *
 *   node jarvis/send-outreach.mjs                 every saved, unsent message (21 days)
 *   node jarvis/send-outreach.mjs --name dana,sam  only these (older drafts too)
 *   node jarvis/send-outreach.mjs --at "tue 11am-1pm" [--name …]   scheduled send in that window
 *   node jarvis/send-outreach.mjs --list | --cancel [id]
 *   node jarvis/send-outreach.mjs --ensure        the Windows task "Jarvis outreach send"
 *                                                 (login + every 15 min): starts the dashboard
 *                                                 server when a scheduled send waits and it is down
 *
 * His workflow: plan and finalize the messages with Claude in the terminal,
 * then either press "Send all" on the Outreach tab or say "send them". This is
 * the second: it opens the Outreach tab in his Chrome with ?send=…, and the
 * page asks the Jarvis extension for the session exactly as the button does
 * (one window, a tab each, filled; each marked sent once HE presses Send).
 * Nothing here or there presses Send.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardArgs } from './cli.mjs';
import { anyWaiting, whenLabel } from './outreach-schedule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => existsSync(p));

export function sendUrl(names = [], base = 'http://localhost:4300') {
  const arg = names.length ? names.map((n) => encodeURIComponent(n)).join(',') : 'all';
  return `${base}/?send=${arg}#outreach`;
}

const API = 'http://localhost:4300';
const post = (p, body) => fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const when = (s) => whenLabel(s.at, s.until);
const serverUp = () => fetch(`${API}/api/outreach/schedule`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);

/** Laptop on, a scheduled send waiting, no server: start it (hidden, detached, as he starts it). */
async function ensure() {
  if (!anyWaiting()) return;
  if (await serverUp()) return;
  const child = spawn(process.execPath, ['jarvis/serve.mjs'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  console.log(`${new Date().toISOString()} started the dashboard server for a scheduled send (pid ${child.pid})`);
}

async function main() {
  guardArgs({
    usage: 'usage: node jarvis/send-outreach.mjs [--name <a,b>] [--at "<tue 11am-1pm>"] [--connect] [--list] [--cancel [id]] [--credits] [--ensure]',
    flags: ['--name', '--at', '--connect', '--list', '--cancel', '--credits', '--ensure'], valued: ['--name', '--at'],
  });
  const args = process.argv.slice(2);
  if (args.includes('--ensure')) return ensure();
  const i = args.indexOf('--name');
  const names = i >= 0 ? String(args[i + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];

  // Scheduled send (2026-10-24): the server keeps the time and the list, and
  // at that time the extension presses Send on each message that checks out.
  if (args.includes('--list') || args.includes('--cancel')) {
    if (args.includes('--cancel')) {
      const id = args[args.indexOf('--cancel') + 1];
      const r = await post('/api/outreach/schedule/cancel', { id: id && !id.startsWith('-') ? id : '' });
      if (!r) { console.log('The dashboard is not running: npm run jarvis:serve'); process.exitCode = 1; return; }
      console.log(r.cancelled.length ? `Cancelled: ${r.cancelled.map((s) => `${when(s)} (${s.names.join(', ')})`).join('; ')}` : 'Nothing scheduled to cancel.');
      return;
    }
    const r = await fetch(`${API}/api/outreach/schedule`).then((x) => x.json()).catch(() => null);
    if (!r) { console.log('The dashboard is not running: npm run jarvis:serve'); process.exitCode = 1; return; }
    if (!r.schedules.length) console.log('Nothing scheduled.');
    for (const s of r.schedules.slice(0, 8)) console.log(`${s.id}  ${when(s)}  ${s.status}${s.sent ? ` (sent ${s.sent.length} of ${s.ids.length})` : ''}  ${s.names.join(', ')}${s.note ? `  · ${s.note}` : ''}`);
    return;
  }
  // THE INMAIL CHECK (2026-10-26): Chrome opens the Outreach tab with
  // ?credits=…, the extension opens each message window in the background and
  // reads LinkedIn's line; this waits for the answers and prints them.
  if (args.includes('--credits')) {
    const q = await fetch(`${API}/api/outreach/send-queue?pdf=0${names.length ? `&name=${encodeURIComponent(names.join(','))}` : ''}`).then((r) => r.json()).catch(() => null);
    if (!q) { console.log('The dashboard is not running: npm run jarvis:serve'); process.exitCode = 1; return; }
    if (!q.people?.length) { console.log('Nothing waiting: no saved, unsent message with a LinkedIn profile.'); return; }
    const url = `${API}/?credits=${names.length ? names.map(encodeURIComponent).join(',') : 'all'}#outreach`;
    if (!CHROME) { console.log('Chrome not found. Open this in Chrome:', url); return; }
    const started = Date.now();
    spawn(CHROME, [url], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Checking ${q.people.length} in Chrome (a background window opens each message box and closes it; nothing is typed)…`);
    const done = new Set();
    for (let t = 0; t < 120 && done.size < q.people.length; t++) {
      await new Promise((r) => setTimeout(r, 3000));
      const c = await fetch(`${API}/api/outreach/credits`).then((r) => r.json()).catch(() => null);
      for (const p of q.people) {
        const e = c?.byId?.[p.id];
        if (!e || done.has(p.id) || Date.parse(e.at) < started) continue;
        done.add(p.id);
        console.log(`  ${p.name}: ${e.kind === 'free' ? 'FREE message' : e.kind === 'inmail' ? `InMail (${e.line.replace(/^InMail: /, '')})` : `unknown${e.note ? ` (${e.note})` : ''}`}`);
      }
      if (done.size === q.people.length && c?.left != null) console.log(`InMail credits left: ${c.left}`);
    }
    if (done.size < q.people.length) console.log(`No answer for ${q.people.length - done.size} within 6 minutes: is the Jarvis extension loaded in Chrome (chrome://extensions, reload it)?`);
    return;
  }
  const a = args.indexOf('--at');
  if (a >= 0) {
    // --connect (2026-10-26, out of InMail): invitations with each saved note, no message.
    const connect = args.includes('--connect');
    const r = await post('/api/outreach/schedule', { when: String(args[a + 1] || ''), names, ...(connect ? { kind: 'connect' } : {}) });
    if (!r) { console.log('The dashboard is not running: npm run jarvis:serve'); process.exitCode = 1; return; }
    if (r.error) { console.log(`Not scheduled: ${r.error}`); process.exitCode = 1; return; }
    if (connect) console.log(`Scheduled ${r.label}: connection requests with your note to ${r.schedule.names.join(', ')}, 15-20 s apart. When one accepts, their saved message goes in the next Mon–Thu 10am–4pm window, opening "Thanks for connecting!".`);
    else console.log(`Scheduled ${r.label}: ${r.schedule.names.join(', ')}. The first time the laptop is on in that window, Chrome opens and sends each one that checks out, 15-20 s apart. Laptop off the whole window: same hours the next ${r.schedule.days ? 'of those days' : 'weekday'}.`);
    if (r.noResume?.length) console.log(`Left out, no resume: ${r.noResume.join(', ')}`);
    if (r.stale?.length) console.log(`Not included, saved over 21 days ago (use --name): ${r.stale.join(', ')}`);
    return;
  }
  const q = await fetch(`http://localhost:4300/api/outreach/send-queue${names.length ? `?name=${encodeURIComponent(names.join(','))}` : ''}`)
    .then((r) => r.json()).catch(() => null);
  if (!q) { console.log('The dashboard is not running: npm run jarvis:serve'); process.exitCode = 1; return; }
  if (!q.people?.length) { console.log('Nothing waiting: no saved, unsent message with a LinkedIn profile.'); return; }
  if (!CHROME) { console.log('Chrome not found. Open this in Chrome:', sendUrl(names)); return; }
  spawn(CHROME, [sendUrl(names)], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Opening in Chrome: ${q.people.map((p) => p.name).join(', ')}. A tab each, filled; he presses Send.`);
  if (q.noResume?.length) console.log(`Left out, no resume: ${q.noResume.join(', ')}`);
  if (!names.length && q.stale?.length) console.log(`Not included, saved over 21 days ago (use --name): ${q.stale.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
