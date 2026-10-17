#!/usr/bin/env node
// jarvis/discover-linkedin.mjs — use LinkedIn as an INDEX OF COMPANIES, not as
// a job board.
//
// WHY THIS EXISTS, AND WHY IT DOES NOT IMPORT POSTINGS
// ────────────────────────────────────────────────────
// The scanner reads company ATS boards, which is the right place to read from:
// the board is the employer's own record, it carries the full description, and
// the apply engine can drive it. But the scanner can only read boards for
// companies that are already in portals.yml, so its coverage is bounded by a
// list we maintain by hand. That bound is invisible from the inside — every
// scan looks complete because it scanned everything it knows about.
//
// Measured 2026-09-19: one week of LinkedIn postings across 30 mechanical,
// robotics and manufacturing searches returned 1,914 jobs. 198 were already in
// the store. 936 were at companies portals.yml has never heard of, across 470
// distinct employers. Only 3 were at a tracked company and missing from the
// store, and those turned out to be a spelling difference. So the gap was never
// a broken reader — it was the length of the company list.
//
// Hence the division of labour here. LinkedIn is very good at one thing we
// cannot do ourselves: telling us WHICH companies are hiring mechanical
// engineers this week. It is bad at everything else — its copy of the
// description is a copy, its apply link is behind a login wall, and postings
// are syndicated with a lag. So this script harvests names, not jobs, and hands
// them to discover-ats.mjs, which finds each company's real board and verifies
// it with a live API call. After that the ordinary scanner owns them forever
// and LinkedIn is out of the loop.
//
// It reads LinkedIn's public guest endpoint — the one that serves logged-out
// visitors. No account, no token, no cookie; `credentials: 'omit'` is not an
// oversight. It is the same data a stranger sees, at one request every 250 ms.
//
// Usage:
//   node jarvis/discover-linkedin.mjs                  # report new companies
//   node jarvis/discover-linkedin.mjs --write          # …and track them
//   node jarvis/discover-linkedin.mjs --days 14 --min 2
//   node jarvis/discover-linkedin.mjs --queries "humanoid robotics,wafer fab"

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { guardArgs } from './cli.mjs';
import { NEVER_TRACK, HARDWARE_TITLE_RE, BUILDING_SERVICES_RE, worthTracking } from './hiring-signals.mjs';
export { NEVER_TRACK, HARDWARE_TITLE_RE, BUILDING_SERVICES_RE, worthTracking };
import { discovery } from './targeting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const USAGE = `
  node jarvis/discover-linkedin.mjs [options]

  Harvest company names from LinkedIn's public job search and report the ones
  portals.yml does not track yet.

    --write            append the resolved companies to portals.yml
    --queries <list>   comma-separated searches (default: the built-in set)
    --days <n>         how far back to look (default 7)
    --min <n>          only report companies with at least n matching postings (default 1)
    --pages <n>        pages per query, 10 postings each (default 8)
    --levels <list>    LinkedIn experience levels (default 1,2,3,4; 'any' for no filter)
    --metros           also run every search per hardware metro, to get past the
                       few hundred results a country-wide search is cut off at
    --metro <list>     location names, instead of the built-in metros: separated by
                       ";" (names carry commas: "Austin, Texas Metropolitan Area"),
                       or by "," when no ";" is present
    --gap <ms>         pause between requests (default 1200)
    --all-titles       count every posting toward a company, not only hardware titles
    --limit <n>        stop after n new companies
    --json             machine-readable output
