// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Jobvite provider — the public career site, read as server-rendered HTML.
//
// Every Jobvite employer has a career site at `https://jobs.jobvite.com/<slug>`
// (Mini-Circuits: jobs.jobvite.com/mini-circuits). There is no public JSON
// feed: the job list is plain HTML, and each posting page carries the whole
// posting twice — a schema.org JobPosting block (which enrich.mjs reads the way
// it reads Breezy and Paylocity pages) and the visible body in
// `div.jv-job-detail-description` (`jobvitePostingFromHtml`, the fallback).
//
// THEMES DIFFER PER EMPLOYER (2026-11-04, both saved under
// jarvis/fixtures/jobvite/):
//   · Egnyte (classic theme): /egnyte/jobs is the whole list, one
//     `<table class="jv-job-list">` per department, a `<tr>` per posting with
//     `td.jv-job-list-name > a` and `td.jv-job-list-location`.
//   · Mini-Circuits (custom theme): /mini-circuits/jobs is a landing page with
//     four "featured" jobs only; the list is at /jobs/positions, a `<li>` per
//     posting whose `<a>` wraps `div.jv-job-list-name`, `div.jv-job-type`
//     ("Engineering | Full-Time") and `div.jv-job-list-location`.
// So the reader works by ROW (an `<li>` or `<tr>` holding a jv-job-list-name),
// never by one theme's nesting, and follows a /jobs/positions link when the
// landing page lists nothing itself. Featured-job cards are never read as the
// list: they are a subset, and reading them would make a 58-posting board look
// like a 4-posting one.
//
// A slug Jobvite does not know 302s to search.jobvite.com/?invalid=1; with
// `redirect: 'error'` that is a thrown error, so a guessed slug never reads as
// an empty board. The host is pinned to jobs.jobvite.com (careers.jobvite.com
// names the same slug and is read from jobs.jobvite.com), HTTPS only.
//
// The client says what it is: the same honest User-Agent enrich.mjs gives
// iCIMS, which answered 200 to it (curl, both employers, 2026-11-04).

export const JOBVITE_UA = 'Jarvis-Jobs/1.0 (personal job search; one posting at a time)';
const HOST_RE = /^(?:jobs|careers)\.jobvite\.com$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/i;
// Jobvite's own paths under the host, never an employer.
export const NOT_A_SLUG = new Set(['jobs', 'job', 'search', 'api', 'www', 'careers', 'static', 'cws']);
const MAX_PAGES = 20;

/**
 * The employer slug of a Jobvite career-site URL, or ''.
 * @param {string} raw
 */
export function jobviteSlug(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (!HOST_RE.test(u.hostname)) return '';
  const first = u.pathname.split('/').filter(Boolean)[0] || '';
  if (!SLUG_RE.test(first) || NOT_A_SLUG.has(first.toLowerCase())) return '';
  return first.toLowerCase();
}

/** @param {import('./_types.js').PortalEntry} entry */
function slugOf(entry) {
  return jobviteSlug(entry?.api || '') || jobviteSlug(entry?.careers_url || '');
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Jobvite';
}

