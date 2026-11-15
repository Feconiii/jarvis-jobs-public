// The daily curation (jarvis/curate.mjs). Run: node jarvis/curate.test.mjs
//
// "bro i thought we supposed to do a run everyday how did i run out of jobs"
// (2026-09-24). No model is called and his store is never touched: the model
// and the filing are stand-ins, the store is a temporary one.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from './db.mjs';
import { curate, parseVerdict, TITLE_OUT, titleOut, CAPPED, openPicks, promptFor, priorAt, reqNumbers, notInterestingCompanies, tierOf, employerClass, employerVerdict, vcListed, daily, STRETCH_LABEL } from './curate.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const ok = (name, cond) => eq(name, !!cond, true);

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
  // F-979: a pick read from a short body (no requirements section) says so on the card.
  eq('a pick from a short body is marked low confidence', /Low confidence: the posting's own description is short \(\d+ characters, no requirements section\); read the posting before applying\.$/.test(picks.notes.k), true);
  {
    const full = [];
    await curate({
      dbPath, root: dir, target: 50, candidates: [{ id: 'f1', company: 'F', title: 'Equipment Engineer' }], log: () => {},
      readDesc: () => `${'Responsibilities: equipment work in the fab. '.repeat(15)}\nRequirements: Bachelor's degree in Mechanical Engineering, 0-2 years of experience.`,
      ask: async () => '{"verdict":"KEEP","why":"0-2 years","note":"Equipment work like his AMAT internship."}',
      file: (ids, notes) => full.push(notes),
    });
    eq('…and a pick from a full body is not', /Low confidence/.test(JSON.stringify(full)), false);
  }
  // F-934, 2026-11-04: a reach is labelled on the card, never dropped.
  {
    const { reachOf, REACH_LABEL } = await import('./curate.mjs');
    eq('the reader\'s reach is kept', parseVerdict('{"verdict":"MAYBE","why":"x","note":"Catch: sensors.","reach":"field"}')?.reach, 'field');
    eq('an unknown reach is nothing', parseVerdict('{"verdict":"MAYBE","why":"x","note":"y","reach":"vibes"}')?.reach, undefined);
    eq('a drop carries no reach', parseVerdict('{"verdict":"DROP","why":"x","reach":"degree"}')?.reach, undefined);
    eq('the prompt asks for it', /"reach":null\|"degree"\|"field"\|"level"/.test(promptFor({ company: 'A', title: 'B' }, 'body', 'cv')), true);
    eq('Field AI\'s own catch names the degree', reachOf({ verdict: 'MAYBE', note: 'Worth a look: The degree list never names mechanical engineering, and the core work is sensor electronics, protocols, ROS timing and optics, which is a stretch.' }), 'degree');
    eq('Coherent\'s "reads more like materials" names the field', reachOf({ verdict: 'MAYBE', note: 'Catch: the core job is crystal growth furnace work, so it reads more like materials process than mechanical.' }), 'field');
    eq('Micron\'s "Equipment Engineer 2" profile names the level', reachOf({ verdict: 'MAYBE', note: 'Worth a look: the job profile is "Equipment Engineer 2" and the work is keeping CMP tools running.' }), 'level');
    eq('a plain catch is no reach', reachOf({ verdict: 'MAYBE', note: 'Worth a look: second shift. Fixture design like his AMAT work.' }), null);
    // Review, 2026-11-04: each names the reach only in so many words.
    const M = (note) => reachOf({ verdict: 'MAYBE', note });
    eq('"not an experienced hire role" is no reach', M('Worth a look: this is not an experienced hire role; the years line says 0-2.'), null);
    eq('"isn\'t an experienced hire" is no reach', M('It isn\'t an experienced hire posting. Fixture work fits.'), null);
    eq('"an experienced hire" still is', M('Catch: the pay band reads as an experienced hire. Fixture work fits.'), 'level');
    eq('"core work is mechanical design, no software" is no reach', M('The core work is mechanical design, no software. His CAD fits.'), null);
    eq('"electronics-adjacent" is no reach', M('The core work is electronics-adjacent packaging design. His CAD fits.'), null);
    eq('"doesn\'t read like software" is no reach', M('It doesn\'t read like software work at all. His CAD fits.'), null);
    eq('"core work is sensor electronics" still is', M('Catch: the core work is sensor electronics and ROS timing.'), 'field');
    eq('"the degree list leads with mechanical" is no reach', M('The degree list leads with mechanical engineering. His CAD fits.'), null);
    eq('"the degree list leads with Chemical" still is', M('Catch: the degree list leads with Chemical and Materials Science.'), 'degree');
    eq('"the degree list omits nothing" is no reach', M('The degree list omits nothing he holds. His CAD fits.'), null);
    eq('"job profile is a role needing 2 years" is no reach', M('Worth a look: the job profile is a role needing 2 years of CAD.'), null);
    eq('"job profile is Engineer II, with" still is', M('Catch: the job profile is Manufacturing Engineer II, with a 0-2 years line.'), 'level');
    const notes = {};
    await curate({
      dbPath, root: dir, target: 50, log: () => {}, screen: () => null,
      candidates: [{ id: 'r1', company: 'R', title: 'Sensor Engineer' }, { id: 'r2', company: 'S', title: 'Fixture Engineer' }],
      readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
      ask: async (p) => (p.includes('body for r1.') ? '{"verdict":"MAYBE","why":"sensors","note":"Catch: sensor electronics. Fixture work like his AMAT internship.","reach":"field"}'
        : '{"verdict":"KEEP","why":"0-2 years","note":"Fixture design like his AMAT internship. It says 0-2 years."}'),
      file: (ids, n) => Object.assign(notes, n),
    });
    eq('a reach card says so first', notes.r1?.startsWith(`Reach: ${REACH_LABEL.field}. Worth a look: Catch: sensor electronics.`), true);
    eq('…and a fit card is unchanged', /Reach:/.test(notes.r2 || ''), false);
  }
  // 2026-11-04: the proof run's top-up goal was 10 and the last batch filed 11.
  {
    const asked = [];
    const r2 = await curate({
      dbPath, root: dir, target: 50, candidates: ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, company: 'G', title: `Equipment Engineer ${id}` })), log: () => {}, stopAfter: 2,
      readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
      ask: async (prompt) => { asked.push(prompt); return '{"verdict":"KEEP","why":"0-2 years","note":"Equipment work like his AMAT internship."}'; },
      file: () => {},
    });
    eq('a batch stops filing at the number still wanted (the top-up is a cap)', [r2.kept.length, asked.length], [2, 2]);
  }
  // F-978 review: a body borrowed from a copy is named to the reader and on the card.
  {
    const h = openDb(dbPath);
    h.prepare(`INSERT INTO jobs (id, url, title, company, location, status, first_seen, last_seen, fit_score, has_desc, source)
      VALUES ('li1', 'https://www.linkedin.com/jobs/view/1', 'Equipment Engineer', 'G', 'Boise, ID', 'new', '2026-11-01', '2026-11-01', 90, 1, 'linkedin')`).run();
    h.prepare(`INSERT INTO jobs (id, url, title, company, location, status, first_seen, last_seen, fit_score, has_desc, source, body_from, enriched_at, desc_len)
      VALUES ('cp1', 'https://g.wd1.myworkdayjobs.com/x/job/1', 'Equipment Engineer', 'G', 'Boise, ID', 'new', '2026-11-01', '2026-11-01', 90, 1, 'workday', 'copy:li1', ?, 900)`).run(new Date().toISOString());
    h.close?.();
    const seen = []; const notes = [];
    await curate({
      dbPath, root: dir, target: 50, candidates: [{ id: 'cp1', company: 'G', title: 'Equipment Engineer' }], log: () => {},
      readDesc: () => `${'Responsibilities: equipment work in the fab. '.repeat(15)}\nRequirements: Bachelor's degree in Mechanical Engineering, 0-2 years of experience.`,
      ask: async (prompt) => { seen.push(prompt); return '{"verdict":"KEEP","why":"0-2 years","note":"Equipment work like his AMAT internship."}'; },
      file: (ids, n) => notes.push(n),
    });
    eq('the reader is told the description came from a copy', seen.some((p) => /This description comes from a copy of the posting on linkedin, not the employer's own board/.test(p)), true);
    eq('…and the card says so', /read from a copy of the posting on linkedin/.test(JSON.stringify(notes)), true);
  }
  // F-984: the reader is told the Department's engineering-petition count, not the ledger's evidence.
  {
    const seen = [];
    await curate({
      dbPath, root: dir, target: 50, candidates: [{ id: 'f9', company: 'Micron Technology', title: 'Equipment Engineer' }], log: () => {},
      readDesc: () => `${'Responsibilities: equipment work in the fab. '.repeat(15)}\nRequirements: Bachelor's degree in Mechanical Engineering, 0-2 years of experience.`,
      ask: async (prompt) => { seen.push(prompt); return '{"verdict":"DROP","why":"test"}'; },
      file: () => {}, dol: (c) => (c === 'Micron Technology' ? 232 : null), taste: false,
    });
    eq('the reader gets the file\'s own count', seen.some((p) => /Certified H-1B engineering petitions on record: 232\./.test(p)), true);
  }

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

  // One role, one pick (F-935): Honda's two requisitions for the same role in
  // the same place were both filed in one run; the second is now turned down
  // unread, and so is a copy of a role already open in his inbox.
  {
    const twin = [{ id: 'h1', company: 'Honda', title: 'Manufacturing Equipment Engineer', location: 'Lincoln, AL' },
      { id: 'h2', company: 'Honda', title: 'Manufacturing Equipment Engineer', location: 'Lincoln, AL' },
      { id: 'o2', company: 'Acme', title: 'Engineer', location: 'Boise, ID' }];
    let asked = 0;
    const r2 = await curate({
      dbPath, root: dir, target: 50, candidates: twin, log: () => {},
      readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
      ask: async () => { asked++; return '{"verdict":"MAYBE","why":"ok","note":"Equipment work like his AMAT internship."}'; },
      file: () => {},
    });
    eq('the first copy is read and filed', r2.maybe.map((x) => x.id), ['h1']);
    eq('the second copy and the one already in his inbox are turned down unread', r2.dropped.map((x) => x.id).sort(), ['h2', 'o2']);
    eq('…without a model call', asked, 1);
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
    const marked = [];
    const rr = await curate({
      dbPath, root: dir, target: 50, candidates: li, log: () => {},
      readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
      route: async (u) => routes[u.match(/(\d+)$/)[1]] || null,
      markRoute: async (id, how) => { marked.push([id, how]); },
      ask: async (prompt) => { asked.push(prompt); return '{"verdict":"KEEP","why":"fits","note":"Fits. Wins."}'; },
      file: (ids, notes, opts = {}) => filed2.push({ ids, notes, undo: !!opts.undo }),
    });
    eq('Easy Apply is turned down, the company-site and unknown ones are read', [rr.dropped.map((x) => x.id), rr.kept.map((x) => x.id)], [['ez'], ['off', 'unk']]);
    eq('…without asking the model', asked.some((p) => p.includes('body for ez.')), false);
    eq('…and the reason is on the row', /Easy Apply only/.test(filed2.find((x) => x.undo).notes.ez), true);
    // F-968: the route is recorded through the store's writer, not curate's own UPDATE.
    eq('each route LinkedIn states is recorded through the store\'s writer', marked, [['ez', 'easy-apply'], ['off', 'offsite']]);
    const { storeRouteWriter } = await import('./curate.mjs');
    eq('…and a run against another file than the store records nothing (never his store)', await storeRouteWriter(dbPath), null);
    const store = await import('./store.mjs');
    eq('…while the store\'s own file gets the store\'s writer', (await storeRouteWriter(store.dbPath())) === store.setApplyRoute, true);
    // Review, 2026-11-04: the same file spelled another way is still the store.
    const real = path.resolve(store.dbPath());
    const spelled = process.platform === 'win32' ? real.replace(/\\/g, '/').replace(/^([a-z]):/i, (m) => m.toLowerCase()).replace(/jarvis/i, 'JARVIS') : real;
    eq('…spelled with forward slashes and another case', (await storeRouteWriter(spelled)) === store.setApplyRoute, true);
    const { samePath } = await import('./curate.mjs');
    eq('…and two different files are two', samePath(real, dbPath), false);
    eq('…nor is an empty path the store', samePath('', real), false);
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
  eq('what he already has at a company reaches the reader', priorAt(d2, { id: 'new9', company: 'acme' }), ['Engineer [inbox] — Boise, ID']);
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

// F-767. Three turn-downs from the 2026-10-03 and 10-08 runs, their reasons
// and the posting lines word for word, against a stubbed model.
console.log('\n🧪 curate: a drop its own brief says is not one is asked again (F-767)');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-767-'));
  const dbPath = path.join(dir, 'jobs.db');
  writeFileSync(path.join(dir, 'cv-short.md'), '# Alex Rivera\nBS Mechanical Engineering');
  openDb(dbPath).close?.();
  const pad = 'Design, build and test fixtures and equipment for production. Work with technicians and suppliers on drawings, tolerances and root cause. '.repeat(4);
  const samsungBody = `Metals Process Engineer\nResponsibilities\n${pad}\nQualifications\nBachelor's degree in Mechanical, Chemical or Materials Engineering.\nU.S. Export Control\nThis role may require access to information subject to U.S. export control laws. Applicants must be authorized to access such information or eligible for government authorization.`;
  const oceanBody = `Mechanical Engineer\nResponsibilities\n${pad}\nQualifications\n• Bachelor's degree in Engineering, preferably Mechanical Engineering\n• 0 to 2 years of related experience\n• Experience working in the Oil & Gas, Manufacturing or related industry.`;
  const rosenBody = `The Mechanical Engineer will design, develop, and test sub-systems related to firetrucks.\n${pad}\nRequirements\n• Bachelor's degree in Mechanical Engineering.\n• 0-3 years of related mechanical engineering experience required.\n• Experience in heavy truck and/or automotive systems preferred.`;
  const samsung = { id: 'sam', company: 'Samsung Electronics America', title: 'Metals Process Engineer' };
  const ocean = { id: 'oce', company: 'Oceaneering', title: 'Mechanical Engineer' };
  const rosen = { id: 'ros', company: 'Rosenbauer America', title: 'RMN Mechanical Engineer' };
  const first = {
    sam: '{"verdict":"DROP","why":"Degree and years pass, but the posting states \'U.S. Export Control: applicants must be authorized to access such information or eligible for government authorization\'. This is not the routine licensing-review line. It reads as a US-person style authorization requirement"}',
    oce: '{"verdict":"DROP","why":"The work is oil and gas product engineering (ASME/API/NACE specs, offshore design office, oil and gas industry experience desired), which is outside his target industries. Degree and 0-2 years would pass."}',
    ros: '{"verdict":"DROP","why":"Fire-truck (heavy vehicle) manufacturing isn\'t one of his target industries, and the role is sustaining-style: QMS corrective action, customer returns and field issue resolution. It also lists 0-3 years as required, which is a 3-year upper bound."}',
  };
  const bodies = { sam: samsungBody, oce: oceanBody, ros: rosenBody };
  // The checks themselves, no model.
  const { dropExceptions } = await import('./curate.mjs');
  const keys = (id, j) => dropExceptions(parseVerdict(first[id]), j, bodies[id]).map((f) => f.key).sort();
  eq('Samsung: the licence line is an exception', keys('sam', samsung), ['licence']);
  eq('Oceaneering: oil & gas (widened 2026-10-08) is an exception', keys('oce', ocean).includes('widened-sectors'), true);
  eq('Rosenbauer: "0-3 years" and heavy vehicles are both exceptions', keys('ros', rosen), ['widened-sectors', 'zero-years']);
  // F-953: KLA's ladder — a 0-year route behind a Doctorate or Master's is no route for a Bachelor's.
  const kla = { id: 'kla', company: 'KLA Corporation', title: 'Service System Engineer (Mechanical/Optical)' };
  const klaWhy = { verdict: 'DROP', why: "Bar 1 fails: the Bachelor's line requires 5 years of related work experience." };
  const ladder = (bach) => `${pad}\nMinimum Qualifications\n• Doctorate (Academic) Degree and 0 years related work experience; Master's Level Degree and related work experience of 3 years; Bachelor's Level Degree and related work experience of ${bach}`;
  eq('KLA: "Doctorate and 0 years; Bachelor\'s and 5 years" is no zero-years way in', dropExceptions(klaWhy, kla, ladder('5 years')).map((f) => f.key), []);
  eq('…nor "Master\'s and 0 years; Bachelor\'s and 2 years"', dropExceptions(klaWhy, kla, `${pad}\nMinimum Qualifications\n• Master's Level Degree and 0 years related work experience; Bachelor's Level Degree and related work experience of 2 years`).map((f) => f.key), []);
  eq('a Bachelor\'s 0-year route still is one', dropExceptions(klaWhy, kla, `${pad}\nMinimum Qualifications\n• Bachelor's degree and 0-2 years of related work experience`).map((f) => f.key), ['zero-years']);
  // His rule 2026-11-06: a program for his graduating class never fails on years.
  const formlabs = { id: 'fl', company: 'Formlabs', title: 'Manufacturing Engineer - May 2027 Graduates' };
  const flWhy = { verdict: 'DROP', why: "Requires 1-3 years of experience in two places ('1-3 Years experience in Design and Manufacturing Engineering roles')." };
  eq('Formlabs\' May 2027 Graduates role dropped on years gets the program rule', dropExceptions(flWhy, formlabs, `${pad}\n• 1-3 Years experience in Design and Manufacturing Engineering roles`).map((f) => f.key), ['grad-program-years']);
  // (At a non-robotics employer: at a robotics one the 1-2-year stretch rule answers instead.)
  eq('…an ordinary title with the same drop does not', dropExceptions(flWhy, { ...formlabs, company: 'Acme Valves', title: 'Manufacturing Engineer' }, `${pad}\n• 1-3 Years experience in Design and Manufacturing Engineering roles`).map((f) => f.key), []);
  eq('…and a program dropped for another reason gets nothing', dropExceptions({ verdict: 'DROP', why: 'Field service role with 80% travel.' }, formlabs, pad).map((f) => f.key), []);
  // His words 2026-11-06: "i dont like specific sub process welding is kinda lame".
  eq('a welding title is out', titleOut('Manufacturing Engineer - Welding'), true);
  eq('…so is a joining one', titleOut('Manufacturing Engineer, Joining Process, Optimus'), true);
  eq('…a broad manufacturing title is not', titleOut('Manufacturing Engineer'), false);
  eq('…nor one that lists welding among other processes', titleOut('Manufacturing Engineer (Welding, Machining, Assembly)'), false);
  eq('…while welding plus brazing is still one sub-process', titleOut('Manufacturing Engineer (Welding/Brazing)'), true);
  eq('a program asking 3+ years gets no program exception', dropExceptions(flWhy, formlabs, `${pad}\nMinimum Qualifications\n• 3+ years of experience in manufacturing engineering`).map((f) => f.key), []);
  // His answer 2026-11-06 ("5. ye"): a robotics role asking 1-2 years is a stretch, filed after the fits.
  const figure = { id: 'fg', company: 'Figure AI', title: 'Mechanical Engineer, Arms' };
  const fgWhy = { verdict: 'DROP', why: 'screened before reading: requires 2+ years and offers no lower path' };
  const twoYrs = `${pad}\nMinimum Qualifications\n• 2+ years of experience in mechanical engineering`;
  eq('a robotics role dropped for 2+ years gets the stretch exception', dropExceptions(fgWhy, figure, twoYrs).map((f) => f.key), ['stretch-years']);
  eq('…not a field service role at the same company', dropExceptions(fgWhy, { ...figure, title: 'Field Service Engineer' }, twoYrs).map((f) => f.key), []);
  eq('…not a quality role', dropExceptions(fgWhy, { ...figure, title: 'Quality Engineer Manufacturing' }, twoYrs).map((f) => f.key), []);
  eq('…not a non-robotics employer', dropExceptions(fgWhy, { ...figure, company: 'Acme Valves' }, twoYrs).map((f) => f.key), []);
  eq('…not 3+', dropExceptions(fgWhy, figure, `${pad}\nMinimum Qualifications\n• 3+ years of experience in mechanical engineering`).map((f) => f.key), []);
  eq('the stretch label is the one the dashboard sorts on', STRETCH_LABEL, 'Stretch: asks 1-2 yrs.');
  eq('a real U.S.-person list is no exception',
    dropExceptions({ verdict: 'DROP', why: 'U.S. person required by export control' }, samsung,
      `${pad}\nQualifications\nBachelor's in ME.\nThis position requires the candidate to be a U.S. Citizen, lawful permanent resident of the U.S., protected individual as defined by 8 U.S.C. 1324b(a)(3), or eligible to obtain the required authorizations from the U.S. Department of State.`).length, 0);
  eq('a required 2+ years is no exception',
    dropExceptions({ verdict: 'DROP', why: 'Requires a minimum of 2 years of relevant experience' }, ocean, `${pad}\nRequirements\n• Minimum of 2 years of engineering experience required.`).length, 0);
  eq('nuclear stays out, energy or not', dropExceptions({ verdict: 'DROP', why: 'Nuclear energy plant fleet support is outside his sectors' }, ocean, pad).length, 0);
  eq('a KEEP is never second-guessed', dropExceptions({ verdict: 'KEEP', why: 'oil and gas, outside his industries', note: 'x' }, ocean, oceanBody).length, 0);

  // The run: the first answer is the stored turn-down, the second is the re-read.
  const second = {
    sam: '{"verdict":"KEEP","why":"metals process work, licence line only","note":"Wafer-fab process work close to his AMAT internship. The export line is a licence review."}',
    oce: '{"verdict":"MAYBE","why":"offshore travel","note":"Offshore travel is the catch. Mechanical design of subsea equipment, 0 to 2 years."}',
    ros: '{"verdict":"DROP","why":"0-3 years is a 3-year bar"}',
  };
  const prompts = [];
  const filed = [];
  const r = await curate({
    dbPath, root: dir, target: 50, candidates: [samsung, ocean, rosen], log: () => {},
    readDesc: (_db, id) => bodies[id], screen: () => null,
    ask: async (p) => { prompts.push(p); const id = Object.keys(bodies).find((k) => p.includes(bodies[k].slice(0, 60))); return p.includes('A CHECK ON YOUR FIRST ANSWER') ? second[id] : first[id]; },
    file: (ids, notes, opts = {}) => filed.push({ ids, notes, undo: !!opts.undo }),
  });
  eq('each excepted drop is asked once more, no more', prompts.length, 6);
  eq('…and the second question names the rule', /a licence he can be granted/.test(prompts.find((p) => p.includes('A CHECK') && p.includes('Metals Process'))), true);
  eq('Samsung is kept on the second read', r.kept.map((x) => x.id), ['sam']);
  eq('Oceaneering is worth a look on the second read', r.maybe.map((x) => x.id).sort(), ['oce', 'ros']);
  eq('Rosenbauer, dropped twice on its zero range, is filed as worth a look, not turned down', r.dropped.length, 0);
  eq('…and its card says why', /turned this down twice/.test(r.maybe.find((x) => x.id === 'ros').note), true);
  eq('nothing was filed as Not curated', filed.filter((x) => x.undo).length, 0);

  // 2026-10-20: a second drop that names another reason stands.
  const { otherDropReason } = await import('./curate.mjs');
  eq('Salas O\'Brien: a relevance drop is not a years drop',
    !!otherDropReason('Relevance bar fails: the work is MEP building design (HVAC systems and load calculations for buildings). It also lists 2 years preferred.'), true);
  eq('Supermicro: a duplicate stands',
    !!otherDropReason('Years bar fails: 5+ years with a Bachelor\'s. The title also duplicates the Optical Manufacturing Engineer already in his inbox from Supermicro.'), true);
  // FRALOCK Mfg Eng I was filed 11-03 when a years exception overruled this.
  eq('FRALOCK: a U.S.-person requirement beside a years line stands',
    !!otherDropReason('Requires U.S. person status under ITAR/EAR, which he cannot meet as an F-1 student, and asks for 2+ years.'), true);
  // F-956: the same title at another site is another job.
  {
    const { dropExceptions: dx, samePlace, sameTitleRows } = await import('./curate.mjs');
    const totowa = { company: 'KLA Corporation', title: 'Mechanical Design Engineer', location: 'Totowa, NJ' };
    const dupWhy = { verdict: 'DROP', why: "Same title as 'Mechanical Design Engineer', which is already on his list three times" };
    const elsewhere = [{ title: 'Mechanical Design Engineer', status: 'rejected', location: 'Milpitas, CA' }, { title: 'Mechanical Design Engineer (101531)', status: 'applied', location: 'Ann Arbor, MI' }];
    eq('Milpitas and US-CA-Milpitas are one place', samePlace('Milpitas, CA', 'US-CA-Milpitas'), true);
    eq('…Totowa and Milpitas are two', samePlace('Totowa, NJ', 'Milpitas, CA'), false);
    eq('…a state alone names no place', samePlace('California', 'Milpitas, CA'), null);
    eq('the requisition number is not part of the title', sameTitleRows(elsewhere, totowa).length, 2);
    eq('KLA Totowa: a "same title" drop against other sites is re-asked', dx(dupWhy, totowa, '', { prior: elsewhere }).map((f) => f.key), ['other-site']);
    eq('…not when one is at the same site', dx(dupWhy, totowa, '', { prior: [...elsewhere, { title: 'Mechanical Design Engineer', status: 'inbox', location: 'Totowa, New Jersey' }] }).length, 0);
    eq('…nor when he hid that title', dx(dupWhy, totowa, '', { prior: [{ title: 'Mechanical Design Engineer', status: 'hidden', location: 'Milpitas, CA' }] }).length, 0);
    eq('…nor when no prior row is passed', dx(dupWhy, totowa, '').length, 0);
    eq('after that check, "same title" is not another reason', otherDropReason(dupWhy.why, { sameTitleOk: true }), null);
    eq('…but sustaining work still is', !!otherDropReason(`${dupWhy.why}; the role is sustaining work`, { sameTitleOk: true }), true);
  }
  eq('Rosenbauer\'s "0-3 years is a 3-year bar" is only the excepted reason', otherDropReason('0-3 years is a 3-year bar'), null);
  eq('…and so is an industry the brief widened', otherDropReason('Fire-truck manufacturing is outside his target industries; 0-3 years required.'), null);
  // F-934, 2026-11-04: the same Salas O'Brien posting, worded by bar number, went in his inbox.
  const salasWhy = 'Fails bar 2: the work is HVAC, plumbing and fire-protection design for buildings (MEP), which is named as outside his relevant fields. The 0-3 years line passes, so years are not the reason; the employer is also a traditional building-services consultancy (bar 3).';
  eq('a failed bar 2, named by number, is another reason', !!otherDropReason('Fails bar 2: the posting is grid protection relay work. The 0-2 years line passes.'), true);
  eq('…and so is a failed bar 3', !!otherDropReason('Bar 3 fails: a small regional contractor. 0-3 years passes.'), true);
  eq('…and the brief\'s own bar-2 list, however worded', !!otherDropReason(salasWhy), true);
  eq('a bar 1 failure is still only the excepted reason', otherDropReason('Fails bar 1: 0-3 years read as a 3-year bar'), null);
  // Review, 2026-11-04: the number must own the verb, and a maker's HVAC product is his work.
  eq('"bar 2 passes, bar 1 fails" is a bar-1 drop, still rescued', otherDropReason('Bar 2 passes, bar 1 fails: 0-3 years read as a 3-year bar'), null);
  eq('"does not fail bar 2" is a bar-1 drop, still rescued', otherDropReason('The work does not fail bar 2; 0-3 years is a 3-year bar'), null);
  eq('"Bar 2 fails? no" is a bar-1 drop, still rescued', otherDropReason('Bar 2 fails? No. 0-3 years is a 3-year bar'), null);
  eq('an HVAC product role at a maker with a years-only drop is still rescued',
    otherDropReason('HVAC equipment design at a chiller manufacturer; 0-3 years is a 3-year bar'), null);
  eq('…and so is fire-protection product engineering at a sprinkler maker', otherDropReason('Fire-protection sprinkler product design engineer; 2 years required'), null);
  eq('"Fails bar #2" is another reason', !!otherDropReason('Fails bar #2: civil/construction site work. 0-2 years passes.'), true);
  eq('"fails the second bar" is another reason', !!otherDropReason('It fails the second bar: grid protection relays. The years line passes.'), true);
  eq('"Bar 2: fail" is another reason', !!otherDropReason('Bar 2: fail, the role is building-services design. 0-3 years passes.'), true);
  // Second review, 2026-11-04: a bar not passed is a bar failed.
  for (const w of ["Doesn't pass bar 2: grid relay work. 0-2 years passes.", 'It does not pass bar 2; the 0-3 years line is fine',
    'Bar 2 does not pass: building-services work', 'Fails to meet bar 3: a regional contractor', 'Doesn’t clear bar 2 (curly apostrophe)', 'Bar 2: field is not met. 0-3 years passes.']) {
    eq(`"${w.slice(0, 40)}…" is another reason`, !!otherDropReason(w), true);
  }
  eq('"Bar 2: does not fail" is still a bar-1 drop', otherDropReason('Bar 2: does not fail. 0-3 years is a 3-year bar'), null);
  eq('MEP design for manufacturing plants is his work, still rescued', otherDropReason('MEP design for manufacturing plants; 0-3 years is a 3-year bar'), null);
  eq('building design named without a bar number is another reason', !!otherDropReason('HVAC and plumbing design for commercial buildings at an MEP design firm; the 0-3 years line passes'), true);
  {
    // End to end: a zero-years route asks again, the second read drops on the
    // field, and the drop stands (it was filed as worth a look before).
    const fieldRun = await curate({
      dbPath, root: dir, target: 50, candidates: [rosen], log: () => {}, readDesc: (_db, id) => bodies[id], screen: () => null,
      ask: async (p) => (p.includes('A CHECK ON YOUR FIRST ANSWER') ? JSON.stringify({ verdict: 'DROP', why: salasWhy }) : first.ros),
      file: () => {},
    });
    eq('a field drop is never overruled by the zero-years exception', [fieldRun.dropped.length, fieldRun.maybe.length, fieldRun.kept.length], [1, 0, 0]);
    const licRun = await curate({
      dbPath, root: dir, target: 50, candidates: [samsung], log: () => {}, readDesc: (_db, id) => bodies[id], screen: () => null,
      ask: async (p) => (p.includes('A CHECK ON YOUR FIRST ANSWER') ? JSON.stringify({ verdict: 'DROP', why: 'Fails bar 2: building HVAC commissioning work. The export line is a licence he can be granted.' }) : first.sam),
      file: () => {},
    });
    eq('…nor by the licence exception', [licRun.dropped.length, licRun.maybe.length, licRun.kept.length], [1, 0, 0]);
  }
  {
    // F-1041: 16 of the 22 "worth a look" overrides since 10-28 were the reader's correct second drop.
    const { secondDropStands, concedesException, realYearsBar, statedFailure, dropIfStated } = await import('./curate.mjs');
    const Z = ['zero-years'];
    for (const [who, w] of [
      ['AtkinsRéalis', "Nuclear plant work: a CANDU station at Pickering with nuclear fleet support, which he turned down by name ('i dont like nuclear'). The 0-3 years range passes, but the nuclear bar still fails."],
      ['Snap-on', 'Traditional tool maker with a mature vehicle-repair tool line and 0 certified H-1B engineering petitions on record, so it fails his employer test for an OPT-to-H-1B path despite passing the years bar.'],
      ['Eos', 'Core work is teardown, testing and failure analysis of battery units plus incoming-parts quality, which is test and quality work he has turned down; the degree and 0–2 years pass.'],
      ['PM Group', 'CQV validation and qualification testing in pharma/biotech GMP is a validation and test role plus a documentation desk, and pharma is outside his fields. Degree and 0-3 years pass.'],
      ['DuBois', 'Field role: on-site evaluations, installation and startup at customer sites, and 50–60% travel. The 0–2 years line passes, so years is not the reason.'],
      ['First Solar', "Pay: the posted range is $56,100-$80,000, which tops out at his $80K floor. The first answer's years objection is cleared: the Bachelor's path starts at 0-2 years."],
      ['NextEra', 'Nuclear utility fleet work at Duane Arnold, which he has ruled out.'],
      ['Illuminate', 'The work is maintenance engineering: most duties are PM schedules and routine repairs, which his rules drop as maintenance.'],
    ]) eq(`${who}: a second drop on another bar stands`, !!secondDropStands(w, '', Z), true);
    eq('Rosenbauer\'s "0-3 years is a 3-year bar" is still overruled', secondDropStands('0-3 years is a 3-year bar', rosenBody, Z), null);
    eq('…and so is "0-3 years … fails bar 1" (a failure about years is the excepted reason)', secondDropStands('Required 0-3 years is a 3-year bar, so it fails bar 1', rosenBody, Z), null);
    eq('"does not pass" concedes nothing', concedesException('The 0-3 years line does not pass', 'zero-years'), null);
    eq('"no bar passes" concedes nothing', concedesException('No years bar passes here', 'zero-years'), null);
    const intelBody = `${pad}\nMinimum Qualifications\nBachelor's degree in Mechanical Engineering with 4+ years of relevant semiconductor industry experience, or Master's with 2+ years. This is an entry level position.`;
    eq('Intel: the reader held to a "4+ years" the posting prints', realYearsBar('The bachelor\'s rung requires 4+ years of semiconductor experience', intelBody, 'zero-years'), '4+ years');
    eq('…a "4+ years" the posting does not print is no bar', realYearsBar('requires 4+ years', rosenBody, 'zero-years'), null);
    eq('a "3 years" inside "0-3 years" is no bar', realYearsBar('3 years required', rosenBody, 'zero-years'), null);
    eq('a preferred 2 years is no bar', realYearsBar('requires 2 years', `${pad}\n• 0-1 years required.\n• 2 years of CAD experience preferred.`, 'zero-years'), null);
    eq('a preferred 3 years is one (his rule)', realYearsBar('3 years preferred counts as required', `${pad}\n• 0-1 years required.\n• 3 years of CAD experience preferred.`, 'zero-years'), '3 years');
    eq('"graduated within the last 2 years" is no experience line', realYearsBar('2 years', `${pad}\n• Graduated within the last 2 years.`, 'zero-years'), null);
    eq('Formlabs at a robotics stretch: a required "three years" of sourcing stands',
      realYearsBar("Required 'at least three years of sourcing or purchasing work experience' is a 3+ years line", `${pad}\n• At least three years of sourcing or purchasing work experience.`, 'stretch-years'), 'three years');
    eq('Zipline at a robotics stretch: a preferred "5–7 years" does not (he applied, 2026-11-06)',
      realYearsBar('"5–7 years of relevant experience preferred" is 3+ years', `${pad}\nRequired: 2+ years of hands-on manufacturing engineering experience.\nPreferred: 5–7 years of relevant experience preferred.`, 'stretch-years'), null);
    eq('…a stretch 2 is no bar at a robotics company', realYearsBar('requires 2+ years', twoYrs, 'stretch-years'), null);
    // Peterbilt, 2026-11-03: "New graduates are encouraged to apply" beside a required 5+.
    const peter = { id: 'pet', company: 'Peterbilt Motors Company', title: 'Product Engineer' };
    bodies.pet = `${pad}\nRequirements\n• Bachelor's degree in Mechanical Engineering.\n• 5+ years of relevant experience.\nNew graduates are encouraged to apply.`;
    const peterWhy = 'Required "5+ years of relevant experience" is a 5-year bar; "New graduates are encouraged to apply" is not an exception to a required years line.';
    eq('Peterbilt\'s first drop does meet the zero-years exception', dropExceptions({ verdict: 'DROP', why: peterWhy }, peter, bodies.pet).map((f) => f.key), ['zero-years']);
    const asks = [];
    const peterRun = await curate({
      dbPath, root: dir, target: 50, candidates: [peter], log: () => {}, readDesc: (_db, id) => bodies[id], screen: () => null,
      ask: async (p) => { asks.push(p); return JSON.stringify({ verdict: 'DROP', why: peterWhy }); },
      file: () => {},
    });
    eq('end to end: asked twice, a second drop on the posting\'s own 5+ years is turned down, not filed', [asks.length, peterRun.dropped.length, peterRun.maybe.length], [2, 1, 0]);

    // The reader's own KEEP/MAYBE that states a failure.
    eq('Apple: "most duties are … the test-role pattern he turned down" is a drop',
      !!statedFailure('Design title, but most duties are failure analysis, root-cause, validation and tolerance work, the test-role pattern he turned down; bar 1 is clean since no years are stated'), true);
    eq('TRUMPF: "which is the admin work he turns down" is a drop', !!statedFailure('Degree and years pass, but most listed duties are project management, reporting and SAP upkeep, which is the admin work he turns down.'), true);
    eq('"Formlabs … so it stays a drop" is a drop', !!statedFailure('the robotics stretch covers only 1-2 years, so it stays a drop.'), true);
    for (const [who, w] of [
      ['Coherent (he applied)', 'Duties lean toward sustaining work (monitoring production data, troubleshooting yield and process issues, root cause) rather than new process design, which he has turned down.'],
      ['Cummins (he applied)', 'Cummins is a big vehicle/engine name with an ME-compatible degree and entry-level wording, but the duties lean on validation strategy and field-investigation support, which he turns down.'],
      ['onsemi (interested)', "Qualifies on degree and years, but 'Engineers may work across... industrial engineering, facilities, test, yield, quality' could place him in roles he turns down"],
      ['Caterpillar', 'Big-name diesel and gas engine employer with no years line, but the core duties include leading validation plans and turbocharger teardown, which he has turned down.'],
      ['AEP', 'Entry-level new-grad role with no years line, but the posting never names the equipment, and it could be substation electrical work, which is a drop.'],
      ['viaPhoton', "Required '1+ years of experience' with new grads welcome; no other bar fails."],
      ['an industry alone', 'Entry-level mechanical design role, but fiber optics for data centers is outside his target industries.'],
      ['a posting that fails to say', 'Mechanical design role; the posting fails to state its funding, a doubt.'],
    ]) eq(`${who}: a doubt stays a doubt`, statedFailure(w), null);
    const d = dropIfStated({ verdict: 'MAYBE', why: 'Degree and years pass, but most listed duties are project management, reporting and SAP upkeep, which is the admin work he turns down.', note: 'Worth a look: x' });
    eq('a MAYBE stating a failure becomes a DROP and says what it was', [d.verdict, d.statedAs, d.note], ['DROP', 'MAYBE', '']);
    eq('a DROP is left alone', dropIfStated({ verdict: 'DROP', why: 'fails bar 2' }).statedAs, undefined);
    const trumpf = { id: 'tru', company: 'TRUMPF', title: 'Manufacturing Engineer' };
    bodies.tru = `${pad}\nRequirements\n• Bachelor's in Mechanical Engineering.`;
    const tRun = await curate({
      dbPath, root: dir, target: 50, candidates: [trumpf], log: () => {}, readDesc: (_db, id) => bodies[id], screen: () => null,
      ask: async () => JSON.stringify({ verdict: 'MAYBE', why: 'Degree and years pass, but most listed duties are project management, reporting and SAP upkeep, which is the admin work he turns down.', note: 'Worth a look: admin heavy.' }),
      file: () => {},
    });
    eq('end to end: that MAYBE is turned down, not filed', [tRun.dropped.length, tRun.maybe.length], [1, 0]);

    // Review, 2026-11-12: each of these was wrong on 714099ed.
    for (const w of ['Not the nuclear work he ruled out; this is solar', 'None of his bars fails', 'Neither bar 1 nor bar 2 fails',
      'Unlike the validation roles he turned down, this is design work', 'Design work despite the test roles he turned down',
      'The posting says "applicants who cannot meet the onsite need are excluded", which he meets'])
      eq(`"${w.slice(0, 44)}…" states no failure`, statedFailure(w), null);
    eq('a quoted line does not hide the reader\'s own words outside it', !!statedFailure('The posting says "onsite"; most duties are audits, which he has turned down'), true);
    for (const w of ['He holds 2 years of internships, so the 0-3 years line is a 3-year bar', 'The 2+ years line passes only for PhDs',
      'The 0-3 years line passes for a Master\'s, and does not pass for a Bachelor\'s'])
      eq(`"${w.slice(0, 44)}…" grants nothing`, concedesException(w, 'zero-years'), null);
    eq('a licence drop that grants the licence line is conceded', !!concedesException('The export-control line is a licence he can be granted, so it is not the reason; the work is building HVAC design', 'licence'), true);
    eq('…one that only names it is not', concedesException('The export-control licence requirement blocks him', 'licence'), null);
    for (const b of ['Every unit carries a 5 year warranty.', 'We have seen 5 years of growth.', 'Proudly 5 years in business.'])
      eq(`"${b}" is no years bar`, realYearsBar('requires 5+ years', `${pad}\n${b}`, 'zero-years'), null);
    eq('…"5 years of relevant experience" is one', realYearsBar('requires 5 years', `${pad}\n• 5 years of relevant experience.`, 'zero-years'), '5 years');
    eq('a new-grad posting\'s required "2 years of internship or co-op" is no bar (his internships count)',
      realYearsBar('Required "2 years of internship or co-op experience" is a 2-year bar',
        `${pad}\nNew graduates are encouraged to apply.\nRequirements\n• 2 years of internship or co-op experience in manufacturing.`, 'zero-years'), null);
    eq('dropIfStated never drops a posting he applied to', dropIfStated({ verdict: 'MAYBE', why: 'most duties are audits, which he has turned down', note: 'x' }, { status: 'applied' }).verdict, 'MAYBE');
    eq('…nor one in his inbox', dropIfStated({ verdict: 'MAYBE', why: 'most duties are audits, which he has turned down', note: 'x' }, { status: 'inbox' }).verdict, 'MAYBE');
    eq('…nor one with an applied date', dropIfStated({ verdict: 'KEEP', why: 'most duties are audits, which he has turned down', note: 'x' }, { status: 'new', applied_at: '2026-11-10' }).verdict, 'KEEP');
    eq('…a new one still drops', dropIfStated({ verdict: 'MAYBE', why: 'most duties are audits, which he has turned down', note: 'x' }, { status: 'new' }).verdict, 'DROP');
  }

  // F-1042. Outside the US is turned down before any read, whatever stage
  // offered the posting: Formlabs' Shenzhen role came through the library stage.
  {
    const { outsideUs } = await import('./curate.mjs');
    const mtce = `${pad}\nJoin the innovation hub at Multimatic Technical Centre Europe (MTCE) in Thetford, UK, where design makes real-world impact.`;
    eq('a foreign location field is turned down', !!outsideUs({ location: 'Shenzhen', title: 'Process Engineer' }), true);
    eq('a town the posting places in the UK is turned down', outsideUs({ location: 'Thetford, Norfolk', title: 'Structures Engineer' }, mtce), 'Outside the US: Thetford, Norfolk (the posting places it in UK)');
    eq('…the same town with no country in the text is read as usual', outsideUs({ location: 'Thetford, Norfolk', title: 'Design Engineer' }, pad), null);
    eq('"Broughton, North Wales" needs both words', !!outsideUs({ location: 'Broughton', title: 'Placement' }, `${pad}\nBased at our site in Broughton, North Wales.`), true);
    eq('"Morton Grove, IL office seeks a Sr" is Illinois, not Suriname', outsideUs({ location: 'Morton Grove', title: 'Sr Manufacturing Engineer' }, `${pad}\nOur Morton Grove, IL office seeks a Sr Manufacturing Engineer.`), null);
    eq('lowercase words are no country ("Boston, on-site at")', outsideUs({ location: 'Boston', title: 'TPM' }, `${pad}\nThis role is in Boston, on-site at our lab.`), null);
    eq('a town the text places in the US as well is read', outsideUs({ location: 'Cambridge', title: 'Engineer' }, `${pad}\nOffices in Cambridge, UK and Cambridge, MA.`), null);
    eq('a US location is never checked against the text', outsideUs({ location: 'Austin, TX', title: 'Engineer' }, `${pad}\nOur partners in Austin, UK.`), null);
    eq('remote is read as usual', outsideUs({ location: 'Remote', title: 'Engineer' }, `${pad}\nTeam in Remote, Germany.`), null);
    // Review, 2026-11-12: US lines with foreign town names are never turned down.
    eq('Paris, TX with "Paris, France" in the blurb is read', outsideUs({ location: 'Paris, TX', title: 'Engineer' }, `${pad}\nFounded in Paris, France in 1920.`), null);
    eq('"Lancaster, Los Angeles" with a "Lancaster, UK site" line is read', outsideUs({ location: 'Lancaster, Los Angeles', title: 'Engineer' }, `${pad}\nWe also run our Lancaster, UK site.`), null);
    for (const l of ['Bothell, Seattle', 'Kent, Seattle area', 'Springfield, Chicago area', 'Oakland, Chicago'])
      eq(`"${l}" with a foreign twin in the text is read`, outsideUs({ location: l, title: 'Engineer' }, `${pad}\nSister site in ${l.split(',')[0]}, United Kingdom.`), null);
    eq('"UK" inside a word never counts ("Durham, DUKE")', outsideUs({ location: 'Durham', title: 'Engineer' }, `${pad}\nOn site at Durham, DUKE University Hospital.`), null);
    eq('…nor "Ukiah"', outsideUs({ location: 'Mendocino', title: 'Engineer' }, `${pad}\nBased in Mendocino, Ukiah Valley.`), null);

    const abroadAsked = [], abroadFiled = [];
    const shen = { id: 'shz', company: 'Formlabs', title: 'Process Engineer', location: 'Shenzhen' };
    const r = await curate({ dbPath, root: dir, target: 50, candidates: [shen], log: () => {}, readDesc: () => oceanBody,
      screen: () => null, ask: async (p) => { abroadAsked.push(p); return '{"verdict":"KEEP","why":"fits"}'; },
      file: (ids, notes) => abroadFiled.push(notes[ids[0]]) });
    eq('a Shenzhen posting costs no model call and is filed as turned down',
      [abroadAsked.length, r.dropped.length, abroadFiled], [0, 1, ['read by the daily curation — Outside the US: Shenzhen']]);
  }

  // A drop that matches no exception costs no second call.
  const one = [];
  await curate({ dbPath, root: dir, target: 50, candidates: [ocean], log: () => {}, readDesc: () => `${pad}\nRequirements\n• 3+ years of design experience required.`,
    screen: () => null, ask: async (p) => { one.push(p); return '{"verdict":"DROP","why":"3+ years required"}'; }, file: () => {} });
  eq('a plain drop is one model call', one.length, 1);
  // A second read that fails leaves the posting unread, never filed.
  const failed = await curate({ dbPath, root: dir, target: 50, candidates: [samsung], log: () => {}, readDesc: () => samsungBody,
    screen: () => null, ask: async (p) => (p.includes('A CHECK') ? 'garbage' : first.sam), file: () => { throw new Error('must not file'); } });
  eq('a failed second read is reported as not read', [failed.failed.length, failed.dropped.length], [1, 0]);
  rmSync(dir, { recursive: true, force: true });
}

// F-731. Leviton's "Associate Mechanical Engineer" was taken out as building
// products, and the next pass filed Leviton's other posting of that title.
console.log('\n🧪 curate: a hand turn-down for the employer carries to its same-titled posting (F-731)');
{
  const { turnDownKind, turnDownReason, carriedTurnDown } = await import('./curate.mjs');
  eq('Leviton\'s reason is about its products', turnDownKind(turnDownReason('Not curated — checked 2026-10-14 — wiring devices and lighting for buildings: outside his sectors (building products)')), 'employer');
  eq('…and reads without its lead', turnDownReason('Not curated — checked 2026-10-14 — wiring devices and lighting'), 'wiring devices and lighting');
  eq('a years line is the posting\'s', turnDownKind('2+ years required at this site'), 'posting');
  eq('no degree or years stated is the posting\'s', turnDownKind('no degree or years stated, cannot verify'), 'posting');
  eq('a reason naming both is the posting\'s', turnDownKind('building products, and 3+ years required'), 'posting');
  eq('nuclear is the employer\'s', turnDownKind('Westinghouse — nuclear plant fleet support'), 'employer');

  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-731-'));
  const dbPath = path.join(dir, 'jobs.db');
  writeFileSync(path.join(dir, 'cv-short.md'), '# Alex Rivera\nBS Mechanical Engineering');
  const db = openDb(dbPath);
  const add = (id, company, title, note) => db.prepare(`INSERT INTO jobs (id, url, title, company, location, status, status_changed_at, first_seen, last_seen, fit_score, has_desc, pick_note)
    VALUES (?, ?, ?, ?, 'Melville, NY', 'new', '2026-10-14', '2026-10-01', '2026-10-14', 90, 1, ?)`).run(id, `https://x.test/${id}`, title, company, note);
  add('lev1', 'Leviton', 'Associate Mechanical Engineer', 'Not curated — checked 2026-10-14 — wiring devices and lighting for buildings: outside his sectors (building products)');
  add('acm1', 'Acme', 'Mechanical Engineer', 'Not curated — checked by hand — 2+ years required at this site');
  add('ocn1', 'Oceaneering', 'Mechanical Engineer', 'Not curated — read by the daily curation — oil and gas, outside his target industries');
  eq('the same title at Leviton carries the turn-down', carriedTurnDown(db, { id: 'lev2', company: 'Leviton', title: 'Associate Mechanical Engineer' })?.title, 'Associate Mechanical Engineer');
  eq('a different title there does not', carriedTurnDown(db, { id: 'lev3', company: 'Leviton', title: 'Manufacturing Engineer' }), null);
  eq('…but the reader is told about it', priorAt(db, { id: 'lev3', company: 'Leviton', title: 'Manufacturing Engineer' }).some((s) => /turned down by hand: wiring devices/.test(s)), true);
  eq('a years turn-down at one site does not carry', carriedTurnDown(db, { id: 'acm2', company: 'Acme', title: 'Mechanical Engineer' }), null);
  eq('…nor reach the reader', priorAt(db, { id: 'acm2', company: 'Acme', title: 'Mechanical Engineer' }).length, 0);
  eq('the daily reader\'s own turn-down does not carry (it errs, F-767)', carriedTurnDown(db, { id: 'ocn2', company: 'Oceaneering', title: 'Mechanical Engineer' }), null);
  db.close?.();
  const asked = [];
  const r = await curate({ dbPath, root: dir, target: 50, log: () => {}, screen: () => null,
    candidates: [{ id: 'lev2', company: 'Leviton', title: 'Associate Mechanical Engineer' }],
    readDesc: () => 'A real posting body. '.repeat(40), ask: async (p) => { asked.push(p); return '{"verdict":"KEEP","why":"x","note":"Fits. Wins."}'; }, file: () => {} });
  eq('Leviton\'s second posting is turned down without a model call', [r.dropped.length, asked.length], [1, 0]);
  eq('…naming the hand decision', /turned down by hand: wiring devices/.test(r.dropped[0].why), true);
  rmSync(dir, { recursive: true, force: true });
}

// F-627. GE's R5052095 grew from 2,071 to 3,915 characters after it was read,
// and the new tail said "We will not sponsor".
console.log('\n🧪 curate: an old body is read again before it is judged (F-627)');
{
  const { staleBody } = await import('./curate.mjs');
  const now = Date.parse('2026-10-18T12:00:00Z');
  const day = (n) => new Date(now - n * 86_400_000).toISOString();
  eq('read 3 days ago: fresh', staleBody({ source: 'workday', desc_len: 3000, enriched_at: day(3) }, 7, now), false);
  eq('read 20 days ago: stale', staleBody({ source: 'workday', desc_len: 3000, enriched_at: day(20) }, 7, now), true);
  eq('never read in full: stale', staleBody({ source: 'greenhouse', desc_len: 3000, enriched_at: null }, 7, now), true);
  eq('a teaser: stale', staleBody({ source: 'workday', desc_len: 300, enriched_at: null }, 7, now), true);
  eq('a board no server reads (Tesla) is never held', staleBody({ source: 'browser-assist', desc_len: 3000, enriched_at: null }, 7, now), false);
  eq('three failed reads: the stored body is what there is', staleBody({ source: 'workday', desc_len: 3000, enriched_at: day(30), enrich_fails: 3 }, 7, now), false);

  // F-948: a star dropped on the startup test is asked again; an unknown employer's same reason is not.
  {
    const { dropExceptions } = await import('./curate.mjs');
    const v = { verdict: 'DROP', why: 'Startup not on his frontier list, and the posting shows none of the five startup tests: no funding, no headcount' };
    eq('a star dropped for no funding is re-asked', dropExceptions(v, { company: 'Standard Bots', title: 'Mechanical Engineer' }, '').map((f) => f.key), ['star-startup-test']);
    eq('…an unknown employer is not', dropExceptions(v, { company: 'Acme Widgets', title: 'Mechanical Engineer' }, '').map((f) => f.key), []);
    eq('…nor a star dropped for years', dropExceptions({ verdict: 'DROP', why: 'Requires six or more years' }, { company: 'Normal Computing', title: 'ME' }, '').map((f) => f.key), []);
  }

  // F-948: a refused re-read never counts as an enrich failure, so the rule
  // above never fired and the same postings were held on every pass.
  {
    const { refreshBodies } = await import('./curate.mjs');
    const rows = {
      full: { id: 'full', source: 'workday', desc_len: 7000, enriched_at: day(90), enrich_fails: 0 },
      teaser: { id: 'teaser', source: 'phenom', desc_len: 300, enriched_at: null, enrich_fails: 0 },
    };
    const fakeDb = { prepare: () => ({ get: (id) => rows[id] }) };
    const heldFile = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-held-')), 'held.json');
    const refused = async () => {};   // the site said 403: nothing changes
    const cands = [{ id: 'full' }, { id: 'teaser' }];
    const first = await refreshBodies(fakeDb, cands, { enrich: refused, heldFile, now });
    eq('first pass: both held while the re-read is tried', first.held.map((j) => j.id), ['full', 'teaser']);
    const sameDay = await refreshBodies(fakeDb, cands, { enrich: refused, heldFile, now: now + 6 * 3_600_000 });
    eq('the same day: still held', sameDay.held.map((j) => j.id), ['full', 'teaser']);
    const nextDay = await refreshBodies(fakeDb, cands, { enrich: refused, heldFile, now: now + 25 * 3_600_000 });
    eq('a day later: the full stored body is read', nextDay.ready.map((j) => j.id), ['full']);
    eq('…the teaser still waits for a real read', nextDay.held.map((j) => j.id), ['teaser']);
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-627-'));
  const dbPath = path.join(dir, 'jobs.db');
  writeFileSync(path.join(dir, 'cv-short.md'), '# Alex Rivera\nBS Mechanical Engineering');
  const db = openDb(dbPath);
  const add = (id, enrichedAt) => db.prepare(`INSERT INTO jobs (id, url, title, company, location, status, first_seen, last_seen, fit_score, has_desc, desc_len, source, enriched_at)
    VALUES (?, ?, 'Manufacturing Engineer', ?, 'Greenville, SC', 'new', '2026-10-01', '2026-10-18', 90, 1, 3000, 'workday', ?)`).run(id, `https://x.test/${id}`, `Co ${id}`, enrichedAt);
  add('ge-old', new Date(Date.now() - 21 * 86_400_000).toISOString());
  add('fresh', new Date(Date.now() - 2 * 86_400_000).toISOString());
  add('paced', new Date(Date.now() - 30 * 86_400_000).toISOString());
  db.close?.();
  const cands = ['ge-old', 'fresh', 'paced'].map((id) => ({ id, company: `Co ${id}`, title: 'Manufacturing Engineer' }));
  const sent = [], asked = [];
  // The stub enricher re-reads GE (its body grows, the date moves) and is paced out on the other.
  const enrich = async (ids) => {
    sent.push(...ids);
    const d = openDb(dbPath);
    d.prepare("UPDATE jobs SET enriched_at = ?, desc_len = 3915 WHERE id = 'ge-old'").run(new Date().toISOString());
    d.close?.();
  };
  const bodies = { 'ge-old': 'The re-read body. We will not sponsor individuals for employment visas. ', fresh: 'A fresh body. ', paced: 'A stale body. ' };
  const r = await curate({ dbPath, root: dir, target: 50, candidates: cands, log: () => {}, screen: () => null, enrich,
    readDesc: (_db, id) => bodies[id].repeat(30),
    ask: async (p) => { asked.push(p); return '{"verdict":"DROP","why":"fits nothing"}'; }, file: () => {} });
  eq('only the old bodies go to the enricher, in one call', sent.sort(), ['ge-old', 'paced']);
  eq('the re-read one and the fresh one are read', r.dropped.map((x) => x.id).sort(), ['fresh', 'ge-old']);
  eq('…on the body the enricher brought back', asked.some((p) => p.includes('We will not sponsor')), true);
  eq('the one the enricher could not reach is left for the next pass, not read', [r.failed.map((x) => x.id), asked.some((p) => p.includes('A stale body'))], [['paced'], false]);
  eq('…and says why', /left for the next/.test(r.failed[0].why), true);
  // A dry run never starts the enricher.
  const dry = [];
  await curate({ dbPath, root: dir, target: 50, candidates: cands, log: () => {}, screen: () => null, dryRun: true,
    enrich: async (ids) => dry.push(...ids), readDesc: (_db, id) => bodies[id].repeat(30), ask: async () => '{"verdict":"DROP","why":"x"}', file: () => {} });
  eq('a dry run starts no enricher', dry.length, 0);
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

console.log('\n🧪 curate: his kind of employer (taste quiz, 2026-10-25, "aim for the damn stars")');
{
  const many = { petitions: () => 500, postings: () => 1800 }, few = { petitions: () => 11, postings: () => 5220 };
  const me = (company, title = 'Mechanical Engineer') => ({ company, title });
  eq('a frontier employer is a star', employerClass('Applied Materials'), 'star');
  eq('a robotics star', employerClass('Field AI'), 'star');
  eq('a same-word company is not mistaken for a star', employerClass('Genesis HealthCare'), 'other');
  eq('a carmaker is a big name', employerClass('American Honda Motor Company, Inc.'), 'name');
  eq('a conglomerate: the role decides', employerClass('Honeywell'), 'role');
  eq('a contract manufacturer is backup', employerClass('Jabil'), 'backup');
  eq('Lincoln Electric is out ("narrow, meh")', employerClass('Lincoln Electric'), 'out');
  {
    const lists = [{ name: 'Example Robotics, Inc.' }, { name: 'Gritt AI' }];
    eq('a VC-list startup is found by its plain name', vcListed('Example Robotics', lists), true);
    eq('…and with its suffix and spacing changed', vcListed('ExampleRobotics Inc', lists), true);
    eq('a different company starting with a list name is not (F-947)', vcListed('Example Robotics Systems', lists), false);
    eq('an empty name is never listed', vcListed('', lists), false);
  }
  // F-948, his decision 2026-11-05: a VC hiring list is not "big funding"; only a known round is.
  eq('a startup he named as funded is read as funded', employerClass('AtmosZero'), 'vc');
  ok('the class never consults the VC lists (being listed is not funding)', !/vcListed\s*\(/.test(employerClass.toString()));
  ok('an unlisted-or-listed startup whose posting names no round is not his kind', /no top investors or big funding/.test(employerVerdict(me('Example Robotics'), 'We build warehouse robots.') || ''));
  eq('…and passes when the posting names a known round', employerVerdict(me('Example Robotics'), 'We raised a $40M Series B led by Founders Fund.'), null);
  eq('a star is filed with no H-1B record at all', employerVerdict(me('Skild AI'), 'we build robots', { petitions: () => 0 }), null);
  eq('a big name that sponsors is filed', employerVerdict(me('Cummins Inc.'), 'engines', many), null);
  ok('a big name with almost no H-1B record is not ("they dont sponsor but they dont say it")', /almost no H-1B record \(11/.test(employerVerdict(me('GE Vernova'), 'turbines', few) || ''));
  eq('…unless its posting says it sponsors', employerVerdict(me('GE Vernova'), 'Visa sponsorship is available for this role.', few), null);
  eq('a mid-size company sponsoring at its size is filed (Veeco: 11 on 255 postings)', employerVerdict(me('Veeco'), 'x', { petitions: () => 11, postings: () => 255 }), null);
  eq('no record under this name is unknown, not a no (onsemi files as Semiconductor Components)', employerVerdict(me('onsemi'), 'x', { petitions: () => 0, postings: () => 1231 }), null);
  ok('a small traditional firm is not filed', /not a name he would want/.test(employerVerdict(me('Taurus Industrial Group'), 'we make conveyors') || ''));
  eq('a startup naming real funding is read', employerVerdict(me('Maven Robotics'), 'Backed by Lux Capital, we raised $40M Series B.'), null);
  ok('a test role is not filed, even at a star ("avoid test roles")', /test roles/.test(employerVerdict(me('Formlabs', 'R&D Reliability/Test Engineer'), 'x') || ''));
  ok('an employer he ruled out stays out', /ruled out/.test(employerVerdict(me('Gulfstream Aerospace'), 'Visa sponsorship is available.') || ''));
}

console.log('\n🧪 curate: the daily search reads batches until 20 are filed or the pool runs out (2026-10-26)');
{
  // A pool of 100 postings; every third one is a keep.
  const all = Array.from({ length: 100 }, (_, i) => ({ id: `j${i}`, company: 'Applied Materials', title: `Engineer ${i}` }));
  const pool = (_db, { limit, skip, minFit }) => (minFit === 55 ? [] : all.filter((j) => !skip.has(j.id)).slice(0, limit));
  const run = async ({ candidates }) => {
    const pick = (j) => Number(j.id.slice(1)) % 3 === 0;
    return { kept: candidates.filter(pick).map((j) => ({ ...j, verdict: 'KEEP' })), maybe: [], dropped: candidates.filter((j) => !pick(j)), failed: [] };
  };
  const quiet = () => {};
  const r = await daily({ open: 40, want: 20, pool, library: async () => [], run, log: quiet });
  ok('below 50 it reads until 20 are filed', r.filed >= 20);
  eq('…in batches, not one pass of 30', r.read, 60);
  eq('the goal is what brings the inbox to 50 when that is more than 20', (await daily({ open: 10, want: 20, pool, library: async () => [], run, log: quiet })).goal, 40);
  eq('at 50 open it does nothing', (await daily({ open: 50, pool, library: async () => [], run, log: quiet })).skipped, true);
  {
    const logged = [];
    await daily({ open: 67, pool, library: async () => [], run, log: (e) => logged.push(e) });
    eq('…and logs it as a no-op with its reason, not a failure', [logged[0].noop, logged[0].why], [true, 'inbox full: 67 open picks, target 50']);
    // Picks closed or applied: the next run refills to target, the library last.
    const libAsked = [];
    const refill = await daily({ open: 45, want: 20, pool: () => [], library: async (_db, o) => { libAsked.push(o.limit); return libAsked.length > 1 ? [] : [{ id: 'L1', company: 'Acme', title: 'Engineer' }]; }, run, log: quiet });
    eq('five under target with the windows empty: the library survivors are read', [refill.goal, libAsked.length >= 1], [20, true]);
  }
  // THE TOP-UP (approved 2026-11-03): a full inbox still gets up to N fresh fits, from the library only.
  {
    const usualAsked = [];
    const lib = async (_db, { limit, skip }) => all.filter((j) => !skip.has(j.id)).slice(0, limit);
    const t = await daily({ open: 67, topUp: 10, pool: (...a) => { usualAsked.push(1); return pool(...a); }, library: lib, run, log: quiet });
    ok('a full inbox with a top-up of 10 files 10 or more, not a no-op', !t.skipped && t.filed >= 10);
    eq('…logged as top-up, with no refill', [t.refill, t.topup >= 10], [0, true]);
    eq('…read from the library survivors only, not the usual windows', usualAsked.length, 0);
    const u = await daily({ open: 45, want: 20, topUp: 10, pool, library: async () => [], run, log: quiet });
    eq('under target the top-up is added on top of the refill', u.goal, 30);
    eq('with no top-up a full inbox is still a no-op', (await daily({ open: 67, topUp: 0, pool, library: lib, run, log: quiet })).noop, true);
    const { clamp } = await import('./settings.mjs');
    eq('the setting is clamped (no run of a thousand)', [clamp('dailyTopUp', 1000), clamp('dailyTopUp', -3), clamp('dailyTopUp', 'x')], [30, 0, 10]);
  }
  // EVERY CARD CARRIES ITS REASON (2026-11-03).
  {
    const { reasonLost } = await import('./curate.mjs');
    eq('a card with no note, or a lost one, has lost its reason', [reasonLost(null), reasonLost(''), reasonLost('Back in the inbox: … (Its original pick note was not recoverable.)'), reasonLost('Worth a look: his fixture work.')], [true, true, true, false]);
  }
  eq('an empty pool ends the run instead of looping', (await daily({ open: 0, want: 20, pool: () => [], library: async () => [], run, log: quiet })).read, 0);
  // F-955: once the 45-day pools are read, his employers' still-open older postings are.
  const asked = [];
  const old = [{ id: 'old1', company: 'Amazon', title: 'Propulsion Hardware Engineer' }];
  const pool2 = (_db, o) => { asked.push(o); return o.days === 120 && !o.skip.has('old1') ? old : []; };
  const r2 = await daily({ open: 0, want: 20, pool: pool2, library: async () => [], run, log: quiet });
  eq('a 120-day pass comes last', asked.at(-1).days, 120);
  eq('…for his kind of employer only', asked.at(-1).classes?.includes('star') && !asked.at(-1).classes?.includes('unknown'), true);
  eq('…and its postings are read', r2.read, 1);
  // F-958: when every window is empty, the library's survivors are read — the run never ends on "dry".
  const libCalls = [];
  const lib = async (_db, o) => { libCalls.push(o); return o.skip.has('lib1') ? [] : [{ id: 'lib1', company: 'Ginkgo Bioworks', title: 'Mechatronics Engineer I' }]; };
  const r3 = await daily({ open: 0, want: 20, pool: () => [], library: lib, run, log: quiet });
  eq('empty windows go on to the library survivors', libCalls.length >= 1, true);
  eq('…which are read', r3.read, 1);
}

console.log('\n🧪 curate: thermal roles are not his interest (2026-11-05)');
{
  const { interestOut } = await import('./curate.mjs');
  const out = (t) => !!interestOut({ title: t });
  for (const t of ['Thermal Engineer', 'Thermal Systems Engineer, Product Development', 'Mechanical Engineer - Thermal', 'Mechanical Engineer II - Thermal & Fluids',
    'HVAC Design Engineer', 'Heat Transfer Engineer', 'Aerothermal Engineer II', 'Thermofluids Analyst II', 'Thermal CAE Engineer', '2027 New Graduate - Thermal Engineer']) {
    eq(`out: ${t}`, out(t), true);
  }
  for (const t of ['Mechanical Engineer', 'Thermal Process Engineer', 'Thermal Design Engineer, Datacenter Compute', 'Senior Cloud Hardware Development Engineer, Thermal & Mechanical',
    'Manufacturing Engineer 3 (Thermal)', 'Mechanical Design Engineer, Lubrication & Thermal, Drive Systems', 'Failure Analysis Engineer - Power & Thermal', 'Equipment Engineer']) {
    eq(`in: ${t}`, out(t), false);
  }
  const why = interestOut({ title: 'Thermal Engineer' });
  eq('the reason quotes him', /not his interest: thermal/.test(why.why) && /waste of time, not my interest plus no expertise/.test(why.said), true);
  eq('the reader is told too, for a title that hides it', /THERMAL ROLES: DROP \("for thermal jobs/.test(promptFor({ company: 'A', title: 'Mechanical Engineer', location: 'X' }, 'body', 'cv')), true);
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-thermal-'));
  const dbPath = path.join(dir, 'jobs.db');
  writeFileSync(path.join(dir, 'cv-short.md'), '# Alex Rivera\nBS Mechanical Engineering');
  openDb(dbPath).close?.();
  const asked = [];
  const r = await curate({
    dbPath, root: dir, target: 50, log: () => {},
    candidates: [{ id: 't1', company: 'A', title: 'Thermal Systems Engineer' }, { id: 'm1', company: 'B', title: 'Mechanical Engineer' }],
    readDesc: (_db, id) => `A real posting body for ${id}. `.repeat(30),
    ask: async (prompt) => { asked.push(prompt); return '{"verdict":"KEEP","why":"fits","note":"Mechanical design work."}'; },
    file: () => {},
  });
  eq('a thermal title is turned down without a read, even when handed in', [r.dropped.map((d) => d.id), asked.length, r.kept.map((k) => k.id)], [['t1'], 1, ['m1']]);
  eq('…with his words as the reason', /not his interest: thermal — "for thermal jobs/.test(r.dropped[0]?.why || ''), true);
  rmSync(dir, { recursive: true, force: true });
}

// F-1040 (2026-11-11). The weekly limit made every read fail as "exit 1", 60 a
// run, and the run went on stage after stage; 67 of the 83 postings at the head
// of the queue had no body and none coming, read "no description" every run.
console.log('\n🧪 curate: a spent model stops the whole daily pass, and bodiless rows wait out of the queue (F-1040)');
{
  const { spentWhy, unread } = await import('./curate.mjs');
  eq('the CLI\'s sentence travels into the reason', spentWhy(new Error("every model is out of credit (You've hit your 5-hour limit · resets 2am (America/Los_Angeles))")),
    "model out of credit — run stopped: You've hit your 5-hour limit · resets 2am (America/Los_Angeles)");
  eq('…and a bare one still reads as stopped', spentWhy(new Error('every model is out of credit')), 'model out of credit — run stopped');

  const asked = [];
  const pool = (_db, o) => { asked.push(o.minFit || 70); return Array.from({ length: 5 }, (_, i) => ({ id: `${o.minFit || 70}-${asked.length}-${i}`, company: 'Applied Materials', title: 'Engineer' })); };
  const run = async ({ candidates }) => ({ kept: [], maybe: [], dropped: [], failed: [{ id: candidates[0].id, why: spentWhy(new Error("every model is out of credit (You've hit your weekly limit · resets 10pm)")) }] });
  const r = await daily({ open: 0, want: 20, pool, library: async () => { asked.push('library'); return []; }, run, log: () => {} });
  eq('one spent read ends every stage: the pool is asked once', asked, [70]);
  eq('…and the result says why', r.stopped, "model out of credit — run stopped: You've hit your weekly limit · resets 10pm");

  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-curate-nobody-'));
  const dbPath = path.join(dir, 'jobs.db');
  const db = openDb(dbPath);
  const row = (id, company, source, descLen, fails, enrichedAt) => db.prepare(`
    INSERT INTO jobs (id, url, title, company, location, status, gone_at, first_seen, last_seen,
      fit_score, fit_blocked, f_hard_block, f_senior, f_intern, f_newgrad, f_grad_mismatch,
      level_years, has_desc, desc_len, posted_at, source, enrich_fails, enriched_at)
    VALUES (?, ?, 'Mechanical Engineer - New Grad', ?, 'Austin, TX', 'new', NULL, date('now'), date('now'),
      95, 0, 0, 0, 0, 1, 0, NULL, 1, ?, date('now'), ?, ?, ?)
  `).run(id, `https://example.test/${id}`, company, descLen, source, fails, enrichedAt);
  row('full', 'Applied Materials', 'workday', 4000, 0, new Date().toISOString());
  row('given-up', 'Lam Research', 'phenom', 300, 3, null);                       // three failed reads: this body is what there is
  row('given-up-empty', 'Teradyne', 'phenom', 0, 3, null);                       // three failed reads and nothing at all
  row('linkedin-short', 'Formlabs', 'linkedin', 250, 0, null);                   // nothing server-side reads LinkedIn again
  row('stub-this-week', 'KLA', 'workday', 300, 0, new Date().toISOString());     // read today, still a stub: read again next week
  row('never-read', 'Micron Technology', 'workday', 300, 0, null);               // the enricher will try it
  db.close?.();
  const list = unread(dbPath, { limit: 10, cold: new Set(), liked: new Set() });
  // Code review #2 (2026-11-13): a short body that is FINAL is read, not held
  // out for good. Only no body at all, or a stub the enricher will read again, waits.
  eq('a short final body is read; no body, or a stub read this week, waits out of the queue', list.map((j) => j.id).sort(), ['full', 'given-up', 'linkedin-short', 'never-read']);
  eq('…counted, never silent', list.unreadable, 2);
  const { bodyIsFinal } = await import('./curate.mjs');
  eq('a LinkedIn body is final', bodyIsFinal({ source: 'linkedin', enrich_fails: 0 }), true);
  eq('…and so is any after three failed reads', bodyIsFinal({ source: 'workday', enrich_fails: 3 }), true);
  eq('…but not a board body the enricher can still read', bodyIsFinal({ source: 'workday', enrich_fails: 0 }), false);
  // …and the reader reads it, where it used to answer "no description to read".
  {
    writeFileSync(path.join(dir, 'cv-short.md'), '# Alex Rivera\nBS Mechanical Engineering');
    const lens = { 'given-up': 300, 'linkedin-short': 250, 'stub-this-week': 300, 'given-up-empty': 40 };
    const read = [];
    const r = await curate({
      dbPath, root: dir, target: 50, log: () => {}, refresh: async (_db, c) => ({ ready: c, held: [] }), markRoute: async () => {},
      route: async () => null,
      candidates: Object.keys(lens).map((id) => ({ id, company: `Co ${id}`, title: 'Mechanical Engineer' })),
      readDesc: (_db, id) => `${id} `.padEnd(lens[id], 'x'),
      ask: async (prompt) => { const id = Object.keys(lens).find((k) => prompt.includes(`${k} x`)); read.push(id); return '{"verdict":"DROP","why":"test"}'; },
      file: () => {},
    });
    eq('a short final body is read', read.sort(), ['given-up', 'linkedin-short']);
    eq('…a stub the enricher will read again, or one too short to judge, is not', r.failed.map((f) => f.id).sort(), ['given-up-empty', 'stub-this-week']);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
