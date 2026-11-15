#!/usr/bin/env node
// jarvis/resolve-copies.mjs — a pick that exists only as a LinkedIn copy, found
// on the employer's own board so the apply engine can drive it (F-1006).
//
// On 2026-11-04, 8 of the 68 picks in his inbox were LinkedIn rows. The apply
// link of a LinkedIn row is behind a login wall, so the apply queue skips every
// one ("linkedin: not fillable without a sign-in or account") and the pick
// holds an inbox slot nobody can use.
//
// For each such pick this looks for the same posting among the employer's own
// board rows already in the store (the scanner's rows, as fresh as the last
// scan). A board row counts only when it passes the same-posting guard that
// every copy link passes (dedupe.linkable → same-posting.mjs, F-980: the same
// employer and the same title, or one requisition id) AND names the same town
// (or either side names none). Then:
//
//   found        exactly one live board row passes → with --write, the board
//                row takes his decision on the copy (carryDecision, the date
//                and note too) and the copy points at it (pointAt), so his
//                inbox shows the board row and the apply queue can fill it.
//                Journalled in dedupe's run journal: `node jarvis/dedupe.mjs
//                --undo <runId>` reverses it.
//   not found    with the reason: no board rows under the employer's name; the
//                board's closest titles and why the guard refused them; the
//                posting closed on the board; the title only in another town.
//   handled      the board row already carries a decision of his (applied,
//                hidden…): the pick is a second card for a role he dealt with
//                (VulcanForms, applied on Rippling). --write points the copy
//                at it and changes no status, as dedupe does for a role he
//                already handled (F-715).
//   ambiguous    two or more live board rows pass: nothing is linked.
//
// The town: the same town, or either side names none. One exception: the
// employer's ONLY live row passing the guard, in the same named state, is the
// posting (LinkedIn's Ayer, MA is VulcanForms' Devens, MA).
//
// An employer with no board rows in the store is looked for with the resolver
// only under --resolve (discover-ats's probes, read-only). A posting found that
// way is reported and never written: tracking a board goes through the ledger
// and the scanner, and the next run here links the row they make.
//
// A similar title in the same town under ANOTHER employer's name (a division
// on its parent's board: Peterbilt on PACCAR's) is shown as a hint, never
// linked: the guard asks for the same employer.
//
//   node jarvis/resolve-copies.mjs [--ids a,b] [--json]            report (the default)
//   node jarvis/resolve-copies.mjs --dry-run                         the same report
//   node jarvis/resolve-copies.mjs --write [--ids a,b]               link what was found
//   node jarvis/resolve-copies.mjs --resolve                         also ask the resolver for untracked employers
import { appendFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sameEmployer, employerKey, similarTitle, coreTitle } from './same-posting.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPY_SOURCES = /^(linkedin|browser-assist|handshake|simplify)/;

/** A row whose only link is a LinkedIn page. */
export const isLinkedInCopy = (r) => String(r?.source || '') === 'linkedin' || /(^|\.)linkedin\.com\//i.test(String(r?.url || '').replace(/^https?:\/\//, ''));

// ── place ───────────────────────────────────────────────────────────

const STATES = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy' };
const VAGUE = /^(?:united states(?: of america)?|usa?|remote|hybrid|multiple(?: locations)?|various|anywhere|\d+ locations?|)$/;

/** The town a location names, lower case ("" when it names none). "US-TX-Denton" and "Denton, TX 76205" are both "denton". */
export function townOf(loc) {
  let s = String(loc || '').toLowerCase().trim();
  s = s.replace(/^(?:us|usa|united states)[\s,-]+[a-z]{2}[\s,-]+/, '');           // US-TX-Denton
  const first = s.split(/[,(|;·/]/)[0].replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (VAGUE.test(first) || STATES[first] || /\d+ locations/.test(s)) return '';
  return first;
}

/** The US state a location names, as its two-letter code ("" when none). */
export function stateOf(loc) {
  const s = String(loc || '').toLowerCase();
  const m = s.match(/^(?:us|usa|united states)[\s,-]+([a-z]{2})[\s,-]/);
  if (m && Object.values(STATES).includes(m[1])) return m[1];
  for (const part of s.split(/[,(|;·]/).slice(1).map((p) => p.replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/[^a-z ]+/g, ' ').trim())) {
    if (Object.values(STATES).includes(part)) return part;
    if (STATES[part]) return STATES[part];
  }
  return '';
}

/** Two locations that could be one posting's: the same town, or either names none. */
export function placeAgrees(a, b) {
  const x = townOf(a), y = townOf(b);
  if (!x || !y) return true;
  return x === y || String(b || '').toLowerCase().includes(x) || String(a || '').toLowerCase().includes(y);
}

// ── judging one pick ───────────────────────────────────────────────

const STOP = new Set(['and', 'of', 'for', 'the', 'a', 'an', 'in', 'at', 'to', 'with', 'on', 'i', 'ii', 'iii', 'iv', 'sr', 'senior', 'jr', 'junior', 'associate', 'staff', 'lead', 'principal', 'new', 'grad', 'engineer', 'engineering', 'position', '2026', '2027']);
const words = (t) => [...new Set(String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w)))];
const overlap = (a, b) => { const B = new Set(words(b)); return words(a).filter((w) => B.has(w)).length; };

