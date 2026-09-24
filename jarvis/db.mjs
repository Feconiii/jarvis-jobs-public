// jarvis/db.mjs — the job store's storage engine.
//
// One SQLite file (data/jarvis/jobs.db), read and written a row at a time.
// Replaces a single JSON document that had to be parsed whole (363 MB at 107k
// jobs) before any question about it could be answered, and rewritten whole
// after any change.
//
// Why SQLite specifically:
//   - No string ceiling. The JSON store died at V8's ~512 MB maximum string
//     length: past that the file could not be read AT ALL, and every recovery
//     path started by reading it into a string.
//   - Filtering happens here, not in JavaScript and not in the browser. The
//     dashboard's list request was serialising every job it had (77 MB at
//     107k) so the page could filter client-side.
//   - Concurrent readers and one writer, enforced by the database. The old
//     file needed a hand-rolled cross-process lock because "merge on save"
//     merged fields but not the SET of jobs — two companies' worth of freshly
//     scanned postings were lost that way.
//   - It ships with Node 24 (node:sqlite). No dependency, no server.
//
// ── Hot and cold ────────────────────────────────────────────────────
//
// `jobs` holds only what a LIST needs: the columns the dashboard filters,
// sorts and renders badges from. Every one is indexed or cheap.
//
// `details` (the full triage verdict, fit breakdown, apply record) and
// `descriptions` are read when ONE job is opened, so they live in their own
// tables, compressed. Browsing a page of 200 jobs touches neither.
//
// ── Why a shared dictionary ─────────────────────────────────────────
//
// Job postings and their verdicts are mostly boilerplate, but the repetition
// is BETWEEN documents, not inside them — and a compressor working one row at
// a time cannot see it. Measured on this store: 2.3x on descriptions, 1.7x on
// the JSON detail. With a shared dictionary sampled from the store itself,
// the same rows compress 4.2x and 11.8x, with byte-exact round-trips and no
// loss of per-row random access. That difference is most of the answer to
// "can this hold a million jobs".

import { DatabaseSync } from 'node:sqlite';
import zlib from 'zlib';
import { mkdirSync } from 'fs';
import path from 'path';

export const SCHEMA_VERSION = 2;

// ── compression ─────────────────────────────────────────────────────

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
/** codec ids, stored per row so the store stays readable across changes */
const CODEC = { GZIP: 1, ZSTD: 2, ZSTD_DICT: 3 };
// Level and dictionary size are chosen TOGETHER, measured on this store's own
// descriptions (300 held-out documents, ratio against throughput):
//
//   no dictionary, level 6   2.25x   7,978 docs/sec
//   110 KB dict,   level 6   3.68x   2,278 docs/sec
//   110 KB dict,   level 12  3.88x     111 docs/sec
//
// A one-shot call reloads the dictionary every time, so a big dictionary at a
// high level is quick to READ and unusably slow to WRITE — level 12 turned a
// one-minute migration into hours for 5% more compression.
const ZSTD_LEVEL = 6;

const zstdOpts = (dict) => {
  const params = { params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } };
  return dict ? { ...params, dictionary: dict } : params;
};

function compress(text, dict) {
  const buf = Buffer.from(text, 'utf-8');
  if (!HAS_ZSTD) return { codec: CODEC.GZIP, blob: zlib.gzipSync(buf, { level: 6 }) };
  if (dict) return { codec: CODEC.ZSTD_DICT, blob: zlib.zstdCompressSync(buf, zstdOpts(dict)) };
  return { codec: CODEC.ZSTD, blob: zlib.zstdCompressSync(buf, zstdOpts(null)) };
}

function decompress(blob, codec, dict) {
  const buf = Buffer.from(blob);
  if (codec === CODEC.GZIP) return zlib.gunzipSync(buf).toString('utf-8');
  if (codec === CODEC.ZSTD_DICT) return zlib.zstdDecompressSync(buf, { dictionary: dict }).toString('utf-8');
  return zlib.zstdDecompressSync(buf).toString('utf-8');
}

/**
 * Build a dictionary from a sample of real rows.
 *
 * zstd's own trainer is a C API Node does not expose, so this uses the
 * supported alternative: a raw content dictionary, which is simply
 * representative text. Measured against a held-out half of the store it
 * recovers most of the benefit (4.2x on descriptions, 11.8x on detail).
 */
export function buildDictionary(samples, maxBytes = 110_000) {
  const joined = samples.join('\n');
  return Buffer.from(joined, 'utf-8').subarray(0, maxBytes);
}

// ── schema ──────────────────────────────────────────────────────────

/** Job fields stored verbatim in their own column. */
const PLAIN_COLUMNS = {
  id: 'id', url: 'url', title: 'title', company: 'company', team: 'team',
  location: 'location', source: 'source', status: 'status',
  statusChangedAt: 'status_changed_at', firstSeen: 'first_seen',
  lastSeen: 'last_seen', enrichFails: 'enrich_fails',
  resume_path: 'resume_path', resume_sent: 'resume_sent',
  deepRequested: 'deep_requested',
  // When the ATS started answering 'gone' for this posting. Plain column, not
  // a derived one: it is an observation, not something recomputable.
  goneAt: 'gone_at',
  // When this posting was last put in front of him in the card deck. An
  // observation, not something recomputable, so it sits with the plain
  // columns rather than the derived ones.
  seenAt: 'seen_at',
  // THE ROW THIS ONE IS A SECOND SPELLING OF (F-406). Not a death: the posting
  // is live, under the id named here. Zipline changed the URL its board
  // publishes on 2026-09-03, a row is identified by its URL, and 328 postings
  // quietly became two rows each — every Zipline job in his deck shown twice.
  // Retiring the old row would be the expensive error, so it is pointed at the
  // new one instead, and lists show the survivor.
  supersededBy: 'superseded_by',
};

/**
 * Value to write when a job has no such field. The NOT NULL columns need one:
 * a column default only applies when the column is OMITTED, and every write
 * here is positional, so an absent field arrives as an explicit NULL.
 */
const COLUMN_DEFAULTS = {
  url: '', title: '', company: '', team: '', location: '', source: '',
  status: 'new', enrich_fails: 0,
};

/** Fields folded into the compressed detail blob, not stored as columns. */
const DETAIL_FIELDS = ['triage', 'fit', 'apply', 'company_meta', 'salary'];

const KNOWN_FIELDS = new Set([
  ...Object.keys(PLAIN_COLUMNS), ...DETAIL_FIELDS, 'description', 'postedAt',
  // Reconstructed on read, never stored: they would be a second copy of a
  // column, free to drift.
  'hasDesc', 'descLen',
]);

