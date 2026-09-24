/**
 * /api/apply-page — the extension telling the dashboard which job a page is.
 *
 * AGAINST AN EMPTY STORE, NEVER HIS. This endpoint WRITES: a posting the store
 * has never seen becomes a row. Running it against data/jarvis/jobs.db would
 * seed his real deck with fixture jobs, so the server is started with
 * JARVIS_DATA_DIR pointing at a temp directory that is deleted afterwards.
 *
 * Tailoring is switched off (JARVIS_TAILOR=off) so a build is a PDF render and
 * not a two-minute model call; the resume that comes back is still the real
 * family PDF, verified against cv.md, which is the part worth proving here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4393;
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let dir;
let token;

async function up(capMs = 25000) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const post = async (pathname, body) => {
  const r = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': token },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (pathname) => {
  const r = await fetch(`${BASE}${pathname}`, { headers: { 'x-jarvis-token': token } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
};

test.before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'jarvis-apply-page-'));
  server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
    // JARVIS_RESUME_DIR: the resumes this test builds go in the temp dir too,
    // never into his real output/jarvis-resumes/sent archive.
    env: { ...process.env, JARVIS_AUTO: '0', JARVIS_DATA_DIR: dir, JARVIS_RESUME_DIR: path.join(dir, 'resumes'), JARVIS_TAILOR: 'off' },
    stdio: 'ignore',
  });
  assert.ok(await up(), 'the dashboard must start on an empty store');
  token = (await (await fetch(`${BASE}/api/apply-token`)).json()).token;
  assert.ok(token);
});

test.after(async () => {
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const JD = `${'Design fixtures for the assembly line. SolidWorks, GD&T, DOE. '.repeat(6)}`;
const POSTING = {
  title: 'Manufacturing Engineer I',
  company: 'Acme Robotics',
  description: JD,
  url: 'https://jobs.lever.co/acme/1b2c3d4e-1111-2222-3333-444455556666',
  location: 'Boise, ID, US',
  source: 'jsonld',
};
let firstId = null;

test('A POSTING THE STORE HAS NEVER SEEN IS RECORDED, AND ITS RESUME STARTS', async () => {
  const { status, body } = await post('/api/apply-page', { pageUrl: POSTING.url, posting: POSTING });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.id, 'the id the tab carries from now on');
  assert.equal(body.recorded, true);
  assert.equal(body.tailored, true, 'the page brought a description, so there is something to write towards');
  assert.equal(body.company, 'Acme Robotics');
  assert.equal(body.submit, false);
  assert.ok(['tailoring', 'ready'].includes(body.status));
  firstId = body.id;

  const { body: job } = await get(`/api/job?id=${firstId}`);
  assert.equal(job.job.title, 'Manufacturing Engineer I');
  assert.equal(job.job.company, 'Acme Robotics');
  assert.equal(job.job.location, 'Boise, ID, US', 'the location travels, so triage buckets honestly');
  assert.match(job.job.description, /Design fixtures/, 'and the description is stored for the tailor');
  assert.equal(job.job.source, 'extension');
});

test('the same posting seen again is the same job — one row, one build', async () => {
  const { body } = await post('/api/apply-page', { pageUrl: `${POSTING.url}/apply`, posting: POSTING });
  assert.equal(body.id, firstId, 'the apply page of the same posting resolves to it');
  assert.equal(body.recorded, false);
});

test('THE TAB\'S CURRENT JOB, SEEN AGAIN ON ITS ATS, IS NOT RECORDED TWICE', async () => {
  // A company site's posting links to its Lever copy; same title, same
  // employer, different URL. Recording it twice would split one application
  // across two rows and start a second resume.
  const { body } = await post('/api/apply-page', {
    pageUrl: 'https://www.acme.test/careers/manufacturing-engineer-i',
    currentId: firstId,
    posting: { ...POSTING, url: '', source: 'dom' },
  });
  assert.equal(body.id, firstId);
  assert.equal(body.recorded, false);

  // With a location suffix, still the same job…
  const suffixed = await post('/api/apply-page', {
    pageUrl: 'https://www.acme.test/careers/me-i-boise',
    currentId: firstId,
    posting: { ...POSTING, title: 'Manufacturing Engineer I - Boise, ID', url: '', source: 'dom' },
  });
  assert.equal(suffixed.body.id, firstId);

  // …but a longer title that merely STARTS the same way is a different job,
  // and gets its own row — the id decides which resume attaches.
  const other = await post('/api/apply-page', {
    pageUrl: 'https://www.acme.test/careers/me-manager',
    currentId: firstId,
    posting: { ...POSTING, title: 'Manufacturing Engineer I Manager', url: 'https://www.acme.test/careers/me-manager', source: 'jsonld' },
  });
  assert.notEqual(other.body.id, firstId, '"Manufacturing Engineer I Manager" is not "Manufacturing Engineer I"');
});

test('A STEP HEADING IS NOT A JOB TITLE — nothing is recorded', async () => {
  for (const title of ['My Information', 'Sign in', 'Careers', 'Open roles']) {
    // eslint-disable-next-line no-await-in-loop
    const { status } = await post('/api/apply-page', {
      pageUrl: `https://acme.wd5.myworkdayjobs.com/x/${encodeURIComponent(title)}`,
      posting: { title, company: 'Acme', description: JD, source: 'dom' },
    });
    assert.equal(status, 404, `"${title}" must not become a job`);
  }
});

test('a page-shaped read without a body is not recorded; with one it is', async () => {
  const thin = await post('/api/apply-page', {
    pageUrl: 'https://careers.thin.test/job/1',
    posting: { title: 'Test Engineer', company: 'Thin Co', description: 'Join us.', source: 'dom' },
  });
  assert.equal(thin.status, 404, 'a heading with no description is a careers page, not a posting');

  const full = await post('/api/apply-page', {
    pageUrl: 'https://careers.full.test/job/2',
    posting: { title: 'Test Engineer', company: 'Full Co', description: JD, source: 'dom' },
  });
  assert.equal(full.status, 200);
  assert.equal(full.body.recorded, true);
});

test('an ATS or identity provider is never filed as the employer', async () => {
  const { body } = await post('/api/apply-page', {
    pageUrl: 'https://boards.greenhouse.io/x/jobs/77',
    posting: { title: 'Mechanical Engineer', company: 'Greenhouse', description: JD, url: 'https://boards.greenhouse.io/x/jobs/77', source: 'jsonld' },
  });
  assert.equal(body.company, '', '"Greenhouse" did not post this job');
});

test('THE TAB\'S ID IS TRUSTED BY /api/plan AND /api/apply-resume', async () => {
  const plan = await post('/api/plan', {
    id: firstId,
    // A form host that says nothing about the employer — the case the id exists for.
    pageUrl: 'https://jobs.lever.co/acme/1b2c3d4e-1111-2222-3333-444455556666/apply',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.id, firstId);
  assert.equal(plan.body.matched, 'id');
  assert.match(plan.body.resumeNote, /Acme Robotics/, 'the note names the employer the resume is for');
  assert.equal(plan.body.submit, false);

  // The resume: 425 while it builds, then the family PDF.
  //
  // WAIT ON PROGRESS, NOT ON A CLOCK (F-438). This polled 40 times at 1.5s and
  // gave up at 60 seconds, which failed the whole suite once when a build that
  // normally takes ~50s was competing with an 890-company scan for the same
  // machine — 69 minutes of wall clock, and the build was advancing the entire
  // time. A test that only fails under load is worse than one that always
  // fails, because it makes "the suite is green" stop meaning anything (F-290).
  //
  // Simply raising the timeout would trade that for a slower, quieter failure
  // whenever the build genuinely hangs. The 425 body carries a `phase` string
  // that changes as the build moves, so the honest question is not "has it
  // taken too long" but "has it STOPPED" — and that is answered by watching
  // the phase. A hang is now caught in 30s, faster than the old 60s ceiling,
  // while a slow-but-moving build is allowed to finish.
  const STALL_LIMIT = 20;          // ~30s with no change of phase = stuck
  const HARD_CEILING = 400;        // ~10 min, so a broken server cannot hang the suite
  let got = null;
  let lastPhase = null;
  let stalled = 0;
  for (let i = 0; i < HARD_CEILING; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    got = await get(`/api/apply-resume?id=${encodeURIComponent(firstId)}&pageUrl=${encodeURIComponent('https://jobs.lever.co/acme/x/apply')}`);
    if (got.status !== 425) break;
    const phase = got.body?.phase ?? '';
    if (phase === lastPhase) stalled += 1;
    else { stalled = 0; lastPhase = phase; }
    assert.ok(stalled < STALL_LIMIT,
      `the resume build stopped moving at "${phase}" — ${JSON.stringify(got.body).slice(0, 160)}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert.equal(got.status, 200, `the resume never became ready: ${JSON.stringify(got.body).slice(0, 200)}`);
  assert.match(Buffer.from(got.body).subarray(0, 5).toString(), /^%PDF/, 'and it is a real PDF');
}, { timeout: 120000 });

test('A DEAD-POSTING VERDICT COUNTS ONLY FROM THE POSTING\'S OWN PAGE', async () => {
  // The armed tab carries its id; a run on some OTHER dead page must not
  // retire this job.
  const elsewhere = await post('/api/filled', {
    id: firstId, pageUrl: POSTING.url, seenOn: 'https://jobs.lever.co/other/dead-posting',
    filled: 0, postingGone: 'This job is no longer available', unanswered: [],
  });
  assert.equal(elsewhere.body.recorded, true);
  let { body: job } = await get(`/api/job?id=${firstId}`);
  assert.ok(!job.job.goneAt, 'a verdict from another page is not a verdict about this job');

  const own = await post('/api/filled', {
    id: firstId, pageUrl: POSTING.url, seenOn: POSTING.url,
    filled: 0, postingGone: 'This job is no longer available', unanswered: [],
  });
  assert.equal(own.body.recorded, true);
  ({ body: job } = await get(`/api/job?id=${firstId}`));
  assert.ok(job.job.goneAt, 'from its own page, it is');
});

test('a run\'s totals land on the job the tab carries', async () => {
  const { body } = await post('/api/filled', {
    id: firstId, pageUrl: `${POSTING.url}/apply`, seenOn: `${POSTING.url}/apply`,
    filled: 14, checked: 3, uploaded: true, reachedReview: true, unanswered: ['step 2: Portfolio'],
    stoppedBecause: 'reached the last step before Submit',
  });
  assert.equal(body.recorded, true);
  assert.equal(body.job, firstId);
  const { body: job } = await get(`/api/job?id=${firstId}`);
  assert.equal(job.job.apply.filled, 14);
  assert.equal(job.job.apply.checked, 3);
  assert.equal(job.job.apply.resumeUploaded, true);
  assert.deepEqual(job.job.apply.needsInput.map((n) => n.label), ['Portfolio']);
});

// HE PRESSES SUBMIT IN THE BROWSER, AND THE TRACKER FINDS OUT BY ITSELF.
//
// The reckoning of 2026-09-10 measured 96 applications prepared and 5
// recorded, because `applied` could only be set by hand. His answer: "i press
// submit but jarvis doesnt know … it doesnt require me to mark, coz i almost
// never press submit in the terminal." The extension had detected the
// confirmation page all along and kept it to itself (F-446).
test('THE CONFIRMATION PAGE MARKS THE JOB APPLIED, WITHOUT HIM TYPING ANYTHING', async () => {
  let { body: before } = await get(`/api/job?id=${firstId}`);
  assert.notEqual(before.job.status, 'applied', 'precondition: not applied yet');

  // A confirmation page is NEVER the posting's own page — that is the point.
  const { body } = await post('/api/filled', {
    id: firstId,
    pageUrl: 'https://jobs.lever.co/acme/abc123/apply/confirmation',
    seenOn: 'https://jobs.lever.co/acme/abc123/apply/confirmation',
    filled: 0, checked: 0, unanswered: [],
    submitted: 'Thank you for applying to Acme!',
  });
  assert.equal(body.recorded, true);
  assert.equal(body.submitted, true, 'the reply says so, so the panel can too');

  const { body: after } = await get(`/api/job?id=${firstId}`);
  assert.equal(after.job.status, 'applied');
  assert.ok(after.job.apply.submittedAt, 'when he sent it, apart from when the engine filled it');
  assert.equal(after.job.apply.submittedSaid, 'Thank you for applying to Acme!',
    'the page\'s own sentence, so a wrong verdict can be traced to it');
});

test('a later run on the same job never erases the evidence that it was sent', async () => {
  // The record is written whole on every report, so anything not carried
  // forward is deleted. The tab disarms on a confirmation, but a stray run
  // must not be able to un-send an application.
  const { body } = await post('/api/filled', {
    id: firstId, pageUrl: `${POSTING.url}/apply`, seenOn: `${POSTING.url}/apply`,
    filled: 2, checked: 0, unanswered: [],
  });
  assert.equal(body.recorded, true);
  assert.equal(body.submitted, undefined, 'this run sent nothing and claims nothing');
  const { body: after } = await get(`/api/job?id=${firstId}`);
  assert.equal(after.job.status, 'applied', 'still applied');
  assert.equal(after.job.apply.submittedSaid, 'Thank you for applying to Acme!', 'and still says why');
});

test('a page that names no job, on an ATS that does not answer, is refused honestly', async () => {
  const { status, body } = await post('/api/apply-page', { pageUrl: 'https://careers.nowhere.test/apply/step2', posting: {} });
  assert.equal(status, 404);
  assert.match(body.error, /does not name a job/);
});

test('the route is gated like the other extension routes', async () => {
  const r = await fetch(`${BASE}/api/apply-page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
    body: JSON.stringify({ pageUrl: 'https://x.test', posting: { title: 'x' } }),
  });
  assert.equal(r.status, 403, 'a page without the token cannot write to his store');
});

// A GUESS NEVER NAMES A COMPANY AS THIS PAGE'S JOB (F-400).
//
// Read off the on-page overlay on an Agility Robotics form: "writing the
// resume for Micron Technology — it will attach when the form reaches the
// upload step". Micron was simply the last application the server had seen,
// and the page — a Greenhouse embed whose URL names no posting — fell back to
// it. Nothing wrong would have been attached; the sentence was the lie.
test('A PAGE THAT MATCHES NOTHING IS NEVER TOLD AN EMPLOYER NAME', async () => {
  const plan = await post('/api/plan', {
    // No id, and a form host that names no posting and matches nothing stored.
    pageUrl: 'https://job-boards.greenhouse.io/embed/job_app?token=999999999',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.equal(plan.status, 200);
  assert.ok(['fallback', 'none'].includes(plan.body.matched), `a guess, not a match: ${plan.body.matched}`);
  assert.doesNotMatch(plan.body.resumeNote, /Acme Robotics/, 'the last application he ran is not this page');
  assert.match(plan.body.resumeNote, /does not say which job it is/, 'it says plainly that it does not know');
  assert.equal(plan.body.submit, false);
  // And it still answers the form: not knowing the posting costs the resume,
  // never the fill.
  assert.ok((plan.body.actions || []).some((a) => /first name/i.test(a.label || '')), 'the name is still filled in');
});

// GREENHOUSE.IO IS NOT AN EMPLOYER (F-401).
//
// Two applications in flight on the same applicant-tracking host scored as
// "the same page" because they share a registrable domain — which every
// Greenhouse board does, and every Lever board, and every Workday tenant. The
// second one opened would have been handed the first one's resume, with the
// panel calling it a match rather than a guess. The tenant in the URL is the
// identity; the domain says nothing.
test('TWO EMPLOYERS ON ONE ATS HOST ARE NOT ONE APPLICATION', async () => {
  const board = (slug, id, company) => ({
    pageUrl: `https://boards.greenhouse.io/${slug}/jobs/${id}`,
    posting: { title: 'Mechanical Engineer', company, description: JD, url: `https://boards.greenhouse.io/${slug}/jobs/${id}`, source: 'jsonld' },
  });
  const one = await post('/api/apply-page', board('alpha-co', 4001, 'Alpha Co'));
  const two = await post('/api/apply-page', board('beta-co', 4002, 'Beta Co'));
  assert.equal(one.body.company, 'Alpha Co');
  assert.equal(two.body.company, 'Beta Co');

  // Beta was applied to last. Standing on ALPHA's form must still mean Alpha.
  const alpha = await post('/api/plan', {
    pageUrl: 'https://job-boards.greenhouse.io/alpha-co/jobs/4001/application',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.equal(alpha.body.id, one.body.id, 'the board in the URL decides, not the domain');
  assert.match(alpha.body.resumeNote, /Alpha Co/);
  assert.doesNotMatch(alpha.body.resumeNote, /Beta Co/, "Beta's resume is never offered to Alpha's form");

  // And a third board nobody has applied to is a guess, not a match.
  const stranger = await post('/api/plan', {
    pageUrl: 'https://boards.greenhouse.io/gamma-co/jobs/4003',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.notEqual(stranger.body.matched, 'page');
  assert.equal(stranger.body.resumeUrl, null, 'no resume is attached to a page we cannot name');

  // THE EMBED FORM NAMES ITS BOARD IN THE QUERY. `for=alpha-co` is the only
  // thing on that URL that says whose form it is — the path segment is
  // "embed" on every board there is. Read live off his Agility Robotics form.
  const embed = await post('/api/plan', {
    pageUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=alpha-co&token=4001',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.equal(embed.body.id, one.body.id, 'the board in ?for= is the employer');
  assert.match(embed.body.resumeNote, /Alpha Co/);

  // The same form with no board named stays a guess.
  const anon = await post('/api/plan', {
    pageUrl: 'https://job-boards.greenhouse.io/embed/job_app?token=999999',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.notEqual(anon.body.matched, 'page');
  assert.equal(anon.body.resumeUrl, null);

  // AN iCIMS TENANT IS THE HOST, NOT THE PATH. Every posting there hangs off
  // /jobs/<id>, so reading only the path would make every iCIMS application a
  // guess — and reading only the domain would make two employers one.
  const icims = (host, id, company) => ({
    pageUrl: `https://${host}/jobs/${id}/mechanical-engineer/job`,
    posting: { title: 'Mechanical Engineer', company, description: JD, url: `https://${host}/jobs/${id}/mechanical-engineer/job`, source: 'jsonld' },
  });
  const amd = await post('/api/apply-page', icims('careers-amd.icims.com', 88060, 'AMD'));
  await post('/api/apply-page', icims('careers-intel.icims.com', 77050, 'Intel'));
  const amdForm = await post('/api/plan', {
    pageUrl: 'https://careers-amd.icims.com/jobs/88060/login',
    fields: [{ label: 'First Name', type: 'text', options: [] }],
  });
  assert.equal(amdForm.body.id, amd.body.id, "the tenant in the host is AMD's identity");
  assert.doesNotMatch(amdForm.body.resumeNote, /Intel/, "Intel's resume is never offered to AMD's form");

  // AND THE PDF ITSELF, not only the sentence about it. /api/apply-resume
  // reads the page the same way, and before this it would have handed a
  // Greenhouse form whatever Greenhouse application ran last.
  const pdf = await get(`/api/apply-resume?pageUrl=${encodeURIComponent('https://job-boards.greenhouse.io/embed/job_app?token=999999')}`);
  assert.ok([404, 409].includes(pdf.status), `a page it cannot name gets no PDF, got ${pdf.status}`);
});

// THE SAME URL, SPELLED DIFFERENTLY, IS THE SAME JOB (F-402).
//
// Finding "the stored posting for this page" used to walk all 196,491 rows
// once per candidate spelling — seven walks, and about eight seconds before
// the panel could say anything. SQLite now throws away the rows that cannot
// match first. These are the spellings that must survive that: a query
// string, a fragment, an /apply suffix, a trailing slash, and a shouted host.
test('A PAGE IS STILL ITS POSTING WHEN THE URL IS SPELLED DIFFERENTLY', async () => {
  const spellings = [
    `${POSTING.url}?utm_source=x#top`,
    `${POSTING.url}/apply`,
    `${POSTING.url}/`,
    POSTING.url.replace('jobs.lever.co', 'JOBS.LEVER.CO'),
  ];
  for (const pageUrl of spellings) {
    // eslint-disable-next-line no-await-in-loop
    const plan = await post('/api/plan', { pageUrl, fields: [{ label: 'First Name', type: 'text', options: [] }] });
    assert.equal(plan.status, 200);
    assert.match(plan.body.resumeNote, /Acme Robotics/, `${pageUrl} is the Acme posting`);
  }
});
