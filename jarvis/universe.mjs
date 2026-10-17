#!/usr/bin/env node
// jarvis/universe.mjs — the coverage ledger: every US employer known to hire
// engineers, and what happened when we went looking for its board.
//
// WHY THIS EXISTS (2026-10-03). "how tf dont we have anything for those????"
// A LinkedIn pass named 624 hiring companies portals.yml had never heard of —
// Garmin, Corning, Teradyne, Komatsu, Ultra Clean — and then the harness killed
// it for memory, 25 names into the resolver, and every name it had not reached
// was gone (F-701). Two failures, one cause: discovery was a thing a person
// ran by hand, and nothing remembered what it had seen. Coverage was bounded by
// a list nobody could measure, so every scan looked complete.
//
// So this keeps the list nobody kept: a table of employers, one row each, fed
// by every source that names US companies hiring engineers —
//
//   · lca       the Department of Labor's H-1B disclosure file (lca_employers in
//               the store): every employer that had an engineering petition
//               certified this year. For an F-1 student this is the universe
//               that matters most — companies that hire engineers AND sponsor.
//   · linkedin  each LinkedIn harvest, kept (discover-linkedin.mjs).
//   · sources   Built In, HN, YC, The Muse, Climatebase (discover-sources.mjs).
//   · store     companies with postings in the store but no tracked board
//               (LinkedIn and Handshake imports).
//   · names     any list handed over by hand.
//
// — and for each one, a state:
//
//   tracked    portals.yml has it (enabled), or its board turned out to be one
//              we already read under another name.
//   disabled   portals.yml has it, switched off on purpose (agency, wrong
//              company). Decided; never re-resolved.
//   gated      clearance / ITAR employer. Decided; never resolved.
//   pending    never looked for. The resolver takes these first.
//   no-board   looked for, nothing answered. Asked again after 30 days (3 when
//              a shared ATS was refusing us — F-444: a refusal is not absence).
//   partial    a Workday tenant without its site path. Asked again in 14 days.
//
// Coverage is then a NUMBER — tracked over everything not decided against —
// printed at the end of every scan and every daily run, so a backlog like
// 2026-10-03's is visible the day it starts instead of the night he runs out.
//
// Usage:
//   node jarvis/universe.mjs report [--pending 30]
//   node jarvis/universe.mjs seed --lca --store
//   node jarvis/universe.mjs seed --names-file <txt> --source linkedin [--sites-file <json>]
//   node jarvis/universe.mjs resolve [--budget 400] [--chunk 150] [--hardware-only] [--dry-run]
//   node jarvis/universe.mjs daily           # LinkedIn's last 2 days, then resolve
//
// The table lives in data/jarvis/universe.db, not jobs.db: a resolve run holds
// it for hours and a scan must never wait on it (the outreach.db lesson, F-597).

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { worthTracking, NEVER_TRACK } from './hiring-signals.mjs';
import { discovery } from './targeting.mjs';

// The `hardware` column and the "eng" counts keep their names; under another
// preset they mean "in the person's field" (worthTracking, lca socFamilies).
const FAMILY = discovery.familyNoun;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const UNIVERSE_DB = path.join(ROOT, 'data', 'jarvis', 'universe.db');
const JOBS_DB = path.join(ROOT, 'data', 'jarvis', 'jobs.db');
const PORTALS = path.join(ROOT, 'portals.yml');
const COVERAGE_LOG = path.join(ROOT, 'data', 'jarvis', 'coverage-log.jsonl');
// One LinkedIn guest-search page: a sweep that fills it saw only part of the employer.
export const LINKEDIN_PAGE = 10;

