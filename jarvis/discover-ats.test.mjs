// Tests for the two checks that decide whether a discovered ATS board is
// really the company we asked for. Both exist because of real failures.

import { nameEvidence, slugCandidates, isCareersHomePayload } from './discover-ats.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 discover-ats: name corroboration');

// The regression this check was written for: "Capital One" resolved to
// jobs.lever.co/capital, a Cyprus crypto firm. The old per-word matcher
// dropped "one" (under 4 chars), leaving only "capital" — a word the slug
// itself supplied — so the board self-corroborated.
check('rejects a board that never says the full company name',
  nameEvidence('Join a dynamic crypto company with capital markets exposure', 'Capital One'), false);
check('accepts a board that names the company',
  nameEvidence('Capital One is hiring a data engineer in McLean', 'Capital One'), true);
check('accepts across punctuation/spacing',
  nameEvidence('Welcome to Capital-One careers', 'Capital One'), true);
check('rejects the same words scattered out of order',
  nameEvidence('We do applied research on intuition pumps', 'Applied Intuition'), false);
check('accepts the contiguous phrase',
  nameEvidence('Applied Intuition builds autonomy software', 'Applied Intuition'), true);
check('empty text is never evidence', nameEvidence('', 'Capital One'), false);
// Hyphenated names must split like any other, or they can never match a
// haystack whose punctuation has been normalised away.
check('hyphenated name corroborates against its own board',
  nameEvidence('Jobs at PT Freeport Indonesia, Freeport-McMoRan', 'Freeport-McMoRan'), true);
check('hyphenated name still rejects an unrelated board',
  nameEvidence('Freeport Bahamas harbour tours', 'Freeport-McMoRan'), false);

console.log('\n🧪 discover-ats: slug strength');

const strength = (name, ticker) =>
  Object.fromEntries(slugCandidates(name, ticker).map(c => [c.slug, c.strong]));

// Full-name slugs are unambiguous; fragments are a coin flip and must earn
// their place via nameEvidence.
const capitalOne = strength('Capital One');
check('full-name slug is strong', capitalOne['capitalone'], true);
check('first-word fragment is weak', capitalOne['capital'], false);

// A one-word company name IS the full name, so it must not be treated as a
// fragment — otherwise Zoox/Uber/Datadog would need corroboration they cannot
// always provide.
check('single-word name is strong', strength('Zoox')['zoox'], true);

// The suffix stripper is deliberately aggressive, which means a real two-word
// name can collapse to one word. That survivor is NOT the full name and must
// not inherit its trust: "International Paper" → "paper" was written into
// portals.yml bound to an unrelated `paper` Workday tenant.
check('word left over after stripping is weak', strength('International Paper')['paper'], false);
check('…and so is "align" from "Align Technology"', strength('Align Technology')['align'], false);
check('but the untouched full name stays strong', strength('International Paper')['internationalpaper'], true);
check('two surviving words are still complete', strength('Applied Materials')['appliedmaterials'], true);
check('suffix-only stripping keeps the raw name strong', strength('Caterpillar Inc.')['caterpillarinc'], true);

// Dropping pure incorporation noise must NOT demote the remainder — otherwise
// correct tenants like adobe / hp / dow all need corroboration they can't give.
check('legal suffix stripped: remainder stays strong', strength('Adobe Inc.')['adobe'], true);
check('legal suffix stripped: HP stays strong', strength('HP Inc.')['hp'], true);
check('legal suffix stripped: Corporation too', strength('Danaher Corporation')['danaher'], true);
// …but a descriptive word carries identity, so its loss still demotes.
check('descriptive word stripped: remainder is weak', strength('Agilent Technologies')['agilent'], false);
check('ticker is always weak', strength('Ford Motor Company', 'F')['f'] ?? 'absent', 'absent'); // too short to be a candidate
check('ticker of usable length is weak', strength('Advanced Micro Devices', 'AMD')['amd'], false);

console.log('\n🧪 seeds: YC payload carries classification');

const { parseYCPayload } = await import('../seeds/vc-portfolios.mjs');

