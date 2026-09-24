#!/usr/bin/env node
// jarvis/liveness-sweep.mjs — walk the deck and retire the postings that are dead.
//
// WHY THIS EXISTS
//
// Two measurements, and they are of different populations — worth keeping apart,
// because the first is the alarming one and the second is what this script can
// actually act on.
//
//   1. 25 random deck postings through check-liveness.mjs, which falls back to a
//      browser and so reaches Workday, Amazon, Oracle and Tesla as well:
//      **12 active, 9 expired, 4 uncertain**. Better than a third confirmed dead.
//   2. Every API-checkable deck posting (Greenhouse / Lever / Ashby — the ATSes
//      with a per-job API): **284 checked, 29 dead, 0 undecidable.**
//
// The gap between 36% and 10% is not a contradiction: this script deliberately
// uses only the API rung, and most of the dead ones in (1) were Workday and
// Amazon reqs it cannot ask about without a browser. The honest reading is that
// (2) is a floor.
//
// Nothing knew about any of it: 3,689 of 3,753 deck rows had never been
// liveness-checked at all.
//
// It shows up as apply runs that do nothing. Driving eight random deck postings
// through the apply engine, four were dead — Intel and Abbott (Workday both say
// "the page you are looking for doesn't exist"), a 1X Technologies req ("Job not
// found"), an Applied Materials req. The engine now recognises and records each
// of those, but only when he actually applies to one, which is the expensive
// moment to find out.
//
// THE ONE RULE THAT MATTERS
//
// A false "expired" is the expensive error — it makes him miss a real job — so
// this marks a posting gone ONLY on definitive evidence: the ATS's own API
// answering 404/410 for that requisition, or Ashby's board no longer listing it.
// `null` (rate-limited, 5xx, unparseable) and anything the API cannot decide are
// left completely alone. The browser fallback in check-liveness.mjs is
// deliberately NOT used here: "uncertain" must never become "gone", and this
// runs unattended.
//
// Usage:
//   node jarvis/liveness-sweep.mjs                 # API rung: fast, parallel
//   node jarvis/liveness-sweep.mjs --browser       # …plus a page load for the rest
//   node jarvis/liveness-sweep.mjs --limit 500
//   node jarvis/liveness-sweep.mjs --dry-run       # report only, write nothing
//   node jarvis/liveness-sweep.mjs --company kla
//   node jarvis/liveness-sweep.mjs --source smartrecruiters --browser
//
// The API rung covers Greenhouse, Lever, Ashby and Workday and finishes the deck
// in a couple of minutes. `--browser` reaches everything else — SmartRecruiters,
// the sitemap boards, Amazon — at one page load each and a single worker, so it
// is minutes per hundred. Run it periodically rather than waiting on it; the
// sweep is idempotent and resumes where it left off.

import { query, updateJob } from './store.mjs';
import { checkLivenessViaApi, isAtsPosting } from '../liveness-api.mjs';
import { chromium } from 'playwright';
import { checkUrlLiveness, newLivenessPage } from '../liveness-browser.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/liveness-sweep.mjs [options]

  Re-check whether stored postings are still live.

    --browser             
    --no-browser          API rung only, even with --picks (what the dashboard schedules)
    --company <value>     
    --picks               check YOUR OWN picks (inbox/queued/interested/applied)
    --concurrency <value> 
    --dry-run             
    --limit <value>       
    --source <value>      
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--browser","--no-browser","--company","--concurrency","--dry-run","--limit","--picks","--source"], valued: ["--company","--concurrency","--limit","--source"] });


function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i !== -1 ? a[i + 1] : undefined; };
  return {
    limit: get('--limit') != null ? Number(get('--limit')) : 200,
    company: get('--company')?.toLowerCase(),
    source: get('--source'),
    dryRun: a.includes('--dry-run'),
    // --picks turns the browser rung on, because his picks are mostly Workday
    // and Amazon; --no-browser takes it back off, which is what the dashboard
    // schedules — an unattended sweep must not open Chromium on his machine.
    browser: (a.includes('--browser') || a.includes('--picks')) && !a.includes('--no-browser'),
    picks: a.includes('--picks'),
    concurrency: get('--concurrency') != null ? Number(get('--concurrency')) : 3,
  };
}

