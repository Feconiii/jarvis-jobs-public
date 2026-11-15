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
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb, readDescription, THIN_BODY } from './db.mjs';
import { DETAIL_SOURCES } from './detail-sources.mjs';
import { loadCandidates, rank, approve, exportBar, isThinBody } from './picks.mjs';
import { classifyExperience } from './triage.mjs';
import { classifyLocation } from './geo.mjs';
import { run } from './tailor-llm.mjs';
import { routeFor, linkedInJobId, EASY_APPLY_NOTE } from './linkedin-route.mjs';
import { prescreen, gradProgram, yearsBar, stretchYears, stretchTitle } from './prescreen.mjs';

/** The label a stretch card's note opens with (his answer 2026-11-06); the dashboard sorts on it. */
export const STRETCH_LABEL = 'Stretch: asks 1-2 yrs.';
/** Roles he turned down whatever the years (one list, prescreen.mjs stretchTitle). */
const NOT_A_STRETCH_TITLE = { test: (t) => !stretchTitle(t) };
import { htmlToText } from './text.mjs';
import { person, screen } from './targeting.mjs';
import { normCo, sameFiler } from './employer-names.mjs';
import { dolPetitions } from './sponsor-prior.mjs';
import { samePath } from './same-file.mjs';
export { normCo, sameFiler };
import { TITLE_OUT, E2_OUT, titleOut, employerClass, CLASS_RANK, vcListed, fundedStartup, starEmployer, h1bPetitions, dolCount, employerVerdict, postingsAt, NOT_HIS_KIND, CAPPED, interestOut } from './employer-taste.mjs';
export { TITLE_OUT, E2_OUT, titleOut, employerClass, vcListed, fundedStartup, starEmployer, h1bPetitions, dolCount, employerVerdict, postingsAt, NOT_HIS_KIND, CAPPED, interestOut };

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
/** Which stale postings were held, and since when (refreshBodies). Kept beside the store it describes. */
// The store's folder: JARVIS_DATA_DIR when set (store.mjs's switch; the CLI
// test runs the real command against a temp store), else data/jarvis.
const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data', 'jarvis');
const HELD_FILE = path.join(DATA_DIR, 'curate-held.json');
const DB_PATH = path.join(DATA_DIR, 'jobs.db');
const LOG_PATH = path.join(DATA_DIR, 'curate-log.jsonl');
const DAILY_LOG = path.join(DATA_DIR, 'curate-daily.jsonl');

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


/** The screen's survivors, his kind of employer first, that nobody has read yet. */
export function unread(dbPath = DB_PATH, { limit = 30, days = 45, cold = notInterestingCompanies(), liked = hisEmployers(dbPath),
  minFit = 70, newGradFit = 60, classes = null, skip = null } = {}) {
  // New-grad wording comes in from fit 60 (F-765: Formlabs' "June 2027 New
  // Grads" scored 66), read after every row at 70+. The daily run goes lower
  // for his kind of employer only (`classes`), once the usual pool is read.
  let rows = loadCandidates(dbPath, { minFit, newGradFit, days })
    .filter((j) => (!classes || classes.includes(employerClass(j.company))) && !(skip && skip.has(j.id)));
  // NO BODY, AND NONE COMING (F-1040, 2026-11-11). 67 of the 83 postings at
  // the head of the queue had no description and none the enricher would
  // fetch again (three failed reads, or read and still a stub this week): each
  // run handed them to the reader, which could only say "no description to
  // read", 70 a run, every run. They wait out of the queue until the enricher
  // can read them again (staleBody, the same question refreshBodies asks), and
  // the daily line counts them.
  const thin = rows.filter((j) => (Number(j.desc_len) || 0) < 400);
  let unreadable = 0;
  if (thin.length) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const q = db.prepare('SELECT id, source, desc_len, enriched_at, enrich_fails FROM jobs WHERE id = ?');
      // …but a short body that is FINAL is read (code review #2): it is what
      // there is, and holding it out held the posting out for good.
      const out = new Set(thin.filter((j) => { const r = q.get(String(j.id)); return r && !staleBody(r) && !(bodyIsFinal(r) && (Number(r.desc_len) || 0) >= MIN_FINAL_BODY); }).map((j) => j.id));
      unreadable = out.size;
      if (out.size) rows = rows.filter((j) => !out.has(j.id));
    } catch { /* the queue as it was */ } finally { try { db?.close(); } catch { /* closed */ } }
  }
  const r = rank(rows, { limit: 5000, perCompany: 4 });
  // THE "CHECK" BUCKET IS READ TOO, AFTER THE CLEAN SURVIVORS (2026-10-03).
  // rank() sets aside a posting whose degree line it cannot settle — no degree
  // stated, Master's and Bachelor's both named, other majors "or related" —
  // with the instruction "read it". The curator only took `picks`, so nobody
  // ever did: 467 unread postings, among them Qcells' cell process engineer,
  // DSI's Mechanical Design Engineer I and STMicro's MEMS role. The reader
  // judges the degree from the whole body, which is what "check" asks for.
  const fresh = (j) => j.where !== 'elsewhere' && !titleOut(j.title) && !(CAPPED && CAPPED.test(String(j.company || '')));
  const low = (j) => ((j.fit_score ?? 0) < 70 ? 2 : 0);
  const list = [...r.picks.filter(fresh).map((j) => ({ j, b: low(j) })), ...(r.needsCheck || []).filter(fresh).map((j) => ({ j, b: 1 + low(j) }))]
    // His kind of employer first (2026-10-25): stars and big names are read
    // before a clean posting anywhere else; an unknown employer comes last.
    .map(({ j, b }, i) => ({ j, b, i, k: CLASS_RANK[employerClass(j.company)], t: tierOf(j.company, { liked, cold }) }))
    .sort((a, b) => a.k - b.k || a.b - b.b || a.t - b.t || a.i - b.i)
    .map((x) => x.j)
    .slice(0, limit);
  // Counted, never silent: the daily line says how many wait for a body.
  list.unreadable = unreadable;
  return list;
}

/**
 * A BODY IS READ AGAIN BEFORE IT IS JUDGED, WHEN IT IS OLD (F-627). Employers
 * edit postings after we read them: GE Vernova's R5052095 grew from 2,071 to
 * 3,915 characters three weeks after it was read, and the new tail said "We
 * will not sponsor". A survivor whose body is a teaser, was never read in full,
 * or was last read more than `days` ago is re-read through the enricher —
 * its pacer and daily allowance, not a second fetcher — before the reader sees
 * it. One the enricher could not re-read this time (paced out for the day, a
 * refusal) is left for the next pass, never judged on the stale copy; after
 * three failed reads the stored body is what there is, and it is read.
 *
 * The same question as enrich.mjs needsReading(), asked here because importing
 * enrich.mjs runs its argument guard against this command's flags.
 */
/**
 * THE STORED BODY IS ALL THERE WILL BE (code review #2, 2026-11-13): a source
 * nothing on the server side reads again (LinkedIn, browser-assist, the
 * extension), or three failed reads. Such a body is read however short it is
 * (from MIN_FINAL_BODY up); waiting for a longer one waits forever.
 */
export function bodyIsFinal(row) {
  if (!row) return false;
  const source = String(row.source || '').replace(/-manual$/, '');
  return !DETAIL_SOURCES.includes(source) || (row.enrich_fails || 0) >= 3;
}
/** Under this, even a final body is a stub with nothing to judge ("Apply on our site"). */
export const MIN_FINAL_BODY = 100;

export function staleBody(row, days = 7, now = Date.now()) {
  if (!row) return false;
  const source = String(row.source || '').replace(/-manual$/, '');
  if (!DETAIL_SOURCES.includes(source)) return false;   // nothing on the server side can read it again
  if ((row.enrich_fails || 0) >= 3) return false;
  const len = Number(row.desc_len) || 0;
  if (!len || (len < THIN_BODY && !row.enriched_at)) return true;
  const at = Date.parse(row.enriched_at || '');
  return !Number.isFinite(at) || now - at > days * 86_400_000;
}

/** Re-read these posting ids through the enricher, at low priority; resolves when it exits. */
export function enrichIds(ids, days, root = ROOT) {
  const file = path.join(os.tmpdir(), `jarvis-curate-refresh-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, `${ids.join('\n')}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'jarvis', 'enrich.mjs'), '--ids-file', file, '--refresh', String(days), '--limit', String(ids.length)],
      { cwd: root, stdio: 'ignore', windowsHide: true });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const done = () => { try { fs.unlinkSync(file); } catch { /* gone */ } resolve(); };
    const kill = setTimeout(() => { try { child.kill(); } catch { /* exited */ } }, 15 * 60_000);
    child.on('exit', () => { clearTimeout(kill); done(); });
    child.on('error', () => { clearTimeout(kill); done(); });
  });
}

/**
 * Which candidates may be read now. Returns `{ ready, held }`: `held` are the
 * ones whose body was stale and is still stale after the enricher's turn.
 */
