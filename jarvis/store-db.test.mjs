#!/usr/bin/env node
// jarvis/store-db.test.mjs — the storage layer's guarantees.
//
// The store moved from one JSON document to SQLite, and the move is only worth
// anything if NOTHING was traded away for the speed and the size. These tests
// pin what "nothing" means:
//
//   - a job read back out is the job that went in, field for field and type
//     for type (the migration's first run failed here: an epoch-millisecond
//     postedAt came back as the string "1784237934200.0");
//   - the promoted columns always agree with the verdict they were derived
//     from, because a list that disagrees with the job it lists is the worst
//     failure this system has;
//   - every filter is ABSOLUTE and means what it says;
//   - an empty incoming field never erases a stored one.
//
// Run: node jarvis/store-db.test.mjs

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { isDeck, adapterFor, buildDictionary, compress, decompress, CODEC, openDb } from './db.mjs';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-store-'));
process.env.JARVIS_DB_PATH = path.join(dir, 'jobs.db');
const S = await import('./store.mjs');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  cond ? pass++ : fail++;
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

const JD_BLOCK = 'We are unable to provide visa sponsorship for this position. Mechanical design work with SolidWorks and GD&T.';
const JD_GOOD = 'Manufacturing engineer for semiconductor equipment. SolidWorks, GD&T, fixture design, CAD. Base Pay Range: $95,000 - $120,000 Annually.';

console.log('\n🧪 round-trip: a job comes back exactly as it went in');
{
  const url = 'https://boards.greenhouse.io/acme/jobs/1';
  S.upsertJobs([{
    url, title: 'Mechanical Design Engineer', company: 'Acme', team: 'Fixtures',
    location: 'Austin, TX', source: 'greenhouse', description: JD_GOOD,
    postedAt: 1784237934200,                       // Workday hands back a NUMBER
    company_meta: { tier: 'watchlist', sponsors_h1b: true, careers_url: 'https://acme/careers' },
  }]);
  const id = S.jobId(url);
  const job = S.getJob(id, { description: true });

  eq('title', job.title, 'Mechanical Design Engineer');
  eq('team', job.team, 'Fixtures');
  ok('postedAt keeps its type and value', job.postedAt === 1784237934200,
    `got ${JSON.stringify(job.postedAt)} (${typeof job.postedAt})`);
  eq('description is byte-exact', job.description, JD_GOOD);
  eq('company_meta survives whole', job.company_meta,
    { tier: 'watchlist', sponsors_h1b: true, careers_url: 'https://acme/careers' });
  ok('the verdict is there', !!job.triage?.flags);
  ok('the score is there', Number.isFinite(job.fit?.score));
  ok('pay was parsed out of the description', job.salary?.min === 95000 && job.salary?.max === 120000,
    JSON.stringify(job.salary));
}

console.log('\n🧪 a field with no column of its own is not dropped');
{
  const url = 'https://boards.greenhouse.io/acme/jobs/2';
  S.upsertJobs([{ url, title: 'Test Engineer', company: 'Acme', description: JD_GOOD }]);
  const id = S.jobId(url);
  // Fields invented by other parts of the system — the apply engine and the
  // agent both write ones this module has never heard of.
  S.updateJob(id, { skipFeedback: { at: '2026-08-12T00:00:00Z', reasons: ['pay'] }, someFutureField: [1, 2, 3] });
  const job = S.getJob(id);
  eq('unknown object survives', job.skipFeedback, { at: '2026-08-12T00:00:00Z', reasons: ['pay'] });
  eq('unknown array survives', job.someFutureField, [1, 2, 3]);
}

console.log('\n🧪 the columns the list reads agree with the verdict behind them');
{
  const url = 'https://boards.greenhouse.io/acme/jobs/3';
  S.upsertJobs([{ url, title: 'Manufacturing Engineer', company: 'Acme', location: 'Austin, TX', description: JD_BLOCK }]);
  const id = S.jobId(url);
  const full = S.getJob(id);
  const listed = S.getListItem(id);

  eq('blocked flag matches', listed.triage.flags.hardBlock, full.triage.flags.hardBlock);
  eq('location bucket matches', listed.triage.locationBucket, full.triage.locationBucket);
  eq('relevance matches', listed.triage.relevance.score, full.triage.relevance.score);
  eq('experience level matches', listed.triage.experience.level, full.triage.experience.level);
  eq('fit score matches', listed.fit.score, full.fit.score);
  eq('fit band matches', listed.fit.band, full.fit.band);
  ok('the work-auth block is real', full.triage.flags.hardBlock === true);
  ok('and it carries its quote', !!full.triage.visa?.block?.quote);
  eq('the blocked filter finds it', S.count({ blocked: true }), 1);
}