const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  url               TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL DEFAULT '',
  company           TEXT NOT NULL DEFAULT '',
  team              TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'new',
  status_changed_at TEXT,
  first_seen        TEXT,
  last_seen         TEXT,
  enrich_fails      INTEGER NOT NULL DEFAULT 0,
  resume_path       TEXT,
  resume_sent       TEXT,
  deep_requested    TEXT,

  -- derived from triage/fit/salary. Everything the LIST view renders or
  -- filters on is here, so drawing a page never opens a detail blob.
  posted_at         TEXT,
  fit_score         INTEGER,
  fit_band          TEXT,
  fit_band_label    TEXT,
  fit_confidence    TEXT,   -- 'full' | 'partial' | 'title-only', never a number
  fit_blocked       INTEGER NOT NULL DEFAULT 0,
  location_bucket   TEXT,
  relevance         INTEGER NOT NULL DEFAULT 0,
  level             TEXT,
  level_years       INTEGER,
  role_kind         TEXT,
  grad_window       TEXT,
  grad_note         TEXT,
  f_hard_block      INTEGER NOT NULL DEFAULT 0,
  -- WHY a posting is a work-auth block (clearance / us_person / us_citizen /
  -- no_sponsorship / perm_authorization). Home breaks the blocks down by
  -- reason; reading it out of the verdict meant decompressing 5,000 blobs.
  block_key         TEXT,
  f_visa_warning    INTEGER NOT NULL DEFAULT 0,
  f_visa_good       INTEGER NOT NULL DEFAULT 0,
  f_senior          INTEGER NOT NULL DEFAULT 0,
  f_stretch         INTEGER NOT NULL DEFAULT 0,
  f_hands_on        INTEGER NOT NULL DEFAULT 0,
  f_intern          INTEGER NOT NULL DEFAULT 0,
  f_newgrad         INTEGER NOT NULL DEFAULT 0,
  f_grad_mismatch   INTEGER NOT NULL DEFAULT 0,
  salary_min        INTEGER,
  salary_max        INTEGER,
  salary_currency   TEXT,
  -- 'hour' | 'month' | 'year'. min/max are always annualised so one scale
  -- sorts and filters, but a $34/hr job has to READ as $34/hr on the card.
  salary_interval   TEXT,
  -- "a job the user would actually browse", materialised. Defined once, in
  -- isDeck() — the list filters, the Home tiles and the enrichment budget all
  -- read the same column, so two views of one number cannot disagree. It also
  -- makes the default view sortable straight off an index: as an equality on
  -- the leading column it lets SQLite walk fit_score order and stop at 400,
  -- instead of sorting 56,000 rows on every page load.
  deck              INTEGER NOT NULL DEFAULT 0,
  has_desc          INTEGER NOT NULL DEFAULT 0,
  desc_len          INTEGER NOT NULL DEFAULT 0,
  tier              TEXT,
  sponsors_h1b      INTEGER NOT NULL DEFAULT 0,
  -- Which apply adapter can drive this posting, decided from its URL at write
  -- time. Home reports apply reach on every load; deriving it on read meant
  -- pulling 56,000 rows out of the database to run four regexes over each.
  adapter           TEXT,
  applied_at        TEXT,
  apply_filled      INTEGER,
  apply_needs       INTEGER,
  -- Set when a DEAD posting's body was dropped to reclaim space. Without it
  -- the enrichment worker sees "no description" and downloads it again, which
  -- would make pruning a treadmill instead of a saving.
  body_pruned       INTEGER NOT NULL DEFAULT 0,
  gone_at           TEXT
);

-- The full verdict, the fit breakdown, the apply record and any field without
-- a column of its own. One compressed blob per job, read only when a job is
-- opened. Nothing is dropped: a job read back out is the job that went in.
CREATE TABLE IF NOT EXISTS details (
  id     TEXT PRIMARY KEY,
  codec  INTEGER NOT NULL,
  blob   BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS descriptions (
  id     TEXT PRIMARY KEY,
  codec  INTEGER NOT NULL,
  blob   BLOB NOT NULL,
  len    INTEGER NOT NULL
);

-- Shared compression dictionaries, kept IN the database: a dictionary stored
-- anywhere else is a way to lose every description at once.
CREATE TABLE IF NOT EXISTS dicts (kind TEXT PRIMARY KEY, blob BLOB NOT NULL);

CREATE TABLE IF NOT EXISTS meta  (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, json TEXT);

-- Deliberately NO index on url: every lookup goes through jobId(url), which is
-- the primary key. An index on a 106-character column cost 14 MB at 107k jobs
-- to serve queries nothing makes.
CREATE INDEX IF NOT EXISTS jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_company    ON jobs(company);
CREATE INDEX IF NOT EXISTS jobs_band_score ON jobs(fit_band, fit_score DESC);
CREATE INDEX IF NOT EXISTS jobs_score      ON jobs(fit_score DESC);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(first_seen DESC);
CREATE INDEX IF NOT EXISTS jobs_posted     ON jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS jobs_bucket     ON jobs(location_bucket);
CREATE INDEX IF NOT EXISTS jobs_applied_at ON jobs(applied_at DESC);
CREATE INDEX IF NOT EXISTS jobs_browse     ON jobs(status, location_bucket, fit_score DESC);
CREATE INDEX IF NOT EXISTS jobs_deck       ON jobs(deck, fit_score DESC, first_seen DESC);
CREATE INDEX IF NOT EXISTS jobs_deck_new   ON jobs(deck, first_seen DESC);
-- Counting "X of Y" is a separate query from fetching the page, and it has to
-- read nothing but these two columns. Without it the count fell back to a row
-- lookup per match — 54 ms against 6 ms for the page it accompanies.
CREATE INDEX IF NOT EXISTS jobs_deck_stat  ON jobs(deck, status);
-- Home groups the browsable pile by company on every rebuild. Covered, that is
-- 3 ms instead of 62 ms for 2 MB of index — and 62 ms is a full table scan,
-- which is the number that grows with the store.
CREATE INDEX IF NOT EXISTS jobs_deck_co    ON jobs(deck, company);
CREATE INDEX IF NOT EXISTS jobs_source     ON jobs(source, deck);
CREATE INDEX IF NOT EXISTS jobs_adapter    ON jobs(adapter, deck);
CREATE INDEX IF NOT EXISTS jobs_unread     ON jobs(status, f_hard_block, fit_blocked);
CREATE INDEX IF NOT EXISTS jobs_blockkey   ON jobs(block_key);
-- THE DEFAULT VIEW WAS THE SLOWEST QUERY ON THE PAGE.
--
-- The Inbox asks for status IN ('inbox','interested','queued') ordered by fit,
-- and there was an index on status and an index on fit_score but none on both.
-- SQLite picked jobs_score to satisfy the ORDER BY and scanned all 166k rows to
-- return 34 — 2.5 seconds to open the page he lands on, slower than the Library
-- returning a hundred times more.
--
-- jobs_browse looks like it should cover this and does not: location_bucket sits
-- between the two columns, so a query that does not constrain location cannot
-- use the fit_score suffix for ordering.
CREATE INDEX IF NOT EXISTS jobs_status_score ON jobs(status, fit_score DESC);

-- Search has to stay instant. The old dashboard searched an array it had
-- already downloaded; a LIKE scan over a million rows would be a downgrade, so
-- the searchable text is indexed. Only the short fields — the UI does not
-- search descriptions, and indexing them would cost more than the table.
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title, company, team, location,
  content='jobs', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS jobs_fts_ins AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, team, location)
  VALUES (new.rowid, new.title, new.company, new.team, new.location);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_del AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, team, location)
  VALUES ('delete', old.rowid, old.title, old.company, old.team, old.location);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_upd AFTER UPDATE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, team, location)
  VALUES ('delete', old.rowid, old.title, old.company, old.team, old.location);
  INSERT INTO jobs_fts(rowid, title, company, team, location)
  VALUES (new.rowid, new.title, new.company, new.team, new.location);
