// How a LinkedIn posting takes an application (linkedin-route.mjs, 2026-10-02).
import assert from 'node:assert/strict';
import { applyRoute, linkedInJobId, routeFor } from './linkedin-route.mjs';

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };
console.log('\n🧪 linkedin-route: Easy Apply or the company site');

// The button markup as the guest page served it, 2026-10-02.
const EASY = '<button class="apply-button apply-button--default top-card-layout__cta" data-tracking-control-name="public_jobs_apply-link-onsite">Easy Apply</button>';
const OFFSITE = '<button class="sign-up-modal__outlet top-card-layout__cta" data-tracking-control-name="public_jobs_apply-link-offsite_contextual-sign-in-modal_join-link">Apply<icon class="apply-button__offsite-apply-icon-svg"></icon></button>';
const CLOSED = '<figure class="closed-job"><figcaption>No longer accepting applications</figcaption></figure>';

ok('KUKA\'s on-site button is Easy Apply', () => assert.equal(applyRoute(EASY), 'easy-apply'));
ok('ANDRITZ\'s off-site button is the company site', () => assert.equal(applyRoute(OFFSITE), 'offsite'));
ok('a closed posting is closed, never Easy Apply', () => assert.equal(applyRoute(CLOSED), 'closed'));
ok('a live page with no button drawn (Photronics, signed out) is unknown', () => assert.equal(applyRoute('<div class="top-card-layout__cta-container"></div>'), null));
ok('an empty page is unknown', () => assert.equal(applyRoute(''), null));

ok('the posting id is read from a view URL, a slug with dashes and a currentJobId', () => {
  assert.equal(linkedInJobId('https://www.linkedin.com/jobs/view/jr-mobility-engineer-at-kuka-4467250791'), '4467250791');
  assert.equal(linkedInJobId('https://www.linkedin.com/jobs/view/4467250791/'), '4467250791');
  assert.equal(linkedInJobId('https://www.linkedin.com/jobs/view/entry-level-r-d-engineer-job-%231154-at-enstrom-4471686221'), '4471686221');
  assert.equal(linkedInJobId('https://www.linkedin.com/jobs/search/?currentJobId=4469181165&keywords=x'), '4469181165');
  assert.equal(linkedInJobId('https://job-boards.greenhouse.io/x/jobs/4386510009'), null, 'not LinkedIn');
});

const asked = [];
const fake = (body, status = 200) => async (u) => { asked.push(u); return { ok: status === 200, status, text: async () => body }; };
const viaGuest = await routeFor('https://www.linkedin.com/jobs/view/x-at-kuka-4467250791', { fetchImpl: fake(EASY) });
ok('routeFor asks the guest posting page', () => {
  assert.equal(viaGuest, 'easy-apply');
  assert.equal(asked[0], 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4467250791');
});
const refused = await routeFor('https://www.linkedin.com/jobs/view/x-4467250791', { fetchImpl: fake('', 429) });
const offline = await routeFor('https://www.linkedin.com/jobs/view/x-4467250791', { fetchImpl: async () => { throw new Error('offline'); } });
const notLi = await routeFor('https://example.com/jobs/1', { fetchImpl: fake(EASY) });
ok('a refused or failed fetch is unknown, not Easy Apply', () => assert.deepEqual([refused, offline, notLi], [null, null, null]));

console.log(`\n${pass} passed`);
