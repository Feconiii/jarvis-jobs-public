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
    discover: discoverRaw, setNativeValue, enterText, SUBMIT_RE, nextControl, stepSignature, expandSections, openResumeUpload, resumeOpenerSaw, otpBoxes, codeConfirmControl, oracleEmailNext, sessionStayControl, settle, startGate, signInWall, signInWallKind, applyControl, atsMoved,
    advanceBlockedBy, comboValue, postingGone, pageBlocked, readPosting, applicationDone, alreadyApplied, looksLikeApplication, ssoControl, waitForSomething, dismissCookieBanner, experienceSections, ENTRY_IDS, ENTRY_PRIMARY, deepQuerySelectorAll, labelFor, allControls, onScreen, headingAbove, buttonName, wouldSubmit,
    errorsOnPage, consentGate, unseenControls, isStandingNotice, his,
  } = globalThis.__jarvis || {};
  // Reading the page, counted on every call (S6). SPENT is defined below; this only runs later.
  const discover = (...args) => { const t = Date.now(); try { return discoverRaw(...args); } finally { try { SPENT.discover += Date.now() - t; } catch { /* before the counters exist */ } } };
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
  // NEVER THE SITE'S OWN HEADER (F-1012, 2026-11-05): Tesla's first <h1> is its
  // logo link, "Careers" and the skip link, and "Tesla homepageCareersSkip to
  // main content" went to the server as the job. An <h1> in the site's banner or
  // navigation, or one that reads as navigation, is passed over.
  const HEADING_CHROME_RE = /skip (?:to|navigation)\b|^(?:main|site|primary) (?:menu|navigation)$|^toggle (?:navigation|menu)$/i;
  const headingText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const siteChrome = (el) => !!el.closest('nav, [role="navigation"], [role="banner"]')
    || (!!el.closest('header') && !el.closest('main, article, [role="main"]'));
  const pageHeading = () => {
    const h1 = [...document.querySelectorAll('h1')].find((el) => headingText(el) && !siteChrome(el) && !HEADING_CHROME_RE.test(headingText(el)));
    return headingText(h1 || document.querySelector('h2.applying-for-title, h2')).slice(0, 200);
  };
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
  //
  // WHICH WAIT IT WAS (S5, 2026-11-12). S6 showed the fixed waits are 55% of
  // his runs (73% with the tab hidden, 34% on screen) but not which of the ~90
  // they were, and a wait cut blind is how a fill breaks. Each pause is charged
  // to the line of content.js that asked for it: as long as it lasted, how long
  // it asked for, how often, and how much of it the tab was hidden. Line
  // numbers and ms only; the version travels with them so a line can be read
  // back from git.
  const waitSite = () => {
    try {
      // Every frame with a position (content.js when injected as a file, the
      // inline script in the tests); pause is only ever called from this file.
      const frames = String(new Error().stack || '').split('\n').filter((f) => /:\d+:\d+\)?\s*$/.test(f));
      const m = (frames[2] || '').match(/:(\d+):\d+\)?\s*$/);   // [0] waitSite, [1] pause, [2] whoever asked
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  };
  const pause = (ms) => { const site = waitSite(); return new Promise((r) => {
    let done = false;
    const began = Date.now();
    const hiddenAtStart = document.visibilityState === 'hidden';
    const finish = () => {
      if (done) return;
      done = true;
      try {
        const spent = Date.now() - began;
        SPENT.waits += spent;
        const s = SPENT.sites[site] || (SPENT.sites[site] = [0, 0, 0, 0]);
        s[0] += spent; s[1] += Math.max(0, Number(ms) || 0); s[2] += 1; if (hiddenAtStart) s[3] += spent;
      } catch { /* before the counters exist */ }
      r();
    };
    if (document.visibilityState === 'hidden' && ms > 0) {
      try {
        chrome.runtime.sendMessage({ type: 'sleep', ms }, () => { void chrome.runtime.lastError; finish(); });
      } catch { /* the extension was reloaded under this page: the timer below still ends it */ }
    }
    let port;
    try { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); finish(); }; port = ch.port2; } catch { /* no ports here */ }
    setTimeout(() => (port ? port.postMessage(0) : finish()), ms);
  }); };

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
   *
   * S6 (2026-11-07): every phase, so the slowest step is measured on his
   * machine before any wait is cut. discover = reading the page; plan = waiting
   * for the dashboard's answer; waits = the fixed pauses, as long as they
   * lasted (they overlap the buckets they sit in). Phase names and ms only:
   * nothing of the page or his answers goes in.
   */
  const SPENT = { answers: 0, resume: 0, prompts: 0, entries: 0, discover: 0, plan: 0, waits: 0, sites: {}, began: Date.now() };
  const timed = async (bucket, fn) => {
    const t = Date.now();
    try { return await fn(); } finally { SPENT[bucket] += Date.now() - t; }
  };
  /** This run's phases in whole ms, and which one was longest (S6). Names and numbers only. */
  const runTimings = () => {
    const t = { total: Date.now() - SPENT.began, discover: SPENT.discover, plan: SPENT.plan, answers: SPENT.answers, resume: SPENT.resume, dropdowns: SPENT.prompts, entries: SPENT.entries, waits: SPENT.waits };
    for (const k of Object.keys(t)) t[k] = Math.max(0, Math.round(t[k]));
    const phases = ['discover', 'plan', 'answers', 'resume', 'dropdowns', 'entries', 'waits'];
    t.slowest = phases.reduce((a, b) => (t[b] > t[a] ? b : a), phases[0]);
    t.hidden = document.visibilityState === 'hidden';
    // S5: the twelve waits that took longest, [line, ms spent, ms asked, times, ms spent hidden].
    t.waitSites = Object.entries(SPENT.sites).filter(([line]) => Number(line) > 0)
      .map(([line, s]) => [Number(line), ...s.map((x) => Math.round(x))])
      .sort((a, b) => b[1] - a[1]).slice(0, 12);
    try { t.v = chrome.runtime.getManifest().version; } catch { /* reloaded under the page */ }
    return t;
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
  // Whether this run began on an armed tab: such a run stops once he disarms it (F-990).
  RUN.startedArmed = !!RUN.armed;

  /*
   * ONE RUN TYPES ON A PAGE (F-994 review). When the worker takes over a run
   * that looked stalled, the old script is still in the page. Each run carries
   * the worker's token and claims the page with it; a run whose token is no
   * longer the page's stops at its next step. And a run says it is alive —
   * every status, every step, from any frame, at most every ten seconds — so
   * a slow run (a two-minute resume build, a form in an iframe) is never
   * mistaken for a stalled one.
   */
  if (RUN.runToken) globalThis.__jarvisActiveRun = RUN.runToken;
  function superseded() {
    return !!(RUN.runToken && globalThis.__jarvisActiveRun && globalThis.__jarvisActiveRun !== RUN.runToken);
  }
  let aliveSentAt = 0;
  function heartbeat() {
    try {
      if (!RUN.runToken || Date.now() - aliveSentAt < 10_000 || !chrome?.runtime?.id) return;
      aliveSentAt = Date.now();
      send({ type: 'run-alive' }).catch(() => null);
    } catch { /* never in the way */ }
  }

  /**
   * HE DISARMED THE TAB MID-RUN (F-990, Re:Build 2026-11-04): he removed the
   * optional cover letter and disarmed, and the run still in flight put it
   * back seconds later. A run that began armed asks before each step — the
   * page's own flag (his stop on the page), then the worker (the panel's
   * disarm), at most once a second — and stops when the answer is no.
   */
  let armedAskedAt = 0;
  let armedAnswer = true;
  async function disarmedMidRun() {
    if (!RUN.startedArmed) return false;
    if (!RUN.armed) return true;
    if (Date.now() - armedAskedAt < 1000) return !armedAnswer;
    armedAskedAt = Date.now();
    const r = await send({ type: 'still-armed' }).catch(() => null);
    // No answer (an older worker, a test page): carry on as before.
    armedAnswer = r && typeof r.armed === 'boolean' ? r.armed : true;
    return !armedAnswer;
  }

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
      // ANY Submit press, his or a tool's (F-1002, 2026-11-04): Medra and
      // Etched (Ashby) were submitted from another window and never marked
      // applied. Jarvis never presses Submit itself, and this only reads.
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
  const DONE_MISS_SENT = new Set();
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
      // A confirmation-shaped URL refused for want of the page's word (R3):
      // recorded once per path — the path and the reason, no page text.
      const miss = globalThis.__jarvisDoneMiss;
      if (miss?.path && !DONE_MISS_SENT.has(miss.path)) {
        DONE_MISS_SENT.add(miss.path);
        try { send({ type: 'capture', pageUrl: location.origin + miss.path, why: `R3: not counted as sent — ${miss.why}`, label: '', html: '' }); } catch { /* a record, never the form */ }
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
        if (r.repaired.length) chip(`Jarvis re-entered ${r.repaired.length} field${r.repaired.length > 1 ? 's' : ''} the form had lost — press ${name || 'Save and Continue'} again`, { summary: true });
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
    // …and a form sent without a click on its button: Enter in the last box (F-1002).
    document.addEventListener('submit', () => { try { watchForSent(); } catch { /* never in the way */ } }, true);
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
      lastPress = { trigger, at: Date.now() };
      setTimeout(() => reportPageErrors(trigger), 1500);
      setTimeout(() => reportPageErrors(trigger), 4000);
      watchErrors();
    } catch { /* never in the way of his press */ }
  }
  let errorObserver = null;
  // A message drawn within a few seconds of a press is the press's answer,
  // whichever reader sees it first: the change watcher's timer can beat the
  // 1.5 s read when the page was quiet before the press.
  let lastPress = { trigger: '', at: 0 };
  const changeTrigger = () => (lastPress.trigger && Date.now() - lastPress.at < 4000 ? lastPress.trigger : 'appeared on the page');
  function watchErrors() {
    if (errorObserver || typeof MutationObserver !== 'function' || !document.body) return;
    let timer = null;
    let lastRun = 0;
    errorObserver = new MutationObserver(() => {
      if (timer) return;
      // Trailing, at most every 3 s: a React form re-renders on each keystroke.
      const wait = Math.max(1200, 3000 - (Date.now() - lastRun));
      timer = setTimeout(() => { timer = null; lastRun = Date.now(); reportPageErrors(changeTrigger()); }, wait);
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
      heading: pageHeading(),
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
    heartbeat();   // every status this run shows says it is alive, from any frame (F-994 review)
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
      captureNode(box, why, label);
    } catch { /* a record, never the form */ }
  }
  /** One element's markup, scrubbed as captureAround scrubs it: no values, scripts, styles, images or hidden contents; 24 KB at most. */
  function captureNode(box, why, label = '') {
    try {
      const copy = box.cloneNode(true);
      copy.querySelectorAll('script, style, noscript, svg, img, iframe').forEach((x) => x.remove());
      copy.querySelectorAll('input, textarea').forEach((x) => { x.removeAttribute('value'); if (x.tagName === 'TEXTAREA') x.textContent = ''; });
      copy.querySelectorAll('[value]').forEach((x) => { if (x.tagName !== 'OPTION') x.removeAttribute('value'); });
      const html = copy.outerHTML.replace(/\s+/g, ' ').slice(0, 24000);
      send({ type: 'capture', pageUrl: location.href, why, label: String(label).slice(0, 200), html });
    } catch { /* a record, never the form */ }
  }

  /**
   * ORACLE'S EXPERIENCE ENTRIES, BEFORE AND AFTER THE RESUME PARSE (R5 step 1,
   * 2026-11-07). Oracle parses the uploaded resume and adds each job it reads
   * as a new UNDATED entry beside his dated one (F-942). Removing those needs
   * the real markup of a tile and its controls, which no capture holds yet, so
   * this only RECORDS it: the smallest container holding a section's Add
   * (data-qa="add<N>") and all its tiles (article[data-qa="profileItem<N>"]),
   * scrubbed like every capture, sent once per page and moment to the same
   * local captures file. Nothing is changed on the form.
   */
  /**
   * AN ORACLE LIST BOX THE MENU COULD NOT ANSWER (P2, 2026-11-07). Only for an
   * empty box inside Oracle's cx-select, only after the menu path found
   * nothing: the worker reads the box's whole option list through its React
   * props, picks his answer with the server's matcher and sets it through the
   * box's own setter (oracle-select.js). The box is then READ BACK, and only a
   * box showing that option counts. Each use is logged — the field's label and
   * whether it held, never a value — so his next real Oracle fill shows
   * whether it works.
   */
  // Never through this path, whatever the planner says (review: belt and braces):
  // self-identification, pay, references, citizenship, work authorization and
  // the other protected questions (widened, second review).
  const ORACLE_DIRECT_NEVER = /\b(gender|sex|race|racial|ethnic|ethnicity|hispanic|latino|latinx|veteran|disab|orientation|pronoun|transgender|salary|pay|compensation|wage|reference|citizen|citizenship|nationality|visa|sponsor|authori[sz]|work (permit|auth)|religio|marital|criminal|convict|military|minority|lgbt|birth|legally|eligib|right to work|immigra|green ?card|permanent resident|foreign national|export|itar|u\.? ?s\.? person|clearance|restricted|controlled)|\b(rate|age)\b|\bf-?1\b/i;
  // Work authorization and export words that are also ordinary words in
  // lower case: only the capitalised acronym, whole word ("OPT", "EAR"), so
  // "opt in", "year" and "early" stay out of it (P2 third review).
  const ORACLE_DIRECT_NEVER_CASED = /\b(OPT|EAR|CPT)\b/;
  const oracleDirectNever = (label) => ORACLE_DIRECT_NEVER.test(label) || ORACLE_DIRECT_NEVER_CASED.test(label);
  // …nor a generic label ("Select one") inside a self-identification section,
  const ORACLE_DIRECT_SECTION_NEVER = /self[- ]?identif|voluntary|equal (employment )?opportunit|\beeo|diversity|demographic|affirmative action|ofccp|veteran|disab|gender|\brace\b|ethnic/i;
  // …or inside a work-authorization, export or legal section (P2 third review).
  const ORACLE_DIRECT_SECTION_LEGAL = /work authori[sz]|employment eligib|eligib(le|ility) to work|right to work|immigra|sponsor|visa|export|\bitar\b|\blegal/i;
  // A stuck pick or set leaves the box as it is rather than holding the fill.
  const P2_LIMIT_MS = () => Number(globalThis.__jarvisP2LimitMs) || 45000;
  const within = (p, ms) => {
    let t;
    return Promise.race([p, new Promise((res) => { t = setTimeout(() => res({ ok: false, why: `no answer within ${Math.round(ms / 1000)} s`, late: true }), ms); })])
      .finally(() => clearTimeout(t));
  };
  function oracleSectionWords(el) {
    const parts = [];
    try { if (headingAbove) parts.push(headingAbove(el)); } catch { /* fall through */ }
    try { parts.push(el.closest('fieldset')?.querySelector('legend')?.textContent || ''); } catch { /* fall through */ }
    try {
      const g = el.closest('[role="group"], [role="region"], section');
      if (g) {
        parts.push(g.getAttribute('aria-label') || '');
        for (const id of String(g.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent || '');
      }
    } catch { /* fall through */ }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  async function oracleDirect(a, f, wanted, label, boxBefore = '') {
    if (a?.action !== 'prompt') return false;
    if (oracleDirectNever(String(label || ''))) return false;
    const el = f?.elements?.[0];
    if (!el || !el.id || typeof el.closest !== 'function' || !el.closest('.cx-select-container')) return false;
    if (!Array.isArray(wanted) || !wanted.length) return false;
    const sectionWords = oracleSectionWords(el);
    if (ORACLE_DIRECT_SECTION_NEVER.test(sectionWords) || ORACLE_DIRECT_SECTION_LEGAL.test(sectionWords)) return false;
    // HIS PICK IS NEVER REPLACED (review): the box must be as the menu attempts
    // left it — empty, as it was before them, or holding only the filter text
    // they typed (and only while it is not focused: a focused box holding it may
    // be his typing) — and not touched by him. Asked now, again before the set,
    // and once more IN THE PAGE right before the setter (oracleSelectSet's guard).
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const wants = wanted.slice(0, 3).map((w) => String(w ?? ''));
    const untouched = () => {
      if (his && (his.touched(f) || his.touched(el))) return false;
      if (el.hasAttribute?.('data-jarvis-his')) return false;
      const v = norm(el.value);
      return !v || v === norm(boxBefore) || (document.activeElement !== el && wants.some((w) => norm(w) && v === norm(w)));
    };
    if (!untouched()) return false;
    // His own keys and clicks on the box while the worker is busy mark it for
    // the page's last look (the DOM is shared; his events reach this listener
    // before the page's setter can run).
    const container = el.closest('.cx-select-container');
    const markHis = (e) => { if (e.isTrusted) { try { el.setAttribute('data-jarvis-his', '1'); } catch { /* fall through */ } } };
    const HIS_EVENTS = ['keydown', 'input', 'pointerdown', 'mousedown', 'paste', 'drop', 'cut'];
    for (const t of HIS_EVENTS) { el.addEventListener(t, markHis, true); container?.addEventListener(t, markHis, true); }
    // 'kept' (the box shows his answer), 'unconfirmed' (the setter was asked
    // and may have run, but the box does not show it: his to check), or ''.
    let result = '';
    let outcome;
    try {
      const r = await within(send({ type: 'oracle-pick', inputId: el.id, wants }).catch(() => null), P2_LIMIT_MS());
      if (!r?.ok || !Number.isInteger(r.index) || !r.label) outcome = `not set (${String(r?.why || 'no answer').slice(0, 60)})`;
      else if (!untouched()) outcome = 'not set (the box changed while its list was read: left as it is)';
      else {
        const s = await within(send({ type: 'oracle-set', inputId: el.id, index: r.index, label: r.label, before: String(boxBefore || ''), wanted: wants }).catch(() => null), P2_LIMIT_MS());
        // A set that did not answer in time may still have run in the page.
        if (!s?.ok && !s?.late) outcome = `not set (${String(s?.why || 'no answer').slice(0, 60)})`;
        else {
          await pause(400);
          const shown = norm(el.value);
          result = shown && kept_same(shown, r.label) ? 'kept' : 'unconfirmed';
          outcome = result === 'kept' ? 'kept' : `set, but not confirmed${s?.late ? ` (${s.why})` : ''}; check this field`;
        }
      }
    } finally {
      for (const t of HIS_EVENTS) { el.removeEventListener(t, markHis, true); container?.removeEventListener(t, markHis, true); }
    }
    try { send({ type: 'capture', pageUrl: location.href, why: `P2: Oracle list set through its own props — ${outcome}`, label: String(label || '').slice(0, 200), html: '' }); } catch { /* a record, never the form */ }
    return result;
  }

  const ORACLE_ENTRY_SECTION = /experience|employment|work history/i;
  const ORACLE_CAPTURED = new Set();
  function captureOracleEntries(moment) {
    try {
      if (!/(^|\.)oraclecloud\.com$/i.test(location.hostname)) return 0;
      let sent = 0;
      for (const add of document.querySelectorAll('[data-qa^="add"]')) {
        const qa = add.getAttribute('data-qa') || '';
        if (!/^add\d+$/.test(qa)) continue;
        const label = (add.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!ORACLE_ENTRY_SECTION.test(label)) continue;
        const tiles = [...document.querySelectorAll(`article[data-qa="profileItem${qa.slice(3)}"]`)];
        let box = add.parentElement;
        for (let d = 0; box && d < 10 && !tiles.every((t) => box.contains(t)); d += 1) box = box.parentElement;
        if (!box || box === document.body || !tiles.every((t) => box.contains(t))) continue;
        const key = `${location.pathname}|${moment}|${qa}`;
        if (ORACLE_CAPTURED.has(key)) continue;
        ORACLE_CAPTURED.add(key);
        captureNode(box, `R5: Oracle entries ${moment} (${tiles.length} shown)`, label);
        sent += 1;
      }
      return sent;
    } catch { return 0; }   // a record, never the form
  }

  /**
   * DOES THIS SLOT ALREADY SHOW A FILE? (F-911) Oracle empties its file input
   * after every upload and lists the file as a chip beside it, so `files` read
   * empty on each follow-along run and Oceaneering's optional box collected
   * seven copies of the resume. The slot is the input's ancestors up to, not
   * including, the first one that holds another file input — never the page.
   */
  function slotShowsFile(input, { resume = false } = {}) {
    try {
      let slot = input;
      for (let p = input.parentElement, i = 0; p && p !== document.body && i < 6; p = p.parentElement, i += 1) {
        if ([...p.querySelectorAll('input[type="file"]')].some((f) => f !== input)) break;
        slot = p;
      }
      if (slot === input) return false;
      const words = `${slot.innerText || ''}\n${[...slot.querySelectorAll('[aria-label],[title]')].map((n) => `${n.getAttribute('aria-label') || ''} ${n.getAttribute('title') || ''}`).join('\n')}`;
      const FILE_RE = /[^\s/\\]\.(pdf|docx?|rtf|odt)\b/i;
      if (!resume) return FILE_RE.test(words);
      // FOR THE RESUME, ANOTHER OF HIS FILES IS NOT IT (F-1013 #7). A slot with
      // no other file input climbs to the whole form, so the cover letter's or
      // portfolio's chip beside it read as "the resume is in", and an emptied
      // resume slot was never attached again.
      return words.split('\n').some((line) => FILE_RE.test(line) && !NOT_RESUME_FILE_RE.test(line));
    } catch { return false; }
  }

  /**
   * A FILE FROM AN EARLIER APPLICATION IS NOT THIS POSTING'S (F-913). Oracle
   * and other account-based forms put the resume and letter from his last
   * application at the same employer back into the slots — onsemi's held
   * "AlexRiveraResume.pdf" and the Scottsdale cover letter — and F-413's "keep what
   * is there" kept them. Once per tab, before anything is attached, a file chip
   * in a resume / letter / documents slot whose name is not one Jarvis gives
   * (they all start with his name and a space) is removed with the slot's own
   * Remove button, so the tailored pair goes on. After that first pass a file
   * in a slot is his and stays (F-413).
   */
  const SLOT_WORDS_RE = /\b(resume|résumé|cv|curriculum|cover\s*letter|supporting\s+documents?|attachments?|documents?)\b/i;
  const REMOVE_RE = /^\s*(remove|delete|clear|discard)\b|\b(remove|delete)\s+(file|attachment|document)\b/i;
  // After the file's role, a word that makes it ANOTHER posting: a level, a
  // program, or another kind of role (F-1013 review). Anything else (a place,
  // a requisition) leaves it the same role.
  const OTHER_ROLE_RE = /^(i{1,3}|iv|v|[1-5]|\d{4}|level|grade|senior|sr|junior|jr|lead|staff|principal|intern|internship|co op|coop|apprentice|trainee|resident|fellow|graduate|grad|new grad|university|campus|early career|entry|manager|supervisor|technician|specialist|associate)\b/;
  function earlierFileChips() {
    const ours = new RegExp(`^${PERSON_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'i');
    const found = [];
    for (const btn of document.querySelectorAll('button, [role="button"], a')) {
      const name = String(btn.getAttribute('aria-label') || btn.textContent || '').trim();
      const fileName = name.match(/^(?:(?:remove|delete)\s+(?:file\s+)?)?(\S[^\n]{0,150}?\.(?:pdf|docx?|rtf|odt))$/i)?.[1];
      if (!fileName) continue;
      // A Jarvis file names its posting ("Alex Rivera - Coherent Corp - Process
      // Engineer - DMG….pdf"). One naming ANOTHER posting at this employer is
      // from the earlier application too (F-916, Coherent 2026-10-25). Kept
      // when the page names no title to compare with.
      if (ours.test(fileName)) {
        const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        // "<his name> - <employer> - <role>[ - cover letter].pdf", split on " - "
        // (F-1013 #14): a hyphen INSIDE the employer ("Rolls-Royce") broke the
        // old pattern, and an unparsed name was kept whatever posting it named.
        const parts = fileName.replace(/\.[a-z]+$/i, '').replace(/\s+-\s+cover letter$/i, '').split(/\s+-\s+/);
        const role = parts.length >= 3 ? flat(parts.slice(2).join(' ')) : '';
        const head = flat(typeof pageHeading === 'function' ? pageHeading() : '');
        // THE SAME ROLE, not a role that merely CONTAINS the old one: "Process
        // Engineer" was kept on a "Process Engineer II" posting (F-1013 #14).
        // A long role may have been cut to fit the name (SHORT_FILE_NAME_MAX), so
        // only a role of 24+ characters may match the start of the heading.
        // The page's title before its " - Employer Careers" tail.
        const title = flat(String(document.title || '').split(/\s[-–—|]\s/)[0]);
        // A heading may add a place or a requisition ("Process Engineer - Boise,
        // ID", "Process Engineer (R-1234)"): still the same role (review of
        // F-1013, 2026-11-05). A level or another kind of role after it is not.
        const sameAs = (t) => t === role || (role.length >= 24 && t.startsWith(role))
          || (t.startsWith(`${role} `) && !OTHER_ROLE_RE.test(t.slice(role.length + 1)));
        let keep;
        if (!role) keep = true;                        // his fixed name, or one he chose: his
        else if (head) keep = sameAs(head) || (!!title && sameAs(title));
        else if (title) keep = sameAs(title);
        else keep = true;                              // the page names no title to compare with
        if (keep) continue;
      }
      // The slot: the nearest ancestor holding a Remove control, which must sit
      // in a part of the page that talks about resumes or documents.
      let remove = REMOVE_RE.test(name) ? btn : null;
      let box = btn.parentElement;
      for (let i = 0; box && box !== document.body && i < 4 && !remove; i += 1, box = box.parentElement) {
        remove = [...box.querySelectorAll('button, [role="button"], a')].find((b) => b !== btn
          && REMOVE_RE.test(`${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.textContent || ''}`.trim()));
      }
      if (!remove) continue;
      // Coherent's Oracle (F-916): the section title is a bare span, and a full
      // slot has no file input left — but the control says "Remove Resume" and
      // sits in <resume-upload-button> / .file-upload-wrapper.
      const says = `${remove.getAttribute('aria-label') || ''} ${remove.textContent || ''}`;
      // Micron (Eightfold, F-923): the x is "Delete file Alex Rivera - Micron….pdf"
      // — his way too: "press x to delete the resume then put in new one".
      let slotish = SLOT_WORDS_RE.test(says.replace(/^\s*(remove|delete|clear|discard)\b/i, ''))
        || /\b(remove|delete)\s+(file|attachment|document)\b/i.test(says);
      for (let p = btn, i = 0; p && p !== document.body && i < 8 && !slotish; i += 1, p = p.parentElement) {
        if (/upload|attachment|resume/i.test(`${p.tagName} ${typeof p.className === 'string' ? p.className : ''}`)) slotish = true;
      }
      if (slotish) { if (!found.some((f) => f.remove === remove)) found.push({ fileName, remove, jarvis: ours.test(fileName) }); continue; }
      let region = box;
      for (let i = 0; region && region !== document.body && i < 6; i += 1, region = region.parentElement) {
        if (region.querySelector('input[type="file"]') || SLOT_WORDS_RE.test(region.getAttribute('aria-label') || '')
          || [...region.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,label,[role="heading"]')].some((h) => SLOT_WORDS_RE.test(h.textContent || ''))) break;
      }
      if (!region || region === document.body) continue;
      if (!found.some((f) => f.remove === remove)) found.push({ fileName, remove, jarvis: ours.test(fileName) });
    }
    return found;
  }
  /**
   * A JARVIS FILE FOR ANOTHER POSTING, FOUND LATE (F-942, Cummins on Oracle
   * 2026-10-29). The earlier-files pass runs once per tab, and after it a file
   * in a slot is his (F-413). Oracle can draw his saved profile files after
   * that look, so "Alex Rivera - Cummins Inc. - Design Engineer.pdf" sat in the
   * Product Engineer form's slot and the report said "uploaded". Before an
   * upload is skipped for a slot that shows a file, a file Jarvis named for a
   * DIFFERENT posting is removed. A file he chose himself (any other name) and
   * this posting's own file are never touched.
   */
  async function clearOtherPostingFiles() {
    const removed = [];
    for (const { fileName, remove, jarvis } of earlierFileChips()) {
      if (!jarvis || !remove.isConnected) continue;
      remove.click();
      removed.push(fileName);
      await pause(600);
      const yes = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
        .find((b) => /^\s*(yes|remove|delete|ok|confirm)\b/i.test(b.textContent || ''));
      if (yes) { yes.click(); await pause(600); }
    }
    if (removed.length) console.log(`[jarvis] removed files Jarvis made for another posting: ${removed.join(', ')}`);
    return removed;
  }
  async function clearEarlierFiles() {
    try {
      if (sessionStorage.getItem('jv-earlier-files-checked')) return [];
    } catch { return []; }
    // Only a page with file slots counts as checked: Oracle's email screen
    // came first in the same tab and used the one look up (Coherent R&D
    // Prototype, 2026-10-25 — the R&D Engineer pair stayed).
    const chips = earlierFileChips();
    if (!chips.length && !document.querySelector('input[type="file"]')) return [];
    try { sessionStorage.setItem('jv-earlier-files-checked', '1'); } catch { /* checked this run only */ }
    const removed = [];
    for (const { fileName, remove } of chips) {
      if (!remove.isConnected) continue;
      remove.click();
      removed.push(fileName);
      await pause(600);
      // A confirm step ("Are you sure?") inside the page, never a browser dialog.
      const yes = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
        .find((b) => /^\s*(yes|remove|delete|ok|confirm)\b/i.test(b.textContent || ''));
      if (yes) { yes.click(); await pause(600); }
    }
    return removed;
  }

  /**
   * The same resume under a name a fussy uploader takes (Phenom: under 60
   * characters). Company legal suffixes go first; then the company itself,
   * since the site is the company's; then the role is cut at a word.
   */
  const SHORT_FILE_NAME_MAX = 55;
  function shortFileName(name) {
    const ext = (String(name).match(/\.[a-z0-9]{2,5}$/i) || ['.pdf'])[0];
    const parts = String(name).slice(0, -ext.length).split(/\s+-\s+/);
    const person = parts[0] || PERSON_NAME;
    const company = String(parts[1] || '').replace(/,?\s+(inc\.?|incorporated|llc|l\.l\.c\.|corp\.?|corporation|company|co\.|ltd\.?|limited|plc|gmbh|holdings?)\b\.?/gi, '').replace(/[,.]+$/, '').trim();
    const role = parts.slice(2).join(' - ').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const fits = (s) => (s.length + ext.length <= SHORT_FILE_NAME_MAX ? s + ext : null);
    return fits([person, company, role].filter(Boolean).join(' - '))
      || fits([person, role].filter(Boolean).join(' - '))
      || fits(`${person} - ${role.slice(0, SHORT_FILE_NAME_MAX - ext.length - person.length - 3).replace(/\s+\S*$/, '')}`.replace(/\s+-\s*$/, ''))
      || `${PERSON_NAME} Resume${ext}`;
  }

  /** The same file slot, found again after the page redrew it: by id, then by name. */
  function slotAgain(old) {
    try {
      const esc = (s) => (globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
      if (old.id) { const byId = document.getElementById(old.id); if (byId && byId !== old && byId.type === 'file') return byId; }
      if (old.name) { const byName = document.querySelector(`input[type="file"][name="${esc(old.name)}"]`); if (byName && byName !== old) return byName; }
    } catch { /* fall through */ }
    return null;
  }

  /**
   * IS THE RESUME STILL IN ITS SLOT? (F-1009, Rippling, AtmosZero 2026-11-05)
   * The fill said uploaded, then Rippling's resume parser redrew the form and
   * the slot was empty. Looked at after the step, and after a parse: the slot
   * itself holds the file (its input, or a chip with a file name), or the page
   * still shows the name. Neither, and it is attached once more and looked at
   * again. Only when NEITHER shows: a second copy on a form that does hold the
   * file is the fault F-413 forbids. `attach: false` only looks.
   * @returns {Promise<{ kept: boolean, reattached: boolean }>}
   */
  async function keepResume(input, name, { attach = true } = {}) {
    const held = (s) => !!s && ((s.files?.length || 0) > 0 || slotShowsFile(s, { resume: true }));
    const slotNow = () => (input.isConnected ? input : slotAgain(input));
    let slot = slotNow();
    if (held(slot) || fileShowing(name)) return { kept: true, reattached: false };
    if (!slot || !attach) return { kept: false, reattached: false };
    console.log('[jarvis] the resume left its slot after it was attached (the page redrew) — attaching it again');
    const put = await attachResume(slot).catch(() => null);
    if (!put || put.ok === false) return { kept: false, reattached: true };
    for (let i = 0; i < 10; i += 1) {
      slot = slotNow();
      if (held(slot) || fileShowing(name)) return { kept: true, reattached: true };
      await pause(300);
    }
    return { kept: false, reattached: true };
  }
  const RESUME_DROPPED = 'Resume (attached, then the page dropped it — attach it yourself before you Submit)';

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
      if (superseded()) throw new Error('a newer run took over this page');
      if (!said) { said = true; console.log(`[jarvis] ${got.error} — waiting for it`); }
      const secs = Math.round((Date.now() - started) / 1000);
      chip(`${String(got.error || 'writing the resume').replace(/ — try again in a moment$/, '')} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — it attaches when ready`);
      await pause(5000);
      got = await send({ type: 'resume', pageUrl: location.href, heading: pageHeading(), pageTitle: document.title || '' });
    }
    chip('Jarvis is filling…');
    if (!got?.ok) throw new Error(got?.error || 'no resume from the server');
    // THE SLOT AFTER THE WAIT (F-989, Re:Build 2026-11-04). A press that
    // started the build waited for it, and Greenhouse's form had redrawn in
    // the meantime: the file went into an input no longer on the page —
    // "attached, but the page never showed the file" — and a second press,
    // with the build done, attached it. After any wait, the slot is found
    // again by its id or name.
    if (said && !input.isConnected) {
      const again = slotAgain(input);
      if (again) { input = again; console.log('[jarvis] the form redrew while the resume was written; attaching to the slot as it is now'); }
    }
    const bytes = new Uint8Array(got.bytes);
    // THE FILENAME AN ATS RECORDS IS THE ONE ON THIS FILE (F-409). It used to
    // be a fixed "Alex Rivera Resume.pdf" for every posting; he asked for his name,
    // the company and the role instead — "i want to have a signal thats what
    // you actually attached" — so the page shows him, in the chip the form
    // draws, exactly which resume went on. The server names it; this only
    // falls back if an older worker sent no name.
    const named = String(got.filename || '').trim();
    let file = new File([bytes], named || `${PERSON_NAME} Resume.pdf`, { type: 'application/pdf' });
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
      // A NAME TOO LONG FOR THE SITE (2026-10-26). Phenom (careers.honda.com)
      // silently drops any file whose name is 60 characters or more — no
      // error, no request — and "Alex Rivera - American Honda Motor Company, Inc.
      // - Manufacturing Engineer.pdf" is 74, so no Honda form ever got his
      // resume. Measured on the live page: 58 taken, 60 refused. Once, the
      // same PDF under a shorter name that still says which resume it is.
      if (!fileShowing(file.name) && file.name.length > SHORT_FILE_NAME_MAX) {
        const shortName = shortFileName(file.name);
        if (shortName !== file.name) {
          file = new File([bytes], shortName, { type: 'application/pdf' });
          const dt2 = new DataTransfer();
          dt2.items.add(file);
          try { input.value = ''; } catch { /* a box that will not be cleared */ }
          input.files = dt2.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          for (let i = 0; i < 20 && !fileShowing(file.name); i += 1) { agreeToUploadNotice(); await pause(400); }
          if (fileShowing(file.name)) console.log(`[jarvis] the site would not take the long file name; attached it as "${shortName}"`);
        }
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
    // …AND ONCE MORE, after a wait, if the slot is empty and no name shows
    // (F-989): what the second press did by hand, done by the first.
    if (said && !(input.files?.length) && !fileShowing(file.name)) {
      const slot = input.isConnected ? input : slotAgain(input);
      if (slot) {
        input = slot;
        const dt3 = new DataTransfer();
        dt3.items.add(file);
        input.files = dt3.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 10 && !fileShowing(file.name) && !(input.files?.length); i += 1) await pause(300);
      }
    }
    const shownNow = fileShowing(file.name);
    if (!((input.files?.length || 0) > 0 || shownNow) || (ownDrawn && !shownNow)) captureAround(input, 'resume upload did not show on the page');
    // PHENOM SAYS FOR CERTAIN (2026-10-26): its hidden #resumeName holds the
    // file's name once its server has it. Empty means refused, whatever the
    // input still holds — and an input left holding it read as "1 file
    // already attached" on every later pass, so Honda's slot was never tried
    // again while the report said "uploaded".
    const phenomName = input.closest?.('.resume-upload-wrapper') ? document.getElementById('resumeName') : null;
    if (phenomName && !String(phenomName.value || '').trim()) {
      try { input.value = ''; } catch { /* a box that will not be cleared */ }
      return { ok: false, refused: '', showing: false, name: file.name };
    }
    // A SITE THAT SAYS IT REFUSED THE FILE HAS NOT GOT IT (F-880). career5's
    // SuccessFactors portal printed "Error Encountered while uploading your
    // file." beside a file the run had counted as attached (2026-10-16), and
    // the report said "resume attached". Its own words are read for a moment
    // after the drop, and a refusal is reported as one, in those words.
    // Decided BEFORE the wait below: a site that takes the file and empties
    // its box (UKG) must not read as a failure because time passed.
    const okNow = (input.files?.length || 0) > 0 || shownNow;
    const showingNow = ownDrawn ? fileShowing(file.name) : null;
    const REFUSED_RE = /\berror\b[^.]{0,40}\bupload|\bupload[^.]{0,40}\b(fail(ed|ure)?|error|refused|rejected)\b|could not be uploaded|unable to upload|file (type|format|extension) (is )?not (allowed|supported|accepted)|file is too (large|big)/i;
    let refused = '';
    for (let i = 0; i < 4 && !refused; i += 1) {
      refused = pageErrors().find((t) => REFUSED_RE.test(t)) || '';
      if (!refused) await pause(400);
    }
    if (refused) {
      captureAround(input, `resume refused by the site: ${refused.slice(0, 80)}`);
      // Cleared, so nothing later reads the refused file as attached.
      try { input.value = ''; } catch { /* a box that will not be cleared */ }
      return { ok: false, refused, showing: false, name: file.name };
    }
    return {
      ok: okNow,
      // Only a claim where it was checked. `null` is "no evidence either way",
      // and the caller says nothing about it — a warning nobody can act on is
      // worse than silence.
      showing: showingNow,
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
   * HIS OTHER FILES ARE NOT HIS RESUME (F-1013 #7, review 2026-11-05). The
   * cover letter is "Alex Rivera - <co> - <role> - cover letter.pdf" and the
   * portfolio "Alex Rivera Portfolio.pdf": either chip on the page read as "the
   * resume is showing", so an empty resume slot was reported attached and
   * keepResume (F-1009) never attached it again.
   */
  const NOT_RESUME_FILE_RE = /cover[\s_-]*letter|portfolio|transcript|writing[\s_-]*sample/i;
  /** A chip naming his RESUME in this text: his name or the file's own start, up to its .pdf, and not another of his files. */
  function resumeNamedIn(text, base = '') {
    const re = /alex\s*rivera\b[^\n]{0,90}?\.pdf/gi;
    for (let m = re.exec(text); m; m = re.exec(text)) if (!NOT_RESUME_FILE_RE.test(m[0])) return true;
    if (base) {
      for (let i = text.indexOf(base); i >= 0; i = text.indexOf(base, i + 1)) {
        const chip = text.slice(i, i + 160).split(/\.pdf\b|\n/i)[0];
        if (!NOT_RESUME_FILE_RE.test(chip)) return true;
      }
    }
    return false;
  }

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
      const base = String(name || '').replace(/\.pdf$/i, '').trim();
      if (resumeNamedIn(text, base.length > 8 ? base.slice(0, Math.min(base.length, 24)) : '')) return true;
      // PHENOM KEEPS IT IN HIDDEN BOXES (Honda, 2026-10-03): the apply form
      // carries `#resumeName` / `#resumePath`, empty until its server has the
      // file; the uploader prints nothing a reader would see in time.
      const held = ['resumeName', 'resumePath', 'resumeRelativePath'].map((id) => document.getElementById(id)?.value || '').join(' ');
      return !!(held.trim() && /\.(pdf|docx?|txt|html?)\b|\//i.test(held) && !NOT_RESUME_FILE_RE.test(held));
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
      if (superseded()) throw new Error('a newer run took over this page');
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
   * His portfolio PDF onto a portfolio slot (2026-10-22). Built ahead of time by
   * `npm run portfolio:pdf`, so there is nothing to wait for: the server has
   * the file or it does not. Dropped on the zone too when the input is hidden,
   * for uploaders that only listen there.
   */
  async function attachPortfolio(input) {
    const got = await send({ type: 'portfolio' });
    if (!got?.ok) throw new Error(got?.error || 'no portfolio PDF — run npm run portfolio:pdf');
    const bin = atob(String(got.b64 || ''));
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) raw[i] = bin.charCodeAt(i);
    const file = new File([raw], String(got.filename || '').trim() || `${PERSON_NAME} Portfolio.pdf`, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    let hidden = false;
    try { const st = getComputedStyle(input); hidden = st.display === 'none' || st.visibility === 'hidden' || input.offsetParent === null; } catch { /* treat as shown */ }
    if (hidden) {
      await pause(1200);
      const base = file.name.replace(/\.pdf$/i, '');
      if (!String(document.body?.innerText || '').includes(base)) dropOnto(input, file);
    }
    console.log(`[jarvis] portfolio attached: ${file.name}`);
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
  // .pac-container .pac-item: GOOGLE PLACES rows (P3), plain divs in a
  // container at the end of <body>, on any site that uses Google's address
  // and city autocomplete. Modelled on Google's markup, not met live yet.
  const optionSelector = '[role="option"], [data-automation-id="promptOption"], li[role="option"], [data-automation-id="promptLeafNode"], spl-select-option, .dropdown-results .dropdown-location, [role="gridcell"].cx-select__list-item, .pac-container .pac-item';
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
    // A GOOGLE PLACES ROW is inline spans — the place, then its region — that
    // read "SpringfieldWA, USA" run together; its parts are joined with a comma.
    if (n?.classList?.contains?.('pac-item')) {
      const parts = [...n.children].filter((c) => !c.classList.contains('pac-icon')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (parts.length) return parts.join(', ');
    }
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
  /**
   * A ROW ALREADY TICKED (P3, 2026-11-12). In a multi-select whose rows carry
   * checkboxes, clicking a ticked row UN-chooses it. The row's own box (or its
   * aria-checked) says so; aria-selected is NOT read — it marks the row the
   * keyboard is on, not one that is chosen.
   */
  const rowTicked = (n) => {
    if (!n) return false;
    if (n.getAttribute?.('aria-checked') === 'true') return true;
    const box = n.querySelector?.('input[type="checkbox"]');
    if (box) return !!box.checked;
    return n.querySelector?.('[role="checkbox"][aria-checked="true"]') != null;
  };
  /**
   * A LIST'S OWN "NOT LISTED" ROW (P3 review, 2026-11-12): "Other", "Other
   * (please specify)", "Other / Not Listed", "Not Listed", "None of the
   * above", "School not listed". Never a real name that opens on the word:
   * "Other Valley College" is a school he did not attend.
   */
  const notListedRow = (t) => /^(other|not listed|none of the above|(my\s+)?(school|university|college|institution|degree)\s+(is\s+)?not\s+(listed|found)|not\s+on\s+(the|this)\s+list)\s*([-–:(/,].*)?$/i
    .test(String(t || '').replace(/\s+/g, ' ').trim());
  /**
   * THE BOX A LIST SCROLLS IN, never the page (P4, 2026-11-13). A list taller
   * than its window is scrolled to reach rows it has not painted (Workday's
   * virtualised prompts). Climbing from a row of a list that does NOT scroll
   * reached <html>, and the page was scrolled a screen at a time to its end
   * and left at the top: measured on a react-select school box below the fold,
   * the window went 300 → 5805 → 0 during one fill.
   */
  const listScroller = (row) => {
    const page = new Set([document.documentElement, document.body, document.scrollingElement]);
    let grid = row;
    for (let i = 0; grid && i < 8; i += 1, grid = grid.parentElement) {
      if (page.has(grid)) return null;
      if (grid.scrollHeight > grid.clientHeight + 8) return grid;
    }
    return null;
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
    // …but a list's OWN search box is not another field (ADP, 2026-10-17): the
    // filter input in <sdf-select-simple>'s portal says aria-controls="listbox"
    // and sits with that list inside its floating pane, which made every option
    // "another field's" and the years question read 0 rows. A control inside
    // the same pop-up as the list it names is that list's search box; a form
    // field's own combobox is never inside a pop-up, so F-697 still holds.
    // ADP names its pane by TAG (<sdf-floating-pane>), with no such class.
    const POPUP = '[class*="floating" i], [class*="portal" i], [class*="popover" i], [class*="popper" i], [role="dialog"], sdf-floating-pane, sdf-floating-pane-portal';
    const others = el && scope === document
      ? new Set(all('[aria-controls]', document)
        .filter((c) => { const id = c.getAttribute('aria-controls'); const tgt = id ? byId(id) : null; const pane = tgt && c.closest?.(POPUP); return !(pane && pane.contains(tgt)); })
        .map((c) => c.getAttribute('aria-controls')).filter((id) => id && id !== mine))
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
    const grid = listScroller(first);
    if (!grid) return seen;
    const startedAt = grid.scrollTop;
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
    grid.scrollTop = startedAt;
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
  /** A street-address box by its label: address or street, never e-mail, web, URL or IP (F-1017 (1)). */
  function streetLabel(label) {
    const l = String(label || '');
    return /\baddress\b|\bstreet\b/i.test(l) && !/e-?mail|\bweb|\burl\b|\bip\b/i.test(l);
  }

  async function pickSuggestion(el, want, rowsBefore, label, alts = []) {
    try {
      if (!el || el.tagName !== 'INPUT' || !want) return false;
      const locationish = /location|\bcity\b|where\b.{0,30}\b(live|located|based)/i.test(label || '');
      // A STREET-ADDRESS BOX THAT SUGGESTS (F-1017 (1), Lam on Eightfold
      // 2026-10-30): its list spells the street its own way ("1 Test Street,
      // Springfield, WA, USA" for "1 Test St"), the matcher found no row, the list
      // was shut, and the box dropped what was typed. The one row that starts
      // with the same number and street name is his street.
      const addressish = streetLabel(label);
      // Only a box that can suggest is waited on — a pause after every text
      // box cost seconds on a long form. Anything else gets one look now.
      const suggests = locationish || addressish || el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')
        || el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns') || el.hasAttribute('list');
      if (suggests) await pause(450);
      let rows = openRows(el);
      if (rows.length <= rowsBefore && locationish && want.includes(',')) {
        const city = want.split(',')[0].trim();
        // THE OTHER SPELLINGS FIRST, THEN THE CITY (P3): "Springfield, WA" for a
        // list that answers postal codes, then the bare city. The plan names
        // them (`placeAlts`, from the server's state table).
        const tries = [...new Set([...(Array.isArray(alts) ? alts.map(String) : []), city].filter((t) => t && norm(t) !== norm(want)))].slice(0, 3);
        for (const t of tries) {
          // Staying in the box: its list closes on blur (Lever, 2026-09-25).
          // eslint-disable-next-line no-await-in-loop
          if (enterText) await enterText(el, t, { stay: true }); else setNativeValue(el, t);
          // Until the rows arrive, not a fixed beat: Lever's lookup answered in
          // under a second on Phoenix Tailings and in more on Machina Labs, and
          // the fixed 900 ms read that as "nothing found" (2026-09-25).
          for (let waited = 0; waited < 3000; waited += 150) {
            // eslint-disable-next-line no-await-in-loop
            await pause(150);
            if (openRows(el).length > rowsBefore) break;
          }
          rows = openRows(el);
          if (rows.length > rowsBefore) break;
        }
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
      if (addressish) {
        // The number and the street's first word, as whole words: "1 test"
        // takes "1 Test Street …" and never "1 Testa Ave". Decided here, not
        // by the general matcher, which takes the FIRST of two "1 Test Street"
        // rows in different cities: exactly one row fits, or the choice is his.
        const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const head = words(want).split(' ').slice(0, 2).join(' ');
        if (/^\d+\s\S+/.test(head)) {
          const fits = texts.map((t, k) => (words(t) === head || words(t).startsWith(`${head} `) ? k : -1)).filter((k) => k >= 0);
          // No row with his number and street word ("12 N Main" vs "12 North
          // Main …"): the matcher's own pick stands. Two or more: his choice.
          i = fits.length === 1 ? fits[0] : fits.length > 1 ? -1 : i;
        }
      }
      if (Number.isInteger(i) && i >= 0 && i < texts.length) {
        const places = !!rows[i]?.classList?.contains?.('pac-item');
        const typedText = String(el.value || '');
        const ok = await clickRowByText(el, texts[i]);
        // A Places box takes the hovered row on blur (P3): leave it, with the
        // events raised by hand for a tab the browser will not focus.
        if (places) {
          el.blur();
          el.dispatchEvent(new FocusEvent('blur'));
          el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        }
        await pause(300);
        // A PLACES ROW COUNTS ONLY ONCE THE BOX TOOK IT (review 2026-11-12):
        // text left in the box is just what was typed, and the list shuts on
        // every blur, taken or not, so its closing proves nothing. Taken means
        // the box now reads differently from what was typed, or reads the row.
        if (places) {
          const now = String(el.value || '');
          const took = now.trim() !== '' && (norm(now) !== norm(typedText) || norm(now) === norm(texts[i]));
          if (!took) {
            console.log(`[jarvis] "${String(label).slice(0, 40)}": the place list did not take "${texts[i].slice(0, 50)}"`);
            return false;
          }
        }
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
      const grid = listScroller(first);
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
      // A GOOGLE PLACES ROW is chosen by HOVER (P3): the hovered row is the
      // one the box takes when it loses focus (the caller blurs it). Only
      // these rows get mouseover, so no other site's hover menu is opened.
      const hover = hit.classList?.contains?.('pac-item') ? ['mouseover', 'mouseenter'] : [];
      for (const type of [...hover, 'pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
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
    // A LIST STILL SEARCHING IS NOT ITS ANSWER (F-878). Oracle's ZIP lookup
    // showed "99009, Elk, Springfield, WA" for "12345" — the rows of a search on
    // the first digits, read before the full number's search came back, and
    // the walk gave up on a list that was still busy (TI, 2026-10-23). A list
    // that says aria-busy is waited for, and a number is waited for until a
    // row carries it: a number has no near miss worth taking.
    const listBusy = () => {
      const id = owner?.getAttribute?.('aria-controls');
      const lb = id ? byId(id) : null;
      return lb?.getAttribute?.('aria-busy') === 'true';
    };
    const numeric = /^\d{3,}$/.test(String(want).trim());
    while (Date.now() < deadline) {
      await pause(120);
      if (listBusy()) { steady = 0; continue; }
      const rows = openRows(owner);
      if (rows.length === 1 && /^no (items|results|matches|options)\b/i.test(norm(rowText(rows[0])))) {
        emptyFor += 1;
        if (emptyFor >= 7) return null;
        continue;
      }
      emptyFor = 0;
      if (numeric && rows.length && !rows.some((n) => rowText(n).includes(String(want).trim()))) { seen = rows; steady = 0; continue; }
      if (rows.length) seen = rows;
      // WHOLE WORDS ONLY (F-618). "No" was found inside "just NOT a protected
      // veteran" and HP's form said he is a veteran. Anything short of the
      // answer's own words at the row's start goes to the matcher, which
      // knows what "No" means for a veteran question.
      const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const w = words(want);
      // A ROW WHOSE FIRST PART IS THE ANSWER beats one that only starts with
      // it (F-883): "Springfield" took "Springfield Valley, Springfield, WA" over
      // "Springfield, Springfield, WA" on Oceaneering's Oracle City (2026-10-23).
      // …and only when ONE row does (F-987). Ginkgo's sponsorship list was
      // "Yes, I will need sponsorship support now | Yes, but not until the
      // future | No": the server's matcher refused "Yes", and the first row
      // whose first part is "Yes" was taken — a claim the plan never made.
      // Two rows that both start with the answer go to the matcher, or to him.
      // A BARE YES OR NO IS NEVER TAKEN LOOSELY (F-987 review): with only
      // "Yes, but not until the future" and "No" on offer, the one row whose
      // first part is "Yes" would still be his answer to a visa question. The
      // server's matcher has already been asked; what it refused stays his.
      const bare = /^(yes|no|y|n|true|false)$/.test(w);
      const only = (pred) => { if (bare) return null; const m = rows.filter(pred); return m.length === 1 ? m[0] : null; };
      const hit = rows.find((n) => norm(rowText(n)) === norm(want))
        || only((n) => words(String(rowText(n)).split(',')[0]) === w)
        || only((n) => words(rowText(n)).startsWith(`${w} `))
        // The words INSIDE a row only when one row has them, and never behind
        // a qualifier that changes the thing: "Bachelor's" (two words once the
        // apostrophe goes) was found inside "Post Bachelor's or equivalent" on
        // Ford's Oracle Education Level (F-886, 2026-10-23). Anything less
        // certain goes to the server's matcher.
        || (() => {
          if (w.split(' ').length < 2) return null;
          const inside = rows.filter((n) => ` ${words(rowText(n))} `.includes(` ${w} `) && !/^(post|pre|non|under) [a-z]/.test(words(rowText(n))));
          return inside.length === 1 ? inside[0] : null;
        })();
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
  /**
   * A SEARCH THAT LISTENS TO KEYS, NOT TO TEXT (F-887). Oracle's cx-select
   * lookups (School, ZIP, City) search on each keystroke: a value inserted
   * whole left the list unfiltered on onsemi and TI (2026-10-23). Typed here
   * one character at a time — keydown, keypress, the character inserted as
   * typing inserts it, keyup — the way a person's keys arrive.
   */
  const keyTyped = (box) => !!box?.matches?.('input.cx-select-input, input[role="combobox"][aria-haspopup="grid"]');
  async function typeByKeys(box, text) {
    box.focus({ preventScroll: true });
    try { box.select?.(); document.execCommand('delete'); } catch { /* nothing to clear */ }
    if (String(box.value || '')) setNativeValue(box, '');
    for (const ch of String(text)) {
      const init = { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : '', bubbles: true, composed: true };
      box.dispatchEvent(new KeyboardEvent('keydown', init));
      box.dispatchEvent(new KeyboardEvent('keypress', init));
      let put = false;
      try { put = document.execCommand('insertText', false, ch); } catch { put = false; }
      if (!put) setNativeValue(box, `${box.value || ''}${ch}`);
      box.dispatchEvent(new KeyboardEvent('keyup', init));
      // eslint-disable-next-line no-await-in-loop
      await pause(45);
    }
  }

  // `rowOk` (P3 review 2026-11-12): a row the matcher picks is taken only when
  // this says yes. The "Other" last resort passes notListedRow, so a school
  // named "Other Valley College" is never his "Other".
  async function pickFromPrompt(el, want, kind, alsoOk = [], { remote = false, rowOk = null } = {}) {
    const fits = (t) => !rowOk || rowOk(String(t || ''));
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
      box.focus({ preventScroll: true });
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
            box.focus({ preventScroll: true });
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
        // A NAME THAT OPENS ON A GENERIC WORD is searched by its first word
        // that tells it apart (P3): "University" answers every university,
        // and a remote school list's first page of those may not hold
        // "University of Washington"; "Washington" does.
        // Only an answer OPENING on one of these words changes: "I am not a
        // veteran" still opens on "I", "The Ohio State University" on "The".
        const headWord = () => {
          const ws = String(want).trim().split(/\s+/);
          if (ws.length < 2 || !/^(university|college|institute|school)$/i.test(ws[0])) return ws[0].slice(0, 12);
          return (ws.slice(1).find((x) => !/^(of|the|and|for|at|in|&)$/i.test(x)) || ws[0]).slice(0, 12);
        };
        const prefix = streetish ? String(want).trim().split(/\s+/).slice(0, 3).join(' ')
          : /^\s*\d{4,}\s*$/.test(String(want)) ? String(want).trim().slice(0, 3)
          : /^\s*\d/.test(String(want)) ? String(want).trim()[0] : headWord();
        // WHAT THE BOX HELD BEFORE ANY SEARCH WAS TYPED IN IT (F-1035): put back
        // when nothing below is chosen, so a box that already had an answer is
        // never left showing the search word.
        const boxHad = String(box.value ?? '');
        for (const attempt of ['open', 'filtered']) {
          if (attempt === 'filtered') {
            // A <div> combobox has nothing to type into; its open list is all there is.
            // (An Oracle lookup is searched even when the prefix is the whole
            // answer: its open list is an unfiltered first page — F-887.)
            if ((prefix.length < 3 && !/^\d$/.test(prefix)) || (norm(prefix) === norm(want) && !keyTyped(box)) || !/^(INPUT|TEXTAREA)$/.test(box.tagName)) break;
            // TYPED, as a person types: SmartRecruiters opens its list on real
            // text insertion and not on a value set from outside plus
            // synthetic keys (measured 2026-09-24). The old path stays the
            // fallback for a page that refuses execCommand.
            box.focus({ preventScroll: true });
            if (keyTyped(box)) {
              await typeByKeys(box, prefix);
            } else {
              let typedIn = false;
              try { box.select?.(); typedIn = document.execCommand('insertText', false, prefix); } catch { typedIn = false; }
              if (!typedIn || !String(box.value || '').includes(prefix)) {
                setNativeValue(box, prefix);
                for (const t of ['keydown', 'keypress', 'keyup']) {
                  box.dispatchEvent(new KeyboardEvent(t, { key: 'a', bubbles: true }));
                }
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
            // …AND AN OLD LIST STILL ON SCREEN IS NOT THE ANSWER (F-887). Oracle
            // keeps its unfiltered first page (Aalborg, Alpen-Adria, American
            // University…) up while the search for "Lakeside" runs; the rows
            // were read at once and School stayed empty (onsemi, 2026-10-23).
            // Rows that carry the typed words are waited for, up to 3 s.
            if (keyTyped(box)) {
              const p = norm(prefix);
              const carriesPrefix = () => openRows(box).some((n) => norm(rowText(n)).includes(p));
              for (let waited = 0; waited < 3000 && !carriesPrefix(); waited += 150) {
                // eslint-disable-next-line no-await-in-loop
                await pause(150);
              }
            }
            // A NUMBER IS WAITED FOR UNTIL A ROW CARRIES IT, THEN SEARCHED
            // WHOLE (F-878). TI's Oracle ZIP lookup offered only "99009, Elk,
            // Springfield, WA" for "12345" (2026-10-23): rows of a search still
            // settling, or a lookup the first digits do not reach. A number has
            // no near miss worth taking, so the full number is typed before
            // the field is given up.
            if (/^\s*\d{4,}\s*$/.test(String(want))) {
              const num = String(want).trim();
              const carries = () => openRows(box).some((n) => rowText(n).includes(num));
              for (let waited = 0; waited < 2500 && !carries(); waited += 150) {
                // eslint-disable-next-line no-await-in-loop
                await pause(150);
              }
              if (!carries()) {
                box.focus({ preventScroll: true });
                if (keyTyped(box)) {
                  await typeByKeys(box, num);
                } else {
                  let typedAll = false;
                  try { box.select?.(); typedAll = document.execCommand('insertText', false, num); } catch { typedAll = false; }
                  if (!typedAll || !String(box.value || '').includes(num)) setNativeValue(box, num);
                }
                for (let waited = 0; waited < 3000 && !carries(); waited += 150) {
                  // eslint-disable-next-line no-await-in-loop
                  await pause(150);
                }
              }
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
          // EVERY SPELLING ON THE LIST ALREADY OPEN (F-991), as the menu path
          // below does. Maven's "How did you hear about us?" reopened per
          // spelling of the company's site, ~6 s each, and the field's budget
          // ran out before "LinkedIn", the row it had.
          if (!(Number.isInteger(i) && i >= 0) && attempt === 'open' && alsoOk.length) {
            for (const alt of alsoOk) {
              // eslint-disable-next-line no-await-in-loop
              const again = await send({ type: 'choose', want: String(alt), options: texts }).catch(() => null);
              if (again?.ok && Number.isInteger(again.index) && again.index >= 0) { i = again.index; break; }
            }
          }
          if (Number.isInteger(i) && i >= 0 && i < texts.length && !fits(texts[i])) {
            console.log(`[jarvis] combo "${String(want).slice(0, 30)}": "${String(texts[i]).slice(0, 40)}" is not that row — not taken`);
            i = -1;
          }
          if (Number.isInteger(i) && i >= 0 && i < texts.length) {
            // ALREADY CHOSEN IS ANSWERED. Clicking a chosen row of a
            // multi-select un-chooses it (SmartRecruiters' major, 2026-09-24).
            const now = comboValue ? comboValue(el) : '';
            // The whole option for a single choice: "No" is not already chosen
            // because the box reads "No Selection" (TSMC, 2026-09-24). A
            // multi-select's chips are a list, so there a part is enough.
            const multiBox = kind === 'multi';
            // …but an Oracle lookup holding the very word just typed to search
            // it has chosen nothing (F-902): "Vietnamese" typed into Ford's
            // Language box read as already chosen, the row was never clicked,
            // and the save was refused with "The Language field is required."
            const ownTyping = attempt === 'filtered' && keyTyped(box);
            if (now && !ownTyping && (multiBox ? norm(now).includes(norm(texts[i])) : norm(now) === norm(texts[i]))) return true;
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
                box.focus({ preventScroll: true });
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
        // NOTHING CHOSEN, SO NOTHING CHANGED (F-1035). The filtered attempt types
        // a search into the box before the "never typed over" guard further
        // down; on a box that already held an answer, a search that found
        // nothing left that word in place of the answer (a second try after
        // the page settled turned "June" into "May", 2026-11-07). What the
        // input held is put back: its own value where it holds the choice
        // (Oracle, Eightfold), empty where it only searches (react-select).
        // A row that matched has already returned above — a wrong saved City
        // is still replaced (F-883). A box he touched during the try is his
        // (F-1024): left as he left it, and named. The events the restore
        // raises are dispatched, not trusted, so they never count as his.
        if (alreadyHad && kind !== 'multi' && /^(INPUT|TEXTAREA)$/.test(box.tagName || '') && String(box.value ?? '') !== boxHad) {
          if (his && (his.touched(box) || his.touched(el) || (wrap && his.touched(wrap)))) {
            console.log(`[jarvis] combo "${String(want).slice(0, 30)}": nothing chosen, and he changed the box meanwhile — left as he left it`);
          } else {
            setNativeValue(box, boxHad);
            console.log(`[jarvis] combo "${String(want).slice(0, 30)}": nothing chosen — the box is back to what it held`);
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
          if (!Number.isInteger(i) || i < 0 || i >= texts.length || !fits(texts[i])) break;
          // Already ticked: the answer is in, and a click would take it out.
          if (kind === 'multi' && rowTicked(openRows(box).find((n) => norm(rowText(n)) === norm(texts[i])))) {
            console.log(`[jarvis] prompt "${want}": "${texts[i]}" is already ticked — left alone`);
            if (openRows(box).length) box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
          }
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
      box.focus({ preventScroll: true });
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
      const found = await waitForOption(want, box);
      const row = found && fits(rowText(found)) ? found : null;
      if (!row) {
        // A component that takes custom values is given the answer as one
        // (F-354) — the typed text stays and the form's model holds it.
        // Never for a pick held to `rowOk`: a typed "Other" is not its row.
        if (!rowOk && !alreadyHad && commitComponentValue(box, String(want))) { box.blur(); return true; }
        if (found && openRows(box).length) box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        // Leave nothing behind — unless there was something there to begin
        // with, in which case leaving it alone is the whole point.
        if (!alreadyHad) { setNativeValue(box, ''); box.blur(); }
        return !!alreadyHad && kind !== 'multi';   // a chip already there is not this item (F-390)
      }
      // Already ticked (P3): answered as it stands. The search text goes, the
      // list shuts, and the row is not clicked — a click would un-choose it.
      if (kind === 'multi' && rowTicked(row)) {
        console.log(`[jarvis] prompt "${want}": "${rowText(row)}" is already ticked — left alone`);
        setNativeValue(box, '');
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        box.blur();
        return true;
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
      if (!row || !fits(rowText(row))) { clickNoSubmit(button); return false; }   // close it rather than leave it hanging open
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

  // AN ENTRY'S OWN SAVE IS NEVER THE SECTION'S ADD (F-889). Oracle labels the
  // open entry's save "Add Education" and hides the real Add (data-qa
  // "add106") while the entry is open; the save was pressed as the Add, so
  // every run stored whatever the open entry held as another tile — TI,
  // 2026-10-23: "Mechanical Engineering" twice and "Unnamed Major".
  const isEntrySave = (b) => !!b?.closest?.('[data-qa="profileItemInlineSaveButton"], .profile-item-footer');

  function genericAddFor(kind) {
    if (!deepQuerySelectorAll || !buttonName) return null;
    const btn = deepQuerySelectorAll('button, [role="button"]').filter((b) => onScreen(b) && !isEntrySave(b))
      .find((b) => { const name = buttonName(b); return /\badd\b/i.test(name) && SECTION_HEAD_RE[kind].test(`${name} ${headingAbove ? headingAbove(b) : ''}`); });
    return btn || null;
  }

  /**
   * ORACLE'S PROFILE ITEMS BY THEIR NUMBER (F-889). Each section's Add is
   * data-qa="add<N>" ("Add Education", "Add Experience"), its saved entries are
   * article[data-qa="profileItem<N>"] tiles, and the open entry's save sits in
   * the same .profile-item-container. A tile names an education by its Major
   * only ("Mechanical Engineering", or "Unnamed Major"), a job by title and
   * company. Null when the page is not built this way.
   */
  function oracleSection(kind) {
    const add = [...document.querySelectorAll('[data-qa^="add"]')]
      .find((b) => /^add\d+$/.test(b.getAttribute('data-qa') || '') && SECTION_HEAD_RE[kind].test((b.textContent || '').trim()));
    if (!add) return null;
    const n = add.getAttribute('data-qa').slice(3);
    const container = add.closest('.profile-item-container') || add.parentElement?.parentElement || null;
    const articles = [...document.querySelectorAll(`article[data-qa="profileItem${n}"]`)];
    const tiles = articles.map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase());
    const save = container?.querySelector('[data-qa="profileItemInlineSaveButton"]');
    return { n, container, tiles, articles, openSave: save && save.getClientRects().length > 0 ? save : null };
  }

  // A SAVED TILE ORACLE STILL FLAGS (F-911): "Fields to fix: 1" under it.
  const TILE_FIX_RE = /\bfields?\s+to\s+fix\b/i;
  const tileButton = (article, word) => article.querySelector(`button[aria-label="${word}" i], button[title="${word}" i]`)
    || [...article.querySelectorAll('button, [role="button"]')].find((b) => new RegExp(`^\\s*${word}\\b`, 'i').test(b.getAttribute('aria-label') || b.textContent || ''));

  /**
   * ROWS AN EARLIER RUN LEFT EMPTY ARE DELETED (F-911). Ford's Languages held
   * two "Unnamed Language — Fields to fix: 1" tiles beside good English and
   * Vietnamese ones: a run added a row, could not choose the name, and left
   * it. A tile is junk only when it says "Unnamed …" and carries no other word
   * — nothing he typed is ever on it. Uses the tile's own Delete, and a
   * confirm step inside the page if one opens.
   */
  async function oracleDeleteEmptyTiles(kind) {
    const ora = oracleSection(kind);
    if (!ora) return 0;
    let deleted = 0;
    for (const a of ora.articles) {
      const text = String(a.innerText || a.textContent || '');
      if (!/\bunnamed\b/i.test(text)) continue;
      const rest = text.replace(/\bunnamed\s+(job\s+title|[a-z]+)/gi, ' ').replace(/\bfields?\s+to\s+fix\b:?\s*\d*/gi, ' ')
        .replace(/\b(edit|delete)\b/gi, ' ').replace(/[\d/\-–—:.,\s]+/g, ' ').trim();
      if (rest) continue;
      const del = tileButton(a, 'Delete');
      if (!del) continue;
      del.click();
      await pause(700);
      const yes = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button, .oj-dialog button')]
        .find((b) => b.getClientRects().length > 0 && /^\s*(yes|delete|remove|ok|confirm)\b/i.test(b.textContent || ''));
      if (yes) { yes.click(); await pause(700); }
      deleted += 1;
    }
    return deleted;
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
    input.focus({ preventScroll: true });
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
  function entryOnPage(kind, e, opts = {}) {
    // Oracle's saved tiles, read by their own section (F-889): an education
    // tile carries only its Major, so the school-and-degree pair below never
    // found it and each run added the entry again.
    const ora = oracleSection(kind);
    if (ora && ora.tiles.length) {
      const keys = (kind === 'work' ? [e.title, e.company] : kind === 'education' ? [e.fieldOfStudy || e.school] : [e.name])
        .filter((v) => v && String(v).trim()).map((v) => String(v).trim().toLowerCase());
      // A tile's spelling of the company may be shorter or punctuated
      // differently ("Acme Steel Steel Stud Co" for "…Company"; F-900): Ford's
      // Experience went from 2 tiles to 5 in one run. The company is matched
      // by its words without a corporate suffix, or by its first two words.
      const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const SUFFIX = /\s+(company|co|inc|incorporated|llc|ltd|corp|corporation|group|plc)$/;
      const has = (t, k, i) => {
        const ft = flat(t), fk = flat(k);
        if (ft.includes(fk)) return true;
        if (kind !== 'work' || i !== 1) return false;
        const core = fk.replace(SUFFIX, '');
        const two = fk.split(' ').slice(0, 2).join(' ');
        return (core.length >= 4 && ft.includes(core)) || (two.split(' ').length === 2 && two.length >= 8 && ft.includes(two));
      };
      const at = keys.length ? ora.tiles.findIndex((t) => keys.every((k, i) => has(t, k, i))) : -1;
      // A matching tile Oracle still flags is not done (F-911): Oceaneering's
      // education held only its Major, and "present" left Degree and School
      // blank for good. The caller opens it with the tile's Edit instead.
      if (at >= 0 && opts.flagged && TILE_FIX_RE.test(ora.tiles[at])) { opts.flagged.article = ora.articles[at]; return false; }
      if (at >= 0) return true;
    }
    // ORACLE'S TIMELINE THEME (F-915, Coherent 2026-10-25): saved entries are
    // .beautiful-timeline-item cards, and a short card shows only its title
    // ("Manufacturing Engineer Intern From May 2026 to August 2026"), so the
    // title-and-company pair below never found Applied Materials and a dateless
    // copy was added. A job is the same job when its dates are.
    const cards = [...document.querySelectorAll('.beautiful-timeline-item')].map((c) => String(c.innerText || c.textContent || '').replace(/\s+/g, ' ').toLowerCase());
    if (cards.length) {
      const MON = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
      const when = (d) => (d && d.year ? `${d.month ? `${MON[Number(d.month) - 1]} ` : ''}${d.year}` : '');
      const low = (s) => String(s || '').trim().toLowerCase();
      for (const t of cards) {
        if (kind === 'work') {
          const s = when(e.start), en = when(e.end);
          if (s && t.includes(`from ${s}`) && (!en || t.includes(`to ${en}`))) return true;
          if (e.title && e.company && t.includes(low(e.title)) && t.includes(low(e.company))) return true;
        } else if (kind === 'education') {
          if (e.school && t.includes(low(e.school))) return true;
        } else if (e.name && t.includes(low(e.name))) return true;
      }
    }
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

  // INLINE ROWS (F-897): SuccessFactors' Previous Employment is rows of boxes
  // with one Add and no per-row Save. Each Add paints a new empty row; the
  // page may redraw the whole section, so the rows already filled come back as
  // "new" controls too — only EMPTY boxes are taken, and no Save is looked for.
  /**
   * A SAVED JOB THAT SAYS SOMETHING HIS FILES DO NOT (F-924, Denso 2026-10-25).
   * His earlier Denso profile held Acme Steel as "Mechanical Engineer" — an
   * internship, overstated — and Applied Materials under its team's name,
   * "Automation Technology Group", and both were kept. An internship whose
   * saved tile has no "Intern" in it, or a tile with his job's dates and
   * another employer, is named in the report so he edits it before Submit.
   */
  const mismatchTried = new Set();
  function savedEntryMismatch(kind, e) {
    if (kind !== 'work' || !e?.company) return '';
    const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const core = flat(e.company).replace(/\s+(company|co|inc|incorporated|llc|ltd|corp|corporation|group|plc)$/, '');
    const firstTwo = core.split(' ').slice(0, 2).join(' ');
    const ora = oracleSection(kind);
    const cards = [...document.querySelectorAll('.beautiful-timeline-item')];
    // Only Oracle's standard tiles are opened and corrected: their Edit opens
    // the editor the save path knows. A timeline card's does not, and a miss
    // there would Add a copy — those are named instead.
    const nodes = [...(ora?.articles || []), ...cards.map(() => null)];
    const tiles = [...(ora?.tiles || []), ...cards.map((c) => String(c.innerText || c.textContent || ''))]
      .map((t) => String(t).replace(/\s+/g, ' ').trim());
    if (!tiles.some(Boolean)) return '';
    const MON = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const when = (d) => {
      if (!d) return '';
      if (typeof d === 'string') return flat(d);
      return d.year ? flat(`${d.month ? MON[Number(d.month) - 1] : ''} ${d.year}`) : '';
    };
    const start = when(e.start);
    for (let k = 0; k < tiles.length; k += 1) {
      const t = tiles[k]; if (!t) continue;
      const ft = flat(t);
      const hasCompany = (core.length >= 4 && ft.includes(core)) || (firstTwo.length >= 8 && ft.includes(firstTwo));
      if (hasCompany && /\bintern\b/i.test(String(e.title || '')) && !/\bintern(ship)?\b/i.test(t)) {
        return { node: nodes[k] || null, msg: `a saved entry at ${e.company} reads "${t.slice(0, 80)}" — it was an internship, so its title should be "${e.title}"` };
      }
      if (!hasCompany && start && ft.includes(`from ${start}`) && /\bintern\b/i.test(String(e.title || ''))) {
        return { node: nodes[k] || null, msg: `a saved entry with your ${e.company} dates reads "${t.slice(0, 80)}" — its employer should be "${e.company}"` };
      }
    }
    return '';
  }

  async function fillEntriesGeneric(kind, entries, { inline = false } = {}) {
    let filled = 0, checked = 0;
    const unanswered = [];
    const keys = [];
    // ENTRIES THIS RUN FOUND SAVED OR SAVED ITSELF (F-900). The tab's record
    // keeps "left for you" lines across the runs of one application and only
    // drops one whose label a later run answered. TI's report at 08:53 still
    // said "Work experience 2 (Acme Steel…) — Add did not open a sub-form" and
    // "entered; press its Save yourself" from an older run, over a page whose
    // tiles showed every job saved. These tags clear those lines.
    const answered = [];
    let done = 0;
    const landed = (k) => { filled += 1; keys.push(k); };
    const controlsNow = () => [...allControls(), ...deepQuerySelectorAll('[role="checkbox"], [role="radio"]')].filter((el) => el.getClientRects().length > 0);
    const buttonsNow = () => deepQuerySelectorAll('button, [role="button"]').filter((b) => onScreen(b));
    const labels = ENTRY_LABELS[kind];
    // Empty rows an earlier run left (F-911).
    const junk = await oracleDeleteEmptyTiles(kind);
    if (junk) console.log(`[jarvis] ${SECTION_LABEL[kind]}: deleted ${junk} empty row(s) an earlier run left`);
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const tag = `${SECTION_LABEL[kind]} ${i + 1}${e.company || e.school || e.name ? ` (${e.company || e.school || e.name})` : ''}`;
      // AN ENTRY THAT IS ALREADY ON THE PAGE IS NOT ADDED AGAIN (F-355). A
      // second press, or the pass over fields an answer revealed, saw the
      // saved "Manufacturing Engineer Intern · Applied Materials" card and
      // opened Add for it once more.
      const flagged = {};
      // A SAVED TILE THAT SAYS SOMETHING HIS FILES DO NOT is opened with its own
      // Edit and filled again from his files, like a "Fields to fix" row
      // (F-924). Once per tile per page; when it has no Edit, it is named.
      let off = '';
      try { off = savedEntryMismatch(kind, e); } catch { off = ''; }
      const fixKey = off && off.node ? `${location.pathname}|${kind}|${String(off.node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)}` : '';
      if (off && off.node && !mismatchTried.has(fixKey) && tileButton(off.node, 'Edit')) {
        mismatchTried.add(fixKey);
        console.log(`[jarvis] ${tag}: ${off.msg} — correcting it from your files`);
        flagged.article = off.node;
      } else if (off) {
        unanswered.push(`${tag}: ${off.msg} — edit it before you Submit`);
      }
      if (!flagged.article && entryOnPage(kind, e, { flagged })) { landed(`entry:${kind}:${i}:present`); answered.push(tag); done += 1; continue; }
      // …but a saved row Oracle flags "Fields to fix" is opened and finished (F-911).
      const editTile = flagged.article ? tileButton(flagged.article, 'Edit') : null;
      if (editTile) {
        chip(`${tag}: finishing the saved row`);
        clickNoSubmit(editTile);
        for (let t = 0; t < 24 && !oracleSection(kind)?.openSave; t += 1) await pause(250);
      }
      // AN ENTRY LEFT OPEN BY AN EARLIER RUN IS FILLED AND SAVED, NOT ADDED
      // AGAIN (F-889). Oracle hides its Add while an entry is open; the open
      // entry's controls are this entry's, and its save counts as new.
      const ora = oracleSection(kind);
      const reuse = ora?.openSave && ora.container ? ora : null;
      const add = reuse ? null : genericAddFor(kind);
      if (!add && !reuse) { unanswered.push(`${tag} — ${i === 0 ? 'no Add button on this form; add it by hand' : 'no way to add another here; the rest are yours'}`); break; }
      // The chip names the stage, so a slow or stuck entry is visible on the
      // page rather than a bare "Jarvis is filling…" (F-353).
      chip(`${tag}: opening`);
      const before = new Set(reuse ? controlsNow().filter((el) => !reuse.container.contains(el)) : controlsNow());
      const buttonsBefore = new Set(buttonsNow().filter((b) => !(reuse && b === reuse.openSave)));
      if (add) clickNoSubmit(add);
      let fresh = [];
      for (let t = 0; t < 32 && !fresh.length; t += 1) { await pause(250); fresh = controlsNow().filter((el) => !before.has(el)); }
      await pause(300);
      fresh = controlsNow().filter((el) => !before.has(el));
      if (!fresh.length) { unanswered.push(`${tag} — Add did not open a sub-form`); break; }
      const labelled = fresh.map((el) => ({ el, label: labelFor(el, el.type || 'text') || '', used: false }));
      const emptyOk = (el) => !inline || el.type === 'checkbox' || el.getAttribute('role') === 'checkbox' || !String(el.value ?? '').trim();
      const take = (re, pred = () => true) => { const hit = labelled.find((x) => !x.used && re.test(x.label) && pred(x.el) && emptyOk(x.el)); if (hit) hit.used = true; return hit; };
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
        // AN ORACLE LOOKUP IN AN ENTRY IS PICKED FROM ITS LIST (F-887): text
        // set into onsemi's School box left "The School Name field is
        // required" — the value has to be a row the lookup offered.
        if (keyTyped(f.el)) {
          const picked = await pickFromPrompt(f.el, String(value), 'combo');
          await pause(150);
          // Typed text sitting in an Oracle lookup is not a choice: only a
          // row picked counts (F-902).
          if (picked) landed(`entry:${kind}:${i}:${key}`);
          else unanswered.push(`${tag} — ${key}: could not pick "${String(value).slice(0, 40)}" from its list`);
          continue;
        }
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
      // A CHOICE DRAWN AS PILLS IS STILL A CHOICE (F-889). Oracle's Degree is a
      // required row of cx-select pill buttons, not a box; nothing chose one,
      // the save was refused, and TI's entry was left open with "Add these
      // yourself". The pill is picked by the dashboard's matcher from the
      // degree and its spellings, before the save; a pill already chosen stays.
      if (kind === 'education' && e.degree) {
        const scope = oracleSection(kind)?.container;
        const row = scope && [...scope.querySelectorAll('.input-row')]
          .find((r) => labels.degree.test((r.querySelector('label')?.textContent || '').trim()) && r.querySelector('button.cx-select-pill-section'));
        if (row) {
          const pills = () => [...row.querySelectorAll('button.cx-select-pill-section')].filter((b) => b.getClientRects().length > 0);
          const texts = pills().map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim());
          const chosen = () => pills().find((b) => /--selected/.test(String(b.className || '')) || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true');
          if (chosen()) landed(`entry:${kind}:${i}:degree`);
          else {
            let at = -1;
            for (const w of [e.degree, ...(Array.isArray(e.degreeAlts) ? e.degreeAlts : [])]) {
              // eslint-disable-next-line no-await-in-loop
              const asked = await send({ type: 'choose', want: String(w), options: texts }).catch(() => null);
              if (asked?.ok && Number.isInteger(asked.index) && asked.index >= 0) { at = asked.index; break; }
            }
            if (at >= 0) {
              chip(`${tag}: degree`);
              pills()[at]?.click();
              for (let t = 0; t < 6 && !chosen(); t += 1) await pause(200);
              if (chosen()) landed(`entry:${kind}:${i}:degree`);
              else unanswered.push(`${tag} — degree: choose "${texts[at]}"`);
            } else unanswered.push(`${tag} — degree: none of "${texts.slice(0, 5).join(' | ')}" is "${e.degree}"`);
          }
        }
      }
      if (kind === 'work') {
        if (e.current) {
          const c = take(labels.current, (el) => el.type === 'checkbox' || el.getAttribute('role') === 'checkbox');
          if (c) { if (!isOn(c.el)) { c.el.click(); await settleAria(c.el); } if (isOn(c.el)) { checked += 1; keys.push(`entry:work:${i}:current`); } else unanswered.push(`${tag} — I currently work here: tick it`); }
        }
        for (const [key, when] of [['start', e.start], ['end', e.end]]) {
          if (!when) continue;
          // A split Month / Year box takes no whole date (F-795): left to the
          // planner's pass, which answers each half by its name.
          const f = take(labels[key], (el) => isDateBox(el) && !/\b(month|year|day)\b/i.test(labelFor(el, el.type || 'text') || ''));
          if (!f) continue;
          chip(`${tag}: ${key === 'start' ? 'from' : 'to'} date`);
          if (await setGenericDate(f.el, when)) landed(`entry:work:${i}:${key}`);
          else unanswered.push(`${tag} — ${key === 'start' ? 'From' : 'To'}: pick ${String(when.month || '').padStart(2, '0')}/${when.year}`);
        }
      } else if (kind === 'education') {
        for (const [key, year] of [['firstYear', e.firstYear], ['lastYear', e.lastYear]]) {
          if (!year) continue;
          // A YEAR NEVER GOES INTO A MONTH BOX (F-795). Oracle splits each date
          // into "Start Date Month" and "Start Date Year"; "start" matched the
          // Month box first and "2023" was typed into it. A Year box is taken
          // when there is one; Month and Day boxes are never taken here (the
          // planner's pass over the open entry answers them by name).
          const yearOk = (x) => (isDateBox(x.el) || x.el.type === 'number') && !/\b(month|day)\b/i.test(x.label);
          const split = labelled.find((x) => !x.used && labels[key].test(x.label) && /\byear\b/i.test(x.label) && yearOk(x));
          const f = split ? ((split.used = true), split) : take(labels[key], (el) => yearOk({ el, label: labelFor(el, el.type || 'text') || '' }));
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
      // ORACLE'S INLINE SAVE IS A type=submit INSIDE THE APPLICATION FORM
      // (F-887): `button.save-btn[data-qa=
      // "profileItemInlineSaveButton"]`, labelled "Add Education" / "Add
      // Experience". wouldSubmit refused it, the first entry stayed open, and
      // every second Add "did not open a sub-form" (Ford, TI, Oceaneering,
      // onsemi, 2026-10-23). This one named control is allowed; Oracle's real
      // Submit is a separate type=button pager control, and clickNoSubmit
      // still cancels any native form submission while it clicks.
      const entrySave = (b) => !!b.matches?.('button.save-btn[data-qa="profileItemInlineSaveButton"]');
      // An inline row has no Save, and a redrawn section's own Add would read
      // as one here and open yet another row (F-897).
      const save = inline ? null : buttonsNow().filter((b) => !buttonsBefore.has(b) && (!wouldSubmit(b) || entrySave(b)))
        .find((b) => {
          const n = buttonName(b);
          const id = `${b.getAttribute('data-ui') || ''} ${b.getAttribute('data-automation-id') || ''} ${b.getAttribute('data-testid') || ''}`;
          return (/\b(save|done|add|update|confirm|ok)\b/i.test(n) || /save/i.test(id)) && !/cancel|another|file|upload|submit|apply/i.test(n);
        });
      if (save) {
        const stillOpen = () => fresh.some((el) => el.isConnected && el.getClientRects().length > 0);
        // Oracle's screen-reader announcements are alerts too ("You're all
        // set, Anna Maria Alex!" was given as why TI refused the entry, F-889).
        const refusal = () => deepQuerySelectorAll('[role="alert"]').map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t && t.length < 100 && !/you['’]re all set|\bloaded\b|dependency-fields|apply-flow\./i.test(t))[0] || '';
        chip(`${tag}: saving`);
        clickNoSubmit(save);
        // AN ORACLE SAVE GOES TO ITS SERVER FIRST (F-900): TI's entries were
        // still closing when the 4 s look ended, and a save in flight read as
        // refused — and was cancelled. Oracle's is waited for up to 12 s
        // unless the form has said why it refused.
        const slowSave = entrySave(save);
        for (let t = 0; t < (slowSave ? 48 : 16) && stillOpen() && !(t >= 8 && slowSave && refusal()); t += 1) await pause(250);
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
        answered.push(tag);
        done += 1;
      } else if (!inline) {
        unanswered.push(`${tag} — entered; press its Save yourself`);
      }
      console.log(`[jarvis] ${tag}: entered (by labels${inline ? ', inline row' : ''})`);
    }
    // Every entry saved or already there: an older run's "this form said …
    // Add these yourself" for the section is answered too (F-900).
    // A row this run saved with no name is taken off again, and said (F-911).
    const leftEmpty = await oracleDeleteEmptyTiles(kind);
    if (leftEmpty) {
      console.log(`[jarvis] ${SECTION_LABEL[kind]}: deleted ${leftEmpty} empty row(s) it could not finish`);
      unanswered.push(`${SECTION_LABEL[kind]} — ${leftEmpty} row${leftEmpty > 1 ? 's' : ''} could not be finished and ${leftEmpty > 1 ? 'were' : 'was'} removed; check the list and add what is missing`);
    } else if (entries.length && done === entries.length) answered.push(`${SECTION_LABEL[kind]} — this form said`);
    return { filled, checked, unanswered, keys, answered };
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
  /**
   * WHAT A DATE WIDGET HOLDS, NOT WHAT ITS BOX SHOWS (F-801). Workday's live
   * spinner keeps its number in aria-valuenow and in the "-display" div beside
   * the input (Samsung's captured markup, 2026-10-04); the input is only where
   * keys land. Read from the box alone, a date Workday HAD taken looked empty:
   * the key fallback and the step's read-back typed it again into a widget
   * whose focus had moved on, and the month's digits became the year — HP
   * 06 → 2006 (F-618), KION 05 → 2005, ITW and Terex 08 → 2008 ("Invalid
   * Date: 08/", 2026-10-16 to 10-23). A box with neither reads as before.
   */
  function spinnerNow(input) {
    const now = input?.getAttribute?.('aria-valuenow');
    if (now != null && /^\d+$/.test(String(now).trim())) return String(now).trim();
    const disp = input?.parentElement?.querySelector?.('[data-automation-id$="-display"]');
    const shown = String(disp?.textContent || '').replace(/\D/g, '');
    if (shown) return shown;
    return String(input?.value ?? '');
  }

  async function setSpinner(input, val) {
    const s = String(val);
    const want = s.replace(/\D/g, '');
    const holds = () => {
      const got = spinnerNow(input).replace(/\D/g, '');
      return !!got && (got === want || (want.length <= 2 && Number(got) === Number(want)));
    };
    const leave = async () => {
      input.blur();
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await pause(180);
    };
    // 1. As typing inserts it.
    input.focus({ preventScroll: true });
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
    input.focus({ preventScroll: true });
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

  /**
   * A SALARY BOX THAT WANTS ONLY A NUMBER (2026-10-17). His answer is
   * "$90000/year", which most forms keep as typed; ADP's "What is your desired
   * salary?" refused it — "Invalid salary value" — and the step would not move.
   * Once a page has said so, every salary-like box holding more than digits is
   * retyped as the number alone. Returns how many were retyped.
   */
  async function retrySalaryDigits() {
    let n = 0;
    for (const el of deepQuerySelectorAll('input[type="text"], input:not([type]), input[type="number"]')) {
      if (!el.getClientRects().length) continue;
      const v = String(el.value || '');
      const digits = v.replace(/\.\d*$/, '').replace(/\D/g, '');
      if (!digits || digits === v.trim() || digits.length < 4) continue;
      if (!/salary|compensation|pay\b|wage/i.test(labelFor(el, 'text') || el.getAttribute('aria-label') || el.name || el.id || '')) continue;
      if (enterText) await enterText(el, digits); else setNativeValue(el, digits);
      n += 1;
    }
    if (n) console.log(`[jarvis] the page refused a salary as written; retyped ${n} box(es) as the number alone`);
    return n;
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
    if (his && his.touched(container)) return true;   // he set it: his answer stands (F-1024)
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
    if (his && his.touched(box)) return true;   // he unticked it (F-1024)
    (box.closest('label') || box).click();
    return !!box.checked;
  }

  async function fillEntries(groups) {
    let filled = 0, checked = 0;
    const unanswered = [];
    const keys = [];
    const answered = [];
    const landed = (k) => { filled += 1; keys.push(k); };
    for (const group of groups) {
      const kind = group.kind;
      const specs = ENTRY_FIELDS[kind];
      const entries = Array.isArray(group.entries) ? group.entries : [];
      if (!specs || !entries.length) continue;
      const primary = ENTRY_PRIMARY?.[kind] || specs[0].ids;
      // No Workday wrappers and no Workday Add: a component form (F-341).
      if (!lastOf(primary) && !addButtonFor(kind)) {
        const g = await fillEntriesGeneric(kind, entries, { inline: !!group.inline });
        filled += g.filled; checked += g.checked; unanswered.push(...g.unanswered); keys.push(...g.keys); answered.push(...(g.answered || []));
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
    return { filled, checked, unanswered, keys, answered };
  }

  /** A <select> option that is a placeholder rather than a choice. */
  // "-- Select --", "Select state", "Choose a country…" too (F-1013 #25, review
  // 2026-11-05): those read as an answer, and a site's default under them was
  // kept on a follow-along run as if he had chosen it.
  const PLACEHOLDER_OPTION_RE = /^\s*[-—–\s]*(?:(?:please\s+)?(?:select|choose|pick)(?:\s+(?:one|an?\s+\w+(?:\s+\w+)?|your\s+\w+(?:\s+\w+)?|\w+))?|none\s+selected|no\s+selection|nothing\s+selected)?\s*[-—–.:…\s]*$/i;

  /**
   * Does this control already carry an answer? Only asked on a follow-along
   * run, where the answer is to leave it alone.
   */
  function holdsAnswer(a, f, el, els) {
    if (a.action === 'fill') {
      // A Workday date part holds what its widget holds (F-801), not its box.
      const held = (a.datePart ? spinnerNow(el) : String(el.value ?? '')).trim();
      // A YEAR BOX HOLDING SOMETHING THAT IS NOT A YEAR holds no answer (F-799):
      // UKG's resume parse left "08/2023" in "From year", and its server
      // refused the step ("Path 'Educations[0].FromYear'").
      if (held && /^(19|20)\d\d$/.test(String(a.value ?? '').trim()) && /\byear\b|yyyy/i.test(String(a.label || '')) && !/^(19|20)\d\d$/.test(held)) return false;
      return held !== '';
    }
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
    // ANY SITE'S BOX MARKED INVALID WHILE IT HOLDS TEXT (F-922). Micron's
    // Eightfold form showed his email and names in their boxes, aria-invalid,
    // "cannot be left blank" — its own state never took the typing. He fixed
    // it by retyping; the same edit is made here. Read by aria-invalid alone,
    // so a page-wide alert never keeps a box flagged.
    for (const box of document.querySelectorAll('input[aria-invalid="true"], textarea[aria-invalid="true"]')) {
      if (out.some((o) => o.box === box)) continue;
      if (/^(checkbox|radio|hidden|file)$/i.test(box.type || '') || box.readOnly || box.disabled) continue;
      if (onScreen && !onScreen(box)) continue;
      if (!String(box.value || '').trim()) continue;
      if (box.getAttribute('role') === 'combobox' || /dateSection|searchBox/.test(box.getAttribute('data-automation-id') || '')) continue;
      out.push({ wrap: box.parentElement || box, box, generic: true });
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
    for (const { wrap, box, generic } of staleBoxes()) {
      if (his && (his.touched(box) || his.touched(wrap))) continue;   // his box: never retyped (F-1024)
      const label = (labelFor && labelFor(box)) || wrap.querySelector('label')?.textContent?.trim() || 'a field';
      // eslint-disable-next-line no-await-in-loop
      await retypeLastLetter(box);
      // eslint-disable-next-line no-await-in-loop
      await pause(250);
      const flagged = box.getAttribute('aria-invalid') === 'true' || (!generic && !!wrap.querySelector(FIELD_ERROR_SEL));
      if (flagged) {
        const why = (wrap.querySelector(FIELD_ERROR_SEL)?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        still.push(`${label}${why ? ` ("${why}")` : ''}`);
      } else repaired.push(label);
    }
    if (repaired.length || still.length) console.log(`[jarvis] re-entered ${repaired.length} field(s) the form had not taken${still.length ? `; still flagged: ${still.join('; ')}` : ''}`);
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
  /**
   * Does this file box fill the application from the resume it is given?
   * Read from the words around it, a few levels up — UKG's sits under "You
   * can use a resume to fill out your application faster" (F-798).
   */
  // …and Phenom's "Make completing your job application easier by uploading
  // your resume" (Honda, 2026-10-23, F-874): uploaded last, its parse emptied
  // Country and State under the answers and wrote the job rows in its order.
  const PREFILL_RE = /fill\s+(out\s+)?(your\s+|the\s+)?(application|form|profile)\s+(faster|quicker|automatically)|(make|makes)\s+(completing|filling\s+(out|in))\s+(your\s+|the\s+)?(job\s+)?application\s+(easier|faster|quicker)|pre-?fill|auto-?populat|populate\s+(your|the)\s+(application|form|profile)|(parse|import)\s+(your\s+)?(resume|cv)\s+to\s+fill/i;
  function prefillsFromResume(el) {
    let n = el;
    for (let k = 0; k < 5 && n; k += 1, n = n.parentElement) {
      const whole = String(n.innerText || n.textContent || '');
      const t = whole.slice(0, 800);
      if (PREFILL_RE.test(t)) return true;
      if (whole.length > 800) break;            // past the box's own block: the rest of the page says nothing about it
    }
    return false;
  }
  /** Wait for a form to finish filling itself from a resume: it changes, then holds still for 2 s (25 s at most). */
  async function waitForPrefill(capMs = 25000) {
    const shape = () => `${document.querySelectorAll('input, select, textarea').length}|${String(document.body?.innerText || '').length}|${[...document.querySelectorAll('input, select, textarea')].map((e) => e.value).join('\u0001')}`;
    const started = Date.now();
    let last = shape();
    let changedAt = 0;
    let quietSince = Date.now();
    while (Date.now() - started < capMs) {
      await pause(250);
      const now = shape();
      if (now !== last) { last = now; changedAt = Date.now(); quietSince = Date.now(); continue; }
      if (changedAt && Date.now() - quietSince >= 2000) return true;
      if (!changedAt && Date.now() - started >= 8000) return false;   // nothing happened: not a parsing box after all
    }
    return false;
  }

  /**
   * WHERE AN ADDRESS PART SITS IN ITS CASCADE (F-883), or null for anything
   * else: Country 0, State 1, County 2, City 3, ZIP 4. A phone's country code
   * is not an address part.
   */
  const addressRank = (label) => {
    const l = String(label || '').replace(/\s*[—–-]\s.*$/, '').trim().toLowerCase();
    if (!l || /phone|dial|citizen|nationality|birth|degree|school|employer|company/.test(l)) return null;
    if (/^country(\s*\/\s*region)?\b/.test(l)) return 0;
    if (/^(state|province|state\s*\/\s*province|region)\b/.test(l)) return 1;
    if (/^county\b/.test(l)) return 2;
    if (/^(city|town|city\s*\/\s*town)\b/.test(l)) return 3;
    if (/^(zip|postal|post\s*code|postcode)\b/.test(l)) return 4;
    return null;
  };
  /**
   * AN ADDRESS BOX HOLDING ANOTHER PLACE IS NOT HIS CORRECTION (F-883). A run
   * that follows him keeps what a box holds — it may be his fix — but an
   * address comes from his files, and a candidate profile the site saved can
   * hold a stale one: TI's held City "Elk" for a man in Springfield, and the ZIP
   * lookup below it then had nothing to offer. Compared on the first part
   * ("Springfield, Springfield, WA" is Springfield); a state's code and name agree.
   */
  const addressDisagrees = (a, held) => {
    if (addressRank(a.label) == null || !String(a.value ?? '').trim() || !String(held ?? '').trim()) return false;
    const first = (s) => String(s).split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const h = first(held); const w = first(a.value);
    // Equal first parts only: "Springfield Valley" is another town than "Springfield".
    if (!h || !w || h === w) return false;
    if (addressRank(a.label) === 1 && (h.length === 2 || w.length === 2)) return false;   // WA / Washington: the matcher decides
    return true;
  };

  /**
   * A WORK-AUTHORIZATION ANSWER SAVED IN HIS ACCOUNT IS NOT HIS CORRECTION
   * (F-925, critical). Honeywell's Oracle form opened with the Yes/No pills
   * from his earlier application pressed — authorized "Yes", sponsorship
   * "No" — and the follow-along rule kept them as if he had chosen them now;
   * the plan had the right answers. A visa/sponsorship question whose pressed
   * answer differs from the plan is answered from his files when this tab has
   * NEVER SEEN the question before — the value can only have come from the
   * site. Once a run has planned it, whatever it holds is his: the rule that a
   * follow-along run keeps his hand corrections still stands.
   */
  const VISA_Q_RE = /\bsponsor|\bauthori[sz]ed\s+to\s+work|\blawfully\s+authori[sz]ed|\bwork\s+authori[sz]ation\b|\bvisa\b|\bimmigration\b|\bwithout\s+restriction/i;
  const SEEN_FIELDS_KEY = 'jv-seen-fields';
  const seenFields = () => {
    if (!globalThis.__jarvisSeenFields) {
      let arr = [];
      try { arr = JSON.parse(sessionStorage.getItem(SEEN_FIELDS_KEY) || '[]'); } catch { arr = []; }
      globalThis.__jarvisSeenFields = new Set(Array.isArray(arr) ? arr : []);
    }
    return globalThis.__jarvisSeenFields;
  };
  const markFieldsSeen = (labels) => {
    const s = seenFields();
    for (const l of labels) if (l) s.add(`${location.pathname}|${l}`);
    try { sessionStorage.setItem(SEEN_FIELDS_KEY, JSON.stringify([...s].slice(-400))); } catch { /* this document remembers */ }
  };
  const visaDisagrees = (a, f, el, els) => {
    if (!VISA_Q_RE.test(String(a.label || '')) || !String(a.value ?? '').trim()) return false;
    const key = `${location.pathname}|${a.label}`;
    if (seenFields().has(key)) return false;
    let held = '';
    if (a.action === 'prompt') held = f.current;
    else if (el?.tagName === 'SELECT') held = el.selectedOptions?.[0]?.textContent ?? f.current;
    else if (Array.isArray(els) && els.length > 1) {
      const on = els.findIndex((e) => isOn(e));
      held = on >= 0 ? (f.options?.[on] ?? els[on]?.textContent ?? els[on]?.value ?? '') : '';
    } else held = el?.value ?? f.current;
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const h = norm(held); const w = norm(a.value);
    if (!h || !w || h === w || h.startsWith(`${w} `) || w.startsWith(`${h} `)) return false;
    console.log(`[jarvis] ${a.label.slice(0, 60)}: the page held "${String(held).trim().slice(0, 40)}" (saved in the account?) — answering "${a.value}" from his files`);
    return true;
  };

  /** One box, by what it is on this page (F-881): its id, name and label together. */
  const fieldKeyOf = (f, el) => `${el?.id || f?.id || ''}|${el?.name || f?.name || ''}|${f?.label || ''}`;

  // HIS HANDS AND HIS FIELDS (F-1024, 2026-11-06): "i try to edit it myself the
  // dropdown but it keeps running my shit over". discover.js marks every field
  // he changes (`his`). Here: a run waits while he is typing or picking, then
  // never writes a field he touched — not in a later pass, the read-back's
  // refill, the second try for lists, a follow-along run or its exceptions.
  // A field the SITE keeps clearing is re-entered twice at most.
  const HIS_QUIET_MS = 2500;
  const HIS_WAIT_CAP_MS = 30000;
  /** Wait until he has left the page alone for HIS_QUIET_MS; false when he kept at it past the cap. */
  async function waitForHim() {
    if (!his) return true;
    const began = Date.now();
    // The cap is counted in waits as well as by the clock: a clock that stands
    // still or steps back (a frozen test clock, a system time correction) must
    // never hold a run here for good.
    for (let waited = 0; Date.now() - his.lastGestureAt() < HIS_QUIET_MS; waited += 200) {
      if (Date.now() - began > HIS_WAIT_CAP_MS || waited >= HIS_WAIT_CAP_MS) return false;
      // eslint-disable-next-line no-await-in-loop
      await pause(200);
    }
    return true;
  }
  /** Fields Jarvis wrote in this document, and how often it found one empty again and refilled it. */
  const WROTE = globalThis.__jarvisWrote || (globalThis.__jarvisWrote = new Map());
  const WRITE_ACTIONS = new Set(['fill', 'prompt', 'select', 'check', 'uncheck', 'essay']);
  const REFILL_CAPPED = new Set(['fill', 'prompt', 'select']);

  async function fillCurrentStep(only = null, { keepExisting = false, entries: wantEntries = true, readBack = !only, prefilled = false, context = null, parseWrote = null } = {}) {
    const opts = { prefilled, parseWrote };
    // PLANNED WITH THE WHOLE PAGE, WRITTEN ONLY WHERE ASKED (F-872). A pass
    // over a few fields (the ones an answer revealed, the ones the read-back
    // lost) used to send the planner those fields alone, and an End Date with
    // no Company box beside it cannot be placed in a job row: Paylocity's End
    // Date appears only once "Currently Working Here" is unticked, and was
    // never answered (Optomec ×4, 2026-10-04). With `context`, the planner
    // sees every field and only `only`'s are touched.
    const restrict = only && Array.isArray(context) && context.length ? new Set(only.map((f) => f.elements?.[0]).filter(Boolean)) : null;
    // Closed sections first: TSMC's SuccessFactors form keeps every question
    // behind a collapsed section header (2026-09-24).
    if (!only && expandSections) {
      const opened = expandSections();
      if (opened) { console.log(`[jarvis] opened ${opened} closed section(s)`); await settle(); }
    }
    // …and a resume slot that exists only once its dialog is open
    // (SuccessFactors' "Upload a Resume", F-835).
    if (!only && !prefilled && openResumeUpload) {
      const pressed = await openResumeUpload();
      console.log(`[jarvis] resume opener: ${resumeOpenerSaw?.() || ''}`);
      if (pressed) { console.log(`[jarvis] opened the resume upload ("${pressed}")`); await settle(); }
    }
    // Files left from an earlier application at this employer (F-913).
    if (!only && !prefilled) {
      const gone = await clearEarlierFiles();
      if (gone.length) { console.log(`[jarvis] removed files from an earlier application: ${gone.join(', ')}`); await settle(); }
    }
    const fields = restrict ? context : (only || discover());
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

    const asked = await timed('plan', () => send({
      type: 'plan',
      pageUrl: location.href,
      heading: pageHeading(),
      pageTitle: document.title || '',
      fields: fields.map(({ elements, ...rest }) => rest),
      sections,
      // (No "the page mentions a cover letter" signal since 2026-11-04: his
      // rule is a letter only where the form asks, decided by the plan itself.)
    }));
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
    const isFile = (a) => a.action === 'upload' || a.action === 'upload-letter' || a.action === 'upload-portfolio';
    // …AND WRITTEN ANSWERS AFTER EVERYTHING TYPED, for the same reason
    // (Sabanto's Breezy form, 2026-09-25): its "Cover Letter" box came first,
    // the writer took over three minutes, and not one field was filled in
    // that time. The server starts writing when it plans the step, so the
    // text keeps coming while the rest of the form fills.
    const isEssay = (a) => a.action === 'essay';
    let actions = [...planned.filter((a) => !isFile(a) && !isEssay(a)), ...planned.filter(isEssay), ...planned.filter(isFile)];
    // AN ADDRESS IS LOOKED UP IN THE ORDER IT CASCADES (F-883). Oracle filters
    // each address list by the one before it: TI's ZIP list held only the
    // codes of the City already in the box ("99009, Elk, Springfield, WA"), and the
    // plan, in page order, asked ZIP before City (2026-10-23). The address
    // parts keep their slots among the other actions and are re-dealt into
    // them Country → State → County → City → ZIP.
    {
      const slots = [];
      // Skips too: a ZIP skipped as "already set" is looked at again after City.
      actions.forEach((a, k) => { if (addressRank(a.label) != null) slots.push(k); });
      if (slots.length > 1) {
        const parts = slots.map((k) => actions[k]).sort((x, y) => addressRank(x.label) - addressRank(y.label));
        slots.forEach((k, j) => { actions[k] = parts[j]; });
      }
    }

    // …EXCEPT A RESUME BOX THAT FILLS THE FORM FROM THE RESUME (F-798). UKG's
    // "You can use a resume to fill out your application faster" box parses
    // the file and re-writes the form: uploaded last, it blanked Address 1,
    // Zip, Major and Skills under answers already typed, added a second
    // education row, and left "08/2023" in a year box (Yaskawa, 2026-10-22).
    // There the resume goes in FIRST, the page is let finish filling itself,
    // and the step is read and planned again on top of what it wrote.
    if (!only && !opts.prefilled) {
      const up = actions.find((a) => a.action === 'upload');
      const field = up && (fields.find((x) => x.type === 'file' && ((up.fieldId && x.id === up.fieldId) || (up.key && x.key === up.key))) || fields[up.at]);
      const box = field?.elements?.[0];
      if (box && prefillsFromResume(box)) {
        console.log('[jarvis] this resume box fills the form from the resume — attaching it first');
        // Which boxes were EMPTY before the parse (F-881): what lands in them
        // is the site's guess, and a follow-along run may write over it.
        const parseWrote = new Set();
        parseWrote.before = new Set();   // every key present before the upload: a box the parse CREATES is absent here
        for (const f of fields) {
          const el0 = f.elements?.[0];
          if (el0) parseWrote.before.add(fieldKeyOf(f, el0));
          if (!el0 || f.type === 'file') continue;
          const held = String(f.current ?? ('value' in el0 ? el0.value : '') ?? '').trim();
          if (!held) parseWrote.add(fieldKeyOf(f, el0));
        }
        captureOracleEntries('before the resume parse');   // R5 step 1: a record only
        // A resume the server cannot give must not end the step (review, 2026-10-24).
        const put = await timed('resume', () => attachResume(box)).catch((e) => ({ ok: false, error: String(e?.message || e) }));
        if (!(put && put.ok === false)) {
          await waitForPrefill();
          captureOracleEntries('after the resume parse');
          const again = await fillCurrentStep(null, { keepExisting, entries: wantEntries, readBack, prefilled: true, parseWrote });
          // Attached but never shown is said, not counted as done (F-465).
          if (put && put.showing === false) {
            return { ...again, uploaded: false, unanswered: [...(again.unanswered || []), 'Resume (attached, but the page never showed the file — check it before you Submit)'] };
          }
          // THE PARSE CAN TAKE THE FILE BACK OUT (F-1009): looked at again,
          // attached once more if it is gone, and the form answered again on
          // top of what the second parse wrote.
          const k = await keepResume(box, put?.name || '');
          if (!k.kept) return { ...again, uploaded: false, unanswered: [...(again.unanswered || []), RESUME_DROPPED] };
          if (k.reattached) {
            await waitForPrefill();
            const third = await fillCurrentStep(null, { keepExisting, entries: wantEntries, readBack, prefilled: true, parseWrote });
            const still = await keepResume(box, put?.name || '', { attach: false });
            return still.kept ? { ...third, uploaded: true } : { ...third, uploaded: false, unanswered: [...(third.unanswered || []), RESUME_DROPPED] };
          }
          return { ...again, uploaded: true };
        }
      }
    }
    // Once the box has filled the form, a second upload would parse it over
    // everything again: nothing more goes into a prefilling box on this pass.
    if (opts.prefilled) {
      actions = actions.filter((a) => {
        if (a.action !== 'upload') return true;
        const f = fields.find((x) => x.type === 'file' && ((a.fieldId && x.id === a.fieldId) || (a.key && x.key === a.key))) || fields[a.at];
        return !(f?.elements?.[0] && prefillsFromResume(f.elements[0]));
      });
    }

    let filled = 0, checked = 0, uploaded = false;
    let attachedResume = null;   // the resume this step attached, looked at again at its end (F-1009)
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
    /** Optional fields nothing answers — shown apart, never "left for you" (F-803). */
    const optionalBlank = [];
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

    const datePartsTyped = [];
    for (let i = 0; i < actions.length; i += 1) {
      let a = actions[i];
      if (superseded()) {
        unanswered.push('stopped: a newer run took over this page');
        break;
      }
      heartbeat();
      if (await disarmedMidRun()) {
        unanswered.push('stopped: you disarmed this tab — nothing more was put on the form');
        break;
      }
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
      if (restrict && !restrict.has(el)) continue;   // planned for context only (F-872)
      // A ZIP THAT WAS ALREADY RIGHT, EMPTIED BY THE CITY CHANGED ABOVE IT
      // (F-883). The planner skipped it as "already set"; Oracle's lookups
      // cascade, so a City replaced a moment ago can clear it. Typed back.
      if (a.action === 'skip' && addressRank(a.label) === 4 && String(f.current || '').trim() && !String(el.value ?? '').trim()) {
        a = { ...a, action: f.type === 'prompt' ? 'prompt' : 'fill', value: String(f.current).split(',')[0].trim(), why: 'the ZIP it held, emptied when City changed', refill: true };
      }
      // HIS HANDS FIRST (F-1024): while he is typing or picking, the run
      // waits for him instead of racing him; then what he touched is his.
      if (his && WRITE_ACTIONS.has(a.action)) {
        if (Date.now() - his.lastGestureAt() < HIS_QUIET_MS) {
          if (!(await waitForHim())) {
            unanswered.push('paused: you were using the form, so Jarvis stopped here — press Jarvis when you want the rest filled');
            break;
          }
          // He may have taken the page elsewhere while the run waited.
          if (superseded()) { unanswered.push('stopped: a newer run took over this page'); break; }
          if (await disarmedMidRun()) { unanswered.push('stopped: you disarmed this tab — nothing more was put on the form'); break; }
        }
        if (his.touched(f)) {
          skipped += 1;
          answered.push(a.label);
          keptList.push(`${a.label} (yours: left as you set it)`);
          continue;
        }
      }
      // The follow-along rule, applied before anything is written. A prompt
      // the planner would re-drive, a select with a real choice in it, a
      // radio group with a button pressed, a text box with words in it: all
      // his now. Counted as skipped, not unanswered — they ARE answered.
      // …EXCEPT WHAT THE SITE'S OWN RESUME PARSE WROTE A MOMENT AGO (F-881).
      // A box empty before the upload and full after it holds the parse's
      // guess, not his correction: Honda's (Phenom) Education End Date read
      // 01/01/2027 and was kept on the follow-along run (2026-10-23).
      if (keepExisting && holdsAnswer(a, f, el, els) && !(opts.parseWrote && (opts.parseWrote.has(fieldKeyOf(f, el)) || (opts.parseWrote.before && !opts.parseWrote.before.has(fieldKeyOf(f, el)))))
        && !a.refill && !addressDisagrees(a, a.action === 'prompt' ? f.current : (el?.tagName === 'SELECT' ? (el.selectedOptions?.[0]?.textContent ?? f.current) : (el?.value ?? f.current)))
        && !visaDisagrees(a, f, el, els)) {
        skipped += 1;
        answered.push(a.label);   // the page holds it; it is not his to do (F-399)
        const now = a.action === 'fill' ? String(el.value ?? '') : a.action === 'prompt' ? String(f.current || '')
          : el.tagName === 'SELECT' ? (el.options[el.selectedIndex]?.textContent || '') : (els.find((e) => isOn(e))?.value || f.options?.[els.findIndex((e) => isOn(e))] || '');
        const want = String(a.value ?? '');
        if (want && !kept_same(now, want)) keptList.push(`${a.label} (kept "${now.trim().slice(0, 40)}")`);
        continue;
      }
      // A FIELD THE SITE KEEPS CLEARING (F-1024): what Jarvis wrote and then
      // finds EMPTY again is written again twice at most, then named for him.
      // Only that counts — a write into a field still holding an answer (a
      // later pass, a press) is not the site wiping anything (review).
      // Only for answers whose emptiness can be read: holdsAnswer calls every
      // tick and essay empty, so those would hit the cap while done (review).
      if (REFILL_CAPPED.has(a.action)) {
        // The posting, as discover.js's pageKey reads it: a hash's own query is a per-step token.
        const wroteKey = `${location.pathname}${location.search}${String(location.hash || '').split('?')[0]}|${fieldKeyOf(f, el)}`;
        const w = WROTE.get(wroteKey);
        if (!w) WROTE.set(wroteKey, { refills: 0 });
        else if (!holdsAnswer(a, f, el, els)) {
          if (w.refills >= 2) {
            unanswered.push(`${a.label} (the page kept clearing it; Jarvis stopped re-entering it)`);
            continue;
          }
          w.refills += 1;
        }
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
          // A street-address box is typed into and STAYED in (F-1017 (1)): its
          // suggestion list closes on leaving, and Eightfold's drops the text
          // with it. The list gets its pick first, then the box is left.
          const streetBox = !a.datePart && el.tagName === 'INPUT' && streetLabel(a.label);
          let typed = a.datePart && dateWrap && todayTried.get(dateWrap) && String(el.value || '').trim()
            ? { kept: true }
            : a.datePart && typeof setSpinner === 'function'
            // A part that reads back WRONG is typed once more from a clean
            // start: HP's year box held 2006 after 2027 was typed (F-618).
            ? { kept: (await setSpinner(el, String(typeValue))) || (String(el.value || '').trim() !== '' && (await pause(300), await setSpinner(el, String(typeValue)))) }
            : enterText ? await enterText(el, a.value, { stay: streetBox }) : (setNativeValue(el, a.value), { kept: kept(el.value, a.value) });
          // Only parts this run TYPED: a date the calendar's Today set is
          // Workday's own and may be tomorrow by his clock (F-690).
          const calendarSet = !!(a.datePart && dateWrap && todayTried.get(dateWrap));
          if (a.datePart && typeof setSpinner === 'function' && typed.kept && !calendarSet) datePartsTyped.push({ el, value: String(typeValue), label: a.label, part: a.datePart });
          // A BOX THAT SUGGESTS AS YOU TYPE (2026-09-24). Rippling's and Lever's
          // location boxes open a list under the text; the value only counts
          // once a row is chosen, and a list left open was read by the NEXT
          // dropdown as its own options (Rippling: race offered "Springfield, WA,
          // USA"). So a list that opened because of this typing is answered —
          // the matcher picks the row — or, when nothing fits, shut.
          let pickedRow = false;
          if (!a.datePart) {
            pickedRow = await pickSuggestion(el, String(a.value), rowsBefore, a.label, a.placeAlts);
            if (pickedRow) typed = { kept: true };
            // Then the box is left the way enterText leaves any box (review,
            // 2026-11-06): blurred, and the blur/focusout raised by hand when
            // the browser will not (a background tab, F-464/F-470), so a form
            // that commits on blur (Workday) still hears it.
            if (streetBox) {
              const wasActive = document.activeElement === el;
              try { if (wasActive) el.blur(); } catch { /* fall through */ }
              if (!wasActive || !(typeof document.hasFocus === 'function' ? document.hasFocus() : true)) {
                el.dispatchEvent(new FocusEvent('blur', { composed: true }));
                el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
              }
              await pause(120);
              if (!pickedRow) typed = { kept: kept(el.value, a.value) };
            }
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
          // A MONTH AND YEAR IN WORDS REFUSED BY A MASKED BOX (F-855).
          // Paylocity's work-history "Start Date" (Optomec, four runs,
          // 2026-10-04) would not hold "May 2026"; he typed "05/2026". Once,
          // as numbers, before saying the box wants something else.
          {
            const words = String(a.value || '').trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
            const held = typed.kept && (pickedRow || kept(el.value, a.value) || (typed.value && kept(el.value, typed.value)));
            const mi = words ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(words[1].toLowerCase().slice(0, 3)) : -1;
            if (mi >= 0 && !a.datePart && !held) {
              const num = `${String(mi + 1).padStart(2, '0')}/${words[2]}`;
              const again = enterText ? await enterText(el, num) : (setNativeValue(el, num), { kept: kept(el.value, num) });
              const digits = String(el.value || '').replace(/\D/g, '');
              const bare = String(el.value || '').replace(/[_\s]/g, '');
              if (again.kept !== false && bare === num) typed = { kept: true, value: String(el.value || num) };
            }
          }
          // A chosen suggestion is the answer, in the list's own spelling.
          // A date part is judged by setSpinner, which reads the widget's own
          // number; Workday's live box clears its text once it takes it (F-801).
          if (typed.kept && ((a.datePart && typeof setSpinner === 'function') || pickedRow || kept(el.value, a.value) || (typed.value && kept(el.value, typed.value)))) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
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
          // What the box held before the menu attempts typed into it (P2 review).
          const boxBefore = String(f?.elements?.[0]?.value ?? '');
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
          // THE LIST'S OWN "NOT LISTED" ROW, LAST (P3). Only after every one of
          // his spellings missed, only on a box holding nothing, never one he
          // touched, and named for him to check: the school or degree he has
          // is not on this list, and "Other" is what the list offers for that.
          // A name box that opens under "Other" is filled on the next pass.
          // A list that never opened, or a row the page dropped, is a page in
          // motion (F-716), not a miss: it gets its second try first, and the
          // second try (a run of its own) reaches this step if it misses again.
          const inMotion = readBack && f.promptKind === 'combo' && (!LAST_PROMPT_ROWS.length || LAST_PROMPT_PICKED);
          let notListedPick = '';
          if (!added && !inMotion && single && Array.isArray(a.notListed) && a.notListed.length && !String(f.current || '').trim()
            && !(comboValue && String(comboValue(el) || '').trim()) && !(his && his.touched(el)) && Date.now() <= until) {
            for (const w of a.notListed) {
              // eslint-disable-next-line no-await-in-loop
              if (await pickFromPrompt(el, String(w), f.promptKind, [], { rowOk: notListedRow })) { added = 1; notListedPick = String((comboValue && comboValue(el)) || w).trim(); break; }
              if (Date.now() > until) break;
            }
            if (notListedPick) console.log(`[jarvis] "${String(a.label).slice(0, 40)}": nothing on the list is "${String(wanted[0]).slice(0, 40)}" — chose "${notListedPick.slice(0, 40)}"`);
          }
          if (added) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
          if (notListedPick) unanswered.push(`${a.label} (chose "${notListedPick}": "${wanted[0]}" is not on this list — check it, and fill the name box if one opened)`);
          // One skill this employer's list does not carry is not worth telling
          // him about; none of them is.
          // WHY IT DID NOT LAND, TRUTHFULLY. A field that already holds an
          // answer is never typed over (the F-211 protection), and reporting
          // that as "nothing matched" sent me hunting a matcher bug on the
          // live Applied Materials form when the engine had done the right
          // thing — the page held "Yes" and the plan wanted something else.
          SPENT.prompts += Date.now() - promptBegan;
          const held = String(f.current || '').trim();
          let viaProps = '';
          // …unless what it holds IS the answer (Pronto's second press,
          // 2026-09-26: "left as No" where the plan wanted No) — answered.
          if (!added && held && wanted.some((w) => kept_same(held, w))) { skipped += 1; answered.push(a.label); }
          else if (!added && held) unanswered.push(`${a.label} (left as "${held}" — it already had an answer, and nothing here types over one)`);
          // ORACLE'S LIST BOX, ONE LAST WAY (P2): its own props, after the menu failed.
          else if (!added && (viaProps = await oracleDirect(a, f, wanted, a.label, boxBefore)) === 'kept') { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
          else if (!added && viaProps === 'unconfirmed') unanswered.push(`${a.label} (set through the list's own props, but not confirmed; check this field)`);
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
          // An "Other" row taken last (P3) already has its own check line.
          else if (missed.length && wanted.length === 1 && !notListedPick) unanswered.push(`${a.label} (no "${missed[0]}")`);
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
              // A PILL THAT IS DRAWN AGAIN WHEN CHOSEN (F-816). Oracle's
              // cx-select-pills re-render on a click: the button that was
              // clicked is detached, the chosen one is a NEW node, and reading
              // the old one said "not kept" while the page showed "Mr." chosen
              // (Denso, TI, Legrand: Title, Degree, three Yes/No pills). The
              // same option is looked up again, by its words, in its group.
              const group = pick.closest?.('[role="radiogroup"], [role="group"], ul, fieldset') || null;
              const words = String(pick.textContent || '').replace(/\s+/g, ' ').trim();
              const groupName = group?.getAttribute?.('aria-label') || '';
              const live = () => {
                if (pick.isConnected || !words) return pick;
                // The group itself may be drawn again: found by its own name.
                const g = group?.isConnected ? group
                  : (groupName ? [...document.querySelectorAll('[role="radiogroup"], [role="group"]')].find((n) => n.getAttribute('aria-label') === groupName) : null);
                if (!g) return pick;
                return [...g.querySelectorAll('[role="radio"], button, input[type="radio"], input[type="checkbox"]')]
                  .find((n) => String(n.textContent || n.value || '').replace(/\s+/g, ' ').trim() === words) || pick;
              };
              if (!isOn(pick)) {
                pick.click();
                await settleAria(pick);
                for (let t = 0; t < 8 && !isOn(live()); t += 1) await pause(150);
              }
              if (isOn(live())) { filled += 1; filledKeys.add(`${a.label}|${a.type}`); answered.push(a.label); }
              else {
                unanswered.push(`${a.label} (the page did not keep the choice)`);
                // Oracle's Title pill showed "Mr." chosen while this said it was
                // not, and its SMS consent flipped to "I do not agree" (Denso,
                // F-695): the pill's markup is what says how it shows a choice.
                captureAround(pick, 'choice not kept (or not readable as chosen)', a.label);
              }
            } else unanswered.push(`${a.label} (no option ${a.optionIndex})`);
          }
        } else if (a.action === 'check' || a.action === 'uncheck') {
          // A TICK IS COUNTED ONLY WHEN THE PAGE KEPT IT (F-1013 #15, review
          // 2026-11-05). A consent box disabled until the terms are scrolled, or
          // one redrawn after the click, took the click and stayed as it was,
          // and the report said "ticked". Read back like a radio choice; a box
          // the page redrew is found again by its id.
          // "uncheck": a job that ended is not "currently working here" (F-871).
          const want = a.action === 'check';
          const liveBox = (b) => (b.isConnected ? b : (b.id && document.getElementById(b.id)) || null);
          let missed = false;
          for (const box of els) {
            if (isOn(box) === want) continue;
            box.click(); await settleAria(box);
            let now = liveBox(box);
            for (let t = 0; t < 6 && now && isOn(now) !== want; t += 1) { await pause(150); now = liveBox(box); }
            if (now && isOn(now) !== want) missed = true;
            else if (want) checked += 1;
          }
          if (missed) {
            unanswered.push(`${a.label} (the page did not keep the ${want ? 'tick' : 'cleared box'} — check it yourself)`);
            captureAround(els[0], `${want ? 'tick' : 'untick'} not kept`, a.label);
          } else answered.push(a.label);
        } else if (a.action === 'upload') {
          sawUpload = true;
          // A SLOT THAT ALREADY HOLDS A FILE IS HIS (F-413). The planner reads
          // this off the page too, but a form he refilled after a timeout can
          // paint its chip between the plan and this line, and putting a
          // second copy of the same PDF onto a live application is the fault
          // that rule was written for.
          let slot = el;
          const holdsResume = (s) => (s.files && s.files.length > 0) || slotShowsFile(s, { resume: true });
          // The file it shows may be one Jarvis made for another posting (F-942).
          if (holdsResume(slot) && (await clearOtherPostingFiles()).length) {
            await pause(400);
            slot = el.isConnected ? el : (slotAgain(el) || el);
          }
          if (holdsResume(slot)) {
            skipped += 1;
            answered.push(a.label);
            uploaded = true;
          } else {
            const put = await timed('resume', () => attachResume(slot));
            if (put && put.ok === false) {
              unanswered.push(put.refused
                ? `${a.label} (the site refused the file: "${String(put.refused).slice(0, 80)}" — attach the resume yourself)`
                : `${a.label} (the page did not keep the file — attach the resume yourself)`);
            } else {
              uploaded = true;
              // Attached to the field, but the form never printed the name.
              // Said out loud rather than counted as done (F-465).
              if (put && put.showing === false) unanswered.push(`${a.label} (attached, but the page never showed the file — check it before you Submit)`);
              else attachedResume = { el: slot, name: put?.name || '', label: a.label };   // looked at again at the end of the step (F-1009)
            }
          }
        } else if (a.action === 'upload-letter') {
          // THE COVER LETTER, AS A FILE (F-410). Same rule: only into an empty
          // slot. A letter that cannot be written is said out loud rather than
          // leaving a required field silently blank.
          let slot = el;
          const holdsFile = (s) => (s.files && s.files.length > 0) || slotShowsFile(s);
          // The letter it shows may be one Jarvis wrote for another posting (F-942).
          if (holdsFile(slot) && (await clearOtherPostingFiles()).length) {
            await pause(400);
            slot = el.isConnected ? el : (slotAgain(el) || el);
          }
          if (holdsFile(slot)) {
            skipped += 1;
            answered.push(a.label);
          } else {
            try {
              await attachCoverLetter(slot);
              filled += 1;
              filledKeys.add(`${a.label}|${a.type}`);
              answered.push(a.label);
            } catch (e) {
              unanswered.push(`${a.label} (${String(e.message || e).slice(0, 70)})`);
            }
          }
        } else if (a.action === 'upload-portfolio') {
          // HIS PORTFOLIO PDF (2026-10-22). Same rule: only into an empty slot.
          if ((el.files && el.files.length > 0) || slotShowsFile(el)) {
            skipped += 1;
            answered.push(a.label);
          } else {
            try {
              await attachPortfolio(el);
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
          // AN OPTIONAL BLANK IS SHOWN, NOT COUNTED (F-803). The planner marks
          // a field the form does not require and his files do not answer as
          // `optional`; listing it as "left for you" beside the required ones
          // made Moog's Suffix read like a gap and the run like a failure.
          else if (a.optional) optionalBlank.push(a.label);
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

    // Every question this run planned is now one the tab has seen (F-925).
    try { markFieldsSeen(actions.map((a) => a.label)); } catch { /* bookkeeping only */ }

    // EVERY DATE PART, READ AGAIN ONCE THE WHOLE DATE IS IN (2026-10-26).
    // Each part was checked right after it was typed, and the year still
    // changed afterwards: Terex's start date (2026-10-26) and HP's (F-618)
    // read 2006, Brooks' 2010 — the month's digits ended up in the year box
    // while the later parts were typed. A part that no longer holds its value
    // is typed again on its own; one that still will not hold it is named.
    if (datePartsTyped.length) {
      const holdsPart = (d) => {
        const got = String(spinnerNow(d.el) || '').replace(/\D/g, '');
        const want = d.value.replace(/\D/g, '');
        return !!got && (got === want || (want.length <= 2 && Number(got) === Number(want)));
      };
      await pause(400);
      const hisPart = (d) => !!(his && his.touched(d.el));   // he corrected it meanwhile (F-1024)
      for (const d of datePartsTyped) {
        if (!d.el.isConnected || holdsPart(d) || hisPart(d)) continue;
        await setSpinner(d.el, d.value);
        await pause(250);
      }
      for (const d of datePartsTyped) {
        if (!d.el.isConnected || holdsPart(d) || hisPart(d)) continue;
        console.log(`[jarvis] ${d.label}: the ${d.part} box changed to "${spinnerNow(d.el)}" after the date was typed`);
        filled = Math.max(0, filled - 1);
        unanswered.push(`${d.label} (the ${d.part} box reads "${String(spinnerNow(d.el)).trim()}" — it should be ${d.value}; fix it before you submit)`);
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
      for (const a of r.answered || []) answered.push(a);   // entries now saved clear older runs' lines (F-900)
    }

    // WHAT WORKDAY STILL CALLS EMPTY AFTER ALL THAT (F-550). Re-entered the
    // way he does it by hand; what will not take is named for him.
    try {
      const stale = await reassertStale();
      for (const s of stale.still) unanswered.push(`${s} — the form still flags this though it holds your text; check it, or delete one letter and retype it`);
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
          if (his && his.touched(f)) continue;   // he changed or emptied it: not lost, his (F-1024)
          lost.push({ a, f });
        }
        if (lost.length) {
          console.log(`[jarvis] read back: ${lost.length} answer(s) the page did not keep — ${lost.map((x) => x.a.label).join(' | ').slice(0, 200)}`);
          const again = await fillCurrentStep(lost.map((x) => x.f), { entries: false, context: now });
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

    // THE RESUME, LOOKED AT AGAIN AT THE END OF THE STEP (F-1009). Rippling's
    // parser redrew the form after the file went on and the slot was empty,
    // while this said uploaded. A beat for the redraw, then the slot is read;
    // gone, it is attached once more; gone again, it is said, not counted.
    if (attachedResume) {
      try {
        await pause(1000);
        const k = await keepResume(attachedResume.el, attachedResume.name);
        if (!k.kept) {
          uploaded = false;
          const i = answered.indexOf(attachedResume.label);
          if (i >= 0) answered.splice(i, 1);
          unanswered.push(RESUME_DROPPED.replace(/^Resume/, attachedResume.label || 'Resume'));
        }
      } catch { /* a look, never a reason to fail the step */ }
    }

    // fieldKeys is what the step loop compares against to notice a field that
    // only appeared once an earlier answer was given.
    return { filled, checked, skipped, uploaded, sawUpload, unanswered, optionalBlank, answered, written, kept: keptList,
      // DID THIS PAGE HAVE A FORM ON IT AT ALL? Not "did we fill anything" —
      // whether there were controls here to read. The panel's green line turns
      // on this, and nothing else can stand in for it (F-443).
      readForm: fields.length > 0,
      filledKeys: [...filledKeys], fieldKeys: (restrict ? only : fields).map((f) => `${f.label}|${f.type}`),
      // A list with nothing in it yet: Honda's State is "Please Select" and a
      // blank until a Country is chosen (2026-10-02).
      starvedKeys: (restrict ? only : fields).filter((f) => f.type === 'select' && (f.options || []).filter((o) => String(o?.text ?? o).trim()).length <= 1).map((f) => `${f.label}|${f.type}`),
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
      // A file in SOME input is not the resume (F-1013 #7): the cover letter's
      // input holding its letter said "resume uploaded".
      for (const el of document.querySelectorAll('input[type="file"]')) {
        if ([...(el.files || [])].some((f) => !NOT_RESUME_FILE_RE.test(f.name || ''))) return true;
      }
      // His name, then a .pdf on the same line: matches the fixed old name
      // and the per-posting one alike ("Alex Rivera - Agility Robotics - …pdf").
      return resumeNamedIn(document.body?.innerText || '');
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
      filled, checked, holdsResume: !!(uploaded || resumeOnPage()), sawUpload, unanswered: unanswered || [], optionalBlank: args.optionalBlank || [], kept, written, readForm,
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

  /**
   * A SLOW SAVE IS NOT A REFUSAL (F-789). `settle()` returns once the page has
   * been still for 750 ms, and a Workday "Save and Continue" keeps the old
   * step on screen, unchanged, while it saves. On Terex (2026-10-22, the
   * machine busy with a scan) the walk read that second of stillness as "the
   * form stayed on this step" and stopped; My Experience painted a moment
   * later and sat unfilled for five minutes. So after the press the walk keeps
   * looking: until the step changes, the form says what it refused, or the
   * wait runs out — 8 s, stretched to 30 s while the page shows it is busy.
   * Returns true when the page is still on the step it was pressed on.
   */
  const BUSY_SEL = '[aria-busy="true"], [role="progressbar"], [data-automation-id*="loading" i], [data-automation-id*="spinner" i], [class*="spinner" i]';
  const busy = () => [...document.querySelectorAll(BUSY_SEL)].some((el) => {
    if (el.closest('#jarvis-overlay')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  async function stillOnStep(beforeClick, before, { capMs = 8000, busyCapMs = 30000 } = {}) {
    const same = () => { const s = stepSignature(); return s === beforeClick || s === before; };
    const started = Date.now();
    let waited = false;
    while (same()) {
      if (pageErrors().length) return true;
      const ms = Date.now() - started;
      if (ms >= busyCapMs || (ms >= capMs && !busy())) return true;
      waited = true;
      await pause(250);
    }
    // A step that arrived while we were waiting is let finish painting; one
    // that was already there when the first settle ended needs no second.
    if (waited) await settle();
    return false;
  }

  /**
   * The labels of the boxes the page marked aria-invalid (R4), from
   * discover.js errorsOnPage: labels only, never values; at most six, each
   * cut to 60 characters, each once.
   */
  function invalidFieldLabels() {
    let found = [];
    try { found = typeof errorsOnPage === 'function' ? errorsOnPage({ max: 40 }) : []; } catch { found = []; }
    const out = [];
    for (const e of found) {
      if (e?.how !== 'invalid') continue;
      const label = String(e.field || '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim().slice(0, 60);
      if (label && !out.includes(label)) out.push(label);
      if (out.length >= 6) break;
    }
    return out;
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
      // ADP's accommodation notice is role=alert on every page (F-840): it is
      // never why a step stalled.
      if (typeof isStandingNotice === 'function' && isStandingNotice(t)) continue;
      // …nor is a screen-reader announcement (F-815). Oracle says "You're all
      // set, Anna Maria Alex!", "The form Address form loaded" and, untranslated,
      // "apply-flow.a11y.dependency-fields-loaded" through role=alert; all
      // three were given as why the form "would not move on" (six runs).
      if (!/could not|couldn['’]t|cannot|can['’]t|not be|was not|failed|error/i.test(t)
        && /^you['’]re\s+all\s+set\b|\bform\b.{0,40}\bloaded\.?$|\bpage\s+is\s+loaded\b|^[a-z0-9_-]+(\.[a-z0-9_-]+){2,}$/i.test(t)) continue;
      if (t.length > 8 && t.length < 300) seen.add(t);
    }
    return [...seen].slice(0, 4);
  }

  /**
   * Read the newest emailed code for this page's employer and type it (his
   * consent, 2026-10-23). Asks every 4 s for up to two minutes, stops as soon
   * as the code box is gone (he typed it himself). Returns null when there is
   * no code box, { entered: true, from } when typed, { entered: false, why }.
   */
  async function enterEmailedCode() {
    if (!(otpBoxes?.() || []).length) return null;
    // AT MOST THREE CODES IN TEN MINUTES (F-905 review): a site that keeps
    // refusing them is his to look at, not a loop.
    const recent = (state.codeEntries || []).filter((t) => Date.now() - t < 10 * 60_000);
    if (recent.length >= 3) return { entered: false, why: 'three codes went in within ten minutes and the site still asks' };
    if (!state.codeSince) state.codeSince = Date.now() - 5 * 60_000;
    chip('Jarvis: reading the sign-in code from your email…');
    // Two minutes by the clock, each ask capped at 20 s; a reason that cannot
    // change by waiting (Gmail not connected, the dashboard down) ends it now.
    const deadline = Date.now() + 120_000;
    const ask = () => Promise.race([
      send({ type: 'code', pageUrl: location.href, since: state.codeSince }).catch(() => null),
      new Promise((r) => setTimeout(() => r({ code: null, why: 'the dashboard did not answer in 20 s' }), 20_000)),
    ]);
    let got = null;
    while (Date.now() < deadline) {
      got = await ask();
      if (got?.code) break;
      if (got?.why && got.why !== 'no code in his email yet' && !/did not answer/.test(got.why)) break;
      await pause(4000);
      if (!(otpBoxes?.() || []).length) { chip(''); return null; }
    }
    chip('');
    if (!got?.code) return { entered: false, why: got?.why || 'no code arrived in two minutes' };
    const boxes = otpBoxes() || [];
    if (!boxes.length) return null;   // he typed it himself meanwhile
    const code = String(got.code);
    if (boxes.length === 1) await enterText(boxes[0], code);
    else for (let i = 0; i < boxes.length && i < code.length; i += 1) await enterText(boxes[i], code[i]);
    // The code is spent: a second pass waits for a newer one.
    state.codeSince = Date.now();
    state.codeEntries = [...recent, Date.now()];
    await pause(400);
    const btn = codeConfirmControl?.(boxes);
    if (btn) btn.click();
    console.log(`[jarvis] typed the emailed code from ${got.from || 'his email'}${btn ? ` and pressed "${(btn.textContent || btn.value || '').trim()}"` : ' — no Verify button found beside it'}`);
    return { entered: true, from: got.from || '' };
  }
  /** After a code went in: once the site lets him in, fill the form in the same run. */
  async function afterCode(auto) {
    for (let i = 0; i < 40; i += 1) {
      await pause(500);
      if (!(otpBoxes?.() || []).length && !(signInWall && signInWall())) break;
    }
    if ((otpBoxes?.() || []).length || (signInWall && signInWall())) return null;
    // Bounded by enterEmailedCode's three-in-ten-minutes, so a later sign-in
    // in the same page still fills.
    if (settle) await settle();
    return run({ auto });
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
    // A LOOK, NOT A RUN (F-1002): the worker sent this to a confirmation page in
    // a tab Jarvis filled, armed or not, only to hear the thank-you. Nothing is filled.
    if (RUN.checkOnly) return { frame: location.href, filled: 0, checked: 0, uploaded: false, unanswered: [], stoppedBecause: 'looked for a confirmation: none on this page yet', auto, checkOnly: true };

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

    // THE CODE FROM HIS EMAIL GOES IN BY ITSELF (his consent, 2026-10-23:
    // "ENABLE VERIFICATION CODE EXTRACTION FROM EMAIL … I CONSENT"). A code
    // box on screen: the newest code this employer emailed is read from his
    // Gmail through the dashboard, typed, and its Verify pressed. Passwords
    // are still never typed.
    if (otpBoxes && (otpBoxes() || []).length) {
      const coded = await enterEmailedCode();
      if (coded?.entered) {
        const next = await afterCode(auto);
        if (next) return next;
        const why = `typed the code from your email${coded.from ? ` (${coded.from})` : ''} — ${RUN.armed ? 'the form fills by itself once the site lets you in' : 'click Jarvis again once the form shows'}`;
        showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: why });
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, enteredCode: true, stoppedBecause: why };
      }
      if (coded && !coded.entered) {
        const why = `the site wants the code it emailed you, and none came through (${coded.why}) — type it yourself`;
        showPanel({ filled: 0, checked: 0, uploaded: false, unanswered: [], steps: 0, waiting: true, stoppedBecause: why });
        return { frame: location.href, filled: 0, checked: 0, uploaded: false, signInRequired: true, stoppedBecause: why };
      }
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
        // ORACLE'S EMAIL-ONLY NEXT IS PRESSED FOR HIM (2026-10-23): it only
        // emails a code, and the code now comes from his Gmail by itself.
        const nextBtn = (r?.filled || 0) > 0 && oracleEmailNext ? oracleEmailNext() : null;
        if (nextBtn) {
          // Ten minutes, not thirty seconds (F-908): an Oracle tenant that sent
          // a code minutes ago sends no new one, and that code is still good.
          state.codeSince = Date.now() - 10 * 60_000;
          console.log('[jarvis] Oracle email sign-in — pressing Next for the code');
          chip('Jarvis: asking for the sign-in code…');
          nextBtn.click();
          for (let i = 0; i < 60 && !(otpBoxes?.() || []).length; i += 1) await pause(500);
          if ((otpBoxes?.() || []).length) {
            const coded = await enterEmailedCode();
            if (coded?.entered) {
              const next = await afterCode(auto);
              if (next) return next;
            }
          }
        }
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
    // EIGHTFOLD'S JOB PAGE, WITH NO APPLY TO FOLLOW (F-1017 (3), Lam 2026-10-30;
    // F-1010, Micron). Twice the press said "no form here yet" on the job page
    // and never reached the form; opening /careers/apply?pid=<id> by hand
    // worked every time. Every Eightfold tenant serves its form there, so on
    // his press, with no Apply control found, the form is opened directly.
    const atsLib = globalThis.__jarvisAts || null;
    const onEightfold = !!atsLib?.atsFor && atsLib.atsFor(location.href)?.key === 'eightfold';
    const efPid = onEightfold && !/\/careers\/apply\b/.test(location.pathname) ? String(atsLib.reqToken(location.href) || '').replace(/^eightfold:/, '') : '';
    if (efPid && !applyBtn && !auto) {
      const domain = new URLSearchParams(location.search).get('domain');
      const to = `${location.origin}/careers/apply?pid=${encodeURIComponent(efPid)}${domain ? `&domain=${encodeURIComponent(domain)}` : ''}`;
      console.log(`[jarvis] Eightfold job page with no Apply control — opening its application form (${to})`);
      await send({ type: 'following', pageUrl: location.href }).catch(() => null);
      location.assign(to);
      return { frame: location.href, filled: 0, checked: 0, uploaded: false, isPosting: true, stoppedBecause: 'opening the application form' };
    }
    // "STARTED" ONLY WHEN THIS PAGE CONFIRMED IT (F-1013 #12, review 2026-11-05).
    // RUN.started arrives from the tab and is corrected above only when the
    // page's posting was read AND the server answered. A posting it could not
    // read, or one the server refused (the unreadable-title 404 among them),
    // left the PREVIOUS posting's "started" standing, and on a site with no
    // requisition token an armed tab moved to job B pressed Apply on B as A.
    const startedHere = !!(posted?.ok && typeof posted.started === 'boolean' && posted.started);
    const mayFollow = !auto || (startedHere && !state.followedApply);
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
      // …and an Apply that SAYS it opens a menu gets its item chosen even when
      // the posting has other fields on it (F-884): Schindler's posting carried
      // a chat widget's boxes, the "no fields" test failed, the menu's "Apply
      // Now" was never chosen, and the walk filled the posting instead.
      const opensMenu = applyBtn.getAttribute?.('aria-haspopup') === 'true' || /dropdown/i.test(String(applyBtn.getAttribute?.('data-toggle') || ''));
      if ((!discover().length || opensMenu) && !(startGate && startGate())) {
        const items = (deepQuerySelectorAll ? deepQuerySelectorAll('[role="menu"] a, [role="menu"] button, .dropdown-menu a, .dropdown-menu button, [role="menuitem"]') : [])
          // A help link beside the item is "javascript:alert(…)" — a dialog
          // would freeze the run. Never a script URL.
          .filter((a) => !/^\s*javascript:/i.test(String(a.getAttribute?.('href') || '')))
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
    SPENT.answers = 0; SPENT.resume = 0; SPENT.prompts = 0; SPENT.entries = 0; SPENT.discover = 0; SPENT.plan = 0; SPENT.waits = 0; SPENT.sites = {};
    let uploaded = false;
    let sawUpload = false;
    let filled = 0;
    let checked = 0;
    let skipped = 0;
    /** Every label answered anywhere in this walk (F-399). */
    const answeredAll = [];
    const unanswered = [];
    const unansweredSeen = new Set();
    /** Optional fields left blank across the walk (F-803): shown, not counted. */
    const optionalAll = [];
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
    let salaryRetried = false;
    let refillOnly = false;   // F-888: a remembered step a reload emptied — fill, never advance

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
      // …UNLESS A RELOAD EMPTIED IT (F-888). Accepting Ford's cookie banner
      // reloaded the Oracle email step (2026-10-23): the tab remembered the
      // step as filled, every box on it was now blank, and nothing filled it
      // again. A remembered step with nothing in any of its boxes holds
      // nothing of his to review.
      const emptied = () => {
        const boxes = allControls().filter((el) => onScreen(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
          && !/^(hidden|checkbox|radio|file|submit|button|image|reset)$/i.test(el.type || ''));
        return boxes.length > 0 && boxes.every((el) => !String(el.value ?? '').trim());
      };
      // Filled again, but never advanced: Back to a step can redraw it blank
      // too, and pressing Next for him there is the Western Digital fault.
      if (auto && step === 1 && handledCoarse.has(coarse(before)) && emptied()) refillOnly = true;
      if (auto && step === 1 && handledCoarse.has(coarse(before)) && !refillOnly) {
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
        const extra = await fillCurrentStep(revealed, { keepExisting: auto, entries: false, readBack: true, context: discover() });
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
      for (const o of r.optionalBlank || []) if (o && !optionalAll.includes(o)) optionalAll.push(o);
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

      if (refillOnly) {
        stoppedBecause = 'a step Jarvis already filled came back empty (a reload) — filled again; the next press is yours';
        break;
      }
      const next = nextControl();
      if (!next) {
        // Say WHICH kind of stop this is. "There is no way on" and "the only way
        // on submits the form" look identical from outside, and the second one is
        // the rule working rather than a fault.
        const blocked = advanceBlockedBy && advanceBlockedBy();
        // ORACLE'S EMAIL-ONLY NEXT, PRESSED FOR HIM (2026-10-23): it only
        // emails a code, and the code now comes from his Gmail by itself.
        const emailNext = blocked && /asks for your email first/.test(blocked) && oracleEmailNext ? oracleEmailNext() : null;
        if (emailNext && !state.pressedEmailNext) {
          state.pressedEmailNext = true;
          state.codeSince = Date.now() - 10 * 60_000;   // see F-908 above
          console.log('[jarvis] Oracle email sign-in — pressing Next for the code');
          chip('Jarvis: asking for the sign-in code…');
          emailNext.click();
          for (let i = 0; i < 60 && !(otpBoxes?.() || []).length; i += 1) await pause(500);
          const coded = await enterEmailedCode();
          if (coded?.entered) {
            const after = await afterCode(auto);
            if (after) return after;
          }
          stoppedBecause = coded?.entered
            ? 'typed the code from your email — the form fills by itself once the site lets you in'
            : coded ? `pressed Next; the code did not come through (${coded.why}) — type it yourself` : 'pressed Next for the sign-in code';
          break;
        }
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
      // Pressed where it is (P4): a click needs no scroll, and scrolling to
      // Next moved the page he was reading on every step.
      next.click();
      await settle();

      let stuck = await stillOnStep(beforeClick, before);
      // A REFUSED SIGNATURE DATE IS RETRIED ONCE with the other today (F-732),
      // then the same button pressed again — the press he already made.
      if (stuck && !dateRetried && /\bdate\b[^·]{0,80}\b(required|today)/i.test(pageErrors().join(' · '))) {
        dateRetried = true;
        if (await retrySignatureDate()) {
          (nextControl() || next).click();
          await settle();
          stuck = await stillOnStep(beforeClick, before);
        }
      }
      // …and a refused SALARY is retyped as its number, once (ADP, 2026-10-17).
      if (stuck && !salaryRetried && /\b(salary|compensation|pay|wage)\b[^·]{0,40}\b(invalid|numeric|number|digits?)\b|\binvalid\b[^·]{0,40}\b(salary|compensation|pay|wage)\b/i.test(pageErrors().join(' · '))) {
        salaryRetried = true;
        if (await retrySalaryDigits()) {
          (nextControl() || next).click();
          await settle();
          stuck = await stillOnStep(beforeClick, before);
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
        // WHICH BOXES THE SITE REFUSED (R4, 2026-11-07): the fields it marked
        // invalid, by their labels only — never what is in them — so he knows
        // where to look without reading the whole step again.
        const invalid = invalidFieldLabels();
        if (invalid.length) stoppedBecause += ` — the site marked these invalid: ${invalid.join(' · ')}`;
        break;
      }
      if (step === MAX_STEPS) stoppedBecause = `stopped after ${MAX_STEPS} steps`;
    }

    console.log(`[jarvis] done: ${filled} filled, ${checked} ticked, resume ${uploaded ? 'ATTACHED' : 'not attached'} across ${steps.length} step(s)`);
    // WHERE THE TIME WENT (F-465). Printed on every run, so the next long form
    // that feels slow names its own bottleneck instead of being guessed at.
    {
      const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
      console.log(`[jarvis] time: ${secs(Date.now() - SPENT.began)} total — reading ${secs(SPENT.discover)}, plan ${secs(SPENT.plan)}, answers ${secs(SPENT.answers)}, resume ${secs(SPENT.resume)}, dropdowns ${secs(SPENT.prompts)}, experience/education ${secs(SPENT.entries)}, fixed waits ${secs(SPENT.waits)}${document.visibilityState === 'hidden' ? ' (tab was hidden)' : ''}`);
    }
    const timings = runTimings();
    if (unanswered.length) console.log('[jarvis] left for you:', unanswered);
    console.log(`[jarvis] stopped because: ${stoppedBecause}`);
    console.log('[jarvis] Submit is yours. Nothing here presses it.');
    // A follow-along run that found nothing to do says nothing. The panel from
    // the run that did the work is the one he is reading, and replacing it
    // with "0 filled" every time the page twitches is how a working tool
    // comes to look broken.
    const didSomething = filled > 0 || checked > 0 || uploaded || unanswered.length > 0;
    if (!auto || didSomething) {
      showPanel({ filled, checked, uploaded, sawUpload, unanswered, optionalBlank: optionalAll.filter((o) => !answeredAll.includes(o)), kept: keptAll, written: writtenAll, readForm, steps: steps.length, stoppedBecause, resumeNote, staleExtension, appliedBefore, timings });
    } else chip('');
    // `where` names the page AND the step on it. An SPA whose steps share one
    // URL (Eightfold) would otherwise look like the same page to the worker's
    // quiet-run hold (F-379), and the step after three quiet runs would never
    // be filled.
    return { frame: location.href, filled, checked, skipped, uploaded: uploaded || resumeOnPage(), unanswered, optionalBlank: optionalAll.filter((o) => !answeredAll.includes(o)), answered: answeredAll, kept: keptAll, written: writtenAll, readForm, steps: steps.length, stoppedBecause, sawForm: true, timings, where: `${location.href}##${(stepSignature && stepSignature()) || ''}`.slice(0, 400), auto };
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
      await send({ type: 'filled', result: { ...result, pageUrl: location.href, startedOn, resumeNote: result && !result.uploaded ? (resumeOpenerSaw?.() || '') : '' } }).catch(() => null);
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
  globalThis.__jarvisContent = { again, run: runOnce, watch, stopWatching, stopFollowing, state, chip, RUN, loadId: RUN.loadId, captureOracleEntries };
  // THE WORKER STARTS THE COPY ALREADY HERE (S2, 2026-11-07) instead of sending
  // all four files again: exactly what this file's own top does when it arrives
  // a second time — the context the worker just set, the run's claim on the
  // page — and then the same hand-over to `again`. The worker passes the run's
  // context in (review): two presses close together can never swap tokens
  // through the shared `__jarvisRun`.
  globalThis.__jarvisResumeRun = (given) => {
    if (given && typeof given === 'object') globalThis.__jarvisRun = given;
    const ctx = Object.assign({ armed: false, auto: false, started: false, id: null }, (given && typeof given === 'object' ? given : globalThis.__jarvisRun) || {});
    ctx.startedArmed = !!ctx.armed;
    if (ctx.runToken) globalThis.__jarvisActiveRun = ctx.runToken;
    return again(ctx);
  };

  // STAYING SIGNED IN (his call, 2026-10-23: "staying logged in is fine,
  // opening it again is probably where I draw the line"). Every 15 s for four
  // hours after Jarvis first ran here: a "your session is about to expire"
  // dialog gets its own Continue, at most once a minute. A form that already
  // closed is never reopened, and nothing inside a human check is touched.
  if (!globalThis.__jarvisKeepAlive) {
    const since = Date.now();
    let pressedAt = 0;
    globalThis.__jarvisKeepAlive = setInterval(() => {
      if (Date.now() - since > 4 * 3600_000) { clearInterval(globalThis.__jarvisKeepAlive); return; }
      if (Date.now() - pressedAt < 60_000) return;
      let b = null;
      try { b = sessionStayControl && sessionStayControl(); } catch { /* a check, never a crash */ }
      if (!b) return;
      pressedAt = Date.now();
      console.log(`[jarvis] the site asked whether you are still there — pressing its "${(b.textContent || b.value || '').trim()}"`);
      b.click();
    }, 15_000);
  }

  const first = runOnce({ auto: !!RUN.auto });
  first.finally(() => { if (RUN.armed) watch(); });
  return first;
})();
