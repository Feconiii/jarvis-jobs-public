// jarvis/apply/generic.mjs — last-resort adapter for any ATS without a specific one.
//
// Registered LAST, so every purpose-built adapter wins first. This exists because
// the long tail is large: Tesla (~4.7k postings in the store), SmartRecruiters
// (~860), TI on Oracle Recruiting (~590), Teradyne on SuccessFactors (~500),
// iCIMS/Joby (~225). Writing five bespoke adapters for those would be a lot of
// code for forms that are, in the end, ordinary labelled HTML — which is exactly
// what the shared _form filler already drives.
//
// It is deliberately conservative. It only fills labels that resolve to an answer
// the user has actually configured, it verifies every value against the page, it
// flags whatever it cannot place, and it never submits. Landing on a page with no
// form is reported, not silently treated as success.

import { fill as formFill, countApplicationFields, APPLY_PATH_RE, APPLY_TEXT_RE, bouncedToRoot, pageBlocker } from './_form.mjs';
import { time } from './_timing.mjs';

export const id = 'generic';

// Last resort: apply.mjs tries the specific adapters before this one.
export const matches = () => true;

/** Count the fillable controls actually on the page — ALL of them, site
 *  furniture included. This is the page-stability measure used by settle();
 *  the decision gates below use countApplicationFields() instead, because
 *  "how many controls are there" and "is this an application form" are
 *  different questions and answering the second with the first is what made
 *  the engine fill Amazon's search box. */
async function controlCount(page) {
  return await page.evaluate(() => [...document.querySelectorAll('input,select,textarea')]
    .filter(e => e.type !== 'hidden' && e.getClientRects().length > 0).length).catch(() => 0);
}

/** Wait until the control count stops growing (these are nearly all SPAs).
 *
 *  A count that is stable at ZERO used to be unable to end this loop — `n > 0`
 *  was required — so every board page, the single most common thing this
 *  adapter is pointed at, burned the entire budget before the Apply link was
 *  even looked for. That was a flat 8s on the first call and up to 20s on the
 *  second. Stable-at-zero now ends it too, after a short floor so an SPA that
 *  simply has not rendered yet is not mistaken for an empty page. */
async function settle(page, timeout = 15000) {
  let prev = -1;
  let stable = 0;
  const started = Date.now();
  const deadline = started + timeout;
  while (Date.now() < deadline) {
    const n = await controlCount(page);
    if (n === prev) {
      stable++;
      if (n > 0) return n;
      if (stable >= 2 && Date.now() - started >= 1500) return n;
    } else {
      stable = 0;
    }
    prev = n;
    await page.waitForTimeout(700);
  }
  return prev;
}

/** Dismiss a cookie banner, choosing the privacy-preserving option. Never clicks
 *  a bare "Accept" — that is the user's call, and the banner rarely blocks the
 *  form anyway. */
