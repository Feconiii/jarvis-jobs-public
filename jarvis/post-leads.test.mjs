import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { idDate, parsePostHtml, readWords, leadsFromPosts, toLeadPerson, standingOf, kindOf } from './post-leads.mjs';
import { mergePostLeads, getLeadRun, readSignal } from './leads.mjs';

// Synthetic pages in the shape LinkedIn serves a public post (2026-10-04):
// JSON-LD SocialMediaPosting; the author's own words in articleBody; `text`
// often just the attached card's title; sharedContent for a reshare, whose
// own activity id appears in the page as a second urn.
const page = ({ author, authorUrl, words = '', cardTitle = 'Robotics Systems Engineer II, Tech Deployment', date, ownId, shared = null }) => {
  const ld = {
    '@type': 'SocialMediaPosting', datePublished: date, text: cardTitle, articleBody: words,
    author: { '@type': 'Person', name: author, url: authorUrl },
    ...(shared ? { sharedContent: { '@type': 'WebPage', headline: shared.words, author: { '@type': 'Person', name: shared.author, url: shared.url } } } : {}),
  };
  return `<html><script type="application/ld+json">${JSON.stringify(ld)}</script>
    <a data-urn="urn:li:activity:${ownId}"></a>${shared ? `<div data-urn="urn:li:activity:${shared.id}"></div>` : ''}
    <a href="https://lnkd.in/gAbC123">job</a></html>`;
};
// Two real activity ids from 2026-09 posts, and the dates they encode.
const JAI_ID = '7501039202753251931'; // 2026-09-02T22:11:48.505Z
const RILEY_ID = '7501645451320609370';
const NOW = new Date('2026-10-04T12:00:00Z');

test('an activity id carries its own timestamp', () => {
  assert.equal(idDate(JAI_ID).toISOString(), '2026-09-02T22:11:48.505Z');
  assert.equal(idDate('not a number'), null);
  assert.equal(idDate('12'), null);
});

test('a reshare with words: the words are the resharer\'s, the original is dated by its own id', () => {
  const html = page({
    author: 'Riley T Morgan', authorUrl: 'https://www.linkedin.com/in/riley', date: '2026-09-04T14:20:49.426Z', ownId: RILEY_ID,
    words: 'My team is hiring. Kai is a very strong leader to work for. If your background aligns feel free to reach out to me or apply directly.',
    shared: { author: 'Kai Ortiz', url: 'https://www.linkedin.com/in/kaiortiz', words: "We're Hiring: Robotics Systems Engineers", id: JAI_ID },
  });
  const p = parsePostHtml(html, `https://www.linkedin.com/posts/riley_x-activity-${RILEY_ID}-Zdsc`);
  assert.equal(p.author.name, 'Riley T Morgan');
  assert.match(p.text, /^My team is hiring/);
  assert.equal(p.shared.author.name, 'Kai Ortiz');
  assert.equal(p.shared.date, '2026-09-02T22:11:48.505Z');
  assert.equal(p.shared.url, `https://www.linkedin.com/feed/update/urn:li:activity:${JAI_ID}/`);
  assert.deepEqual(p.shortLinks, ['https://lnkd.in/gAbC123']);
  const leads = leadsFromPosts([p], { now: NOW });
  const names = leads.map((l) => l.name);
  assert.deepEqual(names.sort(), ['Riley T Morgan', 'Kai Ortiz'].sort());
  const g = leads.find((l) => l.name === 'Riley T Morgan');
  assert.ok(g.best.owns && g.best.invites);
  assert.equal(g.best.role, 'reshared with their own words');
  const j = leads.find((l) => l.name === 'Kai Ortiz');
  assert.equal(j.best.role, 'wrote the original');
  assert.match(j.best.via, /Riley T Morgan reshared it/);
});

