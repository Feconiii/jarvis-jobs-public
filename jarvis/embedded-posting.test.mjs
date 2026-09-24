// Tests for postings read out of a careers page's own data. The fixtures are
// built in the exact shape Apple and Google served on 2026-09-20.

import { applePosting, googlePosting, embeddedPosting } from './embedded-posting.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const applePage = (job) => {
  const inner = JSON.stringify({ loaderData: { jobDetails: { jobsData: job } } });
  return `<html><script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(inner)});</script></html>`;
};
const APPLE = {
  postingTitle: 'Advanced Manufacturing Engineer',
  jobSummary: 'Imagine what you can do here.',
  description: 'Work closely with engineering teams through product development.',
  minimumQualifications: "Bachelor's degree in Mechanical Engineering",
  preferredQualifications: 'N/A',
  postDateInGMT: '2026-09-17T15:56:16.574+00:00',
  teamNames: ['Operations and Supply Chain'],
  locations: [{ name: 'Cupertino', city: 'Cupertino', stateProvince: 'California', countryName: 'United States' }],
};

console.log('\n🧪 embedded-posting: Apple');
{
  const jp = applePosting(applePage(APPLE));
  check('title', jp.title, 'Advanced Manufacturing Engineer');
  check('the qualifications are in the body, where the degree check reads them', /Minimum Qualifications<\/h3><p>Bachelor's degree in Mechanical Engineering/.test(jp.description), true);
  check('an "N/A" section is left out, not printed', /Preferred Qualifications/.test(jp.description), false);
  check('team', jp.occupationalCategory, 'Operations and Supply Chain');
  check('location, schema.org-shaped', jp.jobLocation[0].address, { '@type': 'PostalAddress', addressLocality: 'Cupertino', addressRegion: 'California', addressCountry: 'United States' });
  check('posted date', jp.datePosted, '2026-09-17T15:56:16.574+00:00');
  check('a record with no text at all is not a posting', applePosting(applePage({ postingTitle: 'X' })), null);
  check('a page without the data is null', applePosting('<html></html>'), null);
  check('broken data is null, not a throw', applePosting('<script>window.__staticRouterHydrationData = JSON.parse("{oops");</script>'), null);
}

const googlePage = (rows) => `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify([[['1', 'Similar job', 'url']]])}, sideChannel: {}});</script>`
  + `<script>AF_initDataCallback({key: 'ds:0', hash: '1', data:${JSON.stringify([rows])}, sideChannel: {}});</script>`;
const ROW = ['96671508889248454', 'Mechanical Engineer, Robotics, DeepMind', 'https://signin', [null, '<ul><li>Design actuators</li></ul>'],
  [null, "<h3>Minimum qualifications:</h3><ul><li>Bachelor's degree in Mechanical Engineering</li></ul>"], 'projects/x', null, 'DeepMind', 'en-US',
  [['Cambridge, MA, USA', ['355 Main St'], 'Cambridge', '02142', 'MA', 'US']], [null, '<p>Build components for advanced robots.</p>']];

console.log('\n🧪 embedded-posting: Google');
{
  const jp = googlePosting(googlePage(ROW));
  // The sitemap slug gave this row the title "Mechanical Engineer" and no place.
  check('the real title, not the slug', jp.title, 'Mechanical Engineer, Robotics, DeepMind');
  check('organisation', jp.occupationalCategory, 'DeepMind');
  check('location', jp.jobLocation[0].address.addressLocality + ', ' + jp.jobLocation[0].address.addressRegion, 'Cambridge, MA');
  check('about, responsibilities and qualifications are all in the body',
    [/advanced robots/, /Design actuators/, /Bachelor's degree in Mechanical/].every(r => r.test(jp.description)), true);
  check('the "similar jobs" list beside it is never mistaken for the posting', jp.title === 'Similar job', false);
  // A positional format can move. If it does, say nothing rather than guess.
  check('an id that is not an id is refused', googlePosting(googlePage(['not-an-id', 'Title', '', [null, '<p>x</p>']])), null);
  check('a record with no bodies is refused', googlePosting(googlePage(['96671508889248454', 'Title', ''])), null);
  check('a page without the callback is null', googlePosting('<html></html>'), null);
}

console.log('\n🧪 embedded-posting: the dispatcher');
{
  check('Apple page → Apple reader', embeddedPosting(applePage(APPLE)).title, 'Advanced Manufacturing Engineer');
  check('Google page → Google reader', embeddedPosting(googlePage(ROW)).title, 'Mechanical Engineer, Robotics, DeepMind');
  check('anything else → null', embeddedPosting('<html><body>Careers</body></html>'), null);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