const DAY = 24 * 60 * 60 * 1000;
/** How long a settled answer stands before the board is looked for again. */
export const RETRY_DAYS = { 'no-board': 30, partial: 14, refused: 3 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS employers (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  site         TEXT NOT NULL DEFAULT '',
  sources      TEXT NOT NULL DEFAULT '',
  hardware     INTEGER NOT NULL DEFAULT 0,
  evidence     INTEGER NOT NULL DEFAULT 0,
  sample       TEXT NOT NULL DEFAULT '',
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending',
  tracked_as   TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT,
  next_attempt TEXT,
  outcome      TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT '',
  site_source  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS employers_state ON employers(state, hardware DESC, evidence DESC);
`;

export function openUniverse(file = UNIVERSE_DB) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 30000');
  if (String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase() !== 'wal') {
    try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* another opener did it */ }
  }
  db.exec(SCHEMA);
  // Columns added after the first rows were written.
  const cols = new Set(db.prepare('PRAGMA table_info(employers)').all().map((c) => c.name));
  if (!cols.has('platform')) db.exec("ALTER TABLE employers ADD COLUMN platform TEXT NOT NULL DEFAULT ''");
  if (!cols.has('site_source')) db.exec("ALTER TABLE employers ADD COLUMN site_source TEXT NOT NULL DEFAULT ''");
  // The LinkedIn sweep's answer for an employer with no readable board.
  if (!cols.has('listing')) db.exec("ALTER TABLE employers ADD COLUMN listing TEXT NOT NULL DEFAULT ''");
  if (!cols.has('listing_count')) db.exec('ALTER TABLE employers ADD COLUMN listing_count INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('listing_checked')) db.exec('ALTER TABLE employers ADD COLUMN listing_checked TEXT');
  return db;
}

// ── names ───────────────────────────────────────────────────────────

/**
 * Legal and corporate suffixes, which say nothing about WHICH company it is.
 * The H-1B file spells employers the way the petition did — "Rivian
 * Automotive, LLC", "Intuitive Surgical Operations, Inc." — and portals.yml
 * spells them the way a person would. Same list companyKey() strips, plus the
 * forms only a legal filing uses.
 */
const SUFFIX = new Set(['inc', 'llc', 'l', 'c', 'ltd', 'corp', 'corporation', 'company', 'co', 'group', 'holdings',
  'plc', 'gmbh', 'usa', 'us', 'u', 's', 'the', 'a', 'an', 'lp', 'llp', 'pllc', 'pc', 'na', 'incorporated', 'limited']);

/** Words of a company name, lower-case, '&' read as 'and', suffixes dropped. */
export function nameTokens(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !SUFFIX.has(w));
}

export const keyOf = (name) => nameTokens(name).join('');

/**
 * A name a person would type into a search, from a legal one. "Rivian
 * Automotive, LLC" → "Rivian Automotive"; "FORD MOTOR COMPANY" keeps its words
 * (the resolver lower-cases anyway). Only TRAILING suffixes go — "The Boeing
 * Company" must stay "The Boeing".
 */
export function plainName(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  const tail = /[,.]?\s+(inc|llc|l\.l\.c|ltd|corp|corporation|co|company|lp|llp|pllc|plc|incorporated|limited)\.?$/i;
  for (let i = 0; i < 3 && tail.test(s); i++) s = s.replace(tail, '').trim();
  return s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Every name a tracked entry answers to. "Alphabet (Google)" is also Google;
 * "Teradyne / Universal Robots" is both; "Intuitive Surgical — Manufacturing/
 * Process/Quality Engineer" is Intuitive Surgical.
 */
export function aliasesOf(entryName) {
  const raw = String(entryName || '');
  const out = new Set([raw]);
  const paren = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) { out.add(paren[1]); out.add(paren[2]); }
  const head = raw.split(/\s+[—–-]\s+/)[0];
  if (head) out.add(head);
  for (const part of raw.split(/\s+\/\s+/)) out.add(part);
  return [...out].map(nameTokens).filter((t) => t.length);
}

/**
 * Index of what portals.yml tracks, for matching. Disabled entries are kept:
 * a company turned off on purpose is decided, and must not come back as
 * "pending" (F-527 — deleting ICON's entry let the resolver re-add it).
 */
export function trackedIndex(entries) {
  const exact = new Map();
  const byFirst = new Map();
  for (const e of entries || []) {
    if (!e || !e.name) continue;
    const rec = { name: e.name, enabled: e.enabled !== false };
    for (const toks of aliasesOf(e.name)) {
      exact.set(toks.join(''), rec);
      if (!byFirst.has(toks[0])) byFirst.set(toks[0], []);
      byFirst.get(toks[0]).push({ toks, rec });
    }
  }
  return { exact, byFirst };
}

// One-word names that are a word, not a company. A tracked "International"
// must not answer for International Paper, nor "Constellation" for both
// Constellation Brands and Constellation Energy (F-713).
export const GENERIC_HEADS = new Set([
  'international', 'national', 'american', 'united', 'general', 'universal', 'southern', 'northern', 'western',
  'eastern', 'pacific', 'atlantic', 'constellation', 'archer', 'global', 'advanced', 'applied', 'integrated',
  'precision', 'standard', 'superior', 'premier', 'allied', 'continental', 'first', 'liberty', 'summit',
  'pioneer', 'central', 'digital', 'quantum', 'dynamic', 'dynamics', 'innovative', 'intelligent', 'modern',
  'north', 'south', 'east', 'west', 'atlas', 'apex', 'vector', 'delta', 'alpha', 'omega', 'phoenix', 'eagle',
  'titan', 'fusion', 'element', 'nova', 'zenith', 'crown', 'royal', 'star', 'sun', 'solar', 'energy', 'power',
  'scientific', 'technical', 'industrial', 'industries', 'systems', 'technologies', 'technology', 'solutions',
  'electric', 'mechanical', 'engineering', 'materials', 'products', 'manufacturing', 'medical', 'health',
]);

const startsWith = (long, short) => short.length <= long.length && short.every((w, i) => long[i] === w);

/**
 * Which tracked entry this name is, or null.
 *
 * Exact on the joined words first. Then WORD-prefix either way — "Rivian
 * Automotive" is the tracked "Rivian", and "Intuitive" (LinkedIn) is the
 * tracked "Intuitive Surgical" — but never a character prefix: "Applebee's"
 * is not Apple. A one-word prefix must be at least five letters, so "Arm" and
 * "Real" do not swallow every company that starts with them, and must not be an
 * ordinary word (GENERIC_HEADS), so "Constellation" is neither Constellation
 * Brands nor Constellation Energy.
 */
export function matchTracked(name, index) {
  const toks = nameTokens(name);
  if (!toks.length) return null;
  const hit = index.exact.get(toks.join(''));
  if (hit) return hit;
  for (const { toks: t, rec } of index.byFirst.get(toks[0]) || []) {
    const shorter = t.length <= toks.length ? t : toks;
    if (shorter.join('').length < 5) continue;
    // "International" is not International Paper (F-713): a one-word name that
    // is an ordinary word matches only exactly.
    if (shorter.length === 1 && GENERIC_HEADS.has(shorter[0])) continue;
    if (startsWith(toks, t) || startsWith(t, toks)) return rec;
  }
  return null;
}

export function portalsEntries(file = PORTALS) {
  try {
    const cfg = yaml.load(readFileSync(file, 'utf8')) || {};
    return Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : [];
  } catch { return []; }
}

// ── ingest ──────────────────────────────────────────────────────────

/**
 * Add or refresh employers. Each row: { name, site?, titles?: [], count? }.
 * A source adds evidence; it never downgrades a settled state.
 *
 * @returns {{ added: number, seen: number, skipped: number }}
 */
export function ingest(db, rows, source, { now = new Date().toISOString() } = {}) {
  const get = db.prepare('SELECT * FROM employers WHERE key = ?');
  const ins = db.prepare(`INSERT INTO employers (key, name, site, sources, hardware, evidence, sample, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE employers SET site = ?, sources = ?, hardware = ?, evidence = ?, sample = ?, last_seen = ? WHERE key = ?`);
  let added = 0, seen = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const name = plainName(r.name);
      const key = keyOf(name);
      // Staffing shops and resellers name other people's jobs; tracking their
      // board is how Raydar happened (F-509).
      if (!key || NEVER_TRACK.test(name)) { skipped++; continue; }
      const titles = (r.titles || []).filter(Boolean);
      const hw = titles.some((t) => worthTracking(t)) ? 1 : 0;
      const n = Number(r.count) || titles.length || 1;
      const prev = get.get(key);
      if (!prev) {
        ins.run(key, name, r.site || '', source, hw, n, titles.slice(0, 4).join(' | ').slice(0, 300), now, now);
        added++;
        continue;
      }
      const sources = [...new Set([...String(prev.sources).split(','), source].filter(Boolean))].join(',');
      upd.run(prev.site || r.site || '', sources, prev.hardware || hw, Math.max(prev.evidence, n),
        prev.sample || titles.slice(0, 4).join(' | ').slice(0, 300), now, key);
      seen++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, seen, skipped };
}

/**
 * Every employer with a certified H-1B petition in the person's SOC families
 * (`eng_certified`: the column kept its name; lca.mjs counts it from the
 * preset's socFamilies — for the hardware preset, engineering).
 */
export function lcaRows(jobsDbPath = JOBS_DB) {
  const db = new DatabaseSync(jobsDbPath, { readOnly: true });
  try {
    return db.prepare('SELECT name, eng_certified, top_titles FROM lca_employers WHERE eng_certified > 0').all()
      .map((r) => ({ name: r.name, count: r.eng_certified, titles: String(r.top_titles || '').split('|').map((t) => t.trim()) }));
  } finally { db.close(); }
}

/** Companies with live postings in the store, whatever read them in. */
export function storeRows(jobsDbPath = JOBS_DB) {
  const db = new DatabaseSync(jobsDbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    const rows = db.prepare(`SELECT company, count(*) AS n FROM jobs
      WHERE gone_at IS NULL AND location_bucket IS NOT 'non-us' GROUP BY company`).all();
    const titles = db.prepare('SELECT title FROM jobs WHERE company = ? AND gone_at IS NULL LIMIT 12');
    return rows.map((r) => ({ name: r.company, count: r.n, titles: titles.all(r.company).map((t) => t.title) }));
  } finally { db.close(); }
}

// ── state ───────────────────────────────────────────────────────────

/**
 * Bring every row in line with portals.yml: an employer the list now has is
 * tracked (or disabled); one whose entry has gone back to pending.
 */
export function sync(db, entries = portalsEntries()) {
  const index = trackedIndex(entries);
  const rows = db.prepare("SELECT key, name, state, tracked_as FROM employers WHERE state IN ('pending','tracked','disabled','no-board','partial')").all();
  const set = db.prepare('UPDATE employers SET state = ?, tracked_as = ? WHERE key = ?');
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const m = matchTracked(r.name, index);
      // A board found under another name ("same board as …") is tracked through
      // that entry; the name match cannot see it, so it is left alone.
      if (!m && r.state === 'tracked' && r.tracked_as.startsWith('board:')) continue;
      const state = m ? (m.enabled ? 'tracked' : 'disabled') : (r.state === 'tracked' || r.state === 'disabled' ? 'pending' : r.state);
      const as = m ? m.name : '';
      if (state !== r.state || as !== r.tracked_as) { set.run(state, as, r.key); changed++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return changed;
}

/** What the resolver should look at next: never-tried first, hardware first. */
export function due(db, { limit = 400, hardwareOnly = false, now = new Date().toISOString(), retryAll = false, minEvidence = 0 } = {}) {
  // retryAll: every no-board / partial row is due now, whatever its retry date —
  // for a rerun after the resolver learned something new (a fixed pattern, a new
  // provider). minEvidence narrows it to employers worth that.
  return db.prepare(`SELECT key, name, site FROM employers
    WHERE (state = 'pending' OR (state IN ('no-board','partial') AND (${retryAll ? '1 = 1' : 'next_attempt IS NULL OR next_attempt <= ?'})))
    ${hardwareOnly ? 'AND hardware = 1' : ''}
    ${minEvidence > 0 ? `AND evidence >= ${Number(minEvidence) | 0}` : ''}
    ORDER BY (state = 'pending') DESC, hardware DESC,
      -- Hiring THIS month beats a petition filed last year: a company a job
      -- index named recently is looked for before the H-1B history.
      (last_seen >= ? AND (sources LIKE '%linkedin%' OR sources LIKE '%sources%')) DESC,
      evidence DESC, name LIMIT ?`).all(...(retryAll ? [] : [now]), new Date(Date.parse(now) - 30 * DAY).toISOString(), limit);
}

/**
 * Read a discover-ats --results-file back into the ledger.
 * `refused`: the run reported a shared ATS refusing us, so its misses are not
 * real and come back in days, not a month.
 */
export function record(db, lines, { refused = false, now = new Date() } = {}) {
  const at = now.toISOString();
  const later = (d) => new Date(now.getTime() + d * DAY).toISOString();
  const upd0 = db.prepare(`UPDATE employers SET state = ?, tracked_as = ?, outcome = ?, attempts = attempts + 1,
    last_attempt = ?, next_attempt = ?, platform = ? WHERE key = ?`);
  const upd = { run: (state, as, outcome, at1, next, key, platform = '') => upd0.run(state, as, outcome, at1, next, platform, key) };
  const counts = {};
  db.exec('BEGIN');
  try {
    for (const l of lines) {
      const key = keyOf(plainName(l.name));
      if (!key) continue;
      counts[l.outcome] = (counts[l.outcome] || 0) + 1;
      switch (l.outcome) {
        case 'tracked': upd.run('tracked', l.url ? `board:${l.url}` : '', 'tracked', at, null, key); break;
        case 'dupe': upd.run('tracked', `board:${l.url || ''}`, 'same board as a tracked company', at, null, key); break;
        case 'gated': upd.run('gated', '', 'clearance / ITAR employer', at, null, key); break;
        case 'partial': upd.run('partial', '', `workday tenant, site unknown: ${l.url || ''}`, at, later(RETRY_DAYS.partial), key); break;
        // A miss on a platform we cannot read yet is named, so the report can
        // say "312 employers are on UKG" instead of "312 have no board".
        case 'miss': upd.run('no-board', '', l.platform ? `runs on ${l.platform}, which nothing here reads yet`
          : refused ? 'no board (a shared ATS was refusing)' : 'no board answered', at,
          later(refused ? RETRY_DAYS.refused : RETRY_DAYS['no-board']), key, l.platform || ''); break;
        default: break;   // 'known' and 'found' settle nothing; sync() reads portals.yml
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return counts;
}

export function readResults(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Hand names to discover-ats and record what it settles. Used by the resolve
 * command and by discover-linkedin / discover-sources, so every pass lands in
 * the ledger whoever started it.
 *
 * @param {{name: string, site?: string}[]} companies
 */
export async function resolveNames(db, companies, { write = true, log = process.stderr, concurrency = 8, lookup = lookupSite } = {}) {
  if (!companies.length) return {};
  // A name with no website gets one looked up, so its careers page can be
  // followed instead of guessing `<name>.com` (branded boards live there).
  if (lookup) await fillSites(db, companies, lookup);
  // Kept under the store, not the temp folder: a run killed for memory leaves
  // its answers here and the next run records them (replayLeftovers).
  const dir = path.join(RUNS_DIR, `${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const resultsFile = path.join(dir, 'results.jsonl');
  const sitesFile = path.join(dir, 'sites.json');
  const sites = companies.filter((c) => c.site).map((c) => ({ name: plainName(c.name), site: c.site }));
  writeFileSync(sitesFile, JSON.stringify(sites));
  const args = [path.join(HERE, 'discover-ats.mjs'), '--names', companies.map((c) => plainName(c.name)).join(','),
    '--results-file', resultsFile, '--concurrency', String(concurrency)];
  if (sites.length) args.push('--sites-file', sitesFile);
  if (write) args.push('--write');
  let refused = false;
  await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const watch = (buf) => {
      const s = String(buf);
      if (/shared ATS refused us/.test(s)) refused = true;
      log.write?.(s);
    };
    child.stdout.on('data', watch);
    child.stderr.on('data', watch);
    child.on('exit', resolve);
    child.on('error', resolve);
  });
  const counts = record(db, readResults(resultsFile), { refused });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  return counts;
}

const RUNS_DIR = path.join(ROOT, 'data', 'jarvis', 'universe-runs');

/** Record what a killed run settled before it died, then clear it away. */
export function replayLeftovers(db, dir = RUNS_DIR) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const sub of readdirSync(dir)) {
    const file = path.join(dir, sub, 'results.jsonl');
    const lines = readResults(file);
    if (lines.length) { record(db, lines); n += lines.length; }
    try { rmSync(path.join(dir, sub), { recursive: true, force: true }); } catch { /* next time */ }
  }
  return n;
}

