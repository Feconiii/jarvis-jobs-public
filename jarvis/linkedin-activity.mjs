#!/usr/bin/env node
/**
 * LINKEDIN ACTIVITY — who he has written to on LinkedIn, and who answered,
 * tied to the jobs on his Outreach tab.
 *
 * Alex, 2026-09-25: "there should be linkedin mcp to check my messages and who
 * i have reached out to, similar to gmail tracking my applications".
 *
 * THERE IS NO READING HIS LINKEDIN INBOX. LinkedIn has no messaging API for a
 * member, and every "LinkedIn MCP" that reads messages signs in with his
 * session cookie and scrapes — exactly what OUTREACH.md §2a rules out, because
 * the account is the one thing a job search cannot lose. He chose (2026-09-25)
 * the two sources that are his by right:
 *
 *   1. GMAIL, automatic. LinkedIn emails him when someone accepts his
 *      invitation (the full name is in the email) and when someone replies to
 *      an InMail (the name and the reply text are in the email). Measured in his
 *      inbox the same day: 57 invitation emails and 6 InMail emails in 90 days,
 *      and exactly one "You have 1 new message" digest — which names nobody.
 *      LinkedIn never emails him what HE sent.
 *
 *   2. LINKEDIN'S OWN DATA EXPORT, when he asks for it (Settings → Data privacy
 *      → Get a copy of your data → Messages and Invitations). `messages.csv`
 *      holds every message both ways and `Invitations.csv` every invitation
 *      with its note. That is the only record of what he sent.
 *
 * Every event names a person. A person is tied to a job when they are someone
 * the Outreach button found for it, someone saved to the ledger for it, or
 * someone he attached to it by hand. A tie moves the ledger FORWARD only: a
 * message he sent marks a saved contact sent; a message they sent marks it
 * replied. An accepted invitation is shown, and moves nothing.
 *
 *   node jarvis/linkedin-activity.mjs <export.zip | export folder>
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import zlib from 'zlib';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { outreachDb, outreachDbPath } from './outreach-db.mjs';
import { allContacts, getContact, markSent, markReplied } from './contacts.mjs';
import { leadPeople } from './leads.mjs';

const dbFile = () => outreachDbPath();

const DDL = `
CREATE TABLE IF NOT EXISTS li_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,            -- 'gmail' | 'export'
  -- 'invite_sent' | 'invite_accepted' | 'message_sent' | 'message_received'
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  person      TEXT NOT NULL,            -- normalised name, the join key
  profile_url TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  job_id      TEXT NOT NULL DEFAULT '',
  contact_id  TEXT NOT NULL DEFAULT '',
  why         TEXT NOT NULL DEFAULT '',
  seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS li_events_job ON li_events(job_id, at);
CREATE INDEX IF NOT EXISTS li_events_person ON li_events(person, at);
-- Gmail messages already read, whether or not they held an event.
CREATE TABLE IF NOT EXISTS li_seen (msg_id TEXT PRIMARY KEY, at TEXT NOT NULL);
-- A person he tied to a job by hand.
CREATE TABLE IF NOT EXISTS li_links (person TEXT PRIMARY KEY, job_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS li_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const db = (dbPath = dbFile()) => outreachDb(dbPath, { ddl: DDL });

const SENT = new Set(['invite_sent', 'message_sent']);
/** Outreach he did not tie to a job is kept this far back; older is his life, not his search. */
export const UNTIED_WINDOW_DAYS = 90;

// ── names ────────────────────────────────────────────────────────────

const CREDENTIALS = new Set(['mba', 'pmp', 'phd', 'pe', 'eit', 'cpa', 'ms', 'msc', 'bs', 'bsc', 'jr', 'sr', 'ii', 'iii', 'csm', 'cssgb', 'cssbb']);
/**
 * "Lauren Traster, PMP®" and "lauren  traster" are one person. Accents,
 * credentials after a comma, emoji and middle names do not decide a match;
 * first and last name do.
 */
export function personKey(name) {
  const base = String(name || '').split(',')[0]
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '');
  const words = base.split(/\s+/).filter((w) => w && !CREDENTIALS.has(w));
  if (!words.length) return '';
  return words.length === 1 ? words[0] : `${words[0]} ${words[words.length - 1]}`;
}

