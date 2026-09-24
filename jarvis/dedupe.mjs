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
    const key = [norm(r.company), token, norm(r.title), norm(r.location), pathShape(r.url, token, r.title)].join('##');
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
  const extra = groups.reduce((n, g) => n + g.stale.length, 0);
  const byCompany = new Map();
  for (const g of groups) byCompany.set(g.keep.company, (byCompany.get(g.keep.company) || 0) + g.stale.length);

  log(`${rows.length} live rows · ${groups.length} postings carrying more than one spelling · ${extra} extra row(s)`);
  [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([c, n]) => log(`  ${String(n).padStart(4)}  ${c}`));
  for (const g of groups.slice(0, 3)) {
    log(`\n  ${g.keep.company} — ${g.keep.title} (${g.keep.location})`);
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
        if (DECIDED.has(r.status) && (g.keep.status === 'new' || !g.keep.status)) {
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