/**
 * A company's website from its name, via Clearbit's public autocomplete (no
 * key). Believed only when the name it returns IS the name asked — "Garmin" →
 * garmin.com — because a site handed to the resolver is treated as the
 * company's own word, and a near-miss would bind a stranger's board to it.
 */
export async function lookupSite(name, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    const list = await r.json();
    const want = keyOf(name);
    const hit = (Array.isArray(list) ? list : []).find((c) => c?.domain && keyOf(c.name) === want);
    return hit ? `https://${hit.domain}` : '';
  } catch { return ''; }
}

async function fillSites(db, companies, lookup) {
  const save = db.prepare('UPDATE employers SET site = ?, site_source = ? WHERE key = ?');
  const tried = db.prepare('SELECT site, site_source FROM employers WHERE key = ?');
  for (const c of companies) {
    if (c.site) continue;
    const key = keyOf(plainName(c.name));
    const prev = tried.get(key);
    if (prev?.site_source) { c.site = prev.site || ''; continue; }   // asked before; 'none' stays none
    c.site = await lookup(plainName(c.name));
    save.run(c.site, c.site ? 'lookup' : 'none', key);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ── report ──────────────────────────────────────────────────────────

export function coverage(db, { now = new Date().toISOString() } = {}) {
  const by = Object.fromEntries(db.prepare('SELECT state, count(*) AS n FROM employers GROUP BY state').all().map((r) => [r.state, r.n]));
  const hw = Object.fromEntries(db.prepare('SELECT state, count(*) AS n FROM employers WHERE hardware = 1 GROUP BY state').all().map((r) => [r.state, r.n]));
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const decided = (by.gated || 0) + (by.disabled || 0);
  const hwTotal = Object.values(hw).reduce((a, b) => a + b, 0);
  const hwDecided = (hw.gated || 0) + (hw.disabled || 0);
  const dueNow = db.prepare(`SELECT count(*) AS n FROM employers WHERE state = 'pending'
    OR (state IN ('no-board','partial') AND (next_attempt IS NULL OR next_attempt <= ?))`).get(now).n;
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 100);
  // What the LinkedIn sweep found for employers with no readable board.
  const listing = Object.fromEntries(db.prepare(`SELECT listing, count(*) AS n FROM employers
    WHERE state IN ('no-board','partial') GROUP BY listing`).all().map((r) => [r.listing || 'unswept', r.n]));
  const viaLinkedin = listing['hiring-hw'] || 0;
  // PARTLY READ (F-713). One LinkedIn search returns one page; an employer that
  // filled it has more postings than we hold. And a big employer whose board
  // gives next to nothing (reboard.mjs's last full run) is not covered by it.
  const capped = db.prepare(`SELECT count(*) AS n FROM employers WHERE state IN ('no-board','partial')
    AND listing = 'hiring-hw' AND listing_count >= ?`).get(LINKEDIN_PAGE).n;
  let thin = 0;
  try { thin = (JSON.parse(db.prepare(`SELECT value FROM meta WHERE key = 'reboard_thin'`).get()?.value || '[]')).length; } catch { /* no full run yet */ }
  const nothing = (listing['hiring-other'] || 0) + (listing.none || 0);
  const unknown = (listing.unswept || 0) + (by.pending || 0);
  return {
    total, by, hardware: { total: hwTotal, by: hw },
    tracked: by.tracked || 0,
    pending: by.pending || 0,
    noBoard: (by['no-board'] || 0) + (by.partial || 0),
    due: dueNow,
    listing, viaLinkedin, nothing, unknown, capped, thin, partly: capped + thin,
    // DISCOVERABLE: every employer whose engineering postings reach the store —
    // by its own board, or by LinkedIn's copies — plus every employer verified
    // to have none to find. What is left is the employers nobody has looked at
    // in either place yet, and that is the number that must reach zero.
    // A partly-read employer is not counted as discoverable (F-713).
    discoverable: pct((by.tracked || 0) - thin + viaLinkedin - capped + nothing, total - decided),
    // Coverage: of the employers we could track, how many we do. A company
    // with no readable board is NOT covered — it is the honest gap, and the
    // number has to show it.
    coverage: pct(by.tracked || 0, total - decided),
    checked: pct(total - decided - (by.pending || 0), total - decided),
    hardwareCoverage: pct(hw.tracked || 0, hwTotal - hwDecided),
  };
}

/** A value kept in the ledger itself — reboard.mjs's thin list. Per database, so a test ledger has its own. */
export function setMeta(db, key, value) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function coverageLine(c) {
  const known = c.total - (c.by.gated || 0) - (c.by.disabled || 0);
  return `Coverage: ${c.discoverable}% of ${known.toLocaleString()} known US ${FAMILY} employers discoverable`
    + ` — ${c.tracked.toLocaleString()} by their own board, ${c.viaLinkedin.toLocaleString()} through LinkedIn's copies,`
    + ` ${c.nothing.toLocaleString()} with no ${FAMILY} postings to find`
    + ` · ${c.unknown.toLocaleString()} not yet looked at`
    + (c.partly ? ` · ${c.partly.toLocaleString()} big employers only partly read (${c.thin} through a thin board, ${c.capped} past one page of LinkedIn)` : '')
    + (c.due ? ` · ${c.due.toLocaleString()} due a board check` : '');
}

// ── the LinkedIn sweep ──────────────────────────────────────────────
//
// WHY (2026-10-04). Once every known employer had been checked for a board,
// 7,700 had none the server can read — sites that refuse machines, Paycom,
// Dayforce, script-built careers pages. "No readable board" is not the same as
// "not discoverable": LinkedIn's public guest search lists their postings, and
// import-linkedin.mjs already imports exactly these (the fallback CLAUDE.md
// names for companies whose board does not answer). So each one is asked,
// once a fortnight: "<name> engineer", last 30 days, US. Postings are counted
// only when the CARD's company is this employer, never on the search alone.
//
//   hiring-hw     hardware postings listed  → imported as LinkedIn rows
//   hiring-other  postings, none hardware   → nothing for him to find
//   none          nothing listed under its name
//
// One search per employer, LinkedIn's own pacing; a run that LinkedIn keeps
// throttling stops and says how far it got, and the rest stay due.

export const SWEEP_RECHECK_DAYS = 14;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ budget?: number, days?: number, dryRun?: boolean, harvestImpl?: Function, importImpl?: Function, log?: (s: string) => void, now?: Date }} [opts]
 */
