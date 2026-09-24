/**
 * The outreach routes, against a REAL server and an EMPTY store.
 *
 * Against a temp JARVIS_DATA_DIR, never his: these endpoints WRITE — a contact
 * row, a sent date, a permanent do-not-contact — and a test that seeded his
 * real ledger with "Dana Lee" would be a bug with a person's name on it.
 *
 * Drafting is switched off (JARVIS_TAILOR=off) so nothing here spends two
 * minutes in a model call. What is under test is the plumbing and the GATE:
 * the server must refuse a second person for one role, and must refuse anything
 * at all for someone who asked not to be contacted — refuse at the route,
 * not in the page, because a page can be reloaded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4396;
const BASE = `http://127.0.0.1:${PORT}`;

let server; let dir; let token; let jobId;

const post = async (p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': token },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { 'x-jarvis-token': token } });
  return { status: r.status, body: await r.json() };
};

test.before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'jarvis-outreach-'));
  server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, JARVIS_AUTO: '0', JARVIS_DATA_DIR: dir, JARVIS_RESUME_DIR: path.join(dir, 'resumes'), JARVIS_TAILOR: 'off' },
    stdio: 'ignore',
  });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  token = (await (await fetch(`${BASE}/api/apply-token`)).json()).token;
  assert.ok(token, 'the server hands out a token');

  // One posting to talk about, recorded the way the extension records one.
  // The description carries the two things outreach reads out of a JD — the
  // team and the reporting line — plus the role account that proves a domain.
  const POSTING = {
    title: 'Manufacturing Engineer I',
    company: 'Acme Tools',
    location: 'Austin, TX, US',
    url: 'https://jobs.lever.co/acmetools/9c8b7a65-1111-2222-3333-444455556666',
    source: 'jsonld',
    description: `You will join the Equipment Engineering team in Austin. This role reports to the Manufacturing Engineering Manager. ${'Design fixtures and process tooling for the assembly line. SolidWorks, GD&T, DOE. '.repeat(5)} Questions about accommodations: accommodations@acmetools.com`,
  };
  const seeded = await post('/api/apply-page', { pageUrl: POSTING.url, posting: POSTING });
  jobId = seeded.body?.id || '';
  assert.ok(jobId, `a job to talk about: ${JSON.stringify(seeded.body).slice(0, 300)}`);
});

test.after(() => {
  server?.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }
});

test('the spec names a team, a title and a search — never a person', async () => {
  const { status, body } = await get(`/api/outreach?id=${jobId}`);
  assert.equal(status, 200);
  assert.equal(body.spec.team, 'Equipment Engineering');
  assert.equal(body.spec.managerTitle, 'Manufacturing Engineering Manager');
  assert.ok(body.spec.searches.some((s) => s.persona === 'alumni'), 'alumni is offered');
  assert.ok(body.spec.searches.every((s) => s.url.startsWith('https://www.linkedin.com/search/')),
    'every search is a link he clicks');
  assert.equal(body.contacts.length, 0);
  assert.equal(body.gate.ok, true, 'nobody written to yet');
});

test('the company\'s own posting supplies its email domain', async () => {
  const { body } = await get(`/api/outreach?id=${jobId}`);
  assert.equal(body.emailHint.domain, 'acmetools.com');
  // A role account proves the domain and teaches nothing about the format, so
  // the pattern stays empty and any address built from it is a labelled guess.
  assert.equal(body.emailHint.pattern, '');
});

test('a contact is recorded, with the address marked as a guess', async () => {
  const { status, body } = await post('/api/outreach/contact', {
    id: jobId, name: 'Dana Lee', title: 'Equipment Engineer', persona: 'team', channel: 'email',
  });
  assert.equal(status, 200);
  assert.equal(body.contact.status, 'drafted');
  assert.equal(body.contact.email, 'dana.lee@acmetools.com');
  assert.equal(body.contact.email_conf, 'guess', 'nothing confirmed the format, and it says so');
});

test('THE ROUTE REFUSES A SECOND PERSON FOR THE SAME ROLE', async () => {
  const { status, body } = await post('/api/outreach/contact', {
    id: jobId, name: 'Sam Rivers', title: 'Staff Engineer', persona: 'team',
  });
  assert.equal(status, 409, 'refused at the route, not left to the page to remember');
  assert.match(body.error, /Dana Lee/, 'and it says who is already in flight');
});

test('he marks it sent, and the follow-up is not due yet', async () => {
  const { body } = await post('/api/outreach/mark', { contactId: 'acmetools:danalee', what: 'sent' });
  assert.equal(body.contact.status, 'sent');
  assert.ok(body.contact.sent_at);
  const { body: q } = await get('/api/outreach/queue');
  assert.equal(q.due.length, 0, 'nothing is due six business days early');
  assert.equal(q.stats.rate, '0/1', 'a fraction, never a percentage');
});

test('a reply ends the outreach and shows up in the stats', async () => {
  await post('/api/outreach/mark', { contactId: 'acmetools:danalee', what: 'replied' });
  const { body } = await get('/api/outreach/queue');
  assert.equal(body.stats.rate, '1/1');
  assert.deepEqual(body.stats.byPersona.team, { sent: 1, replied: 1 });
});

test('DO NOT CONTACT IS PERMANENT, AND THE ROUTE ENFORCES IT', async () => {
  await post('/api/outreach/contact', { id: jobId, name: 'Kit Moreno', persona: 'alumni', force: true });
  await post('/api/outreach/mark', { contactId: 'acmetools:kitmoreno', what: 'do-not-contact', why: 'asked not to be' });
  // Even with `force`, which exists for "one more person at this company".
  const again = await post('/api/outreach/contact', { id: jobId, name: 'Kit Moreno', persona: 'alumni' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /not to be contacted/);
});

test('drafting returns a refusal rather than a message when writing is off', async () => {
  const { status, body } = await post('/api/outreach/draft', { id: jobId, name: 'Dana Lee', channel: 'email' });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.text, '');
  assert.match(body.why, /switched off/);
});

test('an unknown job is refused honestly', async () => {
  const { status } = await get('/api/outreach?id=nope');
  assert.equal(status, 404);
});

// ── the Outreach button on an application card ───────────────────────
// Research is off in this server (JARVIS_TAILOR=off), so what is under test is
// the route: it starts a run for a real job, reports it back, and lists it in
// the board's summary — without minutes of web search.

test('THE OUTREACH BUTTON: a lead run is started, reported, and summarised for the board', async () => {
  const before = await get(`/api/outreach/leads?id=${jobId}`);
  assert.equal(before.status, 200);
  assert.equal(before.body.run.status, 'none', 'nothing has been researched yet');

  const started = await post('/api/outreach/leads', { id: jobId });
  assert.equal(started.status, 200);
  assert.equal(started.body.run.status, 'failed');
  assert.match(started.body.run.error, /switched off/, 'the reason travels to the page');
  assert.ok(Array.isArray(started.body.contacts), 'the ledger rows come back with it, so the page can mark who is saved');

  const after = await get(`/api/outreach/leads?id=${jobId}`);
  assert.equal(after.body.run.status, 'failed');
  assert.equal(after.body.job.company, 'Acme Tools');

  const { body } = await get('/api/outreach/leads/summary');
  assert.equal(body.jobs[jobId].status, 'failed');
  assert.equal(body.jobs[jobId].count, 0);
});

// ── mail: the setup routes, against a server with no Gmail ─────────────
test('MAIL SETUP: status, a validated client, Google\'s read-only consent link, and a refused stale sign-in', async () => {
  const st = await get('/api/mail/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.configured, false);
  assert.equal(st.body.connected, false);
  assert.match(st.body.redirectUri, /\/oauth\/gmail\/callback$/);

  assert.equal((await post('/api/mail/client', { client_id: 'nope', client_secret: 'x' })).status, 400);
  const saved = await post('/api/mail/client', { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.configured, true);

  const r = await fetch(`${BASE}/api/mail/connect`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.hostname, 'accounts.google.com');
  assert.equal(to.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly', 'read-only, and nothing else');

  const stale = await fetch(`${BASE}/oauth/gmail/callback?code=x&state=forged`);
  assert.equal(stale.status, 200);
  assert.match(await stale.text(), /not connected: that sign-in link is stale/);

  assert.equal((await post('/api/mail/sync', {})).status, 409, 'nothing to check before it is connected');
  const ev = await get('/api/mail/events');
  assert.deepEqual(ev.body.latest, {});
  assert.equal((await post('/api/mail/undo', { msgId: 'nope' })).status, 404);
});

test('a lead run for an unknown job is refused', async () => {
  assert.equal((await post('/api/outreach/leads', { id: 'nope' })).status, 404);
  assert.equal((await get('/api/outreach/leads?id=nope')).status, 404);
});