// The seed list is only usable if YC's own tags survive parsing — filtering
// thousands of portfolio companies down to the hardware ones depends on it.
const ycRows = parseYCPayload({
  companies: [{
    name: 'Lambda Robotics', slug: 'lambda-robotics', website: 'https://x.co',
    batch: 'W25', tags: ['Robotics', 'AI'], industries: ['B2B'],
    regions: ['United States of America'], teamSize: 7, status: 'Active',
    oneLiner: 'Robots for warehouses',
  }],
});
check('tags survive parsing', ycRows[0].tags, ['Robotics', 'AI']);
check('industries survive parsing', ycRows[0].industries, ['B2B']);
check('teamSize survives parsing', ycRows[0].teamSize, 7);
check('status survives parsing', ycRows[0].status, 'Active');
check('existing fields unchanged', ycRows[0].slug, 'lambda-robotics');
// Absent metadata must not materialise as empty arrays — consumers check truthiness.
const bare = parseYCPayload({ companies: [{ name: 'Bare', slug: 'bare', website: 'https://y.co' }] });
check('absent tags stay absent', bare[0].tags, undefined);


console.log('\n🧪 seeds: the yc-oss mirror shape');

// F-416. The v0.1 API answers with camelCase under `companies`; the mirror
// answers with a bare snake_case array and two classification fields of its
// own. One parser reads both, or the source swap silently produces companies
// with no tags — which the hardware filter would then drop entirely.
const ossRows = parseYCPayload([{
  name: 'Antropi Robotics', slug: 'antropi', website: 'https://a.co',
  batch: 'Summer 2025', tags: ['Hard Tech'], industries: ['Industrials'],
  industry: 'Industrials', subindustry: 'Manufacturing and Robotics',
  team_size: 12, status: 'Active', one_liner: 'Autonomous CNC factories',
  stage: 'Seed', isHiring: true,
}]);
check('bare array parses', ossRows.length, 1);
check('one_liner maps to oneLiner', ossRows[0].oneLiner, 'Autonomous CNC factories');
check('team_size maps to teamSize', ossRows[0].teamSize, 12);
check('industry and subindustry join industries', ossRows[0].industries,
  ['Industrials', 'Manufacturing and Robotics']);
check('isHiring survives', ossRows[0].isHiring, true);
check('stage survives', ossRows[0].stage, 'Seed');
// The camelCase payload must not regress while both shapes share a parser.
check('camelCase teamSize still wins', parseYCPayload({ companies: [
  { name: 'A', slug: 'a', website: 'https://a.co', teamSize: 4 },
] })[0].teamSize, 4);

console.log('\n🧪 seeds: the curated hardware list');

const { listHardwareStartups, HARDWARE_DOMAINS } = await import('../seeds/hardware-startups.mjs');
const { HARDWARE_TAGS, CLEARANCE_GATED, looksHardware } = await import('./discover-ats.mjs');

const curated = listHardwareStartups();
check('the list is not empty', curated.length > 200, true);

// Every curated name must survive the same filter YC companies face, or a
// name written down on purpose gets thrown away before it is ever probed.
// "medical" was the live case: HARDWARE_TAGS carries "medical device", not
// "medical", so the whole medical-device domain would have vanished.
const filteredOut = curated.filter(c => !looksHardware(c)).map(c => c.name);
check('every curated name passes the hardware filter', filteredOut, []);
check('medical maps onto a tag the filter actually holds',
  HARDWARE_TAGS.includes(listHardwareStartups({ domains: ['medical'] })[0].tags[0]), true);

// His visa constraint, enforced where it cannot be forgotten: a defence-first
// employer added to the curated list must still be refused by the gate.
const gated = curated.filter(c => CLEARANCE_GATED.some(g => c.name.toLowerCase().includes(g)));
check('no curated name is clearance-gated', gated.map(c => c.name), []);

// Slugs reach hostnames now (bamboohr/breezy/recruitee probes), so a curated
// name that cannot produce a safe candidate is a name that can never resolve.
const unslugged = curated.filter(c => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(c.slug));
check('every curated slug is host-safe', unslugged.map(c => c.slug), []);

check('domain filter narrows the list',
  listHardwareStartups({ domains: ['semiconductor'] }).length < curated.length, true);
check('an unknown domain yields nothing', listHardwareStartups({ domains: ['crypto'] }), []);
check('domains are the documented set', HARDWARE_DOMAINS.length, 6);

// One name may sit in two domains; the caller must never probe it twice.
const names = curated.map(c => c.name.toLowerCase());
check('no duplicate names', names.length, new Set(names).size);

console.log('\n🧪 discover-ats: a slug that reaches a hostname');

