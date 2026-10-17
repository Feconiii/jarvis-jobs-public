// Tests for reboard.mjs (F-713) and the generic-name rule in universe.mjs's
// matchTracked. The names are the ones the 2026-10-06 check met: Caterpillar on
// a one-posting SmartRecruiters account, Microchip on a 17-posting one, and the
// S&P 500 names a one-word tracked entry answered for.

import {
  simplifyBoards, isBetter, isSuspect, repointEntry, entrySpan, wrongBoardDisable, displayName,
  REPLACE_MIN, THIN_OPEN, THIN_OPEN_LARGE, STALE_DAYS, ADD_MIN,
} from './reboard.mjs';
import { keyOf, plainName, trackedIndex, matchTracked } from './universe.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 reboard: when a board is suspect');
{
  check('an S&P 500 company with 17 open postings is suspect', isSuspect({ open: 17, large: true, lastSeenDays: 2 }), true);
  check('…a small employer with 17 is not', isSuspect({ open: 17, large: false, lastSeenDays: 2 }), false);
  check('a board with nothing new for two months is suspect, however many it lists', isSuspect({ open: 234, large: true, lastSeenDays: STALE_DAYS + 15 }), true);
  check('a big, fresh board is left alone', isSuspect({ open: THIN_OPEN_LARGE + 1, large: true, lastSeenDays: 1 }), false);
  check('an employer with nothing in the store is suspect', isSuspect({ open: 0, large: false, lastSeenDays: Infinity }), true);
}

console.log('\n🧪 reboard: when a found board wins');
{
  check('Caterpillar: 1 → 957 replaces', isBetter(1, 957), true);
  check('Microchip: 17 → 494 replaces', isBetter(17, 494), true);
  check('a board only twice as big does not replace', isBetter(40, 80), false);
  check(`under ${REPLACE_MIN} postings never replaces, even from nothing`, isBetter(0, REPLACE_MIN - 1), false);
  check(`a new employer is added from ${ADD_MIN}`, isBetter(0, ADD_MIN, { adding: true }), true);
  check('…not below', isBetter(0, ADD_MIN - 1, { adding: true }), false);
}

console.log('\n🧪 reboard: Simplify\'s list');
{
  const now = Date.parse('2026-10-06T00:00:00Z');
  const t = (d) => (now - d * 86400000) / 1000;
  const rows = [
    { company_name: 'Caterpillar', url: 'https://cat.wd5.myworkdayjobs.com/CaterpillarCareers/job/A', date_posted: t(10), locations: ['Peoria, IL'], category: 'Hardware' },
    { company_name: 'Caterpillar', url: 'https://cat.wd5.myworkdayjobs.com/CaterpillarCareers/job/B', date_posted: t(20), locations: ['Mossville, IL'], category: 'Software' },
    { company_name: 'Caterpillar', url: 'https://cat.wd5.myworkdayjobs.com/CaterpillarCareers/job/C', date_posted: t(400), locations: ['Peoria, IL'], category: 'Hardware' },
    { company_name: 'Caterpillar', url: 'https://cat.wd5.myworkdayjobs.com/CaterpillarCareers/job/D', date_posted: t(5), locations: ['Grenoble, France'], category: 'Hardware' },
  ];
  const m = simplifyBoards(rows, (n) => keyOf(plainName(n)), now);
  const cat = m.get('caterpillar');
  check('every posting URL is kept as a board hint', cat.urls.length, 4);
  check('recent counts only US postings from the past year', cat.recent, 2);
  check('…and hardware ones among them', cat.hardware, 1);
  check('a row with no URL is skipped', simplifyBoards([{ company_name: 'X' }], keyOf, now).size, 0);
}

