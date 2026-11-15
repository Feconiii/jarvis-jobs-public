/**
 * WHAT A POSTING'S OWN JSON-LD SAYS BEYOND ITS TITLE (R1, 2026-11-07).
 *
 * The extension reads employment type, pay, remote, where applicants may live,
 * the closing date and the employer's own site from the posting's JobPosting
 * markup (discover.js jsonLdExtras) and sends them with /api/apply-page.
 * Facts about the job, never about him. Two rules here:
 *   - pay is annualised by schema.org's unit words the way providers/ashby.mjs
 *     annualises Ashby's (hour 2080, day 260, week 52, month 12, year 1), kept
 *     as structured pay (source 'jsonld', which resolveSalary trusts over the
 *     description), and only when it reads as a plausible yearly figure;
 *   - a closing date in the past is a CAUTION shown to him, never a reason to
 *     retire the posting (CLAUDE.md: a false "expired" is the expensive error).
 */
const PER_YEAR = { HOUR: 2080, DAY: 260, WEEK: 52, MONTH: 12, YEAR: 1 };

/**
 * {min, max, currency, unit} from the page → the store's annual {min, max,
 * currency, interval, source}, or null. A rate below a year (hour, day, week)
 * is annualised only for a full-time job: an intern's or a contractor's hourly
 * rate times 2,080 hours is a salary nobody offered (review), so it is not kept.
 */
const NOT_FULL_YEAR = /PART[_\s-]?TIME|INTERN|TEMPORARY|CONTRACT|PER[_\s-]?DIEM|SEASONAL/i;
export function jsonLdSalary(s, employmentType = '') {
  if (!s || typeof s !== 'object') return null;
  const unit = String(s.unit || 'YEAR').toUpperCase().replace(/S$/, '');
  const k = PER_YEAR[unit];
  if (!k) return null;
  if (k > 12 && NOT_FULL_YEAR.test(String(employmentType || ''))) return null;
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
  const lo = num(s.min); const hi = num(s.max);
  if (lo == null && hi == null) return null;
  const min = Math.round((lo ?? hi) * k); const max = Math.round((hi ?? lo) * k);
  const [a, b] = [Math.min(min, max), Math.max(min, max)];
  if (a < 10_000 || b > 2_000_000) return null;   // not a yearly figure anyone would publish
  const currency = /^[A-Z]{3}$/.test(String(s.currency || '')) ? String(s.currency) : 'USD';
  return { min: a, max: b, currency, interval: 'year', source: 'jsonld' };
}

/** "The page says applications closed on 3 Nov 2026" when the closing date has passed; '' otherwise. A caution only. */
export function closingCaution(validThrough, now = Date.now()) {
  const t = Date.parse(String(validThrough || ''));
  if (!Number.isFinite(t) || t >= now) return '';
  const d = new Date(t);
  return `the posting's own markup says applications closed on ${d.toISOString().slice(0, 10)} — check the page before applying (nothing was retired)`;
}

/**
 * A location for a REMOTE posting whose markup gave none: "Remote", with where
 * applicants may live. An on-site posting's applicant requirement is not where
 * the job is (review), so it gives no location.
 */
export function locationFromExtras({ remote = false, applicantLocations = [] } = {}) {
  if (!remote) return '';
  const where = (Array.isArray(applicantLocations) ? applicantLocations : []).map((w) => String(w).trim()).filter(Boolean).slice(0, 3).join(' / ');
  return where ? `Remote (${where})`.slice(0, 120) : 'Remote';
}

/**
 * THE EMPLOYER'S OWN SITE, OR NOTHING (R1 review). A posting's
 * hiringOrganization.sameAs is often its LinkedIn, Facebook or Glassdoor page;
 * looked up in the store, linkedin.com named whoever was commonest among his
 * LinkedIn rows. Social, aggregator and shared job-board hosts are refused, and
 * so is the page's own host (it was already asked). Returns the host to look
 * up, or ''. The caller still requires the store to name exactly one company there.
 */
const NOT_AN_EMPLOYER_SITE = /(^|\.)(linkedin\.com|lnkd\.in|facebook\.com|fb\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|tiktok\.com|glassdoor\.com|crunchbase\.com|wikipedia\.org|wikidata\.org|indeed\.com|ziprecruiter\.com|monster\.com|builtin\.com|wellfound\.com|angel\.co|simplify\.jobs|handshake\.com|joinhandshake\.com|google\.com|bing\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|bamboohr\.com|rippling\.com|pinpointhq\.com|breezy\.hr|recruitee\.com|myworkdayjobs\.com|myworkdaysite\.com|icims\.com|jobvite\.com|successfactors\.com|successfactors\.eu|oraclecloud\.com|taleo\.net|ultipro\.com|paylocity\.com|adp\.com|dayforcehcm\.com|eightfold\.ai|phenompeople\.com)$/i;
export function employerSiteHost(site, pageUrl = '') {
  let host = '';
  try { const u = new URL(String(site || '')); if (!/^https?:$/.test(u.protocol)) return ''; host = u.hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  if (!host || NOT_AN_EMPLOYER_SITE.test(host)) return '';
  let page = '';
  try { page = new URL(String(pageUrl)).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* none */ }
  if (page && (page === host || page.endsWith(`.${host}`) || host.endsWith(`.${page}`))) return '';
  return host;
}
