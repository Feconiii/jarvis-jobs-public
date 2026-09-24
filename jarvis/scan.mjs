#!/usr/bin/env node
// jarvis/scan.mjs — broad, honest discovery.
//
// The old scanner's job was to REJECT: a title whitelist, a negative list, a
// location gate, a salary gate — every posting had to survive a gauntlet before
// it was allowed into the pipeline. That is exactly why NVIDIA "had no roles":
// one narrow title match failed and the posting vanished silently.
//
// Jarvis inverts it. This scanner CAPTURES. It pulls every posting a company's
// ATS API will give it, runs triage (which FLAGS, never drops), and records how
// thoroughly each company was actually scanned — so "no relevant roles" is a
// verifiable statement (0 of 340 postings matched) rather than an unfalsifiable
// one. Relevance is computed and stored for SORTING; it never hides anything.
//
// It reuses the existing providers/ layer wholesale (Greenhouse, Lever, Ashby,
// Workday CXS, SmartRecruiters, BambooHR, …). Companies whose careers page has
// no structured API provider are reported as "needs assisted scan", not
// silently counted as empty.
//
// Usage:
//   node jarvis/scan.mjs                 # scan all enabled tracked companies
//   node jarvis/scan.mjs --company kla   # one company (name substring)
//   node jarvis/scan.mjs --tier watchlist
//   node jarvis/scan.mjs --dry-run       # don't write the store

import { readFileSync, existsSync, readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { makeHttpCtx } from '../providers/_http.mjs';
import { upsertJobs, recordScan, withStoreLock, DB_PATH } from './store.mjs';
import { triage } from './triage.mjs';
import { htmlToText } from './text.mjs';

import { guardArgs } from './cli.mjs';
import { makeHostLimiter, registrableDomain, mapPool } from './net-pool.mjs';

const USAGE = `
  npm run jarvis:scan -- [options]
  
    Discover postings across every tracked company and write them to the store.
  
      --company <name>    only this company
      --provider <name>   only this ATS adapter
      --tier <name>       only companies in this tier
      --new-since <file>  only companies added since this older copy of portals.yml
      --dry-run           report what would be written, write nothing
      --concurrency <n>   companies fetched at once (default 10)
      --per-host <n>      requests at once to ONE host (default 3)
      --help, -h          print this
`;

// F-162: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--company","--provider","--tier","--dry-run","--concurrency","--per-host","--new-since"], valued: ["--new-since","--company","--provider","--tier","--concurrency","--per-host"] });


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS_DIR = path.join(ROOT, 'providers');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');

// Default watchlist — companies scanned first and flagged for extra attention.
// Overridable via a top-level `watchlist:` list in portals.yml.
const DEFAULT_WATCHLIST = ['nvidia', 'applied materials', 'kla', 'lam research', 'asml'];

// ── provider loading (mirrors scan.mjs; kept local so Jarvis is self-contained) ──

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const p = mod.default;
      if (p && typeof p.fetch === 'function' && p.id) providers.set(p.id, p);
    } catch (err) {
      console.error(`⚠️  provider ${file} failed to load: ${err.message}`);
    }
  }
  return providers;
}

function resolveProvider(entry, providers) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    return p ? { provider: p } : { error: `unknown provider: ${entry.provider}` };
  }
  for (const p of providers.values()) {
    if (p.id === 'local-parser') continue;
    let hit;
    try { hit = p.detect?.(entry); } catch { hit = null; }
    if (hit) return { provider: p };
  }
  return null;
}

// ── watchlist tiering ───────────────────────────────────────────────

function tierFor(name, watchlist) {
  const lower = (name || '').toLowerCase();
  if (watchlist.some(w => lower.includes(w))) return 'watchlist';
  return 'tracked';
}

