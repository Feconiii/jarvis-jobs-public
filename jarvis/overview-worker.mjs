/**
 * THE HOME TILES' AGGREGATES, OFF THE SERVER'S THREAD (2026-09-25).
 *
 * serve.mjs computed these "off the request path" on a timer — but node:sqlite
 * is synchronous, so the timer ran on the one thread that answers every
 * request. His serve.log: "home tiles recomputed in 31.8s". For those 31.8
 * seconds the extension's "is this page a posting?" waited too, which is the
 * "takes like 30s to recognize a page" he reported. The same queries run here,
 * in a worker thread with its own read connection, and the server only
 * assembles the answer.
 *
 * Every value is a plain count or row list, so it crosses the thread boundary
 * as data. Nothing here writes.
 */
import { parentPort } from 'node:worker_threads';
import { count, countBy, query, flagTotals, distinctCompanies, storeStats } from './store.mjs';

export function heavyAggregates({ hidden = [], readableSources = [], now = Date.now() } = {}) {
  const DAY = 86400000;
  const iso = (ms) => new Date(now - ms).toISOString();
  const browsable = { browsable: true };
  const ex = hidden.length ? hidden : undefined;
  const stat = {
    ...flagTotals(),
    newGrad: count({ browsable: true, newGrad: true, status: ['new', 'interested'], excludeCompany: ex }),
    blocked: count({ blocked: true, excludeCompany: ex }),
    new24h: count({ browsable: true, since: iso(DAY), status: ['new', 'interested'], excludeCompany: ex }),
    new7d: count({ browsable: true, since: iso(7 * DAY), status: ['new', 'interested'], excludeCompany: ex }),
    readable: count({ ...browsable, source: readableSources }),
    deepRead: count({ ...browsable, source: readableSources, hasDesc: true }),
    applyable: 0,
    queuedApplyable: count({ status: 'queued', hasAdapter: true }),
    companies: distinctCompanies(),
  };
  const byAdapter = countBy('adapter', browsable);
  delete byAdapter.unknown;   // countBy files NULL (no adapter) under 'unknown'
  stat.applyable = Object.values(byAdapter).reduce((a, b) => a + b, 0);
  const applyRuns = query({ prepared: true }, { sort: 'applied', limit: 60, full: true }).rows
    .map((j) => ({
      at: (j.apply || {}).at, company: j.company, title: j.title, url: j.url,
      filled: Array.isArray((j.apply || {}).filled) ? (j.apply || {}).filled.length : ((j.apply || {}).filled || 0),
      needs: (j.apply || {}).needsInput?.length ?? 0,
    }));
  return {
    stat,
    blockReasons: countBy('block_key', { blocked: true }),
    bySource: countBy('source'),
    byCompanyCounts: countBy('company', browsable),
    watchlistCompanies: Object.keys(countBy('company', { ...browsable, tier: 'watchlist' })),
    byAdapter,
    applyRuns,
    storage: storeStats(),
  };
}

/**
 * THE HEADER'S TWO FULL PASSES (F-1021): the per-status GROUP BY and the
 * unread count read every row — 4 s idle, 84 s on 2026-11-06 with the
 * enricher writing — and ran on the server's thread once a minute from
 * /api/jobs. Here they block nobody; serve.mjs keeps the last answer.
 */
export function headerTotals() {
  return { byStatus: countBy('status'), newOpen: count({ status: 'new', blocked: false, fitBlocked: false }) };
}

/** The progress line's coverage counts (2.4 s once under memory pressure, F-1021). */
export function coverageTotals({ readableSources = [] } = {}) {
  const readableFilter = { browsable: true, source: readableSources };
  return {
    readable: count(readableFilter),
    read: count({ ...readableFilter, hasDesc: true }),
    teams: count({ ...readableFilter, hasTeam: true }),
  };
}

/** Each per-posting resume file's row, as [path, owner] pairs (a full pass: resume_path has no index; F-1022). */
export function resumeOwnerPairs() {
  return query({ hasResume: true }, { limit: 2000 }).rows.map((j) => [
    String(j.resume_path).replace(/\\/g, '/'),
    { id: j.id, company: j.company, title: j.title, url: j.url, status: j.status },
  ]);
}

/** The search strip (F-1022): it opened the store and looked up every screen survivor on the server's thread, 3 s a call. */
async function searchStrip(args) {
  const { searchStatus } = await import('./search-status.mjs');
  return searchStatus({ settings: args.settings ?? null });
}

if (parentPort) {
  parentPort.on('message', async (msg) => {
    try {
      const data = msg.kind === 'heavyCounts' ? headerTotals()
        : msg.kind === 'coverage' ? coverageTotals(msg.args || {})
          : msg.kind === 'resumeOwners' ? resumeOwnerPairs()
            : msg.kind === 'searchStatus' ? await searchStrip(msg.args || {})
              : heavyAggregates(msg.args || {});
      parentPort.postMessage({ id: msg.id, ok: true, data });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, ok: false, error: String(e?.message || e) });
    }
  });
}
