// PAGES THE TEST HARNESSES DRIVE THROUGH HIS LIVE DASHBOARD (F-1029).
//
// The extension may reach only localhost:4300, and his dashboard holds that
// port, so jarvis/extension/loaded.test.mjs fills its fixture pages through the
// live server. Every run wrote plans and reports into his answer log and
// plans.jsonl: 694 + 8 lines by 2026-11-07. F-631 already dropped pages served
// from this machine; the test's direct plan call names a Greenhouse address
// instead, and 106 of those counted toward Greenhouse's fill rates.
//
// The tests take their fixture addresses FROM HERE, so the log writers and the
// prune (answer-log.mjs --prune-harness) know exactly the pages the tests use.

/** The posting address loaded.test asks the live server to plan for. */
export const HARNESS_PLAN_URL = 'https://boards.greenhouse.io/x/jobs/1';
/** Every non-local address a harness sends to the live server. */
export const HARNESS_URLS = [HARNESS_PLAN_URL];
/** No application lives on this machine: a page the dashboard (or a test server) serves itself (F-631). */
export const LOCAL_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i;

/** Is this page a harness's, never his? */
export function isHarnessPage(url) {
  const s = String(url || '');
  if (LOCAL_PAGE.test(s)) return true;
  return HARNESS_URLS.some((h) => s === h || s.startsWith(`${h}?`) || s.startsWith(`${h}#`) || s.startsWith(`${h}/`));
}
