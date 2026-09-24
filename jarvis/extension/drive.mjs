/**
 * DRIVE THE SHIPPED EXTENSION AGAINST A REAL POSTING, in a throwaway Chromium.
 *
 *   node jarvis/extension/drive.mjs <posting url> [--minutes 6] [--twice] [--keep-profile]
 *
 * Loads `jarvis/extension` with --load-extension into a fresh persistent
 * profile (a real MV3 worker needs a headed browser), opens the posting,
 * presses the Jarvis button through the worker's own `press`, and prints the
 * tab's accumulated state as it changes — filled, ticked, uploaded, left for
 * him, why it stopped — then the panel's text and the page's [jarvis] console
 * lines. `--twice` presses again once the first run is quiet and reports every
 * field the second pass changed, which is how F-324 was found.
 *
 * It talks to the dashboard on localhost:4300 exactly as the installed copy
 * does, so a run records the job, builds the resume and writes the application
 * record — the product doing its job, on a real posting, without his Chrome.
 * Nothing here can press Submit: the extension never does, and this only
 * presses Jarvis.
 *
 * This is the harness that found F-317 to F-325 in one evening. Every "the
 * batch showed…" fault before it was found by hand.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir, freemem } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { guardArgs } from '../cli.mjs';

const USAGE = `
  node jarvis/extension/drive.mjs <posting url> [options]

    --minutes <n>     how long to wait for the run to go quiet (default 6)
    --twice           press again after the first run and diff every field
    --panel           open the side panel beside the tab at the end, print its text and screenshot it
    --keep-profile    leave the throwaway Chrome profile on disk
    --show            put the window on screen instead of off it
`;
guardArgs({ usage: USAGE, flags: ['--minutes', '--twice', '--keep-profile', '--show', '--panel'], valued: ['--minutes'] });

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('-'));
// A STARVED MACHINE PRODUCES A GHOST RESULT, not a failure: with under a
// gigabyte free, Windows killed the harness's Chromium mid-run and the
// report read "runs 0, filled 0" on a form that fills fine (Dexterity,
// 2026-09-05). Say so and stop instead.
const freeGb = freemem() / 1024 ** 3;
if (freeGb < 1.2) {
  console.error(`not enough free memory to drive a browser (${freeGb.toFixed(1)} GB free; needs about 1.2 GB) — close some apps and try again`);
  process.exit(2);
}
if (!url) { console.error(USAGE); process.exit(2); }
const get = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };
const minutes = Number(get('--minutes') || 6);
const twice = argv.includes('--twice');
const keep = argv.includes('--keep-profile');
const show = argv.includes('--show');
const wantPanel = argv.includes('--panel');

const EXT = path.dirname(fileURLToPath(import.meta.url));
const profileDir = mkdtempSync(path.join(tmpdir(), 'jarvis-drive-'));
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...(show ? [] : ['--window-position=2000,2000'])],
});
const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const page = ctx.pages()[0] || await ctx.newPage();
const logs = [];
const NOISE = /step 1: filled 0, ticked 0$|done: 0 filled, 0 ticked|stopped because: this page is not a multi-step|Submit is yours/;
const hook = (p) => {
  p.on('console', (m) => { const t = m.text(); if (/\[jarvis\]/i.test(t) && !NOISE.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 300)}`); });
  p.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
};
hook(page); ctx.on('page', hook);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
await page.waitForTimeout(2500);
const tab = await worker.evaluate(async (u) => {
  const ts = await chrome.tabs.query({});
  const t = ts.find((x) => x.url && x.url.startsWith(u.slice(0, 40))) || ts[0];
  return { id: t.id, url: t.url };
}, url);
console.log(`tab ${tab.id}  ${tab.url}`);

// THE TAB THE APPLICATION MOVED TO. An Apply that opens a new tab (AGCO's
// SuccessFactors, some Workday tenants) arms that tab, and the original one
// then says only "followed Apply — picking up on the page it opened". The
// state reported is the armed tab that did the most recent useful thing.
const state = () => worker.evaluate(async (id) => {
  await self.armedState(id);
  const { armed } = await chrome.storage.local.get('armed');
  const all = Object.entries(armed || {}).map(([k, v]) => [Number(k), v]);
  const best = all.sort((a, b) => (b[1].lastUsefulAt || 0) - (a[1].lastUsefulAt || 0))[0];
  const s = best ? best[1] : await self.armedState(id);
  return s ? { tab: best ? best[0] : id, runs: s.runs, acc: s.acc } : null;
}, tab.id).catch((e) => ({ err: e.message }));
const press = () => worker.evaluate(async (id) => { const t = await chrome.tabs.get(id); await self.press(t); }, tab.id);
const applyPage = () => ctx.pages().find((x) => /apply|application/i.test(x.url())) || ctx.pages()[0];

const snapshot = async () => applyPage().evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (!el.getClientRects().length) continue;
    const lab = el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.name || el.id || el.placeholder || '';
    const key = `${lab.replace(/\s+/g, ' ').trim().slice(0, 60)}|${el.type || el.tagName}`;
    if (el.type === 'checkbox' || el.type === 'radio') out[key] = el.checked ? 'on' : 'off';
    else if (el.type === 'file') out[key] = el.files?.length ? `file:${el.files[0].name}` : '';
    else out[key] = String(el.value || '').slice(0, 60);
  }
  for (const el of document.querySelectorAll('[role="combobox"], [data-test-id], [data-automation-id^="formField-"]')) {
    const id = el.getAttribute('data-test-id') || el.getAttribute('data-automation-id') || el.id;
    if (!id) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (t) out[`custom:${id}`] = t;
  }
  return out;
}).catch(() => ({}));

async function waitQuiet(mins) {
  const deadline = Date.now() + mins * 60000;
  let last = ''; let lastChange = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = JSON.stringify(await state());
    if (cur !== last) { last = cur; lastChange = Date.now(); console.log(`  +${Math.round((Date.now() - (deadline - mins * 60000)) / 1000)}s ${cur.slice(0, 400)}`); }
    else if (Date.now() - lastChange > 60000) break;
  }
}

console.log('PRESS'); await press(); await waitQuiet(minutes);
if (twice) {
  const before = await snapshot();
  console.log(`fields on the page: ${Object.keys(before).length}`);
  console.log('PRESS AGAIN'); await press(); await waitQuiet(Math.min(minutes, 3));
  const after = await snapshot();
  const diff = Object.keys({ ...before, ...after }).filter((k) => (before[k] || '') !== (after[k] || ''));
  console.log(`CHANGED BY THE SECOND PASS: ${diff.length}`);
  for (const k of diff) console.log(`  ${k}: ${JSON.stringify(before[k] || '')} -> ${JSON.stringify(after[k] || '')}`);
}

const final = await state();
console.log('\nFINAL', JSON.stringify(final, null, 1).slice(0, 2000));
for (const p of ctx.pages()) {
  const panel = await p.evaluate(() => {
    const host = document.getElementById('jarvis-overlay');
    const root = host?.shadowRoot || host;
    const el = root?.querySelector('#jarvis-panel') || root?.querySelector('#jarvis-chip');
    return el ? el.innerText.slice(0, 1500) : null;
  }).catch(() => null);
  if (panel) console.log(`\nPANEL on ${p.url()}\n${panel}`);
}
console.log('\nLOGS\n' + logs.slice(-40).join('\n'));
// THE SIDE PANEL, on a real posting, in a visible Chromium: the page it shows
// for the driven tab, its text, and a screenshot to look at.
if (wantPanel) {
  const panelPage = await ctx.newPage();
  await panelPage.setViewportSize({ width: 380, height: 1200 });
  await panelPage.goto(`${worker.url().replace(/background\.js$/, '')}panel.html?tab=${tab.id}`);
  await panelPage.waitForFunction(() => !document.getElementById('main').hidden || /Not a posting|cannot see/.test(document.getElementById('empty').textContent), null, { timeout: 30000 }).catch(() => {});
  await panelPage.waitForFunction(() => !document.getElementById('pdf').hidden || /No resume|could not|not a posting|Not a posting/i.test(document.body.innerText), null, { timeout: 240000 }).catch(() => {});
  await panelPage.waitForTimeout(1500);
  const text = await panelPage.evaluate(() => document.body.innerText.slice(0, 2500));
  const shot = `${profileDir}-panel.png`;
  await panelPage.screenshot({ path: shot, fullPage: true });
  console.log(`\nSIDE PANEL for tab ${tab.id}\n${text}\n  screenshot: ${shot}`);
}
await ctx.close();
if (keep) console.log(`profile kept at ${profileDir}`); else rmSync(profileDir, { recursive: true, force: true });
