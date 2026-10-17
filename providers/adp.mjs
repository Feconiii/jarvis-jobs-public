// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// ADP Workforce Now recruiting — the public career center's own API.
//
// WHY (2026-10-03, F-705). In the 120-company miss sample, 4 ran ADP — Ultium
// Cells (batteries) and FANUC America (robotics) among them. A Workforce Now
// career center is the page
//   https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=<CID>&ccId=<CCID>
// and its script reads
//   …/careercenter/public/events/staffing/v1/job-requisitions?cid=…&ccId=…&$top=20&$skip=…
//     → { jobRequisitions: [{ itemID, requisitionTitle, postDate,
//          requisitionLocations: [{ address: { cityName, countrySubdivisionLevel1: { codeValue } } }] }],
//         meta: { totalNumber } }
// and one posting at …/job-requisitions/<itemID>?cid=…&ccId=… →
//   { requisitionDescription } (HTML), which enrich.mjs reads.
// No auth. The ccId matters: one employer can run several career centers
// (Ultium: three), and without it the API answers with a different, smaller
// set — so an entry lists every ccId it found (`adp_ccids`).
//
// ADP's newer "MyJobs" sites (myjobs.adp.com/<name>/cx — FANUC) are a
// different API and are NOT read here; branded-boards.mjs names them 'adp'.

const HOST = 'workforcenow.adp.com';
const API = `https://${HOST}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`;
const PAGE = 20;
const MAX_PAGES = 50;

/** { cid, ccId } from a career-center or posting URL, or null. */
export function adpIds(raw) {
  let u;
  try { u = new URL(String(raw || '').replace(/&amp;/g, '&')); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST) return null;
  const cid = u.searchParams.get('cid') || '';
  if (!/^[0-9a-f-]{36}$/i.test(cid)) return null;
  const ccId = u.searchParams.get('ccId') || '';
  return { cid: cid.toLowerCase(), ccId: /^[\w-]{1,40}$/.test(ccId) ? ccId : '' };
}

/** Every Workforce Now career center linked from a page: [{ cid, ccId }]. */
export function adpCentersIn(html) {
  const out = new Map();
  for (const m of String(html || '').matchAll(/https:\/\/workforcenow\.adp\.com\/mascsr\/default\/mdf\/recruitment\/recruitment\.html\?[^"'<>\s\\]+/gi)) {
    const ids = adpIds(m[0]);
    if (ids) out.set(`${ids.cid}|${ids.ccId}`, ids);
  }
  return [...out.values()];
}

export const careerCenterUrl = ({ cid, ccId }) =>
  `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?cid=${cid}${ccId ? `&ccId=${ccId}` : ''}&lang=en_US`;

const query = ({ cid, ccId }) => `cid=${cid}&timeStamp=${Date.now()}&lang=en_US${ccId ? `&ccId=${ccId}` : ''}&locale=en_US`;

/** The posting's own description endpoint, for enrich.mjs. */
export function adpDetailApi(postingUrl) {
  const ids = adpIds(postingUrl);
  if (!ids) return null;
  let jobId = '';
  try { jobId = new URL(String(postingUrl).replace(/&amp;/g, '&')).searchParams.get('jobId') || ''; } catch { return null; }
  if (!/^[\w-]{1,40}$/.test(jobId)) return null;
  return `${API}/${jobId}?${query(ids)}`;
}

/**
 * One page of requisitions → normalized jobs. Exported for tests.
 * @param {any} json
 * @param {{cid: string, ccId: string}} ids
 * @param {string} company
 */
export function parseAdpResponse(json, ids, company) {
  const list = Array.isArray(json?.jobRequisitions) ? json.jobRequisitions : [];
  const jobs = [];
  for (const r of list) {
    if (!r?.itemID || !r?.requisitionTitle) continue;
    const places = (Array.isArray(r.requisitionLocations) ? r.requisitionLocations : []).map((l) => {
      const a = l?.address || {};
      const named = [a.cityName, a.countrySubdivisionLevel1?.codeValue].filter(Boolean).join(', ');
      return named || String(l?.nameCode?.shortName || '').trim();
    }).filter(Boolean);
    const posted = r.postDate ? Date.parse(r.postDate) : NaN;
    jobs.push({
      title: String(r.requisitionTitle).trim(),
      url: `${careerCenterUrl(ids)}&jobId=${r.itemID}`,
      company: company || '',
      location: places.join(' | '),
      postedAt: Number.isNaN(posted) ? undefined : posted,
    });
  }
  return { jobs, total: Number(json?.meta?.totalNumber) || 0 };
}

/** The career centers an entry reads: its URL's, plus any listed in adp_ccids. */
function centersOf(entry) {
  const base = adpIds(entry.careers_url);
  if (!base) return [];
  const extra = String(entry.adp_ccids || '').split(',').map((s) => s.trim()).filter((s) => /^[\w-]{1,40}$/.test(s));
  const ccIds = [...new Set([base.ccId, ...extra])];
  return ccIds.map((ccId) => ({ cid: base.cid, ccId }));
}

/** @type {Provider} */
export default {
  id: 'adp',

  detect(entry) {
    return adpIds(entry.careers_url) ? { url: String(entry.careers_url) } : null;
  },

  async fetch(entry, ctx) {
    const centers = centersOf(entry);
    if (!centers.length) throw new Error(`adp: ${entry.name} needs a careers_url like https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=<CID>&ccId=<CCID>`);
    const cap = Number(entry.max_pages) > 0 ? Math.min(Number(entry.max_pages), MAX_PAGES) : MAX_PAGES;
    const seen = new Set();
    const all = [];
    for (const ids of centers) {
      let got = 0;
      for (let page = 0; page < cap; page++) {
        const json = await ctx.fetchJson(`${API}?${query(ids)}&$top=${PAGE}&$skip=${page * PAGE}`,
          { headers: { accept: 'application/json' }, redirect: 'error' });
        const { jobs, total } = parseAdpResponse(json, ids, entry.name);
        if (!jobs.length) break;
        for (const j of jobs) {
          const id = j.url.split('jobId=')[1];
          if (seen.has(id)) continue;   // the same requisition in two career centers
          seen.add(id);
          all.push(j);
        }
        got += jobs.length;
        if (total && got >= total) break;
      }
    }
    return all;
  },
};
