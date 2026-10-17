/**
 * Jarvis Apply — reading the form.
 *
 * Split out of content.js so it can be TESTED. Everything here is pure DOM work
 * with no extension API in sight, which means jarvis/extension/discover.test.mjs
 * can load it into a real browser page, point it at fixtures built from the
 * forms that actually broke, and assert what it finds. The messaging half cannot
 * be tested that way, so the two are kept apart.
 *
 * It exposes itself on globalThis because a content script has no module system;
 * background.js injects this file first and content.js second.
 */
(() => {
  const SUBMIT_RE = /submit|send application|finish|complete application/i;

  // What ats.js knows about this page's ATS, when ats.js was injected first.
  // Optional on purpose: every test harness that loads this file alone must
  // still get the generic behaviour, and so must a page whose ATS is unknown.
  const ATS = globalThis.__jarvisAts || null;
  const here = () => { try { return ATS?.atsFor(location.href) || null; } catch { return null; } };
  const matchesAny = (el, selector) => { try { return !!selector && el.matches(selector); } catch { return false; } };
  /**
   * A PAUSE THAT STAYS A PAUSE IN A BACKGROUND TAB (F-464).
   *
   * The walker polls at 250ms. Chrome throttles a hidden tab's chained timers
   * to one a second, so hidden — which is how a follow-along run spends most
   * of its time — `waitFor` noticed the next step up to a second late and
   * `settle` called a page stable after three seconds of quiet instead of
   * three-quarters of one. Handing each timer over through a message port
   * restarts the chain at nesting level zero. Same helper as content.js.
   */
  // Hidden, the worker keeps the time (content.js, 2026-09-25): a hidden
  // page's timers never fire sooner than once a second.
  const pause = (ms) => new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(); } };
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && ms > 0 && globalThis.chrome?.runtime?.sendMessage) {
      try { chrome.runtime.sendMessage({ type: 'sleep', ms }, () => { void chrome.runtime.lastError; finish(); }); } catch { /* fallback below */ }
    }
    let port;
    try { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); finish(); }; port = ch.port2; } catch { /* no ports here */ }
    setTimeout(() => (port ? port.postMessage(0) : finish()), ms);
  });

  /**
   * SHADOW ROOTS ARE PART OF THE PAGE (F-327).
   *
   * SmartRecruiters' apply form (jobs.smartrecruiters.com/oneclick-ui — the
   * ATS with the most rows in his store) is built from `spl-*` web components.
   * Every input, the resume dropzone, the phone field and the Next button live
   * inside open shadow roots, and `document.querySelectorAll` sees none of
   * them: the page read as "0 fields — this does not look like an
   * application" (Becton Dickinson, measured live 2026-09-04). Every question
   * this file asks of the page goes through here, so a control is found
   * wherever the page put it, in document order.
   *
   * Two kinds of shadow root are NOT the page: our own overlay, and other
   * extensions' — Simplify draws its whole sidebar ("Autofill", "Resume
   * Score", a search box) into one on the same form. Closed roots cannot be
   * entered and are not tried.
   */
  const FOREIGN_ROOT_RE = /jarvis-overlay|simplify|grammarly|lastpass|1password|bitwarden|dashlane/i;
  const foreignHost = (h) => FOREIGN_ROOT_RE.test(`${h.id || ''} ${typeof h.className === 'string' ? h.className : ''} ${h.tagName}`);
  function deepQuerySelectorAll(selector, root = document, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot && !foreignHost(el)) deepQuerySelectorAll(selector, el.shadowRoot, out);
    }
    return out;
  }
  const allControls = () => deepQuerySelectorAll('input, select, textarea');
  /**
   * Is this element drawn? NOT `offsetParent !== null`: that is null for
   * anything inside a `position: fixed` ancestor — a dropdown's popover, a
   * modal, a sticky footer — so SmartRecruiters' "How did you find out" list
   * rendered six rows and this file counted zero of them (F-336).
   */
  const onScreen = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  /**
   * What tells one instance of a component from the next. It must be UNIQUE
   * on the page: SmartRecruiters' two dropzones — "Easy Apply" (parse a file
   * to autofill) and "Resume *" — are both <spl-dropzone> with no id, no label
   * and no name, each first among its parent's children, so both read as
   * "spl-dropzone#0/file-input" and the plan's upload for the Resume slot was
   * matched back to the Easy Apply one: the resume was parsed, the form
   * re-rendered under the run, and the Resume slot stayed empty (F-352).
   * Otherwise the instance's position among every element of its tag on the
   * page — a number, never a test id: "apply-with-resume-container" would
   * have read as the resume slot to the planner's identifier rule.
   */
  const hostName = (h) => h.id || h.getAttribute('label') || h.getAttribute('name')
    || `${h.tagName.toLowerCase()}#${deepQuerySelectorAll(h.tagName.toLowerCase()).indexOf(h)}`;
  /** The parent of a node, stepping out of a shadow root to its host. */
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
  /**
   * The element a click must land on. A web component's host is not its
   * button: SmartRecruiters' Next is <oc-button><spl-button>…</spl-button>
   * </oc-button> with the real <button> two shadow roots down, and a click on
   * the host reaches nobody's listener.
   */
  const clickTarget = (el) => {
    if (!el) return el;
    if (matchesAny(el, 'button, a, input, [role="button"]')) return el;
    return deepQuerySelectorAll('button, [role="button"], a[href], input[type="button"], input[type="submit"]', el)[0] || el;
  };

  /**
   * React (Workday, Eightfold, Greenhouse's newer forms) tracks input state in
   * its own store and ignores a plain `el.value = x` — the value reappears on
   * the next render as though nothing happened. Going through the prototype's
   * native setter and then dispatching the events React listens for is what
   * makes a typed value stick. This is the single most important function here.
   */
  function setNativeValue(el, value) {
    // Only a real field holds a value. Called on a <div> combobox or a
    // component host, the input setter throws "Illegal invocation" and the
    // field it was meant for was left cleared (Western Digital, 2026-09-24).
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    // `composed`: a control inside a shadow root has listeners on its host too.
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  /**
   * TYPE A VALUE THE WAY A PERSON DOES, and check the form kept it.
   *
   * Alex, 2026-09-15: "sometimes my name and stuff is filled in but the form
   * does not detect my name is there, then i have to delete a letter, retype,
   * then it registers." `setNativeValue` alone puts the words in the box and
   * fires `input` and `change` — and a form that validates on focus, keystroke
   * or BLUR (Workday commits on blur; Formik marks a field touched there) never
   * hears about them, so its own copy of the field stays empty and "required"
   * stands. The box then reads back as filled, which is why the extension
   * counted it.
   *
   * So the whole gesture: focus the box, insert the text with the browser's own
   * insertText command (its input events are real ones, which every framework
   * reads), fall back to the native setter when that is not possible, give the
   * key events a validator listens for, leave the field, and look again a beat
   * later — a controlled input that missed the change re-renders to its old
   * value on the next frame, and that is filled a second way, not counted.
   */
  const sameText = (got, want) => {
    const g = String(got ?? ''); const w = String(want ?? '');
    if (g === w) return true;
    const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!!g && bare(g) === bare(w)) return true;
    // The same number, as content.js's kept_same reads it (F-633): "6" for
    // "06", and a box that keeps only "90000" of "$90000/year". Never an
    // amount written with k or m.
    if (/^\d+$/.test(g.trim()) && /^\d+$/.test(w.trim()) && Number(g) === Number(w)) return true;
    return /^\s*\d[\d,]*\s*$/.test(g) && !/\d\s*[kKmM]\b/.test(w)
      && /^[\s$€£]*[\d,]+(\.0+)?\s*(\/\s*(yr|year|annum)|per\s+(year|annum)|annually|usd|a\s+year)?\s*$/i.test(w)
      && g.replace(/\D/g, '') === w.replace(/\.0+\s*/, ' ').replace(/[^\d]/g, '');
  };
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  // `stay`: type without leaving the box. A suggest-as-you-type list closes on
  // blur — Lever's "Current location" drops its rows the moment the field is
  // left, so the rows were never there to choose from (2026-09-25).
  async function enterText(el, value, { settleMs = 60, stay = false } = {}) {
    const want = String(value ?? '');
    const read = () => (el.isContentEditable ? String(el.textContent || '') : String(el.value ?? ''));
    const doc = el.ownerDocument || document;
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    const focused = doc.activeElement === el;
    if (!focused) el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));

    let via = 'setter';
    if (focused && want && typeof doc.execCommand === 'function' && !el.isContentEditable) {
      try {
        el.select?.();
        if (doc.execCommand('insertText', false, want) && read() === want) via = 'insertText';
      } catch { /* the command is not available here */ }
    }
    if (via === 'insertText') {
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      setNativeValue(el, want);
    }
    const key = want.slice(-1) || 'Backspace';
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }));

    // LEAVING THE FIELD IS WHERE WORKDAY COMMITS, AND el.blur() DOES NOT
    // ALWAYS SAY SO.
    //
    // Measured in his own Chrome on a strict fixture, 2026-09-17: with the
    // window not in front — `document.hasFocus() === false`, which is exactly
    // the background-tab case of F-464 — `el.blur()` moves `activeElement`
    // away and dispatches NO blur and NO focusout at all. The old code called
    // blur() and returned, so a form that commits on blur (Workday) or clears
    // its "required" error on touch (Formik) never heard anything, the value
    // sat in the box, and `kept` came back true because `el.value` still read
    // "Alex". That is F-470 exactly, surviving its own fix.
    //
    // So: blur it, and when the document has no focus — when the browser will
    // not raise those events itself — raise them here. Guarded by hasFocus()
    // so a focused window does not get them twice.
    const leave = () => {
      if (stay) return;
      const wasActive = doc.activeElement === el;
      if (wasActive) { try { el.blur(); } catch { /* fall through */ } }
      const focusedDoc = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
      if (!wasActive || !focusedDoc) {
        el.dispatchEvent(new FocusEvent('blur', { composed: true }));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
      }
    };
    leave();

    if (settleMs) await tick(settleMs);
    if (!sameText(read(), want)) {
      // The page put its own value back. Once more, the other way round.
      setNativeValue(el, want);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: want }));
      leave();
      if (settleMs) await tick(settleMs);
      via = `${via}+retry`;
    }
    return { kept: sameText(read(), want), via };
  }

  // A <slot> has no text of its own; its words are the nodes assigned to it.
  // SmartRecruiters chains a question through two slots (<spl-autocomplete>
  // → <spl-input> → its <label>), so the label read as "" until this.
  const slotText = (n) => (n && n.tagName === 'SLOT' && n.assignedNodes
    ? n.assignedNodes({ flatten: true }).map((t) => plainText(t)).join(' ')
    : plainText(n));
  // WORDS, NOT CODE OR SOMEONE ELSE'S OPTIONS (Spirit AeroSystems on iCIMS,
  // 2026-10-02). A question's container held a <style> block, and its label
  // read "#remainderSection{background-color:white;position:absolute;…}"; a
  // Year box inside a <label> that also held the Month and Day dropdowns read
  // "MonthJanFebMar…Day1234…Year". textContent includes both. Style, script
  // and template text never are, and a dropdown's options are not the label
  // of anything but that dropdown.
  // …nor a dropdown's own box: Paylocity draws its State and Country menus,
  // current value and all, INSIDE the <label>, which read "StateWashington"
  // and "CountryUnited States" — and no rule knew either (F-691).
  const NOT_WORDS = 'style, script, noscript, template, select, option, datalist, [aria-haspopup="listbox"], [role="listbox"]';
  function plainText(n) {
    if (!n) return '';
    if (n.nodeType === 1 && /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) return '';
    if (n.nodeType !== 1 || /^(SELECT|OPTION|DATALIST)$/.test(n.tagName) || !n.querySelector(NOT_WORDS)) return n.textContent || '';
    const copy = n.cloneNode(true);
    copy.querySelectorAll(NOT_WORDS).forEach((x) => x.remove());
    return copy.textContent || '';
  }
  // "SVGs not supported by this browser." is the fallback text inside an
  // icon's <svg>, not words on the form. Workable's resume slot read as
  // exactly that (Verustruct, 2026-09-24), so it was never taken for a resume.
  const text = (n) => slotText(n).replace(/SVGs? (are )?not supported by (this|your) browser\.?/gi, ' ').replace(/\s+/g, ' ').trim();

  /**
   * The label a human would read for this control.
   *
   * PORTED FROM jarvis/apply/_form.mjs, deliberately and almost line for line.
   * That version took twelve rounds against live forms to arrive at; writing a
   * fresh one here reproduced two of the bugs it had already fixed within an
   * hour, measured on a live Lever form:
   *
   *   - every radio question came back labelled with its own first OPTION
   *     ("Yes", "US", "0-2") instead of the question, so nothing could match it;
   *   - a <select>'s wrapper text swallowed the entire option list.
   *
   * If this ever needs changing, change it in both places. jarvis/extension/
   * discover.test.mjs runs this against fixtures built from the exact forms that
   * produced those bugs, which is what stops the two copies drifting silently.
   */
  /**
   * Workday's stable key for a field, e.g. "formField-legalName--firstName".
   *
   * Measured on a live GlobalFoundries application: Workday puts NO usable
   * label, name or id on the input itself — every one came back with an empty
   * `data-automation-id` — while the wrapping div carries an id that never
   * changes between tenants. jarvis/apply/_workday-keys.mjs answers off these
   * directly, which is what fills My Information instead of guessing at it.
   */
  function fieldKey(el) {
    const wrap = el.closest('[data-automation-id^="formField-"]');
    const wd = wrap?.getAttribute('data-automation-id') || el.getAttribute('data-automation-id') || '';
    if (wd) return wd;
    // A JSON-schema form's list entries (Honda's Phenom apply, 2026-10-02):
    // `experienceData[1].companyName` says which job and which part of it, which
    // the label ("Company Name", twice) cannot.
    const id = el.id || '';
    return /^[A-Za-z]+\[\d+\]\.[\w.]+$/.test(id) ? id : '';
  }

  /**
   * Is this input really a Workday PROMPT — a button-and-listbox widget with a
   * hidden input behind it?
   *
   * Measured on a live GlobalFoundries form: Country, State and Phone Device
   * Type each render a `<button>` showing "United States of America" over an
   * `<input>` whose value is `bc33aa3152ec42d4995f4791a1`. A plain filler sees
   * the input, types prose into it, and destroys a field Workday had already
   * filled correctly from his candidate profile.
   *
   * Returns `{ button, current }` for a prompt, or null for an ordinary input.
   */
  /**
   * The value an ARIA combobox is actually CARRYING, which is never `.value`.
   *
   * react-select clears its text input after a selection and renders the chosen
   * option as a sibling node. So a committed combobox reads `.value === ''`, and
   * one we merely typed into reads back the typed text perfectly. Asking the
   * input is not just unhelpful, it is exactly backwards.
   */
  // A PLACEHOLDER IS NOT A VALUE. TSMC's SuccessFactors menus show "No
  // Selection" until something is chosen; read as the value, "No" looked
  // already chosen and nothing was ever clicked (2026-09-24).
  const PLACEHOLDER_VALUE_RE = /^\s*(no\s+selection|none\s+selected|nothing\s+selected|select|choose|please\s+(select|choose)|select\s+(one|an?\s+option|a\s+value|an?\s+(state|country|province|region))|choose\s+(one|an?\s+option)|-+|—)\s*[.:…-]*\s*$/i;
  function comboValue(el) {
    const v = comboValueRaw(el);
    return PLACEHOLDER_VALUE_RE.test(String(v || '')) ? '' : v;
  }
  function comboValueRaw(el) {
    // TWO WIDGETS, OPPOSITE CONVENTIONS, and reading the wrong one is worse
    // than not reading at all.
    //
    //   react-select (Greenhouse, Lever)  commits into a rendered sibling and
    //                                     CLEARS the input.
    //   Eightfold  (Micron, Applied)      commits into the input's own value.
    //
    // Measured on both. Reading only the react-select shape meant every
    // Eightfold combobox looked uncommitted — and because the fill verifies
    // commit through this function, it CLEARED fifteen correctly chosen answers
    // on a live Micron form and reported them unanswered. A verification that
    // undoes correct work is worse than no verification.
    //
    // So the shape is identified first. A react-select renders a value
    // container; Eightfold has none. Only when there is no such container does
    // the input's own value count — which preserves the original point of this
    // function, that typed-but-uncommitted react-select text must never read as
    // an answer.
    // WORKDAY'S MULTI-SELECT commits into a chip list beside the box, and the
    // box keeps whatever was typed — so `el.value` is the search term, not the
    // answer, and a pick read as "nothing committed" (F-390). The chips are
    // the answer when there is a chip list to read.
    const wrap = el.closest?.('[data-automation-id^="formField-"]');
    const chips = wrap?.querySelector('[data-automation-id="selectedItemList"]');
    if (chips) return text(chips);
    // SMARTRECRUITERS' <spl-multiselect-autocomplete> keeps the choice on the
    // component — `host.value` holds the option ids and the chip is drawn in
    // its shadow root — while the input it wraps is emptied on every pick
    // (Western Digital, measured 2026-09-24). Read as the input, a pick that
    // landed looked like nothing, and a retry toggled it back off.
    // The input can sit several components deep (the multi-select wraps an
    // inner input component), so walk out through the hosts to the one that
    // holds a `value`.
    // THE ATTRIBUTE, NOT THE PROPERTY: an extension's content script runs in
    // an isolated world where a component's own JS properties (`host.value`)
    // do not exist; SmartRecruiters mirrors the choice into a `value`
    // attribute, which the DOM shares with every world.
    const hostValue = (h) => { const p = h.value; return p != null ? p : h.getAttribute?.('value'); };
    let host = el.getRootNode?.()?.host;
    for (let i = 0; host && i < 4 && !(/autocomplete|select/i.test(host.tagName) && ('value' in host || host.hasAttribute?.('value'))); i += 1) host = host.getRootNode?.()?.host;
    if (host && /autocomplete|select/i.test(host.tagName)) {
      const v = hostValue(host);
      if (Array.isArray(v) ? v.length : (v != null && String(v).trim())) {
        // A single select shows its label in the box itself.
        if (!/multi/i.test(host.tagName) && String(el.value || '').trim()) return String(el.value).trim();
        const shown = [...(host.shadowRoot?.querySelectorAll('[class*="tag" i], [class*="chip" i], spl-tag, spl-chip') || [])].map((t) => text(t)).filter(Boolean).join(', ');
        return shown || text(host.shadowRoot || host) || String(v);
      }
    }
    // A COMBOBOX THAT IS NOT AN INPUT (Rippling's `div role="combobox"`) shows
    // its choice as its own text, and "Select..." until one is made.
    if (el.tagName && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
      const t = text(el);
      return /^(select|choose|pick)(\s+(one|an?\s+option|a\s+value))?\s*\.{0,3}$/i.test(t) ? '' : t;
    }

    let node = el.parentElement;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
      const shown = [...node.querySelectorAll(
        '[class*="singleValue"], [class*="single-value"], [class*="multiValue__label"], [class*="multi-value__label"]',
      )].map((n) => text(n)).filter(Boolean);
      if (shown.length) return shown.join(', ');
      if (node.querySelector('[class*="value-container"], [class*="valueContainer"], [class*="__placeholder"]')) {
        return '';   // a react-select with nothing chosen yet
      }
    }
    return (el.value || '').trim();
  }

  /**
   * Is this an ARIA combobox — a control where typing does not choose anything?
   *
   * Measured on a live Greenhouse form: Country, Degree, Gender, Veteran Status,
   * Disability Status and **"Are you legally authorized to work in the United
   * States?"** are all `role="combobox"` `class="select__input"`. Every one was
   * classified as a plain text box, typed into, and counted as filled. The text
   * appears on screen and react-select never commits it, so the form carried NO
   * answer to the work-authorisation question while the report said it did.
   *
   * The trap that makes this worth a comment: reading the value back does not
   * catch it. The input holds the typed text faithfully — it is react's state
   * that never heard about it — so a read-back check confirms the lie.
   */
  function isCombobox(el) {
    // PAYLOCITY'S MENUS HAVE NO ROLE (F-691): a plain text input with
    // aria-autocomplete="list" inside a box that owns the listbox. Read as a
    // text box, "Washington" was typed into its search and thrown away.
    if (el.getAttribute('role') !== 'combobox') {
      return el.tagName === 'INPUT' && el.getAttribute('aria-autocomplete') === 'list' && !!el.closest('[aria-haspopup="listbox"]');
    }
    return el.getAttribute('aria-autocomplete') === 'list' || el.hasAttribute('aria-expanded');
  }

  /**
   * Workday's "nothing chosen yet" text. It is a PLACEHOLDER, not an answer.
   *
   * The Playwright driver has stripped it since jarvis/apply/workday.mjs:146;
   * this file did not, and the cost was silent. `apply-plan.mjs:305` reads a
   * non-empty `current` as "already set" and plans `skip` — so an untouched
   * required dropdown was planned as done and never reached the list of things
   * left for him. Measured on a live Jabil step: four required questions, and
   * the report named one.
   */
  const PLACEHOLDER_RE = /^(select one|select a value)$/i;

  /**
   * The trigger button of a Workday prompt inside `wrap`, or null.
   *
   * AT PARITY WITH jarvis/apply/workday.mjs:549-550 AND :758-761, deliberately.
   * The driver recognises four widget markers plus two fallbacks; this file
   * recognised three markers and no fallback, so `promptIcon`,
   * `data-uxi-widget-type="selectinput"`, `aria-haspopup="menu"` and a bare
   * "Select One" button all came back as ordinary TEXT — and a prompt read as
   * text gets prose typed into the opaque id behind it, which is the exact
   * damage the note below describes.
   *
   * Precedence is unchanged from the version that only matched three literal
   * aria-haspopup values: a popup button wins first, so a multi-select wrapper
   * that also carries one is still driven as a single prompt. Only BELOW that
   * does the multi guard bite, and it has to — a chip's delete control is a
   * `<button>` inside the wrapper and must never be taken for a trigger.
   */
  const PROMPT_MARKER = '[data-automation-id="promptIcon"], [data-uxi-widget-type="selectinput"]';

  /**
   * A TRIGGER IS NEVER THE THING THAT SENDS THE APPLICATION.
   *
   * The wrapper pass clicks whatever `promptButton` returns, and two of its
   * three paths fall back to a `<button>` chosen by position. `wouldSubmit`
   * cannot be the test here: a bare `<button>` inside a `<form>` has
   * `type === 'submit'` by default, so it would reject the very Degree /
   * Field-of-Study widget the fallback exists for.
   *
   * What CAN be tested is what the control says and what Workday calls it. A
   * button reading Submit, Save and Continue, Next or Review is his, always,
   * whatever wrapper it happens to sit in.
   */
  const NAV_ID_RE = /pageFooterNextButton|bottom-navigation-next-button|navigation-button/i;
  function isTriggerButton(b) {
    if (!b) return false;
    if (NAV_ID_RE.test(b.getAttribute('data-automation-id') || '')) return false;
    const sub = here()?.submit;
    if (sub && matchesAny(b, sub)) return false;
    const t = text(b);
    return !SUBMIT_RE.test(t) && !FINAL_RE.test(t) && !NEXT_RE.test(t);
  }

  function promptButton(wrap) {
    if (!wrap) return null;
    const popup = wrap.querySelector('button[aria-haspopup]');
    if (popup) return isTriggerButton(popup) ? popup : null;
    if (wrap.querySelector('[data-automation-id="multiSelectContainer"]')) return null;
    const buttons = [...wrap.querySelectorAll('button')].filter(isTriggerButton);
    if (wrap.querySelector(PROMPT_MARKER)) return buttons[0] || null;
    // Degree and Field of Study render as a bare "Select One" button with a
    // decoy text input beside it — workday.mjs:758-761 says so in as many words.
    return buttons.find((b) => PLACEHOLDER_RE.test(text(b))) || null;
  }

  function promptOf(el) {
    if (el.tagName !== 'INPUT' || (el.type && !['text', 'hidden', ''].includes(el.type.toLowerCase()))) return null;
    const wrap = el.closest('[data-automation-id^="formField-"]');
    if (!wrap) {
      // Not Workday. An ARIA combobox is still a pick-from-a-list control and
      // must never be typed into and called done.
      if (isCombobox(el)) return { kind: 'combo', button: null, current: comboValue(el) };
      return null;
    }

    // Read off a live GlobalFoundries form, Workday ships TWO kinds:
    //
    //  single — `button[aria-haspopup=listbox]` over an input whose value is an
    //           opaque id ("bc33aa3152ec42d4995f4791a106ed"). Country, State and
    //           Phone Device Type. Usually already filled from his candidate
    //           profile, and typing over that id is what broke the step.
    //  multi  — a `multiSelectContainer` with a search input and a
    //           `selectedItemList` of chips. "How Did You Hear About Us?" and
    //           Country Phone Code. Both were EMPTY and both are required, which
    //           is why Save and Continue would not move.
    const button = promptButton(wrap);
    const multi = wrap.querySelector('[data-automation-id="multiSelectContainer"]');
    // Workday tenants ship ARIA comboboxes too, inside a formField wrapper with
    // neither a prompt button nor a multiSelectContainer. Falling straight to
    // null there put them back in the typed-into-and-called-done bucket.
    if (!button && !multi) return isCombobox(el) ? { kind: 'combo', button: null, current: comboValue(el) } : null;
    const selected = wrap.querySelector('[data-automation-id="selectedItemList"]');
    const shown = (text(button) || text(selected) || '').trim();
    return {
      kind: button ? 'single' : 'multi',
      button,
      current: PLACEHOLDER_RE.test(shown) ? '' : shown,
    };
  }

  /**
   * How many attachments the page already shows for this upload.
   *
   * Workday keeps the input itself empty after a successful upload (the file
   * has gone to the server), so `el.files.length` is 0 and is not the thing to
   * ask. What it DOES render is a delete control per attached file.
   */
  function attachedNear(el) {
    const scope = el.closest('[data-automation-id="file-upload"], section, form') || document;
    const chips = scope.querySelectorAll('[data-automation-id="delete-file"], [data-automation-id="file-preview"]');
    if (chips.length || el.files?.length) return chips.length || el.files.length;
    // A COMPONENT THAT TOOK THE FILE AND EMPTIED ITS INPUT (SmartRecruiters'
    // <spl-dropzone>, 2026-09-24) shows it in its own shadow root: a file name
    // and a "Delete file" control. Counted, so a second pass does not upload
    // on top of it.
    const host = el.getRootNode?.()?.host;
    const shown = host?.shadowRoot ? (host.shadowRoot.textContent || '') : '';
    const del = host?.shadowRoot?.querySelector('[aria-label*="delete" i], [aria-label*="remove" i]');
    return (del && /\.(pdf|docx?|rtf|odt|txt)\b/i.test(shown)) ? 1 : 0;
  }
  /**
   * A little of the wording around a control, for telling look-alikes apart.
   *
   * Ashby puts TWO resume inputs on one page: an optional "Autofill from resume"
   * parser and the real required attachment. Both are `type=file`, both accept
   * PDFs, and both label as "Resume". Only the surrounding words separate them.
   */
  function nearText(el) {
    const box = el.closest('section, fieldset, [class*="field"], div');
    return ((box?.parentElement || box)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  /**
   * THE INSTRUCTIONS AROUND A WRITTEN QUESTION, whole (2026-09-17).
   *
   * `nearText` cut everything to 90 characters, which is enough to spot an
   * "Autofill from resume" parser and nowhere near enough for "Please keep your
   * cover letter under 200 words and tell us why you want to build robots that
   * build solar farms" — so the writer never saw the form's own instructions or
   * its word limit. This reads what the page ties to the box: aria-describedby
   * first, then the text of the question's own wrapper with the box's value
   * taken out.
   */
  function helpText(el) {
    const tree = el.getRootNode();
    const described = String(el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .map((id) => plainText(tree.getElementById?.(id) || document.getElementById(id))).join(' ');
    const box = el.closest('[data-automation-id^="formField-"], fieldset, .application-question, [class*="question"], [class*="field"], li, section')
      || el.parentElement?.parentElement || el.parentElement;
    let around = plainText(box);
    const value = String(el.value || '');
    if (value) around = around.split(value).join(' ');
    return `${described} ${around}`.replace(/\s+/g, ' ').trim().slice(0, 800);
  }

  function labelFor(el, type) {
    let label = '';
    // Workday's wrapper holds the real question ("Have you previously worked as
    // an Employee or Intern?"), while the input's own label is just the option
    // text ("Yes"). Take the wrapper first for anything inside one.
    const wdWrap = el.closest('[data-automation-id^="formField-"]');
    if (wdWrap) {
      const l = wdWrap.querySelector('label, legend');
      if (l && !l.contains(el)) label = plainText(l);
    }
    // The label is looked for in the TREE THE CONTROL IS IN — its shadow
    // root when it has one — never only in the document.
    const tree = el.getRootNode();
    if (!label && el.id) {
      const l = tree.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      // A label that is only a required mark is no label: a component whose
      // host was given no text still renders "<label>*</label>", and taking
      // it stopped the walk up to the host that does carry the name. A label
      // whose words come through a <slot> reads them from the slot.
      const lt = l ? [...l.querySelectorAll('slot')].map(slotText).join(' ') + ' ' + plainText(l) : '';
      if (l && lt.replace(/[*✱\s]/g, '')) label = lt;
    }
    // A LABEL THAT IS ONLY A REQUIRED MARK IS NO LABEL, on every path. The
    // consent box on SmartRecruiters' screening step is <label>*<input></label>
    // inside its component; `closest('label')` returned "*", which counted as
    // found, the walk to the host never ran, and the box was planned as a
    // question with no words (F-333).
    // "Select" / "Choose one" is a control's own word, not a question: Boom
    // Supersonic's searchable dropdown is aria-label="Select" (2026-09-25).
    const meaningful = (s) => /[^\s*✱:]/.test(String(s || '')) && !/^\s*(select|choose)\b[\s\w.…-]{0,12}$/i.test(String(s || ''));
    if (!meaningful(label)) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) label = lb.split(/\s+/).map((x) => plainText(tree.getElementById?.(x) || document.getElementById(x))).join(' ');
    }
    if (!meaningful(label)) label = el.getAttribute('aria-label') || '';
    if (!meaningful(label)) label = plainText(el.closest('label'));
    if (!meaningful(label)) {
      // WALK UP, don't stop at the first div.
      //
      // Lever's custom questions carry no id, no aria-label and no <label for>.
      // The question lives in a `.application-label` a few levels above, the
      // `name` is `cards[<uuid>][field3]`, and the placeholder reads "Type your
      // response". Stopping at `el.closest('div')` found nothing, so the
      // fallbacks below took the placeholder — and **"What are your salary
      // expectations?" was labelled "Type your response"** on a live Veeva
      // form, which no answer table can ever match. His profile answers that
      // question.
      label = '';
      let node = parentOf(el);
      // NEVER A LEVEL THAT HOLDS OTHER QUESTIONS (Breezy, 2026-09-24). Two
      // levels up from Breezy's name box is the whole <form>; once its resume
      // parse added work-history rows, the first "label"-classed thing in the
      // form was a date picker's "Start date" — and EVERY field on the page,
      // name, email, phone and a honeypot, was labelled "Start date" and
      // planned his start date. A label found at a level holding other
      // controls could belong to any of them, so the walk stops there.
      const othersIn = (n) => [...n.querySelectorAll('input:not([type="hidden"]), select, textarea')]
        .some((x) => x !== el && !(el.name && x.name === el.name) && !(el.type === 'radio' && x.type === 'radio'));
      for (let i = 0; node && i < 5 && !label; node = parentOf(node)) {
        if (node.querySelectorAll && othersIn(node)) break;
        // A WEB COMPONENT NAMES ITS FIELD ON THE HOST. SmartRecruiters'
        // <spl-input label="First name"> renders that attribute inside its
        // shadow root; the phone number's label sits two hosts up.
        if (node.tagName.includes('-')) {
          const own = (node.getAttribute('label') || node.getAttribute('aria-label') || '').trim();
          if (own.length > 1) { label = own; break; }
        }
        // `[slot*="label"]`: a web component's label arrives through a slot —
        // SmartRecruiters' consent box is <spl-checkbox><spl-typography-label
        // slot="label-content">You declare that you have read…</…>, and its
        // own <label> holds only the required mark (F-333).
        const l = [...node.querySelectorAll('label, .label, [class*="label"], [slot*="label"]')]
          .find((n) => !n.contains(el) && slotText(n).replace(/[*✱\s]/g, '').length > 2);
        if (l) label = slotText(l);
        // Stepping out of a shadow root is not a level of the page.
        if (node.parentElement) i += 1;
      }
      // THE QUESTION IN THE BLOCK BEFORE THE FIELD (Rippling, Boom Supersonic
      // 2026-09-25): "Please explain why you want to work at Boom…" is a <p>
      // in the sibling before `data-testid="field"`, with no label anywhere,
      // and its searchable dropdown sits eight levels inside. Only once the
      // walk above found NO label: Atomic Semi's "Ideal start date in office"
      // has a real <label> one level further up and help text ("This is an
      // in-office position.") in the sibling below it — read first, the help
      // text became the question.
      for (let n = type === 'file' ? null : parentOf(el), i = 0; n && i < 9 && !label; n = parentOf(n), i += 1) {
        if (n.querySelectorAll && othersIn(n)) break;
        const sib = n.previousElementSibling;
        if (!sib || sib.querySelector('input, select, textarea, [role="combobox"], [role="radio"], [role="checkbox"]')) continue;
        const first = (sib.innerText || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
        if (first.length > 3 && first.length <= 400) label = first;
      }
    }
    label = (label || '').replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
    // A MACHINE CODE AT THE END IS NOT PART OF THE QUESTION. Waymo's labels
    // carry <span>80aff57e</span> after the words ("First Name (required)
    // 0830c081", 2026-09-24) — a fresh hex token per field. Eight hex
    // characters with a digit in them; a real last word is never that.
    label = label.replace(/\s+(?=[0-9a-f]{8}$)(?=\S*\d)[0-9a-f]{8}$/, '').trim();

    // A DATE BOX NAMED FOR SOMETHING ELSE. Breezy's parsed work-history dates
    // carry placeholder="Company" (its own copy-paste), so they read as
    // "Company"; what they are is in the binding — ng-model
    // "candidatePosition.date_start" / "date_end" (2026-09-24).
    if ((type === 'date' || el.type === 'date') && !/date|from|to\b|start|end|since|until|when/i.test(label)) {
      const bind = ['ng-model', 'formcontrolname', 'v-model', 'data-field', 'name', 'id']
        .map((a) => el.getAttribute(a) || '').join(' ');
      if (/start|from|begin/i.test(bind)) label = 'Start date';
      else if (/end|to\b|until|finish/i.test(bind)) label = 'End date';
    }

    // A <select>'s wrapper text contains every option, so the fallback can
    // swallow the whole list — Lever's Race field read as "RaceSelect…Hispanic
    // or LatinoWhite (Not Hispanic or Latino)…", which matched the Hispanic rule
    // instead of the Race rule. Longest option first, or stripping the short one
    // guts the long one and leaves "(Not )" behind.
    if (el.tagName === 'SELECT') {
      const opts = [...el.options]
        .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((ot) => ot.length > 2)
        .sort((a, b) => b.length - a.length);
      for (const ot of opts) if (label.includes(ot)) label = label.split(ot).join(' ');
      label = label.replace(/\s+/g, ' ').replace(/[*✱:]\s*$/, '').trim();
    }
    // A file input's own label is often about the MECHANICS, not the purpose:
    // Workday's reads "Upload a file (5MB max)", which matches nothing, so the
    // planner would call it "a file upload that is not the resume" and refuse to
    // attach — the resume bug's second half. What names it is the section
    // heading above it ("Resume/CV/additional documents"), so put that in front.
    if (type === 'file') {
      // A NAMELESS upload is walked BEFORE it is called "Resume/CV". Dover
      // (2026-09-24) has two bare inputs: "Autofill from resume" (a parser)
      // and "Resume (optional)". Named first, both read as the resume, the
      // walk that tells a parser apart never ran, and the file went to the
      // parser.
      const nameless = !label;
      // A SLOT NAMED BY ITS BUTTON (Formlabs' Greenhouse embed, 2026-09-25).
      // The cover-letter slot and "If your portfolio is not available online,
      // please attach it here" were both read as "Attach", and the second was
      // listed as left for him under that one word. The question is the first
      // line above the button, at a level holding no other visible control.
      if (/^\s*(attach|upload|browse|choose\s+(a\s+)?file|select\s+(a\s+)?file|add\s+(a\s+)?file)\s*[*✱]?\s*$/i.test(label)) {
        const button = label.replace(/[*✱]/g, '').trim();
        const othersShown = (n) => [...n.querySelectorAll('input:not([type="hidden"]), select, textarea')]
          .some((x) => x !== el && x.type !== 'file' && x.getClientRects().length > 0);
        for (let node = parentOf(el), i = 0; node && i < 6; i += 1, node = parentOf(node)) {
          if (!node.querySelectorAll || othersShown(node) || node.querySelectorAll('input[type="file"]').length > 1) break;
          // Greenhouse puts "Dropbox", "Google Drive" and "Enter manually"
          // beside Attach; a control's own words are never the question.
          const controls = new Set([...node.querySelectorAll('button, a, [role="button"]')].map((b) => text(b).toLowerCase()).filter(Boolean));
          const lead = (node.innerText || '').split('\n').map((s) => s.trim())
            .find((s) => s && s.toLowerCase() !== button.toLowerCase() && !controls.has(s.toLowerCase())
              && !/^(accepted\s+file|file\s+types?|max(imum)?\s+file|or\s*$|drag|drop|enter\s+manually|dropbox|google\s+drive)/i.test(s));
          if (lead && lead.length <= 200) { label = `${lead.replace(/[*✱:]\s*$/, '').trim()} — ${button}`; break; }
        }
      }
      if (nameless) label = 'Resume/CV';
      if (nameless || !/resume|cv\b|curriculum/i.test(label)) {
        // Walk up to the NEAREST ancestor that contains a heading and use that
        // one, whatever it says. Measured on Workday, the "Resume/CV/additional
        // documents" heading is seven levels above the input, so a short walk
        // finds nothing — but a long walk that keeps looking for a heading it
        // LIKES would sail past a "Portfolio" heading to find a "Resume" one
        // further up, and put his resume in the portfolio slot. Nearest wins,
        // and if the nearest does not name a resume then this is not one.
        let node = parentOf(el);
        for (let i = 0; node && i < 12; i += 1, node = parentOf(node)) {
          // A SLOT WITH A NAME OF ITS OWN STOPS AT ITS OWN QUESTION. Ashby's
          // "Cover Letter" slot (Mariana Minerals, 2026-09-25) walked up to the
          // whole form, whose first line is "Autofill from resume", and was
          // skipped as the parser slot; the letter never went on.
          if (!nameless && node.querySelectorAll
            && [...node.querySelectorAll('input:not([type="hidden"]), select, textarea')].some((x) => x !== el && (x.type === 'file' || x.getClientRects().length > 0))) break;
          // A section that says "Resume *" in a label-like first line rather
          // than a heading: SmartRecruiters' <oc-resume-upload> (F-332), which
          // sits under the posting's own h1 and would otherwise be named by
          // it. Nearest wins here too, and a short line only.
          const lead = (node.innerText || '').trim().split('\n')[0].trim();
          // A slot that PARSES a file to autofill the form is not the resume
          // slot, however the file is named: SmartRecruiters' "Easy Apply —
          // choose a file to autocomplete your application" (F-352). Named
          // so, the planner refuses it.
          if (lead.length <= 40 && /easy apply|autocomplete|auto-?fill|prefill|apply with (?:a |your )?(?:resume|cv)/i.test(lead)) { label = `${lead.replace(/[*✱:]\s*$/, '').trim()} — ${label}`; break; }
          if (lead.length <= 40 && /resume|cv\b|curriculum/i.test(lead)) { label = `${lead.replace(/[*✱:]\s*$/, '').trim()} — ${label}`; break; }
          const heading = [...node.querySelectorAll('h1, h2, h3, h4, legend')].map((h) => text(h)).filter(Boolean)[0];
          if (!heading) continue;
          if (/resume|cv\b|curriculum|document/i.test(heading)) label = `${heading} — ${label}`;
          break;
        }
      }
    }

    // Radios and checkboxes carry their OPTION text as a label ("Male", "Yes").
    // The QUESTION lives on the group, and finding it is the whole game: without
    // it, twelve radio groups on a live Applied Materials form went unanswered,
    // including "Are you legally authorized to work in the United States?".
    //
    // BUT ONLY WHEN THE LABEL REALLY IS AN OPTION WORD. Measured on a live
    // Micron (Eightfold) form: a checkbox whose own `<label for>` reads "Save
    // my answers for future applications." was prefixed with a swallowed page
    // section and came back as
    //
    //   "Application questions Application questionsMy InformationCountry of
    //    ResidenceHave you previously been employed by any Micron Company?YesNo
    //    — Save my answers for future applications."
    //
    // A label that is already a full sentence needs no question in front of it;
    // hunting for one can only make it worse. The length gate is what tells the
    // two cases apart, and it is the same distinction the comment above draws.
    // …but only for a control that stands alone. A long OPTION in a group is
    // still an option: Capstan Medical's "Yes - I'm attending our pursuing
    // higher education currently" (Lever, 2026-09-26) became the question, and
    // "Are you currently enrolled in … a Bachelor's, Master's, or Doctoral
    // degree?" above it was never read.
    const grouped = el.name && (el.getRootNode().querySelectorAll?.(`input[type="${type}"][name="${CSS.escape(el.name)}"]`) || []).length > 1;
    if ((type === 'radio' || type === 'checkbox') && label.trim().length > 24 && !grouped) {
      return label;
    }
    if (type === 'radio' || type === 'checkbox') {
      let group = plainText(el.closest('fieldset')?.querySelector('legend'))
        || (() => {
          // `[role=group]` and a plain aria-labelled fieldset matter as much as
          // radiogroup: GlobalFoundries' Workday labels "Have you previously
          // worked as an Employee or Intern?" that way, and looking only for
          // radiogroup left both options labelled "Yes" and "No".
          const g = el.closest('[role="radiogroup"], [role="group"], fieldset');
          if (!g) return '';
          const lb = g.getAttribute('aria-labelledby');
          return (lb ? plainText(document.getElementById(lb)) : '')
            || g.getAttribute('aria-label') || '';
        })();

      // Neither exists on Eightfold, and Applied Materials wraps all twelve
      // questions in ONE radiogroup labelled "Position Specific Questions", so a
      // group label can also be present and useless. Both cases walk for the
      // real question.
      const generic = /^(position specific|application|additional|screening|voluntary)?\s*questions?$/i;
      const gtxt = String(group || '').replace(/\s+/g, ' ').trim();
      if (!gtxt || generic.test(gtxt)) {
        const own = new Set([...(el.name
          ? document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`) : [el])]
          .map((r) => {
            const l = r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
            return ((l ? l.textContent : r.value) || '').replace(/\s+/g, ' ').trim().toLowerCase();
          }).filter(Boolean));
        let node = el.parentElement;
        let hops = 0;
        while (node && hops++ < 6) {
          // The question sits directly ABOVE its options. Searching descendants
          // finds the section heading; searching children finds the option rows.
          // Preceding siblings are where the question actually is.
          let cand = '';
          for (let sib = node.previousElementSibling; sib && !cand; sib = sib.previousElementSibling) {
            // A <style> above the options is not the question (Spirit's
            // "#remainderSection{background-color:white;…}", 2026-10-02).
            if (/^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE|LINK|META)$/.test(sib.tagName)) continue;
            const t = plainText(sib).replace(/\s+/g, ' ').trim();
            // A short question is still a question when it is written as one
            // — a <label>, <legend> or heading of its own ("Pronouns", on
            // Lever, F-346); a stray short line of prose is not.
            const asked = /^(LABEL|LEGEND|H[1-6]|DT)$/.test(sib.tagName) || sib.getAttribute('role') === 'heading';
            if ((t.length > 12 || (asked && t.length > 3)) && t.length < 400 && !own.has(t.toLowerCase())
              && !generic.test(t)) cand = t;
          }
          if (cand) { group = cand; break; }
          node = node.parentElement;
        }
        // THE GROUP'S NAME, as a last resort: Lever's pronoun boxes share
        // name="pronouns" and nothing above them survives the filters, so
        // the field was listed for him as "He/him" — its first option.
        if (!group && /^[a-z][a-z_ -]{2,40}$/i.test(el.name || '') && !/^(q|question|field|input|option|choice|answer)s?[-_ ]?\d*$/i.test(el.name)) {
          const n = el.name.replace(/[_-]+/g, ' ').trim();
          group = n.charAt(0).toUpperCase() + n.slice(1);
        }
      }
      const gt = (group || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      // Workday carries the question on the formField wrapper AND on the group,
      // so a naive prefix produced "…please continue.* — …please continue." —
      // the same sentence twice, differing only by a required-marker asterisk.
      // Compare stripped of punctuation before deciding it is new information.
      const bare = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (gt && !bare(label).includes(bare(gt))) label = `${gt} — ${label}`;
    }

    if (label) return label;

    // A PLACEHOLDER THAT SAYS NOTHING IS NOT A LABEL. "Type your response" is
    // an instruction, and using it as the question guarantees the field can
    // never be answered — worse, it looks like a real label in the report, so
    // the gap reads as "we have no answer" rather than "we never read it".
    const ph = el.getAttribute('placeholder')?.trim() || '';
    if (ph && !/^(type|enter|write|your|select|choose|please|e\.?g\.?|start typing)\b/i.test(ph)) return ph;

    // A BOX UNDER A HEADING OF ITS OWN is named by the heading. Breezy's
    // summary and cover letter are bare <textarea name="cSummary"> /
    // "cCoverLetter" under "<h3>Summary</h3>" / "<h3>Cover Letter</h3>"
    // (2026-09-24), and were reported by their internal names. Only a heading
    // with no other control between it and the box.
    heading: for (let n = el, i = 0; n && i < 4; i += 1, n = n.parentElement) {
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.querySelector?.('input:not([type="hidden"]), select, textarea')) break heading;
        const h = s.matches?.('h1, h2, h3, h4, h5, legend') ? s : s.querySelector?.('h1, h2, h3, h4, h5, legend');
        const t = h ? text(h).replace(/[*✱:]\s*$/, '').trim() : '';
        if (t && t.length <= 60) return t;
        // …or by a QUESTION written above it in plain text. Rippling's custom
        // short answers are <p>What is your salary expectation?</p> over a box
        // with no label, no placeholder and a random name (Cintal,
        // 2026-09-24), and were reported as "o8tr6xgz5N". Only a line that
        // asks something, so a stray paragraph never names a field.
        const q = h ? '' : text(s).replace(/[*✱]\s*$/, '').trim();
        if (q && q.length <= 300 && /\?$/.test(q)) return q;
        // …or by a SHORT LINE directly above it, written as a plain <div>:
        // Dover's "First Name *", "Phone Number" (2026-09-24) — the form had
        // no <label> anywhere and every box was reported by its internal
        // name. The nearest sibling only, one line, no control inside it.
        if (!h && s === n.previousElementSibling) {
          const line = text(s).replace(/[*✱:]\s*$/, '').replace(/[*✱]\s*$/, '').trim();
          if (line && line.length <= 80 && !/\n/.test(s.innerText || '')) return line;
        }
      }
    }

    // Nor is a machine-generated name. Lever writes `cards[<uuid>][field5]`;
    // reporting that back to him as the question is noise dressed as a label.
    // Rippling writes a fresh random token per load ("WgaoKnKViAz",
    // "0Dq0 u2aLhP"), which reads as a different unanswerable question on
    // every visit: a name that flips case over and over is not words.
    const nm = el.getAttribute('name') || '';
    const flips = (nm.match(/[a-z](?=[A-Z])|[A-Z](?=[a-z])|[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) || []).length;
    if (nm && !/[[\]]|[0-9a-f]{8}-[0-9a-f]{4}/i.test(nm) && flips < 5) return nm.replace(/[_-]+/g, ' ').trim();

    return '';
  }

  /** Radios and checkboxes that share a name are ONE question, not several. */
  /**
   * ASHBY'S CHECKBOX GROUPS (Base Power, 2026-09-25). Each box of "How did you
   * hear about Base Power Company?" is NAMED after its own option, so the
   * name-grouping below made every option its own question — the question was
   * lost, "LinkedIn" met the LinkedIn-profile rule and stayed unticked. The
   * boxes share an id prefix (`<question>-labeled-checkbox-N`), and the
   * question is the fieldset's first <label>.
   */
  // …and its radio groups the same way ("How did you hear about Eight
  // Sleep?" came through labelled by its first option, 2026-09-25).
  const ASHBY_GROUP_RE = /^(.+)-labeled-(?:checkbox|radio)-\d+$/;
  function ashbyGroupQuestion(el) {
    if (!ASHBY_GROUP_RE.test(String(el?.id || ''))) return '';
    const q = el.closest('fieldset')?.firstElementChild;
    return q && q.tagName === 'LABEL' ? text(q) : '';
  }
  function groupKey(el) {
    if (el.type !== 'radio' && el.type !== 'checkbox') return null;
    const ashby = String(el.id || '').match(ASHBY_GROUP_RE);
    if (ashby) return `${el.type}:ashby:${ashby[1]}`;
    // A shared `name` is the usual grouping. Workday sometimes omits it and
    // relies on the formField wrapper instead, and without this fallback each
    // option of one question became a separate unanswerable field.
    if (el.name) return `${el.type}:${el.name}`;
    const k = fieldKey(el);
    return k ? `${el.type}:${k}` : null;
  }

  /** The option text for one radio or checkbox, without the question prefix. */
  // ASHBY'S YES/NO (2026-09-25). A yes-or-no question there is two buttons,
  // "Yes" and "No", over a hidden checkbox. Read as that checkbox it arrived
  // with the single option "YesNo", so "Do you now, or in the future, require
  // visa sponsorship?" was planned as a bare tick on Mariana Minerals' form and
  // ended cleared. The buttons are the question's options.
  function yesNoButtons(el) {
    if ((el.type || '').toLowerCase() !== 'checkbox') return null;
    for (let n = el.parentElement, i = 0; n && i < 4; n = n.parentElement, i += 1) {
      // Never a level that holds another question: a plain consent box beside
      // a Yes/No would borrow its buttons.
      if ([...n.querySelectorAll('input, select, textarea')].some((x) => x !== el)) return null;
      const bs = [...n.querySelectorAll('button')];
      if (!bs.length) continue;
      const yes = bs.find((b) => /^\s*yes\s*$/i.test(b.textContent || ''));
      const no = bs.find((b) => /^\s*no\s*$/i.test(b.textContent || ''));
      return bs.length === 2 && yes && no ? [yes, no] : null;
    }
    return null;
  }

  function optionText(el) {
    const l = el.id && el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return text(l) || el.value || '';
  }

  /**
   * Is this control part of the SITE, not the application?
   *
   * PORTED FROM `SITE_FURNITURE_SRC` in jarvis/apply/_form.mjs, patterns and
   * structure identical. The Playwright driver has had this for months; the
   * extension never did.
   *
   * Measured on a live Amazon posting — three of which are in his queue right
   * now: the page carries 21 controls, and the only two the reader called
   * application fields were **Amazon's own job search bar**, "Search for jobs
   * by title or keyword" and "search job by location". Clicking the extension
   * there would have typed his details into a job search box.
   *
   * Two tiers, because one rule could not be both safe and sufficient. Tier 1
   * is plain substrings that never name a real application field. Tier 2 is
   * words that DO appear inside real forms, so they must stand alone as a
   * token — "search" anchored that way will not match a react-select's own
   * `select__search` input, which is a genuine control on Greenhouse and Ashby.
   *
   * The form boundary matters more than any name: skipping a REAL field is the
   * expensive direction, because an unfilled field looks exactly like a filled
   * one in the report.
   */
  const FURNITURE_ANY = /savesearch|save-search|jobalert|job-alert|jobsearch|job-search|searchbox|searchform|searchbar|searchinput|searchwrapper|searchcontainer|searchresults|search-form|search-container|search-field|search-?typeahead|typeahead-?search|search-?autocomplete|autocomplete-?search|jobs?-?autocomplete|autocomplete-?jobs?|talentcommunity|talent-community|subscribe|newsletter|cookie|consent-|-consent|masthead|skiplink|skip-link/i;
  // "autocomplete" and "typeahead" are no longer tokens on their own (F-337):
  // SmartRecruiters' City and "How did you find out" are <spl-autocomplete>
  // components with "c-spl-autocomplete-…" classes on every ancestor, and the
  // bare token made both of them site furniture — never discovered, never
  // filled, never reported. A job-search typeahead still reads as furniture
  // through the compound forms in FURNITURE_ANY above.
  const FURNITURE_TOKEN = /(^|[-_ ])(search|alert|alerts|chat)([-_ ]|$)/i;

  /**
   * A JOB-SEARCH PANEL, BY ITS OWN NAMES (F-384).
   *
   * SuccessFactors' career site (Zimmer Biomet, measured 2026-09-06) numbers
   * its ids — "36:", "40:", "41:" — and carries no telling class, so the id
   * and class rules above saw nothing. Its search panel came back as an
   * application: "Keywords", "Keyword search options — Exact Match", "in job
   * title", "Requisition ID" were all reported as things left for HIM to
   * answer on a page that is a search box.
   *
   * The control's `name` is the thing that gives it away there (keyword,
   * kwopt, reqnumber), so names are read too. Deliberately narrow: these are
   * words no application question uses.
   */
  const FURNITURE_NAME = /^(?:keyword|keywords|kwopt|reqnumber|requisition_?id|jobreqid|radius|distance|sortby|sort_?order|pagesize|facet)/i;
  /** …and by what the label says, for a panel whose names are numbered too. */
  const FURNITURE_LABEL = /^\s*keywords?\s*$|^\s*keyword search options\b|^\s*search (?:jobs|openings|by)\b|^\s*requisition id\s*$|^\s*(?:sort by|results per page|search radius|distance)\s*$|^\s*subscribe\b|\bnews\s*(?:&|and)\s*updates\b/i;
  // A SITE'S OWN SEARCH BOX is named `q` (Swisslog's careers page, 2026-09-25:
  // "q" and "Subscribe for news & updates" were the two things "left for you"
  // on a page with no application on it). The WHOLE name, never a prefix —
  // "question_12" is a real field.
  const FURNITURE_EXACT_NAME = /^(?:q|s|query|search|searchterm|search_term)$/i;

  /**
   * A BOT TRAP (F-388). Workday's Create Account page carries
   * `<input name="website" data-automation-id="beecatcher">` whose label reads
   * "Enter website. This input is for robots only, do not enter if you're
   * human." Measured live on HP's tenant (2026-09-07) it was discovered,
   * planned, and reported to him as the one thing left for him to fill — on a
   * field whose entire purpose is that nothing but a bot touches it.
   *
   * Filling one is worse than useless: it is the signal that gets an
   * application binned. Named by what these fields call themselves and by what
   * their labels say.
   */
  const HONEYPOT_ATTR = /beecatcher|honey-?pot|bot-?field|bot-?trap|anti-?bot|hp-?field|leave-?blank/i;
  const HONEYPOT_TEXT = /for robots only|do not (?:enter|fill)[^.]{0,30}human|if you(?:'| a)?re human|leave (?:this|it) (?:field )?blank|spam ?(?:protection|trap)/i;
  function isHoneypot(el) {
    if (!el) return false;
    const attrs = `${el.getAttribute?.('data-automation-id') || ''} ${el.name || ''} ${el.id || ''} ${(typeof el.className === 'string' ? el.className : '')} ${el.getAttribute?.('aria-label') || ''}`;
    if (HONEYPOT_ATTR.test(attrs)) return true;
    // Breezy's "hp_7f2b" (2026-09-24): named hp_<hash>, in an aria-hidden box
    // at left:-9999px with tabindex -1 — invisible to a person.
    if (el.type !== 'file') {
      if (/(^|[\s_-])hp[_-][0-9a-z]{2,}\b/i.test(`${el.name || ''} ${el.id || ''}`)) return true;
      try {
        if (el.closest?.('[aria-hidden="true"]') && el.getAttribute?.('tabindex') === '-1') return true;
        // Page coordinates, not the viewport's: a field scrolled out of view
        // above is still a field.
        const r = el.getBoundingClientRect?.();
        if (r && (r.right + window.scrollX < -500 || r.bottom + window.scrollY < -500)) return true;
      } catch { /* not measurable — judged by its words below */ }
    }
    if (HONEYPOT_TEXT.test(el.getAttribute?.('aria-label') || '')) return true;
    return HONEYPOT_TEXT.test(labelFor(el, (el.type || 'text').toLowerCase()) || '');
  }

  function siteFurniture(el) {
    if (isHoneypot(el)) return true;
    const named = (n) => {
      const id = n.id || '';
      const cls = (n.getAttribute && typeof n.getAttribute('class') === 'string') ? n.getAttribute('class') : '';
      const nm = (n.getAttribute && n.getAttribute('name')) || '';
      return FURNITURE_ANY.test(id) || FURNITURE_ANY.test(cls)
        || FURNITURE_TOKEN.test(id) || FURNITURE_TOKEN.test(cls)
        || (!!nm && (FURNITURE_ANY.test(nm) || FURNITURE_NAME.test(nm) || FURNITURE_EXACT_NAME.test(nm)));
    };
    // The control's own label, before anything else is asked about it.
    if (el && FURNITURE_LABEL.test((labelFor(el, el.type || 'text') || '').trim())) return true;

    // 1. Site chrome always wins, and is checked before anything else.
    let form = null;
    for (let n = el; n && n !== document.documentElement; n = parentOf(n)) {
      const tag = n.tagName;
      if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER') return true;
      if (n.getAttribute && n.getAttribute('role') === 'search') return true;
      // A web component's form is a form: SmartRecruiters' <spl-form> (F-337).
      if (tag === 'FORM' || /-FORM$/.test(tag)) { form = n; break; }
    }

    // 2. THE FORM BOUNDARY. Inside a real <form>, no name on the control can
    //    overrule the fact that it belongs to the application.
    // …UNLESS THE FORM SAYS WHAT IT IS. Waymo's posting page carries a second
    // <form> under "Job Alerts — Sign up to receive tailored job alerts"
    // (2026-09-24), with its own First Name, Email, Departments and
    // Locations; it was read as the application. Its heading is the only name
    // it has.
    if (form) {
      let box = form;
      for (let i = 0; box && i < 4; i += 1, box = box.parentElement) {
        // The NEAREST worded heading before the field — Waymo's alert form
        // opens with an empty <legend>, and a container two levels up can hold
        // both the alert form's heading and the application's.
        const h = [...(box.querySelectorAll?.('h1, h2, h3, h4, legend') || [])]
          .filter((x) => text(x) && (x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
          .pop();
        if (h && !h.contains(el)) {
          if (/^\s*(job\s+alerts?|get\s+job\s+alerts|talent\s+(community|network)|join\s+our\s+talent|newsletter|stay\s+(connected|in\s+touch))\b/i.test(text(h))) return true;
          break;
        }
      }
      return named(form);
    }

    // 3. No enclosing form, so judge by the names on the chain. <body> is not
    //    on it: its classes describe the PAGE. SmartRecruiters' chat widget
    //    sets "has-winston-chat-mobile-apply" there, and every control outside
    //    the form became furniture — Western Digital's privacy consent box was
    //    never discovered, ticked or reported (F-567, 2026-09-24).
    for (let n = el; n && n !== document.documentElement && n !== document.body; n = parentOf(n)) {
      if (named(n)) return true;
    }
    return false;
  }

  const visible = (el) => {
    // READONLY MEANS NOTHING ON A RADIO OR A CHECKBOX — the browser still
    // ticks it — and Eightfold marks every radio readonly. AMAT's whole
    // "Position Specific Questions" block (sponsorship, work authorization,
    // graduation status, degree, major, graduation term, relocation) was
    // dropped here, on every AMAT application, and never reported (F-694).
    if (el.disabled || (el.readOnly && !/^(radio|checkbox)$/i.test(el.type || ''))) return false;
    if (el.type === 'hidden') return false;
    // A SLIDER IS NEVER AN ANSWER. Eaton's Eightfold posting embeds a video
    // whose Seek and Volume are `input[type=range]`; they counted as two form
    // controls, which was enough to make the posting read as a form — so
    // Apply was never followed and the report listed "Volume" as a question
    // left for him. Measured live.
    if (el.type === 'range' || el.type === 'color') return false;
    // …but never the page itself: Modernizr writes its feature tests onto
    // <html> as classes — "video audio canvas …" — so every control on every
    // Modernizr page sat "inside a video player". ADP Workforce Now is one:
    // the signed-in Therm-X form read as 0 fields and a sign-in wall
    // (2026-10-16), and no ADP application ever filled a box.
    const mediaBox = el.closest('video, audio, [class*="player" i], [class*="video" i]');
    if (mediaBox && mediaBox !== document.documentElement && mediaBox !== document.body) return false;
    // AN OPEN CALENDAR'S OWN MONTH AND YEAR LISTS are its navigation, not
    // questions: Honda's react-datepicker popup came back as fields named
    // "<", "May 2026" and "2026" (2026-10-02). The date box itself stays.
    if (el.closest('.react-datepicker, .react-datepicker-popper')) return false;

    // A FILE INPUT IS EXEMPT FROM EVERY ONE OF THESE TESTS, and this check must
    // come FIRST. Getting that half-right is why he never once saw a resume.
    //
    // Workday renders the resume input as
    // `<input type=file data-automation-id="file-upload-input-ref">` with
    // `display: none` behind a "Select files" button. Greenhouse hides it with a
    // `visually-hidden` class. **Eightfold — Applied Materials, his single
    // biggest employer — marks it `aria-hidden="true"` AND `display: none`.**
    //
    // That last one matters twice over: the aria-hidden rule below was added an
    // hour before this line and would have excluded Eightfold's resume input,
    // silently reintroducing the exact bug it sits above. Assigning to `.files`
    // works on any of them; that is how the Playwright driver has always done it.
    if (el.type === 'file') return true;

    // `aria-hidden` means "this is not for a person", and for everything that is
    // not an upload it is telling the truth. Greenhouse's newer forms are built
    // on react-select, which renders a hidden sentinel input per dropdown to
    // carry HTML5 required-validation. Those were 15 of 54 unanswered questions
    // in a sweep of six live forms — more than a quarter of the list — and not
    // one was a question. They were noisy enough to hide the real gaps.
    if (el.getAttribute('aria-hidden') === 'true') return false;

    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    // A STYLED CHECKBOX OR RADIO HIDES ITS NATIVE INPUT — zero size, opacity
    // 0 — behind a drawn <label>: Oracle's "I agree with the terms and
    // conditions" on TI's email step (F-345) was read as invisible and never
    // ticked, and never listed. What a person sees is the label.
    if ((el.type === 'checkbox' || el.type === 'radio') && (r.width === 0 || r.height === 0 || s.opacity === '0')) {
      const label = el.labels?.[0] || el.closest('label')
        || (el.id ? el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (label && label.getClientRects().length > 0 && getComputedStyle(label).visibility !== 'hidden') return true;
    }
    if (r.width === 0 && r.height === 0) return false;
    return s.visibility !== 'hidden' && s.display !== 'none';
  };

  /** Everything on this page that could be part of an application. */
  /**
   * WORKDAY'S "MY EXPERIENCE" STEP: Work Experience, Education and Languages
   * are not fields, they are sections with an Add button that injects a
   * sub-form. The sub-form's fields carry stable data-automation-ids (the
   * same ones jarvis/apply/workday.mjs has driven for months); which section
   * an Add button belongs to is read from the nearest heading, never from its
   * position — tenants reorder and hide sections, and an off-by-one here
   * types a job title into a website field.
   *
   * Returned as SECTIONS, not fields: the server answers with the entries to
   * add (from his profile), and content.js adds and fills them. A section
   * that already holds a filled entry — a resumed draft, a tenant that parsed
   * the resume — is reported `filled` and left alone, so a second pass adds
   * nothing on top of his history.
   */
  const ENTRY_IDS = {
    work: ['formField-jobTitle', 'formField-title', 'formField-companyName', 'formField-company', 'formField-location', 'formField-roleDescription', 'formField-description', 'formField-currentlyWorkHere', 'currentlyWorkHere', 'formField-startDate', 'formField-endDate'],
    education: ['formField-schoolName', 'formField-school', 'formField-schoolItem', 'formField-degree', 'formField-fieldOfStudy', 'formField-fieldsOfStudy', 'formField-gradeAverage', 'formField-gpa', 'formField-firstYearAttended', 'formField-lastYearAttended'],
    language: ['formField-language', 'formField-languageName', 'formField-languageProficiency', 'formField-overallProficiency', 'formField-proficiency'],
    // Workday's "Websites" section (F-553): empty until Add is pressed, then one URL box.
    website: ['formField-url', 'formField-webAddress', 'formField-websiteUrl', 'formField-websiteURL'],
  };
  const ENTRY_PRIMARY = { work: ['formField-jobTitle', 'formField-title'], education: ['formField-schoolName', 'formField-school', 'formField-schoolItem'], language: ['formField-language', 'formField-languageName'], website: ['formField-url', 'formField-webAddress', 'formField-websiteUrl', 'formField-websiteURL'] };
  const ENTRY_SEL = Object.values(ENTRY_IDS).flat().map((id) => `[data-automation-id="${id}"]`).join(', ');
  // "Experience" alone is SmartRecruiters' heading for work history (F-341).
  const SECTION_RE = { work: /\b(?:work\s*)?experience\b|employment|work\s*history/i, education: /education/i, language: /language/i, website: /^\s*(?:add\s+)?websites?\b|\bwebsites?\s*$/i };
  /** What a button is called: its text, its aria-label, or its component host's. */
  const buttonName = (b) => {
    const host = b.getRootNode?.().host;
    // Each name once: Honda's Next says "Next" in its text AND its aria-label,
    // and "Next Next" matched no Next pattern — his presses there were never
    // logged as steps (2026-10-02).
    const names = [text(b), b.getAttribute('aria-label'), host?.getAttribute?.('aria-label'), host ? text(host) : '']
      .map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return [...new Map(names.map((s) => [s.toLowerCase(), s])).values()].join(' ').trim();
  };
  const insideEntry = (el) => !!el.closest?.(ENTRY_SEL);

  function headingAbove(el) {
    let node = el.parentElement;
    for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
      const h = node.querySelector('h1,h2,h3,h4,h5,legend,[role="heading"]');
      const t = (h?.textContent || '').trim();
      if (t) return t;
    }
    return '';
  }

  /**
   * THE QUESTION ABOVE A SPLIT DATE (Boom Supersonic's Rippling form,
   * 2026-09-25). Its three boxes label themselves "month", "day" and "year";
   * the question — "Please share your anticipated graduation date." — sits in
   * a wrapper above them. The nearest ancestor whose words are more than the
   * boxes' own slashes is where it is.
   */
  function splitDateQuestion(el) {
    let box = el;
    for (let i = 0; i < 14 && box; i += 1) {
      box = box.parentElement;
      const words = String(box?.textContent || '').replace(/\s+/g, ' ').trim();
      if (words.replace(/[\s/.-]+/g, '').replace(/^(mm|dd|yyyy|month|day|year)+$/i, '').length > 3) {
        return words.replace(/[\s/]+$/g, '').slice(0, 300);
      }
    }
    return '';
  }
  function datePartOf(el) {
    if (!el || el.tagName !== 'INPUT') return undefined;
    const s = [el.getAttribute('data-automation-id'), el.id, el.getAttribute('aria-label'), el.placeholder, el.name].filter(Boolean).join(' ');
    if (/dateSectionMonth|(^|[^a-z])month([^a-z]|$)|(^|\s)MM(\s|$)/i.test(s)) return 'month';
    if (/dateSectionDay|(^|[^a-z])day([^a-z]|$)|(^|\s)DD(\s|$)/i.test(s)) return 'day';
    if (/dateSectionYear|(^|[^a-z])year([^a-z]|$)|(^|\s)YYYY(\s|$)/i.test(s)) return 'year';
    return undefined;
  }

  function experienceSections() {
    const out = [];
    const adds = [...document.querySelectorAll('[data-automation-id="Add"], [data-automation-id="add-button"]')]
      .filter((b) => b.getClientRects().length > 0);
    for (const kind of Object.keys(ENTRY_IDS)) {
      const add = adds.find((b) => SECTION_RE[kind].test(headingAbove(b)));
      const panels = [...document.querySelectorAll(ENTRY_PRIMARY[kind].map((id) => `[data-automation-id="${id}"]`).join(', '))];
      if (!add && !panels.length) continue;
      const valueOf = (panel) => { const c = panel.querySelector('input, textarea'); return c ? String(c.value || '').trim() : ''; };
      const filled = panels.some((p) => valueOf(p) !== '');
      const blank = panels.length > 0 && valueOf(panels[panels.length - 1]) === '';
      out.push({ kind, label: add ? headingAbove(add) : kind, count: panels.length, filled, blank, hasAdd: !!add });
    }

    // ANY OTHER FORM WITH AN "ADD" NAMED FOR ITS SECTION (F-341). SmartRecruiters'
    // Experience and Education are <spl-button aria-label="Add experience
    // entry"> beside a heading that is a component, not an <h2>; there are no
    // Workday wrappers to count. The section is reported so the server plans
    // his entries; content.js fills the sub-form by its labels. "Filled" is
    // judged by whether the section already shows an entry's worth of text
    // beyond its heading, its Add and its boilerplate.
    const seen = new Set(out.map((s) => s.kind));
    const boiler = /\badd\b|fields marked with \*? ?are required\.?|i currently work here|cancel|save|\*/gi;
    for (const b of deepQuerySelectorAll('button, [role="button"]').filter(onScreen)) {
      const name = buttonName(b);
      if (!/\badd\b/i.test(name)) continue;
      const about = `${name} ${headingAbove(b)}`;
      const kind = Object.keys(SECTION_RE).find((k) => SECTION_RE[k].test(about) && !seen.has(k));
      if (!kind) continue;
      // The section: the nearest ancestor that names the section and is not the page.
      let section = parentOf(b);
      for (let d = 0; section && d < 8; d += 1) {
        const t = (section.innerText || '').trim();
        if (SECTION_RE[kind].test(t) && t.length < 4000) break;
        section = parentOf(section);
      }
      const body = ((section?.innerText || '').replace(SECTION_RE[kind], '').replace(boiler, '').replace(/\s+/g, ' ').trim());
      const filled = body.length > 12;
      seen.add(kind);
      out.push({ kind, label: name, count: filled ? 1 : 0, filled, blank: false, hasAdd: true, generic: true });
    }
    return out;
  }

  function discover() {
    const controls = allControls()
      .filter(visible)
      .filter((el) => !siteFurniture(el))
      // Entry sub-forms are driven by fillEntries, never by the generic
      // enumerator: "Company" inside a Work Experience panel is that job's
      // employer, not the answer to "current company". (The driver has the
      // same rule, for the same reason.)
      .filter((el) => !insideEntry(el))
      // A HONEYPOT IS FOR BOTS, and filling one flags the application as one.
      // Breezy's "hp_7f2b" sits in an aria-hidden box at left:-9999px with
      // tabindex -1 (2026-09-24) — invisible to a person, so never a question.
      .filter((el) => !isHoneypot(el));
    const fields = [];
    const seenGroup = new Map();

    for (const el of controls) {
      const type = el.tagName === 'SELECT' ? 'select'
        : el.tagName === 'TEXTAREA' ? 'text'
          : (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'image', 'reset'].includes(type)) continue;

      const gk = groupKey(el);
      if (gk && seenGroup.has(gk)) {
        // Another option of a question already recorded. Its OPTION text joins
        // the list; its label would repeat the question.
        const f = seenGroup.get(gk);
        f.options.push(optionText(el));
        f.elements.push(el);
        continue;
      }

      // The label carries the QUESTION (prefixed by labelFor for radios and
      // checkboxes); the options list carries the choices. Keeping those apart
      // is what lets the server match a question and then pick an option.
      // A Workday PROMPT is a button plus a hidden input whose value is an
      // opaque id like "bc33aa3152ec42d4995f4791a1". Typing into one replaces
      // that id with prose and breaks the field — measured live: writing into
      // the phone-code prompt produced "Enter a valid format for Phone Number"
      // and the step would not advance. They are driven by clicking, or left
      // alone when Workday has already filled them from his candidate profile.
      const prompt = promptOf(el);
      const yn = yesNoButtons(el);
      const ownLabel = ashbyGroupQuestion(el) || labelFor(el, type);
      const part = datePartOf(el);
      const field = {
        label: part && /^\s*(month|day|year|mm|dd|yyyy)\s*\*?\s*$/i.test(ownLabel || '') ? (splitDateQuestion(el) || ownLabel) : ownLabel,
        type: prompt ? 'prompt' : (type === 'radio' || yn ? 'radio' : type),
        name: el.name || '',
        // An id inside a shadow root is scoped to that root, so every
        // instance of a component carries the same one ("i", "file-input");
        // the plan's answers are matched back by id, and four fields called
        // "i" put City's answer in First name. Qualify it by the host.
        id: el.id ? (el.getRootNode().host ? `${hostName(el.getRootNode().host)}/${el.id}` : el.id) : '',
        key: fieldKey(el),
        current: prompt ? prompt.current : undefined,
        promptKind: prompt ? prompt.kind : undefined,
        // WHICH PART OF A SPLIT DATE (2026-09-24). Workday's signature date is
        // three boxes, month / day / year, all labelled "Date"; each was given
        // the whole "09/23/2026" on four applications in one night.
        datePart: part,
        // A CALENDAR PICKER'S TEXT BOX takes MM/DD/YYYY and nothing else
        // (Honda's react-datepicker, 2026-10-02); "May 2026" typed into it
        // parsed to nothing.
        ...(el.closest?.('.react-datepicker__input-container, .react-datepicker-wrapper') ? { picker: 'mdy' } : {}),
        // How many files are ALREADY on this upload. Resuming a Workday draft
        // once stacked three copies of the same PDF on a live application,
        // because nothing checked before attaching.
        attached: type === 'file' ? attachedNear(el) : undefined,
        required: el.required || el.getAttribute('aria-required') === 'true',
        // WHAT THE BOX WILL PHYSICALLY HOLD. A phone field capped at 10
        // characters silently truncated his number to a wrong one — caught only
        // because the filler reads the value back, so it was reported blank
        // rather than filed wrong. The planner can pick a shorter spelling of
        // the SAME number instead, but only if it is told the limit exists.
        maxLength: el.maxLength > 0 && el.maxLength < 524288 ? el.maxLength : undefined,
        // A BOX BUILT FOR PROSE SAYS SO.
        //
        // A <textarea> is reported with type "text", deliberately — every rule
        // in the answer table that matches a text field must match one. But
        // "tell us about a project you are proud of" and "First name" are then
        // indistinguishable, and the written questions fell through to
        // "no answer for this question" on every form that asked one. This
        // flag is the whole difference, and nothing but the essay writer
        // reads it.
        multiline: el.tagName === 'TEXTAREA' ? true : undefined,
        // Nearby wording, so an "Autofill from resume" parser can be told from
        // the real attachment slot — Ashby ships both, and they look alike.
        // For a written question it carries the help text and the word limit,
        // which is what decides how long the answer should be.
        near: el.tagName === 'TEXTAREA' ? helpText(el) : type === 'file' ? nearText(el) : undefined,
        // A one-line box's placeholder too when it is a DATE MASK ("mm/dd/yyyy",
        // BambooHR), so the answer can be written in that shape.
        placeholder: el.tagName === 'TEXTAREA' ? (el.getAttribute('placeholder') || '').trim().slice(0, 200) || undefined
          : (/^\s*(m{1,2}|d{1,2}|y{2,4})\s*[/.-]\s*(m{1,2}|d{1,2}|y{2,4})(\s*[/.-]\s*(m{1,2}|d{1,2}|y{2,4}))?\s*$|^\s*(pick|select|choose|enter)\s+(a\s+|the\s+)?date\b/i.test(el.getAttribute('placeholder') || '') ? el.getAttribute('placeholder').trim() : undefined),
        options: el.tagName === 'SELECT'
          ? [...el.options].map((o) => o.textContent.trim())
          : yn ? ['Yes', 'No']
            : (type === 'radio' || type === 'checkbox' ? [optionText(el)] : []),
        elements: yn || [el],
      };
      fields.push(field);
      if (gk) seenGroup.set(gk, field);
    }

    // ARIA RADIOS AND CHECKBOXES THAT ARE NOT INPUTS (F-334).
    //
    // SmartRecruiters' screening questions are <spl-radio role="radio"
    // aria-checked="false" label="Yes"> inside a <spl-radio-group> whose
    // question arrives through a slot; there is no <input> anywhere on the
    // step, so "Are you legally authorized to work in the USA without
    // sponsorship?" was never a question this reader saw (Becton Dickinson,
    // measured live 2026-09-04). A control is whatever answers the question.
    const shownAria = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      && el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('aria-disabled') !== 'true';
    const ariaGroupOf = (el) => {
      for (let n = parentOf(el), i = 0; n && i < 6 && n.nodeType === 1; n = parentOf(n), i += 1) {
        if (n.getAttribute('role') === 'radiogroup' || /radio-?group|radiogroup|checkbox-?group/i.test(n.tagName)) return n;
      }
      return el.parentElement || parentOf(el);
    };
    // AN EMPTY ANCHOR NAMED BY A LABEL BESIDE IT (TSMC's SuccessFactors form,
    // 2026-09-24). Its radios are `<a id="455:_anchor" role="radio">` with no
    // text of their own; "Yes", "2025", "Spring" sit in a label next to each.
    // Read as-is, nine questions arrived with options ["", "", ""] and a
    // "question" that was the first option's word, and not one was answered.
    const byId = (el, id) => (id ? (el.getRootNode().getElementById?.(id) || document.getElementById(id)) : null);
    const ariaOption = (el) => {
      const own = (el.getAttribute('label') || el.getAttribute('aria-label') || text(el) || '').trim();
      if (own) return own;
      const lb = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => text(byId(el, id))).filter(Boolean).join(' ');
      if (lb) return lb;
      const forId = el.id && [...(el.getRootNode().querySelectorAll?.('label[for]') || [])].find((l) => l.htmlFor === el.id || l.htmlFor === el.id.replace(/_anchor$/, ''));
      if (forId && text(forId)) return text(forId);
      // The next element beside it, when that is a short word and not another control.
      for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (sib.matches?.('[role="radio"], [role="checkbox"], input, select, textarea')) break;
        const t = text(sib);
        if (t) return t.length <= 80 ? t : '';
      }
      const up = el.parentElement;
      if (up && up.querySelectorAll('[role="radio"], [role="checkbox"]').length === 1) {
        const t = text(up);
        if (t && t.length <= 80) return t;
      }
      return (el.getAttribute('value') || '').trim();
    };
    const ariaQuestion = (group, optionTexts) => {
      const own = new Set(optionTexts.map((t) => t.toLowerCase()).filter(Boolean));
      // "2025 2026 2027" — the options on one line — is not a question either.
      const isOption = (t) => {
        const low = t.toLowerCase();
        if (own.has(low)) return true;
        let rest = ` ${low} `;
        for (const o of [...own].sort((a, b) => b.length - a.length)) rest = rest.split(` ${o} `).join(' ');
        return own.size > 1 && !rest.replace(/[\s|/,*]+/g, '');
      };
      const slot = [...group.querySelectorAll('[slot*="label"], legend, label, [class*="label"]')]
        .map((n) => text(n)).find((t) => t && !isOption(t));
      if (slot) return slot;
      const lb = group.getAttribute('aria-labelledby');
      const named = (lb ? text(byId(group, lb)) : '') || group.getAttribute('aria-label') || '';
      if (named.trim()) return named.trim();
      const inner = (group.innerText || '').split('\n').map((s) => s.trim()).find((s) => s && !isOption(s));
      if (inner) return inner;
      // EVERYTHING INSIDE THE GROUP IS AN OPTION, so the question is above it —
      // the preceding sibling, or its parent's, a few levels up.
      for (let node = group, hops = 0; node && hops < 5; node = node.parentElement, hops += 1) {
        for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
          if (sib.querySelector?.('[role="radio"], input, select, textarea')) break;
          const t = text(sib);
          if (t && t.length > 3 && t.length < 600 && !isOption(t)) return t;
        }
      }
      return '';
    };
    const ariaGroups = new Map();
    for (const el of deepQuerySelectorAll('[role="radio"], [role="checkbox"]')) {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) continue;
      if (!shownAria(el) || siteFurniture(el) || insideEntry(el)) continue;
      // The role on a wrapper of a real input is that input's, counted above.
      if (deepQuerySelectorAll('input', el).length) continue;
      const type = el.getAttribute('role');
      const option = ariaOption(el);
      const group = type === 'radio' ? ariaGroupOf(el) : null;
      if (group && ariaGroups.has(group)) {
        const f = ariaGroups.get(group);
        f.options.push(option);
        f.elements.push(el);
        f.label = (ariaQuestion(group, f.options) || f.label).replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
        continue;
      }
      const label = group ? ariaQuestion(group, [option]) : (option.length > 24 ? option : (labelFor(el, type) || option));
      const field = {
        label: label.replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim(),
        type,
        name: '',
        id: el.id ? (el.getRootNode().host ? `${hostName(el.getRootNode().host)}/${el.id}` : el.id) : '',
        key: fieldKey(el),
        current: undefined,
        promptKind: undefined,
        attached: undefined,
        required: el.getAttribute('aria-required') === 'true' || !!group?.hasAttribute?.('required') || group?.getAttribute?.('aria-required') === 'true',
        maxLength: undefined,
        near: undefined,
        options: [option],
        elements: [el],
        aria: true,
      };
      fields.push(field);
      if (group) ariaGroups.set(group, field);
    }

    // A COMBOBOX THAT IS A <div> (Rippling, 2026-09-24). Gender, veteran and
    // disability — and one required question — were `div role="combobox"`
    // named through aria-labelledby. Every pass here starts from an <input>,
    // so none of them reached the plan. The label is what aria-labelledby
    // points at; the choice, if any, is the div's own text.
    for (const el of deepQuerySelectorAll('[role="combobox"]')) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      if (!el.getClientRects().length || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.querySelector('input, select, textarea')) continue;
      if (siteFurniture(el) || insideEntry(el)) continue;
      // Not inside a web component: SmartRecruiters' <spl-…> widgets carry
      // their own inputs, already read above, and its phone country-code
      // picker taken here was cleared by the fill ("Illegal invocation",
      // Western Digital 2026-09-24). Nor a country-code picker anywhere.
      if (el.getRootNode() !== document) continue;
      if (/country\s*code|dial(l?ing)?\s*code|calling\s*code/i.test(`${el.getAttribute('aria-label') || ''} ${el.id || ''}`)) continue;
      const lb = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => text(byId(el, id))).filter(Boolean).join(' ');
      const aria = el.getAttribute('aria-label') || '';
      const named = lb || (/^(select|choose)\b/i.test(aria) ? '' : aria);
      let label = (named || labelFor(el, 'text') || '').replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
      // Named only "Select" (Rippling's one required dropdown): the question is above it.
      if (!label || /^(select|choose)\b.{0,12}$/i.test(label)) {
        label = (ariaQuestion(el.parentElement || el, [label, text(el), 'Select', 'Select...']) || '').replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
      }
      // …or in the block before its field wrapper, six levels up (Boom
      // Supersonic's custom dropdown, 2026-09-25): the first line of the
      // nearest earlier sibling that holds no control.
      if (!label || /^(select|choose)\b.{0,12}$/i.test(label)) {
        for (let n = el.parentElement, i = 0; n && i < 8; n = n.parentElement, i += 1) {
          if (n.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]').length > 1) break;
          const sib = n.previousElementSibling;
          if (!sib || sib.querySelector('input, select, textarea, [role="combobox"], [role="radio"], [role="checkbox"]')) continue;
          const first = (sib.innerText || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
          if (first.length > 3 && first.length <= 400) { label = first.replace(/[*✱]\s*$/, '').trim(); break; }
        }
      }
      if (!label || /^(select|choose)\b.{0,12}$/i.test(label)) continue;
      fields.push({
        label,
        type: 'prompt',
        name: '',
        id: el.id || '',
        key: fieldKey(el),
        current: comboValue(el) || undefined,
        promptKind: 'combo',
        attached: undefined,
        required: el.getAttribute('aria-required') === 'true',
        maxLength: undefined,
        near: undefined,
        options: [],
        elements: [el],
      });
    }

    // HIDDEN NATIVE INPUTS BEHIND STYLED BOXES (Rippling, 2026-09-24).
    //
    // Rippling's custom questions are real <input type="checkbox|radio"> with
    // `display: none`, each under a visible box reading "Yes" or "No". Neither
    // pass above sees them — the input has no box on screen, and the visible
    // box has no role — so a whole questionnaire reached the plan as nothing.
    // The visible box is the option: it is what gets clicked, its text is the
    // option's name, and the hidden input inside it says whether it took.
    const styledGroups = new Map();
    for (const input of deepQuerySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (input.getClientRects().length > 0 || input.disabled) continue;
      if (siteFurniture(input) || insideEntry(input)) continue;
      // ASHBY'S YES/NO lands here, not in the main pass: its checkbox is
      // hidden and has no id (the label's `for` names it by `name`). Read as a
      // styled box, the one box was the whole Yes/No container, so the option
      // came out "YesNo" (Mariana Minerals, measured live 2026-09-25).
      const yn = yesNoButtons(input);
      if (yn) {
        const entry = yn[0].parentElement?.parentElement || yn[0].parentElement;
        const named = input.name && entry?.querySelector(`label[for="${CSS.escape(input.name)}"]`);
        const label = (named ? text(named) : '') || (entry ? ariaQuestion(entry, ['Yes', 'No']) : '');
        if (label) {
          fields.push({
            label: label.replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim(),
            type: 'radio', name: input.name || '', id: input.id || '', key: '',
            current: undefined, promptKind: undefined, attached: undefined,
            required: input.required || !!entry?.querySelector('label[class*="required"]'),
            maxLength: undefined, near: undefined,
            options: ['Yes', 'No'], elements: yn, aria: true,
          });
        }
        continue;
      }
      let box = input.parentElement;
      for (let d = 0; box && d < 4; d += 1, box = box.parentElement) {
        if (box.getClientRects().length > 0 && box.querySelectorAll('input[type="radio"], input[type="checkbox"]').length === 1 && text(box)) break;
      }
      if (!box || !box.getClientRects().length || !text(box) || text(box).length > 120) continue;
      const gk = `${input.type}|${input.name || ''}`;
      if (!input.name) continue;
      if (!styledGroups.has(gk)) styledGroups.set(gk, { type: input.type, boxes: [], inputs: [] });
      const g = styledGroups.get(gk);
      g.boxes.push(box); g.inputs.push(input);
    }
    for (const g of styledGroups.values()) {
      const options = g.boxes.map((b) => text(b));
      // The container every option sits in; the question is read from it or above it.
      let wrap = g.boxes[0].parentElement;
      while (wrap && !g.boxes.every((b) => wrap.contains(b))) wrap = wrap.parentElement;
      const label = wrap ? ariaQuestion(wrap, options) : '';
      if (!label) continue;
      fields.push({
        label: label.replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim(),
        type: g.type,
        name: g.inputs[0].name,
        id: g.inputs[0].id || '',
        key: '',
        current: undefined,
        promptKind: undefined,
        attached: undefined,
        required: g.inputs.some((i) => i.required) || /\*\s*$/.test(label),
        maxLength: undefined,
        near: undefined,
        options,
        elements: g.boxes,
        aria: true,
      });
    }

    // ── the wrapper pass ────────────────────────────────────────────────
    //
    // A WORKDAY DROPDOWN CAN HAVE NO NATIVE CONTROL AT ALL, and the loop above
    // can never reach one. It enumerates `input, select, textarea`; a Workday
    // questionnaire renders some questions as a `formField-` wrapper holding a
    // label and a `<button>Select One</button>` and nothing else.
    //
    // Measured on a live Jabil Application Questions step: four required
    // questions — the age-18 question, work authorisation, prior experience at
    // the company, and visa sponsorship — produced ZERO fields. The page had
    // two ordinary inputs, both were filled, and the report said one thing was
    // left for him while Save and Continue refused to move on four errors.
    //
    // Widening the selector to include `button` does not work: a bare
    // `<button>`'s `.type` is 'submit', so the guard a few lines above drops it.
    // The wrappers have to be asked directly, which is what
    // jarvis/apply/workday.mjs:484-485 has always done — the Playwright driver
    // has never hit this bug because it enumerates wrappers, not controls.
    //
    // The guard is "no VISIBLE native control", not "no native control", and
    // that is load-bearing: it also picks up the button-plus-hidden-input shape,
    // which `visible()` rejects at the filter above before `promptOf` — whose
    // own `'hidden'` case was therefore unreachable — gets a chance to see it.
    for (const wrap of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      const key = wrap.getAttribute('data-automation-id');
      // THIS WRAPPER, not this key (F-670): every added language row repeats
      // the first row's keys, and a key already seen skipped row 2's Reading,
      // Speaking and Writing — Flowserve refused the step on all three.
      if (fields.some((f) => (f.elements || []).some((e) => wrap.contains(e)))) continue;
      if ([...wrap.querySelectorAll('input, select, textarea')].some(visible)) continue;
      const btn = promptButton(wrap);
      if (!btn || !visible(btn) || siteFurniture(btn)) continue;

      // Read the asterisk BEFORE labelFor strips it — that is the only signal
      // some tenants give that a question is required.
      const rawLabel = wrap.querySelector('label, legend')?.textContent || '';
      const selected = wrap.querySelector('[data-automation-id="selectedItemList"]');
      const shown = (text(btn) || text(selected) || '').trim();
      fields.push({
        label: labelFor(btn, 'button'),
        type: 'prompt',
        name: '',
        id: btn.id || '',
        key,
        current: PLACEHOLDER_RE.test(shown) ? '' : shown,
        promptKind: wrap.querySelector('[data-automation-id="multiSelectContainer"]') ? 'multi' : 'single',
        required: btn.getAttribute('aria-required') === 'true'
          || wrap.getAttribute('aria-required') === 'true'
          || /[*✱]\s*$/.test(rawLabel.replace(/\s+$/, '')),
        options: [],
        // EXACTLY ONE NODE, AND IT MUST BE THE TRIGGER BUTTON. content.js reads
        // `aria-controls` off elements[0] to scope the option rows to this
        // widget's own listbox; anything else there falls back to a
        // document-wide query, which is the bug that clicked another field's
        // option on a live Micron form.
        elements: [btn],
      });
    }
    // ICON FALLBACK TEXT IS NOT PART OF A LABEL, whichever path read it
    // (Workable's resume slot, 2026-09-24).
    for (const f of fields) {
      if (typeof f.label === 'string') f.label = f.label.replace(/SVGs? (are )?not supported by (this|your) browser\.?/gi, ' ').replace(/\s+/g, ' ').trim();
    }
    // A DATE PICKER'S OWN BOX IS NOT A QUESTION (Rippling, Boom Supersonic
    // 2026-09-25): typing a graduation month opened a calendar whose inner
    // input read "//September2026SMTWTFS1234…TodayClear", and it was listed as
    // a required question left for him. A label holding a week's day letters
    // in a row is a calendar grid.
    // A MONTH LIST AND THE YEAR LIST AFTER IT ARE ONE DATE (Ashby's education
    // history, Applied Intuition 2026-09-25): "Start Date" named only the
    // month <select>, the year beside it had no name at all, and the month
    // was planned as a whole date ("this box wants a full date"). Named as
    // the halves they are, the education-date rules answer both.
    const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
    const count = (f, re) => (f.options || []).filter((o) => re.test(String(o?.text ?? o).trim())).length;
    for (let i = 0; i + 1 < fields.length; i += 1) {
      const m = fields[i], y = fields[i + 1];
      // The year list is unnamed, or named the same as the month beside it.
      if (m.type !== 'select' || y.type !== 'select' || (String(y.label || '').trim() && y.label !== m.label)) continue;
      if (count(m, MONTHS) < 10 || count(y, /^(19|20)\d{2}$/) < 5 || !String(m.label || '').trim()) continue;
      const base = String(m.label).replace(/\s+month$/i, '').trim();
      m.label = `${base} month`;
      y.label = `${base} year`;
    }
    // A PAY-PERIOD LIST WITH NO NAME (Sabanto's Breezy form, 2026-09-25):
    // Hourly / Weekly / Monthly / Yearly sits beside "Desired Salary" with no
    // label of its own and reached the plan as "". Named for the salary it
    // belongs to.
    const PERIOD = /^(hourly|daily|weekly|bi-?weekly|monthly|yearly|annually|annual|per\s+(hour|day|week|month|year))$/i;
    for (let i = 0; i < fields.length; i += 1) {
      const f = fields[i];
      if (String(f.label || '').trim() || !/^(select|radio|prompt)$/.test(f.type)) continue;
      if ((f.options || []).filter((o) => PERIOD.test(String(o?.text ?? o).trim())).length < 3) continue;
      const pay = fields.slice(Math.max(0, i - 3), i).reverse().find((x) => /salary|compensation|pay\b|wage|rate/i.test(String(x.label || '')));
      f.label = `${pay ? pay.label : 'Pay'} — period`;
    }
    // A QUESTION ABOUT A LIST PRINTED UNDER IT carries that list (Atomic Semi,
    // 2026-09-25): "If no, is your home country listed below?" — the
    // countries are text in the same entry, and the answer is whether his is
    // among them. The entry's text goes to the planner as `near`.
    for (const f of fields) {
      if (f.near || !/\b(listed|named|shown)\s+(below|above)|\bthe\s+following\s+countr|\bcountries\s+(below|above|listed)/i.test(String(f.label || ''))) continue;
      const head = String(f.label).slice(0, 30);
      for (let n = f.elements?.[0]?.parentElement, i = 0; n && i < 8; n = n.parentElement, i += 1) {
        const t = n.innerText || '';
        if (t.includes(head) && t.length > f.label.length + 20) { f.near = t.replace(/\s+/g, ' ').slice(0, 2000); break; }
      }
    }
    const CALENDAR = /S\s?M\s?T\s?W\s?T\s?F\s?S\d|Su\s*Mo\s*Tu\s*We\s*Th\s*Fr\s*Sa/;
    return fields.filter((f) => !(typeof f.label === 'string' && CALENDAR.test(f.label)));
  }

  // ── walking a multi-step application ────────────────────────────────
  //
  // THIS IS THE PART THAT WAS MISSING, and it is why he never saw a resume
  // attached. A Workday application is a SIX-STEP wizard — My Information, My
  // Experience, Application Questions, Voluntary Disclosures, Self Identify,
  // Review — and the resume upload is on step TWO. Filling only the page in
  // front of you means step 1 has no file input at all, so nothing ever
  // attached and nothing past the first screen was ever answered.

  /** Text that means "this button finishes the application". Never clicked. */
  const FINAL_RE = /^\s*(submit|submit application|send application)\s*$/i;

  /** Text that means "go to the next step". */
  const NEXT_RE = /^\s*(save and continue|save & continue|continue|next|next step|save and next|review)\s*$/i;

  /**
   * The control that advances to the next step, or null if there is none.
   *
   * Workday's automation-ids come first because they are stable across tenants
   * and are what the Playwright driver has always used. The text match is the
   * fallback for every other ATS.
   *
   * A control whose text is Submit is NEVER returned, whatever its id says.
   */
  /**
   * Would clicking this control SUBMIT a form?
   *
   * The never-submit rule was defended by a text regex, and text is not what
   * makes a button submit. Measured: `<button type="submit">Continue</button>`
   * inside a form passed `FINAL_RE` — its text is "Continue" — was clicked, and
   * the form submitted. An application sent without him pressing anything is the
   * one outcome this whole system exists to prevent.
   *
   * The subtle half: a `<button>` with NO type attribute inside a `<form>`
   * defaults to submit. Reading the `.type` PROPERTY rather than the attribute
   * is what catches `<button>Continue</button>`, which looks innocent in markup.
   */
  function wouldSubmit(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' && /^(submit|image)$/i.test(el.type || '')) return true;
    if (tag === 'BUTTON' && String(el.type || '').toLowerCase() === 'submit' && el.closest('form')) return true;
    return false;
  }

  const phenomStep = (b) => {
    const cls = typeof b.className === 'string' ? b.className : '';
    return /\bbtn-next\b/.test(cls) && /\bbtn-navigate\b/.test(cls)
      && /^\s*next\s*$/i.test(b.textContent || '')
      && !!b.closest('.navigation[class*="-step"]')
      && /[?&]step=\d/.test(location.search);
  };

  function nextControl() {
    const ats = here();
    const wd = [...document.querySelectorAll(
      '[data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]',
    )].filter((b) => onScreen(b));
    // Where the ATS names its Next control stably, that name beats a text
    // match — SmartRecruiters' is a web component whose text is in a shadow
    // root, and Jobvite's carries "Next" only as an aria-label.
    const named = ats?.next
      ? deepQuerySelectorAll(ats.next).filter((b) => onScreen(b) && !b.disabled)
      : [];
    const generic = deepQuerySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
      .filter((b) => onScreen(b) && !b.disabled)
      .filter((b) => NEXT_RE.test(text(b) || b.value || b.getAttribute('aria-label') || ''));
    for (const b of [...wd, ...named, ...generic]) {
      const t = (text(b) || b.value || b.getAttribute('aria-label') || '').trim();
      if (FINAL_RE.test(t)) return null;    // the Review step. Stop here.
      // THE ATS SAYS THIS ONE SENDS THE APPLICATION. Its name wins over
      // whatever the button reads.
      if (ats?.submit && matchesAny(b, ats.submit)) return null;
      // A control that submits is his, whatever it is labelled. Refusing it
      // costs one click he makes himself; clicking it costs an application.
      // …EXCEPT PHENOM'S STEP BUTTON (Honda, 2026-10-02). Each step of its
      // apply flow is a <form> whose Next is type=submit
      // (`.navigation.<step>-step > button.btn-navigate.btn-next`); the
      // application is sent only by the last step's own Submit. Refusing it
      // stopped the walk on every one of Honda's five steps.
      if (wouldSubmit(b) && !phenomStep(b)) return null;
      return clickTarget(b);
    }
    return null;
  }

  /**
   * Why we stopped, when `nextControl` refused something that was there.
   *
   * "There is no way on" and "the only way on submits the form" are different
   * facts, and he needs the second one said out loud — otherwise a form that
   * stops one step early looks like a bug rather than the rule working.
   */
  /**
   * Oracle's first step (TI, F-345): "Authentication screen. You don't need
   * to have an account — get started by using your email", an Email box, a
   * terms box and a Next that submits the email and sends him a code. That
   * is not "a form whose only way on submits it"; it is the site asking for
   * his email first, and the panel should say so in those words.
   */
  const EMAIL_GATE_RE = /authentication screen|verif(?:y|ication) (?:code|email)|we(?:'ll| will) (?:send|email) (?:you )?a (?:verification |one-time )?code|get started (?:right away )?by (?:simply )?using your email|enter your email to (?:start|begin|continue|apply)/i;
  function emailGate() {
    if (/\/apply\/email(?:\/|\?|$)/i.test(location.pathname)) return true;
    return EMAIL_GATE_RE.test((document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000));
  }

  /**
   * WHAT KIND OF WALL THIS IS, once signInWall() has said there is one.
   *
   * "sign in here" over a page with no sign-in button and no password box is
   * confusing advice. iCIMS' /login (measured on Joby, 2026-09-06) reads
   * "Enter Your Information — Email", one box, an EU/UK residency tick and a
   * captcha: there is nothing to sign into yet, and the honest instruction is
   * to give the address and follow what it sends. Oracle's first step is the
   * same shape and already says so (F-345).
   *
   *   'email'  — an email box, no password, nothing to sign in WITH
   *   'signin' — a password box, or a third-party sign-in, or it says so
   */
  function signInWallKind() {
    const all = deepQuerySelectorAll('input');
    const has = (re) => all.some((el) => el.getClientRects().length > 0
      && re.test(`${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}`));
    if (has(/password/i)) return 'signin';
    if (ssoControl && ssoControl()) return 'signin';
    const words = `${document.title} ${(document.body?.innerText || '').slice(0, 1200)}`;
    if (/\b(sign|log)\s?in\b/i.test(words) && !/\bcreate\b/i.test(words)) return 'signin';
    const email = all.some((el) => el.getClientRects().length > 0
      && (/email/i.test(`${el.type || ''} ${el.name || ''} ${el.id || ''} ${el.autocomplete || ''}`)
        || /email/i.test(labelFor(el, el.type || 'text') || '')));
    return email ? 'email' : 'signin';
  }

  function advanceBlockedBy() {
    const cands = deepQuerySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
      .filter((b) => onScreen(b) && !b.disabled);
    const nextish = cands.find((b) => NEXT_RE.test(text(b) || b.value || ''));
    if (nextish && wouldSubmit(nextish)) {
      const name = (text(nextish) || nextish.value || '').trim();
      if (emailGate()) return `this site asks for your email first — press "${name}", type the code it emails you, and the form fills by itself from there`;
      return `the only way on is "${name}", which submits the form — that press is yours`;
    }
    // A NEXT THAT IS GREYED OUT IS NOT THE END OF THE FORM (2026-10-16). ADP
    // disables Next until its required resume is in; the run said "reached the
    // last step before Submit" on step 2 of 6.
    const greyed = deepQuerySelectorAll('button, [role="button"], input[type="button"]')
      .find((b) => onScreen(b) && (b.disabled || b.getAttribute('aria-disabled') === 'true') && NEXT_RE.test(text(b) || b.value || b.getAttribute('aria-label') || ''));
    if (greyed) return `"${(text(greyed) || greyed.value || 'Next').trim()}" is greyed out — this step still needs something it requires (see the list); once that is in, press it`;
    return null;
  }

  /**
   * The gate in front of a Workday application, if there is one.
   *
   * A fresh apply URL opens a "Start Your Application" modal offering Apply
   * Manually / Autofill with Resume / Use My Last Application, and until one is
   * chosen the page has ZERO form controls — so clicking the extension there did
   * nothing at all and reported nothing useful.
   *
   * Only "Apply Manually" is ever chosen, and that is the same choice the
   * Playwright driver makes for the same reason: it gives a deterministic empty
   * form. "Autofill with Resume" lets Workday parse the PDF and write its own
   * guesses into fields we are about to answer from his profile, and "Use My
   * Last Application" copies answers written for a different job.
   */
  // A PRIVACY NOTICE BETWEEN APPLY AND THE FORM (ADP Workforce Now, Mando,
  // F-692): Apply opens "Privacy Policy — Consent & Continue | Decline & Close"
  // in place, the run waited for a page that never came, and nothing filled.
  // His standing answer to a consent is yes — every one, cookies included
  // ("can we just press consent on everything", 2026-10-03, after Eightfold's
  // notices). Never a button that would submit, and a bare Confirm / OK /
  // Continue only in a notice that says nothing of submitting, withdrawing or
  // deleting.
  const CONSENT_GO_RE = /^\s*(?:i\s+)?(consent|accept(\s+all)?|agree|acknowledge|understand)(\s+(&|and)\s+(continue|proceed|apply|close))?\s*\.?\s*$/i;
  const CONSENT_PLAIN_RE = /^\s*(confirm|ok(ay)?|continue|proceed)\s*\.?\s*$/i;
  function consentGate() {
    const panes = deepQuerySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], sdf-focus-pane, sdf-modal, .modal, [class*="modal" i]')
      .filter((d) => onScreen(d) || onScreen(d.shadowRoot?.querySelector('[role="dialog"]')));
    for (const pane of panes) {
      const words = `${pane.textContent || ''} ${pane.shadowRoot?.textContent || ''}`.replace(/\s+/g, ' ');
      if (!/\bprivacy\b|\bconsent\b|\bterms\b|\bdata\s+protection\b|\bcookies?\b|\bnotice\b|\bagree(ment)?\b|\bartificial\s+intelligence\b|\bAI\b/i.test(words)) continue;
      // …and never a sign-in or account box's Continue: that is his.
      const plainOk = !/\b(submit|submission|withdraw|delete|remove|discard|cancel\s+(your|this)\s+application)\b/i.test(words)
        && !pane.querySelector('input[type="password"], input[type="email"], input[autocomplete="username"]');
      const named = (b) => (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ');
      const buttons = [...pane.querySelectorAll('button, [role="button"], sdf-button')].filter((b) => onScreen(b) && !wouldSubmit(b));
      const go = buttons.find((b) => CONSENT_GO_RE.test(named(b))) || (plainOk && buttons.find((b) => CONSENT_PLAIN_RE.test(named(b))));
      if (go) return go.shadowRoot?.querySelector('button') || go;
    }
    return null;
  }
  function startGate() {
    const manual = document.querySelector('[data-automation-id="applyManually"]');
    return onScreen(manual) ? manual : consentGate();
  }

  /**
   * Is this a sign-in wall rather than an application?
   *
   * Worth telling apart from "an empty form": one means he needs an account at
   * this employer, the other means something is broken.
   */
  /** Paths that mean "identify yourself first", whatever the fields say. */
  const AUTH_PATH_RE = /\/(login|log-?in|signin|sign-?in|register|create-?account|new-?account)(\/|\?|$)/i;

  /** A box that wants the code from his email or phone. */
  // Not a bare "code": a three-field form with a postal code on it is a form.
  const OTP_RE = /verif(?:y|ication)\s*code|one[\s-]?time|passcode|security code|confirmation code|authentication code|\botp\b|\bmfa\b|enter (?:the )?code|code (?:we|that was) sent/i;

  function signInWall() {
    // A GATE AT AN AUTH URL, even with no password on it.
    //
    // Following iCIMS' Apply link lands on `/login`, which asks for an email and
    // a consent box and nothing else. There is no password, so the check below
    // called it an ordinary form — but it is the door to starting an account,
    // and whether to open one at this employer is his call, not this tool's.
    // Bounded by field count so a real application that happens to live under
    // /login is still filled.
    if (AUTH_PATH_RE.test(location.pathname + location.search)
      && applicationControls().length <= 3) return true;

    // …AND THE SAME GATE INSIDE AN IFRAME. iCIMS renders its whole flow in
    // one (measured on Joby, 2026-09-06): the outer page is the employer's
    // site and only the frame's src and the form's own action say /login. A
    // form that POSTS to an auth path is that door wherever it is drawn.
    const postsToAuth = deepQuerySelectorAll('form').some((f) => f.getClientRects().length > 0
      && AUTH_PATH_RE.test(f.getAttribute('action') || ''));
    if (postsToAuth && applicationControls().length <= 3) return true;

    // AN AUTH HOST, OR A PAGE THAT SAYS IT IS ONE.
    //
    // Amazon's Apply button leads to https://passport.amazon.jobs/ — pathname
    // "/", so the path check above misses it entirely — titled "Log in or
    // create account", carrying exactly one control: #preLoginEmailField.
    //
    // Measured live on five of his saved Amazon postings: signInWall() returned
    // FALSE, discover() returned that one field labelled "Email", and the
    // engine would have typed his address into a LOGIN form and reported one
    // field filled. That is worse than doing nothing — it reads as an
    // application that happened. It is also how all five Amazon rows in the
    // audit came back showing a single answered "Email" and nothing else.
    //
    // Bounded by control count for the same reason as the path check: a real
    // application that merely mentions signing in somewhere is still filled.
    const authHost = /^(passport|login|signin|sign-in|auth|accounts?|identity)\./i.test(location.hostname);
    // The first 1200 characters, not 400: Microsoft's Eightfold sign-in page
    // opens with a skip link, a header and an employee notice, and its "Sign
    // in using" row sat just past the old window (measured 2026-09-06, F-363).
    const saysSo = `${document.title} ${(document.body?.innerText || '').slice(0, 1200)}`;
    const authText = /\b(log|sign)\s?in\b[^.]{0,24}\bor\b[^.]{0,24}\bcreate\b|\bcreate\b[^.]{0,30}\baccount\b[^.]{0,24}\bor\b[^.]{0,24}\b(log|sign)\s?in\b|select a method below to (?:log|sign)\s?in|create one during the (?:log|sign)\s?in process/i.test(saysSo);
    // A PAGE HEADED "SIGN IN" IS A SIGN-IN PAGE, whatever else it carries.
    const headed = /^\s*(?:sign|log)\s?in\s*$/i.test(document.querySelector('h1')?.textContent || '');

    // THIRD-PARTY SIGN-IN IS THE PLAINEST SIGNAL THERE IS.
    //
    // Eightfold's apply flow — GlobalFoundries, Micron, Microsoft, Lam
    // Research, Qualcomm, which is a large share of the companies he tracks —
    // sends Apply Now to /careers/apply, which renders "Sign in / Email /
    // Continue / OR Sign in using Google / Microsoft / LinkedIn / Facebook /
    // First time here? Create". One control, id `auth-entry-email-input`.
    //
    // The wording check above misses it: the words are all present but too far
    // apart and not joined by "or". Nobody puts "Sign in using Google" on an
    // application form, so the SSO row is worth matching directly. The field's
    // own id is the second signal — an input NAMED auth is not an answer.
    const sso = /\b(sign|log)\s?in (using|with)\b|\bcontinue with (google|microsoft|linkedin|apple|facebook)\b/i.test(saysSo);
    const authField = !!document.querySelector(
      'input[id*="auth" i], input[name*="auth" i], input[id*="signin" i], input[name*="signin" i], input[id*="login" i], input[name*="login" i]',
    );
    if ((authHost || authText || sso || authField || headed)
      && applicationControls().length <= 3) return true;

    // A VERIFICATION CODE IS HIS TO TYPE. iCIMS emails a code after the
    // account step; Workday and Eightfold tenants can ask for one on sign-in.
    // The page has one or two inputs and a Continue button, and without this
    // rule it read as a small form: the filler would plan the code box as an
    // unanswerable question and press Continue for him with the box empty.
    const controls = allControls().filter(visible);
    if (controls.length <= 3 && controls.some((el) => el.getAttribute('autocomplete') === 'one-time-code'
      || OTP_RE.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`)
      || OTP_RE.test(labelFor(el, (el.type || 'text').toLowerCase())))) return true;

    // A VERIFICATION SIGN-UP THAT ALSO OFFERS GOOGLE IS A SIGN-IN PAGE
    // (2026-10-16). ADP's "Join Our Talent Community": name, email, mobile,
    // "Where would you like to receive a verification code?" — and "Sign in
    // with Google" beside them. While its boxes were invisible (F-746) it read
    // as a wall and Google was pressed, which is his standing instruction;
    // once they were readable the run filled the sign-up and stopped at the
    // code. The Google button wins whenever the page is asking to send a code.
    if (ssoControl && ssoControl()
      // Before its Continue is pressed, ADP's page says it in other words: "the
      // mobile number or email associated with this verification process",
      // "Alternatively, you can sign in through your social media accounts".
      && /receive (a|the|your) (verification|security|one[\s-]?time) code|where (would|should) (you like to|we) (receive|send)[^.?]{0,30}code|send (you |me )?(a|the) (verification|one[\s-]?time) code|associated with this verification process|sign in (through|with|using) your social media/i.test(document.body?.innerText || '')) return true;

    // A PASSWORD FIELD SETTLES IT, and this is the important half.
    //
    // Choosing "Apply Manually" while signed out lands on Workday's Create
    // Account page — email, password, verifyPassword — and that page has four
    // `formField-*` wrappers. The first version of this check asked whether the
    // page had form fields and concluded "not a wall", so the filler would have
    // treated an account-creation form as an application and typed his email
    // into it. Signing in and creating accounts are his to do, always.
    if (document.querySelector('input[type="password"]')) return true;

    // A PAGE THAT OFFERS "APPLY" IS A POSTING, NOT A WALL.
    //
    // Workday puts a Sign In link in the header of EVERY page, job adverts
    // included. The check below asked only whether that link existed and the
    // page had no form fields — which is exactly what a Workday job advert
    // looks like — so **every Workday posting reported itself as a sign-in
    // wall**, and the extension refused to follow its Apply button rather than
    // starting the application. Workday carries more postings in his deck than
    // any other ATS.
    //
    // Measured on a live Jabil posting: zero password inputs, zero form fields,
    // a header Sign In link, and an Apply button right there on the page.
    if (applyControl()) return false;

    // Workday's account step, named rather than inferred.
    //
    // Choosing "Apply Manually" while signed out lands on **"step 1 of 7 —
    // Create Account/Sign In"**, measured on a live Jabil application. The
    // heuristic below reaches the right verdict there today, but only because
    // the page happens to have a header link and no form fields yet — Workday
    // renders the fields a moment later, and once they arrive the heuristic
    // flips. Reading the step's own name does not depend on that timing.
    const wizard = (document.body?.innerText || '').slice(0, 400);
    if (/create account\s*\/\s*sign in|create account or sign in/i.test(wizard)) return true;

    const signIn = document.querySelector('[data-automation-id="utilityButtonSignIn"], [data-automation-id="signInLink"]');
    const hasForm = document.querySelectorAll('[data-automation-id^="formField-"]').length > 0;
    return !!(onScreen(signIn) && !hasForm);
  }

  /**
   * The "Sign in with Google" control on a sign-in wall, or null.
   *
   * His standing instruction: press it. He is signed into Google in this
   * Chrome, so the round trip is automatic and lands back on the form; the
   * account chooser, if Google shows one, is his. Only Google — never an
   * email/password form, never "create account", never a different provider
   * he did not name. Workday names its button; other tenants only label it.
   */
  const GOOGLE_SSO_RE = /^\s*(?:sign|log)\s?in\s+(?:with|using|via)\s+google\s*$|^\s*continue\s+with\s+google\s*$/i;
  function ssoControl() {
    const named = document.querySelector('[data-automation-id="GoogleSignInButton"], [data-automation-id*="googleSignIn" i]');
    if (onScreen(named)) return named;
    return [...document.querySelectorAll('button, a, [role="button"]')]
      .find((b) => onScreen(b) && GOOGLE_SSO_RE.test((b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' '))) || null;
  }

  /**
   * Has this posting been taken down?
   *
   * Measured on a live Form Energy posting: Ashby's public board API reports it
   * `isListed: true` with a `jobUrl` that renders **"Page not found"**. Checked
   * in his own Chrome as well as headless, so it is not bot detection — the
   * board is simply ahead of the page. Our liveness check believes the API and
   * calls it active, so a dead posting sits in his queue.
   *
   * Clicking the extension there reported "0 filled", which reads as the tool
   * being broken rather than the job being gone. Saying which one it is costs
   * nothing and is the difference between "try again" and "move on".
   *
   * Requires BOTH the wording and an absence of form controls, so a real
   * application that happens to contain the phrase is never dismissed.
   */
  // PORTED FROM `DEAD_POSTING_RE` in jarvis/apply/_form.mjs, character for
  // character, and checked by the drift test in discover.test.mjs.
  const GONE_RE = /oops|gone too far|no longer (available|accepting|active|posted|open)|has been (filled|closed|removed)|position (closed|filled)|(job|position|posting|role|opening|vacancy)[^.]{0,40}(isn.?t|is not)\s+available|(page|job|position|posting|requisition|opening|vacancy)\s+(you\s+requested\s+)?(was|is|has been)?\s*(not found|closed|filled|removed|expired|unavailable)|(page|job|position|posting|requisition|opening|vacancy)[^.]{0,40}(does\s?n.?t|does not)\s+exist/i;

  function postingGone() {
    // THE SITE SAID SO IN THE ADDRESS (Rippling, Aalo Atomics 2026-09-25): a
    // pulled posting redirects to the board with `?rr_message=job_not_found`,
    // and the board's own filters made the page look like a form — the report
    // read "everything that could be filled is; Submit is yours" on a job
    // board.
    if (/[?&](rr_message|message|error)=job[_-]?not[_-]?found\b/i.test(location.search || '')) return 'job not found';
    // …which Rippling's router then rewrites away (…/jobs?jobBoardSlug=…
    // &page=0) before any of this runs; the worker saw the address the tab
    // actually landed on and passes it along.
    if (globalThis.__jarvisRun?.gone) return String(globalThis.__jarvisRun.gone);
    // Application controls mean this is a form, whatever the prose says. Site
    // furniture does not count — a dead Amazon posting still renders the whole
    // job-search bar, which is 21 controls and not one of them an application.
    const real = allControls()
      .filter((el) => visible(el) && !siteFurniture(el));
    if (real.length > 0) return null;

    // The FIRST part of the page only. Capping the whole page length instead
    // meant a 404 that also renders site chrome — 1,837 characters on Amazon —
    // was never examined at all, so the deadest page in his queue read as an
    // ordinary empty one.
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    // A SESSION THAT TIMED OUT IS NOT A DEAD POSTING. SmartRecruiters: "Due to
    // inactivity, the form has been closed to protect your data. Click on the
    // button below to start your application process again." (Western
    // Digital, 2026-09-24) matched "has been closed" and was reported as a
    // posting gone — the one false verdict that can retire a live job.
    if (SESSION_OVER_RE.test(text)) return null;
    const m = text.match(GONE_RE);
    return m ? m[0] : null;
  }
  const SESSION_OVER_RE = /due\s+to\s+inactivity|session\s+(has\s+)?(expired|timed\s+out)|your\s+session\s+(is\s+about\s+to\s+)?(expire|time\s+out)|to\s+protect\s+your\s+data|start\s+your\s+application(\s+process)?\s+again/i;

  /**
   * A page that is refusing us rather than showing a form.
   *
   * PORTED FROM `pageBlocker` in jarvis/apply/_form.mjs, patterns identical.
   * That version has recognised these for months; the extension knew only about
   * sign-in walls, so on an iCIMS human-verification page it reported "no form
   * controls here" — which reads as the tool being broken rather than the site
   * asking him to prove he is a person.
   *
   * `jarvis/extension/discover.test.mjs` asserts these two patterns are
   * character-for-character what `_form.mjs` uses, so the two copies cannot
   * drift in silence. Drift between those two files is this project's most
   * repeated failure.
   *
   * NEITHER IS EVER CLEARED AUTOMATICALLY. Clicking through a bot check is
   * exactly what this engine must refuse; it names the check and stops.
   */
  const HUMAN_CHECK_RE = /confirm you are human|security check|are not a bot|verify you are human/i;
  const REFUSED_RE = /access denied|don.?t have permission to access|unusual traffic|rate.?limit(ed)?\b|request blocked|403 forbidden/i;

  /**
   * A bot wall that carries NO WORDS of its own: DataDome (SmartRecruiters'
   * oneclick-ui served one to an automation Chromium, 2026-09-04 — a 403
   * whose body is a bare <iframe> to geo.captcha-delivery.com), hCaptcha,
   * Cloudflare Turnstile. The text tests above see an empty page, and an
   * empty page read as "not a multi-step application", which is the wrong
   * fact: the site is asking for a person. Named, never clicked through.
   */
  const CHALLENGE_FRAME_SEL = 'iframe[src*="captcha-delivery.com"], iframe[title*="captcha" i], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha"]';
  const CHALLENGE_TITLE_RE = /just a moment|attention required|access denied|verify you are human|bot verification/i;

  function pageBlocked() {
    const text = (document.body?.innerText || '').slice(0, 4000);
    // A WALL IS THE WHOLE PAGE. Eightfold (Lam) embeds reCAPTCHA's hidden
    // bframe on every application page, and the first version of this rule
    // called Lam's form a human-verification check with the fields in plain
    // view (F-339, his screenshot). A challenge frame counts only when it is
    // drawn at a size a person could see AND the page holds no application
    // controls of its own — the DataDome page is exactly that; a form with a
    // hidden captcha helper is not.
    const walled = () => {
      const frame = [...document.querySelectorAll(CHALLENGE_FRAME_SEL)].find((f) => {
        const r = f.getBoundingClientRect();
        return r.width >= 250 && r.height >= 150 && getComputedStyle(f).visibility !== 'hidden';
      });
      if (!frame && !(text.length < 400 && CHALLENGE_TITLE_RE.test(document.title || ''))) return false;
      return allControls().filter((el) => visible(el) && !siteFurniture(el)).length === 0;
    };
    if (walled()) {
      return { kind: 'human', why: 'this site is showing a human-verification check — clear it yourself in this tab, then click again' };
    }
    if (HUMAN_CHECK_RE.test(text)) {
      return { kind: 'human', why: 'this site is showing a human-verification check — clear it yourself in this tab, then click again' };
    }
    if (REFUSED_RE.test(text.slice(0, 800))) {
      return { kind: 'blocked', why: 'this site refused the browser (an Access Denied page, not a form) — wait a few minutes and try again' };
    }
    // …AND SAID AS WHAT IT IS: the form timed out and must be reopened.
    if (SESSION_OVER_RE.test(text.slice(0, 800)) && allControls().filter((el) => visible(el) && !siteFurniture(el)).length === 0) {
      return { kind: 'session', why: 'the site closed the form for inactivity — reopen it (its button starts the application again), then click Jarvis' };
    }
    // AN APPLICATION ALREADY STARTED ELSEWHERE. firststage (Wayve, 2026-09-24):
    // after the CV, "You already have an application in progress — It looks
    // like you have already started an application for this role using this
    // email address", with one button that emails a link. It was reported as
    // "something required is still empty" with nothing listed. The link and
    // the draft are his; the button is never pressed for him.
    if (IN_PROGRESS_RE.test(text) && allControls().filter((el) => visible(el) && !siteFurniture(el)).length === 0) {
      return { kind: 'in-progress', why: 'this site already holds an application you started for this role under your email — continue that one (the site can email you a link to it)' };
    }
    return null;
  }
  const IN_PROGRESS_RE = /you\s+(?:already\s+)?have\s+an?\s+(?:application|draft)\s+(?:already\s+)?in\s+progress|already\s+started\s+an\s+application\s+for\s+this\s+(?:role|job|position)/i;

  /**
   * The Apply control on a JOB POSTING, when this page is not the form yet.
   *
   * Measured: clicking the extension on a Bosch SmartRecruiters posting, a Form
   * Energy Ashby posting, or a Joby iCIMS posting found zero application fields
   * — because those pages are adverts with an Apply button, not forms. The
   * report said "0 filled", which reads as broken rather than as "you are on the
   * wrong page".
   *
   * Kept in step with jarvis/apply/_form.mjs, which has the same two patterns
   * and the same reason: stated twice they drift, and that is F-14, F-74 and
   * F-77 in this ledger already.
   */
  // A SAVED APPLICATION'S WAY BACK IN IS APPLY TOO (2026-10-16): ADP shows a
  // posting he has started as "Pending Submission" with "Complete Your
  // Application" where Apply was, and the run said "no form here yet".
  const APPLY_TEXT_RE = /^\s*(apply|apply now|apply here|apply to this job|apply for this job|i'?m interested|start (your )?application|continue to application|(complete|continue|resume|finish) (your |this |my )?application)\s*$/i;
  const APPLY_PATH_RE = /(^|\/)(apply|application|applications|applicant|apply-now)(\/|$)/i;

  function applyControl() {
    // Already on a form? Then there is nothing to follow. This guard is also
    // what keeps "Apply filters" on a search page out of the running below —
    // a filter UI has inputs, so it never reaches the loose matches.
    //
    // It counts APPLICATION controls, not every input on the page. Counting all
    // of them meant a posting that also carries a job search bar looked like a
    // form we were already on: a live Amazon posting has 21 controls, all of
    // them site furniture, so its Apply button was never found and none of the
    // three Amazon jobs in his queue could be started.
    // NEVER A CONTROL THAT SUBMITS. A two-field quick-apply form has an
    // "Apply" button that IS the send button; following it would send an
    // application with his email and nothing else in it. `wouldSubmit` is the
    // same test nextControl applies, for the same reason.
    const cands = deepQuerySelectorAll('a, button, [role="button"]')
      .filter((b) => onScreen(b) && !wouldSubmit(b));

    // The ATS's own name for its Apply control, where it has one — and it
    // wins BEFORE the field count below: the ATS is saying "this is the
    // posting", and a posting page can carry a match-my-resume upload, a
    // search box or a video player without being a form.
    const ats = here();
    if (ats?.apply) {
      const named = cands.find((b) => matchesAny(b, ats.apply));
      if (named) return named;
    }
    // PHENOM CAREER SITES live on the employer's own domain (careers.honda.com,
    // www.jpl.jobs), so no host names them — the markup does. Measured
    // 2026-10-02: the posting's Apply Now is <a data-ph-at-id="apply-link">,
    // and the job-alert email box, the chatbot input and the "rate your
    // experience" stars made the page count as a form, so Apply was never
    // followed and the alert email was filled instead. The first one is the
    // posting's own; the rest belong to "similar jobs" below it.
    // Never on the application itself (/apply?jobSeqNo=…&step=1).
    const phenom = !/\/(?:hvh)?apply\b/i.test(location.pathname)
      && cands.find((b) => b.getAttribute('data-ph-at-id') === 'apply-link');
    if (phenom) return phenom;

    const real = allControls()
      .filter((el) => visible(el) && !siteFurniture(el));
    if (real.length > 2) return null;

    // Exact text first — "Apply" beats "Apply for other roles at this company".
    const byText = cands.find((b) => APPLY_TEXT_RE.test((b.textContent || '').trim()));
    if (byText) return byText;

    // Then a short control that STARTS with apply. iCIMS renders its link as
    // "Apply for this job onlineApply" (the visible label and a screen-reader
    // span, concatenated), which no exact match will ever catch — and iCIMS
    // postings were reporting zero fields because of it. Length-capped so a
    // paragraph beginning "Apply by 30 June to..." is not mistaken for a button.
    const byPrefix = cands.find((b) => {
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length <= 48 && /^apply\b/i.test(t) && !/other role|another|filter|all jobs/i.test(t);
    });
    if (byPrefix) return byPrefix;

    return cands.find((b) => {
      const href = b.getAttribute('href') || '';
      return href && APPLY_PATH_RE.test(href) && /apply/i.test(b.textContent || href);
    }) || null;
  }

  /** A cheap fingerprint of what is on screen, to tell one step from the next. */
  /**
   * CLOSED SECTIONS HIDE THEIR QUESTIONS (TSMC, SuccessFactors, 2026-09-24).
   *
   * The application is a stack of collapsed sections — Profile Information,
   * Prior Work Experience, Formal Education, Skills, Job-Specific Information —
   * each a <button aria-expanded="false"> inside an <h2>. Closed, their fields
   * are not on the page to read, so a run saw almost nothing. Every closed
   * SECTION HEADER is opened: a disclosure button that sits in a heading (or
   * carries SuccessFactors' own section class), never a dropdown's trigger
   * (aria-haspopup, a combobox), never one holding a field, never site chrome
   * and never anything that would submit. Returns how many it opened.
   */
  function expandSections() {
    const heads = deepQuerySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"]')
      .filter((b) => b.getClientRects().length > 0)
      .filter((b) => !b.hasAttribute('aria-haspopup') || b.getAttribute('aria-haspopup') === 'false')
      .filter((b) => b.getAttribute('role') !== 'combobox' && !isCombobox(b))
      .filter((b) => b.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')
        || /rcmFormSectionTopBar/.test(typeof b.className === 'string' ? b.className : ''))
      .filter((b) => !b.querySelector('input, select, textarea'))
      .filter((b) => !siteFurniture(b) && !wouldSubmit(b));
    for (const b of heads) b.click();
    return heads.length;
  }

  function stepSignature() {
    const ids = [...document.querySelectorAll('[data-automation-id^="formField-"]')]
      .map((n) => n.getAttribute('data-automation-id')).join('|');
    const heading = text(document.querySelector('h1, h2, [data-automation-id="pageHeader"]'));
    // A start gate is a step of its own. It adds no field and no heading the
    // selector above sees first, so without this a modal appearing over the
    // posting read as "nothing changed" and the watcher slept through it.
    const gate = onScreen(document.querySelector('[data-automation-id="applyManually"]')) ? '::gate' : '';
    // So is a sign-in wall. Workday's Sign In step has the same heading as
    // the modal before it and no inputs at all, so it read as "nothing
    // changed" and the Google button was never pressed (Jabil, measured live).
    const wall = onScreen(document.querySelector('[data-automation-id="GoogleSignInButton"], input[type="password"], [data-automation-id="signInLink"]')) ? '::wall' : '';
    // WHICH controls, not only how many (F-573). Wayve's firststage steps share
    // a heading and a path and hold one control each — the CV upload, then a
    // consent box — so "heading::1" called the second step the first. Workday
    // is named by its field ids already; everything else by type and name.
    let fp = '';
    const ctrls = allControls();
    if (!ids) {
      const s = ctrls.map((el) => `${el.type || el.tagName}:${el.name || el.id || ''}`).join('|');
      let h = 0;
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
      fp = `::f${(h >>> 0).toString(36)}`;
    }
    return `${heading}::${ids || ctrls.length}${fp}${gate}${wall}`;
  }

  /**
   * Wait for the page to become SOMETHING: fields, a wall, a gate, an Apply
   * control or a dead-page notice. `settle()` waits for the signature to stop
   * changing, which is the wrong question right after a click that opens a
   * new step — the new step can take seconds to paint, and until it does the
   * signature has not changed at all.
   */
  async function waitForSomething(capMs = 8000, { ignoreApply = false } = {}) {
    const started = Date.now();
    while (Date.now() - started < capMs) {
      // An Apply control counts too: Oracle's job page (TI) renders "Apply
      // Now" a few seconds after the document, and a press that looked once
      // reported "not a multi-step application" on a posting (F-343).
      // Not right after Apply was pressed, though: the header's Apply link
      // is still there while the new page paints (Microsoft's Eightfold,
      // F-365), and it must not count as the page having arrived.
      if (discover().length || signInWall() || startGate() || postingGone() || (!ignoreApply && applyControl())) return true;
      await pause(250);
    }
    return false;
  }

  /** Wait until the page stops changing, or `capMs` passes. Never throws. */
  async function settle(capMs = 12000) {
    let last = '';
    let stableFor = 0;
    const started = Date.now();
    while (Date.now() - started < capMs) {
      await pause(250);
      const sig = stepSignature();
      if (sig === last) { stableFor += 250; if (stableFor >= 750) return; }
      else { last = sig; stableFor = 0; }
    }
  }

  /**
   * Has this employer MOVED to a different ATS?
   *
   * A distinct answer from "sign in first", and confusing the two is expensive.
   * Six GlobalFoundries jobs sat in his shortlist reported as sign-in walls.
   * The tenant had in fact been decommissioned months earlier and every advert
   * on it says so:
   *
   *     We moved to Eightfold, use this link to new job applications:
   *     https://globalfoundries.eightfold.ai/careers
   *
   * The old pages still render, so nothing reads as dead — check-liveness.mjs
   * calls them active, correctly, because they ARE live pages that simply can
   * no longer be applied to. And signInWall()'s last rule is "a visible Sign In
   * link and no form fields", which is exactly what a migrated tenant looks
   * like. So the engine told him to sign in at a tenant that cannot accept an
   * application, which wastes his time in the way that looks most like his own
   * fault.
   *
   * Requires an absence of form controls, like postingGone(), so a real
   * application that happens to mention a move is never abandoned.
   */
  const MOVED_RE = /\b(we(?:'ve| have)? moved|has moved|we are now|now hiring through|applications? (?:are |is )?now (?:at|on|handled)|no longer accept(?:ing)? applications? (?:through|via|on)|use this link to new job applications)\b/i;

  /** The controls that are the application's: drawn, and not the site's. */
  const applicationControls = () => allControls().filter((el) => visible(el) && !siteFurniture(el));

  function atsMoved() {
    const real = applicationControls();
    if (real.length > 0) return null;
    if (applyControl()) return null;
    // THE FORM IS IN A FRAME ON THIS SAME ATS. AMD's iCIMS pages carry "Our
    // Careers Site has Moved" as site chrome on every page while the
    // application itself is an iCIMS iframe below it (F-342). A page whose
    // frames belong to a known ATS has not moved anywhere.
    if ([...document.querySelectorAll('iframe')].some((f) => ATS?.isAtsHost?.(f.src || ''))) return null;

    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!MOVED_RE.test(text)) return null;
    // MID-APPLICATION IS NOT MOVED (F-732). GlobalFoundries' live Workday form,
    // between two steps with no controls drawn yet, matched the loose phrases
    // and the run stopped with "moved — linkedin.com/company/globalfoundries".
    // Inside an apply flow only the migration notice itself counts.
    if (/\/apply(\/|$|\?)/i.test(location.pathname + location.search)
      && !/\b(we(?:'ve| have)? moved to|use this link to new job applications|no longer accept(?:ing)? applications?)\b/i.test(text)) return null;

    // The destination, when the page names one — that is the useful half. A
    // footer's social link is not a destination.
    const SOCIAL_RE = /(^|\.)(linkedin|facebook|twitter|x|instagram|youtube|glassdoor|tiktok)\.com$/i;
    const link = [...document.querySelectorAll('a[href]')]
      .map((a) => a.href)
      .find((h) => { try { const u = new URL(h); return /^https?:$/i.test(u.protocol) && u.hostname !== location.hostname && !SOCIAL_RE.test(u.hostname); } catch { return false; } }) || null;
    const said = (text.match(/[^.]*(?:moved|no longer accept|new job applications)[^.]*/i) || [''])[0].trim().slice(0, 160);
    return { why: said || 'this employer has moved to a different application system', link };
  }

  // ── reading the POSTING, not the form ───────────────────────────────
  //
  // A resume can only be tailored towards a description, and until now the
  // only description the server could see was the one the SCANNER had stored.
  // He arms the extension on whatever page he is on — a link someone sent him,
  // a company portals.yml has never heard of — and those were exactly the pages
  // that got "nothing to tailor from" and no resume at all. The page itself
  // says what the job is; this reads it and the server records it.

  /** HTML to readable text, lists surviving as lines. */
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    for (const n of doc.querySelectorAll('script, style')) n.remove();
    for (const n of doc.querySelectorAll('br')) n.replaceWith('\n');
    for (const n of doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, ul, ol, section')) {
      n.prepend('\n'); n.append('\n');
    }
    return (doc.body?.textContent || '')
      .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * The JSON-LD JobPosting, when the page ships one.
   *
   * Greenhouse, Lever, Ashby, Workday, SmartRecruiters and iCIMS all embed
   * `<script type="application/ld+json">` with `@type: JobPosting` on the
   * posting page — title, hiringOrganization and the full description as HTML.
   * It is the page's own structured statement of what the job is, which makes
   * it the most trustworthy source there is, and it is the same markup Google
   * for Jobs reads, so vendors keep it accurate.
   */
  function postingFromJsonLd() {
    const found = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent || ''); } catch { continue; }
      const nodes = [];
      const walk = (x, depth = 0) => {
        if (!x || typeof x !== 'object' || depth > 4) return;
        if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
        nodes.push(x);
        if (x['@graph']) walk(x['@graph'], depth + 1);
        if (x.mainEntity) walk(x.mainEntity, depth + 1);
      };
      walk(data);
      const isJob = (n) => /jobposting/i.test([].concat(n['@type'] || []).join(' '));
      found.push(...nodes.filter(isJob));
    }
    // ONE JOB, OR NONE. A careers landing page lists several postings as
    // JSON-LD; taking the first would tailor his resume to whichever job the
    // page happened to put first. Ambiguity is answered with nothing.
    if (found.length !== 1) return null;
    const jp = found[0];
    const title = String(jp.title || jp.name || '').replace(/\s+/g, ' ').trim();
    if (!title) return null;
    const url = String(jp.url || '').trim();
    // THE MARKUP MUST DESCRIBE THIS PAGE. A tenant that leaves a previous
    // job's JSON-LD in a shared template would otherwise rename every
    // application after it. Compared by requisition id, the only thing two
    // URLs for one posting reliably share.
    if (url && ATS) {
      const a = ATS.reqToken(url);
      const b = ATS.reqToken(location.href);
      if (a && b && a !== b) return null;
    }
    const org = jp.hiringOrganization;
    const company = typeof org === 'string' ? org : (org && (org.name || org.legalName)) || '';
    // `where`, not `location`: a local by that name shadows window.location
    // for the whole function, and the token check above reads it.
    const loc = [].concat(jp.jobLocation || [])[0];
    const addr = loc && (loc.address || loc);
    const where = addr && typeof addr === 'object'
      ? [addr.addressLocality, addr.addressRegion, addr.addressCountry && (addr.addressCountry.name || addr.addressCountry)]
        .filter(Boolean).map(String).join(', ')
      : (typeof addr === 'string' ? addr : '');
    return {
      title,
      company: String(company || '').replace(/\s+/g, ' ').trim(),
      description: htmlToText(jp.description || ''),
      url,
      location: String(where || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      source: 'jsonld',
    };
  }

  /**
   * The posting read off the rendered page, for tenants that ship no JSON-LD.
   *
   * ONLY ON A PAGE SHAPED LIKE A POSTING — an Apply control and no application
   * fields. On a form step the nearest `<h1>` is "My Information", and recording
   * that as a job title at this employer would put junk in his store under a
   * real company's name. `applyControl()` is the same test the rest of this
   * file uses to tell a posting from a form.
   */
  const DESCRIPTION_SEL = [
    '[data-automation-id="jobPostingDescription"]',   // Workday
    '#job-description', '.job-description', '[class*="job-description" i]', '[class*="jobDescription" i]',
    '[class*="posting-description" i]', '[class*="job_description" i]', '[data-testid*="description" i]',
    '[id*="description" i]', '[class*="description" i]',
    'article', 'main',
  ].join(', ');

  /** Headings that are never a job title, however the page is shaped. */
  const NOT_A_TITLE_RE = /^(?:my information|my experience|application questions|voluntary disclosures|self[- ]identify|review|sign in|log in|create account|candidate (?:profile|home)|apply(?: now)?|careers?|jobs?|search(?: jobs)?|job search|open (?:roles|positions|jobs)|current openings|welcome|home|thank you.*|error|page not found)$/i;

  function postingFromDom() {
    if (!applyControl()) return null;
    const title = text(document.querySelector('[data-automation-id="jobPostingHeader"]'))
      || text(document.querySelector('h1'))
      || (document.querySelector('meta[property="og:title"]')?.content || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 160 || NOT_A_TITLE_RE.test(title)) return null;
    const company = (document.querySelector('meta[property="og:site_name"]')?.content || '').replace(/\s+/g, ' ').trim();
    // The longest description-looking block wins: the selectors are ordered by
    // how specifically they name a description, but a `[class*="description"]`
    // can be a one-line teaser above the real body.
    let description = '';
    for (const el of document.querySelectorAll(DESCRIPTION_SEL)) {
      const t = (el.innerText || '').trim();
      if (t.length > description.length) description = t;
    }
    return { title, company, description: description.slice(0, 40000), url: '', source: 'dom' };
  }

  /** What this page says the job is, or null when it does not say. */
  function readPosting() {
    try { return postingFromJsonLd() || postingFromDom(); } catch { return null; }
  }

  /**
   * Has the application been SENT — by him, since nothing here can send one?
   *
   * An armed tab keeps filling whatever page it lands on. After he presses
   * Submit the ATS shows "Thank you for applying", and a tab that stays armed
   * there would greet the next posting he opens in it an hour later by filling
   * it — with the previous employer's resume in hand. Recognising the
   * confirmation is how the tab stands down on its own.
   *
   * Requires an absence of form controls, like postingGone(): a form that
   * happens to thank him in a sidebar is still a form.
   */
  // The phrase list lives in ats.js (it is the union of what Simplify
  // recognises across 54 ATSes and what this project has met); this is the
  // fallback for a harness that loads this file alone.
  const SUBMITTED_RE = ATS?.SUBMITTED_RE
    || /thank(?:s| you) for (?:applying|your application|submitting)|application (?:has been |was )(?:submitted|received|sent|completed)|(?:successfully|you have) (?:submitted|applied)|we (?:have )?(?:got|received) your application/i;

  /**
   * "You have already applied for this position." Nothing to do here but say
   * so. Workday dates it instead — "You applied for this job on September 2,
   * 2026." above a View Application link, no Apply anywhere — and that read
   * as "no form here yet" on a Jabil posting he had sent on the 2nd (F-371).
   */
  const ALREADY_RE = /you(?:'ve| have) already applied|already applied (?:for|to) this|application (?:was )?already (?:submitted|received)|you have applied to this (?:job|position|role)|you applied (?:for|to) this (?:job|position|role) on [A-Z][a-z]+ \d{1,2},? \d{4}/i;
  function alreadyApplied() {
    const t = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    const m = t.match(ALREADY_RE);
    return m ? m[0] : null;
  }

  function applicationDone() {
    const real = allControls()
      .filter((el) => visible(el) && !siteFurniture(el));
    if (real.length > 0) return null;
    // A PAGE THAT STILL OFFERS APPLY OR SUBMIT IS NOT DONE, whatever it says.
    // Workday's Review step has no inputs and reads "make sure your application
    // is complete" above the Submit button; a posting thanks him for his
    // interest above Apply. Calling either "sent" would stand the tab down and
    // show a tick for an application that was never sent — the one claim
    // this extension must never make.
    if (applyControl()) return null;
    const offersSubmit = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
      .some((b) => onScreen(b) && (FINAL_RE.test(text(b) || b.value || '') || SUBMIT_RE.test(text(b) || b.value || '')));
    if (offersSubmit) return null;
    // Some ATSes say it in the URL before they say it on the page.
    if (ATS?.CONFIRMATION_URL_RE?.test(location.pathname)) return `confirmation page (${location.pathname})`;
    // A CANDIDATE'S OWN DASHBOARD lists his applications and their statuses
    // ("Application Submitted", "jobs you have applied to") — it is never the
    // confirmation of the one in front of him (iCIMS /jobs/dashboard, Werfen,
    // 2026-09-24).
    if (/\/(dashboard|my-?applications|candidate-?home|candidatehome|myprofile)\b/i.test(location.pathname)) return null;
    // The headline, not the whole page: a confirmation leads with it.
    const t = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    const m = t.match(SUBMITTED_RE);
    return m ? m[0] : null;
  }

  /**
   * Does this page look like an APPLICATION, as opposed to any page with a
   * form on it?
   *
   * A run he clicked for fills whatever is in front of him; that is what the
   * click means. A run nobody clicked for — the armed tab landing on a page —
   * needs a reason to believe the page is the application it is following,
   * because under the permissions that make following possible, "any page
   * with a form" includes a vendor's contact form and a newsletter box. A
   * file input, an ATS host, an ATS form marker, an apply-shaped URL, or
   * simply enough fields to be a form worth filling: any one will do.
   */
  function looksLikeApplication() {
    const real = allControls()
      .filter((el) => visible(el) && !siteFurniture(el));
    if (real.some((el) => el.type === 'file')) return true;
    if (real.length >= 4) return true;
    if (document.querySelector('[data-automation-id^="formField-"], #application_form, #application-form, .application-form, [data-qa*="application" i], form[action*="apply" i], form[id*="apply" i], [class*="application-form" i]')) return true;
    if (ATS?.isAtsHost?.(location.href)) return true;
    return /\/(?:apply|application|applications|applicant|candidate|careers?|jobs?)(?:\/|\?|$)/i.test(location.pathname);
  }

  /**
   * Decline the cookie banner, once per document, and say which button it was.
   *
   * Stryker's banner covered the posting on 2026-09-03 and had to be declined
   * by hand before Apply could be pressed; the rule was written down then and
   * built now. The choice is always the most private one — decline, reject,
   * necessary only — never Accept, and never "Manage" (which opens a settings
   * pane rather than closing anything). A bare Close/Dismiss is taken only
   * when the banner offers no decline at all.
   *
   * A banner is a visible region that talks about cookies, is fixed or a
   * dialog or named like one, holds no form fields, and is not the page.
   */
  const COOKIE_DECLINE_RE = /^(?:decline(?: all)?(?: cookies)?|reject(?: all)?(?: cookies)?|refuse(?: all)?|deny(?: all)?|(?:only |just )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?(?: only)?|(?:accept )?(?:only )?(?:necessary|essential)(?: cookies)?(?: only)?|no,? thanks|continue without (?:accepting|cookies)|(?:i )?do not accept|opt[ -]?out|use (?:necessary|essential) cookies only)$/i;
  const COOKIE_CLOSE_RE = /^(?:close|dismiss|got it|ok(?:ay)?|x|✕|×)$/i;
  // HIS RULE SINCE 2026-10-03: "can we just press consent on everything i
  // give permission i always consent anyways". Accept first; a bare close
  // next; decline only on a banner that offers nothing else.
  const COOKIE_ACCEPT_RE = /^(?:accept(?: all)?(?: cookies)?|allow(?: all)?(?: cookies)?|(?:i )?(?:agree|accept|consent)(?: (?:&|and) (?:close|continue|proceed))?|ok,? i agree|yes,? i agree|accept (?:and|&) (?:close|continue))$/i;
  function dismissCookieBanner() {
    if (dismissCookieBanner.done) return null;
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const txt = (b) => (b.textContent || b.getAttribute('aria-label') || b.value || '').replace(/\s+/g, ' ').trim();
    const named = (el) => /cookie|consent|gdpr|privacy|onetrust|truste|cc-|banner|notice/i.test(`${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('aria-label') || ''}`);
    const regions = [...document.querySelectorAll('div, section, aside, dialog, footer, form')]
      .filter((el) => shown(el)
        && /\bcookies?\b/i.test(el.textContent || '')
        && (el.textContent || '').length < 4000
        && !el.querySelector('input:not([type=button]):not([type=submit]):not([type=hidden]), select, textarea')
        && (named(el) || el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog' || getComputedStyle(el).position === 'fixed'))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    for (const region of regions) {
      const buttons = [...region.querySelectorAll('button, a, [role="button"], input[type="button"]')].filter(shown);
      const decline = buttons.find((b) => COOKIE_ACCEPT_RE.test(txt(b)))
        || buttons.find((b) => COOKIE_CLOSE_RE.test(txt(b)))
        || buttons.find((b) => COOKIE_DECLINE_RE.test(txt(b)));
      if (!decline) continue;
      dismissCookieBanner.done = true;
      const label = txt(decline);
      decline.click();
      return label;
    }

    // THE BUTTON ITSELF, when nothing around it is named (F-389).
    //
    // Workday's own banner sits in divs whose classes are build hashes
    // (css-w89go0), is positioned `static`, and is not a dialog — so no region
    // above qualifies and the banner stayed up through the whole run.
    // Screenshotted on HP's tenant, 2026-09-07. Its decline control names
    // itself: `data-automation-id="legalNoticeDeclineButton"`. Any button that
    // reads like a decline is taken too, but only when the block it sits in
    // actually talks about cookies and holds no form fields — the guard the
    // region pass uses, applied upwards from the button instead of downwards
    // from a container.
    const take = (re) => [
      ...deepQuerySelectorAll('[data-automation-id*="legalNotice" i], [data-automation-id*="cookie" i], [id*="cookie" i]')
        .filter((b) => shown(b) && /^(BUTTON|A)$/.test(b.tagName) && re.test(txt(b))),
      ...deepQuerySelectorAll('button, a, [role="button"]').filter((b) => shown(b) && re.test(txt(b)) && txt(b).length < 40),
    ];
    for (const b of [...take(COOKIE_ACCEPT_RE), ...take(COOKIE_DECLINE_RE)]) {
      let el = b.parentElement;
      for (let i = 0; el && i < 6; i += 1, el = el.parentElement) {
        const t = el.textContent || '';
        if (!/\bcookies?\b/i.test(t) || t.length > 4000) continue;
        if (el.querySelector('input:not([type=button]):not([type=submit]):not([type=hidden]), select, textarea')) break;
        dismissCookieBanner.done = true;
        const label = txt(b);
        b.click();
        return label;
      }
    }
    return null;
  }

  /**
   * WHAT THE PAGE IS SAYING IN RED (his ask, 2026-10-02: "detect red sentences
   * or letters on pages when errors pop up … it would help you troubleshoot
   * the logs"). A form that refuses a step says why on the page, and mostly
   * only there: in red under the box, in a role=alert banner, beside a box
   * marked aria-invalid. The answer log held what went in, never what the
   * page answered back, so a refusal had to be described from memory.
   *
   * Reading only. Each message carries how it was recognised (`red`, `alert`,
   * `invalid`), the field it sits under, and its colour, so a log line can be
   * traced to the box without a screenshot.
   */
  const ERROR_WORD_RE = /\b(required|invalid|error|errors|must|please\s+(?:enter|select|provide|fill|complete|choose|upload|correct|answer|add|use|check)|cannot|can't|isn't\s+valid|not\s+(?:a\s+)?valid|too\s+(?:long|short|many|large)|fail(?:ed|ure)?|missing|incorrect|exceeds?|at\s+least|no\s+more\s+than|only\s+\d|did\s+not|could\s+not|couldn't|will\s+not|won't|not\s+(?:be\s+)?(?:accepted|allowed|supported|uploaded|saved|found)|doesn't\s+match|does\s+not\s+match|unable|problem|wrong|issues?\s+(?:that\s+)?needs?|needs?\s+(?:corrections?|attention|to\s+be\s+fixed))\b/i;
  const SUCCESS_RE = /\b(successfully|success|uploaded|saved|thank\s+you|complete[d]?)\b/i;
  // The static required markers every form draws in red before anything goes wrong.
  const REQUIRED_MARK_RE = /^[\s*†‡()]*(?:required(?:\s+fields?)?|indicates\s+(?:a\s+)?required(?:\s+(?:field|question)s?)?|required\s+fields?\s+are\s+marked(?:\s+with\s+an?\s+asterisk)?|fields?\s+marked\s+with\s+(?:an?\s+)?\*?\s*(?:are|is)\s+required)?[\s*†‡().:]*$/i;
  function redness(color) {
    const m = String(color || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?/i);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const a = m[4] === undefined ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : +m[4]);
    return a >= 0.4 && r >= 150 && r - g >= 70 && r - b >= 50;
  }
  // The element's OWN text — a wrapper whose child is red is not itself red.
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const fieldNear = (el) => {
    let box = el;
    for (let i = 0; i < 5 && box; i += 1, box = box.parentElement) {
      const c = box.querySelector?.('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea, [role="combobox"], [role="radiogroup"]');
      if (c) {
        try { return labelFor(c, c.type || c.tagName.toLowerCase()) || ''; } catch { return ''; }
      }
    }
    return '';
  };
  function errorsOnPage({ max = 15 } = {}) {
    const out = [];
    const seen = new Set();
    const add = (el, text, how) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 400 || seen.has(t)) return;
      if (REQUIRED_MARK_RE.test(t)) return;
      if (SUCCESS_RE.test(t) && !ERROR_WORD_RE.test(t)) return;
      seen.add(t);
      let color = '';
      try { color = getComputedStyle(el).color; } catch { /* detached */ }
      out.push({ text: t.slice(0, 300), how, field: fieldNear(el).slice(0, 200), color });
    };
    // 1. Said as an error by the markup.
    for (const el of deepQuerySelectorAll('[role="alert"], [aria-live="assertive"], [data-automation-id*="rror"], [class*="error" i], [class*="invalid" i], [id*="error" i]')) {
      if (!onScreen(el) || el.querySelector('input, select, textarea')) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      // AN ALERT IS NOT AN ERROR BY BEING ONE (F-670). Workday and Oracle
      // announce "Saving", "Done", "You're all set", "… page is loaded" through
      // role="alert"; 20 of the first 37 logged lines were those.
      if (t && (ERROR_WORD_RE.test(t) || redness(getComputedStyle(el).color))) add(el, t, 'alert');
    }
    // 2. The message a box marked invalid points at.
    for (const box of deepQuerySelectorAll('[aria-invalid="true"]')) {
      if (!onScreen(box)) continue;
      const ids = String(box.getAttribute('aria-describedby') || box.getAttribute('aria-errormessage') || '').split(/\s+/).filter(Boolean);
      const said = ids.map((id) => box.getRootNode().getElementById?.(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
      const label = (() => { try { return labelFor(box, box.type || box.tagName.toLowerCase()) || ''; } catch { return ''; } })();
      const t = said || `marked invalid: ${label || box.name || box.id || box.tagName.toLowerCase()}`;
      if (!seen.has(t)) {
        seen.add(t);
        out.push({ text: t.slice(0, 300), how: 'invalid', field: label.slice(0, 200), color: '' });
      }
    }
    // 3. Anything drawn in red: a sentence, a word, a single letter's warning.
    const all = deepQuerySelectorAll('body *');
    for (let i = 0; i < all.length && i < 6000; i += 1) {
      const el = all[i];
      if (/^(SCRIPT|STYLE|NOSCRIPT|OPTION|SVG|PATH|INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) continue;
      const t = ownText(el);
      if (!t || t.length < 2) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch { continue; }
      if (!redness(cs.color) || !onScreen(el)) continue;
      // A red brand heading or link is not a message: it needs an error word
      // or a box beside it.
      if (!ERROR_WORD_RE.test(t) && !fieldNear(el)) continue;
      if (/^(A|BUTTON|H1|H2)$/.test(el.tagName) && !ERROR_WORD_RE.test(t)) continue;
      add(el, (el.textContent || t), 'red');
    }
    return out.slice(0, max);
  }

  /**
   * WHAT IS ON THE PAGE THAT THE PLAN NEVER SAW (2026-10-03, "how do we make
   * this robust"). 263 fields since 09-26 went out "not planned": AMAT's
   * readonly radios, Paylocity's label-swallowing menus, Oracle's grid rows,
   * Workday's repeated language rows. Each was invisible for weeks because a
   * field discover() drops is reported nowhere. This lists every control a
   * person can see and answer that no discovered field covers — so a miss is
   * logged and shown on the run it happens, not found by him.
   *
   * Covered = the control is a field's element, inside one or holding one,
   * shares a radio/checkbox name or a Workday wrapper with one, or its label
   * holds one. Never counted: honeypots and site furniture (discover's own
   * tests), search boxes, sliders, cookie notices, the extension's own panel,
   * an open list's rows, disabled controls.
   */
  const UNSEEN_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=search]):not([type=range]):not([type=color]), select, textarea, [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [contenteditable="true"], button[aria-haspopup="listbox"]';
  function unseenControls(fields = null, { max = 20 } = {}) {
    const out = [];
    try {
      const list = Array.isArray(fields) ? fields : discover();
      const els = list.flatMap((f) => f.elements || []).filter(Boolean);
      const covered = new Set(els);
      const names = new Set(els.map((e) => e.name).filter(Boolean));
      const wraps = new Set(els.map((e) => e.closest?.('[data-automation-id^="formField-"]')).filter(Boolean));
      const drawn = (el) => onScreen(el) || [...(el.labels || [])].some(onScreen);
      for (const el of deepQuerySelectorAll(UNSEEN_SEL)) {
        if (covered.has(el) || el.disabled) continue;
        // A LOCKED BOX IS NOT A QUESTION (F-716): Lam's Email, read-only once
        // he is signed in, was reported as missed. Eightfold's read-only radios
        // and a read-only combobox trigger are still answerable, so kept.
        if ((el.readOnly || el.getAttribute('aria-readonly') === 'true') && !/^(radio|checkbox)$/i.test(el.type || '')
          && !el.getAttribute('role') && !el.getAttribute('aria-haspopup')) continue;
        // …AND A READ-ONLY PICKER THAT ALREADY SHOWS A VALUE IS ANSWERED (F-737).
        // Micron's Eightfold signature Date sets itself to today ("16 Oct
        // 2026"), and every run told him "Date (on the page, but Jarvis never
        // saw it — answer it yourself)" about a box that was already filled.
        if ((el.readOnly || el.getAttribute('aria-readonly') === 'true') && !/^(radio|checkbox)$/i.test(el.type || '')
          && String(el.value || '').trim()) continue;
        if (!drawn(el)) continue;
        if (el.closest?.('#jarvis-overlay, [role="listbox"], [role="grid"], [role="menu"], .react-datepicker, video, audio')) continue;
        if (el.getRootNode?.()?.host?.id === 'jarvis-overlay') continue;
        if (siteFurniture(el)) continue;
        // Work/education/language/website entries are filled by the entry
        // filler from his history, not by the plan.
        if (insideEntry(el) || /dateSection/.test(el.getAttribute('data-automation-id') || '')) continue;
        if (el.name && names.has(el.name)) continue;
        const w = el.closest?.('[data-automation-id^="formField-"]');
        if (w && wraps.has(w)) continue;
        if (els.some((e) => e.contains?.(el) || el.contains?.(e))) continue;
        if ([...(el.labels || [])].some((l) => els.some((e) => l.contains(e)))) continue;
        let near = '';
        for (let n = el.parentElement; n && !near && n !== document.body; n = n.parentElement) near = (n.querySelector('label, legend')?.textContent || '').trim();
        if (/\bcookies?\b/i.test(near)) continue;
        let label = '';
        try { label = labelFor(el, el.type || el.getAttribute('role') || el.tagName.toLowerCase()) || ''; } catch { label = ''; }
        label = String(label || near || el.getAttribute('aria-label') || el.name || el.id || '').replace(/\s+/g, ' ').trim();
        // One line per question: a radio group's options are one miss, not five.
        if (/^(radio|checkbox)$/i.test(el.type || '') || /^(radio|checkbox)$/.test(el.getAttribute('role') || '')) {
          label = label.replace(/\s+—\s+[^—]*$/, '');
          if (el.name) { if (names.has(el.name)) continue; names.add(el.name); }
        }
        out.push({
          el,
          label: label.slice(0, 200),
          kind: `${el.tagName.toLowerCase()}${el.type && el.tagName === 'INPUT' ? `[${el.type}]` : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`,
          required: el.required || el.getAttribute('aria-required') === 'true',
        });
        if (out.length >= max) break;
      }
    } catch { /* a check, never the fill */ }
    // One line per question: a radio group's options are one miss, not five.
    const seen = new Set();
    return out.filter((u) => { const k = `${u.label}|${u.el.name || ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  globalThis.__jarvis = {
    errorsOnPage, redness, unseenControls,
    labelFor, optionText, groupKey, visible, discover, setNativeValue, enterText,
    fieldKey, promptOf, isCombobox, comboValue, nextControl, stepSignature, expandSections, settle, startGate, signInWall, signInWallKind, applyControl,
    wouldSubmit, advanceBlockedBy, postingGone, pageBlocked, atsMoved,
    readPosting, postingFromJsonLd, postingFromDom, htmlToText, applicationDone, alreadyApplied, looksLikeApplication, ssoControl, waitForSomething,
    dismissCookieBanner, COOKIE_DECLINE_RE, consentGate,
    experienceSections, ENTRY_IDS, ENTRY_PRIMARY, insideEntry,
    SUBMIT_RE, FINAL_RE, NEXT_RE, OTP_RE,
    deepQuerySelectorAll, allControls, clickTarget, parentOf, onScreen, headingAbove, buttonName,
  };
})();
