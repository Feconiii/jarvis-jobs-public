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

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { guardArgs } from './cli.mjs';

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
    --metro <list>     comma-separated location names, instead of the built-in metros
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
 * it. They cover the shapes of work his files actually evidence: mechanical
 * design, manufacturing and process engineering, equipment and test, robotics
 * and automation. Overlap between them is free; the harvest dedupes by posting
 * id and the same company surfacing under four searches is a signal, not waste.
 */
export const DEFAULT_QUERIES = [
  'robotics engineer', 'mechanical engineer new grad', 'manufacturing engineer new grad',
  'process engineer semiconductor', 'hardware engineer new grad', 'mechanical design engineer',
  'automation engineer', 'equipment engineer', 'test engineer mechanical',
  'systems engineer new grad', 'product engineer hardware', 'manufacturing engineer robotics',
  'mechatronics engineer', 'R&D engineer mechanical', 'integration engineer hardware',
  'field service engineer semiconductor', 'process engineer new grad', 'NPI engineer',
  'validation engineer hardware', 'tooling engineer', 'applications engineer robotics',
  'design engineer entry level', 'associate mechanical engineer', 'graduate engineer',
  // Added 2026-09-20 from the LinkedIn page he pasted, where none of the titles
  // that excited him carried a "new grad" tag: a twelve-person robotics company
  // writes "Mechanical Engineer", "Prototype Engineer", "Robotics Build
  // Engineer". These are the shapes of that work, still never a company name.
  'mechanical engineer robotics', 'humanoid robot mechanical', 'robotics hardware engineer',
  'prototype engineer', 'robotics build engineer', 'electromechanical engineer',
  'actuator design engineer', 'mechanism design engineer', 'opto-mechanical engineer',
  'mechanical engineer startup', 'hardware integration engineer', 'robot technician',
  'surgical robotics mechanical', 'lab automation engineer', 'mechanical engineer medical device',
  'mechanical engineer drone', 'eVTOL mechanical engineer', 'spacecraft mechanical engineer',
  'battery manufacturing engineer', 'fusion energy engineer', 'additive manufacturing engineer',
  'thermal engineer hardware', 'packaging engineer semiconductor', 'wafer fab equipment engineer',
  'consumer electronics product design engineer', 'reliability engineer hardware',
];

/**
 * Employers that are never worth tracking, whatever they post.
 *
 * Staffing agencies and job-board reposters are most of the noise in any
 * keyword search: they relist other companies' roles under their own name, so
 * tracking them adds duplicates with a worse apply path and no employer behind
 * them. Defense primes are excluded for the standing reason — an F-1 cannot
 * hold a clearance — and NOT because of export control, which stopped being a
 * disqualifier on 2026-09-19 (see jarvis/visa.mjs).
 *
 * This filter only decides what to TRACK. It never hides a posting; triage does
 * that, visibly, with the sentence it read.
 */
