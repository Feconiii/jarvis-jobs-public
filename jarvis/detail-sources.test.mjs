// jarvis/detail-sources.test.mjs — the one list, and proof it still matches (F-444, F-445).
//
// The bug these guard was never "the list is wrong today". It was that three
// copies of one list, in three files, kept in step by hand, drift — and drift
// silently, because nothing compares them. serve.mjs's copy carried a comment
// explaining that it had already drifted once and been corrected, and by the
// time anyone looked again it was wrong in both directions and 39,000 read
// postings were being counted as unreadable.
//
// So the test that matters is not "does the module export an array". It is
// "does this array still equal what enrich.mjs actually implements", checked
// against the source of truth rather than against another copy of the belief.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DETAIL_SOURCES, BODY_IN_LIST, BROWSER_ONLY, READABLE_SOURCES, driftFrom,
} from './detail-sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The keys of enrich.mjs's DETAIL map, read out of the FILE.
 *
 * Deliberately not an import: enrich.mjs calls guardArgs() at the top level,
 * which would parse the test runner's argv and exit. Reading the source is
 * also the more honest check — it sees what is written, not what a module
 * chose to export.
 */
function detailKeysFromSource() {
  const src = readFileSync(path.join(HERE, 'enrich.mjs'), 'utf-8');
  const start = src.indexOf('const DETAIL = {');
  assert.notEqual(start, -1, 'enrich.mjs no longer declares `const DETAIL = {` — this test is reading the wrong thing');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, 'unbalanced braces in the DETAIL literal');
  const body = src.slice(start, end);
  // Method shorthand at one level of indentation: `workday(url) {` or
  // `'oracle-orc'(url, job) {`.
  return [...body.matchAll(/^ {2}(?:'([\w.-]+)'|([a-zA-Z][\w]*))\s*\(/gm)].map(m => m[1] || m[2]);
}

test('DETAIL_SOURCES is exactly what enrich.mjs implements', () => {
  const actual = detailKeysFromSource();
  assert.ok(actual.length >= 5, `only found ${actual.length} derivers — the parser, not the list, is probably wrong`);
  const { missing, stale } = driftFrom(actual);
  assert.deepEqual(missing, [], 'enrich.mjs grew a deriver that detail-sources.mjs does not name — add it there');
  assert.deepEqual(stale, [], 'detail-sources.mjs names a deriver enrich.mjs no longer has — remove it there');
});

test('driftFrom reports each direction separately', () => {
  const grew = driftFrom([...DETAIL_SOURCES, 'brandnew']);
  assert.deepEqual(grew.missing, ['brandnew']);
  assert.deepEqual(grew.stale, []);

  const shrank = driftFrom(DETAIL_SOURCES.filter(s => s !== 'workday'));
  assert.deepEqual(shrank.missing, []);
  assert.deepEqual(shrank.stale, ['workday'], 'the two directions need different fixes, so they are reported apart');
});

test('a source belongs to exactly one category', () => {
  const seen = new Map();
  for (const [name, list] of [['DETAIL_SOURCES', DETAIL_SOURCES], ['BODY_IN_LIST', BODY_IN_LIST], ['BROWSER_ONLY', BROWSER_ONLY]]) {
    for (const s of list) {
      assert.ok(!seen.has(s), `${s} is in both ${seen.get(s)} and ${name} — "needs a fetch" and "arrives read" cannot both be true`);
      seen.set(s, name);
    }
  }
});

test('READABLE_SOURCES is both server routes and nothing else', () => {
  assert.deepEqual([...READABLE_SOURCES].sort(), [...DETAIL_SOURCES, ...BODY_IN_LIST].sort());
  for (const s of BROWSER_ONLY) {
    assert.ok(!READABLE_SOURCES.includes(s),
      `${s} refuses non-browser requests — counting it as readable is how the coverage tile lies`);
  }
});

test('the sources the store actually carries are all accounted for', () => {
  // The check that would have caught F-445 the day it happened: not "is the
  // list self-consistent" but "does it know about the boards his store is
  // actually full of". amazon-jobs was 21,327 live rows and appeared in none
  // of the three copies.
  const known = new Set([...READABLE_SOURCES, ...BROWSER_ONLY]);
  const BIG_SOURCES = ['workday', 'amazon-jobs', 'ashby', 'greenhouse', 'phenom', 'sitemap-jobs', 'lever', 'smartrecruiters', 'browser-assist'];
  for (const s of BIG_SOURCES) {
    assert.ok(known.has(s), `${s} is one of the largest sources in the store and this module has never heard of it`);
  }
});

test('the lists are sorted, so a diff shows what changed and not where it landed', () => {
  for (const [name, list] of [['DETAIL_SOURCES', DETAIL_SOURCES], ['BODY_IN_LIST', BODY_IN_LIST]]) {
    assert.deepEqual(list, [...list].sort(), `${name} is out of order`);
  }
});

test('serve.mjs and dashboard.html no longer keep their own copies', () => {
  const serve = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  assert.ok(!/const ENRICHABLE_SOURCES = new Set\(\[/.test(serve),
    'serve.mjs has re-grown a private source list — that is F-445 happening again');
  assert.ok(serve.includes("from './detail-sources.mjs'"), 'serve.mjs should import the shared list');

  const dash = readFileSync(path.join(HERE, 'dashboard.html'), 'utf-8');
  assert.ok(dash.includes('window.__JARVIS_SOURCES'),
    'dashboard.html should read the injected list rather than a literal of its own');
});
