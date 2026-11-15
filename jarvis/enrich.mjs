#!/usr/bin/env node
// jarvis/enrich.mjs — fill in full job descriptions, then re-triage.
//
// WHY THIS EXISTS: the broad scan is zero-token and only sees what a company's
// LIST api returns — usually title + location, no description. That's fine for
// browsing, but it means visa HARD-BLOCK detection (citizenship / clearance /
// "no sponsorship") never sees the sentence that would trigger it. Enrichment
// closes that safety-relevant gap: it pulls each posting's full description from
// the SAME ATS's public per-job detail endpoint (no auth, no scraping tricks),
// stores it, and re-runs triage so a "we will not sponsor" line actually blocks.
//
// It is deliberately ON-DEMAND and scoped, not part of every scan — you enrich
// the handful of jobs you're about to browse or queue, not all 5000. Keeps it
// cheap and polite.
//
// Usage:
//   node jarvis/enrich.mjs --id 8e0dec65b5d0bc19  # read exactly this posting
//   node jarvis/enrich.mjs --company kla          # enrich KLA postings missing a description
//   node jarvis/enrich.mjs --status queued        # enrich everything in your queue
//   node jarvis/enrich.mjs --relevance 15 --limit 200
//   node jarvis/enrich.mjs --fit 40 --limit 4000    # read everything Fair and up
//   node jarvis/enrich.mjs --all --limit 500      # broad backfill (bounded)
//   node jarvis/enrich.mjs --force ...            # re-fetch even if a description exists