export async function refreshBodies(db, cands, { days = 7, enrich = enrichIds, dryRun = false, heldFile = HELD_FILE, now = Date.now() } = {}) {
  const rowOf = (id) => {
    try { return db.prepare('SELECT id, source, desc_len, enriched_at, enrich_fails, gone_at FROM jobs WHERE id = ?').get(String(id)); } catch { return null; }
  };
  const stale = cands.filter((j) => staleBody(rowOf(j.id), days));
  if (stale.length && !dryRun) { try { await enrich(stale.map((j) => j.id), days); } catch { /* what is still stale is held */ } }
  // HELD ONCE, NOT FOREVER (F-948, 2026-10-31). A re-read that the site
  // refuses (Workday 403 after the day's allowance, a 500) does not count as
  // an enrich failure, so `enrich_fails >= 3` never released anything: KLA's
  // Product Development Engineer, body read in July, was held on every pass
  // and the daily search filed nothing for five days. A posting whose stored
  // body is FULL and that was already held on an earlier day is read from
  // that copy; a teaser or a never-read body still waits.
  let since = {};
  try { since = JSON.parse(fs.readFileSync(heldFile, 'utf8')); } catch { /* first run */ }
  const held = new Set(), released = [];
  for (const j of stale) {
    const r = rowOf(j.id);
    if (!r || r.gone_at) { held.add(j.id); continue; }
    if (!staleBody(r, days)) { delete since[j.id]; continue; }
    const full = (Number(r.desc_len) || 0) >= THIN_BODY && !!r.enriched_at;
    const first = Date.parse(since[j.id] || '');
    if (full && Number.isFinite(first) && now - first >= 86_400_000) { released.push(j.id); continue; }
    if (!since[j.id]) since[j.id] = new Date(now).toISOString();
    held.add(j.id);
  }
  if (!dryRun) { try { fs.writeFileSync(heldFile, JSON.stringify(since)); } catch { /* a record, never the read */ } }
  return { ready: cands.filter((j) => !held.has(j.id)), held: stale.filter((j) => held.has(j.id)), refreshed: stale.length - held.size - released.length, released };
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
export function priorRows(db, job) {
  try {
    return db.prepare(`SELECT title, status, location FROM jobs WHERE lower(company) = lower(?) AND id <> ?
      AND (applied_at IS NOT NULL OR status IN ('applied','inbox','interested','rejected','hidden'))
      ORDER BY status_changed_at DESC LIMIT 25`).all(String(job.company || ''), String(job.id || ''));
  } catch { return []; }
}

/**
 * A PLACE AS ITS CITY WORDS (F-956). State and country words are left out, so
 * "Milpitas, CA" and "US-CA-Milpitas" share "milpitas" and Totowa, NJ shares
 * nothing with Milpitas. null when either side names no city.
 */
const PLACE_NOISE = new Set(('us usa united states america remote hybrid onsite site office county city area metro greater '
  + 'alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas '
  + 'kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new hampshire jersey '
  + 'mexico york north carolina dakota ohio oklahoma oregon pennsylvania rhode island south tennessee texas utah vermont virginia '
  + 'washington west wisconsin wyoming').split(' '));
export function cityWords(loc) {
  return new Set(String(loc || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !PLACE_NOISE.has(w)));
}
export function samePlace(a, b) {
  const A = cityWords(a), B = cityWords(b);
  if (!A.size || !B.size) return null;
  for (const w of A) if (B.has(w)) return true;
  return false;
}
/** A title without its requisition number or parenthetical: "Mechanical Design Engineer (101531)" is the plain title. */
const titleCore = (t) => String(t || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b[a-z]{0,3}-?\d{4,}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * THE SAME TITLE AT ANOTHER SITE IS ANOTHER JOB (F-956). The reader was shown
 * his titles with no place, and dropped KLA's Totowa "Mechanical Design
 * Engineer" and Amazon's North Reading "Robotics Systems Engineer I" as "same
 * title already on his list" — both separate openings he then applied to.
 * Returns the rows with this title, each marked same site or not.
 */
export function sameTitleRows(rows, job) {
  const k = titleCore(job.title);
  if (!k) return [];
  return rows.filter((r) => titleCore(r.title) === k).map((r) => ({ ...r, place: samePlace(r.location, job.location) }));
}

export function priorAt(db, job, rows = priorRows(db, job)) {
  try {
    const out = rows.map((r) => {
      let s = `${r.title} [${r.status}]`;
      if (r.location) s += ` — ${r.location}`;
      if (titleCore(r.title) === titleCore(job.title)) {
        const p = samePlace(r.location, job.location);
        if (p === true) s += ' (same title, SAME SITE)';
        else if (p === false) s += ' (same title, OTHER SITE: a separate opening)';
      }
      return s;
    });
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
    // WHAT WAS TURNED DOWN BY HAND FOR THE EMPLOYER OR ITS PRODUCT (F-731).
    // Leviton's "Associate Mechanical Engineer" was taken out of his inbox as
    // building products, and the next pass filed Leviton's other posting of
    // that title: a "Not curated" row is status 'new', which this list never
    // read. Only a reason about the employer or its product line speaks for
    // another opening; a years line at one site says nothing about the next.
    for (const r of turnedDownAt(db, job)) {
      if (r.kind === 'employer') out.push(`${r.title} [turned down by hand: ${r.reason}]`);
    }
    return out;
  } catch { return []; }
}

/**
 * KIND OF TURN-DOWN (F-731): 'employer' when the reason is about the employer
 * or its product line (sector, industry, products, defense, nuclear…), else
 * 'posting'. A reason that names anything about the posting itself — years,
 * degree, shift, site, a duplicate, a dead link, sponsorship — is the
 * posting's, whatever else it says: carrying it to another opening is the
 * expensive error.
 */
const POSTING_REASON = /\b(?:years?|yrs?|yoe|experience|degree|bachelor\w*|master\w*|ph\.?d|requirements?|qualif\w*|graduat\w*|intern\w*|co-?op|shifts?|night|weekend|plc|e[2-5]|grade|travel|relocat\w*|duplicate|same\s+(?:title|requisition|posting)|already|closed|no\s+longer|easy\s+apply|expired|dead|description|body|stub|thin|salary|pay|clearance|itar|u\.?\s?s\.?[\s-]+person|citizen\w*|green\s+card|sponsor\w*|on-?site|location|site|city|title|role|job|work|duties|position|software|sales|product\s+management)\b/i;
const EMPLOYER_REASON = /\b(?:sectors?|industr(?:y|ies)|products?|product\s+lines?|business|employer|company|market|consumer|novelty|not\s+interesting|outside\s+(?:his|her|their))\b/i;
export function turnDownKind(reason, { fieldWords = screen.employerTurnDown || null } = {}) {
  const s = String(reason || '');
  const employer = EMPLOYER_REASON.test(s) || !!(fieldWords && fieldWords.test(s));
  return employer && !POSTING_REASON.test(s) ? 'employer' : 'posting';
}

/** A "Not curated" note's reason, without the "checked by hand —" lead. */
export function turnDownReason(note) {
  return String(note || '')
    .replace(/^Not curated\s*[—-]\s*/i, '')
    .replace(/^(?:checked(?:\s+by\s+hand)?|read\s+in\s+full|re-?screened|withdrawn)(?:\s+(?:on\s+)?\d{4}-\d{2}-\d{2})?:?\s*[—-]\s*/i, '')
    .trim();
}

/**
 * Postings at this employer turned down by HAND ("Not curated — …" written by
 * him or a session he directed). The daily reader's own turn-downs are not
 * carried: it errs in both directions (F-767), and a wrong drop must not spread.
 */
export function turnedDownAt(db, job) {
  try {
    return db.prepare(`SELECT title, pick_note FROM jobs WHERE lower(company) = lower(?) AND id <> ?
      AND pick_note LIKE 'Not curated%' AND pick_note NOT LIKE 'Not curated — read by the daily curation%'
      ORDER BY status_changed_at DESC LIMIT 25`).all(String(job.company || ''), String(job.id || ''))
      .map((r) => { const reason = turnDownReason(r.pick_note); return { title: r.title, reason, kind: turnDownKind(reason) }; });
  } catch { return []; }
}

const titleKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The same title at this employer turned down by hand for the employer or its product, or null. */
export function carriedTurnDown(db, job) {
  const k = titleKey(job.title);
  return turnedDownAt(db, job).find((r) => r.kind === 'employer' && titleKey(r.title) === k) || null;
}

/**
 * THE READER'S TURN-DOWNS ITS OWN BRIEF SAYS ARE NOT DROPS (F-767). Haiku
 * dropped Samsung's Metals Process Engineer for "Applicants must be authorized
 * to access such information or eligible for government authorization" — the
 * licence line the brief names as NOT a drop; Oceaneering's 0-2-year ME as oil
 * & gas, in his sectors since 2026-10-08; Rosenbauer's "0-3 years" as a
 * 3-year bar. Each DROP is checked here for free; only one that matches an
 * exception is asked again, with the rule spelled out.
 *
 * @returns [{ key, rule }] — the exceptions this drop runs into (empty: the drop stands)
 */
const LICENCE_WHY = /\bexport[\s-]+control|\blicen[cs]\w*|\bgovernment\s+authori[sz]ation|\bauthori[sz]ed\s+to\s+access\b|\bU\.?\s?S\.?[\s-]+person/i;
const LICENCE_LINE = /[^.\n]{0,200}\b(?:export\s+control|export\s+licen[cs]\w*|government\s+authori[sz]ation|deemed\s+export)\b[^\n]{0,240}/i;
const YEARS_WHY = /\b\d+\s*(?:-|–|—|to)\s*\d+\s*(?:years?|yrs?)\b|\b\d+\s*\+?\s*(?:years?|yrs?)\b|\b(?:one|two|three|four|five)\s+years?\b|\byears?\s+(?:of\s+)?(?:experience\s+)?(?:required|requirement|bar|bound|minimum)/i;
const SAME_TITLE_WHY = /\bduplicat\w*|\bsame (?:title|role)\b|\balready (?:on|in|at) (?:his|the) (?:list|inbox)\b|\balready (?:applied|on his|in his)\b/i;
export function dropExceptions(v, job, text, { exceptions = screen.readerDropExceptions || [], prior = null } = {}) {
  if (!v || v.verdict !== 'DROP') return [];
  const why = String(v.why || '');
  const body = String(text || '');
  const out = [];
  // A "same title" drop where every row of that title on his list is at
  // another site, and none is one he hid (F-956). A row he hid with this title
  // still speaks for it; so does one at the same site or with no place named.
  if (prior && SAME_TITLE_WHY.test(why) && !/same requisition/i.test(why)) {
    const same = sameTitleRows(prior, job);
    if (same.length && same.every((r) => r.place === false && r.status !== 'hidden')) {
      out.push({ key: 'other-site', rule: `Every "${job.title}" already on his list is at another site (${[...new Set(same.map((r) => r.location))].join('; ')}); this one is in ${job.location}. A different site is a separate opening, and he applies to those. It is not a duplicate.` });
    }
  }
  if (LICENCE_WHY.test(why) && !/\bITAR\b|International\s+Traffic\s+in\s+Arms/i.test(body)) {
    let bar = null;
    try { bar = exportBar(job.title, body); } catch { bar = 'unknown'; }
    const line = body.match(LICENCE_LINE);
    if (!bar && line) {
      out.push({ key: 'licence', rule: `The export-control line in this posting — "${line[0].replace(/\s+/g, ' ').trim().slice(0, 300)}" — is a licence he can be granted, not a U.S.-person requirement; the brief lists it as NOT a drop. Quote it in the note.` });
    }
  }
  if (YEARS_WHY.test(why)) {
    let e = null;
    try { e = classifyExperience(job.title, body); } catch { e = null; }
    // A 0-year route behind a degree he does not hold is no route (F-953):
    // KLA's "Doctorate and 0 years …; Bachelor's and 5 years" overruled the
    // reader's correct drop three times on 2026-11-02.
    const ev = String(e?.evidence?.[0] || '');
    const advancedOnly = /\b(doctor\w*|ph\.?\s?d|master'?s?)\b[^;.\n]{0,60}\b0\s*(?:\+\s*)?years?/i.test(body) && /\bbachelor'?s?\b[^;.\n]{0,60}\b[1-9]\d*\s*(?:\+\s*)?years?/i.test(body)
      && !/\bbachelor'?s?\b[^;.\n]{0,60}\b0\s*(?:-|–|to)?\s*\d*\s*years?/i.test(body);
    if (e && e.level === 'entry' && e.years === 0 && !advancedOnly && !/\b(doctor\w*|ph\.?\s?d|master'?s?)\b/i.test(ev)) {
      out.push({ key: 'zero-years', rule: `The posting offers a way in with no experience — "${String(e.evidence[0] || '').slice(0, 240)}". A required range that starts at zero passes whatever its top ("0-3" is not a 3-year bar), and so does a posting that invites recent graduates.` });
    } else if (gradProgram({ title: job.title, text: body }) && !((yearsBar(body)?.years ?? 0) > (screen.gradProgramMaxYears ?? 2))) {
      // A ROLE MADE FOR HIS GRADUATING CLASS NEVER FAILS ON YEARS (his rule,
      // 2026-11-06): Formlabs' "Manufacturing Engineer - May 2027 Graduates"
      // was dropped for "1-3 years".
      out.push({ key: 'grad-program-years', rule: `"${job.title}" is a role made for graduating students. In such a program a years line starting at 1 or 2 ("1-3", "2+") means internships and co-ops, and he has those (two engineering internships). That line is never a reason to drop it. Judge it on everything else, including whether its graduation window takes his class.` });
    } else if (stretchYears({ company: job.company, title: job.title, text: body }) && !NOT_A_STRETCH_TITLE.test(String(job.title || ''))) {
      // A STRETCH, NOT A DROP (his answer 2026-11-06, "5. ye"): at a robotics
      // company a required 1-2 years is read as a stretch fit.
      out.push({ key: 'stretch-years', rule: `${job.company} is a robotics company, and here a required years line that starts at 1 or 2 is a stretch he wants to see, not a drop (his rule). Answer MAYBE if the role passes everything else, and start the note with the years line quoted. 3+ years, field service, support and quality roles are still drops.` });
    }
  }
  // A STAR IS NOT HELD TO THE STARTUP TEST (F-948). The brief says so and the
  // reader dropped Standard Bots and Matic Robots on it anyway, the first live
  // run after (2026-10-31: "Startup not on his frontier list … no funding").
  // An unknown employer never gets this far without naming its funding
  // (employerVerdict turns it away before reading), so it is a star question.
  if (employerClass(job.company) === 'star' && SURVIVAL_WHY.test(why)) {
    out.push({ key: 'star-startup-test', rule: `${job.company} is on his frontier list, which means it has already passed his startup tests (moat, product, survivability, capital). Missing funding or headcount figures in the posting is never a reason to drop it.` });
  } else if (employerClass(job.company) === 'vc' && VC_FUNDING_WHY.test(why)) {
    // Only his named funded startups reach this (F-948, 2026-11-05): a VC
    // hiring list alone no longer makes an employer 'vc'.
    out.push({ key: 'vc-list-funded', rule: `${job.company} is one of the startups he knows to be funded (a known round, his list of 2026-11-02): it passes the survivability and capital tests. Missing funding, investor or headcount figures in the posting is never a reason to drop it. Moat, product and sponsorship still count.` });
  }
  for (const x of exceptions) {
    if (x?.why?.test(why) && !(x.unless && x.unless.test(why))) out.push({ key: x.key, rule: x.rule });
  }
  return out;
}
const VC_FUNDING_WHY = /\bsurviv\w*|\bfunding\b|\bfunded\b|\bheadcount\b|\b40\+?\s*(?:people|employees)\b|\$\s?20\s?m|\binvestors?\b|\bcapital\b|\braised\b|\bsmall team\b/i;
const SURVIVAL_WHY = /\bsurviv\w*|\bfunding\b|\bfunded\b|\bheadcount\b|\b40\+?\s*(?:people|employees)\b|\$\s?20\s?m|\binvestors?\b|\bstartup tests?\b|\bfive (?:startup )?tests\b|\bsmall team\b|\bcapital\b/i;

/**
 * A SECOND DROP THAT NAMES ANOTHER REASON STANDS (2026-10-20). The exception
 * only answers the reason it covers. Salas O'Brien's MEP building design
 * ("Relevance bar fails …") and Creation Technologies' circuit-card line were
 * filed as "worth a look" because their brief also mentioned a years figure
 * that a recent-graduate line waives; Supermicro's Optical Manufacturing
 * Engineer was filed twice, the second time over "duplicates the … already in
 * his inbox".
 */
// The hard drops are other reasons too (2026-11-02): FRALOCK's second answer
// was "Requires U.S. person status under ITAR/EAR … The 0–2 years … pass", and
// the years exception filed it as worth a look.
const OTHER_DROP_WHY = /\bITAR\b|\bU\.?\s?S\.?[\s-]+persons?\b|\bcitizen\w*|\bgreen[\s-]card\b|\bpermanent resident\b|\bsponsor\w*|\bclearance\b|\bdefen[cs]e\b|\bmilitary\b|\bPLC\b|\bmaster'?s\b|\bph\.?\s?d\b|\bdoctora\w*|\bnight\b|\bweekend\b|\brelevance\b|\bduplicat\w*|\bsame title\b|\balready (?:on|in) his (?:list|inbox)\b|\bsustaining\b|\b(?:2nd|second|3rd|third|night|overnight)\s+shift\b|\btechnician\b|\bnot (?:mechanical|an? (?:mechanical|engineering))\b|\b(?:software|electrical|IT|firmware|RF|digital)\s+(?:work|role|engineering|design)\b|\bdegree (?:list|line) (?:names|lists) only\b|\boutside (?:his|the) (?:field|discipline)\b/i;
/**
 * A FAILED BAR 2 OR 3 IS ANOTHER REASON, HOWEVER IT IS WORDED (F-934, 2026-11-04).
 * The two exceptions that can overrule a second drop, the licence line and the
 * zero-years route, both answer bar 1 (can he hold the job). The brief's bar 2
 * is the field and bar 3 the employer, so a drop that says either failed is
 * never answered by them. Salas O'Brien's MEP building design came back on
 * 2026-11-04 as "Fails bar 2: … outside his relevant fields", which the word
 * list above did not know ("relevance" did, 2026-10-20), and went in his inbox.
 * So: the bar's number when the reader gives it, and the brief's building-
 * design drop.
 *
 * TIGHTENED ON REVIEW (2026-11-04). A failing number must own its verb, in its
 * own clause: "bar 2 passes, bar 1 fails", "does not fail bar 2" and "Bar 2
 * fails? no" are bar-1 drops, and the exceptions exist to rescue exactly those.
 * The field words count only as BUILDING design ("for buildings", "MEP design",
 * "building services"), never HVAC or fire-protection products at a maker
 * (a chiller or sprinkler OEM, "building systems" robots), which are his work.
 */
const BAR_N = String.raw`(?:bar\s*#?\s*(?:[2-9]|two|three)|(?:second|third|2nd|3rd)\s+bar)`;
const FAILS_BAR = new RegExp(String.raw`\bfail(?:s|ed|ing)?\s+(?:on\s+)?(?:the\s+)?${BAR_N}\b`, 'i');
// Up to three filler words before the verb ("Bar 2: field is not met"), none of them a negation ("Bar 2: does not fail").
const FILLER = String.raw`(?:(?!(?:not|no|never|nor)\b|\w*n['’]?t\b)[\w'’-]+\s+){0,3}?`;
const BAR_FAILS = new RegExp(String.raw`^\W*(?:the\s+)?${BAR_N}\s*(?::|—|–|-|is|was)?\s*${FILLER}(?:fails?|failed|not met)\b`, 'i');
// A bar that is not passed is a failed bar (second review, 2026-11-04): "doesn't pass bar 2",
// "fails to meet bar 3", "Bar 2 does not pass". Its own negation is the verb, so the veto below does not apply.
const NOT_PASS_BAR = new RegExp(String.raw`\b(?:does\s+not|doesn['’]?t|did\s+not|didn['’]?t|fails?\s+to|failed\s+to|cannot|can['’]?t)\s+(?:pass|meet|clear)\s+(?:the\s+)?${BAR_N}\b`, 'i');
const BAR_NOT_PASSED = new RegExp(String.raw`^\W*(?:the\s+)?${BAR_N}\s+(?:does\s+not|doesn['’]?t|did\s+not|didn['’]?t|is\s+not|isn['’]?t|was\s+not|wasn['’]?t)\s+(?:pass\w*|met|meet|clear\w*)\b`, 'i');
const NEGATED = /\b(?:not|no|never|doesn['’]?t|didn['’]?t|isn['’]?t|wasn['’]?t|nor)\b|n['’]t\b/i;
const BUILDING_DESIGN = /\bfor buildings\b|\bMEP\s+(?:design|engineering|consult\w*|firm)\b|\bbuilding[\s-](?:services|design)\b|\b(?:HVAC|plumbing|fire[\s-]protection)\b[^.;]{0,40}\bdesign for (?:commercial |residential )?(?:buildings|facilities)\b|\bcivil(?:\/|\s+(?:and|or)\s+)construction\b/i;
const MAKER_WORK = /\bproducts?\b|\bequipment\b|\bmanufactur\w*/i;

/** The failing bar-2/3 clause, or the building-design phrase, in a drop's reason; else null. */
function failedBar(reason) {
  const why = String(reason || '').slice(0, 500);   // a reason is a sentence or two; a pasted body is not one
  for (const clause of why.split(/[.;!]|,\s*|\s+(?:but|while|whereas)\s+/i)) {
    if (!clause.trim() || clause.includes('?')) continue;
    const np = clause.match(NOT_PASS_BAR) || clause.match(BAR_NOT_PASSED);
    if (np && !NEGATED.test(clause.slice(0, np.index))) return np[0].trim();
    const m = clause.match(FAILS_BAR) || clause.match(BAR_FAILS);
    if (!m) continue;
    const before = clause.slice(0, m.index), after = clause.slice(m.index + m[0].length);
    if (NEGATED.test(before) || /\bpass\w*/i.test(after.split(/[:—–]/)[0])) continue;
    return m[0].trim();
  }
  if (MAKER_WORK.test(why)) return null;
  const b = why.match(BUILDING_DESIGN);
  return b ? b[0] : null;
}

export function otherDropReason(why, { sameTitleOk = false } = {}) {
  // Once code has shown every row of this title is at another site, "same
  // title" / "duplicate" is the excepted reason itself, not another one.
  const s = sameTitleOk ? String(why || '').replace(new RegExp(SAME_TITLE_WHY.source, 'gi'), ' ') : String(why || '');
  const m = s.match(OTHER_DROP_WHY);
  return m ? m[0] : failedBar(s);
}

/**
 * A SECOND DROP STANDS WHEN THE READER GAVE THE EXCEPTION ITS DUE (F-1041). Of
 * the 22 postings code filed as "worth a look" over a second drop since
 * 2026-10-28, 16 would still be filed by the word list above. Two shapes:
 * - the reader granted the excepted reason and dropped on another: "The 0-3
 *   years range passes, but the nuclear bar still fails" (AtkinsRéalis),
 *   "fails his employer test … despite passing the years bar" (Snap-on),
 *   Eos's test work, PM Group's CQV, Acuren's quoting, DuBois's field role,
 *   First Solar's pay. No word list names every other reason; the concession
 *   does.
 * - the reader held to a years line the posting really prints, at a length no
 *   zero-start route covers: Intel's "4+ years", Peterbilt's "5+ years",
 *   Formlabs' "three years" of sourcing, Niagara's 2 years. Code's route came
 *   from another line ("New graduates are encouraged to apply", "0 Years
 *   managing people"). His rules: 3+ is a drop even when preferred, a
 *   required 2 is a drop except as a robotics stretch. At a robotics stretch a
 *   preferred line never stands: he applied to Zipline over "5–7 years …
 *   preferred".
 * Rosenbauer's "0-3 years is a 3-year bar" (F-767) quotes a line that starts at
 * zero, so it is still overruled.
 */
const NUM_WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const N = String.raw`(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const YEARS_PHRASE = new RegExp(String.raw`\b(${N})\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*${N}\s*\+?\s*)?(?:years?|yrs?)\b`, 'gi');
const yearsLines = (s) => [...String(s || '').matchAll(YEARS_PHRASE)].map((m) => ({
  min: /^\d/.test(m[1]) ? Number(m[1]) : NUM_WORD[m[1].toLowerCase()], at: m.index, text: m[0],
}));
const SOFT_YEARS = /\bprefer\w*|\bdesired\b|\bnice to have\b|\bbonus\b|\bideal\w*|\ba plus\b/i;
const NOT_EXPERIENCE = /^\s*(?:of\s+)?(?:\w+\s+){0,3}?(?:graduat\w*|degree|college|school|program|coursework|old|ago)\b/i;
// The number must be a length of experience (review, 2026-11-12): never a
// "5-year warranty", "5 years of growth" or "10 years in business".
const EXPERIENCE_NEAR = /\bexperience\b|\bexp\b|\bprofessional\b|\bindustry\b|\brelevant\b|\bworking\b|\bwork\b|\bin the (?:field|position|role)\b/i;
// At a posting open to new graduates, internships and co-ops ARE the years
// (his two count): a required "2 years of internship or co-op" is no bar there.
const INTERNSHIP_NEAR = /\bintern\w*|\bco-?ops?\b/i;
/** A years line in the reader's reason that the posting prints and no zero-start route answers, else null. */
export function realYearsBar(why, body, key) {
  const need = key === 'stretch-years' ? 3 : 2;
  const text = String(body || '');
  for (const q of yearsLines(why).filter((x) => x.min >= need)) {
    for (const b of yearsLines(text)) {
      if (b.min !== q.min) continue;
      if (/\b(?:within|last|past)\s+$/i.test(text.slice(Math.max(0, b.at - 12), b.at))) continue;
      const after = text.slice(b.at + b.text.length, b.at + b.text.length + 60);
      if (NOT_EXPERIENCE.test(after.slice(0, 40))) continue;
      if (!EXPERIENCE_NEAR.test(after) && !EXPERIENCE_NEAR.test(text.slice(Math.max(0, b.at - 30), b.at))) continue;
      if (INTERNSHIP_NEAR.test(after)) continue;
      // A preferred line is no bar at a robotics stretch (he applied to
      // Zipline over "5–7 years of relevant experience preferred", 2026-11-06);
      // elsewhere a preferred 3+ still is (his rule), a preferred 2 is not.
      if ((key === 'stretch-years' || b.min < 3) && SOFT_YEARS.test(text.slice(Math.max(0, b.at - 120), b.at + b.text.length + 60))) continue;
      return b.text;
    }
  }
  return null;
}
const CLAUSES = /[.;!:]|\s+(?:but|while|whereas|though|although|despite|yet)\s+/i;
const YEARS_SUBJECT = /\byears?\b|\byrs?\b/i;
// "holds" is not here: "He holds 2 years of internships, so the 0-3 years line
// is a 3-year bar" concedes nothing (review, 2026-11-12).
const CONCEDES = /\bnot the reason\b|\bnot a (?:drop|reason)\b|\b(?:pass(?:es|ed|ing)?|clear(?:s|ed)?|(?:is|are) met|(?:is|are) fine)\b/gi;
const NEGATED_VERB = /(?:\bnot|\bnever|\bno|n['’]t|\bfails?\s+to|\bfailed\s+to|\bcannot)\s+(?:\w+\s+){0,2}$/i;
/** The clause in a second drop that grants the excepted reason, else null. */
export function concedesException(why, key) {
  const subject = key === 'licence' ? LICENCE_WHY : YEARS_SUBJECT;
  for (const c of String(why || '').slice(0, 600).split(CLAUSES)) {
    if (!subject.test(c) || c.includes('?')) continue;
    const ms = [...c.matchAll(CONCEDES)];
    if (!ms.length) continue;
    // Every grant in the clause must be a plain one: "does not pass", or
    // "passes only for PhDs", anywhere in it and the clause grants nothing.
    const plain = (m) => /^not/i.test(m[0]) || (!NEGATED_VERB.test(c.slice(0, m.index)) && !/^\s+only\b/i.test(c.slice(m.index + m[0].length)));
    if (!ms.every(plain)) continue;
    return c.trim();
  }
  return null;
}
/** Why a second drop stands against the exceptions code checked (`keys`), else null. */
export function secondDropStands(why, body, keys) {
  for (const k of keys) {
    const c = concedesException(why, k);
    if (c) return `conceded: ${c}`;
    if (k === 'zero-years' || k === 'stretch-years') {
      const y = realYearsBar(why, body, k);
      if (y) return `the posting's "${y}"`;
    }
  }
  // A failure it states about something else ("nuclear fleet work …, which he
  // has ruled out"). One about the excepted reason itself is what code answers.
  const said = statedFailure(why, (c) => keys.some((k) => (k === 'licence' ? LICENCE_WHY : YEARS_SUBJECT).test(c)));
  return said ? `states: ${said}` : null;
}

/**
 * A REASON THAT STATES A FAILURE IS A DROP, WHATEVER THE VERDICT SAYS (F-1041).
 * The reader filed Apple's "most duties are failure analysis, root-cause,
 * validation and tolerance work, the test-role pattern he turned down" and
 * TRUMPF's "most listed duties are project management, reporting and SAP
 * upkeep, which is the admin work he turns down" as MAYBE. A doubt stays a
 * MAYBE: he applied to Coherent's "duties lean toward sustaining work … which
 * he has turned down" and Cummins' "lean on validation … which he turns down",
 * and onsemi's "could place him in roles he turns down" is on his interested
 * list. So only a clause with no hedge in it counts, and "outside his
 * industries" never does on its own (two of those are on his interested list).
 */
const STATED_FAIL = /\bfails\b(?!\s+to\s+(?!meet|pass|clear)\w)|\bhe\s+(?:has\s+)?(?:already\s+)?(?:turned\s+down|ruled\s+out)\b|\bwhich\s+(?:is\s+)?(?:the\s+)?[\w\s/-]{0,40}?\bhe\s+turns\s+down\b|\b(?:stays|remains)\s+a\s+drop\b|\bhis\s+rules\s+(?:drop|turn\s+down|rule\s+out)\b|\b(?:he\s+)?(?:cannot|can['’]?t)\s+(?:meet|hold|satisfy)\b/i;
const HEDGE = /\blean\w*|\bedges?\b|\bclose to\b|\bcould\b|\bmay\b|\bmight\b|\bwould\b|\blike\b|\binclud\w*|\balso\b|\bsome\b|\bpart(?:ly|ial\w*)?\b|\btoward\w*|\bif\b|\bunless\b|\bwhether\b|\bpossibl\w*|\bperhaps\b|\bunclear\b|\bnot clear\b|\bdoubt\w*/i;
// A negation or a contrast anywhere before the failure word turns it around
// (review, 2026-11-12): "Not the nuclear work he ruled out", "None of his
// bars fails", "Neither bar 1 nor bar 2 fails", "Unlike the validation roles
// he turned down, this is design work".
const CONTRA = /\b(?:not|no|none|neither|nor|never|nothing|unlike|despite|rather than|instead of)\b|n['’]t\b/i;
// What the posting itself says, in quotes, is not the reader's verdict:
// 'applicants who "cannot meet the onsite need" are excluded'.
const QUOTED = /"[^"]{0,300}"|“[^”]{0,300}”|(^|[\s(])'[^']{3,300}'(?=[\s.,;:)!]|$)/g;
export function statedFailure(why, skip = () => false) {
  // "despite"/"unlike" open a clause and stay at its head, so the contrast
  // check below sees them: "fails bar 2 despite the years" keeps "fails bar 2".
  for (const raw of String(why || '').slice(0, 600).split(/[.;!]|\s+(?:but|while|whereas|though|although|yet)\s+|\s+(?=(?:despite|unlike)\s)/i)) {
    const c = raw.replace(QUOTED, '$1 ');
    if (!c.trim() || c.includes('?') || HEDGE.test(c) || skip(c)) continue;
    const m = c.match(STATED_FAIL);
    if (!m || CONTRA.test(c.slice(0, m.index))) continue;
    return raw.trim();
  }
  return null;
}
/**
 * A KEEP or MAYBE whose reason states a failure, turned into the DROP it says
 * it is. Never a posting he already acted on (in his inbox, on his interested
 * list, applied): his act outranks any wording.
 */
const HIS_ACT = new Set(['inbox', 'interested', 'applied', 'responded', 'interview', 'offer']);
const hisAct = (job) => !!job && (HIS_ACT.has(String(job.status || '')) || !!job.applied_at);
export function dropIfStated(v, job = null) {
  if (!v || v.verdict === 'DROP') return v;
  if (hisAct(job)) return v;
  const said = statedFailure(v.why);
  return said ? { verdict: 'DROP', why: v.why, note: '', statedAs: v.verdict, stated: said } : v;
}

/**
 * OUTSIDE THE US, TURNED DOWN BEFORE ANY READ (F-1042). The usual stages
 * leave foreign rows out of the pool, but the library stage did not, and
 * Formlabs' Shenzhen "Process Engineer" was read and filed. So every posting
 * is checked here, whatever stage offered it: the country its location field
 * names, read fresh by geo.mjs (not a stale stored bucket), and, when that
 * field names no country ("Thetford, Norfolk"), the country the posting's own
 * text puts that town in ("Multimatic Technical Centre Europe (MTCE) in
 * Thetford, UK"). Any US or remote reading, or a town the text places in the
 * US as well, is read as usual. Returns the drop reason, or null.
 */
export function outsideUs(j, text = '') {
  const loc = String(j?.location || '').trim();
  const where = classifyLocation(loc, j?.title, j?.url);
  if (where === 'non-us') return `Outside the US: ${loc || j?.title}`;
  if (where !== 'unknown' || !loc) return null;
  const town = loc.split(/\s*[,(|;·]\s*/)[0].trim();
  if (town.length < 4 || /\d/.test(town) || /remote|hybrid|location/i.test(town)) return null;
  const esc = town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The place after "Town," is read one word at a time, shortest first, and the
  // first reading decides: "Morton Grove, IL office seeks a Sr" is Illinois,
  // not the "Sr" (Suriname) its last word would make it; "Broughton, North
  // Wales" needs both words. Only capitalised words name a place: "Boston,
  // on-site at" and "Boston, Merlin is" read as Austria and Iceland otherwise.
  const re = new RegExp(`\\b${esc}\\s*,\\s*([A-Z][A-Za-z'-]*\\.?(?:[ \\t]+[A-Z][A-Za-z'-]*\\.?){0,2})`, 'g');
  let abroad = null, home = false;
  for (const m of String(text || '').matchAll(re)) {
    const words = m[1].split(/\s+/).map((w) => w.replace(/\.$/, ''));
    for (let n = 1; n <= words.length; n++) {
      const place = words.slice(0, n).join(' ');
      const v = classifyLocation(`${town}, ${place}`);
      if (v === 'unknown') continue;
      if (v === 'non-us') abroad = abroad || place;
      else home = true;
      break;
    }
  }
  return abroad && !home ? `Outside the US: ${loc} (the posting places it in ${abroad})` : null;
}

/** The second question, for a drop that ran into one of the brief's exceptions. */
export function recheckPrompt(prompt, v, found) {
  return `${prompt}

A CHECK ON YOUR FIRST ANSWER. You answered DROP because: "${v.why}". Under the rules above that is not a reason to drop:
${found.map((f) => `- ${f.rule}`).join('\n')}
Judge the posting again on every OTHER bar. If one of them fails, DROP and name that one; otherwise KEEP or MAYBE. Answer with ONE line of JSON, as before.`;
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
  const reach = REACH_KINDS.includes(String(v.reach || '').toLowerCase()) ? String(v.reach).toLowerCase() : null;
  return reach && verdict !== 'DROP' ? { verdict, why, note, reach } : { verdict, why, note };
}

/**
 * A REACH IS LABELLED, NEVER DROPPED (F-934, first mate's call 2026-11-04). The
 * reader filed Field AI's sensor role and Coherent's crystal growth as worth a
 * look with the reach in its own note ("the degree list never names mechanical
 * … a stretch"), and he spent a full application on each. A drop rule would cut
 * roles he chose: of the notes naming a missing degree he applied to 7 (Innate,
 * Maven, Focused Energy…). So the card says so, first: "Reach: …". The reader
 * names it ("reach" in its answer); when it does not, the same narrow wording
 * in its own catch does. Nothing else changes: not the verdict, not the order.
 */
export const REACH_KINDS = ['degree', 'field', 'level'];
export const REACH_LABEL = {
  degree: 'his degree is not among the ones the posting lists',
  field: 'the core work is another discipline',
  level: 'the level asks for more experience than a new graduate has',
};
// Each names the reach only in so many words (review, 2026-11-04): the degree
// left out must be mechanical, and a list that "leads with" one must lead with
// another discipline; the core work must BE the other discipline, word for
// word after the verb ("is sensor electronics", never "is mechanical design,
// no software", nor "electronics-adjacent"); the level numeral must end a
// title in quotes or before punctuation ("Equipment Engineer 2" and, not "a
// role needing 2 years"); "experienced hire" never after a not / no / isn't.
const OTHER_DISCIPLINE = String.raw`(?:chemical|chemistry|electrical|electronics|materials|computer|physics|optics|optical|photonics|software|firmware|RF)`;
const REACH_NOTE = {
  degree: new RegExp(String.raw`degree (?:list|line)[^.]{0,120}?\b(?:never names|does not name|doesn['’]?t name|does not list|doesn['’]?t list|omits|leaves out)\s+(?:mechanical|ME)\b|degree (?:list|line)[^.]{0,120}?\bleads with\s+${OTHER_DISCIPLINE}\b(?!-)|degree (?:list|line)[^.]{0,120}?,\s*not mechanical\b|\bmechanical (?:engineering )?is not (?:listed|named|among)\b`, 'i'),
  field: new RegExp(String.raw`\b(?:core|main|real|day-to-day) (?:work|job|duties)\b[^.]{0,40}?\b(?:is|are|reads? as)\s+(?:(?:mostly|largely|mainly|really)\s+)?(?:an?\s+)?(?:sensor\s+|analog\s+|power\s+)?${OTHER_DISCIPLINE}\b(?!-)|(?<!(?:\bnot|\bnever|n['’]t)\s+)\breads? (?:more )?like (?:an? )?${OTHER_DISCIPLINE}\b(?!-)`, 'i'),
  experienced: /(?<!(?:\bnot|\bno|\bnever|n['’]t)\b[^.]{0,20})\bexperienced hire\b|\bSeniority Level: Mid-Level\b/i,
  // Case-sensitive: the title starts with a capital (a sentence's "a role needing 2 years" does not).
  title: /\bjob profile is ["“]?[A-Z][\w&/ -]{0,40}?\s(?:2|II|3|III)(?:["”]|(?=\s*(?:[,.;:)]|and\b|with\b|$)))/,
};
const reachInNote = (note) => {
  const n = String(note || '');
  if (REACH_NOTE.degree.test(n)) return 'degree';
  if (REACH_NOTE.field.test(n)) return 'field';
  if (REACH_NOTE.experienced.test(n) || REACH_NOTE.title.test(n)) return 'level';
  return null;
};
/** The reach kind for a pick: the reader's own, else its note's catch; null when none. */
export function reachOf(v) {
  if (!v || v.verdict === 'DROP') return null;
  if (REACH_KINDS.includes(v.reach)) return v.reach;
  return reachInNote(v.note);
}

async function askModel(prompt) {
  // Haiku reads (his call, 2026-10-08: "reduce the readers to haiku"). Every
  // pick is still checked by hand before it is reported, and never Opus
  // (his rule for writers, 2026-09-16).
  const out = await run('claude', ['-p'], { input: prompt, timeout: 180_000, models: ['haiku'] });
  return out.stdout;
}

/**
 * Why a run stopped on a spent model, with the CLI's own sentence when it gave
 * one ("You've hit your 5-hour limit · resets 2am") — F-1040.
 */
export function spentWhy(e) {
  const m = String(e?.message || '').match(/out of credit \((.*)\)\s*$/);
  return `model out of credit — run stopped${m ? `: ${m[1]}` : ''}`;
}

/**
 * One run. `ask` and `file` are injectable so the tests never call a model or
 * write the store.
 */
export async function curate({ dbPath = DB_PATH, limit = 30, target = 50, force = false, dryRun = false,
  ask = askModel, file = approve, log = (e) => fs.appendFileSync(LOG_PATH, `${JSON.stringify(e)}\n`), root = ROOT,
  candidates = null, readDesc = readDescription, route = routeFor, days = 45, screen = prescreen, lockWaitMs = 10 * 60_000,
  refresh = refreshBodies, refreshDays = 7, enrich = enrichIds, taste = null, dol = null, stopAfter = Infinity, markRoute = null } = {}) {
  // LinkedIn's route goes through the store's own writer, under its lock
  // (F-968). Only for the store itself: a run against another file (a test's)
  // records nothing rather than touch the real store.
  markRoute ||= (id, how) => storeRouteWriter(dbPath).then((w) => w && w(id, how));
  // Postings handed in by hand were chosen on purpose: the taste gate (2026-10-25) is for the unattended pick.
  const tasteOf = taste || (candidates ? () => null : employerVerdict);
  const db = openDb(dbPath);
  const open = openPicks(db);
  if (!force && open >= target) { db.close?.(); return { skipped: true, open, target, kept: [], maybe: [], dropped: [], failed: [] }; }
  const want = force ? limit : Math.min(limit, Math.max(10, (target - open) * 3));
  const picked = candidates || unread(dbPath, { limit: want, days });
  const cv = facts(root);
  const kept = [], maybe = [], dropped = [], failed = [];
  // Old bodies are read again first (F-627); one the enricher could not reach
  // this pass waits for the next, rather than being judged on the old copy.
  let cands = picked;
  try {
    const r = await refresh(db, picked, { days: refreshDays, enrich: (ids, d) => enrich(ids, d, root), dryRun,
      heldFile: path.join(path.dirname(dbPath), 'curate-held.json') });
    cands = r.ready;
    for (const j of r.held) failed.push({ id: j.id, why: `body due a re-read (older than ${refreshDays} days or never read in full) and not re-read this pass — left for the next` });
  } catch { cands = picked; }
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
  const dolOf = dol || dolPetitions(dbPath);
  const unfiled = [];
  const fileOne = (row) => {
    if (row.verdict === 'DROP') {
      // Read and turned down: the reason stays on the row and the screen skips it.
      file([row.id], { [row.id]: `read by the daily curation — ${row.why}` }, { dbPath, undo: true });
    } else {
      const base = row.verdict === 'MAYBE' && !/^worth a look/i.test(row.note) ? `Worth a look: ${row.note}` : row.note;
      // LOW CONFIDENCE (F-979): the posting's own text is short, so the verdict rests on less.
      const withCopy = row.copyOf ? `${base} The description was read from a copy of the posting on ${row.copyOf}, not the employer's own board.` : base;
      const lowConf = row.lowConfidence ? `${withCopy} Low confidence: ${row.lowConfidence}; read the posting before applying.` : withCopy;
      const kind = reachOf(row);
      // A STRETCH (his answer 2026-11-06, "5. ye"): a robotics company's role
      // asking 1-2 years, filed after the true fits of its band (dashboard).
      const stretch = row.stretch ? `${STRETCH_LABEL} ` : '';
      const note = kind ? `Reach: ${REACH_LABEL[kind]}. ${stretch}${lowConf}` : `${stretch}${lowConf}`;
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
  // ONE ROLE, ONE PICK (F-935, 2026-10-27). Honda posts the same Manufacturing
  // Equipment Engineer in Lincoln, AL as two requisitions with the same teaser;
  // both were read in one batch and both went in his inbox, because "already in
  // his inbox" was asked before the run. A second posting with the same
  // employer, title and place as an open pick — or one filed earlier this run —
  // is turned down without a read.
  const roleKey = (c, t, l) => [c, t, l].map((x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|');
  // role → the ids holding it, so a posting is never its own duplicate (a
  // second run read First Solar's pick, filed a minute earlier, as "another
  // requisition" of itself and turned it down, 2026-11-02).
  const openRoles = new Map();
  const hold = (k, id) => { if (!openRoles.has(k)) openRoles.set(k, new Set()); openRoles.get(k).add(String(id)); };
  try {
    for (const r of db.prepare(`SELECT id, company, title, location FROM jobs WHERE status IN ('inbox','interested')
      AND applied_at IS NULL AND gone_at IS NULL AND superseded_by IS NULL`).all()) hold(roleKey(r.company, r.title, r.location), r.id);
  } catch { /* a store without these columns has nothing open */ }
  const record = (row) => {
    if (row.verdict === 'KEEP' || row.verdict === 'MAYBE') {
      const j = cands.find((x) => x.id === row.id);
      if (j) hold(roleKey(j.company, j.title, j.location), j.id);
      if (j?.shortBody) row = { ...row, lowConfidence: j.shortBody };
      if (j?.bodyFromCopy) row = { ...row, copyOf: j.bodyFromCopy };
      const reach = reachOf(row);
      if (reach) row = { ...row, reach };
    }
    (row.verdict === 'KEEP' ? kept : row.verdict === 'MAYBE' ? maybe : dropped).push(row);
    log({ at: new Date().toISOString(), ...row });
    if (dryRun) return;
    unfiled.push(row);
    flush();
  };
  try {
    for (const j of cands) {
      // THE TOP-UP IS A CAP (2026-11-04): the proof run's goal was 10 and the
      // last batch filed past it, to 11. The daily search says how many it
      // still wants; the rest of the batch stays unread for the next run.
      if (kept.length + maybe.length >= stopAfter) break;
      if ([...(openRoles.get(roleKey(j.company, j.title, j.location)) || [])].some((id) => id !== String(j.id))) {
        record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: 'the same role at the same place is already in his inbox (another requisition)', note: '' });
        continue;
      }
      // WORK HE SAID HE DOES NOT WANT, by the title, before anything is read
      // (thermal, 2026-11-05: "for thermal jobs I think it's a waste of time,
      // not my interest plus no expertise"). Every caller, handed-in postings too:
      // this is his interest, not the employer-taste gate.
      { const out = interestOut(j);
        if (out) { record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: `${out.why} — ${out.said}`, note: '' }); continue; } }
      let desc = '';
      try { desc = readDesc(db, j.id) || ''; } catch { desc = ''; }
      // A short body that is final is read, marked short below (code review #2).
      let final = false;
      if (desc.length < 400 && desc.length >= MIN_FINAL_BODY) {
        try { final = bodyIsFinal(db.prepare('SELECT source, enrich_fails FROM jobs WHERE id = ?').get(String(j.id))); } catch { final = false; }
      }
      if (desc.length < 400 && !final) { failed.push({ id: j.id, why: 'no description to read' }); continue; }
      { const t = htmlToText(desc); if (t.length < 500 || isThinBody(t)) j.shortBody = `the posting's own description is short (${t.length} characters${isThinBody(t) ? ', no requirements section' : ''})`; }
      // A BODY BORROWED FROM A COPY SAYS SO (F-978 review): to the reader, and on the card.
      try {
        const from = db.prepare('SELECT body_from FROM jobs WHERE id = ?').get(j.id)?.body_from || '';
        if (from) j.bodyFromCopy = db.prepare('SELECT source FROM jobs WHERE id = ?').get(from.replace(/^copy:/, ''))?.source || 'another site';
      } catch { /* a store without the column */ }
      // A LinkedIn posting is asked how it takes an application before anything
      // is read: Easy Apply only means no tailored resume, and he does not apply
      // that way (2026-10-02). Unknown is not Easy Apply; it is read as usual.
      if (linkedInJobId(j.url)) {
        let how = null;
        try { how = await route(j.url); } catch { how = null; }
        if (how) { try { await markRoute(j.id, how); } catch { /* a record, never the read */ } }
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
      const text = htmlToText(desc);
      let acted = null;   // his own status for this posting, read from the store (candidates do not carry it)
      try { acted = db.prepare('SELECT status, applied_at FROM jobs WHERE id = ?').get(String(j.id)) || null; } catch { acted = null; }
      // Never a posting he already acted on: his act outranks the reading.
      const abroad = hisAct(acted ? { ...j, ...acted } : j) ? null : outsideUs(j, text);
      if (abroad) { record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: abroad, note: '' }); continue; }
      const pre = screen({ title: j.title, text, company: j.company });
      if (pre) { record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: pre.why, note: '' }); continue; }
      // The same title at this employer, turned down by hand for the employer
      // or its product line, is turned down again without a model (F-731).
      const carried = carriedTurnDown(db, j);
      if (carried) {
        record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: `"${carried.title}" at ${j.company} was turned down by hand: ${carried.reason}`, note: '' });
        continue;
      }
      // An employer that is neither a star nor a big name is turned down
      // without a model unless its own posting names top investors or big
      // funding (his taste quiz, 2026-10-25).
      const kind = employerClass(j.company);
      const taste = tasteOf(j, text);
      if (taste) {
        record({ id: j.id, company: j.company, title: j.title, verdict: 'DROP', why: taste, note: '' });
        continue;
      }
      let v = null;
      const prior = priorRows(db, j);
      const told = j.bodyFromCopy ? `[This description comes from a copy of the posting on ${j.bodyFromCopy}, not the employer's own board.]\n\n${desc}` : desc;
      // The reader is told the Department's own engineering-petition count
      // (F-984; first mate's call 2026-11-04): the ledger's evidence adds the
      // store's postings to it. null (no file loaded) says nothing.
      const prompt = promptFor({ ...j, employerClass: kind, h1b: dolOf(j.company) ?? undefined }, told, cv, priorAt(db, j, prior));
      try { v = parseVerdict(await ask(prompt)); } catch (e) {
        if (/out of credit/i.test(String(e?.message))) { failed.push({ id: j.id, why: spentWhy(e) }); break; }
        failed.push({ id: j.id, why: String(e?.message || e).slice(0, 120) });
        continue;
      }
      if (!v) { failed.push({ id: j.id, why: 'unreadable verdict' }); continue; }
      v = dropIfStated(v, acted ? { ...j, ...acted } : j);
      // A DROP its own brief says is not one is asked once more (F-767). A
      // second read that fails leaves the posting unread for the next run; a
      // second DROP for the same excepted reason is filed as worth a look.
      const found = dropExceptions(v, j, text, { prior });
      if (found.length) {
        let v2 = null;
        try { v2 = parseVerdict(await ask(recheckPrompt(prompt, v, found))); } catch (e) {
          if (/out of credit/i.test(String(e?.message))) { failed.push({ id: j.id, why: spentWhy(e) }); break; }
          v2 = null;
        }
        if (!v2) { failed.push({ id: j.id, why: `second read failed after a drop its brief excepts (${found.map((f) => f.key).join(', ')})` }); continue; }
        v2 = dropIfStated(v2, acted ? { ...j, ...acted } : j);
        const keys = found.map((f) => f.key);
        // 'other-site' only tells the reader where his rows are; its second
        // answer stands. Code compares exact titles, and the reader caught
        // near-same titles at the same site (Amazon North Reading, 2026-11-02).
        // Only an exception that code checked against the posting's own words
        // (a licence line, a zero-year route) overrules a second drop. The
        // star / VC-list reminders only tell the reader something: AtmosZero's
        // Engineer III design role was filed over a second, correct years drop
        // (2026-11-02).
        const FORCES = new Set(['licence', 'zero-years', 'stretch-years']);
        const again = dropExceptions(v2, j, text, { prior }).filter((f) => keys.includes(f.key) && FORCES.has(f.key));
        if (v2.verdict === 'DROP' && again.length && !otherDropReason(v2.why, { sameTitleOk: keys.includes('other-site') })
          && !secondDropStands(v2.why, text, again.map((f) => f.key))) {
          v2 = {
            verdict: 'MAYBE', why: v2.why,
            note: `Worth a look: the reader turned this down twice for "${v2.why.slice(0, 200)}", which his rules do not count as a drop (${again.map((f) => f.key).join(', ')}). Read the posting before applying.`,
          };
        }
        record({ id: j.id, company: j.company, title: j.title, ...v2, rechecked: keys, firstWhy: v.why, stretch: stretchYears({ company: j.company, title: j.title, text }) && !NOT_A_STRETCH_TITLE.test(String(j.title || '')) });
        continue;
      }
      record({ id: j.id, company: j.company, title: j.title, ...v, stretch: stretchYears({ company: j.company, title: j.title, text }) && !NOT_A_STRETCH_TITLE.test(String(j.title || '')) });
    }
    const until = Date.now() + lockWaitMs;
    while (!flush() && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(15_000, lockWaitMs)));
  } finally { db.close?.(); }
  return { skipped: false, open, target, read: cands.length, kept, maybe, dropped, failed, unfiled: unfiled.map((r) => r.id) };
}

