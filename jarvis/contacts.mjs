/**
 * THE CONTACT LEDGER — who he has written to, about what, and when to stop.
 *
 * This is the half of outreach that is not a message. `jarvis/OUTREACH.md`'s
 * design constraints 4, 5 and 6 are all rules about STATE, and without a record
 * they are just good intentions:
 *
 *   · at most two people per company per role, by default (one until 2026-10-05)
 *   · never the same person twice without a reply
 *   · one follow-up, 5-7 business days later, adding something new — then stop
 *   · honour "don't contact me" instantly and permanently
 *
 * "Persistent" turns into "pushy" at the second follow-up, and in an industry
 * where Applied Materials, KLA, Lam and ASML people rotate between the four,
 * pushy is expensive for years. So the ledger's job is mostly to say NO.
 *
 * It lived in the same SQLite file as the jobs until 2026-09-25, when that
 * file's write lock — held for minutes by every scan — made his presses fail
 * with "database is locked" (F-597). It is in `outreach.db` beside it now; see
 * outreach-db.mjs. Rows still name their job by id and are read with it.
 *
 * NOTHING HERE SENDS. `sentAt` is set by him telling the dashboard he sent it,
 * the same way `status: applied` used to work — except that outreach genuinely
 * leaves from his own client, so there is no confirmation page to read.
 */
import { outreachDb, outreachDbPath } from './outreach-db.mjs';

/**
 * THE STORE'S FOLDER, resolved the same way the store resolves it.
 *
 * The first version of this computed its own path from `import.meta.url`,
 * which looks harmless and is not: `JARVIS_DATA_DIR` is how every test in this
 * project points the server at a temp store, and a module that ignores it
 * writes to HIS store while a test thinks it is writing to a temp one. Caught
 * by outreach-api.test.mjs on its first run — the test's own fixture contacts
 * turned up in his real ledger — which is the only reason the endpoints are
 * tested against a live server at all.
 *
 * Resolved per call, never at import: an import is hoisted above any
 * assignment to process.env, so a constant here would be read too early.
 */
const dbFile = () => outreachDbPath();

const DDL = `
CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL DEFAULT '',
  company       TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  persona       TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL DEFAULT '',
  linkedin_url  TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  email_conf    TEXT NOT NULL DEFAULT '',
  draft         TEXT NOT NULL DEFAULT '',
  followup_draft TEXT NOT NULL DEFAULT '',
  -- 'drafted' | 'sent' | 'followed_up' | 'replied' | 'closed'
  status        TEXT NOT NULL DEFAULT 'drafted',
  -- Set the moment he says "don't contact" — checked before anything else.
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT,
  sent_at       TEXT,
  followed_up_at TEXT,
  replied_at    TEXT,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS contacts_job     ON contacts(job_id);
CREATE INDEX IF NOT EXISTS contacts_company ON contacts(company);
CREATE INDEX IF NOT EXISTS contacts_status  ON contacts(status, sent_at);
`;

// One connection per file, schema applied once (outreach-db.mjs). The rows
// already in jobs.db are carried across on the first open.
const db = (dbPath = dbFile()) => outreachDb(dbPath, { ddl: DDL, legacy: ['contacts'] });

