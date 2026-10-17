/**
 * NAMES, FILES AND RESUMES FOR A SECOND PERSON.
 *
 * Everything here runs as the made-up finance user in
 * jarvis/presets/finance-data/test-profile.yml ("Test Analyst"), in a child
 * process, because targeting.mjs reads the profile once at import. The suite
 * itself stays pinned to the default person; the last test checks that the
 * same calls still give his answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE = path.join(HERE, 'presets', 'finance-data', 'test-profile.yml');
const PORT = 4398;
const BASE = `http://127.0.0.1:${PORT}`;
const url = (f) => pathToFileURL(path.join(HERE, f)).href;

/** Run a module snippet as the test analyst (or as the default person) and return its JSON. */
function runAs(code, { profile = PROFILE } = {}) {
  const env = { ...process.env };
  delete env.JARVIS_ONEDRIVE_DIR;
  delete env.JARVIS_ONEDRIVE_FOLDER;
  delete env.JARVIS_RESUME_POOL;
  if (profile) env.JARVIS_PROFILE = profile; else delete env.JARVIS_PROFILE;
  // As the default person the OneDrive sync would really run: switch it off.
  if (!profile) env.JARVIS_ONEDRIVE = 'off'; else delete env.JARVIS_ONEDRIVE;
  // NODE_TEST_CONTEXT pins the default person when no profile is named.
  env.NODE_TEST_CONTEXT = env.NODE_TEST_CONTEXT || 'child-v8';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const PROBE = `
  const fam = await import(${JSON.stringify(url('resume-family.mjs'))});
  const rfj = await import(${JSON.stringify(url('resume-for-job.mjs'))});
  const od = await import(${JSON.stringify(url('onedrive-resumes.mjs'))});
  const li = await import(${JSON.stringify(url('linkedin-fill.mjs'))});
  console.log(JSON.stringify({
    file: fam.resumeFileName(),
    path: fam.resumePathFor({ title: 'Financial Analyst' }).path,
    finance: fam.familyFor({ title: 'Financial Analyst' }).key,
    quality: fam.familyFor({ title: 'Quality Data Analyst', description: 'test validation manufacturing' }).key,
    robotics: fam.familyFor({ title: 'Robotics Engineer' }).key,
    families: fam.ALL_FAMILIES.map((f) => f.key),
    audit: rfj.auditName({ family: 'total-experience', job: { company: 'Acme', title: 'Analyst' } }),
    attach: od.ATTACH,
    oneDrive: od.schoolOneDrive(),
    sync: od.syncToOneDrive(),
    linkedin: li.attachName({ company: 'Acme', title: 'Analyst' }),
  }));
`;

test('the test analyst: their name on every file, one family, OneDrive not configured', () => {
  const r = runAs(PROBE);
  assert.equal(r.file, 'Test Analyst Resume.pdf');
  assert.equal(r.path, 'output/jarvis-resumes/total-experience/Test Analyst Resume.pdf');
  assert.equal(r.finance, 'total-experience');
  assert.equal(r.quality, 'total-experience', 'no hardware lane for a finance posting that says "quality"');
  assert.equal(r.robotics, 'total-experience');
  assert.deepEqual(r.families, ['total-experience']);
  assert.equal(r.audit, 'Test Analyst Resume - total-experience - Acme - Analyst.pdf');
  assert.equal(r.attach, 'Test Analyst Resume.pdf');
  assert.equal(r.oneDrive, null, 'never guesses a synced folder on someone else\'s machine');
  assert.equal(r.sync.skipped, 'OneDrive not configured');
  assert.equal(r.linkedin, 'Test Analyst Resume - Acme - Analyst.pdf');
});

test('a pool with no hand-written plan builds the whole pool, in pool order, and is still checked against cv.md', () => {
  const r = runAs(`
    const rv = await import(${JSON.stringify(url('resume-variants.mjs'))});
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    const pool = {
      name: 'Test Analyst',
      contact: { email: 'analyst@example.com', phone: '+1 (555) 010-0000' },
      education: { school: 'Example State University', location: 'Seattle, WA', degree: 'BBA, Finance', date: 'May 2026', coursework: ['Corporate Finance', 'Financial Modeling'] },
      orgs: {
        bank: { org: 'Example Bank', location: 'Seattle, WA', date: 'Summer 2025', title: 'Financial Analyst Intern',
          bullets: { forecast: { text: 'Built a monthly cash forecast model in Excel.' }, variance: { text: 'Wrote variance commentary for the budget review.' } } },
        cafe: { org: 'Campus Cafe', location: 'Seattle, WA', date: '2024', title: 'Shift Lead',
          bullets: { cash: { text: 'Reconciled the cash drawer every night.' } } },
      },
      projects: { dcf: { lead: 'DCF Valuation', text: 'Valued a retailer with a DCF model.' } },
      skills: { tools: { lead: 'Tools', items: ['Excel', 'SQL'] } },
    };
    const spec = rv.buildSpec('total-experience', pool);
    const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-pool-'));
    const cv = path.join(dir, 'cv.md');
    writeFileSync(cv, [
      'Example State University', 'May 2026', 'Corporate Finance, Financial Modeling',
      'Example Bank — Financial Analyst Intern — Summer 2025',
      '- Built a monthly cash forecast model in Excel.', '- Wrote variance commentary for the budget review.',
      'Campus Cafe — Shift Lead — 2024', '- Reconciled the cash drawer every night.',
      'DCF Valuation: Valued a retailer with a DCF model.', 'Tools: Excel, SQL',
    ].join('\\n'));
    const clean = rv.verifyPoolAgainstCv(pool, cv, path.join(dir, 'none.md'));
    pool.orgs.bank.bullets.forecast.text = 'Built a monthly cash forecast model in Excel saving $2M.';
    const drifted = rv.verifyPoolAgainstCv(pool, cv, path.join(dir, 'none.md'));
    console.log(JSON.stringify({
      orgs: spec.experience.map((e) => [e.orgKey, e.title, e.bullets.map((b) => b.provenanceKey)]),
      projects: spec.projects.map((p) => p.key),
      skills: spec.skills.map((s) => s.key),
      edu: spec.education[0].bullets,
      name: spec.name,
      clean, drifted: drifted.length,
    }));
  `);
  assert.deepEqual(r.orgs, [
    ['bank', 'Financial Analyst Intern', ['bank.forecast', 'bank.variance']],
    ['cafe', 'Shift Lead', ['cafe.cash']],
  ]);
  assert.deepEqual(r.projects, ['dcf']);
  assert.deepEqual(r.skills, ['tools']);
  assert.deepEqual(r.edu, [{ lead: 'Relevant Coursework', text: 'Corporate Finance, Financial Modeling' }], 'no GPA or honors line the pool does not have');
  assert.equal(r.name, 'Test Analyst');
  assert.deepEqual(r.clean, [], 'a pool copied from its cv.md passes');
  assert.equal(r.drifted, 1, 'a line that drifted from cv.md still fails the build');
});

test('the dashboard says who it is running for: /api/person and the stamped page', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-person-api-'));
  const env = { ...process.env, JARVIS_PROFILE: PROFILE, JARVIS_AUTO: '0', JARVIS_DATA_DIR: dir, JARVIS_RESUME_DIR: path.join(dir, 'resumes'), JARVIS_TAILOR: 'off', JARVIS_ONEDRIVE: 'off' };
  const server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)], { cwd: ROOT, env, stdio: 'ignore' });
  t.after(async () => {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(dir, { recursive: true, force: true });
  });
  let up = false;
  for (const until = Date.now() + 30000; Date.now() < until && !up;) {
    try { up = (await fetch(`${BASE}/`)).ok; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  assert.ok(up, 'the dashboard must start as the test analyst');

  const tok = await (await fetch(`${BASE}/api/apply-token`)).json();
  assert.equal(tok.person?.fullName, 'Test Analyst', 'the extension learns the name with its token');

  const p = await (await fetch(`${BASE}/api/person`, { headers: { 'x-jarvis-token': tok.token } })).json();
  assert.equal(p.fullName, 'Test Analyst');
  assert.equal(p.firstName, 'Test');
  assert.equal(p.preset, 'finance-data');
  assert.equal(p.resumeFileName, 'Test Analyst Resume.pdf');

  const html = await (await fetch(`${BASE}/`)).text();
  const m = html.match(/window\.__JARVIS_PERSON=(\{.*?\});<\/script>/);
  assert.ok(m, 'the page carries the person');
  assert.equal(JSON.parse(m[1]).fullName, 'Test Analyst');
});

test('the default person is unchanged: his name, his four lanes', () => {
  const r = runAs(PROBE, { profile: null });
  assert.equal(r.file, 'Alex Rivera Resume.pdf');
  assert.equal(r.robotics, 'automation');
  assert.equal(r.quality, 'manufacturing');
  assert.equal(r.finance, 'total-experience');
  assert.deepEqual(r.families, ['total-experience', 'automation', 'manufacturing', 'mechanical']);
  assert.equal(r.linkedin, 'Alex Rivera Resume - Acme - Analyst.pdf');
});
