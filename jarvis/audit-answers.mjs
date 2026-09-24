#!/usr/bin/env node
// jarvis/audit-answers.mjs — read every question on a real form, and every
// answer this engine would give it, side by side.
//
// WHY THIS EXISTS. Six separate bugs in this project have had one shape: a rule
// matches a phrase while the question asks something else. "…years of
// experience, please briefly EXPLAIN" answered "2 years". "Export control"
// claimed the embargoed-country list. "Which locations are you open to
// RELOCATING to" answered "Yes". "Are you BONDED BY your current company"
// answered with the employer's name. Each was found by tripping over it.
//
// The sixth was found differently — by resolving all 109 labels from five live
// forms in one pass and reading the column of answers. That took ten minutes
// and caught "How many years of experience in the SOFTWARE INDUSTRY do you
// have?" being answered "2 years" on the form of a software company.
//
// So this is that pass, as a command. Nothing here fills anything: it opens the
// forms read-only, asks what would be answered, and prints it. The point is to
// be READ — a wrong answer is obvious to a human scanning a list and invisible
// in a form that quietly submits.
//
// Usage:
//   npm run jarvis:audit -- --url <posting> [--url <posting> …]
//   npm run jarvis:audit -- --queued          # every posting you have queued
//   npm run jarvis:audit -- --queued --review # only the review-flagged answers

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';

import { query } from './store.mjs';
import { planForm, loadApplyProfile } from './apply-plan.mjs';
import { guardArgs } from './cli.mjs';

const USAGE = `
  npm run jarvis:audit -- [options]

  Print every question on a form beside the answer this engine would give it.
  Opens the pages read-only and fills nothing.

    --url <url>    audit this posting (repeatable)
    --queued       audit every posting with status=queued
    --review       show only the answers flagged for review
    --help, -h     print this
`;

guardArgs({ usage: USAGE, flags: ['--url', '--queued', '--review'], valued: ['--url'] });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCOVER = readFileSync(path.join(HERE, 'extension', 'discover.js'), 'utf-8');

/**
 * Every field label a real browser can see, FOLLOWING Apply if it has to.
 *
 * The first version of this read whatever was at the URL and said "no
 * application fields on this page" when it found none. Pointed at his actual
 * queue that produced five identical useless lines, because a queue holds
 * POSTINGS — pages with an Apply button and no form. Two of them were also
 * dead, and it did not say so.
 *
 * The filler already knows all of these apart: a posting to follow, a wall to
 * stop at, a bot check to refuse, a page that is gone. An auditor that does not
 * is answering a different question from the one the filler will face.
 *
 * Clicking Apply is a navigation, not a fill — nothing is typed here.
 */
