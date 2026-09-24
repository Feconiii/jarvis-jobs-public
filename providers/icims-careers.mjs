// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// iCIMS "careers-home" provider — the branded wrapper, not the gated host.
//
// WHY THIS EXISTS (F-454). `providers/icims.mjs` talks to
// `careers-<co>.icims.com`, and as of 2026-09-10 that host refuses every
// non-browser request — sitemap, search and postings alike, one WAF rule
// (F-448). Eleven tracked employers sat behind it: 1,562 live rows, 14% read.
//
// But most large iCIMS customers do not send candidates to that host. They run
// a BRANDED Angular front end on their own domain — `careers.rivian.com`,
// `jobs.<co>.com` — and that app is backed by a plain JSON api at
// `<origin>/api/jobs?page=N&limit=M` which is **not gated at all**. Measured
// on Rivian: HTTP 200 to a plain server request, `count: 746`.
//
// It is strictly better than the raw iCIMS route ever was:
//
//   · the listing carries the FULL description, so there is no enrichment pass
//     and no per-posting fetch (8,926 characters on the first Rivian row);
//   · it carries city, state, country and `full_location`, where the iCIMS
//     sitemap carried no location at all and left everything 'unknown';
//   · it carries `posted_date`, `categories`, `employment_type` and the real
//     `apply_url`.
//
// The apply_url still points at `*.icims.com`, which is correct — that is where
// he applies, in a browser, which is exactly the context iCIMS will serve.
//
// Configure with the branded careers origin:
//
//   - name: Rivian
//     provider: icims-careers
//     careers_url: https://careers.rivian.com

const PAGE_SIZE = 50;
const MAX_PAGES = 40;          // 2,000 postings per board by default
const MAX_PAGES_CAP = 200;

function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return MAX_PAGES;
}

/** The branded origin, or null when careers_url is not a plain https origin. */
export function resolveOrigin(entry) {
  const raw = String(entry?.careers_url || '').trim();
  if (!raw.startsWith('https://')) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  // The GATED host is never this provider's business — that is icims.mjs, and
  // pointing this at it would produce a confusing 405 instead of a clear one.
  if (/\.icims\.com$/i.test(u.hostname)) return null;
  return `https://${u.hostname}`;
}

/**
 * Turn one `/api/jobs` row into a Job. Exported for the tests, because the
 * shape is the whole risk: a location assembled wrongly buckets a US role as
 * foreign and drops it out of his deck without a word.
 */
export function parseCareersHomeRow(row, company) {
  const d = row?.data;
  if (!d) return null;
  const title = String(d.title || '').trim();
  const req = String(d.req_id || d.slug || '').trim();
  if (!title || !req) return null;

  // `full_location` is the site's own rendering and is right when present.
  // Falling back to city/state/country keeps the same order rather than
  // inventing one, and an empty string buckets as 'unknown' — visible — which
  // is the honest failure. Never guess a country.
  const location = String(
    d.full_location
    || [d.city, d.state, d.country].filter(Boolean).join(', ')
    || d.location_name
    || '',
  ).trim();

  // Description first, then the two blocks iCIMS splits out. Some tenants put
  // everything in `description` and leave the others empty; some do not.
  const body = [d.description, d.responsibilities, d.qualifications]
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .join('\n\n');

  // `apply_url` is iCIMS's LOGIN url (`/jobs/31277/login`). Sending him there
  // means a sign-in wall before he can read the posting, so the public view
  // (`/jobs/31277/job`) is used when the shape is recognisable and the login
  // url is kept only as the fallback. Same host, same requisition — this
  // rewrites the path, never the destination.
  const applyUrl = String(d.apply_url || '').trim();
  if (!/^https:\/\//.test(applyUrl)) return null;
  const url = applyUrl.replace(/\/jobs\/(\d+)\/login(?=$|[/?#])/, '/jobs/$1/job');

  const job = {
    title,
    url,
    company: company || '',
    location,
    team: String(d.category || (Array.isArray(d.categories) ? d.categories[0] : '') || '').trim(),
  };
  if (body) job.description = body;
  const ts = Date.parse(d.posted_date || d.create_date || '');
  if (!Number.isNaN(ts)) job.postedAt = ts;
  return job;
}

/** @type {Provider} */
export default {
  id: 'icims-careers',

  // OPT-IN ONLY (F-499). `resolveOrigin` accepts any https origin, so a
  // detect() built on it claimed EVERY company whose provider sorts after
  // "icims-careers" — scan.mjs asks the providers in file order and takes the
  // first yes. From 2026-09-10 lever, rippling, recruitee, smartrecruiters and
  // workable boards were all sent to `<origin>/api/jobs`, 404'd, and scanned
  // nothing for nine days. A branded careers site cannot be recognised from its
  // URL, so this provider answers only when the entry names it — which is how
  // Rivian is configured and how discover-ats.mjs writes new ones.
  detect(entry) {
    if (entry?.provider !== 'icims-careers') return null;
    const origin = resolveOrigin(entry);
    return origin ? { url: `${origin}/api/jobs?page=1&limit=1` } : null;
  },

  async fetch(entry, ctx) {
    const origin = resolveOrigin(entry);
    if (!origin) {
      throw new Error(
        `icims-careers: ${entry.name} needs a branded https careers origin `
        + '(e.g. https://careers.rivian.com). A *.icims.com host belongs to the `icims` provider, '
        + 'and that host is gated — see F-448.',
      );
    }
    const maxPages = resolveMaxPages(entry);
    const out = [];
    const seen = new Set();
    let expected = null;

    for (let page = 1; page <= maxPages; page++) {
      const url = `${origin}/api/jobs?page=${page}&limit=${PAGE_SIZE}`;
      // redirect:'error' pins the hostname — a server-side redirect must not
      // bounce this off the employer's own domain.
      const json = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error' }));
      const rows = Array.isArray(json?.jobs) ? json.jobs : [];
      if (expected === null && Number.isFinite(json?.count)) expected = json.count;
      if (!rows.length) break;

      let fresh = 0;
      for (const row of rows) {
        const job = parseCareersHomeRow(row, entry.name);
        if (!job || seen.has(job.url)) continue;
        seen.add(job.url);
        out.push(job);
        fresh++;
      }
      // A page that repeats what we already have means pagination is not
      // advancing — stop rather than spin to maxPages against their server.
      if (!fresh) break;
      if (rows.length < PAGE_SIZE) break;
    }

    // Said out loud rather than silently returning a short list: "746 expected,
    // 400 captured" is a page cap to raise, and it should not look like a board
    // that shrank.
    if (expected != null && out.length < expected) {
      console.warn(
        `  ⚠  ${entry.name}: board reports ${expected} postings, captured ${out.length}`
        + (out.length >= maxPages * PAGE_SIZE ? ` — page cap reached, raise max_pages` : ''),
      );
    }
    return out;
  },
};