END;
`;

/**
 * Add columns the schema has gained since this database was built.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * without this a new column means re-running the whole migration — and the
 * JSON file it migrates from will not be there forever. Adding a column with a
 * default is instant in SQLite and never rewrites the table.
 */
function addMissingColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(r => r.name));
  // Only additive, only defaulted: anything needing a backfill is a real
  // migration and belongs in its own script.
  const ADDED = [
    ['body_pruned', 'INTEGER NOT NULL DEFAULT 0'],
    ['salary_interval', 'TEXT'],
    ['gone_at', 'TEXT'],
    // Which industry the posting is actually in. The deck interleaves on this
    // so one employer's req list cannot own the whole first page.
    ['field', 'TEXT'],
    // The posting names required degree disciplines and none are his. Same
    // standing as the graduation window: unwinnable however good the fit.
    ['seen_at', 'TEXT'],
    ['f_degree_mismatch', 'INTEGER NOT NULL DEFAULT 0'],
    ['degree_note', 'TEXT'],
    // Why a posting is in his curated inbox, written when it is put there.
    // The inbox is a lane that has been argued for, so the argument travels
    // with the row rather than living only in a chat message he scrolled past.
    ['pick_note', 'TEXT'],
    // One posting, two URL spellings — see supersededBy above.
    ['superseded_by', 'TEXT'],
  ];
  for (const [name, decl] of ADDED) {
    if (have.has(name)) continue;
    try {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${decl}`);
    } catch (e) {
      // CHECK-then-ALTER is not atomic ACROSS PROCESSES, and this codebase runs
      // several at once by design: the dashboard's auto-scanner, an enrich run
      // and an apply run can all open the store within the same second. Two of
      // them read the same `have` set, both find the column missing, and the
      // loser crashes with "duplicate column name: field" before it has done
      // anything at all.
      //
      // Intermittent, so it looked like a flaky test rather than a fault —
      // store-lock.test.mjs starts three writers simultaneously, which is
      // exactly the situation, and it failed roughly one run in four.
      //
      // The other process already added the column, which is the outcome we
      // wanted. WAL makes concurrent access safe; it does not make a
      // read-then-write sequence atomic. Any OTHER error still throws.
      if (!/duplicate column name/i.test(e?.message || '')) throw e;
    }
  }
}

/**
 * Open (creating if needed) a job database.
 *
 * WAL is what makes the auto-scanner and the dashboard safe to run together:
 * readers never block the writer and the writer never blocks readers, which is
 * exactly the situation the old file lock existed to paper over.
 */
