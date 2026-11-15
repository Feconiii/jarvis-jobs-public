/**
 * DRAG A FILE FROM THE PANEL ONTO AN UPLOAD BOX (2026-10-22).
 *
 * The worker's dropCatcher runs in a real Chromium page and a real (trusted)
 * drag is made from a stand-in for the panel chip onto a form with two hidden
 * upload slots. The file must land in the slot it was dropped on, the page's
 * own drop listener must not see the marker drag, and an uploader that only
 * listens on its zone must get the file as a drop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The function's own source, cut out of background.js by its braces. */
function sourceOf(name) {
  const src = readFileSync(path.join(HERE, 'background.js'), 'utf8');
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in background.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const PAGE = `<!doctype html><body style="font:14px sans-serif">
  <div id="chip" draggable="true" style="width:120px;height:30px;background:#ddd">Portfolio</div>
  <div class="upload-zone" id="z1" style="width:320px;height:80px;margin-top:30px;border:1px solid #999">Resume
    <input type="file" id="r" style="display:none"></div>
  <div class="upload-zone" id="z2" style="width:320px;height:80px;margin-top:30px;border:1px solid #999">Portfolio
    <input type="file" id="p" style="display:none"></div>
  <textarea id="t" style="margin-top:30px;width:320px;height:60px"></textarea>
  <script>
    window.seen = [];
    for (const z of document.querySelectorAll('.upload-zone')) z.addEventListener('drop', (e) => {
      e.preventDefault();
      seen.push({ zone: z.id, trusted: e.isTrusted, files: e.dataTransfer ? e.dataTransfer.files.length : 0 });
    });
    for (const z of document.querySelectorAll('.upload-zone')) z.addEventListener('dragover', (e) => e.preventDefault());
    document.getElementById('chip').addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-jarvis-file', 'portfolio');
      e.dataTransfer.setData('text/plain', 'Alex Rivera Portfolio.pdf');
    });
  </script></body>`;

test('a chip dropped on the portfolio box puts the portfolio PDF in that box, and only there', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip(`no browser: ${e.message}`); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await page.evaluate(() => {
      window.notes = [];
      window.chrome = { runtime: { sendMessage: async (m) => {
        if (m.type === 'drag-file') return { ok: true, b64: btoa('%PDF-1.4 portfolio'), filename: 'Alex Rivera Portfolio.pdf', what: m.what };
        if (m.type === 'drag-note') window.notes.push(m.text);
        return undefined;
      } } };
    });
    await page.evaluate(`(${sourceOf('dropCatcher')})('portfolio', 'the portfolio')`);
    await page.dragAndDrop('#chip', '#z2');
    await page.waitForFunction(() => window.notes.some((n) => /^Attached/.test(n)), null, { timeout: 5000 });
    // The fallback drop for a hidden input comes after a short wait.
    await page.waitForFunction(() => window.seen.length > 0, null, { timeout: 5000 });
    const got = await page.evaluate(() => ({
      p: [...document.getElementById('p').files].map((f) => f.name),
      r: document.getElementById('r').files.length,
      seen: window.seen,
      notes: window.notes,
    }));
    assert.deepEqual(got.p, ['Alex Rivera Portfolio.pdf'], 'the portfolio slot holds the file');
    assert.equal(got.r, 0, 'the resume slot beside it is untouched');
    assert.ok(got.seen.every((s) => !s.trusted), `the page never saw the marker drag itself: ${JSON.stringify(got.seen)}`);
    assert.deepEqual(got.seen, [{ zone: 'z2', trusted: false, files: 1 }], 'a zone-only uploader got the file as a drop');

    // Disarmed (the panel's dragend): an ordinary drag on the page is the page's.
    await page.evaluate(`(${sourceOf('dropCatcher')})('', '')`);
    await page.evaluate(() => { window.seen = []; });
    await page.dragAndDrop('#chip', '#z1');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ r: document.getElementById('r').files.length, seen: window.seen }));
    assert.equal(after.r, 0, 'nothing attached once disarmed');
    assert.equal(after.seen.length, 1, 'the page handled its own drop');
    assert.equal(after.seen[0].trusted, true);
  } finally {
    await browser.close();
  }
});

test('a drop that lands on no upload box attaches nothing and says so', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip(`no browser: ${e.message}`); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE.replace(/<div class="upload-zone"[\s\S]*?<\/div>\s*<div class="upload-zone"[\s\S]*?<\/div>/, ''));
    await page.evaluate(() => {
      window.notes = [];
      window.chrome = { runtime: { sendMessage: async (m) => { if (m.type === 'drag-note') window.notes.push(m.text); return { ok: true, b64: '', filename: 'x.pdf' }; } } };
    });
    await page.evaluate(`(${sourceOf('dropCatcher')})('portfolio', 'the portfolio')`);
    await page.dragAndDrop('#chip', '#t');
    await page.waitForFunction(() => window.notes.length > 0, null, { timeout: 5000 });
    const got = await page.evaluate(() => ({ notes: window.notes, text: document.getElementById('t').value }));
    assert.match(got.notes[0], /No upload box there/);
    assert.equal(got.text, '', 'the marker text never lands in a text box');
  } finally {
    await browser.close();
  }
});
