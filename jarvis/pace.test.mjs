// A day's budget per service (F-437).
//
// The concurrency cap in net-pool.mjs bounds how many requests are in flight.
// It says nothing about how many are sent over an afternoon, and volume is what
// these hosts actually enforce: Micron began refusing after roughly 250
// postings, every *.icims.com host after a few hundred, Workday returned 122
// rate-limits across one long pass. A cap that forgets a request the moment it
// finishes cannot express that, so this remembers across runs.
//
// What has to hold: the budget is real, it resets by the calendar, it survives
// a corrupt or absent file, and running out is never mistaken for a failure.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { makePacer, loadPace, savePace, budgetFor, DAILY_BUDGET, pacePath } from './pace.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-pace-'));
const file = path.join(dir, 'enrich-pace.json');
const today = new Date().toISOString().slice(0, 10);

console.log('\n🧪 pace: the budget is real');

// The hosts that actually pushed back get a tighter budget than the default,
// and that difference is the entire point of the table.
check('a service that refused us is capped below the default',
  budgetFor('myworkdayjobs.com') < DAILY_BUDGET.default, true);
check('so is iCIMS', budgetFor('icims.com') < DAILY_BUDGET.default, true);
check('an unlisted service gets the default', budgetFor('example.com'), DAILY_BUDGET.default);

// Spend right up to a small budget and past it.
{
  savePace(file, { 'icims.com': budgetFor('icims.com') - 2 });
  const p = makePacer(file);
  check('the last two requests are allowed', [p.take('icims.com'), p.take('icims.com')], [true, true]);
  check('the next one is refused', p.take('icims.com'), false);
  check('and the service is named as exhausted', p.exhausted(), ['icims.com']);
  // Running out on one service must not stop a different one.
  check('a different service is unaffected', p.take('greenhouse.io'), true);
}

console.log('\n🧪 pace: what it remembers, and for how long');

{
  savePace(file, { 'a.com': 5 });
  const p = makePacer(file);
  p.take('a.com');
  p.flush();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  check('the tally is written under today\'s date', raw.date, today);
  check('and carries the running count', raw.counts['a.com'], 6);
}

// Yesterday's spending must not be charged against today, or the budget would
// only ever shrink.
{
  writeFileSync(file, JSON.stringify({ date: '2020-01-01', counts: { 'icims.com': 99999 } }));
  check('a tally from another day is ignored', loadPace(file), {});
  const p = makePacer(file);
  check('so today starts with a full budget', p.take('icims.com'), true);
}

console.log('\n🧪 pace: it must never break a run');

{
  writeFileSync(file, 'this is not json{{{');
  check('an unreadable tally reads as empty', loadPace(file), {});
  const p = makePacer(file);
  check('and spending still works', p.take('x.com'), true);
}
check('a missing file reads as empty', loadPace(path.join(dir, 'nope.json')), {});
// A row whose host could not be parsed is not paced — refusing it would stall
// the run on rows no budget applies to.
check('an unknown host is never paced out', makePacer(file).take(''), true);

// Saving somewhere impossible is swallowed: pacing is an optimisation, and a
// read budget that cannot be persisted is still better than a crashed run.
savePace(path.join(dir, 'no', 'such', 'dir', 'x.json'), { a: 1 });
check('an unwritable path does not throw', true, true);

console.log('\n🧪 pace: where the tally lives');
check('beside the store', pacePath('/data/jarvis').replace(/\\/g, '/'), '/data/jarvis/enrich-pace.json');

rmSync(dir, { recursive: true, force: true });
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
