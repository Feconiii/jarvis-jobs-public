/**
 * The extension's DOM half, run in a real browser against the forms that broke.
 *
 * Every fixture here is a reduction of a form that produced a measured bug:
 *
 *   - Lever: radio questions with no <fieldset>, where a first attempt labelled
 *     every question with its own first OPTION ("Yes", "US", "AST", "0-2") and
 *     nothing could be answered.
 *   - Eightfold / Applied Materials: twelve questions inside ONE radiogroup
 *     labelled "Position Specific Questions", so a group label existed and was
 *     useless — including on work authorisation and sponsorship.
 *   - Lever again: a <select> whose wrapper text contains every option, which
 *     made the Race field match the Hispanic rule.
 *   - React-controlled inputs, where a plain `el.value = x` is discarded on the
 *     next render.
 *
 * A real browser rather than a DOM shim, because the last of those is only
 * observable where React actually runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCOVER = readFileSync(path.join(HERE, 'discover.js'), 'utf-8');

let browser;
let page;

test.before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
test.after(async () => { await browser?.close(); });

/** Load a fixture and run the extension's own discovery over it. */
async function discoverIn(html) {
  await page.setContent(html);
  await page.addScriptTag({ content: DISCOVER });
  return page.evaluate(() => globalThis.__jarvis.discover().map((f) => ({
    label: f.label, type: f.type, options: f.options,
  })));
}

test('a Lever radio question is labelled with the QUESTION, not its first option', async () => {
  const fields = await discoverIn(`
    <form>
      <div class="app-question">
        <div class="text">Do you have the unrestricted right to work in the United States?</div>
        <ul>
          <li><input type="radio" name="auth" id="a1" value="Yes"><label for="a1">Yes</label></li>
          <li><input type="radio" name="auth" id="a2" value="No"><label for="a2">No</label></li>
        </ul>
      </div>
      <div class="app-question">
        <div class="text">Do you now, or in the future require sponsorship?</div>
        <ul>
          <li><input type="radio" name="spon" id="s1" value="Yes"><label for="s1">Yes</label></li>
          <li><input type="radio" name="spon" id="s2" value="No"><label for="s2">No</label></li>
        </ul>
      </div>
    </form>`);

  assert.equal(fields.length, 2, 'a radio group is ONE question, not one per option');
  assert.match(fields[0].label, /unrestricted right to work/);
  assert.match(fields[1].label, /require sponsorship/);
  assert.deepEqual(fields[0].options, ['Yes', 'No']);
  // The bug this pins: the label was "Yes" and no answer rule could match it.
  assert.ok(!/^Yes/.test(fields[0].label), 'the first option must not become the question');
});

test('a shared radiogroup label that names a SECTION is not used as the question', async () => {
  const fields = await discoverIn(`
    <div role="radiogroup" aria-label="Position Specific Questions">
      <div>
        <p>Are you legally authorized to work in the United States?</p>
        <div>
          <input type="radio" name="q1" id="q1a" value="Yes"><label for="q1a">Yes</label>
          <input type="radio" name="q1" id="q1b" value="No"><label for="q1b">No</label>
        </div>
      </div>
      <div>
        <p>Will you now or in the future require sponsorship?</p>
        <div>
          <input type="radio" name="q2" id="q2a" value="Yes"><label for="q2a">Yes</label>
          <input type="radio" name="q2" id="q2b" value="No"><label for="q2b">No</label>
        </div>
      </div>
    </div>`);

  assert.equal(fields.length, 2);
  // Both questions took the same useless group label before this was handled,
  // which is how twelve questions on one live form went unanswered.
  assert.notEqual(fields[0].label, fields[1].label);
  assert.match(fields[0].label, /legally authorized to work/);
  assert.match(fields[1].label, /require sponsorship/);
  for (const f of fields) assert.ok(!/^Position Specific Questions —/.test(f.label));
});

test('a fieldset legend is used when there is one', async () => {
  const fields = await discoverIn(`
    <fieldset>
      <legend>Are you willing to relocate?</legend>
      <input type="radio" name="r" id="r1" value="Yes"><label for="r1">Yes</label>
      <input type="radio" name="r" id="r2" value="No"><label for="r2">No</label>
    </fieldset>`);
  assert.equal(fields.length, 1);
  assert.match(fields[0].label, /willing to relocate/);
});

test("a select's option list does not leak into its label", async () => {
  const fields = await discoverIn(`
    <div>
      <label for="race">Race</label>
      <select id="race">
        <option>Select…</option>
        <option>Hispanic or Latino</option>
        <option>White (Not Hispanic or Latino)</option>
        <option>Asian (Not Hispanic or Latino)</option>
      </select>
    </div>`);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, 'Race', 'the label must not carry the options');
  assert.ok(!/Hispanic/.test(fields[0].label), 'this is what made Race match the Hispanic rule');
  assert.equal(fields[0].options.length, 4, 'the options themselves are still reported');
});

test('Spirit AeroSystems on iCIMS, 2026-10-02: a <style> above the options is not the question, and a date label is not its dropdowns', async () => {
  const fields = await discoverIn(`
    <div class="iCIMS_Form">
      <div class="q">Have you ever been employed by "Deloitte, LLP"?</div>
      <style>#remainderSection{background-color:white;position:absolute;top:25px;right:0;}</style>
      <div><label><input type="radio" name="q5" value="yes"> yes</label><label><input type="radio" name="q5" value="no"> no</label></div>
    </div>
    <div class="sig">
      <label>Month <select id="m"><option></option><option>Jan</option><option>Feb</option></select>
        Day <select id="d"><option></option><option>1</option><option>2</option></select>
        Year <input id="y" type="text"></label>
    </div>`);
  const radio = fields.find((f) => f.type === 'radio');
  assert.ok(radio, JSON.stringify(fields));
  assert.ok(!/remainderSection|background-color/.test(radio.label), radio.label);
  assert.match(radio.label, /Deloitte/);
  const year = fields.find((f) => f.type === 'text');
  assert.ok(!/JanFeb|Jan Feb/.test(year.label), year.label);
});

test('an unlabelled file input is still recognisable as the resume slot', async () => {
  const fields = await discoverIn('<input type="file" name="">');
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'file');
  assert.match(fields[0].label, /Resume/i, 'Workday renders this with no label at all');
});

test('A DISPLAY:NONE FILE INPUT IS STILL FOUND — the resume bug', async () => {
  // This is why no resume was ever attached. Workday's My Experience step
  // renders the upload as an input with display:none behind a "Select files"
  // button; the old filter exempted file inputs from the size check and then
  // dropped them on the display check one line later. Greenhouse, Lever and
  // Eightfold all hide it the same way, so this is not one tenant's quirk.
  const fields = await discoverIn(`
    <div>
      <h3>Resume/CV/additional documents</h3>
      <button data-automation-id="select-files">Select files</button>
      <input type="file" data-automation-id="file-upload-input-ref" style="display:none">
    </div>`);
  const file = fields.find((f) => f.type === 'file');
  assert.ok(file, 'a hidden file input must still be discovered — assigning .files works on it');
  assert.match(file.label, /Resume/i);
});

test('F-836: an iCIMS resume slot that already holds a file counts it, though its file box is empty', async () => {
  // iCIMS posts the page when a file is chosen; it comes back with the file
  // named beside an empty input (Spirit AeroSystems, 2026-10-02).
  const slot = (name, shown) => `
    <form><div class="iCIMS_ResumeContentDiv">
      <label id="label_PortalProfileFields.Resume_File">Please upload your resume (Max size: 5 MB)</label>
      <input id="PortalProfileFields.Resume_FileName" type="hidden" value="${name}">
      <div id="PortalProfileFields.Resume_FileNameLabel" class="iCIMS_CurrentFile${shown ? '' : ' iCIMS_NoDisplay'}"><span>${shown}</span></div>
      <input type="file" id="PortalProfileFields.Resume_File" name="PortalProfileFields.Resume_File" aria-labelledby="label_PortalProfileFields.Resume_File">
    </div></form>`;
  const read = async (html) => {
    await page.setContent(html);
    await page.addScriptTag({ content: DISCOVER });
    return page.evaluate(() => globalThis.__jarvis.discover().find((f) => f.type === 'file')?.attached);
  };
  assert.equal(await read(slot('Alex Rivera Resume.pdf', 'Alex Rivera Resume.pdf')), 1, 'the file iCIMS holds is counted');
  assert.equal(await read(slot('', '')), 0, 'an empty slot is still empty');
});

test('a file input labelled about MECHANICS is named by its section', async () => {
  // Workday's label is "Upload a file (5MB max)" — it matches no resume pattern,
  // so the planner called it "a file upload that is not the resume" and refused
  // to attach. The heading above it is what says what it is for.
  const fields = await discoverIn(`
    <section>
      <h3>Resume/CV/additional documents</h3>
      <p>A full resume upload is strongly encouraged.</p>
      <div>
        <label for="up">Upload a file (5MB max)</label>
        <input type="file" id="up" style="display:none">
      </div>
    </section>`);
  const file = fields.find((f) => f.type === 'file');
  assert.ok(file);
  assert.match(file.label, /Resume\/CV/, 'the section heading must reach the label');
});

test('a genuinely different upload is NOT renamed into a resume', async () => {
  const fields = await discoverIn(`
    <section>
      <h3>Portfolio</h3>
      <label for="p">Upload a file</label>
      <input type="file" id="p">
    </section>`);
  const file = fields.find((f) => f.type === 'file');
  assert.ok(!/resume|cv/i.test(file.label), 'a portfolio slot must not be mistaken for the resume');
});

test('a zero-size file input is found too', async () => {
  const fields = await discoverIn('<input type="file" style="width:0;height:0;opacity:0">');
  assert.equal(fields.filter((f) => f.type === 'file').length, 1);
});

test('hiding still hides everything that is NOT a file input', async () => {
  const fields = await discoverIn(`
    <input type="text" id="a" style="display:none"><label for="a">Hidden text</label>
    <select id="b" style="visibility:hidden"><option>x</option></select><label for="b">Hidden select</label>
    <input type="file" style="display:none">`);
  assert.deepEqual(fields.map((f) => f.type), ['file'], 'the exemption is for file inputs only');
});

test('hidden and disabled controls are not offered as questions', async () => {
  const fields = await discoverIn(`
    <input type="text" id="a"><label for="a">Visible</label>
    <input type="hidden" name="csrf" value="x">
    <input type="text" disabled id="b"><label for="b">Disabled</label>
    <input type="text" style="display:none" id="c"><label for="c">Hidden</label>
    <input type="submit" value="Submit Application">`);
  assert.deepEqual(fields.map((f) => f.label), ['Visible']);
});

test('a submit button is never returned as a field', async () => {
  const fields = await discoverIn(`
    <input type="text" id="n"><label for="n">Name</label>
    <input type="submit" value="Submit Application">
    <button type="submit">Submit</button>`);
  for (const f of fields) {
    assert.notEqual(f.type, 'submit');
    assert.ok(!/^Submit/i.test(f.label), 'a submit control must never look like a question');
  }
});

test('setNativeValue survives a React-controlled input — the one that matters', async () => {
  // A minimal controlled input: the element refuses any value it did not
  // approve, exactly as React's re-render does. A plain `el.value = x` is
  // reverted; going through the prototype setter and firing `input` is not.
  await page.setContent('<input id="ctl" value="">');
  await page.addScriptTag({ content: DISCOVER });
  const result = await page.evaluate(() => {
    const el = document.getElementById('ctl');
    let committed = '';
    // Stand in for React's store: it owns the value, and only an `input` event
    // it hears about is allowed to change what the element shows.
    el.addEventListener('input', (e) => { committed = e.target.value; });
    Object.defineProperty(el, '__committed', { get: () => committed });

    const naive = (() => { el.value = 'naive'; return committed; })();
    globalThis.__jarvis.setNativeValue(el, 'Alex Rivera');
    return { naive, viaSetter: committed, shown: el.value };
  });
  assert.equal(result.naive, '', 'a plain assignment notifies nothing — this is the bug');
  assert.equal(result.viaSetter, 'Alex Rivera', 'the native setter plus an input event is what commits');
  assert.equal(result.shown, 'Alex Rivera');
});

test('a checkbox reports its own text as an option and the question in the label', async () => {
  const fields = await discoverIn(`
    <div>
      <p>Please read and accept before continuing.</p>
      <div>
        <input type="checkbox" id="c1" name="consent">
        <label for="c1">I agree to the Terms and Conditions</label>
      </div>
    </div>`);
  assert.equal(fields.length, 1);
  assert.match(fields[0].label, /I agree to the Terms/, 'the consent wording must survive — the server matches on it');
});

test('an empty page discovers nothing rather than throwing', async () => {
  assert.deepEqual(await discoverIn('<div>No form here.</div>'), []);
});

test('the Workday start modal is recognised, and only Apply Manually is offered', async () => {
  // A fresh apply URL opens "Start Your Application" with NO form behind it, so
  // the extension found zero controls and reported nothing at all.
  await page.setContent(`
    <h2>Start Your Application</h2>
    <a data-automation-id="autofillWithResume">Autofill with Resume</a>
    <a data-automation-id="applyManually">Apply Manually</a>
    <a data-automation-id="useMyLastApplication">Use My Last Application</a>`);
  await page.addScriptTag({ content: DISCOVER });
  const picked = await page.evaluate(() => {
    const g = globalThis.__jarvis.startGate();
    return g ? g.getAttribute('data-automation-id') : null;
  });
  assert.equal(picked, 'applyManually',
    'Autofill lets Workday parse the PDF over our answers; Use My Last copies another job\'s');
});

test('ADP\'s privacy notice after Apply is a gate, and its Consent & Continue is the way through (Mando, F-692)', async () => {
  await page.setContent(`
    <button id="recruitment_jobDescription_apply">Apply</button>
    <div id="jdv_privacy_dailog" role="dialog" aria-modal="true">
      <h2>Privacy Policy</h2>
      <p>Certain jurisdictions require notice of how we use and protect your personal information.</p>
      <div><span role="button" id="go">Consent &amp; Continue</span><span role="button" id="no">Decline &amp; Close</span></div>
    </div>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.startGate()?.id || null), 'go');
  // Every consent is his yes now, a cookie notice's too (2026-10-03)…
  await page.setContent(`<div role="dialog"><p>We use cookies. See our privacy statement.</p><button id="ok">Accept</button></div>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.startGate()?.id || null), 'ok');
  // …but a sign-in box's Continue is never one, whatever its fine print says.
  await page.setContent(`<div role="dialog"><p>By continuing you agree to our Terms and Privacy Policy.</p><input type="email"><button>Continue</button></div>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.startGate()), null);
});

test('Paylocity\'s State menu: its label is "State", not "StateWashington", and it is a dropdown (Optomec, F-691)', async () => {
  await page.setContent(`
    <div data-automation-id="public-site-address-us-state-wrapper">
      <label for="public-site-address-us-state"><span>State</span>
        <div aria-haspopup="listbox" aria-expanded="false" aria-owns="st-list">
          <div class="input-select-input-single-value">Select a state</div>
          <div><input aria-autocomplete="list" id="public-site-address-us-state" type="text" value=""></div>
        </div>
      </label>
    </div>`);
  await page.addScriptTag({ content: DISCOVER });
  const f = await page.evaluate(() => globalThis.__jarvis.discover().map((x) => ({ label: x.label, type: x.type, kind: x.promptKind, current: x.current })));
  assert.equal(f.length, 1);
  assert.equal(f[0].label, 'State');
  assert.equal(f[0].type, 'prompt');
  assert.equal(f[0].kind, 'combo');
  assert.equal(f[0].current || '', '', '"Select a state" is the placeholder, not an answer');
});

test('Eightfold\'s readonly radios are questions — AMAT\'s whole Position Specific block was dropped (F-694)', async () => {
  await page.setContent(`<form>
    <label id="q_label" for="q"><span>Do you currently need any immigration support or sponsorship from Applied Materials?</span></label>
    <div role="radiogroup" id="q" aria-labelledby="q_legend">
      <div><input aria-label="Yes, Do you currently need any immigration support or sponsorship from Applied Materials?" id="q-1" name="q" type="radio" readonly value="1"><label for="q-1"><span></span><span>Yes</span></label></div>
      <div><input aria-label="No, Do you currently need any immigration support or sponsorship from Applied Materials?" id="q-2" name="q" type="radio" readonly value="2"><label for="q-2"><span></span><span>No</span></label></div>
    </div>
    <label for="t">Read only text</label><input id="t" type="text" readonly value="kept"></form>`);
  await page.addScriptTag({ content: DISCOVER });
  const f = await page.evaluate(() => globalThis.__jarvis.discover().map((x) => ({ label: x.label, type: x.type, options: (x.options || []).map((o) => o?.text ?? o) })));
  const q = f.find((x) => x.type === 'radio');
  assert.ok(q, 'the radio question is found');
  assert.match(q.label, /sponsorship/);
  assert.deepEqual(q.options, ['Yes', 'No']);
  assert.ok(!f.some((x) => /Read only text/.test(x.label)), 'a readonly TEXT box is still not a question');
});

test('UNSEEN: a question on the page that no field covers is listed, one line per question (2026-10-03)', async () => {
  await page.setContent(`<form>
    <label for="fn">First Name</label><input id="fn">
    <fieldset><legend>Are you authorized to work in the US?</legend>
      <label><input type="radio" name="auth" value="y"> Yes</label><label><input type="radio" name="auth" value="n"> No</label></fieldset>
    <div class="cookie-banner"><label>We use cookies<input type="checkbox" id="ck"></label></div>
    <input name="hp_7f2b" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
  </form>`);
  await page.addScriptTag({ content: DISCOVER });
  const r = await page.evaluate(() => ({
    all: globalThis.__jarvis.unseenControls().map((u) => u.label),
    // As if discover() had dropped everything: what would be reported.
    none: globalThis.__jarvis.unseenControls([]).map((u) => `${u.kind}|${u.label}`),
  }));
  assert.deepEqual(r.all, [], 'a form discover() reads fully reports nothing');
  assert.ok(r.none.some((x) => /^input\[text\]\|First Name/.test(x)), r.none.join(' ; '));
  assert.equal(r.none.filter((x) => /authorized/.test(x)).length, 1, 'a radio group is one line');
  assert.ok(!r.none.some((x) => /cookies|hp_7f2b/i.test(x)), 'cookie notices and honeypots are never questions');
});

test('UNSEEN: a locked Email box is not a missed question; a read-only radio still is (Lam signed in, F-716)', async () => {
  await page.setContent(`<form>
    <label for="Contact_Information_email">Email</label>
    <input id="Contact_Information_email" aria-readonly="true" readonly autocomplete="email">
    <fieldset><legend>Do you need sponsorship?</legend>
      <label><input type="radio" name="sp" value="y" readonly> Yes</label><label><input type="radio" name="sp" value="n" readonly> No</label></fieldset>
  </form>`);
  await page.addScriptTag({ content: DISCOVER });
  const none = await page.evaluate(() => globalThis.__jarvis.unseenControls([]).map((u) => u.label));
  assert.ok(!none.some((x) => /^Email/.test(x)), none.join(' ; '));
  assert.ok(none.some((x) => /sponsorship/.test(x)), none.join(' ; '));
});

test('UNSEEN: a read-only date picker already showing today is answered; an empty one is still a miss (Micron, F-737)', async () => {
  const picker = (id, value) => `<label id="${id}_label" for="${id}">Date</label>
    <input role="combobox" aria-expanded="false" aria-haspopup="dialog" aria-label="Select date" id="${id}" readonly placeholder="Select date"
      aria-labelledby="${id}_label" aria-required="true" aria-readonly="true" value="${value}">`;
  await page.setContent(`<form><div>${picker('signed', '16 Oct 2026')}</div><div>${picker('blank', '')}</div></form>`);
  await page.addScriptTag({ content: DISCOVER });
  const ids = await page.evaluate(() => globalThis.__jarvis.unseenControls([]).map((u) => u.el.id));
  assert.ok(!ids.includes('signed'), 'the filled date is not "answer it yourself"');
  assert.ok(ids.includes('blank'), 'an empty required date still is');
});

test('no start gate on an ordinary form', async () => {
  await page.setContent('<input type="text" id="a"><label for="a">Name</label>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.startGate()), null);
});

test("MICROSOFT'S EIGHTFOLD SIGN-IN PAGE IS A WALL, header Apply link and all (F-363)", async () => {
  // As measured live 2026-09-06: a skip link, a header with an Apply link, an
  // employee notice, then "Select a method below to Sign in" and the SSO row
  // more than 400 characters in. No password field, no application controls.
  await page.setContent(`
    <a href="#main">Skip to main content</a>
    <header><span>Microsoft Careers</span><a href="/careers/apply?pid=1970393556981984">Apply</a><button>Sign in</button></header>
    <main id="main"><h1>Sign in</h1>
      <p>If you are a Microsoft Employee, Sign in here. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}</p>
      <p>Select a method below to Sign in. This allows you to access your profile or begin a new application. If you don’t already have an account, you can create one during the Sign in process.</p>
      <p>Sign in using</p><button>Google</button><button>Microsoft</button><button>LinkedIn</button>
    </main>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true, 'a page headed "Sign in" with the SSO row far down is still a wall');
});