`;

/**
 * The default searches.
 *
 * These are deliberately ROLE searches, not company searches — the whole point
 * is to find employers we cannot name yet, so naming them in the query defeats
 * it. They are the preset's (discovery.linkedinQueries), which records why each
 * was added. Overlap between them is free; the harvest dedupes by posting id
 * and the same company surfacing under four searches is a signal, not waste.
 */
export const DEFAULT_QUERIES = [...discovery.linkedinQueries];


// ── the public endpoint ─────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

const decodeEntities = s => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * Pull the job cards out of one page of LinkedIn's guest search.
 *
 * Parsed with string work rather than a DOM, for a reason worth recording: the
 * fragment is served as a bare list of `<li>` elements with no document around
 * them, and LinkedIn's own pages override DOMParser under Trusted Types, so the
 * obvious approach fails in a browser context and silently returns zero rows.
 * Splitting on the entity URN is stable because that attribute is what the
 * markup is built around — every card has exactly one.
 *
 * @param {string} html
 * @returns {Array<{id:string,title:string,company:string,loc:string,posted:string,url:string}>}
 */
export function parseSearchPage(html) {
  const out = [];
  for (const chunk of String(html || '').split('data-entity-urn="urn:li:jobPosting:').slice(1)) {
    const id = (chunk.match(/^(\d+)/) || [])[1];
    if (!id) continue;
    out.push({
      id,
      title: decodeEntities((chunk.match(/base-search-card__title"[^>]*>([\s\S]*?)<\//) || [])[1]),
      company: decodeEntities(
        (chunk.match(/hidden-nested-link"[^>]*>([\s\S]*?)<\//)
          || chunk.match(/base-search-card__subtitle"[^>]*>([\s\S]*?)<\//) || [])[1]),
      loc: decodeEntities((chunk.match(/job-search-card__location"[^>]*>([\s\S]*?)<\//) || [])[1]),
      posted: (chunk.match(/datetime="([\d-]+)"/) || [])[1] || '',
      url: (chunk.match(/href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1] || '',
      // The company's own LinkedIn page, which names its website (F-657).
      companyUrl: (chunk.match(/hidden-nested-link"[^>]*href="(https:\/\/[a-z]{2,3}\.linkedin\.com\/company\/[^"?/]+)/)
        || chunk.match(/href="(https:\/\/[a-z]{2,3}\.linkedin\.com\/company\/[^"?/]+)[^"]*"[^>]*class="hidden-nested-link/) || [])[1] || '',
    });
  }
  return out;
}

/**
 * LinkedIn's experience-level tags: 1 internship, 2 entry, 3 associate,
 * 4 mid-senior, 5 director, 6 executive.
 *
 * This asked for '1,2' until 2026-09-20, and that was the wrong question for a
 * script that harvests COMPANY NAMES (F-509). A startup hiring one senior
 * robotics engineer has a board worth reading, and the level of the posting
 * that revealed it says nothing about the postings on that board. It is also an
 * unreliable tag: startups mostly leave it unset or default it to mid-senior —
 * Agility's 0-3 year Mechanical Engineer was not tagged entry. Measured on one
 * search, one week: the '1,2' filter saw 98 companies and hid 95 others the
 * wider runs found, Lab37, KUKA, HIWIN, GrayMatter Robotics and Brightpick
 * among them. Level is triage's job, per posting, with the sentence it read.
 */
export const DEFAULT_LEVELS = '1,2,3,4';

/** The whole country. One entry, because a search without a place is one search. */
export const UNITED_STATES = { name: 'United States', location: 'United States', geoId: '103644278' };

/**
 * The metros where the preset's employers cluster (discovery.metros).
 *
 * A guest search returns the newest few hundred results and no more, so a
 * country-wide "mechanical engineer" is truncated long before it reaches a
 * twelve-person company in Pittsburgh. Asking per metro is how the same search
 * reaches past the cut. Named by LinkedIn's own location text rather than by
 * geoId — the text resolves on the guest endpoint, and a wrong id fails silent.
 */
export const METROS = discovery.metros.map(name => ({ name, location: name }));

export function searchUrl(query, { start = 0, days = 7, levels = DEFAULT_LEVELS, place = UNITED_STATES } = {}) {
  const p = new URLSearchParams({
    keywords: query,
    location: place.location,
    f_TPR: `r${days * 86400}`,
    sortBy: 'DD',                     // newest first
    start: String(start),
  });
  if (place.geoId) p.set('geoId', place.geoId);
  if (levels) p.set('f_E', levels);
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${p}`;
}

const THROTTLED = new Set([429, 999]);

/**
 * Harvest every posting the given queries return. Names only, no descriptions.
 *
 * THE RATE LIMIT IS THE REAL BOUND (F-509). The guest endpoint answers 429
 * after a burst, and the first version treated any refusal as the end of that
 * query. So a throttled run lost most of its searches, counted them as
 * "errors", and printed a company list that looked complete. Now a 429 is
 * waited out and the SAME page asked again; if LinkedIn stays shut past the
 * retry budget the harvest stops and names the searches that never ran, so a
 * partial run cannot pass for a whole one. Any other refusal still ends just
 * that search.
 *
 * @returns {{postings:Array, requests:number, errors:number, throttled:boolean, unfinished:string[]}}
 */
