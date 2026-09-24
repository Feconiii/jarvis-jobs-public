#!/usr/bin/env node
// jarvis/adopt-chrome-profile.mjs — give the apply engine's browser your logins.
//
// THE PROBLEM THIS SOLVES
//
// The engine drives a dedicated Chrome profile (LOCALAPPDATA/jarvis-chrome) that
// is signed into nothing, which is why every run met a sign-in wall and why he
// did not recognise the window it opened.
//
// The obvious fix — point Chrome at his real profile — CANNOT WORK, and it is
// worth writing down why so nobody tries it again. Since Chrome 136, remote
// debugging is refused on the DEFAULT user-data-dir; it is a deliberate
// mitigation against cookie theft over the DevTools port. Measured here on
// Chrome 151.0.7922.175: `--remote-debugging-port=9222` against
// LOCALAPPDATA/Google/Chrome/User Data starts a perfectly normal browser and
// never opens the port, so the only symptom is ECONNREFUSED.
//
// A NON-default directory is still allowed. So instead of moving the engine to
// his profile, this moves his SESSION to the engine's profile — once — and every
// run afterwards is signed in.
//
// WHAT IT COPIES, AND WHAT THAT MEANS
//
//   Local State          the key his cookies are encrypted with (root-level)
//   Network/Cookies      the session cookies themselves
//   Login Data           saved passwords, so Chrome can autofill a sign-in form
//   Web Data             autofill entries
//   Preferences          his signed-in Google identity
//   Local Storage/       what many sites keep a session token in nowadays
//   Session Storage/
//
// About 4 MB. It is a COPY of live credentials into a second directory on the
// same machine, under the same Windows account, so DPAPI can still decrypt them
// — nothing leaves the machine and nothing is decrypted here. It is still worth
// knowing it exists: deleting LOCALAPPDATA/jarvis-chrome removes it.
//
// Chrome must be CLOSED. Cookies is a locked SQLite file while it runs, and a
// half-copied one is worse than none.
//
// Usage:
//   node jarvis/adopt-chrome-profile.mjs             # copy, Chrome must be closed
//   node jarvis/adopt-chrome-profile.mjs --close     # close Chrome first
//   node jarvis/adopt-chrome-profile.mjs --profile "Profile 1"

import { cpSync, existsSync, mkdirSync, statSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import { spawn } from 'child_process';

const LOCAL = process.env.LOCALAPPDATA || '';
const REAL_ROOT = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
const JARVIS_ROOT = process.env.JARVIS_CHROME_PROFILE || path.join(LOCAL, 'jarvis-chrome');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, dflt) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : dflt; };
const PROFILE = opt('--profile', 'Default');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeRunning() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process chrome -ErrorAction SilentlyContinue).Count'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('close', () => resolve(Number(out.trim()) > 0));
    ps.on('error', () => resolve(false));
  });
}

async function closeChrome() {
  console.log('Closing Chrome (your tabs are saved and will come back)...');
  await new Promise((resolve) => {
    // No /F: WM_CLOSE is what clicking the X does, so Chrome saves its session.
    const ps = spawn('taskkill.exe', ['/IM', 'chrome.exe'], { stdio: 'ignore' });
    ps.on('close', resolve);
    ps.on('error', resolve);
  });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!(await chromeRunning())) return true;
  }
  return false;
}

// [source, destination] relative to their roots. Root-level entries first.
const ITEMS = [
  ['Local State', 'Local State'],
  [`${PROFILE}/Network/Cookies`, 'Default/Network/Cookies'],
  [`${PROFILE}/Login Data`, 'Default/Login Data'],
  [`${PROFILE}/Web Data`, 'Default/Web Data'],
  [`${PROFILE}/Preferences`, 'Default/Preferences'],
  [`${PROFILE}/Local Storage`, 'Default/Local Storage'],
  [`${PROFILE}/Session Storage`, 'Default/Session Storage'],
];

async function main() {
  if (!existsSync(REAL_ROOT)) {
    console.error(`No Chrome profile at ${REAL_ROOT}`);
    process.exit(1);
  }
  if (!existsSync(path.join(REAL_ROOT, PROFILE))) {
    console.error(`No profile "${PROFILE}" in ${REAL_ROOT}`);
    process.exit(1);
  }

  if (await chromeRunning()) {
    if (!flag('--close')) {
      console.error('\nChrome is running, and its cookie database is locked while it is.');
      console.error('Close every Chrome window and re-run, or add --close to do it here.');
      process.exit(1);
    }
    if (!(await closeChrome())) {
      console.error('Chrome would not close — shut it down yourself and re-run.');
      process.exit(1);
    }
  }

  mkdirSync(path.join(JARVIS_ROOT, 'Default', 'Network'), { recursive: true });
  let copied = 0, bytes = 0, missing = 0;
  for (const [from, to] of ITEMS) {
    const src = path.join(REAL_ROOT, from);
    const dst = path.join(JARVIS_ROOT, to);
    if (!existsSync(src)) { console.log(`  – ${from} (not present, skipped)`); missing++; continue; }
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, force: true });
    const size = statSync(src).isDirectory() ? 0 : statSync(src).size;
    bytes += size;
    copied++;
    console.log(`  ✓ ${from}`);
  }

  console.log(`\n${copied} item(s) copied${missing ? `, ${missing} not present` : ''}`
    + `${bytes ? ` (${Math.round(bytes / 1024)} KB of files, plus the storage directories)` : ''}.`);
  console.log(`The engine's browser at ${JARVIS_ROOT} now carries your session.`);
  console.log('\nRun the engine normally — no --real-chrome needed:');
  console.log('  npm run jarvis:apply');
  console.log('\nIf a site still asks you to sign in, sign in once in that window; it persists from then on.');
}

// ONLY WHEN RUN AS A COMMAND. Importing this module used to execute it — the
// class of fault recorded as F-181 (a test import overwrote his real backup)
// and F-182 (importing the apply engine opened a browser on real postings).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
