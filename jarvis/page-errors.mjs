#!/usr/bin/env node
// jarvis/page-errors.mjs — what a form said back, kept.
//
// His ask, 2026-10-02: "make the mistake log detect red sentences or letters
// on pages when errors pop up because i feel like having that would help you
// troubleshoot the logs much ezier". The answer log (answer-log.mjs) holds what
// went INTO a form; a step that refused to move said why only on the page —
// in red under a box, in an alert banner, beside a box marked invalid — and
// that was gone by the time anyone read the log.
//
// The extension reads those messages (discover.js errorsOnPage) 1.5 s and 4 s
// after a Next / Submit press and whenever the form changes, and the dashboard
// appends one line per report here:
//   { at, pageUrl, trigger, heading, job: { id, company, title }, errors: [
//       { text, how: 'red' | 'alert' | 'invalid', field, color } ] }
// Never fails a fill; a log that cannot be written is skipped.
//
// Reading it:
//   npm run jarvis:page-errors                         the last 40 reports
//   npm run jarvis:page-errors -- --company spirit     one employer
//   npm run jarvis:page-errors -- --grep required      messages matching a pattern
//   npm run jarvis:page-errors -- --since 2026-10-02 --last 200
//   npm run jarvis:page-errors -- --json               the raw lines
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STORE_DIR } from './store.mjs';

export const PAGE_ERROR_LOG = path.join(STORE_DIR, 'page-errors.jsonl');
const MAX_BYTES = 10 * 1024 * 1024;   // then rotated to page-errors.1.jsonl
// Extension tests fill fixture pages served by the dashboard itself (F-631).
const LOCAL_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i;
const HOWS = new Set(['red', 'alert', 'invalid', 'unseen']);

