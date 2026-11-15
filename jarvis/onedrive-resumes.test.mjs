// The phone copy of every resume (2026-09-27): one folder per posting, named to
// be searched, holding "Alex Rivera Resume.pdf"; a second run copies nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { folderName, plan, archive, copyAll, syncToOneDrive, TOP, ATTACH } from './onedrive-resumes.mjs';

test('folder names OneDrive accepts, without the location or the legal entity', () => {
  assert.equal(folderName('Acme: Test / Build?'), 'Acme Test Build');
  assert.equal(folderName('Ends with a dot.'), 'Ends with a dot');
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-od-'));
  writeFileSync(path.join(dir, 'Alex Rivera Resume - manufacturing - Micron.pdf'), '%PDF a');
  writeFileSync(path.join(dir, 'Alex Rivera Resume - manufacturing - Micron.pdf.json'), JSON.stringify({ company: '0001 Micron Technology, Inc', title: 'New College Grad Process Engineer Boise Idaho United States Of America', at: '2026-09-03T00:00:00Z' }));
  writeFileSync(path.join(dir, 'Alex-Rivera_automation_GlobalFoundries_Fab-Automation-Engineer.pdf'), '%PDF b');
  const rows = plan(archive(dir));
  assert.deepEqual(rows.map((r) => r.folder).sort(), ['GlobalFoundries - Fab Automation Engineer', 'Micron Technology - New College Grad Process Engineer']);
});

test('two resumes for one role are told apart by date (the older keeps the plain name); everything lands as "Alex Rivera Resume.pdf"; a rerun copies nothing', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'jarvis-od-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'jarvis-od-dest-'));
  for (const [f, at] of [['A', '2026-09-03'], ['B', '2026-09-23']]) {
    writeFileSync(path.join(src, `Alex Rivera Resume - mechanical - Amazon - ${f}.pdf`), `%PDF ${f}`);
    writeFileSync(path.join(src, `Alex Rivera Resume - mechanical - Amazon - ${f}.pdf.json`), JSON.stringify({ company: 'Amazon', title: 'Mechanical Engineer', at: `${at}T12:00:00Z` }));
  }
  const first = copyAll({ dest, items: archive(src) });
  assert.equal(first.copied, 2);
  const folders = readdirSync(path.join(dest, TOP)).filter((n) => n !== 'INDEX.txt').sort();
  assert.deepEqual(folders, ['Amazon - Mechanical Engineer', 'Amazon - Mechanical Engineer (Sep 23)'], 'the oldest keeps the plain name, so a newer build never renames a folder');
  for (const f of folders) assert.ok(existsSync(path.join(dest, TOP, f, ATTACH)));
  assert.equal(copyAll({ dest, items: archive(src) }).copied, 0);
});

test('A TEST ARCHIVE NEVER REACHES HIS ONEDRIVE, and a stale folder goes only when it holds nothing but the resume', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'jarvis-od-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'jarvis-od-dest-'));
  assert.equal(syncToOneDrive({ from: src, dest }).skipped, 'not his resume archive');
  assert.ok(!existsSync(path.join(dest, TOP)), 'nothing was written');

  writeFileSync(path.join(src, 'Alex Rivera Resume - mechanical - Acme - A.pdf'), '%PDF a');
  const top = path.join(dest, TOP);
  for (const n of ['Old Co - Gone', 'His Own Folder']) mkdirSync(path.join(top, n), { recursive: true });
  writeFileSync(path.join(top, 'Old Co - Gone', ATTACH), '%PDF old');
  writeFileSync(path.join(top, 'His Own Folder', ATTACH), '%PDF x');
  writeFileSync(path.join(top, 'His Own Folder', 'notes.txt'), 'mine');
  const r = copyAll({ dest, items: archive(src) });
  assert.equal(r.removed, 1);
  assert.ok(!existsSync(path.join(top, 'Old Co - Gone')));
  assert.ok(existsSync(path.join(top, 'His Own Folder', 'notes.txt')), 'a folder with anything else in it is his');

  // A read that lost most of the archive does not empty his phone.
  for (let i = 0; i < 12; i += 1) { mkdirSync(path.join(top, `Co ${i}`)); writeFileSync(path.join(top, `Co ${i}`, ATTACH), '%PDF'); }
  const held = copyAll({ dest, items: archive(src) });
  assert.equal(held.removed, 0);
  assert.match(held.pruneHeld, /12 folders/);
});

