// Tests for the coverage ledger (universe.mjs) and the branded-board finder
// (branded-boards.mjs). Names are the ones the 2026-10-03 pass met: H-1B legal
// names against portals.yml spellings, and the careers hosts Garmin, Texas
// Instruments and Honeywell actually run.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  nameTokens, keyOf, plainName, aliasesOf, trackedIndex, matchTracked, openUniverse,
  ingest, sync, due, record, coverage, coverageLine, replayLeftovers, lookupSite, linkedinSweep, setMeta, splitShared,
} from './universe.mjs';
import { baseDomain, careerOrigins, orcLinksIn, pageUpLinksIn, platformOf } from './branded-boards.mjs';
import { ukgBase, ukgBoardsIn, parseUkgResponse } from '../providers/ukg.mjs';
import { adpIds, adpCentersIn, parseAdpResponse, adpDetailApi } from '../providers/adp.mjs';
import { paylocityBoard, paylocityBoardsIn, parsePaylocityPage } from '../providers/paylocity.mjs';
import { ukgPosting } from './embedded-posting.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 universe: names');
{
  check('legal suffixes go', plainName('Rivian Automotive, LLC'), 'Rivian Automotive');
  check('…stacked ones too', plainName('Intuitive Surgical Operations, Inc.'), 'Intuitive Surgical Operations');
  check('a leading "The" stays in the plain name', plainName('The Boeing Company'), 'The Boeing');
  check('& reads as and', nameTokens('Kulicke & Soffa'), ['kulicke', 'and', 'soffa']);
  check('key ignores case and suffix', keyOf('FORD MOTOR COMPANY'), keyOf('Ford Motor'));
  check('a parenthesised name is an alias', aliasesOf('Alphabet (Google)').map((t) => t.join('')), ['alphabetgoogle', 'alphabet', 'google']);
  check('a dash-suffixed entry answers to its head', aliasesOf('Intuitive Surgical — Manufacturing/Process/Quality Engineer').some((t) => t.join('') === 'intuitivesurgical'), true);
  check('a slash joins two names', aliasesOf('Teradyne / Universal Robots').some((t) => t.join('') === 'universalrobots'), true);
}

console.log('\n🧪 universe: matching the H-1B spelling to the tracked one');
{
  const idx = trackedIndex([
    { name: 'Rivian' }, { name: 'Intuitive Surgical' }, { name: 'Apple' }, { name: 'Arm' },
    { name: 'Alphabet (Google)' }, { name: 'Raydar', enabled: false }, { name: 'Applied Materials' },
  ]);
  check('Rivian Automotive is the tracked Rivian', matchTracked('Rivian Automotive, LLC', idx)?.name, 'Rivian');
  check('LinkedIn\'s "Intuitive" is Intuitive Surgical', matchTracked('Intuitive', idx)?.name, 'Intuitive Surgical');
  check('Google LLC is Alphabet (Google)', matchTracked('Google LLC', idx)?.name, 'Alphabet (Google)');
  check('Apple Inc. is Apple', matchTracked('Apple Inc.', idx)?.name, 'Apple');
  check('Applebee\'s is NOT Apple — words, not characters', matchTracked("Applebee's", idx), null);
  check('a three-letter name does not swallow its prefix family', matchTracked('Arm Robotics Fabrication', idx), null);
  check('…but is still itself', matchTracked('Arm, Inc.', idx)?.name, 'Arm');
  check('a disabled entry is matched, and says so', matchTracked('Raydar', idx)?.enabled, false);
  check('Applied Intuition is not Applied Materials', matchTracked('Applied Intuition', idx), null);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'universe-test-'));