test('a plain reshare is never the resharer\'s post: only the original author is a lead', () => {
  const html = page({
    author: 'Some Resharer', authorUrl: 'https://www.linkedin.com/in/some', date: '2026-09-20T00:00:00Z', ownId: RILEY_ID,
    words: '', cardTitle: "We're hiring Systems Engineers, reach out to me!",
    shared: { author: 'Devin Shah', url: 'https://www.linkedin.com/in/devin', words: "Exciting opportunity!! We're hiring Systems Engineers to join Technology Deployment", id: JAI_ID },
  });
  const leads = leadsFromPosts([parsePostHtml(html, 'u')], { now: NOW });
  assert.deepEqual(leads.map((l) => l.name), ['Devin Shah']);
});

test('a company page is a pointer, never a lead; the person it reshared is', () => {
  const html = page({
    author: 'Grishin Robotics', authorUrl: 'https://www.linkedin.com/company/grishinrobotics', date: '2026-09-12T07:58:34Z', ownId: RILEY_ID,
    words: 'Amazon Robotics is hiring Systems Engineers for its Technology Deployment team.',
    shared: { author: 'Tomasz Nowak', url: 'https://www.linkedin.com/in/kj', words: "Exciting Opportunity!! We're hiring Systems Engineers", id: JAI_ID },
  });
  const leads = leadsFromPosts([parsePostHtml(html, 'u')], { now: NOW });
  assert.deepEqual(leads.map((l) => l.name), ['Tomasz Nowak']);
  assert.match(leads[0].best.via, /a company page/);
  assert.equal(leads[0].best.date, '2026-09-02T22:11:48.505Z', 'dated by the ORIGINAL, not the company page\'s reshare');
});

test('third-person job broadcasts are not someone on the team', () => {
  assert.ok(readWords('Amazon is hiring a Robotics Systems Engineer I, Tech Deployment. Early career.').broadcast);
  assert.ok(!readWords('My team is hiring a Robotics Systems Engineer').broadcast);
  const html = page({ author: 'Job Poster', authorUrl: 'https://www.linkedin.com/in/jobs', date: '2026-09-30T00:00:00Z', ownId: RILEY_ID, words: 'Amazon is hiring a Robotics Systems Engineer I. Apply now!' });
  assert.deepEqual(leadsFromPosts([parsePostHtml(html, 'u')], { now: NOW }), []);
});

test('the words that make a lead', () => {
  const w = readWords("I am hiring! Reach out—I'd love to connect!");
  assert.ok(w.owns && w.invites && w.hiring);
  assert.ok(readWords("I'm growing my team at Amazon Robotics – Tech Deployment").owns);
  assert.ok(readWords('feel free to reach out to me or apply directly').invites);
  assert.ok(!readWords('Congrats to the team on the launch').hiring);
});

test('freshness uses the same bands as the rest of outreach', () => {
  assert.deepEqual([0, 14, 15, 42, 43, 120, 121, null].map(standingOf), ['fresh', 'fresh', 'recent', 'recent', 'weak', 'weak', 'stale', 'undated']);
  assert.equal(kindOf('https://www.linkedin.com/company/x'), 'company');
  assert.equal(kindOf('https://www.linkedin.com/in/x'), 'person');
});

test('a lead joins the Outreach tab in its own shape, and merges with the research', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'post-leads-'));
  const dbPath = path.join(dir, 'outreach.db');
  try {
    const html = page({
      author: 'Riley T Morgan', authorUrl: 'https://www.linkedin.com/in/riley', date: '2026-09-28T00:00:00Z', ownId: RILEY_ID,
      words: 'My team is hiring. Feel free to reach out to me.',
      shared: { author: 'Kai Ortiz', url: 'https://www.linkedin.com/in/kaiortiz', words: "We're Hiring: Robotics Systems Engineers", id: JAI_ID },
    });
    const people = leadsFromPosts([parsePostHtml(html, 'https://www.linkedin.com/posts/g')], { now: NOW }).map(toLeadPerson);
    const riley = people.find((p) => p.name === 'Riley T Morgan');
    assert.equal(riley.signal.kind, 'invited');
    assert.equal(readSignal(riley.signal, riley.name, NOW).standing, 'fresh');
    // The research had already found Riley with no post: the post evidence wins, his name appears once.
    mergePostLeads('job1', [{ name: 'Riley T Morgan', profile_url: 'https://www.linkedin.com/in/riley/', why: 'research words', signal: null, confidence: 'low' }], { dbPath, now: NOW });
    const n = mergePostLeads('job1', people, { dbPath, now: NOW });
    assert.equal(n, 2);
    const run = getLeadRun('job1', { dbPath });
    const g = run.result.people.find((p) => p.name === 'Riley T Morgan');
    assert.equal(g.why, 'research words');
    assert.equal(g.signal.kind, 'invited');
    assert.equal(run.result.people[0].name, 'Riley T Morgan', 'an inviting, fresh poster ranks first');
  } finally {
    // The store keeps its handle open for the process; Windows will not delete
    // an open database, and the temp folder is the OS's to clear.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still open */ }
  }
});

