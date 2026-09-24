#!/usr/bin/env node
// jarvis/import-handshake.mjs — his university's Handshake feed.
//
// WHY HANDSHAKE IS WORTH A SOURCE OF ITS OWN
// ──────────────────────────────────────────
// Every other source here is an employer's public board. Handshake is the
// opposite: a feed scoped to HIM — his school, his degree, his year — carrying
// postings employers file specifically to reach students, a good part of which
// never appear on a public board at all. Measured 2026-09-19, 5,223 results for
// "mechanical engineer" alone.
//
// It also states, per posting and in plain words, the thing every other source
// makes us infer from prose: whether the employer is "Open to candidates with
// OPT/CPT". That single line is worth more to him than most of a job
// description.
//
// WHY THE INPUT IS SCRAPED, NOT FETCHED
// ─────────────────────────────────────
// There is a JSON endpoint, /stu/postings.json, and it is a trap. It answers,
// it looks right, and it is a stale archive: 792 postings dated 2015-2023, not
// one of which the live UI was showing at the same moment. Expiry cannot catch
// them either — those dead rows carry closing dates years out, one in 2028. So
// the live search page is the source, and `jarvis/handshake-harvest.js` reads
// what it renders. That file explains the rest.
//
// This script parses that harvest. Each row arrives as two blocks of rendered
// text — the result card and the detail pane — so the parsing here is the
// interesting part, and it is what the tests cover.
//
// Usage:
//   node jarvis/import-handshake.mjs <harvest.json> --dry-run
//   node jarvis/import-handshake.mjs <harvest.json>

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { guardArgs } from './cli.mjs';
import { triage } from './triage.mjs';
import { upsertJobs, db } from './store.mjs';
import { companyKey, NEVER_TRACK } from './discover-linkedin.mjs';
import { titleOverlap } from './import-linkedin.mjs';

const USAGE = `
  node jarvis/import-handshake.mjs <harvest.json> [options]

  Import a Handshake harvest taken with jarvis/handshake-harvest.js.

    --dry-run          report what would be imported, write nothing
    --limit <n>        stop after n postings
    --json             machine-readable output
`;

/** A Handshake posting's page, which is where he would apply. */
export function jobUrl(postingId) {
  return `https://app.joinhandshake.com/job-search/${postingId}`;
}

/**
 * Annualise a rendered pay band: "$80–90K/yr", "$25-30/hr", "$100K/yr".
 *
 * The unit is the whole meaning. 25 on an hourly band is $52,000 and clears his
 * floor; read as yearly it is $25 and the posting is filtered out of every
 * pay-aware view. An unrecognised unit returns null rather than a guess,
 * because no answer is recoverable and a wrong one is not.
 *
 * Handshake writes the range with an EN DASH, not a hyphen, and the two are
 * different characters — matching only the hyphen silently loses the maximum
 * on every banded posting.
 */
export function parsePayBand(text) {
  const m = String(text || '').match(
    /\$\s*([\d,.]+)\s*([KkMm])?\s*(?:[–—-]\s*\$?\s*([\d,.]+)\s*([KkMm])?)?\s*\/\s*(yr|year|hr|hour|mo|month|wk|week)/,
  );
  if (!m) return null;
  const scale = s => (/[Kk]/.test(s || '') ? 1000 : /[Mm]/.test(s || '') ? 1e6 : 1);
  const num = (v, s) => (v === undefined ? null : Math.round(parseFloat(String(v).replace(/,/g, '')) * scale(s)));
  const unit = m[5].toLowerCase();
  const factor = /^(yr|year)/.test(unit) ? 1
    : /^(hr|hour)/.test(unit) ? 2080
      : /^(mo|month)/.test(unit) ? 12
        : 52;
  // A bare "$80K/yr" has no maximum. The suffix on the FIRST number applies to
  // the second when the second has none: "$80–90K/yr" means 80K to 90K, not
  // 80 to 90,000.
  const minRaw = num(m[1], m[2] || m[4]);
  const maxRaw = m[3] === undefined ? null : num(m[3], m[4] || m[2]);
  if (minRaw === null && maxRaw === null) return null;
  return {
    min: minRaw === null ? null : minRaw * factor,
    max: maxRaw === null ? null : maxRaw * factor,
    currency: 'USD',
  };
}

