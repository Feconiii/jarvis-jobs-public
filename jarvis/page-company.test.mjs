// Which employer and role an apply page's URL names (F-630).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { pageCompanyKeys, pageTitleHints, tabOrPage, titleParts, employerKey, sameEmployer, namesEmployer } from './page-company.mjs';

const APPLIED_MEDICAL = 'https://engineering-appliedmedical.icims.com/jobs/14341/machine-design-engineer%2c-automation/candidate?from=login&eem=x&code=y';

test('iCIMS: the employer is in the subdomain, not the path ("jobs")', () => {
  const keys = pageCompanyKeys(APPLIED_MEDICAL);
  assert.ok(keys.includes('appliedmedical'), keys.join(','));
  assert.ok(!keys.includes('jobs'));
  assert.ok(!keys.includes('engineering'));
});

test('iCIMS: careers-<company> and a bare <company> label', () => {
  assert.ok(pageCompanyKeys('https://careers-appliedmedical.icims.com/jobs/1/x/job').includes('appliedmedical'));
  assert.ok(pageCompanyKeys('https://uscareers-teradyne.icims.com/jobs/1/x/job').includes('teradyne'));
  assert.ok(pageCompanyKeys('https://zebra.icims.com/jobs/1/x/job').includes('zebra'));
});

test('Lever and Greenhouse keep reading the board slug', () => {
  assert.deepEqual(pageCompanyKeys('https://jobs.lever.co/PhoenixTailings/abc-123/apply'), ['phoenixtailings']);
  assert.deepEqual(pageCompanyKeys('https://job-boards.greenhouse.io/agilityrobotics/jobs/123'), ['agilityrobotics']);
});

test('Workday: <company>.wd5.myworkdayjobs.com/External', () => {
  const keys = pageCompanyKeys('https://solarturbines.wd5.myworkdayjobs.com/en-US/External/job/San-Diego/Engineer_R1');
  assert.ok(keys.includes('solarturbines'), keys.join(','));
  assert.ok(!keys.includes('external'));
});

test('a URL made only of filler names no employer', () => {
  assert.deepEqual(pageCompanyKeys('https://careers.example.com/jobs/1'), []);
  assert.deepEqual(pageCompanyKeys('https://jobs.lever.co/'), []);
  assert.deepEqual(pageCompanyKeys('not a url'), []);
});

test('iCIMS: the role is read from the URL, on the candidate page too', () => {
  assert.deepEqual(pageTitleHints(APPLIED_MEDICAL), ['machine design engineer, automation']);
  assert.deepEqual(pageTitleHints('https://careers-x.icims.com/jobs/14341/login'), []);
  assert.deepEqual(pageTitleHints('https://jobs.lever.co/PhoenixTailings/abc/apply'), []);
});

test('F-633 Lab37: the page\'s own posting wins over the look-alike the tab was opened for', () => {
  const opened = { id: 'e5e0', company: 'Lab37', title: 'Mechanical Design Engineer', url: 'https://job-boards.greenhouse.io/lab37/jobs/8557049002' };
  const shown = { id: '5be9', company: 'Lab37', title: 'Mechanical Design Engineer', url: 'https://job-boards.greenhouse.io/lab37/jobs/8328619002' };
  assert.equal(tabOrPage(opened, shown, 'https://job-boards.greenhouse.io/lab37/jobs/8328619002?gh_src=H6asVO'), 'page');
  assert.equal(tabOrPage(opened, shown, 'https://job-boards.greenhouse.io/lab37/jobs/8328619002/confirmation?gh_src=H6asVO'), 'page', 'the confirmation page marks the posting it confirms');
});

test('F-633 Intel stands: a look-alike matched only by its heading does not take the tab', () => {
  const opened = { id: 'phx', company: 'Intel', title: 'Module Engineer', url: 'https://intel.wd1.myworkdayjobs.com/External/job/Phoenix/Module-Engineer_JR0286648' };
  const penang = { id: 'pen', company: 'Intel', title: 'Module Engineer', url: 'https://intel.wd1.myworkdayjobs.com/External/job/Penang/Module-Engineer_JR0281111' };
  assert.equal(tabOrPage(opened, penang, 'https://intel.wd1.myworkdayjobs.com/External/job/Phoenix/Module-Engineer_JR0286648/apply/applyManually'), 'tab');
  assert.equal(tabOrPage(opened, { ...penang, title: 'Process Engineer' }, 'https://intel.wd1.myworkdayjobs.com/x'), 'page', 'a different job on the page is the page');
  assert.equal(tabOrPage(null, penang, 'https://x'), 'page');
  assert.equal(tabOrPage(opened, null, 'https://x'), 'tab');
});