try {
  const db = openUniverse(path.join(dir, 'u.db'));

  console.log('\n🧪 universe: ingest and state');
  {
    const r = ingest(db, [
      { name: 'Garmin International, Inc.', titles: ['Mechanical Engineer 2'], count: 30 },
      { name: 'Rivian Automotive, LLC', titles: ['Manufacturing Engineer'], count: 377 },
      { name: 'Hartwell Civil Partners Inc.', titles: ['Civil Engineer'], count: 128 },
      { name: 'CyberCoders', titles: ['Mechanical Engineer'] },
    ], 'lca');
    check('a staffing shop is never added', r, { added: 3, seen: 0, skipped: 1 });
    const again = ingest(db, [{ name: 'Garmin International', titles: ['Test Engineer'], count: 5 }], 'linkedin');
    check('the same employer from a second source is seen, not added', again, { added: 0, seen: 1, skipped: 0 });
    const g = db.prepare("SELECT sources, evidence, hardware FROM employers WHERE key = ?").get(keyOf('Garmin International'));
    check('…and carries both sources and the stronger evidence', [g.sources, g.evidence, g.hardware], ['lca,linkedin', 30, 1]);
    check('civil work is not hardware evidence', db.prepare("SELECT hardware FROM employers WHERE key = ?").get(keyOf('Hartwell Civil Partners')).hardware, 0);
    const changed = sync(db, [{ name: 'Rivian' }]);
    check('sync marks the tracked one', changed, 1);
    check('hardware employers come first, then by evidence', due(db).map((r) => r.name), ['Garmin International', 'Hartwell Civil Partners']);
  }

  console.log('\n🧪 universe: a name from a curated hiring list matches exactly (F-947)');
  {
    const idx = trackedIndex([{ name: 'Cambium Networks' }, { name: 'Intuitive Surgical' }]);
    check('LinkedIn\'s one-word name still finds its longer tracked form', matchTracked('Intuitive', idx)?.name, 'Intuitive Surgical');
    check('…but a curated list\'s name does not', matchTracked('Cambium', idx, { exact: true }), null);
    check('…and its exact spelling still does', matchTracked('Cambium Networks', idx, { exact: true })?.name, 'Cambium Networks');
    // Its own ledger, so the blocks below see the rows they expect.
    const db2 = openUniverse(path.join(dir, 'u-f947.db'));
    ingest(db2, [{ name: 'Cambium', titles: ['Materials Engineer'], count: 1 }], 'radar');
    ingest(db2, [{ name: 'Intuitive', titles: ['Mechanical Engineer'], count: 4 }], 'linkedin');
    sync(db2, [{ name: 'Cambium Networks' }, { name: 'Intuitive Surgical' }]);
    const st = (n) => db2.prepare('SELECT state, tracked_as FROM employers WHERE key = ?').get(keyOf(n));
    check('Grace Gong\'s Cambium is left to be looked for, not called tracked', st('Cambium').state, 'pending');
    check('LinkedIn\'s Intuitive is tracked as Intuitive Surgical', [st('Intuitive').state, st('Intuitive').tracked_as], ['tracked', 'Intuitive Surgical']);
    db2.close();
  }

  console.log('\n🧪 universe: recording what the resolver settled');
  {
    const now = new Date('2026-10-03T00:00:00Z');
    const counts = record(db, [
      { name: 'Garmin International', outcome: 'tracked', url: 'https://careers.garmin.com', provider: 'icims-careers' },
      { name: 'Hartwell Civil Partners', outcome: 'miss', platform: 'ukg' },
    ], { now });
    check('counts by outcome', counts, { tracked: 1, miss: 1 });
    const w = db.prepare('SELECT state, platform, next_attempt, attempts FROM employers WHERE key = ?').get(keyOf('Hartwell Civil Partners'));
    check('a miss is no-board, named by platform, retried in 30 days', [w.state, w.platform, w.next_attempt.slice(0, 10), w.attempts], ['no-board', 'ukg', '2026-11-02', 1]);
    check('nothing is due before its retry date', due(db, { now: '2026-10-10T00:00:00Z' }).length, 0);
    check('…and it is due after', due(db, { now: '2026-11-03T00:00:00Z' }).map((r) => r.name), ['Hartwell Civil Partners']);
    record(db, [{ name: 'Hartwell Civil Partners', outcome: 'miss' }], { refused: true, now });
    check('a miss while a shared ATS refused comes back in 3 days', db.prepare('SELECT next_attempt FROM employers WHERE key = ?').get(keyOf('Hartwell Civil Partners')).next_attempt.slice(0, 10), '2026-10-06');
    // F-1049: a recheck of a shared-board employer that misses keeps the board it shares.
    {
      const db3 = openUniverse(path.join(dir, 'u-f1049.db'));
      ingest(db3, [{ name: 'Pall', titles: ['Mechanical Engineer'], count: 1 }], 'linkedin');
      record(db3, [{ name: 'Pall', outcome: 'dupe', url: 'https://danaher.wd1.myworkdayjobs.com/DanaherJobs' }], { now });
      record(db3, [{ name: 'Pall', outcome: 'miss' }], { now });
      const pall = db3.prepare('SELECT state, tracked_as, outcome, attempts FROM employers WHERE key = ?').get(keyOf('Pall'));
      check('a shared-board row that misses on a recheck stays tracked through that board',
        [pall.state, pall.tracked_as, pall.outcome, pall.attempts],
        ['tracked', 'board:https://danaher.wd1.myworkdayjobs.com/DanaherJobs', 'same board as a tracked company', 2]);
      record(db3, [{ name: 'Pall', outcome: 'partial', url: 'https://danaher.wd1.myworkdayjobs.com/DanaherJobs', also: 'taleo' }], { now });
      check('…while a second board it finds still makes it partial', db3.prepare('SELECT state FROM employers WHERE key = ?').get(keyOf('Pall')).state, 'partial');
      const rowOf = (n) => db3.prepare('SELECT state, tracked_as, outcome, next_attempt FROM employers WHERE key = ?').get(keyOf(n));
      const pallPartial = rowOf('Pall');
      record(db3, [{ name: 'Pall', outcome: 'miss' }], { now });
      const pallAfter = rowOf('Pall');
      check('a partial shared-board row that misses later stays partial, its outcome kept, back in 14 days',
        [pallAfter.state, pallAfter.outcome, pallAfter.next_attempt.slice(0, 10)], ['partial', pallPartial.outcome, '2026-10-17']);
      // The refused and platform variants of a miss leave a shared row alone too.
      ingest(db3, [{ name: 'Weir Minerals', titles: ['Mechanical Engineer'], count: 1 }, { name: 'Zalkin', titles: ['Design Engineer'], count: 1 }], 'linkedin');
      record(db3, [{ name: 'Weir Minerals', outcome: 'dupe', url: 'https://weir.wd3.myworkdayjobs.com/Weir_External_Careers' },
        { name: 'Zalkin', outcome: 'dupe', url: 'https://promachbuilt.wd108.myworkdayjobs.com/promach' }], { now });
      record(db3, [{ name: 'Weir Minerals', outcome: 'miss' }], { refused: true, now });
      record(db3, [{ name: 'Zalkin', outcome: 'miss', platform: 'ADP MyJobs' }], { now });
      check('a refused miss keeps a shared-board row tracked', [rowOf('Weir Minerals').state, rowOf('Weir Minerals').tracked_as],
        ['tracked', 'board:https://weir.wd3.myworkdayjobs.com/Weir_External_Careers']);
      check('a platform miss keeps a shared-board row tracked', [rowOf('Zalkin').state, rowOf('Zalkin').tracked_as],
        ['tracked', 'board:https://promachbuilt.wd108.myworkdayjobs.com/promach']);
      // A different board found under the name replaces nothing; it becomes a proposal.
      ingest(db3, [{ name: 'Statco-DSI', titles: ['Mechanical Engineer'], count: 1 }, { name: 'Sentry', titles: ['Controls Engineer'], count: 1 }], 'linkedin');
      record(db3, [{ name: 'Statco-DSI', outcome: 'dupe', url: 'https://promachbuilt.wd108.myworkdayjobs.com/promach' },
        { name: 'Sentry', outcome: 'dupe', url: 'https://promachbuilt.wd108.myworkdayjobs.com/promach' }], { now });
      const proposed = [];
      const c = record(db3, [{ name: 'Statco-DSI', outcome: 'tracked', url: 'https://job-boards.greenhouse.io/statco', provider: 'greenhouse', count: 40 },
        { name: 'Sentry', outcome: 'found', url: 'https://jobs.ashbyhq.com/sentry', provider: 'ashby', count: 120 },
        { name: 'Zalkin', outcome: 'dupe', url: 'https://jobs.smartrecruiters.com/uber' }], { now, propose: (p) => proposed.push(p) });
      check('a recheck that finds a different board under the name keeps the shared one',
        [rowOf('Statco-DSI').tracked_as, rowOf('Sentry').tracked_as, rowOf('Zalkin').tracked_as],
        ['board:https://promachbuilt.wd108.myworkdayjobs.com/promach', 'board:https://promachbuilt.wd108.myworkdayjobs.com/promach', 'board:https://promachbuilt.wd108.myworkdayjobs.com/promach']);
      check('…and writes each one down as a proposal', [c.proposed, proposed.map((p) => `${p.name} ${p.found}`)],
        [3, ['Statco-DSI https://job-boards.greenhouse.io/statco', 'Sentry https://jobs.ashbyhq.com/sentry', 'Zalkin https://jobs.smartrecruiters.com/uber']]);
      check('the same shared board found again (dupe, trailing slash) is no proposal',
        record(db3, [{ name: 'Statco-DSI', outcome: 'dupe', url: 'https://promachbuilt.wd108.myworkdayjobs.com/promach/' }], { now, propose: (p) => proposed.push(p) }).proposed, undefined);
      // A row NOT tracked through a shared board still goes to no-board on a miss.
      ingest(db3, [{ name: 'Hartwell Fabrication', titles: ['Mechanical Engineer'], count: 1 }], 'linkedin');
      record(db3, [{ name: 'Hartwell Fabrication', outcome: 'tracked', url: 'https://jobs.lever.co/hartwell' }], { now });
      record(db3, [{ name: 'Hartwell Fabrication', outcome: 'miss' }], { now });
      check('a row tracked on its own board that misses goes to no-board', rowOf('Hartwell Fabrication').state, 'no-board');
      const split = splitShared(db3, [{ name: 'Statco-DSI' }, { name: 'Pall' }, { name: 'Hartwell Fabrication' }, { name: 'Nobody Known' }]);
      check('shared-board names (tracked or partial) are asked without --write; the rest with it',
        [split.shared.map((x) => x.name), split.rest.map((x) => x.name)], [['Statco-DSI', 'Pall'], ['Hartwell Fabrication', 'Nobody Known']]);
      db3.close();
    }
    // F-946: one Workable name held back marked every miss in the run as unreal.
    record(db, [
      { name: 'Hartwell Civil Partners', outcome: 'miss' },
      { name: 'Garmin International', outcome: 'miss' },
      { name: 'Garmin International', outcome: 'unchecked' },
    ], { refused: true, now });
    const nextOf = (n) => db.prepare('SELECT next_attempt FROM employers WHERE key = ?').get(keyOf(n)).next_attempt.slice(0, 10);
    check('only the name never checked comes back in 3 days', nextOf('Garmin International'), '2026-10-06');
    check('…a checked miss in the same run waits the full 30', nextOf('Hartwell Civil Partners'), '2026-11-02');
    // A run that says it named its unchecked names, and named none: every miss is real.
    record(db, [{ name: '', outcome: 'unchecked-listed' }, { name: 'Hartwell Civil Partners', outcome: 'miss' }], { refused: true, now });
    check('a run that lists no unchecked names: its misses wait 30 days even under the warning', nextOf('Hartwell Civil Partners'), '2026-11-02');
    // 2026-11-03: refused again waits twice as long, up to 24 days, never given up.
    const waits = [];
    let t = now;
    for (let i = 0; i < 5; i++) {
      record(db, [{ name: 'Garmin International', outcome: 'unchecked' }, { name: 'Garmin International', outcome: 'miss' }], { refused: true, now: t });
      const r = db.prepare('SELECT next_attempt, state FROM employers WHERE key = ?').get(keyOf('Garmin International'));
      waits.push(Math.round((Date.parse(r.next_attempt) - t.getTime()) / 86_400_000));
      t = new Date(r.next_attempt);
    }
    // Garmin was already refused once above (3 days), so the next wait is 6.
    check('a name refused again waits 6, 12, 24, 24, 24 days', waits, [6, 12, 24, 24, 24]);
    record(db, [{ name: 'Garmin International', outcome: 'tracked', url: 'https://careers.garmin.com' }], { now });
    check('a board found under a new name stays tracked through sync', (sync(db, [{ name: 'Rivian' }]), db.prepare('SELECT state FROM employers WHERE key = ?').get(keyOf('Garmin International')).state), 'tracked');
  }

  console.log('\n🧪 universe: coverage is a number');
  {
    const c = coverage(db);
    check('tracked over everything not decided against', [c.tracked, c.total, c.coverage], [2, 3, 66.7]);
    check('the line names the gap', /66\.7% of 3 known US engineering employers discoverable — 2 by their own board.*· 1 not yet looked at/.test(coverageLine(c)), true);
    // F-713: a big employer read through a thin board is not discoverable.
    setMeta(db, 'reboard_thin', [{ name: 'Garmin International', open: 2 }]);
    const t = coverage(db);
    check('a thin board comes off the discoverable count', [t.thin, t.discoverable], [1, 33.3]);
    check('…and the line says so', /1 big employers only partly read \(1 through a thin board/.test(coverageLine(t)), true);
    setMeta(db, 'reboard_thin', []);
  }

  console.log('\n🧪 universe: the LinkedIn sweep, for employers no board answers for');
  {
    // Hartwell is the one no-board employer here. A fake LinkedIn: the search
    // returns its own posting plus a stranger's; only the card's company counts.
    const asked = [];
    const fake = async (queries) => {
      asked.push(queries[0]);
      return { throttled: false, postings: [
        { id: '1', company: 'Hartwell Civil Partners', title: 'Mechanical Design Engineer', loc: 'Reno, NV' },
        { id: '2', company: 'Someone Else Inc', title: 'Manufacturing Engineer', loc: 'Reno, NV' },
      ] };
    };
    const imported = [];
    const r = await linkedinSweep(db, { harvestImpl: fake, importImpl: async (f) => imported.push(f), log: () => {}, now: new Date('2026-10-04T00:00:00Z') });
    check('one search per employer, by its name', asked, ['Hartwell Civil Partners engineer']);
    check('its hardware posting counts; the stranger\'s does not', [r.counts['hiring-hw'], r.imported], [1, 1]);
    check('…and goes to the importer', imported.length, 1);
    const c2 = coverage(db);
    check('it is now discoverable through LinkedIn', [c2.viaLinkedin, c2.unknown, c2.discoverable], [1, 0, 100]);
    const again = await linkedinSweep(db, { harvestImpl: fake, importImpl: async () => {}, log: () => {}, now: new Date('2026-10-10T00:00:00Z') });
    check('not asked again inside a fortnight', again.due, 0);
    const none = await linkedinSweep(db, { harvestImpl: async () => ({ throttled: false, postings: [] }), importImpl: async () => {}, log: () => {}, now: new Date('2026-10-20T00:00:00Z') });
    check('after it, asked again; nothing listed is recorded as nothing', [none.counts.none, coverage(db).nothing], [1, 1]);
    const stop = await linkedinSweep(db, { harvestImpl: async () => ({ throttled: true, postings: [] }), log: () => {}, now: new Date('2026-11-20T00:00:00Z') });
    check('a throttled LinkedIn stops the sweep and marks nothing', [stop.throttled, stop.swept], [true, 0]);
  }

  console.log('\n🧪 universe: a killed run is replayed');
  {
    ingest(db, [{ name: 'Corning Incorporated', titles: ['Process Engineer'] }], 'linkedin');
    const runs = path.join(dir, 'runs');
    mkdirSync(path.join(runs, '123-1'), { recursive: true });
    writeFileSync(path.join(runs, '123-1', 'results.jsonl'), `${JSON.stringify({ name: 'Corning', outcome: 'tracked', url: 'https://x' })}\n`);
    check('its answers are recorded', replayLeftovers(db, runs), 1);
    check('…and the employer is settled', db.prepare('SELECT state FROM employers WHERE key = ?').get(keyOf('Corning')).state, 'tracked');
    check('…and the leftover is gone', replayLeftovers(db, runs), 0);
  }
  db.close();
} finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows holds the WAL a moment */ } }

