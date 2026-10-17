/**
 * Jarvis Apply — the filler.
 *
 * Injected into the page he is looking at, on click, in every frame. It asks
 * discover.js what is on the page, asks the server what to do about it, and does
 * exactly that.
 *
 * IT DECIDES NOTHING. There is no answer table here, no profile, no rule about
 * consent boxes. Those took twelve rounds against live forms to get right and
 * live in jarvis/apply/_answers.mjs, where they are tested; a second copy in a
 * content script would drift within a week and nobody would notice until an
 * employer read the result.
 *
 * IT NEVER SUBMITS. There is no code path here that clicks a submit control.
 * That is not a setting, and the server refuses to send an action that would.
 *
 * IT FOLLOWS HIM. One press on the toolbar ARMS the tab (background.js), and
 * from then on the worker re-injects this file on every page the tab lands on,
 * while this file itself watches the page for the next step to appear. So the
 * things that used to cost a second click — an Apply link that navigates, a
 * sign-in he does himself, a verification code, a step he had to finish by
 * hand before pressing Save and Continue — cost nothing now. The walk resumes
 * wherever the form does.
 *
 * A run that follows him is not the same as the run he started. It must never
 * write over what is already on the form, because after the first pass
 * everything there is either ours or HIS correction — see `keepExisting`.
 */
