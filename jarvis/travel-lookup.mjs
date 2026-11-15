/**
 * THE TRAVELLING-REQUISITION ANSWERS, KEPT (F-1032; review 2026-11-07).
 *
 * serve.mjs asks requisition-worker.mjs, in its own thread, whether a stored
 * posting carries a page's requisition under another host. This module keeps
 * the answers and the worker:
 *   - per (token, host): a found id for the session; a "none" for 10 minutes,
 *     so a board row a scan adds since is found; at most 2,000 kept;
 *   - a kept id whose row is gone (deleted) is dropped and asked again;
 *   - one lookup per key at a time (callers share it);
 *   - each lookup gives up after `timeoutMs` (a hung worker must not pin a key);
 *   - a worker that dies takes its waiters with it (each answers a miss), and
 *     for `cooldownMs` no new worker is started: lookups answer a miss at once.
 * `spawn()` returns a Worker-like object (postMessage, on('message'|'error'|'exit'), unref).
 */
export function makeTravelLookup({
  spawn, dbPath, onFound = () => {}, log = () => {},
  now = Date.now, noneMs = 10 * 60_000, timeoutMs = 30_000, cooldownMs = 30_000, max = 2000,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const kept = new Map();      // key → { id, at }
  const pending = new Map();   // key → Promise<id|null>
  const waiting = new Map();   // seq → { resolve, reject, timer }
  let worker = null; let seq = 0; let downUntil = 0;

  const keyOf = (url, want) => { let h = ''; try { h = new URL(String(url)).hostname.toLowerCase(); } catch { /* none */ } return `${want}|${h}`; };

  /** The kept answer: an id, null for "none", undefined when not asked (or stale). */
  function get(url, want) {
    const hit = kept.get(keyOf(url, want));
    if (!hit) return undefined;
    if (!hit.id && now() - hit.at > noneMs) return undefined;
    return hit.id;
  }
  /** Forget a kept answer (its row is gone). */
  function drop(url, want) { kept.delete(keyOf(url, want)); }

  function settle(s, fn) {
    const w = waiting.get(s); if (!w) return;
    waiting.delete(s); clearTimer(w.timer); fn(w);
  }
  function start() {
    if (worker) return worker;
    if (now() < downUntil) throw new Error('the lookup worker is cooling down after a crash');
    const w = spawn();
    w.unref?.();
    w.on('message', ({ seq: s, id, error, ms }) => {
      if (ms > 1000) log(`travelling-requisition lookup took ${(ms / 1000).toFixed(1)}s — in its worker thread`);
      settle(s, (p) => (error ? p.reject(new Error(error)) : p.resolve(id ?? null)));
    });
    const fail = (e) => {
      if (w !== worker) return;   // an old worker's last word
      worker = null;
      downUntil = now() + cooldownMs;
      log(`the lookup worker stopped (${e?.message || e}); lookups answer "not found" for ${Math.round(cooldownMs / 1000)} s`);
      for (const s of [...waiting.keys()]) settle(s, (p) => p.reject(e instanceof Error ? e : new Error(String(e))));
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`exit ${code}`)));
    worker = w;
    return w;
  }
  /** Ask once per key; found answers are kept and announced. */
  function lookup(url, want) {
    const key = keyOf(url, want);
    if (pending.has(key)) return pending.get(key);
    const p = new Promise((resolve, reject) => {
      const s = ++seq;
      const timer = setTimer(() => settle(s, (w) => w.reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
      timer?.unref?.();
      waiting.set(s, { resolve, reject, timer });
      try { start().postMessage({ seq: s, url: String(url), dbPath }); } catch (e) { settle(s, (w) => w.reject(e)); }
    }).then((id) => {
      kept.set(key, { id, at: now() });
      if (kept.size > max) kept.delete(kept.keys().next().value);
      if (id) onFound(id);
      return id;
    }).finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }
  return { get, drop, lookup, keyOf, sizes: () => ({ kept: kept.size, pending: pending.size, waiting: waiting.size }) };
}
