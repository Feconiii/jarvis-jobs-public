// jarvis/employer-taste.mjs — his kind of employer and title, decided without a model (F-986 follow-up, 2026-11-04).
//
// Moved word for word out of curate.mjs, which re-exports all of it. The whole-
// library screen (library-screen.mjs) and the enricher need these, and taking
// them from curate.mjs made a loop: curate.mjs loads library-screen.mjs during
// a run, and library-screen.mjs imported curate.mjs back (F-986: with the run
// in curate.mjs's top-level await, each waited for the other forever). This file
// imports nothing that leads back to curate.mjs; curate-cli.test loads each
// module of the old loop first, in a fresh process.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { screen } from './targeting.mjs';
import { normCo, sameFiler } from './employer-names.mjs';
import { dolPetitions } from './sponsor-prior.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The store's folder, as curate.mjs reads it: JARVIS_DATA_DIR when set.
const DB_PATH = path.join(process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data', 'jarvis'), 'jobs.db');
const FRONTIER = screen.frontier;

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
  return TITLE_OUT.test(t) || (!!E2_OUT && E2_OUT.test(t) && !PROGRAM.test(t)) || subProcessOut(t);
}

/** A title centred on welding/joining as its one process (his rule, 2026-11-06); a multi-process title stays. */
export function subProcessOut(title) {
  const t = String(title || '');
  if (!screen.subProcessTitle || !screen.subProcessTitle.test(t)) return false;
  const broad = new Set((t.match(screen.broadProcessTitle || /$^/g) || []).map((w) => w.toLowerCase().slice(0, 5)));
  return broad.size < 2;
}

/**
 * AIM FOR THE STARS (2026-10-25). "a lot of these companies i legit dont want to
 * work for, i wanna aim for the damn stars": the inbox had 40 employers, Honda
 * with ten rows, because anywhere he had ever applied counted as his kind of
 * employer. His quiz answers the same day drew the line (the preset's
 * `bigNames` / `roleDecides` / `funded` say where): star and big-name employers
 * are filed, a conglomerate only when the role is cool, anyone else only when
 * its posting names top investors or big funding. Having applied somewhere no
 * longer qualifies it. Nothing is hidden by this: the rest stays in the library.
 *
 * 'any' when the preset has no taste gate (a second person's preset).
 */
export function employerClass(company) {
  if (!screen.starsOnly || !FRONTIER) return 'any';
  const c = String(company || '').toLowerCase().trim();
  if (screen.notHisKind && screen.notHisKind.test(c)) return 'out';
  if (FRONTIER.test(c)) return 'star';
  if (screen.bigNames && screen.bigNames.test(c)) return 'name';
  if (screen.roleDecides && screen.roleDecides.test(c)) return 'role';
  if (screen.backup && screen.backup.test(c)) return 'backup';
  // A KNOWN ROUND, NOT A LIST (F-948, his decision 2026-11-05): a startup on a
  // VC hiring list is not "big funding" by being there. Only the startups he
  // named as funded (fundedNames) are 'vc'; a listed one is judged like any
  // unknown startup, and passes only when its posting names the round or the
  // investors (fundedStartup).
  if (screen.fundedNames && screen.fundedNames.test(c)) return 'vc';
  return 'other';
}
export const CLASS_RANK = { any: 0, star: 0, name: 1, role: 2, vc: 2, other: 3, backup: 4, out: 5 };

/**
 * IS THIS STARTUP ON A PUBLISHED VC HIRING LIST? (Grace Gong's On My Radar, the
 * top-N startup lists: ledger sources 'radar' and 'startup-lists'.) From
 * 2026-11-01 a listed startup counted as funded. His decision 2026-11-05
 * (F-948) reverses that: being on a list is NOT big funding, only a known
 * funding round is. So employerClass no longer reads this. It stays as a
 * lookup for discovery and for anything that wants to say where a name came
 * from. Exact name only (no prefix match), so a list name never answers for a
 * different company that starts with it (F-947).
 */
let VC = null;
export function vcListed(company, rows = null) {
  if (!rows && VC === null) {
    try {
      const u = new DatabaseSync(path.join(ROOT, 'data', 'jarvis', 'universe.db'), { readOnly: true });
      VC = new Set(u.prepare("SELECT name FROM employers WHERE sources LIKE '%radar%' OR sources LIKE '%startup-lists%'").all()
        .map((r) => normCo(r.name).replace(/ /g, '')).filter((n) => n.length >= 3));
      u.close();
    } catch { VC = new Set(); }
  }
  const set = rows ? new Set(rows.map((r) => normCo(r.name).replace(/ /g, ''))) : VC;
  const c = normCo(company).replace(/ /g, '');
  return !!c && set.has(c);
}

/** An unknown employer passes only on its own posting's word: top investors or real money. */
export function fundedStartup(text) {
  return !!(screen.funded && screen.funded.test(String(text || '')));
}

/** Filed without the startup test (star, big name, conglomerate, backup). */
export function starEmployer(company) {
  return !['other', 'vc', 'out'].includes(employerClass(company));
}


