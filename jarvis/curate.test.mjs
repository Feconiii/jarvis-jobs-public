// The daily curation (jarvis/curate.mjs). Run: node jarvis/curate.test.mjs
//
// "bro i thought we supposed to do a run everyday how did i run out of jobs"
// (2026-09-24). No model is called and his store is never touched: the model
// and the filing are stand-ins, the store is a temporary one.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';
import { curate, parseVerdict, TITLE_OUT, openPicks, promptFor, priorAt, notInterestingCompanies } from './curate.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};

console.log('🧪 curate: a verdict is read strictly');
eq('a KEEP with its note', parseVerdict('{"verdict":"KEEP","why":"0-2 years","note":"Fits. Wins."}')?.verdict, 'KEEP');
eq('prose around the JSON is tolerated', parseVerdict('Here: {"verdict":"drop","why":"2+ years required"}')?.verdict, 'DROP');
eq('a pick with no reason is not a pick', parseVerdict('{"verdict":"KEEP","why":"x"}'), null);
eq('garbage is nothing', parseVerdict('I think this is a good job'), null);
eq('an unknown verdict is nothing', parseVerdict('{"verdict":"YES","why":"x","note":"y"}'), null);

console.log('\n🧪 curate: titles that fail on their face, and the ones that do not');
eq('senior is out', TITLE_OUT.test('Senior Process Engineer'), true);
eq('an internship is out', TITLE_OUT.test('Manufacturing Engineering Intern'), true);
eq('Engineer II is NOT out — he has applied to six', TITLE_OUT.test('Manufacturing Engineer II'), false);
eq('Mechanical Engineer 2 is NOT out (Lam)', TITLE_OUT.test('Mechanical Engineer 2'), false);
eq('Engineer 3 is out', TITLE_OUT.test('Systems Engineer 3'), true);
eq('a new-grad title passes', TITLE_OUT.test('New College Grad Equipment Engineer'), false);

console.log('\n🧪 curate: the prompt carries the whole posting and his facts');
{
  const p = promptFor({ company: 'Acme', title: 'Process Engineer', location: 'Boise' }, 'X'.repeat(9000) + ' THE END', 'BS Mechanical Engineering, State University');
  eq('the full body, not a requirements excerpt', p.includes('THE END'), true);
  eq('his CV is in it', p.includes('State University'), true);
  eq('F-1 status is in it', /F-1/.test(p), true);
}

console.log('\n🧪 curate: filing, topping up, and stopping');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-'));
  const dbPath = path.join(dir, 'jobs.db');
  writeFileSync(path.join(dir, 'cv-short.md'), '<!-- note -->\n# Alex Rivera\nBS Mechanical Engineering');
  const db = openDb(dbPath);
  const add = (id, status) => db.prepare(`INSERT INTO jobs (id, url, title, company, location, status, first_seen, last_seen, fit_score, has_desc)
    VALUES (?, ?, 'Engineer', 'Acme', 'Boise, ID', ?, '2026-09-20', '2026-09-24', 90, 1)`).run(id, `https://x.test/${id}`, status);
  add('open1', 'inbox');
  db.close?.();

  const cands = [{ id: 'k', company: 'A', title: 'Equipment Engineer' }, { id: 'm', company: 'B', title: 'Test Engineer' },
    { id: 'd', company: 'C', title: 'Process Engineer' }, { id: 'thin', company: 'D', title: 'ME' }];
  const answers = {
    k: '{"verdict":"KEEP","why":"0-2 years","note":"Cleanroom equipment work like his AMAT internship. It says 0-2 years."}',
    m: '{"verdict":"MAYBE","why":"2nd shift","note":"Second shift. Test fixtures like his AMAT work."}',
    d: '{"verdict":"DROP","why":"3+ years required"}',
  };
  const filed = [];
  const r = await curate({
    dbPath, root: dir, target: 50, candidates: cands, log: () => {},
    readDesc: (_db, id) => (id === 'thin' ? 'short' : `A real posting body for ${id}. `.repeat(30)),
    ask: async (prompt) => answers[Object.keys(answers).find((id) => prompt.includes(`body for ${id}.`))],
    file: (ids, notes, opts = {}) => filed.push({ ids, notes, undo: !!opts.undo }),
  });
  eq('one kept, one worth a look, one turned down', [r.kept.length, r.maybe.length, r.dropped.length], [1, 1, 1]);
  eq('a posting with no body is not read, and says so', r.failed.map((f) => f.id), ['thin']);
  const picks = filed.find((x) => !x.undo);
  eq('KEEP and MAYBE go to his inbox together', picks.ids.sort(), ['k', 'm']);
  eq('a MAYBE is labelled as one on his card', /^Worth a look: Second shift/.test(picks.notes.m), true);
  const turned = filed.find((x) => x.undo);
  eq('a DROP is filed as read, with its reason, so it never comes back', turned.notes.d, 'read by the daily curation — 3+ years required');

  // Already enough open: nothing is read at all.
  const quiet = await curate({ dbPath, root: dir, target: 1, candidates: cands, log: () => {},
    ask: async () => { throw new Error('must not be called'); }, file: () => {} });
  eq('a full list is left alone', quiet.skipped, true);
  eq('…and counts what is open', quiet.open, 1);

  // A spent model ends the run; the rest are not handed to anything weaker.
  let calls = 0;
  const spent = await curate({ dbPath, root: dir, target: 50, candidates: cands, log: () => {}, file: () => {},
    readDesc: () => 'A real posting body. '.repeat(40),
    ask: async () => { calls += 1; throw new Error('every model is out of credit'); } });
  eq('out of credit stops after the first call', calls, 1);
  eq('…and says why', /out of credit/.test(spent.failed[0].why), true);

  const d2 = openDb(dbPath); eq('openPicks counts open inbox rows', openPicks(d2), 1);
  eq('what he already has at a company reaches the reader', priorAt(d2, { id: 'new9', company: 'acme' }), ['Engineer [inbox]']);
  eq('…and it is in the prompt', promptFor({ company: 'Acme', title: 'Engineer' }, 'body', 'cv', ['Engineer [applied]']).includes('Engineer [applied]'), true);
  d2.close?.();
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n🧪 curate: an employer he called "not interesting" is not read again');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-skip-'));
  const file = path.join(dir, 'skip-reasons.jsonl');
  writeFileSync(file, [
    JSON.stringify({ reasons: ['Company not interesting'], company: 'Seek Thermal' }),
    JSON.stringify({ reasons: ['Too senior / wants more experience'], company: 'Arista Networks' }),
    'not json',
  ].join('\n'));
  const s = notInterestingCompanies(file);
  eq('Seek Thermal is skipped', s.has('seek thermal'), true);
  eq('a job hidden for another reason does not skip its employer', s.has('arista networks'), false);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