console.log('\n🧪 the deck column is the deck rule, for every job in the store');
{
  // Not a sample: every job in the store, one at a time. A single row where
  // the materialised column and the rule disagree is a job wrongly shown or
  // wrongly hidden — and the column is what the dashboard actually reads.
  const byRule = new Set();
  let checked = 0;
  for (const job of S.each()) { checked++; if (isDeck(job)) byRule.add(job.id); }
  const byColumn = new Set(S.query({ browsable: true }, { limit: 5000 }).rows.map(j => j.id));
  ok(`checked ${checked} jobs`, checked > 0);
  eq('the column and the rule select the same jobs',
    [...byRule].sort().join(','), [...byColumn].sort().join(','));
}

console.log('\n🧪 an empty incoming field never erases a stored one');
{
  const url = 'https://boards.greenhouse.io/acme/jobs/4';
  S.upsertJobs([{ url, title: 'Process Engineer', company: 'Acme', team: 'Etch', location: 'Hillsboro, OR', description: JD_GOOD }]);
  const id = S.jobId(url);
  // A scanner payload: title-only, no description, no team — the shape that
  // silently wiped 735 enriched verdicts under the old merge.
  S.upsertJobs([{ url, title: 'Process Engineer', company: '', team: '', location: 'Hillsboro, OR' }]);
  const job = S.getJob(id, { description: true });
  eq('company survives an empty one', job.company, 'Acme');
  eq('team survives an empty one', job.team, 'Etch');
  eq('description survives a title-only re-scan', job.description, JD_GOOD);
}

console.log('\n🧪 filters are absolute and mean what they say');
{
  S.upsertJobs([
    { url: 'https://jobs.lever.co/x/intern', title: 'Mechanical Engineering Intern', company: 'Lever Co', location: 'Austin, TX', description: 'Summer internship for a rising senior.' },
    { url: 'https://jobs.ashbyhq.com/x/tech', title: 'Manufacturing Technician', company: 'Ashby Co', location: 'Phoenix, AZ', description: 'Operate and maintain production equipment on the line.' },
    { url: 'https://acme.wd1.myworkdayjobs.com/x/ng', title: 'Manufacturing Engineer, University Graduate', company: 'Workday Co', location: 'Santa Clara, CA', description: JD_GOOD },
  ]);
  const only = (f) => S.query(f, { limit: 50 }).rows;
  ok('intern:true returns only internships', only({ intern: true }).every(j => j.triage.flags.internship));
  ok('intern:false returns no internships', only({ intern: false }).every(j => !j.triage.flags.internship));
  ok('handsOn:false returns no technician roles', only({ handsOn: false }).every(j => !j.triage.flags.handsOn));
  ok('company filter is exact', only({ company: 'Acme' }).every(j => j.company === 'Acme'));
  ok('excludeCompany excludes', only({ excludeCompany: ['Acme'] }).every(j => j.company !== 'Acme'));
  ok('minScore is a floor', only({ minScore: 40 }).every(j => j.fit.score >= 40));
  ok('locationBucket filter holds', only({ locationBucket: ['us'] }).every(j => j.triage.locationBucket === 'us'));

  const total = S.count();
  const sum = Object.values(S.countBy('status')).reduce((a, b) => a + b, 0);
  eq('grouped counts add up to the whole store', sum, total);
}

