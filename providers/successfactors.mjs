// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// SAP SuccessFactors provider — the "Career Site Builder" sites that most large
// industrials run (AGCO, CNH, and the long tail of careers.<company>.com).
//
// The search pages are server-rendered HTML, but every CSB site also publishes
// a Google-for-Jobs RSS feed at /sitemap.xml — despite the name it is RSS 2.0,
// not a sitemap, which is why a <loc>-counting probe reports it as empty:
//
//   <item>
//     <title>Quality Technician (Jackson, MN, US)</title>
//     <description><![CDATA[ …full posting HTML… ]]></description>
//     <link>https://careers.agcocorp.com/job/Jackson-Quality-Technician-MN/1238657100/</link>
//     <g:location>…</g:location>  <g:job_function>…</g:job_function>
//   </item>
//
// The feed carries the FULL description, so these companies never need an
// enrichment pass — the work-authorisation triage can run on the first scan.
//
// Configure with the careers host; the feed path is derived:
//
//   - name: AGCO
//     provider: successfactors
//     careers_url: https://careers.agcocorp.com
//
// Override the path with `feed:` if a site publishes it elsewhere.

const FEED_PATH = '/sitemap.xml';

function feedUrl(entry) {
  if (typeof entry.feed === 'string' && entry.feed.startsWith('https://')) return entry.feed;
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  return `https://${parsed.hostname}${FEED_PATH}`;
}

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

/**
 * SuccessFactors puts the location inside the title: "Quality Technician
 * (Jackson, MN, US)". Splitting it matters — the location field drives the
 * US / non-US bucket, and a title carrying "(Beauvais, FR)" that reads as
 * having no location at all is how a foreign posting ends up in a US list.
 *
 * Exported for unit tests.
 *
 * @param {string} rawTitle
 * @returns {{title: string, location: string}}
 */
export function splitTitleLocation(rawTitle) {
  const s = String(rawTitle || '').trim();
  const m = s.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return { title: s, location: '' };
  const inner = m[2].trim();
  // Only treat the parenthetical as a location when it looks like one: at
  // least one comma-separated part, and not a qualifier the recruiter added
  // to the role itself ("(Remote)" is a location; "(m/f/d)" and "(2nd Shift)"
  // are not).
  if (/^(m\/f|w\/m|f\/m|h\/f)/i.test(inner)) return { title: s, location: '' };
  if (/^remote$/i.test(inner)) return { title: m[1].trim(), location: 'Remote' };
  if (!inner.includes(',')) return { title: s, location: '' };
  return { title: m[1].trim(), location: inner };
}

/** Strip HTML down to readable text — the feed ships the posting as escaped markup. */
export function htmlToPlain(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse a SuccessFactors CSB feed. Exported for unit tests.
 *
 * @param {string} xml
 * @param {string} companyName
 */
export function parseSuccessFactorsFeed(xml, companyName) {
  const items = String(xml || '').split(/<item[\s>]/i).slice(1);
  const out = [];
  for (const chunk of items) {
    const body = chunk.slice(0, chunk.search(/<\/item>/i) >= 0 ? chunk.search(/<\/item>/i) : chunk.length);
    const link = tag(body, 'link');
    if (!link.startsWith('https://')) continue;
    const { title, location } = splitTitleLocation(tag(body, 'title'));
    if (!title) continue;
    /** @type {any} */
    const job = {
      title,
      url: link,
      company: companyName,
      location: location || tag(body, 'g:location'),
    };
    const fn = tag(body, 'g:job_function');
    if (fn) job.team = fn;
    const desc = htmlToPlain(tag(body, 'description'));
    if (desc) job.description = desc;
    out.push(job);
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'successfactors',

  async fetch(entry, ctx) {
    const url = feedUrl(entry);
    if (!url) throw new Error(`successfactors: ${entry.name} needs a careers_url (https://careers.<company>.com)`);
    const xml = await ctx.fetchText(url);
    return parseSuccessFactorsFeed(xml, entry.name);
  },
};