// ── running the fetches concurrently ────────────────────────────────
//
// ONE COMPANY AT A TIME WAS THE ENTIRE COST OF A SCAN (F-419). This file used
// to walk `ordered` with a plain `for` loop, so every company waited for the
// one before it — and essentially all of that waiting was a socket doing
// nothing. At 770 tracked companies that is hours of wall clock for minutes of
// work. Nothing about it needed to be serial: providers share no mutable
// state, each company's failure was already isolated from the rest, and store
// writes go through a lock that makes concurrent writers safe (F-295).
//
// TWO limits, not one, and the second is the one that matters. A global pool
// bounds total work. A per-SERVICE pool is what makes the concurrency polite,
// and getting its key wrong is what broke the first version: see F-421 below.
// Without it a global pool is worse than no pool, because one ATS serves
// hundreds of the tracked companies and pointing the whole width at it earns a
// 429 that costs more time than the parallelism saved.

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_PER_HOST = 3;

export { makeHostLimiter, registrableDomain, mapPool };

/** Which service a company's postings come from, for the per-service cap. */
export function hostOf(entry) {
  for (const candidate of [entry?.api, entry?.careers_url]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    try { return registrableDomain(new URL(candidate).hostname); } catch { /* try the next */ }
  }
  return '';
}

// A TRANSIENT FAILURE IS NOT AN EMPTY BOARD (F-421).
//
// Running the fetches concurrently made an intermittent failure mode visible
// that was always latent: measured on the recruitee cohort, three sequential
// runs returned 115 postings from 11 companies every time, while one pooled
// run in three came back with 29 postings and 8 errors. The companies had not
// changed and the boards were not down — sockets simply lose more often when
// more of them are open at once.
//
// That is the exact shape of failure this system exists to avoid: the run
// still "succeeds", the report still prints, and seven companies' postings are
// silently absent for that scan. So a fetch that fails is retried before it is
// believed, with a short backoff, and only a repeated failure is recorded as
// an error. A board that is genuinely gone still fails — it just has to say so
// three times.
const FETCH_ATTEMPTS = 4;
// A dropped socket can be retried almost immediately. A 429 cannot: the server
// has just said "you are asking too fast", and answering that with a 400ms
// pause is not a retry, it is the same mistake again. Measured on Recruitee,
// sub-second backoff left one run in five still losing companies; seconds
// clear it.
const RETRY_MS = [400, 800, 1600];
const RATE_LIMIT_MS = [2_000, 5_000, 10_000];

async function fetchWithRetry(provider, entry, ctx) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      return await provider.fetch(entry, ctx);
    } catch (err) {
      lastErr = err;
      // An HTTP status is the server's considered answer: 404 means no such
      // board and 403 means it will not serve us, and asking three more times
      // changes neither. Retry only what looks like the transport giving out
      // — and 429, which is the one status that explicitly means "later".
      const status = err?.status;
      const rateLimited = status === 429;
      const worthRetrying = !status || rateLimited || status >= 500;
      if (!worthRetrying || attempt === FETCH_ATTEMPTS) break;
      const waits = rateLimited ? RATE_LIMIT_MS : RETRY_MS;
      await new Promise(r => setTimeout(r, waits[attempt - 1] ?? waits[waits.length - 1]));
    }
  }
  throw lastErr;
}

/**
 * Scan ONE company and describe what happened, without touching any shared
 * counter. Lifted verbatim out of the old sequential loop so that the only
 * thing that changed with concurrency is WHERE the work runs, not what it
 * does: the same triage, the same field list, the same three outcomes
 * (needs-assist / ok / error) and the same progress line.
 *
 * Returns `null` only when a `--provider` run is skipping a company that
 * belongs to a different ATS — the caller drops those without counting them.
 *
 * @returns {Promise<null | {report: object, jobs?: object[], counted?: 'api'|'assist'}>}
 */
