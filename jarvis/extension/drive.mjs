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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
    --dump            save every page's text, controls (shown or hidden), HTML and a screenshot beside the profile dir
    --click <css>     after the run, click the first element matching <css> (a date picker, a menu) before the dump, so what it opens is captured
    --keep-profile    leave the throwaway Chrome profile on disk
    --show            put the window on screen instead of off it
`;
guardArgs({ usage: USAGE, flags: ['--minutes', '--twice', '--keep-profile', '--show', '--panel', '--dump', '--click'], valued: ['--minutes', '--click'] });

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('-'));
// A STARVED MACHINE PRODUCES A GHOST RESULT, not a failure: with under a
// gigabyte free, Windows killed the harness's Chromium mid-run and the
// report read "runs 0, filled 0" on a form that fills fine (Dexterity,
// 2026-09-05). Say so and stop instead.
const freeGb = freemem() / 1024 ** 3;
const minGb = Number(process.env.JARVIS_DRIVE_MIN_GB || 1.2);
if (freeGb < minGb) {
  console.error(`not enough free memory to drive a browser (${freeGb.toFixed(1)} GB free; needs about ${minGb} GB) — close some apps and try again`);
  process.exit(2);
}
if (!url) { console.error(USAGE); process.exit(2); }
const get = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };
const minutes = Number(get('--minutes') || 6);
const twice = argv.includes('--twice');
const keep = argv.includes('--keep-profile');
const show = argv.includes('--show');
const wantPanel = argv.includes('--panel');
const clickSel = get('--click');
const wantDump = argv.includes('--dump') || !!clickSel;

const EXT = path.dirname(fileURLToPath(import.meta.url));
const profileDir = mkdtempSync(path.join(tmpdir(), 'jarvis-drive-'));
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...(show ? [] : ['--window-position=2000,2000'])],
});
const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 30000 });
// This profile is the harness's own: its fills are not his work, and the
// dashboard does not record them as "prepared" on his rows (2026-09-25).
await worker.evaluate(() => chrome.storage.local.set({ jarvisHarness: true })).catch(() => {});
const page = ctx.pages()[0] || await ctx.newPage();
const logs = [];
const NOISE = /step 1: filled 0, ticked 0$|done: 0 filled, 0 ticked|stopped because: this page is not a multi-step|Submit is yours/;
const hook = (p) => {
  p.on('console', (m) => { const t = m.text(); if (/\[jarvis\]/i.test(t) && !NOISE.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 300)}`); });
  p.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
};
hook(page); ctx.on('page', hook);

// HIS BROWSER IS SLOWER THAN THIS ONE (F-716). Opera GX limits its own CPU
// and he games on this machine: his Lam fill took 71 s where this harness took
// 22, and every fixed wait in the filler ran out. JARVIS_DRIVE_CPU=4 slows the
// page's CPU four times, so a timing fault reproduces here.
const cpuRate = Number(process.env.JARVIS_DRIVE_CPU || 0);
if (cpuRate > 1) {
  const throttle = async (p) => { try { const s = await ctx.newCDPSession(p); await s.send('Emulation.setCPUThrottlingRate', { rate: cpuRate }); } catch { /* not a page */ } };
  await throttle(page); ctx.on('page', throttle);
  console.log(`CPU slowed ${cpuRate}×`);
}
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message));
// HIS PAGE DOES NOT HAVE FOCUS (F-716). He presses Fill in Opera's docked
// panel, so the keyboard focus is there and not in the form; a Playwright page
// is always focused (reference: Playwright blind spots). JARVIS_DRIVE_NOFOCUS=1
// turns the emulation off and puts another window in front, so the form stays
// on screen without focus, as it is in his browser.
if (process.env.JARVIS_DRIVE_NOFOCUS === '1') {
  const s = await ctx.newCDPSession(page);
  await s.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  // A popup is its own WINDOW: the form's tab stays visible, only unfocused.
  const popup = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  await page.evaluate(() => { window.open('about:blank', 'jarvis-focus-thief', 'popup,width=420,height=300'); }).catch(() => {});
  const other = await popup;
  await other?.bringToFront().catch(() => {});
  await other?.evaluate(() => window.focus()).catch(() => {});
  await page.waitForTimeout(500);
  console.log(`form has focus: ${await page.evaluate(() => document.hasFocus()).catch(() => '?')}`);
}
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

