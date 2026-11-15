import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, signalFromPost } from './outreach-draft.mjs';

const JOB = { company: 'Amazon', title: 'Robotics Systems Engineer I, Tech Deployment', status: 'applied', url: 'https://www.amazon.jobs/en/jobs/10503216/robotics-systems-engineer-i-tech-deployment' };
const CV = "Lakeside University, BS Mechanical Engineering, May 2027. Applied Materials, Automation Technology Group: supported the deployment and validation of Autonomous Mobile Robots for cleanroom material handling; programmed a UR cobot in RoboDK and helped lay out and install it in the cell.";
const JD = 'Robotics Systems Engineer I, Tech Deployment. Deploy robotics on a live floor with the operations team.';
const DRAFT = `Hi Dana,

I saw your post that your Tech Deployment team is hiring, and since you invited people to reach out directly, I wanted to introduce myself.

I recently applied for the Robotics Systems Engineer I, Tech Deployment role:
${JOB.url}

I'm a senior Mechanical Engineering student at Lakeside graduating in May 2027. This past summer I worked with Applied Materials' Automation Technology Group, where I supported the deployment and validation of Autonomous Mobile Robots for cleanroom material handling, and programmed a UR cobot in RoboDK and helped lay out and install it in the cell.

The role stood out because getting robotic equipment running on a live floor with the operations team is really close to the work I've enjoyed most. If you have a chance, I'd really appreciate you taking a quick look at my resume and portfolio and letting me know if you think my background could be relevant to the team.

Portfolio: https://alexrivera.example
Resume: Attached

Thank you!
Alex`;
const recent = new Date(Date.now() - 10 * 86400e3).toISOString();
const ownPost = { url: 'https://www.linkedin.com/posts/dana', date: recent, author: { name: 'Dana Lee' }, text: 'My team is hiring. Feel free to reach out to me.', shared: null };
const reshare = { url: 'https://www.linkedin.com/posts/dana2', date: recent, author: { name: 'Dana Lee' }, text: '', shared: { author: { name: 'Kai Ortiz' }, text: "We're hiring", date: recent } };

test('his template, to someone who wrote the post, passes', () => {
  const r = checkDraft({ text: DRAFT, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee', post: ownPost });
  assert.deepEqual(r.problems, []);
  assert.equal(r.signal.kind, 'invited');
  assert.equal(r.signal.standing, 'fresh');
});

test('"I saw your post" to someone who only reshared it fails', () => {
  const r = checkDraft({ text: DRAFT, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee', post: reshare });
  assert.equal(r.signal.standing, 'reposted');
  assert.ok(r.problems.some((p) => /repost of Kai Ortiz/.test(p)), r.problems.join(' | '));
});

test('…and passes for the original writer, dated by the original', () => {
  const s = signalFromPost(reshare, 'Kai Ortiz');
  assert.equal(s.standing, 'fresh');
  assert.equal(s.author, 'Kai Ortiz');
});

test('a writer shown as "Lin Zhao, SHRM-CP" is Lin Zhao, not a resharer', () => {
  const own = { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7505331407902956122/', date: new Date(Date.now() - 5 * 86400e3).toISOString(), text: 'XPENG 2027 Campus Recruitment is now open!', author: { name: 'Lin Zhao, SHRM-CP' } };
  assert.equal(signalFromPost(own, 'Lin Zhao').standing, 'fresh');
  assert.equal(signalFromPost({ ...own, author: { name: 'Jane Doe (she/her)' } }, 'Jane Doe').standing, 'fresh');
  assert.equal(signalFromPost({ ...own, author: { name: 'Lin Zhaoley' } }, 'Lin Zhao').standing, 'reposted');
});

// Shreyash (2026-10-05): his hiring post was 4 months old and the message said
// "your team is hiring". An old or unread post never supports "is hiring".
test('"your team is hiring" fails on a post four months old, and on no post', () => {
  const old = new Date(Date.now() - 125 * 86400e3).toISOString();
  const stale = { ...ownPost, date: old };
  const r = checkDraft({ text: DRAFT, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee', post: stale });
  assert.ok(r.problems.length > 0, 'a 4-month-old post cannot back this message');
  const weekOld = checkDraft({ text: DRAFT, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee', post: { ...ownPost, date: new Date(Date.now() - 90 * 86400e3).toISOString() } });
  assert.ok(weekOld.problems.some((p) => /says the team is hiring now; their post is 90 days old/.test(p)), weekOld.problems.join(' | '));
  const none = checkDraft({ text: DRAFT, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee' });
  assert.ok(none.problems.some((p) => /hiring now; no dated post/.test(p)), none.problems.join(' | '));
});

test('…but a headline that says "Hiring for" today supports it (Owen)', () => {
  const text = DRAFT.replace(/^I saw your post[^\n]+/m, "Since you're hiring for Tech Deployment, I wanted to introduce myself.");
  const r = checkDraft({ text, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee', title: 'Hiring for Tech Deployment, Amazon Robotics' });
  assert.ok(!r.problems.some((p) => /hiring now/.test(p)), r.problems.join(' | '));
  const without = checkDraft({ text, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee', title: 'Engineering Manager' });
  assert.ok(without.problems.some((p) => /hiring now/.test(p)));
});

test('without a post, a message that claims one fails', () => {
  const r = checkDraft({ text: DRAFT, job: JOB, jd: JD, cvText: CV, name: 'Dana Lee' });
  assert.ok(r.problems.some((p) => /verify|shared history/.test(p)));
});

test('a connection note: 300 characters, addressed to them, no link, never visa or a referral', async () => {
  const { checkConnectNote } = await import('./outreach-draft.mjs');
  assert.equal(checkConnectNote("Hi Chris, I came across your post about the roles on OpenAI's actuator team. I applied to a few of them, so I'd love to connect.", 'Chris Moreno').ok, true);
  assert.match(checkConnectNote('x'.repeat(301), 'Chris Moreno').problems.join(' '), /300/);
  assert.match(checkConnectNote('Hello there, I applied.', 'Chris Moreno').problems.join(' '), /Hi Chris/);
  assert.match(checkConnectNote('Hi Chris, see https://x.com', 'Chris Moreno').problems.join(' '), /links/);
  assert.match(checkConnectNote('Hi Chris, could you refer me?', 'Chris Moreno').problems.join(' '), /referral/);
});
