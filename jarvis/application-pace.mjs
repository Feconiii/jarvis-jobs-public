// jarvis/application-pace.mjs — how many applications he sends a day.
//
// His ask, 2026-10-16: "make a pace counter like how many applications i have
// per day on avg to keep track of if im slacking or not".
//
// An application counts once it is CONFIRMED: a card at applied or beyond
// (responded, interview, offer, rejected). Its day is the day he applied —
// `applied_at`, or failing that the first receipt email tied to it — never the
// day it was rejected. That same night his rule was set: no confirmation email,
// no application, and the cards he had only clicked "applied" on went back to
// Tracking, so these numbers are the ones the inbox can prove.
//
// Days are his local calendar days (the machine's clock), because "today" is
// the day he lives in, not UTC's.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, '..', 'data', 'jarvis', 'jobs.db');
const SENT = ['applied', 'responded', 'interview', 'offer', 'rejected'];

/** YYYY-MM-DD of a date in the machine's local time zone. */
export function localDay(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** The day each confirmed application was sent: [{ id, company, title, day }]. */
export function applicationDays(db) {
  const rows = db.prepare(`SELECT id, company, title, applied_at FROM jobs WHERE status IN (${SENT.map(() => '?').join(',')})`).all(...SENT);
  let firstMail = null;
  try { firstMail = db.prepare(`SELECT MIN(sent_at) AS at FROM mail_events WHERE job_id = ? AND kind = 'received'`); } catch { firstMail = null; }
  const out = [];
  for (const r of rows) {
    const at = r.applied_at || firstMail?.get(r.id)?.at || null;
    if (at) out.push({ id: r.id, company: r.company, title: r.title, day: localDay(at) });
  }
  return out;
}

/**
 * The pace, from a list of application days.
 * @returns {{ today, last7, prev7, perDay7, perDayPrev7, perDay30, total, since, daysSinceLast, streak, days: [{day, n}] }}
 */
export function paceOf(apps, now = new Date()) {
  const byDay = new Map();
  for (const a of apps) byDay.set(a.day, (byDay.get(a.day) || 0) + 1);
  const dayAt = (k) => { const d = new Date(now); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - k); return localDay(d); };
  const sum = (from, to) => { let n = 0; for (let k = from; k < to; k += 1) n += byDay.get(dayAt(k)) || 0; return n; };
  const last7 = sum(0, 7), prev7 = sum(7, 14), last30 = sum(0, 30);
  const days = []; for (let k = 13; k >= 0; k -= 1) days.push({ day: dayAt(k), n: byDay.get(dayAt(k)) || 0 });
  let daysSinceLast = null; for (let k = 0; k < 400; k += 1) if (byDay.get(dayAt(k))) { daysSinceLast = k; break; }
  // Days in a row with at least one application, counting back from today —
  // or from yesterday, so a streak is not "broken" before today is over.
  let streak = 0; for (let k = byDay.get(dayAt(0)) ? 0 : 1; byDay.get(dayAt(k)); k += 1) streak += 1;
  const all = [...byDay.keys()].sort();
  const round = (x) => Math.round(x * 10) / 10;
  return {
    today: byDay.get(dayAt(0)) || 0,
    last7, prev7, perDay7: round(last7 / 7), perDayPrev7: round(prev7 / 7), perDay30: round(last30 / 30),
    total: apps.length, since: all[0] || null, daysSinceLast, streak, days,
  };
}

export function applicationPace(dbPath = DB_PATH, now = new Date()) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return paceOf(applicationDays(db), now); } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const p = applicationPace();
  console.log(`today ${p.today} · last 7 days ${p.last7} (${p.perDay7}/day) · the 7 before ${p.prev7} (${p.perDayPrev7}/day) · 30-day ${p.perDay30}/day · ${p.total} confirmed since ${p.since}${p.streak ? ` · ${p.streak}-day streak` : ''}`);
  console.log(p.days.map((d) => `${d.day.slice(5)} ${'█'.repeat(d.n)}${d.n ? ` ${d.n}` : ' ·'}`).join('\n'));
}