/**
 * store.setApplyRoute when `dbPath` is the store's own file, else null.
 * A path that LOOKS like a store (a jobs.db) but is not this one — another
 * checkout's, or a spelling samePath could not resolve — gets no writer, and
 * says so once per run, so LinkedIn routes are never dropped in silence
 * (F-968 review follow-up, 2026-11-04).
 */
let routeWriterWarned = false;
export async function storeRouteWriter(dbPath, { warn = (m) => console.warn(m) } = {}) {
  const store = await import('./store.mjs');
  if (samePath(dbPath, store.dbPath())) return store.setApplyRoute;
  if (!routeWriterWarned && /(^|[\\/])jobs\.db$/i.test(String(dbPath || ''))) {
    routeWriterWarned = true;
    warn(`  (apply routes not recorded: ${dbPath} is not this store's file, ${store.dbPath()})`);
  }
  return null;
}
/** For tests: let the next null writer warn again. */
export const resetRouteWriterWarning = () => { routeWriterWarned = false; };

// One file, however it is spelled (review, 2026-11-04): same-file.mjs, shared with mail.mjs.
export { samePath };

/**
 * THE DAILY SEARCH (2026-10-26). "schedule a job search every single day, at
 * least 20 new jobs until my inbox hits 50 min, this thing hasnt worked in
 * forever." The 6-hourly pass reads 30 postings and only while the dashboard
 * is up; under his taste rules 30 reads file 0–3, and nothing ran from 10-21
 * to 10-25. This keeps reading in batches until it has filed `want` new picks
 * (or enough to bring the inbox to `target`, whichever is more), the pool is
 * read out, or `maxRead` postings have been read. Once the usual pool (fit
 * 70+, new-grad wording 60+) is read, it goes on to his kind of employer —
 * star, big name, conglomerate — down to fit 55. Run by the scheduled task
 * from jarvis/register-daily-search.ps1; nothing happens with the inbox at 50+.
 */
