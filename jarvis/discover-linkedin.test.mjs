// jarvis/discover-linkedin.test.mjs — the LinkedIn company index.
//
// Everything here is pure: parsing a served fragment, keying a company name,
// and deciding which names are new. The network is a stub. What is being
// protected is the two ways this script can be quietly wrong — returning zero
// rows because the markup moved (which looks like "LinkedIn had nothing"), and
// re-reporting companies we already track because the name is spelled
// differently (which buries the real finds).

import {
  parseSearchPage, companyKey, newCompanies, searchUrl, harvest,
  NEVER_TRACK, DEFAULT_QUERIES,
} from './discover-linkedin.mjs';

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.error(`  ✗ ${what}\n      got  ${a}\n      want ${b}`);
};
const ok = (what, cond) => check(what, !!cond, true);

// A real fragment, trimmed: two cards as LinkedIn serves them to a logged-out
// visitor. The bare <li> with a stray doctype is not a mistake in the fixture —
// it is what the endpoint actually returns, and it is why this is parsed with
// string work instead of a DOM.
const FRAGMENT = `<!DOCTYPE html>
      <li>
      <div class="base-card relative w-full base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4450378663" data-impression-id="jobs-search-result-0">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/mechanical-engineer-at-freeform-4450378663?refId=abc">
        <span class="sr-only"> Mechanical Engineer </span></a>
        <div class="base-search-card__info">
          <h3 class="base-search-card__title"> Mechanical Engineer (New Grad December 2026) </h3>
          <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/freeformfuture">Freeform</a></h4>
          <div class="base-search-card__metadata">
            <span class="job-search-card__location"> Los Angeles, CA </span>
            <time class="job-search-card__listdate--new" datetime="2026-09-19">1 day ago</time>
          </div>
        </div>
      </div>
      </li>
      <li>
      <div class="base-card relative w-full base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4460396350">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/manufacturing-engineer-i-at-phoenix-tailings-4460396350">
        </a>
        <div class="base-search-card__info">
          <h3 class="base-search-card__title"> Manufacturing Engineer I &amp; Tooling </h3>
          <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/phoenix-tailings">Phoenix Tailings</a></h4>
          <div class="base-search-card__metadata">
            <span class="job-search-card__location"> Exeter, NH </span>
            <time datetime="2026-09-19">1 day ago</time>
          </div>
        </div>
      </div>
      </li>`;

console.log('🧪 discover-linkedin: reading the served fragment');
{
  const rows = parseSearchPage(FRAGMENT);
  check('both cards are found', rows.length, 2);
  check('id comes from the entity URN', rows[0].id, '4450378663');
  check('title', rows[0].title, 'Mechanical Engineer (New Grad December 2026)');
  check('company', rows[0].company, 'Freeform');
  check('location', rows[0].loc, 'Los Angeles, CA');
  check('posted date', rows[0].posted, '2026-09-19');
  check('the tracking query string is dropped from the url',
    rows[0].url, 'https://www.linkedin.com/jobs/view/mechanical-engineer-at-freeform-4450378663');
  // "Engineer I & Tooling" arrives as "I &amp; Tooling". A title that keeps the
  // entity reads wrong everywhere it is shown and breaks title matching against
  // the store.
  check('HTML entities are decoded', rows[1].title, 'Manufacturing Engineer I & Tooling');
}

// The failure this file exists for. When LinkedIn changes its markup the parser
// returns [], harvest() reads that as "past the last page" and stops, and the
// whole run reports a cheerful zero. An empty parse must be distinguishable
// from an empty result, so the shape is asserted rather than the count alone.
console.log('🧪 discover-linkedin: markup that does not match yields nothing, not garbage');
check('a page with no cards is empty', parseSearchPage('<html><body>Sign in to continue</body></html>'), []);
check('empty input is empty', parseSearchPage(''), []);
check('a card with no id is skipped', parseSearchPage('data-entity-urn="urn:li:jobPosting:"><h3 class="base-search-card__title">X</h3>'), []);

