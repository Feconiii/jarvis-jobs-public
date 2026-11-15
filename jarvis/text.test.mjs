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

console.log('🧪 text: a body whose requirement sections are all empty (F-760)');
{
  const { hollowBody } = await import('./text.mjs');
  // CNH, join.cnh.com, 2026-10-18: the Italian and French copies of a US
  // requisition, as the SuccessFactors feed carries them.
  const IT = 'Chi siamo\n\nInnovazione. Sostenibilità. Produttività. È così che stiamo aprendo nuove strade nella nostra missione.\n\n'
    + 'Scopo del ruolo\n\nMaggiori Responsabilità\n\nEsperienza Richiesta\n\nQualifiche preferenziali\n\nTrasparenza salariale\n\n'
    + 'Lo stipendio annuale per questo ruolo è di USD $19,57 - $35,02, più eventuali bonus applicabili.\n\nModalità di lavoro flessibili\n\nCongedo parentale';
  const FR = 'À propos de nous \n\n \n\n Innovation. Durabilité. Productivité.\n\n Objectif du poste \n\n \n\n Principales responsabilités \n\n \n\n'
    + ' Expérience requise \n\n \n\n Qualifications requises \n\n \n\n Transparence salariale \n\n Le salaire annuel pour ce poste est de USD $19,57 - $35,02.';
  const EN_HOLLOW = 'Grow a Career. Build a Future.\nJob Purpose\nKey Responsibilities\nExperience Required\nPreferred Qualifications\nPay Transparency\nThe annual salary for this role is EUR €39,000.00 - €59,800.00 plus any applicable bonus.';
  eq('the Italian template copy is hollow', hollowBody(IT), true);
  eq('the French one too', hollowBody(FR), true);
  eq('an English copy with the same empty sections too', hollowBody(EN_HOLLOW), true);
  // The same template with the sections filled in — CNH's own Italian posting
  // for a Torino role, which IS a description.
  const IT_FULL = 'Scopo del ruolo\n\nBridge the gap between business needs and IT solutions. They analyze business processes.\n\n'
    + 'Maggiori Responsabilità\n\n• Requirement Gathering: Working with business users to understand their needs.\n\nEsperienza Richiesta\n\n• 3+ years';
  eq('a filled-in template is not', hollowBody(IT_FULL), false);
  eq('a normal posting is not', hollowBody('Responsibilities\n• Design fixtures for wafer handling\nQualifications\n• BS in Mechanical Engineering'), false);
  eq('one empty heading before a filled one is not enough', hollowBody('Requirements\nQualifications\n• BS in Mechanical Engineering, 0-2 years of experience'), false);
  eq('the benefits list is not mistaken for headings', hollowBody('Benefits\nMedical\nDental\nVision\n401(k)'), false);
  // McCormick's SuccessFactors table: headings repeated, then short column
  // labels, then the text — a full posting that the first version of this
  // check called hollow.
  const MCCORMICK = 'Key Responsibilities\nKey Responsibilities\nDescription\n% of Time Spent\n'
    + 'Maintaining customer quality satisfaction through the implementation of quality systems.\n30%\n'
    + 'Required Qualifications\nRequired Qualifications\nQualifications\nDescription\nLevel of Education and Discipline\n'
    + 'BSc in Technical - Quality/Research/Product Development\n'
    + 'Preferred Qualifications\nPreferred Qualifications\nQualifications\nDescription\nLevel of Education and Discipline\nMS in Technical';
  eq('a table under repeated headings is not hollow', hollowBody(MCCORMICK), false);
  // Cargill and HF Sinclair: whole requirement sections one short line long.
  eq('a one-line section is a section (Cargill)', hollowBody('Qualifications\nMinimum Qualifications\nSecondary education level or equivalent\nPreferred Qualifications\nBachelor\'s degree in related field\nExperience with SAP'), false);
  eq('…and so is one short sentence (HF Sinclair)', hollowBody('Experience\nExperience:\nOne year of job experience is required.\nPreferred Experience:\nRequired Skills\nRequired Skills:\nExcel'), false);
  eq('three stacked headings with the list under the last are not hollow', hollowBody('Responsibilities\nRequirements\nQualifications\n• BS in Mechanical Engineering\n• SolidWorks'), false);
  eq('an empty body is not "hollow" (it is just empty)', hollowBody(''), false);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
