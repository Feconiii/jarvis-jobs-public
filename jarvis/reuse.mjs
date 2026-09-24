/**
 * REUSE — a resume or an answer already written for a posting is not written
 * again.
 *
 * Alex, 2026-09-15: "sometimes application times out or i forget about it, i
 * come back and nothing is filled, when i press fill again the resume gets
 * rewritten meanwhile it was already created and stored … we need to enable
 * jarvis jobs to reuse resumes and answers if jd is the same as previous
 * posting it has already applied to."
 *
 * Three ways a finished build used to be thrown away:
 *   1. Pressing Apply on the dashboard started a build every time, finished or
 *      not.
 *   2. A finished build lived only in the server's memory, so a dashboard
 *      restart forgot it and the next fill paid for the whole build again.
 *   3. The same description under a second posting id — a repost, the same req
 *      in two cities — was a stranger.
 *
 * So a finished build is written down: a SNAPSHOT of the PDF (the canonical
 * file is named company + title and a second posting with the same title
 * overwrites it), plus everything the panel and the form need about it. It is
 * handed back when:
 *
 *   · it is for this posting, or for a posting at the same company whose
 *     description is the same once formatting, dates and req numbers are set
 *     aside; and
 *   · cv.md, cv-short.md and the bullet pool are what they were when it was
 *     built. A resume built before he added the Mars Rover Team is not his
 *     resume any more, and reusing it would quietly undo the change.
 *
 * "Build it again" and "Change the resume" still build a new one — reuse is the
 * default, never a lock.
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Shorter than this, "the same description" is too little text to mean the same job. */
export const MIN_JD_CHARS = 400;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

/**
 * One key for "the same job description at the same company". Formatting,
 * digits (req ids, dates, pay figures, counts) and punctuation are set aside;
 * the words are not. Null when there is not enough text to say.
 */
export function jdKey(company, description) {
  const text = String(description || '');
  if (text.replace(/\s+/g, ' ').trim().length < MIN_JD_CHARS) return null;
  const words = text.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
  const co = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${co}:${sha(words)}`;
}

/** The files a resume is made from. A change to any of them means a new resume. */
export function sourcesVersion(files = [
  path.join(ROOT, 'cv.md'),
  path.join(ROOT, 'cv-short.md'),
  path.join(HERE, 'resume-pool.json'),
]) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.split(/[\\/]/).pop());
    try { h.update(readFileSync(f)); } catch { h.update('missing'); }
  }
  return h.digest('hex').slice(0, 24);
}

// ── resume builds ────────────────────────────────────────────────────

const recordFile = (dir, id) => path.join(dir, `${String(id).replace(/[^a-z0-9-]/gi, '')}.json`);
const snapshotFile = (dir, id) => path.join(dir, `${String(id).replace(/[^a-z0-9-]/gi, '')}.pdf`);

/**
 * Keep a finished build. `record` is what the server needs to restore its
 * application context without building: family, titles, the lines it leads
 * with, the tailoring report, the checklist.
 */
export function saveBuild(dir, id, record) {
  if (!id || !record?.pdfPath || !existsSync(record.pdfPath)) return null;
  mkdirSync(dir, { recursive: true });
  const snapshot = snapshotFile(dir, id);
  copyFileSync(record.pdfPath, snapshot);
  const saved = { ...record, id: String(id), snapshot, savedAt: new Date().toISOString() };
  writeFileSync(recordFile(dir, id), `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}

function readRecord(file) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf-8'));
    return r && r.snapshot && existsSync(r.snapshot) ? r : null;
  } catch { return null; }
}

/**
 * A build that can stand in for building this one, or null.
 *
 * This posting's own build first; then the newest build for a DIFFERENT posting
 * with the same description key. Both must have been made from the current CV.
 */
export function findReusableBuild(dir, { id, jdKey: key, sources }) {
  if (!existsSync(dir)) return null;
  const own = readRecord(recordFile(dir, id));
  // Its own build is reused when the description has not changed under it.
  // A build made with no description (key null) is not reused for a posting
  // that now has one — that build had nothing to tailor towards.
  if (own && own.sources === sources && own.jdKey === key) return { record: own, sameJob: true };
  if (!key) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const r = readRecord(path.join(dir, name));
    if (!r || r.id === String(id) || r.jdKey !== key || r.sources !== sources) continue;
    if (!best || String(r.savedAt) > String(best.savedAt)) best = r;
  }
  return best ? { record: best, sameJob: false } : null;
}

/**
 * Put a kept build back where the form uploads from: a copy of the snapshot at
 * the file name this posting's resume would have had.
 */
export function restoreBuild(found, pdfPath) {
  mkdirSync(path.dirname(pdfPath), { recursive: true });
  copyFileSync(found.record.snapshot, pdfPath);
  return pdfPath;
}

// ── answers ──────────────────────────────────────────────────────────

/**
 * The other postings an answer could be borrowed from: every job id with saved
 * answers (or a saved build) whose description key matches this one.
 *
 * `describe(id) → { company, description }` is the store, injected. Keys are
 * computed once per id and kept; answer files do not change job.
 */
export function makeSiblingIndex({ answerDir, buildDir, describe }) {
  const keyOf = new Map();
  const idsIn = (dir, re) => {
    try { return readdirSync(dir).map((n) => (n.match(re) || [])[1]).filter(Boolean); } catch { return []; }
  };
  return function siblingsOf(id, key) {
    if (!key) return [];
    const ids = new Set([
      ...idsIn(answerDir, /^([a-z0-9]+)-[0-9a-f]+\.json$/i),
      ...idsIn(buildDir, /^([a-z0-9]+)\.json$/i),
    ]);
    const out = [];
    for (const other of ids) {
      if (other === String(id)) continue;
      if (!keyOf.has(other)) {
        const d = describe(other);
        keyOf.set(other, d ? jdKey(d.company, d.description) : null);
      }
      if (keyOf.get(other) === key) out.push(other);
    }
    return out;
  };
}
