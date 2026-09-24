#!/usr/bin/env node
// jarvis/discover-ats.mjs — turn a list of company NAMES into verified
// portals.yml entries.
//
// The gap this closes: scan.mjs can only scan companies that are already in
// portals.yml with a working careers_url. Adding "the S&P 500" by hand means
// finding each company's ATS tenant, instance, and site path — ~500 lookups.
// This script does that mechanically and, critically, VERIFIES each hit with a
// real API call before writing it. Nothing lands in portals.yml that did not
// just return live postings.
//
// Probe order is cheapest-first, stopping at the first provider that answers:
//   Greenhouse → Ashby → Lever → SmartRecruiters → Rippling → Workable →
//   BambooHR → Breezy → Recruitee → Workday
//
// Workday needs a (tenant, instance, site) triple and is the common case for
// large caps, so it gets a two-stage probe. The CXS endpoint distinguishes
// "tenant exists, wrong site" (HTTP 404, errorCode S21, "not found:
// Job_Posting_Site_ID=…") from "no such tenant/instance" (HTTP 422). So we
// first find the live (tenant, instance) with one throwaway request per
// instance, and only then spend requests on site candidates. Without that
// split, the full tenant×instance×site matrix is ~200 requests per company;
// with it, most companies cost under a dozen.
//
// Usage:
//   node jarvis/discover-ats.mjs --sp500                  # resolve S&P 500
//   node jarvis/discover-ats.mjs --names "Zoox,Rivian"    # ad-hoc list
//   node jarvis/discover-ats.mjs --sp500 --write          # append to portals.yml
//   node jarvis/discover-ats.mjs --sp500 --concurrency 12
//   node jarvis/discover-ats.mjs --sp500 --sectors "Industrials,Health Care"
//   node jarvis/discover-ats.mjs --sp500 --exclude-sectors "Financials,Real Estate"
//
// Without --write it only prints the YAML it would add (dry run by default:
// portals.yml is user-layer config and should not change as a side effect of
// a lookup).
//
// A note on scale: adding a company here is cheap, but SCANNING it is not.
// the store currently runs ~1.9 KB per posting because full descriptions are
// retained (triage recomputes work-authorisation blocks from them). The whole
// S&P 500 is on the order of a quarter-million postings, i.e. a ~900 MB store
// that every scan parses and rewrites. The --sectors / --exclude-sectors
// filters exist so breadth can be bought where it pays: Industrials, Health
// Care, Information Technology, Energy and Materials hold essentially all the
// mechanical-engineering surface, while Financials, Real Estate and Utilities
// contribute volume and almost no matching roles.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import yaml from 'js-yaml';

import { guardArgs } from './cli.mjs';
import { makeHostLimiter, serviceOf } from './net-pool.mjs';

