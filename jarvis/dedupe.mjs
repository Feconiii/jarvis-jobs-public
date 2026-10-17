#!/usr/bin/env node
/**
 * jarvis/dedupe.mjs — one posting, one card (F-406).
 *
 * A row is identified by its URL. When a board changes the URL it publishes,
 * every posting on it becomes a SECOND row and nothing removes the first:
 * "the board stopped listing this URL" is not evidence the job is gone, and
 * this project is right to refuse to read it as such.
 *
 * Measured on his store 2026-09-08: Zipline changed its `absolute_url` shape
 * on 3 September, and 328 stale rows sat beside 338 current ones — every
 * Zipline job in his deck drawn twice.
 *
 *   first seen 2026-08-21, last 2026-09-03  …/open-roles?gh_jid=7868140003
 *   first seen 2026-09-03, last 2026-09-07  …/open-roles/7868140003?gh_jid=…
 *
 * So the old row is marked as a second SPELLING of the new one, never as a
 * death. Nothing is retired, nothing is deleted, and his decisions travel to
 * the survivor.
 *
 * WHAT COUNTS AS THE SAME POSTING is deliberately strict, and the reason is
 * KLA: Workday lists one requisition in several cities, and "Spares Demand
 * Planner 2637175" in Ann Arbor and in Phoenix are two real choices for him.
 * So the test is company AND requisition AND title AND location — never the
 * requisition alone — and the row still being listed always wins.
 *
 * Usage:
 *   node jarvis/dedupe.mjs            # say what it would do, change nothing
 *   node jarvis/dedupe.mjs --write    # point the stale spellings at the survivor
 *   node jarvis/dedupe.mjs --undo     # clear every pointer, showing them all again
 */
import vm from 'node:vm';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, withStoreLock } from './store.mjs';
import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/dedupe.mjs [--write] [--undo] [--limit <n>]

    (no flag)   report only — nothing is written
    --write     mark each stale spelling as superseded by the row that is still listed
    --undo      clear every pointer, so all rows show again
    --limit     look at no more than this many live rows (default: all)
