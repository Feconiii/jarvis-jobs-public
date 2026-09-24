/**
 * Jarvis Apply — what is known about each applicant-tracking system.
 *
 * One table, loaded by BOTH the service worker (importScripts) and the page
 * (injected before discover.js). It exists so that "which ATS is this", "which
 * posting is this URL about" and "what does a sent application look like" are
 * answered the same way in both places. Two copies of this knowledge is how
 * F-14, F-74 and F-77 happened.
 *
 * Shaped after Simplify Copilot's remote config (57 ATSes; the URL patterns,
 * requisition-id extractors and submitted-page detectors in there are the
 * distilled experience of a product used on millions of applications), reduced
 * to the systems he actually meets and to the three facts this extension
 * needs. Nothing here fills a field: field knowledge lives in the repo.
 *
 * Every entry:
 *   host     which hostnames belong to the ATS (company-hosted tenants are
 *            recognised by URL shape instead, see `atsFor`)
 *   token    the posting's own id, read from a URL. Two pages with DIFFERENT
 *            tokens are two different jobs, whatever else they share — the
 *            worker uses this to drop a tab's application when he pastes a
 *            different posting into it, and discover.js uses it to refuse a
 *            JSON-LD posting that describes a different job than the page.
 *   submit   the control that SENDS the application on this ATS. Never
 *            clicked, whatever it is labelled — belt and braces over the text
 *            and type checks in discover.js.
 *   next     the control that moves to the next step, where the ATS names it
 *            stably. Tried before the generic text match.
 *   apply    the Apply control on a posting page, where the ATS names it.
 */
