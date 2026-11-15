// Jobvite provider: list parsing, the description reader, and the resolver's
// detection of a jobs.jobvite.com/<slug> board. Every page here is a saved
// fixture (jarvis/fixtures/jobvite/, fetched 2026-11-04) from two employers on
// two different themes; nothing touches the network.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jobvite, { parseJobviteList, jobvitePostingFromHtml, jobviteSlug, nextPageUrl, JOBVITE_UA } from '../providers/jobvite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (f) => readFileSync(path.join(HERE, 'fixtures', 'jobvite', f), 'utf-8');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 jobvite: the list, on two themes');

const mini = parseJobviteList(fixture('mini-circuits-positions.html'), 'mini-circuits', 'Mini-Circuits');
check('Mini-Circuits (custom theme, <li> rows): every posting on /jobs/positions', mini.length, 54);
check('Mini-Circuits first row: title, location, department, url', mini[0], {
  title: 'Field Applications Engineer - West Coast', company: 'Mini-Circuits', location: 'Remote, California',
  url: 'https://jobs.jobvite.com/mini-circuits/job/o9l3zfwQ', team: 'Engineering',
});
check('Mini-Circuits: no posting read twice', new Set(mini.map((j) => j.url)).size, mini.length);

const egnyte = parseJobviteList(fixture('egnyte-jobs.html'), 'egnyte', 'Egnyte');
check('Egnyte (classic theme, <table> rows): every posting on /jobs', egnyte.length, 25);
check('Egnyte first row: entities decoded, no department column', egnyte[0], {
  title: 'Customer Support Specialist, AR & Billing', company: 'Egnyte', location: 'Mountain View, California',
  url: 'https://jobs.jobvite.com/egnyte/job/opPUAfws',
});
check('Egnyte: a non-ASCII title survives', egnyte[1].title, 'FP&A Manager – GTM');
check('another employer\'s postings never count', parseJobviteList(fixture('egnyte-jobs.html'), 'mini-circuits').length, 0);

// Featured cards are a subset of the list: a landing page with only those is
// not a 4-posting board.
const LANDING = `<div class="jv-featured-job"><a href="/mini-circuits/job/opp2Afwa"><div class="jv-featured-job-title">A</div></a></div>
  <a class="jv-button" href="/mini-circuits/jobs/positions">Join Our Team</a>`;
check('featured cards are not the list', parseJobviteList(LANDING, 'mini-circuits').length, 0);

console.log('\n🧪 jobvite: fetch() follows the theme to the full list');

function fakeCtx(pages) {
  const asked = [];
  return {
    asked,
    fetchText: async (url, opts) => {
      asked.push({ url, ua: opts?.headers?.['user-agent'], redirect: opts?.redirect });
      if (!(url in pages)) throw new Error(`HTTP 302 (unknown ${url})`);
      return pages[url];
    },
  };
}
{
  const ctx = fakeCtx({
    'https://jobs.jobvite.com/mini-circuits/jobs': LANDING,
    'https://jobs.jobvite.com/mini-circuits/jobs/positions': fixture('mini-circuits-positions.html'),
  });
  const jobs = await jobvite.fetch({ name: 'Mini-Circuits', careers_url: 'https://jobs.jobvite.com/mini-circuits' }, ctx);
  check('landing page with featured cards only → /jobs/positions read', jobs.length, 54);
  check('two requests, honest UA, redirects refused', ctx.asked, [
    { url: 'https://jobs.jobvite.com/mini-circuits/jobs', ua: JOBVITE_UA, redirect: 'error' },
    { url: 'https://jobs.jobvite.com/mini-circuits/jobs/positions', ua: JOBVITE_UA, redirect: 'error' },
  ]);
}
{
  const ctx = fakeCtx({ 'https://jobs.jobvite.com/egnyte/jobs': fixture('egnyte-jobs.html') });
  const jobs = await jobvite.fetch({ name: 'Egnyte', careers_url: 'https://jobs.jobvite.com/egnyte/jobs' }, ctx);
  check('a /jobs page that lists everything is read in one request', [jobs.length, ctx.asked.length], [25, 1]);
}
{
  // Paginated board: page 1 links page 2 through a.jv-pagination-next.
  const row = (id, t) => `<tr><td class="jv-job-list-name"><a href="/acme/job/${id}">${t}</a></td><td class="jv-job-list-location">Austin, Texas</td></tr>`;
  const p1 = `<table class="jv-job-list">${row('oAAAA1', 'One')}${row('oAAAA2', 'Two')}</table><a class="jv-pagination-next" href="/acme/jobs?p=1">Next</a>`;
  const p2 = `<table class="jv-job-list">${row('oAAAA2', 'Two')}${row('oAAAA3', 'Three')}</table><a class="jv-pagination-next" href="/acme/jobs?p=1">Next</a>`;
  const ctx = fakeCtx({ 'https://jobs.jobvite.com/acme/jobs': p1, 'https://jobs.jobvite.com/acme/jobs?p=1': p2 });
  const jobs = await jobvite.fetch({ name: 'Acme', careers_url: 'https://jobs.jobvite.com/acme' }, ctx);
  check('pages followed, duplicates dropped, a page asked once', [jobs.map((j) => j.title), ctx.asked.length], [['One', 'Two', 'Three'], 2]);
  check('a next link to another employer is not followed', nextPageUrl('<a class="jv-pagination-next" href="/other/jobs?p=1">', 'acme'), '');
}
{
  let threw = false;
  try { await jobvite.fetch({ name: 'Nobody', careers_url: 'https://jobs.jobvite.com/nobody' }, fakeCtx({})); } catch { threw = true; }
  check('an unknown slug (302 to search.jobvite.com) is an error, not an empty board', threw, true);
}

