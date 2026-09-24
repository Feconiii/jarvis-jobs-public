// @ts-check
/**
 * seeds/vc-sites.mjs — portfolio companies as DOMAINS, not names.
 *
 * WHY A DIFFERENT UNIT (F-433). `vc-portfolios.mjs` asks a portfolio page for
 * company NAMES, then `discover-ats.mjs` guesses an ATS slug from each name.
 * That chain breaks twice: most VC sites render their portfolio client-side so
 * the names are not in the HTML at all, and even when they are, a slug guessed
 * from a name misses every board whose slug is an abbreviation.
 *
 * A portfolio page does one thing reliably, whatever framework it is built in:
 * it LINKS to each company's own website. Those outbound links are the
 * portfolio. And a domain is a better input than a name, because
 * `resolveViaCareersPage()` already turns a company's own site into a verified
 * board — that is how Commonwealth Fusion was found at `jobs.lever.co/cfsenergy`,
 * a slug no name-mangling reaches.
 *
 * So this extracts hostnames and lets the existing machinery do the rest.
 * Nothing here decides a company exists; the board still has to answer.
 *
 * THREE WAYS IN, in order of how good the data is. A firm is read the best way
 * it allows, and the later routes exist because the earlier ones came back
 * empty on exactly the books worth having.
 *
 *   1. Its CMS or its own sitemap (`VC_CMS`) — the real company NAME alongside
 *      the URL. Eclipse 53 via Sanity, Founders Fund 64 via WP REST, DCVC 295,
 *      The Engine 128 and Lowercarbon 101 via their sitemaps.
 *   2. Outbound links on the page (`VC_SITES`) — 8VC 169, Seraphim 107,
 *      Construct 18.
 *   3. The script bundle, when the page renders client-side and carries no
 *      links at all — Root Ventures 70, compiled into `app.bundle.js`.
 *
 * DCVC was twice written off as "needs a browser" before its robots.txt turned
 * out to name a sitemap with a `companies` section. A source that yields
 * nothing is reported as BROKEN, never as an empty portfolio (F-417) — and
 * "broken" is worth going back to.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 25_000;

/**
 * Hosts that appear on a portfolio page and are not portfolio companies: the
 * firm's own tooling, socials, CDNs, analytics, press outlets it links to, and
 * the boilerplate every CMS emits.
 */
const NOISE_RE = new RegExp([
  'twitter', 'x\\.com', 'linkedin', 'facebook', 'instagram', 'youtube', 'vimeo',
  'github', 'medium', 'substack', 'crunchbase', 'pitchbook', 'angel\\.co',
  'google', 'gstatic', 'googleapis', 'googletagmanager', 'doubleclick',
  'cloudflare', 'cloudfront', 'akamai', 'typekit', 'fontawesome', 'fonts\\.',
  'wp\\.com', 'w\\.org', 'gmpg\\.org', 'schema\\.org', 'gravatar', 'wixstatic',
  'squarespace', 'webflow', 'vercel\\.app', 'netlify\\.app', 'hubspot',
  'mailchimp', 'eventbrite', 'apple\\.com', 'spotify', 'bloomberg',
  'businessinsider', 'barrons', 'forbes', 'techcrunch', 'wsj', 'nytimes',
  'reuters', 'cnbc', 'axios', 'wired', 'theverge', 'altareturn',
  // Link shorteners and package/registry hosts turn up inside JS bundles.
  'bit\\.ly', 'ghcr\\.io', 'npmjs', 'unpkg', 'jsdelivr', 'sentry',
].join('|'), 'i');

/**
 * First labels that mark a host as a company's infrastructure rather than the
 * company. `docs.daily.co` and `app.hash.ai` are the same company as
 * `daily.co` and `hash.ai`, and counting them separately would probe the same
 * employer three times under three names.
 */
const INFRA_LABEL = new Set([
  'docs', 'app', 'api', 'cdn', 'static', 'assets', 'blog', 'help', 'support',
  'status', 'mail', 'login', 'auth', 'dashboard', 'portal', 'admin', 'dev',
]);