function fromCodePoint(cp) {
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

/** Tags out, entities decoded, whitespace collapsed. */
function plain(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The inner HTML of the first element whose class list holds `cls`, counting
 * its own tag's opens and closes so nested markup comes along whole.
 * @param {string} html
 * @param {string} cls
 */
function innerOfClass(html, cls) {
  const src = String(html || '');
  const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*(?<![\\w-])${cls}(?![\\w-])[^"']*["'][^>]*>`, 'i').exec(src);
  if (!open) return '';
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1, m;
  while ((m = re.exec(src))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return src.slice(open.index + open[0].length, m.index);
  }
  return src.slice(open.index + open[0].length);
}

/**
 * Parse one page of a Jobvite career-site job list. Exported for tests.
 *
 * @param {string} html
 * @param {string} slug     The employer slug; only links to its own postings count.
 * @param {string} [company]
 * @returns {Array<{title: string, url: string, company: string, location: string, team?: string}>}
 */
export function parseJobviteList(html, slug, company = 'Jobvite') {
  if (typeof html !== 'string' || !html || !slug) return [];
  const label = typeof company === 'string' && company.trim() ? company.trim() : 'Jobvite';
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hrefRe = new RegExp(`href\\s*=\\s*["'](?:https?://(?:jobs|careers)\\.jobvite\\.com)?/${esc}/job/([A-Za-z0-9]{4,20})(?:[/?#][^"']*)?["']`, 'i');
  const jobs = [];
  const seen = new Set();
  // A row is an <li> or <tr> that holds a jv-job-list-name. Neither theme
  // nests one row in another, so a lazy match to the row's own close is whole.
  const rowRe = /<(li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[2];
    if (!/\bjv-job-list-name\b/.test(row)) continue;
    const href = hrefRe.exec(row);
    if (!href) continue;
    const url = `https://jobs.jobvite.com/${slug}/job/${href[1]}`;
    if (seen.has(url)) continue;
    const title = plain(innerOfClass(row, 'jv-job-list-name'));
    if (!title) continue;
    seen.add(url);
    const job = { title, company: label, location: plain(innerOfClass(row, 'jv-job-list-location')).replace(/\s+,/g, ','), url };
    // "Engineering | Full-Time": the department is the part before the bar.
    const type = plain(innerOfClass(row, 'jv-job-type'));
    const team = type.split('|')[0].trim();
    if (team) job.team = team;
    jobs.push(job);
  }
  return jobs;
}

/**
 * The next list page, when the board paginates (`a.jv-pagination-next`), as an
 * absolute jobs.jobvite.com URL under the same slug, or ''.
 * @param {string} html
 * @param {string} slug
 */
export function nextPageUrl(html, slug) {
  const tag = /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bjv-pagination-next\b[^"']*["'][^>]*>/i.exec(String(html || ''))?.[0];
  const href = tag && /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  if (!href || href === '#') return '';
  let u;
  try { u = new URL(href.replace(/&amp;/g, '&'), `https://jobs.jobvite.com/${slug}/jobs`); } catch { return ''; }
  return HOST_RE.test(u.hostname) && jobviteSlug(u.href) === slug ? `https://jobs.jobvite.com${u.pathname}${u.search}` : '';
}

/** Does the landing page point at a separate full list (/<slug>/jobs/positions)? */
function positionsLink(html, slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`href\\s*=\\s*["'](?:https?://jobs\\.jobvite\\.com)?/${esc}/jobs/positions["'?]`, 'i').test(String(html || ''))
    ? `https://jobs.jobvite.com/${slug}/jobs/positions` : '';
}

/**
 * The posting a Jobvite posting page shows, from its visible markup — the
 * fallback for a page whose schema.org block is missing. Shaped like the
 * JobPosting enrich.mjs reads, or null when the page has no body.
 * @param {string} html
 * @returns {{ '@type': 'JobPosting', title: string, description: string } | null}
 */
export function jobvitePostingFromHtml(html) {
  const src = String(html || '');
  if (!/\bjv-job-detail-description\b/.test(src)) return null;
  const description = innerOfClass(src, 'jv-job-detail-description').trim();
  if (plain(description).length < 40) return null;
  return { '@type': 'JobPosting', title: plain(innerOfClass(src, 'jv-header')), description };
}

/** @type {Provider} */
export default {
  id: 'jobvite',

  detect(entry) {
    const slug = slugOf(entry);
    return slug ? { url: `https://jobs.jobvite.com/${slug}/jobs` } : null;
  },

  async fetch(entry, ctx) {
    const slug = slugOf(entry);
    if (!slug) throw new Error(`jobvite: cannot derive a jobs.jobvite.com/<slug> board for ${fallbackCompany(entry)}`);
    const company = fallbackCompany(entry);
    const get = (url) => ctx.fetchText(url, { redirect: 'error', headers: { 'user-agent': JOBVITE_UA, accept: 'text/html' } });

    let url = `https://jobs.jobvite.com/${slug}/jobs`;
    let html = await get(url);
    if (!parseJobviteList(html, slug, company).length) {
      const positions = positionsLink(html, slug);
      if (positions) { url = positions; html = await get(url); }
    }
    const jobs = [];
    const seen = new Set();
    const visited = new Set([url]);
    for (let page = 1; ; page++) {
      for (const j of parseJobviteList(html, slug, company)) {
        if (!seen.has(j.url)) { seen.add(j.url); jobs.push(j); }
      }
      const next = nextPageUrl(html, slug);
      if (!next || visited.has(next) || page >= MAX_PAGES) break;
      visited.add(next);
      html = await get(next);
    }
    return jobs;
  },
};