console.log('\n🧪 universe: website lookup believes only the same name');
{
  const fake = (list) => async () => ({ ok: true, json: async () => list });
  check('exact name → its domain', await lookupSite('Garmin', { fetchImpl: fake([{ name: 'Garmin', domain: 'garmin.com' }]) }), 'https://garmin.com');
  check('a different company is not believed', await lookupSite('Marvell Semiconductor', { fetchImpl: fake([{ name: 'Marvel Entertainment', domain: 'marvel.com' }]) }), '');
  check('a failed lookup is no site, not a throw', await lookupSite('X', { fetchImpl: async () => { throw new Error('down'); } }), '');
}

console.log('\n🧪 branded-boards: careers hosts on the company\'s own domain');
{
  check('registrable domain', baseDomain('www.careers.garmin.com'), 'garmin.com');
  check('…two-letter country suffixes keep three labels', baseDomain('jobs.example.co.uk'), 'example.co.uk');
  const o = careerOrigins(['<a href="https://careers.garmin.com/careers-home/jobs">Search Jobs</a> <a href="https://support.garmin.com">x</a> <a href="https://careers.other.com">y</a>'], 'https://www.garmin.com');
  check('careers.<domain> and jobs.<domain> are always asked', o.slice(0, 2), ['https://careers.garmin.com', 'https://jobs.garmin.com']);
  check('support. is not a careers host, and another domain is never ours', o.includes('https://support.garmin.com') || o.includes('https://careers.other.com'), false);
  const corning = careerOrigins(['<a href="https://corningjobs.corning.com/go/Engineering/7684300/">Engineering</a> <a href="https://investors.corning.com">IR</a>'], 'https://www.corning.com');
  check('a host the company named for itself — corningjobs.corning.com (F-713)', corning.includes('https://corningjobs.corning.com'), true);
  check('…investors. is still not one', corning.includes('https://investors.corning.com'), false);
  check('Oracle sites are read from links', orcLinksIn('href="https://icfcjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/Aerospace/jobs"'),
    [{ host: 'https://icfcjb.fa.ocs.oraclecloud.com', site: 'Aerospace' }]);
  check('PageUp instance and site', pageUpLinksIn('https://careers.pageuppeople.com/1050/cw/en-us/listing/'), [{ instance: '1050', site: 'cw' }]);
  check('an unreadable platform is named', platformOf('<script src="https://recruiting.ultipro.com/x/JobBoard/abc"></script>'), 'ukg');
  check('…ADP too', platformOf('workforcenow.adp.com/mascsr/default/mdf/recruitment'), 'adp');
  check('a page with none of them names nothing', platformOf('<html>careers</html>'), '');
}

