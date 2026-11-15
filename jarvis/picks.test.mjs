// The curated screen's identity rules. Run: node jarvis/picks.test.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';
import { dedupeKey, locationKey, loadCandidates, isThinBody, winnability, learnedWhere, exportBar, approve } from './picks.mjs';
import { classifyVisa } from './visa.mjs';

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

// F-956. Eight hand-filed picks went to his inbox at companies he had hidden,
// where the board never shows them. approve() refuses them now, and says so.
console.log('\n🧪 picks: a company he hid is not filed to his inbox');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-picks-'));
  const dbPath = path.join(dir, 'jobs.db');
  const db = openDb(dbPath);
  const row = (id, company) => db.prepare(`
    INSERT INTO jobs (id, url, title, company, location, status, first_seen, last_seen, fit_score, fit_blocked, f_hard_block, f_senior, f_intern, f_newgrad, f_grad_mismatch, has_desc, desc_len)
    VALUES (?, ?, 'Mechanical Engineer', ?, 'Beverly, MA', 'new', '2026-11-01', '2026-11-02', 90, 0, 0, 0, 0, 0, 0, 1, 4000)
  `).run(id, `https://example.test/${id}`, company);
  row('hid1', 'Axcelis Technologies');
  row('ok1', 'Lam Research');
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('hiddenCompanies', ?)").run(JSON.stringify(['Axcelis Technologies']));
  db.close?.();
  const r = approve(['hid1', 'ok1'], {}, { dbPath });
  eq('only the visible company is filed', r.moved, 1);
  eq('…and the hidden one comes back as refused', r.refused, ['hid1']);
  const db2 = openDb(dbPath);
  eq('its status is untouched', db2.prepare("SELECT status FROM jobs WHERE id = 'hid1'").get().status, 'new');
  db2.close?.();
  rmSync(dir, { recursive: true, force: true });
}

// F-765. The window read the employer's posting date, so a requisition open for
// months was out of the pool the day the store first saw it (CircuitHub:
// posted 2026-01-15, first seen 09-09).
console.log('\n🧪 picks: a posting the store just found is new, however old its posting date (F-765)');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-picks-'));
  const dbPath = path.join(dir, 'jobs.db');
  const db = openDb(dbPath);
  const row = (id, posted, firstSeen) => db.prepare(`
    INSERT INTO jobs (id, url, title, company, location, status, gone_at, first_seen, last_seen,
      fit_score, fit_blocked, f_hard_block, f_senior, f_intern, f_newgrad, f_grad_mismatch,
      level_years, has_desc, desc_len, posted_at)
    VALUES (?, ?, 'Mechanical Engineer, Factory Automation', ?, 'Boston, MA', 'new', NULL, ${firstSeen}, date('now'),
      95, 0, 0, 0, 0, 0, 0, NULL, 1, 4000, ${posted})
  `).run(id, `https://example.test/${id}`, `Co ${id}`);
  row('circuithub', "date('now', '-276 day')", "date('now', '-39 day')");   // posted January, found in September
  row('fresh', "date('now', '-3 day')", "date('now', '-3 day')");
  row('stale', "date('now', '-200 day')", "date('now', '-120 day')");     // both dates old: still out
  row('posted-recently', "date('now', '-5 day')", "date('now', '-90 day')"); // reposted: the later date counts
  row('no-dates', 'NULL', 'NULL');
  db.close?.();
  const ids = loadCandidates(dbPath, { minFit: 70, days: 45, withDescriptions: false }).map((r) => r.id).sort();
  eq('first seen 39 days ago passes a 45-day window, posted 276 days ago or not', ids.includes('circuithub'), true);
  eq('…both dates old is still outside it', ids.includes('stale'), false);
  eq('…the later of the two dates counts', ids.includes('posted-recently'), true);
  eq('…a fresh posting and one with no dates at all pass', ['fresh', 'no-dates'].every((i) => ids.includes(i)), true);

  // Formlabs' "June 2027 New Grads" scored 66: new-grad wording may come in at
  // a lower fit floor when the caller asks; nothing else does.
  const db2 = openDb(dbPath);
  const fitRow = (id, fit, ng) => db2.prepare(`
    INSERT INTO jobs (id, url, title, company, location, status, gone_at, first_seen, last_seen,
      fit_score, fit_blocked, f_hard_block, f_senior, f_intern, f_newgrad, f_grad_mismatch,
      level_years, has_desc, desc_len, posted_at)
    VALUES (?, ?, 'Engineer', ?, 'Somerville, MA', 'new', NULL, date('now'), date('now'), ?, 0, 0, 0, 0, ?, 0, NULL, 1, 4000, date('now'))
  `).run(id, `https://example.test/${id}`, `Co ${id}`, fit, ng);
  fitRow('formlabs-ng-66', 66, 1);
  fitRow('plain-66', 66, 0);
  fitRow('ng-55', 55, 1);
  db2.close?.();
  const dflt = loadCandidates(dbPath, { minFit: 70, days: 45, withDescriptions: false }).map((r) => r.id);
  eq('by default fit 70 is the floor for every row', dflt.includes('formlabs-ng-66'), false);
  const wide = loadCandidates(dbPath, { minFit: 70, newGradFit: 60, days: 45, withDescriptions: false }).map((r) => r.id);
  eq('newGradFit 60 lets a fit-66 new-grad posting in', wide.includes('formlabs-ng-66'), true);
  eq('…not a fit-66 posting without new-grad wording', wide.includes('plain-66'), false);
  eq('…nor a new-grad posting under the lower floor', wide.includes('ng-55'), false);
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