/**
 * Portfolio pages worth reading. Hardware, deeptech, space and industrial
 * firms — the ones whose companies build physical things.
 */
export const VC_SITES = {
  eightvc: { url: 'https://www.8vc.com/companies', label: '8VC' },
  seraphim: { url: 'https://seraphim.vc/portfolio', label: 'Seraphim Space' },
  construct: { url: 'https://www.constructcap.com', label: 'Construct Capital' },
  lux: { url: 'https://www.luxcapital.com/companies', label: 'Lux Capital' },
  eclipse: { url: 'https://eclipse.vc/portfolio', label: 'Eclipse Ventures' },
  foundersfund: { url: 'https://foundersfund.com/portfolio/', label: 'Founders Fund' },
  dcvc: { url: 'https://www.dcvc.com/companies/', label: 'DCVC' },
  // Root Ventures renders its portfolio into a terminal emulator (xterm.js),
  // so the page carries no company links at all — but the list is compiled
  // into its own script bundle, which is a public asset like any other. When a
  // page yields nothing, `asset` is tried before giving up.
  root: { url: 'https://root.vc', label: 'Root Ventures', asset: 'https://root.vc/js/app.bundle.js' },
  // Hardware-weighted books that serve their portfolio as plain links.
  playground: { url: 'https://playground.global/portfolio', label: 'Playground Global' },
  primemovers: { url: 'https://www.primemoverslab.com/portfolio', label: 'Prime Movers Lab' },
  khosla: { url: 'https://www.khoslaventures.com/portfolio', label: 'Khosla Ventures' },
  congruent: { url: 'https://congruentvc.com/portfolio/', label: 'Congruent Ventures' },
  atone: { url: 'https://www.atoneventures.com/portfolio', label: 'At One Ventures' },
  // DELIBERATELY ABSENT: Bessemer (494 links), Union Square (213) and MaC (174)
  // all read fine — they are simply software books. 8VC's 169 domains produced
  // 28 companies with a single relevant row between them, and those three are
  // further from hardware again. Breadth is only worth buying where it pays,
  // and the scan cost of ~880 mostly-SaaS boards is not free. Add them if the
  // search ever widens.
};

/**
 * Every outbound company hostname on a portfolio page.
 *
 * Pure and synchronous, so the tests feed it fixtures instead of the network.
 *
 * @param {string} html   The page.
 * @param {string} selfHost  The firm's own hostname, so its internal links drop out.
 * @returns {string[]} hostnames, de-duplicated, `www.` stripped
 */
export function companyHostsIn(html, selfHost = '') {
  if (typeof html !== 'string' || !html) return [];
  const self = String(selfHost || '').toLowerCase().replace(/^www\./, '');
  const out = new Set();
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"'\s]+)["']/gi)) {
    let host;
    try { host = new URL(m[1]).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
    if (!host || host.includes('..')) continue;
    if (self && (host === self || host.endsWith('.' + self))) continue;
    if (NOISE_RE.test(host)) continue;
    // A deep subdomain is nearly always infrastructure rather than a company
    // homepage (cdn.assets.example.com); a company links to its apex.
    const labels = host.split('.');
    if (labels.length > 3) continue;
    // `docs.daily.co` is the same employer as `daily.co`. Fold it in rather
    // than probing one company three times under three names.
    if (labels.length === 3 && INFRA_LABEL.has(labels[0])) {
      out.add(labels.slice(1).join('.'));
      continue;
    }
    out.add(host);
  }
  return [...out];
}

/**
 * Fetch one firm's portfolio and return its company domains.
 * @param {string} key  A key of VC_SITES.
 */
