// jarvis/board-links.mjs — the board a copied posting links to (2026-11-07).
//
// Resurgent Industries posted "Mechanical Engineer (Entry-Level / Intern)" on
// its Ashby board (jobs.ashbyhq.com/resurgent-industries, 15 postings) and
// Jarvis never saw it. Simplify had listed one of its other postings, so the
// store held a row whose link NAMED that board, yet the ledger was handed only
// the company's name, the resolver's guesses ("resurgentindustries") missed the
// hyphen, and the employer was recorded as having no board.
//
// So every posting the store holds as a copy (Simplify, LinkedIn, Handshake,
// Runway), and every listing on Simplify's own list, gives its board link to
// the ledger: a board the link names, at an employer not already tracked,
// is checked with ONE live call (the resolver's own probe) and, when it
// answers, tracked like any other. The daily pass runs it inside the
// resolver's budget: each call made here is one fewer board check later.
//
// Usage:
//   node jarvis/board-links.mjs [--write] [--budget N] [--no-simplify-list] [--days 60]
//   (default is a dry run: what would be tracked, how many postings it brings)

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { boardLinksIn, workdayLinksIn, isClearanceGated } from './discover-ats.mjs';
import { NEVER_TRACK } from './hiring-signals.mjs';
import { keyOf, plainName, trackedIndex, matchTracked } from './universe.mjs';

const DAY = 86_400_000;
const JOBS_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'jarvis', 'jobs.db');

/** Sources whose rows are copies of a posting that lives on someone else's board. */
export const COPY_SOURCES = ['simplify', 'linkedin', 'handshake', 'runway'];

/** Ledger states that settle an employer: nothing here reopens them. */
const SETTLED = new Set(['tracked', 'disabled', 'gated']);

/** Every board a link names, as `provider:slug` / `workday:tenant.instance/site`. */
export function boardKeysIn(text) {
  const s = String(text || '');
  const keys = boardLinksIn(s).map(({ provider, slug }) => `${provider}:${slug}`);
  for (const w of workdayLinksIn(s)) keys.push(`workday:${w.tenant}.${w.instance}/${w.site}`.toLowerCase());
  return [...new Set(keys)];
}

/** The boards portals.yml already reads, enabled or not (a disabled board stays disabled). */
export function takenBoards(entries) {
  const out = new Set();
  for (const e of entries || []) for (const k of boardKeysIn(`${e.careers_url || ''} ${e.api || ''}`)) out.add(k);
  return out;
}

/**
 * Employers whose copied postings name a board we do not read yet.
 * rows: [{ company, url, via }]. `stateOf(key)` is the ledger's state for an
 * employer (optional). Largest first.
 */
export function linkCandidates(rows, { entries = [], stateOf = () => '' } = {}) {
  const taken = takenBoards(entries);
  const index = trackedIndex(entries);
  const by = new Map();
  for (const r of rows || []) {
    const name = plainName(String(r?.company || '').trim());
    const key = keyOf(name);
    if (!key || NEVER_TRACK.test(name)) continue;
    // Tracked (or disabled on purpose) under its own name: the scanner owns it.
    if (matchTracked(name, index)) continue;
    if (SETTLED.has(stateOf(key))) continue;
    // The clearance gate the resolver applies (discover-ats.mjs), on the name
    // and on the link, since a board slug is the company's own spelling of
    // itself (F-434: "Overland" vs ats.rippling.com/overland-ai).
    if (isClearanceGated(name, r.url)) continue;
    const keys = boardKeysIn(r.url).filter((k) => !taken.has(k));
    if (!keys.length) continue;
    let e = by.get(key);
    if (!e) by.set(key, (e = { name, key, postings: 0, boards: new Map(), via: new Set() }));
    for (const k of keys) if (!e.boards.has(k)) e.boards.set(k, String(r.url));
    e.postings++;
    if (r.via) e.via.add(r.via);
  }
  return [...by.values()]
    .map((e) => ({ name: e.name, key: e.key, postings: e.postings, boards: [...e.boards.keys()], links: [...e.boards.values()], via: [...e.via].join(',') }))
    .sort((a, b) => b.postings - a.postings || a.name.localeCompare(b.name));
}

/**
 * One live call per board, never more than `budget` in all. `probe(link, name)`
 * returns the resolver's hit ({ entry, provider, count }) or null. A board two
 * employers both link to is checked once and goes to the first.
 *
 * @returns {Promise<{ found: object[], misses: object[], calls: number, unchecked: object[] }>}
 */
export async function resolveLinks(cands, { probe, budget = Infinity } = {}) {
  const found = [], misses = [], unchecked = [];
  const claimed = new Set();
  let calls = 0;
  for (const c of cands) {
    let hit = null;
    let checked = false;
    for (let i = 0; i < c.boards.length && !hit; i++) {
      if (claimed.has(c.boards[i])) continue;
      if (calls >= budget) break;
      calls++;
      checked = true;
      claimed.add(c.boards[i]);
      const h = await probe(c.links[i], c.name).catch(() => null);
      if (h?.entry && Number(h.count) > 0) hit = { ...h, board: c.boards[i] };
    }
    if (hit) found.push({ ...c, hit });
    else if (checked) misses.push(c);
    else unchecked.push(c);
  }
  return { found, misses, calls, unchecked };
}