test('a sign-in wall is told apart from a broken form', async () => {
  await page.setContent('<button data-automation-id="utilityButtonSignIn">Sign In</button>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true);

  // Signed in, with a form on screen: the same Sign In markup may linger in a
  // header, and calling that a wall would abandon a working application.
  await page.setContent(`
    <button data-automation-id="utilityButtonSignIn">Sign In</button>
    <div data-automation-id="formField-legalName--firstName"><label>First Name</label><input></div>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false);
});

test('A PASSWORD FIELD MAKES IT A WALL, whatever else is on the page', async () => {
  // Workday's Create Account page carries four formField-* wrappers, so a check
  // that asked "does this page have form fields?" concluded it was not a wall —
  // and the filler would have typed his email into an account signup.
  await page.setContent(`
    <button data-automation-id="utilityButtonSignIn">Sign In</button>
    <div data-automation-id="formField-email"><label>Email</label><input type="text"></div>
    <div data-automation-id="formField-password"><label>Password</label><input type="password"></div>
    <div data-automation-id="formField-verifyPassword"><label>Verify New Password</label><input type="password"></div>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true,
    'signing in and creating accounts are his, always');
});

test('react-select sentinel inputs are not questions', async () => {
  // Greenhouse's newer forms render a hidden aria-hidden input per dropdown to
  // carry HTML5 required-validation. They were 15 of 54 unanswered questions in
  // a sweep of six live forms and not one was a question.
  const fields = await discoverIn(`
    <div class="select-shell">
      <label for="real">Country</label>
      <input id="real" type="text">
      <input aria-hidden="true" class="requiredInput" tabindex="-1">
    </div>`);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, 'Country');
});

test('aria-hidden hides it even when it is otherwise perfectly visible', async () => {
  const fields = await discoverIn('<input type="text" id="x" aria-hidden="true" style="width:200px;height:30px"><label for="x">Ghost</label>');
  assert.deepEqual(fields, []);
});

test('EIGHTFOLD: an aria-hidden file input is still the resume', async () => {
  // Applied Materials — his single biggest employer — marks its resume input
  // BOTH aria-hidden and display:none. The aria-hidden exclusion added for
  // Greenhouse's react-select phantoms would have excluded it, silently
  // reintroducing the resume bug on the employer that matters most. File inputs
  // are exempt from every visibility test, and that check must come first.
  const fields = await discoverIn(`
    <button>Upload your resume</button>
    <input type="file" accept=".pdf,.doc,.docx,.txt" aria-hidden="true" style="display:none">`);
  const file = fields.find((f) => f.type === 'file');
  assert.ok(file, 'Eightfold hides its resume input behind aria-hidden AND display:none');
});

test('the order of the two rules is what makes both work', async () => {
  // Both together on one page: the upload must survive, the phantom must not.
  const fields = await discoverIn(`
    <input type="file" aria-hidden="true" style="display:none">
    <input type="text" aria-hidden="true" class="requiredInput">`);
  assert.deepEqual(fields.map((f) => f.type), ['file']);
});

test('iCIMS wording for Apply is recognised', async () => {
  // iCIMS renders the link as the visible label plus a screen-reader span,
  // concatenated: "Apply for this job onlineApply". No exact match catches it,
  // and iCIMS postings reported zero fields because of it.
  await page.setContent(`
    <h1>Manufacturing Engineer - Motors</h1>
    <p>Job description text.</p>
    <a href="/jobs/5302/login">Apply for this job online<span>Apply</span></a>`);
  await page.addScriptTag({ content: DISCOVER });
  const found = await page.evaluate(() => globalThis.__jarvis.applyControl()?.textContent.replace(/\s+/g, ' ').trim());
  assert.match(found, /Apply for this job online/);
});

test('F-1013 #22: a consent notice that says the application will be SENT gets no Confirm / OK / Accept & Apply', async () => {
  const gate = async (html) => { await page.setContent(html); await page.addScriptTag({ content: DISCOVER }); return page.evaluate(() => globalThis.__jarvis.startGate()?.textContent?.trim() ?? null); };
  assert.equal(await gate('<div role="dialog"><p>By confirming you agree to our privacy notice and your application will be sent to the hiring team.</p><button>Confirm</button></div>'), null);
  assert.equal(await gate('<div role="dialog"><p>Privacy notice. Clicking below will submit your application.</p><button>Accept & Apply</button></div>'), null);
  assert.equal(await gate('<div role="dialog"><p>Privacy Policy. We process your data under this notice.</p><button>Consent & Continue</button><button>Decline & Close</button></div>'), 'Consent & Continue', 'a plain privacy notice is still accepted (F-692)');
});

test('F-1013 #21: a localized last step\'s Submit in the Next slot is never pressed; Back beside Next is skipped', async () => {
  const next = async (html) => { await page.setContent(html); await page.addScriptTag({ content: DISCOVER }); return page.evaluate(() => globalThis.__jarvis.nextControl()?.textContent?.trim() ?? null); };
  for (const word of ['Soumettre', 'Envoyer ma candidature', 'Absenden', 'Enviar', 'Invia candidatura', 'Submit']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await next(`<button data-automation-id="pageFooterNextButton">${word}</button>`), null, `"${word}" sends the application`);
  }
  assert.equal(await next('<button data-automation-id="pageFooterNextButton">Retour</button><button data-automation-id="pageFooterNextButton">Suivant</button>'), 'Suivant');
  assert.equal(await next('<button data-automation-id="pageFooterNextButton">Next</button>'), 'Next', 'an English Next is still pressed');
});

test('F-1013 #16: "Apply with LinkedIn" and a quick-apply form\'s own Apply button are never followed', async () => {
  const found = async (html) => { await page.setContent(html); await page.addScriptTag({ content: DISCOVER }); return page.evaluate(() => globalThis.__jarvis.applyControl()?.textContent.replace(/\s+/g, ' ').trim() || null); };
  assert.equal(await found('<h1>Robotics Engineer</h1><p>Advert.</p><button type="button">Apply with LinkedIn</button><button type="button">Apply with Indeed</button>'), null,
    'applying through another site\'s profile is his to choose');
  assert.equal(await found('<h1>Robotics Engineer</h1><p>Advert.</p><button type="button">Apply with LinkedIn</button><a href="/jobs/1/apply">Apply</a>'), 'Apply',
    'the posting\'s own Apply is still found beside it');
  assert.equal(await found(`<h1>Robotics Engineer</h1><form><label for="e">Email</label><input id="e" type="email">
    <button type="button" onclick="window.__SENT = true">Apply</button></form>`), null, 'a type="button" Apply in the same form as the boxes is the send');
});

test('the loose match does not grab things that merely start with "apply"', async () => {
  await page.setContent(`
    <h1>Advert</h1>
    <a href="/other">Apply to other roles at this company</a>
    <a href="/all">Apply filters</a>
    <p>Apply by 30 June to be considered for the autumn intake, and note that late applications are not accepted under any circumstances.</p>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.applyControl()), null);
});

test('a page that already has a form is never treated as an advert', async () => {
  await page.setContent(`
    <input id="a"><label for="a">First Name</label>
    <input id="b"><label for="b">Last Name</label>
    <input id="c"><label for="c">Email</label>
    <a href="/apply">Apply</a>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.applyControl()), null,
    'following Apply here would abandon a form it should be filling');
});

test('an auth URL with a bare email gate is a wall, password or not', async () => {
  // Following iCIMS' Apply link lands on /login: one email field and a consent
  // box, no password. The password check called it an ordinary form, and it is
  // the door to starting an account at that employer — his call, not the tool's.
  await page.goto('https://example.com/jobs/5302/engineer/login');
  await page.setContent(`
    <label for="e">Email</label><input id="e" type="email">
    <label for="c">If you have applied before, enter your information</label><input id="c" type="checkbox">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true);
});

test('a real application that happens to sit under /login is still filled', async () => {
  await page.goto('https://example.com/careers/login');
  await page.setContent(`
    <label for="a">First Name</label><input id="a">
    <label for="b">Last Name</label><input id="b">
    <label for="c">Email</label><input id="c">
    <label for="d">Phone</label><input id="d">
    <label for="e">School</label><input id="e">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false,
    'five application fields is a form, not a gate');
});

test('an ordinary application URL is never called a wall', async () => {
  await page.goto('https://example.com/jobs/123/apply');
  await page.setContent('<label for="a">First Name</label><input id="a">');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false);
});

/**
 * A react-select combobox, reduced from the live Torc Robotics Greenhouse form.
 *
 * Twelve fields on that one page look exactly like this, including work
 * authorisation, sponsorship, and all four EEO questions. Every one was read as
 * a plain text box, typed into, and counted as filled while committing nothing.
 */
const COMBO = `
  <div class="select__control">
    <div class="select__value-container">
      <div class="select__input-container">
        <input id="wa" class="select__input" type="text" role="combobox"
               aria-autocomplete="list" aria-expanded="false" aria-haspopup="true"
               aria-labelledby="wa-label">
      </div>
    </div>
  </div>
  <label id="wa-label" for="wa">Are you legally authorized to work in the United States?</label>`;

test('A REACT-SELECT COMBOBOX IS NOT A TEXT BOX', async () => {
  // The whole fault: typing into one of these puts text on screen and commits
  // nothing, so the form carried no work-authorisation answer while the report
  // said it did.
  const fields = await discoverIn(COMBO);
  const wa = fields.find((f) => /legally authorized/.test(f.label));
  assert.ok(wa, 'the field must still be discovered');
  assert.equal(wa.type, 'prompt', 'typed into as text, it answers nothing');
});

test('a combobox reports the value it RENDERS, not the value in its input', async () => {
  // This is the measurement that would have defeated a read-back check:
  // react-select clears the input on commit, so `.value` is empty exactly when
  // the answer stuck and full exactly when it did not.
  await page.setContent(`
    <div class="select__control"><div class="select__value-container">
      <div class="select__single-value">United States</div>
      <div class="select__input-container">
        <input id="c" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" value="">
      </div>
    </div></div>
    <label for="c">Country</label>`);
  await page.addScriptTag({ content: DISCOVER });
  const seen = await page.evaluate(() => {
    const el = document.getElementById('c');
    return { inputValue: el.value, combo: globalThis.__jarvis.comboValue(el) };
  });
  assert.equal(seen.inputValue, '', 'a committed react-select holds nothing in its input');
  assert.equal(seen.combo, 'United States', 'the answer lives in the rendered node');

  const f = (await discoverIn(`
    <div class="select__control"><div class="select__value-container">
      <div class="select__single-value">United States</div>
      <div class="select__input-container">
        <input id="c" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false">
      </div>
    </div></div>
    <label for="c">Country</label>`)).find((x) => x.label === 'Country');
  assert.equal(f.type, 'prompt');
});

test('a combobox already answered is reported as already answered', async () => {
  // Otherwise the planner overwrites a correct value with the same value,
  // which on Workday means destroying an opaque id it had filled itself.
  await page.setContent(`
    <div class="select__control"><div class="select__value-container">
      <div class="select__single-value">Yes</div>
      <div class="select__input-container">
        <input id="c" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false">
      </div>
    </div></div>
    <label for="c">Are you legally authorized to work in the United States?</label>`);
  await page.addScriptTag({ content: DISCOVER });
  const cur = await page.evaluate(() => globalThis.__jarvis.discover()[0].current);
  assert.equal(cur, 'Yes');
});

test('a plain text input is NOT mistaken for a combobox', async () => {
  // The rule keys on role=combobox, not on class names or a nearby listbox, so
  // an ordinary First Name field must be unaffected.
  const fields = await discoverIn('<label for="a">First Name</label><input id="a" class="select__input">');
  assert.equal(fields[0].type, 'text', 'a class name is not a widget');
});

test('an autocomplete that DOES take free text is still driven by picking', async () => {
  // Greenhouse's Location field is a combobox that looks typeable. Picking from
  // the list is right there too — a typed city that is never committed is the
  // same silent blank as everywhere else.
  const fields = await discoverIn(`
    <label for="loc">Location (City)</label>
    <input id="loc" role="combobox" aria-autocomplete="list" aria-expanded="false">`);
  assert.equal(fields[0].type, 'prompt');
});

/**
 * A posting that has been taken down.
 *
 * Measured on a live Form Energy posting: Ashby's public board API reports it
 * `isListed: true` with a jobUrl that renders "Page not found" — checked in his
 * own Chrome as well as headless, so it is not bot detection. Clicking the
 * extension there said "0 filled", which reads as the tool being broken rather
 * than the job being gone.
 */
test('a taken-down posting is recognised as gone, not as an empty form', async () => {
  await page.setContent('<h1>Page not found</h1><p>The page you requested was not found</p>');
  await page.addScriptTag({ content: DISCOVER });
  const gone = await page.evaluate(() => globalThis.__jarvis.postingGone());
  assert.match(String(gone), /page not found/i);
});

test('a REAL form containing those words is never dismissed', async () => {
  // The guard that matters. A form is a form even if some helper text on it
  // says "not found" — losing an application to a phrase match would be far
  // worse than the confusion this fixes.
  await page.setContent(`
    <p>If your school is not found in the list, type it manually.</p>
    <label for="a">First Name</label><input id="a">
    <label for="b">Email</label><input id="b">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.postingGone()), null,
    'form controls present means this is a form, whatever the prose says');
});

test('an ordinary long page is not called gone', async () => {
  await page.setContent(`<div>${'This role is open and we are hiring. '.repeat(40)}</div>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.postingGone()), null);
});

test('the other ways a board words it are caught too', async () => {
  for (const phrase of [
    'This position has been filled',
    'We are no longer accepting applications',
    'This job is closed',
  ]) {
    await page.setContent(`<p>${phrase}</p>`);
    await page.addScriptTag({ content: DISCOVER });
    const gone = await page.evaluate(() => globalThis.__jarvis.postingGone());
    assert.ok(gone, `not recognised: ${phrase}`);
  }
});

/**
 * Lever's custom questions, reduced from the live Veeva form.
 *
 * No id, no aria-label, no <label for>. The question lives in an
 * `.application-label` a few levels up, the name is `cards[<uuid>][field3]`,
 * and the placeholder reads "Type your response".
 *
 * Stopping the label search at `el.closest('div')` found nothing, so the
 * fallback took the placeholder — and **"What are your salary expectations?"
 * was labelled "Type your response"**, which no answer table can ever match.
 * His profile answers that question.
 */
test('A LEVER QUESTION IS READ FROM ITS LABEL, NOT ITS PLACEHOLDER', async () => {
  const fields = await discoverIn(`
    <div class="application-question">
      <div class="application-label"><div class="text">What are your salary expectations?</div></div>
      <div class="application-field full-width">
        <input name="cards[0a56e2e4-d3b8-48fc-ab3b-405a888f7db9][field3]" placeholder="Type your response">
      </div>
    </div>`);
  assert.equal(fields[0].label, 'What are your salary expectations?');
});

test('a machine-generated name is not reported as the question', async () => {
  // "cards[77aef006-61d7-4863-a824-26058fa64bdf][field5]" in the unanswered
  // list is noise dressed as a label — it reads like a bug in the form.
  const fields = await discoverIn(
    '<div><input name="cards[77aef006-61d7-4863-a824-26058fa64bdf][field5]"></div>');
  assert.equal(fields[0].label, '', 'better no label than a machine id');
});

test('a MEANINGFUL placeholder is still used', async () => {
  // The guard only rejects instructions, not real hints.
  const fields = await discoverIn('<div><input placeholder="LinkedIn Profile URL"></div>');
  assert.equal(fields[0].label, 'LinkedIn Profile URL');
});

test('an ordinary name is still used when nothing better exists', async () => {
  const fields = await discoverIn('<div><input name="first_name"></div>');
  assert.equal(fields[0].label, 'first name');
});

test('generic placeholders are rejected in all their usual wordings', async () => {
  for (const ph of ['Type your response', 'Enter your answer', 'Select...', 'Please choose', 'Your answer']) {
    const fields = await discoverIn(`<div><input placeholder="${ph}"></div>`);
    assert.equal(fields[0].label, '', `"${ph}" is an instruction, not a question`);
  }
});

/**
 * A Workday JOB POSTING is not a sign-in wall.
 *
 * Workday puts a Sign In link in the header of every page, adverts included.
 * The wall check asked only whether that link existed and the page had no
 * `formField-*` wrappers — which is exactly what a Workday advert looks like —
 * so **every Workday posting reported itself as a sign-in wall** and the
 * extension refused to follow its own Apply button. Workday carries more
 * postings in his deck than any other ATS.
 *
 * Measured on a live Jabil posting: zero password inputs, zero form fields, a
 * header Sign In link, and an Apply button right there on the page.
 */
test('A WORKDAY POSTING WITH AN APPLY BUTTON IS NOT A WALL', async () => {
  await page.goto('https://example.com/Jabil_Careers/job/Hendersonville-NC/Automation-Engineer-I');
  await page.setContent(`
    <a data-automation-id="utilityButtonSignIn" href="/login">Sign In</a>
    <h2>Automation Engineer I</h2>
    <a href="/job/apply">Apply</a>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false,
    'the header Sign In link is site furniture, not a wall');
  assert.ok(await page.evaluate(() => !!globalThis.__jarvis.applyControl()),
    'and the Apply control must still be found so the run can follow it');
});

test("Workday's Create Account step IS a wall, by name", async () => {
  // Measured: "Apply Manually" while signed out lands on "step 1 of 7 —
  // Create Account/Sign In". Reading the step's own name does not depend on
  // whether Workday has rendered its fields yet.
  await page.goto('https://example.com/Jabil_Careers/job/x');
  await page.setContent('<div>Back to Job Posting Automation Engineer I current step 1 of 7 Create Account/Sign In step</div>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true);
});

test('a password field is still decisive, Apply button or not', async () => {
  // The guard on the change above: an account-creation form that also carries
  // an Apply link must not be filled just because the link is there.
  await page.goto('https://example.com/careers/x');
  await page.setContent(`
    <a href="/job/apply">Apply</a>
    <label for="e">Email</label><input id="e" type="email">
    <label for="p">Password</label><input id="p" type="password">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true);
});

