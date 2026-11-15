// F-1021: NO FULL PASS OVER THE JOBS TABLE ON THE SERVER'S THREAD.
//
// node:sqlite is synchronous, so a query in serve.mjs that reads every row
// stops every request until it ends. The store is 2.8 GB; on 2026-11-06 the
// Tesla page lookup (`url LIKE '%tesla.com/%…'`) read all of it on each panel
// and fill request — 1.6 s on an idle disk, 72-90 s while the enricher and the
// runway reader were writing — and the extension "took forever to fill tesla".
//
// Every literal query serve.mjs prepares is planned here against the real
// schema, with its own arguments (a template's ${…} filled with a word), and
// any plan that SCANs jobs fails — unless it is listed below with the reason
// it is cheap enough. Aggregates over the whole store belong in
// overview-worker.mjs, which has its own thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Scans that are allowed on the server's thread, by a fragment of their SQL, each with why. */
const ALLOWED = [
  // The mail matcher's distinct company names: a covering-index pass (0.25 s), kept a minute (F-860).
  { sql: 'SELECT DISTINCT company FROM jobs', why: 'covering index on company, cached 60 s' },
  // The travelling-requisition pass (`url LIKE '%token%'`) and its short-token walk left this thread
  // for requisition-worker.mjs (F-1032: 3.4 s cold on 1.1 M rows); they are no longer allowed here.
];

/** A JS string literal's body as the running code sees it ('\\' is one backslash). */
const unescapeJs = (s) => s.replace(/\\(.)/g, '$1');

/** Each `.prepare(<literal>)…get|all|iterate(<args>)` in a source file, with the line it starts on. */
export function literalQueries(src) {
  const out = [];
  const re = /\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1\s*\)\s*(?:\.(get|all|iterate|run)\(([^()]*(?:\([^()]*\)[^()]*)*)\))?/g;
  let m;
  while ((m = re.exec(src))) {
    const [, quote, sql, , args = ''] = m;
    if (quote === '`' && sql.includes('${')) continue;   // built at run time: not checkable here
    if (!/\bFROM\s+jobs\b/i.test(sql)) continue;
    out.push({ sql: unescapeJs(sql), args, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Arguments as the planner will see them: string literals kept, templates' ${…} filled, anything else a plain word. */
export function argValues(args) {
  const vals = [];
  const re = /`((?:\\.|[^`])*)`|'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"|([^,`'"]+)/g;
  let m;
  while ((m = re.exec(args))) {
    if (m[4] !== undefined) { if (m[4].trim()) vals.push(/^\s*\.\.\./.test(m[4]) ? null : 'x'); continue; }
    const s = m[1] ?? m[2] ?? m[3];
    vals.push(unescapeJs(s.replace(/\$\{[^}]*\}/g, 'x')));
  }
  return vals.filter((v) => v !== null);
}

/** The plan's lines that read every row of jobs. */
export function fullScans(handle, sql, args) {
  const n = (sql.match(/\?/g) || []).length;
  const vals = Array.from({ length: n }, (_, i) => args[i] ?? 'x');
  return handle.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...vals)
    .map((r) => String(r.detail))
    .filter((d) => /^SCAN jobs\b/.test(d));
}

test('the old Tesla page lookup is a full pass, which is what this test exists to catch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-sql-'));
  const handle = openDb(path.join(dir, 'jobs.db'));
  try {
    const old = "SELECT id, superseded_by FROM jobs WHERE url LIKE ? AND url NOT LIKE '%/apply/%' AND source != 'extension' ORDER BY last_seen DESC LIMIT 1";
    assert.ok(fullScans(handle, old, ['%tesla.com/%careers/search/job/%-271234']).length);
  } finally { handle.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('no query serve.mjs runs on its own thread reads the whole jobs table', () => {
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-sql-'));
  const handle = openDb(path.join(dir, 'jobs.db'));
  try {
    const found = literalQueries(src);
    assert.ok(found.length > 10, `found only ${found.length} queries — the extractor is broken`);
    const bad = [];
    for (const q of found) {
      if (ALLOWED.some((a) => q.sql.trim() === a.sql)) continue;
      let scans;
      try { scans = fullScans(handle, q.sql, argValues(q.args)); } catch (e) { bad.push(`serve.mjs:${q.line} does not plan (${e.message}): ${q.sql.slice(0, 120)}`); continue; }
      if (scans.length) bad.push(`serve.mjs:${q.line} ${scans.join('; ')}: ${q.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    assert.deepEqual(bad, []);
  } finally { handle.close(); rmSync(dir, { recursive: true, force: true }); }
});