console.log('\n🧪 search finds jobs by title and company, on a prefix');
{
  ok('full word', S.query({ search: 'Manufacturing' }, { limit: 20 }).total >= 2);
  ok('prefix', S.query({ search: 'Manufact' }, { limit: 20 }).total >= 2);
  ok('company name', S.query({ search: 'Ashby Co' }, { limit: 20 }).total >= 1);
  ok('a term that is in no posting finds nothing', S.query({ search: 'zzzznotathing' }, { limit: 20 }).total === 0);
  const filtered = S.query({ search: 'Manufacturing', intern: false }, { limit: 20 });
  ok('search composes with filters', filtered.rows.every(j => !j.triage.flags.internship));
  // A search JOINs the full-text index, whose columns share names with the
  // jobs table. Unqualified, `company NOT IN (…)` is "ambiguous column name" —
  // and every search typed while a company was hidden returned a 500.
  const withCompanyFilter = S.query({ search: 'Manufacturing', excludeCompany: ['Acme'] }, { limit: 20 });
  ok('search composes with a company filter', withCompanyFilter.rows.every(j => j.company !== 'Acme'));
  ok('and with every other column filter',
    S.query({ search: 'Manufacturing', company: ['Workday Co'], minScore: 0, hasDesc: true }, { limit: 20 })
      .rows.every(j => j.company === 'Workday Co'));
}

console.log('\n🧪 paging reports the real total, not the page size');
{
  const page = S.query({}, { limit: 2 });
  ok('the page is capped', page.rows.length <= 2);
  eq('the total is the whole match', page.total, S.count());
  const second = S.query({}, { limit: 2, offset: 2 });
  ok('a second page is different rows',
    !second.rows.some(r => page.rows.find(p => p.id === r.id)));
}

console.log('\n🧪 which apply adapter can drive a posting');
{
  eq('greenhouse', adapterFor('https://boards.greenhouse.io/acme/jobs/1'), 'greenhouse');
  eq('lever', adapterFor('https://jobs.lever.co/x/y'), 'lever');
  eq('ashby', adapterFor('https://jobs.ashbyhq.com/x/y'), 'ashby');
  eq('workday', adapterFor('https://acme.wd1.myworkdayjobs.com/x/y'), 'workday');
  eq('a custom careers site has none', adapterFor('https://tesla.com/careers/job/123'), null);
  // The column is written at upsert time; it must match what the function says
  // about every stored URL, or Home reports apply reach it does not have.
  let byFn = 0;
  for (const j of S.each()) if (adapterFor(j.url)) byFn++;
  eq('the stored column agrees with the function', S.count({ hasAdapter: true }), byFn);
}

console.log('\n🧪 compression: exact round-trips, dictionary or not');
{
  const text = JD_GOOD.repeat(20);
  for (const dict of [null, buildDictionary([JD_GOOD, JD_BLOCK])]) {
    const { codec, blob } = compress(text, dict);
    eq(`round-trip ${dict ? 'with' : 'without'} a dictionary`, decompress(blob, codec, dict), text);
    ok(`  and it is smaller (${blob.length} < ${Buffer.byteLength(text)})`, blob.length < Buffer.byteLength(text));
  }
  const { codec, blob } = compress('', null);
  eq('an empty string round-trips', decompress(blob, codec, null), '');
  ok('codecs are tagged per row', codec === CODEC.ZSTD || codec === CODEC.GZIP);
}

console.log('\n🧪 dropping a body keeps the job, its verdict and its quote');
{
  const id = S.jobId('https://boards.greenhouse.io/acme/jobs/3');
  const before = S.getJob(id);
  S.dropDescription(id);
  const after = S.getJob(id, { description: true });
  eq('the job is still there', after.title, before.title);
  eq('the block is still there', after.triage.flags.hardBlock, true);
  eq('the quote is still there', after.triage.visa.block.quote, before.triage.visa.block.quote);
  eq('only the body is gone', after.description, '');
  eq('and the column says so', S.getListItem(id).hasDesc, false);
}

console.log('\n🧪 a pruned body is not immediately re-downloaded');
{
  // Pruning marks the job. Without the mark the enrichment worker sees "no
  // description" and fetches it again, which turns pruning into a treadmill.
  // Workday, so the "greenhouse posting with no team label" re-read rule —
  // which is a legitimate reason to fetch a job that already has a body —
  // cannot muddy what this is testing.
  const url = 'https://acme.wd1.myworkdayjobs.com/x/retired';
  S.upsertJobs([{ url, title: 'Retired Engineer', company: 'Acme', source: 'workday', description: JD_GOOD }]);
  const id = S.jobId(url);
  const queued = () => S.query({ needsRead: true }, { limit: 500 }).rows.some(j => j.id === id);
  ok('a job that already has a body is not queued for reading', !queued());
  S.dropDescription(id);
  ok('and a pruned one is not queued either', !queued());
  eq('an unpruned job with no body still is', S.query({ needsRead: true }, { limit: 500 }).total > 0, true);
  eq('the job itself is untouched', S.getJob(id).title, 'Retired Engineer');
}

