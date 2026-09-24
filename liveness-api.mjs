// @ts-check
/**
 * liveness-api.mjs — zero-token liveness check for ATS-hosted job postings.
 *
 * Many postings live on ATS platforms (Greenhouse, Lever, Ashby, ...) that expose
 * a public JSON endpoint. We can confirm whether a posting is still live by hitting
 * that endpoint directly — no browser, no LLM tokens — and only fall back to the
 * Playwright check (liveness-browser.mjs) for non-ATS pages or when the API is
 * inconclusive. This is the cheap first rung of the liveness ladder.
 *
 * CONSERVATIVE BY DESIGN: a false "expired" is worse than the status quo (the user
 * misses a real job). So on a definitive 404/410 we return `expired`, and for
 * anything ambiguous (unknown ATS, redirect, 429/5xx, network/timeout) we return
 * `null` (→ caller falls back to Playwright).
 *
 * Two endpoint shapes:
 *   - Per-job (Greenhouse, Lever): the URL maps to a single-job endpoint, so a 200
 *     is itself proof the posting is live.
 *   - Org-level (Ashby): the URL maps to the org's whole job board. A 200 only
 *     proves the board exists, so the provider's `interpret` step parses the board
 *     and confirms THIS posting is still listed before returning active/expired.
 *     (Ashby pages are JS-rendered, so the browser/static rung sees only nav/footer
 *     and false-reports live postings as expired — this API rung is authoritative.)
 *
 * SSRF-safe by construction: the request URL is built from a FIXED, hard-coded API
 * host plus path segments extracted from the posting URL with a strict charset
 * (no slashes / traversal), and server-side redirects are refused.
 */

