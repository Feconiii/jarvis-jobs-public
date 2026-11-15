import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outreachDb } from './outreach-db.mjs';
import { watchList, watchLeads, watchDue, lastWatch, WATCH_EVERY_DAYS } from './lead-watch.mjs';

const NOW = new Date('2026-10-24T20:00:00Z');

function store() {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-watch-')), 'outreach.db');
  outreachDb(dbPath).exec(`
    CREATE TABLE contacts (name TEXT, linkedin_url TEXT, job_id TEXT, company TEXT, do_not_contact INTEGER DEFAULT 0);
    CREATE TABLE lead_verdicts (name TEXT, profile_url TEXT, job_id TEXT, company TEXT, status TEXT);
    CREATE TABLE lead_runs (job_id TEXT PRIMARY KEY, result TEXT);
    CREATE TABLE outreach_removed (job_id TEXT PRIMARY KEY);
    INSERT INTO contacts VALUES ('Riley T Morgan', 'https://www.linkedin.com/in/riley/', 'amazon:td', 'Amazon', 0);
    INSERT INTO contacts VALUES ('Told Us No', 'https://www.linkedin.com/in/nope', 'amazon:td', 'Amazon', 1);
    INSERT INTO lead_verdicts VALUES ('Riley T Morgan', 'https://www.linkedin.com/in/riley', 'amazon:rdpi', 'amazon', 'strong');
    INSERT INTO lead_verdicts VALUES ('Peer Engineer', 'https://www.linkedin.com/in/peer', 'amazon:td', 'amazon', 'rejected');
    INSERT INTO lead_runs VALUES ('amazon:td', '${JSON.stringify({ people: [{ name: 'Peer Engineer', profile_url: 'https://www.linkedin.com/in/peer' }, { name: 'Casey Hart', profile_url: 'https://www.linkedin.com/in/caseyhart' }] })}');
    INSERT INTO lead_runs VALUES ('gone:job', '${JSON.stringify({ people: [{ name: 'Old Lead', profile_url: 'https://www.linkedin.com/in/old' }] })}');
    INSERT INTO outreach_removed VALUES ('gone:job');
  `);
  return dbPath;
}

