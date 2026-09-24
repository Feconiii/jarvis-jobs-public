// jarvis/text.mjs — turn whatever an ATS calls a "description" into text a
// human can read.
//
// WHY THIS IS ITS OWN MODULE: the converter used to live in enrich.mjs, and it
// had an ordering bug that made nearly half the stored descriptions unreadable.
// It stripped tags FIRST and decoded HTML entities SECOND:
//
//     .replace(/<[^>]+>/g, ' ')            // strip
//     .replace(/&lt;/g, '<').replace(/&gt;/g, '>')   // then decode
//
// Greenhouse — one of the largest sources in the store — ships the body with
// its markup entity-ENCODED (`&lt;p&gt;About us&lt;/p&gt;`). The stripper saw
// no tags to remove, and the decoder then RE-CREATED every tag as literal text.
// The user was reading `<div class="content-intro"><p><strong>About:</strong>`
// on screen. Decoding has to happen first, and then the tags are real and can
// be removed.
//
// Three smaller faults rode along with it and are fixed here too:
//   · `<br>` and `<br/>` are self-closing, so the "block tag → newline" rule
//     (which only matched CLOSING tags) turned every line break into a space.
//     676 of 3,000 sampled descriptions were one long run-on paragraph.
//   · Only DECIMAL numeric entities were decoded, so the hex ones every modern
//     editor emits — `&#xa0;`, `&#x2019;`, `&#x1f4cc;` — survived as visible
//     gibberish, and `String.fromCharCode` mangled anything above U+FFFF.
//   · Named entities beyond the five basic ones were never decoded at all, so
//     `&mdash;`, `&rsquo;` and `&hellip;` printed as themselves.
//
// It is used at BOTH ends now — scan time and enrichment — so no description
// can enter the store as markup regardless of which path brought it in.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', shy: '', zwj: '', zwnj: '', feff: '',
  mdash: '—', ndash: '–', horbar: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', prime: '′', Prime: '″',
  deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', frac12: '½',
  frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ',
  ne: '≠', le: '≤', ge: '≥', asymp: '≈', infin: '∞', radic: '√', sum: '∑',
  larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑',
  trade: '™', reg: '®', copy: '©', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  agrave: 'à', egrave: 'è', ugrave: 'ù', ccedil: 'ç', auml: 'ä', ouml: 'ö',
  uuml: 'ü', szlig: 'ß', aring: 'å', oslash: 'ø', aelig: 'æ', ecirc: 'ê',
  ocirc: 'ô', acirc: 'â', icirc: 'î', ucirc: 'û', atilde: 'ã', otilde: 'õ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', Ccedil: 'Ç', Aring: 'Å', Oslash: 'Ø',
};

/**
 * Decode HTML entities: named, decimal (`&#8217;`) and hex (`&#x2019;`).
 *
 * `fromCodePoint`, not `fromCharCode` — the latter silently truncates anything
 * above U+FFFF, which turns an emoji bullet in a posting into a lone surrogate
 * that renders as a replacement box forever after.
 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m);
}

function codePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  // Lone surrogates are not characters and throw; drop them.
  if (n >= 0xd800 && n <= 0xdfff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/**
 * Remove markup, keeping the structure the markup carried.
 *
 * Block elements become newlines and list items become bullets, because a
 * requirements list flattened into one paragraph is exactly as unreadable as
 * raw HTML — just less obviously broken.
 */
function stripTags(s) {
  return s
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Self-closing and opening breaks. These are why the old converter lost
    // every line break it should have kept.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    // List items carry a bullet so a requirements list still reads as a list.
    .replace(/<li\b[^>]*>/gi, '\n• ')
    // Table cells keep a separator so columns do not fuse into one word.
    .replace(/<\/t[dh]>/gi, '  ')
    // Everything else that ends a block ends a line.
    .replace(/<\/?(p|div|section|article|ul|ol|dl|dd|dt|table|tr|h[1-6]|blockquote|pre|form|header|footer|figure)\b[^>]*>/gi, '\n')
    // `</li>` deliberately leaves NOTHING: the next `<li>` supplies the break,
    // and closing one here too would put a blank line between every bullet.
    .replace(/<\/li>/gi, '')
    // Inline tags (<strong>, <em>, <span>, <a>) leave nothing behind: removing
    // them with a SPACE would split "$104,000" out of "<span>$104,000</span>"
    // wrappers and break the pay parser that reads the same text.
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

/** Collapse the whitespace that markup removal leaves behind. */
function tidy(s) {
  return s
    .replace(/\r\n?/g, '\n')
    // Real NBSP characters, not just the entity — they survive every collapse
    // rule below because they are not, technically, whitespace.
    .replace(/[   ﻿]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    // Bullets that ended up on their own line rejoin the item they belong to.
    .replace(/\n•\s*\n/g, '\n• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert an ATS description — HTML, entity-encoded HTML, or already-plain
 * text — into readable plain text. Safe to run on text that is already clean.
 *
 * Two decode/strip passes, because a body that arrived entity-encoded needs one
 * pass to become HTML and a second to become text. Bodies that were never
 * encoded exit after the first, since the loop stops as soon as no tags remain.
 */
export function htmlToText(input) {
  if (!input) return '';
  let s = String(input);
  for (let pass = 0; pass < 3; pass++) {
    s = decodeEntities(s);
    // A tag starts with a letter or a slash — a bare "<" from decoded prose
    // ("temperature < 100C and > 50C") must never be eaten as markup.
    if (!/<\/?[a-zA-Z][^>]*>/.test(s)) break;
    s = stripTags(s);
  }
  return tidy(s);
}

/** True when a stored description still carries markup or undecoded entities. */
export function needsCleaning(s) {
  if (!s) return false;
  return /<\/?[a-zA-Z][^>]*>|&(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d+|#x[0-9a-fA-F]+);|[ ﻿]/.test(s);
}

/**
 * A FILE NAME AN HTTP HEADER CAN CARRY (2026-09-23).
 *
 * Exowatt's posting is "Mechanical Engineer – Optical Systems", with an en
 * dash, and the resume is named after the posting. Node refuses a header value
 * outside Latin-1, so the dashboard answered 500 ("Invalid character in header
 * content") for a resume that was built and sitting on disk — the panel could
 * not show it, the form could not get it. Any title with a curly quote, an em
 * dash or an accented letter did the same.
 *
 * The plain `filename` is ASCII: dashes become "-", curly quotes straight,
 * accents dropped to their letter, anything else removed. That is the name the
 * extension reads and the one an ATS upload sees, which is the safer name for
 * a form anyway. `filename*` carries the exact name for a browser that saves it.
 */
export function contentDisposition(kind, name) {
  const exact = String(name || 'file.pdf');
  const ascii = exact
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ').trim() || 'file.pdf';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(exact)}`;
}