// Before the BambooHR/Breezy/Recruitee probes a slug only ever landed in a
// path, where an odd character is harmless. In a hostname it is not: it points
// the request at a different host. The ticker is the unsanitised input — it
// comes straight from a downloaded CSV.
const hostile = slugCandidates('Evil Corp', 'a.b/../x');
check('an unsafe ticker never becomes a candidate',
  hostile.some(c => c.slug.includes('/') || c.slug.includes('.')), false);
check('a normal ticker still is', slugCandidates('Advanced Micro Devices', 'AMD')
  .some(c => c.slug === 'amd'), true);


console.log('\n🧪 seeds: a source that returns nothing is broken, not empty');

const { SEED_SOURCES, parseA16zPayload } = await import('../seeds/vc-portfolios.mjs');

check('the curated hardware source is registered', typeof SEED_SOURCES.hardware?.fetch, 'function');
check('and it is wired to the curated list',
  (await SEED_SOURCES.hardware.fetch()).length > 200, true);

// F-417, recorded rather than papered over: a16z restyled its portfolio page
// and all three parse strategies stopped matching. This asserts the parser's
// CURRENT behaviour on markup it cannot read, so that whoever writes the
// fourth strategy has a failing line to flip rather than a silent zero.
check('a16z markup the parser cannot read yields nothing',
  parseA16zPayload('<div class="grid"><span>Stripe</span><span>Figure</span></div>'), []);
// The guard that makes that zero visible lives in fetchA16zCompanies, which is
// network-bound; what is testable here is that an empty page is still empty.
check('an empty page is empty without throwing', parseA16zPayload(''), []);
// The strategies that DO work must keep working, or fixing a16z later starts
// from a broken baseline.
check('JSON-LD organisations are still read', parseA16zPayload(
  '<script type="application/ld+json">{"@type":"Organization","name":"Astranis","url":"https://astranis.com"}</script>'
).map(c => c.name), ['Astranis']);


console.log('\n🧪 discover-ats: reading a board out of a careers page');

const { boardLinksIn, workdayLinksIn } = await import('./discover-ats.mjs');

// The case this exists for: Commonwealth Fusion's Lever board is `cfsenergy`,
// which no name-derived slug reaches. Its own careers page links straight to it.
check('finds a Lever board behind an unguessable slug',
  boardLinksIn('<a href="https://jobs.lever.co/cfsenergy">Open roles</a>'),
  [{ provider: 'lever', slug: 'cfsenergy' }]);
check('reads the embed form of a Greenhouse board',
  boardLinksIn('<iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe>'),
  [{ provider: 'greenhouse', slug: 'acme' }]);
check('reads a subdomain board', boardLinksIn('https://foo.breezy.hr/p/123-engineer'),
  [{ provider: 'breezy', slug: 'foo' }]);
// A page that merely mentions the vendor must not become a board.
check('the vendor talking about itself is not a board',
  boardLinksIn('Powered by <a href="https://www.ashbyhq.com">Ashby</a>'), []);
check('nothing found in an empty page', boardLinksIn(''), []);
// The same board linked from every card must be probed once, not fifty times.
check('repeated links collapse to one',
  boardLinksIn('a jobs.ashbyhq.com/acme b jobs.ashbyhq.com/acme c jobs.ashbyhq.com/acme'),
  [{ provider: 'ashby', slug: 'acme' }]);

// Workday is a (tenant, instance, site) triple, not a slug — a careers page
// hands over all three, which is what the two-stage guessing probe spends
// dozens of requests reconstructing.
check('reads a Workday triple, localisation segment and all',
  workdayLinksIn('href="https://bostondynamics.wd1.myworkdayjobs.com/en-US/Boston_Dynamics/job/Waltham/X_R1"'),
  [{ tenant: 'bostondynamics', instance: 'wd1', site: 'Boston_Dynamics' }]);
// `wday` is the API path prefix; treating it as a site id sends every probe
// at a board that does not exist.
check('the API path prefix is not a site id',
  workdayLinksIn('https://kla.wd1.myworkdayjobs.com/wday/cxs/kla/Search/jobs'), []);
check('no Workday link, no result', workdayLinksIn('<p>we are hiring</p>'), []);

// The curated sites must be usable as-is: resolveViaCareersPage builds a URL
// from each one, and a value it cannot parse is a silent no-op.
const badSites = listHardwareStartups()
  .filter(c => c.url)
  .filter(c => { try { return !new URL(c.url).protocol.startsWith('http'); } catch { return true; } })
  .map(c => c.name);
