#!/usr/bin/env node
// jarvis/site-tail.test.mjs — the slug site-tail splitter.
//
// Two copies of this rule exist on purpose: providers/sitemap-jobs.mjs applies
// it while discovering jobs, jarvis/fix-titles.mjs applies it to rows captured
// before it existed. Their comments each claim "the tests cover both" — which
// was not true of anything until this file, and the drift that hid behind that
// claim is the bug below.
//
// humanize() runs an acronym pass that uppercases "Us" to "US" (and "It" to
// "IT") BEFORE the tail regex ever sees the string, so a case-sensitive rule
// listing "Us" could never match the very slugs it was written for. The tail
// then matched from the state code instead and left the country stranded in the
// title: "Manufacturing Engineer 3 US".
//
// Run: `node jarvis/site-tail.test.mjs` (exit 1 on any failure).

import { splitSiteTail as fromProvider } from '../providers/sitemap-jobs.mjs';
import { splitSiteTail as fromRepair } from './fix-titles.mjs';

let pass = 0, fail = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

// Every row runs through BOTH copies, so they cannot drift apart again.
function both(name, title, want) {
  check(`${name} [provider]`, fromProvider(title), want);
  check(`${name} [fix-titles]`, fromRepair(title), want);
}

console.log('🧪 site-tail: country code uppercased by the acronym pass');
both('country + state + town + site number', 'Manufacturing Engineer 3 US Ca Fremont 1003',
  { title: 'Manufacturing Engineer 3', location: 'US CA Fremont' });
both('country + town only', 'Process Engineer US Fremont 1003',
  { title: 'Process Engineer', location: 'US Fremont' });
both('"It" also comes back as "IT"', 'Equipment Engineer IT Milano 2201',
  { title: 'Equipment Engineer', location: 'IT Milano' });

console.log('🧪 site-tail: the forms that already worked stay working');
both('mixed-case country code', 'Test Engineer Cn Xian 1188',
  { title: 'Test Engineer', location: 'CN Xian' });
both('multi-word town', 'Process Engineer De Munich Garching 4021',
  { title: 'Process Engineer', location: 'DE Munich Garching' });

console.log('🧪 site-tail: the mirror shape — country LAST, ZIP instead of a site id');
// 1,213 Eaton reqs arrive as "<title> <City> <State> USA <ZIP>" with an EMPTY
// location column, so the town exists nowhere else. SITE_TAIL cannot see them
// because it keys off a LEADING country code.
both('city, state, USA, ZIP', 'Hazardous Waste Technician Minden Louisiana USA 71055',
  { title: 'Hazardous Waste Technician', location: 'Minden Louisiana USA' });
both('a long title keeps all of itself', 'Senior Embedded Firmware Engineer Raleigh North Carolina USA 27616',
  { title: 'Senior Embedded Firmware Engineer', location: 'Raleigh North Carolina USA' });
both('two-word state', 'Tower Coordinator Weekend Shift Arden North Carolina USA 28704',
  { title: 'Tower Coordinator Weekend Shift', location: 'Arden North Carolina USA' });
both('two-word CITY is kept whole', 'Mov Operator 2nd Shift Olean New York USA 14760',
  { title: 'Mov Operator 2nd Shift', location: 'Olean New York USA' });
both('city and state share a name', 'Design Engineer New York New York USA 10001',
  { title: 'Design Engineer', location: 'New York New York USA' });
both('"Grand" starts a two-word city', 'Process Engineer Grand Rapids Michigan USA 49501',
  { title: 'Process Engineer', location: 'Grand Rapids Michigan USA' });
both('"West Virginia" is not "Virginia"', 'Quality Engineer Charleston West Virginia USA 25301',
  { title: 'Quality Engineer', location: 'Charleston West Virginia USA' });

console.log('🧪 site-tail: what must NOT be split');
both('no tail at all', 'Senior Analyst 4402', null);
both('a title that is only a location keeps its title', 'US Ca Fremont 1003', null);
both('no trailing site number', 'Manufacturing Engineer US Ca Fremont', null);

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