/**
 * A site refusing us is not an empty form.
 *
 * The Playwright driver has recognised these for months. The extension knew
 * only about sign-in walls, so on an iCIMS "Let's confirm you are human" page
 * it reported "no form controls here" — which reads as the tool being broken
 * rather than the site asking him to prove he is a person.
 *
 * Neither is ever cleared automatically. Clicking through a bot check is
 * exactly what this engine must refuse; it names the check and stops.
 */
test('a human-verification check is named, not mistaken for an empty form', async () => {
  await page.setContent("<h1>Let's confirm you are human</h1><p>Complete the check below.</p>");
  await page.addScriptTag({ content: DISCOVER });
  const b = await page.evaluate(() => globalThis.__jarvis.pageBlocked());
  assert.equal(b.kind, 'human');
  assert.match(b.why, /clear it yourself/i, 'and it must say the clearing is his');
});

test('an Access Denied page is named too', async () => {
  await page.setContent('<h1>Access Denied</h1><p>You do not have permission to access this page.</p>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal((await page.evaluate(() => globalThis.__jarvis.pageBlocked())).kind, 'blocked');
});

test('an ordinary form is not called blocked', async () => {
  await page.setContent('<label for="a">First Name</label><input id="a">');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.pageBlocked()), null);
});

test('THE TWO COPIES OF THESE PATTERNS CANNOT DRIFT', async () => {
  // Drift between discover.js and _form.mjs is this project's most repeated
  // failure — the answer table, the label reader and the none-of-the-above rule
  // have each cost a bug that way. These two patterns are duplicated because a
  // content script has no module system, so the duplication is checked instead.
  //
  // Checked with plain string containment rather than a regex matching a regex.
  // The first attempt escaped its own pattern wrongly and failed on a file that
  // was correct — the same class of mistake as F-188, where a backslash meant
  // for a regex became a control character on the way through a shell. When an
  // escape has to survive that many layers, do not use one.
  const formSrc = readFileSync(path.join(HERE, '..', 'apply', '_form.mjs'), 'utf-8');
  for (const fragment of [
    'confirm you are human|security check|are not a bot|verify you are human',
    'access denied|don.?t have permission to access|unusual traffic',
    'request blocked|403 forbidden',
    // The site-furniture filter and the dead-posting pattern, duplicated for
    // the same reason and checked the same way.
    'savesearch|save-search|jobalert|job-alert|jobsearch|job-search|searchbox',
    'talentcommunity|talent-community|subscribe|newsletter|cookie',
    // A bare "autocomplete"/"typeahead" is a field's component, not chrome (F-337).
    '(^|[-_ ])(search|alert|alerts|chat)([-_ ]|$)',
    'search-?typeahead|typeahead-?search|search-?autocomplete|autocomplete-?search',
    'oops|gone too far|no longer (available|accepting|active|posted|open)',
    '(isn.?t|is not)',
  ]) {
    assert.ok(DISCOVER.includes(fragment), `discover.js is missing a blocker pattern: ${fragment}`);
    assert.ok(formSrc.includes(fragment), `_form.mjs no longer has it — they have drifted: ${fragment}`);
  }
});

/**
 * A job board's own search bar is not an application form.
 *
 * Measured on a live Amazon posting — three of which were in his queue: the
 * page carries 21 controls, and the only two the reader called application
 * fields were **Amazon's own job search bar**. Clicking the extension there
 * would have typed into a job search box. The Apply button was never found
 * either, because 21 controls tripped the "we are already on a form" guard.
 */
const AMAZON_SHAPED = `
  <nav>
    <input id="search_typeahead-navigation" name="base_query" placeholder="Search for jobs by title or keyword">
    <input id="location-typeahead-navigation" name="loc_query" placeholder="Location">
    <input name="latitude"><input name="longitude"><input name="loc_group_id">
  </nav>
  <h1>Robotics Systems Engineer I</h1>
  <a href="https://www.amazon.jobs/applicant/jobs/10418150/apply">Apply now</a>`;

test('A JOB SEARCH BAR IS NOT DISCOVERED AS APPLICATION FIELDS', async () => {
  const fields = await discoverIn(AMAZON_SHAPED);
  assert.deepEqual(fields.map((f) => f.label), [],
    'his details must never be typed into a job search box');
});

test('and the Apply button is found despite the search bar', async () => {
  await page.setContent(AMAZON_SHAPED);
  await page.addScriptTag({ content: DISCOVER });
  const t = await page.evaluate(() => globalThis.__jarvis.applyControl()?.textContent?.trim() || null);
  assert.equal(t, 'Apply now', 'counting site furniture as form controls hid it');
});

test('a REAL form is still discovered, search-shaped names and all', async () => {
  // The expensive direction. A react-select's own `select__search` input is a
  // genuine control on Greenhouse and Ashby, and skipping a real field looks
  // exactly like filling one in the report.
  const fields = await discoverIn(`
    <form>
      <label for="a">First Name</label><input id="a">
      <label for="b">Email</label><input id="b" class="select__search">
    </form>`);
  assert.deepEqual(fields.map((f) => f.label), ['First Name', 'Email']);
});

test("Amazon's dead-posting wording is recognised", async () => {
  // Two of the three Amazon jobs in his queue answered HTTP 404 with this.
  // Neither the extension nor the shared pattern matched it, so the deadest
  // page in his queue read as an ordinary empty one.
  await page.setContent(`
    <nav><input id="search_typeahead" placeholder="Search for jobs"></nav>
    <p>Sorry, the job you're looking for isn't available. There are other opportunities you might be interested in.</p>`);
  await page.addScriptTag({ content: DISCOVER });
  const gone = await page.evaluate(() => globalThis.__jarvis.postingGone());
  assert.match(String(gone), /isn.?t available/i,
    'site furniture must not stop a dead page being recognised');
});

/**
 * A checkbox whose label is already a sentence needs no question in front.
 *
 * Measured on a live Micron (Eightfold) form: a checkbox whose own `<label for>`
 * reads "Save my answers for future applications." was prefixed with a swallowed
 * page section and came back as
 *
 *   "Application questions Application questionsMy InformationCountry of
 *    ResidenceHave you previously been employed by any Micron Company?YesNo —
 *    Save my answers for future applications."
 *
 * The group-question hunt exists for radios labelled "Yes"/"No", which need the
 * question. Running it on a label that is already a full sentence can only make
 * it worse.
 */
test('A CHECKBOX WITH A REAL SENTENCE LABEL IS LEFT ALONE', async () => {
  const fields = await discoverIn(`
    <div>
      <h3>Application questions</h3>
      <p>Have you previously been employed by any Micron Company?</p>
      <label for="s">Save my answers for future applications.</label>
      <input id="s" type="checkbox">
    </div>`);
  const f = fields.find((x) => /save my answers/i.test(x.label));
  assert.equal(f.label, 'Save my answers for future applications.',
    'no page section may be glued to the front of it');
});

test('a Yes/No radio still gets its question', async () => {
  // The other direction, and the reason that hunt exists at all: twelve radio
  // groups on a live Applied Materials form went unanswered without it.
  // Each option in its own wrapper, which is how every real form nests them —
  // the question is a preceding SIBLING of the option's wrapper, not a
  // stray element inside the same box.
  const fields = await discoverIn(`
    <div>
      <p>Are you legally authorized to work in the United States?</p>
      <div><label for="y">Yes</label><input id="y" type="radio" name="auth"></div>
      <div><label for="n">No</label><input id="n" type="radio" name="auth"></div>
    </div>`);
  assert.match(fields[0].label, /legally authorized to work/i,
    'a bare "Yes" must still be given its question');
});

test('AMAZON: "Log in or create account" is a wall, not a one-field application', async () => {
  // F-233, measured live. Amazon's Apply button leads to passport.amazon.jobs —
  // pathname "/", so AUTH_PATH_RE never matched — with exactly one control on
  // it. signInWall() said false, discover() returned that control labelled
  // "Email", and the engine would have typed his address into a LOGIN form and
  // reported one field filled. Five of his saved Amazon postings audited that
  // way: a single answered "Email" and nothing else.
  await page.setContent(`
    <title>Log in or create account | Amazon.jobs</title>
    <h1>Log in or create account</h1>
    <label for="preLoginEmailField">Email*</label>
    <input id="preLoginEmailField" type="email" name="email" required>
    <button>Continue</button>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true,
    'a page that says it is a login-or-create-account page is a wall');
});

test('the same wording on a REAL application does not abandon it', async () => {
  // The guard that keeps the check above honest. A long application that
  // mentions signing in somewhere must still be filled — which is why the
  // wording test is bounded by control count, exactly like the path test.
  await page.setContent(`
    <title>Apply — Robotics Engineer</title>
    <p>Already have an account? Log in or create account to save your progress.</p>
    <label for="fn">First Name</label><input id="fn">
    <label for="ln">Last Name</label><input id="ln">
    <label for="em">Email</label><input id="em" type="email">
    <label for="ph">Phone</label><input id="ph">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false,
    'four fields is an application, whatever the prose says');
});

test('an auth HOST is a wall even with no telltale wording', () => {
  // The host half of the check, which is what actually catches redirects to a
  // central identity page that renders nothing useful before JS runs.
  // Driving a real foreign host is not possible here, so the regex itself is
  // pinned — it is the part that would silently stop matching.
  const re = /^(passport|login|signin|sign-in|auth|accounts?|identity)\./i;
  for (const h of ['passport.amazon.jobs', 'login.microsoftonline.com', 'accounts.google.com', 'auth.workday.com', 'identity.sap.com']) {
    assert.ok(re.test(h), `${h} must read as an auth host`);
  }
  for (const h of ['www.amazon.jobs', 'boards.greenhouse.io', 'jobs.ashbyhq.com', 'kla.wd1.myworkdayjobs.com']) {
    assert.ok(!re.test(h), `${h} is an ordinary job host and must not read as a wall`);
  }
});

test('A MIGRATED TENANT IS NOT A SIGN-IN WALL', async () => {
  // F-236, seen in his own Chrome. Six GlobalFoundries jobs sat in his
  // shortlist reported as "this ATS wants you signed in". The tenant had been
  // decommissioned: every advert says "We moved to Eightfold, use this link to
  // new job applications". signInWall()'s last rule is "a visible Sign In link
  // and no form fields" — exactly what a migrated tenant looks like — so the
  // engine told him to sign in somewhere that cannot accept an application.
  await page.setContent(`
    <a href="/signin" data-automation-id="utilityButtonSignIn">Sign In</a>
    <p>We moved to Eightfold, use this link to new job applications:
       <a href="https://globalfoundries.eightfold.ai/careers">careers</a></p>`);
  await page.addScriptTag({ content: DISCOVER });
  const moved = await page.evaluate(() => globalThis.__jarvis.atsMoved());
  assert.ok(moved, 'a page that says it moved must be reported as moved');
  assert.match(moved.why, /moved/i);
  assert.equal(moved.link, 'https://globalfoundries.eightfold.ai/careers',
    'and it must carry WHERE, which is the useful half');
});

test('a real application that mentions a move is never abandoned', async () => {
  // The guard. Like postingGone(), this requires an absence of controls.
  await page.setContent(`
    <p>Our careers site has moved to a new system. Apply below.</p>
    <label for="fn">First Name</label><input id="fn">
    <label for="em">Email</label><input id="em" type="email">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.atsMoved()), null,
    'a page with a form on it is a form, whatever the prose says');
});

test("Workday's own 404 wording reads as gone, not as a wall", async () => {
  // Headless gets this where his signed-in Chrome got the migration banner.
  // "The page you are looking for doesn't exist" was in neither pattern, so it
  // fell through to signInWall()'s Sign In heuristic and reported a wall.
  await page.setContent(`
    <a data-automation-id="utilityButtonSignIn">Sign In</a>
    <p>The page you are looking for doesn't exist.</p>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.ok(await page.evaluate(() => globalThis.__jarvis.postingGone()),
    'a Workday 404 must read as gone');
});