/**
 * THE LIBRARY'S SURVIVORS, BEST FIRST (F-958). After the usual windows are read,
 * the daily search reads the whole-library screen's survivors (library-screen.mjs:
 * every open row, his hard rules, no model). Rescreens what changed first.
 * Readable rows only; his kind of employer before the rest, then fit.
 */
/** A card's reason is missing or was lost when it came back to his inbox. */
export const reasonLost = (note) => !String(note || '').trim() || /original pick note was not recoverable/i.test(String(note));

/**
 * EVERY CARD CARRIES ITS REASON (2026-11-03). Cards that came back to his
 * inbox, or were filed by hand, sat there with no argument ("original pick
 * note was not recoverable"; Honda's Mechanical Design Engineer had none at
 * all). The reader reads each again in dry-run, so nothing is filed, moved or
 * turned down, and only the note is written back (store.setPickNote, which
 * leaves the status and its time alone). If the reader would not file it today,
 * the note says so: a flag on his card, never a move.
 */
export async function renote({ dbPath = DB_PATH, run = curate, write = null, log = () => {} } = {}) {
  const db = openDb(dbPath);
  const rows = db.prepare("SELECT id, company, title, location, url, source, fit_score, pick_note FROM jobs WHERE status IN ('inbox','queued') AND gone_at IS NULL").all()
    .filter((r) => reasonLost(r.pick_note));
  db.close?.();
  if (!rows.length) return { asked: 0, written: 0, rows: [] };
  // The stored body is read as it is: a reason needs no fresh copy, and a dry
  // run would otherwise hold every card whose body is due a re-read.
  const r = await run({ dbPath, candidates: rows, dryRun: true, force: true, limit: rows.length, taste: () => null, log,
    refresh: async (_db, picked) => ({ ready: picked, held: [] }) });
  const day = new Date().toLocaleDateString('en-CA');   // his date, not UTC's
  const setNote = write || (async (id, note) => (await import('./store.mjs')).setPickNote(id, note));
  let written = 0;
  const out = [];
  for (const v of [...r.kept, ...r.maybe, ...r.dropped]) {
    const body = String(v.note || v.why || '').trim();
    if (!body) continue;
    const note = v.verdict === 'DROP'
      ? `Read again ${day}: the reader would not file this one today — ${body}`
      : `${v.verdict === 'KEEP' ? 'Keep' : 'Worth a look'} (reason written again ${day}): ${body}`;
    if (await setNote(v.id, note)) { written++; out.push({ id: v.id, company: v.company, title: v.title, verdict: v.verdict }); }
  }
  // A card the reader could not read (only a list teaser is stored) says so,
  // rather than standing there with no argument at all.
  for (const f of r.failed) {
    const row = rows.find((x) => x.id === f.id);
    if (!row || !reasonLost(row.pick_note)) continue;
    const note = `No reason on file (${day}): only a short list teaser of this posting is stored, so it has not been read in full. Read the posting before applying.`;
    if (await setNote(f.id, note)) { written++; out.push({ id: f.id, company: row.company, title: row.title, verdict: 'UNREAD' }); }
  }
  return { asked: rows.length, written, rows: out, unread: r.failed.length };
}

