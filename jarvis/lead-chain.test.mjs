import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityUrl, ACTIVITY_IDS } from './lead-chain.mjs';

test('a profile becomes its activity page; anything else is refused', () => {
  assert.equal(activityUrl('https://www.linkedin.com/in/riley/?isSelfProfile=false'), 'https://www.linkedin.com/in/riley/recent-activity/all/');
  assert.equal(activityUrl('https://www.linkedin.com/company/amazon'), '');
});

// LinkedIn's 2026 activity page names posts urn:li:share and urn:li:ugcPost,
// not urn:li:activity (Riley's page, 2026-10-05: 5 share, 2 ugcPost, 0 activity).
test('the page snippet lifts share, ugcPost and activity ids, and only reads', () => {
  const html = '<a href="/feed/update/urn:li:share:7501039202107357786/">x</a><div data-urn="urn:li:ugcPost:7249781009542883928"></div>urn:li:activity:7509330408847329882 urn:li:share:7501039202107357786';
  const doc = { documentElement: { outerHTML: html } };
  const ids = new Function('document', `return ${ACTIVITY_IDS}`)(doc).split(',');
  assert.deepEqual(ids.sort(), ['activity:7509330408847329882', 'share:7501039202107357786', 'ugcPost:7249781009542883928'].sort());
  assert.doesNotMatch(ACTIVITY_IDS, /\.click\(|scroll|dispatchEvent/);
});
