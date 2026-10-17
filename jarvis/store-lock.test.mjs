#!/usr/bin/env node
// jarvis/store-lock.test.mjs — the lost-update guard.
//
// The store's writers are separate PROCESSES: the dashboard server, the
// enrichment child it spawns every three minutes, the scan child it spawns
// every six hours, and any apply run. They write at the same time, and what
// they must never do is lose each other's work.
//
// The JSON store lost it constantly. Every writer did read-modify-write on the
// WHOLE file, so anything added between one writer's load and its save was
// simply gone — Eaton (2,204 postings) and MKS (165) each reported "+N new"
// and were absent afterwards. A hand-rolled file lock papered over it.
//
// SQLite removes the failure at the root: writes touch single rows and the
// database serialises them. These tests hold the guarantee to the same
// standard as before — three concurrent writer processes, rendezvousing at a
// barrier so the overlap is guaranteed rather than hoped for, and all three
// must survive. They also pin the things that DID go wrong when the store
// moved: a write that arrives while a long read is streaming, and a
// transaction that throws.

import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(path.join(HERE, 'store.mjs')).href;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  cond ? pass++ : fail++;
};
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKER = `
import { readdirSync, writeFileSync } from 'fs';
import path from 'path';
const dir = process.env.JARVIS_DATA_DIR;
const key = process.argv[2];
const want = Number(process.argv[3]);
const S = await import(${JSON.stringify(STORE_URL)});
const nap = (ms) => new Promise(r => setTimeout(r, ms));

// Barrier: announce, then wait for every sibling, so all writers are inside
// their critical section at the same moment.
writeFileSync(path.join(dir, 'ready-' + key), '1');
for (let i = 0; i < 200; i++) {
  if (readdirSync(dir).filter(f => f.startsWith('ready-')).length >= want) break;
  await nap(25);
}

await S.withStoreLock(async () => {
  S.upsertJobs([{ url: 'https://x/' + key, title: key, company: 'Race' }]);
  await nap(120);   // stands in for the seconds a real writer spends working
});
`;

// SAY WHY THE WORKER DIED.
//
// This discarded stdout and stderr, so a failing worker surfaced as a bare
// `Command failed ... exit code 1` with the node stack of execFile itself and
// nothing about what actually threw. It cost a full diagnostic detour: the
// suite went red while the dashboard happened to be running, and the only way
// to find out whether that was a real defect was to stop the dashboard and run
// it again. A test that fails without saying why is barely better than one that
// does not run.
const run = (file, args, env) => new Promise((resolve, reject) =>
  execFile(process.execPath, [file, ...args], { env }, (err, stdout, stderr) => {
    if (!err) return resolve();
    const said = `${stderr || ''}${stdout || ''}`.trim().split('\n').slice(0, 6).join('\n');
    err.message = `${args[0]} worker failed${said ? `:\n${said}` : ' with no output'}`;
    return reject(err);
  }));

console.log('\n🧪 concurrent writers: three processes, none lost');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-race-'));
  const worker = path.join(dir, 'worker.mjs');
  writeFileSync(worker, WORKER);
  const keys = ['alpha', 'beta', 'gamma'];
  await Promise.all(keys.map((k) =>
    run(worker, [k, String(keys.length)], { ...process.env, JARVIS_DATA_DIR: dir, JARVIS_DB_PATH: path.join(dir, 'jobs.db') })));

  process.env.JARVIS_DB_PATH = path.join(dir, 'jobs.db');
  const S = await import(STORE_URL);
  const titles = new Set(S.query({}, { limit: 100 }).rows.map(r => r.title));
  ok('all three writers land', keys.every(k => titles.has(k)),
    `survivors: ${[...titles].join(', ') || 'none'}`);
  S.closeDb();
  delete process.env.JARVIS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
}

// The rest run in-process against a scratch database.
process.env.JARVIS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-tx-')), 'jobs.db');
const S = await import(STORE_URL);

console.log('\n🧪 a transaction that throws leaves nothing behind');
{
  await S.withStoreLock(() => {
    S.upsertJobs([{ url: 'https://x/rollback', title: 'Rolled Back', company: 'Race' }]);
    throw new Error('boom');
  }).catch(() => {});
  ok('the failed write is not in the store', S.getJob(S.jobId('https://x/rollback')) === null);
  // …and the store is still usable, which a leaked transaction would prevent.
  let after = false;
  await S.withStoreLock(() => { S.upsertJobs([{ url: 'https://x/after', title: 'After', company: 'Race' }]); after = true; });
  ok('the next writer still works', after && !!S.getJob(S.jobId('https://x/after')));
}

console.log('\n🧪 values pass through');
ok('sync return value', (await S.withStoreLock(() => 42)) === 42);
ok('async return value', (await S.withStoreLock(async () => { await nap(5); return 'async'; })) === 'async');

console.log('\n🧪 a user decision survives a concurrent re-scan');
{
  // The exact shape of the bug the old lock existed for: a scan reads, works
  // for a while, then writes — and a status set meanwhile must not vanish.
  const url = 'https://x/sticky';
  S.upsertJobs([{ url, title: 'Sticky', company: 'Race' }]);
  const id = S.jobId(url);
  S.setStatus(id, 'queued');
  S.upsertJobs([{ url, title: 'Sticky', company: 'Race', location: 'Austin, TX' }]);
  ok('status survives a refresh that changes the posting', S.getJob(id).status === 'queued');
}

