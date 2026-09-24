/**
 * The cover letter as a page: his letterhead, the date, the recipient, and a
 * PDF an ATS can take.
 *
 * WHY THIS EXISTS. The letter used to be text in a panel, which he could copy
 * into a box if the form had one. Most forms want a file, and his own letters
 * are laid out — name and contact at the top, the date, then who it is going
 * to. His words, 2026-09-08: "cover letter should be attached automatically as
 * pdf, make sure you have address and name and all the appropriate formatting
 * at top of letter, match location and address exactly for job posting".
 *
 * THE HEADER IS HIS, COPIED FROM HIS OWN LETTERS (cover-letters/STYLE.md).
 * The contact lines below are placeholders — his real ones come from
 * config/profile.yml at render time and never appear in tracked source:
 *
 *     Alex Rivera
 *     Springfield, WA
 *     +1 (555) 010-0000
 *     alex@example.com
 *
 *     January 7, 2026
 *
 *     Hiring Manager
 *     ASM
 *     Phoenix, AZ, United States
 *
 *     Dear Hiring Manager,
 *
 * THE COMPANY'S LOCATION IS THE POSTING'S, VERBATIM. He does not invent street
 * addresses and neither does this: where a posting says only "Phoenix, AZ,
 * United States", that is the line, exactly as his own ASM letter has it. A
 * street address is used only when the posting itself carries one.
 */
import { mkdirSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "January 7, 2026" — the form every one of his letters uses. */
export function letterDate(d = new Date()) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * The posting's location as an address line.
 *
 * Verbatim, as he asked, minus the work-model word an ATS glues onto the
 * front: "Hybrid- Fremont, CA" is a working arrangement and a place, and only
 * the place belongs under a company name on a letter.
 */
export function locationLine(location = '') {
  return String(location || '')
    .replace(/^\s*(?:hybrid|remote|on-?site|in-?office|flexible)\b[\s:–—-]*/i, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * A street address the POSTING gives, or ''.
 *
 * Only a line that looks like a US street address and sits near the top of the
 * description counts. Nothing is inferred from the company name, and nothing
 * is looked up: an invented address on a letter is a fabricated fact.
 */
export function addressFromJd(jd = '', location = '') {
  const text = String(jd || '').slice(0, 6000);
  // "1234 Balentine Dr", "5900 S 226th St", "500 Jackson Street" — a number, a
  // few words that may themselves be numbered, and a street type.
  const re = /\b\d{1,6}\s+(?:(?:[A-Z][\w.'-]*|\d+(?:st|nd|rd|th))\s+){0,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Court|Ct\.?|Parkway|Pkwy\.?|Circle|Cir\.?|Place|Pl\.?)\b/g;
  // The city the posting itself names, so an address belonging to a customer,
  // a conference venue or another office cannot end up on his letter. Without
  // a city to tie it to, no street is used at all. The work-model word comes
  // off first: "Hybrid- Fremont, CA" splits to "Hybrid" otherwise, and a
  // posting whose city is unreadable would silently drop every address.
  const city = locationLine(location).split(/[,\-–]/)[0].trim();
  if (!city || city.length < 3) return '';
  for (const m of text.matchAll(re)) {
    const near = text.slice(Math.max(0, m.index - 160), m.index + m[0].length + 160);
    if (near.toLowerCase().includes(city.toLowerCase())) return m[0].replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * The lines above "Dear …", in order.
 *
 * @param {object} candidate  config/profile.yml's candidate block
 * @param {object} job        the posting: company, title, location
 * @param {string} jd         its description, read only for a street address
 */
export function letterHead({ candidate = {}, job = {}, jd = '', date = new Date(), salutation = 'Hiring Manager' } = {}) {
  const name = String(candidate.full_name || 'Alex Rivera').trim();
  const mine = [name, candidate.location, candidate.phone, candidate.email]
    .map((v) => String(v || '').trim()).filter(Boolean);
  const street = addressFromJd(jd, job.location);
  const theirs = [salutation, String(job.company || '').trim(), street, locationLine(job.location)]
    .map((v) => String(v || '').trim()).filter(Boolean);
  return { mine, date: letterDate(date), theirs, greeting: `Dear ${salutation},`, name };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page. One inch of margin, a serif face, and the same block order as his
 * own letters. Deliberately plain: this is a business letter, and anything
 * decorative on it would read as a template.
 */
export function letterHtml({ head, body, fontPt = 11.5, leading = 1.42 }) {
  const paras = String(body || '').trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 8.5in; min-height: 11in; box-sizing: border-box; padding: 1in 1in 0.9in;
    font: ${fontPt}pt/${leading} "Times New Roman", Times, Georgia, serif; color: #000;
    -webkit-font-smoothing: antialiased;
  }
  .block { margin: 0 0 ${leading * 0.85}em; }
  .block div { margin: 0; }
  p { margin: 0 0 ${leading * 0.8}em; text-align: left; }
  .sign { margin-top: ${leading * 1.1}em; }
  .sign div { margin: 0; }
</style></head><body>
  <div class="block">${head.mine.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
  <div class="block"><div>${esc(head.date)}</div></div>
  <div class="block">${head.theirs.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
  <div class="block"><div>${esc(head.greeting)}</div></div>
  ${paras.map((p) => `<p>${esc(p)}</p>`).join('\n  ')}
  <div class="sign"><div>Sincerely,</div><div>${esc(head.name)}</div></div>
</body></html>`;
}

/**
 * Render it, and keep it to one page.
 *
 * A cover letter that runs onto a second page is a cover letter nobody reads
 * to the end. The type is stepped down in small increments before anything
 * else is tried, and the result says what it took — never silently.
 */
export async function renderLetterPdf(html, outPath, { browser = null } = {}) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const own = !browser;
  const b = browser || await chromium.launch();
  try {
    const page = await b.newPage({ viewport: { width: 816, height: 1056 } });
    await page.setContent(html, { waitUntil: 'load' });
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    await page.close();
    return { path: outPath, height, pages: Math.max(1, Math.ceil(height / 1056)) };
  } finally { if (own) await b.close(); }
}

/** Build the page and write the PDF, stepping the type down until it fits. */
export async function writeLetterPdf({ head, body, outPath }) {
  const browser = await chromium.launch();
  try {
    let last = null;
    for (const [fontPt, leading] of [[11.5, 1.42], [11, 1.36], [10.5, 1.3], [10, 1.24]]) {
      const html = letterHtml({ head, body, fontPt, leading });
      // eslint-disable-next-line no-await-in-loop
      last = await renderLetterPdf(html, outPath, { browser });
      last.fontPt = fontPt;
      if (last.pages <= 1) return last;
    }
    return last;
  } finally { await browser.close(); }
}
