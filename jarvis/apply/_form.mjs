// jarvis/apply/_form.mjs — the shared, ATS-generic form-filling core.
//
// Works on any application form that renders labeled controls in the DOM
// (Greenhouse, Lever, and Ashby all qualify). Strategy: enumerate every form
// control WITH its label straight from the DOM (structured, not visual), then
// resolve each label through the shared answer table and fill deterministically.
// Per-ATS adapters (greenhouse.mjs, lever.mjs, ashby.mjs) are thin wrappers
// that navigate to the form first, then call fill().
//
// Hard rules enforced here:
//   - NEVER interact with any submit control.
//   - NEVER press Enter inside a form input (it can submit the form).
//   - NEVER check a checkbox (they're almost always certifications/consents).
//   - Unknown questions are left blank and reported, not guessed.
//   - Every text fill is read back; values that didn't stick are flagged.

import { resolveLabel as resolveLabelRaw, yesNo } from './_answers.mjs';

/**
 * resolveLabel, with alternatives collapsed to something typable.
 *
 * A rule may answer with SEVERAL truthful values for a question whose shape
 * differs between forms — "How did you hear about us?" is free text on some and
 * a fixed list on others, and his profile holds an answer for each. The planner
 * picks whichever the form offers.
 *
 * This engine calls resolveLabel at eight sites and does not always have the
 * option list to hand, so it takes the first alternative unless options are
 * supplied. Without this wrapper `String(r.value)` on an array produced
 * "LinkedIn,Job Board or Social Media" — both answers joined by a comma and
 * typed into the form as one string. I introduced that while fixing F-263 and
 * caught it by checking the other engine, which is the whole point of having
 * checked it four times before.
 */
export function resolveLabel(label, profile, options = null) {
  const r = resolveLabelRaw(label, profile);
  if (r.kind !== 'answer' || !Array.isArray(r.value)) return r;
  const alts = r.value.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim());
  if (!alts.length) return { kind: 'unknown', why: 'your profile leaves this blank' };
  const list = Array.isArray(options) ? options : [];
  const offered = list.length ? alts.find((a) => chooseOption(a, list) >= 0) : null;
  return { ...r, value: offered || alts[0] };
}
import { time } from './_timing.mjs';

/** Press Escape if this target has a keyboard. fill() also runs against an iframe
 *  Frame — iCIMS and friends embed the entire application — and a Frame has no
 *  .keyboard, so the combobox path threw on every embedded form. */
async function pressEscape(target) {
  if (target && target.keyboard) await target.keyboard.press('Escape').catch(() => {});
}

/**
 * What an "Apply" control says, across the long tail. SmartRecruiters writes
 * "I'm interested", Oracle and SuccessFactors "Apply Now", others "Start your
 * application". Anchored at both ends so a link reading "Apply for other jobs
 * at this company" is not mistaken for one.
 *
 * Shared for the same reason as APPLY_PATH_RE below: apply.mjs waits for this
 * control before looking for its href, generic.mjs waits for it before clicking
 * it, and two copies would drift.
 */
