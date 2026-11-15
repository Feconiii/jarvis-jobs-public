// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Phenom People provider — the career-site platform behind a large share of the
// Fortune 500 (Thermo Fisher, Zimmer Biomet, Microsoft's front end, and the
// long tail of "jobs.<company>.com" sites served from static.vscdn.net).
//
// Every Phenom site exposes the same POST endpoint its own search box uses:
//
//   POST https://<host>/widgets
//   { ddoKey: "refineSearch", from, size, ... }
//   → { refineSearch: { totalHits, data: { jobs: [ … ] } } }
//
// No key, no session, no scraping — the same request the page makes. Each job
// arrives complete enough to skip enrichment: title, requisition id, city /
// state / country, category, posted date and a description teaser.
//
// Configure with an explicit provider and the public careers host:
//
//   - name: Thermo Fisher Scientific
//     provider: phenom
//     careers_url: https://jobs.thermofisher.com
//
// `apply_host: workday` is implied when a posting's applyUrl points at a
// Workday tenant — Phenom is often only the shop window over another ATS, and
// keeping the real apply URL is what lets the apply engine drive the form.

const PAGE_SIZE = 100;
const MAX_PAGES = 60;          // 6,000 postings — above every Phenom site seen
const PHENOM_HOST = /(^|\.)([a-z0-9-]+\.)+[a-z]{2,}$/i;

function hostFor(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!PHENOM_HOST.test(parsed.hostname)) return null;
  return parsed.hostname;
}

function searchBody(from, size) {
  return {
    lang: 'en_us',
    deviceType: 'desktop',
    country: 'us',
    pageName: 'search-results',
    ddoKey: 'refineSearch',
    sortBy: '',
    subsearch: '',
    from,
    jobs: true,
    counts: true,
    all_fields: ['country', 'state', 'city', 'category'],
    size,
    keywords: '',
    global: true,
  };
}

/**
 * Phenom is frequently a front end over Workday or Taleo, and `applyUrl` is the
 * real posting. Prefer it — a URL the apply engine can actually drive is worth
 * more than a prettier one — but drop the trailing `/apply` so the link opens
 * the posting rather than jumping straight into a form.
 */
function jobUrl(host, j) {
  const apply = typeof j.applyUrl === 'string' ? j.applyUrl.trim() : '';
  if (apply.startsWith('https://')) return apply.replace(/\/apply\/?$/, '');
  const seq = j.jobSeqNo || j.jobId || j.reqId;
  if (!seq) return '';
  const slug = String(j.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://${host}/us/en/job/${encodeURIComponent(String(seq))}/${slug}`;
}

/**
 * THE POSTING'S OWN PAGE ON THE PHENOM SITE (2026-11-12). Phenom over
 * SuccessFactors, Taleo or UltiPro hands back an apply link that no reader
 * can open (career4.successfactors.com/career?…career_job_req_id=287881), so
 * those rows kept the list teaser for good: 391 struck out, Bechtel, STERIS,
 * Honda, LANXESS, Swagelok, Vontier and AFL among them. Their page on the
 * Phenom site carries the whole record (Bechtel 18,994 characters, measured).
 * The locale in the path is, in order: the one the id names (…EXTERNALENUS →
 * us/en, …EXTERNALENGLOBAL → global/en), the one the apply link asks for
 * (lang=de_DE → de/de), the one the site's own careers_url is filed under
 * (https://jobs.x.com/gb/en → gb/en), and only then us/en. A wrong guess is
 * not a strike: the enricher tries the locale the site redirects to and does
 * not count a page it could not find (F-1048 review). Exported for tests.
 */
export function phenomPage(host, j, siteLocale = '') {
  const seq = String(j?.jobSeqNo || '').trim();
  if (!host || !/^[A-Za-z0-9-]+$/.test(seq)) return '';
  const loc = /EXTERNAL([A-Z]{2})([A-Z]{2,6})$/.exec(seq);
  const asked = /[?&](?:lang|locale)=([a-z]{2})[_-]([a-z]{2})(?![a-z])/i.exec(String(j?.applyUrl || ''));
  const path = loc ? `${loc[2].toLowerCase()}/${loc[1].toLowerCase()}`
    : asked ? `${asked[2].toLowerCase()}/${asked[1].toLowerCase()}`
    : /^[a-z]{2,6}\/[a-z]{2}$/.test(siteLocale) ? siteLocale : 'us/en';
  const slug = String(j.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://${host}/${path}/job/${seq}/${slug}`;
}

/**
 * Parse one `refineSearch` response. Exported for unit tests.
 *
 * @param {any} json
 * @param {string} host
 * @param {string} companyName
 */
export function parsePhenomResponse(json, host, companyName, { siteLocale = '' } = {}) {
  const jobs = json?.refineSearch?.data?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((j) => {
    const location = j.cityStateCountry
      || [j.city, j.state, j.country].filter(Boolean).join(', ')
      || j.location || '';
    const posted = Date.parse(j.postedDate || j.dateCreated || '');
    /** @type {any} */
    const out = {
      title: String(j.title || '').trim(),
      url: jobUrl(host, j),
      company: companyName,
      location: String(location).trim(),
    };
    if (j.category) out.team = String(j.category).trim();
    if (Number.isFinite(posted)) out.postedAt = posted;
    if (j.descriptionTeaser) out.description = String(j.descriptionTeaser);
    // Where the enricher reads the body when the stored link has no reader:
    // never for a Workday link (read as it is) or a link that is already a
    // page on this site. The stored url stays what it was, so no id moves.
    if (!/myworkday(?:jobs|site)\.com\//.test(out.url) && !out.url.startsWith(`https://${host}/`)) {
      const page = phenomPage(host, j, siteLocale);
      if (page) out.detailApi = page;
    }
    return out;
  }).filter((j) => j.title && j.url);
}

/** The locale a careers_url is filed under (https://jobs.x.com/gb/en/ → gb/en), or ''. Exported for tests. */
export function siteLocaleOf(careersUrl) {
  try { return /^\/([a-z]{2,6}\/[a-z]{2})(?:\/|$)/.exec(new URL(String(careersUrl || '')).pathname)?.[1] || ''; } catch { return ''; }
}

/** Total hits reported by the search, or null when absent. Exported for tests. */
export function totalHits(json) {
  const n = json?.refineSearch?.totalHits;
  return Number.isFinite(n) ? n : null;
}

/** @type {Provider} */
export default {
  id: 'phenom',

  // No detect(): a Phenom site lives on the company's own domain, so there is
  // no hostname pattern to match on. Entries opt in with `provider: phenom`.

  async fetch(entry, ctx) {
    const host = hostFor(entry);
    if (!host) throw new Error(`phenom: ${entry.name} needs a careers_url (https://jobs.<company>.com)`);

    const cap = Number(entry.max_pages) > 0 ? Math.min(Number(entry.max_pages), MAX_PAGES) : MAX_PAGES;
    const siteLocale = siteLocaleOf(entry.careers_url);
    const url = `https://${host}/widgets`;
    const all = [];
    let expected = null;

    for (let page = 0; page < cap; page++) {
      const json = await ctx.fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(searchBody(page * PAGE_SIZE, PAGE_SIZE)),
      });
      if (expected === null) expected = totalHits(json);
      const batch = parsePhenomResponse(json, host, entry.name, { siteLocale });
      if (!batch.length) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      if (expected !== null && all.length >= expected) break;
    }
    return all;
  },
};
