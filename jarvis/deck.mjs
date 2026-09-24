// jarvis/deck.mjs — stop one employer from owning the whole first page.
//
// Sorting the deck by fit score is correct and produces an unbrowsable deck.
// Of the top 100 unblocked postings, 31 were GlobalFoundries; four employers
// held 67 of them. That is not a scoring bug — a large fab really does post
// dozens of near-identical reqs, and they really do all match. But reading ten
// of the same posting in a row is how a card deck gets abandoned, and an
// abandoned deck scores zero however well it was ranked.
//
// So the deck is *spread*: still strongest-first, but a company or a field that
// just appeared waits its turn. The order within any company is untouched, so
// nothing is hidden and nothing is demoted — a GlobalFoundries req that was
// ranked above another GlobalFoundries req still is. Only the interleaving
// changes.
//
// This runs after the database has already sorted and limited, so it reorders
// a page rather than the store.

/**
 * Reorder rows so neither the same employer nor the same field repeats inside
 * a short window, preferring the highest-scoring eligible row at every step.
 *
 * Falls back gracefully: when nothing satisfies both gaps it relaxes to company
 * only, and when even that is impossible (one employer is all that is left) it
 * takes the best remaining row. A spread deck never drops or duplicates a row —
 * the output is always a permutation of the input.
 *
 * @param {Array<{company?:string, field?:string}>} rows  sorted best-first
 * @param {{companyGap?:number, fieldGap?:number}} opts
 *   companyGap — how many cards before the same employer may reappear
 *   fieldGap   — how many cards before the same field may reappear
 * @returns {Array} a permutation of `rows`
 */
export function spreadRows(rows, { companyGap = 3, fieldGap = 2 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 3) return list.slice();

  const pool = list.slice();
  const out = [];
  const recentCo = [];
  const recentField = [];

  const co = (r) => String(r?.company || '').toLowerCase();
  const fld = (r) => String(r?.field || 'other').toLowerCase();

  while (pool.length) {
    // The pool stays in score order, so the FIRST eligible row is always the
    // best eligible row — no re-sorting per step.
    let i = pool.findIndex(r => !recentCo.includes(co(r)) && !recentField.includes(fld(r)));
    if (i === -1) i = pool.findIndex(r => !recentCo.includes(co(r)));
    if (i === -1) i = 0;

    const [row] = pool.splice(i, 1);
    out.push(row);

    recentCo.push(co(row));
    if (recentCo.length > companyGap) recentCo.shift();
    recentField.push(fld(row));
    if (recentField.length > fieldGap) recentField.shift();
  }

  return out;
}

/**
 * How monotonous a deck is, for reporting: the longest run of one employer and
 * how many of the first 20 cards the biggest employer holds.
 */
export function deckConcentration(rows, head = 20) {
  const list = Array.isArray(rows) ? rows : [];
  let longestRun = 0, run = 0, prev = null;
  for (const r of list) {
    const c = String(r?.company || '').toLowerCase();
    run = c && c === prev ? run + 1 : 1;
    if (run > longestRun) longestRun = run;
    prev = c;
  }
  const counts = new Map();
  for (const r of list.slice(0, head)) {
    const c = String(r?.company || '');
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let topCompany = '', topCount = 0;
  for (const [c, n] of counts) if (n > topCount) { topCompany = c; topCount = n; }
  return { longestRun, topCompany, topCount, head: Math.min(head, list.length) };
}
