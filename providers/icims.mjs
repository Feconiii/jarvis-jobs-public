// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// iCIMS provider — the ATS behind Joby Aviation and a wide band of mid-size US
// manufacturers.
//
// iCIMS puts its search behind a human-verification wall: /jobs/search returns
// a challenge page to any plain HTTP client, which is why Joby was previously
// listed as browser-assist-only.
//
// THE SITEMAP IS THE WAY IN, AND WHETHER IT IS OPEN CHANGES UNDER US (F-448).
// This file has now said both things, and each was true when it was written:
//
//   2026-09-10  every route on careers-jobyaviation.icims.com returned the
//               same 2,115-byte 405 body to a plain client — /sitemap.xml,
//               /jobs/sitemap.xml and the postings. One WAF rule, not three.
//   2026-09-17  /sitemap.xml answers 200 with 203 <loc> entries again, and
//               this provider parses 202 Joby postings from it. The store
//               agrees: 1,746 icims rows, 220 of them read.
//
// So the gate is a setting on the tenant's WAF, not a property of iCIMS, and
// it can come back. Neither state is worth hard-coding an assumption about:
// the provider reads the sitemap when it can, and says exactly what happened
// when it cannot (the 405/403 branch in fetch below, which stays).
//
// When it IS gated it is a header rule rather than an IP block. Inside his
// browser the same host serves the posting, but only as a document
// navigation: `fetch()` from a page on that exact origin is refused too, so
// the discriminator is `Sec-Fetch-Dest` — `empty` rejected, `iframe`/
// `document` served. A nicer user-agent or a cookie jar will not fix it, and
// the assisted channel (jarvis/import-descriptions.mjs) is the route.
//
// The shape the parser reads, and how it is tested:
//
//   <url>
//     <loc>https://careers-<co>.icims.com/jobs/5302/manufacturing-engineer---motors/job</loc>
//     <lastmod>2026-08-20T16:55:43-04:00</lastmod>
//   </url>
//
// What it gives up is location: the sitemap carries none, so postings land with
// an empty location and the enrichment pass fills it from the posting's
// JSON-LD. That is the honest trade — an empty location buckets as 'unknown'
// and stays visible, where guessing one could bucket a foreign role as US or
// hide a US role as foreign.
//
// Configure with the iCIMS host:
//
//   - name: Joby Aviation
//     provider: icims
//     careers_url: https://careers-jobyaviation.icims.com

const JOB_PATH = /\/jobs\/\d+\/[^/]+\/job\b/;

function sitemapFor(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!/\.icims\.com$/i.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/sitemap.xml`;
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const ACRONYM = new Map([
  ['ii', 'II'], ['iii', 'III'], ['iv', 'IV'], ['hr', 'HR'], ['it', 'IT'], ['qa', 'QA'],
  ['npi', 'NPI'], ['cnc', 'CNC'], ['ehs', 'EHS'], ['rf', 'RF'], ['ui', 'UI'], ['ux', 'UX'],
]);

/**
 * Turn the URL slug back into a title. The sitemap is the only free source of
 * one, and "manufacturing-engineer---motors" has to read as "Manufacturing
 * Engineer - Motors" for the title filters and the relevance score to work.
 *
 * Exported for unit tests.
 *
 * @param {string} slug
 */
export function titleFromSlug(slug) {
  const words = String(slug || '')
    .replace(/-{2,}/g, ' — ')      // "---" was a dash in the original title
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  return words.split(' ').map((w, i) => {
    const low = w.toLowerCase();
    if (ACRONYM.has(low)) return ACRONYM.get(low);
    if (i > 0 && SMALL.has(low)) return low;
    if (w === '—') return w;
    return low.charAt(0).toUpperCase() + low.slice(1);
  }).join(' ');
}

/**
 * Parse an iCIMS sitemap. Exported for unit tests.
 *
 * @param {string} xml
 * @param {string} companyName
 */
export function parseIcimsSitemap(xml, companyName) {
  const out = [];
  const seen = new Set();
  for (const m of String(xml || '').matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const block = m[1];
    const loc = (block.match(/<loc>([^<]+)<\/loc>/i) || [])[1];
    if (!loc || !JOB_PATH.test(loc)) continue;
    const url = loc.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    const slug = (url.match(/\/jobs\/\d+\/([^/]+)\/job/) || [])[1] || '';
    const title = titleFromSlug(decodeURIComponent(slug));
    if (!title) continue;
    /** @type {any} */
    const job = { title, url, company: companyName, location: '' };
    const mod = (block.match(/<lastmod>([^<]+)<\/lastmod>/i) || [])[1];
    const at = Date.parse(mod || '');
    if (Number.isFinite(at)) job.postedAt = at;
    out.push(job);
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'icims',

  detect(entry) {
    const url = sitemapFor(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const url = sitemapFor(entry);
    if (!url) throw new Error(`icims: ${entry.name} needs a careers_url on *.icims.com`);
    let xml;
    try {
      xml = await ctx.fetchText(url);
    } catch (err) {
      // A 405 here is not a transport hiccup and it will not clear on a retry
      // (F-448). It is iCIMS's WAF refusing anything that is not a browser
      // navigating, and the remedy is a different channel entirely — so say
      // that, rather than leaving a bare "HTTP 405" for the next person to
      // spend an hour on.
      if (err?.status === 405 || err?.status === 403) {
        const gated = new Error(
          `icims: ${entry.name} is gated (HTTP ${err.status} on ${url}). This host refuses every `
          + 'non-browser request, sitemap included, so no scan will ever read it. Harvest it through '
          + 'his browser instead — see "Boards no server can reach" in CLAUDE.md.',
        );
        gated.status = err.status;
        gated.gated = true;
        throw gated;
      }
      throw err;
    }
    return parseIcimsSitemap(xml, entry.name);
  },
};
