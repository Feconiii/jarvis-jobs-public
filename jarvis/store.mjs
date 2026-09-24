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
import path from 'path';
// triage.mjs is pure (no store import), so this dependency is one-directional.
import { triage } from './triage.mjs';
// fit.mjs is likewise pure w.r.t. the store (it reads config/profile.yml and
// cv.md, never the job database), so this stays one-directional.
import { scoreFit, getProfile, slimFit } from './fit.mjs';
import { resolveSalary } from './salary-text.mjs';
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
}

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
const LOCK_ATTEMPTS = 5;
const LOCK_BACKOFF_MS = [1_000, 3_000, 8_000, 15_000];

async function beginImmediate(handle) {
  let lastErr;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try { handle.exec('BEGIN IMMEDIATE'); return; } catch (err) {
      lastErr = err;
      // SQLITE_BUSY (5) and SQLITE_LOCKED (6) mean "someone else is writing";
      // anything else is a real error and must not be retried into a loop.
      const code = err?.errcode;
      if (code !== 5 && code !== 6) throw err;
      if (attempt === LOCK_ATTEMPTS - 1) break;
      await new Promise(r => setTimeout(r, LOCK_BACKOFF_MS[attempt]));
    }
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
    job.triage = triage({ title: job.title, description: job.description, location: job.location, url: job.url });
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
  const rows = db().prepare("SELECT id, title FROM jobs WHERE url LIKE ? ESCAPE '\\' AND gone_at IS NULL ORDER BY last_seen DESC LIMIT 600").all(like);
  const exact = rows.find((r) => want.includes(normTitle(r.title)));
  if (exact) return getJob(exact.id);
  // Whole words only: "…Engineer I" is not inside "…Engineer II".
  const within = rows.find((r) => {
    const t = normTitle(r.title);
    if (t.length <= 8) return false;
    const re = new RegExp(`(?:^| )${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);
    return want.some((w) => re.test(w));
  });
  return within ? getJob(within.id) : null;
}
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function findByUrl(url, normalize) {
  const exact = getJob(jobId(url));
  if (exact) return exact;
  const norm = normalize
    || ((u) => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase());
  const want = norm(url);
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
      if (j.detailApi) existing.detailApi = j.detailApi;
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

/** Set many statuses at once. Returns how many rows changed. */
export function setStatuses(ids, status) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  const stmt = db().prepare('UPDATE jobs SET status = ?, status_changed_at = ? WHERE id = ?');
  const at = new Date().toISOString();
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

// ── scans and company hiding ────────────────────────────────────────

/** Record a scan run's completeness stats (the dashboard's transparency panel). */
export function recordScan(summary) {
  const handle = db();
  handle.prepare('INSERT INTO scans (at, json) VALUES (?, ?)')
    .run(summary?.at || new Date().toISOString(), JSON.stringify(summary));
  // Keep the last 20 runs, as the file store did.
  handle.exec('DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT 20)');
}

/** Recent scan summaries, newest first. */
export function getScans(limit = 20) {
  return db().prepare('SELECT json FROM scans ORDER BY id DESC LIMIT ?').all(limit)
    .map(r => { try { return JSON.parse(r.json); } catch { return null; } })
    .filter(Boolean);
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
