// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// PageUp (careers.pageuppeople.com) provider — added 2026-10-02 for Enpro.
//
// Every PageUp tenant publishes its whole board as one public RSS feed, with
// the requisition number (job:refNo), the location and the FULL description
// in each item, so one request reads the board and nothing needs enriching:
//   https://careers.pageuppeople.com/<instance>/<site>/en-us/rss
//
// Enpro's own careers site (careers.enpro.com) answers every server request
// with an empty 202, so its sitemap gave slug-built titles ("Manufacturing
// Engineer Morgan Hill California United States C0beb96c C2ea …"), no text,
// and URLs that share nothing with the application form he lands on
// (secure.dc4.pageuppeople.com/…/initApplication.asp?lJobID=497392). The
// posting URL here ends in that same number.
//
// Explicit configuration (no auto-detect) — a portals.yml entry sets:
//   provider: pageup
//   pageup_instance: 1050
//   pageup_site: cw          (the listing whose feed carries the jobs; "aw" was empty)
//   pageup_locations: { "Morgan Hill": "Morgan Hill, CA, US", … }   (optional)

import { htmlToText } from '../jarvis/text.mjs';

const tag = (item, name) => {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
};
const unescape = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** One feed's items as jobs. Exported for the test. */
export function parsePageUpFeed(xml, { company = '', base = '', places = {} } = {}) {
  const jobs = [];
  for (const raw of String(xml || '').split('<item>').slice(1)) {
    const item = raw.split('</item>')[0];
    const title = htmlToText(unescape(tag(item, 'title'))).trim();
    const ref = tag(item, 'job:refNo').trim();
    const link = unescape(tag(item, 'link')).trim() || (base && ref ? `${base}/job/${ref}` : '');
    if (!title || !/^https:\/\//.test(link)) continue;
    // "Remote|Remote,Stemco|Longview": a pipe between a region and its site,
    // a comma between sites.
    // A site is a plant name with no state ("Morgan Hill" reads as unknown, so
    // it never reaches a US-only deck); the entry's pageup_locations spells it.
    const location = unescape(tag(item, 'job:location')).split(',')
      .map((s) => s.split('|').pop().trim()).filter(Boolean)
      .map((site) => places[site] || site).join(' | ');
    const posted = Date.parse(tag(item, 'pubDate'));
    const division = unescape(tag(item, 'job:businessLayer1')).split('|').pop()?.trim() || '';
    jobs.push({
      title,
      url: link,
      company,
      location,
      team: division,
      description: htmlToText(unescape(tag(item, 'job:description'))),
      postedAt: Number.isNaN(posted) ? undefined : posted,
    });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'pageup',

  detect() { return null; },

  async fetch(entry, ctx) {
    const instance = String(entry.pageup_instance || '').trim();
    if (!/^\d+$/.test(instance)) throw new Error(`pageup: entry "${entry.name}" needs pageup_instance (the number in careers.pageuppeople.com/<n>/)`);
    const site = String(entry.pageup_site || 'cw').trim();
    const base = `https://careers.pageuppeople.com/${instance}/${site}/en-us`;
    const xml = await ctx.fetchText(`${base}/rss`, { timeoutMs: 30000 });
    return parsePageUpFeed(xml, { company: entry.name || '', base, places: entry.pageup_locations || {} });
  },
};
