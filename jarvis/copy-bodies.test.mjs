// jarvis/copy-bodies.test.mjs — a board row takes its body from a copy (F-978).
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const DIR = mkdtempSync(path.join(tmpdir(), 'jarvis-copybody-'));
process.env.JARVIS_DATA_DIR = DIR;

const { planCopyBodies, usableBody, fillFromCopies, sameEmployer, similarTitle } = await import('./copy-bodies.mjs');
const { upsertJobs, getJob, jobId, getDescription, closeDb, db } = await import('./store.mjs');

const BODY = `Responsibilities: design fixtures and tooling for the assembly line. ${'Work with production and quality. '.repeat(12)}
Requirements: Bachelor's degree in Mechanical Engineering. 0-2 years of experience. SolidWorks, GD&T.`;
const THIN = 'Join our team! Apply now.';

test.after(() => { try { closeDb(); } catch {} rmSync(DIR, { recursive: true, force: true }); });

test('a body is usable only when long and with requirements', () => {
  assert.equal(usableBody(BODY), true);
  assert.equal(usableBody(THIN), false);
  assert.equal(usableBody(''), false);
});

test('the plan: a thin board row takes its longest usable copy, never the other way', () => {
  const who = { company: 'Acme Robotics', title: 'Manufacturing Engineer I' };
  const keeps = [{ id: 'k1', ...who, body: '' }, { id: 'k2', ...who, body: BODY }, { id: 'k3', ...who, body: THIN }];
  const copies = [
    { id: 'c1', keep: 'k1', ...who, body: BODY }, { id: 'c1b', keep: 'k1', company: 'Acme Robotics, Inc.', title: 'Manufacturing Engineer I - Austin', body: `${BODY} More detail.` },
    { id: 'c2', keep: 'k2', ...who, body: `${BODY} longer` },   // k2 has its own body: left alone
    { id: 'c3', keep: 'k3', ...who, body: THIN },              // a thin copy gives nothing
    { id: 'c4', keep: '', ...who, body: BODY },                // not a copy of anything
  ];
  assert.deepEqual(planCopyBodies(keeps, copies).map((p) => [p.id, p.from]), [['k1', 'c1b']]);
});

test('a wrong pointer never lends a body: another employer, or another title', () => {
  const keeps = [{ id: 'k1', company: 'Acme Robotics', title: 'Manufacturing Engineer I', body: '' }];
  assert.deepEqual(planCopyBodies(keeps, [{ id: 'x', keep: 'k1', company: 'Other Robotics', title: 'Manufacturing Engineer I', body: BODY }]), []);
  assert.deepEqual(planCopyBodies(keeps, [{ id: 'y', keep: 'k1', company: 'Acme Robotics', title: 'Senior Software Engineer, Cloud', body: BODY }]), []);
  assert.equal(sameEmployer('The Acme Company', 'ACME'), true);
  assert.equal(similarTitle('Mechanical Engineer', 'Mechanical Engineer (New Grad 2027)'), true);
  assert.equal(similarTitle('Mechanical Engineer', 'Electrical Engineer'), false);
});

test('in a store: written through the enricher\'s path, marked, rescored, and the marker drops when the board\'s own text arrives', async () => {
  const board = { url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Austin-TX/Manufacturing-Engineer_R100', title: 'Manufacturing Engineer', company: 'Acme', location: 'Austin, TX', source: 'workday', description: '' };
  const copy = { url: 'https://www.linkedin.com/jobs/view/4000000001', title: 'Manufacturing Engineer', company: 'Acme', location: 'Austin, TX', source: 'linkedin', description: BODY };
  upsertJobs([board, copy]);
  const kid = jobId(board.url), cid = jobId(copy.url);
  db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(kid, cid);   // what dedupe's pointCopies writes
  const dry = await fillFromCopies({ write: false });
  assert.deepEqual([dry.candidates, dry.plan, dry.filled], [1, 1, 0], 'a dry run writes nothing');
  assert.equal(getDescription(kid) || '', '');
  const r = await fillFromCopies({ write: true });
  assert.equal(r.filled, 1);
  assert.ok((getDescription(kid) || '').includes('Bachelor'), 'the copy\'s body is on the board row');
  const row = db().prepare('SELECT body_from, desc_len, fit_score FROM jobs WHERE id = ?').get(kid);
  assert.equal(row.body_from, `copy:${cid}`, 'it says where the body came from');
  assert.ok(row.desc_len >= 500 && row.fit_score != null, 'rescored on the new body');
  assert.equal((await fillFromCopies({ write: true })).filled, 0, 'a second run has nothing to do');
  // The enricher later reads the board itself: its text replaces the copy's, and the marker goes.
  const { updateJob } = await import('./store.mjs');
  updateJob(kid, { description: `${BODY} Board's own wording.` }, { rederive: true });
  assert.equal(db().prepare('SELECT body_from FROM jobs WHERE id = ?').get(kid).body_from, null);
  assert.ok(getJob(kid));
});

test('a borrowed body whose copy fails the employer/title check is cleared on the next run', async () => {
  const board = { url: 'https://hyve.wd1.myworkdayjobs.com/en-US/External/job/Fremont-CA/Thermal-Engineer_R200', title: 'Thermal Engineer', company: 'Hyve', location: 'Fremont, CA', source: 'workday', description: '' };
  const copy = { url: 'https://www.linkedin.com/jobs/view/4000000002', title: 'Thermal Engineer', company: 'Hyve', location: 'Fremont, CA', source: 'linkedin', description: BODY };
  upsertJobs([board, copy]);
  const kid = jobId(board.url), cid = jobId(copy.url);
  db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(kid, cid);
  await fillFromCopies({ write: true });
  assert.equal(db().prepare('SELECT body_from FROM jobs WHERE id = ?').get(kid).body_from, `copy:${cid}`);
  // The pointer turns out to be wrong: the copy is another role.
  db().prepare("UPDATE jobs SET title = 'Senior Software Engineer, Cloud' WHERE id = ?").run(cid);
  const r = await fillFromCopies({ write: true });
  assert.deepEqual([r.failing, r.cleared], [1, 1]);
  assert.equal(getDescription(kid) || '', '', 'the borrowed text is gone');
  assert.equal(db().prepare('SELECT body_from FROM jobs WHERE id = ?').get(kid).body_from, null);
});
