// jarvis/reader-schedule.mjs — when the dashboard starts the daily search (the reader).
//
// F-999 (2026-11-04): the scan and the reader shared one 6-hour interval, scan
// first, and a reader kick that found a scan running returned without a word.
// The first kick (20 minutes in) also landed inside the startup scan. So the
// dashboard's reader never ran; only the scheduled task's two runs did, and a
// body that landed between them waited up to 14 h. Now a kick during a scan
// is DEFERRED, said so in the server log, and runs when the scan ends.
//
// C (first mate's call, 2026-11-04): when the enricher reads bodies for new
// postings the screen was waiting on, a capped read starts — at most one per
// `triggerGapMs` (2 h), never beside another reader or a scan. Its cap and
// window are the reader's (curate.mjs --trigger), and its outcome line in
// curate-daily.jsonl carries `trigger`, so health checks see it.
//
// Review (2026-11-04): a daily search this server did not start (the
// scheduled task, one by hand) holds the lock file; it counts as busy too, so
// work waits for it instead of starting a run that would find the lock. A
// trigger that found the lock anyway gives its 2-hour slot back.

export const TRIGGER_GAP_MS = 2 * 3600e3;

/**
 * @param {object} o
 * @param {(run: { reason: string, trigger: boolean }) => void} o.start  spawn the reader
 * @param {() => boolean} o.scanRunning
 * @param {() => boolean} o.readerRunning        this server's own reader child
 * @param {() => boolean} [o.otherReaderRunning] a live daily search holding the lock that is not ours
 * @param {() => boolean} [o.applying]           he is filling a form (F-1021): wait, like for a scan
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function makeReaderSchedule({ start, scanRunning, readerRunning, otherReaderRunning = () => false, applying = () => false, log = () => {}, now = Date.now, triggerGapMs = TRIGGER_GAP_MS }) {
  let pending = null;          // { reason, trigger } waiting for a scan or another reader to end
  let lastTrigger = -Infinity, priorTrigger = -Infinity;

  const busy = () => (scanRunning() ? 'a scan is running' : otherReaderRunning() ? 'another daily search is running'
    : applying() ? 'he is applying' : '');
  const run = (job) => {
    if (job.trigger) { priorTrigger = lastTrigger; lastTrigger = now(); }
    start(job);
    return 'started';
  };
  const defer = (job, why) => {
    // A full run waiting outranks a trigger waiting: it reads everything the trigger would.
    if (!pending || (pending.trigger && !job.trigger)) {
      pending = job;
      log(`reader deferred (${job.reason}): ${why}; it starts when that ends`);
    }
    return 'deferred';
  };

  /** The interval's (or a restart's) kick: a full daily search. */
  function kick(reason = 'every 6 h') {
    if (readerRunning()) return 'running';
    const why = busy();
    if (why) return defer({ reason, trigger: false }, why);
    pending = null;
    return run({ reason, trigger: false });
  }

  /** The enricher read `n` bodies for new postings the screen was waiting on. */
  function newBodies(n, reason = 'new postings read') {
    if (!(n > 0)) return 'none';
    if (now() - lastTrigger < triggerGapMs) return 'too-soon';
    const job = { reason: `${reason}: ${n}`, trigger: true };
    // Our own reader may have started before these bodies: the trigger waits for it.
    const why = readerRunning() ? 'a daily search is running' : busy();
    if (why) return defer(job, why);
    return run(job);
  }

  /** Something that blocked the reader ended (a scan, a reader), or the poll is looking. */
  function idle() {
    if (!pending) return 'idle';
    if (readerRunning() || busy()) return 'waiting';
    const job = { ...pending, reason: `${pending.reason}, after the wait` };
    pending = null;
    if (job.trigger && now() - lastTrigger < triggerGapMs) return 'too-soon';
    log(`reader starting (${job.reason})`);
    return run(job);
  }

  /** The trigger just started found the lock taken and read nothing: its 2-hour slot is given back. */
  function triggerSkipped() { lastTrigger = priorTrigger; }

  return { kick, newBodies, idle, scanEnded: idle, poll: idle, triggerSkipped, pending: () => pending };
}