console.log('\n🧪 ukg: the board, its search, and the posting page (F-705)');
{
  const BASE = 'https://recruiting2.ultipro.com/ULT1005UCH/JobBoard/93be8725-1d6c-4162-aba5-e796cf8ea1b5';
  check('the base from a board URL with a query', ukgBase(`${BASE}/?q=&o=postedDateDesc`), BASE);
  check('…from a posting URL', ukgBase(`${BASE}/OpportunityDetail?opportunityId=86eae31c-aaea-490e-abc8-5a9c4bf97eb9`), BASE);
  check('another host is never a UKG board', ukgBase('https://evil.example.com/ULT1005UCH/JobBoard/93be8725-1d6c-4162-aba5-e796cf8ea1b5'), null);
  check('boards are read from a careers page', ukgBoardsIn(`<a href="${BASE}/?q=&amp;o=postedDateDesc">Jobs</a>`), [BASE]);
  // F-792: UKG's newer host serves the same board and search (Convergix, 2026-10-22).
  const NEW = 'https://convergix.rec.pro.ukg.net/CON1096CVAU/JobBoard/52250257-f25d-4ad3-b69e-53bc735d981a';
  check('the newer rec.pro.ukg.net host is a UKG board', ukgBase(`${NEW}/OpportunityApply?opportunityId=6f41c0f1-f013-445a-a361-db72efd4e989`), NEW);
  check('…and is read from a careers page', ukgBoardsIn(`<a href="${NEW}/?q=">Careers</a>`), [NEW]);
  check('…but a look-alike host is not', ukgBase('https://convergix.rec.pro.ukg.net.evil.com/CON1096CVAU/JobBoard/52250257-f25d-4ad3-b69e-53bc735d981a'), null);
  const page = parseUkgResponse({
    totalCount: 390,
    opportunities: [{ Id: '86eae31c-aaea-490e-abc8-5a9c4bf97eb9', Title: ' Technical Program Manager ', PostedDate: '2026-10-02T20:54:25.412Z',
      Locations: [{ Address: { City: 'Hillsboro', State: { Code: 'OR' }, Country: { Code: 'USA' } } }] }, { Title: 'no id' }],
  }, BASE, 'Ultra Clean Technology');
  check('a search page → jobs, with the total', [page.jobs.length, page.total], [1, 390]);
  check('…title, posting URL and a US location', [page.jobs[0].title, page.jobs[0].url.endsWith('opportunityId=86eae31c-aaea-490e-abc8-5a9c4bf97eb9'), page.jobs[0].location],
    ['Technical Program Manager', true, 'Hillsboro, OR, US']);
  const html = '<script>var opportunity = new US.Opportunity.CandidateOpportunityDetail({"Id":"x","Title":"Process Engineer","Description":"<p>Own the {etch} chamber \\"hot\\" swaps</p>","PostedDate":"2026-09-17T21:49:12Z","Locations":[{"Address":{"City":"Manor","State":{"Code":"TX"},"Country":{"Code":"USA"}}}]});</script>';
  const post = ukgPosting(html);
  check('the posting page gives title and full description', [post?.title, post?.description], ['Process Engineer', '<p>Own the {etch} chamber "hot" swaps</p>']);
  check('…and its place', post?.jobLocation?.[0]?.address?.addressLocality, 'Manor');
  check('a page with no record is null', ukgPosting('<html></html>'), null);
}

