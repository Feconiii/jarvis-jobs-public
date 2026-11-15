// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// BambooHR provider — hits the public per-tenant careers list API.
// Auto-detects from careers_url pattern `https://<tenant>.bamboohr.com[/...]`.
// Per-tenant subdomains are the variable part, so SSRF defence uses a regex
// match on `<safe-tenant>.bamboohr.com` rather than a static allowlist
// (same approach as the recruitee provider).
//
// The list endpoint (`/careers/list`) returns lightweight metadata — enough for
// the Job contract (title, url, location) at zero token cost. The full JD lives
// behind a second `/careers/<id>/detail` request, which the scanner deliberately
// skips to stay zero-token (so `description`/`postedAt` are omitted).

const BAMBOOHR_HOST_RE = /^[a-z0-9][a-z0-9-]*\.bamboohr\.com$/;

/** @param {string} url */
function assertBambooHRUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`bamboohr: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`bamboohr: URL must use HTTPS: ${url}`);
  if (!BAMBOOHR_HOST_RE.test(parsed.hostname)) {
    throw new Error(`bamboohr: untrusted hostname "${parsed.hostname}" — must match <tenant>.bamboohr.com`);
  }
  return url;
}

/**
 * Resolve the tenant origin (`https://<tenant>.bamboohr.com`) from an entry.
 * Honours an explicit `api:` URL, else parses `careers_url`.
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {string | null}
 */
function resolveOrigin(entry) {
  const rawApi = typeof entry.api === 'string' ? entry.api : '';
  const rawCareers = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  const raw = (rawApi || rawCareers).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!BAMBOOHR_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}`;
}

/** @type {Provider} */
export default {
  id: 'bamboohr',

  detect(entry) {
    const origin = resolveOrigin(entry);
    return origin ? { url: `${origin}/careers/list` } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) throw new Error(`bamboohr: cannot derive API URL for ${entry.name}`);
    const apiUrl = `${origin}/careers/list`;
    assertBambooHRUrl(apiUrl);
    // redirect:'error' + the host check above keep the final hostname pinned to
    // the tenant — a server-side redirect can't bounce us off-domain (SSRF).
    const json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    // A failed read, never a set of postings: the scan names it under
    // "board(s) failed to read" every run until the entry is fixed (F-637).
    if (isBambooPlaceholder(json?.result)) {
      throw new Error(`bamboohr: ${origin} serves BambooHR's placeholder demo board (#15 "IT Security Engineer", Mayfair), not ${entry.name}'s careers site (F-637)`);
    }
    return parseBambooHRResponse(json, entry.name, origin);
  },
};

/**
 * The demo board BambooHR served under unclaimed-looking subdomains (F-637):
 * andai, culture, curative, xylem, mte and nine more all answered with job #15
 * "IT Security Engineer" in Mayfair, London, beside a generic four or five.
 * @param {any} jobs  the `result` array of /careers/list
 */
export function isBambooPlaceholder(jobs) {
  return (Array.isArray(jobs) ? jobs : []).some(x => String(x?.id) === '15'
    && /^IT Security Engineer$/i.test(String(x?.jobOpeningName || '').trim())
    && /mayfair/i.test(JSON.stringify(x?.location || '')));
}

/**
 * Parse a BambooHR `/careers/list` response. Exported for unit tests.
 *
 * BambooHR returns:
 *   { meta: {...}, result: [{ id, jobOpeningName,
 *       location: { city?, state? }, isRemote?, employmentStatusLabel? }] }
 *
 * - url: built as `<origin>/careers/<id>` — matches the public
 *   `jobOpeningShareUrl`. Rows without a non-empty `id` are dropped (no stable
 *   URL, and url is the scanner's dedup key — a blank id would emit
 *   `/careers/` and collapse distinct postings together).
 * - location: join `city` + `state`; append "Remote" when `isRemote` is truthy.
 *   BambooHR's `isRemote` is `1`/`true` when set and `null` otherwise.
 *
 * @param {any} json
 * @param {string} companyName
 * @param {string} origin  e.g. "https://acme.bamboohr.com"
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseBambooHRResponse(json, companyName, origin) {
  const rows = json?.result;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(j => j && j.jobOpeningName && String(j.id ?? '').trim().length > 0)
    .map(j => {
      const loc = j.location || {};
      const remote = j.isRemote ? 'Remote' : '';
      const location = [loc.city, loc.state, remote].filter(Boolean).join(', ');
      const id = String(j.id).trim();
      return {
        title: String(j.jobOpeningName),
        url: `${origin}/careers/${encodeURIComponent(id)}`,
        company: companyName,
        location,
      };
    });
}
