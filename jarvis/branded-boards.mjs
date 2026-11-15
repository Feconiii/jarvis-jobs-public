// jarvis/branded-boards.mjs — boards that live on a company's OWN domain.
//
// WHY THIS EXISTS (2026-10-03). The resolver could only recognise a board by a
// shared host in a link: greenhouse.io, lever.co, myworkdayjobs.com. Large
// employers mostly do not work that way. Measured on 120 companies a LinkedIn
// pass named and the resolver missed: 10 run SuccessFactors career sites, 6
// Oracle Recruiting Cloud, 3 Phenom, 4 the iCIMS/Jibe "careers-home" app — all
// platforms the SCANNER already reads (providers/), on hosts like
// careers.garmin.com that no slug guess reaches. Garmin was missed with its
// own `careers.garmin.com/api/jobs` answering, and `probeCareersHome` written
// for exactly that sitting in discover-ats.mjs with no caller.
//
// So: from the pages the resolver already fetched, find the company's careers
// HOSTS (careers.<domain>, jobs.<domain>, and whatever its pages link), and ask
// each one the questions the scanner's own providers ask. A board counts only
// when the provider that will scan it returns postings — the same code, so a
// board found here is a board the scan can read.
//
// What it cannot read it NAMES (platformOf): UKG, ADP, Paycom, Dayforce,
// Avature, Taleo… The coverage ledger records that, so the gap is a count per
// platform rather than an anonymous "no board".

import successfactors from '../providers/successfactors.mjs';
import phenom from '../providers/phenom.mjs';
import ukg, { ukgBoardsIn } from '../providers/ukg.mjs';
import adp, { adpCentersIn, careerCenterUrl } from '../providers/adp.mjs';
import paylocity, { paylocityBoardsIn } from '../providers/paylocity.mjs';
import { makeHttpCtx } from '../providers/_http.mjs';

const CAREER_SUB = /^(careers?|jobs?|work|join|talent|opportunities|apply|recruiting|hiring|employment)\./i;
// A first label that is the company's own spelling of it: corningjobs.corning.com,
// uscareers-lennox (F-713 — Corning's 1,103 postings sat behind one).
const CAREER_LABEL = /^[a-z0-9-]*(careers?|jobs)[a-z0-9-]*\./i;

/** The registrable part of a host, roughly: the last two labels (three for co.uk-style). */
export function baseDomain(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  return (sld.length <= 3 && parts[parts.length - 1].length === 2 ? parts.slice(-3) : parts.slice(-2)).join('.');
}

/**
 * Careers origins worth asking, for a company whose pages we fetched.
 * Only hosts on the company's own domain: a link to someone else's site is not
 * the company's board.
 */
export function careerOrigins(pages, siteOrigin) {
  let base = '';
  try { base = baseDomain(new URL(siteOrigin).hostname); } catch { return []; }
  if (!base) return [];
  const out = new Set([`https://careers.${base}`, `https://jobs.${base}`]);
  for (const html of pages) {
    for (const m of String(html || '').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (!host.endsWith(`.${base}`) || !(CAREER_SUB.test(host) || CAREER_LABEL.test(host))) continue;
      out.add(`https://${host}`);
    }
  }
  return [...out].slice(0, 6);
}

/** Oracle Recruiting Cloud sites linked from a page. */
export function orcLinksIn(html) {
  const out = [];
  const seen = new Set();
  const re = /https:\/\/([a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[A-Za-z]{2})?\/sites\/([A-Za-z0-9_]+)/g;
  for (const m of String(html || '').matchAll(re)) {
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: `https://${m[1]}`, site: m[2] });
  }
  return out;
}

