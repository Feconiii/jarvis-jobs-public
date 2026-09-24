/**
 * The shared argument guard, and a survey that every consequential command uses it.
 *
 * F-162 was `--help` opening four real applications. The survey afterwards found
 * that NOT ONE command in this project handled `--help` — every one of them ran
 * instead, including the ones that write to the job store or VACUUM it. So the
 * fix is a shared guard, and the last test here is the one that matters most: it
 * fails when a new command is added without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { guardArgs } from './cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Run the guard without letting it kill the test process. */
function guard(argv, { flags = ['--limit'], valued = ['--limit'] } = {}) {
  const said = { log: [], error: [] };
  let exited = null;
  guardArgs({
    usage: 'USAGE TEXT',
    flags,
    valued,
    argv,
    exit: (c) => { exited = c; },
    out: { log: (m) => said.log.push(m), error: (m) => said.error.push(m) },
  });
  return { exited, out: said.log.join('\n'), err: said.error.join('\n') };
}

test('--help prints and exits before anything can happen', () => {
  const r = guard(['--help']);
  assert.equal(r.exited, 0);
  assert.match(r.out, /USAGE TEXT/);
});

test('-h does the same', () => {
  assert.equal(guard(['-h']).exited, 0);
});

test('an unknown flag stops the run with a non-zero exit', () => {
  const r = guard(['--limt', '3']);
  assert.equal(r.exited, 2, 'a typo is a failure, not a default');
  assert.match(r.err, /Unknown option: --limt/);
  assert.match(r.err, /Nothing was run/);
});

test('every unknown flag is named, not just the first', () => {
  const r = guard(['--nope', '--alsonope']);
  assert.match(r.err, /--nope/);
  assert.match(r.err, /--alsonope/);
});

test('a known flag and its value pass through untouched', () => {
  assert.equal(guard(['--limit', '5']).exited, null, 'nothing exits, the script continues');
});

test('a VALUE that looks like a flag is still a value', () => {
  // `--company --weird-name` is a company called "--weird-name".
  const r = guard(['--company', '--weird-name'], { flags: ['--company'], valued: ['--company'] });
  assert.equal(r.exited, null);
});

test('a boolean flag does NOT swallow the next token', () => {
  // `--dry-run --nonsense` must still catch --nonsense: --dry-run takes no value.
  const r = guard(['--dry-run', '--nonsense'], { flags: ['--dry-run'], valued: [] });
  assert.equal(r.exited, 2);
  assert.match(r.err, /--nonsense/);
});

test('bare arguments are not flags and are left alone', () => {
  assert.equal(guard(['https://example.test/job/1'], { flags: [], valued: [] }).exited, null);
});

test('no arguments at all is the normal case', () => {
  assert.equal(guard([]).exited, null);
});

// --- the survey, which is the point of the file ---------------------------

/**
 * Commands that DO something — write to the store, hit the network, open a
 * browser, rewrite files. A new one added without the guard fails here.
 */
const CONSEQUENTIAL = [
  'apply.mjs',              // opens real applications — this is F-162 itself
  'scan.mjs',               // hits company ATS APIs and writes the store
  'prune.mjs',              // retires rows and VACUUMs the database
  'backup.mjs',             // writes his decisions out to disk
  'enrich.mjs',             // network, and writes descriptions
  'build-resumes.mjs',      // rewrites the four PDFs he sends to employers
  'liveness-sweep.mjs',     // network, and retires postings
  'migrate-store.mjs',      // rewrites the store's schema
  'rekey-jobids.mjs',       // recomputes every job id
  'fix-titles.mjs',         // rewrites stored titles
  'clean-descriptions.mjs', // rewrites stored descriptions
  'rescore.mjs',            // recomputes every fit score
  'retriage.mjs',           // re-runs triage across the store
  'compact-store.mjs',      // rewrites the store file
  'discover-ats.mjs',       // network
  '../check-liveness.mjs',  // network, and the one command outside jarvis/
];

