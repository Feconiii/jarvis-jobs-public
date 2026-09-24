/**
 * A company's logo for the dashboard.
 *
 * Alex, 2026-09-03: "add the job id and company logo as well, logo in all the
 * other tabs too coz the text only does not feel very modern".
 *
 * Nothing in the store knows a company's website. What it does know is the
 * posting URL, and for most of his companies that URL carries the company's
 * identity — an Eightfold site lives on careers.<company>.com, a Workday tenant
 * is <company>.wd1.myworkdayjobs.com, a Greenhouse board is
 * boards.greenhouse.io/<company>. So the domain is GUESSED from the URL first
 * and from the company name second, and each guess is checked against a
 * favicon service that answers 404 for a domain it does not know. Measured on
 * 2026-09-03: DuckDuckGo's icon endpoint returns 200 for kla.com, 1x.tech and
 * dexterity.ai and 404 (with a placeholder body) for a made-up domain; Google's
 * s2 favicon service does the same. Clearbit's logo API no longer answers.
 *
 * What goes over the wire is a company domain — never his name, never a
 * posting's contents. Results, including "no logo found", are cached on disk
 * under data/jarvis/logos so a company is looked up once, not once per row.
 *
 * When every guess misses, the dashboard draws a lettermark. That is not a
 * failure state to hide: a two-letter tile in a stable colour is how Slack and
 * Notion show an org with no picture, and it reads as designed rather than
 * broken.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import path from 'path';

/**
 * Normalise a company name so "KLA Corporation", "KLA Corp." and "KLA" share
 * one logo — the legal form is dropped, everything else is kept. ("Eaton" and
 * "Eaton Corporation" are the same employer in his store; see the requisition
 * matching in serve.mjs for the same lesson learned the hard way.)
 */