/** Why the guard refused a near title, in words. */
function refusal(copyTitle, rowTitle) {
  const lv = (t) => String(t || '').toLowerCase().match(/\b(senior|sr|staff|principal|lead|associate|junior|jr|i{1,3}|iv)\b/g)?.join(' ') || 'none';
  if (lv(copyTitle) !== lv(rowTitle)) return `level differs (${lv(copyTitle)} / ${lv(rowTitle)})`;
  return `core title differs ("${coreTitle(copyTitle)}" / "${coreTitle(rowTitle)}")`;
}

/** His decisions a board row may already carry; only 'new' takes the copy's. */
const OPEN_FOR_CARRY = new Set(['new', '', 'null', 'undefined']);
const SAME_LANE = new Set(['inbox', 'queued', 'interested']);

/**
 * The board row that is this pick's posting. Untouched ('new'): found, and a
 * write gives it his decision on the copy. Already in his inbox/queue: found,
 * a write only points the copy. Already handled (applied, hidden, rejected…):
 * 'handled' — the pick is a second card for a role he dealt with, and a write
 * points the copy at it (taking it out of his inbox) and changes no status.
 */
function onBoard(b, note) {
  const st = String(b.status ?? '');
  const where = `${b.source}: "${b.title}" (${b.location || 'no location'})${note}`;
  if (OPEN_FOR_CARRY.has(st)) return { verdict: 'found', reason: note ? 'found-nearby' : 'found', board: b, why: where };
  if (SAME_LANE.has(st)) return { verdict: 'found', reason: 'found-already-listed', board: b, why: `${where}, already in his ${st} list` };
  return { verdict: 'handled', reason: 'handled', board: b, why: `${where}; the board row is already "${st}"${b.status_changed_at ? ` since ${String(b.status_changed_at).slice(0, 10)}` : ''}: this pick is a second card for it (a write points the copy there and changes no status)` };
}

/**
 * One pick against its employer's board rows. `linkable(copy, row)` is the
 * same-posting guard (dedupe.linkable); passed in so tests can see it used.
 * @returns {{ verdict: 'found'|'handled'|'not-found'|'ambiguous', why: string, board?: object, candidates?: object[] }}
 */
