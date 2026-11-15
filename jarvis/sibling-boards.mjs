// jarvis/sibling-boards.mjs — an employer's SECOND board, where the new-grad roles live.
//
// Employers run separate early-career boards on the same ATS: Astera Labs
// tracks "asteralabs" on Greenhouse (156 postings), while its new-grad roles
// sit on "asteraearlycareer2027" ("Astera Labs Early Career - North America
// 2027", 93 postings, NCG roles among them). The coverage meter found two of
// them missing (2026-11-03). Nothing looked for a sibling board, because the
// employer was already "tracked".
//
// For each tracked Greenhouse or Ashby board, the name's first word and the
// tracked token are tried with early-career words (earlycareer(s), university,
// campus, newgrad(s), students, graduates, emergingtalent), with and without
// this year and next. A sibling counts only if it answers with postings and its
// board names the employer: Greenhouse's board name ("Astera Labs Early
// Career…"), or an Ashby board whose token starts with the tracked one. That
// rules out a look-alike token belonging to another company. A found board is
// written through discovery's own writer (appendToPortals: never a name or URL
// already there) with `company:` set to the employer, so the scanner files its
// rows under that employer and his hidden-company and employer rules still
// apply. Each employer is asked again only after 30 days (sibling-boards.json).
//
// Usage:
//   node jarvis/sibling-boards.mjs [--write] [--limit 40] [--only "Astera Labs"]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { guardArgs } from './cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORTALS = path.join(ROOT, 'portals.yml');
const STATE = path.join(ROOT, 'data', 'jarvis', 'sibling-boards.json');
const DAY = 86_400_000;
const WORDS = ['earlycareer', 'earlycareers', 'university', 'campus', 'newgrad', 'newgrads', 'students', 'graduates', 'emergingtalent'];

/** The tokens to try for one tracked board. */
export function siblingCandidates(token, name, year = new Date().getFullYear()) {
  const first = String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/)[0] || '';
  const roots = [...new Set([String(token || '').toLowerCase(), first].filter((r) => r.length >= 3))];
  const out = new Set();
  // A year rides only on the words boards date ("asteraearlycareer2027"): about 30 tries an employer, not 54.
  const DATED = new Set(['earlycareer', 'university', 'newgrad']);
  for (const r of roots) for (const w of WORDS) for (const y of (DATED.has(w) ? ['', String(year), String(year + 1)] : [''])) out.add(`${r}${w}${y}`);
  out.delete(String(token || '').toLowerCase());
  return [...out];
}

/** Does a Greenhouse board's own name belong to this employer? */
// Whole words, not substrings (review, 2026-11-03): "Arm" must not match an
// "Armada" board, nor "Ion" an "Ionic" one.
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
// The board's own words must be the employer's, with only early-career and
// board words around them (review, 2026-11-03): "Morse Micro Systems Jobs" is
// another company than "Morse Micro".
const LEGAL = /^(inc|corp|corporation|llc|ltd|plc|the|and|company|co)$/;
const FILLER = /^(jobs?|careers?|early|university|universities|campus|new|grads?|graduates?|students?|emerging|talent|programs?|recruiting|hiring|internships?|interns?|north|america|americas|us|usa|global|\d{4})$/;
export function namesEmployer(boardName, employer) {
  const want = words(employer).filter((w) => !LEGAL.test(w));
  const got = words(boardName).filter((w) => !LEGAL.test(w) && !FILLER.test(w));
  return want.length > 0 && want.length === got.length && want.every((w, i) => got[i] === w);
}

/** Tracked Greenhouse / Ashby boards from portals.yml: { name, ats, token }. */
export function trackedBoards(entries) {
  const out = [];
  for (const e of entries || []) {
    if (!e || e.enabled === false) continue;
    const u = `${e.careers_url || ''} ${e.api || ''}`;
    let m;
    if ((m = u.match(/greenhouse\.io\/(?:v1\/boards\/)?([\w-]+)/i))) out.push({ name: e.name, company: e.company || e.name, ats: 'greenhouse', token: m[1].toLowerCase() });
    else if ((m = u.match(/jobs\.ashbyhq\.com\/([^/?#\s]+)/i))) out.push({ name: e.name, company: e.company || e.name, ats: 'ashby', token: decodeURIComponent(m[1]) });
  }
  return out;
}

// An honest name, the enricher's (review, 2026-11-03). A 429 or 403 stops
// this run for that ATS: the boards are asked again next week, never pressed.
const UA = 'Jarvis-Jobs/1.0 (personal job search; one posting at a time)';
export class Refused extends Error {}
async function getText(url, accept) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept, 'user-agent': UA } });
  if (r.status === 429 || r.status === 403) throw new Refused(`HTTP ${r.status}`);
  return r.ok ? r.text() : null;
}
async function getJson(url) {
  const t = await getText(url, 'application/json');
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}

/** One candidate: { token, count, boardName } when it is this employer's live board, else null. */
async function probe(b, token) {
  if (b.ats === 'greenhouse') {
    const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}`);
    if (!meta?.name || !namesEmployer(meta.name, b.company)) return null;
    const jobs = await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
    const count = jobs?.jobs?.length || 0;
    return count ? { token, count, boardName: meta.name } : null;
  }
  if (b.ats === 'ashby') {
    // Proof, not a prefix (review): the board page's own title names the
    // employer ("<title>Morse Micro Jobs</title>").
    const j = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`);
    const count = j?.jobs?.length || 0;
    if (!count) return null;
    const html = await getText(`https://jobs.ashbyhq.com/${encodeURIComponent(token)}`, 'text/html');
    const title = (String(html || '').match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return namesEmployer(title, b.company) ? { token, count, boardName: title.replace(/\s*Jobs\s*$/i, '').trim() || token } : null;
  }
  return null;
}

