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

import { query, updateJob, getJob, db as storeDb, STORE_DIR } from './store.mjs';
import { readPicksAndBoards, readDeckAndBoards, readGonePicksAndBoards, readGoneListedAgain, revivedPicks, rotateGonePicks, unlistedPicks, UNLISTED_DAYS } from './unlisted.mjs';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { checkLivenessViaApi, isAtsPosting, classifyDirectStatus, directStatus } from '../liveness-api.mjs';
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

const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

/** A posting URL with its id segments blanked: /jobs/3726/job → /jobs/* /job, per host. */
export function urlShape(url) {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.split('/').map((seg) => (/\d/.test(seg) ? '*' : seg.toLowerCase())).join('/')}`;
  } catch { return ''; }
}

/**
 * Rows no API answers for and a browser never reaches unattended (F-762):
 * `source: browser-assist` (Tesla, Joby's iCIMS board, Symbotic's own site).
 * Picked round-robin across hosts, so Tesla's 8,000 rows cannot crowd out
 * Joby's and Symbotic's, stalest first within each host.
 */
export function pickDirectRows(rows, limit) {
  const byHost = new Map();
  for (const j of rows) {
    if (j.source !== 'browser-assist' || isAtsPosting(j.url)) continue;
    const h = hostOf(j.url);
    if (!h) continue;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(j);
  }
  const lists = [...byHost.values()];
  const out = [];
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i]);
  }
  return out;
}

/**
 * The direct rung over one host's rows (F-762). One request at a time, `gapMs`
 * apart; the first refusal (403, 429, 5xx, no answer) ends that host for the
 * run — Tesla answers every server request 403 and must be asked once, not
 * eight thousand times. A 404 counts only when another posting of the SAME
 * URL SHAPE on that host answered 200 in the same pass: then the address
 * pattern still works and this requisition is the one that went. A front page
 * answering 200 is not enough — Symbotic's own careers pages 404 R6971, which
 * its Workday board still lists (checked 2026-10-18).
 *
 * @returns {Promise<{gone: {job, verdict}[], asked: number, undecided: number, refusedAt: number|null}>}
 */
export async function sweepHostDirect(jobs, { status = directStatus, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 1000 } = {}) {
  const seen = [];
  let refusedAt = null;
  for (let i = 0; i < jobs.length; i++) {
    if (i) await sleep(gapMs);
    const s = await status(jobs[i].url);
    if (classifyDirectStatus(s)?.refused) { refusedAt = s; break; }
    seen.push({ job: jobs[i], s });
  }
  const liveShapes = new Set(seen.filter((x) => x.s === 200).map((x) => urlShape(x.job.url)));
  const gone = [];
  for (const { job, s } of seen) {
    const v = classifyDirectStatus(s, { hostAnswers: liveShapes.has(urlShape(job.url)) });
    if (v?.result === 'expired') gone.push({ job, verdict: v });
  }
  return { gone, asked: seen.length, undecided: jobs.length - gone.length, refusedAt };
}

/**
 * The whole-host guard for the direct rung. A host where EVERY posting checked
 * 404s is a URL bug until shown otherwise (the 123 SmartRecruiters postings);
 * a host answering 410 for every one is a board that was shut down on purpose
 * (Joby's iCIMS tenant), and that is retired.
 */
export function holdWholeHost(checked, gone) {
  if (!isSuspectWholeSource(checked, gone.length)) return false;
  return gone.some((g) => g.verdict.status !== 410);
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
  // Partial and case-blind ("--company kla" is the documented use): the store's
  // `company` filter is exact, so a lowercased name matched nothing (F-710).
  if (opts.company) filters.companyLike = opts.company;
  // `source` targets one discovery channel — used to finish off the sources the
  // API rung cannot reach, e.g. --source smartrecruiters --browser.
  if (opts.source) filters.source = opts.source;
  // STALEST FIRST (2026-10-16). The default order is fit, so the daily 1,500
  // were the same top-fit postings every day — listed on their boards that
  // morning, live, checked again — and the rows least recently listed, the ones
  // most likely dead, never came up.
  let { rows } = query(filters, { limit: 40000, sort: 'stalest' });
  if (opts.picks) {
    // Three separate queries rather than one, because `status` takes a single
    // value. Applied is included deliberately: knowing a posting he applied to
    // has been pulled is worth as much as knowing one he has not.
    // The curated Inbox is the shortlist he reads first, and it was not
    // swept at all: "a lot of curated jobs are page not found" (2026-09-06).
    const mine = ['inbox', 'queued', 'interested', 'applied']
      .flatMap((status) => query({ ...filters, status }, { limit: 2000 }).rows);
    const seen = new Set();
    // ALREADY RETIRED IS NOT NEWS (2026-09-24): every sweep re-checked the picks
    // it had marked gone before and listed them as "retired" again, so the same
    // fourteen names came back run after run and read like a resurrection.
    rows = mine.filter((j) => !seen.has(j.id) && seen.add(j.id) && !getJob(j.id)?.goneAt);
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

  // THE DIRECT RUNG (F-762): browser-assist rows, one plain GET each, only
  // when no browser runs (with --browser they went through the page load
  // above). A 410 retires; a 404 retires only beside a 200 from the same host;
  // a 403 retires nothing and ends that host for the run.
  if (!opts.browser) {
    const direct = pickDirectRows(rows, opts.limit);
    if (direct.length) {
      const byHost = new Map();
      for (const j of direct) {
        const h = hostOf(j.url);
        if (!byHost.has(h)) byHost.set(h, []);
        byHost.get(h).push(j);
      }
      console.log(`Direct check of ${direct.length} browser-assist posting(s) on ${byHost.size} host(s) — 410 is gone, 404 only beside a 200 from the same host, a 403 decides nothing.`);
      const hosts = [...byHost.entries()];
      const lanes = Math.max(1, Math.min(opts.concurrency, hosts.length));
      const results = [];
      await Promise.all(Array.from({ length: lanes }, async () => {
        for (;;) {
          const next = hosts.shift();
          if (!next) return;
          const [h, jobs] = next;
          const r = await sweepHostDirect(jobs).catch(() => ({ gone: [], undecided: jobs.length, refusedAt: null }));
          results.push({ h, jobs, ...r });
        }
      }));
      for (const r of results) {
        const checkedHere = r.jobs.length;
        if (r.refusedAt !== null) console.log(`   ${r.h}: answered ${r.refusedAt || 'nothing'} — not asked again this run; nothing retired from a refusal.`);
        if (holdWholeHost(r.asked ?? 0, r.gone)) {
          console.log(`   ${r.h}: every posting 404s (${r.gone.length}/${checkedHere}) — a URL bug until shown otherwise; left alone.`);
          unknown += checkedHere;
          continue;
        }
        const already = new Set(toWrite.map((j) => j.id));
        for (const g of r.gone) if (!already.has(g.job.id)) toWrite.push(g.job);
        unknown += checkedHere - r.gone.length;
        if (r.gone.length) console.log(`   ${r.h}: ${r.gone.length} of ${checkedHere} gone (${[...new Set(r.gone.map((g) => g.verdict.status))].join('/')})`);
      }
      console.log('');
    }
  }

  // THE BOARD STOPPED LISTING IT (jarvis/unlisted.mjs, 2026-09-24): for the
  // picks no API can answer for, absence from a freshly read board is the
  // evidence that is left. The deck too since 2026-10-16 (see unlisted.mjs).
  if (!opts.company && !opts.source) {
    try {
      const { picks, boards } = (opts.picks ? readPicksAndBoards : readDeckAndBoards)(storeDb());
      const byId = new Map(picks.map((p) => [p.id, p]));
      const already = new Set(toWrite.map((j) => j.id));
      const gone = unlistedPicks(picks, boards).filter((u) => !already.has(u.id));
      if (gone.length) {
        console.log(`${gone.length} ${opts.picks ? 'pick(s)' : 'deck posting(s)'} their own board has not listed for ${UNLISTED_DAYS}+ days:`);
        gone.forEach((u, i) => {
          const p = byId.get(u.id);
          if (opts.picks || i < 40) console.log(`  · ${p.company} — ${String(p.title).slice(0, 60)} (${u.days} days)`);
          toWrite.push(p);
        });
        if (!opts.picks && gone.length > 40) console.log(`  … and ${gone.length - 40} more`);
        console.log('');
      }
    } catch (e) { console.log(`(board-listing check skipped: ${e.message})`); }
  }

  if (!opts.dryRun) {
    const at = new Date().toISOString();
    // A scan or enrich holding the store past the 30 s busy timeout killed the
    // first deck run 1,348 rows into 1,889 (2026-10-16). Wait it out instead.
    for (const j of toWrite) {
      for (let tries = 0; ; tries += 1) {
        try { updateJob(j.id, { goneAt: at }, { rederive: true }); break; } catch (e) {
          if (e?.errcode !== 5 || tries >= 20) throw e;
          await new Promise((r) => setTimeout(r, 15000));
        }
      }
    }
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

  // HIS GONE PICKS, ASKED AGAIN (2026-11-03). Each --picks run rechecks the
  // picks already marked gone; one the ATS calls active, and its own board
  // still lists, comes back. The rest stay closed (shown folded on the
  // dashboard, never deleted). Nothing is reported unless something changed.
  let revived = [];
  // The deck sweep asks the same of every other row its board listed again.
  if (!opts.company && !opts.source) {
    try {
      const { picks: gonePicks, boards } = (opts.picks ? readGonePicksAndBoards : readGoneListedAgain)(storeDb());
      const checkedFile = path.join(STORE_DIR, opts.picks ? 'gone-recheck.json' : 'gone-recheck-deck.json');
      let checked = {};
      try { checked = JSON.parse(readFileSync(checkedFile, 'utf8')); } catch { /* first run */ }
      const ask = rotateGonePicks(gonePicks.filter((p) => isAtsPosting(p.url)), checked, opts.limit);
      const verdicts = new Map();
      const q = [...ask];
      await Promise.all(Array.from({ length: Math.max(1, Math.min(3, opts.concurrency)) }, async () => {
        for (let p; (p = q.shift());) verdicts.set(p.id, await checkLivenessViaApi(p.url).catch(() => null));
      }));
      if (!opts.dryRun) {
        const at = new Date().toISOString();
        for (const p of ask) if (verdicts.get(p.id)) checked[p.id] = at;
        const live = new Set(gonePicks.map((p) => p.id));
        for (const id of Object.keys(checked)) if (!live.has(id)) delete checked[id];
        try { writeFileSync(checkedFile, JSON.stringify(checked)); } catch { /* next run starts over */ }
      }
      const back = new Set(revivedPicks(ask, boards, verdicts));
      revived = ask.filter((p) => back.has(p.id));
      if (!opts.dryRun) {
        for (const p of revived) {
          for (let tries = 0; ; tries += 1) {
            try { updateJob(p.id, { goneAt: null }, { rederive: true }); break; } catch (e) {
              if (e?.errcode !== 5 || tries >= 20) throw e;
              await new Promise((r) => setTimeout(r, 15000));
            }
          }
        }
      }
      console.log(`Rechecked ${ask.length} of ${gonePicks.length} ${opts.picks ? "pick(s) already marked gone" : "closed row(s) their board listed again"}`
        + `${revived.length ? `: ${revived.length} open again` : ': all still closed or undecided'}.`);
      for (const p of revived) console.log(`  · back: ${p.company} — ${String(p.title).slice(0, 60)}`);
      console.log('');
    } catch (e) { console.log(`(gone-pick recheck skipped: ${e.message})`); }
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