export function judge(copy, rows, { linkable }) {
  if (typeof linkable !== 'function') throw new Error('judge needs the same-posting guard');
  const own = rows.filter((r) => r.id !== copy.id && !COPY_SOURCES.test(String(r.source || '')) && !isLinkedInCopy(r) && sameEmployer(copy.company, r.company));
  if (!own.length) return { verdict: 'not-found', reason: 'untracked', why: `no board rows under "${copy.company}" in the store: the employer is not tracked, or is tracked under another name` };
  const live = own.filter((r) => !r.gone_at);
  const boards = [...new Set(live.map((r) => r.source))].join(', ') || 'none live';
  const guarded = own.filter((r) => linkable(copy, r));
  const here = guarded.filter((r) => placeAgrees(copy.location, r.location));
  const hereLive = here.filter((r) => !r.gone_at);
  if (hereLive.length === 1) return onBoard(hereLive[0], '');
  if (hereLive.length > 1) return { verdict: 'ambiguous', reason: 'ambiguous', candidates: hereLive, why: `${hereLive.length} live board rows pass the guard in this town: ${hereLive.map((r) => `"${r.title}" ${r.url}`).join('; ')}` };
  if (here.length) {
    const g = here.sort((a, b) => String(b.gone_at).localeCompare(String(a.gone_at)))[0];
    return { verdict: 'not-found', reason: 'closed', board: g, why: `the employer's posting is closed: "${g.title}" left the board ${String(g.gone_at).slice(0, 10)} (${g.url})` };
  }
  const elsewhere = guarded.filter((r) => !r.gone_at);
  // A NEIGHBOURING TOWN (VulcanForms, 2026-11-05: LinkedIn says Ayer, MA, the
  // board Devens, MA). The employer's only live row with this title, in the
  // same named state, is the posting; two or more stay unlinked.
  const st = stateOf(copy.location);
  if (elsewhere.length === 1 && st && stateOf(elsewhere[0].location) === st) {
    return onBoard(elsewhere[0], ` — the board names another town in ${st.toUpperCase()} than LinkedIn's ${copy.location}; the employer's only live row with this title`);
  }
  if (elsewhere.length) return { verdict: 'not-found', reason: 'other-town', candidates: elsewhere, why: `the same title is on the board only in ${[...new Set(elsewhere.map((r) => r.location || '?'))].join(' / ')}, not ${copy.location}` };
  const near = live.map((r) => ({ r, n: overlap(copy.title, r.title) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  return {
    verdict: 'not-found', reason: 'no-match', candidates: near.map((x) => x.r),
    why: `${live.length} live row(s) on ${boards}; none passes the same-posting guard${near.length ? `. Closest: ${near.map((x) => `"${x.r.title}" (${refusal(copy.title, x.r.title)})`).join('; ')}` : ''}`,
  };
}

/**
 * A similar title in the same named town under another employer's name — a
 * division on its parent's board. A hint for a person, never a link.
 */
export function otherEmployerHints(copy, rows) {
  if (!townOf(copy.location)) return [];
  return rows.filter((r) => !r.gone_at && !COPY_SOURCES.test(String(r.source || '')) && !isLinkedInCopy(r)
    && !sameEmployer(copy.company, r.company) && townOf(r.location) && placeAgrees(copy.location, r.location)
    && (similarTitle(copy.title, r.title) || overlap(copy.title, r.title) >= 2)).slice(0, 3);
}

/** A posting the resolver's board lists, against the copy: the guard with the copy's employer, and the town. */
export function judgeResolved(copy, jobs, { linkable }) {
  const pass = jobs.filter((j) => linkable(copy, { ...j, company: copy.company }) && placeAgrees(copy.location, j.location));
  if (pass.length === 1) return { verdict: 'found-untracked', reason: 'found-untracked', board: pass[0], why: `on an untracked board: "${pass[0].title}" ${pass[0].url} — not written; track the board through the ledger, then rerun` };
  if (pass.length > 1) return { verdict: 'ambiguous', reason: 'ambiguous', candidates: pass, why: `${pass.length} postings on the resolved board pass the guard` };
  const near = jobs.map((j) => ({ j, n: overlap(copy.title, j.title) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  return { verdict: 'not-found', reason: 'resolved-no-match', why: `the resolver found a board with ${jobs.length} posting(s); none passes the guard${near.length ? `. Closest: ${near.map((x) => `"${x.j.title}"`).join('; ')}` : ''}` };
}

// ── the store ───────────────────────────────────────────────────────

const PICK_COLS = 'id, url, source, company, title, location, status, status_changed_at, pick_note, gone_at, superseded_by';

/** His inbox and queued picks whose only link is LinkedIn's. */
export function copyPicks(handle, { ids = null } = {}) {
  const rows = handle.prepare(`SELECT ${PICK_COLS} FROM jobs WHERE status IN ('inbox','queued') AND gone_at IS NULL AND superseded_by IS NULL`).all();
  return rows.filter(isLinkedInCopy).filter((r) => !ids || ids.includes(r.id));
}

/** Rows that could be this employer's: a LIKE on the employer's first word, then the guard's own employer rule. */
export function employerRows(handle, company) {
  const first = String(company || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/)[0] || employerKey(company);
  if (!first) return [];
  return handle.prepare(`SELECT ${PICK_COLS} FROM jobs WHERE superseded_by IS NULL AND lower(company) LIKE ?`).all(`%${first}%`)
    .filter((r) => sameEmployer(company, r.company));
}

/** Rows anywhere whose title shares the copy's longest word, for the other-employer hint. */
function titleRows(handle, title) {
  const w = words(title).sort((a, b) => b.length - a.length)[0];
  if (!w || w.length < 5) return [];
  return handle.prepare(`SELECT ${PICK_COLS} FROM jobs WHERE superseded_by IS NULL AND gone_at IS NULL AND lower(title) LIKE ? LIMIT 3000`).all(`%${w}%`);
}

/**
 * Judge every LinkedIn-copy pick. `resolveBoard(company)` (optional) is asked
 * for an employer with no board rows and returns { board, jobs } or null.
 */
export async function resolveCopies({ handle, linkable, ids = null, resolveBoard = null, log = () => {} } = {}) {
  const out = [];
  for (const copy of copyPicks(handle, { ids })) {
    let res = judge(copy, employerRows(handle, copy.company), { linkable });
    if (res.reason === 'untracked' && resolveBoard) {
      let found = null, failed = '';
      try { found = await resolveBoard(copy.company); } catch (e) { failed = String(e?.message || e).slice(0, 80); }
      if (found?.jobs?.length) res = { ...judgeResolved(copy, found.jobs, { linkable }), resolvedBoard: found.board };
      else res = { ...res, why: `${res.why}; ${failed ? `the resolver failed: ${failed}` : found ? `the resolver found ${found.board} with no postings` : 'the resolver found no board'}` };
    }
    if (res.verdict === 'not-found') {
      const hints = otherEmployerHints(copy, titleRows(handle, copy.title));
      if (hints.length) res = { ...res, hints, why: `${res.why}. Hint, not linked (another employer's name, the guard asks for the same one): ${hints.map((h) => `${h.company} "${h.title}" (${h.location}) ${h.url}`).join('; ')}` };
    }
    out.push({ copy, ...res });
    log(res.verdict, copy, res);
  }
  return out;
}

/**
 * Link what was found: the board row takes his decision on the copy, the copy
 * points at the board row. Under the store lock, one transaction, journalled
 * in dedupe's run journal so `dedupe.mjs --undo <runId>` reverses it.
 * Every pair is judged again inside the lock; anything that changed is left.
 */
export async function writeLinks(results, { store, linkable, journal, now = () => new Date().toISOString() }) {
  const found = results.filter((r) => r.verdict === 'found' || r.verdict === 'handled');
  if (!found.length) return { runId: null, linked: [] };
  const runId = now();
  const linked = [];
  await store.withStoreLock(() => {
    const h = store.db();
    const get = h.prepare(`SELECT ${PICK_COLS} FROM jobs WHERE id = ?`);
    for (const r of found) {
      const copy = get.get(r.copy.id), board = get.get(r.board.id);
      if (!copy || !board || copy.superseded_by || copy.gone_at || board.gone_at || board.superseded_by) continue;
      if (!['inbox', 'queued'].includes(copy.status)) continue;
      // The same judgement again, on the rows as they are inside the lock.
      const again = judge(copy, employerRows(h, copy.company), { linkable });
      if (!['found', 'handled'].includes(again.verdict) || again.board.id !== board.id) continue;
      const merge = { stale: copy.id, keep: board.id, carried: null, keepPrior: null };
      // His decision first, then the pointer (F-1026): the store refuses to hide
      // a copy holding more of his than the board row, so an untouched board row
      // takes the decision before the copy points at it. A copy someone already
      // pointed elsewhere was skipped above, inside this lock.
      let notesBefore = null, notesAfter = null;
      if (OPEN_FOR_CARRY.has(String(board.status ?? ''))) {
        merge.keepPrior = { status: board.status ?? null, statusChangedAt: board.status_changed_at ?? null };
        merge.carried = copy.status;
        notesBefore = store.notesOf(board.id);
        store.carryDecision(board.id, { status: copy.status, changedAt: copy.status_changed_at, note: copy.pick_note, userNote: copy.user_note });
        notesAfter = store.notesOf(board.id);
      }
      if (!store.pointAt(copy.id, board.id, { onlyIfUnset: true })) {
        // Refused (a handled board row holding less of his): both stay, the
        // carry undone, its notes too (code review #4, as dedupe's swap does).
        if (merge.carried) {
          store.restoreStatus(board.id, merge.keepPrior.status, merge.keepPrior.statusChangedAt);
          store.restoreNotes(board.id, notesBefore, notesAfter);
        }
        continue;
      }
      linked.push(merge);
    }
    if (linked.length) appendFileSync(journal, `${JSON.stringify({ runId, at: runId, merges: linked, via: 'resolve-copies' })}\n`);
  });
  return { runId: linked.length ? runId : null, linked };
}

// ── the resolver, for --resolve ─────────────────────────────────────

async function realResolver() {
  const { resolveCompanyTracked } = await import('./discover-ats.mjs');
  const { makeHttpCtx } = await import('../providers/_http.mjs');
  const dir = path.join(HERE, '..', 'providers');
  const providers = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.startsWith('_'))) {
    try { const p = (await import(pathToFileURL(path.join(dir, f)).href)).default; if (p?.id && typeof p.fetch === 'function') providers.set(p.id, p); } catch { /* a provider that fails to load is not this tool's to fix */ }
  }
  const ctx = makeHttpCtx();
  return async (company) => {
    const { result } = await resolveCompanyTracked({ name: company, seeded: true });
    const entry = result?.entry;
    if (!entry) return null;
    const id = entry.provider || result.provider;
    const p = providers.get(id);
    if (!p) return { board: `${id} ${entry.careers_url}`, jobs: [] };
    const jobs = await p.fetch({ ...entry, provider: id }, ctx);
    return { board: `${id} ${entry.careers_url}`, jobs: (jobs || []).map((j) => ({ title: j.title, url: j.url, location: j.location })) };
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

const RUNNING = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUNNING) main().catch((e) => { console.error(e?.stack || e); process.exit(1); });

async function main() {
  const { guardArgs } = await import('./cli.mjs');
  guardArgs({
    usage: `  node jarvis/resolve-copies.mjs [--ids a,b] [--dry-run|--write] [--resolve] [--json]
  LinkedIn-copy picks in his inbox, found on the employer's own board through the
  same-posting guard. Reports by default; --write links what was found
  (undo: node jarvis/dedupe.mjs --undo <runId>). --resolve also asks the resolver
  about employers with no board rows (read-only; nothing it finds is written).`,
    flags: ['--ids', '--dry-run', '--write', '--resolve', '--json'],
    valued: ['--ids'],
  });
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  if (write && argv.includes('--dry-run')) throw new Error('--write and --dry-run together: pick one');
  const ids = argv.includes('--ids') ? String(argv[argv.indexOf('--ids') + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const json = argv.includes('--json');

  const store = await import('./store.mjs');
  const { linkable } = await import('./dedupe.mjs');
  if (!existsSync(store.dbPath())) throw new Error(`no store at ${store.dbPath()}`);
  // A report opens the store read-only; only --write takes the store's own handle.
  let handle;
  if (write) handle = store.db();
  else { const { DatabaseSync } = await import('node:sqlite'); handle = new DatabaseSync(store.dbPath(), { readOnly: true }); }
  const resolveBoard = argv.includes('--resolve') ? await realResolver() : null;
  const results = await resolveCopies({ handle, linkable, ids, resolveBoard });

  const brief = results.map((r) => ({ id: r.copy.id, company: r.copy.company, title: r.copy.title, location: r.copy.location, linkedin: r.copy.url,
    verdict: r.verdict, reason: r.reason, link: r.board?.url || null, boardId: r.board?.id || null, why: r.why }));
  let wrote = null;
  if (write) wrote = await writeLinks(results, { store, linkable, journal: path.join(store.STORE_DIR, 'dedupe-runs.jsonl') });
  if (json) { console.log(JSON.stringify({ results: brief, wrote }, null, 2)); return; }

  console.log(`${results.length} LinkedIn-copy pick(s) in his inbox${write ? '' : ' — report only, nothing written'}\n`);
  for (const b of brief) {
    console.log(`${b.verdict.toUpperCase().padEnd(10)} ${b.company} — ${b.title} (${b.location || '?'})  [${b.id}]`);
    if (b.link) console.log(`           ${b.link}`);
    console.log(`           ${b.why}\n`);
  }
  const n = (v) => brief.filter((b) => b.verdict === v).length;
  console.log(`found ${n('found')} · already handled ${n('handled')} · not found ${n('not-found')} · ambiguous ${n('ambiguous')}${n('found-untracked') ? ` · on an untracked board ${n('found-untracked')}` : ''}`);
  if (wrote) console.log(wrote.runId ? `linked ${wrote.linked.length}; undo: node jarvis/dedupe.mjs --undo ${wrote.runId}` : 'nothing linked');
  else if (n('found') + n('handled')) console.log('rerun with --write to link the found and already-handled ones');
}
