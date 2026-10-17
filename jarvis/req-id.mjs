// jarvis/req-id.mjs — one rule for "which requisition is this URL".
//
// WHY ITS OWN FILE (F-449). Two modules grew their own version of this within
// an hour of each other:
//
//   assist-liveness.reqIdOf      /[-/_](\d{2,})(?:[/?#].*)?$/   — tolerates a trailing segment
//   import-descriptions.resolveReqId   /[-/_]${req}$/           — did not
//
// So the same Joby posting, `https://careers-jobyaviation.icims.com/jobs/3726/job`,
// was requisition 3726 to the liveness sweep and unidentifiable to the
// importer. Nothing crashed; the harvest would simply have written nothing and
// reported every row as unmatched, which reads exactly like an empty board.
//
// That is F-445 again — one concept, copied, drifting — caught this time
// before it cost anything, because the two were written close enough together
// to compare. The rule lives here now and both import it.

/**
 * The requisition id a posting URL carries, or '' when it carries none.
 *
 * Deliberately conservative about what counts:
 *
 * - at least two digits, because `/job/7` is a page number or a step index far
 *   more often than a requisition;
 * - preceded by `-`, `/` or `_`, so `.../role1880002` is not read as req
 *   880002 — a suffix match on digits alone will happily identify the wrong
 *   posting, and writing one job's description onto another's row is the
 *   worst outcome available here;
 * - optionally followed by one more path segment, a query or a fragment,
 *   because plenty of boards end the URL with `/job` (iCIMS) rather than the
 *   number (Tesla, Greenhouse);
 * - optionally prefixed by up to three UPPERCASE letters, because Workday
 *   requisitions are `R7540` and `JR2020552`, not bare numbers. Symbotic's
 *   whole board was invisible to this for that reason — every row keyed as
 *   "no requisition", which fails safe but does nothing.
 *
 * The case-sensitivity is load-bearing, not decoration. `/careers/role1880002`
 * must still yield nothing: lowercase letters running into digits are a slug,
 * and reading a requisition out of one is how a matcher writes one posting's
 * description onto another posting's row.
 */
export function reqIdOf(url) {
  const m = String(url || '').match(/[-/_]([A-Z]{0,3}\d{2,})(?:[/?#][^?#]*)?(?:[?#].*)?$/);
  return m ? m[1] : '';
}

/** Does this URL name exactly this requisition? */
export function urlHasReqId(url, reqId) {
  const req = String(reqId || '');
  if (!/^[A-Z]{0,3}\d{2,}$/.test(req)) return false;
  return reqIdOf(url) === req;
}

/**
 * Multi-tenant ATS domains whose HOSTNAME names the employer, and whose job
 * numbers are counted per employer from 1.
 */
const TENANT_HOST_RE = /(?:^|\.)(oraclecloud\.com|taleo\.net|icims\.com|myworkdayjobs\.com|bamboohr\.com|applicantpro\.com|avature\.net|pageuppeople\.com|eightfold\.ai|zohorecruit\.com|jobs\.personio\.de)$/i;

/**
 * ARE TWO URLS ON DIFFERENT EMPLOYERS' SITES OF THE SAME ATS? (F-714)
 *
 * Oracle numbers each employer's postings from 1, so "job 1246" is Legrand's
 * Manufacturing Engineer on iadugs.fa.ocs.oraclecloud.com and Darling
 * Ingredients' Fleet Mechanic 2 on ekgz.fa.us6.oraclecloud.com — and the panel
 * showed the second on the first's form (2026-10-06). The same requisition
 * number on two tenants of one ATS is two postings. A company's own domain
 * fronting the ATS is not a tenant host, so it is never ruled out here.
 */
export function crossTenant(a, b) {
  let ha;
  let hb;
  try { ha = new URL(String(a)).hostname.toLowerCase(); hb = new URL(String(b)).hostname.toLowerCase(); } catch { return false; }
  if (ha === hb) return false;
  const da = ha.match(TENANT_HOST_RE)?.[1]?.toLowerCase();
  return !!da && da === hb.match(TENANT_HOST_RE)?.[1]?.toLowerCase();
}
