// jarvis/sponsor-prior.mjs — the employer's H-1B record, as a prior (F-982, 2026-11-04).
//
// The store's `sponsors_h1b` covers 58 of 6,124 employers (lca-import ran once).
// The coverage ledger holds the Department of Labor disclosure file's certified
// engineering petitions for every employer that filed one (curate.h1bPetitions,
// which the reader already sees). This turns that count into what a card shows
// and a tie-breaker the Inbox uses among equal fits.
//
// THE POSTING'S OWN WORDS WIN. A row whose text blocks him (no sponsorship,
// citizenship) or carries a work-authorisation caution gets no prior: an
// employer's history says nothing against what this posting says.

import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './store.mjs';
import { sameFiler, normCo } from './employer-names.mjs';

/**
 * @param {{ company: string, triage?: { flags?: object } }} job
 * @param {(company: string) => number|null} petitions
 * @returns {{ petitions: number, overruled?: string } | null}  null: the ledger is missing
 */
export function sponsorPrior(job, petitions) {
  const n = petitions(job?.company || '');
  if (n == null) return null;
  const f = job?.triage?.flags || {};
  if (f.hardBlock) return { petitions: n, overruled: 'the posting itself states a work-authorisation block' };
  if (f.visaWarning) return { petitions: n, overruled: 'the posting itself says something about work authorisation' };
  return { petitions: n };
}

/**
 * THE DEPARTMENT'S OWN COUNT (2026-11-04): certified H-1B petitions in his
 * occupational family (lca_employers.eng_certified, the disclosure file in the
 * store), summed over the employer's own legal filers (curate.sameFiler: the
 * same name, or the name followed only by generic words — "Cisco Systems",
 * "Amazon.com Services"; not "Apple Hospitality"). The ledger's `evidence`,
 * which curate.h1bPetitions sums, adds the store's own posting counts to the
 * filings (Micron 1,561 there against 232 here), so the card does not use it.
 * Returns null when no disclosure file is loaded.
 */
export function dolPetitions(file = null) {
  let rows = null;
  const cache = new Map();
  return (company) => {
    if (rows === null) {
      rows = [];
      try {
        const h = new DatabaseSync(file || dbPath(), { readOnly: true });
        try { rows = h.prepare('SELECT name, eng_certified AS n FROM lca_employers WHERE eng_certified > 0').all().map((r) => ({ k: normCo(r.name), n: r.n })); }
        finally { h.close(); }
      } catch { rows = []; }
    }
    if (!rows.length) return null;
    const c = normCo(company);
    if (!c) return 0;
    if (!cache.has(c)) cache.set(c, rows.filter((r) => sameFiler(c, r.k)).reduce((a, r) => a + r.n, 0));
    return cache.get(c);
  };
}

/** The weight a prior gives a tie: none when the posting's own words overrule it. */
export const priorWeight = (p) => (p && !p.overruled ? p.petitions : 0);

/**
 * Stable: fit first, then the employer's record among equal fits, then the
 * order the store gave. Rows with no fit keep their place at the end.
 */
export function byFitThenPrior(rows) {
  return rows.map((j, i) => ({ j, i }))
    .sort((a, b) => ((b.j.fit?.score ?? -1) - (a.j.fit?.score ?? -1)) || (priorWeight(b.j.sponsorPrior) - priorWeight(a.j.sponsorPrior)) || (a.i - b.i))
    .map((x) => x.j);
}

/**
 * ONE MATCHING RULE FOR THE LINKS AND THE CARD (review, 2026-11-04). The card's
 * count (sponsor-prior.dolPetitions) and the reader's take an employer's own
 * filers by curate.sameFiler; the links that set sponsors_h1b used the older
 * matchEmployers, so the two could disagree. Each company is linked to the
 * largest filer sameFiler accepts. Indexed by first word and by the name with
 * spaces dropped, so 6,000 companies against 50,000 filers is quick.
 */
export function filerLinks(companies, loaded) {
  const byFirst = new Map(), bySquash = new Map();
  for (const r of loaded) {
    const n = normCo(r.name);
    if (!n) continue;
    const e = { key: r.key, n, certified: r.certified || 0 };
    const w = n.split(' ')[0];
    if (!byFirst.has(w)) byFirst.set(w, []);
    byFirst.get(w).push(e);
    const sq = n.replace(/ /g, '');
    if (!bySquash.has(sq)) bySquash.set(sq, []);
    bySquash.get(sq).push(e);
  }
  const out = new Map();
  for (const company of companies) {
    const c = normCo(company);
    const cands = c ? [...(byFirst.get(c.split(' ')[0]) || []), ...(bySquash.get(c.replace(/ /g, '')) || [])] : [];
    const best = cands.filter((e) => sameFiler(c, e.n)).sort((a, b) => b.certified - a.certified)[0];
    out.set(company, best ? { key: best.key, how: 'same-filer' } : { key: '', how: 'none' });
  }
  return out;
}