console.log('\n🧪 jobvite: detect()');

check('jobs.jobvite.com/<slug>', jobvite.detect({ careers_url: 'https://jobs.jobvite.com/mini-circuits' }), { url: 'https://jobs.jobvite.com/mini-circuits/jobs' });
check('a posting URL names its board', jobviteSlug('https://jobs.jobvite.com/Egnyte/job/orIXAfwq'), 'egnyte');
check('careers.jobvite.com is the same slug', jobviteSlug('https://careers.jobvite.com/mini-circuits/favicon.ico'), 'mini-circuits');
check('Jobvite\'s own pages are not employers', jobviteSlug('https://jobs.jobvite.com/search?q=x'), '');
check('another host never claimed', jobvite.detect({ careers_url: 'https://jobvite.com.evil.example/acme' }), null);
check('other boards untouched', jobvite.detect({ careers_url: 'https://acme.teamtailor.com/jobs' }), null);

console.log('\n🧪 jobvite: the posting body');

for (const [f, title, min] of [['mini-circuits-job.html', 'Field Applications Engineer - West Coast', 10000], ['egnyte-job.html', 'FP&A Manager – GTM', 15000]]) {
  const html = fixture(f);
  const ld = JSON.parse(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(html)[1]);
  check(`${f}: schema.org JobPosting with the full body (what enrich reads)`, [ld['@type'], ld.title, ld.description.length > min], ['JobPosting', title, true]);
  const shown = jobvitePostingFromHtml(html);
  check(`${f}: jv-job-detail-description fallback reads the same posting`, [shown.title, shown.description.length > min, /Apply/.test(shown.description.slice(-200))], [title, true, false]);
}
check('no description div → null', jobvitePostingFromHtml('<h2 class="jv-header">X</h2>'), null);

console.log('\n🧪 discover-ats: a jobs.jobvite.com/<slug> link is a jobvite board');

const { boardLinksIn, boardFromText } = await import('./discover-ats.mjs');
check('boardLinksIn names it', boardLinksIn('<a href="https://jobs.jobvite.com/mini-circuits/jobs">Careers</a>').filter((b) => b.provider === 'jobvite'),
  [{ provider: 'jobvite', slug: 'mini-circuits' }]);