export async function linkedinSweep(db, { budget = 300, days = 30, dryRun = false, harvestImpl = null, importImpl = null,
  log = (s) => console.log(s), now = new Date() } = {}) {
  const harvest = harvestImpl || (await import('./discover-linkedin.mjs')).harvest;
  const stale = new Date(now.getTime() - SWEEP_RECHECK_DAYS * DAY).toISOString();
  const rows = db.prepare(`SELECT key, name FROM employers WHERE state IN ('no-board','partial')
    AND (listing_checked IS NULL OR listing_checked < ?)
    ORDER BY hardware DESC, evidence DESC, name LIMIT ?`).all(stale, budget);
  const save = db.prepare('UPDATE employers SET listing = ?, listing_count = ?, listing_checked = ? WHERE key = ?');
  const counts = { 'hiring-hw': 0, 'hiring-other': 0, none: 0 };
  let done = 0, throttled = false, imported = 0, batch = 0;
  // IMPORTED AS IT GOES (2026-10-04). The first full sweep held every posting
  // it found until the end of a ten-hour run, so a kill would have lost all of
  // them. Every 100 employers the found postings are imported, and only THEN
  // are those employers marked swept — a run stopped in between leaves them
  // due, and the next sweep finds them again.
  let pending = [];   // { key, count, postings }
  const flush = async () => {
    const postings = pending.flatMap((p) => p.postings);
    if (postings.length && !dryRun) {
      // The import itself is import-linkedin.mjs, unchanged: it skips companies
      // whose board we read, folds duplicates, reads every description in full
      // and leaves out Easy-Apply-only postings.
      const dir = path.join(ROOT, 'data', 'jarvis', 'harvests');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `sweep-${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${++batch}.json`);
      writeFileSync(file, JSON.stringify({ postings }));
      log(`  ${postings.length} ${discovery.fieldWord} posting(s) at ${pending.length} employer(s) → importing (${path.relative(ROOT, file)})`);
      if (importImpl) await importImpl(file);
      else {
        await new Promise((resolve) => {
          const child = spawn(process.execPath, [path.join(HERE, 'import-linkedin.mjs'), '--from', file],
            { cwd: ROOT, stdio: 'inherit', windowsHide: true });
          child.on('exit', resolve); child.on('error', resolve);
        });
      }
      imported += postings.length;
    }
    if (!dryRun) for (const p of pending) save.run('hiring-hw', p.count, now.toISOString(), p.key);
    pending = [];
  };
  for (const r of rows) {
    const res = await harvest([`${r.name} ${discovery.sweepTerm}`], { days, pages: 1 });
    if (res.throttled) { throttled = true; break; }
    // The card's company, matched by words the way portals.yml names are.
    const idx = trackedIndex([{ name: r.name }]);
    const mine = (res.postings || []).filter((p) => matchTracked(p.company, idx));
    const hw = mine.filter((p) => worthTracking(p.title));
    const listing = hw.length ? 'hiring-hw' : mine.length ? 'hiring-other' : 'none';
    counts[listing]++;
    if (hw.length) pending.push({ key: r.key, count: mine.length, postings: hw });
    else if (!dryRun) save.run(listing, mine.length, now.toISOString(), r.key);
    done++;
    if (done % 100 === 0) { await flush(); log(`  … ${done}/${rows.length} swept — ${JSON.stringify(counts)}`); }
  }
  await flush();
  log(`  swept ${done} of ${rows.length}${throttled ? ' — LinkedIn kept throttling, the rest stay due' : ''}: ${JSON.stringify(counts)}`);
  return { swept: done, due: rows.length, throttled, counts, imported };
}

