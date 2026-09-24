// jarvis/detail-sources.mjs — which ATSes a posting's body can be read from.
//
// WHY THIS IS ITS OWN FILE (F-444). `dashboard.html` kept its own copy of this
// list to decide what to say under an unread posting:
//
//     const ENRICHABLE = new Set(['workday','greenhouse','smartrecruiters','sitemap-jobs','lever']);
//
// `DETAIL` in enrich.mjs then grew past it — oracle-orc, rippling, bamboohr,
// breezy, icims — and nobody updated the copy. So the card told him a
// posting's board "exposes no per-job detail endpoint — open the original
// posting to read it" for boards one command reads fine.
//
// The page cannot import enrich.mjs (it runs in a browser), and serve.mjs must
// not import it either — enrich.mjs calls `guardArgs()` at the top level, which
// would parse the SERVER's argv and exit on anything it did not recognise.
// That is the same trap net-pool.mjs was carved out of scan.mjs to avoid.
//
// So the names live here, alone, importable by anyone — and `enrich.mjs`
// asserts on load that its DETAIL keys are exactly DETAIL_SOURCES. A mirror
// that cannot silently drift is not really a mirror.

/**
 * Every `source` with a per-job detail deriver in enrich.mjs's DETAIL map.
 * These need a second fetch after the scan; that is what `jarvis:enrich` is.
 */
export const DETAIL_SOURCES = [
  'bamboohr',
  'breezy',
  'greenhouse',
  'icims',
  'oracle-orc',
  'rippling',
  'sitemap-jobs',
  'smartrecruiters',
  'workday',
];

/**
 * Sources whose LIST api already ships the body, so their rows arrive read and
 * never need an enrichment pass at all. Measured on the store 2026-09-10 —
 * amazon-jobs, ashby, phenom, successfactors and extension sit at 100% read,
 * lever 97%, jibeapply 89%, recruitee 82%.
 *
 * The stragglers are why this is a separate list rather than a footnote: a
 * lever row with no body is a posting that failed at scan time, not a posting
 * waiting on a deriver, and the advice for the two is different.
 */
export const BODY_IN_LIST = [
  'amazon-jobs',
  'ashby',
  'extension',
  'jibeapply',
  'lever',
  'phenom',
  'recruitee',
  'successfactors',
];

/**
 * Sources nothing on the server can read, at all — the site refuses
 * non-browser HTTP. Only the assisted channel reaches these
 * (`import-descriptions.mjs`), and saying so on the card is the honest answer
 * rather than pointing at a command that would read nothing.
 */
export const BROWSER_ONLY = ['browser-assist'];

/** What the dashboard means by "we can read this": either server route works. */
export const READABLE_SOURCES = [...DETAIL_SOURCES, ...BODY_IN_LIST];

/**
 * Compare against the live DETAIL map. Returns the two directions of drift so
 * the caller can say which way it went — "enrich grew a deriver nobody told
 * the dashboard about" and "this list names a deriver that no longer exists"
 * are different mistakes with different fixes.
 */
export function driftFrom(detailKeys) {
  const declared = new Set(DETAIL_SOURCES);
  const actual = new Set(detailKeys);
  return {
    missing: [...actual].filter((k) => !declared.has(k)).sort(),
    stale: [...declared].filter((k) => !actual.has(k)).sort(),
  };
}
