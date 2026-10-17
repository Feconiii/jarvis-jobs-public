// The daily curation (jarvis/curate.mjs). Run: node jarvis/curate.test.mjs
//
// "bro i thought we supposed to do a run everyday how did i run out of jobs"
// (2026-09-24). No model is called and his store is never touched: the model
// and the filing are stand-ins, the store is a temporary one.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';
import { curate, parseVerdict, TITLE_OUT, titleOut, CAPPED, openPicks, promptFor, priorAt, reqNumbers, notInterestingCompanies, tierOf } from './curate.mjs';

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
// 2026-10-03: "stop fuckin shwoing me e2 e3 level roles for amat".
eq('an AMAT E3 grade is out', titleOut('Process Engineer E3'), true);
eq('an AMAT E2 grade is out', titleOut('Mechanical Engineer II E2'), true);
eq('…but not the E2 rotation program, his best AMAT fit', titleOut('2027 Engineer Development Rotation Program Systems Engineering (E2)'), false);
eq('Tesla is capped: the curator never files one unasked', CAPPED.test('Tesla'), true);
eq('E2E is end-to-end, not a grade', titleOut('Network and System Verification Engineer, E2E'), false);

console.log('\n🧪 curate: the prompt carries the whole posting and his facts');
{
  const p = promptFor({ company: 'Acme', title: 'Process Engineer', location: 'Boise' }, 'X'.repeat(9000) + ' THE END', 'BS Mechanical Engineering, Lakeside');
  eq('the full body, not a requirements excerpt', p.includes('THE END'), true);
  eq('his CV is in it', p.includes('Lakeside'), true);
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
  // A row at a company he hid is invisible to him, so it is not an open pick
  // (2026-10-03: 60 of 104 counted were, and the curator stood down).
  db.prepare(`INSERT INTO jobs (id, url, title, company, location, status, first_seen, last_seen, fit_score, has_desc)
    VALUES ('hid1', 'https://x.test/hid1', 'Engineer', 'Alstom', 'Pittsburgh', 'inbox', '2026-09-20', '2026-09-24', 90, 1)`).run();
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('hiddenCompanies', ?)").run(JSON.stringify(['Alstom']));
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
  const merge = (list) => ({ ids: list.flatMap((x) => x.ids), notes: Object.assign({}, ...list.map((x) => x.notes)) });
  const picks = merge(filed.filter((x) => !x.undo));
  eq('KEEP and MAYBE go to his inbox', picks.ids.sort(), ['k', 'm']);
  eq('a MAYBE is labelled as one on his card', /^Worth a look: Second shift/.test(picks.notes.m), true);
  const turned = merge(filed.filter((x) => x.undo));
  eq('a DROP is filed as read, with its reason, so it never comes back', turned.notes.d, 'read by the daily curation — 3+ years required');

  // A run stopped part-way keeps every verdict it already made (2026-10-03:
  // background jobs get reaped when the machine runs short of memory).
  {
    const kept2 = [];
    await curate({
      dbPath, root: dir, target: 50, candidates: cands.slice(0, 3), log: () => {},
      readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
      ask: async (prompt) => { if (prompt.includes('body for d.')) throw new Error('out of credit'); return answers[Object.keys(answers).find((id) => prompt.includes(`body for ${id}.`))]; },
      file: (ids) => kept2.push(...ids),
    });
    eq('a run that stops part-way has already filed what it read', kept2.sort(), ['k', 'm']);
  }

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

  // F-730: a scan holding the write lock does not end the run.
  {
    const three = [{ id: 'a', company: 'A', title: 'Engineer' }, { id: 'b', company: 'B', title: 'Engineer' }, { id: 'c', company: 'C', title: 'Engineer' }];
    let locks = 3; const wrote = []; const asked = [];
    const r = await curate({ dbPath, root: dir, target: 50, candidates: three, log: () => {}, lockWaitMs: 50,
      readDesc: () => 'A real posting body. '.repeat(40),
      ask: async (p) => { asked.push(p); return '{"verdict":"KEEP","why":"fits","note":"Fits. Wins."}'; },
      file: (ids) => { if (locks-- > 0) throw new Error('database is locked'); wrote.push(...ids); } });
    eq('every posting is still read while the store is locked', asked.length, 3);
    eq('…and every verdict is written once the lock frees, in order', wrote, ['a', 'b', 'c']);
    eq('…with nothing left unwritten', r.unfiled, []);
    const stuck = await curate({ dbPath, root: dir, target: 50, candidates: three.slice(0, 1), log: () => {}, lockWaitMs: 50,
      readDesc: () => 'A real posting body. '.repeat(40),
      ask: async () => '{"verdict":"DROP","why":"no"}',
      file: () => { throw new Error('database is locked'); } });
    eq('a lock that never frees is reported, not thrown', stuck.unfiled, ['a']);
    let threw = false;
    try {
      await curate({ dbPath, root: dir, target: 50, candidates: three.slice(0, 1), log: () => {}, lockWaitMs: 50,
        readDesc: () => 'A real posting body. '.repeat(40), ask: async () => '{"verdict":"DROP","why":"no"}',
        file: () => { throw new Error('no such column: pick_note'); } });
    } catch { threw = true; }
    eq('any other write error still stops the run', threw, true);
  }

  // LinkedIn Easy Apply only: turned down before any model call (2026-10-02).
  {
    const li = [{ id: 'ez', company: 'KUKA', title: 'Jr. Mobility Engineer', url: 'https://www.linkedin.com/jobs/view/jr-mobility-engineer-at-kuka-4467250791' },
      { id: 'off', company: 'ANDRITZ', title: 'Mechanical Design Engineer', url: 'https://www.linkedin.com/jobs/view/mechanical-design-engineer-at-andritz-4469181165' },
      { id: 'unk', company: 'Z', title: 'Test Engineer', url: 'https://www.linkedin.com/jobs/view/test-engineer-at-z-4400000001' }];
    const asked = [];
    const routes = { 4467250791: 'easy-apply', 4469181165: 'offsite' };
    const filed2 = [];
    const rr = await curate({
      dbPath, root: dir, target: 50, candidates: li, log: () => {},
      readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
      route: async (u) => routes[u.match(/(\d+)$/)[1]] || null,
      ask: async (prompt) => { asked.push(prompt); return '{"verdict":"KEEP","why":"fits","note":"Fits. Wins."}'; },
      file: (ids, notes, opts = {}) => filed2.push({ ids, notes, undo: !!opts.undo }),
    });
    eq('Easy Apply is turned down, the company-site and unknown ones are read', [rr.dropped.map((x) => x.id), rr.kept.map((x) => x.id)], [['ez'], ['off', 'unk']]);
    eq('…without asking the model', asked.some((p) => p.includes('body for ez.')), false);
    eq('…and the reason is on the row', /Easy Apply only/.test(filed2.find((x) => x.undo).notes.ez), true);
  }

  const d2 = openDb(dbPath); eq('openPicks counts open inbox rows', openPicks(d2), 1);
  // F-728: a LinkedIn copy folded into its board row is not a second pick.
  d2.prepare(`INSERT INTO jobs (id, url, title, company, status, first_seen, last_seen, superseded_by)
    VALUES ('li-copy', 'https://www.linkedin.com/jobs/view/1', 'Engineer', 'Acme', 'inbox', '2026-10-01', '2026-10-01', 'some-board-row')`).run();
  eq('…and a copy pointed at another row is not counted', openPicks(d2), 1);
  d2.prepare("DELETE FROM jobs WHERE id = 'li-copy'").run();
  // 2026-10-03: J&J's R-098612 came back as "6267-Auris Health Inc. Legal Entity".
  d2.prepare(`INSERT INTO jobs (id, url, title, company, status, first_seen, last_seen)
    VALUES ('jj1', 'https://jj.wd5.myworkdayjobs.com/JJ/job/Santa-Clara/Operations-Process-Engineer--Capital-System-_R-098612-1',
    'Operations Process Engineer (Capital System)', 'Johnson & Johnson', 'interested', '2026-10-01', '2026-10-01')`).run();
  eq('the same requisition under another legal name is on his list',
    /same requisition, listed as Johnson & Johnson/.test(priorAt(d2, { id: 'au1', company: '6267-Auris Health Inc. Legal Entity',
      title: 'Operations Process Engineer (Capital System)',
      url: 'https://jj.wd5.myworkdayjobs.com/en-US/JJ/job/Santa-Clara/Operations-Process-Engineer--Capital-System-_R-098612-1' })[0]), true);
  eq('a year in the URL is not a requisition', reqNumbers('https://x.test/2027-Engineer-Program/12394'), ['12394']);
  // F-738: a tenant code, a site code and a UUID are not requisitions.
  eq('UKG tenant code and UUIDs are not requisitions',
    reqNumbers('https://recruiting.ultipro.com/ROL1001RBCAI/JobBoard/323503a8-be53-4e45-a425-31ab5d011434/OpportunityDetail?opportunityId=b7892288-647c-48a8-9b92-60c66d10a53f'), []);
  eq('Oracle\'s site code is not, its job number is', reqNumbers('https://iadugs.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/1246'), ['1246']);
  eq('a LinkedIn slug ends on its id', reqNumbers('https://www.linkedin.com/jobs/view/manufacturing-engineer-at-legrand-4470601942'), ['4470601942']);
  eq('a Workday slug ends on its requisition', reqNumbers('https://jj.wd5.myworkdayjobs.com/JJ/job/Santa-Clara/Operations-Process-Engineer--Capital-System-_R-098612-1'), ['098612']);
  eq('what he already has at a company reaches the reader', priorAt(d2, { id: 'new9', company: 'acme' }), ['Engineer [inbox]']);
  eq('…and it is in the prompt', promptFor({ company: 'Acme', title: 'Engineer' }, 'body', 'cv', ['Engineer [applied]']).includes('Engineer [applied]'), true);
  eq('…and a different city in the title is a separate opening, not a duplicate', /differs only in the CITY or SITE/.test(promptFor({ company: 'Acme', title: 'Engineer' }, 'body', 'cv', ['Engineer [applied]'])), true);
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
  const s = notInterestingCompanies(file, path.join(dir, 'none.json'));
  eq('Seek Thermal is skipped', s.has('seek thermal'), true);
  eq('a job hidden for another reason does not skip its employer', s.has('arista networks'), false);
  // He took employers back off the list on 2026-10-08; his skip reasons stay as written.
  const cleared = path.join(dir, 'cold-cleared.json');
  writeFileSync(cleared, JSON.stringify({ cleared: ['Seek Thermal'] }));
  eq('an employer he took back off the list is read like anyone else', notInterestingCompanies(file, cleared).has('seek thermal'), false);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n🧪 curate: his kind of employer is read first, and nothing is excluded for taste');
{
  const liked = new Set(['applied materials']);
  const cold = new Set(['seek thermal']);
  eq('an employer he applied to leads', tierOf('Applied Materials', { liked, cold }), 0);
  eq('a frontier employer is next', tierOf('Figure', { liked, cold }), 1);
  eq('everyone else after that', tierOf('Cretex Medical', { liked, cold }), 2);
  eq('"not interesting" is last — read, never skipped', tierOf('Seek Thermal', { liked, cold }), 3);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