// F-1053 (2026-11-14): the copy is all synchronous file work, 1.6 to 2.3 s on
// his 1,021-resume archive, and the dashboard ran it in-process at boot,
// hourly and after every resume build: the server froze for each.
test('THE COPY RUNS IN ITS OWN PROCESS: the dashboard and the resume builder never run it in theirs', async () => {
  const od = await import('./onedrive-resumes.mjs');
  assert.equal(typeof od.syncInBackground, 'function');
  // On in this process (the copy is off by default since 11-14), off in the child.
  const was = process.env.JARVIS_ONEDRIVE; process.env.JARVIS_ONEDRIVE = 'on';
  try {
  const src = mkdtempSync(path.join(tmpdir(), 'jarvis-od-src-'));
  assert.equal((await od.syncInBackground({ from: src })).skipped, 'not his resume archive', 'a test archive spawns nothing');
  // Switched off inside the child, so his OneDrive is never touched here.
  const one = od.syncInBackground({ env: { JARVIS_ONEDRIVE: 'off' } });
  const two = od.syncInBackground({ env: { JARVIS_ONEDRIVE: 'off' } });
  assert.equal(one, two, 'a call while one runs joins it');
  let ticks = 0; const iv = setInterval(() => { ticks += 1; }, 5);
  const r = await one;
  clearInterval(iv);
  assert.equal(r.skipped, 'switched off');
  assert.ok(Number.isInteger(r.pid) && r.pid !== process.pid, `ran in another process (${r.pid})`);
  assert.ok(ticks > 0, 'the event loop ran while it worked');
  const { readFileSync } = await import('fs');
  for (const f of ['serve.mjs', 'resume-for-job.mjs']) {
    const src2 = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src2, /\bsyncToOneDrive\s*\(/, `${f} does not copy in its own process`);
    assert.match(src2, /\bsyncInBackground\s*\(/, `${f} hands the copy to the child`);
  }
  } finally { if (was !== undefined) process.env.JARVIS_ONEDRIVE = was; else delete process.env.JARVIS_ONEDRIVE; }
});

// 2026-11-14, his words 11-13: "honestly we can stop the copying to onedrive
// thing i never use that, lets just turn it off for better time".
test('THE COPY IS OFF BY DEFAULT: no copy and no child process unless it is turned on', async () => {
  const od = await import('./onedrive-resumes.mjs');
  const was = process.env.JARVIS_ONEDRIVE; delete process.env.JARVIS_ONEDRIVE;
  const wasDir = process.env.JARVIS_ONEDRIVE_DIR;
  // Never his real profile (review): a temp one with no OneDrive setting.
  const wasProf = process.env.JARVIS_PROFILE;
  const profDir = mkdtempSync(path.join(tmpdir(), 'jarvis-od-prof-'));
  process.env.JARVIS_PROFILE = path.join(profDir, 'profile.yml');
  writeFileSync(process.env.JARVIS_PROFILE, 'name: x\n');
  try {
    const dest = mkdtempSync(path.join(tmpdir(), 'jarvis-od-dest-'));
    // His archive, a temporary destination: off writes nothing there.
    assert.equal(od.syncToOneDrive({ dest, items: [] }).skipped, 'switched off');
    assert.ok(!existsSync(path.join(dest, TOP)), 'nothing was written');
    // In the background: resolves at once, no child process, nothing written.
    process.env.JARVIS_ONEDRIVE_DIR = dest;
    const r = await od.syncInBackground({ env: { JARVIS_ONEDRIVE_DIR: dest } });
    assert.equal(r.skipped, 'switched off');
    assert.equal(r.pid, undefined, 'no child was started');
    assert.ok(!existsSync(path.join(dest, TOP)), 'nothing was written by a child');
  } finally {
    if (was !== undefined) process.env.JARVIS_ONEDRIVE = was;
    if (wasDir !== undefined) process.env.JARVIS_ONEDRIVE_DIR = wasDir; else delete process.env.JARVIS_ONEDRIVE_DIR;
    if (wasProf !== undefined) process.env.JARVIS_PROFILE = wasProf; else delete process.env.JARVIS_PROFILE;
  }
});

test('the switch: JARVIS_ONEDRIVE or resumes.onedrive turns it on, JARVIS_ONEDRIVE=off always wins', async () => {
  const { oneDriveSwitch } = await import('./onedrive-resumes.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-od-prof-'));
  const prof = (name, text) => { const f = path.join(dir, name); writeFileSync(f, text); return f; };
  const none = prof('none.yml', 'name: x\n');
  const on = prof('on.yml', 'resumes:\n  onedrive: on\n');
  const onBool = prof('on-bool.yml', 'resumes:\n  onedrive: true\n');
  const dirOnly = prof('dir.yml', 'resumes:\n  onedrive_dir: "C:/Users/someone/OneDrive"\n');
  const dirOff = prof('dir-off.yml', 'resumes:\n  onedrive_dir: "C:/Users/someone/OneDrive"\n  onedrive: off\n');
  const missing = path.join(dir, 'missing.yml');
  assert.equal(oneDriveSwitch({ env: {}, profileFile: none, isHim: true }).on, false, 'off by default');
  assert.equal(oneDriveSwitch({ env: {}, profileFile: missing, isHim: true }).on, false, 'no profile: off');
  assert.equal(oneDriveSwitch({ env: {}, profileFile: on, isHim: true }).on, true);
  assert.equal(oneDriveSwitch({ env: {}, profileFile: onBool, isHim: true }).on, true);
  assert.equal(oneDriveSwitch({ env: { JARVIS_ONEDRIVE: 'on' }, profileFile: none, isHim: true }).on, true);
  assert.equal(oneDriveSwitch({ env: { JARVIS_ONEDRIVE: 'off' }, profileFile: on, isHim: true }).on, false, 'off wins');
  // Someone else who named a folder chose the copy; he never needed one.
  assert.equal(oneDriveSwitch({ env: {}, profileFile: dirOnly, isHim: false }).on, true);
  assert.equal(oneDriveSwitch({ env: {}, profileFile: dirOnly, isHim: true }).on, false);
  assert.equal(oneDriveSwitch({ env: {}, profileFile: dirOff, isHim: false }).on, false);
  assert.equal(oneDriveSwitch({ env: { JARVIS_ONEDRIVE_DIR: 'C:/x' }, profileFile: none, isHim: false }).on, true);
  assert.equal(oneDriveSwitch({ env: { JARVIS_ONEDRIVE_DIR: 'C:/x' }, profileFile: none, isHim: true }).on, false);
  assert.equal(oneDriveSwitch({ env: { JARVIS_ONEDRIVE: '0' }, profileFile: on, isHim: true }).on, false);
});

test('the dashboard schedules the copy only when the switch is on', async () => {
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('const od = oneDriveSwitch()');
  assert.ok(at > 0, 'serve.mjs reads the switch');
  const block = src.slice(at, src.indexOf('});', src.indexOf('setInterval(oneDrive', at)));
  assert.match(block, /if \(!od\.on\)[\s\S]*else \{[\s\S]*setTimeout\(oneDrive[\s\S]*setInterval\(oneDrive/, 'both timers sit in the on branch');
});