/** Stable id so the same person at the same company is one row, not many. */
export function contactId(company, name) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${norm(company)}:${norm(name)}`;
}

/** Business days, because "5-7 days later" means working days to a recruiter. */
export function addBusinessDays(from, n) {
  const d = new Date(from);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d;
}

export const FOLLOWUP_BUSINESS_DAYS = 6;

/**
 * MAY HE WRITE TO THIS PERSON? The suppression rules, in one place, returning
 * a reason rather than a boolean — the reason is what the dashboard shows.
 *
 * @param {object|null} existing  the contact row, if this person is known
 * @param {object[]} atCompany    every contact already recorded at this company
 * @param {{jobId?:string, now?:Date, perCompanyPerRole?:number}} [opts]
 */
// Two, not one (his call, 2026-10-05: "be flexible, no hard rules except for
// date and other obvious stuff"): Riley and Devin each invited contact for
// the same Tech Deployment team; a second good lead is worth a message. A cap
// still stands so one posting never becomes a mass mailing.
export function canContact(existing, atCompany = [], { jobId = '', now = new Date(), perCompanyPerRole = 2 } = {}) {
  if (existing?.do_not_contact) {
    return { ok: false, why: 'he asked not to be contacted — permanently, and that is the end of it' };
  }
  if (existing?.replied_at) {
    return { ok: false, why: 'they replied; this is a conversation now, not outreach' };
  }
  if (existing?.status === 'followed_up') {
    return { ok: false, why: 'already followed up once — a second follow-up is where persistent turns into pushy' };
  }
  if (existing?.sent_at) {
    const due = addBusinessDays(new Date(existing.sent_at), FOLLOWUP_BUSINESS_DAYS);
    if (now < due) {
      return { ok: false, why: `sent ${existing.sent_at.slice(0, 10)}; the one follow-up is due ${due.toISOString().slice(0, 10)}`, followUpOn: due.toISOString() };
    }
    return { ok: true, followUp: true, why: 'the single follow-up is due — it must add something new, not repeat the first' };
  }
  if (existing) return { ok: true, why: 'drafted but not sent' };
  // A NEW person at a company he has already written to about this same role.
  const sameRole = atCompany.filter((c) => c.job_id === jobId && !c.do_not_contact);
  if (jobId && sameRole.length >= perCompanyPerRole) {
    return { ok: false, why: `already reaching out to ${sameRole.map((c) => c.name || 'someone').join(' and ')} about this role — ${perCompanyPerRole} people per company per role at most` };
  }
  return { ok: true, why: '' };
}

/** Everything recorded at one company. */
export function atCompany(company, { dbPath = dbFile() } = {}) {
  return db(dbPath).prepare('SELECT * FROM contacts WHERE company = ? ORDER BY created_at DESC').all(String(company || ''));
}

export function getContact(id, { dbPath = dbFile() } = {}) {
  return db(dbPath).prepare('SELECT * FROM contacts WHERE id = ?').get(String(id)) || null;
}

export function forJob(jobId, { dbPath = dbFile() } = {}) {
  return db(dbPath).prepare('SELECT * FROM contacts WHERE job_id = ? ORDER BY created_at DESC').all(String(jobId || ''));
}

export function allContacts({ dbPath = dbFile(), limit = 500 } = {}) {
  return db(dbPath).prepare('SELECT * FROM contacts ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?').all(Number(limit) || 500);
}

/** Record or update one contact. Never writes a status backwards. */
export function saveContact(row, { dbPath = dbFile() } = {}) {
  const id = row.id || contactId(row.company, row.name);
  const now = new Date().toISOString();
  const prev = getContact(id, { dbPath });
  const merged = {
    id,
    job_id: row.job_id ?? prev?.job_id ?? '',
    company: row.company ?? prev?.company ?? '',
    name: row.name ?? prev?.name ?? '',
    title: row.title ?? prev?.title ?? '',
    persona: row.persona ?? prev?.persona ?? '',
    channel: row.channel ?? prev?.channel ?? '',
    linkedin_url: row.linkedin_url ?? prev?.linkedin_url ?? '',
    email: row.email ?? prev?.email ?? '',
    email_conf: row.email_conf ?? prev?.email_conf ?? '',
    draft: row.draft ?? prev?.draft ?? '',
    followup_draft: row.followup_draft ?? prev?.followup_draft ?? '',
    status: row.status ?? prev?.status ?? 'drafted',
    // ONCE SET, NEVER UNSET. A "do not contact" that a later write could clear
    // is not a promise, and this is the one rule with a person on the other
    // end of it.
    do_not_contact: (prev?.do_not_contact || row.do_not_contact) ? 1 : 0,
    created_at: prev?.created_at || now,
    sent_at: row.sent_at ?? prev?.sent_at ?? null,
    followed_up_at: row.followed_up_at ?? prev?.followed_up_at ?? null,
    replied_at: row.replied_at ?? prev?.replied_at ?? null,
    note: row.note ?? prev?.note ?? '',
  };
  db(dbPath).prepare(`INSERT INTO contacts
      (id, job_id, company, name, title, persona, channel, linkedin_url, email, email_conf, draft, followup_draft, status, do_not_contact, created_at, sent_at, followed_up_at, replied_at, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      job_id=excluded.job_id, company=excluded.company, name=excluded.name, title=excluded.title,
      persona=excluded.persona, channel=excluded.channel, linkedin_url=excluded.linkedin_url,
      email=excluded.email, email_conf=excluded.email_conf, draft=excluded.draft,
      followup_draft=excluded.followup_draft, status=excluded.status,
      do_not_contact=excluded.do_not_contact, sent_at=excluded.sent_at,
      followed_up_at=excluded.followed_up_at, replied_at=excluded.replied_at, note=excluded.note`)
    .run(merged.id, merged.job_id, merged.company, merged.name, merged.title, merged.persona,
      merged.channel, merged.linkedin_url, merged.email, merged.email_conf, merged.draft,
      merged.followup_draft, merged.status, merged.do_not_contact, merged.created_at,
      merged.sent_at, merged.followed_up_at, merged.replied_at, merged.note);
  return merged;
}

/**
 * Take off a person he has NOT written to, so someone better can take the
 * role's one slot (2026-09-27: the re-ranked research put 7 of 11 saved people
 * below a better lead). Anyone sent to, replied, or marked do-not-contact
 * stays: that row is history, and the do-not-contact promise must survive.
 * Returns the removed row, or null with nothing changed.
 */
export function removeUnsent(id, { dbPath = dbFile() } = {}) {
  const prev = getContact(id, { dbPath });
  if (!prev || prev.sent_at || prev.replied_at || prev.do_not_contact) return null;
  db(dbPath).prepare('DELETE FROM contacts WHERE id = ?').run(String(id));
  return prev;
}

/** He sent it. The one event this system cannot observe for itself. */
export function markSent(id, { dbPath = dbFile(), at = new Date().toISOString() } = {}) {
  const prev = getContact(id, { dbPath });
  if (!prev) return null;
  const followUp = prev.sent_at
    ? { status: 'followed_up', followed_up_at: at }
    : { status: 'sent', sent_at: at };
  return saveContact({ id, ...followUp }, { dbPath });
}

export function markReplied(id, { dbPath = dbFile(), at = new Date().toISOString() } = {}) {
  return getContact(id, { dbPath }) ? saveContact({ id, status: 'replied', replied_at: at }, { dbPath }) : null;
}

export function markDoNotContact(id, { dbPath = dbFile(), why = '' } = {}) {
  return getContact(id, { dbPath }) ? saveContact({ id, do_not_contact: 1, status: 'closed', note: why }, { dbPath }) : null;
}

/**
 * Whose single follow-up is due today. Sorted oldest first, because the value
 * of a follow-up decays and the oldest one is the closest to being pointless.
 */
// …and NOT about an application that is already over (2026-10-16): four of six
// "due" were Amazon contacts tied to roles Amazon had rejected or closed. A
// nudge about a decided application asks for nothing he can get.
export function dueFollowUps({ dbPath = dbFile(), now = new Date(), jobStatus = null } = {}) {
  const rows = db(dbPath).prepare(
    "SELECT * FROM contacts WHERE status = 'sent' AND sent_at IS NOT NULL AND do_not_contact = 0 AND replied_at IS NULL").all();
  const over = (c) => {
    if (!jobStatus || !c.job_id) return false;
    try { const s = jobStatus(c.job_id); return s === 'rejected' || s === 'gone'; } catch { return false; }
  };
  return rows
    .map((c) => ({ ...c, dueAt: addBusinessDays(new Date(c.sent_at), FOLLOWUP_BUSINESS_DAYS).toISOString() }))
    .filter((c) => new Date(c.dueAt) <= now && !over(c))
    .sort((a, b) => (a.sent_at < b.sent_at ? -1 : 1));
}

/**
 * The numbers the learning loop needs, and the reason this feature is worth
 * building at all: response rate per company and per persona is the only data
 * that can ever say whether outreach beats applying.
 */
export function outreachStats({ dbPath = dbFile() } = {}) {
  const rows = allContacts({ dbPath, limit: 100000 });
  const sent = rows.filter((c) => c.sent_at);
  const replied = sent.filter((c) => c.replied_at);
  const by = (key) => {
    const out = {};
    for (const c of sent) {
      const k = c[key] || '(none)';
      out[k] = out[k] || { sent: 0, replied: 0 };
      out[k].sent += 1;
      if (c.replied_at) out[k].replied += 1;
    }
    return out;
  };
  return {
    drafted: rows.length,
    sent: sent.length,
    replied: replied.length,
    // Reported as a fraction, never as a percentage, until the denominator is
    // big enough for a percentage to mean anything. Two replies out of three is
    // not a 67% reply rate.
    rate: sent.length ? `${replied.length}/${sent.length}` : '0/0',
    byPersona: by('persona'),
    byCompany: by('company'),
    byChannel: by('channel'),
  };
}

export { dbFile as contactsDbPath };
