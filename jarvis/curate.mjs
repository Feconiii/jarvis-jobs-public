#!/usr/bin/env node
// jarvis/curate.mjs — keep his shortlist from running dry.
//
// WHY THIS EXISTS. 2026-09-24: "find me 50 jobs i ran out of jobs to apply
// for?????????" and then "bro i thought we supposed to do a run everyday how
// did i run out of jobs??????????". The scanner DID run every day — 4,700 new
// postings on the 23rd, 11,600 on the 22nd — but reading them into his inbox
// was a step only a person ever took (/jarvis-jobs), and nobody had since
// 2026-09-20. The store kept growing while the list he works from emptied.
//
// This is that step, unattended, with the same rules the hand curation used:
//
//   1. SCREEN   picks.mjs — visa, senior, internship, grad window, degree,
//               overseas and per-company cap, all mechanical.
//   2. READ     every survivor's WHOLE description goes to the model with his
//               short CV and the two bars (qualified as written; relevant work).
//               His rule, 2026-09-02: nothing goes in on title or score.
//   3. FILE     KEEP → his inbox with the reason; MAYBE → his inbox, the note
//               starting "Worth a look:" and naming the catch; DROP → marked
//               "Not curated — <why>", which the screen never serves again.
//
// It tops the list up; it does not flood it. Nothing runs while he already has
// TARGET open picks, and one run reads at most --limit postings.
//
// Usage: node jarvis/curate.mjs [--limit 30] [--target 50] [--days 45] [--dry-run] [--force]
//   --days widens the posting window; graduate programs posted in August are
//   still open in October (2026-10-03: 75 unread survivors were 45-120 days old).

import fs from 'node:fs';
import path from 'node:path';
import { openDb, readDescription } from './db.mjs';
import { loadCandidates, rank, approve } from './picks.mjs';
import { run } from './tailor-llm.mjs';
import { routeFor, linkedInJobId, EASY_APPLY_NOTE } from './linkedin-route.mjs';
import { prescreen } from './prescreen.mjs';
import { htmlToText } from './text.mjs';
import { person, screen } from './targeting.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const DB_PATH = path.join(ROOT, 'data', 'jarvis', 'jobs.db');
const LOG_PATH = path.join(ROOT, 'data', 'jarvis', 'curate-log.jsonl');

/**
 * Titles that fail his standing rules on their face; not worth a model call.
 * NOT "II" or "2": he has applied to six "Engineer II" roles (AMAT, Lam, Amazon)
 * and a level number is not a years requirement — the reader decides those.
 * The title rules, the AMAT grade, the frontier list and the cap are the
 * preset's, moved there so a second user can run Jarvis.
 */
export const TITLE_OUT = screen.titleOut;

/**
 * Applied Materials pay grades (2026-10-03: "stop fuckin shwoing me e2 e3 level
 * roles for amat"). E3 and up is out by TITLE_OUT for everyone; E2 is out too
 * unless the title is a graduate or rotation program — "2027 Engineer
 * Development Rotation Program … (E2)" is his best-fitting AMAT posting.
 */
export const E2_OUT = screen.e2Out || null;
const PROGRAM = /\b(program|rotation|graduate|new college|ncg|early career)\b/i;
export function titleOut(title) {
  const t = String(title || '');
  return TITLE_OUT.test(t) || (!!E2_OUT && E2_OUT.test(t) && !PROGRAM.test(t));
}

/**
 * How many postings he already has open to work from.
 *
 * A row at a company he hid does not count: the view never shows it. On
 * 2026-10-03, 60 of the 104 rows this counted were at hidden companies
 * (Alstom, ANDRITZ, Honda, Vermeer…), so the curator saw 104 ≥ 50 and stood
 * down while his visible list was 44 — "shi running out so quick".
 */
