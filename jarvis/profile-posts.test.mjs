import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileUrl, parseProfileHtml, worksAt, readProfile } from './profile-posts.mjs';

const NOW = new Date('2026-10-21T12:00:00Z');
const FRESH = '7506026300000000101'; // 2026-09-16
const OLD = '7340000000000000000'; // mid 2025

const profilePage = (posts) => `<html><head><title>Sam Ortiza - Tutor Intelligence | LinkedIn</title>
<meta name="description" content="I am a mechanical engineer · Experience: Tutor Intelligence · Education: Worcester Polytechnic Institute · Location: United States"></head>
<body>${posts.map((id) => `<a href="https://www.linkedin.com/posts/samortiza_x-activity-${id}-Ab3d?trk=public_profile">p</a>`).join('')}</body></html>`;

const postPage = (id, words) => `<html><script type="application/ld+json">${JSON.stringify({
  '@type': 'SocialMediaPosting', datePublished: '2026-09-16T16:28:45.265Z', articleBody: words,
  author: { '@type': 'Person', name: 'Sam Ortiza', url: 'https://www.linkedin.com/in/samortiza' },
})}</script><a data-urn="urn:li:activity:${id}"></a></html>`;

test('a profile is named by URL or slug', () => {
  assert.equal(profileUrl('samortiza'), 'https://www.linkedin.com/in/samortiza');
  assert.equal(profileUrl('https://www.linkedin.com/in/samortiza/?x=1'), 'https://www.linkedin.com/in/samortiza');
  assert.equal(profileUrl('linkedin.com/in/chris-moreno-0000000'), 'https://www.linkedin.com/in/chris-moreno-0000000');
  assert.equal(profileUrl('not a profile at all'), '');
});

test('the page gives name, employer and dated posts; only the window counts as recent', () => {
  const p = parseProfileHtml(profilePage([FRESH, OLD]), { now: NOW, days: 75, slug: 'samortiza' });
  assert.equal(p.name, 'Sam Ortiza');
  assert.equal(p.headline, 'Tutor Intelligence');
  assert.equal(p.experience, 'Tutor Intelligence');
  assert.equal(p.posts.length, 2);
  assert.equal(p.recent.length, 1);
  assert.equal(p.recent[0].ageDays, 34);
  assert.equal(p.recent[0].own, true, 'the link carries their own slug');
  assert.ok(!p.recent[0].url.includes('?'), 'tracking query dropped');
  assert.equal(worksAt(p, 'Tutor Intelligence'), true);
  assert.equal(worksAt(p, 'Neuralink'), false);
});

test('a 999 is retried once, then reported as refused, never as "no posts"', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 999, text: async () => '' }; };
  const r = await readProfile('samortiza', { fetchImpl, now: NOW, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.equal(r.status, 'refused');
  assert.equal(r.posts, undefined);
});

test('a refusal that clears on the retry reads the page and its recent posts', async () => {
  const pages = [
    { ok: false, status: 999, text: async () => '' },
    { ok: true, status: 200, text: async () => profilePage([FRESH, OLD]) },
    { ok: true, status: 200, text: async () => postPage(FRESH, 'My team is hiring mechanical engineers, reach out to me.') },
  ];
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return pages.shift(); };
  const r = await readProfile('samortiza', { fetchImpl, now: NOW, sleep: async () => {} });
  assert.equal(r.status, 'ok');
  assert.equal(r.posts.length, 1, 'only the post inside the window is read');
  assert.equal(r.posts[0].author.name, 'Sam Ortiza');
  assert.equal(seen.length, 3);
});

test('their own posts are read first; a post they only engaged with is never a lead', async () => {
  const ENGAGED = '7517972625000000103'; // 2026-10-19, someone else's
  const page = `<html><title>Sam Ortiza - Tutor Intelligence | LinkedIn</title>
    <a href="https://www.linkedin.com/posts/lee-parkhurst_four-products-activity-${ENGAGED}-8YAd">x</a>
    <a href="https://www.linkedin.com/posts/samortiza_x-activity-${FRESH}-Ab3d">y</a></html>`;
  const p = parseProfileHtml(page, { now: NOW, slug: 'samortiza' });
  assert.deepEqual(p.recent.map((x) => x.own), [false, true]);
  const order = [];
  const fetchImpl = async (url) => {
    order.push(url);
    if (url.includes('/in/')) return { ok: true, status: 200, text: async () => page };
    return { ok: true, status: 200, text: async () => postPage(FRESH, 'We are hiring, reach out') };
  };
  const r = await readProfile('samortiza', { fetchImpl, now: NOW, sleep: async () => {} });
  assert.match(order[1], /samortiza_/, 'own post read before the engaged one');
  assert.equal(r.posts.find((x) => x.url.includes('lee-parkhurst')).own, false);
});

test('the Outreach button: a person with no post gets their own hiring post; a moved person is named', async () => {
  const { profileCheck } = await import('./profile-posts.mjs');
  const moved = `<html><title>Jo Doe - Other Co | LinkedIn</title><meta name="description" content="x · Experience: Other Co · y"></html>`;
  const fetchImpl = async (url) => {
    if (url.endsWith('/in/samortiza')) return { ok: true, status: 200, text: async () => profilePage([FRESH]) };
    if (url.endsWith('/in/jodoe')) return { ok: true, status: 200, text: async () => moved };
    if (url.endsWith('/in/refused')) return { ok: false, status: 999, text: async () => '' };
    return { ok: true, status: 200, text: async () => postPage(FRESH, 'My team is hiring mechanical engineers, reach out.') };
  };
  const people = [
    { name: 'Sam Ortiza', profile_url: 'https://www.linkedin.com/in/samortiza', signal: { kind: 'none' } },
    { name: 'Jo Doe', profile_url: 'https://www.linkedin.com/in/jodoe' },
    { name: 'Refused Person', profile_url: 'https://www.linkedin.com/in/refused' },
    { name: 'No Profile' },
  ];
  const out = await profileCheck(people, 'Tutor Intelligence', { fetchImpl, now: NOW, sleep: async () => {} });
  assert.equal(out[0].profile_check, 'still there');
  assert.match(out[0].signal.url, /samortiza_x-activity-/);
  assert.equal(out[0].signal.kind, 'hiring_post');
  assert.match(out[1].profile_check, /does not name Tutor Intelligence \(shows Other Co\)/);
  assert.equal(out[2].profile_check, 'refused');
  assert.equal(out[2].signal, undefined, 'a refused page changes nothing');
  assert.deepEqual(out[3], { name: 'No Profile' });
});

test('the employer on the page matches without its generic words, and only then (2026-10-24)', () => {
  assert.equal(worksAt({ experience: 'Sunday' }, 'Sunday Robotics'), true);
  assert.equal(worksAt({ experience: 'Figure' }, 'Figure AI'), true);
  assert.equal(worksAt({ experience: 'Amazon Web Services (AWS)' }, 'Amazon'), true);
  assert.equal(worksAt({ experience: 'Applied Intuition' }, 'Applied Materials'), false);
  assert.equal(worksAt({ experience: 'Tesla' }, 'Amazon'), false);
});