export async function harvest(queries, {
  days = 7, pages = 8, levels = DEFAULT_LEVELS, places = [UNITED_STATES],
  fetchImpl = fetch, pause = sleep, gap = 1200, backoff = 45_000, retries = 4, onProgress = null,
} = {}) {
  const seen = new Map();
  const unfinished = [];
  let requests = 0, errors = 0, throttled = false;

  for (const place of places) {
    for (const q of queries) {
      const label = places.length > 1 ? `${q} @ ${place.name}` : q;
      if (throttled) { unfinished.push(label); continue; }
      let stale = 0, fresh = 0;
      for (let page = 0; page < pages; page++) {
        let rows = null;
        for (let attempt = 0; rows === null; attempt++) {
          let r;
          try {
            r = await fetchImpl(searchUrl(q, { start: page * 10, days, levels, place }), {
              headers: { 'user-agent': UA, accept: 'text/html' },
              credentials: 'omit',
            });
            requests++;
          } catch { errors++; break; }
          if (r.ok) { rows = parseSearchPage(await r.text()); break; }
          errors++;
          if (!THROTTLED.has(r.status)) break;          // a real refusal: end this search
          if (attempt >= retries) { throttled = true; break; }
          await pause(backoff * 2 ** attempt);           // wait it out, then the SAME page
        }
        // Every search after this one is skipped and named by the check above.
        if (throttled) { unfinished.push(label); break; }
        if (!rows || !rows.length) break;                // refused, or past the last page
        let added = 0;
        for (const row of rows) if (!seen.has(row.id)) { seen.set(row.id, { ...row, query: q, place: place.name }); added++; }
        fresh += added;
        // Newest-first searches overlap heavily. Two pages in a row with
        // nothing new means the rest is what another search already returned.
        stale = added ? 0 : stale + 1;
        if (stale >= 2) break;
        await pause(gap);
      }
      if (onProgress) onProgress({ label, fresh, total: seen.size, requests });
    }
  }
  return { postings: [...seen.values()], requests, errors, throttled, unfinished };
}

/**
 * THE COMPANY'S OWN WEBSITE, FROM ITS OWN LINKEDIN PAGE (F-657).
 *
 * A name is all a search card hands the resolver, and a name cannot reach a
 * board whose address nothing derives from it: JPL runs Workday as `citjpl`,
 * Vertex sits on pod `wd501`. Both had picks in his inbox that sent him to
 * LinkedIn's login wall. The company's own careers page links the board
 * outright, and discover-ats already follows it — when it is given a website.
 *
 * Every card links the company's LinkedIn page, and that page names the
 * website the company published ("about_website"), wrapped in a redirect.
 * Pure, so the tests feed it fixtures.
 *
 * @param {string} html
 * @returns {string} the website's origin, or '' when the page names none
 */
export function websiteFromCompanyPage(html) {
  // The attribute order is not fixed; the one in the tag is what matters.
  const href = (String(html || '').match(/href="([^"]+)"[^>]*about_website|about_website[^>]*href="([^"]+)"/) || []).slice(1).find(Boolean);
  if (!href) return '';
  let target = decodeEntities(href);
  try {
    const u = new URL(target);
    if (/linkedin\.com$/i.test(u.hostname)) target = u.searchParams.get('url') || '';
    const site = new URL(target);
    if (!/^https?:$/.test(site.protocol) || /linkedin\.com$/i.test(site.hostname)) return '';
    return site.origin;
  } catch { return ''; }
}

/**
 * Look up the website for each company that has a LinkedIn page link. Paced like
 * the search, and it STOPS at the first rate-limit rather than waiting it out: a
 * missing website only costs the resolver its best hint, never a company.
 */
export async function companyWebsites(companies, { fetchImpl = fetch, pause = sleep, gap = 1200 } = {}) {
  const out = new Map();
  for (const c of companies) {
    if (!c.companyUrl) continue;
    let r;
    try {
      r = await fetchImpl(c.companyUrl, { headers: { 'user-agent': UA, accept: 'text/html' }, credentials: 'omit' });
    } catch { continue; }
    if (THROTTLED.has(r.status)) break;
    if (r.ok) {
      const site = websiteFromCompanyPage(await r.text());
      if (site) out.set(c.name, site);
    }
    await pause(gap);
  }
  return out;
}

// ── matching against what we already track ──────────────────────────

/**
 * Company-name key. Same shape of normalisation discover-ats uses on slugs:
 * punctuation and the legal-form words carry no identity, so "Vast Space, Inc."
 * and "Vast" are one company. Kept deliberately loose — a false MATCH here only
 * means we do not re-add a company we already have, while a false MISS floods
 * the report with duplicates of tracked employers.
 */