export function openPicks(db) {
  let hidden = [];
  try {
    const row = db.prepare("SELECT v FROM meta WHERE k = 'hiddenCompanies'").get();
    const v = row ? JSON.parse(row.v) : [];
    if (Array.isArray(v)) hidden = v.map((c) => String(c).toLowerCase().trim());
  } catch { /* no hidden list yet */ }
  const hide = new Set(hidden);
  // Nor does a second copy of a posting (F-728): the view shows the row it
  // points at, so 36 LinkedIn copies were counted twice on 2026-10-14.
  return db.prepare(`SELECT company FROM jobs WHERE status IN ('inbox','interested')
    AND applied_at IS NULL AND gone_at IS NULL AND superseded_by IS NULL`).all()
    .filter((r) => !hide.has(String(r.company || '').toLowerCase().trim())).length;
}

/**
 * Employers he has already turned down as employers: any posting he hid with
 * "Company not interesting" (2026-09-24: Virtual Incision, Seek Thermal and
 * HaloBraid, all from the hand-curated list that night). One such hide speaks
 * for the company; it is not asked again.
 */
export function notInterestingCompanies(file = path.join(ROOT, 'data', 'jarvis', 'skip-reasons.jsonl'),
  clearedFile = path.join(ROOT, 'data', 'jarvis', 'cold-cleared.json')) {
  const out = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if ((e.reasons || []).some((r) => /company not interesting/i.test(String(r))) && e.company) out.add(String(e.company).toLowerCase().trim());
    }
  } catch { /* no reasons recorded yet */ }
  // EMPLOYERS HE TOOK BACK OFF THE LIST (2026-10-08: "undo all those guys,
  // unless its extremely narrow line of product or a bit laughable"). The
  // skip reasons stay as he wrote them; this file only says which no longer count.
  try {
    for (const c of JSON.parse(fs.readFileSync(clearedFile, 'utf8')).cleared || []) out.delete(String(c).toLowerCase().trim());
  } catch { /* nothing cleared */ }
  return out;
}

/**
 * THE EMPLOYERS HE GOES FOR (2026-09-24). "the jobs im seeing jsut doesnt hit" —
 * the hand-curated list leaned on medical devices and small industrial firms,
 * because the ranker rewards new-grad WORDING and frontier employers rarely use
 * it. His own record says what hits: Tesla, Applied Materials, Micron, Amazon,
 * KLA, Lam, ASML, NVIDIA, OpenAI, TSMC, 1X, Machina, Sunday, Neuralink… So an
 * employer he has applied to or hearted before is read first, then the
 * frontier list, then everyone else.
 *
 * NOTHING IS EXCLUDED FOR TASTE. "im still open to medical device but ye the
 * allure is not there, i love flashy stuff but eventually i will be humble
 * enough to apply so dont exclude anything." A company he called "not
 * interesting" is read LAST, not skipped.
 */
const FRONTIER = screen.frontier;

export function hisEmployers(dbPath = DB_PATH) {
  try {
    const db = openDb(dbPath);
    const rows = db.prepare(`SELECT DISTINCT lower(company) AS c FROM jobs WHERE applied_at IS NOT NULL
      OR status IN ('applied','interested','responded','interview','offer')`).all();
    db.close?.();
    return new Set(rows.map((r) => String(r.c || '').trim()).filter(Boolean));
  } catch { return new Set(); }
}

export function tierOf(company, { liked = new Set(), cold = new Set() } = {}) {
  const c = String(company || '').toLowerCase().trim();
  if (cold.has(c)) return 3;
  if (liked.has(c)) return 0;
  if (FRONTIER && FRONTIER.test(c)) return 1;
  return 2;
}

/**
 * Employers he has capped. Tesla, 2026-10-01: 23 applications sent, his five
 * best fits kept, and no new Tesla role is filed without asking him first. The
 * curator files unattended, so it does not read them at all.
 */
export const CAPPED = screen.capped || null;