/** Definitive death, as opposed to "we could not tell". */
function isDefinitelyGone(verdict) {
  if (!verdict || verdict.result !== 'expired') return false;
  // The API answered for THIS requisition: a 404/410, or an Ashby board that no
  // longer lists it. Anything else is not proof.
  if (/_api_gone$|_api_unlisted$/.test(verdict.code || '')) return true;
  // From the BROWSER rung, only an HTTP status counts. `http_gone` is the server
  // answering 404/410 for this URL.
  //
  // Its siblings are deliberately NOT accepted: `insufficient_content`,
  // `no_apply_control` and `listing_page` are heuristics about how a page LOOKS,
  // and every one of them fires on a live posting that renders slowly or hides
  // its Apply control behind a script. The 25-URL sample that started this work
  // had four "uncertain" verdicts of exactly that kind — including a Thermo
  // Fisher requisition that is live. Retiring those would be the expensive
  // error this whole script is built to avoid.
  // `expired_body` IS NOT ACCEPTED EITHER, and it took nearly shipping the
  // opposite to establish why.
  //
  // It looks like it should be: it fires on the posting's own words — "the page
  // you are looking for doesn't exist", "position has been filled" — which is a
  // statement rather than an inference about page shape, and 8 of the top 60
  // rows in his deck (13%, scoring 93-98) come back that way and can be retired
  // by nothing else today.
  //
  // Then two of those eight were opened in his own signed-in Chrome:
  //
  //   KLA    "Associate Test Engineer Trainee"   really is a 404, for him, today
  //   Jabil  "Automation Engineer I"             renders the JOB, with an Apply
  //                                              button, in Hendersonville NC
  //
  // Same verdict from the headless browser, opposite truths. Workday serves a
  // "doesn't exist" shell to a visitor it does not like and the real posting to
  // him — the same divergence as F-236, where headless got a 404 and his Chrome
  // got a migration banner. So `expired_body` FROM A HEADLESS BROWSER cannot
  // tell "this posting is gone" from "Workday declined to render for a bot",
  // and one of the two costs him a real job.
  //
  // The dead ones stay in the deck. That is the cheaper error, it is the rule
  // this whole script is built on, and the honest answer is that retiring a
  // Workday posting needs evidence this rung cannot produce.
  return false;
}

/**
 * Is this source's result a liveness finding, or a bug report?
 *
 * The check that was missing when this script retired 123 LIVE SmartRecruiters
 * postings. Its rule - retire only on a definitive HTTP 404 from the ATS - was
 * sound, and it was applied to URLs the SCANNER had built wrongly:
 * jobs.smartrecruiters.com/<slug>/postings/<id> 404s for postings that are live
 * at /<slug>/<id>-<title>. A 404 proves the URL is dead. It does not prove the
 * JOB is dead, and nothing here knew the difference.
 *
 * Real decay never reaches 100%. AMD's postings on jibeapply measured 5-of-6
 * dead in the same sweep and that IS honest expiry - checked against their API,
 * the URL format returns 200 on current requisitions. So the signal is not a
 * high rate, it is a TOTAL one over enough postings to mean something.
 */
export function isSuspectWholeSource(checked, dead) {
  return checked >= 8 && dead === checked;
}