check('every curated site parses as an http(s) URL', badSites, []);


console.log('\n🧪 discover-ats: the mid- and small-cap index');

const { parseWikiConstituents } = await import('./discover-ats.mjs');

const WIKI = `<html><table id="constituents"><tbody>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th><th>GICS Sub-Industry</th></tr>
<tr><td><a href="/x">AA</a></td><td><a href="/y">Alcoa</a></td><td>Materials</td><td>Aluminum</td></tr>
<tr><td>RRX</td><td>Regal Rexnord</td><td>Industrials</td><td>Electrical Components</td></tr>
<tr><td>GTLS</td><td>Chart Industries &amp; Co</td><td>Industrials</td><td>Machinery</td></tr>
</tbody></table></html>`;

const rows = parseWikiConstituents(WIKI);
check('reads every constituent row', rows.length, 3);
check('the header row is not a company', rows.map(r => r.name).includes('Security'), false);
check('markup inside a cell is stripped', rows[0], { ticker: 'AA', name: 'Alcoa', sector: 'Materials' });
check('the sector comes through for filtering', rows[1].sector, 'Industrials');
check('HTML entities are decoded', rows[2].name, 'Chart Industries & Co');

// A page without the table must not read as an index of zero companies —
// that is the a16z failure (F-417) in a different costume.
check('a page with no constituents table yields nothing',
  parseWikiConstituents('<html><p>This list has moved.</p></html>'), []);
check('an empty page yields nothing', parseWikiConstituents(''), []);
check('a non-string yields nothing', parseWikiConstituents(null), []);
// A rebalance can list the same company twice on one page.
check('a repeated company is listed once', parseWikiConstituents(
  WIKI.replace('</tbody>', '<tr><td>AA</td><td>Alcoa</td><td>Materials</td></tr></tbody>')
).length, 3);
// Rows too short to carry (ticker, name, sector) are navigation, not data.
check('a short row is not a company',
  parseWikiConstituents('<table id="constituents"><tr><td>next page</td></tr></table>'), []);


console.log('\n🧪 discover-ats: iCIMS, the board you cannot guess');

// iCIMS subdomains are abbreviations no name-mangling reaches — Parker
// Hannifin runs `careers-parker`, Aurora Innovation runs `careers-aurora`. A
// naive slug probe scored 0 hits across 60 mid-caps. Reading the link off the
// careers page is the only route, so the reader has to recognise the shape.
check('reads an iCIMS board off a careers page',
  boardLinksIn('<a href="https://careers-jobyaviation.icims.com/jobs/search">Careers</a>'),
  [{ provider: 'icims', slug: 'careers-jobyaviation' }]);
check('reads it from a bare posting URL',
  boardLinksIn('https://careers-parker.icims.com/jobs/12/engineer/job'),
  [{ provider: 'icims', slug: 'careers-parker' }]);
// "Powered by iCIMS" is on a great many careers pages; the vendor's own site
// is not a customer board.
check('the vendor site is not a board',
  boardLinksIn('Powered by <a href="https://www.icims.com">iCIMS</a>'), []);
// One board linked from every job card must be probed once.
check('repeated iCIMS links collapse',
  boardLinksIn('a careers-acme.icims.com b careers-acme.icims.com'),
  [{ provider: 'icims', slug: 'careers-acme' }]);


console.log('\n🧪 discover-ats: the clearance gate reads every identifier');

const { isClearanceGated } = await import('./discover-ats.mjs');

// THE BREACH (F-434). Names derived from domains lose punctuation, and the
// gate was matching on the pretty name only — so Overland AI, a defence
// autonomy company ON the gate list, was tracked and scanned as "Overland".
check('the pretty name alone would have missed it', isClearanceGated('Overland'), false);
check('…but the domain it came from does not',
  isClearanceGated('Overland', 'https://overland-ai.com'), true);
check('…and neither does the resolved board URL',
  isClearanceGated('Overland', 'https://ats.rippling.com/overland-ai/jobs'), true);

// Punctuation is exactly what a domain strips, so the comparison must ignore it.
check('hyphenated', isClearanceGated('overland-ai'), true);
check('underscored', isClearanceGated('overland_ai'), true);
check('run together', isClearanceGated('OverlandAI'), true);
check('spaced and capitalised', isClearanceGated('Overland AI'), true);

