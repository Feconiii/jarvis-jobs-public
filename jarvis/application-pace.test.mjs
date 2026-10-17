import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paceOf, localDay } from './application-pace.mjs';

test('the pace counts confirmed applications by his local day', () => {
  const now = new Date(2026, 9, 16, 3, 0);   // Oct 16, 03:00 local
  const day = (k) => { const d = new Date(now); d.setHours(12); d.setDate(d.getDate() - k); return localDay(d); };
  const apps = [
    ...Array(3).fill(0).map(() => ({ day: day(0) })),   // today
    ...Array(2).fill(0).map(() => ({ day: day(1) })),   // yesterday
    { day: day(5) },
    ...Array(7).fill(0).map(() => ({ day: day(9) })),   // the week before
  ];
  const p = paceOf(apps, now);
  assert.equal(p.today, 3);
  assert.equal(p.last7, 6);
  assert.equal(p.perDay7, 0.9);
  assert.equal(p.prev7, 7);
  assert.equal(p.perDayPrev7, 1);
  assert.equal(p.streak, 2, 'today and yesterday');
  assert.equal(p.daysSinceLast, 0);
  assert.equal(p.days.length, 14);
  assert.equal(p.days.at(-1).n, 3);
});

test('a streak is not broken before today is over', () => {
  const now = new Date(2026, 9, 16, 9, 0);
  const d1 = new Date(now); d1.setDate(d1.getDate() - 1);
  const d2 = new Date(now); d2.setDate(d2.getDate() - 2);
  const p = paceOf([{ day: localDay(d1) }, { day: localDay(d2) }], now);
  assert.equal(p.today, 0);
  assert.equal(p.streak, 2);
  assert.equal(p.daysSinceLast, 1);
});