export function companyKey(name) {
  return String(name || '')
    .toLowerCase()
    // "&" and "and" are the same word, and employers spell it both ways in the
    // same week — "Kulicke & Soffa" on LinkedIn, "Kulicke and Soffa" in
    // portals.yml. Stripping the ampersand as punctuation instead of reading it
    // makes those two different companies forever.
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|plc|gmbh|usa|us|the|a|an)\b/g, '')
    .replace(/\s+/g, '');
}

/**
 * Split a harvest into companies we track and companies we do not.
 * Pure — takes the tracked names, so the tests do not need portals.yml.
 */

export function newCompanies(postings, trackedNames, { min = 1, relevantOnly = false } = {}) {
  const tracked = new Set(trackedNames.map(companyKey).filter(Boolean));
  const found = new Map();
  for (const p of postings) {
    const key = companyKey(p.company);
    if (!key || tracked.has(key) || NEVER_TRACK.test(p.company)) continue;
    // Counted toward the company only when the posting itself is the work.
    if (relevantOnly && !worthTracking(p.title)) continue;
    if (!found.has(key)) found.set(key, { name: p.company, key, count: 0, titles: [], locations: new Set(), companyUrl: '' });
    const e = found.get(key);
    e.count++;
    if (!e.companyUrl && p.companyUrl) e.companyUrl = p.companyUrl;
    if (e.titles.length < 4) e.titles.push(p.title);
    e.locations.add(p.loc);
  }
  return [...found.values()]
    .filter(e => e.count >= min)
    .map(e => ({ ...e, locations: [...e.locations].slice(0, 3) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function trackedNamesFromPortals() {
  const cfg = yaml.load(readFileSync(path.join(ROOT, 'portals.yml'), 'utf8')) || {};
  return (cfg.tracked_companies || []).map(c => c && c.name).filter(Boolean);
}

// ── CLI ─────────────────────────────────────────────────────────────

const FLAGS = ['--write', '--queries', '--days', '--min', '--pages', '--limit', '--json', '--levels', '--metros', '--metro', '--gap', '--all-titles'];
const VALUED = ['--queries', '--days', '--min', '--pages', '--limit', '--levels', '--metro', '--gap'];

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: FLAGS, valued: VALUED, argv });

  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const has = name => args.includes(`--${name}`);

  const days = Number(flag('days', 7));
  const pages = Number(flag('pages', 8));
  const min = Number(flag('min', 1));
  const limit = Number(flag('limit', 0));
  const asJson = has('json');
  const levels = flag('levels', DEFAULT_LEVELS) === 'any' ? '' : String(flag('levels', DEFAULT_LEVELS));
  const gap = Number(flag('gap', 1200));
  // Metro names carry commas ("Austin, Texas Metropolitan Area"), so a list
  // with a ';' in it is split on ';' only.
  const metroList = String(flag('metro', ''));
  const places = metroList
    ? metroList.split(metroList.includes(';') ? ';' : ',').map(s => s.trim()).filter(Boolean).map(name => ({ name, location: name }))
    : has('metros') ? [UNITED_STATES, ...METROS] : [UNITED_STATES];
  const queries = flag('queries', '')
    ? String(flag('queries', '')).split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_QUERIES;

  if (!asJson) {
    console.log(`\n  Reading LinkedIn's public job search — ${queries.length} searches × ${places.length} place${places.length === 1 ? '' : 's'}, last ${days} days, levels ${levels || 'any'}.\n`);
  }

  const { postings, requests, errors, throttled, unfinished } = await harvest(queries, {
    days, pages, levels, places, gap,
    onProgress: asJson ? null : ({ label, fresh, total }) => console.log(`    ${String(total).padStart(5)} postings  +${String(fresh).padStart(3)}  ${label}`),
  });
  // THE HARVEST IS KEPT, AND EVERY COMPANY IN IT GOES IN THE LEDGER (F-701).
  // 2026-10-03: a run collected 1,950 postings and 624 untracked companies,
  // was killed for memory 25 names into the resolver, and kept nothing — the
  // names existed only in a console log. Saved first, before anything slow.
  if (!asJson) {
    try {
      const dir = path.join(ROOT, 'data', 'jarvis', 'harvests');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `linkedin-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
      writeFileSync(file, JSON.stringify(postings));
      console.log(`  harvest saved → ${path.relative(ROOT, file)}`);
    } catch (e) { console.log(`  ⚠ harvest not saved: ${e.message}`); }
  }
  let ledger = null;
  try {
    const u = await import('./universe.mjs');
    ledger = { u, db: u.openUniverse() };
    const byCompany = new Map();
    for (const p of postings) {
      if (!p.company) continue;
      if (!byCompany.has(p.company)) byCompany.set(p.company, { name: p.company, titles: [], count: 0 });
      const e = byCompany.get(p.company);
      e.count++;
      if (e.titles.length < 8) e.titles.push(p.title);
    }
    // Only employers with hardware work among what they posted (F-528): a
    // keyword search also returns banks and building-services firms.
    const r = u.ingest(ledger.db, [...byCompany.values()].filter(e => e.titles.some(t => worthTracking(t))), 'linkedin');
    u.sync(ledger.db);
    if (!asJson) console.log(`  ledger: ${r.added} new employer(s), ${r.seen} seen again`);
  } catch (e) { if (!asJson) console.log(`  ⚠ coverage ledger not updated: ${e.message}`); }

  const tracked = trackedNamesFromPortals();
  // A company is reported only when something it posted is hardware work (F-528).
  let fresh = newCompanies(postings, tracked, { min, relevantOnly: !has('all-titles') });
  if (limit > 0) fresh = fresh.slice(0, limit);

  if (asJson) {
    console.log(JSON.stringify({ postings: postings.length, requests, errors, throttled, unfinished, tracked: tracked.length, companies: fresh }, null, 1));
  } else {
    console.log(`\n  ${postings.length} postings over ${requests} requests${errors ? ` (${errors} refused)` : ''}.`);
    if (throttled) {
      console.log(`\n  ⚠ LinkedIn stayed rate-limited. ${unfinished.length} searches NEVER RAN, so this list is partial:`);
      console.log(`    ${unfinished.slice(0, 12).join(' · ')}${unfinished.length > 12 ? ` … +${unfinished.length - 12}` : ''}\n`);
    }
    console.log(`  ${tracked.length} companies already tracked.`);
    console.log(`  ${fresh.length} companies NOT tracked, with ${min}+ matching postings:\n`);
    for (const c of fresh) {
      console.log(`    ${String(c.count).padStart(3)}  ${c.name}`);
      console.log(`         ${c.titles.slice(0, 2).join(' · ')}${c.locations[0] ? `  [${c.locations[0]}]` : ''}`);
    }
  }

  if (!has('write')) {
    ledger?.db.close();
    if (!asJson) {
      console.log(`\n  (report only — re-run with --write to resolve these boards and track them)`);
      console.log(`  Or hand a subset to the resolver yourself:`);
      console.log(`    node jarvis/discover-ats.mjs --names "${fresh.slice(0, 5).map(c => c.name).join(',')}" --write\n`);
    }
    return 0;
  }

  // --write delegates rather than reimplementing. discover-ats is the only
  // thing that may touch portals.yml, and it VERIFIES a board with a live API
  // call before writing it — a LinkedIn company name is a hint, not a source.
  if (!fresh.length) { ledger?.db.close(); console.log('\n  Nothing new to track.\n'); return 0; }
  // --names is comma-separated, and "American Honda Motor Company, Inc." is
  // one company. The slug guesser drops punctuation anyway.
  const plain = (name) => name.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  // Each company's published website, so the resolver can follow its careers
  // page to a board no slug reaches (F-657).
  console.log(`\n  Reading the website on ${fresh.filter(c => c.companyUrl).length} company pages…`);
  const sites = await companyWebsites(fresh, { gap });
  console.log(`  ${sites.size} website(s) found. Handing ${fresh.length} names to discover-ats for verification…\n`);
  if (ledger) {
    // Through the ledger, so every answer is recorded — a miss is retried in a
    // month, a tracked one never again — and a killed run is replayed.
    const list = fresh.map(c => ({ name: plain(c.name), site: sites.get(c.name) || '' }));
    const counts = await ledger.u.resolveNames(ledger.db, list, { write: true });
    ledger.u.sync(ledger.db);
    console.log(`\n  settled: ${JSON.stringify(counts)}`);
    console.log(`  ${ledger.u.coverageLine(ledger.u.coverage(ledger.db))}`);
    ledger.db.close();
    return 0;
  }
  const { spawnSync } = await import('node:child_process');
  const extra = [];
  if (sites.size) {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-sites-')), 'sites.json');
    writeFileSync(file, JSON.stringify([...sites].map(([name, site]) => ({ name: plain(name), site }))));
    extra.push('--sites-file', file);
  }
  console.log(`  ${sites.size} website(s) found. Handing ${fresh.length} names to discover-ats for verification…\n`);
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'jarvis', 'discover-ats.mjs'),
    '--names', fresh.map(c => plain(c.name)).join(','),
    ...extra,
    '--write',
  ], { stdio: 'inherit' });
  return r.status ?? 0;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
