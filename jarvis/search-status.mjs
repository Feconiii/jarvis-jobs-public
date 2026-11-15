// jarvis/search-status.mjs — what the Inbox's status strip says (2026-11-03).
//
// "Last search ran, filed N, next run, survivors waiting": the main view could
// not say any of it, so a full inbox looked the same as a broken search. Read
// from curate-daily.jsonl (every daily run, its no-ops included), the store,
// the screen cache, and the Task Scheduler's own next-run time. Read-only.

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STORE_DIR } from './store.mjs';

/** The last daily run, and the last one that filed anything, from the log's lines. */
export function lastRuns(lines) {
  const runs = (lines || []).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.at);
  const last = runs[runs.length - 1] || null;
  const filed = [...runs].reverse().find((r) => Number(r.filed) > 0) || null;
  return {
    last: last && { at: last.at, filed: Number(last.filed) || 0, topup: Number(last.topup) || 0, noop: !!last.noop, why: last.why || null, open: last.open ?? null, read: last.read ?? null, error: last.error || null },
    lastFiled: filed && { at: filed.at, filed: Number(filed.filed) || 0, topup: Number(filed.topup) || 0 },
  };
}

/**
 * THE SEARCH'S OWN ALARM (F-981, 2026-11-04). 21 of 33 runs filed nothing and
 * nobody noticed for weeks (first mate's history audit). The same rules as
 * first-mate/bin/jarvis-health.mjs, so the strip and the coordinator agree:
 * two non-no-op runs in a row filing 0; over half the tried rows failing in the
 * last `n` runs; no run for 18 hours (the 4:10 PM to 6:30 AM gap is 14.3 h, more
 * when the laptop sleeps); a goal over 100; the last run filing
 * under half its goal. Each is one plain sentence.
 */
export function healthAlarms(lines, { now = new Date(), n = 6 } = {}) {
  const runs = (lines || []).map((l) => { try { return typeof l === 'string' ? JSON.parse(l) : l; } catch { return null; } }).filter((r) => r && r.at);
  if (!runs.length) return ['The daily search has never run.'];
  const isNoop = (r) => r.noop === true || r.skipped === true || (typeof r.goal === 'number' && r.goal <= 0);
  const recent = runs.slice(-n);
  const last = runs[runs.length - 1];
  const out = [];
  // A run that crashed or stopped part-way says so (F-986): the 11-04 6:30 run left no line at all.
  if (last.error) out.push(`The last search failed (${String(last.error).replace(/\.$/, '')}).`);
  let zeros = 0;
  for (let i = runs.length - 1; i >= 0 && (Number(runs[i].filed) || 0) === 0; i--) if (!isNoop(runs[i])) zeros += 1;
  if (zeros >= 2) out.push(`${zeros} searches in a row filed nothing.`);
  const read = recent.reduce((s, r) => s + (Number(r.read) || 0), 0);
  const failed = recent.reduce((s, r) => s + (Number(r.failed) || 0), 0);
  if (read + failed > 0 && failed / (read + failed) > 0.5) out.push(`${Math.round((100 * failed) / (read + failed))}% of the postings the last ${recent.length} searches tried failed to read.`);
  const ageH = (now - Date.parse(last.at)) / 3600e3;
  if (ageH > 18) out.push(`No search has run for ${Math.round(ageH)} hours (it is scheduled twice a day).`);
  if (Number(last.goal) > 100) out.push(`The last search's goal was ${last.goal}, which looks like a bug.`);
  if (!isNoop(last) && Number(last.goal) > 0 && (Number(last.filed) || 0) < last.goal / 2) out.push(`The last search filed ${Number(last.filed) || 0} of its goal of ${last.goal}.`);
  return out;
}

/** Local midnight of `now`, as an ISO string. */
export function startOfToday(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString();
}

let nextRunCache = { at: 0, value: null };
/** The scheduled task's next run, asked of Windows; cached ten minutes. */
export function nextScheduledRun(task = 'Jarvis Daily Job Search') {
  if (Date.now() - nextRunCache.at < 10 * 60_000) return Promise.resolve(nextRunCache.value);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-ScheduledTaskInfo -TaskName '${task}').NextRunTime.ToUniversalTime().ToString('o')`],
      { timeout: 15_000, windowsHide: true }, (err, out) => {
        const v = !err && /^\d{4}-/.test(String(out).trim()) ? String(out).trim() : null;
        nextRunCache = { at: Date.now(), value: v };
        resolve(v);
      });
  });
}

/** Everything the strip shows. */
export async function searchStatus({ dir = STORE_DIR, now = new Date(), nextRun = nextScheduledRun, settings = null } = {}) {
  let lines = [];
  try { lines = readFileSync(path.join(dir, 'curate-daily.jsonl'), 'utf8').trim().split('\n').slice(-200); } catch { /* no runs yet */ }
  const runs = lastRuns(lines);
  let filedToday = null, open = null, waiting = null;
  try {
    const db = new DatabaseSync(path.join(dir, 'jobs.db'), { readOnly: true });
    const since = startOfToday(now);
    filedToday = db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('inbox','queued') AND gone_at IS NULL AND status_changed_at >= ?").get(since).n;
    open = db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('inbox','queued') AND gone_at IS NULL").get().n;
    try {
      const s = new DatabaseSync(path.join(dir, 'screen.db'), { readOnly: true });
      const ids = s.prepare("SELECT id FROM verdicts WHERE verdict = 'survivor'").all().map((r) => r.id);
      s.close();
      const q = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND status = 'new' AND gone_at IS NULL AND (pick_note IS NULL OR pick_note NOT LIKE 'Not curated%')");
      waiting = ids.filter((id) => q.get(id)).length;
    } catch { /* no screen yet */ }
    db.close();
  } catch { /* no store */ }
  // The H-1B data's own freshness (F-984): one line when the next quarter is overdue.
  let lca = null;
  try { const m = await import('./lca-refresh.mjs'); lca = m.staleNotice(m.loadedLabel(path.join(dir, 'jobs.db')), now); } catch { lca = null; }
  return { ...runs, filedToday, open, survivorsWaiting: waiting, nextRun: await nextRun(), topUp: settings?.dailyTopUp ?? null, alarms: [...healthAlarms(lines, { now }), ...(lca ? [lca] : [])] };
}
