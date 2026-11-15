#!/usr/bin/env node
// jarvis/reboard.mjs — a big employer read through a thin board gets its real
// board (F-713).
//
// The resolver stops at the first board that answers. For Caterpillar that was
// a SmartRecruiters account with one posting, while its real site is a Workday
// tenant with hundreds; Microchip, Pentair, ITT and Parker Hannifin were the
// same. Every one counted as "tracked" in the coverage line, so nothing ever
// went back. 450 entries even carry the resolver's own "UNVERIFIED: only a
// handful of postings" note, and nobody re-checked them.
//
// This pass asks, of every employer we have reason to think is big, whether we
// read a believable number of its postings, and if not, looks for the board it
// actually uses:
//
//   1. Simplify's public new-grad list (github.com/SimplifyJobs/New-Grad-Positions):
//      people there file each posting under the company that published it, and
//      the posting URL names the board — cat.wd5.myworkdayjobs.com/CaterpillarCareers.
//   2. The company's own careers page (the same follow-the-link path the resolver uses).
//   3. A Workday tenant named after the company.
//
// A new board replaces the old one only when it is clearly the main one: at
// least 25 postings and three times what the old board gave. The entry keeps
// its name, so everything he decided on it stays attached; its notes record
// what it pointed at before.
//
// "Big" is any of: an S&P 1500 company outside finance and real estate, an
// employer with 10+ certified H-1B engineering petitions, or one Simplify has
// filed 3+ postings for in the past year.
//
// Usage:
//   node jarvis/reboard.mjs                 # report what would change
//   node jarvis/reboard.mjs --write         # repoint / add the boards found
//   node jarvis/reboard.mjs --only "Caterpillar,Microchip"
//   node jarvis/reboard.mjs --apply --skip "Beth Israel Lahey Health"   # write the reviewed dry run

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { guardArgs } from './cli.mjs';
import { GENERIC_HEADS } from './universe.mjs';
import { discovery } from './targeting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTALS = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const CACHE = path.join(ROOT, 'data', 'cache');
const SIMPLIFY_FILE = path.join(CACHE, 'simplify-listings.json');
const FOUND_FILE = path.join(ROOT, 'data', 'jarvis', 'reboard-found.json');
const SIMPLIFY_URL = 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json';
const DAY = 86400000;

/** A board this good replaces a thin one. */
export const REPLACE_MIN = 25;
export const REPLACE_RATIO = 3;
/** Below this many open postings, a big employer's board is suspect — an S&P 500 company's below 100. */
export const THIN_OPEN = 15;
export const THIN_OPEN_LARGE = 100;
/** A big employer whose board has shown nothing new for this long has probably moved. */
export const STALE_DAYS = 45;

/** Should this tracked board be re-checked? Pure. */
export function isSuspect({ open, large, lastSeenDays }) {
  if (open < (large ? THIN_OPEN_LARGE : THIN_OPEN)) return true;
  return Number.isFinite(lastSeenDays) && lastSeenDays > STALE_DAYS;
}
/** A new employer is tracked from this many postings, like the resolver's own bar. */
export const ADD_MIN = 10;

// S&P sectors and sub-industries with no surface for the person's field,
// whatever their size — the preset's (for hardware: finance, real estate,
// media, and the sub-industries with no mechanical-engineering surface). A
// preset may leave either out (null): nothing is skipped.
const SKIP_SECTOR = discovery.skipSectorRe || null;
const SKIP_SUB = discovery.skipSubRe || null;
/** Simplify's categories that count as the person's field (hardware: /hardware/i). */
const FIELD_CATEGORY = discovery.simplifyCategoryRe;

// ── pure parts ──────────────────────────────────────────────────────

/**
 * Simplify's listings, by company key: the posting URLs (which name the board),
 * and how many postings it filed in the past year (US, any category).
 * @returns {Map<string, {name: string, urls: string[], recent: number, hardware: number}>}
 */