// ── CLI ─────────────────────────────────────────────────────────────

const USAGE = `
  node jarvis/universe.mjs <command> [options]

    report [--pending <n>]           coverage, and the next employers due a board check
    seed --lca                       every employer with a certified engineering H-1B petition
    seed --store                     companies with postings in the store
    seed --names-file <txt> --source <s> [--sites-file <json>]
    resolve [--budget <n>] [--chunk <n>] [--concurrency <n>] [--hardware-only] [--dry-run]
            [--retry-all] [--min-evidence <n>]   misses again now, ignoring their retry date
                                     look for the boards of what is due, and track them
    daily                            LinkedIn's last two days (and the public indexes on
                                     Sundays), then resolve 1,500
    sweep [--budget <n>] [--dry-run]  LinkedIn, for employers no board answers for: import
                                     their hardware postings, or record that they have none
    ats --source <s> -- <discover-ats args>
                                     run the resolver on its own lists (--sp400, --seeds yc…)
                                     and record every company it names in the ledger
`;

const LOCK = path.join(ROOT, 'data', 'jarvis', 'universe.lock');

/** One resolve run at a time; a lock whose process is gone is stale. */
function takeLock() {
  try {
    const held = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (held?.pid && held.pid !== process.pid) {
      try { process.kill(held.pid, 0); return false; } catch { /* dead: take it */ }
    }
  } catch { /* no lock */ }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  process.on('exit', () => {
    try { if (JSON.parse(readFileSync(LOCK, 'utf8')).pid === process.pid) rmSync(LOCK); } catch { /* gone */ }
  });
  return true;
}

