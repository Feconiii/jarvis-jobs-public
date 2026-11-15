import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhen, parseWindow, addSchedule, takeDue, sendableSchedule, cancelSchedule, recordResult, listSchedules, anyWaiting, touchSchedule, GRACE_MS, STALLED_MS, MAX_ROLLS, QUIET_MS, MAX_REOPENS, everScheduled, scheduleAccepted, catchUpOwed } from './outreach-schedule.mjs';

const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'sched-')), 's.json');
// Saturday 2026-10-24, 3:00 PM local.
const SAT = new Date(2026, 9, 24, 15, 0);
const at = (d) => [d.getDay(), d.getDate(), d.getHours(), d.getMinutes()];
const hrs = (w) => [w.at.getDay(), w.at.getHours(), w.until.getHours(), w.until.getMinutes()];

test('his words become a local time', () => {
  assert.deepEqual(at(parseWhen('tue 9am', SAT)), [2, 27, 9, 0]);
  assert.deepEqual(at(parseWhen('Tuesday at 8:30', SAT)), [2, 27, 8, 30]);
  assert.deepEqual(at(parseWhen('tomorrow 9', SAT)), [0, 25, 9, 0]);
  assert.deepEqual(at(parseWhen('9am', SAT)), [0, 25, 9, 0], 'a bare time already past today is tomorrow');
  assert.deepEqual(at(parseWhen('sat 2pm', SAT)), [6, 31, 14, 0], 'this weekday, already past: next week');
  assert.deepEqual(at(parseWhen('mon 3', SAT)), [1, 26, 15, 0], 'a bare 1-7 means the afternoon');
  assert.deepEqual(at(parseWhen('2026-10-27 09:00', SAT)), [2, 27, 9, 0]);
  assert.equal(parseWhen('whenever', SAT), null);
  assert.equal(parseWhen('tue 25:00', SAT), null);
});

test('his words become a window ("11am to 1pm")', () => {
  assert.deepEqual(hrs(parseWindow('tue 11am-1pm', SAT)), [2, 11, 13, 0]);
  assert.deepEqual(hrs(parseWindow('tue 11 to 1', SAT)), [2, 11, 13, 0]);
  assert.deepEqual(hrs(parseWindow('tomorrow 9:30am–11', SAT)), [0, 9, 11, 0]);
  assert.deepEqual(hrs(parseWindow('2026-10-27 11:00-13:30', SAT)), [2, 11, 13, 30]);
  assert.deepEqual(hrs(parseWindow('wed 10am', SAT)), [3, 10, 12, 0], 'one time: two hours from it');
  assert.equal(parseWindow('tue 1pm-11am', SAT), null);
});

test('several days: "11 to 2 pm, monday tuesday wednesday thursday" (2026-10-26)', () => {
  const MON_1AM = new Date(2026, 9, 26, 0, 50);
  for (const words of ['mon-thu 11am-2pm', 'monday tuesday wednesday thursday 11 to 2pm', 'mon, tue, wed, thu 11am-2pm', 'mon thru thu 11-2']) {
    const w = parseWindow(words, MON_1AM);
    assert.deepEqual([...at(w.at), w.until.getHours()], [1, 26, 11, 0, 14], words);
    assert.deepEqual(w.days, [1, 2, 3, 4], words);
  }
  const fri = parseWindow('mon-thu 11am-2pm', new Date(2026, 9, 30, 9, 0));
  assert.deepEqual(at(fri.at), [1, 2, 11, 0], 'asked on a Friday: the next Monday');
  assert.deepEqual(at(parseWindow('mon-thu 11am-2pm', new Date(2026, 9, 26, 12, 0)).at), [1, 26, 11, 0], 'inside today\'s window: today');
  assert.deepEqual(at(parseWindow('mon-thu 11am-2pm', new Date(2026, 9, 29, 15, 0)).at), [1, 2, 11, 0], 'Thursday after the window: Monday');
  assert.deepEqual(parseWindow('weekdays 9-11', SAT).days, [1, 2, 3, 4, 5]);
  assert.equal(parseWindow('tue 11am-1pm', SAT).days, undefined, 'one day is still one window');
});

test('a second list for the same window joins the first (one send session at a time)', () => {
  const file = tmp();
  const w = { at: new Date(2026, 9, 26, 10), until: new Date(2026, 9, 26, 16), days: [1, 2, 3, 4], file, now: +new Date(2026, 9, 26, 1) };
  const a = addSchedule({ ...w, people: [{ id: 'm', name: 'Chris' }] });
  const b = addSchedule({ ...w, people: [{ id: 's', name: 'Sarah' }, { id: 'm', name: 'Chris' }] });
  assert.equal(a.id, b.id);
  assert.deepEqual(listSchedules({ file, active: true }).map((s) => s.names), [['Chris', 'Sarah']]);
  const c = addSchedule({ ...w, at: new Date(2026, 9, 26, 11), people: [{ id: 't', name: 'Taylor' }] });
  assert.notEqual(c.id, a.id, 'another window stays its own');
});

