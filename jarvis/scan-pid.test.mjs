/**
 * F-597: a restarted dashboard must not start a second scan beside a running
 * one. The pid file is how it knows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { runningScanPid } from './scan-pid.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-scanpid-'));
const file = path.join(dir, 'scan.pid');
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

test('no file, no scan', () => {
  assert.equal(runningScanPid(file), null);
});

test('a live process named in the file is a running scan; a dead one is not', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  try {
    writeFileSync(file, String(child.pid));
    assert.equal(runningScanPid(file), child.pid);
  } finally { child.kill(); }
  await new Promise((r) => child.on('exit', r));
  assert.equal(runningScanPid(file), null, 'the process is gone, so the scan is');
});

test('a pid file left by a crash long ago is ignored, whatever holds that number now', () => {
  writeFileSync(file, String(process.ppid || 1));
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
  utimesSync(file, old, old);
  assert.equal(runningScanPid(file), null);
});
