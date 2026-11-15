// The LinkedIn sweep asks employers hiring in his field lately again after 3
// days, out of the same budget. The shape is Aseon Labs (2026-11-07): swept on
// 10-30, nothing listed, the roles he saw on Jack & Jill posted days later, and
// the next sweep two weeks out.

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openUniverse, ingest, record, sweepDue, linkedinSweep, keyOf, FRESH_SHARE } from './universe.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'fresh-sweep-'));
const db = openUniverse(path.join(dir, 'u.db'));
const DAYMS = 86400e3;
const at = (s) => new Date(s);
const setSwept = (name, listing, checked) => db.prepare('UPDATE employers SET listing = ?, listing_checked = ? WHERE key = ?').run(listing, checked, keyOf(name));
try {
  const t0 = '2026-10-30T00:00:00Z';
  // Named by a LinkedIn harvest on 10-28 (hardware), swept 10-30, nothing listed.
  ingest(db, [{ name: 'Aseon Labs', titles: ['Mechanical Engineer'], count: 2 }], 'linkedin', { now: '2026-10-28T00:00:00Z' });
  // Its last sweep listed hardware postings.
  ingest(db, [{ name: 'Hiring Robotics', titles: ['Robotics Engineer'], count: 5 }], 'lca', { now: '2026-09-01T00:00:00Z' });
  // Hardware, but nothing recent on LinkedIn: the fortnight rule.
  ingest(db, [{ name: 'Quiet Castings', titles: ['Manufacturing Engineer'], count: 9 }], 'lca', { now: '2026-09-01T00:00:00Z' });
  // Not his field, named by LinkedIn lately: the fortnight rule.
  ingest(db, [{ name: 'Office Supply Works', titles: ['Sales Associate'], count: 3 }], 'linkedin', { now: '2026-10-28T00:00:00Z' });
  const names = ['Aseon Labs', 'Hiring Robotics', 'Quiet Castings', 'Office Supply Works'];
  record(db, names.map((name) => ({ name, outcome: 'miss' })), { now: at('2026-10-01T00:00:00Z') });
  setSwept('Aseon Labs', 'none', t0);
  setSwept('Hiring Robotics', 'hiring-hw', t0);
  setSwept('Quiet Castings', 'none', t0);
  setSwept('Office Supply Works', 'none', t0);

  console.log('\n🧪 fresh sweep: who is asked again after 3 days');
  {
    check('inside 3 days, nobody', sweepDue(db, { budget: 300, now: at('2026-11-01T00:00:00Z') }).map((r) => r.name), []);
    const d = sweepDue(db, { budget: 300, now: at('2026-11-03T12:00:00Z') });
    check('after 3 days: the sweep-confirmed hirer first, then the one LinkedIn named lately', d.map((r) => r.name), ['Hiring Robotics', 'Aseon Labs']);
    check('…both marked fresh', d.every((r) => r.fresh), true);
    const later = sweepDue(db, { budget: 300, now: at('2026-11-14T00:00:00Z') });
    check('after a fortnight everyone is due, the fresh ones first', later.map((r) => r.name), ['Hiring Robotics', 'Aseon Labs', 'Quiet Castings', 'Office Supply Works']);
    check('…and nobody twice', new Set(later.map((r) => r.name)).size, later.length);
    // Evidence older than 30 days no longer counts.
    const stale = sweepDue(db, { budget: 300, now: at('2026-12-05T00:00:00Z') });
    check('past the 30-day window: no one is fresh', stale.filter((r) => r.fresh).length, 0);
  }

  console.log('\n🧪 fresh sweep: never above the budget');
  {
    const now = at('2026-11-14T00:00:00Z');
    check('budget 1: one employer, fresh share rounds down to none, so the rotation keeps its slot', sweepDue(db, { budget: 1, now }).map((r) => [r.name, !!r.fresh]), [['Quiet Castings', false]]);
    check('budget 3: two fresh (two-thirds), one from the rotation', sweepDue(db, { budget: 3, now }).map((r) => [r.name, !!r.fresh]),
      [['Hiring Robotics', true], ['Aseon Labs', true], ['Quiet Castings', false]]);
    check('budget 0: nothing', sweepDue(db, { budget: 0, now }), []);
    check('the share is two-thirds', FRESH_SHARE, 2 / 3);
    for (const b of [1, 2, 3, 4, 10]) check(`budget ${b}: at most ${b} asked`, sweepDue(db, { budget: b, now }).length <= b, true);
  }

  console.log('\n🧪 fresh sweep: the sweep itself');
  {
    const asked = [];
    const r = await linkedinSweep(db, {
      budget: 300, now: at('2026-11-03T12:00:00Z'), log: () => {}, importImpl: async () => {},
      harvestImpl: async (q) => { asked.push(q[0]); return { postings: q[0].startsWith('Aseon Labs') ? [{ company: 'Aseon Labs', title: 'Mechanical Engineer' }] : [] }; },
    });
    check('it asks the fresh ones', asked.map((q) => q.replace(/ \w+$/, '')), ['Hiring Robotics', 'Aseon Labs']);
    check('…finds Aseon\'s new posting, and says how many were fresh', [r.counts['hiring-hw'], r.fresh], [1, 2]);
    const row = db.prepare('SELECT listing, listing_checked FROM employers WHERE key = ?').get(keyOf('Aseon Labs'));
    check('…and records it', [row.listing, row.listing_checked.slice(0, 10)], ['hiring-hw', '2026-11-03']);
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// First Mate's review: last_seen moves for ANY source, so it cannot say
// LinkedIn named an employer lately; and the two-thirds cap must bite.
console.log('\n🧪 fresh sweep: only LinkedIn\'s own sighting counts');
{
  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'fresh-sweep-2-'));
  const file = path.join(dir2, 'u.db');
  let u = openUniverse(file);
  try {
    const swept = (name, listing, checked) => u.prepare('UPDATE employers SET listing = ?, listing_checked = ? WHERE key = ?').run(listing, checked, keyOf(name));
    // Named by LinkedIn in August, then re-ingested by the H-1B file and a hiring list in late October.
    ingest(u, [{ name: 'Once Named Corp', titles: ['Mechanical Engineer'] }], 'linkedin', { now: '2026-08-01T00:00:00Z' });
    ingest(u, [{ name: 'Once Named Corp', titles: ['Mechanical Engineer'] }], 'lca', { now: '2026-10-28T00:00:00Z' });
    ingest(u, [{ name: 'Once Named Corp', titles: ['Mechanical Engineer'] }], 'radar', { now: '2026-10-29T00:00:00Z' });
    record(u, [{ name: 'Once Named Corp', outcome: 'miss' }], { now: at('2026-10-01T00:00:00Z') });
    swept('Once Named Corp', 'none', '2026-10-30T00:00:00Z');
    const now = at('2026-11-04T00:00:00Z');
    check('an lca/radar re-ingest of a once-LinkedIn-named employer is not fresh', sweepDue(u, { budget: 300, now }).map((r) => r.name), []);
    ingest(u, [{ name: 'Once Named Corp', titles: ['Mechanical Engineer'] }], 'linkedin', { now: '2026-11-01T00:00:00Z' });
    check('…a LinkedIn sighting this week makes it fresh', sweepDue(u, { budget: 300, now }).map((r) => [r.name, !!r.fresh]), [['Once Named', true]]);

    // An existing ledger gets the column: a row LinkedIn alone ever named starts
    // from its last_seen, a row with other sources waits for LinkedIn's next pass.
    ingest(u, [{ name: 'Only LinkedIn Inc', titles: ['Robotics Engineer'] }], 'linkedin', { now: '2026-10-20T00:00:00Z' });
    ingest(u, [{ name: 'Mixed Sources Inc', titles: ['Robotics Engineer'] }], 'linkedin', { now: '2026-08-01T00:00:00Z' });
    ingest(u, [{ name: 'Mixed Sources Inc', titles: ['Robotics Engineer'] }], 'lca', { now: '2026-10-20T00:00:00Z' });
    u.exec('ALTER TABLE employers DROP COLUMN linkedin_seen');
    u.close();
    u = openUniverse(file);
    const seen = (name) => u.prepare('SELECT linkedin_seen FROM employers WHERE key = ?').get(keyOf(name)).linkedin_seen;
    check('migration: LinkedIn-only row takes its last_seen; a mixed row starts empty',
      [seen('Only LinkedIn Inc'), seen('Mixed Sources Inc')], ['2026-10-20T00:00:00Z', null]);
  } finally {
    u.close();
    rmSync(dir2, { recursive: true, force: true });
  }
}

