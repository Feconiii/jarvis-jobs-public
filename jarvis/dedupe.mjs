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
import { db, withStoreLock, STORE_DIR, pointAt, clearPointer, clearAllPointers, restoreStatus, setStatus, decisionRank, mayHide, holdsRecord, carryDecision, notesOf, restoreNotes, setReopenedApplications, restorePointer } from './store.mjs';
import { registrableDomain } from './net-pool.mjs';
import { appendFileSync, existsSync } from 'fs';
import { guardArgs } from './cli.mjs';
import { couldBeOnePosting } from './same-posting.mjs';

const USAGE = `
  node jarvis/dedupe.mjs [--write] [--undo] [--limit <n>]

    (no flag)   report only — nothing is written
    --write     mark each stale spelling as superseded by the row that is still listed
    --undo [id] reverse one --write run exactly (the one named, or the last with --yes): its
                pointers and any status it carried onto a kept row, under the store lock
    --undo-all  clear every pointer ever set (the old --undo)
    --recheck-copies  judge every browser-assist/Handshake copy pointer by the current
                rule; with --write, clear the ones it would not set
    --recheck-decisions  judge every pointer by today's rule (F-1026): one hiding a row that
                holds more of his than its survivor is turned round (his row survives) or,
                when the two are no longer one posting, cleared; with --write, fix them
    --limit     look at no more than this many live rows (default: all)
`;
// The rule is exported for `dedupe.test.mjs`; only a direct run touches the
// store, so importing this file can never point one row at another.
const RUNNING = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUNNING) guardArgs({ usage: USAGE, flags: ['--write', '--undo', '--undo-all', '--recheck-copies', '--recheck-decisions', '--yes', '--limit'], valued: ['--limit'] });

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
    // HIS ROW SURVIVES FIRST (review, 2026-11-06): the row holding his
    // strongest decision is kept, so an application is never the spelling that
    // gets hidden behind a fresher copy that carries none of it (its applied
    // date, its resume, its notes). Then the one the board is still listing;
    // ties keep the id that sorts first so a re-run is stable.
    // At one decision, the row holding the application's record (F-1028).
    const sorted = [...rows2].sort((a, b) => decisionRank(b.status) - decisionRank(a.status)
      || (holdsRecord(b) ? 1 : 0) - (holdsRecord(a) ? 1 : 0)
      || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(a.id).localeCompare(String(b.id)));
    const [keep, ...stale] = sorted;
    // Every row seen just as recently as the survivor, holding as much of his,
    // is left alone: without a stale one there is nothing to supersede, only a
    // guess about which of two equally-live rows is the real one. A row without
    // the record, beside the one holding it, is not that guess.
    const older = stale.filter((r) => String(r.lastSeen || '') < String(keep.lastSeen || '') || decisionRank(r.status) < decisionRank(keep.status)
      || (holdsRecord(keep) && !r.applied_at));
    if (older.length) out.push({ keep, stale: older });
  }
  return out;
}

/** A decision he made on the stale row that the survivor must not lose. */
const DECIDED = new Set(['interested', 'queued', 'applied', 'inbox', 'skipped', 'hidden']);

/**
 * How much of his a row holds, for choosing the survivor and for refusing a
 * merge that would hide more than it keeps: the application pipeline, then his
 * lists, then a hide, then nothing.
 */
// The ranks and the rule live in the store, beside pointAt, the one place a copy is hidden.
export { decisionRank };

/**
 * WOULD THIS MERGE HIDE MORE OF HIS THAN IT KEEPS? (review, 2026-11-06). The
 * old spelling holds a stronger decision than the survivor and nothing carries
 * it across: an application ("rejected" included, it is later than applied)
 * behind a row still "new" disappeared from his board. Refused, and logged.
 * A repost's closed list card is hidden on purpose (the new requisition is the
 * card now); an application never is.
 */
/** Does his decision on the old spelling `r` move onto the survivor of `g`? (Reposts and closed LinkedIn twins carry nothing.) */
export const carries = (g, r) => !g.repost && !(g.linkedin && g.keep.goneAt) && DECIDED.has(r.status) && (g.keep.status === 'new' || !g.keep.status);

export function hidesHisDecision(staleStatus, keepStatus, { carried = null, repost = false } = {}) {
  if (carried) return false;
  return !mayHide({ status: staleStatus }, { status: keepStatus }, { repost });
}

/**
 * What a write would do with each old spelling, decided once for the dry run
 * and the write alike (review): within a posting the old spellings are taken
 * strongest decision first, so an application carries before a heart, and
 * the survivor's status as each carry leaves it is what the next one meets.
 */
/**
 * A SURVIVOR THAT CLOSED WHILE ITS COPY STAYS LIVE (review, 2026-11-06). The
 * survivor is the row with his decision, which can be the older posting; when
 * that one closes, his card would read closed and Apply would open the dead
 * address while the live copy stayed hidden behind it. For a card he has not
 * applied through (new, his lists, a hide), the two swap: his decision and
 * notes go onto the live row and the closed one points at it. An application
 * stays where it is — he has applied, and its record (date, resume) is on it.
 */
const SWAPPABLE = new Set(['new', 'inbox', 'interested', 'queued', 'skipped', 'hidden']);
const APPLICATION = new Set(['applied', 'rejected', 'responded', 'interview', 'offer']);
const closedWithLiveCopy = (handle) => handle.prepare(`SELECT k.id AS keepId, k.status AS keepStatus, k.status_changed_at AS keepChanged, k.company, k.title, k.url AS keepUrl,
      s.id AS liveId, s.status AS liveStatus, s.status_changed_at AS liveChanged, s.last_seen AS liveSeen, s.url AS liveUrl
    FROM jobs s JOIN jobs k ON k.id = s.superseded_by
    WHERE s.superseded_by IS NOT NULL AND s.gone_at IS NULL AND k.gone_at IS NOT NULL AND k.superseded_by IS NULL`).all()
  // One live copy per closed survivor: the one the board listed last.
  .sort((a, b) => String(b.liveSeen || '').localeCompare(String(a.liveSeen || '')))
  .filter((p, i, all) => all.findIndex((q) => q.keepId === p.keepId) === i);
const pairKey = (a, b) => [String(a), String(b)].sort().join('|');
/**
 * Pairs swapped in the last `days` (review: a posting whose liveness flips back
 * and forth would otherwise swap on every scan). Either direction counts.
 */