console.log('🧪 discover-linkedin: the search URL asks for what he can actually take');
{
  const u = new URL(searchUrl('robotics engineer', { start: 20, days: 7 }));
  check('query', u.searchParams.get('keywords'), 'robotics engineer');
  check('United States', u.searchParams.get('geoId'), '103644278');
  // '1,2' until 2026-09-20. This script harvests COMPANY NAMES, and the level
  // of the posting that revealed a company says nothing about its board — the
  // narrow filter hid 95 companies on a single search (F-509).
  check('internship through mid-senior, never director or executive', u.searchParams.get('f_E'), '1,2,3,4');
  check("'any' level drops the filter", new URL(searchUrl('x', { levels: '' })).searchParams.has('f_E'), false);
  const metro = new URL(searchUrl('x', { place: { name: 'Greater Pittsburgh Region', location: 'Greater Pittsburgh Region' } }));
  check('a metro is asked for by name', metro.searchParams.get('location'), 'Greater Pittsburgh Region');
  check('…and never carries the country id with it', metro.searchParams.has('geoId'), false);
  check('newest first', u.searchParams.get('sortBy'), 'DD');
  // f_TPR is seconds, not days. Passing days straight through asks for the last
  // seven SECONDS and returns nothing at all — a silent empty run.
  check('the age window is expressed in seconds', u.searchParams.get('f_TPR'), 'r604800');
  check('paging', u.searchParams.get('start'), '20');
}

console.log('🧪 discover-linkedin: a company we already track is not re-reported');
{
  const postings = [
    { company: 'Vast, Inc.', title: 'Tooling Engineer I', loc: 'Long Beach, CA' },
    { company: 'Freeform', title: 'Mechanical Engineer', loc: 'Los Angeles, CA' },
  ];
  // portals.yml spells it "Vast". The posting spells it "Vast, Inc.". Without
  // normalisation this reports a tracked company as a new find every week.
  const fresh = newCompanies(postings, ['Vast', 'Applied Materials']);
  check('only the genuinely new company is reported', fresh.map(c => c.name), ['Freeform']);
  check('legal-form words do not create a second company', companyKey('Vast, Inc.'), companyKey('Vast'));
  check('case and spacing do not either', companyKey('Applied  MATERIALS'), companyKey('applied materials'));
  // "&" is a word, not punctuation. Dropping it turns one employer into two.
  check('an ampersand reads as "and"', companyKey('Kulicke & Soffa'), companyKey('Kulicke and Soffa'));
  // …but normalisation must not be so aggressive that two real companies
  // collide, which would hide one of them permanently.
  ok('different companies keep different keys', companyKey('Radiant') !== companyKey('Radiance'));
  ok('a shared first word is not a match', companyKey('Impulse Space') !== companyKey('Impulse'));
}

console.log('🧪 discover-linkedin: ranking and thresholds');
{
  const postings = [
    { company: 'Alpha', title: 'Mechanical Engineer', loc: 'Austin, TX' },
    { company: 'Alpha', title: 'Process Engineer', loc: 'Austin, TX' },
    { company: 'Alpha', title: 'Test Engineer', loc: 'Boise, ID' },
    { company: 'Beta', title: 'Robotics Engineer', loc: 'Boston, MA' },
  ];
  const all = newCompanies(postings, []);
  check('the company hiring most comes first', all.map(c => c.name), ['Alpha', 'Beta']);
  check('postings are counted', all[0].count, 3);
  check('sample titles come along for the judgement call', all[0].titles.length, 3);
  check('locations are deduped', all[0].locations, ['Austin, TX', 'Boise, ID']);
  check('--min drops the thin ones', newCompanies(postings, [], { min: 2 }).map(c => c.name), ['Alpha']);
}

