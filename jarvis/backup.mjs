#!/usr/bin/env node
// jarvis/backup.mjs — save the part of Jarvis that cannot be rebuilt.
//
//   node jarvis/backup.mjs                 # write jarvis-backup/jarvis-backup.json
//   node jarvis/backup.mjs --private       # …including your address / EEO answers
//   node jarvis/backup.mjs --restore <file># put decisions back onto a rebuilt store
//
// The job store is 396 MB and almost none of it is precious. Every posting
// comes back from a scan, every description from a re-read, every score is
// recomputed from cv.md and profile.yml. Backing that up is backing up a
// cache.
//
// What no scan can bring back is what YOU did: the jobs you marked interested,
// queued, applied, rejected; what the apply engine filled and when; which
// companies you hid; why you skipped things. Plus the files you wrote — your
// CV, your profile, your preferences, and portals.yml, which holds hundreds of
// verified ATS endpoints that took real work to resolve.
//
// That is a couple of hundred kilobytes. It fits in a private repo, on any
// stick, in an email. This writes exactly that, and can put it back.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { db, each, getJob, putJob, getScans, hiddenCompanies, setCompanyHidden, setStatus, updateJob, recordScan, jobId } from './store.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  npm run jarvis:backup -- [options]
  
    Copy his decisions and hand-written files into jarvis-backup/.
  
      --out <dir>   where to write the backup
      --private     include the files that are gitignored
      --restore     restore FROM a backup instead of making one
      --help, -h    print this
`;

// F-162: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--out","--private","--restore"], valued: ["--out","--restore"] });


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'jarvis-backup');

const args = process.argv.slice(2);
const includePrivate = args.includes('--private');
const restoreFlag = args.indexOf('--restore');
// Where the file goes. Overridable so a test cannot overwrite the real backup
// with its own fixture — which is exactly what happened the first time.
const outFlag = args.indexOf('--out');
const OUT_FILE = outFlag !== -1 && args[outFlag + 1]
  ? path.resolve(args[outFlag + 1])
  : path.join(OUT_DIR, 'jarvis-backup.json');

/** The files you wrote. Small, hand-made, and not in git. */
const USER_FILES = [
  'cv.md',
  'config/profile.yml',
  'portals.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'jarvis/preferences.md',
  'article-digest.md',
  // The answer writer learns from these two (2026-09-23): his kept and
  // rejected answers, and the stories that are in no other file.
  'Alex_Open_Ended_Application_Answer_Corpus.md',
  'interview-prep/stories.md',
];

/**
 * Your address, phone and the EEO answers you gave (gender, race, veteran,
 * disability). Left out unless asked for: a backup that lives in a repo should
 * not carry them by default, however private that repo is meant to be.
 */
const PRIVATE_FILES = ['data/jarvis/apply-profile.yml'];

/**
 * What contact data is ACTUALLY in the bundle, whatever the flag claims.
 *
 * `includesPrivate` used to be a straight copy of `--private`, which only ever
 * governed `apply-profile.yml`. But `cv.md` and `config/profile.yml` are
 * bundled ALWAYS, and both carry his email and phone — so a default backup was
 * written, and committed, stamped `includesPrivate: false` while containing the
 * very things the README promises are "deliberately not in it".
 *
 * A flag that asserts a fact about a file's contents will eventually be wrong
 * about them. This measures the finished bundle instead, so the stamp cannot
 * drift from the bytes it describes.
 */
const CONTACT_PATTERNS = [
  ['an email address', /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
  // Parentheses or explicit separators required, so a bare ten-digit posting id
  // in portals.yml is not announced as his phone number.
  ['a phone number', /(\+1[\s.-]?)?\(\d{3}\)\s*\d{3}[\s.-]?\d{4}|\b\d{3}[.-]\d{3}[.-]\d{4}\b/],
  ['a street address', /\b\d+\s+[A-Za-z.]+\s+([A-Za-z]+\s+)?(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|court|ct|boulevard|blvd)\b/i],
];

/** Which bundled files carry contact data, and what kind. */
export function contactDataIn(files) {
  const found = new Map();
  for (const [rel, content] of Object.entries(files || {})) {
    for (const [what, re] of CONTACT_PATTERNS) {
      if (!re.test(String(content))) continue;
      if (!found.has(what)) found.set(what, new Set());
      found.get(what).add(rel);
    }
  }
  return found;
}

/** A job is worth saving if you touched it in any way. */
function isYours(job) {
  return (job.status && job.status !== 'new')
    || job.apply || job.resume_path || job.resume_sent
    || job.deepRequested || job.skipFeedback;
}

function backup() {
  const jobs = [];
  for (const job of each()) {
    if (!isYours(job)) continue;
    // The whole record, so a decision survives even if the posting is gone
    // and a future scan never finds it again.
    jobs.push(job);
  }

  const files = {};
  const wanted = includePrivate ? [...USER_FILES, ...PRIVATE_FILES] : USER_FILES;
  for (const rel of wanted) {
    const full = path.join(ROOT, rel);
    if (existsSync(full)) files[rel] = readFileSync(full, 'utf-8');
  }

  const payload = {
    kind: 'jarvis-backup',
    version: 1,
    at: new Date().toISOString(),
    // Context, so a restore can report what it is putting back.
    counts: { jobs: jobs.length, files: Object.keys(files).length },
    // Measured from the bundle, not copied from the flag. See contactDataIn.
    includesPrivate: includePrivate || contactDataIn(files).size > 0,
    hiddenCompanies: hiddenCompanies(),
    scans: getScans(20),
    jobs,
    files,
  };

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);

  console.log(`\n── Backup ──`);
  console.log(`  Decisions saved : ${jobs.length} jobs you acted on`);
  console.log(`  Hidden companies: ${payload.hiddenCompanies.length}`);
  console.log(`  Files saved     : ${Object.keys(files).join(', ') || 'none'}`);
  // Names the FILE, because the old wording ("your address / EEO answers")
  // read as a promise about the whole bundle and the warning below contradicts
  // it — cv.md carries his phone whatever this flag does.
  if (!includePrivate) console.log(`  Left out        : ${PRIVATE_FILES.join(', ')} — your EEO answers (--private to include)`);

  // Say what is in it, in the place where he will act on it. The old message
  // said only what was left out, which read as a guarantee about the rest.
  const carried = contactDataIn(files);
  if (carried.size) {
    console.log(`\n  ⚠ This bundle still carries:`);
    for (const [what, where] of carried) console.log(`      ${what} — in ${[...where].join(', ')}`);
    console.log(`    Keep it out of version control. It is gitignored for that reason.`);
  }
  console.log(`  Size            : ${kb} KB → ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`\n  Not saved, because a scan rebuilds it: every posting, every`);
  console.log(`  description, every score.\n`);
}

