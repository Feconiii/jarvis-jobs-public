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

const PROFILE = {
  identity: {
    first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera',
    email: 'v@example.test', phone: '+1 (555) 000-0000',
    location: 'Springfield, Washington', city: 'Springfield', state: 'Washington',
    country: 'United States', postal_code: '00000', address_line1: '1 Test St',
    linkedin: 'https://linkedin.com/in/alex',
  },
  education: { school: 'State University', discipline: 'Mechanical Engineering' },
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

  // The server side, reachable from the page. Same planner the dashboard uses.
  await page.exposeFunction('__jarvisPlan', (fields, sections) => planForm(fields, PROFILE, { sections: sections || [] }));
  await page.exposeFunction('__jarvisResume', () => RESUME_BYTES);
  // The worker forwards an open list to /api/choose, which ranks it with the
  // same matcher that made the plan. The fixture answers the same way.
  await page.exposeFunction('__jarvisChoose', (want, options) => chooseOption(want, options));
});
test.after(async () => { await browser?.close(); });

/** Load a fixture, then run discover.js + content.js exactly as shipped. */
async function fill(html, { planError = '', editPlan = '', worker = null } = {}) {
  // A FRESH DOCUMENT. `setContent` reuses the current one (document.write), so
  // an armed run's watcher, its timers and `__jarvisContent` would all survive
  // into the next fixture and race it.
  await page.goto('about:blank');
  await page.setContent(html);
  await page.addScriptTag({ content: DISCOVER });
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
          else if (msg.type === 'resume') reply({ ok: true, bytes: await globalThis.__jarvisResume() });
          else if (msg.type === 'choose') { const index = await globalThis.__jarvisChoose(msg.want, msg.options); reply({ ok: true, index, value: index >= 0 ? msg.options[index] : null }); }
          else reply({ ok: false, error: 'unknown' });
        },
      },
    };
  }, { planError, editPlan, worker });
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
  assert.equal(got.edu[0].school, 'State University');
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

test('THE COOKIE BANNER IS DECLINED, never accepted, before anything is filled', async () => {
  // Stryker's banner hid the posting on 2026-09-03 and had to be declined by
  // hand. The most private choice, always; "Manage" opens a pane and is never
  // the pick; a form that merely mentions cookies is not a banner.
  const result = await fill(`
    <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px">
      By clicking “Accept All Cookies”, you agree to the storing of cookies on your device.
      <button onclick="window.__accepted = 1">Accept All Cookies</button>
      <button onclick="window.__managed = 1">Manage Cookies</button>
      <button onclick="window.__declined = (window.__declined || 0) + 1; document.getElementById('onetrust-banner-sdk').remove()">Decline All</button>
    </div>
    <label for="a">First Name</label><input id="a">`);
  assert.equal(result.filled, 1, 'the form still fills');
  const flags = await page.evaluate(() => ({ a: window.__accepted, m: window.__managed, d: window.__declined }));
  assert.equal(flags.d, 1, 'Decline All was pressed once');
  assert.equal(flags.a, undefined, 'Accept was never touched');
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

test('a question it cannot answer is reported, never guessed', async () => {
  const result = await fill(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Describe your ideal Tuesday</label><input id="b">`);
  assert.equal(result.filled, 1);
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
    <label for="b">Describe your ideal Tuesday</label><input id="b">
    <label for="c">I agree to the Terms</label><input id="c" type="checkbox">`);

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
  assert.match(src, /const fields = only \|\| discover\(\)/,
    'and use that subset instead of re-reading the page');
  assert.match(src, /await fillCurrentStep\(revealed, \{ keepExisting: auto, entries: false \}\)/,
    'the second pass must pass the revealed fields, not re-plan everything — under the same follow-along rule as the first');

  // The guard: `revealed` has to be what its name says.
  assert.match(src, /const revealed = discover\(\)\.filter\(\(f\) => !seen\.has\(/,
    'revealed means "not seen on the first pass"');
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
async function fillAs(html, run) {
  await page.goto('about:blank');   // a fresh document, see fill()
  await page.setContent(html);
  await page.addScriptTag({ content: DISCOVER });
  await page.evaluate((ctx) => {
    globalThis.__jarvisRun = ctx;
    globalThis.__sent = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg, reply) => {
          globalThis.__sent.push(JSON.parse(JSON.stringify(msg)));
          if (msg.type === 'plan') reply({ ok: true, plan: await globalThis.__jarvisPlan(msg.fields) });
          else if (msg.type === 'resume') reply({ ok: true, bytes: await globalThis.__jarvisResume() });
          else if (msg.type === 'posting') reply({ ok: true, id: 'from-page', status: 'tailoring', company: 'Acme', tailored: true });
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
    <script>document.getElementById('g').value = 'Female';</script>`;

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
  await wait(7000);
  const after = await page.evaluate(() => ({
    left: window.__left,
    onScreen: document.querySelector('h2').textContent,
    submitted: !!window.__SUBMITTED,
  }));
  assert.equal(after.onScreen, 'Review', `having filled step two, the walk carried on to the last one: ${JSON.stringify(after)}`);
  const stepTwo = after.left[1];
  assert.equal(stepTwo.email, 'v@example.test', 'step two was filled without a click');
  assert.equal(stepTwo.school, 'State University');
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
  assert.match(got.edu[0], /^State University \| /);
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
  assert.equal(email.signInRequired, true, 'it is still a wall — an account here is his call');
  assert.match(email.stoppedBecause || '', /asks for your email first/);
  assert.doesNotMatch(email.stoppedBecause || '', /sign in/i);
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
