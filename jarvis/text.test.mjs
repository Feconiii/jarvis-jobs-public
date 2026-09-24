#!/usr/bin/env node
// jarvis/text.test.mjs — golden tests for the description converter.
//
// Every input below is the shape of a real stored description that was showing
// up unreadable on the card. The first one is the whole reason this file
// exists: Greenhouse ships bodies with the markup entity-ENCODED, and the old
// converter decoded entities AFTER stripping tags, so it re-created the tags as
// visible text instead of removing them. 15,876 of 35,362 stored descriptions
// were affected.
//
// Run: `node jarvis/text.test.mjs` (exit 1 on any failure).

import { htmlToText, decodeEntities, needsCleaning } from './text.mjs';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

console.log('🧪 text: entity-encoded markup (Greenhouse)');
eq('tags arrive encoded and must be REMOVED, not revealed',
  htmlToText('&lt;div class="content-intro"&gt;&lt;p&gt;&lt;strong&gt;About Neuralink:&lt;/strong&gt;&lt;/p&gt;\n&lt;p&gt;We are creating devices.&lt;/p&gt;&lt;/div&gt;'),
  'About Neuralink:\n\nWe are creating devices.');

console.log('🧪 text: structure the markup carried');
eq('self-closing breaks become newlines, not spaces',
  htmlToText('<p>Line one<br/>Line two<br>Line three</p>'),
  'Line one\nLine two\nLine three');
eq('list items keep their bullets and do not double-space',
  htmlToText('<ul><li>SolidWorks</li><li>GD&amp;T</li><li>FEA</li></ul>'),
  '• SolidWorks\n• GD&T\n• FEA');
eq('table cells are separated rather than fused into one word',
  htmlToText('<table><tr><td>Level</td><td>Pay</td></tr></table>'),
  'Level Pay');

console.log('🧪 text: entities');
eq('hex numeric entities decode', htmlToText('Don&#x2019;t miss&#xa0;this'), 'Don’t miss this');
eq('decimal numeric entities decode', htmlToText('caf&#233;'), 'café');
eq('named entities beyond the basic five decode',
  htmlToText('&mdash; it&rsquo;s good&hellip;'), '— it’s good…');
eq('astral codepoints survive (fromCodePoint, not fromCharCode)',
  htmlToText('&#128204; pinned'), '📌 pinned');
eq('unknown entities are left alone rather than mangled',
  decodeEntities('&notarealentity; stays'), '&notarealentity; stays');

console.log('🧪 text: things it must NOT break');
eq('decoded comparison operators are not eaten as a tag',
  htmlToText('Temperature &lt; 100C and &gt; 50C'), 'Temperature < 100C and > 50C');
eq('inline tags leave no space, so span-wrapped pay stays adjacent',
  htmlToText('<span>$104,000</span><span>&mdash;</span><span>$156,000 USD</span>'),
  '$104,000—$156,000 USD');
eq('already-plain text is returned unchanged',
  htmlToText('Already plain text, nothing to do.'), 'Already plain text, nothing to do.');
eq('script and style contents are dropped',
  htmlToText('<style>.a{color:red}</style><p>Real text</p><script>var x=1<2;</script>'), 'Real text');
eq('empty input', htmlToText(''), '');
eq('null input', htmlToText(null), '');

console.log('🧪 text: the backfill predicate');
eq('markup is detected', needsCleaning('<p>hi</p>'), true);
eq('encoded markup is detected', needsCleaning('&lt;p&gt;hi&lt;/p&gt;'), true);
eq('a real NBSP is detected', needsCleaning('a b'), true);
eq('clean text is left alone', needsCleaning('Plain text — with an em dash.'), false);
eq('converter output never needs a second pass',
  needsCleaning(htmlToText('&lt;p&gt;Don&#x2019;t&lt;/p&gt;&nbsp;<br/>')), false);

console.log('🧪 text: a file name a header can carry (2026-09-23)');
{
  const { contentDisposition } = await import('./text.mjs');
  const exo = 'Alex Rivera - Exowatt - Mechanical Engineer – Optical Systems (Miami, FL).pdf';
  const h = contentDisposition('inline', exo);
  eq('the Exowatt en dash becomes a plain dash in the name the extension reads',
    /filename="([^"]+)"/.exec(h)[1], 'Alex Rivera - Exowatt - Mechanical Engineer - Optical Systems (Miami, FL).pdf');
  eq('the header is all ASCII, which is what Node requires', /^[\x20-\x7E]+$/.test(h), true);
  eq('the exact name rides along for a browser', h.includes("filename*=UTF-8''") && decodeURIComponent(h.split("''")[1]) === exo, true);
  eq('an accent keeps its letter', /filename="([^"]+)"/.exec(contentDisposition('attachment', 'Société – Rôle.pdf'))[1], 'Societe - Role.pdf');
  eq('a plain name is untouched', /filename="([^"]+)"/.exec(contentDisposition('inline', 'Alex Rivera Resume.pdf'))[1], 'Alex Rivera Resume.pdf');
  // The extension's own reader (background.js) must still find the name.
  const named = /filename="?([^";]+)"?/i.exec(h);
  eq("the extension's reader gets the ASCII name", named[1].trim(), 'Alex Rivera - Exowatt - Mechanical Engineer - Optical Systems (Miami, FL).pdf');
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