/** Clean one report from the page. Exported for the test. */
export function pageErrorRow({ pageUrl = '', trigger = '', heading = '', job = null, errors = [] } = {}, at = new Date()) {
  const list = (Array.isArray(errors) ? errors : []).slice(0, 20).map((e) => ({
    text: String(e?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    how: HOWS.has(e?.how) ? e.how : 'red',
    field: String(e?.field || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    color: String(e?.color || '').slice(0, 40),
  })).filter((e) => e.text);
  if (!list.length) return null;
  return {
    at: at.toISOString(),
    pageUrl: String(pageUrl).slice(0, 600),
    trigger: String(trigger).slice(0, 120),
    heading: String(heading).slice(0, 200),
    job: job ? { id: String(job.id || ''), company: String(job.company || ''), title: String(job.title || '') } : null,
    errors: list,
  };
}

/** Append one report. Returns how many messages were kept (0 when skipped). */
export function logPageErrors(report, { file = PAGE_ERROR_LOG } = {}) {
  try {
    if (LOCAL_PAGE.test(String(report?.pageUrl || ''))) return 0;
    const row = pageErrorRow(report);
    if (!row) return 0;
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return row.errors.length;
  } catch { return 0; }
}

export function readPageErrors({ file = PAGE_ERROR_LOG, company = '', grep = '', since = '', last = 40 } = {}) {
  if (!existsSync(file)) return [];
  const co = String(company).toLowerCase();
  const re = grep ? new RegExp(grep, 'i') : null;
  const rows = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (since && String(r.at) < since) continue;
    if (co && !`${r.job?.company || ''} ${r.pageUrl}`.toLowerCase().includes(co)) continue;
    if (re && !r.errors.some((e) => re.test(e.text) || re.test(e.field))) continue;
    rows.push(r);
  }
  return rows.slice(-last);
}

export function formatPageErrors(rows) {
  if (!rows.length) return 'No page errors logged for that.';
  const out = [];
  for (const r of rows) {
    const who = r.job ? `${r.job.company} · ${r.job.title}` : (r.heading || r.pageUrl);
    out.push(`${r.at.slice(0, 16).replace('T', ' ')}  ${who}`);
    out.push(`    ${r.trigger} — ${r.pageUrl}`);
    for (const e of r.errors) out.push(`    [${e.how}] ${e.field ? `${e.field}: ` : ''}${e.text}`);
  }
  return out.join('\n');
}

/**
 * THE QUESTIONS NO PLAN SAW, BY PLATFORM (2026-10-03). The extension logs a
 * control on the page that discover() did not cover as `how: 'unseen'`; one
 * platform's reader fault shows up at every company on it, so the report is
 * grouped by the ATS host's platform, then by question, with a count.
 */
export function platformOf(pageUrl) {
  const h = (() => { try { return new URL(String(pageUrl)).hostname.toLowerCase(); } catch { return ''; } })();
  const P = [[/myworkdayjobs.com$|myworkday.com$/, 'Workday'], [/oraclecloud.com$/, 'Oracle Recruiting Cloud'], [/eightfold.ai$/, 'Eightfold'], [/greenhouse.io$/, 'Greenhouse'],
    [/lever.co$/, 'Lever'], [/ashbyhq.com$/, 'Ashby'], [/icims.com$/, 'iCIMS'], [/smartrecruiters.com$/, 'SmartRecruiters'], [/paylocity.com$/, 'Paylocity'], [/adp.com$/, 'ADP'],
    [/successfactors.(com|eu)$|sapsf.com$/, 'SuccessFactors'], [/workable.com$/, 'Workable'], [/bamboohr.com$/, 'BambooHR'], [/rippling.com$/, 'Rippling'], [/jobvite.com$/, 'Jobvite'], [/breezy.hr$/, 'Breezy'], [/taleo.net$/, 'Taleo']];
  for (const [re, name] of P) if (re.test(h)) return name;
  // Eightfold and Phenom often live on the employer's own careers host.
  return h ? `other (${h})` : 'unknown';
}
export function unseenByPlatform(rows) {
  const by = new Map();
  for (const r of rows) for (const e of r.errors || []) {
    if (e.how !== 'unseen') continue;
    const p = platformOf(r.pageUrl);
    if (!by.has(p)) by.set(p, new Map());
    const q = by.get(p);
    const k = e.text;
    const cur = q.get(k) || { text: k, kind: e.field, count: 0, companies: new Set() };
    cur.count += 1; cur.companies.add(r.job?.company || (() => { try { return new URL(r.pageUrl).hostname; } catch { return '?'; } })());
    q.set(k, cur);
  }
  return [...by].map(([platform, q]) => ({ platform, questions: [...q.values()].sort((a, b) => b.count - a.count).map((x) => ({ ...x, companies: [...x.companies] })) }))
    .sort((a, b) => b.questions.length - a.questions.length);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { guardArgs } = await import('./cli.mjs');
  const usage = `
  page-errors — what forms said back in red, in alerts, and beside invalid boxes

    --company <name>   one employer (matches the company or the page URL)
    --grep <pattern>   messages or fields matching a pattern
    --since <date>     from this ISO date on
    --last <n>         how many reports (default 40)
    --json             the raw lines
    --unseen           questions on the page that no plan saw, grouped by platform
`;
  const args = guardArgs({ usage, flags: ['--company', '--grep', '--since', '--last', '--json', '--unseen'], valued: ['--company', '--grep', '--since', '--last'] });
  const val = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
  void args;
  const unseen = process.argv.includes('--unseen');
  const rows = readPageErrors({ company: val('--company'), grep: val('--grep'), since: val('--since'), last: Number(val('--last')) || (unseen ? 100000 : 40) });
  if (unseen) {
    const groups = unseenByPlatform(rows);
    if (!groups.length) console.log('No unseen questions logged.');
    for (const g of groups) {
      console.log(`
${g.platform} — ${g.questions.length} question(s) never seen`);
      for (const q of g.questions) console.log(`  ${String(q.count).padStart(3)}×  ${q.text}  [${q.kind}]  — ${q.companies.slice(0, 4).join(', ')}`);
    }
    process.exit(0);
  }
  console.log(process.argv.includes('--json') ? rows.map((r) => JSON.stringify(r)).join('\n') : formatPageErrors(rows));
}
