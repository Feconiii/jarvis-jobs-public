/**
 * THE TRAVELLING-REQUISITION LOOKUP, OFF THE SERVER'S THREAD (F-1032, 2026-11-07).
 *
 * A page the store cannot place by its address is asked one last question:
 * does any stored posting carry the same requisition id under another host (a
 * Greenhouse gh_jid on a company's own site)? That is a pass over every URL in
 * the store, `url LIKE '%<token>%'` over the URL index: 3.4 s cold, 0.3-0.4 s
 * warm on 1,094,948 rows (measured 2026-11-07). On the server's one thread it
 * stalled every request behind it: his Warren CAT form on UKG (3.3 s of a
 * 3.5 s plan), and the first plan after a boot (6.3 s).
 *
 * The same query runs here, in a worker with its own read-only connection.
 * The server keeps answering while it runs and keeps each answer for the
 * session (serve.mjs, travelLookup).
 */
import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { crossTenant } from './req-id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The extension's own requisition extractors, loaded as serve.mjs loads them. */
export function loadAts() {
  const ctx = { URL };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(HERE, 'extension', 'ats.js'), 'utf-8'), ctx);
  return ctx.__jarvisAts || null;
}

/**
 * The stored posting that names `url`'s requisition under any host, or null.
 * Every extractor lifts the id out of the URL as a literal substring, so a
 * stored URL with this requisition contains it (discover.test.mjs holds the
 * extractors to that); a token under 4 characters, or with nothing to filter
 * on, takes the full walk. The same number on another employer's tenant is
 * another posting (F-714).
 */
export function travellingMatch(db, ats, url) {
  const want = ats?.reqToken?.(url);
  if (!want) return null;
  const raw = String(want).replace(/^[a-z0-9-]+:/i, '');
  const byRowid = db.prepare('SELECT id FROM jobs WHERE rowid = ?');
  if (raw.length >= 4) {
    const esc = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
    for (const row of db.prepare("SELECT rowid AS rid, url FROM jobs INDEXED BY jobs_url_nocase WHERE url LIKE ? ESCAPE '\\'").iterate(`%${esc}%`)) {
      if (ats.reqToken(row.url) === want && !crossTenant(url, row.url)) return byRowid.get(row.rid)?.id ?? null;
    }
    return null;
  }
  for (const row of db.prepare('SELECT id, url FROM jobs').iterate()) {
    if (ats.reqToken(row.url) === want && !crossTenant(url, row.url)) return row.id;
  }
  return null;
}

if (parentPort) {
  let db = null; let ats = null;
  parentPort.on('message', ({ seq, url, dbPath }) => {
    try {
      if (!db) db = new DatabaseSync(dbPath, { readOnly: true });
      if (!ats) ats = loadAts();
      const t = Date.now();
      const id = travellingMatch(db, ats, url);
      parentPort.postMessage({ seq, id, ms: Date.now() - t });
    } catch (e) {
      parentPort.postMessage({ seq, error: String(e?.message || e) });
    }
  });
}
