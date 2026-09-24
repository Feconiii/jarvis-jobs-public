/**
 * The side panel page, rendered in a real Chromium with the worker stubbed.
 *
 * panel.js talks only to the worker (chrome.runtime.sendMessage) and reads
 * the active tab (chrome.tabs.query); both are stubbed here with what the
 * worker would answer for one Becton Dickinson-shaped application. What is
 * proven: the job card, the fit ring and skills, the resume PDF in its frame,
 * the tailoring audit, the walk's state, and that Fill sends a press for the
 * tab beside it — and that nothing on the page submits anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = pathToFileURL(path.join(HERE, 'panel.html')).href;

// A tiny PDF, base64, as the worker would hand it over.
const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');

const DATA = {
  job: { id: 'job-1', title: 'Advanced Manufacturing Engineer I', company: 'Becton Dickinson', location: 'Warwick, RI, United States', salary_min: 75000, salary_max: 95000, salary_currency: 'USD', logo: null },
  fit: { score: 72, band: 'strong', bandLabel: 'Strong fit', reasons: ['Manufacturing engineering — his target role', 'Asks ~1y experience'], blockers: [], skills: { matched: ['solidworks', 'gd&t', 'lean'], missing: ['minitab'] } },
  application: { status: 'ready', family: { key: 'mfg', label: 'Manufacturing' }, titles: ['Manufacturing Engineer Intern'], resume: true,
    qa: { ok: false, failed: ['No isolated skill on a second line'], problems: ['Skills "CAD/CAE" wraps to a second line of 1 item(s) ("AutoCAD")'], warnings: [] },
    tailoring: { why: 'plan for experience; 2 rewrite(s) proposed', applied: [{ key: 'amat.amr', from: 'Supported AMR deployment.', to: 'Supported deployment and validation of AMRs for cleanroom material handling.' }], refused: [], unmatched: [], notices: [] } },
  submit: false,
};

let browser;
let page;
const sent = [];

async function open({ armed = null, running = false, resume = { ok: true, pdf: PDF_B64, filename: 'Alex Rivera Resume.pdf' }, panel = { ok: true, data: DATA }, letter = { ok: false, status: 404, error: 'no letter for this job yet' }, report = null, live = '' } = {}) {
  sent.length = 0;
  page = await browser.newPage();
  await page.exposeFunction('__sent', (m) => { sent.push(m); });
  await page.addInitScript(({ armed, running, resume, panel, letter, report, live }) => {
    const answers = {
      panel: { ...panel, tab: { id: 7, url: 'https://jobs.smartrecruiters.com/oneclick-ui/company/Co/publication/abc', title: 'Easy apply' }, armed, running },
      'panel-state': { ok: true, armed, running, report, live },
      // "ask Claude" from the Answers tab: the worker asks the page which box
      // it is about, then the server — here, the answer comes straight back.
      'panel-ask': { ok: true, q: 'Why do you want to work at Becton Dickinson?', status: 'ready', text: 'I want to work on medical device manufacturing lines.', problems: [], model: { used: 'opus' } },
      'panel-put': { ok: true, found: true, said: 'in the box' },
      'panel-resume': resume,
      'panel-retailor': { ok: true, id: 'job-1', status: 'tailoring' },
      'cover-letter': { ok: true, id: 'job-1', status: 'writing' },
      // A LIST IS A SEQUENCE OF ANSWERS, one per read, the last one repeating
      // — which is how the worker actually behaves while the filler writes a
      // letter underneath the panel (F-538).
      'cover-letter-get': letter,
      'fill-text': { ok: true, found: true },
      // The dashboard's own address for the file, which is where the name
      // comes from now (F-412). A blob has no name to take.
      'file-url': { ok: true, url: 'http://localhost:4300/api/apply-resume?id=job-1&inline=1' },
      'attach-file': { ok: true, name: 'Alex Rivera - Becton Dickinson - Manufacturing Engineer I.pdf', label: 'Resume' },
      press: { ok: true, tabId: 7 },
    };
    globalThis.chrome = {
      runtime: {
        sendMessage: (msg, cb) => {
          globalThis.__sent(msg);
          let a = answers[msg.type];
          if (Array.isArray(a)) a = a.length > 1 ? a.shift() : a[0];
          setTimeout(() => cb(a || { ok: false, error: `unknown ${msg.type}` }), 5);
        },
        getManifest: () => ({ version: '9.9.9' }),
        onMessage: { addListener() {} },
        lastError: null,
      },
      // The only API that names a download authoritatively (F-386).
      downloads: { download: async (o) => { globalThis.__sent({ type: '__download', ...o }); return 1; } },
      tabs: {
        query: async () => [{ id: 7, url: 'https://jobs.smartrecruiters.com/oneclick-ui/company/Co/publication/abc', title: 'Easy apply' }],
        create: async () => ({}),
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    };
  }, { armed, running, resume, panel, letter, report, live });
  await page.goto(PANEL);
  await page.waitForFunction(() => !document.getElementById('main').hidden || /Not a posting|cannot see/.test(document.getElementById('empty').textContent));
  return page;
}

test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

test('THE PANEL SHOWS THE POSTING, ITS FIT AND THE RESUME WRITTEN FOR IT', async () => {
  await open();
  assert.equal(await page.textContent('#title'), 'Advanced Manufacturing Engineer I');
  assert.equal(await page.textContent('#sub'), 'Becton Dickinson · Warwick, RI, United States');
  assert.equal(await page.textContent('#pay'), '$75,000 – $95,000 / year');
  assert.equal(await page.textContent('#score'), '72');
  assert.equal(await page.textContent('#band'), 'Strong fit');
  assert.match(await page.textContent('#skills'), /Asks for 3 of his skills/);
  assert.match(await page.textContent('#skills'), /minitab/);
  await page.waitForFunction(() => !document.getElementById('pdf').hidden);
  // Shown from the dashboard's address rather than a blob, so Chrome's own
  // viewer names the file if he saves it from there (F-412).
  assert.match(await page.getAttribute('#pdf', 'src'), /\/api\/apply-resume/, 'the PDF is shown from the address that names it');
  assert.match(await page.textContent('#family'), /Manufacturing/);
  assert.match(await page.textContent('#audit-body'), /Supported deployment and validation of AMRs/);
  assert.match(await page.textContent('#qa'), /Layout check: No isolated skill on a second line/, 'a sheet that failed his checklist says so beside the PDF');
  assert.equal(await page.textContent('#fill'), 'Fill this page');
  const submitty = await page.evaluate(() => [...document.querySelectorAll('button, input, a')].filter((b) => /submit|send application/i.test(b.textContent + (b.value || ''))).length);
  assert.equal(submitty, 0, 'nothing on the panel submits');
  await page.close();
});

test('FILL PRESSES FOR THE TAB BESIDE IT, and the walk\'s state is read back', async () => {
  const armed = { id: 'job-1', company: 'Becton Dickinson', started: true, acc: { filled: 34, checked: 2, uploaded: true, unanswered: ['step 1: Website'], stoppedBecause: 'reached the last step before Submit' } };
  await open({ armed });
  assert.match(await page.textContent('#status'), /34 filled · 2 ticked · resume attached/);
  assert.match(await page.textContent('#status'), /1 left for you/);
  assert.match(await page.textContent('#status'), /Submit is yours/);
  assert.equal(await page.textContent('#fill'), 'Fill this page again');
  await page.click('#fill');
  await page.waitForFunction(() => globalThis.__jarvisPanel.state.pollUntil > 0);
  await new Promise((r) => setTimeout(r, 50));
  const press = sent.find((m) => m.type === 'press');
  assert.ok(press, 'a press went to the worker');
  assert.equal(press.tabId, 7, 'for the tab the panel is beside');
  await page.close();
});

test('A NOTE IN THE PANEL ASKS FOR THE RESUME AGAIN, for this job, in his words', async () => {
  await open({ panel: { ok: true, data: { ...DATA, application: { ...DATA.application, request: 'shorter Acme Steel' } } } });
  await page.waitForFunction(() => !document.getElementById('pdf').hidden);
  // "Change it" folds inside the Resume card it changes (2026-09-23).
  await page.click('#change-open');
  assert.match(await page.textContent('#request-shown'), /Written with your note: "shorter Acme Steel"/);
  await page.click('#retailor');
  assert.match(await page.textContent('#retailor-note'), /Say what to change/, 'an empty note goes nowhere');
  await page.fill('#request', 'lead with the fixture work');
  await page.click('#retailor');
  await page.waitForFunction(() => /Writing it again/.test(document.getElementById('retailor-note').textContent));
  const m = sent.find((x) => x.type === 'panel-retailor');
  assert.ok(m, 'the note went to the worker');
  assert.equal(m.id, 'job-1');
  assert.equal(m.request, 'lead with the fixture work');
  assert.equal(await page.inputValue('#request'), '', 'the box clears once it is sent');
  await page.close();
});

test('THE COVER LETTER IS ASKED FOR, SHOWN WITH ITS CHECKS, AND PUT IN THE FORM ON HIS CLICK', async () => {
  await open();
  // THE STRIP IS HOW HE FINDS IT. The letter card sat under the PDF viewer
  // and he reported the panel had no cover-letter option at all. It is a
  // named tab now, beside Resume, and it opens the card on its own.
  await page.waitForFunction(() => !document.getElementById('pdf').hidden);
  assert.equal(await page.isHidden('#letter'), true, 'the letter waits behind its tab');
  assert.equal(await page.isVisible('#tab-letter'), true, 'and the tab is on screen without scrolling past the PDF');
  const tabY = await page.evaluate(() => document.getElementById('tab-letter').getBoundingClientRect().top);
  assert.ok(tabY < 700, `the Cover letter tab sits at ${Math.round(tabY)}px — above the fold`);
  await page.click('#tab-letter');
  await page.waitForFunction(() => !document.getElementById('letter').hidden);
  assert.equal(await page.isHidden('#resume'), true, 'one card at a time');
  assert.match(await page.textContent('#letter-status'), /None written/);
  await page.fill('#letter-request', 'mention the cobot');
  await page.click('#letter-write');
  await page.waitForFunction(() => /Writing it/.test(document.getElementById('letter-status').textContent));
  const asked = sent.find((m) => m.type === 'cover-letter');
  assert.equal(asked.id, 'job-1');
  assert.equal(asked.request, 'mention the cobot');
  await page.close();

  const ready = { ok: true, status: 'ready', at: '2026-09-06T20:00:00Z', text: 'Dear Hiring Manager,\n\nAt Applied Materials I designed a fixture.\n\nAlex Rivera', problems: ['figure "85%" is not in cv.md or the posting'], notices: [], request: '' };
  await open({ letter: ready });
  await page.click('#tab-letter');
  await page.waitForFunction(() => !document.getElementById('letter-text').hidden);
  assert.match(await page.textContent('#letter-text'), /designed a fixture/);
  assert.match(await page.textContent('#letter-problems'), /Check before you use it[\s\S]*85%/, 'what the guard could not clear is shown, in red, before he uses it');
  assert.equal(await page.textContent('#letter-write'), 'Write it again');
  await page.click('#letter-fill');
  await page.waitForFunction(() => /In the form/.test(document.getElementById('letter-note').textContent));
  const filled = sent.find((m) => m.type === 'fill-text');
  assert.equal(filled.tabId, 7);
  assert.match(filled.text, /Alex Rivera$/);
  await page.close();
});

/**
 * F-538. The filler asks for the cover letter itself when the form has a slot
 * for one, so the panel's first read is taken BEFORE the letter exists. That
 * "none yet" was remembered for as long as the panel stayed on the page, and
 * he watched the card say "None written for this posting yet." beside a
 * Neuralink form holding "… - Cover Letter.pdf" (2026-09-21).
 */