export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // busy_timeout FIRST. Switching to WAL and running the schema both need a
  // brief exclusive lock, and until the timeout is set a contending process
  // fails immediately instead of waiting — which is exactly what happens when
  // the dashboard, a scan child and an apply run start at the same moment.
  db.exec('PRAGMA busy_timeout = 30000');
  // …EXCEPT THAT busy_timeout DOES NOT COVER THIS NEXT LINE.
  //
  // Switching journal_mode takes a lock no busy handler is consulted for:
  // SQLite returns "database is locked" immediately if any other connection is
  // open, timeout or not. The comment above was half right and the half it got
  // wrong is the one that throws — `openDb` died at the WAL line during a full
  // test run, which is the same shape as the dashboard, a scan child and an
  // apply run starting together. A crash on open, in the one function every
  // entry point calls first.
  //
  // The switch is also a ONE-TIME operation: the mode is a property of the
  // database file, so every open after the first is already WAL and needs to do
  // nothing at all. Checking first removes the contention entirely in the
  // common case, and the retry covers the genuine first-time race.
  if (String(db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase() !== 'wal') {
    const until = Date.now() + 5000;
    for (;;) {
      try { db.exec('PRAGMA journal_mode = WAL'); break; } catch (e) {
        if (Date.now() > until || !/lock|busy/i.test(String(e?.message || ''))) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -32000'); // 32 MB of page cache; the hot table fits
  // A WAL THAT NOTHING EVER TRUNCATES GROWS WITHOUT END.
  //
  // Measured 2026-09-20: `jobs.db-wal` at **199,016,632 bytes** — 48,588 pages
  // against a `wal_autocheckpoint` of 1000 (about 4 MB), so forty-eight times
  // the threshold it is supposed to be held at. The main file is not bloat
  // (301,563 job rows, 4,355 free pages); the journal beside it was a fifth of
  // the store again.
  //
  // Two separate causes, and both need saying:
  //
  //   `journal_size_limit = -1` is SQLite's default and means "never shrink the
  //   file". A passive checkpoint can copy every page back into the database
  //   and the 199 MB file still stays 199 MB on disk, ready to be refilled.
  //
  //   A passive autocheckpoint cannot reset the WAL at all while any other
  //   connection holds an older read mark. `logs/dashboard.log` shows 112
  //   server starts in 2.5 days across 6 ports, every one of them opening this
  //   store, so there is almost always a reader.
  //
  // The limit is set on every open because it is per-connection, not stored in
  // the file. It only takes effect when a checkpoint runs, and it never blocks:
  // SQLite truncates if it can and carries on if it cannot.
  db.exec('PRAGMA journal_size_limit = 67108864');   // 64 MB
  // A RUNNING SCAN MUST NOT BREAK EVERY OTHER COMMAND.
  //
  // `db.exec(DDL)` runs on every single open, and it contains CREATE INDEX and
  // CREATE TABLE. While a scan holds the write lock — 166k postings, tens of
  // minutes, entirely normal — those statements wait out busy_timeout and then
  // throw, so `openDb` dies and the dashboard, the CLI and the apply engine all
  // fail to start. Measured: with `jarvis/scan.mjs` running, every query took
  // 32 seconds and then failed.
  //
  // The schema is idempotent and almost always already correct, so a lock here
  // is not a reason to refuse to open a database that is perfectly usable. The
  // exception is a database that does not have the schema yet: there, failing
  // is right, because nothing downstream can work.
  try {
    db.exec(DDL);
  } catch (err) {
    const locked = /lock|busy/i.test(String(err?.message || ''));
    let haveSchema = false;
    try {
      haveSchema = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get();
    } catch { /* cannot even read the catalogue — fall through and rethrow */ }
    if (!locked || !haveSchema) throw err;
    // Schema is there and someone else is writing. Anything genuinely missing
    // gets created by the next open that finds the lock free.
  }
  try {
    addMissingColumns(db);
  } catch (err) {
    if (!/lock|busy/i.test(String(err?.message || ''))) throw err;
  }
  const v = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
  if (!v) db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

// ── dictionaries ────────────────────────────────────────────────────

// THE DICTIONARY WAS RE-READ FROM SQLITE ONCE PER ROW.
//
// `readDetail` falls back to `getDictionary(db, 'detail')` when its caller
// passes no dict, and `fullJob` — which every `full: true` query goes through —
// passes none. So a 134-row `/api/prepared` read the same 110 KB blob out of
// the database 134 times. Measured 2026-09-22:
//
//   getDictionary once                       0.3 ms
//   getDictionary x134 (as shipped)         33.7 ms
//   readDetail x134 as shipped              50.4 ms
//   readDetail x134 with the dict hoisted    9.5 ms
//
// A 7x saving on the detail read, and it scales: `/api/skip-insights` does the
// same thing over 800 and 300 rows.
//
// Memoised HERE rather than at the call sites, because there are many and one
// missed site puts the cost straight back. Keyed by connection in a WeakMap, so
// a closed database is collected normally and two handles never share a cache.
const DICTS = new WeakMap();

export function putDictionary(db, kind, blob) {
  db.prepare('INSERT INTO dicts (kind, blob) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET blob = excluded.blob')
    .run(kind, blob);
  // The only writer, so this is the only place the cache can go stale.
  DICTS.get(db)?.delete(kind);
}

export function getDictionary(db, kind) {
  let perDb = DICTS.get(db);
  if (!perDb) { perDb = new Map(); DICTS.set(db, perDb); }
  // `null` is a real answer — a store with no dictionary of this kind — and is
  // cached like any other, so a miss does not re-query on every row either.
  if (perDb.has(kind)) return perDb.get(kind);
  const row = db.prepare('SELECT blob FROM dicts WHERE kind = ?').get(kind);
  const dict = row ? Buffer.from(row.blob) : null;
  perDb.set(kind, dict);
  return dict;
}

// ── derived columns ─────────────────────────────────────────────────
//
// Everything here is recomputed from the job on every write. It is a cache of
// what triage/fit already decided, existing only so SQL can filter on it —
// never a second source of truth. Derived data going stale is this system's
// characteristic failure, so nothing may be written to these columns that is
// not read straight back out of the job object.

/**
 * `postedAt` is whatever the ATS gave us — epoch milliseconds from Workday, an
 * ISO string from Greenhouse, occasionally a bare date. A text column would
 * render the number 1784237934200 as "1784237934200.0" and hand back a string
 * where the dashboard expects a number, so the original rides along in the
 * detail blob and this normalised copy is what the database sorts on.
 */
export function normalizePosted(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    // Some providers publish seconds, most milliseconds. Anything below this
    // is far too small to be a millisecond timestamp of this decade.
    const d = new Date(v < 1e11 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * "A job the user would actually browse" — the single definition.
 *
 * A work-auth block, a rule he wrote in preferences.md, a technician posting,
 * an internship (he graduates May 2027 and is taking no more), a stated
 * graduation window he falls outside, a role that needs more years than exist
 * in his career, or a country he cannot work in. A job with no verdict at all
 * is not browsable: its bucket is unknown, not eligible.
 */
/**
 * Which apply adapter can drive a posting. Mirrors the ADAPTERS table in
 * apply.mjs — the honest answer to "how much of this pile can Jarvis fill in
 * for me", which Home reports and the queue view filters on.
 */
// A SECOND copy of the apply engine's adapter list, and it had drifted.
//
// `apply.mjs` builds its own list from the driver modules themselves —
// greenhouse, lever, ashby, workday, eightfold, generic — while this one was
// hand-written with four entries and never learned about eightfold. The engine
// could apply to an Eightfold form; the `adapter` column and the coverage stat
// said it could not.
//
// Same defect as ENRICHABLE_SOURCES drifting from the DETAIL registry (F-74)
// and as geo/prefs splitting locations differently (F-14): one question, two
// answers, kept in step by hand.
const ADAPTERS = [
  ['greenhouse', /greenhouse\.io|job-boards\.greenhouse/i],
  ['lever', /jobs\.lever\.co/i],
  ['ashby', /jobs\.ashbyhq\.com/i],
  ['workday', /myworkdayjobs\.com/i],
  // Eightfold is TWO patterns, and restating only the first is what made this
  // list wrong a second time in one sitting. The driver matches either:
  //   *.eightfold.ai/…                              (the hosted domain)
  //   <tenant-domain>/careers/job|apply?…domain=…   (behind the company's own)
  // Micron, Lam Research and Applied Materials all run the second form — which
  // eightfold.mjs's own header calls "the single largest apply gap", ~6,900
  // postings — so missing it here understated coverage by exactly the employers
  // that matter most to him.
  //
  // SOURCE OF TRUTH is `matches()` in jarvis/apply/eightfold.mjs. It is copied
  // rather than imported because that module pulls in the form filler and the
  // browser layer beneath it, and this file runs in the scanner's hot path.
  // If that matcher changes, change it here too.
  ['eightfold', /\.eightfold\.ai\/|\/careers\/(?:job|apply)\b[^?]*\?[^#]*\bdomain=/i],
];
export function adapterFor(jobUrl) {
  for (const [name, re] of ADAPTERS) if (re.test(jobUrl || '')) return name;
  return null;
}

export function isDeck(job) {
  const t = job.triage || {};
  const f = t.flags || {};
  if (!t.locationBucket) return false;
  // Taken down at the source. Enrichment found the ATS answering 403/404/410
  // for this req — Workday's answer for a pulled posting — so it cannot be
  // applied to. The row stays; it just stops being offered.
  if (job.goneAt) return false;
  if (f.hardBlock || f.handsOn || f.internship || f.gradMismatch || f.degreeMismatch) return false;
  if (job.fit?.blockers?.length) return false;
  if (t.experience?.level === 'exclude') return false;
  return ['us', 'remote', 'unknown'].includes(t.locationBucket);
}

/** @param {any} job */
export function derived(job) {
  const t = job.triage || {};
  const f = job.fit || {};
  const flags = t.flags || {};
  const sal = job.salary || {};
  const meta = job.company_meta || {};
  const desc = job.description || '';
  const bool = (v) => (v ? 1 : 0);
  return {
    posted_at: normalizePosted(job.postedAt),
    fit_score: Number.isFinite(f.score) ? Math.round(f.score) : null,
    fit_band: f.band ?? null,
    fit_band_label: f.bandLabel ?? null,
    fit_confidence: f.confidence ?? null,
    field: f.field ?? null,
    fit_blocked: bool(f.blockers && f.blockers.length > 0),
    location_bucket: t.locationBucket ?? null,
    relevance: Math.round(t.relevance?.score ?? 0),
    level: t.experience?.level ?? null,
    level_years: Number.isFinite(t.experience?.years) ? t.experience.years : null,
    role_kind: t.roleKind ?? null,
    // {from, to, quote} — kept as JSON so the promoted copy is the whole
    // thing, quote included, and the list view never has to open the blob.
    grad_window: t.program?.gradWindow ? JSON.stringify(t.program.gradWindow) : null,
    grad_note: t.program?.gradNote == null ? null : String(t.program.gradNote),
    f_hard_block: bool(flags.hardBlock),
    block_key: t.visa?.block?.key ?? (flags.hardBlock ? 'other' : null),
    f_visa_warning: bool(flags.visaWarning),
    f_visa_good: bool(flags.visaGood),
    f_senior: bool(flags.senior),
    f_stretch: bool(flags.stretch),
    f_hands_on: bool(flags.handsOn),
    f_intern: bool(flags.internship),
    f_newgrad: bool(flags.newGrad),
    f_grad_mismatch: bool(flags.gradMismatch),
    f_degree_mismatch: bool(flags.degreeMismatch),
    // The sentence that decided it, promoted so the card can quote it without
    // decompressing the verdict blob — the same reason block_key is promoted.
    degree_note: t.degree?.mismatch
      ? JSON.stringify({ wanted: t.degree.wanted || [], quote: t.degree.quote || '' })
      : null,
    salary_min: Number.isFinite(sal.min) ? Math.round(sal.min) : null,
    salary_max: Number.isFinite(sal.max) ? Math.round(sal.max) : null,
    salary_currency: sal.currency ?? null,
    salary_interval: sal.interval ?? null,
    deck: bool(isDeck(job)),
    has_desc: bool(desc.length > 40),
    desc_len: desc.length,
    tier: meta.tier ?? null,
    sponsors_h1b: bool(meta.sponsors_h1b),
    adapter: adapterFor(job.url),
    applied_at: job.apply?.at ?? null,
    apply_filled: Number.isFinite(job.apply?.filled) ? job.apply.filled : null,
    apply_needs: Array.isArray(job.apply?.needsInput) ? job.apply.needsInput.length : null,
  };
}

const COLUMNS = [...Object.values(PLAIN_COLUMNS), ...Object.keys(derived({}))];

const INSERT_SQL = `INSERT INTO jobs (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ')}`;

/** Turn a job object into the positional row `INSERT_SQL` expects. */
export function jobToRow(job) {
  const d = derived(job);
  const row = [];
  for (const field of Object.keys(PLAIN_COLUMNS)) {
    const v = job[field];
    if (v == null) row.push(COLUMN_DEFAULTS[PLAIN_COLUMNS[field]] ?? null);
    else if (typeof v === 'number') row.push(v);
    else if (typeof v === 'boolean') row.push(v ? 1 : 0);
    else row.push(String(v));
  }
  for (const k of Object.keys(d)) {
    const v = d[k];
    // A derived value that isn't a scalar is a bug in `derived()`, but it must
    // not take a migration down 60,000 rows in: keep the data, flag it here.
    if (v == null || typeof v === 'number' || typeof v === 'string') row.push(v);
    else if (typeof v === 'boolean') row.push(v ? 1 : 0);
    else row.push(JSON.stringify(v));
  }
  return row;
}

/** The part of a job that lives in the compressed blob. */
export function jobToDetail(job) {
  const detail = {};
  for (const k of DETAIL_FIELDS) if (job[k] !== undefined) detail[k] = job[k];
  if (job.postedAt !== undefined) detail.postedAt = job.postedAt;
  for (const k of Object.keys(job)) if (!KNOWN_FIELDS.has(k)) detail[k] = job[k];
  return detail;
}

// A SMARTRECRUITERS URL THE SCANNER BUILT WRONGLY, CORRECTED ON THE WAY OUT
// (F-326).
//
// The scanner used to write `jobs.smartrecruiters.com/<slug>/postings/<id>`,
// which SmartRecruiters answers with 404 FOR LIVE POSTINGS. It stopped writing
// that form, but 14,913 rows already carried it and the store's identity IS
// the url, so they cannot be corrected in place — which is why that entry has
// sat at "Open (root): a URL migration would need new ids".
//
// It does not need one. Measured against the live site 2026-09-18, on a
// posting still open in his deck:
//
//   /Intuitive/postings/744000136300637          -> 404
//   /Intuitive/744000136300637                   -> 200
//   /Intuitive/744000136300637-field-service-…   -> 200
//
// The id alone is enough; the title slug is decoration. So the row keeps the
// url it is identified by, and every READER gets one that opens. Seven of
// these are in his deck today, each a live posting behind a link that would
// have told him it was gone.
const SMARTRECRUITERS_OLD_URL = /^(https:\/\/jobs\.smartrecruiters\.com\/[^/]+)\/postings\/([^/?#]+)(.*)$/;

/** The public URL that actually opens, for a row whose stored one does not. */
export function publicUrl(url) {
  const m = SMARTRECRUITERS_OLD_URL.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}${m[3] || ''}` : url;
}

/**
 * Rebuild a job from its row. Detail and description are separate reads —
 * that is the point of the split — so a listed job carries the promoted
 * columns and nothing heavier.
 */
export function rowToJob(row) {
  if (!row) return null;
  const job = {};
  for (const [field, col] of Object.entries(PLAIN_COLUMNS)) {
    const v = row[col];
    if (v !== null && v !== undefined) job[field] = v;
  }
  if (job.url) job.url = publicUrl(job.url);
  // The list view reads these unconditionally; `undefined` rendered as the
  // string "undefined" in the old dashboard.
  if (job.company == null) job.company = '';
  if (job.team == null) job.team = '';
  if (job.location == null) job.location = '';
  if (job.status == null) job.status = 'new';
  job.hasDesc = row.has_desc === 1;
  job.descLen = row.desc_len ?? 0;
  return job;
}

/**
 * The list-shaped view of a row: everything the dashboard's table and cards
 * render, rebuilt from promoted columns alone. No blob is opened.
 */
export function rowToListItem(row) {
  const job = rowToJob(row);
  // Epoch milliseconds, not the ISO text and not the provider's original: the
  // list renders an age from it ("3w old") and sorts by it. Handing back the
  // stored ISO string made every age read "NaNmo old". The untouched original
  // is still in the detail blob, which is what `getJob` returns.
  job.postedAt = row.posted_at ? Date.parse(row.posted_at) : null;
  // TAKEN DOWN AT THE SOURCE, carried to the list so it can be SEEN.
  //
  // `goneAt` only ever fed `isDeck`, which drops a dead posting out of the pile
  // he is triaging. That is right for the deck and does nothing for the rows he
  // has already picked: his queue and shortlist are filtered by status, not by
  // deck, so a retired posting sits there looking exactly like a live one. Three
  // dead Amazon reqs and two dead Applied Materials reqs were doing that.
  //
  // The row is never hidden — triage flags, it never drops — it just says so.
  job.goneAt = row.gone_at || null;
  // Why this posting is in his curated inbox. A shortlist without its
  // reasoning is just a shorter list — the argument is the product.
  job.pickNote = row.pick_note || null;
  job.supersededBy = row.superseded_by || null;
  job.salary = (row.salary_min != null || row.salary_max != null)
    ? { min: row.salary_min, max: row.salary_max, currency: row.salary_currency || 'USD', interval: row.salary_interval || 'year' }
    : null;
  job.company_meta = (row.tier != null || row.sponsors_h1b)
    ? { tier: row.tier, sponsors_h1b: row.sponsors_h1b === 1 }
    : null;
  job.fit = row.fit_score == null ? null : {
    score: row.fit_score,
    band: row.fit_band,
    bandLabel: row.fit_band_label,
    confidence: row.fit_confidence,
    blocked: row.fit_blocked === 1,
    field: row.field || 'other',
  };
  job.triage = {
    locationBucket: row.location_bucket,
    relevance: { score: row.relevance },
    experience: { level: row.level || 'unknown', years: row.level_years },
    // WHICH work-authorisation rule refused it, not just that one did (F-468).
    // The flag alone makes a card say "blocked" and leaves him to open the
    // posting to find out why; the key is one stored column and turns that
    // into "requires a security clearance".
    blockKey: row.block_key || null,
    roleKind: row.role_kind,
    program: {
      gradWindow: row.grad_window ? JSON.parse(row.grad_window) : null,
      gradNote: row.grad_note,
      internship: row.f_intern === 1,
      newGrad: row.f_newgrad === 1,
    },
    flags: {
      hardBlock: row.f_hard_block === 1,
      visaWarning: row.f_visa_warning === 1,
      visaGood: row.f_visa_good === 1,
      senior: row.f_senior === 1,
      stretch: row.f_stretch === 1,
      handsOn: row.f_hands_on === 1,
      internship: row.f_intern === 1,
      newGrad: row.f_newgrad === 1,
      gradMismatch: row.f_grad_mismatch === 1,
      degreeMismatch: row.f_degree_mismatch === 1,
    },
  };
  // Promoted alongside the flag so the badge can quote the posting without
  // decompressing the verdict blob — a claim this blunt ("you cannot get this
  // job") is only worth making if he can check it against the source.
  if (row.degree_note) {
    try { job.triage.degree = JSON.parse(row.degree_note); } catch { /* pre-migration row */ }
  }
  if (row.applied_at) {
    job.apply = { at: row.applied_at, filled: row.apply_filled, needs: row.apply_needs };
  }
  return job;
}

// ── writes ──────────────────────────────────────────────────────────

export function makeWriters(db) {
  const insertJob = db.prepare(INSERT_SQL);
  const insertDetail = db.prepare(
    'INSERT INTO details (id, codec, blob) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET codec = excluded.codec, blob = excluded.blob');
  const insertDesc = db.prepare(
    'INSERT INTO descriptions (id, codec, blob, len) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET codec = excluded.codec, blob = excluded.blob, len = excluded.len');
  const dropDesc = db.prepare('DELETE FROM descriptions WHERE id = ?');
  const clearDescCols = db.prepare('UPDATE jobs SET has_desc = 0, desc_len = 0 WHERE id = ?');
  const markPruned = db.prepare('UPDATE jobs SET body_pruned = 1 WHERE id = ?');
  // Put has_desc/desc_len back in step with the descriptions table. Used after
  // a write whose caller had no body loaded — see putJob.
  const restoreDescCols = db.prepare(`
    UPDATE jobs SET
      has_desc = COALESCE((SELECT len > 40 FROM descriptions WHERE id = jobs.id), 0),
      desc_len = COALESCE((SELECT len      FROM descriptions WHERE id = jobs.id), 0)
    WHERE id = ?`);
  const touch = db.prepare('UPDATE jobs SET last_seen = ?, status = ? WHERE id = ?');

  let detailDict = getDictionary(db, 'detail');
  let descDict = getDictionary(db, 'description');

  return {
    /** Re-read the dictionaries after they have been (re)built. */
    refreshDictionaries() {
      detailDict = getDictionary(db, 'detail');
      descDict = getDictionary(db, 'description');
    },
    /**
     * Write one job.
     *
     * An empty description NEVER clears a stored one. Scanner payloads are
     * title-only (list APIs carry no body), so a blind write would have the
     * 6-hourly re-scan wipe every description enrichment had fetched — the
     * same shape as the bug where re-scans reset enriched work-auth verdicts.
     */
    putJob(job, opts = {}) {
      insertJob.run(...jobToRow(job));
      const detail = jobToDetail(job);
      const { codec, blob } = compress(JSON.stringify(detail), detailDict);
      insertDetail.run(job.id, codec, blob);
      const desc = job.description || '';
      // `description: false` for passes that read the body only to re-derive
      // from it (re-score, re-triage). The text has not changed, and
      // recompressing 34,000 unchanged postings is most of that run's cost.
      if (desc.length > 0 && opts.description !== false) {
        const c = compress(desc, descDict);
        insertDesc.run(job.id, c.codec, c.blob, desc.length);
      }
      // has_desc/desc_len are DERIVED from job.description, and the row write
      // above just recomputed them from whatever the caller happened to be
      // holding. A pass that loaded the job WITHOUT its body — to fix a title,
      // say — therefore records "no description" for 667 postings that have
      // one, and the deep-read coverage figure drops for no reason. The body
      // itself is untouched, so the truth is one lookup away: take it from the
      // descriptions table rather than from the caller's partial object.
      if (!desc) restoreDescCols.run(job.id);
    },
    /**
     * A re-scan that found nothing new about a job: bump the bookkeeping and
     * leave everything else alone.
     *
     * Most of a scan is this case — the same postings, unchanged — and the
     * whole-record path would recompress a verdict blob per job to write two
     * unchanged timestamps. At ~2,300 compressions a second that is the
     * difference between a scan costing seconds and costing minutes.
     */
    touchJob(id, lastSeen, status) {
      touch.run(lastSeen, status, id);
    },
    /** Drop a body while keeping the job, its verdict and its quotes. */
    dropDescription(id) { dropDesc.run(id); clearDescCols.run(id); markPruned.run(id); },
  };
}

export function readDetail(db, id, dict) {
  const row = db.prepare('SELECT codec, blob FROM details WHERE id = ?').get(id);
  if (!row) return {};
  try { return JSON.parse(decompress(row.blob, row.codec, dict ?? getDictionary(db, 'detail'))); }
  catch { return {}; }
}

export function readDescription(db, id, dict) {
  const row = db.prepare('SELECT codec, blob FROM descriptions WHERE id = ?').get(id);
  if (!row) return '';
  try { return decompress(row.blob, row.codec, dict ?? getDictionary(db, 'description')); }
  catch { return ''; }
}

/** A row plus its detail blob: the whole job, as it went in. */
export function fullJob(db, row, dicts = {}) {
  const job = rowToJob(row);
  if (!job) return null;
  Object.assign(job, readDetail(db, job.id, dicts.detail));
  return job;
}

// ── reads ───────────────────────────────────────────────────────────

/**
 * Build the WHERE clause for a filter set. Every branch here maps to an
 * indexed or promoted column; adding one that doesn't turns a millisecond
 * query into a full scan, which at a million rows is the difference between
 * instant and a visible pause.
 */
/**
 * Recognise the default view and answer it from the `deck` column.
 *
 * The dashboard sends its filters one at a time — not blocked, not a
 * technician role, not an internship, US-eligible — which is precisely the
 * definition of `deck`. Spelled out as five separate conditions the planner
 * cannot use the deck index, so the default view sorted 56,000 rows on every
 * page load (191 ms) instead of walking an index and stopping at 400 (6 ms).
 *
 * The substitution is only safe when the user has not asked to see
 * over-senior roles, since `deck` excludes those too.
 */
function foldIntoDeck(f) {
  const eligible = ['remote', 'unknown', 'us'];
  const loc = [].concat(f.locationBucket || []).slice().sort();
  const isDefault = f.blocked === false && f.fitBlocked === false
    && f.intern === false && f.handsOn === false && f.gradMismatch === false
    && loc.length === 3 && loc.every((v, i) => v === eligible[i])
    && !(f.level || []).includes('exclude');
  if (!isDefault) return f;
  const folded = { ...f, browsable: true };
  delete folded.blocked; delete folded.fitBlocked; delete folded.intern;
  delete folded.handsOn; delete folded.gradMismatch; delete folded.locationBucket;
  return folded;
}

/**
 * Every filter key buildWhere understands.
 *
 * An unknown key used to be ignored in silence, which is the most dangerous
 * possible behaviour for a query builder: the caller gets NO filter rather than
 * the one they asked for, and the result still looks like a valid answer. A
 * liveness sweep written against `{deck: true}` — there is no `deck` key, the
 * column is selected by `browsable` — reported that it was sweeping the deck
 * and swept all 166,136 rows in the store instead.
 *
 * A warning rather than a throw: this runs under the dashboard and the scanner,
 * and turning a typo into a crash mid-scan trades one bad failure for another.
 */
// `search` is consumed by queryJobs itself, not by buildWhere — it joins the
// full-text index rather than adding a WHERE clause — so it belongs in this set
// even though nothing below reads it. It was the first thing the warning fired
// on, and a false warning is worse than none: it teaches you to ignore them.
export const FILTER_KEYS = new Set([
  'search',
  'adapter',
  'band',
  'blocked',
  'blockKey',
  'browsable',
  'company',
  'companyLike',
  'degreeMismatch',
  'excludeCompany',
  'excludeLevel',
  'field',
  'fitBlocked',
  'gradMismatch',
  'handsOn',
  'hasAdapter',
  'hasDesc',
  'hasResume',
  'hasTeam',
  'intern',
  'level',
  'locationBucket',
  'maxScore',
  'minRelevance',
  'minSalary',
  'minScore',
  'needsRead',
  'newGrad',
  'notStatus',
  'postedWithin',
  'prepared',
  'pruned',
  'roleKind',
  'seenBefore',
  'seenSince',
  'senior',
  'since',
  'source',
  'sponsors',
  'status',
  'tier',
  'unseen',
  'includeSuperseded',
]);

function warnUnknownFilters(f) {
  for (const k of Object.keys(f || {})) {
    if (f[k] === undefined || FILTER_KEYS.has(k)) continue;
    console.warn(`[store] ignoring unknown filter "${k}" — it selects NOTHING, so this query is WIDER than intended.`);
  }
}

export function buildWhere(rawFilters = {}) {
  warnUnknownFilters(rawFilters);
  const f = foldIntoDeck(rawFilters);
  const where = [];
  const args = [];
  // Every column is qualified. A search joins `jobs` to the full-text index,
  // which has columns of the same names — an unqualified `company NOT IN (…)`
  // there is "ambiguous column name", and it took down every search that also
  // had a filter on it.
  const c = (col) => `jobs.${col}`;
  const inList = (col, vals) => {
    const list = [].concat(vals);
    where.push(`${c(col)} IN (${list.map(() => '?').join(', ')})`);
    args.push(...list);
  };
  const flag = (col, v) => { if (v === true) where.push(`${c(col)} = 1`); else if (v === false) where.push(`${c(col)} = 0`); };
  const cmp = (col, op, v) => { if (Number.isFinite(v) || (typeof v === 'string' && v)) { where.push(`${c(col)} ${op} ?`); args.push(v); } };

  // A SECOND SPELLING OF A ROW IS NOT A SECOND JOB (F-406). Excluded from
  // every query by default — this is the one filter that is ON unless asked
  // otherwise, because a duplicate card is wrong in every view there is. It
  // hides no posting: the row it points at is the same job, still listed. The
  // maintenance pass that sets the pointer asks for `includeSuperseded` so it
  // can see what it is merging.
  if (f.includeSuperseded !== true) where.push(`${c('superseded_by')} IS NULL`);

  if (f.status) inList('status', f.status);
  if (f.notStatus) {
    const list = [].concat(f.notStatus);
    where.push(`${c('status')} NOT IN (${list.map(() => '?').join(', ')})`);
    args.push(...list);
  }
  if (f.band) inList('fit_band', f.band);
  if (f.locationBucket) inList('location_bucket', f.locationBucket);
  if (f.company) inList('company', f.company);
  if (f.field) inList('field', f.field);
  if (f.level) inList('level', f.level);
  if (f.source) inList('source', f.source);
  // WHY a posting is work-auth blocked. Needed to re-triage exactly the rows a
  // visa fix can change: a classifier correction that un-blocks postings cannot
  // be applied through `browsable`, because the rows it would free are, by
  // definition, not in the deck yet.
  if (f.blockKey) inList('block_key', f.blockKey);
  if (f.roleKind) inList('role_kind', f.roleKind);
  if (f.tier) inList('tier', f.tier);
  if (f.adapter) inList('adapter', f.adapter);
  if (f.hasAdapter === true) where.push(`${c('adapter')} IS NOT NULL`);
  if (f.hasTeam === true) where.push(`${c('team')} != ''`);
  if (f.excludeCompany?.length) {
    where.push(`${c('company')} NOT IN (${f.excludeCompany.map(() => '?').join(', ')})`);
    args.push(...f.excludeCompany);
  }
  if (f.excludeLevel?.length) {
    where.push(`(${c('level')} IS NULL OR ${c('level')} NOT IN (${f.excludeLevel.map(() => '?').join(', ')}))`);
    args.push(...f.excludeLevel);
  }
  if (f.companyLike) { where.push(`${c('company')} LIKE ?`); args.push(`%${f.companyLike}%`); }
  // What the enrichment pass is for: a posting whose body was never read, or a
  // Greenhouse posting with no team label (departments come only from the
  // detail API). Three failures and it is left alone — the auto worker ran
  // every three minutes and would otherwise burn the budget on the same
  // permanently broken postings forever.
  if (f.needsRead === true) {
    where.push(`(${c('enrich_fails')} < 3 AND ${c('body_pruned')} = 0
      AND (${c('has_desc')} = 0 OR (${c('source')} = 'greenhouse' AND ${c('team')} = '')))`);
  }
  flag('body_pruned', f.pruned);
  cmp('fit_score', '>=', f.minScore);
  cmp('fit_score', '<=', f.maxScore);
  cmp('relevance', '>=', f.minRelevance);
  cmp('salary_max', '>=', f.minSalary);
  flag('has_desc', f.hasDesc);
  // `blocked` is the work-authorisation hard block; `fitBlocked` also covers a
  // rule the user wrote in preferences.md ("never 2nd shift"). Two different
  // questions — the dashboard asks the first, the leaderboard the second.
  flag('f_hard_block', f.blocked);
  flag('fit_blocked', f.fitBlocked);
  flag('f_intern', f.intern);
  flag('f_newgrad', f.newGrad);
  flag('f_grad_mismatch', f.gradMismatch);
  flag('f_degree_mismatch', f.degreeMismatch);
  // "Show me things I have not seen" is a different question from "show me
  // things I have not decided": a card he read and moved past is still status
  // 'new', and the deck kept handing it back to him at the top.
  if (f.unseen === true) where.push(`${c('seen_at')} IS NULL`);
  if (f.unseen === false) where.push(`${c('seen_at')} IS NOT NULL`);
  // Postings he has already been shown once. "Show me things I have not seen"
  // is a different question from "show me things I have not decided": a card
  // he read and moved past is still status 'new'.
  if (f.unseen === true) where.push();
  if (f.unseen === false) where.push();
  flag('f_senior', f.senior);
  flag('f_hands_on', f.handsOn);
  flag('sponsors_h1b', f.sponsors);
  if (f.prepared === true) where.push(`${c('applied_at')} IS NOT NULL`);
  if (f.hasResume === true) where.push(`${c('resume_path')} IS NOT NULL AND ${c('resume_path')} != ''`);
  flag('deck', f.browsable);
  cmp('first_seen', '>=', f.since);
  // HOW OLD THE POSTING IS, measured on the same date the card prints: the
  // board's published date, and first seen only when the board published none
  // (dashboard.html `ageOf`). Deriving it differently here would let a card
  // reading "posted 3d ago" disappear from "posted ≤ 7 days".
  //
  // A row carrying NEITHER date is KEPT. Triage flags, it never drops, and a
  // missing field is not evidence of an old posting — the boards that publish
  // no date at all (and every row imported from a browser harvest) would
  // otherwise vanish the moment he asked for fresh jobs, with nothing on
  // screen to say why.
  if (Number.isFinite(f.postedWithin) && f.postedWithin > 0) {
    const age = `COALESCE(NULLIF(${c('posted_at')}, ''), NULLIF(${c('first_seen')}, ''))`;
    where.push(`(${age} IS NULL OR ${age} >= ?)`);
    args.push(new Date(Date.now() - f.postedWithin * 86400000).toISOString());
  }
  cmp('last_seen', '>=', f.seenSince);
  // The other direction: postings NOT verified since a date. This is what a
  // liveness sweep selects on — the oldest rows, not the best-fitting ones.
  cmp('last_seen', '<=', f.seenBefore);

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const SORTS = {
  fit: 'fit_score DESC, first_seen DESC',
  new: 'first_seen DESC',
  posted: 'posted_at DESC',
  relevance: 'relevance DESC, fit_score DESC',
  company: 'company ASC, title ASC',
  salary: 'salary_max DESC',
  applied: 'applied_at DESC',
  // Oldest-verified first, so a bounded liveness sweep always works on the
  // postings most likely to have died since anyone last looked.
  stalest: 'last_seen ASC',
};

function ftsQuery(search) {
  // Prefix matching, so typing "nvid" finds NVIDIA the way the old
  // client-side substring filter did.
  return String(search).split(/\s+/).filter(Boolean)
    .map(t => `"${t.replace(/"/g, '')}"*`).join(' ');
}

/**
 * A page of jobs plus the total that matched.
 *
 * The total is a separate COUNT rather than rows.length because the whole
 * point is that the caller receives a page: the header's "showing X of Y" has
 * to be the real Y, not the size of the page.
 */
export function queryJobs(db, filters = {}, opts = {}) {
  const { sql: whereSql, args } = buildWhere(filters);
  const order = SORTS[opts.sort] || SORTS.fit;
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
  const offset = Math.max(0, opts.offset ?? 0);
  const shape = opts.full ? (row) => fullJob(db, row) : rowToListItem;
  const search = String(filters.search || '').trim();

  if (search) {
    const q = ftsQuery(search);
    const joined = whereSql ? whereSql.replace(/^WHERE /, 'AND ') : '';
    const rows = db.prepare(
      `SELECT jobs.* FROM jobs_fts JOIN jobs ON jobs.rowid = jobs_fts.rowid
       WHERE jobs_fts MATCH ? ${joined} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(q, ...args, limit, offset);
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM jobs_fts JOIN jobs ON jobs.rowid = jobs_fts.rowid
       WHERE jobs_fts MATCH ? ${joined}`,
    ).get(q, ...args).n;
    return { rows: rows.map(shape), total: Number(total) };
  }

  const rows = db.prepare(`SELECT * FROM jobs ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  // THE COUNT COSTS 14x THE PAGE IT ANNOTATES.
  //
  // Measured 2026-09-22 on the default Library filters: the 400 rows take
  // 11.3ms against an index, and `COUNT(*)` over the same WHERE takes 159ms
  // median and 2.3s at worst, because no index can serve a count over a
  // filtered scan of 385k rows.
  //
  // It is skipped when the page is SHORT — fewer rows came back than were
  // asked for, so this is the last page and the true total is already known
  // exactly. That is the common case for every decided view (Inbox, Hidden,
  // Applications) and it costs nothing to be right about.
  //
  // A FULL page still pays for it, because "Show N more" needs a real number
  // and guessing one would put a button on screen that does nothing, or hide
  // rows he has. `countTotal: false` lets a caller that shows no such button
  // skip it outright.
  const short = rows.length < limit;
  const total = (opts.countTotal === false || short)
    ? offset + rows.length
    : Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(...args).n);
  return { rows: rows.map(shape), total };
}

/**
 * Walk every job matching a filter without ever holding them all.
 *
 * This replaces `Object.values(store.jobs)`, which materialised the entire
 * store — about 4 GB of live heap at a million jobs. `full: true` attaches
 * each job's detail blob, which is what the re-score and re-triage passes
 * need; leaving it off keeps the walk to the promoted columns.
 */
export function* iterateJobs(db, filters = {}, opts = {}) {
  const { sql: whereSql, args } = buildWhere(filters);
  const dicts = { detail: getDictionary(db, 'detail') };
  for (const row of db.prepare(`SELECT * FROM jobs ${whereSql}`).iterate(...args)) {
    yield opts.full === false ? rowToListItem(row) : fullJob(db, row, dicts);
  }
}

/** Group counts for one column, computed by the database. */
export function countBy(db, column, filters = {}) {
  const allowed = new Set(['status', 'fit_band', 'location_bucket', 'company', 'level', 'source', 'role_kind', 'tier', 'adapter', 'block_key']);
  if (!allowed.has(column)) throw new Error(`countBy: ${column} is not an indexed column`);
  const { sql: whereSql, args } = buildWhere(filters);
  const out = {};
  for (const r of db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM jobs ${whereSql} GROUP BY ${column}`).all(...args)) {
    out[r.k ?? 'unknown'] = Number(r.n);
  }
  return out;
}

export function countJobs(db, filters = {}) {
  const search = String(filters.search || '').trim();
  const { sql: whereSql, args } = buildWhere(filters);
  if (search) {
    const joined = whereSql ? whereSql.replace(/^WHERE /, 'AND ') : '';
    return Number(db.prepare(
      `SELECT COUNT(*) AS n FROM jobs_fts JOIN jobs ON jobs.rowid = jobs_fts.rowid WHERE jobs_fts MATCH ? ${joined}`,
    ).get(ftsQuery(search), ...args).n);
  }
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`).get(...args).n);
}

export { CODEC, HAS_ZSTD, compress, decompress };