/** PageUp career sites linked from a page. */
export function pageUpLinksIn(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/careers\.pageuppeople\.com\/(\d+)\/([a-z]+)\//gi)) {
    const key = `${m[1]}/${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ instance: m[1], site: m[2].toLowerCase() });
  }
  return out;
}

/**
 * Platforms nothing here can read yet, by their fingerprints. First match wins,
 * most specific first. Used only to NAME a miss.
 */
const UNREADABLE = [
  ['ukg', /recruiting\d*\.ultipro\.com|\.ukg\.net|ultipro/i],
  ['adp-myjobs', /myjobs\.adp\.com/i],
  ['adp', /workforcenow\.adp\.com|recruiting\.adp\.com/i],
  ['paycom', /paycomonline\.net/i],
  ['dayforce', /dayforcehcm\.com/i],
  ['paylocity', /recruiting\.paylocity\.com/i],
  ['paycor', /recruitingbypaycor|paycor\.com\/|newton\.newtonsoftware/i],
  ['taleo', /taleo\.net/i],
  ['brassring', /brassring\.com/i],
  ['avature', /avature\.net/i],
  ['eightfold', /eightfold\.ai/i],
  ['jazzhr', /applytojob\.com/i],
  ['clearcompany', /clearcompany\.com/i],
  ['hirebridge', /hirebridge\.com/i],
  ['radancy', /tmpwebeng|talentbrew|radancy/i],
  ['cornerstone', /[a-z0-9-]+\.csod\.com/i],
  ['successfactors-legacy', /career\d*\.successfactors\.(?:com|eu)\/career/i],
  // A careers site on its own .jobs domain (www.milwaukeetool.jobs) — usually
  // DirectEmployers or Radancy behind it.
  ['dotjobs', /https?:\/\/(?:www\.)?[a-z0-9-]+\.jobs(?:[/"'\s]|$)/i],
  // Not a platform: the page refused a machine (Akamai, Cloudflare). Named so
  // the ledger does not count it as "has no careers page".
  ['bot-blocked', /errors\.edgesuite\.net|cf-chl-|challenge-platform|Attention Required! \| Cloudflare/i],
];
export function platformOf(text) {
  for (const [k, re] of UNREADABLE) if (re.test(String(text || ''))) return k;
  return '';
}

// A board no provider in providers/ reads (UKG, ADP Workforce Now and Paylocity
// are read since F-705/F-720), by the HOST of a URL. A tenant host, never the
// vendor's own site: a "powered by" footer links www.<vendor>.com. Radancy and
// the paycor.com marketing site are left out (they name a vendor, not a board).
const SECOND_BOARD = [
  ['adp-myjobs', /^myjobs\.adp\.com$/],
  // Paycom's boards are on www.paycomonline.net itself: its /ats/ path decides.
  ['paycom', /(^|\.)paycomonline\.net$/, /\/ats\//i],
  ['dayforce', /\.dayforcehcm\.com$/],
  ['paycor', /(^|\.)recruitingbypaycor\.com$|\.newtonsoftware\.com$/],
  ['taleo', /\.taleo\.net$/],
  ['brassring', /\.brassring\.com$/],
  ['avature', /\.avature\.net$/],
  ['eightfold', /\.eightfold\.ai$/],
  ['jazzhr', /\.applytojob\.com$/],
  ['clearcompany', /\.clearcompany\.com$/],
  ['hirebridge', /\.hirebridge\.com$/],
  ['cornerstone', /\.csod\.com$/],
  ['successfactors-legacy', /^career\d*\.successfactors\.(?:com|eu)$/],
];
const NOT_A_TENANT = /^(?:www|info|blog|help|support|status|docs)\./;

/**
 * A SECOND BOARD NOTHING HERE READS, linked from a careers page (2026-11-07).
 * Bastian Solutions' page links the Toyota Automated Logistics Workday board it
 * shares (none of its Greenfield postings are on it) AND an ADP MyJobs board.
 * The readable one made it "tracked", so the LinkedIn sweep never looked.
 *
 * Only what the page LINKS to or embeds as a frame: an <a href> or an
 * <iframe src>. A script, a stylesheet, or a vendor's name in the text is not
 * a board (First Mate's review: a "powered by Paycor" footer script would have
 * made a shared-board employer partial).
 */
export function unreadableBoardIn(text) {
  const s = String(text || '');
  const urls = [...s.matchAll(/<(?:a|iframe)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const u of urls) {
    let url;
    try { url = new URL(u.replace(/&amp;/g, '&'), 'https://example.invalid/'); } catch { continue; }
    const host = url.hostname.toLowerCase();
    for (const [k, re, path] of SECOND_BOARD) {
      if (!re.test(host)) continue;
      if (path ? path.test(url.pathname) : !NOT_A_TENANT.test(host)) return k;
    }
  }
  return '';
}

const ctx = makeHttpCtx();

/** The iCIMS/Jibe careers-home app: `<origin>/api/jobs`. */
async function careersHome(origin, name) {
  try {
    const j = await ctx.fetchJson(`${origin}/api/jobs?page=1&limit=1`, { timeoutMs: 12000 });
    const first = j?.jobs?.[0]?.data;
    if (!Number.isFinite(j?.count) || j.count < 1 || !first?.title || !(first.req_id || first.slug)) return null;
    return { entry: { name, careers_url: origin, provider: 'icims-careers' }, provider: 'icims-careers', count: j.count };
  } catch { return null; }
}

/** A Phenom career site: the provider's own search, one page. */
async function phenomSite(origin, name) {
  try {
    const jobs = await phenom.fetch({ name, careers_url: origin, provider: 'phenom', max_pages: 1 }, ctx);
    if (!jobs.length) return null;
    return { entry: { name, careers_url: origin, provider: 'phenom' }, provider: 'phenom', count: jobs.length, countIsPage: true };
  } catch { return null; }
}

/**
 * One careers origin, asked as every branded app we read: careers-home,
 * Phenom, SuccessFactors. For an origin the caller found or guessed itself.
 */
export async function brandedOrigin(origin, name) {
  return (await careersHome(origin, name)) || (await phenomSite(origin, name)) || (await successFactorsSite(origin, name));
}

/** A SuccessFactors career site (the provider reads its job feed). */
async function successFactorsSite(origin, name) {
  try {
    const jobs = await successfactors.fetch({ name, careers_url: origin, provider: 'successfactors' }, ctx);
    if (!jobs.length) return null;
    return { entry: { name, careers_url: origin, provider: 'successfactors' }, provider: 'successfactors', count: jobs.length };
  } catch { return null; }
}

/** An Oracle Recruiting Cloud site: one request, its own total. */
async function orcSite({ host, site }, name, careersUrl) {
  try {
    const url = `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site},limit=1`;
    const j = await ctx.fetchJson(url, { timeoutMs: 20000 });
    const item = j?.items?.[0];
    const total = Number(item?.TotalJobsCount ?? (item?.requisitionList || []).length);
    if (!total) return null;
    return {
      entry: { name, careers_url: careersUrl || `${host}/hcmUI/CandidateExperience/en/sites/${site}`, provider: 'oracle-orc', orc_host: host, orc_site: site },
      provider: 'oracle-orc', count: total,
    };
  } catch { return null; }
}

/** A UKG Pro Recruiting board linked from the company's page (F-705). */
async function ukgBoard(base, name) {
  try {
    const jobs = await ukg.fetch({ name, careers_url: base, max_pages: 1 }, ctx);
    if (!jobs.length) return null;
    return { entry: { name, careers_url: `${base}/`, provider: 'ukg' }, provider: 'ukg', count: jobs.length };
  } catch { return null; }
}

/**
 * ADP Workforce Now career centers linked from the company's page (F-705).
 * One employer can run several (Ultium Cells: three); all of one cid become a
 * single entry, the rest of the ccIds listed in `adp_ccids`.
 */
async function adpCenters(centers, name) {
  const byCid = new Map();
  for (const c of centers) {
    if (!byCid.has(c.cid)) byCid.set(c.cid, []);
    byCid.get(c.cid).push(c.ccId);
  }
  for (const [cid, ccIds] of byCid) {
    const [first, ...rest] = ccIds;
    const entry = { name, careers_url: careerCenterUrl({ cid, ccId: first }), provider: 'adp' };
    if (rest.length) entry.adp_ccids = rest.join(',');
    try {
      const jobs = await adp.fetch({ ...entry, max_pages: 2 }, ctx);
      if (jobs.length) return { entry, provider: 'adp', count: jobs.length };
    } catch { /* next cid */ }
  }
  return null;
}

/** A PageUp site: its RSS feed. */
async function pageUpSite({ instance, site }, name) {
  try {
    const xml = await ctx.fetchText(`https://careers.pageuppeople.com/${instance}/${site}/en-us/rss`, { timeoutMs: 20000 });
    const count = (String(xml).match(/<item[\s>]/g) || []).length;
    if (!count) return null;
    return {
      entry: { name, careers_url: `https://careers.pageuppeople.com/${instance}/${site}/en-us`, provider: 'pageup', pageup_instance: instance, pageup_site: site },
      provider: 'pageup', count,
    };
  } catch { return null; }
}