test('EIGHTFOLD: "Sign in using Google" is a wall, not a one-field application', async () => {
  // F-238. Eightfold's Apply Now goes to /careers/apply, which renders a single
  // email box with id `auth-entry-email-input` under a row of SSO buttons.
  // signInWall() said false, so the engine would have typed his address into a
  // sign-in box and reported one field filled — the F-233 shape again, on the
  // ATS behind GlobalFoundries, Micron, Microsoft, Lam Research and Qualcomm.
  await page.setContent(`
    <h1>Sign in</h1>
    <label for="auth-entry-email-input">Email</label>
    <input id="auth-entry-email-input" type="email">
    <button>Continue</button>
    <div>OR</div>
    <button>Sign in using Google</button>
    <button>Sign in using LinkedIn</button>
    <p>First time here? Create an account</p>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true);
});

test('an input merely NAMED like an author field is not a wall', async () => {
  // The `input[id*="auth"]` signal is deliberately narrow — it only counts on a
  // page with three controls or fewer. A real application must survive it.
  await page.setContent(`
    <label for="author-name">Author name</label><input id="author-name">
    <label for="fn">First Name</label><input id="fn">
    <label for="ln">Last Name</label><input id="ln">
    <label for="em">Email</label><input id="em" type="email">
    <label for="ph">Phone</label><input id="ph">`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false,
    'five fields is an application');
});

// ── Workday dropdowns with no native control (F-297) ──────────────────
//
// Measured on a live Jabil Application Questions step. Four required questions
// rendered as a `formField-` wrapper holding a label and a `<button>Select
// One</button>` and NOTHING ELSE. `discover()` enumerated `input, select,
// textarea`, so all four were invisible: not unanswered, absent. The panel
// reported "1 filled" and named one thing left for him while Save and Continue
// refused to move on four errors.
//
// The Playwright driver has never had this bug because it enumerates wrappers
// (apply/workday.mjs:484-485). These fixtures are that step reduced.

const JABIL_STEP = `
  <form>
    <div data-automation-id="formField-age18">
      <label>Jabil requires you to be at least 18 years of age to be eligible for employment. Please indicate if you are 18 years of age or older. *</label>
      <button id="b-age" aria-haspopup="listbox" aria-expanded="false">Select One</button>
    </div>
    <div data-automation-id="formField-workAuth">
      <label>Are you currently authorized to work for Jabil in the United States? *</label>
      <button id="b-auth" aria-haspopup="listbox" aria-expanded="false">Select One</button>
    </div>
    <div data-automation-id="formField-priorExp">
      <label>What is your experience working at Jabil? *</label>
      <button id="b-exp" aria-haspopup="listbox" aria-expanded="false">Select One</button>
    </div>
    <div data-automation-id="formField-sponsorship">
      <label>Do you now, or will you in the future, require visa sponsorship to work for Jabil in the United States (for example H-1B, TN, L-1, etc.)? *</label>
      <button id="b-spon" aria-haspopup="listbox" aria-expanded="false">Select One</button>
    </div>
    <div data-automation-id="formField-contingentId">
      <label for="cw">If you are currently a contingent worker, enter your Jabil Contingent Worker ID:</label>
      <input id="cw" type="text">
    </div>
    <div data-automation-id="formField-salary">
      <label for="sal">Gross salary expectations?</label>
      <input id="sal" type="text">
    </div>
    <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
  </form>`;

/** discover(), keeping the fields the summary mapper above throws away. */
async function promptsIn(html) {
  await page.setContent(html);
  await page.addScriptTag({ content: DISCOVER });
  return page.evaluate(() => globalThis.__jarvis.discover().map((f) => ({
    label: f.label,
    type: f.type,
    promptKind: f.promptKind,
    current: f.current,
    required: f.required,
    key: f.key,
    id: f.id,
    tag: f.elements[0] ? f.elements[0].tagName : null,
  })));
}

test('A WORKDAY DROPDOWN WHOSE ONLY CONTROL IS A BUTTON IS STILL A FIELD', async () => {
  const fields = await promptsIn(JABIL_STEP);
  assert.equal(fields.length, 6, 'four dropdowns plus two text boxes — not two');

  for (const [key, wording] of [
    ['formField-age18', /18 years of age/],
    ['formField-workAuth', /authorized to work for Jabil/],
    ['formField-priorExp', /experience working at Jabil/],
    ['formField-sponsorship', /require visa sponsorship/],
  ]) {
    const f = fields.find((x) => x.key === key);
    assert.ok(f, `${key} must be discovered at all — being absent is the bug`);
    assert.match(f.label, wording, 'the label must carry the QUESTION');
    assert.equal(f.type, 'prompt', 'a dropdown typed into as text answers nothing');
    assert.equal(f.promptKind, 'single');
    assert.equal(f.required, true, 'the asterisk is the only signal Workday gives');
    assert.equal(f.tag, 'BUTTON',
      'elements[0] must be the TRIGGER — content.js reads aria-controls off it');
  }
});

test('"Select One" IS A PLACEHOLDER, NOT AN ANSWER', async () => {
  // The silent half of F-297. apply-plan.mjs reads any non-empty `current` as
  // "already answered" and plans `skip`, and a skip is counted but never listed
  // — so an untouched required dropdown would still not reach the list of what
  // was left for him even after it became discoverable.
  const fields = await promptsIn(JABIL_STEP);
  for (const f of fields.filter((x) => x.type === 'prompt')) {
    assert.equal(f.current, '', `${f.key} must report nothing chosen, not the placeholder`);
  }
});

test('a prompt hidden behind a hidden input is discovered exactly ONCE', async () => {
  // visible() drops `type="hidden"` before promptOf() ever runs, which made
  // promptOf's own hidden case unreachable. The wrapper pass covers it — and
  // must not also produce a second copy of the same field.
  const fields = await promptsIn(`
    <div data-automation-id="formField-auth">
      <label>Are you currently authorized to work for Jabil in the United States?</label>
      <button aria-haspopup="listbox">Select One</button>
      <input type="hidden" value="bc33aa3152ec42d4995f4791a1">
    </div>`);
  assert.equal(fields.length, 1, 'one wrapper is one field');
  assert.equal(fields[0].type, 'prompt');
  assert.equal(fields[0].current, '');
});

test('a prompt that DOES have a visible input is still one field, and keeps its answer', async () => {
  // The Country/State shape. The native pass already emits it, so the wrapper
  // pass must skip it — and a real chosen value must survive the placeholder
  // strip untouched.
  const fields = await promptsIn(`
    <div data-automation-id="formField-country">
      <label for="ctry">Country</label>
      <button aria-haspopup="listbox">United States of America</button>
      <input id="ctry" type="text" value="bc33aa3152ec42d4995f4791a1">
    </div>`);
  assert.equal(fields.length, 1, 'discovered twice would plan the same field twice');
  assert.equal(fields[0].type, 'prompt');
  assert.equal(fields[0].current, 'United States of America');
});

test('A PROMPT TRIGGER IS NEVER THE CONTROL THAT SENDS THE APPLICATION', async () => {
  // The wrapper pass hands elements[0] to content.js, which CLICKS it. A bare
  // <button> inside a <form> has type="submit" by default, so the type cannot
  // be the test — what the button SAYS has to be. Here the nav control comes
  // first in DOM order, which is exactly how a first-button-wins fallback
  // would have clicked Save and Continue.
  const fields = await promptsIn(`
    <form>
      <div data-automation-id="formField-site">
        <label>Which site are you applying to? *</label>
        <button data-automation-id="pageFooterNextButton" type="submit">Save and Continue</button>
        <span data-automation-id="promptIcon"></span>
        <button id="real-trigger">Select One</button>
      </div>
    </form>`);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].id, 'real-trigger', 'the trigger, never the nav button');

  const submitty = await promptsIn(`
    <form>
      <div data-automation-id="formField-only">
        <label>Anything at all *</label>
        <span data-automation-id="promptIcon"></span>
        <button type="submit">Submit</button>
      </div>
    </form>`);
  assert.equal(submitty.length, 0,
    'a wrapper whose only button submits yields NO field rather than a clickable Submit');
});

test('THE PROMPT SHAPES CANNOT DRIFT FROM THE PLAYWRIGHT DRIVER', async () => {
  // discover.js recognised three widget markers and no fallback while
  // apply/workday.mjs recognised four and two, so promptIcon, selectinput and a
  // bare "Select One" button were read as ordinary TEXT here and driven as
  // prompts there. Nothing tied the two lists together, which is how they
  // drifted. Same string-containment method as the test above, for the same
  // reason.
  const wdSrc = readFileSync(path.join(HERE, '..', 'apply', 'workday.mjs'), 'utf-8');
  for (const fragment of [
    'data-automation-id="promptIcon"',
    'data-uxi-widget-type="selectinput"',
    'data-automation-id="multiSelectContainer"',
    'select one|select a value',
  ]) {
    assert.ok(DISCOVER.includes(fragment), `discover.js must know ${fragment}`);
    assert.ok(wdSrc.includes(fragment), `workday.mjs must know ${fragment}`);
  }
});

// ── reading the posting off the page ─────────────────────────────────

const ATSJS = readFileSync(path.join(HERE, 'ats.js'), 'utf-8');

/** Load discover.js — with the ATS table in front of it when asked — and read the posting. */
const readIn = async (html, { ats = false, url = null } = {}) => {
  if (url) {
    await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
  } else {
    await page.setContent(html);
  }
  if (ats) await page.addScriptTag({ content: ATSJS });
  await page.addScriptTag({ content: DISCOVER });
  const got = await page.evaluate(() => globalThis.__jarvis.readPosting());
  if (url) await page.unroute('**/*');
  return got;
};

test('A JSON-LD JobPosting is read whole: title, employer, description as text, location', async () => {
  const got = await readIn(`
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Careers' },
        { '@type': ['JobPosting'], title: 'Mechanical Engineer, New Grad',
          hiringOrganization: { '@type': 'Organization', name: 'Micron Technology' },
          description: '<div><p>About the role</p><ul><li>Design fixtures</li><li>Run DOEs</li></ul></div>',
          jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Boise', addressRegion: 'ID', addressCountry: 'US' } },
          url: 'https://micron.test/jobs/42' },
      ],
    })}</script>
    <h1>Mechanical Engineer, New Grad</h1><button>Apply</button>`);
  assert.equal(got.source, 'jsonld');
  assert.equal(got.title, 'Mechanical Engineer, New Grad');
  assert.equal(got.company, 'Micron Technology');
  assert.equal(got.url, 'https://micron.test/jobs/42');
  assert.equal(got.location, 'Boise, ID, US');
  assert.match(got.description, /^About the role\n\s*Design fixtures\n\s*Run DOEs$/, 'lists survive as lines');
  assert.ok(!/<[a-z]/i.test(got.description), 'and no HTML reaches the tailor');
});

test('a hiringOrganization given as a plain string still names the employer', async () => {
  const got = await readIn(`
    <script type="application/ld+json">{"@type":"JobPosting","title":"ME","hiringOrganization":"Jabil","description":"x"}</script>
    <button>Apply</button>`);
  assert.equal(got.company, 'Jabil');
});

test('TWO JobPostings ON ONE PAGE IS NO POSTING — a careers list is not a job', async () => {
  // Taking the first would tailor his resume to whichever job the page put
  // first. Ambiguity is answered with nothing; the server then has nothing
  // to record, which is correct.
  const got = await readIn(`
    <script type="application/ld+json">{"@type":"JobPosting","title":"ME I","description":"x"}</script>
    <script type="application/ld+json">{"@type":"JobPosting","title":"ME II","description":"y"}</script>
    <h1>Open roles</h1><a href="/jobs/1">Apply</a>`);
  assert.equal(got, null, '"Open roles" is not a job either, so the page-shape fallback has nothing to say');
});

test('JSON-LD THAT DESCRIBES A DIFFERENT JOB THAN THE PAGE IS REFUSED', async () => {
  // A tenant that leaves a previous job's markup in a shared template would
  // otherwise rename every application after it. Compared by requisition id,
  // the one thing two URLs for the same posting reliably share.
  const stale = await readIn(`
    <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Old Job', description: 'x',
      url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/Old-Job_R111111' })}</script>
    <h2 data-automation-id="jobPostingHeader">New Job</h2><a data-automation-id="adventureButton" role="button">Apply</a>`,
  { ats: true, url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/New-Job_R222222' });
  assert.ok(!stale || stale.source !== 'jsonld', `the stale JSON-LD must not win: ${JSON.stringify(stale)}`);

  const same = await readIn(`
    <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'New Job', description: 'x',
      url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/New-Job_R222222' })}</script>
    <a data-automation-id="adventureButton" role="button">Apply</a>`,
  { ats: true, url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/New-Job_R222222/apply' });
  assert.equal(same?.title, 'New Job', 'the same requisition on its apply page is fine');
});

test('WITHOUT JSON-LD, THE PAGE IS READ ONLY WHEN IT IS SHAPED LIKE A POSTING', async () => {
  // A posting: an Apply control, no application fields. Workday's own ids.
  const posting = await readIn(`
    <h2 data-automation-id="jobPostingHeader">Manufacturing Engineer</h2>
    <div data-automation-id="jobPostingDescription"><p>Own the assembly line.</p><p>${'Requirements. '.repeat(20)}</p></div>
    <a data-automation-id="adventureButton">Apply</a>`);
  assert.equal(posting.source, 'dom');
  assert.equal(posting.title, 'Manufacturing Engineer');
  assert.match(posting.description, /Own the assembly line/);

  // A form step: an <h1> that is a STEP heading. Recording "My Information" as
  // a job title under a real employer would put junk in his store.
  const step = await readIn(`
    <h1>My Information</h1>
    <label for="a">First Name</label><input id="a">
    <label for="b">Last Name</label><input id="b">
    <label for="c">Email</label><input id="c">
    <button data-automation-id="pageFooterNextButton">Save and Continue</button>`);
  assert.equal(step, null);

  // A careers landing page: an Apply link, an <h1> that names no job.
  const landing = await readIn('<h1>Careers</h1><p>Join us.</p><a href="/jobs">Apply</a>');
  assert.equal(landing, null, '"Careers" is not a job title');
});

test('the longest description block wins over a one-line teaser', async () => {
  const got = await readIn(`
    <h1>Test Engineer</h1>
    <div class="job-description-teaser">Join us.</div>
    <main><p>${'The real body. '.repeat(30)}</p></main>
    <button>Apply Now</button>`);
  assert.match(got.description, /The real body/);
});

test('F-1012: THE SITE\'S HEADER IS NEVER THE JOB TITLE (Tesla: logo, "Careers" and the skip link in the first <h1>)', async () => {
  const body = `<main id="main"><h1>Manufacturing Engineer, Process &amp; Equipment Development</h1>
    <div class="job-description"><p>${'Own prototype processes into high-volume production. '.repeat(12)}</p></div>
    <a href="/careers/search/job/apply/271234">Apply</a></main>`;
  // Tesla's shape: the header <h1> holds the logo link and the skip link.
  const tesla = await readIn(`<header class="tds-site-header"><h1><a href="/">Tesla homepage</a><a href="/careers">Careers</a><a href="#main">Skip to main content</a></h1></header>${body}`);
  assert.equal(tesla?.title, 'Manufacturing Engineer, Process & Equipment Development');
  // The same header with no <header> around it: its words alone rule it out.
  const bare = await readIn(`<h1><a href="/">Tesla homepage</a><a href="/careers">Careers</a><a href="#main">Skip to main content</a></h1>${body}`);
  assert.equal(bare?.title, 'Manufacturing Engineer, Process & Equipment Development');
  // A posting's own <header> inside <main> is the posting, and is kept.
  const own = await readIn(`<main><header class="job-header"><h1>Process Engineer</h1></header>
    <div class="job-description"><p>${'Run the line. '.repeat(30)}</p></div><button>Apply</button></main>`);
  assert.equal(own?.title, 'Process Engineer');
  // Nothing but furniture: no posting, rather than a junk one.
  const none = await readIn('<h1>Skip to main content</h1><div class="job-description"><p>x</p></div><button>Apply</button>');
  assert.equal(none, null);
});

test('F-1013 #2: "IF YOU HAVE ALREADY APPLIED…" IS BOILERPLATE, NOT HIS STATUS', async () => {
  const said = async (html) => { await page.setContent(html); await page.addScriptTag({ content: DISCOVER }); return page.evaluate(() => globalThis.__jarvis.alreadyApplied()); };
  assert.equal(await said('<h1>Process Engineer</h1><p>If you have already applied for this position, please do not reapply.</p><button>Apply</button>'), null);
  assert.equal(await said('<p>Candidates who have already applied to this role will be contacted.</p><button>Apply</button>'), null);
  assert.equal(await said('<p>Please note: whether or not you\'ve already applied, sign in to continue.</p>'), null);
  assert.match(String(await said('<h1>Process Engineer</h1><p>You have already applied for this position.</p><a>View application</a>')), /already applied/i, 'his own status still counts');
  // A conditional sentence first does not hide a real statement after it.
  assert.match(String(await said('<p>If you have already applied, do not reapply.</p><p>You have already applied for this job.</p>')), /already applied/i);
});

test('WORKDAY MY EXPERIENCE SECTIONS ARE READ BY HEADING, AND ENTRY FIELDS STAY OUT OF THE FIELD LIST', async () => {
  await page.setContent(`
    <h2>My Experience</h2>
    <div><h3>Work Experience</h3>
      <div data-automation-id="formField-jobTitle"><label>Job Title</label><input value=""></div>
      <button data-automation-id="Add">Add</button></div>
    <div><h3>Education</h3>
      <div data-automation-id="formField-schoolName"><label>School or University</label><input value="Test University"></div>
      <div data-automation-id="formField-fieldOfStudy"><label>Field of Study</label><input value="Mechanical Engineering"></div>
      <button data-automation-id="Add">Add Another</button></div>
    <div><h3>Websites</h3><button data-automation-id="Add">Add</button></div>
    <label for="p">Phone</label><input id="p">`);
  await page.addScriptTag({ content: DISCOVER });
  const sections = await page.evaluate(() => globalThis.__jarvis.experienceSections());
  // Websites is a section too since F-553 (2026-09-24): his portfolio goes there.
  assert.deepEqual(sections.map((s) => s.kind), ['work', 'education', 'website']);
  assert.equal(sections.find((s) => s.kind === 'website').filled, false, 'an empty Websites section is not his yet');
  const work = sections.find((s) => s.kind === 'work');
  assert.equal(work.count, 1); assert.equal(work.filled, false); assert.equal(work.blank, true, 'Workday pre-created one blank panel');
  const edu = sections.find((s) => s.kind === 'education');
  assert.equal(edu.filled, true, 'an entry with a value is already his');
  const fields = await page.evaluate(() => globalThis.__jarvis.discover().map((f) => f.label));
  assert.deepEqual(fields, ['Phone'], 'Job Title, School and Field of Study belong to their entries, not the generic list');
});

test('F-889: Oracle sections are read by their Add\'s number and report their saved tiles, the Add hidden or not (TI)', async () => {
  await page.setContent(`
    <div class="apply-flow-block"><h3>Education</h3><div class="profile-item-container">
      <div class="profile-item-list"><article data-qa="profileItem106">Mechanical Engineering</article><article data-qa="profileItem106">Unnamed Major</article></div>
      <div class="profile-add-item" style="display:none"><button type="button" data-qa="add106">Add Education</button></div>
      <div class="profile-item-footer"><button class="save-btn" data-qa="profileItemInlineSaveButton">Add Education</button></div></div></div>
    <div class="apply-flow-block"><h3>Experience</h3><div class="profile-item-container">
      <div class="profile-item-list"></div>
      <div class="profile-add-item"><button type="button" data-qa="add129">Add Experience</button></div></div></div>
    <label for="p">Phone</label><input id="p">`);
  await page.addScriptTag({ content: DISCOVER });
  const sections = await page.evaluate(() => globalThis.__jarvis.experienceSections());
  const edu = sections.find((s) => s.kind === 'education');
  const work = sections.find((s) => s.kind === 'work');
  assert.equal(edu.saved, 2, JSON.stringify(sections));
  assert.equal(edu.filled, false, 'the planner still sends his entries; content.js skips the ones a tile shows');
  assert.equal(work.saved, 0);
  assert.equal(sections.filter((s) => s.kind === 'education').length, 1, 'the inline save is not read as a second section');
});

test('"THANK YOU FOR APPLYING" IS RECOGNISED, AND ONLY WITHOUT A FORM', async () => {
  const doneIn = async (html, ats = false) => {
    await page.setContent(html);
    if (ats) await page.addScriptTag({ content: ATSJS });
    await page.addScriptTag({ content: DISCOVER });
    return page.evaluate(() => globalThis.__jarvis.applicationDone());
  };
  assert.match(await doneIn('<h1>Thank you for applying!</h1><p>We will be in touch.</p>'), /thank you for applying/i);
  assert.match(await doneIn('<p>Your application has been submitted.</p>'), /application has been submitted/i);
  // Phrases the ATS table carries, from Simplify's 54-ATS list.
  assert.match(await doneIn('<h2>We got your application</h2>', true), /got your application/i);
  assert.match(await doneIn('<h2>Application Complete</h2><p>See all Job Openings</p>', true), /application complete/i);
  assert.equal(await doneIn('<p>Thank you for applying — one more step:</p><label for="a">Phone</label><input id="a">'), null,
    'a form that thanks him mid-way is still a form');
  assert.equal(await doneIn('<h1>My Information</h1><label for="a">First Name</label><input id="a">'), null);
  // THE TWO PAGES THAT MUST NEVER READ AS SENT. Workday's Review step: no
  // inputs, "make sure your application is complete", a Submit button. A
  // posting: "thank you for your interest", an Apply button. Either read as
  // "sent" would stand the tab down and show a tick for an application that
  // was never sent.
  assert.equal(await doneIn('<h2>Review</h2><p>Please make sure your application is complete and accurate.</p><button data-automation-id="pageFooterNextButton">Submit</button>', true), null,
    'a Review step with a Submit button is not a sent application');
  assert.equal(await doneIn('<h1>Test Engineer</h1><p>Thank you for your interest in Acme! Your application has been received by our team in the past? Apply below.</p><a href="/apply">Apply</a>', true), null,
    'a posting with an Apply control is not a sent application, whatever it says');
  // A CANDIDATE DASHBOARD LISTS APPLICATIONS; it confirms none (Werfen's
  // iCIMS /jobs/dashboard, 2026-09-24: "this application is done").
  assert.equal(await doneIn('<h1>Welcome back</h1><h2>Jobs you have applied to</h2><p>None yet.</p>', true), null,
    '"jobs you have applied to" is a list heading');
  assert.match(await doneIn('<h1>You have applied to this job</h1>', true), /you have applied/i);
  await page.goto('about:blank');
  await page.evaluate(() => history.replaceState?.(null, '', location.href));
  await page.route('https://careers-acme.icims.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h2>Status</h2><p>Mechanical Engineer — Application Submitted</p>' }));
  await page.goto('https://careers-acme.icims.com/jobs/dashboard');
  await page.addScriptTag({ content: ATSJS });
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.applicationDone()), null, 'a dashboard\'s status column is not this application\'s confirmation');
  await page.unroute('https://careers-acme.icims.com/**');
});

// R3 (2026-11-07): his Warren CAT application on UKG was logged "sent" from a
// confirmation-shaped URL; he had not sent it (his answer, relayed 12:06).
test('R3: UKG — its own Submit button keeps a page unsent, and its URL needs the page to agree', async () => {
  const at = async (url, body) => {
    await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body }));
    await page.goto(url);
    await page.addScriptTag({ content: ATSJS });
    await page.addScriptTag({ content: DISCOVER });
    const r = await page.evaluate(() => globalThis.__jarvis.applicationDone());
    await page.unroute(url);
    return r;
  };
  const ukg = 'https://recruiting2.ultipro.com/WAR1007/JobBoard/c797a398/OpportunityApply/Confirmation';
  // A step with UKG's custom-element Submit: never sent, whatever the URL says.
  assert.equal(await at(ukg, '<h2>Review and submit</h2><ukg-button data-automation="btn-submit" style="display:inline-block;width:120px;height:30px">Submit</ukg-button>'), null,
    'a <ukg-button> Submit on screen means not sent');
  // …drawn by its text alone (display: contents, no box of its own): still on screen (review).
  assert.equal(await at(ukg, '<h2>Review and submit</h2><ukg-button data-automation="btn-submit" style="display:contents">Submit</ukg-button>'), null,
    'a display:contents <ukg-button> Submit means not sent');
  // The URL alone: not proof on UKG — and the miss is recorded as the path and why, no page text.
  assert.equal(await at(ukg, '<h2>Review</h2><p>Check your details, Warren.</p>'), null, 'a UKG confirmation-shaped URL without the page saying so');
  const miss = await page.evaluate(() => globalThis.__jarvisDoneMiss);
  assert.equal(miss?.path, '/WAR1007/JobBoard/c797a398/OpportunityApply/Confirmation');
  assert.match(miss?.why || '', /^ukg: confirmation-shaped URL/);
  assert.doesNotMatch(JSON.stringify(miss), /Warren|Check your details/, 'no page text in the record');
  // The URL and the page agree: sent.
  assert.match(await at(ukg, '<h1>Thank you for applying!</h1><p>We will review your application.</p>') || '', /confirmation page .*thank you for applying/i);
  // …with UKG's own buttons still in the markup but hidden: sent (review).
  assert.match(await at(ukg, '<h1>Thank you for applying!</h1><ukg-button data-automation="btn-submit" style="display:none">Submit</ukg-button><ukg-button data-automation="btn-next" hidden>Next</ukg-button>') || '', /confirmation page .*thank you for applying/i,
    'hidden UKG buttons on the real confirmation do not block it');
  // Another platform keeps the URL rule as it was.
  assert.match(await at('https://boards.greenhouse.io/acme/jobs/123/confirmation', '<div>Done.</div>') || '', /^confirmation page/,
    'Greenhouse\'s /confirmation URL is still enough');
  // PLATFORMS THAT DID NOT OPT IN: a visible button[type=submit] (a header search) never blocks their confirmation (review).
  assert.match(await at('https://boards.greenhouse.io/acme/jobs/123/confirmation', '<form><button type="submit">Search jobs</button></form><h1>Thank you for applying</h1>') || '', /^confirmation page/,
    'Greenhouse confirmation with a search button');
  assert.match(await at('https://careers-acme.icims.com/jobs/123/thank-you', '<form><button type="submit">Search</button></form><h1>Thank you for applying!</h1>') || '', /^confirmation page/,
    'iCIMS confirmation with its header search (selector button[type="submit"]) still counts');
});