console.log('\n🧪 hidden companies and scan history persist');
{
  eq('hide', S.setCompanyHidden('Acme', true), ['Acme']);
  eq('unhide', S.setCompanyHidden('Acme', false), []);
  S.recordScan({ at: '2026-08-12T00:00:00Z', postingsCaptured: 5 });
  eq('the scan is recorded', S.getScans(5)[0].postingsCaptured, 5);
  for (let i = 0; i < 25; i++) S.recordScan({ at: `2026-08-12T00:00:${String(i).padStart(2, '0')}Z` });
  ok('only the last 20 runs are kept', S.getScans(50).length === 20);
}

console.log('\n🧪 a board that puts the posting id in the query string');
{
  // Zipline serves all 315 of its postings from www.zipline.com/open-roles and
  // tells them apart only by ?gh_jid=. When the id ignored the query, all 315
  // hashed the same and each overwrote the last — one row survived. Agility
  // Robotics, Waymo and Nuro were showing exactly one job for the same reason.
  const a = 'https://www.zipline.com/open-roles?gh_jid=7895360003';
  const b = 'https://www.zipline.com/open-roles?gh_jid=7893921003';
  ok('two postings on one path are two jobs', S.jobId(a) !== S.jobId(b));

  // Decoration still collapses: every Eightfold sitemap URL carries ?domain=.
  ok('a decorative parameter is still ignored',
    S.jobId('https://x.eightfold.ai/careers/job/12?domain=micron.com') === S.jobId('https://x.eightfold.ai/careers/job/12'));
  ok('tracking parameters are ignored',
    S.jobId('https://x.com/j/9?utm_source=li&utm_campaign=q3') === S.jobId('https://x.com/j/9'));

  // Order and case must not change identity, or a re-scan would duplicate rows.
  ok('parameter order does not matter',
    S.jobId('https://x.com/j?gh_jid=5&utm_source=li') === S.jobId('https://x.com/j?utm_source=li&gh_jid=5'));
  ok('parameter name case does not matter',
    S.jobId('https://x.com/j?GH_JID=5') === S.jobId('https://x.com/j?gh_jid=5'));
  ok('a fragment is ignored', S.jobId('https://x.com/j/9#apply') === S.jobId('https://x.com/j/9'));
  ok('a trailing slash is ignored', S.jobId('https://x.com/j/9/') === S.jobId('https://x.com/j/9'));

  // Zimmer Biomet: Phenom over SuccessFactors. One path, identity in
  // career_job_req_id, and a session token that is regenerated per scan.
  const zb = (req, crb) => `https://career8.successfactors.com/careers?company=zimmerin01&loginFlowRequired=true&career_os=job_listing&career_ns=job_application&career_job_req_id=${req}&_s.crb=${crb}`;
  ok('a vendor id param nobody allowlisted still separates postings',
    S.jobId(zb('11939', 'AAA')) !== S.jobId(zb('11426', 'AAA')));
  ok('a session token that rotates does NOT mint a new job every scan',
    S.jobId(zb('11939', 'AAA')) === S.jobId(zb('11939', 'ZZZ')));

  // Two postings that differ in the id param must not merge in the store.
  S.upsertJobs([
    { url: a, title: 'Aerodynamics Manager', company: 'Zipline', location: 'South San Francisco, California, USA' },
    { url: b, title: 'Accounting Intern', company: 'Zipline', location: 'South San Francisco, California, USA' },
  ]);
  eq('both land in the store', S.count({ company: 'Zipline' }), 2);
  ok('each is retrievable by its own url', !!S.getJobByUrl(a) && !!S.getJobByUrl(b));
}

console.log('\n🧪 the deck fold must not swallow a filter the user opened');