const USAGE = `
  node jarvis/discover-ats.mjs [options]

  Discover which ATS a company uses.

    --all-startups        
    --sp500 --sp400 --sp600
    --concurrency <value> 
    --exclude-sectors <value>
    --limit <value>       
    --names <value>       
    --sectors <value>     
    --seeds <value>       
    --vc <a,b>            VC portfolios, read as company domains
    --write               
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--all-startups","--sp500","--sp400","--sp600","--concurrency","--exclude-sectors","--limit","--names","--sectors","--seeds","--vc","--write"], valued: ["--concurrency","--exclude-sectors","--limit","--names","--sectors","--seeds","--vc"] });


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const SP500_CACHE = path.join(CACHE_DIR, 'sp500-constituents.csv');
const SP500_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

const UA = 'Mozilla/5.0 (compatible; career-ops/1.3)';
const TIMEOUT_MS = 12_000;

// Roles at these employers are gated behind US security clearance or ITAR
// "US person" status, which an F-1/OPT candidate cannot hold. Discovering them
// would only fill the pipeline with postings that can never be applied to, so
// they are never auto-added. (See modes/_profile.md for the standing rule.)
export const CLEARANCE_GATED = [
  'lockheed', 'northrop', 'raytheon', 'rtx', 'general dynamics', 'l3harris',
  'huntington ingalls', 'leidos', 'booz allen', 'caci', 'saic', 'palantir',
  'transdigm', 'howmet', 'axon',
  // Defence-first companies whose engineering roles are clearance- or
  // US-person-gated almost without exception. Space and energy startups are
  // deliberately NOT here: their ITAR postings get hard-blocked individually,
  // with the quote, so the applyable minority still surfaces.
  'spacex', 'blue origin', 'anduril', 'shield ai', 'general atomics',
  'sierra nevada', 'aerovironment', 'kratos', 'epirus', 'radiance technologies',
  // Added 2026-09-08 with the curated hardware seed: defence-first startups
  // that read as commercial hard-tech from the name alone, which is exactly
  // how they would otherwise slip past this gate.
  'saronic', 'castelion', 'forterra', 'overland ai', 'hidden level',
  'firestorm labs', 'scout ai', 'applied research associates',
  // Added 2026-09-09 on MEASUREMENT rather than reputation. This list's own
  // rule is that space startups stay off it, because their ITAR postings get
  // blocked one at a time and the applyable minority still reaches him. True
  // Anomaly has no applyable minority: of the first 25 postings read, **25 of
  // 25** hard-blocked — security clearance or US-person status, every one. That
  // is 182 live postings he can never hold, and the criterion this list
  // already states ("gated almost without exception") is met.
  'true anomaly',
  // Same measurement, same answer (2026-09-10): Mach Industries returned
  // **25 of 25** read postings hard-blocked on clearance or US-person status.
  'mach industries',
];

/**
 * Is any of these strings a clearance-gated employer? (F-434)
 *
 * The gate used to read the display NAME only, and that was enough while every
 * name came from an index or a hand-written list. It stopped being enough the
 * moment names started being derived from domains: `overland-ai.com` becomes
 * "Overland", which does not contain "overland ai", so **Overland AI — a
 * defence autonomy company on this very list — was written into portals.yml
 * and scanned**, 34 postings of it.
 *
 * So every identifier the company is known by is checked, not just the pretty
 * one: the name, the site it came from, and the board URL once resolved. All of
 * them are normalised down to letters and digits first, because the difference
 * between "overland ai", "Overland-AI" and "overland_ai" is punctuation and
 * punctuation is exactly what a domain strips.
 *
 * His F-1/OPT status makes this a wall rather than a preference, so it fails
 * closed: anything that looks gated is dropped.
 */
const flatten = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const spaced = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A SHORT TERM IS NOT SAFE AS A SUBSTRING (F-440). The first version of this
// flattened both sides and asked `includes`, which fixed the domain case and
// broke the opposite one: **MosaicML** contains "saic" and **Axoni** contains
// "axon", so an AI company and a fintech were both refused as defence
// contractors. A gate that wrongly EXCLUDES costs him jobs just as surely as
// one that wrongly admits them — quietly, and without ever appearing in a
// count of anything.
//
// So the two cases are separated:
//
//   · A distinctive term (6+ characters flattened) still matches as a
//     substring, because that is what reaches through a domain —
//     "northropgrumman.wd1.myworkdayjobs.com" has no word boundary around
//     "northrop", and it must still be caught.
//   · A short one ("rtx", "saic", "caci", "axon") must sit on a word boundary.
//     "SAIC", "saic.com" and "Axon Enterprise" match; "MosaicML", "Axoni" and
//     "efficacies" do not.
const MIN_SUBSTRING = 6;
const GATE_TERMS = CLEARANCE_GATED.map((g) => {
  const flat = flatten(g);
  return {
    flat,
    // Anchored on the spaced form, where a domain's dots and hyphens have
    // become separators — so "overland-ai.com" reads as "overland ai com".
    word: new RegExp(`(?:^| )${spaced(g).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`),
  };
});

export function isClearanceGated(...identifiers) {
  return identifiers.some((id) => {
    const flat = flatten(id);
    if (!flat) return false;
    const words = spaced(id);
    return GATE_TERMS.some(({ flat: g, word }) =>
      g.length >= MIN_SUBSTRING ? flat.includes(g) : word.test(words));
  });
}

// ── tiny fetch helpers ──────────────────────────────────────────────

// A REFUSAL MUST NOT READ AS "NO BOARD" (F-444).
//
// Discovery probes nine ATSes per candidate and had no per-service limit of any
// kind — enrichment got both a concurrency cap (F-426) and a daily budget
// (F-437), and this tool, which fires far more requests per company, got
// neither. Debugging a single company on 2026-09-10 was enough to put
// `apply.workable.com` into `429`, and the DCVC re-run that followed reported
// **184 "No ATS found"** — a number that silently mixed "probed cleanly, there
// is no board" with "the ATS would not talk to us".
//
// That is the worst kind of false negative in this project: the company is
// never tracked, nothing says why, and no count anywhere records that anything
// was missed.
//
// So refusals are counted per service and surfaced in the run's own summary,
// and the pool is capped per service so a sweep cannot do this to itself.
const refusalsByService = new Map();
const withService = makeHostLimiter(Number(process.env.JARVIS_DISCOVER_PER_SERVICE) || 3);

// STOP ASKING A SERVICE THAT HAS SAID NO.
//
// The per-service concurrency cap above bounds how many requests are in flight;
// it does nothing about how many are sent, and the probe chain asks EVERY
// candidate's slug of every ATS. A 190-company run therefore makes at least 190
// requests to `apply.workable.com` alone — and measured on 2026-09-10 it
// produced **324 refusals in a single run** while never exceeding 3 concurrent.
//
// Past a handful of refusals the answer for that service is settled for this
// run: it will not talk to us, every further probe is wasted, and each one digs
// the rate limit deeper. So the service is dropped, once, loudly — and every
// company that needed it is reported as unchecked rather than as having no
// board.
const REFUSALS_BEFORE_DROP = 5;
const droppedServices = new Set();

function noteRefusal(url, status) {
  const s = serviceOf(url);
  if (!s) return;
  if (!refusalsByService.has(s)) refusalsByService.set(s, { count: 0, status });
  const rec = refusalsByService.get(s);
  rec.count += 1;
  if (rec.count >= REFUSALS_BEFORE_DROP && !droppedServices.has(s)) {
    droppedServices.add(s);
    console.error(`  ⚠  ${s} has refused ${rec.count} times (HTTP ${status}) — not asking it again this run.`);
  }
}

/** Has this service already told us to stop? */
function isDropped(url) {
  const s = serviceOf(url);
  return !!s && droppedServices.has(s);
}

// TWO KINDS OF REFUSAL, AND ONLY ONE OF THEM MATTERS.
//
// The first version of this report listed every refusing host together, which
// buried the signal: a re-check on 2026-09-10 named ten "services", and eight
// were individual COMPANY sites — fervoenergy.com, quantum-machines.co,
// enlitic.com — sitting behind Cloudflare and answering 403 to any robot. That
// is one company each, it is the normal state of the web, and it costs nothing
// beyond that company.
//
// A shared ATS refusing is a different event entirely: every candidate probed
// against it in that run is unchecked, which can be hundreds of companies at
// once. Those are the misses that are not real, and they are what the summary
// needs to put in front of a reader.
const ATS_SERVICE_RE = /(greenhouse|lever|ashbyhq|myworkdayjobs|smartrecruiters|icims|bamboohr|breezy|recruitee|workable|rippling|jobvite|taleo|eightfold|oraclecloud|paylocity|dayforce)\./i;

/** Refusals, split into shared ATSes (which invalidate misses) and one-off company sites. */
export function refusalReport() {
  const all = [...refusalsByService.entries()]
    .map(([service, v]) => ({ service, ...v }))
    .sort((a, b) => b.count - a.count);
  return {
    ats: all.filter(r => ATS_SERVICE_RE.test(r.service + '.')),
    sites: all.filter(r => !ATS_SERVICE_RE.test(r.service + '.')),
  };
}

async function req(url, { method = 'GET', body = null, headers = {} , speculative = true } = {}) {
  // A service that has already refused us this run is not asked again — but
  // only for SPECULATION.
  //
  // The breaker exists to stop nine guesses per candidate being fired at a host
  // that has said no. It must not block the opposite case: confirming a board
  // the company itself published on its own careers page. Those are one request
  // each, they are the highest-value requests the tool makes, and dropping them
  // is how Slip Robotics stayed missing after everything else was fixed — its
  // page named `apply.workable.com/slip-robotics`, and the breaker (tripped
  // earlier in the run by slug guesses) refused to look.
  if (speculative && isDropped(url)) return { ok: false, status: 429, text: '', refused: true };
  return withService(serviceOf(url), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'user-agent': UA, accept: 'application/json', ...headers },
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await res.text();
      // 429 and 403 are the host declining, and 405 is the same thing wearing an
      // odd status code (F-432). None of them is evidence that a board does not
      // exist.
      if (res.status === 429 || res.status === 403 || res.status === 405) noteRefusal(url, res.status);
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      return { ok: false, status: 0, text: '', error: err.message };
    } finally {
      clearTimeout(timer);
    }
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ── slug candidates ─────────────────────────────────────────────────

// Corporate suffixes carry no signal in an ATS slug and actively cause misses
// ("Cummins Inc" → the tenant is "cummins").
// Two different kinds of word get stripped, and conflating them caused real
// mis-bindings.
//
// LEGAL suffixes are pure incorporation noise. Removing "Inc." from "Adobe
// Inc." loses nothing — "adobe" is still the complete, distinguishing name.
//
// DESCRIPTIVE words look like noise but carry identity. Removing
// "International" from "International Paper" leaves "paper", which is NOT the
// company — and that fragment was trusted enough to bind the entry to an
// unrelated `paper` Workday tenant. Names that lose a descriptive word are
// therefore treated as fragments and must corroborate.
const LEGAL_SUFFIXES = /\b(inc|corp|corporation|co|company|companies|holdings?|group|plc|ltd|limited|llc|lp|the)\b/gi;
const DESCRIPTIVE_SUFFIXES = /\b(international|industries|technologies|technology|systems)\b/gi;
const SUFFIXES = new RegExp(`${LEGAL_SUFFIXES.source}|${DESCRIPTIVE_SUFFIXES.source}`, 'gi');

function nameWords(name) {
  // Split on EVERY non-alphanumeric run, hyphens included. Keeping
  // "Freeport-McMoRan" as a single token made the phrase check search for a
  // literal hyphen while the haystack had already been normalised to a space,
  // so the company's own careers board failed to corroborate itself.
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(SUFFIXES, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Candidates are returned with a `strong` flag, and the distinction is the
// whole reason this script can be trusted at 500-company scale.
//
// A slug built from the COMPLETE name ("lucidmotors") can realistically only
// belong to that company. A slug built from a fragment — the first word, or a
// ticker — is a coin flip: "applied" is Applied Intuition on Ashby, but it
// could as easily have been Applied Materials, and a Greenhouse board named
// "delta" belongs to whoever registered it first. Fragment slugs therefore
// only count as a hit once the board's own text corroborates the company
// name (see corroborate()). Skipping that check would silently graft another
// company's postings onto this one.
export function slugCandidates(name, ticker) {
  const words = nameWords(name);
  const out = new Map(); // slug → strong
  // A slug now reaches a HOSTNAME, not just a path: the BambooHR, Breezy and
  // Recruitee probes interpolate it as `<slug>.bamboohr.com` and friends. A
  // path segment that is merely odd is harmless; a hostname segment that is
  // odd points the request somewhere else entirely. Everything below this line
  // is built from `nameWords`, which already strips to [a-z0-9] — except the
  // ticker, which is passed through from a downloaded CSV. So the charset is
  // enforced here, once, for every candidate rather than at each probe.
  const HOST_SAFE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const add = (s, strong) => {
    if (!s || s.length < 2 || s.length > 40) return;
    if (!HOST_SAFE.test(s)) return;
    if (!out.has(s) || strong) out.set(s, strong);
  };

  // Words BEFORE suffix-stripping. Needed because the stripper is aggressive
  // by design ("Align Technology" → "align" is the right slug) but that same
  // aggression collapses genuine two-word names: "International Paper" reduces
  // to "paper", which then looked like a complete name and was trusted without
  // corroboration — binding the entry to an unrelated `paper` Workday tenant.
  // A slug is only "complete" if nothing distinguishing was thrown away.
  // Only the loss of a DESCRIPTIVE word makes the remainder a fragment;
  // dropping "Inc."/"Corporation" leaves the name intact.
  const lostWords = DESCRIPTIVE_SUFFIXES.test(String(name).toLowerCase());
  DESCRIPTIVE_SUFFIXES.lastIndex = 0; // /g regexes are stateful across .test()

  // The stripped name is only a COMPLETE identifier while it still holds more
  // than one word, or nothing was stripped from it. Once it collapses to a
  // lone word that survived stripping ("paper", "align"), it is a fragment and
  // must be corroborated like any other.
  const strippedIsComplete = words.length >= 2 || !lostWords;

  if (words.length) {
    add(words.join(''), strippedIsComplete);
    add(words.join('-'), strippedIsComplete);
    // Fragments are still worth probing — plenty of boards really are just the
    // first word — but only ever as weak candidates, so nameEvidence decides.
    if (words.length >= 2) add(words[0], false);
    if (words.length > 2) add(words.slice(0, 2).join(''), false);
  }
  add(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''), true);
  if (ticker) add(String(ticker).toLowerCase(), false);

  return [...out.entries()].map(([slug, strong]) => ({ slug, strong }));
}

// Does `text` actually look like it belongs to `name`?
//
// Requires the company name as a CONTIGUOUS PHRASE, not a bag of words. The
// looser per-word version let a real false positive through: for "Capital One"
// it discarded "one" as too short, leaving only "capital" — which the slug
// itself supplied — so `jobs.lever.co/capital`, a Cyprus crypto firm, passed
// corroboration and was written to portals.yml as Capital One.
//
// A fragment slug can always echo its own word back; only the words it does
// NOT contain carry information. Matching the whole phrase is what makes the
// check independent of the slug.
export function nameEvidence(text, name) {
  if (!text) return false;
  const words = nameWords(name);
  if (!words.length) return false;
  const hay = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  // Tolerate punctuation/spacing between the name's words ("Arthur J Gallagher").
  const phrase = new RegExp(`\\b${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\b`);
  return phrase.test(hay);
}

// ── provider probes ─────────────────────────────────────────────────
// Each returns a portals.yml-shaped entry on a verified hit, else null.

async function probeGreenhouse({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const n = Array.isArray(j?.jobs) ? j.jobs.length : 0;
  if (!n) return null;

  if (!strong) {
    // Greenhouse publishes the board's real display name — the strongest
    // corroboration available anywhere in this script. Use it.
    const meta = parseJson((await req(`https://boards-api.greenhouse.io/v1/boards/${slug}`)).text);
    const boardName = meta?.name || '';
    if (!nameEvidence(`${boardName} ${meta?.content || ''}`, name)) return null;
  }
  return {
    entry: {
      name,
      careers_url: `https://job-boards.greenhouse.io/${slug}`,
      api: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    },
    provider: 'greenhouse', count: n,
  };
}