test('A VERIFICATION-CODE PAGE IS A WALL', async () => {
  const wallIn = async (html) => {
    await page.setContent(html);
    await page.addScriptTag({ content: DISCOVER });
    return page.evaluate(() => globalThis.__jarvis.signInWall());
  };
  assert.equal(await wallIn('<label for="c">Verification code</label><input id="c"><button>Continue</button>'), true);
  assert.equal(await wallIn('<label for="c">Code</label><input id="c" autocomplete="one-time-code"><button>Verify</button>'), true);
  assert.equal(await wallIn('<label for="c">Enter the code we sent to your phone</label><input id="c" name="otp">'), true);
  // A postal code is not a verification code.
  assert.equal(await wallIn('<label for="a">Email</label><input id="a"><label for="z">Postal Code</label><input id="z"><label for="p">Phone</label><input id="p">'), false);
});

test('THE ATS TABLE NAMES APPLY, NEXT AND SUBMIT WHERE THE TEXT CANNOT', async () => {
  const load = async (html, url) => {
    await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.addScriptTag({ content: ATSJS });
    await page.addScriptTag({ content: DISCOVER });
    await page.unroute('**/*');
  };
  // Workday's Apply is named by its automation id, whatever it reads.
  await load('<h2>Job</h2><a data-automation-id="adventureButton" role="button">Candidatar-se</a>',
    'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/Job_R1');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.applyControl()?.getAttribute('data-automation-id')), 'adventureButton');

  // Lever's Submit is #btn-submit; SmartRecruiters' Next is a web component
  // whose text lives in a shadow root. Neither reads like anything.
  await load('<form><input id="a"><input id="b"><input id="c"><button id="btn-submit" type="button">Send it in</button></form>',
    'https://jobs.lever.co/acme/1b2c3d4e-1111-2222-3333-444455556666/apply');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.nextControl()), null, 'the ATS says #btn-submit sends the application — never clicked');

  await load('<form><input id="a"><oc-button data-test="footer-next"><span>weiter</span></oc-button><oc-button data-test="footer-submit"><span>senden</span></oc-button></form>',
    'https://jobs.smartrecruiters.com/Acme/743999999999999-engineer');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.nextControl()?.getAttribute('data-test')), 'footer-next');
});

test('A QUICK-APPLY BUTTON THAT SUBMITS IS NEVER "FOLLOWED"', async () => {
  // A two-field form whose only button is "Apply" IS the send button.
  // Following it would send an application with his email and nothing else.
  await page.setContent(`
    <form><label for="e">Email</label><input id="e"><button type="submit">Apply</button></form>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.applyControl()), null);
});

/**
 * SmartRecruiters' apply form, as measured live on Becton Dickinson
 * (2026-09-04): every field is a web component whose input, label and
 * required mark live in a shadow root; the host carries the label as an
 * attribute; the phone number's input is a component INSIDE a component and
 * its label sits two hosts up; Next is a button two shadow roots down; and
 * Simplify's sidebar is a shadow root on the same page with a search box in
 * it that is nobody's question.
 */
const SHADOW_FORM = `
  <h2>Personal information</h2>
  <x-input id="fn" label="First name"></x-input>
  <x-input id="ln" label="Last name"></x-input>
  <x-input id="em" label="Email" type="email"></x-input>
  <x-input id="ci" label="City"></x-input>
  <x-phone id="ph" label="Phone number"></x-phone>
  <x-nav></x-nav>
  <div class="simplify-jobs-shadow-root" id="foreign"></div>
  <script>
    customElements.define('x-input', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<label for="i">' + (this.getAttribute('label') || '') + '<span aria-hidden="true">*</span></label><input id="i" type="' + (this.getAttribute('type') || 'text') + '">';
        r.querySelector('input').addEventListener('input', (e) => { this.setAttribute('value', e.target.value); });
      }
    });
    customElements.define('x-phone', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<label for="p">Phone number</label><div><x-select></x-select><x-input id="p" type="tel"></x-input></div>';
      }
    });
    customElements.define('x-select', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<button type="submit">+1</button>'; }
    });
    customElements.define('x-nav', class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<footer style="position:fixed;bottom:0;left:0"><x-button><button type="button">Next</button></x-button></footer>';
        r.querySelector('button').addEventListener('click', () => { window.__next = (window.__next || 0) + 1; });
      }
    });
    customElements.define('x-button', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'; }
    });
    document.getElementById('foreign').attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="Search jobs"><button>Autofill</button>';
  <\/script>`;

test('A FORM BUILT FROM WEB COMPONENTS IS READ THROUGH ITS SHADOW ROOTS (F-327)', async () => {
  const fields = await discoverIn(SHADOW_FORM);
  assert.deepEqual(fields.map((f) => f.label), ['First name', 'Last name', 'Email', 'City', 'Phone number'],
    'every field is found, in page order, labelled from its own shadow root or its host — and nothing from Simplify\'s root');
  assert.deepEqual(fields.map((f) => f.type), ['text', 'text', 'email', 'text', 'tel']);
  const more = await page.evaluate(() => {
    const j = globalThis.__jarvis;
    const next = j.nextControl();
    next.click();
    return {
      looks: j.looksLikeApplication(),
      nextTag: next.tagName, nextText: next.textContent.trim(), clicked: window.__next || 0,
      controls: j.allControls().length,
      wall: j.signInWall(),
    };
  });
  assert.equal(more.looks, true, 'five shadow fields are an application');
  assert.equal(more.nextTag, 'BUTTON', 'Next resolves to the real button, not the component host');
  assert.equal(more.clicked, 1, 'and clicking it reaches the component\'s listener');
  assert.equal(more.controls, 5, 'the foreign root\'s search box is not a control of this page');
  assert.equal(more.wall, false, 'a country-code button of type=submit is not a sign-in wall');
});

test('A BOT WALL WITH NO WORDS IS STILL A BOT WALL — DataDome is named, never clicked', async () => {
  // The exact shape SmartRecruiters served (2026-09-04): a 403 whose body is
  // one iframe to the challenge and no text at all.
  await page.setContent('<html><head><title>smartrecruiters.com</title></head><body style="margin:0"><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x" sandbox="allow-scripts allow-same-origin allow-forms" title="DataDome CAPTCHA" width="100%" height="100%"></iframe></body></html>');
  await page.addScriptTag({ content: DISCOVER });
  const got = await page.evaluate(() => globalThis.__jarvis.pageBlocked());
  assert.equal(got?.kind, 'human');
  assert.match(got.why, /human-verification check/);
  // Cloudflare's interstitial by title, when the body has not painted words.
  await page.setContent('<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div></body></html>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal((await page.evaluate(() => globalThis.__jarvis.pageBlocked()))?.kind, 'human');
  // Eightfold's hidden reCAPTCHA helper on a page WITH the form (Lam, F-339).
  await page.setContent('<html><head><title>Manufacturing Engineer 2 — Lam Research</title></head><body>'
    + '<h1>Application for</h1><label for="f">Legal First Name</label><input id="f"><label for="l">Legal Last Name</label><input id="l"><input type="file" id="r">'
    + '<div style="visibility:hidden;position:absolute;width:0;height:0"><iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en" title="recaptcha challenge expires in two minutes"></iframe></div>'
    + '</body></html>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.pageBlocked()), null, 'a hidden captcha helper beside a real form is not a wall');
  // A real page whose title merely mentions verification is not a wall.
  await page.setContent('<html><head><title>Verify you are human resources certified</title></head><body>' + 'Lorem ipsum dolor sit amet. '.repeat(30) + '<form><input><input><input><input></form></body></html>');
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.pageBlocked()), null);
});

test('A FILE SLOT IS NAMED BY THE "Resume *" LINE OF ITS SECTION, not the posting\'s h1 (F-332)', async () => {
  const fields = await discoverIn(`
    <h1>Advanced Manufacturing Engineer I</h1>
    <section id="easy"><h2>Easy Apply</h2><p>Choose an option to autocomplete your application.</p>
      <label for="f1">Choose a file or drop it here</label><input id="f1" type="file"></section>
    <section id="res"><div class="lbl">Resume *</div>
      <label for="f2">Choose a file or drop it here</label><input id="f2" type="file"></section>`);
  const files = fields.filter((f) => f.type === 'file').map((f) => f.label);
  assert.equal(files.length, 2);
  assert.doesNotMatch(files[0], /resume/i, 'the autocomplete-from-a-resume slot is not the resume slot');
  assert.match(files[1], /^Resume — /, 'the upload under "Resume *" is');
});

test('A CONSENT BOX WHOSE WORDS ARRIVE THROUGH A SLOT IS LABELLED BY THEM (F-333)', async () => {
  // The measured shape: the input sits INSIDE a <label> that holds only the
  // required mark, and the words are slotted in beside it.
  const fields = await discoverIn(`
    <h2>Preliminary questions</h2>
    <x-check id="consent"><x-label slot="label-content">You declare that you have read and understand the privacy notice of Acme.</x-label></x-check>
    <script>
      customElements.define('x-label', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'; }
      });
      customElements.define('x-check', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML = '<div><label for="c"><span aria-hidden="true">*</span><input id="c" type="checkbox"></label><slot name="label-content"></slot></div>';
        }
      });
    <\/script>`);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].type, 'checkbox');
  assert.match(fields[0].label, /read and understand the privacy notice/);
});

test('A QUESTION WRITTEN ABOVE A BARE BOX NAMES IT; A RANDOM NAME NEVER DOES (F-569)', async () => {
  // Rippling's custom short answer, measured on Cintal 2026-09-24: no label, no
  // placeholder, a fresh random name per load. It was reported as "o8tr6xgz5N".
  const fields = await discoverIn(`
    <form>
      <div><div><div><p>What is your salary expectation?<div></div></p></div></div>
        <div data-testid="field"><div><div><input id="field-62" aria-required="true" maxlength="50" name="WgaoKnKViAz"></div></div></div>
        <div><p>0/50</p></div></div>
      <div><input id="field-70" name="VzmmSOYuL9i"></div>
      <div><input id="field-71" name="firstName"></div>
    </form>`);
  assert.equal(fields[0].label, 'What is your salary expectation?');
  assert.equal(fields[1].label, '', 'a random token is not a question');
  assert.equal(fields[2].label, 'firstName', 'a real camelCase name still reads');
});

test('TSMC: closed section headers are opened, dropdowns and menus are not (F-577)', async () => {
  // SuccessFactors, measured 2026-09-24: every section of the application is a
  // <button aria-expanded="false"> inside an <h2>, and its fields are hidden
  // until it is opened.
  await page.setContent(`
    <nav><h3><button aria-expanded="false" id="menu" onclick="window.__menu=1">Options</button></h3></nav>
    <div class="rcmFormSection"><h2><button class="rcmFormSectionTopBar" aria-expanded="false" id="s1"
      onclick="this.setAttribute('aria-expanded','true');document.getElementById('b1').style.display='block'">Profile Information</button></h2>
      <div id="b1" style="display:none"><label for="f">First Name</label><input id="f"></div></div>
    <div><h2><button aria-expanded="false" aria-haspopup="listbox" id="dd" onclick="window.__dd=1">Country</button></h2></div>
    <label for="c">Degree</label><input id="c" role="combobox" aria-expanded="false">`);
  await page.addScriptTag({ content: DISCOVER });
  const opened = await page.evaluate(() => globalThis.__jarvis.expandSections());
  assert.equal(opened, 1, 'only the section header');
  assert.equal(await page.evaluate(() => [window.__menu, window.__dd]).then((x) => x.filter(Boolean).length), 0, 'no menu, no dropdown');
  const labels = await page.evaluate(() => globalThis.__jarvis.discover().map((f) => f.label));
  assert.ok(labels.includes('First Name'), 'the opened section\'s field is read');
});

test('WAYMO: a Job Alerts form is not the application, and a hex code is not part of a label (F-575)', async () => {
  // Measured 2026-09-24: a second <form> under "Job Alerts" (opening with an
  // empty <legend>) was read as the application, and every label ended in a
  // <span>0830c081</span> code.
  const fields = await discoverIn(`
    <div><div><h3>Job Alerts</h3><p>Sign up to receive tailored job alerts delivered straight to your inbox!</p></div>
      <div><form id="new_form_submission_1_3"><fieldset><legend></legend></fieldset>
        <label for="a1"><span>First Name <small>(required)</small></span> <span>80aff57e</span></label><input id="a1" required>
      </form></div></div>
    <h2>Apply for this job</h2>
    <form id="new_form_submission_7_0">
      <label for="b1"><span>First Name <small>(required)</small></span> <span>27277ec8</span></label><input id="b1" required>
      <label for="b2"><span>Website</span> <span>ddde699c</span></label><input id="b2">
    </form>`);
  assert.deepEqual(fields.map((f) => f.label), ['First Name (required)', 'Website']);
});

test('A TIMED-OUT SESSION IS NOT A DEAD POSTING (F-579)', async () => {
  // SmartRecruiters, Western Digital, 2026-09-24: read as "this posting is gone".
  await page.setContent(`<main><p>Due to inactivity, the form has been closed to protect your data. Click on the button below to start your application process again.</p><button>Start again</button></main>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.postingGone()), null);
  assert.equal(await page.evaluate(() => globalThis.__jarvis.pageBlocked()?.kind), 'session');
  await page.setContent(`<main><h1>Sorry, this position has been closed.</h1></main>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.ok(await page.evaluate(() => globalThis.__jarvis.postingGone()), 'a really closed posting is still gone');
});

test('AN APPLICATION ALREADY IN PROGRESS is said as one, and never hides a form (F-574)', async () => {
  await page.setContent(`<main><h1>Hardware Engineer</h1><h2>You already have an application in progress</h2>
    <p>It looks like you have already started an application for this role using this email address.</p>
    <button>Send me a link to my application</button></main>`);
  await page.addScriptTag({ content: DISCOVER });
  const walled = await page.evaluate(() => globalThis.__jarvis.pageBlocked());
  assert.equal(walled?.kind, 'in-progress');
  await page.setContent(`<main><p>You already have an application in progress.</p><label>First name <input name="first"></label></main>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.pageBlocked()), null, 'a page with a form is a form');
});

test('DOVER: plain <div> lines name the boxes, and the autofill parser is not the resume slot (F-570)', async () => {
  // Measured on app.dover.com, 2026-09-24: no <label> anywhere, so every box
  // was reported by its internal name, and both bare file inputs were named
  // "Resume/CV" before the parser check could run — the resume went to the
  // "Autofill from resume" parser.
  const fields = await discoverIn(`
    <form novalidate>
      <div><div role="button" tabindex="0"><input accept=".pdf" type="file" style="display:none"><div><div><div>Autofill from resume</div><div>Drag &amp; drop or upload to autofill your application.</div></div></div><button type="button">Upload file</button></div></div>
      <div><div><div>First Name *</div><div><div><input id=":r7:" name="firstName" required type="text"></div></div></div></div>
      <div><div>Phone Number </div><div><div><input id=":rb:" name="phoneNumber" type="text"></div></div></div>
      <div><div>Resume (optional)</div><div><div role="button" tabindex="0"><input accept=".pdf" type="file" style="display:none"><div><div>Drag and drop file or <div>browse computer</div></div><div>(PDF, 5 MB maximum)</div></div></div></div></div>
    </form>`);
  const byType = (t) => fields.filter((f) => f.type === t).map((f) => f.label);
  assert.deepEqual(byType('text'), ['First Name', 'Phone Number']);
  const files = byType('file');
  assert.match(files[0], /^Autofill from resume — /, 'the parser is named as one');
  assert.match(files[1], /^Resume \(optional\) — /, 'the real slot is named as the resume');
});

test('A CHAT WIDGET\'S CLASS ON <body> DOES NOT MAKE THE PAGE FURNITURE (F-567)', async () => {
  // Measured 2026-09-24 on Western Digital (SmartRecruiters): the chat widget
  // sets body.has-winston-chat-mobile-apply, the consent box sits outside the
  // form, and "chat" as a token made it site furniture — never ticked, never
  // reported. A real search widget on the same page is still furniture.
  const fields = await discoverIn(`
    <body class="has-winston-chat-mobile-apply"><main>
      <h2>Preliminary questions</h2>
      <label><input type="checkbox" id="c"> You declare that you have read and agree to the privacy notice of Acme.</label>
      <div id="savesearch"><input type="text" aria-label="Search jobs"></div>
    </main></body>`);
  assert.deepEqual(fields.map((f) => f.type), ['checkbox']);
  assert.match(fields[0].label, /privacy notice of Acme/);
});