/**
 * Read the result card.
 *
 * Rendered as employer, title, then an optional "pay · employment type" line,
 * then location. The pay line is genuinely optional — plenty of postings omit
 * it — so the lines are identified by shape rather than by index. Counting
 * positions would shift the location into the title on every unpaid posting.
 */
export function parseCard(cardText) {
  const lines = String(cardText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const out = { employer: lines[0] || '', title: lines[1] || '', pay: '', employmentType: '', location: '' };
  for (const line of lines.slice(2)) {
    if (line === '∙' || /^\d+\s*(wk|d|h|mo|yr)\s+ago$/i.test(line)) continue;
    if (/\$/.test(line)) {
      out.pay = line;
      const t = line.split('·')[1];
      if (t) out.employmentType = t.trim();
      continue;
    }
    if (!out.location) {
      // "Full-time" alone on a line is the employment type, not a place.
      if (/^(full-time|part-time|internship|contract|temporary|co-?op)$/i.test(line)) { out.employmentType = line; continue; }
      out.location = line;
    }
  }
  return out;
}

const PANE_END = /\n(?:What they're looking for|What this job offers|Similar jobs|About [A-Z])/;

/**
 * Read the detail pane.
 *
 * Everything here is optional: Handshake renders the "At a glance" block only
 * when the employer filled it in, and the work-authorization lines only when
 * they answered those questions. A missing line means unknown, never "no" —
 * reading silence as "will not sponsor" would hide jobs, which is the error
 * this project refuses to make.
 */
export function parsePane(paneText) {
  const text = String(paneText || '');
  const after = (marker) => {
    const i = text.indexOf(marker);
    return i === -1 ? '' : text.slice(i + marker.length);
  };
  let description = after('Job description');
  if (description) {
    const end = description.match(PANE_END);
    if (end) description = description.slice(0, end.index);
    // The clamped view ends in an ellipsis and a "More" affordance. If the
    // harvester could not expand it, say so rather than importing half a job.
    description = description.replace(/\n\.\.\.\s*\nMore\b[\s\S]*$/, '').trim();
  }
  const glanceIdx = text.indexOf('At a glance');
  const glance = glanceIdx === -1 ? '' : text.slice(glanceIdx, glanceIdx + 600);
  return {
    description,
    pay: (glance.match(/\$[^\n]*\/(?:yr|hr|mo|wk|year|hour|month|week)/) || [''])[0],
    applyBy: (text.match(/Apply by ([^\n∙]+)/) || [, ''])[1].trim(),
    // Three states, not two. `true` and `false` are things the employer said;
    // `null` is a question they never answered.
    //
    // THE NEGATIVE IS TESTED FIRST, and that order is the whole correctness of
    // this line. "Open to candidates with OPT/CPT" is a substring of "Not open
    // to candidates with OPT/CPT", so checking the positive first reports an
    // employer's explicit refusal as an invitation — the worst direction this
    // field can fail in, because it would put a badge on the card telling him
    // the job is OPT-friendly when the posting says it is not.
    optCpt: /\bnot open to candidates with OPT\/CPT|does not sponsor/i.test(text) ? false
      : /\bopen to candidates with OPT\/CPT/i.test(text) ? true : null,
    workAuthRequired: /US work authorization required/i.test(text) ? true : null,
    remote: /\bRemote\b/.test(glance) && !/Work in person/.test(glance),
  };
}

/** One harvested row becomes one store row, or null when it cannot be judged. */
export function toStoreRow(row) {
  const card = parseCard(row.card);
  const pane = parsePane(row.pane);
  if (!card.title || !pane.description) return null;

  const facts = [
    card.employmentType && `Employment type: ${card.employmentType}`,
    pane.applyBy && `Apply by ${pane.applyBy}`,
    // Put the work-authorization answer in the body, where the visa classifier
    // reads. This is the one source that states it outright, and leaving it in
    // a field nothing reads would waste the best signal Handshake gives us.
    pane.optCpt === true && 'This employer is open to candidates with OPT/CPT.',
    pane.optCpt === false && 'This employer is not open to candidates with OPT/CPT.',
    pane.workAuthRequired === true && 'US work authorization required.',
  ].filter(Boolean).join('\n');

  const description = facts ? `${pane.description}\n\n${facts}` : pane.description;
  const title = card.title;
  const location = card.location || (pane.remote ? 'Remote' : '');
  const url = jobUrl(row.posting_id);

  return {
    url,
    title,
    company: card.employer || '',
    team: '',
    location,
    description,
    salary: parsePayBand(pane.pay || card.pay),
    postedAt: null,
    detailApi: null,
    source: 'handshake',
    triage: triage({ title, description, location, url }),
    company_meta: {
      tier: 'handshake',
      careers_url: '',
      notes: 'From his Handshake feed. Apply through Handshake — the engine cannot fill this one.',
      sponsors_h1b: pane.optCpt === true,
    },
  };
}

/** Decide what to import and count why the rest was left out. */
export function selectImportable(rows, { storeRows = [] } = {}) {
  const byCompany = new Map();
  for (const r of storeRows) {
    const k = companyKey(r.company);
    if (!k) continue;
    if (!byCompany.has(k)) byCompany.set(k, []);
    byCompany.get(k).push(r.title);
  }
  const take = [], skipped = { unreadable: 0, filtered: 0, alreadyHave: 0 };
  for (const row of rows) {
    const built = toStoreRow(row);
    if (!built) { skipped.unreadable++; continue; }
    if (NEVER_TRACK.test(built.company)) { skipped.filtered++; continue; }
    const titles = byCompany.get(companyKey(built.company)) || [];
    if (titles.some(t => titleOverlap(built.title, t) >= 0.6)) { skipped.alreadyHave++; continue; }
    take.push(built);
  }
  return { take, skipped };
}

// ── CLI ─────────────────────────────────────────────────────────────

const FLAGS = ['--dry-run', '--limit', '--json'];
const VALUED = ['--limit'];

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: FLAGS, valued: VALUED, argv });
  const limFlag = args.indexOf('--limit');
  const file = args.find((a, i) => !a.startsWith('--') && i !== limFlag + 1);
  if (!file) { console.error(USAGE); return 2; }

  const has = n => args.includes(`--${n}`);
  const limit = limFlag === -1 ? 0 : Number(args[limFlag + 1]) || 0;
  const asJson = has('json');
  const say = (...a) => { if (!asJson) console.log(...a); };

  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const rows = parsed.rows || [];
  say(`\n  ${rows.length} postings in ${path.basename(file)}.`);

  const storeRows = db().prepare('SELECT company, title FROM jobs').all();
  let { take, skipped } = selectImportable(rows, { storeRows });
  if (limit > 0) take = take.slice(0, limit);

  const blocked = take.filter(r => r.triage.flags.hardBlock).length;
  const optOk = take.filter(r => r.company_meta.sponsors_h1b).length;

  if (asJson) {
    console.log(JSON.stringify({
      harvested: rows.length, selected: take.length, skipped, hardBlocked: blocked, optCpt: optOk,
    }, null, 1));
  } else {
    console.log(`  ${skipped.unreadable} unreadable, ${skipped.alreadyHave} already held, ${skipped.filtered} filtered.`);
    console.log(`  ${take.length} to import, across ${new Set(take.map(r => r.company)).size} companies.`);
    console.log(`  ${optOk} say they are open to OPT/CPT. ${blocked} hard-blocked on work authorization.\n`);
    for (const r of take.slice(0, 25)) {
      const pay = r.salary?.min ? ` $${Math.round(r.salary.min / 1000)}k` : '';
      const opt = r.company_meta.sponsors_h1b ? '  ✓OPT' : '';
      console.log(`    ${r.company} — ${r.title}  [${r.location || '—'}]${pay}${opt}`);
    }
    if (take.length > 25) console.log(`    …and ${take.length - 25} more`);
  }

  if (has('dry-run')) { say(`\n  (dry run — nothing written)\n`); return 0; }
  if (!take.length) { say(`\n  Nothing to import.\n`); return 0; }
  const { added, updated } = upsertJobs(take);
  say(`\n  Store updated: ${added} added, ${updated} updated.\n`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
