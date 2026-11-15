// jarvis/coverage-meter.mjs — how much of the live market in his field does the
// library hold? Asked of sources OUTSIDE the scanner, once a week.
//
// Every scan looks complete from the inside, and "tracked" has already turned
// out not to mean "read" (F-713). This takes live postings from outside and
// looks for each one in the store:
//
//   1. Simplify's public new-grad list (github.com/SimplifyJobs/New-Grad-Positions).
//   2. A weekly rotation of the Greenhouse, Lever and Ashby boards the store
//      already reads, through their public JSON (not the scanner's providers).
//   3. Boards the store does NOT read: employers Simplify names on Greenhouse,
//      Lever or Ashby that no row in the store belongs to.
//
// THE SAMPLE IS CUT INDEPENDENTLY OF THE LIBRARY (review, 2026-11-03). A first
// version reused the library's own title regex, discipline list and employer
// classes, so a role the library wrongly rejected could never show up as a
// miss. The sample now uses its own plain field words, the US, entry level,
// and only his HARD rules: no sponsorship / citizenship required (Simplify's
// flags), clearance words, the defense primes. Whatever the library then does
// with a posting it holds is reported beside it ("in store, removed by the
// library's title rule"), so a wrong rule is visible as such.
//
// A posting counts as found only on the same URL, the same requisition id at
// the same employer, or the same title at the same place. Read-only on the
// store, the screen cache and the ledger; logged to coverage-log.jsonl.
//
// Writes: data/jarvis/coverage-log.jsonl; the ledger, for employers it finds
// missing (queued as pending; the scheduled resolve pass resolves them, never
// this script, so it never touches portals.yml); and the cached copy of Simplify's list (data/cache, refreshed
// when a day old). --dry-run writes none of them and reads the cached list as it is.
//
// Usage:
//   node jarvis/coverage-meter.mjs [--boards 20] [--new-boards 10] [--dry-run]

import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { employerOf, reqIdOf, reqPlatformOf } from './dedupe.mjs';
import { keyOf, plainName } from './universe.mjs';
import { guardArgs } from './cli.mjs';
// The employers discovery never tracks: defense contractors and labs he skips
// for the clearance reason (Leidos, SAIC, Booz Allen, Draper…) and staffing
// shops that post other employers' jobs. His rule, written once, in the preset.
import { NEVER_TRACK } from './hiring-signals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data', 'jarvis');
export const TARGET = 0.9;
const DAY = 86_400_000;

// ── the sample, by its own words ─────────────────────────────────────

/** His field, in plain words (not the library's FIELD_TITLE). */
const FIELD_WORDS = /\b(mechanical|manufacturing|process engineer|process development|equipment engineer|robotics?|mechatronics?|automation engineer|production engineer|hardware engineer|design engineer|product design|electromechanical|npi|new product introduction|industrialization|controls engineer|tooling|fixture|integration engineer|systems engineer|reliability engineer|test engineer|quality engineer|materials engineer|packaging engineer|thermal engineer|structures? engineer|propulsion)\b/i;
const SOFTWARE = /\b(software|firmware|data (?:engineer|scientist|analyst)|machine learning|full[- ]stack|front[- ]end|back[- ]end|devops|cloud|security engineer|sales|account|marketing|recruit|finance|accounting|legal|counsel)\b/i;
/** Not entry level, in plain words. */
const ABOVE_ENTRY = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|chief|architect|vp|supervisor)\b|\b(?:ii|iii|iv|v)\b|\b[2-5]\b(?!\s*(?:year|yr))/i;
const NOT_A_JOB = /\b(intern(ship)?|co-?op|apprentice|student|fellowship|phd|postdoc)\b/i;
// His hard rules only.
const CLEARANCE = /\b(clearance|cleared|secret|ts\/sci|itar|u\.?s\.? citizen(ship)?|polygraph)\b/i;
const NOT_HIS = new Set(['U.S. Citizenship is Required', 'Does Not Offer Sponsorship']);
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '));

