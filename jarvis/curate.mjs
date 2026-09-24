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
// Usage: node jarvis/curate.mjs [--limit 30] [--target 50] [--dry-run] [--force]

import fs from 'node:fs';
import path from 'node:path';
import { openDb, readDescription } from './db.mjs';
import { loadCandidates, rank, approve } from './picks.mjs';
import { run } from './tailor-llm.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const DB_PATH = path.join(ROOT, 'data', 'jarvis', 'jobs.db');
const LOG_PATH = path.join(ROOT, 'data', 'jarvis', 'curate-log.jsonl');

/**
 * Titles that fail his standing rules on their face; not worth a model call.
 * NOT "II" or "2": he has applied to six "Engineer II" roles (AMAT, Lam, Amazon)
 * and a level number is not a years requirement — the reader decides those.
 */
export const TITLE_OUT = /\b(senior|sr\.?|staff|principal|manager|director|head of|intern(ship)?|co-?op|technician|operator|assembler|machinist|apprentice|night|graveyard|3rd shift|third shift)\b|\b(III|IV)\b|\bengineer\s+[3-5]\b/i;

/** How many postings he already has open to work from. */
export function openPicks(db) {
  return db.prepare(`SELECT count(*) AS n FROM jobs WHERE status IN ('inbox','interested')
    AND applied_at IS NULL AND gone_at IS NULL`).get().n;
}

/**
 * Employers he has already turned down as employers: any posting he hid with
 * "Company not interesting" (2026-09-24: Virtual Incision, Seek Thermal and
 * HaloBraid, all from the hand-curated list that night). One such hide speaks
 * for the company; it is not asked again.
 */
export function notInterestingCompanies(file = path.join(ROOT, 'data', 'jarvis', 'skip-reasons.jsonl')) {
  const out = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if ((e.reasons || []).some((r) => /company not interesting/i.test(String(r))) && e.company) out.add(String(e.company).toLowerCase().trim());
    }
  } catch { /* no reasons recorded yet */ }
  return out;
}

/** The screen's survivors, best first, that nobody has read yet. */
export function unread(dbPath = DB_PATH, { limit = 30, skipCompanies = notInterestingCompanies() } = {}) {
  const rows = loadCandidates(dbPath, { minFit: 70, days: 45 });
  const r = rank(rows, { limit: 5000, perCompany: 4 });
  return r.picks
    .filter((j) => j.where !== 'elsewhere' && !TITLE_OUT.test(String(j.title || ''))
      && !skipCompanies.has(String(j.company || '').toLowerCase().trim()))
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
    return db.prepare(`SELECT title, status FROM jobs WHERE lower(company) = lower(?) AND id <> ?
      AND (applied_at IS NOT NULL OR status IN ('applied','inbox','interested','rejected','hidden'))
      ORDER BY status_changed_at DESC LIMIT 25`).all(String(job.company || ''), String(job.id || ''))
      .map((r) => `${r.title} [${r.status}]`);
  } catch { return []; }
}

export function promptFor(job, description, cvShort, prior = []) {
  return `You are curating job postings for Alex Rivera. Read the ENTIRE description below and decide.

HIS FACTS (the only facts you may use about him):
${cvShort}
Status: F-1 student, will need OPT then H-1B sponsorship. Graduates May 2027, can start June 2027.

BOTH BARS MUST HOLD FOR KEEP:
1. Qualified as written.
   - Degree: Bachelor's in Mechanical, or "Engineering" / "a related technical field" generally, passes. If it lists only other disciplines (Electrical, Chemical, Computer, CS, Materials, Physics) with no mechanical and no general engineering: DROP. Master's/PhD required: DROP.
   - Years: "0", "0-2", new grad, entry level, "internships/co-ops count" pass. A REQUIRED "1+", "2+", "1-3" or more: DROP. Preferred years are fine.
   - A graduation window excluding May 2027: DROP. Internships and co-ops: DROP.
2. Relevant: semiconductor/semicap, robotics and automation, medical devices, EV/battery/energy hardware, or high-tech manufacturing, AND the work is mechanical, manufacturing, equipment, process, test or automation engineering. DROP electrical/circuit/PCB, firmware, software, IT, pure chemistry, HVAC/MEP/building, civil/construction, oil & gas, facilities/compliance desks, sales.
Also DROP: night/graveyard/3rd shift, compressed 12-hour or weekend-only schedules; security clearance; U.S. citizenship required with no license alternative; "will not sponsor"; defense or weapons; spacecraft, satellites, launch vehicles.
NOT a drop, just a caution to quote: export-control language that allows a license.
MAYBE (not KEEP): 2nd shift, heavy travel, quality engineer, field service, applications engineer, industrial engineer, sustaining, or a real doubt you can name.

ALREADY AT THIS COMPANY (applied, in his list, rejected or hidden): ${prior.length ? prior.join('; ') : 'nothing'}
The same or nearly the same title already on that list: DROP, and say which.

POSTING: ${job.company} — ${job.title} — ${job.location || ''}
---
${String(description || '').slice(0, 14000)}
---

Answer with ONE line of JSON and nothing else:
{"verdict":"KEEP"|"MAYBE"|"DROP","why":"<the deciding fact, one line>","note":"<KEEP/MAYBE only: two plain sentences for his card. First: the concrete overlap with his experience above. Second: why he can win it, quoting the posting's years or new-grad words. For MAYBE start with the catch. No hype.>"}`;
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
  // Sonnet reads; a spent Sonnet ends the run rather than handing the reading
  // to something weaker (his rule for writers, 2026-09-16: never Opus, and the
  // judgement here is the whole product).
  const out = await run('claude', ['-p'], { input: prompt, timeout: 180_000, models: ['sonnet'] });
  return out.stdout;
}

