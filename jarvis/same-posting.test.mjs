// F-1013 #3, #6, #9: one rule for "has he applied there?" and "is this the same role?".
// node --test jarvis/same-posting.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sameRole, appliedRowsAt, APPLIED_STATUSES, sameEmployer } from './same-posting.mjs';

test('#9: a place or cohort tail is the same role; a different specialty is not', () => {
  assert.equal(sameRole('Manufacturing Engineer I - Boise, ID', 'Manufacturing Engineer I'), true);
  assert.equal(sameRole('Process Engineer (Remote)', 'Process Engineer'), true);
  assert.equal(sameRole('Mechanical Engineer, New Grad 2027', 'Mechanical Engineer'), true);
  assert.equal(sameRole('Mechanical Engineer - Idaho', 'Mechanical Engineer'), true);
  assert.equal(sameRole('Mechanical Engineer - Thermal', 'Mechanical Engineer - Structures'), false, 'the review case');
  assert.equal(sameRole('Mechanical Engineer - Thermal', 'Mechanical Engineer'), false);
  assert.equal(sameRole('Manufacturing Engineer I Manager', 'Manufacturing Engineer I'), false);
  assert.equal(sameRole('Mechanical Engineer II', 'Mechanical Engineer I'), false, 'levels differ');
  assert.equal(sameRole('Engineer, Manufacturing Automation', 'Engineer, Manufacturing Automation'), true);
  assert.equal(sameRole('Engineer, Manufacturing Automation', 'Engineer, Process'), false);
});

test('#3/#6: applications at an employer are found under any spelling, by status, never by fill time', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, company TEXT, title TEXT, url TEXT, status TEXT, applied_at TEXT, status_changed_at TEXT)');
  const put = db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)');
  put.run('a', 'Micron Technology', 'Process Engineer', 'u1', 'applied', null, '2026-09-19');   // from his inbox: no fill time
  put.run('b', 'Micron Technology, Inc.', 'Equipment Engineer', 'u2', 'rejected', '2026-09-01', '2026-10-01');
  put.run('c', 'Micron', 'Yield Engineer', 'u3', 'inbox', '2026-11-04', null);                  // filled, held back: not an application
  put.run('d', 'Microchip Technology', 'Test Engineer', 'u4', 'applied', null, '2026-09-02');    // another employer
  put.run('e', 'Figure AI', 'Mechanical Engineer', 'u5', 'interview', null, '2026-10-02');
  const ids = (rows) => rows.map((r) => r.id).sort();
  assert.deepEqual(ids(appliedRowsAt(db, 'Micron')), ['a', 'b'], '"Micron" is "Micron Technology"; a held-back fill is not an application');
  assert.deepEqual(ids(appliedRowsAt(db, 'Micron Technology', 'a')), ['b'], 'the row itself is left out');
  assert.deepEqual(ids(appliedRowsAt(db, 'Figure')), ['e'], 'an interviewing row was an application');
  assert.deepEqual(ids(appliedRowsAt(db, '')), []);
  assert.equal(sameEmployer('Micron', 'Microchip Technology'), false);
  assert.deepEqual(APPLIED_STATUSES, ['applied', 'responded', 'interview', 'offer', 'rejected']);
});
