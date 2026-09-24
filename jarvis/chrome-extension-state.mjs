/**
 * What version of THIS extension has Chrome actually loaded?
 *
 * WHY THIS READS A BROWSER FILE, AND WHAT IT WILL NOT READ.
 *
 * Chrome never auto-updates an unpacked extension. `background.js` handles that
 * with `reloadIfStale()` — but that runs on a toolbar CLICK, so it cannot fire
 * for someone who is not clicking. The dashboard's other check has the same
 * shape: it can only report staleness once the extension has contacted the
 * server, which also requires a click.
 *
 * So both detectors were blind in exactly the case that matters. Measured on his
 * own profile: the extension was loaded on 2026-08-31 21:46 and
 * `first_install_time` still equalled `last_update_time` two days later, with
 * the repo twenty-five versions ahead. Every fix in a full session of work was
 * sitting on disk, invisible, and nothing could say so.
 *
 * This closes that loop WITHOUT a click, by reading the one thing Chrome writes
 * down: its extension registry.
 *
 * It opens `Secure Preferences`, walks `extensions.settings`, and keeps only
 * entries whose `path` is the extension directory of THIS repository. From
 * those it reads the version, whether Chrome disabled it, and when it was last
 * updated. Nothing else in that file is looked at, and no other file in the
 * profile is opened — not cookies, not history, not saved credentials.
 *
 * Best-effort by construction: every failure returns null, because a dashboard
 * that cannot find Chrome must still work.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

/** Chrome stores time as microseconds since 1601-01-01. */
function chromeTime(value) {
  try {
    const ms = Number(BigInt(value) / 1000n) - 11644473600000;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  } catch { return null; }
}

/** Every Chrome profile directory worth looking in, newest-looking first. */
function profileDirs() {
  const roots = [];
  const local = process.env.LOCALAPPDATA;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (local) roots.push(path.join(local, 'Google', 'Chrome', 'User Data'));
  if (home) {
    roots.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'));
    roots.push(path.join(home, '.config', 'google-chrome'));
  }
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name !== 'Default' && !/^Profile \d+$/.test(e.name)) continue;
      out.push(path.join(root, e.name));
    }
  }
  return out;
}

/**
 * The loaded state of the unpacked extension living at `extensionDir`.
 *
 * Returns null when Chrome is not installed, the profile cannot be read, or this
 * extension is not registered in any profile — all of which are ordinary.
 */
export function loadedExtension(extensionDir) {
  const want = path.resolve(extensionDir).toLowerCase();
  for (const profile of profileDirs()) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      const p = path.join(profile, file);
      if (!existsSync(p)) continue;
      let settings;
      try {
        settings = JSON.parse(readFileSync(p, 'utf-8'))?.extensions?.settings;
      } catch { continue; }
      if (!settings || typeof settings !== 'object') continue;

      for (const [id, entry] of Object.entries(settings)) {
        const dir = String(entry?.path || '');
        if (!dir) continue;
        // Unpacked extensions store an absolute path; packed ones store a
        // relative folder under the profile, which can never match this.
        if (path.resolve(dir).toLowerCase() !== want) continue;

        const installed = chromeTime(entry.first_install_time);
        const updated = chromeTime(entry.last_update_time);
        return {
          id,
          // The manifest version Chrome registered its service worker with.
          // Absent on some Chrome builds, so it is allowed to be null and the
          // caller must not depend on it alone.
          version: entry?.service_worker_registration_info?.version
            || entry?.manifest?.version || null,
          disabled: Array.isArray(entry.disable_reasons) && entry.disable_reasons.length > 0,
          installedAt: installed,
          updatedAt: updated,
          // The signal that actually matters, and the one that is always
          // present: Chrome has not re-read this directory since it was first
          // loaded, so whatever is on disk now is NOT what is running.
          neverReloaded: !!(installed && updated && installed === updated),
          profile: path.basename(profile),
        };
      }
    }
  }
  return null;
}
