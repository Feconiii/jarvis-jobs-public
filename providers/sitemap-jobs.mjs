// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Sitemap-based job discovery — for careers sites whose search UI is
// JS-rendered or session-gated but which publish their postings in a public
// SEO sitemap (most Radancy, Eightfold, Phenom, and custom sites do: the
// sitemap exists precisely so search engines can index every job).
//
// Explicit configuration only (no auto-detect): a portals.yml entry sets
//   provider: sitemap-jobs
//   sitemap:  https://.../sitemap.xml     (urlset or one-level sitemapindex)
//   job_path: regex the job URL path must match (default: /\/job\b|\/jobs?\//)
//   style:    radancy | eightfold | plain  (how to read title/location from the slug)
//
// Titles/locations derived from URL slugs are approximate (lowercased,
// hyphens→spaces). jarvis/enrich.mjs upgrades them to exact title +
// description via the posting page's JSON-LD.
//
// Known styles:
//   radancy   https://jobs.x.com/job/<city>/<title-slug>/<n>/<id>
//   eightfold https://careers.x.com/careers/job/<id>-<title-and-location-slug>
//   plain     title = last path segment minus trailing job-id tokens

const MAX_URLS = 20000;

// The site tail some tenants append to the slug: a country code, an optional
// state, a town and a site number. Kept here rather than imported so this
// provider stays standalone; jarvis/fix-titles.mjs holds the identical rule for
// repairing rows captured before this existed, and its tests cover both.
// Case-INSENSITIVE, and that matters: humanize() runs an acronym pass that
// uppercases "Us" to "US" (and "It" to "IT") before this ever sees the string,
// so a case-sensitive "Us" could never match the very slugs it was written for.
// "manufacturing-engineer-3-us-ca-fremont-1003" matched from "Ca" instead and
// left the country code stranded in the title as "Manufacturing Engineer 3 US".
const SITE_TAIL = /\s+((?:Us|Cn|De|Kr|Tw|Jp|In|Il|My|Sg|Ie|Fr|It|Nl|Be|At|Ch|Es|Pt|Se|Dk|No|Fi|Pl|Cz|Hu|Ro|Tr|Mx|Br|Ca|Au|Nz|Za|Ph|Th|Vn|Id)(?:\s+[A-Za-z][A-Za-z.'-]*){1,4})(?:\s+\d{2,})+\s*$/i;

// The same tenants also emit the MIRROR shape — country last, and a ZIP where
// the site number goes: "Hazardous Waste Technician Minden Louisiana USA 71055".
// 1,213 Eaton reqs arrive that way with an EMPTY location column, so the town is
// readable nowhere else, and SITE_TAIL cannot see it because that rule keys off
// a LEADING country code.
//
// The STATE is the anchor, and the city is then taken by walking backwards from
// it. Matching "1-3 capitalised words then a state" instead does not work:
// regex alternation is leftmost-first, so on "Hazardous Waste Technician Minden
// Louisiana USA 71055" it starts at the earliest position that can satisfy the
// count and hands "Waste Technician Minden" to the location. Laziness does not
// help — it only shrinks the match once a start position is chosen.
const US_STATE_WORDS = /alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming|district\s+of\s+columbia|puerto\s+rico/.source;
const US_ZIP_TAIL = new RegExp(
  String.raw`\s+(${US_STATE_WORDS})\s+(USA|US)\s+\d{4,6}\s*$`, 'i');

// One word of city, unless the word before it is one of the handful that start
// a two-word American city — "Olean New York" must not become "York New York".
// Erring toward one word leaves a stray word in the TITLE, which is harmless;
// erring toward two takes a word OFF the title, which is not.
const CITY_PREFIX = /^(new|san|santa|st\.?|saint|grand|port|fort|ft\.?|lake|mount|mt\.?|west|east|north|south|cape|el|la|las|los|palm|big|little|round|cedar|oak|pine|red|white|green|long|des|colorado|kansas|oklahoma|salt|sioux|baton|corpus|coral|boca|winter|bowling|iowa|idaho|jefferson|university)$/i;

export function splitSiteTail(title) {
  const src = String(title || '');
  const m = SITE_TAIL.exec(src);
  if (m) {
    const head = src.slice(0, m.index).trim();
    if (head.length < 4) return null;   // a title that is only a location is not a title
    const parts = m[1].trim().split(/\s+/);
    const loc = parts.map((p, i) => (i < 2 && p.length === 2 ? p.toUpperCase() : p)).join(' ');
    return { title: head, location: loc };
  }
  const z = US_ZIP_TAIL.exec(src);
  if (z) {
    const words = src.slice(0, z.index).trim().split(/\s+/);
    const take = (words.length >= 2 && CITY_PREFIX.test(words[words.length - 2])) ? 2 : 1;
    const head = words.slice(0, words.length - take).join(' ').trim();
    if (head.length < 4) return null;
    const city = words.slice(words.length - take).join(' ');
    return { title: head, location: `${city} ${z[1]} ${z[2].toUpperCase()}` };
  }
  return null;
}

function humanize(slug) {
  let s = String(slug);
  try { s = decodeURIComponent(s); } catch { /* keep raw on malformed escapes */ }
  return s
    .replace(/\.(html?|aspx?)$/i, '')
    .replace(/[‐-―–—]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())
    // Roman numerals and the short acronyms that job titles are full of come
    // out of blind title-casing as "Ii", "Iii", "Nx", "Cnc". "Manufacturing
    // Engineer Ii E2" is how a real Applied Materials req reads in the list.
    // A lone "V" or "X" is more often a product name than a numeral, so the
    // set stops at the levels job titles actually use.
    .replace(/\b(I{1,3}|IV|VI{0,3}|IX)\b/gi, (m) => m.toUpperCase())
    .replace(/\b(cnc|npi|cad|cam|fea|gd&t|ic|rf|ai|ml|it|hr|qa|qc|ehs|sap|plc|hvac|pcb|smt|ate|mems|asic|fpga|usa|us|uk|emea|apac|r&d|nvh|bms|adas|hmi|erp|mes|sqe|dfm|dfa|spc|msa|ppap|fmea|8d|5s|oee|tpm|wip|bom|eol|sop|kpi|fep|cmp|cvd|pvd|ald|oem|esd|uv|led|dram|nand|euv)\b/gi,
      (m) => m.toUpperCase());
}

function parseByStyle(url, style) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean);

  if (style === 'radancy') {
    // /job/<city>/<title-slug>/<n>/<id>
    const i = segs.indexOf('job');
    if (i === -1 || segs.length < i + 3) return null;
    return { title: humanize(segs[i + 2]), location: humanize(segs[i + 1]) };
  }
  if (style === 'eightfold') {
    // /careers/job/<id>-<title-and-location-slug>  (location words are mixed
    // into the slug; keep them in the title — triage still buckets "United
    // States" correctly, and enrich fixes the title later)
    const last = segs[segs.length - 1] || '';
    const m = last.match(/^(\d+)-(.+)$/);
    if (!m) return null;
    return { title: humanize(m[2]), location: '' };
  }
  // plain: last meaningful segment, dropping a trailing job-id token like
  // "j00276930". A purely-numeric last segment (SuccessFactors:
  // /City-Title-ST/1390606800/) means the slug is the segment before it.
  let last = segs[segs.length - 1] || '';
  if (/^\d+$/.test(last)) last = segs[segs.length - 2] || '';
  last = last.replace(/[-_]*j?\d{5,}$/i, '');
  // …or a LEADING one: Google writes /jobs/results/<18-digit id>-<title-slug>/,
  // and every title arrived as "126170207566602950 Data Center Mechanical
  // Engineer I". Five digits or more, so "3d-printing-engineer" is untouched.
  last = last.replace(/^\d{5,}[-_]+/, '');
  if (!last) return null;
  return { title: humanize(last), location: '' };
}

async function fetchSitemapUrls(ctx, sitemapUrl, depth = 0) {
  const xml = await ctx.fetchText(sitemapUrl, { timeoutMs: 30000 });
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
  if (/<sitemapindex/i.test(xml) && depth === 0) {
    const all = [];
    for (const child of locs.slice(0, 20)) {
      try { all.push(...await fetchSitemapUrls(ctx, child, 1)); } catch { /* skip broken child */ }
      if (all.length > MAX_URLS) break;
    }
    return all;
  }
  return locs;
}

/** @type {Provider} */
export default {
  id: 'sitemap-jobs',

  // Explicit only — a sitemap URL is deliberate configuration, not guessable.
  detect() { return null; },

  async fetch(entry, ctx) {
    const sitemap = entry.sitemap;
    if (typeof sitemap !== 'string' || !sitemap.startsWith('https://')) {
      throw new Error(`sitemap-jobs: entry "${entry.name}" needs a https sitemap: URL`);
    }
    const style = entry.style || 'plain';
    const jobPath = entry.job_path ? new RegExp(entry.job_path, 'i') : /\/job\b|\/jobs?\//i;

    const urls = (await fetchSitemapUrls(ctx, sitemap)).slice(0, MAX_URLS);
    const jobs = [];
    for (const url of urls) {
      let path;
      try { path = new URL(url).pathname; } catch { continue; }
      if (!jobPath.test(path)) continue;
      const parsed = parseByStyle(url, style);
      if (!parsed || !parsed.title) continue;
      // Several tenants end the slug with the site — "Manufacturing Engineer 3
      // Us Ca Fremont 1003", "Field Service Engineer Cn Xian 03 3829". These
      // paths give no location of their own, so that tail is the ONLY place it
      // exists: dropped, a Xian posting is classified `unknown` and sits in a
      // US-only deck. Moved into the location, it classifies correctly.
      const tail = splitSiteTail(parsed.title);
      jobs.push({
        title: tail ? tail.title : parsed.title,
        url,
        company: entry.name || '',
        location: parsed.location || (tail ? tail.location : ''),
      });
    }
    return jobs;
  },
};
