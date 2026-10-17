/**
 * IS A SCAN ALREADY RUNNING? A pid file in the store folder says so.
 *
 * The dashboard starts a scan two minutes after it boots when the last
 * FINISHED scan is over six hours old — and a scan records itself only when it
 * finishes. So a dashboard restarted while its own scan was still running
 * started a second one beside it, and the two took turns holding the store's
 * write lock (F-597, 2026-09-25). The scan now writes its pid here while it
 * runs, and the dashboard does not start another while that process is alive.
 */
import { readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import { STORE_DIR } from './store.mjs';

export const scanPidPath = () => path.join(STORE_DIR, 'scan.pid');

/** A pid file older than this is a crash's leftover, whatever process has that number now. */
const STALE_MS = 12 * 60 * 60 * 1000;

export function markScanRunning(file = scanPidPath()) {
  try { writeFileSync(file, String(process.pid)); } catch { return; }
  process.on('exit', () => {
    try { if (readFileSync(file, 'utf-8').trim() === String(process.pid)) unlinkSync(file); } catch { /* already gone */ }
  });
}

/** The running scan's pid, or null. */
export function runningScanPid(file = scanPidPath()) {
  try {
    if (Date.now() - statSync(file).mtimeMs > STALE_MS) return null;
    const pid = Number(readFileSync(file, 'utf-8').trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    process.kill(pid, 0);   // throws when no such process
    return pid;
  } catch { return null; }
}