(() => {
  const {
    discover, setNativeValue, enterText, SUBMIT_RE, nextControl, stepSignature, expandSections, settle, startGate, signInWall, signInWallKind, applyControl, atsMoved,
    advanceBlockedBy, comboValue, postingGone, pageBlocked, readPosting, applicationDone, alreadyApplied, looksLikeApplication, ssoControl, waitForSomething, dismissCookieBanner, experienceSections, ENTRY_IDS, ENTRY_PRIMARY, deepQuerySelectorAll, labelFor, allControls, onScreen, headingAbove, buttonName, wouldSubmit,
    errorsOnPage, consentGate, unseenControls,
  } = globalThis.__jarvis || {};
  /**
   * WHOSE FILES. The worker keeps the dashboard's person in storage
   * (`jarvisPerson`); a file the server sent without a name falls back to
   * theirs. The original user's name until that is read.
   */
  let PERSON_NAME = 'Alex Rivera';
  try {
    chrome.storage?.local?.get?.('jarvisPerson')?.then?.((s) => {
      const n = s?.jarvisPerson?.fullName;
      if (typeof n === 'string' && n.trim()) PERSON_NAME = n.trim();
    })?.catch?.(() => {});
  } catch { /* no storage here: the default name stands */ }
  /** Apply through somebody else's account: never chosen for him (F-347). */
  const SOCIAL_APPLY_RE = /linkedin|indeed|google|facebook|seek\b|xing|glassdoor|apple|microsoft/i;
  /**
   * WHAT TO SAY ABOUT A WALL. "Sign in here" over a page with no sign-in
   * button and no password box is confusing advice: iCIMS' /login (measured on
   * Joby, 2026-09-06) asks only for an email, and there is nothing to sign
   * into yet. `panel` is the sentence in the on-page panel, `short` the one
   * the dashboard and the side panel record.
   */
  function wallWords(armed) {
    const kind = (signInWallKind && signInWallKind()) || 'signin';
    if (kind === 'email') {
      return armed
        ? { panel: 'This employer wants your email before the form. Give it here and follow what it sends; the form fills by itself once you are through.',
          short: 'this employer asks for your email first — give it here, and the form fills by itself once you are through' }
        : { panel: 'This employer wants your email before the form. Give it here, then click Jarvis again.',
          short: 'this employer asks for your email first, then click Jarvis again' };
    }
    return armed
      ? { panel: 'Sign in here, or create the account. Signing in is yours; the form fills by itself once you are in.',
        short: 'sign in here — the form fills by itself once you are in' }
      : { panel: 'Sign in here, or create the account, then click Jarvis again. Signing in is yours.',
        short: 'sign in here, or create the account, then click Jarvis again' };
  }

  /** What the page calls the job, for the server to match when the URL does not say (F-330). */
  // An <h2> when the page has no <h1>: ADP's form names its job only in
  // <h2 class="applying-for-title">Applying for …</h2> (2026-10-16).
  const pageHeading = () => ((document.querySelector('h1') || document.querySelector('h2.applying-for-title, h2'))?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  /**
   * COMMIT A CUSTOM VALUE TO AN AUTOCOMPLETE COMPONENT (F-354).
   *
   * SmartRecruiters' Title, Company and Office location are <spl-autocomplete
   * allowcustomvalues> hosts whose suggestion list opens only on a real
   * keystroke; text typed into the inner box stays visible and the form still
   * says "Please provide title". Measured 2026-09-05: what the component's
   * form model listens for is its `value` ATTRIBUTE plus a `spl-change` event
   * carrying `detail.value` — after which Save accepts the entry. Only a host
   * that declares `allowcustomvalues` is given one; a list-only box (City on
   * the same form) is left to its list.
   */
  function commitComponentValue(el, value) {
    let host = el?.getRootNode?.()?.host || null;
    for (let i = 0; host && i < 3; i += 1) {
      const tag = host.tagName.toLowerCase();
      if (host.hasAttribute('allowcustomvalues') || /-autocomplete$/.test(tag)) break;
      host = host.getRootNode?.()?.host || null;
    }
    if (!host || !host.hasAttribute('allowcustomvalues')) return null;
    host.setAttribute('value', String(value));
    for (const name of ['spl-change', 'change']) {
      host.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail: { value: String(value) } }));
    }
    return host;
  }

  /** Is this box or radio on — a real input's `checked`, or an ARIA one's `aria-checked` (F-334). */
  // …or a styled box standing in for a hidden native input (Rippling,
  // 2026-09-24): the box is what gets clicked, the input inside says whether it took.
  // …or one of Ashby's Yes/No buttons (2026-09-25): pressed, or styled as
  // the chosen one; "Yes" also ticks the hidden checkbox beside it.
  const isOn = (el) => {
    if (typeof el.checked === 'boolean') return el.checked;
    if (el.tagName === 'BUTTON') {
      if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true') return true;
      if (/(^|[\s_-])(active|selected|checked|chosen)(?=[\s_-]|$)/i.test(String(el.className || ''))) return true;
      const box = /^\s*yes\s*$/i.test(el.textContent || '') && el.parentElement?.parentElement?.querySelector('input[type="checkbox"]');
      return !!box?.checked;
    }
    const aria = el.getAttribute('aria-checked');
    if (aria != null) return aria === 'true';
    const inner = el.querySelector?.('input[type="radio"], input[type="checkbox"]');
    return inner ? inner.checked : false;
  };
  /**
   * A PAUSE THAT STAYS A PAUSE IN A BACKGROUND TAB (F-355, widened by F-464).
   *
   * He presses Fill and then looks at another tab. Chrome slows a hidden tab's
   * timers to one a second, and after five minutes hidden it slows any timer
   * CHAINED more than five deep to ONE A MINUTE. Every wait in this file is a
   * chain of short timers, so a form that fills in seconds on screen crawled or
   * ran out of budget behind another tab — his words, 2026-09-14: *"there seems
   * to be issue with clicking off screen or tab the extension does not fill as
   * well as when u are looking at it."*
   *
   * The CHAIN is what gets throttled, so the chain is broken: each timer hands
   * over through a message port, and the next timer starts from a message task
   * at nesting level zero. Every pause then costs at most about a second
   * hidden, never a minute.
   *
   * This lived inside the entries step and covered only that step (F-355);
   * every other wait in this file was still a raw chained setTimeout. It is
   * module-level now and it is the ONLY way this file waits. Do not write
   * `pause(n)` here again.
   */
  //
  // AND A HIDDEN TAB'S TIMERS STILL NEVER FIRE SOONER THAN ONCE A SECOND
  // (2026-09-25, "why is jarvis fill speed now painfully slow"): a 120 ms poll
  // cost a whole second, eight times over, on every dropdown. Hidden, the wait
  // is kept by the extension's worker, whose timers are not held back
  // (background.js, "A CLOCK FOR A HIDDEN TAB"). The page timer still runs
  // beside it as the fallback, so a worker that never answers costs a second,
  // not the run.
  const pause = (ms) => new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(); } };
    if (document.visibilityState === 'hidden' && ms > 0) {
      try {
        chrome.runtime.sendMessage({ type: 'sleep', ms }, () => { void chrome.runtime.lastError; finish(); });
      } catch { /* the extension was reloaded under this page: the timer below still ends it */ }
    }
    let port;
    try { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); finish(); }; port = ch.port2; } catch { /* no ports here */ }
    setTimeout(() => (port ? port.postMessage(0) : finish()), ms);
  });

  /**
   * WHERE THE RUN'S TIME ACTUALLY WENT (F-465).
   *
   * Micron's form is long and he says it struggles. Any speed work on it that
   * starts before the measurement is guesswork, and this file has four places
   * a long form can spend a minute: the written answers, the resume, the
   * prompt widgets and the experience entries. They are counted here and
   * printed with the done line, so the next run on a form that feels slow says
   * which one it was.
   *
   * Counting only. Nothing branches on these numbers.
   */
  const SPENT = { answers: 0, resume: 0, prompts: 0, entries: 0, began: Date.now() };
  const timed = async (bucket, fn) => {
    const t = Date.now();
    try { return await fn(); } finally { SPENT[bucket] += Date.now() - t; }
  };

  /** An ARIA control re-renders after a click; give it a beat before reading it back. */
  const settleAria = async (el) => { if (typeof el.checked !== 'boolean') await pause(80); };
  if (!discover) return { error: "discover.js did not load", filled: 0, checked: 0, uploaded: false };

  /**
   * WHAT KIND OF RUN THIS IS, set by the worker before it injects the files.
   *
   *   armed    the tab follows him: install the watcher when the run ends
   *   auto     nobody clicked for this run — a navigation or the watcher
   *            started it — so never write over a value already on the form
   *   started  he began THIS application himself (his press followed Apply,
   *            or the tab was opened by that press). Only then may a run
   *            nobody clicked for follow an Apply control: a posting he merely
   *            navigated the armed tab to is read, never applied to.
   *   id       the application this tab belongs to, when the server has said
   *
   * Absent when the file is loaded some other way (the test harnesses inject
   * it bare), in which case it behaves exactly as it did before armed mode:
   * one click, one walk, no watcher.
   */
  const RUN = Object.assign({ armed: false, auto: false, started: false, id: null }, globalThis.__jarvisRun || {});

  // INJECTED AGAIN INTO A DOCUMENT IT IS ALREADY IN. The worker re-injects on
  // every navigation of an armed tab, and a soft navigation (Workday moving
  // between steps with pushState) keeps the document — so this file arrives a
  // second time with everything below already defined. Redefining it would
  // start a second watcher beside the first. Hand the request to the copy
  // that is already here —
  //
  // UNLESS THAT COPY IS FROM A PREVIOUS LOAD OF THE EXTENSION. A reload does
  // not clear the isolated world of pages already open, and the copy left in
  // it has a `chrome.runtime` that only throws. The worker stamps every
  // injection with its load id; a resident from another load is told to stop
  // and replaced.
  const prior = globalThis.__jarvisContent;
  if (prior && prior.loadId === RUN.loadId) return prior.again(RUN);
  if (prior) {
    console.log('[jarvis] a copy from a previous load of the extension is in this page — replacing it');
    try { prior.stopWatching(); } catch { /* its context is gone */ }
  }

  // A DEAD EXTENSION CONTEXT LOOKS LIKE A BROKEN FEATURE.
  //
  // Reloading the extension does not clear the isolated world of pages that
  // are already open. The copy of this script left in them keeps running with
  // a `chrome.runtime` that only throws "Extension context invalidated." — so
  // every "ask Claude" link printed that sentence under itself, which names
  // the machinery and tells him nothing he can do. The page has to be loaded
  // again before this script can reach the worker, and that is the whole
  // message. Nothing here reloads it for him: a reload on a half-filled
  // application throws away the answers already in the boxes.
  const RELOAD_ME = 'Jarvis was updated after this page opened — reload the page, then Fill this page again.';
  const contextGone = (e) => /context invalidated|receiving end does not exist/i.test(String(e?.message || e));
  const send = (msg) => new Promise((resolve) => {
    const fail = (e) => resolve({ ok: false, gone: contextGone(e), error: contextGone(e) ? RELOAD_ME : String(e?.message || e) });
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        const err = chrome.runtime.lastError;
        if (err) fail(err); else resolve(reply);
      });
    } catch (e) { fail(e); }
  });
  // CAN THIS PAGE REACH THE EXTENSION AT ALL? No in a harness, and no on a
  // page opened before the extension was reloaded — the two cases where the
  // report is drawn on the page because there is no side panel to send it to.
  const reachable = () => { try { return !!chrome?.runtime?.id; } catch { return false; } };

  /**
   * WHAT WENT OUT, NOT ONLY WHAT WAS PLANNED. His ask, 2026-09-24: "it should
   * also record which questions were unasnwered/changed from what it answerred
   * versus when i submitted yes so it can see trhe difference". The answer log
   * held the engine's plan; the form he actually sent could differ in every
   * box he touched. So when a Next / Continue / Submit control is pressed —
   * by him or by the walk — every field on the page is read as it stands and
   * sent to the dashboard, which compares it with the plan (answer-log.mjs).
   *
   * Every step, not just the last: Workday's Submit sits on a Review page with
   * no inputs on it, so the values have to be caught on the way through.
   * Reading only; nothing here changes the page or presses anything.
   */
  // Its own copy: the filler's is declared far below, and a script that
  // returns early never reaches it.
  const SNAP_PLACEHOLDER_RE = /^\s*(select|choose|please select|please choose|--|—|none selected|no selection)?\s*(one|an option|a value)?\s*[.:…-]*\s*$/i;
  const SNAP_NEXT_RE = /^\s*(save and continue|save & continue|continue|next|next step|save and next|review|proceed)\s*$/i;
  function valueNow(f) {
    const els = f.elements || [];
    const el = els[0];
    const optText = (o) => String(o?.text ?? o ?? '').trim();
    try {
      // ONE BOX IS TICKED OR NOT (2026-09-25). `current` for a Workday
      // checkbox is its LABEL when ticked ("I am fluent in this language. |
      // …"), so every snapshot logged the box as "changed" and hid whether
      // the tick had landed. The box's own state first; an ARIA box too.
      if (f.type === 'checkbox' && els.length <= 1 && el) {
        if (typeof el.checked === 'boolean' && el.tagName === 'INPUT') return el.checked ? 'checked' : 'unchecked';
        const aria = el.getAttribute?.('aria-checked');
        if (aria === 'true' || aria === 'false') return aria === 'true' ? 'checked' : 'unchecked';
      }
      // …and a group whose copies all say the same thing is one box (F-369):
      // Workday's fluent box read as its text twice, never as ticked (F-670).
      if (f.type === 'checkbox' && els.length > 1 && new Set((f.options || []).map((o) => optText(o).toLowerCase())).size === 1) {
        const on = els.filter(isOn).length;
        return on === els.length ? 'checked' : on ? `${on} of ${els.length} checked` : 'unchecked';
      }
      if (f.current !== undefined) return String(f.current || '');
      if (el?.tagName === 'SELECT') {
        const o = el.options[el.selectedIndex];
        return o && el.selectedIndex >= 0 && !SNAP_PLACEHOLDER_RE.test(o.textContent || '') ? o.textContent.trim() : '';
      }
      if (f.type === 'radio' || (f.type === 'checkbox' && els.length > 1)) {
        return els.map((e, i) => (isOn(e) ? optText(f.options?.[i]) || String(e.value || '') : null)).filter(Boolean).join(' | ');
      }
      if (f.type === 'checkbox') return el?.checked ? 'checked' : 'unchecked';
      if (f.type === 'file') return f.attached ? `${f.attached} file(s) attached` : '';
      return String(el?.value ?? '');
    } catch { return ''; }
  }
  function snapshotOnPress(ev) {
    try {
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
      const control = path.find((n) => n?.tagName && (/^(BUTTON|A)$/.test(n.tagName)
        || (n.tagName === 'INPUT' && /^(submit|button|image)$/i.test(n.type || ''))
        || n.getAttribute?.('role') === 'button'));
      if (!control) return;
      const name = String((buttonName && buttonName(control)) || control.value || control.textContent || '').replace(/\s+/g, ' ').trim();
      const auto = control.getAttribute?.('data-automation-id') || '';
      const stage = SUBMIT_RE && SUBMIT_RE.test(name) ? 'submit'
        : (SNAP_NEXT_RE.test(name) || /pageFooterNextButton|bottom-navigation-next-button/.test(auto)) ? 'step' : '';
      if (!stage || !discover) return;
      const fields = discover().filter((f) => f.label).map((f) => ({
        // Workday's key tells two fields with one label apart: Legal Name and
        // Preferred Name both say "First Name" (2026-09-26).
        label: f.label, type: f.type, ...(f.key ? { key: String(f.key).slice(0, 120) } : {}),
        // A split date's three boxes share one key (F-618).
        ...(f.datePart ? { datePart: f.datePart } : {}),
        options: (f.options || []).slice(0, 25).map((o) => String(o?.text ?? o).slice(0, 80)),
        value: valueNow(f).slice(0, 4000),
      }));
      if (!fields.length) return;
      send({ type: 'snapshot', stage, button: name.slice(0, 80), by: ev.isTrusted ? 'you' : 'jarvis', pageUrl: location.href, heading: pageHeading(), pageTitle: document.title, fields });
    } catch { /* a record, never the form */ }
  }
  // AFTER HIS SUBMIT, WAIT FOR THE THANK-YOU (2026-10-02). Ashby keeps the
  // same URL and swaps the form for "Thank you for applying" only when its
  // upload finishes; the one check after the press ran five seconds in, saw
  // the posting, and nothing looked again — Capable, Charge Robotics, Kovari,
  // Haast, 1X and Collaborative Robotics were sent and never marked applied.
  // So the page is read every 1.5 s for two minutes, and a confirmation goes
  // to the worker exactly as a run's would: the card moves to Applied and
  // the tab stands down. Nothing is pressed.
  function watchAfterPress(ev) {
    try {
      if (!ev.isTrusted) return;
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
      const control = path.find((n) => n?.tagName && (/^(BUTTON|A)$/.test(n.tagName)
        || (n.tagName === 'INPUT' && /^(submit|button|image)$/i.test(n.type || ''))
        || n.getAttribute?.('role') === 'button'));
      if (!control) return;
      const name = String((buttonName && buttonName(control)) || control.value || control.textContent || '').replace(/\s+/g, ' ').trim();
      if (SUBMIT_RE && SUBMIT_RE.test(name)) watchForSent();
    } catch { /* never in the way of his press */ }
  }
  let watchingSent = false;
  function watchForSent() {
    if (watchingSent || typeof applicationDone !== 'function') return;
    watchingSent = true;
    const until = Date.now() + 120_000;
    const tick = () => {
      let said = null;
      try { said = applicationDone(); } catch { said = null; }
      if (said) {
        watchingSent = false;
        send({ type: 'filled', result: {
          frame: location.href, pageUrl: location.href, filled: 0, checked: 0, uploaded: false,
          submitted: String(said), stoppedBecause: `the page says "${said}" — this application is done`,
        } });
        return;
      }
      if (Date.now() > until) { watchingSent = false; return; }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
  }
  // WHEN HIS "SAVE AND CONTINUE" IS REFUSED (F-550). Workday runs its
  // required check on the press; a box it lost shows an error while holding
  // his text. A moment later, if the page is still here, those boxes are
  // re-entered and the corner line tells him to press again. Nothing is
  // pressed from here.
  function repairAfterPress(ev) {
    try {
      if (!ev.isTrusted) return;
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
      const control = path.find((n) => n?.tagName === 'BUTTON' || n?.getAttribute?.('role') === 'button');
      if (!control) return;
      const name = String((buttonName && buttonName(control)) || control.textContent || '').replace(/\s+/g, ' ').trim();
      const auto = control.getAttribute?.('data-automation-id') || '';
      if (!(SNAP_NEXT_RE.test(name) || /pageFooterNextButton|bottom-navigation-next-button/.test(auto))) return;
      const at = location.href;
      setTimeout(async () => {
        if (location.href !== at || typeof reassertStale !== 'function') return;
        const r = await reassertStale();
        if (r.repaired.length) chip(`Jarvis re-entered ${r.repaired.length} field${r.repaired.length > 1 ? 's' : ''} Workday had lost — press ${name || 'Save and Continue'} again`, { summary: true });
      }, 1500);
    } catch { /* never in the way of his press */ }
  }
  if (!globalThis.__jarvisRepairOn && reachable()) {
    globalThis.__jarvisRepairOn = true;
    document.addEventListener('click', repairAfterPress, true);
  }
  if (!globalThis.__jarvisSentWatchOn && reachable()) {
    globalThis.__jarvisSentWatchOn = true;
    document.addEventListener('click', watchAfterPress, true);
  }
  if (!globalThis.__jarvisSnapshotOn && reachable()) {
    globalThis.__jarvisSnapshotOn = true;
    document.addEventListener('click', snapshotOnPress, true);
  }
  // WHAT THE PAGE SAID BACK (his ask, 2026-10-02). Red text, alert banners and
  // boxes marked invalid go to the dashboard's page-error log
  // (data/jarvis/page-errors.jsonl, `npm run jarvis:page-errors`), so a step
  // that would not move is logged with the form's own words. Read 1.5 s and
  // 4 s after any Next / Submit press (his or the walk's), and whenever the
  // page changes on a form — a message drawn on blur counts too. Each
  // message once per page; reading only.
  const ERRORS_SENT = new Set();
  function reportPageErrors(trigger) {
    try {
      if (typeof errorsOnPage !== 'function') return;
      const fresh = errorsOnPage().filter((e) => !ERRORS_SENT.has(`${location.pathname}|${e.text}`));
      if (!fresh.length) return;
      for (const e of fresh) ERRORS_SENT.add(`${location.pathname}|${e.text}`);
      send({ type: 'page-errors', trigger, pageUrl: location.href, heading: pageHeading(), pageTitle: document.title, errors: fresh });
    } catch { /* a record, never the form */ }
  }
  function errorsAfterPress(ev) {
    try {
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
      const control = path.find((n) => n?.tagName && (/^(BUTTON|A)$/.test(n.tagName)
        || (n.tagName === 'INPUT' && /^(submit|button|image)$/i.test(n.type || ''))
        || n.getAttribute?.('role') === 'button'));
      if (!control) return;
      const name = String((buttonName && buttonName(control)) || control.value || control.textContent || '').replace(/\s+/g, ' ').trim();
      const auto = control.getAttribute?.('data-automation-id') || '';
      const isSubmit = SUBMIT_RE && SUBMIT_RE.test(name);
      if (!isSubmit && !SNAP_NEXT_RE.test(name) && !/pageFooterNextButton|bottom-navigation-next-button/.test(auto)) return;
      const trigger = `after ${ev.isTrusted ? 'your' : 'Jarvis\'s'} press of "${name.slice(0, 60)}"`;
      setTimeout(() => reportPageErrors(trigger), 1500);
      setTimeout(() => reportPageErrors(trigger), 4000);
      watchErrors();
    } catch { /* never in the way of his press */ }
  }
  let errorObserver = null;
  function watchErrors() {
    if (errorObserver || typeof MutationObserver !== 'function' || !document.body) return;
    let timer = null;
    let lastRun = 0;
    errorObserver = new MutationObserver(() => {
      if (timer) return;
      // Trailing, at most every 3 s: a React form re-renders on each keystroke.
      const wait = Math.max(1200, 3000 - (Date.now() - lastRun));
      timer = setTimeout(() => { timer = null; lastRun = Date.now(); reportPageErrors('appeared on the page'); }, wait);
    });
    errorObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-invalid', 'style', 'hidden'] });
  }
  if (!globalThis.__jarvisErrorsOn && reachable()) {
    globalThis.__jarvisErrorsOn = true;
    document.addEventListener('click', errorsAfterPress, true);
    // Only on a form: every page this script reaches is not an application.
    try {
      if (looksLikeApplication && looksLikeApplication()) { watchErrors(); setTimeout(() => reportPageErrors('on the page as it loaded'), 2500); }
    } catch { /* never in the way */ }
  }
  // Whether the side panel is open beside this tab, as the worker last said.
  let PANEL_OPEN = false;

  /**
   * A one-line status in the corner while a run is going.
   *
   * The report panel is painted when a run ENDS. On Eightfold the resume slot
   * is on the first screen, so the run's first act is to wait up to four
   * minutes for the tailored PDF — and until this existed those minutes showed
   * a "…" badge and nothing else, which reads as "nothing is happening" and
   * invites a second click. Says what it is doing, and how to make it stop.
   */
  /**
   * Where Jarvis draws on the page: one host element with a shadow root.
   *
   * The first panel lived straight in the page's DOM, and on a page where
   * Simplify's extension had injected its stylesheet the rows collapsed onto
   * one another — their CSS reached ours. A shadow root is the one boundary
   * page CSS and other extensions' CSS cannot cross, and `all: initial` on the
   * host stops inherited styles at the door.
   */
  /**
   * WHAT PAGE THIS IS, sent with every written answer so the server can check
   * the tab's job id against the page actually open (a stale id must not send
   * the wrong posting's description to the writer).
   */
  function pageInfo() {
    return {
      pageUrl: location.href,
      pageTitle: String(document.title || '').slice(0, 200),
      heading: String(document.querySelector('h1, h2')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      pageText: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000),
    };
  }

  /**
   * THE WRITING BOX HE WAS LAST IN (2026-09-17). "answer all of this" typed
   * into the panel is a request about that box, not a question. Our own panel
   * lives in a shadow root under #jarvis-overlay, so its boxes never count.
   */
  let LAST_BOX = null;
  document.addEventListener('focusin', (e) => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (!t || !(t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t.getRootNode?.()?.host?.id === 'jarvis-overlay') return;
    LAST_BOX = t;
  }, true);

  function overlay() {
    let host = document.getElementById('jarvis-overlay');
    if (host && host.shadowRoot) return host.shadowRoot;
    host = document.createElement('div');
    host.id = 'jarvis-overlay';
    host.style.cssText = 'all:initial;position:fixed;top:0;right:0;z-index:2147483647;pointer-events:none';
    (document.body || document.documentElement).appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6edf3; }
      #jarvis-chip, #jarvis-panel { pointer-events: auto; position: fixed; top: 14px; right: 14px; background: #12151a; border: 1px solid #30363d; box-shadow: 0 8px 28px rgba(0,0,0,.45); }
      #jarvis-chip { border-radius: 8px; padding: 7px 11px; font-size: 12.5px; display: flex; gap: 10px; align-items: center; }
      #jarvis-panel { width: 330px; max-height: 70vh; overflow: auto; border-radius: 10px; padding: 13px 15px; }
      #jarvis-panel div { margin: 0; }
      #jarvis-panel ul { margin: 4px 0 0 16px; padding: 0; }
      #jarvis-panel li { margin: 2px 0; }
      #jarvis-panel summary { list-style: none; }
      #jarvis-panel summary::-webkit-details-marker { display: none; }
      #jarvis-panel summary::after { content: ' \\25BE'; color: #79c0ff; font-size: 15px; line-height: 1; vertical-align: -1px; }
      #jarvis-panel details[open] summary::after { content: ' \\25B4'; }
      #jarvis-panel summary:hover { color: #adbac7; }
      b { font-weight: 700; }
    `;
    root.appendChild(style);
    return root;
  }

  /**
   * ONE BOX, NOT TWO STACKED ON EACH OTHER (F-502).
   *
   * The chip and the panel were both `position: fixed; top: 14px; right: 14px`,
   * so whenever both were up the chip landed square on the panel's header —
   * over the ✕, which left him with a progress line he could not dismiss and a
   * report he could not read. He saw it on a live Amazon application: the
   * panel said "Waiting. Jarvis continues by itself", and the resume wait loop
   * then drew "still writing the resume for Amazon · 0:30" straight across it.
   *
   * The fix is not to move one of them — two floating boxes fighting for the
   * same corner is the bug. When the panel is open the progress line belongs
   * INSIDE it, as the one row that changes while everything else holds still.
   * The floating chip is what a page with no panel gets, and nothing else.
   */
  /*
   * AND WITH THE SIDE PANEL OPEN, NOTHING ON THE PAGE AT ALL (2026-09-23).
   * The progress line goes to the worker, the side panel shows it under its
   * Fill button, and the page stays the form. With the panel closed the line
   * is drawn here as before, with "open the panel" on it. `summary` is the
   * one-line report after a run, already routed by its caller.
   */
  let CHIP_SEQ = 0;
  function chip(textNow, { summary = false } = {}) {
    if (window !== window.top) return;   // one chip per tab, from the top frame
    const root = overlay();
    const panel = root.getElementById('jarvis-panel');
    const live = panel && panel.querySelector('#jarvis-live');
    if (live) {
      root.getElementById('jarvis-chip')?.remove();   // never both at once
      live.hidden = !textNow;
      live.textContent = String(textNow || '');
      return;
    }
    const seq = ++CHIP_SEQ;
    if (!summary && reachable()) {
      send({ type: 'page-live', text: String(textNow || '') }).then((r) => {
        if (r?.ok) PANEL_OPEN = !!r.panelOpen;
        if (seq === CHIP_SEQ) drawChip(PANEL_OPEN ? '' : textNow);
      });
      // Drawn at once only when the panel is known to be closed, so an open
      // panel never has a line flash up beside it on every tick.
      if (PANEL_OPEN) return;
    }
    drawChip(textNow, { summary });
  }

  /*
   * A RUN'S LAST WORD OUTLIVES ITS "DONE". The run clears its progress line as
   * it finishes, and that clear used to land just after the one-line report
   * was drawn — wiping the report. Clearing progress leaves a report alone;
   * a report is replaced by the next run's progress, or removed as a report.
   */
  function drawChip(textNow, { summary = false } = {}) {
    const root = overlay();
    let el = root.getElementById('jarvis-chip');
    if (!textNow) { if (summary || el?.dataset.summary !== '1') el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'jarvis-chip';
      el.style.cssText = [
        'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483647',
        'background:#12151a', 'color:#e6edf3', 'border:1px solid #30363d',
        'border-radius:8px', 'padding:7px 11px',
        'font:12.5px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
        'box-shadow:0 6px 20px rgba(0,0,0,.4)', 'display:flex', 'gap:10px', 'align-items:center',
      ].join(';');
      root.appendChild(el);
    }
    el.dataset.summary = summary ? '1' : '0';
    const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    el.innerHTML = `<span>${esc(textNow)}</span>${reachable()
      ? '<span id="jarvis-open" style="cursor:pointer;color:#79c0ff;white-space:nowrap">open the panel</span>' : ''}${RUN.armed
      ? '<span id="jarvis-stop" style="cursor:pointer;color:#79c0ff;white-space:nowrap">stop following</span>' : ''}`;
    el.querySelector('#jarvis-stop')?.addEventListener('click', stopFollowing);
    el.querySelector('#jarvis-open')?.addEventListener('click', () => {
      send({ type: 'open-panel' }).then((r) => { if (r?.ok) { PANEL_OPEN = true; el.remove(); } });
    });
  }

  /** He asked it to stop. Tell the worker; it forgets the tab. */
  async function stopFollowing() {
    stopWatching();
    RUN.armed = false;
    chip('');
    overlay().getElementById('jarvis-panel')?.remove();
    await send({ type: 'stop', pageUrl: location.href }).catch(() => null);
  }

  /**
   * Did the page KEEP what we wrote, allowing for it reformatting the value?
   *
   * Strict equality was too strict and produced false negatives on fields that
   * normalise input. Measured on live Greenhouse forms: the phone box is an
   * `intl-tel-input`, and writing "+1 (555) 000-0000" leaves it holding
   * "+1 (555) 000-0000" — correctly filled, reported as "the page did not keep
   * the value", and not counted.
   *
   * Comparing on alphanumerics only accepts a reformat and still rejects the
   * two cases that matter: a field that silently discards the value (empty),
   * and one that replaces it with something else.
   */
  const kept_same = (got, want) => {
    const g = String(got ?? '');
    const w = String(want ?? '');
    if (g === w) return true;
    if (!g) return false;
    const bare = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (bare(g) === bare(w)) return true;
    // THE SAME NUMBER IS KEPT (F-633). Onto Innovation's Workday (2026-10-01):
    // the date boxes hold "6" and "1" for "06" and "01", and the salary box
    // keeps only "90000" of "$90000/year" — all three reported as faults to
    // fix by hand on a step that held exactly the answer. A box holding just a
    // number keeps an answer whose only digits are that number; never one
    // written with k or m ("$90k" is not a box holding "90").
    if (/^\d+$/.test(g.trim()) && /^\d+$/.test(w.trim()) && Number(g) === Number(w)) return true;
    // THE SAME PHONE NUMBER WITH ITS COUNTRY CODE ADDED (2026-10-16). ADP's
    // phone box turns "555-010-0000" into "+1 555 010 0000": same ten digits,
    // a "+1" in front, reported as lost on Therm-X's form while it held his
    // number. Only phone-shaped values, and only a 1–3 digit prefix.
    const dg = g.replace(/\D/g, ''), dw = w.replace(/\D/g, '');
    const phoneish = (x) => /^[\s+()\d.-]{7,}$/.test(x);
    if (phoneish(g) && phoneish(w) && Math.min(dg.length, dw.length) >= 10) {
      const [long, short] = dg.length >= dw.length ? [dg, dw] : [dw, dg];
      if (long.endsWith(short) && long.length - short.length <= 3) return true;
    }
    if (/^\s*\d[\d,]*\s*$/.test(g) && !/\d\s*[kKmM]\b/.test(w) && /^[\s$€£]*[\d,]+(\.0+)?\s*(\/\s*(yr|year|annum)|per\s+(year|annum)|annually|usd|a\s+year)?\s*$/i.test(w)
      && g.replace(/\D/g, '') === w.replace(/\.0+\s*/, ' ').replace(/[^\d]/g, '')) return true;
    // A PAGE THAT TIDIES A URL KEPT IT. BambooHR turns "alexrivera.example"
    // into "http://alexrivera.example" on blur (Cornelis Networks, measured
    // 2026-09-24), and the run reported "the page did not keep the value" for
    // a box holding exactly his address.
    const url = (x) => x.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(url(w)) && url(g) === url(w);
  };
  const kept = kept_same;

  /**
   * THE UPLOADER'S MARKUP, WHEN AN UPLOAD DOES NOT LAND (F-655, 2026-10-02).
   * Spirit AeroSystems' iCIMS profile planned the resume, the run never
   * reported, and the box was empty when he submitted — with nothing to say
   * why. The control's surroundings (four levels up, 24 KB at most) go to his
   * dashboard: no values, no script or style, no hidden-field contents. Sent
   * before the attempt too, because an uploader that reloads its frame on
   * `change` ends this script before it could report anything.
   */
  function captureAround(el, why, label = '') {
    try {
      let box = el;
      for (let i = 0; i < 4 && box.parentElement && box.parentElement !== document.body; i += 1) box = box.parentElement;
      const copy = box.cloneNode(true);
      copy.querySelectorAll('script, style, noscript, svg, img, iframe').forEach((x) => x.remove());
      copy.querySelectorAll('input, textarea').forEach((x) => { x.removeAttribute('value'); if (x.tagName === 'TEXTAREA') x.textContent = ''; });
      copy.querySelectorAll('[value]').forEach((x) => { if (x.tagName !== 'OPTION') x.removeAttribute('value'); });
      const html = copy.outerHTML.replace(/\s+/g, ' ').slice(0, 24000);
      send({ type: 'capture', pageUrl: location.href, why, label: String(label).slice(0, 200), html });
    } catch { /* a record, never the form */ }
  }

  async function attachResume(input) {
    captureAround(input, 'resume upload, before the attempt', labelFor ? labelFor(input, 'file') : '');
    // WAIT FOR THE RESUME RATHER THAN GIVING UP ON IT.
    //
    // Clicking Jarvis on a form the dashboard has never seen used to attach
    // nothing at all: no prepared application meant no resume, and the run
    // filled every field and uploaded none. The server now tailors one on the
    // spot for any page it can match to a posting, and answers 425 while it is
    // writing. That takes a couple of minutes, so this waits — an application
    // that arrives without a resume is worth more delay than that.
    const deadline = Date.now() + 420000; // write, check, review, rewrite
    const started = Date.now();
    let got = await send({ type: 'resume', pageUrl: location.href, heading: pageHeading(), pageTitle: document.title || '' });
    let said = false;
    while (!got?.ok && got?.status === 425 && Date.now() < deadline) {
      if (!said) { said = true; console.log(`[jarvis] ${got.error} — waiting for it`); }
      const secs = Math.round((Date.now() - started) / 1000);
      chip(`${String(got.error || 'writing the resume').replace(/ — try again in a moment$/, '')} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — it attaches when ready`);
      await pause(5000);
      got = await send({ type: 'resume', pageUrl: location.href, heading: pageHeading(), pageTitle: document.title || '' });
    }
    chip('Jarvis is filling…');
    if (!got?.ok) throw new Error(got?.error || 'no resume from the server');
    const bytes = new Uint8Array(got.bytes);
    // THE FILENAME AN ATS RECORDS IS THE ONE ON THIS FILE (F-409). It used to
    // be a fixed "Alex Rivera Resume.pdf" for every posting; he asked for his name,
    // the company and the role instead — "i want to have a signal thats what
    // you actually attached" — so the page shows him, in the chip the form
    // draws, exactly which resume went on. The server names it; this only
    // falls back if an older worker sent no name.
    const named = String(got.filename || '').trim();
    const file = new File([bytes], named || `${PERSON_NAME} Resume.pdf`, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // DID THE PAGE TAKE THE FILE, OR ONLY THE INPUT? (F-465)
    //
    // Setting `input.files` and firing `change` is enough for most ATSes and
    // for none of the rest: an uploader that listens on its DROP ZONE rather
    // than on the hidden input takes the file into the DOM and never tells its
    // own application, so the form stays empty while this reported an upload.
    // Micron (Eightfold) is where he hit it — *"the extension fails to attach
    // resume after it is done"*.
    //
    // So it is read back off the page the way he would read it: an uploader
    // that has really got the file prints its name. If the name does not
    // appear, the file is offered again as a DROP, which is the event those
    // uploaders are actually listening for.
    //
    // ASKED OF A HIDDEN INPUT ONLY, and this is the part that keeps it from
    // becoming noise. A VISIBLE `<input type=file>` is rendered by the browser
    // with the filename inside the control, which is not page text, so reading
    // the document would report every plain Greenhouse form as a failure. A
    // hidden input means the SITE drew the uploader and the site owes the
    // chip; if it never draws one, something did not land.
    //
    // Under two seconds either way, and it stops the moment the name appears.
    const ownDrawn = (() => {
      try { const s = getComputedStyle(input); return s.display === 'none' || s.visibility === 'hidden' || input.offsetParent === null; }
      catch { return false; }
    })();
    if (ownDrawn) {
      // UP TO EIGHT SECONDS FOR THE NAME. SmartRecruiters prints it only once
      // the upload has finished on its server — about 1-4 s on a real resume —
      // and 0.9 s here called a resume that landed a failure, then dropped it
      // a second time (Western Digital, 2026-09-24).
      for (let i = 0; i < 20 && !fileShowing(file.name); i += 1) { agreeToUploadNotice(); await pause(400); }
      if (!fileShowing(file.name)) {
        dropOnto(input, file);
        for (let i = 0; i < 3 && !fileShowing(file.name); i += 1) await pause(300);
      }
    }
    // TAKEN AND CLEARED IS STILL TAKEN. Rippling moves the file into its own
    // state and empties the input, then prints the name ("Alex Rivera -
    // Cinta...pdf remove", 2026-09-24) — the run said "the page did not keep
    // the file" beside a chip showing it. The chip is the evidence this
    // function already trusts; an empty input next to it is not a failure.
    // AND AN INPUT THAT EMPTIED ITSELF, whether or not it looked hidden: the
    // component took the file. SmartRecruiters' dropzone input is not hidden
    // by any of the tests above, so the name was never looked for and a
    // resume sitting in the zone was reported "the page did not keep the
    // file" (Western Digital, 2026-09-24). Wait for the name the same way.
    if (!ownDrawn && !(input.files?.length)) {
      for (let i = 0; i < 20 && !fileShowing(file.name); i += 1) { agreeToUploadNotice(); await pause(400); }
    }
    const shownNow = fileShowing(file.name);
    if (!((input.files?.length || 0) > 0 || shownNow) || (ownDrawn && !shownNow)) captureAround(input, 'resume upload did not show on the page');
    return {
      ok: (input.files?.length || 0) > 0 || shownNow,
      // Only a claim where it was checked. `null` is "no evidence either way",
      // and the caller says nothing about it — a warning nobody can act on is
      // worse than silence.
      showing: ownDrawn ? fileShowing(file.name) : null,
      name: file.name,
    };
  }

  /**
   * A NOTICE THAT HOLDS THE FILE (F-621). Micron's Eightfold form opens "Notice
   * Related to Micron's Use of the Eightfold AI Recruiting Software" the moment
   * a resume is chosen, with I Agree and Cancel, and the file goes nowhere
   * until it is answered: every Micron fill since 2026-09-25 said "attached,
   * but the page never showed the file". His standing answer to AI screening
   * and consent is yes. Only an agree/accept/acknowledge button, only inside a
   * notice that says what it is about, never Cancel, Decline or a submit.
   */
  // …AND APPLIED MATERIALS' "Data Privacy Agreement" (Eightfold, 2026-09-27):
  // "Please confirm that you agree to the Applied Materials Data Privacy
  // Policy", Cancel / Confirm, raised when the file is chosen — every AMAT fill
  // said "the page never showed the file". A bare Confirm / OK / Continue only
  // inside a MODAL DIALOG about privacy, consent or a notice that says nothing
  // of submitting, withdrawing or deleting (F-623).
  function agreeToUploadNotice() {
    try {
      const shown = (n) => { const r = n.getBoundingClientRect?.(); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'; };
      const btn = [...document.querySelectorAll('button, [role="button"]')].find((b) => {
        const said = String(b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim();
        const agree = /^(i\s+)?(agree|accept|acknowledge|consent)(\s+and\s+continue)?\.?$|^i\s+understand\.?$/i.test(said);
        const confirm = !agree && /^(confirm|ok|okay|continue)\.?$/i.test(said);
        if (!agree && !confirm) return false;
        // A submit button INSIDE A FORM is never pressed (Eightfold marks every
        // dialog button type="submit", in a dialog outside the form, where it
        // submits nothing); clickNoSubmit also blocks any submission.
        if (!shown(b) || (/submit/i.test(b.getAttribute('type') || '') && b.closest('form'))) return false;
        if (confirm) {
          const dialog = b.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
          const text = String(dialog?.innerText || '').slice(0, 4000);
          return !!dialog && /\b(privacy|consent|agree(ment)?|notice)\b/i.test(text) && !/\b(submit|submission|withdraw|delete|remove|discard)\b/i.test(text);
        }
        let box = b; for (let k = 0; k < 8 && box.parentElement; k += 1) box = box.parentElement;
        return /\b(artificial intelligence|AI|recruiting software|privacy|notice|consent|terms)\b/i.test(String(box.innerText || '').slice(0, 4000));
      });
      if (!btn) return false;
      console.log(`[jarvis] a notice held the file — pressed "${String(btn.innerText || '').trim()}"`);
      clickNoSubmit(btn);
      return true;
    } catch { return false; }
  }

  /** His name, then a .pdf on the same line — the shape every ATS chip prints. */
  const RESUME_NAME_RE = /alex\s*rivera\b[^\n]{0,90}\.pdf/i;

  /**
   * Is this file named anywhere the reader can see it?
   *
   * The page's own chip is the only honest evidence that an upload landed. The
   * filename carries his name, the employer and the role (F-409), and a form
   * may print any part of it, so a prefix counts — as does the older fixed
   * name, for a resume attached by a previous version.
   */
  function fileShowing(name) {
    try {
      // THROUGH SHADOW ROOTS TOO. SmartRecruiters prints the file name inside
      // its <spl-dropzone>'s shadow root, which document.body.innerText never
      // reads — so a resume that landed was reported "the page did not keep
      // the file", and was dropped on the zone a second time (Western
      // Digital, measured 2026-09-24).
      const shadows = deepQuerySelectorAll ? deepQuerySelectorAll('*').filter((e) => e.shadowRoot).map((e) => e.shadowRoot.textContent || '').join('\n') : '';
      const text = `${document.body?.innerText || ''}\n${shadows}`;
      if (RESUME_NAME_RE.test(text)) return true;
      // PHENOM KEEPS IT IN HIDDEN BOXES (Honda, 2026-10-03): the apply form
      // carries `#resumeName` / `#resumePath`, empty until its server has the
      // file; the uploader prints nothing a reader would see in time.
      const held = ['resumeName', 'resumePath', 'resumeRelativePath'].map((id) => document.getElementById(id)?.value || '').join(' ');
      if (held.trim() && /\.(pdf|docx?|txt|html?)\b|\//i.test(held)) return true;
      const base = String(name || '').replace(/\.pdf$/i, '').trim();
      return base.length > 8 && text.includes(base.slice(0, Math.min(base.length, 24)));
    } catch { return false; }
  }

  /**
   * Offer a file the way a person would: dropped onto the zone around the input.
   *
   * Uploaders built on a drag-and-drop zone bind their handler to the zone, not
   * to the input inside it, so this is the only event that reaches them.
   */
  function dropOnto(el, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const zone = el.closest('label, [class*="drop" i], [class*="upload" i], [class*="dropzone" i]') || el.parentElement || el;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    } catch { /* no DragEvent here, or the zone refused it — the caller still reports honestly */ }
  }

  /**
   * A WRITTEN ANSWER INTO THE BOX THAT ASKED FOR IT.
   *
   * "Tell us about a project you are proud of", "why should we hire you" —
   * questions no answer table will ever hold, because the answer is prose
   * about his own work. Every one of them used to be left blank with "no
   * answer for this question", which is how a run that filled thirty fields
   * still handed him the form back to finish.
   *
   * The server starts these when it plans the step, so by the time the filler
   * arrives the text is usually already written; when it is not, this waits
   * the way the resume and the letter do. Everything it types is checked
   * against cv.md first (jarvis/apply/essay.mjs) — a sentence he cannot
   * defend in an interview never reaches the box.
   *
   * Returns the problems the check could not clear, so the panel can put them
   * in front of him. He reads every one of these before Submit, which is his.
   */
  async function writeAnswerInto(el, a) {
    const deadline = Date.now() + 420000; // write, check, review, rewrite
    const started = Date.now();
    const ask = (again) => send({
      type: 'answer', question: a.label, kind: a.kind || null,
      context: a.context || '', again: !!again,
      field: { label: a.label, near: a.context || '', maxLength: el?.maxLength > 0 && el.maxLength < 524288 ? el.maxLength : 0, placeholder: (el?.getAttribute?.('placeholder') || '').slice(0, 200), value: '' },
      ...pageInfo(),
    });
    let got = await ask(false);
    // The server may have resolved the job from the page; poll by the key it answered with.
    let answerKey = got?.key || '';
    let said = false;
    // TWO WAYS THE SERVER SAYS "NOT YET", and both have to keep this waiting.
    //
    // A POST that STARTS a write answers 202 — `ok: true`, a status of
    // "writing", and no text. A POST that finds one already in flight answers
    // 425, which the worker reports as `ok: false, writing: true`. Waiting only
    // on the second would have made the first look like a finished answer with
    // an empty body, and thrown "no answer from the server" on every question
    // this run was the first to ask.
    const pending = (r) => !String(r?.text || '').trim() && (r?.writing || r?.status === 'writing');
    while (pending(got) && Date.now() < deadline) {
      if (!said) { said = true; console.log(`[jarvis] writing the answer to "${a.label}"`); }
      const secs = Math.round((Date.now() - started) / 1000);
      chip(`writing the answer to "${String(a.label).slice(0, 40)}" · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
      await pause(5000);
      got = await send({ type: 'answer-get', question: a.label, key: got?.key || answerKey });
      answerKey = got?.key || answerKey;
    }
    chip('Jarvis is filling…');
    if (!got?.ok || !String(got.text || '').trim()) throw new Error(got?.error || got?.why || 'no answer from the server');
    if (enterText) await enterText(el, String(got.text).trim()); else setNativeValue(el, String(got.text).trim());
    // THE SAME READ-BACK EVERY OTHER FILL GETS. A box that quietly refuses
    // two hundred words — a maxlength the page did not report, a React
    // controlled input — must not be counted as answered.
    if (!String(el.value || '').trim()) throw new Error('the page did not keep the answer');
    return { text: String(got.text).trim(), problems: got.problems || [], why: got.why || '', model: got.model || null };
  }

  /**
   * The cover letter onto a cover-letter slot (F-410).
   *
   * The same shape as the resume: the server writes one if this posting has
   * none — the request says the page has a slot — and answers 425 while it
   * does, so this waits rather than leaving a required field blank. A letter
   * takes about as long as a resume, and both are worth the wait on a form
   * that asked for them.
   */
  async function attachCoverLetter(input) {
    const deadline = Date.now() + 420000; // write, check, review, rewrite
    const started = Date.now();
    const ask = () => send({ type: 'letter', pageUrl: location.href, heading: pageHeading(), pageTitle: document.title || '' });
    let got = await ask();
    let said = false;
    while (!got?.ok && got?.status === 425 && Date.now() < deadline) {
      if (!said) { said = true; console.log(`[jarvis] ${got.error} — waiting for it`); }
      const secs = Math.round((Date.now() - started) / 1000);
      chip(`${String(got.error || 'writing the cover letter')} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
      await pause(5000);
      got = await ask();
    }
    chip('Jarvis is filling…');
    if (!got?.ok) throw new Error(got?.error || 'no cover letter from the server');
    const bytes = new Uint8Array(got.bytes);
    const file = new File([bytes], String(got.filename || '').trim() || `${PERSON_NAME} Cover Letter.pdf`, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`[jarvis] cover letter attached: ${file.name}`);
  }

  /**
   * Drive a Workday prompt: click the button, wait for the list, click the row.
   *
   * These cannot be typed into — the input behind the button holds an opaque id
   * (`bc33aa3152ec42d4995f4791a1`), and writing prose over it is what produced
   * "Enter a valid format for Phone Number" on a live form. The only honest way
   * to change one is to do what a person does.
   */
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  /** An empty result, worded a dozen different ways, is not an option. */
  const NO_RESULTS_RE = /^(no items|no results|no matches|nothing found|no options)\.?$/i;

  /**
   * Click a control WITHOUT letting it send the form.
   *
   * A `<button>` inside a `<form>` is `type="submit"` unless it says otherwise,
   * and a Workday questionnaire trigger is a bare `<button>` — which is exactly
   * what the wrapper pass now hands us to click. A fixture built from the live
   * Jabil step proved it: clicking the dropdown navigated the page.
   *
   * Workday's own handler calls preventDefault, so on a healthy form this
   * changes nothing at all. It is the guard for the form where it does not, and
   * it belongs here rather than in a check beforehand because "would this
   * submit?" cannot be answered from the markup: a bare button reads as a
   * submit button whether or not the page treats it as one, so refusing to
   * click would refuse every real trigger too.
   *
   * The listener is capture-phase and removed on the next tick, so nothing
   * about the page's behaviour outlives the click.
   */
  /**
   * Enter, with the codes a real keyboard carries (Workday reads keyCode).
   * A script's Enter never submits a form — only a trusted one does — and the
   * submit guard stands anyway.
   */
  function pressEnter(el) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const form = el.closest?.('form');
    const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    form?.addEventListener('submit', stop, true);
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keypress', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    } finally {
      if (form) setTimeout(() => form.removeEventListener('submit', stop, true), 0);
    }
  }

  function clickNoSubmit(el) {
    const form = el.closest?.('form');
    if (!form) { el.click(); return; }
    const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    form.addEventListener('submit', stop, true);
    try { el.click(); } finally {
      setTimeout(() => form.removeEventListener('submit', stop, true), 0);
    }
  }

  /**
   * Every option row currently visible in THIS control's open list.
   *
   * Scoped by `aria-controls` when the widget names its listbox. The global
   * query is the fallback — Workday renders its list into a portal at the end
   * of <body> with no link back to the field — but it must not be the default:
   * a list left open by the previous field is still in the document, so a
   * document-wide query returns two fields' options mixed together, the server
   * is asked to choose an index into that mixture, and the row that gets
   * clicked belongs to the wrong question.
   *
   * That is not a hypothetical. Micron's Country box renders all 195 countries
   * and filters correctly on a typed prefix — both mechanisms this code relies
   * on work — and the field still came out empty.
   */
  // spl-select-option: SmartRecruiters' option component, which is what listens
  // for the click — its inner role=option row does not (2026-09-24).
  // .dropdown-results .dropdown-location: Lever's "Current location" rows —
  // plain divs, no role, so the box looked like it found nothing and the
  // location was "not kept" (Phoenix Tailings, 2026-09-25).
  // .cx-select__list-item: ORACLE RECRUITING CLOUD's rows are role="gridcell"
  // in a role="grid" (F-695): every Oracle dropdown — address, ZIP, city,
  // state, gender, veteran, start/end month — read "0 rows" on Denso, Cummins
  // and "Global Careers", with the list open on screen. Only Oracle's own
  // class, so a calendar's day grid is never taken for a list.
  const optionSelector = '[role="option"], [data-automation-id="promptOption"], li[role="option"], [data-automation-id="promptLeafNode"], spl-select-option, .dropdown-results .dropdown-location, [role="gridcell"].cx-select__list-item';
  // THROUGH SHADOW ROOTS, BOTH THE LIST AND ITS ROWS' TEXT (F-331).
  //
  // SmartRecruiters' City is an autocomplete whose input, listbox and rows
  // all live in shadow roots, and whose row text reaches the row through a
  // <slot>: the `[role=option]` div reads as EMPTY and the words "Irvine, CA,
  // US" sit on a host two roots up. Measured live 2026-09-04: the list
  // opened, five rows rendered, and this code saw none of them.
  const all = (sel, root) => (deepQuerySelectorAll ? deepQuerySelectorAll(sel, root) : [...root.querySelectorAll(sel)]);
  const byId = (id) => (id ? (document.getElementById(id) || all(`#${CSS.escape(id)}`, document)[0] || null) : null);
  const rowText = (n) => {
    let h = n;
    for (let i = 0; h && i < 4 && !(h.textContent || '').trim(); i += 1) h = h.getRootNode?.()?.host || null;
    const raw = ((h || n).textContent || '').replace(/\s+/g, ' ').trim();
    // A ROW BUILT FROM STACKED BLOCKS READS AS ONE WORD in textContent (F-632):
    // Ashby's school results are name / country / domain in three divs, and
    // "Lakeside UniversityUnited Stateslakeside.edu" matched nothing. innerText
    // keeps the line breaks — taken only when spacing is all it changes, so a
    // text-transform or a visually hidden span never alters what is matched.
    const shown = String((h || n).innerText || '').replace(/\s+/g, ' ').trim();
    return shown && shown !== raw && shown.replace(/\s/g, '') === raw.replace(/\s/g, '') ? shown : raw;
  };
  const openRows = (el) => {
    const mine = el?.getAttribute?.('aria-controls') || '';
    const owned = mine ? byId(mine) : null;
    const scope = owned && all(optionSelector, owned).length ? owned : document;
    // ANOTHER FIELD'S LIST IS NOT THIS ONE'S (John Deere's Eightfold, F-697):
    // State's own list (aria-controls="list-32") had not opened yet, the
    // document-wide look found the Veteran list still open, offered "I am not
    // a Veteran" as State's and Race's options, and — rows being present —
    // never tried to open State's at all. A row inside a list some OTHER
    // control names as its own is skipped.
    // (Asked with no field — "is any list open at all?" — every list counts.)
    const others = el && scope === document
      ? new Set(all('[aria-controls]', document).map((c) => c.getAttribute('aria-controls')).filter((id) => id && id !== mine))
      : null;
    const foreign = (n) => {
      if (!others || !others.size) return false;
      for (let p = n; p && p !== document.body; p = p.parentElement || p.getRootNode?.()?.host) if (p.id && others.has(p.id)) return true;
      return false;
    };
    return all(optionSelector, scope)
      // `getClientRects`, not `offsetParent`: a popover is `position: fixed`
      // and every row inside one has offsetParent null (F-336).
      .filter((n) => n.getClientRects().length > 0 && !NO_RESULTS_RE.test(rowText(n)) && !foreign(n));
  };

  /**
   * THE ROW THAT LISTENS, when three nodes carry the same words (F-390).
   *
   * Workday renders each option three times over: a `menuItem` (role=option),
   * a `promptLeafNode`, and a `promptOption`. Measured on Applied Materials:
   * clicking the `menuItem` — which comes first in the DOM, so it is the one
   * that was being clicked — does nothing at all, while a plain click on the
   * `promptLeafNode` works every time. Lower rank wins.
   */
  function rowRank(n) {
    const a = n.getAttribute?.('data-automation-id') || '';
    if (/^SPL-.*OPTION$/.test(n.tagName || '')) return -1;
    return a === 'promptLeafNode' ? 0 : a === 'promptOption' ? 1 : 2;
  }

  /** Among rows reading the same thing, the one worth clicking. */
  function bestSameRow(owner, node) {
    if (!node) return node;
    const same = openRows(owner).filter((n) => norm(rowText(n)) === norm(rowText(node)));
    return same.sort((a, b) => rowRank(a) - rowRank(b))[0] || node;
  }

  /**
   * EVERY ROW, NOT THE FEW THAT HAPPEN TO BE PAINTED (F-390).
   *
   * Workday renders long prompts through react-virtualized: the popup holds a
   * handful of rows and paints the rest as you scroll. Measured live on
   * Applied Materials' "How Did You Hear About Us?" (2026-09-07): the list has
   * five categories, `aria-setsize="5"` says so, and only TWO were in the DOM
   * when the run read it — so "Job Board or Social Media", the answer his
   * profile carries, was never among the options offered to the matcher and a
   * REQUIRED field blocked the whole application.
   *
   * Typing does not help: this widget ignores the search box entirely (every
   * query returned the same two rows). Scrolling is what paints them.
   */
  async function revealTexts(owner, waitMs = 1800) {
    const seen = [];
    const add = () => { for (const n of openRows(owner)) { const t = rowText(n); if (t && !seen.includes(t)) seen.push(t); } };
    // The popup does not open on the same tick as the click. Give it a moment
    // before concluding there is nothing to read — the whole failure this
    // function exists to fix is reading a list too early. A box whose list is
    // REMOTE (Workday's skills taxonomy) opens empty and stays empty until a
    // search term is typed, so callers on that path pass a short wait and fall
    // through to typing rather than paying this on every item.
    const until = Date.now() + waitMs;
    while (Date.now() < until && !openRows(owner).length) {
      // eslint-disable-next-line no-await-in-loop
      await pause(120);
    }
    add();
    const first = openRows(owner)[0];
    const want = Number(first?.closest?.('[aria-setsize]')?.getAttribute('aria-setsize') || 0);
    let grid = first;
    for (let i = 0; grid && i < 8; i += 1, grid = grid.parentElement) {
      if (grid.scrollHeight > grid.clientHeight + 8) break;
    }
    if (!grid || !(grid.scrollHeight > grid.clientHeight + 8)) return seen;
    const step = Math.max(60, grid.clientHeight || 120);
    for (let i = 0; i < 40; i += 1) {
      if (want && seen.length >= want) break;
      const before = seen.length;
      const at = grid.scrollTop;
      grid.scrollTop = at + step;
      await pause(130);
      add();
      if (grid.scrollTop <= at && seen.length === before) break;   // nothing left to show
    }
    grid.scrollTop = 0;
    await pause(120);
    add();
    return seen;
  }

  /**
   * Click the row that reads `text`, scrolling it back into the DOM first —
   * react-virtualized throws away the nodes you scrolled past, so the node
   * `revealTexts` saw is usually gone by the time a choice is made.
   */
  /**
   * A TEXT BOX THAT SUGGESTS AS YOU TYPE: choose the row, or close the list.
   *
   * Only rows that appeared BECAUSE of this typing count — a list already on
   * screen belongs to something else. A location box that finds nothing for
   * "Springfield, Washington" (Lever: "No location found") is asked again with the
   * city alone, and its first row naming the city is taken; if that finds
   * nothing either, the full answer goes back in and the list is shut.
   */
  async function pickSuggestion(el, want, rowsBefore, label) {
    try {
      if (!el || el.tagName !== 'INPUT' || !want) return false;
      const locationish = /location|\bcity\b|where\b.{0,30}\b(live|located|based)/i.test(label || '');
      // Only a box that can suggest is waited on — a pause after every text
      // box cost seconds on a long form. Anything else gets one look now.
      const suggests = locationish || el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')
        || el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns') || el.hasAttribute('list');
      if (suggests) await pause(450);
      let rows = openRows(el);
      if (rows.length <= rowsBefore && locationish && want.includes(',')) {
        const city = want.split(',')[0].trim();
        // Staying in the box: its list closes on blur (Lever, 2026-09-25).
        if (enterText) await enterText(el, city, { stay: true }); else setNativeValue(el, city);
        // Until the rows arrive, not a fixed beat: Lever's lookup answered in
        // under a second on Phoenix Tailings and in more on Machina Labs, and
        // the fixed 900 ms read that as "nothing found" (2026-09-25).
        for (let waited = 0; waited < 3000; waited += 150) {
          // eslint-disable-next-line no-await-in-loop
          await pause(150);
          if (openRows(el).length > rowsBefore) break;
        }
        rows = openRows(el);
        if (rows.length <= rowsBefore) {
          if (enterText) await enterText(el, want); else setNativeValue(el, want);
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return false;
        }
      }
      if (rows.length <= rowsBefore) return false;
      const texts = rows.map(rowText);
      const asked = await send({ type: 'choose', want, options: texts }).catch(() => null);
      let i = asked?.ok ? asked.index : -1;
      if ((i == null || i < 0) && locationish) {
        const city = norm(want.split(',')[0]);
        i = texts.findIndex((t) => norm(t).startsWith(city));
      }
      if (Number.isInteger(i) && i >= 0 && i < texts.length) {
        const ok = await clickRowByText(el, texts[i]);
        await pause(300);
        console.log(`[jarvis] "${String(label).slice(0, 40)}": chose the suggestion "${texts[i].slice(0, 50)}"`);
        return ok && String(el.value || '').trim() !== '';
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    } catch { return false; }
  }

  async function clickRowByText(owner, text) {
    const all = () => openRows(owner).filter((n) => norm(rowText(n)) === norm(text))
      .sort((a, b) => rowRank(a) - rowRank(b));
    const find = () => all()[0];
    let hit = find();
    if (!hit) {
      const first = openRows(owner)[0];
      let grid = first;
      for (let i = 0; grid && i < 8; i += 1, grid = grid.parentElement) if (grid.scrollHeight > grid.clientHeight + 8) break;
      const step = Math.max(60, grid?.clientHeight || 120);
      for (let i = 0; grid && i < 40 && !hit; i += 1) {
        const at = grid.scrollTop;
        grid.scrollTop = at + step;
        // eslint-disable-next-line no-await-in-loop
        await pause(130);
        hit = find();
        if (grid.scrollTop <= at) break;
      }
    }
    if (!hit) return false;
    // EVERY COPY OF THE ROW, UNTIL ONE OF THEM ANSWERS (F-395).
    //
    // Workday draws each option three times and only one copy listens — the
    // `promptLeafNode` on the tenant this was measured on. Which copy that is
    // could differ elsewhere, and a ranking that is wrong on some other tenant
    // would fail silently and look exactly like "nothing matched". So the
    // ranking is a preference, not a bet: each copy is clicked in turn until
    // the page changes, which is the only evidence that matters.
    const copies = all();
    const shape = () => `${openRows(owner).map((n) => rowText(n)).join('|')}##${(comboValue && owner ? comboValue(owner) : '')}`;
    const before = shape();
    for (const node of copies) {
      // eslint-disable-next-line no-await-in-loop
      await clickOneRow(node);
      if (shape() !== before) return true;
    }
    return copies.length > 0;
  }

  /** One row, clicked the way a person clicks it. */
  /**
   * WAIT FOR THE VALUE, do not glance at it (F-398).
   *
   * Measured on Agility Robotics' Greenhouse form (2026-09-07): Degree and
   * Veteran Status were reported "nothing matched" while the page plainly held
   * "Bachelor's Degree" and "I am not a protected veteran" — the pick had
   * worked and the check ran before react re-rendered. A report that calls a
   * full field empty is the same class of lie as the reverse.
   */
  async function committed(el, was, capMs = 1600) {
    if (!comboValue) return true;
    const until = Date.now() + capMs;
    for (;;) {
      const now = comboValue(el);
      if (now && now !== was) return true;
      if (Date.now() >= until) return false;
      // eslint-disable-next-line no-await-in-loop
      await pause(120);
    }
  }

  async function clickOneRow(hit) {
    // A ROW IS OPENED WITH A POINTER, NOT WITH .click() (F-390).
    //
    // Measured on Applied Materials' prompt: a bare `.click()` on a CATEGORY
    // row left the menu exactly where it was — the submenu never opened, so
    // the drill-down could never begin. Clicking the same row with a real
    // mouse (through the debugger) opened it every time. Workday's rows listen
    // for the pointer sequence, the same way react-select listens for
    // mousedown; the form-submit guard is kept around all of it.
    const form = hit.closest?.('form');
    const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (form) form.addEventListener('submit', stop, true);
    try {
      const at = hit.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, composed: true, view: window,
        clientX: Math.round(at.left + at.width / 2), clientY: Math.round(at.top + at.height / 2), button: 0 };
      for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const E = /^pointer/.test(type) && window.PointerEvent ? PointerEvent : MouseEvent;
        hit.dispatchEvent(new E(type, /^pointer/.test(type) ? { ...opts, pointerId: 1, isPrimary: true, pointerType: 'mouse' } : opts));
      }
      // A WEB-COMPONENT OPTION TAKES A PLAIN click(). SmartRecruiters'
      // <spl-select-option> ignores the pointer sequence Workday needs and
      // selects on click() (GPA menu, Western Digital, measured 2026-09-24).
      if (/-OPTION$/.test(hit.tagName || '')) hit.click();
    } finally {
      if (form) setTimeout(() => form.removeEventListener('submit', stop, true), 0);
    }
    await pause(450);
  }

  /**
   * Wait for a matching option row to appear in the open list, or give up.
   *
   * THE SERVER PICKS. A combobox hides its options until it is opened, so when
   * the plan was made they did not exist and `chooseOption` never saw them —
   * leaving this function to do its own string matching. Measured on a live
   * Torc Robotics form, that failed three fields in a row:
   *
   *   Country        nothing matched "United States of America"
   *   Degree         nothing matched "Bachelor of Science"
   *   Veteran Status nothing matched "I am not a Veteran."
   *
   * `chooseOption` knows that "not a veteran" is "not a PROTECTED veteran", and
   * knows degree levels, dial codes and state abbreviations besides. None of it
   * was reachable from here. So the rows are reported to the server and it
   * decides — the same judgement that made the plan, applied to options that
   * only exist once the list is open.
   *
   * The local match still runs first (it is free and usually right) and is the
   * fallback if the server cannot be reached, so this can only add matches.
   */
  // `alsoOk`: the other spellings of the same answer, asked of the SAME open
  // list in preference order. `settle`: a list that has stopped changing is
  // the whole list — a static menu opened from a button, never a remote search
  // still filtering (F-618).
  async function waitForOption(want, owner = null, capMs = 2500, { alsoOk = [], settle = false } = {}) {
    const deadline = Date.now() + capMs;
    let seen = [];
    // "No Items." held steady is the search's answer, not a list still
    // loading: a miss ends in under a second instead of costing the whole cap,
    // which is what lets a skills box try more of his list (F-552).
    let emptyFor = 0;
    let steady = 0;
    let lastShape = '';
    while (Date.now() < deadline) {
      await pause(120);
      const rows = openRows(owner);
      if (rows.length === 1 && /^no (items|results|matches|options)\b/i.test(norm(rowText(rows[0])))) {
        emptyFor += 1;
        if (emptyFor >= 7) return null;
        continue;
      }
      emptyFor = 0;
      if (rows.length) seen = rows;
      // WHOLE WORDS ONLY (F-618). "No" was found inside "just NOT a protected
      // veteran" and HP's form said he is a veteran. Anything short of the
      // answer's own words at the row's start goes to the matcher, which
      // knows what "No" means for a veteran question.
      const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const w = words(want);
      const hit = rows.find((n) => norm(rowText(n)) === norm(want))
        || rows.find((n) => words(rowText(n)).startsWith(`${w} `))
        || (w.split(' ').length >= 2 ? rows.find((n) => ` ${words(rowText(n))} `.includes(` ${w} `)) : null);
      if (hit) return hit;
      // A MENU THAT HAS FINISHED DRAWING will not grow the answer by waiting.
      // Every miss used to cost the whole 2.5 s cap before the matcher was
      // even asked (F-618: Hyve's "How Did You Hear About Us?", 25 s).
      const shape = rows.map(rowText).join('|');
      if (settle && rows.length && shape === lastShape) { steady += 1; if (steady >= 3) break; } else steady = 0;
      lastShape = shape;
    }

    if (!seen.length) return null;
    const texts = seen.map(rowText);
    LAST_PROMPT_ROWS = texts.slice(0, 12);
    for (const w of [want, ...alsoOk]) {
      // eslint-disable-next-line no-await-in-loop
      const asked = await send({ type: 'choose', want: String(w), options: texts }).catch(() => null);
      const i = asked?.ok ? asked.index : -1;
      if (Number.isInteger(i) && i >= 0 && i < seen.length) return seen[i];
    }
    return null;
  }

  /**
   * How long ALL the items for one multi-select may take, together.
   *
   * GlobalFoundries' skills box runs a remote lookup against a curated taxonomy
   * and answers "No Items." for "SolidWorks". Twelve items at four seconds each
   * spent nearly a minute on one OPTIONAL field and stalled the whole run —
   * which is the actual bug. A field that will not answer must cost seconds, not
   * the application.
   */
  const MULTI_BUDGET_MS = 6000;
  /** A REQUIRED multi-select may take this long, and stops once it has enough. */
  const MULTI_BUDGET_REQUIRED_MS = 45000;
  const MULTI_ENOUGH = 6;
  // A SKILLS box is worth more than any other optional list (F-552): it is
  // what an ATS keyword-matches on, and a taxonomy that lacks the first two
  // spellings usually has the next ones. Longer budget, more misses allowed.
  // He wants 10-15 skills in the box, not one (2026-09-24): the box is given
  // his whole list ranked for the posting and stops at fifteen.
  const SKILLS_BUDGET_MS = 60000;
  const SKILLS_MISSES = 8;
  const SKILLS_ENOUGH = 15;
  // The rows the last prompt showed, so a miss can say what WAS on offer
  // instead of only what was wanted (F-551: Intel's fluency lists).
  let LAST_PROMPT_ROWS = [];
  // Did the last prompt find its row and click it? A pick that did not hold
  // is a page problem, not a matching one (F-716).
  let LAST_PROMPT_PICKED = false;

  /**
   * Drive a Workday prompt by doing what a person does.
   *
   * These cannot be typed into: the input behind a single-select prompt holds an
   * opaque id (`bc33aa3152ec42d4995f4791a1`), and writing prose over it produced
   * "Enter a valid format for Phone Number" on a live form and stopped the step
   * dead. There are two shapes and they open differently:
   *
   *   single — a button with aria-haspopup. Click it, pick the row.
   *   multi  — a search box. Type into it, wait for the list to filter, pick.
   *
   * Both lists render into a portal at the end of <body> rather than inside the
   * field, so the rows have to be looked for globally.
   */
  // `alsoOk`: the rule's OTHER acceptable answers. Inside a submenu the one
  // being tried may not exist while another does — Applied Materials files
  // LinkedIn under a category, and the career site that led there has no leaf
  // of its own (F-390, re-met 2026-09-24 when the career site moved first).
  async function pickFromPrompt(el, want, kind, alsoOk = [], { remote = false } = {}) {
    // WHAT WAS ALREADY THERE. The failure paths below clear the search box so a
    // half-typed term is not left on a real application — but if the field was
    // ALREADY answered, clearing it destroys a correct value.
    //
    // Measured on a live Micron form: Country committed "United States" on the
    // first pass, then the conditional second pass tried again, could not
    // match, and wiped it. In isolation the field filled perfectly, which is
    // why it looked like a matching bug for so long. Same shape as F-211: a
    // safety path undoing correct work.
    const alreadyHad = (comboValue && comboValue(el)) || '';
    const wrap = el.closest('[data-automation-id^="formField-"]') || el.parentElement;
    // THE FIELD ALREADY NAMED ITS TRIGGER, so do not go looking for another one.
    //
    // When discover's wrapper pass finds a Workday dropdown whose only control
    // is a button, elements[0] IS that button — picked with a guard that
    // refuses anything reading Submit, Save and Continue, Next or Review.
    // Re-querying the wrapper here would throw that choice away and click
    // whichever button happens to come first in the DOM instead, which on the
    // one rule this system has no tolerance for is not a risk worth taking.
    const button = el.tagName === 'BUTTON' ? el
      : wrap?.querySelector('button[aria-haspopup], button');

    // ANOTHER FIELD'S LIST STILL OPEN IS CLOSED FIRST (F-581). Workday draws
    // every prompt's list into one portal at the end of the page, so a list
    // left open is read as this field's options: Wolfspeed's "How Did You Hear
    // About Us?" was offered "United States of America (+1)" — the phone-code
    // list — beside its own categories, and LinkedIn never landed. Simplify
    // clicks the page's main area before this field for the same reason.
    if (kind !== 'combo' && !remote && openRows(null).length) {
      document.activeElement?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      const main = document.querySelector('#mainContent, [data-automation-id="mainContent"], main') || document.body;
      for (const t of ['mousedown', 'mouseup', 'click']) main.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      await pause(200);
    }

    if (kind === 'combo' || kind === 'multi' || !button) {
      // An ARIA combobox IS its own search box. Hunting the wrapper for one
      // would find a neighbouring field's input on forms that stack them.
      const box = kind === 'combo' ? el
        : wrap?.querySelector('[data-automation-id="searchBox"]')
        || wrap?.querySelector('input[type="text"], input:not([type])') || el;
      box.focus();
      // Workday's prompt opens on a real mouse gesture, the same way
      // react-select does; `click()` alone left it shut on some tenants.
      for (const t of ['mousedown', 'mouseup', 'click']) box.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      box.click();
      // A REMOTE search (a skills taxonomy) has nothing to show until a term
      // is searched, so it is not waited on or read first (F-581: skills cost
      // ~2.5 s each; Simplify does one in under a second).
      await pause(remote ? 120 : 350);

      // OPEN THE LIST BEFORE TYPING, and let the server read it.
      //
      // Typing the answer is what filters a combobox, and when the answer does
      // not literally appear in the list that filters it to NOTHING — so there
      // were no options left to report and nothing to choose from. Measured on
      // a live Torc Robotics form: Country, Degree and Veteran Status all
      // failed that way, and all three are matches `chooseOption` makes
      // easily once it can see the choices.
      //
      // Workday's multi-selects are excluded on purpose: their lists are remote
      // and genuinely empty until a search term is typed.
      if (kind === 'combo') {
        // REACT-SELECT OPENS ON mousedown, NOT ON click.
        //
        // Measured on a live Torc Robotics form: `el.click()` left the menu
        // shut and zero options rendered; dispatching mousedown opened it and
        // three appeared. That single difference is why every combobox that
        // needed to read its own list came back "nothing matched" — the list
        // was never on screen to read.
        // ONE MENU AT A TIME, AND OPEN IT UNTIL IT IS OPEN (F-398).
        //
        // Measured on Agility Robotics' Greenhouse form (2026-09-07): 39 of 43
        // fields answered, and Degree and Veteran Status came back "nothing
        // matched" on option lists the matcher gets right in isolation. Their
        // menus never opened. A react-select that is still closing swallows the
        // next mousedown, and the fields are filled back to back — so any menu
        // still up is dismissed first, and the open is attempted again if no
        // rows appear.
        document.activeElement?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await pause(120);
        // A LIST THAT IS ALREADY OPENING IS WAITED FOR, NOT CLICKED AGAIN
        // (2026-10-16). Micron's Eightfold dropdowns open late — measured in
        // his Opera, the list appeared ~0.5 s after the press, after the first
        // look — and a second press on a box already saying aria-expanded
        // "true" shuts it. Three presses in a row left the five screening
        // questions (U.S. worker, sponsorship, export, veteran, terms) with
        // "0 rows" while the same form filled in Playwright. Rows are watched
        // for after each press instead of read once.
        for (let go = 0; go < 3 && !openRows(box).length; go += 1) {
          if (box.getAttribute('aria-expanded') !== 'true') {
            box.focus();
            for (const t of ['mousedown', 'mouseup', 'click']) {
              box.dispatchEvent(new MouseEvent(t, { bubbles: true }));
            }
          }
          for (let waited = 0; waited < (go === 0 ? 900 : 1200) && !openRows(box).length; waited += 100) {
            // eslint-disable-next-line no-await-in-loop
            await pause(100);
          }
        }

        // Two goes: the list as it opens, then the list filtered by a PREFIX.
        //
        // A long list only renders its first few rows. Micron's Country box has
        // 195 options and opens showing Afghanistan to Angola — "United States
        // of America" is nowhere near the rendered window, so reading the open
        // list can never find it.
        //
        // Typing the WHOLE answer does not rescue it either: the option reads
        // "United States" and filtering on "United States of America" leaves
        // nothing. A prefix filters the list down to a handful and still
        // contains the right row, and then the server matches it properly —
        // which is the same division of labour as everywhere else here.
        // A number is opened by its first digit: typing all of "3.85" is the
        // whole answer (so the filtered pass was skipped), and a SmartRecruiters
        // list stays shut until something is typed (GPA, 2026-09-24).
        // A STREET ADDRESS is looked up by its number and street, not its first
        // digit: "9" offered Optomec's form "9 N Browne St…" (F-691).
        const streetish = /^\s*\d+[a-z]?\s+\S+\s+\S/i.test(String(want)) && /[a-z]{3}/i.test(String(want));
        // A ZIP is a LOOKUP: "9" is thousands of codes, "992" a handful with
        // 12345 among them (Oracle's ZIP Code, Denso F-695). A short number —
        // a GPA's "3" — keeps its first digit.
        const prefix = streetish ? String(want).trim().split(/\s+/).slice(0, 3).join(' ')
          : /^\s*\d{4,}\s*$/.test(String(want)) ? String(want).trim().slice(0, 3)
          : /^\s*\d/.test(String(want)) ? String(want).trim()[0] : String(want).trim().split(/\s+/)[0].slice(0, 12);
        for (const attempt of ['open', 'filtered']) {
          if (attempt === 'filtered') {
            // A <div> combobox has nothing to type into; its open list is all there is.
            if ((prefix.length < 3 && !/^\d$/.test(prefix)) || norm(prefix) === norm(want) || !/^(INPUT|TEXTAREA)$/.test(box.tagName)) break;
            // TYPED, as a person types: SmartRecruiters opens its list on real
            // text insertion and not on a value set from outside plus
            // synthetic keys (measured 2026-09-24). The old path stays the
            // fallback for a page that refuses execCommand.
            box.focus();
            let typedIn = false;
            try { box.select?.(); typedIn = document.execCommand('insertText', false, prefix); } catch { typedIn = false; }
            if (!typedIn || !String(box.value || '').includes(prefix)) {
              setNativeValue(box, prefix);
              for (const t of ['keydown', 'keypress', 'keyup']) {
                box.dispatchEvent(new KeyboardEvent(t, { key: 'a', bubbles: true }));
              }
            }
            await pause(600);
            // A LIST THAT ASKS A SERVER IS WATCHED UNTIL IT ANSWERS (F-632).
            // Ashby's "Search schools..." waits 300 ms after the last key and
            // then queries; measured on Applied Intuition's live form, the
            // rows landed 1.0 s after typing — after the one look at 0.6 s, so
            // School came back "nothing matched" with no list offered.
            for (let waited = 600; waited < 2500 && !openRows(box).length; waited += 150) {
              // eslint-disable-next-line no-await-in-loop
              await pause(150);
            }
          }
          const rows = openRows(box);
          if (!rows.length) continue;
          LAST_PROMPT_ROWS = rows.map(rowText).slice(0, 12);
          const asked = await send({
            type: 'choose',
            want: String(want),
            options: rows.map(rowText),
          }).catch(() => null);
          let i = asked?.ok ? asked.index : -1;
          let texts = rows.map(rowText);
          // A LIST LONGER THAN ITS WINDOW: Western Digital's GPA menu paints four
          // rows and "3.5 and above" is the fifth (2026-09-24). Read them all
          // before deciding nothing fits.
          if (!(Number.isInteger(i) && i >= 0) && attempt === 'open') {
            const every = await revealTexts(box, 400);
            if (every.length > texts.length) {
              LAST_PROMPT_ROWS = every.slice(0, 12);
              const again = await send({ type: 'choose', want: String(want), options: every }).catch(() => null);
              if (again?.ok && Number.isInteger(again.index) && again.index >= 0) { i = again.index; texts = every; }
            }
          }
          if (Number.isInteger(i) && i >= 0 && i < texts.length) {
            // ALREADY CHOSEN IS ANSWERED. Clicking a chosen row of a
            // multi-select un-chooses it (SmartRecruiters' major, 2026-09-24).
            const now = comboValue ? comboValue(el) : '';
            // The whole option for a single choice: "No" is not already chosen
            // because the box reads "No Selection" (TSMC, 2026-09-24). A
            // multi-select's chips are a list, so there a part is enough.
            const multiBox = kind === 'multi';
            if (now && (multiBox ? norm(now).includes(norm(texts[i])) : norm(now) === norm(texts[i]))) return true;
            const clicked = await clickRowByText(box, texts[i]);
            if (clicked) LAST_PROMPT_PICKED = true;
            const took = await committed(el, alreadyHad);
            console.log(`[jarvis] combo "${String(want).slice(0, 30)}" (${attempt}, ${texts.length} rows): chose "${texts[i].slice(0, 40)}" — ${clicked ? 'clicked' : 'row not found'}, ${took ? 'committed' : `not committed (reads "${String(comboValue ? comboValue(el) : '').slice(0, 40)}")`}`);
            if (took) return true;
            // THE ROW WAS THERE WHEN READ AND GONE WHEN CLICKED (F-621):
            // Micron's Eightfold menus re-render as they open, and the first
            // menu of the form lost its row every first press — then stayed
            // open, and the next question read "English | Spanish" as its
            // own list. Shut it, open it again, and click the same row once.
            if (!clicked) {
              document.activeElement?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              await pause(300);
              for (let go = 0; go < 3 && !openRows(box).some((n) => norm(rowText(n)) === norm(texts[i])); go += 1) {
                box.focus();
                for (const t of ['mousedown', 'mouseup', 'click']) box.dispatchEvent(new MouseEvent(t, { bubbles: true }));
                // eslint-disable-next-line no-await-in-loop
                await pause(go === 0 ? 450 : 700);
              }
              const again = await clickRowByText(box, texts[i]);
              if (again) LAST_PROMPT_PICKED = true;
              const tookAgain = again && await committed(el, alreadyHad);
              console.log(`[jarvis] combo "${String(want).slice(0, 30)}": reopened — ${again ? 'clicked' : 'row not found'}, ${tookAgain ? 'committed' : 'not committed'}`);
              if (tookAgain) return true;
              // Never leave it open for the next question to read.
              if (openRows(box).length) document.activeElement?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
          } else {
            console.log(`[jarvis] combo "${String(want).slice(0, 30)}" (${attempt}, ${texts.length} rows): nothing fits — ${texts.slice(0, 6).join(' | ').slice(0, 160)}`);
          }
        }
      }
      // A WORKDAY PROMPT THAT IS A MENU OF MENUS (F-390).
      //
      // Measured live on Applied Materials' "How Did You Hear About Us?"
      // (2026-09-07), a REQUIRED field that blocked the whole application:
      // the popup lists five CATEGORIES, each with a chevron —
      //
      //     Applied Materials Corporate Website      ›
      //     I currently work at/for Applied Materials ›
      //     Job Board or Social Media                 ›
      //     Job Fair or Recruiting Event              ›
      //     Staffing Agency                           ›
      //
      // — and choosing one opens a second level (104.com, Dice.com, Facebook,
      // Glassdoor, Indeed, … LinkedIn) where the real answer lives. Two things
      // defeated the old path at once: only two of the five were painted (the
      // list is virtualised), and clicking a category commits nothing, so even
      // a correct first pick read as a failure.
      //
      // So: reveal every row, let the server choose among ALL of them, click
      // it, and if nothing committed and the rows changed underneath, choose
      // again at the level that opened. His profile answers this question at
      // both levels — "LinkedIn" and "Job Board or Social Media" — and the
      // matcher already knows one is a kind of the other.
      if (kind !== 'combo' && !(remote && !openRows(box).length)) {
        for (let level = 0; level < 3; level += 1) {
          // eslint-disable-next-line no-await-in-loop
          // A short look on the first pass: a list that is a MENU is already
          // there, and one that is a remote search never will be.
          const texts = await revealTexts(box, level === 0 ? 700 : 1800);
          if (texts.length) LAST_PROMPT_ROWS = texts.slice(0, 12);
          console.log(`[jarvis] prompt "${want}" level ${level}: ${texts.length} row(s)${texts.length ? ` — ${texts.slice(0, 6).join(' | ')}` : ''}`);
          if (!texts.length) break;
          // eslint-disable-next-line no-await-in-loop
          const asked = await send({ type: 'choose', want: String(want), options: texts }).catch(() => null);
          let i = asked?.ok ? asked.index : -1;
          // Every level, in preference order, on the list already open —
          // reopening it per alternative cost ~3.5 s each and ran out the
          // field's budget after two (F-390 fixture, 2026-09-24).
          if (!Number.isInteger(i) || i < 0) {
            for (const alt of alsoOk) {
              // eslint-disable-next-line no-await-in-loop
              const again = await send({ type: 'choose', want: String(alt), options: texts }).catch(() => null);
              if (again?.ok && Number.isInteger(again.index) && again.index >= 0) { i = again.index; break; }
            }
          }
          if (!Number.isInteger(i) || i < 0 || i >= texts.length) break;
          const before = texts.join('|');
          // eslint-disable-next-line no-await-in-loop
          const clicked = await clickRowByText(box, texts[i]);
          console.log(`[jarvis] prompt "${want}": chose "${texts[i]}" (${clicked ? 'clicked' : 'row not found'})`);
          if (!clicked) break;
          // COMMITTED means the field says something it did not say before. A
          // multi-select already holding one chip must not report the next
          // item as chosen merely because the box is non-empty — that made a
          // required skills box claim twelve answers and hold one (F-390).
          if (await committed(el, alreadyHad)) return true;
          // eslint-disable-next-line no-await-in-loop
          const after = (await revealTexts(box)).join('|');
          if (after === before || !after) break;   // not a drill-down; nothing more to try
        }
        if (await committed(el, alreadyHad, 400)) return true;
      }

      // A FIELD THAT ALREADY HOLDS AN ANSWER IS NEVER TYPED OVER. The list
      // could not be read or matched; typing the answer as a search term
      // here would leave the sentence sitting in the box in place of the
      // committed value — measured on Lam's Veteran field, second press:
      // "No" became "I am not a Veteran." plus "1 error found". Leave what
      // is there and say the pick did not happen; he sees it in the list.
      // …unless the control takes MANY answers, where a chip already in it is
      // not "the answer" but one of them: his skills box holds a dozen, and
      // this guard once made every item after the first fail (F-390).
      if (alreadyHad && kind !== 'multi') { box.blur(); return false; }
      // TYPED, then ENTER (F-581). Workday's "Type to Add Skills" searches when
      // Enter is pressed, not as you type: a value set from outside plus a key
      // event with no key code left the list shut, and every skill came back
      // "nothing matched" on Viavi, ABB and Novanta after F-552 shipped. The
      // same recipe Simplify runs on Workday: insert the text as typing does,
      // and press Enter with the codes Workday reads — only when no list came
      // up by itself, so a type-ahead list is never answered by Enter.
      const term = String(want).slice(0, 40);
      box.focus();
      let typedTerm = false;
      try { box.select?.(); typedTerm = document.execCommand('insertText', false, term); } catch { typedTerm = false; }
      if (!typedTerm || norm(box.value) !== norm(term)) setNativeValue(box, term);
      // Workday's search box runs its lookup off KEYBOARD events, not `input` —
      // setting the value alone searched for the empty string and the list came
      // back "No Items." every time.
      for (const type of ['keydown', 'keypress', 'keyup']) {
        box.dispatchEvent(new KeyboardEvent(type, { key: 'a', bubbles: true }));
      }
      // Workday's own search box: Enter at once, as Simplify does — its list
      // never comes up from typing alone.
      const workdaySearch = !!box.closest?.('[data-automation-id="multiSelectContainer"], [data-automation-id="monIkerSearchBox"]');
      if (kind === 'multi' && workdaySearch) pressEnter(box);
      else if (kind === 'multi') {
        let listed = false;
        for (let t = 0; t < 5 && !listed; t += 1) {
          await pause(120);
          listed = openRows(box).some((r) => !/^no (items|results|matches|options)\b/i.test(norm(rowText(r))));
        }
        if (!listed) pressEnter(box);
      }
      const row = await waitForOption(want, box);
      if (!row) {
        // A component that takes custom values is given the answer as one
        // (F-354) — the typed text stays and the form's model holds it.
        if (!alreadyHad && commitComponentValue(box, String(want))) { box.blur(); return true; }
        // Leave nothing behind — unless there was something there to begin
        // with, in which case leaving it alone is the whole point.
        if (!alreadyHad) { setNativeValue(box, ''); box.blur(); }
        return !!alreadyHad && kind !== 'multi';   // a chip already there is not this item (F-390)
      }
      await clickRowByText(box, rowText(row));
      // CLICKING A ROW IS NOT COMMITTING A VALUE. For a combobox, ask what the
      // control now renders — that reads react's state rather than our own
      // typing, and it is the only answer here worth trusting. If nothing
      // committed, clear the box so no half-typed search term is left sitting
      // on a real application, and report the field unanswered.
      if (kind === 'combo' && comboValue && !(await committed(el, alreadyHad))) {
        if (!alreadyHad) { setNativeValue(box, ''); box.blur(); }
        return !!alreadyHad && kind !== 'multi';   // a chip already there is not this item (F-390)
      }
      return true;
    }

    // A MENU OPENED FROM A BUTTON (F-618). Workday's Degree, the language
    // ladders and some tenants' "How Did You Hear About Us?" open this way.
    // Two things were missing here that the search-box path above has had:
    //
    //  - the other spellings. Only `want` was looked for, so HP's "Bachelors
    //    (±16 years of education)" never met "Bachelors" and the education
    //    entry reported "could not set" on every HP and HPE fill; and each
    //    alternative the caller tried reopened the menu and waited out its
    //    cap — Hyve's source question took 25 s to reach its ninth spelling.
    //  - the read-back. A click was returned as a commit. Samsung's Reading
    //    and Caterpillar's Speaking went out EMPTY with nothing in the report
    //    (2026-09-25), one ladder in four.
    const shown = () => (comboValue ? comboValue(button) : '');
    const sameChoice = (a, b) => { const x = norm(a); const y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
    for (let go = 0; go < 2; go += 1) {
      clickNoSubmit(button);
      // eslint-disable-next-line no-await-in-loop
      const row = await waitForOption(want, button, 2500, { alsoOk, settle: true });
      if (!row) { clickNoSubmit(button); return false; }   // close it rather than leave it hanging open
      const pick = rowText(row);
      // ALREADY CHOSEN IS ANSWERED, as on the combobox path above. Clicking
      // the chosen row of a Workday menu again can un-choose it — the pass
      // over revealed fields re-planned a ladder holding "Excellent" and
      // Samsung's Reading went out empty (F-618).
      if (norm(shown()) === norm(pick)) {
        if (openRows(button).length) clickNoSubmit(button);   // shut, the way it opened
        return true;
      }
      // Through the same door as every other pick: every copy of the row, in
      // preference order, until one of them answers (F-395).
      // eslint-disable-next-line no-await-in-loop
      await clickRowByText(button, pick);
      if (!comboValue) { await pause(250); return true; }
      for (let t = 0; t < 12; t += 1) {
        // eslint-disable-next-line no-await-in-loop
        await pause(120);
        if (sameChoice(shown(), pick)) return true;
      }
      console.log(`[jarvis] prompt "${String(want).slice(0, 30)}": chose "${pick.slice(0, 40)}" but the field reads "${shown().slice(0, 40)}"${go ? '' : ' — once more'}`);
      if (openRows(button).length) clickNoSubmit(button);
      // eslint-disable-next-line no-await-in-loop
      await pause(200);
    }
    return false;
  }

  // ── Workday My Experience: add and fill Work Experience / Education / Language entries ──
  //
  // Ported from jarvis/apply/workday.mjs (fillMyExperience), which has walked
  // this step on NVIDIA, KLA, Jabil and GlobalFoundries. Same ids, same
  // heading-driven Add button, same "reuse the blank panel Workday pre-creates"
  // rule, same read-back before anything is counted. What a content script
  // cannot do is send TRUSTED keystrokes: Workday's date spinners are driven
  // with synthetic key events here and read back, and a date that did not
  // take is reported for him to type, never claimed.
  const ENTRY_FIELDS = {
    work: [
      { key: 'title', ids: ['formField-jobTitle', 'formField-title'] },
      { key: 'company', ids: ['formField-companyName', 'formField-company'] },
      { key: 'location', ids: ['formField-location'] },
      { key: 'description', ids: ['formField-roleDescription', 'formField-description'] },
    ],
    education: [
      { key: 'school', ids: ['formField-schoolName', 'formField-school', 'formField-schoolItem'] },
      { key: 'degree', ids: ['formField-degree'] },
      { key: 'fieldOfStudy', ids: ['formField-fieldOfStudy', 'formField-fieldsOfStudy'] },
      { key: 'gpa', ids: ['formField-gradeAverage', 'formField-gpa'] },
      { key: 'firstYear', ids: ['formField-firstYearAttended'], year: true },
      { key: 'lastYear', ids: ['formField-lastYearAttended'], year: true },
    ],
    language: [
      { key: 'name', ids: ['formField-language', 'formField-languageName'] },
      { key: 'proficiency', ids: ['formField-languageProficiency', 'formField-overallProficiency', 'formField-proficiency'] },
    ],
    website: [
      { key: 'url', ids: ['formField-url', 'formField-webAddress', 'formField-websiteUrl', 'formField-websiteURL'] },
    ],
  };
  const SECTION_LABEL = { work: 'Work experience', education: 'Education', language: 'Language', website: 'Website' };
  const SECTION_HEAD_RE = { work: /\b(?:work\s*)?experience\b|employment|work\s*history/i, education: /education/i, language: /language/i, website: /^\s*(?:add\s+)?websites?\b|\bwebsites?\s*$/i };

  /**
   * ENTRIES ON A FORM WITHOUT WORKDAY'S IDS (F-341): SmartRecruiters and any
   * component form. The sub-form that Add opens is read by its LABELS —
   * "Title", "Company", "Office location", "Description", "From", "To", "I
   * currently work here" — and each label is matched to the entry's field.
   */
  const ENTRY_LABELS = {
    work: {
      title: /\b(?:job\s*)?title\b|\bposition\b|\brole\b/i,
      company: /company|employer|organi[sz]ation/i,
      location: /location|\bcity\b/i,
      description: /description|responsibilit|duties|summary|details/i,
      start: /^from\b|\bstart/i,
      end: /^to\b|\bend\b|until/i,
      current: /currently|present|still\s+work/i,
    },
    education: {
      school: /school|university|college|institution/i,
      degree: /degree|qualification|level of education/i,
      fieldOfStudy: /field of study|major|discipline|area of study|subject/i,
      gpa: /\bgpa\b|grade/i,
      firstYear: /^from\b|\bstart|first year|enrol/i,
      lastYear: /^to\b|\bend\b|last year|graduat|completion/i,
    },
    language: { name: /language/i, proficiency: /proficien|level|fluen/i },
    website: { url: /\burl\b|website|web\s*address|\blink\b/i },
  };

  function genericAddFor(kind) {
    if (!deepQuerySelectorAll || !buttonName) return null;
    const btn = deepQuerySelectorAll('button, [role="button"]').filter((b) => onScreen(b))
      .find((b) => { const name = buttonName(b); return /\badd\b/i.test(name) && SECTION_HEAD_RE[kind].test(`${name} ${headingAbove ? headingAbove(b) : ''}`); });
    return btn || null;
  }

  /**
   * A month-year on a form that is not Workday. Two shapes met so far: a
   * calendar (SmartRecruiters' flatpickr month picker, which ignores typed
   * text — measured: "05/2026", "May 2026" and "2026-05-01" all left January)
   * whose year steps by its arrows and whose month is a cell to click; and a
   * plain box that keeps "MM/YYYY".
   */
  async function setGenericDate(input, date) {
    if (!input || !date || !date.year) return false;
    const vis = (e) => e.getClientRects().length > 0;
    input.focus();
    input.click();
    await pause(400);
    const cal = (deepQuerySelectorAll ? deepQuerySelectorAll('.flatpickr-calendar') : []).find(vis);
    if (cal) {
      const yearBox = deepQuerySelectorAll('input.cur-year', cal)[0];
      const prev = deepQuerySelectorAll('.flatpickr-prev-month', cal)[0];
      const next = deepQuerySelectorAll('.flatpickr-next-month', cal)[0];
      let cur = parseInt(yearBox?.value, 10);
      for (let guard = 0; Number.isFinite(cur) && cur !== Number(date.year) && guard < 80; guard += 1) {
        (cur > Number(date.year) ? prev : next)?.click();
        await pause(120);
        cur = parseInt(yearBox?.value, 10);
      }
      const months = deepQuerySelectorAll('.flatpickr-monthSelect-month', cal).filter(vis);
      if (months.length === 12 && date.month) {
        months[Number(date.month) - 1].click();
        await pause(300);
        return String(input.value || '').includes(String(date.year));
      }
      // A day calendar: the first day of the month is the least wrong click.
      const days = deepQuerySelectorAll('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)', cal).filter(vis);
      if (days.length && !date.month) { input.blur(); return false; }
    }
    const mm = String(date.month || 1).padStart(2, '0');
    // THE BOX'S OWN MASK FIRST, TYPED. Workable's entry dates are a
    // react-datepicker reading "MM/YYYY" (Verustruct, 2026-09-24): a value
    // set from outside held for the first job and was dropped for the next
    // three; typed, it holds every time. The calendar it opens is closed after.
    const ph = String(input.placeholder || '').trim().toUpperCase().replace(/\s+/g, '');
    const masked = ph === 'MM/YYYY' ? [`${mm}/${date.year}`] : ph === 'YYYY-MM' ? [`${date.year}-${mm}`] : ph === 'MM/DD/YYYY' ? [`${mm}/01/${date.year}`] : [];
    for (const v of [...masked, `${mm}/${date.year}`, `${date.year}-${mm}`, `${mm}/01/${date.year}`]) {
      if (enterText) await enterText(input, v); else setNativeValue(input, v);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
      if (document.querySelector('.react-datepicker-popper, .react-datepicker__tab-loop')) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
      }
      input.blur();
      await pause(200);
      if (String(input.value || '').includes(String(date.year))) return true;
    }
    return false;
  }

  /**
   * Is this entry already a saved card on the page? A saved entry renders
   * as text — its title and company (school and degree) in one small block
   * that holds no form control. The two names together, in one such block,
   * is the card; either alone could be the posting's own words.
   */
  function entryOnPage(kind, e) {
    const pair = kind === 'work' ? [e.title, e.company] : kind === 'education' ? [e.school, e.degree || e.fieldOfStudy] : [e.name];
    const wants = pair.filter((v) => v && String(v).trim()).map((v) => String(v).trim().toLowerCase());
    if (wants.length < Math.min(2, pair.length)) return false;
    const has = (el) => {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').toLowerCase();
      return t.length < 1200 && wants.every((w) => t.includes(w));
    };
    return deepQuerySelectorAll('li, article, section, div, tr, oc-experience-entry, oc-education-entry').some((el) =>
      el.getClientRects().length > 0 && has(el) && !el.querySelector('input, textarea, select') && !deepQuerySelectorAll('input, textarea, select').some((c) => el.contains(c) || el.contains(c.getRootNode()?.host)));
  }

  async function fillEntriesGeneric(kind, entries) {
    let filled = 0, checked = 0;
    const unanswered = [];
    const keys = [];
    const landed = (k) => { filled += 1; keys.push(k); };
    const controlsNow = () => [...allControls(), ...deepQuerySelectorAll('[role="checkbox"], [role="radio"]')].filter((el) => el.getClientRects().length > 0);
    const buttonsNow = () => deepQuerySelectorAll('button, [role="button"]').filter((b) => onScreen(b));
    const labels = ENTRY_LABELS[kind];
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const tag = `${SECTION_LABEL[kind]} ${i + 1}${e.company || e.school || e.name ? ` (${e.company || e.school || e.name})` : ''}`;
      // AN ENTRY THAT IS ALREADY ON THE PAGE IS NOT ADDED AGAIN (F-355). A
      // second press, or the pass over fields an answer revealed, saw the
      // saved "Manufacturing Engineer Intern · Applied Materials" card and
      // opened Add for it once more.
      if (entryOnPage(kind, e)) { landed(`entry:${kind}:${i}:present`); continue; }
      const add = genericAddFor(kind);
      if (!add) { unanswered.push(`${tag} — ${i === 0 ? 'no Add button on this form; add it by hand' : 'no way to add another here; the rest are yours'}`); break; }
      // The chip names the stage, so a slow or stuck entry is visible on the
      // page rather than a bare "Jarvis is filling…" (F-353).
      chip(`${tag}: opening`);
      const before = new Set(controlsNow());
      const buttonsBefore = new Set(buttonsNow());
      clickNoSubmit(add);
      let fresh = [];
      for (let t = 0; t < 32 && !fresh.length; t += 1) { await pause(250); fresh = controlsNow().filter((el) => !before.has(el)); }
      await pause(300);
      fresh = controlsNow().filter((el) => !before.has(el));
      if (!fresh.length) { unanswered.push(`${tag} — Add did not open a sub-form`); break; }
      const labelled = fresh.map((el) => ({ el, label: labelFor(el, el.type || 'text') || '', used: false }));
      const take = (re, pred = () => true) => { const hit = labelled.find((x) => !x.used && re.test(x.label) && pred(x.el)); if (hit) hit.used = true; return hit; };
      const isText = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|number)$/i.test(el.type || 'text'));
      const isDateBox = (el) => el.tagName === 'INPUT' && /^(text|search)$/i.test(el.type || 'text');
      const textKeys = kind === 'work' ? ['title', 'company', 'location', 'description']
        : kind === 'education' ? ['school', 'degree', 'fieldOfStudy', 'gpa'] : ['name', 'proficiency'];
      for (const key of textKeys) {
        const value = e[key];
        if (value == null || value === '') continue;
        const f = take(labels[key], isText);
        if (!f) continue;
        chip(`${tag}: ${key}`);
        // An autocomplete keeps its own sequence (the value, a keystroke, then
        // the commit) — leaving the field first would close it. A plain box is
        // typed like any other field on the form.
        if (f.el.getAttribute('role') === 'combobox' || !enterText) {
          setNativeValue(f.el, String(value));
          f.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true, composed: true }));
          if (f.el.getAttribute('role') === 'combobox') commitComponentValue(f.el, String(value));
        } else {
          await enterText(f.el, String(value));
        }
        f.el.blur();
        f.el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
        await pause(150);
        if (kept(f.el.value, String(value))) landed(`entry:${kind}:${i}:${key}`);
        else unanswered.push(`${tag} — ${key}: could not set "${String(value).slice(0, 40)}"`);
      }
      if (kind === 'work') {
        if (e.current) {
          const c = take(labels.current, (el) => el.type === 'checkbox' || el.getAttribute('role') === 'checkbox');
          if (c) { if (!isOn(c.el)) { c.el.click(); await settleAria(c.el); } if (isOn(c.el)) { checked += 1; keys.push(`entry:work:${i}:current`); } else unanswered.push(`${tag} — I currently work here: tick it`); }
        }
        for (const [key, when] of [['start', e.start], ['end', e.end]]) {
          if (!when) continue;
          const f = take(labels[key], isDateBox);
          if (!f) continue;
          chip(`${tag}: ${key === 'start' ? 'from' : 'to'} date`);
          if (await setGenericDate(f.el, when)) landed(`entry:work:${i}:${key}`);
          else unanswered.push(`${tag} — ${key === 'start' ? 'From' : 'To'}: pick ${String(when.month || '').padStart(2, '0')}/${when.year}`);
        }
      } else if (kind === 'education') {
        for (const [key, year] of [['firstYear', e.firstYear], ['lastYear', e.lastYear]]) {
          if (!year) continue;
          const f = take(labels[key], (el) => isDateBox(el) || el.type === 'number');
          if (!f) continue;
          // A MASKED "MM/YYYY" box is a month-year date, not a year box: the
          // bare year typed into Workable's became "20/27" and the proper date
          // could not land after it (Slip Robotics, 2026-09-25).
          if (f.el.type === 'number' || !/date|pick|mm|yyyy/i.test(f.el.placeholder || '')) {
            setNativeValue(f.el, String(year));
            if (kept(f.el.value, String(year))) { landed(`entry:education:${i}:${key}`); continue; }
          }
          // A month-year picker, and the profile states the month (F-358):
          // the same calendar path the work entries take.
          const month = key === 'firstYear' ? e.firstMonth : e.lastMonth;
          if (month) {
            chip(`${tag}: ${key === 'firstYear' ? 'from' : 'to'} date`);
            if (await setGenericDate(f.el, { year, month })) { landed(`entry:education:${i}:${key}`); continue; }
          }
          // A FUTURE END DATE THE BOX REFUSES IS A DEGREE STILL UNDER WAY.
          // Workable's education "To" clears anything after this month —
          // "05/2025" holds, "05/2027" is wiped — and has no "currently
          // studying" box, so blank is how it records a degree in progress
          // (Slip Robotics, 2026-09-25). Not a gap in the application.
          const now = new Date();
          const future = key === 'lastYear' && month
            && (Number(year) > now.getFullYear() || (Number(year) === now.getFullYear() && Number(month) > now.getMonth() + 1));
          if (future) {
            // Whatever the refused attempt left in the box goes too: a
            // half-typed "05/2" is worse than the blank the form wants.
            if (String(f.el.value || '').trim()) {
              setNativeValue(f.el, '');
              f.el.dispatchEvent(new Event('input', { bubbles: true }));
              f.el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            console.log(`[jarvis] ${tag}: this form takes no future end date — left blank, which it reads as still studying`);
            continue;
          }
          // A month-year picker asked for a month he never stated: his pick.
          unanswered.push(`${tag} — ${key === 'firstYear' ? 'From' : 'To'}: pick the month in ${year}`);
        }
      }
      // SAVE THE ENTRY. The sub-form's own Save is not the application's
      // Submit; it closes the panel and lists the entry. Never a control that
      // would submit the form.
      // Workable's is "Update" (data-ui="save-section", Verustruct 2026-09-24):
      // left unpressed, the entry stayed open and Workable blocked every other
      // Add on the page, so the second job never went in.
      const save = buttonsNow().filter((b) => !buttonsBefore.has(b) && !wouldSubmit(b))
        .find((b) => {
          const n = buttonName(b);
          const id = `${b.getAttribute('data-ui') || ''} ${b.getAttribute('data-automation-id') || ''} ${b.getAttribute('data-testid') || ''}`;
          return (/\b(save|done|add|update|confirm|ok)\b/i.test(n) || /save/i.test(id)) && !/cancel|another|file|upload|submit|apply/i.test(n);
        });
      if (save) {
        const stillOpen = () => fresh.some((el) => el.isConnected && el.getClientRects().length > 0);
        const refusal = () => deepQuerySelectorAll('[role="alert"]').map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 100)[0] || '';
        chip(`${tag}: saving`);
        clickNoSubmit(save);
        for (let t = 0; t < 16 && stillOpen(); t += 1) await pause(250);
        // A REFUSAL THAT NAMES CHARACTERS IS ANSWERED, ONCE (F-356). Becton
        // Dickinson (SmartRecruiters) refused entry 2 with "This field cannot
        // contain following characters: ;" — the description carried a
        // semicolon. Those characters are taken out of the text that holds
        // them (a semicolon becomes a comma, the rest go) and Save is pressed
        // again. Anything else the form says is handled below.
        if (stillOpen()) {
          const m = refusal().match(/cannot contain (?:the )?following characters?\s*:?\s*(.+?)\.?$/i);
          const bad = m ? [...new Set(m[1].replace(/\s+/g, '').split(''))] : [];
          let scrubbed = 0;
          for (const x of labelled) {
            const v = isText(x.el) ? String(x.el.value || '') : '';
            if (!v || !bad.some((c) => v.includes(c))) continue;
            const clean = bad.reduce((s, c) => s.split(c).join(c === ';' ? ',' : ''), v).replace(/\s{2,}/g, ' ').trim();
            setNativeValue(x.el, clean);
            x.el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true, composed: true }));
            scrubbed += 1;
          }
          if (scrubbed) {
            chip(`${tag}: saving again without ${bad.join(' ')}`);
            await pause(200);
            clickNoSubmit(save);
            for (let t = 0; t < 16 && stillOpen(); t += 1) await pause(250);
          }
        }
        if (stillOpen()) {
          // THE FORM REFUSED THE ENTRY. SmartRecruiters' Title, Company and
          // Location are autocompletes that take only a value picked from a
          // list, and the list opens only on a real keystroke (F-331) — typed
          // text sits in the box and "Title is required" stays. A half-filled
          // panel left open blocks the page's Next, so it is cancelled, the
          // entries are named as his, and no further panel is opened here.
          const why = refusal() || 'something in it is missing';
          const cancel = buttonsNow().filter((b) => !buttonsBefore.has(b) && !wouldSubmit(b)).find((b) => /cancel|discard|close/i.test(buttonName(b)));
          if (cancel) { clickNoSubmit(cancel); await pause(400); }
          const left = entries.slice(i).map((x) => x.title || x.school || x.name || '').filter(Boolean).join('; ');
          unanswered.push(`${SECTION_LABEL[kind]} — this form said "${why}" when the entry was saved; its fields want a pick from a list that opens only when you type. Add these yourself: ${left}`);
          console.log(`[jarvis] ${tag}: the form refused the entry ("${why}") — cancelled, the rest are his`);
          break;
        }
      } else {
        unanswered.push(`${tag} — entered; press its Save yourself`);
      }
      console.log(`[jarvis] ${tag}: entered (by labels)`);
    }
    return { filled, checked, unanswered, keys };
  }

  const lastOf = (ids) => { const els = document.querySelectorAll(ids.map((id) => `[data-automation-id="${id}"]`).join(', ')); return els.length ? els[els.length - 1] : null; };
  const countOf = (ids) => document.querySelectorAll(ids.map((id) => `[data-automation-id="${id}"]`).join(', ')).length;

  function addButtonFor(kind) {
    const heading = (el) => {
      let node = el.parentElement;
      for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
        const h = node.querySelector('h1,h2,h3,h4,h5,legend,[role="heading"]');
        const t = (h?.textContent || '').trim();
        if (t) return t;
      }
      return '';
    };
    return [...document.querySelectorAll('[data-automation-id="Add"], [data-automation-id="add-button"]')]
      .filter((b) => b.getClientRects().length > 0)
      .find((b) => SECTION_HEAD_RE[kind].test(heading(b))) || null;
  }

  /**
   * Type into a Workday date spinner (MM / DD / YYYY) and read it back AFTER
   * leaving it — Workday redraws the box from its own model on blur, so a
   * value only it never took is gone by then.
   *
   * F-581 (2026-09-24): the old path set the value from outside and sent key
   * events with no key code. The box showed the digits, Workday's model never
   * had them, and the form said "required" on Viavi, ABB, TD Synnex and
   * Wolfspeed while the date sat there on screen. Two ways in now, each read
   * back: the text inserted as typing inserts it (Simplify's Workday recipe:
   * focus, click, select, insertText), then key by key with the codes Workday
   * reads (key, code, keyCode, which).
   */
  async function setSpinner(input, val) {
    const s = String(val);
    const want = s.replace(/\D/g, '');
    const holds = () => {
      const got = String(input.value || '').replace(/\D/g, '');
      return !!got && (got === want || (want.length <= 2 && Number(got) === Number(want)));
    };
    const leave = async () => {
      input.blur();
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await pause(180);
    };
    // 1. As typing inserts it.
    input.focus();
    try { input.click(); } catch { /* not clickable */ }
    try { input.select(); } catch { /* not selectable */ }
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, s); } catch { inserted = false; }
    if (inserted) {
      await pause(120);
      await leave();
      if (holds()) return true;
    }
    // 2. Key by key, with the codes a real keyboard carries.
    input.focus();
    try { input.select(); } catch { /* not selectable */ }
    let acc = '';
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      const init = { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : '', keyCode: code, which: code, charCode: code, bubbles: true, cancelable: true };
      const before = String(input.value || '');
      input.dispatchEvent(new KeyboardEvent('keydown', init));
      input.dispatchEvent(new KeyboardEvent('keypress', init));
      acc += ch;
      // The page may have taken the key itself; only write what it did not.
      if (String(input.value || '') === before) setNativeValue(input, acc);
      input.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    await pause(120);
    await leave();
    return holds();
  }

  /**
   * TODAY, FROM THE CALENDAR (F-581). A signature date on Workday's
   * self-identify pages is today's date, and its calendar has a Today button:
   * two clicks, no typing, nothing for Workday's model to miss. Simplify
   * answers these fields the same way.
   */
  async function pickToday(wrap) {
    const icon = wrap?.querySelector('[data-automation-id="dateIcon"], [data-automation-id="dateTimeWidgetIcon"]');
    if (!icon) return false;
    clickNoSubmit(icon);
    let today = null;
    for (let t = 0; t < 10 && !today; t += 1) {
      await pause(150);
      today = document.querySelector('[data-automation-id="datePicker"] [data-automation-id="datePickerToday"], [data-automation-id="datePicker"] [data-automation-id="datePickerSelectedToday"]');
    }
    if (!today) { document.activeElement?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); return false; }
    clickNoSubmit(today);
    await pause(300);
    // WORKDAY'S TODAY IS THE ANSWER, NOT OURS (F-690). After 5 PM in Springfield
    // it is already tomorrow in UTC: Flowserve's Today set 10/4, this check
    // wanted his 10/3, called the pick a failure, and the typing that followed
    // put 10/03 back — "The field Date is required", then "Enter today's
    // date". A full date within a day of his clock is the calendar's today.
    const boxes = [...wrap.querySelectorAll('input[data-automation-id^="dateSection"]')];
    const got = {};
    for (const b of boxes) {
      const part = /Month/.test(b.getAttribute('data-automation-id')) ? 'month' : /Day/.test(b.getAttribute('data-automation-id')) ? 'day' : 'year';
      got[part] = Number(String(b.value || '').replace(/\D/g, ''));
    }
    if (!boxes.length || !got.month || !got.day || !got.year) return false;
    const picked = new Date(got.year, got.month - 1, got.day);
    const d = new Date();
    const mine = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.abs(picked - mine) <= 36 * 3600 * 1000;
  }
  const todayTried = new WeakMap();

  /**
   * THE OTHER TODAY, AFTER WORKDAY REFUSED ONE (F-732). Workday's "today" is
   * the tenant's, and no single clock matches every tenant: after 5 PM Pacific
   * Crown, Generac and Samsung took his local date (2026-10-04), Flowserve and
   * GlobalFoundries (2026-10-16, 23:01 Pacific) refused it — "The field Date is
   * required", then "Enter today's date". So once Workday has said no, the
   * signature date is retyped as whichever of his date and the UTC date the
   * boxes do not hold. Returns false when there is no other date to try.
   */
  async function retrySignatureDate() {
    if (!/(^|\.)myworkday(jobs|site)?\.com$/i.test(location.hostname)) return false;
    const wrap = document.querySelector('[data-automation-id="formField-dateSignedOn"]');
    const boxes = wrap ? [...wrap.querySelectorAll('input[data-automation-id^="dateSection"]')] : [];
    if (!boxes.length) return false;
    const partOf = (b) => (/Month/.test(b.getAttribute('data-automation-id')) ? 'month' : /Day/.test(b.getAttribute('data-automation-id')) ? 'day' : 'year');
    const held = {};
    for (const b of boxes) held[partOf(b)] = Number(String(b.value || '').replace(/\D/g, ''));
    const now = new Date();
    const local = { month: now.getMonth() + 1, day: now.getDate(), year: now.getFullYear() };
    const utc = { month: now.getUTCMonth() + 1, day: now.getUTCDate(), year: now.getUTCFullYear() };
    const holds = (d) => boxes.every((b) => held[partOf(b)] === d[partOf(b)]);
    const want = holds(local) ? utc : local;
    if (holds(want)) return false;
    for (const b of boxes) {
      const part = partOf(b);
      await setSpinner(b, part === 'year' ? String(want.year) : String(want[part]).padStart(2, '0'));
    }
    console.log(`[jarvis] Workday refused the signature date; retyped it as ${want.month}/${want.day}/${want.year}`);
    return true;
  }

  /** Is this date part today's? A signature date always is. */
  function isTodayPart(part, value) {
    const d = new Date();
    const n = Number(String(value).replace(/\D/g, ''));
    return part === 'month' ? n === d.getMonth() + 1 : part === 'day' ? n === d.getDate() : part === 'year' ? n === d.getFullYear() : false;
  }

  async function setEntryDate(container, date) {
    if (!container || !date) return false;
    let any = false; let all = true;
    for (const [id, val] of [['dateSectionMonth-input', date.month], ['dateSectionYear-input', date.year]]) {
      if (val == null) continue;
      const input = container.querySelector(`[data-automation-id="${id}"]`);
      if (!input) continue;
      any = true;
      if (!(await setSpinner(input, String(val).padStart(id.includes('Month') ? 2 : 4, '0')))) all = false;
    }
    return any && all;
  }

  const isPromptContainer = (c) => !!c.querySelector('[data-automation-id="promptIcon"], button[aria-haspopup="listbox"], [data-uxi-widget-type="selectinput"], [data-automation-id="multiSelectContainer"]')
    || /select one|select a value/i.test(c.querySelector('button')?.textContent || '');

  async function setEntryField(spec, value, alts = []) {
    const container = lastOf(spec.ids);
    if (!container) return 'absent';
    if (spec.year) {
      const y = container.querySelector('[data-automation-id="dateSectionYear-input"], input');
      return y ? await setSpinner(y, String(value)) : false;
    }
    if (isPromptContainer(container)) {
      const ctl = container.querySelector('input, button');
      const kind = container.querySelector('[data-automation-id="multiSelectContainer"]') ? 'multi' : 'single';
      // The menu's own spelling of the same answer is accepted too: HP's
      // "Bachelors (±16 years of education)" for "Bachelor of Science".
      return ctl ? await pickFromPrompt(ctl, String(value), kind, kind === 'single' ? alts.map(String) : []) : false;
    }
    const ctl = container.querySelector('textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden])');
    if (!ctl) return false;
    if (enterText) return (await enterText(ctl, String(value))).kept && kept(ctl.value, String(value));
    setNativeValue(ctl, String(value));
    return kept(ctl.value, String(value));
  }

  function setCurrentlyWorkHere() {
    const box = lastOf(['formField-currentlyWorkHere', 'currentlyWorkHere'])?.querySelector('input[type=checkbox]');
    if (!box) return 'absent';
    if (box.checked) return true;
    (box.closest('label') || box).click();
    return !!box.checked;
  }

  async function fillEntries(groups) {
    let filled = 0, checked = 0;
    const unanswered = [];
    const keys = [];
    const landed = (k) => { filled += 1; keys.push(k); };
    for (const group of groups) {
      const kind = group.kind;
      const specs = ENTRY_FIELDS[kind];
      const entries = Array.isArray(group.entries) ? group.entries : [];
      if (!specs || !entries.length) continue;
      const primary = ENTRY_PRIMARY?.[kind] || specs[0].ids;
      // No Workday wrappers and no Workday Add: a component form (F-341).
      if (!lastOf(primary) && !addButtonFor(kind)) {
        const g = await fillEntriesGeneric(kind, entries);
        filled += g.filled; checked += g.checked; unanswered.push(...g.unanswered); keys.push(...g.keys);
        continue;
      }
      const lastPanelEmpty = () => { const p = lastOf(primary); const c = p?.querySelector('input, textarea'); return !!p && (!c || !String(c.value || '').trim()); };
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const tag = `${SECTION_LABEL[kind]} ${i + 1}${e.company || e.school || e.name ? ` (${e.company || e.school || e.name})` : ''}`;
        if (!lastPanelEmpty()) {
          const add = addButtonFor(kind);
          if (!add) { unanswered.push(`${tag} — ${i === 0 ? 'no Add button on this tenant; add it by hand' : 'no "Add Another" here; the rest are yours'}`); break; }
          const before = countOf(primary);
          clickNoSubmit(add);
          for (let t = 0; t < 32 && countOf(primary) <= before; t++) await pause(250);   // the sub-form paints
          if (countOf(primary) <= before) { unanswered.push(`${tag} — Add did not open a sub-form`); break; }
          await pause(200);
        }
        for (const spec of specs) {
          const value = e[spec.key];
          if (value == null || value === '') continue;
          const ok = await setEntryField(spec, value, Array.isArray(e[`${spec.key}Alts`]) ? e[`${spec.key}Alts`] : []);
          if (ok === 'absent') continue;
          if (ok) landed(`entry:${kind}:${i}:${spec.key}`); else unanswered.push(`${tag} — ${spec.key}: could not set "${String(value).slice(0, 40)}"`);
        }
        if (kind === 'work') {
          if (e.current) {
            const ok = setCurrentlyWorkHere();
            if (ok === true) { checked += 1; keys.push(`entry:work:${i}:current`); } else if (ok === false) unanswered.push(`${tag} — I currently work here: tick it`);
          }
          if (e.start) { if (await setEntryDate(lastOf(['formField-startDate']), e.start)) landed(`entry:work:${i}:start`); else if (lastOf(['formField-startDate'])) unanswered.push(`${tag} — From: type ${String(e.start.month || '').padStart(2, '0')}/${e.start.year}`); }
          if (e.end) { if (await setEntryDate(lastOf(['formField-endDate']), e.end)) landed(`entry:work:${i}:end`); else if (lastOf(['formField-endDate'])) unanswered.push(`${tag} — To: type ${String(e.end.month || '').padStart(2, '0')}/${e.end.year}`); }
        }
        console.log(`[jarvis] ${tag}: entered`);
      }
      // A blank panel Workday pre-created and nothing used is a hard
      // validation stop ("Job Title is required") for an entry he never asked
      // for. Deleting is not attempted from here; it is named.
      if (lastPanelEmpty() && countOf(primary) > entries.length) unanswered.push(`${SECTION_LABEL[kind]} — a blank entry panel remains; delete it before Save and Continue`);
    }
    return { filled, checked, unanswered, keys };
  }

  /** A <select> option that is a placeholder rather than a choice. */
  const PLACEHOLDER_OPTION_RE = /^\s*(select|choose|please select|please choose|--|—|none selected|no selection)?\s*(one|an option|a value)?\s*[.:…-]*\s*$/i;

  /**
   * Does this control already carry an answer? Only asked on a follow-along
   * run, where the answer is to leave it alone.
   */
  function holdsAnswer(a, f, el, els) {
    if (a.action === 'fill') return String(el.value ?? '').trim() !== '';
    if (a.action === 'prompt') return String(f.current || '').trim() !== '';
    if (a.action === 'select') {
      if (el.tagName === 'SELECT') {
        const opt = el.options[el.selectedIndex];
        return !!opt && el.selectedIndex >= 0 && String(el.value ?? '') !== ''
          && !PLACEHOLDER_OPTION_RE.test(opt.textContent || '');
      }
      return els.some((e) => isOn(e));
    }
    // `check` only ever ticks what is unticked, and his standing answer to a
    // consent is yes; `upload` is refused by the planner when a file is
    // already attached. Neither needs protecting here.
    return false;
  }

  /**
   * A BOX THAT HOLDS TEXT AND IS STILL CALLED EMPTY (F-550, 2026-09-24).
   *
   * "known workday portal problem where sth is filled but workday still says
   * unfilled or required." The value is in the input, and Workday's own model
   * never took it, so its validation still reads the field as empty. His own
   * fix, from 2026-09-15, is the one that works: "delete a letter, retype,
   * then it registers." That is what this does, with real editing commands,
   * to every text box whose wrapper shows an error while it holds text. It
   * never changes what the box says, never touches an empty box (that one is
   * already named in the report), and never presses anything.
   */
  const FIELD_ERROR_SEL = '[data-automation-id="errorMessage"], [data-automation-id="inputError"], [data-automation-id*="rrorMessage"], [role="alert"]';
  function staleBoxes() {
    const out = [];
    for (const w of document.querySelectorAll('[data-automation-id^="formField-"]')) {
      if (!onScreen || !onScreen(w)) continue;
      const box = w.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), textarea');
      if (!box || box.readOnly || box.disabled) continue;
      // Date spinners are driven digit by digit and read back already.
      if (/dateSection/.test(box.getAttribute('data-automation-id') || '')) continue;
      // A prompt's search box is not where its value lives.
      if (box.getAttribute('data-automation-id') === 'searchBox') continue;
      if (!String(box.value || '').trim()) continue;
      const flagged = box.getAttribute('aria-invalid') === 'true' || !!w.querySelector(FIELD_ERROR_SEL);
      if (flagged) out.push({ wrap: w, box });
    }
    return out;
  }
  async function retypeLastLetter(box) {
    const val = String(box.value || '');
    const doc = box.ownerDocument || document;
    try { box.focus({ preventScroll: true }); } catch { /* not focusable */ }
    let done = false;
    if (doc.activeElement === box && typeof doc.execCommand === 'function') {
      try {
        box.setSelectionRange?.(val.length, val.length);
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true }));
        const del = doc.execCommand('delete', false);
        box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', bubbles: true, composed: true }));
        const last = val.slice(-1);
        box.dispatchEvent(new KeyboardEvent('keydown', { key: last, bubbles: true, composed: true }));
        const ins = doc.execCommand('insertText', false, last);
        box.dispatchEvent(new KeyboardEvent('keyup', { key: last, bubbles: true, composed: true }));
        done = del && ins && String(box.value || '') === val;
      } catch { done = false; }
    }
    if (!done) {
      // No editing commands here: the same two steps through the setter.
      setNativeValue(box, val.slice(0, -1));
      setNativeValue(box, val);
    }
    box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    try { box.blur(); } catch { /* fall through */ }
    box.dispatchEvent(new FocusEvent('blur', { composed: true }));
    box.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    return String(box.value || '') === val;
  }
  async function reassertStale() {
    const repaired = []; const still = [];
    for (const { wrap, box } of staleBoxes()) {
      const label = (labelFor && labelFor(box)) || wrap.querySelector('label')?.textContent?.trim() || 'a field';
      // eslint-disable-next-line no-await-in-loop
      await retypeLastLetter(box);
      // eslint-disable-next-line no-await-in-loop
      await pause(250);
      const flagged = box.getAttribute('aria-invalid') === 'true' || !!wrap.querySelector(FIELD_ERROR_SEL);
      if (flagged) {
        const why = (wrap.querySelector(FIELD_ERROR_SEL)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        still.push(`${label}${why ? ` ("${why}")` : ''}`);
      } else repaired.push(label);
    }
    if (repaired.length || still.length) console.log(`[jarvis] re-entered ${repaired.length} field(s) Workday had not taken${still.length ? `; still flagged: ${still.join('; ')}` : ''}`);
    return { repaired, still };
  }

  /** Fill whatever is on screen right now. One step of the wizard. */
  /**
   * Fill whatever is on screen. `only` narrows it to specific fields.
   *
   * The Playwright driver has always kept a `handled` set and filtered each
   * rescan through it, so a field filled once is never touched again. The
   * extension was written fresh, re-planned EVERY field on its second pass, and
   * re-made four bugs that path had already paid to fix: a combobox re-prompted
   * and wiped, a ticked box toggled off, a committed value cleared by a
   * "leave nothing behind" cleanup, and an answer overwritten by a retry.
   *
   * Each of those was fixed where it surfaced. This is the structural version:
   * the second pass is handed ONLY the fields that appeared after the first, so
   * it cannot revisit a handled one at all.
   */
  /**
   * `keepExisting` is the follow-along rule: a control that already holds an
   * answer is left exactly as it is. On a run he did not start, anything on the
   * form is either what the first pass wrote or what he corrected by hand, and
   * there is no way to tell those apart from here — so neither is touched. A
   * blank is still filled; only a value is protected. Measured need: he fixes a
   * phone number the form rejected, presses Save and Continue himself, and the
   * step that follows must not begin by putting the rejected number back.
   */
  async function fillCurrentStep(only = null, { keepExisting = false, entries: wantEntries = true, readBack = !only } = {}) {
    // Closed sections first: TSMC's SuccessFactors form keeps every question
    // behind a collapsed section header (2026-09-24).
    if (!only && expandSections) {
      const opened = expandSections();
      if (opened) { console.log(`[jarvis] opened ${opened} closed section(s)`); await settle(); }
    }
    const fields = only || discover();
    // Workday's My Experience: sections to add entries to, beside the fields.
    const sections = (!only && experienceSections) ? experienceSections() : [];
    if (!fields.length && !sections.length) {
      // "0 filled" on a posting that has been taken down reads as the tool
      // being broken. Measured on a live Form Energy posting whose Ashby board
      // API still reports it listed while the page itself says "Page not
      // found" — so a dead job sits in his queue and clicking here looked like
      // a bug. Which of the two it is decides whether he retries or moves on.
      // A site refusing us is not an empty form. On an iCIMS human-verification
      // page this used to report "no form controls here", which reads as the
      // tool being broken rather than the site asking him to prove he is a
      // person. It is NEVER cleared automatically — naming it and stopping is
      // the whole behaviour.
      const blocked = pageBlocked?.();
      if (blocked) {
        return { filled: 0, checked: 0, uploaded: false, unanswered: [], note: blocked.why };
      }
      const gone = postingGone?.();
      if (gone) {
        return {
          filled: 0, checked: 0, uploaded: false, unanswered: [],
          // STRUCTURED, not just prose. This verdict comes from the browser he
          // is signed into, which is the only place it can be trusted: a
          // headless check cannot tell a dead Workday posting from one Workday
          // refused to render for a bot, and gets it wrong in both directions
          // (F-250). Here there is no such doubt — this is the page as HE sees
          // it. Carrying it to the server is the one honest way to retire a
          // posting nothing else can.
          postingGone: String(gone),
          // Ashby's HOSTED page is not always the board. Form Energy runs its
          // board on formenergy.com, and every jobs.ashbyhq.com/formenergy URL
          // renders "Page not found" while the board API lists the job as
          // live. The dashboard checks the API before it retires anything.
          note: /(?:^|\.)jobs\.ashbyhq\.com$/i.test(location.hostname)
            ? `Ashby's hosted page says "${gone}". This company may run its board on its own site — the dashboard checks the board before retiring the posting.`
            : `this posting is gone — the page says "${gone}". Nothing to fill.`,
        };
      }
      return { filled: 0, checked: 0, uploaded: false, unanswered: [], readForm: false, note: 'no form controls here' };
    }

    const asked = await send({
      type: 'plan',
      pageUrl: location.href,
      heading: pageHeading(),
      pageTitle: document.title || '',
      fields: fields.map(({ elements, ...rest }) => rest),
      sections,
      // THE PAGE SAYS "COVER LETTER" ANYWHERE (his ask, 2026-10-03: "if page
      // mentions cover letter start writing … the cover letter slot is there
      // but there is no cover letter yet"). The dashboard starts the letter on
      // this plan, steps before the slot is reached.
      mentionsLetter: /cover[\s_-]?(letter|note)|letter\s+of\s+(interest|motivation)|motivation(al)?\s+letter/i.test(String(document.body?.innerText || '')),
    });
    if (!asked?.ok) return { filled: 0, checked: 0, uploaded: false, unanswered: [], error: asked?.error || 'no plan' };

    const plan = asked.plan;
    // Belt and braces: the server never sends a submit action, and if one ever
    // appeared the filler would still refuse it.
    //
    // UPLOADS LAST. The resume can take two minutes to write, and attachResume
    // waits for it. Lever puts the resume slot at the top of its form, so the
    // run sat on that wait with every field below still blank — measured live
    // on Dexterity: nothing typed for ninety seconds, then everything at once.
    // Typing first costs nothing and shows him the run is alive.
    const planned = (plan.actions || []).filter((a) => !SUBMIT_RE.test(a.action || ''));
    const isFile = (a) => a.action === 'upload' || a.action === 'upload-letter';
    // …AND WRITTEN ANSWERS AFTER EVERYTHING TYPED, for the same reason
    // (Sabanto's Breezy form, 2026-09-25): its "Cover Letter" box came first,
    // the writer took over three minutes, and not one field was filled in
    // that time. The server starts writing when it plans the step, so the
    // text keeps coming while the rest of the form fills.
    const isEssay = (a) => a.action === 'essay';
    const actions = [...planned.filter((a) => !isFile(a) && !isEssay(a)), ...planned.filter(isEssay), ...planned.filter(isFile)];

    let filled = 0, checked = 0, uploaded = false;
    // WAS THERE ANYWHERE TO PUT A RESUME on this step? A Workday
    // application carries its upload on screen TWO, so "no resume
    // attached" on the questions step described a failure that had not
    // happened and buried the ones that had.
    let sawUpload = false;
    // Which FIELDS were verified, not how many writes happened. Eightfold
    // re-renders labels between passes, so the same field could look new on
    // the second pass and be counted twice — 29 reported against 26 in the
    // DOM. A set of identities cannot double-count whatever the label does.
    const filledKeys = new Set();
    const unanswered = [];
    // DROPDOWNS WORTH A SECOND TRY once the page settles (F-716): a list that
    // never opened, or a row that was clicked and did not hold.
    const secondChance = [];
    // What the follow-along rule left as he had it, when the profile would
    // have said something else. Reported, never silent: a value he typed and
    // a value the engine disagrees with are both worth a glance before Submit.
    const keptList = [];
    let skipped = 0;
    /** Labels this pass answered, however it answered them (F-399). */
    const answered = [];
    /**
     * The written answers this pass typed — the question, how long the answer
     * ran, and anything its check could not clear.
     *
     * These are the only fields whose CONTENT he has to read rather than
     * glance at: two hundred words in his voice, about his own work, going to
     * a human. Every one of them is listed whatever its checks said.
     */
    const written = [];

    /**
     * Find the field an action was decided FOR — by identity, never by position.
     *
     * The old code did `fields[i]`, which is only correct while the two arrays
     * are the same length in the same order. On a live GlobalFoundries form a
     * one-item difference shifted everything after it and typed "Washington"
     * into the phone-code prompt, which Workday rejected with "Enter a valid
     * format for Phone Number". Identity first, position only as a last resort
     * and only when it agrees about what the field is.
     */
    // TWO ROWS, ONE KEY (F-670). Workday gives the second language row's
    // Reading the same formField- key as the first's; the key alone sent row
    // 2's answer to row 1 and row 2 went out empty. The element id
    // ("language-396--…", "language-397--…") tells the rows apart.
    const oneOfKey = (same, a) => (same.length > 1 && a.fieldId && same.find((x) => x.id === a.fieldId)) || same[0] || null;
    const findField = (a, i) => {
      // `i` is the action's position AFTER uploads were moved last; it is
      // only a last resort, and only trusted when the label agrees.
      // A SPLIT DATE'S THREE BOXES SHARE ONE KEY (F-581). Workday's month, day
      // and year all sit in formField-dateSignedOn, so "the field with this
      // key" was the MONTH box three times: 09, then 24, then 2026 typed over
      // one another, the day and year left empty, and the form said the date
      // was required. The part is part of the identity.
      if (a.key && a.datePart) { const f = fields.find((x) => x.key === a.key && x.datePart === a.datePart); if (f) return f; }
      if (a.key) { const f = oneOfKey(fields.filter((x) => x.key && x.key === a.key && (!a.datePart || !x.datePart)), a); if (f) return f; }
      // ONE NAME, TWO BOXES (F-735). Oracle's month and year pickers of one
      // date are both name="startDate": the name alone sent "Start Date Year"
      // to the MONTH box, which offered "May | January | …" and the year was
      // never set (Nokia, 2026-10-16). Several boxes with one name are told
      // apart by their own id, then their label.
      if (a.name) {
        const same = fields.filter((x) => x.name && x.name === a.name);
        const f = same.length > 1
          ? (a.fieldId && same.find((x) => x.id === a.fieldId)) || same.find((x) => x.label === a.label) || null
          : same[0];
        if (f) return f;
      }
      if (a.fieldId) { const f = fields.find((x) => x.id && x.id === a.fieldId); if (f) return f; }
      const at = fields[a.at ?? i];
      return at && at.label === a.label ? at : null;
    };

    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i];
      const f = findField(a, i);
      if (!f) {
        if (a.action !== 'skip' && a.action !== 'unknown') {
          unanswered.push(`${a.label} (could not find this field on the page)`);
        } else if (a.action === 'skip') {
          // A field the planner decided about and the page no longer shows is
          // decided, not outstanding (F-399).
          answered.push(a.label);
        }
        continue;
      }
      const els = f.elements || [];
      const el = els[0];
      if (!el) continue;
      // The follow-along rule, applied before anything is written. A prompt
      // the planner would re-drive, a select with a real choice in it, a
      // radio group with a button pressed, a text box with words in it: all
      // his now. Counted as skipped, not unanswered — they ARE answered.
      if (keepExisting && holdsAnswer(a, f, el, els)) {
        skipped += 1;
        answered.push(a.label);   // the page holds it; it is not his to do (F-399)
        const now = a.action === 'fill' ? String(el.value ?? '') : a.action === 'prompt' ? String(f.current || '')
          : el.tagName === 'SELECT' ? (el.options[el.selectedIndex]?.textContent || '') : (els.find((e) => isOn(e))?.value || f.options?.[els.findIndex((e) => isOn(e))] || '');
        const want = String(a.value ?? '');
        if (want && !kept_same(now, want)) keptList.push(`${a.label} (kept "${now.trim().slice(0, 40)}")`);
        continue;
      }
      try {
        if (a.action === 'fill') {
          // COUNT WHAT THE PAGE HOLDS, NOT WHAT WE ASKED FOR.
          //
          // `filled` used to increment on the attempt. It is the number he
          // reads first, and on a live Micron form it said 29 against 26 values
          // actually in the DOM. Every serious failure in this project has been
          // a report claiming more than happened, so the counter now asks the
          // input what it holds — the same read-back that caught react-select
          // pretending, applied to ordinary text too.
          // TYPED, NOT PLACED (2026-09-15). A name that showed in the box while
          // the form still said "required" was counted here as filled — the
          // read-back right after setting a value always agrees with itself.
          // enterText focuses, types, leaves the field and looks again after
          // the page has had a frame to put its own value back.
          // A date PART goes into Workday's spinner digit by digit, the way the
          // experience dates already do; insertText into one is ignored.
          const rowsBefore = openRows(el).length;
          // A LOCATION BOX THAT ALREADY HOLDS HIS CITY IS DONE. The second press
          // on Penumbra's Lever form (2026-09-25) retyped "Springfield, Washington"
          // over the chosen "Springfield, WA, USA", the lookup missed, and the box
          // ended empty — the one thing a second pass must never do.
          if (!a.datePart && /location|\bcity\b|where\b.{0,30}\b(live|located|based)/i.test(a.label || '')
            && el.tagName === 'INPUT' && String(el.value || '').trim()
            && norm(el.value).startsWith(norm(String(a.value || '').split(',')[0]))) {
            filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label);
            continue;
          }
          // A signature date is today's: the calendar's Today button first,
          // once per date, then typing (F-581).
          const dateWrap = a.datePart ? el.closest('[data-automation-id^="formField-"]') : null;
          if (dateWrap && isTodayPart(a.datePart, a.value) && !todayTried.has(dateWrap)) {
            todayTried.set(dateWrap, await pickToday(dateWrap).catch(() => false));
          }
          // The calendar set the whole date; its day may be tomorrow by his
          // clock, and typing his day over it is what Workday refused (F-690).
          // …AND WITH NO TODAY BUTTON, WORKDAY'S TODAY IS STILL UTC (F-706):
          // Flowserve's calendar said 10/4 at 17:10 Pacific (19:10 in its own
          // Texas), so "today" there is the UTC date. A today's part on a
          // Workday host is typed from the UTC clock; everywhere else, his.
          let typeValue = a.value;
          if (dateWrap && todayTried.get(dateWrap) === false && /(^|\.)myworkday(jobs|site)?\.com$/i.test(location.hostname) && isTodayPart(a.datePart, a.value)) {
            const u = new Date();
            const utc = { month: u.getUTCMonth() + 1, day: u.getUTCDate(), year: u.getUTCFullYear() }[a.datePart];
            if (utc) typeValue = a.datePart === 'year' ? String(utc) : String(utc).padStart(Math.min(2, String(a.value).trim().length) || 1, '0');
          }
          let typed = a.datePart && dateWrap && todayTried.get(dateWrap) && String(el.value || '').trim()
            ? { kept: true }
            : a.datePart && typeof setSpinner === 'function'
            // A part that reads back WRONG is typed once more from a clean
            // start: HP's year box held 2006 after 2027 was typed (F-618).
            ? { kept: (await setSpinner(el, String(typeValue))) || (String(el.value || '').trim() !== '' && (await pause(300), await setSpinner(el, String(typeValue)))) }
            : enterText ? await enterText(el, a.value) : (setNativeValue(el, a.value), { kept: kept(el.value, a.value) });
          // A BOX THAT SUGGESTS AS YOU TYPE (2026-09-24). Rippling's and Lever's
          // location boxes open a list under the text; the value only counts
          // once a row is chosen, and a list left open was read by the NEXT
          // dropdown as its own options (Rippling: race offered "Springfield, WA,
          // USA"). So a list that opened because of this typing is answered —
          // the matcher picks the row — or, when nothing fits, shut.
          let pickedRow = false;
          if (!a.datePart) {
            pickedRow = await pickSuggestion(el, String(a.value), rowsBefore, a.label);
            if (pickedRow) typed = { kept: true };
          }
          // A WEB ADDRESS BOX THAT REFUSES A BARE DOMAIN (BambooHR's "Website,
          // Blog or Portfolio" at Seakeeper and Cornelis, 2026-09-24/25). His
          // portfolio is kept as "alexrivera.example" on his word; a box that
          // will not hold it gets the same address with https:// — the form he
          // typed himself on Exowatt. Only a bare domain, only after a refusal.
          if (!(typed.kept && (pickedRow || kept(el.value, a.value)))
            && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(String(a.value || '')) && !a.datePart) {
            const full = `https://${a.value}`;
            const again = enterText ? await enterText(el, full) : (setNativeValue(el, full), { kept: kept(el.value, full) });
            if (again.kept && kept(el.value, full)) typed = { kept: true, value: full };
          }
          // A SECOND LOOK BEFORE "NOT KEPT" (2026-10-16). ADP's phone box takes
          // its country from the menu beside it and rewrites the number a beat
          // later: read at once it was blank, read a second later it held
          // "+1 555 010 0000". One more look, on a box that is not a date part.
          if (!(typed.kept && (pickedRow || kept(el.value, a.value) || (typed.value && kept(el.value, typed.value)))) && !a.datePart) {
            await pause(900);
            if (kept(el.value, a.value)) typed = { kept: true };
          }
          // A chosen suggestion is the answer, in the list's own spelling.
          if (typed.kept && (pickedRow || kept(el.value, a.value) || (typed.value && kept(el.value, typed.value)))) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
          // A month and a year refused by a box that wants a whole date
          // (Base Power's Ashby "Graduation Date", 2026-09-25): say that.
          else if (/^(\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{4})$/.test(String(a.value || '').trim())) unanswered.push(`${a.label} (this box wants a full date — ${a.value} is all your files say; add the day)`);
          // A DATE PART THE PAGE CHANGED is named with both values: "did not
          // keep the value" hid a start date of 2006 in plain sight (F-618).
          else if (a.datePart && String(el.value || '').trim()) unanswered.push(`${a.label} (the ${a.datePart} box reads "${String(el.value).trim()}" — it should be ${a.value}; fix it before you submit)`);
          else {
            unanswered.push(`${a.label} (the page did not keep the value)`);
            // Oracle's Address Line 1 kept "9" of a street (2026-10-02, F-655).
            captureAround(el, `typed value not kept (page holds ${String(el.value || '').length} characters)`, a.label);
          }
        }
        else if (a.action === 'essay') {
          // A box that already holds words is his — the same rule every other
          // field has. Typing over an answer he wrote himself would be the
          // worst version of this feature.
          if (String(el.value || '').trim()) {
            skipped += 1;
            answered.push(a.label);
          } else {
            try {
              const wrote = await timed('answers', () => writeAnswerInto(el, a));
              filled += 1;
              filledKeys.add(`${a.label}|${a.type}`);
              answered.push(a.label);
              // WRITTEN, AND WORTH READING BEFORE IT GOES. Every one of these
              // lands on the "check these" list whatever its checks said: it
              // is two hundred words going out under his name.
              written.push({ label: a.label, words: wrote.text.split(/\s+/).filter(Boolean).length, problems: wrote.problems, model: wrote.model || null });
            } catch (e) {
              unanswered.push(`${a.label} (${String(e.message || e).slice(0, 70)})`);
            }
          }
        }
        else if (a.action === 'prompt') {
          // A multi prompt takes one item at a time; `values` is the list.
          const wanted = Array.isArray(a.values) && a.values.length ? a.values : [a.value];
          let added = 0;
          const missed = [];
          // A REQUIRED list is worth more of the run (F-370): the step cannot
          // move on without one match, so the misses do not end it and the
          // budget is the long one. Enough hits, and the rest are not needed.
          // A SINGLE prompt's `values` are ALTERNATIVES, not items (F-551): the
          // first one the list accepts is the answer, and every one is worth a
          // try, because the list is short and the answer is one of them.
          const single = f.promptKind !== 'multi' || !!a.oneOf;
          const required = !single && !!f.required && wanted.length > 1;
          const skills = !single && !!a.skills;
          // A SINGLE choice's values are spellings of one answer, and every one
          // is worth its try: on a hidden tab the first attempt alone took over
          // six seconds and "Bachelor of Science" — the spelling that matches
          // Western Digital's "Bachelors of Science" — was never tried
          // (2026-09-24). The short budget is for optional multi lists.
          const until = Date.now() + (required || single ? MULTI_BUDGET_REQUIRED_MS : skills ? SKILLS_BUDGET_MS : MULTI_BUDGET_MS);
          let inARow = 0;
          const promptBegan = Date.now();
          LAST_PROMPT_ROWS = [];
          LAST_PROMPT_PICKED = false;
          for (const w of wanted) {
            if (single && added) break;
            if (skills ? added >= SKILLS_ENOUGH : required && added >= MULTI_ENOUGH) break;
            // Budget checked BEFORE the attempt as well as after: three tries at
            // GlobalFoundries' skills box cost 24.7 seconds and added nothing,
            // because the check only ran once an attempt had already been paid
            // for. One optional field must never cost the application.
            if (wanted.length > 1 && Date.now() > until) break;
            // eslint-disable-next-line no-await-in-loop
            if (await pickFromPrompt(el, w, f.promptKind, single ? wanted.filter((x) => x !== w) : [], { remote: skills })) { added += 1; inARow = 0; } else { missed.push(w); inARow += 1; }
            // A button menu was asked every spelling in that one opening
            // (F-618); opening it again per spelling only spends his time.
            if (!added && f.promptKind === 'single') break;
            // A curated taxonomy that does not contain "SolidWorks" will not
            // contain "MATLAB" either. Two misses in a row is the whole answer —
            // except in a skills box, which gets five (F-552), and a single
            // prompt, whose values are alternatives to be tried in turn.
            if (wanted.length > 1 && !single && inARow >= (skills ? SKILLS_MISSES : 2) && !required) break;
          }
          // THEN THE NAME A TAXONOMY FILES IT UNDER (F-552), for the ones his
          // resume abbreviates: "GD&T" is "Geometric Dimensioning and
          // Tolerancing" there. After the whole list as written, so a required
          // box reaches every skill it could take verbatim first.
          if (a.searchAlts) {
            for (const w of [...missed]) {
              const alt = a.searchAlts[w];
              if (!alt) continue;
              if (added >= (skills ? SKILLS_ENOUGH : MULTI_ENOUGH) || Date.now() > until) break;
              // eslint-disable-next-line no-await-in-loop
              if (await pickFromPrompt(el, alt, f.promptKind, [], { remote: skills })) { added += 1; missed.splice(missed.indexOf(w), 1); }
            }
          }
          if (added) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
          // One skill this employer's list does not carry is not worth telling
          // him about; none of them is.
          // WHY IT DID NOT LAND, TRUTHFULLY. A field that already holds an
          // answer is never typed over (the F-211 protection), and reporting
          // that as "nothing matched" sent me hunting a matcher bug on the
          // live Applied Materials form when the engine had done the right
          // thing — the page held "Yes" and the plan wanted something else.
          SPENT.prompts += Date.now() - promptBegan;
          const held = String(f.current || '').trim();
          // …unless what it holds IS the answer (Pronto's second press,
          // 2026-09-26: "left as No" where the plan wanted No) — answered.
          if (!added && held && wanted.some((w) => kept_same(held, w))) { skipped += 1; answered.push(a.label); }
          else if (!added && held) unanswered.push(`${a.label} (left as "${held}" — it already had an answer, and nothing here types over one)`);
          else if (!added) {
            const said = `${a.label} (nothing matched "${wanted.slice(0, 3).join(', ')}"${LAST_PROMPT_ROWS.length ? ` — the list offered: ${LAST_PROMPT_ROWS.slice(0, 8).join(' | ')}` : ''})`;
            // NOT A MISMATCH, A PAGE IN MOTION (F-716): Lam's signed-in form
            // redrew under the fill — its list never opened (0 rows), or the
            // right row was clicked and the redraw dropped it. Tried again
            // once the page has settled; only then is it his.
            if (readBack && f.promptKind === 'combo' && (!LAST_PROMPT_ROWS.length || LAST_PROMPT_PICKED)) secondChance.push({ a, f, said });
            else unanswered.push(said);
            // Oracle's education Country, 2026-10-02: no rows, no reason (F-655).
            if (f?.elements?.[0]) captureAround(f.elements[0], `typeahead: nothing matched (${LAST_PROMPT_ROWS.length} rows read)`, a.label);
          }
          else if (missed.length && wanted.length === 1) unanswered.push(`${a.label} (no "${missed[0]}")`);
        } else if (a.action === 'select') {
          // THE LIST WAS EMPTY WHEN THE PAGE WAS READ, AND IS NOT NOW (F-485).
          //
          // A <select> whose options are built by script is empty at discovery
          // and full a moment later. The plan says `optionIndex: -1` for that
          // case and carries what it wants; this looks again, and only then
          // decides. Micron's veteran self-identification question is the one
          // that taught this: the engine had "I am not a Veteran." in hand and
          // reported the question as his, because the list it was matching
          // against had nothing in it.
          if (a.lateOptions && el.tagName === 'SELECT') {
            // Touching it is what fills some of them; the rest just need a
            // moment. Both are cheap, and this only runs where the alternative
            // is handing the question back.
            try { el.focus({ preventScroll: true }); el.click(); } catch { /* not focusable */ }
            const until = Date.now() + 2500;
            while (el.options.length <= 1 && Date.now() < until) await pause(120);
            const texts = [...el.options].map((o) => String(o.textContent || '').trim());
            if (texts.length > 1) {
              const asked = await send({ type: 'choose', want: String(a.value), options: texts }).catch(() => null);
              const i = asked?.ok ? asked.index : -1;
              if (Number.isInteger(i) && i >= 0 && i < el.options.length) {
                const want = el.options[i]?.value ?? '';
                setNativeValue(el, want);
                if (kept(el.value, want) && want !== '') {
                  filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label);
                } else unanswered.push(`${a.label} (the page did not keep the choice)`);
              } else unanswered.push(`${a.label} (its list opened, and nothing in it matched "${String(a.value).slice(0, 40)}")`);
            } else {
              unanswered.push(`${a.label} (its list never filled in — choose "${String(a.value).slice(0, 40)}" yourself)`);
            }
          } else if (el.tagName === 'SELECT') {
            const want = el.options[a.optionIndex]?.value ?? '';
            setNativeValue(el, want);
            // Same read-back as `fill`: a <select> that rejects a value silently
            // snaps back to its placeholder, and counting the attempt would
            // report an answer the form does not have.
            if (kept(el.value, want) && want !== '') { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
            else unanswered.push(`${a.label} (the page did not keep the choice)`);
          } else {
            const pick = els[a.optionIndex];
            if (pick) {
              // CLICKING A CHECKED BOX UNCHECKS IT. The conditional second pass
              // re-runs the same action, and on a live Torc form that toggled
              // the export-control "None/Not applicable" box back OFF — the
              // fourth time this session a repeat of correct work has undone
              // it. Only click what is not already the way we want it.
              if (!isOn(pick)) { pick.click(); await settleAria(pick); }
              if (isOn(pick)) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
              else {
                unanswered.push(`${a.label} (the page did not keep the choice)`);
                // Oracle's Title pill showed "Mr." chosen while this said it was
                // not, and its SMS consent flipped to "I do not agree" (Denso,
                // F-695): the pill's markup is what says how it shows a choice.
                captureAround(pick, 'choice not kept (or not readable as chosen)', a.label);
              }
            } else unanswered.push(`${a.label} (no option ${a.optionIndex})`);
          }
        } else if (a.action === 'check') {
          for (const box of els) if (!isOn(box)) { box.click(); await settleAria(box); checked += 1; }
          answered.push(a.label);
        } else if (a.action === 'upload') {
          sawUpload = true;
          // A SLOT THAT ALREADY HOLDS A FILE IS HIS (F-413). The planner reads
          // this off the page too, but a form he refilled after a timeout can
          // paint its chip between the plan and this line, and putting a
          // second copy of the same PDF onto a live application is the fault
          // that rule was written for.
          if (el.files && el.files.length > 0) {
            skipped += 1;
            answered.push(a.label);
            uploaded = true;
          } else {
            const put = await timed('resume', () => attachResume(el));
            if (put && put.ok === false) {
              unanswered.push(`${a.label} (the page did not keep the file — attach the resume yourself)`);
            } else {
              uploaded = true;
              // Attached to the field, but the form never printed the name.
              // Said out loud rather than counted as done (F-465).
              if (put && put.showing === false) unanswered.push(`${a.label} (attached, but the page never showed the file — check it before you Submit)`);
            }
          }
        } else if (a.action === 'upload-letter') {
          // THE COVER LETTER, AS A FILE (F-410). Same rule: only into an empty
          // slot. A letter that cannot be written is said out loud rather than
          // leaving a required field silently blank.
          if (el.files && el.files.length > 0) {
            skipped += 1;
            answered.push(a.label);
          } else {
            try {
              await attachCoverLetter(el);
              filled += 1;
              filledKeys.add(`${a.label}|${a.type}`);
              answered.push(a.label);
            } catch (e) {
              unanswered.push(`${a.label} (${String(e.message || e).slice(0, 70)})`);
            }
          }
        } else if (a.action === 'unknown') {
          // A BOX ALREADY TICKED IS NOT LEFT FOR HIM (Applied Intuition,
          // 2026-09-25): the first pass ticked "Still Student?"; the second
          // planned only part of the form, could not tell it was education,
          // and listed the ticked box as a question he still had.
          if (/^(checkbox|radio)$/.test(String(f?.type || a.type || '')) && els.some((e) => isOn(e))) { skipped += 1; answered.push(a.label); }
          else unanswered.push(a.label);
        } else if (a.action === 'skip') {
          // DELIBERATELY LEFT ALONE IS NOT THE SAME AS UNANSWERED.
          //
          // The planner skips for good reasons — the field is already set
          // correctly, his profile says leave it blank, the answer is "No" so
          // the box stays unticked, "save my answers" is his call. All of that
          // fell through here and was recorded nowhere, so a field the engine
          // decided about looked identical to one it never saw.
          //
          // The server has stored a `skipped` count all along and nothing ever
          // sent one, so it read 0 on every run.
          skipped += 1;
          // ANSWERED IS ANSWERED, however it got that way. A field the planner
          // skipped because the page already holds the right value is not a
          // field he still has to do — and the tab's running total kept
          // listing exactly those (F-399).
          answered.push(a.label);
        }
      } catch (e) {
        unanswered.push(`${a.label} (${String(e.message || e).slice(0, 60)})`);
      }
    }

    // WORK EXPERIENCE AND EDUCATION ENTRIES, added and filled last: each Add
    // paints a sub-form, and every field inside it is this entry's, never the
    // generic enumerator's.
    if (wantEntries && Array.isArray(plan.entries) && plan.entries.length) {
      // A WATCHDOG. On Becton Dickinson (SmartRecruiters) the entries step
      // stalled inside an open sub-form for ten minutes and the run never
      // reported (F-353). Whatever an entry does, the run ends and says so.
      // The budget is per entry, and twice that behind another tab, where
      // every wait is a second at best (F-355).
      const count = plan.entries.reduce((n, g) => n + (Array.isArray(g.entries) ? g.entries.length : 0), 0);
      const budget = Math.max(120000, 60000 * count) * (document.visibilityState === 'hidden' ? 2 : 1);
      const entriesBegan = Date.now();
      const r = await Promise.race([
        fillEntries(plan.entries),
        new Promise((resolve) => setTimeout(() => resolve({ filled: 0, checked: 0, keys: [], unanswered: ['Experience/Education — took too long on this form; add the entries yourself'] }), budget)),
      ]);
      SPENT.entries += Date.now() - entriesBegan;
      filled += r.filled;
      checked += r.checked;
      // The walk counts FIELD IDENTITIES, not this number; every entry field
      // that landed is one identity of its own.
      for (const k of r.keys) filledKeys.add(k);
      for (const u of r.unanswered) unanswered.push(u);
    }

    // WHAT WORKDAY STILL CALLS EMPTY AFTER ALL THAT (F-550). Re-entered the
    // way he does it by hand; what will not take is named for him.
    try {
      const stale = await reassertStale();
      for (const s of stale.still) unanswered.push(`${s} — Workday still flags this though it holds your text; check it, or delete one letter and retype it`);
    } catch { /* a repair, never a reason to fail the step */ }

    // THE SECOND TRY (F-716). Lam's signed-in form loads his saved profile
    // into itself after the page appears and redraws as it does: a list that
    // was opening shuts, a picked row is dropped. Every test of Lam's form
    // without that redraw filled all of it — focus off, CPU four times slower,
    // both. So a dropdown that failed that way gets one more go after a
    // pause, on the field as the page now draws it.
    if (secondChance.length) {
      try {
        await pause(1500);
        const now = discover();
        const retry = [];
        for (const s of secondChance) {
          const f = (s.a.fieldId && now.find((x) => x.id === s.a.fieldId))
            || now.find((x) => x.label === s.a.label && x.type === s.a.type);
          if (f) retry.push({ ...s, f });
          else unanswered.push(s.said);
        }
        if (retry.length) {
          console.log(`[jarvis] second try for ${retry.length} dropdown(s) after the page settled — ${retry.map((x) => x.a.label).join(' | ').slice(0, 160)}`);
          await fillCurrentStep(retry.map((x) => x.f), { entries: false });
          const after = discover();
          for (const { a, said } of retry) {
            const f = (a.fieldId && after.find((x) => x.id === a.fieldId))
              || after.find((x) => x.label === a.label && x.type === a.type);
            const el = f?.elements?.[0];
            if (f && el && holdsAnswer(a, f, el, f.elements)) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
            else unanswered.push(said);
          }
        }
      } catch { for (const s of secondChance) unanswered.push(s.said); }
    }

    // READ BACK, ONCE THE PAGE HAS SETTLED (2026-09-24). An answer counted as
    // filled is looked at again after the whole step: a later field's list, a
    // re-render or a model that never took the value can empty it (the split
    // dates, the resume that "attached" and was gone). What was lost is filled
    // once more; what still will not hold is named for him and not counted.
    // …and after the pass over REVEALED fields too, which is the last thing
    // to touch the page before the report: Samsung's Reading was emptied there
    // and went out blank under "nothing left" (F-618). Never inside the
    // read-back's own refill, which would recurse.
    if (readBack) {
      try {
        await pause(250);
        const now = discover();
        const lost = [];
        for (const a of actions) {
          if (!['fill', 'select', 'prompt'].includes(a.action) || a.promptKind === 'multi' || !answered.includes(a.label)) continue;
          const f = (a.key ? oneOfKey(now.filter((x) => x.key === a.key && (x.datePart || '') === (a.datePart || '')), a)
            : a.name ? now.find((x) => x.name === a.name) : null)
            || now.find((x) => x.label === a.label && x.type === a.type && (x.datePart || '') === (a.datePart || ''));
          const el = f?.elements?.[0];
          if (!f || !el || holdsAnswer(a, f, el, f.elements)) continue;
          lost.push({ a, f });
        }
        if (lost.length) {
          console.log(`[jarvis] read back: ${lost.length} answer(s) the page did not keep — ${lost.map((x) => x.a.label).join(' | ').slice(0, 200)}`);
          const again = await fillCurrentStep(lost.map((x) => x.f), { entries: false });
          // Workday redraws a ticked box a beat later; reading at once called
          // GlobalFoundries' disability box lost while the press sent it
          // ticked (F-732).
          await pause(400);
          const after = discover();
          for (const { a } of lost) {
            const f = (a.fieldId && after.find((x) => x.id === a.fieldId))
              || after.find((x) => x.label === a.label && x.type === a.type && (x.datePart || '') === (a.datePart || ''));
            const el = f?.elements?.[0];
            if (f && el && holdsAnswer(a, f, el, f.elements)) continue;
            filled = Math.max(0, filled - 1);
            answered.splice(answered.indexOf(a.label), 1);
            unanswered.push(`${a.label} (filled, but the page did not keep it — fill it in)`);
          }
          void again;
        }
      } catch { /* a read-back, never a reason to fail the step */ }
    }

    // fieldKeys is what the step loop compares against to notice a field that
    // only appeared once an earlier answer was given.
    return { filled, checked, skipped, uploaded, sawUpload, unanswered, answered, written, kept: keptList,
      // DID THIS PAGE HAVE A FORM ON IT AT ALL? Not "did we fill anything" —
      // whether there were controls here to read. The panel's green line turns
      // on this, and nothing else can stand in for it (F-443).
      readForm: fields.length > 0,
      filledKeys: [...filledKeys], fieldKeys: fields.map((f) => `${f.label}|${f.type}`),
      // A list with nothing in it yet: Honda's State is "Please Select" and a
      // blank until a Country is chosen (2026-10-02).
      starvedKeys: fields.filter((f) => f.type === 'select' && (f.options || []).filter((o) => String(o?.text ?? o).trim()).length <= 1).map((f) => `${f.label}|${f.type}`),
      resumeNote: plan.resumeNote, staleExtension: plan.staleExtension };
  }

  /**
   * Walk the whole application: fill this step, advance, fill the next, and stop
   * at the last screen before Submit.
   *
   * This is what makes it an application rather than a form-filler. A Workday
   * application is six screens and the RESUME UPLOAD IS ON SCREEN TWO — filling
   * only what is in front of you means nothing is ever attached and nothing past
   * My Information is ever answered.
   *
   * Three things stop the loop, and none of them is a timer:
   *   - there is no next control (we are done, or the only button is Submit);
   *   - the screen did not change after clicking, so we are stuck and pressing
   *     again would just be pressing again;
   *   - MAX_STEPS, which exists so a form that loops cannot loop us forever.
   *
   * IT NEVER PRESSES SUBMIT. `nextControl` returns null the moment the only way
   * forward is a Submit button, so the walk ends on the review screen with
   * everything filled and his finger on the last click.
   */
  const MAX_STEPS = 10;

  /**
   * Say what happened, ON THE PAGE.
   *
   * Until this existed the only output was a badge number and a browser console
   * nobody opens, so "it filled some things and left a million unanswered" was
   * the honest experience of using it — there was no way to see WHICH things, or
   * why it stopped. The panel is the difference between a tool you trust and one
   * you check by hand anyway.
   *
   * Deliberately plain, top-right, dismissible, and it never covers a form
   * control it might have filled.
   */
  /**
   * DOES THE FORM ALREADY HOLD HIS RESUME? (F-407)
   *
   * A second press on a form that is already filled uploads nothing — there is
   * nothing left to do — and the panel then said "no resume slot on this
   * screen" over a form holding his resume. Read off a Physical Intelligence
   * application: the first press logged "resume ATTACHED", the second reported
   * `uploaded: false`, and the record and the panel both said the opposite of
   * what the page showed.
   *
   * Two ways to see it, and either is enough: a file input still holding its
   * file, or the name this engine always saves under printed on the page —
   * which is how an ATS that swaps the input for a chip (Ashby does) still
   * says so.
   */
  function resumeOnPage() {
    try {
      for (const el of document.querySelectorAll('input[type="file"]')) {
        if (el.files && el.files.length > 0) return true;
      }
      // His name, then a .pdf on the same line: matches the fixed old name
      // and the per-posting one alike ("Alex Rivera - Agility Robotics - …pdf").
      return RESUME_NAME_RE.test(document.body?.innerText || '');
    } catch { return false; }
  }

  /**
   * THE BOX A QUESTION IS ABOUT, with everything the page says around it
   * (2026-09-17). A typed line that is not any box's label — "bro answer all
   * of this" — is HIS REQUEST about the box he was last in, and the box's own
   * label is the question. Shared by the page's box and the side panel.
   */
  function fieldFor(typed, { free = false, request = '' } = {}) {
    let fields = [];
    try { fields = (discover() || []).filter((f) => f.multiline || f.elements?.[0]?.tagName === 'TEXTAREA'); } catch { fields = []; }
    const norm = (s) => String(s || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    let field = fields.find((f) => norm(f.label) === norm(typed)) || null;
    let asking = request;
    if (!field && free) {
      field = (LAST_BOX && fields.find((f) => f.elements?.[0] === LAST_BOX))
        || fields.find((f) => f.required && !String(f.elements?.[0]?.value || '').trim())
        || (fields.length === 1 ? fields[0] : null);
      if (field) asking = [typed, request].filter(Boolean).join(' — ');
    }
    const q = field ? String(field.label || typed).replace(/\s*\*\s*$/, '').trim() : typed;
    const box = field?.elements?.[0];
    const fieldCtx = field ? {
      label: q, near: field.near || '', placeholder: field.placeholder || '',
      maxLength: field.maxLength || 0, value: String(box?.value || '').slice(0, 2000),
    } : null;
    return { q, field, fieldCtx, asking };
  }

  /**
   * THE BOX THIS QUESTION BELONGS TO, found the same way the filler finds any
   * field: by its label, never by position on the page. Guarded: a click that
   * throws here would take the whole strip down with it.
   */
  async function putInBox(q, text) {
    let found = [];
    try { found = discover() || []; } catch { found = []; }
    const field = found.find((f) => String(f.label || '').trim() === q
      || String(f.label || '').replace(/\s*\*\s*$/, '').trim() === q);
    const box = field?.elements?.[0];
    if (!box) return { found: false, said: 'no box on this page matches that question — copy it instead' };
    if (enterText) await enterText(box, text); else setNativeValue(box, text);
    return { found: true, said: String(box.value || '').trim() ? 'in the box' : 'the page did not keep it' };
  }

  /**
   * THE SIDE PANEL REACHES THE PAGE THROUGH HERE (2026-09-23). The panel is
   * an extension page and cannot see the form, so the worker relays: "which
   * box is this question about, and what does the page say around it", "put
   * this answer in that box", and "draw the one-line status" for a report a
   * subframe made. A frame without the box stays silent, so the frame that
   * holds the form is the one that answers; the top frame answers last, with
   * "not here", so the panel is never left waiting.
   */
  const hasBox = (q) => {
    try { return (discover() || []).some((f) => String(f.label || '').replace(/\s*\*\s*$/, '').trim() === q); } catch { return false; }
  };
  try {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg?.type === 'jarvis-field') {
        const found = fieldFor(String(msg.question || ''), { free: !!msg.free, request: String(msg.request || '') });
        if (found.field) {
          reply({ ok: true, here: true, q: found.q, field: found.fieldCtx, asking: found.asking, context: found.field.near || '', ...pageInfo() });
          return false;
        }
        if (window !== window.top) return false;
        setTimeout(() => reply({ ok: true, here: false, q: String(msg.question || '').trim(), field: null, asking: String(msg.request || ''), context: '', ...pageInfo() }), 400);
        return true;
      }
      if (msg?.type === 'jarvis-put') {
        if (hasBox(String(msg.question || ''))) { putInBox(String(msg.question), String(msg.text || '')).then(reply); return true; }
        if (window !== window.top) return false;
        setTimeout(() => reply({ found: false, said: 'no box on this page matches that question — copy it instead' }), 400);
        return true;
      }
      if (msg?.type === 'jarvis-line' && window === window.top) {
        PANEL_OPEN = !!msg.panelOpen;
        chip(PANEL_OPEN ? '' : String(msg.text || ''), { summary: true });
        return false;
      }
      return false;
    });
  } catch { /* no extension context: a harness */ }

  /**
   * THE REPORT GOES TO THE SIDE PANEL, NOT ONTO THE FORM (2026-09-23).
   *
   * "stuff is still climbing on top of each other" — the report was a 330px
   * box pinned over the form's top-right corner, beside a side panel that
   * held the resume and the letter. It now travels to the worker, and the side
   * panel shows it on its Answers tab with every "ask Claude" beside it. With
   * the panel closed the page gets one line in the corner that opens it.
   *
   * The full box below is kept for the one case with no side panel to reach:
   * no extension context at all (a harness, or a page opened before the
   * extension was reloaded, whose `chrome.runtime` is dead). Decided
   * synchronously, so that case draws exactly what it always drew.
   */
  function showPanel(args) {
    const { filled, checked, uploaded, sawUpload, unanswered, kept = [], written = [], readForm = null, steps, stoppedBecause, resumeNote, staleExtension, appliedBefore = null, armed = RUN.armed, waiting = false } = args;
    if (window !== window.top && !(filled > 0 || checked > 0 || uploaded)) return;   // a frame that did nothing says nothing
    // "The form holds his resume" is a fact about the PAGE (F-407).
    const report = {
      filled, checked, holdsResume: !!(uploaded || resumeOnPage()), sawUpload, unanswered: unanswered || [], kept, written, readForm,
      steps, stoppedBecause, resumeNote, staleExtension, appliedBefore, armed, waiting,
      pageUrl: location.href, top: window === window.top, at: Date.now(),
    };
    if (!reachable()) { drawPanel(report); return; }
    send({ type: 'page-report', report }).then((r) => {
      if (!r?.ok) { drawPanel(report); return; }   // the worker is gone: the page is the only place left
      PANEL_OPEN = !!r.panelOpen;
      overlay().getElementById('jarvis-panel')?.remove();
      // A subframe's line is drawn by the top frame, on the worker's relay.
      if (window === window.top) chip(PANEL_OPEN ? '' : JarvisReport.line(report), { summary: true });
    });
  }

  function drawPanel(report) {
    const { armed = RUN.armed } = report;
    chip('');
    const root = overlay();
    root.getElementById('jarvis-panel')?.remove();
    const el = document.createElement('div');
    el.id = 'jarvis-panel';
    el.style.cssText = [
      'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483647',
      'width:330px', 'max-height:70vh', 'overflow:auto',
      'background:#12151a', 'color:#e6edf3', 'border:1px solid #30363d',
      'border-radius:10px', 'padding:13px 15px',
      'font:13px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)',
    ].join(';');

    const esc = JarvisReport.esc;
    const rows = [];
    // THE HEADER STAYS PUT. The panel scrolls at 70vh, and a long report used
    // to carry the ✕ off the top with it — a box he could read and not close.
    rows.push(`<div style="position:sticky;top:0;z-index:2;background:#12151a;border-bottom:1px solid #21262d;margin:-13px -15px 10px;padding:13px 15px 9px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b style="font-size:13.5px">Jarvis</b>
        <span id="jarvis-x" style="cursor:pointer;opacity:.6;padding:0 6px;font-size:14px">✕</span></div>
      <div id="jarvis-live" hidden style="margin-top:7px;padding:5px 8px;border-radius:6px;background:#1b2027;color:#79c0ff;font-size:12.5px"></div></div>`);
    // The report itself: the same renderer the side panel uses (report.js).
    rows.push(JarvisReport.render({ ...report, armed }));

    el.innerHTML = rows.join('');
    root.appendChild(el);
    el.querySelector('#jarvis-x').onclick = () => el.remove();
    el.querySelector('#jarvis-stop')?.addEventListener('click', stopFollowing);

    /**
     * Ask for one answer and show it, with a copy button and — when the
     * question names a box actually on this page — a button that puts it
     * there. Never types anything by itself: this whole strip is his click.
     */
    async function askFor(question, out, say, { again = false, request = '', free = false } = {}) {
      const typed = String(question || '').trim();
      if (!typed) { say('type the question first'); return; }
      const { q, field, fieldCtx, asking } = fieldFor(typed, { free, request });
      if (field && q !== typed) say(`for "${q.slice(0, 40)}"…`);
      say(asking ? 'writing with your request…' : again ? 'writing another…' : 'asking Claude…');
      out.innerHTML = '';
      let got = await send({ type: 'answer', question: q, again: again || !!asking, request: asking, context: field?.near || '', field: fieldCtx, ...pageInfo() }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      let answerKey = got?.key || '';
      const deadline = Date.now() + 420000; // write, check, review, rewrite
      // Same two "not yet" shapes as the filler: 202 started it (ok, no text),
      // 425 says one is already in flight.
      const pending = (r) => !String(r?.text || '').trim() && (r?.writing || r?.status === 'writing');
      while (pending(got) && Date.now() < deadline) {
        await pause(4000);
        say('writing…');
        const k = got?.key || answerKey;
        got = await send({ type: 'answer-get', question: q, key: k }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
        answerKey = got?.key || k;
      }
      if (!got?.ok || !String(got.text || '').trim()) {
        say('');
        out.innerHTML = `<div style="color:#d29922;margin-top:5px">${esc(String(got?.error || got?.why || 'no answer').slice(0, 200))}</div>`;
        return;
      }
      say('');
      const text = String(got.text).trim();
      const problems = got.problems || [];
      // WHY THIS ANSWER AND NOT ANOTHER. The writer now reads the posting,
      // the company and the rest of the form before it writes, and records
      // what it concluded. Showing that is the only way he can tell a good
      // answer from a lucky one — his ask, 2026-09-13: "it should know about
      // me, the job, the company, the culture, the social setting".
      // Folded away by default: the box is what he came for.
      out.innerHTML = JarvisReport.answer(got);
      const said = out.querySelector('.jarvis-said');
      out.querySelector('.jarvis-revise').onclick = () => {
        const note = String(out.querySelector('.jarvis-note').value || '').trim();
        if (!note) { said.textContent = 'say what to change first'; return; }
        askFor(q, out, say, { again: true, request: note.slice(0, 600) });
      };
      out.querySelector('.jarvis-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(text); said.textContent = 'copied'; }
        catch { said.textContent = 'could not copy — select it instead'; }
      };
      out.querySelector('.jarvis-put').onclick = async () => {
        said.textContent = (await putInBox(q, text)).said;
      };
      out.querySelector('.jarvis-again').onclick = () => askFor(q, out, say, { again: true });
    }

    for (const link of el.querySelectorAll('.jarvis-ask')) {
      link.addEventListener('click', () => {
        const out = el.querySelector(`.jarvis-ask-out[data-i="${link.dataset.i}"]`);
        const was = link.textContent;
        askFor(link.dataset.q, out, (m) => { link.textContent = m || was; });
      });
    }
    const freeGo = el.querySelector('#jarvis-ask-go');
    if (freeGo) {
      freeGo.addEventListener('click', () => askFor(
        el.querySelector('#jarvis-ask-q').value,
        el.querySelector('#jarvis-ask-free-out'),
        (m) => { el.querySelector('#jarvis-ask-note').textContent = m; },
        { free: true },
      ));
    }
  }

  /**
   * What the form itself says is wrong, in its own words.
   *
   * Deduplicated and trimmed: Workday renders the same message twice (once in a
   * summary banner, once beside the field) and tacks an internal error code on
   * the end that means nothing to him.
   */
  /**
   * The requests the FORM made and lost, from netwatch.js in the page world.
   *
   * A step that will not advance often says nothing useful — a live Workday
   * refused to move and offered only "Page Error VPS|dc492c63…". The reason was
   * a background request that failed, which nothing here could see.
   */
  function failedRequests() {
    try {
      const raw = document.documentElement.dataset.jarvisNet;
      // Analytics an ad blocker refused is not why a step stalled: every JPL
      // stall named "POST uxi-ingestion.us.mlde.workday.com -> network error"
      // (Opera GX, 2026-10-02), beside the real reason.
      const noise = /uxi-ingestion|\/analytics|telemetry|google-analytics|doubleclick|segment\.io|hotjar|newrelic|nr-data/i;
      return raw ? JSON.parse(raw).filter((x) => !noise.test(JSON.stringify(x))).slice(-4) : [];
    } catch { return []; }
  }

  function pageErrors() {
    const seen = new Set();
    for (const n of document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [data-automation-id*="Error"]')) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(/^Errors?\s*Found/i, '')
        .replace(/Error\s*Code:\s*\S+/i, '')
        .replace(/^Error-\s*/i, '')
        .replace(/Error-Page Error-?/i, '')
        .trim();
      // A role=alert that reports SUCCESS is not why the step stalled: Onto
      // Innovation's "Alex Rivera - … .pdf successfully uploaded" was given as the
      // reason the form "would not move on" (2026-10-01, F-633).
      if (/\bsuccessfully\b|\bsuccess\b|\buploaded\b|\bsaved\b/i.test(t) && !/\b(error|required|invalid|fail(ed|ure)?|must|cannot|can't|not\s+(be\s+)?(allowed|supported|accepted))\b/i.test(t)) continue;
      if (t.length > 8 && t.length < 300) seen.add(t);
    }
    return [...seen].slice(0, 4);
  }

  async function run({ auto = RUN.auto } = {}) {
    // A form drawn after load (a single-page app) is a form once a run reaches it.
    if (reachable()) watchErrors();
    // THE APPLICATION IS SENT. He pressed Submit, the ATS is saying thank you,
    // and an armed tab must stand down here — otherwise the next posting he
    // opens in this tab an hour from now is filled with this employer's resume
    // in hand. Structured, so the worker disarms rather than parses prose.
    const finished = applicationDone && applicationDone();
    if (finished) {
      console.log(`[jarvis] the page says "${finished}" — this application is done. Standing down on this tab.`);
      return {
        frame: location.href, filled: 0, checked: 0, uploaded: false, submitted: String(finished),
        stoppedBecause: `the page says "${finished}" — this application is done`,
      };
    }

    // THE COOKIE BANNER GOES FIRST, declined. It can sit over the Apply
    // button (Stryker) or over the form's last fields, and a click that lands
    // on it is a click that did nothing. The most private choice, every time.
    if (dismissCookieBanner) {
      const declined = dismissCookieBanner();
      if (declined) { console.log(`[jarvis] answered the cookie banner ("${declined}")`); await settle(); }
    }

    // HE HAS ALREADY APPLIED HERE. Applied Materials says so on the posting
    // itself (measured live); so do Eightfold tenants generally. Nothing to
    // fill, and the store should know — so it is reported as sent.
    const already = alreadyApplied && alreadyApplied();
    if (already) {
      console.log(`[jarvis] the page says "${already}" — nothing to do here.`);
      showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, armed: false, stoppedBecause: `You already applied here — the page says "${already}".` });
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, submitted: String(already), alreadyApplied: true, stoppedBecause: `already applied — the page says "${already}"`, auto };
    }

    chip(auto ? 'Jarvis is filling…' : 'Jarvis is reading the page…');

    // A MOVED TENANT COMES FIRST, because it looks exactly like a sign-in wall
    // and the advice is the opposite. Telling him to sign in at an ATS that no
    // longer accepts applications wastes his time in the way that looks most
    // like his own fault (F-236).
    const moved = atsMoved && atsMoved();
    if (moved) {
      const where = moved.link ? ` Apply here instead: ${moved.link}` : '';
      console.log(`[jarvis] this employer has moved to a different application system.${where}`);
      showPanel({
        filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0,
        stoppedBecause: `This employer has moved to a different system — ${moved.why}.${where}`,
      });
      return {
        frame: location.href, filled: 0, checked: 0, uploaded: false, atsMoved: true,
        stoppedBecause: `this employer has moved to a different system — the page says "${moved.why}"${moved.link ? ` — ${moved.link}` : ''}`,
      };
    }

    // A DEAD PAGE BEFORE A WALL. Workday's "The page you are looking for
    // doesn't exist" keeps the header's Sign In link and has no fields, which
    // is exactly what the last wall rule looks for — so a retired Stryker
    // posting was reported as "sign in here" (measured live). Nothing to sign
    // in to; the verdict is the whole result.
    const goneNow = postingGone && postingGone();
    if (goneNow) {
      const why = /(?:^|\.)jobs\.ashbyhq\.com$/i.test(location.hostname)
        ? `Ashby's hosted page says "${goneNow}". This company may run its board on its own site — the dashboard checks the board before retiring the posting.`
        : `this posting is gone — the page says "${goneNow}". Nothing to fill.`;
      showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, armed: false, stoppedBecause: why });
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, postingGone: String(goneNow), stoppedBecause: why, auto };
    }

    // A sign-in wall is not a broken form, and saying which it is turns
    // "this thing does nothing" into "create an account here first".
    //
    // Signing in is his — passwords, verification codes, SSO. On an armed tab
    // the watcher stays on through it, so the form that appears once he is in
    // fills without a second click. That is the difference he asked for.
    if (signInWall && signInWall()) {
      // "JUST PRESS SIGN IN WITH GOOGLE" — his words, and his standing
      // instruction. Once per document: the page navigates to Google and
      // back, and the armed tab picks the form up on its return. Never the
      // email/password route, never "create account".
      const sso = ssoControl && ssoControl();
      if (sso && RUN.armed && !state.pressedSso) {
        state.pressedSso = true;
        console.log('[jarvis] a sign-in wall with "Sign in with Google" — pressing it');
        chip('Jarvis: signing in with Google…');
        clickNoSubmit(sso);
        await settle();
        return {
          frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, pressedSso: true,
          stoppedBecause: 'pressed Sign in with Google — the form fills by itself once you are back',
        };
      }
      // AN EMAIL-ONLY FIRST SCREEN IS FILLED, NOT JUST NAMED (2026-09-24).
      // iCIMS (Werfen, Joby, AMD, Marvell): "Enter Your Information" — his
      // email, a California-resident box, a privacy "I accept", and an
      // hCaptcha. "icims sucks too": the run filled nothing and said "give
      // your email". There is no password and nothing to sign into, so the
      // boxes are answered like any other; the human check and the Next press
      // stay his, and nothing here touches either.
      if ((signInWallKind && signInWallKind()) === 'email' && !state.filledEmailGate) {
        state.filledEmailGate = true;
        let r = null;
        try {
          r = await fillCurrentStep();
          // A box that appears once another is ticked — Werfen's privacy
          // "I accept" shows only after the California box — gets its own pass.
          if (settle) await settle();
          const again = await fillCurrentStep(null, { keepExisting: true, entries: false });
          if (again) r = { ...r, filled: (r?.filled || 0) + (again.filled || 0), checked: (r?.checked || 0) + (again.checked || 0), unanswered: again.unanswered || r?.unanswered || [] };
        } catch (e) { console.log('[jarvis] email screen:', e?.message || e); }
        const got = (r?.filled || 0) + (r?.checked || 0);
        const why = got
          ? `your email${r?.checked ? ' and the consent' : ''} are filled — do the human check if there is one and press Next yourself; ${RUN.armed ? 'the form fills by itself from there' : 'then click Jarvis again'}`
          : wallWords(RUN.armed).short;
        showPanel({ filled: r?.filled || 0, checked: r?.checked || 0, uploaded: false, unanswered: r?.unanswered || [], steps: 1, waiting: true, stoppedBecause: why });
        return { frame: location.href, filled: r?.filled || 0, checked: r?.checked || 0, uploaded: false, unanswered: r?.unanswered || [], signInRequired: true, stoppedBecause: why };
      }
      console.log('[jarvis] this tenant wants you signed in before it shows the application.');
      showPanel({
        filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0,
        waiting: true,
        stoppedBecause: wallWords(RUN.armed).panel,
      });
      return {
        frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true,
        stoppedBecause: wallWords(RUN.armed).short,
      };
    }

    // A page refusing us — a human check, an Access Denied — is his to clear,
    // and nothing here is typed until he has. Named before anything is
    // clicked, because the checks above are about walls and this is about a
    // page that is not really there.
    const blockedNow = pageBlocked && pageBlocked();
    if (blockedNow) {
      showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: blockedNow.why });
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, blocked: blockedNow.kind, stoppedBecause: blockedNow.why };
    }

    // TELL THE SERVER WHAT JOB THIS IS, in the page's own words.
    //
    // Sent before the plan, so the resume is building before the first field
    // is typed. The worker records the id the server answers with on the TAB,
    // and every later request from this tab carries it — which is how a
    // Workday form on a host that never names the employer still gets the
    // employer's resume, and how a posting the store has never seen gets one
    // at all. Best-effort: a page that says nothing about the job still fills.
    //
    // From the top frame only, after the walls: an embedded board's iframe
    // does not speak for the page around it, and a sign-in page's leftover
    // markup does not speak for anything.
    let posted = null;
    const posting = window === window.top && readPosting ? readPosting() : null;
    if (posting?.title) {
      posted = await send({ type: 'posting', pageUrl: location.href, posting }).catch(() => null);
      if (posted?.ok && posted.company) chip(`Jarvis: ${posted.tailored ? 'writing the resume for' : 'preparing the resume for'} ${posted.company}…`);
      // The worker knows, now that the page has said which job it is, whether
      // this is still an application HE began. It may not be: measured live,
      // a tab armed on one posting and navigated to another kept "started"
      // from the first and pressed Apply on the second.
      if (posted?.ok && typeof posted.started === 'boolean') RUN.started = posted.started;
    }

    // Workday opens on a "Start Your Application" modal with no form behind it,
    // so clicking the extension on a fresh apply URL found zero controls and
    // reported nothing. Choose Apply Manually and wait for step one to paint.
    // Allowed on a run nobody clicked for: the modal only exists because
    // Apply was pressed, so this is a choice inside an application already
    // begun, not the beginning of one.
    const gate = startGate && startGate();
    if (gate) {
      console.log(`[jarvis] pressing "${String(gate.textContent || gate.getAttribute?.('aria-label') || 'Apply Manually').replace(/\s+/g, ' ').trim().slice(0, 40)}" to start the application`);
      gate.click();
      await settle();
      if (waitForSomething) await waitForSomething();
    }

    // Clicked on a JOB POSTING rather than the form? Follow Apply.
    //
    // Bosch (SmartRecruiters), Form Energy (Ashby) and Joby (iCIMS) postings all
    // have an Apply button and no application fields, so the report read
    // "0 filled" — which looks like a broken tool rather than the wrong page.
    // Following the link is also the difference between "a form filler" and
    // "press Apply and it applies".
    //
    // BUT ONLY WHEN HE MEANT TO APPLY HERE. His press means "apply to this".
    // A run nobody pressed for — the armed tab landing on a posting — may
    // follow Apply only if the application was begun by his press (`started`:
    // the Apply link opened a new tab, or an intermediate page offers Apply
    // again), and at most once per document, so a page that keeps offering
    // Apply cannot become a loop. A posting he merely navigated the armed tab
    // to is READ (its title goes to the server above) and never applied to:
    // the panel says so and the next press is his.
    // WORKABLE'S FEED LINKS TO A TEXT PAGE WITH NO APPLY ON IT. The scanner
    // stores apply.workable.com/<slug>/jobs/view/<id> — Workable's plain-text
    // rendering, which has no button and no form (Verustruct, driven
    // 2026-09-24: "no form here yet"). The application lives at
    // /<slug>/j/<id>/apply/. Only on his press, like following Apply.
    const workableView = location.href.match(/^https:\/\/apply\.workable\.com\/([^/]+)\/jobs\/view\/([A-Z0-9]+)(?:\.md)?\/?(?:[?#].*)?$/i);
    if (workableView && !auto) {
      console.log('[jarvis] Workable text page — going to its application form');
      await send({ type: 'following', pageUrl: location.href }).catch(() => null);
      location.assign(`https://apply.workable.com/${workableView[1]}/j/${workableView[2]}/apply/`);
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, isPosting: true, stoppedBecause: 'opening the application form' };
    }
    const applyBtn = applyControl && applyControl();
    const mayFollow = !auto || (RUN.started && !state.followedApply);
    if (applyBtn && !mayFollow) {
      // A SIGN-IN PAGE THAT ALSO OFFERS "APPLY" IS A SIGN-IN PAGE. Microsoft's
      // Eightfold apply page (measured 2026-09-06) carries a header Apply link
      // beside "Select a method below to Sign in"; the run read it as a
      // posting and told him it was a different one. The wall is his to pass,
      // and the form fills by itself once he is in.
      if (signInWall && signInWall()) {
        const said = wallWords(RUN.armed);
        const why = said.short;
        showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: said.panel });
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, stoppedBecause: why, auto };
      }
      const why = 'this is a posting — click Jarvis to apply to it';
      console.log(`[jarvis] ${why}`);
      // Said as what it is: a posting the run will not press Apply on by
      // itself. It is "a different posting" only when the tab was armed for
      // another job; a page reached by following Apply that offers Apply
      // again is not (Microsoft's Eightfold, measured 2026-09-06).
      const other = RUN.id && posted?.id && String(posted.id) !== String(RUN.id);
      showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: `${other ? 'This is a different posting.' : 'This is a posting, not the form.'} ${why.replace(/^this is a posting — /, '').replace(/^click/, 'Click')}.` });
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, isPosting: true, stoppedBecause: why };
    }
    if (applyBtn) {
      console.log('[jarvis] this is the posting, not the form — following Apply');
      state.followedApply = true;
      // Tell the worker BEFORE the click: an Apply that opens a new tab is
      // recognised as ours only if this arrived just before the tab did.
      await send({ type: 'following', pageUrl: location.href }).catch(() => null);
      // WHAT WAS HERE BEFORE THE CLICK (Swisslog, 2026-09-26, F-623): "APPLY
      // HERE" opened KUKA's board in a NEW TAB, the posting kept its search box
      // and a Resume/CV box, and the run took those for the form painted in
      // place — the resume went into the posting page. Apply that opened a new
      // tab, or changed nothing on this one, leaves this page alone.
      const fieldsSig = () => discover().map((f) => `${f.type}|${f.label}`).join('\n');
      const beforeSig = fieldsSig();
      const beforeUrl = location.href;
      const newTab = /^_blank$/i.test(String(applyBtn.getAttribute?.('target') || '').trim());
      clickNoSubmit(applyBtn);
      await settle();
      if (waitForSomething) await waitForSomething();
      // ONLY A NEW TAB (2026-09-30): "changed nothing on this page" also
      // matched Ashby's own application page, which keeps its "Apply for
      // this Job" button above the form — every Ashby fill ended "followed
      // Apply" with 0 filled from 2026-09-27 until this. A form still here
      // after an in-place Apply is the form.
      if (beforeSig && newTab && location.href === beforeUrl && !(startGate && startGate()) && !(signInWall && signInWall())) {
        const msg = 'followed Apply — the application opened in another tab';
        console.log(`[jarvis] ${msg}`);
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, followedApply: true, stoppedBecause: msg };
      }

      // THE GATE CAN COME AFTER APPLY. Measured live on KLA: Apply opens
      // Workday's "Start Your Application" modal IN PLACE — no navigation, no
      // new fields — so the gate check above, which ran before Apply, saw
      // nothing, and the run ended one click short with nothing to wake it.
      // The Playwright driver learned the same lesson as F-239.
      const lateGate = startGate && startGate();
      if (lateGate) {
        console.log(`[jarvis] Apply opened a gate — pressing "${String(lateGate.textContent || lateGate.getAttribute?.('aria-label') || 'Apply Manually').replace(/\s+/g, ' ').trim().slice(0, 40)}"`);
        lateGate.click();
        await settle();
        // The step behind the gate takes seconds to paint and changes nothing
        // the signature sees while it does. Wait for it to BE something.
        if (waitForSomething) await waitForSomething();
      }

      // AN APPLY THAT OPENS A MENU (SuccessFactors career sites — AGCO, F-347):
      // "Apply now" is a dropdown toggle, and the link that applies is the
      // "Apply Now" item inside it, beside "Start applying with LinkedIn".
      // The plain item is chosen; a social sign-in never is.
      if (!discover().length && !(startGate && startGate())) {
        const items = (deepQuerySelectorAll ? deepQuerySelectorAll('[role="menu"] a, [role="menu"] button, .dropdown-menu a, .dropdown-menu button, [role="menuitem"]') : [])
          .filter((a) => onScreen(a) && !wouldSubmit(a))
          .map((a) => ({ a, name: (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() }))
          .filter(({ name }) => name && !SOCIAL_APPLY_RE.test(name));
        const pick = items.find(({ name }) => /^apply(?: now| manually| with (?:resume|email))?$/i.test(name))
          || items.find(({ name }) => /^(?:apply\b.*|continue|start(?: application)?)$/i.test(name));
        if (pick) {
          console.log(`[jarvis] Apply opened a menu — choosing "${pick.name}"`);
          clickNoSubmit(pick.a);
          await settle();
          if (waitForSomething) await waitForSomething();
        }
      }

      // If the form appeared in place, carry on. Many Apply controls are links
      // that NAVIGATE, and a navigation destroys this script mid-run. The tab
      // is armed, so the worker picks the walk up on whatever page the link
      // opened — the same path every other navigation takes now. `followedApply`
      // is reported so the record says what happened here.
      // The page Apply opened, painted in place: fields, a wall or a gate.
      // Eightfold's Apply is a route change whose sign-in paints a few
      // seconds later while the header's Apply link stays (F-365); the old
      // eight-second wait counted that link as the page having arrived,
      // returned "followed Apply", and the watcher then took the sign-in
      // page for the step the run had ended on. Wait for something that is
      // not the Apply link, and walk on if it is a wall.
      if (!discover().length && waitForSomething) await waitForSomething(20000, { ignoreApply: true });
      // WHAT APPLY OPENED MAY BE A DOOR, NOT A FORM (F-388).
      //
      // Measured live on HP's Workday tenant: Apply → "Apply Manually" →
      // **Create Account** (email, password, verify password, a consent box and
      // a bot trap). The wall check further down runs only from step 2, or
      // behind a gate, or after a wait — none of which is true here — so the
      // run fell straight through into filling an account-creation form and
      // told him the bot trap was the one thing left for him to do. Signing in
      // and creating accounts are his, always; this is the earliest place that
      // can be said on this path.
      if (signInWall && signInWall()) {
        // HIS STANDING ANSWER HERE TOO: press "Sign in with Google" (2026-10-16).
        // Only the wall met BEFORE Apply pressed it; ADP's talent-community
        // sign-up appears AFTER Apply and its Consent gate, and was filled and
        // left at the verification code instead.
        const sso = ssoControl && ssoControl();
        if (sso && RUN.armed && !state.pressedSso) {
          state.pressedSso = true;
          console.log('[jarvis] Apply opened a sign-in with "Sign in with Google" — pressing it');
          chip('Jarvis: signing in with Google…');
          clickNoSubmit(sso);
          await settle();
          return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, pressedSso: true, followedApply: true,
            stoppedBecause: 'pressed Sign in with Google — the form fills by itself once you are back' };
        }
        const said = wallWords(RUN.armed);
        console.log(`[jarvis] Apply opened a wall — ${said.short}`);
        showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: said.panel });
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, stoppedBecause: said.short, auto };
      }
      if (!discover().length && !(pageBlocked && pageBlocked()) && !(startGate && startGate())) {
        const msg = 'followed Apply — picking up on the page it opened';
        console.log(`[jarvis] ${msg}`);
        return {
          frame: location.href, filled: 0, checked: 0, uploaded: false,
          unanswered: [], steps: 0, followedApply: true, stoppedBecause: msg,
        };
      }
    }

    // A RUN NOBODY CLICKED FOR NEEDS A REASON TO BELIEVE THIS IS THE
    // APPLICATION. Under the permissions that make following possible, "a
    // page with a form on it" includes a vendor's contact form. His press
    // means "fill this"; a navigation means nothing until the page looks like
    // the thing being followed.
    // AN EMPTY PAGE IS NOT YET A PAGE (F-365). The worker injects on "the
    // page loaded", and Microsoft's Eightfold apply page paints its sign-in
    // half a second later: a run that judged the empty document said "not an
    // application" and nothing woke it. Wait for the page to be something,
    // then look for the wall before judging.
    let waitedForForm = false;
    if (auto && window === window.top && waitForSomething && !discover().length
      && !(signInWall && signInWall()) && !(startGate && startGate()) && !(applyControl && applyControl())) {
      chip('waiting for the page…');
      waitedForForm = await waitForSomething(25000);
      chip('');
      if (signInWall && signInWall()) {
        const said = wallWords(true);
        showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: said.panel });
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, stoppedBecause: said.short, auto };
      }
    }
    if (auto && looksLikeApplication && !looksLikeApplication()) {
      // A page with a search box and a header is "not an application" the
      // moment it loads and a sign-in page a second later (F-365). Let it
      // settle, and look for the wall once more before saying nothing.
      if (settle) await settle();
      if (signInWall && signInWall()) {
        const said = wallWords(true);
        showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: said.panel });
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, stoppedBecause: said.short, auto };
      }
      const why = 'this page does not look like an application — click Jarvis if it is one';
      console.log(`[jarvis] ${why}`);
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, notApplication: true, stoppedBecause: why };
    }

    const steps = [];
    // The clock starts with the walk, not with the script (F-465).
    SPENT.began = Date.now();
    SPENT.answers = 0; SPENT.resume = 0; SPENT.prompts = 0; SPENT.entries = 0;
    let uploaded = false;
    let sawUpload = false;
    let filled = 0;
    let checked = 0;
    let skipped = 0;
    /** Every label answered anywhere in this walk (F-399). */
    const answeredAll = [];
    const unanswered = [];
    const unansweredSeen = new Set();
    const keptAll = [];
    /** Every written answer this run typed, across all its steps. */
    const writtenAll = [];
    /**
     * Did any step of this run actually READ a form?
     *
     * The panel used to decide that from `filled + checked === 0 && !uploaded`
     * — and a resume attached on an EARLIER step made `uploaded` true, so a
     * page with three empty required textareas on it printed the green
     * "nothing left unanswered" (F-443, screenshotted). A resume from a page
     * ago is not evidence that this page was read, and nothing except reading
     * it is.
     */
    let readForm = false;
    let stoppedBecause = 'reached the last step before Submit';
    let resumeNote = null;
    let staleExtension = null;
    // Whether the store already has this application (F-414).
    let appliedBefore = null;
    // One retry of a refused signature date per run (F-732).
    let dateRetried = false;

    for (let step = 1; step <= MAX_STEPS; step += 1) {
      // THE WALLS, AGAIN, ON EVERY STEP. Apply Manually while signed out lands
      // on Workday's Create Account step; a tenant can put a verification code
      // between two steps. Checked once at the top, they were never seen
      // again, and the credential form went to the planner — which refuses
      // it, but only after this file had pressed Continue on it once.
      // …and after a wait for a page that painted late (F-365): the walls
      // were checked before the page had anything on it.
      // …AND ON A PRESS THAT LANDED ON ONE (F-388). This was gated on "not the
      // first step of a run nobody had to follow anything to reach", which is
      // exactly what a press on Workday's Create Account page is: measured
      // live on HP's tenant, the run went on to plan and fill an
      // account-creation form. The gate was there to stop a Workday POSTING
      // reading as a wall — every one of them carries a header Sign In link —
      // and `signInWall()` has answered that on its own since F-236: a page
      // offering Apply is never a wall. So the gate costs correctness and buys
      // nothing, and the walls are checked on every step of every run.
      {
        if (signInWall && signInWall()) {
          const said = wallWords(RUN.armed);
          stoppedBecause = said.short;
          showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, waiting: true, stoppedBecause: said.panel });
          return { frame: location.href, filled, checked, skipped, uploaded, unanswered, steps: steps.length, signInRequired: true, stoppedBecause, auto };
        }
        const blocked = pageBlocked && pageBlocked();
        if (blocked) {
          showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, waiting: true, stoppedBecause: blocked.why });
          return { frame: location.href, filled, checked, skipped, uploaded, unanswered, steps: steps.length, blocked: blocked.kind, stoppedBecause: blocked.why, auto };
        }
      }
      // EVERY CONSENT, ON EVERY STEP (his rule, 2026-10-03: "can we just
      // press consent on everything … even the eightfold sites just consent").
      // A notice raised mid-walk is pressed before the step is read; at most
      // three in a row, so a notice that will not close cannot hold the walk.
      for (let n = 0; n < 3 && consentGate; n += 1) {
        const go = consentGate();
        if (!go) break;
        console.log(`[jarvis] consented: "${String(go.textContent || go.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`);
        clickNoSubmit(go);
        // eslint-disable-next-line no-await-in-loop
        await settle();
      }
      const before = stepSignature();
      // A STEP ALREADY FILLED IN THIS TAB IS HIS TO REVIEW. A run nobody
      // pressed for — the watcher, or the re-injection that follows every page
      // load — stops here instead of filling it again and pressing Next
      // (Western Digital, 2026-09-24: Back to step one was filled and advanced
      // twice, by the re-injection, not the watcher). His press always runs.
      if (auto && step === 1 && handledCoarse.has(coarse(before))) {
        stoppedBecause = 'a step Jarvis already filled — it is yours to review; press Jarvis to fill it again';
        console.log(`[jarvis] ${stoppedBecause}`);
        break;
      }
      // EVERY STEP THIS WALK FILLS IS HANDLED, not only the one it ends on
      // (Western Digital, 2026-09-24: "when i try to review my info it keeps
      // refilling … when i go back a page"). Going Back to step one looked
      // new to the watcher, which filled it again and pressed Next, taking him
      // off the page he meant to read.
      state.handled.add(before); handledCoarse.add(coarse(before));
      const r = await fillCurrentStep(null, { keepExisting: auto });
      for (const k of r.kept || []) if (!keptAll.includes(k)) keptAll.push(k);
      for (const w of r.written || []) if (!writtenAll.some((x) => x.label === w.label)) writtenAll.push(w);
      readForm = readForm || !!r.readForm;

      // A DEAD POSTING IS THE WHOLE RESULT, not a step with nothing on it.
      // fillCurrentStep has always recognised "Page not found" (F-250) and
      // the loop threw the verdict away: the panel read "0 filled · not a
      // multi-step application" over a page that said the job was gone, and
      // the store was never told. Measured live on a Form Energy posting.
      if (r.postingGone) {
        stoppedBecause = r.note || `this posting is gone — the page says "${r.postingGone}"`;
        showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, stoppedBecause, armed: false });
        return { frame: location.href, filled, checked, skipped, uploaded, unanswered, steps: steps.length, postingGone: r.postingGone, stoppedBecause, auto };
      }
      if (r.note && r.filled === 0 && !(r.fieldKeys || []).length && step === 1 && /human-verification|refused the browser/.test(r.note)) {
        showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, waiting: true, stoppedBecause: r.note });
        return { frame: location.href, filled, checked, skipped, uploaded, unanswered, steps: steps.length, blocked: true, stoppedBecause: r.note, auto };
      }
      // THE FORM IS NOT THERE YET (F-360). SmartRecruiters paints its
      // application seconds after the document — under load, more than the
      // eight seconds a run waits for something — so his press reported
      // "0 filled · this page is not a multi-step application" and the real
      // walk ran two minutes later through the watcher. His press waits once
      // more, longer, and takes the step again; if there is still nothing,
      // the panel says that, in those words, never "not an application".
      // A run nobody pressed for waits too (F-365): the worker injects on
      // "the page loaded", which on Microsoft's Eightfold apply page is half
      // a second before the sign-in page paints — the run saw an empty page,
      // said nothing, and nothing came later to wake it.
      if (r.note === 'no form controls here' && step === 1 && !r.filled && !r.checked && !r.uploaded && window === window.top) {
        if (!waitedForForm && waitForSomething) {
          waitedForForm = true;
          chip('waiting for the form to appear…');
          if (await waitForSomething(25000)) { step -= 1; continue; }
        }
        stoppedBecause = RUN.armed
          ? 'no form here yet — this tab is followed, and the form fills by itself when it appears'
          : 'no form on this page yet — open the application, then press Jarvis again';
        // A follow-along run on a page that stayed empty keeps the last panel.
        if (!auto) showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, waiting: true, stoppedBecause });
        return { frame: location.href, filled, checked, skipped, uploaded, unanswered, written: writtenAll, steps: steps.length, stoppedBecause, auto };
      }
      const stepFilled = new Set(r.filledKeys || []);
      checked += r.checked; skipped += (r.skipped || 0); uploaded = uploaded || r.uploaded;
      sawUpload = sawUpload || !!r.sawUpload;

      // ANSWERING A QUESTION CAN REVEAL ANOTHER ONE.
      //
      // Measured on a live Torc Robotics form: "Please identify your race" does
      // not exist on page load. It appears only once "Are you Hispanic/Latino?"
      // is answered — so it was never in the plan, never filled, and never
      // reported. An unanswered field nobody is told about is the worst of the
      // three outcomes.
      //
      // One extra pass, and only when genuinely NEW fields appeared, so a form
      // that re-renders on every keystroke cannot spin here.
      // COUNTED, NOT A SET (F-611). An entry row the pass added carries the
      // same labels as the row before it: HP's second language row has its
      // own "Overall", and a set of labels called it seen, so it was never
      // answered and Workday refused the step ("The field Overall is required",
      // twice, 2026-09-26). A label present more times than before is new;
      // page order puts the added rows' fields after the old ones.
      const seenCount = new Map();
      for (const k of (r.fieldKeys || []).map(String)) seenCount.set(k, (seenCount.get(k) || 0) + 1);
      const metNow = new Map();
      const starved = new Set((r.starvedKeys || []).map(String));
      const revealed = discover().filter((f) => {
        const k = `${f.label}|${f.type}`;
        const n = (metNow.get(k) || 0) + 1;
        metNow.set(k, n);
        if (n > (seenCount.get(k) || 0)) return true;
        // …or a list that was empty on the first pass and has its options now,
        // still unanswered: the State that loads once Country is chosen.
        const el = f.elements?.[0];
        return starved.has(k) && el?.tagName === 'SELECT' && el.options.length > 2 && !el.value;
      });
      if (revealed.length) {
        console.log(`[jarvis] answering revealed ${revealed.length} more field(s) — filling those too`);
        // The revealed fields only — never the entries again (F-355): the
        // sub-form of an entry still open counts as revealed fields, and
        // adding the entries twice is what happened.
        const extra = await fillCurrentStep(revealed, { keepExisting: auto, entries: false, readBack: true });
        // COUNT THE REVEALED FIELDS ONLY. The second pass re-fills everything
        // it can see, including what the first pass already did, so adding its
        // total reported 37 filled against a 36-field form. Nobody was misled
        // about WHICH fields were done — the per-field report was right — but
        // this project's worst failures have all been headline numbers claiming
        // more than happened, so the number is made to match.
        // Union of IDENTITIES, so a field the second pass re-filled cannot be
        // counted twice — Eightfold re-renders labels between passes, which is
        // what made an approximation here wrong.
        for (const k of extra.filledKeys || []) stepFilled.add(k);
        checked += extra.checked; uploaded = uploaded || extra.uploaded;
        sawUpload = sawUpload || !!extra.sawUpload;
        for (const k of extra.kept || []) if (!keptAll.includes(k)) keptAll.push(k);
        for (const w of extra.written || []) if (!writtenAll.some((x) => x.label === w.label)) writtenAll.push(w);
        readForm = readForm || !!extra.readForm;
        for (const u of extra.unanswered || []) {
          const line = `step ${step}: ${u}`;
          if (!unansweredSeen.has(u)) { unansweredSeen.add(u); unanswered.push(line); }
        }
        for (const a of extra.answered || []) if (a && !answeredAll.includes(a)) answeredAll.push(a);
      }

      filled += stepFilled.size;

      // The second pass re-reports every field the first pass could not answer,
      // so the list he reads would carry each of them twice. Deduplicated by
      // text: a longer unanswered list is exactly the thing these fixes exist
      // to shrink.
      // …and across STEPS too: SmartRecruiters re-renders its first page when
      // the resume attaches, the signature changes, the page counts as a new
      // step, and the same five optional links were listed twice (measured
      // 2026-09-04: "13 left for you" for 8 questions). The same words are
      // the same question wherever they recur; the step named is the first.
      for (const u of r.unanswered || []) {
        const line = `step ${step}: ${u}`;
        if (!unansweredSeen.has(u)) { unansweredSeen.add(u); unanswered.push(line); }
      }
      for (const a of r.answered || []) if (a && !answeredAll.includes(a)) answeredAll.push(a);
      // WHAT THE PAGE HAS THAT THE PLAN NEVER SAW (2026-10-03). A question
      // discover() drops is otherwise reported nowhere — AMAT's ten radio
      // questions went unseen on every application for weeks. Each one is
      // shown to him, written to the page log as "unseen", and its markup
      // captured (three per page) so the reader can be fixed by platform.
      try {
        const unseen = unseenControls ? unseenControls() : [];
        if (unseen.length) {
          console.log(`[jarvis] ${unseen.length} question(s) on the page Jarvis did not see — ${unseen.map((u) => u.label).join(' | ').slice(0, 200)}`);
          for (const u of unseen) {
            const said = `${u.label || u.kind} (on the page, but Jarvis never saw it — answer it yourself)`;
            if (!unansweredSeen.has(said)) { unansweredSeen.add(said); unanswered.push(`step ${step}: ${said}`); }
          }
          const fresh = unseen.filter((u) => !ERRORS_SENT.has(`${location.pathname}|unseen|${u.label}`));
          for (const u of fresh) ERRORS_SENT.add(`${location.pathname}|unseen|${u.label}`);
          if (fresh.length) {
            send({ type: 'page-errors', trigger: `step ${step}: on the page, not in the plan`, pageUrl: location.href, heading: pageHeading(), pageTitle: document.title,
              errors: fresh.map((u) => ({ text: u.label || u.kind, how: 'unseen', field: `${u.kind}${u.required ? ' · required' : ''}`, color: '' })) });
            for (const u of fresh.slice(0, 3)) captureAround(u.el, 'on the page, not in the plan (unseen)', u.label);
          }
        }
      } catch { /* a check, never the fill */ }
      steps.push({ step, ...r });
      console.log(`[jarvis] step ${step}: filled ${r.filled}, ticked ${r.checked}${r.uploaded ? ', resume attached' : ''}${r.error ? ` — ${r.error}` : ''}`);
      // NO PLAN IS THE WHOLE RESULT. When the worker could not reach the
      // dashboard the step returns an error and nothing filled; the loop
      // used to fall through to "this page is not a multi-step application"
      // and the only trace of the real reason was a console line. Measured on
      // Lam with the dashboard down: a full form, 0 filled, and a panel that
      // read like the form was the problem.
      if (r.error && !r.filled && !r.checked && !r.uploaded) {
        stoppedBecause = `nothing filled — ${r.error}`;
        showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, stoppedBecause });
        return { frame: location.href, filled, checked, skipped, uploaded, unanswered, steps: steps.length, error: r.error, stoppedBecause, auto };
      }
      if (r.resumeNote) { resumeNote = r.resumeNote; console.log('[jarvis]', r.resumeNote); }
      if (r.staleExtension) staleExtension = r.staleExtension;
      if (r.applied && !appliedBefore) {
        appliedBefore = r.applied;
        console.log(`[jarvis] you already applied to ${r.applied.where === 'this' ? 'THIS posting' : `this role at ${r.applied.company}`}`);
      }

      const next = nextControl();
      if (!next) {
        // Say WHICH kind of stop this is. "There is no way on" and "the only way
        // on submits the form" look identical from outside, and the second one is
        // the rule working rather than a fault.
        const blocked = advanceBlockedBy && advanceBlockedBy();
        stoppedBecause = blocked
          ? `${blocked}${RUN.armed && !/press/i.test(blocked) ? ' — press it, and the next page fills by itself' : ''}`
          : (step === 1
            // A single-page form that filled is a success, and used to be
            // reported in words that read like a failure (measured on Lam:
            // 18 filled, resume attached, "not a multi-step application").
            // …and a SECOND press on a form already filled is the same
            // success. Measured on the Applied Materials form (2026-09-06):
            // every field held its answer, so the pass filled nothing, and the
            // panel said "this page is not a multi-step application" over a
            // complete application. What was skipped counts as answered here —
            // it is skipped precisely because it already holds the answer.
            ? ((filled + checked > 0 || uploaded || skipped > 0)
              ? 'a single-page application — everything that could be filled is; Submit is yours'
              : 'this page is not a multi-step application')
            : 'reached the last step before Submit');
        break;
      }

      // A RUN NOBODY CLICKED FOR ADVANCES ONLY A STEP IT DID SOMETHING ON.
      // If everything on this step was already his, pressing Save and
      // Continue for him is pressing a button he may have been about to read
      // first. His press walks; a follow-along run walks only where it worked.
      if (auto && stepFilled.size === 0 && r.checked === 0 && !r.uploaded) {
        stoppedBecause = 'this step was already answered — the next press is yours';
        break;
      }

      // THE PAGE IS COMPARED WITH ITSELF JUST BEFORE THE CLICK (F-357), not
      // with the snapshot taken before filling. Filling changes the page —
      // a consent reveals a question, an entry panel opens and closes — so
      // a Next that did nothing still read as "a new step", and on Becton
      // Dickinson the walk counted eight steps on one page, re-adding the
      // same refused entry each time.
      const beforeClick = stepSignature();
      state.handled.add(beforeClick); handledCoarse.add(coarse(beforeClick));   // the step as he will find it on Back
      next.scrollIntoView({ block: 'center' });
      next.click();
      await settle();

      let stuck = stepSignature() === beforeClick || stepSignature() === before;
      // A REFUSED SIGNATURE DATE IS RETRIED ONCE with the other today (F-732),
      // then the same button pressed again — the press he already made.
      if (stuck && !dateRetried && /\bdate\b[^·]{0,80}\b(required|today)/i.test(pageErrors().join(' · '))) {
        dateRetried = true;
        if (await retrySignatureDate()) {
          (nextControl() || next).click();
          await settle();
          stuck = stepSignature() === beforeClick || stepSignature() === before;
        }
      }

      if (stuck) {
        // Workday keeps you on a step when something required is missing, and it
        // says exactly what. Its own words beat any guess of ours: the first
        // time this fired, the answer was "The field Upload a file (5MB max) is
        // required" — which is the whole reason applications went nowhere.
        // The page's own words first, then the requests it lost. Either alone
        // has been the whole answer at least once; the combination is what turns
        // "it stopped" into something he can act on.
        const said = pageErrors();
        const lost = failedRequests();
        stoppedBecause = said.length
          ? `the form would not move on: ${said.join(' · ')}`
          : 'the form stayed on this step — something required is still empty, see the list above';
        if (lost.length) stoppedBecause += ` — and these requests failed: ${lost.join(' · ')}`;
        break;
      }
      if (step === MAX_STEPS) stoppedBecause = `stopped after ${MAX_STEPS} steps`;
    }

    console.log(`[jarvis] done: ${filled} filled, ${checked} ticked, resume ${uploaded ? 'ATTACHED' : 'not attached'} across ${steps.length} step(s)`);
    // WHERE THE TIME WENT (F-465). Printed on every run, so the next long form
    // that feels slow names its own bottleneck instead of being guessed at.
    {
      const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
      console.log(`[jarvis] time: ${secs(Date.now() - SPENT.began)} total — answers ${secs(SPENT.answers)}, resume ${secs(SPENT.resume)}, dropdowns ${secs(SPENT.prompts)}, experience/education ${secs(SPENT.entries)}${document.visibilityState === 'hidden' ? ' (tab was hidden)' : ''}`);
    }
    if (unanswered.length) console.log('[jarvis] left for you:', unanswered);
    console.log(`[jarvis] stopped because: ${stoppedBecause}`);
    console.log('[jarvis] Submit is yours. Nothing here presses it.');
    // A follow-along run that found nothing to do says nothing. The panel from
    // the run that did the work is the one he is reading, and replacing it
    // with "0 filled" every time the page twitches is how a working tool
    // comes to look broken.
    const didSomething = filled > 0 || checked > 0 || uploaded || unanswered.length > 0;
    if (!auto || didSomething) {
      showPanel({ filled, checked, uploaded, sawUpload, unanswered, kept: keptAll, written: writtenAll, readForm, steps: steps.length, stoppedBecause, resumeNote, staleExtension, appliedBefore });
    } else chip('');
    // `where` names the page AND the step on it. An SPA whose steps share one
    // URL (Eightfold) would otherwise look like the same page to the worker's
    // quiet-run hold (F-379), and the step after three quiet runs would never
    // be filled.
    return { frame: location.href, filled, checked, skipped, uploaded: uploaded || resumeOnPage(), unanswered, answered: answeredAll, kept: keptAll, written: writtenAll, readForm, steps: steps.length, stoppedBecause, sawForm: true, where: `${location.href}##${(stepSignature && stepSignature()) || ''}`.slice(0, 400), auto };
  }

  // ── following him ───────────────────────────────────────────────────
  //
  // The walk above stops for reasons that are his to resolve: a sign-in, a
  // human check, a required question the profile cannot answer. He resolves
  // it and presses Save and Continue himself — and the next step used to sit
  // there unfilled until he clicked the toolbar again. The watcher is what
  // makes one click enough: when the page becomes a different step, it runs
  // the walk again.
  //
  // Bounded three ways, because a page that never stops changing must not
  // become a filler that never stops filling: a floor between runs, a ceiling
  // on runs per document, and a run only when the step signature — heading
  // plus the set of fields — actually differs from where the last run ended.

  const state = {
    running: null, pending: false, watching: false, lastSig: '', lastRunAt: 0, autoRuns: 0,
    followedApply: false, pressedSso: false, handled: new Set(), lastUserInputAt: 0,
  };
  // A step by its address and heading, without the count of controls: a
  // SmartRecruiters step draws its saved entries again when he comes Back to
  // it (12 description boxes for 4 jobs, 2026-09-24), so the full signature
  // no longer matches and the step read as new. Markers (gate, wall) stay.
  //
  // …BUT TWO STEPS UNDER ONE HEADING ARE STILL TWO STEPS (F-573). Wayve's
  // firststage flow shows "Upload CV" and then its questions on the same path
  // under the same heading; without the count they were one step, and the
  // questions read as "already filled" after only the CV had gone in. What is
  // ASKED tells them apart — the distinct kinds of question, not how many
  // copies of each — so a step redrawn with more boxes still matches itself.
  const shapeOf = () => {
    try {
      const kinds = [...new Set(discover().map((f) => `${f.type}:${String(f.label || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()}`))].sort().join('|');
      let h = 0;
      for (let i = 0; i < kinds.length; i += 1) h = (h * 31 + kinds.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    } catch { return '*'; }
  };
  // The exact fingerprint (::f…) goes too: it changes with every extra box
  // and with names a site randomises per load (Rippling).
  const coarse = (sig) => `${location.pathname}##${String(sig || '').replace(/::f[0-9a-z]+(?=(::|$))/, '').replace(/::\d+(?=(::|$))/, `::${shapeOf()}`)}`;
  // KEPT ACROSS PAGE LOADS IN THIS TAB. SmartRecruiters loads a new document
  // for each step, so a memory held in this script died with the step: Back
  // arrived in a fresh document that had "handled" nothing, and the watcher
  // filled step one again and pressed Next (Western Digital, live 2026-09-24).
  // sessionStorage is this tab and this site only, and ends with the tab.
  const HANDLED_KEY = '__jarvis_handled_steps';
  const handledCoarse = (() => {
    const set = new Set();
    try { for (const k of JSON.parse(sessionStorage.getItem(HANDLED_KEY) || '[]')) set.add(k); } catch { /* storage refused: this document only */ }
    const add = set.add.bind(set);
    set.add = (k) => { add(k); try { sessionStorage.setItem(HANDLED_KEY, JSON.stringify([...set].slice(-60))); } catch { /* full or refused */ } return set; };
    const clear = set.clear.bind(set);
    set.clear = () => { clear(); try { sessionStorage.removeItem(HANDLED_KEY); } catch { /* ignore */ } };
    return set;
  })();
  const MIN_GAP_MS = 3000;
  const MAX_AUTO_RUNS = 25;
  /** How long after he last typed or clicked before a follow-along run may start. */
  const USER_QUIET_MS = 4000;

  // WHEN HE IS USING THE PAGE, THE PAGE IS HIS. A follow-along run that
  // opens a dropdown while he has one open, or presses Save and Continue
  // while he is halfway through a sentence, is worse than no run. Trusted
  // events only: the filler's own synthetic clicks must not count as his.
  for (const type of ['keydown', 'pointerdown', 'input']) {
    document.addEventListener(type, (e) => { if (e.isTrusted) state.lastUserInputAt = Date.now(); }, true);
  }

  /**
   * One run at a time, and EVERY run reports.
   *
   * The worker cannot wait for a run to end: a run can outlast the five
   * minutes Chrome gives a service worker for one event (the resume wait
   * alone is up to four), and a run the watcher started is one the worker
   * never saw begin. So the run tells the worker what it did, whoever started
   * it, and the worker records and shows it from there — one path for both.
   */
  function runOnce(opts) {
    if (state.running) { state.pending = true; return state.running; }
    state.running = (async () => {
      let result;
      // Where this run began, so the worker can tell a walk started over
      // from one that carries on (F-361).
      const startedOn = location.href;
      try { result = await run(opts); } finally {
        state.lastSig = stepSignature();
        state.handled.add(state.lastSig);
        // Only the EXACT page it ended on: the step a run merely arrived at
        // (Wayve's questions, painted after the CV went in) is not a step it
        // filled. Every step the walk did fill was recorded as it went (F-573).
        state.lastRunAt = Date.now();
        state.running = null;
        chip('');   // whatever the run said while it worked, it is done saying it
      }
      await send({ type: 'filled', result: { ...result, pageUrl: location.href, startedOn } }).catch(() => null);
      return result;
    })();
    return state.running;
  }

  /** A run the watcher started. */
  async function autoRun(why) {
    if (state.autoRuns >= MAX_AUTO_RUNS) {
      console.warn(`[jarvis] ${MAX_AUTO_RUNS} follow-along runs on this page — standing down. Click the toolbar button to start again.`);
      showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, armed: false,
        stoppedBecause: `stopped following this page after ${MAX_AUTO_RUNS} runs — click the toolbar button to start again` });
      stopWatching();
      await send({ type: 'runaway', pageUrl: location.href }).catch(() => null);
      return null;
    }
    state.autoRuns += 1;
    console.log(`[jarvis] ${why} — filling`);
    return runOnce({ auto: true });
  }

  let observer = null;
  let poll = null;
  let debounce = null;

  function stopWatching() {
    state.watching = false;
    observer?.disconnect(); observer = null;
    clearInterval(poll); poll = null;
    clearTimeout(debounce); debounce = null;
  }

  function check() {
    if (!state.watching || state.running) return;
    if (Date.now() - state.lastRunAt < MIN_GAP_MS) return;
    if (Date.now() - state.lastUserInputAt < USER_QUIET_MS) return;
    const sig = stepSignature();
    // Only a step this document has not seen. A→B→A — a dropdown opening and
    // closing, a validation banner appearing and going — fires nothing.
    if (sig === state.lastSig || state.handled.has(sig) || handledCoarse.has(coarse(sig))) return;
    // Let the step finish painting before reading it — a half-rendered step
    // has half its fields, and the other half would be "revealed" later.
    settle().then(() => {
      if (!state.watching || state.running) return;
      if (Date.now() - state.lastUserInputAt < USER_QUIET_MS) return;
      const now = stepSignature();
      if (now === state.lastSig || state.handled.has(now) || handledCoarse.has(coarse(now))) return;
      // A submitted application ends the following, whatever else the page
      // shows; the worker learns it from the run's result.
      autoRun('the page moved to a new step');
    });
  }

  function watch() {
    if (state.watching || !RUN.armed) return;
    state.watching = true;
    state.lastSig = stepSignature();
    try {
      observer = new MutationObserver(() => { clearTimeout(debounce); debounce = setTimeout(check, 700); });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
    } catch { /* a document that forbids observation still gets the poll */ }
    // Belt and braces: a framework that swaps a step in one big replaceChildren
    // still fires the observer, but a step that arrives via a re-attached root
    // outside <html> — seen once — does not. Two seconds is invisible to him.
    poll = setInterval(check, 2000);
  }

  /**
   * The second and later injections into this document land here.
   *
   * A NEW ARMING replaces the old context (he clicked again after the watcher
   * stood down); a disarm stops the watcher; anything else is "run again",
   * which the run lock turns into "after the current run, if any".
   */
  function again(ctx) {
    Object.assign(RUN, ctx || {});
    if (!RUN.armed) { stopWatching(); }
    if (ctx && ctx.reset) { state.autoRuns = 0; state.handled.clear(); handledCoarse.clear(); }
    // A RE-INJECTION NOBODY CLICKED FOR, ON A PAGE THAT HAS NOT CHANGED, IS
    // NOISE. The worker follows every frame load in the tab — a chat widget
    // or an analytics iframe reloading arrives here as "run again". If the
    // step is the one the last run ended on, there is nothing to run.
    if (RUN.auto && !state.running && stepSignature() === state.lastSig) {
      return Promise.resolve({ frame: location.href, filled: 0, checked: 0, uploaded: false, unchanged: true, auto: true, stoppedBecause: 'nothing changed on this page' });
    }
    const p = runOnce({ auto: !!RUN.auto });
    p.finally(() => { if (RUN.armed) watch(); });
    return p;
  }

  // `chip` is on here for the overlap check in fill.test.mjs: the rule it
  // enforces (progress never covers the panel) is only observable by asking
  // for a progress line while a panel is up, which no fixture can otherwise do.
  globalThis.__jarvisContent = { again, run: runOnce, watch, stopWatching, stopFollowing, state, chip, RUN, loadId: RUN.loadId };

  const first = runOnce({ auto: !!RUN.auto });
  first.finally(() => { if (RUN.armed) watch(); });
  return first;
})();