async function scanOne(entry, { providers, filterProvider, ctx, withHost }) {
  const resolved = resolveProvider(entry, providers);
  if (!resolved || resolved.error) {
    // A provider-scoped run is asking about one ATS, so companies that have
    // no ATS at all are out of scope — counting them here would report a
    // "needs assisted scan" backlog that this run never intended to cover.
    if (filterProvider) return null;
    // No structured API — this is the honest signal the old system hid.
    return {
      counted: 'assist',
      report: {
        company: entry.name, tier: entry._tier, provider: null,
        status: 'needs-assist',
        note: entry.scan_method === 'websearch'
          ? 'No structured ATS API for this careers page — needs assisted (browser/websearch) scan.'
          : (resolved?.error || 'No provider matched this careers URL.'),
        found: 0,
      },
    };
  }

  const provider = resolved.provider;
  // Applied after resolution, since a company's ATS is derived from its
  // careers_url rather than declared up front.
  if (filterProvider && provider.id.toLowerCase() !== filterProvider) return null;

  try {
    const jobs = await withHost(hostOf(entry), () => fetchWithRetry(provider, entry, ctx));
    const list = Array.isArray(jobs) ? jobs : [];
    const enriched = list
      .filter(j => j && j.url && j.title)
      .map(j => {
        // Normalised HERE, not later: several providers hand back raw or
        // entity-encoded HTML, and a description stored as markup is markup
        // for good — triage reads it, the pay parser reads it, and the card
        // shows it. One converter at the door, for every source.
        const description = htmlToText(j.description || '');
        const t = triage({ title: j.title, description, location: j.location || '', url: j.url || '' });
        return {
          url: j.url,
          title: j.title,
          company: j.company || entry.name,
          team: j.team || '',
          location: j.location || '',
          description,
          // Providers that publish a pay range (Ashby) parse it into an
          // annualised {min,max,currency}. This mapping rebuilds each job
          // from an explicit field list, so anything omitted here is dropped
          // before the store ever sees it — which is how salary stayed empty
          // even after the provider and the store both handled it.
          salary: j.salary || null,
          postedAt: j.postedAt ?? null,
          // Where enrichment can find the description, for the providers
          // whose detail endpoint cannot be derived from the posting URL.
          // Oracle's is the case: careers.ti.com is a vanity domain that
          // 302s the API to an error page, and the real host and site number
          // exist only in portals.yml, which the enricher does not read.
          detailApi: j.detailApi || null,
          source: provider.id,
          triage: t,
          company_meta: { tier: entry._tier, careers_url: entry.careers_url || '', notes: entry.notes || '', sponsors_h1b: !!entry.sponsors_h1b },
        };
      });
    const blocked = enriched.filter(j => j.triage.flags.hardBlock).length;
    process.stdout.write(`  ${entry._tier === 'watchlist' ? '★' : '·'} ${entry.name}: ${enriched.length} postings (${provider.id})\n`);
    return {
      counted: 'api',
      jobs: enriched,
      report: {
        company: entry.name, tier: entry._tier, provider: provider.id,
        status: 'ok', found: enriched.length, hardBlocked: blocked,
        note: enriched.length === 0
          ? `Scanned via ${provider.id} API — 0 postings returned (verifiably empty right now).`
          : `Scanned via ${provider.id} API — ${enriched.length} postings captured, ${blocked} hard-blocked on work-auth.`,
      },
    };
  } catch (err) {
    process.stdout.write(`  ✗ ${entry.name}: ${err.message}\n`);
    return {
      report: {
        company: entry.name, tier: entry._tier, provider: provider.id,
        status: 'error', found: 0, note: `Provider error: ${err.message}`,
      },
    };
  }
}