test('ARIA RADIOS WITH NO INPUT BEHIND THEM ARE QUESTIONS (F-334)', async () => {
  const fields = await discoverIn(`
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
  const radios = fields.filter((f) => f.type === 'radio');
  assert.deepEqual(radios.map((f) => f.label), [
    'Are you legally authorized to work in the United States?',
    'Do you now or in the future require sponsorship to work in the United States?',
  ], 'the question comes from the group\'s slotted label, never from an option');
  assert.deepEqual(radios.map((f) => f.options), [['Yes', 'No'], ['Yes', 'No']]);
  const boxes = fields.filter((f) => f.type === 'checkbox');
  assert.equal(boxes.length, 1, 'a role=checkbox wrapper around a real checkbox is that checkbox, counted once');
  assert.match(boxes[0].label, /privacy notice/);
});

test('A QUESTION THAT REACHES ITS LABEL THROUGH TWO SLOTS IS STILL READ (F-333)', async () => {
  const fields = await discoverIn(`
    <x-auto><span slot="label-content">How did you find out about this opportunity?</span></x-auto>
    <script>
      customElements.define('x-inner', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML = '<label for="i"><slot name="label-content"></slot><span aria-hidden="true">*</span></label><input id="i" type="text">';
        }
      });
      customElements.define('x-auto', class extends HTMLElement {
        connectedCallback() {
          this.attachShadow({ mode: 'open' }).innerHTML = '<div><div><div><x-inner><slot name="label-content" slot="label-content"></slot></x-inner></div></div></div>';
        }
      });
    <\/script>`);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, 'How did you find out about this opportunity?');
});

test('AN AUTOCOMPLETE FIELD IS A FIELD; A JOB-SEARCH TYPEAHEAD IS FURNITURE (F-337)', async () => {
  const fields = await discoverIn(`
    <div class="job-search-typeahead"><label for="s">Search jobs</label><input id="s" type="text"></div>
    <x-form id="question-form-1">
      <div class="c-spl-autocomplete-dropdown"><div class="c-spl-autocomplete-status"></div>
        <label for="city">City</label><input id="city" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false">
      </div>
    </x-form>
    <div class="location-autocomplete"><label for="loc">Location</label><input id="loc" type="text"></div>
    <script>customElements.define('x-form', class extends HTMLElement {});<\/script>`);
  assert.deepEqual(fields.map((f) => f.label), ['City', 'Location'],
    'the search typeahead is furniture; the autocomplete components are questions, inside a custom form or not');
});

test('EVERY REQUISITION TOKEN IS A LITERAL PIECE OF ITS OWN URL (F-402)', async () => {
  // The dashboard finds "the stored posting with this requisition" by asking
  // SQLite for the rows whose URL CONTAINS the token, instead of parsing all
  // 196,491 URLs in his store — 235 ms against 1.2 s, and that difference is
  // most of the wait he sees when the panel is working out what page he is on.
  //
  // That shortcut is only allowed because every extractor here lifts the id
  // out of the URL rather than deriving one. It holds for all 180,068 stored
  // URLs that carry a requisition; this holds it to the extractors, so a new
  // ATS added later cannot quietly turn a real match into "not a posting".
  const URLS = [
    'https://boards.greenhouse.io/pathrobotics/jobs/4567890',
    'https://job-boards.greenhouse.io/embed/job_app?for=agilityrobotics&token=5986750004',
    'https://www.agilityrobotics.com/about/job-post?gh_jid=5986750004',
    'https://jobs.lever.co/zoox/1B2C3D4E-1111-2222-3333-444455556666',
    'https://jobs.ashbyhq.com/1x/1932c050-c00f-434a-85a4-3076ec613ac4',
    'https://hp.wd5.myworkdayjobs.com/ExternalCareerSite/job/Corvallis/Process-and-Tooling-Engineer_3159888-1',
    'https://careers.micron.com/careers/job/687238472915?domain=micron.com',
    'https://careers.eaton.com/careers/apply?pid=687238472915',
    'https://jobs.smartrecruiters.com/BectonDickinson2/743999797968244-advanced-manufacturing-engineer-i',
    'https://jobs.smartrecruiters.com/oneclick-ui/company/BectonDickinson2/publication/90f93468-9911-48fc-a661-286cfc7442e6',
    'https://careers.amd.com/careers-home/jobs/88060',
    'https://www.amazon.jobs/en/jobs/10516443/robotics-systems-engineer-i',
    'https://jobs.apple.com/en-us/details/200612345/mechanical-engineer',
    'https://apply.workable.com/acme/j/AB12CD34EF/',
    'https://jobs.jobvite.com/acme/job/oXYZbfwm',
  ];
  const rows = await page.evaluate((urls) => urls.map((u) => [u, globalThis.__jarvisAts.reqToken(u)]), URLS);
  const named = rows.filter(([, t]) => t);
  assert.ok(named.length >= 12, `these URLs name postings: ${JSON.stringify(rows)}`);
  for (const [url, token] of named) {
    const raw = String(token).replace(/^[a-z0-9-]+:/i, '');
    assert.ok(raw.length >= 4, `${token} is too short to look up by`);
    assert.ok(
      url.toLowerCase().includes(raw.toLowerCase()),
      `${token} is not a piece of ${url} — the dashboard's requisition lookup would miss it`,
    );
  }
});

test('A WORKDAY REQUISITION LIKE "26-798" IS A REQUISITION, on the posting and its form alike (Wolfspeed, F-715)', async () => {
  const t = await page.evaluate((urls) => urls.map((u) => globalThis.__jarvisAts.reqToken(u)), [
    'https://cree.wd108.myworkdayjobs.com/EXT/job/Durham-North-Carolina/Manufacturing-Engineer_26-798',
    'https://cree.wd108.myworkdayjobs.com/en-US/EXT/job/Durham%2C-North-Carolina/Manufacturing-Engineer_26-798/apply/autofillWithResume',
    'https://x.wd5.myworkdayjobs.com/site/job/A/Engineer_12',
  ]);
  assert.equal(t[0], 'workday:Manufacturing-Engineer_26-798');
  assert.equal(t[1], t[0], 'the form is the same posting');
  assert.equal(t[2], null, 'two digits alone are still not a requisition');
});

test('ORACLE ON THE EMPLOYER\'S OWN DOMAIN carries its requisition too (Texas Instruments, F-793)', async () => {
  const t = await page.evaluate((urls) => urls.map((u) => globalThis.__jarvisAts.reqToken(u)), [
    'https://careers.ti.com/en/sites/CX/job/25017157/apply/section/1',
    'https://careers.ti.com/en/sites/CX_1/job/25017157',
    'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/25017157',
    'https://www.example.org/sites/default/files/job/12',
  ]);
  assert.equal(t[0], 'oracle:25017157', 'the form names the requisition');
  assert.equal(t[1], t[0], 'the stored posting, on another site name, is the same one');
  assert.equal(t[2], t[0], 'and the oraclecloud host still reads the same way');
  assert.equal(t[3], null, 'a site path with a short number is not an Oracle posting');
});

test('SMARTRECRUITERS NAMES ONE JOB TWO WAYS, and the two never read as two jobs (F-338)', async () => {
  const t = await page.evaluate((urls) => urls.map((u) => globalThis.__jarvisAts.reqToken(u)), [
    'https://jobs.smartrecruiters.com/BectonDickinson2/743999797968244-advanced-manufacturing-engineer-i',
    'https://jobs.smartrecruiters.com/oneclick-ui/company/BectonDickinson2/publication/90f93468-9911-48fc-a661-286cfc7442e6?dcr_ci=BectonDickinson2',
    'https://jobs.smartrecruiters.com/oneclick-ui/company/BectonDickinson2/publication/90f93468-9911-48fc-a661-286cfc7442e6/screening?dcr_ci=BectonDickinson2',
  ]);
  assert.equal(t[0], 'smartrecruiters:743999797968244');
  assert.equal(t[1], 'smartrecruiters-publication:90f93468-9911-48fc-a661-286cfc7442e6');
  assert.equal(t[2], t[1], 'the screening step is the same publication');
  assert.notEqual(t[0].split(':')[0], t[1].split(':')[0], 'different kinds — the worker never compares them');
});

test('A SIGN-IN WALL IS STILL A WALL WITH A COOKIE WIDGET\'S HIDDEN BOXES ON THE PAGE (F-342)', async () => {
  // AMD's iCIMS login: two real controls, and OneTrust's six hidden consent
  // checkboxes — which used to push the count past the wall's bound.
  await page.setContent(`
    <div id="onetrust-pc-sdk" style="display:none">
      <input type="checkbox" id="ot-group-id-C0002"><input type="checkbox" id="ot-group-id-C0003"><input type="checkbox" id="ot-group-id-C0004">
      <input type="text" id="vendor-search-handler"><input type="checkbox" id="chkbox-id"><input type="checkbox" id="select-all-hosts-groups-handler">
    </div>
    <h1>Enter Your Information</h1>
    <label for="e">Email</label><input id="e" type="email">
    <label><input type="checkbox" id="acc"> I accept</label>
    <button type="submit">Next</button>`);
  await page.evaluate(() => history.replaceState(null, '', '/jobs/88060/login?in_iframe=1'));
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true);
});

test('A "WE HAVE MOVED" BANNER OVER AN ATS FRAME IS NOT A MOVE (F-342)', async () => {
  const load = async (html, url) => {
    await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.addScriptTag({ content: ATSJS });
    await page.addScriptTag({ content: DISCOVER });
    await page.unroute('**/*');
  };
  await load(`
    <div class="banner">Our Careers Site has Moved: Learn how talent, purpose, and progress combine to create careers that change the world at our new Careers home. <a href="https://www.amd.com/en/corporate/careers.html">new Careers home</a></div>
    <iframe src="https://careers-amd.icims.com/jobs/88060/login?in_iframe=1" width="100%" height="500"></iframe>`,
    'https://careers-amd.icims.com/jobs/88060/login?mobile=false');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.atsMoved()), null, 'the application is in the frame below the banner');
  await load(`<p>We have moved to Eightfold, use this link to new job applications: <a href="https://gf.eightfold.ai/careers">here</a></p>`,
    'https://globalfoundries.wd1.myworkdayjobs.com/en-US/External/job/x');
  assert.ok(await page.evaluate(() => globalThis.__jarvis.atsMoved()), 'a page with no frame and a moved notice still is one');
  // F-732: GlobalFoundries' live Workday form between two steps — no controls
  // drawn yet, loose wording, a footer LinkedIn link — is not a moved tenant.
  await load(`<p>We are now reviewing your answers.</p><a href="https://www.linkedin.com/company/globalfoundries">LinkedIn</a>`,
    'https://globalfoundries.wd1.myworkdayjobs.com/en-US/External/job/x/apply?utm_source=jackandjill');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.atsMoved()), null, 'mid-application, only the migration notice itself counts');
  await load(`<p>We have moved to Eightfold. <a href="https://www.linkedin.com/company/gf">LinkedIn</a></p>`,
    'https://globalfoundries.wd1.myworkdayjobs.com/en-US/External/job/x');
  const moved = await page.evaluate(() => globalThis.__jarvis.atsMoved());
  assert.ok(moved, 'the notice itself still counts');
  assert.equal(moved.link, null, 'a footer social link is not where he applies');
});

test('A STYLED CHECKBOX WITH ITS NATIVE INPUT HIDDEN IS STILL A BOX TO TICK (F-345)', async () => {
  const fields = await discoverIn(`
    <label for="e">Email Address</label><input id="e" type="email">
    <label class="input-row" for="c"><input type="checkbox" id="c" style="position:absolute;width:0;height:0;opacity:0"> <span>I agree with the terms and conditions</span></label>
    <label for="gone" style="display:none"><input type="checkbox" id="gone" style="opacity:0"> Really hidden</label>`);
  assert.deepEqual(fields.map((f) => `${f.type}:${f.label}`), ['email:Email Address', 'checkbox:I agree with the terms and conditions'],
    'the drawn label makes the box real; a box whose label is not drawn is still hidden');
});

