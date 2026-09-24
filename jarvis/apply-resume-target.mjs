/**
 * What should /api/apply-resume do with this request?
 *
 * THIS IS A SEPARATE MODULE SO IT CAN BE TESTED FOR REAL. serve.mjs starts an
 * HTTP server on import, so everything in it is pinned by tests that read the
 * source as text and match strings. That is enough to catch a deleted line and
 * not enough to catch a wrong one: the guard against serving another employer's
 * resume was broken here for exactly as long as it took to write it, while a
 * test asserting the string `matched === 'fallback'` still passed, because the
 * string was there and the condition in front of it was wrong.
 *
 * The decision is four-way and the dangerous case is the third:
 *
 *   use-ctx    a prepared application matches this page — serve its PDF
 *   build      no prepared application, but the page IS a posting in the store
 *              — tailor one now (this is the flow he actually uses: open a
 *              form, click the extension, never touch the dashboard)
 *   refuse     the page cannot be tied to any posting, and something else was
 *              applied to most recently. Serving that resume would attach
 *              another employer's name to this application. Refuse.
 *   none       nothing matches and nothing was applied to.
 */

/**
 * @param {object} q
 * @param {boolean} q.asked      an explicit job id was given (the dashboard's own
 *                               link, or the id an armed tab carries)
 * @param {boolean} q.askedFound that id names a posting in the store
 * @param {'page'|'fallback'|'none'} q.matched  how contextForPage scored this page
 * @param {boolean} q.haveCtx    that match carried a context
 * @param {boolean} q.jobFound   the page URL resolved to a posting in the store
 * @returns {'use-ctx'|'build'|'refuse'|'none'}
 */
export function resumeTarget({ asked = false, askedFound = false, matched = 'none', haveCtx = false, jobFound = false } = {}) {
  // An explicit id is not a guess, so it never refuses and never falls back to
  // whatever was applied to last. It builds only for the posting IT names —
  // `askedFound`, never `jobFound`, which is about the page and may be a
  // different job. That case exists because the extension now carries the id
  // on the tab (an armed tab keeps its application across every page of the
  // walk), and a dashboard restart empties APPLY_CONTEXT while the tab is
  // still mid-application. The id still names a real posting; building for it
  // is the honest answer, and "none" left him with no resume for a job the
  // store knows perfectly well.
  if (asked) return haveCtx ? 'use-ctx' : (askedFound ? 'build' : 'none');

  // A page-level match is this posting's own application.
  if (matched === 'page' && haveCtx) return 'use-ctx';

  // No prepared application, but we know which posting he is standing on.
  if (jobFound) return 'build';

  // We do NOT know which posting this is, and something else is in flight.
  // This is the near-miss the whole guard exists for.
  if (matched === 'fallback') return 'refuse';

  return 'none';
}
