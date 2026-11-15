/**
 * SCHEDULED SEND (2026-10-24).
 *
 * "can we schedule send it? thats probably the most annoying thing timing",
 * then "it should send within time frame for example 11am to 1pm, and any time
 * within that that laptop is on it sends it, coz i might not always have laptop
 * on". LinkedIn has no scheduled send, so Jarvis keeps a WINDOW. He finalizes
 * the messages with Claude and picks one ("tue 11am-1pm"); the list of people
 * is FROZEN then: a message saved later is not in it. The first moment inside
 * the window that the dashboard server is running (the laptop is on; the
 * Windows task "Jarvis outreach send" starts the server at login and every 15
 * minutes while a schedule waits), it opens the Outreach tab in his Chrome with
 * ?send=schedule:<id>. The extension asks the server for that schedule's
 * people, fills a tab each, and because the server says this session is due,
 * presses Send on each one whose checks all pass (addressed to that person,
 * subject and text are the saved ones, resume attached, not already in the
 * thread), a minute or two apart. Anything that fails a check stays filled.
 *
 * A window the laptop was off for moves to the same hours on the next weekday,
 * up to MAX_ROLLS times, then it is marked missed. Never sent outside a window.
 *
 * The server is the only authority: a page that opens ?send=schedule:x for a
 * schedule that is not due gets an ordinary session, where he presses Send.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEDULE_FILE = path.join(ROOT, 'data', 'jarvis', 'outreach-schedule.json');
export const GRACE_MS = 30 * 60e3;        // a pass started inside the window may finish this far past its end
export const STALLED_MS = 60 * 60e3;      // opened, never reported back: tried again in the next window
export const MAX_ROLLS = 5;
export const BUSY_MS = 45 * 60e3;         // a launched session that has not reported holds the next one back this long
export const QUIET_MS = 15 * 60e3;        // launched, no sign of life this long: Chrome is opened on it again (F-938)
export const MAX_REOPENS = 2;
const DEFAULT_SPAN_MS = 2 * 3600e3;

function load(file = SCHEDULE_FILE) {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(j.items) ? j : { items: [] }; } catch { return { items: [] }; }
}
function save(state, file = SCHEDULE_FILE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}
const endOf = (s) => Date.parse(s.until || s.at) || Date.parse(s.at) + DEFAULT_SPAN_MS;

/** Every schedule, newest first; `active` = still to happen. */
export function listSchedules({ file, active = false } = {}) {
  const items = load(file).items.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return active ? items.filter((s) => s.status === 'scheduled' || s.status === 'launched') : items;
}

export function addSchedule({ at, until, days = null, people, kind = 'message', file, now = Date.now() }) {
  const from = at instanceof Date ? at : new Date(at);
  const to = until ? (until instanceof Date ? until : new Date(until)) : new Date(+from + DEFAULT_SPAN_MS);
  if (Number.isNaN(+from) || Number.isNaN(+to)) throw new Error('that time could not be read');
  if (+to <= +from) throw new Error('the window ends before it starts');
  if (+to < now) throw new Error('that window is already over');
  if (!people?.length) throw new Error('nothing waiting to send');
  const state = load(file);
  // SAME WINDOW, ONE SCHEDULE (2026-10-26): the extension runs one send
  // session at a time, so a second schedule opening the same minute was turned
  // away and slipped a whole day. A new list for a window already waiting
  // joins it instead.
  const same = state.items.find((s) => s.status === 'scheduled' && s.at === from.toISOString() && endOf(s) === +to
    && (s.kind || 'message') === kind
    && JSON.stringify(s.days || null) === JSON.stringify(Array.isArray(days) && days.length ? days : null));
  if (same) {
    for (const p of people) if (!same.ids.includes(p.id)) { same.ids.push(p.id); same.names.push(p.name); }
    save(state, file);
    return same;
  }
  const item = {
    id: randomBytes(5).toString('hex'),
    at: from.toISOString(),
    until: to.toISOString(),
    ids: people.map((p) => p.id),
    names: people.map((p) => p.name),
    ...(Array.isArray(days) && days.length ? { days } : {}),
    // 'connect' (2026-10-26): invitations with his note, no message.
    ...(kind === 'connect' ? { kind } : {}),
    status: 'scheduled',
    rolls: 0,
    createdAt: new Date(now).toISOString(),
  };
  state.items.push(item);
  save(state, file);
  return item;
}

