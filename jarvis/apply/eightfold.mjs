// jarvis/apply/eightfold.mjs — Eightfold-hosted career sites.
//
// Eightfold powers the "custom looking" career sites of several of Alex's target
// companies — Micron, Lam Research and Applied Materials all run it behind their
// own domain, which is why they looked like bespoke sites with no adapter. In the
// store that is roughly 6,900 postings, the single largest apply gap.
//
// The good news: the apply page is ONE on-page form with ordinary labelled
// controls (Email, First name, Last name, City, EEO radios) plus a file input, so
// there is nothing tenant-specific to drive — the shared _form filler handles it,
// exactly as it does for Greenhouse. This adapter only has to find the apply page.
//
// Fingerprint: Eightfold serves /careers/job/... and /careers/apply?pid=... and
// tags every link with a `domain=` parameter. Matching the shape rather than a
// host list means a new Eightfold company works without a code change.

import { fill as formFill } from './_form.mjs';
import { time } from './_timing.mjs';

export const id = 'eightfold';

/** Wait until the control count stops growing — this is a React SPA, and
 *  enumerating too early sees a fraction of the form and reports a clean run. */
async function settle(page, timeout = 15000) {
  let prev = -1;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const n = await page.evaluate(
      () => document.querySelectorAll('input:not([type=hidden]),select,textarea').length,
    ).catch(() => 0);
    if (n > 0 && n === prev) return n;
    prev = n;
    await page.waitForTimeout(700);
  }
  return prev;
}

/** Combine two fill passes, keeping the first result for any repeated label. */
function merge(a, b) {
  const seen = new Set(a.filled.map(f => f.label));
  return {
    filled: [...a.filled, ...b.filled.filter(f => !seen.has(f.label))],
    review: [...a.review, ...b.review],
    // A field filled on the second pass is no longer outstanding.
    needsInput: [...a.needsInput, ...b.needsInput]
      .filter(n => ![...a.filled, ...b.filled].some(f => f.label === n.label)),
    skipped: [...a.skipped, ...b.skipped],
    resumeUploaded: a.resumeUploaded || b.resumeUploaded,
  };
}

export function matches(url) {
  if (/\.eightfold\.ai\//i.test(url)) return true;
  try {
    const u = new URL(url);
    return /\/careers\/(job|apply)\b/i.test(u.pathname) && /[?&]domain=/i.test(u.search);
  } catch { return false; }
}

/** Eightfold's apply URL is deterministic, so derive it rather than hunting for a
 *  link: /careers/job/<pid>-slug?domain=X → /careers/apply?pid=<pid>&domain=X.
 *  On the live site the Apply control is not a plain anchor, so a link lookup
 *  found nothing and the engine filled the job page instead of the form. */
export function applyUrlFor(jobUrl) {
  try {
    const u = new URL(jobUrl);
    if (/\/careers\/apply/i.test(u.pathname)) return jobUrl;
    const m = u.pathname.match(/\/careers\/job\/(\d+)/);
    if (!m) return null;
    const q = new URLSearchParams({ pid: m[1] });
    const domain = u.searchParams.get('domain');
    if (domain) q.set('domain', domain);
    return `${u.origin}/careers/apply?${q.toString()}`;
  } catch { return null; }
}

/** Is this form behind a CAPTCHA? Jarvis never solves or bypasses one — it says
 *  so and the user clears it in the open tab. */
async function hasCaptcha(page) {
  return await page.evaluate(() => !!document.querySelector(
    '.g-recaptcha, #g-recaptcha-response, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]',
  )).catch(() => false);
}

export async function fill(page, profile) {
  if (!/\/careers\/apply/i.test(page.url())) {
    const target = applyUrlFor(page.url());
    if (target) await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    else {
      const btn = page.locator('a[href*="/careers/apply"], button').filter({ hasText: /^apply/i }).first();
      if (await btn.count().catch(() => 0)) await btn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForURL('**/careers/apply**', { timeout: 15000 }).catch(() => {});
    }
  }

  // Wait for the form itself, not a fixed sleep.
  // `:visible` on every branch — see the note on the same call in _form.mjs.
  // waitForSelector resolves a selector LIST to the first match in DOM order
  // and then waits for THAT element to satisfy `state`. ATSes routinely hide
  // the real file input behind a styled Attach button (this file's own
  // upload code says so), so the first match here was typically a hidden
  // input that never becomes visible, and the wait ran its full 25 seconds
  // on a form that had already rendered.
  // Wait for the form OR for a CAPTCHA, whichever arrives first.
  //
  // A gated requisition never paints a form, so this used to burn the full 25
  // seconds proving what the CAPTCHA check below then answered instantly.
  // Probing for the CAPTCHA BEFORE the wait does not work either — measured on
  // a live Micron posting, the challenge renders after this point, so an early
  // look sees nothing and the wait runs out anyway.
  //
  // waitForFunction rather than a combined selector: waitForSelector resolves a
  // selector LIST to the first match in DOM order and then waits for THAT one,
  // and a hidden CAPTCHA iframe at the top of the document would hold the whole
  // wait open — the F-81 trap, one file over.
  await time('ef:first-paint', () => page.waitForFunction(() => {
    const vis = (e) => e.getClientRects().length > 0;
    const field = [...document.querySelectorAll('input[type=file], input[type=email], form input[type=text]')].some(vis);
    const captcha = !!document.querySelector('.g-recaptcha, #g-recaptcha-response, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]');
    return field || captcha;
  }, null, { timeout: 25000, polling: 400 }).catch(() => {}));
  await time('ef:settle-1', () => settle(page));

  let result = await time('ef:fill-1', () => formFill(page, profile));

  // Eightfold reveals the rest of the form only AFTER it has parsed the uploaded
  // resume, so a first pass that finds nothing but the file input is normal, not
  // a failure. Wait for the form to grow, then fill what just appeared.
  if (result.resumeUploaded && result.filled.length <= 1) {
    await time('ef:settle-2', () => settle(page, 30000));
    result = merge(result, await time('ef:fill-2', () => formFill(page, profile)));
  }

  // A CAPTCHA is a hard stop, always. Jarvis does not solve or bypass them — it
  // says so, and the user clears it in the open tab.
  const captcha = await hasCaptcha(page);
  if (captcha) {
    result.needsInput.push({
      label: 'CAPTCHA',
      why: 'this form is behind a CAPTCHA — solve it yourself in this tab before submitting; Jarvis never touches these',
    });
  }

  if (!result.filled.length && !result.needsInput.length) {
    result.needsInput.push({
      label: 'Application form',
      why: 'no form fields found on this Eightfold page — it may require sign-in, or the posting is closed; complete it by hand',
    });
  }
  return result;
}