test('"NONE WRITTEN YET" IS RE-ASKED, so a letter the filler wrote shows up', async () => {
  const ready = { ok: true, status: 'ready', at: '2026-09-21T00:42:00Z', text: 'Dear Hiring Manager,\n\nAt Applied Materials I designed a fixture.\n\nAlex Rivera', problems: [], notices: [], request: '' };
  const none = { ok: false, status: 404, error: 'no letter for this job yet' };

  // HIS CLICK ON THE TAB ASKS AGAIN. The first read (on load) found nothing;
  // opening the card reads it a second time.
  await open({ letter: [none, ready] });
  await page.waitForFunction(() => /None written/.test(document.getElementById('letter-status').textContent));
  await page.click('#tab-letter');
  await page.waitForFunction(() => !document.getElementById('letter-text').hidden);
  assert.match(await page.textContent('#letter-text'), /designed a fixture/);
  assert.equal(await page.textContent('#letter-write'), 'Write it again');
  assert.equal(sent.filter((m) => m.type === 'cover-letter-get').length, 2, 'the miss was not kept');
  await page.close();

  // AND WITHOUT A CLICK, while the walk runs — which is exactly when the
  // filler writes one.
  await open({ armed: { id: 'job-1', company: 'Becton Dickinson', started: true }, running: true, letter: [none, ready] });
  await page.waitForFunction(() => /None written/.test(document.getElementById('letter-status').textContent));
  await page.waitForFunction(() => !document.getElementById('letter-text').hidden, null, { timeout: 15000 });
  assert.match(await page.textContent('#letter-text'), /designed a fixture/);
  await page.close();
});