async function main() {
  const opts = parseArgs();
  // `browsable`, NOT `deck`. There is no `deck` filter key — buildWhere maps the
  // deck column from `f.browsable` — and an unknown key is silently ignored, so
  // `{deck: true}` quietly returns the WHOLE STORE. The first run of this script
  // did exactly that: it reported sweeping the deck and swept 166,136 rows,
  // then reported a dead rate "of the deck" measured on a population that was
  // mostly not in it. The postings it retired were genuinely dead — the
  // definitive-evidence rule held — but the number attached to them was wrong.
  // HIS OWN PICKS ARE NOT IN THE DECK, which is why none of them were ever
  // swept. `browsable` means undecided — the pile he is still triaging. The
  // moment he queues or shortlists something it leaves that set, so the twenty
  // postings he actually cares about were the only ones nothing ever re-checked.
  //
  // That is backwards. A dead posting in the deck costs him one card; a dead
  // posting in his QUEUE costs him an application he was about to spend real
  // attention on — three of the five in his queue were Amazon reqs answering
  // 404. `--picks` sweeps those, and turns the browser rung on by default,
  // because his picks are mostly Workday and Amazon and the API rung cannot
  // reach either.
  //
  // The definitive-evidence rule is unchanged and matters more here, not less:
  // a false "expired" on a job he shortlisted is the expensive error.
  const filters = opts.picks ? {} : { browsable: true };
  if (opts.company) filters.company = opts.company;
  // `source` targets one discovery channel — used to finish off the sources the
  // API rung cannot reach, e.g. --source smartrecruiters --browser.
  if (opts.source) filters.source = opts.source;
  let { rows } = query(filters, { limit: 20000 });
  if (opts.picks) {
    // Three separate queries rather than one, because `status` takes a single
    // value. Applied is included deliberately: knowing a posting he applied to
    // has been pulled is worth as much as knowing one he has not.
    // The curated Inbox is the shortlist he reads first, and it was not
    // swept at all: "a lot of curated jobs are page not found" (2026-09-06).
    const mine = ['inbox', 'queued', 'interested', 'applied']
      .flatMap((status) => query({ ...filters, status }, { limit: 2000 }).rows);
    const seen = new Set();
    rows = mine.filter((j) => !seen.has(j.id) && seen.add(j.id));
  }

  // Only postings the API can answer for. `goneAt` is not carried on list rows,
  // so the deck filter above is what excludes the already-retired: a marked
  // posting has deck=0.
  // Without --browser this is the API rung only, which is cheap, parallel and
  // covers Greenhouse, Lever, Ashby and Workday. With it, everything else gets a
  // real page load — the only way to reach SmartRecruiters (no per-job API, and
  // four of four sampled were dead), sitemap boards and the rest.
  const candidates = (opts.browser ? rows : rows.filter(j => isAtsPosting(j.url)))
    .slice(0, opts.limit);

  console.log(`Sweeping ${candidates.length} ${opts.picks ? 'posting(s) you picked' : 'deck posting(s)'} against their ATS APIs`
    + `${opts.dryRun ? ' — DRY RUN, nothing will be written' : ''}.`);
  console.log('Only a definitive 404/410 (or an Ashby board that no longer lists it) retires a posting.\n');

  let gone = 0; let active = 0; let unknown = 0;
  const retired = [];

  // A SMALL pool. These are different hosts, so politeness is not the binding
  // constraint — Node's own HTTP client is. At six concurrent requests with
  // abort-on-timeout, undici throws `assert(!this.paused)` from inside its
  // socket handler: an asynchronous assertion no `.catch()` on the fetch can
  // see, which kills the whole run. Three is stable over the full deck.
  //
  // Writes are per-posting and the sweep is idempotent — a retired posting
  // leaves the deck, so it is not re-checked — so an interrupted run loses only
  // the work it had not done yet. Re-running resumes.
  // ONE browser page, shared, and therefore one worker when --browser is on:
  // page.goto is not reentrant, and a second worker would navigate the page out
  // from under the first.
  let browserHandle = null, page = null;
  if (opts.browser) {
    browserHandle = await chromium.launch({ headless: true });
    page = await newLivenessPage(browserHandle);
  }
  const queue = [...candidates];
  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      let verdict = await checkLivenessViaApi(job.url).catch(() => null);
      // The browser rung answers only for what the API could not, and only when
      // asked for: it is a page load per posting.
      if (!verdict && opts.browser && page) {
        verdict = await checkUrlLiveness(page, job.url).catch(() => null);
      }
      if (isDefinitelyGone(verdict)) {
        gone++;
        retired.push(job);
        // NOT written here — see the whole-source check after the sweep.
      } else if (verdict?.result === 'active') {
        active++;
      } else {
        unknown++;
      }
    }
  };
  const workers = opts.browser ? 1 : Math.max(1, opts.concurrency);
  await Promise.all(Array.from({ length: workers }, worker));
  if (browserHandle) await browserHandle.close().catch(() => {});

  // A SOURCE THAT IS 100% DEAD IS A BUG REPORT, NOT A LIVENESS RESULT.
  //
  // This is the check that was missing when this script retired 123 live
  // SmartRecruiters postings. Its rule — retire only on a definitive HTTP 404
  // from the ATS — was sound, and it was applied to URLs the SCANNER had built
  // wrongly: `jobs.smartrecruiters.com/<slug>/postings/<id>` 404s for postings
  // that are live at `/<slug>/<id>-<title>`. A 404 proves the URL is dead. It
  // does not prove the JOB is dead, and nothing here knew the difference.
  //
  // Real decay never reaches 100%. AMD's postings on jibeapply were 5-of-6 dead
  // in the same measurement and that IS honest expiry — checked, their URL
  // format returns 200 on current requisitions. So the signal is not a high
  // rate, it is a TOTAL one over enough postings to mean something.
  //
  // Retirements are therefore buffered and written at the end. An interrupted
  // run now writes nothing rather than half — the sweep is idempotent and
  // resumes, so that costs a re-run and buys the ability to look at a source as
  // a whole before believing it.
  const bySource = new Map();
  for (const j of candidates) {
    const e = bySource.get(j.source) || { checked: 0, dead: 0 };
    e.checked++;
    bySource.set(j.source, e);
  }
  for (const j of retired) bySource.get(j.source).dead++;

  const suspect = new Set();
  for (const [src, e] of bySource) {
    if (isSuspectWholeSource(e.checked, e.dead)) suspect.add(src);
  }
  const held = retired.filter(j => suspect.has(j.source));
  const toWrite = retired.filter(j => !suspect.has(j.source));

  if (suspect.size) {
    console.log('');
    console.log('WARNING: not retiring these - every posting checked was dead, which is a URL bug, not decay:');
    for (const src of suspect) {
      const e = bySource.get(src);
      console.log(`   ${src}: ${e.dead}/${e.checked} dead (100%). Check what URL its provider builds`);
      console.log('     against the ATS own API before believing this.');
    }
    console.log(`   ${held.length} posting(s) left in the deck.`);
    console.log('');
  }

  if (!opts.dryRun) {
    const at = new Date().toISOString();
    for (const j of toWrite) updateJob(j.id, { goneAt: at }, { rederive: true });
  }
  gone = toWrite.length;
  retired.length = 0;
  retired.push(...toWrite);

  if (retired.length) {
    console.log(`Retired ${retired.length} posting(s):`);
    for (const j of retired.slice(0, 40)) {
      console.log(`  · ${j.company} — ${String(j.title).slice(0, 60)}`);
    }
    if (retired.length > 40) console.log(`  … and ${retired.length - 40} more`);
    console.log('');
  }

  const checked = gone + active + unknown;
  const pct = checked ? Math.round((gone / checked) * 100) : 0;
  console.log(`${active} active · ${gone} dead (${pct}%) · ${unknown} the API could not decide`);
  if (opts.dryRun) console.log('\n(dry run — nothing was written)');
  else if (gone) console.log(`\n${gone} posting(s) marked gone; they leave the deck on the next query.`);
  console.log('Postings the API could not decide are left alone — a false "expired" costs him a real job.');
}

// Only when RUN, never when imported. `isSuspectWholeSource` is exported for
// its tests, and importing it used to execute the whole sweep — so the test
// suite hit the network and could write goneAt to his store. A test that
// mutates the thing it is testing is worse than no test.
if (import.meta.filename === process.argv[1]) await main();
