/**
 * The Outreach button's research: what it asks for, what it lets through, and
 * how a run lives and dies. The model is replaced by a stub — nothing here
 * spends minutes on the web — and the store is a temp one, never his.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-leads-'));
process.env.JARVIS_DATA_DIR = dir;
const L = await import('./leads.mjs');

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

const JOB = { id: 'job-acme-1', company: 'Acme Robotics', title: 'Mechanical Engineer', team: 'Hardware', location: 'Austin, TX', url: 'https://jobs.ashbyhq.com/acme/1' };

test('the prompt names the job and carries the privacy rules', () => {
  const p = L.buildLeadsPrompt(JOB, { description: 'Design grippers.' });
  assert.match(p, /Acme Robotics/);
  assert.match(p, /Mechanical Engineer/);
  assert.match(p, /Design grippers\./);
  assert.match(p, /Never guess or construct an individual email address/);
  assert.match(p, /Never include phone numbers/);
  assert.match(p, /data-broker/);
  assert.match(p, /security clearance/, 'the eligibility check is asked for');
  assert.match(p, /defense or military/);
  assert.doesNotMatch(p, /already flagged/, 'no block note on an unblocked job');
  assert.match(L.buildLeadsPrompt(JOB, { hardBlock: true }), /already flagged this posting as blocked/);
});

test('parseLeads keeps the answer and drops what the rules forbid', () => {
  const out = L.parseLeads(`Here you go:
{"people":[
 {"name":"Dana Lee","title":"Head of Hardware","persona":"manager","why":"Leads the team; call her at (512) 555-0199","profile_url":"https://www.linkedin.com/in/dana","public_email":"dana@acme.com","email_source_url":"https://acme.com/team","evidence_url":"javascript:alert(1)","confidence":"high"},
 {"name":"Sam Rivers","title":"Recruiter","persona":"wizard","why":"Recruits engineers","profile_url":"ftp://nope","public_email":"sam@acme.com","email_source_url":"","confidence":"certain"},
 {"name":"","title":"nobody"}
],"hook":"Raised $40M","hook_source":"https://news.example/acme","careers_email":"see the careers page","warnings":["Requires US citizenship"],"notes":"ok"}
trailing words`);
  assert.equal(out.people.length, 2, 'a nameless entry is not a person');
  const [dana, sam] = out.people;
  assert.equal(dana.public_email, 'dana@acme.com', 'an email with the page it was published on survives');
  assert.doesNotMatch(dana.why, /555/, 'a phone number is cut out of the prose');
  assert.equal(dana.evidence_url, '', 'a non-http link is dropped');
  assert.equal(sam.public_email, '', 'an email with no published source is dropped — no guesses');
  assert.equal(sam.profile_url, '');
  assert.equal(sam.persona, 'team');
  assert.equal(sam.confidence, 'low');
  assert.equal(out.careers_email, '', 'a sentence about an inbox is not an inbox');
  assert.deepEqual(out.warnings, ['Requires US citizenship']);
  assert.equal(L.parseLeads('no json here'), null);
});

test('at most five people, whatever comes back', () => {
  const people = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, confidence: 'high' }));
  assert.equal(L.parseLeads(JSON.stringify({ people })).people.length, L.MAX_PEOPLE);
});

test('a run goes running → done, and a second press does not start a second run', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const ask = async () => { calls += 1; await gate; return JSON.stringify({ people: [{ name: 'Dana Lee', confidence: 'high', persona: 'manager' }], warnings: [] }); };

  const first = L.startLeadRun(JOB, { ask });
  assert.equal(first.status, 'running');
  const again = L.startLeadRun(JOB, { ask });
  assert.equal(again.status, 'running');
  assert.equal(L.leadSummary()[JOB.id].status, 'running');
  release();
  await L.idle();
  assert.equal(calls, 1, 'one press, one research run');

  const done = L.getLeadRun(JOB.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result.people[0].name, 'Dana Lee');
  assert.deepEqual(L.leadSummary()[JOB.id], { status: 'done', count: 1, warnings: 0 });

  // Done stays done unless he asks again.
  assert.equal(L.startLeadRun(JOB, { ask }).status, 'done');
  assert.equal(calls, 1);
});

test('"search again" keeps the old leads on screen while the new run works, then replaces them', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ask = async () => { await gate; return JSON.stringify({ people: [{ name: 'Kit Moreno' }] }); };
  const running = L.startLeadRun(JOB, { ask, refresh: true });
  assert.equal(running.status, 'running');
  assert.equal(running.result.people[0].name, 'Dana Lee', 'the previous leads are still there');
  release();
  await L.idle();
  assert.equal(L.getLeadRun(JOB.id).result.people[0].name, 'Kit Moreno');
});

test('a failure says why, and an unreadable answer is a failure, not an empty list', async () => {
  const job = { ...JOB, id: 'job-acme-2' };
  L.startLeadRun(job, { ask: async () => 'I could not find anyone, sorry.' });
  await L.idle();
  const r = L.getLeadRun(job.id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /without a readable answer/);

  const job3 = { ...JOB, id: 'job-acme-3' };
  L.startLeadRun(job3, { ask: async () => { const e = new Error('timed out'); e.killed = true; throw e; } });
  await L.idle();
  assert.match(L.getLeadRun(job3.id).error, /timed out/);
  assert.doesNotMatch(L.getLeadRun(job3.id).error, /resume/, 'the resume wording of the shared failure text is not shown here');
});

test('research switched off is refused with the reason', () => {
  const was = process.env.JARVIS_TAILOR;
  process.env.JARVIS_TAILOR = 'off';
  try {
    const r = L.startLeadRun({ ...JOB, id: 'job-acme-4' }, { ask: async () => { throw new Error('must not be called'); } });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /switched off/);
  } finally {
    if (was === undefined) delete process.env.JARVIS_TAILOR; else process.env.JARVIS_TAILOR = was;
  }
});
