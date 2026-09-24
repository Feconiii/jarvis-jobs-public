/**
 * The answer audit — the sweep that found F-220, as a command.
 *
 * Six bugs in this project have had one shape: a rule matching a phrase while
 * the question asks something else. Five were found by tripping over them; the
 * sixth was found by resolving every label from five live forms in one pass and
 * READING the column of answers.
 *
 * These tests do not open a browser. What is worth pinning is that the command
 * obeys the conventions this project has paid for — `--help` must not run
 * anything (F-162), an unknown flag must stop the run (F-163), and importing it
 * must do nothing at all (F-182) — and that its output makes a wrong answer
 * visible rather than burying it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'audit-answers.mjs');

test('--help prints and runs nothing', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help']);
  assert.match(stdout, /--queued/);
  assert.match(stdout, /fills nothing/, 'it must say it is read-only');
  assert.ok(!/###/.test(stdout), 'no form may be opened by --help');
});

test('an unknown flag stops the run, with a non-zero exit', async () => {
  // F-163: `--help` and a typo must both be dead ends. The non-zero exit is
  // half the point — a script that runs this in a loop has to be able to tell.
  await assert.rejects(() => run(process.execPath, [CLI, '--bogus']), (e) => {
    // The refusal goes to stderr, which is where a refusal belongs: piping
    // stdout to another command must not carry an error message into it.
    const said = String(e.stderr) + String(e.stdout);
    assert.match(said, /Unknown option/);
    assert.match(said, /Nothing was run/);
    assert.notEqual(e.code, 0, 'a rejected flag must not look like success');
    return true;
  });
});

test('with no target it refuses rather than guessing one', async () => {
  await assert.rejects(() => run(process.execPath, [CLI]), (e) => {
    assert.match(String(e.stderr), /Nothing to audit/);
    return true;
  });
});

test('IMPORTING IT OPENS NOTHING', async () => {
  // F-182: apply.mjs used to launch a browser on import. This command opens
  // real pages, so the same mistake here would open five of them.
  const src = readFileSync(CLI, 'utf-8');
  assert.match(src, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
  const mod = await import(pathToFileURLString(CLI));
  assert.equal(typeof mod.audit, 'function', 'and it still exports something useful');
});

function pathToFileURLString(p) {
  return new URL(`file:///${p.split(path.sep).join('/')}`).href;
}

test('IT NEVER TYPES, AND CLICKS ONLY TO NAVIGATE', () => {
  // The promise is that this is safe to point at a real application. It has to
  // follow Apply to reach a form at all — his queue holds postings — so it
  // cannot be "no clicks". The guarantee is narrower and has to be stated
  // exactly: nothing is TYPED, nothing is ATTACHED, and the only things clicked
  // are the Apply control and Workday's start gate.
  const src = readFileSync(CLI, 'utf-8');

  for (const forbidden of ['setNativeValue', 'attachResume', 'content.js', 'DataTransfer']) {
    assert.ok(!src.includes(forbidden), `the audit must not be able to write to a page: ${forbidden}`);
  }

  const clicks = [...src.matchAll(/(\w+)\(\)\?\.click\(\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(clicks)].sort(), ['applyControl', 'startGate'],
    'only navigation may be clicked — anything else is a fill in disguise');
});

test('a sign-in wall is reported as a wall, not as a one-question form', () => {
  // F-233. Following Amazon's Apply lands on a login page carrying exactly one
  // control — an email box. This file asked "are there fields?" FIRST, so five
  // of his saved Amazon postings audited as a single answered "Email" and
  // nothing else, which reads as an application with one question on it.
  //
  // content.js checks signInWall() before it discovers anything, which is why
  // the filler stops and says "sign in here" instead of typing into a login
  // form. The auditor has to face the same page the same way.
  const src = readFileSync(path.join(HERE, 'audit-answers.mjs'), 'utf-8');
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `audit-answers.mjs no longer contains ${needle}`);
    return i;
  };
  const fields = at('if (seen.fields.length) return seen.fields;');
  for (const guard of ['if (seen.gone)', 'if (seen.blocked)', 'if (seen.wall)']) {
    assert.ok(at(guard) < fields, `${guard} must be decided BEFORE falling back to the field list`);
  }
});

test('the filler decides the same way, and first', () => {
  // The two must not drift: an auditor that answers a different question from
  // the one the filler will face is worse than no auditor (F-223's shape).
  const content = readFileSync(path.join(HERE, 'extension', 'content.js'), 'utf-8');
  // `run({ auto })` since F-306: a run nobody pressed for is told so.
  const run = content.indexOf('async function run(');
  assert.ok(run > 0, 'content.js no longer has run()');
  const wall = content.indexOf('signInWall()', run);
  const discover = content.indexOf('discover()', run);
  assert.ok(wall > 0 && wall < discover,
    'content.js must check the sign-in wall before it discovers fields');
});

test('getting to the form may take more than one click, in either order', () => {
  // F-239. Intel and KLA have an Apply link and no gate on the posting page.
  // Clicking Apply opens Workday's "Apply Manually" modal — the gate, arriving
  // AFTER the gate check had already run and found nothing. The old fixed order
  // (gate once, then Apply once, then stop) stopped one click short of the form
  // and reported "no Apply control to follow" about a control it had followed.
  const src = readFileSync(path.join(HERE, 'audit-answers.mjs'), 'utf-8');
  const walk = src.slice(src.indexOf('let seen = await read();'), src.indexOf('if (seen.gone)'));
  assert.match(walk, /for \(let step = 0; step < \d+/, 'the walk to the form must be a bounded loop');
  assert.ok(walk.indexOf('startGate') > 0 && walk.indexOf('applyControl') > 0,
    'and it must be able to click either one on any pass');
  // Bounded, and it must give up when a pass changes nothing.
  assert.match(walk, /break;/, 'a page that keeps offering the same control is a loop, not progress');
});

test('a file upload alone does not count as a form to answer', () => {
  // An Eightfold posting carries one file input — "upload your resume to see
  // how you match" — and that single control was enough to stop the walk.
  const src = readFileSync(path.join(HERE, 'audit-answers.mjs'), 'utf-8');
  assert.match(src, /f\.type !== 'file'/, 'uploads must not be mistaken for questions');
});
