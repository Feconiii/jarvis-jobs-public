// F-1033: the scan clock is the last scan's own record, not the server's boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScanDelay } from './scan-clock.mjs';

const H = 3600_000;
const at = (iso) => Date.parse(iso);

test('due six hours after the last scan; the time left before that', () => {
  assert.equal(nextScanDelay({ lastAt: '2026-11-07T05:10:00Z', now: at('2026-11-07T11:10:00Z'), everyMs: 6 * H }), 0);
  assert.equal(nextScanDelay({ lastAt: '2026-11-07T05:10:00Z', now: at('2026-11-07T11:02:00Z'), everyMs: 6 * H }), 8 * 60_000);
  assert.ok(nextScanDelay({ lastAt: '2026-11-06T22:19:00Z', now: at('2026-11-07T11:00:00Z'), everyMs: 6 * H }) < 0, 'overdue');
});

test('no scan on record, or an unreadable one: due now', () => {
  assert.equal(nextScanDelay({ lastAt: null, now: 1, everyMs: 6 * H }), 0);
  assert.equal(nextScanDelay({ lastAt: 'not a date', now: 1, everyMs: 6 * H }), 0);
});

test('tonight\'s case: a boot at 11:02 after a 05:10 scan runs the next one by 11:14, not at 17:02', () => {
  // serve.mjs looks two minutes after boot and every ten minutes after.
  const boot = at('2026-11-07T11:02:00Z');
  const looks = [boot + 2 * 60_000, ...Array.from({ length: 40 }, (_, i) => boot + 2 * 60_000 + (i + 1) * 10 * 60_000)];
  const first = looks.find((t) => nextScanDelay({ lastAt: '2026-11-07T05:10:00Z', now: t, everyMs: 6 * H }) <= 0);
  assert.equal(new Date(first).toISOString(), '2026-11-07T11:14:00.000Z');
});

test('a second restart soon after: still due by the same record (one scan; kickScan refuses a second while one runs)', () => {
  const last = '2026-11-07T05:10:00Z';
  for (const boot of [at('2026-11-07T10:00:00Z'), at('2026-11-07T10:30:00Z'), at('2026-11-07T11:05:00Z')]) {
    const firstLook = boot + 2 * 60_000;
    const wait = nextScanDelay({ lastAt: last, now: firstLook, everyMs: 6 * H });
    assert.equal(new Date(firstLook + Math.max(0, wait)).toISOString(), wait > 0 ? '2026-11-07T11:10:00.000Z' : new Date(firstLook).toISOString());
  }
});

// Code review #3 (2026-11-13).
test('code review #3: only a full scan sets the clock — an assisted import of one page or a --company scan does not', async () => {
  const { lastFullScanAt, isFullScan } = await import('./scan-clock.mjs');
  const full = { at: '2026-11-13T00:07:00Z', full: true, companiesScanned: 3629, perCompany: [{ provider: 'workday' }] };
  const legacyFull = { at: '2026-11-12T16:15:00Z', companiesScanned: 3630, perCompany: [{ provider: 'workday' }, { provider: 'lever' }] };
  const assist = { at: '2026-11-13T04:00:00Z', full: false, companiesScanned: 1, perCompany: [{ provider: 'browser-assist' }] };
  const legacyAssist = { at: '2026-11-13T03:00:00Z', companiesScanned: 1, perCompany: [{ provider: 'browser-assist' }] };
  const oneCompany = { at: '2026-11-13T05:00:00Z', full: false, companiesScanned: 1, perCompany: [{ provider: 'workday' }] };
  assert.deepEqual([full, legacyFull, assist, legacyAssist, oneCompany].map(isFullScan), [true, true, false, false, false]);
  assert.equal(lastFullScanAt([oneCompany, assist, legacyAssist, full, legacyFull]), full.at, 'newest first: the full one under them');
  assert.equal(lastFullScanAt([assist]), null);
  // His case: a full scan at 00:07, an import at 04:00. Due at 06:07, not 10:00.
  assert.equal(nextScanDelay({ lastAt: lastFullScanAt([assist, full]), now: at('2026-11-13T06:07:00Z'), everyMs: 6 * H }), 0);
});

test('code review #3: a scan that died (no record) is retried twice, 30 minutes apart, then waits a whole interval', () => {
  const last = '2026-11-13T00:00:00Z';
  const now0 = at('2026-11-13T06:00:00Z');
  assert.equal(nextScanDelay({ lastAt: last, now: now0, everyMs: 6 * H, tries: [] }), 0, 'due');
  const t1 = '2026-11-13T06:00:00Z';
  assert.equal(nextScanDelay({ lastAt: last, now: at('2026-11-13T06:10:00Z'), everyMs: 6 * H, tries: [t1] }), 20 * 60_000, 'one died: 30 min after it');
  const t2 = '2026-11-13T06:30:00Z', t3 = '2026-11-13T07:00:00Z';
  assert.equal(nextScanDelay({ lastAt: last, now: at('2026-11-13T07:00:00Z'), everyMs: 6 * H, tries: [t1, t2] }), 0, 'two died: the third start is due');
  assert.equal(nextScanDelay({ lastAt: last, now: at('2026-11-13T07:10:00Z'), everyMs: 6 * H, tries: [t1, t2, t3] }), 6 * H - 10 * 60_000, 'three died: six hours after the last');
  // A try older than the record finished: it does not count.
  assert.equal(nextScanDelay({ lastAt: '2026-11-13T06:01:00Z', now: at('2026-11-13T12:01:00Z'), everyMs: 6 * H, tries: [t1] }), 0);
  // No record at all and three dead tries: still capped.
  assert.ok(nextScanDelay({ lastAt: null, now: at('2026-11-13T07:10:00Z'), everyMs: 6 * H, tries: [t1, t2, t3] }) > 0);
});

test('code review #3: the server reads the last FULL scan and counts its own starts; the records say which are full', async () => {
  const { readFileSync } = await import('node:fs');
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const serve = src('./serve.mjs');
  const body = serve.slice(serve.indexOf('const scanIfDue = () =>'), serve.indexOf('setTimeout(scanIfDue'));
  assert.match(body, /lastFullScanRecordAt\(\)/, 'the clock is the last full scan');
  // week-fixes J3: the store answers in SQL; twenty ~700 KB records are not
  // parsed every ten minutes (F-1025).
  assert.doesNotMatch(body, /getScans\(/, 'no scan record is parsed to find it');
  assert.doesNotMatch(body, /getScans\(1\)\?\.\[0\]/, 'not whatever record came last');
  assert.match(body, /tries: scanTries/);
  assert.match(serve, /at: new Date\(\)\.toISOString\(\), full: false, companiesScanned: 1/, 'the page import says it is not a full scan');
  assert.match(src('./import-assist.mjs'), /full: false/);
  assert.match(src('./scan.mjs'), /full: !filterCompany && !filterTier && !filterProvider && !knownBefore/);
});