// foldIntoDeck swaps a default-looking filter set for the `deck` index, which
// is a large speed win and excludes over-senior roles by definition. It decides
// whether it may fold by looking for 'exclude' in the level list.
//
// The dashboard used to send NO level param when all four toggles were on,
// because "all of them" and "no filter" look equivalent. They are not: sending
// nothing let the fold happen, the deck index dropped every senior posting, and
// the toggle appeared live while doing nothing. 37,016 postings stayed hidden.
{
  const { buildWhere } = await import('./db.mjs');
  const base = {
    status: ['new'], blocked: false, fitBlocked: false, intern: false,
    handsOn: false, gradMismatch: false, locationBucket: ['us', 'remote', 'unknown'],
  };
  const defaultView = buildWhere({ ...base, level: ['entry', 'stretch', 'unknown', 'mid'] });
  eq('the default view still folds onto the deck index', /deck/.test(defaultView.sql), true);

  const wantsSenior = buildWhere({ ...base, level: ['entry', 'stretch', 'unknown', 'mid', 'exclude'] });
  eq('asking for senior roles does NOT fold onto the deck', /deck/.test(wantsSenior.sql), false);
  eq('…and filters on level instead', /level/.test(wantsSenior.sql), true);

  // The shape that caused it: no level key at all.
  const noLevel = buildWhere(base);
  eq('an absent level list folds (so the client must spell it out)', /deck/.test(noLevel.sql), true);
}

console.log('\n🧪 the field filter reaches SQL');

// The dropdown, the column and the index all existed; the line that read the
// query parameter did not, so every option returned the identical 12,302 rows.
{
  const { buildWhere } = await import('./db.mjs');
  const w = buildWhere({ status: ['new'], field: ['robotics'] });
  eq('a field filter produces a field clause', /field/.test(w.sql), true);
  eq('…and binds the value', w.args.includes('robotics'), true);
}

console.log('\n🧪 findByHeading: a form that names the job by board and heading (F-330)');
{
  S.upsertJobs([
    { url: 'https://jobs.smartrecruiters.com/BectonDickinson2/743999797968244-advanced-manufacturing-engineer-i', title: 'Advanced Manufacturing Engineer I', company: 'Becton Dickinson', description: JD_GOOD },
    { url: 'https://jobs.smartrecruiters.com/BectonDickinson2/743999797968245-advanced-manufacturing-engineer-ii', title: 'Advanced Manufacturing Engineer II', company: 'Becton Dickinson', description: JD_GOOD },
    { url: 'https://jobs.smartrecruiters.com/Bosch/743999797968246-advanced-manufacturing-engineer-i', title: 'Advanced Manufacturing Engineer I', company: 'Bosch', description: JD_GOOD },
  ]);
  const BD = 'https://jobs.smartrecruiters.com/BectonDickinson2/';
  const hit = S.findByHeading(BD, ['Advanced Manufacturing Engineer I', 'Easy apply - Advanced Manufacturing Engineer I - Becton Dickinson']);
  ok('the exact title on the right board', hit?.url === `${BD}743999797968244-advanced-manufacturing-engineer-i`, hit?.url);
  ok('the <title> alone still finds it', S.findByHeading(BD, ['Easy apply - Advanced Manufacturing Engineer I - Becton Dickinson'])?.title === 'Advanced Manufacturing Engineer I');
  ok('level II is not level I', S.findByHeading(BD, ['Advanced Manufacturing Engineer II'])?.title === 'Advanced Manufacturing Engineer II');
  ok('another board never answers', S.findByHeading('https://jobs.smartrecruiters.com/Bosch/', ['Advanced Manufacturing Engineer II']) === null);
  ok('a heading that is nobody\'s title answers nothing', S.findByHeading(BD, ['Easy Apply']) === null);
  S.updateJob(hit.id, { goneAt: new Date().toISOString() });
  ok('a posting marked gone is not matched', S.findByHeading(BD, ['Advanced Manufacturing Engineer I']) === null);
}

