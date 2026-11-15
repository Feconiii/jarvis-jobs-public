#!/usr/bin/env node
/**
 * THE GUARD AGAINST "THE LIBRARY IS DRY" (2026-11-03, F-958).
 *
 * He came up short at least nine times in seven weeks; six faults were fixed,
 * each tuned to one run, while the stop rule "the filtered pool is empty, so the
 * library is read out" never changed. This runs against his REAL store,
 * read-only (the screen's own cache, data/jarvis/screen.db, is the only write),
 * and fails unless:
 *
 *   1. every known-good posting (picks he was given after a full read) survives
 *      the deterministic screen, or waits only on a body;
 *   2. every known-bad posting (read and dropped on the posting's own words) is
 *      removed, for the stated reason;
 *   3. the removal table accounts for every open row (screened = sum of stages),
 *      and a run either has >= GOAL readable survivors or the table proves, rule
 *      by rule, that fewer exist — "waiting on a body" is printed as its own
 *      line, never folded into "exhausted".
 *
 * Usage: npm run jarvis:acceptance   (too heavy for jarvis:test: it reads ~1.0M rows)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, readDescription, getDictionary } from './db.mjs';
import { htmlToText } from './text.mjs';
import { loadPrefs } from './prefs.mjs';
import { screenRow, screenLibrary, removalTable, STAGES, DB_PATH } from './library-screen.mjs';

/** Read in full and filed on 2026-11-02; each must pass the screen. */
export const KNOWN_GOOD = {
  '05418fd550a1b5ab': 'Ford — Launch Process Engineer',
  '82617a79654478ff': 'First Solar — Engineer- Manufacturing I',
  'c5684a2dd54f222a': 'Intel — Oregon Advanced Packaging Module Engineer - Laser',
  '9ddf6a6277558f31': 'Amazon — Robotics Systems Engineer I, Tech Deployment (Seattle)',
  '040297a433c9aff5': 'Samsung — Metals Process Engineer',
  '5dc2967ee14a87cd': 'Re:Build — Entry Level Mechanical Engineer',
  '1eaaa64de43cda5b': 'Medra — Mechanical Engineer',
  '2f05e4048a4cc868': 'Ginkgo Bioworks — Mechatronics Engineer I',
  '7744fba3559e925a': 'Symbotic — New Grad Manufacturing Engineer',
  '56ded9f6dac35cd8': 'Peterbilt — Mechanical Engineer, Powertrain & Aftertreatment',
  'c08fa2e73e2f81df': 'Maven Robotics — Robotic System Integration Engineer',
  'e3d0cd9ba765ff66': 'Maven Robotics — Robot Field Engineer',
  '3e628b1722980659': 'Solcoa — Mechanical Engineer',
  'dccee658b3251fe3': 'Riverpoint Medical — Manufacturing Engineer I',
  '5be7a3360a81dc73': 'Allison Transmission — Associate Manufacturing Engineer',
  '8ec0e6d3503890f5': 'Geek+ — 2027 New Grad Associate Manufacturing Engineer',
  'b2393f5619bae3db': 'VulcanForms — Associate NPI Manufacturing Equipment Development Engineer',
  // Found LIVE on Micron's own Workday board by first mate's outside check
  // (2026-11-03, tasks/jarvis-coverage-gap.md): a fit the library must keep.
  '187fafc115b7463c': 'Micron — New College Grad Dry Etch Process Engineer (Boise)',
  '6433a588dce2df37': 'Micron — New College Grad Dry Etch Equipment Engineer (Boise)',
};

/** Read and dropped on the posting's own words on 2026-11-02; each must be removed for that reason. */
export const KNOWN_BAD = {
  '286470993373c475': ['years', 'ASM Engineer I, Mechanical Design: "3+ years of experience in mechanical design"'],
  '0f09f426a9501033': ['clearance', 'Regal Rexnord Design Engineer I: "U.S. Person"'],
  'bdf5b0132a7633a7': ['visa', 'Neogen Manufacturing Engineer I: will not sponsor'],
  'e4eef1ca60ef7a2d': ['years', 'TARGAN Manufacturing Engineer I: "Minimum of 2 years"'],
  // From the same outside check, on their own wording.
  '5327c441781994b4': ['years', 'Abbott Mechanical Engineer I: "Minimum 3 years" (its "Bachelors Degree (± 16 years)" is schooling)'],
  '301a1811a59d6f58': ['clearance', 'Antares Manufacturing Engineer I-II, Machining: ITAR'],
};