// ── main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? (args[companyFlag + 1] || '').toLowerCase() : null;
  const tierFlag = args.indexOf('--tier');
  const filterTier = tierFlag !== -1 ? (args[tierFlag + 1] || '').toLowerCase() : null;
  // Rescan only the companies served by one ATS. The use case is a provider
  // fix: when a provider starts returning a field it previously dropped, the
  // store needs a re-fetch of just those companies, not a full sweep of every
  // tracked employer.
  // Scan only what was ADDED since a saved copy of portals.yml. A discovery
  // pass adds hundreds of companies at once; their first scan should not have
  // to re-read the thousand boards that were already there. Pairs with
  // audit-new-boards.mjs, which takes the same file.
  const sinceFlag = args.indexOf('--new-since');
  let knownBefore = null;
  if (sinceFlag !== -1) {
    const older = yaml.load(readFileSync(path.resolve(args[sinceFlag + 1] || ''), 'utf-8')) || {};
    knownBefore = new Set((older.tracked_companies || []).map(c => c && c.name).filter(Boolean));
  }
  const providerFlag = args.indexOf('--provider');
  const filterProvider = providerFlag !== -1 ? (args[providerFlag + 1] || '').toLowerCase() : null;

  // How wide to run. The defaults are deliberately modest — this hits other
  // people's servers, and a scan that finishes in four minutes instead of
  // three is not worth a rate-limit ban that costs a day of coverage.
  const numArg = (flag, fallback) => {
    const i = args.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(args[i + 1]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const concurrency = numArg('--concurrency', DEFAULT_CONCURRENCY);
  const perHost = numArg('--per-host', DEFAULT_PER_HOST);

  const providers = await loadProviders(PROVIDERS_DIR);
  if (providers.size === 0) { console.error('No providers loaded.'); process.exit(1); }

  if (!existsSync(PORTALS_PATH)) { console.error(`portals.yml not found at ${PORTALS_PATH}`); process.exit(1); }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const watchlist = Array.isArray(config.watchlist) && config.watchlist.length
    ? config.watchlist.map(w => String(w).toLowerCase())
    : DEFAULT_WATCHLIST;

  const ctx = makeHttpCtx();
  const nowIso = new Date().toISOString();

  // Watchlist first, so the most important companies are scanned even if a run
  // is interrupted.
  const ordered = companies
    .filter(c => c && c.enabled !== false && typeof c.name === 'string')
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .filter(c => !knownBefore || !knownBefore.has(c.name))
    .map(c => ({ ...c, _tier: tierFor(c.name, watchlist) }))
    .filter(c => !filterTier || c._tier === filterTier)
    .sort((a, b) => (a._tier === 'watchlist' ? 0 : 1) - (b._tier === 'watchlist' ? 0 : 1));

  // Fetches run concurrently now; see the pool helpers above. The report is
  // built from the results BY INDEX, so it keeps its deterministic
  // watchlist-first order even though execution no longer has one.
  // FLUSHED IN CHUNKS, NOT HOARDED (F-420).
  //
  // Every posting used to be held in one array until the last company
  // answered. Across 770 tracked companies that is a quarter of a million
  // postings with full descriptions — well over a gigabyte of live objects —
  // and concurrency makes the peak arrive sooner and higher. The OS killed the
  // test suite for memory on 2026-09-08; a full sweep is the bigger
  // allocation, which is why full sweeps were being avoided in favour of
  // scoped runs. That is a workaround the scanner should not need.
  //
  // WHAT THIS TRADES AWAY, DELIBERATELY. The single write existed so a reader
  // never saw half a scan. Chunked writes give that up: a crash mid-sweep now
  // leaves some companies updated and others not. That is the better failure —
  // the alternative is a scan that cannot finish at all, and a partial sweep
  // is self-healing because the next run completes it. What must NOT be given
  // up is the store lock itself (F-295): every chunk still writes inside one,
  // so a concurrent writer's rows are never lost, and `upsertJobs` still
  // preserves the statuses the dashboard has set.
  // Overridable so the multi-chunk path can actually be exercised: at the real
  // threshold most providers flush exactly once, which tests nothing about the
  // buffer swap or the running totals.
  const FLUSH_EVERY = Number(process.env.JARVIS_SCAN_FLUSH_EVERY) || 20_000;
  const withHost = makeHostLimiter(perHost);

  const perCompany = new Array(ordered.length);
  let apiScanned = 0, needsAssist = 0, captured = 0, added = 0, updated = 0;
  let pending = [];

  async function flush() {
    if (dryRun || !pending.length) return;
    // Swap synchronously: workers keep pushing while the write awaits, and a
    // posting appended mid-flush must land in the NEXT chunk, not vanish.
    const batch = pending;
    pending = [];
    const r = await withStoreLock(async () => upsertJobs(batch, nowIso));
    added += r.added;
    updated += r.updated;
  }

  await mapPool(ordered, concurrency, async (entry, i) => {
    const r = await scanOne(entry, { providers, filterProvider, ctx, withHost });
    if (!r) return; // a --provider run skipping another ATS's company
    // Slotted by index, so the report keeps its deterministic watchlist-first
    // order even though execution no longer has one. The holes left by skipped
    // companies are dropped below.
    perCompany[i] = r.report;
    if (r.counted === 'api') apiScanned++;
    else if (r.counted === 'assist') needsAssist++;
    if (r.jobs?.length) {
      captured += r.jobs.length;
      pending.push(...r.jobs);
      if (pending.length >= FLUSH_EVERY) await flush();
    }
  });
  await flush();

  // Write only NOW, after minutes of fetching — the dashboard may have set
  // statuses meanwhile, and upsert preserves them.
  //
  // In one transaction, so a reader never sees half a scan. This used to be a
  // hand-rolled file lock: every writer rewrote the WHOLE store, so a
  // concurrent writer's additions vanished if its load→save straddled ours,
  // and two companies (Eaton, 2,204 postings; MKS, 165) were lost that way.
  // The postings are already in the store; what is left is the scan record.
  // It still goes through the lock, and it is written LAST so a run that dies
  // mid-sweep leaves no record claiming it finished.
  const report = perCompany.filter(Boolean);
  const summary = {
    at: nowIso,
    companiesScanned: apiScanned,
    companiesNeedingAssist: needsAssist,
    postingsCaptured: captured,
    added, updated,
    perCompany: report,
  };
  if (!dryRun) await withStoreLock(async () => recordScan(summary));

  console.log('\n── Scan complete ──');
  console.log(`  API-scanned companies : ${apiScanned}`);
  console.log(`  Needs assisted scan   : ${needsAssist}`);
  console.log(`  Postings captured     : ${captured}`);
  if (!dryRun) console.log(`  Store: +${added} new, ${updated} refreshed → ${STOREHINT()}`);
  if (dryRun) console.log('  (dry run — store not written)');

  // THE COMPANIES THIS RUN GOT NOTHING FROM (F-508). An empty board is not an
  // error, so nothing ever mentioned it — and a company that has left its ATS
  // looks exactly like that: Figure AI's old Ashby board answered 200 with an
  // empty list for months while 104 postings sat on Greenhouse. Named here,
  // every run, so a quiet move cannot hide inside a scan that looks complete.
  const empty = report.filter(r => r.status === 'ok' && r.found === 0).map(r => r.company);
  const failed = report.filter(r => r.status === 'error').map(r => r.company);
  const name =(list) => `${list.slice(0, 25).join(', ')}${list.length > 25 ? ` … +${list.length - 25}` : ''}`;
  if (empty.length) console.log(`\n  ⚠ ${empty.length} board(s) answered with ZERO postings — hiring freeze, or the company moved ATS:\n    ${name(empty)}`);
  if (failed.length) console.log(`\n  ⚠ ${failed.length} board(s) failed to read:\n    ${name(failed)}`);
  // ONE POSTING, ONE CARD (F-406). A board can change the URL shape it
  // publishes at any time — Zipline did, on 2026-09-03 — and from that moment
  // every posting on it arrives as a NEW row while the old one stays, because
  // "no longer listed" is not evidence a job is gone. The scan is where that
  // starts, so it is where the second spelling is pointed at the first.
  // Nothing is retired and nothing is deleted; see jarvis/dedupe.mjs.
  if (!dryRun) {
    try {
      const { dedupeStore } = await import('./dedupe.mjs');
      const said = [];
      await dedupeStore({ write: true, log: (line) => said.push(String(line)) });
      const pointed = said.map((l) => l.trim()).find((l) => l.startsWith('pointed '));
      if (pointed) console.log(`  ${pointed}`);
    } catch (err) {
      // Never the scan's problem: the postings are stored either way.
      console.log(`  (could not collapse duplicate spellings: ${err?.message || err})`);
    }
  }
  if (needsAssist) {
    console.log('\n  Companies still needing an assisted scan:');
    for (const c of report.filter(p => p.status === 'needs-assist')) {
      console.log(`    • ${c.company} — ${c.note}`);
    }
  }
}

function STOREHINT() {
  return path.relative(ROOT, path.resolve(ROOT, DB_PATH));
}

// ONLY WHEN RUN AS A COMMAND. Importing this module used to execute it — the
// class of fault recorded as F-181 (a test import overwrote his real backup)
// and F-182 (importing the apply engine opened a browser on real postings).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