console.log('\n🧪 the store reports its own version so caches cannot go stale');
{
  const before = S.storeVersion();
  S.upsertJobs([{ url: 'https://x/version', title: 'Version', company: 'Race' }]);
  ok('a write changes the version token', S.storeVersion() !== before);
}

// WAITING FOR ANOTHER WRITER NEVER FREEZES THIS PROCESS (2026-09-26). The
// dashboard froze for 10 s while one background write queued behind an
// enrichment child: `BEGIN IMMEDIATE` waited out busy_timeout synchronously.
// A second connection holds the lock for 1.2 s; meanwhile a 100 ms timer in
// THIS process must keep ticking, and the write must still land after.
console.log('\n🧪 a write queued behind another writer does not block the event loop');
{
  const { DatabaseSync } = await import('node:sqlite');
  const other = new DatabaseSync(process.env.JARVIS_DB_PATH);
  other.exec('BEGIN IMMEDIATE');
  // The longest silence between ticks, not their count: a loop frozen for the
  // whole busy_timeout still ticks plenty before and after the freeze.
  let last = Date.now(), gap = 0;
  const timer = setInterval(() => { const now = Date.now(); gap = Math.max(gap, now - last); last = now; }, 100);
  setTimeout(() => { try { other.exec('COMMIT'); } catch { /* already done */ } }, 1200);
  const began = Date.now();
  await S.withStoreLock(() => S.upsertJobs([{ url: 'https://x/queued', title: 'Queued', company: 'Race' }]));
  clearInterval(timer);
  other.close();
  const took = Date.now() - began;
  ok('the write waited for the other writer, and no longer than it had to', took >= 1000 && took < 5000, `${took} ms`);
  ok('…and the event loop kept running meanwhile', gap < 600, `longest silence ${gap} ms`);
  ok('…and the write landed', !!S.findByUrl('https://x/queued'));
}

// TWO TRANSACTIONS AT ONCE IN ONE PROCESS (F-607). The server serves requests
// concurrently over one connection; the second BEGIN used to land inside the
// first's open transaction and die with "cannot start a transaction within a
// transaction".
console.log('\n🧪 two transactions at once in one process both land');
{
  const order = [];
  const one = S.withStoreLock(async () => { order.push('one in'); await nap(150); S.upsertJobs([{ url: 'https://x/one', title: 'One', company: 'Race' }]); order.push('one out'); });
  const two = S.withStoreLock(async () => { order.push('two in'); S.upsertJobs([{ url: 'https://x/two', title: 'Two', company: 'Race' }]); order.push('two out'); });
  const res = await Promise.allSettled([one, two]);
  ok('neither failed', res.every(r => r.status === 'fulfilled'), res.map(r => r.reason?.message).filter(Boolean).join(' | '));
  ok('…they ran one after the other', order.join(',') === 'one in,one out,two in,two out', order.join(','));
  ok('…and both wrote', !!S.findByUrl('https://x/one') && !!S.findByUrl('https://x/two'));
  const nested = await S.withStoreLock(() => S.withStoreLock(() => 'inner'));
  ok('a locked helper called inside a locked span joins it instead of waiting on itself', nested === 'inner');
}

// A PLAIN WRITE MADE WHILE A TRANSACTION IS BACKING OFF KEEPS ITS PATIENCE.
// The zero timeout is for the BEGIN attempt only; left on the shared
// connection, a status change pressed meanwhile failed at once as "locked".
console.log('\n🧪 a plain write during another write\'s back-off waits, it does not fail');
{
  const holder = path.join(path.dirname(process.env.JARVIS_DB_PATH), 'holder.mjs');
  writeFileSync(holder, [
    "import { DatabaseSync } from 'node:sqlite';",
    'const d = new DatabaseSync(process.argv[2]);',
    "d.exec('BEGIN IMMEDIATE');",
    "console.log('held');",
    "setTimeout(() => { d.exec('COMMIT'); d.close(); }, 1500);",
  ].join('\n'));
  const child = execFile(process.execPath, [holder, process.env.JARVIS_DB_PATH]);
  await new Promise((r) => child.stdout.once('data', r));
  const locked = S.withStoreLock(() => S.upsertJobs([{ url: 'https://x/backoff', title: 'Backoff', company: 'Race' }]));
  await nap(200);   // the transaction above is now between attempts
  let plain = 'ok';
  try { S.upsertJobs([{ url: 'https://x/plain', title: 'Plain', company: 'Race' }]); } catch (err) { plain = err.message; }
  await locked;
  ok('the plain write waited for the other process and landed', plain === 'ok' && !!S.findByUrl('https://x/plain'), plain);
  ok('…and the transaction landed too', !!S.findByUrl('https://x/backoff'));
}

const dir = path.dirname(process.env.JARVIS_DB_PATH);
S.closeDb();
rmSync(dir, { recursive: true, force: true });
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