/** The screen's survivors, his kind of employer first, that nobody has read yet. */
export function unread(dbPath = DB_PATH, { limit = 30, days = 45, cold = notInterestingCompanies(), liked = hisEmployers(dbPath) } = {}) {
  const rows = loadCandidates(dbPath, { minFit: 70, days });
  const r = rank(rows, { limit: 5000, perCompany: 4 });
  // THE "CHECK" BUCKET IS READ TOO, AFTER THE CLEAN SURVIVORS (2026-10-03).
  // rank() sets aside a posting whose degree line it cannot settle — no degree
  // stated, Master's and Bachelor's both named, other majors "or related" —
  // with the instruction "read it". The curator only took `picks`, so nobody
  // ever did: 467 unread postings, among them Qcells' cell process engineer,
  // DSI's Mechanical Design Engineer I and STMicro's MEMS role. The reader
  // judges the degree from the whole body, which is what "check" asks for.
  const fresh = (j) => j.where !== 'elsewhere' && !titleOut(j.title) && !(CAPPED && CAPPED.test(String(j.company || '')));
  return [...r.picks.filter(fresh).map((j) => ({ j, b: 0 })), ...(r.needsCheck || []).filter(fresh).map((j) => ({ j, b: 1 }))]
    .map(({ j, b }, i) => ({ j, b, i, t: tierOf(j.company, { liked, cold }) }))
    .sort((a, b) => a.b - b.b || a.t - b.t || a.i - b.i)
    .map((x) => x.j)
    .slice(0, limit);
}