(() => {
  const q = (u, k) => u.searchParams.get(k) || '';

  const ATS = [
    {
      key: 'workday',
      host: /\.myworkday(?:jobs|site)\.com$/i,
      // /en-US/<site>/job/<location>/<Title>_R123456[/apply/...]. The id sits in
      // the segment after /job/ (one or two segments in), tagged with an
      // underscore and a requisition number. Simplify's extractor takes the
      // same segment.
      token: (u) => {
        const m = u.pathname.match(/\/job\/(?:[^/]+\/)?([^/]*_[A-Za-z]*-?\d{3,}[^/]*)(?:\/|$)/);
        return m ? `workday:${m[1]}` : null;
      },
      // Workday's Submit is the same footer button as Next, told apart by
      // its text — discover.js's FINAL_RE does that; no selector can.
      next: '[data-automation-id="pageFooterNextButton"], [data-automation-id="bottom-navigation-next-button"]',
      apply: '[data-automation-id="adventureButton"], [data-uxi-element-id="Apply_adventureButton"]',
    },
    {
      key: 'greenhouse',
      host: /(?:^|\.)greenhouse\.io$/i,
      token: (u) => {
        const m = u.pathname.match(/\/jobs\/(\d+)/) || u.search.match(/[?&](?:gh_jid|token)=(\d+)/);
        return m ? `greenhouse:${m[1]}` : null;
      },
      // Company sites embed the board; the job id travels as ?gh_jid=.
      embedded: (u) => /[?&]gh_jid=\d+/.test(u.search),
      submit: '#submit_app, input[type="submit"][data-trackingid="job-application-submit"], button.submit-step',
      apply: 'a[href*="#app"], a.postings-btn',
    },
    {
      key: 'lever',
      host: /^jobs(?:\.eu)?\.lever\.co$/i,
      token: (u) => { const m = u.pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i); return m ? `lever:${m[1].toLowerCase()}` : null; },
      submit: '#btn-submit',
      apply: 'a[data-qa="show-page-apply"], a.template-btn-submit[href*="/apply"]',
    },
    {
      key: 'ashby',
      host: /^jobs\.ashbyhq\.com$/i,
      token: (u) => {
        const m = u.pathname.match(/^\/[^/]+\/([0-9a-f-]{36})/i) || u.search.match(/[?&]ashby_jid=([0-9a-f-]{36})/i);
        return m ? `ashby:${m[1].toLowerCase()}` : null;
      },
      embedded: (u) => /[?&]ashby_jid=/.test(u.search),
      submit: 'button.ashby-application-form-submit-button',
      apply: 'a[href$="/application"]',
    },
    {
      key: 'eightfold',
      host: /\.eightfold\.ai$/i,
      // Most tenants serve Eightfold from their own host — careers.lamresearch.com,
      // careers.appliedmaterials.com — with the same /careers/job|apply paths
      // and a ?domain= that names the tenant. Measured live 2026-09-03: Lam's
      // and Applied's postings carried no token, so two URLs for one job were
      // two jobs to the store and the Resumes tab could not name the id.
      shape: (u) => /^\/careers\/(?:job\/\d{6,}|apply)(?:[/?#-]|$)/.test(u.pathname + u.search) && (u.searchParams.has('domain') || u.searchParams.has('pid') || /^\/careers\/job\/\d{6,}/.test(u.pathname)),
      // ?pid= on the older URLs; /careers/job/<id>-slug on the newer ones
      // (Boston Scientific, Eaton, measured live) — the same id either way.
      token: (u) => { const pid = q(u, 'pid') || (u.pathname.match(/\/careers\/job\/(\d+)/) || [])[1]; return pid ? `eightfold:${pid}` : null; },
      submit: '[data-test-id="submitApplicationButton"]',
      apply: '[data-test-id="apply-button"], a[href*="/careers/apply"]',
    },
    {
      key: 'icims',
      host: /\.(?:icims|jibeapply)\.com$/i,
      token: (u) => { const m = u.pathname.match(/\/jobs\/(\d+)(?:\/|$)/); return m ? `icims:${m[1]}` : null; },
      // iCIMS moves between pages with input[type=submit] "Next" — that press
      // is his (a submit control is never clicked), and the armed tab fills
      // the page it lands on.
      submit: 'input[type="submit"][value="Submit" i], button[type="submit"]',
      apply: 'a.iCIMS_ApplyOnlineButton',
    },
    {
      key: 'smartrecruiters',
      host: /^jobs\.smartrecruiters\.com$/i,
      // /Bosch/743999999999999-manufacturing-engineer: the id leads the slug.
      // The posting carries a numeric id; the apply form (/oneclick-ui/…/
      // publication/<uuid>) carries a uuid for the SAME job. They are two kinds
      // of token, and a worker comparing them across the Apply click read
      // every SmartRecruiters application as "a different posting" (F-338).
      token: (u) => { const m = u.pathname.match(/\/(\d{9,})(?:-|\/|$)|\/oneclick-ui\/company\/[^/]+\/[^/]+\/([^/?#]+)/); return m ? (m[1] ? `smartrecruiters:${m[1]}` : `smartrecruiters-publication:${m[2]}`) : null; },
      submit: 'oc-button[data-test="footer-submit"]',
      next: 'oc-button[data-test="footer-next"]',
      apply: 'a.js-oneclick[href*="/oneclick-ui/"]',
    },
    {
      key: 'successfactors',
      host: /\.(?:successfactors|sapsf)\.(?:com|eu)$|\.ns2cloud\.com$/i,
      token: (u) => {
        const id = q(u, 'jobReqId') || q(u, 'job_req_id') || (u.pathname.match(/\/(\d{4,})\/?$/) || [])[1];
        return id ? `successfactors:${id}` : null;
      },
      submit: 'span[role="button"][id*="submitBtn"], button[name="fbja_apply"][type="submit"]',
      next: 'span[role="button"][id*="nextBtn"]',
      apply: '#applyButton_top, #applyButton_bottom',
    },
    {
      key: 'taleo',
      host: /\.taleo\.net$/i,
      token: (u) => { const id = q(u, 'job'); return id ? `taleo:${id}` : null; },
      submit: 'input[type="button"][id*="submitCmd"]',
      next: 'input[type="button"][value*="Save and Continue" i], input[type="button"][value="Next" i]',
    },
    {
      key: 'oracle',
      host: /\.oraclecloud\.com$/i,
      shape: (u) => /\/CandidateExperience\//i.test(u.pathname),
      token: (u) => { const m = u.pathname.match(/\/(?:job|preview)\/(\d+)(?:\/|$)/); return m ? `oracle:${m[1]}` : null; },
      // Oracle's Submit and Next are the same footer button, told apart by text.
      next: 'footer.apply-flow-pagination button',
      apply: 'button.apply-now-button',
    },
    {
      key: 'jobvite',
      host: /^jobs\.jobvite\.com$/i,
      token: (u) => { const m = u.pathname.match(/\/job\/([A-Za-z0-9]+)/); return m ? `jobvite:${m[1]}` : null; },
      submit: 'button[aria-label="Send Application"]',
      next: 'button[aria-label="Next"]',
      apply: 'a.jv-button-apply:not(.apply-later)',
    },
    {
      key: 'workable',
      host: /^(?:apply|jobs)\.workable\.com$/i,
      token: (u) => { const m = u.pathname.match(/\/(?:j|jobs)\/([A-Za-z0-9]+)/); return m ? `workable:${m[1]}` : null; },
      submit: 'button[data-ui="apply-button"]',
      apply: 'a[data-ui="apply-button"]',
    },
    {
      key: 'ukg',
      host: /\.(?:ultipro\.(?:com|ca)|rec\.pro\.ukg\.net)$/i,
      token: (u) => { const id = q(u, 'opportunityId'); return id ? `ukg:${id}` : null; },
      submit: 'input[type="submit"][value="Submit Application" i], ukg-button[data-automation="btn-submit"]',
      next: 'ukg-button[data-automation="btn-next"]',
    },
    {
      key: 'adp',
      host: /\.adp\.com$/i,
      token: (u) => { const id = q(u, 'jobId') || q(u, 'reqId'); return id ? `adp:${id}` : null; },
    },
    {
      key: 'amazon',
      host: /\.amazon\.jobs$/i,
      token: (u) => { const m = u.pathname.match(/\/jobs\/(\d+)/); return m ? `amazon:${m[1]}` : null; },
      apply: '#apply-button',
    },
    {
      key: 'apple',
      host: /^jobs\.apple\.com$/i,
      token: (u) => { const m = u.pathname.match(/\/(?:details|apply)\/(\d+)/); return m ? `apple:${m[1]}` : null; },
      submit: '#applyReviewSubmit',
    },
    {
      key: 'avature',
      host: /\.avature\.net$/i,
      token: (u) => { const id = q(u, 'jobId') || q(u, 'folderId'); return id ? `avature:${id}` : null; },
      // Avature's Next and Submit are both button[name=save][type=submit],
      // told apart by text — and both are submit controls, so neither is
      // clicked; the armed tab fills each page he moves to.
      apply: 'a[href*="ApplicationMethods"], a[href*="ApplyRegister"]',
    },
    {
      key: 'brassring',
      host: /\.brassring\.com$/i,
      token: (u) => { const m = (u.hash + u.search).match(/jobDetails=(\d+)/i) || u.search.match(/[?&]jobid=(\d+)/i); return m ? `brassring:${m[1]}` : null; },
      submit: 'button[type="button"]#save',
      next: 'button[type="button"]#next',
      apply: '#applyFromDetailBtn',
    },
    {
      key: 'rippling',
      host: /(?:^|\.)(?:rippling-ats\.com|ats\.rippling\.com)$/i,
      token: (u) => { const m = u.pathname.match(/\/(?:job|jobs)\/([A-Za-z0-9-]+)/); return m ? `rippling:${m[1]}` : null; },
    },
    {
      key: 'bamboohr',
      host: /\.bamboohr\.com$/i,
      token: (u) => { const m = u.pathname.match(/\/(?:careers|jobs)\/(?:view\.php\?id=)?(\d+)/) || u.search.match(/[?&]id=(\d+)/); return m ? `bamboohr:${m[1]}` : null; },
    },
  ];

  /** Which ATS a URL belongs to, by host, or by URL shape for company-hosted tenants. */
  function atsFor(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    for (const a of ATS) {
      if (a.host.test(u.hostname)) return a;
    }
    for (const a of ATS) {
      if (a.shape && a.shape(u)) return a;
      if (a.embedded && a.embedded(u)) return a;
    }
    return null;
  }

  /**
   * The posting's own id, read from a URL — `null` when the URL carries none.
   *
   * Only ever compared for INEQUALITY: two tokens that differ are two jobs.
   * A missing token proves nothing, so a page without one never drops an
   * application on its own.
   */
  function reqToken(url) {
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    const a = atsFor(u.href);
    if (a?.token) {
      try { const t = a.token(u); if (t) return t; } catch { /* not this shape */ }
    }
    // Company-hosted boards that carry a known ATS's id in the query string.
    const gh = u.search.match(/[?&]gh_jid=(\d+)/);
    if (gh) return `greenhouse:${gh[1]}`;
    const ab = u.search.match(/[?&]ashby_jid=([0-9a-f-]{36})/i);
    if (ab) return `ashby:${ab[1].toLowerCase()}`;
    return null;
  }

  /** Is this a host that belongs to an ATS at all? */
  const isAtsHost = (url) => !!atsFor(url);

  /**
   * Identity providers. The worker never injects on these: signing in is his,
   * the page has nothing to fill, and a filler that so much as reads a Google
   * sign-in page is a filler that should not exist.
   */
  const IDP_RE = /(?:^|\.)(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|appleid\.apple\.com|auth0\.com|okta\.com|oktapreview\.com|onelogin\.com|pingidentity\.com|duosecurity\.com|linkedin\.com\/(?:oauth|uas|checkpoint)|facebook\.com\/(?:login|dialog))(?:\/|$)/i;
  const isIdp = (url) => {
    try { const u = new URL(String(url)); return IDP_RE.test(`${u.hostname}${u.pathname}`); } catch { return false; }
  };

  /**
   * What a SENT application looks like, in words. The phrases are the union
   * of what Simplify recognises across 54 ATSes and what this project has
   * met itself. Used only on a page with no form controls.
   */
  // Not "thank you for your interest": every careers page says that. And no
  // phrase here is trusted on a page that still offers Apply or Submit — see
  // discover.js applicationDone, which asks that before asking this.
  const SUBMITTED_RE = /thank(?:s| you) for (?:applying|your application|submitting)|application (?:has been |was )(?:submitted|received|sent|completed|successful)|(?:successfully|you have) (?:submitted|applied)|we (?:have |'ve )?(?:got|received) your application|application (?:submitted|sent|complete|received)\b|your application (?:has been|was) (?:sent|received)/i;

  /** Confirmation pages an ATS sends to after Submit, by URL. */
  const CONFIRMATION_URL_RE = /\/(?:confirmation|applyConfirmation|SuccessfulRegistration|thank-?you|application-?(?:complete|submitted|received))(?:\/|\?|$)/i;

  /**
   * Frames that are furniture, never the application: CAPTCHA widgets,
   * embedded video, ad and analytics pixels. Every Eightfold page carries an
   * invisible reCAPTCHA iframe, and it answers the worker first because it
   * is tiny — on Lam and Micron its report claimed the tab's page URL and
   * "this page is not a multi-step application" before the real page had
   * even pressed Apply. A widget frame can never be where the application is.
   */
  const WIDGET_RE = /(?:^|\.)(?:recaptcha\.net|google\.com\/recaptcha|gstatic\.com|hcaptcha\.com|challenges\.cloudflare\.com|youtube(?:-nocookie)?\.com|vimeo\.com|doubleclick\.net|googletagmanager\.com|google-analytics\.com|facebook\.com\/(?:plugins|tr)|linkedin\.com\/px|bing\.com\/(?:bat|ms)|hotjar\.com|fullstory\.com|intercom\.io|zendesk\.com|cookiebot\.com|onetrust\.com|trustarc\.com)(?:\/|$)/i;
  const isWidget = (url) => {
    try { const u = new URL(String(url)); return WIDGET_RE.test(`${u.hostname}${u.pathname}`); } catch { return false; }
  };

  globalThis.__jarvisAts = { ATS, atsFor, reqToken, isAtsHost, isIdp, IDP_RE, isWidget, WIDGET_RE, SUBMITTED_RE, CONFIRMATION_URL_RE };
})();
