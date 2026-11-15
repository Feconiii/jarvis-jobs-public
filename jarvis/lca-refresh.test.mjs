// jarvis/lca-refresh.test.mjs — the H-1B record kept current (F-984).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel, newerFile, nextDue, staleNotice } from './lca-refresh.mjs';

test('a disclosure file names its fiscal year and quarter', () => {
  assert.deepEqual(parseLabel('LCA_Disclosure_Data_FY2026_Q3.xlsx'), { fy: 2026, q: 3 });
  assert.equal(parseLabel('resume.pdf'), null);
});

test('only a newer quarter is imported; an older one would move employers backwards', () => {
  const files = ['C:/d/LCA_Disclosure_Data_FY2026_Q2.xlsx', 'C:/d/LCA_Disclosure_Data_FY2026_Q4.xlsx', 'C:/d/LCA_Disclosure_Data_FY2027_Q1.xlsx'];
  assert.equal(newerFile(files, { fy: 2026, q: 3 }), 'C:/d/LCA_Disclosure_Data_FY2027_Q1.xlsx');
  assert.equal(newerFile(['C:/d/LCA_Disclosure_Data_FY2026_Q3.xlsx'], { fy: 2026, q: 3 }), null);
  assert.equal(newerFile(files, null), 'C:/d/LCA_Disclosure_Data_FY2027_Q1.xlsx');
});

test('the next quarter is due about 75 days after it ends (the fiscal year starts in October)', () => {
  const n = nextDue({ fy: 2026, q: 3 });
  assert.equal(n.label, 'FY2026 Q4');
  assert.equal(n.due.toISOString().slice(0, 10), '2026-12-14');   // Sep 30 + 75
  assert.equal(nextDue({ fy: 2026, q: 4 }).label, 'FY2027 Q1');
  assert.equal(nextDue({ fy: 2026, q: 4 }).due.toISOString().slice(0, 10), '2027-03-16');   // Dec 31 + 75
});

test('stale only once the next quarter is overdue', () => {
  assert.equal(staleNotice({ fy: 2026, q: 3 }, new Date('2026-11-04T12:00:00Z')), null);
  assert.match(staleNotice({ fy: 2026, q: 3 }, new Date('2026-12-20T12:00:00Z')), /FY2026 Q3; FY2026 Q4 was due 2026-12-14/);
  assert.equal(staleNotice(null), null);
});

test('an import waits when the laptop is short of memory (the xlsx reader holds the shared strings whole)', async () => {
  const { enoughMemory, MIN_FREE_MB } = await import('./lca-refresh.mjs');
  assert.equal(enoughMemory(500 * 1048576), false);
  assert.equal(enoughMemory((MIN_FREE_MB + 1) * 1048576), true);
});