/** Simplify's own list as link rows: active, US, recent, the person's field. */
export function simplifyLinkRows(listings, { now = Date.now(), days = 60, fieldRe = /hardware/i, inUs = () => true } = {}) {
  const out = [];
  for (const l of listings || []) {
    if (!l?.active || l.is_visible === false || !l.url || !l.company_name) continue;
    if (!fieldRe.test(String(l.category || ''))) continue;
    if (now - Number(l.date_posted || 0) * 1000 > days * DAY) continue;
    if (!inUs(l.locations)) continue;
    out.push({ company: l.company_name, url: l.url, via: 'simplify-list' });
  }
  return out;
}

/**
 * Live copied rows in the store, US only, newest first and never more than
 * `limit`. By source alone, so the read SEARCHes the source index: the old
 * `tier = 'simplify' OR source IN (…)` scanned all 1.14 M rows (0.9 s, the
 * F-1021 class), and the 97 rows the tier added sit on boards we already read.
 */
export const STORE_LINK_SQL = `SELECT company, url, source AS via FROM jobs
  WHERE source IN (${COPY_SOURCES.map(() => '?').join(',')}) AND gone_at IS NULL AND location_bucket IS NOT 'non-us'
  ORDER BY first_seen DESC LIMIT ?`;
export function storeLinkRows(file = JOBS_DB, { limit = 20000 } = {}) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    return db.prepare(STORE_LINK_SQL).all(...COPY_SOURCES, limit);
  } finally { db.close(); }
}

/** The note a tracked entry carries, so whoever reads portals.yml knows where it came from. */
export function entryBlock(f, renderEntry, date = new Date().toISOString().slice(0, 10)) {
  return renderEntry({ ...f.hit, entry: { ...f.hit.entry, name: f.name } }, '')
    .replace(/(Auto-discovered via [^)]+\))\./, `$1. Found from a posting link (${f.via || 'copy'}) by board-links.mjs ${date}.`);
}

/**
 * The whole pass: gather, check, and (with write) track. Used by the CLI and
 * by universe.mjs daily, which hands it its open ledger and what is left of
 * the resolver's budget.
 */
export async function runLinks({ db, budget = 300, write = false, withSimplifyList = true, days = 60, entries: given, log = (s) => console.log(s) } = {}) {
  const u = await import('./universe.mjs');
  const ats = await import('./discover-ats.mjs');
  const entries = given ?? u.portalsEntries();
  // portalsEntries() answers [] for a missing or unparsable file; read as
  // "nothing is tracked", every tracked employer would look like a candidate.
  if (!entries.length) {
    log('  board links skipped: portals.yml read as empty');
    return { candidates: 0, found: [], misses: [], calls: 0, unchecked: [], postings: 0, written: [] };
  }
  const rows = storeLinkRows();
  if (withSimplifyList) {
    const { simplifyListings } = await import('./reboard.mjs');
    const { inUs } = await import('./coverage-meter.mjs');
    rows.push(...simplifyLinkRows(await simplifyListings(), { days, inUs }));
  }
  const state = db.prepare('SELECT state FROM employers WHERE key = ?');
  const cands = linkCandidates(rows, { entries, stateOf: (k) => state.get(k)?.state || '' });
  const probe = (link, name) => ats.boardFromText(link, name, true, new Set());
  const res = await resolveLinks(cands, { probe, budget });
  const postings = res.found.reduce((n, f) => n + Number(f.hit.count || 0), 0);
  log(`  board links: ${cands.length} employer(s) link a board we do not read; ${res.calls} checked (budget ${budget})`);
  log(`  → ${res.found.length} board(s) answer, ${postings} posting(s) live on them; ${res.misses.length} did not answer; ${res.unchecked.length} left for the next run`);
  for (const f of [...res.found].sort((a, b) => b.hit.count - a.hit.count).slice(0, 10)) {
    log(`    ${f.name}: ${f.hit.count} via ${f.hit.provider} ${f.hit.entry.careers_url} (${f.postings} linked, from ${f.via})`);
  }
  let written = [];
  if (write && res.found.length) {
    const block = res.found.map((f) => entryBlock(f, ats.renderEntry)).join('\n\n');
    const w = ats.appendToPortals(block);
    written = w.written;
    if (w.refused.length) log(`  already in portals.yml, left alone: ${w.refused.join(', ')}`);
    const ok = new Set(written.map((n) => n.toLowerCase()));
    const mine = res.found.filter((f) => ok.has(f.name.toLowerCase()));
    // record() only updates, so an employer the ledger has never met is added first.
    u.ingest(db, mine.map((f) => ({ name: f.name, titles: [], count: f.postings })), 'board-links');
    u.record(db, mine.map((f) => ({ name: f.name, outcome: 'tracked', url: f.hit.entry.careers_url })));
    log(`  tracked ${mine.length}: ${mine.map((f) => f.name).join(', ')}`);
  } else if (res.found.length) log('  (dry run — nothing written; --write tracks them)');
  return { candidates: cands.length, ...res, postings, written };
}

async function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const write = argv.includes('--write');
  const u = await import('./universe.mjs');
  if (write && !u.takeLock()) { console.log('  another resolve run holds the ledger — try again when it ends'); return 0; }
  const db = u.openUniverse();
  try {
    await runLinks({ db, write, budget: Number(flag('budget', 300)) || 300, withSimplifyList: !argv.includes('--no-simplify-list'), days: Number(flag('days', 60)) || 60 });
    if (write) u.sync(db);
  } finally { db.close(); }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((c) => process.exit(c || 0), (e) => { console.error(e); process.exit(1); });
}