`;
// The rule is exported for `dedupe.test.mjs`; only a direct run touches the
// store, so importing this file can never point one row at another.
const RUNNING = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUNNING) guardArgs({ usage: USAGE, flags: ['--write', '--undo', '--limit'], valued: ['--limit'] });

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The extension's ATS table, for one function: the posting id a URL carries. */
const ATS = (() => {
  const ctx = { URL, globalThis: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(HERE, 'extension', 'ats.js'), 'utf-8'), ctx);
  return ctx.__jarvisAts;
})();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A path segment with its percent-escapes resolved.
 *
 * Joby publishes `certification-project-engineer%2c-international`. Without
 * decoding, norm() turns `%2c` into the token "2c" and the segment stops
 * matching the title it is a copy of, so the posting drew twice. Malformed
 * escapes are left exactly as they are rather than throwing — a URL we cannot
 * decode is one we simply do not get to simplify.
 */
function decodeSeg(seg) {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/**
 * THE PATH, ONCE THE REQUISITION IS TAKEN OUT OF IT.
 *
 * The whole risk in this file is merging two postings that are not the same
 * one, and NVIDIA is the case that proves the location COLUMN cannot be
 * trusted for it: "Enterprise Sales Account Manager - HCLS DACH (2 Locations)"
 * stores one location string for two rows whose URLs say Germany-Munich and
 * Switzerland-Remote. KLA does the same with Ann Arbor and Phoenix. Those are
 * real, separate choices for him.
 *
 * The URL knows. Drop the segments that carry the requisition and what is left
 * is where the posting is and which board it is on:
 *
 *   /open-roles                       and  /open-roles/7868140003
 *     -> open-roles                        open-roles              SAME
 *   /…/job/Germany-Munich/…_JR2020552 and  /…/job/Switzerland-Remote/…_JR2020552
 *     -> …/job/germany-munich              …/job/switzerland-remote  DIFFERENT
 */
export function pathShape(url, token, title) {
  const bare = String(token || '').replace(/^[a-z0-9-]+:/i, '').toLowerCase();
  const wantedTitle = norm(title);
  let parts;
  try { parts = new URL(String(url)).pathname.split('/').filter(Boolean); } catch { return String(url); }
  return parts
    .filter((seg) => !(bare && seg.toLowerCase().includes(bare)))
    // A SEGMENT THAT IS THE TITLE IS NOT A LOCATION (F-451). iCIMS publishes
    // the same requisition both bare and slugged —
    //   /jobs/4895/job
    //   /jobs/4895/battery-module-senior-manufacturing-engineer/job
    // — so this returned "jobs/job" and "jobs/battery-.../job", two shapes,
    // and 133 Joby postings drew twice in his deck.
    //
    // Dropping the slug is safe precisely because the title is already its own
    // field in the grouping key: this filter cannot merge two postings whose
    // titles differ, and it cannot touch the case this function exists for —
    // KLA's Ann Arbor vs Phoenix, NVIDIA's Munich vs Zurich — because a
    // location segment never equals the title.
    .filter((seg) => !(wantedTitle && norm(decodeSeg(seg)) === wantedTitle))
    .map((seg) => seg.toLowerCase())
    .join('/');
}

/**
 * A PLACE AS A SET OF WORDS. Lam published one requisition twice, once as
 * "Tualatin, OR,US, US" and once as "US OR Tualatin" (2026-09-24), and both
 * rows sat on his Applications page as applied. Same words, other order: one
 * place. Two different cities never share their word set, so KLA's Ann Arbor
 * and Phoenix stay two.
 */
export function placeKey(location) {
  return [...new Set(norm(location).split(' ').filter(Boolean))].sort().join(' ');
}

/**
 * The only cards a repost folds away: ones on his lists that record no
 * application. Applied and later keep their card (two Amazon applications to
 * one title are two applications); hidden and skipped are not on his page and
 * carry the reasons that train the ranker.
 */
const FOLDABLE = new Set(['inbox', 'interested', 'queued']);

/**
 * REPOSTS (2026-09-24). An employer that reposts a job under a new requisition
 * leaves the old card on his lists: six GlobalFoundries "Advanced Manufacturing
 * Equipment Engineer" cards in Malta, one per repost, all closed; a closed KLA
 * "Mechanical Design Engineer" card beside the repost he applied to.
 *
 * The rule is narrower than it looks, because a different requisition is
 * usually a different job. A row is folded into its repost only when ALL of:
 *   - same company, title, place and URL shape — only the requisition differs;
 *   - two or more of the rows are on his lists (a duplicate on HIS page);
 *   - the row is GONE: its board no longer lists it;
 *   - it is inbox, interested or queued — never an application of his, never
 *     a hidden row;
 *   - the row it folds into is one of his cards, listed more recently.
 * A live posting is never folded away, and no decision moves: the survivor
 * keeps its own status (a hide carried onto a live repost would hide a job).
 *
 * @param rows [{id,url,company,title,location,lastSeen,status,goneAt}]
 */
export function repostGroups(rows, reqToken = (u) => ATS.reqToken(u)) {
  const groups = new Map();
  for (const r of rows) {
    const token = reqToken(r.url);
    if (!token) continue;
    const key = [norm(r.company), norm(r.title), placeKey(r.location), pathShape(r.url, token, r.title)].join('##');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, token });
  }
  const out = [];
  const onHisPage = (r) => !!r.status && r.status !== 'new';
  for (const rows2 of groups.values()) {
    if (new Set(rows2.map((r) => r.token)).size < 2) continue;
    // A duplicate is two of HIS cards. One dead card beside a repost he never
    // opened is not a duplicate on his page, and folding it would only take
    // the card away.
    if (rows2.filter(onHisPage).length < 2) continue;
    // The card that stays is one of his; then a row still listed; then the
    // one seen last.
    const sorted = [...rows2].sort((a, b) => (onHisPage(a) ? 0 : 1) - (onHisPage(b) ? 0 : 1)
      || (a.goneAt ? 1 : 0) - (b.goneAt ? 1 : 0)
      || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(a.id).localeCompare(String(b.id)));
    const keep = sorted[0];
    const stale = sorted.slice(1).filter((r) => r.goneAt && FOLDABLE.has(r.status) && r.token !== keep.token
      && String(r.lastSeen || '') < String(keep.lastSeen || ''));
    if (stale.length) out.push({ keep, stale });
  }
  return out;
}

/**
 * Group live rows into postings. Exported so the rule can be tested without a
 * store: the rule is the whole of this file's risk.
 *
 * @param {Array<{id:string,url:string,company:string,title:string,location:string,lastSeen:string}>} rows
 * @returns {Array<{keep:object, stale:object[]}>}
 */
export function duplicateGroups(rows, reqToken = (u) => ATS.reqToken(u)) {
  const groups = new Map();
  for (const r of rows) {
    const token = reqToken(r.url);
    // No requisition, no claim. Two postings that merely share a title are two
    // postings, and guessing otherwise is how a real job disappears.
    if (!token) continue;
    const key = [norm(r.company), token, norm(r.title), placeKey(r.location), pathShape(r.url, token, r.title)].join('##');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const rows2 of groups.values()) {
    if (rows2.length < 2) continue;
    // The one the board is still listing survives; ties keep the id that sorts
    // first so a re-run is stable.
    const sorted = [...rows2].sort((a, b) =>
      String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(a.id).localeCompare(String(b.id)));
    const [keep, ...stale] = sorted;
    // Every row seen just as recently as the survivor is left alone: without a
    // stale one there is nothing to supersede, only a guess about which of two
    // equally-live rows is the real one.
    const older = stale.filter((r) => String(r.lastSeen || '') < String(keep.lastSeen || ''));
    if (older.length) out.push({ keep, stale: older });
  }
  return out;
}

/** A decision he made on the stale row that the survivor must not lose. */
const DECIDED = new Set(['interested', 'queued', 'applied', 'inbox', 'skipped', 'hidden']);

/**
 * THE LINKEDIN COPY OF A POSTING THE EMPLOYER'S OWN BOARD ALSO CARRIES (F-674).
 *
 * import-linkedin skips a company whose board is already readable, but only at
 * import time. When the board row arrives LATER, both stay: on 2026-10-03, 24
 * of the 44 LinkedIn cards in his inbox had an employer-board twin. He had
 * already applied to five of them (Brooks, Cummins, SLB, Scrap Labs, WeRide)
 * and hidden five more. Phoenix Tailings' twin was gone from its Lever board
 * while the LinkedIn copy sat in his inbox looking open, and LinkedIn copies
 * are never retired because nothing can check one.
 *
 * Same company and same title, and a location that does not contradict:
 * different cities are two real choices (the KLA rule above). The board row is
 * kept, gone or not, because it is the better record: the engine can drive it
 * and the liveness sweep can read it. His decision on the copy is carried onto
 * a board row he has not touched yet.
 */
export function linkedinCopyGroups(rows) {
  const isLi = (r) => r.source === 'linkedin' || /linkedin\.com\/jobs/.test(String(r.url || ''));
  const key = (r) => `${String(r.company || '').toLowerCase().trim()}|${String(r.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const by = new Map();
  for (const r of rows) { if (!by.has(key(r))) by.set(key(r), []); by.get(key(r)).push(r); }
  const city = (loc) => String(loc || '').toLowerCase().split(/[,(|;·]/)[0].replace(/^(us|usa|united states)[\s-]+[a-z]{2}[\s-]+/, '').replace(/[^a-z ]/g, '').trim();
  const vague = (loc) => !city(loc) || /^(united states|usa|us|remote|multiple|\d+ locations?)$/.test(city(loc)) || /\d+ locations/i.test(String(loc || ''));
  const fits = (a, b) => vague(a.location) || vague(b.location)
    || String(b.location || '').toLowerCase().includes(city(a.location)) || String(a.location || '').toLowerCase().includes(city(b.location));
  const out = [];
  for (const g of by.values()) {
    const board = g.filter((r) => !isLi(r));
    if (!board.length) continue;
    for (const li of g.filter((r) => isLi(r) && !r.superseded_by)) {
      const match = board.filter((b) => fits(li, b));
      if (!match.length) continue;
      // A live row first, then the one listed most recently.
      const keep = match.sort((a, b) => (!!a.goneAt - !!b.goneAt) || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))[0];
      out.push({ keep, stale: [li], linkedin: true });
    }
  }
  return out;
}

/** Statuses that mean he has already dealt with this role. */
const HANDLED = { applied: 3, rejected: 2, hidden: 1 };

/**
 * The employer behind a company string: a LinkedIn page's regional name
 * ("Legrand, North & Central America") is the employer before the comma; a
 * legal suffix after one ("Wolfspeed, Inc.") is not a region.
 */
export function employerOf(company) {
  const s = String(company || '').replace(/,\s*(?=(?:inc|llc|ltd|corp|co|plc|gmbh|s\.?a|l\.?p)\b\.?\s*$)/i, ' ');
  return s.split(',')[0].toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|llc|corp|corporation|company|co|ltd|plc)$/, '');
}

