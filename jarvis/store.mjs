// jarvis/store.mjs — the job store.
//
// Every job Jarvis has discovered, keyed by a stable id derived from the
// posting URL. The scanner upserts into it; the dashboard reads it and mutates
// job status; the apply engine records what it filled.
//
// Backed by SQLite (see db.mjs). It used to be a single JSON document that was
// parsed whole to answer any question and rewritten whole after any change —
// 363 MB at 107k jobs, and unreadable at all past V8's ~512 MB string cap.
//
// Design rules that matter downstream, all unchanged from the file era:
//   - URL is the identity. Re-scanning never duplicates; it refreshes.
//   - A user decision (interested/queued/hidden/applied) is STICKY. A re-scan
//     updates posting fields and triage, but NEVER resets a status the user set.
//   - Triage reflects the MERGED record, never the incoming payload. Scanner
//     payloads are title-only, so trusting them let a re-scan overwrite a
//     description-based work-auth block with a title-only "clean" verdict —
//     735 blocked jobs silently returned to the inbox before this was caught.
//   - An empty incoming field never erases a stored one.

import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'path';
// triage.mjs is pure (no store import), so this dependency is one-directional.
import { triage } from './triage.mjs';
// fit.mjs is likewise pure w.r.t. the store (it reads config/profile.yml and
// cv.md, never the job database), so this stays one-directional.
import { scoreFit, getProfile, slimFit } from './fit.mjs';
import { setEmployerFieldLookup } from './prefs.mjs';
import { resolveSalary } from './salary-text.mjs';
import { samePath } from './same-file.mjs';
import { appliedRowsAt } from './same-posting.mjs';
import {
  openDb, makeWriters, readDescription, readDetail, fullJob, queryJobs as dbQuery,
  iterateJobs as dbIterate, countBy as dbCountBy, countJobs as dbCount,
  rowToListItem, derived, buildDictionary, putDictionary, getDictionary,
  normalizePosted, buildWhere,
} from './db.mjs';

export const STORE_DIR = process.env.JARVIS_DATA_DIR || path.join('data', 'jarvis');

/**
 * Resolved when the database is first opened, not when this module is loaded,
 * so a caller can point at another store before touching it. Tests rely on
 * that: an import is hoisted above any assignment to process.env.
 */
export function dbPath() {
  return process.env.JARVIS_DB_PATH || path.join(process.env.JARVIS_DATA_DIR || STORE_DIR, 'jobs.db');
}
export const DB_PATH = dbPath();
/** The pre-SQLite store. Read by the migration; nothing else should touch it. */
export const LEGACY_JSON_PATH = path.join(STORE_DIR, 'jobs.json');

// Statuses a job can be in. `new` is the default for freshly discovered jobs;
// interested/queued/hidden are browsing decisions; applied → responded →
// interview → offer (or rejected) is the post-application pipeline shown on
// the tracker board. All non-new statuses are sticky across re-scans.
// 'inbox' is the curated lane: a posting Claude has read, checked for
// eligibility and put in front of him. It replaces 'interested' and 'queued',
// which were two names for the same shelf — both meant "not new, not applied"
// and nothing in the system treated them differently.
export const STATUSES = ['new', 'inbox', 'interested', 'queued', 'hidden', 'applied', 'responded', 'interview', 'offer', 'rejected'];
/** Statuses that represent a deliberate user decision — never overwritten by a scan. */
const USER_DECIDED = new Set(['inbox', 'interested', 'queued', 'hidden', 'applied', 'responded', 'interview', 'offer', 'rejected']);

// ── handle ──────────────────────────────────────────────────────────

let _db = null;
let _writers = null;

/** The database handle, opened once per process. */
export function db() {
  if (!_db) {
    _db = openDb(dbPath());
    _writers = makeWriters(_db);
  }
  return _db;
}

// ── an employer's own field ─────────────────────────────────────────
//
// What an employer's described postings are about, when one field holds 80%
// of at least 20 of them: Tutor Intelligence 91/101 robotics, Humanoid
// 160/161. Applied Materials (1% robotics), Medtronic and Hitachi have none,
// so their field-service boilerplate never reads as a robotics employer. At
// 30% the same question freed Ricoh's printer technicians and Omnicell's field
// service (audit, 2026-11-12). prefs.mjs asks only when a rule with a
// `company` exception matched, one indexed company at a time (never a pass
// over the table on the server's thread, F-1021); answers are kept 12 hours.
const EMPLOYER_FIELD_MIN = 20, EMPLOYER_FIELD_SHARE = 0.8, EMPLOYER_FIELD_TTL = 12 * 3600e3;
const _employerFields = new Map();
export function employerFields(company) {
  const key = String(company || '');
  if (!key) return [];
  const hit = _employerFields.get(key);
  if (hit && Date.now() - hit.at < EMPLOYER_FIELD_TTL) return hit.fields;
  let fields = [];
  try {
    const rows = db().prepare('SELECT field, count(*) AS n FROM jobs WHERE company = ? AND has_desc = 1 GROUP BY field').all(key);
    const total = rows.reduce((s, r) => s + r.n, 0);
    if (total >= EMPLOYER_FIELD_MIN) {
      fields = rows.filter(r => r.field && r.field !== 'other' && r.n >= total * EMPLOYER_FIELD_SHARE).map(r => r.field);
    }
  } catch {
    // A failed read (a busy or closed store) is not an answer: nothing is
    // kept, so the next posting asks again (first mate's review, 2026-11-12).
    return [];
  }
  _employerFields.set(key, { at: Date.now(), fields });
  return fields;
}
setEmployerFieldLookup(employerFields);

/**
 * FOLD THE JOURNAL BACK IN, and shrink the file behind it.
 *
 * `PRAGMA journal_size_limit` (jarvis/db.mjs) caps the WAL, but a limit only
 * takes effect when a checkpoint actually runs — and the passive ones SQLite
 * does on its own cannot reset the journal while any other connection holds a
 * read mark. With the dashboard, a scan child and an apply run all on this
 * store, there is nearly always one. Measured 2026-09-20: a 199 MB WAL beside a
 * 774 MB database, 48× the autocheckpoint threshold.
 *
 * TRUNCATE rather than FULL: FULL copies the pages back and leaves the file at
 * its high-water mark, which is the half that never got fixed on its own.
 *
 * Never throws and never blocks. `wal_checkpoint` returns a busy code instead
 * of waiting when a reader is mid-transaction, and that is the correct answer
 * here — this is housekeeping, and the next caller will get it.
 *
 * @returns {{busy:boolean, pages:number, moved:number}|null}
 */
export function checkpointWal() {
  if (!_db) return null;
  try {
    const r = _db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {};
    return { busy: Number(r.busy) === 1, pages: Number(r.log || 0), moved: Number(r.checkpointed || 0) };
  } catch { return null; }
}

/** Close the handle (tests, and the migration's verify pass). */
export function closeDb() {
  // On the way out, when this process is the one letting go of its read mark,
  // is the moment a checkpoint is most likely to succeed.
  checkpointWal();
  if (_db) { try { _db.close(); } catch { /* already closed */ } }
  _db = null; _writers = null;
}

let _writes = 0;
function writers() { db(); _writes++; return _writers; }

/**
 * A token that changes whenever the store does — including from another
 * process.
 *
 * `PRAGMA data_version` is SQLite's own counter for commits made by OTHER
 * connections, which is exactly the case the dashboard cannot otherwise see:
 * the scanner and the enrichment worker are separate processes. Combined with
 * this process's own write count it is a complete "has anything changed",
 * which is what makes it safe to cache an expensive aggregate against.
 */
export function storeVersion() {
  const row = db().prepare('PRAGMA data_version').get();
  return `${row?.data_version ?? 0}:${_writes}`;
}

/**
 * Memoise a function on the store's version. The Home tiles are ~20 aggregate
 * queries; recomputing them for every poll of a store that has not changed is
 * the kind of waste that made the old dashboard feel slow.
 */