export async function fetchVcSiteHosts(key) {
  const src = VC_SITES[key];
  if (!src) throw new Error(`vc-sites: unknown firm "${key}" (have: ${Object.keys(VC_SITES).join(', ')})`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let html;
  try {
    const res = await fetch(src.url, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const self = new URL(src.url).hostname;
  const fromPage = companyHostsIn(html, self);
  if (fromPage.length || !src.asset) return fromPage;

  // The page rendered its portfolio client-side. The bundle that renders it is
  // a public asset, and the company URLs are compiled into it — bare, not in
  // href attributes, so they are matched as plain URLs.
  const res = await fetch(src.asset, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`asset HTTP ${res.status}`);
  const js = await res.text();
  return companyHostsIn(
    [...js.matchAll(/https?:\/\/[^\s"'`\\)]+/g)].map(m => `href="${m[0]}"`).join(' '),
    self,
  );
}

// ── firms that publish their portfolio through a CMS ─────────────────
//
// Link-scraping is the fallback, not the goal. A firm whose site is backed by a
// content API hands over the REAL company name alongside the URL, and a real
// name beats one derived from a domain: "Redwood Materials", not "Redwoodmaterials".
//
// These are found by looking at what the page loads, and each is one public
// read-only endpoint — no key, no auth, nothing that is not already serving the
// firm's own visitors.

/**
 * Eclipse Ventures — Sanity. Its portfolio never appears in the HTML (the page
 * returned 723 KB and exactly one usable outbound link), but the dataset behind
 * it answers a public GROQ query with all 53 companies and their websites.
 */
async function fetchEclipse() {
  const query = encodeURIComponent('*[_type=="company"]{title,websiteURL}');
  const url = `https://5uq66tk5.apicdn.sanity.io/v2021-10-21/data/query/production?query=${query}`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json())?.result ?? [];
  return rows
    .filter(r => r?.title)
    .map(r => ({ name: String(r.title).trim(), site: String(r.websiteURL || '').trim() }));
}

/**
 * Founders Fund — WordPress, with `company` registered as a public post type.
 * The REST collection paginates, and `X-WP-Total` says how many there are.
 * Its custom fields come back empty, so this yields NAMES only — which is
 * enough: `discover-ats.mjs` resolves a name through the slug probes and the
 * guessed-homepage fallback.
 */
async function fetchFoundersFund() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://foundersfund.com/wp-json/wp/v2/company?per_page=100&page=${page}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) break;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const name = String(r?.title?.rendered || '').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
      if (name) out.push({ name, site: '' });
    }
    const total = Number(res.headers.get('x-wp-totalpages') || 0);
    if (total && page >= total) break;
  }
  return out;
}

/**
 * DCVC — via its own sitemap, which its robots.txt points at.
 *
 * Its portfolio page is fetched at runtime from something no plain GET reaches,
 * and its JS bundle carries no company URLs, so both of the routes above come
 * back empty. It was written off as "needs a browser" — wrongly. `robots.txt`
 * names `sitemaps-1-sitemap.xml`, that index has a `companies` section, and the
 * section lists **295 company pages**. Nothing here is a workaround: the file
 * exists to be read, and the same robots.txt says `Allow: /`.
 *
 * Each company page then gives up better data than any scrape of the index
 * would have — the real name in its `<title>` ("DCVC | Pacific Fusion") and the
 * company's own website as its only outbound link. That is 295 fetches, run
 * narrow and slowly, and worth it: this is the most hardware-dense book of the
 * lot (Pacific Fusion, Atom Computing, Quantum Motion, Lunar Energy, Regent).
 */
/**
 * Hosts that are a JOB BOARD rather than a company homepage. A firm's company
 * page often links the FIRM's own careers board — engine.xyz/resident-companies/ashgen
 * links `jobs.lever.co/engine` — and taking that as the company's website would
 * bind every one of its portfolio companies to the firm's own board.
 */
const ATS_HOST_RE = /(greenhouse|lever|ashbyhq|myworkdayjobs|smartrecruiters|icims|bamboohr|breezy|recruitee|workable|rippling|jobvite|taleo|eightfold)\./i;

/**
 * A firm whose portfolio is a section of its own sitemap.
 *
 * Three firms turned out to publish it this way, and the pattern is worth
 * naming once rather than writing three times: read the section, fetch each
 * company page, and take the real name from its `<title>` and the company's
 * own site from its first outbound link.
 *
 * The title carries both names, in either order — "DCVC | Pacific Fusion" but
 * "AshGen | The Engine" — so the firm's own name is removed and the longest
 * remaining segment is the company.
 */
function makeSitemapFirm({ sitemap, firm }) {
  return async ({ concurrency = 4 } = {}) => {
    const get = async (url) => {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xml' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };

    const xml = await get(sitemap);
    const pages = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    if (!pages.length) return [];

    const firmHost = (() => { try { return new URL(sitemap).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const out = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (cursor < pages.length) {
        const url = pages[cursor++];
        let html;
        try { html = await get(url); } catch { continue; }
        const title = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] || '');
        const name = title.split('|')
          .map(s => s.trim())
          .filter(s => s && s.toLowerCase() !== firm.toLowerCase() && !s.toLowerCase().includes(firm.toLowerCase()))
          .sort((a, b) => b.length - a.length)[0]
          || url.replace(/\/$/, '').split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        // THE FIRST OUTBOUND LINK IS NOT RELIABLY THE COMPANY'S. Lowercarbon's
        // page for Artyc links `frostmethane.com` — a neighbouring portfolio
        // company — before `shipartyc.com`, which is Artyc's actual site. Taking
        // the first would have bound one company's name to another's board, and
        // bound it AUTHORITATIVELY, since a site the firm published is trusted
        // without the board having to say the name back.
        //
        // So the link has to look like the company: its hostname must contain
        // the company's name, or the name must contain the hostname's label
        // (Artyc → shipartyc.com, AshGen → ash-gen.com, Gridware → gridware.io).
        // When nothing matches, the answer is NO SITE rather than a guess —
        // an empty site falls back to a `<name>.com` guess that is explicitly
        // marked non-authoritative, which is the safe failure.
        const flatName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const candidates = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
          .map(m => m[1])
          .filter((h) => {
            try {
              const host = new URL(h).hostname.replace(/^www\./, '');
              return !NOISE_RE.test(host) && !ATS_HOST_RE.test(host)
                && host !== firmHost && !host.endsWith('.' + firmHost);
            } catch { return false; }
          });
        const site = candidates.find((h) => {
          try {
            const label = new URL(h).hostname.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
            return label.length >= 3 && flatName.length >= 3
              && (label.includes(flatName) || flatName.includes(label));
          } catch { return false; }
        }) || '';
        if (name) out.push({ name, site });
      }
    }));
    return out;
  };
}

/** Firms whose portfolio comes back as {name, site} rather than bare domains. */
export const VC_CMS = {
  eclipse: { fetch: fetchEclipse, label: 'Eclipse Ventures (Sanity)' },
  foundersfund: { fetch: fetchFoundersFund, label: 'Founders Fund (WP REST)' },
  dcvc: {
    fetch: makeSitemapFirm({
      sitemap: 'https://www.dcvc.com/sitemaps-1-section-companies-1-sitemap.xml',
      firm: 'DCVC',
    }),
    label: 'DCVC (sitemap)',
  },
  // The Engine is MIT's tough-tech fund: the densest hardware book of the lot,
  // and it uses the same Craft-CMS sitemap shape DCVC does.
  engine: {
    fetch: makeSitemapFirm({
      sitemap: 'https://engine.xyz/sitemaps-1-section-residentCompanies-1-sitemap.xml',
      firm: 'The Engine',
    }),
    label: 'The Engine (sitemap)',
  },
  lowercarbon: {
    fetch: makeSitemapFirm({
      sitemap: 'https://lowercarbon.com/company-sitemap.xml',
      firm: 'Lowercarbon Capital',
    }),
    label: 'Lowercarbon Capital (sitemap)',
  },
};

/** A readable company name from a hostname, for the portals.yml entry. */
export function nameFromHost(host) {
  const label = String(host || '').replace(/^www\./, '').split('.')[0] || '';
  return label
    .split(/[-_]/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default { VC_SITES, companyHostsIn, fetchVcSiteHosts, nameFromHost };