test('A PAGE THAT IS NOT A POSTING SAYS SO, and a resume still being written is waited for', async () => {
  await open({ panel: { ok: false, status: 404, error: 'this page is not a posting in your store' } });
  assert.match(await page.textContent('#empty'), /Not a posting in your store/);
  assert.equal(await page.isHidden('#main'), true);
  await page.close();

  await open({ resume: { ok: false, status: 425, error: 'still writing the resume for Becton Dickinson' } });
  await page.waitForFunction(() => /still writing/i.test(document.getElementById('resume-body').textContent));
  assert.equal(await page.isHidden('#pdf'), true);
  await page.close();
});

/**
 * A BUILD IN PROGRESS SAYS WHERE IT HAS GOT TO, AND A FINISHED ONE SAVES UNDER
 * ITS OWN NAME.
 *
 * "says still writing the resume for amazon but ive been waiting and nothing
 * happens" and "when i press download it doesnt use the naming convention we
 * had it was just a bunch of random letters and numbers" (2026-09-06). The
 * server names the stage on every 425; the panel draws a bar and the stage,
 * and the finished PDF is offered as a link that carries the filename.
 */
test('a resume still being written shows the stage it is at, not one unchanging line', async () => {
  await open({ resume: { ok: false, status: 425, error: 'still writing the resume for Amazon', phase: 'checking every claim against your CV', seconds: 41 } });
  await page.waitForFunction(() => /checking every claim/.test(document.getElementById('resume-body').textContent));
  const shown = await page.evaluate(() => ({
    text: document.getElementById('resume-body').textContent,
    width: document.querySelector('#resume-body .phase .bar i')?.style.width || '',
    pdfHidden: document.getElementById('pdf').hidden,
    dlHidden: document.getElementById('download-pdf').hidden,
  }));
  assert.match(shown.text, /checking every claim against your CV/);
  assert.match(shown.text, /41s/, 'and how long it has been going');
  assert.equal(shown.width, '45%', 'the bar reflects the stage');
  assert.equal(shown.pdfHidden, true);
  assert.equal(shown.dlHidden, true, 'nothing to download until it is written');
  await page.close();
});