export const NEVER_TRACK = new RegExp([
  // staffing, recruiting and reposting
  'cybercoders', 'jobot', '\\balten\\b', 'aerotek', 'insight global', 'actalent', 'randstad',
  'kelly services', 'robert half', 'teksystems', 'motion recruitment', 'apex systems',
  'collabera', 'kforce', 'adecco', 'manpower', 'belcan', 'system one', 'staffing',
  'recruit', 'talent solutions', 'diverse lynx', 'mindlance', 'tata consultancy',
  'infosys', 'wipro', 'cognizant', 'accenture', 'capgemini', 'lensa', 'ziprecruiter',
  'careerbuilder', 'get\\.it', 'dice\\b', 'jobs?\\.', '\\bvetjobs\\b', 'executive search',
  'rex\\.zone', 'lofton', 'zobility', 'eteam\\b', 'jobs? (?:in|at|near)\\b',
  // Named one by one because no pattern catches them: these are IT- and
  // engineering-staffing shops that relist other companies' roles under their
  // own name. Every one was read and confirmed from its own postings on
  // 2026-09-19 rather than guessed at from the name.
  'bright vision', 'zenovo', 'cindavi', 'haveron james', 'newnovation', 'auxo talent',
  'ttn talent', 'green key', 'edison smart', 'lumicity', 'strativ', 'evona',
  'acceler8', 'pentangle', 'steneral', 'silverspace', 'info way', 'ls solutions',
  'dsm-h', 'mount kemble', 'brightpath', 'michael page', '\\blhh\\b', 'vaco',
  'aegis worldwide', 'sterling engineering', 'kcm technical', '\\bhti\\b', 'prosum',
  'quest global', 'hcltech', 'l&t technology', 'tata technologies', 'spectrum killian',
  'searchmasters', 'paradigm nat', '\\bcps, inc', 'ina solution', 'atem corp',
  'bn associates', 'westmag', 'omega technical', 'global connect technologies',
  'innorev', 'tiltedge', 'jbs technologies', 'pacific international',
  'val\\x27s services', 'roshay', 'teleperformance',
  // From the page he pasted on 2026-09-20. Raydar resolved to a live Workable
  // board with 186 postings and was tracked for four minutes before its titles
  // were read: "(Confidential) Director of Marketing", account executives in
  // every city. A name ending in "Search" is a search firm.
  'raydar', '\\bd24\\b', 'spectra360', 'programmers\\.io', '\\bsearch$', 'professional search',
  // From the per-metro harvest the same day: agencies, and the employers a
  // keyword search drags in that will never post his kind of role.
  'judge group', 'acro service', 'akkodis', 'personnel services', '\\bpersonnel\\b', 'talent\\b',
  '\\bbank\\b', 'insurance', '\\bgeico\\b', '\\baig\\b', '\\bllp\\b', '\\bpwc\\b', '^ey$', 'deloitte', 'kpmg',
  'towne park', 'cushman', '\\bcbre\\b', 'cypress hcm', 'htc global',
  // Building design and construction. Their "Mechanical Engineer" is HVAC and
  // plumbing for buildings, which his filters have excluded since the first day,
  // and the title alone cannot say so — Jacobs posted 31 of them in one harvest.
  '^jacobs\\b', 'kiewit', 'dlr group', '^hed$', 'mckinstry', 'bowman consulting', 'aecom',
  'burns (?:&|and) mcdonnell', 'black (?:&|and) veatch', 'stantec', '^wsp\\b', '^hdr\\b', '^arup\\b',
  'consulting engineers', 'building technologies', 'carollo', 'gray aes', '\\barchitects?\\b',
  'engineers (?:&|and) constructors', '\\bconstruction\\b',
  // Defense primes, weapons companies and the clearance-gated national labs.
  // These are filtered on the employer, not on anything the posting says — an
  // F-1 cannot hold a clearance and he does not want weapons work. Export
  // control is NOT why they are here; that stopped disqualifying anything on
  // 2026-09-19. Radiant, Vast, Impulse and Astrolab are deliberately absent.
  'lockheed', 'northrop', 'raytheon', '\\brtx\\b', 'blue origin', 'spacex', 'l3harris',
  'general dynamics', 'bae systems', 'booz allen', 'applied physics laborator', '\\bkbr\\b',
  'leidos', '\\bsaic\\b', 'mitre', 'peraton', '\\bcaci\\b', 'huntington ingalls',
  'general atomics', 'sandia', 'lawrence livermore', 'los alamos', 'lincoln laborator',
  'anduril', 'shield ai', 'firefly aerospace', 'collins aerospace', 'rocket lab',
  'sierra nevada', 'sierra space', 'kratos', 'epirus', 'castelion', 'ursa major',
  'aerovironment', 'x-bow', 'true anomaly', 'amentum', 'parsons', '\\bv2x\\b',
  'mercury systems', 'voyager technologies', 'aerospace corporation', 'draper',
  'battelle', 'textron', '\\bmoog\\b', 'elbit', 'qinetiq', 'overland ai', 'neros',
  // Weapons manufacture, by name and by word. "Defense" in a company's own name
  // is the company telling us what it builds, so it counts — but the word needs
  // its boundaries: an unanchored "ammo" matched "Mammoth Brands", a consumer
  // goods company, on the first run.
  '\\bdefen[cs]e\\b', '\\barmament', '\\bmunitions?\\b', '\\bordnance\\b', '\\bammo\\b',
  'firearms?\\b', 'sig sauer', 'smith *& *wesson', '\\bsturm,? ruger', '\\bcolt\\b',
  'barrett firearms', 'vista outdoor', 'winchester repeating',
].join('|'), 'i');

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
 * The metros where hardware and robotics companies cluster.
 *
 * A guest search returns the newest few hundred results and no more, so a
 * country-wide "mechanical engineer" is truncated long before it reaches a
 * twelve-person company in Pittsburgh. Asking per metro is how the same search
 * reaches past the cut. Named by LinkedIn's own location text rather than by
 * geoId — the text resolves on the guest endpoint, and a wrong id fails silent.
 */
