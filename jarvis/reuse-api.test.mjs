/**
 * "I come back and nothing is filled, I press fill again and the resume gets
 * rewritten" (Alex, 2026-09-15) — against a real server, a real build, and a
 * real restart.
 *
 * Temp store and temp resume folder; the model is off (JARVIS_TAILOR=off), so
 * the build is the family base laid out and measured — slow enough (tens of
 * seconds) that a rebuild would show, and nothing is spent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WRITER_VERSION } from './apply/essay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4388;
const BASE = `http://127.0.0.1:${PORT}`;
let server; let dir; let token;

async function start() {
  server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, JARVIS_AUTO: '0', JARVIS_DATA_DIR: dir, JARVIS_RESUME_DIR: path.join(dir, 'resumes'), JARVIS_TAILOR: 'off' },
    stdio: 'ignore',
  });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  token = (await (await fetch(`${BASE}/api/apply-token`)).json()).token;
}
async function stop() {
  const s = server; server = null;
  if (!s) return;
  await new Promise((r) => { s.once('exit', r); s.kill(); setTimeout(r, 3000); });
}
const post = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-token': token }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { 'x-jarvis-token': token } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
};

const DESCRIPTION = 'Design fixtures and tooling for the robot assembly line. SolidWorks, GD&T, tolerance analysis, root cause analysis, and hands-on builds with technicians. '.repeat(4);
const FIRST = {
  title: 'Manufacturing Engineer I', company: 'Acme Robotics', location: 'Boise, ID, US', source: 'jsonld',
  url: 'https://jobs.lever.co/acmerobotics/aaaa1111-2222-3333-4444-555566667777', description: `Req 1001. ${DESCRIPTION}`,
};
// The same role reposted: a new req number, a new link, the same description.
const REPOST = { ...FIRST, url: 'https://jobs.lever.co/acmerobotics/bbbb1111-2222-3333-4444-555566667777', description: `Req 2002. ${DESCRIPTION}` };

test.before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'jarvis-reuse-api-'));
  await start();
});
test.after(async () => {
  await stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ }
});

let firstId = '';

test('the first fill builds the resume', async () => {
  const seen = await post('/api/apply-page', { pageUrl: FIRST.url, posting: FIRST });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  firstId = seen.body.id;
  let ready = false;
  for (let i = 0; i < 240 && !ready; i += 1) {
    const r = await get(`/api/apply-status?id=${firstId}`);
    if (r.body?.status === 'failed') assert.fail(`the build failed: ${r.body.error}`);
    ready = r.body?.status === 'ready';
    if (!ready) await new Promise((res) => setTimeout(res, 1000));
  }
  assert.ok(ready, 'the first build finishes');
  const st = await get(`/api/apply-status?id=${firstId}`);
  assert.equal(st.body.reused, null, 'the first build is a build, not a reuse');
});

test('AFTER A RESTART, the same posting is ready at once — its resume is not written again', async () => {
  await stop();
  await start();
  const again = await post('/api/apply-page', { pageUrl: FIRST.url, posting: FIRST });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, firstId);
  assert.equal(again.body.status, 'ready', 'no second build after the dashboard restarted');
  const st = await get(`/api/apply-status?id=${firstId}`);
  assert.equal(st.body.reused?.sameJob, true);
  assert.match(st.body.tailoring.notices.join(' '), /reused the resume already built for this posting/, 'and the panel is told');
  const pdf = await get(`/api/apply-resume?id=${firstId}`);
  assert.equal(pdf.status, 200, 'the PDF is there to attach');
});

test('A REPOST WITH THE SAME DESCRIPTION borrows that resume', async () => {
  const seen = await post('/api/apply-page', { pageUrl: REPOST.url, posting: REPOST });
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.notEqual(seen.body.id, firstId, 'a different posting id');
  assert.equal(seen.body.status, 'ready', 'ready without building');
  const st = await get(`/api/apply-status?id=${seen.body.id}`);
  assert.equal(st.body.reused?.sameJob, false);
  assert.equal(st.body.reused?.from, firstId);
  assert.equal((await get(`/api/apply-resume?id=${seen.body.id}`)).status, 200);
});

test('AN ANSWER written for the first posting is handed to the repost for the same question', async () => {
  // Written the way the server writes one (serve.mjs answerKeyFor / answerFileFor).
  const question = 'Tell us about a project you are proud of';
  const keyFor = (id) => `${id}::${question.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const fileFor = (key) => {
    let h = 0;
    for (let i = 0; i < key.length; i += 1) h = ((h * 31) + key.charCodeAt(i)) >>> 0;
    return path.join(dir, 'answers', `${key.split('::')[0]}-${h.toString(16)}.json`);
  };
  mkdirSync(path.join(dir, 'answers'), { recursive: true });
  writeFileSync(fileFor(keyFor(firstId)), JSON.stringify({ status: 'ready', question, text: 'I designed a machine-vision inspection fixture.', problems: [], notices: [], request: '', writer: WRITER_VERSION }));
  // An answer an OLDER writer produced is never handed back (2026-09-17).
  const oldQuestion = 'Brief Cover Letter';
  const oldKey = `${firstId}::${oldQuestion.toLowerCase()}`;
  writeFileSync(fileFor(oldKey), JSON.stringify({ status: 'ready', question: oldQuestion, text: 'the retired pipeline wrote this', problems: [], notices: [], request: '' }));
  const stale = await get(`/api/answer?id=${firstId}&question=${encodeURIComponent(oldQuestion)}`);
  assert.equal(stale.status, 404, 'a saved answer from another writer version is not served');

  const repostId = (await post('/api/apply-page', { pageUrl: REPOST.url, posting: REPOST })).body.id;
  const got = await get(`/api/answer?id=${repostId}&question=${encodeURIComponent(question)}`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.text, 'I designed a machine-vision inspection fixture.');
  assert.equal(got.body.reusedFrom, firstId);

  const other = await get(`/api/answer?id=${repostId}&question=${encodeURIComponent('Why this company?')}`);
  assert.equal(other.status, 404, 'a question never answered is not invented from a different one');
});