/** A portals.yml entry for a sibling board, filed under its employer. */
export function siblingEntry(b, hit) {
  const careers = b.ats === 'greenhouse' ? `https://job-boards.greenhouse.io/${hit.token}` : `https://jobs.ashbyhq.com/${hit.token}`;
  const lines = [`  - name: ${JSON.stringify(`${b.company} (${hit.boardName.replace(/^.*?(early career|university|campus|new ?grad|students|graduates|emerging talent)/i, '$1').slice(0, 60) || 'early career'})`)}`,
    `    company: ${JSON.stringify(b.company)}`, `    careers_url: ${careers}`];
  if (b.ats === 'greenhouse') lines.push(`    api: https://boards-api.greenhouse.io/v1/boards/${hit.token}/jobs`);
  lines.push(`    notes: ${JSON.stringify(`Second board of ${b.company} ("${hit.boardName}", ${hit.count} postings), found by sibling-boards.mjs.`)}`, '    enabled: true');
  return lines.join('\n');
}

async function main() {
  const USAGE = '  node jarvis/sibling-boards.mjs [--write] [--limit N] [--only "<employer>"]\n\n  Look for tracked employers\' separate early-career boards on Greenhouse and Ashby; with --write, track each one found.';
  guardArgs({ usage: USAGE, flags: ['--write', '--limit', '--only'], valued: ['--limit', '--only'] });
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 40;
  const only = argv.includes('--only') ? String(argv[argv.indexOf('--only') + 1]).toLowerCase() : '';
  const cfg = yaml.load(readFileSync(PORTALS, 'utf8')) || {};
  const tracked = trackedBoards(cfg.tracked_companies);
  const have = new Set(tracked.map((b) => `${b.ats}/${b.token.toLowerCase()}`));
  let state = {};
  try { state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}; } catch { state = {}; }
  const due = tracked.filter((b) => (only ? b.company.toLowerCase() === only || b.name.toLowerCase() === only : Date.now() - Date.parse(state[`${b.ats}/${b.token}`] || 0) > 30 * DAY))
    .sort((a, b) => Date.parse(state[`${a.ats}/${a.token}`] || 0) - Date.parse(state[`${b.ats}/${b.token}`] || 0))
    .slice(0, limit);
  const found = [];
  const stopped = new Set();
  for (const b of due) {
    if (stopped.has(b.ats)) continue;
    let finished = true;
    for (const t of siblingCandidates(b.token, b.company)) {
      if (have.has(`${b.ats}/${t}`)) continue;
      let hit = null;
      try { hit = await probe(b, t); } catch (e) {
        if (e instanceof Refused) { stopped.add(b.ats); finished = false; console.log(`  ⚠ ${b.ats} refused us (${e.message}) — not asked again this run`); break; }
      }
      if (hit) { found.push({ b, hit }); have.add(`${b.ats}/${t}`); console.log(`  ✓ ${b.company}: ${b.ats}/${t} — "${hit.boardName}", ${hit.count} postings`); }
      await new Promise((r) => setTimeout(r, 300));
    }
    // An employer cut short by a refusal is asked again next run, not in 30 days.
    if (finished) state[`${b.ats}/${b.token}`] = new Date().toISOString();
  }
  console.log(`${due.length} tracked board(s) asked; ${found.length} sibling board(s) found.`);
  if (write) {
    if (found.length) {
      // The resolver's own lock (review, 2026-11-03): a resolve run writing
      // portals.yml at the same moment is waited out, up to ten minutes.
      const { takeLock } = await import('./universe.mjs');
      let locked = false;
      for (let i = 0; i < 20 && !(locked = takeLock()); i++) await new Promise((r) => setTimeout(r, 30_000));
      if (!locked) {
        // The employers asked are still asked; only the boards found wait (review).
        for (const { b } of found) delete state[`${b.ats}/${b.token}`];
        writeFileSync(STATE, JSON.stringify(state, null, 1));
        console.log('  a resolve run holds portals.yml; progress saved, and the employers with boards found are asked again next run');
        return;
      }
      const { appendToPortals } = await import('./discover-ats.mjs');
      const r = appendToPortals(found.map(({ b, hit }) => siblingEntry(b, hit)).join('\n\n'));
      console.log(`  portals.yml: ${r.written.length} written${r.refused.length ? `, ${r.refused.length} already there` : ''}`);
    }
    writeFileSync(STATE, JSON.stringify(state, null, 1));
  } else if (found.length) console.log('(dry run — re-run with --write to track them)');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