/** His facts, from the one-page CV he wrote himself (comments stripped). */
export function facts(root = ROOT) {
  const raw = fs.readFileSync(path.join(root, 'cv-short.md'), 'utf8');
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * What he has already done at this employer. A title he has applied to or
 * hidden there is not news — 1X's "Mechanical Engineer" was reposted under a
 * second company name and nearly went back in his list (2026-09-24).
 */
export function priorAt(db, job) {
  try {
    const out = db.prepare(`SELECT title, status FROM jobs WHERE lower(company) = lower(?) AND id <> ?
      AND (applied_at IS NOT NULL OR status IN ('applied','inbox','interested','rejected','hidden'))
      ORDER BY status_changed_at DESC LIMIT 25`).all(String(job.company || ''), String(job.id || ''))
      .map((r) => `${r.title} [${r.status}]`);
    // THE SAME REQUISITION UNDER ANOTHER LEGAL NAME (2026-10-03). "6267-Auris
    // Health Inc. Legal Entity" is J&J's R-098612 and "Honda Dev. and Mfg. of
    // Am." is American Honda's 12394 — both already on his list, both filed
    // again because the company names differ. Same title + a shared
    // requisition number in the URL is the same posting.
    const reqs = reqNumbers(job.url);
    if (reqs.length) {
      const same = db.prepare(`SELECT company, title, status, url FROM jobs WHERE lower(title) = lower(?) AND id <> ?
        AND lower(company) <> lower(?)
        AND (applied_at IS NOT NULL OR status IN ('applied','inbox','interested','rejected','hidden'))`)
        .all(String(job.title || ''), String(job.id || ''), String(job.company || ''));
      for (const r of same) {
        if (reqNumbers(r.url).some((n) => reqs.includes(n))) out.unshift(`${r.title} [${r.status}] — same requisition, listed as ${r.company}`);
      }
    }
    return out;
  } catch { return []; }
}

/**
 * Requisition-looking numbers in a posting URL: a path or query piece that IS
 * a number, or the number a slug ends on ("…-4470601942", "…_R-098612-1").
 * Not a year.
 *
 * NOT ANY RUN OF DIGITS (F-738). "1001" sits inside UKG's tenant code
 * (ROL1001RBCAI, ARR1001ARFAC) and Oracle's site (CX_1001), and UUIDs carry
 * digit runs too — so Dodge Industrial's and Arrow Fastener's Manufacturing
 * Engineer were turned down as "the same requisition, listed as Legrand".
 */
export function reqNumbers(url) {
  let rest = String(url || '');
  try { const u = new URL(rest); rest = `${u.pathname}${u.search}`; } catch { /* not a URL — read it whole */ }
  const out = [];
  for (const tok of rest.split(/[/?&=#]+/)) {
    if (!tok || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tok)) continue;   // a UUID
    if (/^[A-Za-z]{1,4}_\d+$/.test(tok)) continue;                                                       // a site code: CX_1001
    const m = tok.match(/^(\d{4,})$/) || tok.match(/[-_.][A-Za-z]{0,3}-?(\d{4,})(?:-\d{1,2})?$/);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)].filter((n) => !/^(19|20)\d\d$/.test(n));
}

/**
 * The reader's whole brief for one posting. It is the preset's (curatePrompt),
 * moved there so a second user can run Jarvis; for the default person it is the
 * brief he shaped, unchanged.
 */
export function promptFor(job, description, cvShort, prior = []) {
  return screen.curatePrompt(person, job, description, cvShort, prior);
}

/** The model's line, read strictly: anything malformed is a skip, never a pick. */
export function parseVerdict(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let v;
  try { v = JSON.parse(m[0]); } catch { return null; }
  const verdict = String(v.verdict || '').toUpperCase();
  if (!['KEEP', 'MAYBE', 'DROP'].includes(verdict)) return null;
  const why = String(v.why || '').trim().slice(0, 300);
  const note = String(v.note || '').trim().slice(0, 900);
  if (verdict !== 'DROP' && !note) return null;   // a pick with no reason is not a pick
  return { verdict, why, note };
}

async function askModel(prompt) {
  // Haiku reads (his call, 2026-10-08: "reduce the readers to haiku"). Every
  // pick is still checked by hand before it is reported, and never Opus
  // (his rule for writers, 2026-09-16).
  const out = await run('claude', ['-p'], { input: prompt, timeout: 180_000, models: ['haiku'] });
  return out.stdout;
}

/**
 * One run. `ask` and `file` are injectable so the tests never call a model or
 * write the store.
 */
export async function curate({ dbPath = DB_PATH, limit = 30, target = 50, force = false, dryRun = false,
  ask = askModel, file = approve, log = (e) => fs.appendFileSync(LOG_PATH, `${JSON.stringify(e)}\n`), root = ROOT,
  candidates = null, readDesc = readDescription, route = routeFor, days = 45, screen = prescreen, lockWaitMs = 10 * 60_000 } = {}) {
  const db = openDb(dbPath);
  const open = openPicks(db);
  if (!force && open >= target) { db.close?.(); return { skipped: true, open, target, kept: [], maybe: [], dropped: [], failed: [] }; }
  const want = force ? limit : Math.min(limit, Math.max(10, (target - open) * 3));
  const cands = candidates || unread(dbPath, { limit: want, days });
  const cv = facts(root);
  const kept = [], maybe = [], dropped = [], failed = [];
  // EACH VERDICT IS FILED THE MOMENT IT IS MADE (2026-10-03). Filing used to
  // wait for the end of the run, so a run stopped part-way — the machine runs
  // out of memory and background jobs get reaped — threw away every verdict it
  // had paid for. The log kept them; the store did not.
  //
  // A SCAN HOLDING THE WRITE LOCK DOES NOT END THE RUN (F-730, 2026-10-14). A
  // scan can hold it longer than the store's 30 s busy wait, and one locked
  // write threw out of the loop: 19 of 40 read, the rest never asked. A verdict
  // that cannot be written waits in `unfiled` while reading goes on (reading
  // needs no write lock), is tried again after every later verdict, and at the
  // end for up to `lockWaitMs` more. Anything still unwritten is reported.
  const unfiled = [];
  const fileOne = (row) => {
    if (row.verdict === 'DROP') {
      // Read and turned down: the reason stays on the row and the screen skips it.
      file([row.id], { [row.id]: `read by the daily curation — ${row.why}` }, { dbPath, undo: true });
    } else {
      const note = row.verdict === 'MAYBE' && !/^worth a look/i.test(row.note) ? `Worth a look: ${row.note}` : row.note;
      file([row.id], { [row.id]: note }, { dbPath });
    }
  };
  const flush = () => {
    while (unfiled.length) {
      try { fileOne(unfiled[0]); unfiled.shift(); }
      catch (e) { if (/lock|busy/i.test(String(e?.message || ''))) return false; throw e; }
    }
    return true;
  };
  const record = (row) => {
    (row.verdict === 'KEEP' ? kept : row.verdict === 'MAYBE' ? maybe : dropped).push(row);
    log({ at: new Date().toISOString(), ...row });
    if (dryRun) return;
    unfiled.push(row);
    flush();
  };
  try {
    for (const j of cands) {
      let desc = '';
      try { desc = readDesc(db, j.id) || ''; } catch { desc = ''; }
      if (desc.length < 400) { failed.push({ id: j.id, why: 'no description to read' }); continue; }
      // A LinkedIn posting is asked how it takes an application before anything
      // is read: Easy Apply only means no tailored resume, and he does not apply
      // that way (2026-10-02). Unknown is not Easy Apply; it is read as usual.
      if (linkedInJobId(j.url)) {
        let how = null;
        try { how = await route(j.url); } catch { how = null; }
        if (how) { try { db.prepare('UPDATE jobs SET apply_route = ? WHERE id = ?').run(how, j.id); } catch { /* a record */ } }
        if (how === 'easy-apply') {
          const row = { id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: EASY_APPLY_NOTE, note: '' };
          record(row);
          continue;
        }
        // A dead pick "got me excited for nothing" (2026-09-27): closed is not filed.
        if (how === 'closed') {
          const row = { id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: 'LinkedIn says no longer accepting applications', note: '' };
          record(row);
          continue;
        }
      }
      // What a script can see on the page is turned down without a model
      // (prescreen.mjs, 2026-10-08): a required 2+ years with no way in for a
      // new graduate, or a title in another discipline. Anything unsure is read.
      const pre = screen({ title: j.title, text: htmlToText(desc) });
      if (pre) { record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: pre.why, note: '' }); continue; }
      let v = null;
      try { v = parseVerdict(await ask(promptFor(j, desc, cv, priorAt(db, j)))); } catch (e) {
        if (/out of credit/i.test(String(e?.message))) { failed.push({ id: j.id, why: 'model out of credit — run stopped' }); break; }
        failed.push({ id: j.id, why: String(e?.message || e).slice(0, 120) });
        continue;
      }
      if (!v) { failed.push({ id: j.id, why: 'unreadable verdict' }); continue; }
      record({ id: j.id, company: j.company, title: j.title, ...v });
    }
    const until = Date.now() + lockWaitMs;
    while (!flush() && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(15_000, lockWaitMs)));
  } finally { db.close?.(); }
  return { skipped: false, open, target, read: cands.length, kept, maybe, dropped, failed, unfiled: unfiled.map((r) => r.id) };
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const r = await curate({
    limit: Number(arg('limit', 30)), target: Number(arg('target', 50)), days: Number(arg('days', 45)),
    force: process.argv.includes('--force'), dryRun: process.argv.includes('--dry-run'),
  });
  if (r.skipped) console.log(`${r.open} open picks already (target ${r.target}) — nothing to do. --force reads anyway.`);
  else {
    console.log(`read ${r.read}: ${r.kept.length} kept, ${r.maybe.length} worth a look, ${r.dropped.length} turned down${r.failed.length ? `, ${r.failed.length} not read` : ''}`);
    for (const x of [...r.kept, ...r.maybe]) console.log(`  ${x.verdict.padEnd(5)} ${x.company} — ${x.title}`);
    for (const x of r.failed) console.log(`  not read ${x.id}: ${x.why}`);
    if (r.unfiled.length) {
      console.log(`  ${r.unfiled.length} verdict(s) NOT written — the store stayed locked (a scan?). They are in curate-log.jsonl: ${r.unfiled.join(', ')}`);
      process.exitCode = 2;
    }
  }
}
