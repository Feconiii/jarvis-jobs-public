// jarvis/page-company.mjs — which employer and which role an apply page names,
// read off its URL alone.
//
// Used to find the stored copy of a posting the store knows only from LinkedIn
// (serve.mjs findLinkedInCopy). The first version took the company from the
// URL's first path segment — right for jobs.lever.co/PhoenixTailings/…, and
// "jobs" on every iCIMS page, where the employer is in the SUBDOMAIN:
// engineering-appliedmedical.icims.com/jobs/14341/machine-design-engineer%2c-automation/candidate
// (Applied Medical, 2026-09-30: "icims reader does not recognize job from
// applied medical"). Workday has the same shape: <company>.wd5.myworkdayjobs.com/External/.

// Words a careers subdomain or path is made of that never name an employer.
const FILLER = new Set([
  'www', 'jobs', 'job', 'careers', 'career', 'apply', 'boards', 'board', 'hire',
  'recruiting', 'talent', 'external', 'internal', 'global', 'us', 'usa', 'na',
  'uscareers', 'engineering', 'hourly', 'campus', 'students', 'university',
  'experienced', 'professional', 'corporate', 'en', 'portal', 'site', 'ats',
]);

// Hosts whose first label is the ATS itself, not the employer.
const ATS_HOST = /^(?:jobs\.lever\.co|(?:job-)?boards\.greenhouse\.io|jobs\.ashbyhq\.com|apply\.workable\.com|jobs\.smartrecruiters\.com|jobs\.jobvite\.com)$/i;

const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Flattened employer names the page's URL could stand for, longest first.
 * "engineering-appliedmedical.icims.com" → ["appliedmedical", …]; a pure
 * filler label yields nothing rather than a guess.
 */
export function pageCompanyKeys(pageUrl) {
  let u;
  try { u = new URL(String(pageUrl)); } catch { return []; }
  const keys = new Set();
  const add = (s) => { const k = flat(s); if (k.length >= 4 && !FILLER.has(k)) keys.add(k); };
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const first = segs[0] ? decodeURIComponent(segs[0]) : '';
  // The board's own slug: jobs.lever.co/PhoenixTailings, boards.greenhouse.io/agility.
  if (first && !/^[a-z]{2}-[A-Z]{2}$/.test(first)) add(first);
  if (!ATS_HOST.test(host)) {
    // The employer's label: the leftmost one, split on dashes so a prefix like
    // "careers-" or "engineering-" falls away; every contiguous run is tried.
    const label = host.split('.')[0];
    const parts = label.split('-').filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      for (let j = i + 1; j <= parts.length; j += 1) {
        const run = parts.slice(i, j);
        if (run.every((p) => FILLER.has(p))) continue;
        add(run.filter((p) => !FILLER.has(p) || run.length === 1).join(''));
      }
    }
  }
  return [...keys].sort((a, b) => b.length - a.length);
}

const CO_SUFFIX = /[,.]?\s+(?:inc|llc|ltd|corp|corporation|co|company|gmbh|plc)\.?$/i;
/** An employer's name without "Inc." and its kin, flattened: "Optomec Inc." → "optomec". */
export const employerKey = (s) => flat(String(s || '').trim().replace(CO_SUFFIX, ''));

/**
 * Does a stored company name belong to the employer a site's key names?
 * "Applied Materials Inc" for `appliedmaterials`, "Lam Research" for
 * `lamresearch`, "AMD" for `amd`. Also a shortened name ("Applied" for
 * `appliedmaterials`), but only a real one: a blank company — a manual or
 * LinkedIn row — is a prefix of every key, and matched an Eightfold page to
 * another employer's posting by title and city alone (F-726).
 */
export function sameEmployer(key, company) {
  const k = flat(key), c = flat(company);
  if (k.length < 3 || c.length < 3) return false;
  return c.startsWith(k) || (k.startsWith(c) && c.length >= Math.min(k.length, 6));
}

/**
 * THE EMPLOYER AND ROLE A PAGE TITLE NAMES, for a form whose URL names
 * neither (F-691). Paylocity's form is /Recruiting/Jobs/Apply/4554622 and its
 * title "Optomec Inc. - Mechanical Engineer Application": the Optomec row the
 * store holds from LinkedIn was never found, and no resume went on.
 */
export function titleParts(headings) {
  const out = [];
  for (const h of headings || []) {
    const m = String(h || '').match(/^\s*(.{2,60}?)\s+[-–—|]\s+(.{3,120}?)(?:\s+application)?\s*$/i);
    if (m && employerKey(m[1]).length >= 3) out.push({ company: employerKey(m[1]), role: m[2].trim() });
  }
  return out;
}

/** A posting's address without its query, fragment or form suffix. */
function postingAddress(u) {
  return String(u || '').trim().replace(/[?#].*$/, '')
    .replace(/\/(apply|application|confirmation|thank-?you)(\/.*)?$/i, '')
    .replace(/\/+$/, '').toLowerCase();
}

/**
 * WHICH POSTING IS THIS TAB ON: the one it was opened for, or the one the page
 * shows? (F-633)
 *
 * Same company and same title used to mean "the tab stands" — right for Intel
 * (2026-09-26), where the page matched a Penang "Module Engineer" only by its
 * HEADING while he was applying to Phoenix's. Wrong for Lab37 (2026-09-30):
 * the tab was opened for one "Mechanical Design Engineer" (8557049002), he
 * clicked through the board to the other (8328619002) — which he had applied
 * to four minutes before — and the fill, the resume and the "applied" mark all
 * went to the posting he never opened, with no "already applied" warning.
 * When the page's own address IS a posting's address, the page wins.
 *
 * @returns 'page' | 'tab'
 */
export function tabOrPage(remembered, onPage, pageUrl) {
  if (!onPage) return 'tab';
  if (!remembered || String(onPage.id) === String(remembered.id)) return remembered ? 'tab' : 'page';
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lookAlike = flat(remembered.title) === flat(onPage.title) && flat(remembered.company) === flat(onPage.company);
  if (!lookAlike) return 'page';
  const here = postingAddress(pageUrl);
  return here && here === postingAddress(onPage.url) ? 'page' : 'tab';
}

/**
 * The role, where the URL spells it out: iCIMS keeps it beside the posting id,
 * /jobs/14341/machine-design-engineer%2c-automation/<page>. On its sign-in and
 * candidate pages the heading is not the job, so this is the only title there.
 */
export function pageTitleHints(pageUrl) {
  let u;
  try { u = new URL(String(pageUrl)); } catch { return []; }
  if (!/\.icims\.com$/i.test(u.hostname)) return [];
  const m = u.pathname.match(/\/jobs\/\d+\/([^/]+)/i);
  if (!m) return [];
  let slug;
  try { slug = decodeURIComponent(m[1]); } catch { slug = m[1]; }
  const title = slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
  return title && !/^(job|login|candidate|apply)$/i.test(title) ? [title] : [];
}