console.log('🧪 discover-linkedin: who is never worth tracking');
{
  // Agencies relist other companies' jobs under their own name: tracking one
  // adds duplicates with a worse apply path and no employer behind them.
  for (const n of ['CyberCoders', 'Jobot', 'Insight Global', 'Aerotek', 'Diverse Lynx', 'ABC Staffing Group', 'Tech Recruiters LLC']) {
    ok(`agency filtered: ${n}`, NEVER_TRACK.test(n));
  }
  // Defense primes, for the clearance reason — NOT the export-control reason,
  // which stopped disqualifying anything on 2026-09-19.
  for (const n of ['Lockheed Martin', 'Northrop Grumman', 'SpaceX', 'Blue Origin', 'Raytheon',
    'L3Harris Technologies', 'Anduril Industries', 'Shield AI', 'Firefly Aerospace',
    'Collins Aerospace', 'Rocket Lab', 'MIT Lincoln Laboratory']) {
    ok(`defense prime filtered: ${n}`, NEVER_TRACK.test(n));
  }
  // Weapons manufacture, caught on the live import of 2026-09-19 — four of
  // these reached the store before the filter named them.
  for (const n of ['SIG SAUER, Inc.', 'Twenty-Six Defense', 'Phoenix Defense, LLC.', 'GM Defense',
    'Smith & Wesson', 'Sturm, Ruger & Co.', 'Vista Outdoor']) {
    ok(`weapons filtered: ${n}`, NEVER_TRACK.test(n));
  }
  // …and the false positive that came with it: an unanchored "ammo" matched
  // "Mammoth Brands", a consumer goods company with no weapons connection.
  for (const n of ['Mammoth Brands', 'Colton Industries', 'Defensive Driving School LLC']) {
    ok(`not a weapons company: ${n}`, !NEVER_TRACK.test(n));
  }

  // The companies export control used to hide must NOT be filtered here. Moving
  // them from one blocklist to another would undo the 2026-09-19 change without
  // anything in visa.mjs looking wrong.
  for (const n of ['Radiant', 'Vast', 'Impulse Space', 'Astrolab', 'Hadrian', 'Layup Parts']) {
    ok(`export-controlled but kept: ${n}`, !NEVER_TRACK.test(n));
  }
  // The expensive direction: a real employer caught by an over-broad pattern is
  // one we never discover and never notice missing.
  for (const n of ['Applied Materials', 'Radiant', 'Vast', 'Formlabs', 'Zipline', 'Standard Bots',
    'Intuitive Surgical', 'Micron Technology', 'Phoenix Tailings', 'Freeform', 'Lam Research',
    'KLA', 'ASML', 'Teradyne', 'Rivian', 'Lucid Motors', 'Archer Aviation', 'Atomic Machines']) {
    ok(`kept: ${n}`, !NEVER_TRACK.test(n));
  }
  check('a filtered company never reaches the report',
    newCompanies([{ company: 'CyberCoders', title: 'Mechanical Engineer', loc: 'Remote' }], []).length, 0);
}

console.log('🧪 discover-linkedin: paging stops instead of spinning');
{
  // Two pages of results then an empty one. The harvester must stop at the
  // empty page rather than requesting all eight, and must not double-count a
  // posting that appears under two different searches.
  const pages = [FRAGMENT, FRAGMENT, ''];
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, text: async () => pages[Math.min(calls++, pages.length - 1)] });
  const { postings, requests } = await harvest(['a', 'b'], { pages: 8, fetchImpl, pause: async () => {} });
  // Query "a" walks pages 0,1,2 and stops on the empty third; query "b" gets the
  // clamped empty page and stops on its first. Four requests, not the sixteen an
  // unbounded run would make — the empty page is the stop signal, and without it
  // every query costs the full page budget against a rate limiter.
  check('stopped on the empty page instead of spending the page budget', requests, 4);
  check('the same posting under two searches is one company', postings.length, 2);
  check('and it remembers which search found it', postings[0].query, 'a');
}
{
  // A refusal that is NOT a rate limit ends that query and leaves the rest of
  // the run alone.
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? { ok: false, status: 400, text: async () => '' } : { ok: true, text: async () => FRAGMENT });
  const { postings, errors, throttled } = await harvest(['a', 'b'], { pages: 2, fetchImpl, pause: async () => {} });
  check('the refusal is counted', errors, 1);
  ok('the next query still runs', postings.length > 0);
  check('and it is not mistaken for a rate limit', throttled, false);
}

