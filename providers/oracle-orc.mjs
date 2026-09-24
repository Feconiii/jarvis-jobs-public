// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Oracle Recruiting Cloud (ORC / "CandidateExperience") provider.
// Public REST endpoint, no auth:
//   https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//     ?onlyData=true&finder=findReqs;siteNumber=<site>,limit=N,offset=M
//
// Explicit configuration (no auto-detect) — a portals.yml entry sets:
//   provider: oracle-orc
//   orc_host: https://edbz.fa.us2.oraclecloud.com
//   orc_site: CX_1
//   careers_base: https://careers.ti.com/en/sites/CX_1   (vanity job-URL base)

const PAGE = 100;
const MAX_PAGES = 40; // 4000 postings safety cap

/** @type {Provider} */
export default {
  id: 'oracle-orc',

  detect() { return null; },

  async fetch(entry, ctx) {
    const host = String(entry.orc_host || '').replace(/\/$/, '');
    const site = entry.orc_site || 'CX_1';
    const base = String(entry.careers_base || `${host}/hcmUI/CandidateExperience/en/sites/${site}`).replace(/\/$/, '');
    if (!host.startsWith('https://')) throw new Error(`oracle-orc: entry "${entry.name}" needs orc_host`);

    const jobs = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${site},limit=${PAGE},offset=${page * PAGE},sortBy=POSTING_DATES_DESC`;
      const json = /** @type {any} */ (await ctx.fetchJson(url, { timeoutMs: 25000 }));
      const item = json?.items?.[0];
      const reqs = Array.isArray(item?.requisitionList) ? item.requisitionList : [];
      for (const r of reqs) {
        if (!r?.Id || !r?.Title) continue;
        const locs = [r.PrimaryLocation, ...(Array.isArray(r.secondaryLocations) ? r.secondaryLocations.map((/** @type {any} */ s) => s?.Name) : [])]
          .filter(Boolean).join(' | ');
        const posted = r.PostedDate ? Date.parse(r.PostedDate) : NaN;
        jobs.push({
          title: String(r.Title).trim(),
          url: `${base}/job/${r.Id}`,
          company: entry.name || '',
          location: locs,
          postedAt: Number.isNaN(posted) ? undefined : posted,
          // Where the description lives. The posting URL is a vanity domain
          // (careers.ti.com) that 302s the API to an error page, and neither
          // the real Oracle host nor the site number appears in it — so
          // enrichment cannot derive this endpoint from the URL the way it
          // does for Workday or Greenhouse. Carrying it on the job is the only
          // way the enricher can reach the text, and without it 294 postings
          // were being scored on their title alone.
          detailApi: `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
            + `?expand=all&onlyData=true&finder=ById%3BId%3D%22${encodeURIComponent(r.Id)}%22`
            + `%2CsiteNumber%3D%22${encodeURIComponent(site)}%22`,
        });
      }
      const total = Number(item?.TotalJobsCount || 0);
      if (jobs.length >= total || reqs.length === 0) break;
    }
    return jobs;
  },
};
