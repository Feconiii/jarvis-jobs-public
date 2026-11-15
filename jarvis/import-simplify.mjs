// jarvis/import-simplify.mjs — Simplify's new-grad list as a SOURCE, not just a meter.
//
// github.com/SimplifyJobs/New-Grad-Positions lists new-grad postings from
// employers' own boards, many of which the scanner does not read (Avature,
// Jobvite, an employer's second "early career" board). The coverage meter
// found 15 of 58 live postings in his field missing from the store.
//
// Each active, visible, US listing in the preset's categories (Hardware for
// hardware-engineering), at an employer discovery does not refuse to track
// (defense contractors, staffing shops), that Simplify does not flag with a
// label the person's work authorization bars ("Does Not Offer Sponsorship",
// "U.S. Citizenship is Required" for someone who needs sponsorship) goes
// through the store's normal path (upsertJobs) with its title-and-place triage,
// and the same whole-library screen judges it. A listing whose URL the store
// already holds merges into that row (same job id). The row is filed under the
// ATS its URL names when Jarvis has a reader for it (Workday, Greenhouse,
// iCIMS, Oracle…), so the enricher reads its body, the liveness sweep checks it
// and the apply engine can drive it. Otherwise under "simplify".
//
// Its employer goes into the ledger (source "simplify"), so the resolver looks
// for the board itself. A board is the better record (jarvis/COVERAGE.md).
//
// Usage:
//   node jarvis/import-simplify.mjs [--dry-run] [--days 60]

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { upsertJobs, db, jobId, STORE_DIR } from './store.mjs';
import { triage } from './triage.mjs';
import { DETAIL_SOURCES } from './detail-sources.mjs';
import { inUs, matchPosting, storeIndex, normUrl, employerKey } from './coverage-meter.mjs';
import { guardArgs } from './cli.mjs';
import { NEVER_TRACK } from './hiring-signals.mjs';
import { discovery, person } from './targeting.mjs';

const DAY = 86_400_000;
// Which of Simplify's sponsorship labels the person cannot take, from their
// work authorization (targeting.mjs): someone who needs sponsorship cannot take
// either; a citizen or green-card holder can take both.
export function barredLabels(who = person) {
  const out = new Set();
  if (!who?.usPerson) out.add('U.S. Citizenship is Required');
  if (who?.needsSponsorship) out.add('Does Not Offer Sponsorship');
  return out;
}

/** The ATS a posting URL is hosted on, as the store names sources. */
const HOSTS = [
  ['workday', /myworkday(?:jobs|site)\.com/i], ['greenhouse', /greenhouse\.io/i], ['lever', /jobs\.lever\.co/i],
  ['ashby', /jobs\.ashbyhq\.com/i], ['icims', /\.icims\.com/i], ['oracle-orc', /oraclecloud\.com\/hcmUI/i],
  ['successfactors', /successfactors\.(?:com|eu)|sapsf\.com|jobs\.sap\.com/i], ['smartrecruiters', /smartrecruiters\.com/i],
  ['workable', /workable\.com/i], ['bamboohr', /bamboohr\.com/i], ['breezy', /breezy\.hr/i], ['adp', /adp\.com/i],
  ['paylocity', /paylocity\.com/i], ['ukg', /ultipro\.com|ukg\.net/i], ['rippling', /rippling\.com/i],
];
export function sourceFor(url) {
  const hit = HOSTS.find(([, re]) => re.test(String(url || '')));
  return hit && DETAIL_SOURCES.includes(hit[0]) ? hit[0] : 'simplify';
}

/** Simplify's listings as store rows: only what his hard flags allow, nothing the store already has. */
// A copy under another URL is the same posting (review, 2026-11-03): besides
// the exact job id, `held(p)` asks whether the store holds it at that employer
// by requisition id, or by title at the same place (coverage-meter's matcher).
// The categories read are the preset's (`discovery.simplifyCategoryRe`): Hardware
// for hardware-engineering; a preset without one imports nothing.
export function simplifyRows(listings, { now = Date.now(), days = 60, has = () => false, held = () => false,
  categoryRe = discovery.simplifyCategoryRe, who = person } = {}) {
  const out = [];
  const barred = barredLabels(who);
  for (const l of listings || []) {
    if (!l || !l.active || l.is_visible === false) continue;
    if (!categoryRe || !categoryRe.test(String(l.category || ''))) continue;
    if (barred.has(l.sponsorship)) continue;
    if (now - Number(l.date_posted || 0) * 1000 > days * DAY) continue;
    if (!inUs(l.locations) || !l.url || !l.title || !l.company_name) continue;
    // Employers discovery never tracks: defense contractors and labs (his clearance rule), staffing shops.
    if (NEVER_TRACK.test(String(l.company_name))) continue;
    const location = [].concat(l.locations || []).join(' | ');
    if (has(jobId(l.url)) || held({ company: l.company_name, title: l.title, url: l.url, location })) continue;
    out.push({
      url: l.url, title: l.title, company: l.company_name, team: '', location, description: '',
      salary: null, postedAt: Number(l.date_posted) ? Number(l.date_posted) * 1000 : null, detailApi: null,
      source: sourceFor(l.url),
      triage: triage({ title: l.title, description: '', location, url: l.url }),
      company_meta: { tier: 'simplify', careers_url: '', notes: 'Found on Simplify\'s new-grad list.', sponsors_h1b: false },
    });
  }
  return out;
}

