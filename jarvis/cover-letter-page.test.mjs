#!/usr/bin/env node
/**
 * The letter as a page: his letterhead, and the address rule (F-410).
 *
 * The block above "Dear …" is copied from the eleven letters he wrote himself,
 * so these tests are written against those letters rather than against a
 * general idea of what a business letter looks like.
 *
 * Run: node jarvis/cover-letter-page.test.mjs
 */
import { letterDate, letterHead, letterHtml, addressFromJd, locationLine } from './cover-letter-page.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  cond ? pass += 1 : fail += 1;
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

// PLACEHOLDER CONTACT DETAILS, deliberately. His real ones live in
// config/profile.yml, which is gitignored, and `jarvis/backup.test.mjs` fails
// the suite the moment a tracked file carries them. What is under test is the
// SHAPE of the block, which a placeholder proves just as well.
const HIM = {
  full_name: 'Alex Rivera',
  location: 'Springfield, WA',
  phone: '+1 (555) 010-0000',
  email: 'alex@example.com',
};

console.log('🧪 the date, the way every one of his letters writes it');
eq('January 7, 2026', letterDate(new Date(2026, 0, 7)), 'January 7, 2026');
eq('September 8, 2026', letterDate(new Date(2026, 8, 8)), 'September 8, 2026');

console.log('\n🧪 his letterhead, against his own ASM letter');
{
  // The shape of his ASM letter, with the contact lines standing in:
  //   <name> / <city, state> / <phone> / <email>
  //   January 7, 2026
  //   Hiring Manager / ASM / Phoenix, AZ, United States
  //   Dear Hiring Manager,
  const head = letterHead({
    candidate: HIM,
    job: { company: 'ASM', location: 'Phoenix, AZ, United States' },
    jd: 'We make deposition tools.',
    date: new Date(2026, 0, 7),
  });
  eq('his block', head.mine, ['Alex Rivera', 'Springfield, WA', '+1 (555) 010-0000', 'alex@example.com']);
  eq('the date', head.date, 'January 7, 2026');
  eq('theirs', head.theirs, ['Hiring Manager', 'ASM', 'Phoenix, AZ, United States']);
  eq('the greeting', head.greeting, 'Dear Hiring Manager,');
  ok('a missing contact line is left out rather than left blank',
    letterHead({ candidate: { full_name: 'Alex Rivera' }, job: { company: 'X' } }).mine.length === 1);
}

console.log('\n🧪 the location is the POSTING\'s, and the work model is not part of it');
eq('"Hybrid- Fremont, CA"', locationLine('Hybrid- Fremont, CA'), 'Fremont, CA');
eq('"Remote — Austin, TX"', locationLine('Remote — Austin, TX'), 'Austin, TX');
eq('"On-site: Boise, ID"', locationLine('On-site: Boise, ID'), 'Boise, ID');
eq('an ordinary one is untouched', locationLine('Phoenix, AZ, United States'), 'Phoenix, AZ, United States');

console.log('\n🧪 a street address comes from the POSTING or not at all');
{
  // He does not invent addresses and neither does this. An address is used
  // only when the posting gives one AND it sits beside the posting's own city
  // — otherwise a customer site or another office ends up on his letter.
  eq('the posting names its own office',
    addressFromJd('Our Fremont office is at 1234 Balentine Dr. We build robots.', 'Hybrid- Fremont, CA'),
    '1234 Balentine Dr');
  eq('a numbered street too',
    addressFromJd('Report to 5900 S 226th St, Kent, Washington.', 'Kent, WA'), '5900 S 226th St');
  eq('an address for ANOTHER city is not this posting\'s',
    addressFromJd('Our Santa Clara showroom is at 320 Martin Ave.', 'Hybrid- Fremont, CA'), '');
  eq('no address in the posting, no address on the letter',
    addressFromJd('We make deposition tools in Phoenix.', 'Phoenix, AZ'), '');
  eq('an unreadable location decides nothing', addressFromJd('500 Jackson Street, Columbus.', ''), '');
}

console.log('\n🧪 the page itself');
{
  const head = letterHead({ candidate: HIM, job: { company: 'Agility Robotics', location: 'Fremont, CA' }, date: new Date(2026, 8, 8) });
  const html = letterHtml({ head, body: 'First paragraph.\n\nSecond paragraph.' });
  ok('one page of Letter size', /@page \{ size: Letter/.test(html));
  ok('an inch of margin', /padding: 1in/.test(html));
  ok('his name at the top', html.indexOf('Alex Rivera') < html.indexOf('Agility Robotics'));
  ok('the date between the two blocks',
    html.indexOf('September 8, 2026') > html.indexOf(HIM.email) && html.indexOf('September 8, 2026') < html.indexOf('Hiring Manager'));
  ok('both paragraphs, as paragraphs', (html.match(/<p>/g) || []).length === 2);
  ok('and it signs off for him', /Sincerely,<\/div><div>Alex Rivera<\/div>/.test(html));
  ok('a body with markup in it cannot inject any',
    !/<script>/.test(letterHtml({ head, body: '<script>alert(1)</script>' })) );
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
