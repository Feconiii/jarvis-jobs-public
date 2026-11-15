// F-1032: the travelling-requisition lookup, in its worker thread, finds what
// the in-thread pass found — and nothing it did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { loadAts, travellingMatch } from './requisition-worker.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'req-worker-'));
const dbPath = path.join(dir, 'jobs.db');
test.after(() => rmSync(dir, { recursive: true, force: true }));
{
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, url TEXT); CREATE INDEX jobs_url_nocase ON jobs(url COLLATE NOCASE);');
  const add = db.prepare('INSERT INTO jobs (id, url) VALUES (?, ?)');
  add.run('gh-board', 'https://boards.greenhouse.io/acme/jobs/7012345');
  add.run('oracle-legrand', 'https://iadugs.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1246');
  add.run('other', 'https://boards.greenhouse.io/zeta/jobs/9999999');
  db.close();
}
const ats = loadAts();

test('a Greenhouse id on the company\'s own site is found on its board', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(travellingMatch(db, ats, 'https://www.acme.com/careers/job?gh_jid=7012345'), 'gh-board');
  db.close();
});

test('the same number on another employer\'s tenant is another posting (F-714)', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(travellingMatch(db, ats, 'https://ekgz.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1246'), null);
  db.close();
});

test('a page with no requisition, or one nobody holds, is none', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(travellingMatch(db, ats, 'https://www.acme.com/about'), null);
  assert.equal(travellingMatch(db, ats, 'https://www.acme.com/careers/job?gh_jid=7000001'), null);
  db.close();
});

test('the worker answers by message, off the asking thread', async () => {
  const w = new Worker(new URL('./requisition-worker.mjs', import.meta.url));
  try {
    const ask = (seq, url) => new Promise((resolve) => {
      const on = (m) => { if (m.seq === seq) { w.off('message', on); resolve(m); } };
      w.on('message', on);
      w.postMessage({ seq, url, dbPath });
    });
    const a = await ask(1, 'https://www.acme.com/careers/job?gh_jid=7012345');
    assert.equal(a.id, 'gh-board');
    assert.equal(typeof a.ms, 'number');
    const b = await ask(2, 'https://www.acme.com/careers/job?gh_jid=7000001');
    assert.equal(b.id, null);
    const c = await ask(3, 'not a url');
    assert.equal(c.id ?? null, null, 'a bad page is a miss, never a crash');
  } finally { await w.terminate(); }
});

// PARITY (F-1032 review): the old in-thread pass, as it was in serve.mjs
// before the move (7bde3b99), against the worker's, on the same rows.
import { crossTenant } from './req-id.mjs';
function oldInThread(db, ATS, url) {
  const want = ATS?.reqToken?.(url);
  if (!want) return null;
  const raw = String(want).replace(/^[a-z0-9-]+:/i, '');
  if (raw.length >= 4) {
    const esc = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
    for (const row of db.prepare("SELECT rowid AS rid, url FROM jobs INDEXED BY jobs_url_nocase WHERE url LIKE ? ESCAPE '\\'").iterate(`%${esc}%`)) {
      if (ATS.reqToken(row.url) === want && !crossTenant(url, row.url)) {
        const hit = db.prepare('SELECT id FROM jobs WHERE rowid = ?').get(row.rid);
        return hit ? hit.id : null;
      }
    }
    return null;
  }
  for (const row of db.prepare('SELECT id, url FROM jobs').iterate()) {
    if (ATS.reqToken(row.url) === want && !crossTenant(url, row.url)) return row.id;
  }
  return null;
}

test('parity: the worker answers exactly what the old in-thread pass answered', () => {
  const w = new DatabaseSync(dbPath);
  w.prepare('INSERT OR IGNORE INTO jobs (id, url) VALUES (?, ?)').run('oracle-short', 'https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/12');
  w.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const pages = [
    'https://www.acme.com/careers/job?gh_jid=7012345',
    'https://job-boards.greenhouse.io/acme/jobs/7012345',
    'https://ekgz.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1246',
    'https://iadugs.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/1246',
    'https://www.otherco.com/jobs/abcd.fa.us2.oraclecloud.com/job/12',
    'https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/12',
    'https://www.zeta.com/careers?gh_jid=9999999',
    'https://www.acme.com/about',
  ];
  for (const p of pages) assert.equal(travellingMatch(db, ats, p), oldInThread(db, ats, p), p);
  assert.ok(ats.reqToken(pages[5]).replace(/^[a-z0-9-]+:/i, '').length < 4, 'one page takes the short-id walk');
  db.close();
});