function flag(args, name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); return 0; }
  const db = openUniverse();
  try {
    if (cmd === 'seed') {
      if (args.includes('--lca')) console.log('  lca  ', ingest(db, lcaRows(), 'lca'));
      if (args.includes('--store')) console.log('  store', ingest(db, storeRows(), 'store'));
      // A saved LinkedIn harvest (data/jarvis/harvests/linkedin-*.json).
      const harvestFile = flag(args, 'harvest', '');
      if (harvestFile) {
        const by = new Map();
        for (const p of JSON.parse(readFileSync(harvestFile, 'utf8'))) {
          if (!p?.company || !worthTracking(p.title)) continue;
          if (!by.has(p.company)) by.set(p.company, { name: p.company, titles: [], count: 0 });
          const e = by.get(p.company); e.count++; if (e.titles.length < 8) e.titles.push(p.title);
        }
        console.log('  linkedin', ingest(db, [...by.values()], 'linkedin'));
      }
      const namesFile = flag(args, 'names-file', '');
      if (namesFile) {
        const sitesFile = flag(args, 'sites-file', '');
        const sites = new Map();
        if (sitesFile) for (const s of JSON.parse(readFileSync(sitesFile, 'utf8'))) sites.set(String(s.name).toLowerCase(), s.site);
        const names = readFileSync(namesFile, 'utf8').split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
        // A hand-supplied list is evidence of hiring, not of hardware; the
        // caller already filtered it on titles, so it is marked hardware.
        const rows = names.map((n) => ({ name: n, site: sites.get(n.toLowerCase()) || '', titles: [discovery.sampleTitle] }));
        console.log(`  ${flag(args, 'source', 'names')}`, ingest(db, rows, flag(args, 'source', 'names')));
      }
      console.log(`  ${sync(db)} rows matched to portals.yml`);
      console.log(`\n  ${coverageLine(coverage(db))}`);
      return 0;
    }
    if (cmd === 'report') {
      sync(db);
      const c = coverage(db);
      console.log(`\n  ${coverageLine(c)}\n`);
      console.log('  by state:', c.by);
      console.log('  hardware:', c.hardware.by);
      // What the misses run on: the platforms worth a provider next.
      const plat = db.prepare(`SELECT platform, count(*) AS n FROM employers WHERE state = 'no-board' AND platform <> ''
        GROUP BY platform ORDER BY n DESC`).all();
      if (plat.length) console.log('  no board, by the platform it runs on:', Object.fromEntries(plat.map((p) => [p.platform, p.n])));
      const n = Number(flag(args, 'pending', 20));
      const next = due(db, { limit: n });
      if (next.length) {
        console.log(`\n  next ${next.length} due a board check:`);
        for (const r of next) console.log(`    ${r.name}`);
      }
      return 0;
    }
    if (cmd === 'resolve' || cmd === 'daily' || cmd === 'ats' || cmd === 'sweep') {
      // THE MACHINE IS HIS FIRST (2026-10-04: "they were making my league of
      // legends game laggy as hell"). These runs take hours and nothing waits
      // on them minute to minute, so they run at idle priority — and on
      // Windows every child (the resolver, the readers) inherits it.
      // JARVIS_FULL=1 when he says the machine is free ("full blast it").
      if (process.env.JARVIS_FULL !== '1') {
        try { os.setPriority(os.constants.priority.PRIORITY_LOWEST); } catch { /* not permitted: run anyway */ }
      }
      // One at a time — two runs trip the shared ATS rate limits — but a run
      // that finds the lock taken WAITS rather than giving up: the dashboard's
      // daily pass must not cancel a long hand-started resolve, nor the other
      // way round. Twelve hours, then it says so and stops.
      const until = Date.now() + 12 * 60 * 60 * 1000;
      let said = false;
      while (!takeLock()) {
        if (Date.now() > until) { console.log('  the ledger stayed locked for 12 hours — not starting'); return 0; }
        if (!said) { console.log('  another resolve run holds the ledger — waiting for it to finish'); said = true; }
        await new Promise((r) => setTimeout(r, 60 * 1000));
      }
    }
    if (cmd === 'resolve' || cmd === 'daily') {
      const replayed = replayLeftovers(db);
      if (replayed) console.log(`  ${replayed} answer(s) recorded from a run that was stopped part-way`);
      if (cmd === 'daily') {
        // LinkedIn first: it names the companies hiring THIS week, which is the
        // freshest evidence there is. It ingests and resolves its own names.
        const run = (script, a) => new Promise((resolve) => {
          const child = spawn(process.execPath, [path.join(HERE, script), ...a],
            { cwd: ROOT, stdio: 'inherit', windowsHide: true });
          child.on('exit', resolve); child.on('error', resolve);
        });
        await run('discover-linkedin.mjs', ['--days', '2', '--write']);
        // Runway's new postings (one title read per page): a benchmark from outside,
        // and the board links of employers we do not track (discover-runway.mjs).
        await run('discover-runway.mjs', ['--write']);
        // The slower indexes weekly: their lists change by the month.
        if (new Date().getDay() === 0) await run('discover-sources.mjs', ['--write']);
        // And weekly, every big employer's board is held to its size: a thin or
        // stale board is replaced by the one it really uses (F-713).
        if (new Date().getDay() === 0) await run('reboard.mjs', ['--write']);
      }
      sync(db);
      // 1,500 a day (was 400): a rate-limited night leaves thousands of misses
      // due again in three days, and 400 a day took two weeks to get through them.
      const budget = Number(flag(args, 'budget', 1500));
      const chunk = Math.max(10, Number(flag(args, 'chunk', 150)));
      const list = due(db, { limit: budget, hardwareOnly: args.includes('--hardware-only'),
        retryAll: args.includes('--retry-all'), minEvidence: Number(flag(args, 'min-evidence', 0)) || 0 });
      console.log(`  ${list.length} employer(s) due a board check (budget ${budget}, ${chunk} per run)`);
      const totals = {};
      for (let i = 0; i < list.length; i += chunk) {
        const part = list.slice(i, i + chunk);
        console.log(`\n  ── ${i + 1}–${i + part.length} of ${list.length} ──`);
        const counts = await resolveNames(db, part, { write: !args.includes('--dry-run'), concurrency: Number(flag(args, 'concurrency', 8)) || 8 });
        for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] || 0) + v;
        sync(db);
      }
      // Then LinkedIn, for the employers no board answers for (300 a day: one
      // search each, at LinkedIn's pace).
      let swept = null;
      if (cmd === 'daily') swept = await linkedinSweep(db, { budget: Number(flag(args, 'sweep-budget', 300)) });
      const c = coverage(db);
      console.log(`\n  settled: ${JSON.stringify(totals)}`);
      console.log(`  ${coverageLine(c)}`);
      try { appendFileSync(COVERAGE_LOG, `${JSON.stringify({ at: new Date().toISOString(), cmd, settled: totals, swept, ...c })}\n`); } catch { /* a record */ }
      return 0;
    }
    if (cmd === 'sweep') {
      sync(db);
      const r = await linkedinSweep(db, { budget: Number(flag(args, 'budget', 300)), dryRun: args.includes('--dry-run') });
      const c = coverage(db);
      console.log(`  ${coverageLine(c)}`);
      try { appendFileSync(COVERAGE_LOG, `${JSON.stringify({ at: new Date().toISOString(), cmd, swept: r, ...c })}\n`); } catch { /* a record */ }
      return 0;
    }
    if (cmd === 'ats') {
      const source = flag(args, 'source', 'ats');
      const rest = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
      const dir = path.join(RUNS_DIR, `${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const resultsFile = path.join(dir, 'results.jsonl');
      let refused = false;
      await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(HERE, 'discover-ats.mjs'), ...rest, '--results-file', resultsFile, '--write'],
          { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const watch = (b) => { const t = String(b); if (/shared ATS refused us/.test(t)) refused = true; process.stderr.write(t); };
        child.stdout.on('data', watch); child.stderr.on('data', watch);
        child.on('exit', resolve); child.on('error', resolve);
      });
      const lines = readResults(resultsFile);
      // Every company the list named is part of the universe, whatever happened.
      console.log(`  ${source}`, ingest(db, lines.map((l) => ({ name: l.name, titles: [discovery.genericTitle] })), source));
      console.log('  settled', record(db, lines, { refused }));
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
      sync(db);
      console.log(`  ${coverageLine(coverage(db))}`);
      return 0;
    }
    console.error(`unknown command: ${cmd}\n${USAGE}`);
    return 1;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
