// Tests for board-links.mjs: a copied posting's link hands its board to the ledger.
// The shapes are the ones met on 2026-11-07: Resurgent Industries' Ashby board,
// which the resolver's name guesses missed because of the hyphen.

import { boardKeysIn, takenBoards, linkCandidates, resolveLinks, simplifyLinkRows, entryBlock, STORE_LINK_SQL, COPY_SOURCES, storeLinkRows, runLinks } from './board-links.mjs';
import { renderEntry } from './discover-ats.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const RESURGENT = 'https://jobs.ashbyhq.com/resurgent-industries/cf80a6e9-02db-4f0b-88cf-6bebd61fd3bf/application?embed=true';

console.log('\n🧪 board-links: the board a link names');
{
  check('an Ashby posting names its board, hyphen and all', boardKeysIn(RESURGENT), ['ashby:resurgent-industries']);
  check('a Workday posting names tenant, instance and site',
    boardKeysIn('https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers/job/Austin-TX/Mechanical-Engineer_R123').filter((k) => k.startsWith('workday:')),
    ['workday:acme.wd5/acmecareers']);
  check('a LinkedIn link names no board', boardKeysIn('https://www.linkedin.com/jobs/view/mechanical-engineer-at-arm-institute-4456902612'), []);
  check('boards already in portals.yml are known', takenBoards([{ name: 'X', careers_url: 'https://jobs.ashbyhq.com/resurgent-industries' }]).has('ashby:resurgent-industries'), true);
}

console.log('\n🧪 board-links: who is a candidate');
{
  const rows = [
    { company: 'Resurgent Industries', url: RESURGENT, via: 'simplify' },
    { company: 'Resurgent Industries', url: 'https://jobs.ashbyhq.com/resurgent-industries/other-id', via: 'simplify-list' },
    { company: 'Figure AI', url: 'https://boards.greenhouse.io/figureai/jobs/1', via: 'simplify' },
    { company: 'Newco Robotics', url: 'https://jobs.ashbyhq.com/figureai/2', via: 'simplify' },
    { company: 'Mach Industries', url: 'https://jobs.ashbyhq.com/mach/3', via: 'simplify' },
    { company: 'Gated Labs', url: 'https://jobs.lever.co/gatedlabs/4', via: 'simplify' },
    { company: 'Some Person', url: 'https://www.linkedin.com/jobs/view/5', via: 'linkedin' },
  ];
  const entries = [
    { name: 'Figure AI', careers_url: 'https://boards.greenhouse.io/figureai', enabled: true },
    { name: 'Other Figure', careers_url: 'https://jobs.ashbyhq.com/figureai', enabled: true },
    { name: 'Mach Industries', careers_url: 'https://jobs.ashbyhq.com/machindustries', enabled: false },
  ];
  const c = linkCandidates(rows, { entries, stateOf: (k) => (k === 'gatedlabs' ? 'gated' : '') });
  check('only the employer with an unread board is left', c.map((x) => x.name), ['Resurgent Industries']);
  check('…its two postings are counted, one board kept', [c[0].postings, c[0].boards], [2, ['ashby:resurgent-industries']]);
  check('…and where the links came from', c[0].via, 'simplify,simplify-list');
}

console.log('\n🧪 board-links: the clearance gate holds here too');
{
  // The resolver never tracks a gated employer (discover-ats.mjs isClearanceGated);
  // a posting link must not be a way round it, by name or by the board's slug.
  const rows = [
    { company: 'Anduril Industries', url: 'https://boards.greenhouse.io/andurilindustries/jobs/1', via: 'simplify' },
    { company: 'Overland', url: 'https://ats.rippling.com/overland-ai/jobs/2', via: 'linkedin' },
    { company: 'Longshot Space', url: 'https://jobs.ashbyhq.com/longshot/3', via: 'simplify' },
    { company: 'Stoke Space', url: 'https://jobs.ashbyhq.com/stoke-space/4', via: 'simplify' },
  ];
  const c = linkCandidates(rows, {});
  check('gated by name and by slug are not candidates; space startups still are', c.map((x) => x.name), ['Longshot Space', 'Stoke Space']);
}