/**
 * One run. `ask` and `file` are injectable so the tests never call a model or
 * write the store.
 */
export async function curate({ dbPath = DB_PATH, limit = 30, target = 50, force = false, dryRun = false,
  ask = askModel, file = approve, log = (e) => fs.appendFileSync(LOG_PATH, `${JSON.stringify(e)}\n`), root = ROOT,
  candidates = null, readDesc = readDescription } = {}) {
  const db = openDb(dbPath);
  const open = openPicks(db);
  if (!force && open >= target) { db.close?.(); return { skipped: true, open, target, kept: [], maybe: [], dropped: [], failed: [] }; }
  const want = force ? limit : Math.min(limit, Math.max(10, (target - open) * 3));
  const cands = candidates || unread(dbPath, { limit: want });
  const cv = facts(root);
  const kept = [], maybe = [], dropped = [], failed = [];
  for (const j of cands) {
    let desc = '';
    try { desc = readDesc(db, j.id) || ''; } catch { desc = ''; }
    if (desc.length < 400) { failed.push({ id: j.id, why: 'no description to read' }); continue; }
    let v = null;
    try { v = parseVerdict(await ask(promptFor(j, desc, cv, priorAt(db, j)))); } catch (e) {
      if (/out of credit/i.test(String(e?.message))) { failed.push({ id: j.id, why: 'model out of credit — run stopped' }); break; }
      failed.push({ id: j.id, why: String(e?.message || e).slice(0, 120) });
      continue;
    }
    if (!v) { failed.push({ id: j.id, why: 'unreadable verdict' }); continue; }
    const row = { id: j.id, company: j.company, title: j.title, ...v };
    (v.verdict === 'KEEP' ? kept : v.verdict === 'MAYBE' ? maybe : dropped).push(row);
    log({ at: new Date().toISOString(), ...row });
  }
  db.close?.();
  if (!dryRun) {
    const notes = {};
    for (const r of kept) notes[r.id] = r.note;
    for (const r of maybe) notes[r.id] = /^worth a look/i.test(r.note) ? r.note : `Worth a look: ${r.note}`;
    if (Object.keys(notes).length) file(Object.keys(notes), notes, { dbPath });
    // Read and turned down: the reason stays on the row and the screen skips it.
    const why = {};
    for (const r of dropped) why[r.id] = `read by the daily curation — ${r.why}`;
    if (Object.keys(why).length) file(Object.keys(why), why, { dbPath, undo: true });
  }
  return { skipped: false, open, target, read: cands.length, kept, maybe, dropped, failed };
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const r = await curate({
    limit: Number(arg('limit', 30)), target: Number(arg('target', 50)),
    force: process.argv.includes('--force'), dryRun: process.argv.includes('--dry-run'),
  });
  if (r.skipped) console.log(`${r.open} open picks already (target ${r.target}) — nothing to do. --force reads anyway.`);
  else {
    console.log(`read ${r.read}: ${r.kept.length} kept, ${r.maybe.length} worth a look, ${r.dropped.length} turned down${r.failed.length ? `, ${r.failed.length} not read` : ''}`);
    for (const x of [...r.kept, ...r.maybe]) console.log(`  ${x.verdict.padEnd(5)} ${x.company} — ${x.title}`);
    for (const x of r.failed) console.log(`  not read ${x.id}: ${x.why}`);
  }
}
