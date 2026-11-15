/**
 * BACKGROUND WORK WAITS WHILE HE IS APPLYING (F-1021, 2026-11-06).
 *
 * "why tf is the jarvis extension so slow and unresponsive now takes forever
 * to fill tesla". The enricher, the runway reader and the daily discovery pass
 * were all writing to the store while he filled a form, and every panel and
 * fill request waited on the same disk. A request from the extension's apply
 * path marks him as applying; for `quietMs` after the last one, a background
 * job asked to start is held and started once he has been quiet that long.
 * The caller asks `gate(name, retry)` before starting; a held job is started
 * by calling `retry`, which asks again and is let through. A job is never held longer than `maxHoldMs` (a panel left open all evening
 * must not stop the scan for good), and nothing is ever dropped.
 *
 * `onApplying` / `onQuiet` fire on the change, so the caller can lower the
 * priority of children that were already running and put it back afterwards.
 */
export function makeApplyQuiet({
  quietMs = 10 * 60 * 1000,
  maxHoldMs = 60 * 60 * 1000,
  staggerMs = 60 * 1000,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
  onApplying = () => {},
  onQuiet = () => {},
  log = () => {},
} = {}) {
  let last = 0;
  let timer = null;
  let applyingState = false;
  const held = new Map();   // name -> { fn, since }
  let releasing = null;     // the held job being started now: its own gate lets it through

  const applying = () => last > 0 && now() - last < quietMs;

  // ONE AT A TIME (F-1021 review): everything held used to start in the same
  // instant he went quiet — enrich, scan, discovery, mail, lead-watch at once.
  let lastRelease = -Infinity;
  function runHeld() {
    if (now() - lastRelease < staggerMs) return;
    for (const [name, h] of [...held]) {
      if (applying() && now() - h.since < maxHoldMs) continue;
      held.delete(name);
      lastRelease = now();
      log(`${name} → started (${applying() ? 'held an hour, running anyway' : 'he is quiet'})`);
      releasing = name;
      try { h.fn(); } catch (e) { log(`${name} → ${e?.message || e}`); } finally { releasing = null; }
      return;
    }
  }

  function arm() {
    if (timer) clearTimer(timer);
    timer = null;
    if (applyingState && !applying()) { applyingState = false; try { onQuiet(); } catch { /* best effort */ } }
    if (!held.size && !applyingState) return;
    runHeld();
    if (!held.size && !applyingState) return;
    const t = now();
    const waits = [];
    if (applying()) waits.push(last + quietMs - t);                    // the quiet moment
    for (const h of held.values()) waits.push(h.since + maxHoldMs - t); // a job's cap
    if (held.size && !applying()) waits.push(0);                       // due now, only the spacing holds it
    let delay = Math.min(...waits);
    if (held.size) delay = Math.max(delay, lastRelease + staggerMs - t);
    timer = setTimer(arm, Math.max(1000, delay));
  }

  return {
    /** A request from the apply path: he is filling a form now. */
    touch() {
      last = now();
      if (!applyingState) { applyingState = true; try { onApplying(); } catch { /* best effort */ } }
      arm();
    },
    applying,
    /**
     * May `name` start now? True when he is not applying (or this is its held
     * run being released); otherwise `fn` is held (one per name) and run when
     * he is quiet, and the caller returns without starting anything.
     */
    gate(name, fn) {
      if (releasing === name || !applying()) return true;
      if (!held.has(name)) { held.set(name, { fn, since: now() }); log(`${name} → held while he is applying`); }
      else held.get(name).fn = fn;
      arm();
      return false;
    },
    held: () => [...held.keys()],
    /** Re-check the clock now (tests; the timer does this by itself). */
    tick: arm,
  };
}

/** The extension's apply-path requests: his hands are on a form. Heartbeats and status polls are not. */
export const APPLY_PATHS = new Set([
  '/api/panel', '/api/panel-retailor', '/api/filled', '/api/plan', '/api/apply', '/api/apply-resume',
  '/api/apply-current', '/api/apply-page', '/api/answer', '/api/answer-snapshot', '/api/form-capture',
  '/api/choose', '/api/page-errors', '/api/fill-anyway', '/api/resume-name', '/api/cover-letter',
]);
