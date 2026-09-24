// Tests for the two limits that make a concurrent scan safe (F-419).
//
// The scan used to walk every tracked company one at a time. Making it
// concurrent is only correct if three things hold, and each is checked here
// against behaviour rather than implementation:
//
//   1. the report keeps INPUT order, or a per-company summary shuffles between
//      runs and stops being diffable;
//   2. no more than `limit` companies are ever in flight;
//   3. no more than `perHost` requests ever hit ONE SERVICE — the limit that
//      actually matters, and the one this got wrong first. Keying it on the
//      hostname looked right and let eleven Recruitee subdomains run at once
//      against a single shared rate limiter; the key has to be the registrable
//      domain (F-421).

import { mapPool, hostOf, makeHostLimiter, registrableDomain } from './scan.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const tick = () => new Promise(r => setTimeout(r, 5));

console.log('\n🧪 scan: the work pool');

// Deliberately finishes in reverse: if results were pushed as they completed,
// this is the case that would scramble them.
const backwards = await mapPool([50, 40, 30, 20, 10], 5, async (ms) => {
  await new Promise(r => setTimeout(r, ms));
  return ms;
});
check('results keep INPUT order, not completion order', backwards, [50, 40, 30, 20, 10]);

let live = 0, peak = 0;
await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
  live++; peak = Math.max(peak, live);
  await tick();
  live--;
});
check('never more than `limit` companies in flight at once', peak <= 4, true);
check('…and it actually uses the width it is given', peak, 4);

check('every item is visited exactly once',
  (await mapPool([1, 2, 3, 4, 5], 3, async (n) => n * 2)), [2, 4, 6, 8, 10]);
check('an empty list is not an error', await mapPool([], 8, async () => 1), []);
// A width larger than the work must not spawn idle workers that hang the pool.
check('width larger than the list still returns', await mapPool([1], 16, async (n) => n), [1]);

console.log('\n🧪 scan: the per-host cap');

// THE limit that matters. ~120 tracked companies are served from
// boards-api.greenhouse.io, so a global pool of 10 without this would point ten
// simultaneous requests at one host and earn a 429 that costs more time than
// the parallelism saved.
{
  const withHost = makeHostLimiter(3);
  let n = 0, top = 0;
  await Promise.all(Array.from({ length: 12 }, () => withHost('boards-api.greenhouse.io', async () => {
    n++; top = Math.max(top, n);
    await tick();
    n--;
  })));
  check('one host never exceeds its cap', top, 3);
}

// Two hosts must not share a budget, or a slow Workday tenant would throttle
// every unrelated board queued behind it.
{
  const withHost = makeHostLimiter(2);
  let n = 0, top = 0;
  const run = (host) => withHost(host, async () => { n++; top = Math.max(top, n); await tick(); n--; });
  await Promise.all([
    ...Array.from({ length: 4 }, () => run('a.example')),
    ...Array.from({ length: 4 }, () => run('b.example')),
  ]);
  check('separate hosts get separate budgets', top, 4);
}

// A provider that throws must release its slot, or one bad board wedges every
// other company on that host for the rest of the run.
{
  const withHost = makeHostLimiter(1);
  await withHost('x.example', async () => { throw new Error('provider blew up'); }).catch(() => {});
  let ran = false;
  await withHost('x.example', async () => { ran = true; });
  check('a throwing fetch releases its slot', ran, true);
}

// An entry with no host (hostOf returned '') must still run, uncapped, rather
// than queueing forever behind an empty key.
{
  const withHost = makeHostLimiter(1);
  check('a company with no host is not blocked', await withHost('', async () => 'ran'), 'ran');
}

console.log('\n🧪 scan: what the cap is keyed on');

// THE CORRECTION THAT MADE THE POOL SAFE (F-421). This was first keyed on the
// full hostname, which looked right and was wrong: Recruitee gives every
// customer its own subdomain, so eleven tracked companies read as eleven
// unrelated hosts and all ran at once — and Recruitee, which has ONE rate
// limiter behind all of them, answered 429 and dropped eight of the eleven.
// The key has to be the service, not the name it answers to.
check('every Recruitee tenant shares one key',
  hostOf({ careers_url: 'https://bego.recruitee.com' })
    === hostOf({ careers_url: 'https://myr.recruitee.com' }), true);
check('…and that key is the service', hostOf({ careers_url: 'https://bego.recruitee.com' }), 'recruitee.com');
// Workday is the same story: separate tenants, one myworkdayjobs.com in front
// of them. Capping them together is the FEATURE — an earlier version of this
// test asserted the opposite, and asserting it is what let the 429s through.
check('two Workday tenants share one key',
  hostOf({ careers_url: 'https://kla.wd1.myworkdayjobs.com/Search' })
    === hostOf({ careers_url: 'https://nvidia.wd5.myworkdayjobs.com/Search' }), true);
// Unrelated services must NOT share a budget, or one slow ATS throttles them all.
check('different ATSes keep separate keys',
  hostOf({ careers_url: 'https://jobs.ashbyhq.com/a' })
    !== hostOf({ careers_url: 'https://jobs.lever.co/a' }), true);

// `api` wins over `careers_url` because that is the URL the provider actually
// calls — though both resolve to greenhouse.io, so this only shows up when the
// two fields point at genuinely different services.
check('the API URL is preferred', hostOf({
  api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
  careers_url: 'https://job-boards.greenhouse.io/acme',
}), 'greenhouse.io');
check('falls back to the careers page', hostOf({ careers_url: 'https://jobs.ashbyhq.com/acme' }), 'ashbyhq.com');
check('keys are compared lowercase', hostOf({ careers_url: 'https://Jobs.Lever.CO/acme' }), 'lever.co');
// Two labels is right for .com/.io/.hr/.co, but not for a multi-part suffix —
// there, two labels would collapse every unrelated .co.uk employer into one
// bucket and throttle them against each other.
check('a multi-part suffix keeps the company label',
  registrableDomain('careers.example.co.uk'), 'example.co.uk');
check('a bare domain is already registrable', registrableDomain('lever.co'), 'lever.co');

// An entry with no usable URL must still yield a key the limiter tolerates,
// and must never throw.
check('an entry with no URL yields no host', hostOf({}), '');
check('an unparseable URL yields no host', hostOf({ careers_url: 'not a url' }), '');
check('a null entry yields no host', hostOf(null), '');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