export const APPLY_TEXT_RE = /^\s*(apply|apply now|apply here|apply to this job|apply for this job|i'?m interested|submit application|start (your )?application|continue to application)\s*$/i;

/**
 * Does this URL path look like an application form rather than a job posting?
 *
 * Lives here because BOTH callers need the same answer and they cannot import
 * each other: apply.mjs uses it to decide whether a same-host Apply link is
 * worth following, generic.mjs to decide whether it is already ON the form and
 * should stop hunting for an Apply button. Stated twice, these would drift —
 * which is F-14, F-74 and F-77, three times running in this codebase.
 */
export const APPLY_PATH_RE = /(^|\/)(apply|application|applications|applicant|apply-now)(\/|$)|\/talentcommunity\/apply\//i;

/**
 * What is standing between us and the application form?
 *
 * Three different things all used to surface as the same sentence — "no
 * recognisable form fields on this page" — and they need three different
 * actions from him:
 *
 *   sign-in    Amazon's Apply link lands on passport.amazon.jobs unless the
 *              browser already holds a session. Measured live.
 *   human      iCIMS shows "Let's confirm you are human" to an automated
 *              browser. Joby's 42 postings are all behind it.
 *   gone       SmartRecruiters answers a pulled posting with "Oops, you've gone
 *              too far!" — the posting is dead, not the form broken.
 *
 * Naming the blocker matters beyond the wording. A sign-in page has an email
 * box, so the filler happily "filled 1 field" and the run was recorded as a
 * prepared application with `filled: 1`. That is the F-44 defect exactly:
 * ready has to mean ready. Returning early keeps `filled` at zero so Review &
 * Send does not offer him an empty login page as work waiting to be finished.
 *
 * Lives here rather than in generic.mjs because EVERY adapter needs it. A dead
 * Ashby posting reported "filled 0 field(s)" and nothing else — the four proven
 * drivers call fill() directly and never had this check, so silence was the
 * whole report. Silence is the worst answer available: it looks identical to a
 * form that simply had nothing to fill.
 */
/**
 * How an ATS says a requisition is gone, in the wordings they actually use.
 *
 * Exported so it can be tested against real strings without a browser — it lives
 * inside a page.evaluate, where a wrong pattern is invisible until a live run.
 * Written originally for "page not found", it missed Ashby's OTHER wording: a
 * live 1X Technologies req answers "Job not found". That dead posting was
 * reported as "nothing resolved to a field" and never marked gone, so it stayed
 * in his deck to be queued again. F-53's lesson for the fifth time — the matcher
 * is literal, so every wording goes in beside the rule.
 */
// The "isn't available" branch was added after a live Amazon posting — one of
// three sitting in his QUEUE — answered HTTP 404 with "Sorry, the job you're
// looking for isn't available." None of the other branches match that wording,
// so a dead job looked to the engine like a page with no form on it.
//
// Anchored to a job word within a short distance, so a real form saying "if
// this option isn't available" is not mistaken for a dead posting.
// THE RESUME SLOT, told apart from every other upload — shared, because the
// two engines had different answers. The Playwright driver used to decide
// with `/resume|cv/` plus "if there is exactly one file input it IS the
// resume", which put his resume into a lone TRANSCRIPT, COVER LETTER or
// PORTFOLIO upload. The planner already refused those. See F-255.
/** A resume file input, told apart from every other upload on the page. */
export const RESUME_FIELD_RE = /resume|cv\b|curriculum\s*vitae|attach.*(resume|cv)/i;

/** Uploads that are emphatically NOT the resume, however they are labelled. */
// "easy apply", "autocomplete", "autofill", "prefill": a slot that parses a
// file to fill the form for the applicant is not the resume slot (F-352).
/**
 * A slot that PARSES a resume to prefill the form (SmartRecruiters' "Easy
 * Apply", Workday's "Autofill with Resume") — not the slot the application
 * keeps the resume in. The resume goes in its own slot (F-352); this one is
 * left alone on purpose, and said so (F-359).
 */
export const PARSE_SLOT_RE = /easy apply|autocomplete|auto-?fill|prefill|apply with (?:a |your )?(?:resume|cv)/i;

export const NOT_RESUME_RE = /cover.?letter|portfolio|transcript|writing.?sample|certificat|reference|photo|passport|visa|licen[cs]e|easy apply|autocomplete|auto-?fill|prefill/i;

/**
 * Is this file input the resume slot?
 *
 * Greenhouse labels BOTH its resume and its cover-letter inputs "Attach", and
 * tells them apart only by `id` — `resume` and `cover_letter`. Matching on the
 * label alone left both unanswered (8 of 54 unknowns in a six-form sweep), and
 * loosening the label pattern to accept "Attach" would have put his resume in
 * the cover-letter slot, which is worse than leaving it out.
 *
 * So the identifier is checked FIRST and it is decisive in both directions.
 */
export function isResumeField(field) {
  const ident = `${field?.id || ''} ${field?.name || ''} ${field?.key || ''}`;
  const label = String(field?.label || '');
  if (NOT_RESUME_RE.test(ident)) return false;
  if (RESUME_FIELD_RE.test(ident)) return true;
  if (NOT_RESUME_RE.test(label)) return false;
  return RESUME_FIELD_RE.test(label) || !label.trim();
}

/** A slot that wants the cover letter as a file. */
export const COVER_LETTER_FIELD_RE = /cover.?letter|covering.?letter|letter.?of.?(?:interest|motivation)|motivation.?letter/i;

/**
 * Is this file input the COVER LETTER slot? (F-410)
 *
 * The same discipline as the resume, and for the same reason: Greenhouse
 * labels both inputs "Attach" and tells them apart by `id` alone
 * (`resume` / `cover_letter`). The identifier decides first, and an unlabelled
 * slot is never assumed to be this one — a letter in the resume slot is worse
 * than no letter.
 */
export function isCoverLetterField(field) {
  const ident = `${field?.id || ''} ${field?.name || ''} ${field?.key || ''}`;
  const label = String(field?.label || '');
  if (COVER_LETTER_FIELD_RE.test(ident)) return true;
  if (RESUME_FIELD_RE.test(ident)) return false;
  return COVER_LETTER_FIELD_RE.test(label);
}

export const DEAD_POSTING_RE = /oops|gone too far|no longer (available|accepting|active|posted|open)|has been (filled|closed|removed)|position (closed|filled)|(job|position|posting|role|opening|vacancy)[^.]{0,40}(isn.?t|is not)\s+available|(page|job|position|posting|requisition|opening|vacancy)\s+(you\s+requested\s+)?(was|is|has been)?\s*(not found|closed|filled|removed|expired|unavailable)|(page|job|position|posting|requisition|opening|vacancy)[^.]{0,40}(does\s?n.?t|does not)\s+exist/i;

export async function pageBlocker(page) {
  return await page.evaluate((deadSrc) => {
    const DEAD = new RegExp(deadSrc, 'i');
    const text = (document.body.innerText || '').slice(0, 4000);
    const vis = (e) => e && e.getClientRects().length > 0;
    if (DEAD.test(text.slice(0, 600)))
      return { kind: 'gone', why: 'this posting is no longer live — the ATS says so on the page; nothing to fill' };
    if (/confirm you are human|security check|are not a bot|verify you are human/i.test(text))
      return { kind: 'human', why: 'this ATS is showing a human-verification check — clear it yourself in this tab, then re-run' };
    // The site refused the browser outright. Tesla answers repeated automated
    // visits with an Akamai "Access Denied" page, and reporting that as "no
    // recognisable form fields" sends him looking for a broken form when the
    // real answer is to wait or open it himself. Anchored on the phrases those
    // pages actually use, so a job description mentioning access control does
    // not match.
    if (/access denied|don.?t have permission to access|unusual traffic|rate.?limit(ed)?\b|request blocked|403 forbidden/i.test(text.slice(0, 800)))
      return { kind: 'blocked', why: 'this site refused the browser (an Access Denied page, not a form) — it rate-limits automated visits; wait a few minutes and re-run, or open the posting yourself in this tab' };
    const pw = [...document.querySelectorAll('input[type=password]')].some(vis);
    const authHost = /^(passport|login|signin|sign-in|auth|accounts|idp)\./i.test(location.hostname);
    if ((pw || authHost) && /sign in|log in|create (an )?account|password/i.test(text))
      return { kind: 'signin', why: 'this ATS wants you signed in before it shows the form — sign in in this tab, then re-run' };
    return null;
  }, DEAD_POSTING_RE.source).catch(() => null);
}

/**
 * Did following an Apply link land us back on the site's own front page?
 *
 * careers.agcocorp.com answers a direct GET of its own
 * /talentcommunity/apply/<id>/ link with a redirect to the site root — its
 * apply flow is a dropdown that wants an account, not a link. The engine then
 * filled the home page's talent-community "Enter E-mail Address" box and
 * reported it as a filled application field: a hop that bounces reads as
 * success, which is worse than not hopping at all.
 *
 * Landing on a DIFFERENT host is not a bounce — that is how amazon.jobs hands
 * off to passport.amazon.jobs, and the sign-in diagnosis depends on being
 * there. Shared because both hops navigate: apply.mjs's, and generic.mjs's own.
 */
export function bouncedToRoot(fromUrl, toUrl) {
  try {
    const to = new URL(toUrl);
    const from = new URL(fromUrl);
    return to.hostname === from.hostname
      && !APPLY_PATH_RE.test(to.pathname)
      && to.pathname.replace(/\/+$/, '') === '';
  } catch { return false; }
}

/**
 * Is this control part of the SITE, or part of the APPLICATION?
 *
 * A job-board page and an application form both contain text inputs, so a count
 * of controls cannot tell them apart. That is what made the engine fill
 * amazon.jobs' search box and then report "no recognisable form fields" on a
 * posting whose form it had never reached: the board page carries ten visible
 * controls, `generic.mjs` read that as "this page already has a form", and the
 * branch that follows the Apply link never ran.
 *
 * Measured on the live page, all ten of those controls — INCLUDING `city` and
 * `country`, which are perfectly ordinary names on a real application form —
 * sit inside NAV.navbar > FORM.search-form > DIV#search-container. So the test
 * has to be STRUCTURAL: where the control lives, not what it is called. A name
 * blocklist would have skipped the real City field on a real form, which is the
 * expensive error — a silently unfilled field looks exactly like a filled one.
 *
 * Kept as one source string used by both callers (the enumerator here and the
 * gate in generic.mjs). This codebase's signature defect is one question
 * answered in two places that then drift — F-14, F-74, F-77 — and a second copy
 * of this predicate would be the fourth instance.
 */
export const SITE_FURNITURE_SRC = `(el) => {
  // Two tiers, because one rule could not be both safe and sufficient.
  //
  // TIER 1 — unambiguous furniture, matched as a plain substring. These words
  // never name a field on a real application. The separator-anchored version
  // of this rule missed AGCO's job-alert widget, whose container is
  // "div#savesearch" — no separator before "search" — so the engine filled its
  // "Enter E-mail Address" box and reported it as a filled application field.
  // camelCase forms are written out beside the hyphenated ones. The rule is
  // case-INsensitive, so "search-container" does not match Micron's
  // "searchContainer-185iD" - the capital is gone by the time it is tested
  // and there is no separator to anchor on. That is F-53 again: the matcher
  // is literal, so every form a name takes goes in beside it.
  const FURNITURE_ANY = /savesearch|save-search|jobalert|job-alert|jobsearch|job-search|searchbox|searchform|searchbar|searchinput|searchwrapper|searchcontainer|searchresults|search-form|search-container|search-field|search-?typeahead|typeahead-?search|search-?autocomplete|autocomplete-?search|jobs?-?autocomplete|autocomplete-?jobs?|talentcommunity|talent-community|subscribe|newsletter|cookie|consent-|-consent|masthead|skiplink|skip-link/i;
  // TIER 2 — words that DO appear inside real forms, so they must sit alone as
  // a token. "search" anchored this way will not match a react-select's
  // "select__search" input, which is a genuine control on many application
  // forms; "chat" will not match "chatham".
  const FURNITURE_TOKEN = /(^|[-_ ])(search|alert|alerts|chat)([-_ ]|$)/i;
  const named = (n) => {
    const id = n.id || '';
    const cls = (n.getAttribute && typeof n.getAttribute('class') === 'string')
      ? n.getAttribute('class') : '';
    return FURNITURE_ANY.test(id) || FURNITURE_ANY.test(cls)
      || FURNITURE_TOKEN.test(id) || FURNITURE_TOKEN.test(cls);
  };

  // 1. Site chrome always wins, and is checked before anything else.
  let form = null;
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const tag = n.tagName;
    // An application form is never inside the site chrome.
    if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER') return true;
    if (n.getAttribute && n.getAttribute('role') === 'search') return true;
    // A web component's form is a form: SmartRecruiters' <spl-form> (F-337).
    if (tag === 'FORM' || /-FORM$/.test(tag)) { form = n; break; }
  }

  // 2. THE FORM BOUNDARY. If the nearest enclosing <form> is a real one, the
  //    control belongs to the application and no name on it can overrule that.
  //
  //    Without this, a react-select's own "select__search" input — a genuine
  //    control on Greenhouse and Ashby forms — matched the "search" token and
  //    was skipped. Skipping a real field is the expensive direction of this
  //    rule: an unfilled field looks exactly like a filled one in the report.
  if (form) return named(form);

  // 3. No enclosing form at all, so judge by the names on the chain. This is
  //    where AGCO's job-alert widget lands — div#savesearch, sitting in a bare
  //    div with no form around it.
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (named(n)) return true;
  }
  return false;
}`;

/**
 * How many controls on this page belong to an actual application?
 *
 * The number `generic.mjs` gates on. Counting every control answered the wrong
 * question; this counts the ones that are not site furniture.
 */
export async function countApplicationFields(target) {
  return await target.evaluate((src) => {
    const isFurniture = new Function('return ' + src)();
    return [...document.querySelectorAll('input,select,textarea')]
      .filter(e => e.type !== 'hidden' && e.getClientRects().length > 0)
      .filter(e => !isFurniture(e)).length;
  }, SITE_FURNITURE_SRC).catch(() => 0);
}

/**
 * Turn a control's `name` into the question it is asking.
 *
 * A radio group whose fieldset carries no legend has no label of its own, so the
 * enumerator falls back to walking the DOM and comes back with one of the
 * OPTIONS. On OpenAI's Ashby application the gender group was labelled "Male",
 * which resolves to nothing, so all four self-identification questions were
 * handed back to him — on a form where his standing instruction is that they get
 * answered.
 *
 * The name is unambiguous where the label is not:
 *
 *   ebb0dc98-4126-42b2-9d3c-98c402a941ba__systemfield_eeoc_gender  ->  eeoc gender
 *
 * and `eeoc gender`, `eeoc race`, `eeoc veteran` and `eeoc disability` all
 * resolve correctly through the ordinary answer table. Verified against that
 * live form.
 */
function questionFromName(name) {
  return String(name || '')
    // Ashby prefixes the requisition's uuid; Workday and Greenhouse use their own.
    .replace(/^[0-9a-f]{8}[0-9a-f-]*_{1,2}/i, '')
    .replace(/\b(systemfield|customfield|question|field)s?[_-]/gi, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tick a checkbox or radio, escalating the way the combobox path already does.
 * Throws if the box does not end up checked, so the callers' existing reporting
 * still applies.
 *
 * A bare `.check()` carries Playwright's THIRTY-SECOND default timeout. On the
 * live Texas Instruments form the single "I agree with the terms and
 * conditions" box sits behind a styled wrapper, fails Playwright's hit-target
 * test, and burned all thirty of those seconds — 30s of a 69s application, for
 * one checkbox.
 *
 * It then reported "could not check", which for a consent box is the wrong
 * outcome twice over: his standing instruction is that every consent and
 * AI-screening box gets ticked, and an unticked consent box is the one thing
 * that silently invalidates an otherwise complete application.
 *
 * Whether the box ended up checked is READ BACK, never assumed.
 */
async function tick(loc) {
  // EVERY call here carries an explicit timeout, including the ones that look
  // incidental. Playwright's default is thirty seconds on all of them —
  // isChecked, scrollIntoViewIfNeeded and evaluate included — and a control
  // that is never actionable pays each default in turn.
  //
  // Measured on a live Lam Research (Eightfold) form: the single "Contact
  // Consent — I consent to…" checkbox took **128 seconds**. Bounding the two
  // check() calls, as the first version of this helper did, fixed 30 of those
  // and left the other three defaults untouched, which is why the form still
  // took 2m38s after that change appeared to be the fix.
  const T = { timeout: 2000 };
  if (await loc.isChecked(T).catch(() => false)) return true;
  if (await loc.check({ timeout: 3000 }).then(() => true).catch(() => false)) return true;
  await loc.scrollIntoViewIfNeeded(T).catch(() => {});
  // force:true is a real trusted click that skips the hit-target test — the
  // same step that fixed the Eightfold comboboxes further down this file.
  if (await loc.check({ force: true, timeout: 2500 }).then(() => true).catch(() => false)) return true;
  // A styled checkbox hides the real input and listens on its <label>.
  await loc.evaluate((el) => {
    const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    (lab || el.closest('label') || el).click();
  }, undefined, T).catch(() => {});
  if (await loc.isChecked(T).catch(() => false)) return true;
  throw new Error('the box would not tick');
}

/** Tag every fillable control with data-jarvis-i and return its metadata. */
async function enumerateFields(page) {
  return await page.evaluate((furnitureSrc) => {
    const isFurniture = new Function('return ' + furnitureSrc)();
    const out = [];
    const seen = new Set();
    const controls = document.querySelectorAll('input, textarea, select');
    let i = 0;
    for (const el of controls) {
      // The site's own search box, job-alert signup and chat widget are not
      // part of the application. Filling them is wrong, and reporting them as
      // "no answer in apply-profile.yml" buried the real outstanding fields.
      if (isFurniture(el)) continue;
      // A honeypot is a bot trap: a real applicant never sees it, so anything
      // typed into it marks the application as automated. Texas Instruments
      // ships one named exactly `honeypot` on its /apply/email step, and the
      // engine was listing it as a field awaiting his answer. Never fill it,
      // never report it.
      // Spelled out in every form the field actually takes: TI ships `honey-pot`
      // with id `honey-pot-1`, and a rule written only for `honeypot` matched
      // neither. That is F-53's lesson — the matcher is literal — costing a
      // fourth repeat.
      if (/honey[-_ ]?pot|^(bot-?field|_gotcha)$/i.test(`${el.name || ''} ${el.id || ''}`)) continue;
      const type = (el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      // `readonly` is NOT a valid attribute on radios or checkboxes — the HTML
      // spec says it does not apply to them — but Eightfold sets it anyway. All
      // 55 radios on a live Applied Materials form carried readOnly, so this
      // line skipped every one of them: 12 answerable questions (work
      // authorisation, sponsorship, graduation year, relocation) never even
      // reached the filler. It is honoured for text inputs, where it means
      // something.
      if (el.disabled) continue;
      if (el.readOnly && type !== 'radio' && type !== 'checkbox') continue;
      // VISIBLE elements only. Hidden duplicates (e.g. a collapsed "Quick
      // Apply" widget) otherwise win the dedup and the real fields stay empty.
      // File inputs are exempt: ATSes routinely hide them behind styled
      // "Attach" buttons, and setInputFiles works on hidden inputs.
      if (type !== 'file') {
        const style = window.getComputedStyle(el);
        const visible = el.offsetParent !== null && style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
        if (!visible) continue;
      }
      // label: for= → aria-labelledby → aria-label → closest <label> → nearest label-ish sibling
      let label = '';
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) label = l.textContent;
      }
      if (!label) {
        const lb = el.getAttribute('aria-labelledby');
        if (lb) label = lb.split(/\s+/).map(x => document.getElementById(x)?.textContent || '').join(' ');
      }
      if (!label) label = el.getAttribute('aria-label') || '';
      if (!label) label = el.closest('label')?.textContent || '';
      if (!label) {
        const wrap = el.closest('div');
        const l = wrap?.querySelector('label, .label, [class*="label"]');
        if (l) label = l.textContent;
      }
      label = (label || '').replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
      // A <select>'s wrapper text contains every option, so the label fallback can
      // swallow the whole list — Lever's Race field read as "RaceSelect ...Hispanic
      // or LatinoWhite (Not Hispanic or Latino)…". That matched the Hispanic rule
      // instead of the Race rule and answered the race question "Decline to
      // self-identify". Strip the option texts back out.
      if (el.tagName === 'SELECT') {
        // Longest first: stripping "Hispanic or Latino" before the longer
        // "White (Not Hispanic or Latino)" would gut the longer option and leave
        // "(Not )" fragments behind.
        const opts = [...el.options]
          .map(o => (o.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(ot => ot.length > 2)
          .sort((a, b) => b.length - a.length);
        for (const ot of opts) if (label.includes(ot)) label = label.split(ot).join(' ');
        label = label.replace(/\s+/g, ' ').replace(/[*✱:]\s*$/, '').trim();
      }
      if (!label && type === 'file') label = 'Resume/CV';
      // Radios/checkboxes carry their OPTION text as label ("Male", "Yes, I
      // can…"); the question lives on the group. Prefix the group label so
      // answer rules see the actual question.
      if (type === 'radio' || type === 'checkbox') {
        let group = el.closest('fieldset')?.querySelector('legend')?.textContent
          || (() => { const g = el.closest('[role="radiogroup"]'); if (!g) return '';
               const lb = g.getAttribute('aria-labelledby');
               return lb ? (document.getElementById(lb)?.textContent || '') : (g.getAttribute('aria-label') || ''); })();
        // NEITHER of those exists on an Eightfold application, and without the
        // question the label is just the option text — "Yes". No answer rule can
        // match "Yes", so all twelve radio groups on a live Applied Materials
        // form went unanswered, including "Are you legally authorized to work in
        // the United States?" and "Will you require sponsorship?".
        //
        // So walk up for the question. Take the first ancestor carrying text
        // that is NOT just this group's own option labels: the options are
        // siblings, the question sits above them.
        // Also run this when the group label is a SECTION heading rather than a
        // question. Applied Materials wraps all twelve questions in one
        // role="radiogroup" labelled "Position Specific Questions", so every
        // group got that same useless label and none could be answered.
        const generic = /^(position specific|application|additional|screening|voluntary)?\s*questions?$/i;
        const gtxt = String(group || '').replace(/\s+/g, ' ').trim();
        if (!gtxt || generic.test(gtxt)) {
          const own = new Set([...(el.name
            ? document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`) : [el])]
            .map((r) => {
              const l = r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
              return ((l ? l.textContent : r.value) || '').replace(/\s+/g, ' ').trim().toLowerCase();
            }).filter(Boolean));
          let node = el.parentElement, hops = 0;
          while (node && hops++ < 6) {
            // The question sits directly ABOVE its options. Searching
            // descendants found the SECTION heading ("Position Specific
            // Questions") first and labelled all twelve groups identically;
            // searching direct children found the option rows. Look at the
            // preceding siblings of each ancestor instead — that is where the
            // question text actually lives.
            let cand = '';
            for (let sib = node.previousElementSibling; sib && !cand; sib = sib.previousElementSibling) {
              const t = (sib.textContent || '').replace(/\s+/g, ' ').trim();
              if (t.length > 12 && t.length < 400 && !own.has(t.toLowerCase())
                  && !/^(position specific|application) questions$/i.test(t)) cand = t;
            }
            if (cand) { group = cand; break; }
            node = node.parentElement;
          }
        }
        const gt = (group || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (gt && !label.includes(gt)) label = `${gt} — ${label}`;
      }
      const key = label + '|' + type;
      if (label && seen.has(key) && type !== 'radio') continue;
      seen.add(key);
      el.setAttribute('data-jarvis-i', String(i));
      out.push({
        i,
        label,
        name: el.getAttribute('name') || '',
        // Radios in one group share a name and differ only by value. Without
        // this the multi-pass de-duplication key collapsed every option in a
        // group to a single entry, so a group could never be matched against
        // its options.
        value: el.getAttribute('value') || '',
        tag: el.tagName.toLowerCase(),
        type,
        role: el.getAttribute('role') || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).map(o => o.textContent.trim()).filter(Boolean)
          : null,
      });
      i++;
    }
    return out;
  }, SITE_FURNITURE_SRC);
}

// Postal code → spelled-out state, for location dropdowns that write the long
// form while every posting and profile writes the short one.
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
  PR: 'Puerto Rico',
};

/** Normalize for comparison: lowercase, punctuation → space ("Self-Identify" ≡ "Self Identify"). */
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Does `option` text express `answer`? Word-boundary safe ("Male" ≠ "Female",
 *  "No" ≠ "North America", years "1" ≠ "10+ years"). */
function optionMatches(answer, option) {
  const a = norm(answer), o = norm(option);
  if (!a || !o) return false;
  if (o === a) return true;
  // whole-phrase containment on normalized text, anchored at word boundaries
  if (new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(o)) return true;
  // prefix match only at a token boundary — the char after the prefix must not
  // continue the word ("no" must not match "north america", "1" not "10 years")
  const boundaryPrefix = (needle) => o.startsWith(needle) && !/[a-z0-9]/.test(o[needle.length] || '');
  if (boundaryPrefix(a)) return true;
  const yn = yesNo(answer);
  if (yn && boundaryPrefix(yn)) return true;
  // Numeric options ("0", "1", "2") vs a ranged answer ("1-2 years"): take the
  // answer's leading number.
  const am = a.match(/^(\d+)/);
  return !!(am && /^\d+$/.test(o) && o === am[1]);
}
export { optionMatches, norm };

/**
 * Choose which option expresses `want`, returning its index or -1.
 *
 * This is the one place that knows how differently ATSes word the same choice,
 * so every adapter benefits instead of each learning it separately:
 *   degree   "Bachelor of Science" → Workday "Bachelors of Arts or Science
 *            (Bachelors)" / Greenhouse "Bachelor's Degree"
 *   veteran  "I am not a Veteran." → "I am not a protected veteran"
 *   country  "United States of America" → "United States +1"
 *   consent  "Yes" → "Yes, I consent to the use of artificial intelligence"
 *
 * The polarity guard is the important one: a yes/no answer must never land on an
 * option of the opposite sense. A wrong answer that reports as filled is worse
 * than a blank field, and an opt-out consent selected for a "Yes" answer is the
 * exact failure this prevents.
 */
/**
 * The same states as US_STATES above, keyed BOTH WAYS on normalised text.
 *
 * Derived from that table rather than written out again — a second hand-typed
 * list of fifty states is a list that drifts. `norm` has already lowercased and
 * stripped punctuation, so the keys here are "washington" and "wa".
 */
const STATE_EITHER_WAY = (() => {
  const m = Object.create(null);
  for (const [abbr, full] of Object.entries(US_STATES)) {
    m[norm(abbr)] = norm(full);
    m[norm(full)] = norm(abbr);
  }
  return m;
})();

/**
 * The yes/no an answer EXPRESSES, when it expresses one: "Yes" and "No" as
 * yesNo reads them, plus a first-person statement read by its negation — "I
 * am not a Veteran." is a no, "I am a veteran" is a yes. null for anything
 * else. Used by the planner to see that a field already holding "No" is
 * already answered by a profile value that is a sentence.
 */
export function polarityOf(want) {
  const w = String(want == null ? '' : want);
  const yn = yesNo(w);
  if (yn) return yn;
  const nw = norm(w);
  if (!/^i (?:am|do|have|was|will|can|identify)\b/.test(nw)) return null;
  return /\b(not|never|no|don t|do not|haven t|have not)\b/.test(nw) ? 'no' : 'yes';
}

/**
 * A LANGUAGE-PROFICIENCY LADDER, rung by rung, whatever words a tenant uses.
 * Workday says Basic / Intermediate / Advanced / Fluent on one tenant and
 * Elementary / Limited working / Professional working / Full professional /
 * Native or bilingual on another; some number the rungs. The rung an option
 * sits on is what matters, not its spelling.
 */
/** Facts a polarity match must never assert on his behalf (see chooseOption 1c). */
const STATUS_CLAIM_ANY = /\bcitizen|naturaliz|permanent resident|green card|clearance|\bveteran\b/;

const PROFICIENCY_RUNGS = [
  [/\bnative\b|\bbilingual\b|mother tongue/, 9],
  [/\bfluent\b|full professional|\bexpert\b|\bmastery\b|\bc2\b/, 8],
  [/\badvanced\b|\bproficient\b|professional working|\bprofessional\b|\bc1\b/, 7],
  [/upper[\s-]?intermediate|\bb2\b/, 6],
  [/\bintermediate\b|\bconversational\b|limited working|\bb1\b/, 5],
  [/\bbasic\b|\bbeginner\b|\belementary\b|\bnovice\b|\ba[12]\b/, 3],
  // GENERIC RATING SCALES, WHOLE OPTION ONLY (F-551). "Low / Medium / High"
  // and "Poor / Fair / Good / Excellent" are proficiency ladders too, and the
  // top of them is what he asked for ("everything should be fluent"). Anchored
  // to the entire option so "High School" or "Good Standing" never reads as a
  // rung — and a ladder still needs two rungs before it decides anything.
  [/^(excellent|very high|outstanding)$/, 8],
  [/^(high|very good|strong)$/, 7],
  [/^(good|moderate|medium|average)$/, 5],
  [/^(fair|limited|low|some)$/, 3],
  [/^(poor|very low|none|no proficiency)$/, 1],
];
export function proficiencyRung(text) {
  const t = norm(text);
  if (!t) return null;
  for (const [re, rung] of PROFICIENCY_RUNGS) if (re.test(t)) return rung;
  // "5 - Fluent" style rungs carry their own number; a bare number is a rung
  // only when the list is numbered, which the caller checks.
  const n = t.match(/^(\d)\b/);
  return n ? Number(n[1]) : null;
}

export function chooseOption(want, options) {
  const texts = (options || []).map((t) => (t == null ? '' : String(t).trim()));
  // Drop a trailing dial code so "United States of America" can match
  // "United States of America (+1)". The old pattern required the code to be
  // the last characters on the line, so the PARENTHESISED form — which is how
  // every phone-code dropdown measured in this deck writes it — was never
  // stripped, and his country matched nothing.
  const clean = texts.map((t) => norm(t.replace(/\s*\(?\+\d{1,4}\)?\s*$/, '')));
  const w = String(want == null ? '' : want);
  const nw = norm(w);
  if (!nw) return -1;

  const find = (pred) => clean.findIndex((t, i) => texts[i] && pred(t));

  // 1. Yes/no answers are decided by polarity, first and last.
  const yn = yesNo(w);
  if (yn) {
    // "I will read the arbitration agreement below." and "I understand and
    // agree to the terms…" are the only options Anthropic offers under two
    // consent dropdowns (F-349): a first-person acknowledgement is a yes.
    const affirms = (t) => (/^yes\b/.test(t) || /^y$/.test(t) || /^true$/.test(t)
        || /\b(i )?(consent|agree|accept|authorize)\b/.test(t)
        || /\bi (will|have) read\b|\bi (understand|acknowledge|certify|confirm|attest)\b/.test(t))
      && !/opt[\s-]?out|\bdo not\b|\bdecline\b|\bnot consent\b|\bdisagree\b/.test(t);
    // DECLINING TO ANSWER IS NOT ANSWERING NO, and it is worded like a
    // negation, so it was being picked as one. Measured: answer "No" against
    // [I am authorized…, I am not authorized…, I do not wish to answer] chose
    // **"I do not wish to answer"** — the option containing "do not" — over the
    // one that says exactly what he means. A non-answer on a demographic
    // question is recoverable; on work authorisation it reads as evasion of the
    // only question the screen actually cares about.
    //
    // Bare "I decline" is still a genuine no on a consent question. Only the
    // "…to answer / to self-identify" forms are excluded.
    const NONANSWER = /wish to answer|prefer not to|decline to (self|state|answer|identify)|do not wish/;
    const denies = (t) => !NONANSWER.test(t)
      && (/^no\b/.test(t) || /^n$/.test(t) || /^false$/.test(t)
        || /opt[\s-]?out|\bdo not\b|\bdecline\b|\bnot consent\b/.test(t));
    // 1c. A CONSENT WORDED AS A SCOPE, not a yes/no. Lam's Eightfold form asks
    //     "I consent to make my profile visible for and receive communications
    //     … as follows:" and offers [Recruiters can contact me for ANY open
    //     position…, Recruiters can contact me for ONLY the roles I apply to].
    //     Neither says yes, both are un-negated, so "Yes" matched nothing and
    //     a required field went blank on every Lam application. His standing
    //     answers are yes to every consent and yes to the talent community
    //     ("more recruiter reach is a plus"), so "Yes" is the widest scope and
    //     "No" the narrowest. Only when EVERY option is a contact-scope
    //     statement — a menu of other things is never decided this way.
    let hit = -1;
    {
      const SCOPE = /\b(contact me|be contacted|receive (?:communications|emails|updates)|be considered|keep me informed)\b/;
      const live = texts.map((_, i) => i).filter((i) => texts[i] && !NONANSWER.test(clean[i]));
      if (live.length >= 2 && live.every((i) => SCOPE.test(clean[i]))) {
        const wide = live.filter((i) => /\b(any|all|every)\b/.test(clean[i]) && !/\bonly\b/.test(clean[i]));
        const narrow = live.filter((i) => /\bonly\b/.test(clean[i]));
        if (yn === 'yes' && wide.length === 1) hit = wide[0];
        else if (yn === 'no' && narrow.length === 1) hit = narrow[0];
      }
    }
    if (hit === -1) hit = find(yn === 'yes' ? affirms : denies);

    // A PROSE BINARY IS STILL A BINARY.
    //
    // Greenhouse and Lever routinely write a yes/no question as two statements
    // with no "yes" and no "no" in either of them:
    //
    //   [ ] I am authorized to work in the US for any employer
    //   [ ] I am not authorized to work in the US
    //
    // His answer is "Yes". Neither option starts with "yes", so this returned
    // -1 and the field was left blank — on WORK AUTHORISATION, the single most
    // consequential question on any form, and a blank one gets an application
    // binned without a human ever seeing it.
    //
    // The guard that makes this safe is demanding a genuine binary: exactly one
    // first-person claim negated, exactly one not. A list where two options are
    // un-negated is not a yes/no pair — it is a menu, and picking from a menu
    // by polarity is how "I am authorized" gets chosen for a SPONSORSHIP
    // question. Two candidates, one of each sign, or nothing happens.
    //
    // "I do not wish to answer" is excluded first: declining to answer is not
    // the same as answering no, and it is worded like a negation.
    if (hit === -1) {
      // A STATUS HE HAS NEVER CLAIMED IS NOT INFERRED FROM POLARITY.
      //
      // The path below turns "Yes" into whichever option is the un-negated
      // first-person claim. If a form asks something his profile DOES answer
      // ("Are you legally authorized to work in the US?" → Yes) and words its
      // options as a citizenship pair, that "Yes" would become **"I am a United
      // States citizen"** — a false statement about an F-1 student, generated
      // out of a true answer to a different question. Work authorisation and
      // citizenship are not the same fact, and his profile holds only one.
      //
      // Clearance is on the list for the reason it is on every skip list in
      // this repo: he cannot hold one, and a polarity match must never be the
      // thing that says otherwise.
      const STATUS_CLAIM = /\bcitizen|naturaliz|permanent resident|green card|clearance|\bveteran\b/;
      const isNeg = (t) => /\b(not|never|unable|cannot)\b/.test(t);
      const claims = texts.map((_, i) => i)
        .filter((i) => texts[i] && !NONANSWER.test(clean[i]) && /^i (am|do|have|will|can)\b/.test(clean[i]));
      const neg = claims.filter((i) => isNeg(clean[i]));
      const pos = claims.filter((i) => !isNeg(clean[i]));
      if (neg.length === 1 && pos.length === 1 && !STATUS_CLAIM.test(clean[pos[0]])) {
        hit = yn === 'yes' ? pos[0] : neg[0];
      }
    }
    // "X" AND "NOT X" (2026-09-24). Workday's Hispanic question offers
    // "Hispanic or Latino" / "Not Hispanic or Latino" — a yes/no in other
    // words, and "No" matched neither. Exactly one option that is another
    // option with "not" in front: yes is X, no is Not X.
    if (hit === -1) {
      const pairs = [];
      clean.forEach((t, i) => {
        if (!texts[i]) return;
        const m = t.match(/^not\s+(.+)$/);
        if (!m) return;
        const j = clean.findIndex((u, k) => k !== i && texts[k] && u === m[1]);
        if (j !== -1) pairs.push({ pos: j, neg: i });
      });
      if (pairs.length === 1 && !STATUS_CLAIM_ANY.test(clean[pairs[0].pos])) hit = yn === 'yes' ? pairs[0].pos : pairs[0].neg;
    }
    if (hit !== -1) return hit;
  }

  // 1d. THE TOP OF A PROFICIENCY LADDER (F-367). His instruction: the highest
  //     level offered, for every language he lists. A "Fluent" or
  //     "Native" answer against a ladder takes the highest rung the tenant
  //     offers, whatever it is called — so "Native or Bilingual" answers a
  //     [Basic, Intermediate, Advanced, Fluent] list with Fluent, and "Fluent"
  //     answers a list that goes up to "Native or bilingual" with that.
  //     Only a ladder decides this way: at least two options on rungs, and an
  //     answer that itself sits on the top two.
  {
    const wantRung = proficiencyRung(nw);
    if (wantRung != null && wantRung >= 8) {
      const rungs = clean.map((t, i) => (texts[i] ? proficiencyRung(t) : null));
      const onLadder = rungs.filter((r) => r != null).length;
      if (onLadder >= 2 || (onLadder === 1 && texts.filter(Boolean).length === 1)) {
        let top = -1;
        rungs.forEach((r, i) => { if (r != null && (top === -1 || r > rungs[top])) top = i; });
        if (top !== -1) return top;
      }
    }
  }

  // 2. Exact match FIRST, then the strict shared rule — and among loose
  //    matches, the SHORTEST option.
  //
  //    Taking the first containment hit filled a live Applied Materials form
  //    with "United States Minor Outlying Islands" for Country code, because
  //    that option contains the phrase "United States" and sorted ahead of the
  //    real one. A wrong answer is the worst outcome the engine can produce —
  //    worse than a blank, which at least announces itself — so an option that
  //    says exactly what he answered always wins, and a longer option is
  //    treated as carrying extra meaning he did not ask for.
  let idx = clean.findIndex((t, i) => texts[i] && t === nw);
  // 2b. "Open" and "No preference" are the same answer.
  //
  // Placed before the loose containment below on purpose: "Open" is a
  // token-boundary prefix of "Open Source Contributor", so a generic match
  // could carry it onto an unrelated option before the right one was ever
  // considered. An exact match still wins over both.
  //
  // His profile says `remote_or_onsite: Open`. Neuralink asks "Which onsite
  // location would you like to apply to?" and offers Austin | South San
  // Francisco | No preference — a question his answer covers exactly, reported
  // as unanswerable.
  //
  // Deliberately narrow: only when the whole answer is one of these words, so
  // "open to relocation" or a role called "Open Source Engineer" cannot reach
  // it, and only onto an option that says the same thing.
  if (idx === -1 && /^(open|any|either|flexible|no preference)$/i.test(nw)) {
    idx = find((t) => /^(no preference|any|any location|either|flexible|open|no strong preference)$/.test(t));
  }

  if (idx === -1) {
    const hits = [];
    for (let i = 0; i < texts.length; i++) if (texts[i] && optionMatches(w, texts[i])) hits.push(i);
    idx = hits.length ? hits.reduce((best, i) => (clean[i].length < clean[best].length ? i : best), hits[0]) : -1;
  }

  // 2c. THE COUNTRY, ABBREVIATED. Normalisation turns "U.S.A." into "u s a",
  //     and none of the short forms is a prefix of "united states of america"
  //     in either direction, so a list of [USA, UK, CAN] matched nothing at all
  //     and his country — a required field on every form — went blank.
  if (idx === -1 && /^united states( of america)?$/.test(nw)) {
    idx = find((t) => /^(usa|us|u s a|u s|america|united states|united states of america)$/.test(t));
  }

  // 2d. A SOURCE AND THE CATEGORY IT BELONGS TO.
  //
  //     "How did you hear about us?" is free text on some forms and a fixed
  //     list on others, and the fixed lists are usually CATEGORIES: [Job Board
  //     or Social Media, Employee Referral, University Event]. His answer
  //     "LinkedIn" is none of those words while being plainly one of those
  //     things, so the question came back unanswerable on every form that
  //     grouped its options.
  //
  //     Only widens a named source to a category that genuinely contains it —
  //     LinkedIn really is both a social network and a job board — and never
  //     the other way, so "Referral" can never be reached from a job board.
  //     Anchored whole-string, so a category cannot be reached by a stray word.
  if (idx === -1) {
    const CATEGORY = {
      linkedin: /^(job board|social media|job board or social media|social media or job board|online job board)$/,
      indeed: /^(job board|online job board|job board or social media)$/,
      glassdoor: /^(job board|online job board|job board or social media)$/,
      handshake: /^(university|college|school|campus|career center|university event|job board)$/,
    };
    const cat = CATEGORY[nw];
    if (cat) idx = find((t) => cat.test(t));
  }

  // 3. Reverse prefix: the OPTION is a token-boundary prefix of the answer.
  //    "United States" ⊂ "United States of America"; "Bachelor" ⊂ "Bachelor of
  //    Science". The forward direction is already covered by optionMatches.
  if (idx === -1) {
    idx = find((t) => t.length >= 4 && nw.startsWith(t) && !/[a-z0-9]/.test(nw[t.length] || ''));
  }

  // 4. Degree level — and never across levels: "Masters of Arts or Science"
  //    also contains the word "science" and would otherwise win a bachelor.
  if (idx === -1) {
    const levels = [
      // The option patterns run against NORMALISED text, where "B.S." is "b s",
      // so a list of [B.A., B.S., M.S.] matched no level at all and the whole
      // question came back unanswerable. Abbreviations are how plenty of forms
      // write these.
      [/\b(bachelor|bachelors|bs|ba|b\.s|b\.a|undergraduate)\b/i, /bachelor|undergraduate|\bb ?[as]\b/, /master|doctor|associate|high school/],
      [/\b(master|masters|ms|ma|m\.s|mba)\b/i, /master|\bm ?[as]\b|\bmba\b/, /bachelor|doctor|associate|high school/],
      [/\b(phd|ph\.d|doctor|doctorate)\b/i, /doctor|ph ?d/, /bachelor|master|associate|high school/],
      [/\bassociates?\b/i, /associate|\ba ?[as]\b/, /bachelor|master|doctor|high school/],
      [/high school/i, /high school/, null],
    ];
    const lvl = levels.find(([re]) => re.test(w));
    if (lvl) {
      const inLevel = [];
      clean.forEach((t, i) => {
        if (texts[i] && lvl[1].test(t) && !(lvl[2] && lvl[2].test(t))) inLevel.push(i);
      });

      // ARTS OR SCIENCE IS NOT A COIN TOSS. Measured: his answer "Bachelor's"
      // against a list of exactly [Bachelor of Arts, Bachelor of Science] took
      // the first match and put **Bachelor of Arts** on the form. cv.md says
      // "Bachelor of Science: Mechanical Engineering". That is a false claim
      // about his education, made silently, on a page a recruiter reads.
      //
      // A generic option claims the least and is always right when his answer
      // was generic, so it wins. If the form offers only specialised options
      // and his answer names no specialisation, there is nothing here to
      // choose FROM — so choose nothing, and let it be reported unanswered.
      // A blank announces itself; a wrong degree does not.
      /**
       * Every specialisation a piece of degree wording names.
       *
       * A SET rather than one value, because KLA's list offers "Bachelors of
       * Arts or Science (Bachelors)" — an option that names both and therefore
       * commits to neither. That is a generic bachelor's option wearing a long
       * name, and treating it as "Arts" refused a question it answers exactly.
       *
       * Normalised text has already turned "B.S." into "b s", so the space is
       * part of what the abbreviations have to match.
       */
      const specsIn = (t) => {
        const set = new Set();
        for (const m of t.matchAll(/\b(fine arts|arts|science|engineering|business|education)\b/g)) {
          set.add(m[1].replace('fine ', ''));
        }
        if (/\b(b|m)\.? ?a\b/.test(t)) set.add('arts');
        if (/\b(b|m)\.? ?s\b/.test(t)) set.add('science');
        return set;
      };

      // Naming none is generic; naming several is generic too.
      const generic = inLevel.filter((i) => specsIn(clean[i]).size !== 1);
      const wantSpecs = specsIn(nw);
      if (generic.length) {
        idx = generic.reduce((best, i) => (clean[i].length < clean[best].length ? i : best), generic[0]);
      } else if (wantSpecs.size === 1) {
        // Only an option naming the SAME specialisation. Being the sole
        // bachelor-level option on the list does not make "Bachelor of Arts"
        // true for a Bachelor of Science.
        const [only] = wantSpecs;
        const same = inLevel.filter((i) => specsIn(clean[i]).has(only));
        idx = same.length ? same[0] : -1;
      }
    }
  }

  // 4a-i. AN "ONLY" OPTION IS AN EXCLUSIVE CLAIM, and openness is not exclusive.
  //
  // Measured on a live Veeva form: "Are you willing to work in office or a
  // remote only role?" offers [Remote only, Office-based position]. His profile
  // says "Open to on-site, hybrid, or remote", which matched neither, so a
  // REQUIRED field went blank.
  //
  // "Remote only" is simply FALSE for him — it says he will not come in.
  // "Office-based position" is true, because he is willing to. So the exclusive
  // options are struck out, and the answer is taken only when exactly ONE
  // remains: two survivors means the form is asking him to choose between
  // things he is equally open to, and that choice is his.
  if (idx === -1 && /^(open|flexible|either|any|willing)\b|open\s+to\b/.test(nw)) {
    const inclusive = [];
    clean.forEach((t, i) => { if (texts[i] && !/\bonly\b/.test(t)) inclusive.push(i); });
    if (inclusive.length === 1) idx = inclusive[0];
  }

  // 4a. "NO" AGAINST A LIST OF THINGS THAT ARE NOT NO.
  //
  // Export-control and clearance questions offer statuses rather than yes/no —
  // [U.S. Citizen, Permanent Resident, Protected Individual, None of the above]
  // — and his answer is "No". Nothing matches, so a REQUIRED field is left
  // blank. "None of the above" is what "No" means on a list like that.
  //
  // Late on purpose: polarity (step 1) and an exact match (step 2) both run
  // first, so a list that really does contain "No" still picks it.
  if (idx === -1 && yn === 'no') {
    idx = find((t) => /^(none of the above|none|not applicable|n a|neither)\b/.test(t));
  }

  // 4b. US STATES, in whichever direction the form wants them.
  //
  // Measured against his real profile: `state: "Washington"` against a dropdown
  // offering [AL, AK, AZ, CA, WA, WY] matched nothing, so a required address
  // field on every form that abbreviates was left blank and reported. The
  // reverse happens too — a profile holding "WA" against a list of full names.
  //
  // Two-letter codes are matched EXACTLY and never by containment: "IN"
  // (Indiana), "OR" (Oregon), "OK", "ME", "HI" and "DE" are all ordinary
  // English words, and a loose match would put Indiana in an address because
  // the answer contained the word "in".
  if (idx === -1) {
    const other = STATE_EITHER_WAY[nw];
    if (other) idx = find((t) => t === other);
  }

  // 5. Veteran status: "not a veteran" ≡ "not a protected veteran".
  if (idx === -1 && /veteran/i.test(w)) {
    if (/\bnot\b/i.test(w)) idx = find((t) => /veteran/.test(t) && /\bnot\b/.test(t) && !/wish/.test(t));
    else if (/identify/i.test(w)) idx = find((t) => /identify/.test(t) && /veteran/.test(t));
  }

  // 5b. Declining to answer, however the form words it. Self-identification
  //     lists are where his configured answer and the option text almost never
  //     use the same verb: a live Applied Materials form offered "I DO NOT WISH
  //     TO SELF-IDENTIFY" against his "I decline to self-identify", and "I Don't
  //     Wish To Answer" against "I do not want to answer". Both were reported as
  //     unanswerable on a form where the right option was sitting in the list.
  const DECLINE = /decline|prefer not|do not wish|don t wish|dont wish|do not want|not want to answer|choose not|rather not|no answer|not disclose/i;
  if (idx === -1 && DECLINE.test(nw)) idx = find((t) => DECLINE.test(t));

  // 5c. "Company website" is how his profile words it; employers write their
  //     own name — "Applied Materials Corporate Website".
  if (idx === -1 && /\bwebsite\b/i.test(nw)) {
    idx = find((t) => /\bwebsite\b/.test(t) && !/job board|social media|staffing|agency|job fair/.test(t));
  }

  // 6. Phone dialling code.
  if (idx === -1) {
    const code = w.match(/\+\d+/);
    if (code) idx = texts.findIndex((t) => t.includes(code[0]));
  }

  // 7. "Mobile" ↔ "Cell/Cellular".
  if (idx === -1 && /mobile|cell/i.test(w)) idx = find((t) => /cell|mobile/.test(t));

  // 8. Gender identity lists say Man/Woman where the profile says Male/Female.
  if (idx === -1) {
    if (/^male$/i.test(w)) idx = find((t) => /^man$/.test(t));
    else if (/^female$/i.test(w)) idx = find((t) => /^woman$/.test(t));
  }

  // 9. "Austin, TX" ≡ "Austin, Texas, United States".
  //
  // Location dropdowns spell the state out; his profile and every posting
  // write the postal code. Found in a prepared Formic application, where
  // "Springfield, WA" failed against a list whose only entry was "Springfield,
  // Washington, United States" — so a field that was answerable landed in
  // "needs you before submitting" instead. The same miss applies to "Austin,
  // TX", which is one of his own preferred hubs.
  //
  // Both parts must match: the city AND the expanded state. Matching the city
  // alone would put a Portland, Oregon answer on Portland, Maine.
  if (idx === -1) {
    const m = /^\s*([^,]+),\s*([A-Za-z]{2})\s*$/.exec(w);
    const full = m && US_STATES[m[2].toUpperCase()];
    if (full) {
      const city = norm(m[1]);
      const state = norm(full);
      idx = find((t) => t.includes(city) && t.includes(state));
    }
  }

  // 10. Last guard: never return an option of the wrong polarity.
  if (idx !== -1 && yn) {
    const t = clean[idx];
    const affirms = /^yes\b|\b(i )?(consent|agree|accept)\b/.test(t) && !/opt[\s-]?out|\bdo not\b|\bdecline\b/.test(t);
    const denies = /^no\b|opt[\s-]?out|\bdo not\b|\bdecline\b/.test(t);
    if (yn === 'yes' ? denies : affirms) return -1;
  }
  // 1d. A FIRST-PERSON STATEMENT AGAINST A BARE YES/NO LIST.
  //
  //     His veteran answer is Workday's sentence, "I am not a Veteran." Lam's
  //     Eightfold form asks "Veteran" and offers [Choose not to disclose, No,
  //     Yes]. The sentence starts with neither word, so polarity never ran and
  //     the only "veteran" option to match by text did not exist: reported as
  //     "nothing matched" on every Lam application. A negated first-person
  //     claim IS "No", and an un-negated one IS "Yes" — but only when the list
  //     really is a bare yes/no and no option says the thing itself, so a menu
  //     of statuses is never collapsed to a polarity. Last resort on purpose.
  if (idx === -1 && /^i (?:am|do|have|was|will|can|identify)\b/.test(nw)) {
    const yesIdx = find((t) => /^yes$/.test(t));
    const noIdx = find((t) => /^no$/.test(t));
    if (yesIdx !== -1 && noIdx !== -1) {
      idx = /\b(not|never|no|don t|do not|haven t|have not)\b/.test(nw) ? noIdx : yesIdx;
    }
  }

  return idx;
}

// Exported so the plan the browser extension executes recognises a consent box
// by the SAME rule the Playwright driver does. Two definitions of "this is a
// consent" drifting apart is how one path quietly starts leaving boxes unticked,
// and an unticked consent box is the one thing that silently voids the whole
// application.
/**
 * A CONSENT IS NOT A CERTIFICATION OF FACT, AND NOT A COMMITMENT.
 *
 * His standing instruction is yes to every consent and AI-screening box, and
 * that is right for what it was written about: data processing, SMS, privacy
 * notices, 'the information provided is accurate'.
 *
 * Attacking it (F-276) showed the rule ticking these too:
 *
 *   "I certify that I am a United States citizen"        <- FALSE. He is F-1.
 *   "I certify that I do not require visa sponsorship"   <- FALSE, and his
 *                                                           profile says so.
 *   "I agree to pay a $500 application processing fee"
 *   "I agree to waive my right to sue this employer"
 *   "I agree to work unpaid for the first 90 days"
 *
 * The first two are the reason this exists: a false statement about his
 * immigration status, asserted on his behalf, on a form a human reads. That is
 * the fabrication rule broken by the consent rule.
 *
 * So a box whose text CLAIMS A STATUS he has an answer for, or COMMITS him to
 * money or to giving up a right, is never auto-ticked. It is left to him,
 * which costs one click and cannot assert anything untrue.
 */
export const CERT_NOT_RE = /\bcitizen(ship)?\b|\bnaturaliz|permanent resident|green card|sponsor(ship)?|\bvisa\b|work authoriz|authorized to work|right to work|\bpay\b|\bfee\b|deposit|\bwaive\b|waiver|unpaid|without pay|\bindemnif|arbitrat|\bsue\b|non-?compete/i;

/*
 * TWO SPELLINGS TESLA USES THAT THIS MISSED (live form, 2026-09-20).
 *
 *   "I have read, understand, and agree to the statements above."
 *        A REQUIRED checkbox, left unticked. The old pattern wanted the verb
 *        directly after "I", and here "have read," sits in between — so the
 *        most ordinary consent sentence on the internet did not match.
 *        Anything between "I" and the verb is now allowed, but only a short
 *        run of it, so this cannot reach across a whole paragraph and tick a
 *        box on the strength of an "agree" forty words away.
 *
 *   "I authorize Tesla to consider me for other job opportunities…"
 *        Not in the verb list at all. It widens where his application is read
 *        rather than narrowing it, which is the direction he wants.
 *
 * CERT_NOT_RE still vetoes both — it runs first, and it is what keeps
 * "I certify that I am a U.S. citizen" out of reach of this rule.
 */
export const CERT_RE = /i\s+(?:[\w,]+[\s,]+){0,3}(certify|acknowledge|agree|consent|understand|confirm|authoriz\w+)|terms\s+(of|and)|privacy\s+(policy|notice)|accuracy\s+of/i;

/**
 * Fill the application form.
 * @returns {{filled:Array, review:Array, needsInput:Array, skipped:Array, resumeUploaded:boolean}}
 */
export async function fill(page, profile) {
  const result = { filled: [], review: [], needsInput: [], skipped: [], resumeUploaded: false };

  // Wait for the form to exist (Greenhouse renders it client-side).
  //
  // `:visible` on each branch is load-bearing, not decoration. waitForSelector
  // resolves a selector list to the FIRST match in DOM order and then waits for
  // THAT element to satisfy `state`. On the Texas Instruments application the
  // first match of `input, textarea, select` is the Oracle chat widget's hidden
  // textarea, which is never visible — so the wait ran its full twenty seconds
  // while the email field sat two nodes below it, already rendered.
  //
  // Measured on that page: `input, textarea, select` timed out at 6010ms;
  // `input:visible, …` found the field in 26ms. Any site with a hidden chat,
  // consent or skip-link control ahead of its form paid that toll on every
  // application the generic adapter drove.
  await time('form:wait-controls', () =>
    page.waitForSelector('input:visible, textarea:visible, select:visible', { timeout: 10000 })
      .catch(() => {}));
  // MULTI-PASS. The form is not all there when the page settles.
  //
  // Measured on a live Applied Materials (Eightfold) application: the DOM held
  // 68 visible controls — 11 text, 2 checkbox, 55 radio — and this function had
  // tagged 12. Every missing control PASSED the visibility filter, so nothing
  // was being wrongly skipped: the question sections simply had not rendered
  // yet when the single enumerate ran. Their names say so —
  // Position_Specific_Questions_QUESTION_SETUP_*, which Eightfold builds after
  // the contact block.
  //
  // That is why an application reported "6 field(s) filled" on a form with
  // sixty-eight, and why the EEO and work-authorisation questions — the ones
  // that decide whether the application is usable — were the ones left blank.
  //
  // So: enumerate, fill, look again. Stop when a pass turns up nothing new, or
  // after MAX_PASSES, so a form that renders a field per keystroke cannot spin
  // forever. Fields are keyed by name+value (radios share a name) and by
  // label+type otherwise, so nothing is filled twice across passes.
  const MAX_PASSES = 6;
  const handled = new Set();
  const keyOf = (f) => (f.name ? `${f.name}|${f.value ?? ''}|${f.type}` : `${f.label}|${f.type}`);

  let emptyPasses = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (pass > 0) {
      // Sections below the fold render lazily — the twelve "Application
      // questions" radio groups on the Applied Materials form appear only once
      // that part of the page is reached. Scroll, then wait: breaking on the
      // FIRST empty pass ended the run before they existed, which is why the
      // report never mentioned them at all.
      await time('form:rescan-wait', async () => {
        // Scroll to trigger the lazy sections, then WAIT FOR THE FORM TO GROW
        // rather than for a fixed 2 seconds.
        //
        // The fixed wait made the outcome depend on how fast the page happened
        // to render. Three consecutive Applied Materials runs filled 16, 16 and
        // 12 fields — and the 12 was the FASTEST run (16.6s of fill against
        // 25s), because the later question groups had not appeared within the
        // fixed window and the loop exited before they did. A field count that
        // varies run to run is the worst kind of unreliable: the report says
        // "filled 12" both times and never mentions the four it never saw.
        //
        // Growth ends the wait immediately, so a static form is FASTER than it
        // was; only a form that is still rendering pays the longer budget. The
        // first rescan gets the bigger budget because that is the one catching
        // lazily-rendered sections; the second only has to confirm.
        const before = await countApplicationFields(page);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
        // Deliberately SHORT, and the reason is measured rather than assumed.
        //
        // A longer budget looked obviously right — give the lazy sections time
        // to arrive — and the evidence says it buys nothing. On the Applied
        // Materials runs that ended short, the missing controls were still
        // absent after twenty-three seconds of extra waiting, and the final
        // enumerate found ZERO unhandled fields: the form served on those runs
        // was genuinely shorter, not slower. Meanwhile the long budget cost a
        // Relativity Space application 12s → 24s for the same twelve fields,
        // because a static form pays the full budget on every rescan.
        //
        // So: short budget, and growth ends it immediately — which is what
        // actually helps, and is why this is not simply the old fixed sleep.
        const budget = 2500;
        const deadline = Date.now() + budget;
        while (Date.now() < deadline) {
          await page.waitForTimeout(350);
          if (await countApplicationFields(page) > before) break;
        }
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await page.waitForTimeout(300);
      });
    }
    const all = await time('form:enumerate', () => enumerateFields(page));
    const fields = all.filter((f) => {
      const k = keyOf(f);
      if (handled.has(k)) return false;
      handled.add(k);
      return true;
    });
    if (!fields.length) { if (++emptyPasses >= 2) break; continue; }
    emptyPasses = 0;
    if (process.env.JARVIS_TRACE_PASS) {
      const nowT = performance.now();
      console.log(`   [pass ${pass}] ${fields.length} new field(s); previous pass took ${Math.round(nowT - (globalThis.__jarvisPassT || nowT))}ms`);
      globalThis.__jarvisPassT = nowT;
    }


    // Radio groups: one decision per group, made after seeing all its options.
    const radioGroups = new Map(); // name → {label, entries:[{f, optText}]}
    for (const f of fields) {
      if (f.type !== 'radio') continue;
      const key = f.name || f.label;
      const groupLabel = f.label.includes(' — ') ? f.label.split(' — ')[0] : f.label;
      const optText = f.label.includes(' — ') ? f.label.split(' — ').slice(1).join(' — ') : f.label;
      if (!radioGroups.has(key)) radioGroups.set(key, { label: groupLabel, entries: [] });
      radioGroups.get(key).entries.push({ f, optText });
    }
    const radioDone = new Set();

    // Checkbox GROUPS — one question, many boxes. Radios have been grouped
    // since this file was written; checkboxes never were, so each box was
    // resolved on its own and a question whose answer was sitting in the list
    // came back unanswered.
    //
    // Measured on a live Relativity Space (Greenhouse) form: "How did you hear
    // about us? *" is SIXTEEN checkboxes, one of them "Company Website" — his
    // configured answer. It produced sixteen separate "no matching answer"
    // lines on a REQUIRED field, which is both a miss and the bulk of the noise
    // in that report.
    //
    // Keyed by the group label rather than by `name`: checkboxes in a group
    // usually carry different names, which is what makes them checkboxes.
    const checkboxGroups = new Map();
    for (const f of fields) {
      if (f.type !== 'checkbox' || !f.label.includes(' — ')) continue;
      const groupLabel = f.label.split(' — ')[0];
      const optText = f.label.split(' — ').slice(1).join(' — ');
      if (!checkboxGroups.has(groupLabel)) checkboxGroups.set(groupLabel, { label: groupLabel, entries: [] });
      checkboxGroups.get(groupLabel).entries.push({ f, optText });
    }
    const checkboxGroupDone = new Set();

    for (const f of fields) {
      const loc = page.locator(`[data-jarvis-i="${f.i}"]`);
      if (process.env.JARVIS_TRACE_PASS) {
        const t = performance.now();
        if (globalThis.__jarvisFieldT) console.log(`      +${Math.round(t - globalThis.__jarvisFieldT)}ms  <- ${globalThis.__jarvisFieldL}`);
        globalThis.__jarvisFieldT = t;
        globalThis.__jarvisFieldL = `${f.type}/${f.role || '-'} ${String(f.label).slice(0, 45)}`;
      }

      // A grouped checkbox question, decided once for the whole group. A group
      // of ONE is not a group — that is how a consent box is worded ("…terms
      // and conditions: — Yes") — so those fall through to the single-checkbox
      // path below and keep being auto-ticked.
      if (f.type === 'checkbox' && f.label.includes(' — ')) {
        const groupLabel = f.label.split(' — ')[0];
        const group = checkboxGroups.get(groupLabel);
        if (group && group.entries.length >= 2) {
          if (checkboxGroupDone.has(groupLabel)) continue;
          checkboxGroupDone.add(groupLabel);
          // A CONSENT group is ticked in full, and this test has to come first.
          //
          // Grouping checkboxes (F-86) introduced a regression it took a live
          // Lam Research form to catch: resolveLabel() returns `never` for
          // anything saying "I consent", because that rule exists for TYPED
          // signature boxes. Individually, each box had matched CERT_RE and been
          // auto-ticked; grouped, the whole group hit the `never` branch and was
          // reported "left blank by policy" — silently doing the opposite of his
          // standing instruction that every consent box gets ticked.
          //
          // Ticking every option is what the ungrouped code did, and it is right
          // here: CERT_RE only matches certify/acknowledge/agree/consent, so the
          // options under it are consents, not a menu to choose between.
          if (profile.policy?.auto_check_certifications && CERT_RE.test(groupLabel) && !CERT_NOT_RE.test(groupLabel)) {
            for (const e of group.entries) {
              try {
                await tick(page.locator(`[data-jarvis-i="${e.f.i}"]`));
                result.filled.push({ label: `${groupLabel} — ${e.optText}`, value: '☑ checked (certification/consent)' });
              } catch {
                result.needsInput.push({ label: `${groupLabel} — ${e.optText}`, why: 'consent box would not tick — tick it yourself in this tab' });
              }
            }
            result.review.push({ label: groupLabel, value: `${group.entries.length} consent box(es) checked; confirm before submit` });
            continue;
          }
          const r = resolveLabel(groupLabel, profile);
          if (r.kind === 'never') {
            result.skipped.push({ label: groupLabel, why: 'left blank by policy (self-ID/certification)' });
            continue;
          }
          const hit = r.kind === 'answer' ? chooseOption(r.value, group.entries.map(e => e.optText)) : -1;
          if (hit !== -1) {
            const target = group.entries[hit];
            try {
              await tick(page.locator(`[data-jarvis-i="${target.f.i}"]`));
              result.filled.push({ label: groupLabel, value: target.optText });
              result.review.push({ label: groupLabel, value: `checked "${target.optText}" — one of ${group.entries.length}; confirm before submit` });
            } catch {
              result.needsInput.push({ label: groupLabel, why: `could not tick "${target.optText}" — pick it yourself in this tab` });
            }
            continue;
          }
          result.needsInput.push({
            label: groupLabel,
            why: `checkbox group — no option matching ${r.kind === 'answer' ? JSON.stringify(r.value) : 'any configured answer'}; `
              + `options: ${group.entries.map(e => e.optText).slice(0, 6).join(' | ')}; pick yourself`,
          });
          continue;
        }
      }

      // Resume upload — the one file input we act on.
      if (f.type === 'file') {
        // ONE TEST, SHARED WITH THE PLANNER (F-255).
        //
        // This used to decide for itself: `/resume|cv/` on the label or name,
        // OR "if the page has exactly one file input, it IS the resume". That
        // last clause is what made it wrong — on a form whose only upload is a
        // TRANSCRIPT, a COVER LETTER or a PORTFOLIO, it uploaded his resume
        // into it. The planner has refused those all along, and the extension
        // goes through the planner, so only this engine had the bug.
        //
        // `isResumeField` keeps the part that mattered — Greenhouse labels its
        // resume input just "Attach", and an unlabelled input still counts —
        // while excluding the uploads that are emphatically not the resume.
        const isResume = isResumeField(f);
        const path = profile.documents?.resume_path;
        if (isResume && path) {
          try {
            await loc.setInputFiles(path);
            result.resumeUploaded = true;
            result.filled.push({ label: f.label, value: `(uploaded ${path})` });
          } catch (e) {
            result.needsInput.push({ label: f.label, why: `resume upload failed: ${e.message.split('\n')[0]}` });
          }
        } else {
          result.needsInput.push({ label: f.label, why: isResume ? 'no resume_path set in apply-profile.yml' : 'file upload — attach manually' });
        }
        continue;
      }

      // Checkboxes. With the user's standing consent (policy.auto_check_
      // certifications), certification/consent boxes are checked — and always
      // listed under REVIEW. Yes-answered questions check too; anything else
      // is left for the user. Nothing here can submit.
      if (f.type === 'checkbox') {
        if (profile.policy?.auto_check_certifications && CERT_RE.test(f.label) && !CERT_NOT_RE.test(f.label)) {
          try {
            await tick(loc);
            result.filled.push({ label: f.label, value: '☑ checked (certification/consent)' });
            result.review.push({ label: f.label, value: 'checked — certification; confirm before submit' });
          } catch (e) {
            result.needsInput.push({ label: f.label, why: `could not check: ${e.message.split('\n')[0]}` });
          }
          continue;
        }
        const r = resolveLabel(f.label, profile);
        if (r.kind === 'answer' && yesNo(r.value) === 'yes') {
          try {
            await tick(loc);
            result.filled.push({ label: f.label, value: '☑ checked' });
            if (r.review) result.review.push({ label: f.label, value: 'checked' });
          } catch (e) {
            result.needsInput.push({ label: f.label, why: `could not check: ${e.message.split('\n')[0]}` });
          }
        } else if (r.kind === 'answer' && yesNo(r.value) === 'no') {
          // A "No" answer on a checkbox GROUP means: check its "Not Applicable"/
          // "None" option if one exists (e.g. Active Security Clearance(s)).
          const optText = f.label.includes(' — ') ? f.label.split(' — ').slice(1).join(' — ') : f.label;
          if (/^(not applicable|none|n\/a)\b/i.test(optText.trim())) {
            try {
              await tick(loc);
              result.filled.push({ label: f.label, value: '☑ checked (your answer is No → Not Applicable)' });
              if (r.review) result.review.push({ label: f.label, value: 'checked Not Applicable' });
            } catch (e) {
              result.needsInput.push({ label: f.label, why: `could not check: ${e.message.split('\n')[0]}` });
            }
          } else {
            result.skipped.push({ label: f.label, why: 'left unchecked (your answer is No)' });
          }
        } else {
          result.needsInput.push({ label: f.label, why: 'checkbox — no matching answer; check it yourself if applicable' });
        }
        continue;
      }

      // Radio groups: resolve the GROUP question once, pick the option whose
      // text matches the configured answer; otherwise flag the group once.
      if (f.type === 'radio') {
        const key = f.name || f.label;
        if (radioDone.has(key)) continue;
        radioDone.add(key);
        const group = radioGroups.get(key);
        // If the group's "label" is just one of its own options, the form gave
        // it no question text and the enumerator picked an option. The shared
        // `name` is the question in that case - see questionFromName above.
        const optTexts = new Set(group.entries.map(e => e.optText));
        const question = (optTexts.has(group.label) && f.name)
          ? (questionFromName(f.name) || group.label)
          : group.label;
        const r = resolveLabel(question, profile);
        if (r.kind === 'never') {
          result.skipped.push({ label: group.label, why: 'left blank by policy' });
          continue;
        }
        if (r.kind === 'answer') {
          const hit = group.entries.find(e => optionMatches(r.value, e.optText));
          if (hit) {
            try {
              await tick(page.locator(`[data-jarvis-i="${hit.f.i}"]`));
              result.filled.push({ label: group.label, value: hit.optText });
              if (r.review) result.review.push({ label: group.label, value: hit.optText });
            } catch (e) {
              result.needsInput.push({ label: group.label, why: `could not select "${hit.optText}": ${e.message.split('\n')[0]}` });
            }
            continue;
          }
          result.needsInput.push({ label: group.label, why: `no option matching "${r.value}" — options: ${group.entries.map(e => e.optText).slice(0, 5).join(' | ')}` });
          continue;
        }
        result.needsInput.push({ label: group.label, why: 'radio group — select at review' });
        continue;
      }

      const r = resolveLabel(f.label, profile);
      if (r.kind === 'never') { result.skipped.push({ label: f.label, why: 'left blank by policy (self-ID/certification)' }); continue; }
      if (r.kind === 'unknown') {
        if (f.label) {
          // A dropdown's PLACEHOLDER is not a question. Neuralink's form has a
          // control whose only readable text is "Select...", and reporting
          // `Select... - no answer in apply-profile.yml` tells him to add a
          // profile key for a question nobody asked. Say what is actually true:
          // the control has no label the engine can read.
          const placeholder = /^(select|choose|please select|pick one|-+|—+)\s*\.{0,3}$/i.test(String(f.label).trim());
          result.needsInput.push(placeholder
            ? { label: f.label, why: 'this control has no readable label — the form shows only its placeholder; set it yourself in this tab' }
            : { label: f.label, why: 'no answer in apply-profile.yml' });
        }
        continue;
      }

      try {
        if (f.tag === 'select') {
          const si = chooseOption(r.value, f.options || []);
          const target = si === -1 ? undefined : f.options[si];
          if (target) {
            await loc.selectOption({ label: target });
            result.filled.push({ label: f.label, value: target });
            if (r.review) result.review.push({ label: f.label, value: target });
          } else {
            result.needsInput.push({ label: f.label, why: `no matching option for "${r.value}" — options: ${f.options?.slice(0, 6).join(' | ')}` });
          }
        } else if (f.role === 'combobox' || f.type === 'search') {
          // React select. NEVER press Enter here — Enter inside a form input can
          // submit the form. Open the listbox, type just the FIRST WORD to filter
          // (full phrases over-filter when the option wording differs slightly),
          // then CLICK the option that matches the whole answer; anything less
          // certain gets flagged instead.
          // Opening the listbox: the input itself can be zero-sized or overlaid by
          // its own styled wrapper, which makes a direct click time out (that was
          // every "fill failed: locator.click" on Eightfold forms). Scroll it in,
          // then fall back to clicking the wrapper.
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          // 1200ms, not 5000. The comment below records that on Eightfold forms
          // this first click ALWAYS fails the hit-target test — the styled
          // wrapper sits over the input — and that the escalation beneath it is
          // what actually opens the listbox. So every combobox paid the full
          // five seconds to learn something already known: eight of them on one
          // Lam Research form, forty seconds of a 2m45s application.
          //
          // The timeout only has to be long enough for a combobox that IS
          // directly clickable to respond; those respond in tens of
          // milliseconds. Nothing is skipped either way — the ladder below runs
          // on failure exactly as before.
          await time('form:combobox-open', () => loc.click({ timeout: 1200 })).catch(async () => {
            // ESCALATION, in order of how much it can go wrong.
            //
            // Measured on a live Applied Materials (Eightfold) form: the five
            // fields that failed — Country, Country code, Protected Veteran,
            // Disability, Language — are all `input[role=combobox]`, 556x36,
            // visible, pointer-events:auto, not disabled, with NO overlay on the
            // page. Nothing about them is unclickable; Playwright's hit-target
            // check is failing because the styled wrapper sits over the input,
            // and that surfaces as "locator.click: Timeout 5000ms exceeded".
            //
            // The old fallback called a raw DOM .click() on the wrapper. React
            // selects open on mousedown/pointerdown and ignore a synthetic
            // click(), so it did nothing and the field was reported as failed.
            // 1. force:true — a real trusted click that skips the hit-target test.
            const forced = await loc.click({ force: true, timeout: 2500 }).then(() => true).catch(() => false);
            if (!forced) {
              // 2. the pointer sequence a custom select actually listens for.
              await loc.evaluate((el) => {
                const target = el.closest('[role="combobox"], [class*="select"], [class*="Select"]') || el.parentElement || el;
                const opts = { bubbles: true, cancelable: true, composed: true };
                for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
                  const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
                  target.dispatchEvent(new Ctor(type, opts));
                }
              }).catch(() => {});
              // 3. focus alone opens some comboboxes; typing below does the rest.
              await loc.focus().catch(() => {});
            }
            await page.waitForTimeout(300);
          });
          const yn = yesNo(r.value);
          const probe = yn || r.value.split(/\s+/)[0];
          // BOUNDED. `fill()` and `pressSequentially()` both carry Playwright's
          // THIRTY-SECOND default when no timeout is given, and a combobox whose
          // input is not considered editable burns both in sequence — a minute
          // per field. That is the same defect as the bare `.check()` above, and
          // it is where a Lam Research application spent most of 2m45s across
          // eight dropdowns. Four seconds is far longer than any real combobox
          // needs to accept a keystroke.
          await time('form:combobox-type', () =>
            loc.fill(probe, { timeout: 4000 })
              .catch(() => loc.pressSequentially(probe, { timeout: 4000 }).catch(() => {})));
          await page.waitForTimeout(400);
          // Scope to THIS combobox's open listbox — a page-global option query can
          // read a different dropdown's list (e.g. the phone country-code picker).
          const boxId = await loc.getAttribute('aria-controls').catch(() => null) || await loc.getAttribute('aria-owns').catch(() => null);
          // The page-global fallback is only safe when there is exactly ONE list
          // open. On OpenAI's Ashby self-identification block four comboboxes sit
          // together, and `.last()` read the ETHNICITY list while answering
          // GENDER — the report said `no option matching "Decline to
          // self-identify" — options: Hispanic or Latino`.
          //
          // That miss was lucky. The same wrong list could just as easily have
          // contained a plausible match, and the engine would have picked a real
          // answer to a question it was not looking at, and reported it as
          // filled. That is F-84's failure mode with a worse blast radius, on
          // exactly the questions where a wrong answer matters most.
          //
          // So: no aria-controls AND more than one list open means we do not
          // know which list is ours, and the field is flagged rather than
          // guessed at.
          let box = null;
          if (boxId) {
            box = page.locator(`[id="${boxId}"]`);
          } else {
            const open = page.locator('[role="listbox"]:visible');
            const n = await open.count().catch(() => 0);
            if (n === 1) box = open.first();
          }
          if (!box) {
            result.needsInput.push({
              label: f.label,
              why: `dropdown — could not tell which option list belongs to this question (${await page.locator('[role="listbox"]:visible').count().catch(() => 0)} open at once); pick it yourself in this tab`,
            });
            await pressEscape(page);
            continue;
          }
          const optionLoc = box.locator('[role="option"]');
          let options = await optionLoc.allTextContents().catch(() => []);
          if (!options.length) {
            // Some dropdowns are click-only: typing filtered everything out or
            // closed the list. Clear and reopen without typing.
            // Bounded for the same reason as the type above — a bare fill()
            // waits 30s.
            await loc.fill('', { timeout: 3000 }).catch(() => {});
            await pressEscape(page);
            await time('form:combobox-reopen', () => loc.click({ timeout: 2500 }).catch(() => {}));
            await page.waitForTimeout(400);
            options = await optionLoc.allTextContents().catch(() => []);
          }
          const idx = chooseOption(r.value, options);
          if (idx !== -1) {
            await optionLoc.nth(idx).click({ timeout: 5000 });
            result.filled.push({ label: f.label, value: options[idx] + ' (combobox — verify at review)' });
            if (r.review) result.review.push({ label: f.label, value: options[idx] });
          } else {
            result.needsInput.push({ label: f.label, why: `dropdown — no option matching "${r.value}"${options.length ? ' — options: ' + options.slice(0, 5).join(' | ') : ''}; pick manually` });
          }
          // Close any lingering list so it can't intercept the next field's click.
          await pressEscape(page);
        } else {
          // A number input rejects anything non-numeric ("Cannot type text into
          // input[type=number]"), so hand it just the digits.
          const value = f.type === 'number' ? (String(r.value).match(/\d+/) || [''])[0] : r.value;
          if (!value) { result.needsInput.push({ label: f.label, why: `no numeric value in "${r.value}"` }); continue; }
          await loc.fill(value, { timeout: 8000 });
          // Verify the value actually stuck (controlled React inputs can silently
          // discard programmatic values — that's how empty-but-"filled" happens).
          const now = await loc.inputValue().catch(() => null);
          if (now !== null && now.trim() === '') {
            result.needsInput.push({ label: f.label, why: 'value did not stick — fill manually' });
          } else {
            result.filled.push({ label: f.label, value });
            if (r.review) result.review.push({ label: f.label, value });
          }
        }
      } catch (e) {
        result.needsInput.push({ label: f.label, why: `fill failed: ${e.message.split('\n')[0]}` });
      }
    }
  }

  // RADIO GROUPS, DECIDED ONCE EVERY OPTION HAS BEEN SEEN.
  //
  // A group can only be matched against its options when all of them are on the
  // page, and these forms render in stages. On OpenAI's Ashby application the
  // gender radios arrived across SEPARATE passes, so each pass built a PARTIAL
  // group and asked chooseOption to match "Decline to self-identify" against a
  // one-option list containing "Male". All four self-identification questions
  // failed that way, on a form where his standing instruction is that they get
  // answered.
  //
  // Re-enumerating first is what makes this safe: data-jarvis-i is reassigned on
  // every enumerate, so a handle captured in pass 0 need not point at the same
  // control now.
  try {
    const groups = new Map();
    for (const f of await enumerateFields(page)) {
      if (f.type !== 'radio') continue;
      const key = f.name || f.label;
      const gl = f.label.includes(' — ') ? f.label.split(' — ')[0] : f.label;
      const ot = f.label.includes(' — ') ? f.label.split(' — ').slice(1).join(' — ') : f.label;
      if (!groups.has(key)) groups.set(key, { label: gl, name: f.name, entries: [] });
      groups.get(key).entries.push({ f, optText: ot });
    }
    for (const group of groups.values()) {
      if (group.entries.length < 2) continue;
      const optTexts = new Set(group.entries.map(e => e.optText));
      // The label is unusable in two ways, and both mean the form gave this
      // group no question text of its own:
      //   - it IS one of the options ("Male"), or
      //   - it is the enumerator's blob, which swallowed the options whole
      //     ("GenderInput genderMaleFemaleDecline to self-identify").
      // Either way the shared `name` is the question.
      const blob = [...optTexts].filter(o => o && group.label.includes(o)).length >= 2;
      const question = ((optTexts.has(group.label) || blob) && group.name)
        ? (questionFromName(group.name) || group.label)
        : group.label;
      if (result.filled.some(x => String(x.label) === question)) continue;
      const r = resolveLabel(question, profile);
      if (r.kind !== 'answer') continue;
      const hit = chooseOption(r.value, group.entries.map(e => e.optText));
      if (hit === -1) continue;
      const target = page.locator(`[data-jarvis-i="${group.entries[hit].f.i}"]`);
      if (await target.isChecked({ timeout: 1500 }).catch(() => false)) continue;
      try {
        await tick(target);
        result.filled.push({ label: question, value: group.entries[hit].optText });
        result.review.push({ label: question, value: group.entries[hit].optText });
        // The partial-group attempts were reported under the OPTION texts, so
        // clear those too or the report asks him to answer what is answered.
        result.needsInput = result.needsInput.filter(n =>
          String(n.label) !== question && !optTexts.has(String(n.label)));
      } catch { /* leave it flagged for him */ }
    }
  } catch { /* a second look is a courtesy, never a failure */ }

  // DID WE MISS ANY? One last enumerate, comparing against everything the loop
  // handled.
  //
  // The pass loop stops when two consecutive passes turn up nothing new, and on
  // a form that renders in stages that is a judgement call it can get wrong.
  // Measured across nine Applied Materials runs after the growth-wait went in:
  // eight filled 16 fields, one filled 12 — and the report for that one said
  // "filled 12" without ever mentioning the four it never saw. A field count
  // that varies run to run is bad; a report that cannot tell you it varied is
  // worse, because he would send the application believing it complete.
  //
  // This cannot make the render race go away. It makes it VISIBLE, which is the
  // rule this whole system is built on: flag, never silently drop.
  try {
    const finalFields = await enumerateFields(page);
    const leftover = finalFields.filter((f) => !handled.has(keyOf(f)));
    if (process.env.JARVIS_TRACE_PASS) console.log(`   [final] ${finalFields.length} field(s) on page, ${handled.size} handled, ${leftover.length} leftover`);
    if (leftover.length) {
      result.needsInput.push({
        label: `${leftover.length} field(s) appeared after the run finished`,
        why: `${leftover.slice(0, 5).map(f => String(f.label).replace(/\s+/g, ' ').slice(0, 45)).join(' · ')}`
          + ` — this form renders in stages; re-run to fill them, or complete them in this tab`,
      });
    }
  } catch { /* the final look is a courtesy, never a failure */ }

  // COLLAPSE repeats before reporting. The multi-pass loop dedupes the fields it
  // ACTS on, keyed by name+value or label+type; a form that re-renders between
  // passes with different name attributes defeats that key and the same field is
  // filled, and listed, twice. Tesla's reported "filled 10 field(s)" was six —
  // Legal First Name, Legal Last Name, Phone Number and Email each counted
  // twice.
  //
  // This matters past cosmetics: `filled` is the number Review & Send uses to
  // decide an application is ready (F-44), so an inflated count is the same
  // defect that fault was about, arriving by a different route.
  const collapse = (rows, keyOf) => {
    const seen = new Set();
    return rows.filter((r) => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  // A LABEL THAT WAS FILLED IS NOT OUTSTANDING.
  //
  // Forms repeat labels: OpenAI's Ashby application renders Legal Name,
  // Preferred Name, Email and Phone Number twice — once in the contact block and
  // again in the self-identification block — and the second copy is inside a
  // section that will not accept a programmatic fill. The run filled all four
  // and then reported all four under "needs your input" as well, so the report
  // told him to go and complete fields it had just completed.
  //
  // The Eightfold adapter has reconciled its two passes this way since it was
  // written; the core never did it for the passes inside a single fill().
  const filledLabels = new Set(result.filled.map(f => String(f.label)));
  result.needsInput = result.needsInput.filter(n => !filledLabels.has(String(n.label)));

  result.filled = collapse(result.filled, (r) => `${r.label}|${r.value}`);
  result.review = collapse(result.review, (r) => `${r.label}|${r.value}`);
  result.needsInput = collapse(result.needsInput, (r) => `${r.label}|${r.why}`);
  result.skipped = collapse(result.skipped, (r) => `${r.label}|${r.why}`);
  return result;
}
