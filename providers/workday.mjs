// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public CXS jobs endpoint (POST, paginated).
// Auto-detects from either public careers_url shape:
//   https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>
//   https://<instance>.myworkdaysite.com/recruiting/<tenant>/<site>
// e.g. https://23andme.wd5.myworkdayjobs.com/23 →
//      POST https://23andme.wd5.myworkdayjobs.com/wday/cxs/23andme/23/jobs
//
// Workday only exposes a relative "postedOn" label ("Posted Today",
// "Posted 5 Days Ago", "Posted 30+ Days Ago"); postedAt is derived from it
// and omitted for the unbounded "30+ Days Ago" form.

const PAGE_SIZE = 20;
const MAX_PAGES = 50; // default safety cap — at most 1000 postings per site
const MAX_PAGES_CAP = 500; // hard ceiling even with entry.max_pages

// Large tenants (Stryker, Medtronic) exceed 1000 postings; a portal entry can
// raise the cap with `max_pages:` (mirrors jibeapply.mjs).
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return MAX_PAGES;
}

/**
 * Workday publishes on TWO public hosts, and this only knew one (F-453).
 *
 *   tenant-first   https://<tenant>.<wdN>.myworkdayjobs.com[/<locale>]/<site>
 *   host-first     https://<wdN>.myworkdaysite.com/recruiting/<tenant>/<site>
 *
 * Both answer the same CXS endpoint, `<origin>/wday/cxs/<tenant>/<site>/jobs`;
 * only the way the tenant is spelled into the URL differs. Onto Innovation is
 * on the second — 185 postings — and was filed as "No public ATS API found",
 * with a careers_url whose domain does not even resolve.
 */
function resolveEndpoint(entry) {
  const url = entry.careers_url || '';

  // tenant-first: acme.wd5.myworkdayjobs.com/en-US/Careers
  let m = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  if (m) {
    const [, tenant, instance, site] = m;
    const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
    return {
      api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
      // externalPath is relative to the site, not the host root — without the
      // site segment the URL 404s.
      jobBase: `${origin}/${site}`,
    };
  }

  // host-first: wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers
  m = url.match(/^https:\/\/(wd[\w-]*)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([\w-]+)\/([^/?#]+)/);
  if (m) {
    const [, instance, tenant, site] = m;
    const origin = `https://${instance}.myworkdaysite.com`;
    return {
      api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
      jobBase: `${origin}/recruiting/${tenant}/${site}`,
    };
  }

  return null;
}

function parsePostedOn(label) {
  if (!label) return undefined;
  if (/posted\s+today/i.test(label)) return Date.now();
  if (/posted\s+yesterday/i.test(label)) return Date.now() - 86_400_000;
  const m = label.match(/posted\s+(\d+)(\+?)\s*day/i);
  if (!m || m[2] === '+') return undefined; // "30+ Days Ago" — unbounded, no usable date
  return Date.now() - Number(m[1]) * 86_400_000;
}

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const ep = resolveEndpoint(entry);
    return ep ? { url: ep.api } : null;
  },

  async fetch(entry, ctx) {
    const ep = resolveEndpoint(entry);
    if (!ep) throw new Error(`workday: cannot derive CXS endpoint for ${entry.name}`);

    const jobs = [];
    const maxPages = resolveMaxPages(entry);
    for (let page = 0; page < maxPages; page++) {
      const body = JSON.stringify({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        searchText: '',
        appliedFacets: {},
      });
      const json = await ctx.fetchJson(ep.api, {
        method: 'POST',
        redirect: 'error',
        body,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
      });
      const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      for (const j of postings) {
        if (!j.externalPath) continue;
        jobs.push({
          title: j.title || '',
          url: ep.jobBase + j.externalPath,
          company: entry.name,
          location: j.locationsText || '',
          postedAt: parsePostedOn(j.postedOn),
        });
      }
      if (postings.length < PAGE_SIZE) break;
    }
    return jobs;
  },
};
