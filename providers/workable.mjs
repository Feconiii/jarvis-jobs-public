// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workable provider — hits the public markdown feed at /<slug>/jobs.md.
// Workable's documented JSON API requires an auth token; the markdown feed
// is the only no-auth public surface. Auto-detects from careers_url pattern
// `https://apply.workable.com/<slug>`. A tracked_companies entry can also
// set `provider: workable` explicitly to bypass detection.

const ALLOWED_WORKABLE_HOSTS = new Set(['apply.workable.com']);

function assertWorkableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`workable: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`workable: URL must use HTTPS: ${url}`);
  if (!ALLOWED_WORKABLE_HOSTS.has(parsed.hostname)) {
    throw new Error(`workable: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_WORKABLE_HOSTS].join(', ')}`);
  }
  return url;
}

function resolveFeedUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'apply.workable.com') return null;
  const slug = parsed.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://apply.workable.com/${slug}/jobs.md`;
}

/** @type {Provider} */
export default {
  id: 'workable',

  detect(entry) {
    const feedUrl = resolveFeedUrl(entry);
    return feedUrl ? { url: feedUrl } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = resolveFeedUrl(entry);
    if (!feedUrl) throw new Error(`workable: cannot derive feed URL for ${entry.name}`);
    assertWorkableUrl(feedUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertWorkableUrl above it guarantees the final hostname stays in the allowlist.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    const departments = departmentsFromSearchGuide(text);
    if (!departments.length) return parseWorkableMarkdown(text, entry.name);
    // A LARGER BOARD ANSWERS WITH A SEARCH GUIDE, NOT A TABLE (F-659).
    // Past some size the feed stops listing jobs and explains its query
    // parameters instead — no row parses, and the scanner reported OnLogic's
    // 33 openings as "ZERO postings — hiring freeze, or moved ATS" (TMEIC,
    // Nextern and Celsius the same). The guide names every department and
    // every country. One search returns at most SEARCH_CAP rows (TMEIC's
    // 34-role parent department answered 30), so a department past the cap is
    // asked through its sub-departments instead. Departments alone are not
    // enough either: 13 of Nextern's 47 have none, so the countries are asked
    // too and the answers merged.
    const byUrl = new Map();
    const searches = [
      ...departmentSearches(departments).map((name) => `department=${encodeURIComponent(name)}`),
      ...countriesFromSearchGuide(text).map((c) => `${encodeURIComponent('location[0][country]')}=${encodeURIComponent(c)}`),
    ];
    for (const query of searches) {
      const url = `${feedUrl}?${query}`;
      assertWorkableUrl(url);
      for (const job of parseWorkableMarkdown(await ctx.fetchText(url, { redirect: 'error' }), entry.name)) {
        if (!byUrl.has(job.url)) byUrl.set(job.url, job);
      }
    }
    return [...byUrl.values()];
  },
};

/** Rows one Workable search returns at most (measured on TMEIC, 2026-10-02). */
export const SEARCH_CAP = 30;

/**
 * The department tree of Workable's search guide — the page a large board
 * serves at /jobs.md in place of its table. Sub-departments are indented
 * under their parent.
 *
 * @param {string} text
 * @returns {Array<{name: string, count: number, children: Array}>} empty when the page is a table
 */
export function departmentsFromSearchGuide(text) {
  if (typeof text !== 'string' || text.includes('[View](')) return [];
  const section = text.split(/^## Departments\s*$/m)[1];
  if (!section) return [];
  const roots = [];
  const stack = [];   // [{ indent, node }]
  for (const line of section.split(/^## /m)[0].split('\n')) {
    const m = line.match(/^(\s*)- (.+?) \((\d+) roles?\)\s*$/);
    if (!m) continue;
    const node = { name: m[2], count: Number(m[3]), children: [] };
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

/**
 * Which departments to search: each one whose search fits under the cap,
 * and for any that does not, its sub-departments as well. The parent is
 * still asked — openings filed on it directly belong to no child, and a
 * capped answer for them beats none.
 *
 * @param {Array<{name: string, count: number, children: Array}>} tree
 * @returns {string[]}
 */
export function departmentSearches(tree) {
  const out = [];
  for (const d of tree) {
    out.push(d.name);
    if (d.count >= SEARCH_CAP) out.push(...departmentSearches(d.children));
  }
  return out;
}

/**
 * The countries of the same guide's "## Locations" list
 * ("- United States: Minnesota, Maple Grove | …").
 *
 * @param {string} text
 * @returns {string[]}
 */
export function countriesFromSearchGuide(text) {
  if (typeof text !== 'string') return [];
  const section = text.split(/^## Locations\s*$/m)[1];
  if (!section) return [];
  const out = [];
  for (const line of section.split(/^## /m)[0].split('\n')) {
    const m = line.match(/^- ([^:]+):/);
    if (m && !out.includes(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

/**
 * Parse Workable's public markdown feed. Exported as a named export for unit
 * tests. The feed exposes a table:
 *   | Title | Department | Location | Type | Salary | Posted | Details |
 * where `Details` holds a markdown link
 *   [View](https://apply.workable.com/<slug>/jobs/view/<id>.md)
 * URLs are validated against `https://apply.workable.com/` — off-domain or
 * non-HTTPS [View] links are skipped (not emitted).
 *
 * @param {string} text — markdown body
 * @param {string} companyName — value to write into job.company
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseWorkableMarkdown(text, companyName) {
  if (typeof text !== 'string') return [];
  const jobs = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const cols = line.split('|').map(c => c.trim());
    // Cols: ['', title, dept, location, type, salary, posted, '[View](url.md)', '']
    if (cols.length < 8) continue;
    const title = cols[1];
    if (!title || title === 'Title') continue;
    const location = cols[3] || '';
    const urlMatch = line.match(/\[View\]\(([^)]+)\)/);
    let url = urlMatch ? urlMatch[1] : '';
    if (url.endsWith('.md')) url = url.slice(0, -3);
    if (!url) continue;  // skip rows with no resolvable URL (e.g., malformed [View] link)

    // Validate the extracted URL — must parse as https://apply.workable.com/...
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'apply.workable.com') continue;
      url = parsedUrl.href;
    } catch {
      continue;
    }

    jobs.push({ title, url, location, company: companyName });
  }
  return jobs;
}
