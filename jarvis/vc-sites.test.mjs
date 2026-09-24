// Reading a VC portfolio as DOMAINS rather than names (F-433).
//
// The name route breaks twice: most firms render their portfolio client-side so
// no names are in the HTML, and a slug guessed from a name misses every board
// whose slug is an abbreviation. A portfolio page does one thing reliably in
// every framework — it links to each company's own site — and a domain feeds
// straight into the careers-page resolver that found Commonwealth Fusion at
// `jobs.lever.co/cfsenergy`.
//
// So what matters is that the extractor keeps companies and drops the firm's
// own furniture. These assertions are all about that line.

import { companyHostsIn, nameFromHost, VC_SITES } from '../seeds/vc-sites.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 vc-sites: portfolio companies out of a portfolio page');

check('an outbound company link is a company',
  companyHostsIn('<a href="https://hadrian.co">Hadrian</a>', 'constructcap.com'), ['hadrian.co']);
check('www is stripped so one company is one entry',
  companyHostsIn('<a href="https://www.zenopower.com/">Zeno</a> <a href="https://zenopower.com">Zeno</a>', 'seraphim.vc'),
  ['zenopower.com']);
check('single quotes parse too',
  companyHostsIn("<a href='https://cowboyspace.com'>x</a>", 'constructcap.com'), ['cowboyspace.com']);

// The firm's own site is all over its own page — nav, logo, every article.
check('the firm itself is not a portfolio company',
  companyHostsIn('<a href="https://www.constructcap.com/team">Team</a><a href="https://constructcap.com">Home</a>', 'www.constructcap.com'), []);
check('…including its own subdomains',
  companyHostsIn('<a href="https://blog.constructcap.com/x">Blog</a>', 'constructcap.com'), []);

// Socials, CDNs, analytics and the press outlets a firm links to are on every
// one of these pages and none of them is a portfolio company.
check('socials are dropped', companyHostsIn('<a href="https://twitter.com/x">t</a><a href="https://www.linkedin.com/c/y">l</a>', 'f.vc'), []);
check('CDNs and analytics are dropped',
  companyHostsIn('<a href="https://googletagmanager.com/x">g</a><a href="https://cdn.cloudflare.com/y">c</a>', 'f.vc'), []);
check('press outlets are dropped',
  companyHostsIn('<a href="https://bloomberg.com/news">b</a><a href="https://techcrunch.com/p">t</a>', 'f.vc'), []);
// gmpg.org and w.org appear in the boilerplate of every WordPress site and were
// the ONLY "companies" a naive extractor found on two of these pages.
check('CMS boilerplate is dropped',
  companyHostsIn('<link href="https://gmpg.org/xfn/11"><a href="https://w.org/">x</a>', 'f.vc'), []);
// A deep subdomain is infrastructure; a company links to its apex.
// docs.daily.co and daily.co are one employer. Counting them separately would
// probe the same company three times under three names — which is what a JS
// bundle hands you, since it carries every URL the site ever calls.
check('an infrastructure subdomain folds into its company',
  companyHostsIn('<a href="https://docs.daily.co/x">d</a>', 'f.vc'), ['daily.co']);
check('…and does not duplicate the apex',
  companyHostsIn('<a href="https://app.hash.ai">a</a><a href="https://hash.ai">b</a>', 'f.vc'), ['hash.ai']);
check('a real product subdomain is kept',
  companyHostsIn('<a href="https://site.4pilab.com">x</a>', 'f.vc'), ['site.4pilab.com']);
check('link shorteners and registries are dropped',
  companyHostsIn('<a href="https://bit.ly/x">b</a><a href="https://ghcr.io/y">g</a>', 'f.vc'), []);
check('a deep subdomain is not a company homepage',
  companyHostsIn('<a href="https://cdn.assets.example.com/x">x</a>', 'f.vc'), []);

check('relative and mailto links are ignored',
  companyHostsIn('<a href="/portfolio">p</a><a href="mailto:hi@f.vc">m</a>', 'f.vc'), []);
check('an empty page yields nothing', companyHostsIn('', 'f.vc'), []);
check('a non-string yields nothing', companyHostsIn(null, 'f.vc'), []);

console.log('\n🧪 vc-sites: naming the company from its domain');

check('a plain domain', nameFromHost('hadrian.co'), 'Hadrian');
check('a hyphenated domain becomes words', nameFromHost('form-energy.com'), 'Form Energy');
check('www is ignored', nameFromHost('www.zenopower.com'), 'Zenopower');
check('a subdomain uses its first label', nameFromHost('site.4pilab.com'), 'Site');
check('nothing in, nothing out', nameFromHost(''), '');

console.log('\n🧪 vc-sites: the registry');
check('every firm has a url and a label',
  Object.values(VC_SITES).every(v => /^https:\/\//.test(v.url) && v.label.length > 0), true);
check('the firms that were measured to work are registered',
  ['eightvc', 'seraphim', 'construct'].every(k => k in VC_SITES), true);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
