/**
 * THE WHOLE PIPELINE, end to end, with the real files.
 *
 * `discover.js` and `content.js` are loaded verbatim — the same bytes the
 * extension ships — into a real browser, against fixtures reduced from live
 * forms. The only thing stubbed is `chrome.runtime.sendMessage`, because that is
 * the one part a page cannot have; it is wired to the same `planForm` the server
 * calls, so every decision under test is the real one.
 *
 * This exists because everything else in the suite tests one half. Discovery was
 * proven, planning was proven, and the resume still never attached — because the
 * two halves met in a place nothing tested. This is that place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import { planForm } from '../apply-plan.mjs';
import { chooseOption } from '../apply/_form.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// report.js rides in the same injection as discover.js and content.js (2026-09-23).
const DISCOVER = readFileSync(path.join(HERE, 'report.js'), 'utf-8') + String.fromCharCode(10) + readFileSync(path.join(HERE, 'discover.js'), 'utf-8');
const CONTENT = readFileSync(path.join(HERE, 'content.js'), 'utf-8');
// P2: the worker runs these in the page's world; the harness does the same.
const ORACLE_SELECT = readFileSync(path.join(HERE, 'oracle-select.js'), 'utf-8');

const PROFILE = {
  identity: {
    first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera',
    email: 'v@example.test', phone: '+1 (555) 000-0000',
    location: 'Springfield, Washington', city: 'Springfield', state: 'Washington',
    country: 'United States', postal_code: '00000', address_line1: '1 Test St',
    linkedin: 'https://linkedin.com/in/alex',
  },
  education: { school: 'Lakeside University', discipline: 'Mechanical Engineering' },
  work_experience: [
    { title: 'Mechanical Engineer Intern', company: 'Acme Fab', location: 'Austin, Texas', start: 'May 2026', end: 'August 2026', description: 'Designed an inspection fixture.' },
    { title: 'Manufacturing Lead', company: 'Test University', location: 'Springfield, Washington', start: 'August 2024', description: 'Ran the shop floor.' },
  ],
  answers: { authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', restricted_country_citizen: 'No',
    // Two truthful answers to one question whose SHAPE differs by tenant:
    // free text on some forms, a fixed list on others (F-390).
    how_heard: 'LinkedIn', heard_about_us: 'Job Board or Social Media',
    skills: 'SolidWorks, Autodesk Inventor, Creo, AutoCAD, GD&T, FEA, Python, Lean manufacturing' },
  eeo: { gender: 'Male', race: 'Asian', veteran: 'I am not a protected veteran', disability: 'No' },
};

// A tiny stand-in for the tailored PDF. Only its bytes and name are under test.
const RESUME_BYTES = Array.from(Buffer.from('%PDF-1.4\n% jarvis test resume\n%%EOF'));

let browser;
let page;

test.before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  // JDEBUG=1 prints the page's own [jarvis] lines, for a failing fixture.
  if (process.env.JDEBUG) page.on('console', (m) => { if (/jarvis/i.test(m.text())) console.log('  PAGE', m.text().slice(0, 240)); });

  // The server side, reachable from the page. Same planner the dashboard uses.
  await page.exposeFunction('__jarvisPlan', (fields, sections) => planForm(fields, PROFILE, { sections: sections || [] }));
  await page.exposeFunction('__jarvisResume', () => RESUME_BYTES);
  // The worker forwards an open list to /api/choose, which ranks it with the
  // same matcher that made the plan. The fixture answers the same way.
  await page.exposeFunction('__jarvisChoose', (want, options) => chooseOption(want, options));
  // His own hands, from inside a fixture's hook: a real click and real keys (P2).
  await page.exposeFunction('__hisKeys', async (selector, text) => { await page.click(selector); await page.keyboard.type(text); });
});
test.after(async () => { await browser?.close(); });

/** Load a fixture, then run discover.js + content.js exactly as shipped. */
async function fill(html, { planError = '', editPlan = '', worker = null, url = '', before = null } = {}) {
  // A FRESH DOCUMENT. `setContent` reuses the current one (document.write), so
  // an armed run's watcher, its timers and `__jarvisContent` would all survive
  // into the next fixture and race it.
  // `url`: served from that address, for code that reads the host (F-706).
  if (url) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
  } else {
    await page.goto('about:blank');
    await page.setContent(html);
  }
  await page.addScriptTag({ content: DISCOVER });
  await page.addScriptTag({ content: ORACLE_SELECT });
  // Stub only the extension messaging channel.
  await page.evaluate(({ planError, editPlan, worker }) => {
    globalThis.__sentMsgs = [];
    globalThis.chrome = {
      runtime: {
        // A LIVE WORKER, when a test asks for one (2026-09-23): an extension
        // context the page can reach, so its report goes to the side panel.
        ...(worker ? { id: 'jarvis-test' } : {}),
        sendMessage: async (msg, reply) => {
          globalThis.__sentMsgs.push(msg);
          if (worker && (msg.type === 'page-report' || msg.type === 'page-live')) { reply({ ok: true, panelOpen: !!worker.panelOpen }); return; }
          if (worker && msg.type === 'open-panel') { reply({ ok: true }); return; }
          if (msg.type === 'plan' && planError) reply({ ok: false, error: planError });
          else if (msg.type === 'plan') {
            let plan = await globalThis.__jarvisPlan(msg.fields, msg.sections);
            // A test may reshape the plan (an education entry with months).
            if (editPlan) plan = (0, eval)(`(${editPlan})`)(plan);
            reply({ ok: true, plan });
          }
          // A resume still being written (F-989): a fixture sets __resume425 to how many "not yet" answers come first.
          else if (msg.type === 'resume' && globalThis.__resume425 > 0) { globalThis.__resume425 -= 1; reply({ ok: false, status: 425, error: 'writing the resume' }); }
          else if (msg.type === 'resume') reply({ ok: true, bytes: await globalThis.__jarvisResume() });
          else if (msg.type === 'choose') { const index = await globalThis.__jarvisChoose(msg.want, msg.options); reply({ ok: true, index, value: index >= 0 ? msg.options[index] : null }); }
          // The sign-in code from his email: whatever the fixture put in window.__code.
          else if (msg.type === 'code') reply(globalThis.__code ? { code: globalThis.__code, from: 'Acme Careers' } : { code: null, why: 'none yet' });
          // P2, as the worker does it: read the box's own list, choose, reply — and set only on the second ask.
          // A fixture's __duringPick runs while the list is being read (the box changing under it).
          else if (msg.type === 'oracle-pick') {
            const r = globalThis.__jarvisOracleSelect.oracleSelectRead(msg.inputId);
            let index = -1;
            if (r.ok) for (const w of msg.wants || []) { index = await globalThis.__jarvisChoose(w, r.labels); if (index >= 0) break; }
            if (typeof globalThis.__duringPick === 'function') await globalThis.__duringPick();
            reply(!r.ok ? r : index >= 0 ? { ok: true, index, label: r.labels[index] } : { ok: false, why: 'his answer is not among its options' });
          }
          // __duringSet: runs after the content script's last look and before the page's (the race the guard closes).
          else if (msg.type === 'oracle-set') {
            if (typeof globalThis.__duringSet === 'function') await globalThis.__duringSet();
            reply(globalThis.__jarvisOracleSelect.oracleSelectSet(msg.inputId, msg.index, msg.label, { before: msg.before, wanted: msg.wanted }));
          }
          else reply({ ok: false, error: 'unknown' });
        },
      },
    };
  }, { planError, editPlan, worker });
  if (before) await before();
  return page.evaluate(CONTENT);
}

/**
 * Workday's My Experience, as the driver has measured it: an Add button per
 * section, a sub-form of data-automation-id wrappers per entry, month/year
 * spinners for dates, a checkbox for "I currently work here", and ONE blank
 * Work Experience panel pre-created by the tenant.
 */
const MY_EXPERIENCE = `
  <h2>My Experience</h2>
  <div id="work"><h3>Work Experience</h3><div id="work-panels"></div><button type="button" data-automation-id="Add">Add</button></div>
  <div id="edu"><h3>Education</h3><div id="edu-panels"></div><button type="button" data-automation-id="Add">Add</button></div>
  <div id="web"><h3>Websites</h3><button type="button" data-automation-id="Add" onclick="window.__websiteAdded = 1">Add</button></div>
  <script>(() => {
    const mk = (id, inner) => { const d = document.createElement('div'); d.setAttribute('data-automation-id', id); d.innerHTML = inner; return d; };
    const spinners = () => '<input data-automation-id="dateSectionMonth-input" placeholder="MM"><input data-automation-id="dateSectionYear-input" placeholder="YYYY">';
    const addWork = () => {
      const p = document.createElement('div'); p.className = 'panel';
      p.append(mk('formField-jobTitle', '<label>Job Title</label><input>'), mk('formField-companyName', '<label>Company</label><input>'),
        mk('formField-location', '<label>Location</label><input>'), mk('formField-currentlyWorkHere', '<label><input type="checkbox"> I currently work here</label>'),
        mk('formField-startDate', '<label>From</label>' + spinners()), mk('formField-endDate', '<label>To</label>' + spinners()),
        mk('formField-roleDescription', '<label>Role Description</label><textarea></textarea>'));
      document.getElementById('work-panels').append(p);
      document.querySelector('#work button').textContent = 'Add Another';
    };
    addWork();   // the blank panel Workday pre-creates
    document.querySelector('#work button').addEventListener('click', addWork);
    document.querySelector('#edu button').addEventListener('click', () => {
      const p = document.createElement('div');
      p.append(mk('formField-schoolName', '<label>School or University</label><input>'), mk('formField-fieldOfStudy', '<label>Field of Study</label><input>'));
      document.getElementById('edu-panels').append(p);
    });
  })();<\/script>`;

test('WORKDAY MY EXPERIENCE IS ADDED AND FILLED — reusing the blank panel, never touching Websites', async () => {
  const result = await fill(MY_EXPERIENCE);
  const got = await page.evaluate(() => {
    const val = (panel, id) => panel.querySelector('[data-automation-id="' + id + '"] input, [data-automation-id="' + id + '"] textarea')?.value || '';
    const panels = [...document.querySelectorAll('#work-panels .panel')];
    return {
      panels: panels.length,
      work: panels.map((p) => ({
        title: val(p, 'formField-jobTitle'), company: val(p, 'formField-companyName'), location: val(p, 'formField-location'),
        desc: val(p, 'formField-roleDescription'),
        current: p.querySelector('[data-automation-id="formField-currentlyWorkHere"] input').checked,
        from: [...p.querySelectorAll('[data-automation-id="formField-startDate"] input')].map((i) => i.value).join('/'),
        to: [...p.querySelectorAll('[data-automation-id="formField-endDate"] input')].map((i) => i.value).join('/'),
      })),
      edu: [...document.querySelectorAll('#edu-panels > div')].map((p) => ({ school: val(p, 'formField-schoolName'), field: val(p, 'formField-fieldOfStudy') })),
      addLabel: document.querySelector('#work button').textContent,
      websiteAdded: window.__websiteAdded,
    };
  });
  assert.equal(got.panels, 2, 'two entries, and the pre-created blank panel was REUSED for the first');
  assert.equal(got.work[0].title, 'Mechanical Engineer Intern');
  assert.equal(got.work[0].company, 'Acme Fab');
  assert.equal(got.work[0].location, 'Austin, Texas');
  assert.equal(got.work[0].desc, 'Designed an inspection fixture.');
  assert.equal(got.work[0].current, false);
  assert.equal(got.work[0].from, '05/2026');
  assert.equal(got.work[0].to, '08/2026');
  assert.equal(got.work[1].company, 'Test University');
  assert.equal(got.work[1].current, true, 'no end date → I currently work here');
  assert.equal(got.work[1].to, '/', 'and no end date is typed for an ongoing role');
  assert.equal(got.edu.length, 1);
  assert.equal(got.edu[0].school, 'Lakeside University');
  assert.equal(got.edu[0].field, 'Mechanical Engineering');
  assert.equal(got.websiteAdded, undefined, 'a section the profile has nothing for is never touched');
  assert.ok(result.filled >= 12, `counts what landed (${result.filled})`);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.unanswered, []);
});

test('F-553: WORKDAY WEBSITES — Add is pressed and the portfolio goes in the URL box', async () => {
  // "does not input portfolio link in additional website section" (2026-09-24).
  const html = MY_EXPERIENCE.replace(
    '<button type="button" data-automation-id="Add" onclick="window.__websiteAdded = 1">Add</button>',
    '<div id="web-panels"></div><button type="button" data-automation-id="Add" onclick="window.__websiteAdded = 1; const d = document.createElement(\'div\'); d.setAttribute(\'data-automation-id\', \'formField-url\'); d.innerHTML = \'<label>URL</label><input>\'; document.getElementById(\'web-panels\').append(d);">Add</button>');
  const result = await fill(html, { editPlan: `(plan) => { const s = (plan.entries || []); s.push({ kind: 'website', entries: [{ url: 'alexrivera.example' }] }); plan.entries = s; return plan; }` });
  const got = await page.evaluate(() => ({
    added: window.__websiteAdded,
    url: document.querySelector('[data-automation-id="formField-url"] input')?.value || '',
  }));
  const reported = await page.evaluate(() => (globalThis.__sentMsgs || []).filter((m) => m.type === 'plan').flatMap((m) => (m.sections || []).map((s) => s.kind)));
  assert.ok(reported.includes('website'), `the page reports the Websites section to the planner: ${reported.join(', ')}`);
  assert.equal(got.added, 1, 'Add under Websites was pressed');
  assert.equal(got.url, 'alexrivera.example', 'and the portfolio is in the URL box, bare domain');
  assert.equal(result.unanswered.some((u) => /Website/.test(u)), false);
});

test('a My Experience section that already holds an entry is left exactly as it is', async () => {
  const result = await fill(MY_EXPERIENCE.replace('addWork();   // the blank panel Workday pre-creates',
    "addWork(); document.querySelector('[data-automation-id=\"formField-jobTitle\"] input').value = 'Something he typed';"));
  const got = await page.evaluate(() => ({
    panels: document.querySelectorAll('#work-panels .panel').length,
    title: document.querySelector('[data-automation-id="formField-jobTitle"] input').value,
    edu: document.querySelectorAll('#edu-panels > div').length,
  }));
  assert.equal(got.panels, 1, 'nothing added on top of his history');
  assert.equal(got.title, 'Something he typed');
  assert.equal(got.edu, 1, 'the empty Education section is still filled');
  assert.ok(result.filled >= 2);
});

test('THE COOKIE BANNER IS ACCEPTED before anything is filled — "press consent on everything" (2026-10-03)', async () => {
  // Stryker's banner hid the posting on 2026-09-03 and had to be declined by
  // hand. The most private choice, always; "Manage" opens a pane and is never
  // the pick; a form that merely mentions cookies is not a banner.
  const result = await fill(`
    <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px">
      By clicking “Accept All Cookies”, you agree to the storing of cookies on your device.
      <button onclick="window.__accepted = (window.__accepted || 0) + 1; document.getElementById('onetrust-banner-sdk').remove()">Accept All Cookies</button>
      <button onclick="window.__managed = 1">Manage Cookies</button>
      <button onclick="window.__declined = 1">Decline All</button>
    </div>
    <label for="a">First Name</label><input id="a">`);
  assert.equal(result.filled, 1, 'the form still fills');
  const flags = await page.evaluate(() => ({ a: window.__accepted, m: window.__managed, d: window.__declined }));
  assert.equal(flags.a, 1, 'Accept All was pressed once');
  assert.equal(flags.d, undefined, 'Decline was never touched');
  assert.equal(flags.m, undefined, 'and neither was Manage');
});

test('a form that talks about cookies is not a banner', async () => {
  const result = await fill(`
    <form style="position:fixed;top:0">
      <p>We use cookies to keep you signed in.</p>
      <label for="a">First Name</label><input id="a">
      <button type="button" onclick="window.__clicked = 1">Close</button>
    </form>`);
  assert.equal(result.filled, 1);
  assert.equal(await page.evaluate(() => window.__clicked), undefined, 'nothing inside a form is pressed as a banner button');
});

test('A PLAN THAT COULD NOT BE FETCHED IS THE STOP REASON, on the panel', async () => {
  // Measured on Lam with the dashboard down: a full form, 0 filled, and a
  // panel reading "this page is not a multi-step application" — the only
  // trace of the real reason was a console line.
  const why = 'the Jarvis dashboard is not running — start it with npm run jarvis:serve';
  const result = await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Email</label><input id="b">`, { planError: why });
  assert.equal(result.filled, 0);
  assert.equal(result.error, why, 'the error travels to the worker');
  assert.match(result.stoppedBecause, /nothing filled — the Jarvis dashboard is not running/);
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.textContent || '');
  assert.match(panel, /dashboard is not running/, 'and he reads it on the page');
  assert.doesNotMatch(panel, /not a multi-step application/);
});

test('a Greenhouse form fills, and the resume lands in the RESUME slot', async () => {
  const result = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <label for="last_name">Last Name</label><input id="last_name" type="text">
      <label for="email">Email</label><input id="email" type="text">
      <div><h3>Resume</h3><label for="resume">Attach</label><input id="resume" type="file" class="visually-hidden" style="display:none"></div>
      <div><h3>Cover Letter</h3><label for="cover_letter">Attach</label><input id="cover_letter" type="file" style="display:none"></div>
      <input aria-hidden="true" class="requiredInput">
    </form>`);

  assert.equal(result.filled, 3, 'name, name, email');
  assert.equal(result.uploaded, true, 'the resume must actually attach');

  const state = await page.evaluate(() => ({
    first: document.getElementById('first_name').value,
    email: document.getElementById('email').value,
    resumeFiles: [...document.getElementById('resume').files].map((f) => f.name),
    coverFiles: [...document.getElementById('cover_letter').files].map((f) => f.name),
  }));
  assert.equal(state.first, 'Alex');
  assert.equal(state.email, 'v@example.test');
  assert.deepEqual(state.resumeFiles, ['Alex Rivera Resume.pdf']);
  assert.deepEqual(state.coverFiles, [], 'his resume must never end up in the cover-letter slot');
});

/**
 * F-470: "MY NAME IS FILLED IN BUT THE FORM DOES NOT DETECT IT."
 *
 * Alex, 2026-09-15: he had to delete a letter and retype it before the form
 * registered his name. The fixture is the shape of the forms that do this: a
 * form state that only hears REAL input events (a script's `new Event('input')`
 * is `isTrusted: false`), commits a field to its state on blur, and — like a
 * controlled input — puts its own value back into the box on the next frame.
 * A box that merely shows the text is not an answer; the STATE is.
 */
test('A NAME IS TYPED INTO A STRICT FORM, not just placed in the box — the form\'s own state holds it', async () => {
  const result = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <label for="last_name">Last Name</label><input id="last_name" type="text">
      <label for="email">Email</label><input id="email" type="email">
    </form>
    <script>(() => {
      window.__state = { first_name: '', last_name: '', email: '' };
      const draft = {};
      for (const id of Object.keys(window.__state)) {
        const el = document.getElementById(id);
        // Only a real edit updates the draft — the way a framework ignores
        // what it did not see typed.
        el.addEventListener('input', (e) => { if (e.isTrusted) draft[id] = el.value; });
        // The field is committed when he leaves it.
        el.addEventListener('blur', () => { if (id in draft) window.__state[id] = draft[id]; });
        // A controlled input: whatever the state says is what the box shows.
        el.addEventListener('input', () => requestAnimationFrame(() => {
          if (!(id in draft)) el.value = window.__state[id];
        }));
      }
    })();</script>`);

  const state = await page.evaluate(() => ({ ...window.__state, box: document.getElementById('first_name').value }));
  assert.equal(state.first_name, 'Alex', 'the form itself registered the first name');
  assert.equal(state.last_name, 'Rivera');
  assert.equal(state.email, 'v@example.test', 'an email box takes typed text too');
  assert.equal(state.box, 'Alex');
  assert.equal(result.filled, 3, 'and only what the form kept is counted');
});

/**
 * F-470 AGAIN, IN THE CASE ITS OWN FIX MISSED: THE WINDOW IS NOT IN FRONT.
 *
 * Measured in his real Chrome on a strict fixture, 2026-09-17. When
 * `document.hasFocus()` is false — the background-tab case of F-464, and the
 * ordinary case while he works in another window — `el.blur()` moves
 * `activeElement` away and dispatches NO blur and NO focusout. The old
 * `leave()` called blur() and returned, so a form that commits on blur heard
 * nothing: the name sat in the box, the form state stayed empty, the "required"
 * error stayed up, and `kept` came back true because `el.value` still read it.
 *
 * The test above cannot catch this, because a Playwright page IS focused. So
 * this one reproduces what the browser does instead: `hasFocus()` false, and a
 * `blur()` that moves focus silently.
 */
test('WITH THE WINDOW NOT IN FRONT, a blur-commit form still registers the name', async () => {
  await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
    </form>
    <script>(() => {
      // What the browser really does when the document has no focus.
      document.hasFocus = () => false;
      HTMLElement.prototype.blur = function () {
        // activeElement moves; no blur or focusout is dispatched.
        const a = this.ownerDocument.activeElement;
        if (a === this) this.ownerDocument.documentElement.focus?.();
      };
      window.__state = { first_name: '' };
      let draft = null;
      const el = document.getElementById('first_name');
      el.addEventListener('input', (e) => { if (e.isTrusted) draft = el.value; });
      el.addEventListener('blur', () => { if (draft !== null) window.__state.first_name = draft; });
    })();</script>`);

  const state = await page.evaluate(() => ({ ...window.__state, box: document.getElementById('first_name').value }));
  assert.equal(state.box, 'Alex', 'the box shows it');
  assert.equal(state.first_name, 'Alex',
    'and the FORM holds it — without this, every Workday text field filled behind another window is silently empty');
});

/**
 * F-465: EVERY RUN SAYS WHERE ITS TIME WENT.
 *
 * Micron's form is long and he says it struggles. The four places a long form
 * can spend a minute — the written answers, the resume, the prompt widgets and
 * the experience entries — are counted and printed with the done line, so the
 * next slow form names its own bottleneck instead of being guessed at. Read
 * off the page's real console, because a number nobody can see is not a
 * measurement.
 */
test('the run prints where its time went', async () => {
  const lines = [];
  const listen = (m) => lines.push(m.text());
  page.on('console', listen);
  try {
    await fill(`
      <form>
        <label for="first_name">First Name</label><input id="first_name" type="text">
        <label for="email">Email</label><input id="email" type="text">
      </form>`);
  } finally { page.off('console', listen); }
  const line = lines.find((t) => /\[jarvis\] time:/.test(t));
  assert.ok(line, `the timing line is printed, got: ${lines.slice(-4).join(' | ')}`);
  assert.match(line, /total/);
  assert.match(line, /answers \d+\.\ds/);
  assert.match(line, /resume \d+\.\ds/);
  assert.match(line, /dropdowns \d+\.\ds/);
  assert.match(line, /experience\/education \d+\.\ds/);
});

/**
 * F-465: AN UPLOADER THAT ONLY LISTENS FOR A DROP.
 *
 * Micron's Eightfold form, and his report: *"for micron the extension fails to
 * attach resume after it is done."* The site draws its own uploader around a
 * hidden input and binds its handler to the DROP ZONE, so setting
 * `input.files` and firing `change` puts the file in the DOM and tells the
 * application nothing. The old code called that an upload.
 *
 * The fixture is that uploader: `change` on the input is ignored, and only a
 * real `drop` on the zone makes it print the filename — which is the only
 * evidence a reader ever gets that the file landed.
 */
test('HONDA\'S UPLOADER (Phenom, 2026-10-03): the file is taken when its hidden resumeName fills, and Additional Attachments gets nothing', async () => {
  const result = await fill(`
    <div class="resume-upload-wrapper"><div>* Make completing your job application easier by uploading your resume or CV.</div>
      <input type="file" id="phenomResume" tabindex="-1" style="display: none;">
      <button type="button" class="upload-resume-btn btn primary-button">Upload Resume</button></div>
    <form class="rjsf">
      <label class="file-label"><span class="title-text">Additional Attachments</span><input type="file" id="extra" style="display: none;"></label>
      <label for="firstName">First Name</label><input id="firstName" type="text">
      <label for="email">Email</label><input id="email" type="text">
      <input type="hidden" id="resumeName" value=""><input type="hidden" id="resumePath" value="">
    </form>
    <script>
      document.getElementById('phenomResume').addEventListener('change', (e) => setTimeout(() => {
        const f = e.target.files[0];
        document.getElementById('resumeName').value = f.name;
        document.getElementById('resumePath').value = 'AHMAHMUS/resumes/' + f.name;
      }, 600));
    <\/script>`);
  assert.equal(result.uploaded, true);
  assert.equal((result.unanswered || []).some((u) => /never showed the file/.test(u)), false, 'Honda kept it, so nothing to warn about');
  assert.equal(await page.evaluate(() => document.getElementById('extra').files.length), 0, 'no second copy in Additional Attachments');
});

test('F-911: a slot whose input is empty but whose chip already names a file is not attached to again', async () => {
  // Oracle (Oceaneering, 2026-10-24): the input is cleared after each upload and
  // the file shown as a chip; seven follow-along runs left seven copies.
  const result = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <div class="attachments">
        <h3>Resume</h3><label for="resume">Upload Resume</label>
        <input id="resume" type="file" style="display:none">
        <ul><li><button type="button" aria-label="Alex Rivera - Oceaneering - Mechanical Engineer.pdf Remove">Alex Rivera - Oceaneering - Mechanical Engineer.pdf</button></li></ul>
      </div>
      <div class="cover">
        <h3>Cover Letter</h3><p>Accepted formats: .pdf, .docx</p><label for="cl">Upload Cover Letter</label>
        <input id="cl" type="file" style="display:none">
      </div>
      <script>document.getElementById('resume').addEventListener('change', () => { window.__again = (window.__again || 0) + 1; });<\/script>
    </form>`);
  assert.equal(await page.evaluate(() => window.__again || 0), 0, 'the resume shown in the chip is not attached a second time');
  assert.equal(result.uploaded, true, 'and the run still counts the resume as on the form');
});

test('F-989: a form that redraws while the resume is written still gets it, in the slot as it is now (Re:Build)', async () => {
  // The press began the build; the filler waited; Greenhouse's form redrew
  // and replaced the file input. The first press attached into the old one.
  const html = `
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
    </form>
    <script>
      window.__resume425 = 1;   // the server is still writing it on the first ask
      setTimeout(() => {
        const old = document.getElementById('resume');
        const fresh = document.createElement('input');
        fresh.type = 'file'; fresh.id = 'resume'; fresh.name = 'resume';
        old.replaceWith(fresh);
      }, 1500);
    </script>`;
  const result = await fill(html);
  const files = await page.evaluate(() => document.getElementById('resume').files.length);
  assert.equal(files, 1, `the resume is in the slot on the page (${JSON.stringify(result.unanswered)})`);
  assert.equal(result.uploaded, true);
  assert.ok(!(result.unanswered || []).some((u) => /never showed the file|did not keep the file/.test(String(u.label || u))), JSON.stringify(result.unanswered));
});

// A resume slot that a parser redraws after the file goes on (Rippling, F-1009):
// `times` is how many attaches it throws away, by replacing the input with an
// empty one 300 ms after each change.
const DROPPING_SLOT = (times) => `
  <form>
    <label for="first_name">First Name</label><input id="first_name" type="text">
    <label for="resume">Resume</label><input id="resume" name="resume" type="file">
  </form>
  <script>
    window.__attaches = 0;
    let left = ${times};
    const watch = (el) => el.addEventListener('change', () => {
      window.__attaches += 1;
      if (left <= 0) return;
      left -= 1;
      setTimeout(() => {
        const fresh = document.createElement('input');
        fresh.type = 'file'; fresh.id = 'resume'; fresh.name = 'resume';
        document.getElementById('resume').replaceWith(fresh);
        watch(fresh);
      }, 300);
    });
    watch(document.getElementById('resume'));
  </script>`;

test('F-1009: a resume the page drops after the attach is attached again, and counted only when it stays (Rippling)', async () => {
  const once = await fill(DROPPING_SLOT(1));
  assert.equal(await page.evaluate(() => document.getElementById('resume').files.length), 1, `the file is back in the slot (${JSON.stringify(once.unanswered)})`);
  assert.equal(await page.evaluate(() => window.__attaches), 2, 'attached twice: once, and once after the redraw');
  assert.equal(once.uploaded, true);
  assert.ok(!(once.unanswered || []).some((u) => /dropped it/.test(String(u.label || u))), JSON.stringify(once.unanswered));

  const always = await fill(DROPPING_SLOT(9));
  assert.equal(always.uploaded, false, 'a slot that stays empty is not "uploaded"');
  assert.ok((always.unanswered || []).some((u) => /attached, then the page dropped it/.test(String(u.label || u))), JSON.stringify(always.unanswered));
  assert.equal(await page.evaluate(() => window.__attaches), 2, 'one second try, never a loop');

  const kept = await fill(DROPPING_SLOT(0));
  assert.equal(kept.uploaded, true);
  assert.equal(await page.evaluate(() => window.__attaches), 1, 'a slot that kept the file gets no second copy (F-413)');
});

test('F-1013 #7: his COVER LETTER\'S chip on the page is not his resume — an emptied resume slot is attached again and never reported uploaded', async () => {
  const withLetter = DROPPING_SLOT(9).replace('</form>', '<div class="chip">Alex Rivera - Acme - Process Engineer - cover letter.pdf</div><div class="chip">Alex Rivera Portfolio.pdf</div></form>');
  const r = await fill(withLetter);
  assert.equal(r.uploaded, false, 'the letter\'s chip does not stand for the resume');
  assert.equal(await page.evaluate(() => window.__attaches), 2, 'the resume was looked for, missed, and attached once more');
  assert.ok((r.unanswered || []).some((u) => /attached, then the page dropped it/.test(String(u.label || u))), JSON.stringify(r.unanswered));
});

test('F-1002: a Submit pressed by a tool (not a trusted click) is watched, and the thank-you is reported (Ashby, Medra)', async () => {
  // Ashby keeps the URL and swaps the form for its confirmation after the press.
  const html = `<div id="app"><form onsubmit="return false">
    <label for="first_name">First Name</label><input id="first_name" type="text">
    <button type="button" id="send">Submit Application</button>
  </form></div>
  <script>
    document.getElementById('send').addEventListener('click', () => setTimeout(() => {
      document.getElementById('app').innerHTML = '<h2>Thank you for applying</h2><p>Your application was successfully submitted.</p>';
    }, 300));
  </script>`;
  await fillAs(html, { armed: false, auto: false, reachable: true });
  await page.evaluate(() => { globalThis.__sent.length = 0; document.getElementById('send').click(); });   // untrusted, as a tool's press can be
  await page.waitForFunction(() => globalThis.__sent.some((m) => m.type === 'filled' && m.result?.submitted), null, { timeout: 8000 });
  const said = await page.evaluate(() => globalThis.__sent.find((m) => m.type === 'filled' && m.result?.submitted).result.submitted);
  assert.match(said, /thank you for applying|successfully submitted/i);
});

test('F-994 review: once a newer run claims the page, the old one types nothing more — one fill on the form', async () => {
  // The worker took over a run it thought stalled; the old script is still here.
  // A newer run claims the page as soon as the first field is typed.
  const html = `<form>
    <label for="first_name">First Name</label><input id="first_name" type="text">
    <label for="last_name">Last Name</label><input id="last_name" type="text">
    <label for="email">Email</label><input id="email" type="email">
  </form>
  <script>
    document.getElementById('first_name').addEventListener('input', () => { globalThis.__jarvisActiveRun = 'the-newer-run'; });
  </script>`;
  const r = await fillAs(html, { armed: false, auto: false, runToken: 'the-old-run' });
  const typed = await page.evaluate(() => ['first_name', 'last_name', 'email'].map((id) => document.getElementById(id).value));
  assert.notEqual(typed[0], '', 'it had typed the first field');
  assert.deepEqual(typed.slice(1), ['', ''], 'and nothing after the newer run claimed the page');
  assert.ok((r.unanswered || []).some((u) => /a newer run took over/.test(String(u.label || u))), JSON.stringify(r.unanswered));
});

test('F-1002: a check-only run on a page with a form fills nothing (the look at a confirmation page)', async () => {
  const html = `<form><label for="first_name">First Name</label><input id="first_name" type="text"></form>`;
  const r = await fillAs(html, { armed: false, auto: true, checkOnly: true });
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), '');
  assert.equal(r.checkOnly, true);
  assert.equal(r.filled, 0);
});

test('F-990: a run that began armed stops once he disarms the tab; one still armed fills as before (Re:Build)', async () => {
  const html = `<form>
    <label for="first_name">First Name</label><input id="first_name" type="text">
    <label for="last_name">Last Name</label><input id="last_name" type="text">
  </form>`;
  const stopped = await fillAs(html, { armed: true, auto: false, stillArmed: false });
  const typed = await page.evaluate(() => [document.getElementById('first_name').value, document.getElementById('last_name').value]);
  assert.deepEqual(typed, ['', ''], 'nothing more goes on the form');
  assert.ok((stopped.unanswered || []).some((u) => /you disarmed this tab/.test(String(u.label || u))), JSON.stringify(stopped.unanswered));
  const goes = await fillAs(html, { armed: true, auto: false, stillArmed: true });
  const typed2 = await page.evaluate(() => document.getElementById('first_name').value);
  assert.notEqual(typed2, '', 'still armed: it fills');
  assert.ok(!(goes.unanswered || []).some((u) => /disarmed/.test(String(u.label || u))));
});

test('F-913: a file left from an earlier application is removed once, and this posting\'s file goes on', async () => {
  // onsemi (Oracle, 2026-10-24): the account put "AlexRiveraResume.pdf" from an
  // earlier onsemi application back in the resume slot.
  const html = `
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <div class="attachments">
        <h3>Resume</h3><label for="resume">Upload Resume</label>
        <input id="resume" type="file" style="display:none">
        <ul id="chips"><li><button type="button">AlexRiveraResume.pdf</button><button type="button" aria-label="Remove">x</button></li></ul>
      </div>
      <script>
        document.querySelector('[aria-label="Remove"]').addEventListener('click', (e) => e.target.closest('li').remove());
        document.getElementById('resume').addEventListener('change', (e) => {
          window.__put = (window.__put || 0) + 1;
          document.getElementById('chips').innerHTML = '<li><button type="button">' + e.target.files[0].name + '</button><button type="button" aria-label="Remove">x</button></li>';
          e.target.value = '';
        });
      <\/script>
    </form>`;
  const result = await fill(html, { url: 'https://careers.example.test/apply' });
  const after = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips').textContent }));
  assert.equal(after.put, 1, 'this posting\'s resume was attached');
  assert.equal(/AlexRiveraResume/.test(after.chips), false, 'the earlier application\'s file is gone');
  assert.equal(result.uploaded, true);

  assert.equal(/Alex Rivera Resume\.pdf/.test(after.chips), true, 'and the slot now shows the tailored one');
  // Later runs in this tab keep whatever is in the slot (F-413): the check is once per tab.
  assert.equal(await page.evaluate(() => sessionStorage.getItem('jv-earlier-files-checked')), '1');
});

test('F-916: a Jarvis file naming ANOTHER posting at this employer is removed; one naming this posting stays', async () => {
  const html = (chipName) => `
    <title>Production Engineer - Coherent Corp. US Careers</title>
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <div class="attachments">
        <h3>Resume</h3><label for="resume">Upload Resume</label>
        <input id="resume" type="file" style="display:none">
        <ul id="chips"><li><button type="button">${chipName}</button><div><button type="button" aria-label="Remove Resume">Remove</button></div></li></ul>
      </div>
      <script>
        document.querySelector('[aria-label="Remove Resume"]').addEventListener('click', (e) => e.target.closest('li').remove());
        document.getElementById('resume').addEventListener('change', () => { window.__put = (window.__put || 0) + 1; });
      <\/script>
    </form>`;
  await fill(html('Alex Rivera - Coherent Corp - Process Engineer - DMG (Diamond Material Growth).pdf'), { url: 'https://f916a.example.test/apply/one' });
  let got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips').textContent }));
  assert.equal(/Process Engineer/.test(got.chips), false, `the other posting's resume is removed: ${JSON.stringify(got)}`);
  assert.equal(got.put, 1, 'and this posting\'s goes on');
  await fill(html('Alex Rivera - Coherent Corp - Production Engineer.pdf'), { url: 'https://f916b.example.test/apply/two' });
  got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips').textContent }));
  assert.equal(/Production Engineer\.pdf/.test(got.chips), true, 'this posting\'s own file stays');
  assert.equal(got.put, 0);
});

test('F-1013 #25: a dropdown resting on "-- Select --" (with a value behind it) is not an answer, and gets his', async () => {
  await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <label for="h">How did you hear about us?</label>
      <select id="h"><option value="0" selected>-- Select --</option><option value="web">Company Website</option><option value="li">LinkedIn</option></select>
    </form>`);
  assert.notEqual(await page.evaluate(() => document.getElementById('h').value), '0', 'the placeholder was not kept as his answer');
});

test('F-1013 #15: a consent box that refuses the click is NOT counted as ticked, and is named for him', async () => {
  const r = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <input type="checkbox" id="agree" onclick="return false"><label for="agree">I agree to the privacy policy and terms of use</label>
    </form>`);
  assert.equal(await page.evaluate(() => document.getElementById('agree').checked), false, 'precondition: the page refused it');
  assert.equal(r.checked || 0, 0, 'nothing is claimed ticked');
  assert.ok((r.unanswered || []).some((u) => /privacy policy/i.test(String(u.label || u)) && /did not keep the tick/.test(String(u.label || u))), JSON.stringify(r.unanswered));
});

test('F-1013 #14: an earlier file whose role only STARTS this posting\'s, or whose employer has a hyphen, is removed too', async () => {
  const html = (title, chipName) => `
    <title>${title}</title>
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <div class="attachments">
        <h3>Resume</h3><label for="resume">Upload Resume</label>
        <input id="resume" type="file" style="display:none">
        <ul id="chips"><li><button type="button">${chipName}</button><div><button type="button" aria-label="Remove Resume">Remove</button></div></li></ul>
      </div>
      <script>
        document.querySelector('[aria-label="Remove Resume"]').addEventListener('click', (e) => e.target.closest('li').remove());
        document.getElementById('resume').addEventListener('change', () => { window.__put = (window.__put || 0) + 1; });
      <\/script>
    </form>`;
  await fill(html('Process Engineer II - Coherent Corp. US Careers', 'Alex Rivera - Coherent Corp - Process Engineer.pdf'), { url: 'https://f1013a.example.test/apply/one' });
  let got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips').textContent }));
  assert.equal(/Process Engineer\.pdf/.test(got.chips), false, `"Process Engineer" is not "Process Engineer II": ${JSON.stringify(got)}`);
  assert.equal(got.put, 1);
  await fill(html('Mechanical Engineer - Rolls-Royce Careers', 'Alex Rivera - Rolls-Royce - Test Engineer.pdf'), { url: 'https://f1013b.example.test/apply/two' });
  got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips').textContent }));
  assert.equal(/Test Engineer\.pdf/.test(got.chips), false, 'a hyphenated employer no longer hides the role');
  await fill(html('Mechanical Engineer - Rolls-Royce Careers', 'Alex Rivera - Rolls-Royce - Mechanical Engineer.pdf'), { url: 'https://f1013c.example.test/apply/three' });
  got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips').textContent }));
  assert.equal(/Mechanical Engineer\.pdf/.test(got.chips), true, 'this posting\'s own file stays');
});

test('F-942: a Jarvis file for ANOTHER posting that shows up after the first look is removed and this posting\'s file goes on; his own file stays', async () => {
  const html = (chipName) => `
    <title>Careers at Cummins</title>
    <h1>Product Engineer</h1>
    <script>try { sessionStorage.setItem('jv-earlier-files-checked', '1'); } catch {}<\/script>
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <div class="attachments">
        <h3>Resume</h3><label for="resume">Upload Resume</label>
        <input id="resume" type="file" style="display:none">
        <ul id="chips"><li><button type="button">${chipName}</button><div><button type="button" aria-label="Remove Resume">Remove</button></div></li></ul>
      </div>
      <script>
        document.querySelector('[aria-label="Remove Resume"]').addEventListener('click', (e) => e.target.closest('li').remove());
        document.getElementById('resume').addEventListener('change', () => { window.__put = (window.__put || 0) + 1; });
      <\/script>
    </form>`;
  const r = await fill(html('Alex Rivera - Cummins Inc. - Design Engineer.pdf'), { url: 'https://f942a.example.test/apply/one' });
  let got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips')?.textContent || '' }));
  assert.equal(/Design Engineer\.pdf/.test(got.chips), false, `the other posting's file is removed: ${JSON.stringify(got)}`);
  assert.equal(got.put, 1, 'and this posting\'s resume goes on');
  assert.equal(r.uploaded, true);
  await fill(html('My Resume 2026.pdf'), { url: 'https://f942b.example.test/apply/two' });
  got = await page.evaluate(() => ({ put: window.__put || 0, chips: document.getElementById('chips')?.textContent || '' }));
  assert.equal(/My Resume 2026\.pdf/.test(got.chips), true, 'a file he chose himself stays (F-413)');
  assert.equal(got.put, 0, '…and nothing is put on top of it');
});

test('F-1017 (1): a street-address box that suggests takes the one row for his street, and keeps it (Lam on Eightfold)', async () => {
  // The box spells the street its own way and DROPS what was typed when its
  // list closes without a pick, the way Lam's Eightfold address box did.
  const box = (rows) => `
    <form>
      <label for="addr">Address Line 1</label>
      <input id="addr" type="text" aria-controls="addr-list" autocomplete="off">
      <ul id="addr-list" role="listbox" style="display:none"></ul>
      <script>
        const input = document.getElementById('addr'), list = document.getElementById('addr-list');
        let chosen = false;
        input.addEventListener('input', () => {
          chosen = false;
          list.innerHTML = ${JSON.stringify(rows)}.map((r) => '<li role="option">' + r + '</li>').join('');
          list.style.display = input.value ? 'block' : 'none';
        });
        list.addEventListener('mousedown', (e) => e.preventDefault());
        list.addEventListener('click', (e) => {
          const li = e.target.closest('[role="option"]'); if (!li) return;
          input.value = li.textContent; chosen = true; list.style.display = 'none';
        });
        input.addEventListener('blur', () => setTimeout(() => { if (!chosen) input.value = ''; list.style.display = 'none'; }, 50));
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { list.style.display = 'none'; if (!chosen) input.value = ''; } });
      <\/script>
    </form>`;
  const one = await fill(box(['1 Test Street, Springfield, WA, USA', '1 Testa Ave, Boston, MA, USA']));
  const kept = await page.evaluate(() => document.getElementById('addr').value);
  assert.equal(kept, '1 Test Street, Springfield, WA, USA', `the row for his street is taken and kept: ${JSON.stringify(one.unanswered)}`);
  assert.ok(!(one.unanswered || []).some((u) => /Address Line 1/.test(String(u.label || u))), 'and it is not reported lost');
  // Two rows for the same street: a choice he makes, said out loud, never a guess.
  const two = await fill(box(['1 Test Street, Springfield, WA, USA', '1 Test Street, Seattle, WA, USA']));
  assert.ok((two.unanswered || []).some((u) => /Address Line 1/.test(String(u.label || u))), `two candidate rows are left for him: ${JSON.stringify(two.unanswered)}`);
});

test('F-1017 (1) review: a street box with no suggestion list is still LEFT, so a form that commits on blur gets the address', async () => {
  // Workday commits a text box when it hears blur/focusout; the stayed-in
  // address box must still be left after its (empty) suggestion look.
  await fill(`
    <form>
      <label for="street">Street Address</label><input id="street" type="text">
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <script>
        const s = document.getElementById('street');
        const commit = () => { s.dataset.committed = s.value; };
        s.addEventListener('blur', commit); s.addEventListener('focusout', commit);
      <\/script>
    </form>`);
  assert.equal(await page.evaluate(() => document.getElementById('street').dataset.committed || ''), '1 Test St', 'the box heard it was left, with his address in it');
});

test('F-1017 (3): his press on an Eightfold job page with no Apply control opens /careers/apply?pid=… directly', async () => {
  const job = 'https://careers.f1017.example.test/careers/job/790300845183-mechatronics-engineer-2?domain=lamresearch.com';
  const form = 'https://careers.f1017.example.test/careers/apply**';
  await page.unroute(job).catch(() => {});
  await page.route(job, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Mechatronics Engineer 2 | Lam Research</title><h1>Mechatronics Engineer 2</h1><p>Design and validate mechatronic subsystems.</p>' }));
  await page.route(form, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Apply</title><p>apply form</p>' }));
  await page.goto(job);
  // This test loads the ATS table the extension injects before content.js.
  await page.addScriptTag({ content: readFileSync(path.join(HERE, 'ats.js'), 'utf-8') });
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate(() => {
    globalThis.__jarvisRun = { armed: false, auto: false };
    globalThis.__sent = [];
    globalThis.chrome = { runtime: { sendMessage: async (msg, reply) => { globalThis.__sent.push(msg.type); reply({ ok: true }); } } };
  });
  await Promise.all([page.waitForURL(/\/careers\/apply\?pid=790300845183&domain=lamresearch\.com/, { timeout: 15000 }), page.evaluate(CONTENT).catch(() => null)]);
  assert.match(page.url(), /\/careers\/apply\?pid=790300845183&domain=lamresearch\.com$/);
  await page.unroute(form).catch(() => {});
});

test('F-1013 #14 review: a heading that adds a requisition or a place keeps this posting\'s own file', async () => {
  const html = (heading, chipName) => `
    <title>Careers at Micron</title>
    <h1>${heading}</h1>
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <div class="attachments">
        <h3>Resume</h3><label for="resume">Upload Resume</label>
        <input id="resume" type="file" style="display:none">
        <ul id="chips"><li><button type="button">${chipName}</button><div><button type="button" aria-label="Remove Resume">Remove</button></div></li></ul>
      </div>
      <script>
        document.querySelector('[aria-label="Remove Resume"]').addEventListener('click', (e) => e.target.closest('li').remove());
      <\/script>
    </form>`;
  await fill(html('Process Engineer (R-1234)', 'Alex Rivera - Micron - Process Engineer.pdf'), { url: 'https://f1013d.example.test/apply/four' });
  let chips = await page.evaluate(() => document.getElementById('chips').textContent);
  assert.equal(/Process Engineer\.pdf/.test(chips), true, `a requisition after the role is the same role: ${chips}`);
  await fill(html('Process Engineer - Boise, ID', 'Alex Rivera - Micron - Process Engineer.pdf'), { url: 'https://f1013e.example.test/apply/five' });
  chips = await page.evaluate(() => document.getElementById('chips').textContent);
  assert.equal(/Process Engineer\.pdf/.test(chips), true, 'so is a place');
  await fill(html('Process Engineer Intern', 'Alex Rivera - Micron - Process Engineer.pdf'), { url: 'https://f1013f.example.test/apply/six' });
  chips = await page.evaluate(() => document.getElementById('chips').textContent);
  assert.equal(/Process Engineer\.pdf/.test(chips), false, 'an internship is another posting');
  await fill(html('Process Engineer - 2027 University Graduate', 'Alex Rivera - Micron - Process Engineer.pdf'), { url: 'https://f1013g.example.test/apply/seven' });
  chips = await page.evaluate(() => document.getElementById('chips').textContent);
  assert.equal(/Process Engineer\.pdf/.test(chips), false, 'a graduate program is another posting');
});

test('a drop-zone uploader gets the file dropped on it, and says so', async () => {
  const result = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <label for="email">Email</label><input id="email" type="text">
      <div id="zone" class="upload-dropzone">
        <h3>Resume</h3><label for="resume">Attach</label>
        <input id="resume" type="file" style="display:none">
        <div id="chip"></div>
      </div>
      <script>(() => {
        const zone = document.getElementById('zone');
        // The input's own change event is deliberately ignored — this is the
        // uploader that broke it.
        zone.addEventListener('dragover', (e) => e.preventDefault());
        zone.addEventListener('drop', (e) => {
          e.preventDefault();
          const f = e.dataTransfer?.files?.[0];
          if (f) document.getElementById('chip').textContent = f.name;
        });
      })();<\/script>
    </form>`);

  assert.equal(result.uploaded, true, 'the resume attached');
  const state = await page.evaluate(() => ({
    chip: document.getElementById('chip').textContent,
    files: [...document.getElementById('resume').files].map((f) => f.name),
  }));
  assert.equal(state.chip, 'Alex Rivera Resume.pdf', 'the page itself shows the file — the drop reached the zone');
  assert.deepEqual(state.files, ['Alex Rivera Resume.pdf'], 'and the input holds it too');
  assert.equal(
    (result.unanswered || []).some((u) => /never showed the file/.test(u)), false,
    'nothing to warn about once the page has shown it',
  );
});

/**
 * …AND WHEN NOTHING TAKES IT, HE IS TOLD. The same hidden-input uploader with
 * no handler at all: the file is on the field and the page never acknowledges
 * it. That is not an upload to report as done — it is a line on his list.
 */
test('a hidden uploader that never shows the file is reported, not ticked off', async () => {
  const result = await fill(`
    <form>
      <label for="first_name">First Name</label><input id="first_name" type="text">
      <label for="email">Email</label><input id="email" type="text">
      <div><h3>Resume</h3><label for="resume">Attach</label><input id="resume" type="file" style="display:none"></div>
    </form>`);
  assert.ok(
    (result.unanswered || []).some((u) => /never showed the file/.test(u)),
    `he is told to check it, got: ${JSON.stringify(result.unanswered)}`,
  );
  // …and the uploader's markup reaches his dashboard, without his values (F-655).
  const caps = await page.evaluate(() => globalThis.__sentMsgs.filter((m) => m.type === 'capture'));
  assert.ok(caps.some((c) => /did not show/.test(c.why)), `a capture after the failed upload: ${JSON.stringify(caps.map((c) => c.why))}`);
  assert.ok(caps.every((c) => /id="resume"/.test(c.html) && !/alex|@/i.test(c.html)), 'the markup, no values');
});

/**
 * A PRIVACY DIALOG THAT HOLDS THE FILE (Applied Materials' Eightfold form,
 * 2026-09-27, F-623). Choosing the file raises "Data Privacy Agreement" —
 * Cancel / Confirm, both type="submit", in a dialog outside the form — and the
 * file goes nowhere until Confirm. A Confirm in a dialog about SUBMITTING is
 * never pressed.
 */
const PRIVACY_DIALOG = (body) => `
  <form>
    <label for="first_name">First Name</label><input id="first_name" type="text">
    <label for="email">Email</label><input id="email" type="text">
    <div><h3>Resume</h3><label for="resume">Upload your resume</label><input id="resume" type="file" style="display:none"><div id="chip"></div></div>
  </form>
  <div id="dlg" role="dialog" aria-modal="true" style="display:none">
    <span role="heading">Data Privacy Agreement</span>
    <p>${body}</p>
    <button type="submit" id="cancel">Cancel</button><button type="submit" id="confirm">Confirm</button>
  </div>
  <script>(() => {
    let pending = null;
    document.getElementById('resume').addEventListener('change', (e) => { pending = e.target.files[0]; document.getElementById('dlg').style.display = 'block'; });
    document.getElementById('confirm').addEventListener('click', () => { window.__confirmed = 1; document.getElementById('dlg').style.display = 'none'; if (pending) document.getElementById('chip').textContent = pending.name; });
    document.getElementById('cancel').addEventListener('click', () => { window.__cancelled = 1; document.getElementById('dlg').style.display = 'none'; });
  })();<\/script>`;

test('AMAT: a Data Privacy Agreement raised by the file is confirmed, and the file shows (F-623)', async () => {
  const result = await fill(PRIVACY_DIALOG('When you upload your resume, we provide job recommendations to you. Please confirm that you agree to the Applied Materials Data Privacy Policy.'));
  const st = await page.evaluate(() => ({ confirmed: !!window.__confirmed, cancelled: !!window.__cancelled, chip: document.getElementById('chip').textContent }));
  assert.equal(st.confirmed, true, 'Confirm was pressed');
  assert.equal(st.cancelled, false, 'never Cancel');
  assert.equal(st.chip, 'Alex Rivera Resume.pdf');
  assert.equal(result.uploaded, true);
  assert.equal((result.unanswered || []).some((u) => /never showed the file/.test(u)), false);
});

test('a Confirm in a dialog about submitting is never pressed', async () => {
  await fill(PRIVACY_DIALOG('Please confirm you agree to our privacy policy and want to submit your application now.'));
  assert.equal(await page.evaluate(() => !!window.__confirmed), false);
});

test('Swisslog: an Apply that opens another tab leaves the posting page alone — no resume in its box (F-623)', async () => {
  const result = await fill(`
    <form action="/en-us/search-results-page"><input type="search" name="q" aria-label="q"></form>
    <h1>Mechanical Engineer - Swisslog Global</h1>
    <p>Job description text.</p>
    <a href="about:blank" target="_blank" onclick="window.__applied = 1; return false;">APPLY HERE</a>
    <form action="/en-us/careers/openings/mechanical-engineer-4142"><label for="f">Resume/CV</label><input id="f" type="file" name="file"></form>`);
  assert.equal(await page.evaluate(() => !!window.__applied), true, 'Apply was followed');
  assert.equal(result.followedApply, true, JSON.stringify(result));
  assert.equal(await page.evaluate(() => document.getElementById('f').files.length), 0, 'nothing attached to the posting page');
});

test('Ashby, 2026-09-30: an Apply button above the form that changes nothing does not end the run — the form is filled', async () => {
  const result = await fill(`
    <h1>Mechanical Engineer</h1>
    <a href="#" onclick="window.__applied = 1; return false;">Apply</a>
    <form>
      <label for="email">Email</label><input id="email" type="text">
      <div><h3>Resume</h3><label for="resume">Attach</label><input id="resume" type="file" style="display:none"><div id="chip"></div></div>
      <script>document.getElementById('resume').addEventListener('change', (e) => { document.getElementById('chip').textContent = e.target.files[0].name; });<\/script>
    </form>`);
  assert.notEqual(result.followedApply, true, JSON.stringify(result.stoppedBecause));
  assert.equal(await page.evaluate(() => document.getElementById('email').value), 'v@example.test');
});

test('IT WALKS A MULTI-STEP WIZARD and stops before Submit', async () => {
  // Three screens with a Save and Continue between them and Submit at the end —
  // the shape of every Workday application, which is six screens with the resume
  // on the second. Filling only the first screen is why nothing ever attached.
  const result = await fill(`
    <div id="app"></div>
    <script>
      const steps = [
        '<h2>My Information</h2><label for="first_name">First Name</label><input id="first_name">' +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button>',
        '<h2>My Experience</h2><h3>Resume/CV</h3><label for="resume">Upload a file (5MB max)</label>' +
          '<input id="resume" type="file" style="display:none">' +
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
    </script>`);

  assert.equal(result.steps, 3, 'all three screens, not just the first');
  assert.equal(result.uploaded, true, 'the resume is on screen TWO — the whole point');
  assert.match(result.stoppedBecause, /last step before Submit/);

  const after = await page.evaluate(() => ({
    submitted: !!window.__SUBMITTED,
    onScreen: document.querySelector('h2').textContent,
    email: document.getElementById('email')?.value,
  }));
  assert.equal(after.submitted, false, 'SUBMIT IS HIS. Nothing here may press it.');
  assert.equal(after.onScreen, 'Review', 'it walks to the review screen and waits');
  assert.equal(after.email, 'v@example.test', 'and it filled the last screen before stopping');
});

test('it refuses to fill a sign-in or create-account page', async () => {
  const result = await fill(`
    <h2>Create Account</h2>
    <label for="email">Email</label><input id="email" type="text">
    <label for="password">Password</label><input id="password" type="password">
    <label for="verify">Verify New Password</label><input id="verify" type="password">`);
  assert.equal(result.signInRequired, true);
  assert.equal(result.filled, 0);
  const email = await page.evaluate(() => document.getElementById('email').value);
  assert.equal(email, '', 'not even the email — signing up is his');
});

test('it chooses Apply Manually at the Workday start gate', async () => {
  const result = await fill(`
    <div id="app">
      <h2>Start Your Application</h2>
      <a data-automation-id="autofillWithResume" onclick="window.__CHOSE='autofill'">Autofill with Resume</a>
      <a data-automation-id="applyManually" onclick="window.__CHOSE='manual';document.getElementById('form').style.display=''">Apply Manually</a>
    </div>
    <div id="form" style="display:none">
      <label for="first_name">First Name</label><input id="first_name">
    </div>`);
  assert.equal(await page.evaluate(() => window.__CHOSE), 'manual');
  assert.equal(result.filled, 1, 'and then it fills the form the gate was hiding');
});

test('A FORM THAT PAINTS LATE IS WAITED FOR — his press is not answered with "not an application" (F-360)', async () => {
  // SmartRecruiters' shape under load: the document is there, the form
  // arrives ten seconds later. The run used to give up after eight.
  const result = await fill(`
    <h1>Advanced Manufacturing Engineer I</h1>
    <div id="app"></div>
    <script>setTimeout(() => { document.getElementById('app').innerHTML = '<label for="first_name">First Name</label><input id="first_name">'; }, 9500);<\/script>`);
  assert.equal(result.filled, 1, `the late field was filled (stopped: ${result.stoppedBecause})`);
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), 'Alex');
  assert.ok(!/not a multi-step application/.test(result.stoppedBecause), result.stoppedBecause);
});

test('APPLY THAT SWAPS THE PAGE IN PLACE FOR A LATE SIGN-IN PAGE IS WALKED INTO THE WALL, not left as "followed Apply" (F-365)', async () => {
  // Microsoft's Eightfold posting: Apply is a route change; the header keeps
  // its Apply link; the sign-in page paints three seconds later.
  const result = await fill(`
    <main id="main"><h1>Mechanical Engineering Intern</h1><p>Redmond, Washington.</p><a id="apply" data-test-id="apply-button" href="#apply">Apply</a></main>
    <script>
      document.getElementById('apply').addEventListener('click', (e) => { e.preventDefault();
        // (A route change in the real page; about:blank forbids pushState.)
        // The header's Apply link is there at once; the sign-in page paints later.
        document.getElementById('main').innerHTML = '<header><a href="/careers/apply?pid=1">Apply</a></header><div id="late"></div>';
        setTimeout(() => { document.getElementById('late').innerHTML = '<h1>Sign in</h1><p>Select a method below to Sign in.</p><p>Sign in using</p><button>Google</button><button>Microsoft</button>'; }, 3000); });
    <\/script>`);
  assert.equal(result.signInRequired, true, `the wall behind Apply is found: ${result.stoppedBecause}`);
  assert.ok(!result.followedApply, 'not reported as "followed Apply" with nothing seen');
});

test('A FOLLOW-ALONG RUN WAITS FOR A LATE PAGE AND FINDS THE SIGN-IN WALL BEHIND IT (F-365)', async () => {
  // Microsoft's Eightfold apply page: the worker injects on "the page loaded",
  // half a second before the sign-in page paints. The run used to see an
  // empty page, say nothing, and nothing came later to wake it.
  const result = await fillAs(`
    <div id="app"></div>
    <script>setTimeout(() => { document.getElementById('app').innerHTML = '<h1>Sign in</h1><p>Select a method below to Sign in.</p><p>Sign in using</p><button>Google</button><button>Microsoft</button><a href="/careers/apply?pid=1">Apply</a>'; }, 2500);<\/script>`,
    { armed: true, auto: true });
  assert.equal(result.signInRequired, true, `the wall behind the late page is found: ${result.stoppedBecause}`);
  assert.match(result.stoppedBecause, /sign in here/i);
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.querySelector('#jarvis-panel')?.innerText || '');
  assert.match(panel, /Sign in here/);
});

test('A PAGE WITH NO FORM AT ALL SAYS SO — never "not an application" (F-360)', async () => {
  const result = await fill('<h1>Some posting</h1><p>Loading…</p>');
  assert.match(result.stoppedBecause, /no form on this page yet/);
  assert.equal(result.filled, 0);
});

test('A STATE LIST THAT LOADS ONLY ONCE COUNTRY IS CHOSEN is answered on the second pass (Honda, 2026-10-02)', async () => {
  await fill(`
    <form>
      <label for="city">City</label><input id="city">
      <label for="country">Country</label>
      <select id="country"><option value="">Please Select</option><option value="5266"> United Kingdom </option><option value="5270"> United States </option></select>
      <label for="region">State</label>
      <select id="region"><option value="">Please Select</option><option>  </option></select>
    </form>
    <script>
      document.getElementById('country').addEventListener('change', () => setTimeout(() => {
        document.getElementById('region').innerHTML = '<option value="">Please Select</option><option value="OR">Oregon</option><option value="WA">Washington</option>';
      }, 200));
    <\/script>`);
  assert.equal(await page.evaluate(() => document.getElementById('country').selectedOptions[0].textContent.trim()), 'United States');
  assert.equal(await page.evaluate(() => document.getElementById('region').value), 'WA', 'the State filled once its list arrived');
});

test('a stalled step reports the FORM\'S OWN words', async () => {
  const result = await fill(`
    <div>
      <h2>My Experience</h2>
      <label for="a">Something</label><input id="a">
      <div role="alert">Errors Found Error-Upload a file (5MB max) The field Upload a file (5MB max) is required and must have a value. Error Code: VPS|abc</div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>
    </div>`);
  assert.match(result.stoppedBecause, /would not move on/);
  assert.match(result.stoppedBecause, /required and must have a value/);
  assert.ok(!/VPS\|abc/.test(result.stoppedBecause), 'Workday\'s internal error code means nothing to him');
});

test('F-815: Oracle\'s screen-reader announcements are never given as the reason a step stalled', async () => {
  // ekpl / First Solar / Denso, 2026-10-03..16: "the form would not move on:
  // You're all set, Anna Maria Alex! · apply-flow.a11y.dependency-fields-loaded".
  const result = await fill(`
    <div>
      <h2>Contact Information</h2>
      <label for="a">Something</label><input id="a">
      <div role="alert">You're all set, Anna Maria Alex!</div>
      <div role="alert">The form Address form loaded</div>
      <div role="alert">apply-flow.a11y.dependency-fields-loaded</div>
      <div role="alert">The Address Line 1 field is required.</div>
      <button data-automation-id="pageFooterNextButton">Next step</button>
    </div>`);
  assert.match(result.stoppedBecause, /Address Line 1 field is required/);
  assert.doesNotMatch(result.stoppedBecause, /all set|form loaded|a11y/, result.stoppedBecause);
});

test('F-816: an Oracle pill drawn again when chosen is read as chosen', async () => {
  // cx-select-pills (TI / Legrand / Denso markup, form-captures): the click
  // re-renders the group, so the clicked button is detached and the chosen
  // one is a new node. The run said "the page did not keep the choice".
  const report = await fill(`
    <div class="input-row"><div class="input-row__control-container" id="c"></div></div>
    <script>
      const opts = ['Yes', 'No'];
      const draw = (chosen) => {
        document.getElementById('c').innerHTML = '<ul role="radiogroup" aria-label="Are you legally authorized to work in the United States?" class="cx-select-pills-container">'
          + opts.map((o) => '<li role="presentation"><button type="button" role="radio" aria-checked="' + (o === chosen) + '" class="cx-select-pill-section' + (o === chosen ? ' cx-select-pill-section--selected' : '') + '"><span class="cx-select-pill-name"> ' + o + '</span></button></li>').join('') + '</ul>';
        for (const b of document.querySelectorAll('#c button')) b.addEventListener('click', () => setTimeout(() => { window.__chosen = b.textContent.trim(); draw(window.__chosen); }, 120));
      };
      draw(null);
    <\/script>`);
  assert.equal(await page.evaluate(() => window.__chosen), 'Yes', 'the pill was clicked');
  assert.ok(!(report.unanswered || []).some((u) => /did not keep the choice/.test(u.label || u)), JSON.stringify(report.unanswered));
});

test('F-633: a success notice is never given as the reason a step stalled', async () => {
  // Onto Innovation, 2026-10-01: "the form would not move on: Alex Rivera - Onto
  // Innovation - Applications Engineer 3.pdf successfully uploaded".
  const result = await fill(`
    <div>
      <h2>My Experience</h2>
      <label for="a">Something</label><input id="a">
      <div role="alert">Alex Rivera - Onto Innovation - Applications Engineer 3.pdf successfully uploaded</div>
      <div role="alert">Error-The field Phone Number is required and must have a value.</div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>
    </div>`);
  assert.ok(!/successfully uploaded/.test(result.stoppedBecause), result.stoppedBecause);
  assert.match(result.stoppedBecause, /Phone Number is required/);
});

test('A NEXT THAT DOES NOTHING IS ONE STEP, even when filling changed the page (F-357)', async () => {
  // Ticking the consent reveals a question; Next never moves. The walk used
  // to compare the page after Next with the page BEFORE filling, see the
  // revealed field as a new step, and go round again.
  const result = await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="c">I agree to the Terms and Conditions</label><input id="c" type="checkbox">
    <div id="more"></div>
    <button data-automation-id="pageFooterNextButton" onclick="window.__NEXT = (window.__NEXT || 0) + 1">Save and Continue</button>
    <script>document.getElementById('c').addEventListener('change', () => { if (!document.getElementById('r')) document.getElementById('more').innerHTML = '<label for="r">Race</label><select id="r"><option>Select</option><option>Asian</option></select>'; });<\/script>`);
  assert.equal(result.steps, 1, `one step, not a loop (stopped: ${result.stoppedBecause})`);
  assert.equal(await page.evaluate(() => window.__NEXT), 1, 'Next was pressed once');
  assert.match(result.stoppedBecause, /stayed on this step/);
  assert.equal(await page.evaluate(() => document.getElementById('r').value), 'Asian', 'the revealed question was still answered');
});

test('F-789: a Save and Continue that takes seconds to show the next step is not "the form stayed on this step" (Terex, 2026-10-22)', async () => {
  // Workday keeps the old step on screen, unchanged, while it saves. The walk
  // used to judge after 750 ms of stillness and stop; the next step painted a
  // moment later and sat unfilled for five minutes.
  const result = await fill(`
    <div id="app">
      <h2>My Information</h2><label for="a">First Name</label><input id="a">
      <button data-automation-id="pageFooterNextButton" id="next">Save and Continue</button>
    </div>
    <script>
      document.getElementById('next').onclick = () => {
        setTimeout(() => {
          document.getElementById('app').innerHTML = '<h2>My Experience</h2><label for="b">Last Name</label><input id="b">';
        }, 2500);
      };
    <\/script>`);
  assert.doesNotMatch(String(result.stoppedBecause), /stayed on this step/, result.stoppedBecause);
  assert.equal(result.steps, 2, `the walk reached the second step: ${result.stoppedBecause}`);
  assert.equal(await page.evaluate(() => document.getElementById('b')?.value), 'Rivera', 'and filled it');
});

test('F-798: a resume box that fills the form from the resume gets the file FIRST, once, and the answers go in on top of what it wrote (UKG, Yaskawa)', async () => {
  // UKG parses the upload and re-writes the form; uploaded last, it blanked
  // the address typed a moment before, and every later run uploaded again.
  const result = await fill(`
    <form onsubmit="return false">
      <div id="rbox"><p>You can use a resume to fill out your application faster and it will be added automatically as an attachment.</p>
        <label for="res">Upload Resume</label><input type="file" id="res"></div>
      <label for="addr">Address 1</label><input id="addr">
      <label for="city">City</label><input id="city">
      <div id="attached"></div>
    </form>
    <script>
      window.__uploads = 0;
      document.getElementById('res').addEventListener('change', () => {
        window.__uploads += 1;
        setTimeout(() => {
          document.getElementById('addr').value = '';
          document.getElementById('city').value = 'Parsed City';
          document.getElementById('attached').innerHTML = '<label><input type="checkbox" id="att"> Alex Rivera - Acme - Engineer.pdf</label>';
          document.getElementById('res').value = '';
        }, 600);
      });
    <\/script>`);
  assert.equal(await page.evaluate(() => window.__uploads), 1, 'one upload, not one per pass');
  assert.equal(result.uploaded, true);
  assert.equal(await page.evaluate(() => document.getElementById('addr').value), '1 Test St', `the parse did not wipe the address: ${result.stoppedBecause}`);
  assert.equal(await page.evaluate(() => document.getElementById('city').value), 'Springfield');
});

test('F-1009: a parsing resume box that redraws itself empty gets the file again, and the answers go back on top of the second parse (Rippling)', async () => {
  // The first parse rewrites the form AND redraws the box empty, with no chip;
  // the second keeps the file and shows it. The address it blanks each time
  // must be his again at the end.
  const result = await fill(`
    <form onsubmit="return false">
      <div id="rbox"><p>You can use a resume to fill out your application faster and it will be added automatically as an attachment.</p>
        <label for="res">Upload Resume</label><input type="file" id="res" name="res"></div>
      <label for="addr">Address 1</label><input id="addr">
      <label for="city">City</label><input id="city">
      <div id="attached"></div>
    </form>
    <script>
      window.__uploads = 0;
      const watch = (el) => el.addEventListener('change', () => {
        window.__uploads += 1;
        const first = window.__uploads === 1;
        setTimeout(() => {
          document.getElementById('addr').value = '';
          document.getElementById('city').value = 'Parsed City';
          if (first) {
            const fresh = document.createElement('input');
            fresh.type = 'file'; fresh.id = 'res'; fresh.name = 'res';
            document.getElementById('res').replaceWith(fresh);
            watch(fresh);
          } else {
            document.getElementById('attached').innerHTML = '<span>Alex Rivera - Acme - Engineer.pdf</span>';
          }
        }, 600);
      });
      watch(document.getElementById('res'));
    <\/script>`);
  assert.equal(await page.evaluate(() => window.__uploads), 2, 'attached again once, after the redraw');
  assert.equal(result.uploaded, true, JSON.stringify(result.unanswered));
  assert.equal(await page.evaluate(() => document.getElementById('addr').value), '1 Test St', 'the second parse did not leave the address blank');
  assert.equal(await page.evaluate(() => document.getElementById('city').value), 'Springfield');
});

test('F-874: Phenom\'s "Make completing your job application easier" box is a prefilling box too — the file first, the answers on top (Honda)', async () => {
  const result = await fill(`
    <form onsubmit="return false">
      <div id="rbox"><p>Upload options * Make completing your job application easier by uploading your resume or CV. Upload either DOC, DOCX, HTML, PDF, or TXT file types (3MB max)</p>
        <label for="res">Upload Resume</label><input type="file" id="res"></div>
      <label for="addr">Address</label><input id="addr">
      <label for="city">City</label><input id="city">
    </form>
    <script>
      window.__uploads = 0;
      document.getElementById('res').addEventListener('change', () => {
        window.__uploads += 1;
        // Phenom's parse writes its own reading of the resume over the step.
        setTimeout(() => { document.getElementById('addr').value = ''; document.getElementById('city').value = 'Parsed City'; }, 600);
      });
    <\/script>`);
  assert.equal(await page.evaluate(() => window.__uploads), 1);
  assert.equal(result.uploaded, true);
  assert.equal(await page.evaluate(() => document.getElementById('addr').value), '1 Test St', `the parse did not wipe the address: ${result.stoppedBecause}`);
  assert.equal(await page.evaluate(() => document.getElementById('city').value), 'Springfield');
});

test('F-881: on a run that follows him, what the site\'s resume parse wrote is not kept as his — what he typed before is (Honda Education End Date)', async () => {
  await fillAs(`
    <form onsubmit="return false">
      <div id="rbox"><p>Make completing your job application easier by uploading your resume or CV.</p>
        <label for="res">Upload Resume</label><input type="file" id="res"></div>
      <label for="city">City</label><input id="city">
      <label for="addr">Address</label><input id="addr" value="his own street">
    </form>
    <script>
      document.getElementById('res').addEventListener('change', () => {
        setTimeout(() => { document.getElementById('city').value = 'Parsed City'; }, 600);
      });
    <\/script>`, { armed: true, auto: true });
  assert.equal(await page.evaluate(() => document.getElementById('city').value), 'Springfield', 'the parse\'s guess was replaced by his answer');
  assert.equal(await page.evaluate(() => document.getElementById('addr').value), 'his own street', 'what was there before the upload is still his');
});

test('F-835: a SuccessFactors resume slot behind "Upload a Resume" is opened and the resume attached', async () => {
  const result = await fill(`
    <div class="rcmFormSection">
      <label for="fn">First Name</label><input id="fn">
      <h3>Resume</h3>
      <a href="javascript:void(0)" id="open" onclick="window.__opened = (window.__opened || 0) + 1; document.getElementById('dlg').innerHTML = '<div role=&quot;dialog&quot;><label for=&quot;dev&quot;>Upload from Device</label><input type=&quot;file&quot; id=&quot;dev&quot;></div>'">Upload a Resume</a>
      <div id="dlg"></div>
    </div>`);
  assert.equal(await page.evaluate(() => window.__opened), 1, 'the dialog was opened once');
  assert.equal(result.uploaded, true, `the resume attached: ${result.stoppedBecause}`);
  assert.equal(await page.evaluate(() => document.getElementById('dev').files.length), 1);
});

test('F-880: a resume the site refuses is reported as refused, in its words, never "attached" (career5, 2026-10-16)', async () => {
  const result = await fill(`
    <label for="fn">First Name</label><input id="fn">
    <label for="cv">Resume/CV</label><input type="file" id="cv">
    <div id="msg"></div>
    <script>document.getElementById('cv').addEventListener('change', () => {
      setTimeout(() => { document.getElementById('msg').innerHTML = '<div role="alert">Error Encountered while uploading your file.</div>'; }, 300);
    });<\/script>`);
  assert.equal(result.uploaded, false, `refused is not attached: ${JSON.stringify(result.unanswered)}`);
  assert.ok(result.unanswered.some((u) => /refused the file: "Error Encountered while uploading your file\./.test(u)), JSON.stringify(result.unanswered));
});

test('F-880: a plain upload with no complaint still counts as attached', async () => {
  const result = await fill(`
    <label for="fn">First Name</label><input id="fn">
    <label for="cv">Resume/CV</label><input type="file" id="cv">`);
  assert.equal(result.uploaded, true);
});

test('F-894: SuccessFactors\' "+" that opens the resume dialog is pressed, in a closed section, and the cover letter\'s is not (Schindler, Lincoln, Veeco)', async () => {
  const result = await fill(`
    <label for="fn">First Name</label><input id="fn">
    <div class="rcmFormSection">
      <button type="button" id="docsBar" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.getElementById('docs').style.display='block'">My Documents</button>
      <div id="docs" style="display:none">
        <span id="lab-r" class="hiddenAriaContent" style="display:none">Resume</span>
        <div class="attachmentBtn" id="51:_attach">
          <div id="51:_attachLabel" class="attachmentLabel attachmentText" onclick="window.__tileClicked = 1"><span>Upload a Resume</span></div>
          <div class="attachActions">
            <span id="51:_attachIcon" class="glyphicon glyphicon-plus-sign addAttachments" role="button" tabindex="0" aria-labelledby="lab-r 51:_ariaActionLabel" style="display:inline-block;width:16px;height:16px"
              onclick="window.__plusResume = (window.__plusResume || 0) + 1; document.getElementById('dlg').innerHTML = '<div role=&quot;dialog&quot;>Select a source for your file upload <label for=&quot;52:_file&quot;>Upload from Device</label><input type=&quot;file&quot; id=&quot;52:_file&quot; name=&quot;fileData1&quot;></div>'"></span>
            <span id="51:_ariaActionLabel" class="hiddenAriaContent" style="display:none">Upload a Resume Opens a dialog</span>
          </div>
        </div>
        <span id="lab-c" style="display:none">Cover Letter</span>
        <div class="attachmentBtn" id="53:_attach"><div class="attachmentLabel"><span>Attach a Cover Letter</span></div>
          <div class="attachActions"><span id="53:_attachIcon" class="glyphicon glyphicon-plus-sign addAttachments" role="button" tabindex="0" aria-labelledby="lab-c 53:_ariaActionLabel" style="display:inline-block;width:16px;height:16px" onclick="window.__plusCover = 1"></span>
            <span id="53:_ariaActionLabel" style="display:none">Attach a Cover Letter Opens a dialog</span></div></div>
      </div>
    </div>
    <div id="dlg"></div>`);
  assert.equal(await page.evaluate(() => window.__plusResume || 0), 1, 'the resume "+" was pressed once');
  assert.equal(await page.evaluate(() => window.__plusCover || 0), 0, 'the cover letter "+" was not');
  assert.equal(await page.evaluate(() => document.getElementById('52:_file')?.files.length), 1, `the resume went into the dialog's box: ${result.stoppedBecause}`);
  assert.equal(result.uploaded, true);
});

test('F-896: a hidden, unnamed file box elsewhere on the page does not stop the resume "+" (Lincoln, Veeco)', async () => {
  const result = await fill(`
    <label for="fn">First Name</label><input id="fn">
    <div id="leftover" style="display:none"><input type="file" name="fileData9"></div>
    <div class="attachmentBtn">
      <span id="lab-r" style="display:none">Resume</span>
      <div class="attachActions">
        <span id="plus" class="glyphicon glyphicon-plus-sign addAttachments" tabindex="0" aria-labelledby="lab-r act-r" style="display:inline-block;width:16px;height:16px"
          onclick="window.__plusResume = (window.__plusResume || 0) + 1; document.getElementById('dlg').innerHTML = '<div role=&quot;dialog&quot;>Select a source <label for=&quot;f1&quot;>Upload from Device</label><input type=&quot;file&quot; id=&quot;f1&quot; name=&quot;fileData1&quot;></div>'"></span>
        <span id="act-r" style="display:none">Upload a Resume Opens a dialog</span>
      </div>
    </div>
    <div id="dlg"></div>`);
  assert.equal(await page.evaluate(() => window.__plusResume || 0), 1, 'the "+" (a focusable span with no role) was pressed once');
  assert.equal(await page.evaluate(() => document.getElementById('f1')?.files.length), 1, `the resume went into the dialog's box: ${result.stoppedBecause}`);
  assert.equal(result.uploaded, true);
});

test('the emailed code is typed into six one-digit boxes, Verify is pressed, and the form that follows is filled (his consent, 2026-10-23)', async () => {
  const result = await fill(`
    <script>window.__code = '482913';</script>
    <h1>Verify your email</h1>
    <p>Enter the verification code we sent to your email.</p>
    <div id="pins">${[1, 2, 3, 4, 5, 6].map((i) => `<input id="p${i}" maxlength="1" inputmode="numeric" aria-label="Digit ${i}">`).join('')}</div>
    <button type="button" id="verify" onclick="window.__typed = [...document.querySelectorAll('#pins input')].map((i) => i.value).join(''); document.body.innerHTML = '<h1>Application</h1><label for=fn>First Name</label><input id=fn>'">Verify</button>`);
  assert.equal(await page.evaluate(() => window.__typed), '482913', 'every digit in its box before Verify');
  assert.equal(await page.evaluate(() => document.getElementById('fn')?.value), 'Alex', `the form behind the code was filled: ${result.stoppedBecause}`);
});

test("Oracle's email-only screen: the email is filled, Next pressed, the emailed code typed (his consent, 2026-10-23)", async () => {
  await fill(`
    <script>window.__code = '731044';</script>
    <h1>Welcome</h1>
    <label for="em">Email Address</label><input id="em" type="email" name="email">
    <label><input type="checkbox" id="agree"> I agree with the terms and conditions</label>
    <script>
      window.toForm = () => { window.__typed = document.getElementById('vc').value; document.body.innerHTML = '<label for="fn">First Name</label><input id="fn">'; };
      window.toCode = () => { window.__next = 1; document.body.innerHTML = '<p>Enter the verification code we sent to your email.</p><label for="vc">Verification Code</label><input id="vc" name="verificationCode"><button type="button" onclick="toForm()">Verify</button>'; };
    </script>
    <form onsubmit="event.preventDefault(); toCode()"><button type="submit" id="next">Next</button></form>`,
  { url: 'https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123/apply/email' });
  assert.equal(await page.evaluate(() => window.__next || 0), 1, 'Next was pressed for the code');
  assert.equal(await page.evaluate(() => window.__typed), '731044', 'the emailed code went in');
  assert.equal(await page.evaluate(() => document.getElementById('fn')?.value), 'Alex');
});

test('an application page is never read as a code page: one-character boxes among questions, "one-time" in its text, a bare Submit (F-905 review)', async () => {
  await fill(`
    <script>window.__code = '482913';</script>
    <label for="fn">First Name</label><input id="fn">
    <p>This role includes a one-time relocation bonus. Best phone time: mornings.</p>
    <label for="mi">Middle Initial</label><input id="mi" maxlength="1">
    <div><input id="d1" maxlength="1" aria-label="Badge number part 1"><input id="d2" maxlength="1" aria-label="Badge number part 2"><input id="d3" maxlength="1" aria-label="Badge number part 3"><input id="d4" maxlength="1" aria-label="Badge number part 4"></div>
    <button type="button" onclick="window.__submitted = 1">Submit</button>`);
  assert.equal(await page.evaluate(() => window.__submitted || 0), 0, 'Submit was never pressed');
  assert.equal(await page.evaluate(() => document.getElementById('d1').value), '', 'no code digits typed into the date boxes');
  // (The planner leaves a page with four one-character boxes alone as a
  // credential form — the older, safer rule; nothing here overrides it.)
});

test('a code box whose only button is "Submit" gets the code but nothing is pressed (F-905 review)', async () => {
  await fill(`
    <script>window.__code = '731044';</script>
    <p>Enter the verification code we sent to your email.</p>
    <label for="vc">Verification Code</label><input id="vc" name="verificationCode">
    <button type="button" onclick="window.__submitted = 1">Submit</button>`);
  assert.equal(await page.evaluate(() => document.getElementById('vc').value), '731044');
  assert.equal(await page.evaluate(() => window.__submitted || 0), 0, 'a bare Submit is never the button for the code');
});

test('a "your session is about to expire" dialog gets its own Continue; one that asks for a human check does not (his call, 2026-10-23)', async () => {
  await fill(`
    <label for="fn">First Name</label><input id="fn">
    <div id="warn"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<div role="dialog">Your session is about to expire. Do you want to continue? <button type="button" onclick="window.__stay = (window.__stay || 0) + 1; this.closest(\'[role=dialog]\').remove()">Continue</button></div>'
      + '<div role="dialog">Are you still there? Please verify you are human. <button type="button" onclick="window.__bot = 1">Continue</button></div>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__stay || 0), 1, 'the session warning was answered once');
  assert.equal(await page.evaluate(() => window.__bot || 0), 0, 'a human check is never pressed');
});

test('F-910: Oracle\'s "Are You Still With Us?" (a plain div) gets Continue Working, never End Session', async () => {
  // Live 2026-10-24: TI, Oceaneering and Ford, all filled, all ended by this box.
  await fill(`
    <label for="fn">First Name</label><input id="fn">
    <div id="warn"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<div class="standard-apply-session-expire-container"><h1>Are You Still With Us?</h1>'
      + '<p>It seems you\'ve been gone for a while. For security reasons we will end your session automatically in 03:00 unless you would like to continue working.</p>'
      + '<button type="button" onclick="window.__end = 1">End Session</button>'
      + '<button type="button" onclick="window.__stay = (window.__stay || 0) + 1; this.parentElement.remove()">Continue Working</button></div>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__stay || 0), 1, 'Continue Working was pressed once');
  assert.equal(await page.evaluate(() => window.__end || 0), 0, 'End Session is never pressed');
});

test('week review: a session dialog drawn INSIDE the application form never gets its type-less Continue; one with its own form does', async () => {
  // A <button> with no type inside a <form> submits that form. A timeout
  // dialog rendered inside the application's form would send the application.
  await fill(`
    <form id="app" onsubmit="window.__sent = (window.__sent || 0) + 1; return false">
      <label for="fn">First Name</label><input id="fn">
      <div id="warn"></div>
    </form>
    <div id="own"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<div role="dialog">Your session is about to expire. <button onclick="window.__inner = 1">Continue</button></div>';
    document.getElementById('own').innerHTML = '<div role="dialog"><form onsubmit="window.__stay = (window.__stay || 0) + 1; this.closest(\'[role=dialog]\').remove(); return false">'
      + 'Your session is about to expire. <button type="submit">Continue</button></form></div>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__sent || 0), 0, 'the application form was never submitted');
  assert.equal(await page.evaluate(() => window.__inner || 0), 0, 'the Continue that would submit it was never pressed');
  assert.equal(await page.evaluate(() => window.__stay || 0), 1, 'a dialog that submits only its own form still gets its Continue');
});

test('week-fixes J1a: a session container WRAPPING the whole application never gets the application\'s Continue', async () => {
  // `.modal` and [class*=session-expire] match a container, not just a box:
  // one that wraps the whole application puts the application's form
  // "inside the dialog", and its type-less Continue submits it.
  await fill(`
    <div id="shell">
      <form id="app" onsubmit="window.__sent = (window.__sent || 0) + 1; return false">
        <label for="fn">First Name</label><input id="fn">
        <div id="warn"></div>
      </form>
    </div>`);
  await page.evaluate(() => {
    document.getElementById('shell').className = 'standard-apply-session-expire-container';
    document.getElementById('warn').innerHTML = 'Your session is about to expire. <button onclick="window.__press = 1">Continue</button>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__sent || 0), 0, 'the wrapped application was never submitted');
  assert.equal(await page.evaluate(() => window.__press || 0), 0, 'its type-less Continue was never pressed');
});

test('week-fixes J1b: a session Continue outside any form whose form="…" names the application is never pressed', async () => {
  // A button outside any form still submits the form its form="id" names.
  await fill(`
    <form id="app" onsubmit="window.__sent = (window.__sent || 0) + 1; return false">
      <label for="fn">First Name</label><input id="fn">
    </form>
    <div id="warn"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<div role="dialog">Your session is about to expire. <button form="app" onclick="window.__press = 1">Continue</button></div>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__sent || 0), 0, 'the form named by form="app" was never submitted');
  assert.equal(await page.evaluate(() => window.__press || 0), 0, 'the form="app" Continue was never pressed');
});

test('week-fixes K2a: a session dialog\'s own form that owns an application field by form="…" is never submitted', async () => {
  // form.elements holds an <input form="sess"> drawn outside the form; a
  // querySelector inside the form does not see it.
  await fill(`
    <label for="fn">First Name</label><input id="fn" form="sess">
    <div id="warn"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<div role="dialog"><form id="sess" onsubmit="window.__sent = (window.__sent || 0) + 1; return false">'
      + 'Your session is about to expire. <input type="hidden" name="t" value="1"><button type="submit">Continue</button></form></div>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__sent || 0), 0, 'the form that owns First Name was never submitted');
});

test('week-fixes K2b: a session dialog\'s own form holding a contenteditable field is never submitted', async () => {
  await fill(`
    <label for="fn">First Name</label><input id="fn">
    <div id="warn"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<div role="dialog"><form onsubmit="window.__sent = (window.__sent || 0) + 1; return false">'
      + 'Your session is about to expire. <div contenteditable>notes</div><button type="submit">Continue</button></form></div>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__sent || 0), 0, 'a form with a field he could type in was never submitted');
});

test('week-fixes K2c: a session dialog that IS its own form, holding only hidden inputs, still gets its Continue', async () => {
  await fill(`
    <label for="fn">First Name</label><input id="fn">
    <div id="warn"></div>`);
  await page.evaluate(() => {
    document.getElementById('warn').innerHTML = '<form role="dialog" class="session-expire" onsubmit="window.__stay = (window.__stay || 0) + 1; this.remove(); return false">'
      + 'Your session is about to expire. <input type="hidden" name="t" value="1"><button type="submit">Stay signed in</button></form>';
  });
  await page.waitForTimeout(17_000);
  assert.equal(await page.evaluate(() => window.__stay || 0), 1, 'stay signed in was pressed once');
});

test('F-835: an Upload Resume button over a file box already on the page is never pressed', async () => {
  await fill(`
    <label for="fn">First Name</label><input id="fn">
    <button type="button" id="up" onclick="window.__pressed = 1">Upload Resume</button>
    <input type="file" id="cv" style="display:none" aria-label="Resume">`);
  assert.equal(await page.evaluate(() => window.__pressed || 0), 0);
});

test('F-803: an optional field nothing answers is shown apart, never "left for you"', async () => {
  // Moog's Workday listed "Suffix" beside the required questions, and every
  // such run read as unfinished. Optional blanks are shown, not counted.
  const result = await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Describe your ideal Tuesday</label><input id="b" required>
    <label for="c">Your favourite colour of stapler</label><input id="c">`);
  assert.ok(result.unanswered.some((u) => /Tuesday/.test(u)), `the required one is left for him: ${JSON.stringify(result.unanswered)}`);
  assert.ok(!result.unanswered.some((u) => /stapler/.test(u)), `the optional one is not: ${JSON.stringify(result.unanswered)}`);
  assert.ok((result.optionalBlank || []).some((u) => /stapler/.test(u)), `…but it is named: ${JSON.stringify(result.optionalBlank)}`);
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText || '');
  assert.match(panel, /optional, left blank: .*stapler/i);
  assert.match(panel, /1 left for you/);
});

test('a question it cannot answer is reported, never guessed', async () => {
  const result = await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Describe your ideal Tuesday</label><input id="b" required>`);
  assert.equal(result.filled, 1);
  // Required, so it is his (an optional one is named apart — F-803).
  assert.deepEqual(result.unanswered, ['step 1: Describe your ideal Tuesday']);
  assert.equal(await page.evaluate(() => document.getElementById('b').value), '', 'left genuinely blank');
});

test('consent boxes are ticked and EEO is answered', async () => {
  const result = await fill(`
    <label for="c">I agree to the Terms and Conditions</label><input id="c" type="checkbox">
    <label for="ai">I consent to the use of artificial intelligence in screening</label><input id="ai" type="checkbox">
    <label for="g">Gender</label><select id="g"><option>Select</option><option>Male</option><option>Female</option></select>`);
  assert.equal(result.checked, 2, 'every consent box, every time');
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Male');
});

test('nothing on the page is a submit control the filler will touch', async () => {
  await fill(`
    <label for="a">First Name</label><input id="a">
    <button id="s" type="submit" onclick="window.__PRESSED=true">Submit Application</button>
    <input type="submit" value="Submit" onclick="window.__PRESSED=true">`);
  assert.equal(await page.evaluate(() => !!window.__PRESSED), false);
});

test('IT SHOWS WHAT IT DID, on the page', async () => {
  // Until this existed the only output was a badge number and a console nobody
  // opens — so "it filled some things and left a million unanswered" was the
  // honest experience of using it, with no way to see which things or why.
  await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Describe your ideal Tuesday</label><input id="b" required>
    <label for="c">I agree to the Terms</label><input id="c" type="checkbox">`);
  // Required, so it is "left for you"; an optional blank is named apart (F-803).

  const panel = await page.evaluate(() => {
    const el = document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel');
    return el ? { text: el.innerText.replace(/\s+/g, ' '), onTop: getComputedStyle(el).position } : null;
  });
  assert.ok(panel, 'a panel must appear on the page');
  assert.match(panel.text, /1 filled/);
  assert.match(panel.text, /1 ticked/);
  assert.match(panel.text, /1 left for you/);
  assert.match(panel.text, /Describe your ideal Tuesday/, 'it names the question it could not answer');
  assert.match(panel.text, /Submit is yours/);
  assert.equal(panel.onTop, 'fixed');
});

test('the panel tells a MISSING resume from a screen with nowhere to put one', async () => {
  // These used to read the same. A Workday application carries its upload on
  // screen TWO, so "no resume attached" appeared on the Application Questions
  // step — describing a failure that had not happened, on the same panel that
  // was quietly under-reporting four unanswered questions.
  await fill('<label for="a">First Name</label><input id="a">');
  const noSlot = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(noSlot, /no resume slot on this screen/);
  assert.doesNotMatch(noSlot, /no resume attached/, 'nothing failed here');

  // A page that DOES have a resume slot and still ends up without one is a
  // real miss, and must keep saying so.
  await page.setContent('<label for="a">First Name</label><input id="a">'
    + '<div><h3>Resume</h3><input id="r" type="file" style="display:none"></div>');
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg, reply) => {
          if (msg.type === 'plan') reply({ ok: true, plan: await globalThis.__jarvisPlan(msg.fields) });
          else if (msg.type === 'resume') reply({ ok: false, error: 'no resume built for this job yet', status: 404 });
          else reply({ ok: false, error: 'unknown' });
        },
      },
    };
  });
  await page.evaluate(CONTENT);
  const missed = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(missed, /no resume attached/, 'there was a slot and it is still empty');
});

test('A FORM THAT ALREADY HOLDS HIS RESUME SAYS SO, on a run that uploaded nothing (F-407)', async () => {
  // Read off a live Physical Intelligence application: the first press logged
  // "resume ATTACHED"; the second press had nothing left to upload, and the
  // panel then read "no resume slot on this screen" over a form holding his
  // resume. Whether the form has it is a fact about the PAGE, not about what
  // this run happened to do.
  //
  // Ashby swaps the file input for a chip once the file is chosen, so the
  // filename is what remains to be seen — and the engine always saves under
  // the same one.
  await fill('<label for="a">First Name</label><input id="a">'
    + '<div class="chip">Alex Rivera Resume.pdf <button>Remove</button></div>');
  const text = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(text, /resume attached/, 'the page is holding it, whatever this run did');
  assert.doesNotMatch(text, /no resume slot on this screen/);

  // …and a page with neither a slot nor a file still says the honest thing.
  await fill('<label for="a">First Name</label><input id="a">');
  const bare = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(bare, /no resume slot on this screen/);
  assert.doesNotMatch(bare, /no resume attached/, 'nothing failed here');
});

test('PROGRESS NEVER COVERS THE PANEL, and never hides the ✕ (F-502)', async () => {
  // Read off a live Amazon application. The chip and the panel were both
  // pinned to `top: 14px; right: 14px`, so the resume wait loop drew "still
  // writing the resume for Amazon · 0:30" straight across the panel's header
  // — over the ✕. He could neither read the report under it nor close it.
  //
  // Two properties, and the second is the one that makes the first hold: a
  // progress line asked for while a panel is up goes INSIDE the panel, and no
  // second floating box is created to fight it for the corner.
  await fill('<label for="a">First Name</label><input id="a">');
  const shown = await page.evaluate(() => {
    globalThis.__jarvisContent.chip('still writing the resume for Amazon · 0:30');
    const root = document.getElementById('jarvis-overlay').shadowRoot;
    const panel = root.getElementById('jarvis-panel');
    const live = panel.querySelector('#jarvis-live');
    const x = panel.querySelector('#jarvis-x').getBoundingClientRect();
    return {
      floating: !!root.getElementById('jarvis-chip'),
      live: live.hidden ? '' : live.textContent,
      // Is the ✕ the topmost thing at its own centre? If anything were
      // drawn over it, this is the hit test that would say so.
      xIsClickable: root.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2)?.id === 'jarvis-x',
    };
  });
  assert.equal(shown.floating, false, 'no second box: the panel is the one surface');
  assert.match(shown.live, /still writing the resume for Amazon/, 'the progress line reads inside the panel');
  assert.equal(shown.xIsClickable, true, 'nothing is drawn over the close button');

  // Cleared, the row goes away rather than sitting there empty.
  const cleared = await page.evaluate(() => {
    globalThis.__jarvisContent.chip('');
    const root = document.getElementById('jarvis-overlay').shadowRoot;
    return { floating: !!root.getElementById('jarvis-chip'), hidden: root.getElementById('jarvis-panel').querySelector('#jarvis-live').hidden };
  });
  assert.deepEqual(cleared, { floating: false, hidden: true });

  // With NO panel on screen, progress still has somewhere to go — the
  // floating chip is what a page with no report gets.
  const alone = await page.evaluate(() => {
    const root = document.getElementById('jarvis-overlay').shadowRoot;
    root.getElementById('jarvis-panel').remove();
    globalThis.__jarvisContent.chip('Jarvis is reading the page…');
    return root.getElementById('jarvis-chip')?.textContent || '';
  });
  assert.match(alone, /Jarvis is reading the page/);
});

test('WITH THE SIDE PANEL OPEN, NOTHING IS DRAWN OVER THE FORM (2026-09-23)', async () => {
  // "stuff is still climbing on top of each other." The report goes to the
  // worker for the side panel's Answers tab; the page draws no box and no
  // progress chip while the panel is open beside it.
  await fill('<label for="a">First Name</label><input id="a">', { worker: { panelOpen: true } });
  await page.waitForFunction(() => globalThis.__sentMsgs.some((m) => m.type === 'page-report'));
  await new Promise((r) => setTimeout(r, 50));
  const seen = await page.evaluate(() => {
    const root = document.getElementById('jarvis-overlay')?.shadowRoot;
    const sent = globalThis.__sentMsgs.find((m) => m.type === 'page-report').report;
    return { panel: !!root?.getElementById('jarvis-panel'), chip: !!root?.getElementById('jarvis-chip'), filled: sent.filled, holdsResume: sent.holdsResume, unanswered: sent.unanswered };
  });
  assert.equal(seen.panel, false, 'no box over the form');
  assert.equal(seen.chip, false, 'and no line in the corner either');
  assert.equal(seen.filled, 1, 'the report the side panel reads is the run\'s own');
  assert.equal(seen.holdsResume, false);
});

test('WITH THE SIDE PANEL CLOSED, ONE LINE THAT OPENS IT (2026-09-23)', async () => {
  await fill('<label for="a">First Name</label><input id="a">', { worker: { panelOpen: false } });
  await page.waitForFunction(() => !!document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-chip'));
  const line = await page.evaluate(() => document.getElementById('jarvis-overlay').shadowRoot.getElementById('jarvis-chip').textContent);
  assert.match(line, /Jarvis · 1 filled/);
  assert.match(line, /open the panel/);
  assert.equal(await page.evaluate(() => !!document.getElementById('jarvis-overlay').shadowRoot.getElementById('jarvis-panel')), false, 'still no box over the form');
  await page.evaluate(() => document.getElementById('jarvis-overlay').shadowRoot.getElementById('jarvis-open').click());
  await page.waitForFunction(() => globalThis.__sentMsgs.some((m) => m.type === 'open-panel'));
});

test('the panel can be dismissed', async () => {
  await fill('<label for="a">First Name</label><input id="a">');
  const gone = await page.evaluate(() => {
    document.getElementById('jarvis-overlay').shadowRoot.querySelector('#jarvis-panel #jarvis-x').click();
    return !document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel');
  });
  assert.equal(gone, true);
});

test('a sign-in wall gets a panel too, not silence', async () => {
  await fill('<label for="p">Password</label><input id="p" type="password">');
  const text = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(text, /Sign in here/);
  assert.match(text, /Signing in is yours/);
});

test('on a JOB POSTING it follows Apply instead of reporting nothing', async () => {
  // Bosch (SmartRecruiters), Form Energy (Ashby) and Joby (iCIMS) postings all
  // have an Apply button and no application fields. The report read "0 filled",
  // which looks like a broken tool rather than the wrong page.
  const result = await fill(`
    <div id="page">
      <h1>Manufacturing Engineer</h1>
      <p>A long job advert with no form on it at all.</p>
      <button id="apply">Apply</button>
    </div>
    <script>
      document.getElementById('apply').onclick = () => {
        document.getElementById('page').innerHTML =
          '<label for="first_name">First Name</label><input id="first_name">' +
          '<label for="email">Email</label><input id="email">';
      };
    </script>`);
  assert.equal(result.filled, 2, 'it follows Apply and then fills the form behind it');
});

test('a navigating Apply link asks the worker to pick the thread back up', async () => {
  // Clicking a real link NAVIGATES, and a navigation destroys the content script
  // mid-run — so following Apply is only useful if someone resumes on the page
  // it opened. It reports `followedApply`; background.js waits for the new page
  // to settle and injects once more. That is what makes this one click, not two.
  const result = await fill(`
    <h1>Manufacturing Engineer</h1>
    <p>Advert text with no form.</p>
    <button id="a" onclick="document.body.innerHTML='<p>a page with no form either</p>'">Apply</button>`);
  assert.equal(result.followedApply, true);
  assert.match(result.stoppedBecause, /picking up on the page it opened/);
});

test('a real form is never mistaken for an advert', async () => {
  // The guard is "fewer than three controls". A form with fields must not have
  // its Apply/Submit button followed instead of being filled.
  const result = await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Last Name</label><input id="b">
    <label for="c">Email</label><input id="c">
    <button>Apply</button>`);
  assert.equal(result.filled, 3);
});

test('A SUBMIT BUTTON LABELLED "Continue" IS NEVER CLICKED', async () => {
  // The never-submit rule was defended by a TEXT regex, and text is not what
  // makes a button submit. Measured before the fix: this exact page was clicked
  // through and the form submitted. An application sent without him pressing
  // anything is the one outcome this whole system exists to prevent.
  const result = await fill(`
    <form onsubmit="window.__SUBMITTED = true; return false;">
      <label for="a">First Name</label><input id="a">
      <button type="submit">Continue</button>
    </form>`);
  assert.equal(await page.evaluate(() => !!window.__SUBMITTED), false,
    'a submit button is his, whatever it is labelled');
  assert.equal(result.filled, 1, 'and the form is still filled — only the advance is refused');
  assert.match(result.stoppedBecause, /submits the form — that press is yours/);
});

test('a button with NO type inside a form is a submit button', async () => {
  // <button> defaults to type="submit" inside a form. Reading the .type
  // PROPERTY rather than the attribute is what catches this one; in markup it
  // looks completely innocent.
  await fill(`
    <form onsubmit="window.__S = true; return false;">
      <label for="a">First Name</label><input id="a">
      <button>Next</button>
    </form>`);
  assert.equal(await page.evaluate(() => !!window.__S), false,
    'an untyped button in a form submits it, and must be refused like any other');
});

test('input[type=submit] labelled "Next" is refused too', async () => {
  await fill(`
    <form onsubmit="window.__S3 = true; return false;">
      <label for="a">First Name</label><input id="a">
      <input type="submit" value="Next">
    </form>`);
  assert.equal(await page.evaluate(() => !!window.__S3), false);
});

test('a real SPA next button still advances', async () => {
  // The guard must not cost the multi-step walk. Workday's control is
  // type="button" with a JS handler and is not inside a form at all.
  // WRAPPED IN AN IIFE, and that is not cosmetic. `setContent` reuses the page's
  // global scope, so a bare `const steps` here collided with the one an earlier
  // fixture had already declared. The re-declaration threw, the whole inline
  // script no-opped, #app stayed empty — and the test failed reporting
  // "this page is not a multi-step application", which is true of an empty page
  // and says nothing about the rule under test. A fixture that silently does
  // nothing is the worst kind, because the failure describes the fixture.
  const result = await fill(`
    <div id="app"></div>
    <script>
      (() => {
        const spaSteps = [
          '<h2>One</h2><label for="first_name">First Name</label><input id="first_name">' +
            '<button type="button" data-automation-id="pageFooterNextButton">Save and Continue</button>',
          '<h2>Two</h2><label for="email">Email</label><input id="email">' +
            '<button type="button" data-automation-id="pageFooterNextButton">Submit</button>',
        ];
        let i = 0;
        const render = () => {
          document.getElementById('app').innerHTML = spaSteps[i];
          const b = document.querySelector('[data-automation-id="pageFooterNextButton"]');
          if (b && b.textContent === 'Save and Continue') b.onclick = () => { i += 1; render(); };
        };
        render();
      })();
    </script>`);
  assert.equal(result.steps, 2, `a non-submitting next button must still be followed — got ${JSON.stringify(result)}`);
  assert.match(result.stoppedBecause, /last step before Submit/);
});

test('a button that submits OUTSIDE any form is not refused', async () => {
  // type="submit" only submits if it is IN a form. Refusing it elsewhere would
  // cost real advances for no safety gain.
  //
  // Asserted by whether the button was CLICKED, not by the step count: a fixture
  // with no heading and the same field count on both screens is invisible to
  // stepSignature, and that would be testing the fixture rather than the rule.
  await fill(`
    <div id="app">
      <h2>One</h2>
      <label for="a">First Name</label><input id="a">
      <button type="submit" onclick="window.__CLICKED = true">Continue</button>
    </div>`);
  assert.equal(await page.evaluate(() => !!window.__CLICKED), true,
    'no form means no submission, so this is an ordinary advance');
});

/**
 * A working react-select, behaving as the live one was measured to behave:
 * typing filters a listbox, and CLICKING AN OPTION CLEARS THE INPUT and renders
 * the choice in a sibling node. That last part is the whole fault — it is why
 * the input holds text exactly when the answer did not stick.
 */
function comboFixture(question, options) {
  return `
    <label id="q-label" for="q">${question}</label>
    <div class="select__control"><div class="select__value-container">
      <div class="select__input-container">
        <input id="q" class="select__input" role="combobox" aria-autocomplete="list"
               aria-expanded="false" aria-labelledby="q-label">
      </div>
    </div></div>
    <div id="menu"></div>
    <script>(() => {
      const OPTS = ${JSON.stringify(options)};
      const input = document.getElementById('q');
      const menu = document.getElementById('menu');
      const vc = document.querySelector('.select__value-container');
      const render = () => {
        menu.textContent = '';
        const q = input.value.toLowerCase();
        for (const o of OPTS.filter((x) => x.toLowerCase().startsWith(q))) {
          const d = document.createElement('div');
          d.setAttribute('role', 'option');
          d.textContent = o;
          d.addEventListener('click', () => {
            input.value = '';                       // react-select clears on commit
            let sv = vc.querySelector('.select__single-value');
            if (!sv) { sv = document.createElement('div'); sv.className = 'select__single-value'; vc.prepend(sv); }
            sv.textContent = o;
            menu.textContent = '';
          });
          menu.appendChild(d);
        }
      };
      input.addEventListener('input', render);
      input.addEventListener('click', render);
    })();<\/script>`;
}

test('THE WORK-AUTHORISATION COMBOBOX ACTUALLY COMMITS ITS ANSWER', async () => {
  // Measured on the live Torc Robotics form: this field, and eleven others on
  // the same page, were typed into and counted as filled while the form carried
  // no answer at all.
  const result = await fill(comboFixture('Are you legally authorized to work in the United States?', ['Yes', 'No']));

  const state = await page.evaluate(() => ({
    inputValue: document.getElementById('q').value,
    committed: document.querySelector('.select__single-value')?.textContent || '',
  }));
  assert.equal(state.committed, 'Yes', 'the answer must reach react, not just the screen');
  assert.equal(state.inputValue, '', 'and a committed react-select holds nothing in its input');
  assert.equal(result.filled, 1, 'and it counts as answered because it IS answered');
});

test('a combobox with no matching option is reported unanswered, not claimed', async () => {
  // The honest outcome. Reporting a fill here is what made twelve blanks look
  // like twelve answers.
  const result = await fill(comboFixture('Are you legally authorized to work in the United States?', ['Maybe', 'Unclear']));

  const state = await page.evaluate(() => ({
    inputValue: document.getElementById('q').value,
    committed: document.querySelector('.select__single-value')?.textContent || '',
  }));
  assert.equal(state.committed, '', 'nothing was chosen');
  assert.equal(state.inputValue, '', 'and no half-typed search term is left on a real application');
  assert.equal(result.filled, 0, 'it must not be counted');
  assert.ok(result.unanswered.some((u) => /legally authorized/.test(u.label || u)),
    'and he must be told which question went unanswered');
});

test('F-987: "Yes" is never committed to one of two "Yes, …" rows the matcher refused (Ginkgo, 2026-11-04)', async () => {
  // Ginkgo's Greenhouse sponsorship question. The server's matcher rightly
  // found no single row for "Yes"; the typed fallback then took the first row
  // whose first comma part is "Yes" — "…sponsorship support now", a claim the
  // plan never made.
  // Since his answer (2026-11-04, F-995) Ginkgo's own list holds his row, and
  // the plan names it: that row, never the "…support now" one.
  const Q = 'Do you now or will you in the future need employer sponsorship for a visa to work in the country where the job is open?';
  await fill(comboFixture(Q, ['Yes, I will need sponsorship support now', 'Yes, but not until the future', 'No']));
  const ginkgo = await page.evaluate(() => document.querySelector('.select__single-value')?.textContent || '');
  assert.equal(ginkgo, 'Yes, but not until the future', 'his row, named by the plan');
  // The guard itself: two "Yes, …" rows and neither is his — nothing committed, nothing half-typed.
  const result = await fill(comboFixture(Q, ['Yes, I will need sponsorship support now', 'Yes, I need sponsorship support for a transfer', 'No']));
  const state = await page.evaluate(() => ({
    inputValue: document.getElementById('q').value,
    committed: document.querySelector('.select__single-value')?.textContent || '',
  }));
  assert.equal(state.committed, '', `two rows start with "Yes": neither is his answer by default (${state.committed})`);
  assert.equal(state.inputValue, '', 'and no half-typed search term is left behind');
  assert.ok(result.unanswered.some((u) => /sponsorship/.test(u.label || u)), 'and the question is left for him, named');
});

test('F-991: a combobox is asked every spelling of the answer in one opening, so "LinkedIn" is reached (Maven, 2026-11-04)', async () => {
  // Maven's Greenhouse "How did you hear about us?": Google search | LinkedIn |
  // Hacker News | Word of Mouth. The plan lists the company's own site first in
  // many spellings, then LinkedIn; each spelling reopened the list, and the
  // field's budget ran out on the eighth, before LinkedIn.
  const began = Date.now();
  const result = await fill(comboFixture('How did you hear about us?', ['Google search', 'LinkedIn', 'Hacker News', 'Word of Mouth']));
  const took = Date.now() - began;
  const committed = await page.evaluate(() => document.querySelector('.select__single-value')?.textContent || '');
  assert.equal(committed, 'LinkedIn', `his ladder's first row the list has (${JSON.stringify(result.unanswered)})`);
  assert.ok(took < 15000, `one opening, not one per spelling: ${took} ms`);
});

// F-995, SETTLED BY HIS ANSWER (2026-11-04): "Yes, but not until the future" IS
// his row. The plan names it first, word for word, so it is chosen as itself —
// never reached by a loose bare "Yes".
test('F-995: his sponsorship row "Yes, but not until the future" is chosen because the plan names it (sponsorship)', async () => {
  for (const options of [['Yes, but not until the future', 'No'], ['Yes, now', 'Yes, but not until the future', 'No']]) {
    const result = await fill(comboFixture(
      'Do you now or will you in the future need employer sponsorship for a visa to work in the country where the job is open?',
      options,
    ));
    const committed = await page.evaluate(() => document.querySelector('.select__single-value')?.textContent || '');
    assert.equal(committed, 'Yes, but not until the future', `his row, named by the plan (${options.join(' | ')}; ${JSON.stringify(result.unanswered)})`);
  }
});

// F-996: chooseOption gave "Company Website" (and every "… Website" spelling)
// to a row that only shares the word: "Website banner ad".
test('F-991 review: an alternate spelling never takes a decoy row on the open list (F-996)', async () => {
  // "Company Website" and its spellings are asked of the open list before
  // LinkedIn; a row that only shares a word with them is not the company's site.
  await fill(comboFixture('How did you hear about us?', ['Google search', 'Company newsletter', 'Website banner ad', 'LinkedIn', 'Word of Mouth']));
  const committed = await page.evaluate(() => document.querySelector('.select__single-value')?.textContent || '');
  assert.equal(committed, 'LinkedIn');
});

test('F-987: one row that starts with the answer is still taken', async () => {
  await fill(comboFixture('Are you legally authorized to work in the United States?', ['Yes, I am authorized', 'No, I am not authorized']));
  const committed = await page.evaluate(() => document.querySelector('.select__single-value')?.textContent || '');
  assert.equal(committed, 'Yes, I am authorized');
});

/**
 * Ashby's "Search schools..." box (Applied Intuition, 2026-09-30, read from
 * Ashby's own bundle): nothing is listed until something is typed; the search
 * waits 300 ms after the last keystroke, then asks the server
 * (ApiSearchSchoolByCanonicalName, 120-300 ms measured). The fill typed
 * "Lakeside", looked once 0.6 s later, saw no rows, and reported "nothing
 * matched" with no list offered.
 */
function ashbySchoolFixture(results, delayMs) {
  return `
    <label id="s-label" for="s">School</label>
    <div class="value"></div>
    <input id="s" placeholder="Search schools..." role="combobox" aria-autocomplete="list"
           aria-haspopup="listbox" aria-expanded="false" aria-labelledby="s-label">
    <script>(() => {
      const RESULTS = ${JSON.stringify(results)};
      const input = document.getElementById('s');
      const shown = document.querySelector('.value');
      let pop = null, t = 0;
      const close = () => { if (pop) pop.remove(); pop = null; input.setAttribute('aria-expanded', 'false'); };
      input.addEventListener('input', () => {
        close(); clearTimeout(t);
        if (!input.value) return;
        input.setAttribute('aria-expanded', 'true');
        t = setTimeout(() => {
          pop = document.createElement('div');
          pop.setAttribute('role', 'listbox');
          for (const [name, country, domain] of RESULTS) {
            const row = document.createElement('div');
            row.setAttribute('role', 'option');
            row.innerHTML = '<div><div>' + name + '</div><div>' + country + '</div></div><div>' + domain + '</div>';
            row.addEventListener('click', () => { shown.textContent = name; input.value = name; close(); });
            pop.appendChild(row);
          }
          document.body.appendChild(pop);   // a portal at the end of the page, as Floating UI draws it
        }, ${delayMs});
      });
    })();<\/script>`;
}

test('F-632: Ashby\'s school search is watched until it answers, and its stacked rows are read with spaces', async () => {
  const result = await fill(ashbySchoolFixture([
    ['Lakeside University', 'United States', 'lakeside.edu'],
    ['Germantown Academy', 'United States', 'germantownacademy.net'],
    ['Saint Aloysius Lakeside National University', 'Peru', 'unica.edu.pe'],
  ], 1000));
  const chosen = await page.evaluate(() => document.querySelector('.value').textContent);
  assert.equal(chosen, 'Lakeside University');
  assert.equal(result.filled, 1);
});

test('ORACLE RECRUITING CLOUD: a lookup whose rows are role=gridcell is read, and a ZIP is searched by its first three digits (Denso, F-695)', async () => {
  // Oracle's cx-select: the input names its list by aria-controls, the list is
  // a role="grid" of role="gridcell" rows, and the ZIP lookup only answers a
  // search. Every Oracle dropdown read "0 rows" before this.
  await fill(`
    <label for="postalCode-32">ZIP Code</label>
    <div class="cx-select-container"><input id="postalCode-32" name="postalCode" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="postalCode-32-listbox" aria-expanded="false" class="cx-select-input"></div>
    <div id="postalCode-32-listbox" role="grid" class="cx-select__list"></div>
    <script>(() => {
      const input = document.getElementById('postalCode-32');
      const grid = document.getElementById('postalCode-32-listbox');
      const ZIPS = ['99201, Springfield, Springfield, WA', '12345, Springfield, Springfield, WA', '99203, Springfield, Springfield, WA'];
      input.addEventListener('input', () => {
        grid.innerHTML = '';
        window.__searched = input.value;
        if (input.value.length < 3) return;   // a lookup: nothing for one digit
        for (const z of ZIPS.filter((x) => x.startsWith(input.value))) {
          const row = document.createElement('div'); row.setAttribute('role', 'row');
          const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.className = 'cx-select__list-item ';
          cell.innerHTML = '<div class="cx-select__list-item-container"><span class="cx-select__list-item--content"><span>' + z + '</span></span></div>';
          cell.addEventListener('click', () => { input.value = z; grid.innerHTML = ''; });
          row.appendChild(cell); grid.appendChild(row);
        }
      });
    })();<\/script>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/zip/i.test(a.label)) { a.action = 'prompt'; a.value = '12345'; a.promptKind = 'combo'; } return plan; }` });
  const got = await page.evaluate(() => ({ value: document.getElementById('postalCode-32').value, searched: window.__searched }));
  assert.equal(got.value, '12345, Springfield, Springfield, WA');
});

test('F-878: an Oracle ZIP lookup that answers its first digits with another code is searched with the whole number (TI, 2026-10-23)', async () => {
  // TI's lookup offered only "99009, Elk, Springfield, WA" for "12345". Here the
  // three-digit search answers that, slowly; only the whole number finds 12345.
  await fill(`
    <label for="postalCode-30">ZIP Code</label>
    <div class="cx-select-container"><input id="postalCode-30" name="postalCode" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="postalCode-30-listbox" aria-expanded="false" class="cx-select-input"></div>
    <div id="postalCode-30-listbox" role="grid" class="cx-select__list"></div>
    <script>(() => {
      const input = document.getElementById('postalCode-30');
      const grid = document.getElementById('postalCode-30-listbox');
      const draw = (z) => {
        grid.innerHTML = '';
        for (const t of z) {
          const row = document.createElement('div'); row.setAttribute('role', 'row');
          const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.className = 'cx-select__list-item ';
          cell.innerHTML = '<div class="cx-select__list-item-container"><span class="cx-select__list-item--content"><span>' + t + '</span></span></div>';
          cell.addEventListener('click', () => { input.value = t; grid.innerHTML = ''; });
          row.appendChild(cell); grid.appendChild(row);
        }
      };
      input.addEventListener('input', () => {
        (window.__searches = window.__searches || []).push(input.value);
        if (input.value === '12345') { grid.setAttribute('aria-busy', 'true'); setTimeout(() => { grid.setAttribute('aria-busy', 'false'); draw(['12345, Springfield, Springfield, WA']); }, 400); }
        else if (input.value.length >= 3) draw(['99009, Elk, Springfield, WA']);
        else grid.innerHTML = '';
      });
    })();<\/script>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/zip/i.test(a.label)) { a.action = 'prompt'; a.value = '12345'; a.promptKind = 'combo'; } return plan; }` });
  const got = await page.evaluate(() => ({ value: document.getElementById('postalCode-30').value, searches: window.__searches }));
  assert.equal(got.value, '12345, Springfield, Springfield, WA', `searches: ${JSON.stringify(got.searches)}`);
});

test('F-883: Oracle\'s ZIP list follows its City — City first, and a saved wrong City is replaced even on a follow-along run (TI, 2026-10-23)', async () => {
  // Page order ZIP, City (as TI draws them); the saved profile left City
  // "Elk", so the ZIP list held only Elk's codes and his ZIP had no row.
  const box = (name, label) => `<label for="${name}-1">${label}</label>
    <div class="cx-select-container"><input id="${name}-1" name="${name}" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="${name}-1-listbox" aria-expanded="false" class="cx-select-input"></div>
    <div id="${name}-1-listbox" role="grid" class="cx-select__list"></div>`;
  await fillAs(`<form onsubmit="return false">${FOUR}${box('postalCode', 'ZIP Code')}${box('city', 'City')}</form>
    <script>(() => {
      const ZIPS = { Elk: ['99009, Elk, Springfield, WA'], Springfield: ['00000, Springfield, Springfield, WA', '12345, Springfield, Springfield, WA'] };
      const CITIES = ['Airway Heights, Springfield, WA', 'Cheney, Springfield, WA', 'Elk, Springfield, WA', 'Springfield, Springfield, WA'];
      const city = document.getElementById('city-1'); const zip = document.getElementById('postalCode-1');
      city.value = 'Elk';
      window.__order = [];
      const wire = (input, rows) => {
        const grid = document.getElementById(input.id + '-listbox');
        const draw = () => {
          grid.innerHTML = '';
          for (const t of rows().filter((r) => !input.__typed || r.toLowerCase().includes(input.__typed.toLowerCase()))) {
            const row = document.createElement('div'); row.setAttribute('role', 'row');
            const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.className = 'cx-select__list-item ';
            cell.innerHTML = '<div class="cx-select__list-item-container"><span class="cx-select__list-item--content"><span>' + t + '</span></span></div>';
            cell.addEventListener('click', () => { input.value = t.split(',')[input === city ? 0 : 0].trim() === t.split(',')[0].trim() ? (input === city ? t.split(',')[0].trim() : t) : t; window.__order.push(input.name); grid.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); if (input === city) zip.value = ''; });
            row.appendChild(cell); grid.appendChild(row);
          }
          input.setAttribute('aria-expanded', 'true');
        };
        input.addEventListener('mousedown', () => { input.__typed = ''; draw(); });
        input.addEventListener('input', () => { input.__typed = input.value; draw(); });
      };
      wire(city, () => CITIES);
      wire(zip, () => ZIPS[city.value] || []);
    })();<\/script>`, { armed: true, auto: true, choose: true });
  const got = await page.evaluate(() => ({ city: document.getElementById('city-1').value, zip: document.getElementById('postalCode-1').value, order: window.__order }));
  assert.equal(got.city, 'Springfield', `the saved "Elk" was replaced: ${JSON.stringify(got)}`);
  assert.equal(got.zip, '00000, Springfield, Springfield, WA', `the ZIP came from Springfield's list: ${JSON.stringify(got)}`);
  assert.deepEqual(got.order, ['city', 'postalCode'], 'City before ZIP');
});

test('F-883: a saved City of another town is replaced, Springfield is not "Springfield Valley", the ZIP it empties comes back, and his street is left alone (onsemi, Oceaneering)', async () => {
  const box = (name, label) => `<label for="${name}-1">${label}</label>
    <div class="cx-select-container"><input id="${name}-1" name="${name}" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="${name}-1-listbox" aria-expanded="false" class="cx-select-input"></div>
    <div id="${name}-1-listbox" role="grid" class="cx-select__list"></div>`;
  await fillAs(`<form onsubmit="return false">${FOUR}
    <label for="a1">Address Line 1</label><input id="a1" name="addressLine1" value="456 Example Ave">
    ${box('postalCode', 'ZIP Code')}${box('city', 'City')}</form>
    <script>(() => {
      const ZIPS = { Mica: ['99023, Mica, Springfield, WA'], Springfield: ['00000, Springfield, Springfield, WA'], 'Springfield Valley': ['99206, Springfield Valley, Springfield, WA'] };
      const CITIES = ['Mica, Springfield, WA', 'Springfield Valley, Springfield, WA', 'Springfield, Springfield, WA'];
      const city = document.getElementById('city-1'); const zip = document.getElementById('postalCode-1');
      city.value = 'Mica'; zip.value = '00000';
      const wire = (input, rows) => {
        const grid = document.getElementById(input.id + '-listbox');
        const draw = () => {
          grid.innerHTML = '';
          for (const t of rows().filter((r) => !input.__typed || r.toLowerCase().includes(input.__typed.toLowerCase()))) {
            const row = document.createElement('div'); row.setAttribute('role', 'row');
            const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.className = 'cx-select__list-item ';
            cell.innerHTML = '<div class="cx-select__list-item-container"><span class="cx-select__list-item--content"><span>' + t + '</span></span></div>';
            cell.addEventListener('click', () => { input.value = input === city ? t.split(',')[0].trim() : t; grid.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); if (input === city) zip.value = ''; });
            row.appendChild(cell); grid.appendChild(row);
          }
          input.setAttribute('aria-expanded', 'true');
        };
        input.addEventListener('mousedown', () => { input.__typed = ''; draw(); });
        input.addEventListener('input', () => { input.__typed = input.value; draw(); });
      };
      wire(city, () => CITIES);
      wire(zip, () => ZIPS[city.value] || []);
    })();<\/script>`, { armed: true, auto: true, choose: true });
  const got = await page.evaluate(() => ({ city: document.getElementById('city-1').value, zip: document.getElementById('postalCode-1').value, street: document.getElementById('a1').value }));
  assert.equal(got.city, 'Springfield', `Mica replaced, and not by Springfield Valley: ${JSON.stringify(got)}`);
  assert.equal(got.zip, '00000, Springfield, Springfield, WA', `the ZIP the City change emptied came back: ${JSON.stringify(got)}`);
  assert.equal(got.street, '456 Example Ave', 'his street line is his');
});

test('F-735: an Oracle date\'s MONTH and YEAR share one name, and each gets its own list (Nokia, 2026-10-16)', async () => {
  const sel = (part, opts) => `
    <span id="lab-${part}">${part === 'month' ? 'Month' : 'Year'}</span>
    <div class="cx-select-container"><input id="${part}-startDate-42" name="startDate" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid"
      aria-controls="${part}-startDate-42-listbox" aria-expanded="false" aria-labelledby="sd-l lab-${part}" class="cx-select-input"></div>
    <div id="${part}-startDate-42-listbox" role="grid" class="cx-select__list" style="display:none">${opts.map((o) =>
      `<div role="row"><div role="gridcell" class="cx-select__list-item "><div class="cx-select__list-item-container"><span class="cx-select__list-item--content">${o}</span></div></div></div>`).join('')}</div>`;
  await fill(`<form><span id="sd-l">Start Date</span>
    ${sel('month', ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August'])}
    ${sel('year', ['2027', '2026', '2025', '2024', '2023'])}</form>
    <script>(() => {
      for (const part of ['month', 'year']) {
        const box = document.getElementById(part + '-startDate-42'); const grid = document.getElementById(part + '-startDate-42-listbox');
        const open = () => { grid.style.display = 'block'; box.setAttribute('aria-expanded', 'true'); };
        box.addEventListener('mousedown', open); box.addEventListener('click', open); box.addEventListener('focus', open);
        grid.addEventListener('click', (e) => { const c = e.target.closest('[role=gridcell]'); if (!c) return; box.value = c.textContent.trim(); grid.style.display = 'none'; box.setAttribute('aria-expanded', 'false'); });
      }
    })();<\/script>`, { editPlan: `(plan) => { for (const a of plan.actions) {
      if (/Month/.test(a.label)) Object.assign(a, { action: 'prompt', value: 'May', promptKind: 'combo' });
      else if (/Year/.test(a.label)) Object.assign(a, { action: 'prompt', value: '2026', promptKind: 'combo' }); } return plan; }` });
  const got = await page.evaluate(() => [document.getElementById('month-startDate-42').value, document.getElementById('year-startDate-42').value]);
  assert.deepEqual(got, ['May', '2026'], 'the year went into the YEAR box');
});

test('ANOTHER FIELD\'S OPEN LIST IS NEVER READ AS THIS ONE\'S (John Deere Eightfold, F-697)', async () => {
  // Veteran's list (list-30) is still open; State names list-32, which opens
  // only on a mousedown. State must open its own and take Washington.
  await fill(`
    <form>
      <label id="st-l" for="input-34">State / Province</label>
      <input id="input-34" role="combobox" aria-controls="list-32" aria-expanded="false" aria-labelledby="st-l" type="text">
      <ul id="list-32" role="listbox" style="display:none"><li role="option">Oregon</li><li role="option">Washington</li></ul>
      <ul id="list-30" role="listbox"><li role="option">I am not a Veteran</li><li role="option">I prefer not to answer</li></ul>
      <input aria-controls="list-30" role="combobox" style="position:absolute;left:-9999px">
    </form>
    <script>(() => {
      const box = document.getElementById('input-34'); const list = document.getElementById('list-32');
      box.addEventListener('mousedown', () => { list.style.display = 'block'; box.setAttribute('aria-expanded', 'true'); });
      list.addEventListener('click', (e) => { const r = e.target.closest('[role=option]'); if (!r) return; box.value = r.textContent; list.style.display = 'none'; });
    })();<\/script>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/state/i.test(a.label)) { a.action = 'prompt'; a.value = 'Washington'; a.promptKind = 'combo'; } return plan; }` });
  assert.equal(await page.evaluate(() => document.getElementById('input-34').value), 'Washington');
});

test('F-716: a dropdown that cannot open while the page redraws gets a second try once it settles (Lam, signed in)', async () => {
  // Lam's signed-in form loads his saved profile after the page appears; until
  // then this list ignores every open. The first pass finds no rows; the
  // second try, after the page settles, must open it and CLICK Washington.
  await fill(`
    <form>
      <label id="st-l" for="input-34">State / Province</label>
      <input id="input-34" role="combobox" aria-controls="list-32" aria-expanded="false" aria-labelledby="st-l" type="text">
      <ul id="list-32" role="listbox" style="display:none"><li role="option">Oregon</li><li role="option">Washington</li></ul>
    </form>
    <script>(() => {
      const box = document.getElementById('input-34'); const list = document.getElementById('list-32');
      const readyAt = Date.now() + 3500;
      box.addEventListener('mousedown', () => { if (Date.now() < readyAt) return; list.style.display = 'block'; box.setAttribute('aria-expanded', 'true'); });
      // Typed text is not an answer here: only a clicked row is.
      box.addEventListener('input', () => { box.value = ''; });
      list.addEventListener('click', (e) => { const r = e.target.closest('[role=option]'); if (!r) return; window.__clicked = r.textContent; box.value = r.textContent; list.style.display = 'none'; });
    })();<\/script>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/state/i.test(a.label)) { a.action = 'prompt'; a.value = 'Washington'; a.promptKind = 'combo'; } return plan; }` });
  assert.equal(await page.evaluate(() => window.__clicked || ''), 'Washington');
  assert.equal(await page.evaluate(() => document.getElementById('input-34').value), 'Washington');
});

test('a combobox is never left with a stray value when the pick fails', async () => {
  // A dropdown that shows "Alex" in its search box reads, to the human opening
  // the application, as an answer nobody gave.
  await fill(comboFixture('Country', ['Narnia']));
  assert.equal(await page.evaluate(() => document.getElementById('q').value), '');
});

/**
 * A page that REFORMATS a value has kept it.
 *
 * The read-back check added this session turned three silent failures into
 * visible ones — and produced one of its own. `Phone (the page did not keep the
 * value)` appeared on two live Greenhouse forms where the phone was filled
 * perfectly: Greenhouse uses `intl-tel-input`, which rewrites
 * "+1 (555) 000-0000" as "+1 (555) 000-0000". Strict equality called that a
 * failure and did not count it.
 */
test('A REFORMATTED VALUE COUNTS AS FILLED', async () => {
  const result = await fill(`
    <form>
      <label for="phone">Phone</label>
      <input id="phone" type="tel">
      <script>(() => {
        const el = document.getElementById('phone');
        // Stand-in for intl-tel-input: strips the brackets, keeps the number.
        el.addEventListener('input', () => {
          const v = el.value;
          const tidy = v.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
          if (tidy !== v) el.value = tidy;
        });
      })();<\/script>
    </form>`);

  const got = await page.evaluate(() => document.getElementById('phone').value);
  assert.ok(got, 'the page kept a value');
  assert.notEqual(got, '+1 (555) 000-0000', 'and reformatted it, which is the point of this test');
  assert.equal(result.filled, 1, 'a reformat is not a rejection');
  assert.equal((result.unanswered || []).length, 0, 'and must not be reported as a failure');
});

test('a phone the page rewrites with or without its country code counts as filled (ADP, 2026-10-16)', async () => {
  const result = await fill(`
    <form>
      <label for="phone">Phone</label>
      <input id="phone" type="tel">
      <script>(() => {
        const el = document.getElementById('phone');
        // ADP's box keeps the national number in its own spacing, country code elsewhere.
        el.addEventListener('input', () => { const d = el.value.replace(/\\D/g, '').replace(/^1(?=\\d{10}$)/, ''); const t = d.length === 10 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : d; if (t !== el.value) el.value = t; });
      })();<\/script>
    </form>`);
  const got = await page.evaluate(() => document.getElementById('phone').value);
  assert.equal(got, '555 000 0000', 'the page reformatted it without the +1');
  assert.equal(result.filled, 1, 'a reformat that drops the country code is not a rejection');
  assert.equal((result.unanswered || []).length, 0);
});

test('a value the page DISCARDS is still reported', async () => {
  // The other half. If everything counted, the check would be worthless.
  const result = await fill(`
    <form>
      <label for="phone">Phone</label>
      <input id="phone" type="tel">
      <script>(() => {
        const el = document.getElementById('phone');
        el.addEventListener('input', () => { el.value = ''; });
      })();<\/script>
    </form>`);
  assert.equal(result.filled, 0);
  assert.ok((result.unanswered || []).some((u) => /did not keep/.test(String(u.label || u))),
    'a discarded value must be named');
});

/**
 * Clicking a checked box unchecks it.
 *
 * The conditional second pass re-runs the same action, and on a live Torc form
 * that toggled the export-control "None/Not applicable" box back OFF — the
 * fourth time this session that repeating correct work has undone it.
 */
test('A SECOND PASS DOES NOT UNTICK A BOX IT ALREADY TICKED', async () => {
  await fill(`
    <form>
      <fieldset>
        <legend>Are you a citizen of any of the following?</legend>
        <label for="cuba">Cuba</label><input id="cuba" type="checkbox" name="ec">
        <label for="none">None/Not applicable</label><input id="none" type="checkbox" name="ec">
      </fieldset>
    </form>`);
  const state = await page.evaluate(() => ({
    none: document.getElementById('none').checked,
    cuba: document.getElementById('cuba').checked,
  }));
  assert.equal(state.none, true, 'the honest answer must still be ticked after every pass');
  assert.equal(state.cuba, false, 'and no country may be ticked');
});

/**
 * The second pass may only see fields the first pass never saw.
 *
 * The Playwright driver has always kept a `handled` set and filtered each
 * rescan through it, so a field filled once is never touched again. The
 * extension was written fresh, re-planned EVERY field on its second pass, and
 * re-made four bugs that path had already paid to fix: a combobox re-prompted
 * and wiped, a ticked box toggled off, a committed value cleared by a
 * "leave nothing behind" cleanup, and an answer overwritten by its own retry.
 *
 * Each was fixed where it surfaced. This pins the structural version, which is
 * what makes the whole class impossible rather than fixed four times.
 */
test('THE SECOND PASS IS HANDED ONLY THE REVEALED FIELDS', () => {
  const src = readFileSync(path.join(HERE, 'content.js'), 'utf-8');

  assert.match(src, /async function fillCurrentStep\(only = null/,
    'it must be able to take a subset at all');
  // (F-798 added a third case, a restricted re-plan on top of a pre-filled
  // page; the subset still wins over re-reading the page.)
  assert.match(src, /const fields = (?:restrict \? context : )?\(?only \|\| discover\(\)/,
    'and use that subset instead of re-reading the page');
  assert.match(src, /await fillCurrentStep\(revealed, \{ keepExisting: auto, entries: false, readBack: true(?:, context: discover\(\))? \}\)/,
    'the second pass must pass the revealed fields, not re-plan everything — under the same follow-along rule as the first');

  // The guard: `revealed` has to be what its name says.
  // …counted, not a set (F-611): a row the pass added repeats the labels of
  // the row before it, and those fields are new all the same.
  assert.match(src, /const revealed = discover\(\)\.filter\(\(f\) => \{/,
    'revealed means "more of this label than the first pass saw"');
  assert.match(src, /if \(n > \(seenCount\.get\(k\) \|\| 0\)\) return true;/);
  // …plus a list that was empty on the first pass and still unanswered (Honda's
  // State, 2026-10-02) — and nothing else that was already there.
  assert.match(src, /return starved\.has\(k\) && el\?\.tagName === 'SELECT' && el\.options\.length > 2 && !el\.value;/);
});

test('A REVEALED FIELD WITH A LABEL ALREADY ON THE PAGE IS STILL ANSWERED (HP, F-611)', async () => {
  // Answering the first row's Overall adds a second row with its own Overall —
  // the shape of HP's language rows, where the second stayed empty and
  // Workday refused the step.
  await fill(`
    <label for="o1">Overall</label>
    <select id="o1"><option>Select One</option><option>3 - Intermediate</option><option>4 - Fluent</option></select>
    <div id="more"></div>
    <script>document.getElementById('o1').addEventListener('change', () => { if (!document.getElementById('o2')) document.getElementById('more').innerHTML = '<label for="o2">Overall</label><select id="o2"><option>Select One</option><option>3 - Intermediate</option><option>4 - Fluent</option></select>'; });<\/script>`);
  assert.equal(await page.evaluate(() => document.getElementById('o1').value), '4 - Fluent');
  assert.equal(await page.evaluate(() => document.getElementById('o2')?.value), '4 - Fluent', 'the second row\'s Overall is answered too');
});

// ── the button-only Workday dropdown, driven for real (F-297) ─────────
//
// Nothing in this suite exercised promptKind 'single' at all. Discovery is
// proven elsewhere and planning is proven elsewhere; this is the place the two
// meet, and a trigger that is a <button> rather than an <input> had never been
// clicked by the shipped content.js in any test.

/** Workday's questionnaire dropdown: a trigger, and a listbox in a portal. */
const wdPrompt = (id, question, options) => `
  <div data-automation-id="formField-${id}">
    <label>${question} *</label>
    <button id="trigger-${id}" aria-haspopup="listbox" aria-controls="lb-${id}"
            aria-expanded="false">Select One</button>
  </div>
  <ul id="lb-${id}" role="listbox" style="display:none">
    ${options.map((o) => `<li role="option">${o}</li>`).join('')}
  </ul>
  <script>
    (() => {
      const t = document.getElementById('trigger-${id}');
      const lb = document.getElementById('lb-${id}');
      t.addEventListener('click', () => {
        lb.style.display = lb.style.display === 'none' ? 'block' : 'none';
      });
      lb.addEventListener('click', (e) => {
        const row = e.target.closest('[role="option"]');
        if (!row) return;
        t.textContent = row.textContent;   // Workday commits into the trigger
        lb.style.display = 'none';
      });
    })();
  </script>`;

test('A WORKDAY DROPDOWN WITH NO INPUT BEHIND IT IS ACTUALLY FILLED', async () => {
  const result = await fill(`
    <form>
      ${wdPrompt('sponsorship',
    'Do you now, or will you in the future, require visa sponsorship to work for Jabil in the United States (for example H-1B, TN, L-1, etc.)?',
    ['Yes', 'No'])}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`);

  const committed = await page.evaluate(
    () => document.getElementById('trigger-sponsorship').textContent.trim(),
  );
  assert.equal(committed, 'Yes', 'the trigger must carry the answer, not the placeholder');
  assert.equal(result.filled, 1, 'and it must be COUNTED — an uncounted fill reads as a miss');
  assert.deepEqual(result.unanswered, [], 'nothing to report when it worked');
});

test('a dropdown whose list has no matching row is REPORTED, never claimed', async () => {
  // The direction that costs an application is a report saying more happened
  // than did. A list that cannot answer must leave the field named.
  const result = await fill(`
    <form>
      ${wdPrompt('odd', 'Do you now, or will you in the future, require visa sponsorship?',
    ['Maybe later', 'Prefer not to say'])}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`);

  const committed = await page.evaluate(
    () => document.getElementById('trigger-odd').textContent.trim(),
  );
  assert.equal(committed, 'Select One', 'nothing was chosen');
  assert.equal(result.filled, 0, 'and nothing may be counted');
  assert.ok(result.unanswered.some((u) => /sponsorship/i.test(u)),
    'the question must appear in what is left for him');
});

test('A LANGUAGE DROPDOWN TAKES ITS TOP RUNG, AND A MISS SAYS WHAT WAS ON OFFER (F-551)', async () => {
  // "everything should be fluent" — whatever the tenant calls the top.
  const result = await fill(`
    <form>
      ${wdPrompt('speak', 'Speaking', ['Low', 'Medium', 'High'])}
      ${wdPrompt('read', 'Reading', ['Two', 'Three'])}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`);
  const got = await page.evaluate(() => ({
    speak: document.getElementById('trigger-speak').textContent.trim(),
    read: document.getElementById('trigger-read').textContent.trim(),
  }));
  assert.equal(got.speak, 'High', 'the top of a Low/Medium/High scale');
  assert.equal(got.read, 'Select One', 'a list with no ladder in it is not guessed at');
  const miss = result.unanswered.find((u) => /Reading/.test(u)) || '';
  assert.match(miss, /the list offered: Two \| Three/, 'the report names what the list held');
});

test('THE SECOND LANGUAGE ROW\'S LADDERS ARE ANSWERED, THOUGH THEY SHARE ROW 1\'S KEYS (Flowserve, F-670)', async () => {
  // Workday repeats a field's formField- key in every added row; only the
  // trigger's id ("language-396--…", "language-397--…") differs. Row 2's
  // Reading/Speaking/Writing were skipped as already seen, and the step was
  // refused on all three.
  const ladder = ['1 - Beginner', '3 - Intermediate', '5 - Fluent'];
  const row = (n, field) => `
    <div data-automation-id="formField-6f7f${field}">
      <label>${field[0].toUpperCase()}${field.slice(1)} *</label>
      <button id="language-${n}--6f7f${field}" aria-haspopup="listbox" aria-controls="lb-${n}-${field}" aria-expanded="false">Select One</button>
      <input type="text" style="display:none">
    </div>
    <ul id="lb-${n}-${field}" role="listbox" style="display:none">${ladder.map((o) => `<li role="option">${o}</li>`).join('')}</ul>`;
  const fields = ['reading', 'speaking', 'writing'];
  await fill(`
    <form>
      <h3>Languages 1</h3>${fields.map((f) => row(396, f)).join('')}
      <h3>Languages 2</h3>${fields.map((f) => row(397, f)).join('')}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <script>
      for (const t of document.querySelectorAll('button[aria-haspopup]')) {
        const lb = document.getElementById(t.getAttribute('aria-controls'));
        t.addEventListener('click', () => { lb.style.display = lb.style.display === 'none' ? 'block' : 'none'; });
        lb.addEventListener('click', (e) => { const r = e.target.closest('[role="option"]'); if (!r) return; t.textContent = r.textContent; lb.style.display = 'none'; });
      }
    <\/script>`);
  const got = await page.evaluate(() => [...document.querySelectorAll('button[aria-haspopup]')].map((b) => `${b.id.split('--')[0]} ${b.textContent.trim()}`));
  assert.deepEqual(got, [
    'language-396 5 - Fluent', 'language-396 5 - Fluent', 'language-396 5 - Fluent',
    'language-397 5 - Fluent', 'language-397 5 - Fluent', 'language-397 5 - Fluent',
  ]);
});

// ── F-618: a menu opened from a button, 2026-09-27 ────────────────────────
//
// HP's Degree menu spells a bachelor's "Bachelors (±16 years of education)",
// and the button path looked only for "Bachelor of Science" — every HP and
// HPE fill said "could not set". Hyve's "How Did You Hear About Us?" took 25 s
// because each spelling reopened the menu and waited out its cap. And a click
// was reported as a commit: Samsung's Reading went out empty, unreported.

/** A Workday prompt whose rows ignore the first `ignore` clicks (Infinity: every click). */
const wdPromptStubborn = (id, question, options, ignore) => `
  <div data-automation-id="formField-${id}">
    <label>${question} *</label>
    <button id="trigger-${id}" aria-haspopup="listbox" aria-controls="lb-${id}" aria-expanded="false">Select One</button>
  </div>
  <ul id="lb-${id}" role="listbox" style="display:none">
    ${options.map((o) => `<li role="option">${o}</li>`).join('')}
  </ul>
  <script>
    (() => {
      const t = document.getElementById('trigger-${id}');
      const lb = document.getElementById('lb-${id}');
      let clicks = 0;
      t.addEventListener('click', () => { lb.style.display = lb.style.display === 'none' ? 'block' : 'none'; });
      lb.addEventListener('click', (e) => {
        const row = e.target.closest('[role="option"]');
        if (!row) return;
        clicks += 1;
        lb.style.display = 'none';
        if (clicks > ${ignore === Infinity ? 'Infinity' : ignore}) t.textContent = row.textContent;
      });
    })();
  </script>`;

test('F-735: a degree menu of abbreviations takes "B. Sc." for a Bachelor of Science (KION, 2026-10-16)', async () => {
  const kion = ['Secondary School', 'HS', 'Apprenticeship', 'B. A.', 'B. Eng.', 'B. Sc.', 'LL. B.', 'M. A.', 'M. Eng.', 'M. Sc.', 'MBA', 'PhD'];
  const result = await fill(`
    <form>
      ${wdPrompt('degree', 'Degree', kion)}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, {
    editPlan: `(plan) => { for (const a of plan.actions) if (a.label === 'Degree') Object.assign(a, { action: 'prompt', value: 'Bachelor of Science', values: ['Bachelor of Science', "Bachelor's", 'Bachelors', "Bachelor's Degree", 'Bachelor', 'B. Sc.', 'B.Sc.', 'BSc', 'B.S.', 'BS'] }); return plan; }`,
  });
  const got = await page.evaluate(() => document.getElementById('trigger-degree').textContent.trim());
  assert.equal(got, 'B. Sc.');
  assert.deepEqual(result.unanswered.filter((u) => /Degree/.test(u)), []);
});

test('F-618: a button menu takes the form\'s own spelling of his degree, in one opening', async () => {
  const hp = ['Other (other type of degree or diploma)', 'High School or GED (±11 years of education)', 'Technical Diploma (±12 years of education)', 'Associates (±14 years of education)', 'Bachelors (±16 years of education)', 'Masters (±18 years of education)'];
  const began = Date.now();
  const result = await fill(`
    <form>
      ${wdPrompt('degree', 'Degree', hp)}
      ${wdPrompt('source', 'How Did You Hear About Us?', ['Company Career Site', 'Employee Referral', 'Recruiter', 'Other'])}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, {
    // The plan HP's Degree got on 2026-09-27, word for word.
    editPlan: `(plan) => { for (const a of plan.actions) if (a.label === 'Degree') Object.assign(a, { action: 'prompt', value: 'Bachelor of Science', values: ['Bachelor of Science', "Bachelor's", 'Bachelors', "Bachelor's Degree", 'Bachelor'] }); return plan; }`,
  });
  const took = Date.now() - began;
  const got = await page.evaluate(() => ({
    degree: document.getElementById('trigger-degree').textContent.trim(),
    source: document.getElementById('trigger-source').textContent.trim(),
  }));
  assert.equal(got.degree, 'Bachelors (±16 years of education)');
  assert.equal(got.source, 'Company Career Site', 'a tenant without LinkedIn lands on its career site');
  assert.deepEqual(result.unanswered.filter((u) => /Degree|Hear/.test(u)), []);
  assert.ok(took < 12000, `two menus, not two dozen openings: ${took} ms`);
});

test('F-618: "No" is never found inside "NOT" — HP\'s veteran menu', async () => {
  const vets = ['I DO NOT WISH TO SELF-IDENTIFY', 'I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN', 'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE', 'I am not a Veteran.'];
  await fill(`
    <form>
      ${wdPrompt('vet1', 'Are you a protected U.S. Military Veteran?', vets)}
      ${wdPrompt('vet2', 'Veteran status', vets)}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, {
    // 2026-09-26: the export rule's "No"; 2026-09-27: two answers joined by a comma.
    editPlan: `(plan) => { for (const a of plan.actions) { if (a.label.startsWith('Are you')) Object.assign(a, { action: 'prompt', value: 'No', values: undefined }); if (a.label === 'Veteran status') Object.assign(a, { action: 'prompt', value: 'I am not a Veteran.', values: ['I am not a Veteran.', 'I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN'] }); } return plan; }`,
  });
  const got = await page.evaluate(() => [document.getElementById('trigger-vet1').textContent.trim(), document.getElementById('trigger-vet2').textContent.trim()]);
  assert.ok(!/I IDENTIFY AS/.test(got[0]), `"No" must not claim veteran status: ${got[0]}`);
  assert.equal(got[1], 'I am not a Veteran.');
});

test('KLA, 2026-09-24: an answer that is none of a Yes/No menu\'s rows never commits "Yes" (F-623)', async () => {
  await fill(`
    <form>
      ${wdPrompt('hisp', 'Are you Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race.', ['Yes', 'No'])}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, {
    // The plan that day: his race, given to the Hispanic question.
    editPlan: `(plan) => { for (const a of plan.actions) if (/Hispanic/.test(a.label)) Object.assign(a, { action: 'prompt', value: 'Asian', values: undefined }); return plan; }`,
  });
  const got = await page.evaluate(() => document.getElementById('trigger-hisp').textContent.trim());
  assert.notEqual(got, 'Yes', 'never a claim he did not make');
});

test('F-618: a pick the menu did not keep is tried again, and one it never keeps is reported', async () => {
  const result = await fill(`
    <form>
      ${wdPromptStubborn('read', 'Reading', ['1 - Low', '2 - Medium', '3 - High'], 1)}
      ${wdPromptStubborn('speak', 'Speaking', ['1 - Low', '2 - Medium', '3 - High'], Infinity)}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`);
  const got = await page.evaluate(() => ({
    read: document.getElementById('trigger-read').textContent.trim(),
    speak: document.getElementById('trigger-speak').textContent.trim(),
  }));
  assert.equal(got.read, '3 - High', 'the second opening lands it');
  assert.equal(got.speak, 'Select One');
  assert.ok(result.unanswered.some((u) => /Speaking/.test(u)), `an empty ladder is never counted as filled: ${JSON.stringify(result.unanswered)}`);
  assert.ok(!result.unanswered.some((u) => /Reading/.test(u)), 'the one that landed is not reported');
});

test('F-550: A BOX WORKDAY LOST IS RE-ENTERED THE WAY HE DOES IT BY HAND', async () => {
  // "sth is filled but workday still says unfilled or required" (2026-09-24).
  // The fixture's model, like Workday's, only takes a change from a real
  // editing event; the box shows "Blue" and the model is empty, so the field
  // wears its "required" error. His fix is delete one letter and retype it.
  const result = await fill(`
    <form>
      <div data-automation-id="formField-favouriteColour">
        <label for="fc">Favourite colour *</label>
        <input id="fc" aria-required="true" aria-invalid="true" value="Blue">
        <div data-automation-id="errorMessage" id="fc-err">The field Favourite colour is required and must have a value.</div>
      </div>
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <script>
      window.__model = '';
      const box = document.getElementById('fc');
      box.addEventListener('input', (e) => { if (e.inputType) window.__model = box.value; });
      box.addEventListener('blur', () => {
        const ok = window.__model.trim() !== '';
        box.setAttribute('aria-invalid', ok ? 'false' : 'true');
        const err = document.getElementById('fc-err');
        if (ok && err) err.remove();
      });
    <\/script>`);
  const got = await page.evaluate(() => ({ model: window.__model, box: document.getElementById('fc').value, err: !!document.getElementById('fc-err') }));
  assert.equal(got.box, 'Blue', 'what the box says never changes');
  assert.equal(got.model, 'Blue', 'and the form now holds it too');
  assert.equal(got.err, false, 'so the required error is gone');
  assert.equal(result.unanswered.some((u) => /still flags/.test(u)), false);
});

test('THE TRIGGER IS CLICKED AND SAVE AND CONTINUE IS NOT', async () => {
  // The wrapper pass hands content.js a bare <button> to click. This pins that
  // the one it clicks is the dropdown's and never the form's.
  await page.setContent(`
    <form>
      ${wdPrompt('age', 'Please indicate if you are 18 years of age or older', ['Yes', 'No'])}
      <button id="nav" data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <script>
      window.__navClicks = 0;
      document.getElementById('nav').addEventListener('click', (e) => {
        e.preventDefault(); window.__navClicks += 1;
      });
    </script>`);
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg, reply) => {
          if (msg.type === 'plan') reply({ ok: true, plan: await globalThis.__jarvisPlan(msg.fields) });
          else reply({ ok: false, error: 'unknown' });
        },
      },
    };
  });
  await page.evaluate(CONTENT);

  assert.equal(await page.evaluate(() => window.__navClicks), 0,
    'Save and Continue is his — nothing here may press it');
});

// ── following him ───────────────────────────────────────────────────
//
// One press arms the tab. From then on the worker re-injects on every page
// and the page's own watcher picks up the next step; neither may write over a
// value already on the form, because it is either ours or his correction.

/** Like fill(), but the page is told what kind of run this is, and every message it sends is kept. */
async function fillAs(html, run, url = '') {
  // `url`: served from a real origin, so sessionStorage — the tab's memory of
  // steps it filled — outlives a reload (F-888).
  if (url) {
    await page.unroute(url).catch(() => {});
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
  } else {
    await page.goto('about:blank');   // a fresh document, see fill()
    await page.setContent(html);
  }
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate((ctx) => {
    globalThis.__jarvisRun = ctx;
    globalThis.__sent = [];
    globalThis.chrome = {
      runtime: {
        // A worker the page can reach (its listeners install only then), when a test asks.
        ...(ctx.reachable ? { id: 'jarvis-test' } : {}),
        sendMessage: async (msg, reply) => {
          globalThis.__sent.push(JSON.parse(JSON.stringify(msg)));
          if (msg.type === 'plan') reply({ ok: true, plan: await globalThis.__jarvisPlan(msg.fields) });
          else if (msg.type === 'resume') reply({ ok: true, bytes: await globalThis.__jarvisResume() });
          // As the worker answers: with the tab's `started` (background.js 'posting'),
          // or a refusal when a test says the server would not take the page.
          else if (msg.type === 'posting') reply(ctx.postingRefused ? { ok: false, status: 404, error: 'couldn\'t read this page\'s job title' } : { ok: true, id: 'from-page', status: 'tailoring', company: 'Acme', tailored: true, ...(typeof ctx.started === 'boolean' ? { started: ctx.started } : {}) });
          // Is the tab still armed? (F-990) Only when a test says what the worker would answer.
          else if (msg.type === 'still-armed' && typeof ctx.stillArmed === 'boolean') reply({ ok: true, armed: ctx.stillArmed });
          // A list's rows are matched by the real matcher only when a test asks (F-883).
          else if (msg.type === 'choose' && ctx.choose) { const index = await globalThis.__jarvisChoose(msg.want, msg.options); reply({ ok: true, index, value: index >= 0 ? msg.options[index] : null }); }
          else reply({ ok: true });
        },
      },
    };
  }, run);
  return page.evaluate(CONTENT);
}

const sent = () => page.evaluate(() => globalThis.__sent);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Four fields, so a run nobody clicked for believes it is an application.
const FOUR = `
    <label for="first_name">First Name</label><input id="first_name">
    <label for="last_name">Last Name</label><input id="last_name">
    <label for="email">Email</label><input id="email">
    <label for="phone">Phone</label><input id="phone">`;

test('F-573: a NEW step under the same heading is filled; the step he comes Back to is not', async () => {
  // Wayve's firststage flow (2026-09-24): "Upload CV" and then its questions,
  // on one path under one heading. The follow-along run called the questions
  // "a step Jarvis already filled" when only the CV had gone in. And the other
  // way (F-562, Western Digital): Back to a filled step, redrawn with one more
  // copy of a box, must still read as the step he is reviewing.
  const A = `<h2>Apply</h2>${FOUR}`;
  await fillAs(A, { armed: true, auto: false });
  const plans = async () => (await sent()).filter((m) => m.type === 'plan').length;
  const before = await plans();
  await page.evaluate(() => {
    document.body.innerHTML = '<h2>Apply</h2><label for="q1">Why this role?</label><textarea id="q1"></textarea>'
      + '<label for="q2">Portfolio link</label><input id="q2"><label for="q3">Notice period</label><input id="q3">'
      + '<label for="q4">Desired salary</label><input id="q4">';
    globalThis.__jarvisRun = { armed: true, auto: true };
  });
  const next = await page.evaluate(CONTENT);
  assert.doesNotMatch(String(next?.stoppedBecause || ''), /already filled/, 'a different step is not the one filled');
  assert.ok(await plans() > before, 'the new step was planned');

  await page.evaluate((html) => {
    document.body.innerHTML = `${html}<label for="email2">Email</label><input id="email2">`;
    globalThis.__jarvisRun = { armed: true, auto: true };
  }, A);
  const back = await page.evaluate(CONTENT);
  assert.match(String(back?.stoppedBecause || ''), /already filled/, 'the step he came back to is his to review');
});

test('F-925: a work-authorization answer the SITE saved (never seen by this tab) is answered from his files; his own change after that stays', async () => {
  // Honeywell's Oracle form, 2026-10-25: the pills from his earlier application
  // were pressed when the page opened — sponsorship "No" — and the follow-along
  // run kept them as his.
  const FORM = `${FOUR}
    <fieldset><legend>Will you now or in the future require visa sponsorship to work in the United States?</legend>
      <label for="sy">Yes</label><input type="radio" name="sp" id="sy" value="Yes">
      <label for="sn">No</label><input type="radio" name="sp" id="sn" value="No" checked>
    </fieldset>`;
  await fillAs(FORM, { armed: true, auto: true, id: 'job-1' });
  const first = await page.evaluate(() => document.querySelector('input[name=sp]:checked')?.value);
  assert.equal(first, 'Yes', 'the saved "No" is replaced by his answer');
  // He changes it by hand; the next follow-along run keeps it.
  await page.evaluate(() => { document.getElementById('sn').checked = true; });
  await page.evaluate(CONTENT);
  const second = await page.evaluate(() => document.querySelector('input[name=sp]:checked')?.value);
  assert.equal(second, 'No', 'after a run has planned it, the box is his');
});

test('A RUN HE DID NOT START NEVER WRITES OVER WHAT IS ON THE FORM', async () => {
  // After the first pass, everything on the form is either what we wrote or
  // what he corrected by hand, and there is no telling them apart. He fixes a
  // phone number the form rejected, presses Save and Continue himself, and the
  // follow-along run must not begin by putting the rejected number back.
  const FORM = `
    <label for="first_name">First Name</label><input id="first_name" value="Vincent">
    <label for="email">Email</label><input id="email">
    <label for="g">Gender</label><select id="g"><option>Select</option><option>Male</option><option>Female</option></select>
    <fieldset><legend>Are you legally authorized to work in the United States?</legend>
      <label for="y">Yes</label><input type="radio" name="auth" id="y" value="Yes">
      <label for="n">No</label><input type="radio" name="auth" id="n" value="No" checked>
    </fieldset>
    <script>document.getElementById('g').value = 'Female';
      // "After the first pass": this tab has planned the question before (F-925).
      globalThis.__jarvisSeenFields = new Set([location.pathname + '|Are you legally authorized to work in the United States?']);</script>`;

  const auto = await fillAs(FORM, { armed: true, auto: true, id: 'job-1' });
  const state = await page.evaluate(() => ({
    first: document.getElementById('first_name').value,
    email: document.getElementById('email').value,
    gender: document.getElementById('g').value,
    auth: document.querySelector('input[name=auth]:checked')?.value,
  }));
  assert.equal(state.first, 'Vincent', 'his correction stays');
  assert.equal(state.gender, 'Female', 'his choice stays');
  assert.equal(state.auth, 'No', 'his radio stays, even where the profile disagrees');
  assert.equal(state.email, 'v@example.test', 'a BLANK is still filled');
  assert.equal(auto.filled, 1, 'and only the blank is counted');
  assert.ok(auto.skipped >= 3, 'the rest are skipped — answered, not unanswered');
  assert.ok(!auto.unanswered.some((u) => /First Name|Gender|authorized/i.test(u)),
    'a field he answered is not on the list of things left for him');
  // NOT SILENT. A value the engine would have set differently is named, so he
  // can glance at it before Submit.
  assert.ok(auto.kept.some((k) => /First Name.*Vincent/.test(k)), `kept values are reported: ${JSON.stringify(auto.kept)}`);
  assert.ok(auto.kept.some((k) => /authorized.*No/.test(k)));
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(panel, /left as you had them/);

  // The press he makes himself keeps the behaviour it always had.
  const pressed = await fillAs(FORM, { armed: true, auto: false });
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), 'Alex',
    'a run he started writes the profile, as it did before armed mode existed');
  assert.ok(pressed.filled >= 3);
});

test('THE WATCHER FILLS THE NEXT STEP AFTER HE PRESSES SAVE AND CONTINUE HIMSELF', async () => {
  // Step one has a required question the profile cannot answer, so the walk
  // stops there and the panel names it. He types the answer and presses Save
  // and Continue. Step two used to sit there until he clicked the toolbar
  // again; now the page notices it and fills it.
  const result = await fillAs(`
    <div id="app"></div>
    <script>
      const steps = [
        '<h2>My Information</h2><label for="first_name">First Name</label><input id="first_name">' +
          '<label for="t">Describe your ideal Tuesday</label><input id="t" required>' +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button>',
        '<h2>My Experience</h2><label for="email">Email</label><input id="email">' +
          '<label for="school">School</label><input id="school">' +
          '<label for="phone">Phone</label><input id="phone">' +
          '<label for="last_name">Last Name</label><input id="last_name">' +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button>',
        '<h2>Review</h2><button data-automation-id="pageFooterNextButton">Submit</button>',
      ];
      let i = 0;
      const render = () => {
        document.getElementById('app').innerHTML = steps[i];
        const b = document.querySelector('[data-automation-id="pageFooterNextButton"]');
        if (b && b.textContent === 'Save and Continue') b.onclick = () => {
          // Workday refuses to move while a required field is empty.
          const req = document.querySelector('input[required]');
          if (req && !req.value) return;
          // What the step held when it was left — the DOM is replaced.
          (window.__left = window.__left || []).push(Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.id, el.value])));
          i += 1; render();
        };
        if (b && b.textContent === 'Submit') b.onclick = () => { window.__SUBMITTED = true; };
      };
      render();
    </script>`, { armed: true, auto: false });

  assert.equal(result.steps, 1, 'it could not get past step one');
  assert.ok(result.unanswered.some((u) => /Tuesday/.test(u)), `and said why: ${JSON.stringify(result)}`);
  assert.match(result.stoppedBecause, /stayed on this step/);
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(panel, /Following this tab/, 'the panel says it will keep going');
  assert.match(panel, /Stop following/, 'and how to make it stop');

  // He answers it and moves on himself.
  await page.evaluate(() => {
    document.getElementById('t').value = 'Quiet';
    document.querySelector('[data-automation-id="pageFooterNextButton"]').click();
  });
  assert.equal(await page.evaluate(() => document.querySelector('h2').textContent), 'My Experience');

  // The watcher: 700ms debounce, then settle, then a 3s floor since the last run.
  await wait(9000);
  const after = await page.evaluate(() => ({
    left: window.__left,
    onScreen: document.querySelector('h2').textContent,
    submitted: !!window.__SUBMITTED,
  }));
  assert.equal(after.onScreen, 'Review', `having filled step two, the walk carried on to the last one: ${JSON.stringify(after)}`);
  const stepTwo = after.left[1];
  assert.equal(stepTwo.email, 'v@example.test', 'step two was filled without a click');
  assert.equal(stepTwo.school, 'Lakeside University');
  assert.equal(after.submitted, false, 'SUBMIT IS HIS, on a follow-along run as on any other');

  const msgs = await sent();
  const reports = msgs.filter((m) => m.type === 'filled');
  assert.equal(reports.length, 2, 'every run reports — the press and the follow-along');
  assert.equal(reports[0].result.auto, false);
  assert.equal(reports[1].result.auto, true);
  assert.ok(reports[1].result.filled >= 4);
});

test('a follow-along run does not press Save and Continue on a step that was already his', async () => {
  // Everything on the step was answered before the run arrived. Pressing on
  // would be pressing a button he may have been about to read first.
  await fillAs(`
    <div id="app">
      <h2>Step</h2>
      <label for="first_name">First Name</label><input id="first_name" value="V">
      <label for="last_name">Last Name</label><input id="last_name" value="H">
      <label for="email">Email</label><input id="email" value="a@b.c">
      <label for="phone">Phone</label><input id="phone" value="1">
      <button data-automation-id="pageFooterNextButton" onclick="window.__ADVANCED = true">Save and Continue</button>
    </div>`, { armed: true, auto: true });
  assert.equal(await page.evaluate(() => !!window.__ADVANCED), false);
});

test('an unarmed run installs no watcher and the page is left alone afterwards', async () => {
  await fillAs('<div id="app"><h2>Step 1</h2><label for="a">First Name</label><input id="a"></div>', { armed: false, auto: false });
  await page.evaluate(() => {
    document.getElementById('app').innerHTML = `<h2>Step 2</h2>${'<label for="email">Email</label><input id="email">'}`;
  });
  await wait(5500);
  assert.equal(await page.evaluate(() => document.getElementById('email').value), '',
    'without arming, nothing happens after the run — exactly as before');
  assert.equal(await page.evaluate(() => globalThis.__jarvisContent.state.watching), false);
});

test('INJECTED TWICE INTO ONE DOCUMENT, IT RUNS AGAIN RATHER THAN DOUBLING UP', async () => {
  // A soft navigation keeps the document, so the worker's re-injection lands
  // on a page where everything is already defined. Redefining would start a
  // second watcher beside the first and every step would be filled twice.
  await fillAs(`<h2>Step</h2>${FOUR}`, { armed: true, auto: false });
  // A press again: runs again, same document, one watcher.
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false, reset: true }; });
  const second = await page.evaluate(CONTENT);
  assert.ok(second && typeof second.filled === 'number', 'the second injection still answers with a run');
  const plans = (await sent()).filter((m) => m.type === 'plan').length;
  assert.equal(plans, 2, 'one plan per run, two runs — not a watcher and a run racing');

  // A re-injection nobody clicked for, on a page that has not changed, is
  // noise — a chat widget's iframe reloading — and runs nothing.
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: true }; });
  const third = await page.evaluate(CONTENT);
  assert.equal(third.unchanged, true);
  assert.equal((await sent()).filter((m) => m.type === 'plan').length, 2, 'no third plan');
});

test('THE PAGE TELLS THE WORKER WHAT JOB IT IS, before the first field is typed', async () => {
  await fillAs(`
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Manufacturing Engineer I',
      hiringOrganization: { '@type': 'Organization', name: 'Acme Robotics' },
      description: '<p>Build the line.</p><ul><li>SolidWorks</li><li>GD&amp;T</li></ul>',
      url: 'https://acme.test/jobs/1',
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Boise', addressRegion: 'ID', addressCountry: 'US' } },
    })}</script>
    <h1>Manufacturing Engineer I</h1>
    <form><label for="a">First Name</label><input id="a"></form>`, { armed: true, auto: false });
  const msgs = await sent();
  assert.equal(msgs[0].type, 'posting', 'the posting goes first, so the resume is building before the plan');
  assert.equal(msgs[0].posting.title, 'Manufacturing Engineer I');
  assert.equal(msgs[0].posting.company, 'Acme Robotics');
  assert.match(msgs[0].posting.description, /Build the line\.\s*\n\s*SolidWorks\s*\n\s*GD&T/);
  assert.equal(msgs[0].posting.url, 'https://acme.test/jobs/1');
  assert.equal(msgs[0].posting.location, 'Boise, ID, US');
  assert.equal(msgs[1].type, 'plan');
});

test('a page that says nothing about the job sends no posting', async () => {
  await fillAs(`<h2>My Information</h2><form>${FOUR}</form>`, { armed: true });
  const msgs = await sent();
  assert.ok(!msgs.some((m) => m.type === 'posting'), '"My Information" is a step heading, not a job title');
});

test('A SIGN-IN WALL ON AN ARMED TAB WAITS, AND THE FORM FILLS ONCE HE IS IN', async () => {
  const result = await fillAs(`
    <div id="app">
      <h2>Sign In</h2>
      <label for="e">Email</label><input id="e">
      <label for="p">Password</label><input id="p" type="password">
    </div>`, { armed: true, auto: false });
  assert.equal(result.signInRequired, true);
  assert.equal(await page.evaluate(() => document.getElementById('e').value), '', 'not even the email');
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(panel, /Signing in is yours/);
  assert.match(panel, /fills by itself once you are in/, 'and it says it will carry on, so he does not reach for the button');
  assert.ok(!(await sent()).some((m) => m.type === 'posting'), 'a sign-in page is never read as a posting');

  // He signs in; the tenant swaps the wall for the form in place.
  await page.evaluate((four) => {
    document.getElementById('app').innerHTML = `<h2>My Information</h2>${four}`;
  }, FOUR);
  await wait(7000);
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), 'Alex',
    'the form that appeared after sign-in is filled without a click');
});

test('A VERIFICATION CODE IS HIS TO TYPE', async () => {
  const result = await fillAs(`
    <h2>Check your email</h2>
    <label for="c">Enter the verification code we sent you</label><input id="c" autocomplete="one-time-code">
    <button onclick="window.__PRESSED = true">Continue</button>`, { armed: true, auto: false });
  assert.equal(result.signInRequired, true, 'a code box is a wall, not a one-field form');
  assert.equal(await page.evaluate(() => document.getElementById('c').value), '');
  assert.equal(await page.evaluate(() => !!window.__PRESSED), false, 'and Continue is not pressed for him with the box empty');
});

test('A RUN NOBODY CLICKED FOR DOES NOT START AN APPLICATION HE DID NOT', async () => {
  // He armed the tab on one posting and then browsed to another in it. The
  // new posting is READ — its title goes to the server — and never applied
  // to: the panel says so and the next press is his.
  const result = await fillAs(`
    <h1>Test Engineer</h1>
    <p>${'A long job advert. '.repeat(20)}</p>
    <button id="apply" onclick="window.__APPLIED = true">Apply</button>`, { armed: true, auto: true, started: false });
  assert.equal(result.isPosting, true);
  assert.equal(await page.evaluate(() => !!window.__APPLIED), false, 'Apply was not pressed');
  assert.ok((await sent()).some((m) => m.type === 'posting'), 'but the posting was read');
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(panel, /click Jarvis to apply/i);

  // The same page, on an application HE started (the tab Apply opened, or an
  // intermediate page offering Apply again): followed, once.
  await fillAs(`
    <div id="page"><h1>Test Engineer</h1><p>${'Advert. '.repeat(20)}</p><button id="apply">Apply</button></div>
    <script>document.getElementById('apply').onclick = () => { window.__APPLIED = (window.__APPLIED || 0) + 1;
      document.getElementById('page').innerHTML = '<h1>Test Engineer</h1><p>Still an advert, with another Apply.</p><button id="apply2" onclick="window.__APPLIED += 1">Apply</button>'; };</script>`,
  { armed: true, auto: true, started: true });
  assert.equal(await page.evaluate(() => window.__APPLIED), 1, 'followed once, and not again on the page it revealed');
});

test('F-1013 #12: A "STARTED" TAB ON A POSTING THE SERVER COULD NOT CONFIRM DOES NOT PRESS APPLY', async () => {
  // The tab carries "started" from job A; this page is job B and the server
  // refused it (an unreadable title, a page it could not place). Without the
  // server's word that THIS is his application, Apply is not pressed.
  await fillAs(`
    <h1>Test Engineer</h1><p>${'A long job advert. '.repeat(20)}</p>
    <button id="apply" onclick="window.__APPLIED = true">Apply</button>`, { armed: true, auto: true, started: true, postingRefused: true });
  assert.equal(await page.evaluate(() => !!window.__APPLIED), false, 'Apply was not pressed on an unconfirmed posting');
});

test('a run nobody clicked for fills only what looks like an application', async () => {
  // Under the permissions that make following possible, "a page with a form"
  // includes a vendor's contact form. Three fields and nothing else is not
  // enough reason to type his details into it.
  const result = await fillAs(`
    <h2>Contact us</h2>
    <label for="first_name">First Name</label><input id="first_name">
    <label for="email">Email</label><input id="email">
    <label for="m">Message</label><textarea id="m"></textarea>`, { armed: true, auto: true });
  assert.equal(result.notApplication, true);
  assert.equal(await page.evaluate(() => document.getElementById('email').value), '');
  // His press fills it regardless: the press means "fill this".
  const pressed = await fillAs(`
    <label for="first_name">First Name</label><input id="first_name">
    <label for="email">Email</label><input id="email">`, { armed: true, auto: false });
  assert.equal(pressed.filled, 2);
});

test('"THANK YOU FOR APPLYING" IS REPORTED AS DONE, structured', async () => {
  const result = await fillAs(`
    <h1>Thank you for applying!</h1>
    <p>We have received your application and will be in touch.</p>`, { armed: true, auto: true });
  assert.ok(result.submitted, 'the worker disarms on this, so it must be a field and not prose');
  assert.equal(result.filled, 0);
});

test('HIS SUBMIT, THEN A THANK-YOU THAT ARRIVES LATE, on the same URL — reported as sent (Ashby, Capable 2026-10-02)', async () => {
  await fillAs(`
    <form id="f" onsubmit="return false"><label for="first_name">First Name</label><input id="first_name">
    <label for="email">Email</label><input id="email">
    <button type="submit" id="go">Submit Application</button></form>`, { armed: false, auto: false });
  // The listeners hang on a reachable worker; the harness's stand-in has no id.
  await page.evaluate(() => { globalThis.chrome.runtime.id = 'test'; delete globalThis.__jarvisContent; });
  await page.evaluate(CONTENT);
  // His press (Playwright's click is trusted). The upload takes a while; the
  // form is replaced by the thank-you three seconds later.
  await page.click('#go');
  await page.evaluate(() => setTimeout(() => {
    document.getElementById('f').outerHTML = '<h2>Thank you for applying</h2><p>Your application was successfully submitted.</p>';
  }, 3000));
  await wait(6000);
  const msgs = await sent();
  const done = msgs.find((m) => m.type === 'filled' && m.result?.submitted);
  assert.ok(done, `the confirmation reaches the worker: ${JSON.stringify(msgs.map((m) => m.type))}`);
  assert.match(done.result.submitted, /thank you for applying/i);
});

test('…and a Submit the page refuses (the form stays) reports nothing as sent', async () => {
  await fillAs(`
    <form id="f2" onsubmit="return false"><label for="email2">Email</label><input id="email2">
    <button type="submit" id="go2">Submit Application</button></form>`, { armed: false, auto: false });
  await page.evaluate(() => { globalThis.chrome.runtime.id = 'test'; delete globalThis.__jarvisContent; });
  await page.evaluate(CONTENT);
  await page.click('#go2');
  await wait(4000);
  assert.equal((await sent()).some((m) => m.type === 'filled' && m.result?.submitted), false);
});

test('A REFUSED STEP SENDS THE PAGE\'S RED WORDS to the log, with the box they sit under (his ask, 2026-10-02)', async () => {
  await fillAs(`
    <style>.err{color:#c62828}</style>
    <form id="f3" onsubmit="return false">
      <div><label for="city">City</label><input id="city"><div id="city-err"></div></div>
      <div><label for="phone3">Phone</label><input id="phone3"></div>
      <button type="button" id="next3">Save and Continue</button></form>`, { armed: false, auto: false });
  await page.evaluate(() => { globalThis.chrome.runtime.id = 'test'; delete globalThis.__jarvisContent; });
  await page.evaluate(CONTENT);
  await page.evaluate(() => document.getElementById('next3').addEventListener('click', () => {
    document.getElementById('city-err').innerHTML = '<span class="err">Please select a city from the list</span>';
  }));
  await page.click('#next3');
  await wait(2200);
  const reports = (await sent()).filter((m) => m.type === 'page-errors');
  const hit = reports.flatMap((r) => r.errors.map((e) => ({ ...e, trigger: r.trigger }))).find((e) => /select a city/.test(e.text));
  assert.ok(hit, `the red line reaches the worker: ${JSON.stringify(reports)}`);
  assert.equal(hit.how, 'red');
  assert.match(hit.field, /City/);
  // The run's own walk may press it first; either way the press is named.
  assert.match(hit.trigger, /^after (your|Jarvis's) press of "Save and Continue"$/);
  // …and once only: the 4 s read finds the same line and sends nothing new.
  await wait(2500);
  const again = (await sent()).filter((m) => m.type === 'page-errors').flatMap((r) => r.errors).filter((e) => /select a city/.test(e.text));
  assert.equal(again.length, 1);

  // A message drawn with no press at all (validation on blur) is caught as it appears.
  await page.evaluate(() => { document.querySelector('#phone3').insertAdjacentHTML('afterend', '<p class="err">Enter a valid phone number</p>'); });
  await wait(3500);
  const blur = (await sent()).filter((m) => m.type === 'page-errors' && m.errors.some((e) => /valid phone number/.test(e.text)));
  assert.equal(blur.length, 1, 'a message that appears on its own is logged too');
  assert.match(blur[0].trigger, /appeared/);
});

test('a follow-along run that finds nothing to do leaves the last panel alone', async () => {
  await fillAs(`<h2>Step</h2>${FOUR}`, { armed: true, auto: false });
  const before = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText);
  assert.match(before, /4 filled/);
  // The page re-renders the same step (a validation banner, a tooltip).
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div role="tooltip">hi</div>'); });
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: true }; });
  await page.evaluate(CONTENT);
  const after = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText);
  assert.equal(after, before, 'a "0 filled" panel on every twitch of the page is how a working tool looks broken');
});

test('the stop link on the panel tells the worker, and the watcher stands down', async () => {
  await fillAs(`<h2>Step</h2>${FOUR}`, { armed: true, auto: false });
  assert.equal(await page.evaluate(() => globalThis.__jarvisContent.state.watching), true);
  await page.evaluate(() => document.getElementById('jarvis-overlay').shadowRoot.querySelector('#jarvis-panel #jarvis-stop').click());
  await wait(100);
  assert.ok((await sent()).some((m) => m.type === 'stop'), 'the worker is told');
  assert.equal(await page.evaluate(() => globalThis.__jarvisContent.state.watching), false);
  assert.equal(await page.evaluate(() => !!document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')), false);
});

test('the watcher waits while he is typing', async () => {
  // A trusted keystroke in the last four seconds means the page is his;
  // the run comes once he pauses.
  await fillAs(`
    <div id="app"><h2>Step 1</h2><label for="t">Describe your ideal Tuesday</label><input id="t" required>
    <label for="a">First Name</label><input id="a"><label for="b">Last Name</label><input id="b"><label for="c">Email</label><input id="c">
    <button data-automation-id="pageFooterNextButton" id="n">Save and Continue</button></div>`, { armed: true, auto: false });
  // He is typing (a real key press from Playwright is trusted) as the step changes.
  await page.focus('#t');
  await page.keyboard.type('Qu');
  await page.evaluate((four) => {
    document.getElementById('app').innerHTML = `<h2>Step 2</h2>${four}`;
  }, FOUR);
  await page.keyboard.type('iet');
  await wait(2500);
  assert.equal(await page.evaluate(() => document.getElementById('email').value), '', 'not while he types');
  await wait(6000);
  assert.equal(await page.evaluate(() => document.getElementById('email').value), 'v@example.test', 'once he pauses');
});

test('A DEAD POSTING IS THE WHOLE RESULT — reported, structured, and the tab stands down', async () => {
  // Measured live on a Form Energy posting whose Ashby page reads "Page not
  // found": the walk recognised it and then threw the verdict away, so the
  // panel said "0 filled · not a multi-step application" and the store was
  // never told the job was gone.
  const result = await fillAs(`
    <h1>Page not found</h1><p>The page you requested was not found</p>
    <footer>Powered by Ashby · Privacy Policy · Security</footer>`, { armed: true, auto: false });
  assert.match(result.postingGone || '', /page not found|not found/i, 'the verdict must travel to the worker, which tells the store');
  assert.match(result.stoppedBecause, /gone/);
  const panel = await page.evaluate(() => document.getElementById('jarvis-overlay')?.shadowRoot?.getElementById('jarvis-panel')?.innerText.replace(/\s+/g, ' '));
  assert.match(panel, /gone/, 'and it says so where he reads');
  assert.ok(!/Following this tab/.test(panel), 'there is nothing left to follow');
});

test('A WEB-COMPONENT FORM IS FILLED INSIDE ITS SHADOW ROOTS (F-327)', async () => {
  const result = await fill(`
    <h2>Personal information</h2>
    <x-input id="fn" label="First name"></x-input>
    <x-input id="ln" label="Last name"></x-input>
    <x-input id="em" label="Email" type="email"></x-input>
    <x-input id="ci" label="City"></x-input>
    <div class="simplify-jobs-shadow-root" id="foreign"></div>
    <script>
      customElements.define('x-input', class extends HTMLElement {
        connectedCallback() {
          const r = this.attachShadow({ mode: 'open' });
          r.innerHTML = '<label for="i">' + this.getAttribute('label') + '</label><input id="i" type="' + (this.getAttribute('type') || 'text') + '">';
          // The component keeps its own copy of the value, as Lit does — a
          // value that never raised an input event never reaches it.
          r.querySelector('input').addEventListener('input', (e) => { this.setAttribute('value', e.target.value); });
        }
      });
      document.getElementById('foreign').attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="Search jobs">';
    <\/script>`);
  const got = await page.evaluate(() => ({
    first: document.getElementById('fn').shadowRoot.querySelector('input').value,
    firstSeen: document.getElementById('fn').getAttribute('value'),
    last: document.getElementById('ln').shadowRoot.querySelector('input').value,
    email: document.getElementById('em').shadowRoot.querySelector('input').value,
    foreign: document.getElementById('foreign').shadowRoot.querySelector('input').value,
  }));
  assert.equal(got.first, 'Alex');
  assert.equal(got.firstSeen, 'Alex', 'the component saw the value arrive');
  assert.equal(got.last, 'Rivera');
  assert.ok(got.email.includes('@'));
  assert.equal(got.foreign, '', 'nothing was typed into Simplify\'s search box');
  assert.ok(result.filled >= 3, `filled ${result.filled}`);
  assert.equal(result.notApplication, undefined, 'the page was recognised as an application');
});

/**
 * SmartRecruiters' City, as measured: an ARIA combobox inside a component
 * inside a component; its listbox in the outer component's shadow root; each
 * row a component whose `[role=option]` div is EMPTY because the words come
 * through a <slot> from a host two roots up.
 */
const SHADOW_COMBOBOX = `
  <h2>Personal information</h2>
  <x-input id="fn" label="First name"></x-input>
  <x-input id="ln" label="Last name"></x-input>
  <x-input id="em" label="Email" type="email"></x-input>
  <x-city id="ci" label="City"></x-city>
  <script>
    customElements.define('x-input', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<label for="i">' + this.getAttribute('label') + '</label><input id="i" type="' + (this.getAttribute('type') || 'text') + '">';
      }
    });
    customElements.define('x-row', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div role="option" class="row"><slot></slot></div>'; }
    });
    customElements.define('x-city', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        // The list is a popover, position fixed, as SmartRecruiters' is (F-336).
        r.innerHTML = '<x-input id="inner" label="City"></x-input><div id="menu-city" role="listbox" style="position:fixed;left:0;top:0;background:#fff"></div>';
        const input = r.getElementById('inner').shadowRoot.querySelector('input');
        input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-controls', 'menu-city'); input.setAttribute('aria-expanded', 'false');
        const menu = r.getElementById('menu-city');
        input.addEventListener('input', () => {
          menu.innerHTML = '';
          if (input.value.length < 3) return;
          for (const city of ['Springfield, WA, US', 'Springfield Valley, WA, US', 'Sponsor, TX, US']) {
            if (!city.toLowerCase().startsWith(input.value.toLowerCase())) continue;
            const row = document.createElement('x-row'); row.textContent = city;
            row.addEventListener('click', () => { input.value = city; this.setAttribute('value', city); window.__picked = city; menu.innerHTML = ''; });
            menu.append(row);
          }
          input.setAttribute('aria-expanded', menu.children.length ? 'true' : 'false');
        });
      }
    });
  <\/script>`;

test('A SHADOW-ROOT AUTOCOMPLETE IS PICKED FROM ITS LIST — rows read through their slots (F-331)', async () => {
  const result = await fill(SHADOW_COMBOBOX);
  const got = await page.evaluate(() => ({
    picked: window.__picked || null,
    committed: document.getElementById('ci').getAttribute('value'),
    shown: document.getElementById('ci').shadowRoot.getElementById('inner').shadowRoot.querySelector('input').value,
  }));
  assert.equal(got.picked, 'Springfield, WA, US', `the row for his city was clicked (unanswered: ${JSON.stringify(result.unanswered)})`);
  assert.equal(got.committed, 'Springfield, WA, US', 'and the component committed it');
  assert.equal(got.shown, 'Springfield, WA, US');
});

test('ARIA RADIOS ARE CLICKED AND READ BACK THROUGH aria-checked (F-334)', async () => {
  const result = await fill(`
  <h2>Preliminary questions</h2>
  <x-radio-group id="auth" required>
    <span slot="label-content">Are you legally authorized to work in the United States?</span>
    <x-radio label="Yes" value="1" role="radio" aria-checked="false"></x-radio>
    <x-radio label="No" value="0" role="radio" aria-checked="false"></x-radio>
  </x-radio-group>
  <x-radio-group id="spons">
    <span slot="label-content">Do you now or in the future require sponsorship to work in the United States?</span>
    <x-radio label="Yes" value="1" role="radio" aria-checked="false"></x-radio>
    <x-radio label="No" value="0" role="radio" aria-checked="false"></x-radio>
  </x-radio-group>
  <label role="checkbox" aria-checked="false" id="wrapped"><input type="checkbox" id="real"> I agree to the terms of the privacy notice of Acme</label>
  <script>
    customElements.define('x-radio-group', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label><slot name="label-content"></slot><span aria-hidden="true">*</span></label><div><slot></slot></div>'; }
    });
    customElements.define('x-radio', class extends HTMLElement {
      connectedCallback() {
        this.attachShadow({ mode: 'open' }).innerHTML = '<span class="dot"></span><span>' + this.getAttribute('label') + '</span>';
        this.addEventListener('click', () => {
          // The component re-renders on the next frame, as Lit does.
          setTimeout(() => {
            for (const r of this.parentElement.querySelectorAll('x-radio')) r.setAttribute('aria-checked', String(r === this));
            this.parentElement.setAttribute('value', this.getAttribute('value'));
          }, 20);
        });
      }
    });
  <\/script>`);
  const got = await page.evaluate(() => ({
    auth: [...document.querySelectorAll('#auth x-radio')].map((r) => r.getAttribute('aria-checked')),
    authValue: document.getElementById('auth').getAttribute('value'),
    spons: [...document.querySelectorAll('#spons x-radio')].map((r) => r.getAttribute('aria-checked')),
    real: document.getElementById('real').checked,
  }));
  assert.deepEqual(got.auth, ['true', 'false'], `authorized → Yes (unanswered: ${JSON.stringify(result.unanswered)})`);
  assert.equal(got.authValue, '1', 'the component committed the pick');
  assert.deepEqual(got.spons, ['true', 'false'], 'sponsorship → Yes, from his profile');
  assert.equal(got.real, true, 'the consent box behind the ARIA wrapper is ticked');
  assert.ok(result.filled >= 2, `filled ${result.filled}`);
});

/**
 * SmartRecruiters' Experience section, as measured (F-341): a component
 * heading, an Add button whose name is its aria-label, a sub-form of
 * labelled components (Title/Company/Office location as comboboxes, a
 * Description textarea, From/To date boxes, an "I currently work here" box)
 * and its own Cancel/Save. Save lists the entry and closes the sub-form.
 */
const SR_EXPERIENCE = `
  <h2>Personal information</h2>
  <x-input id="fn" label="First name"></x-input>
  <x-input id="ln" label="Last name"></x-input>
  <x-input id="em" label="Email" type="email"></x-input>
  <x-input id="ci" label="City"></x-input>
  <section id="exp"><x-title>Experience</x-title><x-button id="add-exp" aria-label="Add experience entry"><span>Add</span></x-button><div id="exp-entries"></div><div id="exp-panel"></div></section>
  <section id="edu"><x-title>Education</x-title><x-button id="add-edu" aria-label="Add education entry"><span>Add</span></x-button><div id="edu-entries"></div><div id="edu-panel"></div></section>
  <script>
    customElements.define('x-title', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div class="t"><slot></slot></div>'; } });
    customElements.define('x-input', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<label for="i">' + (this.getAttribute('label') || '') + '</label><input id="i" type="' + (this.getAttribute('type') || 'text') + '"' + (this.hasAttribute('combobox') ? ' role="combobox" aria-autocomplete="list" aria-expanded="false"' : '') + (this.getAttribute('placeholder') ? ' placeholder="' + this.getAttribute('placeholder') + '"' : '') + '>';
      }
      get value() { return this.shadowRoot.querySelector('input').value; }
    });
    customElements.define('x-area', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label for="a">' + this.getAttribute('label') + '</label><textarea id="a"></textarea>'; }
      get value() { return this.shadowRoot.querySelector('textarea').value; }
    });
    customElements.define('x-check', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label for="c"><span aria-hidden="true">*</span><input id="c" type="checkbox"></label><slot name="label-content"></slot>'; }
      get checked() { return this.shadowRoot.querySelector('input').checked; }
    });
    customElements.define('x-button', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<button type="button"><slot></slot></button>';
        r.querySelector('button').addEventListener('click', () => this.dispatchEvent(new CustomEvent('press')));
      }
    });
    const openWork = () => {
      const p = document.getElementById('exp-panel');
      if (p.children.length) return;
      // Title is a SmartRecruiters-style autocomplete: it allows custom
      // values, and its model is its value attribute set by spl-change.
      p.innerHTML = '<x-input id="w-title" label="Title" combobox allowcustomvalues></x-input><x-input id="w-company" label="Company" combobox></x-input><x-input id="w-loc" label="Office location" combobox></x-input>'
        + '<x-area id="w-desc" label="Description"></x-area><x-input id="w-from" label="From" placeholder="Pick a date"></x-input><x-input id="w-to" label="To" placeholder="Pick a date"></x-input>'
        + '<x-check id="w-cur"><span slot="label-content">I currently work here</span></x-check>'
        + '<x-button id="w-cancel" aria-label="Cancel adding experience entry"><span>Cancel</span></x-button><x-button id="w-save" aria-label="Save experience entry"><span>Save</span></x-button>';
      document.getElementById('w-title').addEventListener('spl-change', (e) => { document.getElementById('w-title').dataset.model = e.detail.value; });
      document.getElementById('w-save').addEventListener('press', () => {
        const g = (id) => document.getElementById(id).value;
        const li = document.createElement('div'); li.className = 'entry';
        // The title the form keeps is the committed model, never the box's text.
        const title = document.getElementById('w-title').dataset.model || '';
        li.textContent = [title, g('w-company'), g('w-loc'), g('w-from') + ' – ' + (document.getElementById('w-cur').checked ? 'Present' : g('w-to')), g('w-desc')].join(' | ');
        document.getElementById('exp-entries').append(li);
        p.innerHTML = '';
      });
    };
    document.getElementById('add-exp').addEventListener('press', openWork);
    const openEdu = () => {
      const p = document.getElementById('edu-panel');
      if (p.children.length) return;
      p.innerHTML = '<x-input id="e-school" label="School" combobox></x-input><x-input id="e-degree" label="Degree"></x-input><x-input id="e-field" label="Field of study"></x-input>'
        + '<x-input id="e-from" label="From" placeholder="Pick a date"></x-input><x-input id="e-to" label="To" placeholder="Pick a date"></x-input>'
        + '<x-button id="e-save" aria-label="Save education entry"><span>Save</span></x-button>';
      document.getElementById('e-save').addEventListener('press', () => {
        const g = (id) => document.getElementById(id).value;
        const li = document.createElement('div'); li.className = 'entry';
        li.textContent = [g('e-school'), g('e-degree'), g('e-field'), g('e-from') + ' – ' + g('e-to')].join(' | ');
        document.getElementById('edu-entries').append(li);
        p.innerHTML = '';
      });
    };
    document.getElementById('add-edu').addEventListener('press', openEdu);
  <\/script>`;

test('AN ENTRY THE FORM REFUSES IS CANCELLED AND NAMED AS HIS — never a panel left open (F-353)', async () => {
  // SmartRecruiters' shape: Save keeps the panel open with "Title is required."
  // because the Title autocomplete only takes a picked value.
  // Cancel clears the panel; Save refuses with the form's own alert.
  const result = await fill(SR_EXPERIENCE.replace(
    "document.getElementById('w-save').addEventListener('press', () => {",
    "document.getElementById('w-cancel').addEventListener('press', () => { p.innerHTML = ''; });"
    + " document.getElementById('w-save').addEventListener('press', () => { if (!window.__allowSave) { p.insertAdjacentHTML('afterbegin', '<div role=\"alert\">Title is required.</div>'); return; }",
  ));
  const got = await page.evaluate(() => ({ panelOpen: document.getElementById('exp-panel').children.length, saved: document.querySelectorAll('#exp-entries .entry').length, eduSaved: document.querySelectorAll('#edu-entries .entry').length }));
  assert.equal(got.panelOpen, 0, 'the refused panel was cancelled');
  assert.equal(got.saved, 0);
  const note = result.unanswered.find((u) => /Work experience — this form said "Title is required\."/.test(u));
  assert.ok(note, `the refusal is named with the form's own words: ${JSON.stringify(result.unanswered)} error=${result.error || ''} stopped=${result.stoppedBecause || ''} filled=${result.filled}`);
  assert.match(note, /Add these yourself: Mechanical Engineer Intern; Manufacturing Lead/, 'and every entry still his is listed');
  assert.equal(got.eduSaved, 1, 'education, which the form accepts, was still entered');
});

test('A REFUSAL THAT NAMES CHARACTERS IS ANSWERED — the text is scrubbed and saved again (F-356)', async () => {
  // SmartRecruiters' shape: "This field cannot contain following characters: ;"
  // Here the form forbids a full stop, which the test description carries.
  const result = await fill(SR_EXPERIENCE.replace(
    "document.getElementById('w-save').addEventListener('press', () => {",
    "document.getElementById('w-cancel').addEventListener('press', () => { p.innerHTML = ''; });"
    + " document.getElementById('w-save').addEventListener('press', () => { p.querySelector('[role=alert]')?.remove(); if (document.getElementById('w-desc').value.includes('.')) { p.insertAdjacentHTML('afterbegin', '<div role=\"alert\">This field cannot contain following characters: .</div>'); return; }",
  ));
  const got = await page.evaluate(() => ({
    panelOpen: document.getElementById('exp-panel').children.length,
    work: [...document.querySelectorAll('#exp-entries .entry')].map((e) => e.textContent),
  }));
  assert.equal(got.panelOpen, 0, 'no panel left open');
  assert.equal(got.work.length, 2, `both entries saved after the scrub (unanswered: ${JSON.stringify(result.unanswered)})`);
  assert.match(got.work[0], /\| Designed an inspection fixture$/, 'the forbidden character is gone from the saved text');
  assert.match(got.work[1], /\| Ran the shop floor$/);
  assert.ok(!result.unanswered.some((u) => /this form said/.test(u)), JSON.stringify(result.unanswered));
});

test('AN EDUCATION ENTRY\'S MONTH PICKERS ARE SET WHEN THE PROFILE STATES THE MONTHS (F-358)', async () => {
  const result = await fill(SR_EXPERIENCE, {
    editPlan: `(plan) => { for (const g of plan.entries || []) if (g.kind === 'education') for (const e of g.entries) Object.assign(e, { firstYear: 2023, firstMonth: 8, lastYear: 2027, lastMonth: 5 }); return plan; }`,
  });
  const edu = await page.evaluate(() => [...document.querySelectorAll('#edu-entries .entry')].map((e) => e.textContent));
  assert.equal(edu.length, 1, `the education entry saved (unanswered: ${JSON.stringify(result.unanswered)})`);
  assert.match(edu[0], /\| 08\/2023 – 05\/2027$/, 'both month pickers set from the stated months');
  assert.ok(!result.unanswered.some((u) => /pick the month/.test(u)), JSON.stringify(result.unanswered));
});

test('F-795: a split Month / Year date in a generic entry never gets a year in its Month box (Coherent, Oracle)', async () => {
  const result = await fill(`
    <h2>Education</h2>
    <div id="edu"><button type="button" id="add-edu">Add Education</button><div id="edu-panel"></div></div>
    <script>
      document.getElementById('add-edu').addEventListener('click', () => {
        document.getElementById('edu-panel').innerHTML =
          '<label for="s">School Name</label><input id="s">' +
          '<label for="sm">Start Date Month</label><input id="sm">' +
          '<label for="sy">Start Date Year</label><input id="sy">' +
          '<label for="em">End Date Month</label><input id="em">' +
          '<label for="ey">End Date Year</label><input id="ey">';
      });
    <\/script>`, {
    editPlan: `(plan) => { for (const g of plan.entries || []) if (g.kind === 'education') for (const e of g.entries) Object.assign(e, { firstYear: 2023, firstMonth: 8, lastYear: 2027, lastMonth: 5 }); return plan; }`,
  });
  const got = await page.evaluate(() => Object.fromEntries(['s', 'sm', 'sy', 'em', 'ey'].map((id) => [id, document.getElementById(id)?.value ?? null])));
  assert.ok(got.s !== null, `the entry was opened: ${JSON.stringify(result.unanswered)}`);
  assert.ok(!/^\d{4}$/.test(String(got.sm)), `no year in Start Date Month: ${JSON.stringify(got)}`);
  assert.ok(!/^\d{4}$/.test(String(got.em)), `no year in End Date Month: ${JSON.stringify(got)}`);
  assert.equal(got.sy, '2023', `the year went into the Year box: ${JSON.stringify(got)}`);
});

test('F-887: an Oracle entry is saved with its own inline "Add Experience" (a type=submit in the form), the form is never sent, and the second entry goes in', async () => {
  // Modelled on Ford's live markup (2026-10-23): the entry's footer is
  // Cancel + button.save-btn[data-qa="profileItemInlineSaveButton"], both
  // without a type attribute inside the application's <form>; one entry open
  // at a time; the application's own Submit is a type=button pager control.
  const result = await fill(`
    <form class="apply-flow__content apply-flow__content-form" onsubmit="window.__nativeSubmit = (window.__nativeSubmit || 0) + 1; return false">
      <label for="fn">First Name</label><input id="fn">
      <h2>Experience</h2>
      <div id="exp"><div id="cards"></div><button type="button" id="add" class="button apply-flow-profile-item-tile__new-tile">Add Experience</button><div id="panel"></div></div>
      <button type="button" class="button apply-flow-pagination__submit-button" onclick="window.__SUBMITTED = 1">Submit</button>
    </form>
    <script>
      const panel = document.getElementById('panel'), cards = document.getElementById('cards');
      document.getElementById('add').addEventListener('click', () => {
        if (panel.children.length) return;   // Oracle: one open entry at a time
        panel.innerHTML = '<div class="standard-apply-flow-profile-item"><label for="t">Job Title</label><input id="t">'
          + '<label for="c">Employer Name</label><input id="c">'
          + '<div class="app-dialog__buttons-bar"><button class="button app-dialog__footer-button cancel-btn">Cancel</button>'
          + '<button class="button app-dialog__footer-button save-btn" data-qa="profileItemInlineSaveButton">Add Experience</button></div></div>';
        panel.querySelector('.save-btn').addEventListener('click', (e) => { e.preventDefault();
          const c = document.createElement('div'); c.className = 'card';
          c.textContent = document.getElementById('t').value + ' | ' + document.getElementById('c').value;
          cards.appendChild(c); panel.innerHTML = ''; });
        panel.querySelector('.cancel-btn').addEventListener('click', (e) => { e.preventDefault(); panel.innerHTML = ''; });
      });
    <\/script>`);
  const got = await page.evaluate(() => ({ cards: [...document.querySelectorAll('#cards .card')].map((c) => c.textContent), open: document.getElementById('panel').children.length, native: window.__nativeSubmit || 0, submitted: !!window.__SUBMITTED }));
  assert.equal(got.cards.length, 2, `both jobs saved as cards: ${JSON.stringify(got)} ${JSON.stringify(result.unanswered)}`);
  assert.match(got.cards[0], /Mechanical Engineer Intern \| Acme Fab/);
  assert.equal(got.open, 0, 'no entry left open');
  assert.equal(got.native, 0, 'the application form was never submitted natively');
  assert.equal(got.submitted, false, 'SUBMIT IS HIS');
  assert.ok(!result.unanswered.some((u) => /Save yourself|did not open a sub-form/.test(u)), JSON.stringify(result.unanswered));
});

/**
 * Oracle's profile-item sections as TI's live page drew them (2026-10-23):
 * a .profile-item-container holding the saved tiles (article[data-qa=
 * "profileItem<N>"]), the section's Add (data-qa="add<N>", hidden while an
 * entry is open), the open entry's fields, and its footer — Cancel and the
 * inline save, labelled "Add Education" like the Add itself. Degree is a
 * required row of cx-select pills.
 */
const TILE_BTNS = '<button type="button" aria-label="Edit" title="Edit"></button><button type="button" aria-label="Delete" title="Delete"></button>';
const ORACLE_SECTIONS = ({ eduTiles = [], eduOpen = false, workTiles = [], buttons = false } = {}) => `
  <form onsubmit="window.__nativeSubmit = (window.__nativeSubmit || 0) + 1; return false">
    <label for="fn">First Name</label><input id="fn">
    <div class="apply-flow-block"><h3>Education</h3>
      <div class="profile-item-container" id="edu"><div class="standard-apply-flow-profile-item">
        <div class="profile-item-list" id="edu-tiles">${eduTiles.map((t) => `<article class="apply-flow-profile-item-tile" data-qa="profileItem106"><div class="apply-flow-profile-item-tile__summary"><span>${t}</span></div>${buttons ? TILE_BTNS : ''}</article>`).join('')}</div>
        <div class="profile-add-item" id="edu-additem"><button type="button" class="button apply-flow-profile-item-tile__new-tile" data-qa="add106" id="edu-add"><span class="button__label">Add Education</span></button></div>
        <div class="profile-item-content" id="edu-form"></div>
        <div class="profile-item-footer" id="edu-foot"></div>
      </div></div></div>
    <div class="apply-flow-block"><h3>Experience</h3>
      <div class="profile-item-container" id="work"><div class="standard-apply-flow-profile-item">
        <div class="profile-item-list" id="work-tiles">${workTiles.map((t) => `<article class="apply-flow-profile-item-tile" data-qa="profileItem129"><div class="apply-flow-profile-item-tile__summary"><span>${t}</span></div>${buttons ? TILE_BTNS : ''}</article>`).join('')}</div>
        <div class="profile-add-item" id="work-additem"><button type="button" class="button apply-flow-profile-item-tile__new-tile" data-qa="add129" id="work-add"><span class="button__label">Add Experience</span></button></div>
        <div class="profile-item-content" id="work-form"></div>
        <div class="profile-item-footer" id="work-foot"></div>
      </div></div></div>
    <button type="button" class="button apply-flow-pagination__submit-button" onclick="window.__SUBMITTED = 1">Submit</button>
  </form>
  <script>(() => {
    window.__adds = { edu: 0, work: 0 }; window.__saves = { edu: 0, work: 0 };
    const tile = (list, qa, text) => { const a = document.createElement('article'); a.className = 'apply-flow-profile-item-tile'; a.setAttribute('data-qa', qa);
      a.innerHTML = '<div class="apply-flow-profile-item-tile__summary"><span></span></div>'; a.querySelector('span').textContent = text; document.getElementById(list).appendChild(a); };
    const foot = (id, label, onSave) => { const f = document.getElementById(id);
      f.innerHTML = '<div class="app-dialog__buttons-bar"><button class="button app-dialog__footer-button cancel-btn">Cancel</button>'
        + '<button class="button app-dialog__footer-button save-btn" data-qa="profileItemInlineSaveButton"><span class="button__label">' + label + '</span></button></div>';
      f.querySelector('.save-btn').addEventListener('click', (e) => { e.preventDefault(); onSave(); });
      f.querySelector('.cancel-btn').addEventListener('click', (e) => { e.preventDefault(); close(id.split('-')[0]); }); };
    const close = (k) => { document.getElementById(k + '-form').innerHTML = ''; document.getElementById(k + '-foot').innerHTML = ''; document.getElementById(k + '-additem').style.display = ''; };
    const openEdu = () => {
      document.getElementById('edu-additem').style.display = 'none';
      document.getElementById('edu-form').innerHTML = '<div class="input-row input-row--has-picker"><label class="input-row__label"><span>Degree</span></label>'
        + '<ul class="cx-select-pills-container">' + ["Associate's Degree/College Diploma", "Bachelor's Degree", "Master's Degree", 'Other']
          .map((p) => '<li><button type="button" class="cx-select-pill-section"><span class="cx-select-pill-name">' + p + '</span></button></li>').join('') + '</ul></div>'
        + '<div class="input-row"><label class="input-row__label" for="major"><span>Major</span></label><input class="input-row__control" id="major" name="major"></div>'
        + '<div class="input-row"><label class="input-row__label" for="school"><span>School</span></label><input class="input-row__control" id="school" name="school"></div>';
      document.getElementById('edu-form').querySelectorAll('.cx-select-pill-section').forEach((b) => b.addEventListener('click', () => {
        document.querySelectorAll('#edu-form .cx-select-pill-section').forEach((x) => x.classList.remove('cx-select-pill-section--selected'));
        b.classList.add('cx-select-pill-section--selected'); }));
      foot('edu-foot', 'Add Education', () => {
        window.__saves.edu += 1;
        if (!document.querySelector('#edu-form .cx-select-pill-section--selected')) {
          document.getElementById('edu-foot').insertAdjacentHTML('afterbegin', '<div role="alert">The Degree field is required.</div>'); return; }
        tile('edu-tiles', 'profileItem106', document.getElementById('major').value || 'Unnamed Major'); close('edu'); });
    };
    const openWork = () => {
      document.getElementById('work-additem').style.display = 'none';
      document.getElementById('work-form').innerHTML = '<label for="jt">Job Title</label><input id="jt"><label for="emp">Employer Name</label><input id="emp">';
      foot('work-foot', 'Add Experience', () => { window.__saves.work += 1;
        tile('work-tiles', 'profileItem129', document.getElementById('jt').value + ' ' + document.getElementById('emp').value); close('work'); });
    };
    document.getElementById('edu-add').addEventListener('click', () => { window.__adds.edu += 1; if (!document.getElementById('edu-form').children.length) openEdu(); });
    document.getElementById('work-add').addEventListener('click', () => { window.__adds.work += 1; if (!document.getElementById('work-form').children.length) openWork(); });
    ${eduOpen ? 'openEdu();' : ''}
    // A tile's own Edit and Delete (F-911): Delete takes the tile off; Edit on
    // an education tile opens it again with its Major filled in.
    window.__tileEdits = 0; window.__tileDeletes = 0;
    document.addEventListener('click', (e) => {
      const b = e.target.closest('article button'); if (!b) return;
      const art = b.closest('article');
      if (b.getAttribute('aria-label') === 'Delete') { window.__tileDeletes += 1; art.remove(); }
      if (b.getAttribute('aria-label') === 'Edit' && art.closest('#edu-tiles')) {
        window.__tileEdits += 1; const major = art.querySelector('span').textContent.replace(/Fields to fix.*$/, '').trim();
        art.remove(); openEdu(); document.getElementById('major').value = major; }
      // …and on a job tile (F-924): opens the job with what the tile held.
      if (b.getAttribute('aria-label') === 'Edit' && art.closest('#work-tiles')) {
        window.__tileEdits += 1; const t = art.querySelector('span').textContent.trim();
        const emp = (t.match(/(Acme Fab|Test University)$/) || [''])[0];
        art.remove(); openWork(); document.getElementById('jt').value = t.slice(0, t.length - emp.length).trim(); document.getElementById('emp').value = emp; }
    });
  })();<\/script>`;
const ORACLE_DEGREE = `(plan) => { for (const g of plan.entries || []) if (g.kind === 'education') for (const e of g.entries) { e.degree = 'Bachelor of Science'; e.degreeAlts = ["Bachelor's Degree", "Bachelor's"]; } return plan; }`;
const oracleState = () => page.evaluate(() => ({
  edu: [...document.querySelectorAll('#edu-tiles article')].map((a) => a.textContent.trim()),
  work: [...document.querySelectorAll('#work-tiles article')].map((a) => a.textContent.trim()),
  adds: window.__adds, saves: window.__saves, eduOpen: !!document.getElementById('edu-form').children.length,
  native: window.__nativeSubmit || 0, submitted: !!window.__SUBMITTED,
}));

test('F-889: an Oracle entry left open is filled and saved — its save is never taken for the Add — and a job a tile already shows is not added again (TI)', async () => {
  const result = await fill(ORACLE_SECTIONS({ eduOpen: true, workTiles: ['Mechanical Engineer Intern Acme Fab'] }), { editPlan: ORACLE_DEGREE });
  const got = await oracleState();
  assert.deepEqual(got.edu, ['Mechanical Engineering'], `one education tile, with its Major: ${JSON.stringify(got)} ${JSON.stringify(result.unanswered)}`);
  assert.equal(got.adds.edu, 0, 'the hidden Add was not pressed, and the open entry was used');
  assert.equal(got.saves.edu, 1, 'its save pressed once, with the Degree pill chosen first');
  assert.equal(got.eduOpen, false);
  assert.deepEqual(got.work, ['Mechanical Engineer Intern Acme Fab', 'Manufacturing Lead Test University'], 'only the missing job added');
  assert.equal(got.adds.work, 1);
  assert.equal(got.native, 0, 'the application form was never submitted');
  assert.equal(got.submitted, false, 'SUBMIT IS HIS');
  assert.ok(!result.unanswered.some((u) => /Save yourself|did not open|you're all set/i.test(u)), JSON.stringify(result.unanswered));
});

test('F-889: on a later run, Oracle sections whose tiles already show his entries get nothing added (TI showed three education tiles after three runs)', async () => {
  await fill(ORACLE_SECTIONS({ eduTiles: ['Mechanical Engineering'], workTiles: ['Mechanical Engineer Intern Acme Fab', 'Manufacturing Lead Test University'] }), { editPlan: ORACLE_DEGREE });
  const got = await oracleState();
  assert.deepEqual(got.edu, ['Mechanical Engineering'], JSON.stringify(got));
  assert.equal(got.work.length, 2, JSON.stringify(got));
  assert.deepEqual(got.adds, { edu: 0, work: 0 }, 'no Add pressed');
});

test('F-911: an Oracle row flagged "Fields to fix" is opened and finished, and an empty "Unnamed" row is deleted (Oceaneering, Ford)', async () => {
  await fill(ORACLE_SECTIONS({
    buttons: true,
    eduTiles: ['Mechanical Engineering Fields to fix: 1'],
    workTiles: ['Mechanical Engineer Intern Acme Fab', 'Unnamed Job Title Fields to fix: 1', 'Manufacturing Lead Test University'],
  }), { editPlan: ORACLE_DEGREE });
  const got = await oracleState();
  const extra = await page.evaluate(() => ({ edits: window.__tileEdits, deletes: window.__tileDeletes }));
  assert.equal(extra.edits, 1, `the flagged education row was opened with its Edit: ${JSON.stringify({ got, extra })}`);
  assert.deepEqual(got.edu, ['Mechanical Engineering'], 'and saved finished — one row, nothing to fix');
  assert.equal(got.adds.edu, 0, 'no second education row added');
  assert.equal(extra.deletes, 1, 'the empty row was deleted');
  assert.deepEqual(got.work, ['Mechanical Engineer Intern Acme Fab', 'Manufacturing Lead Test University'], 'his two jobs stay, nothing added');
  assert.equal(got.submitted, false, 'SUBMIT IS HIS');
});

test('F-924: a saved Oracle job tile that drops "Intern" is opened with its Edit and saved again with his title — nothing added (Denso)', async () => {
  const result = await fill(ORACLE_SECTIONS({
    buttons: true,
    eduTiles: ['Mechanical Engineering'],
    workTiles: ['Mechanical Engineer Acme Fab', 'Manufacturing Lead Test University'],
  }), { editPlan: ORACLE_DEGREE });
  const got = await oracleState();
  const extra = await page.evaluate(() => ({ edits: window.__tileEdits }));
  assert.equal(extra.edits, 1, `the overstated tile was opened: ${JSON.stringify({ got, extra, u: result.unanswered })}`);
  assert.deepEqual(got.work, ['Manufacturing Lead Test University', 'Mechanical Engineer Intern Acme Fab'], 'his title is back, one tile each');
  assert.equal(got.adds.work, 0, 'no job added');
  assert.equal(got.submitted, false, 'SUBMIT IS HIS');
});

test('F-915: Oracle timeline cards count as his saved jobs — matched by their dates when the short card hides the company (Coherent)', async () => {
  const cards = '<div class="beautiful-timeline-item" role="group"><span>Process Intern</span> <span>From May 2026 to August 2026</span></div>'
    + '<div class="beautiful-timeline-item" role="group"><span>Manufacturing Lead</span> <span>Test University</span> <span>From August 2024 to Present</span></div>';
  await fill(ORACLE_SECTIONS({ eduTiles: ['Mechanical Engineering'] }).replace('<div class="profile-item-list" id="work-tiles">', '<div class="profile-item-list" id="work-tiles">' + cards), { editPlan: ORACLE_DEGREE });
  const got = await oracleState();
  assert.equal(got.adds.work, 0, `no job added again: ${JSON.stringify(got)}`);
});

test('F-900: Oracle tiles that spell the company shorter are his jobs — nothing added again — and the run names every entry as done', async () => {
  // Ford's Experience went from 2 tiles to 5 in one run (2026-10-23); TI's
  // tiles read "Manufacturing Engineer Intern Acme Steel Steel Stud Co…".
  const result = await fill(ORACLE_SECTIONS({ eduTiles: ['Mechanical Engineering'], workTiles: ['Mechanical Engineer Intern Acme Fab', 'Manufacturing Lead Acme Steel Steel Stud Co'] }), {
    editPlan: `(plan) => { for (const g of plan.entries || []) { if (g.kind === 'work') g.entries[1].company = 'Acme Steel Stud Company'; if (g.kind === 'education') for (const e of g.entries) { e.degree = 'Bachelor of Science'; e.degreeAlts = ["Bachelor's Degree"]; } } return plan; }`,
  });
  const got = await oracleState();
  assert.equal(got.work.length, 2, `no job added again: ${JSON.stringify(got)}`);
  assert.deepEqual(got.adds, { edu: 0, work: 0 });
  const answered = result.answered || [];
  for (const tag of ['Work experience 1 (Acme Fab)', 'Work experience 2 (Acme Steel Stud Company)', 'Work experience — this form said', 'Education — this form said']) {
    assert.ok(answered.includes(tag), `"${tag}" reported done, so an older run's line about it is cleared: ${JSON.stringify(answered)}`);
  }
});

test('F-902: a one-word answer typed into an Oracle lookup is still CLICKED (the box holding "Vietnamese" is not a choice), and a slow save is waited out (Ford)', async () => {
  const result = await fill(`
    <form onsubmit="window.__nativeSubmit = (window.__nativeSubmit || 0) + 1; return false">
      <label for="fn">First Name</label><input id="fn">
      <div class="apply-flow-block"><h3>Languages</h3>
        <div class="profile-item-container" id="lang"><div class="standard-apply-flow-profile-item">
          <div class="profile-item-list" id="lang-tiles"><article class="apply-flow-profile-item-tile" data-qa="profileItem140"><div class="apply-flow-profile-item-tile__summary"><span>English</span></div></article></div>
          <div class="profile-add-item" id="lang-additem" style="display:none"><button type="button" class="button apply-flow-profile-item-tile__new-tile" data-qa="add140" id="lang-add"><span class="button__label">Add Language</span></button></div>
          <div class="profile-item-content" id="lang-form">
            <div class="input-row"><label class="input-row__label" for="lname"><span>Language</span></label>
              <div class="cx-select-container"><input id="lname" name="contentItemId" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="lname-listbox" aria-expanded="false" aria-required="true" class="cx-select-input"></div>
              <div id="lname-listbox" role="grid" class="cx-select__list"></div></div>
          </div>
          <div class="profile-item-footer" id="lang-foot"><div class="app-dialog__buttons-bar"><button class="button app-dialog__footer-button cancel-btn" id="lang-cancel">Cancel</button>
            <button class="button app-dialog__footer-button save-btn" data-qa="profileItemInlineSaveButton"><span class="button__label">Add Language</span></button></div></div>
        </div></div></div>
      <button type="button" class="button apply-flow-pagination__submit-button" onclick="window.__SUBMITTED = 1">Submit</button>
    </form>
    <script>(() => {
      window.__saves = 0; window.__cancels = 0;
      const box = document.getElementById('lname'), grid = document.getElementById('lname-listbox');
      const ALL = ['Afrikaans', 'Albanian', 'Arabic', 'English', 'French', 'Vietnamese', 'Welsh'];
      // Only a clicked row is chosen; text typed to search chooses nothing.
      let model = '';
      const draw = (list) => { grid.innerHTML = ''; for (const t of list) { const row = document.createElement('div'); row.setAttribute('role', 'row');
        const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.className = 'cx-select__list-item ';
        cell.innerHTML = '<div class="cx-select__list-item-container"><span class="cx-select__list-item--content"><span>' + t + '</span></span></div>';
        cell.addEventListener('click', () => { model = t; box.value = t; grid.innerHTML = ''; box.setAttribute('aria-expanded', 'false'); });
        row.appendChild(cell); grid.appendChild(row); } };
      const open = () => { box.setAttribute('aria-expanded', 'true'); if (!grid.children.length) draw(ALL.slice(0, 3)); };
      box.addEventListener('mousedown', open); box.addEventListener('click', open); box.addEventListener('focus', open);
      let timer = null;
      box.addEventListener('keyup', () => { model = ''; clearTimeout(timer); timer = setTimeout(() => {
        const q = box.value.toLowerCase(); draw(ALL.filter((t) => t.toLowerCase().includes(q)).slice(0, 3)); }, 300); });
      const foot = document.getElementById('lang-foot');
      foot.querySelector('.save-btn').addEventListener('click', (e) => { e.preventDefault(); window.__saves += 1;
        if (!model) { if (!foot.querySelector('[role=alert]')) foot.insertAdjacentHTML('afterbegin', '<div role="alert">The Language field is required.</div>'); return; }
        // Oracle's server answers in its own time.
        setTimeout(() => { const a = document.createElement('article'); a.className = 'apply-flow-profile-item-tile'; a.setAttribute('data-qa', 'profileItem140');
          a.innerHTML = '<div class="apply-flow-profile-item-tile__summary"><span>' + model + '</span></div>'; document.getElementById('lang-tiles').appendChild(a);
          document.getElementById('lang-form').innerHTML = ''; foot.innerHTML = ''; document.getElementById('lang-additem').style.display = ''; }, 5500); });
      foot.querySelector('.cancel-btn').addEventListener('click', (e) => { e.preventDefault(); window.__cancels += 1; });
    })();<\/script>`, {
    editPlan: `(plan) => { plan.entries = (plan.entries || []).filter((g) => g.kind !== 'language'); plan.entries.push({ kind: 'language', entries: [{ name: 'English' }, { name: 'Vietnamese' }] }); return plan; }`,
  });
  const got = await page.evaluate(() => ({ tiles: [...document.querySelectorAll('#lang-tiles article')].map((a) => a.textContent.trim()), saves: window.__saves, cancels: window.__cancels, native: window.__nativeSubmit || 0, submitted: !!window.__SUBMITTED }));
  assert.deepEqual(got.tiles, ['English', 'Vietnamese'], `Vietnamese saved once, English not again: ${JSON.stringify(got)} ${JSON.stringify(result.unanswered)}`);
  assert.equal(got.cancels, 0, 'a slow save is not cancelled');
  assert.equal(got.native, 0);
  assert.equal(got.submitted, false, 'SUBMIT IS HIS');
  // (The test profile has no languages, so the planner leaves the bare box as
  // "step 1: Language"; with his profile it skips it — apply-plan.test F-902.)
  assert.ok(!result.unanswered.some((u) => /Language \d|this form said/.test(u)), JSON.stringify(result.unanswered));
});

test('F-887: an Oracle lookup that searches only on keystrokes, and opens on an unfiltered first page, is typed key by key (onsemi School)', async () => {
  await fill(`
    <label for="sch">School</label>
    <div class="cx-select-container"><input id="sch" name="educationalEstablishment" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="sch-listbox" aria-expanded="false" class="cx-select-input"></div>
    <div id="sch-listbox" role="grid" class="cx-select__list"></div>
    <script>(() => {
      const box = document.getElementById('sch'), grid = document.getElementById('sch-listbox');
      const ALL = ['Aalborg University', 'Alpen-Adria-Universitat Klagenfurt', 'American University', 'Lakeside University', 'Springfield Falls Community College'];
      const draw = (list) => { grid.innerHTML = ''; for (const t of list) { const row = document.createElement('div'); row.setAttribute('role', 'row');
        const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.className = 'cx-select__list-item ';
        cell.innerHTML = '<div class="cx-select__list-item-container"><span class="cx-select__list-item--content"><span>' + t + '</span></span></div>';
        cell.addEventListener('click', () => { box.value = t; grid.innerHTML = ''; box.setAttribute('aria-expanded', 'false'); });
        row.appendChild(cell); grid.appendChild(row); } };
      const open = () => { box.setAttribute('aria-expanded', 'true'); if (!grid.children.length) draw(ALL.slice(0, 3)); };
      box.addEventListener('mousedown', open); box.addEventListener('click', open); box.addEventListener('focus', open);
      // The search listens to KEYS: text inserted whole, with no keyup, filters nothing.
      let timer = null;
      box.addEventListener('keyup', () => { clearTimeout(timer); timer = setTimeout(() => {
        const q = box.value.toLowerCase(); draw(ALL.filter((t) => t.toLowerCase().includes(q)).slice(0, 3)); }, 300); });
    })();<\/script>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/school/i.test(a.label)) Object.assign(a, { action: 'prompt', value: 'Lakeside University', promptKind: 'combo' }); return plan; }` });
  assert.equal(await page.evaluate(() => document.getElementById('sch').value), 'Lakeside University');
});

test('F-888: a step this tab filled, emptied by a reload, is filled again by the run that follows him (Ford, cookie banner)', async () => {
  const url = 'https://jarvis-test.example/apply/email';
  await fillAs(`<h2>You don't need to have an account</h2>${FOUR}`, { armed: true, auto: false }, url);
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), 'Alex', 'his press filled it');
  // The banner's accept reloads the page: a fresh document, the boxes blank,
  // the tab's memory of the step (sessionStorage) still there.
  const r = await fillAs(`<h2>You don't need to have an account</h2>${FOUR}<button type="button" onclick="window.__NEXT = 1">Next</button>`, { armed: true, auto: true }, url);
  assert.match(String(r?.stoppedBecause || ''), /came back empty/, JSON.stringify(r));
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), 'Alex', 'filled again after the reload');
  assert.equal(await page.evaluate(() => window.__NEXT || 0), 0, 'and Next left for him');
});

test('A COMPONENT FORM\'S EXPERIENCE AND EDUCATION ARE ENTERED BY THEIR LABELS AND SAVED (F-341)', async () => {
  const result = await fill(SR_EXPERIENCE);
  const got = await page.evaluate(() => ({
    work: [...document.querySelectorAll('#exp-entries .entry')].map((e) => e.textContent),
    edu: [...document.querySelectorAll('#edu-entries .entry')].map((e) => e.textContent),
    panelOpen: document.getElementById('exp-panel').children.length,
    first: document.getElementById('fn').value,
  }));
  assert.equal(got.first, 'Alex', 'the ordinary fields are still filled');
  assert.equal(got.work.length, 2, `two work entries saved (unanswered: ${JSON.stringify(result.unanswered)})`);
  assert.match(got.work[0], /^Mechanical Engineer Intern \| Acme Fab \| Austin, Texas \| 05\/2026 – 08\/2026 \| Designed an inspection fixture\./);
  assert.match(got.work[1], /^Manufacturing Lead \| Test University \| Springfield, Washington \| 08\/2024 – Present \| Ran the shop floor\./);
  assert.equal(got.edu.length, 1, 'the education entry saved');
  assert.match(got.edu[0], /^Lakeside University \| /);
  assert.equal(got.panelOpen, 0, 'no sub-form left open');
  assert.ok(!result.unanswered.some((u) => /Add did not open|Save did not close|could not set/.test(u)), JSON.stringify(result.unanswered));

  // A SECOND PRESS ADDS NOTHING TWICE (F-355): the saved cards are on the
  // page, so each entry is counted present and no Add is opened for it.
  const again = await page.evaluate(CONTENT);
  const after = await page.evaluate(() => ({
    work: document.querySelectorAll('#exp-entries .entry').length,
    edu: document.querySelectorAll('#edu-entries .entry').length,
    panelOpen: document.getElementById('exp-panel').children.length + document.getElementById('edu-panel').children.length,
  }));
  assert.equal(after.work, 2, `still two work entries after a second press (unanswered: ${JSON.stringify(again.unanswered)})`);
  assert.equal(after.edu, 1, 'still one education entry after a second press');
  assert.equal(after.panelOpen, 0, 'no sub-form opened by the second press');
});

test('AN APPLY THAT OPENS A MENU: the plain "Apply Now" is chosen, never LinkedIn (F-347)', async () => {
  const result = await fill(`
    <h1>Manufacturing Engineer</h1>
    <div class="btn-group">
      <button type="button" class="btn dropdown-toggle" id="apply">Apply now</button>
      <ul class="dropdown-menu" id="menu" style="display:none">
        <li><a role="menuitem" href="#" id="manual">Apply Now</a></li>
        <li><a role="menuitem" href="#" id="li">Start applying with LinkedIn</a></li>
      </ul>
    </div>
    <div id="form"></div>
    <script>
      document.getElementById('apply').addEventListener('click', () => { document.getElementById('menu').style.display = 'block'; });
      document.getElementById('manual').addEventListener('click', (e) => { e.preventDefault(); window.__applied = 'manual'; document.getElementById('menu').style.display = 'none';
        document.getElementById('form').innerHTML = '<form><label for="f">First Name</label><input id="f"><label for="l">Last Name</label><input id="l"><label for="e">Email</label><input id="e" type="email"></form>'; });
      document.getElementById('li').addEventListener('click', (e) => { e.preventDefault(); window.__applied = 'linkedin'; });
    <\/script>`);
  const got = await page.evaluate(() => ({ applied: window.__applied || null, first: document.getElementById('f')?.value || '' }));
  assert.equal(got.applied, 'manual', `the plain item was chosen (stopped: ${result.stoppedBecause})`);
  assert.equal(got.first, 'Alex', 'and the form it revealed was filled');
});

test('F-884: a posting with a chat widget still chooses the Apply menu\'s "Apply Now", and the chat\'s video upload never gets the resume (Schindler)', async () => {
  // Schindler (SuccessFactors career site, 2026-10-23): Paradox's "Eli" is an
  // <apply-widget> whose shadow root holds "Write a reply..." and a hidden
  // "Upload Video" input; the Apply toggle says aria-haspopup and opens a menu
  // with "Apply Now", a javascript:alert help link and LinkedIn.
  const result = await fill(`
    <h1>Manufacturing Engineer</h1>
    <div class="btn-group">
      <button type="button" class="btn dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-label="Apply now" id="apply">Apply now</button>
      <ul class="dropdown-menu socialbutton" id="menu" style="display:none">
        <li><a role="menuitem" class="applyOption" href="#" id="manual">Apply Now</a></li>
        <li><a class="socialbutton-help" href="javascript:window.__alerted = 1">?</a></li>
        <li><a role="menuitem" class="applyOption" href="#" id="li">Start apply with LinkedIn</a></li>
      </ul>
    </div>
    <div id="form"></div>
    <apply-widget id="eli"></apply-widget>
    <script>
      const root = document.getElementById('eli').attachShadow({ mode: 'open' });
      root.innerHTML = '<div><p>Eli said, Hi! I am Eli, your virtual recruiter.</p><textarea placeholder="Write a reply..."></textarea><label>Upload Video<input type="file" accept="video/*" style="display:none"></label></div>';
      document.getElementById('apply').addEventListener('click', () => { document.getElementById('menu').style.display = 'block'; });
      document.getElementById('manual').addEventListener('click', (e) => { e.preventDefault(); window.__applied = 'manual'; document.getElementById('menu').style.display = 'none';
        document.getElementById('form').innerHTML = '<form><label for="f">First Name</label><input id="f"><label for="cv">Resume</label><input id="cv" type="file"></form>'; });
      document.getElementById('li').addEventListener('click', (e) => { e.preventDefault(); window.__applied = 'linkedin'; });
    <\/script>`);
  const got = await page.evaluate(() => ({
    applied: window.__applied || null, alerted: window.__alerted || 0,
    first: document.getElementById('f')?.value || '',
    video: document.getElementById('eli').shadowRoot.querySelector('input[type=file]').files.length,
    reply: document.getElementById('eli').shadowRoot.querySelector('textarea').value,
  }));
  assert.equal(got.applied, 'manual', `the menu's Apply Now was chosen (stopped: ${result.stoppedBecause})`);
  assert.equal(got.alerted, 0, 'the javascript: help link was never clicked');
  assert.equal(got.first, 'Alex', 'the form it revealed was filled');
  assert.equal(got.video, 0, 'nothing went into the chat\'s video upload');
  assert.equal(got.reply, '', 'and nothing was typed into the chat');
});

test('the panel lives in a shadow root, out of reach of the page\'s and other extensions\' CSS', async () => {
  // Simplify's extension injects a stylesheet on every page; beside its side
  // panel, Jarvis's rows collapsed onto one another. A shadow root is the one
  // boundary that CSS cannot cross.
  await fillAs(`
    <style>div { position: absolute !important; top: 0 !important; line-height: 0 !important; color: red !important; }</style>
    <h2>Step</h2>${FOUR}`, { armed: true, auto: false });
  const got = await page.evaluate(() => {
    const host = document.getElementById('jarvis-overlay');
    const panel = host?.shadowRoot?.getElementById('jarvis-panel');
    // The panel's OWN first child is the sticky header (F-502), so it is not
    // the probe for "the page did not position this" — the status row under
    // it is, and it carries no positioning of ours at all.
    const head = panel?.children[0];
    const row = panel?.children[1];
    return panel ? {
      hostHasShadow: !!host.shadowRoot,
      color: getComputedStyle(panel).color,
      rowPos: getComputedStyle(row).position,
      headPos: getComputedStyle(head).position,
      lh: getComputedStyle(row).lineHeight,
    } : null;
  });
  assert.ok(got?.hostHasShadow, 'the panel is inside a shadow root');
  assert.notEqual(got.color, 'rgb(255, 0, 0)', 'the page\'s !important colour does not reach it');
  assert.equal(got.rowPos, 'static', 'nor its positioning');
  assert.notEqual(got.lh, '0px', 'nor its line-height — this is what collapsed the rows beside Simplify');
  // Our own sticky header survives a page that shouts `position: absolute
  // !important` at every div: an !important page rule would beat our inline
  // one, so this reading is the boundary holding.
  assert.equal(got.headPos, 'sticky', 'the header keeps the positioning WE gave it');
});

// ── F-367 / F-369 / F-370: Jabil's My Experience, measured 2026-09-06 ─────
//
// The language block under each language is five Workday dropdowns —
// Comprehension, Overall, Reading, Speaking, Writing — on a numbered ladder,
// plus "I am fluent in this language." once per language; and the skills box
// is a REQUIRED multi-select over a taxonomy that has neither SolidWorks nor
// Inventor. Every one of those was left for him.

/** A Workday multi-select over a remote taxonomy: type, wait, pick a row. */
const wdMulti = (id, question, taxonomy, { required = true } = {}) => `
  <div data-automation-id="formField-${id}">
    <label>${question}${required ? ' *' : ''}</label>
    <div data-automation-id="multiSelectContainer">
      <div data-automation-id="selectedItemList" id="chips-${id}"></div>
      <input data-automation-id="searchBox" id="search-${id}" type="text" aria-controls="lb-${id}"${required ? ' aria-required="true"' : ''}>
    </div>
  </div>
  <ul id="lb-${id}" role="listbox" style="display:none"></ul>
  <script>
    (() => {
      const TAX = ${JSON.stringify(taxonomy)};
      const box = document.getElementById('search-${id}');
      const lb = document.getElementById('lb-${id}');
      const chips = document.getElementById('chips-${id}');
      window.__picked_${id} = [];
      box.addEventListener('keyup', () => {
        const q = box.value.trim().toLowerCase();
        setTimeout(() => {
          const hits = q ? TAX.filter((t) => t.toLowerCase().includes(q)) : [];
          lb.innerHTML = hits.length ? hits.map((t) => '<li role="option">' + t + '</li>').join('') : '<li role="option">No Items.</li>';
          lb.style.display = 'block';
        }, 120);
      });
      lb.addEventListener('click', (e) => {
        const row = e.target.closest('[role="option"]');
        if (!row || /No Items/.test(row.textContent)) return;
        window.__picked_${id}.push(row.textContent);
        const chip = document.createElement('span'); chip.textContent = row.textContent; chips.append(chip);
        box.value = ''; lb.style.display = 'none';
      });
    })();
  </script>`;

/** One Workday language entry: the name, the fluent box, five ladders. */
const wdLanguage = (n, name) => `
  <div class="language" data-automation-id="language-${n}">
    <div data-automation-id="formField-language"><label>Language</label><button id="lang-${n}" aria-haspopup="listbox">${name}</button></div>
    <div data-automation-id="formField-native"><label><input type="checkbox" id="native-${n}" name="native"> I am fluent in this language.</label></div>
    ${['Comprehension', 'Overall', 'Reading', 'Speaking', 'Writing'].map((skill, i) => wdPrompt(`lang${n}skill${i}`, skill, ['1 - Beginner', '2 - Basic', '3 - Intermediate', '4 - Advanced', '5 - Fluent'])).join('')}
  </div>`;

test('F-367/F-369: every proficiency dropdown takes the top rung, and each fluent box is ticked', async () => {
  const result = await fill(`
    <form>
      <h2>My Experience</h2>
      <div id="langs"><h3>Languages</h3>${wdLanguage(1, 'English')}${wdLanguage(2, 'Vietnamese')}</div>
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`);
  const got = await page.evaluate(() => ({
    rungs: [...document.querySelectorAll('[id^="trigger-lang"]')].map((b) => b.textContent.trim()),
    fluent: [...document.querySelectorAll('[id^="native-"]')].map((c) => c.checked),
  }));
  assert.deepEqual(got.rungs, Array(10).fill('5 - Fluent'), 'ten dropdowns, ten top rungs');
  assert.deepEqual(got.fluent, [true, true], 'both languages are fluent');
  assert.deepEqual(result.unanswered.filter((u) => /fluent|Comprehension|Overall|Reading|Speaking|Writing/.test(u)), [], 'nothing of the language block is left for him');
});

test('F-370: a REQUIRED skills box keeps going down his list until something lands', async () => {
  const skills = ['SolidWorks', 'Autodesk Inventor', 'Creo', 'AutoCAD', 'GD&T', 'FEA', 'DFM', 'DFA', 'CNC machining', 'PLC', 'Python'];
  const result = await fill(`
    <form>
      ${wdMulti('skills', 'Type to Add Skills', ['AutoCAD', 'PLC Programming', 'Python (Programming Language)', 'Lean Manufacturing', 'Welding'])}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/Skills/.test(a.label)) { a.action = 'prompt'; a.values = ${JSON.stringify(skills)}; a.value = 'SolidWorks'; } return plan; }` });
  const picked = await page.evaluate(() => window.__picked_skills);
  assert.ok(picked.includes('AutoCAD'), `the fourth skill lands after three misses; picked: ${picked.join(', ')}`);
  assert.ok(picked.includes('PLC Programming') && picked.some((p) => /Python/.test(p)), `and the list is walked to its end: ${picked.join(', ')}`);
  assert.equal(result.unanswered.some((u) => /nothing matched/.test(u)), false, 'a required box with three skills in it is not "nothing matched"');
});

test('…while an OPTIONAL list that is not skills still stops after two misses, as before', async () => {
  const items = ['SolidWorks', 'Autodesk Inventor', 'Creo', 'AutoCAD'];
  await fill(`
    <form>
      ${wdMulti('opt', 'Type to Add Tools', ['AutoCAD'], { required: false })}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/Tools/.test(a.label)) { a.action = 'prompt'; a.promptKind = 'multi'; a.values = ${JSON.stringify(items)}; a.value = 'SolidWorks'; } return plan; }` });
  const picked = await page.evaluate(() => window.__picked_opt);
  assert.deepEqual(picked, [], 'two misses end an optional list — one optional field must never cost the run');
});

test('F-552: an optional SKILLS box keeps going past misses and tries the taxonomy spelling', async () => {
  // "struggles with skills too" (2026-09-24). Intel's box got SolidWorks and
  // Inventor, missed both, and stopped with nothing in it.
  const result = await fill(`
    <form>
      ${wdMulti('skills', 'Type to Add Skills', ['AutoCAD', 'Geometric Dimensioning And Tolerancing (GD&T)', 'Finite Element Methods', 'Python (Programming Language)', 'Lean Manufacturing'], { required: false })}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`);
  const picked = await page.evaluate(() => window.__picked_skills);
  assert.ok(picked.includes('AutoCAD'), `past the first misses: ${picked.join(', ')}`);
  assert.ok(picked.some((p) => /Geometric Dimensioning/.test(p)), `GD&T found under its full name: ${picked.join(', ')}`);
  assert.ok(picked.length >= 3, `several skills, not one: ${picked.join(', ')}`);
  assert.equal(result.unanswered.some((u) => /Skills/.test(u)), false);
});

test('F-371: Workday dates an application he already sent, and that is "already applied", not "no form yet"', async () => {
  // Measured on Jabil (2026-09-06): "You applied for this job on September 2,
  // 2026." above View Application, no Apply anywhere. The run said "no form
  // here yet — this tab is followed" and the store kept the job as interested.
  const result = await fill(`
    <main>
      <h2>Automation Engineer I</h2>
      <p>You applied for this job on September 2, 2026.</p>
      <a href="/candidate/applications">View Application</a>
      <dl><dt>locations</dt><dd>Hendersonville, NC</dd><dt>job requisition id</dt><dd>J2454515</dd></dl>
      <p>At Jabil we are proud to be a trusted partner.</p>
    </main>`);
  assert.equal(result.alreadyApplied, true, 'the verdict travels to the worker, which marks the job applied');
  assert.match(result.stoppedBecause || '', /already applied/i);
  assert.doesNotMatch(result.stoppedBecause || '', /no form here yet/);
});

test('F-378: a second press on a form already answered is a success, not "not a multi-step application"', async () => {
  // Measured on the live Applied Materials form (2026-09-06): every field held
  // its answer from the first walk, so the pass filled nothing and the panel
  // said "this page is not a multi-step application" over a COMPLETE
  // application. Skipped means "already holds the answer", so it counts.
  const preset = (id, question, value, options) => `
    <div data-automation-id="formField-${id}">
      <label>${question} *</label>
      <button id="trigger-${id}" aria-haspopup="listbox" aria-controls="lb-${id}">${value}</button>
    </div>
    <ul id="lb-${id}" role="listbox" style="display:none">${options.map((o) => `<li role="option">${o}</li>`).join('')}</ul>`;
  const result = await fill(`
    <form>
      ${preset('auth', 'Are you legally authorized to work in the United States?', 'Yes', ['Yes', 'No'])}
      ${preset('spon', 'Will you now or in the future require sponsorship for employment?', 'Yes', ['Yes', 'No'])}
      <button type="submit">Submit application</button>
    </form>`);
  assert.equal(result.filled, 0, 'nothing to fill — it is all there');
  assert.ok(result.skipped > 0, `and the fields are counted as answered, got skipped=${result.skipped}`);
  assert.match(result.stoppedBecause || '', /everything that could be filled is/);
  assert.doesNotMatch(result.stoppedBecause || '', /not a multi-step application/);
});

/**
 * A WALL WITH NOTHING TO SIGN IN WITH IS NOT A SIGN-IN.
 *
 * iCIMS' /login, measured on Joby Aviation (2026-09-06), reads "Enter Your
 * Information — Email", one box, an EU/UK residency tick and a captcha. There
 * is no password, no "sign in", nothing to sign in WITH — and the panel said
 * "sign in here", which is advice he cannot follow. Oracle's first step is the
 * same shape and has said the honest thing since F-345.
 */
test('F-381: an email-only gate says so, and a real sign-in still says sign in', async () => {
  const email = await fill(`
    <main>
      <h1>Enter Your Information</h1>
      <form action="/jobs/3726/login" method="post">
        <label for="e">Email</label><input id="e" name="email" type="email">
        <label><input type="checkbox" id="eu"> If you are a European Union (EU) or United Kingdom (UK) resident, please check this box.</label>
        <button type="submit">Next</button>
      </form>
    </main>`);
  assert.equal(email.signInRequired, true, 'it is still a wall — Next, and any human check, are his');
  // FILLED, NOT JUST NAMED (2026-09-24, "icims sucks too"): his email goes in;
  // pressing Next — the step that starts anything at this employer — is his.
  assert.match(email.stoppedBecause || '', /your email .*press Next yourself/);
  assert.doesNotMatch(email.stoppedBecause || '', /sign in/i);
  assert.ok(await page.evaluate(() => document.getElementById('e').value.includes('@')), 'his email is in the box');
  // …AND HIS RESIDENCY IS NOT A CONSENT. The standing yes-to-consent rule must
  // not tick a question of fact.
  const ticked = await page.evaluate(() => document.getElementById('eu').checked);
  assert.equal(ticked, false, 'he is not an EU or UK resident, and nothing may say he is');

  const real = await fill(`
    <main>
      <h1>Sign In</h1>
      <form action="/login" method="post">
        <label for="u">Email</label><input id="u" name="email" type="email">
        <label for="p">Password</label><input id="p" name="password" type="password">
        <button type="submit">Sign in</button>
      </form>
    </main>`);
  assert.equal(real.signInRequired, true);
  assert.match(real.stoppedBecause || '', /sign in here/i);
});

test('F-388: when Apply opens an account page, that is a wall — not a form to fill', async () => {
  // Measured live on HP's Workday tenant (2026-09-07): Apply → "Apply
  // Manually" → **Create Account** (email, password, verify password, a
  // consent box and a bot trap). The wall check runs only from step 2, behind
  // a gate, or after a wait — none of which is true on this path — so the run
  // fell straight through into filling an account-creation form, and told him
  // the bot trap was the one thing left for him to do.
  const result = await fill(`
    <h1>Process and Tooling Engineer</h1>
    <p>Advert text.</p>
    <button id="a" onclick="document.body.innerHTML = document.getElementById('acct').innerHTML">Apply</button>
    <template id="acct">
      <h1>Create Account</h1>
      <form action="/apply/applyManually" method="post">
        <label for="e">Email Address</label><input id="e" data-automation-id="email" type="text">
        <label for="p">Password</label><input id="p" data-automation-id="password" type="password">
        <label for="v">Verify New Password</label><input id="v" data-automation-id="verifyPassword" type="password">
        <label><input type="checkbox" data-automation-id="createAccountCheckbox"> I agree to the Terms</label>
        <label for="w">Enter website. This input is for robots only, do not enter if you're human.</label>
        <input id="w" name="website" data-automation-id="beecatcher">
        <button type="submit">Create Account</button>
      </form>
    </template>`);
  assert.equal(result.signInRequired, true, 'creating an account is his, always');
  assert.equal(result.filled, 0, 'and nothing on it is typed into');
  assert.deepEqual(result.unanswered || [], [], 'least of all the bot trap');
  assert.match(result.stoppedBecause || '', /sign in|account|email first/i);
});

test('…and a press straight ONTO the account page is the same answer', async () => {
  // The wall check used to be gated on "not the first step of a run that had
  // to follow something to get here", so a press on the Create Account page
  // itself — his commonest way of landing on one, from a link or a reload —
  // still went through to the planner. Measured live on HP's tenant.
  const result = await fill(`
    <h1>Create Account</h1>
    <form action="/apply/applyManually" method="post">
      <label for="e">Email Address</label><input id="e" data-automation-id="email" type="text">
      <label for="p">Password</label><input id="p" data-automation-id="password" type="password">
      <label for="v">Verify New Password</label><input id="v" data-automation-id="verifyPassword" type="password">
      <label><input type="checkbox" data-automation-id="createAccountCheckbox"> I agree to the Terms and Conditions</label>
      <button type="submit">Create Account</button>
    </form>`);
  assert.equal(result.signInRequired, true);
  assert.equal(result.filled, 0);
  assert.doesNotMatch(result.stoppedBecause || '', /not a multi-step application/);
});

test('a Workday POSTING is still not a wall, header Sign In link and all', async () => {
  // The gate that was removed existed to protect this case, and `signInWall()`
  // has answered it on its own since F-236: a page offering Apply is a posting.
  // Workday carries more of his deck than any other ATS, so this is the one
  // that must not regress.
  const result = await fill(`
    <header><a href="/login">Sign In</a></header>
    <h1>Process and Tooling Engineer</h1>
    <p>Advert text, no form at all.</p>
    <a data-automation-id="adventureButton" href="#" onclick="document.body.innerHTML='<form><label>First Name<input name=first></label><label>Email<input name=email type=email></label><button type=submit>Submit</button></form>'">Apply</a>`);
  assert.notEqual(result.signInRequired, true, 'a posting with Apply is never a wall');
  assert.ok((result.filled || 0) >= 1 || result.followedApply, 'it follows Apply instead of stopping');
});

/**
 * A WORKDAY PROMPT THAT IS A MENU OF MENUS, PAINTED A FEW ROWS AT A TIME.
 *
 * Measured live on Applied Materials' "How Did You Hear About Us?"
 * (2026-09-07) — REQUIRED, and it blocked the whole application. The popup
 * lists five categories, only two of which were in the DOM (react-virtualized),
 * and choosing one opens a second level where the real answer lives. Typing
 * does not filter this widget at all: every query returned the same two rows.
 */
test('F-390: a virtualised two-level Workday prompt is scrolled, drilled into, and answered', async () => {
  const result = await fill(`
    <form>
      <div data-automation-id="formField-source">
        <label>How Did You Hear About Us? *</label>
        <div data-automation-id="multiSelectContainer">
          <div data-automation-id="selectedItemList" id="chips"></div>
          <input data-automation-id="searchBox" id="src" type="text" aria-controls="lb">
        </div>
      </div>
      <div id="lb" style="display:none"><div id="win" style="height:64px;overflow:auto"><div id="inner"></div></div></div>
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <script>
      (() => {
        const TOP = ['Applied Materials Corporate Website', 'I currently work at/for Applied Materials', 'Job Board or Social Media', 'Job Fair or Recruiting Event', 'Staffing Agency'];
        const LEAF = ['104.com', 'Dice.com', 'Facebook', 'Glassdoor', 'Indeed', 'Instagram', 'LinkedIn', 'Twitter'];
        const lb = document.getElementById('lb'), win = document.getElementById('win'), inner = document.getElementById('inner');
        let level = TOP;
        // react-virtualized: only the rows inside the scroll window exist.
        const paint = () => {
          const ROW = 32, top = win.scrollTop, n = level.length;
          inner.style.height = (n * ROW) + 'px';
          const from = Math.max(0, Math.floor(top / ROW) - 1), to = Math.min(n, Math.ceil((top + win.clientHeight) / ROW) + 1);
          inner.innerHTML = '';
          for (let i = from; i < to; i += 1) {
            const d = document.createElement('div');
            d.setAttribute('data-automation-id', 'promptOption');
            d.setAttribute('aria-setsize', String(n));
            d.style.cssText = 'height:32px;position:absolute;top:' + (i * ROW) + 'px';
            d.textContent = level[i];
            d.onclick = () => {
              if (level === TOP) { level = LEAF; win.scrollTop = 0; paint(); return; }   // a category drills in
              document.getElementById('chips').textContent = level[i];                    // a leaf commits
              lb.style.display = 'none';
            };
            inner.append(d);
          }
        };
        inner.style.position = 'relative';
        win.addEventListener('scroll', paint);
        document.getElementById('src').addEventListener('click', () => { lb.style.display = 'block'; level = TOP; win.scrollTop = 0; paint(); });
      })();
    <\/script>`);
  const chips = await page.evaluate(() => document.getElementById('chips').textContent.trim());
  assert.equal(chips, 'LinkedIn', `it reached the leaf; the field holds "${chips}"`);
  assert.equal(result.filled, 1, 'and it is counted');
  assert.deepEqual(result.unanswered, [], 'nothing left for him on a question his profile answers');
});

test('F-390: a single-select prompt clicks the row that listens, not the one that is first', async () => {
  // Workday renders each option three times — menuItem, promptLeafNode,
  // promptOption — and only the leaf node responds to a click (measured live
  // on Applied Materials). The single-select path clicks whatever the option
  // search returned, which was the menuItem: first in the DOM, and inert.
  const result = await fill(`
    <div data-automation-id="formField-country">
      <label>Country *</label>
      <button id="trigger-c" aria-haspopup="listbox" aria-controls="lb-c">Select One</button>
    </div>
    <ul id="lb-c" role="listbox" style="display:none">
      <li><div data-automation-id="menuItem" role="option">United States of America</div>
          <div data-automation-id="promptLeafNode">United States of America</div></li>
      <li><div data-automation-id="menuItem" role="option">Canada</div>
          <div data-automation-id="promptLeafNode">Canada</div></li>
    </ul>
    <script>
      (() => {
        const t = document.getElementById('trigger-c'), lb = document.getElementById('lb-c');
        t.addEventListener('click', () => { lb.style.display = lb.style.display === 'none' ? 'block' : 'none'; });
        // ONLY the leaf node listens — exactly as Workday behaves.
        for (const n of lb.querySelectorAll('[data-automation-id="promptLeafNode"]')) {
          n.addEventListener('click', () => { t.textContent = n.textContent; lb.style.display = 'none'; });
        }
      })();
    <\/script>`);
  const shown = await page.evaluate(() => document.getElementById('trigger-c').textContent.trim());
  assert.equal(shown, 'United States of America', `the inert copy was clicked; the trigger reads "${shown}"`);
  assert.equal(result.filled, 1);
});

test('F-395: when the copy that listens is NOT the preferred one, it is still found', async () => {
  // Workday draws each option three times and only one copy listens. Which one
  // that is was measured on a single tenant, and a ranking that is wrong
  // elsewhere would fail silently and read exactly like "nothing matched". So
  // every copy is clicked until the page changes. Here the LEAST preferred
  // copy is the live one, which is the case the ranking gets wrong.
  const result = await fill(`
    <div data-automation-id="formField-country">
      <label>Country *</label>
      <button id="trigger-x" aria-haspopup="listbox" aria-controls="lb-x">Select One</button>
    </div>
    <ul id="lb-x" role="listbox" style="display:none">
      <li><div data-automation-id="promptLeafNode">United States of America</div>
          <div data-automation-id="promptOption">United States of America</div>
          <div data-automation-id="menuItem" role="option" id="live">United States of America</div></li>
    </ul>
    <script>
      (() => {
        const t = document.getElementById('trigger-x'), lb = document.getElementById('lb-x');
        t.addEventListener('click', () => { lb.style.display = lb.style.display === 'none' ? 'block' : 'none'; });
        // ONLY the menuItem listens here — the opposite of the tenant measured.
        document.getElementById('live').addEventListener('click', () => { t.textContent = 'United States of America'; lb.style.display = 'none'; });
      })();
    <\/script>`);
  const shown = await page.evaluate(() => document.getElementById('trigger-x').textContent.trim());
  assert.equal(shown, 'United States of America', `it gave up on the copy that answers; the trigger reads "${shown}"`);
  assert.equal(result.filled, 1);
});

/**
 * A SCRIPT-BUILT LISTBOX IS OPENED, READ AND ANSWERED (F-485's neighbourhood).
 *
 * Eightfold builds its listboxes from script, so their options do not exist in
 * the DOM until the control is pressed. This pins that the engine handles that
 * shape end to end: press, reveal the rows, rank them through /api/choose,
 * click the truthful one.
 *
 * IT DOES NOT COVER THE MICRON FAILURE, and that is worth saying plainly. A
 * routing change was written to send an optionless `select` down this same
 * path, and this test passed with that change DISABLED — because a control
 * carrying `aria-haspopup="listbox"` is already discovered as a prompt and
 * never reaches the select branch. The change was reverted rather than shipped
 * on the strength of a test that did not exercise it. What Micron's widget
 * actually is in the DOM is still unknown; it is behind the Apply button.
 */
test('a listbox that renders its options on click is opened and answered', async () => {
  const result = await fill(`
    <form>
      <div data-automation-id="formField-veteran">
        <label id="vlabel">U.S. – Protected Veteran Self-Identification This Employer is a Government contractor subject to the Vietnam Era Veterans Readjustment Assistance Act of 1974, as amended</label>
        <button type="button" aria-haspopup="listbox" aria-labelledby="vlabel" id="vbtn">Select one</button>
        <div id="vlist"></div>
      </div>
    </form>
    <script>(() => {
      window.__picked = '';
      const OPTIONS = [
        'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN',
        'I AM NOT A PROTECTED VETERAN',
        'I DO NOT WISH TO ANSWER',
      ];
      const btn = document.getElementById('vbtn');
      const list = document.getElementById('vlist');
      // Nothing is in the DOM until the control is pressed — the whole point.
      btn.addEventListener('click', () => {
        if (list.childElementCount) return;
        for (const text of OPTIONS) {
          const row = document.createElement('div');
          row.setAttribute('role', 'option');
          row.textContent = text;
          row.addEventListener('click', () => {
            window.__picked = text;
            btn.textContent = text;
            list.innerHTML = '';
          });
          list.appendChild(row);
        }
      });
    })();<\/script>`);

  const picked = await page.evaluate(() => window.__picked);
  assert.equal(picked, 'I AM NOT A PROTECTED VETERAN',
    'the engine opened the list and chose the truthful row');
  assert.ok(!result.unanswered.some((u) => /veteran/i.test(String(u))),
    `and did not report it as his to answer: ${JSON.stringify(result.unanswered)}`);
});

/**
 * F-485: A NATIVE <select> THAT WAS EMPTY WHEN THE PAGE WAS READ.
 *
 * `discover()` types a field `select` only for a real <select>, and reads its
 * choices straight off `el.options`. So `type: 'select'` with an empty list
 * means one thing exactly: the element had no <option> children at that
 * moment. That is how Micron's veteran self-identification question reached
 * the plan, and it was handed back to him as unanswerable while the engine
 * held "I am not a Veteran." and the form offered that very row.
 *
 * The fixture is that element: empty markup, filled by script when touched.
 */
test('A <select> FILLED BY SCRIPT AFTER THE PAGE IS READ IS STILL ANSWERED', async () => {
  const result = await fill(`
    <form>
      <label for="vet">U.S. – Protected Veteran Self-Identification This Employer is a Government contractor subject to the Vietnam Era Veterans Readjustment Assistance Act of 1974, as amended</label>
      <select id="vet"></select>
    </form>
    <script>(() => {
      const sel = document.getElementById('vet');
      // Nothing in it until something touches it — the shape that defeated the
      // engine on a live form.
      const fillIt = () => {
        if (sel.options.length) return;
        for (const t of ['Select one',
          'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF A PROTECTED VETERAN',
          'I AM NOT A PROTECTED VETERAN',
          'I DO NOT WISH TO ANSWER']) {
          const o = document.createElement('option');
          o.textContent = t; o.value = t === 'Select one' ? '' : t;
          sel.appendChild(o);
        }
      };
      sel.addEventListener('focus', fillIt);
      sel.addEventListener('click', fillIt);
    })();<\/script>`);

  const chosen = await page.evaluate(() => document.getElementById('vet').value);
  assert.equal(chosen, 'I AM NOT A PROTECTED VETERAN',
    'the engine looked again, read the list that had appeared, and chose the truthful row');
  assert.ok(!result.unanswered.some((u) => /veteran/i.test(String(u))),
    `and did not hand it back: ${JSON.stringify(result.unanswered)}`);
});

// WHAT WENT OUT, NOT ONLY WHAT WAS PLANNED (his ask, 2026-09-24). Pressing Next
// or Submit sends every field as it stands, so the dashboard can set his final
// answers beside the plan. The snapshot only READS: it must not stop, change or
// delay the press.
test('PRESSING NEXT OR SUBMIT SENDS THE FORM AS IT STANDS — read only', async () => {
  await page.goto('about:blank');
  await page.setContent(`
    <label for="email">Email</label><input id="email">
    <label for="zip">Postal code</label><input id="zip">
    <fieldset><legend>Will you require sponsorship?</legend>
      <label><input type="radio" name="sp" value="Yes">Yes</label>
      <label><input type="radio" name="sp" value="No">No</label></fieldset>
    <button type="button" id="next">Next</button>
    <button type="button" id="send">Submit application</button>
    <button type="button" id="other">Add another</button>`);
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate(() => {
    globalThis.__sent = [];
    globalThis.__jarvisRun = { armed: false, auto: true };
    globalThis.chrome = { runtime: { id: 'test-extension', sendMessage: async (msg, reply) => {
      globalThis.__sent.push(JSON.parse(JSON.stringify(msg)));
      if (msg.type === 'plan') reply({ ok: true, plan: await globalThis.__jarvisPlan(msg.fields) });
      else if (reply) reply({ ok: true });
    } } };
  });
  await page.evaluate(CONTENT);
  // He answers by hand.
  await page.fill('#email', 'a@b.c');
  await page.fill('#zip', '12345');
  await page.check('input[name="sp"][value="Yes"]');

  // The walk pressed Next itself on the way through; that is recorded, and says so.
  const mine = async () => (await sent()).filter((m) => m.type === 'snapshot' && m.by === 'you');
  assert.ok((await sent()).filter((m) => m.type === 'snapshot').every((m) => m.by === 'jarvis'), 'a press the walk made is labelled as the walk');

  await page.click('#other');
  assert.equal((await mine()).length, 0, 'a button that is neither Next nor Submit sends nothing');

  await page.click('#next');
  const step = await mine();
  assert.equal(step.length, 1);
  assert.equal(step[0].stage, 'step');
  assert.equal(step[0].by, 'you', 'a real click is his');
  const val = (label) => step[0].fields.find((f) => new RegExp(label, 'i').test(f.label))?.value;
  assert.equal(val('email'), 'a@b.c');
  assert.equal(val('postal'), '12345');
  assert.equal(val('sponsorship'), 'Yes', 'a radio group reports the option chosen');

  await page.click('#send');
  const all = await mine();
  assert.equal(all[all.length - 1].stage, 'submit');
  assert.equal(await page.inputValue('#zip'), '12345', 'reading the form changed nothing on it');
});

// ─────────────────────────────────────────────────────────────────────
// F-581 (2026-09-24). Workday's skills search runs on ENTER, and its date
// boxes keep only what their own model took. Both left fields empty on his
// forms after F-550/F-552 shipped: skills "nothing matched" on Viavi, ABB and
// Novanta; the self-identify Date "required" while it showed on screen.
// These models behave the way the live widgets do — the old code fails them.
// ─────────────────────────────────────────────────────────────────────

/** Workday's "Type to Add Skills": the lookup runs on Enter (keyCode 13), nothing else. */
const wdSkillsOnEnter = (taxonomy) => `
  <div data-automation-id="formField-skills">
    <label>Type to Add Skills</label>
    <div data-automation-id="multiSelectContainer">
      <div data-automation-id="selectedItemList" id="chips"></div>
      <input data-automation-id="searchBox" id="search" type="text" aria-controls="lb" placeholder="Search">
    </div>
  </div>
  <ul id="lb" role="listbox" style="display:none"></ul>
  <script>
    (() => {
      const TAX = ${JSON.stringify(taxonomy)};
      const box = document.getElementById('search');
      const lb = document.getElementById('lb');
      const chips = document.getElementById('chips');
      window.__picked = [];
      box.addEventListener('keydown', (e) => {
        if (e.keyCode !== 13) return;
        const q = box.value.trim().toLowerCase();
        setTimeout(() => {
          const hits = q ? TAX.filter((t) => t.toLowerCase().includes(q)) : [];
          lb.innerHTML = hits.length ? hits.map((t) => '<li role="option">' + t + '</li>').join('') : '<li role="option">No Items.</li>';
          lb.style.display = 'block';
        }, 150);
      });
      lb.addEventListener('click', (e) => {
        const row = e.target.closest('[role="option"]');
        if (!row || /No Items/.test(row.textContent)) return;
        window.__picked.push(row.textContent);
        const chip = document.createElement('span'); chip.textContent = row.textContent; chips.append(chip);
        box.value = ''; lb.style.display = 'none';
      });
    })();
  </script>`;

test('F-581: a Workday skills box that searches on Enter gets 10-15 skills, quickly', async () => {
  const mine = ['SolidWorks', 'Autodesk Inventor', 'Creo', 'AutoCAD', 'GD&T', 'FEA', 'DFM', 'DFA', 'CNC machining', '3-axis milling',
    'MIG welding', 'TIG welding', 'rapid prototyping', '3D printing', 'robotics integration', 'machine vision', 'PLC', 'metrology', 'Python', 'MATLAB'];
  const taxonomy = ['SolidWorks', 'Autodesk Inventor', 'PTC Creo', 'AutoCAD', 'Geometric Dimensioning And Tolerancing (GD&T)', 'DFM', 'CNC Machining',
    'MIG Welding', 'TIG Welding', 'Rapid Prototyping', '3D Printing', 'Machine Vision', 'PLC Programming', 'Metrology', 'Python (Programming Language)', 'MATLAB'];
  const began = Date.now();
  const result = await fill(`
    <form>
      ${wdSkillsOnEnter(taxonomy)}
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/Skills/.test(a.label)) { a.action = 'prompt'; a.promptKind = 'multi'; a.skills = true; a.values = ${JSON.stringify(mine)}; a.value = 'SolidWorks'; } return plan; }` });
  const took = Date.now() - began;
  const picked = await page.evaluate(() => window.__picked);
  assert.ok(picked.length >= 10 && picked.length <= 15, `10-15 skills, got ${picked.length}: ${picked.join(', ')}`);
  assert.ok(picked.includes('SolidWorks') && picked.includes('AutoCAD'), picked.join(', '));
  assert.ok(took < 45000, `the box costs seconds per skill, not minutes: ${took} ms`);
  assert.equal(result.unanswered.some((u) => /Skills/.test(u)), false);
});

/**
 * A Workday date segment: its own model holds the digits. A digit key (with
 * its keyCode) or text inserted as typing inserts it updates the model; a
 * value set from outside is shown until the box is left, then redrawn from
 * the model — the "required" field with a date on screen.
 */
const wdDateSegment = (part, { keysOnly = false } = {}) => {
  const id = part === 'month' ? 'dateSectionMonth-input' : part === 'day' ? 'dateSectionDay-input' : 'dateSectionYear-input';
  const max = part === 'year' ? 4 : 2;
  return `<input data-automation-id="${id}" role="spinbutton" data-part="${part}" data-max="${max}" data-keys-only="${keysOnly ? 1 : 0}" placeholder="${part === 'year' ? 'YYYY' : part === 'month' ? 'MM' : 'DD'}">`;
};
const WD_DATE_MODEL = `<script>
  for (const box of document.querySelectorAll('input[data-part]')) {
    const max = Number(box.dataset.max); box.dataset.model = '';
    // A select-all then a digit starts the segment over, as on Workday.
    box.addEventListener('focus', () => { box.dataset.fresh = '1'; });
    box.addEventListener('keydown', (e) => {
      if (e.keyCode >= 48 && e.keyCode <= 57) {
        e.preventDefault();
        const was = box.dataset.fresh === '1' ? '' : box.dataset.model;
        box.dataset.fresh = '0';
        box.dataset.model = (was + String.fromCharCode(e.keyCode)).slice(-max); box.value = box.dataset.model;
      }
    });
    box.addEventListener('input', (e) => {
      if (box.dataset.keysOnly === '1') return;
      if (e.inputType === 'insertText') box.dataset.model = box.value.replace(/[^0-9]/g, '').slice(-max);
    });
    box.addEventListener('blur', () => { box.value = box.dataset.model; });
  }
</script>`;

const dateField = (id, opts) => `
  <div data-automation-id="formField-${id}">
    <label>Date</label>
    <div data-automation-id="dateInputWrapper">${['month', 'day', 'year'].map((p) => wdDateSegment(p, opts)).join('')}</div>
  </div>`;

const todayParts = () => { const d = new Date(); return { month: String(d.getMonth() + 1).padStart(2, '0'), day: String(d.getDate()).padStart(2, '0'), year: String(d.getFullYear()) }; };
const planToday = `(plan) => { const d = new Date(); const t = { month: String(d.getMonth() + 1).padStart(2, '0'), day: String(d.getDate()).padStart(2, '0'), year: String(d.getFullYear()) };
  for (const a of plan.actions) if (/^Date/.test(a.label) && a.datePart) { a.action = 'fill'; a.value = t[a.datePart]; } return plan; }`;

test('F-581: a Workday date keeps its digits after the box is left (typed as typing inserts them)', async () => {
  const result = await fill(`<form>${dateField('dateSignedOn')}<button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>${WD_DATE_MODEL}`, { editPlan: planToday });
  const model = await page.evaluate(() => [...document.querySelectorAll('input[data-part]')].map((b) => b.dataset.model || b.value));
  const t = todayParts();
  assert.deepEqual(model.map(Number), [t.month, t.day, t.year].map(Number), `Workday's model holds the date: ${model.join('/')}`);
  assert.equal(result.unanswered.some((u) => /Date/.test(u)), false, result.unanswered.join(' · '));
});

test('F-581: …and a box that takes only KEYS gets digits with their key codes', async () => {
  const result = await fill(`<form>${dateField('dateSignedOn', { keysOnly: true })}<button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>${WD_DATE_MODEL}`, { editPlan: planToday });
  const model = await page.evaluate(() => [...document.querySelectorAll('input[data-part]')].map((b) => b.dataset.model || b.value));
  const t = todayParts();
  assert.deepEqual(model.map(Number), [t.month, t.day, t.year].map(Number), `keys only: ${model.join('/')}`);
  assert.equal(result.unanswered.some((u) => /Date/.test(u)), false, result.unanswered.join(' · '));
});

test('F-801: a Workday date whose number lives in aria-valuenow is read from there — no fallback keys into a widget that moved on', async () => {
  // Live markup (Samsung, 2026-10-04): the box clears itself; the number is in
  // aria-valuenow and a "-display" div. Read from the box, a date Workday had
  // taken looked empty and the key fallback ran — the month's digits became
  // the year (KION 2005, ITW and Terex 2008).
  const seg = (part, max) => `<div class="sec"><div data-automation-id="dateSection${part}-display"></div><input role="spinbutton" data-automation-id="dateSection${part}-input" data-p="${part}" data-max="${max}" aria-label="${part}"></div>`;
  const result = await fill(`<form>
    <div data-automation-id="formField-availableFrom"><label>From</label>
      <div data-automation-id="dateInputWrapper">${seg('Month', 2)}${seg('Year', 4)}</div></div>
    <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>
    <script>
      window.__keys = 0;
      for (const box of document.querySelectorAll('input[data-p]')) {
        const disp = box.parentElement.querySelector('[data-automation-id$="-display"]');
        const take = (digits) => { const m = digits.slice(-Number(box.dataset.max)); disp.textContent = m; box.setAttribute('aria-valuenow', String(Number(m))); box.value = ''; };
        box.addEventListener('input', (e) => { if (e.inputType === 'insertText') take(String(box.value).replace(/\\D/g, '')); });
        box.addEventListener('keydown', () => { window.__keys += 1; });
      }
    <\/script>`, { editPlan: `(plan) => { const parts = ['month', 'year']; const v = { month: '08', year: '2024' }; plan.actions.forEach((a, i) => { if (a.label === 'From') { const p = parts[i]; Object.assign(a, { action: 'fill', datePart: p, key: 'formField-availableFrom', value: v[p], why: '' }); } }); return plan; }` });
  const held = await page.evaluate(() => [...document.querySelectorAll('input[data-p]')].map((b) => b.getAttribute('aria-valuenow')));
  assert.deepEqual(held, ['8', '2024'], `the widget holds 08/2024: ${held.join('/')} · ${result.unanswered.join(' · ')}`);
  assert.equal(await page.evaluate(() => window.__keys), 0, 'no fallback keys were sent into a date already taken');
  assert.equal(result.unanswered.some((u) => /From/.test(u)), false, result.unanswered.join(' · '));
});

test('F-618: a date part the page turns into something else is named with both values', async () => {
  // HP, 2026-09-27: 06 / 01 / 2027 typed, the form held 6 / 1 / 2006, and the
  // report said only "the page did not keep the value".
  const result = await fill(`<form>${dateField('availableFrom')}<button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>${WD_DATE_MODEL}
    <script>
      const y = document.querySelector('input[data-part="year"]');
      y.addEventListener('blur', () => { y.value = '2006'; y.dataset.model = '2006'; });
    </script>`, { editPlan: `(plan) => { const v = { month: '06', day: '01', year: '2027' }; for (const a of plan.actions) if (a.datePart) { a.action = 'fill'; a.value = v[a.datePart]; } return plan; }` });
  const model = await page.evaluate(() => [...document.querySelectorAll('input[data-part]')].map((b) => b.dataset.model || b.value));
  assert.deepEqual(model.slice(0, 2).map(Number), [6, 1], `the month and day hold: ${model.join("/")} · ${result.unanswered.join(" · ")}`);
  assert.ok(result.unanswered.some((u) => /year box reads "2006" — it should be 2027/.test(u)), result.unanswered.join(' · '));
});

test('2026-10-26: a year that changes AFTER it was typed is read again and typed once more (Terex 2006, Brooks 2010)', async () => {
  // The year held 2027 when it was checked, then the page wrote the month's
  // digits into it while another part was handled. Fixture: the first time any
  // OTHER part is focused after the year was set, the year becomes "2006".
  await fill(`<form>${dateField('availableFrom')}<button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>${WD_DATE_MODEL}
    <script>
      const y = document.querySelector('input[data-part="year"]');
      let spoiled = false;
      for (const b of document.querySelectorAll('input[data-part="month"], input[data-part="day"]')) {
        b.addEventListener('focus', () => { if (!spoiled && y.value === '2027') { spoiled = true; window.__spoiled = true; setTimeout(() => { y.value = '2006'; y.dataset.model = '2006'; }, 50); } });
      }
    </script>`, { editPlan: `(plan) => { const v = { month: '06', day: '01', year: '2027' }; const parts = plan.actions.filter((a) => a.datePart); for (const a of parts) { a.action = 'fill'; a.value = v[a.datePart]; } plan.actions.sort((a, b) => (a.datePart === 'year' ? -1 : 0) - (b.datePart === 'year' ? -1 : 0)); return plan; }` });
  const model = await page.evaluate(() => [...document.querySelectorAll('input[data-part]')].map((b) => b.dataset.model || b.value));
  assert.equal(await page.evaluate(() => !!window.__spoiled), true, 'the fixture did spoil the year');
  assert.deepEqual(model.map(Number), [6, 1, 2027], `the date ends whole: ${model.join('/')}`);
});

test('F-633: a box that holds "6" for "06", or "90000" for "$90000/year", kept the answer', async () => {
  // Onto Innovation's Workday, 2026-10-01: three "fix it before you submit"
  // lines over a step that held exactly the answer.
  const result = await fill(`<form>${dateField('availableFrom')}
      <label for="pay">What is your desired annual salary?</label><input id="pay" type="text">
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>${WD_DATE_MODEL}
    <script>
      for (const b of document.querySelectorAll('input[data-part="month"], input[data-part="day"]')) {
        b.addEventListener('blur', () => { if (/^\\d+$/.test(b.value)) { b.value = String(Number(b.value)); b.dataset.model = b.value; } });
      }
      const pay = document.getElementById('pay');
      pay.addEventListener('blur', () => { pay.value = pay.value.replace(/\\D/g, ''); });
    </script>`, { editPlan: `(plan) => { const v = { month: '06', day: '01', year: '2027' }; for (const a of plan.actions) { if (a.datePart) { a.action = 'fill'; a.value = v[a.datePart]; } if (/salary/i.test(a.label)) { a.action = 'fill'; a.value = '$90000/year'; } } return plan; }` });
  const held = await page.evaluate(() => [document.querySelector('input[data-part="month"]').value, document.querySelector('input[data-part="day"]').value, document.getElementById('pay').value]);
  assert.deepEqual(held, ['6', '1', '90000'], 'the fixture behaves as Onto\'s page did');
  assert.ok(!result.unanswered.some((u) => /box reads|did not keep/.test(u)), result.unanswered.join(' · '));
});

test('a salary the page refuses as written is retyped as its number and Next pressed again (ADP, 2026-10-17)', async () => {
  await fill(`<form id="f">
      <h2>Questions</h2>
      <label for="pay">What is your desired salary?</label><input id="pay" type="text">
      <div id="err"></div>
      <button type="button" id="next">Next</button></form>
    <script>
      document.getElementById('next').addEventListener('click', () => {
        const v = document.getElementById('pay').value;
        if (/\\D/.test(v)) { document.getElementById('err').innerHTML = '<div role="alert">Correct the information in highlighted fields. Invalid salary value.</div>'; return; }
        document.getElementById('f').innerHTML = '<h2>Voluntary Self-ID</h2><p>Step 4</p>';
      });
    </script>`, { editPlan: `(plan) => { for (const a of plan.actions) if (/salary/i.test(a.label)) { a.action = 'fill'; a.value = '$90000/year'; } return plan; }` });
  const where = await page.evaluate(() => document.querySelector('h2')?.textContent);
  assert.equal(where, 'Voluntary Self-ID', 'the step moved on once the salary was the number alone');
});

test('F-581: a signature date is taken from the calendar\'s Today button when there is one', async () => {
  await fill(`<form>
      <div data-automation-id="formField-dateSignedOn">
        <label>Date</label>
        <div data-automation-id="dateInputWrapper">${['month', 'day', 'year'].map((p) => wdDateSegment(p, { keysOnly: true })).join('')}</div>
        <div data-automation-id="dateIcon" role="button" id="icon" onclick="document.getElementById('picker').style.display='block'"></div>
      </div>
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <div data-automation-id="datePicker" id="picker" style="display:none">
      <button type="button" data-automation-id="datePickerSelectedToday" id="today">Today</button>
    </div>
    ${WD_DATE_MODEL}
    <script>
      document.getElementById('today').addEventListener('click', () => {
        const d = new Date(); const t = { month: String(d.getMonth() + 1).padStart(2, '0'), day: String(d.getDate()).padStart(2, '0'), year: String(d.getFullYear()) };
        for (const b of document.querySelectorAll('input[data-part]')) { b.value = t[b.dataset.part]; b.dataset.model = t[b.dataset.part]; }
        document.getElementById('picker').style.display = 'none';
        window.__pickedToday = (window.__pickedToday || 0) + 1;
      });
    </script>`, { editPlan: planToday });
  const got = await page.evaluate(() => ({ n: window.__pickedToday || 0, model: [...document.querySelectorAll('input[data-part]')].map((b) => b.dataset.model) }));
  const t = todayParts();
  assert.equal(got.n, 1, 'the calendar was used once for the whole date');
  assert.deepEqual(got.model.map(Number), [t.month, t.day, t.year].map(Number));
});

test('F-690: the calendar\'s Today is kept when Workday\'s day is already tomorrow (Flowserve, 5 PM Pacific)', async () => {
  // Workday's today is not his clock's: at 17:10 in Springfield its calendar set
  // 10/4, the check wanted 10/3, and typing 10/03 over it got "Enter today's date".
  await fill(`<form>
      <div data-automation-id="formField-dateSignedOn">
        <label>Date</label>
        <div data-automation-id="dateInputWrapper">${['month', 'day', 'year'].map((p) => wdDateSegment(p, { keysOnly: true })).join('')}</div>
        <div data-automation-id="dateIcon" role="button" id="icon" onclick="document.getElementById('picker').style.display='block'"></div>
      </div>
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <div data-automation-id="datePicker" id="picker" style="display:none">
      <button type="button" data-automation-id="datePickerSelectedToday" id="today">Today</button>
    </div>
    ${WD_DATE_MODEL}
    <script>
      document.getElementById('today').addEventListener('click', () => {
        const d = new Date(Date.now() + 24 * 3600 * 1000);
        const t = { month: String(d.getMonth() + 1).padStart(2, '0'), day: String(d.getDate()).padStart(2, '0'), year: String(d.getFullYear()) };
        for (const b of document.querySelectorAll('input[data-part]')) { b.value = t[b.dataset.part]; b.dataset.model = t[b.dataset.part]; }
        document.getElementById('picker').style.display = 'none';
      });
    </script>`, { editPlan: planToday });
  const model = await page.evaluate(() => [...document.querySelectorAll('input[data-part]')].map((b) => Number(b.dataset.model)));
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  assert.deepEqual(model, [d.getMonth() + 1, d.getDate(), d.getFullYear()], 'Workday\'s date stands; his day is not typed over it');
});

test('F-581: "How Did You Hear About Us?" lands on LinkedIn under Social Media, past another field\'s list left open', async () => {
  // Wolfspeed, 2026-09-24: the list read for this field held "United States
  // of America (+1)" — the phone-code prompt's rows, still open in Workday's
  // shared portal — and LinkedIn never landed. His rule: LinkedIn first.
  const result = await fill(`
    <main id="mainContent">
      <form>
        <div data-automation-id="formField-source">
          <label>How Did You Hear About Us? *</label>
          <div data-automation-id="multiSelectContainer">
            <div data-automation-id="selectedItemList" id="chips"></div>
            <input data-automation-id="searchBox" id="src" type="text">
          </div>
        </div>
        <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
      </form>
    </main>
    <div id="stale" data-automation-id="activeListContainer">
      <div data-automation-id="promptOption" role="option">United States of America (+1)</div>
      <div data-automation-id="promptOption" role="option">Canada (+1)</div>
    </div>
    <div id="lb" style="display:none"></div>
    <script>
      (() => {
        const TOP = ['Campus Campaign', 'Career Websites', 'Company Career Site', 'Social Media', 'Employee Referral'];
        const SUB = { 'Career Websites': ['Glassdoor', 'Indeed', 'ZipRecruiter'], 'Social Media': ['Facebook', 'Instagram', 'LinkedIn', 'Twitter'] };
        const lb = document.getElementById('lb');
        // Workday closes an open list on a press anywhere outside it.
        document.addEventListener('mousedown', (e) => { const s = document.getElementById('stale'); if (s && !s.contains(e.target)) s.remove(); }, true);
        const paint = (rows) => {
          lb.innerHTML = '';
          for (const t of rows) {
            const d = document.createElement('div');
            d.setAttribute('data-automation-id', 'promptOption'); d.setAttribute('role', 'option'); d.textContent = t;
            d.onclick = () => {
              if (SUB[t]) { paint(SUB[t]); return; }
              if (TOP.includes(t) && t !== 'Company Career Site') return;
              document.getElementById('chips').textContent = t; lb.style.display = 'none';
            };
            lb.append(d);
          }
          lb.style.display = 'block';
        };
        document.getElementById('src').addEventListener('click', () => paint(TOP));
      })();
    <\/script>`);
  const chips = await page.evaluate(() => document.getElementById('chips').textContent.trim());
  assert.equal(chips, 'LinkedIn', `LinkedIn first, found one level down; the field holds "${chips}"`);
  assert.deepEqual(result.unanswered, [], result.unanswered.join(' · '));
});

test('READ BACK: an answer the page drops after it was filled is filled again, and one that will not hold is named', async () => {
  // The first time the phone number is typed, the page re-renders and empties
  // the first name — a later field undoing an earlier one, as a re-render does.
  const result = await fill(`
    <form>
      <label for="fn">First Name *</label><input id="fn" name="firstName" required>
      <label for="ph">Phone *</label><input id="ph" name="phone" type="tel" required>
      <label for="city">City *</label><input id="city" name="city" required>
      <button type="submit">Submit</button>
    </form>
    <script>
      let once = false;
      document.getElementById('ph').addEventListener('input', () => { if (!once) { once = true; setTimeout(() => { document.getElementById('fn').value = ''; }, 0); } });
      // City never keeps anything: the model behind it refuses every value.
      document.getElementById('city').addEventListener('blur', () => { setTimeout(() => { document.getElementById('city').value = ''; }, 0); });
    </script>`);
  const got = await page.evaluate(() => ({ fn: document.getElementById('fn').value, city: document.getElementById('city').value }));
  assert.ok(got.fn.trim(), `the dropped first name was filled again: "${got.fn}"`);
  assert.ok(result.unanswered.some((u) => /City/.test(u)), `the box that would not hold is named: ${result.unanswered.join(' · ')}`);
});

test('WERFEN (iCIMS): email in, the CA box for a CA job, then the privacy "I accept" it reveals — captcha and Next untouched', async () => {
  // Live, careers-werfen.icims.com/jobs/10977/…/login (San Diego), 2026-09-24,
  // laid out as the page lays it out: Email; "If you are a California (CA)
  // resident, or applying for a position in CA, please check this box."; and a
  // #gdpr_container, display:none until that box is ticked, holding the
  // privacy-notice links and "I accept". "icims sucks too."
  const r = await fill(`
    <div class="modal-body">
      <h1>Enter Your Information</h1>
      <form id="enterEmailForm" class="iCIMS_SignIn" action="/jobs/10977/associate-systems-engineer/login" method="post">
        <label for="email">Email</label><input id="email" class="form-control" name="css_loginName" type="email">
        <div class="checkbox"><label><input type="checkbox" id="eu_resident" name="eu_resident"> If you are a California (CA) resident, or applying for a position in CA, please check this box.</label>
          <p>Indicate whether or not you are a California (CA) resident.</p></div>
        <div id="gdpr_container" style="display:none">
          <p><a href="#n1">Click here</a> if you are an external candidate applying to a position based in California with Werfen.</p>
          <p><a href="#n2">Click here</a> if you are an employee of Werfen applying to a position in California.</p>
          <div class="checkbox gdpr_wrapper"><label><input type="checkbox" id="accept_gdpr" name="accept_gdpr"> I accept</label>
            <p>You must indicate that you have read the privacy notice and consent to the processing of your personal data before you can continue.</p></div>
        </div>
        <textarea name="h-captcha-response" id="hc" style="display:none"></textarea>
        <button type="submit" id="next" onclick="window.__pressed = 1">Next</button>
      </form>
    </div>
    <script>
      document.getElementById('eu_resident').addEventListener('change', (e) => { document.getElementById('gdpr_container').style.display = e.target.checked ? 'block' : 'none'; });
    </script>`, {
    // The posting's location comes from the store on a real run; the harness
    // plans without one, so the San Diego answer is given here.
    editPlan: `(plan) => { for (const a of plan.actions) if (/California \\(CA\\) resident/.test(a.label)) { a.action = 'check'; a.value = 'checked'; } return plan; }`,
  });
  const got = await page.evaluate(() => ({
    email: document.getElementById('email').value,
    ca: document.getElementById('eu_resident').checked,
    gdpr: document.getElementById('accept_gdpr').checked,
    captcha: document.getElementById('hc').value,
    pressed: !!window.__pressed,
  }));
  assert.ok(got.email.includes('@'), 'his email');
  assert.equal(got.ca, true, 'the job is in California');
  assert.equal(got.gdpr, true, 'the privacy consent it revealed is ticked — his standing yes');
  assert.equal(got.captcha, '', 'the human check is never touched');
  assert.equal(got.pressed, false, 'Next is his');
  assert.equal(r.signInRequired, true);
});

// R4 (2026-11-07): a step that will not move on names the boxes the site marked invalid — labels only.
test('R4: a stalled step names the boxes the site marked invalid, by label, never their values', async () => {
  const result = await fill(`
    <div>
      <h2>My Information</h2>
      <label for="ph">Phone Number</label><input id="ph" aria-invalid="true" aria-describedby="ph-err"><div id="ph-err">Enter a valid phone number</div>
      <label for="zip">Postal Code *</label><input id="zip" aria-invalid="true">
      <label for="prefname">Preferred Name</label><input id="prefname">
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>
    </div>`);
  const why = String(result.stoppedBecause || '');
  assert.match(why, /the site marked these invalid: /, why);
  const listed = why.split('the site marked these invalid: ')[1] || '';
  assert.match(listed, /Phone Number/, 'a box with its own message');
  assert.match(listed, /Postal Code/, 'and one with none');
  assert.doesNotMatch(listed, /\*/, 'the required star is not part of the label');
  assert.doesNotMatch(listed, /Preferred Name/, 'a box the site did not mark is not listed');
  assert.doesNotMatch(listed, /\d{3}/, 'no value goes in: no phone digits, no ZIP');
});

test('R4: a stalled step with no box marked invalid says nothing more', async () => {
  const result = await fill(`
    <div>
      <h2>My Experience</h2>
      <label for="a">Something</label><input id="a">
      <div role="alert">The field Upload a file (5MB max) is required and must have a value.</div>
      <button data-automation-id="pageFooterNextButton">Save and Continue</button>
    </div>`);
  assert.match(String(result.stoppedBecause), /would not move on/);
  assert.doesNotMatch(String(result.stoppedBecause), /marked these invalid/);
});

test('R4: at most six boxes are named', async () => {
  const boxes = Array.from({ length: 8 }, (_, i) => `<label for="q${i}">Question ${i + 1}</label><input id="q${i}" aria-invalid="true">`).join('');
  const result = await fill(`<div><h2>Application Questions</h2>${boxes}<button data-automation-id="pageFooterNextButton">Save and Continue</button></div>`);
  const listed = (String(result.stoppedBecause).split('the site marked these invalid: ')[1] || '').split(' — ')[0];
  assert.equal(listed.split(' · ').length, 6, listed);
});

// R5 step 1 (2026-11-07): Oracle's experience entries are RECORDED around the resume parse — never changed.
const ORACLE_ENTRIES = `
  <div class="profile-section"><h3>Experience</h3>
    <button data-qa="add1">Add Experience</button>
    <article data-qa="profileItem1"><div>Manufacturing Engineer Intern</div><div>Acme Steel</div><div>06/2024 - 08/2024</div><button>Edit</button><button>Delete</button></article>
    <article data-qa="profileItem1"><div>Mechanical Engineering Intern</div><div>Acme Steel</div><button>Edit</button><button>Delete</button></article>
    <label for="note">Note</label><input id="note" value="his own words">
  </div>
  <div><h3>Education</h3><button data-qa="add2">Add Education</button><article data-qa="profileItem2"><div>Lakeside</div></article></div>`;

test('R5: Oracle\'s experience entries are captured whole (tiles, buttons, labels) with no values, once per moment, and nothing on the form changes', async () => {
  await fill(ORACLE_ENTRIES, { url: 'https://fa-test.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/apply' });
  const before = await page.evaluate(() => document.querySelectorAll('article[data-qa^="profileItem"]').length);
  const got = await page.evaluate(() => {
    globalThis.__sentMsgs = [];
    const first = globalThis.__jarvisContent.captureOracleEntries('after the resume parse');
    const again = globalThis.__jarvisContent.captureOracleEntries('after the resume parse');
    return { first, again, msgs: globalThis.__sentMsgs.filter((m) => m.type === 'capture') };
  });
  assert.equal(got.first, 1, 'the experience section only, not education');
  assert.equal(got.again, 0, 'once per page and moment');
  assert.equal(got.msgs.length, 1);
  const m = got.msgs[0];
  assert.match(m.why, /^R5: Oracle entries after the resume parse \(2 shown\)$/);
  assert.equal(m.label, 'Add Experience');
  assert.match(m.html, /profileItem1/);
  assert.match(m.html, /Mechanical Engineering Intern/, 'the tile text it already shows is kept');
  assert.match(m.html, />Delete</, 'its controls too');
  assert.doesNotMatch(m.html, /his own words/, 'no value leaves the box');
  assert.doesNotMatch(m.html, /Lakeside/, 'another section is not swept in');
  assert.equal(await page.evaluate(() => document.querySelectorAll('article[data-qa^="profileItem"]').length), before, 'nothing on the form changed');
});

test('R5: no capture anywhere but Oracle', async () => {
  await fill(ORACLE_ENTRIES, { url: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x/apply' });
  const n = await page.evaluate(() => globalThis.__jarvisContent.captureOracleEntries('after the resume parse'));
  assert.equal(n, 0);
});

test('S6: a run returns where its time went — phase names and whole ms, nothing of the page', async () => {
  // The plan answer takes a known 30 ms here, so the plan's clock is proved
  // without depending on how fast this machine reads a four-field form.
  const slowPlan = '(plan) => { const t0 = Date.now(); while (Date.now() - t0 < 30) { /* the dashboard thinking */ } return plan; }';
  const result = await fill(`<h2>Apply</h2>${FOUR}`, { editPlan: slowPlan });
  const t = result.timings;
  assert.ok(t && typeof t === 'object', JSON.stringify(result).slice(0, 300));
  for (const k of ['total', 'discover', 'plan', 'answers', 'resume', 'dropdowns', 'entries', 'waits']) {
    assert.ok(Number.isInteger(t[k]) && t[k] >= 0, `${k}: ${t[k]}`);
  }
  assert.ok(t.total >= t.plan && t.total >= t.discover, 'the phases sit inside the run');
  assert.ok(t.plan >= 25, `the plan's wait was timed: ${JSON.stringify(t)}`);
  assert.ok(['discover', 'plan', 'answers', 'resume', 'dropdowns', 'entries', 'waits'].includes(t.slowest));
  const words = JSON.stringify(t).replace(/"(total|discover|plan|answers|resume|dropdowns|entries|waits|slowest|hidden|waitSites|v)"/g, '');
  assert.doesNotMatch(words, /Alex|First|Name|Email|Phone|@|http/i, 'no page text and no answers in it');
  // S5: each wait is charged to the line that asked for it, numbers only.
  assert.ok(Array.isArray(t.waitSites) && t.waitSites.length > 0, `the waits are named: ${JSON.stringify(t.waitSites)}`);
  const lines = CONTENT.split(/\r?\n/);
  for (const s of t.waitSites) {
    assert.equal(s.length, 5);
    assert.ok(s.every((x) => Number.isInteger(x) && x >= 0), JSON.stringify(s));
    assert.match(lines[s[0] - 1] || '', /pause\(/, `line ${s[0]} is a wait: ${lines[s[0] - 1]}`);
    assert.ok(s[3] >= 1, 'counted');
  }
  for (let i = 1; i < t.waitSites.length; i += 1) assert.ok(t.waitSites[i - 1][1] >= t.waitSites[i][1], 'longest first');
});

// P2 (2026-11-07, review fixes): Oracle's cx-select, set through its own React
// props once the menu found nothing. The menu here never shows a row (Oracle's
// filtered window without the right one); the props hold the whole list.
// `owner`: whose props the nearest option list is — 'self' (the box's id) or
// another field's. The box's own valueObserver writes the label into it.
// `silent`: the box's own setter runs but never writes the label back (a read-back that fails).
function oracleBox(question, id, options, { owner = 'self', silent = false } = {}) {
  return `
    <label for="${id}">${question}</label>
    <div class="cx-select-container"><input id="${id}" name="${id}" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="${id}-listbox" aria-expanded="false" class="cx-select-input"></div>
    <div id="${id}-listbox" role="grid" class="cx-select__list"></div>
    <script>(() => {
      const input = document.getElementById('${id}');
      const OPTIONS = ${JSON.stringify(options)}.map((o, i) => ({ label: o, value: 'v' + i }));
      window.__setCalls = window.__setCalls || [];
      const props = {
        id: ${JSON.stringify(owner === 'self' ? id : owner)}, options: OPTIONS,
        valueObserver: (v) => { window.__setCalls.push(${JSON.stringify(owner === 'self' ? id : owner)}); if (${JSON.stringify(owner === 'self' && !silent)}) input.value = OPTIONS.find((o) => o.value === v).label; },
      };
      input['__reactFiber$p2test'] = { memoizedProps: { className: 'cx-select-input' }, return: { memoizedProps: { className: 'row' }, return: { memoizedProps: props, return: null, child: null }, child: null } };
    })();<\/script>`;
}
const MONTHS12 = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const asPrompt = (re, value) => `(plan) => { for (const a of plan.actions) if (${re}.test(a.label)) { a.action = 'prompt'; a.value = ${JSON.stringify(value)}; a.values = undefined; a.promptKind = 'combo'; } return plan; }`;
const p2Sent = () => page.evaluate(() => ({
  picks: globalThis.__sentMsgs.filter((m) => m.type === 'oracle-pick').length,
  sets: globalThis.__sentMsgs.filter((m) => m.type === 'oracle-set').length,
  said: globalThis.__sentMsgs.filter((m) => m.type === 'capture' && /^P2:/.test(m.why || '')).map((m) => m.why),
  setCalls: window.__setCalls || [],
}));

test('P2: the menu found nothing, so the box\'s OWN list is set through its props — and the box shows it', async () => {
  const result = await fill(oracleBox('Start month', 'startMonth-4', MONTHS12), { editPlan: asPrompt('/start month/i', 'May') });
  assert.equal(await page.evaluate(() => document.getElementById('startMonth-4').value), 'May');
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets], [1, 1], 'read once, set once');
  assert.deepEqual(s.setCalls, ['startMonth-4']);
  assert.match(s.said.join(' | '), /kept/);
  assert.ok(result.filled >= 1, JSON.stringify(result.unanswered));
});

test('P2: a list that belongs to ANOTHER field (an ancestor\'s model) is refused, and nothing is set', async () => {
  await fill(oracleBox('Start month', 'startMonth-4', MONTHS12, { owner: 'gender-7' }), { editPlan: asPrompt('/start month/i', 'May') });
  assert.equal(await page.evaluate(() => document.getElementById('startMonth-4').value), '');
  const s = await p2Sent();
  assert.equal(s.sets, 0, 'never asked to set');
  assert.deepEqual(s.setCalls, [], 'the other field\'s setter never called');
  assert.match(s.said.join(' | '), /not set \(the nearest option list is not this box/);
});

test('P2: self-identification, work authorization and the like never go through this path, whatever the plan says', async () => {
  await fill(oracleBox('Veteran status', 'veteran-2', ['I am not a protected veteran', 'I am a protected veteran'])
    + oracleBox('Will you now or in the future require visa sponsorship?', 'sponsor-3', ['Yes', 'No']), {
    editPlan: `(plan) => { for (const a of plan.actions) { const v = /veteran/i.test(a.label) ? 'I am not a protected veteran' : /sponsorship/i.test(a.label) ? 'Yes' : null; if (v) { a.action = 'prompt'; a.value = v; a.values = undefined; a.promptKind = 'combo'; } } return plan; }`,
  });
  assert.deepEqual(await page.evaluate(() => [document.getElementById('veteran-2').value, document.getElementById('sponsor-3').value]), ['', '']);
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls.length], [0, 0, 0]);
});

test('P2: work authorization and export wordings with no "visa" or "sponsor" in them never go through this path either (third review)', async () => {
  const qs = [
    ['Are you legally eligible to work in the U.S.?', 'legal-1'],
    ['Do you now or in the future require immigration support?', 'immig-2'],
    ['Are you currently on OPT?', 'opt-3'],
    ['Is any of your past work subject to EAR?', 'ear-4'],
    ['Are you a U.S. person under export rules?', 'usp-5'],
  ];
  await fill(qs.map(([q, id]) => oracleBox(q, id, ['Yes', 'No'])).join(''), { editPlan: asPrompt('/legally|immigration|OPT|EAR|U\\.S\\. person/', 'Yes') });
  assert.deepEqual(await page.evaluate((ids) => ids.map((id) => document.getElementById(id).value), qs.map(([, id]) => id)), qs.map(() => ''));
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls.length], [0, 0, 0]);
});

test('P2: a generic label under a work-authorization heading is refused', async () => {
  await fill(`<section><h2>Work Authorization</h2>${oracleBox('Select one', 'wa-9', ['Yes', 'No'])}</section>`, { editPlan: asPrompt('/select one/i', 'Yes') });
  assert.equal(await page.evaluate(() => document.getElementById('wa-9').value), '');
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls.length], [0, 0, 0]);
});

test('P2: an ordinary label with "year", "early" or "option" in it is NOT blocked by the new words', async () => {
  const result = await fill(oracleBox('Earliest year you could start (pick an option)', 'year-6', ['2026', '2027']), { editPlan: asPrompt('/earliest year/i', '2027') });
  assert.equal(await page.evaluate(() => document.getElementById('year-6').value), '2027');
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets], [1, 1]);
  assert.match(s.said.join(' | '), /kept/);
  assert.ok(result.filled >= 1, JSON.stringify(result.unanswered));
});

test('P2: a pick that never answers is given up after the limit, and the box is left as it is', async () => {
  const result = await fill(oracleBox('Start month', 'startMonth-4', MONTHS12), {
    editPlan: asPrompt('/start month/i', 'May'),
    before: () => page.evaluate(() => { globalThis.__jarvisP2LimitMs = 1000; globalThis.__duringPick = () => new Promise(() => {}); }),
  });
  assert.notEqual(await page.evaluate(() => document.getElementById('startMonth-4').value), 'May');
  const s = await p2Sent();
  // The settled-page retry (F-716) may ask once more; each ask is bounded.
  assert.ok(s.picks >= 1 && s.picks <= 2, `picks ${s.picks}`);
  assert.deepEqual([s.sets, s.setCalls.length], [0, 0]);
  assert.match(s.said.join(' | '), /not set \(no answer within 1 s\)/);
  assert.match(result.unanswered.join(' | '), /Start month/);
});

test('P2: the setter ran but the box does not show it: reported as set but not confirmed, for him to check', async () => {
  const result = await fill(oracleBox('Start month', 'startMonth-4', MONTHS12, { silent: true }), { editPlan: asPrompt('/start month/i', 'May') });
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls], [1, 1, ['startMonth-4']]);
  assert.match(s.said.join(' | '), /set, but not confirmed; check this field/);
  assert.match(result.unanswered.join(' | '), /Start month \(set through the list's own props, but not confirmed; check this field\)/);
  assert.doesNotMatch(result.unanswered.join(' | '), /nothing matched/);
});

test('P2: a generic label under a self-identification heading is refused too', async () => {
  await fill(`<section><h2>Voluntary Self-Identification</h2>${oracleBox('Select one', 'eeo-9', ['Option A', 'Option B'])}</section>`, { editPlan: asPrompt('/select one/i', 'Option A') });
  assert.equal(await page.evaluate(() => document.getElementById('eeo-9').value), '');
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls.length], [0, 0, 0]);
});

test('P2: he types into the box after Jarvis\'s last look but before the page\'s setter — nothing is written', async () => {
  await fill(oracleBox('Start month', 'startMonth-4', MONTHS12), {
    editPlan: asPrompt('/start month/i', 'May'),
    before: () => page.evaluate(() => { globalThis.__duringSet = () => globalThis.__hisKeys('#startMonth-4', 'Ju'); }),
  });
  assert.equal(await page.evaluate(() => document.getElementById('startMonth-4').value), 'Ju', 'his keys stand');
  const s = await p2Sent();
  assert.deepEqual([s.sets, s.setCalls.length], [1, 0], 'asked to set, and the page refused');
  assert.match(s.said.join(' | '), /not set \(box changed/);
});

test('P2: the box holding exactly the wanted text while FOCUSED is not taken as ours', async () => {
  await fill(oracleBox('Start month', 'startMonth-4', MONTHS12), {
    editPlan: asPrompt('/start month/i', 'May'),
    before: () => page.evaluate(() => { globalThis.__duringPick = () => { const b = document.getElementById('startMonth-4'); b.value = 'May'; b.focus(); }; }),
  });
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls.length], [1, 0, 0]);
  assert.match(s.said.join(' | '), /the box changed while its list was read/);
});

test('P2: the box filled while its list was being read is left as it is', async () => {
  await fill(oracleBox('Start month', 'startMonth-4', MONTHS12), {
    editPlan: asPrompt('/start month/i', 'May'),
    before: () => page.evaluate(() => { globalThis.__duringPick = () => { document.getElementById('startMonth-4').value = 'June'; }; }),
  });
  assert.equal(await page.evaluate(() => document.getElementById('startMonth-4').value), 'June', 'what arrived meanwhile stays');
  const s = await p2Sent();
  assert.deepEqual([s.picks, s.sets, s.setCalls.length], [1, 0, 0]);
  assert.match(s.said.join(' | '), /the box changed while its list was read/);
});

// F-1035 (2026-11-07): a search that finds nothing never leaves its word in a box that already held an answer.
test('F-1035: a combobox that already holds an answer is not left showing the search word when nothing matches', async () => {
  // No React fiber here, so P2's path stays out of it: only the menu path is under test.
  await fill(`
    <label for="startMonth-9">Start month</label>
    <div class="cx-select-container"><input id="startMonth-9" name="startMonth-9" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="startMonth-9-listbox" aria-expanded="false" class="cx-select-input" value="June"></div>
    <div id="startMonth-9-listbox" role="grid" class="cx-select__list"></div>`, { editPlan: asPrompt('/start month/i', 'May') });
  assert.equal(await page.evaluate(() => document.getElementById('startMonth-9').value), 'June', 'the answer it held, not the typed search');
});

test('F-1035: a box he types into during the search is left as he left it, not put back', async () => {
  // Once the search word is in, his own keys (trusted, from the test) arrive while the list is awaited.
  await fill(`
    <label for="startMonth-10">Start month</label>
    <div class="cx-select-container"><input id="startMonth-10" name="startMonth-10" type="text" role="combobox" aria-autocomplete="list" aria-haspopup="grid" aria-controls="startMonth-10-listbox" aria-expanded="false" class="cx-select-input" value="June"></div>
    <div id="startMonth-10-listbox" role="grid" class="cx-select__list"></div>`, {
    editPlan: asPrompt('/start month/i', 'May'),
    before: () => page.evaluate(() => {
      const b = document.getElementById('startMonth-10');
      let done = false;
      b.addEventListener('input', () => {
        if (done || b.value !== 'May') return;
        done = true;
        globalThis.__hisDone = globalThis.__hisKeys('#startMonth-10', 'Jul').then(() => { globalThis.__hisLeft = b.value; });
      });
    }),
  });
  await page.evaluate(() => globalThis.__hisDone);
  const [shown, left] = await page.evaluate(() => [document.getElementById('startMonth-10').value, globalThis.__hisLeft]);
  assert.ok(left && left !== 'June' && left !== 'May', `his keys landed: ${left}`);
  assert.equal(shown, left, 'what he typed stands');
});

test('P2: a box he touched is his — never set through its props', async () => {
  await fill(oracleBox('Start month', 'startMonth-4', MONTHS12), {
    editPlan: asPrompt('/start month/i', 'May'),
    // His own keys (a script's would not be his): typed, then cleared.
    before: async () => { await page.click('#startMonth-4'); await page.keyboard.type('Ma'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await wait(2700); },
  });
  assert.equal(await page.evaluate(() => document.getElementById('startMonth-4').value), '');
  const s = await p2Sent();
  assert.deepEqual([s.sets, s.setCalls.length], [0, 0]);
});

// (F-1024's tests sit above this block: they read the page clock moving — review 2026-11-06.)
// F-1024 (2026-11-06): "i try to edit it myself the dropdown but it keeps running my shit over".
// What he touched is his: no run writes it again, not even one he presses.
const HIS_FORM = `<h2>Apply</h2>${FOUR}
  <label for="g">Gender</label><select id="g"><option>Select</option><option>Male</option><option>Female</option><option>Decline to answer</option></select>`;

test('F-1024: he picks a different option, and even a run he presses leaves it', async () => {
  await fillAs(HIS_FORM, { armed: true, auto: false });
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Male', 'the first run answers it');
  // His own pick, with real keys: a scripted change would not be his.
  await page.focus('#g');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Female');
  await wait(2700);   // past the run's wait for his hands
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
  const again = await page.evaluate(CONTENT);
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Female', 'his pick stays');
  assert.ok(again && !String(again.stoppedBecause || '').match(/error/i), JSON.stringify(again?.stoppedBecause));
});

test('F-1024: he clears a box, and it stays empty', async () => {
  await fillAs(HIS_FORM, { armed: true, auto: false });
  assert.ok(await page.evaluate(() => document.getElementById('phone').value), 'the first run answers it');
  await page.click('#phone', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  assert.equal(await page.evaluate(() => document.getElementById('phone').value), '');
  await wait(2700);
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
  await page.evaluate(CONTENT);
  assert.equal(await page.evaluate(() => document.getElementById('phone').value), '', 'the box he emptied stays empty');
});

test('F-1024: the SITE wipes a box once, and Jarvis puts it back; one that is wiped every time is entered three times at most', async () => {
  // Jarvis's own typing raises trusted input events (execCommand): it must never count as his.
  await fillAs(`<h2>Apply</h2>${FOUR}
    <script>
      let wiped = 0;
      document.getElementById('email').addEventListener('change', (e) => { if (wiped++ === 0) setTimeout(() => { e.target.value = ''; }, 50); });
      globalThis.__phoneWrites = 0;
      document.getElementById('phone').addEventListener('change', (e) => { globalThis.__phoneWrites += 1; setTimeout(() => { e.target.value = ''; }, 50); });
    <\/script>`, { armed: true, auto: false });
  assert.equal(await page.evaluate(() => document.getElementById('email').value), 'v@example.test', 'the wiped box is filled again');
  // One typed entry raises several change events, so count the RUNS that wrote it.
  const changes = () => page.evaluate(() => globalThis.__phoneWrites);
  const wrote = [(await changes()) > 0];
  const said = [];
  for (let i = 0; i < 3; i += 1) {
    const before = await changes();
    await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
    const r = await page.evaluate(CONTENT);
    said.push(...(r?.unanswered || []));
    wrote.push((await changes()) > before);
  }
  assert.deepEqual(wrote, [true, true, true, false], `entered by the first run, again twice, then left alone: ${JSON.stringify(wrote)}`);
  assert.ok(said.some((u) => /Phone.*kept clearing it/.test(u)), `named for him once it gave up: ${JSON.stringify(said)}`);
});

test('F-1024: his pick stays his when the site redraws the box a moment after it', async () => {
  // Workday and react-select re-key a field on change; the old node is gone within the half second (review).
  await fillAs(`${HIS_FORM}
    <script>
      document.addEventListener('change', (e) => {
        if (e.target.id !== 'g' || !e.isTrusted) return;
        setTimeout(() => { const old = document.getElementById('g'); const fresh = old.cloneNode(true); fresh.value = old.value; old.replaceWith(fresh); }, 30);
      }, true);
    <\/script>`, { armed: true, auto: false });
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Male');
  await page.focus('#g');
  await page.keyboard.press('ArrowDown');
  await wait(2700);
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Female', 'the redraw kept his pick');
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
  await page.evaluate(CONTENT);
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Female', 'remembered by its question, not only its node');
});

test('F-1024: a consent box the site unticks is ticked again on every run, never called "kept clearing it"', async () => {
  // The refill cap reads emptiness; a tick has none to read, so it is not capped (review).
  await fillAs(`<h2>Apply</h2>${FOUR}
    <label><input type="checkbox" id="agree"> I agree with the terms and conditions</label>`, { armed: true, auto: false });
  assert.equal(await page.evaluate(() => document.getElementById('agree').checked), true);
  const said = [];
  for (let i = 0; i < 4; i += 1) {
    await page.evaluate(() => { document.getElementById('agree').checked = false; });   // the site unticks it
    await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
    said.push(...((await page.evaluate(CONTENT))?.unanswered || []));
    assert.equal(await page.evaluate(() => document.getElementById('agree').checked), true, `ticked again on run ${i + 1}: ${JSON.stringify(said)}`);
  }
  assert.ok(!said.some((u) => /kept clearing it/.test(u)), JSON.stringify(said));
});

test('F-1024: the refill cap holds on a hash-routed form whose token changes every step', async () => {
  // #/apply?t=… changes per step; the cap is per posting, read as discover.js's pageKey reads it (review).
  const base = 'https://apply.example.test/careers/apply';
  const html = `<h2>Apply</h2>${FOUR}
    <script>
      globalThis.__phoneWrites = 0;
      document.getElementById('phone').addEventListener('change', (e) => { globalThis.__phoneWrites += 1; setTimeout(() => { e.target.value = ''; }, 50); });
    <\/script>`;
  // A route never sees the #fragment, so the page is served at its address without it.
  await page.route(base, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  try {
    await fillAs(html, { armed: true, auto: false }, `${base}#/apply?t=1`);
  } finally { await page.unroute(base).catch(() => {}); }
  const changes = () => page.evaluate(() => globalThis.__phoneWrites);
  const wrote = [(await changes()) > 0];
  for (let i = 2; i <= 4; i += 1) {
    await page.evaluate((t) => { location.hash = `#/apply?t=${t}`; }, i);
    const before = await changes();
    await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
    await page.evaluate(CONTENT);
    wrote.push((await changes()) > before);
  }
  assert.deepEqual(wrote, [true, true, true, false], `capped across the token changes: ${JSON.stringify(wrote)}`);
});

test('F-1024: what he set on one posting is not his on the next posting in the same tab', async () => {
  // Eightfold, Phenom and Taleo keep one path for every job and name it in the query (review).
  const url1 = 'https://apply.example.test/careers/apply?pid=111';
  const url2 = 'https://apply.example.test/careers/apply?pid=222';
  await fillAs(HIS_FORM, { armed: true, auto: false }, url1);
  await page.focus('#g');
  await page.keyboard.press('ArrowDown');
  await wait(800);   // his question remembered by label
  await fillAs(HIS_FORM, { armed: true, auto: false }, url2);
  assert.equal(await page.evaluate(() => document.getElementById('g').value), 'Male', 'a new posting is answered as usual');
});

test('F-1024: while he is typing, the run waits for him instead of racing him', async () => {
  await fillAs(`<h2>Apply</h2>${FOUR}`, { armed: true, auto: false });
  await page.evaluate(() => { document.getElementById('first_name').value = ''; document.getElementById('email').value = ''; });
  await page.click('#first_name');
  await page.keyboard.type('Vin');
  await page.evaluate(() => { globalThis.__jarvisRun = { armed: true, auto: false }; });
  const running = page.evaluate(CONTENT);   // a run starts while his hands are on the form
  await page.keyboard.type('cent', { delay: 150 });
  const r = await running;
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), 'Vincent', 'what he typed stays');
  assert.equal(await page.evaluate(() => document.getElementById('email').value), 'v@example.test', 'the run went on once he stopped');
  assert.ok(!(r?.unanswered || []).some((u) => /First Name/.test(u)), JSON.stringify(r?.unanswered));
});

// LAST IN THE FILE ON PURPOSE: it freezes the page clock, which would skew any
// later test that compares the page's date with the test's own.
test('F-706: a Workday signature date with no Today button is typed from the UTC clock — Workday\'s today', async () => {
  // 17:30 on Oct 3 in Springfield is already Oct 4 to Workday (Flowserve, F-690).
  await page.clock.setFixedTime(new Date('2026-10-04T00:30:00Z'));
  await fill(`<form>${dateField('dateSignedOn', { keysOnly: true })}<button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button></form>${WD_DATE_MODEL}`,
    { editPlan: planToday, url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/x/apply' });
  const got = await page.evaluate(() => [...document.querySelectorAll('input[data-part]')].map((b) => Number(b.dataset.model)));
  assert.deepEqual(got, [10, 4, 2026], 'the UTC date, whatever his clock says');
});

test('F-732: a signature date Workday refuses is retyped once as the other today, and the step moves on', async () => {
  // Crown, Generac and Samsung took his LOCAL date after 5 PM Pacific; Flowserve
  // and GlobalFoundries wanted the UTC one. This tenant wants local: the UTC
  // date typed first is refused ("The field Date is required"), the retry
  // types his date, the same press is made again, and the step advances.
  await page.clock.setFixedTime(new Date('2026-10-16T06:01:00Z'));
  const local = await page.evaluate(() => { const d = new Date(); return [d.getMonth() + 1, d.getDate(), d.getFullYear()]; });
  const utc = [10, 16, 2026];
  if (local.join('/') === utc.join('/')) return;   // a UTC machine has no second today to try
  const result = await fill(`<form onsubmit="return false">${dateField('dateSignedOn', { keysOnly: true })}
    <button data-automation-id="pageFooterNextButton" type="button">Save and Continue</button></form>${WD_DATE_MODEL}
    <script>
      window.__presses = 0;
      document.querySelector('[data-automation-id="pageFooterNextButton"]').addEventListener('click', () => {
        window.__presses += 1;
        const got = [...document.querySelectorAll('input[data-part]')].map((b) => Number(b.dataset.model));
        if (got.join('/') !== ${JSON.stringify(local.join('/'))}) {
          document.querySelector('[role="alert"]')?.remove();
          const e = document.createElement('div'); e.setAttribute('role', 'alert');
          e.textContent = 'Errors Found Error-Date The field Date is required and must have a value.';
          document.body.prepend(e);
          return;
        }
        window.__accepted = got.join('/');
        document.body.innerHTML = '<h2>Review</h2><p>Check your application.</p>';
      });
    <\/script>`,
    { editPlan: planToday, url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/x/apply' });
  const seen = await page.evaluate(() => ({ presses: window.__presses, accepted: window.__accepted || null }));
  assert.equal(seen.accepted, local.join('/'), `the step took his date after the retry (presses ${seen.presses}; ${result.stoppedBecause})`);
  assert.equal(seen.presses, 2, 'one refused press, one retry — never a loop');
  assert.doesNotMatch(String(result.stoppedBecause || ''), /would not move on/);
});

test('F-855: a masked date box that refuses "May 2026" gets "05/2026" (Paylocity work history, Optomec 2026-10-04)', async () => {
  const result = await fill(`
    <form>
      <label for="c">Company Name (required)</label><input id="c">
      <label for="p">Position</label><input id="p">
      <label for="s">Start Date</label><input id="s" placeholder="">
    </form>
    <script>
      // The mask keeps digits and slashes only, as Paylocity's does.
      document.getElementById('s').addEventListener('input', (e) => { const v = e.target.value.replace(/[^0-9/]/g, ''); if (v !== e.target.value) e.target.value = v; });
    <\/script>`);
  assert.equal(await page.evaluate(() => document.getElementById('c').value), 'Acme Fab');
  assert.equal(await page.evaluate(() => document.getElementById('s').value), '05/2026', JSON.stringify(result.unanswered));
  assert.ok(!(result.unanswered || []).some((u) => /Start Date/.test(u)), `not left for him: ${JSON.stringify(result.unanswered)}`);
});

test('F-871/F-872: an ended job\'s "Currently Working Here" is cleared, and the End Date it reveals gets that job\'s end (Paylocity, Optomec 2026-10-04)', async () => {
  const result = await fill(`
    <form>
      <label for="c">Company Name (required)</label><input id="c">
      <label for="s">Start Date</label><input id="s">
      <div><span>Reason for Leaving</span> <label><input type="checkbox" id="cur" checked> Currently Working Here</label></div>
      <div id="endbox"></div>
    </form>
    <script>
      // Paylocity draws the End Date only once the box is cleared.
      document.getElementById('cur').addEventListener('change', (e) => {
        document.getElementById('endbox').innerHTML = e.target.checked ? '' : '<label for="e">End Date</label><input id="e">';
      });
    <\/script>`);
  assert.equal(await page.evaluate(() => document.getElementById('c').value), 'Acme Fab');
  assert.equal(await page.evaluate(() => document.getElementById('cur').checked), false, 'an ended job is not current');
  const end = await page.evaluate(() => document.getElementById('e')?.value ?? null);
  assert.ok(end && /2026/.test(end) && /08|aug/i.test(end), `the revealed End Date is the job's own end, not left or guessed: ${JSON.stringify(end)} ${JSON.stringify(result.unanswered)}`);
});

test('F-897: SuccessFactors inline job rows — Add opens a row per missing job, filled boxes are never reused, no Save is asked for', async () => {
  // Modelled on Lincoln Electric's Previous Employment (2026-10-23): one row of
  // boxes, a section Add, MM/DD/YYYY date boxes. The Add here REDRAWS the whole
  // section (new elements, values kept) — the worst case for "new controls".
  const result = await fill(`
    <form onsubmit="return false">
      <label for="fn">First Name</label><input id="fn">
      <div id="sec"><h3>Previous Employment</h3><div id="rows"></div><button type="button" id="add"><span></span> Add</button></div>
    </form>
    <script>
      const vals = [{}];
      const draw = () => {
        document.getElementById('rows').innerHTML = vals.map((v, i) =>
          '<div class="row"><label for="c' + i + '">* Company Name</label><input id="c' + i + '">'
          + '<label for="t' + i + '">* Position Title</label><input id="t' + i + '">'
          + '<label for="s' + i + '">From Date</label><input id="s' + i + '" placeholder="MM/DD/YYYY">'
          + '<label for="e' + i + '">End Date</label><input id="e' + i + '" placeholder="MM/DD/YYYY"></div>').join('');
        vals.forEach((v, i) => { for (const k of ['c', 't', 's', 'e']) { const el = document.getElementById(k + i); el.value = v[k] || ''; el.addEventListener('input', () => { v[k] = el.value; }); el.addEventListener('change', () => { v[k] = el.value; }); } });
      };
      draw();
      document.getElementById('add').addEventListener('click', () => { vals.push({}); draw(); });
    <\/script>`);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((r) => [...r.querySelectorAll('input')].map((i) => i.value)));
  assert.equal(rows.length, 2, `one row per job, no extra: ${JSON.stringify(rows)} ${JSON.stringify(result.unanswered)}`);
  assert.equal(rows[0][0], 'Acme Fab');
  assert.equal(rows[0][2], '05/01/2026', 'MM/DD/YYYY, never "May 2026" (F-899)');
  assert.equal(rows[1][0], 'Test University', `the second job goes in the new row: ${JSON.stringify(rows)}`);
  assert.equal(rows[1][1], 'Manufacturing Lead');
  assert.match(rows[1][2], /^08\/01\/2024$/);
  assert.ok(!result.unanswered.some((u) => /Save yourself|did not open a sub-form/.test(u)), JSON.stringify(result.unanswered));
});

test('S2: the worker resumes the copy already in the page with THIS run\'s context, not whatever sits in the shared slot', async () => {
  await fillAs(`<h2>Apply</h2>${FOUR}`, { armed: true, auto: false, runToken: 'A', loadId: 'L1' });
  const got = await page.evaluate(async () => {
    const before = { has: typeof globalThis.__jarvisResumeRun, active: globalThis.__jarvisActiveRun, filled: document.querySelector('#first_name').value };
    globalThis.__jarvisRun = { runToken: 'OTHER' };   // another press's context in the shared slot
    const res = await globalThis.__jarvisResumeRun({ armed: true, auto: false, runToken: 'B', loadId: 'L1' });
    return { before, active: globalThis.__jarvisActiveRun, run: globalThis.__jarvisRun.runToken, content: globalThis.__jarvisContent.RUN.runToken, startedArmed: globalThis.__jarvisContent.RUN.startedArmed, res: !!res && typeof res === 'object' };
  });
  assert.equal(got.before.has, 'function', 'content.js leaves the entry point');
  assert.equal(got.before.active, 'A');
  assert.ok(got.before.filled, 'the first run filled the form');
  assert.equal(got.active, 'B', 'the resume claims the page for its own run');
  assert.equal(got.run, 'B');
  assert.equal(got.content, 'B', 'the resident copy now carries this run');
  assert.equal(got.startedArmed, true);
  assert.ok(got.res, 'and answers like a run');
});

// ── P3 (Simplify plan, phase 3, approved 2026-11-06): school and degree, Places, ticked rows ──

/**
 * A Greenhouse-style School box over a REMOTE list: opening it shows a first
 * page; typing searches the whole list (contains, case aside) after 200 ms
 * and shows at most `pageSize` rows, as a server's first page does. With
 * `otherBox`, choosing "Other" opens a name box under it.
 */
function remoteSchoolFixture({ firstPage, schools, otherBox = false, pageSize = 3, label = 'School' }) {
  return `
    <label id="s-label" for="s">${label}</label>
    <div class="select__control"><div class="select__value-container">
      <div class="select__input-container">
        <input id="s" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-labelledby="s-label">
      </div>
    </div></div>
    <div id="menu"></div>
    <div id="other-wrap"></div>
    <script>(() => {
      const FIRST = ${JSON.stringify(firstPage)};
      const ALL = ${JSON.stringify(schools)};
      const input = document.getElementById('s');
      const menu = document.getElementById('menu');
      const vc = document.querySelector('.select__value-container');
      window.__searched = [];
      const show = (rows) => {
        menu.textContent = '';
        for (const o of rows) {
          const d = document.createElement('div');
          d.setAttribute('role', 'option');
          d.textContent = o;
          d.addEventListener('click', () => {
            input.value = '';
            let sv = vc.querySelector('.select__single-value');
            if (!sv) { sv = document.createElement('div'); sv.className = 'select__single-value'; vc.prepend(sv); }
            sv.textContent = o;
            menu.textContent = '';
            input.setAttribute('aria-expanded', 'false');
            if (${otherBox ? 'true' : 'false'} && o === 'Other' && !document.getElementById('o')) {
              document.getElementById('other-wrap').innerHTML = '<label for="o">If other, please enter your school name</label><input id="o" type="text">';
            }
          });
          menu.appendChild(d);
        }
        input.setAttribute('aria-expanded', rows.length ? 'true' : 'false');
      };
      let t = 0;
      input.addEventListener('mousedown', () => { if (!input.value) show(FIRST); });
      input.addEventListener('input', () => {
        clearTimeout(t);
        const q = input.value.trim().toLowerCase();
        if (!q) { show(FIRST); return; }
        window.__searched.push(q);
        t = setTimeout(() => {
          const hits = ALL.filter((s) => s.toLowerCase().includes(q)).slice(0, ${pageSize});
          if (hits.length) show(hits);
          else { menu.innerHTML = '<div role="option">No options</div>'; }
        }, 200);
      });
    })();<\/script>`;
}

const P3_UNIS = ['University of Alabama', 'University of Arizona', 'University of Arkansas', 'University of Washington', 'Washington State University'];
const P3_FIRST = ['Abilene Christian University', 'Adelphi University', 'Other'];
const schoolShown = () => page.evaluate(() => document.querySelector('.select__single-value')?.textContent || '');

test('P3: a school that opens on "University of" is searched by the word that tells it apart', async () => {
  await fill(remoteSchoolFixture({ firstPage: P3_FIRST, schools: P3_UNIS }), {
    editPlan: `(plan) => { for (const a of plan.actions) if (a.label === 'School') { a.value = 'University of Washington'; delete a.values; } return plan; }`,
  });
  assert.equal(await schoolShown(), 'University of Washington');
  const searched = await page.evaluate(() => window.__searched);
  assert.ok(searched.includes('washington'), `searched: ${searched.join(' | ')}`);
});

test('P3: a first page holding "Other" never wins over his school, which the search finds', async () => {
  const result = await fill(remoteSchoolFixture({ firstPage: P3_FIRST, schools: [...P3_UNIS, 'Lakeside University', 'Other'] }));
  assert.equal(await schoolShown(), 'Lakeside University');
  assert.equal(result.unanswered.some((u) => /chose "Other"/.test(u)), false);
});

test('P3: a school list without his school takes its "Other" row last, names it for him, and the name box under it gets the name', async () => {
  const result = await fill(remoteSchoolFixture({ firstPage: P3_FIRST, schools: [...P3_UNIS, 'Other'], otherBox: true }));
  assert.equal(await schoolShown(), 'Other');
  assert.ok(result.unanswered.some((u) => /(^|: )School \(chose "Other": "Lakeside University" is not on this list/.test(u)), `unanswered: ${result.unanswered.join(' | ')}`);
  assert.equal(result.unanswered.some((u) => /School \(no "Lakeside University"\)/.test(u)), false, 'one line for the field, not two');
  const named = await page.evaluate(() => document.getElementById('o')?.value || '');
  assert.equal(named, 'Lakeside University', 'the box that opened under "Other" holds his school');
});

test('P3: "Other" is never taken over an answer already in the box', async () => {
  const result = await fill(remoteSchoolFixture({ firstPage: P3_FIRST, schools: [...P3_UNIS, 'Other'] }), {
    before: () => page.evaluate(() => {
      const vc = document.querySelector('.select__value-container');
      const sv = document.createElement('div'); sv.className = 'select__single-value'; sv.textContent = 'Adelphi University'; vc.prepend(sv);
    }),
  });
  assert.equal(await schoolShown(), 'Adelphi University');
  assert.equal(result.unanswered.some((u) => /chose "Other"/.test(u)), false);
});

/**
 * Google Places, as its markup is drawn (not met live yet): a .pac-container
 * at the end of <body>, .pac-item rows of inline spans. The HOVERED row is
 * what the box takes when it loses focus; a click alone does nothing. This
 * list answers "Springfield, WA" and "Springfield", never "Springfield, Washington".
 */
function placesFixture({ takesHover = true } = {}) {
  return `
    <label for="loc">Location</label><input id="loc" type="text" autocomplete="off">
    <script>(() => {
      const PLACES = [['Springfield', 'WA, USA'], ['Springfield Valley', 'WA, USA']];
      const input = document.getElementById('loc');
      window.__typedPlaces = [];
      let box = null, hovered = null, t = 0;
      const close = () => { if (box) box.remove(); box = null; };
      input.addEventListener('input', () => {
        clearTimeout(t); close(); hovered = null;
        const q = input.value.trim().toLowerCase();
        if (!q) return;
        window.__typedPlaces.push(q);
        t = setTimeout(() => {
          const hits = PLACES.filter(([n, r]) => (n + ', ' + r).toLowerCase().startsWith(q));
          if (!hits.length) return;
          box = document.createElement('div'); box.className = 'pac-container';
          for (const [n, r] of hits) {
            const row = document.createElement('div'); row.className = 'pac-item';
            row.innerHTML = '<span class="pac-icon pac-icon-marker"></span><span class="pac-item-query"><span class="pac-matched">' + n + '</span></span><span>' + r + '</span>';
            if (${takesHover ? 'true' : 'false'}) row.addEventListener('mouseover', () => { hovered = n + ', ' + r; });
            box.appendChild(row);
          }
          document.body.appendChild(box);
        }, 150);
      });
      input.addEventListener('blur', () => { if (hovered) { input.value = hovered; window.__placeChosen = hovered; } close(); });
    })();<\/script>`;
}

test('P3: a Google Places box is searched "City, ST" when "City, State" finds nothing, and the row is taken by hover then blur', async () => {
  await fill(placesFixture());
  const got = await page.evaluate(() => ({ value: document.getElementById('loc').value, chosen: window.__placeChosen || '', typed: window.__typedPlaces }));
  assert.equal(got.chosen, 'Springfield, WA, USA', `typed: ${got.typed.join(' | ')}`);
  assert.equal(got.value, 'Springfield, WA, USA');
  assert.ok(got.typed.includes('springfield, wa'), `the state's code was tried: ${got.typed.join(' | ')}`);
});

test('P3: a Places list that ignores the hover is not reported as chosen (review 2026-11-12)', async () => {
  const result = await fill(placesFixture({ takesHover: false }));
  const got = await page.evaluate(() => ({ value: document.getElementById('loc').value, chosen: window.__placeChosen || '' }));
  assert.equal(got.chosen, '', 'the list took nothing');
  assert.ok(result.unanswered.some((u) => /(^|: )Location \(/.test(u)), `Location is named for him: ${result.unanswered.join(' | ')} (box reads "${got.value}")`);
});

test('P3: the "Other" last resort takes only an Other row, never a school named "Other Valley College"', async () => {
  const result = await fill(remoteSchoolFixture({ firstPage: ['Abilene Christian University', 'Adelphi University'], schools: [...P3_UNIS, 'Other Valley College'] }));
  assert.equal(await schoolShown(), '', 'no row is a school he did not attend');
  assert.equal(result.unanswered.some((u) => /chose "Other/.test(u)), false, `unanswered: ${result.unanswered.join(' | ')}`);
});

/**
 * A Workday multi-select whose rows carry checkboxes, where clicking a
 * TICKED row un-chooses it — the row is a toggle. AutoCAD is already chosen.
 */
function tickedMultiFixture(taxonomy, already) {
  return `
    <form>
      <div data-automation-id="formField-skills">
        <label>Type to Add Skills *</label>
        <div data-automation-id="multiSelectContainer">
          <div data-automation-id="selectedItemList" id="chips"></div>
          <input data-automation-id="searchBox" id="search" type="text" aria-controls="lb" aria-required="true">
        </div>
      </div>
      <ul id="lb" role="listbox" style="display:none"></ul>
      <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
    </form>
    <script>(() => {
      const TAX = ${JSON.stringify(taxonomy)};
      const picked = new Set(${JSON.stringify(already)});
      const box = document.getElementById('search');
      const lb = document.getElementById('lb');
      const chips = document.getElementById('chips');
      const drawChips = () => { chips.innerHTML = [...picked].map((p) => '<span>' + p + '</span>').join(''); };
      drawChips();
      box.addEventListener('keyup', () => {
        const q = box.value.trim().toLowerCase();
        setTimeout(() => {
          const hits = q ? TAX.filter((t) => t.toLowerCase().includes(q)) : [];
          lb.innerHTML = hits.length ? hits.map((t) => '<li role="option"><input type="checkbox"' + (picked.has(t) ? ' checked' : '') + '>' + t + '</li>').join('') : '<li role="option">No Items.</li>';
          lb.style.display = 'block';
        }, 120);
      });
      lb.addEventListener('click', (e) => {
        const row = e.target.closest('[role="option"]');
        if (!row || /No Items/.test(row.textContent)) return;
        const t = row.textContent.trim();
        if (picked.has(t)) picked.delete(t); else picked.add(t);
        drawChips(); box.value = ''; lb.style.display = 'none';
      });
    })();<\/script>`;
}

test('P3: a row already ticked in a Workday multi-select is answered, never clicked (which would un-choose it)', async () => {
  await fill(tickedMultiFixture(['AutoCAD', 'Python (Programming Language)', 'Welding'], ['AutoCAD']), {
    editPlan: `(plan) => { for (const a of plan.actions) if (/Skills/.test(a.label)) { a.action = 'prompt'; a.promptKind = 'multi'; a.values = ['AutoCAD', 'Python (Programming Language)']; a.value = 'AutoCAD'; } return plan; }`,
  });
  const chips = await page.evaluate(() => [...document.querySelectorAll('#chips span')].map((s) => s.textContent));
  assert.ok(chips.includes('AutoCAD'), `AutoCAD is still chosen: ${chips.join(', ')}`);
  assert.ok(chips.includes('Python (Programming Language)'), `and the next skill was added: ${chips.join(', ')}`);
});

/**
 * P4: A FILL NEVER MOVES THE PAGE (Simplify research 2026-11-06). He reads the
 * form while it fills; a page that jumps to each box loses his place. Every
 * box here sits below the fold of a 720 px window, the page starts part-way
 * down, and the window's position is recorded on every scroll event.
 */
const P4_GAP = '<div style="height:900px"></div>';
const watchScroll = () => page.evaluate(() => {
  window.scrollTo(0, 300);
  window.__ys = [];
  window.addEventListener('scroll', () => window.__ys.push(Math.round(window.scrollY)), { passive: true });
});
const scrollsSeen = () => page.evaluate(() => ({ now: Math.round(window.scrollY), ys: window.__ys }));

test('P4: a fill of boxes, a list, a search box and a consent below the fold leaves the page where he had it', async () => {
  const result = await fill(`
    ${P4_GAP}
    <label for="fn">First Name</label><input id="fn" type="text">
    ${P4_GAP}
    <label for="ln">Last Name</label><input id="ln" type="text">
    ${P4_GAP}
    <label for="em">Email</label><input id="em" type="email">
    ${P4_GAP}
    <label for="co">Country</label><select id="co"><option value="">Select</option><option>Canada</option><option>United States</option></select>
    ${P4_GAP}
    ${remoteSchoolFixture({ firstPage: P3_FIRST, schools: [...P3_UNIS, 'Lakeside University'] })}
    ${P4_GAP}
    <label><input id="ok" type="checkbox"> I agree to the privacy policy</label>
    ${P4_GAP}`, { before: watchScroll });
  const got = await scrollsSeen();
  const vals = await page.evaluate(() => ({ fn: document.getElementById('fn').value, em: document.getElementById('em').value, co: document.getElementById('co').value, ok: document.getElementById('ok').checked }));
  assert.ok(vals.fn && vals.em && vals.co === 'United States', `the boxes filled: ${JSON.stringify(vals)} (answered ${result.answered?.length})`);
  assert.equal(await schoolShown(), 'Lakeside University', 'the search box filled');
  assert.deepEqual({ now: got.now, moved: got.ys.filter((y) => y !== 300) }, { now: 300, moved: [] }, `the window moved: ${got.ys.join(', ')}`);
});

test('P4: a walk to the next step presses a Next below the fold without scrolling to it', async () => {
  const result = await fill(`
    <div id="app"></div>
    <script>
      const tall = '<div style="height:2400px"></div>';
      const steps = [
        '<h2>My Information</h2>' + tall + '<label for="first_name">First Name</label><input id="first_name">' + tall +
          '<button data-automation-id="pageFooterNextButton">Save and Continue</button><div style="height:300px"></div>',
        '<h2>Review</h2>' + tall + '<label for="email">Email</label><input id="email">' + tall +
          '<button data-automation-id="pageFooterNextButton">Submit</button><div style="height:300px"></div>',
      ];
      let i = 0;
      const render = () => {
        document.getElementById('app').innerHTML = steps[i];
        const b = document.querySelector('[data-automation-id="pageFooterNextButton"]');
        if (b && b.textContent === 'Save and Continue') b.onclick = () => { i += 1; render(); };
        if (b && b.textContent === 'Submit') b.onclick = () => { window.__SUBMITTED = true; };
      };
      render();
    </script>`, { before: watchScroll });
  assert.equal(result.steps, 2, JSON.stringify(result.stoppedBecause));
  assert.equal(await page.evaluate(() => document.getElementById('email')?.value), 'v@example.test');
  assert.equal(await page.evaluate(() => !!window.__SUBMITTED), false, 'SUBMIT IS HIS');
  const got = await scrollsSeen();
  assert.deepEqual({ now: got.now, moved: got.ys.filter((y) => y !== 300) }, { now: 300, moved: [] }, `the window moved: ${got.ys.join(', ')}`);
});