/**
 * A ROLE HE HAS ALREADY HANDLED, LISTED AGAIN (2026-10-07, F-715).
 *
 * "why tf so many jobs on jarvis ive already seen or applied to, even the
 * extension says so". The extension's "you applied to this role" reads
 * company and title; the lists did not, so the same role came back:
 *   - copies Jarvis recorded from a form page (Wolfspeed 26-798's /apply page
 *     in Tracking beside the Workday posting he applied to; Standard Bots'
 *     board root);
 *   - a LinkedIn copy under the employer's regional page name ("Legrand,
 *     North & Central America") beside the Legrand posting he applied to;
 *   - the same title at the same place under another requisition (Amazon's
 *     six "Innovation and Design Engineer" postings in Bellevue; AMAT's
 *     sitemap and Eightfold copies of one Kalispell posting).
 *
 * A listed row folds into the applied, rejected or hidden row of the same
 * employer and title when it is the same requisition, or the same city. A
 * row recorded from a page or LinkedIn is a weak record whose location is
 * often a street or blank, so a location that does not CONTRADICT is enough
 * there. Another city is another opening and is left alone (KLA). Nothing
 * moves onto the handled row; `--undo` shows every row again.
 *
 * @param rows [{id,url,source,company,title,location,lastSeen,status}] — listed and handled rows together
 */
