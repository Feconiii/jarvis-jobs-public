#!/usr/bin/env node
// jarvis/import-linkedin.mjs — the fallback for companies whose board we cannot
// reach.
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE MAIN ROUTE
// ────────────────────────────────────────────────
// discover-linkedin.mjs finds companies we do not track and hands them to
// discover-ats.mjs, which finds their real board. When that works it is
// strictly better than anything here: the board is the employer's own record,
// it carries the full description, the apply engine can drive it, and the
// scanner owns it from then on.
//
// It does not always work, and the reasons are not ones better guessing fixes.
// Measured 2026-09-19 over 22 companies:
//   • Phoenix Tailings links a Lever board from its careers page that returns
//     404 from Lever's public API.
//   • Radiant Nuclear's site answers 403 to every server request.
//   • portals.yml already had a "Radiant" — a UK cloud company — so the nuclear
//     one collided with it and was never scanned at all.
// One of 22 resolved. For the other 21 the LinkedIn copy is the only reachable
// record, and dropping it means he never sees the job.
//
// So this imports those postings, and ONLY those. A company whose board we can
// read is skipped here on purpose — importing it too would create a second,
// worse row for a posting we already have properly.
//
// ON CREATING ROWS FROM A HARVEST
// ───────────────────────────────
// The browser-assist path in this project never creates rows: a description
// arriving with no posting behind it would be an invention, so it is reported
// instead. That rule is about BODIES. This is different in the way that
// matters — the harvest here IS the posting record. Every row carries the
// posting's own LinkedIn URL, its title, its company and its full description
// as LinkedIn served them, and nothing is synthesised to fill a gap: a posting
// whose description comes back empty is counted and skipped, never invented.
//
// What these rows are NOT is applyable. LinkedIn keeps the employer's apply
// link behind a login wall, so the URL is a page for him to open, not a form
// the engine can fill. They are marked so the card says so.
//
// Usage:
//   node jarvis/import-linkedin.mjs --dry-run
//   node jarvis/import-linkedin.mjs                     # import what is new
//   node jarvis/import-linkedin.mjs --days 14 --pages 6
//   node jarvis/import-linkedin.mjs --queries "humanoid robotics"

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { guardArgs } from './cli.mjs';
import { htmlToText } from './text.mjs';
import { triage } from './triage.mjs';
import { upsertJobs, db } from './store.mjs';
import {
  harvest, companyKey, NEVER_TRACK, DEFAULT_QUERIES, worthTracking,
} from './discover-linkedin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const USAGE = `
  node jarvis/import-linkedin.mjs [options]

  Import LinkedIn postings for companies whose ATS board cannot be reached.
  Companies already in portals.yml are skipped — their board is the source.

    --dry-run          report what would be imported, write nothing
    --queries <list>   comma-separated searches (default: the built-in set)
    --days <n>         how far back to look (default 7)
    --pages <n>        pages per query, 10 postings each (default 8)
    --limit <n>        stop after n postings
    --from <file>      read postings from a saved harvest instead of searching again
    --only <company>   import only this company out of the harvest
    --as <name>        store it under this name, and import it even though a
                       DIFFERENT company of the same name is tracked
    --json             machine-readable output