export async function libraryPool(dbPath = DB_PATH, { limit = 30, skip = null, rescreen = true } = {}) {
  const { screenLibrary, survivors } = await import('./library-screen.mjs');
  const screenPath = path.join(path.dirname(dbPath), 'screen.db');
  if (rescreen) {
    // A failed rescreen is said, not swallowed (audit, 2026-11-03); the cached verdicts still stand.
    try { screenLibrary({ dbPath, screenPath }); } catch (e) { console.error(`library screen not refreshed: ${String(e?.message || e).slice(0, 200)}`); }
  }
  let ids = [];
  try { ids = survivors({ screenPath, limit: 5000, skip }); } catch { return []; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const get = db.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'new' AND gone_at IS NULL AND superseded_by IS NULL AND (pick_note IS NULL OR pick_note NOT LIKE 'Not curated%')");
  const rows = [];
  for (const r of ids) { const j = get.get(r.id); if (j) rows.push(j); }
  db.close();
  // A title in his field first, then his kind of employer, then fit: ranked by
  // class alone, the first reads were a star's HPC and IT roles (2026-11-03).
  const FIELD = /mechanical|manufactur|process|equipment|robot|mechatron|automation|design engineer|production engineer|r&d|npi|hardware engineer|build engineer/i;
  return rows.map((j, i) => ({ j, i, f: FIELD.test(String(j.title || '')) ? 0 : 1, k: CLASS_RANK[employerClass(j.company)] ?? 3 }))
    .sort((a, b) => a.f - b.f || a.k - b.k || (b.j.fit_score ?? 0) - (a.j.fit_score ?? 0) || a.i - b.i)
    .slice(0, limit).map((x) => x.j);
}

/** His calendar day (local), not UTC: the 4:10 PM run is the next UTC day. */
export const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * ONE TOP-UP ALLOWANCE A DAY, SHARED (first mate's call, 2026-11-04,
 * reversible). Top-ups past his target were approved for the two scheduled
 * runs, `dailyTopUp` each. A triggered read of new postings may draw on the
 * same allowance, so the day's volume past his target never grows (2 ×
 * dailyTopUp); picks only arrive sooner. Counted from the day's outcome lines.
 */