export function handledRoleGroups(rows, reqToken = (u) => ATS.reqToken(u)) {
  const key = (r) => `${employerOf(r.company)}|${norm(r.title)}`;
  const handled = new Map();
  for (const r of rows) {
    if (!HANDLED[r.status] || !employerOf(r.company) || !norm(r.title)) continue;
    if (!handled.has(key(r))) handled.set(key(r), []);
    handled.get(key(r)).push(r);
  }
  const city = (loc) => String(loc || '').toLowerCase().split(/[,(|;·]/)[0].replace(/^(us|usa|united states)[\s-]+[a-z]{2}[\s-]+/, '').replace(/[^a-z ]/g, '').trim();
  const vague = (loc) => !city(loc) || /^(united states|usa|us|remote|multiple|\d+ locations?)$/.test(city(loc)) || /\d+ locations/i.test(String(loc || ''));
  const sameCity = (a, b) => !vague(a.location) && !vague(b.location)
    && (String(b.location || '').toLowerCase().includes(city(a.location)) || String(a.location || '').toLowerCase().includes(city(b.location)));
  const weak = (r) => r.source === 'extension' || r.source === 'linkedin' || /linkedin\.com\/jobs/.test(String(r.url || ''));
  const host = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; } };
  const out = [];
  for (const r of rows) {
    if (HANDLED[r.status] || !['new', 'inbox', 'interested', 'queued', '', undefined, null].includes(r.status)) continue;
    const cands = (handled.get(key(r)) || []).filter((h) => h.id !== r.id);
    if (!cands.length) continue;
    const t = reqToken(r.url);
    const match = cands.filter((h) => {
      const ht = reqToken(h.url);
      if (t && ht && t === ht && host(r.url) === host(h.url)) return true;
      if (sameCity(r, h)) return true;
      if (!(weak(r) || weak(h))) return false;
      // A weak record: anything but a clear other city.
      return vague(r.location) || vague(h.location) || sameCity(r, h)
        || String(r.location || '').toLowerCase().includes(city(h.location)) || String(h.location || '').toLowerCase().includes(city(r.location));
    });
    if (!match.length) continue;
    const keep = match.sort((a, b) => HANDLED[b.status] - HANDLED[a.status] || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))[0];
    out.push({ keep, stale: [r], handled: true });
  }
  return out;
}

/**
 * Find the second spellings and, with `write`, point them at the survivor.
 * Exported so a scan can run it: a board changes its URL shape without
 * warning, and the doubling starts the moment it does.
 */
export async function dedupeStore({ write = false, undo = false, limit = 0, log = console.log } = {}) {
  return run({ write, undo, limit, log });
}

