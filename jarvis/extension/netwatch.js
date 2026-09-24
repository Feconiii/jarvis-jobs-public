/**
 * Jarvis Apply — watching the requests the FORM makes.
 *
 * WHY THIS EXISTS. When a step will not advance, the page usually says why, and
 * F-144 made us read its words back. But not always: a live GlobalFoundries
 * Workday step refused to move and said only
 *
 *     Error-Page Error- Error Code: VPS|dc492c63-3685-488d-97bc-5d1143c05a63
 *
 * which means nothing to anyone. The real answer was a failed background request
 * the page never surfaced, and nothing in this extension could see it. "The form
 * stayed on this step" is a much weaker report than "the form stayed on this
 * step, and POST /apply/step2 came back 422".
 *
 * THE MAIN WORLD, AND WHY IT IS NECESSARY. A content script runs in an isolated
 * world with its own `fetch` and its own `XMLHttpRequest`; patching those there
 * would watch nothing, because the page uses its own. This file is injected with
 * `world: 'MAIN'` so it wraps the ones the application actually calls. That is
 * extension-privileged injection, so the page's own Content-Security-Policy does
 * not block it — which matters, because Workday and Ashby both ship a CSP that
 * forbids inline script.
 *
 * WHAT IT RECORDS, AND WHAT IT DELIBERATELY DOES NOT. Method, path and status
 * for FAILED requests only. Never a request body, never a response body, never a
 * header, never a query string — those carry his answers and the site's tokens,
 * and this is a diagnostic, not a wiretap. The result is a short list of
 * "POST /some/path -> 422" lines with a hard cap.
 *
 * It hands them over through a DOM attribute, which is the one thing both worlds
 * can see.
 */
(() => {
  if (window.__jarvisNetwatch) return;    // injected once per page, not per step
  window.__jarvisNetwatch = true;

  const MAX = 12;
  const seen = [];

  /**
   * Path only, and not even all of it.
   *
   * Dropping the query string was right and not enough: a PATH carries the same
   * class of thing. Measured by attacking this function —
   *
   *   /api/candidate/applicant@…/profile        the email, recorded verbatim
   *   /session/eyJhbGciOiJIUzI1NiJ9.TOKEN.sig/next  a session token, verbatim
   *
   * and those lines travel: stoppedBecause -> the apply record -> the dashboard
   * -> the backup, which warns about carrying personal data for exactly this
   * reason. The module promised "never the site's tokens" and kept only half of
   * it.
   *
   * Segments that look like a secret are replaced, and the SHAPE is kept because
   * the shape is the diagnostic — "/api/candidate/…/profile -> 403" says what
   * failed just as well as the raw path did.
   */
  const SAFE_SEG = /^[a-z0-9][a-z0-9._-]{0,23}$/i;
  const tidyPath = (pathname) => String(pathname).split('/')
    .map((seg) => (!seg || SAFE_SEG.test(seg)) && !seg.includes('@') ? seg : '…')
    .join('/');
  const tidy = (url) => {
    try {
      const u = new URL(String(url), location.href);
      return (u.origin === location.origin ? '' : u.host) + tidyPath(u.pathname);
    } catch { return tidyPath(String(url).split('?')[0]).slice(0, 120); }
  };

  const record = (method, url, status) => {
    if (status >= 200 && status < 400) return;
    // A cancelled request is not a failure worth reporting.
    if (status === 0) return;
    const line = `${String(method || 'GET').toUpperCase()} ${tidy(url)} -> ${status}`;
    if (seen.includes(line)) return;
    seen.push(line);
    if (seen.length > MAX) seen.shift();
    try {
      document.documentElement.dataset.jarvisNet = JSON.stringify(seen);
    } catch { /* a page that forbids dataset writes still gets filled */ }
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      const url = (args[0] && args[0].url) || args[0];
      return origFetch.apply(this, args).then((res) => {
        record(method, url, res.status);
        return res;
      }).catch((e) => {
        // A network-level failure has no status; say so rather than inventing one.
        record(method, url, 'network error');
        throw e;
      });
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__jarvisReq = { method, url };
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      this.addEventListener('loadend', () => {
        const r = this.__jarvisReq || {};
        record(r.method, r.url, this.status);
      });
      return send.apply(this, args);
    };
  }
})();
