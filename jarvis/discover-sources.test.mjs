// Tests for the non-LinkedIn company indexes. Fixtures are the markup and the
// comments each site actually served on 2026-09-20.

import { parseBuiltIn, parseHnComment, parseClimatebase, harvestSources, HARDWARE_TITLE_RE, SOURCE_QUERIES } from './discover-sources.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const CARD = (id, company, title) => `<div class="left-side-tile-item-2"><a href="/company/x" target="_blank" data-id="company-title" data-builtin-track-job-id="${id}" class="font-barlow"><span>${company}</span></a></div> <div class="left-side-tile-item-3"><h2 class="font-barlow"><a href="/job/x/${id}" target="_blank" data-id="job-card-title" data-alias="/job/x/${id}" data-builtin-track-job-id="${id}" class="card-alias-after-overlay text-break">${title}</a></h2></div>`;

console.log('\n🧪 discover-sources: Built In');
{
  const rows = parseBuiltIn(CARD('10617367', 'Ericsson', 'Mechanical Design Engineer II') + CARD('2', 'Kulicke &amp; Soffa', 'Process Engineer'));
  check('one row per card', rows.length, 2);
  check('company', rows[0].company, 'Ericsson');
  check('title', rows[0].title, 'Mechanical Design Engineer II');
  check('the id is the site’s own job id', rows[0].id, 'builtin-10617367');
  check('entities are decoded', rows[1].company, 'Kulicke & Soffa');
  check('a page with no cards is empty', parseBuiltIn('<html>Just a moment…</html>'), []);
}

console.log('\n🧪 discover-sources: HN Who is hiring');
{
  const hit = (t) => ({ objectID: '1', comment_text: t });
  const good = parseHnComment(hit('Cascade Space | Senior Mechanical Engineer | San Francisco, CA (ONSITE) | Full-time<p>We build…'));
  check('company is the first segment', good.company, 'Cascade Space');
  check('role is the second', good.title, 'Senior Mechanical Engineer');
  check('a URL beside the name is dropped', parseHnComment(hit('Apex Space (https:&#x2F;&#x2F;apexspace.com) | Multiple Roles | LA')).company, 'Apex Space');
  check('a reply in prose is not a posting', parseHnComment(hit('Thanks for the feedback; I&#x27;ll be revisiting with my staff how we are explaining things.')), null);
  check('a comment that leads with the place is not a company', parseHnComment(hit('Cologne, Germany | UMH | Robotics Engineer')), null);
  check('…nor one that leads with the work mode', parseHnComment(hit('REMOTE (US) | Overture | COO')), null);
  check('a sentence is not a company name', parseHnComment(hit('At Tether we are hiring across the whole company right now! | Engineers')), null);
}

console.log('\n🧪 discover-sources: Climatebase');
{
  const page = (jobs) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { jobs } } })}</script>`;
  const rows = parseClimatebase(page([{ id: 7, title: 'Mechanical Engineer', name_of_employer: 'Form Energy' }, { id: 8, title: 'Sales Estimator', name_of_employer: 'OmniSource' }]));
  check('read out of the page’s own JSON', rows.map(r => r.company), ['Form Energy', 'OmniSource']);
  check('no JSON, no rows', parseClimatebase('<html></html>'), []);
  check('broken JSON, no rows and no throw', parseClimatebase('<script id="__NEXT_DATA__">{oops</script>'), []);
}

console.log('\n🧪 discover-sources: a site’s search is a hint, the title is what was posted');
{
  for (const t of ['Mechanical Design Engineer II', 'Robotics Engineer - Humanoids focus', 'Senior Manufacturing Automation and Robotics Engineer', 'Test and Development Technician', 'Prototype Engineer', 'Process Control Engineer']) {
    check(`kept: ${t}`, HARDWARE_TITLE_RE.test(t), true);
  }
  for (const t of ['Sales Estimator', 'FP&A Analyst', 'Transportation Planner', 'Senior Account Executive', 'Associate, Human Resources', 'Policy and Regulatory Affairs Manager']) {
    check(`dropped: ${t}`, HARDWARE_TITLE_RE.test(t), false);
  }
  // Climatebase returned its whole feed whatever was searched. The scrap-metal
  // recycler with 33 sales estimators must not reach the resolver.
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ jobs: [{ id: 1, title: 'Sales Estimator', name_of_employer: 'OmniSource' }, { id: 2, title: 'Mechanical Engineer', name_of_employer: 'Form Energy' }] })}</script>`;
  let n = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => (++n === 1 ? html : '') });
  const { postings } = await harvestSources({ sources: ['climatebase'], queries: ['x'], fetchImpl, pause: async () => {} });
  check('only the hardware title survives', postings.map(p => p.company), ['Form Energy']);
}

