#!/usr/bin/env node
// jarvis/discover-sources.mjs — the other public indexes of WHO IS HIRING.
//
// Same division of labour as discover-linkedin.mjs, and for the same reason:
// the scanner's reach is the length of portals.yml, and a job site is good at
// exactly one thing we cannot do ourselves — naming employers we have never
// heard of. So this harvests COMPANY NAMES, never postings, and hands the
// untracked ones to discover-ats.mjs, which verifies each board with a live
// API call. After that the ordinary scanner owns the company.
//
// WHICH SITES, AND WHY NOT THE OBVIOUS ONES
// ─────────────────────────────────────────
// Measured 2026-09-20, one plain GET each, no cookies:
//   Built In        200  — 25 cards a page, company and title in the markup,
//                          still full at page 40. Startup-heavy, which is the
//                          half of the market an S&P list never reaches.
//   HN Who is hiring 200 — Algolia's public API. A few hundred comments a
//                          month, a handful mechanical, nearly all companies
//                          of under fifty people: Cascade Space, Reframe.
//   Climatebase     200  — energy and climate hardware, in the page's own JSON.
//   Indeed, Glassdoor, ZipRecruiter, SimplyHired   403 — bot protection.
//   Wellfound       200, but the body is a DataDome challenge.
//   YC Work at a Startup   406.   (YC is already a seed: --seeds yc.)
//   Dice            200 — and nearly every card is a staffing firm's repost.
// The refused ones stay refused. Getting past bot protection means pretending
// to be a person, the block would simply move, and their listings are
// overwhelmingly syndicated copies of boards the scanner reads directly.
//
// Usage:
//   node jarvis/discover-sources.mjs                       # report new companies
//   node jarvis/discover-sources.mjs --write               # …and track the ones that resolve
//   node jarvis/discover-sources.mjs --sources builtin,hn --pages 20
//   node jarvis/discover-sources.mjs --json > harvest.json

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { guardArgs } from './cli.mjs';
import { newCompanies, HARDWARE_TITLE_RE, worthTracking } from './discover-linkedin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const USAGE = `
  node jarvis/discover-sources.mjs [options]

  Harvest company names from Built In, HN "Who is hiring" and Climatebase, and
  report the ones portals.yml does not track yet.

    --write            hand the new names to discover-ats, which verifies and tracks them
    --sources <list>   builtin,hn,ycjobs,muse,climatebase,adzuna (default: all;
                       adzuna needs ADZUNA_APP_ID and ADZUNA_APP_KEY, free at developer.adzuna.com)
    --queries <list>   comma-separated searches for Built In and Climatebase
    --pages <n>        pages per search (default 12)
    --months <n>       how many monthly HN threads to read (default 3)
    --min <n>          only report companies with at least n postings (default 1)
    --json             machine-readable output