`;

/** LinkedIn's public detail endpoint for one posting. */
export function postingUrl(id) {
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;
}

/**
 * Pull the description and the criteria block out of a served posting page.
 *
 * The criteria block ("Seniority level", "Employment type", "Job function") is
 * appended to the body rather than dropped: triage reads seniority out of the
 * text, and LinkedIn states it explicitly where most boards only imply it.
 *
 * @returns {{description: string, criteria: string[]}}
 */
export function parsePosting(html) {
  const src = String(html || '');
  const markup = (src.match(/class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  const criteria = [...src.matchAll(
    /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g,
  )].map(m => `${htmlToText(m[1])}: ${htmlToText(m[2])}`.replace(/\s+/g, ' ').trim());
  return { description: htmlToText(markup), criteria };
}

/** One posting's full text, or null when LinkedIn serves nothing usable. */
export async function fetchPosting(id, { fetchImpl = fetch, pause = (ms) => new Promise(r => setTimeout(r, ms)), backoff = 45_000, retries = 4 } = {}) {
  let html;
  // A rate limit is not an empty posting (F-509). This returned null on a 429,
  // the caller counted it as "description came back empty", and a throttled
  // import quietly dropped most of what it had found. Waited out, asked again.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetchImpl(postingUrl(id), { headers: { 'user-agent': UA, accept: 'text/html' } });
      if (r.ok) { html = await r.text(); break; }
      if ((r.status !== 429 && r.status !== 999) || attempt >= retries) return null;
    } catch { return null; }
    await pause(backoff * 2 ** attempt);
  }
  const { description, criteria } = parsePosting(html);
  // A posting with no body is not a posting we can judge, and a row with an
  // empty description would sail through triage unflagged and land in his deck
  // looking like a clean fit. Reported, never invented.
  if (!description) return null;
  return { description, criteria };
}

// ── deciding what to import ─────────────────────────────────────────

const words = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2));

/** Title overlap, the same measure the LinkedIn/store diff uses. */
export function titleOverlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}

/**
 * Split a harvest into what to import and why the rest was left out.
 *
 * `trackedKeys` are companies whose board the scanner already reads, and
 * `storeRows` are the postings it has read from them. Both are passed in rather
 * than read here so the tests need neither portals.yml nor a database.
 */
/**
 * WHEN TWO COMPANIES SHARE A NAME.
 *
 * portals.yml tracks "Radiant" and "Radiant Industries", and both are a UK
 * cloud and datacentre company. Radiant Industries of El Segundo, which builds
 * portable nuclear microreactors and posted four reqs naming his exact
 * graduation window, is a different company that happens to share the name. The
 * tracked-company check cannot tell them apart, so it skipped the nuclear one
 * as "already covered" — and because its own site answers 403 to every server
 * request, nothing else reaches it either. It was invisible from both ends.
 *
 * `--only` selects a company out of the harvest by name and `--as` stores it
 * under a name that does not collide. Both are deliberate, one company at a
 * time: guessing which of two same-named companies a posting belongs to is not
 * something to automate.
 */
/**
 * Is this posting already in the store under a company whose name leads, or is
 * led by, this one? Both halves are required: the name relation alone is how
 * two different companies get merged, and the title alone matches every
 * "Mechanical Engineer" in the store.
 */
export function isAliasDuplicate(key, title, byCompany) {
  if (!key || key.length < 5) return false;
  for (const [other, titles] of byCompany) {
    if (other === key || other.length < 5) continue;
    if (!other.startsWith(key) && !key.startsWith(other)) continue;
    if (titles.some(t => titleOverlap(title, t) >= 0.8)) return true;
  }
  return false;
}

export function selectImportable(postings, { trackedKeys = new Set(), storeRows = [], only = '', as = '' } = {}) {
  const byCompany = new Map();
  for (const r of storeRows) {
    const k = companyKey(r.company);
    if (!k) continue;
    if (!byCompany.has(k)) byCompany.set(k, []);
    byCompany.get(k).push(r.title);
  }

  const onlyKey = only ? companyKey(only) : '';
  const take = [], skipped = { tracked: 0, filtered: 0, alreadyHave: 0, notSelected: 0 };
  for (const raw of postings) {
    const p = as && (!onlyKey || companyKey(raw.company) === onlyKey) ? { ...raw, company: as } : raw;
    if (onlyKey && companyKey(raw.company) !== onlyKey) { skipped.notSelected++; continue; }
    const key = companyKey(p.company);
    if (!key) { skipped.filtered++; continue; }
    if (NEVER_TRACK.test(p.company)) { skipped.filtered++; continue; }
    // The board is the better source. If we can read it, this row would only
    // be a second, worse copy of a posting we already get properly. `--as`
    // overrides that, because it means the tracked company of this name is a
    // DIFFERENT company and the board we read is not this employer's.
    if (!as && trackedKeys.has(key)) { skipped.tracked++; continue; }
    const titles = byCompany.get(key) || [];
    if (titles.some(t => titleOverlap(p.title, t) >= 0.6)) { skipped.alreadyHave++; continue; }
    // THE SAME EMPLOYER UNDER ANOTHER SPELLING (F-529). LinkedIn says "Intuitive"
    // and "Varda Space Industries"; portals.yml says "Intuitive Surgical" and
    // "Varda Space". The keys differ, so the tracked-company check above let
    // them through and 336 rows were imported as second, worse copies.
    //
    // A name rule cannot settle it — "Voltava" is not Volta, "Rochester
    // Electronics" is not Roche, and the nuclear Radiant is not the cloud one
    // (F-505). The POSTING can: when one name leads the other AND that company's
    // board already carries this title, it is the same job. When it does not,
    // the posting is imported, because a different employer or a job its board
    // does not show are both things he should see.
    if (!as && isAliasDuplicate(key, p.title, byCompany)) { skipped.alias = (skipped.alias || 0) + 1; continue; }
    take.push(p);
  }
  return { take, skipped };
}

/** Build the store row for one harvested posting. */
export function toStoreRow(posting, { description, criteria = [] }) {
  const body = criteria.length ? `${description}\n\n${criteria.join('\n')}` : description;
  return {
    url: posting.url,
    title: posting.title,
    company: posting.company,
    team: '',
    location: posting.loc || '',
    description: body,
    salary: null,
    postedAt: posting.posted ? Date.parse(`${posting.posted}T00:00:00Z`) || null : null,
    detailApi: null,
    source: 'linkedin',
    triage: triage({ title: posting.title, description: body, location: posting.loc || '', url: posting.url }),
    company_meta: {
      tier: 'linkedin',
      careers_url: '',
      // Said plainly, because it changes what he does with the card: the apply
      // engine cannot drive a LinkedIn URL, and no board of this company's own
      // was reachable to drive instead.
      notes: 'Found on LinkedIn; this company has no ATS board we can read. Apply on LinkedIn — the engine cannot fill this one.',
      sponsors_h1b: false,
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

const FLAGS = ['--dry-run', '--queries', '--days', '--pages', '--limit', '--json', '--only', '--as', '--from'];
const VALUED = ['--queries', '--days', '--pages', '--limit', '--only', '--as', '--from'];

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: FLAGS, valued: VALUED, argv });
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
  const has = n => args.includes(`--${n}`);

  const days = Number(flag('days', 7));
  const pages = Number(flag('pages', 8));
  const limit = Number(flag('limit', 0));
  const dryRun = has('dry-run');
  const asJson = has('json');
  const queries = flag('queries', '')
    ? String(flag('queries', '')).split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_QUERIES;

  const say = (...a) => { if (!asJson) console.log(...a); };
  say(`\n  Reading LinkedIn — ${queries.length} searches, last ${days} days.`);

  // --from reuses a harvest discover-linkedin already paid for. The guest
  // endpoint rate-limits by volume, and asking the same 500 pages twice in one
  // evening is how the second run comes back a quarter the size of the first.
  const from = flag('from', '');
  let postings, throttled = false, unfinished = [];
  if (from) {
    postings = JSON.parse(readFileSync(path.resolve(from), 'utf8')).postings || [];
    say(`  (from ${from} — LinkedIn's search is not asked again)`);
  } else {
    ({ postings, throttled, unfinished } = await harvest(queries, { days, pages }));
  }
  if (throttled) say(`  ⚠ LinkedIn stayed rate-limited: ${unfinished.length} searches never ran, so this import is partial.`);

  const cfg = yaml.load(readFileSync(path.join(ROOT, 'portals.yml'), 'utf8')) || {};
  const trackedKeys = new Set((cfg.tracked_companies || []).map(c => companyKey(c && c.name)).filter(Boolean));
  // Two columns across the whole store, read directly. The dedupe check needs
  // every company/title pair and nothing else, and pulling full rows for
  // 299,000 postings to compare two strings is the difference between a second
  // and a minute.
  const storeRows = db().prepare('SELECT company, title FROM jobs').all();

  let { take, skipped } = selectImportable(postings, { trackedKeys, storeRows, only: flag('only','') || '', as: flag('as','') || '' });
  // A search is a hint; the title is what was posted (F-528). A row imported
  // here has no board behind it and the engine cannot drive it, so it has to
  // earn its place: hardware work, not building services, not a bank's
  // "Systems Engineer". --only names a company on purpose and is left alone.
  const before = take.length;
  if (!flag('only', '')) take = take.filter(p => worthTracking(p.title));
  const offTopic = before - take.length;
  if (limit > 0) take = take.slice(0, limit);
  if (offTopic) say(`  ${offTopic} left out: the title is not hardware work.`);

  say(`  ${postings.length} postings. ${skipped.tracked} at companies whose board we read, ` +
      `${skipped.alreadyHave} already in the store, ${skipped.filtered} filtered.`);
  say(`  ${take.length} to fetch in full.\n`);

  const rows = [];
  let empty = 0;
  for (const p of take) {
    const body = await fetchPosting(p.id);
    if (!body) { empty++; continue; }
    rows.push(toStoreRow(p, body));
    await new Promise(r => setTimeout(r, 1200));
  }

  const blocked = rows.filter(r => r.triage.flags.hardBlock).length;
  if (asJson) {
    console.log(JSON.stringify({
      harvested: postings.length, selected: take.length, withBody: rows.length,
      noBody: empty, hardBlocked: blocked, dryRun,
      companies: [...new Set(rows.map(r => r.company))],
    }, null, 1));
  } else {
    console.log(`  ${rows.length} postings with a readable description` +
      `${empty ? `, ${empty} served none and were skipped` : ''}.`);
    console.log(`  ${blocked} hard-blocked on work authorization.`);
    console.log(`  ${new Set(rows.map(r => r.company)).size} companies.\n`);
    for (const r of rows.slice(0, 30)) {
      console.log(`    ${r.company} — ${r.title}  [${r.location}]`);
    }
    if (rows.length > 30) console.log(`    …and ${rows.length - 30} more`);
  }

  if (dryRun) { say(`\n  (dry run — nothing written)\n`); return 0; }
  if (!rows.length) { say(`\n  Nothing to import.\n`); return 0; }

  const { added, updated } = upsertJobs(rows);
  say(`\n  Store updated: ${added} added, ${updated} updated.`);
  say(`  Run \`node jarvis/dedupe.mjs\` if any of these also arrive from a board later.\n`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