const TIMEOUT_MS = 8_000;
// Strict path-segment charset. Anything with a slash, dot-dot, or other char is
// rejected before it can reach the fixed-host API URL template.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Each ATS: detect its posting URL, then map to a public JSON API URL.
// `match` returns the extracted path params (or null); `api` builds the FIXED-host URL.
// Optional per-provider fields:
//   `timeoutMs`  — override the default fetch timeout (slow/rate-limited APIs).
//   `interpret`  — read the 200 response body to decide liveness (org-level APIs
//                  where a 200 alone doesn't prove THIS posting is live).
const ATS_PROVIDERS = [
  {
    id: 'greenhouse',
    // boards.greenhouse.io/{board}/jobs/{id} · job-boards[.eu].greenhouse.io/{board}/jobs/{id}
    match(u) {
      if (!/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
      const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/);
      return m ? { board: m[1], id: m[2] } : null;
    },
    api: ({ board, id }) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
  },
  {
    id: 'lever',
    // jobs.lever.co/{slug}/{id}
    match(u) {
      if (u.hostname !== 'jobs.lever.co') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/?#]+)\/?$/);
      return m ? { slug: m[1], id: m[2] } : null;
    },
    api: ({ slug, id }) => `https://api.lever.co/v0/postings/${slug}/${id}`,
  },
  {
    id: 'ashby',
    // jobs.ashbyhq.com/{org}/{jobId}[/application]. Ashby's public posting API is
    // ORG-level (the whole job board), not per-job — so `api` maps to the board and
    // `interpret` confirms this {jobId} is still listed. Only {org} reaches the
    // fixed-host URL; {jobId} is used solely to filter the parsed board (SAFE_SEGMENT
    // still validates both).
    match(u) {
      if (u.hostname !== 'jobs.ashbyhq.com') return null;
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/);
      return m ? { org: m[1], jobId: m[2] } : null;
    },
    api: ({ org }) => `https://api.ashbyhq.com/posting-api/job-board/${org}`,
    // Ashby's posting-api has a server-side latency floor and rate-limits repeated
    // unauthenticated hits (see providers/ashby.mjs). Give it more room than the ATS
    // default so a slow-but-live board doesn't time out into a Playwright fallback.
    timeoutMs: 20_000,
    async interpret(res, { jobId }) {
      let json;
      try {
        json = await res.json();
      } catch {
        return null; // unparseable body → inconclusive, let the browser decide
      }
      return classifyAshbyBoard(json, jobId);
    },
  },
  {
    id: 'workday',
    // <tenant>.wd<N>.myworkdayjobs.com/[locale/]<site>/job/<location>/<slug>
    //   -> /wday/cxs/<tenant>/<site>/job/<location>/<slug>
    //
    // Workday is the single biggest ATS in the deck (936 postings carry the
    // adapter) and had no API rung, so every dead requisition on it could only
    // be found by opening a browser - which in practice meant finding it during
    // an apply run. Two of four random Workday postings sampled were dead.
    //
    // SSRF: the host is NOT taken from the posting URL verbatim. It is
    // reassembled from a tenant matched against [a-z0-9-]+ and a data-centre
    // matched against wd\d+, into a fixed myworkdayjobs.com template - so the
    // same property the other providers get from a hard-coded host holds here.
    // Every path segment must pass SAFE_SEGMENT; anything percent-encoded or
    // otherwise unusual returns null and falls back to the browser rung.
    match(u) {
      const h = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i.exec(u.hostname);
      if (!h) return null;
      const m = /^\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([^/]+)\/job\/(.+?)\/?$/.exec(u.pathname);
      if (!m) return null;
      // Location and slug are returned SEPARATELY, never joined. resolveAtsApi
      // validates every value it is handed against SAFE_SEGMENT, which forbids
      // slashes - that guard IS the SSRF property and must not be weakened to
      // fit a path into it. Measured across the deck: all 1,113 Workday
      // postings have exactly two segments after /job/, and anything else
      // returns null and falls back to the browser rung.
      const parts = m[2].split('/');
      if (parts.length !== 2) return null;
      return { tenant: h[1].toLowerCase(), dc: h[2].toLowerCase(), site: m[1], loc: parts[0], slug: parts[1] };
    },
    api: ({ tenant, dc, site, loc, slug }) =>
      `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${loc}/${slug}`,
  },
  {
    id: 'smartrecruiters',
    // jobs.smartrecruiters.com/<slug>/<id>[-title]  and the OLD form the scanner
    // once wrote, jobs.smartrecruiters.com/<slug>/postings/<id>
    //   -> api.smartrecruiters.com/v1/companies/<slug>/postings/<id>
    //
    // The old form 404s for LIVE postings (providers/smartrecruiters.mjs
    // explains the swap), and 14,786 store rows still carried it on
    // 2026-09-04 — every one read as "expired" by the page rung and as
    // "gone" by the extension while the job was open. The public API answers
    // 200 with the posting for a live one and 404 for a removed one, so it
    // decides, whatever the page says.
    match(u) {
      if (u.hostname !== 'jobs.smartrecruiters.com') return null;
      const m = /^\/([A-Za-z0-9._-]+)\/(?:postings\/)?(\d{6,})(?:-[^/]*)?\/?$/.exec(u.pathname);
      return m ? { slug: m[1], id: m[2] } : null;
    },
    api: ({ slug, id }) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${id}`,
  },
  {
    id: 'eightfold',
    // <company host>/careers/job/<id>[-slug]?domain=<tenant domain>
    //   -> <company host>/api/pcsx/position_details?position_id=<id>&domain=<tenant>&hl=en
    //
    // Micron, Lam, Applied Materials, Qualcomm, GlobalFoundries and Microsoft
    // all run Eightfold on their own hosts, and none had an API rung — so a
    // closed Micron posting sat in his inbox with the page saying "No longer
    // accepting applications" and only a browser could see it. Measured
    // 2026-09-04: the closed posting answers {status: 404} on this endpoint
    // and a live one {status: 200, data.positionUserActions.applyAction.status:
    // "allowed"}, unauthenticated. (The PCSX LISTING endpoints are
    // session-gated; this per-position one is not.)
    //
    // SSRF: the host is the posting's own, so it must look like a hostname
    // and the path must be exactly /careers/job/<digits>; the domain
    // parameter is a hostname too. Anything else falls back to the browser.
    match(u) {
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(u.hostname)) return null;
      const m = /^\/careers\/job\/(\d{6,})(?:-[^/]*)?\/?$/.exec(u.pathname);
      if (!m) return null;
      const domain = u.searchParams.get('domain') || '';
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain)) return null;
      return { host: u.hostname.toLowerCase(), id: m[1], domain: domain.toLowerCase() };
    },
    api: ({ host, id, domain }) => `https://${host}/api/pcsx/position_details?position_id=${id}&domain=${domain}&hl=en`,
    async interpret(res) {
      let json;
      try { json = await res.json(); } catch { return null; }
      return classifyEightfoldPosition(json);
    },
  },
];

/**
 * Decide liveness for one Eightfold posting from its position_details payload.
 * Pure + deterministic, like classifyAshbyBoard.
 */
