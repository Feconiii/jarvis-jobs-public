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
