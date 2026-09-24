#!/usr/bin/env node
// jarvis/rescore.mjs — recompute the fit score for every job in the store.
//
// Fit is derived from config/profile.yml + cv.md, so it goes stale whenever
// those change: edit a target role, raise the salary floor, add a skill, and
// every stored score is answering the old question. Scanning again would
// refetch tens of thousands of postings to recompute a number that needs no
// network at all — this reads the store, rescores in place, and writes back.
//
// Run it after: editing your profile or CV, changing fit.mjs, or any
// enrichment batch that added descriptions.
//
// Usage:
//   node jarvis/rescore.mjs               # rescore everything
//   node jarvis/rescore.mjs --dry-run     # report the shift, write nothing
//   node jarvis/rescore.mjs --top 20      # also print the current top N

import { ids, getJob, putJob, query } from './store.mjs';
import { pathToFileURL } from 'url';
import { loadProfile, scoreFit, slimFit } from './fit.mjs';
import { triage } from './triage.mjs';
import { resolveSalary } from './salary-text.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/rescore.mjs [options]

  Recompute fit scores across the store.

    --after <value>
    --budget <value>
    --deck-only           only the postings you browse — see the note below
    --dry-run
    --retriage            also re-read each body through triage(): level,
                          years, visa verdict, graduation window. Needed after
                          any change to triage.mjs — fit alone will not move.
    --top <value>
    --help, -h

  AFTER EDITING preferences.md, WHICH ONE YOU NEED DEPENDS ON THE EDIT:

    ADDED a never/no rule   --deck-only is right. The postings it should hide
                            are in the deck, which is what that scores.

    REMOVED or NARROWED     run the FULL rescore, with no flag. A blocked row
    a rule                  is not in the deck, so --deck-only cannot reach the
                            rows the change was for and nothing appears to
                            happen. Measured on this store: 131,767 blocked
                            rows, 119,196 of them by your own rules.
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--after","--budget","--deck-only","--dry-run","--retriage","--top"], valued: ["--after","--budget","--top"] });