check('Jobvite\'s own host paths are noise', boardLinksIn('<a href="https://jobs.jobvite.com/jobs">x</a>').filter((b) => b.provider === 'jobvite'), []);
{
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts = {}) => {
    asked.push(String(url));
    const pages = {
      'https://jobs.jobvite.com/mini-circuits/jobs': LANDING,
      'https://jobs.jobvite.com/mini-circuits/jobs/positions': fixture('mini-circuits-positions.html'),
    };
    if (String(url) in pages) return new Response(pages[String(url)], { status: 200, headers: { 'content-type': 'text/html' } });
    if (opts.redirect === 'error') throw new TypeError('fetch failed: redirect mode is set to error');
    return new Response('', { status: 404 });
  };
  try {
    const hit = await boardFromText('<a href="https://jobs.jobvite.com/mini-circuits">Open roles</a>', 'Mini-Circuits', true, new Set());
    check('the probe confirms it through the provider', hit && { provider: hit.provider, count: hit.count, entry: hit.entry },
      { provider: 'jobvite', count: 54, entry: { name: 'Mini-Circuits', careers_url: 'https://jobs.jobvite.com/mini-circuits/jobs', provider: 'jobvite' } });
    check('only jobs.jobvite.com was asked', asked.every((u) => u.startsWith('https://jobs.jobvite.com/mini-circuits/')), true);
    const miss = await boardFromText('<a href="https://jobs.jobvite.com/nobody-here">x</a>', 'Nobody Here', true, new Set());
    check('a slug Jobvite redirects away is no board', miss, null);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\n🧪 enrich: Jobvite pages are asked for honestly');

const { userAgentFor, HONEST_UA } = await import('./enrich.mjs');
check('jobs.jobvite.com gets the honest client name', userAgentFor('https://jobs.jobvite.com/egnyte/job/orIXAfwq'), HONEST_UA);
check('the provider and the enricher use one name', JOBVITE_UA, HONEST_UA);
check('other hosts unchanged', userAgentFor('https://boards.greenhouse.io/x/jobs/1') === HONEST_UA, false);

console.log('\n🧪 enrich: a jobvite row has a detail source');

const { detailSpec } = await import('./enrich.mjs');
const { DETAIL_SOURCES } = await import('./detail-sources.mjs');
check('a posting URL is read as a page (schema.org path)', detailSpec({ source: 'jobvite', url: 'https://jobs.jobvite.com/mini-circuits/job/o9l3zfwQ' }),
  { html: 'https://jobs.jobvite.com/mini-circuits/job/o9l3zfwQ', pick: null });
check('a list or apply URL is not a posting', [
  detailSpec({ source: 'jobvite', url: 'https://jobs.jobvite.com/mini-circuits/jobs' }),
  detailSpec({ source: 'jobvite', url: 'https://jobs.jobvite.com/mini-circuits/job/o9l3zfwQ/apply' }),
  detailSpec({ source: 'jobvite', url: 'https://evil.example/mini-circuits/job/o9l3zfwQ' }),
], [null, null, null]);
check('the dashboard\'s list names it', DETAIL_SOURCES.includes('jobvite'), true);

console.log('\n🧪 pace: one day per Jobvite employer, under a Jobvite ceiling');

const { paceKeys, paceLimits, makePacer, budgetFor, DAILY_BUDGET } = await import('./pace.mjs');
const { serviceOf, makeHostLimiter } = await import('./net-pool.mjs');
const { readSettings, clamp } = await import('./settings.mjs');
const { mkdtempSync, rmSync } = await import('fs');
const { tmpdir } = await import('os');
{
  const mc = paceKeys('https://jobs.jobvite.com/mini-circuits/job/o9l3zfwQ', serviceOf);
  const eg = paceKeys('https://jobs.jobvite.com/Egnyte/job/orIXAfwq', serviceOf);
  check('the tenant is the employer slug, not the shared host', [mc, eg], [
    { service: 'jobvite.com', tenant: 'jobs.jobvite.com/mini-circuits' },
    { service: 'jobvite.com', tenant: 'jobs.jobvite.com/egnyte' },
  ]);
  check('host-tenanted platforms unchanged', paceKeys('https://kla.wd1.myworkdayjobs.com/x/job/1', serviceOf),
    { service: 'myworkdayjobs.com', tenant: 'kla.wd1.myworkdayjobs.com' });
  check('untenanted services unchanged', paceKeys('https://boards-api.greenhouse.io/v1/boards/x/jobs/1', serviceOf), { service: 'greenhouse.io', tenant: '' });
  check('no settings: the platform gets 1,000, not the 5,000 default', [budgetFor('jobvite.com', paceLimits({})), DAILY_BUDGET['jobvite.com']], [1000, 1000]);

  const dir = mkdtempSync(path.join(tmpdir(), 'jobvite-pace-'));
  try {
    const s = readSettings(path.join(dir, 'no-settings.json'));
    check('settings default: 1,000 a day across Jobvite, 150 per employer, 2 in flight', [s.paceJobviteCeiling, s.pacePerTenant, s.paceTenantConcurrency], [1000, 150, 2]);
    check('the ceiling is clamped like the others', [clamp('paceJobviteCeiling', 99999), clamp('paceJobviteCeiling', 1)], [5000, 100]);
    check('his setting becomes the ceiling', paceLimits(s).ceilings['jobvite.com'], 1000);

    const limits = paceLimits({ pacePerTenant: 2, paceJobviteCeiling: 3 });
    const p = makePacer(path.join(dir, 'pace.json'), { limits });
    check('one employer spends only its own day', [p.take(mc), p.take(mc), p.take(mc)], [true, true, false]);
    check('…another employer on the same host still reads, up to the platform ceiling', [p.take(eg), p.take(eg)], [true, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // The enricher's limiters: 3 in flight per platform (PER_SERVICE), 2 per
  // employer site (paceTenantConcurrency), keyed exactly as paceKeys keys them.
  const withService = makeHostLimiter(3), withTenant = makeHostLimiter(2);
  let perSlug = 0, peakSlug = 0, platform = 0, peakPlatform = 0;
  const one = (k) => withService(k.service, () => withTenant(k.tenant, async () => {
    platform++; peakPlatform = Math.max(peakPlatform, platform);
    if (k.tenant === mc.tenant) { perSlug++; peakSlug = Math.max(peakSlug, perSlug); }
    await new Promise((r) => setTimeout(r, 5));
    if (k.tenant === mc.tenant) perSlug--;
    platform--;
  }));
  await Promise.all([mc, mc, mc, mc, eg, eg, eg, eg].map(one));
  check('at most 2 in flight to one employer, 3 to Jobvite', [peakSlug, peakPlatform], [2, 3]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