export function recentSwaps({ days = 7, runs = readJournal(), now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const out = new Set();
  for (const r of runs) {
    if (r.undone || !(Date.parse(r.at || r.runId) >= since)) continue;
    for (const m of r.merges || []) if (m.repointed) out.add(pairKey(m.stale, m.keep));
  }
  return out;
}
export function closedSurvivors(handle, { recent = recentSwaps() } = {}) {
  return closedWithLiveCopy(handle)
    .filter((p) => SWAPPABLE.has(p.keepStatus || 'new') && decisionRank(p.liveStatus) <= decisionRank(p.keepStatus))
    .filter((p) => !recent.has(pairKey(p.keepId, p.liveId)));
}
/**
 * AN APPLICATION ON A POSTING THAT REOPENED (review, 2026-11-06). The swap
 * leaves an application where its record is, so the live repost stays hidden
 * behind it; he must still see that it is open again. Named in the log and on
 * the Overview (store.reopenedApplications).
 */
export function reopenedApplications(handle) {
  return closedWithLiveCopy(handle).filter((p) => APPLICATION.has(p.keepStatus))
    .map((p) => ({ keepId: p.keepId, liveId: p.liveId, status: p.keepStatus, company: p.company, title: p.title, keepUrl: p.keepUrl, liveUrl: p.liveUrl }));
}

export function planMerges(groups) {
  const plan = [];
  for (const g of groups) {
    let keepStatus = g.keep.status;
    const stale = [...g.stale].sort((a, b) => decisionRank(b.status) - decisionRank(a.status) || String(a.id).localeCompare(String(b.id)));
    for (const r of stale) {
      const carry = carries({ ...g, keep: { ...g.keep, status: keepStatus } }, r);
      const refuse = !carry && !mayHide(r, { ...g.keep, status: keepStatus }, { repost: !!g.repost });
      plan.push({ g, r, carry, refuse, keepBefore: keepStatus || 'new' });
      if (carry) keepStatus = r.status;
    }
  }
  return plan;
}

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
// A COPY SOURCE is any row that is not the employer's own board: LinkedIn,
// the browser-assist rows harvested from a careers page the server cannot read,
// and Handshake (2026-11-03: Symbotic held four roles twice, browser-assist
// beside its Workday board). The board row is the one kept.
export const COPY_SOURCES = /^(linkedin|browser-assist|handshake)/;
/** Rows that only ever copy a posting: the copy sources and Simplify's own rows. */
const COPY_OR_SIMPLIFY = /^(linkedin|browser-assist|handshake|simplify)/;
// A requisition-like code at the end of a path: Symbotic's own careers page
// writes /open-positions/R7209, its Workday board …/Cell-Operator_R7540.
const reqLike = (u) => (String(u || '').split(/[?#]/)[0].match(/(?:^|[\/_-])((?:J?R|REQ)?-?\d{4,})\/?$/i) || [])[1]?.replace(/-/g, '').toUpperCase() || '';
/** A requisition id without its decoration: "R07540", "JR-7540", "req7540" → "7540". */
export function normReqId(id) {
  return String(id || '').toUpperCase().replace(/^(?:J?R|REQ)[-_ ]?(?=\d)/, '').replace(/[-_ ]/g, '').replace(/^0+(?=\d)/, '');
}
// reqToken answers "workday:Cell-Operator_R7540", "icims:5054": the platform
// goes, and a Workday slug keeps only the requisition code at its end.
// The trailing "-1"/"-2" is stripped only where it is a known repost marker:
// Workday's ("Engineer-I--Manufacturing_31163527-2" is 31163527 posted again).
// Elsewhere it is part of the id (review, 2026-11-03: "1234-1" is not "1234").
const codeOf = (t) => {
  const s = String(t || '');
  const workday = /^workday:/i.test(s);
  const v = s.replace(/^[a-z-]+:/i, '');
  const m = workday
    ? v.match(/(?:^|[_\-/])((?:J?R|REQ)?-?\d{3,})(?:-\d{1,2})?$/i)
    : v.match(/(?:^|[_\-/])((?:J?R|REQ)?-?\d{3,}(?:-\d{1,2})?)$/i);
  return m ? m[1] : v;
};
/** The normalised requisition id a posting URL carries, or ''. */
export function reqIdOf(url, reqToken = (u) => ATS.reqToken(u)) {
  return normReqId(codeOf(reqToken(url)) || reqLike(url));
}
/**
 * Which numbering a requisition id belongs to: the ATS reqToken names
 * ("workday", "icims"…), else the host. Micron's Eightfold sitemap row
 * (careers.micron.com/…/42120395-…) and its Workday posting (…_JR115580) are
 * one posting in two numberings, so ids are compared only within one.
 */
/** The tenant or board a posting URL names on a shared ATS host, else its host. */
export function tenantOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  let m;
  if ((m = host.match(/^([\w-]+)\.wd\d+\.myworkdayjobs\.com$/))) return m[1];
  if (/myworkdaysite\.com$/.test(host)) return (seg[seg[0] === 'recruiting' ? 1 : 2] || '').toLowerCase();
  if (/greenhouse\.io$/.test(host)) return (seg[0] === 'v1' ? seg[2] : seg[0] === 'embed' ? u.searchParams.get('for') : seg[0] || '').toLowerCase();
  if (/(^|\.)lever\.co$/.test(host) || /(^|\.)ashbyhq\.com$/.test(host) || /smartrecruiters\.com$/.test(host)) return (seg[0] === 'v1' || seg[0] === 'v0' ? seg[2] : seg[0] || '').toLowerCase();
  return host;
}

export function reqPlatformOf(url, reqToken = (u) => ATS.reqToken(u)) {
  const t = String(reqToken(url) || '');
  const m = t.match(/^([a-z-]+):/i);
  // The ATS numbers per tenant or board (review, 2026-11-03): two employers'
  // Workday tenants both have an R123. The tenant or board token is part of
  // the numbering, so two of them never share one.
  if (m) return `${m[1].toLowerCase()}:${tenantOf(url)}`;
  // A host is one numbering with every host under its registrable domain
  // (review, 2026-11-03): careers.x.com and jobs.x.com number postings alike.
  try { return registrableDomain(new URL(String(url)).hostname.toLowerCase()) || ''; } catch { return ''; }
}
export function linkedinCopyGroups(rows, reqToken = (u) => ATS.reqToken(u)) {
  const isLi = (r) => COPY_SOURCES.test(String(r.source || '')) || /linkedin\.com\/jobs/.test(String(r.url || ''));
  const key = (r) => `${String(r.company || '').toLowerCase().trim()}|${String(r.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const by = new Map();
  for (const r of rows) { if (!by.has(key(r))) by.set(key(r), []); by.get(key(r)).push(r); }
  const city = (loc) => String(loc || '').toLowerCase().split(/[,(|;·]/)[0].replace(/^(us|usa|united states)[\s-]+[a-z]{2}[\s-]+/, '').replace(/[^a-z ]/g, '').trim();
  const vague = (loc) => !city(loc) || /^(united states|usa|us|remote|multiple|\d+ locations?)$/.test(city(loc)) || /\d+ locations/i.test(String(loc || ''));
  // THE REQUISITION FIRST (2026-11-03): two different requisition ids are two
  // postings, whatever their titles and towns (Symbotic R7209 is not R7540).
  // A LinkedIn URL carries LinkedIn's own id, so it is not compared.
  // Review (2026-11-03): ids are normalised (R/JR/REQ prefixes, dashes, zero
  // padding) and compared EXACTLY; "R71234" is not "1234". A copy that is not a
  // LinkedIn row must carry an id that equals the board row's: with no id on
  // either side there is no proof, so no merge. LinkedIn rows keep F-674's
  // company + title + place rule (their URL holds LinkedIn's own id).
  const isLinkedIn = (r) => r.source === 'linkedin' || /linkedin\.com/.test(String(r.url || ''));
  const idOf = (r) => reqIdOf(r.url, reqToken);
  const sameReq = (copy, board) => {
    if (isLinkedIn(copy)) return true;
    const x = idOf(copy), y = idOf(board);
    return !!x && !!y && x === y;
  };
  const fits = (a, b) => sameReq(a, b) && (vague(a.location) || vague(b.location)
    || String(b.location || '').toLowerCase().includes(city(a.location)) || String(a.location || '').toLowerCase().includes(city(b.location)));
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
export async function dedupeStore({ write = false, undo = false, limit = 0, log = console.log, recheckDecisions = false, yes = false } = {}) {
  return run({ write, undo, undoAll: false, limit, log, recheckDecisions, yes });
}

// EACH --write RUN IS RECORDED (review, 2026-11-03): --undo cleared every
// pointer ever set and left carried statuses behind. Now a run's merges (the
// pointer, and any status it carried onto the kept row with that row's prior
// status) are journalled, and --undo reverses exactly one run.
const JOURNAL = path.join(STORE_DIR, 'dedupe-runs.jsonl');
function readJournal() {
  if (!existsSync(JOURNAL)) return [];
  const lines = readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const undone = new Set(lines.filter((l) => l.undid).map((l) => l.undid));
  return lines.filter((l) => l.runId).map((l) => ({ ...l, undone: undone.has(l.runId) }));
}

/**
 * What undoing one merge may change, given the rows as they are now. Only what
 * the run itself did: a pointer someone has since moved is left, and a carried
 * status is put back only if the kept row still carries it.
 */
export function undoPlan(merge, now) {
  return {
    unmark: !!now.stale && now.stale.superseded_by === merge.keep,
    restore: !!merge.carried && !!merge.keepPrior && !!now.keep && now.keep.status === merge.carried,
  };
}

/**
 * Copy pointers that the current rule would not set (review, 2026-11-03): each
 * {stale, keep} pair of rows is judged again by linkedinCopyGroups.
 */
// Only pairs the copy rule could have made: a copy source against a board row
// with the same company and title. A pointer another rule set (the same
// requisition under a new URL spelling: Joby's "Performance Lead/DER" and
// "Performance Lead Der", one iCIMS id) is not this rule's to judge.
export function copyShaped({ stale, keep }) {
  const k = (r) => `${String(r.company || '').toLowerCase().trim()}|${String(r.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return COPY_SOURCES.test(String(stale.source || '')) && !COPY_SOURCES.test(String(keep.source || '')) && k(stale) === k(keep);
}
/**
 * May these two rows be linked as one posting? Equal requisition ids prove it;
 * otherwise the same employer and a similar title (same-posting.mjs).
 */
export function linkable(stale, keep, reqToken = (u) => ATS.reqToken(u)) {
  const x = reqIdOf(stale.url, reqToken), y = reqIdOf(keep.url, reqToken);
  if (x && x === y) return true;
  return couldBeOnePosting(stale, keep);
}

/**
 * Copy links whose rows no longer look like one posting: a title on either
 * side changed after the link was made (Hyve's board row was retitled "Staff
 * Thermal Engineer" under its "System Thermal Engineer" LinkedIn copies), or
 * the link was wrong from the start. Any copy source, any rule that set it.
 */
export function driftedCopyPointers(pairs, reqToken = (u) => ATS.reqToken(u)) {
  return pairs.filter(({ stale, keep }) => COPY_OR_SIMPLIFY.test(String(stale.source || '')) && !linkable(stale, keep, reqToken));
}

export function failingCopyPointers(pairs, judgeFn = linkedinCopyGroups) {
  // Two equal requisition ids are proof of one posting, whatever else differs.
  const sameId = ({ stale, keep }) => { const x = reqIdOf(stale.url), y = reqIdOf(keep.url); return !!x && x === y; };
  return pairs.filter(copyShaped).filter((p) => !sameId(p)).filter(({ stale, keep }) => !judgeFn([{ ...stale, superseded_by: null }, keep]).some((g) => g.keep.id === keep.id && g.stale.some((s) => s.id === stale.id)));
}

/**
 * Store writes, then their journal line (review, 2026-11-06: the line is
 * appended AFTER the commit, so the journal never names a run the store rolled
 * back). withStoreLock is one IMMEDIATE transaction that commits when the
 * callback returns. If the append itself fails after a commit, the run is
 * said in full on stderr so it can be undone by hand from that line.
 */
async function journalled(handle, writes, entry) {
  let line = null;
  const out = await withStoreLock(() => {
    const o = writes();
    line = typeof entry === 'function' ? entry(o) : entry;
    return o;
  });
  if (line) {
    try { appendFileSync(JOURNAL, `${JSON.stringify(line)}\n`); }
    catch (e) { console.error(`dedupe: the run was written but its journal line was not (${e.message}): ${JSON.stringify(line)}`); }
  }
  return out;
}

/**
 * Point copies another command matched at their kept rows (2026-11-03: Simplify
 * rows already held under a board's own URL). The same journalled, undoable
 * write as a --write run; nothing is carried, since a copy has no decision of
 * his. `pairs`: [{ stale: id, keep: id }].
 */
/**
 * A ROW JUST HIDDEN TAKES ITS INCOMING POINTERS WITH IT (F-1034, 2026-11-07).
 * The merge pass hid rows that other copies already pointed at, and every one
 * of those became a chain the recheck then had to collapse (24 after the 13:08
 * scan). Now each row pointing at `staleId` is pointed straight at `keepId`
 * through the store's own guard; one the guard refuses (it holds more of his
 * than the survivor) is left pointing nowhere, so it shows. Returns the moves,
 * journalled on the merge so an undo puts each back exactly.
 */
function moveIncoming(handle, staleId, keepId) {
  const moves = [];
  const into = handle.prepare('SELECT id FROM jobs WHERE superseded_by = ?').all(String(staleId)).map((r) => r.id).filter((id) => id !== keepId);
  for (const id of into) {
    if (!clearPointer(id, { from: staleId })) continue;
    const to = pointAt(id, keepId, { notes: true }) ? keepId : null;
    moves.push({ id, from: staleId, to });
  }
  return moves;
}

export async function pointCopies(pairs, { write = false, log = console.log } = {}) {
  let fresh = pairs.filter((p) => p.stale && p.keep && p.stale !== p.keep);
  if (!write || !fresh.length) return { pointed: 0, runId: null };
  const handle = db();
  // TWO ROLES ARE NEVER ONE COPY (review, 2026-11-04): whatever matched them,
  // the rows must name the same employer and a similar title, unless both
  // carry the same requisition id. Every command that links copies writes here.
  const row = handle.prepare('SELECT id, url, company, title FROM jobs WHERE id = ?');
  const refused = [];
  fresh = fresh.filter((p) => {
    const s = row.get(p.stale), k = row.get(p.keep);
    if (!s || !k || linkable(s, k)) return true;
    refused.push(p); return false;
  });
  if (refused.length) log(`refused ${refused.length} link(s) between rows with another employer or title`);
  const runId = new Date().toISOString();
  const merges = [];
  await journalled(handle, () => {
    for (const p of fresh) {
      if (!pointAt(p.stale, p.keep, { onlyIfUnset: true })) continue;
      const merge = { stale: p.stale, keep: p.keep, carried: null, keepPrior: null };
      const incoming = moveIncoming(handle, p.stale, p.keep);
      if (incoming.length) merge.incoming = incoming;
      merges.push(merge);
    }
  }, () => (merges.length ? { runId, at: runId, merges, via: 'pointCopies' } : null));
  log(`pointed ${merges.length} copy row(s) at the row already held — \`node jarvis/dedupe.mjs --undo ${runId}\` reverses it`);
  return { pointed: merges.length, runId };
}

/** Clear pointers a re-check no longer supports, journalled. `pairs`: [{ stale, keep }]. */
export async function clearPointers(pairs, { write = false, why = '', log = console.log } = {}) {
  if (!write || !pairs.length) return { cleared: 0 };
  const handle = db();
  const cleared = [];
  await journalled(handle, () => {
    for (const p of pairs) if (clearPointer(p.stale, { from: p.keep })) cleared.push({ stale: p.stale, keep: p.keep });
  }, () => (cleared.length ? { recheck: new Date().toISOString(), why, cleared } : null));
  log(`cleared ${cleared.length} pointer(s)${why ? ` (${why})` : ''}`);
  return { cleared: cleared.length };
}

/**
 * EVERY POINTER JUDGED AGAIN BY TODAY'S RULE (--recheck-decisions, 2026-11-06).
 * Pointers set before F-1026 can hide a row holding more of his than the row
 * they point at (two rejected applications behind untouched copies). For each:
 * when the two rows are still one posting by the dedupe rule, they are turned
 * round so his row survives; otherwise the pointer is cleared and both show.
 * A closed list card behind its repost was hidden on purpose and stays.
 */
const holdsApplication = (r) => APPLICATION.has(r?.status) || !!r?.applied_at;
/**
 * Which row of a loop shows: his strongest decision; then the one holding the
 * application's own record (applied_at, and the resume sent with it); then the
 * one listed most recently; then the id.
 */
const loopSurvivor = (rows) => [...rows].sort((a, b) => decisionRank(b.status) - decisionRank(a.status)
  || (b.applied_at ? 1 : 0) - (a.applied_at ? 1 : 0)
  || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(a.id).localeCompare(String(b.id)))[0];

/**
 * The whole recheck, decided before anything is written (2026-11-06):
 *   loops     rows pointing round in a circle: none of them shows. The row with
 *             his strongest decision shows; the others point at it.
 *   chains    a row pointing at a row that is itself pointed: it points straight
 *             at the visible end instead.
 *   failing   a pointer hiding a row that holds more of his than its survivor:
 *             turned round when the two are still one posting, else cleared.
 *   skipped   one where his decision on the survivor is NEWER (he hid the board
 *             row after picking the copy): his latest choice stands. Never for a
 *             row holding an application, which is never left hidden this way.
 */
export function recheckPlan(handle) {
  const cols = 'id, url, source, company, title, location, last_seen AS lastSeen, status, status_changed_at, applied_at, gone_at, superseded_by';
  const pointed = handle.prepare(`SELECT ${cols} FROM jobs WHERE superseded_by IS NOT NULL`).all();
  const byId = new Map(pointed.map((r) => [r.id, r]));
  const getRow = handle.prepare(`SELECT ${cols} FROM jobs WHERE id = ?`);
  const rowOf = (id) => byId.get(id) || getRow.get(id);
  // Loops first: follow each pointer until it ends or comes round.
  const loops = []; const inLoop = new Set();
  for (const r of pointed) {
    if (inLoop.has(r.id)) continue;
    const path = [r.id]; let cur = r;
    for (let n = 0; cur && cur.superseded_by && n < 50; n += 1) {
      const at = path.indexOf(cur.superseded_by);
      if (at >= 0) {
        const members = path.slice(at).map((id) => rowOf(id));
        if (!members.some((m) => inLoop.has(m.id))) { members.forEach((m) => inLoop.add(m.id)); loops.push({ members, survivor: loopSurvivor(members) }); }
        break;
      }
      path.push(cur.superseded_by); cur = rowOf(cur.superseded_by);
    }
  }
  // The visible end of a pointer, once the loops are broken.
  const survivorOf = new Map(); for (const l of loops) for (const m of l.members) survivorOf.set(m.id, l.survivor.id);
  const endOf = (id) => {
    let cur = rowOf(id);
    for (let n = 0; cur && n < 50; n += 1) {
      if (survivorOf.has(cur.id)) return rowOf(survivorOf.get(cur.id));
      if (!cur.superseded_by) return cur;
      cur = rowOf(cur.superseded_by);
    }
    return null;
  };
  const chains = []; const failing = []; const skipped = [];
  for (const s of pointed) {
    if (inLoop.has(s.id)) continue;
    const k = rowOf(s.superseded_by);
    if (!k) continue;
    const end = k.superseded_by || survivorOf.has(k.id) ? endOf(k.id) : k;
    if (!end || end.id === s.id) continue;
    const viaChain = end.id !== k.id;
    if (mayHide(s, end, { repost: !!s.gone_at })) { if (viaChain) chains.push({ s, k, end }); continue; }
    // His newer decision on the survivor stands — never for an application.
    if (!holdsApplication(s) && decisionRank(end.status) > 0 && end.status_changed_at && s.status_changed_at && end.status_changed_at > s.status_changed_at) {
      skipped.push({ s, k: end, why: `his decision on the survivor (${end.status}, ${String(end.status_changed_at).slice(0, 10)}) is newer than this one (${s.status}, ${String(s.status_changed_at).slice(0, 10)})` });
      continue;
    }
    // Still one posting, his row the survivor? (Both as live, so the rule judges the postings, not their liveness.)
    const g = duplicateGroups([{ ...s, superseded_by: null }, { ...end, superseded_by: null }]);
    const regrouped = g.length === 1 && g[0].keep.id === s.id && g[0].stale.some((r) => r.id === end.id);
    // …or plainly one job: the same employer, the same title and the same place,
    // all three named (first mate, 2026-11-06: "visible is safer than tidy", so
    // anything less shows both rows instead).
    const named = (x) => !!String(x || '').trim();
    const samePosting = named(s.company) && named(s.title) && named(s.location)
      && employerOf(s.company) === employerOf(end.company) && norm(s.title) === norm(end.title)
      && placeKey(s.location) === placeKey(end.location);
    const swap = !viaChain && (regrouped || samePosting);
    failing.push({ s, k: end, fix: swap ? 'swap' : 'release' });
  }
  return { loops, chains, failing, skipped };
}
/** The pointers the recheck would fix (kept for callers that want the flat list). */
export const pointersHidingHisDecision = (handle) => recheckPlan(handle).failing;

/**
 * THE RECHECK, WRITTEN (2026-11-06), until nothing is left to fix. One pass
 * can leave work for the next — a chain collapsed onto a row that a later
 * turn-round then points elsewhere (KLA, 2026-11-06) — so the passes repeat
 * inside one lock, at most five, until a plan finds nothing. Every pointer and
 * note changed is journalled as it was and as it is left (--undo restores
 * exactly). Returns the counts; writes no journal line when nothing changed.
 */
/** After any upsert outside a scan (the import scripts): the recheck, quiet unless it changed something. */
export const recheckAfterUpsert = ({ log = console.log } = {}) => recheckWrite(db(), { log, quietWhenClean: true })
  .catch((err) => { log(`  (the recheck after this import failed: ${err?.message || err})`); return null; });
export const RECHECK_MAX_PASSES = 5;
// `follows`: the --write run this recheck ends (code review #5). Its journal
// line names that run, so an undo of the --write takes the recheck back first.
export async function recheckWrite(handle, { log = console.log, quietWhenClean = false, plan: planOf = recheckPlan, maxPasses = RECHECK_MAX_PASSES, follows = null } = {}) {
  const runId = new Date().toISOString();
  const n = { passes: 0, loops: 0, loopClears: 0, loopPointed: 0, chains: 0, ruleClears: 0, turned: 0, refusedAfterClear: 0, skipped: 0, settled: true, leftAfterCap: 0 };
  const t0 = Date.now();
  // EXACT BEFORE AND AFTER (review, 2026-11-06): every pointer and note this
  // run changes is journalled as it was and as it is left, so --undo puts
  // back precisely the state it found — loops and chains included.
  // Every pointed row and every row pointed at, as two queries. In one, SQLite
  // passed over the whole table: `… OR id IN (…)` took 1.0 s on his store, a
  // UNION 10 s (it merged through the primary key). Apart, each reads only
  // idx_jobs_superseded and the primary key.
  const snapPointers = () => new Map([
    ...handle.prepare('SELECT id, superseded_by FROM jobs WHERE superseded_by IS NOT NULL').all(),
    ...handle.prepare('SELECT id, superseded_by FROM jobs WHERE id IN (SELECT superseded_by FROM jobs WHERE superseded_by IS NOT NULL)').all(),
  ].map((r) => [r.id, r.superseded_by ?? null]));
  const notesFirst = new Map();
  const touchNotes = (id) => { if (!notesFirst.has(id)) notesFirst.set(id, notesOf(id)); };
  const repoint = (staleId, fromId, toId) => {
    if (fromId && !clearPointer(staleId, { from: fromId })) return false;
    touchNotes(toId);
    if (!pointAt(staleId, toId)) { if (fromId) n.refusedAfterClear += 1; return false; }   // its old pointer is gone: it shows
    return true;
  };
  let pointerDiffs = []; let noteDiffs = [];
  const todoOf = (p) => p.loops.length + p.chains.length + p.failing.length;
  await journalled(handle, () => {
    const lockAt = Date.now();
    let before = null;   // taken only when there is something to change (a clean store: one plan, nothing else)
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const p = planOf(handle);   // judged inside the lock, again each pass
      if (pass === 0) n.skipped = p.skipped.length;
      if (!todoOf(p)) break;
      if (!before) before = snapPointers();
      n.passes += 1;
      // 1. Loops: the survivor shows, every other member points straight at it.
      for (const l of p.loops) {
        n.loops += 1;
        if (clearPointer(l.survivor.id, { from: l.survivor.superseded_by })) n.loopClears += 1;
        for (const m of l.members) if (m.id !== l.survivor.id && m.superseded_by !== l.survivor.id && repoint(m.id, m.superseded_by, l.survivor.id)) n.loopPointed += 1;
      }
      // 2. Chains: straight at the visible end.
      for (const c of p.chains) if (repoint(c.s.id, c.k.id, c.end.id)) n.chains += 1;
      // 3. A pointer hiding more of his: his row is shown, then (when the two
      // are still one posting) the other row points at it.
      for (const f of planOf(handle).failing) {
        if (!clearPointer(f.s.id, { from: f.s.superseded_by })) continue;
        if (f.fix === 'swap' && !f.k.superseded_by && repoint(f.k.id, null, f.s.id)) { n.turned += 1; continue; }
        n.ruleClears += 1;
      }
    }
    // THE CAP IS NEVER SILENT (review): one more plan after the last pass.
    if (n.passes >= maxPasses) {
      const left = todoOf(planOf(handle));
      if (left) { n.settled = false; n.leftAfterCap = left; }
    }
    const after = before ? snapPointers() : new Map();
    if (!before) before = new Map();
    n.lockMs = Date.now() - lockAt;
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const b = before.has(id) ? before.get(id) : null; const a = after.has(id) ? after.get(id) : null;
      if (b !== a) pointerDiffs.push({ id, before: b, after: a });
    }
    noteDiffs = [...notesFirst].map(([id, b]) => ({ id, before: b, after: notesOf(id) })).filter((d) => JSON.stringify(d.before) !== JSON.stringify(d.after));
  }, () => (pointerDiffs.length || !n.settled ? { runId, at: runId, recheckDecisions: true, ...(follows && pointerDiffs.length ? { follows } : {}), pointers: pointerDiffs, notes: noteDiffs, counts: n }
    // A CLEAN RECHECK LEAVES ONE LINE TOO (first mate, 2026-11-06: "so I can see it ran"). No runId, so no undo ever picks it.
    : { recheckClean: true, at: runId, ms: n.lockMs, skipped: n.skipped, by: path.basename(process.argv[1] || 'unknown') }));
  n.totalMs = Date.now() - t0;
  if (!n.settled) log(`\n!!! RECHECK DID NOT SETTLE: ${n.leftAfterCap} pointer(s) still to fix after ${maxPasses} passes — run \`node jarvis/dedupe.mjs --recheck-decisions\` and look (journalled as ${runId}).`);
  if (pointerDiffs.length || !quietWhenClean) {
    log(`\n${quietWhenClean ? 'recheck after the pass' : 'written'}: ${n.loops} loop(s) broken (${n.loopClears} survivor pointer(s) cleared, ${n.loopPointed} member(s) pointed at the survivor), ${n.chains} chain(s) collapsed, ${n.ruleClears} pointer(s) cleared by the rule, ${n.turned} turned round${n.refusedAfterClear ? `, ${n.refusedAfterClear} left showing (the store refused the new pointer)` : ''}; ${n.skipped} left as they are; ${n.passes} pass(es), the store held ${n.lockMs ?? 0} ms. ${pointerDiffs.length} pointer change(s) journalled${pointerDiffs.length ? ` — \`--undo ${runId}\` restores them exactly` : ''}.`);
  }
  return { ...n, changes: pointerDiffs.length, runId: pointerDiffs.length ? runId : null };
}

/** Reverse one journalled run, journalling the undo. */
async function undoRun(handle, target, log) {
  // A RECHECK RUN IS PUT BACK EXACTLY (review): each pointer and note as it
  // was, wherever it is still what the run left — no rule judges an undo.
  if (target.recheckDecisions && Array.isArray(target.pointers)) {
    let restored = 0, left = 0, notes = 0;
    await journalled(handle, () => {
      for (const d of [...target.pointers].reverse()) { if (restorePointer(d.id, d.before, { expect: d.after })) restored += 1; else left += 1; }
      for (const d of target.notes || []) if (restoreNotes(d.id, d.before, d.after)) notes += 1;
    }, () => ({ undid: target.runId, at: new Date().toISOString(), pointers: restored, notes }));
    log(`undid recheck run ${target.runId}: ${restored} pointer(s) and ${notes} note(s) put back exactly${left ? `, ${left} left (changed since)` : ''}`);
    return;
  }
  const get = handle.prepare('SELECT superseded_by, status FROM jobs WHERE id = ?');
  let pointers = 0, statuses = 0, skipped = 0;
  await journalled(handle, () => {
    for (const m of target.merges) {
      const plan = undoPlan(m, { stale: get.get(m.stale), keep: get.get(m.keep) });
      if (plan.unmark) { clearPointer(m.stale); pointers++; } else skipped++;
      if (plan.restore) { restoreStatus(m.keep, m.keepPrior.status, m.keepPrior.statusChangedAt); statuses++; }
      // The survivor's notes as they were, unless he has written since (review).
      if (plan.unmark && m.notesBefore) restoreNotes(m.keep, m.notesBefore, m.notesAfter);
      // A swap also moved the live copy's own pointer: put it back, copying no notes.
      if (plan.unmark && m.repointed) pointAt(m.repointed.id, m.repointed.to, { onlyIfUnset: true, notes: false });
      // The rows that pointed at the hidden one, pointed back at it exactly (F-1034).
      if (plan.unmark && Array.isArray(m.incoming)) for (const d of [...m.incoming].reverse()) restorePointer(d.id, d.from, { expect: d.to });
    }
  }, () => ({ undid: target.runId, at: new Date().toISOString(), pointers, statuses }));
  log(`undid dedupe run ${target.runId}: ${pointers} pointer(s) cleared, ${statuses} carried status(es) put back${skipped ? `, ${skipped} left (changed since)` : ''}`);
}

async function run({ write, undo, undoAll, recheck, recheckDecisions = false, yes = false, limit, log = console.log }) {
  const handle = db();
  if (recheck) {
    const cols = 'id, url, source, company, title, location, last_seen AS lastSeen, status, gone_at AS goneAt';
    const stale = handle.prepare(`SELECT ${cols}, superseded_by FROM jobs WHERE superseded_by IS NOT NULL`).all().filter((s) => COPY_OR_SIMPLIFY.test(String(s.source || '')));
    const getKeep = handle.prepare(`SELECT ${cols} FROM jobs WHERE id = ?`);
    const pairs = stale.map((s) => ({ stale: s, keep: getKeep.get(s.superseded_by) })).filter((p) => p.keep);
    // The copy rule's own re-judgement (browser-assist and Handshake), then
    // any copy whose titles no longer look like one posting (2026-11-04).
    const ruleFailing = failingCopyPointers(pairs.filter((p) => /^(browser-assist|handshake)/.test(String(p.stale.source || ''))));
    const seen = new Set(ruleFailing.map((f) => f.stale.id));
    const drifted = driftedCopyPointers(pairs).filter((f) => !seen.has(f.stale.id));
    if (drifted.length) log(`${drifted.length} copy link(s) whose rows name another employer or title now`);
    const failing = [...ruleFailing, ...drifted];
    log(`${pairs.filter(copyShaped).length} copy pointer(s) the copy rule could have set, judged again (${pairs.length - pairs.filter(copyShaped).length} set by other rules, left); ${failing.length} would not be set now`);
    for (const f of failing.slice(0, 20)) log(`  · ${f.stale.company} — ${f.stale.title}: ${f.stale.url} ≠ ${f.keep.url}`);
    if (!write || !failing.length) { if (failing.length) log('Re-run with --write to clear them.'); return; }
    await journalled(handle, () => { for (const f of failing) clearPointer(f.stale.id, { from: f.keep.id }); },
      { recheck: new Date().toISOString(), cleared: failing.map((f) => ({ stale: f.stale.id, keep: f.keep.id })) });
    log(`cleared ${failing.length} pointer(s)`);
    return;
  }
  if (recheckDecisions) {
    const tag = (r) => `${r.id} [${r.status || 'new'}${r.applied_at ? `, applied ${String(r.applied_at).slice(0, 10)}` : ''}${r.gone_at ? ', closed' : ''}]`;
    const report = (p) => {
      log(`${p.loops.length} loop(s) — rows pointing at each other, none of them on his board:`);
      for (const l of p.loops) log(`  ${l.members.map(tag).join(' ↔ ')} ${l.survivor.company} — ${l.survivor.title}\n      fix: ${l.survivor.id} shows; ${l.members.filter((m) => m.id !== l.survivor.id).map((m) => m.id).join(', ')} point at it`);
      log(`${p.chains.length} chain(s) — a row pointing at a row that is itself pointed:`);
      for (const c of p.chains.slice(0, 50)) log(`  ${tag(c.s)} → ${c.k.id} → … → ${tag(c.end)} ${c.s.company} — ${c.s.title}\n      fix: points straight at ${c.end.id}`);
      log(`${p.failing.length} pointer(s) hide a row holding more of his than the row that shows:`);
      for (const f of p.failing) log(`  ${tag(f.s)} → ${tag(f.k)} ${f.s.company} — ${f.s.title}\n      ${f.fix === 'swap' ? `fix: ${f.k.id} points at ${f.s.id} instead (the row with his decision shows)` : 'fix: the pointer is cleared, both show'}`);
      log(`${p.skipped.length} left as they are — his newer decision is on the row that shows:`);
      for (const x of p.skipped) log(`  ${tag(x.s)} → ${tag(x.k)} ${x.s.company} — ${x.s.title}: ${x.why}`);
    };
    const plan = recheckPlan(handle);
    report(plan);
    const todo = plan.loops.length + plan.chains.length + plan.failing.length;
    if (!write || !todo) { if (todo) log('Nothing was written. Re-run with --write to fix them.'); return; }
    await recheckWrite(handle, { log });
    return;
  }
  if (undoAll) {
    const n = await withStoreLock(() => clearAllPointers());
    log(`cleared ${n} pointer(s) — every row shows again (statuses carried onto kept rows stay; --undo <run> reverses those)`);
    return;
  }
  if (undo) {
    const runs = readJournal();
    // WHAT A BARE --undo REVERSES (code review #5): the last run that changed
    // something (a recheck that only failed to settle changed nothing, so it is
    // never "the last run"), and a --write together with the recheck that ended
    // it: undoing only the recheck left the merge in place.
    const changes = (r) => (r.merges || r.pointers || []).length + (r.notes || []).length;
    const target = undo === true ? runs.filter((r) => !r.undone && changes(r)).pop() : runs.find((r) => r.runId === undo);
    if (!target) { log(undo === true ? 'no dedupe run to undo' : `no dedupe run ${undo}`); return; }
    // Newest first: the recheck is put back before the --write it followed. A
    // run named by its id is undone alone, as the --write's own line says.
    const write = undo === true && target.follows && runs.find((r) => r.runId === target.follows && !r.undone);
    const group = write ? [target, write] : [target];
    // With no run named, say which one and wait for --yes (review, 2026-11-03).
    if (undo === true && !yes) {
      const total = group.reduce((s, r) => s + (r.merges || r.pointers || []).length, 0);
      log(write
        ? `the last dedupe run is the --write ${write.runId} with its recheck ${target.runId}: ${total} change(s). Re-run with --undo --yes to reverse both (--undo ${write.runId} reverses the merge alone).`
        : `the last dedupe run is ${target.runId}: ${total} change(s). Re-run with --undo --yes to reverse it, or --undo ${target.runId}.`);
      return;
    }
    for (const t of group) await undoRun(handle, t, log);
    return;
  }
  const sql = `SELECT id, url, source, company, title, location, last_seen AS lastSeen, status, applied_at, superseded_by
               FROM jobs WHERE gone_at IS NULL AND superseded_by IS NULL${limit ? ' LIMIT ?' : ''}`;
  const rows = limit ? handle.prepare(sql).all(limit) : handle.prepare(sql).all();
  const groups = duplicateGroups(rows);
  // Reposts: only titles where a closed card of his sits, so the pass reads a
  // few hundred rows, not the whole store.
  const repostRows = handle.prepare(`SELECT j.id, j.url, j.source, j.company, j.title, j.location, j.last_seen AS lastSeen, j.status, j.applied_at, j.gone_at AS goneAt
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
  const liRows = handle.prepare(`SELECT j.id, j.url, j.source, j.company, j.title, j.location, j.last_seen AS lastSeen, j.status, j.applied_at, j.gone_at AS goneAt, j.superseded_by
    FROM jobs j JOIN (SELECT DISTINCT lower(company) c, lower(title) t FROM jobs
      WHERE (source = 'linkedin' OR source LIKE 'browser-assist%' OR source LIKE 'handshake%') AND gone_at IS NULL AND superseded_by IS NULL) d
      ON lower(j.company) = d.c AND lower(j.title) = d.t
    WHERE j.superseded_by IS NULL`).all();
  for (const g of linkedinCopyGroups(liRows)) {
    const stale = g.stale.filter((r) => !taken.has(r.id));
    if (stale.length) { groups.push({ ...g, stale }); stale.forEach((r) => taken.add(r.id)); }
  }
  // A role he already handled, listed again (F-715): his lists and the deck
  // against every row he applied to, was rejected from or hid.
  const roleRows = handle.prepare(`SELECT id, url, source, company, title, location, last_seen AS lastSeen, status, applied_at
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
  // What the write would leave alone, said before anything is written.
  const plan = planMerges(groups);
  const wouldRefuse = plan.filter((p) => p.refuse)
    .map((p) => `${p.r.id} [${p.r.status || 'new'}] → ${p.g.keep.id} [${p.keepBefore}] ${p.g.keep.company} — ${p.g.keep.title}`);
  if (wouldRefuse.length) {
    log(`\n${wouldRefuse.length} would be left alone: the old spelling holds more of his than the survivor:`);
    for (const x of wouldRefuse.slice(0, 20)) log(`  ${x}`);
  }
  const swaps = closedSurvivors(handle);
  if (swaps.length) {
    log(`\n${swaps.length} survivor(s) closed while a copy is still live — his card moves to the live copy:`);
    for (const s of swaps.slice(0, 20)) log(`  ${s.keepId} [${s.keepStatus || 'new'}, closed] → ${s.liveId} [${s.liveStatus || 'new'}, live] ${s.company} — ${s.title}`);
  }
  const reopened = reopenedApplications(handle);
  if (reopened.length) {
    log(`\n${reopened.length} posting(s) he applied to closed and are open again under another address (his application stays on the old row):`);
    for (const x of reopened.slice(0, 20)) log(`  ${x.company} — ${x.title} [${x.status}]: open again at ${x.liveUrl}`);
  }
  if (!write) {
    const p = recheckPlan(handle);
    const todo = p.loops.length + p.chains.length + p.failing.length;
    if (todo) log(`\n${todo} pointer(s) the recheck would fix after the write (--recheck-decisions lists them).`);
    log('\nNothing was written. Re-run with --write to point the old spellings at the survivor.');
    return;
  }

  let pointed = 0; let carried = 0; let swapped = 0;
  const runId = new Date().toISOString();
  const merges = [];
  const refused = [];
  await journalled(handle, () => {
    const prior = handle.prepare('SELECT status, status_changed_at FROM jobs WHERE id = ?');
    for (const { g, r, carry, refuse, keepBefore } of plan) {
      // HIS DECISION FOLLOWS THE POSTING. If he hearted, queued, applied to
      // or hid the old spelling and the survivor is still untouched, the
      // survivor inherits it — otherwise the merge would lose the one thing
      // in the row that was his.
      // A repost is another requisition: nothing is carried onto it.
      // A LinkedIn copy whose board twin is gone carries nothing: the posting is closed.
      // Decided before anything is written, so no carry is ever left without its pointer.
      if (refuse) { refused.push(`${r.id} [${r.status || 'new'}] → ${g.keep.id} [${keepBefore}] ${g.keep.company} — ${g.keep.title}`); continue; }
      const merge = { stale: r.id, keep: g.keep.id, carried: null, keepPrior: null };
      if (carry) {
        const p0 = prior.get(g.keep.id) || {};
        merge.keepPrior = { status: p0.status ?? null, statusChangedAt: p0.status_changed_at ?? null };
        merge.carried = r.status;
        setStatus(g.keep.id, r.status);   // the store's writer: status_changed_at is now, as before
        g.keep.status = r.status;
        carried += 1;
      }
      // The store's own guard is the last word (F-1026); his notes move with the
      // pointer, and are journalled so an undo puts the survivor's back (review).
      const notesBefore = notesOf(g.keep.id);
      if (!pointAt(r.id, g.keep.id, { repost: !!g.repost })) {
        if (merge.carried) {
          restoreStatus(g.keep.id, merge.keepPrior.status, merge.keepPrior.statusChangedAt);
          g.keep.status = merge.keepPrior.status;   // what the next old spelling of this posting meets
        }
        refused.push(`${r.id} [${r.status || 'new'}] → ${g.keep.id} [${keepBefore}] (refused by the store)`);
        continue;
      }
      const notesAfter = notesOf(g.keep.id);
      if (JSON.stringify(notesBefore) !== JSON.stringify(notesAfter)) Object.assign(merge, { notesBefore, notesAfter });
      const incoming = moveIncoming(handle, r.id, g.keep.id);
      if (incoming.length) merge.incoming = incoming;
      merges.push(merge);
      pointed += 1;
    }
    // The closed survivors, swapped with their live copy (journalled like any merge,
    // `repointed` recording the pointer the undo puts back).
    const row = handle.prepare('SELECT id, status, status_changed_at, pick_note, user_note, superseded_by, gone_at FROM jobs WHERE id = ?');
    for (const s of swaps) {
      const keep = row.get(s.keepId); const live = row.get(s.liveId);
      if (!keep || !live || live.superseded_by !== keep.id || live.gone_at || !keep.gone_at || keep.superseded_by) continue;
      clearPointer(live.id, { from: keep.id });
      const merge = { stale: keep.id, keep: live.id, carried: null, keepPrior: null, repointed: { id: live.id, to: keep.id } };
      const notesBefore = notesOf(live.id);
      if (keep.status && keep.status !== 'new' && keep.status !== live.status) {
        merge.keepPrior = { status: live.status ?? null, statusChangedAt: live.status_changed_at ?? null };
        merge.carried = keep.status;
        carryDecision(live.id, { status: keep.status, changedAt: keep.status_changed_at, note: keep.pick_note, userNote: keep.user_note });
        carried += 1;
      }
      if (!pointAt(keep.id, live.id)) {
        if (merge.carried) restoreStatus(live.id, merge.keepPrior.status, merge.keepPrior.statusChangedAt);
        restoreNotes(live.id, notesBefore, notesOf(live.id));
        pointAt(live.id, keep.id, { notes: false });
        refused.push(`${keep.id} → ${live.id}: the swap was refused by the store; left as it was`);
        continue;
      }
      const notesAfter = notesOf(live.id);
      if (JSON.stringify(notesBefore) !== JSON.stringify(notesAfter)) Object.assign(merge, { notesBefore, notesAfter });
      const incoming = moveIncoming(handle, keep.id, live.id);
      if (incoming.length) merge.incoming = incoming;
      merges.push(merge);
      swapped += 1;
    }
    // The Overview names every reopened posting he applied to (replaced each run).
    setReopenedApplications(reopened);
  }, () => (merges.length ? { runId, at: runId, merges } : null));
  log(`\npointed ${pointed} old spelling(s) at the row still being listed; ${carried} decision(s) carried over${swapped ? `; ${swapped} closed survivor(s) swapped with their live copy` : ''}`);
  if (refused.length) {
    log(`left ${refused.length} alone: the old spelling holds more of his than the row that would survive (an application is never hidden behind it):`);
    for (const x of refused.slice(0, 20)) log(`  ${x}`);
  }
  log(`Nothing was retired and nothing was deleted — \`--undo ${runId}\` reverses exactly this run.`);
  // EVERY WRITE ENDS WITH THE RECHECK (F-1028, 2026-11-06). A scan clears the
  // pointer of every address it lists again (F-406); the pass above then judges
  // only those rows. Pointers into a row it just un-pointed, chains, and a
  // record left behind its copy are fixed here, journalled as their own run.
  await recheckWrite(handle, { log, quietWhenClean: true, follows: merges.length ? runId : null });
}

const argv = process.argv.slice(2);
const at = argv.indexOf('--limit');
if (RUNNING) {
  await run({
    write: argv.includes('--write'),
    // --undo alone is the last run; --undo <run id> names one.
    undo: argv.includes('--undo') ? (argv[argv.indexOf('--undo') + 1] && !argv[argv.indexOf('--undo') + 1].startsWith('--') ? argv[argv.indexOf('--undo') + 1] : true) : false,
    undoAll: argv.includes('--undo-all'),
    recheck: argv.includes('--recheck-copies'),
    recheckDecisions: argv.includes('--recheck-decisions'),
    yes: argv.includes('--yes'),
    limit: at !== -1 ? Number(argv[at + 1]) : 0,
  });
}