// A FILL WAITING FOR ITS RESUME IS NOT QUIET (2026-09-27): the first AMAT
// drive ended at +65 s while the chip said "still writing the resume … it
// attaches when ready", and reported an empty run. The build takes minutes.
const writingResume = async () => {
  for (const p of ctx.pages()) {
    const t = await p.evaluate(() => {
      const host = document.getElementById('jarvis-overlay');
      const root = host?.shadowRoot || host;
      return (root?.querySelector('#jarvis-panel') || root?.querySelector('#jarvis-chip'))?.innerText || '';
    }).catch(() => '');
    if (/still writing the resume/i.test(t)) return true;
  }
  return false;
};

async function waitQuiet(mins) {
  const deadline = Date.now() + mins * 60000;
  let last = ''; let lastChange = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = JSON.stringify(await state());
    if (cur !== last) { last = cur; lastChange = Date.now(); console.log(`  +${Math.round((Date.now() - (deadline - mins * 60000)) / 1000)}s ${cur.slice(0, 400)}`); }
    else if (Date.now() - lastChange > 60000) {
      if (await writingResume()) { lastChange = Date.now(); console.log('  (the resume is still being written — waiting)'); continue; }
      break;
    }
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
// THE WHOLE PAGE, for "it didn't see all of the questions" (AMAT, 2026-10-03):
// its text, every control (shadow roots and iframes too) with whether it is
// drawn, the HTML and a full-page screenshot — what discover() missed is read
// off this, not guessed.
if (wantDump) {
  for (const [i, p] of ctx.pages().entries()) {
    if (/^chrome-extension:|^about:blank/.test(p.url())) continue;
    // WHAT A CONTROL OPENS (2026-10-16, Micron's Eightfold date picker): the
    // dialog exists only after a click, so the dump would never show it.
    if (clickSel) {
      const hit = p.locator(clickSel).first();
      if (await hit.count().catch(() => 0)) {
        await hit.scrollIntoViewIfNeeded().catch(() => {});
        await hit.click({ timeout: 5000 }).catch((e) => console.log(`--click: ${String(e.message).split(/\r?\n/)[0]}`));
        await p.waitForTimeout(900);
        console.log(`CLICKED ${clickSel} on ${p.url().slice(0, 80)}`);
      }
    }
    const base = `${profileDir}-page${i}`;
    for (const f of p.frames()) {
      const dump = await f.evaluate(() => {
        const deep = (root, out = []) => { for (const e of root.querySelectorAll('*')) { out.push(e); if (e.shadowRoot) deep(e.shadowRoot, out); } return out; };
        const els = deep(document);
        const controls = els.filter((e) => e.matches('input:not([type=hidden]), select, textarea, [role=combobox], [role=radio], [role=checkbox], [role=listbox], [contenteditable=true]'))
          .map((e) => {
            const r = e.getBoundingClientRect();
            let lab = e.labels?.[0]?.textContent || e.getAttribute('aria-label') || '';
            if (!lab) { let n = e.parentElement; for (let k = 0; k < 5 && n && !lab; k += 1, n = n.parentElement) lab = (n.querySelector('label, legend')?.textContent || ''); }
            return `${r.width && r.height ? 'shown ' : 'HIDDEN'} ${e.tagName.toLowerCase()}${e.type ? `[${e.type}]` : ''}${e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : ''} #${e.id || e.name || ''} y=${Math.round(r.top + scrollY)} | ${lab.replace(/\s+/g, ' ').trim().slice(0, 120)}`;
          });
        return { text: document.body?.innerText || '', html: document.documentElement.outerHTML, controls };
      }).catch(() => null);
      if (!dump || (!dump.controls.length && dump.text.length < 50)) continue;
      const tag = f === p.mainFrame() ? '' : `-frame${p.frames().indexOf(f)}`;
      writeFileSync(`${base}${tag}.txt`, `URL ${f.url()}\n\nCONTROLS (${dump.controls.length})\n${dump.controls.join('\n')}\n\nTEXT\n${dump.text}`);
      writeFileSync(`${base}${tag}.html`, dump.html);
      console.log(`DUMP ${f.url().slice(0, 100)} — ${dump.controls.length} controls → ${base}${tag}.txt`);
    }
    await p.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  }
}
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
// A CLOSE THAT NEVER RETURNS (2026-09-26): under memory pressure Chromium
// did not answer `close`, the drive sat for ten minutes after printing its
// result, and every drive queued behind it waited. Bounded, then out.
await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
try { if (keep) console.log(`profile kept at ${profileDir}`); else rmSync(profileDir, { recursive: true, force: true }); } catch { /* a locked profile dir is the OS's to clean */ }
process.exit(0);