async function main() {
  guardArgs({ usage: '  node jarvis/import-simplify.mjs [--dry-run] [--days N]\n\n  Import Simplify\'s new-grad listings in the preset\'s categories that the person\'s work authorization allows, through the store\'s normal path.', flags: ['--dry-run', '--days', '--point-copies', '--recheck-copies'], valued: ['--days'] });
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const days = Number(argv[argv.indexOf('--days') + 1]) || 60;
  if (argv.includes('--recheck-copies')) {
    // Every Simplify row pointed at another, judged again by today's matcher
    // against that row alone (review, 2026-11-03: different ids in one
    // numbering are two postings). Pointers it no longer supports are cleared.
    const handle = db();
    const get = handle.prepare('SELECT id, company, title, location, url, gone_at, status FROM jobs WHERE id = ?');
    const pointed = handle.prepare("SELECT id, company, title, location, url, superseded_by FROM jobs WHERE tier = 'simplify' AND superseded_by IS NOT NULL").all();
    const failing = [];
    for (const s of pointed) {
      const keep = get.get(s.superseded_by);
      if (!keep) continue;
      const idx = { byUrl: new Map([[normUrl(keep.url), keep]]), byEmployer: new Map([[employerKey(keep.company), [keep]]]) };
      if (!matchPosting(s, idx)) failing.push({ s, keep });
    }
    console.log(`${pointed.length} Simplify pointer(s) judged again; ${failing.length} no longer hold`);
    for (const f of failing.slice(0, 12)) console.log(`  · ${f.s.company} — ${f.s.title}: ${f.s.url.slice(0, 80)} ≠ ${f.keep.url.slice(0, 80)}`);
    if (dry) { console.log('(dry run — nothing written)'); return; }
    const { clearPointers } = await import('./dedupe.mjs');
    await clearPointers(failing.map((f) => ({ stale: f.s.id, keep: f.keep.id })), { write: true, why: 'Simplify copy re-check: different requisition ids' });
    return;
  }
  if (argv.includes('--point-copies')) {
    // Rows imported before the copy check (2026-11-03): match each against every
    // OTHER row at its employer and point it at the one already held.
    const handle = db();
    const sim = handle.prepare("SELECT id, company, title, location, url FROM jobs WHERE tier = 'simplify' AND superseded_by IS NULL").all();
    const companies = handle.prepare('SELECT DISTINCT company FROM jobs').all().map((r) => r.company);
    const idx = storeIndex(handle, sim, companies);
    const ids = new Set(sim.map((r) => r.id));
    for (const rows of idx.byEmployer.values()) for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i].id)) rows.splice(i, 1);
    for (const [k, r] of [...idx.byUrl]) if (ids.has(r.id)) idx.byUrl.delete(k);
    const pairs = sim.map((r) => ({ stale: r.id, keep: matchPosting(r, idx)?.row.id })).filter((p) => p.keep);
    console.log(`${sim.length} Simplify row(s); ${pairs.length} already held under another URL`);
    const { pointCopies } = await import('./dedupe.mjs');
    if (dry) { console.log('(dry run — nothing written)'); return; }
    await pointCopies(pairs, { write: true });
    return;
  }
  const { simplifyListings } = await import('./reboard.mjs');
  const listings = await simplifyListings();
  const exists = db().prepare('SELECT 1 FROM jobs WHERE id = ?');
  const handle = db();
  const companies = handle.prepare('SELECT DISTINCT company FROM jobs').all().map((r) => r.company);
  const idx = storeIndex(handle, (listings || []).map((l) => ({ company: l.company_name, title: l.title, url: l.url })), companies);
  const rows = simplifyRows(listings, { days, has: (id) => !!exists.get(id), held: (p) => !!matchPosting(p, idx) });
  const by = {}; for (const r of rows) by[r.source] = (by[r.source] || 0) + 1;
  console.log(`${rows.length} Simplify listing(s) not in the store (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`);
  for (const r of rows.slice(0, 15)) console.log(`  · ${r.company} — ${r.title} [${r.location}]`);
  if (dry || !rows.length) { if (dry) console.log('(dry run — nothing written)'); return; }
  const { added, updated } = upsertJobs(rows);
  await (await import('./dedupe.mjs')).recheckAfterUpsert();   // F-1028
  const { openUniverse, ingest } = await import('./universe.mjs');
  const led = ingest(openUniverse(), rows.map((r) => ({ name: r.company, titles: [r.title], hardware: true })), 'simplify');
  console.log(`store: ${added} added, ${updated} updated · ledger: ${led.added} new employer(s), ${led.seen} known`);
  appendFileSync(path.join(STORE_DIR, 'coverage-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), cmd: 'import-simplify', listed: rows.length, added, updated, bySource: by, ledger: led })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