console.log('\n🧪 fresh sweep: the two-thirds cap bites');
{
  const dir3 = mkdtempSync(path.join(os.tmpdir(), 'fresh-sweep-3-'));
  const u = openUniverse(path.join(dir3, 'u.db'));
  try {
    const hot = ['Alpha Robotics', 'Bravo Robotics', 'Charlie Robotics', 'Delta Robotics', 'Echo Robotics'];
    hot.forEach((name, i) => ingest(u, [{ name, titles: ['Mechanical Engineer'], count: 10 - i }], 'linkedin', { now: '2026-10-28T00:00:00Z' }));
    // The rotation orders by evidence, so this one leads it.
    ingest(u, [{ name: 'Rotation Castings', titles: ['Manufacturing Engineer'], count: 50 }], 'lca', { now: '2026-09-01T00:00:00Z' });
    record(u, [...hot, 'Rotation Castings'].map((name) => ({ name, outcome: 'miss' })), { now: at('2026-10-01T00:00:00Z') });
    const now = at('2026-11-04T00:00:00Z');
    check('five fresh, budget 3: two fresh (the cap), one from the rotation',
      sweepDue(u, { budget: 3, now }).map((r) => [r.name, !!r.fresh]), [['Alpha Robotics', true], ['Bravo Robotics', true], ['Rotation Castings', false]]);
    check('…budget 6: four fresh, and the rotation still keeps its two slots',
      sweepDue(u, { budget: 6, now }).filter((r) => r.fresh).length, 4);
  } finally {
    u.close();
    rmSync(dir3, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