export const GOAL = 25;

/** Survivors whose row carries no reader verdict yet (still status new, no "Not curated" note). */
export function unreadSurvivors(dbPath = DB_PATH) {
  const screenPath = path.join(path.dirname(dbPath), 'screen.db');
  const s = new DatabaseSync(screenPath, { readOnly: true });
  const ids = s.prepare("SELECT id FROM verdicts WHERE verdict = 'survivor'").all().map((r) => r.id);
  s.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const q = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND status = 'new' AND (pick_note IS NULL OR pick_note NOT LIKE 'Not curated%')");
  const n = ids.filter((id) => q.get(id)).length;
  db.close();
  return n;
}

export function checkFixtures(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  const dict = getDictionary(db, 'description');
  const rules = (() => { try { return loadPrefs(); } catch { return null; } })();
  const hidden = new Set((() => { try { const r = db.prepare("SELECT v FROM meta WHERE k = 'hiddenCompanies'").get(); return r ? JSON.parse(r.v) : []; } catch { return []; } })().map((c) => String(c).toLowerCase().trim()));
  const get = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const fails = [];
  const judge = (id) => {
    const row = get.get(id);
    if (!row) return null;
    // A filed pick carries his note, not "Not curated"; its status is not 'new' — the screen does not read status.
    const text = htmlToText(readDescription(db, id, dict) || '');
    // Judged as if unread: a fixture tests the rules, not the read-before marker.
    return { row, v: screenRow({ ...row, pick_note: null }, text, { hidden, rules }) };
  };
  // The expected verdict is pinned per fixture (review, 2026-11-03): every
  // known-good posting is a readable survivor, not merely "not removed".
  for (const [id, name] of Object.entries(KNOWN_GOOD)) {
    const r = judge(id);
    if (!r) { fails.push(`known-good ${name} (${id}) is not in the store`); continue; }
    if (r.v.stage !== 'survivor') fails.push(`known-good ${name}: expected survivor, got ${r.v.stage} — ${r.v.reason}`);
  }
  for (const [id, [stage, name]] of Object.entries(KNOWN_BAD)) {
    const r = judge(id);
    if (!r) { fails.push(`known-bad ${name} (${id}) is not in the store`); continue; }
    if (r.v.verdict !== 'out') fails.push(`known-bad ${name} survived the screen`);
    else if (r.v.stage !== stage) fails.push(`known-bad ${name} was removed for ${r.v.stage}, expected ${stage} (${r.v.reason})`);
  }
  db.close?.();
  return fails;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let failed = 0;
  const fx = checkFixtures();
  console.log(`fixtures: ${Object.keys(KNOWN_GOOD).length} known-good, ${Object.keys(KNOWN_BAD).length} known-bad`);
  for (const f of fx) { console.log(`  ✗ ${f}`); failed += 1; }
  if (!fx.length) console.log('  ✓ every known-good posting survives; every known-bad one is removed for its reason');
  const res = screenLibrary({});
  console.log(removalTable(res));
  const sum = STAGES.reduce((a, k) => a + (res.counts[k] || 0), 0);
  if (sum !== res.open) { console.log(`  ✗ the table accounts for ${sum} of ${res.open} open rows`); failed += 1; }
  else console.log(`  ✓ every open row is accounted for (${sum.toLocaleString()})`);
  // THE PROOF BRANCH MUST BE A PROOF (review, 2026-11-03). Fewer than GOAL
  // readable survivors passes only when every one has been read (its verdict is
  // on the row) — the table then shows, rule by rule, that fewer exist. Unread
  // survivors are fits nobody looked for: that is a failure, whatever the count.
  const surv = res.counts.survivor || 0;
  const unread = unreadSurvivors();
  if (surv >= GOAL) console.log(`  ✓ ${surv} readable survivors >= ${GOAL}`);
  else if (unread === 0) console.log(`  ✓ fewer than ${GOAL} readable survivors (${surv}), every one read; ${(res.counts['waiting-body'] || 0).toLocaleString()} more wait on a body — not "exhausted"`);
  else { console.log(`  ✗ ${surv} survivors, ${unread} of them never read: the reader stopped before the library did`); failed += 1; }
  process.exit(failed ? 1 : 0);
}