// HIS PICKS SKIP ITAR AND U.S.-PERSON ROLES (2026-09-30, 2026-10-02).
{
  const pcb = 'This position requires access to information subject to the International Traffic in Arms Regulations (22 C.F.R, Chapter 1, Subchapter M). Qualified candidates must be legally authorized to access such information.';
  eq('PCB Piezotronics: ITAR access is a skip', !!exportBar('Manufacturing Engineer I', pcb), true);
  const sierra = 'This position requires the candidate to be a U.S. Citizen, lawful permanent resident of the U.S., protected individual as defined by 8 U.S.C. 1324b(a)(3), or eligible to obtain the required authorizations from the U.S. Department of State.';
  eq('Sierra Space: a U.S.-person list, even "or eligible to obtain authorizations", is a skip', !!exportBar('Manufacturing Engineer I', sierra), true);
  const adi = 'Applicants for this position – except US Citizens, US Permanent Residents, and protected individuals as defined by 8 U.S.C. 1324b(a)(3) – may have to go through an export licensing review process.';
  eq('Analog Devices: the routine export-licence review is NOT a skip', exportBar('Associate Manufacturing Engineer', adi), null);
  const kairos = 'Note: You are applying for a position that is located in a facility that handles information that is subject to export control restrictions by the Department of Energy under 10 CFR Part 810. Foreign nationals who are citizens of countries that are not on the general authorization list are not permitted unless the Department of Energy issues an export control license.\n\nApplication form questions:\nAre you a U.S. citizen, a U.S. lawful permanent resident (i.e. green card holder), or a protected individual under 8 U.S.C. Sec. 1324b? (required)\nAre you a citizen of any country that is NOT included in the following list: Argentina, Australia, … or Vietnam? (required)';
  eq('Kairos Power: a 10 CFR 810 licence question is NOT a skip (F-959)', exportBar('Mechanical Engineer, Fuel Handling Equipment', kairos), null);
  eq('…but ITAR beside it still is', !!exportBar('Mechanical Engineer', kairos + '\nThis role requires access to ITAR-controlled technical data.'), true);
  eq('nothing about export control: no bar', exportBar('Mechanical Engineer', 'Design fixtures for wafer handling robots. BS in Mechanical Engineering.'), null);
  // The 11-12 audit's leaks (visa gate item 4): each is a skip by its own words.
  const bulwark = 'Required: Must be a U.S. Citizen or U.S. Permanent Resident (Green Card holder) eligible to work in an ITAR/EAR-regulated environment.';
  eq('Bulwark Dynamics: citizen or green card, ITAR/EAR environment, is a skip', !!exportBar('Mechanical Engineer', bulwark), true);
  eq('…and so is the citizen-or-green-card line without the ITAR word', !!exportBar('Mechanical Engineer', 'Required: Must be a U.S. Citizen or U.S. Permanent Resident (Green Card holder).'), true);
  const fralock = 'This position requires access to information controlled under the International Traffic in Arms Regulations (ITAR) or the Export Administration Regulations (EAR), the successful candidate must be a "U.S. person" as defined in the ITAR and EAR (which generally means (i) be a citizen or national of the United States; or (ii) be a lawful permanent resident of the United States; or (iii) have been admitted to the United States as a refugee, or have been granted asylum).';
  eq('FRALOCK: a "U.S. person" as defined in the ITAR and EAR is a skip', !!exportBar('Manufacturing Engineer I', fralock), true);
  const samsung = 'This position may include access to controlled information or technology under U.S. export control laws. Employment may be contingent on either the applicant verifying that the applicant falls under the “U.S. Person” definition (including U.S. citizens, U.S. lawful permanent residents, and those granted U.S. asylum or refugee status) or the employer timely obtaining any necessary export license under federal law. The employer evaluates export licensing on a case-by-case basis and may decline to proceed with a job applicant in its sole discretion, as export license applications can take many weeks to process.';
  eq('Samsung Austin: a U.S. person OR a licence the employer obtains is NOT a skip (F-1045)', exportBar('CVD Equipment Engineer', samsung), null);
  // Review 11-12: the licence alternative excuses only its own sentence.
  eq('…but a separate hard U.S.-person sentence later in the posting still bars it',
    !!exportBar('CVD Equipment Engineer', samsung + '\n\nRequirements: Candidates must be a U.S. person (U.S. citizen or green card holder).'), true);
  eq('"or we cannot obtain an export license" is no alternative',
    !!exportBar('Mechanical Engineer', 'Candidates must be a U.S. person as defined by the EAR, or we cannot obtain an export license for this role.'), true);
  eq('"or cannot obtain" with no employer is no alternative either',
    !!exportBar('Mechanical Engineer', 'Applicants must be U.S. persons under the EAR or cannot obtain an export license.'), true);
  eq('a citizen demand beside a bare "or obtaining an export license" is no alternative',
    !!exportBar('Mechanical Engineer', 'You must be a U.S. citizen or permanent resident, or obtaining an export license will be your responsibility.'), true);
  eq('Analog Devices still passes', exportBar('Associate Manufacturing Engineer', adi), null);
  // A sentence that only defines "U.S. person" demands nothing (TSMC Arizona, Hermeus, Vast).
  eq('TSMC Arizona: "may require an export license" plus a definition is not a skip',
    exportBar('Engineering Full-Time Opportunities', 'This position requires access to export-controlled technology. Non-U.S. Persons may require an export license. U.S. Persons include United States citizens, lawful permanent residents, and persons admitted to the United States as a refugee or asylee.'), null);
  eq('Hermeus: "or otherwise eligible for deemed export licensing" plus a definition is not a skip',
    exportBar('Manufacturing Engineer, New Grad', 'The person hired will have access to information and items subject to U.S. export controls, and therefore, must either be a "U.S. person" as defined by 22 C.F.R. § 120.62 or otherwise eligible for deemed export licensing. US persons include U.S. citizens, U.S. nationals, lawful permanent residents (green card holders), and asylees and refugees with such status granted, not pending.'), null);
  eq('…but a definition that also demands ("only U.S. persons, which include…") still bars',
    !!exportBar('Mechanical Engineer', 'This role requires access to ITAR data. U.S. persons include citizens and green card holders, and only U.S. persons are eligible for this role.'), true);
  // Visa-gate follow-ups (First Mate re-check, 11-12): three rare leaks.
  // (1) The refusal can sit in its own sentence: the licence excuse is then empty.
  eq('a licence the company obtains, refused in the next sentence, still bars',
    !!exportBar('Mechanical Engineer', 'Must be a U.S. person or the company obtains an export license. The company does not file export licenses for foreign nationals.'), true);
  eq('…while a refusal of some other licence elsewhere does not',
    exportBar('CVD Equipment Engineer', samsung + ' Applicants who cannot obtain a driver\'s license are not eligible for the fleet program.'), null);
  // (2) A definition needs a defining verb and a list of statuses; a bare "are" or "is" is a demand.
  eq('"U.S. persons are considered exclusively" bars',
    !!exportBar('Mechanical Engineer', 'This role involves export-controlled technology. U.S. persons are considered exclusively.'), true);
  eq('"U.S. persons are hired for this role" bars',
    !!exportBar('Mechanical Engineer', 'This role involves export-controlled technology. U.S. persons are hired for this role.'), true);
  eq('"U.S. persons are defined as citizens, permanent residents…" is still a definition',
    exportBar('Engineering Full-Time Opportunities', 'This position requires access to export-controlled technology. Non-U.S. Persons may require an export license. U.S. persons are defined as citizens, lawful permanent residents, refugees and asylees.'), null);
  // (3) "deemed export" excuses only as an alternative, never beside a hard demand.
  eq('"a U.S. person or, if not, eligible for deemed export" is the alternative, commas and all (first mate\'s review)',
    exportBar('Mechanical Engineer', 'Applicants must be a U.S. person or, if not, eligible for deemed export.'), null);
  // Citizenship with no alternative is not this gate's: visa.mjs hard-blocks it before any pick (us_citizen).
  for (const t of ['U.S. citizenship required.', 'This position is open to U.S. citizens only.']) {
    eq(`"${t}" is visa.mjs's hard block, not exportBar's`, [exportBar('Mechanical Engineer', t), classifyVisa('Mechanical Engineer', `Design fixtures. ${t}`).block?.key], [null, 'us_citizen']);
  }
  eq('"requires a U.S. person (deemed export)" bars',
    !!exportBar('Mechanical Engineer', 'This role requires a U.S. person (deemed export).'), true);
  eq('…and an "or" between two statuses is not an alternative to them',
    !!exportBar('Mechanical Engineer', 'Must be a U.S. citizen or permanent resident (deemed export).'), true);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
