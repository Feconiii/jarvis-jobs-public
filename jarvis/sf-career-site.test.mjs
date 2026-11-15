/**
 * F-956: a SuccessFactors career site names one posting by two numbers.
 * Danfoss's scan stored /job/<slug>/1366617557/; his form was
 * /job/<slug>/50576-en_GB/, and the extension recorded a second row. The page
 * must find the stored posting by host + slug, and tell two postings with one
 * slug apart by the page's own description, or not at all.
 *
 * Against a temp store, never his.
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
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
let server, dir, token, idOf;

const words = (seed, n) => Array.from({ length: n }, (_, i) => `${seed}word${i}`).join(' ');
const UTICA_A = `Utica plant process engineering ${words('alpha', 80)}`;
const UTICA_B = `Utica plant process engineering ${words('bravo', 80)}`;

test.before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'jarvis-sf-site-'));
  process.env.JARVIS_DATA_DIR = dir;
  const { upsertJobs, db } = await import('./store.mjs');
  idOf = (req) => db().prepare('SELECT id FROM jobs WHERE url LIKE ?').get(`%/${req}/`)?.id;
  upsertJobs([
    { url: 'https://jobs.example-sf.com/job/Maumee-Engineer%2C-Manufacturing-Engineering-OH-OH-43537/1368607557/', title: 'Engineer, Manufacturing Engineering', company: 'Danfoss', location: 'Maumee, OH', description: words('maumee', 90), source: 'successfactors' },
    { url: 'https://jobs.example-sf.com/job/Utica-Engineer%2C-Manufacturing-Engineering-NY-NY-13502/1366617557/', title: 'Engineer, Manufacturing Engineering', company: 'Danfoss', location: 'Utica, NY', description: UTICA_A, source: 'successfactors' },
    { url: 'https://jobs.example-sf.com/job/Utica-Engineer%2C-Manufacturing-Engineering-NY-NY-13502/1373749157/', title: 'Engineer, Manufacturing Engineering', company: 'Danfoss', location: 'Utica, NY', description: UTICA_B, source: 'successfactors' },
    { url: 'https://jobs.example-sf.com/job/Van-Wert-Manufacturing-Engineer-OH-OH-45891/1358070157/', title: 'Manufacturing Engineer', company: 'Danfoss', location: 'Van Wert, OH', description: words('vanwert', 90), source: 'successfactors' },
  ]);
  server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, JARVIS_AUTO: '0', JARVIS_DATA_DIR: dir, JARVIS_RESUME_DIR: path.join(dir, 'resumes'), JARVIS_TAILOR: 'off' },
    stdio: 'ignore',
  });
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  token = (await (await fetch(`${BASE}/api/apply-token`)).json()).token;
});

test.after(async () => {
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
  try { (await import('./store.mjs')).db().close(); } catch { /* already closed */ }
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the WAL a moment longer */ } }
});

const page = async (pageUrl, description, title = 'Engineer, Manufacturing Engineering') => {
  const r = await fetch(`${BASE}/api/apply-page`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': token },
    body: JSON.stringify({ pageUrl, posting: { title, company: 'Danfoss', description, url: pageUrl } }),
  });
  return r.json();
};

test('one stored posting with that slug is the page', async () => {
  const r = await page('https://jobs.example-sf.com/job/Van-Wert-Manufacturing-Engineer-OH-OH-45891/48811-en_US/', words('vanwert', 90), 'Manufacturing Engineer');
  assert.equal(r.id, idOf('1358070157'));
  assert.equal(r.recorded, false);
});

test('two with one slug: the description decides (Danfoss Utica)', async () => {
  const r = await page('https://jobs.example-sf.com/job/Utica-Engineer,-Manufacturing-Engineering-NY-NY-13502/50576-en_GB/', UTICA_B);
  assert.equal(r.id, idOf('1373749157'));
  assert.equal(r.recorded, false);
});

test('…and a description that matches neither picks none of them', async () => {
  const r = await page('https://jobs.example-sf.com/job/Utica-Engineer,-Manufacturing-Engineering-NY-NY-13502/50577-en_GB/', words('charlie', 90));
  assert.ok(r.id && r.id !== idOf('1366617557') && r.id !== idOf('1373749157'));
});
