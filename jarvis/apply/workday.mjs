// jarvis/apply/workday.mjs — Workday (myworkdayjobs.com) application adapter.
//
// Workday is the single biggest ATS in Alex's world — KLA, NVIDIA, Intel, ASML,
// Applied Materials, Stryker, Medtronic, Cognex, GlobalFoundries, NXP, Analog
// Devices all run it. The whole tier is one adapter because Workday renders
// EVERY tenant with the same stable `data-automation-id` field IDs (confirmed
// live on NVIDIA: formField-legalName--firstName, formField-addressLine1,
// formField-source, formField-candidateIsPreviousWorker, …).
//
// FLOW (5 steps + review): a "Start Your Application" modal (Apply Manually /
// Use My Last Application) → My Information → My Experience → Application
// Questions → Voluntary Disclosures → Self Identify → Review. Each page ends
// with "Save and Continue". We fill from the apply-profile, click through, and
// STOP at Review — never Submit.
//
// Requires a signed-in Workday session in the browser profile (a one-time
// Google sign-in unlocks every tenant via SSO — see apply.mjs --login).

import { resolveLabel, yesNo } from './_answers.mjs';
import { wdValue } from './_workday-keys.mjs';
import { chooseOption } from './_form.mjs';
import { workEntries, educationEntries, hasAnyExperience } from './_experience.mjs';
// `record` is aliased: this module already has a record() for review entries.
import { time, record as recordMs } from './_timing.mjs';

export const id = 'workday';
export const matches = (url) => /myworkdayjobs\.com\//i.test(url);

