#!/usr/bin/env node
// jarvis/clean-descriptions.mjs — re-clean every description already in the store.
//
// The HTML→text converter was wrong for as long as the store has existed: it
// stripped tags before decoding entities, so every Greenhouse body (which
// arrives entity-encoded) had its markup RE-CREATED as literal text instead of
// removed. Nearly half the descriptions in the store are unreadable because of
// it, and the postings they belong to will mostly never be fetched again.
//
// Refetching 35,000 postings to fix a string bug would be absurd — the correct
// text is already in the database, wrapped in markup. This pass unwraps it.
//
// It also re-runs triage and the pay parser on the cleaned text, because both
// read the description: a "will not sponsor" line hidden inside a tag soup and
// a pay range split across three <span>s were invisible to them before.
//
// Usage:
//   node jarvis/clean-descriptions.mjs             # clean, re-triage, re-price
//   node jarvis/clean-descriptions.mjs --dry-run   # report only, write nothing
//   node jarvis/clean-descriptions.mjs --limit 500 # bounded first pass

import { ids, getJob, putJob } from './store.mjs';
import { htmlToText, needsCleaning } from './text.mjs';
import { triage } from './triage.mjs';
import { resolveSalary } from './salary-text.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/clean-descriptions.mjs [options]

  Strip boilerplate out of stored descriptions.

    --dry-run             
    --limit <value>       
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--dry-run","--limit"], valued: ["--limit"] });


const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const limitFlag = args.indexOf('--limit');
const LIMIT = limitFlag !== -1 ? Number(args[limitFlag + 1]) || Infinity : Infinity;

const jobIds = ids();
console.log(`Scanning ${jobIds.length.toLocaleString()} jobs for markup left in the description${DRY ? ' (dry run)' : ''}…`);

let read = 0, dirty = 0, shrunkBytes = 0, newBlocks = 0, newPay = 0, examples = 0;

for (const id of jobIds) {
  if (dirty >= LIMIT) break;
  const job = getJob(id, { description: true });
  if (!job?.description) continue;
  read++;
  if (!needsCleaning(job.description)) continue;

  const cleaned = htmlToText(job.description);
  if (!cleaned || cleaned === job.description) continue;
  dirty++;
  shrunkBytes += job.description.length - cleaned.length;

  const hadBlock = !!job.triage?.flags?.hardBlock;
  const hadPay = Number.isFinite(job.salary?.max);

  job.description = cleaned;
  job.triage = triage({ title: job.title, description: cleaned, location: job.location, url: job.url });
  // resolveSalary keeps a structured ATS figure if one exists; only the
  // text-derived case can change here.
  job.salary = resolveSalary({ ...job, salary: hadPay ? job.salary : null });

  if (!hadBlock && job.triage.flags.hardBlock) {
    newBlocks++;
    if (newBlocks <= 5) console.log(`  ⛔ now blocked: ${job.title} (${job.company}) — ${job.triage.visa.block.reason}`);
  }
  if (!hadPay && Number.isFinite(job.salary?.max)) newPay++;

  if (examples < 3) {
    examples++;
    console.log(`  ✂  ${job.company} — ${job.title}\n     now: ${JSON.stringify(cleaned.slice(0, 110))}`);
  }

  // The description IS the change, so unlike retriage/rescore this pass writes it.
  if (!DRY) putJob(job, { description: true });
}

console.log(`\n── Description cleanup ──`);
console.log(`  Read              : ${read.toLocaleString()}`);
console.log(`  Carried markup    : ${dirty.toLocaleString()}`);
console.log(`  Bytes removed     : ${(shrunkBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  New work-auth blocks found in newly-readable text : ${newBlocks.toLocaleString()}`);
console.log(`  Pay ranges newly parseable                        : ${newPay.toLocaleString()}`);
console.log(DRY ? '\nDry run — nothing written.' : '\nStore updated.');
