// jarvis/daily-lock.mjs — one daily search at a time (curate.mjs --daily), shared with the dashboard.
//
// The lock is a file holding the running search's pid. Review of fresh-lane
// (2026-11-04): a live holder made the next run exit 0 with a stdout line and
// no outcome line, so once the dashboard read on triggers and every 6 h, a
// scheduled 6:30 or 4:10 run that found one running was lost in silence. Now
// a run waits for the holder (a trigger does not: it is skipped, says so, and
// gives its 2-hour slot back), and every outcome is a line in curate-daily.jsonl.
import fs from 'node:fs';
import path from 'node:path';

/** Exit code of a trigger skipped because another daily search held the lock. */
export const SKIPPED_FOR_LOCK = 3;

export const dailyLockPath = (dataDir) => path.join(dataDir, 'curate-daily.lock');

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The pid in the lock file, or null. */
export function lockPid(file) {
  try { return Number(fs.readFileSync(file, 'utf8')) || null; } catch { return null; }
}

/** A live process other than `self` holding the lock, or null. */
export function liveHolder(file, { self = process.pid, isAlive = alive } = {}) {
  const pid = lockPid(file);
  return pid && pid !== self && isAlive(pid) ? pid : null;
}

/**
 * Take the lock. A live holder is waited for up to `waitMs` (a trigger does
 * not wait). Returns { ok: true, stale } — `stale` is a dead holder's pid,
 * for its outcome line — or { ok: false, held }.
 */
export async function takeDailyLock(file, { trigger = false, waitMs = 20 * 60_000, pollMs = 15_000, self = process.pid,
  isAlive = alive, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = now() + (trigger ? 0 : waitMs);
  let stale = null;
  for (;;) {
    // ATOMIC (review, 2026-11-04): the file is created only if it does not
    // exist ('wx'), so two processes can never both see it free and both take it.
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(self)); } finally { fs.closeSync(fd); }
      return { ok: true, stale };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const pid = lockPid(file);
    if (pid === self) return { ok: true, stale };
    if (!pid || !isAlive(pid)) {
      // A dead holder's lock (or an empty file): reported once, then taken over.
      if (pid && pid !== self) stale = stale || pid;
      try { fs.unlinkSync(file); } catch { /* another process took it over first */ }
      continue;
    }
    if (now() >= until) return { ok: false, held: pid };
    await sleep(Math.min(pollMs, Math.max(0, until - now())));
  }
}
