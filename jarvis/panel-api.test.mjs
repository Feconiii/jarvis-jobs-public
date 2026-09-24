/**
 * /api/panel — what the extension's side panel shows for a page.
 *
 * Against an empty store in a temp directory, never his (the posting below is
 * recorded through /api/apply-page, which writes). Tailoring is off so the
 * build is a render, not a model call.
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
const PORT = 4394;
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
  const r = await fetch(`${BASE}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-token': token }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const get = async (pathname) => {
  const r = await fetch(`${BASE}${pathname}`, { headers: { 'x-jarvis-token': token } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
};

test.before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'jarvis-panel-api-'));
  server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
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

const POSTING = {
  title: 'Manufacturing Engineer I',
  company: 'Acme Robotics',
  description: `${'Design fixtures for the assembly line. SolidWorks, GD&T, DOE, PLC programming. '.repeat(6)}`,
  url: 'https://jobs.lever.co/acme/1b2c3d4e-1111-2222-3333-444455556666',
  location: 'Boise, ID, US',
  source: 'jsonld',
};

test('THE PANEL IS TOLD WHAT A PAGE IS: the posting, its fit, and the application', async () => {
  const seen = await post('/api/apply-page', { pageUrl: POSTING.url, posting: POSTING });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  const id = seen.body.id;

  // By the page — the apply page of the posting resolves to it.
  const { status, body } = await get(`/api/panel?pageUrl=${encodeURIComponent(`${POSTING.url}/apply`)}`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.job.id, id);
  assert.equal(body.job.title, 'Manufacturing Engineer I');
  assert.equal(body.job.company, 'Acme Robotics');
  assert.equal(body.job.location, 'Boise, ID, US');
  assert.match(body.job.logo || '', /\/api\/logo\?company=Acme/, 'the logo is served by this dashboard');
  assert.ok(Number.isFinite(body.fit.score), 'the deck\'s own fit score');
  assert.ok(body.fit.band, 'and its band');
  assert.ok(Array.isArray(body.fit.skills.matched) && Array.isArray(body.fit.skills.missing), 'skills asked for, split by whether he has them');
  assert.ok(Array.isArray(body.fit.reasons));
  assert.ok(body.application, 'the build that /api/apply-page started');
  assert.ok(['tailoring', 'ready'].includes(body.application.status));
  assert.equal(body.submit, false, 'nothing here submits');

  // By id — what an armed tab asks with, whatever page it is on.
  const byId = await get(`/api/panel?id=${id}&pageUrl=${encodeURIComponent('https://sso.example.test/login')}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.job.id, id, 'the id wins over a page that resolves to nothing');
});

// TWO POSTINGS AT ONE COMPANY ARE NOT INTERCHANGEABLE (2026-09-19).
//
// He had Tesla's form for "Manufacturing Engineer, Process & Equipment
// Development" open and the panel showed "Manufacturing Engineer, Manufacturing
// Development" — a different Palo Alto posting he had already applied to — so it
// also told him he had applied to this one. The tab kept its earlier binding,
// and the only staleness check asked whether the page mentions the company,
// which every posting at that company passes.
test('the page he is on outranks the job the tab remembers', async () => {
  const sibling = {
    ...POSTING,
    title: 'Manufacturing Engineer, Process & Equipment Development',
    url: 'https://jobs.lever.co/acme/9999aaaa-bbbb-cccc-dddd-eeeeffff0000',
  };
  const a = await post('/api/apply-page', { pageUrl: POSTING.url, posting: POSTING });
  const b = await post('/api/apply-page', { pageUrl: sibling.url, posting: sibling });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.notEqual(a.body.id, b.body.id, 'two postings, two rows');

  // The tab still holds the FIRST posting; the page in front of him is the
  // second. The page wins.
  const got = await get(`/api/panel?id=${a.body.id}&pageUrl=${encodeURIComponent(`${sibling.url}/apply`)}`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.job.id, b.body.id, 'the panel shows the posting the page is for');
  assert.equal(got.body.job.title, sibling.title, 'not the one the tab was bound to');

  // And the id still wins where the page resolves to nothing, which is what a
  // remembered binding is for — an apply form on a host the store never saw.
  const off = await get(`/api/panel?id=${a.body.id}&pageUrl=${encodeURIComponent('https://sso.example.test/login')}`);
  assert.equal(off.body.job.id, a.body.id);
});

test('HIS NOTE WRITES THE RESUME AGAIN, and the panel shows the note it was written with', async () => {
  const { body } = await get(`/api/panel?pageUrl=${encodeURIComponent(POSTING.url)}`);
  const id = body.job.id;
  // A REAL BUILD IS A REAL WAIT. The model chooses the shape, the guard checks
  // every claim against cv.md, then the page is laid out and measured — one to
  // two minutes, by design (RESUME-RULES §10). Sixty seconds was under that and
  // the test failed on a loaded machine with "still writing the resume", which
  // is the system working.
  let built = false;
  for (let i = 0; i < 200 && !built; i += 1) {
    const r = await get(`/api/apply-resume?id=${id}`);
    if (r.status === 200) built = true;
    else await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(built, 'the first build finishes before his note is sent');
  const empty = await post('/api/panel-retailor', { id, request: '   ' });
  assert.equal(empty.status, 400, 'an empty note is refused');
  const asked = await post('/api/panel-retailor', { id, request: 'lead with the fixture work' });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'tailoring');
  assert.equal(asked.body.submit, false);
  let ready = null;
  for (let i = 0; i < 200 && !ready; i += 1) {
    const r = await get(`/api/panel?id=${id}&pageUrl=${encodeURIComponent(POSTING.url)}`);
    if (r.body.application?.status === 'ready') ready = r.body;
    else await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(ready, 'the build with his note finishes');
  assert.equal(ready.application.request, 'lead with the fixture work', 'and the panel is told which note it was written with');
  assert.equal(ready.application.resume, true);
  const unknown = await post('/api/panel-retailor', { id: 'nope', request: 'x' });
  assert.equal(unknown.status, 404);
});

test('A COVER LETTER IS WRITTEN IN THE BACKGROUND AND READ BACK — switched off here, it says so', async () => {
  const { body } = await get(`/api/panel?pageUrl=${encodeURIComponent(POSTING.url)}`);
  const id = body.job.id;
  const none = await get(`/api/cover-letter?id=${id}`);
  assert.equal(none.status, 404, 'nothing written yet');
  const asked = await post('/api/cover-letter', { id, request: 'mention the fixture' });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'writing');
  assert.equal(asked.body.submit, false);
  let done = null;
  for (let i = 0; i < 40 && !done; i += 1) {
    const r = await get(`/api/cover-letter?id=${id}`);
    if (r.status === 200) done = r.body;
    else await new Promise((res) => setTimeout(res, 500));
  }
  assert.ok(done, 'the write ends');
  // JARVIS_TAILOR=off: no model is called, and the answer says exactly that.
  assert.equal(done.status, 'failed');
  assert.match(done.error || done.why, /switched off/);
  assert.equal(done.request, 'mention the fixture');
  assert.equal(done.submit, false);
  const unknown = await post('/api/cover-letter', { id: 'nope' });
  assert.equal(unknown.status, 404);
});

test('A PAGE THAT IS NOT A POSTING IS SAID SO — never the last application\'s job', async () => {
  const { status, body } = await get(`/api/panel?pageUrl=${encodeURIComponent('https://careers.other.test/jobs/999')}`);
  assert.equal(status, 404);
  assert.match(body.error, /not a posting in your store/);
});

test('THE PANEL\'S RESUME IS THE APPLICATION\'S PDF, by id', async () => {
  const { body } = await get(`/api/panel?pageUrl=${encodeURIComponent(POSTING.url)}`);
  const id = body.job.id;
  let pdf = null;
  for (let i = 0; i < 60 && !pdf; i += 1) {
    const r = await get(`/api/apply-resume?id=${id}`);
    if (r.status === 200) pdf = r.body;
    else if (r.status === 425) await new Promise((res) => setTimeout(res, 1000));
    else assert.fail(`unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  }
  assert.ok(pdf && pdf.byteLength > 1000, 'a real PDF');
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), '%PDF-');
  const after = await get(`/api/panel?id=${id}&pageUrl=${encodeURIComponent(POSTING.url)}`);
  assert.equal(after.body.application.status, 'ready');
  assert.equal(after.body.application.resume, true, 'and the panel is told there is one to show');
  assert.ok(after.body.application.family?.label, 'with the family it was built from');
});
