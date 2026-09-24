// The curated screen's identity rules. Run: node jarvis/picks.test.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';
import { dedupeKey, locationKey, loadCandidates, isThinBody, winnability, learnedWhere } from './picks.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};

console.log('🧪 picks: one opening on two boards is one pick (F-344)');
const lam = (location) => ({ company: 'Lam Research', title: 'Mechanical Engineer 2', location });
eq('"US OR Tualatin" and "Tualatin, OR,US, US" are the same place', dedupeKey(lam('US OR Tualatin')), dedupeKey(lam('Tualatin, OR,US, US')));
eq('…and so is "Tualatin, OR"', dedupeKey(lam('Tualatin, OR')), dedupeKey(lam('US OR Tualatin')));
eq('Essex, VT in three spellings', new Set([locationKey('Essex, VT,US, US'), locationKey('Essex, VT'), locationKey('US VT Essex')]).size, 1);
eq('two states are two choices', dedupeKey(lam('Tualatin, OR')) === dedupeKey(lam('Fremont, CA')), false);
eq('a missing location is its own key, not a wildcard', locationKey(''), '');
eq('levels are not requisition noise', dedupeKey({ company: 'Acme', title: 'Process Engineer II', location: 'Boise, ID' }) === dedupeKey({ company: 'Acme', title: 'Process Engineer', location: 'Boise, ID' }), false);

// ── the screen itself ───────────────────────────────────────────────
//
// F-467. Applied Intuition "Mechanical Engineer - New Grad (December 2026)"
// ranked 99 fit / 89 winnability near the top of a curated list, for a man who
// graduates in May 2027. triage() had already read "will graduate by the end
// of 2026" and set f_grad_mismatch = 1 — the screen never asked.
console.log('\n🧪 picks: a graduation window he falls outside of is a bar');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-picks-'));
  const dbPath = path.join(dir, 'jobs.db');
  const db = openDb(dbPath);

  const row = (id, title, gradMismatch) => db.prepare(`
    INSERT INTO jobs (id, url, title, company, location, status, gone_at, first_seen, last_seen,
      fit_score, fit_blocked, f_hard_block, f_senior, f_intern, f_newgrad, f_grad_mismatch,
      level_years, has_desc, desc_len, posted_at)
    VALUES (?, ?, ?, 'Applied Intuition', 'Mountain View, CA', 'new', NULL, '2026-09-01', '2026-09-17',
      99, 0, 0, 0, 0, 1, ?, NULL, 1, 4000, date('now'))
  `).run(id, `https://example.test/${id}`, title, gradMismatch);

  row('aaa1', 'Mechanical Engineer - New Grad (December 2026)', 1);
  row('bbb2', 'Mechanical Engineer - New Grad', 0);
  db.close?.();

  const rows = loadCandidates(dbPath, { minFit: 70, days: 60, withDescriptions: false });
  const titles = rows.map((r) => r.id).sort();
  eq('the posting whose window he misses does not reach the list', titles, ['bbb2']);
  eq('…and it is reported, not silently dropped', rows.gradExcluded, 1);

  const all = loadCandidates(dbPath, { minFit: 70, days: 60, withDescriptions: false, gradAnyway: true });
  eq('--grad-anyway puts it back', all.map((r) => r.id).sort(), ['aaa1', 'bbb2']);

  rmSync(dir, { recursive: true, force: true });
}

// F-467, second half. A stored body of company boilerplate is not a posting
// that has been read, and every verdict derived from it is a verdict about
// text nobody fetched.
console.log('\n🧪 picks: a body with no requirements cannot be judged');
eq('Capstan\'s 799-character stub is thin',
  isThinBody('Capstan Medical is building a robotic system for heart valve replacement. '
    + 'We are a well-funded team in Santa Clara. Our culture values ownership and speed. '.repeat(6)),
  true);
eq('a terse posting that states its requirements is not thin',
  isThinBody('Design Quality Engineer. Requirements: BS in Mechanical Engineering, 2 years in medical devices.'),
  false);
eq('an empty body is thin', isThinBody(''), true);
eq('a long page of culture copy with no requirements is still thin',
  isThinBody('We believe in people. '.repeat(120)),
  true);

// F-466, the pay half. A posting that states no years but pays from $225K has
// told you its level anyway.
console.log('\n🧪 picks: a senior pay band with no years stated costs reading order');
{
  const base = { f_newgrad: 0, f_intern: 0, sponsors_h1b: 0, level_years: null, posted_at: null };
  const openai = winnability({ ...base, salary_min: 225000, salary_interval: 'year' });
  const plain = winnability({ ...base, salary_min: null });
  eq('the $225K band lowers winnability', openai.score < plain.score, true);
  eq('…and says why', openai.why.some((w) => /a level above new grad/.test(w)), true);
  eq('a normal new-grad band is untouched',
    winnability({ ...base, salary_min: 95000, salary_interval: 'year' }).score, plain.score);
  eq('a stated years figure wins over the pay band',
    winnability({ ...base, level_years: 1, salary_min: 225000, salary_interval: 'year' })
      .why.some((w) => /a level above new grad/.test(w)),
    false);
  eq('an hourly rate is not a salary band',
    winnability({ ...base, salary_min: 200000, salary_interval: 'hour' }).score, plain.score);
}

// F-310. `whereIsIt` returns 'unclear' for any city it does not recognise, and
// an unclear location costs 15 points. Reno, Albany, Greenville and Stafford
// were all being docked for being unrecognisable to a regex — while his own
// store held hundreds of rows at those very places, already bucketed. The
// entry's instruction was "do not extend the city list, it will never
// converge"; a list learned from his own data converges by itself.
console.log('\n🧪 picks: a place the store already knows is not "unrecognised"');
{
  const places = new Map([
    ['reno', { us: 175, non: 0 }],
    ['albany', { us: 259, non: 1 }],
    ['gloucester', { us: 5, non: 6 }],
    ['rugby', { us: 0, non: 6 }],
    ['thin', { us: 3, non: 0 }],
  ]);
  eq('a place seen hundreds of times in US rows is US', learnedWhere('Reno', places), 'us');
  eq('a near-unanimous majority is enough', learnedWhere('Albany', places), 'us');
  eq('a place seen only in foreign rows is elsewhere', learnedWhere('Rugby', places), 'elsewhere');
  // Gloucester is Applied Materials' Massachusetts site AND a city in England.
  // 5 against 6 is a coin toss, and the honest answer is to stay unclear.
  eq('a genuinely ambiguous name stays unknown', learnedWhere('Gloucester', places), null);
  eq('thin evidence is not evidence', learnedWhere('Thin', places), null);
  eq('a place it has never seen stays unknown', learnedWhere('Yixing', places), null);
  eq('an empty location is not a place', learnedWhere('', places), null);
  eq('no evidence at all is safe', learnedWhere('Reno', null), null);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