export function memoOnStore(fn, { minAgeMs = 0 } = {}) {
  let key = null, value, computedAt = 0;
  return (...args) => {
    const now = storeVersion();
    if (now === key) return value;

    // A SCAN COMMITTING IS NOT A REASON TO REBUILD THE HOME TILES.
    //
    // The version is "<data_version>:<our own writes>". `data_version` moves
    // whenever ANOTHER process commits — and the dashboard spawns scan,
    // enrich, liveness, retire and mail-sync children that commit constantly.
    // So the expensive aggregates were being invalidated continuously by the
    // server's own background work, and `/api/overview` measured 22-39 s cold
    // against 2 ms warm: the cold path was the common one.
    //
    // `minAgeMs` rate-limits ONLY that cause. A write by this process — which
    // is him, hearting or hiding or skipping something — always recomputes
    // immediately, because a number that disagrees with the click he just made
    // is the failure this whole cache has to avoid.
    const ours = String(now).split(':')[1];
    const wasOurs = key == null ? null : String(key).split(':')[1];
    const userWrote = ours !== wasOurs;
    if (!userWrote && minAgeMs > 0 && key != null && Date.now() - computedAt < minAgeMs) {
      return value;
    }
    value = fn(...args); key = now; computedAt = Date.now();
    return value;
  };
}

/**
 * Query parameters that are NOT part of a posting's identity.
 *
 * This began as an allowlist of identity-bearing names (`gh_jid` and friends),
 * written after a Greenhouse board embedded on a company's own site — one path,
 * `?gh_jid=` the only difference — collapsed Zipline's 315 postings into a
 * single row and left Agility Robotics, Waymo and Nuro showing one job each.
 *
 * The allowlist was the wrong shape. Zimmer Biomet came in the next day on
 * `career8.successfactors.com/careers?career_job_req_id=11939`, collapsed 389
 * postings to 2, and proved the point: there is no finite list of the names a
 * vendor might use, and every name missing from an allowlist fails SILENTLY, by
 * hiding jobs. A denylist fails the other way — an unknown volatile parameter
 * produces a visible duplicate row, which is recoverable and which someone
 * notices. Given the product law (fear the false negative), that is the trade
 * to take.
 *
 * So: keep every parameter, minus the three kinds that are provably not
 * identity — tracking, session/auth, and presentation. `_s.crb` earns its place
 * here specifically: SuccessFactors regenerates it per session, so keeping it
 * would mint a new row for the same job on every single scan.
 */
const NON_ID_PARAMS = new Set([
  // tracking
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'gh_src', 'src', 'source',
  'ref', 'referrer', 'referer', 'trackingid', 'trk', 'campaign',
  // session / auth — these change between scans
  '_s.crb', 'sessionid', 'jsessionid', 'token', 'csrf', 'loginflowrequired',
  // presentation, locale and pagination
  'domain', 'lang', 'locale', 'mode', 'format', 'in_iframe', 'rss', 'ss',
  'page', 'from', 'size', 'start', 'startrow', 'offset', 'limit', 'sort',
  'sortcolumn', 'sortdirection', 'career_os', 'career_ns', 'createnewalert',
]);

const isNonId = (k) => {
  const low = k.toLowerCase();
  return NON_ID_PARAMS.has(low) || low.startsWith('utm_');
};

/**
 * Stable job id from a URL.
 *
 * Trailing slashes and decorative parameters (`?domain=micron.com` on every
 * Eightfold sitemap URL, `utm_*` on a shared link) are noise: two URLs that
 * differ only there are the same posting. Identity-bearing parameters are
 * kept, sorted, so the id does not depend on their order in the link.
 */