/** A role in his field, entry level, that no hard rule of his excludes — by title and employer. */
export function sampleKeeps(p) {
  const t = String(p.title || '');
  return FIELD_WORDS.test(t) && !SOFTWARE.test(t) && !ABOVE_ENTRY.test(t) && !NOT_A_JOB.test(t)
    && !CLEARANCE.test(t) && !NEVER_TRACK.test(String(p.company || ''));
}

/** A place in the US, read plainly: "Boise, ID", "Remote in USA", "United States". */
export function inUs(locations) {
  return [].concat(locations || []).some((l) => {
    const s = String(l || '');
    if (/\b(united states|usa|u\.s\.a?\.?)\b|remote in (?:the )?us/i.test(s)) return true;
    const m = s.match(/,\s*([A-Z]{2})\b/);
    return !!m && US_STATES.has(m[1]);
  });
}

/** Simplify's listings, cut by the sample's own rules. */
export function simplifySample(listings, { now = Date.now(), days = 30 } = {}) {
  return (listings || []).filter((l) => l && l.active && l.is_visible !== false
    && (now - Number(l.date_posted || 0) * 1000) <= days * DAY
    && !NOT_HIS.has(l.sponsorship) && inUs(l.locations))
    .map((l) => ({ source: 'simplify', company: l.company_name, title: l.title, url: l.url, location: [].concat(l.locations || []).join(' | ') }))
    .filter(sampleKeeps);
}

// ── finding it ───────────────────────────────────────────────────────

/** host + path, lower case, without query, hash or trailing slash. */
export function normUrl(u) {
  try { const x = new URL(String(u)); return `${x.hostname.replace(/^www\./, '')}${x.pathname}`.toLowerCase().replace(/\/+$/, ''); }
  catch { return String(u || '').toLowerCase(); }
}
const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const employerKey = (c) => keyOf(plainName(employerOf(c)));