// ── pages that only exist after their script runs ──────────────────
//
// Measured on the 120-company sample: after every probe above, 62 were still
// misses with no platform named — careers pages whose job links are written by
// script (Garmin's was one until careers.<domain> was asked directly). Rendered
// in a browser, the page asks its ATS for jobs, and that REQUEST names the
// board even when no link ever does. So the text handed back is the rendered
// DOM plus every URL the page requested; the resolver's own detectors read it.
//
// One headless Chromium for the whole run, opened on first use. His machine
// often runs with under a gigabyte free, so: one page at a time, images,
// fonts and media blocked, 20 seconds a page.

let browserP = null;
let renderQueue = Promise.resolve();

async function browser() {
  if (!browserP) {
    browserP = import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
    process.once('exit', () => { browserP?.then((b) => b.close()).catch(() => {}); });
  }
  return browserP;
}

/** Close the shared browser (the resolver calls this at the end of a run). */
export async function closeRenderer() {
  if (!browserP) return;
  const b = await browserP.catch(() => null);
  browserP = null;
  await b?.close().catch(() => {});
}

/**
 * Render a careers page and return its DOM plus every URL it requested.
 * Serialised: only one page renders at a time, whatever the caller's concurrency.
 */
export function renderCareers(url, { timeoutMs = 20000 } = {}) {
  const run = renderQueue.then(async () => {
    let page = null;
    const requested = [];
    try {
      const b = await browser();
      page = await b.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        return ['image', 'font', 'media'].includes(t) ? route.abort() : route.continue();
      });
      page.on('request', (r) => { if (requested.length < 400) requested.push(r.url()); });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const frames = page.frames().map((f) => f.url());
      const html = await page.content().catch(() => '');
      return `${html}\n${requested.join('\n')}\n${frames.join('\n')}\n${page.url()}`;
    } catch {
      return '';
    } finally {
      await page?.close().catch(() => {});
    }
  });
  renderQueue = run.catch(() => '');
  return run;
}

