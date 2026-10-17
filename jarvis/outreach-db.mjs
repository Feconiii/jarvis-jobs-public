/**
 * OUTREACH'S OWN FILE — `outreach.db`, beside `jobs.db` in the store folder.
 *
 * The contact ledger and the Outreach button's research runs used to live in
 * `jobs.db`, and every write to them is a person pressing a button. A scan
 * holds that file's write lock for minutes at a time (F-483: 20,000 postings
 * per locked chunk), and SQLite's busy wait gives up after 30 seconds — so
 * pressing Outreach during a scan froze the dashboard for 30 seconds and then
 * said "database is locked" (F-597, Fluidstack, 2026-09-25).
 *
 * Nothing here joins against the jobs table in SQL; every caller reads a job
 * through the store and the outreach rows through this file. So they can live
 * apart, and a scan can never make a press wait.
 *
 * The first open copies the rows that were already in `jobs.db` across, once.
 * The old tables are left where they were, unread.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import { dbPath as storeDbPath } from './store.mjs';

/** Resolved per call, like the store's own path, so JARVIS_DATA_DIR is honoured. */
export const outreachDbPath = () => path.join(path.dirname(storeDbPath()), 'outreach.db');

const OPENED = new Map();

/**
 * One connection per file per process, with `ddl` applied the first time a
 * module asks. `legacy` names the tables to carry over from `jobs.db`.
 */
export function outreachDb(dbPath = outreachDbPath(), { ddl = '', legacy = [] } = {}) {
  let entry = OPENED.get(dbPath);
  if (!entry) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const handle = new DatabaseSync(dbPath);
    handle.exec('PRAGMA busy_timeout = 5000');
    if (String(handle.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase() !== 'wal') {
      handle.exec('PRAGMA journal_mode = WAL');
    }
    handle.exec('PRAGMA synchronous = NORMAL');
    handle.exec('CREATE TABLE IF NOT EXISTS carried_over (tbl TEXT PRIMARY KEY, at TEXT NOT NULL, rows INTEGER NOT NULL)');
    entry = { handle, schemas: new Set() };
    OPENED.set(dbPath, entry);
  }
  if (ddl && !entry.schemas.has(ddl)) {
    entry.handle.exec(ddl);
    for (const t of legacy) carryOver(entry.handle, t, dbPath);
    entry.schemas.add(ddl);
  }
  return entry.handle;
}

/**
 * Copy one table's rows out of `jobs.db`, once. Read-only on the old file: a
 * reader never waits on a scan under WAL. Columns are matched by name, so a
 * table that gained a column here still takes the old rows.
 */
function carryOver(handle, table, dbPath) {
  if (handle.prepare('SELECT 1 FROM carried_over WHERE tbl = ?').get(table)) return;
  const old = path.join(path.dirname(dbPath), 'jobs.db');
  let rows = 0;
  if (existsSync(old)) {
    const src = new DatabaseSync(old, { readOnly: true });
    try {
      src.exec('PRAGMA busy_timeout = 5000');
      const there = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      if (there) {
        const mine = new Set(handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
        const cols = src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).filter((c) => mine.has(c));
        const put = handle.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        handle.exec('BEGIN');
        try {
          for (const r of src.prepare(`SELECT ${cols.join(',')} FROM ${table}`).all()) { put.run(...cols.map((c) => r[c])); rows += 1; }
          handle.exec('COMMIT');
        } catch (e) { handle.exec('ROLLBACK'); throw e; }
      }
    } finally { src.close(); }
  }
  handle.prepare('INSERT INTO carried_over (tbl, at, rows) VALUES (?, ?, ?)').run(table, new Date().toISOString(), rows);
}
