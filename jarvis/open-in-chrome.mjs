/**
 * Open a URL in the Chrome he is actually signed into.
 *
 * THE MECHANISM IS THE ONE THAT KILLED THE OLD DESIGN. Chrome allows one process
 * per user-data-dir; launching a second against a directory already open does
 * not error — it hands its URL to the running instance and exits 0. F-125/F-126
 * recorded that as the silent failure that made `--real-chrome` impossible,
 * because Playwright needed the second process to be a REAL browser it could
 * attach a debug port to, and Chrome 136+ refuses that port on the default
 * profile anyway.
 *
 * Here we do not want to attach to anything. We want a tab to appear in his
 * window, in his session, with his cookies and his employer accounts. That is
 * exactly what the hand-off does, so the bug becomes the feature: no debug port,
 * no profile copy, no credentials touched, nothing to be refused.
 *
 * If Chrome is NOT already running this launches it normally, which is also
 * correct — same profile either way.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** Where Chrome installs itself on Windows, in the order worth checking. */
export function chromeCandidates(env = process.env) {
  const dirs = [
    env['PROGRAMFILES'],
    env['PROGRAMFILES(X86)'],
    env['LOCALAPPDATA'],
  ].filter(Boolean);
  return dirs.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
}

/** The installed chrome.exe, or null when none of the usual places has one. */
export function findChrome(env = process.env, exists = existsSync) {
  for (const c of chromeCandidates(env)) if (exists(c)) return c;
  return null;
}

/**
 * A URL is about to be handed to a browser as an argument, so it has to be one.
 * Anything that is not plain http(s) is refused rather than passed along —
 * `file:` and `chrome:` arguments would read local disk, and a bare string could
 * arrive from the dashboard's own network surface.
 */
export function isOpenableUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/**
 * Open `url` in his Chrome. Resolves `{ ok, why, chrome }` and never throws —
 * a tab that failed to open is worth reporting, not worth losing the resume
 * that was just built for it.
 *
 * `profileDirectory` defaults to Default, which F-125 measured as his live
 * profile (signed in, 1 MB of cookies, written that day) against a Profile 1
 * that has been stale since 2023.
 */
export async function openInChrome(url, {
  env = process.env,
  profileDirectory = 'Default',
  chromePath = null,
  spawn = run,
} = {}) {
  if (!isOpenableUrl(url)) return { ok: false, why: `refused to open "${String(url).slice(0, 80)}" — only http and https`, chrome: null };

  const chrome = chromePath || findChrome(env);
  if (!chrome) return { ok: false, why: 'no chrome.exe in Program Files, Program Files (x86) or LOCALAPPDATA', chrome: null };

  const args = [];
  if (profileDirectory) args.push(`--profile-directory=${profileDirectory}`);
  args.push(String(url));

  try {
    await spawn(chrome, args, { windowsHide: false, timeout: 20_000 });
    return { ok: true, why: 'handed the URL to his running Chrome', chrome };
  } catch (e) {
    // The hand-off itself exits 0. A non-zero exit here means Chrome could not
    // start at all, which is worth saying plainly rather than as an errno.
    return { ok: false, why: `Chrome would not open the tab: ${String(e?.message || e).split('\n')[0]}`, chrome };
  }
}