export function topUpToday(lines, { now = Date.now(), cap = 20 } = {}) {
  const day = localDay(now);
  const used = (lines || []).filter((e) => e && e.at && localDay(e.at) === day).reduce((n, e) => n + (Number(e.topup) || 0), 0);
  return { cap, used, left: Math.max(0, cap - used) };
}

export async function daily({ dbPath = DB_PATH, want = 20, target = 50, topUp = 0, maxRead = 300, batch = 30, days = 45,
  maxFile = Infinity, trigger = '', topUpDay = null,
  run = curate, pool = unread, library = libraryPool, open = null, log = (e) => fs.appendFileSync(DAILY_LOG, `${JSON.stringify(e)}\n`) } = {}) {
  // A TRIGGERED READ (C, 2026-11-04): the dashboard starts one when the
  // enricher reads bodies for new postings the screen was waiting on. It files
  // at most `maxFile`, reads only the `days` window (new postings), skips the
  // older windows and the library, and its line says `trigger`.
  const tag = trigger ? { trigger } : {};
  const _log = log;
  log = (e) => _log({ ...e, ...tag });
  let have = open;
  if (have === null) { const db = openDb(dbPath); have = openPicks(db); db.close?.(); }
  // A FULL INBOX IS A NO-OP, SAID SO (2026-11-03): health checks read this log,
  // and "skipped" alone looked the same as a run that broke. It is not a
  // failure; the next run after picks are applied, skipped or closed refills.
  // THE TOP-UP (approved 2026-11-03): a scheduled run files up to `topUp` fresh
  // fits even with a full inbox, so readable survivors never wait for him to
  // retire old picks. It is added on top of the refill to target. With a full
  // inbox it reads only the library's survivors, best fits first, judged by
  // the same reader as every pick.
  const room = have < target ? target - have : 0;
  let refill = have < target ? Math.max(want, room) : 0;
  // The day's shared top-up, said on every line that draws on it (topUpDay = { cap, used }).
  // NEVER PAST TARGET PLUS WHAT IS LEFT OF IT (first mate's call, 2026-11-04):
  // "want" used to fill past target uncounted (45 open + want 20 = 65). Now
  // everything past target — a want larger than the room, and the top-up —
  // comes out of the day's shared allowance and is logged as top-up.
  if (topUpDay) {
    const left = Math.max(0, topUpDay.cap - topUpDay.used);
    topUp = Math.min(refill - room + topUp, left);
    refill = room;
  }
  const today = (filedPast) => (topUpDay ? { topupToday: { used: topUpDay.used + filedPast, cap: topUpDay.cap } } : {});
  if (!refill && !topUp) {
    const spent = topUpDay && topUpDay.used >= topUpDay.cap ? `; today's top-up (${topUpDay.cap}) is spent` : '';
    const r = { at: new Date().toISOString(), skipped: true, noop: true, why: `inbox full: ${have} open picks, target ${target}${spent}`, open: have, target, ...today(0) };
    log(r); return r;
  }
  const goal = Math.min(refill + topUp, maxFile);
  const tried = new Set();
  // STILL OPEN IS STILL A JOB (F-955). A posting first seen more than 45 days
  // ago that its board still lists was never offered: Amazon's Propulsion
  // Hardware role, GlobalFoundries' Fab Automation and Skyworks' Test
  // Engineer 2, all applied to by hand. Last, and only at his kind of employer:
  // a wider window at any employer is mostly the wrong work (F-955's 137 reads).
  const stages = [{ name: 'usual' }, { name: 'his employers, fit 55+', minFit: 55, newGradFit: 50, classes: ['star', 'name', 'role', 'vc'] },
    { name: 'his employers, still open after 45 days', days: 120, classes: ['star', 'name', 'role', 'vc'] },
    // The whole library, last (F-958): "the pool is empty" is a statement about
    // the read window above, never about the store.
    { name: 'library survivors', library: true }].filter((st) => (trigger ? !st.library && !st.days : refill || st.library));
  const kept = [], maybe = [];
  let read = 0, failed = 0;
  const failedWhy = {};
  // A SPENT MODEL ENDS THE WHOLE PASS (F-1040): it used to end one stage, and
  // the next stage asked the same spent model again.
  let stopped = '';
  let noBody = 0;   // postings left out of the queue until the enricher can read them (F-1040)
  for (const stage of stages) {
    if (stopped) break;
    while (kept.length + maybe.length < goal && read < maxRead) {
      const n = Math.min(batch, maxRead - read);
      const list = stage.library ? await library(dbPath, { limit: n, skip: tried, rescreen: !tried.size || !stage.screened }) : pool(dbPath, { limit: n, days, skip: tried, ...stage });
      noBody = Math.max(noBody, Number(list.unreadable) || 0);
      stage.screened = true;
      if (!list.length) break;
      for (const j of list) tried.add(j.id);
      // A library survivor is judged by the reader, employer included: taste
      // ranked it, the brief's bar 3 decides (it removed six good picks as a gate).
      const r = await run({ dbPath, candidates: list, taste: stage.library ? () => null : employerVerdict, force: true, limit: list.length, days, stopAfter: goal - kept.length - maybe.length });
      kept.push(...r.kept); maybe.push(...r.maybe);
      read += r.kept.length + r.maybe.length + r.dropped.length;
      failed += r.failed.length;
      // Why postings went unread, counted (the log said "67 not read" and nothing more, 2026-11-02).
      for (const f of r.failed) { const k = String(f.why || '').replace(/\s*\(.*$/, '').slice(0, 80); failedWhy[k] = (failedWhy[k] || 0) + 1; }
      const spent = r.failed.find((f) => /out of credit/i.test(f.why));
      if (spent) { stopped = spent.why; break; }
    }
  }
  const out = { at: new Date().toISOString(), open: have, goal, refill, topup: Math.max(0, kept.length + maybe.length - refill), read, filed: kept.length + maybe.length, kept: kept.length, maybe: maybe.length, failed, failedWhy,
    ...(stopped ? { stopped } : {}),
    ...(noBody ? { noBody } : {}),
    picks: [...kept, ...maybe].map((x) => `${x.verdict} ${x.company} — ${x.title}`) };
  Object.assign(out, today(out.topup));
  log(out);
  return out;
}

// THE COMMAND RUNS AFTER THIS MODULE HAS LOADED, NEVER AS ITS TOP-LEVEL AWAIT
// (F-986, 2026-11-04). The 6:30 AM run, the first with --topup, ended with
// "unsettled top-level await" and logged nothing: the top-up path loads
// library-screen.mjs, and the reader sponsor-prior.mjs, and both import this
// file back. While this file's top level was still awaiting the run, each of
// those loads waited for it to finish loading, and nothing was left running.
// main() is called without await, so the module is done loading first.
// curate-cli.test.mjs runs the real command to catch it again.
/** The outcome line for a run that died holding the lock, unless one with its pid is already the last line. */
export function staleLockLine(pid, { file = DAILY_LOG, now = new Date() } = {}) {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)); } catch { /* no log yet */ }
  if (last && Number(last.pid) === Number(pid)) return false;
  try { fs.appendFileSync(file, `${JSON.stringify({ at: now.toISOString(), error: `the previous run (pid ${pid}) ended without an outcome (killed)`, pid: Number(pid) })}\n`); } catch { return false; }
  return true;
}

