// Tests for the page-error log: what a form said back in red (2026-10-02).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { pageErrorRow, logPageErrors, readPageErrors, formatPageErrors, platformOf, unseenByPlatform } from './page-errors.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };
console.log('\n🧪 page-errors: the form\'s own words, kept');

const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'page-errors-')), 'page-errors.jsonl');
const job = { id: 'abc', company: 'Spirit AeroSystems', title: 'Manufacturing Engineer' };

ok('a report is kept with its job, trigger and each message', () => {
  const n = logPageErrors({ pageUrl: 'https://spiritaero.icims.com/jobs/1/apply', trigger: 'after your press of "Next"', heading: 'Apply', job,
    errors: [{ text: 'Please select a city from the list', how: 'red', field: 'City', color: 'rgb(198, 40, 40)' }, { text: 'Enter a valid phone number', how: 'invalid', field: 'Phone' }] }, { file });
  assert.equal(n, 2);
  const [row] = readPageErrors({ file });
  assert.equal(row.job.company, 'Spirit AeroSystems');
  assert.equal(row.errors[0].field, 'City');
  assert.equal(row.errors[1].how, 'invalid');
});

ok('a fixture page on this machine is never logged (F-631)', () => {
  assert.equal(logPageErrors({ pageUrl: 'http://localhost:4300/__jarvis_fixture_x', errors: [{ text: 'Required', how: 'red' }] }, { file }), 0);
  assert.equal(readPageErrors({ file }).length, 1);
});

ok('a report with no message in it is not a row', () => {
  assert.equal(pageErrorRow({ pageUrl: 'https://x.com', errors: [{ text: '   ' }] }), null);
  assert.equal(logPageErrors({ pageUrl: 'https://x.com', errors: [] }, { file }), 0);
});

ok('an unknown "how" is read as red, and long text is cut', () => {
  const row = pageErrorRow({ pageUrl: 'https://x.com', errors: [{ text: 'x'.repeat(900), how: 'banner' }] });
  assert.equal(row.errors[0].how, 'red');
  assert.equal(row.errors[0].text.length, 300);
});

ok('reading filters by company and by pattern', () => {
  logPageErrors({ pageUrl: 'https://mycronicusa.applicantpro.com/apply', job: { id: 'm', company: 'Mycronic', title: 'ME' },
    errors: [{ text: 'File type not supported', how: 'alert' }] }, { file });
  assert.equal(readPageErrors({ file, company: 'mycronic' }).length, 1);
  assert.equal(readPageErrors({ file, grep: 'phone' }).length, 1);
  assert.equal(readPageErrors({ file, grep: 'nothing-like-this' }).length, 0);
});

ok('the printout names the job, the press and each message under its field', () => {
  const text = formatPageErrors(readPageErrors({ file, company: 'spirit' }));
  assert.match(text, /Spirit AeroSystems · Manufacturing Engineer/);
  assert.match(text, /after your press of "Next"/);
  assert.match(text, /\[red\] City: Please select a city from the list/);
  assert.equal(formatPageErrors([]), 'No page errors logged for that.');
});

ok('a missing log reads as empty', () => {
  assert.deepEqual(readPageErrors({ file: path.join(path.dirname(file), 'none.jsonl') }), []);
  assert.ok(existsSync(file) && readFileSync(file, 'utf-8').trim().split('\n').length === 2);
});

ok('unseen questions are kept and grouped by platform, then question (2026-10-03)', () => {
  assert.equal(pageErrorRow({ pageUrl: 'https://x', errors: [{ text: 'Are you in F-1 status?', how: 'unseen' }] }).errors[0].how, 'unseen');
  assert.equal(platformOf('https://hcwt.fa.us2.oraclecloud.com/hcmUI/x'), 'Oracle Recruiting Cloud');
  assert.equal(platformOf('https://amat.wd1.myworkdayjobs.com/x'), 'Workday');
  const rows = [
    { pageUrl: 'https://hcwt.fa.us2.oraclecloud.com/a', job: { company: 'DENSO' }, errors: [{ text: 'Title', how: 'unseen', field: 'input[radio]' }, { text: 'red thing', how: 'red' }] },
    { pageUrl: 'https://ekpl.fa.us6.oraclecloud.com/b', job: { company: 'Cummins' }, errors: [{ text: 'Title', how: 'unseen', field: 'input[radio]' }] },
    { pageUrl: 'https://amat.wd1.myworkdayjobs.com/c', job: { company: 'Applied Materials' }, errors: [{ text: 'Reading', how: 'unseen', field: 'button' }] },
  ];
  const g = unseenByPlatform(rows);
  assert.equal(g[0].platform, 'Oracle Recruiting Cloud');
  assert.equal(g[0].questions[0].count, 2);
  assert.deepEqual(g[0].questions[0].companies, ['DENSO', 'Cummins']);
  assert.equal(g.flatMap((x) => x.questions).length, 2, 'red messages are not unseen questions');
});

console.log(`\n${pass} passed`);