/**
 * Look for a board on the company's own domain, given the pages already
 * fetched from its site. Returns a resolver hit, or `{ platform }` naming an
 * unreadable platform it saw, or null.
 *
 * @param {string[]} pages     HTML of the pages fetched from the company site
 * @param {string} siteOrigin  the company site's origin
 * @param {string} name
 * @param {{ fetchPage?: (url: string) => Promise<string> }} [opts]
 */
export async function resolveBranded(pages, siteOrigin, name, { fetchPage } = {}) {
  const seen = [...pages];
  for (const o of orcLinksIn(seen.join('\n'))) {
    const hit = await orcSite(o, name);
    if (hit) return hit;
  }
  for (const b of ukgBoardsIn(seen.join('\n'))) {
    const hit = await ukgBoard(b, name);
    if (hit) return hit;
  }
  for (const b of paylocityBoardsIn(seen.join('\n'))) {
    try {
      const jobs = await paylocity.fetch({ name, careers_url: b }, ctx);
      if (jobs.length) return { entry: { name, careers_url: b, provider: 'paylocity' }, provider: 'paylocity', count: jobs.length };
    } catch { /* next board */ }
  }
  const centers = adpCentersIn(seen.join('\n'));
  if (centers.length) {
    const hit = await adpCenters(centers, name);
    if (hit) return hit;
  }
  for (const p of pageUpLinksIn(seen.join('\n'))) {
    const hit = await pageUpSite(p, name);
    if (hit) return hit;
  }
  for (const origin of careerOrigins(seen, siteOrigin)) {
    const hit = (await careersHome(origin, name)) || (await phenomSite(origin, name)) || (await successFactorsSite(origin, name));
    if (hit) return hit;
    // The careers host's own front page often links the real board (an ORC
    // site behind careers.ti.com, a Workday tenant behind jobs.x.com).
    if (fetchPage) {
      const html = await fetchPage(`${origin}/`).catch(() => '');
      if (html) {
        seen.push(html);
        for (const o of orcLinksIn(html)) {
          const h = await orcSite(o, name, origin);
          if (h) return h;
        }
      }
    }
  }
  const platform = platformOf(seen.join('\n'));
  return platform ? { platform } : null;
}
