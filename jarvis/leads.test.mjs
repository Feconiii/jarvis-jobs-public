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

// A run recorded back when these rows lived in jobs.db (before F-597).
const { DatabaseSync } = await import('node:sqlite');
{
  const old = new DatabaseSync(path.join(dir, 'jobs.db'));
  old.exec(`CREATE TABLE lead_runs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT NOT NULL DEFAULT '')`);
  old.prepare('INSERT INTO lead_runs VALUES (?,?,?,?,?,?)').run('job-old', 'done', '2026-09-17T10:00:00Z', '2026-09-17T10:04:00Z', JSON.stringify({ people: [{ name: 'Old Lead' }] }), '');
  old.close();
}

const L = await import('./leads.mjs');
const C = await import('./contacts.mjs');

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

test('the runs already in jobs.db are carried into outreach.db on the first open', () => {
  assert.equal(L.getLeadRun('job-old').result.people[0].name, 'Old Lead');
});

test('F-597: A SCAN HOLDING THE JOBS STORE CANNOT MAKE THE OUTREACH BUTTON WAIT', async () => {
  // What a scan does: hold jobs.db's write lock for minutes.
  const scan = new DatabaseSync(path.join(dir, 'jobs.db'));
  scan.exec('BEGIN IMMEDIATE');
  try {
    const t0 = Date.now();
    const r = L.startLeadRun({ ...JOB, id: 'job-during-scan' }, { ask: async () => JSON.stringify({ people: [] }) });
    assert.equal(r.status, 'running');
    C.saveContact({ job_id: 'job-during-scan', company: 'Fluidstack', name: 'Pat Doe' });
    C.markSent(C.contactId('Fluidstack', 'Pat Doe'));
    L.removeFromOutreach('job-during-scan');
    assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms, not after a 30-second busy wait`);
    await L.idle();
  } finally { scan.exec('ROLLBACK'); scan.close(); }
});

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
  // Counts first passes only: a one-person answer also earns one wider pass (F-711).
  const ask = async (p) => { if (!/A FIRST PASS FOUND/.test(p)) calls += 1; await gate; return JSON.stringify({ people: [{ name: 'Dana Lee', confidence: 'high', persona: 'manager' }], warnings: [] }); };

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
  const { startedAt, ...summary } = L.leadSummary()[JOB.id];
  assert.deepEqual(summary, { status: 'done', count: 1, warnings: 0 });
  assert.ok(startedAt, 'when he chose it, for the Outreach tab to order by');

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

test('taking a job off the Outreach tab keeps its research, and pressing Outreach again brings it back', async () => {
  assert.ok(L.leadSummary()[JOB.id], 'on the list after the press');
  L.removeFromOutreach(JOB.id);
  assert.equal(L.leadSummary()[JOB.id], undefined, 'off the list, so the card reads "Outreach" again');
  assert.ok(L.removedFromOutreach().has(JOB.id));
  let calls = 0;
  const back = L.startLeadRun(JOB, { ask: async () => { calls += 1; return '{}'; } });
  assert.equal(back.status, 'done', 'the old research comes back with it');
  assert.equal(calls, 0, 'nothing is searched twice');
  assert.equal(L.leadSummary()[JOB.id].count, 1);
  assert.equal(L.removedFromOutreach().has(JOB.id), false);
});

test('A RUN THAT FINDS FEWER THAN TWO PEOPLE WIDENS ONCE (F-711)', async () => {
  const job = { ...JOB, id: 'job-acme-widen' };
  const prompts = [];
  const ask = async (p) => {
    prompts.push(p);
    return prompts.length === 1
      ? JSON.stringify({ people: [{ name: 'Sam Ortiz', confidence: 'medium' }], notes: 'profiles answered 999' })
      : JSON.stringify({ people: [{ name: 'Sam Ortiz' }, { name: 'Ana Ruiz', confidence: 'low' }], notes: 'found by team name' });
  };
  L.startLeadRun(job, { ask });
  await L.idle();
  assert.equal(prompts.length, 2, 'one wider pass');
  assert.match(prompts[1], /A FIRST PASS FOUND ONLY 1: Sam Ortiz/);
  const r = L.getLeadRun(job.id);
  assert.deepEqual(r.result.people.map((p) => p.name), ['Sam Ortiz', 'Ana Ruiz'], 'merged, nobody twice');
  assert.match(r.result.notes, /Wider search: found by team name/);

  // Two people the first time: no second ask.
  const job2 = { ...JOB, id: 'job-acme-enough' };
  let n = 0;
  L.startLeadRun(job2, { ask: async () => { n += 1; return JSON.stringify({ people: [{ name: 'A B' }, { name: 'C D' }] }); } });
  await L.idle();
  assert.equal(n, 1);
  assert.match(L.buildLeadsPrompt(JOB), /run at least 8 different searches/);
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

// ── what they said in public, and when (2026-09-26) ──────────────────
test('THE PROMPT asks for invitations, dates and the original author, and names the people he saved', () => {
  const p = L.buildLeadsPrompt(JOB, { known: ['Dana Lee'], today: new Date('2026-09-26T12:00:00Z') });
  assert.match(p, /Today is 2026-09-26/);
  assert.match(p, /send me your resume/);
  assert.match(p, /Never guess a date/);
  assert.match(p, /ORIGINAL author/);
  assert.match(p, /Dana Lee/);
  assert.doesNotMatch(L.buildLeadsPrompt(JOB), /ALREADY SAVED/);
});

test('A POST\'S AGE DECIDES ITS WORTH — his bands: 0-2 weeks strong, 2-6 useful, 2-3 months weak, 4+ months not current', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const at = (date) => L.readSignal({ kind: 'invited', quote: 'DM me', date, author: 'Dana Lee' }, 'Dana Lee', now);
  assert.equal(at('2026-09-14').standing, 'fresh', '12 days');
  assert.equal(at('2026-08-25').standing, 'recent', '32 days');
  assert.equal(at('2026-07-20').standing, 'weak', '68 days');
  assert.equal(at('2026-05-01').standing, 'stale', '4+ months is not current hiring evidence');
  assert.equal(at('2026-03-20').standing, 'stale', '"we are hiring" six months ago is useless');
  assert.equal(at('').standing, 'undated');
  assert.equal(at('three weeks ago').standing, 'undated', 'a date is never guessed from prose');
  assert.equal(L.readSignal({ kind: 'none' }, 'Dana Lee', now), null);
});

test('A REPOST IS THE AUTHOR\'S WORDS, never the reposter\'s', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const s = L.readSignal({ kind: 'invited', quote: 'Send me your resume', date: '2026-09-20', author: 'Priya Nair' }, 'Sam Rivers', now);
  assert.equal(s.standing, 'reposted');
  assert.equal(s.author, 'Priya Nair');
  assert.equal(L.readSignal({ kind: 'invited', date: '2026-09-20', author: 'Samuel J. Rivers' }, 'Samuel Rivers', now).standing, 'fresh', 'a middle initial is the same author');
});

test('a fresh invitation is listed first; a stale one ranks with no signal; a personal detail needs its source', () => {
  const out = L.parseLeads(JSON.stringify({ people: [
    { name: 'Old Post', confidence: 'high', signal: { kind: 'invited', date: '2026-02-01', author: 'Old Post' } },
    { name: 'Reposter', confidence: 'high', signal: { kind: 'invited', date: '2026-09-20', author: 'Someone Else' } },
    { name: 'Fresh Invite', confidence: 'low', signal: { kind: 'invited', quote: 'my team is hiring, DM me', date: '2026-09-18', author: 'Fresh Invite' },
      personal: { text: 'Gave a talk on gripper design at Automate 2026', source_url: 'https://example.com/talk' } },
    { name: 'No Source', confidence: 'medium', personal: { text: 'Likes robots' } },
  ] }), { now: new Date('2026-09-26T12:00:00Z') });
  assert.equal(out.people[0].name, 'Fresh Invite');
  assert.equal(out.people[0].personal.source_url, 'https://example.com/talk');
  assert.equal(out.people.find((p) => p.name === 'No Source').personal, null, 'an unsourced detail is dropped');
  assert.equal(out.people.find((p) => p.name === 'Reposter').signal.standing, 'reposted');
  // Stored runs are re-read against today: fresh last month is stale later.
  const later = L.restand(out, new Date('2027-03-01T12:00:00Z'));
  assert.equal(later.people.find((p) => p.name === 'Fresh Invite').signal.standing, 'stale');
});

test('ONE PERSON, SEVERAL NAMES: a maiden name in brackets or a title is not a repost (Casey Hart, 2026-09-26)', () => {
  assert.ok(L.samePerson('Casey Hart (formerly Casey Lane)', 'Casey Hart'));
  assert.ok(L.samePerson('Casey Lane', 'Casey Hart (formerly Casey Lane)'));
  assert.ok(L.samePerson('Dr. Michael S. Grant', 'Michael Grant'));
  assert.ok(!L.samePerson('Casey Hart', 'Priya Nair'));
  const now = new Date('2026-09-26T12:00:00Z');
  assert.equal(L.readSignal({ kind: 'hiring_post', date: '2026-09-20', author: 'Casey Hart' }, 'Casey Hart (formerly Casey Lane)', now).standing, 'fresh');
});

test('EXPECTED REPLY VALUE ranks the three, not the title: a flooded founder loses to a reachable engineer on the team (2026-09-27)', () => {
  const out = L.parseLeads(JSON.stringify({ considered: 10, people: [
    { name: 'Famous Founder', persona: 'manager', lead_type: 'decision', confidence: 'high',
      scores: { proximity: 4, hook: 2, reply: 1, help: 4, competition: 1 } },
    { name: 'Team Engineer', persona: 'team', lead_type: 'technical', confidence: 'medium',
      scores: { proximity: 5, hook: 4, reply: 4, help: 3, competition: 5 }, usefulness: 'can say whether his fixture work matches' },
    { name: 'Alum Recruiter', persona: 'recruiter', lead_type: 'alternate', confidence: 'medium',
      scores: { proximity: 3, hook: 5, reply: 4, help: 4, competition: 3 } },
  ] }), { now: new Date('2026-09-27T12:00:00Z') });
  assert.equal(out.considered, 10);
  assert.deepEqual(out.people.map((p) => p.name), ['Team Engineer', 'Alum Recruiter', 'Famous Founder']);
  assert.equal(out.people[0].lead_type, 'technical');
  assert.equal(out.people[0].usefulness, 'can say whether his fixture work matches');
  // A score outside 1-5 is clamped; a missing one drops the scores, never invents them.
  const odd = L.parseLeads(JSON.stringify({ people: [{ name: 'A B', scores: { proximity: 9, hook: 0, reply: 3, help: 3, competition: 3 } }, { name: 'C D', scores: { proximity: 3 } }] }));
  assert.deepEqual(odd.people.find((p) => p.name === 'A B').scores, { proximity: 5, hook: 1, reply: 3, help: 3, competition: 3 });
  assert.equal(odd.people.find((p) => p.name === 'C D').scores, null);
});

test('the prompt asks for 8-12 considered, the best 3 of different kinds, and penalises founders and generic recruiters', () => {
  const p = L.buildLeadsPrompt(JOB);
  assert.match(p, /8 to 12 plausible people/);
  assert.match(p, /BEST 3/);
  assert.match(p, /"decision"/);
  assert.match(p, /founders and celebrity executives/);
  assert.match(p, /No posts at all is NOT a bad sign/);
  assert.match(p, /4 months or more is NOT current hiring evidence/);
});

test('THREE EXCELLENT LEADS (2026-09-27): someone inviting DMs, posting actively, or posting about the work outranks a quiet higher-scored title', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const out = L.parseLeads(JSON.stringify({ people: [
    { name: 'Quiet Manager', lead_type: 'decision', confidence: 'high',
      scores: { proximity: 5, hook: 4, reply: 3, help: 5, competition: 4 } },
    { name: 'Active Engineer', lead_type: 'technical', confidence: 'medium',
      scores: { proximity: 4, hook: 3, reply: 3, help: 3, competition: 4 },
      activity: { recent_posts: 4, latest: '2026-09-20', url: 'https://www.linkedin.com/posts/active-engineer_abc' } },
    { name: 'Inviting Recruiter', lead_type: 'alternate', confidence: 'medium',
      scores: { proximity: 3, hook: 3, reply: 3, help: 3, competition: 3 },
      signal: { kind: 'invited', quote: 'my team is hiring, DM me', date: '2026-09-22', author: 'Inviting Recruiter' } },
    { name: 'Work Poster', confidence: 'low',
      scores: { proximity: 3, hook: 3, reply: 3, help: 3, competition: 3 },
      signal: { kind: 'relevant_post', quote: 'we just shipped the new gripper', date: '2026-09-01', author: 'Work Poster' } },
  ] }), { now });
  assert.deepEqual(out.people.map((p) => p.name), ['Inviting Recruiter', 'Active Engineer', 'Work Poster', 'Quiet Manager'], 'a fresh invitation leads');
  assert.equal(out.people[1].excellent, 'active on LinkedIn');
  assert.equal(out.people[0].excellent, 'invites messages');
  assert.equal(out.people[2].excellent, 'posts about the work');
  assert.equal(out.people[3].excellent, '');
});

test('ACTIVITY is read from what was seen: dated, sourced, re-judged on every read, never guessed', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const url = 'https://www.linkedin.com/posts/dana-lee_abc';
  assert.equal(L.readActivity({ recent_posts: 3, latest: '2026-09-10', url }, now).level, 'active');
  assert.equal(L.readActivity({ recent_posts: 1, latest: '2026-09-10', url }, now).level, 'occasional', 'one post is not active');
  assert.equal(L.readActivity({ recent_posts: 0, latest: '2026-07-01', url }, now).level, 'occasional');
  assert.equal(L.readActivity({ recent_posts: 0, latest: '2026-01-01', url }, now).level, 'quiet');
  assert.equal(L.readActivity({ recent_posts: 5, latest: '', url }, now), null, 'no date: unknown');
  assert.equal(L.readActivity({ recent_posts: 5, latest: '2026-09-10', url: '' }, now), null, 'nowhere seen: unknown');
  // Active last week, quiet by spring: a stored run goes stale on its own.
  const out = L.parseLeads(JSON.stringify({ people: [{ name: 'Dana Lee', activity: { recent_posts: 3, latest: '2026-09-10', url } }] }), { now });
  const later = L.restand(out, new Date('2027-04-01T12:00:00Z'));
  assert.equal(later.people[0].activity.level, 'quiet');
  assert.equal(later.people[0].excellent, '');
});

test('the prompt hunts for invitations, active posters and posts about the work first, with the author read from the post URL', () => {
  const p = L.buildLeadsPrompt(JOB);
  assert.match(p, /THREE EXCELLENT LEADS/);
  assert.match(p, /site:linkedin\.com\/posts/);
  assert.match(p, /relevant_post/);
  assert.match(p, /Never estimate a count you did not see/);
  assert.match(p, /names its AUTHOR/);
});