console.log('\n🧪 adp: Workforce Now career centers (F-705)');
{
  const CID = '3aada650-9516-4fad-a8af-527c53c40e64';
  const page = `<a href="https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&amp;ccId=9200679038627_2&amp;type=JS&amp;lang=en_US">A</a>`
    + `<a href="https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&amp;ccId=9200679039949_2&amp;lang=en_US">B</a>`;
  check('every career center on a page, &amp; read as &', adpCentersIn(page), [{ cid: CID, ccId: '9200679038627_2' }, { cid: CID, ccId: '9200679039949_2' }]);
  check('a non-ADP host is never read as one', adpIds(`https://evil.example.com/x?cid=${CID}`), null);
  const r = parseAdpResponse({ meta: { totalNumber: 18 }, jobRequisitions: [{ itemID: '9201842282301_1', requisitionTitle: 'Production Engineer', postDate: '2026-10-01T13:44:00.000-04:00',
    requisitionLocations: [{ address: { cityName: 'Warren', countrySubdivisionLevel1: { codeValue: 'OH' } } }] }] }, { cid: CID, ccId: '9200679038627_2' }, 'Ultium Cells');
  check('a page → jobs, with the total', [r.jobs.length, r.total, r.jobs[0].location], [1, 18, 'Warren, OH']);
  check('the posting URL carries what the description call needs', adpDetailApi(r.jobs[0].url)?.startsWith(
    `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/9201842282301_1?cid=${CID}&`), true);
  check('…and keeps the career center', /ccId=9200679038627_2/.test(adpDetailApi(r.jobs[0].url)), true);
  check('MyJobs is named apart from Workforce Now', [platformOf('https://myjobs.adp.com/fanuc/cx'), platformOf('workforcenow.adp.com/mascsr')], ['adp-myjobs', 'adp']);
}

