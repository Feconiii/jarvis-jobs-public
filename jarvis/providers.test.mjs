#!/usr/bin/env node
// jarvis/providers.test.mjs — the three ATS platforms added 2026-08-20.
//
// Phenom, SuccessFactors and iCIMS between them cover the employers that were
// invisible: the industrial automation layer, the medtech tier, and every
// "jobs.<company>.com" site in the Fortune 500. These tests pin the parsing
// against payload shapes captured from the live endpoints, because the failure
// that matters here is not a crash — it is a posting that parses into the store
// with the wrong location and gets bucketed out of view.
//
// Run: node jarvis/providers.test.mjs

import phenom, { parsePhenomResponse, totalHits } from '../providers/phenom.mjs';
import sf, { parseSuccessFactorsFeed, splitTitleLocation, htmlToPlain } from '../providers/successfactors.mjs';
import icims, { parseIcimsSitemap, titleFromSlug } from '../providers/icims.mjs';
import { parseSmartRecruitersResponse } from '../providers/smartrecruiters.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import lever, { leverBody } from '../providers/lever.mjs';
import icimsCareers from '../providers/icims-careers.mjs';
import { htmlToText } from './text.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  cond ? pass++ : fail++;
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

console.log('\n🧪 Phenom: the shape jobs.thermofisher.com actually returns');
{
  const payload = {
    refineSearch: {
      totalHits: 3244,
      data: {
        jobs: [{
          title: 'Manufacturing Engineer II',
          jobId: 'R-01337204',
          jobSeqNo: 'TFSCGLOBAL123',
          city: 'Carlsbad', state: 'California', country: 'United States',
          cityStateCountry: 'Carlsbad, California, United States',
          category: 'Manufacturing',
          postedDate: '2026-08-09T00:00:00.000+0000',
          descriptionTeaser: 'Own process development for instrument assembly.',
          applyUrl: 'https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Carlsbad/Manufacturing-Engineer-II_R-01337204/apply',
        }],
      },
    },
  };
  const [j] = parsePhenomResponse(payload, 'jobs.thermofisher.com', 'Thermo Fisher Scientific');
  eq('title', j.title, 'Manufacturing Engineer II');
  eq('location prefers the assembled cityStateCountry', j.location, 'Carlsbad, California, United States');
  eq('category becomes the team label', j.team, 'Manufacturing');
  ok('postedAt is epoch ms', j.postedAt === Date.parse('2026-08-09T00:00:00.000+0000'));
  // Phenom is often only the shop window: keeping the Workday applyUrl is what
  // lets the apply engine drive the form instead of stopping at a brochure page.
  eq('the real ATS url survives, without the /apply suffix', j.url,
    'https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Carlsbad/Manufacturing-Engineer-II_R-01337204');
  eq('totalHits is read for pagination', totalHits(payload), 3244);

  eq('a response with no jobs key is empty, not a crash', parsePhenomResponse({}, 'h', 'C'), []);
  const noApply = parsePhenomResponse({ refineSearch: { data: { jobs: [
    { title: 'Test Engineer', jobSeqNo: 'X1', city: 'Austin', state: 'Texas', country: 'United States' },
  ] } } }, 'jobs.example.com', 'Example');
  ok('a posting with no applyUrl still gets a usable url', noApply[0].url.startsWith('https://jobs.example.com/us/en/job/X1/'));
  eq('a posting with neither title nor url is dropped',
    parsePhenomResponse({ refineSearch: { data: { jobs: [{ city: 'Austin' }] } } }, 'h', 'C'), []);
  eq('provider id', phenom.id, 'phenom');
}