test('serve.mjs finds a LinkedIn copy through these, not the first path segment', () => {
  const src = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf-8');
  assert.match(src, /import \{ pageCompanyKeys, pageTitleHints, tabOrPage, titleParts, employerKey, sameEmployer, namesEmployer \} from '\.\/page-company\.mjs';/);
  assert.match(src, /keys\.some\(\(k\) => sameEmployer\(k, row\.company\)\)/, 'the Eightfold lookup asks sameEmployer (F-726)');
  assert.match(src, /tabOrPage\(remembered, onPage, page\.pageUrl\) === 'tab'/, 'jobForRequest asks tabOrPage');
  assert.match(src, /function findLinkedInCopy\(pageUrl, headings\)/);
  assert.match(src, /new Set\(\[\.\.\.pageCompanyKeys\(pageUrl\), \.\.\.named\.map/);
  assert.match(src, /findLinkedInCopy\(pageUrl, linkHeads\)/);
});

test('A FORM WHOSE URL NAMES NO EMPLOYER IS NAMED BY ITS TITLE (Paylocity, Optomec, F-691)', () => {
  assert.deepEqual(pageCompanyKeys('https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4554622'), [], 'the URL alone names nobody');
  assert.deepEqual(titleParts(['Optomec Inc. - Mechanical Engineer Application']), [{ company: 'optomec', role: 'Mechanical Engineer' }]);
  assert.equal(employerKey('Optomec Inc.'), employerKey('Optomec'));
  assert.equal(employerKey('Acme, LLC'), 'acme');
  assert.deepEqual(titleParts(['Apply with resume']), [], 'a heading with no employer in it yields nothing');
});

test('sameEmployer: a blank or one-letter company names no employer (F-726)', async () => {
  const { sameEmployer } = await import('./page-company.mjs');
  assert.equal(sameEmployer('appliedmaterials', 'Applied Materials Inc'), true);
  assert.equal(sameEmployer('lamresearch', 'Lam Research'), true);
  assert.equal(sameEmployer('amd', 'AMD'), true);
  assert.equal(sameEmployer('appliedmaterials', 'Applied'), true, 'a shortened real name');
  assert.equal(sameEmployer('appliedmaterials', ''), false, 'a manual or LinkedIn row with no company');
  assert.equal(sameEmployer('appliedmaterials', 'A'), false);
  assert.equal(sameEmployer('appliedmaterials', 'App'), false, 'too short to be the employer');
  assert.equal(sameEmployer('appliedmaterials', 'Applied Medical'), false);
  assert.equal(sameEmployer('', 'Anything'), false);
});

// F-1023 (2026-11-06, "not a posting???"): GeekPlus's own MokaHR form for the "Geek+" row he had in his Inbox.
test('a MokaHR address names its employer in the second path segment', () => {
  const keys = pageCompanyKeys('https://hire-r1.mokahr.com/social-recruitment/geekplusamerica/100008811#/job/e4b8f198-b824-4c20-8cad-b157f2b552f7/apply');
  assert.deepEqual(keys, ['geekplusamerica']);
});

test('"+" is "plus" and a trailing region goes: Geek+ is geekplusamerica', () => {
  assert.equal(namesEmployer('geekplusamerica', 'Geek+'), true);
  assert.equal(namesEmployer('geekplus', 'GeekPlus America'), false, 'the company side keeps its words');
  assert.equal(sameEmployer('geekplusamerica', 'Geek+'), true);
  assert.equal(sameEmployer('siemensusa', 'Siemens'), true);
});

test('two employers that share a word never match', () => {
  assert.equal(namesEmployer('bankofamerica', 'Bank of the West'), false, 'the regionless key is exact, never a prefix');
  assert.equal(sameEmployer('bankofamerica', 'Bank of the West'), false);
  assert.equal(sameEmployer('appliedmedical', 'Applied Materials'), false);
  assert.equal(namesEmployer('appliedmedical', 'Applied Materials'), false);
  assert.equal(namesEmployer('americanairlines', 'American Express'), false);
});