console.log('\n🧪 paylocity: the board page\'s own data (F-720)');
{
  const B = 'https://recruiting.paylocity.com/recruiting/jobs/All/698ae7dc-5433-43b7-9995-6252db90aab7/Advanced-Cooling-Technologies-Inc';
  check('the board from a link', paylocityBoardsIn(`<a href="${B}">Careers</a>`), [B]);
  check('another host is never a Paylocity board', paylocityBoard('https://evil.example.com/recruiting/jobs/All/698ae7dc-5433-43b7-9995-6252db90aab7'), null);
  const html = `<script>window.pageData = {"Jobs":[{"JobId":3906699,"JobTitle":"Engineer- Product Development","PublishedDate":"2026-09-28T11:28:31-05:00","IsInternal":false,"Description":"Join {our} \\"team\\"","JobLocation":{"City":"Lancaster","State":"PA","Country":"USA"}},{"JobId":1,"JobTitle":"Internal only","IsInternal":true}]};</script>`;
  const jobs = parsePaylocityPage(html, 'Advanced Cooling Technologies');
  check('postings from the page data, internal ones skipped', jobs.map((j) => [j.title, j.location, j.url]),
    [['Engineer- Product Development', 'Lancaster, PA, US', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/3906699']]);
  check('a page without the data is no postings, not a throw', parsePaylocityPage('<html></html>', 'X'), []);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
