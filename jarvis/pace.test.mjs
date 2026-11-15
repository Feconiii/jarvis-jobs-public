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
import { makePacer, loadPace, savePace, budgetFor, DAILY_BUDGET, pacePath, TARGETED_RESERVE, paceKeys, paceLimits, hasAllowance, backlogHeld, FRESH_RESERVE_PCT, FRESH_RELEASE_UTC } from './pace.mjs';

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

console.log('\n🧪 pace: a hand-picked list is not starved by the auto worker');
{
  const f = path.join(dir, 'reserve.json');
  savePace(f, { 'myworkdayjobs.com': DAILY_BUDGET['myworkdayjobs.com'] });   // the auto worker spent the day
  check('the ordinary run is paced out', makePacer(f).take('myworkdayjobs.com'), false);
  const t = makePacer(f, { reserve: 2 });
  check('a targeted run still gets its reserve', [t.take('myworkdayjobs.com'), t.take('myworkdayjobs.com'), t.take('myworkdayjobs.com')], [true, true, false]);
  t.flush();
  check('…counted apart, so the next targeted run sees it spent', makePacer(f, { reserve: 2 }).take('myworkdayjobs.com'), false);
  check('the reserve is a few hundred, not a second budget', TARGETED_RESERVE <= 500, true);
}

console.log('\n🧪 pace: one day per employer site on Workday, iCIMS and Oracle (F-979)');
{
  const svc = (u) => { const h = new URL(u).hostname.split('.'); return h.slice(-2).join('.'); };
  check('a Workday URL is the platform plus its tenant host', paceKeys('https://kla.wd1.myworkdayjobs.com/x', svc), { service: 'myworkdayjobs.com', tenant: 'kla.wd1.myworkdayjobs.com' });
  check('an untenanted service has no tenant', paceKeys('https://boards-api.greenhouse.io/v1/x', svc), { service: 'greenhouse.io', tenant: '' });
  check('an unparseable URL is unpaced', paceKeys('not a url', svc), { service: '', tenant: '' });
  const limits = paceLimits({ pacePerTenant: 3, paceWorkdayCeiling: 5, paceIcimsCeiling: 100, paceOracleCeiling: 100, paceTenantConcurrency: 2 });
  check('his settings become the limits', [limits.perTenant, limits.ceilings['myworkdayjobs.com'], limits.tenantConcurrency], [3, 5, 2]);
  const f = path.join(dir, 'tenant.json');
  const p = makePacer(f, { limits });
  const kla = paceKeys('https://kla.wd1.myworkdayjobs.com/x', svc), nv = paceKeys('https://nvidia.wd5.myworkdayjobs.com/x', svc);
  check('a tenant gets its own day', [p.take(kla), p.take(kla), p.take(kla), p.take(kla)], [true, true, true, false]);
  check('…and a spent tenant does not stop another', p.take(nv), true);
  check('…until the platform ceiling', [p.take(nv), p.take(nv)], [true, false]);
  check('allows() answers without spending', p.allows(paceKeys('https://ge.wd5.myworkdayjobs.com/x', svc)), false);
  check('hasAllowance reads a day\'s counts the same way', hasAllowance(kla, { 'myworkdayjobs.com': 1, 'myworkdayjobs.com@kla.wd1.myworkdayjobs.com': 3 }, limits), false);
  check('an untenanted service keeps its old budget', budgetFor('apple.com', limits), DAILY_BUDGET['apple.com']);
  check('the ceiling replaces Workday\'s shared 1,500', budgetFor('myworkdayjobs.com', limits), 5);
  check('without limits nothing changes', [budgetFor('myworkdayjobs.com'), makePacer(path.join(dir, 'old.json')).take('myworkdayjobs.com')], [DAILY_BUDGET['myworkdayjobs.com'], true]);
  p.flush();
  check('the tenant tally is saved with the day', loadPace(f)['myworkdayjobs.com@kla.wd1.myworkdayjobs.com'], 3);
  const r = makePacer(f, { limits, reserve: 5 });
  check('a targeted run\'s reserve lifts the platform ceiling…', r.take(paceKeys('https://ge.wd5.myworkdayjobs.com/x', svc)), true);
  check('…but never a spent tenant\'s own day', r.take(kla), false);
}

