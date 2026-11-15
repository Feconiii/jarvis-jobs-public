import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, reserve, readHistory, CAPS, MIN_GAP_MS, JITTER_MS, MAX_WAIT_MS } from './linkedin-mcp-guard.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOON = new Date(2026, 9, 23, 12, 0, 0).getTime();
const calls = (n, tool, startMs) => Array.from({ length: n }, (_, i) => ({ at: startMs + i * 60_000, tool }));
const noJitter = () => 0;

test('writing and bulk tools are refused whatever the history', () => {
  for (const t of ['send_message', 'connect_with_person', 'get_company_employees', 'get_sidebar_profiles', 'get_feed']) {
    const v = decide([], t, NOON);
    assert.equal(v.allow, false, t);
    assert.match(v.reason, /Refused/);
  }
});

test('read tools pass on an empty day', () => {
  for (const t of ['search_posts', 'search_people', 'get_person_profile', 'get_inbox', 'get_conversation']) {
    assert.equal(decide([], t, NOON).allow, true, t);
  }
});

test('no daily cap since 2026-10-26: a busy day still passes', () => {
  assert.deepEqual(CAPS, {});
  const hist = calls(200, 'search_people', NOON - 200 * 60_000);
  assert.equal(decide(hist, 'search_people', NOON).allow, true);
  assert.equal(decide(hist, 'get_person_profile', NOON).allow, true);
});

test('calls are spaced at least the minimum gap apart', () => {
  const v = decide([{ at: NOON - 5_000, tool: 'search_posts' }], 'search_posts', NOON, noJitter);
  assert.equal(v.allow, true);
  assert.equal(v.waitMs, MIN_GAP_MS - 5_000);
  const later = decide([{ at: NOON - 120_000, tool: 'search_posts' }], 'search_posts', NOON, noJitter);
  assert.equal(later.waitMs, 0);
});

test('close_session is free: no cap, no wait', () => {
  const hist = calls(CAPS.total, 'search_posts', NOON - 10_000);
  const v = decide(hist, 'close_session', NOON);
  assert.equal(v.allow, true);
  assert.equal(v.waitMs, 0);
});

test('a tool not on the read-only list is refused, even one never named (F-951)', () => {
  for (const t of ['send_invitation', 'comment_on_post', 'react_to_post', 'follow_company', 'anything_new']) {
    const v = decide([], t, NOON);
    assert.equal(v.allow, false, t);
    assert.match(v.reason, /read-only list/);
  }
});

test('parallel calls each take their own turn: 20-30 s apart, not all at once (F-951)', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'liguard-')), 'usage.jsonl');
  const t = NOON;
  const got = await Promise.all(['get_person_profile', 'get_person_profile', 'search_posts', 'get_person_profile']
    .map((tool) => reserve(tool, { username: 'x' }, { file, now: () => t, rand: noJitter })));
  const waits = got.map((v) => v.waitMs).sort((a, b) => a - b);
  assert.deepEqual(waits, [0, MIN_GAP_MS, 2 * MIN_GAP_MS, 3 * MIN_GAP_MS], 'each later call waits one more gap');
  assert.equal(readHistory(file).length, 4, 'every turn written before its wait');
});

test('a queue past the hook timeout is refused, never let through unspaced (F-951)', () => {
  const hist = [{ at: NOON + MAX_WAIT_MS, tool: 'search_posts' }];
  const v = decide(hist, 'search_posts', NOON, noJitter);
  assert.equal(v.allow, false);
  assert.match(v.reason, /one at a time/);
  assert.ok(MAX_WAIT_MS + MIN_GAP_MS + JITTER_MS < 600_000, 'shorter than the hook timeout');
});
