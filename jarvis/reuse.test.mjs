/**
 * Reuse: when a finished resume or answer stands in for writing it again, and
 * when it must not. Temp directories only; no model, no store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { jdKey, sourcesVersion, saveBuild, findReusableBuild, restoreBuild, makeSiblingIndex, MIN_JD_CHARS } from './reuse.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-reuse-'));
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

const JD = 'Design fixtures and tooling for robotic assembly lines. Work with SolidWorks, GD&T and DFM. '.repeat(8);

test('the same description is the same key — formatting, digits and links aside', () => {
  const a = jdKey('Acme Robotics', `Req 1234 posted 2026-09-01\n${JD}\nApply at https://acme.com/jobs/1`);
  const b = jdKey('Acme Robotics', `Req 9876 posted 2026-09-14   ${JD.toUpperCase()}  Apply at https://acme.com/jobs/2`);
  assert.ok(a);
  assert.equal(a, b, 'a repost with a new req number and date is the same job');
  assert.notEqual(jdKey('Acme Robotics', `${JD} Also lead the vision team.`), a, 'different words are a different job');
  assert.notEqual(jdKey('Other Co', JD), a, 'the same boilerplate at another company is another job');
  assert.equal(jdKey('Acme', 'x'.repeat(MIN_JD_CHARS - 1)), null, 'too little text to call two postings the same');
});

test('the CV version changes when any source file changes', () => {
  const f1 = path.join(dir, 'cv.md'); const f2 = path.join(dir, 'pool.json');
  writeFileSync(f1, 'cv one'); writeFileSync(f2, '{}');
  const v1 = sourcesVersion([f1, f2]);
  assert.equal(sourcesVersion([f1, f2]), v1);
  writeFileSync(f1, 'cv one, now with the Mars Rover Team');
  assert.notEqual(sourcesVersion([f1, f2]), v1);
});

function fakeBuild(name, content) {
  const family = path.join(dir, 'resumes', 'mechanical');
  mkdirSync(family, { recursive: true });
  const pdf = path.join(family, name);
  writeFileSync(pdf, content);
  return pdf;
}

test('a posting reuses its own build — until the CV or its description changes', () => {
  const builds = path.join(dir, 'builds1');
  const key = jdKey('Acme Robotics', JD);
  const pdf = fakeBuild('Alex Rivera - Acme Robotics - Mechanical Engineer.pdf', 'PDF-ONE');
  saveBuild(builds, 'job1', { jdKey: key, sources: 'v1', pdfPath: pdf, title: 'Mechanical Engineer', familyKey: 'mechanical' });

  const found = findReusableBuild(builds, { id: 'job1', jdKey: key, sources: 'v1' });
  assert.equal(found?.sameJob, true);
  assert.equal(findReusableBuild(builds, { id: 'job1', jdKey: key, sources: 'v2' }), null, 'a new CV means a new resume');
  assert.equal(findReusableBuild(builds, { id: 'job1', jdKey: jdKey('Acme Robotics', `${JD} New duties.`), sources: 'v1' }), null, 'a changed description means a new resume');
});

test('the snapshot survives a second posting overwriting the same file name', () => {
  const builds = path.join(dir, 'builds2');
  const key = jdKey('Acme Robotics', JD);
  const pdf = fakeBuild('Alex Rivera - Acme Robotics - Test Engineer.pdf', 'FOR-JOB-A');
  saveBuild(builds, 'jobA', { jdKey: key, sources: 'v1', pdfPath: pdf });
  writeFileSync(pdf, 'FOR-JOB-B');   // another "Test Engineer" posting at Acme builds over it
  const found = findReusableBuild(builds, { id: 'jobA', jdKey: key, sources: 'v1' });
  restoreBuild(found, pdf);
  assert.equal(readFileSync(pdf, 'utf-8'), 'FOR-JOB-A', 'the resume that was built for job A is what job A gets');
});

test('a different posting with the same description borrows the newest build; nothing else does', () => {
  const builds = path.join(dir, 'builds3');
  const key = jdKey('Acme Robotics', JD);
  saveBuild(builds, 'old', { jdKey: key, sources: 'v1', pdfPath: fakeBuild('old.pdf', 'OLD') });
  saveBuild(builds, 'new', { jdKey: key, sources: 'v1', pdfPath: fakeBuild('new.pdf', 'NEW') });
  saveBuild(builds, 'stale', { jdKey: key, sources: 'v0', pdfPath: fakeBuild('stale.pdf', 'STALE') });
  // "new" was saved after "old"; force the order in case both landed in one millisecond.
  const recNew = JSON.parse(readFileSync(path.join(builds, 'new.json'), 'utf-8'));
  writeFileSync(path.join(builds, 'new.json'), JSON.stringify({ ...recNew, savedAt: '2099-01-01T00:00:00Z' }));

  const found = findReusableBuild(builds, { id: 'repost', jdKey: key, sources: 'v1' });
  assert.equal(found.sameJob, false);
  assert.equal(found.record.id, 'new');
  const out = path.join(dir, 'resumes', 'mechanical', 'Alex Rivera - Acme Robotics - Repost.pdf');
  restoreBuild(found, out);
  assert.equal(readFileSync(out, 'utf-8'), 'NEW');

  assert.equal(findReusableBuild(builds, { id: 'repost', jdKey: null, sources: 'v1' }), null, 'no description, no borrowing');
  assert.equal(findReusableBuild(builds, { id: 'repost', jdKey: jdKey('Acme Robotics', `${JD} Different.`), sources: 'v1' }), null);
});

test('a build with no file behind it is not kept', () => {
  assert.equal(saveBuild(path.join(dir, 'builds4'), 'x', { pdfPath: path.join(dir, 'missing.pdf') }), null);
  assert.equal(existsSync(path.join(dir, 'builds4', 'x.json')), false);
});

test('siblings for answers are the other postings with the same description', () => {
  const answers = path.join(dir, 'answers');
  mkdirSync(answers, { recursive: true });
  for (const id of ['aaa111', 'bbb222', 'ccc333']) writeFileSync(path.join(answers, `${id}-deadbeef.json`), '{}');
  const store = {
    aaa111: { company: 'Acme Robotics', description: JD },
    bbb222: { company: 'Acme Robotics', description: `  ${JD}\n\n55  ` },
    ccc333: { company: 'Acme Robotics', description: `${JD} Totally different role.` },
  };
  let lookups = 0;
  const siblingsOf = makeSiblingIndex({ answerDir: answers, buildDir: path.join(dir, 'nobuilds'), describe: (id) => { lookups += 1; return store[id] || null; } });
  const key = jdKey('Acme Robotics', JD);
  assert.deepEqual(siblingsOf('aaa111', key), ['bbb222']);
  const before = lookups;
  siblingsOf('aaa111', key);
  assert.equal(lookups, before, 'a posting\'s key is worked out once');
  assert.deepEqual(siblingsOf('aaa111', null), []);
});
