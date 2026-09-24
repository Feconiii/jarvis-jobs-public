// jarvis/company-logo.test.mjs — the logo resolver guesses well and never lies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { domainCandidates, registrableDomain, initials, logoKey, fetchIcon, LogoCache } from './company-logo.mjs';

test('the posting URL names the company before the name is guessed at', () => {
  const first = (c) => domainCandidates(c)[0];
  // Workday tenant, Greenhouse board, Lever, Ashby, Eightfold on the company's own host.
  assert.equal(first({ company: 'KLA Corporation', url: 'https://kla.wd1.myworkdayjobs.com/en-US/Search/job/x/Mechanical-Design-Engineer_R1' }), 'kla.com');
  assert.equal(first({ company: 'Neuralink', url: 'https://boards.greenhouse.io/neuralink/jobs/7668502003' }), 'neuralink.com');
  assert.equal(first({ company: 'Dexterity', url: 'https://jobs.lever.co/dexterity/abc' }), 'dexterity.com');
  assert.equal(first({ company: 'Lam Research', url: 'https://careers.lamresearch.com/careers/job/1' }), 'lamresearch.com');
  assert.equal(first({ company: 'Eaton Corporation', url: 'https://careers.eaton.com/careers/job/1-x' }), 'eaton.com');
  assert.equal(first({ company: 'Applied Materials', url: 'https://amat.eightfold.ai/careers/job/1' }), 'amat.com');
  // An aggregator's host says nothing; the name decides.
  assert.equal(first({ company: 'Boston Scientific', url: 'https://www.linkedin.com/jobs/view/1' }), 'bostonscientific.com');
});

test('startup TLDs are tried, and a descriptive word is never dropped from a name', () => {
  const c = domainCandidates({ company: '1X Technologies', url: 'https://jobs.ashbyhq.com/1x/abc' });
  assert.ok(c.includes('1x.tech'), `${c}`);
  const g = domainCandidates({ company: 'Gradient Robotics' });
  assert.ok(!g.includes('gradient.com'), 'Gradient Robotics must not resolve to whoever owns gradient.com');
  assert.ok(g.includes('gradientrobotics.com'));
  // Only the legal form goes.
  assert.equal(domainCandidates({ company: 'Motorola Solutions' })[0], 'motorolasolutions.com');
  assert.equal(domainCandidates({ company: 'Acme, Inc.' })[0], 'acme.com');
  assert.ok(domainCandidates({ company: 'Acme, Inc.' }).length <= 8, 'bounded');
});

test('registrable domains and initials', () => {
  assert.equal(registrableDomain('careers.lamresearch.com'), 'lamresearch.com');
  assert.equal(registrableDomain('jobs.acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(initials('KLA Corporation'), 'K');
  assert.equal(initials('Lam Research'), 'LR');
  assert.equal(initials('1X Technologies'), '1T');
  assert.equal(initials(''), '?');
  assert.equal(logoKey('KLA Corp.'), 'kla');
  assert.equal(logoKey('Eaton Corporation'), logoKey('Eaton'), 'one employer, one logo');
});

const png = (n) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n)]);
const fakeFetch = (known) => async (url) => {
  const domain = String(url).match(/ip3\/([^/]+)\.ico|domain=([^&]+)/);
  const d = (domain?.[1] || domain?.[2] || '').toLowerCase();
  if (known[d]) return { status: 200, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => png(known[d]) };
  // What the real services do for an unknown domain: 404 with an image body.
  return { status: 404, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => png(1400) };
};

test('fetchIcon takes the first source that answers 200 with an image, and refuses tiny ones', async () => {
  const hit = await fetchIcon('kla.com', { fetchImpl: fakeFetch({ 'kla.com': 800 }) });
  assert.equal(hit.source, 'duckduckgo');
  assert.equal(hit.bytes.length, 808);
  assert.equal(await fetchIcon('nothing.example', { fetchImpl: fakeFetch({}) }), null, 'a 404 is not a logo, whatever its body');
  assert.equal(await fetchIcon('tiny.example', { fetchImpl: fakeFetch({ 'tiny.example': 10 }) }), null, 'a 1×1 is not a logo');
  const boom = async () => { throw new Error('offline'); };
  assert.equal(await fetchIcon('kla.com', { fetchImpl: boom }), null, 'offline is a lettermark, not an error');
});

test('THE CACHE: one lookup per company, misses remembered, hits kept on disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-logos-'));
  try {
    let calls = 0;
    const fetchImpl = async (u) => { calls++; return fakeFetch({ 'kla.com': 600 })(u); };
    const cache = new LogoCache(dir);
    const a = await cache.resolve({ company: 'KLA Corporation', url: 'https://kla.wd1.myworkdayjobs.com/x/job/y_R1' }, { fetchImpl });
    assert.equal(a.domain, 'kla.com');
    assert.ok(existsSync(a.full));
    const callsAfterHit = calls;
    // Second ask: answered from disk, no network.
    const b = await cache.resolve({ company: 'KLA Corp.', url: '' }, { fetchImpl });
    assert.equal(b.file, a.file, 'KLA Corp. and KLA Corporation share one logo');
    assert.equal(calls, callsAfterHit);

    // A miss is remembered for a month.
    const miss = await cache.resolve({ company: 'Gradient Robotics' }, { fetchImpl });
    assert.equal(miss.none, true);
    const callsAfterMiss = calls;
    await cache.resolve({ company: 'Gradient Robotics' }, { fetchImpl });
    assert.equal(calls, callsAfterMiss, 'a remembered miss costs no network');
    // …and retried after it.
    const later = Date.now() + 31 * 24 * 3600 * 1000;
    await cache.resolve({ company: 'Gradient Robotics' }, { fetchImpl, now: later });
    assert.ok(calls > callsAfterMiss, 'retried after the month');

    // Concurrent asks for one company share a lookup.
    const cache2 = new LogoCache(mkdtempSync(path.join(tmpdir(), 'jarvis-logos2-')));
    let calls2 = 0;
    const slow = async (u) => { calls2++; await new Promise((r) => setTimeout(r, 20)); return fakeFetch({ 'neuralink.com': 500 })(u); };
    const [x, y] = await Promise.all([
      cache2.resolve({ company: 'Neuralink', url: 'https://boards.greenhouse.io/neuralink/jobs/1' }, { fetchImpl: slow }),
      cache2.resolve({ company: 'Neuralink', url: 'https://boards.greenhouse.io/neuralink/jobs/2' }, { fetchImpl: slow }),
    ]);
    assert.equal(x.file, y.file);
    assert.equal(calls2, 1, 'two rows, one lookup');
    const idx = JSON.parse(readFileSync(path.join(cache2.dir, 'index.json'), 'utf-8'));
    assert.equal(idx.neuralink.domain, 'neuralink.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