test('a missed window moves only to his days: Thursday off → next Monday, never Friday', () => {
  const file = tmp();
  addSchedule({ at: new Date(2026, 9, 29, 11), until: new Date(2026, 9, 29, 14), days: [1, 2, 3, 4], people: [{ id: 'a', name: 'A' }], file, now: +new Date(2026, 9, 29, 1) });
  assert.deepEqual(takeDue({ file, now: +new Date(2026, 9, 30, 12) }), [], 'Friday noon: not his day');
  const due = takeDue({ file, now: +new Date(2026, 10, 2, 11, 30) });
  assert.equal(due.length, 1);
  assert.deepEqual(at(new Date(due[0].at)), [1, 2, 11, 0]);
});

test('sent the first moment inside the window, once; never before or after it', () => {
  const file = tmp();
  const now = Date.parse('2026-10-26T16:00:00Z');
  const s = addSchedule({ at: new Date(now + 3600e3), until: new Date(now + 3 * 3600e3), people: [{ id: 'c1', name: 'Dana Lee' }], file, now });
  assert.deepEqual([s.ids, s.names, s.status], [['c1'], ['Dana Lee'], 'scheduled']);
  assert.ok(anyWaiting({ file }));
  assert.deepEqual(takeDue({ file, now }), [], 'before the window');
  assert.equal(sendableSchedule(s.id, { file, now }), null);
  const inside = now + 2.5 * 3600e3;               // the laptop came on late in the window
  assert.equal(takeDue({ file, now: inside }).length, 1);
  assert.equal(takeDue({ file, now: inside + 30e3 }).length, 0, 'opened once');
  assert.ok(sendableSchedule(s.id, { file, now: inside }));
  assert.ok(sendableSchedule(s.id, { file, now: now + 3 * 3600e3 + GRACE_MS - 1 }), 'a pass started in the window may finish');
  assert.equal(sendableSchedule(s.id, { file, now: now + 3 * 3600e3 + GRACE_MS + 60e3 }), null);
  recordResult(s.id, { sent: ['Dana Lee'], left: [] }, { file, now: inside });
  assert.equal(sendableSchedule(s.id, { file, now: inside }), null, 'a finished schedule cannot be run again');
  assert.equal(listSchedules({ file })[0].status, 'done');
  assert.equal(anyWaiting({ file }), false);
});

test('a window the laptop was off for moves to the same hours on the next weekday', () => {
  const file = tmp();
  // Friday 2026-10-30, 11:00-13:00 local.
  const from = new Date(2026, 9, 30, 11, 0), to = new Date(2026, 9, 30, 13, 0);
  const s = addSchedule({ at: from, until: to, people: [{ id: 'c1', name: 'Dana Lee' }], file, now: +from - 3600e3 });
  const monEvening = +new Date(2026, 10, 2, 18, 0);  // laptop first on Monday evening
  assert.deepEqual(takeDue({ file, now: monEvening }), []);
  const after = listSchedules({ file })[0];
  assert.deepEqual([new Date(after.at).getDay(), new Date(after.at).getDate(), new Date(after.at).getHours(), after.status], [2, 3, 11, 'scheduled'], 'Tuesday 11am, weekends skipped');
  assert.equal(takeDue({ file, now: +new Date(2026, 10, 3, 12, 15) }).length, 1, 'sent inside Tuesday\'s window');
  assert.ok(sendableSchedule(s.id, { file, now: +new Date(2026, 10, 3, 12, 15) }));
});

test(`after ${MAX_ROLLS} moved windows it is missed; an opened send that never reported is tried again`, () => {
  const file = tmp();
  const from = new Date(2026, 9, 26, 11, 0), to = new Date(2026, 9, 26, 13, 0);
  addSchedule({ at: from, until: to, people: [{ id: 'c1', name: 'A' }], file, now: +from - 60e3 });
  takeDue({ file, now: +new Date(2026, 11, 1, 18, 0) });
  assert.equal(listSchedules({ file })[0].status, 'missed');

  const f2 = tmp();
  const s = addSchedule({ at: from, until: to, people: [{ id: 'c1', name: 'A' }], file: f2, now: +from - 60e3 });
  assert.equal(takeDue({ file: f2, now: +from + 60e3 }).length, 1);
  takeDue({ file: f2, now: +to + STALLED_MS + 60e3 });
  const again = listSchedules({ file: f2 })[0];
  assert.equal(again.status, 'scheduled');
  assert.equal(new Date(again.at).getDate(), 27);
  assert.equal(sendableSchedule(s.id, { file: f2, now: +to + STALLED_MS + 60e3 }), null);
});