export function simplifyBoards(listings, keyOf, now = Date.now()) {
  const out = new Map();
  const US = /, [A-Z]{2}$|United States|USA|Remote in US/;
  for (const r of Array.isArray(listings) ? listings : []) {
    const name = String(r?.company_name || '').trim();
    const key = keyOf(name);
    if (!key || !r.url) continue;
    let e = out.get(key);
    if (!e) out.set(key, (e = { name, urls: new Set(), recent: 0, hardware: 0 }));
    e.urls.add(String(r.url));
    const fresh = now - Number(r.date_posted || 0) * 1000 < 365 * DAY;
    const us = (r.locations || []).some((l) => US.test(l));
    if (fresh && us) {
      e.recent++;
      if (FIELD_CATEGORY.test(r.category || '')) e.hardware++;
    }
  }
  for (const e of out.values()) e.urls = [...e.urls];
  return out;
}

/**
 * The name a new entry gets. "Coca-Cola Company (The)" is Coca-Cola, but
 * "McCormick & Company" must not become "McCormick &", nor "Southern Company"
 * the ordinary word "Southern".
 */
export function displayName(name, plain) {
  const raw = String(name || '').replace(/\s*\(The\)\s*$/i, '').replace(/^The\s+/i, '').trim();
  const p = plain(raw);
  const words = p.split(/\s+/).filter(Boolean);
  if (/[&,-]$/.test(p) || (words.length === 1 && GENERIC_HEADS.has(words[0].toLowerCase()))) return raw;
  return p;
}