console.log('🧪 discover-linkedin: a rate limit is waited out, never mistaken for the end (F-509)');
{
  // One 429, then LinkedIn opens again. The SAME page must be asked again —
  // the first version broke out of the query here, so a throttled run lost its
  // searches and printed a list that looked complete.
  const urls = [], waits = [];
  let n = 0;
  const fetchImpl = async (u) => { urls.push(u); return ++n === 1 ? { ok: false, status: 429, text: async () => '' } : { ok: true, text: async () => (n === 2 ? FRAGMENT : '') }; };
  const { postings, throttled, unfinished } = await harvest(['a'], { pages: 3, fetchImpl, pause: async (ms) => { waits.push(ms); }, backoff: 1000 });
  check('the page that was refused is the page asked again', urls[0], urls[1]);
  ok('it waited the backoff before asking', waits.includes(1000));
  check('the postings behind the rate limit were not lost', postings.length, 2);
  check('a recovered run is not reported as throttled', throttled, false);
  check('and nothing is left unfinished', unfinished, []);
}
{
  // LinkedIn stays shut. The harvest must stop asking and NAME what never ran.
  const waits = [];
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
  const { throttled, unfinished, requests } = await harvest(['a', 'b', 'c'], { pages: 5, fetchImpl, pause: async (ms) => { waits.push(ms); }, backoff: 1000, retries: 2 });
  check('it says so', throttled, true);
  check('every search that never ran is named', unfinished, ['a', 'b', 'c']);
  check('it stopped asking after the retry budget', requests, 3);
  check('each wait is longer than the last', waits, [1000, 2000]);
}
{
  // Per-metro: the same search, asked once per place, deduped across places.
  const asked = [];
  const fetchImpl = async (u) => { asked.push(new URL(u).searchParams.get('location')); return { ok: true, text: async () => '' }; };
  await harvest(['a'], { places: [{ name: 'X', location: 'X' }, { name: 'Y', location: 'Y' }], fetchImpl, pause: async () => {} });
  check('each place is searched', asked, ['X', 'Y']);
}

console.log('🧪 discover-linkedin: a keyword search is a hint, the title is what was posted (F-528)');
{
  const { worthTracking } = await import('./discover-linkedin.mjs');
  for (const t of ['Mechanical Design Engineer', 'Robotics Build Engineer', 'Prototype Engineer', 'Manufacturing Engineer I', 'Hardware Test Engineer', 'Founding Mechatronics Engineer', 'Equipment Engineer I']) {
    check(`worth tracking: ${t}`, worthTracking(t), true);
  }
  // What "mechanical engineer" per city actually returned on 2026-09-20.
  for (const t of ['Mechanical Engineer - HVAC', 'MEP Design Engineer', 'Plumbing Design Engineer', 'Building Systems Engineer', 'Water/Wastewater Process Engineer', 'Construction Quality Engineer', 'IT Systems Engineer', 'Software Test Engineer', 'Licensed Insurance Agent', 'Hotel Valet Attendant']) {
    check(`not worth tracking: ${t}`, worthTracking(t), false);
  }
  const posts = [
    { company: 'Northwind Mechanical', title: 'Mechanical Engineer - HVAC', loc: 'Denver' },
    { company: 'Northwind Mechanical', title: 'Plumbing Design Engineer', loc: 'Denver' },
    { company: 'Matic Robots', title: 'Mechanical Design Engineer', loc: 'Menlo Park' },
    { company: 'Matic Robots', title: 'Office Manager', loc: 'Menlo Park' },
  ];
  check('relevantOnly keeps the robotics company and drops the builder', newCompanies(posts, [], { relevantOnly: true }).map(c => c.name), ['Matic Robots']);
  check('…and counts only the postings that are the work', newCompanies(posts, [], { relevantOnly: true })[0].count, 1);
  check('without it, everything is reported as before', newCompanies(posts, []).length, 2);
  for (const n of ['The Judge Group', 'Huntington National Bank', 'GEICO', 'Armanino LLP', 'PwC', 'Towne Park']) ok(`never tracked: ${n}`, NEVER_TRACK.test(n));
  for (const n of ['Matic Robots', 'General Robotics', 'Riverbank Robotics', 'Talos Automation']) ok(`kept: ${n}`, !NEVER_TRACK.test(n));
}

console.log('🧪 discover-linkedin: the default searches are role searches');
{
  ok('there are enough of them to cover his shapes of work', DEFAULT_QUERIES.length >= 20);
  // Naming an employer in the query defeats the purpose — this script exists to
  // find companies we cannot name yet.
  const named = DEFAULT_QUERIES.filter(q => /applied materials|tesla|spacex|intel|micron|lam |asml/i.test(q));
  check('no query names a company', named, []);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