export function classifyEightfoldPosition(json) {
  if (!json || typeof json !== 'object') return null;
  const status = Number(json.status);
  if (status === 404) return { result: 'expired', code: 'eightfold_api_gone', reason: 'Eightfold position_details says 404 — posting closed' };
  if (status === 200) {
    const apply = json.data?.positionUserActions?.applyAction?.status;
    if (apply === 'allowed') return { result: 'active', code: 'eightfold_api_ok', reason: 'Eightfold lists the position and allows applying (live)' };
    // "log_in" is a sign-in wall, not a closed req (F-501). GlobalFoundries'
    // "Semiconductor Manufacturing Engineer (2027 New College Graduate)" answered
    // 200 with applyAction "log_in" on 2026-09-19 while its page and job record
    // were public — and was called expired. A closed posting answers 404 here.
    if (apply === 'log_in') return { result: 'active', code: 'eightfold_api_login', reason: 'Eightfold lists the position; applying needs a sign-in (live)' };
    if (apply === 'closed') return { result: 'expired', code: 'eightfold_api_closed', reason: 'Eightfold lists the position but applying is "closed"' };
    // Any other state is one nobody has measured. A false "expired" retires a
    // real job he never hears about, so an unknown state goes to the browser.
    if (typeof apply === 'string') return null;
    return { result: 'active', code: 'eightfold_api_ok', reason: 'Eightfold lists the position (live)' };
  }
  return null;
}

/**
 * Decide liveness for one Ashby posting from its org's job-board API payload.
 * Pure + deterministic (no I/O), mirroring classifyLiveness in liveness-core.mjs.
 *
 * The public board lists only currently-published postings, so a posting that is
 * absent (or explicitly `isListed: false`) has been removed/unlisted → expired.
 * A present, listed posting → active. An unexpected shape → null (inconclusive),
 * so a future API change degrades to a Playwright fallback rather than a false
 * "expired".
 *
 * @param {any} json - parsed job-board response, expected shape `{ jobs: [...] }`
 * @param {string} jobId - the {jobId} from jobs.ashbyhq.com/{org}/{jobId}
 * @returns {{ result: 'active' | 'expired', code: string, reason: string } | null}
 */
export function classifyAshbyBoard(json, jobId) {
  if (!json || !Array.isArray(json.jobs)) return null; // unexpected shape → fall back
  const target = String(jobId).toLowerCase();
  const job = json.jobs.find((j) => typeof j?.id === 'string' && j.id.toLowerCase() === target);
  if (job && job.isListed !== false) {
    return { result: 'active', code: 'ashby_api_ok', reason: 'Ashby posting is listed on the board (live)' };
  }
  return { result: 'expired', code: 'ashby_api_unlisted', reason: 'Ashby posting not listed on the board — removed/unlisted' };
}

/**
 * Map a posting URL to its ATS API URL, or null if it isn't a known ATS posting
 * (or any extracted segment fails the strict charset). Pure + deterministic.
 * @param {string} rawUrl
 * @returns {{ ats: string, apiUrl: string, parts: Record<string, string>, timeoutMs?: number, interpret?: (res: Response, parts: Record<string, string>) => Promise<{ result: 'active' | 'expired', code: string, reason: string } | null> } | null}
 */
export function resolveAtsApi(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const provider of ATS_PROVIDERS) {
    const parts = provider.match(u);
    if (!parts) continue;
    // SSRF guard: every derived segment must be a single safe path segment.
    if (!Object.values(parts).every((v) => SAFE_SEGMENT.test(v) && !v.includes('..'))) return null;
    return { ats: provider.id, apiUrl: provider.api(parts), parts, timeoutMs: provider.timeoutMs, interpret: provider.interpret };
  }
  return null;
}

/** True if `url` is an ATS posting we can check via API (lets callers stay lazy about the browser). */
export function isAtsPosting(url) {
  return resolveAtsApi(url) !== null;
}

/**
 * Zero-token liveness check via the posting's ATS API.
 * @param {string} url
 * @returns {Promise<{ result: 'active' | 'expired', code: string, reason: string } | null>}
 *   null = not a known ATS posting, or inconclusive → caller should fall back to Playwright.
 */
/**
 * Is this Workday tenant answering us AT ALL right now?
 *
 * The control for the 403 rule above: its public job list, which every tenant
 * serves to anyone. 200 means we are being talked to, so a 403 on one
 * requisition is about that requisition. Anything else — a block, a timeout,
 * a 5xx — means we cannot tell, and the caller must not retire anything.
 */
