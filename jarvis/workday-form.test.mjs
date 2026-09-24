#!/usr/bin/env node
// jarvis/workday-form.test.mjs — DOM guards for the Workday step reader.
//
// The rest of the suite is pure-data (triage, answers, options, resumes). These
// two functions are the only hot-path Workday code that can be tested without a
// live tenant, and they are exactly the code that got rewritten for speed:
//
//   fieldManifest    — was two page.evaluate()s PER FIELD, now one per step.
//                      A wrong `kind` here is not a slow application, it is a
//                      job title typed into a dropdown, so every widget shape
//                      Workday renders gets a case below.
//   settledFieldIds  — was a 400ms sleep-poll, now settles inside the renderer.
//                      The regression it must not have is returning while the
//                      step is still painting: Workday advances steps WITHOUT a
//                      page load, so a stale sample from the previous step could
//                      match the new one on the first look.
//
// Runs headless against a fixture; no network, no ATS, no profile data.

import { chromium } from 'playwright';
import { fieldManifest, settledFieldIds } from './apply/workday.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// One container per widget shape Workday actually renders, with the markers the
// kind-detector keys on. Order matters only in that the manifest preserves it.
const FIXTURE = `<body>
  <div data-automation-id="formField-legalName--firstName">
    <label>First Name*</label><input type="text">
  </div>
  <div data-automation-id="formField-candidateIsPreviousWorker">
    <label>Have you worked here before?</label>
    <label><input type="radio" name="p" value="Yes">Yes</label>
    <label><input type="radio" name="p" value="No">No</label>
  </div>
  <div data-automation-id="formField-agreementAccepted">
    <label>I certify the above is accurate</label><input type="checkbox">
  </div>
  <div data-automation-id="formField-signatureDate">
    <label>Date</label>
    <div data-automation-id="dateInputWrapper">
      <input data-automation-id="dateSectionMonth-input">
      <input data-automation-id="dateSectionDay-input">
      <input data-automation-id="dateSectionYear-input">
    </div>
  </div>
  <div data-automation-id="formField-countryRegion">
    <label>State*</label>
    <input type="text"><span data-automation-id="promptIcon"></span>
  </div>
  <div data-automation-id="formField-source">
    <label>How Did You Hear About Us?*</label>
    <div data-automation-id="multiSelectContainer"><input type="text"></div>
  </div>
  <div data-automation-id="formField-degree">
    <label>Degree</label><button aria-haspopup="listbox">Select One</button>
  </div>
  <div data-automation-id="formField-phoneType">
    <legend>Phone Device Type</legend>
    <button aria-haspopup="true">Select One</button>
  </div>
</body>`;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log('\n🧪 workday: field manifest reads every widget shape');
await page.setContent(FIXTURE);
const ids = await settledFieldIds(page);
const got = await fieldManifest(page, ids);

eq('every formField- container is found, in DOM order', ids, [
  'formField-legalName--firstName', 'formField-candidateIsPreviousWorker',
  'formField-agreementAccepted', 'formField-signatureDate', 'formField-countryRegion',
  'formField-source', 'formField-degree', 'formField-phoneType',
]);

const kinds = Object.fromEntries(got.map((f) => [f.fid.replace('formField-', ''), f.kind]));
eq('plain input → text', kinds['legalName--firstName'], 'text');
eq('radio group → radio', kinds.candidateIsPreviousWorker, 'radio');
eq('checkbox → checkbox', kinds.agreementAccepted, 'checkbox');
eq('segmented MM/DD/YYYY → date, never text', kinds.signatureDate, 'date');
// The one that has bitten this adapter before: a prompt WITH a text input is
// still a prompt. Typing into it instead of driving the listbox leaves the
// required field empty while the run reports it filled.
eq('promptIcon beside a text input → prompt, not text', kinds.countryRegion, 'prompt');
eq('multiSelectContainer → prompt', kinds.source, 'prompt');
eq('button[aria-haspopup=listbox] → prompt', kinds.degree, 'prompt');
eq('bare aria-haspopup button with no input → prompt', kinds.phoneType, 'prompt');

console.log('\n🧪 workday: labels come back clean');
const labels = Object.fromEntries(got.map((f) => [f.fid.replace('formField-', ''), f.label]));
eq('required asterisk stripped', labels['legalName--firstName'], 'First Name');
eq('legend counts as a label', labels.phoneType, 'Phone Device Type');
eq('question text preserved', labels.source, 'How Did You Hear About Us?');

console.log('\n🧪 workday: a field that vanished mid-read degrades, never throws');
eq('missing container → text with no label', await fieldManifest(page, ['formField-gone']),
  [{ fid: 'formField-gone', label: '', kind: 'text' }]);

console.log('\n🧪 workday: settle waits for a step that is still painting');
// Workday paints My Information in chunks. Returning after the first chunk is
// what made late fields never fill AND never report — a clean-looking run with
// a required field left empty.
await page.setContent('<body><div data-automation-id="formField-a"><label>A</label><input></div></body>');
await page.evaluate(() => {
  setTimeout(() => {
    const d = document.createElement('div');
    d.setAttribute('data-automation-id', 'formField-late');
    d.innerHTML = '<label>Late</label><input>';
    document.body.appendChild(d);
  }, 350);
});
eq('late-rendered field is included', (await settledFieldIds(page)).includes('formField-late'), true);

// Same count as the previous step, different fields: the in-page marker must be
// cleared per call or this returns on its first sample, mid-paint.
console.log('\n🧪 workday: a new step with the same field count still settles');
await page.setContent('<body><div data-automation-id="formField-x"><label>X</label><input></div></body>');
await page.evaluate(() => {
  setTimeout(() => {
    const d = document.createElement('div');
    d.setAttribute('data-automation-id', 'formField-y');
    d.innerHTML = '<label>Y</label><input>';
    document.body.appendChild(d);
  }, 300);
});
eq('does not return the half-painted step', (await settledFieldIds(page)).sort(),
  ['formField-x', 'formField-y']);

await browser.close();
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