`;

export const ALL_SOURCES = ['builtin', 'hn', 'ycjobs', 'muse', 'climatebase', 'adzuna'];

/** Role searches, never company names — same rule as discover-linkedin. */
export const SOURCE_QUERIES = [
  'mechanical engineer', 'robotics engineer', 'manufacturing engineer', 'hardware engineer',
  'mechanical design engineer', 'mechatronics', 'test engineer hardware', 'process engineer',
  'automation engineer', 'electromechanical',
];

const decode = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#x2F;/g, '/').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * A posting only counts toward a company if its TITLE is hardware work.
 *
 * Climatebase ignores the search term and returns its whole feed — the first
 * run's top "new company" was a scrap-metal recycler with 33 sales estimators.
 * A site's search is a hint; the title is what was actually posted.
 */
// One definition, shared with the LinkedIn finder.
export { HARDWARE_TITLE_RE };

// ── parsers: pure, so the tests need no network ─────────────────────

/** Built In search page → postings. One card carries one tracked job id twice. */
export function parseBuiltIn(html) {
  const out = [];
  const src = String(html || '');
  const re = /data-id="company-title"[^>]*data-builtin-track-job-id="(\d+)"[^>]*>\s*<span[^>]*>([^<]+)<\/span>[\s\S]{0,900}?data-id="job-card-title"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ id: `builtin-${m[1]}`, company: decode(m[2]), title: decode(m[3]), loc: '', source: 'builtin' });
  }
  return out;
}

/**
 * One HN "Who is hiring" comment → a posting, or null.
 *
 * The thread's convention is "Company | Role | Location | …" on the first line.
 * A comment that does not follow it is a reply or a question, and guessing a
 * company out of free prose is how a sentence fragment ends up in portals.yml.
 */
export function parseHnComment(hit) {
  const text = decode(String(hit?.comment_text || '').replace(/<p>/g, '\n').replace(/<[^>]+>/g, ' '));
  const first = text.split('\n')[0] || text;
  const parts = first.split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const company = parts[0].replace(/\(\s*https?:[^)]*\)/g, '').replace(/https?:\S+/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!company || company.length > 50 || /[.!?]$/.test(company) || company.split(/\s+/).length > 6) return null;
  // Some comments lead with the place: "Cologne, Germany | UMH | …". A city is
  // not an employer, and the name would go to the resolver as if it were.
  if (/,\s*[A-Z]/.test(company) || /\b(?:remote|onsite|on-site|hybrid|full[- ]?time)\b/i.test(company)) return null;
  return { id: `hn-${hit.objectID}`, company, title: parts[1].slice(0, 120), loc: parts[2] || '', source: 'hn' };
}

/** Climatebase search page → postings, out of the page's own __NEXT_DATA__. */
export function parseClimatebase(html) {
  const raw = (String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
  if (!raw) return [];
  let data; try { data = JSON.parse(raw); } catch { return []; }
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.name_of_employer === 'string' && typeof node.title === 'string' && node.id != null) {
      out.push({ id: `climatebase-${node.id}`, company: decode(node.name_of_employer), title: decode(node.title), loc: '', source: 'climatebase' });
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return out;
}

/**
 * The Muse's public API → postings. No key. Mostly large employers, so most of
 * what it names is tracked already; it costs twelve requests to find out.
 */
export function parseMuse(json) {
  let data; try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  return (data?.results || [])
    .filter(r => r && r.id != null && r.company?.name && r.name)
    .map(r => ({ id: `muse-${r.id}`, company: decode(r.company.name), title: decode(r.name), loc: decode(r.locations?.[0]?.name || ''), source: 'muse' }));
}

/**
 * YC's own job posts on Hacker News → postings.
 *
 * Every YC company may post one hiring story, and they all follow one form:
 * "Zettascale (YC S24) Is Hiring ASIC/FPGA Engineers to Build Chips". That form
 * is the whole parser — a story that does not match it is not read, because a
 * company name guessed out of a free headline is how a sentence fragment gets
 * resolved to somebody's board. Most of YC is software, so the headline has to
 * say something physical before the company is worth a resolver's time.
 */
const YC_STORY_RE = /^(.{2,48}?)\s*\((YC [A-Z]{1,2}\d{2})\)\s+(?:is|are)\s+hiring\b\s*(.*)$/i;
export const PHYSICAL_HINT_RE = /\b(?:hardware|robot|mechanical|mechatronic|manufactur|electrical|embedded|firmware|asic|fpga|chips?|silicon|semiconductor|battery|batteries|drone|aerospace|satellite|space|rocket|propulsion|nuclear|fusion|energy|factory|factories|industrial|automation|sensor|optic|photonic|laser|biotech|lab automation|medical device|3d print|additive|materials?|machining|machinist|machine shop|cnc|eVTOL|aircraft|vehicle|automotive|physical)/i;
export function parseYcStory(hit) {
  const m = decode(hit?.title || '').match(YC_STORY_RE);
  if (!m) return null;
  const role = m[3].replace(/^(?:an?|for|its|their)\s+/i, '').trim();
  if (!PHYSICAL_HINT_RE.test(role)) return null;
  return { id: `yc-${hit.objectID}`, company: m[1].trim(), title: role.slice(0, 120), loc: '', source: 'ycjobs', batch: m[2] };
}

/**
 * Adzuna's official search API → postings. Needs the free key pair from
 * developer.adzuna.com in ADZUNA_APP_ID / ADZUNA_APP_KEY; without it the source
 * is skipped and says so. This is the legitimate door to the aggregator tier:
 * Indeed, Glassdoor and ZipRecruiter answer 403 to a server, and Adzuna
 * republishes the same syndicated listings through an API it invites you to use.
 * Response shape per their documentation; NOT yet exercised against the live
 * API from this machine — no key was available on 2026-09-20.
 */
export function parseAdzuna(json) {
  let data; try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  return (data?.results || [])
    .filter(r => r && r.id != null && r.company?.display_name && r.title)
    .map(r => ({ id: `adzuna-${r.id}`, company: decode(r.company.display_name), title: decode(String(r.title).replace(/<[^>]+>/g, '')), loc: decode(r.location?.display_name || ''), source: 'adzuna' }));
}

// ── harvesters ──────────────────────────────────────────────────────

async function get(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json' } });
  return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
}

/** Page a search until it runs dry, is refused, or stops yielding anything new. */
async function pageThrough(urlFor, parse, { pages, fetchImpl, pause, seen, report, label }) {
  let stale = 0;
  const offTopic = new Set();
  for (let page = 1; page <= pages; page++) {
    let res;
    try { res = await get(urlFor(page), fetchImpl); } catch { report.errors++; break; }
    report.requests++;
    if (!res.ok) { report.errors++; report.refused.push(`${label} p${page} (${res.status})`); break; }
    const rows = parse(res.text);
    if (!rows.length) break;
    let added = 0;
    // `fresh` counts what the PAGE held, so paging continues through a page of
    // off-topic titles; only on-topic ones are kept.
    let fresh = 0;
    for (const row of rows) {
      if (seen.has(row.id) || offTopic.has(row.id)) continue;
      fresh++;
      if (worthTracking(row.title)) { seen.set(row.id, row); added++; } else offTopic.add(row.id);
    }
    added = fresh;
    stale = added ? 0 : stale + 1;
    if (stale >= 2) break;
    await pause(900);
  }
}

export async function harvestSources({
  sources = ALL_SOURCES, queries = SOURCE_QUERIES, pages = 12, months = 3,
  env = process.env, now = Date.now,
  fetchImpl = fetch, pause = sleep,
} = {}) {
  const seen = new Map();
  const report = { requests: 0, errors: 0, refused: [] };
  const opts = { pages, fetchImpl, pause, seen, report };

  if (sources.includes('builtin')) {
    for (const q of queries) {
      await pageThrough(
        (p) => `https://builtin.com/jobs?${new URLSearchParams({ search: q, country: 'USA', allLocations: 'true', page: String(p) })}`,
        parseBuiltIn, { ...opts, label: `builtin "${q}"` });
    }
  }
  if (sources.includes('climatebase')) {
    for (const q of queries) {
      await pageThrough(
        (p) => `https://climatebase.org/jobs?${new URLSearchParams({ l: 'United States', q, p: String(p - 1) })}`,
        parseClimatebase, { ...opts, pages: Math.min(pages, 5), label: `climatebase "${q}"` });
    }
  }
  if (sources.includes('muse')) {
    await pageThrough(
      (p) => `https://www.themuse.com/api/public/jobs?${new URLSearchParams({ category: 'Science and Engineering', location: 'United States', page: String(p) })}`,
      parseMuse, { ...opts, pages: Math.min(pages, 15), label: 'muse' });
  }
  if (sources.includes('adzuna')) {
    const id = env.ADZUNA_APP_ID, key = env.ADZUNA_APP_KEY;
    if (!id || !key) report.refused.push('adzuna (no ADZUNA_APP_ID / ADZUNA_APP_KEY — free at developer.adzuna.com)');
    else for (const q of queries) {
      await pageThrough(
        (p) => `https://api.adzuna.com/v1/api/jobs/us/search/${p}?${new URLSearchParams({ app_id: id, app_key: key, what: q, results_per_page: '50', max_days_old: '14' })}`,
        parseAdzuna, { ...opts, pages: Math.min(pages, 6), label: `adzuna "${q}"` });
    }
  }
  if (sources.includes('ycjobs')) {
    // A year of stories, newest first, 100 a page.
    const since = Math.floor(now() / 1000) - 365 * 86400;
    for (let page = 0; page < 12; page++) {
      let r;
      try { r = await get(`https://hn.algolia.com/api/v1/search_by_date?tags=job&hitsPerPage=100&page=${page}&numericFilters=created_at_i>${since}`, fetchImpl); } catch { report.errors++; break; }
      report.requests++;
      if (!r.ok) { report.errors++; report.refused.push(`ycjobs p${page} (${r.status})`); break; }
      const hits = JSON.parse(r.text || '{}').hits || [];
      if (!hits.length) break;
      for (const hit of hits) { const row = parseYcStory(hit); if (row && !seen.has(row.id)) seen.set(row.id, row); }
      await pause(300);
    }
  }
  if (sources.includes('hn')) {
    try {
      const idx = await get('https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=12', fetchImpl);
      report.requests++;
      const threads = (JSON.parse(idx.text || '{}').hits || []).filter(h => /who is hiring/i.test(h.title || '')).slice(0, months);
      for (const t of threads) {
        for (const term of ['mechanical', 'hardware', 'robotics', 'manufacturing', 'mechatronics']) {
          const r = await get(`https://hn.algolia.com/api/v1/search?tags=comment,story_${t.objectID}&query=${term}&hitsPerPage=100`, fetchImpl);
          report.requests++;
          if (!r.ok) { report.errors++; report.refused.push(`hn ${t.title} (${r.status})`); continue; }
          for (const hit of JSON.parse(r.text || '{}').hits || []) {
            // Top-level comments only: a reply's parent is another comment.
            if (String(hit.parent_id) !== String(t.objectID)) continue;
            const row = parseHnComment(hit);
            if (row && !seen.has(row.id)) seen.set(row.id, row);
          }
          await pause(300);
        }
      }
    } catch { report.errors++; }
  }
  return { postings: [...seen.values()], ...report };
}