test('the research\'s cited post is read at the source: credit and date follow the page', async () => {
  const { verifyLeadPosts } = await import('./post-leads.mjs');
  const url = `https://www.linkedin.com/posts/riley_x-activity-${RILEY_ID}-Zdsc`;
  const html = page({
    author: 'Riley T Morgan', authorUrl: 'https://www.linkedin.com/in/riley', date: '2026-09-28T00:00:00Z', ownId: RILEY_ID,
    words: 'My team is hiring. Feel free to reach out to me or apply directly.',
    shared: { author: 'Kai Ortiz', url: 'https://www.linkedin.com/in/kaiortiz', words: "We're Hiring: Robotics Systems Engineers", id: JAI_ID },
  });
  const fetchImpl = async (u) => ({ ok: true, text: async () => (String(u).startsWith(url) ? html : '') });
  // The research credited Kai with Riley's post, undated: the page says Kai wrote the ORIGINAL, on its own date.
  const research = [{ name: 'Kai Ortiz', profile_url: 'https://www.linkedin.com/in/kaiortiz', evidence_url: url, signal: { kind: 'hiring_post', author: 'Riley T Morgan', date: '', quote: 'My team is hiring', url } }];
  const v = await verifyLeadPosts(research, { fetchImpl, now: NOW, pauseMs: 0 });
  const jai = v.people[0];
  assert.equal(jai.signal.author, 'Kai Ortiz');
  assert.equal(jai.signal.date, '2026-09-02');
  assert.equal(readSignal(jai.signal, 'Kai Ortiz', NOW).standing, 'recent');
  assert.deepEqual(v.added.map((p) => p.name), ['Riley T Morgan'], 'the resharer with his own invitation joins the leads');
  assert.equal(v.added[0].signal.kind, 'invited');
});

test('no cited post, no fetch', async () => {
  const { verifyLeadPosts } = await import('./post-leads.mjs');
  let calls = 0;
  const v = await verifyLeadPosts([{ name: 'A B', evidence_url: 'https://example.com/team' }], { fetchImpl: async () => { calls += 1; return { ok: false }; }, pauseMs: 0 });
  assert.equal(calls, 0);
  assert.equal(v.added.length, 0);
});

