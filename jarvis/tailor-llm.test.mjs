/**
 * THE CLI'S REFUSAL IS NOT AN ANSWER (F-456).
 *
 * Every "ask Claude" click on his apply panel came back `answer call failed
 * (exit 1)` and nothing else. The nested `claude` CLI had spent the model his
 * account defaults to and said so — on STDOUT, with an empty stderr and exit 1.
 * `run()` dropped stdout on a non-zero exit and `describeFailure` read only
 * stderr, so the one sentence naming the problem was thrown away at both ends.
 *
 * These tests drive the REAL `run()` against a node script standing in for the
 * CLI, because the bug lived in the plumbing around the spawn and a mock of the
 * spawn would have passed the whole time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

import { run, runOnce, describeFailure, CLI_MODELS, LIMIT_MESSAGE, buildTailorPrompt } from './tailor-llm.mjs';
import { buildSpec, loadPool } from './resume-variants.mjs';

const LIMIT = "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

test('LIMIT_MESSAGE recognises what the CLI actually prints', () => {
  assert.ok(LIMIT_MESSAGE.test(LIMIT));
  assert.ok(LIMIT_MESSAGE.test("You've reached your Opus limit."));
  // And not an ordinary answer that happens to discuss limits.
  assert.equal(LIMIT_MESSAGE.test('I tested the fixture to its load limit.'), false);
});

test('THE REASON SURVIVES — a refusal printed on stdout is not swallowed', () => {
  // The exact shape of the live failure: exit 1, message on stdout, stderr empty.
  const e = Object.assign(new Error('exit 1'), { code: 1, stdout: LIMIT, stderr: '' });
  const said = describeFailure(e, 'claude', 'answer', 150000);
  assert.match(said, /out of credit/, 'he must be told the account is out, not "exit 1"');
  assert.match(said, /Fable limit/, "and told in the CLI's own words");
  assert.match(said, /JARVIS_CLI_MODEL/, 'and told what to do about it');
});

test('an ordinary crash still reads as one', () => {
  const e = Object.assign(new Error('exit 2'), { code: 2, stderr: 'TypeError: boom' });
  assert.match(describeFailure(e, 'claude', 'tailoring', 1000), /tailoring call failed \(exit 2\).*boom/);
  assert.match(describeFailure({ code: 'ENOENT' }, 'claude', 'tailoring', 1000), /not on PATH/);
  assert.match(describeFailure({ killed: true }, 'claude', 'tailoring', 30000), /timed out after 30s/);
});

test('the model list is explicit — no call inherits whatever his account defaults to', () => {
  assert.ok(CLI_MODELS.length >= 1);
  assert.ok(!CLI_MODELS.includes(''), 'an empty entry would send the CLI a bare --model');
});

// ── the real spawn ──────────────────────────────────────────────────
//
// A stand-in for the CLI: it reads --model, and answers the way the real one
// does — the spent model prints its refusal on stdout and exits 1.
const DIR = mkdtempSync(path.join(tmpdir(), 'jarvis-cli-'));
const FAKE = path.join(DIR, 'claude.mjs');
writeFileSync(FAKE, `
const i = process.argv.indexOf('--model');
const model = i > 0 ? process.argv[i + 1] : '(default)';
if (model === 'spent' || model === '(default)') {
  process.stdout.write(${JSON.stringify(LIMIT)});
  process.exit(1);
}
process.stdout.write('answered by ' + model);
`);

// `run` only injects a model for the claude CLI — it is named by basename, so
// the stand-in has to BE named `claude`. On Windows that means the .cmd shim,
// which is the shape the real CLI has here and the reason `run` shells out at
// all. CLI_MODELS is read once at import, so the list has to be set in a child
// process's environment rather than this one's.
const SHIM = path.join(DIR, 'claude.cmd');
writeFileSync(SHIM, `@echo off\r\nnode "${FAKE}" %*\r\n`);

// The driver goes in a FILE, not `node -e`: on Windows `run` shells out, and a
// multi-line argument does not survive cmd.exe.
const DRIVER = path.join(DIR, 'drive.mjs');
writeFileSync(DRIVER, `
import { run, describeFailure } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'tailor-llm.mjs')).href)};
try {
  const out = await run(${JSON.stringify(SHIM)}, ['-p'], { input: '', timeout: 20000 });
  process.stdout.write('OK:' + out.stdout.trim());
} catch (e) {
  process.stdout.write('FAIL:' + describeFailure(e, 'claude', 'answer', 20000));
}
`);

const askWith = (models) => runOnce(process.execPath, [DRIVER], { timeout: 30000, env: { ...process.env, JARVIS_CLI_MODEL: models } });

test('A SPENT MODEL MOVES TO THE NEXT ONE', { skip: process.platform !== 'win32' && 'the .cmd shim is the Windows shape' }, async () => {
  const { stdout } = await askWith('spent,sonnet');
  assert.match(stdout, /^OK:answered by sonnet$/,
    'one exhausted model must not take the feature down while a working one is next in the list');
});

test('WHEN EVERY MODEL IS SPENT IT FAILS — it never returns the refusal as the answer', { skip: process.platform !== 'win32' && 'the .cmd shim is the Windows shape' }, async () => {
  // On exit 0 the refusal IS the whole of stdout, and the writers hand stdout
  // to a form box. "You've reached your Fable limit" must never be typed into
  // one of his applications.
  const { stdout } = await askWith('spent');
  assert.match(stdout, /^FAIL:/);
  assert.match(stdout, /out of credit/);
  assert.doesNotMatch(stdout, /^OK:/);
});

test('the spawn carries stdout onto the error', async () => {
  // CLI_MODELS is read at import, so this drives runOnce the way run does and
  // asserts the shape run depends on: the refusal is on stdout, exit 1.
  await assert.rejects(
    () => runOnce(process.execPath, [FAKE, '-p', '--model', 'spent'], { input: '', timeout: 20000 }),
    (e) => {
      assert.equal(e.code, 1);
      assert.match(String(e.stdout), /reached your Fable limit/, 'stdout must travel with the error');
      assert.equal(String(e.stderr), '', 'and stderr is empty, which is why stderr alone was not enough');
      return true;
    },
  );
  // The working model answers.
  const ok = await runOnce(process.execPath, [FAKE, '-p', '--model', 'sonnet'], { input: '', timeout: 20000 });
  assert.equal(ok.stdout, 'answered by sonnet');
});

test('EVERY CALL NAMES ITS MODEL — an unnamed model is what broke', async () => {
  const out = await runOnce(process.execPath, [FAKE, '-p', '--model', 'opus'], { input: '', timeout: 20000 });
  assert.equal(out.stdout, 'answered by opus');
  // Without --model the stand-in behaves like his account did: refuses.
  await assert.rejects(() => runOnce(process.execPath, [FAKE, '-p'], { input: '', timeout: 20000 }));
});

test('a non-claude binary passes through untouched — the tests drive node through run()', async () => {
  const out = await run(process.execPath, ['-e', 'process.stdout.write("plain")'], { timeout: 20000 });
  assert.equal(out.stdout, 'plain', 'run() must not append --model to node');
});

console.log('tailor-llm: CLI failure reporting OK');

// ── the other direction (2026-09-22) ─────────────────────────────────
//
// His instruction: "everything on resume should earn its keep". The prompt has
// always pushed COVERAGE — what the posting asked for and the page must prove.
// It never pushed the opposite, and the measurement says that is the side that
// slipped: across his last fifty sent resumes each page covered 49% of the
// terms its posting named while carrying 23 to 33 the posting never mentioned.
//
// So the prompt now carries a measured brief of BOTH directions, computed from
// the posting's own nouns rather than from the model's paraphrase of them. What
// must not happen is that brief quietly disappearing in a refactor, because
// nothing else in the pipeline pushes back on excess.
test('the prompt tells the model what the posting named and the draft misses', () => {
  const spec = buildSpec('automation', loadPool());
  const jd = 'You will commission Fanuc and ABB robots, program Allen-Bradley PLCs, '
    + 'apply Six Sigma and Lean, and use networking fundamentals (TCP/IP, DNS).';
  const p = buildTailorPrompt({ spec, job: { company: 'Acme', title: 'Robotics Engineer' }, jd, pool: loadPool() });
  assert.match(p, /Measured on this posting: it names \d+ concrete terms/);
  assert.match(p, /NAMED BY THE POSTING, NOT ON THE DRAFT:.*PLC/);
  assert.match(p, /ON THE DRAFT, NOT ASKED FOR:/);
  // And the rule that makes the brief safe: a term is only worth putting on
  // when the menu genuinely proves it. Without this it is keyword-stuffing.
  assert.match(p, /if anything in the menu\s+proves one/);
});

// HIS CORRECTION, 2026-09-23: "even after all bullets hit the jd great if we
// still have some space we should put the next relevant thing on there, so
// unrequested terms are not necessarily a bad thing". The brief of 2026-09-22
// told the model the unasked terms were "what pays for" coverage and to drop
// them. Coverage comes first; after it, relevant filler is wanted.
test('a line the posting never named is not a fault once the posting is covered', () => {
  const p = buildTailorPrompt({ spec: buildSpec('automation', loadPool()), job: { company: 'Acme', title: 'Robotics Engineer' },
    jd: 'Use SolidWorks and GD&T; apply Six Sigma.', pool: loadPool() });
  assert.match(p, /next most relevant/);
  assert.match(p, /is NOT a fault/);
  assert.doesNotMatch(p, /what pays for it/);
});

test('his section order and his grammar reach the writer (2026-09-23)', () => {
  const p = buildTailorPrompt({ spec: buildSpec('automation', loadPool()), job: { company: 'Acme', title: 'Engineer' },
    jd: 'Use SolidWorks.', pool: loadPool() });
  assert.match(p, /acme NEVER has fewer lines than makerspace/);
  assert.match(p, /full grammar/);
  assert.match(p, /No dangling modifiers/);
  assert.match(p, /6-DOF/);
  assert.doesNotMatch(p, /6 DOF/);
});

test('a posting that names nothing concrete says so, instead of an empty list', () => {
  const spec = buildSpec('automation', loadPool());
  const p = buildTailorPrompt({
    spec, job: { company: 'Acme', title: 'Engineer' },
    jd: 'We are a fast-paced team that values ownership and impact. Bring your whole self to work.',
    pool: loadPool(),
  });
  assert.match(p, /names no concrete tools or methods/);
  assert.doesNotMatch(p, /NOT ON THE DRAFT: \(none\)/);
});