export function cancelSchedule(id, { file } = {}) {
  const state = load(file);
  const hits = state.items.filter((s) => (id ? s.id === id : true) && s.status === 'scheduled');
  for (const s of hits) s.status = 'cancelled';
  if (hits.length) save(state, file);
  return hits;
}

/** The same hours on the next allowed day: his days ("mon-thu"), else the next weekday. */
function nextWeekday(s) {
  const a = new Date(s.at), u = new Date(endOf(s));
  const ok = (d) => (Array.isArray(s.days) && s.days.length ? s.days.includes(d) : d !== 0 && d !== 6);
  do { a.setDate(a.getDate() + 1); u.setDate(u.getDate() + 1); } while (!ok(a.getDay()));
  s.at = a.toISOString();
  s.until = u.toISOString();
}

/**
 * The schedules whose window is open now, marked launched (so each opens once
 * per window). A window that passed with the laptop off moves to the next
 * weekday; one opened but never reported back is tried again the same way.
 */
export function takeDue({ file, now = Date.now() } = {}) {
  const state = load(file);
  const due = [];
  let changed = false;
  for (const s of state.items) {
    if (s.status === 'launched' && !s.doneAt && now > endOf(s) + STALLED_MS) {
      s.status = 'scheduled';
      s.note = 'Chrome was opened but the send never reported back; trying the next window';
      changed = true;
    }
    // A SESSION THAT WENT QUIET IS OPENED AGAIN (F-938; 2026-10-27 the 11:19
    // run sat "launched" 30 min with nothing sent, and re-opening its link by
    // hand started it). A session still working turns the second one away.
    if (s.status === 'launched' && !s.doneAt && now <= endOf(s) && (s.reopens || 0) < MAX_REOPENS
      && now - Math.max(Date.parse(s.launchedAt || 0), Date.parse(s.activeAt || 0), Date.parse(s.reopenedAt || 0)) > QUIET_MS) {
      s.reopens = (s.reopens || 0) + 1;
      s.reopenedAt = new Date(now).toISOString();
      changed = true;
      due.push(s);
      continue;
    }
    if (s.status !== 'scheduled') continue;
    while (now > endOf(s) && s.status === 'scheduled') {
      changed = true;
      s.rolls = (s.rolls || 0) + 1;
      if (s.rolls > MAX_ROLLS) { s.status = 'missed'; s.note = `the laptop was off during ${MAX_ROLLS + 1} windows in a row; nothing was sent`; break; }
      nextWeekday(s);
      s.note = 'the laptop was off during the window; moved to the next weekday';
    }
    if (s.status !== 'scheduled' || now < Date.parse(s.at)) continue;
    // ONE SESSION AT A TIME: the extension turns a second one away, so a
    // schedule due while another runs waits for it to report (or 45 min).
    if (state.items.some((o) => o !== s && o.status === 'launched' && !o.doneAt && now - Date.parse(o.launchedAt || 0) < BUSY_MS)) continue;
    changed = true;
    s.status = 'launched';
    s.launchedAt = new Date(now).toISOString();
    due.push(s);
  }
  if (changed) save(state, file);
  return due;
}

/**
 * A sign of life from a launched session: its queue was fetched, or one of its
 * people was marked. `contactId` finds the schedule holding that person.
 */
export function touchSchedule({ id = '', contactId = '' } = {}, { file, now = Date.now() } = {}) {
  const state = load(file);
  let changed = false;
  for (const s of state.items) {
    if (s.status !== 'launched' || s.doneAt) continue;
    if ((id && s.id === id) || (contactId && (s.ids || []).includes(contactId))) { s.activeAt = new Date(now).toISOString(); changed = true; }
  }
  if (changed) save(state, file);
  return changed;
}

/**
 * Every contact id a message schedule has ever held, whatever became of it
 * (F-951): the after-accept catch-up schedules only people never scheduled, so
 * a session that left someone for him never brings them back on its own.
 */