test('THE RESUME IS NAMED EVERYWHERE IT CAN BE SAVED FROM, never a blob id (F-412)', async () => {
  await open();
  await page.waitForFunction(() => !document.getElementById('pdf').hidden);
  const dl = await page.evaluate(() => {
    const a = document.getElementById('download-pdf');
    return {
      hidden: a.hidden,
      name: a.getAttribute('download'),
      href: a.getAttribute('href'),
      frame: document.getElementById('pdf').getAttribute('src'),
      attach: document.getElementById('attach-pdf').hidden,
    };
  });
  assert.equal(dl.hidden, false, 'the button is offered as soon as the PDF is here');
  assert.equal(dl.name, 'Alex Rivera Resume.pdf', 'the name the server gave it');
  // NOT A BLOB. Chrome's PDF viewer takes its Save name from the last segment
  // of the URL it is showing, so a blob offered a UUID from the viewer's own
  // save button and from "open in a tab" — the two routes anyone uses. His
  // words: "pressing download resume in the extension saves it as name with
  // random letters and numbers". The dashboard's URL carries the name.
  assert.doesNotMatch(dl.href, /^blob:/, 'the link is not a blob');
  assert.match(dl.href, /\/api\/apply-resume/, "it is the dashboard's own address");
  assert.doesNotMatch(dl.frame, /^blob:/, 'and neither is what the viewer is showing');
  assert.match(dl.frame, /inline=1/, 'shown inline, so the viewer names its own save');
  assert.equal(dl.attach, false, 'and it can be put straight into the slot on the page (F-413)');

  // The save itself carries the name too.
  await page.click('#download-pdf');
  await page.waitForFunction(() => /Saved as/.test(document.getElementById('save-note').textContent));
  const saved = sent.find((m) => m.type === '__download');
  assert.equal(saved.filename, 'Alex Rivera Resume.pdf', 'the Save dialog is handed the name, not a blob id');
  assert.doesNotMatch(saved.url, /^blob:/, 'and the header names it even if `filename` is ignored');
  assert.equal(saved.saveAs, true, 'and he still chooses where it goes');
  await page.close();
});

