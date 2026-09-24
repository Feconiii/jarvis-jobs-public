#!/usr/bin/env node
// jarvis/migrate-store.mjs — move the job store from one JSON file into SQLite.
//
//   node jarvis/migrate-store.mjs              # build jobs.db beside jobs.json
//   node jarvis/migrate-store.mjs --verify     # re-check an existing jobs.db
//   node jarvis/migrate-store.mjs --in X --out Y
//
// The JSON file is never modified, only read — and it is read by streaming, so
// this works on a store that has already outgrown V8's ~512 MB string cap and
// can no longer be opened at all.
//
// Nothing is thrown away. Descriptions are gzipped (job postings compress
// about eight to one) and every field without a column of its own is kept
// verbatim, so a job read back out of the database is the job that went in.
// Verification is not optional: it re-reads the database afterwards and
// compares counts, statuses and a sample of whole records against the source.

import { existsSync, statSync, unlinkSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';
import { streamJobs, parseTail } from './json-stream.mjs';
import {
  openDb, makeWriters, fullJob, readDescription, jobToDetail,
  buildDictionary, putDictionary,
} from './db.mjs';
import { DB_PATH, LEGACY_JSON_PATH } from './store.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/migrate-store.mjs [options]

  Migrate the job store to the current schema.

    --force               
    --in <value>          
    --out <value>         
    --verify              
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--force","--in","--out","--verify"], valued: ["--in","--out"] });


const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const inPath = flag('--in', LEGACY_JSON_PATH);
const outPath = flag('--out', DB_PATH);
const verifyOnly = args.includes('--verify');
const force = args.includes('--force');

const MB = (b) => `${(b / 1048576).toFixed(0)} MB`;

/** Fields that are stored but reconstructed differently, so compared loosely. */
const SAMPLE_FIELDS = ['url', 'title', 'company', 'team', 'location', 'source', 'status',
  'firstSeen', 'lastSeen', 'postedAt', 'resume_path', 'resume_sent'];

function verify(dbPath, source) {
  const db = openDb(dbPath);
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n);
  const bodies = Number(db.prepare('SELECT COUNT(*) AS n FROM descriptions').get().n);
  const statuses = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) {
    statuses[r.status] = Number(r.n);
  }

  const problems = [];
  if (n !== source.count) problems.push(`job count ${n} != ${source.count} in the source`);
  if (bodies !== source.withDescription) problems.push(`description count ${bodies} != ${source.withDescription}`);
  for (const [status, count] of Object.entries(source.statuses)) {
    if ((statuses[status] || 0) !== count) problems.push(`status ${status}: ${statuses[status] || 0} != ${count}`);
  }

  // Whole-record spot check on the sample held back during the read.
  let sampled = 0;
  for (const original of source.samples) {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(original.id);
    if (!row) { problems.push(`sample ${original.id} is missing`); continue; }
    const back = fullJob(db, row);
    for (const f of SAMPLE_FIELDS) {
      const a = original[f] ?? null, b = back[f] ?? null;
      if (a !== b && !(a === '' && b === null) && !(a === null && b === '')) {
        problems.push(`sample ${original.id}: ${f} "${a}" != "${b}"`);
      }
    }
    if (JSON.stringify(original.triage ?? null) !== JSON.stringify(back.triage ?? null)) {
      problems.push(`sample ${original.id}: triage differs`);
    }
    if (JSON.stringify(original.fit ?? null) !== JSON.stringify(back.fit ?? null)) {
      problems.push(`sample ${original.id}: fit differs`);
    }
    const desc = readDescription(db, original.id);
    if ((original.description || '') !== desc) {
      problems.push(`sample ${original.id}: description differs (${(original.description || '').length} vs ${desc.length} chars)`);
    }
    sampled++;
  }

  // The indexes are the whole point — a missing one turns a page load into a
  // full scan. Ask the planner, rather than trusting that CREATE INDEX ran.
  const plan = db.prepare(
    'EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE status = ? AND location_bucket = ? ORDER BY fit_score DESC LIMIT 200',
  ).all('new', 'us').map(r => r.detail).join(' ');
  if (!/USING INDEX/i.test(plan)) problems.push(`the browse query is not using an index: ${plan}`);

  db.close();
  return { n, bodies, statuses, problems, sampled };
}

