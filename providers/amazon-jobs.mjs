// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Amazon provider — hits the public amazon.jobs search.json endpoint.
//
// Amazon runs its own ATS (iCIMS-backed) rather than Greenhouse/Workday, so it
// needs a dedicated provider. The endpoint is the same one the public careers
// search UI calls, and it takes no auth.
//
// Two things about it are worth knowing, because they decide what "we scanned
// Amazon" can honestly mean:
//
//   1. `hits` saturates at 10000 and `offset` stops returning rows past 10000.
//      A single query can therefore never see more than 10k postings.
//   2. There is no cursor — only offset paging at 100/page.
//
// So a plain unfiltered crawl silently truncates. To get past the cap we shard
// the crawl by `business_category` (aws, retail, devices, ops, …): each shard
// gets its own 10k window, and the union covers far more than one flat scan.
// Shards are configured in portals.yml (`categories:`), defaulting to the full
// public category list. Every shard that saturates is reported, so truncation
// is visible rather than silent.
//
// portals.yml knobs:
//   provider:   amazon-jobs
//   countries:  [USA]        # normalized_country_code filter; [] = worldwide
//   categories: [aws, ...]   # business_category shards; [] = one flat crawl
//   max_pages:  100          # per shard, 100 postings/page (cap: 100)

const SEARCH_HOST = 'www.amazon.jobs';
const SEARCH_URL = `https://${SEARCH_HOST}/en/search.json`;
const PAGE_SIZE = 100;
const OFFSET_CAP = 10000; // API returns nothing past this
const MAX_PAGES_DEFAULT = 100;

// Amazon's business_category facet. Sharding on it multiplies the reachable
// window past the per-query 10k ceiling.
//
// These slugs are the values Amazon stamps on the postings themselves,
// harvested by sampling the live feed — NOT guesses. That distinction matters:
// an unrecognised slug does not error, it silently returns 0 hits, so a wrong
// list looks exactly like an empty category. `job_category[]` is deliberately
// not used here: the API accepts it and then ignores it, returning the full
// unfiltered set, which would make every shard a duplicate full crawl.
const DEFAULT_CATEGORIES = [
  'aws',
  'alexa-and-amazon-devices',
  'fulfillment-and-operations',
  'fulfillment-ops',
  'fulfillment-ops-team',
  'fulfillment-technology-and-robotics',
  'operations',
  'transportation-and-logistics',
  'transportation-shipping-logistics',
  'finance',
  'pxt',
  'advertising',
  'retail',
  'entertainment',
  'subsidiaries',
  'amazon-security',
  'healthcare',
  'legal',
  'worldwide-grocery-stores',
  'ecp',
  'amazon-business',
  'north-america-stores',
  'international-stores',
  'selling-partner-services',
  'consumer_engagement',
  'global-communications-and-community-impact',
  'studentprograms',
  'ats',
  'customer-service',
  'amazon-customer-service',
  'customer-trust-and-partner-support',
  'public-relations-and-public-policy',
  'global-corporate',
  'amazon-artificial-general-intelligence',
  'amazonian-experience-and-tech',
  'core-ai',
  'alexa',
  'kindlecontent',
  'cross-channel-cross-category-marketing',
  'no-business-category',
];

/** @param {string} url */
function assertAmazonUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`amazon-jobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`amazon-jobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== SEARCH_HOST)
    throw new Error(`amazon-jobs: untrusted hostname "${parsed.hostname}" — must be ${SEARCH_HOST}`);
  return url;
}

// "August  3, 2026" (note the double space on single-digit days) → epoch ms.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(String(value).replace(/\s+/g, ' ').trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildUrl({ offset, countries, category }) {
  const params = new URLSearchParams();
  params.set('base_query', '');
  params.set('result_limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  params.set('sort', 'recent');
  for (const cc of countries) params.append('normalized_country_code[]', cc);
  if (category) params.append('business_category[]', category);
  return `${SEARCH_URL}?${params.toString()}`;
}

function normalizeJob(raw, entry) {
  const path = raw?.job_path;
  if (!path || !raw.title) return null;
  // job_path is site-relative ("/en/jobs/123/title"); anchor it to the known host.
  const url = new URL(path, `https://${SEARCH_HOST}`).href;
  if (!url.startsWith(`https://${SEARCH_HOST}/`)) return null;

  // Qualifications carry the degree/experience signal triage keys off, so fold
  // them into the description rather than dropping them.
  const description = [raw.description, raw.basic_qualifications, raw.preferred_qualifications]
    .filter(Boolean)
    .join('\n\n');

  return {
    title: raw.title.trim(),
    url,
    company: entry.name || 'Amazon',
    location: raw.normalized_location || [raw.city, raw.state, raw.country_code].filter(Boolean).join(', '),
    team: raw.job_category || raw.business_category || '',
    description,
    postedAt: toEpochMs(raw.posted_date),
  };
}

/** @param {any} entry */
function resolveConfig(entry) {
  const countries = Array.isArray(entry.countries)
    ? entry.countries.map(c => String(c).toUpperCase())
    : ['USA'];
  const categories = Array.isArray(entry.categories) ? entry.categories.map(String) : DEFAULT_CATEGORIES;
  const maxPages = Math.min(
    Number.isFinite(entry.max_pages) ? Number(entry.max_pages) : MAX_PAGES_DEFAULT,
    OFFSET_CAP / PAGE_SIZE,
  );
  return { countries, categories, maxPages };
}

/** @type {Provider} */
export default {
  id: 'amazon-jobs',

  detect(entry) {
    const url = entry.careers_url || '';
    return /(^|\/\/)([a-z0-9-]+\.)?amazon\.jobs(\/|$)/i.test(url) ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const { countries, categories, maxPages } = resolveConfig(entry);
    // `null` is the unsharded crawl. It runs first and always: the category
    // list can go stale when Amazon renames an org, and a posting carrying an
    // unknown slug would fall through every shard. The flat pass guarantees the
    // 10k most-recent postings are captured no matter what the facets do.
    // `categories: []` in portals.yml opts out of sharding entirely.
    const shards = categories.length ? [null, ...categories] : [null];

    const byUrl = new Map();
    const saturated = [];

    for (const category of shards) {
      let pages = 0;
      for (let offset = 0; offset < OFFSET_CAP && pages < maxPages; offset += PAGE_SIZE, pages++) {
        const url = buildUrl({ offset, countries, category });
        assertAmazonUrl(url);
        let json;
        try {
          json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error', timeoutMs: 30000 }));
        } catch (err) {
          // One bad page shouldn't void the whole company. Stop this shard,
          // keep everything already collected, move to the next shard.
          if (offset === 0) throw err;
          break;
        }
        const rows = Array.isArray(json?.jobs) ? json.jobs : [];
        for (const raw of rows) {
          const job = normalizeJob(raw, entry);
          if (job) byUrl.set(job.url, job); // dedupe across category shards
        }
        if (rows.length < PAGE_SIZE) break; // last page of this shard
        if (offset + PAGE_SIZE >= OFFSET_CAP) saturated.push(category || 'all');
      }
    }

    const jobs = [...byUrl.values()];
    if (saturated.length) {
      // Surfaced in the scan log so a truncated crawl is never mistaken for a
      // complete one.
      console.error(
        `  ⓘ amazon-jobs: hit the 10k API ceiling on ${saturated.length} shard(s) — ` +
        `${saturated.slice(0, 5).join(', ')}${saturated.length > 5 ? ', …' : ''}. ` +
        `Those categories have more postings than the API will page through.`,
      );
    }
    return jobs;
  },
};
