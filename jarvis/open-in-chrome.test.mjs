/**
 * Opening a tab is the one thing in this system that reaches outside the
 * process, so what it refuses matters as much as what it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openInChrome, findChrome, chromeCandidates, isOpenableUrl } from './open-in-chrome.mjs';

const ENV = {
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
};

test('looks for Chrome in the three places Windows puts it', () => {
  const c = chromeCandidates(ENV);
  assert.equal(c.length, 3);
  for (const p of c) assert.match(p, /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
});

test('prefers Program Files over the per-user install', () => {
  const found = findChrome(ENV, (p) => p.includes('Program Files') || p.includes('AppData'));
  assert.match(found, /^C:\\Program Files\\/);
});

test('reports no Chrome rather than guessing a path', () => {
  assert.equal(findChrome(ENV, () => false), null);
});

test('only http and https are openable', () => {
  assert.ok(isOpenableUrl('https://boards.greenhouse.io/x/jobs/1'));
  assert.ok(isOpenableUrl('http://localhost:4300/'));
  for (const bad of ['file:///C:/Users/you/cv.md', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,x', '', null, 'not a url']) {
    assert.equal(isOpenableUrl(bad), false, `"${bad}" must not reach a browser command line`);
  }
});

test('a non-web URL is refused before Chrome is ever spawned', async () => {
  let spawned = false;
  const r = await openInChrome('file:///C:/Users/you/cv.md', {
    env: ENV, chromePath: 'C:\\chrome.exe', spawn: async () => { spawned = true; },
  });
  assert.equal(r.ok, false);
  assert.equal(spawned, false, 'a refused URL must not be handed to a process at all');
  assert.match(r.why, /only http and https/);
});

test('passes the profile directory so the tab lands in the profile he is signed into', async () => {
  let seen = null;
  const r = await openInChrome('https://example.test/job/1', {
    env: ENV, chromePath: 'C:\\chrome.exe',
    spawn: async (bin, args) => { seen = { bin, args }; },
  });
  assert.equal(r.ok, true);
  assert.equal(seen.bin, 'C:\\chrome.exe');
  // F-125 measured Default as his live profile; Profile 1 has been stale since 2023.
  assert.ok(seen.args.includes('--profile-directory=Default'));
  assert.equal(seen.args.at(-1), 'https://example.test/job/1', 'the URL goes last');
});

test('never passes a debug port — that is what made the old design impossible', async () => {
  let seen = null;
  await openInChrome('https://example.test/', {
    env: ENV, chromePath: 'C:\\chrome.exe', spawn: async (bin, args) => { seen = args; },
  });
  // Chrome 136+ refuses remote debugging on the default profile outright. Asking
  // for it here would not fail loudly, it would just be ignored — and the whole
  // point of this path is that it needs no port at all.
  assert.ok(!seen.some((a) => /remote-debugging/.test(a)));
  assert.ok(!seen.some((a) => /user-data-dir/.test(a)), 'a user-data-dir would start a SEPARATE browser he is not signed into');
});

test('says plainly when Chrome is not installed', async () => {
  const r = await openInChrome('https://example.test/', { env: {}, spawn: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.why, /no chrome\.exe/);
});

test('a Chrome that will not start is reported, not thrown', async () => {
  const r = await openInChrome('https://example.test/', {
    env: ENV, chromePath: 'C:\\chrome.exe',
    spawn: async () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /would not open the tab/);
});
