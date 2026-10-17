#!/usr/bin/env node
// jarvis/discover-runway.mjs — Runway's new postings, as a benchmark and as
// board links for employers we do not track (2026-10-07, he asked: "incorporate
// runway").
//
// Runway (joinrunway.io) is a student job board that watches ~175,000 company
// career sites. Its public job pages — listed in its sitemap and allowed by its
// robots.txt — carry a schema.org JobPosting (title, employer, its domain,
// location) and the link to the posting on the employer's own board. That link
// is what this reads it for: it names the board, the same evidence Simplify's
// list gives reboard.mjs.
//
// Two things per run:
//   1. A BENCHMARK. Of Runway's new US hardware/mechanical postings, how many
//      are in the store, and how many are at employers we track? Logged to
//      coverage-log.jsonl, so the "discoverable" number is checked from outside.
//   2. DISCOVERY. Every employer with such a posting that we do not track has
//      its board looked for (the posting's own link first, then its careers
//      page) and, with --write, added — through reboard.mjs's writer, so a
//      rejected find stays rejected.
//
// Cheap on purpose. ~99% of Runway's catalog is hourly retail and service work
// (measured 2026-10-07: 11 of 1,172 US pages). The job title sits in the first
// 5 KB of a 95 KB page, so each page is read only as far as its <title>, and
// only an engineering title is read in full. Job ids are time-ordered (cuid),
// so a run reads only the postings created since the last one.
//
// Nothing is imported from Runway: a found board is scanned by the ordinary
// scanner, like every other discovery source.
//
// Usage:
//   node jarvis/discover-runway.mjs                 # the last 7 days, report only
//   node jarvis/discover-runway.mjs --write         # …and track the boards found
//   node jarvis/discover-runway.mjs --days 3 --limit 5000

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { guardArgs } from './cli.mjs';
import { worthTracking, NEVER_TRACK } from './hiring-signals.mjs';
import { discovery } from './targeting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARVESTS = path.join(ROOT, 'data', 'jarvis', 'harvests');
const STATE = path.join(ROOT, 'data', 'jarvis', 'runway-state.json');
const COVERAGE_LOG = path.join(ROOT, 'data', 'jarvis', 'coverage-log.jsonl');
const ORIGIN = 'https://app.joinrunway.io';
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; jarvis-jobs; personal job search)', accept: 'text/html' };
const DAY = 86400000;

// ── pure parts ──────────────────────────────────────────────────────

/** When a Runway job id was created. Its ids are cuids: "c" + base-36 milliseconds. */
export function idTime(id) {
  const m = /^c([a-z0-9]{8})/.exec(String(id || ''));
  if (!m) return NaN;
  const t = parseInt(m[1], 36);
  return t > Date.UTC(2020, 0, 1) && t < Date.UTC(2100, 0, 1) ? t : NaN;
}

/** "<job title> @ <employer> | Runway" → { title, company }. */
export function parseTitle(html) {
  const m = /<title>([^<]*)<\/title>/i.exec(String(html || ''));
  if (!m) return null;
  const raw = m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();
  const t = /^(.*)\s@\s(.*?)\s*\|\s*Runway\s*$/.exec(raw);
  return t ? { title: t[1].trim(), company: t[2].trim() } : null;
}

// Hosts that are Runway's own furniture, never the employer's board.
const NOT_A_BOARD = /joinrunway|googletagmanager|google-analytics|facebook|gstatic|googleapis|crustdata|amazonaws|cloudfront|schema\.org|w3\.org|fonts\.|sentry|intercom|stripe|apple\.com\/app|play\.google/i;

/** The posting's own record: employer, its domain, country, date, and the link to its board. */
export function parsePosting(html) {
  const s = String(html || '');
  const m = /<script type="application\/ld\+json">([^<]*)<\/script>/i.exec(s);
  let j = null;
  try { j = m ? JSON.parse(m[1]) : null; } catch { j = null; }
  if (!j || j['@type'] !== 'JobPosting') return null;
  const domain = String(j.hiringOrganization?.sameAs || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  // The apply link: the first outside URL that looks like a job posting.
  const links = (s.match(/https?:\/\/[^"'\\\s<>]+/g) || []).map((u) => u.replace(/\\+$/, ''));
  const apply = links.find((u) => !NOT_A_BOARD.test(u) && /job|career|apply|recruit|posting|opening|position|requisition/i.test(u)
    && !/\.(?:png|jpe?g|svg|webp|css|js)(?:\?|$)/i.test(u)) || '';
  return {
    title: String(j.title || ''),
    company: String(j.hiringOrganization?.name || ''),
    domain,
    country: String(j.jobLocation?.address?.addressCountry || ''),
    region: String(j.jobLocation?.address?.addressRegion || ''),
    posted: String(j.datePosted || ''),
    apply,
  };
}

/**
 * The same job under two spellings of its title: one title's words all appear,
 * in order, in the other's (the store often appends a location or a req tag).
 */
export function sameJob(a, b) {
  const w = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const [x, y] = [w(a), w(b)];
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 2 && long.length > 1) return false;
  let i = 0;
  for (const t of long) if (t === short[i]) i++;
  return i === short.length;
}

export const isUS = (country) => /^(United States|US|USA|U\.S\.)$/i.test(String(country || '').trim());

// ── network ─────────────────────────────────────────────────────────

/** A page, read only as far as `stopAt` (or whole). Empty on any failure. */
async function readPage(url, { stopAt = null, maxBytes = 2_000_000 } = {}) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!r.ok || !r.body) return { status: r.status, text: '' };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (stopAt && text.includes(stopAt)) { reader.cancel().catch(() => {}); break; }
    }
    return { status: r.status, text };
  } catch { return { status: 0, text: '' }; }
}