/** The title a posting URL's last segment spells, without its requisition id. */
export function slugTitle(url) {
  let seg = '';
  try { seg = decodeURIComponent(new URL(String(url)).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
  if (/^\d+$/.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg)) return '';
  return normTitle(seg.replace(/[_-](?:J?R|REQ)?-?\d{4,}(?:-\d+)?$/i, '').replace(/^\d{4,}-/, ''));
}

/** The first place word of a location ("boise" from "Boise, ID"), or '' when it names none. */
export function placeWord(loc) {
  const s = String(loc || '').toLowerCase().split(/[|;·]/)[0].replace(/^(?:us|usa|united states)[\s,-]+(?:[a-z]{2}[\s,-]+)?/, '');
  const w = s.split(/[,(]/)[0].replace(/[^a-z ]/g, ' ').trim();
  return /^(remote|united states|usa|us|multiple|various|\d+ locations?)?$/.test(w) ? '' : w;
}
const samePlace = (a, b) => { const x = placeWord(a), y = placeWord(b); return !x || !y || x === y || x.includes(y) || y.includes(x); };

/**
 * Find a sampled posting among store rows: the same URL; else the same
 * requisition id at the same employer; else the same title at the same place
 * (review: a title alone found other requisitions). The title may be the one
 * the URL carries, since Simplify renames postings. A store title may carry the
 * place after the role (Micron's sitemap), so the place is also read from it.
 * @param idx { byUrl: Map<normUrl,row>, byEmployer: Map<key,row[]> }
 */
export function matchPosting(p, idx) {
  const u = idx.byUrl.get(normUrl(p.url));
  if (u) return { row: u, how: 'url' };
  const rows = idx.byEmployer.get(employerKey(p.company)) || [];
  const id = reqIdOf(p.url);
  const plat = reqPlatformOf(p.url);
  if (id) {
    // An equal id at the same employer is the same posting on any host: Leviton
    // and Keysight publish one iCIMS number on their own careers site too.
    const r = rows.find((x) => reqIdOf(x.url) === id);
    if (r) return { row: r, how: 'requisition' };
  }
  // DIFFERENT IDS IN ONE NUMBERING ARE DIFFERENT POSTINGS (review, 2026-11-03):
  // a second opening with the same title in the same city is not a copy. Title
  // and place decide only when one side has no id, or the two ids come from
  // different numberings (an Eightfold sitemap row and its Workday posting).
  const comparable = (r) => { const y = reqIdOf(r.url); return id && y && reqPlatformOf(r.url) === plat; };
  const titles = [normTitle(p.title), slugTitle(p.url)].filter((t) => t && t.split(' ').length >= 2);
  const same = rows.filter((r) => {
    if (comparable(r)) return false;
    const rt = normTitle(r.title);
    const placeOk = samePlace(p.location, r.location) || (placeWord(p.location) && rt.includes(placeWord(p.location)));
    return titles.some((t) => rt === t || rt.startsWith(`${t} `)) && placeOk;
  });
  if (!same.length) return null;
  return { row: same.find((r) => !r.gone_at) || same[0], how: 'title and place' };
}

const STAGE_WORDS = {
  'not-us': 'the library reading it as outside the US', visa: 'a work-authorisation block', 'his-rules': 'his preferences',
  level: 'the level rule', employer: 'an employer rule', title: "the library's title rule", years: 'the years rule',
  clearance: 'the clearance rule', degree: 'the degree rule', field: "the library's discipline rule", pay: 'the pay floor', 'read-before': 'a reader decision',
};

/** Why a sampled posting is or is not in the library, and what the library did with it. */
export function reasonFor(match, ledgerState, stage = null) {
  if (match) {
    if (match.row.gone_at) return 'in store, marked closed';
    if (stage && STAGE_WORDS[stage]) return `in store, removed by ${STAGE_WORDS[stage]}`;
    return 'in store';
  }
  if (!ledgerState) return 'employer not in the ledger';
  if (ledgerState === 'tracked') return 'employer tracked, posting not picked up';
  // A board turned off by a title audit or by him is a decision, not a gap
  // (first mate, 2026-11-04: Alarm.com, 6 of 83 titles his). Its own bucket,
  // outside the percentage.
  if (ledgerState === 'disabled') return DISABLED;
  return `employer ${ledgerState}`;
}

export const DISABLED = 'employer disabled on purpose';

/**
 * Coverage counts every posting the store holds open; the library's own
 * verdicts are shown beside it. Employers disabled on purpose are counted in
 * their own bucket and left out of the percentage.
 */
export function summarize(results) {
  const byReason = {};
  for (const r of results) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  const counted = results.filter((r) => r.reason !== DISABLED);
  const held = counted.filter((r) => r.reason.startsWith('in store') && r.reason !== 'in store, marked closed').length;
  return { sampled: counted.length, found: held, pct: counted.length ? Math.round((held / counted.length) * 1000) / 10 : null, byReason, ...(results.length > counted.length ? { disabledOnPurpose: results.length - counted.length } : {}) };
}

// ── the boards ───────────────────────────────────────────────────────

/** The public board token a URL names, per ATS (source optional). */
export function boardOf(source, url) {
  const u = String(url || '');
  const hint = String(source || '') || u;
  let m;
  if (/greenhouse/.test(hint) && (m = u.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)/i))) return { ats: 'greenhouse', token: m[1].toLowerCase() };
  if (/lever/.test(hint) && (m = u.match(/jobs\.lever\.co\/([\w.-]+)/i))) return { ats: 'lever', token: m[1].toLowerCase() };
  if (/ashby/.test(hint) && (m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) return { ats: 'ashby', token: decodeURIComponent(m[1]) };
  return null;
}

/** This week's slice: a stable order, a different window each week. */
export function weeklySlice(boards, n, now = Date.now()) {
  const sorted = [...boards].sort((a, b) => `${a.ats}/${a.token}`.localeCompare(`${b.ats}/${b.token}`));
  if (sorted.length <= n) return sorted;
  const start = (Math.floor(now / (7 * DAY)) * n) % sorted.length;
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, n);
}