console.log('\n🧪 discover-sources: a refusal is said, never read as "nothing new"');
{
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '' });
  const res = await harvestSources({ sources: ['builtin'], queries: ['mechanical engineer'], fetchImpl, pause: async () => {} });
  check('counted', res.errors, 1);
  check('and named, with the status', res.refused, ['builtin "mechanical engineer" p1 (403)']);
  const named = SOURCE_QUERIES.filter(q => /tesla|apple|intel|micron|asml/i.test(q));
  check('no search names a company', named, []);
}

console.log('\n🧪 discover-sources: YC’s own job posts on Hacker News');
{
  const { parseYcStory } = await import('./discover-sources.mjs');
  const s = (title) => parseYcStory({ objectID: '9', title });
  // Real headlines, 2026-09-20.
  const z = s('Zettascale (YC S24) Is Hiring ASIC/FPGA Engineers to Build Chips for ASI');
  check('company', z.company, 'Zettascale');
  check('batch', z.batch, 'YC S24');
  check('role', z.title, 'ASIC/FPGA Engineers to Build Chips for ASI');
  check('a software-only headline is not worth a resolver’s time', s('Kyber (YC W23) Is Hiring a Forward Deployed Engineer'), null);
  check('"Is Hiring" with nothing after it says nothing physical', s('Cekura (YC F24) Is Hiring'), null);
  check('a headline that does not follow the form is not read', s('We are hiring mechanical engineers at a robotics startup'), null);
  check('an ordinary story is not a job post', s('Show HN: my robot arm'), null);
  check('"Machine Learning" is not machining', s('BoldVoice (YC S21) Is Hiring Fullstack and Machine Learning Engineers'), null);
  check('the article is dropped from the role', s('Acme Robotics (YC W25) is hiring a Mechanical Engineer').title, 'Mechanical Engineer');
}

console.log('\n🧪 discover-sources: The Muse and Adzuna (official APIs)');
{
  const { parseMuse, parseAdzuna, harvestSources: hs } = await import('./discover-sources.mjs');
  const muse = parseMuse(JSON.stringify({ results: [{ id: 1, name: 'Engineer III, Hardware Development', company: { name: 'CrowdStrike' }, locations: [{ name: 'Austin, TX' }] }, { id: 2, name: 'No company' }] }));
  check('Muse: company, title, place', muse, [{ id: 'muse-1', company: 'CrowdStrike', title: 'Engineer III, Hardware Development', loc: 'Austin, TX', source: 'muse' }]);
  check('Muse: bad JSON is empty, not a throw', parseMuse('{oops'), []);
  const adz = parseAdzuna({ results: [{ id: '77', title: '<strong>Mechanical</strong> Engineer', company: { display_name: 'Acme &amp; Sons' }, location: { display_name: 'Reno, NV' } }] });
  check('Adzuna: highlight markup and entities are cleaned', adz, [{ id: 'adzuna-77', company: 'Acme & Sons', title: 'Mechanical Engineer', loc: 'Reno, NV', source: 'adzuna' }]);
  // No key: the source is skipped and SAYS so — it never reads as "nothing new".
  let called = 0;
  const res = await hs({ sources: ['adzuna'], env: {}, fetchImpl: async () => { called++; return { ok: true, status: 200, text: async () => '{}' }; }, pause: async () => {} });
  check('without a key Adzuna is never called', called, 0);
  check('…and the run names why', /adzuna \(no ADZUNA_APP_ID/.test(res.refused[0] || ''), true);
  const withKey = [];
  await hs({ sources: ['adzuna'], queries: ['q'], env: { ADZUNA_APP_ID: 'i', ADZUNA_APP_KEY: 'k' }, fetchImpl: async (u) => { withKey.push(u); return { ok: true, status: 200, text: async () => '{"results":[]}' }; }, pause: async () => {} });
  check('with a key it asks the documented endpoint', /^https:\/\/api\.adzuna\.com\/v1\/api\/jobs\/us\/search\/1\?app_id=i&app_key=k&what=q/.test(withKey[0] || ''), true);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
