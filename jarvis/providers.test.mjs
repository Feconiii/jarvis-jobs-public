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

import phenom, { parsePhenomResponse, totalHits, phenomPage, siteLocaleOf } from '../providers/phenom.mjs';
import sf, { parseSuccessFactorsFeed, splitTitleLocation, htmlToPlain } from '../providers/successfactors.mjs';
import icims, { parseIcimsSitemap, titleFromSlug } from '../providers/icims.mjs';
import { parseSmartRecruitersResponse } from '../providers/smartrecruiters.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import lever, { leverBody, leverTitle } from '../providers/lever.mjs';
import icimsCareers from '../providers/icims-careers.mjs';
import { htmlToText } from './text.mjs';
import pageup, { parsePageUpFeed } from '../providers/pageup.mjs';
import workable, { departmentsFromSearchGuide, countriesFromSearchGuide, departmentSearches } from '../providers/workable.mjs';
import { readFileSync as readAts } from 'fs';
import vm from 'node:vm';
import { tmpdir } from 'os';
import { join as joinPath } from 'path';

// The Workable provider reads the real discovery hold file (F-634); a block on
// his network that day must not fail these offline tests, nor may they write it.
process.env.JARVIS_DISCOVER_HOLDS = joinPath(tmpdir(), `providers-test-holds-${process.pid}.json`);

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

  // 2026-11-12: Phenom over SuccessFactors / Taleo hands back a link no reader opens;
  // the posting's page on the Phenom site goes along as detailApi, the url unchanged.
  const sf = parsePhenomResponse({ refineSearch: { data: { jobs: [
    { title: 'Mechanical Engineer (Civil)', jobSeqNo: 'BECHUS287881EXTERNALENUS', applyUrl: 'https://career4.successfactors.com/career?company=bechtelP&career_job_req_id=287881' },
    { title: 'Process Engineer', jobSeqNo: 'QGRQGAGLOBALP1EXTERNALENGLOBAL', applyUrl: 'https://acme.taleo.net/careersection/2/jobdetail.ftl?job=1' },
    { title: 'Process Engineer', jobSeqNo: 'AHMA12394', applyUrl: 'https://recruiting.ultipro.com/AME/JobBoard/x/OpportunityDetail?opportunityId=1' },
  ] } } }, 'jobs.bechtel.com', 'Bechtel');
  eq('the stored url stays the apply link', sf[0].url, 'https://career4.successfactors.com/career?company=bechtelP&career_job_req_id=287881');
  eq('…and its page is kept to read', sf[0].detailApi, 'https://jobs.bechtel.com/us/en/job/BECHUS287881EXTERNALENUS/mechanical-engineer-civil');
  eq('the locale the id names is the path', sf[1].detailApi, 'https://jobs.bechtel.com/global/en/job/QGRQGAGLOBALP1EXTERNALENGLOBAL/process-engineer');
  eq('an id with no locale is filed under us/en', sf[2].detailApi, 'https://jobs.bechtel.com/us/en/job/AHMA12394/process-engineer');
  eq('a Workday link gets no page (it is read as Workday)', j.detailApi, undefined);
  eq('a link already on the site gets no page', noApply[0].detailApi, undefined);
  eq('an id with odd characters gets no page', phenomPage('jobs.x.com', { jobSeqNo: 'a/b', title: 't' }), '');
  // F-1048 review: an id with no locale takes the apply link's, then the site's own, before us/en.
  eq('the locale the apply link asks for', phenomPage('jobs.lanxess.com', { jobSeqNo: 'LANX4471', title: 'Process Engineer',
    applyUrl: 'https://career5.successfactors.eu/career?company=lanxess&career_job_req_id=4471&lang=de_DE' }), 'https://jobs.lanxess.com/de/de/job/LANX4471/process-engineer');
  eq('…the id\'s own locale still wins over it', phenomPage('jobs.x.com', { jobSeqNo: 'X1EXTERNALENUS', title: 't', applyUrl: 'https://a.test/?lang=de_DE' }), 'https://jobs.x.com/us/en/job/X1EXTERNALENUS/t');
  const gb = parsePhenomResponse({ refineSearch: { data: { jobs: [
    { title: 'Design Engineer', jobSeqNo: 'SWAG991', applyUrl: 'https://swagelok.taleo.net/careersection/2/jobdetail.ftl?job=991' },
  ] } } }, 'jobs.swagelok.co.uk', 'Swagelok', { siteLocale: siteLocaleOf('https://jobs.swagelok.co.uk/gb/en/') });
  eq('the locale the careers_url is filed under', gb[0].detailApi, 'https://jobs.swagelok.co.uk/gb/en/job/SWAG991/design-engineer');
  eq('a careers_url with no locale path names none', siteLocaleOf('https://jobs.bechtel.com'), '');
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

  // Arthrex, CTS, Lindsay, REV Group (2026-10-01): /sitemap.xml is a URL
  // sitemap and the RSS lives at /googlejobs.xml.
  const asked = [];
  const ctx = { fetchText: async (u) => { asked.push(u); return u.endsWith('/googlejobs.xml') ? xml : '<?xml version="1.0"?><urlset><url><loc>https://careers.x.com/</loc></url></urlset>'; } };
  const viaAlt = await sf.fetch({ name: 'Arthrex', careers_url: 'https://careers.arthrex.com' }, ctx);
  eq('a URL sitemap falls through to /googlejobs.xml', viaAlt.length, 2);
  eq('…asking the RSS path second', asked, ['https://careers.arthrex.com/sitemap.xml', 'https://careers.arthrex.com/googlejobs.xml']);
  asked.length = 0;
  const pinned = await sf.fetch({ name: 'X', careers_url: 'https://careers.x.com', feed: 'https://careers.x.com/sitemap.xml' }, ctx);
  eq('…but an explicit feed: is taken as given', [pinned.length, asked.length], [0, 1]);

  // CNH (F-760): the Italian copy of a US requisition is the translated
  // template with every requirement section empty. The posting is kept; the
  // template is not stored as its description.
  const cnh = parseSuccessFactorsFeed(`<rss><channel><item>
      <title>Design Engineer (Oak Brook, IL, US)</title>
      <description><![CDATA[&lt;p&gt;Chi siamo&lt;/p&gt;&lt;p&gt;Innovazione. Sostenibilità. Produttività.&lt;/p&gt;&lt;p&gt;Scopo del ruolo&lt;/p&gt;&lt;p&gt;Maggiori Responsabilità&lt;/p&gt;&lt;p&gt;Esperienza Richiesta&lt;/p&gt;&lt;p&gt;Qualifiche preferenziali&lt;/p&gt;&lt;p&gt;Trasparenza salariale&lt;/p&gt;&lt;p&gt;Lo stipendio annuale per questo ruolo è di USD $19,57 - $35,02, più eventuali bonus applicabili.&lt;/p&gt;]]></description>
      <link>https://join.cnh.com/job/Oak-Brook-Design-Engineer-IL-60521/1367648455/</link>
    </item></channel></rss>`, 'CNH');
  eq('the translated-template copy is still a posting', cnh.length, 1);
  eq('…with no description, rather than an empty template', cnh[0].description, undefined);
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
{
  // Phoenix Tailings numbers its board like an outline (2026-09-24).
  eq('a section number is not part of the title', leverTitle('4.6. Manufacturing Engineer I'), 'Manufacturing Engineer I');
  eq('…nor a two-space one', leverTitle('4.5.  Production Engineer II'), 'Production Engineer II');
  eq('a year with no dot is kept', leverTitle('2027 New Grad Mechanical Engineer'), '2027 New Grad Mechanical Engineer');
  eq('3D is kept', leverTitle('3D Printing Engineer'), '3D Printing Engineer');
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

// ── PageUp (Enpro, 2026-10-02) ───────────────────────────────────────
{
  const feed = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel xmlns:job="http://pageuppeople.com/">
<item><guid isPermaLink="true">https://careers.pageuppeople.com/1050/cw/en-us/job/497392</guid><link>https://careers.pageuppeople.com/1050/cw/en-us/job/497392</link><title>Manufacturing Engineer</title><description>NxEdge</description><pubDate>Wed, 17 Sep 2026 18:00:00 Z</pubDate><job:refNo>497392</job:refNo><job:description>&lt;p&gt;NxEdge is a world class company &amp;amp; more.&lt;/p&gt;&lt;p&gt;Salary Range: $102K - 110K&lt;/p&gt;</job:description><job:location>NxEdge|Morgan Hill</job:location><job:businessLayer1>EnPro Industries|Advanced Surface Technologies</job:businessLayer1></item>
<item><link>https://careers.pageuppeople.com/1050/cw/en-us/job/497425</link><title>National Sales Manager - US West</title><job:refNo>497425</job:refNo><job:location>Remote|Remote,Stemco|Longview</job:location></item>
</channel></rss>`;
  const jobs = parsePageUpFeed(feed, { company: 'Enpro', places: { 'Morgan Hill': 'Morgan Hill, CA, US', Longview: 'Longview, TX, US' } });
  eq('PageUp: every item is a posting', jobs.length, 2);
  eq('…its link ends in the job number the form carries', jobs[0].url, 'https://careers.pageuppeople.com/1050/cw/en-us/job/497392');
  eq('…a plant name becomes a place', jobs[0].location, 'Morgan Hill, CA, US');
  eq('…several sites, each spelled', jobs[1].location, 'Remote | Longview, TX, US');
  ok('…the description is text, not escaped markup', /world class company & more\.\s+Salary Range: \$102K - 110K/.test(jobs[0].description), jobs[0].description);
  eq('…the division is the team', jobs[0].team, 'Advanced Surface Technologies');
  ok('…and the date is read', jobs[0].postedAt === Date.parse('2026-09-17T18:00:00Z'));
  let threw = false;
  try { await pageup.fetch({ name: 'X' }, { fetchText: async () => feed }); } catch { threw = true; }
  ok('…an entry without its instance number is refused, not guessed', threw);

  // The extension reads the same number off the posting and off the form.
  const ctx = { URL, globalThis: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(readAts(new URL('./extension/ats.js', import.meta.url), 'utf-8'), ctx);
  const tok = ctx.__jarvisAts.reqToken;
  eq('PageUp posting → its job number', tok('https://careers.pageuppeople.com/1050/cw/en-us/job/497392'), 'pageup:497392');
  eq('PageUp form → the same number', tok('https://secure.dc4.pageuppeople.com/apply/1050/aw/applicationForm/initApplication.asp?lJobID=497392&sLanguage=en-us&sSourcePointer=aw'), 'pageup:497392');
  eq('…its first page names none', tok('https://secure.dc4.pageuppeople.com/apply/1050/aw/applicationForm/preFill.asp?sData=UFUtVjMtuH'), null);
  // Zoho Recruit (RKS Design, 2026-09-28: "not a posting in your store").
  eq('Zoho Recruit → its job number', tok('https://rksdesign.zohorecruit.com/jobs/Careers/657802000005145001/Entry-Level-Mechanical-Product-Development-Engineer?source=LinkedIn-Basic'), 'zoho:657802000005145001');
}

console.log('\n🧪 Workable: a large board serves a search guide, read one department at a time (F-659)');
{
  // Shape of OnLogic's /jobs.md, 2026-10-02 — 33 openings, no table.
  const GUIDE = `# OnLogic — Open Positions

> This company has 33 open positions. Use the search endpoint to filter results.

## How to Search

Send a **GET** request to \`https://apply.workable.com/onlogic-inc/jobs.md\` with query string parameters:

## Departments

- Engineering (8 roles)
- Sales & Marketing (10 roles)
- Finance (1 role)

## Locations

- United States: North Carolina, Cary | Vermont, South Burlington
`;
  const TABLE = (rows) => `| Title | Department | Location | Type | Salary | Posted | Details |
|-------|-----------|----------|------|--------|--------|---------|
${rows.map(([t, id]) => `| ${t} | X | South Burlington, United States | Full-time |  | 2026-09-10 | [View](https://apply.workable.com/onlogic-inc/jobs/view/${id}.md) |`).join('\n')}`;
  eq('the departments come off the guide',
    departmentsFromSearchGuide(GUIDE).map(d => [d.name, d.count]), [['Engineering', 8], ['Sales & Marketing', 10], ['Finance', 1]]);
  // TMEIC files all 34 under one parent, and one search answers at most 30.
  const NESTED = `## Departments

- TMEIC Corporation Americas (34 roles)
  - Finance (2020000) (3 roles)
  - Energy and Infrastructure Solutions (9097000) (16 roles)
    - EIS Operations (9097200) (5 roles)
- Small (2 roles)

## Locations
`;
  const tree = departmentsFromSearchGuide(NESTED);
  eq('sub-departments sit under their parent', tree[0].children.map(d => d.name), ['Finance (2020000)', 'Energy and Infrastructure Solutions (9097000)']);
  eq('…to any depth', tree[0].children[1].children[0].name, 'EIS Operations (9097200)');
  eq('a parent past the cap is searched with its children; one under it is searched alone',
    departmentSearches(tree), ['TMEIC Corporation Americas', 'Finance (2020000)', 'Energy and Infrastructure Solutions (9097000)', 'Small']);
  eq('a page with a table is not a guide', departmentsFromSearchGuide(TABLE([['Firmware Engineer', 'A1']])), []);

  const asked = [];
  const pages = {
    'https://apply.workable.com/onlogic-inc/jobs.md': GUIDE,
    'https://apply.workable.com/onlogic-inc/jobs.md?department=Engineering': TABLE([['Firmware Engineer', 'A1'], ['Facilities Automation Engineer', 'A2']]),
    'https://apply.workable.com/onlogic-inc/jobs.md?department=Sales%20%26%20Marketing': TABLE([['Sales Engineer', 'B1'], ['Firmware Engineer', 'A1']]),
    'https://apply.workable.com/onlogic-inc/jobs.md?department=Finance': TABLE([['Financial Analyst', 'C1']]),
    // An opening with no department is reachable only by its country (13 of Nextern's 47).
    'https://apply.workable.com/onlogic-inc/jobs.md?location%5B0%5D%5Bcountry%5D=United%20States': TABLE([['Firmware Engineer', 'A1'], ['Test Technician', 'D1']]),
  };
  const ctx = { fetchText: async (u) => { asked.push(u); if (!(u in pages)) throw new Error(`unexpected ${u}`); return pages[u]; } };
  const jobs = await workable.fetch({ name: 'OnLogic', careers_url: 'https://apply.workable.com/onlogic-inc' }, ctx);
  eq('every department is read, each posting once',
    jobs.map(j => j.title), ['Firmware Engineer', 'Facilities Automation Engineer', 'Sales Engineer', 'Financial Analyst', 'Test Technician']);
  eq('one request for the guide, one per department, one per country', asked.length, 5);
  eq('the countries come off the guide', countriesFromSearchGuide(GUIDE), ['United States']);
}

console.log('\n🧪 workable: the scanner honours the IP-block hold discovery writes (F-634)');
{
  const { mkdtempSync, rmSync, readFileSync: rd } = await import('fs');
  const os = await import('os');
  const p = await import('path');
  const dir = mkdtempSync(p.join(os.tmpdir(), 'wk-hold-'));
  const holds = p.join(dir, 'discover-holds.json');
  const prev = process.env.JARVIS_DISCOVER_HOLDS;
  process.env.JARVIS_DISCOVER_HOLDS = holds;
  try {
    const entry = { name: 'OnLogic', careers_url: 'https://apply.workable.com/onlogic-inc' };
    let sent = 0;
    const blocked = { fetchText: async () => { sent++; const e = new Error('HTTP 429'); e.status = 429; e.retryAfter = '70000'; throw e; } };
    let first;
    try { await workable.fetch(entry, blocked); } catch (e) { first = e; }
    eq('a 429 is still an error to the scanner', first?.status, 429);
    const saved = JSON.parse(rd(holds, 'utf8'));
    eq('…and its deadline is written down', Math.round((Date.parse(saved.holds['workable.com'].until) - Date.now()) / 3600e3), 19);
    let second;
    try { await workable.fetch(entry, blocked); } catch (e) { second = e; }
    eq('inside the hold nothing is sent', sent, 1);
    eq('…and the refusal says so', !!second?.held, true);
  } finally {
    if (prev == null) delete process.env.JARVIS_DISCOVER_HOLDS; else process.env.JARVIS_DISCOVER_HOLDS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n🧪 bamboohr: the placeholder demo board is a failed read, never postings (F-637)');
{
  const { default: bamboohr } = await import('../providers/bamboohr.mjs');
  const demo = { result: [
    { id: '15', jobOpeningName: 'IT Security Engineer', location: { city: 'Mayfair', state: 'London, City of' } },
    { id: '20', jobOpeningName: 'Software Engineer', location: { city: 'Berlin', state: 'Brandenburg' } },
  ] };
  let err = '';
  try { await bamboohr.fetch({ name: 'Xylem', careers_url: 'https://xylem.bamboohr.com/careers' }, { fetchJson: async () => demo }); }
  catch (e) { err = e.message; }
  ok('a tracked board serving it fails the read and says why', /placeholder demo board/.test(err), err);
  const real = await bamboohr.fetch({ name: 'Acme', careers_url: 'https://acme.bamboohr.com/careers' },
    { fetchJson: async () => ({ result: [{ id: '42', jobOpeningName: 'Mechanical Engineer', location: { city: 'Wichita', state: 'Kansas' } }] }) });
  ok('a real board still reads', real.length === 1 && real[0].title === 'Mechanical Engineer');
}

{
  console.log('\n🧪 workday: a posting with no location text takes its city from the path (F-777)');
  const { locationFromPath } = await import('../providers/workday.mjs');
  const { classifyLocation } = await import('./geo.mjs');
  ok('Accenture\'s Bengaluru posting reads Bengaluru',
    locationFromPath('/job/Bengaluru/Process---Manufacturing-Engineer_R00299176') === 'Bengaluru');
  ok('…and buckets as non-US', classifyLocation(locationFromPath('/job/Bengaluru/X_R1')) === 'non-us');
  ok('a multi-word city keeps its words',
    locationFromPath('/job/Lisbon-Santos-37/Next-Generation-Robotics-Engineer_R1') === 'Lisbon Santos 37');
  ok('a US path still reads as the US',
    classifyLocation(locationFromPath('/job/Austin-TX/Mechanical-Engineer_R1')) === 'us');
  ok('no path, no location', locationFromPath('') === '' && locationFromPath('/weird') === '');
}

{
  console.log('\n🧪 pinpoint: postings.json carries the whole body — keep it');
  const { parsePinpointResponse } = await import('../providers/pinpoint.mjs');
  const [p] = parsePinpointResponse({ data: [{
    title: 'Propulsion Engineer', url: 'https://impulsespace.pinpointhq.com/postings/1',
    location: { name: 'El Segundo, CA' },
    description: '<p>Build engines.</p>',
    key_responsibilities_header: 'What you will do', key_responsibilities: '<ul><li>Test thrusters</li></ul>',
    skills_knowledge_expertise_header: 'Requirements', skills_knowledge_expertise: '<ul><li>BS in Mechanical Engineering</li></ul>',
    benefits: '<p>To conform to ITAR you must be a U.S. citizen or lawful permanent resident.</p>',
  }] }, 'Impulse Space');
  ok('the closing section (where the ITAR clause lives) arrives too', /ITAR/.test(p.description));
  ok('the intro, duties and requirements all arrive',
    /Build engines/.test(p.description) && /Test thrusters/.test(p.description) && /BS in Mechanical/.test(p.description));
  ok('each section keeps its header', /<h3>What you will do<\/h3>/.test(p.description) && /<h3>Requirements<\/h3>/.test(p.description));
  const [bare] = parsePinpointResponse({ data: [{ title: 'X', url: 'https://a.pinpointhq.com/postings/2' }] }, 'A');
  ok('no body, no description field', !('description' in bare));
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
