// jarvis/apply/_timing.mjs — where the minutes actually go.
//
// An application takes ~10 minutes and nothing in the engine could say which
// part. That made every speed-up a guess. This records wall-clock per named
// phase so the next optimisation targets the measured cost rather than the
// suspected one.
//
// Two levels of label, deliberately:
//   - bare  ("navigate", "fill")  — the per-application phases in apply.mjs.
//     These do not overlap, so they sum to the application's time.
//   - "wd:" ("wd:prompt", "wd:save") — inside the Workday adapter, i.e. inside
//     "fill". They are a BREAKDOWN of fill, not additional time, and are
//     printed as such so nobody adds the two columns together.
//
// Set JARVIS_TIMING=0 to turn the whole thing off.

const ON = process.env.JARVIS_TIMING !== '0';

let bucket = new Map();

/** Time `fn` under `label`. Transparent: returns and throws exactly what fn does. */
export async function time(label, fn) {
  if (!ON) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const e = bucket.get(label) || { n: 0, ms: 0 };
    e.n++;
    e.ms += performance.now() - t0;
    bucket.set(label, e);
  }
}

/** Record a duration measured by hand, for a region that cannot be wrapped
 *  (one containing an early `return`, typically). */
export function record(label, ms) {
  if (!ON) return;
  const e = bucket.get(label) || { n: 0, ms: 0 };
  e.n++;
  e.ms += ms;
  bucket.set(label, e);
}

/** Drain the accumulator — call once per application. */
export function takePhases() {
  const m = bucket;
  bucket = new Map();
  return m;
}

/** Fold one phase map into another (for the batch total). */
export function mergePhases(into, from) {
  for (const [k, v] of from) {
    const e = into.get(k) || { n: 0, ms: 0 };
    e.n += v.n;
    e.ms += v.ms;
    into.set(k, e);
  }
  return into;
}

export function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/**
 * One compact block: the top-level phases on a line, then the adapter-internal
 * breakdown sorted by cost. Sub-phases under 300ms are noise and are dropped —
 * the point is to find the minutes, not to itemise every millisecond.
 */
export function formatPhases(m, indent = '   ') {
  if (!ON || !m.size) return '';
  const top = [...m].filter(([k]) => !k.includes(':'));
  const sub = [...m].filter(([k]) => k.includes(':')).filter(([, v]) => v.ms >= 300);
  const total = top.reduce((a, [, v]) => a + v.ms, 0);
  const lines = [];
  if (top.length) {
    top.sort((a, b) => b[1].ms - a[1].ms);
    lines.push(`${indent}⏱ ${fmtMs(total)} — ` + top.map(([k, v]) => `${k} ${fmtMs(v.ms)}`).join(' · '));
  }
  if (sub.length) {
    sub.sort((a, b) => b[1].ms - a[1].ms);
    for (const [k, v] of sub.slice(0, 10)) {
      lines.push(`${indent}    ${k.padEnd(18)} ${fmtMs(v.ms).padStart(7)}  ×${v.n}`);
    }
  }
  return lines.join('\n');
}