test('the Outreach button\'s run checks its posts before saving', async () => {
  // Ten days old whenever the test runs: a fixed date stops being 'recent' (RECENT_DAYS)
  // and the label this test checks goes with it (it read 2026-09-28 and failed from 11-09).
  const posted = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const L = await import('./leads.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-verify-'));
  const dbPath = path.join(dir, 'outreach.db');
  const url = `https://www.linkedin.com/posts/riley_x-activity-${RILEY_ID}-Zdsc`;
  const html = page({
    author: 'Riley T Morgan', authorUrl: 'https://www.linkedin.com/in/riley', date: `${posted}T00:00:00Z`, ownId: RILEY_ID,
    words: 'My team is hiring. Feel free to reach out to me.',
    shared: { author: 'Kai Ortiz', url: 'https://www.linkedin.com/in/kaiortiz', words: "We're Hiring: Robotics Systems Engineers", id: JAI_ID },
  });
  const ask = async () => JSON.stringify({ people: [{ name: 'Riley T Morgan', persona: 'manager', confidence: 'low', profile_url: 'https://www.linkedin.com/in/riley', evidence_url: url, signal: { kind: 'relevant_post', quote: 'snippet', url, date: '', author: 'Riley T Morgan' } }] });
  try {
    L.startLeadRun({ id: 'verify-1', company: 'Amazon', title: 'Robotics Systems Engineer I' }, { ask, dbPath, postFetch: async () => ({ ok: true, text: async () => html }) });
    await L.idle();
    const run = L.getLeadRun('verify-1', { dbPath });
    assert.equal(run.status, 'done');
    const names = run.result.people.map((p) => p.name);
    assert.ok(names.includes('Kai Ortiz'), 'the original writer was added');
    const g = run.result.people.find((p) => p.name === 'Riley T Morgan');
    assert.equal(g.signal.kind, 'invited');
    assert.equal(g.signal.date, posted);
    assert.equal(g.excellent, 'invites messages');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still open */ }
  }
});

test('a video post is a post: its poster is the creator, its words the description (F-783)', () => {
  // The shape of Sam Ortiza's 2026-09-16 Tutor reshare, a VideoObject.
  const WILL_ID = '7506026300000000101';
  const JOSH_ID = '7506025829000000102';
  const ld = {
    '@type': 'VideoObject', datePublished: '2026-09-16T16:28:45.265Z',
    headline: 'Extremely proud of the entire hardware engineering team.',
    description: 'Extremely proud of the entire hardware engineering team.',
    creator: { '@type': 'Person', name: 'Sam Ortiza', url: 'https://www.linkedin.com/in/samortiza' },
    sharedContent: { '@type': 'WebPage', headline: "I'm excited to share Tutor's next generation of robots. We're hiring.", author: { '@type': 'Person', name: 'Dana Whitfield', url: 'https://www.linkedin.com/in/dana-whitfield-0000000' } },
  };
  const html = `<html><script type="application/ld+json">${JSON.stringify(ld)}</script><a data-urn="urn:li:activity:${WILL_ID}"></a><div data-urn="urn:li:activity:${JOSH_ID}"></div></html>`;
  const p = parsePostHtml(html, `https://www.linkedin.com/posts/samortiza_x-activity-${WILL_ID}-Ab3d`);
  assert.ok(p, 'a video post is read');
  assert.equal(p.author.name, 'Sam Ortiza');
  assert.equal(p.author.kind, 'person');
  assert.equal(p.text, 'Extremely proud of the entire hardware engineering team.');
  assert.equal(p.shared.author.name, 'Dana Whitfield');
  assert.equal(p.date, '2026-09-16T16:28:45.265Z');
});

test('a posting link is lifted off a post for any application platform, never LinkedIn\'s own job list (2026-10-24)', async () => {
  const { JOB_LINK } = await import('./post-leads.mjs');
  const html = `<p>Apply: https://boards.greenhouse.io/tutorintelligence/jobs/123 and https://jobs.lever.co/agility/abc-1 and https://tesla.wd5.myworkdayjobs.com/en-US/careers/job/x_R1 and https://www.amazon.jobs/en/jobs/2912345</p>
    <a href="https://www.linkedin.com/jobs/view/999">Explore jobs</a>`;
  const got = [...html.matchAll(JOB_LINK)].map((m) => m[0]);
  assert.equal(got.length, 4);
  assert.ok(got.every((u) => !/linkedin\.com/.test(u)));
  const p = parsePostHtml(`<script type="application/ld+json">${JSON.stringify({ '@type': 'SocialMediaPosting', articleBody: 'We are hiring', author: { name: 'A B', url: 'https://www.linkedin.com/in/ab' } })}</script> https://jobs.ashbyhq.com/genesis/abc`, 'https://www.linkedin.com/posts/ab_x-activity-7518854823000000105-Kp4m');
  assert.deepEqual(p.jobLinks, ['https://jobs.ashbyhq.com/genesis/abc']);
});