console.log('\n🧪 board-links: an unreadable portals.yml stops the pass');
{
  // portalsEntries() answers [] for a missing or broken file; that must not read as "nothing tracked".
  const said = [];
  const r = await runLinks({ db: null, entries: [], write: true, withSimplifyList: false, log: (s) => said.push(s) });
  check('nothing gathered, checked or written', [r.candidates, r.calls, r.written.length], [0, 0, 0]);
  check('…and it says why', said.some((s) => /portals\.yml read as empty/.test(s)), true);
}

console.log('\n🧪 board-links: the store read uses the source index');
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openDb } = await import('./db.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-links-'));
  const file = path.join(dir, 'jobs.db');
  openDb(file).close();
  const db = new DatabaseSync(file);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${STORE_LINK_SQL}`).all(...COPY_SOURCES, 10).map((r) => r.detail).join(' | ');
  db.close();
  check('SEARCH on jobs_source, never a full scan', [/SEARCH jobs USING INDEX jobs_source/.test(plan), /SCAN jobs\b(?! USING)/.test(plan)], [true, false]);
  check('an empty store reads as no rows', storeLinkRows(file), []);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n🧪 board-links: one call per board, inside the budget');
{
  const cands = [
    { name: 'A', boards: ['ashby:a', 'lever:a'], links: ['la', 'la2'], postings: 3 },
    { name: 'B', boards: ['ashby:shared'], links: ['lb'], postings: 2 },
    { name: 'C', boards: ['ashby:shared'], links: ['lc'], postings: 1 },
    { name: 'D', boards: ['greenhouse:d'], links: ['ld'], postings: 1 },
  ];
  const asked = [];
  const probe = async (link, name) => { asked.push(link); return link === 'la2' || link === 'lb' ? { entry: { name, careers_url: `https://x/${link}` }, provider: 'ashby', count: 7 } : null; };
  const r = await resolveLinks(cands, { probe, budget: 3 });
  check('A takes two calls (first board answered nothing), B one, then the budget is spent', asked, ['la', 'la2', 'lb']);
  check('found A and B', r.found.map((f) => f.name), ['A', 'B']);
  check('C links the board B claimed: not asked again, not a miss', [r.misses.map((m) => m.name), r.unchecked.map((m) => m.name)], [[], ['C', 'D']]);
  check('calls are counted for the budget', r.calls, 3);
  const zero = await resolveLinks(cands, { probe: async () => { throw new Error('no'); }, budget: 0 });
  check('a zero budget asks nothing', [zero.calls, zero.unchecked.length], [0, 4]);
}

console.log('\n🧪 board-links: Simplify\'s own list');
{
  const now = Date.parse('2026-11-07T00:00:00Z');
  const l = (o) => ({ active: true, url: 'https://jobs.ashbyhq.com/x/1', company_name: 'X', category: 'Hardware Engineering', date_posted: now / 1000 - 86400, locations: ['Austin, TX'], ...o });
  const rows = simplifyLinkRows([l({}), l({ active: false }), l({ category: 'Software' }), l({ date_posted: now / 1000 - 90 * 86400 }), l({ locations: ['London, England'] })],
    { now, inUs: (locs) => locs.some((s) => /, [A-Z]{2}$/.test(s)) });
  check('active, field, recent, US only', rows.length, 1);
}

console.log('\n🧪 board-links: the entry it writes');
{
  const block = entryBlock({ name: 'Resurgent Industries', via: 'simplify', hit: { entry: { careers_url: 'https://jobs.ashbyhq.com/resurgent-industries', provider: 'ashby' }, provider: 'ashby', count: 15 } }, renderEntry, '2026-11-07');
  check('named, pinned, and says where it came from', [/name: "Resurgent Industries"/.test(block), /provider: ashby/.test(block), /Found from a posting link \(simplify\) by board-links\.mjs 2026-11-07/.test(block)], [true, true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