export function logoKey(company) {
  const words = String(company || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const bare = words.filter((w) => !CORP_SUFFIX.has(w));
  return (bare.length ? bare : words).join('').slice(0, 64);
}

/** A stable hue for the lettermark, so the same company is always the same colour. */
export function hueFor(company) {
  let h = 0;
  for (const c of String(company || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** The letters on a lettermark: first letters of the first two words. */
export function initials(company) {
  const words = String(company || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const pick = words.filter((w) => !CORP_SUFFIX.has(w.toLowerCase()));
  const use = pick.length ? pick : words;
  return use.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

/**
 * Words that name the legal form rather than the company. "KLA Corporation"
 * lives at kla.com, "Eaton Corporation" at eaton.com. "Motorola Solutions" is
 * NOT on this list on purpose: motorolasolutions.com is the real company and
 * motorola.com is a different one.
 */
const CORP_SUFFIX = new Set(['inc', 'inc.', 'incorporated', 'corp', 'corp.', 'corporation', 'co', 'co.', 'company',
  'ltd', 'ltd.', 'limited', 'llc', 'plc', 'holdings', 'group', 'gmbh', 'ag', 'sa', 'nv', 'bv', 'pty', 'llp', 'lp']);

/** Job boards and aggregators: their host says nothing about the employer. */
const AGGREGATOR_RE = /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|simplyhired|dice|monster|builtin|builtinla|builtinnyc|wellfound|angel|joinhandshake|handshake|google|bing|adzuna|jooble|lensa|talent|careerjet|craigslist|usajobs|jobright|simplify)\.(com|co|jobs|org)$/i;

/**
 * Hosted ATS platforms, and where the employer's slug hides in the URL. Each
 * entry says how to pull the slug out; the slug becomes a domain guess. Entries
 * with no slug rule are recognised only so their host is never mistaken for the
 * employer's own site.
 */
export const ATS_SLUGS = [
  { name: 'workday', host: /^([a-z0-9-]+)\.wd\d*\.myworkdayjobs\.com$/i, fromHost: 1 },
  { name: 'workday', host: /^([a-z0-9-]+)\.myworkdayjobs\.com$/i, fromHost: 1 },
  { name: 'greenhouse', host: /(^|\.)greenhouse\.io$/i, fromPath: /^\/(?:embed\/job_app\/?)?([a-z0-9_-]+)/i },
  { name: 'lever', host: /^jobs\.lever\.co$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'ashby', host: /^jobs\.ashbyhq\.com$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'smartrecruiters', host: /(^|\.)smartrecruiters\.com$/i, fromPath: /^\/([A-Za-z0-9_-]+)/ },
  { name: 'eightfold', host: /^([a-z0-9-]+)\.eightfold\.ai$/i, fromHost: 1 },
  { name: 'icims', host: /^(?:careers-|jobs-)?([a-z0-9-]+)\.icims\.com$/i, fromHost: 1 },
  { name: 'jobvite', host: /^jobs\.jobvite\.com$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'workable', host: /^apply\.workable\.com$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'bamboohr', host: /^([a-z0-9-]+)\.bamboohr\.com$/i, fromHost: 1 },
  { name: 'breezy', host: /^([a-z0-9-]+)\.breezy\.hr$/i, fromHost: 1 },
  { name: 'rippling', host: /^ats\.rippling\.com$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'taleo', host: /^([a-z0-9-]+)\.taleo\.net$/i, fromHost: 1 },
  { name: 'successfactors', host: /(^|\.)successfactors\.(com|eu)$/i, fromQuery: 'company' },
  { name: 'jazzhr', host: /^([a-z0-9-]+)\.applytojob\.com$/i, fromHost: 1 },
  { name: 'recruitee', host: /^([a-z0-9-]+)\.recruitee\.com$/i, fromHost: 1 },
  { name: 'pinpoint', host: /^([a-z0-9-]+)\.pinpointhq\.com$/i, fromHost: 1 },
  { name: 'teamtailor', host: /^([a-z0-9-]+)\.teamtailor\.com$/i, fromHost: 1 },
  { name: 'personio', host: /^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/i, fromHost: 1 },
  { name: 'dover', host: /^jobs\.dover\.com$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'gem', host: /^jobs\.gem\.com$/i, fromPath: /^\/([a-z0-9_-]+)/i },
  { name: 'ukg', host: /^recruiting\d*\.ultipro\.com$/i },
  { name: 'oracle', host: /(^|\.)oraclecloud\.com$/i },
  { name: 'phenom', host: /(^|\.)phenompeople\.com$/i },
  { name: 'avature', host: /(^|\.)avature\.net$/i },
  { name: 'paylocity', host: /(^|\.)paylocity\.com$/i },
  { name: 'paycom', host: /(^|\.)paycomonline\.net$/i },
  { name: 'adp', host: /(^|\.)adp\.com$/i },
  { name: 'amazon', host: /^(www\.)?amazon\.jobs$/i, fixed: 'amazon.com' },
];

/** Second-level public suffixes, so "kla.co.uk" is not shortened to "co.uk". */
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.jp', 'co.kr', 'com.sg', 'com.br', 'co.in',
  'com.tw', 'com.cn', 'co.il', 'com.mx', 'co.nz', 'com.hk', 'co.za', 'com.tr', 'com.ar']);

/** The registrable part of a host: "careers.lamresearch.com" → "lamresearch.com". */
export function registrableDomain(host) {
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const last2 = labels.slice(-2).join('.');
  const n = SECOND_LEVEL.has(last2) ? 3 : 2;
  if (labels.length < n) return null;
  return labels.slice(-n).join('.');
}

/** Turn an employer slug or name into domain guesses, most likely first. */
function guesses(slug, tlds = ['com']) {
  const s = String(slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '');
  if (!s || s.length < 2) return [];
  const out = [];
  for (const tld of tlds) out.push(`${s}.${tld}`);
  if (s.includes('-')) for (const tld of tlds) out.push(`${s.replace(/-/g, '')}.${tld}`);
  return out;
}

/** The company name with its legal-form words removed, joined into a slug. */
function nameSlugs(company) {
  const words = String(company || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const bare = words.filter((w) => !CORP_SUFFIX.has(w));
  const out = [];
  // The legal form dropped first — "KLA Corporation" is kla.com — then the
  // whole name, for the few that really do carry it in the domain.
  if (bare.length) out.push(bare.join(''));
  out.push(words.join(''));
  return [...new Set(out)];
}

/**
 * Domains worth asking about for this company, most likely first.
 *
 * The posting URL comes first because it is evidence rather than a guess: a
 * careers site on the company's own domain names the company outright, and an
 * ATS tenant slug was chosen by the company itself. The name-derived guesses
 * follow, and they get the startup TLDs too (1X lives at 1x.tech, Dexterity at
 * dexterity.ai). Only the legal form is ever dropped from a name — "KLA
 * Corporation" is kla.com — never a descriptive word, so "Gradient Robotics"
 * can never resolve to whoever owns gradient.com.
 */
export function domainCandidates({ company, url } = {}) {
  const out = [];
  const push = (d) => { if (d && !out.includes(d)) out.push(d); };

  let u = null;
  try { u = url ? new URL(String(url)) : null; } catch { u = null; }
  if (u && /^https?:$/.test(u.protocol)) {
    const host = u.hostname.toLowerCase();
    const ats = ATS_SLUGS.find((a) => a.host.test(host));
    if (ats) {
      let slug = null;
      if (ats.fixed) push(ats.fixed);
      else if (ats.fromHost) slug = host.match(ats.host)?.[ats.fromHost] || null;
      else if (ats.fromPath) slug = u.pathname.match(ats.fromPath)?.[1] || null;
      else if (ats.fromQuery) slug = u.searchParams.get(ats.fromQuery);
      // "embed", "job", "jobs", "careers" are path words, not tenants.
      if (slug && !/^(embed|jobs?|careers?|apply|en|en-us|external|home|search|job_app|company)$/i.test(slug)) {
        for (const d of guesses(slug, ['com', 'ai', 'io', 'tech'])) push(d);
      }
    } else if (!AGGREGATOR_RE.test(host)) {
      // The company's own site (Eightfold, Phenom and most in-house career
      // pages sit on careers.<company>.com). Strip the careers subdomain and
      // keep what is left.
      const reg = registrableDomain(host);
      if (reg && !/(^|\.)(myworkdayjobs|greenhouse|lever|ashbyhq|smartrecruiters|eightfold|icims|jobvite|workable)\./i.test(`.${host}`)) {
        // careers.kla.com → kla.com; jobs.acme.co.uk keeps acme.co.uk. Any
        // subdomain of the company's own site still names the company.
        push(reg);
      }
    }
  }

  const slugs = nameSlugs(company);
  slugs.forEach((s, i) => {
    for (const d of guesses(s, i === 0 ? ['com', 'ai', 'io'] : ['com'])) push(d);
  });
  return out.slice(0, 8);
}

/** Services that answer 404 for an unknown domain, tried in this order. */
export const ICON_SOURCES = [
  { name: 'duckduckgo', url: (d) => `https://icons.duckduckgo.com/ip3/${d}.ico` },
  { name: 'google', url: (d) => `https://www.google.com/s2/favicons?domain=${d}&sz=128` },
];

/** Too small to be anything but a blank or a 1×1 placeholder. */
const MIN_ICON_BYTES = 120;

/**
 * Fetch one domain's icon from the first source that has it. Returns
 * `{ bytes, type, source }` or null. Never throws — a network hiccup is a
 * lettermark, not an error.
 */
export async function fetchIcon(domain, { fetchImpl = globalThis.fetch, timeoutMs = 6000, sources = ICON_SOURCES } = {}) {
  for (const src of sources) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try { res = await fetchImpl(src.url(domain), { redirect: 'follow', signal: ctl.signal }); }
      finally { clearTimeout(timer); }
      if (!res || res.status !== 200) continue;
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < MIN_ICON_BYTES) continue;
      return { bytes, type, source: src.name };
    } catch {
      // timeout, DNS, refused — try the next source
    }
  }
  return null;
}

const EXT_FOR = { 'image/png': 'png', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** A miss is retried after this long; a hit is kept until the file is deleted. */
const MISS_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The on-disk cache: one index, one image file per company. Reads are cheap
 * and synchronous (the dashboard asks for dozens per page); the index is
 * written whole after every change, which at a few hundred entries is nothing.
 */
export class LogoCache {
  constructor(dir) {
    this.dir = dir;
    this.indexPath = path.join(dir, 'index.json');
    this.index = null;
    this.inflight = new Map();
  }

  load() {
    if (this.index) return this.index;
    try { this.index = JSON.parse(readFileSync(this.indexPath, 'utf-8')) || {}; }
    catch { this.index = {}; }
    return this.index;
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.index, null, 1));
    renameSync(tmp, this.indexPath);
  }

  /** What the cache knows: `{ file, type, domain }`, `{ none: true }`, or null when never asked. */
  peek(company, now = Date.now()) {
    const idx = this.load();
    const e = idx[logoKey(company)];
    if (!e) return null;
    if (e.file) {
      const full = path.join(this.dir, e.file);
      if (existsSync(full)) return { ...e, full };
      delete idx[logoKey(company)];
      return null;
    }
    if (e.none && now - Date.parse(e.at || 0) < MISS_TTL_MS) return e;
    return null;
  }

  /**
   * Resolve a company's logo, fetching if the cache has no answer. Concurrent
   * requests for the same company share one lookup — a table of forty rows from
   * one employer must not fire forty lookups.
   */
  async resolve({ company, url }, { fetchImpl, now = Date.now() } = {}) {
    const key = logoKey(company);
    if (!key) return { none: true };
    const known = this.peek(company, now);
    if (known) return known;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.lookup(key, { company, url }, { fetchImpl, now }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async lookup(key, { company, url }, { fetchImpl, now }) {
    const idx = this.load();
    for (const domain of domainCandidates({ company, url })) {
      const hit = await fetchIcon(domain, { fetchImpl });
      if (!hit) continue;
      const ext = EXT_FOR[hit.type] || 'png';
      const file = `${key}.${ext}`;
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path.join(this.dir, file), hit.bytes);
      idx[key] = { file, type: hit.type, domain, source: hit.source, at: new Date(now).toISOString() };
      this.save();
      return { ...idx[key], full: path.join(this.dir, file) };
    }
    idx[key] = { none: true, at: new Date(now).toISOString(), tried: domainCandidates({ company, url }).length };
    this.save();
    return idx[key];
  }
}

