#!/usr/bin/env node
// jarvis/compact-store.mjs — repair a jobs.json that has grown too big to read.
//
// V8 caps a single string at ~512 MB (0x1fffffe8 chars). Past that,
// readFileSync(path,'utf-8') throws before JSON.parse ever runs, so the store
// becomes completely unreadable — not slow, not partial: unreadable. Every
// normal recovery path is closed at that point, because every one of them
// starts by reading the file into a string.
//
// This tool streams the file instead, extracting one job object at a time and
// writing a compacted copy. Nothing is ever held as one giant string.
//
// Compaction does two things:
//   1. Drops per-job `fit.breakdown` / `fit.reasons`. Those are recomputed on
//      demand for the single job being viewed; stored on ~95k jobs they were
//      ~150 MB of prose.
//   2. Writes without indentation (the old saveStore pretty-printed at two
//      spaces, which at this scale is >100 MB of whitespace).
//
// Usage:
//   node jarvis/compact-store.mjs                 # compact in place (keeps a .bak)
//   node jarvis/compact-store.mjs --dry-run       # report only
//   node jarvis/compact-store.mjs --in X --out Y

import { createReadStream, createWriteStream, existsSync, statSync, copyFileSync, renameSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/compact-store.mjs [options]

  Rewrite the store file, smaller.

    --dry-run             
    --in <value>          
    --out <value>         
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--dry-run","--in","--out"], valued: ["--in","--out"] });


const KEEP_FIT = ['score', 'band', 'bandLabel', 'confidence', 'blockers'];

function slim(job) {
  if (job && job.fit) {
    const f = job.fit;
    const kept = {};
    for (const k of KEEP_FIT) if (f[k] !== undefined) kept[k] = f[k];
    job.fit = kept;
  }
  return job;
}

/**
 * Walk the top-level {"jobs":{...}} map, yielding [id, jobObject] pairs.
 *
 * Brace counting has to be string-aware: a description containing `{` or an
 * escaped quote would otherwise desynchronise the scanner and corrupt every
 * job after it.
 */
async function streamJobs(inPath, onJob) {
  const stream = createReadStream(inPath, { encoding: 'utf-8', highWaterMark: 1 << 20 });

  let buf = '';
  let started = false;      // have we entered the "jobs" object?
  let done = false;         // has the jobs object closed?
  let tail = '';            // everything after the jobs object
  let i = 0;                // read cursor within buf

  const compact = () => { if (i > 0) { buf = buf.slice(i); i = 0; } };

  for await (const chunk of stream) {
    buf += chunk;

    if (done) { tail += chunk; continue; }

    if (!started) {
      const at = buf.indexOf('"jobs"');
      if (at === -1) { if (buf.length > 1 << 20) buf = buf.slice(-1024); continue; }
      const brace = buf.indexOf('{', at + 6);
      if (brace === -1) continue;
      i = brace + 1;
      started = true;
    }

    // Extract as many complete "id": {...} entries as the buffer allows.
    for (;;) {
      // Skip separators.
      while (i < buf.length && (buf[i] === ',' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === ' ' || buf[i] === '\t')) i++;
      if (i >= buf.length) break;

      if (buf[i] === '}') { // end of the jobs map
        done = true;
        tail = buf.slice(i + 1);
        break;
      }
      if (buf[i] !== '"') { i++; continue; }

      // Key.
      const keyEnd = buf.indexOf('"', i + 1);
      if (keyEnd === -1) break;              // need more data
      const id = buf.slice(i + 1, keyEnd);
      let j = keyEnd + 1;
      while (j < buf.length && (buf[j] === ':' || buf[j] === ' ')) j++;
      if (j >= buf.length) break;
      if (buf[j] !== '{') { i = j; continue; }

      // Balanced, string-aware scan of the value object.
      let depth = 0, inStr = false, esc = false, k = j, end = -1;
      for (; k < buf.length; k++) {
        const c = buf[k];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end === -1) break;                 // object spans past the buffer

      onJob(id, JSON.parse(buf.slice(j, end + 1)));
      i = end + 1;
    }
    compact();
    if (done) break;
  }
  stream.destroy();
  return tail;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const inFlag = args.indexOf('--in');
  const outFlag = args.indexOf('--out');
  const inPath = inFlag !== -1 ? args[inFlag + 1] : path.join('data', 'jarvis', 'jobs.json');
  const outPath = outFlag !== -1 ? args[outFlag + 1] : inPath;

  if (!existsSync(inPath)) { console.error(`No store at ${inPath}`); process.exit(1); }
  const sizeBefore = statSync(inPath).size;
  console.log(`Reading ${inPath} (${(sizeBefore / 1e6).toFixed(0)} MB) by streaming…`);

  const tmp = outPath + '.compact.tmp';
  const out = dryRun ? null : createWriteStream(tmp, { encoding: 'utf-8' });
  const write = (s) => { if (out && !out.write(s)) return new Promise(r => out.once('drain', r)); };

  let n = 0, hadBreakdown = 0;
  const statuses = {};
  if (!dryRun) await write('{"version":1,"jobs":{');

  const tail = await streamJobs(inPath, (id, job) => {
    if (job.fit && (job.fit.breakdown || job.fit.reasons)) hadBreakdown++;
    statuses[job.status || 'new'] = (statuses[job.status || 'new'] || 0) + 1;
    slim(job);
    if (!dryRun) {
      if (n) out.write(',');
      out.write(JSON.stringify(id) + ':' + JSON.stringify(job));
    }
    n++;
    if (n % 20000 === 0) process.stderr.write(`  … ${n} jobs\n`);
  });

  // The tail holds scans / hiddenCompanies — small enough to parse normally.
  let scans = [], hidden = [];
  try {
    const parsed = JSON.parse('{' + tail.replace(/^\s*,/, '').replace(/\}\s*$/, '') + '}');
    if (Array.isArray(parsed.scans)) scans = parsed.scans;
    if (Array.isArray(parsed.hiddenCompanies)) hidden = parsed.hiddenCompanies;
  } catch {
    console.error('  ⚠ could not parse the trailing scans/hiddenCompanies — they will be reset.');
  }

  if (!dryRun) {
    out.write('},"scans":' + JSON.stringify(scans) + ',"hiddenCompanies":' + JSON.stringify(hidden) + '}');
    await new Promise(r => out.end(r));
  }

  console.log(`\n── Compaction ${dryRun ? '(dry run) ' : ''}──`);
  console.log(`  Jobs recovered   : ${n}`);
  console.log(`  Had fit breakdown: ${hadBreakdown}`);
  console.log(`  Scans kept       : ${scans.length}, hidden companies: ${hidden.length}`);
  console.log(`  Statuses         : ${Object.entries(statuses).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (dryRun) { console.log('  (dry run — nothing written)'); return; }

  const sizeAfter = statSync(tmp).size;
  // Never destroy the original until the replacement is known-good.
  if (n === 0) { console.error('  ✗ recovered 0 jobs — refusing to replace the original.'); process.exit(1); }
  if (outPath === inPath) {
    const bak = inPath + '.bak-precompact';
    copyFileSync(inPath, bak);
    console.log(`  Original kept at : ${bak}`);
  }
  renameSync(tmp, outPath);
  console.log(`  ${(sizeBefore / 1e6).toFixed(0)} MB → ${(sizeAfter / 1e6).toFixed(0)} MB  (${outPath})`);
}

// ONLY WHEN RUN AS A COMMAND. Importing this module used to execute it — the
// class of fault recorded as F-181 (a test import overwrote his real backup)
// and F-182 (importing the apply engine opened a browser on real postings).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