/** Is this found board clearly the employer's main one, against what we read now? */
export function isBetter(open, count, { adding = false } = {}) {
  if (!Number.isFinite(count)) return false;
  if (adding) return count >= ADD_MIN;
  return count >= REPLACE_MIN && count >= REPLACE_RATIO * Math.max(open, 1);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOARD_KEYS = ['provider', 'careers_url', 'api', 'orc_host', 'orc_site', 'pageup_instance', 'pageup_site', 'adp_ccids'];

/**
 * Point one portals.yml entry at a new board. Pure. The name, and anything
 * else hand-written on the entry, stays; the board fields are replaced; the old
 * board is written into the notes; a disabled entry is turned back on only when
 * it was disabled for being the wrong board.
 *
 * @returns {{text: string, changed: boolean, reason: string}}
 */
/** Where one entry sits in portals.yml text: from its "  - name:" line to the next one. */
export function entrySpan(text, name) {
  const head = new RegExp(`  - name: "?${esc(name)}"?[ \\t]*\\r?\\n`);
  const at = text.search(head);
  if (at === -1) return null;
  const next = text.slice(at + 1).search(/\r?\n  - name: /);
  return { at, end: next === -1 ? text.length : at + 1 + next };
}

export function repointEntry(text, name, entry, note) {
  const span = entrySpan(text, name);
  if (!span) return { text, changed: false, reason: 'not-found' };
  const { at, end } = span;
  const block = text.slice(at, end);
  const nl = /\r\n/.test(block) ? '\r\n' : '\n';
  const lines = block.split(/\r?\n/);
  const keep = lines.filter((l, i) => i === 0 || !new RegExp(`^    (${BOARD_KEYS.join('|')}):`).test(l));
  const fields = [];
  if (entry.provider) fields.push(`    provider: ${entry.provider}`);
  fields.push(`    careers_url: ${entry.careers_url}`);
  if (entry.api) fields.push(`    api: ${entry.api}`);
  for (const k of BOARD_KEYS.slice(3)) if (entry[k] !== undefined && entry[k] !== '') fields.push(`    ${k}: ${JSON.stringify(String(entry[k]))}`);
  keep.splice(1, 0, ...fields);
  let out = keep.join(nl);
  const stamp = String(note).replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  out = /^    notes: "/m.test(out)
    ? out.replace(/^(    notes: ")/m, (m, p1) => `${p1}${stamp} `)
    : out.replace(/^(    enabled: )/m, (m, p1) => `    notes: ${JSON.stringify(stamp)}${nl}${p1}`);
  out = out.replace(/^    enabled: false\b.*$/m, '    enabled: true');
  return { text: text.slice(0, at) + out + text.slice(end), changed: true, reason: 'ok' };
}

/** Disabled because the board was wrong (placeholder, other company) — not because the company is out of scope. */
export const wrongBoardDisable = (notes) => /placeholder|not this company|wrong (board|company)|demo postings/i.test(String(notes || ''));

// ── inputs ──────────────────────────────────────────────────────────

export async function simplifyListings({ refresh = false } = {}) {
  const fresh = existsSync(SIMPLIFY_FILE) && Date.now() - statSync(SIMPLIFY_FILE).mtimeMs < DAY;
  if (fresh && !refresh) return JSON.parse(readFileSync(SIMPLIFY_FILE, 'utf8'));
  try {
    const r = await fetch(SIMPLIFY_URL, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(SIMPLIFY_FILE, text);
    return JSON.parse(text);
  } catch (e) {
    console.error(`  ⚠ Simplify's list could not be fetched (${e.message}) — ${existsSync(SIMPLIFY_FILE) ? 'using the cached copy' : 'going on without it'}`);
    return existsSync(SIMPLIFY_FILE) ? JSON.parse(readFileSync(SIMPLIFY_FILE, 'utf8')) : [];
  }
}

function spIndex() {
  const out = [];
  const csv = path.join(CACHE, 'sp500-constituents.csv');
  if (existsSync(csv)) {
    for (const l of readFileSync(csv, 'utf8').trim().split('\n').slice(1)) {
      const cells = []; let cur = ''; let q = false;
      for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch; }
      cells.push(cur);
      out.push({ name: cells[1], sector: cells[2], sub: cells[3] || '', large: true });
    }
  }
  for (const f of ['sp400-constituents.json', 'sp600-constituents.json']) {
    const p = path.join(CACHE, f);
    if (!existsSync(p)) continue;
    try { for (const r of JSON.parse(readFileSync(p, 'utf8'))) out.push({ name: r.name, sector: r.sector || '', sub: r.sub || '' }); } catch { /* skip */ }
  }
  return out.filter((r) => r.name && !(SKIP_SECTOR && SKIP_SECTOR.test(r.sector)) && !(SKIP_SUB && SKIP_SUB.test(r.sub)));
}

// ── the search ──────────────────────────────────────────────────────

const SHARED_HOST = /myworkdayjobs\.com|myworkdaysite\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|icims\.com|oraclecloud\.com|bamboohr\.com|breezy\.hr|recruitee\.com|rippling\.com|eightfold\.ai|avature\.net|taleo\.net|successfactors|jobvite\.com|ultipro\.com|ukg\.net|paylocity\.com|adp\.com|dayforcehcm\.com|paycomonline/i;

/** Every board we can confirm for this employer, largest first. */
export async function boardsFor(c, d) {
  const found = [];
  const tried = new Set();
  const add = (hit, via) => { if (hit?.entry && Number(hit.count) > 0) found.push({ ...hit, via }); };
  // 1. Simplify's posting URLs. One link at a time, so a company with several
  // Workday sites (KLA files under "UR" and "AnnArbor") is measured site by site.
  const seenOrigins = new Set();
  for (const url of (c.simplify?.urls || []).slice(0, 40)) {
    add(await d.boardFromText(url, c.name, true, tried), c.via || 'simplify');
    let origin = '';
    try { origin = new URL(url).origin; } catch { continue; }
    if (SHARED_HOST.test(origin)) {
      // An Oracle site is read by the branded resolver from the link itself.
      if (/oraclecloud\.com/.test(origin) && !seenOrigins.has(url.replace(/\/job\/.*$/, ''))) {
        seenOrigins.add(url.replace(/\/job\/.*$/, ''));
        add(await d.resolveBranded([url], '', c.name), c.via || 'simplify');
      }
      continue;
    }
    if (seenOrigins.has(origin)) continue;
    seenOrigins.add(origin);
    // jobs.keysight.com, careers.garmin.com: the company's own careers host.
    add(await d.resolveBranded([url], url, c.name, { fetchPage: d.fetchPage }), c.via || 'simplify');
  }
  // 2. The company's own site — only one the company published, never a guessed lookup.
  if (c.site && c.siteTrusted) {
    const hit = await d.resolveViaCareersPage(c.site, c.name, { authoritative: true }).catch(() => null);
    add(hit, 'careers page');
  }
  // 2b. No published site: www.<name>.com, as a guess — a board it links must
  // carry the company's name or be a Workday tenant named after it.
  if (!(c.site && c.siteTrusted) && !found.some((f) => f.count >= REPLACE_MIN)) {
    const strong = d.slugCandidates(c.name).filter((x) => x.strong)[0];
    const guess = c.site || (strong ? `https://www.${strong.slug}.com` : '');
    if (guess) add(await d.resolveViaCareersPage(guess, c.name, { authoritative: false }).catch(() => null), 'careers page (guessed)');
  }
  // 2c. A careers host named after the company: seagatecareers.com,
  // corningjobs.corning.com, careers.<name>.com. Every one is a guess, so its
  // front page must name the company before its board is believed.
  if (!found.some((f) => f.count >= REPLACE_MIN)) {
    // Weak slugs too ("seagate" for Seagate Technology): the front page has to name the company anyway.
    const strong = d.slugCandidates(c.name).filter((x) => !x.slug.includes('-')).slice(0, 3);
    const origins = [...new Set(strong.flatMap(({ slug: s }) => [
      `https://${s}careers.com`, `https://${s}jobs.com`, `https://careers.${s}.com`, `https://jobs.${s}.com`,
      `https://${s}jobs.${s}.com`, `https://${s}careers.${s}.com`,
    ]))];
    for (const o of origins) {
      const html = await d.fetchPage(`${o}/`);
      if (!html || !d.nameEvidence(html, c.name)) continue;
      add(await d.brandedOrigin(o, c.name).catch(() => null), 'careers host');
      if (found.some((f) => f.count >= REPLACE_MIN)) break;
    }
  }
  // 3. A Workday tenant named after the company.
  if (!found.some((f) => f.count >= REPLACE_MIN)) {
    for (const cand of d.slugCandidates(c.name).filter((s) => s.strong).slice(0, 4)) {
      add(await d.probeWorkday(cand, c.name).catch(() => null), 'workday probe');
      if (found.some((f) => f.count >= REPLACE_MIN)) break;
    }
  }
  const norm = (u) => String(u || '').toLowerCase().replace(/\/+$/, '');
  const unique = new Map();
  for (const f of found) {
    const k = norm(f.entry.careers_url);
    if (!unique.has(k) || unique.get(k).count < f.count) unique.set(k, f);
  }
  return [...unique.values()].sort((a, b) => b.count - a.count);
}

/** What boardsFor needs: the resolver's probes, the branded-site readers and a page fetch. */
export async function makeDeps() {
  const ats = await import('./discover-ats.mjs');
  const branded = await import('./branded-boards.mjs');
  const fetchPage = async (url) => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' } }); return r.ok ? await r.text() : ''; } catch { return ''; }
  };
  return { ...ats, resolveBranded: branded.resolveBranded, brandedOrigin: branded.brandedOrigin, fetchPage };
}

export async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

async function main(argv) {
  const USAGE = `
  node jarvis/reboard.mjs [--write] [--only "A,B"] [--limit N] [--concurrency N] [--refresh]
  node jarvis/reboard.mjs --apply [--skip "A,B"]     write the last dry run's finds, minus any rejected

  For every big employer, check that the board we read gives a believable
  number of postings; if not, find its real board (Simplify's list, its own
  careers page, a Workday tenant) and, with --write, point the entry there.
  Big employers with no entry at all are looked for the same way and added.
`;
  const args = guardArgs({ usage: USAGE, flags: ['--write', '--only', '--limit', '--concurrency', '--refresh', '--apply', '--skip'], valued: ['--only', '--limit', '--concurrency', '--skip'], argv });
  const val = (f, dflt) => { const i = args.indexOf(f); return i === -1 ? dflt : args[i + 1]; };
  const write = args.includes('--write');
  const only = val('--only', '') ? new Set(String(val('--only')).split(',').map((s) => s.trim().toLowerCase())) : null;
  const limit = Number(val('--limit', 0)) || Infinity;
  const concurrency = Number(val('--concurrency', 4)) || 4;
  // undici's parser assertion is thrown outside any promise (F-636): one lost
  // request, which settles as a miss on its own timer — not a lost run.
  process.on('uncaughtException', (e) => {
    if (e?.code === 'ERR_ASSERTION' && /undici/.test(String(e.stack || ''))) { console.error('  ⚠ undici parser assertion (F-636) — one request lost, run continues'); return; }
    console.error(e);
    process.exit(1);
  });
  if (!process.env.JARVIS_FULL) { try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ } }

  const u = await import('./universe.mjs');
  const ats = await import('./discover-ats.mjs');
  if (args.includes('--apply')) {
    if (!existsSync(FOUND_FILE)) { console.error('  no dry run to apply — run node jarvis/reboard.mjs first'); return 1; }
    const skip = new Set(String(val('--skip', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
    const saved = JSON.parse(readFileSync(FOUND_FILE, 'utf8')).filter((h) => !skip.has(h.name.toLowerCase()));
    console.log(`applying ${saved.length} board(s) from the last dry run${skip.size ? ` (${skip.size} skipped)` : ''}`);
    return applyFound(saved, { u, ats });
  }
  const d = await makeDeps();

  const entries = u.portalsEntries(PORTALS);
  const open = new Map(u.storeRows().map((r) => [r.name.toLowerCase(), r.count]));
  const { DatabaseSync } = await import('node:sqlite');
  const jdb = new DatabaseSync(path.join(ROOT, 'data', 'jarvis', 'jobs.db'), { readOnly: true });
  const lastSeen = new Map(jdb.prepare('SELECT lower(company) c, max(first_seen) last FROM jobs GROUP BY lower(company)').all().map((r) => [r.c, r.last]));
  jdb.close();
  const sim = simplifyBoards(await simplifyListings({ refresh: args.includes('--refresh') }), (n) => u.keyOf(u.plainName(n)));
  const sp = spIndex();
  const led = u.openUniverse();
  const ledgerRows = led.prepare(`SELECT key, name, state, tracked_as, evidence, hardware, site, site_source, listing, listing_count FROM employers`).all();
  led.close();

  const entryKeys = new Map();   // alias key -> entry
  for (const e of entries) for (const toks of u.aliasesOf(e.name)) entryKeys.set(toks.join(''), e);
  const ledgerByAs = new Map();
  for (const r of ledgerRows) if (r.tracked_as && !r.tracked_as.startsWith('board:')) {
    const p = ledgerByAs.get(r.tracked_as);
    if (!p || r.evidence > p.evidence) ledgerByAs.set(r.tracked_as, r);
  }
  const ledgerByKey = new Map(ledgerRows.map((r) => [r.key, r]));
  const spKeys = new Set(sp.map((r) => u.keyOf(u.plainName(r.name))));
  const largeKeys = new Set(sp.filter((r) => r.large).map((r) => u.keyOf(u.plainName(r.name))));
  const keyOfName = (n) => u.keyOf(u.plainName(n));
  const simFor = (n) => sim.get(keyOfName(n)) || null;
  const siteOf = (r) => (r && r.site ? { site: r.site, siteTrusted: r.site_source !== 'lookup' && r.site_source !== 'none' } : {});

  // A — tracked through a board that gives a big employer next to nothing.
  const cands = [];
  for (const e of entries) {
    const disabledWrong = e.enabled === false && wrongBoardDisable(e.notes);
    if (e.enabled === false && !disabledWrong) continue;
    // A find he or a review turned down stays turned down.
    if (/reboard: keep/i.test(e.notes || '')) continue;
    if (ats.isClearanceGated(e.name)) continue;
    const n = open.get(String(e.name).toLowerCase()) || 0;
    const k = keyOfName(e.name);
    const last = lastSeen.get(String(e.name).toLowerCase());
    const lastSeenDays = last ? (Date.now() - Date.parse(last)) / DAY : Infinity;
    if (!disabledWrong && !isSuspect({ open: n, large: largeKeys.has(k), lastSeenDays })) continue;
    const lr = ledgerByAs.get(e.name) || ledgerByKey.get(k);
    const s = simFor(e.name);
    const big = spKeys.has(k) || (lr && lr.evidence >= 10) || (s && s.recent >= 3) || /UNVERIFIED/.test(e.notes || '') && ((lr && lr.evidence >= 3) || (s && s.recent >= 1));
    if (!big) continue;
    // "Large" for the coverage line: an S&P 500 company. A startup Simplify lists
    // three postings for is big enough to re-check, not big enough to call a gap
    // (the ledger's evidence counts a small board's own postings too).
    cands.push({ kind: 'repoint', name: e.name, open: n, entry: e, simplify: s, large: largeKeys.has(k), ...siteOf(lr) });
  }
  // B — big employers with no entry at all.
  const seen = new Set(cands.map((c) => keyOfName(c.name)));
  const addCand = (name, extra = {}) => {
    const k = keyOfName(name);
    if (!k || seen.has(k) || entryKeys.has(k)) return;
    if (ats.isClearanceGated(name)) return;
    seen.add(k);
    const lr = ledgerByKey.get(k);
    if (lr && (lr.state === 'disabled' || lr.state === 'gated')) return;
    cands.push({ kind: 'add', name: displayName(name, u.plainName), open: 0, simplify: simFor(name), ...siteOf(lr), ...extra });
  };
  const hiresEngineers = (n) => {
    const lr = ledgerByKey.get(keyOfName(n));
    const s = simFor(n);
    return !!((lr && (lr.hardware || lr.listing === 'hiring-hw')) || (s && s.hardware >= 1));
  };
  for (const r of sp) if (hiresEngineers(r.name)) addCand(r.name, { sector: r.sector });
  for (const s of sim.values()) if (s.hardware >= 2) addCand(s.name);
  for (const r of ledgerRows) if (r.hardware && r.evidence >= 10 && r.state === 'no-board') addCand(r.name);
  for (const r of ledgerRows) if (r.state === 'no-board' && r.listing === 'hiring-hw' && r.listing_count >= 8) addCand(r.name);

  let todo = cands.filter((c) => !only || only.has(c.name.toLowerCase()) || [...only].some((o) => c.name.toLowerCase().startsWith(o)));
  todo = todo.slice(0, limit);
  console.error(`reboard: ${todo.filter((c) => c.kind === 'repoint').length} thin boards to re-check, ${todo.filter((c) => c.kind === 'add').length} big employers with no entry`);

  const results = [];
  let done = 0;
  await mapPool(todo, concurrency, async (c) => {
    const boards = await boardsFor(c, d).catch((e) => { console.error(`  ✗ ${c.name}: ${e.message}`); return []; });
    const best = boards[0];
    const sameAsOld = best && c.entry && String(best.entry.careers_url).replace(/\/+$/, '').toLowerCase() === String(c.entry.careers_url || '').replace(/\/+$/, '').toLowerCase();
    const ok = best && !sameAsOld && isBetter(c.open, best.count, { adding: c.kind === 'add' });
    results.push({ ...c, best, ok });
    done++;
    if (ok) console.error(`  ✓ ${c.kind === 'add' ? 'NEW ' : ''}${c.name}: ${c.open} → ${best.count} via ${best.provider} (${best.via}) ${best.entry.careers_url}`);
    if (done % 25 === 0) console.error(`  … ${done}/${todo.length}`);
  });

  const hits = results.filter((r) => r.ok);
  // Two employers landing on one board is one board (a parent and its unit).
  const byUrl = new Map();
  for (const h of hits.sort((a, b) => (a.kind === 'repoint' ? -1 : 1) - (b.kind === 'repoint' ? -1 : 1))) {
    const k = String(h.best.entry.careers_url).toLowerCase().replace(/\/+$/, '');
    const taken = entries.find((e) => String(e.careers_url || '').toLowerCase().replace(/\/+$/, '') === k);
    if (taken && taken.name !== h.name) { h.ok = false; h.dupeOf = taken.name; continue; }
    if (byUrl.has(k)) { h.ok = false; h.dupeOf = byUrl.get(k); continue; }
    byUrl.set(k, h.name);
  }
  const final = hits.filter((h) => h.ok);
  console.log(`\n${final.length} boards found (${final.filter((h) => h.kind === 'repoint').length} repointed, ${final.filter((h) => h.kind === 'add').length} new), ${results.length - final.length} left as they were`);
  for (const h of final.sort((a, b) => b.best.count - a.best.count)) {
    console.log(`  ${h.kind === 'add' ? 'add    ' : 'repoint'} ${h.name.padEnd(36)} ${String(h.open).padStart(4)} → ${String(h.best.count).padStart(5)}  ${h.best.provider.padEnd(16)} ${h.best.entry.careers_url}`);
  }
  const thinLeft = results.filter((r) => !r.ok && !r.dupeOf && r.kind === 'repoint');
  const dupes = results.filter((r) => r.dupeOf);
  if (dupes.length) console.log(`\nalready read under another name (${dupes.length}): ${dupes.map((r) => `${r.name} → ${r.dupeOf}`).join(', ')}`);
  if (thinLeft.length) console.log(`\nstill thin, no better board found (${thinLeft.length}): ${thinLeft.map((r) => `${r.name} (${r.open})`).join(', ')}`);

  // A full run records who is still only partly read, for the coverage line.
  if (!only && limit === Infinity) {
    const st = {
      at: new Date().toISOString(),
      thin: thinLeft.filter((r) => r.large && r.open < THIN_OPEN).map((r) => ({ name: r.name, open: r.open })),
      found: final.length,
    };
    try { writeFileSync(path.join(ROOT, 'data', 'jarvis', 'reboard-state.json'), JSON.stringify(st, null, 2)); } catch { /* a record */ }
    // The coverage line reads the thin list from the ledger itself.
    try { const db = u.openUniverse(); u.setMeta(db, 'reboard_thin', st.thin); db.close(); } catch (e) { console.error(`  ⚠ ledger not updated: ${e.message}`); }
  }
  // Every dry run is kept, so what was reviewed is exactly what --apply writes.
  const keep = final.map((h) => ({ kind: h.kind, name: h.name, open: h.open, sector: h.sector || '', entry: h.entry ? { careers_url: h.entry.careers_url || '', api: h.entry.api || '' } : null, best: h.best }));
  writeFileSync(FOUND_FILE, JSON.stringify(keep, null, 2));
  if (!write || !final.length) { if (final.length) console.log(`\nNothing written. Review, then: node jarvis/reboard.mjs --apply [--skip "A,B"]`); return 0; }
  return applyFound(final, { u, ats });
}

/** Write found boards into portals.yml (repoint or add) and the ledger. */
export async function applyFound(final, { u, ats }) {
  let text = readFileSync(PORTALS, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  const added = [];
  for (const h of final) {
    const entry = { ...h.best.entry, name: h.name };
    if (h.kind === 'repoint') {
      const note = `Repointed ${date} (F-713) to ${h.best.provider} (${h.best.count} postings live, found via ${h.best.via}) from ${h.entry.careers_url || h.entry.api || '?'}, which gave ${h.open}.`;
      const r = repointEntry(text, h.name, entry, note);
      if (r.changed) text = r.text; else console.error(`  ⚠ ${h.name}: entry ${r.reason}`);
    } else {
      added.push(ats.renderEntry({ ...h.best, entry, thin: false }, h.sector || '').replace(/(Auto-discovered via [^)]+\))\./, `$1. Found by reboard.mjs ${date} via ${h.best.via} (F-713).`));
    }
  }
  if (added.length) {
    const marker = '\ntracked_companies:';
    const at = text.indexOf(marker);
    if (at === -1) throw new Error('portals.yml has no tracked_companies: key');
    const block = `\n\n  # ── Big employers found by jarvis/reboard.mjs (${date}) ──\n${added.join('\n\n')}\n`;
    text = text.slice(0, at + marker.length) + block + text.slice(at + marker.length);
  }
  // A copy without the changed entries, so a --new-since scan reads exactly these.
  const before = path.join(ROOT, 'data', 'jarvis', 'reboard-before.yml');
  let beforeText = text;
  for (const h of final) {
    const span = entrySpan(beforeText, h.name);
    if (span) beforeText = beforeText.slice(0, span.at) + beforeText.slice(span.end);
  }
  writeFileSync(before, beforeText);
  writeFileSync(PORTALS, text);
  // The ledger learns the new ones now rather than at the next sync.
  const db = u.openUniverse();
  u.record(db, final.filter((h) => h.kind === 'add').map((h) => ({ name: h.name, outcome: 'tracked', url: h.best.entry.careers_url })));
  db.close();
  writeFileSync(path.join(ROOT, 'data', 'jarvis', 'reboard-last.json'), JSON.stringify(final.map((h) => ({ kind: h.kind, name: h.name, open: h.open, count: h.best.count, provider: h.best.provider, url: h.best.entry.careers_url, via: h.best.via })), null, 2));
  console.log(`\nportals.yml updated (${final.length}). Scan just these with: npm run jarvis:scan -- --new-since data/jarvis/reboard-before.yml`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((c) => process.exit(c || 0), (e) => { console.error(e); process.exit(1); });
}
