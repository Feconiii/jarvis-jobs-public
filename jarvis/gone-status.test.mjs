// What counts as "this posting is gone" — the one judgement in this system
// whose generous direction hides live jobs (F-427).
//
// A 5,582-row enrichment pass marked 899 Workday rows dead in one afternoon
// because 403 was trusted as proof of removal. Fourteen were then sampled: the
// CXS API answered 403 and the posting's own page answered 200 for all
// fourteen. Every one was live, and Accenture alone lost 480 rows out of his
// deck without a word.
//
// These assertions exist so that rule cannot come back by accident.

import { isGoneStatus, isRefusal } from './enrich.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 enrich: what proves a posting is gone');

// Unambiguous everywhere: the resource is not there.
check('404 is gone', isGoneStatus(404, 'workday'), true);
check('410 is gone', isGoneStatus(410, 'greenhouse'), true);
check('…on any source', isGoneStatus(404, 'smartrecruiters'), true);

// THE REGRESSION. Workday answers 403 both for a pulled req and for a request
// it does not like the look of, and at volume the second is overwhelmingly
// more common. It must never again be read as an expiry.
check('a Workday 403 is NOT gone', isGoneStatus(403, 'workday'), false);
check('a 403 is not gone on any other source either', isGoneStatus(403, 'greenhouse'), false);

// The network having a bad minute is not an employer taking a job down.
check('429 is not gone', isGoneStatus(429, 'workday'), false);
check('500 is not gone', isGoneStatus(500, 'workday'), false);
check('503 is not gone', isGoneStatus(503, 'greenhouse'), false);
check('200 is obviously not gone', isGoneStatus(200, 'workday'), false);
// A timeout arrives as no status at all.
check('no status is not gone', isGoneStatus(0, 'workday'), false);
check('undefined is not gone', isGoneStatus(undefined, 'workday'), false);


console.log('\n🧪 enrich: what may count as a strike');

// Three strikes puts a row past `enrich_fails < 3` and it is never read again,
// so what counts as a strike decides what becomes permanently unreadable.
// 7,187 live rows were already past that cutoff — Accenture 490, AbbVie 485,
// DaVita 413 — because refusals were being counted (F-429).
check('403 is a refusal, not a strike', isRefusal(403), true);
check('429 is a refusal', isRefusal(429), true);
// 405 is a refusal on EVIDENCE: every *.icims.com host began answering 405 to
// everything — sitemap.xml included — hours after serving 200s. A static XML
// file does not become method-restricted (F-432).
check('405 is a refusal, not a structural answer', isRefusal(405), true);
check('500 is a refusal', isRefusal(500), true);
check('503 is a refusal', isRefusal(503), true);
check('a timeout (no status) is a refusal', isRefusal(0), true);
check('undefined is a refusal', isRefusal(undefined), true);

// Structural failures DO strike: they are facts about the posting or its board
// and will not change on the next pass, so retrying forever is pure cost.
check('404 is not a refusal — it is an answer', isRefusal(404), false);
check('410 is not a refusal', isRefusal(410), false);
check('200 is not a refusal', isRefusal(200), false);

// The two judgements must not overlap: a status cannot be both "the posting is
// gone" and "the host refused us".
for (const s of [403, 429, 500, 0, 404, 410, 200]) {
  check(`${s}: gone and refusal are mutually exclusive`,
    !(isGoneStatus(s, 'workday') && isRefusal(s)), true);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
