/**
 * The command line, which can open real applications at real employers.
 *
 * This file exists because of one measurement: `node jarvis/apply.mjs --help`
 * printed no help. It fell straight through the argument parser, took the
 * default limit of fifteen, launched a browser and began opening live postings.
 * ASKING THE SCRIPT WHAT IT DOES MADE IT DO IT.
 *
 * Every test here runs the real CLI as a subprocess and asserts on what it does
 * BEFORE any browser could start, because that is the only place the difference
 * between "explained itself" and "started applying" is observable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'apply.mjs');

/** Run the CLI and capture everything, including a non-zero exit. */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 30000, windowsHide: true });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: e.stdout || '', err: e.stderr || '' };
  }
}

/** Did this run get as far as opening a browser? */
const startedApplying = (r) => /Opening \d+ application|Starting your persistent Chrome|Attached to your persistent Chrome/i.test(r.out + r.err);

test('--help explains itself and opens NOTHING', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /npm run jarvis:apply/);
  assert.match(r.out, /NEVER submits/i, 'the one rule belongs in the usage text');
  assert.ok(!startedApplying(r), 'asking what it does must not make it do it');
});

test('-h works too', async () => {
  const r = await cli(['-h']);
  assert.match(r.out, /--company/);
  assert.ok(!startedApplying(r));
});

test('AN UNKNOWN FLAG STOPS THE RUN', async () => {
  // A typo must never open applications at real employers.
  const r = await cli(['--limt', '3']);
  assert.notEqual(r.code, 0, 'a typo is a failure, not a default');
  assert.match(r.err, /Unknown option: --limt/);
  assert.match(r.err, /Nothing was run/, 'the shared guard wording');
  assert.ok(!startedApplying(r));
});

test('several unknown flags are all named', async () => {
  const r = await cli(['--nope', '--alsonope']);
  assert.match(r.err, /--nope/);
  assert.match(r.err, /--alsonope/);
  assert.ok(!startedApplying(r));
});

test('a real flag and its value are not mistaken for a typo', async () => {
  // --company takes a value; the value must not be read as an unknown flag, and
  // a company with no queued jobs must stop cleanly rather than open anything.
  const r = await cli(['--company', 'nosuchcompanyanywhere', '--limit', '1']);
  assert.match(r.out + r.err, /Nothing to apply to/i);
  assert.ok(!startedApplying(r));
});

test('a value that LOOKS like a flag is still a value', async () => {
  const r = await cli(['--company', '--weird-name', '--limit', '1']);
  assert.ok(!/Unknown option/.test(r.err), '--weird-name is the value of --company, not a flag');
  assert.ok(!startedApplying(r));
});

test('the usage text points at the browser flow, which is the one he uses', async () => {
  const r = await cli(['--help']);
  assert.match(r.out, /jarvis:serve/);
  assert.match(r.out, /Jarvis button/i);
});

test('every browser flag the engine reads is accepted', async () => {
  // The header comment documented --login, --connect and --chrome-profile, and
  // a first pass at the guard listed only the four flags in the usage text —
  // which would have rejected browser flags this engine has always taken.
  // Documentation is not an inventory; the source is.
  const src = readFileSync(CLI, 'utf-8');
  const read = new Set([...src.matchAll(/(?:argv|a)\.(?:includes|indexOf)\('(--[a-z-]+)'\)|get\('(--[a-z-]+)'\)/g)]
    .map((m) => m[1] || m[2]));
  const declared = new Set(JSON.parse(src.match(/const FLAGS = (\[[^\]]+\])/s)[1].replace(/'/g, '"')));
  const missing = [...read].filter((f) => !declared.has(f));
  assert.deepEqual(missing, [], `apply.mjs reads these but the guard would reject them: ${missing.join(', ')}`);
});

/**
 * The one sentence this engine has to be trusted about.
 *
 * `watchForSubmissions` kept ONE set and put two different things in it: a tab
 * that had been submitted, and a tab the process could no longer watch. So a
 * lost tab was announced as a submitted one. Measured on Gradient Robotics,
 * 2026-09-01 — "All watched applications submitted" printed five times while the
 * tab sat open at /application with Submit untouched and the store still reading
 * `queued`.
 */
test('THE WORD "submitted" IS NEVER PRODUCED BY A LOST TAB', async () => {
  const { watchSummary } = await import('./apply.mjs');

  assert.equal(watchSummary(1, 0, 1), '\n  All 1 watched application submitted. Ctrl+C to exit.');
  assert.equal(watchSummary(3, 0, 3), '\n  All 3 watched applications submitted. Ctrl+C to exit.');

  // The exact shape of the fault: every tab lost, none submitted.
  const allLost = watchSummary(0, 5, 5);
  assert.ok(!/\bsubmitted\b/.test(allLost), `said "submitted" about tabs it lost: ${allLost}`);
  assert.match(allLost, /lost track/i);
  assert.match(allLost, /nothing was marked applied/i, 'he has to be told the tracker was not updated');

  // Mixed: the count must be honest about both halves.
  const mixed = watchSummary(2, 1, 3);
  assert.match(mixed, /2 submitted/);
  assert.match(mixed, /1 lost track of/);
  assert.match(mixed, /not marked applied/);

  // Still working: no closing line at all, so nothing to reprint every 4s.
  assert.equal(watchSummary(0, 0, 2), '');
  assert.equal(watchSummary(1, 0, 2), '');
});

test('importing the apply engine does not START an apply run', async () => {
  // main() used to be called unconditionally at import, so importing this
  // module to test one helper would launch a browser against real postings.
  // F-181 was the same mistake in backup.mjs, where it overwrote his backup.
  const src = readFileSync(CLI, 'utf-8');
  assert.match(src, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
    'apply.mjs must only run main() when invoked as a command');
});