export const METROS = [
  'San Francisco Bay Area', 'Los Angeles Metropolitan Area', 'Greater Boston',
  'Greater Seattle Area', 'Austin, Texas Metropolitan Area', 'New York City Metropolitan Area',
  'Greater Pittsburgh Region', 'San Diego Metropolitan Area', 'Denver Metropolitan Area',
  'Detroit Metropolitan Area', 'Greater Phoenix Area', 'Dallas-Fort Worth Metroplex',
  'Atlanta Metropolitan Area', 'Greater Chicago Area', 'Raleigh-Durham-Chapel Hill Area',
  'Salt Lake City Metropolitan Area', 'Portland, Oregon Metropolitan Area', 'Greater Minneapolis-St. Paul Area',
].map(name => ({ name, location: name }));

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
/**
 * Is this posting the kind of work that makes its EMPLOYER worth tracking?
 *
 * A keyword search is a hint, not a filter. "mechanical engineer" per city
 * returns Jacobs, Kiewit and thirty MEP consultancies — mechanical engineering
 * of buildings, which his filters have excluded from the first day — and
 * "systems engineer" returns a bank. Pass 2 on 2026-09-20 tracked GEICO, US
 * Bank and a valet-parking company off exactly that, 2,518 rows of insurance
 * agents and cash-vault processors, before the audit read their titles. So a
 * company is only worth resolving when something it posted is hardware work
 * and is not building services.
 */
export const HARDWARE_TITLE_RE = /\b(?:mechanical|mechatronic|electromechanical|robotic|manufacturing|hardware|automation|controls?|process|test|design|product|equipment|tooling|npi|r&d|systems?|thermal|propulsion|opto-?mechanical|quality|reliability|integration|prototype|build)\w*\b[^|]{0,40}\b(?:engineer|technician|designer)|\b(?:engineer|technician)\b[^|]{0,30}\b(?:mechanical|robotic|hardware|manufacturing)/i;
export const BUILDING_SERVICES_RE = /\b(?:hvac|mep\b|plumbing|piping|building|construction|commissioning|facilit(?:y|ies)|water|wastewater|civil|structural|architect|fire protection|energy modeling|refrigeration|utilities|substation|transmission line|it systems?|network|software|cloud|devops|salesforce|sap\b|servicenow|cyber)/i;
export const worthTracking = (title) => HARDWARE_TITLE_RE.test(title || '') && !BUILDING_SERVICES_RE.test(title || '');

export function newCompanies(postings, trackedNames, { min = 1, relevantOnly = false } = {}) {
  const tracked = new Set(trackedNames.map(companyKey).filter(Boolean));
  const found = new Map();
  for (const p of postings) {
    const key = companyKey(p.company);
    if (!key || tracked.has(key) || NEVER_TRACK.test(p.company)) continue;
    // Counted toward the company only when the posting itself is the work.
    if (relevantOnly && !worthTracking(p.title)) continue;
    if (!found.has(key)) found.set(key, { name: p.company, key, count: 0, titles: [], locations: new Set() });
    const e = found.get(key);
    e.count++;
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
  const places = flag('metro', '')
    ? String(flag('metro', '')).split(',').map(s => s.trim()).filter(Boolean).map(name => ({ name, location: name }))
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
  if (!fresh.length) { console.log('\n  Nothing new to track.\n'); return 0; }
  const { spawnSync } = await import('node:child_process');
  console.log(`\n  Handing ${fresh.length} names to discover-ats for verification…\n`);
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'jarvis', 'discover-ats.mjs'),
    // --names is comma-separated, and "American Honda Motor Company, Inc." is
    // one company. The slug guesser drops punctuation anyway.
    '--names', fresh.map(c => c.name.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()).join(','),
    '--write',
  ], { stdio: 'inherit' });
  return r.status ?? 0;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