async function labelsOn(browser, url) {
  const page = await browser.newPage();
  const read = async () => {
    await page.evaluate(DISCOVER);
    return page.evaluate(() => ({
      fields: globalThis.__jarvis.discover().map(({ elements, ...f }) => f),
      gone: globalThis.__jarvis.postingGone(),
      blocked: globalThis.__jarvis.pageBlocked(),
      wall: globalThis.__jarvis.signInWall(),
      moved: globalThis.__jarvis.atsMoved(),
      gate: !!globalThis.__jarvis.startGate(),
      apply: globalThis.__jarvis.applyControl()
        ? (globalThis.__jarvis.applyControl().textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)
        : null,
    }));
  };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Long enough for the JS-rendered ATS forms; Eightfold is the slowest.
    await page.waitForTimeout(8000);
    let seen = await read();

    // GETTING TO THE FORM TAKES MORE THAN ONE CLICK, and this used to allow
    // exactly one of each in a fixed order: gate, then Apply, then stop.
    //
    // Intel and KLA both need the other order. Their posting page has an Apply
    // link and NO gate, so the gate check ran first and found nothing; clicking
    // Apply then opens Workday's "Apply Manually" modal — which is the gate,
    // now on screen, with the check that would have clicked it already spent.
    // Both audited as "no application fields, and no Apply control to follow",
    // which was doubly wrong: there was an Apply control, and it had been
    // followed. It stopped one click short of the form.
    //
    // A short loop instead. Each pass clicks whichever way forward exists and
    // re-reads; it stops as soon as there is something to answer, or when there
    // is nothing left to click. Bounded, because a page that keeps offering the
    // same control after being clicked is a loop, not progress.
    //
    // A file upload is not something anyone ANSWERS — an Eightfold posting
    // carries one ("upload your resume to see how you match") and that single
    // control was enough to stop this following Apply Now at all.
    const answerable = (s) => s.fields.filter((f) => f.type !== 'file').length;
    for (let step = 0; step < 3 && !answerable(seen); step += 1) {
      if (seen.gate) {
        await page.evaluate(() => globalThis.__jarvis.startGate()?.click());
        await page.waitForTimeout(6000);
      } else if (seen.apply) {
        await page.evaluate(() => globalThis.__jarvis.applyControl()?.click());
        await page.waitForTimeout(8000);
      } else {
        break;
      }
      const before = seen;
      seen = await read();
      // Nothing moved: same page, same controls. Clicking again would only
      // repeat it, and a stuck auditor is worse than an honest "no".
      if (!answerable(seen) && seen.gate === before.gate && seen.apply === before.apply
        && seen.fields.length === before.fields.length) break;
    }

    // ORDER MATTERS, AND FIELDS COME LAST.
    //
    // This asked "are there fields?" first, so a page with one field on it was
    // reported as a one-question application no matter what kind of page it
    // was. Following Amazon's Apply lands on a login page carrying exactly one
    // control — an email box — and five of his saved Amazon postings audited
    // as `Email: <his address>` and nothing else (F-233).
    //
    // The filler already gets this right: it checks signInWall() before it
    // discovers anything, which is why it stops and says "sign in here" rather
    // than typing into a login form. An auditor that answers a different
    // question from the one the filler will face is worse than no auditor.
    if (seen.gone) return { note: `this posting is gone — the page says "${seen.gone}"` };
    if (seen.blocked) return { note: seen.blocked.why };
    // Before the wall: a migrated tenant looks exactly like one (a Sign In
    // link, no form fields), and "sign in here" sends him somewhere that
    // cannot accept an application (F-236).
    if (seen.moved) {
      return { note: `this employer has moved to a different system — ${seen.moved.why}${seen.moved.link ? ` (${seen.moved.link})` : ''}` };
    }
    if (seen.wall) return { note: 'this ATS wants you signed in before it shows the form' };
    if (seen.fields.length) return seen.fields;
    return { note: 'no application fields, and no Apply control to follow' };
  } catch (e) {
    return { note: `could not read it: ${String(e?.message || e).split('\n')[0].slice(0, 70)}` };
  } finally {
    await page.close();
  }
}

export async function audit({ urls, reviewOnly = false, log = console.log } = {}) {
  const profile = loadApplyProfile();
  const browser = await chromium.launch();
  // Required and optional were counted together, so a form answered in full
  // except for two blank OPTIONAL boxes reported "2 left to you" — the same
  // shape as two required questions the engine could not handle (F-240).
  const totals = { answered: 0, review: 0, unanswered: 0, optional: 0 };
  try {
    for (const url of urls) {
      log(`\n### ${url}`);
      const fields = await labelsOn(browser, url);
      if (fields.note) { log(`    ${fields.note}`); continue; }

      for (const a of planForm(fields, profile).actions) {
        const answered = ['fill', 'select', 'prompt', 'check'].includes(a.action);
        if (answered) { totals.answered += 1; if (a.review) totals.review += 1; }
        else if (a.action === 'unknown') { if (a.optional) totals.optional += 1; else totals.unanswered += 1; }
        if (reviewOnly && !a.review) continue;
        const label = String(a.label || '(no label)').replace(/\s+/g, ' ').slice(0, 62);
        const value = answered ? JSON.stringify(a.value ?? '(ticked)') : `— ${a.why || a.action}`;
        log(`  ${a.review ? '!' : ' '} ${label.padEnd(64)} ${String(value).slice(0, 46)}`);
      }
    }
  } finally {
    await browser.close();
  }
  return totals;
}

async function main() {
  const argv = process.argv.slice(2);
  const urls = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--url' && argv[i + 1]) urls.push(argv[i + 1]);
  if (argv.includes('--queued')) {
    for (const j of query({ status: 'queued' }, { limit: 200, full: true }).rows) {
      if (j.url) urls.push(j.url);
    }
  }
  if (!urls.length) {
    console.error('Nothing to audit. Pass --url <posting>, or --queued to use your queue.\n');
    process.exit(1);
  }

  const totals = await audit({ urls, reviewOnly: argv.includes('--review') });
  const opt = totals.optional ? `, ${totals.optional} optional left blank` : '';
  console.log(`\n  ${totals.answered} answered (${totals.review} flagged for review), ${totals.unanswered} left to you${opt}.`);
  console.log('  Lines marked ! are the ones worth reading twice: they are answers');
  console.log('  about work authorisation, EEO, salary and export control.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
