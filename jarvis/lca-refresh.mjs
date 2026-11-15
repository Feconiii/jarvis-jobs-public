#!/usr/bin/env node
// jarvis/lca-refresh.mjs — keep the H-1B record current (F-984, 2026-11-04).
//
// The Department of Labor publishes the LCA disclosure file each quarter, and
// dol.gov refuses every non-browser request, so the file has to come through
// his browser. This does the rest, from the daily pass:
//
//   · a disclosure file in his Downloads newer than the one loaded is imported
//     (lca-import.mjs, the existing path) and the ledger reseeded from it
//     (universe.mjs seed --lca --store), so curate.h1bPetitions reads it too;
//   · otherwise, on Sundays, today's companies are linked again to the file
//     already loaded (lca-import --relink): the store gains employers every day;
//   · and when the next quarter's file is due and not loaded, it says so (the
//     Inbox strip shows the same line, search-status.mjs).
//
//   node jarvis/lca-refresh.mjs [--relink] [--dry-run]

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** { fy, q } from "LCA_Disclosure_Data_FY2026_Q3.xlsx", or null. */
export function parseLabel(name) {
  const m = String(name || '').match(/LCA_Disclosure_Data_FY(\d{4})_Q([1-4])/i);
  return m ? { fy: Number(m[1]), q: Number(m[2]) } : null;
}

const order = (l) => (l ? l.fy * 4 + l.q : 0);

/** The newest disclosure file in `files` that is newer than `loaded`, or null. */
export function newerFile(files, loaded) {
  const best = files.map((f) => ({ f, l: parseLabel(path.basename(f)) })).filter((x) => x.l && order(x.l) > order(loaded))
    .sort((a, b) => order(b.l) - order(a.l))[0];
  return best ? best.f : null;
}

/**
 * When the quarter after `loaded` should be out: the federal fiscal year starts
 * in October, so FY2026 Q4 ends 2026-09-30; DOL has published within about
 * 75 days of a quarter's end.
 */
export function nextDue(loaded) {
  if (!loaded) return null;
  const n = loaded.q === 4 ? { fy: loaded.fy + 1, q: 1 } : { fy: loaded.fy, q: loaded.q + 1 };
  // Quarter end: Q1 Dec 31 (of fy-1), Q2 Mar 31, Q3 Jun 30, Q4 Sep 30.
  const end = n.q === 1 ? new Date(Date.UTC(n.fy - 1, 11, 31)) : new Date(Date.UTC(n.fy, [0, 0, 2, 5, 8][n.q] + 1, 0));
  return { label: `FY${n.fy} Q${n.q}`, due: new Date(end.getTime() + 75 * 864e5) };
}

/** One sentence when the next quarter is overdue, else null. */
export function staleNotice(loaded, now = new Date()) {
  const n = nextDue(loaded);
  if (!n || now < n.due) return null;
  return `The H-1B disclosure data is FY${loaded.fy} Q${loaded.q}; ${n.label} was due ${n.due.toISOString().slice(0, 10)}. Download it from dol.gov (performance data) into Downloads and the next daily pass loads it.`;
}

/** Free memory an import needs before it starts (MB). */
export const MIN_FREE_MB = 1500;
export const enoughMemory = (free = os.freemem()) => free / 1048576 >= MIN_FREE_MB;

/** The label of the file the store holds, from lca_employers.source. */
export function loadedLabel(jobsDb) {
  try {
    const h = new DatabaseSync(jobsDb, { readOnly: true });
    try { return h.prepare('SELECT DISTINCT source FROM lca_employers').all().map((r) => parseLabel(r.source)).filter(Boolean).sort((a, b) => order(b) - order(a))[0] || null; }
    finally { h.close(); }
  } catch { return null; }
}

function main(argv) {
  const dry = argv.includes('--dry-run');
  const { dbPath } = { dbPath: path.join(process.env.JARVIS_DATA_DIR || path.join(HERE, '..', 'data', 'jarvis'), 'jobs.db') };
  const loaded = loadedLabel(dbPath);
  const downloads = path.join(os.homedir(), 'Downloads');
  let files = [];
  try { files = readdirSync(downloads).filter((f) => /^LCA_Disclosure_Data_FY\d{4}_Q[1-4].*\.xlsx$/i.test(f)).map((f) => path.join(downloads, f)).filter((f) => statSync(f).size > 1e6); } catch { files = []; }
  const fresh = newerFile(files, loaded);
  const node = (args) => spawnSync(process.execPath, args, { cwd: path.join(HERE, '..'), stdio: 'inherit' }).status;
  console.log(`H-1B data loaded: ${loaded ? `FY${loaded.fy} Q${loaded.q}` : 'none'}${fresh ? `; newer file found: ${path.basename(fresh)}` : ''}`);
  if (fresh) {
    if (dry) { console.log('  (dry run) would import it and reseed the ledger'); return 0; }
    // xlsx.mjs reads the file's shared-strings table whole, a few hundred MB on
    // a full year's file (review, 2026-11-04). On a laptop near its limit the
    // import waits for a later run rather than push it over.
    if (!enoughMemory()) { console.log(`  only ${Math.round(os.freemem() / 1048576)} MB free: the import waits for the next run (it needs about ${MIN_FREE_MB} MB)`); return 0; }
    if (node([path.join(HERE, 'lca-import.mjs'), fresh]) !== 0) return 1;
    return node([path.join(HERE, 'universe.mjs'), 'seed', '--lca', '--store']) || 0;
  }
  if (argv.includes('--relink')) {
    if (node([path.join(HERE, 'lca-import.mjs'), '--relink', ...(dry ? ['--dry-run'] : [])]) !== 0) return 1;
  }
  const stale = staleNotice(loaded);
  if (stale) console.log(`  ${stale}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