function restore(file) {
  const payload = JSON.parse(readFileSync(file, 'utf-8'));
  if (payload.kind !== 'jarvis-backup') throw new Error('not a jarvis backup file');

  let applied = 0, missing = 0, restoredFiles = 0;
  for (const saved of payload.jobs) {
    const id = saved.id || jobId(saved.url);
    if (!getJob(id)) {
      // The posting is gone or has not been re-scanned yet. Put the whole
      // record back rather than dropping the decision on the floor.
      putJob(saved);
      missing++;
    }
    if (saved.status && saved.status !== 'new') setStatus(id, saved.status);
    const patch = {};
    // `goneAt` IS ON THIS LIST, and it was the one thing here that a scan
    // cannot rebuild.
    //
    // It was already being SAVED — 9 records carried it — and then silently
    // dropped on the way back in, because the restore only copied the six keys
    // below. Proven by round-trip on a temp store: status survived, the verdict
    // did not.
    //
    // That matters most for the verdicts that cost the most to get. The
    // liveness sweep can re-derive an API 404 on the next run, but a posting
    // retired because HE opened it in his signed-in browser and the page said
    // it was gone (F-251) is exactly the evidence no scan produces — headless
    // checks cannot tell that from a bot block (F-250). Losing it on restore
    // sends him back to a posting he has already discovered is dead.
    //
    // `closed_note` joins them after a sweep of every key the backup SAVES
    // against every key it puts back. Twenty-two were saved and not restored;
    // twenty are scan-derived (triage, fit, salary, firstSeen…) and one,
    // `applied_at`, is only the column form of `apply.at`, which is restored.
    // The last is a hand-written verification — "requisition closed — gone from
    // KLA API, verified 2026-07-31". Nothing writes that field any more, which
    // is precisely why losing it would be permanent.
    for (const k of ['apply', 'resume_path', 'resume_sent', 'deepRequested', 'skipFeedback', 'statusChangedAt', 'goneAt', 'closed_note']) {
      if (saved[k] !== undefined) patch[k] = saved[k];
    }
    if (Object.keys(patch).length) updateJob(id, patch);
    applied++;
  }
  for (const name of payload.hiddenCompanies || []) setCompanyHidden(name, true);
  for (const s of [...(payload.scans || [])].reverse()) recordScan(s);

  for (const [rel, text] of Object.entries(payload.files || {})) {
    const full = path.join(ROOT, rel);
    // Never overwrite a file that exists: a restore is for a machine that lost
    // them, not a way to silently roll your CV back to an older draft.
    if (existsSync(full)) { console.log(`  kept existing  ${rel}`); continue; }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    restoredFiles++;
    console.log(`  restored       ${rel}`);
  }

  console.log(`\n── Restore ──`);
  console.log(`  Decisions put back : ${applied} (${missing} for postings not currently in the store)`);
  console.log(`  Files written      : ${restoredFiles}`);
  console.log(`  Backup taken       : ${payload.at}\n`);
}

// ONLY WHEN RUN AS A COMMAND. This used to execute on import, so a test that
// imported one pure helper from this file silently ran a full backup against
// his real store and OVERWROTE jarvis-backup/jarvis-backup.json — and, sharing
// the store with the rest of the suite, hung it. A test run must never write
// his data.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (restoreFlag !== -1) {
    const file = args[restoreFlag + 1];
    if (!file || !existsSync(file)) { console.error('Usage: node jarvis/backup.mjs --restore <file>'); process.exit(1); }
    db();
    restore(file);
  } else {
    db();
    backup();
  }
}