console.log('\n🧪 SuccessFactors: location lives inside the title');
{
  // The bucket a posting lands in is decided by its location field. A title
  // reading "Group Leader (Beauvais, FR)" whose location is empty buckets as
  // 'unknown' and shows up in a US-only list — the exact direction of error
  // the location work was done to stop.
  eq('a US location is split out', splitTitleLocation('Quality Technician (Jackson, MN, US)'),
    { title: 'Quality Technician', location: 'Jackson, MN, US' });
  eq('a foreign location is split out too', splitTitleLocation('Group Leader (Beauvais, FR)'),
    { title: 'Group Leader', location: 'Beauvais, FR' });
  eq('Remote counts as a location', splitTitleLocation('Staff Engineer (Remote)'),
    { title: 'Staff Engineer', location: 'Remote' });
  // Not every parenthetical is a place.
  eq('a German gender tag is not a location', splitTitleLocation('Ingenieur (m/f/d)'),
    { title: 'Ingenieur (m/f/d)', location: '' });
  eq('a shift qualifier is not a location', splitTitleLocation('Machinist (2nd Shift)'),
    { title: 'Machinist (2nd Shift)', location: '' });
  eq('a title with no parenthetical is untouched', splitTitleLocation('Process Engineer'),
    { title: 'Process Engineer', location: '' });

  ok('html is flattened to readable text',
    htmlToPlain('<p>Job <b>Summary</b></p><br><li>SolidWorks</li>').includes('Job Summary'));

  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Quality Technician (Jackson, MN, US)</title>
      <description><![CDATA[&lt;p&gt;Support production quality.&lt;/p&gt;]]></description>
      <link>https://careers.agcocorp.com/job/Jackson-Quality-Technician-MN/1238657100/</link>
      <g:job_function>Manufacturing</g:job_function>
    </item>
    <item>
      <title>Regional Sales Rep (Vincennes, IN, US)</title>
      <description><![CDATA[Sell things.]]></description>
      <link>https://careers.agcocorp.com/job/Vincennes-Sales/1389184700/</link>
    </item>
    <item><title>Broken, no link</title></item>
  </channel></rss>`;
  const jobs = parseSuccessFactorsFeed(xml, 'AGCO');
  eq('both real postings parse', jobs.length, 2);
  eq('title is clean', jobs[0].title, 'Quality Technician');
  eq('location is populated', jobs[0].location, 'Jackson, MN, US');
  eq('job function becomes the team', jobs[0].team, 'Manufacturing');
  ok('the full description rides along, so no enrichment pass is needed',
    jobs[0].description.includes('Support production quality'));
  ok('an item with no link is skipped', !jobs.some(j => j.title === 'Broken, no link'));
  eq('provider id', sf.id, 'successfactors');
}

console.log('\n🧪 iCIMS: the sitemap is the only ungated source');
{
  eq('a slug becomes a title', titleFromSlug('system-safety-engineer'), 'System Safety Engineer');
  eq('a triple dash was a real dash', titleFromSlug('manufacturing-engineer---motors'), 'Manufacturing Engineer — Motors');
  eq('small words stay small', titleFromSlug('director-of-quality'), 'Director of Quality');
  eq('known acronyms stay upper', titleFromSlug('npi-engineer-ii'), 'NPI Engineer II');

  const xml = `<?xml version='1.0' encoding='utf-8'?><urlset>
    <url><loc>https://careers-jobyaviation.icims.com/jobs/intro</loc></url>
    <url><loc>https://careers-jobyaviation.icims.com/jobs/5331/system-safety-engineer/job</loc><lastmod>2026-08-20T18:49:29-04:00</lastmod></url>
    <url><loc>https://careers-jobyaviation.icims.com/jobs/5302/manufacturing-engineer---motors/job</loc><lastmod>2026-08-20T16:55:43-04:00</lastmod></url>
    <url><loc>https://careers-jobyaviation.icims.com/jobs/5302/manufacturing-engineer---motors/job</loc></url>
  </urlset>`;
  const jobs = parseIcimsSitemap(xml, 'Joby Aviation');
  eq('only real postings, deduped', jobs.length, 2);
  eq('title comes from the slug', jobs[1].title, 'Manufacturing Engineer — Motors');
  eq('the /jobs/intro landing page is not a job', jobs.filter(j => /intro/.test(j.url)).length, 0);
  ok('lastmod becomes postedAt', jobs[0].postedAt === Date.parse('2026-08-20T18:49:29-04:00'));
  // The sitemap has no location. Leaving it empty buckets as 'unknown' and stays
  // visible; inventing one could hide a US role or surface a foreign one.
  eq('location is left empty rather than guessed', jobs[0].location, '');
  eq('provider id', icims.id, 'icims');
}

console.log('');
console.log('iCIMS says what a 405 MEANS, because it means one thing (F-448)');
// The sitemap route this provider was built on is gated now. A bare "HTTP 405"
// sends the next person looking for a transport bug; the refusal is permanent
// for any non-browser client, and the remedy is a different channel. The test
// also pins the other direction: an ordinary failure must NOT be dressed up as
// a gate, or a real outage reads as "use the browser" forever.
{
  const entry = { name: 'Joby Aviation', careers_url: 'https://careers-jobyaviation.icims.com' };
  const ctxThrowing = (status) => ({
    async fetchText() { const e = new Error(`HTTP ${status}`); e.status = status; throw e; },
  });

  for (const status of [405, 403]) {
    let err = null;
    try { await icims.fetch(entry, ctxThrowing(status)); } catch (e) { err = e; }
    ok(`${status} is reported as a gate`, !!err?.gated, `got: ${err && err.message}`);
    ok(`${status} message names the employer`, !!err && err.message.includes('Joby Aviation'));
    ok(`${status} message points at the browser route`, !!err && /browser/i.test(err.message));
    ok(`${status} keeps the status on the error`, err?.status === status, `got: ${err && err.status}`);
  }

  // A 500 or a timeout is a transport problem and will clear. Calling it a gate
  // would retire a whole board's scan on one bad afternoon.
  for (const status of [500, 502, undefined]) {
    let err = null;
    try { await icims.fetch(entry, ctxThrowing(status)); } catch (e) { err = e; }
    ok(`${status} is NOT dressed up as a gate`, !err?.gated, `got: ${err && err.message}`);
  }

  // And a host that is not iCIMS at all still fails on its own terms.
  let cfgErr = null;
  try { await icims.fetch({ name: 'Nope', careers_url: 'https://example.com' }, ctxThrowing(405)); }
  catch (e) { cfgErr = e; }
  ok('a non-iCIMS careers_url is a config error, not a gate', !cfgErr?.gated && /icims/.test(cfgErr?.message || ''));
}

console.log('');
console.log('SmartRecruiters builds the PUBLIC posting URL');
// This provider had no test, which is how it shipped a URL shape that 404s.
// `ref` is the API's own url; swapping its host produced
// jobs.smartrecruiters.com/<slug>/postings/<id>, which SmartRecruiters answers
// with 404 for LIVE postings. Verified on their API against one requisition:
// /postings/<id> -> 404, /<id>-<title-slug> -> 200. Every posting this source
// put in his deck - all 123 of them - pointed at a dead URL.
{
  const payload = { content: [{
    id: '744000146271379',
    name: 'Senior AI Data Science Engineer',
    ref: 'https://api.smartrecruiters.com/v1/companies/Intuitive/postings/744000146271379',
    location: { city: 'Sunnyvale', region: 'CA', country: 'us' },
  }] };
  const [row] = parseSmartRecruitersResponse(payload, 'Intuitive Surgical');
  eq('public url, not the API path', row.url,
    'https://jobs.smartrecruiters.com/Intuitive/744000146271379-senior-ai-data-science-engineer');
  ok('never the /postings/ shape', !row.url.includes('/postings/'), row.url);
  // The slug from `ref` keeps SmartRecruiters' casing; the lowercased company
  // name would give /intuitive-surgical/ and miss.
  ok('slug comes from ref, with its casing', row.url.includes('/Intuitive/'), row.url);
}
{
  // No ref: fall back to the company slug, still in the public shape.
  const payload = { content: [{ id: '999', name: 'Test Engineer', location: { fullLocation: 'Austin, TX' } }] };
  const [row] = parseSmartRecruitersResponse(payload, 'Acme Robotics');
  eq('fallback url', row.url, 'https://jobs.smartrecruiters.com/acme-robotics/999-test-engineer');
}

// ── Greenhouse: where the description lives (F-404) ──────────────────
//
// A company that hosts its own Greenhouse board publishes a URL that carries
// the posting id and NOT the board — `agilityrobotics.com/about/job-post
// ?gh_jid=5986750004` — and the detail endpoint needs the board. 2,231
// postings across twelve companies were unreadable for that reason: no
// description, no visa check on the description, a title-only fit score, and
// any resume written for one written blind. The board is known at discovery,
// so the posting now carries the endpoint.
console.log('\n🧪 greenhouse: every posting says where its description lives');
{
  const board = 'https://boards-api.greenhouse.io/v1/boards/agilityrobotics/jobs';
  const json = {
    jobs: [
      { id: 5986750004, title: 'Mechanical Engineer', absolute_url: 'https://www.agilityrobotics.com/about/job-post?gh_jid=5986750004', location: { name: 'Hybrid- Fremont, CA' } },
      { id: 6178371004, title: 'Campus Program Recruiter', absolute_url: 'https://job-boards.greenhouse.io/agilityrobotics/jobs/6178371004', location: { name: 'Remote' } },
    ],
  };
  const ctx = { fetchJson: async () => json };
  const rows = await greenhouse.fetch({ name: 'Agility Robotics', api: board }, ctx);
  eq('the company-hosted posting carries its detail endpoint', rows[0].detailApi,
    'https://boards-api.greenhouse.io/v1/boards/agilityrobotics/jobs/5986750004');
  eq('…and so does one on greenhouse.io itself', rows[1].detailApi,
    'https://boards-api.greenhouse.io/v1/boards/agilityrobotics/jobs/6178371004');
  ok('the posting URL is still the company\'s own', rows[0].url.includes('agilityrobotics.com'));

  // A board given as a careers_url rather than an api: URL builds the same
  // endpoint — the slug is the only part that matters.
  const viaCareers = await greenhouse.fetch({ name: 'Agility Robotics', careers_url: 'https://job-boards.greenhouse.io/agilityrobotics' }, ctx);
  eq('derived from careers_url too', viaCareers[0].detailApi,
    'https://boards-api.greenhouse.io/v1/boards/agilityrobotics/jobs/5986750004');
}

console.log('\n🧪 Lever: the requirements live in `lists`, not in the description');
{
  // The shape api.lever.co/v0/postings/cfsenergy returned on 2026-09-19 for
  // "Manufacturing Engineer - First Shift", trimmed. Reading descriptionPlain
  // alone stored the "About CFS" paragraph and nothing the screen could judge.
  const posting = {
    text: 'Manufacturing Engineer - First Shift',
    hostedUrl: 'https://jobs.lever.co/cfsenergy/42685769-30a5-4e10-8c1f-7c3abe0fb170',
    categories: { location: 'Devens, MA', department: 'Manufacturing' },
    createdAt: 1757455724794,
    description: '<div><b>About Commonwealth Fusion Systems:</b> on a mission…</div>',
    descriptionPlain: 'About Commonwealth Fusion Systems: on a mission…',
    lists: [
      { text: "What you'll do:", content: '<li>Develop, implement, and qualify manufacturing processes</li>' },
      { text: "What we're looking for:", content: "<li>Bachelor's degree in Mechanical Engineering</li><li>5+ years of experience in manufacturing engineering</li>" },
    ],
    additional: '<div>This role requires compliance with U.S. export control laws.</div>',
    additionalPlain: 'This role requires compliance with U.S. export control laws.',
  };
  const rows = await lever.fetch({ name: 'Commonwealth Fusion Systems', careers_url: 'https://jobs.lever.co/cfsenergy' },
    { fetchJson: async () => [posting] });
  const text = htmlToText(rows[0].description);
  ok('the years line reaches the store', text.includes('5+ years of experience in manufacturing engineering'), text);
  ok('…and the degree line', text.includes("Bachelor's degree in Mechanical Engineering"), text);
  ok('…and the section headings', text.includes("What we're looking for:"), text);
  ok('…and the closing export-control text', text.includes('export control laws'), text);
  ok('the intro is still first', text.startsWith('About Commonwealth Fusion Systems'), text);

  // A posting with no lists and only plain fields still yields its body.
  const bare = leverBody({ descriptionPlain: 'Just an intro.' });
  eq('plain-only postings keep their text', bare, 'Just an intro.');
}

console.log('\n🧪 Routing: every board reaches its own provider (F-499)');
{
  // scan.mjs asks providers in file order and takes the first that answers.
  // icims-careers claimed any https origin, so every provider sorting after it
  // (lever, rippling, recruitee, smartrecruiters, workable) went dark for nine
  // days. Pin the order-dependent outcome the way scan.mjs computes it.
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../providers/', import.meta.url);
  const all = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    const p = (await import(new URL(f, dir).href)).default;
    if (p?.id && p.id !== 'local-parser') all.push(p);
  }
  const firstClaim = (entry) => {
    for (const p of all) { let hit = null; try { hit = p.detect?.(entry); } catch {} if (hit) return p.id; }
    return null;
  };
  eq('a Lever board goes to lever', firstClaim({ name: 'CFS', careers_url: 'https://jobs.lever.co/cfsenergy' }), 'lever');
  eq('a Rippling board goes to rippling', firstClaim({ name: 'Zap', careers_url: 'https://ats.rippling.com/zap-energy-careers/jobs' }), 'rippling');
  eq('a SmartRecruiters board goes to smartrecruiters', firstClaim({ name: 'Intuitive', careers_url: 'https://jobs.smartrecruiters.com/Intuitive' }), 'smartrecruiters');
  ok('icims-careers answers when the entry names it',
    !!icimsCareers.detect({ name: 'Rivian', provider: 'icims-careers', careers_url: 'https://careers.rivian.com' }));
  ok('…and not for a bare https origin', !icimsCareers.detect({ name: 'X', careers_url: 'https://careers.example.com' }));
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