async function dismissCookieBanner(page) {
  const reject = page.locator('button, a[role=button]')
    .filter({ hasText: /reject all|decline all|only necessary|necessary only|reject non-essential|decline/i })
    .first();
  if (await reject.count().catch(() => 0)) {
    await reject.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

/** Known deterministic apply URLs. Cheaper and far more reliable than hunting for
 *  a button whose wording changes per tenant. */
function derivedApplyUrl(url) {
  // SmartRecruiters: /{company}/postings/{id} → /{company}/postings/{id}/apply
  const sr = url.match(/^(https:\/\/jobs\.smartrecruiters\.com\/[^/]+\/postings\/\d+)(?:[/?#].*)?$/i);
  if (sr) return `${sr[1]}/apply`;
  // Oracle Recruiting Cloud: /…/sites/<site>/job/<id> -> /…/job/<id>/apply/email
  //
  // Deterministic, and it has to be, because the Apply control on these pages
  // is a <button> with no href whose handler re-renders the SPA around it: a
  // tagged handle goes stale and the click times out. Verified on two
  // unrelated tenants - careers.ti.com (a vanity domain) and Emerson on
  // hdjq.fa.us2.oraclecloud.com - both of which serve Email Address, a
  // honeypot and a terms checkbox at that path. Emerson reported "no
  // recognisable form fields" before this.
  //
  // Matched on the PATH shape rather than a host list, because TI proves the
  // host can be anything; a wrong guess simply finds no form and the run
  // carries on, and bouncedToRoot catches a redirect.
  const orc = url.match(/^(https:\/\/[^/]+\/(?:hcmUI\/CandidateExperience\/)?[a-z]{2}(?:-[A-Za-z]{2})?\/sites\/[A-Za-z0-9_-]+\/job\/\d+)\/?$/i);
  if (orc) return `${orc[1]}/apply/email`;
  return null;
}


export async function fill(page, profile) {
  // Sub-phases under `gen:` — a breakdown OF fill, the same convention the
  // Workday adapter uses. "fill 40s" on a two-field form was untraceable, and
  // an unattributable number is one nobody can optimise (the reason _timing
  // exists at all).
  await time('gen:cookie', () => dismissCookieBanner(page));
  await time('gen:settle-1', () => settle(page, 8000));

  const derived = derivedApplyUrl(page.url());
  if (derived && await countApplicationFields(page) < 3) {
    await time('gen:derived-url', async () => {
      await page.goto(derived, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await dismissCookieBanner(page);
      await settle(page, 20000);
    });
  }

  // A posting page with no APPLICATION controls means the form is behind an
  // Apply control. Follow it — href first so an SPA re-render cannot swallow a
  // click.
  //
  // This used to ask `controlCount(page) < 3`, which counted the site's own
  // search box: amazon.jobs scored 10, careers.agcocorp.com scored 3, so on
  // both the branch never ran and the engine filled the search box instead.
  // Between them that is ~460 deck postings, including everything he currently
  // has queued.
  // An email-first flow (Oracle Recruiting, SuccessFactors) shows ONE field on
  // its first step, so a field count alone reads as "no form here" and sent the
  // engine hunting for an Apply button it had already pressed — 12s of waiting
  // per application on AGCO, for a button that could not exist.
  // Ask what is blocking us BEFORE hunting for an Apply control. Landing on
  // passport.amazon.jobs, this used to spend a further 12 seconds waiting for
  // an Apply button on a login page that will never have one.
  const early = await time('gen:blocker', () => pageBlocker(page));
  if (early) {
    return {
      filled: [], review: [], skipped: [], resumeUploaded: false,
      needsInput: [{ label: 'Application form', why: early.why, blocker: early.kind }],
    };
  }

  let hopBounced = false;
  const onFormAlready = (() => {
    try { return APPLY_PATH_RE.test(new URL(page.url()).pathname); } catch { return false; }
  })();
  if (!onFormAlready && await countApplicationFields(page) < 3) {
    await time('gen:apply-hop', async () => {
      const applyCtl = page.locator('a, button, [role=button]')
        .filter({ hasText: APPLY_TEXT_RE })
        .first();
      // WAIT for the control, do not merely look once. settle() returns as soon
      // as the control count is stable — which on a board page is immediately,
      // and correctly, zero — so a single look ran before the button had
      // rendered and the hop silently did nothing. Waiting on the button itself
      // is both more precise and faster than any fixed delay: it returns the
      // moment the button exists.
      await applyCtl.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      if (!await applyCtl.count().catch(() => 0)) return;
      // href first so an SPA re-render cannot swallow the click. A BUTTON can
      // carry one too — careers.agcocorp.com renders exactly that — so this
      // reads the attribute rather than assuming an anchor.
      const href = await applyCtl.getAttribute('href').catch(() => null);
      // NEVER activate a `javascript:` control. AGCO's apply dropdown holds
      // `javascript:alert('Join our talent community…')` entries, and a native
      // alert() blocks every subsequent automation command — the whole run
      // would hang on a modal only he can dismiss. Skipping is the only safe
      // move; the report below will say the form was not reached.
      if (/^javascript:/i.test(href || '')) return;
      const before = page.url();
      if (href && !/^#/.test(href)) {
        await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      } else {
        await applyCtl.scrollIntoViewIfNeeded().catch(() => {});
        await applyCtl.click({ timeout: 8000 }).catch(() => {});
      }
      await page.waitForTimeout(2500);
      // Same verification apply.mjs does — this hop navigates too, and landing
      // on the site's front page is how AGCO's dropdown-driven apply link fails.
      if (bouncedToRoot(before, page.url())) {
        hopBounced = true;
        await page.goto(before, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      }
      await dismissCookieBanner(page);
      await settle(page, 20000);
    });
  }

  // Whatever we landed on, say what it IS before trying to fill it. A sign-in
  // page, a bot check and a dead posting are all "a page with inputs on it".
  const blocker = await time('gen:blocker', () => pageBlocker(page));
  if (blocker) {
    return {
      filled: [], review: [], skipped: [], resumeUploaded: false,
      needsInput: [{ label: 'Application form', why: blocker.why, blocker: blocker.kind }],
    };
  }

  // Several ATSes (iCIMS especially) render the whole application inside an
  // iframe, so the top document holds almost nothing. Fill wherever the form
  // actually lives: the frame with the most controls.
  let target = page;
  if (await countApplicationFields(page) < 5) {
    let best = null, bestN = 0;
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      const n = await fr.evaluate(() => [...document.querySelectorAll('input,select,textarea')]
        .filter(e => e.type !== 'hidden').length).catch(() => 0);
      if (n > bestN) { bestN = n; best = fr; }
    }
    if (best && bestN >= 3) target = best;
  }

  const result = await time('gen:form-fill', () => formFill(target, profile));
  if (target !== page) {
    result.filled.push({ label: 'Form location', value: 'filled inside an embedded iframe' });
  }

  // CAPTCHAs are a hard stop, always — never solved, never bypassed.
  const captcha = await page.evaluate(() => !!document.querySelector(
    '.g-recaptcha, #g-recaptcha-response, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey]',
  )).catch(() => false);
  if (captcha) {
    result.needsInput.push({
      label: 'CAPTCHA',
      why: 'this form is behind a CAPTCHA — clear it yourself in this tab; Jarvis never touches these',
    });
  }

  // Nothing filled and nothing blocking: the page really does have no form we
  // recognise. pageBlocker() above has already handled the sign-in, bot-check
  // and dead-posting cases, so this sentence now means what it says.
  if (!result.filled.length) {
    result.needsInput.push({
      label: 'Application form',
      why: hopBounced
        // The Apply control exists and refuses to be followed. On AGCO it is a
        // dropdown offering "join our talent community" — an account signup,
        // which is his to start, not the engine's.
        ? 'the Apply control bounced back to the site front page — this ATS wants an account before it opens the form; start it yourself in this tab'
        : 'no recognisable form fields on this page — no adapter for this ATS; fill it by hand in this tab',
    });
  }
  return result;
}