// The primes, however they are written.
check('Lockheed', isClearanceGated('Lockheed Martin'), true);
check('a Workday board URL', isClearanceGated('X', 'https://northropgrumman.wd1.myworkdayjobs.com/Careers'), true);
check('Anduril by domain', isClearanceGated('Anduril'), true);

// It must not swallow companies he SHOULD see. Space and energy startups are
// deliberately not gated — their ITAR postings get hard-blocked one at a time,
// with the quote, so the applyable minority still reaches him.
check('a space startup is not gated', isClearanceGated('Stoke Space', 'https://stokespace.com'), false);
check('a fusion startup is not gated', isClearanceGated('Commonwealth Fusion Systems', 'https://cfs.energy'), false);
check('a robotics startup is not gated', isClearanceGated('Cowboyspace', 'https://cowboyspace.com'), false);

// Empty input is not a match, or every unnamed entry would be dropped.
check('nothing is not gated', isClearanceGated('', '', undefined), false);
check('no arguments at all', isClearanceGated(), false);


console.log('\n🧪 discover-ats: the gate must not over-match either (F-440)');

// Flattening punctuation fixed the domain case (F-434) and broke the opposite
// one: MosaicML contains "saic", Axoni contains "axon". An AI company and a
// fintech were both refused as defence contractors. A gate that wrongly
// EXCLUDES costs him jobs as surely as one that wrongly admits them.
check('MosaicML is not SAIC', isClearanceGated('MosaicML'), false);
check('Axoni is not Axon', isClearanceGated('Axoni'), false);
check('a word merely containing "caci" is not CACI', isClearanceGated('Efficacies Inc'), false);

// …while the short terms still catch the real thing, on a word boundary.
check('SAIC itself', isClearanceGated('SAIC'), true);
check('Axon Enterprise', isClearanceGated('Axon Enterprise'), true);
check('CACI International', isClearanceGated('CACI International'), true);
check('RTX', isClearanceGated('RTX'), true);
check('a short term on a domain boundary', isClearanceGated('X', 'https://saic.com/careers'), true);

// A distinctive term still reaches through a domain, where there is no
// boundary to sit on at all.
check('northrop inside a Workday hostname',
  isClearanceGated('X', 'https://northropgrumman.wd1.myworkdayjobs.com/Careers'), true);

// And the companies he SHOULD see stay visible — the whole point of caring.
for (const [n, s] of [['Stoke Space', 'https://stokespace.com'],
                      ['Pacific Fusion', 'https://www.pacificfusion.com/'],
                      ['Atom Computing', ''],
                      ['Commonwealth Fusion Systems', 'https://cfs.energy']]) {
  check(`${n} is not gated`, isClearanceGated(n, s), false);
}


console.log('');
console.log('🧪 the branded iCIMS careers-home board (F-454)');
// The gated host (F-448) answers 405 to everything, so probeIcims finds
// nothing for eleven tracked employers. Their candidates use a branded Angular
// app on the company's own domain instead, backed by /api/jobs. The risk in
// probing that path is a false positive: plenty of sites answer /api/jobs with
// something, and filing a stranger's endpoint as an employer's board is worse
// than finding no board at all.
{
  const real = { count: 746, jobs: [{ data: { req_id: '31277', title: 'Continuous Improvement Partner' } }] };
  check('a real careers-home payload is recognised', isCareersHomePayload(real), true);
  check('slug instead of req_id still counts', isCareersHomePayload({ count: 2, jobs: [{ data: { slug: '31277', title: 'T' } }] }), true);

  check('an empty board is not a board', isCareersHomePayload({ count: 0, jobs: [] }), false);
  check('an array merely CALLED jobs is refused', isCareersHomePayload({ count: 5, jobs: [{ id: 1, name: 'x' }] }), false);
  check('rows with no title are refused', isCareersHomePayload({ count: 5, jobs: [{ data: { req_id: '9' } }] }), false);
  check('rows with no requisition are refused', isCareersHomePayload({ count: 5, jobs: [{ data: { title: 'T' } }] }), false);
  check('a missing count is refused', isCareersHomePayload({ jobs: [{ data: { req_id: '1', title: 't' } }] }), false);
  for (const junk of [null, undefined, {}, 'x', 42, []]) {
    check('junk is refused: ' + JSON.stringify(junk), isCareersHomePayload(junk), false);
  }
}


console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