test('ORACLE\'S EMAIL STEP IS NAMED AS ONE, not as a form whose Next submits (F-345)', async () => {
  await page.setContent(`
    <form><h2>Job application form</h2><p>Authentication screen. You don't need to have an account. Get started right away by simply using your email.</p>
    <label for="e">Email Address</label><input id="e" type="email">
    <button type="button">Cancel</button><button type="submit">Next</button></form>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.match(await page.evaluate(() => globalThis.__jarvis.advanceBlockedBy()), /asks for your email first — press "Next", type the code it emails you/);
  await page.setContent('<form><label for="a">Name</label><input id="a"><button type="submit">Next</button></form>');
  await page.addScriptTag({ content: DISCOVER });
  assert.match(await page.evaluate(() => globalThis.__jarvis.advanceBlockedBy()), /the only way on is "Next", which submits the form/);
});

test('A CHECKBOX GROUP IS NAMED BY ITS QUESTION, EVEN A SHORT ONE, AND BY ITS NAME AS A LAST RESORT (F-346)', async () => {
  const fields = await discoverIn(`
    <div><ul><li><label><input type="checkbox" name="eeo-veteran-status" value="Yes"><span>Yes</span></label></li>
      <li><label><input type="checkbox" name="eeo-veteran-status" value="No"><span>No</span></label></li></ul></div>
    <div class="application-question">
      <label>Pronouns</label>
      <ul><li><label><input type="checkbox" name="pronouns" value="He/him"><span>He/him</span></label></li>
      <li><label><input type="checkbox" name="pronouns" value="She/her"><span>She/her</span></label></li>
      <li><label><input type="checkbox" name="pronouns" value="They/them"><span>They/them</span></label></li></ul>
    </div>`);
  assert.deepEqual(fields.map((f) => f.label), ['Eeo veteran status — Yes', 'Pronouns — He/him']);
  assert.deepEqual(fields[1].options, ['He/him', 'She/her', 'They/them']);
});

test('TWO INSTANCES OF ONE COMPONENT NEVER SHARE A FIELD ID (F-352)', async () => {
  // SmartRecruiters' shape: two identical dropzones, only the second under a
  // "Resume *" line; the plan's answers are matched back by id.
  const fields = await discoverIn(`
    <h1>Advanced Manufacturing Engineer I</h1>
    <section><div class="t">Easy Apply</div><p>Choose an option to autocomplete your application.</p><x-form-field><x-drop data-test="apply-with-resume-container"></x-drop></x-form-field></section>
    <section><div class="t">Resume *</div><x-form-field><x-drop data-test="resume-upload"></x-drop></x-form-field></section>
    <section><x-form-field><x-drop></x-drop></x-form-field><x-form-field><x-drop></x-drop></x-form-field></section>
    <script>
      customElements.define('x-form-field', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'; } });
      customElements.define('x-drop', class extends HTMLElement {
        connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<label for="file-input">Choose a file or drop it here</label><input type="file" id="file-input">'; }
      });
    <\/script>`);
  assert.equal(fields.filter((f) => f.type === 'file').length, 4);
  // `discoverIn` keeps labels and types only; the ids are read straight off the page.
  const files = await page.evaluate(() => globalThis.__jarvis.discover().filter((f) => f.type === 'file').map((f) => ({ id: f.id, label: f.label, type: f.type, name: f.name, key: f.key })));
  assert.equal(new Set(files.map((f) => f.id)).size, 4, `ids are unique: ${JSON.stringify(files.map((f) => f.id))}`);
  assert.deepEqual(files.map((f) => f.id), ['x-drop#0/file-input', 'x-drop#1/file-input', 'x-drop#2/file-input', 'x-drop#3/file-input'],
    'the instance is its position among the page\'s x-drop elements — a number, never a test id the planner could read as "resume"');
  assert.match(files[1].label, /^Resume — /);
  assert.match(files[0].label, /^Easy Apply — /, 'the parse-to-autofill slot is named as one');
  const { isResumeField } = await import('../apply/_form.mjs');
  assert.equal(isResumeField(files[0]), false, 'and the planner refuses it');
  assert.equal(isResumeField(files[1]), true);
});

test('the requisition ids that tell one job from another', async () => {
  await page.setContent('<p></p>');
  await page.addScriptTag({ content: ATSJS });
  const tokens = await page.evaluate(() => [
    'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/job/FL/Manufacturing-Engineer_R123456/apply/applyManually',
    'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/job/FL/Manufacturing-Engineer_R123456',
    'https://boards.greenhouse.io/acme/jobs/4012345?gh_src=x',
    'https://www.acme.com/careers/?gh_jid=4012345',
    'https://jobs.lever.co/acme/1b2c3d4e-1111-2222-3333-444455556666/apply',
    'https://micron.eightfold.ai/careers/job/563123?pid=563123&domain=micron.com',
    'https://bostonscientific.eightfold.ai/careers/job/563602813469132-manufacturing-engineer-i?domain=bostonscientific.com',
    'https://careers-acme.icims.com/jobs/12345/mechanical-engineer/job',
    'https://acme.taleo.net/careersection/2/jobdetail.ftl?job=12345',
    'https://accounts.google.com/o/oauth2/auth',
    'https://careers.acme.com/some/page',
    'https://careers.lamresearch.com/careers/job/1099555830739-mechanical-engineer-2-us-or-tualatin-1034-?domain=lamresearch.com',
    'https://careers.lamresearch.com/careers/apply?pid=1099555830739&domain=lamresearch.com',
    'https://careers.appliedmaterials.com/careers/job/790315027772',
  ].map((u) => [globalThis.__jarvisAts.reqToken(u), globalThis.__jarvisAts.isIdp(u)]));
  assert.equal(tokens[0][0], tokens[1][0], 'a posting and its apply page are the same job');
  assert.equal(tokens[2][0], tokens[3][0], 'a Greenhouse board and the company site embedding it are the same job');
  assert.match(tokens[4][0], /^lever:/);
  assert.match(tokens[5][0], /^eightfold:563123$/);
  assert.match(tokens[6][0], /^eightfold:563602813469132$/, 'the newer Eightfold URL carries the id in the path');
  assert.match(tokens[7][0], /^icims:12345$/);
  assert.match(tokens[8][0], /^taleo:12345$/);
  assert.equal(tokens[9][1], true, 'Google sign-in is an identity provider');
  assert.equal(tokens[10][0], null, 'and a URL with no id says nothing');
  // Eightfold on the tenant's own host: the posting and its apply page are one job.
  assert.equal(tokens[11][0], 'eightfold:1099555830739', 'Lam serves Eightfold from careers.lamresearch.com');
  assert.equal(tokens[12][0], tokens[11][0], 'and its apply page names the same requisition');
  assert.equal(tokens[13][0], 'eightfold:790315027772', 'Applied Materials, without a ?domain=');
});

test('F-384: a job-search panel is site furniture, not an application', async () => {
  // SuccessFactors' career site (Zimmer Biomet, measured 2026-09-06) numbers
  // its ids — "36:", "40:", "41:" — and carries no telling class, so the id and
  // class rules saw nothing and its SEARCH BOX came back as an application:
  // "Keywords", "Keyword search options — Exact Match", "in job title",
  // "Requisition ID" were all reported as things left for HIM to answer.
  const fields = await discoverIn(`
    <form>
      <label for="a">Keywords</label><input id="36:" name="keyword">
      <fieldset><legend>Keyword search options</legend>
        <label><input type="checkbox" id="40:"> Exact Match</label>
        <label><input type="radio" id="39:_item_0" name="kwopt"> in job title</label>
      </fieldset>
      <label for="41:">Requisition ID</label><input id="41:" name="reqnumber">
    </form>`);
  assert.deepEqual(fields.map((f) => f.label), [],
    `a search panel is furniture; got ${fields.map((f) => f.label).join(' | ')}`);
});

test('…and an application that happens to ask something similar is untouched', async () => {
  // The guard has to be narrow enough that a real question survives it. These
  // are questions his forms actually ask.
  const fields = await discoverIn(`
    <form>
      <label for="k">What key skills would you bring to this role?</label><input id="k" name="key_skills">
      <label for="w">Keyword Research Experience</label><input id="w" name="experience_keyword_research">
      <label for="r">Requisition ID you are applying to, if known</label><input id="r" name="req">
      <label for="e">Email</label><input id="e" name="email" type="email">
    </form>`);
  assert.equal(fields.length, 4, `every real question survives; got ${fields.map((f) => f.label).join(' | ')}`);
});

test('F-388: a bot trap is never a field', async () => {
  // Workday's Create Account page (HP's tenant, measured live 2026-09-07)
  // carries <input name="website" data-automation-id="beecatcher"> labelled
  // "Enter website. This input is for robots only, do not enter if you're
  // human." It was discovered, planned, and reported to him as the one thing
  // left for him to fill — on the field whose whole purpose is that only a bot
  // touches it. Filling one is what gets an application binned.
  const fields = await discoverIn(`
    <form>
      <label for="w">Enter website. This input is for robots only, do not enter if you're human.</label>
      <input id="w" name="website" data-automation-id="beecatcher">
      <label for="hp">Leave this field blank</label><input id="hp" name="hp_check">
      <label for="e">Email Address</label><input id="e" name="email" type="email">
    </form>`);
  assert.deepEqual(fields.map((f) => f.label), ['Email Address'],
    `only the real question survives; got ${fields.map((f) => f.label).join(' | ')}`);
});

test('F-389: a cookie banner in hashed-class divs is still answered — Accept, his rule since 2026-10-03', async () => {
  // Workday's own banner (HP's tenant, screenshotted 2026-09-07) sits in divs
  // whose classes are build hashes, is positioned `static`, and is not a
  // dialog — so the region pass found nothing to look at and the banner stayed
  // up through the whole run, over the form. Its decline control names itself.
  await page.setContent(`
    <div class="css-1k55zyc"><div class="css-w89go0">
      <span>We use cookies (or similar technologies) to personalize content and ads. By clicking "Accept", you agree.</span>
      <div class="css-shnk6d"><div class="css-b3pn3b">
        <button class="css-1c158vi" data-automation-id="legalNoticeDeclineButton" onclick="window.__declined=1">Decline</button>
      </div><div class="css-b3pn3b">
        <button class="css-1c158vi" data-automation-id="legalNoticeAcceptButton" onclick="window.__accepted=1">Accept Cookies</button>
      </div></div>
    </div></div>
    <form><label>Email<input type="email" name="email"></label></form>`);
  await page.addScriptTag({ content: DISCOVER });
  const r = await page.evaluate(() => ({ label: globalThis.__jarvis.dismissCookieBanner(), declined: !!window.__declined, accepted: !!window.__accepted }));
  assert.equal(r.accepted, true, '"press consent on everything" (2026-10-03)');
  assert.equal(r.declined, false, 'and not the decline beside it');
  assert.match(r.label || '', /accept/i);
});

test('EMPTY ARIA ANCHORS NAMED BY A LABEL BESIDE THEM (TSMC SuccessFactors, 2026-09-24)', async () => {
  const fields = await discoverIn(`
  <style>a[role=radio]{display:inline-block;width:12px;height:12px;border:1px solid}</style>
  <div class="row"><span class="q">What year will you graduate?</span></div>
  <div class="row"><span class="opts">
    <a id="486:_anchor" role="radio" aria-checked="false" href="#"></a><label for="486:_anchor">2025</label>
    <a id="487:_anchor" role="radio" aria-checked="false" href="#"></a><label for="487:_anchor">2026</label>
    <a id="488:_anchor" role="radio" aria-checked="false" href="#"></a><label for="488:_anchor">2027</label>
  </span></div>
  <div class="row"><span class="q">Are you willing to work in a cleanroom?</span></div>
  <div class="row"><span class="opts">
    <a id="493:_anchor" role="radio" aria-checked="false" aria-labelledby="493:_l" href="#"></a><span id="493:_l">Yes</span>
    <a id="494:_anchor" role="radio" aria-checked="false" aria-labelledby="494:_l" href="#"></a><span id="494:_l">No</span>
  </span></div>`);
  const radios = fields.filter((f) => f.type === 'radio');
  assert.deepEqual(radios.map((f) => f.options), [['2025', '2026', '2027'], ['Yes', 'No']]);
  assert.deepEqual(radios.map((f) => f.label), ['What year will you graduate?', 'Are you willing to work in a cleanroom?'],
    'the question is the text above the group, never its first option');
});

test('HIDDEN NATIVE INPUTS BEHIND STYLED BOXES, AND DIV COMBOBOXES (Rippling, 2026-09-24)', async () => {
  const fields = await discoverIn(`
  <style>.hid{display:none}.box{display:inline-block;padding:4px;border:1px solid}</style>
  <div class="q"><p>Are you open to relocate within the US?</p>
    <div class="opts">
      <div class="box"><div><input class="hid" type="checkbox" name="cq.reloc" value="y"></div>Yes</div>
      <div class="box"><div><input class="hid" type="checkbox" name="cq.reloc" value="n"></div>No</div>
    </div>
  </div>
  <label id="g-label">Gender</label>
  <div id="g" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-labelledby="g-label" tabindex="0"><p>Select...</p></div>
  <p>Which shift can you work?</p>
  <div><div id="s" role="combobox" aria-expanded="false" aria-label="Select" tabindex="0"><p>Select</p></div></div>`);
  const reloc = fields.find((f) => /relocate/.test(f.label));
  assert.ok(reloc, 'the styled Yes/No question is read');
  assert.deepEqual(reloc.options, ['Yes', 'No']);
  assert.equal(reloc.type, 'checkbox');
  const gender = fields.find((f) => f.label === 'Gender');
  assert.ok(gender, 'a div combobox named by aria-labelledby is read');
  assert.equal(gender.type, 'prompt');
  assert.equal(gender.current, undefined, '"Select..." is a placeholder, not an answer');
  assert.ok(fields.some((f) => /which shift/i.test(f.label)), 'a combobox named only "Select" takes the question above it');
});

test("ASHBY'S YES/NO BUTTONS OVER A HIDDEN CHECKBOX (Mariana Minerals, 2026-09-25)", async () => {
  const fields = await discoverIn(`
  <form>
    <div class="_fieldEntry">
      <label class="ashby-application-form-question-title" for="q1">Do you now, or in the future, require visa sponsorship?</label>
      <div class="_yesno"><button type="button" class="_option">Yes</button><button type="button" class="_option">No</button>
        <input type="checkbox" id="q1" name="q1" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px"></div>
    </div>
    <div class="_fieldEntry">
      <label for="q2">I agree to the privacy notice</label>
      <input type="checkbox" id="q2" name="q2">
    </div>
  </form>`);
  const spon = fields.find((f) => /visa sponsorship/.test(f.label));
  assert.ok(spon, 'the question is read');
  assert.equal(spon.type, 'radio', 'two buttons are a choice, not a tick');
  assert.deepEqual(spon.options, ['Yes', 'No']);
  const consent = fields.find((f) => /privacy notice/.test(f.label));
  assert.equal(consent?.type, 'checkbox', 'a plain checkbox stays a checkbox');

  // The live markup (measured 2026-09-25): no id, the label's `for` is the
  // checkbox's NAME, and the checkbox has no box on screen.
  const live = await discoverIn(`<form>
    <div class="ashby-application-form-field-entry">
      <label class="ashby-application-form-question-title _required" for="a370d02c">Do you now, or in&nbsp; the future, require visa sponsorship?</label>
      <div class="ashby-application-form-input-yesno"><button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button>
        <input type="checkbox" tabindex="-1" name="a370d02c" style="display:none"></div>
    </div></form>`);
  assert.equal(live.length, 1);
  assert.equal(live[0].type, 'radio');
  assert.deepEqual(live[0].options, ['Yes', 'No']);
  assert.match(live[0].label, /require visa sponsorship\?$/);
});

test('A FILE SLOT NAMED ONLY BY ITS BUTTON TAKES THE QUESTION ABOVE IT (Formlabs, 2026-09-25)', async () => {
  const slot = (id, q) => `
    <div class="file-upload">
      <div class="upload-label">${q}</div>
      <div class="button-container"><button type="button">Attach</button>
        <label for="${id}" style="position:absolute;width:1px;height:1px;overflow:hidden">Attach</label>
        <input id="${id}" type="file" style="position:absolute;width:1px;height:1px;opacity:0">
        <button type="button">Dropbox</button><button type="button">Google Drive</button><button type="button">Enter manually</button></div>
      <p>Accepted file types: pdf, doc, docx, txt, rtf</p>
    </div>`;
  const fields = await discoverIn(`<form>
    <div><label for="fn">First Name</label><input id="fn"></div>
    ${slot('resume', 'Resume/CV*')}
    ${slot('cover_letter', 'Cover Letter')}
    ${slot('question_1', 'If your portfolio is not available online, please attach it here')}
  </form>`);
  const files = fields.filter((f) => f.type === 'file').map((f) => f.label);
  assert.equal(files.length, 3);
  assert.match(files[0], /^Resume\/CV/);
  assert.match(files[1], /^Cover Letter — Attach$/);
  assert.match(files[2], /^If your portfolio is not available online/);
});

test('THE QUESTION IN THE BLOCK BEFORE THE FIELD (Rippling, Boom Supersonic 2026-09-25)', async () => {
  const q = (text, control) => `
    <div>
      <div><div><p>${text}<span></span></p></div></div>
      <div data-testid="field"><div><div data-testid="customQuestions.x"><div><div data-testid="select-controller"><div><div><div>${control}</div></div></div></div></div></div></div>
    </div>`;
  const fields = await discoverIn(`<form>
    ${q('Please explain why you want to work at Boom and why you would make an extraordinary contribution.', '<textarea maxlength="10000"></textarea>')}
    ${q('Are you a U.S. Person?', '<div id="c1" role="combobox" aria-label="Select" aria-expanded="false" tabindex="0"><p>Select</p></div>')}
    ${q('Which of the following best describes how you found out about this opportunity?', '<input role="combobox" aria-label="Select" placeholder="Select" name="W2Rx">')}
  </form>`);
  const labels = fields.map((f) => f.label);
  assert.ok(labels.some((l) => /^Please explain why you want to work at Boom/.test(l)), 'the essay box');
  assert.ok(labels.includes('Are you a U.S. Person?'), 'the div dropdown');
  assert.ok(labels.includes('Which of the following best describes how you found out about this opportunity?'), 'the searchable dropdown');
  assert.ok(!labels.includes('Select'), '"Select" is never a question');
});

test("A DATE PICKER'S OWN BOX IS NOT A QUESTION (Rippling, 2026-09-25)", async () => {
  const fields = await discoverIn(`<form>
    <label for="n">First name</label><input id="n">
    <div role="dialog"><label for="cal">//September2026SMTWTFS12345678910TodayClear</label><input id="cal" required></div>
  </form>`);
  assert.deepEqual(fields.map((f) => f.label), ['First name']);
});

test('A MONTH LIST AND THE UNNAMED YEAR LIST AFTER IT ARE ONE DATE (Ashby education history, 2026-09-25)', async () => {
  const months = ['Month', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m) => `<option>${m}</option>`).join('');
  const years = ['Year', ...Array.from({ length: 12 }, (_, i) => String(2030 - i))].map((y) => `<option>${y}</option>`).join('');
  const fields = await discoverIn(`<form>
    <div><label for="sm">Start Date</label><div><select id="sm">${months}</select><select>${years}</select></div></div>
    <div><label for="em">End Date</label><div><select id="em">${months}</select><select>${years}</select></div></div>
  </form>`);
  assert.deepEqual(fields.map((f) => f.label), ['Start Date month', 'Start Date year', 'End Date month', 'End Date year']);
});

test('A DATE PICKER\'S "Pick date..." PLACEHOLDER IS PASSED ON (Atomic Semi, 2026-09-25)', async () => {
  await discoverIn(`<form><label for="d">Ideal start date in office</label><input id="d" type="text" placeholder="Pick date..."></form>`);
  const ph = await page.evaluate(() => globalThis.__jarvis.discover()[0].placeholder);
  assert.equal(ph, 'Pick date...');
});

test('A QUESTION ABOUT A LIST PRINTED UNDER IT CARRIES THE LIST (Atomic Semi, 2026-09-25)', async () => {
  await discoverIn(`<form><fieldset><legend>If no, is your home country listed below?</legend>
    <p>Armenia, Azerbaijan, China, Cuba, Vietnam, Yemen</p>
    <label><input type="radio" name="hc" value="Yes"> Yes</label><label><input type="radio" name="hc" value="No"> No</label></fieldset></form>`);
  const near = await page.evaluate(() => globalThis.__jarvis.discover().find((f) => /home country/.test(f.label))?.near || '');
  assert.match(near, /Vietnam/);
});

test('A PAY-PERIOD LIST WITH NO NAME IS NAMED FOR ITS SALARY (Sabanto Breezy, 2026-09-25)', async () => {
  const fields = await discoverIn(`<form><label for="s">Desired Salary</label><input id="s" type="text">
    <select name=""><option>Hourly</option><option>Weekly</option><option>Monthly</option><option>Yearly</option></select></form>`);
  assert.equal(fields[1].label, 'Desired Salary — period');
});

test('A LONG OPTION IN A GROUP IS NOT THE QUESTION (Capstan Medical Lever, 2026-09-26)', async () => {
  const fields = await discoverIn(`<form><ul><li class="application-question custom-question"><div><div><div class="application-label">Are you currently enrolled in, or actively pursuing, a Bachelor's, Master's, or Doctoral degree?</div></div>
    <div><ul data-qa="multiple-choice">
      <li><label><input type="radio" name="cards[x][field2]" value="Yes - I'm attending our pursuing higher education currently"><span>Yes - I'm attending our pursuing higher education currently</span></label></li>
      <li><label><input type="radio" name="cards[x][field2]" value="No"><span>No</span></label></li></ul></div></div></li></ul>
    <label><input type="checkbox" id="c1"> I agree to the privacy notice and the processing of my data</label></form>`);
  assert.match(fields[0].label, /^Are you currently enrolled/);
  assert.match(fields[1].label, /privacy notice/, 'a lone box still carries its own sentence');
});

test('F-840: ADP\'s accommodation notice and SmartRecruiters\' required-fields line are not errors; a real message beside them still is', async () => {
  await page.setContent(`<form>
      <div role="alert" style="color:rgb(38,35,33)">If you are unable to complete this application due to a disability, contact this employer to ask for an accommodation or an alternative application process.</div>
      <div role="alert" style="color:rgb(56,60,56)">Fields marked with * are required.<label>I currently work here</label><button type="button">Cancel</button><button type="button">Save</button></div>
      <div role="alert">Correct the information in highlighted fields. If you are unable to complete this application due to a disability, contact this employer.</div>
      <div role="alert">Fields marked with * are required. Please enter a valid email address.</div>
    </form>`);
  await page.addScriptTag({ content: DISCOVER });
  const errs = await page.evaluate(() => globalThis.__jarvis.errorsOnPage());
  const texts = errs.map((e) => e.text);
  assert.ok(!texts.some((t) => /^If you are unable to complete/.test(t)), `the notice alone is not an error: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((t) => /^Fields marked with \* are required\.I currently/.test(t)), 'the dialog instruction is not an error');
  assert.ok(texts.some((t) => /^Correct the information in highlighted fields/.test(t)), 'a real refusal sharing a banner with the notice still counts');
  assert.ok(texts.some((t) => /valid email address/.test(t)), 'a real message after the instruction still counts');
});

test('WHAT THE PAGE SAYS IN RED IS READ, WITH ITS FIELD (his ask, 2026-10-02)', async () => {
  await page.setContent(`<style>.err{color:#d32f2f}.brand{color:rgb(200,16,46)}.req{color:red}</style>
    <h2 class="brand">Spirit AeroSystems Careers</h2>
    <a class="brand" href="#">Benefits</a>
    <p><span class="req">*</span> indicates a required field</p>
    <form>
      <div class="q"><label for="fn">First Name <span class="req">*</span></label><input id="fn"><div class="err">This field is required.</div></div>
      <div class="q"><label for="ph">Phone</label><input id="ph" aria-invalid="true" aria-describedby="ph-msg"><span id="ph-msg">Enter a valid phone number</span></div>
      <div class="q"><label for="zip">Postal Code</label><input id="zip"><b class="req">!</b> <span class="req">Wrong format</span></div>
      <div role="alert">Your resume could not be uploaded. Try a PDF under 5 MB.</div>
      <div role="alert">Alex Rivera Resume.pdf successfully uploaded</div>
      <div role="alert">Saving</div>
      <div role="alert">You're all set, Alex!</div>
      <div role="alert">Your form needs corrections</div>
    </form>`);
  await page.addScriptTag({ content: DISCOVER });
  const errs = await page.evaluate(() => globalThis.__jarvis.errorsOnPage());
  const by = (re) => errs.find((e) => re.test(e.text));
  assert.equal(by(/This field is required/)?.how, 'red');
  assert.match(by(/This field is required/)?.field || '', /First Name/, 'the red line is tied to the box above it');
  assert.equal(by(/valid phone number/)?.how, 'invalid');
  assert.match(by(/valid phone number/)?.field || '', /Phone/);
  assert.equal(by(/Wrong format/)?.how, 'red', 'red words beside a box count without an error word');
  assert.match(by(/Wrong format/)?.field || '', /Postal Code/);
  assert.ok(by(/could not be uploaded/), 'an alert banner is read');
  assert.ok(!by(/successfully uploaded/), 'an alert that reports success is not an error');
  assert.ok(!by(/^Saving$|all set/), 'a status announcement is not an error (F-670)');
  assert.ok(by(/needs corrections/), 'Ashby\'s grey banner still counts');
  assert.ok(!by(/Spirit AeroSystems Careers|Benefits/), 'a red brand heading or link is not a message');
  assert.ok(!by(/^\*$|indicates a required field/), 'the required-field marker is not an error');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.redness('rgb(211, 47, 47)')), true);
  assert.equal(await page.evaluate(() => globalThis.__jarvis.redness('rgb(51, 51, 51)')), false);
  assert.equal(await page.evaluate(() => globalThis.__jarvis.redness('rgba(220, 20, 60, 0.1)')), false, 'a faint red wash is not red text');
});

test('PHENOM (Honda, JPL, 2026-10-02): the posting\'s Apply Now is followed; Honda\'s step Next is walked; "Next Next" is one name', async () => {
  const at = async (url, html) => {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.addScriptTag({ content: DISCOVER });
  };
  // The posting page, with the furniture that hid its Apply: a job-alert
  // email, the chatbot box and the rating stars.
  await at('https://careers.honda.test/us/en/job/AHMAHMUS12351EXTERNALENUS/Manufacturing-Equipment-Engineer', `
    <h1>Manufacturing Equipment Engineer</h1>
    <a data-ph-at-id="apply-link" class="phw-btn" href="https://careers.honda.test/us/en/hvhapply?jobSeqNo=AHMAHMUS12351EXTERNALENUS">Apply Now<span class="phw-sr">Apply Now Manufacturing Equipment Engineer</span></a>
    <div class="phw-subscribe"><label for="em">Email address</label><input id="em" type="email"><button data-ph-at-id="subscribe-jobs-link">Submit</button></div>
    <div class="chatbot"><input aria-label="Chatbot User Input box with Send button"></div>
    <fieldset><legend>How would you rate your experience?</legend><label><input type="radio" name="r">No rating</label><label><input type="radio" name="r">1 star</label></fieldset>
    <h3>Similar jobs</h3><a data-ph-at-id="apply-link" href="https://careers.honda.test/us/en/hvhapply?jobSeqNo=OTHER">Apply Now</a>`);
  const apply = await page.evaluate(() => globalThis.__jarvis.applyControl()?.getAttribute('href'));
  assert.match(apply || '', /jobSeqNo=AHMAHMUS12351EXTERNALENUS/, 'the posting\'s own Apply, not a similar job\'s');

  // A step of the apply flow: Next is type=submit inside the step's form.
  const step = (name) => `<form class="rjsf"><label for="fn">First Name</label><input id="fn">
    <div class="navigation ${name}-step"><div></div><button type="submit" class="btn btn-navigate btn-next" id="next" aria-label="Next">Next</button></div></form>`;
  await at('https://careers.honda.test/us/en/apply?jobSeqNo=AHMAHMUS12351EXTERNALENUS&step=1&stepname=personalInformation', step('personalInformation'));
  const next = await page.evaluate(() => {
    const J = globalThis.__jarvis;
    const n = J.nextControl();
    return { id: n?.id || null, name: J.buttonName(document.getElementById('next')), apply: !!J.applyControl() };
  });
  assert.equal(next.id, 'next', 'Honda\'s Next is walked, not left as a submit');
  assert.equal(next.name, 'Next', 'its text and aria-label are one name');
  assert.equal(next.apply, false, 'on the form itself nothing is an Apply to follow');

  // …and the last step's Submit, and any other submit, is still his.
  await at('https://careers.honda.test/us/en/apply?jobSeqNo=AHMAHMUS12351EXTERNALENUS&step=5&stepname=review',
    '<form><label for="x">Sig</label><input id="x"><div class="navigation review-step"><button type="submit" class="btn btn-navigate btn-submit">Submit</button></div></form>');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.nextControl()), null);
  await at('https://forms.example.test/apply?step=1',
    '<form><label for="y">Name</label><input id="y"><button type="submit" class="btn-next">Next</button></form>');
  assert.equal(await page.evaluate(() => globalThis.__jarvis.nextControl()), null, 'a plain form\'s submit-type Next is still his');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('HONDA STEP 2 (captured 2026-10-03): entry fields carry their entry\'s key, date boxes say they are calendar pickers, the open calendar is not a question', async () => {
  await page.goto('about:blank');
  await page.setContent(`<form class="rjsf"><fieldset id="experienceData[1]"><div class="row no-gutter form-fields">
    <div class="col-md-6"><div class="form-group field field-string"><label class="control-label" for="experienceData[1].companyName">Company Name<span class="required">*</span></label>
      <input aria-label="Company Name" class="form-control" required id="experienceData[1].companyName" type="text"></div></div>
    <div class="col-md-12"><div class="form-group field field-string"><label class="control-label" for="experienceData[1].presentEmployer">Current Employer<span class="required">*</span></label>
      <select id="experienceData[1].presentEmployer" class="form-control" required><option value="">Please Select</option><option value="6628">Current</option><option value="6629">Prior</option></select></div></div>
    <div class="col-md-12"><div id="experienceData_1_fromTo" class="date-range-fromTo">
      <div class="form-group field field-string"><label class="control-label" for="experienceData[1].fromTo.startDate">From Date<span class="required">*</span></label>
        <div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input type="text" id="experienceData[1].fromTo.startDate" class="form-control"></div></div></div>
      <div class="form-group field field-string"><label class="control-label" for="experienceData[1].fromTo.endDate">End Date</label>
        <div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input type="text" id="experienceData[1].fromTo.endDate" class="form-control"></div></div>
        <div class="react-datepicker-popper"><div class="react-datepicker"><div class="react-datepicker__header"><div class="range-div">
          <button aria-label="Previous Month">&lt;</button><select class="range-select"><option>2025</option><option>2026</option></select>
          <select class="range-select"><option>January</option><option>February</option></select><button aria-label="Next Month">&gt;</button></div></div></div></div></div>
    </div></div></div></fieldset></form>`);
  await page.addScriptTag({ content: DISCOVER });
  const got = await page.evaluate(() => globalThis.__jarvis.discover().map((f) => ({ label: f.label, type: f.type, key: f.key, picker: f.picker || '' })));
  assert.deepEqual(got.map((f) => f.key), ['experienceData[1].companyName', 'experienceData[1].presentEmployer', 'experienceData[1].fromTo.startDate', 'experienceData[1].fromTo.endDate']);
  assert.deepEqual(got.map((f) => f.picker), ['', '', 'mdy', 'mdy']);
  assert.ok(!got.some((f) => /^<$|January|2026/.test(f.label)), `the calendar's own lists are not questions: ${JSON.stringify(got.map((f) => f.label))}`);
});

