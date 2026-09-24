// jarvis/net-pool.mjs — how many requests this project will have in flight,
// and at whom.
//
// Split out of scan.mjs so enrich.mjs can use the same limiter (F-426). It has
// to be its own file rather than an import from scan.mjs, because scan.mjs
// calls `guardArgs()` at module scope: importing it from the enricher would
// parse the ENRICHER's argv against the SCANNER's flag list and exit the
// process on `--auto`. Verified before this file existed.
//
// Nothing here does I/O. It only decides who waits.

/**
 * A counting semaphore per key. Callers await a slot and release it in a
 * `finally`, so a throwing worker can never leak one and wedge the key.
 *
 * @param {number} limit  Maximum concurrent holders per key. <= 0 disables.
 */
export function makeHostLimiter(limit) {
  const active = new Map();   // key → in-flight count
  const waiting = new Map();  // key → queued resolvers

  return async function withHost(host, fn) {
    if (!host || limit <= 0) return fn();
    if ((active.get(host) || 0) >= limit) {
      await new Promise((resolve) => {
        if (!waiting.has(host)) waiting.set(host, []);
        waiting.get(host).push(resolve);
      });
    }
    active.set(host, (active.get(host) || 0) + 1);
    try {
      return await fn();
    } finally {
      active.set(host, active.get(host) - 1);
      const queue = waiting.get(host);
      if (queue && queue.length) queue.shift()();
    }
  };
}

// THE THING THAT RATE-LIMITS IS THE SERVICE, NOT THE HOSTNAME (F-421).
//
// Keyed on the full hostname this looked right and was wrong. Recruitee gives
// every customer its own subdomain — bego.recruitee.com, grip.recruitee.com,
// myr.recruitee.com — so a per-hostname cap saw eleven unrelated hosts and let
// them all run at once, and Recruitee answered `429 Too Many Requests` because
// behind those subdomains there is one service with one limiter. Measured:
// eight of eleven companies failing in a single run. Same shape for
// bamboohr.com, breezy.hr and every myworkdayjobs.com tenant.
//
// Two labels is right for every ATS this project talks to (recruitee.com,
// greenhouse.io, lever.co, breezy.hr); the list below covers the multi-part
// suffixes where two labels would collapse unrelated companies onto one bucket
// and throttle them against each other.
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.nz', 'co.za', 'co.in', 'com.au', 'com.br', 'com.mx',
  'com.cn', 'com.sg', 'org.uk', 'net.au', 'ac.uk',
]);

/** The registrable domain of a hostname — the unit that actually rate-limits. */
export function registrableDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_PART_TLDS.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** The service a URL belongs to, or '' when it cannot be parsed. */
export function serviceOf(url) {
  try { return registrableDomain(new URL(String(url)).hostname); } catch { return ''; }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving INPUT ORDER
 * in the returned array. Order matters where the caller builds a report from
 * it: a report whose rows shuffle every run is a report nobody can diff.
 */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}
