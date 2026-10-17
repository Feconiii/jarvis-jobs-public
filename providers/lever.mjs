// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url pattern `https://jobs.lever.co/<slug>`.

/**
 * The whole posting body. Lever splits a posting into `description` (the
 * intro), `lists` (each titled section — "What you'll do", "What we're looking
 * for") and `additional` (the closing text). Reading `descriptionPlain` alone
 * kept only the intro: every CFS posting reached the store as its "About CFS"
 * paragraph, with the degree and years lines the eligibility screen reads
 * thrown away. HTML throughout — scan.mjs converts it once at the door.
 */
export function leverBody(j) {
  const parts = [typeof j.description === 'string' && j.description ? j.description : (j.descriptionPlain || '')];
  for (const l of Array.isArray(j.lists) ? j.lists : []) {
    if (l?.text) parts.push(`<h3>${l.text}</h3>`);
    if (l?.content) parts.push(`<ul>${l.content}</ul>`);
  }
  parts.push(typeof j.additional === 'string' && j.additional ? j.additional : (j.additionalPlain || ''));
  return parts.filter(Boolean).join('\n');
}

/**
 * A board's own outline numbering is not part of the title. Phoenix Tailings
 * files every posting under a section number ("4.6. Manufacturing Engineer I"),
 * and the same job everywhere else — LinkedIn, his notes, the email — is
 * "Manufacturing Engineer I". Only a number-dot run at the very start is taken:
 * "2027 New Grad" and "3D Printing Engineer" have no dot and keep theirs.
 */
export function leverTitle(text) {
  return String(text || '').replace(/^\s*\d+(?:\.\d+)*\.\s+/, '').trim();
}

function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.lever.co/v0/postings/${match[1]}`;
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: leverTitle(j.text),
      url: j.hostedUrl || '',
      company: entry.name,
      team: [j.categories?.department, j.categories?.team].filter(Boolean).join(' / '),
      location: j.categories?.location || '',
      // Lever's v0 postings list ships the full description for free (same
      // payload, no per-job request) — enables scan.mjs content_filter.
      description: leverBody(j),
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
