// R1: what a posting's own JSON-LD says beyond its title.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonLdSalary, closingCaution, locationFromExtras, employerSiteHost } from './posting-extras.mjs';

test('pay is annualised by schema.org\'s unit words and kept as structured pay', () => {
  assert.deepEqual(jsonLdSalary({ min: 80000, max: 100000, currency: 'USD', unit: 'YEAR' }), { min: 80000, max: 100000, currency: 'USD', interval: 'year', source: 'jsonld' });
  assert.deepEqual(jsonLdSalary({ min: 30, max: 40, currency: 'USD', unit: 'HOUR' }), { min: 62400, max: 83200, currency: 'USD', interval: 'year', source: 'jsonld' });
  assert.deepEqual(jsonLdSalary({ min: 7000, currency: 'USD', unit: 'MONTH' }), { min: 84000, max: 84000, currency: 'USD', interval: 'year', source: 'jsonld' }, 'one figure is both ends');
  assert.equal(jsonLdSalary({ min: 95000, max: 70000, unit: 'YEARS' }).min, 70000, 'ends in order; a plural unit reads');
  assert.equal(jsonLdSalary({ min: 90000, unit: 'YEAR', currency: 'dollars' }).currency, 'USD', 'an unreadable currency is not invented: USD only as the default');
});

test('pay that is not a plausible yearly figure is not kept', () => {
  assert.equal(jsonLdSalary({ min: 5, max: 9, unit: 'YEAR' }), null, 'too small to be a salary');
  assert.equal(jsonLdSalary({ min: 90000, unit: 'HOUR' }), null, 'an annual figure mislabelled hourly');
  assert.equal(jsonLdSalary({ min: 90000, unit: 'FORTNIGHT' }), null, 'an unknown unit');
  assert.equal(jsonLdSalary({ unit: 'YEAR' }), null);
  assert.equal(jsonLdSalary(null), null);
});

test('a closing date in the past is a caution, never a verdict', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.match(closingCaution('2026-11-03T00:00:00Z', now), /closed on 2026-11-03 .*nothing was retired/);
  assert.equal(closingCaution('2026-12-01', now), '', 'still open');
  assert.equal(closingCaution('soon', now), '');
  assert.equal(closingCaution(null, now), '');
});

test('a REMOTE posting with no location in its markup says Remote, with where applicants may live; an on-site one gets nothing', () => {
  assert.equal(locationFromExtras({ remote: true }), 'Remote');
  assert.equal(locationFromExtras({ remote: true, applicantLocations: ['United States'] }), 'Remote (United States)');
  assert.equal(locationFromExtras({ applicantLocations: ['Texas', 'Arizona'] }), '', 'where applicants may live is not where an on-site job is (review)');
  assert.equal(locationFromExtras({}), '');
});

test('an hourly rate is annualised only for a full-time job (review)', () => {
  assert.equal(jsonLdSalary({ min: 30, max: 40, unit: 'HOUR' }, 'INTERN'), null);
  assert.equal(jsonLdSalary({ min: 30, max: 40, unit: 'HOUR' }, ['PART_TIME']), null);
  assert.equal(jsonLdSalary({ min: 30, max: 40, unit: 'HOUR' }, 'CONTRACTOR'), null);
  assert.equal(jsonLdSalary({ min: 30, max: 40, unit: 'HOUR' }, 'TEMPORARY'), null);
  assert.equal(jsonLdSalary({ min: 30, max: 40, unit: 'HOUR' }, 'FULL_TIME').min, 62400);
  assert.equal(jsonLdSalary({ min: 90000, max: 100000, unit: 'YEAR' }, 'CONTRACTOR').min, 90000, 'a yearly figure is a yearly figure');
});

test("the employer's own site, never a social, aggregator or job-board page, nor the page's own host (review)", () => {
  assert.equal(employerSiteHost('https://www.linkedin.com/company/zeta-widgets', 'https://zeta.test/jobs/1'), '', 'LinkedIn names nobody');
  for (const site of ['https://facebook.com/zeta', 'https://x.com/zeta', 'https://www.glassdoor.com/Overview/zeta', 'https://www.crunchbase.com/organization/zeta', 'https://en.wikipedia.org/wiki/Zeta', 'https://www.indeed.com/cmp/zeta', 'https://boards.greenhouse.io/zeta', 'https://zeta.wd1.myworkdayjobs.com/x']) {
    assert.equal(employerSiteHost(site, 'https://careers.zeta.test/jobs/1'), '', site);
  }
  assert.equal(employerSiteHost('https://www.zetawidgets.com', 'https://jobs.lever.co/zetawidgets/1'), 'zetawidgets.com');
  assert.equal(employerSiteHost('https://zetawidgets.com/about', 'https://careers.zetawidgets.com/jobs/1'), '', "the page's own site was already asked");
  assert.equal(employerSiteHost('ftp://zetawidgets.com', ''), '');
  assert.equal(employerSiteHost('not a url', ''), '');
});