test('cancel, a finished window and an empty list are refused or undone', () => {
  const file = tmp();
  const now = Date.parse('2026-10-26T16:00:00Z');
  assert.throws(() => addSchedule({ at: new Date(now - 3 * 3600e3), until: new Date(now - 3600e3), people: [{ id: 'c1', name: 'A' }], file, now }), /over/);
  assert.throws(() => addSchedule({ at: new Date(now + 3600e3), people: [], file, now }), /nothing waiting/);
  const s = addSchedule({ at: new Date(now + 3600e3), people: [{ id: 'c1', name: 'A' }], file, now });
  assert.equal(cancelSchedule(s.id, { file }).length, 1);
  assert.deepEqual(takeDue({ file, now: now + 2 * 3600e3 }), [], 'a cancelled schedule never opens');
});

test('CONNECT schedules keep their kind and never merge with a message schedule in the same window', () => {
  const file = tmp();
  const w = { at: new Date(2026, 9, 26, 10), until: new Date(2026, 9, 26, 16), days: [1, 2, 3, 4] };
  const now = +new Date(2026, 9, 26, 9);
  const m = addSchedule({ ...w, people: [{ id: 'a', name: 'A' }], file, now });
  const c = addSchedule({ ...w, people: [{ id: 'b', name: 'B' }], kind: 'connect', file, now });
  assert.notEqual(m.id, c.id);
  assert.equal(c.kind, 'connect');
  assert.equal(m.kind, undefined);
  const c2 = addSchedule({ ...w, people: [{ id: 'd', name: 'D' }], kind: 'connect', file, now });
  assert.equal(c2.id, c.id, 'connect joins connect');
  assert.deepEqual(c2.ids, ['b', 'd']);
});

test('one session at a time: a schedule due while another runs waits for its report', () => {
  const file = tmp();
  const w = { at: new Date(2026, 9, 26, 10), until: new Date(2026, 9, 26, 16), days: [1, 2, 3, 4] };
  const m = addSchedule({ ...w, people: [{ id: 'a', name: 'A' }], file, now: +new Date(2026, 9, 26, 9) });
  const c = addSchedule({ ...w, people: [{ id: 'b', name: 'B' }], kind: 'connect', file, now: +new Date(2026, 9, 26, 9) });
  const t1 = +new Date(2026, 9, 26, 10, 1);
  const first = takeDue({ file, now: t1 });
  assert.equal(first.length, 1, 'only one opens');
  assert.equal(takeDue({ file, now: t1 + 60e3 }).length, 0, 'the other waits while the first runs');
  recordResult(first[0].id, { sent: ['A'] }, { file, now: t1 + 5 * 60e3 });
  const second = takeDue({ file, now: t1 + 6 * 60e3 });
  assert.deepEqual(second.map((s) => s.id), [first[0].id === c.id ? m.id : c.id], 'the other opens once the first reported');
});

test('after an accept: a random 30-40 min wait, only inside his window, never 10:00 sharp', async () => {
  const { afterAcceptWindow } = await import('./outreach-schedule.mjs');
  const min = (d) => d.getHours() * 60 + d.getMinutes();
  // Tue 2026-10-27, accepted 11:00 -> 11:30..11:40 the same day.
  const acc = new Date(2026, 9, 27, 11, 0);
  for (const r of [0, 0.5, 0.999]) {
    const w = afterAcceptWindow({ acceptedAt: acc, now: acc, rand: () => r });
    assert.equal(w.at.getDate(), 27);
    assert.ok(min(w.at) >= 11 * 60 + 30 && min(w.at) <= 11 * 60 + 40, `r=${r}: ${w.at}`);
    assert.equal(w.until.getHours(), 16);
  }
  // Accepted 3:45 pm -> past 4 pm, so Wednesday 10:00-10:40.
  const late = afterAcceptWindow({ acceptedAt: new Date(2026, 9, 27, 15, 45), now: new Date(2026, 9, 27, 15, 45), rand: () => 0.5 });
  assert.equal(late.at.getDate(), 28);
  assert.equal(min(late.at), 10 * 60 + 20);
  // Accepted Thursday evening -> Monday's window (his days only).
  const thu = afterAcceptWindow({ acceptedAt: new Date(2026, 9, 29, 20, 0), now: new Date(2026, 9, 29, 20, 0), rand: () => 0.25 });
  assert.equal(thu.at.getDay(), 1);
  assert.equal(min(thu.at), 10 * 60 + 10);
  // The email arrived late (accepted 2 h ago): no older than now, a minute out.
  const now = new Date(2026, 9, 27, 13, 0);
  const lag = afterAcceptWindow({ acceptedAt: new Date(2026, 9, 27, 11, 0), now, rand: () => 0.5 });
  assert.ok(+lag.at >= +now + 60e3 - 1);
});