export function everScheduled({ file } = {}) {
  return new Set(load(file).items.filter((s) => (s.kind || 'message') === 'message').flatMap((s) => s.ids || []));
}

/**
 * Each accepted person's saved message into its after-accept window. One
 * person's failure never skips the rest, and whoever fails stays owed: the
 * next catch-up finds them, because they were never scheduled (F-951).
 * `queue(names, { pdf: false })` → { people: [{ id, … }] } (serve.mjs).
 */
export async function scheduleAccepted(people, { queue, window = 'mon-thu 10am-4pm', add = addSchedule, log = console.log, now = new Date() } = {}) {
  let q = { people: [] };
  try { q = await queue(people.map((p) => String(p.name).toLowerCase()), { pdf: false }); } catch (e) { log(`  accepted → could not read the send queue (${e?.message || e}); tried again next sync`); return []; }
  const items = [];
  for (const p of people) {
    try {
      const ready = q.people.filter((r) => r.id === p.id);
      if (!ready.length) { log(`  accepted → ${p.name}: no saved message with a resume to send yet`); continue; }
      const win = afterAcceptWindow({ acceptedAt: p.at, window, now });
      if (!win) continue;
      const item = add({ at: win.at, until: win.until, days: win.days, people: ready, now: +now });
      log(`  accepted → ${p.name}: message scheduled ${whenLabel(item.at, item.until)}`);
      items.push(item);
    } catch (e) { log(`  accepted → ${p.name}: not scheduled (${e?.message || e}); tried again next sync`); }
  }
  return items;
}

/** The owed (accepted, unsent) who were never in a message schedule, scheduled. */
export async function catchUpOwed({ owed, schedule, scheduled = everScheduled } = {}) {
  const have = scheduled();
  const people = owed().filter((p) => !have.has(p.id));
  return people.length ? schedule(people) : [];
}

/** Is a schedule waiting at all (the Windows task starts the server only then)? */
export function anyWaiting({ file } = {}) {
  return load(file).items.some((s) => s.status === 'scheduled' || (s.status === 'launched' && !s.doneAt));
}

/** The schedule a send session may press Send for: launched, inside its window (plus grace). */
export function sendableSchedule(id, { file, now = Date.now() } = {}) {
  const s = load(file).items.find((x) => x.id === id);
  if (!s || s.status !== 'launched') return null;
  if (now < Date.parse(s.at) || now > endOf(s) + GRACE_MS) return null;
  return s;
}