// ── CLI ─────────────────────────────────────────────────────────────

const FLAGS = ['--write', '--sources', '--queries', '--pages', '--months', '--min', '--json'];
const VALUED = ['--sources', '--queries', '--pages', '--months', '--min'];

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: FLAGS, valued: VALUED, argv });
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
  const has = n => args.includes(`--${n}`);
  const list = (n, d) => (flag(n, '') ? String(flag(n, '')).split(',').map(s => s.trim()).filter(Boolean) : d);
  const asJson = has('json');

  const sources = list('sources', ALL_SOURCES);
  if (!asJson) console.log(`\n  Reading ${sources.join(', ')} for company names…\n`);
  const res = await harvestSources({
    sources, queries: list('queries', SOURCE_QUERIES),
    pages: Number(flag('pages', 12)), months: Number(flag('months', 3)),
  });

  const cfg = yaml.load(readFileSync(path.join(ROOT, 'portals.yml'), 'utf8')) || {};
  const tracked = (cfg.tracked_companies || []).map(c => c && c.name).filter(Boolean);
  const fresh = newCompanies(res.postings, tracked, { min: Number(flag('min', 1)) });

  if (asJson) { console.log(JSON.stringify({ ...res, tracked: tracked.length, companies: fresh }, null, 1)); }
  else {
    const per = {}; for (const p of res.postings) per[p.source] = (per[p.source] || 0) + 1;
    console.log(`  ${res.postings.length} postings over ${res.requests} requests — ${Object.entries(per).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    // A refusal is said, with the page it happened on: a source that starts
    // answering 403 must not read as "that site had nothing new this week".
    if (res.refused.length) console.log(`  ⚠ refused: ${res.refused.slice(0, 8).join(' · ')}${res.refused.length > 8 ? ` … +${res.refused.length - 8}` : ''}`);
    console.log(`  ${fresh.length} companies NOT tracked:\n`);
    for (const c of fresh.slice(0, 80)) console.log(`    ${String(c.count).padStart(3)}  ${c.name}  —  ${c.titles[0] || ''}`);
    if (fresh.length > 80) console.log(`    … +${fresh.length - 80} more (use --json for all)`);
  }

  if (!has('write') || !fresh.length) return 0;
  const { spawnSync } = await import('node:child_process');
  console.log(`\n  Handing ${fresh.length} names to discover-ats for verification…\n`);
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'jarvis', 'discover-ats.mjs'),
    '--names', fresh.map(c => c.name.replace(/,/g, ' ')).join(','), '--write',
  ], { stdio: 'inherit' });
  return r.status ?? 0;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