async function run({ write, undo, limit, log = console.log }) {
  const handle = db();
  if (undo) {
    const n = handle.prepare('UPDATE jobs SET superseded_by = NULL WHERE superseded_by IS NOT NULL').run().changes;
    log(`cleared ${n} pointer(s) — every row shows again`);
    return;
  }
  const sql = `SELECT id, url, company, title, location, last_seen AS lastSeen, status, superseded_by
               FROM jobs WHERE gone_at IS NULL AND superseded_by IS NULL${limit ? ' LIMIT ?' : ''}`;
  const rows = limit ? handle.prepare(sql).all(limit) : handle.prepare(sql).all();
  const groups = duplicateGroups(rows);
  // Reposts: only titles where a closed card of his sits, so the pass reads a
  // few hundred rows, not the whole store.
  const repostRows = handle.prepare(`SELECT j.id, j.url, j.company, j.title, j.location, j.last_seen AS lastSeen, j.status, j.gone_at AS goneAt
    FROM jobs j JOIN (SELECT DISTINCT company, title FROM jobs
      WHERE gone_at IS NOT NULL AND superseded_by IS NULL AND status IN ('inbox','interested','queued')) d
      ON j.company = d.company AND j.title = d.title
    WHERE j.superseded_by IS NULL`).all();
  const taken = new Set(groups.flatMap((g) => g.stale.map((r) => r.id)));
  for (const g of repostGroups(repostRows)) {
    const stale = g.stale.filter((r) => !taken.has(r.id));
    if (stale.length) groups.push({ ...g, stale, repost: true });
  }
  // LinkedIn copies of a board posting (F-674): every company/title that has a
  // live LinkedIn row, with its board twins whether or not they are gone.
  const liRows = handle.prepare(`SELECT j.id, j.url, j.source, j.company, j.title, j.location, j.last_seen AS lastSeen, j.status, j.gone_at AS goneAt, j.superseded_by
    FROM jobs j JOIN (SELECT DISTINCT lower(company) c, lower(title) t FROM jobs
      WHERE source = 'linkedin' AND gone_at IS NULL AND superseded_by IS NULL) d
      ON lower(j.company) = d.c AND lower(j.title) = d.t
    WHERE j.superseded_by IS NULL`).all();
  for (const g of linkedinCopyGroups(liRows)) {
    const stale = g.stale.filter((r) => !taken.has(r.id));
    if (stale.length) { groups.push({ ...g, stale }); stale.forEach((r) => taken.add(r.id)); }
  }
  // A role he already handled, listed again (F-715): his lists and the deck
  // against every row he applied to, was rejected from or hid.
  const roleRows = handle.prepare(`SELECT id, url, source, company, title, location, last_seen AS lastSeen, status
    FROM jobs WHERE superseded_by IS NULL AND (status IN ('applied','rejected','hidden','inbox','interested','queued')
      OR (status = 'new' AND deck = 1 AND gone_at IS NULL))`).all();
  for (const g of handledRoleGroups(roleRows)) {
    const stale = g.stale.filter((r) => !taken.has(r.id));
    if (stale.length) { groups.push({ ...g, stale }); stale.forEach((r) => taken.add(r.id)); }
  }
  const extra = groups.reduce((n, g) => n + g.stale.length, 0);
  const byCompany = new Map();
  for (const g of groups) byCompany.set(g.keep.company, (byCompany.get(g.keep.company) || 0) + g.stale.length);

  log(`${rows.length} live rows · ${groups.length} postings carrying more than one spelling · ${extra} extra row(s)`);
  [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([c, n]) => log(`  ${String(n).padStart(4)}  ${c}`));
  for (const g of groups.slice(0, 3).concat(groups.filter((x) => x.repost).slice(0, 10))) {
    log(`\n  ${g.keep.company} — ${g.keep.title} (${g.keep.location})${g.repost ? ' — reposted' : ''}`);
    log(`    keep  ${g.keep.lastSeen?.slice(0, 10)}  ${g.keep.url}`);
    for (const r of g.stale) log(`    old   ${r.lastSeen?.slice(0, 10)}  ${r.url}`);
  }
  if (!write) {
    log('\nNothing was written. Re-run with --write to point the old spellings at the survivor.');
    return;
  }

  let pointed = 0; let carried = 0;
  await withStoreLock(() => {
    const mark = handle.prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?');
    const carry = handle.prepare('UPDATE jobs SET status = ?, status_changed_at = ? WHERE id = ?');
    for (const g of groups) {
      for (const r of g.stale) {
        // HIS DECISION FOLLOWS THE POSTING. If he hearted, queued, applied to
        // or hid the old spelling and the survivor is still untouched, the
        // survivor inherits it — otherwise the merge would lose the one thing
        // in the row that was his.
        // A repost is another requisition: nothing is carried onto it.
        // A LinkedIn copy whose board twin is gone carries nothing: the posting is closed.
        if (!g.repost && !(g.linkedin && g.keep.goneAt) && DECIDED.has(r.status) && (g.keep.status === 'new' || !g.keep.status)) {
          carry.run(r.status, new Date().toISOString(), g.keep.id);
          g.keep.status = r.status;
          carried += 1;
        }
        mark.run(g.keep.id, r.id);
        pointed += 1;
      }
    }
  });
  log(`\npointed ${pointed} old spelling(s) at the row still being listed; ${carried} decision(s) carried over`);
  log('Nothing was retired and nothing was deleted — `--undo` puts every row back.');
}

const argv = process.argv.slice(2);
const at = argv.indexOf('--limit');
if (RUNNING) {
  await run({
    write: argv.includes('--write'),
    undo: argv.includes('--undo'),
    limit: at !== -1 ? Number(argv[at + 1]) : 0,
  });
}