test('A MODERNIZR PAGE IS NOT A VIDEO PLAYER (ADP Workforce Now, Therm-X, 2026-10-16)', async () => {
  const fields = await discoverIn(`<!doctype html><html class="hydrated js flexbox canvas video audio localstorage"><body>
    <h2>Personal Information</h2>
    <label for="fn">First Name*</label><input id="fn" type="text">
    <label for="ln">Last Name*</label><input id="ln" type="text">
    <div class="video-player"><label for="vol">Volume</label><input id="vol" type="text"></div>
  </body></html>`);
  const labels = fields.map((f) => f.label);
  assert.ok(labels.some((l) => /First Name/.test(l)), `the form's own boxes are read (got ${JSON.stringify(labels)})`);
  assert.ok(labels.some((l) => /Last Name/.test(l)));
  assert.ok(!labels.some((l) => /Volume/.test(l)), 'a box inside a real player is still not a question');
});

test('A GREYED-OUT NEXT IS NOT THE LAST STEP (ADP resume step, 2026-10-16)', async () => {
  await page.setContent(`<h2>Resume</h2><p>Required</p><input type="file" id="r"><button type="button">Previous</button><button type="button" disabled aria-disabled="true">Next</button>`);
  await page.addScriptTag({ content: DISCOVER });
  const said = await page.evaluate(() => ({ next: !!globalThis.__jarvis.nextControl(), why: globalThis.__jarvis.advanceBlockedBy() }));
  assert.equal(said.next, false, 'a disabled Next is never pressed');
  assert.match(String(said.why), /greyed out/);
});

test('A SIGN-UP THAT SENDS A CODE AND OFFERS GOOGLE IS A SIGN-IN WALL (ADP talent community, 2026-10-16)', async () => {
  const sso = `<button type="button">Sign in with Google</button>`;
  await page.setContent(`<h2>Join Our Talent Community</h2>
    <label for="f">First Name</label><input id="f"><label for="l">Last Name</label><input id="l">
    <label for="e">Email</label><input id="e" type="email"><label for="m">Mobile Number</label><input id="m" type="tel">
    <p>Where would you like to receive a verification code?</p>
    <label><input type="radio" name="to"> +1-555-010-0000</label><label><input type="radio" name="to"> v@example.test</label>
    <button type="button">Send</button>${sso}`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true, 'Google is pressed rather than the sign-up filled');
  // …and before its Continue, when the code question has not appeared yet.
  await page.setContent(`<h2>Join Our Talent Community</h2>
    <p>Please be advised that the mobile number or email associated with this verification process is intended to be unique to you.</p>
    <label for="f">First Name</label><input id="f"><label for="l">Last Name</label><input id="l">
    <label for="e">Email</label><input id="e" type="email"><label for="m">Mobile Number</label><input id="m" type="tel">
    <button type="button">Continue</button><p>Alternatively, you can sign in through your social media accounts.</p>${sso}`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), true, 'before Continue too');
  await page.setContent(`<h2>Apply</h2>
    <label for="f">First Name</label><input id="f"><label for="l">Last Name</label><input id="l">
    <label for="e">Email</label><input id="e" type="email"><label for="m">Phone</label><input id="m" type="tel">${sso}`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.signInWall()), false, 'an application with a Google button and no code is still a form');
});

test('"COMPLETE YOUR APPLICATION" ON A STARTED POSTING IS ITS APPLY (ADP Pending Submission, 2026-10-16)', async () => {
  await page.setContent(`<h1>Mechanical Engineer I/II – Thermal Systems</h1><p>Pending Submission</p><button type="button">Back</button><button type="button">Complete Your Application</button>`);
  await page.addScriptTag({ content: DISCOVER });
  assert.equal(await page.evaluate(() => globalThis.__jarvis.buttonName(globalThis.__jarvis.applyControl())), 'Complete Your Application');
});

test('ADP\'S <sdf-select-simple> IS A QUESTION: shadow trigger, label from the block above (Therm-X, 2026-10-17)', async () => {
  await page.setContent(`<div class="qMainDiv">
      <div>4. How many years have you worked as a mechanical design engineer (internships count at half)?*</div>
      <div class="itemPadLeft"><div id="drop_down_type_3"><sdf-select-simple id="question_3" placeholder="Choose an option"></sdf-select-simple></div></div>
    </div>
    <script>
      customElements.define('sdf-select-simple', class extends HTMLElement {
        connectedCallback() {
          const r = this.attachShadow({ mode: 'open' });
          r.innerHTML = '<div class="combo"><div role="button" class="trigger-button" aria-expanded="false" tabindex="0"><span class="selected-label-placeholder">Choose an option</span></div></div>';
        }
      });
    </script>
    <input class="filter sc-sdf-select-simple" role="combobox" aria-label="Enter text to filter your options">`);
  await page.addScriptTag({ content: DISCOVER });
  const fields = await page.evaluate(() => globalThis.__jarvis.discover().map((f) => ({ label: f.label, type: f.type, kind: f.promptKind, el: f.elements[0]?.className })));
  assert.deepEqual(fields.map((f) => f.label), ['How many years have you worked as a mechanical design engineer (internships count at half)?'], JSON.stringify(fields));
  assert.equal(fields[0].el, 'trigger-button', 'the shadow trigger is the control');
});

test('A STYLED CHECKBOX PARKED OFFSCREEN WITH A LABEL ON SCREEN IS A QUESTION; A TRAP IS NOT (ADP e-sign, 2026-10-17)', async () => {
  await page.setContent(`<form>
      <div class="vdl-checkbox"><input id="cb1" type="checkbox" name="self_att_agree_chk" tabindex="0" style="position:absolute;left:-9999px;opacity:0"><label for="cb1">Yes, I agree to sign electronically.</label></div>
      <input name="hp_7f2b" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px">
      <input id="trap" type="checkbox" tabindex="-1" style="position:absolute;left:-9999px">
    </form>`);
  await page.addScriptTag({ content: DISCOVER });
  const labels = await page.evaluate(() => globalThis.__jarvis.discover().map((f) => f.label));
  assert.deepEqual(labels, ['Yes, I agree to sign electronically.'], JSON.stringify(labels));
});

test('F-873: a plain box reports what it already holds; an empty one and a password do not', async () => {
  await page.setContent(`
    <form>
      <label for="co">Company Name</label><input id="co" value="Lakeside University – Makerspace Manufacturing Tech">
      <label for="ti">Job Title</label><input id="ti">
      <label for="pw">Password</label><input id="pw" type="password" value="secret">
    </form>`);
  await page.addScriptTag({ content: DISCOVER });
  const got = await page.evaluate(() => globalThis.__jarvis.discover().map((f) => [f.label, f.held ?? null]));
  const by = Object.fromEntries(got);
  assert.equal(by['Company Name'], 'Lakeside University – Makerspace Manufacturing Tech');
  assert.equal(by['Job Title'], null);
  assert.ok(!Object.values(by).includes('secret'), `a password is never read: ${JSON.stringify(got)}`);
});

test('F-884: a chat widget (Paradox <apply-widget>) is not the page — its reply box and video upload are no fields', async () => {
  const fields = await discoverIn(`
    <h1>Manufacturing Engineer</h1>
    <form><label for="f">First Name</label><input id="f"></form>
    <apply-widget id="eli"></apply-widget>
    <div id="intercom-container"></div>
    <script>
      document.getElementById('eli').attachShadow({ mode: 'open' }).innerHTML = '<textarea placeholder="Write a reply..."></textarea><label>Upload Video<input type="file" accept="video/*"></label>';
      document.getElementById('intercom-container').attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="Type a message">';
    <\/script>`);
  assert.deepEqual(fields.map((f) => f.label), ['First Name'], JSON.stringify(fields.map((f) => [f.label, f.type])));
});

// ── R1 (2026-11-07): the posting's JSON-LD, chosen and checked ──────────

const ld = (o) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description: 'x', ...o })}</script>`;

test('R1: SEVERAL JobPostings — the one with this page\'s requisition is the job', async () => {
  const got = await readIn(`${ld({ title: 'Old Job', url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/Old-Job_R111111' })}
    ${ld({ title: 'New Job', url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/New-Job_R222222' })}
    <a data-automation-id="adventureButton" role="button">Apply</a>`,
  { ats: true, url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boise/New-Job_R222222' });
  assert.equal(got?.title, 'New Job');
  assert.equal(got?.source, 'jsonld');
});

test('R1: several JobPostings and no requisition — the one titled like the page\'s own heading', async () => {
  const got = await readIn(`${ld({ title: 'Process Engineer' })}${ld({ title: 'Test Engineer' })}
    <h1>Test Engineer</h1><button>Apply</button>`);
  assert.equal(got?.title, 'Test Engineer');
  assert.equal(got?.source, 'jsonld');
});

test('R1: several JobPostings the page cannot tell apart — still none from the markup', async () => {
  const got = await readIn(`${ld({ title: 'Test Engineer', hiringOrganization: 'A' })}${ld({ title: 'Test Engineer', hiringOrganization: 'B' })}
    <h1>Test Engineer</h1><button>Apply</button>`);
  assert.ok(!got || got.source !== 'jsonld', JSON.stringify(got));
});

test('R1: THE SAME BLOB AT ANOTHER ADDRESS is the previous job (a single-page site that kept it); its apply page is not', async () => {
  const blob = `${ld({ title: 'Widget Engineer', hiringOrganization: 'Acme' })}<h1>Widget Engineer</h1><button>Apply</button>`;
  const first = await readIn(blob, { url: 'https://careers.acme-widgets.test/jobs?job=17&utm_source=x' });
  assert.equal(first?.source, 'jsonld', 'read first here');
  const again = await readIn(blob, { url: 'https://careers.acme-widgets.test/jobs?job=17' });
  assert.equal(again?.source, 'jsonld', 'the same page without its tracking parameter is the same page');
  const apply = await readIn(blob.replace('<button>Apply</button>', '<a href="#">Apply</a>'), { url: 'https://careers.acme-widgets.test/jobs?job=17' });
  assert.equal(apply?.source, 'jsonld');
  const otherLanguage = await readIn(blob, { url: 'https://careers.acme-widgets.test/en-US/jobs?job=17' });
  assert.equal(otherLanguage?.source, 'jsonld', 'the same page under a locale segment is the same page (review)');
  const moved = await readIn(blob, { url: 'https://careers.acme-widgets.test/jobs?job=18' });
  assert.ok(!moved || moved.source !== 'jsonld', `the markup first read at job 17 is not job 18's: ${JSON.stringify(moved)}`);
});

test('R1: what the posting says beyond its title — pay, remote, where applicants may live, closing date, the employer\'s site', async () => {
  const got = await readIn(`${ld({
    title: 'Controls Engineer', hiringOrganization: { '@type': 'Organization', name: 'Acme', sameAs: 'https://www.acme.com' },
    employmentType: ['FULL_TIME'], jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: [{ '@type': 'Country', name: 'United States' }],
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 85000, maxValue: 105000, unitText: 'YEAR' } },
    validThrough: '2026-12-31T23:59:59Z',
  })}<h1>Controls Engineer</h1><button>Apply</button>`);
  assert.equal(got.employmentType, 'FULL_TIME');
  assert.deepEqual(got.salary, { min: 85000, max: 105000, currency: 'USD', unit: 'YEAR' });
  assert.equal(got.remote, true);
  assert.deepEqual(got.applicantLocations, ['United States']);
  assert.equal(got.validThrough, '2026-12-31T23:59:59.000Z');
  assert.equal(got.employerSite, 'https://www.acme.com');
  const bare = await readIn(`${ld({ title: 'Controls Engineer' })}<h1>Controls Engineer</h1><button>Apply</button>`);
  for (const k of ['salary', 'remote', 'applicantLocations', 'validThrough', 'employerSite', 'employmentType']) assert.ok(!(k in bare), `${k} absent when the markup says nothing`);
});

test('R1: THE SITE\'S NAME AS AN EMPLOYER loses only its careers words', async () => {
  const company = async (site) => (await readIn(`<meta property="og:site_name" content="${site}"><h1>Mechanical Engineer</h1><button>Apply</button>`))?.company;
  assert.equal(await company('Acme Careers'), 'Acme');
  assert.equal(await company('Careers at Acme Robotics'), 'Acme Robotics');
  assert.equal(await company('Careers | Acme'), 'Acme');
  assert.equal(await company('Acme Careers Home'), 'Acme');
  assert.equal(await company('Acme Jobs | Home'), 'Acme');
  assert.equal(await company('Smart Home'), 'Smart Home', '"Home" goes only with a careers word (review)');
  assert.equal(await company('Jobs'), '', 'nothing but the careers word: no name');
  assert.equal(await company('Job Corps'), 'Job Corps', 'a name that merely starts with a careers word is left alone');
});

// ── R1 item 5: employer career sites, as read off their live public pages (2026-11-07) ──

test('R1: TESLA — the job is the <h1> in #job-details-container, not the logo or the "Build your Career at Tesla" hero', async () => {
  const got = await readIn(`
    <header id="tds-site-header-wrapper"><div id="tds-global-menu"><header id="tds-site-header"><h1 class="tds-site-logo">Tesla homepage Careers Skip to main content</h1></header></div></header>
    <section class="legacy-hero careers-width-constraint"><h1>Build your Career at Tesla</h1></section>
    <div id="app"><div id="job-details-container" class="careers-width-constraint"><div class="tds-content_container tds-content_container--large">
      <h1 class="tds-text--h1-alt">Engineering Technician, Low Voltage Test</h1></div>
      <a href="/careers/search/job/apply/284928">Apply</a></div></div>
    <meta property="og:site_name" content="Build your Career at Tesla">`, { url: 'https://www.tesla.com/careers/search/job/284928' });
  assert.equal(got?.title, 'Engineering Technician, Low Voltage Test');
  assert.equal(got?.company, 'Tesla', 'the site name loses "Build your Career at"');
});

test('R1: GOOGLE — an <h1> that says "Job Details" is not the title; og:title is', async () => {
  const got = await readIn(`
    <c-wiz class="zQTmif SSPGKf"><div class="T4LgNb"><div class="RRYLgd"><div><h1 class="g9adte">Job Details</h1></div></div></div></c-wiz>
    <span><div class="DkhPwc"><div class="sPeqm"><h2 class="p1N2lc">Silicon Engineer, PhD, University Graduate, 2027 Start</h2></div></div></span>
    <a href="#apply">Apply</a>
    <meta property="og:title" content="Silicon Engineer, PhD, University Graduate, 2027 Start">`, { url: 'https://www.google.com/about/careers/applications/jobs/results/127950560631366342' });
  assert.equal(got?.title, 'Silicon Engineer, PhD, University Graduate, 2027 Start');
});

test('R1: AMAZON and APPLE — their own title spots; "Amazon.jobs" names Amazon', async () => {
  const amazon = await readIn(`
    <div class="container"><div class="row"><div class="info-wrapper col-12 col-md-7"><div class="info"><h1 class="title">Senior Financial Analyst, Engineering Capex Analytics &amp; Planning</h1></div></div>
    <div class="apply-wrapper col-12 col-md-5"><div class="apply"><a id="apply-button" class="btn btn-primary" href="#">Apply now</a></div></div></div></div>
    <meta property="og:site_name" content="Amazon.jobs">`, { url: 'https://www.amazon.jobs/en/jobs/10371179/senior-financial-analyst-engineering-capex-analytics-planning' });
  assert.equal(amazon?.title, 'Senior Financial Analyst, Engineering Capex Analytics & Planning');
  assert.equal(amazon?.company, 'Amazon');
  const apple = await readIn(`
    <div><div id="jobdetails-wrapper"><div><main class="text-center mt-30"><h1 id="jobdetails-postingtitle" class="t-headline fw-medium">Industrial Designer</h1></main></div></div></div>
    <a href="#">Submit Resume</a><button>Apply</button>`, { url: 'https://jobs.apple.com/en-us/details/200007574-0836/industrial-designer' });
  assert.equal(apple?.title, 'Industrial Designer');
});

test('R1: the new not-a-title words never swallow a real title', async () => {
  const got = await readIn('<h1>Work at Height Safety Technician</h1><button>Apply</button>');
  assert.equal(got?.title, 'Work at Height Safety Technician');
  const careersLead = await readIn('<h1>Careers at Acme</h1><h2>x</h2><meta property="og:title" content="Robotics Engineer"><button>Apply</button>');
  assert.equal(careersLead?.title, 'Robotics Engineer', '"Careers at Acme" is the site, not the job');
});
