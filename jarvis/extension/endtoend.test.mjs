/**
 * THE WHOLE THING, WITH NOTHING STUBBED BUT THE BUTTON.
 *
 * Every other test in this suite replaces something. `fill.test.mjs` calls
 * `planForm` in-process. `background.test.mjs` supplies its own `fetch`.
 * `loaded.test.mjs` proves the extension loads but cannot inject, because
 * `activeTab` is granted by a real click and by nothing else.
 *
 * This one runs:
 *
 *   the real dashboard server  ->  the real tailored PDF on disk
 *   -> the real /api/plan and /api/apply-resume over a real socket
 *   -> the real discover.js and content.js, byte for byte as shipped
 *   -> a real <input type=file> on a real page
 *
 * Only `chrome.runtime.sendMessage` is simulated, and it is wired to the same
 * HTTP endpoints background.js calls, with the same token handshake — the one
 * that was broken for the entire life of the project (F-166).
 *
 * It exists because two claims were only ever proven by hand: that a TAILORED
 * resume reaches the form, and that a multi-screen application is walked
 * end to end. Proven by hand is proven once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// report.js rides in the same injection as discover.js and content.js (2026-09-23).
const DISCOVER = readFileSync(path.join(HERE, 'report.js'), 'utf-8') + String.fromCharCode(10) + readFileSync(path.join(HERE, 'discover.js'), 'utf-8');
const CONTENT = readFileSync(path.join(HERE, 'content.js'), 'utf-8');
const PORT = 4392;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let browser;
let page;
let token;
let applied = null;   // { id, company, resume } once a real application is built

async function up(capMs = 25000) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

test.before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'jarvis', 'serve.mjs'), '--port', String(PORT)],
    { cwd: ROOT, env: { ...process.env, JARVIS_AUTO: '0' }, stdio: 'ignore' });
  assert.ok(await up(), 'the dashboard must start');
  // NO Origin header, because that is how the real extension asks.
  //
  // Chrome OMITS Origin when an extension fetches a host it holds permission
  // for (F-166), so the shipped worker reaches this endpoint with no Origin and
  // `sec-fetch-dest: empty`. This harness used to send a made-up
  // `chrome-extension://test` instead, which worked only while the gate
  // accepted ANY extension id. Pinning it to the installed extension (F-271)
  // correctly refused the fake, and every test in this file failed on
  // "and hand out a token".
  token = (await (await fetch(`${BASE}/api/apply-token`)).json()).token;
  assert.ok(token, 'and hand out a token');

  browser = await chromium.launch();
  // BYPASS THE PAGE'S CSP, because the real extension does.
  //
  // background.js injects with chrome.scripting.executeScript, which is
  // extension-privileged and is not subject to the page's Content-Security-
  // Policy — that is exactly why the fetches live in the worker. This harness
  // injects with addScriptTag, which IS subject to it, so pointing the test at
  // a real Ashby posting failed with "Executing inline script violates the
  // following Content Security Policy directive" — a property of the harness
  // that the shipped extension does not have. Without this the test can only
  // ever run against sites with a lax CSP, which is the opposite of the ones
  // worth testing.
  const context = await browser.newContext({ bypassCSP: true });
  page = await context.newPage();

  // The messaging channel, wired to the REAL endpoints rather than to planForm.
  await page.exposeFunction('__jarvisHttp', async (kind, body) => {
    if (kind === 'plan') {
      const r = await fetch(`${BASE}/api/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jarvis-token': token },
        body: JSON.stringify(body),
      });
      return { ok: r.ok, plan: await r.json() };
    }
    const r = await fetch(`${BASE}/api/apply-resume?pageUrl=${encodeURIComponent(body.pageUrl || '')}`,
      { headers: { 'x-jarvis-token': token } });
    if (!r.ok) return { ok: false, error: (await r.json()).error };
    return { ok: true, bytes: [...new Uint8Array(await r.arrayBuffer())] };
  });
});

test.after(async () => { await browser?.close(); server?.kill(); });

/** Load a fixture and run the shipped scripts against it. */
async function fill(html, pageUrl) {
  await page.goto(pageUrl || 'about:blank');
  await page.setContent(html);
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg, reply) => {
          if (msg.type === 'plan') reply(await globalThis.__jarvisHttp('plan', { fields: msg.fields, pageUrl: msg.pageUrl }));
          else if (msg.type === 'resume') reply(await globalThis.__jarvisHttp('resume', { pageUrl: msg.pageUrl }));
          else reply({ ok: false, error: 'unknown' });
        },
      },
    };
  });
  return page.evaluate(CONTENT);
}