async function jobIds() {
  const index = (await readPage(`${ORIGIN}/sitemap.xml`)).text;
  const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const ids = [];
  for (const map of maps) {
    // A sitemap that fails once is asked again: a silent miss here lost two
    // thirds of the ids on the first run (167,927 of 570,218).
    let xml = '';
    for (let attempt = 0; attempt < 3 && !xml.includes('</urlset>'); attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 3000 * attempt));
      xml = (await readPage(map, { maxBytes: 20_000_000 })).text;
    }
    if (!xml.includes('</urlset>')) console.error(`  ⚠ ${map} could not be read — its postings are left for the next run`);
    for (const m of xml.matchAll(/\/explore\/job\/([a-z0-9]{20,32})<\/loc>/g)) ids.push(m[1]);
  }
  return ids;
}

// ── main ────────────────────────────────────────────────────────────

async function main(argv) {
  const USAGE = `
  node jarvis/discover-runway.mjs [--days N] [--limit N] [--concurrency N] [--write]

  Read Runway's postings created in the last N days (default: since the last
  run, at most 7), keep the US hardware/mechanical ones, measure how many the
  store holds, and look for the boards of employers we do not track.
`;
  const args = guardArgs({ usage: USAGE, flags: ['--days', '--limit', '--concurrency', '--write'], valued: ['--days', '--limit', '--concurrency'], argv });
  const val = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const write = args.includes('--write');
  const limit = Number(val('--limit', 25000)) || 25000;
  const concurrency = Math.min(8, Number(val('--concurrency', 4)) || 4);
  if (!process.env.JARVIS_FULL) { try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted */ } }
  process.on('uncaughtException', (e) => {
    if (e?.code === 'ERR_ASSERTION' && /undici/.test(String(e.stack || ''))) return;   // F-636: one lost request
    console.error(e); process.exit(1);
  });

  let state = {};
  try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* first run */ }
  const days = Number(val('--days', 0));
  const since = days > 0 ? Date.now() - days * DAY : Math.max(Date.now() - 7 * DAY, Number(state.newest || 0));

  const all = await jobIds();
  const fresh = all.map((id) => ({ id, t: idTime(id) })).filter((x) => x.t > since).sort((a, b) => b.t - a.t).slice(0, limit);
  console.error(`runway: ${all.length.toLocaleString()} job pages listed, ${fresh.length.toLocaleString()} created since ${new Date(since).toISOString().slice(0, 16)}`);
  if (!all.length) { console.error('  ⚠ the sitemap answered nothing — Runway may have changed it; nothing measured'); return 1; }

  const postings = [];
  let read = 0, refused = 0;
  let k = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (k < fresh.length) {
      const { id } = fresh[k++];
      const url = `${ORIGIN}/explore/job/${id}`;
      const head = await readPage(url, { stopAt: '</title>', maxBytes: 64_000 });
      if (head.status === 429 || head.status === 403) { refused++; await new Promise((r) => setTimeout(r, 5000)); continue; }
      read++;
      if (read % 2000 === 0) console.error(`  … ${read.toLocaleString()} read, ${postings.length} US ${discovery.familyNoun}`);
      const t = parseTitle(head.text);
      if (!t || !worthTracking(t.title)) continue;
      const p = parsePosting((await readPage(url)).text);
      if (p && isUS(p.country)) postings.push({ ...p, url });
    }
  }));
  if (refused > 50) console.error(`  ⚠ Runway refused ${refused} pages — the run is a partial sample`);

  mkdirSync(HARVESTS, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(HARVESTS, `runway-${stamp}.json`), JSON.stringify(postings, null, 1));

  // 1. The benchmark. A posting counts as held when the store has the same job
  // at the same employer under a title that contains it word for word — the
  // store often keeps the board's longer title ("…Adv Degree Gloucester Ma").
  // Only postings two days old or more are judged: a newer one may simply not
  // have met the next scan yet.
  const u = await import('./universe.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const jdb = new DatabaseSync(path.join(ROOT, 'data', 'jarvis', 'jobs.db'), { readOnly: true });
  jdb.exec('PRAGMA busy_timeout = 30000');
  const idx = u.trackedIndex(u.portalsEntries());
  const ats = await import('./discover-ats.mjs');
  const rowsAt = jdb.prepare('SELECT title FROM jobs WHERE company = ? OR company LIKE ? LIMIT 20000');
  const cache = new Map();
  const titlesAt = (company, trackedAs) => {
    const k = trackedAs || company;
    if (!cache.has(k)) cache.set(k, rowsAt.all(trackedAs || company, `${String(company).split(/\s+/)[0]}%`).map((r) => r.title));
    return cache.get(k);
  };
  const cutoff = Date.now() - 2 * DAY;
  let inStore = 0, atTracked = 0, gated = 0, tooNew = 0;
  const missedAtTracked = [];
  const untracked = new Map();
  for (const p of postings) {
    if (ats.isClearanceGated(p.company) || /clearance|TS\/SCI|\bsecret\b|polygraph/i.test(p.title)) { gated++; continue; }
    const hit = u.matchTracked(p.company, idx);
    if (titlesAt(p.company, hit?.name).some((t) => sameJob(p.title, t))) { inStore++; continue; }
    if (Date.parse(p.posted) > cutoff) { tooNew++; continue; }
    if (hit) { if (hit.enabled) { atTracked++; missedAtTracked.push(p); } continue; }
    if (NEVER_TRACK.test(p.company)) continue;
    const key = u.keyOf(u.plainName(p.company));
    if (!untracked.has(key)) untracked.set(key, { name: u.plainName(p.company), domain: p.domain, urls: [], titles: [] });
    const e = untracked.get(key);
    if (p.apply) e.urls.push(p.apply);
    e.titles.push(p.title);
  }
  jdb.close();
  const counted = postings.length - gated - tooNew;
  const pct = counted ? Math.round((1000 * inStore) / counted) / 10 : 100;
  console.log(`\nRunway, ${fresh.length.toLocaleString()} new pages: ${postings.length} US ${discovery.label} postings (${gated} clearance-gated and ${tooNew} under two days old, not judged).`);
  console.log(`  in the store: ${inStore} of ${counted} (${pct}%) · at employers we track, missing: ${atTracked} · at employers we do not track: ${counted - inStore - atTracked} (${untracked.size} employers)`);
  for (const m of missedAtTracked.slice(0, 15)) console.log(`    missing at a tracked employer: ${m.company} — ${m.title} (${m.posted.slice(0, 10)})`);

  // 2. Discovery, through reboard's board search and writer.
  const rb = await import('./reboard.mjs');
  const d = await rb.makeDeps();
  const entries = u.portalsEntries();
  const taken = new Set(entries.map((e) => String(e.careers_url || '').toLowerCase().replace(/\/+$/, '')));
  const found = [];
  const misses = [];
  await rb.mapPool([...untracked.values()], 4, async (c) => {
    const boards = await rb.boardsFor({ name: c.name, simplify: { urls: c.urls }, via: 'runway',
      site: c.domain ? `https://${c.domain}` : '', siteTrusted: !!c.domain }, d).catch(() => []);
    const best = boards[0];
    if (best && rb.isBetter(0, best.count, { adding: true }) && !taken.has(String(best.entry.careers_url).toLowerCase().replace(/\/+$/, ''))) {
      taken.add(String(best.entry.careers_url).toLowerCase().replace(/\/+$/, ''));
      found.push({ kind: 'add', name: c.name, open: 0, sector: '', entry: null, best });
      console.error(`  ✓ ${c.name}: ${best.count} via ${best.provider} ${best.entry.careers_url}`);
    } else misses.push(c);
  });
  // The ledger hears about every one of them, found or not.
  const led = u.openUniverse();
  u.ingest(led, [...untracked.values()].map((c) => ({ name: c.name, site: c.domain ? `https://${c.domain}` : '', titles: c.titles, count: c.titles.length })), 'runway');
  u.record(led, misses.map((c) => ({ name: c.name, outcome: 'miss' })));
  led.close();
  console.log(`  boards found for ${found.length} of ${untracked.size} untracked employers${found.length ? ': ' + found.map((f) => `${f.name} (${f.best.count})`).join(', ') : ''}`);
  if (misses.length) console.log(`  no readable board: ${misses.map((m) => m.name).join(', ')}`);

  try {
    appendFileSync(COVERAGE_LOG, `${JSON.stringify({ at: new Date().toISOString(), cmd: 'runway', pages: fresh.length, read, refused,
      hardware: postings.length, gated, inStore, atTracked, untracked: untracked.size, found: found.length, pct })}\n`);
  } catch { /* a record */ }
  // Only a run that tracks what it found moves the mark; a report-only run can be repeated.
  if (write && fresh.length) writeFileSync(STATE, JSON.stringify({ newest: fresh[0].t, at: new Date().toISOString() }, null, 2));

  if (write && found.length) await rb.applyFound(found, { u, ats });
  else if (found.length) console.log('  (report only — run with --write to track them)');
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).then((c) => process.exit(c || 0), (e) => { console.error(e); process.exit(1); });
}