// ── waiting ─────────────────────────────────────────────────────────
//
// Every settle in this adapter used to be a fixed sleep, and a fixed sleep is
// pure loss: waitForTimeout(1200) costs 1200ms whether the widget painted in
// 80ms or never painted at all. Worse, most of them sit inside per-field or
// per-step loops, so the loss multiplies by the size of the form — a Workday
// prompt paid ~4.5s of sleep, times ten prompts, times six steps.
//
// These replace them with a condition poll that keeps the ORIGINAL sleep as its
// CEILING. The worst case is therefore exactly what it was before (nothing can
// regress), and the common case returns as soon as the page is actually ready.

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` until it is true, capped at `capMs`. Returns whether it came true. */
async function until(cond, capMs, stepMs = 60) {
  const t0 = Date.now();
  for (;;) {
    if (await cond().catch(() => false)) return true;
    const left = capMs - (Date.now() - t0);
    if (left <= 0) return false;
    await nap(Math.min(stepMs, left));
  }
}

const SAVE_BTN = '[data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]';
const SUBMIT_RE = /^submit$/i;

// ── low-level Workday widget drivers (proven live on NVIDIA) ─────────

/** Fill a plain text/textarea input inside a formField container. Never throws. */
async function fillText(page, fieldId, value) {
  const loc = page.locator(`[data-automation-id="${fieldId}"] input, [data-automation-id="${fieldId}"] textarea`).first();
  if (!(await loc.count())) return false;
  try {
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill(String(value), { timeout: 4000 });
  } catch {
    // Some Workday inputs reject fill(); fall back to sequential typing.
    try { await loc.fill('', { timeout: 2000 }).catch(() => {}); await loc.pressSequentially(String(value), { delay: 15, timeout: 4000 }); }
    catch { return false; }
  }
  const now = await loc.inputValue().catch(() => '');
  return now.trim() !== '';
}

/** Fill a standalone MM/DD/YYYY Workday date field (the Self Identify signature
 *  date). It is three spinner segments, not one input: typing "07/29/2026" into
 *  the month segment yields "07//" and Workday answers "Invalid Date". */
async function fillDateParts(page, fieldId, value) {
  const container = page.locator(`[data-automation-id="${fieldId}"]`).last();
  const m = String(value).match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (!m) return false;
  const parts = [
    ['dateSectionMonth-input', m[1]],
    ['dateSectionDay-input', m[2]],
    ['dateSectionYear-input', m[3]],
  ];
  let any = false, allStuck = true;
  for (const [id, val] of parts) {
    const input = container.locator(`[data-automation-id="${id}"]`).first();
    if (!(await input.count().catch(() => 0))) continue;
    await input.click({ timeout: 3000 }).catch(() => {});
    // Real keystrokes only — synthetic events crash Workday's date widget.
    await input.pressSequentially(String(val), { delay: 20, timeout: 4000 }).catch(() => {});
    any = true;
    if (!String(await input.inputValue().catch(() => '')).trim()) allStuck = false;
  }
  return any && allStuck;
}

/** Pick a radio option by its label text (e.g. "No"). */
async function pickRadio(page, fieldId, want) {
  const yn = yesNo(want) || String(want);
  const radios = page.locator(`[data-automation-id="${fieldId}"] input[type=radio]`);
  const n = await radios.count();
  for (let i = 0; i < n; i++) {
    const r = radios.nth(i);
    const lbl = (await r.evaluate(el => {
      const l = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
      return (l?.textContent || '').trim();
    }).catch(() => '')).toLowerCase();
    if (lbl === yn.toLowerCase() || lbl.startsWith(yn.toLowerCase())) {
      await r.evaluate(el => (el.closest('label') || el).click());
      return true;
    }
  }
  return false;
}

/** What a prompt field currently holds ('' when nothing is selected). This is
 *  the only honest way to know a pick worked: Workday accepts the click on the
 *  option and still leaves the field empty when the widget was not really open. */
async function promptValue(page, fieldId) {
  return await page.locator(`[data-automation-id="${fieldId}"]`).first().evaluate((el) => {
    const txt = (n) => ((n && n.textContent) || '').replace(/\s+/g, ' ').trim();

    // MULTI-SELECT (How Did You Hear About Us, Country Phone Code). Selections
    // are chips in selectedItemList; the visible input holds only the filter
    // text I typed. Reading that input is what made an empty required field
    // report as filled, so it is deliberately ignored here.
    if (el.querySelector('[data-automation-id="multiSelectContainer"]')) {
      const chips = [...el.querySelectorAll('[data-automation-id="selectedItem"]')]
        .map(txt).filter(Boolean);
      if (chips.length) return chips.join(', ');
      // Workday states it outright: "0 items selected" / "2 items selected".
      const m = txt(el).match(/(\d+)\s+items?\s+selected/i);
      if (m) return Number(m[1]) > 0 ? `${m[1]} selected` : '';
      return '';
    }

    // SINGLE PROMPT (Country, State, Phone Device Type): the backing input holds
    // the Workday id and the trigger button shows the chosen label.
    for (const inp of el.querySelectorAll('input')) {
      if ((inp.value || '').trim()) return inp.value.trim();
    }
    const t = txt(el.querySelector('button'));
    if (t && !/^(select one|select a value)$/i.test(t)) return t;
    return '';
  }).catch(() => '');
}

/** Drive a Workday prompt/listbox (Country, State, Phone Type, How-heard).
 *  Click to open; type to filter using THIS widget's own input; then click the
 *  matching option from THIS widget's own listbox. Never presses Enter. Checks
 *  ALL options — some lists (State) run past 40 entries.
 *
 *  Two scoping rules, both learned the hard way on KLA:
 *  - the filter box must come from inside the container. The old page-wide
 *    `input[type=text]:visible` fallback grabbed the Phone Extension box, so
 *    filtering Phone Type typed "Mobile" into the extension field.
 *  - the return value is read back off the field, never inferred from the click.
 *    Returning true after a click that did not stick is what made empty fields
 *    report as filled. */
/** First alternative this tenant actually offers, matched against one list. */
function chooseAny(alts, texts) {
  for (const a of alts) {
    const idx = chooseOption(a, texts);
    if (idx !== -1) return { idx, alt: a };
  }
  return { idx: -1, alt: null };
}

/** Click option `idx` and verify the field really took it — a click Workday
 *  accepted while leaving the field empty is what made empty required fields
 *  report as filled. */
async function commitPick(page, fieldId, opts, idx) {
  const opt = opts.nth(idx);
  await opt.click({ timeout: 4000 }).catch(() => {});
  await until(async () => (await promptValue(page, fieldId)) !== '', 500);
  // Some multi-selects need the click on the option's own inner row.
  if ((await promptValue(page, fieldId)) === '') {
    await opt.locator('[data-automation-id="promptOption"], div, span').first()
      .click({ timeout: 3000 }).catch(() => {});
    await until(async () => (await promptValue(page, fieldId)) !== '', 500);
  }
  return (await promptValue(page, fieldId)) !== '';
}

async function pickPrompt(page, fieldId, wants) {
  // Accept a list of acceptable answers and take the first the tenant offers.
  const candidates = (Array.isArray(wants) ? wants : [wants]).filter(w => w != null && String(w).trim());
  if (!candidates.length) return { ok: false, options: [], chosen: null };

  // ONE open cycle tries them ALL against the same list. This used to run a
  // full open / filter / scan / scroll cycle PER candidate, and "How Did You
  // Hear About Us?" passes six of them — six cycles on a field whose answer was
  // sitting in the first list it read. Only if none of them appear unfiltered do
  // we fall back to typing each candidate in turn.
  let last = await pickPromptOnce(page, fieldId, candidates[0], candidates);
  if (last.ok) return last;
  for (const w of candidates.slice(1)) {
    last = await pickPromptOnce(page, fieldId, w, [w]);
    if (last.ok) return last;
  }
  return last;
}

async function pickPromptOnce(page, fieldId, want, alternatives = [want]) {
  const container = page.locator(`[data-automation-id="${fieldId}"]`).last();
  // Prefer an explicit "Select One" button as the trigger. Some Workday prompts
  // (Degree, Field of Study) render as that button plus a decoy empty text input,
  // and `button, input` first-match can land on the decoy, which opens nothing.
  const selectOne = container.locator('button').filter({ hasText: /select one|select a value/i }).first();
  const trigger = (await selectOne.count().catch(() => 0))
    ? selectOne
    : container.locator('button, input').first();
  if (!(await trigger.count())) return { ok: false, options: [], chosen: null };

  // Options must come from this widget's own listbox, not whatever list happens
  // to be open on the page — AND only the visible copies. Workday renders each
  // option twice (one visible, one hidden for a11y/measurement); indexing into
  // the mixed set means clicking a hidden node, which does nothing at all and
  // leaves the field empty. Re-read aria-controls each time: filtering replaces
  // the listbox, so an id captured before typing is stale.
  const readOptions = async () => {
    const boxId = (await trigger.getAttribute('aria-controls').catch(() => null))
      || (await trigger.getAttribute('aria-owns').catch(() => null));
    const box = boxId ? page.locator(`[id="${boxId}"]`) : page.locator('[role="listbox"]:visible').last();
    const opts = box.locator('[role="option"]:visible, [data-automation-id="promptOption"]:visible');
    const texts = (await opts.allTextContents().catch(() => [])).map(t => (t || '').trim());
    return { opts, texts };
  };
  /**
   * A CHEAP fingerprint of the open list, for polling only.
   *
   * The poll must not cost more than the sleep it replaced, and reading the
   * options properly does: `allTextContents()` over `[role=option]:visible`
   * makes Playwright compute visibility element by element, and Country and
   * Country Phone Code carry ~250 entries each. Polling THAT turned a 500ms
   * sleep into something slower than the sleep. This is one page call that
   * counts the rows and samples the ends — enough to see the list appear or
   * change, cheap enough to ask repeatedly.
   */
  const optionKey = async () => {
    const boxId = (await trigger.getAttribute('aria-controls').catch(() => null))
      || (await trigger.getAttribute('aria-owns').catch(() => null));
    return await page.evaluate((id) => {
      const box = id ? document.getElementById(id)
        : [...document.querySelectorAll('[role="listbox"]')].filter((b) => b.offsetParent !== null).pop();
      if (!box) return '';
      const els = [...box.querySelectorAll('[role="option"], [data-automation-id="promptOption"]')]
        .filter((e) => e.offsetParent !== null);
      if (!els.length) return '';
      const t = (e) => (e.textContent || '').trim().slice(0, 40);
      return `${els.length}|${t(els[0])}|${t(els[els.length - 1])}`;
    }, boxId).catch(() => '');
  };
  /** Wait until this widget's list is populated AND different from `prev`.
   *  Passing '' means "just wait for it to appear". Capped at the duration the
   *  fixed sleep this replaces used to cost, so it can never be slower. */
  const optionsSettled = (prev, capMs, stepMs) => until(async () => {
    const k = await optionKey();
    return k.length > 0 && k !== prev;
  }, capMs, stepMs);

  await time('wd:prompt-open', async () => {
    await trigger.click({ timeout: 4000 }).catch(() => {});
    await optionsSettled('', 500);
  });

  // Try the list EXACTLY AS OPENED, before typing anything. When the answer is
  // already on screen this skips the filter round-trip entirely — and for a
  // multi-candidate field it is what collapses six open cycles into one.
  {
    const { opts: o0, texts: t0 } = await readOptions();
    const hit = chooseAny(alternatives, t0);
    if (hit.idx !== -1) {
      if (await commitPick(page, fieldId, o0, hit.idx)) {
        await page.keyboard.press('Escape').catch(() => {});
        return { ok: true, options: [...new Set(t0.filter(Boolean))], chosen: t0[hit.idx] };
      }
      // The click did not stick. Reopen, so the filter path below starts from a
      // known-open widget instead of whatever half-state that left behind.
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await optionsSettled('', 500);
    }
  }

  const isInput = await trigger.evaluate(el => el.tagName === 'INPUT').catch(() => false);
  const filter = isInput ? trigger : container.locator('input[type="text"], input:not([type])').first();
  const canFilter = await filter.count().catch(() => 0);
  if (canFilter) {
    // Wait for the list to actually CHANGE, not merely to be non-empty: the
    // unfiltered list is already on screen, so "non-empty" would return before
    // the filter had been applied and the pick would come off the stale set.
    const beforeFilter = await optionKey();
    await filter.fill(String(want).slice(0, 30)).catch(() => {});
    await optionsSettled(beforeFilter, 500);
  }

  let { opts, texts } = await readOptions();
  if (!texts.length && canFilter) {
    // Click-only list, or the filter text matched nothing: reopen unfiltered.
    await filter.fill('').catch(() => {});
    await trigger.click({ timeout: 3000 }).catch(() => {});
    await optionsSettled('', 500);
    ({ opts, texts } = await readOptions());
  }

  // All option-wording knowledge lives in chooseOption (_form.mjs) so every
  // adapter shares it — including the polarity guard that stops a "Yes" answer
  // from ever landing on an opt-out option.
  let idx = chooseOption(want, texts);

  // HIERARCHICAL prompts: Workday's Field of Study offers only categories at the
  // top level — "All" / "Partial List (First 500 Entries)" — and the real values
  // appear after drilling in. Without this, the field simply never filled.
  for (let depth = 0; idx === -1 && depth < 2; depth++) {
    let gate = texts.findIndex((t) => /^all$/i.test(t.trim()));
    if (gate === -1) gate = texts.findIndex((t) => /partial list|first \d+ entries/i.test(t));
    if (gate === -1) break;
    // A hierarchical row is TWO controls: the promptOption label SELECTS it, and
    // a trailing "side charm" (marked hassidecharm, rendered as an svg) DRILLS IN.
    // Clicking the label picked the category as if it were a value and closed the
    // popup — which is why Field of Study never filled. Click the charm.
    const row = opts.nth(gate);
    const charm = row.locator('[data-automation-id="promptOption"] ~ div, svg').last();
    // Must be the SAME shape optionsSettled compares against — a texts.join()
    // never equals the fingerprint, so it would degrade to "wait for non-empty"
    // and return before the drill-down had replaced the list.
    const beforeDrill = await optionKey();
    const clicked = (await charm.count().catch(() => 0))
      ? await charm.click({ timeout: 4000 }).then(() => true).catch(() => false)
      : false;
    if (!clicked) await row.click({ timeout: 4000 }).catch(() => {});
    await optionsSettled(beforeDrill, 1200);
    ({ opts, texts } = await readOptions());
    // If the popup closed anyway, reopen and try again from the top.
    if (!texts.length) {
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await optionsSettled('', 1000);
      ({ opts, texts } = await readOptions());
    }
    if (canFilter && texts.length > 12) {
      const beforeNarrow = await optionKey();
      await filter.fill(String(want).slice(0, 30)).catch(() => {});
      await optionsSettled(beforeNarrow, 800);
      ({ opts, texts } = await readOptions());
    }
    idx = chooseOption(want, texts);

    // The expanded level is VIRTUALISED — only ~9 rows exist in the DOM at a
    // time — and typing does not filter a hierarchical prompt, so the wanted
    // entry is simply not present to click. Scroll and re-read until it appears.
    for (let s = 0; idx === -1 && s < 90; s++) {
      const beforeScroll = await optionKey();
      const moved = await opts.first().evaluate((el) => {
        // Walk up to whichever ancestor actually scrolls.
        let n = el.parentElement;
        for (let d = 0; d < 8 && n; d++, n = n.parentElement) {
          if (n.scrollHeight > n.clientHeight + 4) {
            const before = n.scrollTop;
            n.scrollTop = before + Math.max(120, n.clientHeight * 0.8);
            return n.scrollTop !== before;
          }
        }
        return false;
      }).catch(() => false);
      if (!moved) break;
      // Virtualised rows swap in on the next paint; 90 iterations of a flat
      // 150ms sleep was up to 13.5s of scrolling a list that redraws in ~20.
      await optionsSettled(beforeScroll, 150, 25);
      ({ opts, texts } = await readOptions());
      idx = chooseOption(want, texts);
    }
  }
  if (idx !== -1) await commitPick(page, fieldId, opts, idx);
  await page.keyboard.press('Escape').catch(() => {});

  // Verified, not assumed.
  const ok = (await promptValue(page, fieldId)) !== '';
  // On failure, take my typed filter text back out. Leaving it behind puts words
  // in his form that he never chose and that Workday would not have accepted.
  if (!ok && canFilter) await filter.fill('').catch(() => {});
  return {
    ok,
    options: [...new Set(texts.filter(Boolean))],
    chosen: ok && idx !== -1 ? texts[idx] : (ok ? want : null),
  };
}

// Consent / certification / terms checkboxes. Alex's standing instruction is to
// consent to everything and fill it in, so these are ticked rather than left for
// him (see modes/_custom.md § House Rules). They still appear in the review block.
// Checkboxes that are NOT consents — "I have a preferred name" — stay untouched,
// because ticking one changes what the form asks for.
const CONSENT_RE = /certif|acknowledg|\bagree|consent|terms\s+(and|of)|privacy|accuracy\s+of|authorize/i;

async function tickCheckbox(page, fieldId, label, profile, result) {
  const boxes = page.locator(`[data-automation-id="${fieldId}"] input[type=checkbox]`);
  const count = await boxes.count().catch(() => 0);

  // A GROUP of checkboxes is a multiple-choice question wearing checkbox
  // clothing — Workday's disability self-ID is "Please check one of the boxes
  // below:" with the real answers on the individual boxes. Ticking the first one
  // would declare a disability status he never gave, so match by option text.
  if (count > 1) {
    const groupText = await page.locator(`[data-automation-id="${fieldId}"]`).first()
      .evaluate(el => (el.textContent || '').replace(/\s+/g, ' ')).catch(() => '');
    let want = null;
    if (/disabilit/i.test(groupText)) want = profile.eeo?.disability;
    else if (/veteran/i.test(groupText)) want = profile.eeo?.veteran;
    else {
      const r = resolveLabel(label, profile);
      if (r.kind === 'answer') want = r.value;
    }
    if (!want) {
      result.needsInput.push({ label: label || fieldId, why: 'checkbox group — no matching answer in apply-profile.yml; pick one yourself' });
      return 'skipped';
    }
    const own = [];
    for (let i = 0; i < count; i++) {
      own.push(await boxes.nth(i).evaluate((el) => {
        const l = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
        return (l?.textContent || '').replace(/\s+/g, ' ').trim();
      }).catch(() => ''));
    }
    const pick = chooseOption(want, own);
    if (pick !== -1) {
      const b = boxes.nth(pick);
      await b.evaluate((el) => (el.closest('label') || el).click()).catch(() => {});
      if (await b.isChecked().catch(() => false)) {
        result.review.push({ label: label || fieldId, value: own[pick].slice(0, 60) });
        result.filled.push({ label: label || fieldId, value: own[pick].slice(0, 60) });
        return 'skipped'; // already recorded
      }
    }
    result.needsInput.push({ label: label || fieldId, why: `checkbox group — no option matching "${want}"; pick one yourself` });
    return 'skipped';
  }

  // "I have a preferred name": tick it when his preferred name genuinely differs
  // from his legal name, because the preferred-name fields only RENDER once it is
  // ticked. His legal name is Anna Maria Alex Rivera; he goes by Alex Rivera, and without
  // this the application carries a name nobody at the company would recognise.
  if (/preferred name/i.test(label || '')) {
    const I = profile.identity || {};
    const differs = (I.preferred_first_name && I.preferred_first_name !== I.first_name)
      || (I.preferred_last_name && I.preferred_last_name !== I.last_name);
    if (!differs) {
      result.skipped.push({ label: label || fieldId, why: 'no preferred name configured — left unticked' });
      return 'skipped';
    }
    const box = boxes.first();
    if (await box.isChecked().catch(() => false)) return true;
    await box.evaluate((el) => (el.closest('label') || el).click()).catch(() => {});
    // The preferred-name inputs render on tick — wait for one of them, not for
    // a flat 800ms that is spent whether they appeared in 60ms or not at all.
    await until(async () => await page.locator('[data-automation-id="formField-preferredName--firstName"]')
      .count().catch(() => 0) > 0, 800);
    return await box.isChecked().catch(() => false);
  }

  if (!CONSENT_RE.test(label || '') || !profile.policy?.auto_check_certifications) {
    result.skipped.push({ label: label || fieldId, why: 'checkbox — not a consent; left for you' });
    return 'skipped';
  }
  const box = boxes.first();
  if (!(await box.count().catch(() => 0))) return false;
  if (await box.isChecked().catch(() => false)) return true;
  // Click the label — Workday's styled checkbox swallows direct input clicks.
  await box.evaluate((el) => (el.closest('label') || el).click()).catch(() => {});
  const on = await box.isChecked().catch(() => false);
  if (on) result.review.push({ label: label || fieldId, value: '☑ consented' });
  return on;
}

// ── page fillers ────────────────────────────────────────────────────

/** The formField-* ids on this step, read only once the count stops growing.
 *  Workday paints My Information in chunks — the phone block and the "How Did
 *  You Hear About Us" block can land after the name/address block. Enumerating
 *  once, immediately, meant late fields were never filled AND never reported:
 *  a required field would silently stay empty and the report looked clean. */
const FIELD_IDS_JS = `[...new Set([...document.querySelectorAll('[data-automation-id^="formField-"]')]
  .map(e => e.getAttribute('data-automation-id')))]`;

// How long the field count must hold still before the step counts as painted.
// The old loop sampled every 400ms and returned on two equal samples, so it
// guaranteed 400ms of quiet at a cost of never less than 800ms. This asks for
// MORE quiet (500ms) at a LOWER floor, which is the only honest trade here:
// returning early is not a fast application, it is a required field left empty
// and reported as filled, which is the failure this function exists to prevent.
const FIELD_QUIET_MS = 500;

/**
 * The controls a signed-out Workday paints instead of the form. ONE list, used
 * both to wait for the page to finish painting and to decide that what it
 * painted is a sign-in wall — those two questions were answered from two
 * different lists, and the shorter one did not mention sign-in at all, so every
 * signed-out tenant waited out a 20-second timeout before the wall was noticed.
 */
const SIGNIN_SELECTORS = '[data-automation-id="signInLink"], [data-automation-id="createAccountLink"],'
  + ' [data-automation-id="email"], [data-automation-id="signInContent"],'
  + ' [data-automation-id="GoogleSignInButton"], [data-automation-id="SignInWithEmailButton"]';
const SIGNIN_VISIBLE_SELECTORS = SIGNIN_SELECTORS.split(',')
  .map(s => s.trim() + ':visible').join(', ');

export async function settledFieldIds(page) { // exported for workday-form.test.mjs
  return time('wd:settle', async () => {
    // Settle INSIDE the renderer: the old loop paid a CDP round-trip per sample
    // and rounded every wait up to the next 400ms boundary, so a form that grew
    // in three chunks cost 1.6s of sleep on top of the paint itself.
    //
    // The marker is cleared first because Workday advances steps without a page
    // load — a leftover reading from the PREVIOUS step would otherwise satisfy
    // the quiet period on the new step's very first sample.
    await page.evaluate(() => { delete window.__jarvisFieldSettle; }).catch(() => {});
    await page.waitForFunction((quiet) => {
      const n = new Set([...document.querySelectorAll('[data-automation-id^="formField-"]')]
        .map((e) => e.getAttribute('data-automation-id'))).size;
      const s = window.__jarvisFieldSettle;
      if (!s || s.n !== n) { window.__jarvisFieldSettle = { n, since: Date.now() }; return false; }
      return n > 0 && Date.now() - s.since >= quiet;
    }, FIELD_QUIET_MS, { timeout: 10000, polling: 100 }).catch(() => {});
    return await page.evaluate(FIELD_IDS_JS).catch(() => []);
  });
}

/**
 * Read id + label + widget kind for every field on the step in ONE page call.
 *
 * This was two `page.evaluate`s PER FIELD — on a 20-field My Information step
 * that is 40 CDP round-trips, each a process hop to fetch a few bytes of DOM,
 * and it repeated on the second pass and on every one of the six steps. The
 * logic is unchanged; only the number of trips is.
 */
export async function fieldManifest(page, ids) { // exported for workday-form.test.mjs
  return time('wd:manifest', () => page.evaluate((wanted) => wanted.map((fid) => {
    const el = document.querySelector(`[data-automation-id="${fid}"]`);
    if (!el) return { fid, label: '', kind: 'text' };
    const label = (el.querySelector('label,legend')?.textContent || '').replace(/\*$/, '').trim();
    let kind = 'text';
    if (el.querySelector('input[type=radio]')) kind = 'radio';
    else if (el.querySelector('input[type=checkbox]')) kind = 'checkbox';
    // Segmented date (Month/Day/Year spinners) — never fill()'d as one string.
    else if (el.querySelector('[data-automation-id="dateSectionMonth-input"], [data-automation-id="dateInputWrapper"]')) kind = 'date';
    // A prompt/typeahead — even one WITH a text input (e.g. "How did you hear",
    // Country, State) — must be driven as a prompt, not fill()'d as text.
    else if (el.querySelector('[data-automation-id="promptIcon"], button[aria-haspopup="listbox"], [data-uxi-widget-type="selectinput"], [data-automation-id="multiSelectContainer"]')) kind = 'prompt';
    else if (el.querySelector('button[aria-haspopup]') && !el.querySelector('input[type=text],input:not([type])')) kind = 'prompt';
    return { fid, label, kind };
  }), ids).catch(() => ids.map((fid) => ({ fid, label: '', kind: 'text' }))));
}

async function fillCurrentPage(page, profile, result) {
  const done = new Set();
  // Two passes: whatever rendered late still gets filled and reported.
  for (let pass = 0; pass < 2; pass++) {
  const fieldIds = (await settledFieldIds(page)).filter((id) => !done.has(id));
  if (!fieldIds.length) break;

  for (const { fid, label, kind } of await fieldManifest(page, fieldIds)) {
    done.add(fid);

    // Never touch EEO / disability / certification fields.
    const r0 = resolveLabel(label, profile);
    if (r0.kind === 'never') { result.skipped.push({ label: label || fid, why: 'left blank by policy' }); continue; }

    // Consent checkboxes are decided by policy, not by a profile answer, so they
    // must be handled BEFORE value resolution — otherwise "Yes, I have read and
    // consent to the terms and conditions" falls out at "no answer in
    // apply-profile.yml" and never reaches the checkbox branch at all.
    if (kind === 'checkbox') {
      const res = await time('wd:checkbox', () => tickCheckbox(page, fid, label, profile, result));
      if (res === 'skipped') continue;
      if (res) result.filled.push({ label: label || fid, value: '☑ consented' });
      else result.needsInput.push({ label: label || fid, why: 'could not tick this box — do it manually' });
      continue;
    }

    // Resolve value: explicit Workday map first, then the label matcher.
    let value = wdValue(fid, profile);
    if (value === null) continue; // intentionally left blank (e.g. extension)
    let review = false;
    if (value === undefined) {
      const r = resolveLabel(label, profile);
      if (r.kind === 'answer') { value = r.value; review = r.review; }
      else if (r.kind === 'unknown') { if (label) result.needsInput.push({ label, why: 'no answer in apply-profile.yml' }); continue; }
      else continue;
    }
    // A value may be a list of acceptable answers (see formField-source).
    const wantList = Array.isArray(value) ? value : [value];
    if (!wantList.length || wantList.every(v => v == null || String(v).trim() === '')) {
      if (label) result.needsInput.push({ label, why: 'empty in apply-profile.yml — add it' });
      continue;
    }
    let shownValue = String(wantList[0]);

    // One stubborn field must never crash the whole application.
    let ok = false;
    let options = [];
    try {
      if (kind === 'radio') ok = await time('wd:radio', () => pickRadio(page, fid, wantList[0]));
      else if (kind === 'date') ok = await time('wd:date', () => fillDateParts(page, fid, wantList[0]));
      else if (kind === 'prompt') {
        const p = await time('wd:prompt', () => pickPrompt(page, fid, wantList));
        ok = p.ok; options = p.options;
        if (p.chosen) shownValue = String(p.chosen).trim();
      }
      else ok = await time('wd:text', () => fillText(page, fid, wantList[0]));
    } catch (e) {
      result.needsInput.push({ label: label || fid, why: `fill failed (${e.message.split('\n')[0].slice(0, 40)}) — do it manually` });
      continue;
    }

    if (ok) { result.filled.push({ label: label || fid, value: shownValue }); if (review) result.review.push({ label: label || fid, value: shownValue }); }
    else {
      // Name the options the tenant actually offers, so picking it by hand is one
      // glance instead of a hunt. Tenants word these lists very differently.
      const shown = options.length ? ` — this tenant offers: ${options.slice(0, 10).join(' | ')}` : '';
      result.needsInput.push({ label: label || fid, why: `could not set "${wantList.join('" / "')}"${shown}` });
    }
  }
  }
}

// Resume upload on the My Experience step.
async function tryResume(page, profile, result) {
  const path = profile.documents?.resume_path;
  const fileInput = page.locator('input[type=file]').first();
  if (!(await fileInput.count())) return;
  if (!path) { result.needsInput.push({ label: 'Resume', why: 'no resume_path set — upload manually' }); return; }

  // Resuming a draft means a resume is ALREADY attached. Uploading again stacks
  // duplicates: three identical PDFs on one application is what the recruiter
  // opens, and it reads as careless. Never upload on top of an existing file.
  const attached = await page.evaluate(() =>
    document.querySelectorAll('[data-automation-id="delete-file"]').length).catch(() => 0);
  if (attached > 0) {
    result.skipped.push({
      label: 'Resume',
      why: attached === 1
        ? 'already attached to this application — not uploading a second copy'
        : `already attached ${attached}× — DELETE the extra copies before submitting`,
    });
    if (attached > 1) {
      result.needsInput.push({ label: 'Duplicate resumes', why: `${attached} copies attached — remove all but one` });
    }
    result.resumeUploaded = true;
    return;
  }

  try {
    await fileInput.setInputFiles(path);
    // Workday silently ignores Save and Continue while the upload is still in
    // flight. On ASML's resume-only My Experience step that looked exactly like
    // "a required field is unfilled" — the page was simply not ready yet.
    await page.waitForFunction(() => {
      if (document.querySelector('[data-automation-id="delete-file"]')) return true;
      return /successfully uploaded/i.test(document.body.innerText || '');
    }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    result.resumeUploaded = true;
    result.filled.push({ label: 'Resume', value: `(uploaded ${path})` });
  } catch (e) { result.needsInput.push({ label: 'Resume', why: `upload failed: ${e.message.split('\n')[0]}` }); }
}

// ── My Experience: nested Work Experience / Education sub-forms ──────
//
// Workday will not advance past My Experience without at least one Work
// Experience OR Education entry, and it does not populate them from the
// uploaded resume. Each section is an "Add" button that injects a sub-form with
// its own fields; a second click gives "Add Another". Entry fields carry the
// same stable data-automation-ids as the rest of Workday, but the ids vary a
// little by tenant, so each logical field lists candidates and we take the
// first one actually present inside the entry.
//
// Everything here degrades to a review flag: a section we cannot find, a field
// we cannot set, and a profile with nothing to enter all end up in
// result.needsInput rather than throwing or, worse, half-filling an entry
// silently.

const WORK_FIELDS = [
  { key: 'title', ids: ['formField-jobTitle', 'formField-title'], type: 'text' },
  { key: 'company', ids: ['formField-companyName', 'formField-company'], type: 'text' },
  { key: 'location', ids: ['formField-location'], type: 'text' },
  { key: 'description', ids: ['formField-roleDescription', 'formField-description'], type: 'text' },
];

// Languages sub-form. Tenants vary in how many proficiency prompts they show
// (overall, or one each for reading/speaking/writing); every one is optional, so
// whatever is present gets set and whatever is absent is simply not there.
const LANG_FIELDS = [
  { key: 'name', ids: ['formField-language', 'formField-languageName'], type: 'auto' },
  { key: 'proficiency', ids: ['formField-languageProficiency', 'formField-overallProficiency', 'formField-proficiency'], type: 'auto' },
];

const EDU_FIELDS = [
  { key: 'school', ids: ['formField-schoolName', 'formField-school', 'formField-schoolItem'], type: 'auto' },
  { key: 'degree', ids: ['formField-degree'], type: 'auto' },
  { key: 'fieldOfStudy', ids: ['formField-fieldOfStudy', 'formField-fieldsOfStudy'], type: 'auto' },
  { key: 'gpa', ids: ['formField-gradeAverage', 'formField-gpa'], type: 'text' },
  { key: 'firstYear', ids: ['formField-firstYearAttended'], type: 'year' },
  { key: 'lastYear', ids: ['formField-lastYearAttended'], type: 'year' },
];

/** Human label for the review report. */
const pretty = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/**
 * Find the "Add" button belonging to the section whose heading matches `re`.
 * Heading-driven rather than positional: the observed order on NVIDIA was
 * Work Experience=0, Education=1, Websites=2, but tenants reorder and hide
 * sections, and an off-by-one here would type a job title into a website field.
 * Falls back to `fallbackIndex` only when no heading can be read at all.
 */
async function findAddButton(page, re, fallbackIndex) {
  const btns = page.locator('[data-automation-id="Add"], [data-automation-id="add-button"]');
  const n = await btns.count().catch(() => 0);
  let sawHeading = false;
  for (let i = 0; i < n; i++) {
    const heading = await btns.nth(i).evaluate((el) => {
      // Walk up to the nearest ancestor that owns a heading.
      let node = el.parentElement;
      for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
        const h = node.querySelector('h1,h2,h3,h4,h5,legend,[role="heading"]');
        const text = (h?.textContent || '').trim();
        if (text) return text;
      }
      return '';
    }).catch(() => '');
    if (heading) sawHeading = true;
    if (heading && re.test(heading)) return btns.nth(i);
  }
  if (!sawHeading && fallbackIndex != null && fallbackIndex < n) return btns.nth(fallbackIndex);
  return null;
}

/** The sub-form container for the entry we just added (the last one in its section). */
function lastEntryPanel(page, fieldIds) {
  // Scope by a field the entry is guaranteed to own; `.last()` targets the
  // newest sub-form so "Add Another" appends instead of overwriting entry 1.
  const sel = fieldIds.map((id) => `[data-automation-id="${id}"]`).join(', ');
  return page.locator(sel).last();
}

/** Set one field inside an entry sub-form. Returns true when a value landed. */
async function setEntryField(page, spec, value) {
  for (const id of spec.ids) {
    const container = page.locator(`[data-automation-id="${id}"]`).last();
    if (!(await container.count().catch(() => 0))) continue;

    // Decide text vs prompt from the DOM — School/Degree/Field of Study are
    // typeaheads on most tenants but plain text on some.
    let type = spec.type;
    if (type === 'auto' || type === 'year') {
      const isPrompt = await container.evaluate((el) => {
        if (el.querySelector('[data-automation-id="promptIcon"], button[aria-haspopup="listbox"], [data-uxi-widget-type="selectinput"], [data-automation-id="multiSelectContainer"]')) return true;
        // Degree / Field of Study render as a bare "Select One" button.
        const btn = el.querySelector('button');
        return !!btn && /select one|select a value/i.test(btn.textContent || '');
      }).catch(() => false);
      type = isPrompt ? 'prompt' : 'text';
    }

    // pickPrompt returns {ok, options, chosen} — an object is always truthy, so
    // it must be unwrapped. Testing it directly reported every typeahead as
    // filled no matter what happened.
    let options = [];
    let ok;
    if (type === 'prompt') {
      const p = await pickPrompt(page, id, value);
      ok = p.ok; options = p.options;
    } else {
      ok = await fillText(page, id, value);
    }
    if (ok) return { ok: true, options };

    // A typeahead that rejected a free-text fill: retry as a prompt once.
    if (type === 'text' && spec.type === 'auto') {
      const p = await pickPrompt(page, id, value);
      if (p.ok) return { ok: true, options: p.options };
      options = p.options;
    }
    return { ok: false, options };
  }
  // Field not present on this tenant at all — not an error, and reporting it as
  // one buries the flags that do need his attention (KLA has no First/Last Year
  // Attended, so those were showing up as failures every run).
  return 'absent';
}

/** Fill a Workday compound date (Month / Year spinners) inside `fieldId`. */
async function setEntryDate(page, fieldId, date) {
  const container = page.locator(`[data-automation-id="${fieldId}"]`).last();
  if (!(await container.count().catch(() => 0))) return false;
  let any = false, allStuck = true;
  const parts = [
    ['dateSectionMonth-input', date.month],
    ['dateSectionYear-input', date.year],
  ];
  for (const [id, val] of parts) {
    if (val == null) continue;
    const input = container.locator(`[data-automation-id="${id}"]`).first();
    if (!(await input.count().catch(() => 0))) continue;
    try {
      await input.click({ timeout: 3000 }).catch(() => {});
      // Real keystrokes only — synthetic input events crash Workday's React
      // date widget ("Something went wrong").
      await input.pressSequentially(String(val), { delay: 20, timeout: 4000 });
      any = true;
    } catch { /* leave for the user */ }
    // Read it back. Typing into Workday's date spinner can be swallowed, and
    // reporting "From = 05/2026" for an empty box is how a required-field error
    // arrives with a report that claims everything is filled.
    const now = await input.inputValue().catch(() => '');
    if (!String(now).trim()) allStuck = false;
  }
  return any && allStuck;
}

/** Check the "I currently work here" box in the newest work entry. */
async function setCurrentlyWorkHere(page) {
  const box = page.locator(
    '[data-automation-id="formField-currentlyWorkHere"] input[type=checkbox], [data-automation-id="currentlyWorkHere"] input[type=checkbox]',
  ).last();
  if (!(await box.count().catch(() => 0))) return false;
  if (await box.isChecked().catch(() => false)) return true;
  // Click the label, not the input — Workday's styled checkbox swallows direct
  // input clicks on several tenants.
  await box.evaluate((el) => (el.closest('label') || el).click()).catch(() => {});
  return await box.isChecked().catch(() => false);
}

/** Does this section already contain an entry with a non-empty value? */
async function sectionAlreadyFilled(page, anchorIds) {
  const sel = anchorIds.map((id) => `[data-automation-id="${id}"]`).join(', ');
  return await page.evaluate((s) => {
    for (const container of document.querySelectorAll(s)) {
      for (const input of container.querySelectorAll('input, textarea')) {
        if ((input.value || '').trim()) return true;
      }
    }
    return false;
  }, sel).catch(() => false);
}

/**
 * Delete any entry panel left with an empty required field.
 *
 * Workday pre-creates a blank Work Experience panel on this step, and it rejects
 * the whole page with "Job Title is required" for that panel — an entry the user
 * never asked for. Trying to predict whether the blank exists proved unreliable
 * (tenants differ, and Workday collapses saved panels out of the DOM), so this
 * cleans up after the fact: find panels whose anchor field is still empty and
 * remove them. Anything that cannot be removed is flagged, never left silent.
 */
async function removeBlankEntries(page, primaryId, label, result) {
  for (let guard = 0; guard < 4; guard++) {
    const containers = page.locator(`[data-automation-id="${primaryId}"]`);
    const n = await containers.count().catch(() => 0);
    let removed = false;
    for (let i = n - 1; i >= 0; i--) {
      const c = containers.nth(i);
      const empty = await c.evaluate((el) => {
        const ctl = el.querySelector('input, textarea');
        return !!ctl && !(ctl.value || '').trim();
      }).catch(() => false);
      if (!empty) continue;

      const del = c.locator('xpath=ancestor::*[self::div or self::section][.//button][1]')
        .locator('button').filter({ hasText: /delete|remove/i }).first();
      const viaPanel = (await del.count().catch(() => 0))
        ? del
        : page.locator('[data-automation-id="panel-set-delete-button"], [data-automation-id="delete-button"]').last();
      if (!(await viaPanel.count().catch(() => 0))) {
        result.needsInput.push({
          label: `${label} — blank entry`,
          why: 'Workday left an empty entry here and it has no Delete button I can find — remove it before submitting',
        });
        return;
      }
      await viaPanel.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(900);
      // Some tenants ask to confirm the delete.
      const confirm = page.locator('button').filter({ hasText: /^(ok|delete|yes)$/i }).first();
      if (await confirm.count().catch(() => 0)) {
        await confirm.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(700);
      }
      result.skipped.push({ label: `${label} — blank entry`, why: 'removed the empty panel Workday pre-created' });
      removed = true;
      break;
    }
    if (!removed) return;
  }
}

/** Add and fill every Work Experience + Education entry. */
async function fillMyExperience(page, profile, result) {
  if (!hasAnyExperience(profile)) {
    result.needsInput.push({
      label: 'My Experience',
      why: 'no work_experience or education_entries in apply-profile.yml — Workday requires at least one; add it there or fill this step manually',
    });
    return;
  }

  const sections = [
    {
      re: /work\s*experience|employment/i,
      fallbackIndex: 0,
      entries: workEntries(profile),
      anchorIds: WORK_FIELDS.flatMap((f) => f.ids),
      fill: fillWorkEntry,
    },
    {
      re: /education/i,
      fallbackIndex: 1,
      entries: educationEntries(profile),
      anchorIds: EDU_FIELDS.flatMap((f) => f.ids),
      fill: fillEducationEntry,
    },
    {
      re: /language/i,
      fallbackIndex: null,
      entries: Array.isArray(profile.languages) ? profile.languages : [],
      anchorIds: LANG_FIELDS.flatMap((f) => f.ids),
      fill: fillLanguageEntry,
    },
  ];

  for (const section of sections) {
    if (section.entries.length === 0) continue;
    const label = section.re.source.split('\\s*')[0].replace(/[^a-z ]/gi, '');

    // Not every tenant HAS these sections. ASML's My Experience is resume-only,
    // and reporting "could not find its Add button" there is a false alarm that
    // makes a clean run look broken. Absent section = nothing to do.
    const anchorSel = section.anchorIds.map((id) => `[data-automation-id="${id}"]`).join(', ');
    const anchorsPresent = await page.locator(anchorSel).count().catch(() => 0);
    const anyAdd = await findAddButton(page, section.re, null);
    if (!anchorsPresent && !anyAdd) {
      result.skipped.push({ label: `${label} entries`, why: 'this tenant has no such section on My Experience' });
      continue;
    }

    // Skip a section that already holds a filled entry — a resumed draft, or a
    // tenant whose resume parse did populate it. Adding on top would duplicate
    // the user's history on a real application.
    if (await sectionAlreadyFilled(page, section.anchorIds)) {
      result.skipped.push({ label: `${label} entries`, why: 'already present on this application — left as-is' });
      continue;
    }

    // Workday pre-creates ONE blank panel on this step. Clicking Add for the
    // first entry therefore leaves that blank panel behind, and Workday refuses
    // the page with "Job Title is required" for a panel the user never asked for.
    // Reuse an empty trailing panel instead of adding another.
    const primaryId = section.anchorIds[0];
    const lastPanelIsEmpty = async () => await page.evaluate((id) => {
      const els = [...document.querySelectorAll(`[data-automation-id="${id}"]`)];
      if (!els.length) return false;
      const ctl = els[els.length - 1].querySelector('input, textarea');
      return !ctl || !(ctl.value || '').trim();
    }, primaryId).catch(() => false);

    for (let i = 0; i < section.entries.length; i++) {
      if (await lastPanelIsEmpty()) {
        await section.fill(page, section.entries[i], result, i + 1);
        continue;
      }
      const addBtn = await findAddButton(page, section.re, i === 0 ? section.fallbackIndex : null);
      if (!addBtn) {
        result.needsInput.push({
          label: `${label} entry ${i + 1}`,
          why: i === 0
            ? 'could not find its Add button on this tenant — add the entry manually'
            : 'no "Add Another" available — remaining entries not added',
        });
        break;
      }
      await addBtn.scrollIntoViewIfNeeded().catch(() => {});
      await addBtn.click({ timeout: 6000 }).catch(() => {});
      // Wait for the sub-form to render rather than a fixed sleep.
      await page.locator(section.anchorIds.map((id) => `[data-automation-id="${id}"]`).join(', '))
        .last().waitFor({ state: 'visible', timeout: 8000 })
        .catch(() => {});
      await section.fill(page, section.entries[i], result, i + 1);
    }

    // Whatever blank panel survived, take it out — it is a hard validation stop.
    await removeBlankEntries(page, primaryId, label, result);
  }
}

async function fillWorkEntry(page, entry, result, n) {
  const tag = `Work experience ${n}${entry.company ? ` (${entry.company})` : ''}`;
  for (const spec of WORK_FIELDS) {
    const value = entry[spec.key];
    if (!value) continue;
    const ok = await setEntryField(page, spec, value);
    record(result, ok, `${tag} — ${pretty(spec.key)}`, value);
  }

  if (entry.current) {
    const ok = await setCurrentlyWorkHere(page);
    record(result, ok, `${tag} — I currently work here`, 'checked');
    // Employment status is legally significant and derived from a date, so it
    // always surfaces in the review block even when it filled cleanly.
    if (ok) result.review.push({ label: `${tag} — I currently work here`, value: 'checked' });
  }

  if (entry.start) {
    const ok = await setEntryDate(page, 'formField-startDate', entry.start);
    record(result, ok, `${tag} — From`, fmtDate(entry.start));
  }
  if (entry.end) {
    const ok = await setEntryDate(page, 'formField-endDate', entry.end);
    record(result, ok, `${tag} — To`, fmtDate(entry.end));
  }
}

async function fillLanguageEntry(page, entry, result, n) {
  const tag = `Language ${n}${entry.name ? ` (${entry.name})` : ''}`;
  for (const spec of LANG_FIELDS) {
    const value = entry[spec.key];
    if (!value) continue;
    record(result, await setEntryField(page, spec, String(value)), `${tag} — ${pretty(spec.key)}`, String(value));
  }
}

async function fillEducationEntry(page, entry, result, n) {
  const tag = `Education ${n}${entry.school ? ` (${entry.school})` : ''}`;
  for (const spec of EDU_FIELDS) {
    const value = entry[spec.key];
    if (!value) {
      // Only worth flagging when this tenant actually asks for it.
      if (spec.key === 'firstYear' || spec.key === 'lastYear') {
        const present = await page.locator(spec.ids.map(id => `[data-automation-id="${id}"]`).join(', ')).count().catch(() => 0);
        if (present) result.needsInput.push({ label: `${tag} — ${pretty(spec.key)}`, why: 'blank in apply-profile.yml — add it' });
      }
      continue;
    }
    const ok = await setEntryField(page, spec, String(value));
    record(result, ok, `${tag} — ${pretty(spec.key)}`, String(value));
  }
}

// Accepts a bare boolean (date / checkbox helpers) or setEntryField's
// {ok, options} — a failure that names the tenant's real options is one glance
// to fix by hand instead of a hunt.
function record(result, res, label, value) {
  if (res === 'absent') return; // this tenant does not ask for it
  const ok = res === true || (res && res.ok === true);
  const options = (res && res.options) || [];
  if (ok) { result.filled.push({ label, value: String(value) }); return; }
  const shown = options.length ? ` — this tenant offers: ${options.slice(0, 10).join(' | ')}` : '';
  result.needsInput.push({ label, why: `could not set "${value}"${shown}` });
}

function fmtDate(d) {
  return d.month ? `${String(d.month).padStart(2, '0')}/${d.year}` : String(d.year);
}

/** Read the current step name from the progress bar. */
async function currentStep(page) {
  return await page.locator('[data-automation-id="progressBarActiveStep"]').first()
    .textContent().catch(() => '') || '';
}

async function clickSaveAndContinue(page) {
  const btn = page.locator(SAVE_BTN).first();
  if (!(await btn.count())) return false;
  const txt = ((await btn.textContent().catch(() => '')) || '').trim();
  if (SUBMIT_RE.test(txt)) return false; // never click Submit
  const before = await currentStep(page);
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 6000 }).catch(() => {});
  // Saving is a server round-trip. The old fixed 1.8s sleep concluded "did not
  // advance" while the page was still saving, which is why identical runs
  // sometimes reached Review and sometimes stalled on a fully-filled page. Wait
  // for a real signal instead: the step changed, or a validation error appeared.
  await page.waitForFunction((prev) => {
    const step = (document.querySelector('[data-automation-id="progressBarActiveStep"]') || {}).textContent || '';
    if (step && step !== prev) return true;
    return !!document.querySelector('[data-automation-id="errorMessage"], [data-automation-id="errorHeading"]');
  }, before, { timeout: 25000 }).catch(() => {});
  // The next step starts painting immediately after the step name flips. Wait
  // for the thing the caller is about to look for rather than a flat 700ms.
  await until(async () => await page
    .locator('[data-automation-id^="formField-"], [data-automation-id="reviewPanel"], input[type=file]')
    .count().catch(() => 0) > 0, 700);
  return true;
}

// ── overlays ────────────────────────────────────────────────────────

/** Clear a cookie / legal-notice banner that would intercept every later click.
 *  Declines the optional cookies: that is the privacy-preserving choice and it
 *  dismisses the banner just as well as accepting. This is the website's own
 *  cookie notice, not part of his application, so his standing "consent to
 *  everything" (which is about application questions) does not apply here. */
async function dismissLegalNotice(page) {
  const decline = page.locator('[data-automation-id="legalNoticeDeclineButton"]').first();
  if (await decline.count().catch(() => 0)) {
    await decline.click({ timeout: 4000 }).catch(() => {});
    await until(async () => await decline.count().catch(() => 1) === 0, 700);
    return true;
  }
  return false;
}

// ── sign-in ─────────────────────────────────────────────────────────

// Every Workday tenant keeps its own candidate account, so "already signed into
// Workday" means nothing on a tenant you have not used. Each tenant does offer
// social sign-in, and Google SSO reuses the session already in this browser
// profile — one click, no credentials typed here.
//
// AUTHENTICATION IS AUTOMATED (Alex's standing consent, 2026-08-11: "i consent
// to most automation as possible, filling in passwords logging in etc"). This
// clicks the SSO button, picks his account, and SUBMITS a password field Chrome
// has already autofilled. An engine that hands the application back at the login
// wall has defeated its own purpose.
//
// What it still will not do: invent or store a password. Nothing here reads a
// credential from a file, because a Google password sitting in the repo would
// leak AND fail — scripted password entry is what trips Google's 2FA/device
// verification in the first place. If the field is empty and Chrome has nothing
// saved for it, that is the one case it hands back.
//
// The hard line that remains: never submit the application. That is his.
async function signInWithGoogle(page, profile, result) {
  const btn = page.locator('[data-automation-id="GoogleSignInButton"]').first();
  if (!(await btn.count().catch(() => 0))) {
    result.needsInput.push({
      label: 'Sign in',
      why: 'This tenant offers no Google sign-in — sign in (or create the candidate account) yourself in this window, then re-run',
    });
    return false;
  }

  // Google SSO may open in a popup or navigate the same tab; handle both.
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
  await btn.click({ timeout: 10000 }).catch(() => {});
  const popup = await popupPromise;
  const auth = popup || page;
  await auth.waitForLoadState('domcontentloaded').catch(() => {});
  await auth.waitForTimeout(2500);

  // Account chooser: pick the profile's own address, never "whichever is first".
  const email = profile?.identity?.email || '';
  if (email) {
    const choice = auth.locator(`[data-identifier="${email}"], div[role=link]:has-text("${email}"), li:has-text("${email}")`).first();
    if (await choice.count().catch(() => 0)) {
      await choice.click({ timeout: 8000 }).catch(() => {});
      await auth.waitForTimeout(2500);
    }
  }

  // A password prompt. Chrome's own password manager fills this on his profile,
  // but it only commits the value after a real user gesture — so click the field
  // first, then read it back. A real Playwright click IS that gesture.
  const pw = auth.locator('input[type=password]:visible').first();
  if (await pw.count().catch(() => 0)) {
    await pw.click({ timeout: 5000 }).catch(() => {});
    const filled = await until(
      async () => ((await pw.inputValue().catch(() => '')) || '').length > 0, 2500);
    if (filled) {
      // Submit it. Enter is what a person does here and it works on every
      // variant of the Google form, including the ones with no visible button.
      await pw.press('Enter').catch(() => {});
      await auth.waitForLoadState('domcontentloaded').catch(() => {});
      await until(async () => await auth.locator('input[type=password]:visible')
        .count().catch(() => 1) === 0, 8000);
    }
    // Still asking: either nothing was saved for this account, or Google has
    // escalated to 2FA / device verification, which no amount of automation gets
    // past. Say which, because the fix is different.
    if (await auth.locator('input[type=password]:visible').count().catch(() => 0)) {
      result.needsInput.push({
        label: 'Google password',
        why: filled
          ? 'Google rejected the saved password or wants 2FA — finish it in this window; the session then persists for every later run'
          : 'Chrome has no saved password for this account — sign in once in this window (node jarvis/apply.mjs --login), then it persists',
      });
      return false;
    }
  }
  // 2FA / "verify it's you" — nothing scriptable, and saying so beats timing out.
  const twoFactor = await auth.evaluate(() => /2-step|verify it.s you|verification code|check your phone/i
    .test(document.body?.innerText || '')).catch(() => false);
  if (twoFactor) {
    result.needsInput.push({
      label: 'Google 2-step verification',
      why: 'Google wants a second factor — approve it in this window; the session then persists for every later run',
    });
    return false;
  }

  // Back on the tenant: wait for the sign-in step to give way to a real form.
  await page.waitForFunction(() => {
    const step = (document.querySelector('[data-automation-id="progressBarActiveStep"]') || {}).textContent || '';
    return !/sign in|create account/i.test(step)
      || !!document.querySelector('[data-automation-id^="formField-"]');
  }, null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const stillOut = await page.evaluate(() => {
    const step = (document.querySelector('[data-automation-id="progressBarActiveStep"]') || {}).textContent || '';
    return /sign in|create account/i.test(step)
      && !document.querySelector('[data-automation-id^="formField-"]');
  }).catch(() => false);
  if (stillOut) {
    result.needsInput.push({
      label: 'Sign in',
      why: 'Google sign-in did not complete (consent screen or a new-account prompt) — finish it in this window, then re-run',
    });
    return false;
  }

  result.filled.push({ label: 'Signed in', value: `Google SSO${email ? ` (${email})` : ''}` });
  return true;
}

/**
 * Read the Review page back and report what is actually missing.
 *
 * Filling a field and verifying it on the spot is not the same as Workday having
 * SAVED it. A run reported terms consented and the whole Self Identify section
 * filled, and the live application showed both empty — which is the worst failure
 * this engine can have, because the report looked clean. The Review page is
 * Workday's own summary of what it will submit, so it is the one honest source.
 */
async function auditReview(page, profile, result) {
  // The Review page renders its summary panels after the step flips. Falls back
  // to the full 1.5s on a tenant that names neither panel, so nothing regresses.
  await until(async () => await page
    .locator('[data-automation-id="reviewPanel"], [data-automation-id="summary"]')
    .count().catch(() => 0) > 0, 1500);
  const text = await page.evaluate(
    () => (document.body.innerText || '').replace(/\s+/g, ' '),
  ).catch(() => '');
  if (!text) return;

  const I = profile.identity || {};
  const E = profile.education || {};
  const lower = text.toLowerCase();
  const digits = text.replace(/[^\d]/g, '');

  // Match the way Workday RENDERS each value, not the way we stored it, or the
  // audit cries wolf: the phone comes back as "+1 (555) 000-0000" and the degree
  // as "Bachelors of Arts or Science (Bachelors)". A warning that is wrong twice
  // is a warning he will start ignoring, which would defeat the point.
  const checks = [
    ['Email', () => !I.email || lower.includes(String(I.email).toLowerCase())],
    ['Phone', () => {
      const d = String(I.phone || '').replace(/[^\d]/g, '').slice(-10);
      return !d || digits.includes(d);
    }],
    ['City', () => !I.city || lower.includes(String(I.city).toLowerCase())],
    ['School', () => !E.school || lower.includes(String(E.school).toLowerCase())],
    ['Degree', () => {
      // Compare on the degree LEVEL — the only part whose wording is stable.
      const lvl = (String(E.degree || '').match(/bachelor|master|doctor|associate/i) || [])[0];
      return !lvl || lower.includes(lvl.toLowerCase());
    }],
  ];
  const missing = checks.filter(([, ok]) => !ok()).map(([k]) => k);

  // Workday prints the placeholder for anything still unselected.
  const blanks = (text.match(/Select One/gi) || []).length;

  if (missing.length) {
    result.needsInput.push({
      label: 'Review page is missing data',
      why: `${missing.join(', ')} not shown on the Review summary — those sections did not save; open them and re-enter before submitting`,
    });
  }
  if (blanks) {
    result.needsInput.push({
      label: 'Unselected fields on Review',
      why: `${blanks} field(s) still show "Select One" — check every section before submitting`,
    });
  }
  if (!missing.length && !blanks) {
    result.filled.push({ label: 'Review audit', value: 'summary shows your details — nothing obviously missing' });
  }
}

// ── top-level ───────────────────────────────────────────────────────

export async function fill(page, profile) {
  const result = { filled: [], review: [], needsInput: [], skipped: [], resumeUploaded: false };
  const tStart = performance.now();

  // Before anything else: a cookie banner sits on top of the Apply button.
  await dismissLegalNotice(page);

  // 1. Start Your Application modal. On a job posting, click Apply
  // (data-automation-id="adventureButton" — confirmed stable) to open the modal,
  // then choose "Apply Manually" (deterministic empty form). Uses real
  // visibility waits, not fixed timeouts.
  if (!/\/apply\//i.test(page.url())) {
    // Once a draft exists for this requisition, Workday replaces Apply with
    // "Continue Application" and there is no adventureButton at all — which read
    // as "Apply button not found" and stopped the run on a perfectly good
    // application. Accept either, and resume the draft rather than starting over.
    const applyBtn = page.locator('[data-automation-id="adventureButton"]')
      .or(page.locator('a, button').filter({ hasText: /^\s*(apply|continue application|continue)\s*$/i }))
      .first();
    // Wait for the job-page SPA to hydrate before clicking, or the modal opens
    // but its "Apply Manually" link isn't wired yet and the click won't navigate.
    await time('wd:start-hydrate', async () => {
      await applyBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
    });
    if (await applyBtn.count()) {
      const resuming = /continue/i.test(((await applyBtn.textContent().catch(() => '')) || ''));
      await applyBtn.click({ timeout: 8000 }).catch(() => {});
      const manual = page.locator('[data-automation-id="applyManually"]').first();
      // Are we past the front door — by URL, or by the flow's own chrome being
      // on screen? Waiting on the URL ALONE is what cost 19 seconds of every
      // application: resuming a saved draft shows no modal and does not always
      // move the URL, so both waits below sat out their full timeouts (4s + 15s)
      // on a page that was already ready. Race the real condition instead; the
      // old timeouts stay as ceilings.
      const inFlow = async () => /\/apply\//i.test(page.url())
        || await page.locator('[data-automation-id="progressBarActiveStep"], [data-automation-id^="formField-"]')
          .count().catch(() => 0) > 0;

      let sawModal = false;
      await time('wd:start-modal', () => until(async () => {
        if (await manual.isVisible().catch(() => false)) { sawModal = true; return true; }
        return await inFlow();
      }, resuming ? 4000 : 12000, 150));

      if (sawModal) {
        // Navigate via the link's real href rather than a raced click.
        const href = await manual.getAttribute('href').catch(() => null);
        if (href) await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded' }).catch(() => {});
        else await manual.click({ timeout: 8000 }).catch(() => {});
        await time('wd:start-nav', () => until(inFlow, 12000, 200));
      } else {
        // Resuming a draft goes straight into the flow — no modal, and that is
        // success, not a problem worth flagging.
        await time('wd:start-nav', () => until(inFlow, 15000, 200));
        if (await inFlow()) result.filled.push({ label: 'Existing application', value: 'resumed your saved draft' });
        else result.needsInput.push({ label: 'Start application', why: 'Apply modal did not appear — open it manually' });
      }
    } else {
      // No Apply button on a job URL means this is not a live posting page.
      // Workday answers HTTP 200 with an empty SPA shell for a dead requisition
      // and only paints "the page you are looking for doesn't exist" after
      // hydration — so this is the FIRST place a closed req becomes visible to
      // the engine. Returning quietly here is what made a dead posting look like
      // a successful run that simply filled zero fields.
      const gone = await page.evaluate(() =>
        /page you are looking for doesn.t exist|no longer available|job posting has expired/i.test(document.body.innerText || '')
        || !!document.querySelector('[data-automation-id="errorMessage"]')).catch(() => false);
      // `blocker: 'gone'` is what apply.mjs reads to write goneAt on the job, so
      // a dead requisition leaves the deck instead of being queued again. This
      // adapter had detected the state and only ever printed it: a random sample
      // of four deck postings turned up TWO dead Workday reqs — Intel and Abbott
      // — both correctly identified here, both still sitting in the deck
      // afterwards because nothing recorded what the engine had just learned.
      result.needsInput.push(gone
        ? { label: 'Posting is gone', blocker: 'gone', why: 'Workday says this page does not exist — the requisition is closed. It has been marked gone and will leave your deck.' }
        : { label: 'Apply button not found', why: 'No Apply (adventureButton) on this page — not a Workday posting, or it never finished loading' });
      return result;
    }
  }

  // Wait for the first form step to render (or a sign-in wall / error).
  // Wait for the first form step — OR for the sign-in wall, which is what a
  // signed-out Workday actually paints.
  //
  // Measured on a live Jabil requisition: this call burned its FULL 20 seconds
  // and the sign-in detection immediately below then found the wall instantly.
  // The wait simply did not list the wall's own controls, so on every
  // signed-out tenant it waited out the whole budget for a form that was never
  // going to appear before authentication. Workday is 936 deck postings — the
  // most expensive single wait in the engine.
  //
  // The selector list is shared with that detection rather than restated;
  // stated twice they would drift, which is this codebase's signature defect.
  //
  // `:visible` on every branch for the F-81 reason: waitForSelector resolves a
  // selector LIST to the first match in DOM order and then waits for THAT
  // element, so one hidden node early in the DOM can hold the whole wait open.
  await time('wd:start-firstpaint', () => page.waitForSelector(
    `[data-automation-id^="formField-"]:visible, [data-automation-id="errorMessage"]:visible,`
    + ` [data-automation-id="createAccountCheckbox"]:visible, ${SIGNIN_VISIBLE_SELECTORS}`,
    { timeout: 20000 }).catch(() => {}));
  // Cookie banner + Apply modal + first step painting. Measured by hand rather
  // than wrapped because the block above returns early on a dead requisition.
  recordMs('wd:start', performance.now() - tStart);
  // Detect a sign-in wall by CONTENT, not just URL — a signed-out Workday shows
  // a "Create Account / Sign In" step ON the apply URL.
  // ASML's progress bar renders "current step 1 of 8" with NO step name, so the
  // step text alone cannot detect the wall. The sign-in step's own controls are
  // the reliable signal.
  const needsAuth = await page.evaluate((sel) => {
    const step = (document.querySelector('[data-automation-id="progressBarActiveStep"]') || {}).textContent || '';
    return /sign in|create account/i.test(step) || !!document.querySelector(sel);
  }, SIGNIN_SELECTORS).catch(() => false);
  if (needsAuth || /signin|login|register/i.test(page.url())) {
    const signedIn = await time('wd:signin', () => signInWithGoogle(page, profile, result));
    if (!signedIn) return result;
  }

  // 2. Walk the multi-step flow, filling + Save-and-Continue, until Review.
  // ASML runs 8 steps; leave headroom above the longest tenant seen.
  const MAX_STEPS = 12;
  let lastStep = '';
  for (let i = 0; i < MAX_STEPS; i++) {
    // `:visible` on every branch, same reason as the call above.
    await page.waitForSelector('[data-automation-id^="formField-"]:visible, input[type=file]:visible, [data-automation-id="reviewPanel"]:visible', { timeout: 15000 }).catch(() => {});
    const step = (await currentStep(page)).toLowerCase();
    lastStep = step;


    if (/review/.test(step)) {
      result.filled.push({ label: 'Reached Review', value: 'stopped — your call to submit' });
      await time('wd:review-audit', () => auditReview(page, profile, result));
      break;
    }

    if (/experience/.test(step)) {
      // My Experience is handled entirely by its own filler. The generic
      // enumerator must NOT run here: it would walk the nested entry
      // sub-forms and resolve their labels against the identity block —
      // overwriting a job's "Austin, Texas" with the home address, for one.
      await time('wd:resume', () => tryResume(page, profile, result));
      await time('wd:experience', () => fillMyExperience(page, profile, result));
    } else {
      await fillCurrentPage(page, profile, result);
    }

    // Debug halt, AFTER this step is filled but before it is saved away. Some
    // Workday widgets can only be understood while live on screen and the step is
    // gone within seconds of a normal run. JARVIS_PAUSE_AT=experience stops here
    // with the sub-forms rendered and inspectable.
    if (process.env.JARVIS_PAUSE_AT && step.includes(process.env.JARVIS_PAUSE_AT.toLowerCase())) {
      result.needsInput.push({
        label: 'Paused for inspection',
        why: `JARVIS_PAUSE_AT matched "${step}" — stopped here deliberately, nothing saved`,
      });
      return result;
    }

    const advanced = await time('wd:save', () => clickSaveAndContinue(page));
    if (!advanced) break;

    // Detect an inline validation stop (page didn't change step). This must hold
    // on the FIRST iteration too: with `i > 0` the loop fell through and filled
    // the very same page a second time, which double-reported every field and
    // buried the real cause under the duplicates.
    const after = (await currentStep(page)).toLowerCase();
    if (after === step) {
      const blocking = await page.evaluate(() => [...document.querySelectorAll('[data-automation-id*="rror"]')]
        .map(e => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean).slice(0, 3).join(' | ')).catch(() => '');
      result.needsInput.push({
        label: step || 'This page',
        why: blocking
          ? `Workday rejected the page: ${blocking.slice(0, 200)}`
          : 'a required field is unfilled — complete it, then continue manually',
      });
      break;
    }
  }

  // A run that filled nothing and flagged nothing is indistinguishable from a
  // run that had nothing to do. Say so rather than reporting a clean zero.
  if (!result.filled.length && !result.needsInput.length && !result.resumeUploaded) {
    result.needsInput.push({
      label: 'Nothing was filled',
      why: `No recognised form fields on step "${lastStep || 'unknown'}" — the flow did not render as expected; complete this one by hand`,
    });
  }
  return result;
}