async function tenantAnswers({ tenant, dc, site }, signal) {
  if (!SAFE_SEGMENT.test(tenant) || !SAFE_SEGMENT.test(site) || !/^wd\d+$/.test(dc)) return false;
  try {
    const res = await fetch(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
      method: 'POST',
      headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 1, offset: 0, appliedFacets: {}, searchText: '' }),
      redirect: 'error',
      signal,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * The requisition a Workday slug carries: `R-D-Engineer_R571543-1` -> R571543.
 *
 * The trailing `-1` is Workday's own duplicate-title suffix, not part of the
 * id, and searching with it attached finds nothing; searching without it finds
 * the posting. Returns '' when the slug has no id to search for, and the
 * caller then falls back to the weaker control.
 */
export function workdayRequisition(slug) {
  const s = String(slug || '');
  // No underscore, no requisition: the id is always the part after the last
  // one, and a slug that is only a title must not be searched for as if it
  // were an id — a search for the wrong string finds nothing, and "finds
  // nothing" is what retires a posting.
  if (!s.includes('_')) return '';
  const tail = s.split('_').pop() || '';
  // R571543, 2635066, JR0286844, J-00350480, JR-2026-21950, 26-675.
  if (!/^[A-Za-z-]{0,8}[0-9][A-Za-z0-9-]*$/.test(tail)) return '';
  const trimmed = tail.replace(/-\d{1,2}$/, '');
  return (trimmed.length >= 4 ? trimmed : tail).slice(0, 40);
}

/**
 * ASK THE TENANT FOR THE POSTING BY NAME (F-403).
 *
 * A stronger control than "is this tenant talking to us": its own search, for
 * this requisition. `listed` means the posting is still on the board and a 403
 * on its detail endpoint is a block, not a removal — nothing is retired.
 * `absent` means the board itself no longer carries it. `null` means the
 * tenant did not answer and nothing has been learnt.
 *
 * Measured 2026-09-08 on the three Workday postings a sweep had retired out of
 * his own shortlist: Stryker R571543 and KLA 2635066 both answered `total: 0`
 * from their own boards, while a live Intel posting on the same rung came back
 * with its exact path.
 */
async function tenantStillLists({ tenant, dc, site, slug }, signal) {
  if (!SAFE_SEGMENT.test(tenant) || !SAFE_SEGMENT.test(site) || !/^wd\d+$/.test(dc)) return null;
  const req = workdayRequisition(slug);
  if (!req) return null;
  try {
    const res = await fetch(`https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
      method: 'POST',
      headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0, appliedFacets: {}, searchText: req }),
      redirect: 'error',
      signal,
    });
    if (res.status !== 200) return null;
    const body = await res.json();
    const postings = Array.isArray(body?.jobPostings) ? body.jobPostings : [];
    const mine = postings.some((p) => String(p?.externalPath || '').endsWith(`/${slug}`));
    return mine ? 'listed' : 'absent';
  } catch {
    return null;
  }
}

export async function checkLivenessViaApi(url) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return null;
  const { ats, apiUrl, parts, interpret, timeoutMs } = resolved;

  // The timeout guards the whole classification (fetch + any `interpret` body read),
  // since aborting the shared signal also tears down an in-flight res.json().
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json' },
        redirect: 'error', // refuse server-side redirects (SSRF + ambiguity guard)
        signal: controller.signal,
      });
    } catch {
      return null; // network / timeout / redirect → inconclusive, let Playwright decide
    }

    if (res.status === 404 || res.status === 410) {
      return { result: 'expired', code: `${ats}_api_gone`, reason: `ATS API ${res.status} — posting removed` };
    }
    if (res.status === 200) {
      // Org-level APIs (Ashby) inspect the body to confirm THIS posting; per-job
      // APIs (Greenhouse, Lever) treat a 200 as proof the posting is live.
      if (interpret) return await interpret(res, parts);
      return { result: 'active', code: `${ats}_api_ok`, reason: 'ATS API returns the posting (live)' };
    }
    // WORKDAY ANSWERS 403 FOR A REQUISITION IT HAS PULLED (F-397).
    //
    // Measured 2026-09-07 on a Jabil posting sitting in his curated inbox: the
    // page reads "The page you are looking for doesn't exist" in HIS OWN
    // signed-in Chrome, and its CXS endpoint answers **403** — while a live
    // posting on the same tenant, fetched a second later by the same client,
    // answers 200. So the 403 is about that requisition, not about us.
    //
    // On its own a 403 is exactly the shape of a bot block, and this file's
    // whole discipline is that only definitive evidence retires a posting. So
    // it is not taken on its own: the tenant's own job LIST is asked in the
    // same breath, and only a tenant that is plainly answering us turns a 403
    // into "gone". A tenant that is blocking us answers nothing, and the
    // posting is left alone.
    if (res.status === 403 && ats === 'workday' && parts?.tenant && parts?.site) {
      // Best evidence first: the tenant's own search for this requisition.
      const onBoard = await tenantStillLists(parts, controller.signal);
      if (onBoard === 'listed') return null;   // still on the board — the 403 is about us
      if (onBoard === 'absent') {
        return { result: 'expired', code: `${ats}_api_gone`, reason: 'the tenant\'s own board no longer lists this requisition — posting removed' };
      }
      const control = await tenantAnswers(parts, controller.signal);
      if (control) {
        return { result: 'expired', code: `${ats}_api_gone`, reason: 'ATS API 403 for this requisition while the tenant answers — posting removed' };
      }
      return null;   // the tenant is not talking to us; this proves nothing
    }
    return null; // 429/5xx/other → inconclusive, fall back to the browser check
  } catch {
    return null; // interpret abort / unexpected error → inconclusive
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The TITLE and COMPANY of a posting, from the same ATS API liveness uses.
 *
 * `node jarvis/apply.mjs --url <posting>` used to build its work item as
 * `findStoreJob(u) || { url: u, title: '', company: '' }`. For a posting the
 * scanner has never seen — a link someone sent him, a company not in
 * portals.yml — the fallback won and the title was EMPTY. `familyFor` decides
 * from the title first, so with no title it returned the default family, and a
 * Mechanical Design Engineer posting silently got the all-rounder resume.
 *
 * Those `--url` runs are exactly the applications he cares most about, and they
 * were the ones guaranteed to lose the family.
 *
 * Same resolution path as `checkLivenessViaApi`, so the SSRF guards in
 * `resolveAtsApi` (https only, no redirects, safe path segments) apply here too.
 * Returns null for anything it cannot read; the caller must say so rather than
 * quietly defaulting.
 *
 * @returns {Promise<{ title: string, company: string, ats: string } | null>}
 */
export async function fetchPostingMeta(url) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return null;
  const { ats, apiUrl, parts, timeoutMs } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'user-agent': 'career-ops-liveness/1.0', accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      return null;
    }
    if (res.status !== 200) return null;

    let json;
    try { json = await res.json(); } catch { return null; }

    return postingMetaFrom(ats, json, parts);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the title and company out of one ATS's JSON. Pure, so it is testable
 * without a network — the shapes are the part that breaks when a vendor changes
 * their API, and a network test would fail for a dozen unrelated reasons.
 *
 * Returns null when there is no title. A posting with no title is exactly the
 * case that started this fault, and inventing one would be worse than admitting
 * it: the caller prints a warning instead of defaulting the family in silence.
 */
export function postingMetaFrom(ats, json, parts = {}) {
  // A slug is a poor company name but a far better one than "". It only ever
  // reaches the audit copy's filename; the family is chosen from the title.
  const fromSlug = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

  let title = '';
  let company = '';
  if (ats === 'greenhouse') {
    title = json?.title || '';
    company = json?.company_name || fromSlug(parts.board);
  } else if (ats === 'lever') {
    title = json?.text || '';
    company = fromSlug(parts.slug);
  } else if (ats === 'ashby') {
    // Org-level board: find THIS posting among the listed jobs. Matching the
    // wrong one would title the application after somebody else's job.
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const hit = jobs.find((j) => String(j?.jobId || j?.id || '') === String(parts.jobId));
    title = hit?.title || '';
    company = json?.name || fromSlug(parts.org);
  } else if (ats === 'workday') {
    title = json?.jobPostingInfo?.title || json?.jobPostingInfo?.jobPostingTitle || '';
    company = fromSlug(parts.tenant);
  }

  title = String(title).replace(/\s+/g, ' ').trim();
  company = String(company).replace(/\s+/g, ' ').trim();
  return title ? { title, company, ats } : null;
}

/**
 * Is this posting DEFINITELY gone? Cheap, and conservative by design.
 *
 * `/api/apply` used to open a tab and spend up to two minutes tailoring a
 * resume before he could discover the posting was a 404. Two of the five jobs
 * in his queue were exactly that — Amazon answering "Sorry, the job you're
 * looking for isn't available."
 *
 * Only a definitive 404 or 410 counts. A false "expired" is the expensive error
 * in this project — it makes him miss a real job — so a network failure, a
 * timeout, a 403 (Tesla answers automated visits that way) or any other status
 * returns false and the application proceeds. This can only ever save him time,
 * never cost him an opportunity.
 */
export async function definitelyGone(url) {
  const viaApi = await checkLivenessViaApi(url).catch(() => null);
  if (viaApi?.result === 'expired') return viaApi.reason || 'the ATS API says this posting is gone';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 career-ops/1.0', accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status === 404 || res.status === 410) return `the posting URL answers HTTP ${res.status}`;
    return false;
  } catch {
    return false;   // unreachable is not the same as gone
  } finally {
    clearTimeout(timer);
  }
}