async function probeAshby({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const jobs = Array.isArray(j?.jobs) ? j.jobs : [];
  if (!jobs.length) return null;
  if (!strong) {
    const sample = jobs.slice(0, 5).map(x => `${x.title} ${x.descriptionPlain || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://jobs.ashbyhq.com/${slug}` },
    provider: 'ashby', count: jobs.length,
  };
}

async function probeLever({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://api.lever.co/v0/postings/${slug}?mode=json`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const jobs = Array.isArray(j) ? j : [];
  if (!jobs.length) return null;
  if (!strong) {
    const sample = jobs.slice(0, 5).map(x => `${x.text || ''} ${x.additionalPlain || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://jobs.lever.co/${slug}` },
    provider: 'lever', count: jobs.length,
  };
}

// FIVE MORE BOARDS, FOR THE SAME REASON THE OTHERS ARE HERE (F-416).
//
// The first curated hardware run resolved 81 of 280 names and lost 197 to "no
// ATS found" — companies that plainly have careers pages. The probe chain was
// four boards wide while providers/ already knew twenty-four. These five are
// the ones a 50-to-500-person hardware company actually runs, and each is a
// single public GET keyed on a slug, so adding them costs one request per
// candidate and no new parsing: the scanner reuses the existing provider.
//
// The rest of providers/ stays out on purpose. Workday, iCIMS, Phenom,
// SuccessFactors and Oracle need a tenant/instance/site triple that cannot be
// guessed from a company name, and they are enterprise HR software that
// startups do not run.

async function probeRippling({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://api.rippling.com/platform/api/ats/v1/board/${slug}/jobs`, reqOpts);
  if (!r.ok) return null;
  const jobs = parseJson(r.text);
  if (!Array.isArray(jobs) || !jobs.length) return null;
  if (!strong) {
    const sample = jobs.slice(0, 5).map(x => `${x.name || ''} ${x.url || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://ats.rippling.com/${slug}/jobs` },
    provider: 'rippling', count: jobs.length,
  };
}

async function probeWorkable({ slug, strong }, name, reqOpts = {}) {
  // The public widget endpoint, not the authenticated REST API — same surface
  // providers/workable.mjs reads.
  const r = await req(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const jobs = Array.isArray(j?.jobs) ? j.jobs : [];
  if (!jobs.length) return null;
  if (!strong) {
    const sample = `${j?.name || ''} ${jobs.slice(0, 5).map(x => x.title || '').join(' ')}`;
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://apply.workable.com/${slug}` },
    provider: 'workable', count: jobs.length,
  };
}

async function probeBambooHR({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://${slug}.bamboohr.com/careers/list`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const jobs = Array.isArray(j?.result) ? j.result : [];
  if (!jobs.length) return null;
  if (!strong) {
    const sample = jobs.slice(0, 5).map(x => `${x.jobOpeningName || ''} ${x.departmentLabel || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://${slug}.bamboohr.com/careers` },
    provider: 'bamboohr', count: jobs.length,
  };
}

async function probeBreezy({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://${slug}.breezy.hr/json`, reqOpts);
  if (!r.ok) return null;
  const jobs = parseJson(r.text);
  if (!Array.isArray(jobs) || !jobs.length) return null;
  if (!strong) {
    const sample = jobs.slice(0, 5).map(x => `${x.name || ''} ${x.url || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://${slug}.breezy.hr` },
    provider: 'breezy', count: jobs.length,
  };
}

async function probeRecruitee({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://${slug}.recruitee.com/api/offers/`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const jobs = Array.isArray(j?.offers) ? j.offers : [];
  if (!jobs.length) return null;
  if (!strong) {
    const sample = jobs.slice(0, 5).map(x => `${x.title || ''} ${x.company_name || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://${slug}.recruitee.com` },
    provider: 'recruitee', count: jobs.length,
  };
}

async function probeIcims({ slug, strong }, name, reqOpts = {}) {
  // The search page sits behind a human-verification wall; the sitemap does
  // not. That is the same surface providers/icims.mjs reads, so a board that
  // answers here is a board the scanner can actually fetch.
  const r = await req(`https://${slug}.icims.com/sitemap.xml`, { headers: { accept: 'application/xml' }, ...reqOpts });
  if (!r.ok) return null;
  const locs = r.text.match(/<loc>/g)?.length ?? 0;
  // Every iCIMS sitemap carries a `/jobs/intro` entry whether or not the board
  // has a single opening, so one <loc> is an empty board, not a hit.
  const count = locs - 1;
  if (count < 1) return null;
  if (!strong) {
    // An iCIMS response says nothing about which company it belongs to, so
    // there is no text to corroborate against. The subdomain is the only
    // identity on offer — require it to contain one of the company's own slug
    // candidates, the same guard the guessed-domain Workday path uses.
    const ours = slugCandidates(name).map(c => c.slug).filter(s => s.length >= 4);
    if (!ours.some(s => slug.includes(s))) return null;
  }
  return {
    entry: { name, careers_url: `https://${slug}.icims.com`, provider: 'icims' },
    provider: 'icims', count,
  };
}

/**
 * The BRANDED iCIMS front end, on the company's own domain (F-454).
 *
 * `probeIcims` above reads `<slug>.icims.com/sitemap.xml`, and that host now
 * refuses every non-browser request — 405 to the sitemap, the search and the
 * postings alike. So the probe that used to find these boards finds nothing,
 * and eleven tracked employers went quiet without anyone noticing.
 *
 * Their candidates never saw that host anyway. Large iCIMS customers run an
 * Angular "careers-home" app on their own domain — careers.rivian.com — backed
 * by `${origin}/api/jobs?page=N&limit=M`, which is not gated at all and ships
 * the full description with every row.
 *
 * This takes an ORIGIN rather than a slug, because that is the shape of the
 * evidence: it is only ever called with a host the company's own site led us
 * to, never with a guess. There is no slug to invent here.
 */

/**
 * Does this /api/jobs body actually look like an iCIMS careers-home board?
 *
 * Split out of probeCareersHome so the shape check is testable without a
 * network call. The risk it guards is small but real: plenty of sites answer
 * /api/jobs with SOMETHING, and treating a random array called  as a
 * board would file a stranger's endpoint as an employer's careers site.
 */
export function isCareersHomePayload(j) {
  if (!j || !Array.isArray(j.jobs) || !Number.isFinite(j.count) || j.count < 1) return false;
  const first = j.jobs[0] && j.jobs[0].data;
  return !!(first && (first.req_id || first.slug) && first.title);
}

async function probeCareersHome(origin, name, reqOpts = {}) {
  // Never the gated host — that is probeIcims's business, and asking here
  // would spend a request to be told 405.
  if (/.icims.com$/i.test(new URL(origin).hostname)) return null;
  const r = await req(`${origin}/api/jobs?page=1&limit=1`, { headers: { accept: 'application/json' }, ...reqOpts });
  if (!r.ok) return null;
  const j = parseJson(r.text);
  if (!isCareersHomePayload(j)) return null;
  return {
    entry: { name, careers_url: origin, provider: 'icims-careers' },
    provider: 'icims-careers', count: j.count,
  };
}

async function probeSmartRecruiters({ slug, strong }, name, reqOpts = {}) {
  const r = await req(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=10`, reqOpts);
  if (!r.ok) return null;
  const j = parseJson(r.text);
  const n = Number(j?.totalFound ?? (Array.isArray(j?.content) ? j.content.length : 0));
  if (!n) return null;
  if (!strong) {
    const sample = (Array.isArray(j?.content) ? j.content : [])
      .slice(0, 5).map(x => `${x.name || ''} ${x.company?.name || ''}`).join(' ');
    if (!nameEvidence(sample, name)) return null;
  }
  return {
    entry: { name, careers_url: `https://jobs.smartrecruiters.com/${slug}` },
    provider: 'smartrecruiters', count: n,
  };
}

// Workday ------------------------------------------------------------

const WD_INSTANCES = ['wd1', 'wd3', 'wd5', 'wd2', 'wd12', 'wd101', 'wd103'];
const BOGUS_SITE = 'ZZPROBE';

// Every Workday tenant serves a robots.txt that names its live career sites
// verbatim, in both `Sitemap:` and `Allow:` lines:
//
//   Sitemap: https://adobe.wd5.myworkdayjobs.com/external_experienced/siteMap.xml
//   Allow: /external_experienced/
//
// One GET therefore returns the exact site paths, which beats guessing: site
// names are branded free-text ("external_experienced", "NVIDIAExternalCareerSite",
// "ASMLEXT1") and no candidate list will ever cover them.
async function sitesFromRobots(tenant, instance) {
  const r = await req(`https://${tenant}.${instance}.myworkdayjobs.com/robots.txt`, {
    headers: { accept: 'text/plain' },
  });
  if (!r.ok) return [];
  const sites = new Set();
  for (const m of r.text.matchAll(/^\s*Sitemap:\s*https?:\/\/[^/]+\/([^/\s]+)\//gim)) sites.add(m[1]);
  for (const m of r.text.matchAll(/^\s*Allow:\s*\/([^/\s]+)\//gim)) sites.add(m[1]);
  // Workday's own plumbing paths, never career sites.
  return [...sites].filter(s => !/^(refreshFacet|wday|assets|static|images)$/i.test(s));
}

// Fallback only, for a tenant whose robots.txt is missing or empty.
function siteCandidates(tenant) {
  const T = tenant.charAt(0).toUpperCase() + tenant.slice(1);
  return [
    'External', 'Careers', 'careers', 'Search', 'External_Career_Site',
    'ExternalCareerSite', 'External_Careers', 'Jobs', 'jobs',
    `${T}Careers`, `${T}_Careers`, `${tenant}careers`, tenant, T,
    `${T}External`, `${T}ExternalCareerSite`, `${T}_External`,
    'CAREERS', 'External_Site', 'Professional',
  ];
}

async function cxs(tenant, instance, site) {
  return req(
    `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 1, offset: 0, searchText: '', appliedFacets: {} }),
    },
  );
}

async function probeWorkday({ slug, strong }, name, reqOpts = {}) {
  // Workday's CXS response carries no company name, so there is nothing to
  // corroborate a fragment slug against — and `applied.wd1` would happily
  // return some other Applied's postings. Only full-name tenants are trusted.
  if (!strong) return null;

  // Stage 1 — does this (tenant, instance) exist at all? A live tenant given a
  // nonexistent site answers 404/S21; a dead one answers 422.
  let liveInstance = null;
  for (const instance of WD_INSTANCES) {
    const r = await cxs(slug, instance, BOGUS_SITE);
    if (r.status === 404 && /Job_Posting_Site_ID/.test(r.text)) { liveInstance = instance; break; }
    if (r.status === 200) { liveInstance = instance; break; } // improbable, but a hit is a hit
  }
  if (!liveInstance) return null;

  // Stage 2 — ask the tenant which sites it has, and only guess if it won't say.
  const declared = await sitesFromRobots(slug, liveInstance);
  const sites = declared.length ? declared : siteCandidates(slug);

  // A tenant often runs several sites (experienced / university / contractor).
  // Pick the largest rather than the first: that is the main external board,
  // and a 3-posting university site would otherwise shadow a 3000-job one.
  let best = null;
  for (const site of sites) {
    const r = await cxs(slug, liveInstance, site);
    if (r.status === 429) break; // backing off beats hammering a live tenant
    if (!r.ok) continue;
    const total = Number(parseJson(r.text)?.total ?? 0);
    if (total && (!best || total > best.count)) best = { site, count: total };
  }
  if (best) {
    return {
      entry: { name, careers_url: `https://${slug}.${liveInstance}.myworkdayjobs.com/${best.site}` },
      provider: 'workday', count: best.count,
    };
  }
  // Tenant confirmed but no site matched — report it so it can be filled in by
  // hand rather than vanishing as "no ATS found".
  return { partial: true, provider: 'workday', tenant: slug, instance: liveInstance, name };
}

// ── per-company resolution ──────────────────────────────────────────

// A board this small is almost never the company's main careers site — it is
// usually a stale or single-team board that happens to own the slug.
// Caterpillar, for instance, matches a 1-posting SmartRecruiters board while
// its real site (thousands of jobs) is elsewhere entirely. Below this
// threshold we keep looking instead of declaring victory.
const MIN_CONFIDENT = 10;

async function resolveCompany({ name, ticker, skipWorkday = false, seeded = false, site = '', siteGuessed = false }) {
  const slugs = slugCandidates(name, ticker);
  let partial = null;
  let best = null;
  // The "is this really their main board?" threshold only makes sense for large
  // employers, where a 1-posting board means the real careers site is elsewhere.
  // A seeded startup with four openings is simply a startup with four openings,
  // so applying the same bar would flag almost the entire cohort as suspect.
  // Two independent questions that used to share one flag. "Is this a startup,
  // so a four-posting board is the real board?" is about the company. "Should
  // Workday be probed?" is about cost. They came apart the moment a seed list
  // held scale-ups: the curated hardware list needs Workday probed AND needs
  // the low bar, because it runs from Rivian down to a twelve-person shop.
  const minConfident = (seeded || skipWorkday) ? 1 : MIN_CONFIDENT;
  const consider = (hit) => {
    if (hit?.entry && (!best || hit.count > best.count)) best = hit;
    return hit?.entry && hit.count >= minConfident;
  };

  // ASK THE COMPANY BEFORE GUESSING AT NINE STRANGERS (F-445).
  //
  // The slug chain probes every ATS for every candidate, so a 184-company run
  // makes 184 requests to `apply.workable.com` — and Workable rate-limits an IP
  // long before that. Measured 2026-09-10: three separate runs, every one of
  // them tripping 429 and losing every Workable-hosted company in the batch to
  // a miss that was never a miss.
  //
  // When the company's OWN site is known and published, that is both cheaper
  // and better. Its careers page names the exact board — no guessing — and the
  // requests go to its own domain rather than piling onto one shared host, so a
  // batch of two hundred companies is two hundred separate small conversations
  // instead of two hundred knocks on the same door.
  //
  // Only for an AUTHORITATIVE site. A guessed `<name>.com` has to earn its
  // answer the slow way, because a wrong domain would otherwise bind a real
  // board to the wrong company.
  if (site && !siteGuessed) {
    const followed = await resolveViaCareersPage(site, name, { authoritative: true });
    if (followed?.entry) return followed;
  }

  // Strong slugs first across every provider: a full-name match anywhere beats
  // a fragment match, so an unambiguous hit is never pre-empted by a lucky one.
  for (const cand of [...slugs].sort((a, b) => Number(b.strong) - Number(a.strong))) {
    for (const probe of [
      probeGreenhouse, probeAshby, probeLever, probeSmartRecruiters,
      probeRippling, probeWorkable, probeBambooHR, probeBreezy, probeRecruitee,
    ]) {
      if (consider(await probe(cand, name))) return best;
    }
  }
  // Workday last: it is the most expensive probe (POSTs, two stages). Seeded
  // startups skip it outright — a Workday tenant is enterprise HR software that
  // essentially no VC-portfolio company runs, so probing 7 instances per slug
  // across a thousand of them buys nothing and costs the bulk of the runtime.
  if (skipWorkday) {
    if (best) return best;
    const followed = site ? await resolveViaCareersPage(site, name, { authoritative: !siteGuessed }) : null;
    return followed || { miss: true, name };
  }
  for (const cand of slugs) {
    const hit = await probeWorkday(cand, name);
    if (consider(hit)) return best;
    if (hit?.partial && !partial) partial = hit;
  }
  // Nothing convincing. A thin board still beats nothing, but it is marked so
  // it can be reviewed rather than trusted.
  if (best) return { ...best, thin: true };
  // A Workday tenant with an unknown site path is a real lead; the careers page
  // is only worth a fetch when even that came up empty.
  if (!partial && site) {
    const followed = await resolveViaCareersPage(site, name, { authoritative: !siteGuessed });
    if (followed) return followed;
  }
  return partial || { miss: true, name };
}

// ── concurrency pool ────────────────────────────────────────────────

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── the careers page as a last resort ───────────────────────────────
//
// GUESSING THE SLUG FROM THE NAME HAS A FLOOR (F-416). Commonwealth Fusion
// Systems runs a 95-posting Lever board at `cfsenergy` — a slug no amount of
// name-mangling reaches, because it is not the company's name. Every
// slug-shaped guess for that company was always going to miss.
//
// A company's own careers page does not have to be guessed at. It links
// straight to whichever board it uses, and that link carries the real slug.
// This is deliberately the LAST thing tried: it costs a full HTML fetch, the
// slug probes are cheap and answer for most companies, and a careers page can
// link to a recruiter's board as easily as its own — so whatever is found here
// still goes through the same probe, and is only accepted if that probe
// corroborates the company name exactly as it would for any other candidate.

/** Board URL shapes worth recognising, in the order they are worth trusting. */
const BOARD_PATTERNS = [
  { provider: 'greenhouse', re: /(?:job-boards|boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'greenhouse', re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'ashby', re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'lever', re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'smartrecruiters', re: /jobs\.smartrecruiters\.com\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'rippling', re: /ats\.rippling\.com\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'workable', re: /apply\.workable\.com\/([a-z0-9][a-z0-9-]{1,39})/gi },
  { provider: 'bamboohr', re: /([a-z0-9][a-z0-9-]{1,39})\.bamboohr\.com/gi },
  { provider: 'breezy', re: /([a-z0-9][a-z0-9-]{1,39})\.breezy\.hr/gi },
  { provider: 'recruitee', re: /([a-z0-9][a-z0-9-]{1,39})\.recruitee\.com/gi },
  // iCIMS earns its place here rather than in the slug probes. Its subdomains
  // are abbreviations nobody can derive from a company name — Parker Hannifin
  // runs `careers-parker`, Aurora Innovation runs `careers-aurora` — so
  // guessing is hopeless and reading the link off the careers page is the only
  // route. Joby's page names `careers-jobyaviation.icims.com` outright.
  { provider: 'icims', re: /([a-z0-9][a-z0-9-]{1,60})\.icims\.com/gi },
];

/**
 * Workday is matched separately because its identity is a (tenant, instance,
 * site) triple rather than a slug — and because a careers page hands over all
 * three for free, which is precisely what the two-stage guessing probe spends
 * dozens of requests trying to reconstruct. Boston Dynamics is the case:
 * bostondynamics.com/careers links straight at its Workday site, while every
 * name-derived tenant guess missed.
 *
 * The optional `en-US/` segment appears on localised boards and is not part of
 * the site id.
 */
const WORKDAY_LINK_RE =
  /([a-z0-9][a-z0-9-]{1,39})\.(wd\d{1,3})\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]{2,60})/g;

/**
 * Every Workday board a page points at.
 * @param {string} html
 * @returns {Array<{tenant: string, instance: string, site: string}>}
 */
export function workdayLinksIn(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  const seen = new Set();
  WORKDAY_LINK_RE.lastIndex = 0;
  for (const m of html.matchAll(WORKDAY_LINK_RE)) {
    const [, tenant, instance, site] = m;
    // `wday` is the API path prefix, not a site id.
    if (site === 'wday') continue;
    const key = `${tenant}.${instance}/${site}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tenant, instance, site });
  }
  return out;
}

// Slugs that are the ATS vendor talking about itself, not a customer board.
const BOARD_NOISE = new Set([
  'embed', 'www', 'api', 'app', 'jobs', 'careers', 'job-boards', 'boards',
  'help', 'support', 'blog', 'about', 'my', 'account', 'login', 'signup',
  'resources', 'partners', 'developers', 'status', 'legal', 'privacy',
]);

/**
 * Every ATS board link a page mentions, de-duplicated, in pattern order.
 * Pure — the tests feed it fixtures rather than a live careers page.
 *
 * @param {string} html
 * @returns {Array<{provider: string, slug: string}>}
 */
export function boardLinksIn(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  const seen = new Set();
  for (const { provider, re } of BOARD_PATTERNS) {
    re.lastIndex = 0; // /g regexes are stateful across calls
    for (const m of html.matchAll(re)) {
      const slug = String(m[1] || '').toLowerCase();
      if (!slug || BOARD_NOISE.has(slug)) continue;
      const key = `${provider}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider, slug });
    }
  }
  return out;
}

const PROBE_BY_PROVIDER = {
  greenhouse: probeGreenhouse,
  ashby: probeAshby,
  lever: probeLever,
  smartrecruiters: probeSmartRecruiters,
  rippling: probeRippling,
  workable: probeWorkable,
  bamboohr: probeBambooHR,
  breezy: probeBreezy,
  recruitee: probeRecruitee,
  icims: probeIcims,
};

/** Where a company is likely to have put its openings. */
const CAREERS_PATHS = ['/careers', '/jobs', '/careers/', '/company/careers', '/about/careers', '/'];

/**
 * Follow a company's own site to whatever board it links to.
 *
 * @param {string} site  The company's website, from the seed list.
 * @param {string} name  For corroboration — the found board still has to prove itself.
 */
async function resolveViaCareersPage(site, name, { authoritative = true } = {}) {
  let origin;
  try {
    const u = new URL(site.startsWith('http') ? site : `https://${site}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    origin = u.origin;
  } catch { return null; }

  const tried = new Set();
  for (const p of CAREERS_PATHS) {
    // Fetching the company's OWN careers page is never speculation about a
    // shared host — it is one request to that company's domain, and it is the
    // request that tells us which ATS to confirm.
    const r = await req(`${origin}${p}`, { headers: { accept: 'text/html' }, speculative: false });
    if (!r.ok || !r.text) continue;
    for (const { provider, slug } of boardLinksIn(r.text)) {
      const key = `${provider}:${slug}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const probe = PROBE_BY_PROVIDER[provider];
      if (!probe) continue;
      // WHERE THE EVIDENCE COMES FROM DECIDES HOW FAR IT CARRIES.
      //
      // `authoritative` — a website the seed list published, or one Alex wrote
      // down — means the company itself named this board, which is stronger
      // evidence than its name appearing in a job description. Commonwealth
      // Fusion is why that matters: cfs.energy/careers links at
      // jobs.lever.co/cfsenergy, 95 real postings, and the corroboration check
      // threw it away because the first titles on that board are
      // "Administrative Assistant" and "Assembly Process Engineer" and neither
      // says "Commonwealth Fusion Systems". The company had already identified
      // its own board; asking the board to identify the company again only
      // discarded the answer.
      //
      // A GUESSED domain earns none of that. `<name>.com` is a hypothesis, and
      // a wrong one lands on a squatter, a namesake or an unrelated business
      // that may well have a careers page of its own — so the board it points
      // at has to name the company before it is believed, exactly like any
      // other guess. This is the difference between finding a board and
      // inventing one.
      const hit = await probe({ slug, strong: authoritative }, name, { speculative: false });
      if (hit?.entry) return hit;
    }

    // Workday last, and verified against the triple the page supplied rather
    // than a guessed one — no tenant search, one request.
    for (const { tenant, instance, site } of workdayLinksIn(r.text)) {
      const key = `workday:${tenant}.${instance}/${site}`;
      if (tried.has(key)) continue;
      tried.add(key);
      // A Workday board carries no company name in its response, so there is
      // nothing to corroborate against — which is fine when the company's own
      // published site linked it, and not fine when the domain was a guess.
      // In that case the tenant itself has to look like the company, or a
      // wrong `<name>.com` would hand us a stranger's entire job board.
      if (!authoritative) {
        const ours = new Set(slugCandidates(name).map(c => c.slug));
        if (!ours.has(tenant.toLowerCase())) continue;
      }
      const w = await cxs(tenant, instance, site);
      if (!w.ok) continue;
      const total = Number(parseJson(w.text)?.total ?? 0);
      if (!total) continue;
      return {
        entry: { name, careers_url: `https://${tenant}.${instance}.myworkdayjobs.com/${site}` },
        provider: 'workday', count: total,
      };
    }
  }
  return null;
}

// ── company sources ─────────────────────────────────────────────────

function parseCsv(text) {
  // Minimal RFC4180 reader — enough for this one file (quoted commas in the
  // Headquarters column are the only wrinkle).
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Tags/industries that mean a startup actually builds physical things. YC and
// a16z portfolios run to thousands of companies, the overwhelming majority of
// them B2B SaaS with no mechanical-engineering surface whatsoever. Probing all
// of them would cost hours of requests to add companies that will never post a
// relevant role, so the seed list is filtered before any network work happens.
// Tuned once against a real YC run. "healthcare" and "biotech" were in the
// first version and were far too broad — YC tags every telehealth and
// claims-billing SaaS with them, which flooded the results with companies that
// will never post a mechanical role. "medical device" and "hard tech" capture
// the physical-product subset without the digital-health tail.
export const HARDWARE_TAGS = [
  'hardware', 'hard tech', 'robotics', 'manufacturing', 'aerospace', 'space',
  'drones', 'autonomous', 'self-driving', 'automotive', 'electric vehicle',
  'energy', 'climate', 'nuclear', 'semiconductor', 'supply chain', 'logistics',
  'construction', 'medical device', 'medical devices', 'industrial',
  'agriculture', 'iot', '3d printing', 'materials', 'batteries',
  'transportation', 'aviation', 'mining', 'oil and gas', 'sensors',
  'manufacturing automation', 'warehouse',
];

export function looksHardware(company) {
  const hay = [
    ...(company.tags || []),
    ...(company.industries || []),
    company.oneLiner || '',
  ].join(' ').toLowerCase();
  return HARDWARE_TAGS.some(t => hay.includes(t));
}

async function loadSeeds(sources, { hardwareOnly = true } = {}) {
  const { SEED_SOURCES } = await import(pathToFileURL(path.join(ROOT, 'seeds', 'vc-portfolios.mjs')).href);
  const out = [];
  for (const key of sources) {
    const src = SEED_SOURCES[key];
    if (!src) { console.error(`  ⚠ unknown seed source "${key}" (have: ${Object.keys(SEED_SOURCES).join(', ')})`); continue; }
    let list = [];
    try { list = await src.fetch(); } catch (err) { console.error(`  ⚠ ${key} seed fetch failed: ${err.message}`); continue; }
    // An empty source is a broken source, and the difference matters: for six
    // months "0 companies after filtering" read as "this firm funds no
    // hardware" when it meant "the parser stopped matching" (F-417).
    if (!list.length) {
      console.error(`  ⚠ ${src.label}: returned 0 companies — treat this as BROKEN, not empty.`);
      continue;
    }
    const active = list.filter(c => !c.status || /active/i.test(c.status));
    const kept = hardwareOnly ? active.filter(looksHardware) : active;
    console.error(`  · ${src.label}: ${list.length} companies → ${kept.length} after filtering`);
    out.push(...kept.map(c => ({
      name: c.name,
      sector: `Startup (${key}${c.batch ? ' ' + c.batch : ''})`,
      // Workday is skipped for a VC portfolio because a seed-stage company
      // does not run enterprise HR software, and probing seven instances per
      // slug across a thousand of them is the bulk of the runtime for no hits.
      // The curated hardware list is not that list: it deliberately holds
      // scale-ups and public companies — Rivian, Enovix, Plug Power, Planet
      // Labs — and skipping Workday there threw away the boards it was written
      // to find. The first run lost 181 of 280 names, most of them to this.
      skipWorkday: key !== 'hardware',
      seeded: true,
      // The seed's own website, so resolveCompany can follow it to whatever
      // board the company links to when no slug guess lands. YC publishes one
      // for essentially every company; the curated list carries them only
      // where the slug was known to be unguessable.
      //
      // Withheld from the long tail on purpose. Following a careers page costs
      // up to six HTML fetches, and most of the YC hardware cohort is three
      // people with no board of any kind — 1,088 of them failed every slug
      // probe on 2026-09-08. A company that says it is hiring, or has enough
      // people to need an ATS, is worth the fetches; the rest are not, and
      // will be picked up on a later run once either becomes true. The curated
      // list is exempt: every name on it was written down deliberately.
      site: (key === 'hardware' || c.isHiring || (c.teamSize || 0) >= 10)
        ? (c.url || c.website || '')
        : '',
    })));
  }
  return out;
}

async function loadSp500() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  let csv;
  const r = await req(SP500_URL, { headers: { accept: 'text/csv' } });
  if (r.ok && r.text.length > 1000) {
    csv = r.text;
    writeFileSync(SP500_CACHE, csv);
  } else if (existsSync(SP500_CACHE)) {
    csv = readFileSync(SP500_CACHE, 'utf-8');
    console.error('  ⓘ constituents fetch failed — using cached copy.');
  } else {
    throw new Error(`cannot fetch S&P 500 list (${r.status}) and no cache at ${SP500_CACHE}`);
  }
  const rows = parseCsv(csv);
  const header = rows.shift() || [];
  const iSym = header.indexOf('Symbol');
  const iName = header.indexOf('Security');
  const iSector = header.indexOf('GICS Sector');
  return rows
    .filter(r => r[iName])
    .map(r => ({ ticker: r[iSym], name: r[iName], sector: r[iSector] }));
}

// THE MID- AND SMALL-CAP INDEX IS WHERE HIS JOB ACTUALLY IS (F-418).
//
// `--sp500` covers the large caps. But a mechanical new grad is not
// disproportionately hired by the 500 biggest companies in America — he is
// hired by the industrial base one tier down: Regal Rexnord, Chart Industries,
// Franklin Electric, Watts Water, EnPro, Kadant, Barnes. Those are S&P 400 and
// S&P 600 constituents, 1,000 US employers that discovery could not name.
//
// Neither index is published as a CSV the way the 500 is, so these come from
// Wikipedia's constituent tables — the same Symbol / Security / GICS Sector
// columns, in HTML. The parser is deliberately cell-based rather than a
// text-scrape: a `<td>` boundary is a stable contract even when the markup
// around it is restyled, and the loader refuses a result that comes back
// implausibly small rather than reporting a shrunken index as the truth.

const WIKI_INDEX_URLS = {
  sp400: 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies',
  sp600: 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies',
};

/**
 * Constituents out of a Wikipedia index page.
 * Pure, so the tests can feed it a fixture rather than the live page.
 *
 * @param {string} html
 * @returns {Array<{ticker: string, name: string, sector: string}>}
 */
export function parseWikiConstituents(html) {
  if (typeof html !== 'string' || !html) return [];
  const table = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/);
  if (!table) return [];

  const cellText = (cell) => cell
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const out = [];
  const seen = new Set();
  for (const row of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => cellText(c[1]));
    if (cells.length < 3) continue;
    const [ticker, name, sector] = cells;
    // The header row identifies itself; so does any nested table's header.
    if (!name || /^security$/i.test(name) || /^symbol$/i.test(ticker)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ticker, name, sector });
  }
  return out;
}

/**
 * @param {'sp400'|'sp600'} which
 */
async function loadWikiIndex(which) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const cache = path.join(CACHE_DIR, `${which}-constituents.json`);
  const r = await req(WIKI_INDEX_URLS[which], { headers: { accept: 'text/html' } });
  const rows = r.ok ? parseWikiConstituents(r.text) : [];

  // An index of 400 or 600 companies that parses to a handful is a changed
  // page, not a shrunken index — the same failure mode as the a16z scraper
  // (F-417), and it has to be as loud. The cache is the fallback so one bad
  // fetch costs nothing.
  if (rows.length >= 200) {
    writeFileSync(cache, JSON.stringify(rows, null, 2));
    return rows;
  }
  if (existsSync(cache)) {
    console.error(`  ⓘ ${which} parsed to ${rows.length} companies — using the cached copy.`);
    return JSON.parse(readFileSync(cache, 'utf-8'));
  }
  throw new Error(
    `${which}: parsed ${rows.length} companies from ${r.text.length} bytes and no cache at ${cache} — ` +
    `the Wikipedia table layout has changed and parseWikiConstituents needs updating`);
}

// ── portals.yml I/O ─────────────────────────────────────────────────

// Names AND careers URLs. Name-only matching is not enough: the index lists
// "Stryker Corporation" where portals.yml already had "Stryker", so a name
// check alone re-adds the same Workday board under a second entry and every
// scan then fetches it twice.
function existingEntries() {
  if (!existsSync(PORTALS_PATH)) return { names: new Set(), urls: new Set() };
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const list = Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : [];
  return {
    names: new Set(list.map(c => String(c?.name || '').toLowerCase().trim()).filter(Boolean)),
    urls: new Set(list.map(c => String(c?.careers_url || '').toLowerCase().replace(/\/+$/, '')).filter(Boolean)),
  };
}

function renderEntry(hit, sector) {
  const e = hit.entry;
  const lines = [`  - name: ${JSON.stringify(e.name)}`];
  // Pinned when the probe knows which adapter answered. Detection normally
  // derives the ATS from the careers URL, but that is a first-match-wins scan
  // over every provider, and an iCIMS host is exactly the kind of URL a
  // generic sitemap adapter would claim first — naming the provider removes
  // the race rather than relying on file ordering to settle it.
  if (e.provider) lines.push(`    provider: ${e.provider}`);
  lines.push(`    careers_url: ${e.careers_url}`);
  if (e.api) lines.push(`    api: ${e.api}`);
  const prefix = sector ? `${sector}. ` : '';
  const thin = hit.thin ? ' UNVERIFIED: only a handful of postings - likely NOT the main careers board, review before trusting.' : '';
  lines.push(`    notes: ${JSON.stringify(`${prefix}Auto-discovered via ${hit.provider} (${hit.count} postings live at discovery).${thin}`)}`);
  lines.push('    enabled: true');
  return lines.join('\n');
}

function appendToPortals(block) {
  const src = readFileSync(PORTALS_PATH, 'utf-8');
  const marker = '\ntracked_companies:';
  const at = src.indexOf(marker);
  if (at === -1) throw new Error('portals.yml has no tracked_companies: key');
  const insertAt = at + marker.length;
  const stamp = `\n\n  # ── Auto-discovered by jarvis/discover-ats.mjs (${new Date().toISOString().slice(0, 10)}) ──\n`;
  const next = src.slice(0, insertAt) + stamp + block + '\n' + src.slice(insertAt);
  writeFileSync(PORTALS_PATH, next);
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const useSp500 = args.includes('--sp500');
  const namesFlag = args.indexOf('--names');
  const limitFlag = args.indexOf('--limit');
  const concFlag = args.indexOf('--concurrency');
  const concurrency = concFlag !== -1 ? Number(args[concFlag + 1]) || 8 : 8;

  const sectorsFlag = args.indexOf('--sectors');
  const exclSectorsFlag = args.indexOf('--exclude-sectors');
  const parseList = (i) => (i === -1 ? null : String(args[i + 1] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const onlySectors = parseList(sectorsFlag);
  const dropSectors = parseList(exclSectorsFlag);

  let companies = [];
  const indexes = [];
  if (useSp500) indexes.push(['S&P 500', loadSp500]);
  if (args.includes('--sp400')) indexes.push(['S&P 400 (mid cap)', () => loadWikiIndex('sp400')]);
  if (args.includes('--sp600')) indexes.push(['S&P 600 (small cap)', () => loadWikiIndex('sp600')]);
  for (const [label, load] of indexes) {
    const rows = await load();
    console.error(`  · ${label}: ${rows.length} constituents`);
    // A GUESSED HOMEPAGE, AND LABELLED AS ONE. An index gives a name, a ticker
    // and a sector — never a website. But `<compactname>.com` is right often
    // enough for US public companies (aaon.com, flowserve.com,
    // acuitybrands.com) to be worth one HTML fetch AFTER every cheaper probe
    // has already failed, and it is the only way to reach the boards whose
    // slug is an abbreviation nothing can derive — iCIMS runs
    // `careers-parker` for Parker Hannifin, and no amount of name-mangling
    // produces that.
    //
    // `siteGuessed` is not decoration. It downgrades whatever the page links
    // to from "the company named this board" to "something on a domain we
    // guessed named this board", so the board must still say the company's
    // name back. Without that distinction a wrong `<name>.com` would hand us a
    // namesake's entire job board under this company's name.
    companies.push(...rows.map(r => ({
      ...r,
      site: `https://${String(r.name).toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
      siteGuessed: true,
    })));
  }
  if (indexes.length) {
    if (onlySectors) companies = companies.filter(c => onlySectors.includes(String(c.sector || '').toLowerCase()));
    if (dropSectors) companies = companies.filter(c => !dropSectors.includes(String(c.sector || '').toLowerCase()));
    // A company can sit in two indexes across a rebalance, and probing the
    // same name twice is pure cost.
    const byName = new Map();
    for (const c of companies) if (!byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c);
    companies = [...byName.values()];
  }

  const seedsFlag = args.indexOf('--seeds');
  if (seedsFlag !== -1) {
    const sources = String(args[seedsFlag + 1] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    companies.push(...await loadSeeds(sources, { hardwareOnly: !args.includes('--all-startups') }));
  }

  // VC PORTFOLIOS, READ AS DOMAINS (F-433). A portfolio page links to each
  // company's own site whatever framework it is built in, and a domain is a
  // better input than a name: the careers-page route reaches boards whose slug
  // no name-mangling produces. The site is AUTHORITATIVE — it is the company's
  // own domain, not a `<name>.com` guess — so a board linked from it is
  // believed the way Commonwealth Fusion's was.
  const vcFlag = args.indexOf('--vc');
  if (vcFlag !== -1) {
    const { VC_SITES, VC_CMS, fetchVcSiteHosts, nameFromHost } =
      await import(pathToFileURL(path.join(ROOT, 'seeds', 'vc-sites.mjs')).href);
    const firms = String(args[vcFlag + 1] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const seen = new Set();

    // A CMS-backed firm first, where one exists: it hands over the REAL company
    // name alongside the URL, and "Redwood Materials" beats "Redwoodmaterials"
    // derived from a domain. Link-scraping is the fallback, not the goal.
    for (const key of firms.length ? firms : Object.keys(VC_CMS)) {
      const src = VC_CMS[key];
      if (!src) continue;
      let rows = [];
      try { rows = await src.fetch(); }
      catch (err) { console.error(`  ⚠ ${src.label}: fetch failed — ${err.message}`); continue; }
      if (!rows.length) { console.error(`  ⚠ ${src.label}: returned 0 companies — treat as BROKEN, not empty.`); continue; }
      console.error(`  · ${src.label}: ${rows.length} companies`);
      for (const r of rows) {
        const host = (() => { try { return new URL(r.site).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        if (host) { if (seen.has(host)) continue; seen.add(host); }
        companies.push({
          name: r.name,
          sector: `Startup (${key})`,
          // A site the FIRM published is the company's own address, so a board
          // linked from it is authoritative. With no site we fall back to a
          // guessed `<name>.com`, which is not — hence the flag.
          site: r.site || `https://${r.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
          siteGuessed: !r.site,
          seeded: true,
        });
      }
    }

    for (const key of firms.length ? firms : Object.keys(VC_SITES)) {
      if (VC_CMS[key]) continue;   // already read from its CMS, above
      if (!VC_SITES[key]) { console.error(`  ⚠ unknown firm "${key}" (have: ${[...new Set([...Object.keys(VC_SITES), ...Object.keys(VC_CMS)])].join(', ')})`); continue; }
      let hosts = [];
      try { hosts = await fetchVcSiteHosts(key); }
      catch (err) { console.error(`  ⚠ ${VC_SITES[key].label}: fetch failed — ${err.message}`); continue; }
      // Zero is broken, not empty (F-417): these pages render their portfolio
      // client-side and a silent 0 reads as "this firm funds nobody".
      if (!hosts.length) {
        console.error(`  ⚠ ${VC_SITES[key].label}: 0 company domains — the portfolio is rendered client-side, not missing.`);
        continue;
      }
      const fresh = hosts.filter(h => !seen.has(h));
      for (const h of fresh) seen.add(h);
      console.error(`  · ${VC_SITES[key].label}: ${hosts.length} company domains (${fresh.length} new)`);
      companies.push(...fresh.map(h => ({
        name: nameFromHost(h),
        sector: `Startup (${key})`,
        site: `https://${h}`,
        seeded: true,
      })));
    }
  }
  if (namesFlag !== -1) {
    // An ad-hoc name gets the same guessed homepage an index constituent does,
    // and is labelled a guess for the same reason: it is the only way to reach
    // a board whose slug cannot be derived, and it must not be trusted as if
    // the company had published it.
    companies.push(...String(args[namesFlag + 1] || '').split(',').map(s => s.trim()).filter(Boolean).map(name => ({
      name,
      site: `https://${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
      siteGuessed: true,
    })));
  }
  if (!companies.length) {
    console.error('Nothing to resolve. Pass --sp500, --seeds yc,a16z, and/or --names "A,B".');
    process.exit(1);
  }

  const known = existingEntries();
  const skippedGated = [];
  const skippedKnown = [];
  companies = companies.filter(c => {
    const lower = c.name.toLowerCase();
    if (isClearanceGated(c.name, c.site)) { skippedGated.push(c.name); return false; }
    if (known.names.has(lower)) { skippedKnown.push(c.name); return false; }
    return true;
  });

  if (limitFlag !== -1) companies = companies.slice(0, Number(args[limitFlag + 1]) || companies.length);

  console.error(`Resolving ${companies.length} companies (concurrency ${concurrency})…`);
  if (skippedKnown.length) console.error(`  · ${skippedKnown.length} already in portals.yml — skipped.`);
  if (skippedGated.length) console.error(`  · ${skippedGated.length} clearance/ITAR-gated — skipped: ${skippedGated.slice(0, 6).join(', ')}${skippedGated.length > 6 ? ', …' : ''}`);

  let done = 0;
  const results = await mapPool(companies, concurrency, async (c) => {
    const r = await resolveCompany(c);
    done++;
    if (r.entry) process.stderr.write(`  ✓ ${c.name} → ${r.provider} (${r.count})\n`);
    else if (r.partial) process.stderr.write(`  ~ ${c.name} → workday tenant ${r.tenant}.${r.instance}, site unknown\n`);
    if (done % 25 === 0) process.stderr.write(`  … ${done}/${companies.length}\n`);
    return { ...r, sector: c.sector };
  });

  // Drop hits that landed on a board portals.yml already tracks under another
  // name, and on a board another hit in THIS run already claimed.
  const claimed = new Set(known.urls);
  const dupes = [];
  const gatedLate = [];
  const hits = results.filter(r => {
    if (!r.entry) return false;
    const key = String(r.entry.careers_url).toLowerCase().replace(/\/+$/, '');
    // THE BOARD URL IS THE LAST WORD ON IDENTITY (F-434). A company can reach
    // this point under a name that hides what it is — "Overland" resolving to
    // `ats.rippling.com/overland-ai/jobs` — and the board slug is the company's
    // own spelling of itself, so it is checked here even though the name was
    // checked before any request was spent.
    if (isClearanceGated(r.entry.name, key)) { gatedLate.push(`${r.entry.name} (${key})`); return false; }
    if (claimed.has(key)) { dupes.push(r.entry.name); return false; }
    claimed.add(key);
    return true;
  });
  if (gatedLate.length) console.error(`  · ${gatedLate.length} dropped — the resolved board is clearance/ITAR-gated: ${gatedLate.join(', ')}`);
  if (dupes.length) console.error(`  · ${dupes.length} resolved to an already-tracked board — skipped: ${dupes.slice(0, 6).join(', ')}${dupes.length > 6 ? ', …' : ''}`);
  const partials = results.filter(r => r.partial);
  const misses = results.filter(r => r.miss);

  console.error(`\n── Discovery complete ──`);
  const thin = hits.filter(h => h.thin);
  console.error(`  Resolved      : ${hits.length}${thin.length ? ` (${thin.length} thin — see below)` : ''}`);
  console.error(`  Tenant-only   : ${partials.length} (Workday tenant found, site path needs a manual look)`);
  console.error(`  No ATS found  : ${misses.length}`);
  // A REFUSAL IS NOT AN ABSENCE (F-444). Without this line, a run that was
  // being rate-limited reports the same "No ATS found" number as a run that
  // checked every board cleanly — and the companies behind it are dropped with
  // nothing recording that they were never really looked at.
  const refused = refusalReport();
  if (refused.ats.length) {
    console.error(`  ⚠  ${refused.ats.length} shared ATS refused us — misses that depended on them are NOT real:`);
    for (const r of refused.ats) {
      console.error(`       ${r.service} — ${r.count} refusals (HTTP ${r.status})`);
    }
    console.error('     Re-run later; the companies behind them were never actually checked.');
  }
  if (refused.sites.length) {
    // Ordinary bot protection on a company's own homepage. One company each,
    // nothing to re-run, and worth a line only so the count is not mistaken
    // for the one above.
    console.error(`  ·  ${refused.sites.length} company site(s) refused a careers-page fetch (bot protection) — one company each.`);
  }
  const byProvider = {};
  for (const h of hits) byProvider[h.provider] = (byProvider[h.provider] || 0) + 1;
  console.error(`  By provider   : ${Object.entries(byProvider).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}`);

  const block = hits.map(h => renderEntry(h, h.sector)).join('\n\n');
  if (write && hits.length) {
    appendToPortals(block);
    console.error(`\n  Wrote ${hits.length} entries → ${path.relative(ROOT, PORTALS_PATH)}`);
  } else if (hits.length) {
    console.log(block);
    console.error('\n  (dry run — re-run with --write to append these to portals.yml)');
  }

  if (thin.length) {
    console.error(`\n  Thin boards (<${MIN_CONFIDENT} postings) — probably not the real careers site:`);
    for (const t of thin) console.error(`    • ${t.entry.name} — ${t.entry.careers_url} (${t.count})`);
  }

  if (partials.length) {
    console.error('\n  Workday tenants found but site path unresolved:');
    for (const p of partials) console.error(`    • ${p.name} — https://${p.tenant}.${p.instance}.myworkdayjobs.com/<SITE>`);
  }
}

// Only run when invoked directly — importing this file (tests) must not scan.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1); });
}
