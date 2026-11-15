// jarvis/refusals.test.mjs — a refusing site cools down per host (2026-11-03).
// Run: node jarvis/refusals.test.mjs
import { makeRefusalGate, REFUSALS_TO_COOL, NIGHT_PROBES, isPolicyRefusal } from './refusals.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const CAT = 'https://cat.wd5.myworkdayjobs.com/wday/cxs/cat/CaterpillarCareers/job/1';
const NXP = 'https://nxp.wd3.myworkdayjobs.com/wday/cxs/nxp/Careers/job/2';
const at = (iso) => () => Date.parse(iso);   // local-time ISO (no Z)

console.log('🧪 refusals: a site that refuses cools down, per host');
{
  const g = makeRefusalGate({}, { now: at('2026-11-03T14:00:00') });
  for (let i = 0; i < REFUSALS_TO_COOL; i++) g.refused(CAT);
  g.answered(NXP); g.refused(NXP);
  const { state, cooled } = g.finish();
  eq('three refusals and no answer cools that tenant', cooled.map((c) => c.host), ['cat.wd5.myworkdayjobs.com']);
  eq('a tenant that answered once is not cooled', !!state['nxp.wd3.myworkdayjobs.com'], false);
  const later = makeRefusalGate(state, { now: at('2026-11-03T15:00:00') });
  eq('a cooling tenant is not asked in the day', later.allow(CAT), false);
  eq('…another tenant on the same service still is', later.allow(NXP), true);
  const after = makeRefusalGate(state, { now: at('2026-11-03T20:01:00') });
  eq('after six hours it is asked again', after.allow(CAT), true);
}

console.log('\n🧪 refusals: the cooldown doubles, and one answer clears it');
{
  let st = {};
  const hours = [];
  for (let n = 0; n < 7; n++) {
    const t = Date.parse('2026-11-03T14:00:00') + n * 8 * 86_400_000;
    const g = makeRefusalGate(st, { now: () => t });
    for (let i = 0; i < 5; i++) g.refused(CAT);
    const r = g.finish(); st = r.state;
    hours.push(Math.round((Date.parse(st['cat.wd5.myworkdayjobs.com'].until) - t) / 3_600_000));
  }
  eq('6 h, 12 h, 24 h … capped at 7 days', hours, [6, 12, 24, 48, 96, 168, 168]);
  const g = makeRefusalGate(st, { now: at('2026-12-30T14:00:00') });
  g.answered(CAT);
  const r = g.finish();
  eq('an answer clears the record', [r.cleared, !!r.state['cat.wd5.myworkdayjobs.com']], [['cat.wd5.myworkdayjobs.com'], false]);
}

console.log('\n🧪 refusals: a few probes every night while cooling');
{
  const st = { 'cat.wd5.myworkdayjobs.com': { times: 3, until: '2026-11-06T00:00:00.000Z' } };
  const night = makeRefusalGate(st, { now: at('2026-11-04T02:00:00') });
  let n = 0; while (night.allow(CAT) && n < 100) n++;
  eq(`${NIGHT_PROBES} probes a night`, n, NIGHT_PROBES);
  const day = makeRefusalGate(st, { now: at('2026-11-04T13:00:00') });
  eq('none in the day', day.allow(CAT), false);
  eq('a 429 or a 500 is not a policy refusal', [isPolicyRefusal(403), isPolicyRefusal(429), isPolicyRefusal(503)], [true, false, false]);
}

console.log('\n🧪 refusals: probes do not escalate; shared hosts are keyed by board');
{
  const st = { 'cat.wd5.myworkdayjobs.com': { times: 2, until: '2026-11-04T08:00:00' } };
  const night = makeRefusalGate(st, { now: at('2026-11-04T02:00:00') });
  for (let i = 0; i < NIGHT_PROBES; i++) if (night.allow(CAT)) night.refused(CAT);
  const r = night.finish();
  eq('a refused night probe keeps the cooldown as it was', [r.cooled.length, r.state['cat.wd5.myworkdayjobs.com'].times, r.state['cat.wd5.myworkdayjobs.com'].until], [0, 2, '2026-11-04T08:00:00']);
  const g = makeRefusalGate({}, { now: at('2026-11-03T14:00:00') });
  const A = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1', B = 'https://boards-api.greenhouse.io/v1/boards/zipline/jobs/2';
  for (let i = 0; i < 4; i++) g.refused(A);
  const later = makeRefusalGate(g.finish().state, { now: at('2026-11-03T15:00:00') });
  eq('one Greenhouse board refusing does not cool another', [later.allow(A), later.allow(B)], [false, true]);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
