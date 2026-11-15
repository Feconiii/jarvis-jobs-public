import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleParts, clusters, searches, googleUrl, EXTRACT } from './post-search.mjs';

test('the team comes from the title, not the employer\'s job category', () => {
  assert.deepEqual(titleParts('Robotics Systems Engineer I, Tech Deployment'), { role: 'Robotics Systems Engineer', team: 'Tech Deployment', short: 'Tech Deployment', acronyms: [] });
  const rdpi = titleParts('Robotics Systems Engineer I, Robotics Delivery & Packaging Innovations (RDPI) Technology Deployment');
  assert.equal(rdpi.short, 'Technology Deployment');
  assert.deepEqual(rdpi.acronyms, ['RDPI']);
  assert.equal(titleParts('Innovation and Design Engineer, Worldwide Design Engineering').team, 'Worldwide Design Engineering');
  assert.equal(titleParts('Cloud Hardware Development Engineer, AWS - Early Career (2026)').team, '', 'a bare division is not a team');
  assert.deepEqual(titleParts('Automation Engineer'), { role: 'Automation Engineer', team: '', short: '', acronyms: [] });
});

test('five reqs on one team are one group, and one message', () => {
  const jobs = ['Robotics Systems Engineer I, Tech Deployment', 'Robotics Systems Engineer , Tech Deployment', 'Robotics Systems Engineer I, Tech Deployment', 'Automation Engineer']
    .map((title, i) => ({ id: String(i), title }));
  const c = clusters(jobs);
  assert.equal(c.length, 2);
  assert.equal(c.find((x) => x.team === 'Tech Deployment').jobs.length, 3);
});

test('at most three searches a team, the acronym and the team first', () => {
  const [rdpi] = clusters([{ id: 'a', title: 'Robotics Systems Engineer I, Robotics Delivery & Packaging Innovations (RDPI) Technology Deployment' }]);
  const q = searches('Amazon', rdpi);
  assert.equal(q.length, 3);
  assert.equal(q[0], 'site:linkedin.com/posts "Amazon" "RDPI" hiring');
  assert.equal(q[1], 'site:linkedin.com/posts "Amazon" "Technology Deployment" hiring');
  const [aws] = clusters([{ id: 'b', title: 'Cloud Hardware Development Engineer, AWS - Early Career (2026)' }]);
  assert.ok(searches('Amazon', aws).every((s) => s.includes('Cloud Hardware Development Engineer')));
  assert.match(googleUrl('a "b"'), /tbs=qdr:y&q=a%20%22b%22$/);
});

test('the results-page snippet compiles and returns slugs, never full links', () => {
  assert.doesNotThrow(() => new Function(`return ${EXTRACT}`));
  assert.doesNotMatch(EXTRACT, /return uniq\.map\(\(s\) => 'https/);
});

// His setup item 2 (2026-10-05): the searches run in his Opera, paced, and a
// CAPTCHA stops everything after it.
import { runSearches } from './post-search.mjs';
function fakeCdp(answers) {
  const sent = [];
  let n = 0;
  return {
    sent,
    send: async (method, params = {}) => {
      sent.push({ method, params });
      if (method === 'Target.createTarget') return { targetId: `T${++n}` };
      if (method === 'Target.attachToTarget') return { sessionId: `S${n}` };
      if (method === 'Runtime.evaluate') return { result: { value: answers[n - 1] } };
      return {};
    },
  };
}
test('runs each search in a background Google tab, closes it, and collects the post slugs', async () => {
  const cdp = fakeCdp(['jai_post-activity-1\nriley_post-activity-2', 'NONE']);
  const waits = [];
  const r = await runSearches(cdp, [{ key: 'tech deployment', queries: ['q1', 'q2'] }], { pauseMs: 60000, log: () => {}, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(r.found['tech deployment'], ['jai_post-activity-1', 'riley_post-activity-2']);
  assert.equal(r.stopped, false);
  const opened = cdp.sent.filter((s) => s.method === 'Target.createTarget');
  assert.ok(opened.every((s) => s.params.background && /^https:\/\/www\.google\.com\/search/.test(s.params.url)), 'Google only, never in front');
  assert.equal(cdp.sent.filter((s) => s.method === 'Target.closeTarget').length, 2);
  assert.equal(waits.filter((w) => w === 60000).length, 1, 'one pause between two searches');
});
test('a CAPTCHA stops every search after it', async () => {
  const cdp = fakeCdp(['CHALLENGE: this engine wants a CAPTCHA', 'x-activity-1']);
  const r = await runSearches(cdp, [{ key: 'a', queries: ['q1', 'q2'] }, { key: 'b', queries: ['q3'] }], { pauseMs: 0, log: () => {}, sleep: async () => {} });
  assert.equal(r.stopped, true);
  assert.equal(cdp.sent.filter((s) => s.method === 'Target.createTarget').length, 1);
});

test('once per company: new hires announcing the team they joined (F-783, Chris Moreno)', async () => {
  const { companySearches } = await import('./post-search.mjs');
  const q = companySearches('OpenAI');
  assert.equal(q.length, 2);
  assert.ok(q.every((s) => s.startsWith('site:linkedin.com/posts "joined OpenAI"')));
  assert.ok(q.some((s) => s.includes('"open roles"')));
});

// 2026-10-24: titles outside Amazon's "Role, Team" shape searched as one
// quoted phrase holding the grad year, the degree and the city.
test('grad years, degrees and the posting\'s place are not part of the role', () => {
  assert.equal(titleParts('Semiconductor Manufacturing Engineer 2027 New College Graduate Essex Junction Vermont United States Of America', 'Essex Junction, Vermont, United States').role, 'Semiconductor Manufacturing Engineer');
  assert.equal(titleParts('Manufacturing Engineer I New College Grad Bachelor S Austin Tx', 'Austin, TX').role, 'Manufacturing Engineer');
  assert.equal(titleParts('Plainview Mechanical Engineer NY', 'Plainview, NY').role, 'Mechanical Engineer');
  assert.deepEqual(titleParts('Manufacturing Engineer (Wayne (EPCO), NJ, US)', 'Wayne, NJ'), { role: 'Manufacturing Engineer', team: '', short: '', acronyms: [] });
});

test('a spaced dash names the team too; a comma inside it keeps the last part', () => {
  assert.deepEqual(titleParts('Mechanical Engineer - Optical Systems (Miami, FL)', 'Miami, FL'), { role: 'Mechanical Engineer', team: 'Optical Systems', short: 'Optical Systems', acronyms: [] });
  const h = titleParts('Hardware Operations Engineer - Robotics, Real-World Test Lab');
  assert.equal(h.role, 'Hardware Operations Engineer');
  assert.equal(h.short, 'Real-World Test Lab');
});

test('every search names the company unless the team name is distinctive on its own', () => {
  const [robot] = clusters([{ id: 'r', title: 'Manufacturing Engineer, Robot' }]);
  assert.ok(searches('Capstan Medical', robot).every((s) => s.includes('"Capstan Medical"')));
  const [plain] = clusters([{ id: 'p', title: 'Mechanical Engineer' }]);
  const q = searches('Genesis', plain);
  assert.ok(q.every((s) => s.includes('"Genesis"')), 'never "Mechanical Engineer" "my team" alone');
  assert.equal(q.length, 2);
});
