/**
 * WHERE EACH RUN'S TIME WENT, KEPT (S6, 2026-11-07).
 *
 * Every fill reports its phases with /api/filled: the worker's setup (inject),
 * reading the page (discover), waiting for the plan, the written answers, the
 * resume, the dropdowns, the experience entries, and the fixed waits (which
 * overlap the phases they sit in). Kept so the slow part of HIS machine is
 * measured before any wait is cut (S5). Phase names and whole milliseconds
 * only — never the page, the employer or an answer — checked again here, not
 * trusted from the sender.
 */
import { appendFileSync, existsSync, renameSync, statSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMING_PHASES = ['total', 'inject', 'discover', 'plan', 'answers', 'resume', 'dropdowns', 'entries', 'waits'];
const WORDS = { total: 'total', inject: 'setup', discover: 'reading', plan: 'plan', answers: 'answers', resume: 'resume', dropdowns: 'dropdowns', entries: 'experience/education', waits: 'fixed waits' };
const MAX_BYTES = 5 * 1024 * 1024;

/** Known phase names with whole ms under a day; the slowest named phase; hidden. Anything else is dropped. */
export function cleanTimings(t) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of TIMING_PHASES) { const v = Number(t[k]); if (Number.isFinite(v) && v >= 0 && v < 86_400_000) out[k] = Math.round(v); }
  if (TIMING_PHASES.includes(t.slowest) && t.slowest !== 'total') out.slowest = t.slowest;
  if (t.hidden === true) out.hidden = true;
  const sites = cleanSites(t.waitSites);
  if (sites.length) out.waitSites = sites;
  if (typeof t.v === 'string' && /^\d+(\.\d+){1,3}$/.test(t.v)) out.v = t.v;
  return Object.keys(out).some((k) => TIMING_PHASES.includes(k)) ? out : null;
}

/**
 * WHICH WAIT IT WAS (S5, 2026-11-12): up to twelve [line of content.js, ms spent,
 * ms asked, times, ms spent hidden]. Whole numbers under a day; anything else dropped.
 */
export function cleanSites(sites) {
  if (!Array.isArray(sites)) return [];
  return sites.filter((s) => Array.isArray(s) && s.length === 5 && s.every((x) => Number.isFinite(Number(x)) && Number(x) >= 0 && Number(x) < 86_400_000) && Number(s[0]) >= 1 && Number(s[0]) < 100_000)
    .slice(0, 12).map((s) => s.map((x) => Math.round(Number(x))));
}

/**
 * Every kept run's waits, added up by line of content.js and extension version:
 * which waits cost the most, how far over their asked length they ran, and how
 * much of it was a hidden tab. 'node jarvis/run-timings.mjs --waits'.
 */
export function waitReport(rows) {
  const by = new Map();
  let runs = 0;
  for (const r of rows) {
    const sites = cleanSites(r.waitSites);
    if (!sites.length) continue;
    runs += 1;
    for (const [line, spent, asked, n, hidden] of sites) {
      const k = (r.v || '?') + ':' + line;
      const a = by.get(k) || { v: r.v || '?', line, spent: 0, asked: 0, n: 0, hidden: 0, runs: 0 };
      a.spent += spent; a.asked += asked; a.n += n; a.hidden += hidden; a.runs += 1;
      by.set(k, a);
    }
  }
  return { runs, sites: [...by.values()].sort((a, b) => b.spent - a.spent) };
}

/** "run timing: total 7.9 s · setup 0.4 · reading 0.6 · … · slowest: dropdowns". */
export function timingLine(t) {
  const c = cleanTimings(t);
  if (!c) return '';
  const s = (ms) => (ms / 1000).toFixed(1);
  const parts = TIMING_PHASES.filter((k) => k in c).map((k) => `${WORDS[k]} ${s(c[k])}${k === 'total' ? ' s' : ''}`);
  const waits = (c.waitSites || []).slice(0, 3).map(([line, spent, asked, n]) => `line ${line} ${s(spent)} s/${n}x (asked ${s(asked)})`);
  return `run timing: ${parts.join(' · ')}${c.slowest ? ` · slowest: ${WORDS[c.slowest]}` : ''}${c.hidden ? ' (tab hidden)' : ''}${waits.length ? ` · longest waits: ${waits.join(', ')}` : ''}`;
}

/** One line per run in `file` (rotated at 5 MB to .1). Returns the line kept, or null. */
export function keepTimings(file, t, now = Date.now()) {
  const c = cleanTimings(t);
  if (!c) return null;
  const row = { at: new Date(now).toISOString(), ...c };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      // The old rotation goes first (review): on Windows a rename onto an
      // existing file can fail, and every later rotation with it.
      const older = file.replace(/\.jsonl$/, '.1.jsonl');
      rmSync(older, { force: true });
      renameSync(file, older);
    }
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return row;
  } catch { return null; }
}

// node jarvis/run-timings.mjs --waits [file]: which waits his runs spent the most on (S5).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--waits')) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'jarvis', 'run-timings.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const { runs, sites } = waitReport(rows);
  const s = (ms) => (ms / 1000).toFixed(1);
  console.log(runs + ' of ' + rows.length + ' runs name their waits (1.150.14 and later).');
  for (const a of sites.slice(0, 25)) console.log('  ' + a.v + ' line ' + a.line + ': ' + s(a.spent) + ' s in ' + a.n + ' waits over ' + a.runs + ' runs; asked ' + s(a.asked) + ' s; ' + s(a.hidden) + ' s with the tab hidden');
}