test('PUT IT IN THE SLOT sends the page the file, and says where it went (F-413)', async () => {
  // He asked to drag the resume from the panel into a form's drop zone.
  // Chrome will not carry a File between an extension page and a web page, so
  // this is the same thing in one click.
  await open();
  await page.waitForFunction(() => !document.getElementById('attach-pdf').hidden);
  await page.click('#attach-pdf');
  await page.waitForFunction(() => /Attached/.test(document.getElementById('save-note').textContent));
  const asked = sent.find((m) => m.type === 'attach-file');
  assert.equal(asked.what, 'resume');
  assert.equal(asked.tabId, 7, 'the tab beside the panel');
  const said = await page.evaluate(() => document.getElementById('save-note').textContent);
  assert.match(said, /Alex Rivera - Becton Dickinson - Manufacturing Engineer I\.pdf/, 'it names the file it attached');
  assert.match(said, /Resume/, 'and the slot it went into');
  await page.close();
});

test('WITH NO REPORT ON THE TAB, THE ASK BOX IS STILL THERE (2026-09-24)', async () => {
  // "telling claude to answer again ... it legit just doesnt let me or show it":
  // every ask lived inside a fill report, so no report meant no way to ask.
  await open({ armed: null, report: null, live: '' });
  await page.click('[data-tab="answers"]').catch(() => {});
  await page.waitForFunction(() => !!document.getElementById('jarvis-ask-q'));
  assert.match((await page.textContent('#answers-body')).replace(/\s+/g, ' '), /No fill report on this tab yet/);
  assert.equal(await page.isVisible('#jarvis-ask-q'), true, 'open, not folded away');
  await page.close();
});

test('THE ANSWERS TAB IS THE REPORT THAT USED TO FLOAT OVER THE FORM (2026-09-23)', async () => {
  // "stuff is still climbing on top of each other": the page drew its fill
  // report as a box over the form's top-right corner. The page now hands it
  // to the worker, and it is read here — every written answer and every
  // leftover with its "ask Claude", nothing drawn on the form.
  const report = {
    at: 1, filled: 12, checked: 3, holdsResume: true, sawUpload: true, readForm: true, steps: 1,
    written: [{ label: 'Why do you want to work at Becton Dickinson?', words: 92, problems: [], model: { used: 'opus' } }],
    unanswered: ['step 1: Date Last Used (no value in your profile)'], kept: [], stoppedBecause: 'reached the last step before Submit', armed: false,
  };
  const armed = { id: 'job-1', company: 'Becton Dickinson', started: true, acc: { filled: 12, checked: 3, uploaded: true, unanswered: report.unanswered, stoppedBecause: report.stoppedBecause } };
  await open({ armed, report, live: '' });
  await page.waitForFunction(() => !document.getElementById('answers').hidden);
  assert.equal(await page.isHidden('#resume'), true, 'a report with something to read opens its own tab');
  assert.equal(await page.textContent('#answers-count'), '2', 'the tab counts what needs him');
  const body = (await page.textContent('#answers-body')).replace(/\s+/g, ' ');
  assert.match(body, /12 filled · 3 ticked/);
  assert.match(body, /1 written for you — read it before Submit/);
  assert.match(body, /1 left for you/);
  assert.match(body, /Submit is yours/);
  assert.match(await page.textContent('#status'), /1 written for you · 1 left for you/, 'the one line under Fill says it too');

  // The leftover is asked about by its QUESTION, the engine's note stripped.
  await page.click('.jarvis-ask[data-i="0"]');
  await page.waitForFunction(() => /medical device/.test(document.querySelector('.jarvis-ask-out[data-i="0"]').textContent));
  const asked = sent.find((m) => m.type === 'panel-ask');
  assert.equal(asked.tabId, 7, 'for the tab beside the panel');
  assert.equal(asked.question, 'Date Last Used');

  // Put it in the box goes back to the page.
  await page.click('.jarvis-ask-out[data-i="0"] .jarvis-put');
  await page.waitForFunction(() => /in the box/.test(document.querySelector('.jarvis-ask-out[data-i="0"] .jarvis-said').textContent));
  const put = sent.find((m) => m.type === 'panel-put');
  assert.equal(put.tabId, 7);
  assert.match(put.text, /medical device/);

  // A later poll with the SAME report does not wipe the answer he is reading.
  await page.evaluate(() => globalThis.__jarvisPanel.refresh());
  await new Promise((r) => setTimeout(r, 200));
  assert.match(await page.textContent('.jarvis-ask-out[data-i="0"]'), /medical device/);
  await page.close();
});

test('THE PROGRESS LINE SHOWS UNDER FILL, not in the corner of the form', async () => {
  await open({ running: true, live: 'still writing the resume for Becton Dickinson · 0:30' });
  await page.waitForFunction(() => !document.getElementById('live').hidden);
  assert.match(await page.textContent('#live'), /still writing the resume/);
  assert.equal(await page.textContent('#fill'), 'Filling…');
  await page.close();
});
