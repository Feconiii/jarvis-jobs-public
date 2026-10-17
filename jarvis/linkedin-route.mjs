#!/usr/bin/env node
// jarvis/linkedin-route.mjs — does a LinkedIn posting send him to the company,
// or only take LinkedIn's Easy Apply?
//
// His rule, 2026-10-02: "i dont want to do ez apply but when i click on
// linkedin it keeps showing up, if it was normal apply and took me to the
// comapny site it would be fine but ez apply i cant tailor my resume".
//
// The guest posting page draws one apply button and names its kind in the
// tracking attribute — measured 2026-10-02 on KUKA 4467250791 (Easy Apply)
// and ANDRITZ 4469181165 / Spirit AeroSystems 4471233349 (company site):
//   public_jobs_apply-link-onsite    → 'easy-apply'  LinkedIn's own form
//   public_jobs_apply-link-offsite…  → 'offsite'     the employer's site
//   "No longer accepting applications" → 'closed'
// Anything else is null: unknown, never guessed either way. Measured
// 2026-10-02, some live postings (Photronics 4434709794, Bobcat 4451567245)
// draw no apply button at all to a visitor who is not signed in.
//
// Where the rule is applied:
//   import-linkedin.mjs   an Easy Apply posting is not imported (named in the run)
//   curate.mjs            a LinkedIn candidate is asked first; Easy Apply is
//                         turned down without a model call
//   picks.mjs             the screen skips rows stored as apply_route 'easy-apply'
//   this file, --write    the LinkedIn rows already on his lists: Easy Apply
//                         ones leave the inbox with the reason on the row;
//                         Tracking (his hearts) and Queued are his decisions
//                         and are only listed
//
// Usage:
//   node jarvis/linkedin-route.mjs            check, report, write nothing
//   node jarvis/linkedin-route.mjs --write
import path from 'path';
import { fileURLToPath } from 'url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const EASY_APPLY_NOTE = 'LinkedIn Easy Apply only — no company-site apply, so no tailored resume (his rule, 2026-10-02)';

export function applyRoute(html) {
  const src = String(html || '');
  if (/public_jobs_apply-link-offsite|apply-button__offsite-apply-icon/.test(src)) return 'offsite';
  if (/public_jobs_apply-link-onsite/.test(src)) return 'easy-apply';
  // WD 4451253407, 2026-10-02: the posting's own page says so, no button drawn.
  if (/No longer accepting applications|class="[^"]*closed-job/i.test(src)) return 'closed';
  return null;
}

/** The numeric posting id in a LinkedIn job URL (…/jobs/view/<slug>-<id>, ?currentJobId=<id>). */
export function linkedInJobId(url) {
  const s = String(url || '');
  if (!/linkedin\.com\//i.test(s)) return null;
  return (s.match(/[?&]currentJobId=(\d{6,})/) || s.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/) || [])[1] || null;
}

/** The apply route of a stored LinkedIn URL, asked of the guest page. null when unknown. */
export async function routeFor(url, { fetchImpl = fetch } = {}) {
  const id = linkedInJobId(url);
  if (!id) return null;
  try {
    const r = await fetchImpl(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, { headers: { 'user-agent': UA, accept: 'text/html' } });
    return r.ok ? applyRoute(await r.text()) : null;
  } catch { return null; }
}

async function main(argv) {
  const write = argv.includes('--write');
  const { db } = await import('./store.mjs');
  const { approve } = await import('./picks.mjs');
  const h = db();
  const rows = h.prepare(`SELECT id, company, title, status, url FROM jobs
    WHERE url LIKE '%linkedin.com%' AND superseded_by IS NULL AND gone_at IS NULL
      AND status IN ('inbox', 'queued', 'interested') ORDER BY status, company`).all();
  console.log(`\n  ${rows.length} LinkedIn postings on your lists. Asking LinkedIn how each one takes an application…\n`);
  const seen = { 'easy-apply': [], offsite: [], closed: [], unknown: [] };
  const mark = h.prepare('UPDATE jobs SET apply_route = ? WHERE id = ?');
  for (const r of rows) {
    const route = await routeFor(r.url);
    seen[route || 'unknown'].push(r);
    if (write && route) mark.run(route, r.id);
    await new Promise((res) => setTimeout(res, 1200));
  }
  const line = (r) => `    ${r.status.padEnd(10)} ${r.company} — ${r.title}`;
  console.log(`  Company site: ${seen.offsite.length}   Easy Apply only: ${seen['easy-apply'].length}   closed: ${seen.closed.length}   unknown: ${seen.unknown.length}\n`);
  const outOfInbox = seen['easy-apply'].filter((r) => r.status === 'inbox');
  const his = seen['easy-apply'].filter((r) => r.status !== 'inbox');
  if (outOfInbox.length) {
    console.log(`  Easy Apply only, ${write ? 'taken out of' : 'would leave'} the inbox:`);
    outOfInbox.forEach((r) => console.log(line(r)));
    if (write) approve(outOfInbox.map((r) => r.id), Object.fromEntries(outOfInbox.map((r) => [r.id, EASY_APPLY_NOTE])), { undo: true });
  }
  if (his.length) {
    console.log('\n  Easy Apply only, on Tracking or Queued (yours, left in place):');
    his.forEach((r) => console.log(line(r)));
  }
  if (seen.closed.length) {
    console.log('\n  LinkedIn says "No longer accepting applications" (left for you to clear):');
    seen.closed.forEach((r) => console.log(line(r)));
  }
  if (seen.unknown.length) {
    console.log('\n  No apply button shown to a signed-out visitor (open it to see which kind):');
    seen.unknown.forEach((r) => console.log(line(r)));
  }
  if (!write) console.log('\n  (nothing written — --write applies it)');
  console.log('');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