S.closeDb();
rmSync(dir, { recursive: true, force: true });
console.log('\n🧪 a retired posting says so, and is not dropped');
{
  // F-241. `goneAt` only ever fed isDeck(), which pulls a dead posting out of
  // the pile he is still triaging. His queue and shortlist are filtered by
  // STATUS, not by deck, so a retired posting sat there looking exactly like a
  // live one — two dead Amazon reqs and two dead Applied Materials reqs were
  // doing that, and the only way to find out was to apply to one.
  const url = 'https://boards.greenhouse.io/acme/jobs/gone-1';
  S.upsertJobs([{
    url, title: 'Retired Engineer', company: 'Acme', location: 'Austin, TX',
    source: 'greenhouse', description: JD_GOOD,
  }]);
  const id = S.jobId(url);
  S.setStatus(id, 'queued');
  S.updateJob(id, { goneAt: '2026-09-02T00:00:00Z' }, { rederive: true });

  eq('the list row carries it, or the UI cannot show it',
    S.getListItem(id).goneAt, '2026-09-02T00:00:00Z');

  // AND IT MUST STILL BE THERE. Triage flags, it never drops.
  const queued = S.query({ status: 'queued' }, { limit: 500 }).rows;
  ok('a retired posting stays in the queue he put it in', queued.some((j) => j.id === id));
  ok('and the row he sees carries the flag too',
    queued.find((j) => j.id === id)?.goneAt === '2026-09-02T00:00:00Z');
}

console.log('\n🧪 a live posting carries no gone flag');
{
  const url = 'https://boards.greenhouse.io/acme/jobs/live-1';
  S.upsertJobs([{
    url, title: 'Live Engineer', company: 'Acme', location: 'Austin, TX',
    source: 'greenhouse', description: JD_GOOD,
  }]);
  // null, not undefined — the dashboard tests the value directly.
  eq('null, not undefined', S.getListItem(S.jobId(url)).goneAt, null);
}


console.log('\n🧪 a blank incoming field never erases a stored one');
{
  // F-279. The file header states this as a guarantee — "an empty incoming
  // field never erases a stored one" — and `location` was the one field that
  // broke it. `existing.location = j.location ?? existing.location` guards null
  // and undefined but not '', so a provider returning a blank location erased
  // "Austin, TX" and dropped the posting's bucket from `us` to `unknown`.
  //
  // team, company, salary and description all used truthiness already; the
  // comment two lines below the bug stated the rule for company explicitly.
  const url = 'https://boards.greenhouse.io/acme/jobs/blank-merge';
  S.upsertJobs([{
    url, title: 'Manufacturing Engineer', company: 'Acme', team: 'Fixtures',
    location: 'Austin, TX', source: 'greenhouse', description: JD_GOOD,
    salary: { min: 90000, max: 120000, currency: 'USD', interval: 'year' },
  }]);
  const id = S.jobId(url);
  S.setStatus(id, 'interested');

  // A degraded re-scan: the provider returns the row with the fields blank.
  S.upsertJobs([{
    url, title: 'Manufacturing Engineer', company: '', team: '',
    location: '', source: 'greenhouse', description: '', salary: null,
  }]);
  const after = S.getJob(id, { description: true });

  eq('location survives a blank', after.location, 'Austin, TX');
  eq('company survives a blank', after.company, 'Acme');
  eq('team survives a blank', after.team, 'Fixtures');
  ok('salary survives a blank', !!after.salary);
  ok('the description survives a blank', (after.description || '').length > 0);
  eq('and his decision is untouched', after.status, 'interested');
  eq('the bucket is still the real one', after.triage?.locationBucket, 'us');

  // A REAL change still lands — the fix must not freeze the field.
  S.upsertJobs([{ url, title: 'Manufacturing Engineer', company: 'Acme', location: 'Boise, ID', source: 'greenhouse', description: JD_GOOD }]);
  eq('a genuine relocation still updates', S.getJob(id).location, 'Boise, ID');
}