export function recordResult(id, result = {}, { file, now = Date.now() } = {}) {
  const state = load(file);
  const s = state.items.find((x) => x.id === id);
  if (!s) return null;
  s.status = 'done';
  s.doneAt = new Date(now).toISOString();
  s.sent = (result.sent || []).map(String);
  s.left = (result.left || []).map((l) => ({ name: String(l.name || ''), note: String(l.note || '') }));
  s.note = result.note ? String(result.note) : '';
  save(state, file);
  return s;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * His words to a local time: "tue 9am", "tuesday at 8:30", "tomorrow 9",
 * "today 4pm", "9am" (the next 9am), "2026-10-27 09:00". Null when unreadable.
 */
export function parseWhen(text, now = new Date()) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]);
  const m = t.match(/^(?:(today|tomorrow|tmrw|sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,? ?(?:at )?)?(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)?$/);
  if (!m) return null;
  let h = +m[2];
  const min = m[3] ? +m[3] : 0;
  if (h > 23 || min > 59) return null;
  const ap = m[4]?.[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  // No am/pm on a bare hour from 1 to 7: he means the afternoon (nobody sends at 3 am).
  if (!ap && h >= 1 && h <= 7) h += 12;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min);
  const day = m[1];
  if (!day) { if (d <= now) d.setDate(d.getDate() + 1); return d; }
  if (day === 'today') return d;
  if (day === 'tomorrow' || day === 'tmrw') { d.setDate(d.getDate() + 1); return d; }
  const want = DAYS.indexOf(day.slice(0, 3));
  let add = (want - now.getDay() + 7) % 7;
  if (add === 0 && d <= now) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

/**
 * A window: "tue 11am-1pm", "tomorrow 11 to 1", "2026-10-27 11:00-13:00".
 * One time alone is a two-hour window from it. { at, until } or null.
 */
export function parseWindow(text, now = new Date()) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // SEVERAL DAYS (2026-10-26, his words: "11 to 2 pm … monday tuesday wednesday
  // thrusday"): "mon-thu 11am-2pm", "mon tue wed thu 11-2", "weekdays 11-2".
  // The window starts on the first of those days whose hours are not over yet,
  // and a missed window moves to the next of HIS days, never another.
  const set = parseDays(t);
  if (set) {
    for (let add = 0; add < 8; add++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add);
      if (!set.days.includes(day.getDay())) continue;
      const w = parseWindow(`today ${set.rest}`, day);
      if (!w) return null;
      if (+w.until > +now) return { ...w, days: set.days };
    }
    return null;
  }
  const T = '\\d{1,2}(?::\\d{2})? ?(?:am|pm|a|p)?';
  const m = t.match(new RegExp(`^(.*?)(${T}) ?(?:-|–|to|until|till) ?(${T})$`));
  if (!m) { const at = parseWhen(t, now); return at ? { at, until: new Date(+at + DEFAULT_SPAN_MS) } : null; }
  const at = parseWhen(`${m[1]}${m[2]}`.trim(), now);
  if (!at) return null;
  let until = parseWhen(`today ${m[3]}`, at);
  if (!until) return null;
  if (until <= at && !/[ap]/.test(m[3])) until = new Date(+until + 12 * 3600e3);
  if (until <= at) return null;
  return { at, until };
}

/**
 * When the saved message goes after an accepted invitation (2026-10-27, his
 * words: "not as soon as they accept but like 30-40 min later randomly, right
 * away is sus"): never sooner than a random 30-40 minutes after the accept,
 * and only inside his window. Outside it, the next window opens at its start
 * plus a random 0-40 minutes, so it is never 10:00 sharp either.
 */
export function afterAcceptWindow({ acceptedAt, now = new Date(), window = 'mon-thu 10am-4pm', rand = Math.random } = {}) {
  const accepted = acceptedAt ? new Date(acceptedAt) : now;
  const earliest = new Date(Math.max(+accepted + (30 + rand() * 10) * 60e3, +now + 60e3));
  const w = parseWindow(window, earliest);
  if (!w) return null;
  const at = +earliest > +w.at ? earliest : new Date(+w.at + rand() * 40 * 60e3);
  return { at, until: w.until, ...(w.days ? { days: w.days } : {}) };
}

const DAY_WORD = '(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?';
/** "mon-thu …", "mon tue wed thu …", "weekdays …" → { days: [1,2,3,4], rest }; one day alone is not a set. */
function parseDays(t) {
  const wk = t.match(/^weekdays? (.+)$/);
  if (wk) return { days: [1, 2, 3, 4, 5], rest: wk[1] };
  const m = t.match(new RegExp(`^(${DAY_WORD}(?:(?: ?(?:-|–|to|through|thru|,|and|&) ?| )${DAY_WORD})+),? (.+)$`));
  if (!m) return null;
  const idx = (w) => DAYS.indexOf(w.slice(0, 3));
  const words = m[1].match(new RegExp(DAY_WORD, 'g'));
  const range = words.length === 2 && /(?:-|–|to|through|thru)/.test(m[1].replace(new RegExp(DAY_WORD, 'g'), ''));
  let days = words.map(idx);
  if (range) { days = []; for (let d = idx(words[0]); ; d = (d + 1) % 7) { days.push(d); if (d === idx(words[1])) break; } }
  return { days: [...new Set(days)].sort(), rest: m[2] };
}

/** "Mon, Tue, Wed, Thu" */
export function daysLabel(days) {
  return (days || []).map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1)).join(', ');
}

/** "Tue Oct 27, 11:00 AM–1:00 PM" */
export function whenLabel(at, until) {
  const a = new Date(at);
  const day = a.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const hm = (d) => d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${hm(a)}${until ? `–${hm(new Date(until))}` : ''}`;
}