/** linkedin.com/in/<slug> → slug, or ''. */
export function profileSlug(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

const ENTITIES = { '&#39;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
const decode = (s) => String(s || '').replace(/&#39;|&quot;|&amp;|&lt;|&gt;|&nbsp;/g, (e) => ENTITIES[e]).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
/** LinkedIn pads its previews with invisible joiners; they are not text. */
const tidy = (s, max = 500) => decode(s).replace(/[͏​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// ── 1. Gmail: the emails LinkedIn sends him ──────────────────────────

/** The senders worth reading, as a Gmail search. */
export const LINKEDIN_SEARCH = 'from:(invitations@linkedin.com OR hit-reply@linkedin.com OR inmail-hit-reply@linkedin.com OR messages-noreply@linkedin.com OR messaging-digest-noreply@linkedin.com)';

/**
 * One LinkedIn email → one event, or null. Pure.
 * @param m { id, fromEmail, subject, snippet, body, date } as mail.mjs parses it
 */
export function parseLinkedInEmail(m) {
  const from = String(m?.fromEmail || '').toLowerCase();
  const subject = tidy(m?.subject, 300);
  const snippet = tidy(m?.snippet, 600);
  const body = tidy(m?.body, 4000);
  const at = m?.date || new Date().toISOString();

  // "Luis accepted your invitation, explore their network" — the full name is
  // only in the preview: "See Luis Romero's connections, experience, and more".
  if (/accepted your invitation/i.test(subject)) {
    const full = (snippet.match(/^See (.+?)['’]s? connections/i) || body.match(/See (.+?)['’]s? connections/i) || [])[1];
    const name = full || subject.split(/\s+accepted your invitation/i)[0];
    return name ? { kind: 'invite_accepted', name: name.trim(), at, text: '' } : null;
  }

  // InMail: "You have a new message Ben Carter Reply https://…/thread/…/
  // Thanks, for Amazon we aren't able to sponsor… ------".
  if (/hit-reply@linkedin\.com$/.test(from)) {
    const r = body.match(/You have a new message\s+(.+?)\s+Reply\s+https?:\/\/\S+\s+([\s\S]*?)\s*(?:-{8,}|This email was intended for|$)/i);
    if (r) return { kind: 'message_received', name: r[1].trim(), at, text: tidy(r[2], 500) };
    return null;
  }

  // A message notification that names its sender. LinkedIn only sends these
  // when "Messages" email notifications are on in his settings; these subject
  // shapes are LinkedIn's documented ones and were NOT in his inbox on
  // 2026-09-25 — the bare "You have 1 new message" digest names nobody and is
  // ignored.
  const named = subject.match(/^(.+?) (?:sent you a (?:new )?message|just messaged you|messaged you|replied to your message)\b/i)
    || subject.match(/^New message from (.+)$/i);
  if (named && !/^you\b/i.test(named[1])) {
    return { kind: 'message_received', name: named[1].trim(), at, text: snippet.slice(0, 500) };
  }
  return null;
}

// ── 2. the data export ───────────────────────────────────────────────

/** RFC 4180 CSV, quoted fields spanning lines included. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/**
 * Rows as objects keyed by lower-case header. Some export files open with a
 * few lines of "Notes:" before the header, so the header is the first row
 * that carries the columns asked for.
 */
function table(text, mustHave) {
  const rows = parseCsv(text);
  const h = rows.findIndex((r) => mustHave.every((k) => r.some((c) => c.trim().toLowerCase() === k)));
  if (h === -1) return [];
  const head = rows[h].map((c) => c.trim().toLowerCase());
  return rows.slice(h + 1).map((r) => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** "2026-09-15 18:22:11 UTC" and "9/15/26, 6:22 PM" — both appear in exports. */
export function parseLinkedInDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString();
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (m) {
    let h = +m[4] % 12; if (/pm/i.test(m[6] || '')) h += 12; if (!m[6]) h = +m[4];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(y, +m[1] - 1, +m[2], h, +m[5]).toISOString();
  }
  const d = Date.parse(t);
  return Number.isFinite(d) ? new Date(d).toISOString() : '';
}

/**
 * The export's two files → events. `self` is his own name; when it is not
 * given, the sender on the most conversations is him (he is in all of them).
 */
export function parseExport({ messages = '', invitations = '' } = {}, { self = '' } = {}) {
  const events = [];
  const msgs = messages ? table(messages, ['from', 'to', 'date']) : [];
  let me = personKey(self);
  if (!me && msgs.length) {
    const byConv = new Map();
    for (const r of msgs) {
      const k = personKey(r.from);
      if (!byConv.has(k)) byConv.set(k, new Set());
      byConv.get(k).add(r['conversation id'] || r.date);
    }
    me = [...byConv].sort((a, b) => b[1].size - a[1].size)[0]?.[0] || '';
  }
  for (const r of msgs) {
    if (/^(true|yes)$/i.test(r['is message draft'] || '')) continue;
    const at = parseLinkedInDate(r.date);
    if (!at) continue;
    const text = tidy(r.content || r.subject, 500);
    if (personKey(r.from) === me) {
      const names = String(r.to || '').split(/\s*,\s*(?=[A-Z])/).filter(Boolean);
      const urls = String(r['recipient profile urls'] || '').split(/[\s,]+/).filter(Boolean);
      names.forEach((n, i) => events.push({ kind: 'message_sent', name: n, profile_url: urls[i] || '', at, text }));
    } else {
      events.push({ kind: 'message_received', name: r.from, profile_url: r['sender profile url'] || '', at, text });
    }
  }
  const inv = invitations ? table(invitations, ['from', 'to', 'direction']) : [];
  for (const r of inv) {
    if (!/^outgoing$/i.test(r.direction || '')) continue;
    const at = parseLinkedInDate(r['sent at']);
    if (!at) continue;
    events.push({ kind: 'invite_sent', name: r.to, profile_url: r.inviteeprofileurl || '', at, text: tidy(r.message, 300) });
  }
  return events.filter((e) => personKey(e.name));
}

/**
 * The two files out of the export — a folder, or the .zip LinkedIn sends.
 * The zip is read here (no dependency): LinkedIn's archive is ordinary
 * deflate entries.
 */
export function readExport(input) {
  const want = { messages: /(^|\/)messages\.csv$/i, invitations: /(^|\/)invitations\.csv$/i };
  const out = { messages: '', invitations: '' };
  if (statSync(input).isDirectory()) {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else for (const [k, re] of Object.entries(want)) if (re.test(e.name) && !out[k]) out[k] = readFileSync(p, 'utf-8');
      }
    };
    walk(input);
    return out;
  }
  for (const { name, data } of unzip(readFileSync(input))) {
    for (const [k, re] of Object.entries(want)) if (re.test(name) && !out[k]) out[k] = data.toString('utf-8');
  }
  return out;
}

/** Minimal zip reader: the central directory, then stored or deflated entries. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('that is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (data) files.push({ name, data });
  }
  return files;
}

// ── 3. who each person is, for which job ─────────────────────────────

/**
 * Everyone he might be writing to about a chosen job: the people the Outreach
 * button found, the people saved to the ledger, and the ones he tied by hand.
 */
function candidates(dbPath) {
  const out = [];
  for (const c of allContacts({ limit: 100000 })) {
    if (c.job_id) out.push({ person: personKey(c.name), slug: profileSlug(c.linkedin_url), jobId: c.job_id, contactId: c.id, via: 'saved to the ledger' });
  }
  for (const l of leadPeople()) out.push({ person: personKey(l.name), slug: profileSlug(l.profile_url), jobId: l.jobId, contactId: '', via: 'found by the Outreach button' });
  for (const l of db(dbPath).prepare('SELECT person, job_id FROM li_links').all()) out.push({ person: l.person, slug: '', jobId: l.job_id, contactId: '', via: 'tied by you' });
  return out.filter((c) => c.person || c.slug);
}

/** Every job this person belongs to (one person can be a lead on two roles). */
export function matchPerson(ev, cands) {
  const person = personKey(ev.name); const slug = profileSlug(ev.profile_url);
  const hits = cands.filter((c) => (slug && c.slug && c.slug === slug) || (person && c.person === person));
  const byJob = new Map();
  for (const h of hits) if (!byJob.has(h.jobId) || h.contactId) byJob.set(h.jobId, h);
  return [...byJob.values()];
}

const idOf = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20);

/**
 * Store events and move the ledger. Returns what changed.
 * @param events [{ kind, name, profile_url?, at, text?, msgId? }]
 */
export function recordEvents(events, { source, dbPath = dbFile(), now = new Date() } = {}) {
  const h = db(dbPath);
  const cands = candidates(dbPath);
  const has = h.prepare('SELECT 1 FROM li_events WHERE id = ?');
  // The same reply can come from Gmail today and the export next week.
  const twin = h.prepare(`SELECT 1 FROM li_events WHERE person = ? AND kind = ? AND source != ? AND ABS(julianday(at) - julianday(?)) < (10.0 / 1440) LIMIT 1`);
  const put = h.prepare(`INSERT OR IGNORE INTO li_events (id, source, kind, name, person, profile_url, at, text, job_id, contact_id, why, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Untied outreach is kept for a while, so he can tie it; untied incoming
  // messages are kept only from people he wrote to.
  const wroteTo = new Set(events.filter((e) => SENT.has(e.kind)).map((e) => personKey(e.name)));
  for (const r of h.prepare("SELECT DISTINCT person FROM li_events WHERE kind IN ('invite_sent','message_sent')").all()) wroteTo.add(r.person);
  const since = now.getTime() - UNTIED_WINDOW_DAYS * 86400e3;
  const out = { added: 0, tied: 0, sent: [], replied: [] };
  for (const e of [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const person = personKey(e.name);
    if (!person || !e.at) continue;
    if (twin.get(person, e.kind, source, e.at)) continue;
    const base = e.msgId ? `gmail:${e.msgId}` : `export:${idOf(e.kind, person, e.at, String(e.text || '').slice(0, 60))}`;
    const matches = matchPerson(e, cands);
    if (!matches.length) {
      if (Date.parse(e.at) < since) continue;
      if (!SENT.has(e.kind) && !wroteTo.has(person)) continue;
      if (has.get(base)) continue;
      put.run(base, source, e.kind, e.name, person, e.profile_url || '', e.at,
        SENT.has(e.kind) ? String(e.text || '').slice(0, 160) : '', '', '', '', now.toISOString());
      out.added += 1;
      continue;
    }
    for (const m of matches) {
      const id = matches.length > 1 ? `${base}:${m.jobId}` : base;
      if (has.get(id)) continue;
      put.run(id, source, e.kind, e.name, person, e.profile_url || '', e.at, String(e.text || '').slice(0, 500), m.jobId, m.contactId, m.via, now.toISOString());
      out.added += 1; out.tied += 1;
      if (!m.contactId) continue;
      // THE LEDGER MOVES FORWARD ONLY, and only for someone he saved.
      const c = getContact(m.contactId);
      if (!c || c.do_not_contact) continue;
      if (SENT.has(e.kind) && !c.sent_at) { markSent(c.id, { at: e.at }); out.sent.push(c.name); }
      if (e.kind === 'message_received' && !c.replied_at && (!c.sent_at || e.at >= c.sent_at)) { markReplied(c.id, { at: e.at }); out.replied.push(c.name); }
    }
  }
  return out;
}

/** Gmail's side: parse, record, remember what was read. Called by mail.mjs. */
export function applyLinkedInEmails(messages, { dbPath = dbFile(), now = new Date() } = {}) {
  const h = db(dbPath);
  const seen = h.prepare('SELECT 1 FROM li_seen WHERE msg_id = ?');
  const mark = h.prepare('INSERT OR IGNORE INTO li_seen (msg_id, at) VALUES (?, ?)');
  const events = [];
  for (const m of messages) {
    if (seen.get(m.id)) continue;
    const e = parseLinkedInEmail(m);
    if (e) events.push({ ...e, msgId: m.id });
    mark.run(m.id, now.toISOString());
  }
  const r = recordEvents(events, { source: 'gmail', dbPath, now });
  return { read: messages.length, ...r };
}
export const isLinkedInMailSeen = (id, { dbPath = dbFile() } = {}) => !!db(dbPath).prepare('SELECT 1 FROM li_seen WHERE msg_id = ?').get(id);
export function linkedInMailSince({ dbPath = dbFile() } = {}) {
  return db(dbPath).prepare("SELECT value FROM li_meta WHERE key = 'gmail_since'").get()?.value || '';
}
export function setLinkedInMailSince(iso, { dbPath = dbFile() } = {}) {
  db(dbPath).prepare("INSERT INTO li_meta (key, value) VALUES ('gmail_since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(iso);
}

/** The export's side. */
export function importExport(input, { self = '', dbPath = dbFile(), now = new Date() } = {}) {
  const files = readExport(input);
  if (!files.messages && !files.invitations) throw new Error('no messages.csv or Invitations.csv in that export — ask LinkedIn for "Messages" and "Invitations"');
  const events = parseExport(files, { self });
  const r = recordEvents(events, { source: 'export', dbPath, now });
  const summary = { at: now.toISOString(), file: path.basename(input), events: events.length, ...r, sent: r.sent.length, replied: r.replied.length };
  db(dbPath).prepare("INSERT INTO li_meta (key, value) VALUES ('last_import', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(summary));
  return summary;
}

/** He says who this person was about. Ties their past events too. */
export function tiePerson(name, jobId, { dbPath = dbFile() } = {}) {
  const person = personKey(name);
  if (!person || !jobId) return 0;
  const h = db(dbPath);
  h.prepare('INSERT INTO li_links (person, job_id, at) VALUES (?, ?, ?) ON CONFLICT(person) DO UPDATE SET job_id = excluded.job_id, at = excluded.at')
    .run(person, String(jobId), new Date().toISOString());
  return h.prepare("UPDATE li_events SET job_id = ?, why = 'tied by you' WHERE person = ? AND job_id = ''").run(String(jobId), person).changes;
}

// ── reads for the dashboard ──────────────────────────────────────────

export function eventsForJob(jobId, { dbPath = dbFile() } = {}) {
  return db(dbPath).prepare('SELECT kind, name, profile_url, at, text, source, why FROM li_events WHERE job_id = ? ORDER BY at DESC').all(String(jobId));
}

/** Per job: has he written, did they accept, did they answer, and the latest. */
export function linkedInSummary({ dbPath = dbFile() } = {}) {
  const out = {};
  for (const e of db(dbPath).prepare("SELECT job_id, kind, name, at FROM li_events WHERE job_id != '' ORDER BY at ASC").all()) {
    const s = out[e.job_id] || (out[e.job_id] = { sent: '', accepted: '', replied: '', last: null });
    if (SENT.has(e.kind) && !s.sent) s.sent = e.at;
    if (e.kind === 'invite_accepted') s.accepted = e.at;
    if (e.kind === 'message_received') s.replied = e.at;
    s.last = { kind: e.kind, name: e.name, at: e.at };
  }
  return out;
}

/** Outreach he did on LinkedIn that is not tied to a chosen job, newest first. */
export function untiedOutreach({ dbPath = dbFile(), limit = 60 } = {}) {
  return db(dbPath).prepare(`SELECT person, MAX(name) AS name, MAX(profile_url) AS profile_url, MAX(at) AS at, COUNT(*) AS n,
      MAX(CASE WHEN kind = 'message_received' OR kind = 'invite_accepted' THEN at END) AS answered
    FROM li_events WHERE job_id = '' GROUP BY person
    HAVING SUM(CASE WHEN kind IN ('invite_sent','message_sent') THEN 1 ELSE 0 END) > 0
    ORDER BY MAX(at) DESC LIMIT ?`).all(limit);
}

export function lastImport({ dbPath = dbFile() } = {}) {
  try { return JSON.parse(db(dbPath).prepare("SELECT value FROM li_meta WHERE key = 'last_import'").get()?.value || 'null'); } catch { return null; }
}

/**
 * The newest LinkedIn export sitting in his Downloads folder, so importing it
 * is one press. LinkedIn names it Basic_LinkedInDataExport_<date>.zip (or
 * Complete_…).
 */
export function exportInDownloads({ dir = path.join(os.homedir(), 'Downloads') } = {}) {
  try {
    const found = readdirSync(dir)
      .filter((f) => /linkedin.*export.*\.zip$/i.test(f) || /^(basic|complete)_linkedindataexport/i.test(f))
      .map((f) => ({ name: f, path: path.join(dir, f), mtime: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return found[0] ? { ...found[0], mtime: new Date(found[0].mtime).toISOString() } : null;
  } catch { return null; }
}

// ── CLI ──────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const input = process.argv[2] || exportInDownloads()?.path;
  if (!input || !existsSync(input)) {
    console.log('Usage: node jarvis/linkedin-activity.mjs <LinkedIn export .zip or folder>\n'
      + 'Get it at LinkedIn → Settings → Data privacy → Get a copy of your data → Messages + Invitations.');
    process.exit(input ? 1 : 0);
  }
  const r = importExport(input);
  console.log(`${r.file}: ${r.events} LinkedIn events read, ${r.added} new, ${r.tied} tied to your outreach jobs.`
    + (r.sent ? ` Marked sent: ${r.sent}.` : '') + (r.replied ? ` Marked replied: ${r.replied}.` : ''));
}