// Riley's 2026-10-22 reshare of Kai Ortiz's req, with his own words.
const rileyPost = {
  url: 'https://www.linkedin.com/posts/riley_x-activity-7518854823000000105-Kp4m', own: true, ageDays: 2,
  date: '2026-10-22T18:00:00.000Z', author: { name: 'Riley T Morgan', url: 'https://www.linkedin.com/in/riley', kind: 'person' },
  text: "My team is hiring! I'm excited to share that we're growing.",
  shared: { author: { name: 'Kai Ortiz', url: 'https://www.linkedin.com/in/kaiortiz', kind: 'person' }, text: 'Robotics Systems Engineer II, Tech Deployment: we are hiring', date: '2026-10-22T17:00:00.000Z', url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/' },
};
const page = (posts, experience = 'Amazon') => ({ status: 'ok', name: 'x', headline: '', experience, posts, recent: posts });

test('who is re-read: saved contacts, verdicts and the button\'s finds; never do-not-contact, rejected or removed jobs', () => {
  const list = watchList({ dbPath: store() });
  const by = Object.fromEntries(list.map((p) => [p.slug, p]));
  assert.deepEqual(Object.keys(by).sort(), ['caseyhart', 'riley']);
  assert.deepEqual(by.riley.jobs.sort(), ['amazon:rdpi', 'amazon:td'], 'one read, every job they belong to');
});

test('a retired lead is not re-read (F-977), and the real table\'s status column is read', () => {
  const dbPath = store();
  const h = outreachDb(dbPath);
  h.exec("ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'drafted'");
  h.exec("INSERT INTO contacts (name, linkedin_url, job_id, company, do_not_contact, status) VALUES ('Retired Lead', 'https://www.linkedin.com/in/retiredlead', 'amazon:td', 'Amazon', 0, 'retired')");
  const slugs = watchList({ dbPath }).map((p) => p.slug).sort();
  assert.deepEqual(slugs, ['caseyhart', 'riley']);
});

test('a new hiring post joins every job of that person, its writer included; the next pass does not repeat it', async () => {
  const dbPath = store();
  const merged = [];
  const read = async (url) => (url.includes('riley') ? page([rileyPost]) : page([], 'Sunday'));
  const opts = { dbPath, now: NOW, read, merge: (jobId, people) => merged.push([jobId, people.map((p) => p.name)]), companyOf: (p) => (p.slug === 'caseyhart' ? 'Sunday Robotics' : 'Amazon'), pauseMs: 0 };
  const s = await watchLeads(opts);
  assert.equal(s.checked, 2);
  assert.deepEqual(s.found.map((f) => f.name).sort(), ['Riley T Morgan', 'Kai Ortiz'].sort());
  assert.ok(s.found.find((f) => f.name === 'Kai Ortiz').isNew);
  assert.deepEqual(merged.map(([j]) => j).sort(), ['amazon:rdpi', 'amazon:td']);
  assert.ok(merged.every(([, names]) => names.includes('Kai Ortiz')));
  assert.deepEqual(s.moved, [], '"Sunday" on the page is Sunday Robotics');
  assert.equal(lastWatch({ dbPath }).found.length, 2);

  merged.length = 0;
  const again = await watchLeads({ ...opts, now: new Date(+NOW + 864e5) });
  assert.deepEqual(again.found, [], 'already seen');
  assert.equal(merged.length, 0);
});

test('an old post, a post with no hiring words and a refused page add nobody; a refused page goes first next time', async () => {
  const dbPath = store();
  const old = { ...rileyPost, date: '2026-09-01T00:00:00.000Z', shared: null };
  const chatter = { ...rileyPost, text: 'Great offsite with the team.', shared: null };
  const seen = [];
  const read = async (url) => { seen.push(url); return url.includes('riley') ? page([old, chatter]) : { status: 'refused', http: 999 }; };
  const s = await watchLeads({ dbPath, now: NOW, read, merge: () => assert.fail('nothing to merge'), companyOf: () => 'Amazon', pauseMs: 0 });
  assert.deepEqual([s.checked, s.refused, s.found.length], [1, 1, 0]);
  seen.length = 0;
  await watchLeads({ dbPath, now: new Date(+NOW + 60e3), read, merge: () => {}, companyOf: () => 'Amazon', pauseMs: 0, max: 1 });
  assert.match(seen[0], /caseyhart/, 'the refused page is read first');
});

test('a person whose page names another employer is reported', async () => {
  const dbPath = store();
  const s = await watchLeads({ dbPath, now: NOW, read: async () => page([], 'Tesla'), merge: () => {}, companyOf: () => 'Amazon', pauseMs: 0 });
  assert.equal(s.moved.length, 2);
});

test(`due every ${WATCH_EVERY_DAYS} days`, async () => {
  const dbPath = store();
  assert.equal(watchDue({ dbPath, now: NOW }), true);
  await watchLeads({ dbPath, now: NOW, read: async () => page([]), merge: () => {}, companyOf: () => 'Amazon', pauseMs: 0 });
  assert.equal(watchDue({ dbPath, now: new Date(+NOW + 864e5) }), false);
  assert.equal(watchDue({ dbPath, now: new Date(+NOW + WATCH_EVERY_DAYS * 864e5) }), true);
});

test('three refusals in a row stop the pass, keep the last result, and retry in half a day', async () => {
  const dbPath = store();
  const h = outreachDb(dbPath);
  for (const s of ['a1', 'a2', 'a3', 'a4']) h.prepare("INSERT INTO contacts VALUES (?, ?, 'amazon:td', 'Amazon', 0)").run(s, `https://www.linkedin.com/in/${s}`);
  await watchLeads({ dbPath, now: NOW, read: async (u) => (u.includes('riley') ? page([rileyPost]) : page([])), merge: () => {}, companyOf: () => 'Amazon', pauseMs: 0 });
  assert.equal(lastWatch({ dbPath }).found.length, 2);
  const later = new Date(+NOW + 4 * 864e5);
  assert.equal(watchDue({ dbPath, now: later }), true);
  const reads = [];
  const s = await watchLeads({ dbPath, now: later, read: async (u) => { reads.push(u); return { status: 'refused', http: 999 }; }, merge: () => {}, companyOf: () => 'Amazon', pauseMs: 0 });
  assert.equal(s.blocked, true);
  assert.equal(reads.length, 3, 'stopped at the third refusal');
  assert.equal(lastWatch({ dbPath }).found.length, 2, 'the tab keeps the last real result');
  assert.equal(watchDue({ dbPath, now: new Date(+later + 3600e3) }), false);
  assert.equal(watchDue({ dbPath, now: new Date(+later + 13 * 3600e3) }), true);
});

test('a dry run writes nothing', async () => {
  const dbPath = store();
  await watchLeads({ dbPath, now: NOW, dryRun: true, read: async () => page([rileyPost]), merge: () => assert.fail('dry run merged'), companyOf: () => 'Amazon', pauseMs: 0 });
  assert.equal(lastWatch({ dbPath }), null);
});