async function main() {
  if (!existsSync(inPath)) {
    console.error(`No JSON store at ${inPath} — nothing to migrate.`);
    process.exit(1);
  }
  const sizeBefore = statSync(inPath).size;

  if (!verifyOnly && existsSync(outPath) && !force) {
    console.error(`${outPath} already exists. Pass --force to rebuild it from scratch.`);
    process.exit(1);
  }
  if (!verifyOnly && existsSync(outPath) && force) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(outPath + suffix); } catch (err) {
        // Windows refuses to delete a file another process has open, and the
        // swallowed failure showed up much later as "no such column" — the old
        // database being reopened and quietly reused. Say what is actually
        // wrong, at the point where it is still obvious.
        if (err.code !== 'ENOENT') {
          console.error(`Cannot replace ${outPath + suffix}: ${err.code}.`);
          console.error('Something still has it open — stop the dashboard (jarvis/serve.mjs) and any scan or apply run, then retry.');
          process.exit(1);
        }
      }
    }
  }

  console.log(`Reading ${inPath} (${MB(sizeBefore)}) by streaming…`);

  // Held back for verification: every 500th job, kept whole.
  const source = { count: 0, withDescription: 0, statuses: {}, samples: [], rawDescBytes: 0 };
  const db = verifyOnly ? null : openDb(outPath);
  const writers = db ? makeWriters(db) : null;

  if (db) db.exec('BEGIN');
  let sinceCommit = 0;

  const write = (job) => {
    writers.putJob(job);
    // Commit periodically: one transaction over a million rows holds the whole
    // write-ahead log, which is the shape of failure this migration exists to
    // get away from.
    if (++sinceCommit >= 20000) { db.exec('COMMIT'); db.exec('BEGIN'); sinceCommit = 0; }
  };

  // ── pass 1: sample, so the dictionaries see the whole store ───────
  //
  // The dictionaries ARE sampled text, so what they sample decides how well
  // they work. Built from the first 400 descriptions in file order — which are
  // whichever company happens to sort first — they gave 2.75x. Sampled across
  // the file with a cap per company, the same setting gives materially more,
  // because the boilerplate they have to learn is every employer's, not one's.
  //
  // Sampling needs its own pass: holding 30,000 jobs in memory to sample them
  // is the failure this migration exists to end.
  if (writers) {
    const perCompany = new Map();
    const descSamples = [];
    const detailSamples = [];
    let seen = 0;
    await streamJobs(inPath, (id, job) => {
      seen++;
      const company = job.company || '';
      const taken = perCompany.get(company) || 0;
      const desc = job.description || '';
      if (desc.length > 500 && taken < 8 && descSamples.length < 600) {
        descSamples.push(desc);
        perCompany.set(company, taken + 1);
      }
      // Verdicts are near-identical across jobs, so an even spread is all the
      // diversity they need.
      if (seen % 97 === 0 && detailSamples.length < 900) {
        detailSamples.push(JSON.stringify(jobToDetail({ ...job, id: job.id || id })));
      }
    });
    if (descSamples.length >= 20) putDictionary(db, 'description', buildDictionary(descSamples));
    if (detailSamples.length >= 20) putDictionary(db, 'detail', buildDictionary(detailSamples));
    writers.refreshDictionaries();
    console.log(`  Dictionaries: ${descSamples.length} descriptions from ${perCompany.size} companies, ${detailSamples.length} verdicts`);
  }

  // ── pass 2: write ────────────────────────────────────────────────
  const tail = await streamJobs(inPath, (id, job) => {
    job.id = job.id || id;
    source.count++;
    const desc = job.description || '';
    if (desc.length > 0) { source.withDescription++; source.rawDescBytes += desc.length; }
    const status = job.status || 'new';
    source.statuses[status] = (source.statuses[status] || 0) + 1;
    if (source.count % 500 === 1) source.samples.push(job);

    if (writers) write(job);
    if (source.count % 20000 === 0) process.stderr.write(`  … ${source.count} jobs\n`);
  });

  if (db) {
    db.exec('COMMIT');
    const { scans, hiddenCompanies } = parseTail(tail);
    const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    setMeta.run('hiddenCompanies', JSON.stringify(hiddenCompanies));
    const insScan = db.prepare('INSERT INTO scans (at, json) VALUES (?, ?)');
    for (const s of [...scans].reverse()) insScan.run(s?.at || '', JSON.stringify(s));
    console.log(`  Carried over: ${scans.length} scan summaries, ${hiddenCompanies.length} hidden companies`);
    db.exec('ANALYZE');
    db.close();
  }

  const result = verify(outPath, source);
  const sizeAfter = existsSync(outPath) ? statSync(outPath).size : 0;

  console.log(`\n── Migration ──`);
  console.log(`  Jobs           : ${result.n}`);
  console.log(`  Descriptions   : ${result.bodies} (${MB(source.rawDescBytes)} of text)`);
  console.log(`  Statuses       : ${Object.entries(result.statuses).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  Verified whole : ${result.sampled} sampled records, field by field`);
  console.log(`  Size           : ${MB(sizeBefore)} → ${MB(sizeAfter)}`);

  if (result.problems.length) {
    console.error(`\n  ✗ ${result.problems.length} problem(s):`);
    for (const p of result.problems.slice(0, 20)) console.error(`      ${p}`);
    console.error(`\n  The JSON store was not modified. Fix the above before switching over.`);
    process.exit(1);
  }
  console.log(`\n  ✓ Verified. The JSON store at ${inPath} is untouched; keep it until the dashboard has run clean.`);
  console.log(`    Database: ${outPath}`);
}

// ONLY WHEN RUN AS A COMMAND. Importing this module used to execute it — the
// class of fault recorded as F-181 (a test import overwrote his real backup)
// and F-182 (importing the apply engine opened a browser on real postings).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