import { writeFileSync, readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { getJob, updateJob, query, db, STORE_DIR, withStoreLock, THIN_BODY } from './store.mjs';
import { triage } from './triage.mjs';
import { scoreFit, getProfile, slimFit } from './fit.mjs';
import { resolveSalary } from './salary-text.mjs';
import { htmlToText, hollowBody } from './text.mjs';
import { embeddedPosting } from './embedded-posting.mjs';
import { adpDetailApi } from '../providers/adp.mjs';
import { jobvitePostingFromHtml } from '../providers/jobvite.mjs';
import { makeHostLimiter, serviceOf } from './net-pool.mjs';
import { makePacer, pacePath, TARGETED_RESERVE, paceKeys, paceLimits, hasAllowance } from './pace.mjs';
import { readSettings } from './settings.mjs';
import { DatabaseSync } from 'node:sqlite';
import { CAPPED_BOARD } from './unlisted.mjs';
import { makeRefusalGate, loadRefusals, saveRefusals, refusalsPath, isPolicyRefusal, hostKey } from './refusals.mjs';
import { DETAIL_SOURCES, driftFrom } from './detail-sources.mjs';
import { employerClass } from './employer-taste.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Progress file — read by serve.mjs's /api/progress so the dashboard can show
// a live "jobs read in detail" bar while a batch runs.
const PROGRESS_PATH = path.join(STORE_DIR, 'enrich-progress.json');
/**
 * THE LIVE TALLY, REACHABLE FROM OUTSIDE `main()`.
 *
 * The terminal state was written at the end of a successful run and nowhere
 * else, so a run that was killed left `running: true` behind it — and
 * `/api/progress` would show an enrichment bar with nothing behind it, with no
 * way to tell it from a live one. The dashboard is hard-terminated repeatedly
 * (F-317), so this is reachable, not theoretical.
 */
let LIVE = null;

/** Write the terminal state once, whatever ended the run. */
function finishProgress(why = '') {
  if (!LIVE) return;
  const T = LIVE;
  LIVE = null;
  writeProgress({
    running: false, total: T.total, done: T.done, ok: T.ok, failed: T.failed, gone: T.gone,
    // Held back by today's read allowance (F-448): not failures and not
    // "nothing found"; the dashboard says they wait for tomorrow.
    paced: T.paced || 0, pacedServices: [...(T.pacedServices || [])],
    // Bodies for new postings the screen was waiting on: new survivors to read.
    freshRead: T.freshRead || 0,
    completedAt: new Date().toISOString(), ...(why ? { endedBy: why } : {}),
  });
}

function writeProgress(p) {
  // `updatedAt` is stamped on every write, and it is what the dashboard reads to
  // decide whether a batch is alive. Staleness used to be measured from
  // startedAt, which says only when the run BEGAN — so a long manual enrichment
  // was declared dead at the ten-minute mark while it was still working.
  try { writeFileSync(PROGRESS_PATH, JSON.stringify({ ...p, updatedAt: new Date().toISOString() })); } catch { /* best-effort */ }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/**
 * THE HONEST CLIENT FOR iCIMS (2026-11-03). Every *.icims.com host answered the
 * browser-looking UA above with 405 — measured: a browser UA gets 405 and 2 KB,
 * a plain client name gets 200 and the posting with its schema.org JobPosting.
 * The 405s since 2026-09-09 (isRefusal) were the host turning away a client
 * that claims to be Chrome and does not behave like one. iCIMS gets a plain,
 * truthful name instead. Jobvite (2026-11-04) gets the same name from the
 * start: its posting pages answered it with 200 and the full JobPosting.
 */
export const HONEST_UA = 'Jarvis-Jobs/1.0 (personal job search; one posting at a time)';
export function userAgentFor(url) {
  try { return /(^|\.)(?:icims|jobvite)\.com$/i.test(new URL(String(url)).hostname) ? HONEST_UA : UA; } catch { return UA; }
}
// Narrower on request (JARVIS_ENRICH_CONCURRENCY=2) for a hand-run repair on a
// machine someone is using; the dashboard's worker keeps the default.
const CONCURRENCY = Number(process.env.JARVIS_ENRICH_CONCURRENCY) || 6;

/**
 * Does this posting still need its body read (F-761)? No body; or a body under
 * THIN_BODY that nothing has read in full — the list teaser Workday and Phenom
 * hand back. The same question `needsRead` asks in SQL, for a hand-picked list.
 *
 * `refreshDays`: also a body last read more than that many days ago (or never
 * dated). A read is a snapshot, and employers edit after posting: GE Vernova's
 * R5052095 was read the day after it went up, at 2,071 characters; three weeks
 * later the same CXS record carried 3,915, the new tail holding the pay range
 * and "We will not sponsor individuals for employment visas" (F-627). Nothing
 * was cut on our side — the posting grew, and nothing read it again.
 */
export function needsReading(job, refreshDays, now = Date.now()) {
  const body = String(job?.description || '');
  if (!body || (body.length < THIN_BODY && !job?.enrichedAt)) return true;
  if (!(refreshDays >= 0)) return false;
  const at = Date.parse(job?.enrichedAt || '');
  return !Number.isFinite(at) || now - at > refreshDays * 86_400_000;
}
const TIMEOUT_MS = 15000;

// ── detail-URL derivation, per source ATS ───────────────────────────
// Each returns the public JSON detail endpoint for a stored job URL, or null
// if this source has no per-job detail API (or already ships descriptions).

/**
 * The Greenhouse board a tracked company posts on, from his own portals.yml.
 *
 * Read once, lazily, and never written: portals.yml is his hand-edited config
 * and nothing here may change it. Only the board SLUG is taken, and only from
 * an api/careers_url that is already a Greenhouse address.
 */
let GH_BOARDS = null;
/**
 * The application questions that decide whether he can hold the job at all.
 *
 * Only these. A form asks fifteen things and fourteen of them — GPA, how he
 * heard about it, whether he will relocate — belong nowhere near a resume or a
 * fit score, and the standard "will you require sponsorship" question is asked
 * by everyone and decides nothing. What is kept is the language `classifyVisa`
 * already knows how to read: clearance, citizenship, U.S. person, export
 * control. Kept VERBATIM, because the gate quotes the sentence it blocked on
 * and a paraphrase would put words in the employer's mouth.
 *
 * Returns the body unchanged when the form asks nothing of the kind, which is
 * the overwhelming majority — so no other posting's text moves because of this.
 */
export const GATE_QUESTION = /\bclearance|\bcitizen|\bITAR\b|export[- ]control|U\.?S\.?\s*person|permanent resident|green card/i;

export function appendGateQuestions(body, questions) {
  if (!Array.isArray(questions) || !questions.length) return body;
  const labels = [];
  for (const q of questions) {
    const label = String(q?.label || '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    // THE QUESTION'S OWN NOTE IS WHERE THE ITAR CLAUSE LIVES (Freeform,
    // 2026-10-02): "Citizenship Status" carries "Export Compliance: … must be
    // a 'U.S. person' as defined in the ITAR …" in its description, and the
    // posting body says nothing. He hid it for ITAR; the screen never saw it.
    const note = htmlToText(String(q?.description || '')).replace(/\s+/g, ' ').trim();
    const noteIsGate = !!note && GATE_QUESTION.test(note);
    // …AND THE LABEL NEED NOT SAY SO (F-665, 2026-10-18). Relativity Space's
    // question is labelled just "EXPORT COMPLIANCE"; the note under it says the
    // hire "must either be a 'U.S. person' … or otherwise eligible for a
    // federally issued export control license". Only the label was tested, so
    // the question was dropped and 652 rows read as silent. Either half being
    // about the gate is enough.
    if (!GATE_QUESTION.test(label) && !noteIsGate) continue;
    if (labels.some((l) => l.label === label)) continue;
    labels.push({ label, text: noteIsGate ? `${label} — ${note.slice(0, 900)}` : label, required: q?.required === true });
  }
  if (!labels.length) return body;
  return `${body}\n\nApplication form questions (asked by the employer on its own application):\n${
    labels.map((l) => `${l.text}${l.required ? ' (required)' : ''}`).join('\n')}`;
}

/**
 * ORACLE'S DETAIL ENDPOINT WHEN THE ROW DOES NOT CARRY IT (2026-10-02).
 *
 * New rows lost the scanner's detailApi in the store (fixed there), so 5,045
 * of 5,512 Oracle postings had no description. Two ways back, the same order
 * as Greenhouse's: the posting URL itself when it is on the real Oracle host
 * (Cummins, Emerson, Honeywell: …/hcmUI/CandidateExperience/en/sites/CX_1/job/
 * 2435230), else the company's entry in portals.yml (orc_host, orc_site) with
 * the requisition from the vanity URL (careers.ti.com/en/sites/CX_1/job/…).
 */
let ORC_BOARDS = null;
export function oracleDetailApi(url, company) {
  const id = String(url || '').match(/\/job\/(\d+)(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  let host = '';
  let site = '';
  const own = String(url).match(/^(https:\/\/[\w.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[\w-]+\/sites\/([\w-]+)\//i);
  if (own) [, host, site] = own;
  else {
    if (!ORC_BOARDS) {
      ORC_BOARDS = new Map();
      try {
        const doc = yaml.load(readFileSync(process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml'), 'utf-8')) || {};
        for (const e of [...(doc.tracked_companies || []), ...(doc.watchlist || [])]) {
          if (e?.provider === 'oracle-orc' && e.orc_host && e.name) ORC_BOARDS.set(String(e.name).trim().toLowerCase(), { host: String(e.orc_host).replace(/\/$/, ''), site: e.orc_site || 'CX_1' });
        }
      } catch { /* no portals.yml */ }
    }
    const b = ORC_BOARDS.get(String(company || '').trim().toLowerCase());
    if (!b) return null;
    ({ host, site } = b);
  }
  return `${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
    + `?expand=all&onlyData=true&finder=ById%3BId%3D%22${id}%22%2CsiteNumber%3D%22${encodeURIComponent(site)}%22`;
}

function greenhouseBoardFor(company) {
  const key = String(company || '').trim().toLowerCase();
  if (!key) return '';
  if (!GH_BOARDS) {
    GH_BOARDS = new Map();
    try {
      const text = readFileSync(process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml'), 'utf-8');
      let name = '';
      for (const line of text.split(String.fromCharCode(10))) {
        const named = line.match(/^\s*-\s*name:\s*"?([^"#]+?)"?\s*$/);
        if (named) { name = named[1].trim(); continue; }
        const slug = line.match(/(?:boards-api|job-boards(?:\.eu)?|boards)\.greenhouse\.io\/(?:v1\/boards\/)?([\w-]+)/);
        if (name && slug && !GH_BOARDS.has(name.toLowerCase())) GH_BOARDS.set(name.toLowerCase(), slug[1]);
      }
    } catch { /* no portals.yml — the row's own detailApi is the only route */ }
  }
  return GH_BOARDS.get(key) || '';
}

/** The detail deriver for a row's source; `<ats>-manual` reads as `<ats>`. */
const detailFor = (source) => DETAIL[source] || DETAIL[String(source || '').replace(/-manual$/, '')];

/** The detail spec for a row, or null when its source has no reader. Exported for tests. */
export function detailSpec(job) {
  const d = detailFor(job?.source);
  return d ? d(String(job?.url || ''), job) : null;
}

const DETAIL = {
  // Oracle Recruiting Cloud (Texas Instruments and the rest of the ORC estate).
  //
  // 294 postings sat in the deck with no description — nothing read their
  // skills, their visa language or their degree requirement — because there
  // was no deriver here. The detail call needs the tenant's REAL Oracle host
  // (edbz.fa.us2.oraclecloud.com) and its site number, and neither appears in
  // the posting URL, which is a vanity domain: careers.ti.com/en/sites/CX_1/
  // job/25016597. The vanity host does not proxy the API — it 302s to an error
  // page — so the URL alone cannot reach it.
  //
  // So the scanner, which HAS that config, writes the detail URL onto the job
  // and this reads it back. That is why derivers now receive the job as well
  // as its URL: some detail endpoints are not derivable from the posting
  // address at all.
  'oracle-orc'(url, job) {
    const api = /^https:\/\/[\w.-]+\/hcmRestApi\//.test(String(job?.detailApi || ''))
      ? String(job.detailApi)
      : oracleDetailApi(url, job?.company);
    if (!api) return null;
    return {
      api,
      // The body is split across three fields and any of them can be empty;
      // the qualifications block is the one that carries "Bachelor's in
      // electrical engineering", which is exactly what the degree check reads.
      // …and the CORPORATE block, last (F-733). Emerson keeps its work-
      // authorization rule there and only there: "This is not a position for
      // which sponsorship will be provided … F-1 (including those with OPT or
      // CPT) … are not eligible for hire". Without it the visa gate never saw
      // the sentence, and an Emerson posting reached his inbox.
      pick: (j) => {
        const d = j?.items?.[0] || {};
        return [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr, d.CorporateDescriptionStr]
          .filter(Boolean).join('\n\n');
      },
    };
  },
  // Workday CXS: list URL  https://<tenant>.<inst>.myworkdayjobs.com[/<locale>]/<site><externalPath>
  //          →   detail    https://<tenant>.<inst>.myworkdayjobs.com/wday/cxs/<tenant>/<site><externalPath>
  workday(url) {
    // TWO PUBLIC HOSTS, ONE API (F-453). Workday serves tenant-first
    // (`acme.wd5.myworkdayjobs.com/<site>`) and host-first
    // (`wd1.myworkdaysite.com/recruiting/acme/<site>`). Both reach
    // `<origin>/wday/cxs/<tenant>/<site><externalPath>`; only the spelling of
    // the tenant in the posting URL differs. This knew the first shape only,
    // so an employer on the second could be scanned but never read.
    let m = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)(\/.*)$/);
    if (m) {
      const [, tenant, inst, site, externalPath] = m;
      return {
        api: `https://${tenant}.${inst}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${externalPath}`,
        pick: j => j?.jobPostingInfo?.jobDescription || '',
        title: j => j?.jobPostingInfo?.title || '',
      };
    }
    m = url.match(/^https:\/\/(wd[\w-]*)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([\w-]+)\/([^/]+)(\/.*)$/);
    if (m) {
      const [, inst, tenant, site, externalPath] = m;
      return {
        api: `https://${inst}.myworkdaysite.com/wday/cxs/${tenant}/${site}${externalPath}`,
        pick: j => j?.jobPostingInfo?.jobDescription || '',
        title: j => j?.jobPostingInfo?.title || '',
      };
    }
    return null;
  },
  // Phenom career sites (Thermo Fisher, GE HealthCare) list a ~380-character
  // teaser and link each posting to the employer's own Workday tenant. The
  // curator needs 400 characters to read anything, so those rows took half of
  // every batch as "no description to read" (F-673). The Workday link is the
  // full posting; any other link has no reader here.
  phenom(url, job) {
    if (/myworkday(?:jobs|site)\.com\//.test(url)) return DETAIL.workday(url);
    // A SuccessFactors / Taleo / UltiPro apply link has no reader; the
    // provider keeps the posting's page on the Phenom site as detailApi
    // (providers/phenom.mjs phenomPage). Only an https page of that shape.
    const page = String(job?.detailApi || '');
    if (page !== url && /^https:\/\/[^/]+\/[a-z]{2,6}\/[a-z]{2}\/job\/[A-Za-z0-9-]+/.test(page)
      && !/^https:\/\/[^/]+\/[a-z]{2,6}\/[a-z]{2}\/job\//.test(url)) {
      // Built by the provider, so its locale can be a guess: read through
      // readPhenomPage, which tries the locale the site answers with and
      // never strikes a page it could not find (F-1048 review).
      const spec = DETAIL.phenom(page);
      return spec && { ...spec, phenomGuess: true, applyUrl: url };
    }
    // A posting on the Phenom site itself: its page carries the whole record
    // (phenomPosting). The locale in the path must be the one the id was filed
    // under — QGRQGAGLOBALP122128EXTERNALENGLOBAL lives at /global/en/, and the
    // /us/en/ link the search hands back redirects to the home page.
    const m = /^(https:\/\/[^/]+)\/([a-z]{2,6}\/[a-z]{2})\/job\/([A-Za-z0-9]+)(\/[^?#]*)?/.exec(url);
    if (!m) return null;
    const loc = /EXTERNAL([A-Z]{2})([A-Z]{2,6})$/.exec(m[3]);
    const path = loc ? `${loc[2].toLowerCase()}/${loc[1].toLowerCase()}` : m[2];
    return { html: `${m[1]}/${path}/job/${m[3]}${m[4] || ''}`, pick: null };
  },
  // SuccessFactors career sites list the body in their feed (BODY_IN_LIST once),
  // but a requisition listed only through translated templates arrives with
  // every requirement section empty and is left unread (F-760). Its page is
  // read instead, in English: the link redirects to the translated record and
  // `localeVariant` names the en_US one beside it (F-937).
  successfactors(url) {
    if (!/^https:\/\/[^/]+\/job\//.test(url)) return null;
    return { html: url, locale: 'en_US', pick: null };
  },
  // Greenhouse: list URL .../<board>/jobs/<id>  →  boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>
  //
  // THE FORM SAYS WHAT THE POSTING DOES NOT (F-455, 2026-09-13). General
  // Matter's three New Grad roles reached his inbox at fit 89–99 with a clean
  // work-authorisation check, because the check reads the description and the
  // description is silent. The application form is not: "Active Security
  // Clearance(s)" (required), "Are you eligible for a Q Security Clearance?"
  // (required), "…are you a US citizen?" (required). A Q clearance is the
  // Department of Energy's top tier. He can hold none of them.
  //
  // Greenhouse publishes those questions in the same endpoint the description
  // comes from, one query parameter away. They are part of what the posting
  // requires, so the visa-relevant ones are appended to the body and the gate
  // that already recognises this language finally gets to see it.
  //
  // A COMPANY THAT HOSTS ITS OWN BOARD HIDES THE BOARD (F-404). Agility
  // Robotics publishes `agilityrobotics.com/about/job-post?gh_jid=5986750004`;
  // Waymo, Zipline, Nuro, Datadog and Motional do the same. The slug the
  // detail endpoint needs is nowhere in that URL, so 2,231 postings — every
  // one of those companies' — could never be read: no description, no visa
  // check on the description, a fit score from the title alone, and any
  // resume written for one written blind.
  //
  // Two ways back to the board, in order of authority: the endpoint the
  // scanner wrote onto the row, and failing that the company's own entry in
  // portals.yml, which is where the scanner got it from in the first place.
  greenhouse(url, job) {
    const m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/) || url.match(/\/([\w-]+)\/jobs\/(\d+)/);
    const known = String(job?.detailApi || '');
    const ghJid = url.match(/[?&]gh_jid=(\d+)/);
    const board = m ? m[1] : (ghJid ? greenhouseBoardFor(job?.company) : '');
    const id = m ? m[2] : (ghJid ? ghJid[1] : '');
    const api = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[\w-]+\/jobs\/\d+$/.test(known)
      ? known
      : (board && id ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}` : '');
    if (!api) return null;
    return {
      api: `${api}?content=true&questions=true`,
      pick: j => appendGateQuestions(j?.content || '', j?.questions),
      title: j => j?.title || '',
      // departments[] is the business-unit signal ("2256 Neutron - SSC");
      // offices[] adds the site when present.
      team: j => [
        ...(Array.isArray(j?.departments) ? j.departments.map(d => d?.name) : []),
      ].filter(Boolean).join(' / '),
    };
  },
  // SmartRecruiters publishes a posting under TWO URL shapes (F-424):
  //
  //   https://jobs.smartrecruiters.com/<company>/postings/<id>
  //   https://jobs.smartrecruiters.com/<company>/<id>-<title-slug>
  //
  // Only the first was matched, so 11,539 of his 26,452 SmartRecruiters rows —
  // 44%, including most of Bosch, AbbVie, Intuitive Surgical, Wabtec, Western
  // Digital and Avery Dennison — could never be read at all. No description,
  // no work-authorisation check on the description, and a fit score computed
  // from the title alone. They failed silently as "could not reach", which is
  // how it went unnoticed until the failure reasons were broken out.
  //
  // Both shapes carry the same numeric id and the same detail endpoint takes
  // it, verified live against the API.
  //              →   detail   https://api.smartrecruiters.com/v1/companies/<company>/postings/<id>
  smartrecruiters(url) {
    const m = url.match(/^https:\/\/jobs\.smartrecruiters\.com\/([\w-]+)\/postings\/(\w+)/)
      || url.match(/^https:\/\/jobs\.smartrecruiters\.com\/([\w-]+)\/(\d+)(?:-|$)/);
    if (!m) return null;
    return {
      api: `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`,
      // Join every section, not just jobDescription. Work-authorisation
      // language ("must be authorized to work in the US without sponsorship")
      // lands in qualifications or additionalInformation far more often than
      // in the description proper — and missing it is exactly the hard-block
      // this enrichment exists to catch.
      pick: j => ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
        .map(k => j?.jobAd?.sections?.[k]?.text || '')
        .filter(Boolean)
        .join('\n\n'),
      team: j => [j?.department?.label, j?.function?.label].filter(Boolean).join(' / '),
    };
  },
  // Sitemap-discovered jobs (Radancy/Eightfold/ASML…): the posting page embeds
  // a schema.org JobPosting in <script type="application/ld+json"> for SEO.
  // Besides the description, this upgrades the approximate slug-derived title
  // and fills the missing location.
  'sitemap-jobs'(url) {
    const apple = appleDetailApi(url);
    if (apple) return apple;
    return { html: url, pick: null };
  },
  // Rippling — the ATS a lot of the startups he actually wants are on (F-436).
  //
  // 271 live entry-level US rows had no description and no way to get one,
  // because this source had no deriver. Its board API answers a LIST call with
  // `{uuid, name, department, url, workLocation}` and nothing else, so the
  // scanner cannot carry a body it never receives.
  //
  // The per-job endpoint is the same path plus the uuid, and its `description`
  // is an OBJECT of HTML sections rather than a string — `{company, role}`,
  // measured at 2,823 and 31,805 characters. Joining every string value keeps
  // whichever sections a given tenant uses, including the ones where
  // work-authorisation language actually lands.
  rippling(url) {
    const m = url.match(/^https:\/\/ats\.rippling\.com\/([\w-]+)\/jobs\/([\w-]+)/i);
    if (!m) return null;
    return {
      api: `https://api.rippling.com/platform/api/ats/v1/board/${m[1]}/jobs/${m[2]}`,
      pick: (j) => {
        const d = j?.description;
        if (typeof d === 'string') return d;
        if (d && typeof d === 'object') {
          return Object.values(d).filter(v => typeof v === 'string' && v.trim()).join('\n\n');
        }
        return '';
      },
      team: j => j?.department?.label || j?.department?.name || '',
    };
  },
  // BambooHR — the provider deliberately stops at the list to stay zero-token,
  // which leaves the body unread (F-436). `/careers/list` gives title, location
  // and department; the JD lives one request further on at
  // `/careers/<id>/detail`, wrapped as `{result:{jobOpening:{description}}}`
  // and measured at 4,433 characters.
  //
  // Follow redirects: a tenant whose BambooHR subscription has lapsed 302s to
  // `/settings/account/expired.php`, which is a 200-with-HTML and parses to
  // nothing — that is what "Anchor Health: fetch failed" was in the full sweep,
  // an expired account rather than a network problem.
  bamboohr(url) {
    const m = url.match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.bamboohr\.com\/careers\/(\d+)/i);
    if (!m) return null;
    return {
      api: `https://${m[1]}.bamboohr.com/careers/${m[2]}/detail`,
      pick: j => j?.result?.jobOpening?.description || '',
      team: j => j?.result?.jobOpening?.departmentLabel || '',
    };
  },
  // Breezy — the public board feed (`<tenant>.breezy.hr/json`) carries title,
  // url, location and a published date, and no body, so 41 live entry-level
  // rows had nothing to read (F-436).
  //
  // There is no JSON detail endpoint despite appearances: `/json/<id>` answers
  // with the Angular shell, not data. The posting PAGE, however, ships a
  // schema.org JobPosting — 4,693 characters on the one measured — so it is
  // read the way sitemap-jobs and iCIMS pages are, through `jobPostingFromHtml`.
  breezy(url) {
    if (!/^https:\/\/[a-z0-9][a-z0-9-]*\.breezy\.hr\/p\//i.test(url)) return null;
    return { html: url, pick: null };
  },
  // iCIMS (Joby Aviation and the rest of the iCIMS estate).
  //
  // 42 deck postings had no description and had never even been ATTEMPTED,
  // because this source had no deriver — the last of the four gaps F-07
  // listed. Unlike Tesla, iCIMS answers a plain server-side GET with 200.
  //
  // The catch: the posting page is a shell. The body lives in an iframe, and
  // the page says so itself — it ships a `noscript_icims_content_iframe`
  // whose src is the same URL with `in_iframe=1`. Fetching the shell returns
  // 18KB of chrome and no job; fetching the iframe returns the posting.
  // Paylocity (F-720): the posting page publishes a schema.org JobPosting.
  paylocity(url) {
    const u = String(url || '');
    return /^https:\/\/recruiting\.paylocity\.com\/Recruiting\/Jobs\/Details\/\d+$/i.test(u) ? { html: u, pick: null } : null;
  },
  // Workable (2026-10-08): the board's feed is a list, and 114 relevant rows
  // (New Flyer, Acorn Product Development, Monarch Quantum) were never
  // attempted. One posting's JSON carries the body in three parts.
  workable(url) {
    const m = /^https:\/\/apply\.workable\.com\/([a-z0-9][a-z0-9-]*)\/(?:jobs\/view|j)\/([A-Z0-9]{6,})/i.exec(String(url || ''));
    if (!m) return null;
    return {
      api: `https://apply.workable.com/api/v2/accounts/${m[1]}/jobs/${m[2]}`,
      pick: (j) => [j?.description, j?.requirements && `<h3>Requirements</h3>${j.requirements}`, j?.benefits && `<h3>Benefits</h3>${j.benefits}`]
        .filter((x) => typeof x === 'string' && x.trim()).join('\n'),
    };
  },
  // ADP Workforce Now (F-705): one requisition's JSON carries the body.
  adp(url) {
    const api = adpDetailApi(url);
    return api ? { api, pick: (j) => (typeof j?.requisitionDescription === 'string' ? j.requisitionDescription : '') } : null;
  },
  // UKG Pro Recruiting (F-705): the OpportunityDetail page carries the posting
  // as an embedded record (embedded-posting.mjs → ukgPosting).
  ukg(url) {
    const u = String(url || '');
    if (!/^https:\/\/(?:recruiting\d*\.ultipro\.com|[a-z0-9-]+\.rec\.pro\.ukg\.net)\/[A-Za-z0-9]+\/JobBoard\/[0-9a-f-]{36}\/OpportunityDetail\?opportunityId=[0-9a-f-]{36}/i.test(u)) return null;
    return { html: u, pick: null };
  },
  // Jobvite (F-985): the posting page carries a schema.org JobPosting with the
  // whole body; a page without one falls back to div.jv-job-detail-description
  // (jobPostingFromHtml → jobvitePostingFromHtml).
  jobvite(url) {
    const u = String(url || '');
    return /^https:\/\/jobs\.jobvite\.com\/[a-z0-9][a-z0-9-]*\/job\/[A-Za-z0-9]+\/?$/i.test(u) ? { html: u, pick: null } : null;
  },
  icims(url) {
    const u = String(url || '');
    if (!/\.icims\.com\//i.test(u)) return null;
    const sep = u.includes('?') ? '&' : '?';
    return { html: `${u}${sep}in_iframe=1`, pick: null };
  },
};

/**
 * APPLE'S OWN POSTING API (2026-11-03). jobs.apple.com pages are rendered in
 * the browser and carry no schema.org JobPosting, so every Apple row from the
 * sitemap failed "page had no JobPosting data" three times and was retired —
 * 1,375 open Apple postings with no body, 377 of them in his field and below
 * senior. The page's own data comes from /api/v1/jobDetails/<id>: summary,
 * description, responsibilities, minimum and preferred qualifications.
 */
export function appleDetailApi(url) {
  const m = /^https:\/\/jobs\.apple\.com\/[a-z]{2}-[a-z]{2}\/details\/([0-9][0-9-]+)(?:\/|$)/i.exec(String(url || ''));
  if (!m) return null;
  return {
    api: `https://jobs.apple.com/api/v1/jobDetails/${m[1]}`,
    pick: (j) => {
      const r = j?.res || j || {};
      return [
        r.jobSummary && `<h3>Summary</h3>${r.jobSummary}`,
        r.description && `<h3>Description</h3>${r.description}`,
        r.responsibilities && `<h3>Responsibilities</h3>${r.responsibilities}`,
        r.minimumQualifications && `<h3>Minimum Qualifications</h3>${r.minimumQualifications}`,
        r.preferredQualifications && `<h3>Preferred Qualifications</h3>${r.preferredQualifications}`,
      ].filter((x) => typeof x === 'string' && x.trim()).join('\n').replace(/\n(?!<h3>)/g, '<br>');
    },
  };
}

/** Extract the JobPosting object from a page's JSON-LD blocks. */
function jobPostingFromHtml(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    try {
      const data = JSON.parse(raw.trim());
      const list = Array.isArray(data) ? data : [data];
      for (const d of list) {
        if (d && d['@type'] === 'JobPosting') return d;
        if (d && Array.isArray(d['@graph'])) {
          const hit = d['@graph'].find(g => g['@type'] === 'JobPosting');
          if (hit) return hit;
        }
      }
    } catch { /* malformed block — try the next one */ }
  }
  // No JSON-LD. Apple and Google publish none, and carry the whole posting in
  // their own page data instead — 8,061 rows failed here on their first pass
  // with "page had no JobPosting data" while the data sat in the same response.
  // A Jobvite page with its schema.org block missing still shows the body in
  // div.jv-job-detail-description (null on any page without that div).
  return embeddedPosting(html) || microdataPosting(html) || jobvitePostingFromHtml(html);
}

/**
 * schema.org MICRODATA (F-937, 2026-10-27). SuccessFactors career sites mark a
 * posting up with itemprop attributes rather than a JSON-LD block —
 * `<span itemprop="description">` (one for the posting, more for footers) and
 * `itemprop="title"`. Each described element is taken whole, nested markup and
 * all, by counting its own tag's opens and closes. Exported for tests.
 */
export function microdataPosting(html) {
  const src = String(html || '');
  const inner = (at) => {
    const open = /^<([a-zA-Z][\w-]*)\b[^>]*>/.exec(src.slice(at));
    if (!open) return '';
    const tag = open[1].toLowerCase();
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = at + open[0].length;
    let depth = 1, m;
    while ((m = re.exec(src))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return src.slice(at + open[0].length, m.index);
    }
    return '';
  };
  const starts = (prop) => [...src.matchAll(new RegExp(`<[a-zA-Z][\\w-]*\\b[^>]*itemprop="${prop}"[^>]*>`, 'gi'))].map((m) => m.index);
  const description = starts('description').map(inner).filter((s) => s.trim()).join('\n');
  if (htmlToText(description).trim().length < 200) return null;
  const titleAt = starts('title')[0];
  const title = titleAt != null ? htmlToText(inner(titleAt)).trim() : '';
  return { '@type': 'JobPosting', ...(title ? { title } : {}), description };
}

/**
 * Extract the business unit / group from a job description. Workday exposes no
 * structured team field, but many companies (KLA, AMAT, Intel…) write it into
 * the description under headers like "Group/Division" or in a "The X Division"
 * sentence. Same-titled roles in different units do very different work — this
 * label is what tells them apart in the dashboard.
 */
export function teamFromDescription(text) {
  const t = String(text || '');
  // Generic section headers must never be mistaken for a unit name.
  const JUNK = /^(job description|company overview|responsibilities|the role|about( us| the)?|position( summary)?|summary|overview|description|qualifications|minimum qualifications|preferred qualifications|duties|benefits|requirements)$/i;
  const clean = (s) => {
    const v = s.trim().replace(/^[,;:.\s]+|[,;:.\s]+$/g, '');
    return JUNK.test(v) ? '' : v;
  };
  // A proper-noun unit name: 1-4 capitalized tokens directly before a
  // capitalized "Division"/"Group"/"Business Unit" ("LS-SWIFT Division",
  // "ICOS Vision Systems Group"). Lowercase "division" prose never matches.
  const PROPER_UNIT = /((?:[A-Z][\w&().'-]*(?:\s+|-)){1,4})(?:Division|Group|Business Unit)\b/;

  // 1) Explicit section: take the whole section body (up to the next
  //    header-looking line) and hunt for the named unit inside it.
  const sec = t.match(/(?:Group\/Division|Business Unit|Organization|Department)\s*[:\n]\s*([\s\S]{3,700}?)(?=\n[A-Z][^\n]{0,50}\n|$)/i);
  if (sec) {
    const body = sec[1];
    const named = body.match(/(?:the|our)\s+([A-Z][A-Za-z0-9&().'\/\- ]{2,60}?)\s+(?:Division|Group|Team|Organization|Business Unit)\b/i)
      || body.match(PROPER_UNIT);
    if (named && clean(named[1])) return clean(named[1]);
    const firstLine = body.split('\n')[0].trim();
    if (firstLine && firstLine.length <= 60 && !/^(with|kla|we|our|the company)\b/i.test(firstLine)) {
      const v = clean(firstLine.replace(/[.;].*$/, ''));
      if (v) return v;
    }
  }
  // 2) Anywhere in the document: "join/within/part of the X Division".
  const joined = t.match(/\b(?:join|within|part of)\s+(?:the|our)\s+([A-Z][A-Za-z0-9&().'\/\- ]{2,50}?)\s+(?:Division|Group|Business Unit)\b/);
  if (joined && clean(joined[1])) return clean(joined[1]);
  // 3) Last resort: a proper-noun unit mentioned anywhere ("the LS-SWIFT
  //    Division develops…"). Excludes generic all-caps noise via the
  //    capitalized-token requirement.
  const anywhere = t.match(PROPER_UNIT);
  if (anywhere && !/^(The|Our|A|An|This|Your)\s*$/i.test(anywhere[1].trim())) return clean(anywhere[1]);
  return '';
}

/** Best-effort location string from a JSON-LD jobLocation. */
/**
 * schema.org lets every one of these fields be a string OR an object, and
 * publishers use both. `addressCountry` in particular arrives as "US", as
 * {name:"United States"}, and as {"@type":"Country", alternateName:"US"} —
 * and that last shape has no `.name`, so the old `a.addressCountry?.name ||
 * a.addressCountry` fell through to the OBJECT and joined it into the string.
 * Six postings were stored with the location "[object Object]", and one
 * 26-site Micron listing had five of them embedded in it.
 *
 * Anything that cannot be reduced to a non-empty string is dropped: a missing
 * location is honest and the title fallback can still classify it, while
 * "[object Object]" is unclassifiable and shows up on screen.
 */
function textOf(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    for (const k of ['name', 'alternateName', 'identifier', 'addressCountry']) {
      const s = textOf(v[k]);
      if (s) return s;
    }
  }
  return '';
}

function locationFromJsonLd(jp) {
  const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : (jp.jobLocation ? [jp.jobLocation] : []);
  const parts = locs.map(l => {
    const a = l?.address || {};
    return [a.addressLocality, a.addressRegion, a.addressCountry]
      .map(textOf).filter(Boolean).join(', ');
  }).filter(Boolean);
  return parts.join(' | ');
}

// ── html → readable plain text ──────────────────────────────────────
//
// Moved to text.mjs and rewritten. The version that lived here decoded entities
// AFTER stripping tags, which meant Greenhouse's entity-encoded bodies had their
// markup re-created as literal on-screen text rather than removed.

/**
 * A posting the ATS says is GONE, as opposed to one we merely failed to reach.
 *
 * Workday answers a pulled req with 403 "permission denied" (errorCode S22),
 * not 404 — check-liveness.mjs on the same URL reports "the page you are
 * looking for doesn't exist". Greenhouse and SmartRecruiters answer 404.
 * Everything else — timeouts, 429, 5xx — is the network having a bad minute
 * and must NOT be read as an expiry.
 */
class Gone extends Error {
  constructor(status) { super(`posting gone (HTTP ${status})`); this.gone = true; }
}

/**
 * Which statuses mean "gone" depends on the ATS, and getting this wrong in the
 * generous direction hides live jobs — the one error this system does not
 * tolerate. 404 and 410 are unambiguous everywhere.
 *
 * A WORKDAY 403 IS NO LONGER TRUSTED (F-427). It used to be, on the grounds
 * that 403 is Workday's documented answer for a pulled req. It is also
 * Workday's answer to a request it does not like the look of, and at volume
 * that is the far more common case. Measured 2026-09-09, after a 5,582-row
 * enrichment pass marked 899 Workday rows dead in one afternoon: of fourteen
 * sampled at random, the CXS API returned 403 and the posting's own page
 * returned **200 for all fourteen**. Every one of them was live.
 *
 * So 403 is now a retryable failure on every source, the same as 429. The cost
 * of that is a posting that really was pulled taking longer to leave the deck,
 * which is the cheap error. The cost of the old rule was hundreds of live jobs
 * disappearing from his deck in a batch, silently, with the run reporting
 * success.
 */
/**
 * A REFUSAL IS NOT EVIDENCE ABOUT THE POSTING (F-429). 403 and 429 mean the
 * host would not serve us this minute; 5xx and a bare timeout mean the
 * transport failed. None of them says anything about the job, so none of them
 * may count toward the three strikes that make a row permanently unreadable.
 */
export function isRefusal(status) {
  // 405 is here on evidence, not on principle. Read literally it means "method
  // not allowed", which sounds structural — but no ATS answers a GET to its own
  // public job page that way. Measured 2026-09-09: every host under
  // `*.icims.com` began returning 405 to everything, `sitemap.xml` included,
  // hours after the same hosts had served a 34 KB sitemap and 200s. A static
  // XML file does not become method-restricted; that is a block wearing an
  // unusual status code, and 860 of his rows took a strike for it in one run.
  return !status || status === 403 || status === 405 || status === 429 || status >= 500;
}

export function isGoneStatus(status, source) {
  return status === 404 || status === 410;
}

// KEEP-ALIVE IS WHY LONG RUNS DIED (F-425). Node's bundled HTTP parser
// asserts `!this.paused` when a pooled socket ends while the parser is
// suspended, and it throws that from a socket event handler — outside any
// promise, so no try/catch here can see it and the process simply exits. It
// only happens on a REUSED connection, which is why it took thousands of
// requests to show up. `connection: close` gives up keep-alive to avoid the
// reuse entirely; a fresh TCP handshake per posting is a real cost, and a much
// smaller one than a run that cannot finish.
const NO_KEEPALIVE = { connection: 'close' };

// The code rides on `httpStatus`, read only by the refusal gate: `status` stays
// unset so the strike rules above keep treating every failure as they did.
function httpFailure(code) { const e = new Error(`HTTP ${code}`); e.httpStatus = code; return e; }

async function fetchJson(url, source) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': userAgentFor(url), accept: 'application/json', ...NO_KEEPALIVE }, signal: ctrl.signal });
    if (isGoneStatus(res.status, source)) throw new Gone(res.status);
    if (!res.ok) throw httpFailure(res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function fetchHtml(url) {
  return (await fetchHtmlAt(url)).text;
}

/**
 * The same Phenom posting under the other locales the site itself names: the
 * one a redirect landed on (a /us/en/ guess on a German site lands on /de/de/),
 * then the one the apply link asks for (lang=en_GB → gb/en). Exported for tests.
 */
export function phenomAlternates(pageUrl, { landed = '', applyUrl = '' } = {}) {
  const m = /^(https:\/\/[^/]+)\/([a-z]{2,6}\/[a-z]{2})(\/job\/.*)$/.exec(String(pageUrl || ''));
  if (!m) return [];
  const locs = [];
  const l = /^(https:\/\/[^/]+)\/([a-z]{2,6}\/[a-z]{2})(?:[/?#]|$)/.exec(String(landed || ''));
  if (l && l[1] === m[1]) locs.push(l[2]);
  const p = /[?&](?:lang|locale)=([a-z]{2})[_-]([a-z]{2})(?![a-z])/i.exec(String(applyUrl || ''));
  if (p) locs.push(`${p[2].toLowerCase()}/${p[1].toLowerCase()}`);
  return [...new Set(locs)].filter((x) => x !== m[2]).map((x) => `${m[1]}/${x}${m[3]}`);
}

/**
 * A Phenom page whose locale was built, not given (F-1048 review): read it, and
 * when it 404s or comes back without a JobPosting (the site's home page after a
 * redirect), read it under the locales phenomAlternates names. At most three
 * reads. `fetchAt(url)` → { text, url }. Resolves { page, jp } or null.
 * Exported for tests.
 */
export async function readPhenomPage(url, { applyUrl = '', fetchAt = fetchHtmlAt } = {}) {
  const tried = [];
  let queue = [url];
  while (queue.length && tried.length < 3) {
    const next = queue.shift();
    if (tried.includes(next)) continue;
    tried.push(next);
    let page = null;
    try { page = await fetchAt(next); } catch (e) {
      const st = e?.httpStatus ?? e?.status;
      if (st !== 404 && st !== 410) throw e;   // a refusal or a timeout is handled as one
    }
    const jp = page ? jobPostingFromHtml(page.text) : null;
    if (jp) return { page, jp };
    if (tried.length === 1) queue = phenomAlternates(url, { landed: page?.url || '', applyUrl });
  }
  return null;
}

/** How long a Phenom page that was not found waits before it is asked again. */
export const PHENOM_COOLDOWN_MS = 24 * 3_600_000;
/** Is this row's Phenom page still cooling after a miss. Exported for tests. */
export function phenomCooling(id, misses, now = Date.now()) {
  const at = Date.parse(misses?.[id] || '');
  return Number.isFinite(at) && now - at < PHENOM_COOLDOWN_MS;
}
/** Only the misses still cooling, so the file never grows past a day of them. Exported for tests. */
export function prunePhenomMisses(misses, now = Date.now()) {
  return Object.fromEntries(Object.entries(misses || {}).filter(([id]) => phenomCooling(id, misses, now)));
}
function loadPhenomMisses(file) {
  try { const m = JSON.parse(readFileSync(file, 'utf8')); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

/** The page and the address it finally came from (after redirects). */
async function fetchHtmlAt(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': userAgentFor(url), accept: 'text/html', ...NO_KEEPALIVE }, signal: ctrl.signal });
    if (!res.ok) throw httpFailure(res.status);
    return { text: await res.text(), url: res.url || url };
  } finally { clearTimeout(t); }
}

/**
 * THE SAME POSTING IN ANOTHER LANGUAGE (F-937, 2026-10-27). A SuccessFactors
 * career site can list a requisition only through its translations: CNH's feed
 * carries each US posting as an Italian and a French copy with every
 * requirement section empty, and the posting link redirects to
 * `/job/<slug>/5708-it_IT/`. The English record is the same address with the
 * locale swapped — `/job/<slug>/5708-en_US/`. Returns that address, or null
 * when the page is not a locale-suffixed record or is already in `locale`.
 */
export function localeVariant(finalUrl, locale) {
  const m = /^(https:\/\/[^?#]*\/)(\d+)-([a-z]{2}_[A-Z]{2})\/?(?:[?#].*)?$/.exec(String(finalUrl || ''));
  if (!m || !locale || m[3] === locale) return null;
  return `${m[1]}${m[2]}-${locale}/`;
}

// ── selection ───────────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i !== -1 ? a[i + 1] : undefined; };
  return {
    // ONE POSTING, BY ID — what the dashboard asks for the moment a resume
    // is about to be written for a job whose description was never read.
    id: get('--id'),
    // A LIST OF POSTINGS, ONE ID PER LINE — a hand-picked batch (the recent
    // mechanical rows a curation run is about to read) that no filter names.
    idsFile: get('--ids-file'),
    refresh: get('--refresh') != null ? Number(get('--refresh')) : undefined,
    company: get('--company')?.toLowerCase(),
    status: get('--status'),
    relevance: get('--relevance') != null ? Number(get('--relevance')) : undefined,
    fit: get('--fit') != null ? Number(get('--fit')) : undefined,
    limit: get('--limit') != null ? Number(get('--limit')) : 300,
    all: a.includes('--all'),
    force: a.includes('--force'),
    auto: a.includes('--auto'),
    stale: get('--stale') != null ? Number(get('--stale')) : undefined,
    // Read only these ATSes. Boards do not fail uniformly — on 2026-09-09 the
    // Eightfold hosts (Micron, Lam, Eaton) were refusing while Greenhouse,
    // Ashby and SmartRecruiters answered everything — and without this the
    // only way to spend a read budget on the boards that are actually
    // responding was to name companies one at a time.
    sources: get('--source')?.split(',').map(s => s.trim()).filter(Boolean),
  };
}

/**
 * Choose what to read, in SQL.
 *
 * This used to load all 107k jobs and filter them in JavaScript to pick 300.
 * Every clause below maps to an indexed column, so the database returns the
 * 300 and never materialises the rest.
 */
function selectJobs(opts) {
  // A NAMED POSTING IS NOT A SEARCH. `--id` reads exactly that row, whatever
  // its fit, status or failure count — the caller already decided it matters.
  // Its source must still have a detail deriver; without one there is nothing
  // to read, and an empty list is the honest answer.
  if (opts.id) {
    const one = getJob(String(opts.id), { description: true });
    return one && detailFor(one.source) ? [one] : [];
  }
  if (opts.idsFile) {
    const ids = readFileSync(opts.idsFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return ids.map((id) => getJob(id, { description: true }))
      .filter((j) => j && detailFor(j.source) && (opts.force || needsReading(j, opts.refresh)))
      .slice(0, opts.limit);
  }
  const known = Object.keys(DETAIL);
  if (opts.sources?.length) {
    // Said out loud, because a typo that reads nothing looks exactly like a
    // backlog that is already finished.
    const unknown = opts.sources.filter(s => !known.includes(s));
    if (unknown.length) console.warn(`  ⚠  ignoring unknown source(s): ${unknown.join(', ')} — known: ${known.join(', ')}`);
  }
  const filters = {
    // Only what we CAN read (a detail deriver exists for its source), narrowed
    // to the caller's --source list when there is one. An unknown name is
    // dropped rather than silently widening the run back to everything.
    // `<ats>-manual`: a posting recorded from its own ATS because he opened
    // its form first (serve.mjs recordFromAts). Same API, same deriver.
    source: (opts.sources?.length ? opts.sources.filter(s => known.includes(s)) : known).flatMap((s) => [s, `${s}-manual`]),
  };
  if (opts.auto) {
    // Auto mode (spawned by the dashboard server): read the jobs the user
    // would actually browse — US/remote/unknown location, not senior-titled,
    // not already hard-blocked.
    filters.blocked = false;
    filters.locationBucket = ['us', 'remote', 'unknown'];
    filters.excludeLevel = ['exclude'];
  }
  if (opts.company) filters.companyLike = opts.company;
  if (opts.status) filters.status = opts.status;
  if (opts.relevance != null) filters.minRelevance = opts.relevance;
  // Select by FIT, not the old keyword relevance. Relevance ranks by how
  // mechanical-sounding a title is; fit ranks by whether the job is actually
  // winnable, which is the better use of a bounded read budget.
  if (opts.fit != null) { filters.minScore = opts.fit; filters.fitBlocked = false; }
  // Refetch when the description is missing, OR when a greenhouse job lacks a
  // team label (departments only come from the detail API). Jobs that failed
  // 3+ times are permanently skipped (no auto-retry burn) unless --force.
  if (!opts.force) filters.needsRead = true;

  // LIVENESS SWEEP (--stale <days>).
  //
  // F-08: the store goes stale and nothing notices. 1,275 deck postings had
  // not been re-verified in 14 days and the oldest was five weeks old, while
  // roughly one live listing in seven is already a ghost. The 6-hourly scan
  // refreshes what the portals still LIST; it never re-checks an individual
  // posting that has quietly been pulled.
  //
  // This is a liveness sweep rather than a read: it deliberately drops
  // `needsRead`, because the point is to re-verify postings that ALREADY have
  // a description. Enrichment marks 403/404/410 as `gone`, and that mechanism
  // was measured at 96% accurate (F-06), so re-fetching the stalest rows IS
  // the liveness check — no second code path, no second thing to keep true.
  if (opts.stale != null) {
    delete filters.needsRead;
    filters.browsable = true;
    // …but not the strike cutoff with it. Dropping needsRead also dropped
    // `enrich_fails < 3`, so rows that can never produce a body (Texas
    // Instruments reqs Oracle no longer returns, Teradyne pages the reader
    // could not parse) were fetched again every hour, struck again, and
    // reached 878 strikes. A fetch that cannot produce a body cannot show the
    // posting is live either; check-liveness.mjs is the tool for those.
    filters.readable = true;
    filters.seenBefore = new Date(Date.now() - opts.stale * 86400000).toISOString();
    const { rows } = query(filters, { sort: 'stalest', limit: opts.limit, full: true });
    return rows;
  }

  // WHAT A BOUNDED READ BUDGET SHOULD BE SPENT ON (F-422).
  //
  // This sorted by fit, with the comment "best-fit first, so a bounded run
  // reads the most promising jobs". That is circular: `fit_score` is computed
  // largely FROM the description, so a posting that has never been read scores
  // on its title alone and lands low — and sorting by it means the rows most
  // in need of a read are the last to get one.
  //
  // Measured on his store (2026-09-09, 92,391 entry-level live rows):
  //
  //            fit 60+   |  unread rows   read rows
  //                      |     1.3%         35%
  //
  // Reading a JD is what moves a row up, so ranking unread rows by fit mostly
  // ranks them by whether they have already been read.
  //
  // `relevance` is the honest pre-read signal — it scores the TITLE, which is
  // all we have before fetching — and it predicts the post-read outcome well.
  // Among rows already read:
  //
  //     relevance 20+   → 73% reached fit 60+
  //     relevance 12-19 → 51%
  //     relevance 6-11  → 33%
  //     relevance 0-5   → 14%
  //
  // What that spread is worth HERE, measured rather than assumed: the next 400
  // rows chosen by fit average relevance 17.7, with 328 of 400 at relevance
  // 12+; chosen by relevance they average 27.5, with 400 of 400. So the change
  // buys roughly the difference between the 51% and 73% bands — real, and
  // considerably smaller than the 5x spread of the signal itself, which
  // measures how good relevance is at ranking and not how much this reordering
  // gains. The old sort was not blind; it was just reading a noisier proxy.
  //
  // Fit still leads when re-reading rows that already HAVE a description
  // (--force), because there the score is computed from real text.
  //
  // NEW-GRAD POSTINGS FIRST (F-672, 2026-10-03). 464 unread rows carried
  // f_newgrad against 175,474 that did not, and Micron's "New College Grad
  // ... Shift Engineer" titles score relevance 0, so a 150-row batch ordered
  // by relevance never reached the postings he is actually eligible for.
  const sort = filters.needsRead ? 'unread' : 'fit';
  if (opts.auto && filters.needsRead) {
    // THE SCREEN'S NEXT JOBS FIRST (2026-11-03). The whole-library screen
    // leaves ~11,600 postings that pass every check except "no body yet" —
    // the next jobs that can reach his inbox — and 99.8% had never been
    // attempted, because this queue ranks a million rows by title relevance.
    // They are read first; the relevance queue fills what is left.
    // NEW POSTINGS FIRST (F-983, 2026-11-04): a posting first seen in the last
    // FRESH_HOURS is read before the fit-ordered backlog, so a fit that went
    // live today reaches his inbox today. Measured before: a new posting waited
    // a median 49 h for its body, behind 9,000 older rows.
    const waiting = screenWaiting(opts);
    const first = freshFirst(waiting.filter((w) => !phenomCooling(w.id, phenomMisses)), opts.limit).map((w) => { if (w.fresh) SCREEN_NEW.add(w.id); return getJob(w.id, { description: true }); }).filter(Boolean);
    if (first.length >= opts.limit) return first;
    const taken = new Set(first.map((j) => j.id));
    const spent = pacer.totals();
    const rest = byEmployerTaste(query(filters, { sort, limit: Math.max(opts.limit * 10, 2000), full: true }).rows.filter((j) => !taken.has(j.id) && readableNow(j, spent, !isNewPosting(j))), opts.limit - first.length);
    return [...first, ...rest];
  }
  const { rows } = query(filters, { sort, limit: opts.limit, full: true });
  return rows;
}

/**
 * Can this run send a request for the row: a detail URL, a site with today's
 * allowance left, and not cooling after refusing us. A batch of rows that are
 * only skipped reads nothing (2026-11-03: 11 of 12 paced once the screen's
 * list was spent). A backlog row also leaves the new postings' share of the
 * day alone until the release hour (F-1000).
 */
function readableNow(j, spentToday = pacer.totals(), backlog = false) {
  if (phenomCooling(j.id, phenomMisses)) return false;
  const spec = detailFor(j.source)?.(j.url, j);
  const target = spec && (spec.html || spec.api);
  if (!target) return false;
  if (!hasAllowance(paceKeys(target, serviceOf), spentToday, PACE_LIMITS, { backlog: backlog && !TARGETED })) return false;
  return !refusalGate.cooling(target);
}

/**
 * New postings the screen passed on everything but their body, chosen this
 * run. A body read for one is a new survivor for the reader: the run's
 * progress file says how many (freshRead), and the dashboard starts a capped
 * read when there are any (F-999 follow-up C).
 */
const SCREEN_NEW = new Set();

/** First seen in the last FRESH_HOURS: a new posting, read ahead of the backlog and from its own share of the day. */
export function isNewPosting(job, now = Date.now()) {
  const seen = Date.parse(job?.firstSeen || job?.first_seen || '');
  return Number.isFinite(seen) && now - seen < FRESH_HOURS * 3600e3;
}

/**
 * Can a board's latest read vouch that a row is gone from it? Not when the
 * read may have stopped at a page cap or a shard (review, 2026-11-03: Amazon
 * reads by category and country, iCIMS/ADP/Jibe stop at max_pages): the
 * listing check's own rule, a board at CAPPED_BOARD postings proves nothing.
 * A sitemap lists every posting, so it always can. A row skipped here is only
 * read later, never retired.
 */
export function boardCanVouch(source, recent) {
  if (/^sitemap-jobs/.test(String(source || ''))) return true;
  if (/^amazon/.test(String(source || ''))) return false;
  return recent > 0 && recent < CAPPED_BOARD;
}

/** Has the board been read more than a day after it last listed this row? */
export function droppedByItsBoard(lastSeen, boardNewest) {
  const b = Date.parse(boardNewest || ''), r = Date.parse(lastSeen || '');
  return Number.isFinite(b) && Number.isFinite(r) && b - r > 86_400_000;
}

/**
 * The library screen's "waiting on a body" rows, best fit first, that this
 * run can actually read: a deriver exists, under three strikes, not gone, and
 * not on a site that is out of today's allowance or cooling after refusing
 * us (a batch of rows that are only skipped reads nothing).
 */
export function screenWaiting(opts = {}, { file = path.join(STORE_DIR, 'screen.db'), cap = 3000, now = Date.now() } = {}) {
  let ids = [];
  try {
    const s = new DatabaseSync(file, { readOnly: true });
    // Every waiting row, best fit first (no cap here: a new posting with a
    // middling fit must not fall past it); the cap applies to what is returned.
    try { ids = s.prepare("SELECT id FROM verdicts WHERE stage = 'waiting-body' ORDER BY fit DESC").all().map((r) => r.id); }
    finally { s.close(); }
  } catch { return []; }
  const spentToday = pacer.totals();
  // A row its own board has stopped listing is most likely closed: Apple's
  // waiting rows last listed on 10-31 all answered 404 on 11-03, those listed
  // that morning 200. The listing check retires them after 7 days; until then
  // the reader spends its turn on rows the board still lists.
  const newest = new Map();
  const newestFor = (j) => {
    const k = `${j.company}\u0001${j.source}`;
    if (!newest.has(k)) {
      try {
        const m = db().prepare('SELECT max(last_seen) AS m FROM jobs WHERE company = ? AND source = ?').get(j.company, j.source)?.m || null;
        const recent = m ? db().prepare("SELECT count(*) AS n FROM jobs WHERE company = ? AND source = ? AND last_seen >= datetime(?, '-1 day')").get(j.company, j.source, m)?.n || 0 : 0;
        newest.set(k, boardCanVouch(j.source, recent) ? m : null);
      } catch { newest.set(k, null); }
    }
    return newest.get(k);
  };
  // Only the columns the choice needs (review, 2026-11-03): the full record,
  // body included, is loaded for the rows a run actually takes (fullRows).
  // The columns for every waiting id in a few batched reads (review,
  // 2026-11-04: one lookup per row over 9,000 rows), then the cheap checks, then
  // the costly ones (the board's newest listing, today's allowance) only until
  // `cap` rows are found: new postings first, then the backlog, fit order within each.
  const cols = 'id, url, title, company, source, location, last_seen, gone_at, enrich_fails, desc_len, enriched_at, first_seen';
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db().prepare(`SELECT ${cols} FROM jobs WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) byId.set(r.id, r);
  }
  const fresh = [], backlog = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.gone_at || (r.enrich_fails || 0) >= 3) continue;
    if (r.desc_len && !(r.desc_len < THIN_BODY && !r.enriched_at)) continue;   // needsReading, from the columns
    const src = String(r.source || '').replace(/-manual$/, '');
    if (opts.sources?.length && !opts.sources.includes(src)) continue;
    const j = { id: r.id, url: r.url, title: r.title, company: r.company, source: r.source, location: r.location, lastSeen: r.last_seen,
      fresh: now - Date.parse(r.first_seen || 0) < FRESH_HOURS * 3600e3 };
    (j.fresh ? fresh : backlog).push(j);
  }
  const out = [];
  const take = (list, max) => {
    let n = 0;
    for (const j of list) {
      if (n >= max) break;
      if (droppedByItsBoard(j.lastSeen, newestFor(j))) continue;
      if (!readableNow(j, spentToday, !j.fresh)) continue;
      out.push(j); n += 1;
    }
  };
  take(fresh, cap);
  take(backlog, cap);
  return out;
}

/** How new a posting must be to go ahead of the backlog (first seen, hours). */
export const FRESH_HOURS = 72;

/** The most of one batch new postings may take, so the backlog always gets reads (review, 2026-11-04). */
export const FRESH_SHARE = 0.6;

/**
 * New postings first (his kind of employer first among them), then the backlog
 * the same way. New postings take at most FRESH_SHARE of a batch: a board added
 * today is all "first seen" for three days and would otherwise fill every
 * batch. Whatever either side cannot fill, the other may.
 */
export function freshFirst(rows, limit, classOf = employerClass) {
  const freshAll = byEmployerTaste(rows.filter((j) => j.fresh), limit, classOf);
  const backAll = byEmployerTaste(rows.filter((j) => !j.fresh), limit, classOf);
  const freshTake = Math.min(freshAll.length, Math.max(limit - backAll.length, Math.ceil(limit * FRESH_SHARE)));
  return [...freshAll.slice(0, freshTake), ...backAll.slice(0, limit - freshTake)];
}

// HIS KIND OF EMPLOYER IS READ FIRST (2026-11-01). The day's per-site
// allowance went to employers the curator turns down without reading: Quest
// Global took 488 reads and Trane had 141 waiting (both ruled out in his taste
// quiz), while 1,727 fit-70+ postings had never been fetched at all. The
// background reader now skips ruled-out employers and reads stars, big names,
// conglomerates and his named funded startups (F-948) before unknown ones, keeping the
// pre-read order within each class. A preset with no taste gate ('any')
// changes nothing.
const TASTE_RANK = { any: 0, star: 0, name: 1, role: 2, vc: 2, other: 3, backup: 4 };
export function byEmployerTaste(rows, limit, classOf = employerClass) {
  return rows.map((j, i) => ({ j, i, k: classOf(j.company) }))
    .filter((x) => x.k !== 'out')
    .sort((a, b) => (TASTE_RANK[a.k] ?? 3) - (TASTE_RANK[b.k] ?? 3) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.j);
}

// ── run ─────────────────────────────────────────────────────────────

// THE SAME CAP THE SCANNER NEEDED, FOR THE SAME REASON (F-426).
//
// This pool ran at a flat width with no notion of which service a request was
// aimed at — the exact shape of F-421, where a per-hostname cap let eleven
// Recruitee subdomains hammer one shared rate limiter. A 400-row run showed
// zero network failures, which is what made it look benign; a 5,582-row run
// returned **122 HTTP 429s**. Roughly 45% of the store is Workday, so most
// enrichment requests land on `myworkdayjobs.com`, and at scale that is one
// service being asked six questions at once for hours.
//
// A 429 here is quieter than in the scanner and worse: the row simply stays
// unread, and an unread row keeps looking eligible because `f_hard_block = 0`
// means "never examined", not "clear".


/** Enriched rows are written in groups of this many as they arrive (or every 15 s). */
export const SAVE_EVERY = Number(process.env.JARVIS_ENRICH_SAVE_EVERY) || 8;
const PER_SERVICE = Number(process.env.JARVIS_ENRICH_PER_SERVICE) || 3;
const withService = makeHostLimiter(PER_SERVICE);

// A DAY'S BUDGET, NOT JUST A MOMENT'S (F-437). `withService` bounds how many
// requests are in flight; `pacer` bounds how many are sent to one service
// today. Every host that pushed back on this project pushed back on VOLUME,
// not on concurrency — Micron after roughly 250 postings, every *.icims.com
// host after a few hundred, Workday with 122 rate-limits across one long pass.
// A concurrency cap cannot express that, because it forgets a request the
// moment it finishes.
// A run over a hand-picked list (--ids-file) gets the small targeted reserve,
// so the auto worker spending the day's allowance cannot starve it.
// Per employer site on Workday, iCIMS and Oracle, under a platform ceiling;
// his numbers, in settings.json (F-979).
let PACE_LIMITS = paceLimits({});
try { PACE_LIMITS = paceLimits(readSettings()); } catch { /* defaults */ }
const withTenant = makeHostLimiter(PACE_LIMITS.tenantConcurrency);
// A hand-picked list (--ids-file) has its own reserve and is never "backlog".
const TARGETED = process.argv.includes('--ids-file');
const pacer = makePacer(pacePath(STORE_DIR), { reserve: TARGETED ? TARGETED_RESERVE : 0, limits: PACE_LIMITS });

// A SITE THAT REFUSES US COOLS DOWN, PER HOST (2026-11-03, refusals.mjs).
const REFUSALS_FILE = refusalsPath(STORE_DIR);
const refusalGate = makeRefusalGate(loadRefusals(REFUSALS_FILE));

// A PHENOM PAGE NOT FOUND COOLS DOWN FOR A DAY (F-1048 follow-up, 2026-11-12).
// It takes no strike (readPhenomPage), so without this it would be fetched
// again on every 3-minute pass. Kept as id → time of the miss.
const PHENOM_MISSES_FILE = path.join(STORE_DIR, 'phenom-misses.json');
const phenomMisses = loadPhenomMisses(PHENOM_MISSES_FILE);

/** Thrown when a service is out of budget: skipped, never counted against the row. */
class Paced extends Error {
  constructor(service) {
    super(`paced out for today (${service})`);
    this.paced = true;
    this.service = service;
  }
}

/** Spend one request against a service, or refuse. An older row leaves the new postings' share alone (F-1000). */
function spend(url, job = null) {
  const keys = paceKeys(url, serviceOf);
  const backlog = !TARGETED && !!job && !isNewPosting(job);
  if (!pacer.take(keys, { backlog })) {
    const site = keys.tenant || keys.service;
    // Refused only by the hold: the day is not spent, it is kept for new postings.
    throw new Paced(backlog && pacer.allows(keys) ? `${site} (kept for new postings until ${PACE_LIMITS.freshReleaseUtc}:00 UTC)` : site);
  }
  return keys;
}

/** One request: counted against the day, at most PER_SERVICE in flight per platform and 2 per employer site. */
function paced(url, fn, job = null) {
  const { service, tenant } = spend(url, job);
  return withService(service, () => (tenant ? withTenant(tenant, fn) : fn()));
}

async function pool(items, worker, concurrency) {
  const results = []; let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx).catch(err => ({ error: err.message }));
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * A LOCKED STORE IS WAITED OUT, NOT A CRASH (2026-11-03). A board scan holds
 * the store's write lock for long stretches; the enricher's write-back threw
 * "database is locked" and the process exited, losing what it had read. It
 * retries for up to two minutes, then gives up loudly.
 */
async function withStoreLockPatiently(fn, { waitMs = Number(process.env.JARVIS_ENRICH_LOCK_WAIT_MS) || 120_000 } = {}) {
  // Exponential backoff under one overall cap (review, 2026-11-03), matched on
  // SQLite's own code (SQLITE_BUSY = 5, SQLITE_LOCKED = 6), not on wording.
  const until = Date.now() + waitMs;
  let delay = 1000;
  for (;;) {
    try { return await withStoreLock(fn); }
    catch (e) {
      if (!isLockError(e) || Date.now() + delay > until) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 20_000);
    }
  }
}
export function isLockError(e) {
  return [5, 6].includes(Number(e?.errcode)) || /^SQLITE_(?:BUSY|LOCKED)/.test(String(e?.code || ''));
}

async function runBatch(jobs, T) {

  // The workers mutate these copies; the write-back reads them by id.
  const byId = new Map(jobs.map(j => [j.id, j]));

  let ok = 0, failed = 0, gone = 0, newBlocks = 0, freshRead = 0;


  // WHY A READ FAILED, NOT JUST THAT IT DID (F-423). This reported a bare
  // , which is not a diagnosis:
  // a rate limit, a dead host, a deriver that cannot build a URL and a page
  // that returned no usable text all landed in one number, so there was no way
  // to tell whether the fix was patience, a provider, or nothing at all.
  // WHICH EMPLOYER, NOT JUST WHICH ERROR (F-428). "154 page had no JobPosting
  // data" is a reason without an owner. The same 154 read as "Lam Research 98,
  // Eaton 56" says something actionable: those two boards are client-rendered
  // and no deriver will ever read them, so the rows want the browser-assist
  // channel rather than another pass. Failures cluster by employer far more
  // than by anything else, and a summary that hides that is a summary that
  // gets read as "the network is flaky" for months.
  const note = (why, company) => {
    T.failReasons.set(why, (T.failReasons.get(why) || 0) + 1);
    if (!company) return;
    if (!T.failWho.has(why)) T.failWho.set(why, new Map());
    const who = T.failWho.get(why);
    who.set(company, (who.get(company) || 0) + 1);
  };
  const enrichedIds = [];
  const failedIds = [];
  // Rows whose failure was the HOST refusing us (403/429/5xx/timeout) rather
  // than anything about the posting. They are retried, never struck.
  const refusedIds = new Set();
  // Rows no detail URL can be built for. Nothing was fetched and nothing will
  // be on the next pass either — the same URL goes into the same deriver — so
  // they take all three strikes at once. F-761 put ~8,900 Phenom teasers that
  // link to boards with no reader (SuccessFactors, Taleo, Okta…) into the
  // read queue; three passes each would have spent ~27,000 batch slots on
  // rows that never cost a request.
  const unreachableIds = new Set();
  const goneIds = [];
  // SAVED AS IT GOES (2026-11-03). Enriched rows were held until every fetch in
  // the batch returned and written in one block, so a run stopped by a timeout
  // or the memory reaper lost every body it had read (a 590 s cap lost a whole
  // 400-row batch twice in one night). A read body is a fact about one posting
  // and needs no batch-level check, so it is written in small groups as soon as
  // it arrives; gone and failed rows still wait for the batch (the mass-expiry
  // breaker needs the whole batch to judge them).
  const saved = new Set();
  let pendingSave = [];
  let lastFlush = Date.now();
  const writeEnriched = (id) => {
    const src = byId.get(id);
    if (!src || saved.has(id)) return;
    updateJob(id, {
      title: src.title,
      location: src.location,
      ...(src.team ? { team: src.team } : {}),
      description: src.description,
      postedAt: src.postedAt,
      enrichedAt: src.enrichedAt,
      enrichFails: 0,
    }, { rederive: true });
    saved.add(id);
  };
  const flushSaves = async (force = false) => {
    if (!pendingSave.length || (!force && pendingSave.length < SAVE_EVERY && Date.now() - lastFlush < 15_000)) return;
    const ids = pendingSave; pendingSave = []; lastFlush = Date.now();
    // A failed flush is said and its rows go back in line: the next arrival
    // retries them, and the batch's final write takes whatever is left.
    try { await withStoreLockPatiently(async () => { for (const id of ids) writeEnriched(id); }, { waitMs: 30_000 }); }
    catch (e) { console.error(`  ! save of ${ids.length} bodies deferred: ${String(e?.message || e).slice(0, 120)}`); pendingSave.unshift(...ids); lastFlush = 0; }
  };
  const tick = () => { T.done++; if (T.done % 5 === 0 || T.done === T.total) writeProgress({ running: true, total: T.total, done: T.done, ok: T.ok + ok, failed: T.failed + failed, gone: T.gone + gone, paced: T.paced, pacedServices: [...T.pacedServices], startedAt: T.startedAt }); };
  await pool(jobs, async (job) => { try {
    const deriver = detailFor(job.source);
    const spec = deriver(job.url, job);
    if (!spec) { failed++; note(`no detail URL for source ${job.source}`, job.company); failedIds.push(job.id); unreachableIds.add(job.id); return; }
    const target = spec.html || spec.api;
    // A site cooling down after refusing us: untouched, like a paced row.
    if (target && !refusalGate.allow(target)) { T.paced++; T.pacedServices.add(`${hostKey(target)} (refusing us; asked again later)`); return; }
    try {
      let text = '';
      if (spec.html) {
        // JSON-LD path: exact title + location come along with the description.
        let jp;
        if (spec.phenomGuess) {
          // Not found under any locale the site names: retried on the next
          // pass like a refusal, never a strike. A posting that is really gone
          // leaves through the scan, which stops listing it.
          jp = (await readPhenomPage(spec.html, { applyUrl: spec.applyUrl, fetchAt: (u) => paced(u, () => fetchHtmlAt(u), job) }))?.jp;
          if (!jp) { failed++; phenomMisses[job.id] = new Date().toISOString(); note('Phenom page not found under its locale (no strike; asked again in 24 h)', job.company); return; }
          delete phenomMisses[job.id];
        } else {
          let page = await paced(spec.html, () => fetchHtmlAt(spec.html), job);
          const other = spec.locale ? localeVariant(page.url, spec.locale) : null;
          if (other) page = await paced(other, () => fetchHtmlAt(other), job);
          jp = jobPostingFromHtml(page.text);
        }
        if (!jp) { failed++; note('page had no JobPosting data', job.company); failedIds.push(job.id); return; }
        text = htmlToText(jp.description || '');
        if (jp.title) job.title = String(jp.title).trim();
        if (jp.occupationalCategory) job.team = String(jp.occupationalCategory).trim();
        const loc = locationFromJsonLd(jp);
        if (loc) job.location = loc;
        if (jp.datePosted) {
          const ts = Date.parse(jp.datePosted);
          if (!Number.isNaN(ts)) job.postedAt = ts;
        }
      } else {
        const data = await paced(spec.api, () => fetchJson(spec.api, job.source), job);
        text = htmlToText(spec.pick(data));
        if (spec.team) {
          const t = spec.team(data);
          if (t) job.team = t;
        }
        // The posting's own title wins over the one a list wrote (2026-11-03):
        // Simplify renames postings ("Memory Design Engineer New Grad - …"),
        // and a renamed requisition keeps its old URL slug.
        if (spec.title) {
          const t = String(spec.title(data) || '').trim();
          if (t) job.title = t;
        }
      }
      if (!text || text.length < 40) { failed++; note('description too short to use', job.company); failedIds.push(job.id); return; }
      // Headings with nothing under them (F-760): a translated template, not a
      // posting. Structural — the next read returns the same page — so it
      // strikes, and the stored body (if any) is left as it was.
      if (hollowBody(text)) { failed++; note('every requirement section empty', job.company); failedIds.push(job.id); return; }
      job.description = text;
      // No structured team? Parse the description ("Group/Division: …").
      if (!job.team) {
        const t = teamFromDescription(text);
        if (t) job.team = t;
      }
      const before = job.triage?.flags?.hardBlock;
      job.triage = triage({ title: job.title, description: text, location: job.location, url: job.url });
      // The description is the whole point of enrichment, and fit's skills
      // dimension is only judgeable once one exists — rescore now rather than
      // leaving a title-only score attached to a fully-read posting.
      job.salary = resolveSalary(job);
      job.fit = slimFit(scoreFit(job, getProfile()));
      job.enrichedAt = new Date().toISOString();
      enrichedIds.push(job.id);
      pendingSave.push(job.id);
      await flushSaves();
      if (!before && job.triage.flags.hardBlock) {
        newBlocks++;
        console.log(`  ⛔ NEW BLOCK: ${job.title} (${job.company}) — ${job.triage.visa.block.reason}`);
      }
      ok++;
      if (SCREEN_NEW.has(job.id)) freshRead++;
      if (target) refusalGate.answered(target);
    } catch (err) {
      if (target && !err?.paced) {
        if (isPolicyRefusal(err?.httpStatus)) refusalGate.refused(target);
        else if (err?.gone || (err?.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429)) refusalGate.answered(target);
      }
      // A posting the ATS has taken down is not a failed fetch — it is an
      // answer. Counting it as a failure meant the same dead req was retried
      // three times, reported as "unreachable", and left sitting in the deck
      // for him to click into. 5,979 unread Workday postings were in that
      // state, and the ones sampled were all genuinely gone.
      if (err && err.gone) { goneIds.push(job.id); gone++; }
      // PACED OUT IS NOT A FAILURE (F-437). We chose not to ask this service
      // again today. That is a fact about our own budget, not about the
      // posting — so it is not counted as failed, not recorded as a strike
      // (F-429), and certainly not marked gone (F-427). The row is simply
      // untouched and will be read on the next run.
      else if (err && err.paced) { T.paced++; T.pacedServices.add(err.service); }
      else {
        failed++;
        const s = err?.status;
        // 403 and 429 are refusals; 5xx and a bare timeout are the transport
        // failing. None of them is evidence about this posting.
        if (isRefusal(s)) refusedIds.add(job.id);
        note(s === 429 ? 'rate limited (429)'
          : s ? `HTTP ${s}`
          : (err?.message || 'unknown').slice(0, 40), job.company);
        failedIds.push(job.id);
      }
    }
  } finally { tick(); } }, CONCURRENCY);

  // Write each enriched posting onto the CURRENT row rather than onto the copy
  // this run started with, so a ♥ or a hide clicked mid-run is never clobbered.
  //
  // This used to be a reload-and-merge under a file lock, because saving
  // rewrote the whole store and a scan that added jobs meanwhile would have
  // them erased — this worker runs every three minutes and was the likeliest
  // thief. Row-level writes make that impossible, so the dance is gone.
  await withStoreLockPatiently(async () => {
    // Persist failure counts so permanently-broken postings stop being retried
    // by the auto worker after 3 strikes.
    //
    // A REFUSAL IS NOT A STRIKE (F-429). Three strikes puts a row past
    // `enrich_fails < 3` and it is never read again — so what counts as a
    // strike decides what becomes permanently unreadable. A 403 or a 429 says
    // nothing about the POSTING; it says the host would not serve US, this
    // minute. Counting those meant three rate-limited runs against one
    // employer silently retired its whole board: measured 2026-09-09, **7,187
    // live unread rows** already sat past the cutoff, led by Accenture 490,
    // AbbVie 485, DaVita 413, Emerson 330.
    //
    // The mass-expiry breaker below already reasons this way about "gone" —
    // "a batch we chose not to trust is not evidence against any single
    // posting" — and the same sentence applies here. This is that argument
    // finally applied to ordinary failures too.
    //
    // Structural failures DO still strike: no detail URL for the source, a
    // page carrying no JobPosting data, a description too short to use. Those
    // are facts about the posting or its board and will not change on the next
    // pass, so retrying them forever is pure cost.
    for (const id of failedIds) {
      if (refusedIds.has(id)) continue;
      const job = getJob(id);
      if (job) updateJob(id, { enrichFails: unreachableIds.has(id) ? Math.max(3, (job.enrichFails || 0) + 1) : (job.enrichFails || 0) + 1 });
    }
    // Taken down at the source. Stamped, never deleted — the row, its score and
    // its quotes stay exactly where they were, and isDeck() drops it out of the
    // browsable pile so no evening is spent on a req that no longer exists.
    //
    // WITH ONE CIRCUIT BREAKER. Postings expire a few at a time; a whole batch
    // coming back "gone" is not an employer clearing its board, it is an ATS
    // rate-limiting us or an endpoint shape that has changed. Marking live jobs
    // dead is the one error this system does not tolerate, so past that
    // threshold the run refuses to write and says why.
    const attempted = ok + gone + failed;
    const massExpiry = attempted >= 20 && gone / attempted > 0.6;
    if (massExpiry) {
      console.warn(`\n  ⚠  ${gone} of ${attempted} came back "gone" — that is a rate limit or a changed`);
      console.warn(`     endpoint, not an employer clearing its board. Nothing marked; they will retry.`);
      // "They will retry" has to be TRUE. Counting these as enrichment failures
      // meant three rate-limited runs pushed every one of them past the 3-strike
      // cutoff in filters.needsRead, and they would never be read again — the
      // slow version of exactly the outcome this breaker exists to prevent. A
      // batch we chose not to trust is not evidence against any single posting,
      // so nothing is recorded against them.
    } else {
      for (const id of goneIds) updateJob(id, { goneAt: new Date().toISOString() }, { rederive: true });
    }
    // rederive: a posting whose body has just been read for the first time
    // was scored on its title alone. Leaving the old score in place is how
    // derived data goes stale, which is this system's characteristic failure.
    // A read that worked clears the strikes (enrichFails: 0): left standing,
    // old strikes keep a readable posting out of the liveness sweep for good.
    // Most rows were already saved as they arrived; this writes the rest.
    for (const id of enrichedIds) writeEnriched(id);
  });
  // Roll this batch into the run totals; the driver prints the summary.
  T.ok += ok; T.failed += failed; T.gone += gone; T.newBlocks += newBlocks; T.freshRead += freshRead;
}


// WHY THIS RUNS IN SUB-BATCHES (F-425).
//
// Every enriched posting used to be held until the last fetch returned, then
// written in one transaction. A 5,000-row run died 
// on `assert(!this.paused)` — an assertion inside Node's own HTTP parser,
// thrown from a socket event handler, so no try/catch around the fetch can see
// it and the process simply exits. Every row read up to that point was lost,
// because none of it had been written yet.
//
// Batching bounds that loss to one chunk and bounds peak memory with it. The
// mass-expiry circuit breaker below keeps working because it is a per-batch
// judgement to begin with: 20 attempted, 60% "gone", refuse to mark any of
// them. A smaller batch makes that breaker more sensitive, not less.
const BATCH = Number(process.env.JARVIS_ENRICH_BATCH) || 400;

async function main() {
  const opts = parseArgs();
  const want = Number.isFinite(opts.limit) ? opts.limit : Infinity;

  // SELECTION IS BATCHED TOO, NOT JUST THE WRITE (F-425, second half).
  //
  // Batching the write bounded how much a crash could lose, but selection still
  // materialised the whole run up front — `query(..., { full: true })` loads
  // every row WITH its description, so `--limit 10000` allocated ten thousand
  // full postings before the first fetch. The OS killed that run for memory,
  // which is the same ceiling F-420 hit in the scanner, reached from the other
  // side.
  //
  // Selecting a batch at a time fixes it, and the selection is self-advancing:
  // an enriched row no longer matches `needsRead`, so the next query returns
  // the next-best rows without an offset to track. What does NOT drop out is a
  // row that FAILED — it still needs reading, so it would be handed back
  // forever. `seen` is what breaks that loop: rows already attempted in THIS
  // run are filtered out, and the query overfetches by however many of them are
  // still ranking above the ones we have not tried.
  // How far to look past the rows this run has already attempted. Measured
  // from what the query actually returns rather than inferred from outcomes:
  // the first version computed it from "enriched + gone" and got it wrong,
  // because a row marked GONE still matches the read filter and came straight
  // back, so the second query returned the same 40 rows, `seen` filtered them
  // all out, and the run stopped after one batch believing the well was dry.
  const seen = new Set();
  let overfetch = 0;
  const MAX_OVERFETCH = 5_000; // the memory ceiling this whole change exists to respect

  const T = {
    total: Number.isFinite(want) ? want : 0, done: 0,
    ok: 0, failed: 0, gone: 0, newBlocks: 0, freshRead: 0,
    failReasons: new Map(),
    failWho: new Map(),
    paced: 0,
    pacedServices: new Set(),
    startedAt: new Date().toISOString(),
  };
  LIVE = T;

  let first = true;
  while (T.done < want) {
    const room = Math.min(BATCH, want - T.done);
    const raw = selectJobs({ ...opts, limit: room + overfetch });
    const fresh = raw.filter(j => !seen.has(j.id));

    if (!fresh.length && !first) {
      // Everything visible has been attempted this run. If the query came back
      // full it was truncated by its own limit and there may be untried rows
      // behind it, so widen the window once and look again.
      if (raw.length >= room + overfetch && overfetch < MAX_OVERFETCH) {
        overfetch = Math.min(overfetch + BATCH, MAX_OVERFETCH);
        continue;
      }
      break;
    }
    // However many already-attempted rows outrank the fresh ones, skip past
    // them next time instead of paying for them again.
    overfetch = Math.min(raw.length - fresh.length, MAX_OVERFETCH);
    const batch = fresh.slice(0, room);

    if (!batch.length) {
      if (first) {
        console.log('Nothing to enrich (no matching jobs with a supported detail API and a missing description).');
        console.log('Supported sources: ' + Object.keys(DETAIL).join(', ') + '. Use --force to re-fetch.');
        LIVE = null;
        writeProgress({ running: false, total: 0, done: 0, ok: 0, failed: 0, completedAt: new Date().toISOString() });
        return;
      }
      break; // the well is dry, or everything left was already attempted
    }

    if (first) {
      console.log(`Enriching up to ${Number.isFinite(want) ? want : 'every matching'} posting(s) (${CONCURRENCY} at a time, ${BATCH} per batch)…\n`);
      writeProgress({ running: true, total: T.total, done: 0, ok: 0, failed: 0, startedAt: T.startedAt });
      first = false;
    }

    for (const j of batch) seen.add(j.id);
    await runBatch(batch, T);
    if (!Number.isFinite(want)) T.total = T.done;
  }

  finishProgress();
  console.log(`\n── Enrichment complete ──`);
  console.log(`  Enriched : ${T.ok}`);
  console.log(`  Gone     : ${T.gone}  (taken down at the source — dropped from the deck, row kept)`);
  console.log(`  Failed   : ${T.failed}  (could not reach — will retry)`);
  // The breakdown, because the bare count was not a diagnosis (F-423): a rate
  // limit means run slower, a missing deriver means write a provider, and a
  // 404 means the posting is gone — three different actions behind one number.
  for (const [why, n] of [...T.failReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`             ${String(n).padStart(5)}  ${why}`);
    // Named, because failures cluster by employer far more than by anything
    // else, and "Lam Research 98, Eaton 56" is a decision where "154 failed"
    // is a shrug (F-428).
    const who = [...(T.failWho.get(why) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (who.length) console.log(`                    ${who.map(([c, k]) => `${c} ${k}`).join(', ')}`);
  }
  if (T.paced) {
    console.log(`  Paced    : ${T.paced}  (budget spent for today on ${[...T.pacedServices].join(', ')} — not failures, they retry tomorrow)`);
  }
  console.log(`  New work-auth blocks surfaced from description text: ${T.newBlocks}`);
  reportBlindSpot();
  pacer.flush();
  try {
    const { state, cooled, cleared } = refusalGate.finish();
    saveRefusals(REFUSALS_FILE, state);
    for (const c of cooled) console.log(`  Refusing: ${c.host} answered only 403s; asked again after ${new Date(c.until).toLocaleString()} (time ${c.times}), with a few probes each night`);
    if (cleared.length) console.log(`  Answering again: ${cleared.join(', ')}`);
  } catch (e) { console.log(`  (refusal record not saved: ${String(e?.message || e).slice(0, 80)})`); }
  // Re-read before writing: a second enrich run may have added its own misses.
  try { writeFileSync(PHENOM_MISSES_FILE, JSON.stringify(prunePhenomMisses({ ...loadPhenomMisses(PHENOM_MISSES_FILE), ...phenomMisses }))); } catch { /* a convenience, never a reason to fail */ }
  const spent = pacer.spent().slice(0, 4);
  if (spent.length) console.log(`  Today so far: ${spent.map(([s, n]) => `${s} ${n}`).join(', ')}`);
}


/**
 * What this run could not even attempt (F-443).
 *
 * `selectJobs` filters on `source IN (Object.keys(DETAIL))`. A row whose
 * source has no deriver is not skipped, not failed and not retried — it is
 * outside the query. So "Enrichment complete, 0 failed" was true and useless:
 * 4,743 live Tesla postings, 1,059 of them relevant to him, sat at
 * `enrich_fails = 0` and were never mentioned by any run.
 *
 * That is this system's characteristic failure wearing a new hat — a zero that
 * means "nobody looked" reading exactly like a zero that means "looked and
 * found nothing". Under F-1/OPT the direction matters: an unread posting
 * carries `f_hard_block = 0` by default, so unreadable and clear are the same
 * shape on a card.
 *
 * The honest end of a run therefore names its own blind spot and the route out
 * of it, which for these sources is the browser, not another pass.
 */
export function blindSpot(handle = db()) {
  const known = Object.keys(DETAIL);
  // Counted in the database rather than materialised — the same reason
  // block-audit.mjs asks in SQL. `source NOT IN (derivers)` is the whole
  // question, and it is exactly the clause selectJobs applies in reverse.
  const rows = handle.prepare(`
    SELECT source, company, COUNT(*) AS n
    FROM jobs
    WHERE gone_at IS NULL
      AND superseded_by IS NULL
      AND (has_desc = 0 OR has_desc IS NULL)
      AND location_bucket IN ('us','remote','unknown')
      AND relevance >= 12
      AND source NOT IN (${known.map(() => '?').join(',')})
    GROUP BY source, company
  `).all(...known);

  const bySource = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, { n: 0, who: [] });
    const e = bySource.get(r.source);
    e.n += r.n;
    e.who.push([r.company, r.n]);
  }
  return [...bySource.entries()]
    .map(([source, e]) => ({
      source,
      count: e.n,
      companies: e.who.sort((a, b) => b[1] - a[1]).slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count);
}

function reportBlindSpot() {
  let spots;
  try { spots = blindSpot(); } catch { return; }
  if (!spots.length) return;
  const total = spots.reduce((n, s) => n + s.count, 0);
  console.log(`\n  Not attempted at all: ${total} relevant unread posting(s) in ${spots.length} source(s)`);
  console.log(`  with no detail deriver. These never fail and never retry — they are`);
  console.log(`  outside the query, and only the browser channel can read them:`);
  for (const s of spots) {
    const who = s.companies.map(([c, n]) => `${c} ${n}`).join(', ');
    console.log(`     ${String(s.count).padStart(5)}  ${s.source}${who ? `  (${who})` : ''}`);
  }
  console.log(`  → harvest in his Chrome, then: node jarvis/import-descriptions.mjs <file.json>`);
}


// THE MIRROR THAT CANNOT DRIFT (F-444). `detail-sources.mjs` exists so the
// dashboard and the server can name these boards without importing this file
// (which would run guardArgs against their argv). A copy is only safe if
// copying wrong is loud, so the two are compared the moment this module loads.
//
// A warning, not a throw: this is imported by the auto worker mid-scan, and
// turning a stale list into a crash trades a wrong sentence on a card for a
// dead enrichment run. The message says which direction it drifted, because
// "add a name to detail-sources.mjs" and "delete one" are different fixes.
{
  const { missing, stale } = driftFrom(Object.keys(DETAIL));
  if (missing.length) {
    console.warn(`[enrich] detail-sources.mjs is missing ${missing.join(', ')} — the dashboard will tell him those boards cannot be read when they can. Add them there.`);
  }
  if (stale.length) {
    console.warn(`[enrich] detail-sources.mjs names ${stale.join(', ')}, which DETAIL no longer has — the dashboard will promise a read that fails. Remove them there.`);
  }
}

// Run only when executed directly — importing this module (e.g. for
// teamFromDescription) must not kick off an enrichment run.
import { pathToFileURL } from 'url';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/enrich.mjs [options]

  Pull full descriptions for scored postings and write them to the store.

    --all                 
    --auto                
    --company <value>     
    --fit <value>         
    --force               
    --ids-file <path>     only the posting ids listed in this file, one per line
    --refresh <days>      with --ids-file: also re-read a body last read more than <days> ago
                          (employers edit postings after we read them — F-627)
    --limit <value>       
    --relevance <value>
    --source <a,b>        only these ATSes (greenhouse, ashby, workday, …)
    --stale <value>
    --status <value>
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--all","--auto","--company","--fit","--force","--id","--ids-file","--limit","--refresh","--relevance","--source","--stale","--status"], valued: ["--company","--fit","--id","--ids-file","--limit","--refresh","--relevance","--source","--stale","--status"] });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // WHATEVER ENDS THIS RUN, THE FILE SAYS SO. Ctrl-C, a SIGTERM from the
  // dashboard killing its child, or an uncaught throw each used to leave
  // `running: true` on disk with no `completedAt`, and the bar never came down.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { finishProgress(sig); process.exit(130); });
  }
  main()
    .catch(err => { console.error(err); finishProgress('error'); process.exit(1); })
    .finally(() => finishProgress('exit'));
}
