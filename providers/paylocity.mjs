// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Paylocity Recruiting — the public job board's own page data.
//
// WHY (2026-10-04, F-720). After every known US engineering employer had been
// checked once, Paylocity was the most common platform among the misses that
// named one: 80 employers, Advanced Cooling Technologies and Uniloy among them.
// A board is the public page
//   https://recruiting.paylocity.com/recruiting/jobs/All/<COMPANY-GUID>/<Name>
// which carries every posting in `window.pageData = { Jobs: [{ JobId, JobTitle,
// PublishedDate, JobLocation: { City, State, Country }, IsInternal }] }`.
// Each posting's page, /Recruiting/Jobs/Details/<JobId>, publishes a schema.org
// JobPosting, which enrich.mjs already reads. No auth.

const HOST = 'recruiting.paylocity.com';
const BOARD_RE = /^\/recruiting\/jobs\/All\/([0-9a-f-]{36})(?:\/([^/?#]*))?/i;

/** The board URL from any URL on it, or null. */
export function paylocityBoard(raw) {
  let u;
  try { u = new URL(String(raw || '').replace(/&amp;/g, '&')); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST) return null;
  const m = u.pathname.match(BOARD_RE);
  return m ? `https://${HOST}/recruiting/jobs/All/${m[1].toLowerCase()}${m[2] ? `/${m[2]}` : ''}` : null;
}

/** Every Paylocity board linked from a page. */
export function paylocityBoardsIn(html) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/https:\/\/recruiting\.paylocity\.com\/recruiting\/jobs\/All\/[0-9a-fA-F-]{36}(?:\/[A-Za-z0-9._%-]*)?/gi)) {
    const b = paylocityBoard(m[0]);
    if (b) out.add(b);
  }
  return [...out];
}

/** The `window.pageData` object literal, read by brace depth, or null. */
export function pageData(html) {
  const s = String(html || '');
  const at = s.indexOf('window.pageData');
  if (at < 0) return null;
  const start = s.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Board page → normalized jobs. Internal-only postings are skipped: he cannot
 * apply to them. Exported for tests.
 * @param {string} html
 * @param {string} company
 */
export function parsePaylocityPage(html, company) {
  const data = pageData(html);
  const list = Array.isArray(data?.Jobs) ? data.Jobs : [];
  const jobs = [];
  for (const j of list) {
    if (!j?.JobId || !j?.JobTitle || j.IsInternal) continue;
    const l = j.JobLocation || {};
    const where = [l.City, l.State, l.Country === 'USA' ? 'US' : l.Country].filter(Boolean).join(', ')
      || String(j.LocationName || '') || (j.IsRemote ? 'Remote' : '');
    const posted = j.PublishedDate ? Date.parse(j.PublishedDate) : NaN;
    jobs.push({
      title: String(j.JobTitle).trim(),
      url: `https://${HOST}/Recruiting/Jobs/Details/${j.JobId}`,
      company: company || '',
      location: where,
      postedAt: Number.isNaN(posted) ? undefined : posted,
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'paylocity',

  detect(entry) {
    const b = paylocityBoard(entry.careers_url);
    return b ? { url: b } : null;
  },

  async fetch(entry, ctx) {
    const board = paylocityBoard(entry.careers_url);
    if (!board) throw new Error(`paylocity: ${entry.name} needs a careers_url like https://recruiting.paylocity.com/recruiting/jobs/All/<GUID>/<Name>`);
    const html = await ctx.fetchText(board, { redirect: 'error', headers: { accept: 'text/html' } });
    return parsePaylocityPage(html, entry.name);
  },
};