console.log('\n🧪 reboard: rewriting the entry');
{
  const yml = [
    'tracked_companies:',
    '  - name: "Carvana"',
    '    careers_url: https://job-boards.greenhouse.io/carvana',
    '    enabled: false',
    '',
    '  - name: "Caterpillar Inc."',
    '    careers_url: https://jobs.smartrecruiters.com/caterpillarinc',
    '    notes: "Industrials. Auto-discovered via smartrecruiters (1 postings live at discovery)."',
    '    enabled: true',
    '',
    '  - name: "CDW Corporation"',
    '    careers_url: https://cdw.wd5.myworkdayjobs.com/Careers',
    '    enabled: true',
    '',
  ].join('\n');
  const r = repointEntry(yml, 'Caterpillar Inc.', { careers_url: 'https://cat.wd5.myworkdayjobs.com/CaterpillarCareers' }, 'Repointed 2026-10-06 (F-713).');
  check('the entry changes', r.changed, true);
  check('…to the new board', r.text.includes('    careers_url: https://cat.wd5.myworkdayjobs.com/CaterpillarCareers'), true);
  check('…the old board is gone from its fields', r.text.includes('careers_url: https://jobs.smartrecruiters.com/caterpillarinc'), false);
  check('…and kept in its notes', r.text.includes('notes: "Repointed 2026-10-06 (F-713). Industrials.'), true);
  check('the next entry is untouched', r.text.includes('  - name: "CDW Corporation"\n    careers_url: https://cdw.wd5.myworkdayjobs.com/Careers'), true);
  check('a disabled neighbour stays disabled', /name: "Carvana"\n[^]*?enabled: false/.test(r.text), true);
  check('a missing name changes nothing', repointEntry(yml, 'Nobody', { careers_url: 'x' }, 'n').changed, false);

  const crlf = yml.replace(/\n/g, '\r\n');
  const r2 = repointEntry(crlf, 'Caterpillar Inc.', { careers_url: 'https://cat.wd5.myworkdayjobs.com/CaterpillarCareers', provider: 'workday' }, 'R.');
  check('a CRLF file keeps CRLF', r2.text.includes('  - name: "Caterpillar Inc."\r\n    provider: workday\r\n    careers_url: https://cat.wd5'), true);

  const orc = repointEntry(yml, 'Caterpillar Inc.', { provider: 'oracle-orc', careers_url: 'https://hcwp.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', orc_host: 'https://hcwp.fa.us2.oraclecloud.com', orc_site: 'CX_1' }, 'R.');
  check('an Oracle board keeps its host and its site (Coherent lost orc_host on 2026-10-07)',
    orc.text.includes('    orc_host: "https://hcwp.fa.us2.oraclecloud.com"') && orc.text.includes('    orc_site: "CX_1"'), true);

  const wrong = '  - name: "Xylem"\n    careers_url: https://xylem.bamboohr.com/careers\n    notes: "BambooHR placeholder board, not this company\'s real careers site."\n    enabled: false\n';
  const r3 = repointEntry(wrong, 'Xylem', { careers_url: 'https://xylem.wd5.myworkdayjobs.com/xylem-careers' }, 'R.');
  check('an entry disabled for a wrong board is turned back on', /enabled: true/.test(r3.text), true);
  check('wrong-board disables are recognised', wrongBoardDisable("BambooHR placeholder board, not this company's real careers site"), true);
  check('…an out-of-scope disable is not', wrongBoardDisable('Coach retail, not engineering'), false);

  const span = entrySpan(yml, 'Caterpillar Inc.');
  check('entrySpan covers exactly one entry', yml.slice(span.at, span.end).trim().split('\n').length, 4);
}

console.log('\n🧪 reboard: names for new entries');
{
  check('"Coca-Cola Company (The)" is Coca-Cola', displayName('Coca-Cola Company (The)', plainName), 'Coca-Cola');
  check('"McCormick & Company" keeps its last word', displayName('McCormick & Company', plainName), 'McCormick & Company');
  check('"Southern Company" is not the word "Southern"', displayName('Southern Company', plainName), 'Southern Company');
  check('"Carrier Global" is left alone', displayName('Carrier Global', plainName), 'Carrier Global');
}

console.log('\n🧪 universe: a one-word ordinary name matches only exactly (F-713)');
{
  const idx = trackedIndex([{ name: 'International' }, { name: 'Constellation' }, { name: 'Archer' }, { name: 'Rivian' }, { name: 'Southern Star Central Gas Pipeline' }]);
  check('International Paper is not "International"', matchTracked('International Paper', idx), null);
  check('Constellation Energy is not "Constellation"', matchTracked('Constellation Energy', idx), null);
  check('Archer Daniels Midland is not "Archer"', matchTracked('Archer Daniels Midland', idx), null);
  check('Southern Company is not Southern Star Central Gas Pipeline', matchTracked('Southern Company', idx), null);
  check('"International" itself still is', matchTracked('International', idx)?.name, 'International');
  check('a distinctive one-word name still matches its longer form', matchTracked('Rivian Automotive, LLC', idx)?.name, 'Rivian');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