/**
 * Certified H-1B engineering petitions on record for an employer, from the
 * coverage ledger (universe.db, the disclosure file). Every ledger row whose
 * name starts with the employer's name counts ("Honeywell" takes Honeywell
 * International and Honeywell Aerospace US). null when the ledger is missing.
 */
let LCA = null;
export function h1bPetitions(company, rows = null) {
  if (!rows && LCA === null) {
    try {
      // Read-only, and never through openDb: that writes the job store's schema
      // into whatever file it opens.
      const u = new DatabaseSync(path.join(ROOT, 'data', 'jarvis', 'universe.db'), { readOnly: true });
      LCA = u.prepare("SELECT name, evidence FROM employers WHERE sources LIKE '%lca%'").all().map((r) => ({ n: normCo(r.name), e: r.evidence || 0 }));
      u.close();
    } catch { LCA = []; }
  }
  const list = rows ? rows.map((r) => ({ n: normCo(r.name), e: r.evidence || 0 })) : LCA;
  if (!list.length) return null;
  const c = normCo(company);
  if (!c) return 0;
  return list.filter((r) => sameFiler(c, r.n)).reduce((a, r) => a + r.e, 0);
}

/**
 * THE TASTE RULE COUNTS THE DEPARTMENT'S OWN PETITIONS (his call, 2026-11-04).
 * h1bPetitions sums the ledger's `evidence`, which adds the store's posting
 * counts to the filings: HP Inc. read 738 there and American Honda 304, against
 * 7 and 4 engineering petitions certified (lca_employers.eng_certified over the
 * employer's own filers, sponsor-prior.dolPetitions, the count the card and the
 * reader already use). Only unread postings meet this rule; his applications
 * and the cards already in his inbox are not touched. No disclosure file loaded
 * (null) says nothing, as before.
 */
let DOL = null;
export const dolCount = (company) => (DOL ||= dolPetitions(DB_PATH))(company);

/**
 * Work he said he does not want, read off the title: { key, why, said } or
 * null. The preset's `notInterest` list (thermal, 2026-11-05). Every caller
 * that picks for him asks this: the curator before a read, the apply queue.
 */
export function interestOut(job, rules = screen.notInterest || []) {
  const title = String(job?.title || '');
  for (const r of rules) {
    if (r.title.test(title) && !(r.unless && r.unless.test(title))) return { key: r.key, why: r.why, said: r.said };
  }
  return null;
}

/** A posting that says it sponsors, in so many words. */
const SAYS_SPONSORS = /\b(will|can|does|do)\s+(?:provide\s+|offer\s+)?sponsor|\bsponsorship\s+(?:is\s+)?(?:available|provided|offered)|\bvisa\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered)|\bopen\s+to\s+sponsor/i;

/**
 * Why his kind of employer should not get this posting, or null. No model:
 * the class, the H-1B record and the title decide (his quiz, 2026-10-25).
 */
export function employerVerdict(job, text, { petitions = dolCount, postings = postingsAt } = {}) {
  const kind = employerClass(job.company);
  if (kind === 'any') return null;
  if (kind === 'out') return `${job.company} is an employer he ruled out (his taste quiz, 2026-10-25)`;
  if (screen.testRole && screen.testRole.test(String(job.title || ''))) return 'a test / validation / reliability role: he avoids test roles (2026-10-25)';
  if (kind === 'other' && !fundedStartup(text)) return NOT_HIS_KIND;
  if (['name', 'role', 'backup'].includes(kind) && screen.sponsorBar && !SAYS_SPONSORS.test(String(text || ''))) {
    // Measured against how much the company hires (first run, 2026-10-26):
    // Veeco's 11 petitions is a sponsor at its size, GE Vernova's 11 across
    // 5,220 postings is not. Zero means the disclosure file names it some
    // other way (onsemi files as Semiconductor Components Industries): unknown,
    // so the reader decides.
    const n = petitions(job.company);
    const size = postings(job.company);
    if (n) {
      const rate = size ? n / size : 1;
      if (n < 5 || rate < screen.sponsorBar / 2000) {
        return `a big name with almost no H-1B record (${n} engineering petitions on file against ${size} postings): likely will not sponsor, though the posting does not say so`;
      }
    }
  }
  return null;
}

/** How many postings the store holds for an employer (its hiring size). */
let SIZES = null;
export function postingsAt(company) {
  if (SIZES === null) {
    try {
      const d = new DatabaseSync(DB_PATH, { readOnly: true });
      SIZES = new Map(d.prepare('SELECT lower(trim(company)) c, count(*) n FROM jobs GROUP BY 1').all().map((r) => [r.c, r.n]));
      d.close();
    } catch { SIZES = new Map(); }
  }
  return SIZES.get(String(company || '').toLowerCase().trim()) || 0;
}

export const NOT_HIS_KIND = 'not a name he would want: no frontier or big-name employer, and the posting names no top investors or big funding (his taste quiz, 2026-10-25)';

/**
 * Employers he has capped. Tesla, 2026-10-01: 23 applications sent, his five
 * best fits kept, and no new Tesla role is filed without asking him first. The
 * curator files unattended, so it does not read them at all.
 */
export const CAPPED = screen.capped || null;