test('a launched session that goes quiet is opened again, at most twice; one showing life is left alone (F-938)', () => {
  const file = tmp();
  const w = { at: new Date(2026, 9, 27, 10), until: new Date(2026, 9, 27, 16), days: [1, 2, 3, 4] };
  const s = addSchedule({ ...w, people: [{ id: 'a', name: 'A' }], kind: 'connect', file, now: +new Date(2026, 9, 27, 9) });
  const t1 = +new Date(2026, 9, 27, 11, 19);
  assert.equal(takeDue({ file, now: t1 }).length, 1, 'opened');
  assert.equal(takeDue({ file, now: t1 + QUIET_MS - 60e3 }).length, 0, 'not yet quiet');
  touchSchedule({ contactId: 'a' }, { file, now: t1 + 10 * 60e3 });
  assert.equal(takeDue({ file, now: t1 + 20 * 60e3 }).length, 0, 'a mark 10 min in counts as life');
  const again = takeDue({ file, now: t1 + 26 * 60e3 });
  assert.deepEqual(again.map((x) => x.id), [s.id], 'quiet for 16 min: opened again');
  takeDue({ file, now: t1 + 42 * 60e3 });
  assert.equal(takeDue({ file, now: t1 + 60 * 60e3 }).length, 0, `no more than ${MAX_REOPENS} re-opens`);
  assert.equal(listSchedules({ file }).find((x) => x.id === s.id).reopens, MAX_REOPENS);
});

test('an accepted invitation whose scheduling failed is owed, and the next sync schedules it (F-951)', async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'oas-')), 's.json');
  const now = new Date('2026-11-02T18:00:00Z');   // a Monday, 10:00 Pacific
  const owed = () => [{ id: 'a', name: 'Ana Ruiz', at: '2026-11-02T17:00:00Z' }, { id: 'b', name: 'Ben Ito', at: '2026-11-02T17:05:00Z' }];
  const logs = [];
  const queue = async () => ({ people: [{ id: 'a', name: 'Ana Ruiz' }, { id: 'b', name: 'Ben Ito' }] });
  // First sync: adding Ana's schedule throws; Ben is still scheduled.
  let n = 0;
  const flaky = (o) => { n += 1; if (n === 1) throw new Error('disk full'); return addSchedule({ ...o, file }); };
  const first = await catchUpOwed({ owed, scheduled: () => everScheduled({ file }), schedule: (p) => scheduleAccepted(p, { queue, add: flaky, log: (l) => logs.push(l), now }) });
  assert.deepEqual(first.flatMap((s) => s.ids), ['b'], 'one failure never skips the rest');
  assert.ok(logs.some((l) => /Ana Ruiz: not scheduled \(disk full\)/.test(l)));
  // Next sync: only Ana, who was never scheduled.
  const asked = [];
  const second = await catchUpOwed({ owed, scheduled: () => everScheduled({ file }), schedule: (p) => { asked.push(...p.map((x) => x.id)); return scheduleAccepted(p, { queue, add: (o) => addSchedule({ ...o, file }), log: () => {}, now }); } });
  assert.deepEqual(asked, ['a'], 'Ben is not scheduled twice');
  assert.equal(second.length, 1);
  assert.deepEqual([...everScheduled({ file })].sort(), ['a', 'b']);
  // A third sync has nobody owed.
  assert.deepEqual(await catchUpOwed({ owed, scheduled: () => everScheduled({ file }), schedule: () => { throw new Error('should not run'); } }), []);
});

test('a send queue that cannot be read schedules nobody and throws nothing (F-951)', async () => {
  const logs = [];
  const r = await scheduleAccepted([{ id: 'a', name: 'Ana Ruiz', at: '2026-11-02T17:00:00Z' }], { queue: async () => { throw new Error('resume lookup failed'); }, log: (l) => logs.push(l) });
  assert.deepEqual(r, []);
  assert.match(logs[0], /could not read the send queue/);
});