// ── a running scan must not break every other command ───────────────
//
// `openDb` runs the whole DDL on every open. While a scan holds the write lock
// — 166k postings, tens of minutes, entirely normal — CREATE INDEX waits out
// busy_timeout and throws, so the dashboard, the CLI and the apply engine all
// die on open. Measured against a real scan already running on his store: every
// query took 32 seconds and then failed.
//
// Opening a database whose schema is already correct is not a write, and must
// not require one.
console.log('\n🧪 a second spelling of a row, and what undoes it (F-406)');
{
  const scan = (url, title) => S.upsertJobs([{
    url, title, company: 'Zipline', location: 'South San Francisco, California',
    source: 'greenhouse', triage: null,
  }], new Date().toISOString());

  const OLD = 'https://www.zipline.com/open-roles?gh_jid=7868140003';
  const NEW = 'https://www.zipline.com/open-roles/7868140003?gh_jid=7868140003';
  scan(OLD, 'Mechanical Engineer, RF Systems');
  scan(NEW, 'Mechanical Engineer, RF Systems');
  const oldId = S.jobId(OLD);
  const newId = S.jobId(NEW);

  const shown = () => S.query({ company: ['Zipline'] }, { limit: 50 }).rows.map((r) => r.id).sort();
  eq('both spellings are stored', shown().length, 2);

  // Point the old one at the new one, the way jarvis/dedupe.mjs does.
  S.db().prepare('UPDATE jobs SET superseded_by = ? WHERE id = ?').run(newId, oldId);
  eq('only the survivor is listed', shown(), [newId]);
  ok('…and the pointed-at row is still readable by its own id', !!S.getJob(oldId));
  eq('…and says what it points at', S.getJob(oldId)?.supersededBy, newId);
  eq('a caller that asks for both gets both',
    S.query({ company: ['Zipline'], includeSuperseded: true }, { limit: 50 }).rows.length, 2);

  // THE BOARD LISTS IT AGAIN. Nothing may keep a live posting out of his lists.
  scan(OLD, 'Mechanical Engineer, RF Systems');
  eq('being listed again shows the row again', shown().length, 2);
  eq('…and the pointer is gone, not just ignored', S.getJob(oldId)?.supersededBy, undefined);
}

console.log('\n🧪 the store opens while another process is writing');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-lock-'));
  const file = path.join(dir, 'jobs.db');
  const first = openDb(file);
  const holder = new DatabaseSync(file);
  holder.exec('PRAGMA busy_timeout = 100');
  holder.exec('BEGIN EXCLUSIVE');
  holder.exec('CREATE TABLE scan_in_progress (x)');   // what a scan looks like
  let opened = null, err = '';
  try { opened = openDb(file); } catch (e) { err = String(e && e.message); }
  ok('a second process still opens the store', opened !== null, err);
  const count = opened ? opened.prepare('SELECT COUNT(*) c FROM jobs').get().c : null;
  ok('and can read it', count === 0, `got ${JSON.stringify(count)}`);
  opened?.close?.();
  holder.exec('ROLLBACK');
  holder.close();
  first.close?.();
  // Windows will not unlink a file whose handles were open a moment ago.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }
}