function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const topFlag = args.indexOf('--top');
  const topN = topFlag !== -1 ? Number(args[topFlag + 1]) || 20 : 0;

  // A full pass over 150,000 postings takes the better part of an hour, which
  // is longer than a supervising process is willing to wait — three runs were
  // killed partway, leaving the store half on the old scoring and half on the
  // new one, which is worse than either. So the pass is resumable and can be
  // told to stop while it is still winning:
  //
  //   --budget 480    stop after N seconds and print the cursor to resume from
  //   --after <id>    start after that id (ids sort stably, so this is a seek)
  //   --deck-only     just the postings he actually browses (~7x faster)
  //
  // The cursor is an id rather than an offset because the auto-scanner inserts
  // rows while this runs, and an offset would silently skip a row for every
  // insert that landed before it.
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
  const budgetMs = flag('--budget') ? Number(flag('--budget')) * 1000 : Infinity;
  const after = flag('--after') || '';
  const deckOnly = args.includes('--deck-only');
  // F-466. Fit is derived from the profile; LEVEL, YEARS, the visa verdict and
  // the graduation window are derived from the posting's own body by triage(),
  // and this pass never re-ran it. So a fix to the years extractor reached
  // every posting scanned after it and not one of the 278,000 already stored:
  // the reqs it was written for kept the label it gave them when they were
  // first read. `--retriage` re-reads the body through triage() as well. It is
  // the slower half of the pass, so it stays opt-in.
  const retriage = args.includes('--retriage');

  const profile = loadProfile();
  if (!profile.skills.size) {
    console.error('⚠  No skills detected from cv.md — fit scores will be weak.');
    console.error('   Check that cv.md exists and has a Skills section.');
  }

  // Ids first, then one job at a time: this pass writes every row it reads,
  // and a live query cannot be iterated while its rows are being updated.
  // WHAT HE HAS COMMITTED TO IS NOT IN THE DECK, AND NEEDS RE-READING MOST
  // (F-468).
  //
  // `browsable` is `deck = 1`, and isDeck() sets deck = 0 the moment a row is
  // hard-blocked. So the rows this pass most needs to revisit — a posting he
  // tracked, queued or applied to, whose work-authorisation verdict has since
  // turned — are precisely the ones --deck-only cannot see. Three General
  // Matter reqs sat in his inbox for five days carrying f_hard_block, and the
  // extension filled one of them, because nothing ever looked again.
  //
  // A few dozen rows either way, and they are the rows an error costs most.
  const COMMITTED = ['inbox', 'interested', 'queued', 'applied', 'responded', 'interview', 'offer'];
  const jobIds = [...new Set(deckOnly
    ? [...ids({ browsable: true }), ...ids({ status: COMMITTED })]
    : ids({}))]
    .sort()
    .filter(id => id > after);
  if (!jobIds.length) { console.log('Nothing left to score.'); return; }

  const bands = {};
  const moved = { up: 0, down: 0, same: 0 };
  let scored = 0;

  let payFound = 0;
  let yearsChanged = 0, yearsNewlyBarred = 0;
  const lateBlocks = [];
  const startedAt = Date.now();
  let cursor = after, ranOut = false, lockedOut = false;

  // A SCAN HOLDING THE WRITE LOCK MUST NOT THROW AWAY THE WHOLE PASS (F-483).
  //
  // `openDb` sets busy_timeout to 30s, which covers a query waiting behind
  // another query. It does not cover `jarvis/scan.mjs`, which holds the write
  // lock across 166,000 postings for tens of minutes — so the FIRST row this
  // pass tried to write threw `SQLITE_BUSY: database is locked`, as a raw
  // stack trace, and four thousand rows of work went with it.
  //
  // The pass is already resumable. So a lock is not an error here: it waits a
  // little, tries again, and if the scanner is genuinely settled in, it stops
  // cleanly at the row it reached and prints the command to resume.
  const writeJob = (job) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { putJob(job, { description: false }); return true; }
      catch (err) {
        if (!/lock|busy/i.test(String(err?.message || ''))) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * (attempt + 1));
      }
    }
    return false;
  };
  for (const id of jobIds) {
    if (Date.now() - startedAt > budgetMs) { ranOut = true; break; }
    cursor = id;
    // The score reads skills out of the description, so the body is needed —
    // but it has not changed, so it is not written back.
    const job = getJob(id, { description: true });
    if (!job) continue;
    const before = job.fit?.score;
    const beforeYears = job.triage?.experience?.years ?? null;
    const wasBlocked = job.triage?.flags?.hardBlock === true;
    if (retriage && job.description && job.description.length > 40) {
      job.triage = triage({
        title: job.title, description: job.description, location: job.location, url: job.url,
      });
      const nowYears = job.triage?.experience?.years ?? null;
      if (nowYears !== beforeYears) {
        yearsChanged++;
        if (beforeYears == null && nowYears != null && nowYears > 2) yearsNewlyBarred++;
      }
      // A ROW HE COMMITTED TO THAT CANNOT LEGALLY BE HIS IS NAMED, NOT COUNTED.
      // Nothing is moved or hidden — the decision to withdraw is his, and the
      // card carries the same flag — but a number in a summary is not a
      // warning, and this one cost him a filled application.
      if (job.triage?.flags?.hardBlock && COMMITTED.includes(job.status)) {
        lateBlocks.push({
          status: job.status, company: job.company, title: job.title,
          key: job.triage?.visa?.block?.key || 'work authorisation',
          quote: job.triage?.visa?.block?.quote || '',
          isNew: !wasBlocked,
        });
      }
    }
    const hadPay = !!job.salary;
    job.salary = resolveSalary(job);
    if (!hadPay && job.salary) payFound++;
    const fit = scoreFit(job, profile);
    job.fit = slimFit(fit);
    if (!dryRun && !writeJob(job)) { lockedOut = true; break; }
    scored++;
    bands[fit.bandLabel] = (bands[fit.bandLabel] || 0) + 1;
    if (before == null) continue;
    if (fit.score > before) moved.up++;
    else if (fit.score < before) moved.down++;
    else moved.same++;
  }

  console.log(ranOut ? `\n── Rescore paused (time budget reached) ──` : `\n── Rescore complete ──`);
  console.log(`  Jobs scored : ${scored}`);
  console.log(`  Skills known: ${profile.skills.size} (from cv.md)`);
  if (payFound) console.log(`  Pay parsed from description text: ${payFound} newly priced`);
  if (retriage) {
    console.log(`  Re-triaged            : ${yearsChanged} rows changed their years figure`);
    console.log(`  …of those, newly barred: ${yearsNewlyBarred} state more than 2 years where nothing was read before`);
  }
  if (lateBlocks.length) {
    console.log(`
  ⛔ ${lateBlocks.length} posting${lateBlocks.length === 1 ? '' : 's'} you have committed to state a work-authorisation requirement:`);
    for (const b of lateBlocks) {
      console.log(`     [${b.status}] ${b.company} — ${b.title}`);
      console.log(`        ${b.key}${b.isNew ? ' (new since the last pass)' : ''}`);
      if (b.quote) console.log(`        "${b.quote.slice(0, 150)}"`);
    }
    console.log(`
     Nothing was moved. Withdraw them from the board if you agree.`);
  }
  for (const [label, n] of Object.entries(bands).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(12)}: ${n}`);
  }
  if (moved.up || moved.down) {
    console.log(`  Changed     : ${moved.up} up, ${moved.down} down, ${moved.same} unchanged`);
  }
  if (dryRun) console.log('  (dry run — store not written)');

  if (lockedOut) {
    console.log('\n  ⏸  Another process holds the store — a scan writes for tens of minutes.');
    console.log(`     ${scored.toLocaleString()} rows were written before it stopped; nothing is half-done.`);
  }
  if (ranOut || lockedOut) {
    const left = jobIds.length - scored;
    console.log(`  Remaining   : ${left.toLocaleString()}`);
    console.log(`\n  Resume with:\n    node jarvis/rescore.mjs --after ${cursor}${deckOnly ? ' --deck-only' : ''} --budget ${Math.round(budgetMs / 1000)}`);
  }

  if (topN) {
    // Match what the dashboard actually shows by default. A leaderboard topped
    // by a Fall-2026 internship is noise — he graduates May 2027 and is taking
    // no more of them, which is exactly why the deck filters interns, hands-on
    // technician roles and non-US postings out. Two views of one number that
    // disagree is a bug this codebase has already paid for once.
    const open = query({
      fitBlocked: false,
      notStatus: 'hidden',
      intern: false,
      handsOn: false,
      locationBucket: ['us', 'remote', 'unknown'],
    }, { sort: 'fit', limit: topN }).rows;
    console.log(`\n  Top ${open.length} by fit (deck view — interns / technician / non-US excluded):`);
    for (const j of open) {
      console.log(`    ${String(j.fit.score).padStart(3)} ${j.fit.bandLabel.padEnd(11)} ${(j.company || '').slice(0, 18).padEnd(18)} ${(j.title || '').slice(0, 46)}`);
    }
  }
}

// ONLY WHEN RUN AS A COMMAND. Importing this module used to execute it — the
// class of fault recorded as F-181 (a test import overwrote his real backup)
// and F-182 (importing the apply engine opened a browser on real postings).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
