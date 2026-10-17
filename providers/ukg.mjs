// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// UKG Pro Recruiting (formerly UltiPro) — the public job board's own search.
//
// WHY (2026-10-03, F-705). Measured on 120 companies a LinkedIn pass named and
// the resolver missed, 7 ran UKG — among them Ultra Clean Technology (semicap)
// and Convergix Automation — and nothing here could read it. The board is a
// public page at
//   https://recruiting<n>.ultipro.com/<TENANT>/JobBoard/<BOARD-GUID>/
// whose script POSTs to
//   …/JobBoardView/LoadSearchResults
// with an `opportunitySearch` body and gets back
//   { opportunities: [{ Id, Title, RequisitionNumber, Locations: [{ Address:
//     { City, State: { Code }, Country: { Code } } }], PostedDate,
//     BriefDescription, JobCategoryName }], totalCount }
// No auth, no cookie. The full description is on each posting's
// OpportunityDetail page (embedded-posting.mjs → ukgPosting), read by enrich.
//
// Auto-detects from careers_url; the tenant and board id are the whole config.

const UKG_HOST_RE = /^recruiting\d*\.ultipro\.com$/i;
const BOARD_RE = /^\/([A-Za-z0-9]+)\/JobBoard\/([0-9a-f-]{36})/i;
const PAGE = 50;
const MAX_PAGES = 40;   // 2,000 postings — above any UKG board seen

/** The board's base URL from any URL on it, or null. */
export function ukgBase(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'https:' || !UKG_HOST_RE.test(u.hostname)) return null;
  const m = u.pathname.match(BOARD_RE);
  return m ? `https://${u.hostname.toLowerCase()}/${m[1]}/JobBoard/${m[2].toLowerCase()}` : null;
}

/** Every UKG board linked from a page. */
export function ukgBoardsIn(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/https:\/\/recruiting\d*\.ultipro\.com\/[A-Za-z0-9]+\/JobBoard\/[0-9a-fA-F-]{36}/g)) {
    const b = ukgBase(m[0]);
    if (b) out.add(b);
  }
  return [...out];
}

const searchBody = (skip) => ({
  opportunitySearch: {
    Top: PAGE, Skip: skip, QueryString: '',
    OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
    Filters: [4, 5, 6].map((fieldName) => ({ t: 'TermsSearchFilterDto', fieldName, extra: null, values: [] })),
  },
  matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] },
});

/**
 * One page of the search response → normalized jobs. Exported for tests.
 * @param {any} json
 * @param {string} base
 * @param {string} company
 */
export function parseUkgResponse(json, base, company) {
  const list = Array.isArray(json?.opportunities) ? json.opportunities : [];
  const jobs = [];
  for (const o of list) {
    if (!o?.Id || !o?.Title) continue;
    const places = (Array.isArray(o.Locations) ? o.Locations : []).map((l) => {
      const a = l?.Address || {};
      return [a.City, a.State?.Code || a.State?.Name, a.Country?.Code === 'USA' ? 'US' : (a.Country?.Code || '')]
        .filter(Boolean).join(', ') || String(l?.LocalizedDescription || '');
    }).filter(Boolean);
    const posted = o.PostedDate ? Date.parse(o.PostedDate) : NaN;
    jobs.push({
      title: String(o.Title).trim(),
      url: `${base}/OpportunityDetail?opportunityId=${o.Id}`,
      company: company || '',
      location: places.join(' | '),
      postedAt: Number.isNaN(posted) ? undefined : posted,
    });
  }
  return { jobs, total: Number(json?.totalCount) || 0 };
}

/** @type {Provider} */
export default {
  id: 'ukg',

  detect(entry) {
    const base = ukgBase(entry.careers_url);
    return base ? { url: base } : null;
  },

  async fetch(entry, ctx) {
    const base = ukgBase(entry.careers_url);
    if (!base) throw new Error(`ukg: ${entry.name} needs a careers_url like https://recruiting.ultipro.com/<TENANT>/JobBoard/<GUID>/`);
    const cap = Number(entry.max_pages) > 0 ? Math.min(Number(entry.max_pages), MAX_PAGES) : MAX_PAGES;
    const all = [];
    for (let page = 0; page < cap; page++) {
      const json = await ctx.fetchJson(`${base}/JobBoardView/LoadSearchResults`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(searchBody(page * PAGE)),
        redirect: 'error',
      });
      const { jobs, total } = parseUkgResponse(json, base, entry.name);
      all.push(...jobs);
      if (jobs.length < PAGE || (total && all.length >= total)) break;
    }
    return all;
  },
};
