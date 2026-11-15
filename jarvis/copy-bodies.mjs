#!/usr/bin/env node
// jarvis/copy-bodies.mjs — a board row with no body takes one from its copy (F-978).
//
// dedupe.mjs points each copy of a posting (LinkedIn, Simplify, Handshake) at
// the board row it copies: `superseded_by`. The board row is the one the screen
// and the reader judge, and 10,674 of them were waiting for a body the enricher
// had not fetched yet, while a copy beside some of them already held one.
//
// A body is taken only from a row that points at this one, only when this row's
// own body is missing or thin and the copy's is not, and the longest such copy
// wins. It is written through updateJob(..., { rederive: true }), the enricher's
// path, so triage, the visa gate, the pay parse and fit all run on it, and the
// row says where it came from (body_from = 'copy:<id>'). The board's own text,
// when the enricher fetches it, replaces it and the marker drops.
//
//   node jarvis/copy-bodies.mjs            # dry run: what would be filled
//   node jarvis/copy-bodies.mjs --write    # fill them

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, getDescription, updateJob, withStoreLock, clearDescription } from './store.mjs';
import { isThinBody } from './picks.mjs';
import { htmlToText } from './text.mjs';
import { THIN_BODY } from './db.mjs';
import { guardArgs } from './cli.mjs';

/** A body the screen can judge: long enough and with a requirements section. */
export const usableBody = (text) => {
  const t = htmlToText(String(text || '')).trim();
  return t.length >= THIN_BODY && !isThinBody(t);
};

// A POINTER IS CHECKED BEFORE IT IS TRUSTED (review, 2026-11-04): the copy must
// name the same employer and a similar title, so a wrong superseded_by can
// never feed another posting's text into rederive.
export { sameEmployer, similarTitle } from './same-posting.mjs';
import { couldBeOnePosting } from './same-posting.mjs';

/**
 * Pure. `keeps`: [{ id, company, title, body }] board rows; `copies`: [{ id, keep, company, title, body }]
 * rows pointing at them. Returns [{ id, from, body }] for every board row whose
 * body is unusable and that has a copy with a usable one (the longest).
 */
export function planCopyBodies(keeps, copies) {
  const keepOf = new Map(keeps.map((k) => [k.id, k]));
  const best = new Map();
  for (const c of copies) {
    if (!c.keep || !usableBody(c.body)) continue;
    const k = keepOf.get(c.keep);
    if (!k || !couldBeOnePosting(k, c)) continue;
    const cur = best.get(c.keep);
    if (!cur || String(c.body).length > String(cur.body).length) best.set(c.keep, c);
  }
  const out = [];
  for (const k of keeps) {
    const c = best.get(k.id);
    if (!c || usableBody(k.body)) continue;
    out.push({ id: k.id, from: c.id, fromSource: c.source || '', body: String(c.body) });
  }
  return out;
}

/** Read the pairs from the store (read-only connection; bodies through the store). */
export function readPairs(file = dbPath()) {
  const h = new DatabaseSync(file, { readOnly: true });
  try {
    const copies = h.prepare(`SELECT c.id, c.superseded_by AS keep, c.company, c.title, c.url, c.source FROM jobs c
      WHERE c.superseded_by IS NOT NULL AND c.desc_len >= ${THIN_BODY}`).all();
    const keepIds = [...new Set(copies.map((c) => c.keep))];
    const get = h.prepare(`SELECT id, company, title, url FROM jobs WHERE id = ? AND gone_at IS NULL AND superseded_by IS NULL`);
    const keeps = [];
    for (const id of keepIds) {
      const r = get.get(id);
      if (r) keeps.push({ id: r.id, company: r.company, title: r.title, url: r.url, body: getDescription(r.id) || '' });
    }
    const wanted = new Set(keeps.filter((k) => !usableBody(k.body)).map((k) => k.id));
    const withBodies = copies.filter((c) => wanted.has(c.keep)).map((c) => ({ ...c, body: getDescription(c.id) || '' }));
    return { keeps: keeps.filter((k) => wanted.has(k.id)), copies: withBodies };
  } finally { h.close(); }
}

/** Rows holding a borrowed body whose copy no longer passes the guard (another employer or title). */
export function failingBorrows(file = dbPath()) {
  const h = new DatabaseSync(file, { readOnly: true });
  try {
    const get = h.prepare('SELECT company, title, url FROM jobs WHERE id = ?');
    return h.prepare('SELECT id, company, title, url, body_from FROM jobs WHERE body_from IS NOT NULL').all()
      .filter((r) => { const c = get.get(String(r.body_from).replace(/^copy:/, '')); return !c || !couldBeOnePosting(r, c); })
      .map((r) => r.id);
  } finally { h.close(); }
}

/** Fill them. Each write is its own short lock, so a scan is never held up for long. */
export async function fillFromCopies({ write = false, file = dbPath(), now = new Date().toISOString(), log = () => {} } = {}) {
  // A body borrowed through a pointer that fails the guard goes first: the row
  // waits for its own board's text again (clearDescription rederives it).
  const failing = failingBorrows(file);
  let cleared = 0;
  if (write) for (const id of failing) { if (await withStoreLock(() => clearDescription(id))) { cleared += 1; log(`${id}: borrowed body cleared (its copy names another employer or title)`); } }
  const { keeps, copies } = readPairs(file);
  const plan = planCopyBodies(keeps, copies);
  let filled = 0;
  if (write) {
    for (const p of plan) {
      const body = htmlToText(p.body).trim();
      const done = await withStoreLock(() => updateJob(p.id, { description: body, bodyFrom: { id: p.from, source: p.fromSource, at: now, chars: body.length } }, { rederive: true }));
      if (done) { filled += 1; log(`${p.id} ← ${p.from} (${body.length} chars)`); }
    }
  }
  return { candidates: keeps.length, plan: plan.length, filled, failing: failing.length, cleared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --help, or an unknown flag, prints this and does nothing (cli.test: no consequential command unguarded).
  guardArgs({ usage: 'node jarvis/copy-bodies.mjs [--write]   (dry run without --write: what would be filled)', flags: ['--write'] });
  const write = process.argv.includes('--write');
  const r = await fillFromCopies({ write, log: write ? (l) => console.log(`  ${l}`) : () => {} });
  console.log(`${r.candidates} board rows without a usable body have a copy with one; ${r.plan} can take it${write ? `; ${r.filled} filled` : ' (dry run — --write fills them)'}.`);
  if (r.failing) console.log(`${r.failing} borrowed bodies came through a pointer that fails the employer/title check${write ? `; ${r.cleared} cleared` : ''}.`);
}