// ── F-326: a URL the scanner built wrongly, corrected on the way out ──
//
// `jobs.smartrecruiters.com/<slug>/postings/<id>` answers 404 for postings
// that are LIVE. 14,913 rows carry it, and the store's identity is the url, so
// they cannot be rewritten in place — the entry sat at "a URL migration would
// need new ids". It does not need one: measured against the live site, the id
// alone opens (`/<slug>/<id>` -> 200) and the title slug is decoration. The
// row keeps what it is identified by; every reader gets a link that opens.
console.log('\n🧪 the SmartRecruiters url that 404s for live jobs is corrected for readers');
{
  const { publicUrl, rowToJob } = await import('./db.mjs');
  eq('the broken form is corrected',
    publicUrl('https://jobs.smartrecruiters.com/Intuitive/postings/744000136300637'),
    'https://jobs.smartrecruiters.com/Intuitive/744000136300637');
  eq('a query string survives it',
    publicUrl('https://jobs.smartrecruiters.com/abbvie/postings/123?src=board'),
    'https://jobs.smartrecruiters.com/abbvie/123?src=board');
  // The form the scanner writes NOW is already right and must not be touched.
  const good = 'https://jobs.smartrecruiters.com/Intuitive/744000136300637-field-service-engineer';
  eq('the current form is left alone', publicUrl(good), good);
  // Nothing else on the internet is reshaped by this.
  const gh = 'https://boards.greenhouse.io/acme/jobs/123/postings/9';
  eq('another board is left alone', publicUrl(gh), gh);
  eq('an empty url is not turned into a string', publicUrl(''), '');

  // And it reaches a job read out of a real store, which is the point.
  const dir2 = mkdtempSync(path.join(tmpdir(), 'jarvis-srurl-'));
  const h = openDb(path.join(dir2, 'jobs.db'));
  h.prepare(`INSERT INTO jobs (id, url, title, company, status, first_seen, last_seen)
             VALUES ('sr1', 'https://jobs.smartrecruiters.com/Intuitive/postings/999', 'Manufacturing Engineer', 'Intuitive Surgical', 'new', '2026-09-01', '2026-09-18')`).run();
  const row = h.prepare('SELECT * FROM jobs WHERE id = ?').get('sr1');
  eq('a job read from the store carries the working link',
    rowToJob(row).url, 'https://jobs.smartrecruiters.com/Intuitive/999');
  eq('…while the ROW keeps the identity it is stored under',
    row.url, 'https://jobs.smartrecruiters.com/Intuitive/postings/999');
  h.close?.();
  try { rmSync(dir2, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }
}

// FRESHNESS: "posted ≤ N days", measured on the date the card shows.
//
// The dashboard prints a job's age as `postedAt || firstSeen` — the board's
// published date, with first-seen only as the fallback — and the filter has to
// agree with it, or a card reading "3d" drops out of "posted ≤ 7 days".
//
// The other half is the one this codebase cares about more: a posting with NO
// date of either kind is KEPT. Triage flags, it never drops. Several boards
// publish no date at all, and dropping them for a missing field would hide live
// jobs behind a control that says nothing about what it removed.
console.log('\n🧪 the age filter reads the posted date, falls back to first seen, and drops nothing undated');
{
  const { queryJobs } = await import('./db.mjs');
  const dir3 = mkdtempSync(path.join(tmpdir(), 'jarvis-posted-'));
  const h = openDb(path.join(dir3, 'jobs.db'));
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const add = (id, posted, firstSeen) => h.prepare(
    `INSERT INTO jobs (id, url, title, company, status, posted_at, first_seen, last_seen)
     VALUES (?, ?, 'Manufacturing Engineer', 'Acme', 'new', ?, ?, ?)`,
  ).run(id, `https://example.test/${id}`, posted, firstSeen, iso(0));

  add('fresh', iso(2), iso(400));          // posted recently, in the store for ages
  add('stale', iso(200), iso(0));          // captured today, but the board posted it in March
  add('fallback-fresh', null, iso(3));     // no published date — first seen stands in
  add('fallback-old', null, iso(100));
  add('undated', null, null);              // a board that publishes no date at all
  add('empty-strings', '', '');            // …and the same thing spelled as blanks

  const ids = (days) => queryJobs(h, { postedWithin: days }, { limit: 50 }).rows.map((r) => r.id).sort();
  const within7 = ids(7);

  ok('a posting published two days ago is in', within7.includes('fresh'));
  ok('first seen stands in when the board published no date', within7.includes('fallback-fresh'));
  ok('AN UNKNOWN AGE IS KEPT — it is not an old posting', within7.includes('undated'));
  ok('…including when the columns are blank rather than NULL', within7.includes('empty-strings'));
  ok('a posting published 200 days ago is out, however recently it was captured',
    !within7.includes('stale'), `got: ${within7.join(', ')}`);
  ok('first seen 100 days ago is out too', !within7.includes('fallback-old'));

  // The window is the number of days it says, not a fixed one.
  ok('a wider window admits what a narrower one excluded', ids(120).includes('fallback-old'));
  ok('…and still excludes what is older than it', !ids(120).includes('stale'));
  eq('no window at all filters nothing', queryJobs(h, {}, { limit: 50 }).total, 6);
  // 0 and nonsense mean "any age" rather than "nothing" — a filter that empties
  // the list on a value it does not understand is the silent-drop failure again.
  eq('zero days is not a filter', queryJobs(h, { postedWithin: 0 }, { limit: 50 }).total, 6);
  eq('an unparseable window is not a filter', queryJobs(h, { postedWithin: NaN }, { limit: 50 }).total, 6);

  h.close?.();
  try { rmSync(dir3, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);