console.log('\n🧪 pace: new postings keep a share of every site\'s day, and the backlog loses nothing over the day (F-1000)');
{
  const svc = (u) => new URL(u).hostname.split('.').slice(-2).join('.');
  const site = paceKeys('https://kla.wd1.myworkdayjobs.com/x', svc);
  const at = (h) => Date.parse(`2026-11-04T${String(h).padStart(2, '0')}:30:00Z`);
  // One simulated UTC day. Each hour the reader can send `rate` requests: new
  // postings waiting first (as freshFirst orders them), then the backlog, which
  // always has more. `arrivals` = { hour: new postings a scan found then }.
  const day = ({ pct, arrivals = {}, ceiling = 1000, perTenant = 1000, rate = 150, release = 20 }) => {
    const limits = paceLimits({ paceWorkdayCeiling: ceiling, pacePerTenant: perTenant, paceFreshReservePct: pct, paceFreshReleaseUtc: release });
    const p = makePacer(path.join(dir, `day-${pct}-${Math.random()}.json`), { limits });
    let waiting = [], freshRead = 0, backlogRead = 0;
    const waits = [];
    for (let h = 0; h < 24; h++) {
      for (let i = 0; i < (arrivals[h] || 0); i++) waiting.push(h);
      let sent = 0;
      while (sent < rate && waiting.length && p.take(site, { now: at(h) })) { waits.push(h - waiting.shift()); freshRead++; sent++; }
      while (sent < rate && p.take(site, { backlog: true, now: at(h) })) { backlogRead++; sent++; }
    }
    return { freshRead, backlogRead, unread: waiting.length, maxWait: Math.max(0, ...waits), total: freshRead + backlogRead, held: p.heldForNew() };
  };
  const quiet = [day({ pct: 40 }), day({ pct: 0 })];
  check('a day with no new postings: the backlog reads the whole day, reserve or not', quiet.map((d) => d.backlogRead), [1000, 1000]);
  const arrivals = { 2: 80, 9: 120, 15: 150 };   // the scans of 2026-11-04: 02:40, 09:26, 15:24 UTC
  const before = day({ pct: 0, arrivals }), after = day({ pct: 40, arrivals });
  check('without the reserve the backlog spends the day by mid-morning and the 15:00 scan\'s rows wait for tomorrow',
    [before.unread > 0, before.total], [true, 1000]);
  check('with it, every new posting found before the release hour is read the hour it arrives', [after.unread, after.maxWait], [0, 0]);
  check('…the day is still spent in full', after.total, 1000);
  check('…and the backlog gives up only what new postings read', after.backlogRead, 1000 - after.freshRead);
  check('…the site is named as held for new postings', after.held, ['kla.wd1.myworkdayjobs.com']);
  // The same hold on one employer site's own day (F-979), under a roomy platform ceiling.
  const tenantDay = day({ pct: 40, arrivals: { 15: 30 }, ceiling: 10000, perTenant: 150 });
  check('an employer site keeps 40% of its own 150 for new postings: they are read at 15:00, the backlog takes the rest at release',
    [tenantDay.unread, tenantDay.freshRead, tenantDay.backlogRead], [0, 30, 120]);
  // The rules around it.
  const limits = paceLimits({ paceFreshReservePct: 40, paceFreshReleaseUtc: 20 });
  check('a backlog row stops at 60% before the release hour…', hasAllowance({ service: 'apple.com', tenant: '' }, { 'apple.com': 240 }, limits, { backlog: true, now: at(10) }), false);
  check('…a new posting does not', hasAllowance({ service: 'apple.com', tenant: '' }, { 'apple.com': 240 }, limits, { now: at(10) }), true);
  check('…and from the release hour the backlog may spend the rest', hasAllowance({ service: 'apple.com', tenant: '' }, { 'apple.com': 240 }, limits, { backlog: true, now: at(20) }), true);
  check('the existing ceiling still binds both', [hasAllowance({ service: 'apple.com', tenant: '' }, { 'apple.com': 400 }, limits, { now: at(10) }), hasAllowance({ service: 'apple.com', tenant: '' }, { 'apple.com': 400 }, limits, { backlog: true, now: at(21) })], [false, false]);
  check('without limits (or at 0%) nothing is held', [backlogHeld({ service: 'apple.com' }, { 'apple.com': 399 }, null, at(10)), backlogHeld({ service: 'apple.com' }, { 'apple.com': 399 }, paceLimits({ paceFreshReservePct: 0 }), at(10))], [false, false]);
  check('his settings default to 40% until 20:00 UTC', [paceLimits({}).freshReservePct, paceLimits({}).freshReleaseUtc, FRESH_RESERVE_PCT, FRESH_RELEASE_UTC], [40, 20, 40, 20]);
  // A held backlog request is not a spent day: it never dips into a hand-picked list's reserve.
  const f = path.join(dir, 'held-reserve.json');
  savePace(f, { 'apple.com': 240 });
  const t = makePacer(f, { reserve: 5, limits });
  check('a held backlog request is refused without spending the targeted reserve', [t.take('apple.com', { backlog: true, now: at(10) }), t.totals()['apple.com#reserve'] ?? 0, t.exhausted()], [false, 0, []]);
}

console.log('\n🧪 pace: where the tally lives');
check('beside the store', pacePath('/data/jarvis').replace(/\\/g, '/'), '/data/jarvis/enrich-pace.json');

rmSync(dir, { recursive: true, force: true });
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