const isMain = process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) main().catch((e) => { console.error(e?.stack || e); process.exit(1); });

async function main() {
  // --help RAN the curator (2026-11-03): with the inbox under target it would
  // have read postings and filed picks. The same guard as every command (F-163).
  const { guardArgs } = await import('./cli.mjs');
  guardArgs({
    usage: `  node jarvis/curate.mjs [--limit N] [--target N] [--days N] [--force] [--dry-run]
  node jarvis/curate.mjs --daily [--want N] [--target N] [--max-read N] [--topup]
  node jarvis/curate.mjs --daily --trigger <why> --max-file N --days N   the dashboard's read of new postings (C)
  node jarvis/curate.mjs --renote    write a reason on every inbox card that has none (reads only; moves nothing)

  Read new postings in full and file the ones that fit to his inbox. --daily is
  the scheduled search: the usual window, his employers, older open postings,
  then the whole-library screen's survivors, until --want are filed or the
  inbox reaches --target.`,
    flags: ['--daily', '--want', '--target', '--max-read', '--limit', '--days', '--force', '--dry-run', '--topup', '--renote', '--trigger', '--max-file'],
    valued: ['--want', '--target', '--max-read', '--limit', '--days', '--trigger', '--max-file'],
  });
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  if (process.argv.includes('--renote')) {
    const r = await renote();
    console.log(`${r.asked} card(s) with no reason; ${r.written} written again${r.unread ? `, ${r.unread} could not be read` : ''}`);
    for (const x of r.rows) console.log(`  ${x.verdict.padEnd(5)} ${x.company} — ${x.title}`);
    process.exit(0);
  }
  if (process.argv.includes('--daily')) {
    // ONE DAILY SEARCH AT A TIME (2026-11-02). The dashboard's run and one
    // started by hand read the same postings a minute apart, paying twice, and
    // one turned down the other's pick. A lock held by a live process is
    // WAITED FOR, up to 20 minutes (daily-lock.mjs); a trigger does not wait.
    // Either way a run that cannot start writes a skipped line. A stale lock
    // (the process is gone) is taken over.
    const { dailyLockPath, takeDailyLock, SKIPPED_FOR_LOCK } = await import('./daily-lock.mjs');
    const lockFile = dailyLockPath(DATA_DIR);
    const trigger0 = arg('trigger', '');
    const lock = await takeDailyLock(lockFile, { trigger: !!trigger0 });
    if (!lock.ok) {
      const line = { at: new Date().toISOString(), skipped: true, why: `lock held by pid ${lock.held}: another daily search is running`, heldBy: lock.held, ...(trigger0 ? { trigger: trigger0 } : {}) };
      try { fs.appendFileSync(DAILY_LOG, `${JSON.stringify(line)}\n`); } catch { /* stdout still says it */ }
      console.log(`another daily search is running (pid ${lock.held}) — ${trigger0 ? 'trigger skipped' : 'waited 20 min; not starting a second'}.`);
      process.exit(trigger0 ? SKIPPED_FOR_LOCK : 0);
    }
    // A DEAD RUN'S LOCK IS REPORTED BEFORE IT IS TAKEN OVER (F-986 follow-up).
    // A hard kill (the memory reaper, 2026-11-04 9:34) runs no exit handler, so
    // the lock is the only trace it leaves. daily-search.ps1's backstop line
    // carries the same pid when it got to write one; then nothing is added.
    if (lock.stale) staleLockLine(lock.stale);
    // EVERY RUN LEAVES AN OUTCOME LINE (F-986). A run that crashed, or whose
    // event loop emptied mid-run, used to leave curate-daily.jsonl silent, and
    // the health alarm read the last good run. Now it writes { error, code }.
    let logged = false;
    const outcome = (e) => { logged = true; try { fs.appendFileSync(DAILY_LOG, `${JSON.stringify(e)}\n`); } catch { /* the stdout log still has it */ } };
    const failed = (error, code) => { if (!logged) outcome({ at: new Date().toISOString(), error: String(error).slice(0, 300), code }); };
    process.on('exit', (code) => {
      failed(code ? `the run exited with code ${code} before it finished` : 'the run stopped before it finished: nothing was left running while it waited', code);
      try { if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.unlinkSync(lockFile); } catch { /* gone */ }
    });
    let r, topUp = 0;
    try {
      // --topup: the scheduled runs only (daily-search.ps1), at his setting.
      const { readSettings } = await import('./settings.mjs');
      const perRun = readSettings().dailyTopUp;
      const trigger = arg('trigger', '');
      // A trigger draws on the day's shared top-up as a scheduled run does (its own cap is --max-file).
      topUp = process.argv.includes('--topup') ? perRun : trigger ? 2 * perRun : 0;
      // Every daily run is bounded by the day's shared allowance past target, top-up or not.
      let lines = [];
      try { lines = fs.readFileSync(DAILY_LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }); } catch { /* no log yet */ }
      const topUpDay = topUpToday(lines, { cap: 2 * perRun });
      r = await daily({ want: Number(arg('want', 20)), target: Number(arg('target', 50)), topUp, topUpDay, maxRead: Number(arg('max-read', 300)), log: outcome,
        ...(trigger ? { trigger, maxFile: Math.max(0, Number(arg('max-file', 10)) || 10), days: Math.max(1, Number(arg('days', 3)) || 3) } : {}) });
    } catch (e) {
      failed(`the run crashed: ${e?.message || e}`, 1);
      console.error(e?.stack || e);
      process.exit(1);
    }
    if (r.skipped) console.log(`${r.open} open picks already (target ${r.target}) — nothing to do.`);
    else console.log(`daily search: ${r.open} open, goal ${r.goal}${r.topup || topUp ? ` (top-up ${topUp}: ${r.topup} filed)` : ''}; read ${r.read}, filed ${r.filed} (${r.kept} kept, ${r.maybe} worth a look)${r.failed ? `, ${r.failed} not read (${Object.entries(r.failedWhy || {}).map(([k, n]) => `${n}: ${k}`).join('; ')})` : ''}${r.noBody ? `; ${r.noBody} wait for a body the enricher cannot fetch yet` : ''}${r.stopped ? `\n  STOPPED: ${r.stopped}` : ''}\n  ${r.picks.join('\n  ')}`);
    process.exit(0);
  }
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