export function jobId(url) {
  const raw = String(url || '').trim();
  let normalized = raw.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const query = raw.match(/\?([^#]*)/);
  if (query) {
    const kept = [...new URLSearchParams(query[1]).entries()]
      .filter(([k]) => !isNonId(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k.toLowerCase()}=${v}`);
    if (kept.length) normalized += `?${kept.join('&')}`;
  }
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

// ── transactions ────────────────────────────────────────────────────

/**
 * Run `fn` with exclusive write rights.
 *
 * The file store needed a hand-rolled cross-process lock, because every writer
 * did read-modify-write on the WHOLE document: anything ADDED between one
 * writer's load and its save was simply gone. Two freshly scanned companies
 * (Eaton, 2,204 postings; MKS, 165) reported "+N new" and were not in the
 * store afterwards.
 *
 * That failure mode does not exist here — writes touch single rows — so this
 * is now a real transaction. The name is kept because every caller already
 * wraps the right span of work in it.
 *
 * @template T @param {() => T | Promise<T>} fn @returns {Promise<T>}
 */
export async function withStoreLock(fn) {
  // Already inside one (a helper that locks, called from a locked span): join
  // it. Queuing behind ourselves would wait forever.
  if (IN_TRANSACTION.getStore()) return fn();
  const turn = LOCAL_QUEUE.then(() => IN_TRANSACTION.run(true, async () => {
    const handle = db();
    await beginImmediate(handle);
    try {
      const out = await fn();
      handle.exec('COMMIT');
      return out;
    } catch (err) {
      try { handle.exec('ROLLBACK'); } catch { /* transaction already resolved */ }
      throw err;
    }
  }));
  LOCAL_QUEUE = turn.catch(() => {});
  return turn;
}

// ONE TRANSACTION AT A TIME IN THIS PROCESS (2026-09-26, F-607).
//
// Every caller in a process shares one connection, and SQLite keeps one
// transaction per connection. The dashboard server serves requests
// concurrently, so a second `withStoreLock` arriving while the first one's
// body awaited ran `BEGIN` inside an open transaction: "cannot start a
// transaction within a transaction", not a lock error, so never retried.
// Other PROCESSES are SQLite's to serialise; this queue does it in-process.
let LOCAL_QUEUE = Promise.resolve();
const IN_TRANSACTION = new AsyncLocalStorage();

/**
 * Take the write lock, waiting for it rather than dying on it (F-430).
 *
 * `BEGIN IMMEDIATE` is covered by `busy_timeout`, but the timeout is finite and
 * his dashboard server writes on its own schedule — an enrichment worker every
 * three minutes and a scan every six hours. When one of those held the lock
 * past the timeout, the CALLER died, and the caller is whoever has just spent
 * minutes on the network: a scan crashed here after **236 seconds** of fetching
 * 63 companies, and everything not already flushed went with it.
 *
 * That is the F-420 / F-425 shape once more — do the expensive work, then lose
 * it to one unlucky moment at the end. A lock is the one failure where waiting
 * is obviously right: nothing about the work has gone wrong, another writer is
 * simply mid-transaction.
 */
// THE WAIT IS HERE, ASYNCHRONOUSLY — NEVER INSIDE `BEGIN` (2026-09-26).
//
// `BEGIN IMMEDIATE` is a synchronous call, and with the connection's 30 s
// busy_timeout it WAITED for another writer's lock inside that call — which,
// in the dashboard server, froze the whole process: every request, the panel,
// his fills. Measured with the freeze tracer while he applied: "server blocked
// for 10.1s — no request in flight", one background write queued behind an
// enrichment child. So each attempt is made with busy_timeout 0 (fail at once
// when locked) and the patience lives in these async back-offs instead, about
// the same thirty seconds in all, while the event loop keeps serving.
const LOCK_BACKOFF_MS = [50, 150, 400, 1_000, 2_000, 4_000, 8_000, 15_000];
const LOCK_ATTEMPTS = LOCK_BACKOFF_MS.length + 1;

async function beginImmediate(handle) {
  let lastErr;
  let prev = 30000;
  try { prev = Number(handle.prepare('PRAGMA busy_timeout').get()?.timeout) || 30000; } catch { /* keep the default */ }
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    // Zero only for the attempt itself: the connection is shared, and any
    // other write made during a back-off must keep its usual patience.
    try {
      handle.exec('PRAGMA busy_timeout = 0');
      handle.exec('BEGIN IMMEDIATE');
      return;
    } catch (err) {
      lastErr = err;
      // SQLITE_BUSY (5) and SQLITE_LOCKED (6) mean "someone else is writing";
      // anything else is a real error and must not be retried into a loop.
      const code = err?.errcode;
      if (code !== 5 && code !== 6) throw err;
      if (attempt === LOCK_ATTEMPTS - 1) break;
    } finally {
      try { handle.exec(`PRAGMA busy_timeout = ${prev}`); } catch { /* connection closing */ }
    }
    await new Promise(r => setTimeout(r, LOCK_BACKOFF_MS[attempt]));
  }
  throw lastErr;
}

// ── reads ───────────────────────────────────────────────────────────

/**
 * One job by id, with its full verdict and apply record.
 * Pass `{ description: true }` to also pay for the posting body.
 */
export function getJob(id, opts = {}) {
  const row = db().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!row) return null;
  const job = fullJob(db(), row);
  if (opts.description) job.description = readDescription(db(), id);
  return job;
}

/**
 * How many OTHER postings at this company he has applied to (F-621). "Have
 * you applied on any previous occasions … with Micron?" was answered from a
 * standing No while the store held sixteen Micron applications.
 */
// …BY HIS APPLICATIONS, NOT THE ENGINE'S FILLS (F-1013 #3, review 2026-11-05).
// This counted `applied_at`, which is when the engine last FILLED a form: a
// form he held back made the answer Yes, and an application recorded from his
// inbox or by hand (no fill time) made it No. And "Micron" never met "Micron
// Technology". Now: rows whose STATUS says he sent it, by employerKey.
export function appliedElsewhereAt(company, exceptId = null) {
  const co = String(company || '').trim();
  if (!co) return 0;
  return appliedRowsAt(db(), co, exceptId ?? '').length;
}

/**
 * When he applied to each OTHER posting at this company (F-1036), for a
 * question with a window: "Have you applied to GlobalFoundries within the past
 * 6 months?". Each date is the earliest the row knows (the engine's fill time
 * or the status change that recorded it; a later rejection never makes an
 * application look later than it was). null when a row holds neither.
 */
export function appliedDatesAt(company, exceptId = null) {
  const co = String(company || '').trim();
  if (!co) return [];
  return appliedRowsAt(db(), co, exceptId ?? '').map((r) => [r.applied_at, r.status_changed_at].filter(Boolean).sort()[0] || null);
}

/** One job WITHOUT its detail blob — the shape a list row has. */
export function getListItem(id) {
  const row = db().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? rowToListItem(row) : null;
}

/** One job by posting URL, matched the way ids are derived. */
export function getJobByUrl(url, opts = {}) {
  return getJob(jobId(url), opts);
}

/** A job's description text, decompressed on demand. */
export function getDescription(id) { return readDescription(db(), id); }

/**
 * A page of jobs plus the total number that matched the filter.
 * Filtering, sorting and paging all happen in the database.
 */
export function query(filters = {}, opts = {}) { return dbQuery(db(), filters, opts); }

/**
 * Every job matching a filter, one at a time.
 *
 * Replaces `Object.values(store.jobs)`, which materialised the entire store —
 * about 4 GB of live heap at a million jobs.
 */
export function each(filters = {}, opts = {}) { return dbIterate(db(), filters, opts); }

/** Grouped counts computed by the database (status, fit_band, location_bucket, …). */
export function countBy(column, filters = {}) { return dbCountBy(db(), column, filters); }

/** How many jobs match a filter (no filter: the whole store). */
export function count(filters = {}) { return dbCount(db(), filters); }

/**
 * Every headline total in ONE pass over the table.
 *
 * Asked separately these were eight full scans, because a boolean column is
 * not worth an index of its own (half the rows match either way, so the
 * planner reads the table regardless). Summing them together costs one scan
 * instead of eight, which is most of what made Home slow to build.
 */
export function flagTotals() {
  const r = db().prepare(`SELECT
      COUNT(*)                AS total,
      SUM(deck)               AS browsable,
      SUM(f_hard_block)       AS blocked,
      SUM(f_senior)           AS senior,
      SUM(f_hands_on)         AS techs,
      SUM(f_intern)           AS internships,
      SUM(f_grad_mismatch)    AS gradMismatch,
      -- Raw deck count. The HOME TILE must not use this one: it promised 136
      -- new-grad reqs and its own click-through showed 106, because this
      -- includes postings already decided on and postings at hidden
      -- employers. serve.mjs recomputes it through count(), which applies the
      -- same filters the list will.
      SUM(deck * f_newgrad)   AS newGrad,
      SUM(location_bucket = 'non-us') AS nonUs,
      SUM(deck * (team != ''))        AS withTeam
    FROM jobs`).get();
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k] = Number(v || 0);
  return out;
}

/** How many distinct companies the store holds. */
export function distinctCompanies() {
  return Number(db().prepare('SELECT COUNT(DISTINCT company) AS n FROM jobs').get().n);
}

/** Status counts in the shape the dashboard header expects. */
export function statusCounts() {
  const byStatus = countBy('status');
  const out = { all: 0 };
  for (const s of STATUSES) out[s] = byStatus[s] || 0;
  for (const n of Object.values(byStatus)) out.all += n;
  return out;
}

// ── writes ──────────────────────────────────────────────────────────

/**
 * Fingerprint of everything OUTSIDE a job that its score depends on — the
 * profile and the CV-derived skills.
 *
 * An unchanged posting re-scored against an unchanged profile produces an
 * identical verdict, so a re-scan can skip that work; but when the profile
 * changes, "nothing about the posting changed" stops implying "the score is
 * still right". Recording the fingerprint is what makes the skip safe instead
 * of a way for scores to go quietly stale.
 */
function profileFingerprint() {
  try {
    return createHash('sha1').update(JSON.stringify(getProfile())).digest('hex').slice(0, 16);
  } catch { return 'unknown'; }
}

let _fingerprint = null;
function currentFingerprint() {
  if (_fingerprint == null) _fingerprint = profileFingerprint();
  return _fingerprint;
}

function storedFingerprint() {
  const row = db().prepare('SELECT v FROM meta WHERE k = ?').get('derive_fingerprint');
  return row ? row.v : null;
}

function rememberFingerprint() {
  db().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('derive_fingerprint', currentFingerprint());
}

/**
 * Does an incoming (title-only) verdict say the same thing as the stored row?
 *
 * Only asked for jobs whose body was never read — where the scanner's verdict
 * is the best available and must be accepted if it has changed. Comparing
 * against the promoted columns answers that without opening the detail blob,
 * so the common case (a re-scan that found nothing new) stays a cheap UPDATE
 * of two timestamps instead of a decompress, re-score and recompress.
 */
function triageAgreesWithRow(t, row) {
  const f = t.flags || {};
  return !!f.hardBlock === (row.f_hard_block === 1)
    && !!f.handsOn === (row.f_hands_on === 1)
    && !!f.internship === (row.f_intern === 1)
    && !!f.newGrad === (row.f_newgrad === 1)
    && !!f.gradMismatch === (row.f_grad_mismatch === 1)
    && (t.locationBucket ?? null) === row.location_bucket
    && (t.experience?.level ?? null) === row.level
    && Math.round(t.relevance?.score ?? 0) === row.relevance;
}

/** Recompute triage, salary and fit from the merged record. */
function rederive(job) {
  if (job.description && job.description.length > 40) {
    // enrichedAt: a short body nothing has read in full is "not screened" (F-627).
    job.triage = triage({ title: job.title, description: job.description, location: job.location, url: job.url, enrichedAt: job.enrichedAt ?? null });
  } else if (!job.triage) {
    job.triage = null;
  }
  job.salary = resolveSalary(job);
  job.fit = slimFit(scoreFit(job, getProfile()));
  return job;
}

/**
 * Write a whole job record. Pass `{ description: false }` when the body is
 * unchanged — re-score and re-triage read it only to derive from it.
 */
export function putJob(job, opts = {}) { writers().putJob(job, opts); }

/**
 * Every matching job id, as an array.
 *
 * A pass that WRITES while it walks cannot iterate a live query — the rows it
 * updates move underneath the cursor. Ids are small (107k of them is a couple
 * of megabytes against the ~4 GB the whole store would be), so re-scoring and
 * re-triage take the list first and read each job as they go.
 */
export function ids(filters = {}) {
  const { sql, args } = buildWhere(filters);
  return db().prepare(`SELECT id FROM jobs ${sql}`).all(...args).map(r => r.id);
}

/**
 * Find a job by URL when the id doesn't match — providers sometimes hand back
 * a differently-punctuated URL for the same posting. Deliberately a scan: it
 * runs once per apply run, and an index on url costs 14 MB.
 */
/**
 * A live posting under one board that carries this heading (F-330).
 *
 * The page he is standing on does not always carry the posting's id.
 * SmartRecruiters' apply form lives at
 * /oneclick-ui/company/<slug>/publication/<uuid>, while the store holds
 * /<slug>/<id>-<title>; the uuid appears nowhere in the store. What the form
 * does carry is the board (the slug) and the job's title as its heading, and
 * confined to that board the title is identity enough.
 *
 * `prefix` is the URL prefix every row of that board shares; `headings` are
 * the texts the page offers (its h1, its <title>). An exact title first,
 * then a <title> that contains the stored title. Newest first.
 */
export function findByHeading(prefix, headings) {
  const want = [...new Set((Array.isArray(headings) ? headings : [headings]).map(normTitle).filter(Boolean))];
  if (!prefix || !want.length) return null;
  const like = `${String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db().prepare("SELECT id, title FROM jobs WHERE url LIKE ? ESCAPE '\\' AND gone_at IS NULL AND superseded_by IS NULL ORDER BY last_seen DESC LIMIT 600").all(like);
  // A TITLE SEVERAL POSTINGS SHARE NAMES NONE OF THEM (Intel, 2026-09-26).
  // "Module Engineer" is on Intel's board in Phoenix AND Penang; his Phoenix
  // form was matched to the Penang row — the newest — and the panel said
  // "Blocked — never Malaysia" on the job he was applying to. The resume and
  // answers followed the wrong posting. One title, one posting, or nothing.
  const exact = rows.filter((r) => want.includes(normTitle(r.title)));
  if (exact.length === 1) return getJob(exact[0].id);
  if (exact.length > 1) return null;
  // Whole words only: "…Engineer I" is not inside "…Engineer II".
  // …AND ONE POSTING, IN A HEADING THAT IS ABOUT IT (2026-09-25). A careers
  // LISTING — lucidmotors.com/careers/search, many titles on one page — gave
  // a fill report to "Staff Machine Learning Engineer", the first stored
  // Lucid title found inside it, and a resume could have been built for a job
  // nobody opened. A heading far longer than the title is a list, and two
  // titles inside one heading name no posting.
  const within = rows.filter((r) => {
    const t = normTitle(r.title);
    if (t.length <= 8) return false;
    const re = new RegExp(`(?:^| )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);
    return want.some((w) => re.test(w) && w.length <= t.length + 60);
  });
  const ids = [...new Set(within.map((r) => r.id))];
  return ids.length === 1 ? getJob(ids[0]) : null;
}
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * THE POSTING BEHIND A SUCCESSFACTORS APPLICATION PORTAL.
 *
 * TSMC's form lives at career10.successfactors.com/portalcareer?_s.crb=<token>
 * — a session token that changes on every visit and appears nowhere in the
 * store, on a host the scanner never reads (it reads ro.careers.tsmc.com). The
 * one thing the form carries is the title, with the requisition number on the
 * end: "Intelligent AMHS Engineer (Phoenix, AZ On-site) (6230)".
 *
 * With nothing to match, the page was recorded as a NEW job on 2026-09-19 —
 * no company, no location, a 582-character scrap for a description — and
 * every later visit found that scrap by heading. The resume, the essays and
 * "have you worked at TSMC before?" were all decided without the posting.
 *
 * Matched on title across the scanner's SuccessFactors rows, with the trailing
 * requisition number dropped from either side, and ONLY when exactly one live
 * posting carries it. Two TSMC rows called "AMHS Technician" in different
 * cities name no posting, and a wrong one is worse than none: the id decides
 * which resume attaches.
 */
export function findSuccessFactorsPosting(headings) {
  const strip = (s) => normTitle(String(s || '').replace(/\s*\(\s*\d{3,7}\s*\)\s*$/, ''));
  const want = [...new Set((Array.isArray(headings) ? headings : [headings]).flatMap((h) => [normTitle(h), strip(h)]).filter((t) => t.length > 8))];
  if (!want.length) return null;
  const rows = db().prepare(
    "SELECT id, title, url FROM jobs WHERE source = 'successfactors' AND gone_at IS NULL AND superseded_by IS NULL",
  ).all();
  const hits = rows.filter((r) => want.includes(normTitle(r.title)) || want.includes(strip(r.title)));
  return hits.length === 1 ? getJob(hits[0].id) : null;
}

export function findByUrl(url, normalize) {
  const exact = getJob(jobId(url));
  if (exact) return exact;
  const norm = normalize
    || ((u) => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase());
  const want = norm(url);
  // THE DEFAULT NORMALISATION ONLY DROPS A TAIL AND LOWERS CASE, so a row can
  // match only if its URL begins with `want`, ignoring case — which is what
  // the NOCASE url index answers in a millisecond (2026-09-25). The walk over
  // every row cost 0.7 s on a 390,000-row store, on every fill report from a
  // form page, and blocked the server while it ran.
  if (!normalize && want) {
    const esc = want.replace(/[\\%_]/g, (c) => `\\${c}`);
    for (const row of db().prepare("SELECT id, url FROM jobs WHERE url LIKE ? ESCAPE '\\'").iterate(`${esc}%`)) {
      if (norm(row.url) === want) return getJob(row.id);
    }
    return null;
  }
  for (const row of db().prepare('SELECT id, url FROM jobs').iterate()) {
    if (norm(row.url) === want) return getJob(row.id);
  }
  return null;
}

/**
 * Merge `patch` into a stored job and persist it.
 *
 * The read pulls the description only when the patch or the recompute needs
 * it, so touching a status does not decompress 6 KB of job posting.
 */
export function updateJob(id, patch, opts = {}) {
  const needsBody = opts.rederive || patch.description != null;
  const job = getJob(id, { description: needsBody });
  if (!job) return null;
  Object.assign(job, patch);
  if (opts.rederive) rederive(job);
  writers().putJob(job);
  return job;
}

/**
 * Upsert a batch of discovered jobs.
 *
 * @param {Array} jobs    normalized job records from the scanner. Each needs at
 *                        least {url, title}; optional company/location/team/
 *                        description/postedAt/source/triage/company_meta.
 * @param {string} nowIso timestamp for firstSeen/lastSeen bookkeeping.
 * @returns {{added:number, updated:number}}
 */
export function upsertJobs(jobs, nowIso = new Date().toISOString()) {
  const handle = db();
  const w = writers();
  const staleProfile = storedFingerprint() !== currentFingerprint();
  const getRow = handle.prepare('SELECT * FROM jobs WHERE id = ?');
  let added = 0, updated = 0;

  // BEING LISTED AGAIN UNDOES A SUPERSESSION (F-406).
  //
  // A row can be marked as a second spelling of another row, and every query
  // then shows the other one. That is only ever right while the board has
  // stopped publishing this URL. The moment it publishes it again the row is a
  // live posting the board is offering him, and anything that keeps it out of
  // his lists is the fault this project refuses to have: something that
  // silently hides a posting. So the pointer is cleared for every URL this
  // scan saw, before anything else is decided, and the pass at the end of the
  // scan sets it again only if it still holds.
  const relisted = jobs.filter((j) => j && j.url && j.title).map((j) => jobId(j.url));
  for (let i = 0; i < relisted.length; i += 400) {
    const slice = relisted.slice(i, i + 400);
    handle.prepare(`UPDATE jobs SET superseded_by = NULL
      WHERE superseded_by IS NOT NULL AND id IN (${slice.map(() => '?').join(', ')})`).run(...slice);
  }

  for (const j of jobs) {
    if (!j || !j.url || !j.title) continue;
    const id = jobId(j.url);
    const row = getRow.get(id);

    if (row) {
      // Decide from the ROW whether anything actually changed, before opening
      // the detail blob. The overwhelming majority of a re-scan is unchanged
      // postings, and for those this skips a decompress, a re-score and a
      // recompress — the difference between a scan costing seconds and minutes.
      const contentChanged = staleProfile
        || (j.triage && !row.has_desc && !triageAgreesWithRow(j.triage, row))
        || j.title !== row.title
        // `j.location` truthy, not `!= null`: an empty string is a provider
        // omitting the field, not an ATS moving the job to nowhere (F-279).
        || (j.location && j.location !== row.location)
        || (j.company && j.company !== row.company)
        || (j.team && j.team !== row.team)
        || (j.description && j.description.length > (row.desc_len || 0))
        || (j.postedAt != null && normalizePosted(j.postedAt) !== row.posted_at)
        || !!j.company_meta || !!j.salary
        // A posting that has no stored detail endpoint but arrives with one
        // has changed in the way that matters most: it just became readable.
        || (j.detailApi && !row.has_desc)
        // …and a Phenom row struck out for having no reader, now arriving with
        // its page (phenomRoute below). Its stored detail is read only for
        // these few rows, so a route it already has is not rewritten.
        || (j.detailApi && row.source === 'phenom' && (row.enrich_fails || 0) >= 3 && !fullJob(handle, row).detailApi)
        || row.fit_score == null;

      if (!contentChanged) {
        w.touchJob(id, nowIso, USER_DECIDED.has(row.status) ? row.status : 'new');
        updated++;
        continue;
      }

      const existing = fullJob(handle, row);
      existing.title = j.title;
      // Only a non-empty incoming location wins — the same rule the comment
      // below states for `company`, which this line was quietly breaking.
      // `??` guards null and undefined but not '', so a provider returning a
      // blank location erased "Austin, TX" from the record and dropped the
      // posting's bucket from `us` to `unknown` (F-279).
      if (j.location) existing.location = j.location;
      if (j.team) existing.team = j.team;
      if (j.postedAt != null) existing.postedAt = j.postedAt;
      // A refresh never re-applied the company name, so correcting one in
      // portals.yml only affected postings captured AFTER the change: AMD's
      // 1,058 stayed filed under the API's legal name ("Advanced Micro
      // Devices, Inc") and searching "AMD" matched nothing. Only a non-empty
      // incoming name wins, so a provider that omits the field can never blank
      // out a name already on record.
      if (j.company) existing.company = j.company;
      if (j.company_meta) existing.company_meta = j.company_meta;
      if (j.salary) existing.salary = j.salary;
      // Where enrichment can fetch this posting's text. Adding a field means
      // touching THREE explicit allowlists — the provider, scan.mjs's job
      // mapping, and this merge — because each rebuilds the record from a
      // named list rather than spreading. That is deliberate (it is why a
      // stray provider field cannot corrupt the store) and it is also why
      // `salary` once stayed empty with the provider and the store both
      // handling it correctly.
      // A PHENOM ROW'S FIRST ROUTE (2026-11-12). The provider sends detailApi
      // only when the stored link (SuccessFactors, Taleo, UltiPro) has no
      // reader, and a row with no reader takes all three strikes at once. Those
      // strikes were for having no route, so they are cleared once, when the
      // route first arrives. Phenom only: a Greenhouse or Oracle row with no
      // stored detailApi still had a route from its URL and earned its strikes
      // on it (396 such rows, measured 2026-11-12).
      if (j.detailApi && !existing.detailApi && existing.source === 'phenom' && (existing.enrichFails || 0) >= 3) existing.enrichFails = 0;
      if (j.detailApi) existing.detailApi = j.detailApi;
      // A POSTING THE BOARD RE-POSTED AFTER WE MARKED IT GONE IS LIVE (F-1015).
      // NXP's Etch Equipment Engineer was marked gone 2026-09-08 and listed
      // again posted 2026-10-20; Hadrian's Mechatronics Engineer, gone 09-23,
      // posted 10-19. The scan refreshed last_seen and left gone_at, so both
      // stayed out of every list while LinkedIn showed them. Only a posted
      // date AFTER the mark clears it: a mark from his own browser (F-251) on
      // a posting the list API still carries unchanged stays.
      if (existing.goneAt && j.postedAt && Date.parse(j.postedAt) > Date.parse(existing.goneAt)) existing.goneAt = null;
      existing.lastSeen = nowIso;
      if (!USER_DECIDED.has(existing.status)) existing.status = 'new';

      // Read the stored body only now, and only if the payload has none:
      // triage must see the FULL merged record, not the title-only payload.
      // A scanner payload's triage is computed from the list API, which
      // carries no description — accepting it verbatim let the 6-hourly
      // auto-scan overwrite a description-based verdict with a title-only one,
      // and 735 work-auth-blocked jobs silently returned to the inbox.
      existing.description = j.description || (row.has_desc ? readDescription(handle, id) : '');
      if (existing.description && existing.description.length > 40) {
        existing.triage = triage({
          title: existing.title,
          description: existing.description,
          location: existing.location,
          url: existing.url,
          // A teaser with no full read behind it is not screened (F-627).
          enrichedAt: existing.enrichedAt ?? null,
        });
      } else if (j.triage) {
        existing.triage = j.triage;
      }
      existing.salary = resolveSalary(existing);
      existing.fit = slimFit(scoreFit(existing, getProfile()));

      w.putJob(existing);
      updated++;
    } else {
      const fresh = {
        id,
        url: j.url,
        title: j.title,
        company: j.company || '',
        team: j.team || '',
        location: j.location || '',
        description: j.description || '',
        // Annualised {min, max, currency} where the ATS publishes a pay range
        // (Ashby does). Kept so pay is filterable and sortable.
        salary: j.salary || null,
        postedAt: j.postedAt ?? null,
        source: j.source || '',
        // Where enrichment reads the body (Oracle). The update path above kept
        // it; this one dropped it, so every posting first seen on an Oracle
        // board stayed blank — 1,199 at Cummins, 0 read (2026-10-02).
        ...(j.detailApi ? { detailApi: j.detailApi } : {}),
        triage: j.triage || null,
        company_meta: j.company_meta || null,
        status: 'new',
        firstSeen: nowIso,
        lastSeen: nowIso,
      };
      // Scored from the STORED record, so it reflects the merged description
      // rather than whatever the list API happened to include.
      rederive(fresh);
      w.putJob(fresh);
      added++;
    }
  }
  rememberFingerprint();
  return { added, updated };
}

/** Set a job's status. Returns true if the job exists and was updated. */
export function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  const res = db().prepare('UPDATE jobs SET status = ?, status_changed_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return res.changes > 0;
}

/**
 * Set many statuses at once. Returns how many rows changed. `changedAt` puts
 * back an earlier status date (an undo), so the card keeps its Applied date
 * and its days in status; anything not a past date is ignored.
 */
/**
 * Run a SYNCHRONOUS write section with the store's connection waiting at most
 * `ms` for another process's lock (F-1052), then put its usual patience back.
 * For writes made outside withStoreLock on the server's thread (the mail
 * check's card moves): a lock then throws within `ms` instead of stopping
 * every request for up to 30 s, and the caller retries later. Synchronous
 * only: nothing else on this thread can run inside it, so no other write sees
 * the short wait.
 */
export function withBusyTimeout(ms, fn) {
  const handle = db();
  let prev = 30000;
  try { prev = Number(handle.prepare('PRAGMA busy_timeout').get()?.timeout) || 0; } catch { /* keep the default */ }
  handle.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(ms) || 0))}`);
  try {
    const out = fn();
    if (typeof out?.then === 'function') throw new TypeError('withBusyTimeout takes a synchronous function: its writes would run after the usual wait came back');
    return out;
  } finally {
    try { handle.exec(`PRAGMA busy_timeout = ${prev}`); } catch { /* connection closing */ }
  }
}

/**
 * Every posting under these exact company names, read a page at a time with an
 * await between pages (F-1052, the boot block). Amazon alone is 35,414 rows;
 * read in one statement on the server's only thread after a boot, its rows
 * came off a cold disk with every request waiting. Keyset pages on
 * jobs_company (company, rowid), so each page is one index range. The same
 * rows as `WHERE company IN (…)`; the order is by name, then rowid.
 */
export async function jobsUnderCompanies(names, { page = 1000, pause = () => new Promise((resolve) => setImmediate(resolve)) } = {}) {
  const stmt = db().prepare('SELECT rowid AS rid, id, company, title, status, url, location, first_seen AS firstSeen FROM jobs WHERE company = ? AND rowid > ? ORDER BY rowid LIMIT ?');
  const out = [];
  for (const name of names || []) {
    for (let after = 0; ;) {
      const rows = stmt.all(String(name), after, page);
      for (const { rid, ...row } of rows) out.push(row);
      if (rows.length < page) break;
      after = rows[rows.length - 1].rid;
      await pause();
    }
    await pause();
  }
  return out;
}

export function setStatuses(ids, status, { changedAt } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  const stmt = db().prepare('UPDATE jobs SET status = ?, status_changed_at = ? WHERE id = ?');
  const t = Date.parse(changedAt || '');
  const at = t && t <= Date.now() ? new Date(t).toISOString() : new Date().toISOString();
  let changed = 0;
  for (const id of ids) changed += stmt.run(status, at, id).changes > 0 ? 1 : 0;
  return changed;
}

/**
 * Drop a job's description while keeping the job, its verdict and its quotes.
 *
 * Only for postings that are GONE. A live job's body must stay: triage is
 * recomputed from it, so dropping it would make a later triage fix unable to
 * un-block a job it had wrongly blocked — the one direction of error the
 * product laws forbid.
 */
export function dropDescription(id) { writers().dropDescription(id); }

/**
 * Remove a stored body that is not a description at all — a translated copy
 * whose every requirement section is empty (F-760) — and re-derive the row
 * from its title, so no verdict or score rests on the boilerplate. The row
 * stays live and unpruned: a real body can still arrive for it.
 */
/**
 * Write a pick's reason and nothing else (2026-11-03): status and its time are
 * left as they are, so a card whose reason is written again is not "filed
 * today". Only for a card in his inbox or queue.
 * @returns {boolean} whether a row was written
 */
export async function setPickNote(id, note) {
  return withStoreLock(() => db().prepare("UPDATE jobs SET pick_note = ? WHERE id = ? AND status IN ('inbox','queued')")
    .run(String(note || '').slice(0, 4000) || null, String(id)).changes > 0);
}

/** Whether `file` is this store's jobs.db, however it is spelled (same-file.mjs). */
export const isStoreFile = (file) => samePath(file, dbPath());

/**
 * THE H-1B COLUMN THE RANKER READS, FROM THE DISCLOSURE LINKS (lca-import.mjs,
 * F-968 2026-11-04: it wrote this UPDATE itself). A company linked to a filer
 * (company_lca → lca_employers) is 1 when that filer has certified petitions
 * decided since `since`, else 0; a linked company with no filer row, or a link
 * to none, is set back to 0, never left as it was (F-984). Companies with no
 * link row are not touched. Synchronous; called inside the caller's
 * `withStoreLock`, with the link tables it has just written.
 * @returns {number} postings written
 */
export function writeSponsorsFromLinks({ since = `${new Date().getUTCFullYear() - 2}-01-01` } = {}) {
  return db().prepare(`UPDATE jobs SET sponsors_h1b = COALESCE((
      SELECT CASE WHEN e.certified > 0 AND e.last_decision >= ? THEN 1 ELSE 0 END
        FROM company_lca c JOIN lca_employers e ON e.key = c.key
       WHERE c.company = jobs.company), 0)
    WHERE company IN (SELECT company FROM company_lca)`).run(since).changes;
}

/**
 * Remove rows nobody acted on, with their bodies (disable-board.mjs: a board
 * turned off takes its untouched postings with it; F-968, 2026-11-04, it ran
 * its own BEGIN/DELETE outside the write lock). Only status 'new' is removed:
 * a row he hearted, hid, queued or applied to stays whatever the caller asks.
 * @returns {Promise<number>} rows removed
 */
export async function removeUntouched(ids) {
  return withStoreLock(() => {
    const h = db();
    const isNew = h.prepare("SELECT 1 FROM jobs WHERE id = ? AND status = 'new'");
    const del = ['descriptions', 'details', 'jobs'].map((t) => h.prepare(`DELETE FROM ${t} WHERE id = ?`));
    // A copy that pointed at a removed row points at nothing: it is shown again
    // as itself (F-968 review follow-up, 2026-11-04).
    const unpoint = h.prepare('UPDATE jobs SET superseded_by = NULL WHERE superseded_by = ?');
    let n = 0;
    for (const id of ids || []) {
      if (!isNew.get(String(id))) continue;
      for (const s of del) s.run(String(id));
      unpoint.run(String(id));
      n += 1;
    }
    return n;
  });
}

/**
 * COPY POINTERS (dedupe.mjs, F-968 2026-11-04). A row `superseded_by` another
 * is a second spelling of that posting: views show the kept row only. These
 * write the pointer and nothing else; like setStatus they are synchronous and
 * are called inside the caller's `withStoreLock` (dedupe journals each run in
 * the same transaction).
 */
/**
 * HIS DECISION FOLLOWS THE POSTING (serve.mjs's page fold, F-968 2026-11-04: it
 * wrote this UPDATE itself). The row `toId` takes the status he gave its copy,
 * with that decision's own date (now when the copy had none), and the copy's
 * note only when the row has none of its own. Synchronous; called inside the
 * caller's `withStoreLock`.
 */
export function carryDecision(toId, { status, changedAt = null, note = null, userNote = null } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  return db().prepare('UPDATE jobs SET status = ?, status_changed_at = ?, pick_note = COALESCE(pick_note, ?), user_note = COALESCE(user_note, ?) WHERE id = ?')
    .run(status, changedAt || new Date().toISOString(), note ?? null, userNote ?? null, String(toId)).changes > 0;
}

/**
 * A COPY FOLDED INTO THE ROW THAT KEEPS THE POSTING: his decision carried
 * first (when `decision` is given), then the pointer. When the store refuses
 * the pointer, the carry is undone, status, date and notes alike (code review
 * #4, 2026-11-13): the page fold left both rows showing the same decision and
 * notes, so the posting counted twice. Synchronous; inside the caller's lock.
 * @returns {boolean} whether the copy now points at `keepId`
 */
export function foldCopy(staleId, keepId, decision = null, opts = {}) {
  const prior = decision ? db().prepare('SELECT status, status_changed_at FROM jobs WHERE id = ?').get(String(keepId)) : null;
  const before = prior ? notesOf(keepId) : null;
  if (prior) carryDecision(keepId, decision);
  const after = prior ? notesOf(keepId) : null;
  if (pointAt(staleId, keepId, opts)) return true;
  if (prior) {
    restoreStatus(keepId, prior.status ?? null, prior.status_changed_at ?? null);
    restoreNotes(keepId, before, after);
  }
  return false;
}

/**
 * How much of his a row holds (F-1026): the application pipeline, then his
 * lists, then a hide, then nothing. Chooses which copy of a posting survives,
 * and decides whether pointing one copy at another would hide his decision.
 */
const DECISION_RANK = { offer: 9, interview: 8, responded: 7, applied: 6, rejected: 5, queued: 4, interested: 4, inbox: 4, skipped: 2, hidden: 1, new: 0 };
export const decisionRank = (s) => DECISION_RANK[s] ?? 0;
const LIST_CARD = new Set(['inbox', 'interested', 'queued']);

/**
 * May `stale` (a row) be hidden behind `keep`? Not when it holds more of his
 * than the survivor does: a decision carried across first makes them equal. A
 * repost may hide a closed LIST CARD on purpose (the new requisition is the
 * card now), never an application.
 */
const APPLICATION_STATUS = new Set(['applied', 'rejected', 'responded', 'interview', 'offer']);
/** A row he applied through: an application status, or the engine's record that a form was sent (applied_at). */
export const holdsApplication = (r) => !!r && (APPLICATION_STATUS.has(r.status) || !!r.applied_at);
/**
 * THE APPLICATION'S OWN RECORD (F-1028; first mate, 2026-11-06: "between two
 * application rows, the one with applied_at shows"): the row the engine applied
 * through (applied_at — the date, the resume sent). Not an APPLY-PAGE COPY: a
 * row the extension or a manual add made at the form's own address (source
 * `extension` or `<ats>-manual`; AMAT, TSMC, Wolfspeed, Moog, Danfoss), which
 * stays behind the board row that is the card. Told apart by what the row is,
 * never by when it was last listed (review: a posting that closed before any
 * scan listed it again is still his record).
 */
export const isApplyPageCopy = (r) => r?.source === 'extension' || /-manual$/.test(String(r?.source || ''));
export const holdsRecord = (r) => !!r?.applied_at && !isApplyPageCopy(r);

export function mayHide(stale, keep, { repost = false } = {}) {
  if (!stale || !keep) return false;
  // AN APPLICATION IS NEVER HIDDEN BEHIND A ROW THAT HOLDS NONE (review,
  // 2026-11-06): a row he applied through and later hid or skipped still has
  // its application on it, whatever its status says now.
  if (holdsApplication(stale) && !holdsApplication(keep)) return false;
  const s = decisionRank(stale.status); const k = decisionRank(keep.status);
  // His record is never hidden behind a row without one, unless that row has
  // moved further (an interview the mail put on the copy).
  if (holdsRecord(stale) && !keep.applied_at && s >= k) return false;
  if (s < k) return true;
  // Equal rank is only equal when it is the same decision (review, 2026-11-06):
  // a queued card behind an inbox one is a different choice of his, so it is
  // carried across first or not hidden at all.
  if (s === k && (s === 0 || (stale.status || 'new') === (keep.status || 'new'))) return true;
  return repost && LIST_CARD.has(stale.status);
}

/**
 * Two notes on one posting become one (review): the survivor's own note
 * first, the hidden copy's after it, marked; never one dropped for the other.
 */
export function mergeNotes(keepNote, staleNote) {
  const k = String(keepNote ?? '').trim(); const s = String(staleNote ?? '').trim();
  if (!s) return keepNote ?? null;
  if (!k) return staleNote;
  if (k.includes(s)) return keepNote;
  return `${keepNote}\n\n[from the other copy of this posting] ${staleNote}`;
}

/** Pointers refused because they would have hidden his decision (F-1026), newest last; read by the callers that report. */
export const POINT_REFUSALS = [];

/**
 * Point `staleId` at `keepId`. `onlyIfUnset`: leave a row that already points somewhere.
 *
 * THE ONE PLACE A COPY IS HIDDEN (F-1026, review 2026-11-06): every caller —
 * the dedupe pass, pointCopies, resolve-copies, the page fold — goes through
 * here, so the rule is here. A row holding more of his than the survivor is
 * refused and logged (carry his decision first, then point). His note and the
 * inbox note move with the pointer when the survivor has none, so a hidden
 * copy never takes a note out of sight.
 */
export function pointAt(staleId, keepId, { onlyIfUnset = false, repost = false, notes = true } = {}) {
  if (!staleId || !keepId || staleId === keepId) return false;
  const h = db();
  const get = h.prepare('SELECT id, source, company, title, status, applied_at, pick_note, user_note, superseded_by FROM jobs WHERE id = ?');
  const stale = get.get(String(staleId)); const keep = get.get(String(keepId));
  if (!stale || !keep) return false;
  if (onlyIfUnset && stale.superseded_by) return false;
  // NEVER BEHIND A ROW THAT IS ITSELF HIDDEN (2026-11-06): two group types in one
  // dedupe run each made the other row the survivor, and seven postings —
  // four of them applications he sent — pointed at each other and vanished.
  // A pointer goes to a row that shows, or nowhere.
  if (keep.superseded_by) {
    const line = `left alone: ${stale.id} would point at ${keep.id}, which itself points at ${keep.superseded_by} (no chains, no loops)`;
    POINT_REFUSALS.push({ stale: stale.id, keep: keep.id, staleStatus: stale.status || 'new', keepStatus: keep.status || 'new', line, chain: true });
    try { console.log(`  ${line}`); } catch { /* no console */ }
    return false;
  }
  if (!mayHide(stale, keep, { repost })) {
    const line = `left alone: ${stale.id} [${stale.status || 'new'}] would be hidden behind ${keep.id} [${keep.status || 'new'}] ${keep.company} — ${keep.title}`;
    POINT_REFUSALS.push({ stale: stale.id, keep: keep.id, staleStatus: stale.status || 'new', keepStatus: keep.status || 'new', line });
    if (POINT_REFUSALS.length > 500) POINT_REFUSALS.splice(0, POINT_REFUSALS.length - 500);
    try { console.log(`  ${line}`); } catch { /* no console */ }
    return false;
  }
  // `notes: false` for an undo putting an old pointer back: the survivor's notes are already as they were.
  if (notes && (stale.pick_note || stale.user_note)) {
    h.prepare('UPDATE jobs SET pick_note = ?, user_note = ? WHERE id = ?')
      .run(mergeNotes(keep.pick_note, stale.pick_note), mergeNotes(keep.user_note, stale.user_note), String(keepId));
  }
  const sql = `UPDATE jobs SET superseded_by = ? WHERE id = ?${onlyIfUnset ? ' AND superseded_by IS NULL' : ''}`;
  return h.prepare(sql).run(String(keepId), String(staleId)).changes > 0;
}
/**
 * UNDO ONLY: put a row's pointer back exactly as a journalled run found it,
 * while it is still what that run left (`expect`). No rule is applied here —
 * an undo restores a state, it does not decide one (review, 2026-11-06).
 */
export function restorePointer(id, to, { expect } = {}) {
  const now = db().prepare('SELECT superseded_by FROM jobs WHERE id = ?').get(String(id));
  if (!now || (now.superseded_by ?? null) !== (expect ?? null)) return false;
  return db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(to ?? null, String(id)).changes > 0;
}
/** A row's two notes as they are, for a journal that must put them back (review). */
export function notesOf(id) {
  const r = db().prepare('SELECT pick_note, user_note FROM jobs WHERE id = ?').get(String(id));
  return r ? { pick: r.pick_note ?? null, user: r.user_note ?? null } : null;
}
/** Put a row's notes back to `before`, but only while they are still what the merge left (`after`): a note he wrote since stays. */
export function restoreNotes(id, before, after) {
  if (!before || !after) return false;
  const now = notesOf(id);
  if (!now) return false;
  const pick = now.pick === after.pick ? before.pick : now.pick;
  const user = now.user === after.user ? before.user : now.user;
  if (pick === now.pick && user === now.user) return false;
  return db().prepare('UPDATE jobs SET pick_note = ?, user_note = ? WHERE id = ?').run(pick, user, String(id)).changes > 0;
}
/** Clear `staleId`'s pointer; with `from`, only while it still points there. */
export function clearPointer(staleId, { from = null } = {}) {
  const sql = `UPDATE jobs SET superseded_by = NULL WHERE id = ?${from ? ' AND superseded_by = ?' : ''}`;
  return db().prepare(sql).run(...(from ? [String(staleId), String(from)] : [String(staleId)])).changes > 0;
}
/** Clear every pointer (dedupe --undo-all). Returns how many. */
export function clearAllPointers() {
  return db().prepare('UPDATE jobs SET superseded_by = NULL WHERE superseded_by IS NOT NULL').run().changes;
}
/**
 * Put back a status exactly as it was, date included (dedupe --undo of a
 * carried decision). Unlike setStatuses, a null status or date is restored as
 * null: the row had none before the carry.
 */
export function restoreStatus(id, status, changedAt) {
  if (status != null && !STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  return db().prepare('UPDATE jobs SET status = ?, status_changed_at = ? WHERE id = ?').run(status ?? null, changedAt ?? null, String(id)).changes > 0;
}

/**
 * How a LinkedIn posting takes an application, as LinkedIn's own page says
 * (linkedin-route.mjs). A promoted column only: no derivation reads it, the
 * screen skips 'easy-apply' rows. curate.mjs and linkedin-route.mjs wrote it
 * with their own UPDATE, outside the write lock (F-968, 2026-11-04).
 * @returns {Promise<boolean>} whether a row was written
 */
export const APPLY_ROUTES = ['easy-apply', 'offsite', 'closed'];
export async function setApplyRoute(id, route) {
  if (!APPLY_ROUTES.includes(route)) throw new Error(`invalid apply route: ${route}`);
  return withStoreLock(() => db().prepare('UPDATE jobs SET apply_route = ? WHERE id = ?').run(route, String(id)).changes > 0);
}

export function clearDescription(id) {
  const job = getJob(id);
  if (!job) return null;
  writers().clearDescription(id);
  job.description = '';
  job.triage = triage({ title: job.title, description: '', location: job.location, url: job.url });
  rederive(job);
  writers().putJob(job);
  return job;
}

export { THIN_BODY } from './db.mjs';

// ── scans and company hiding ────────────────────────────────────────

/** Record a scan run's completeness stats (the dashboard's transparency panel). */
export function recordScan(summary) {
  const handle = db();
  handle.prepare('INSERT INTO scans (at, json) VALUES (?, ?)')
    .run(summary?.at || new Date().toISOString(), JSON.stringify(summary));
  // Keep the last 20 runs, as the file store did — and the newest FULL scan
  // past them (week-fixes J3): twenty page imports in six hours would
  // otherwise erase the record the scan clock counts from, and a sweep would
  // start at once.
  handle.exec(`DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT 20)
    AND id IS NOT (SELECT s.id FROM scans s WHERE ${SCAN_FULL_SQL} ORDER BY s.id DESC LIMIT 1)`);
}

/**
 * scan-clock.mjs's isFullScan, in SQL over a row aliased `s`: `full` when the
 * record says true or false; otherwise full unless every company in it came
 * from a browser-assist import. SQLite's JSON reader, not JSON.parse.
 */
const SCAN_FULL_SQL = `(CASE json_type(s.json, '$.full') WHEN 'true' THEN 1 WHEN 'false' THEN 0
  ELSE NOT (coalesce(json_array_length(s.json, '$.perCompany'), 0) > 0
    AND NOT EXISTS (SELECT 1 FROM json_each(s.json, '$.perCompany') AS pc
      WHERE json_extract(pc.value, '$.provider') IS NOT 'browser-assist')) END)`;

/**
 * THE NEWEST FULL SCAN'S TIME, FOR THE SCAN CLOCK (week-fixes J3). serve.mjs
 * looked every ten minutes by parsing twenty ~700 KB records in JavaScript
 * (F-1025). This reads the answer in SQL and keeps it until a scan is recorded.
 */
let LAST_FULL = { handle: null, top: null, at: null };
export function lastFullScanRecordAt() {
  const handle = db();
  const top = handle.prepare('SELECT max(id) AS m FROM scans').get()?.m ?? 0;
  if (LAST_FULL.handle === handle && LAST_FULL.top === top) return LAST_FULL.at;
  const at = handle.prepare(`SELECT s.at FROM scans s WHERE ${SCAN_FULL_SQL} ORDER BY s.id DESC LIMIT 1`).get()?.at ?? null;
  LAST_FULL = { handle, top, at };
  return at;
}

/** Recent scan summaries, newest first. */
export function getScans(limit = 20) {
  return db().prepare('SELECT json FROM scans ORDER BY id DESC LIMIT ?').all(limit)
    .map(r => { try { return JSON.parse(r.json); } catch { return null; } })
    .filter(Boolean);
}

/**
 * THE RECENT SCANS WITHOUT THEIR PER-COMPANY TABLES (F-1025). A scan record is
 * ~700 KB now (3,600 companies), and the Overview's activity list parsed
 * twelve of them on every request for three names and four counts. Kept until
 * a new scan is recorded.
 */
let SCAN_SUMMARY = { handle: null, top: null, limit: 0, rows: [] };
export function recentScanSummaries(limit = 12) {
  const handle = db();   // a store reopened elsewhere is a different store (review)
  const top = handle.prepare('SELECT max(id) AS m FROM scans').get()?.m ?? 0;
  if (SCAN_SUMMARY.handle === handle && SCAN_SUMMARY.top === top && SCAN_SUMMARY.limit >= limit) return SCAN_SUMMARY.rows.slice(0, limit);
  const rows = getScans(limit).map((s) => {
    const names = (s.perCompany || []).map((c) => c && c.company).filter(Boolean);
    return {
      at: s.at, postingsCaptured: s.postingsCaptured, added: s.added, updated: s.updated,
      companiesScanned: s.companiesScanned, firstCompanies: names.slice(0, 3), companyCount: names.length,
    };
  });
  SCAN_SUMMARY = { handle, top, limit, rows };
  return rows.slice(0, limit);
}

function readMetaList(key) {
  const row = db().prepare('SELECT v FROM meta WHERE k = ?').get(key);
  if (!row) return [];
  try { const v = JSON.parse(row.v); return Array.isArray(v) ? v : []; } catch { return []; }
}

function writeMetaList(key, list) {
  db().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, JSON.stringify(list));
}

/**
 * Postings he applied to that closed and are open again under another address
 * (dedupe.mjs, review 2026-11-06): his application stays on the old row, so the
 * Overview names each one. Replaced on every dedupe write.
 */
export function reopenedApplications() { return readMetaList('reopenedApplications'); }
export function setReopenedApplications(list) {
  writeMetaList('reopenedApplications', (Array.isArray(list) ? list : []).slice(0, 200));
}

/** Companies the user has hidden wholesale. */
export function hiddenCompanies() { return readMetaList('hiddenCompanies'); }

/** Hide or unhide an entire company. Returns the updated list. */
export function setCompanyHidden(company, hidden) {
  const name = String(company || '').trim();
  const set = new Set(hiddenCompanies());
  if (name) { if (hidden) set.add(name); else set.delete(name); }
  const list = [...set].sort();
  writeMetaList('hiddenCompanies', list);
  return list;
}

/** Arbitrary key/value the dashboard keeps between visits (e.g. last visit). */
export function getMeta(key, fallback = null) {
  const row = db().prepare('SELECT v FROM meta WHERE k = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch { return row.v; }
}

export function setMeta(key, value) {
  db().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(key, JSON.stringify(value));
}

/** Storage footprint, for the dashboard's honesty panels. */
export function storeStats() {
  const handle = db();
  const bodies = handle.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(blob)), 0) AS packed, COALESCE(SUM(len), 0) AS raw FROM descriptions').get();
  const detail = handle.prepare('SELECT COALESCE(SUM(LENGTH(blob)), 0) AS packed FROM details').get();
  return {
    jobs: count(),
    descriptions: Number(bodies.n),
    descriptionBytes: Number(bodies.packed),
    descriptionBytesUncompressed: Number(bodies.raw),
    detailBytes: Number(detail.packed),
  };
}

/**
 * (Re)build the shared compression dictionaries from a sample of the store.
 *
 * Worth running after a large import: the dictionaries are sampled text, so
 * one built from 400 semiconductor postings compresses semiconductor postings
 * well and a store that has since filled with medtech less well. Existing rows
 * stay readable either way — each row records the codec it was written with —
 * so this is maintenance, never a migration.
 */
export function trainDictionaries(sampleSize = 400) {
  const handle = db();
  const descIds = handle.prepare('SELECT id FROM descriptions ORDER BY RANDOM() LIMIT ?').all(sampleSize).map(r => r.id);
  const descSamples = descIds.map(id => readDescription(handle, id)).filter(t => t.length > 500);
  if (descSamples.length >= 20) putDictionary(handle, 'description', buildDictionary(descSamples));

  const detailIds = handle.prepare('SELECT id FROM details ORDER BY RANDOM() LIMIT ?').all(sampleSize).map(r => r.id);
  const detailSamples = detailIds.map(id => JSON.stringify(readDetail(handle, id)));
  if (detailSamples.length >= 20) putDictionary(handle, 'detail', buildDictionary(detailSamples));

  writers().refreshDictionaries();
  return {
    description: getDictionary(handle, 'description')?.length ?? 0,
    detail: getDictionary(handle, 'detail')?.length ?? 0,
  };
}

export { derived };
