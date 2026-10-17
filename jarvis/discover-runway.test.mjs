// Tests for discover-runway.mjs. The fixtures are cut from Runway's real pages
// (2026-10-07): a Starbucks shift-supervisor page and its sitemap ids.

import { idTime, parseTitle, parsePosting, sameJob, isUS } from './discover-runway.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 runway: ids are time-ordered');
{
  check('a cuid carries its creation time', new Date(idTime('cmuxl1pqr0013bl1dfsavn9ch')).toISOString(), '2026-10-07T04:03:35.955Z');
  check('…so a newer id sorts later', idTime('cmuxl1pqr0013bl1dfsavn9ch') > idTime('cmuxkzdq60002680j8171es4g'), true);
  check('something else is no time at all', Number.isNaN(idTime('JOB_POSTING')), true);
}

console.log('\n🧪 runway: the page');
{
  check('title and employer from <title>', parseTitle('<head><title>Process Engineer Intern (Jan-May 2027) @ TTM Technologies | Runway</title>'),
    { title: 'Process Engineer Intern (Jan-May 2027)', company: 'TTM Technologies' });
  check('an "@" inside the job title stays in the title', parseTitle('<title>Engineer @ Plant 4 @ Oshkosh Corporation | Runway</title>'),
    { title: 'Engineer @ Plant 4', company: 'Oshkosh Corporation' });
  check('entities are decoded', parseTitle('<title>R&amp;D Engineer @ Dr. Pepper &amp; Co | Runway</title>')?.company, 'Dr. Pepper & Co');
  check('not a Runway job page', parseTitle('<title>Sign in</title>'), null);

  const html = '<title>shift supervisor @ Starbucks | Runway</title>'
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"shift supervisor","datePosted":"2026-10-05T04:00:00.000Z",'
    + '"hiringOrganization":{"@type":"Organization","name":"Starbucks","sameAs":"starbucks.com","logo":"https://cdn.joinrunway.io/logo/starbucks.com.jpg"},'
    + '"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressCountry":"United States","addressRegion":"Illinois"}}}</script>'
    + '<script src="https://www.googletagmanager.com/gtm.js?id=X"></script><a href="http://www.starbucks.com/careers">x</a>'
    + '"applyUrl":"https://apply.starbucks.com/careers/job/481081162208-shift-supervisor\\"';
  const p = parsePosting(html);
  check('the employer and its own domain', [p.company, p.domain], ['Starbucks', 'starbucks.com']);
  check('the country and the date', [p.country, p.posted.slice(0, 10)], ['United States', '2026-10-05']);
  check('the apply link is the employer\'s, not a tracker\'s', p.apply.startsWith('http://www.starbucks.com/careers') || p.apply.startsWith('https://apply.starbucks.com'), true);
  check('a page with no JobPosting gives nothing', parsePosting('<script type="application/ld+json">{"@type":"Organization"}</script>'), null);
  check('US is US', [isUS('United States'), isUS('USA'), isUS('Canada')], [true, true, false]);
}

console.log('\n🧪 runway: the same job under two titles');
{
  check('the store keeps the longer title', sameJob('2026 Process Engineer Co-op - Adv Degree', '2026 Process Engineer Co Op Adv Degree Gloucester Ma'), true);
  check('…a location in the middle is fine', sameJob('Intern –Systems Engineering, Oral Healthcare - Summer 2027', 'Intern –Systems Engineering, Oral Healthcare – Bothell, WA – Summer 2027'), true);
  check('a different discipline is a different job', sameJob('Engineer Intern - Mechanical (Summer 2027)', 'Engineer Intern - Industrial (Summer 2027)'), false);
  check('Test Engineer I is not Test Engineer II', sameJob('Test Engineer I', 'Test Engineer II'), false);
  check('one word never matches a long title', sameJob('Engineer', 'Senior Mechanical Engineer'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