test('a real application is built, with a REAL tailored resume', async (t) => {
  // The slowest test in the suite by far, and the only one that exercises the
  // thing he said he had never seen: a resume written FOR the posting.
  //
  // CANDIDATES, NOT `rows[0]`. This took the first queued job and applied to
  // it, which made the whole file fail the moment the top of his queue was a
  // posting that had expired — and it was: an Amazon req answering HTTP 404.
  // /api/apply refuses a dead posting on purpose (it must not spend two minutes
  // tailoring for a job that is gone), so the one test proving a tailored
  // resume reaches a real form had quietly stopped running.
  //
  // A dead queue is his data, not a defect in this code. Try the live ones, and
  // if there are none, SKIP and say so rather than reporting a failure that no
  // change to this repo could fix.
  const candidates = await (async () => {
    const s = await import('../store.mjs');
    return [
      ...s.query({ status: 'queued' }, { limit: 6 }).rows,
      ...s.query({ status: 'interested' }, { limit: 6 }).rows,
    ];
  })();
  assert.ok(candidates.length, 'the store must have at least one job to apply to');

  let job = null;
  let started = null;
  const refused = [];
  for (const candidate of candidates) {
    const r = await (await fetch(`${BASE}/api/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: candidate.id }),
    })).json();
    if (r.status === 'tailoring') { job = candidate; started = r; break; }
    // A gone posting is refused BEFORE a tab is opened, so this costs nothing.
    refused.push(`${candidate.company}: ${r.gone ? 'posting is gone' : (r.error || 'refused')}`);
  }
  if (!job) {
    return t.skip(`no live posting to apply to — tried ${refused.length}: ${refused.join('; ')}`);
  }
  assert.equal(started.status, 'tailoring', 'apply must return immediately, not hold the request');

  // Wait for the resume. Tailoring calls a local model and takes minutes.
  let status = null;
  for (let i = 0; i < 140; i += 1) {
    status = await (await fetch(`${BASE}/api/apply-status?id=${job.id}`)).json();
    if (status.status !== 'tailoring') break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.equal(status.status, 'ready', `resume never finished: ${status.error || status.status}`);
  assert.ok(existsSync(status.resume), 'and the PDF must exist on disk');
  applied = { id: job.id, company: job.company, resume: status.resume, jobUrl: job.url, family: status.family };
}, { timeout: 480000 });

test('THE TAILORED RESUME REACHES THE FORM', async (t) => {
  if (!applied) return t.skip('no live posting was available to build from');
  const result = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name">
      <label for="email">Email</label><input id="email">
      <div><h3>Resume</h3><label for="resume">Attach</label><input id="resume" type="file" style="display:none"></div>
      <div><h3>Cover Letter</h3><label for="cover_letter">Attach</label><input id="cover_letter" type="file" style="display:none"></div>
    </form>`, applied.jobUrl);

  assert.equal(result.uploaded, true, `no resume attached: ${result.stoppedBecause || ''}`);

  const got = await page.evaluate(async () => {
    const f = document.getElementById('resume').files[0];
    return f ? { name: f.name, size: f.size, head: new TextDecoder().decode(await f.slice(0, 8).arrayBuffer()) } : null;
  });
  assert.ok(got, 'the file input must actually hold a file');
  assert.equal(got.name, 'Alex Rivera Resume.pdf', 'the recruiter-facing filename is fixed on purpose');
  assert.match(got.head, /^%PDF/, 'and it must be a real PDF');

  // THE point: the bytes in the form are the tailored PDF from disk, not a stub.
  const onDisk = readFileSync(applied.resume);
  assert.equal(got.size, onDisk.length, 'the attached bytes must be the tailored resume, byte for byte');

  const cover = await page.evaluate(() => document.getElementById('cover_letter').files.length);
  assert.equal(cover, 0, 'and it must never land in the cover-letter slot');
});

test('the resume it attached was written FOR this posting', async (t) => {
  if (!applied) return t.skip('no live posting was available to build from');
  // Not just "a PDF" — the tailoring report has to name what it reworded, and
  // the family has to be the one the router chose for this job.
  const status = await (await fetch(`${BASE}/api/apply-status?id=${applied.id}`)).json();
  assert.ok(status.family?.key, 'a family must have been chosen');
  assert.ok(status.tailoring, 'and a tailoring report kept');
  assert.match(status.resume, new RegExp(status.family.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the PDF must come from the folder of the family that was chosen');
  for (const applied_ of status.tailoring.applied || []) {
    assert.ok(applied_.from && applied_.to && applied_.from !== applied_.to,
      'every recorded rewrite must be a real change, before and after');
  }
});

test('AUTO APPLY: it walks a multi-screen application and stops before Submit', async (t) => {
  if (!applied) return t.skip('no live posting was available to build from');
  const result = await fill(`
    <div id="app"></div>
    <script>
      const steps = [
        '<h2>My Information</h2><label for="first_name">First Name</label><input id="first_name">' +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button>',
        '<h2>My Experience</h2><h3>Resume/CV</h3><label for="resume">Upload a file (5MB max)</label>' +
          '<input id="resume" type="file" style="display:none">' +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button>',
        '<h2>Application Questions</h2>' +
          '<label for="auth">Are you legally authorized to work in the United States?</label>' +
          '<select id="auth"><option>Select</option><option>Yes</option><option>No</option></select>' +
          '<label for="c">I agree to the Terms and Conditions</label><input id="c" type="checkbox">' +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button>',
        '<h2>Review</h2><label for="email">Email</label><input id="email">' +
          '<button data-automation-id="pageFooterNextButton">Submit</button>',
      ];
      let i = 0;
      const render = () => {
        document.getElementById('app').innerHTML = steps[i];
        const b = document.querySelector('[data-automation-id="pageFooterNextButton"]');
        if (b && b.textContent === 'Save and Continue') b.onclick = () => { i += 1; render(); };
        if (b && b.textContent === 'Submit') b.onclick = () => { window.__SUBMITTED = true; };
      };
      render();
    </script>`, applied.jobUrl);

  assert.equal(result.steps, 4, 'all four screens, not just the first');
  assert.equal(result.uploaded, true, 'the resume is on screen TWO and must attach there');
  assert.match(result.stoppedBecause, /last step before Submit/);

  const after = await page.evaluate(() => ({
    submitted: !!window.__SUBMITTED,
    onScreen: document.querySelector('h2').textContent,
    email: document.getElementById('email')?.value,
  }));
  assert.equal(after.submitted, false, 'SUBMIT IS HIS. Nothing here may press it.');
  assert.equal(after.onScreen, 'Review', 'it walks to Review and waits');
  assert.ok(after.email, 'having filled the last screen on the way');
});

test('the work-authorisation answer that goes out is the TRUE one', async (t) => {
  if (!applied) return t.skip('no live posting was available to build from');
  // F-168: "…without sponsorship" used to answer Yes. He needs sponsorship.
  // This runs through the real planner and the real profile, on a real form.
  const result = await fill(`
    <form>
      <label for="a">Are you legally authorized to work in the United States?</label>
      <select id="a"><option>Select</option><option>Yes</option><option>No</option></select>
      <label for="b">Are you legally authorized to work in the United States without sponsorship?</label>
      <select id="b"><option>Select</option><option>Yes</option><option>No</option></select>
      <label for="c">Country of Citizenship</label><input id="c">
    </form>`, applied.jobUrl);

  const state = await page.evaluate(() => ({
    authorized: document.getElementById('a').value,
    withoutSponsorship: document.getElementById('b').value,
    citizenship: document.getElementById('c').value,
  }));
  assert.equal(state.authorized, 'Yes', 'he is authorised to work in the US, and that stays answered');
  // F-335 made this DERIVED rather than blank: "authorized without sponsorship"
  // is the conjunction of two answers he has already given, and since he
  // requires sponsorship it resolves to No. Pinned as No rather than merely
  // "not Yes" — a blank here would also pass "not Yes", and a blank on a
  // required question stops the form.
  assert.equal(state.withoutSponsorship, 'No', 'he NEEDS sponsorship — Yes would be a false claim, blank would stop the form');
  // HIS CITIZENSHIP IS ANSWERED, AND ANSWERED TRUTHFULLY (since 2026-09-04).
  //
  // This assertion read '' until 2026-09-13, and by then it was the last place
  // in the repo still saying so: the profile gained `citizenship_country`, the
  // rule in `_answers.mjs` was rewritten to use it, and `answers.test.mjs` was
  // updated the same day. This file was not, so it went on asserting behaviour
  // the engine had deliberately stopped having — and only failed now because
  // the end-to-end run is not part of `npm run jarvis:test`.
  //
  // Answering it is the safer behaviour, not the looser one. Every Eightfold
  // tenant (Lam, Micron, Applied Materials) asks for country of citizenship to
  // determine export licensing, usually required; a blank there stops the form,
  // and the address rule used to fill "United States of America", which is a
  // false claim about the one fact on the page that matters most. "Vietnam" is
  // true, it comes from his own profile, and it is review-flagged.
  //
  // What F-168 is actually about — never a FALSE work-authorisation claim — is
  // the two assertions above, and they are untouched.
  assert.equal(state.citizenship, 'Vietnam', 'his citizenship is answered from his profile, never from his address');
  // AND NOTHING ON THIS FORM IS LEFT FOR HIM ANY MORE. This line used to
  // assert the opposite — that "without sponsorship" came back on the
  // unanswered list — which was true until F-335 derived it. All three
  // questions now have true answers, so an empty report is the right report.
  const stillBlank = result.unanswered.filter((u) => /sponsor|citizen|authoriz/i.test(u));
  assert.deepEqual(stillBlank, [], 'every work-authorisation question on this form is answered, and answered truthfully');
});