async function readBoard({ ats, token }) {
  const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  if (ats === 'greenhouse') return ((await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`)).jobs || []).map((j) => ({ title: j.title, url: j.absolute_url, location: j.location?.name || '' }));
  if (ats === 'lever') return ((await get(`https://api.lever.co/v0/postings/${token}?mode=json`)) || []).map((j) => ({ title: j.text, url: j.hostedUrl, location: j.categories?.location || '' }));
  if (ats === 'ashby') return ((await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`)).jobs || []).map((j) => ({ title: j.title, url: j.jobUrl, location: j.location || '' }));
  return [];
}

// ── the store, read only ─────────────────────────────────────────────

export function storeIndex(storeDb, samples, companies) {
  const wanted = new Set(samples.map((p) => employerKey(p.company)));
  const byEmployer = new Map();
  // A row already pointed at another (superseded_by) is not a posting to match against.
  const q = storeDb.prepare('SELECT id, url, company, title, location, gone_at, status FROM jobs WHERE company = ? AND superseded_by IS NULL');
  for (const c of companies.filter((x) => wanted.has(employerKey(x)))) for (const r of q.all(c)) {
    const k = employerKey(r.company);
    if (!byEmployer.has(k)) byEmployer.set(k, []);
    byEmployer.get(k).push(r);
  }
  const byUrl = new Map();
  for (const rows of byEmployer.values()) for (const r of rows) byUrl.set(normUrl(r.url), r);
  const direct = storeDb.prepare('SELECT id, url, company, title, location, gone_at, status FROM jobs WHERE url = ? COLLATE NOCASE LIMIT 1');
  for (const p of samples) if (!byUrl.has(normUrl(p.url))) { const r = direct.get(String(p.url).split(/[?#]/)[0]) || direct.get(p.url); if (r) byUrl.set(normUrl(p.url), r); }
  return { byUrl, byEmployer };
}

function judge(samples, { storeDb, ledgerDb, screenDb, companies }) {
  const idx = storeIndex(storeDb, samples, companies);
  const ledger = ledgerDb ? ledgerDb.prepare('SELECT state FROM employers WHERE key = ?') : null;
  const verdict = screenDb ? screenDb.prepare('SELECT verdict, stage FROM verdicts WHERE id = ?') : null;
  return samples.map((p) => {
    const m = matchPosting(p, idx);
    const v = m && verdict ? verdict.get(m.row.id) : null;
    const state = m ? null : (ledger?.get(employerKey(p.company))?.state || null);
    return { ...p, reason: reasonFor(m, state, v?.verdict === 'out' ? v.stage : null), id: m?.row.id || null, how: m?.how || null };
  });
}

async function main() {
  const USAGE = '  node jarvis/coverage-meter.mjs [--boards N] [--new-boards N] [--dry-run]\n\n  Sample live postings in his field from outside the scanner, look each up in the store, and log coverage with reasons.';
  guardArgs({ usage: USAGE, flags: ['--boards', '--new-boards', '--dry-run', '--track'], valued: ['--boards', '--new-boards'] });
  const argv = process.argv.slice(2);
  const val = (f, d) => (argv.includes(f) ? Number(argv[argv.indexOf(f) + 1]) || d : d);
  const nBoards = val('--boards', 20), nNew = val('--new-boards', 10);
  const dry = argv.includes('--dry-run');
  const open = (f) => { try { return new DatabaseSync(path.join(DATA, f), { readOnly: true }); } catch { return null; } };
  const ctx = { storeDb: open('jobs.db'), ledgerDb: open('universe.db'), screenDb: open('screen.db') };
  ctx.companies = ctx.storeDb.prepare('SELECT DISTINCT company FROM jobs').all().map((r) => r.company);

  const { simplifyListings } = await import('./reboard.mjs');
  // --dry-run writes nothing, the Simplify cache included: it reads the copy on disk.
  const listings = dry
    ? (() => { try { return JSON.parse(readFileSync(path.join(DATA, '..', 'cache', 'simplify-listings.json'), 'utf8')); } catch { return []; } })()
    : await simplifyListings();
  const simplify = judge(simplifySample(listings), ctx);

  const sampleBoard = async (boards, source) => {
    const out = [], unread = [];
    for (const b of boards) {
      try {
        for (const j of await readBoard(b)) {
          const p = { source: `${source}:${b.ats}/${b.token}`, company: b.company, ...j };
          if (inUs([j.location]) && sampleKeeps(p)) out.push(p);
        }
      } catch (e) { unread.push(`${b.ats}/${b.token} (${e.message})`); }
    }
    return { out, unread };
  };

  // 2. Boards the store reads.
  const known = new Map();
  for (const r of ctx.storeDb.prepare("SELECT source, url, company FROM jobs WHERE gone_at IS NULL AND (source LIKE 'greenhouse%' OR source LIKE 'lever%' OR source LIKE 'ashby%') GROUP BY company, source").all()) {
    const b = boardOf(r.source, r.url);
    if (b && !known.has(`${b.ats}/${b.token}`)) known.set(`${b.ats}/${b.token}`, { ...b, company: r.company });
  }
  const read = await sampleBoard(weeklySlice([...known.values()], nBoards), 'board');
  const ats = judge(read.out, ctx);

  // 3. Boards it does not read: employers Simplify names on a public ATS with no row in the store.
  const inStore = new Set(ctx.companies.map(employerKey));
  const fresh = new Map();
  for (const l of listings || []) {
    const b = boardOf('', l.url);
    if (!b || known.has(`${b.ats}/${b.token}`) || fresh.has(`${b.ats}/${b.token}`) || inStore.has(employerKey(l.company_name))) continue;
    fresh.set(`${b.ats}/${b.token}`, { ...b, company: l.company_name });
  }
  const readNew = await sampleBoard(weeklySlice([...fresh.values()], nNew), 'new-board');
  const atsNew = judge(readNew.out, ctx);

  const out = { at: new Date().toISOString(), cmd: 'coverage-meter', target: TARGET * 100,
    simplify: summarize(simplify),
    ats: { ...summarize(ats), boards: Math.min(nBoards, known.size), unread: read.unread },
    atsNotInStore: { ...summarize(atsNew), boards: Math.min(nNew, fresh.size), boardsKnown: fresh.size, unread: readNew.unread },
    misses: [...simplify, ...ats, ...atsNew].filter((r) => !r.reason.startsWith('in store') && r.reason !== DISABLED).slice(0, 80).map((r) => `${r.reason} | ${r.company} | ${r.title} | ${r.url}`) };
  const line = (name, s) => `  ${name.padEnd(19)} ${String(s.found).padStart(4)} of ${String(s.sampled).padEnd(4)} held (${s.pct ?? '—'}%${s.pct != null && s.pct < TARGET * 100 ? `, under the ${TARGET * 100}% target` : ''})\n${Object.entries(s.byReason).filter(([k]) => k !== 'in store').map(([k, n]) => `      ${String(n).padStart(4)}  ${k}`).join('\n')}`;
  console.log('Coverage of the live market in his field (held = in the store and open):');
  console.log(line('Simplify', out.simplify));
  console.log(line('boards it reads', out.ats));
  console.log(line('boards it does not', out.atsNotInStore));
  for (const u of [...read.unread, ...readNew.unread]) console.log(`  did not answer: ${u}`);
  for (const m of out.misses.slice(0, 30)) console.log(`   · ${m}`);
  // A MISS IS QUEUED FOR DISCOVERY, NOT RESOLVED HERE (review, 2026-11-03).
  // An employer the ledger has never heard of goes into it as pending (the
  // ledger's own ingest, which refuses the never-track list). The scheduled
  // resolve pass, the one that owns portals.yml writes, resolves it with its
  // own rules and back-off. A meter measures; it does not change config.
  if (!dry) {
    const notIn = [...new Map([...simplify, ...ats, ...atsNew].filter((r) => r.reason === 'employer not in the ledger')
      .map((r) => [employerKey(r.company), r])).values()];
    if (notIn.length) {
      const { openUniverse, ingest } = await import('./universe.mjs');
      out.ledgerFeed = { ...ingest(openUniverse(), notIn.map((r) => ({ name: r.company, titles: [r.title], hardware: true })), 'coverage-meter'), names: notIn.map((r) => r.company) };
      console.log(`  queued in the ledger for the resolve pass: ${out.ledgerFeed.names.join(', ')}`);
    }
    // --track (explicit; a plain run only measures): an untracked employer whose
    // missed posting sits on a board the resolver can read gets that board,
    // through reboard's board search and writer, the path Runway takes every
    // day. A board is verified live before it is written, and the resolver's
    // lock is held, so a resolve run and this never write portals.yml at once.
    if (argv.includes('--track')) out.tracked = await trackMisses([...simplify, ...ats, ...atsNew]);
    appendFileSync(path.join(DATA, 'coverage-log.jsonl'), `${JSON.stringify(out)}\n`);
  }
}

/** Misses an untracked employer's own board could fix, one per employer. */
export function trackable(results) {
  const WHY = new Set(['employer not in the ledger', 'employer no-board', 'employer pending', 'employer gated']);
  const by = new Map();
  for (const r of results) {
    if (!WHY.has(r.reason) || NEVER_TRACK.test(String(r.company || '')) || !r.url) continue;
    const k = employerKey(r.company);
    if (!by.has(k)) by.set(k, { name: r.company, urls: [] });
    by.get(k).urls.push(r.url);
  }
  return [...by.values()];
}

async function trackMisses(results) {
  const cands = trackable(results);
  if (!cands.length) return { asked: 0, found: [] };
  const u = await import('./universe.mjs');
  const ats = await import('./discover-ats.mjs');
  const rb = await import('./reboard.mjs');
  let locked = false;
  for (let i = 0; i < 20 && !(locked = u.takeLock()); i++) await new Promise((r) => setTimeout(r, 30_000));
  if (!locked) { console.log('  --track: a resolve run holds portals.yml; the misses are asked again next run'); return { asked: cands.length, found: [], waited: true }; }
  try {
  const d = await rb.makeDeps();
  const taken = new Set(u.portalsEntries().map((e) => String(e.careers_url || '').toLowerCase().replace(/\/+$/, '')));
  const found = [];
  for (const c of cands) {
    const boards = await rb.boardsFor({ name: c.name, simplify: { urls: c.urls }, via: 'coverage-meter' }, d).catch(() => []);
    const best = boards[0];
    const k = best ? String(best.entry.careers_url).toLowerCase().replace(/\/+$/, '') : '';
    if (best && rb.isBetter(0, best.count, { adding: true }) && !taken.has(k)) {
      taken.add(k);
      found.push({ kind: 'add', name: c.name, open: 0, sector: '', entry: null, best });
      console.log(`  ✓ ${c.name}: ${best.count} via ${best.provider} ${best.entry.careers_url}`);
    } else console.log(`  · ${c.name}: no board to add${best ? ` (${best.count} at ${best.entry.careers_url}${taken.has(k) ? ', already tracked' : ''})` : ''}`);
  }
  if (found.length) await rb.applyFound(found, { u, ats });
  return { asked: cands.length, found: found.map((f) => `${f.name} (${f.best.count})`) };
  } finally { u.releaseLock(); }   // never held past the write (review, 2026-11-04)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