test('every consequential command refuses --help rather than running', () => {
  for (const name of CONSEQUENTIAL) {
    const src = readFileSync(path.join(HERE, name), 'utf-8');
    const guarded = src.includes('guardArgs') || /--help/.test(src);
    assert.ok(guarded, `${name} does not handle --help — asking it what it does will make it do it`);
  }
});

test('and refuses an unrecognised flag rather than falling back to defaults', () => {
  for (const name of CONSEQUENTIAL) {
    const src = readFileSync(path.join(HERE, name), 'utf-8');
    const refuses = src.includes('guardArgs') || /Unknown option/.test(src);
    assert.ok(refuses, `${name} would treat a typo as "proceed with defaults"`);
  }
});


test('no consequential command is MISSING from this list', () => {
  // The survey above only protects the commands it names. This one notices when
  // a NEW script appears that mutates the store, hits the network or opens a
  // browser and was never added — which is how the habit comes back.
  const MUTATES = /withStoreLock|putJob\(|updateJob\(|setStatus|upsertJobs\(|dropDescription\(|chromium\.launch|await fetch\(/;
  const EXEMPT = new Set([
    'cli.mjs', 'serve.mjs', 'db.mjs', 'store.mjs', 'deck.mjs', 'fit.mjs', 'triage.mjs',
    'resume.mjs', 'resume-variants.mjs', 'resume-family.mjs', 'resume-tailor.mjs',
    'resume-for-job.mjs', 'tailor-llm.mjs', 'apply-plan.mjs', 'open-in-chrome.mjs',
    'json-stream.mjs', 'prefs.mjs', 'geo.mjs', 'degree.mjs', 'field.mjs',
    'skip-learn.mjs', 'import-assist.mjs', 'liveness-api.mjs',
  ]);

  const missing = [];
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    if (name.startsWith('_') || EXEMPT.has(name)) continue;
    const src = readFileSync(path.join(HERE, name), 'utf-8');
    // Only scripts that RUN on their own — a library reads no argv.
    if (!/process\.argv/.test(src)) continue;
    if (!MUTATES.test(src)) continue;
    if (src.includes('guardArgs')) continue;
    missing.push(name);
  }
  assert.deepEqual(missing, [],
    `these read argv, they do something, and --help would run them: ${missing.join(', ')}`);
});

/**
 * NO COMMAND MAY RUN ITSELF ON IMPORT.
 *
 * The sibling of the --help fault above, and it bites harder. A module that
 * calls `main()` at the top level executes the moment anything imports it — and
 * a test that wants one pure helper out of a command module is a completely
 * reasonable thing to write.
 *
 *   F-181  a test imported one helper from backup.mjs; the import ran a full
 *          backup against his real store and OVERWROTE jarvis-backup.json,
 *          then hung the suite holding the same 429 MB store.
 *   F-182  apply.mjs did the same, and importing it would have opened a real
 *          browser and started filling real applications.
 *
 * Seven more were unguarded when this test was written, including the three
 * that mutate the job store (compact, migrate, rescore) and the scanner.
 *
 * This is the test that fails when a new command is added without the guard.
 */
test('EVERY COMMAND ONLY RUNS WHEN INVOKED AS ONE', () => {
  const ROOT = path.resolve(HERE, '..');
  const files = [
    ...readdirSync(HERE).filter((f) => f.endsWith('.mjs')).map((f) => path.join(HERE, f)),
    ...readdirSync(ROOT).filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, f)),
  ].filter((f) => !f.endsWith('.test.mjs'));

  const unguarded = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf-8');
    // A top-level call to main() — at column 0, so a call nested inside the
    // guard block (which is indented) does not count.
    if (!/^(await main\(\)|main\(\))/m.test(src)) continue;
    if (!src.includes('pathToFileURL(process.argv[1])')) {
      unguarded.push(path.relative(ROOT, file).split(path.sep).join('/'));
    }
  }

  assert.deepEqual(unguarded, [],
    `these run themselves on import — wrap main() in `
    + `\`if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)\`:\n  `
    + unguarded.join('\n  '));
});
