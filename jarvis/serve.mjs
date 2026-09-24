#!/usr/bin/env node
// jarvis/serve.mjs — the local job-browsing dashboard server.
//
// A single-process, dependency-free HTTP server (Node built-ins only). It is
// the "fast personal job platform" surface: it serves one self-contained HTML
// page and a small JSON API the page talks to. No framework, no build, no
// external calls — everything is local files.
//
//   GET  /                → the dashboard page
//   GET  /api/jobs        → { jobs, scans, counts } from the store
//   POST /api/action      → { ids:[...], status } bulk status change; writes store
//   POST /api/deep        → { id } record a request for deeper analysis (queued for the agent)
//
// Actions the user takes here (interested / queued / hidden) are the SAME
// statuses the batch-apply engine will later read from the store. The dashboard
// is not a separate world — it is the control surface over the one job store.
//
// Usage: node jarvis/serve.mjs [--port 4300]   then open http://localhost:4300

import http from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, createReadStream, mkdirSync, appendFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import {
  query, count, countBy, getJob, getListItem, updateJob, setStatuses, setCompanyHidden,
  hiddenCompanies, upsertJobs, recordScan, getScans, storeStats, memoOnStore, distinctCompanies, flagTotals,
  getDescription, STATUSES, STORE_DIR, withStoreLock,
  // Matches an extension run to the posting it was on, when no prepared
  // application claims the page — see /api/filled.
  findByUrl,
  // The board + heading match for a form whose URL names no posting (F-330).
  findByHeading,
  // jobByRequisition scans URLs for a posting id — see /api/apply-page.
  db,
} from './store.mjs';
import { resumeForJob, tailorReport, personFile } from './resume-for-job.mjs';
import { jdKey, sourcesVersion, saveBuild, findReusableBuild, restoreBuild, makeSiblingIndex } from './reuse.mjs';
import { writeCoverLetter, sourcesFor as coverLetterSources } from './cover-letter.mjs';
import { writeAnswer, answerKind, offLimits, WRITER_VERSION } from './apply/essay.mjs';
import { loadCompanyBrief } from './company-context.mjs';
import { contentDisposition } from './text.mjs';
// The letter as a page an ATS can take: his letterhead, the date, the
// recipient, and a one-page PDF (F-410).
import { letterHead, writeLetterPdf } from './cover-letter-page.mjs';
import { resumeTarget } from './apply-resume-target.mjs';
import { LogoCache, logoKey } from './company-logo.mjs';
import { titlesFromSpec } from './resume-variants.mjs';
import { importDescriptions } from './import-descriptions.mjs';
import { READABLE_SOURCES, BROWSER_ONLY } from './detail-sources.mjs';
import { sweep as assistSweep, planSweep } from './assist-liveness.mjs';
import { targetSpec, writeOutreach, emailPattern, domainFrom, candidateEmail, CHANNELS } from './outreach.mjs';
import { startLeadRun, getLeadRun, leadSummary } from './leads.mjs';
import { mailStatus, saveClient, authUrl, finishAuth, disconnect as disconnectMail, syncMail, latestByJob, recentEvents, undoEvent, companyNames } from './mail.mjs';
import {
  contactId, canContact, saveContact, getContact, forJob, allContacts,
  markSent, markReplied, markDoNotContact, dueFollowUps, outreachStats,
} from './contacts.mjs';
// Matches an archived resume back to its store row — see sentArchive().
import { jobId, getJobByUrl, storeVersion, db as storeDb, checkpointWal } from './store.mjs';
import { loadedExtension } from './chrome-extension-state.mjs';
// The resume variants, so /api/resumes knows which folders to look in.
import { ALL_FAMILIES } from './resume-family.mjs';
import { openInChrome } from './open-in-chrome.mjs';
// Refuses to tailor a resume for a posting that answers 404 — see /api/apply.
import { definitelyGone, fetchPostingMeta, checkLivenessViaApi } from '../liveness-api.mjs';
import { planForm, loadApplyProfile, EXPECTED_EXTENSION, extensionIsStale, chooseBand } from './apply-plan.mjs';
import { logPlan, logWritten, logSnapshot, logReport, logRequest } from './answer-log.mjs';
import { whichRule } from './apply/_answers.mjs';
import { recordUnanswered } from './unanswered.mjs';
import vm from 'vm';
import { chooseOption } from './apply/_form.mjs';
import { scoreFit, getProfile, skillLabel } from './fit.mjs';
import { triage } from './triage.mjs';
import { spreadRows } from './deck.mjs';
import { learnFromSkips, learnFromApplyForms } from './skip-learn.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HTML_PATH = path.join(HERE, 'dashboard.html');
const PROGRESS_PATH = path.join(STORE_DIR, 'enrich-progress.json');
/** Cover letters written for postings, by job id — kept for the panel and on disk. */
const LETTERS = new Map();
/**
 * Company -> { domain, pattern } for outreach, learned from that company's own
 * postings. A company's email footer does not change between page loads, and
 * re-deriving it per request means reading twenty compressed descriptions for
 * a fact that was already known.
 */
const EMAIL_HINTS = new Map();
const LETTER_DIR = path.join(STORE_DIR, 'cover-letters');

/**
 * WRITTEN ANSWERS, by posting and question.
 *
 * "Tell us about a project you are proud of" is asked by half the forms he
 * opens, and the answer is the same every time for the same posting — so it is
 * written once and kept, both for the walk that asked and for the next time he
 * opens that application. Keyed by job id plus the question itself, because
 * one form asks several and they are not interchangeable.
 *
 * On disk as well as in memory: a dashboard restart in the middle of an
 * application used to lose the letter, and losing two hundred words he has
 * already read and approved is worse.
 */
const ANSWERS = new Map();
const ANSWER_DIR = path.join(STORE_DIR, 'answers');

/**
 * FINISHED RESUME BUILDS, KEPT (jarvis/reuse.mjs). A fill that timed out, a
 * dashboard restart, a second press of Apply, or a repost with the same
 * description all used to pay for the whole build again.
 */
const BUILD_DIR = path.join(STORE_DIR, 'builds');
const describeForReuse = (id) => {
  const j = getJob(String(id));
  return j ? { company: j.company, description: getDescription(String(id)) || '' } : null;
};
const siblingsOf = makeSiblingIndex({ answerDir: ANSWER_DIR, buildDir: BUILD_DIR, describe: describeForReuse });
const reuseKeyFor = (id) => { const d = describeForReuse(id); return d ? jdKey(d.company, d.description) : null; };

/**
 * The same question, already answered for ANOTHER posting with the same
 * description. Copied under this posting's key — so it is this application's
 * answer from here on, and a rewrite of it changes this one only.
 */
function siblingAnswer(id, question, key) {
  if (!id) return null;
  for (const other of siblingsOf(id, reuseKeyFor(id))) {
    const had = answerFor(answerKeyFor(other, question));
    if (had?.status !== 'ready' || !String(had.text || '').trim()) continue;
    const entry = { ...had, reusedFrom: other, notices: [...(had.notices || []), 'reused from an earlier application with the same job description'] };
    delete entry.fromDisk;
    ANSWERS.set(key, entry);
    try { mkdirSync(ANSWER_DIR, { recursive: true }); writeFileSync(answerFileFor(key), `${JSON.stringify(entry, null, 2)}\n`); } catch { /* memory holds it */ }
    console.log(`  answer → reused for "${String(question).slice(0, 60)}" from job ${other} (same description)`);
    return entry;
  }
  return null;
}

/** One key for one question on one posting. Stable across restarts. */
/**
 * Does the open page mention this company anywhere a reader would see it — its
 * address, its title, its heading or the first screen of its text? The check
 * that stops a stale tab id from sending one posting's description to the
 * writer while he is on another company's form. Lenient on purpose: one hit on
 * any name the company goes by ("Charge" for Charge Robotics, "amat" in a
 * Workday host) is enough.
 */
function pageMentionsCompany(company, page) {
  const hay = `${page.pageUrl} ${page.pageTitle} ${page.heading} ${page.pageText}`.toLowerCase();
  const flat = hay.replace(/[^a-z0-9]+/g, '');
  const names = companyNames(company);
  if (!names.length) return true;
  const aliases = { 'applied materials': ['amat'], 'lam research': ['lamresearch'], 'taiwan semiconductor manufacturing': ['tsmc'] };
  return names.some((n) => hay.includes(n) || flat.includes(n.replace(/ /g, '')))
    || names.some((n) => (aliases[n] || []).some((a) => flat.includes(a)));
}

/**
 * THE PAGE HE IS STANDING ON OUTRANKS THE TAB'S MEMORY.
 *
 * Measured live, 2026-09-19. He had the Tesla form for **Manufacturing
 * Engineer, Process & Equipment Development** open, and the panel said
 * **Manufacturing Engineer, Manufacturing Development** — a different Palo
 * Alto posting he had already applied to — so it also told him he had applied
 * to this one. Two postings, one tab, and the tab kept the older binding.
 *
 * The only staleness check was `pageMentionsCompany`, which asks whether the
 * word "Tesla" appears anywhere on the page. Every Tesla posting passes it, so
 * it cannot separate two of them. Every answer written under that binding would
 * have been written for the wrong job, and the apply record would have landed
 * on the wrong row.
 *
 * The tab's id is a cache; the URL in front of him is the fact. So when the
 * page resolves to a posting of its own, that posting wins. When the page
 * resolves to nothing — an apply form on a host the store never saw — the
 * remembered id stands, which is what it is for.
 */
function jobForRequest(id, page) {
  const remembered = id ? getJob(id) : null;
  if (!page?.pageUrl) return remembered;
  const onPage = jobForPage(page.pageUrl, { heading: page.heading, pageTitle: page.pageTitle });
  if (!onPage) return remembered;
  if (remembered && String(onPage.id) === String(remembered.id)) return remembered;
  if (remembered) {
    console.log(`  tab said ${remembered.company} — ${remembered.title}, but this page is ${onPage.title}; using the page`);
  }
  return onPage;
}

function answerKeyFor(id, question) {
  const q = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
  return `${id || 'no-job'}::${q}`;
}

/** Where that key lives on disk — the question folded into a filename-safe digest. */
function answerFileFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) { h = ((h * 31) + key.charCodeAt(i)) >>> 0; }
  const [id] = key.split('::');
  return path.join(ANSWER_DIR, `${String(id).replace(/[^a-z0-9-]/gi, '')}-${h.toString(16)}.json`);
}

/** Notes he wrote on an answer an older writer produced, by answer key. */
const STALE_FEEDBACK = new Map();

/** An answer written earlier, from memory or from disk. */
function answerFor(key) {
  const live = ANSWERS.get(key);
  if (live) return live;
  const file = answerFileFor(key);
  if (!existsSync(file)) return null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    // AN ANSWER FROM AN OLDER WRITER IS NOT AN ANSWER (2026-09-17). Handing it
    // back is how a retired prompt kept filling his boxes. His notes on it are
    // kept, so the new writer still honours what he said.
    if (saved.writer !== WRITER_VERSION) {
      if (Array.isArray(saved.feedback) && saved.feedback.length) STALE_FEEDBACK.set(key, saved.feedback);
      return null;
    }
    const entry = { ...saved, status: saved.text ? 'ready' : 'failed', fromDisk: true };
    ANSWERS.set(key, entry);
    return entry;
  } catch { return null; }
}

/**
 * EVERY OTHER BOX ON THIS FORM THAT ALREADY HAS AN ANSWER.
 *
 * Alex, 2026-09-13: *"you cant train it for specific questions, when i call it
 * it should know about me, the job, the company, the culture, the social
 * setting to write a good paragraph."* Part of that setting is the rest of the
 * form. A reader sees five boxes side by side; a writer that sees one box at a
 * time tells the fixture story in all five.
 *
 * Keyed on the job id, so it is this application and no other.
 */
function answersWrittenFor(id, exceptKey) {
  if (!id) return [];
  const out = [];
  for (const [key, entry] of ANSWERS) {
    if (key === exceptKey || !key.startsWith(`${id}::`)) continue;
    if (entry?.status !== 'ready' || !String(entry.text || '').trim()) continue;
    out.push({ question: entry.question, text: entry.text });
  }
  return out.slice(0, 6);
}

/**
 * Write one answer in the background and keep it. Returns the entry at once;
 * the page polls it the same way it polls a resume or a letter.
 *
 * Never throws, and never blocks a fill: a question whose answer could not be
 * written goes back on his list with the reason, which is exactly where it was
 * before this existed.
 */
function startAnswer(key, question, { job = null, jd = null, field = null, kind = null, request = '', context = '', stem = '', seriesIndex = 0, seriesOf = 0, avoid = [], previous = '', feedback = [], warn = '' } = {}) {
  const entry = {
    status: 'writing', at: new Date().toISOString(), question: String(question || ''),
    kind: kind || null, text: '', problems: [], notices: [], why: '', request: String(request || ''),
    // Every note he has written about this answer, kept with it so a later
    // rewrite — or a restart — still honours the first one.
    feedback: [...feedback],
  };
  ANSWERS.set(key, entry);
  // His words, kept the moment he asks (answer-log `request` rows).
  try { logRequest({ job, what: 'answer', question, request, previous }); } catch { /* a record, never the answer */ }
  writeAnswer(question, { job, jd, field, kind, request, context, stem, seriesIndex, seriesOf, avoid, previous, feedback, companyBrief: loadCompanyBrief(job), alsoWritten: answersWrittenFor(String(job?.id || ''), key) }).then((r) => {
    Object.assign(entry, {
      status: r.text ? 'ready' : 'failed',
      text: r.text, problems: r.problems, notices: [...(r.notices || []), ...(warn ? [warn] : [])], why: r.why, reading: r.reading || '', writer: r.writer || null,
      kind: r.kind || entry.kind, error: r.text ? null : r.why,
      // WHICH MODEL WROTE IT, kept with the answer and shown beside it. His
      // ask, 2026-09-19: *"I want to be able to compare output quality and know
      // when a weaker model generated the answer."*
      model: r.model || null,
    });
    if (r.text) {
      try {
        mkdirSync(ANSWER_DIR, { recursive: true });
        writeFileSync(answerFileFor(key), `${JSON.stringify(entry, null, 2)}\n`);
      } catch { /* memory holds it */ }
      logWritten({ job, question, text: r.text, why: r.why, model: r.model || null, kind: r.kind || kind, request });
    }
    console.log(`  answer → ${job?.company || 'this form'}: "${String(question).slice(0, 60)}" — ${r.why}`);
  }).catch((e) => {
    Object.assign(entry, { status: 'failed', error: String(e?.message || e), why: String(e?.message || e) });
  });
  return entry;
}

/**
 * Render one letter onto his letterhead and keep the PDF beside the text.
 *
 * Named the way the resume is (F-409): his name, the employer, the role, so
 * the chip a form draws after the upload tells him what actually went on.
 */
async function renderLetterFile(id, job, text) {
  // config/profile.yml's candidate block, which is where his letterhead lines
  // already live in the form his own letters use ("Springfield, WA", not "Springfield,
  // Washington"). The apply profile's identity block is the fallback.
  let candidate = {};
  try { candidate = coverLetterSources().candidate || {}; } catch { candidate = {}; }
  if (!candidate.full_name) {
    const ident = loadApplyProfile()?.identity || {};
    candidate = {
      full_name: ident.preferred_full_name || ident.full_name,
      location: ident.location, phone: ident.phone, email: ident.email,
    };
  }
  const head = letterHead({ candidate, job, jd: getDescription(id) || '' });
  const bit = (v) => String(v || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const name = [bit(candidate.full_name || 'Alex Rivera'), bit(job.company), bit(job.title).slice(0, 60), 'Cover Letter']
    .filter(Boolean).join(' - ');
  mkdirSync(LETTER_DIR, { recursive: true });
  return writeLetterPdf({ head, body: text, outPath: path.join(LETTER_DIR, `${name}.pdf`) });
}

// ── stale-server guard ──────────────────────────────────────────────
// This dashboard gets left running for WEEKS while the code underneath it
// changes. Node loaded these modules once at startup, so an old process keeps
// serving old logic from new files with no visible sign — the Resumes tab read
// "0 resumes" for an hour after the four family resumes existed on disk, purely
// because the process predated the code that could see them.
//
// So the server reports whether any of its own sources changed after it booted,
// and the UI says "restart me" instead of quietly lying.
const STARTED_AT = Date.now();

function codeChangedSinceStart() {
  const changed = [];
  try {
    for (const e of readdirSync(HERE, { withFileTypes: true })) {
      if (!e.isFile() || !/\.(mjs|html|json)$/.test(e.name)) continue;
      // A TEST file changing cannot make the served dashboard stale - this
      // process never loads one. The banner fired on "options.test.mjs" and
      // told him to restart a server that was already current.
      //
      // That matters more than it looks: this ledger's own rule is "check
      // stale: false after every restart before trusting a measurement", and a
      // banner that cries wolf is one he learns to click past.
      if (/\.test\.mjs$/.test(e.name)) continue;
      // dashboard.html is read from disk on every request (HTML_PATH), so a
      // change to it is live the moment the page reloads — the banner fired on
      // a CSS fix and asked for a restart that would change nothing (2026-09-17).
      if (e.name === 'dashboard.html') continue;
      try {
        if (statSync(path.join(HERE, e.name)).mtimeMs > STARTED_AT) changed.push(e.name);
      } catch { /* vanished mid-scan */ }
    }
  } catch { /* unreadable — treat as fresh rather than nag */ }
  return {
    stale: changed.length > 0,
    startedAt: new Date(STARTED_AT).toISOString(),
    files: changed.sort().slice(0, 8),
  };
}

// ── background workers ──────────────────────────────────────────────
// The terminal keeps itself fresh: an enrichment batch (deep-read of listings
// the user would browse) every few minutes, and a full portal scan every 6h.
// Children reuse the CLI scripts, whose saves are merge-safe against clicks.
// Disable with JARVIS_AUTO=0.
const AUTO = process.env.JARVIS_AUTO !== '0';
const ENRICH_EVERY_MS = 3 * 60 * 1000;
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
const ENRICH_BATCH = 150;
// F-08: nothing re-verified an individual posting. The 6-hourly scan refreshes
// what a portal still LISTS; a req pulled between scans stayed in the deck
// looking live. 1,275 deck postings had not been checked in 14 days and the
// oldest was five weeks old — and the first three probed were all dead.
//
// The sweep runs hourly, oldest-verified first, and is deliberately small: it
// reuses enrichment (which already marks 403/404/410 as `gone`, measured 96%
// accurate in F-06) rather than adding a second liveness path that could drift
// from the first.
const LIVENESS_EVERY_MS = 60 * 60 * 1000;
const LIVENESS_BATCH = 60;
const LIVENESS_STALE_DAYS = 14;
/** One newline, named so a patch tool cannot mangle it into a real line break. */
const NL = String.fromCharCode(10);
/** How often the piles HE reads are checked for postings that have been pulled. */
const RETIRE_PICKS_EVERY_MS = 6 * 60 * 60 * 1000;
/** …and the deck behind them. */
const RETIRE_DECK_EVERY_MS = 24 * 60 * 60 * 1000;
let enrichChild = null, scanChild = null, livenessChild = null, retireChild = null, lastAutoScanAt = null;

function kickEnrich() {
  if (!AUTO || enrichChild) return;
  enrichChild = spawn(process.execPath, [path.join(HERE, 'enrich.mjs'), '--auto', '--limit', String(ENRICH_BATCH)], { cwd: ROOT, stdio: 'ignore' });
  enrichChild.on('exit', () => { enrichChild = null; });
  enrichChild.on('error', () => { enrichChild = null; });
}
function kickScan() {
  if (!AUTO || scanChild) return;
  lastAutoScanAt = new Date().toISOString();
  scanChild = spawn(process.execPath, [path.join(HERE, 'scan.mjs')], { cwd: ROOT, stdio: 'ignore' });
  scanChild.on('exit', () => { scanChild = null; });
  scanChild.on('error', () => { scanChild = null; });
}
/**
 * RETIRE THE DEAD ONES, WITHOUT BEING ASKED.
 *
 * `kickLiveness` below re-READS postings; nothing retired them, so dead
 * postings accumulated in the piles he actually reads until the sweep was run
 * by hand. His report, 2026-09-06: "hey man a lot of curated jobs are apge not
 * found" — and the first sweep of his own lists found five at the top of his
 * shortlist. His picks first and often, because a dead posting in the deck
 * costs him one card and a dead posting in his shortlist costs him an
 * application he was about to spend real attention on.
 *
 * API rung only: an unattended sweep must not open Chromium on his machine,
 * and the rule that ONLY a definitive 404/410 retires anything is what makes
 * running this unattended safe at all.
 */
function kickRetire(picks) {
  if (!AUTO || retireChild || enrichChild || scanChild) return;   // never two readers at once
  retireChild = spawn(process.execPath,
    [path.join(HERE, 'liveness-sweep.mjs'), ...(picks ? ['--picks'] : []), '--no-browser',
      '--limit', String(picks ? 400 : 1500), '--concurrency', '4'],
    { cwd: ROOT, stdio: 'ignore' });
  retireChild.on('exit', () => { retireChild = null; });
  retireChild.on('error', () => { retireChild = null; });
}

/**
 * KEEP HIS SHORTLIST FROM RUNNING DRY (jarvis/curate.mjs).
 *
 * "bro i thought we supposed to do a run everyday how did i run out of jobs"
 * (2026-09-24). The scan ran every six hours and nothing read what it found
 * into his inbox; that was a hand step, last taken four days earlier. Every
 * six hours, after the scan has had its turn, the curator checks how many
 * picks he has open and, below fifty, reads new postings in full and files
 * what qualifies. Above fifty it does nothing and costs nothing.
 */
const CURATE_EVERY_MS = 6 * 60 * 60 * 1000;
let curateChild = null;
function kickCurate() {
  if (!AUTO || curateChild || scanChild) return;
  curateChild = spawn(process.execPath, [path.join(HERE, 'curate.mjs'), '--limit', '30', '--target', '50'],
    { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  curateChild.on('exit', () => { curateChild = null; });
  curateChild.on('error', () => { curateChild = null; });
}

function kickLiveness() {
  if (!AUTO || livenessChild || enrichChild) return;   // never two readers at once
  livenessChild = spawn(process.execPath,
    [path.join(HERE, 'enrich.mjs'), '--stale', String(LIVENESS_STALE_DAYS), '--limit', String(LIVENESS_BATCH)],
    { cwd: ROOT, stdio: 'ignore' });
  livenessChild.on('exit', () => { livenessChild = null; });
  livenessChild.on('error', () => { livenessChild = null; });
}
/**
 * HIS APPLICATIONS, as the mail reader sees them (jarvis/mail.mjs): every card
 * on the Applications board, plus every posting the extension filled a form
 * for — he does not always mark those applied, and an "application received"
 * email is exactly how one gets marked.
 */
const MAIL_STATUSES = ['inbox', 'interested', 'queued', 'applied', 'responded', 'interview', 'offer', 'rejected'];
const mailStore = {
  jobs() {
    const byId = new Map();
    for (const f of [{ status: MAIL_STATUSES }, { prepared: true }]) {
      for (const j of query(f, { limit: 2000 }).rows || []) byId.set(j.id, { id: j.id, company: j.company, title: j.title, status: j.status, url: j.url, location: j.location || '' });
    }
    return [...byId.values()];
  },
  getStatus: (id) => getJob(String(id))?.status || '',
  setStatus: (id, status) => setStatuses([String(id)], status),
  // Every posting at a company, whatever its status: a receipt for a role he
  // never put on the board still proves he applied (mail.mjs matchOffBoard).
  jobsAtCompany(company) {
    const core = companyNames(company)[0];
    if (!core) return [];
    try {
      return storeDb().prepare('SELECT id, company, title, status, url, location FROM jobs WHERE lower(company) LIKE ?').all(`%${core}%`);
    } catch { return []; }
  },
};
let mailSyncing = null;
function kickMailSync() {
  if (mailSyncing || !mailStatus().connected) return mailSyncing;
  mailSyncing = syncMail(mailStore).then((r) => {
    if (r.ok && (r.moved.length || r.unsure.length)) console.log(`  mail → read ${r.read}, moved ${r.moved.length} card(s)${r.unsure.length ? `, ${r.unsure.length} unsure` : ''}`);
    if (!r.ok) console.error(`  mail → ${r.error}`);
    return r;
  }).finally(() => { mailSyncing = null; });
  return mailSyncing;
}
const MAIL_EVERY_MS = 30 * 60 * 1000;

if (AUTO) {
  setTimeout(kickMailSync, 45 * 1000);
  setInterval(kickMailSync, MAIL_EVERY_MS);
  setTimeout(kickEnrich, 5000);
  setInterval(kickEnrich, ENRICH_EVERY_MS);
  setInterval(kickScan, SCAN_EVERY_MS);
  // Twenty minutes in, so a restart mid-afternoon still tops the list up today.
  setTimeout(kickCurate, 20 * 60 * 1000);
  setInterval(kickCurate, CURATE_EVERY_MS);
  setTimeout(kickLiveness, 90 * 1000);          // once shortly after boot
  setInterval(kickLiveness, LIVENESS_EVERY_MS);
  // His own lists first, and often; the deck behind them, and rarely.
  setTimeout(() => kickRetire(true), 3 * 60 * 1000);
  setInterval(() => kickRetire(true), RETIRE_PICKS_EVERY_MS);
  setTimeout(() => kickRetire(false), 20 * 60 * 1000);
  setInterval(() => kickRetire(false), RETIRE_DECK_EVERY_MS);

  // FOLD THE JOURNAL BACK IN WHILE NOTHING ELSE IS READING.
  //
  // The WAL reached 199 MB beside a 774 MB store (2026-09-20) because a passive
  // autocheckpoint cannot reset it while another connection holds a read mark,
  // and with this server, a scan child and an apply run on the same file there
  // is nearly always one. Skipped outright when a reader of ours is live —
  // a checkpoint behind a running scan would only come back busy anyway.
  //
  // Hourly, and on no other schedule: this is housekeeping, it never blocks,
  // and a failed attempt costs nothing because the next one is an hour away.
  const checkpoint = () => {
    if (retireChild || enrichChild || scanChild) return;
    const r = checkpointWal();
    if (r && !r.busy && r.pages > 0) trace(`wal checkpoint — ${r.moved}/${r.pages} pages folded back`);
  };
  setTimeout(checkpoint, 10 * 60 * 1000);
  setInterval(checkpoint, 60 * 60 * 1000);

}

// WARM THE HOME TILES OFF THE REQUEST PATH.
//
// OUTSIDE `if (AUTO)`, deliberately. It sat inside it, and a dashboard started
// with JARVIS_AUTO=0 warmed nothing — which is how I measured 37.9s cold and
// briefly believed the warmer had failed. Auto-scanning decides whether the
// server goes looking for new jobs; it has nothing to say about whether the
// page he opens is ready when he opens it.
//
// `/api/overview` measured 29.6s cold and 0.002s warm (2026-09-22). The
// 60-second floor added earlier stops a scan's commits from forcing a
// recompute on every request, but it cannot make the FIRST one cheap — and
// the first one is the one he waits for, because he opens the tab after the
// server has been sitting idle while scans invalidated it.
//
// So it is computed here instead of there. The work is identical and the
// server is single-threaded either way; what changes is WHO waits. A timer
// waits. He does not.
//
// Deliberately late and deliberately idle-only: 20s after boot so startup is
// not blocked, then every 10 minutes, and skipped entirely while a scan,
// enrich or retire child is running — those are the moments the store is
// busiest and the aggregate would be stale by the time it finished anyway.
const warmOverview = () => {
  if (retireChild || enrichChild || scanChild) return;
  const began = Date.now();
  try {
    buildOverview();
    const ms = Date.now() - began;
    if (ms > 2000) trace(`home tiles recomputed in ${(ms / 1000).toFixed(1)}s — off the request path`);
  } catch (e) { trace(`could not warm the home tiles: ${e.message}`); }
};
setTimeout(warmOverview, 20 * 1000);
setInterval(warmOverview, 10 * 60 * 1000);

// Which sources a body can be read from now comes from detail-sources.mjs
// (imported above), not from a literal here.
//
// THIS LIST DRIFTED TWICE (F-445). It was last written as
// `['workday','greenhouse','sitemap-jobs','oracle-orc','icims']` under a
// comment explaining that it had ALREADY drifted once and been corrected by
// hand — and by 2026-09-10 it was wrong again, missing smartrecruiters,
// rippling, bamboohr and breezy from DETAIL and every body-in-list source
// there is. amazon-jobs alone is 21,327 live rows at 100% read, counted as
// unreadable by the tile that reports how much of the store has been read.
//
// A comment saying "keep this in step by hand" is a bug report about the
// design, not a safeguard. The shared module is asserted against DETAIL when
// enrich.mjs loads, so this cannot go stale in silence again.

// ── assisted-import token ───────────────────────────────────────────
// /api/import accepts cross-origin POSTs (an https careers page pushing its
// own listings, harvested in the user's browser, into the local store —
// localhost is exempt from mixed-content blocking). The token file gates it:
// the driving agent reads the token locally and embeds it in the in-page
// script; arbitrary websites can't read local files, so they can't inject.
const IMPORT_TOKEN_PATH = path.join(STORE_DIR, 'import-token');
/**
 * What /api/apply decided for a job, so /api/plan and /api/apply-resume can
 * answer consistently while he is on the page.
 *
 * In memory on purpose. It holds a path to a PDF and which family produced it —
 * nothing worth persisting, and everything worth forgetting when the server
 * stops. Restarting mid-application costs one click on Apply.
 */
const APPLY_CONTEXT = new Map();

/** The job he is applying to right now, used only when nothing better matches. */
let LAST_APPLY = null;

/**
 * Bounds on a description the extension read off a page (/api/apply-page).
 * Shorter than MIN is a heading or a teaser, not a posting — nothing to tailor
 * towards, and not worth storing as if it were the body. Longer than MAX is a
 * whole careers site scraped by accident; the tailor reads 6,000 characters.
 */
const MIN_PAGE_JD_CHARS = 200;
const MAX_PAGE_JD_CHARS = 40000;

/**
 * The extension's ATS table, loaded here too, for one function: the posting id
 * a URL carries. Two URLs with the same requisition are the same job whatever
 * else differs — measured live on Eaton: the store held
 * `/careers/job/687238472915-…?domain=eaton.com`, the apply page reported
 * `/careers/apply?pid=687238472915`, neither string matched the other, and a
 * second row plus a second resume build followed.
 */
const ATS = (() => {
  try {
    const ctx = { URL, globalThis: {} };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(path.join(HERE, 'extension', 'ats.js'), 'utf-8'), ctx);
    return ctx.__jarvisAts || null;
  } catch { return null; }
})();

/**
 * A requisition token as a person would quote it: "workday:Mechanical-Design-
 * Engineer_2636966" → "2636966", an Ashby UUID → its first block. For display
 * only; matching always uses the whole token.
 */
export function shortRequisition(token) {
  if (!token) return '';
  let t = String(token).replace(/^[a-z0-9]+:/i, '');
  const us = t.lastIndexOf('_');
  if (us > 0 && /^[A-Za-z]?\d+(-\d+)?$/.test(t.slice(us + 1))) t = t.slice(us + 1);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t)) t = t.slice(0, 8);
  return t.slice(0, 24);
}

/**
 * The same match, confined to one company's rows. The full scan above walks
 * every posting in the store (190k rows, 1.4 s measured) and is affordable
 * once per apply; the Resumes tab asks sixty times per load, so it looks
 * only where the answer can be — the store has an index on company.
 */
function jobByRequisitionAt(url, company) {
  const want = ATS?.reqToken?.(url);
  const co = String(company || '').trim();
  if (!want || !co) return null;
  // Exact company first, newest first; the prefix form ("Eaton" for "Eaton
  // Corporation") only if that finds nothing. Eaton alone has 2,000 rows.
  const head = co.split(/\s+/)[0];
  for (const [sql, arg] of [
    ['SELECT id, url FROM jobs WHERE company = ? ORDER BY lastSeen DESC LIMIT 400', co],
    ['SELECT id, url FROM jobs WHERE company LIKE ? ORDER BY lastSeen DESC LIMIT 400', `${head}%`],
  ]) {
    for (const row of db().prepare(sql).all(arg)) if (ATS.reqToken(row.url) === want) return getJob(row.id);
  }
  return null;
}

/**
 * Which store row each archived resume belongs to, remembered by filename.
 * The URL-to-row answer never changes once found; a miss is retried only
 * after the store has changed. Without this the Resumes tab paid the lookup
 * for all sixty files on every load (3.4 s measured).
 */
const ARCHIVE_ROW = new Map();
function archiveRowFor(name, postingUrl, company) {
  const ver = storeVersion();
  const hit = ARCHIVE_ROW.get(name);
  if (hit && (hit.id || hit.ver === ver)) return hit.id ? getJob(hit.id) : null;
  let job = null;
  try { job = postingUrl ? (getJobByUrl(postingUrl) || jobByRequisitionAt(postingUrl, company)) : null; } catch { job = null; }
  ARCHIVE_ROW.set(name, { id: job?.id || null, ver });
  return job;
}

/** A stored job whose URL names the same requisition as `url`, if any. */
function jobByRequisition(url) {
  const want = ATS?.reqToken?.(url);
  if (!want) return null;
  // LET SQLITE THROW AWAY THE 196,490 ROWS THAT CANNOT MATCH (F-402). Every
  // extractor in ats.js lifts the id out of the URL as a literal substring, so
  // a stored posting with this requisition must contain it — 235 ms of LIKE
  // against 1.2 s of parsing every URL in the store. A miss here is a real
  // miss: checked against his whole store, all 180,068 URLs that carry a
  // requisition contain their own token literally, and SQLite's
  // LIKE is case-insensitive over ASCII, so the uuids the extractors lowercase
  // still match. `discover.test.mjs` holds that property to the extractors so
  // a new ATS cannot quietly break it. A token too short to filter on, or one
  // carrying LIKE's own wildcards, still takes the full walk.
  const raw = String(want).replace(/^[a-z0-9-]+:/i, '');
  if (raw.length >= 4 && !/[%_\\]/.test(raw)) {
    for (const row of db().prepare('SELECT id, url FROM jobs WHERE url LIKE ?').iterate(`%${raw}%`)) {
      if (ATS.reqToken(row.url) === want) return getJob(row.id);
    }
    return null;
  }
  for (const row of db().prepare('SELECT id, url FROM jobs').iterate()) {
    if (ATS.reqToken(row.url) === want) return getJob(row.id);
  }
  return null;
}

/**
 * What a posting read off a PAGE must look like before it is recorded as a
 * job in his store.
 *
 * The title decides the resume family and is typed onto the form as his
 * work-history title, so a wrong one is not cosmetic. JSON-LD JobPosting
 * markup is the page's own structured statement and is trusted. A title read
 * from an <h1> is trusted only with a body behind it — a heading with no
 * description is a careers page, not a posting — and never when it is a
 * heading this project knows is not a job. The company field is what the
 * audit copy is filed under; an ATS's or an identity provider's name there
 * is worse than nothing.
 */
const NOT_A_TITLE_RE = /^(?:my information|my experience|application questions|voluntary disclosures|self[- ]identify|review|sign in|log in|create account|candidate (?:profile|home)|apply(?: now)?|careers?|jobs?|search(?: jobs)?|job search|open (?:roles|positions|jobs)|current openings|welcome|home|thank you.*|error|page not found)$/i;
const NOT_A_COMPANY_RE = /^(?:workday|greenhouse|lever|ashby|eightfold|icims|smartrecruiters|successfactors|taleo|oracle|jobvite|workable|ukg|ultipro|adp|google|microsoft|linkedin|apple|okta|facebook|indeed|glassdoor)\b/i;

function pageReadPostingIsRecordable(posting, title, description) {
  if (!title || NOT_A_TITLE_RE.test(title)) return false;
  if (String(posting.source || '') === 'jsonld') return true;
  return description.length >= MIN_PAGE_JD_CHARS;
}

/**
 * Whether the browser extension has ever spoken to this server, and what it said.
 *
 * There was no way to answer "did the extension reach the server?" — so a click
 * that did nothing was indistinguishable from an extension that was never
 * installed, never reloaded, or blocked. Given that every fix in this project is
 * invisible until Chrome reloads an unpacked extension, that is the single most
 * useful fact the dashboard can show.
 */
const EXTENSION = { seenAt: null, version: null, calls: 0, lastPage: null };

/**
 * May this caller read the apply token?
 *
 * THE ORIGINAL VERSION OF THIS REJECTED THE REAL EXTENSION, and that single line
 * is why nothing ever worked in his browser: every click reported "the Jarvis
 * dashboard is not running" while the dashboard was running fine.
 *
 * It required `Origin: chrome-extension://…`. Measured against a genuinely
 * loaded extension, Chrome sends:
 *
 *     origin           (ABSENT)
 *     sec-fetch-site   none
 *     sec-fetch-mode   cors
 *     sec-fetch-dest   empty
 *
 * Chrome OMITS Origin when an extension fetches a host it holds permission for —
 * the request is privileged, not cross-origin. So the check was exactly backwards:
 * it let through anything that COULD forge an Origin header and turned away the
 * one caller that had earned access. (On a host it does NOT have permission for,
 * the same extension does send the header — which is how the first probe, run
 * against port 4399, looked like it passed.)
 *
 * The boundary that actually matters is a WEB PAGE, and a page's `fetch` always
 * sends Origin. So:
 *
 *   - an Origin present and not chrome-extension:// is a page  -> refused
 *   - no Origin, and not a document/subresource load           -> allowed
 *
 * `sec-fetch-dest` carries the second half: a page's `<script src>` reads
 * `script`, an `<img>` reads `image`, a navigation reads `document`. Only a
 * programmatic fetch reads `empty`. A client sending no sec-fetch headers at all
 * is not a browser — it is local tooling, which can read the token file directly
 * anyway, and this server binds to localhost.
 */
/**
 * WHICH extension, not merely "an extension".
 *
 * `chrome-extension://` on its own is a weak claim: EVERY extension the user has
 * installed gets one, and any of them holding broad host permissions can reach
 * localhost. His browser currently runs a second autofill extension whose
 * manifest asks for every host there is (F-244), so "extensions only" was, in
 * practice, "any extension on this machine" — with his resume, address and EEO
 * answers behind it.
 *
 * The id is read from Chrome's own registry for the unpacked extension living
 * in this repo (the same lookup as F-245), and cached, because that file is
 * large and this runs per request.
 *
 * FAILS OPEN on purpose. If Chrome cannot be read — another browser, a fresh
 * profile, a locked file — the old check applies. A gate that locks him out of
 * his own tool because it could not find a preferences file is a worse failure
 * than the one it prevents.
 */
let PINNED_EXT = { at: 0, id: null };
function pinnedExtensionOrigin() {
  const now = Date.now();
  if (now - PINNED_EXT.at < 60000) return PINNED_EXT.id;
  let id = null;
  try { id = loadedExtension(path.join(HERE, 'extension'))?.id || null; } catch { id = null; }
  PINNED_EXT = { at: now, id };
  return id;
}

function callerMayHaveToken(req) {
  const origin = String(req.headers.origin || '');
  if (origin) {
    if (!origin.startsWith('chrome-extension://')) return false;
    const id = pinnedExtensionOrigin();
    // Unknown id -> the old, looser rule. Known id -> this extension only.
    return !id || origin === `chrome-extension://${id}`;
  }
  const dest = String(req.headers['sec-fetch-dest'] || '');
  return dest === '' || dest === 'empty';
}

function noteExtension(version, pageUrl) {
  EXTENSION.seenAt = new Date().toISOString();
  EXTENSION.calls += 1;
  if (version) EXTENSION.version = version;
  if (pageUrl) { try { EXTENSION.lastPage = new URL(pageUrl).hostname; } catch { /* keep the old one */ } }
}

/** The registrable part of a hostname — "appliedmaterials.com" from either
 *  jobs.appliedmaterials.com or careers.appliedmaterials.com. Crude on purpose:
 *  it only has to tell two employers apart, not parse the public suffix list. */
function siteOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase().split('.').slice(-2).join('.'); }
  catch { return ''; }
}

/**
 * Hosts that serve every employer at once — an applicant-tracking system's own
 * domain rather than a company's. On one of these, two postings sharing a
 * registrable domain share nothing at all.
 */
const SHARED_ATS_HOST = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|icims\.com|workable\.com|jobvite\.com|breezy\.hr|recruitee\.com|bamboohr\.com|dayforcehcm\.com|taleo\.net|successfactors\.com|eightfold\.ai|applytojob\.com|teamtailor\.com|jazzhr\.com|ultipro\.com|oraclecloud\.com|avature\.net|paycomonline\.net|paylocity\.com|rippling\.com|pinpointhq\.com|clearcompany\.com|phenompeople\.com)$/i;

/**
 * WHICH EMPLOYER a shared-host URL is for: its board, as one comparable key
 * ("boards.greenhouse.io/acme"). Empty when the URL does not say — a
 * Greenhouse *embed* form (`/embed/job_app?token=…`) names a posting id and no
 * board at all, and the honest answer there is "I do not know".
 */
/**
 * The first label of a host that every employer on the platform shares, so the
 * host says nothing about who this page is for: boards.greenhouse.io,
 * jobs.lever.co, apply.workable.com. Against `careers-amd.icims.com` or
 * `hp.wd5.myworkdayjobs.com`, where the tenant IS the host.
 */
const GENERIC_HOST_LABEL = /^(?:jobs?|boards?|job-boards|apply|application|careers?|www|my|recruiting|hire|talent|apply2)$/;

function boardKey(u) {
  const prefix = boardPrefix(u);
  if (!prefix) return '';
  try {
    const url = new URL(prefix);
    // F-351's twin hosts are the same board under two names.
    const h = url.hostname.toLowerCase().replace(/^job-boards\.greenhouse\.io$/, 'boards.greenhouse.io');
    const slug = (url.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    const named = !!slug && !/^(?:embed|oneclick-ui|apply|application|applications|jobs|job|careers|search)$/.test(slug);
    if (named) return `${h}/${slug}`;
    // THE HOST CAN BE THE TENANT. `careers-amd.icims.com` and
    // `hp.wd5.myworkdayjobs.com` name one employer and put nothing useful in
    // the path — iCIMS hangs every posting off /jobs/<id>. Reading only the
    // path there would turn every iCIMS application into a guess, so a host
    // whose first label is not one every board shares is identity enough.
    const labels = h.split('.');
    return labels.length > 2 && !GENERIC_HOST_LABEL.test(labels[0]) ? h : '';
  } catch { return ''; }
}

/**
 * Which application does THIS tab belong to?
 *
 * The first version answered "the most recent one", which is wrong the moment
 * two are open. He pressed Apply on an Applied Materials posting and then on a
 * GlobalFoundries one; both tabs were open, both resumes were built, and the
 * extension would have attached the GlobalFoundries resume to the Applied
 * Materials form — a confident wrong answer in his name, which is the failure
 * mode this project exists to avoid.
 *
 * So match on the page. An ATS redirect changes the hostname
 * (jobs.appliedmaterials.com → careers.appliedmaterials.com) but almost never
 * the registrable domain, and the applicant-tracking host usually carries the
 * employer's name too. Falls back to the most recent, and SAYS it fell back so
 * the answer can be shown rather than assumed.
 */
function contextForPage(pageUrl) {
  const site = siteOf(pageUrl);
  const host = (() => { try { return new URL(String(pageUrl)).hostname.toLowerCase(); } catch { return ''; } })();
  // greenhouse.io IS NOT AN EMPLOYER (F-401). On a shared applicant-tracking
  // host the registrable domain says nothing about WHO the page is for: every
  // Greenhouse board is greenhouse.io, every Lever board is lever.co. The
  // domain rule below is for an employer's OWN site, where
  // jobs.appliedmaterials.com and careers.appliedmaterials.com really are the
  // same company. On a shared host the tenant is the identity, and an unknown
  // tenant is a guess, never a match.
  const shared = SHARED_ATS_HOST.test(host);
  const board = shared ? boardKey(pageUrl) : '';
  let best = null;
  for (const [id, ctx] of APPLY_CONTEXT) {
    let score = 0;
    if (pageUrl && ctx.jobUrl === pageUrl) score = 100;
    else if (shared) score = board && boardKey(ctx.jobUrl) === board ? 80 : 0;
    else if (site && siteOf(ctx.jobUrl) === site) score = 60;
    else if (host && ctx.company) {
      // careers.<company>.com, <company>.wd1.myworkdayjobs.com, and the like.
      const slug = String(ctx.company).toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (slug.length > 3 && host.replace(/[^a-z0-9]+/g, '').includes(slug)) score = 40;
    }
    if (score && (!best || score > best.score || (score === best.score && ctx.at > best.ctx.at))) {
      best = { id, ctx, score };
    }
  }
  if (best) return { id: best.id, ctx: best.ctx, matched: 'page' };
  const ctx = LAST_APPLY ? APPLY_CONTEXT.get(LAST_APPLY) : null;
  return ctx ? { id: LAST_APPLY, ctx, matched: 'fallback' } : { id: null, ctx: null, matched: 'none' };
}

/**
 * Start building the tailored resume for one job, and remember it.
 *
 * ONE COPY, because there are now two ways in and they must not drift. Pressing
 * Apply on the dashboard is one. Clicking the extension on a form he found
 * himself is the other — and that one used to attach no resume at all (F-230).
 * F-223 was this same shape: the extension re-made four bugs the driver had
 * already fixed, because each had its own copy of the logic.
 *
 * Never awaited by callers. Tailoring took 141s on a live Applied Materials
 * posting, so the caller answers immediately and the status is polled.
 */
function startResumeBuild(job, key, { chrome = null, makeCurrent = true, request = '', reuse = true } = {}) {
  const ctx = {
    status: 'tailoring',
    at: new Date().toISOString(),
    // The store knows the employer even when the page did not say it — a
    // context built from a page match can arrive with no company at all, and
    // its name then goes missing from everything the panel says (2026-09-07).
    company: job.company || (job.id ? getJob(String(job.id))?.company : '') || '',
    title: job.title,
    jobUrl: job.url,
    familyKey: null,
    pdfPath: null,
    chrome,
    tailoring: null,
    error: null,
    // His note for this build, from the side panel — shown back with the result.
    request: String(request || '').trim().slice(0, 600),
    // The stage the build is at, and when it got there: the panel shows this
    // instead of an unchanging "still writing the resume", which he read as
    // dead (2026-09-06).
    phase: 'starting',
    phaseAt: Date.now(),
  };
  // WHO GETS TO BE "THE CURRENT APPLICATION". Pressing Apply on the dashboard
  // says so plainly. A build that started because he happened to click the
  // toolbar on a page does NOT: LAST_APPLY is the fallback every unmatched
  // request lands on, so letting a page click move it would quietly retarget an
  // application he started deliberately somewhere else — the near-miss this
  // whole module exists to prevent.
  if (makeCurrent) LAST_APPLY = key;
  APPLY_CONTEXT.set(key, ctx);

  // Whether this build had a description to write towards. A posting the
  // scanner never enriched ships in his own words; if the extension later
  // reads the description off the page itself, /api/apply-page uses this to
  // know the build is worth doing again.
  const jd = getDescription(key);
  ctx.hadJd = !!(jd && String(jd).trim());
  const reuseKey = jdKey(ctx.company || job.company, jd);
  const sources = sourcesVersion();

  // ALREADY BUILT: hand it back instead of building it again. Its own build,
  // or one for a posting with the same description at the same company, made
  // from the CV as it is now. A note from the panel ("change the resume") and
  // "build it again" always build.
  if (reuse && !ctx.request) {
    const found = findReusableBuild(BUILD_DIR, { id: key, jdKey: reuseKey, sources });
    if (found) {
      try {
        const r = found.record;
        const pdfPath = found.sameJob ? r.pdfPath : path.join(path.dirname(r.pdfPath), personFile(r.person || 'Alex Rivera', job));
        restoreBuild(found, pdfPath);
        Object.assign(ctx, {
          status: 'ready', familyKey: r.familyKey, family: r.family, titles: r.titles || [],
          pdfPath, auditPath: r.auditPath || null, resumeLines: r.resumeLines || [],
          tailoring: { ...(r.tailoring || {}), notices: [...(r.tailoring?.notices || []),
            found.sameJob
              ? `reused the resume already built for this posting on ${String(r.savedAt).slice(0, 10)} — press "build it again" for a new one`
              : `reused the resume built for ${r.title || 'another posting'} (${String(r.savedAt).slice(0, 10)}): same company, same job description`] },
          qa: r.qa || null,
          reused: { from: r.id, sameJob: found.sameJob, at: r.savedAt, title: r.title || '' },
          phase: 'reused',
          phaseAt: Date.now(),
        });
        console.log(`\n  apply → ${job.company} — ${job.title}\n  resume: reused ${found.sameJob ? 'its own earlier build' : `the build for job ${r.id} (same description)`} from ${r.savedAt}\n`);
        return ctx;
      } catch (e) {
        console.error(`  reuse failed, building instead: ${e.message}`);
      }
    }
  }

  resumeForJob(job, {
    jd,
    request: ctx.request,
    onPhase: (text) => { ctx.phase = text; ctx.phaseAt = Date.now(); },
  }).then((built) => {
    ctx.status = 'ready';
    ctx.familyKey = built.family.key;
    ctx.family = { key: built.family.key, label: built.family.label };
    // The titles THIS resume presents (the plan may differ from the family), so
    // /api/plan can make the form say what the PDF says.
    ctx.titles = [...titlesFromSpec(built.spec)];
    ctx.pdfPath = built.pdfPath;
    ctx.auditPath = built.auditPath;
    // The lines this resume leads with, for a cover letter to write around.
    ctx.resumeLines = (built.spec?.experience || []).flatMap((e) => (e.bullets || []).map((b) => b.text)).filter(Boolean).slice(0, 12);
    ctx.tailoring = {
      why: built.why,
      applied: built.applied,
      refused: built.refused,
      unmatched: built.unmatched,
      notices: built.notices,
      planNotes: built.planNotes || [],
      fitNotes: built.fitNotes || [],
    };
    // The layout checklist the sheet passed or failed, for the panel.
    ctx.qa = built.qa?.checklist ? {
      ok: built.qa.checklist.ok,
      failed: built.qa.checklist.items.filter((i) => !i.ok).map((i) => `${i.item}${i.note ? ` — ${i.note}` : ''}`),
      problems: (built.qa.judge?.problems || []).map((p) => p.detail),
      warnings: (built.qa.judge?.warnings || []).map((w) => w.detail),
      png: built.qa.raster?.png || null,
    } : null;
    // KEEP IT, so the next fill, restart or repost does not build it again.
    try {
      saveBuild(BUILD_DIR, key, {
        jdKey: reuseKey, sources, request: ctx.request, company: ctx.company, title: job.title,
        person: built.spec?.name || 'Alex Rivera',
        familyKey: ctx.familyKey, family: ctx.family, titles: ctx.titles,
        pdfPath: ctx.pdfPath, auditPath: ctx.auditPath, resumeLines: ctx.resumeLines,
        tailoring: ctx.tailoring, qa: ctx.qa,
      });
    } catch (e) { console.error(`  could not keep the build for reuse: ${e.message}`); }
    // A FAILED LAYOUT CHECK IS NOT A FOOTNOTE.
    //
    // Measured 2026-09-22: 5 of the 29 tailored builds in the archive carry a
    // recorded QA failure — two tiny final fragments, two orphan words, one
    // unclean Skills section — and every one of them was delivered with the
    // failure sitting in a sidecar nobody opens. A BASE build refuses to ship
    // on the same checklist (`build-resumes` exits non-zero); a tailored one
    // recorded it and carried on.
    //
    // It is not made a hard failure: the polish loop has already tried and
    // given up, and refusing to produce a resume over a short last line would
    // stop him applying for a cosmetic reason. But it goes where he is actually
    // looking, next to the tab that is about to open, instead of into a file.
    if (ctx.qa && ctx.qa.ok === false && ctx.qa.failed?.length) {
      console.log(`\n  ⚠ LAYOUT: this sheet failed ${ctx.qa.failed.length} check`
        + `${ctx.qa.failed.length === 1 ? '' : 's'} — ${ctx.qa.failed.join('; ')}`
        + `\n    the PNG beside the PDF shows it: ${ctx.qa.png || '(not rasterised)'}`);
    }
    console.log(`\n  apply → ${job.company} — ${job.title}\n${tailorReport(built)}${chrome ? `\n  tab: ${chrome.why}` : ''}\n`);
  }).catch((e) => {
    // A drifted pool is the one failure worth stopping on: it means the resume
    // no longer matches cv.md, and no application should go out on top of that.
    // It fails THIS application and nothing else.
    ctx.status = 'failed';
    ctx.error = String(e.message || e).split('\n')[0];
    ctx.problems = e.problems || null;
    console.error(`\n  apply → ${job.company} — ${job.title}\n  FAILED: ${ctx.error}`);
  });

  return ctx;
}

/**
 * The stored posting a form page belongs to.
 *
 * The page he is standing on is often not the URL the scanner recorded: every
 * ATS hangs the form off the posting, so the tab says `…/job/123/apply` while
 * the store says `…/job/123`. Matching only the exact string is what made the
 * extension unable to find the job it was plainly looking at.
 */
/**
 * The URL prefix every posting of this page's BOARD shares, or null.
 *
 * `https://jobs.smartrecruiters.com/BectonDickinson2/` for a SmartRecruiters
 * form at /oneclick-ui/company/BectonDickinson2/publication/<uuid>;
 * `https://<tenant>.myworkdayjobs.com/<Site>/` for Workday (its locale
 * segment, /en-US/, is not part of the board); the first path segment
 * elsewhere (boards.greenhouse.io/<slug>/, jobs.lever.co/<slug>/).
 */
function boardPrefix(pageUrl) {
  let u;
  try { u = new URL(String(pageUrl)); } catch { return null; }
  const host = u.hostname.toLowerCase();
  // A GREENHOUSE EMBED NAMES ITS BOARD IN THE QUERY, NOT THE PATH. His Agility
  // Robotics form is /embed/job_app?for=agilityrobotics&token=… — every board's
  // embed has the same path segment, and `for` is the only thing on the URL
  // that says whose form this is. Read live off that page 2026-09-08.
  if (/greenhouse\.io$/i.test(host) && /^\/embed\//.test(u.pathname)) {
    const forBoard = (u.searchParams.get('for') || '').trim();
    return forBoard ? `https://boards.greenhouse.io/${forBoard}/` : null;
  }
  const sr = /smartrecruiters\.com$/i.test(host) ? u.pathname.match(/\/oneclick-ui\/company\/([^/]+)/) : null;
  const segs = u.pathname.split('/').filter((s) => s && !/^[a-z]{2}-[A-Z]{2}$/.test(s));
  const slug = sr ? sr[1] : (segs[0] || '');
  return slug ? `https://${host}/${slug}/` : null;
}

/**
 * The stored job whose URL is any one of these, in ONE pass.
 *
 * SEVEN SHAPES OF THE SAME URL COST SEVEN FULL SCANS (F-402). `findByUrl`
 * walks all 196,491 rows when the exact string is not stored, and the caller
 * below hands it seven candidate spellings of the page — so a form whose URL
 * the scanner never saw paid seven walks, ~0.8 s each. Measured on his own
 * store: /api/panel took 8.0 s on an unmatched Greenhouse page and 0.02 s on
 * a stored one. That is the whole of the "it takes thirty seconds and says it
 * is not a posting first" he reported.
 *
 * The cheap hash lookup is tried for every shape first; only then does one
 * single walk compare all of them at once.
 */
function findByAnyUrl(urls) {
  const norm = (u) => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  for (const u of urls) {
    const hit = u ? getJob(jobId(u)) : null;
    if (hit) return hit;
  }
  const want = new Set(urls.filter(Boolean).map(norm).filter(Boolean));
  if (!want.size) return null;
  // AND ONE WALK IS STILL 196,491 URLs NORMALISED IN JAVASCRIPT (~0.6 s). A
  // row can only normalise to one of these if its URL BEGINS with it — the
  // normalisation drops a query string, a fragment and a trailing slash, and
  // nothing else — so SQLite can throw the rest away first. LIKE is
  // case-insensitive over ASCII, which is the other half of the
  // normalisation; the JS check below is still what decides.
  const esc = (u) => u.replace(/[\\%_]/g, (c) => `\\${c}`);
  const likes = [...want].map(esc);
  const sql = `SELECT id, url FROM jobs WHERE ${likes.map(() => "url LIKE ? ESCAPE '\\'").join(' OR ')}`;
  for (const row of db().prepare(sql).iterate(...likes.map((l) => `${l}%`))) {
    if (want.has(norm(row.url))) return getJob(row.id);
  }
  return null;
}

/** The answer for one page, kept until the store changes (F-402). */
const PAGE_JOB = new Map();

function jobForPage(pageUrl, hint = {}) {
  if (!pageUrl) return null;
  const key = `${storeVersion()}|${pageUrl}|${hint.heading || ''}|${hint.pageTitle || ''}`;
  // THE PANEL ASKS THE SAME QUESTION FIVE TIMES while a page settles, and a
  // miss is the expensive answer. Held only until the store changes, so a
  // posting recorded a moment ago is never hidden behind a stale "no".
  if (PAGE_JOB.has(key)) {
    const id = PAGE_JOB.get(key);
    const hit = id ? getJob(id) : null;
    if (id === null || hit) return hit;
  }
  const found = jobForPageUncached(pageUrl, hint);
  if (PAGE_JOB.size > 400) PAGE_JOB.clear();
  PAGE_JOB.set(key, found ? String(found.id) : null);
  return found;
}

function jobForPageUncached(pageUrl, hint = {}) {
  const bare = String(pageUrl).replace(/[?#].*$/, '');
  // Greenhouse serves the same board from boards.greenhouse.io and
  // job-boards.greenhouse.io and redirects between them; the store holds
  // whichever the scanner saw (Path Robotics, F-351). Both hosts are tried.
  const twin = (u) => (/\/\/job-boards\.greenhouse\.io\//i.test(u) ? u.replace(/\/\/job-boards\.greenhouse\.io\//i, '//boards.greenhouse.io/')
    : /\/\/boards\.greenhouse\.io\//i.test(u) ? u.replace(/\/\/boards\.greenhouse\.io\//i, '//job-boards.greenhouse.io/') : null);
  const tries = [
    pageUrl,
    bare,
    bare.replace(/\/apply(\/.*)?$/i, ''),
    bare.replace(/\/application(\/.*)?$/i, ''),
    bare.replace(/\/(apply|application)\/?$/i, ''),
  ];
  for (const t of [...tries]) { const w = twin(t); if (w) tries.push(w); }
  const byUrl = findByAnyUrl([...new Set(tries.filter(Boolean))]);
  if (byUrl) return byUrl;
  // TESLA'S FORM IS /careers/search/job/apply/<number>, AND ITS POSTING IS
  // /careers/search/job/<title-slug>-<number> (2026-09-24: "extension does not
  // detect tesla posting on the application page, but it does on jd page").
  // Same number, so the same posting.
  const tesla = String(pageUrl).match(/tesla\.com\/(?:[a-z]{2}_[a-z]{2}\/)?careers\/search\/job\/apply\/(\d+)/i);
  if (tesla) {
    try {
      const row = db().prepare("SELECT id FROM jobs WHERE url LIKE ? AND url NOT LIKE '%/apply/%' ORDER BY last_seen DESC LIMIT 1")
        .get(`%tesla.com/%careers/search/job/%-${tesla[1]}`);
      const hit = row ? getJob(row.id) : null;
      if (hit) return hit;
    } catch { /* fall through */ }
  }
  // THE PAGE NAMES THE JOB BY BOARD AND HEADING when its URL does not (F-330):
  // SmartRecruiters' form carries a publication uuid the store never saw,
  // and above it the job's title. Same board, same title: that posting.
  const board = boardPrefix(pageUrl);
  const headings = [hint.heading, hint.pageTitle].filter(Boolean);
  if (board && headings.length) {
    try {
      const hit = findByHeading(board, headings) || (twin(board) ? findByHeading(twin(board), headings) : null);
      if (hit) return hit;
    } catch { /* fall through to the requisition id */ }
  }
  // The posting's own id in the URL (?gh_jid=…, /jobs/<id>), whatever host
  // carries it — a full scan, once per page.
  try { return jobByRequisition(pageUrl); } catch { return null; }
}


/**
 * HAS HE ALREADY APPLIED TO THIS? (F-414)
 *
 * His words: "it would be nice to also add a you have already applied to this
 * job, i mean simplify has it, rn i have to guess". Guessing is the problem —
 * a second application to the same requisition spends somebody's attention
 * twice, which is the thing this project says it is trying not to do.
 *
 * Two answers, and they are not the same answer:
 *
 *   'this' — this exact posting is marked applied. Certain.
 *   'role' — a DIFFERENT row for the same employer and the same title is.
 *            That is the duplicate-requisition case (F-406): one job listed
 *            twice, or reposted. Worth saying, and worth saying which it is.
 *
 * A row he merely prepared is not an application. Only `status = 'applied'`
 * counts, because that is the status HE sets; `applied_at` is when the engine
 * last ran on the form and says nothing about whether he pressed Submit.
 */
function appliedBefore(job) {
  if (!job?.id) return null;
  const when = (row) => row?.applied_at || row?.status_changed_at || null;
  try {
    const mine = db().prepare('SELECT status, applied_at, status_changed_at FROM jobs WHERE id = ?').get(String(job.id));
    if (mine?.status === 'applied') return { where: 'this', at: when(mine), title: job.title, company: job.company };
    const company = String(job.company || '').trim();
    const title = String(job.title || '').trim();
    if (!company || !title) return null;
    const same = db().prepare(
      "SELECT id, title, url, applied_at, status_changed_at FROM jobs WHERE company = ? AND status = 'applied' AND id != ? ORDER BY applied_at DESC LIMIT 20",
    ).all(company, String(job.id));
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hit = same.find((r) => norm(r.title) === norm(title));
    return hit ? { where: 'role', at: when(hit), title: hit.title, company, otherId: hit.id, otherUrl: hit.url } : null;
  } catch { return null; }
}

let IMPORT_TOKEN;
try { IMPORT_TOKEN = readFileSync(IMPORT_TOKEN_PATH, 'utf-8').trim(); } catch { IMPORT_TOKEN = ''; }
if (!IMPORT_TOKEN) {
  IMPORT_TOKEN = randomBytes(16).toString('hex');
  try { writeFileSync(IMPORT_TOKEN_PATH, IMPORT_TOKEN); } catch { /* read-only fs — imports disabled */ }
}

const portFlag = process.argv.indexOf('--port');
const PORT = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : (process.env.JARVIS_PORT || 4300);

/** The origin a request reached this server on — for URLs handed back to a page. */
function pageBase(req) {
  const host = String(req.headers?.host || 'localhost:4300');
  return `http://${host}`;
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/**
 * Header counts, computed by the database.
 *
 * The inbox pill must count what the inbox SHOWS. Blocked postings are
 * filtered out of every list by default, so counting them made the header
 * promise 96,901 unread against a list of 76,337 — the gap being exactly the
 * work-auth and preference blocks. A job he has since acted on still counts
 * under its own status; only the unread bucket is trimmed.
 */
const counts = memoOnStore(() => {
  const c = { total: count() };
  for (const s of STATUSES) c[s] = 0;
  for (const [status, n] of Object.entries(countBy('status'))) c[status] = n;
  c.new = count({ status: 'new', blocked: false, fitBlocked: false });
  // …AND AN EMPLOYER HE HAS HIDDEN IS HIDDEN EVERYWHERE, including here.
  // Hiding a company is a decision, so it applies to the decided piles too
  // (the list has done this for months) — and the header did not, so it read
  // "22 inbox" over a list of 21 (screenshotted 2026-09-07). One posting, but
  // the same fault this file has fixed three times: a number that disagrees
  // with its own destination.
  const hidden = hiddenCompanies();
  if (hidden.length) {
    for (const s of ['inbox', 'queued', 'interested']) {
      c[s] = count({ status: s, excludeCompany: hidden });
    }
  }
  return c;
});

// ── resumes ─────────────────────────────────────────────────────────
// Rendered resume PDFs live in output/jarvis-resumes/. The Resumes view lists
// them, shows which job each is tailored for, and previews them inline.
const RESUME_DIR = process.env.JARVIS_RESUME_DIR || path.join(ROOT, 'output', 'jarvis-resumes');

/** Company logos, looked up once each and kept beside his data. */
const LOGOS = new LogoCache(path.join(STORE_DIR, 'logos'));
const LOGO_PARALLEL = 4;
let logoBusy = 0;
const logoQueue = [];
function logoSlot() {
  if (logoBusy < LOGO_PARALLEL) { logoBusy++; return Promise.resolve(); }
  return new Promise((resolve) => logoQueue.push(resolve)).then(() => { logoBusy++; });
}
function logoRelease() {
  logoBusy--;
  const next = logoQueue.shift();
  if (next) next();
}
const APPLY_PROFILE_PATH = path.join(STORE_DIR, 'apply-profile.yml');

/** The profile's fallback resume, read without pulling in a YAML parser — this
 *  server is deliberately Node-built-ins only. Every file is named "Alex Rivera
 *  Resume.pdf", so the FOLDER is what identifies it. */
function defaultResumeDir() {
  try {
    const m = readFileSync(APPLY_PROFILE_PATH, 'utf-8')
      .match(/^\s*resume_path:\s*["']?([^"'\n#]+)/m);
    return m ? path.basename(path.dirname(m[1].trim())) : '';
  } catch { return ''; }
}

/**
 * Every FAMILY BASE is called "Alex Rivera Resume.pdf" — they belong to no posting,
 * so the folder is the variant — and that is why this walks the family folders
 * instead of the top level. Listing only the top level showed an empty Resumes
 * tab once the four family folders existed, which is exactly when he most needs
 * to see which four are in play. (A resume built for a posting is named for it:
 * F-409.)
 *
 * `sent/` and the internal `.upload/` staging folder are excluded: the first is
 * the per-application audit trail (surfaced in Review & Send, one row per
 * application), the second is a scratch copy of whatever went out last.
 */
const HIDDEN_RESUME_DIRS = new Set(['sent', '.upload']);

/**
 * A clickable link to a resume that was actually sent, or null.
 *
 * `sent/` is deliberately absent from the resume BROWSER — those are the
 * per-application audit trail rather than the four family builds — so this is
 * the only route to them, and it goes through the same guarded /resume handler
 * rather than exposing a second way to read a file off disk.
 */
function resumeLink(storedPath) {
  // path.basename handles both separators, so no escape is needed here —
  // and a regex over backslashes is the one construction that has failed to
  // survive editing seven times in this session.
  const name = path.basename(String(storedPath || ''));
  if (!name.toLowerCase().endsWith('.pdf')) return null;
  if (!existsSync(path.join(RESUME_DIR, 'sent', name))) return null;
  return `/resume?dir=sent&file=${encodeURIComponent(name)}`;
}

/**
 * The per-application audit copies, newest first.
 *
 * Their filenames are the record - "Alex Rivera Resume - <family> - <Company> -
 * <Position>.pdf" - which is the naming he asked for, and is what makes fifty
 * near-identical PDFs tellable apart. Every part is optional, because older
 * files and hand-made ones do not all carry them.
 */
function sentArchive() {
  const dir = path.join(RESUME_DIR, 'sent');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.pdf')) continue;
    let st;
    try { st = statSync(path.join(dir, name)); } catch { continue; }
    const parts = name.slice(0, -4).split(' - ');
    // The rewrite record written beside the PDF. Older files predate it, so a
    // missing sidecar is normal and simply means "no record kept", not an error.
    let tailoring = null;
    try { tailoring = JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf-8')); } catch { /* none */ }
    // WHICH JOB THIS WAS FOR, beyond the company and title in the filename.
    //
    // Alex, 2026-09-03: "not very distinguishable which resume is for which
    // job". Two KLA mechanical resumes a week apart look identical on this
    // tab; the requisition id and the location are what tell them apart, and
    // both come from the posting the sidecar remembers.
    const postingUrl = tailoring?.url || '';
    const job = archiveRowFor(name, postingUrl, tailoring?.company || (parts[2] || ''));
    const reqToken = postingUrl ? (ATS?.reqToken?.(postingUrl) || (job?.url ? ATS?.reqToken?.(job.url) : null) || null) : null;
    out.push({
      file: name,
      postingUrl,
      jobId: job?.id || (postingUrl ? jobId(postingUrl) : null),
      // The id the company uses — "R572922", "7668502003" — without the ATS
      // prefix the token carries for matching, and without Workday's slugged
      // title in front of it (the card already says the title).
      requisition: shortRequisition(reqToken),
      location: job?.location || '',
      status: job?.status || '',
      // WAS A RECORD KEPT AT ALL? Two different facts were arriving as one.
      //
      // A card with no rewrite list reads as "nothing was reworded for this
      // posting". For 48 of the 50 resumes in his archive the truth is "this
      // was built before rewrites were logged, and nobody knows what changed" —
      // which is the opposite of reassuring, and he cannot tell them apart.
      // Same shape as F-240: an absence reported in the language of a result.
      logged: !!tailoring,
      // What changed and why, so the reasoning survives alongside the result.
      why: tailoring?.why || '',
      rewrites: (tailoring?.applied || []).map((a) => ({ key: a.key, from: a.from, to: a.to })),
      refused: (tailoring?.refused || []).length,
      family: parts.length > 1 ? parts[1] : '',
      company: tailoring?.company || (parts.length > 2 ? parts[2] : ''),
      title: tailoring?.title || (parts.length > 3 ? parts.slice(3).join(' - ') : ''),
      bytes: st.size,
      at: st.mtime.toISOString(),
      url: `/resume?dir=sent&file=${encodeURIComponent(name)}`,
    });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out;
}

/** Which store row each per-posting resume file belongs to. A full-table scan (1.1 s measured), so once per store change. */
const resumeOwners = memoOnStore(() => {
  const byPath = new Map();
  for (const j of query({ hasResume: true }, { limit: 2000 }).rows) {
    byPath.set(String(j.resume_path).replace(/\\/g, '/'), {
      id: j.id, company: j.company, title: j.title, url: j.url, status: j.status,
    });
  }
  return byPath;
});

function listResumes() {
  const found = [];
  const readDir = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (rel || HIDDEN_RESUME_DIRS.has(e.name)) continue;   // one level only
        readDir(path.join(dir, e.name), e.name);
      } else if (e.name.toLowerCase().endsWith('.pdf')) {
        found.push({ file: e.name, dir: rel, full: path.join(dir, e.name) });
      }
    }
  };
  readDir(RESUME_DIR, '');
  if (!found.length) return { dir: path.relative(ROOT, RESUME_DIR).replace(/\\/g, '/'), defaultFile: '', resumes: [], code: codeChangedSinceStart() };

  // Which job (if any) each rendered resume was tailored for. Family resumes are
  // shared across many postings, so only a genuinely per-posting file matches.
  const byPath = resumeOwners();

  // The label a family folder carries, read off the spec that built the PDF, so
  // the tab names the lane ("Automation, robotics & controls") rather than a slug.
  const labelFor = (dir) => {
    try {
      const spec = JSON.parse(readFileSync(path.join(RESUME_DIR, dir, 'spec.json'), 'utf-8'));
      return { label: spec.familyLabel || '', titles: (spec.experience || []).filter(e => /intern/i.test(e.title)).map(e => `${e.org}: ${e.title}`) };
    } catch { return { label: '', titles: [] }; }
  };

  const defaultDir = defaultResumeDir();
  const resumes = found.map(({ file, dir, full }) => {
    let bytes = 0, mtime = null;
    try { const s = statSync(full); bytes = s.size; mtime = s.mtime.toISOString(); } catch { /* vanished */ }
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const { label, titles } = dir ? labelFor(dir) : { label: '', titles: [] };
    return {
      file, dir, path: rel, bytes, mtime,
      family: dir, familyLabel: label, titles,
      isDefault: !!dir && dir === defaultDir,
      job: byPath.get(rel) || null,
    };
  }).sort((a, b) =>
    Number(b.isDefault) - Number(a.isDefault) || a.family.localeCompare(b.family));

  return {
    dir: path.relative(ROOT, RESUME_DIR).split(path.sep).join('/'),
    defaultFile: defaultDir,
    resumes,
    // EVERY TAILORED RESUME HE HAS EVER SENT.
    //
    // Alex, 2026-09-02: "i think we need to make a resume viewer, i think we
    // already have that but like a storage for all tailored resume".
    //
    // He is right on both counts. This tab existed and showed four files - the
    // family builds - because `sent/` is excluded from the walk above as an
    // audit trail rather than a library. Fifty tailored PDFs were on disk with
    // nothing listing them, so the only one he could reach was whichever the
    // last application happened to upload.
    //
    // Kept as a SEPARATE list rather than mixed in: the four family builds are
    // the current templates, and these are the history of what actually went
    // out. Collapsing them would lose that distinction.
    archive: sentArchive(),
    code: codeChangedSinceStart(),
  };
}

// ── overview ────────────────────────────────────────────────────────
// The Home view answers "what has this thing actually DONE for me?" — coverage,
// what it filtered and why, what it can auto-apply to, and a real activity log.
// All derived from the one store; nothing is tracked separately.

// Keys mirror triage.mjs classifyVisa() exactly — us_person (ITAR) is kept
// distinct from us_citizen because they are different disqualifiers.
const BLOCK_LABELS = {
  clearance: 'Security clearance required',
  us_person: 'ITAR / U.S. person required',
  us_citizen: 'U.S. citizenship required',
  export_authorization: 'Offer contingent on export-control authorization',
  no_sponsorship: 'States it will not sponsor',
  perm_authorization: 'Permanent work authorization required',
};

/**
 * Home's numbers, counted by the database.
 *
 * This used to walk all 107k jobs in JavaScript on every page load. Each line
 * below is an indexed COUNT, which is why the tiles come back in milliseconds
 * and would still at ten times the store.
 */
// 60s floor on background-driven recomputes. `flagTotals()` alone is a 4.7-6.4s
// full scan of 385k rows (measured 2026-09-22) and the whole of this is 22-39s
// cold against 2ms warm — while a scan runs, every request paid the cold path,
// and because the server is single-threaded that froze EVERY tab, not just this
// one. His own clicks still recompute immediately; see memoOnStore.
/**
 * The prepared-applications board, memoised.
 *
 * Measured 2026-09-22: 6.0-6.8s median, 12.1s worst, on EVERY click of the
 * Applications tab — the single worst number in the dashboard, and the whole of
 * his "3 seconds" on that tab. It is not the SQL: the row fetch is under 11ms
 * against an index. It is `full: true` decompressing 134 detail blobs, plus an
 * `existsSync` per row for the resume link, recomputed from scratch each time.
 *
 * Nothing here changes unless the store does, so it is cached like the overview
 * tiles. The 30s floor stops a background scan's commits from forcing a rebuild
 * on every request; a write by HIM still rebuilds at once, so a card he just
 * moved is never stale.
 */
const preparedRows = memoOnStore(() => {
    // "23 applications ready for you" was counting two things that are not
    // ready. Five of them filled ZERO fields — the run failed, and opening
    // one to find an empty form is worse than being told it failed. Six more
    // are at employers he has since hidden: he decided against KLA and
    // Axcelis after those forms were filled, and a decision he already made
    // should not be re-presented as work waiting for him.
    const hiddenNow = new Set(hiddenCompanies());
    const rows = query({ prepared: true }, { sort: 'applied', limit: 500, full: true }).rows
      .map(j => ({
        failed: !(j.apply.filled > 0),
        // A run that filled nothing because the POSTING IS GONE is not a
        // run to repeat. Micron, Western Digital and AbbVie all read
        // "filled nothing and need re-running" on 2026-09-04 with the page
        // saying the job was closed; the board should say that instead.
        gone: !!j.goneAt,
        staleCompany: hiddenNow.has(j.company),
        id: j.id,
        company: j.company || '',
        title: j.title || '',
        location: j.location || '',
        status: j.status || 'new',
        at: j.apply.at,
        // Fall back to the posting if an older record has no apply URL.
        url: j.apply.url || j.url,
        postingUrl: j.url,
        filled: j.apply.filled || 0,
        // Ticked boxes, so Review & Send can agree with the badge he saw.
        checked: j.apply.checked || 0,
        skipped: j.apply.skipped || 0,
        resume: !!j.apply.resumeUploaded,
        // Exactly which PDF went out, so it can be opened and checked BEFORE
        // Submit rather than taken on trust.
        resumeSent: j.resume_sent || '',
        // THE LINK HE COULD NOT FOLLOW.
        //
        // Alex, 2026-09-02: "sometimes you generate resume but i cant view it
        // since the job site doesnt let me so idk what you wrote or how it
        // looks like."
        //
        // Every piece was already here: the audit copy is written to sent/
        // for exactly this reason, its path is on the row, and /resume serves
        // a PDF inline. What the row carried was a BOOLEAN — resume: true —
        // which tells him one was built and gives him no way to read it. The
        // one thing missing between the file and his eyes was a URL.
        resumeUrl: resumeLink(j.resume_sent),
        reachedReview: !!j.apply.reachedReview,
        needs: (j.apply.needsInput || []).map(n => ({ l: n.label, w: n.why })),
        written: (j.apply.written || []).map(w => ({ l: w.label, n: w.words, p: w.problems || [] })),
        stoppedBecause: j.apply.stoppedBecause || '',
        review: (j.apply.review || []).map(r => ({ l: r.label, v: String(r.value) })),
      }));
  return rows;
}, { minAgeMs: 30_000 });

const buildOverview = memoOnStore(() => {
  const now = Date.now();
  const DAY = 86400000;
  const iso = (ms) => new Date(now - ms).toISOString();
  const browsable = { browsable: true };

  const hiddenNow = hiddenCompanies();

  const stat = {
    ...flagTotals(),                        // one pass for the eight headline totals
    // A TILE MUST COUNT WHAT ITS OWN CLICK-THROUGH SHOWS.
    //
    // The raw deck count promised 136 new-grad reqs and the list it opened had
    // 106 in it — the difference being postings already decided on and
    // postings at employers he has hidden. Clicking a number and getting a
    // different number is the specific bug the promoted `deck` column was
    // introduced to prevent; it just was not applied here.
    newGrad: count({
      browsable: true, newGrad: true,
      status: ['new', 'interested'],
      excludeCompany: hiddenNow.length ? hiddenNow : undefined,
    }),
    // Same correction for the work-auth tile: 674 of the 10,744 blocks are at
    // employers he has hidden, and every list excludes those, so the tile was
    // promising 674 postings its own click-through would never show.
    blocked: count({
      blocked: true,
      excludeCompany: hiddenNow.length ? hiddenNow : undefined,
    }),
    // Third tile with the same defect, found by clicking it: it counted every
    // posting captured in 24 hours across the WHOLE store and opened the
    // filtered inbox. It read 1 and its destination showed 3,449 before the
    // window was applied at all, then 0 once it was — because the one posting
    // captured that day is not one the inbox would show.
    //
    // A tile counts what its own click-through shows. Same shape as the
    // new-grad and work-auth corrections above.
    new24h: count({
      browsable: true, since: iso(DAY),
      status: ['new', 'interested'],
      excludeCompany: hiddenNow.length ? hiddenNow : undefined,
    }),
    new7d: count({
      browsable: true, since: iso(7 * DAY),
      status: ['new', 'interested'],
      excludeCompany: hiddenNow.length ? hiddenNow : undefined,
    }),
    readable: count({ ...browsable, source: READABLE_SOURCES }),
    deepRead: count({ ...browsable, source: READABLE_SOURCES, hasDesc: true }),
    applyable: 0, queuedApplyable: 0,
    companies: distinctCompanies(),
  };

  const blockReasons = countBy('block_key', { blocked: true });
  const bySource = countBy('source');
  const byCompanyCounts = countBy('company', browsable);

  // Apply reach: which postings the engine can actually drive, by ATS.
  const byAdapter = countBy('adapter', browsable);
  delete byAdapter.unknown;   // countBy files NULL (no adapter) under 'unknown'
  stat.applyable = Object.values(byAdapter).reduce((a, b) => a + b, 0);
  stat.queuedApplyable = count({ status: 'queued', hasAdapter: true });

  // Companies, and which of them are on the watchlist.
  const byCompany = new Map();
  for (const [company, n] of Object.entries(byCompanyCounts)) {
    byCompany.set(company, { company, n, watchlist: false, top: 0 });
  }
  for (const company of Object.keys(countBy('company', { ...browsable, tier: 'watchlist' }))) {
    const co = byCompany.get(company);
    if (co) co.watchlist = true;
  }

  const applyRuns = query({ prepared: true }, { sort: 'applied', limit: 60, full: true }).rows
    .map(j => ({
      at: j.apply.at, company: j.company, title: j.title, url: j.url,
      filled: Array.isArray(j.apply.filled) ? j.apply.filled.length : (j.apply.filled || 0),
      needs: j.apply.needsInput?.length ?? 0,
    }));

  // Funnel — captured narrows to what the user actually acted on.
  const c = counts();
  const scans = getScans(12);
  const funnel = [
    { key: 'captured', label: 'Captured', n: stat.total },
    { key: 'browsable', label: 'Passed triage', n: stat.browsable },
    { key: 'interested', label: 'Interested', n: c.interested || 0 },
    { key: 'queued', label: 'Queued', n: c.queued || 0 },
    { key: 'applied', label: 'Applied', n: c.applied || 0 },
    { key: 'interview', label: 'Interview', n: (c.interview || 0) + (c.responded || 0) },
    { key: 'offer', label: 'Offer', n: c.offer || 0 },
  ];

  // Activity: scans and apply runs interleaved, newest first.
  const activity = [];
  for (const s of scans) {
    // NAME the companies. The scan record carries perCompany[].company, and
    // throwing it away turned the activity log into a dozen identical rows
    // reading "Scanned 1 source(s)" — a panel that filled half the page and
    // told you nothing about what was actually searched.
    const names = (s.perCompany || []).map(c => c && c.company).filter(Boolean);
    const who = names.length === 0 ? `${s.companiesScanned || 0} sources`
      : names.length <= 3 ? names.join(', ')
        : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
    activity.push({
      kind: 'scan', at: s.at,
      text: `Scanned ${who} — ${(s.postingsCaptured || 0).toLocaleString()} postings seen, ${(s.added || 0).toLocaleString()} new`,
    });
  }
  for (const r of applyRuns) {
    activity.push({
      kind: 'apply', at: r.at, url: r.url,
      text: `Filled application at ${r.company} — ${r.title} (${r.filled} fields, ${r.needs} left for you)`,
    });
  }
  activity.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return {
    stat,
    counts: c,
    funnel,
    blockReasons: Object.entries(blockReasons)
      .map(([key, n]) => ({ key, label: BLOCK_LABELS[key] || key, n }))
      .sort((a, b) => b.n - a.n),
    byAdapter: Object.entries(byAdapter).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    bySource: Object.entries(bySource).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 10),
    topCompanies: [...byCompany.values()].sort((a, b) => b.n - a.n).slice(0, 14),
    activity: activity.slice(0, 14),
    lastScanAt: scans[0]?.at || null,
    // Counts the family resumes (one PDF per folder), not the audit copies.
    resumeCount: listResumes().resumes.length,
    storage: storeStats(),
    code: codeChangedSinceStart(),
  };
}, { minAgeMs: 60_000 });

/**
 * A TEST THAT READS HIS REAL STORE MUST NOT BE ABLE TO WRITE TO IT.
 *
 * `dashboard.test.mjs` runs the dashboard against the production store on
 * purpose — the header budget it guards is only meaningful with real postings
 * behind it, and a seeded temp store would measure a page with no cards on it.
 * `JARVIS_AUTO=0` already stops the background writers, so no scan, enrich or
 * retire runs. What is NOT prevented is a test doing something that writes: a
 * click on hide, track or skip would change his data, and the tests grow.
 *
 * So the invariant is enforced rather than remembered. With JARVIS_READONLY=1
 * every mutating request is refused before it reaches a handler, and the test
 * that needed it fails loudly instead of quietly editing his job store.
 *
 * GET and HEAD only. This is not a security control — it is a guard rail for
 * our own test suite, on a server bound to localhost.
 */
const READONLY = process.env.JARVIS_READONLY === '1';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // IS A JARVIS LISTENING? The one question that must never touch the store.
    //
    // A second launch asks this before deciding whether the port is held by us
    // or by something else, and it used to ask `/api/overview` — which counts
    // across 300,000 rows and twice took longer than the 3-second probe
    // allowed, so a healthy dashboard was reported as "something that is not
    // Jarvis" and he was told to kill it. Nothing here reads anything.
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return json(res, 200, { jarvis: true, pid: process.pid, port: PORT });
    }

    if (READONLY && req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 403, {
        error: `read-only mode: ${req.method} ${url.pathname} was refused. `
          + 'This server is running against the real store for a test; a test must not write to it.',
      });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!existsSync(HTML_PATH)) return json(res, 500, { error: 'dashboard.html missing' });
      // The page needs to know which boards a body can be read from, and it
      // cannot import the module that knows (F-444). Stamped in here rather
      // than retyped in the HTML, where the last copy fell five boards behind
      // and the card gave advice that was false.
      const html = readFileSync(HTML_PATH, 'utf-8').replace(
        '<head>',
        `<head><script>window.__JARVIS_SOURCES=${JSON.stringify({ readable: READABLE_SOURCES, browserOnly: BROWSER_ONLY })};</script>`,
      );
      // No cache headers were sent at all, so Chrome applied heuristic caching
      // and served an OLD dashboard.html after the file had changed. The
      // server's own stale-code banner cannot catch this: the SERVER was
      // fresh, and the browser was not.
      //
      // It cost a wrong diagnosis during the ninth pass — a CSS fix measured
      // as "not applied" when the file on disk and the server response both
      // already had it. Same failure as F-24, one layer further out.
      //
      // The whole page is one file read from disk per request on localhost;
      // there is no caching benefit worth that confusion.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, must-revalidate',
      });
      return res.end(html);
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      // A PAGE of jobs, filtered and sorted by the database.
      //
      // This used to serialise every job in the store so the page could filter
      // client-side: 77 MB at 107k jobs, on every load, to render 400 rows.
      // The filters below are the same ones the dashboard offers; they arrive
      // as query parameters and become an indexed WHERE clause.
      const p = url.searchParams;
      // REPEATED PARAMS FIRST, commas only as the old shorthand. 651 postings
      // in his store carry a comma in the company name ("Smith, Jones & Co"),
      // and splitting on commas turns one hidden employer into two names that
      // match nothing — so a value given more than once is taken as given.
      const list = (k) => {
        const many = p.getAll(k).filter(Boolean);
        if (many.length > 1) return many;
        return many.length === 1 ? many[0].split(',').filter(Boolean) : undefined;
      };
      const tri = (k) => (p.get(k) === '1' ? true : p.get(k) === '0' ? false : undefined);
      const num = (k) => (p.get(k) != null && p.get(k) !== '' ? Number(p.get(k)) : undefined);

      const filters = {
        status: list('status'),
        notStatus: list('notStatus'),
        band: list('band'),
        locationBucket: list('loc'),
        level: list('level'),
        company: list('company'),
        excludeCompany: list('excludeCompany'),
        // The field filter had a dropdown, a database column and an index —
        // and this line was missing, so every option returned the identical
        // 12,302 rows. The one control built for the "show me robotics, not
        // ten fab jobs in a row" request never filtered anything.
        field: list('field'),
        tier: list('tier'),
        search: p.get('q') || undefined,
        minScore: num('minScore'),
        minRelevance: num('minRelevance'),
        blocked: tri('blocked'),
        fitBlocked: tri('fitBlocked'),
        intern: tri('intern'),
        handsOn: tri('handsOn'),
        newGrad: tri('newGrad'),
        gradMismatch: tri('gradMismatch'),
        degreeMismatch: tri('degreeMismatch'),
        sponsors: tri('sponsors'),
        since: p.get('since') || undefined,
        // Freshness in days. `since` is a different question — when the
        // SCANNER first saw it — and answering one with the other would make
        // "posted ≤ 7 days" mean "captured in the last 7 days", which on a
        // company tracked last week is every posting it has ever had.
        postedWithin: num('postedWithin'),
      };
      const sort = p.get('sort') || 'fit';
      const { rows, total } = query(filters, {
        sort,
        limit: num('limit') ?? 400,
        offset: num('offset') ?? 0,
      });

      // Spread by default, because strict score order made the deck
      // unbrowsable: 31 of the top 100 were one employer and the card view
      // showed ten near-identical reqs in a row. Only ever reorders a page —
      // no row is dropped — and it is off for the explicitly-ordered sorts,
      // where the whole point is to see the sequence the database produced.
      const spreadable = sort === 'fit' || sort === 'relevance';
      const spread = p.get('spread') === '0' ? false : spreadable;
      const jobs = spread ? spreadRows(rows) : rows;

      // THE SCAN LOG IS 81-95% OF THIS RESPONSE AND THE LIST NEVER READS IT.
      //
      // Measured 2026-09-22: a Library page is 2,295,619 bytes, of which
      // 1,855,146 are `scans` and 439,917 are the jobs actually being shown.
      // The last five scan records carry a 343 KB `perCompany` array each.
      // `apply()` reads `d.jobs`, `d.total` and `d.counts`; the only reader of
      // the scan log is `S.scans`, assigned once in `load()` at page open and
      // shown in the scan panel.
      //
      // So it was serialised, sent and parsed on every tab switch and every
      // search keystroke, and thrown away each time. Now it goes only to the
      // caller that asks, which is that one call at page load.
      const wantsScans = p.get('scans') === '1';
      return json(res, 200, {
        jobs, total, spread,
        counts: counts(),
        ...(wantsScans ? { scans: getScans(20) } : {}),
        hiddenCompanies: hiddenCompanies(),
      });
    }

    // TODAY — a bounded, finishable day's work.
    //
    // The deck holds ~21,000 browsable postings and 147,554 of 147,576 sat
    // untouched: an inbox with no end never gets worked, because there is no
    // moment where you are done. This hands back a fixed, spread slate of the
    // best undecided postings and nothing else. When it is empty, the day's
    // triage is finished — that is the whole point of it.
    // ── OUTREACH ─────────────────────────────────────────────────────
    //
    // Nothing under here sends anything. It produces a search spec, a draft,
    // and a ledger entry; the message leaves from his own client and his own
    // LinkedIn, which is both Product Law 4 and the only way to keep the
    // LinkedIn account a job search depends on. See jarvis/OUTREACH.md.

    /**
     * The address format ONE company uses, learned from its own postings.
     *
     * Per company on demand, not a pass over the whole deck: reading all 3,700
     * readable descriptions takes about forty seconds, which is a page load
     * nobody waits for. Twenty of one company's postings take milliseconds and
     * answer the same question, because a company writes the same footer on
     * every req.
     */
    const emailHintsFor = (company) => {
      if (!company) return {};
      if (EMAIL_HINTS.has(company)) return EMAIL_HINTS.get(company);
      const samples = [];
      const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
      for (const j of query({ company: [company], hasDesc: true }, { limit: 20 }).rows || []) {
        for (const e of (getDescription(j.id) || '').match(EMAIL) || []) {
          if (/\.(png|jpe?g|gif|svg|webp)$/i.test(e)) continue;
          if (!samples.includes(e)) samples.push(e);
        }
        if (samples.length >= 8) break;
      }
      const pat = emailPattern(samples);
      const hint = { domain: pat?.domain || domainFrom(samples), pattern: pat?.pattern || '', from: pat?.from || '' };
      EMAIL_HINTS.set(company, hint);
      return hint;
    };

    /** Everything he needs to go find one person for one job. */
    if (req.method === 'GET' && url.pathname === '/api/outreach') {
      const id = String(url.searchParams.get('id') || '');
      const job = id ? getJob(id) : null;
      if (!job) return json(res, 404, { error: 'no such job' });
      const hints = emailHintsFor(job.company);
      const spec = targetSpec(job, { description: getDescription(job.id) || '', domain: hints.domain || '' });
      const existing = forJob(job.id);
      return json(res, 200, {
        job: { id: job.id, company: job.company, title: job.title, team: job.team, location: job.location, url: job.url, status: job.status },
        spec,
        emailHint: hints,
        contacts: existing,
        // WHY he may or may not write to another person about this role. The
        // reason is the useful half; a bare false teaches nothing.
        gate: canContact(null, existing, { jobId: job.id }),
        channels: CHANNELS,
      });
    }

    /** The work list: follow-ups first, then jobs with nobody on them yet. */
    if (req.method === 'GET' && url.pathname === '/api/outreach/queue') {
      const due = dueFollowUps();
      // Scoped to what he has actually committed to — queued, applied, or in
      // his inbox. Outreach about a posting he has not decided on is the
      // volume play this feature exists to avoid.
      const committed = query({ status: ['inbox', 'interested', 'queued', 'applied'] }, { limit: 200 }).rows || [];
      const seen = new Set(allContacts({ limit: 5000 }).map((c) => c.job_id));
      // The card's Outreach button researches people too (leads.mjs). A job
      // with people found there is not a job "with nobody on it" — the two
      // features used to disagree about the same KLA card (2026-09-17).
      let leads = {};
      try { leads = leadSummary(); } catch { leads = {}; }
      return json(res, 200, {
        due,
        stats: outreachStats(),
        jobs: committed.map((j) => ({
          id: j.id, company: j.company, title: j.title, team: j.team, location: j.location, status: j.status,
          hasContact: seen.has(j.id),
          leadsFound: leads[j.id]?.status === 'done' ? leads[j.id].count || 0 : 0,
          leadsRunning: leads[j.id]?.status === 'running',
        })),
      });
    }

    /** Draft one message. Returns it WITH its problems, and never sends it. */
    if (req.method === 'POST' && url.pathname === '/api/outreach/draft') {
      const body = await readBody(req);
      const job = getJob(String(body.id || ''));
      if (!job) return json(res, 404, { error: 'no such job' });
      const channel = CHANNELS[body.channel] ? body.channel : 'email';
      const contact = { name: String(body.name || ''), title: String(body.title || '') };
      const hints = emailHintsFor(job.company);
      const spec = targetSpec(job, { description: getDescription(job.id) || '', domain: hints.domain || '' });
      const draft = await writeOutreach(job, {
        jd: getDescription(job.id) || '',
        channel,
        persona: String(body.persona || 'team'),
        contact,
        spec,
        request: String(body.request || ''),
      });
      return json(res, 200, {
        ...draft,
        email: contact.name && hints.domain ? candidateEmail(contact.name, hints) : null,
      });
    }

    /** Record the person, the draft, and what he did with it. */
    if (req.method === 'POST' && url.pathname === '/api/outreach/contact') {
      const body = await readBody(req);
      const job = getJob(String(body.id || ''));
      if (!job) return json(res, 404, { error: 'no such job' });
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'a contact needs a name' });
      const cid = contactId(job.company, name);
      const gate = canContact(getContact(cid), forJob(job.id), { jobId: job.id });
      // THE LEDGER SAYS NO AND MEANS IT. A do-not-contact or a second
      // follow-up is refused here, not left to the page to remember.
      if (!gate.ok && !body.force) return json(res, 409, { error: gate.why, gate });
      const hints = emailHintsFor(job.company);
      const mail = body.email ? { address: String(body.email), confidence: 'his' } : (candidateEmail(name, hints) || null);
      const saved = saveContact({
        job_id: job.id, company: job.company, name,
        title: String(body.title || ''), persona: String(body.persona || ''),
        channel: CHANNELS[body.channel] ? body.channel : 'email',
        linkedin_url: String(body.linkedin_url || ''),
        email: mail?.address || '', email_conf: mail?.confidence || '',
        draft: String(body.draft || ''), note: String(body.note || ''),
      });
      return json(res, 200, { contact: saved, gate });
    }

    /** He sent it / they replied / they asked not to be contacted. */
    if (req.method === 'POST' && url.pathname === '/api/outreach/mark') {
      const body = await readBody(req);
      const cid = String(body.contactId || '');
      const what = String(body.what || '');
      const done = what === 'sent' ? markSent(cid)
        : what === 'replied' ? markReplied(cid)
          : what === 'do-not-contact' ? markDoNotContact(cid, { why: String(body.why || '') })
            : null;
      if (!done) return json(res, 400, { error: `cannot mark "${what}" on ${cid || 'no contact'}` });
      return json(res, 200, { contact: done });
    }

    // ── LEADS: the Outreach button on an application card ──────────
    // Press it and Jarvis researches the people for that one job (web search
    // only, jarvis/leads.mjs); the page polls until the leads are back. It finds
    // and shows. Saving a lead to the ledger is a separate press, through the
    // same one-person-per-role gate as /api/outreach/contact.
    if (req.method === 'POST' && url.pathname === '/api/outreach/leads') {
      const body = await readBody(req);
      const job = getJob(String(body.id || ''));
      if (!job) return json(res, 404, { error: 'no such job' });
      const leadRun = startLeadRun(job, {
        description: getDescription(job.id) || '',
        hardBlock: !!job.triage?.flags?.hardBlock,
        refresh: !!body.refresh,
      });
      return json(res, leadRun?.status === 'running' ? 202 : 200, { run: leadRun, contacts: forJob(job.id) });
    }
    if (req.method === 'GET' && url.pathname === '/api/outreach/leads') {
      const id = String(url.searchParams.get('id') || '');
      const job = id ? getJob(id) : null;
      if (!job) return json(res, 404, { error: 'no such job' });
      return json(res, 200, {
        job: { id: job.id, company: job.company, title: job.title, location: job.location, url: job.url },
        run: getLeadRun(job.id) || { status: 'none' },
        contacts: forJob(job.id),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/outreach/leads/summary') {
      return json(res, 200, { jobs: leadSummary() });
    }

    // ── MAIL: his inbox moves his application cards (jarvis/mail.mjs) ──
    // Read-only Gmail. The routes set it up, sync it, show what each email did
    // to which card, and undo a move.
    if (req.method === 'GET' && url.pathname === '/api/mail/status') {
      return json(res, 200, { ...mailStatus(), syncing: !!mailSyncing, redirectUri: `http://localhost:${PORT}/oauth/gmail/callback` });
    }
    if (req.method === 'POST' && url.pathname === '/api/mail/client') {
      const body = await readBody(req);
      try { saveClient(body); } catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 200, mailStatus());
    }
    if (req.method === 'GET' && url.pathname === '/api/mail/connect') {
      try {
        res.writeHead(302, { location: authUrl(`http://localhost:${PORT}/oauth/gmail/callback`) });
        return res.end();
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/oauth/gmail/callback') {
      const back = (msg) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Jarvis · Gmail</title><body style="font:15px system-ui;background:#0e1116;color:#e6edf3;padding:40px">${msg.replace(/</g, '&lt;')}<p><a style="color:#5aa2ff" href="/#applications">Back to Applications</a></p></body>`);
      };
      if (url.searchParams.get('error')) return back(`Gmail was not connected: ${url.searchParams.get('error')}.`);
      try {
        const done = await finishAuth({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        kickMailSync();
        return back(`Gmail connected${done.account ? ` (${done.account})` : ''}, read-only. Jarvis is checking your inbox now.`);
      } catch (e) { return back(`Gmail was not connected: ${e.message}`); }
    }
    if (req.method === 'POST' && url.pathname === '/api/mail/sync') {
      if (!mailStatus().connected) return json(res, 409, { error: 'Gmail is not connected' });
      const r = await kickMailSync();
      return json(res, 200, r || { ok: false, error: 'already checking' });
    }
    if (req.method === 'POST' && url.pathname === '/api/mail/disconnect') {
      disconnectMail();
      return json(res, 200, mailStatus());
    }
    if (req.method === 'GET' && url.pathname === '/api/mail/events') {
      return json(res, 200, { latest: latestByJob(), recent: recentEvents({ limit: 100 }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/mail/undo') {
      const body = await readBody(req);
      const done = undoEvent(String(body.msgId || ''), mailStore);
      if (!done) return json(res, 404, { error: 'nothing to undo for that email' });
      return json(res, 200, { event: done });
    }

    if (req.method === 'GET' && url.pathname === '/api/today') {
      const size = Math.min(Number(url.searchParams.get('size')) || 20, 100);
      const hidden = hiddenCompanies();
      const base = {
        status: ['new'],
        browsable: true,
        blocked: false,
        fitBlocked: false,
        excludeCompany: hidden.length ? hidden : undefined,
      };

      // New-grad reqs first — they are the highest-odds tier for a graduating
      // senior, and there are only a few hundred of them. The general deck
      // tops the slate up when they run out, so the day's work is always a
      // full slate rather than a short one.
      // Unseen first, in four passes. A posting he has already been shown is
      // still status 'new' — he read it and moved on without deciding — and
      // leading with fit alone handed him the same cards every morning, which
      // is most of why the deck felt like it never moved.
      // Deliberately wide. Duplicates of one req score identically, so they sit
      // together in fit order — but only if the window reaches far enough to
      // contain all of them. Too narrow and the folding below sees three of the
      // six GlobalFoundries copies, hides three, and the fourth is back
      // tomorrow. The response is still `size`; this is just the pool it folds.
      const POOL = Math.max(size * 20, 300);
      // READ POSTINGS FIRST.
      //
      // 3,939 of the 12,002 in the deck have no description at all — the
      // provider has no detail path, so they were scored on their title and
      // nothing else. `confidence` already scales those down, and they still
      // reached seven of twenty cards in a day's slate, where they are the
      // least decidable thing on offer: no skills read, no visa language, no
      // pay, no degree requirement. A posting he can actually judge goes
      // first; the title-only ones top the slate up rather than lead it.
      const grads = [
        ...query({ ...base, newGrad: true, unseen: true, hasDesc: true }, { sort: 'fit', limit: POOL }).rows,
        ...query({ ...base, newGrad: true, hasDesc: true }, { sort: 'fit', limit: POOL }).rows,
        ...query({ ...base, newGrad: true }, { sort: 'fit', limit: POOL }).rows,
      ];
      const rest = [
        ...query({ ...base, unseen: true, hasDesc: true }, { sort: 'fit', limit: POOL }).rows,
        ...query({ ...base, hasDesc: true }, { sort: 'fit', limit: POOL }).rows,
        ...query(base, { sort: 'fit', limit: POOL }).rows,
      ];

      // One req, one card. A large employer posts the same opening across a
      // dozen sites — five GlobalFoundries "Semiconductor Manufacturing
      // Engineer (2027)" rows are one decision, and spending five of twenty
      // slots on it is exactly the monotony this view exists to remove.
      // Applying to one is applying to the opening.
      // One req, one card — and one DECISION. Dropping the duplicates from
      // this response is only half the job: GlobalFoundries posts the same
      // "Semiconductor Manufacturing Engineer (2027 New College Graduate)" six
      // times at the same site, so skipping the one on screen left five behind
      // and the very next card was the identical posting again. That is what
      // made skipping feel like it did nothing.
      //
      // The folded ids ride along on the representative, and the client acts on
      // the whole group, so one keystroke decides the opening rather than one
      // of its copies.
      const seen = new Set();
      const byReq = new Map();
      const pool = [];
      for (const r of [...grads, ...rest]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const key = `${r.company}|${String(r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
        const first = byReq.get(key);
        if (first) { (first._dupeIds ||= []).push(r.id); continue; }
        byReq.set(key, r);
        pool.push(r);
      }

      // A wider company gap than the general deck uses: on a twenty-card slate
      // the default lets one employer take five of them, which still reads as
      // "more of the same".
      const jobs = spreadRows(pool, { companyGap: 5, fieldGap: 2 }).slice(0, size);
      return json(res, 200, {
        jobs,
        size,
        remaining: count(base),
        newGradRemaining: count({ ...base, newGrad: true }),
      });
    }

    // "Since your last visit" — three numbers, counted in the database rather
    // than by shipping every job to the browser so it can compare timestamps.
    if (req.method === 'GET' && url.pathname === '/api/digest') {
      const since = url.searchParams.get('since');
      if (!since) return json(res, 200, { fresh: 0, matches: 0, watchlist: 0 });
      const hidden = hiddenCompanies();
      const base = { since, excludeCompany: hidden.length ? hidden : undefined };
      // "Matches your profile" is the same definition the inbox uses, plus a
      // relevance floor. It used to be spelled out separately here and counted
      // technician postings and internships as matches, which the list itself
      // would then refuse to show.
      const match = {
        ...base, browsable: true,
        level: ['entry', 'stretch', 'unknown', 'mid'],
        minRelevance: 15,
      };
      return json(res, 200, {
        fresh: count(base),
        matches: count(match),
        watchlist: count({ ...match, tier: 'watchlist' }),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return json(res, 200, buildOverview());
    }

    if (req.method === 'GET' && url.pathname === '/api/resumes') {
      return json(res, 200, listResumes());
    }

    // Applications the engine has prepared and left for review. The whole point
    // is one click to the exact page the work was left on, so apply.url leads.
    if (req.method === 'GET' && url.pathname === '/api/prepared') {
      return json(res, 200, { rows: preparedRows() });
    }

    if (req.method === 'GET' && url.pathname === '/resume') {
      // Serve a rendered resume PDF inline so the dashboard can preview it.
      // path.basename() strips any traversal ("../../.ssh/id_rsa") before the
      // join, and the resolved path is re-checked against RESUME_DIR — the
      // only directory this server will ever read a file out of.
      const name = path.basename(url.searchParams.get('file') || '');
      // Resumes now live in per-variant subfolders ("sent", "default",
      // "total-experience", "automation", …). Allow ONE level, restricted to a plain slug so
      // nothing path-like survives; the resolved-path containment check below is
      // still the actual guarantee.
      const rawDir = url.searchParams.get('dir') || '';
      const dir = /^[a-z0-9][a-z0-9-]{0,40}$/i.test(rawDir) ? rawDir : '';
      const full = path.resolve(RESUME_DIR, dir, name);
      if (!name.toLowerCase().endsWith('.pdf')
        || !full.startsWith(path.resolve(RESUME_DIR) + path.sep)
        || !existsSync(full)) {
        return json(res, 404, { error: 'no such resume' });
      }
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': statSync(full).size,
        'content-disposition': contentDisposition('inline', name),
        'cache-control': 'no-cache',
      });
      return createReadStream(full).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/logo') {
      // A company's logo, or 404 for the lettermark. See company-logo.mjs for
      // how the domain is guessed and why only a domain ever leaves this
      // machine. Lookups are throttled: a first visit to a 200-row inbox
      // must not open 200 connections to a favicon service at once.
      const company = String(url.searchParams.get('company') || '').slice(0, 120);
      const u = String(url.searchParams.get('u') || '').slice(0, 800);
      if (!logoKey(company)) return json(res, 404, { error: 'no company' });
      let hit = LOGOS.peek(company);
      if (!hit) {
        await logoSlot();
        try { hit = await LOGOS.resolve({ company, url: u }); }
        finally { logoRelease(); }
      }
      if (!hit || hit.none || !hit.full || !existsSync(hit.full)) {
        // 204, not 404: the card's <img> still fires onerror on an empty
        // body and falls back to the lettermark, but Chrome no longer logs
        // "Failed to load resource: 404" once per company on every view
        // (F-350 — dozens of red lines on a clean inbox).
        res.writeHead(204, { 'cache-control': 'private, max-age=3600', 'x-logo': 'none' });
        return res.end();
      }
      res.writeHead(200, {
        'content-type': hit.type || 'image/png',
        'content-length': statSync(hit.full).size,
        'cache-control': 'private, max-age=86400',
        'x-logo-domain': hit.domain || '',
      });
      return createReadStream(hit.full).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/progress') {
      let batch = null;
      try { batch = JSON.parse(readFileSync(PROGRESS_PATH, 'utf-8')); } catch { /* no batch yet */ }
      // A batch that was killed — or crashed — never writes its completion
      // record, so `running:true` sits in the file forever and the header reads
      // "reading batch 150/150…" for the rest of time. The worker writes every
      // 5 jobs, so a file whose last WRITE is old is not a running batch
      // whatever it claims.
      //
      // Measured from the last write, never from startedAt. `enrichChild` is
      // only set for runs this server spawned itself, so a batch the user
      // started by hand — which is exactly what the dashboard's own
      // "no description" note tells them to do — is judged by this rule. Timing
      // it from the start meant any manual run longer than ten minutes was
      // reported as "stopped early" while it was still reading jobs.
      if (batch?.running && !enrichChild) {
        const lastWrite = Date.parse(batch.updatedAt || '')
          || (() => { try { return statSync(PROGRESS_PATH).mtimeMs; } catch { return NaN; } })()
          || Date.parse(batch.startedAt || '');
        const stale = !Number.isFinite(lastWrite) || (Date.now() - lastWrite) > 10 * 60 * 1000;
        if (stale || (batch.total && batch.done >= batch.total)) batch = { ...batch, running: false, stalled: true };
      }
      // Lever ships descriptions in its list API, so those count as read too.
      const readableFilter = { browsable: true, source: READABLE_SOURCES };
      const readable = count(readableFilter);
      const read = count({ ...readableFilter, hasDesc: true });
      const teams = count({ ...readableFilter, hasTeam: true });
      return json(res, 200, {
        batch,
        batchRunning: !!enrichChild || !!batch?.running,
        scanRunning: !!scanChild,
        lastAutoScanAt,
        coverage: { readable, read, teams },
        auto: AUTO,
      });
    }

    // ── applying ────────────────────────────────────────────────────────
    //
    // Three endpoints, and the split between them is the architecture: the
    // SERVER decides everything (which resume, how it is worded, what every
    // answer is) and the browser only does what a browser can do (be signed in,
    // and type). None of this launches a browser of its own — /api/apply hands
    // the URL to the Chrome he is already using, so the tab arrives inside his
    // session with his employer accounts already in it.
    //
    // /api/apply     build the tailored resume, open the posting in his Chrome
    // /api/plan      given the fields found on the page, say what to do with each
    // /api/apply-resume  the PDF itself, so the extension can attach it
    // The extension needs the token before it can call anything, and it cannot
    // be given one by hand on every install without being annoying enough that
    // he stops using it. So an extension may read it; a WEB PAGE may not, which
    // is the boundary that matters.
    if (url.pathname === '/api/apply-token') {
      const origin = String(req.headers.origin || '');
      res.setHeader('access-control-allow-origin', origin || '*');
      res.setHeader('access-control-allow-private-network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (!callerMayHaveToken(req)) return json(res, 403, { error: 'extensions only' });
      noteExtension(null, null);
      console.log(`  extension connected${origin ? ` (${origin.slice(0, 48)})` : ''}`);
      return json(res, 200, { token: IMPORT_TOKEN, port: PORT });
    }

    if (url.pathname === '/api/apply' || url.pathname === '/api/plan'
      || url.pathname === '/api/apply-resume' || url.pathname === '/api/apply-current'
      || url.pathname === '/api/apply-status' || url.pathname === '/api/extension'
      || url.pathname === '/api/choose' || url.pathname === '/api/filled'
      || url.pathname === '/api/apply-page' || url.pathname === '/api/panel' || url.pathname === '/api/panel-retailor'
      || url.pathname === '/api/cover-letter' || url.pathname === '/api/cover-letter-pdf'
      || url.pathname === '/api/answer' || url.pathname === '/api/answer-snapshot') {
      // The extension calls these from the employer's origin, so the same CORS
      // and token gate the assisted import already uses applies here.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-jarvis-token');
      res.setHeader('access-control-allow-private-network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      // The dashboard page itself is same-origin and already trusted; a call
      // from an employer's page is not, and must carry the token.
      const sameOrigin = !req.headers.origin || req.headers.origin === `http://localhost:${PORT}`;
      if (!sameOrigin && (!IMPORT_TOKEN || req.headers['x-jarvis-token'] !== IMPORT_TOKEN)) {
        return json(res, 403, { error: 'bad token' });
      }

      if (url.pathname === '/api/apply' && req.method === 'POST') {
        const body = await readBody(req);
        const { id } = body;
        const job = getJob(id);
        if (!job) return json(res, 404, { error: 'unknown job' });
        const key = String(id);

        // DON'T TAILOR A RESUME FOR A POSTING THAT IS GONE.
        //
        // Two of the five jobs in his queue answer HTTP 404 — Amazon's "Sorry,
        // the job you're looking for isn't available." Pressing Apply on one
        // opened a tab and spent up to two minutes building a tailored PDF
        // before he could see the posting was dead.
        //
        // Only a definitive 404/410 stops it. A network failure, a timeout or a
        // 403 (Tesla answers automated visits that way) all proceed, because a
        // false "expired" is the expensive error here — it makes him miss a
        // real job. This check can cost him time, never an opportunity.
        //
        // His queue is NOT edited. Whether a dead posting stays in it is his
        // call, and this endpoint has no business making it for him.
        const gone = await definitelyGone(job.url).catch(() => false);
        if (gone) {
          return json(res, 409, {
            error: `this posting is gone — ${gone}. Nothing was tailored and no tab was opened. `
              + 'If you think that is wrong, open it yourself; otherwise take it out of the queue.',
            gone: true,
          });
        }

        // THE TAB GOES FIRST AND THE ANSWER COMES BACK IMMEDIATELY.
        //
        // Tailoring takes a minute or two — 141s measured on a live Applied
        // Materials posting including the retry pass and the PDF render. The
        // first version awaited all of that before replying, so the tab opened
        // in one second and he was not told for one hundred and forty. He
        // reasonably concluded nothing was happening.
        //
        // Now the request returns as soon as the tab is open, tailoring runs on
        // behind it, and the dashboard polls /api/apply-status. That is also
        // what makes it safe to walk to the next posting mid-build: each
        // application is tracked by its own job id rather than by "the last one".
        // THE EXTENSION OPENS THE TAB WHEN IT CAN. The dashboard page asks the
        // extension first (an armed tab, no press needed) and only then calls
        // here with `open: false`; the chrome.exe path is the fallback for a
        // browser without the extension.
        const opened = body.open === false
          ? { ok: true, why: 'opened by the extension, armed' }
          : await openInChrome(job.url);

        // A SECOND PRESS IS NOT A SECOND BUILD. He comes back to a fill that
        // timed out and presses Apply again; the resume already written (or
        // still being written) for this posting is the one. Otherwise build —
        // which itself reuses a kept build from before a restart.
        // Deliberately not awaited — see startResumeBuild.
        const had = APPLY_CONTEXT.get(key);
        let ctx;
        if (had && (had.status === 'ready' || had.status === 'tailoring')) {
          ctx = had;
          ctx.chrome = opened;
          LAST_APPLY = key;
        } else {
          ctx = startResumeBuild(job, key, { chrome: opened });
        }

        return json(res, 200, {
          id, url: job.url, status: ctx.status,
          reused: ctx.reused || (had === ctx ? { from: key, sameJob: true, inMemory: true } : null),
          chrome: opened, token: IMPORT_TOKEN, submit: false,
        });
      }

      // How the resume for one application is coming along. Keyed by job id, so
      // three postings can be in flight at once and each reports its own.
      // Has the extension ever spoken to us, and is the copy Chrome loaded current?
      if (url.pathname === '/api/extension' && req.method === 'GET') {
        // WHAT CHROME HAS LOADED, WITHOUT WAITING FOR A CLICK.
        //
        // Every other staleness check needs the extension to contact us first,
        // which needs a toolbar click. Someone who is not clicking never finds
        // out — and that is exactly the person whose copy is out of date.
        // Reading Chrome's own registry answers it passively.
        const chrome = loadedExtension(path.join(HERE, 'extension'));
        return json(res, 200, {
          ...EXTENSION,
          expected: EXPECTED_EXTENSION,
          stale: EXTENSION.version ? extensionIsStale(EXTENSION.version) : null,
          chrome: chrome && {
            ...chrome,
            // `version` is absent on some Chrome builds, so staleness is decided
            // on the signal that is always there: whether Chrome has re-read the
            // directory since it first loaded it.
            stale: chrome.version
              ? extensionIsStale(chrome.version)
              : chrome.neverReloaded,
          },
        });
      }

      if (url.pathname === '/api/apply-status' && req.method === 'GET') {
        const key = String(url.searchParams.get('id') ?? LAST_APPLY);
        const ctx = APPLY_CONTEXT.get(key);
        if (!ctx) return json(res, 404, { error: 'no application started for this posting' });
        return json(res, 200, {
          id: key,
          status: ctx.status,
          company: ctx.company,
          title: ctx.title,
          family: ctx.family || null,
          resume: ctx.pdfPath,
          auditCopy: ctx.auditPath || null,
          tailoring: ctx.tailoring,
          // Set when an earlier build was handed back instead of building again.
          reused: ctx.reused || null,
          // The stage the build is at, so the card can say more than "writing".
          phase: ctx.phase || null,
          chrome: ctx.chrome,
          error: ctx.error,
          problems: ctx.problems || null,
          submit: false,
        });
      }

      // Which application is in progress. The extension asks this instead of
      // trying to work out a job id from the tab's URL, which does not survive
      // the redirect chain from a posting to the ATS form it lives on.
      if (url.pathname === '/api/apply-current' && req.method === 'GET') {
        if (!LAST_APPLY || !APPLY_CONTEXT.has(LAST_APPLY)) {
          return json(res, 404, { error: 'nothing in progress — press Apply on the dashboard first' });
        }
        const ctx = APPLY_CONTEXT.get(LAST_APPLY);
        return json(res, 200, { id: LAST_APPLY, ...ctx, submit: false });
      }

      // WHICH OPTION, decided here rather than in the page.
      //
      // A combobox hides its options until it is opened, so when the plan is
      // made they do not exist yet and `chooseOption` never sees them. The
      // extension was left doing its own string matching, and measured on a
      // live Torc Robotics form it failed three fields in a row:
      //
      //   Country        nothing matched "United States of America"
      //   Degree         nothing matched "Bachelor of Science"
      //   Veteran Status nothing matched "I am not a Veteran."
      //
      // `chooseOption` has a rule for that last one — "not a veteran" is "not a
      // PROTECTED veteran" — and rules for degree levels, dial codes and states
      // besides. None of it was reachable. So the extension now opens the list,
      // reports what it sees, and asks; the judgement stays in one place, which
      // is the whole reason the plan is built server-side to begin with.
      if (url.pathname === '/api/choose' && req.method === 'POST') {
        const body = await readBody(req);
        const want = String(body.want ?? '');
        const options = Array.isArray(body.options) ? body.options.map((o) => String(o)) : [];
        if (!want || !options.length) return json(res, 400, { error: 'want and options are required' });
        let index = chooseOption(want, options);
        if (index == null || index < 0) index = chooseBand(want, options);
        return json(res, 200, {
          index: index == null ? -1 : index,
          value: index >= 0 ? options[index] : null,
        });
      }

      // WHAT THE EXTENSION ACTUALLY DID, written where he will look for it.
      //
      // The extension could ask for a plan, a resume and an option — and had no
      // way to say what happened. So the flow he actually uses (click Jarvis on
      // a form) left NO record: nothing in Review & Send, no list of what was
      // filled, no list of what it could not answer. All of that existed for
      // ninety seconds in an on-page panel and died with the tab.
      //
      // The Playwright driver has always written this record, which is why
      // Review & Send works at all — for applications done the other way. Same
      // shape here on purpose: one record, one reader, no second format to keep
      // in step.
      if (url.pathname === '/api/filled' && req.method === 'POST') {
        const body = await readBody(req);
        const pageUrl = String(body.pageUrl || '');
        const picked = body.id
          ? { id: String(body.id), ctx: APPLY_CONTEXT.get(String(body.id)) }
          : contextForPage(pageUrl);
        // No prepared application? Fall back to the posting this page belongs
        // to. He can click Jarvis on a form he opened himself, and that run is
        // worth recording too.
        let job = (picked.id && getJob(picked.id)) || findByUrl(pageUrl) || null;

        // A POSTING HE FOUND HIMSELF STILL DESERVES A RECORD.
        //
        // `--url` applications — a link someone sent him, a company not in
        // portals.yml — are the ones he cares most about, and they are exactly
        // the ones the store has never seen. Reporting "no job matches this
        // page" and dropping the run means the tracker is complete for
        // everything except the applications that mattered most.
        //
        // Only when the fill actually did something, so clicking Jarvis on a
        // stray page cannot seed the store with junk. The title comes from the
        // ATS API rather than from us: `upsertJobs` requires a real one, and
        // inventing a title is not something this project does.
        if (!job && (Number(body.filled) || 0) > 0 && /^https?:/i.test(pageUrl)) {
          const meta = await fetchPostingMeta(pageUrl).catch(() => null);
          if (meta?.title) {
            upsertJobs([{
              url: pageUrl,
              title: meta.title,
              company: meta.company || '',
              source: `${meta.ats}-manual`,
            }]);
            job = findByUrl(pageUrl) || null;
          }
        }
        // Every run's own report, kept (answer-log.mjs `report` rows).
        try { logReport({ pageUrl, job, body }); } catch { /* a record, never the response */ }
        if (!job) return json(res, 200, { recorded: false, why: 'no job matches this page, and its title could not be read from the ATS' });

        // THE ONE PLACE A POSTING CAN HONESTLY BE RETIRED.
        //
        // liveness-sweep deliberately refuses to retire on page wording,
        // because a headless browser cannot tell a dead Workday posting from
        // one Workday declined to render for a bot — measured, and wrong in
        // both directions on the same run (F-250: KLA genuinely 404, Jabil
        // fully alive, identical headless verdict).
        //
        // This verdict has none of that doubt. It comes from the browser he is
        // signed into, looking at the page as he sees it. So the evidence the
        // sweep cannot produce arrives here instead, for free, every time he
        // clicks Jarvis on something that turns out to be gone.
        //
        // The row is not hidden from his own lists — goneAt only drops it from
        // the deck — and the ✕ gone badge explains itself (F-241).
        //
        // FROM THE POSTING'S OWN PAGE ONLY. An armed tab carries its
        // application id across pages; if he then navigates that tab to some
        // OTHER dead posting, the run reports "gone" with the first job's id.
        // The verdict counts only when the page it came from resolves to the
        // job being retired.
        const seenOn = String(body.seenOn || pageUrl || '');
        const fromOwnPage = !body.id || (jobForPage(seenOn)?.id === job.id);
        let goneNote = '';
        if (body.postingGone && !job.goneAt && fromOwnPage) {
          // THE PAGE CAN BE DEAD WHILE THE JOB IS LIVE. Form Energy runs its
          // Ashby board on formenergy.com; every jobs.ashbyhq.com/formenergy
          // URL renders "Page not found" while the board API lists the job.
          // His browser's verdict is about the PAGE; the ATS API is asked
          // about the JOB, and only when it agrees (or cannot say) is the
          // posting retired. A false "gone" is the expensive error.
          const api = await checkLivenessViaApi(seenOn || job.url).catch(() => null);
          if (api?.result === 'active') {
            goneNote = `the page at this address is dead but the ATS still lists the job (${api.reason}) — find it on the company's own careers site`;
            console.log(`  NOT retired → ${job.company} — ${job.title}\n    his browser saw: "${String(body.postingGone).slice(0, 80)}" but ${api.reason}`);
          } else {
            updateJob(job.id, { goneAt: new Date().toISOString() }, { rederive: true });
            console.log(`  gone → ${job.company} — ${job.title}\n    his browser saw: "${String(body.postingGone).slice(0, 80)}"`);
          }
        }
        // "You have already applied" on the posting's own page, in his browser.
        // The employer's word for it; the tracker catches up.
        if (body.alreadyApplied && fromOwnPage && job.status !== 'applied') {
          updateJob(job.id, { status: 'applied' });
          console.log(`  already applied → ${job.company} — ${job.title}`);
        }

        // HE PRESSED SUBMIT AND THE ATS SAID SO. The tracker follows him; he
        // does not follow the tracker.
        //
        // This is the fix for the worst number in the reckoning of 2026-09-10:
        // 96 applications prepared, 5 recorded, 0 outcomes ever — because the
        // only way a job became `applied` was him typing it, and he works in
        // the browser. The extension has detected the confirmation page all
        // along (it disarms the tab on it, F-446); it simply never said so
        // here.
        //
        // DELIBERATELY NOT gated on `fromOwnPage`, unlike the two verdicts
        // above: a confirmation page is by definition not the posting's page —
        // it is /confirmation, /thank-you, the ATS's own success screen. The
        // id is trustworthy anyway, because the tab that shows a confirmation
        // is the tab that submitted, and it disarms the moment it sees one.
        //
        // The evidence is kept on the row (`submittedSaid`) so a wrong verdict
        // can be traced to the sentence that caused it, and corrected. A false
        // positive here means he stops applying to a job he never applied to,
        // which is why `SUBMITTED_RE` is conservative and has its own corpus
        // (submitted.test.mjs).
        const submittedSaid = String(body.submitted || '').slice(0, 200);
        const newlySubmitted = submittedSaid && job.status !== 'applied';
        if (newlySubmitted) {
          updateJob(job.id, { status: 'applied' });
          console.log(`  SUBMITTED → ${job.company} — ${job.title}\n    the page said: "${submittedSaid.slice(0, 90)}"`);
        }

        const list = (v) => (Array.isArray(v) ? v.slice(0, 60) : []);
        updateJob(job.id, {
          apply: {
            at: new Date().toISOString(),
            url: pageUrl || job.url,
            filled: Number(body.filled) || 0,
            // TICKED BOXES ARE WORK TOO, and the badge already counted them.
            //
            // The extension has always reported `checked` — consent boxes, EEO
            // radios, AI-screening acknowledgements — and the toolbar badge
            // shows `filled + checked`. This record kept only `filled`, so a run
            // that filled 3 fields and ticked 8 boxes showed 11 on the badge and
            // 3 in Review & Send. The number he was shown and the number kept
            // disagreed, and the missing half is the consent half.
            checked: Number(body.checked) || 0,
            resumeUploaded: !!body.uploaded,
            reachedReview: !!body.reachedReview,
            // STORED as {label, why} — the shape /api/prepared reads and then
            // maps to {l,w} for the page. Writing the READER'S shape here put
            // `undefined` in both fields and rendered two blank rows under
            // "needs 2", which looks like the engine forgot what it could not
            // answer rather than like a mismatched key.
            needsInput: list(body.unanswered).map((u) => (typeof u === 'string'
              ? { label: u.replace(/^step \d+: /, ''), why: '' }
              : { label: String(u.label || ''), why: String(u.why || '') })),
            review: list(body.review),
            // WHAT WAS WRITTEN FOR HIM ON THIS RUN, so Review & Send knows.
            //
            // These are the only fields whose CONTENT he has to read before he
            // presses Submit — two hundred words in his voice, about his own
            // work, going to a human. The panel says so on the page, but the
            // page is gone by the time he is on this board, and a record that
            // does not mention them lets an AI-written answer reach a company
            // without his having read it.
            written: list(body.written).map((w) => ({
              label: String(w?.label || '').slice(0, 160),
              words: Number(w?.words) || 0,
              problems: list(w?.problems).map((x) => String(x).slice(0, 200)).slice(0, 4),
            })),
            skipped: Number(body.skipped) || 0,
            // The page's own words about why it would not move on, kept so the
            // reason survives the tab that produced it.
            stoppedBecause: String(goneNote || body.stoppedBecause || '').slice(0, 400),
            // WHEN HE SENT IT, AND WHAT THE PAGE SAID. `apply.at` is when the
            // engine last filled the form, which is not the same event and
            // never was — that ambiguity is half of why the funnel could not be
            // measured. These two only ever appear on an application that was
            // actually sent, and a later run never erases them: this record is
            // written whole on every report, so evidence that is not carried
            // forward is evidence deleted.
            ...(submittedSaid
              ? { submittedAt: new Date().toISOString(), submittedSaid }
              : (job.apply?.submittedAt
                ? { submittedAt: job.apply.submittedAt, submittedSaid: job.apply.submittedSaid || '' }
                : {})),
          },
        });
        return json(res, 200, {
          recorded: true,
          job: job.id,
          ...(submittedSaid ? { submitted: true, status: 'applied' } : {}),
          ...(goneNote ? { note: goneNote } : {}),
        });
      }

      // THE PAGE HE IS STANDING ON, as the extension read it.
      //
      // Until now a resume could only be tailored for a posting the SCANNER had
      // recorded. He arms the extension on whatever page he is on — a link
      // someone sent him, a company not in portals.yml — and those, the ones he
      // cares most about, were exactly the ones told "this page is not a posting
      // in your store, so there is nothing to tailor from" and given no resume.
      //
      // The extension now reads the posting off the page (the JSON-LD
      // JobPosting most ATSes ship; the description block where they do not)
      // and hands it here. This resolves it to a stored job — recording it when
      // the store has never seen it — starts the tailored resume, and answers
      // with the id the TAB carries from then on. That id, not URL guesswork, is
      // what /api/plan and /api/apply-resume are given for the rest of the walk,
      // which is what lets a Workday form on a host that never names the
      // employer still get the employer's resume.
      //
      // WHAT THIS DOES NOT DO. It does not turn the page's words into claims.
      // The description is INPUT to tailoring, and the guard in
      // resume-tailor.mjs still refuses any rewrite that uses a word not in
      // cv.md. A page can change which of his true sentences are emphasised,
      // never what they say. And the title is the page's own markup, never
      // invented: with no title and no answer from the ATS there is nothing
      // honest to record, and it says so.
      if (url.pathname === '/api/apply-page' && req.method === 'POST') {
        const body = await readBody(req);
        const pageUrl = String(body.pageUrl || '');
        if (!/^https?:/i.test(pageUrl)) return json(res, 400, { error: 'pageUrl is required' });
        const posting = body.posting && typeof body.posting === 'object' ? body.posting : {};
        const tidy = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
        const title = tidy(posting.title, 200);
        const rawCompany = tidy(posting.company, 120);
        const company = NOT_A_COMPANY_RE.test(rawCompany) ? '' : rawCompany;
        const location = tidy(posting.location, 120);
        const description = String(posting.description || '').replace(/\r/g, '').trim().slice(0, MAX_PAGE_JD_CHARS);
        const postingUrl = /^https?:/i.test(String(posting.url || '')) ? String(posting.url).slice(0, 2000) : '';

        // 1. Already in the store? The posting's own canonical URL is tried too —
        //    a Greenhouse form at /jobs/123#app names its posting as /jobs/123.
        let job = jobForPage(pageUrl) || (postingUrl ? jobForPage(postingUrl) : null)
          || jobByRequisition(pageUrl) || (postingUrl ? jobByRequisition(postingUrl) : null);
        let recorded = false;

        // 1b. THE SAME JOB, SEEN AGAIN ON ITS ATS. A company site's posting
        //     links to its Lever or Greenhouse copy; the tab already carries
        //     the first, and the second has the same title at the same
        //     employer. Recording it twice would split one application across
        //     two rows and start a second resume build.
        //     A trailing " - Boise", " (Remote)" or ", Idaho" is dropped before
        //     comparing — a company site says "Manufacturing Engineer I" and its
        //     Lever copy "Manufacturing Engineer I - Boise". Never a prefix
        //     match: "Manufacturing Engineer" is not "Manufacturing Engineering
        //     Manager", and the id this decides is the resume that attaches.
        const bare = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const core = (v) => bare(String(v || '').replace(/\s+[-–—|(,].*$/, ''));
        const sameTitle = (a, b) => !!bare(a) && !!bare(b) && (bare(a) === bare(b) || core(a) === core(b));
        // "Eaton" is "Eaton Corporation"; "Micron" is "Micron Technology". A
        // prefix is enough for the COMPANY once the title already agrees.
        const sameCompany = (a, b) => !bare(a) || !bare(b) || bare(a) === bare(b) || bare(a).startsWith(bare(b)) || bare(b).startsWith(bare(a));
        if (!job && body.currentId && title) {
          const current = getJob(String(body.currentId));
          if (current && sameTitle(current.title, title) && sameCompany(current.company, company)) {
            job = current;
          }
        }

        // 2. Not in the store, but the page says what it is — and says it in a
        //    way worth believing. Recorded under the URL the posting names for
        //    itself when it names one.
        if (!job && pageReadPostingIsRecordable(posting, title, description)) {
          const at = postingUrl || pageUrl;
          upsertJobs([{ url: at, title, company, location, description, source: 'extension' }]);
          job = findByUrl(at) || null;
          recorded = !!job;
        }

        // 3. Still nothing: a bare form on an ATS whose page carries no posting
        //    markup. Ask the ATS API for the title, exactly as /api/filled does.
        if (!job) {
          const meta = await fetchPostingMeta(pageUrl).catch(() => null);
          if (meta?.title) {
            upsertJobs([{ url: pageUrl, title: meta.title, company: meta.company || '', source: `${meta.ats}-manual` }]);
            job = findByUrl(pageUrl) || null;
            recorded = !!job;
          }
        }
        if (!job) {
          return json(res, 404, {
            error: 'this page does not name a job — no posting in its markup, and the ATS did not answer. Nothing to tailor from.',
          });
        }

        // 4. A stored posting with no body, on a page that carries one: keep
        //    it, so tailoring has something to write towards. Only when the
        //    store has NOTHING — a page read never overwrites the scanner's copy.
        const id = String(job.id);
        const hadBody = !!(getDescription(id) || '').trim();
        if (!hadBody && description.length >= MIN_PAGE_JD_CHARS) {
          updateJob(id, { description }, { rederive: true });
        }
        const hasBody = hadBody || description.length >= MIN_PAGE_JD_CHARS;

        // 5. One build per posting, and a page click never becomes "the current
        //    application" — the same guards as /api/plan. The one exception: a
        //    build that ran WITHOUT a description, on a posting that now has
        //    one, is worth doing again. Never while one is still running.
        let ctx = APPLY_CONTEXT.get(id);
        if (!ctx || (ctx.status !== 'tailoring' && !ctx.hadJd && hasBody)) {
          ctx = startResumeBuild(job, id, { makeCurrent: false });
        }
        noteExtension(body.extensionVersion, pageUrl);
        return json(res, 200, {
          id,
          status: ctx.status,
          company: ctx.company || job.company || '',
          title: ctx.title || job.title || '',
          recorded,
          tailored: hasBody,
          submit: false,
        });
      }

      if (url.pathname === '/api/plan' && req.method === 'POST') {
        const body = await readBody(req);
        const fields = body.fields;
        // The extension sends the page it is on; that decides which application
        // this is, not whichever one happened to finish last.
        const picked = body.id
          ? { id: String(body.id), ctx: APPLY_CONTEXT.get(String(body.id)), matched: 'id' }
          : contextForPage(body.pageUrl);
        let id = picked.id;
        let ctx = picked.ctx;

        // THE TAB'S OWN ID, after a dashboard restart emptied the contexts.
        //
        // An armed tab carries its application id across every page of the
        // walk (F-306). If this server restarted while he was on screen three,
        // the id still names a real posting in the store, and building for it
        // is the honest answer — "I do not know what job this is" is not true.
        if (!ctx && body.id) {
          const known = getJob(String(body.id));
          if (known) {
            id = String(known.id);
            ctx = startResumeBuild(known, id, { makeCurrent: false });
            picked.matched = 'id';
          }
        }

        // ONE CLICK IS THE WHOLE INTERFACE, so the click starts the resume.
        //
        // Until now the only two ways to begin tailoring were the dashboard's
        // Apply button and /api/apply-resume — and the second is requested ONLY
        // when the plan contains an `upload` action, which needs a file input on
        // the page. A Workday application puts the upload on screen two, so on
        // Application Questions, EEO, Voluntary Disclosures and Review there is
        // no file input, no request, and no build could ever start. He clicked
        // Jarvis on the questions step and was told to go and press Apply on the
        // dashboard, which is the one thing the button was supposed to spare him.
        //
        // /api/plan is the request the extension makes on EVERY step, so this is
        // where a build can begin early enough to be finished by the time an
        // upload field appears. It returns immediately; the tailoring runs
        // behind the fill.
        //
        // Guarded three ways, each for a reason:
        //   - only when nothing is already matched, or the match was a fallback
        //     (a guess) — a real in-flight application is never disturbed;
        //   - `APPLY_CONTEXT.get(...) ||` first, because the extension injects
        //     into EVERY frame and plans EVERY step, and each build shells the
        //     tailoring CLI. One posting, one build;
        //   - `makeCurrent: false`, so a page he merely clicked on cannot take
        //     over from the posting he actually pressed Apply for.
        if (!ctx || picked.matched === 'fallback') {
          const onPage = body.pageUrl ? jobForPage(body.pageUrl, { heading: body.heading, pageTitle: body.pageTitle }) : null;
          if (onPage) {
            id = String(onPage.id);
            ctx = APPLY_CONTEXT.get(id) || startResumeBuild(onPage, id, { makeCurrent: false });
            picked.matched = 'page';
          }
        }

        // Deliberately NOT gated on an application being in progress. Answering
        // a form needs the profile and nothing else; only the resume and the
        // work-history titles need to know which posting this is. Refusing to
        // plan without an Apply first made the extension useless on any form he
        // opened himself, which is most of them.
        let profile;
        try { profile = loadApplyProfile(); }
        catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        noteExtension(body.extensionVersion, body.pageUrl);
        const plan = planForm(fields, profile, {
          // The employer this application is for — a question about his history
          // with them is answered from his own work history (F-376).
          //
          // The STORE is asked when there is no live context, which is most of
          // the time: a context lives only for an application started in this
          // process, so after a restart "Have you ever worked at Applied
          // Materials?" went back to the standing No on Applied Materials' own
          // form (measured 2026-09-07). The id already names the posting.
          company: ctx?.company || (id ? getJob(String(id))?.company : null) || null,
          familyKey: ctx?.familyKey || null,
          titles: ctx?.titles || null,
          extensionVersion: body.extensionVersion || null,
          sections: Array.isArray(body.sections) ? body.sections : [],
          // THE POSTING'S OWN TEXT, so a skills table is ranked for the job
          // rather than filled in profile order (F-534). Costs nothing when it
          // is missing: `rankedSkills` falls back to his own order, and the
          // ranking is plain text overlap, no model call. Same source the fit
          // score and the resume tailor already read.
          jd: (id ? (getJob(String(id))?.description || '') : '') || '',
        });
        // EVERY QUESTION IT COULD NOT ANSWER IS WRITTEN DOWN, WITH ITS OPTIONS.
        //
        // His ask, 2026-09-18: "a lot of times its the same stuff cv.md
        // already has but the question phrasing trips up the extension".
        // Reported once and thrown away, a leftover question teaches nothing —
        // the same wording arrives on the next form from the same vendor and
        // nobody remembers. Recorded here rather than in the extension because
        // this is where the OPTIONS are: the page sent them to be planned.
        //
        // Never lets a logging failure cost him a plan.
        try {
          const byLabel = new Map(fields.map((f) => [String(f?.label || ''), f]));
          recordUnanswered((plan.unanswered || []).map((u) => {
            const f = byLabel.get(String(u.label || '')) || {};
            return {
              label: u.label, why: u.why,
              kind: f.type || '', options: Array.isArray(f.options) ? f.options : [],
            };
          }), { company: ctx?.company || (id ? getJob(String(id))?.company : '') || '' });
        } catch { /* the ledger is a diagnostic; it never blocks a run */ }
        // THE WRITTEN QUESTIONS START NOW, NOT WHEN THE FILLER REACHES THEM.
        //
        // Each one is a model call of a minute or two. A form with three of
        // them would spend three waits in a row at the bottom of the walk,
        // with every other field already typed and nothing on screen moving —
        // the same failure the resume build had before it was moved here.
        // Started in parallel with the fill, they are usually ready by the
        // time the page gets to the box.
        //
        // `startAnswer` is idempotent per question: a second step that shows
        // the same box finds it already written, or already writing.
        //
        // A SERIES IS WRITTEN IN ORDER, and only a series. "Give three
        // examples" needs three DIFFERENT pieces of work, and the only way the
        // third can know what the first used is to wait for it. Everything
        // else still starts at once — this chain is per group, not per form.
        {
          // NO POSTING, NO ANSWER — the same rule /api/answer has had since
          // F-479, now on the path that actually produced one.
          //
          // `data/jarvis/answers/no-job-b0786ab1.json`, 2026-09-20T06:25:37Z:
          // a 325-word Opus answer to "Evidence of Excellence", status `ready`,
          // "passed the checks". The plan 51 ms later is the only one in
          // plans.jsonl carrying `"id": null`. Sixty seconds later the same
          // question was written AGAIN, with an id — so the model was paid for
          // twice and the first answer was written against nothing.
          //
          // An answer is an argument for one claim, built from the posting and
          // his files. Without the posting it is a generic paragraph wearing
          // his facts, which is worse than an empty box: the empty box is
          // obviously his to fill, and the paragraph looks finished.
          //
          // Flagged, never silently dropped. The questions stay on the plan
          // with a reason, and the ask-Claude link on each one still works
          // once the tab knows its posting.
          if (!id) {
            for (const e of (plan.essays || [])) {
              e.needsPosting = true;
              e.why = 'Jarvis does not know which posting this tab is for, so nothing was written. '
                + 'Press Jarvis on the posting (or reload this page), then ask again.';
            }
          }
          // The questions stay on the plan either way; this is only what gets
          // WRITTEN. Dropping them from the response would hide the boxes he
          // still has to fill, which is the failure this project treats as
          // worse than a wrong answer.
          const toWrite = id ? (plan.essays || []) : [];
          const startOne = (e, avoid) => {
            const key = answerKeyFor(id || '', e.label);
            const had = answerFor(key) || siblingAnswer(id, e.label, key);
            if (had && (had.status === 'writing' || had.status === 'ready')) return had;
            return startAnswer(key, e.label, {
              job: id ? getJob(String(id)) : null,
              jd: id ? getDescription(String(id)) : null,
              kind: e.kind || null,
              context: e.context || '',
              field: { label: e.label, near: e.context || '', maxLength: e.maxLength || 0, placeholder: e.placeholder || '' },
              stem: e.stem || '',
              seriesIndex: e.seriesIndex || 0,
              seriesOf: e.seriesOf || 0,
              avoid,
            });
          };
          const loose = toWrite.filter((e) => !e.stem);
          for (const e of loose) startOne(e, []);

          // One chain per group, keyed by the stem.
          const groups = new Map();
          for (const e of toWrite.filter((x) => x.stem)) {
            if (!groups.has(e.stem)) groups.set(e.stem, []);
            groups.get(e.stem).push(e);
          }
          for (const members of groups.values()) {
            members.sort((a, b) => (a.seriesIndex || 0) - (b.seriesIndex || 0));
            // Sequential, and never blocking this response: the chain runs
            // behind the fill exactly as a single answer does.
            (async () => {
              const written = [];
              for (const e of members) {
                const entry = startOne(e, written.slice());
                // Wait for THIS one before starting the next, so the next can
                // differ from it. Capped, because a stuck write must not
                // strand the rest of the group unwritten.
                const until = Date.now() + 300000;
                while (entry && entry.status === 'writing' && Date.now() < until) {
                  await new Promise((r) => setTimeout(r, 2000));
                }
                if (entry?.text) written.push(entry.text);
              }
            })().catch(() => { /* a group that fails leaves its boxes on his list */ });
          }
        }

        // THE LAST PLAN, ON DISK. What the page sent and what came back, so a
        // field left for him can be read as the planner saw it — the tab is
        // in his Chrome, and its console is not reachable from here.
        // WHAT THE PAGE SENT AND WHAT CAME BACK, kept for the last few pages.
        //
        // This is how three faults were read off a tab in his Chrome on
        // 2026-09-07 — including a Yes/No dropdown answered with the name of
        // his university. One file was not enough: a walk plans every step, so
        // by the time the run ended the step that went wrong had been
        // overwritten by the one after it. The last twenty are kept, newest
        // oldest first, and nothing here can fail a fill.
        try {
          const log = path.join(STORE_DIR, 'plans.jsonl');
          const entry = JSON.stringify({ at: new Date().toISOString(), pageUrl: body.pageUrl, id: id ?? null, sections: body.sections || [], fields, actions: plan.actions });
          const had = existsSync(log) ? readFileSync(log, 'utf-8').split(NL).filter(Boolean) : [];
          writeFileSync(log, [...had.slice(-19), entry].join(NL) + NL);
        } catch { /* a diagnostic, never the fill */ }
        // EVERY ANSWER, KEPT (his ask, 2026-09-24). plans.jsonl above holds the
        // last twenty and is overwritten as a walk goes; this one is append-only
        // and names the rule behind each answer — see jarvis/answer-log.mjs.
        try {
          let job = null;
          try { job = id ? getJob(String(id)) : null; } catch { job = null; }
          logPlan({ pageUrl: body.pageUrl, job, fields, actions: plan.actions, explain: (label) => whichRule(label, profile) });
        } catch { /* a record, never the fill */ }
        const ready = ctx?.status === 'ready' && ctx.pdfPath;
        // Never hand over a resume built for a DIFFERENT employer. A fallback
        // match means we are guessing, and guessing wrong here attaches the
        // wrong company's resume to a real application.
        const trusted = ready && picked.matched !== 'fallback';
        return json(res, 200, {
          id: id ?? null,
          ...plan,
          resumeUrl: trusted ? `/api/apply-resume?id=${encodeURIComponent(id)}` : null,
          matched: picked.matched,
          // "You already applied to this" on the page itself (F-414).
          applied: id ? appliedBefore(getJob(String(id))) : null,
          // WORDS FOR THE STATE IT IS ACTUALLY IN. "Press Apply on the dashboard
          // first" was the answer to every case, including the two the click can
          // now handle by itself — so it read as a refusal when the truth was
          // either "already working on it" or "I do not know what job this is".
          // NAME THE EMPLOYER, OR SAY NOTHING WHERE ITS NAME WOULD GO. A context
          // built from the page rather than the store can carry no company, and
          // the panel then read "tailored for  — Manufacturing Engineer I" and
          // "writing the resume for  — it will attach…", with a hole in the
          // sentence where the employer belongs (screenshotted 2026-09-07).
          // A GUESS NEVER NAMES A COMPANY AS THIS PAGE'S JOB (F-400).
          //
          // Screenshotted on Agility Robotics' form: "writing the resume for
          // **Micron Technology** — it will attach when the form reaches the
          // upload step". Micron was simply the last application this process
          // had seen, and the page — a Greenhouse embed whose URL names no
          // posting — fell back to it. Nothing wrong would have been ATTACHED
          // (a fallback match is refused below), but the sentence promised the
          // wrong employer's resume on a real form, which is the plainest kind
          // of lie this panel can tell.
          resumeNote: picked.matched === 'fallback'
            ? 'this page does not say which job it is — press Apply on the right posting, or click Jarvis on the posting itself, and the resume for THAT job is the one that attaches'
            : !ctx
            ? 'this page does not say which job it is, and nothing in your store matches it — open the posting itself and click Jarvis there, or attach a resume yourself'
            : ctx.status === 'tailoring'
              ? `writing the resume${ctx.company ? ` for ${ctx.company}` : ''} — it will attach when the form reaches the upload step`
              : ctx.status === 'failed'
                ? `the resume${ctx.company ? ` for ${ctx.company}` : ''} failed to build: ${ctx.error}`
                : trusted
                  ? `tailored for ${[ctx.company, ctx.title].filter(Boolean).join(' — ')}`
                  : `not attaching: the newest resume was built for ${ctx.company || 'another posting'}, and this page does not look like it. Press Apply on the right posting.`,
        });
      }

      // A COVER LETTER FOR THIS POSTING, from his files, in his voice, held to
      // the facts (cover-letter.mjs). Written in the background like a resume;
      // the panel polls until it is ready and shows the text with anything the
      // guard could not clear. Nothing here sends it anywhere.
      // A WRITTEN QUESTION, ANSWERED. "Tell us about a project you are proud
      // of", "why should we hire you", or anything he types himself and asks
      // Claude to take a look at.
      //
      // POST starts it and returns at once; GET polls. Both are the shape the
      // resume and the letter already have, because the page already knows how
      // to wait for those. Nothing here fills anything and nothing submits: the
      // text comes back, the extension types it into the box, and the button
      // stays his.
      if (url.pathname === '/api/answer' && req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        const question = String(body?.question || '').trim().slice(0, 600);
        if (!question) return json(res, 400, { error: 'no question to answer' });
        // The refusal is here as well as in the writer. This route can be
        // called by hand from the panel with any text at all, and a question
        // policy says is not the model's to answer must be refused wherever it
        // arrives — not only where the planner would have caught it.
        if (offLimits(question)) {
          return json(res, 403, { error: 'that question is yours to answer — self-identification, pay, references and background questions are never written for you' });
        }
        // WHICH JOB, CHECKED (2026-09-17). An answer written with no job
        // ("no-job") or with a stale tab id is written against the wrong
        // posting, or none, and nothing said so. A tab with no id is resolved
        // from the page; a page that cannot be tied to a posting stops here;
        // an id whose company the open page never mentions stops here too.
        const page = {
          pageUrl: String(body?.pageUrl || ''), pageTitle: String(body?.pageTitle || ''),
          heading: String(body?.heading || ''), pageText: String(body?.pageText || '').slice(0, 3000),
        };
        // The page outranks the tab's memory — see jobForRequest. A stale
        // binding to a SIBLING posting at the same company used to survive the
        // company check below and write every answer for the wrong job.
        const resolved = jobForRequest(String(body?.id || ''), page);
        const id = resolved ? String(resolved.id) : '';
        if (!id) {
          return json(res, 409, { error: 'Jarvis does not know which job this tab is for, so nothing was written. Press Jarvis on the posting (or reload this page), then ask again.' });
        }
        const job = resolved;
        if (!job) return json(res, 409, { error: 'the job this tab points at is not in the store any more — press Jarvis on the posting again' });
        // A PAGE THAT DOES NOT PRINT THE COMPANY'S NAME IS NOT THE WRONG PAGE.
        //
        // This used to be a 409, and it refused three questions on Atomic
        // Semi's own application form (2026-09-19) — his words, looking at it:
        // *"why tf cant i call claude to answer these questions"*. The form
        // asks him to "join fab2", which is what Atomic Semi call their fab,
        // and the words "Atomic Semi" appear nowhere on it. Hosted forms do
        // this constantly: a Greenhouse or Ashby page, a product name, a
        // careers subdomain.
        //
        // The check it was standing in for — is this tab still pointing at the
        // right posting — is now done properly by `jobForRequest`, which puts
        // the page ahead of the tab's memory whenever the page resolves to a
        // posting of its own. Reaching here means the store does not recognise
        // this page at all, so there is no evidence against the remembered id
        // and refusing costs him the answer for nothing.
        //
        // So it flags instead of dropping, the way everything else here does:
        // the answer is written and carries a line saying which posting it was
        // written for, where he reads it before Submit.
        const unnamed = page.pageUrl && !pageMentionsCompany(job.company, page)
          ? `this page never names ${job.company} — it was written for ${job.company} — ${job.title}, check that is the right posting`
          : '';
        const key = answerKeyFor(id, question);
        const request = String(body?.request || '').trim().slice(0, 600);
        // Its own answer, or the same question already answered for a posting
        // with the same description — unless he asked for a different one.
        const had = answerFor(key) || (!body?.again && !request ? siblingAnswer(id, question, key) : null);
        // Already written, and he has not asked for a different one: hand it
        // straight back rather than spending another model call on it.
        // A fill asks with no note; a revised answer must survive that ask.
        if (had && had.status === 'ready' && !body?.again && (had.request === request || !request)) {
          return json(res, 200, { ok: true, key, ...had, submit: false });
        }
        if (had?.status === 'writing') return json(res, 425, { ok: true, key, status: 'writing', error: 'still writing that answer' });
        // HIS REVISION. A note sent with a rewrite is about the text he just
        // read: that text goes back to the writer with every note so far. A
        // plain "write it again" keeps the notes and drops nothing he said.
        const feedback = [...(Array.isArray(had?.feedback) ? had.feedback : (STALE_FEEDBACK.get(key) || []))];
        // A note is a REVISION only when there is an answer it is about; on a
        // box with nothing written yet it is his request for the first draft.
        const revising = !!(request && body?.again && String(had?.text || '').trim());
        if (revising) feedback.push(request);
        const entry = startAnswer(key, question, {
          previous: revising ? String(had?.text || '') : '',
          feedback: feedback.slice(-6),
          job,
          jd: getDescription(id),
          field: body?.field || null,
          kind: body?.kind || (answerKind(question)?.kind ?? null),
          request,
          context: String(body?.context || '').slice(0, 600),
          // Carried onto the answer rather than refused — see `unnamed` above.
          warn: unnamed,
        });
        return json(res, 202, { ok: true, key, status: entry.status, submit: false });
      }
      // THE FORM AS IT WENT OUT (his ask, 2026-09-24). The extension reads every
      // field as Next or Submit is pressed; answer-log.mjs sets each beside the
      // plan: kept, changed, cleared, you answered, left blank, edited.
      if (url.pathname === '/api/answer-snapshot' && req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        const page = { pageUrl: String(body?.pageUrl || ''), heading: String(body?.heading || ''), pageTitle: String(body?.pageTitle || '') };
        let job = null;
        try { job = jobForRequest(String(body?.id || ''), page); } catch { job = null; }
        const logged = logSnapshot({ pageUrl: page.pageUrl, job, stage: String(body?.stage || 'step'), button: String(body?.button || ''), by: String(body?.by || ''), fields: Array.isArray(body?.fields) ? body.fields : [] });
        return json(res, 200, { ok: true, logged });
      }
      if (url.pathname === '/api/answer' && req.method === 'GET') {
        const question = String(url.searchParams.get('question') || '').trim();
        const id = String(url.searchParams.get('id') || '');
        const key = String(url.searchParams.get('key') || '') || answerKeyFor(id, question);
        const entry = answerFor(key) || (id && question ? siblingAnswer(id, question, key) : null);
        if (!entry) return json(res, 404, { error: 'no answer for that question yet' });
        if (entry.status === 'writing') return json(res, 425, { key, status: 'writing', error: 'still writing that answer' });
        return json(res, 200, { key, ...entry, submit: false });
      }

      if (url.pathname === '/api/cover-letter' && req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        const id = String(body?.id || '');
        const request = String(body?.request || '').trim().slice(0, 600);
        const job = id ? getJob(id) : null;
        if (!job) return json(res, 404, { error: 'unknown job' });
        const had = LETTERS.get(id);
        if (had?.status === 'writing') return json(res, 425, { error: `still writing the letter for ${job.company}` });
        const entry = { status: 'writing', at: new Date().toISOString(), request, text: '', problems: [], notices: [], why: '' };
        LETTERS.set(id, entry);
        try { logRequest({ job, what: 'letter', request, previous: had?.text || '' }); } catch { /* a record, never the letter */ }
        const jd = getDescription(id);
        const ctx = APPLY_CONTEXT.get(id);
        writeCoverLetter(job, { jd, request, resumeLines: ctx?.resumeLines || [] }).then((r) => {
          Object.assign(entry, { status: r.text ? 'ready' : 'failed', text: r.text, problems: r.problems, notices: r.notices, why: r.why, error: r.text ? null : r.why });
          if (r.text) {
            try { mkdirSync(LETTER_DIR, { recursive: true }); writeFileSync(path.join(LETTER_DIR, `${id}.md`), `${r.text}\n`); } catch { /* memory holds it */ }
            // AND AS A PAGE, so it can be attached rather than pasted (F-410).
            // The text stays the record; the PDF is a rendering of it, made
            // here so it is ready the moment a form asks for a file.
            renderLetterFile(id, job, r.text).then((made) => {
              if (made) { entry.pdfPath = made.path; entry.pdfName = path.basename(made.path); }
            }).catch(() => { /* the text is still his to paste */ });
          }
          console.log(`  letter → ${job.company} — ${job.title}: ${r.why}`);
        }).catch((e) => {
          Object.assign(entry, { status: 'failed', error: String(e?.message || e) });
        });
        return json(res, 202, { ok: true, id, status: 'writing', submit: false });
      }
      // THE LETTER AS A FILE. Same body, laid out on his letterhead. A form
      // with a cover-letter upload slot gets this; a form with a text box
      // still gets the text.
      if (url.pathname === '/api/cover-letter-pdf' && req.method === 'GET') {
        const asked = String(url.searchParams.get('id') || '');
        // The tab's id first, the page second — the same order as the resume,
        // so a form the extension found by itself can have a letter too.
        const onPage = asked ? null : jobForPage(url.searchParams.get('pageUrl') || '', {
          heading: url.searchParams.get('heading') || '', pageTitle: url.searchParams.get('pageTitle') || '',
        });
        const id = asked || (onPage ? String(onPage.id) : '');
        const job = id ? getJob(id) : null;
        if (!job) return json(res, 404, { error: 'this page is not a posting in your store, so there is nothing to write a letter from' });
        let entry = LETTERS.get(id) || null;
        let text = entry?.text || '';
        if (!text) {
          const file = path.join(LETTER_DIR, `${id}.md`);
          if (existsSync(file)) text = readFileSync(file, 'utf-8').trim();
        }
        // A FORM ASKED FOR IT, SO IT GETS WRITTEN (F-410). The letter used to
        // exist only if he had pressed for one in the panel, which meant a
        // form with a cover-letter slot found nothing to attach. `write=1` is
        // the filler saying "this page has a slot for one"; it starts the
        // letter and answers 425 while it is written, exactly as the resume
        // does, and the filler waits the same way.
        if (!text && !entry && url.searchParams.get('write') === '1') {
          entry = { status: 'writing', at: new Date().toISOString(), request: '', text: '', problems: [], notices: [], why: '' };
          LETTERS.set(id, entry);
          const ctx0 = APPLY_CONTEXT.get(id);
          writeCoverLetter(job, { jd: getDescription(id), request: '', resumeLines: ctx0?.resumeLines || [] }).then(async (r) => {
            Object.assign(entry, { status: r.text ? 'ready' : 'failed', text: r.text, problems: r.problems, notices: r.notices, why: r.why, error: r.text ? null : r.why });
            if (r.text) {
              try { mkdirSync(LETTER_DIR, { recursive: true }); writeFileSync(path.join(LETTER_DIR, `${id}.md`), `${r.text}\n`); } catch { /* memory holds it */ }
              const made2 = await renderLetterFile(id, job, r.text).catch(() => null);
              if (made2) { entry.pdfPath = made2.path; entry.pdfName = path.basename(made2.path); }
            }
            console.log(`  letter → ${job.company} — ${job.title}: ${r.why} (the form asked for one)`);
          }).catch((e) => { Object.assign(entry, { status: 'failed', error: String(e?.message || e) }); });
          return json(res, 425, { error: `writing the cover letter for ${job.company} — it attaches when it is ready` });
        }
        if (entry?.status === 'writing') return json(res, 425, { error: `still writing the letter for ${job.company}` });
        if (!text) return json(res, 404, { error: 'no letter for this job yet — ask for one in the panel first' });
        let made = entry?.pdfPath && existsSync(entry.pdfPath) ? { path: entry.pdfPath } : null;
        if (!made) {
          made = await renderLetterFile(id, job, text).catch(() => null);
          if (made && entry) { entry.pdfPath = made.path; entry.pdfName = path.basename(made.path); }
        }
        if (!made) return json(res, 500, { error: 'the letter could not be rendered' });
        const body = readFileSync(made.path);
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': body.length,
          'content-disposition': contentDisposition(url.searchParams.get('inline') === '1' ? 'inline' : 'attachment', path.basename(made.path)),
        });
        return res.end(body);
      }
      if (url.pathname === '/api/cover-letter' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '');
        let entry = LETTERS.get(id) || null;
        if (!entry && id) {
          // A letter written before the dashboard restarted is on disk.
          const file = path.join(LETTER_DIR, `${id}.md`);
          if (existsSync(file)) entry = { status: 'ready', at: statSync(file).mtime.toISOString(), request: '', text: readFileSync(file, 'utf-8').trim(), problems: [], notices: ['written before the dashboard last started; its checks were not kept'], why: 'from disk' };
        }
        if (!entry) return json(res, 404, { error: 'no letter for this job yet' });
        if (entry.status === 'writing') return json(res, 425, { error: 'still writing the letter' });
        return json(res, 200, { id, ...entry, submit: false });
      }

      // "CHANGE THE RESUME": his note, typed in the side panel, and the resume
      // for that posting written again with it. The note steers selection and
      // wording inside the same rules as every build — the guard that refuses
      // a fact not in his approved wording is unchanged — so it can emphasise,
      // reorder and shorten, never invent. The build is asynchronous; the panel
      // polls /api/apply-resume until it is ready, like any other build.
      if (url.pathname === '/api/panel-retailor' && req.method === 'POST') {
        const body = await readBody(req).catch(() => null);
        const id = String(body?.id || '');
        const request = String(body?.request || '').trim();
        const job = id ? getJob(id) : null;
        if (!job) return json(res, 404, { error: 'unknown job' });
        if (!request) return json(res, 400, { error: 'say what to change' });
        if (request.length > 600) return json(res, 400, { error: 'keep the note under 600 characters' });
        const had = APPLY_CONTEXT.get(id);
        if (had?.status === 'tailoring') return json(res, 425, { error: `still writing the resume for ${had.company} — wait for it, then ask` });
        APPLY_CONTEXT.delete(id);
        try { logRequest({ job, what: 'resume', request }); } catch { /* a record, never the build */ }
        const ctx = startResumeBuild(job, id, { makeCurrent: false, request, reuse: false });
        console.log(`  panel → ${job.company} — ${job.title}: writing again with his note "${request.slice(0, 80)}"`);
        return json(res, 202, { ok: true, id, status: ctx.status, request: ctx.request, submit: false });
      }

      // THE SIDE PANEL'S VIEW OF A PAGE: the posting it is, how well it fits
      // him, and the application this server holds for it. Read-only; the
      // resume itself comes from /api/apply-resume by id.
      if (url.pathname === '/api/panel' && req.method === 'GET') {
        const asked = String(url.searchParams.get('id') || '');
        const pageUrl = url.searchParams.get('pageUrl') || '';
        // `asked` used to win outright, so a tab still holding an earlier
        // posting printed that posting's title, fit and "already applied" over
        // the form he was actually looking at (2026-09-19, two Tesla roles).
        const found = jobForRequest(asked, {
          pageUrl, heading: url.searchParams.get('heading') || '', pageTitle: url.searchParams.get('pageTitle') || '',
        });
        if (!found) return json(res, 404, { error: 'this page is not a posting in your store' });
        const job = getJob(String(found.id), { description: true }) || found;
        const fit = scoreFit(job, getProfile());
        const skills = (fit.breakdown || []).find((d) => d.dimension === 'skills' && d.judged) || {};
        const ctx = APPLY_CONTEXT.get(String(job.id)) || null;
        const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
        return json(res, 200, {
          job: {
            ...pick(job, ['id', 'title', 'company', 'location', 'url', 'salary_min', 'salary_max', 'salary_currency', 'salary_interval', 'posted_at', 'status', 'tier', 'level', 'fit_score', 'fit_band', 'fit_band_label', 'has_desc']),
            logo: logoKey(String(job.company || '')) ? `${pageBase(req)}/api/logo?company=${encodeURIComponent(String(job.company))}` : null,
          },
          fit: {
            score: fit.score, band: fit.band, bandLabel: fit.bandLabel, confidence: fit.confidence,
            // The skills line is drawn as chips; the reasons that only repeat it are left out.
            reasons: (fit.reasons || []).filter((r) => !/^(Asks for \d+ of his skills|Also wants)/.test(String(r))).slice(0, 6), blockers: fit.blockers || [],
            skills: { matched: (skills.matched || []).map(skillLabel), missing: (skills.missing || []).map(skillLabel) },
          },
          // Whether he has been here before, so he does not have to remember.
          applied: appliedBefore(job),
          application: ctx ? {
            status: ctx.status, at: ctx.at, family: ctx.family || null, titles: ctx.titles || [],
            tailoring: ctx.tailoring || null, error: ctx.error || null, problems: ctx.problems || null,
            resume: !!(ctx.pdfPath && existsSync(ctx.pdfPath)),
            request: ctx.request || '',
            qa: ctx.qa || null,
          } : null,
          submit: false,
        });
      }

      if (url.pathname === '/api/apply-resume' && req.method === 'GET') {
        const asked = url.searchParams.get('id');
        const picked = asked
          ? { id: asked, ctx: APPLY_CONTEXT.get(String(asked)), matched: 'id' }
          : contextForPage(url.searchParams.get('pageUrl'));
        const pageUrl = url.searchParams.get('pageUrl') || '';
        // Resolve the page to a posting BEFORE deciding, so the decision has
        // everything it needs and lives in one pure function.
        const onPage = (!asked && picked.matched !== 'page')
          ? jobForPage(pageUrl, { heading: url.searchParams.get('heading') || '', pageTitle: url.searchParams.get('pageTitle') || '' })
          : null;
        // The id an armed tab carries names a posting even when no context is
        // left for it (the dashboard restarted mid-walk). Build for THAT
        // posting, never for whatever the page URL happens to resolve to.
        const askedJob = (asked && !picked.ctx) ? getJob(String(asked)) : null;
        const want = resumeTarget({
          asked: !!asked,
          askedFound: !!askedJob,
          matched: picked.matched,
          haveCtx: !!picked.ctx,
          jobFound: !!onPage,
        });

        if (want === 'refuse') {
          return json(res, 409, { error: `this page does not match the application for ${picked.ctx?.company || 'the last posting'} — press Apply on the right posting` });
        }
        if (want === 'none') {
          return json(res, 404, {
            error: pageUrl
              ? 'this page is not a posting in your store, so there is nothing to tailor a resume from — press Apply on the dashboard for the right job'
              : 'no resume built for this job yet — press Apply on the dashboard first',
          });
        }

        // BUILD ONE RATHER THAN REFUSING — the fault he reported as "i havent
        // seen it put in a custom resume at all". He was right: a resume
        // existed only if he had pressed Apply on the DASHBOARD for that exact
        // posting first, so the flow he actually uses — open a form, click the
        // Jarvis button — 404'd here and the run attached nothing.
        //
        // Only reached when the page resolved to a real posting. A page that
        // did not is refused above, never handed the last application's PDF.
        let ctx = picked.ctx;
        // "Build it again" from the panel: a finished build is dropped and
        // started over for the same posting, never for a page-resolved one.
        if (asked && url.searchParams.get('again') === '1' && ctx && ctx.status !== 'tailoring') {
          const target = getJob(String(asked));
          if (target) { APPLY_CONTEXT.delete(String(asked)); ctx = startResumeBuild(target, String(asked), { makeCurrent: false, reuse: false }); }
        }
        if (want === 'build') {
          const target = askedJob || onPage;
          // A build the extension asked for by id never becomes "the current
          // application"; only the dashboard's Apply button does that.
          ctx = APPLY_CONTEXT.get(String(target.id))
            || startResumeBuild(target, String(target.id), { makeCurrent: !askedJob });
        }

        if (ctx?.status === 'tailoring') {
          return json(res, 425, {
            error: `still writing the resume for ${ctx.company} — try again in a moment`,
            phase: ctx.phase || 'starting',
            seconds: Math.round((Date.now() - (ctx.at ? Date.parse(ctx.at) : Date.now())) / 1000),
          });
        }
        if (ctx?.status === 'failed') {
          return json(res, 409, { error: `the resume for ${ctx.company} could not be built: ${ctx.error}` });
        }
        if (!ctx?.pdfPath || !existsSync(ctx.pdfPath)) {
          return json(res, 404, { error: 'no resume built for this job yet — press Apply on the dashboard first' });
        }
        res.writeHead(200, {
          'content-type': 'application/pdf',
          // The name the ATS records is the name in this header. It is the
          // generic one on purpose — a per-posting filename reads as machine-made.
          // `inline` when the panel is SHOWING it: Chrome's PDF viewer reads
          // the Save name from here, which is the whole point (F-412).
          'content-disposition': contentDisposition(url.searchParams.get('inline') === '1' ? 'inline' : 'attachment', path.basename(ctx.pdfPath)),
        });
        return createReadStream(ctx.pdfPath).pipe(res);
      }

      return json(res, 405, { error: 'wrong method for this endpoint' });
    }

    if (url.pathname === '/api/import') {
      // CORS: assisted scans POST here from careers pages in the user's browser.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-jarvis-token');
      // Chrome Private Network Access: public https page → localhost needs this.
      res.setHeader('access-control-allow-private-network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (!IMPORT_TOKEN || req.headers['x-jarvis-token'] !== IMPORT_TOKEN) {
        return json(res, 403, { error: 'bad token' });
      }
      const { company, rows, urlTemplate, sponsors, tier } = await readBody(req);
      if (!company || !Array.isArray(rows)) return json(res, 400, { error: 'need { company, rows }' });
      const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const jobs = rows.map(r => {
        const o = Array.isArray(r)
          ? { title: r[0], idOrUrl: String(r[1] ?? ''), location: r[2] || '', team: r[3] || '' }
          : { title: r.title, idOrUrl: String(r.url || r.id || ''), location: r.location || '', team: r.team || '' };
        if (!o.title) return null;
        const jobUrl = o.idOrUrl.startsWith('http')
          ? o.idOrUrl
          : String(urlTemplate || '').replace('{slug}', slug(o.title)).replace('{id}', o.idOrUrl);
        if (!jobUrl.startsWith('http')) return null;
        return {
          url: jobUrl, title: o.title, company, team: o.team, location: o.location,
          source: 'browser-assist',
          company_meta: { tier: tier || 'tracked', careers_url: '', sponsors_h1b: !!sponsors },
          triage: triage({ title: o.title, description: '', location: o.location, url: o.url }),
        };
      }).filter(Boolean);
      return await withStoreLock(() => {
        const { added, updated } = upsertJobs(jobs);
        recordScan({
          at: new Date().toISOString(), companiesScanned: 1, companiesNeedingAssist: 0,
          postingsCaptured: jobs.length, added, updated,
          perCompany: [{ company, tier: tier || 'tracked', provider: 'browser-assist', status: 'ok', found: jobs.length, note: 'Assisted scan via user browser session (live import).' }],
        });
        return json(res, 200, { imported: jobs.length, added, updated });
      });
    }

    // THE BRIDGE (F-446). A careers page cannot reach localhost at all —
    // Chrome's Private Network Access rule stops a public-origin fetch to
    // 127.0.0.1 at the network layer, before any header this server sends is
    // considered, and it HANGS rather than failing, which is why the endpoint
    // below looked fine for months. The documented fallback (download a file,
    // import it) hits a second ceiling: an origin gets one automatic download
    // and then Chrome blocks the rest for that site.
    //
    // postMessage is subject to neither. This page is served from localhost,
    // so it is same-origin with /api/import-descriptions and can simply POST.
    // The careers page opens it with window.open — a top-level navigation,
    // which PNA does not block either — and posts the harvest across.
    //
    // It renders what happened rather than closing itself, because a silent
    // bridge is how a harvest goes missing without anyone noticing.
    if (req.method === 'GET' && url.pathname === '/assist-bridge') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>Jarvis assist bridge</title>
<style>body{font:14px/1.6 system-ui;margin:2rem;max-width:44rem}code{background:#eee;padding:.1em .3em}pre{background:#f6f6f6;padding:1rem;overflow:auto}</style>
<h1>Assist bridge</h1>
<p id="s">Waiting for a harvest…</p>
<pre id="o"></pre>
<script>
const s = document.getElementById('s'), o = document.getElementById('o');
window.addEventListener('message', async (e) => {
  const d = e.data;
  if (!d || d.kind !== 'jarvis-descriptions' || !Array.isArray(d.rows)) return;
  s.textContent = 'Importing ' + d.rows.length + ' descriptions…';
  try {
    const r = await fetch('/api/import-descriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-token': ${JSON.stringify(IMPORT_TOKEN)} },
      body: JSON.stringify({ rows: d.rows, company: d.company || null, force: !!d.force }),
    });
    const j = await r.json();
    s.textContent = r.ok ? ('Imported ' + j.written + ' of ' + j.total + '.') : 'Import failed.';
    o.textContent = JSON.stringify(j, null, 2);
    if (e.source) e.source.postMessage({ kind: 'jarvis-import-result', result: j, ok: r.ok }, '*');
  } catch (err) {
    s.textContent = 'Import threw: ' + err.message;
    if (e.source) e.source.postMessage({ kind: 'jarvis-import-result', error: err.message }, '*');
  }
});
// AND THE HANDOFF THAT NEEDS NO POPUP. window.open from a careers page is
// blocked without a user gesture, and a synthetic click is not a gesture — so
// the harvest travels in window.name instead, which survives a cross-origin
// navigation of the SAME tab. The careers page stashes the rows there and
// navigates itself here; this reads them and posts them same-origin.
(async () => {
  let payload = null;
  try { payload = window.name ? JSON.parse(window.name) : null; } catch (e) { payload = null; }
  window.name = '';
  // LISTINGS — the third leg (F-454). /api/import has existed since the
  // assisted channel was built, and nothing could reach it: a careers page
  // cannot POST to localhost (F-446). So a gated board could have its bodies
  // read and its dead rows retired, but its jobs could never be DISCOVERED.
  if (payload && payload.kind === 'jarvis-listings' && Array.isArray(payload.rows)) {
    s.textContent = 'Importing ' + payload.rows.length + ' listing(s) for ' + (payload.company || '') + '…';
    try {
      const r = await fetch('/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jarvis-token': ${JSON.stringify(IMPORT_TOKEN)} },
        body: JSON.stringify({
          company: payload.company, rows: payload.rows,
          urlTemplate: payload.urlTemplate || '', sponsors: !!payload.sponsors, tier: payload.tier || 'tracked',
        }),
      });
      const j = await r.json();
      s.textContent = r.ok
        ? ('Imported ' + j.imported + ' listing(s): ' + j.added + ' new, ' + j.updated + ' refreshed.')
        : 'Listing import failed.';
      o.textContent = JSON.stringify(j, null, 2);
      window.__JARVIS_RESULT = { ok: r.ok, result: j };
    } catch (err) { s.textContent = 'Listing import threw: ' + err.message; window.__JARVIS_RESULT = { error: err.message }; }
    return;
  }
  if (payload && payload.kind === 'jarvis-liveness' && Array.isArray(payload.liveReqIds)) {
    s.textContent = 'Checking ' + (payload.company || '') + ' against ' + payload.liveReqIds.length + ' open requisitions…';
    try {
      const r = await fetch('/api/assist-liveness', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jarvis-token': ${JSON.stringify(IMPORT_TOKEN)} },
        body: JSON.stringify({ company: payload.company, liveReqIds: payload.liveReqIds, dryRun: !!payload.dryRun }),
      });
      const j = await r.json();
      s.textContent = (j.refusals && j.refusals.length)
        ? 'Refused — nothing retired.'
        : ('Retired ' + (j.retired || 0) + ' of ' + j.judged + ' judged.');
      o.textContent = JSON.stringify(j, null, 2);
      window.__JARVIS_RESULT = { ok: r.ok, result: j };
    } catch (err) { s.textContent = 'Sweep threw: ' + err.message; window.__JARVIS_RESULT = { error: err.message }; }
    return;
  }
  if (!payload || payload.kind !== 'jarvis-descriptions' || !Array.isArray(payload.rows)) return;
  s.textContent = 'Importing ' + payload.rows.length + ' descriptions handed over from ' + (payload.company || 'a careers page') + '…';
  try {
    const r = await fetch('/api/import-descriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-token': ${JSON.stringify(IMPORT_TOKEN)} },
      body: JSON.stringify({ rows: payload.rows, company: payload.company || null, force: !!payload.force }),
    });
    const j = await r.json();
    // "340 of 215" is not a sentence anyone can read. One requisition can name
    // several store rows (the same posting under two URL spellings), so rows
    // written legitimately exceeds requisitions submitted — say which is which.
    s.textContent = r.ok
      ? ('Wrote ' + j.written + ' row(s) from ' + j.total + ' requisition(s)'
         + (j.newBlocks ? '. ' + j.newBlocks + ' of them hard-block on work authorisation.' : '.'))
      : 'Import failed.';
    o.textContent = JSON.stringify(j, null, 2);
    window.__JARVIS_RESULT = { ok: r.ok, result: j };
  } catch (err) {
    s.textContent = 'Import threw: ' + err.message;
    window.__JARVIS_RESULT = { error: err.message };
  }
})();
if (window.opener) window.opener.postMessage({ kind: 'jarvis-bridge-ready' }, '*');
</script>`);
    }

    // The second half of the assisted channel (F-443). /api/import carries
    // LISTINGS; this carries the BODIES the listing rows could never get,
    // because sites like Tesla return 403 to a server and 200 to his browser.
    // Same CORS contract, same token, same lock — and the write goes through
    // importDescriptions(), which uses enrich.mjs's own rederive path so
    // triage, the visa gate and the fit rescore cannot drift apart.
    if (url.pathname === '/api/import-descriptions') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-jarvis-token');
      res.setHeader('access-control-allow-private-network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (!IMPORT_TOKEN || req.headers['x-jarvis-token'] !== IMPORT_TOKEN) {
        return json(res, 403, { error: 'bad token' });
      }
      const { rows, company, force } = await readBody(req);
      if (!Array.isArray(rows)) return json(res, 400, { error: 'need { rows: [{ url, description }] }' });
      const stats = await importDescriptions(rows, { company: company || null, force: !!force });
      return json(res, 200, {
        total: stats.total, written: stats.written, unmatched: stats.unmatched,
        alreadyRead: stats.alreadyRead, skipped: stats.skipped,
        wrongCompany: stats.wrongCompany, newBlocks: stats.newBlocks,
        reasons: Object.fromEntries(stats.reasons),
      });
    }

    // Assisted liveness (F-447). A board that refuses non-browser HTTP can
    // never be swept by liveness-sweep.mjs, so its dead rows stay live
    // forever — 296 of 1,000 Tesla postings sampled today. The browser can ask
    // the employer's own listing feed once and hand over every requisition
    // still open; anything of theirs not in it is closed.
    //
    // `dryRun` is honoured and the plan comes back either way, because
    // retiring a live posting is the one error this system does not tolerate
    // and the breakers should be readable before they are trusted.
    if (url.pathname === '/api/assist-liveness') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-jarvis-token');
      res.setHeader('access-control-allow-private-network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (!IMPORT_TOKEN || req.headers['x-jarvis-token'] !== IMPORT_TOKEN) {
        return json(res, 403, { error: 'bad token' });
      }
      const { company, liveReqIds, dryRun } = await readBody(req);
      if (!company || !Array.isArray(liveReqIds)) {
        return json(res, 400, { error: 'need { company, liveReqIds: [...] }' });
      }
      const plan = dryRun
        ? planSweep(company, liveReqIds)
        : await assistSweep(company, liveReqIds);
      return json(res, 200, {
        company: plan.company, feedSize: plan.feedSize, storeLive: plan.storeLive,
        judged: plan.judged, stillListed: plan.keep, unkeyed: plan.unkeyed,
        wouldRetire: plan.dead.length, retired: plan.retired ?? 0,
        refusals: plan.refusals,
        sample: plan.dead.slice(0, 5).map(d => d.title),
      });
    }

    // The list the harvest script asks for before it reads anything (F-443).
    //
    // Without this the in-page script would have to carry a thousand URLs
    // inlined into it, or crawl the employer's whole board again — and
    // re-reading 4,700 postings to find the 1,059 that matter is exactly the
    // self-inflicted request volume that has made three previous readings of
    // this system wrong (F-432, F-437, F-444). Ask for the shortlist, read the
    // shortlist.
    if (url.pathname === '/api/assist-targets') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, x-jarvis-token');
      res.setHeader('access-control-allow-private-network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (!IMPORT_TOKEN || req.headers['x-jarvis-token'] !== IMPORT_TOKEN) {
        return json(res, 403, { error: 'bad token' });
      }
      const company = url.searchParams.get('company') || '';
      const source = url.searchParams.get('source') || '';
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 250, 1000));
      // Relevance, not everything. He is not going to read 4,743 Tesla
      // postings and neither is this: the budget goes to the rows that could
      // plausibly end up on a card.
      const minRelevance = Number(url.searchParams.get('relevance') ?? 12);
      const rows = query({
        ...(company ? { companyLike: company } : {}),
        ...(source ? { source: [source] } : {}),
        hasDesc: false,
        locationBucket: ['us', 'remote', 'unknown'],
        minRelevance,
      }, { limit, sort: 'fit' });
      return json(res, 200, {
        total: rows.total,
        targets: rows.rows.map(j => ({ id: j.id, url: j.url, title: j.title })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/company') {
      const { company, hidden } = await readBody(req);
      return json(res, 200, { hiddenCompanies: setCompanyHidden(company, !!hidden) });
    }

    if (req.method === 'GET' && url.pathname === '/api/job') {
      // The one place a description is read: opening a single job.
      const job = getJob(url.searchParams.get('id'), { description: true });
      if (!job) return json(res, 404, { error: 'unknown job' });
      // The stored fit is the headline only — the six-dimension breakdown is
      // recomputed here, for this one job, rather than persisted across ~97k of
      // them (which is what pushed jobs.json past the size it could be read at).
      // scoreFit is pure and reads no files beyond the memoised profile, so
      // this costs microseconds.
      let full = job;
      try {
        full = { ...job, fit: scoreFit(job, getProfile()) };
      } catch { /* fall back to the stored headline */ }
      return json(res, 200, { job: full });
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const { ids, status } = await readBody(req);
      if (!Array.isArray(ids) || !STATUSES.includes(status)) {
        return json(res, 400, { error: 'need { ids:[], status } with a valid status' });
      }
      return await withStoreLock(() => {
        const changed = setStatuses(ids, status);
        return json(res, 200, { changed, counts: counts() });
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/skip-reason') {
      // Recorded on the job AND appended to a flat log. The log is the useful
      // artefact: reading a few hundred skip reasons together is what tells you
      // which rule to add to preferences.md, which no single job ever shows.
      const { id, reasons, note, hideCompany } = await readBody(req);
      return await withStoreLock(() => {
        const job = getListItem(id);
        if (!job) return json(res, 404, { error: 'unknown job' });
        const entry = {
          at: new Date().toISOString(),
          reasons: Array.isArray(reasons) ? reasons.slice(0, 12).map(String) : [],
          note: String(note || '').slice(0, 500),
        };
        // A skip can carry a company-level verdict. "defense company cant
        // work" is not a fact about one req, and hiding only that req left 41
        // more Hermeus postings queued to be skipped one at a time. The
        // machinery already existed; the skip flow just never called it.
        let hidden = null;
        if (hideCompany && String(hideCompany).trim()) {
          hidden = setCompanyHidden(String(hideCompany).trim(), true);
          entry.hidCompany = String(hideCompany).trim();
        }
        // HIS OWN "THIS IS DEAD" IS THE BEST EVIDENCE THERE IS.
        //
        // Nine of his fifty-three recorded skips are a dead posting — the
        // single largest reason, ahead of every preference — and not one of
        // them retired anything. The skip stored the words and moved on, so the
        // row stayed live, stayed in the deck, and stayed eligible to be
        // curated back into his inbox.
        //
        // He does not reach for the reason chip either: the histogram has zero
        // uses of "Dead posting / no longer live" and nine notes reading "dead
        // posting", "deas posting", "expried", "page does not exist". So the
        // note is read as well as the chip, misspellings and all.
        //
        // This is the one rung better than the API. liveness-sweep retires only
        // on a definitive 404/410 and refuses to guess, which is why his
        // Workday and Amazon reqs are unreachable to it — and he has just
        // opened the page and looked at it. A false "expired" is the expensive
        // error, so nothing here infers: it fires only when he says so.
        const DEAD_NOTE_RE = /\b(dead|deas|expir\w*|exipr\w*|expried|no longer (live|available|open)|not found|404|page does not exist|posting does not exist|closed|gone)\b/i;
        const saysDead = entry.reasons.some((r) => /^dead posting/i.test(r))
          || DEAD_NOTE_RE.test(entry.note);
        if (saysDead && !job.goneAt) {
          // `rederive: true` is the same path liveness-sweep uses, so the deck,
          // the triage flags and the picks screen all see it at once.
          updateJob(id, { goneAt: new Date().toISOString() }, { rederive: true });
          entry.retired = true;
        }
        updateJob(id, { skipFeedback: entry });
        try {
        const line = JSON.stringify({
          ...entry, id, company: job.company, title: job.title,
          location: job.location, fit: job.fit?.score ?? null,
        }) + '\n';
          writeFileSync(path.join(STORE_DIR, 'skip-reasons.jsonl'), line, { flag: 'a' });
        } catch { /* the store copy is the source of truth; the log is a convenience */ }
        return json(res, 200, { ok: true, hiddenCompanies: hidden });
      });
    }

    // What "hide this company" would actually cost, so the checkbox can say so
    // before it is ticked rather than after.
    if (req.method === 'GET' && url.pathname === '/api/company-count') {
      const company = url.searchParams.get('company') || '';
      if (!company) return json(res, 200, { deck: 0, good: 0 });
      return json(res, 200, {
        deck: count({ company: [company], browsable: true, status: ['new', 'interested'] }),
        good: count({ company: [company], browsable: true, status: ['new', 'interested'], band: ['strong', 'good'] }),
      });
    }

    // WHAT YOUR SKIPS ARE TELLING YOU.
    //
    // The other half of the skip loop. `skip-reasons.jsonl` had one writer and
    // zero readers, so skipping changed nothing about what came next — "it
    // geuninely feels like this skip thing is useless". This reads the log
    // back and proposes rules; it never writes one. Accepting is a separate,
    // explicit act (`/api/accept-rule`), because a scorer that quietly learns
    // preferences he never stated is one he cannot audit.
    if (req.method === 'GET' && url.pathname === '/api/skip-insights') {
      const hidden = hiddenCompanies();
      // Everything he has turned down: the explicit skips with reasons, and
      // the hidden pile, which is the same decision made without one.
      const skipped = query({ status: ['hidden'] }, { sort: 'fit', limit: 800, full: true }).rows
        .map(j => ({
          title: j.title, company: j.company, location: j.location, at: j.statusChangedAt,
          reasons: j.skipFeedback?.reasons || [], note: j.skipFeedback?.note || '',
          fit: j.fit?.score ?? null,
        }));
      // The deck is the baseline. A word only counts as a preference if he
      // skips it more often than it appears in what he is choosing from.
      const deck = query({
        status: ['new'], browsable: true, blocked: false, fitBlocked: false,
        excludeCompany: hidden.length ? hidden : undefined,
      }, { sort: 'fit', limit: 4000 }).rows.map(j => ({ title: j.title, company: j.company, location: j.location }));

      // The guard rails, drawn from the user-layer files and his own positive
      // decisions. Without them the very first proposal was "block
      // manufacturing" — his target role — followed by "hide Applied
      // Materials", where he interned and has applied.
      const prof = getProfile();
      const protect = [
        ...(prof.primaryRoles || []), ...(prof.secondaryRoles || []),
        ...(prof.industries || []), ...(prof.skills || []),
        'mechanical', 'manufacturing', 'automation', 'robotics', 'design',
        'process', 'quality', 'test', 'equipment', 'systems', 'production',
      ];
      // Any employer he has said yes to in any form.
      const protectCompanies = [...new Set(
        query({ status: ['interested', 'queued', 'applied', 'responded', 'interview', 'offer'] },
          { sort: 'fit', limit: 500 }).rows.map(j => j.company).filter(Boolean),
      )];

      const out = learnFromSkips(skipped, deck, { protect, protectCompanies });
      out.protectedCompanies = protectCompanies.length;

      // What the FORMS gave away that the postings did not. Evidence the apply
      // engine collected a month ago and nothing was reading.
      const preparedForGates = query({ prepared: true }, { sort: 'applied', limit: 300, full: true }).rows;
      const gates = learnFromApplyForms(preparedForGates).filter(g => !hidden.includes(g.target));
      out.proposals = [...gates, ...out.proposals];
      out.totals.proposals = out.proposals.length;
      // A company he has already hidden is not a proposal.
      out.proposals = out.proposals.filter(p => !(p.kind === 'company' && hidden.includes(p.target)));
      return json(res, 200, out);
    }

    // Accept one proposal. Appends a line to preferences.md, or hides a
    // company — the same two things he could do by hand, done for him only after
    // he clicks. Nothing here runs on its own.
    if (req.method === 'POST' && url.pathname === '/api/accept-rule') {
      const { action, rule, company } = await readBody(req);
      if (action === 'hide-company' && company) {
        return json(res, 200, { ok: true, hiddenCompanies: setCompanyHidden(String(company), true) });
      }
      if (action === 'add-rule' && rule) {
        const line = String(rule).trim();
        if (!/^(never|no|avoid|prefer|want|love)\s/i.test(line)) {
          return json(res, 400, { error: 'not a preference rule' });
        }
        const path_ = path.join(HERE, 'preferences.md');
        let text;
        try { text = readFileSync(path_, 'utf-8'); } catch { return json(res, 500, { error: 'preferences.md unreadable' }); }
        if (text.includes(line)) return json(res, 200, { ok: true, already: true });
        // Appended with the date and the fact that it came from his own
        // skips, so a rule he does not remember writing explains itself.
        const stamp = new Date().toISOString().slice(0, 10);
        writeFileSync(path_, `${text.replace(/\s*$/, '')}\n\n# Learned from your skips, ${stamp}\n${line}\n`);
        return json(res, 200, { ok: true, rule: line });
      }
      return json(res, 400, { error: 'unknown action' });
    }

    // "I have looked at this one." Recorded when a card is actually rendered,
    // so tomorrow's deck can lead with postings he has never been shown. A
    // posting he read and moved past is still status 'new', which is why the
    // deck kept handing him the same cards.
    if (req.method === 'POST' && url.pathname === '/api/seen') {
      const { ids } = await readBody(req);
      const list = Array.isArray(ids) ? ids.slice(0, 200).map(String) : [];
      const at = new Date().toISOString();
      let marked = 0;
      for (const id of list) {
        // First sighting only — re-marking would make "seen today" creep
        // forward every time he pages back through the deck.
        const j = getListItem(id);
        if (j && !j.seenAt) { updateJob(id, { seenAt: at }); marked++; }
      }
      return json(res, 200, { ok: true, marked });
    }

    if (req.method === 'POST' && url.pathname === '/api/deep') {
      // Records a "please analyze this deeply" request. The agent picks these up;
      // the dashboard never runs analysis itself (keeps it instant + cheap).
      const { id } = await readBody(req);
      const updated = updateJob(id, { deepRequested: new Date().toISOString() });
      if (!updated) return json(res, 404, { error: 'unknown job' });
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// LEAVE A TRACE WHEN THIS PROCESS DIES. The dashboard vanished twice in one
// evening with an empty stderr, and every extension press then read "the
// dashboard is not running" with nothing to say why. A rejection nobody
// caught is logged and survived; a thrown exception is logged and exits.
//
// …AND THE TRACE HAS TO GO SOMEWHERE THAT OUTLIVES THE PROCESS (F-317).
//
// The first version of this wrote to stderr, which was the whole bug wearing a
// different hat: the dashboard is started detached — by his shortcut, by
// `Start-Process -WindowStyle Hidden`, by every restart in this project — and
// that discards stdout and stderr. So "the next death leaves a trace" left
// none, and F-317 sat open on "read the log the process now writes" when there
// was no log to read. It goes to a FILE now, and the file records starts as
// well as deaths: "it was up at 21:02 and gone by 21:40" is most of the
// diagnosis, and neither half is visible from a process that is not there.
const DEATH_LOG = path.join(HERE, '..', 'logs', 'dashboard.log');
function trace(line) {
  const stamped = `[${new Date().toISOString()}] pid ${process.pid} — ${line}\n`;
  try { console.error(stamped.trim()); } catch { /* no console when detached */ }
  try {
    mkdirSync(path.dirname(DEATH_LOG), { recursive: true });
    appendFileSync(DEATH_LOG, stamped);
  } catch { /* a log that cannot be written must never take the server down */ }
}
trace(`started on port ${PORT}`);
process.on('unhandledRejection', (e) => {
  trace(`unhandled rejection — ${e?.stack || e}`);
});
process.on('uncaughtException', (e) => {
  trace(`uncaught exception — ${e?.stack || e}`);
  process.exit(1);
});
process.on('exit', (code) => { if (code !== 0) trace(`exiting with code ${code}`); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { trace(`${sig} — stopping`); process.exit(0); }); } catch { /* not on this platform */ }
}

// An already-running dashboard is the normal case for a desktop shortcut, not an
// error. Without this, the second launch threw EADDRINUSE and the shortcut window
// flashed and closed — indistinguishable from "Jarvis won't start".
server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  const url = `http://localhost:${PORT}`;

  // ASK THE CHEAPEST QUESTION FIRST, AND GIVE IT LONGER TO ANSWER.
  //
  // `/api/overview` counts across a 300,000-row store, and on 2026-09-20 that
  // store had a 419 MB journal beside it. Two launches died at EXACTLY 3.0s
  // (logs/dashboard.log, 2026-09-19 10:40 and 10:55) — the old timeout — and
  // printed "Port 4300 is taken by something that is not Jarvis", telling him
  // to kill his own working dashboard. A slow answer is not a wrong one.
  //
  // `/api/ping` reads nothing, so a live Jarvis answers it immediately however
  // large the store is; the overview probe stays as a fallback for a server
  // old enough not to have the route, with a timeout that a real query can
  // finish inside.
  const asks = async (p, ms) => fetch(`${url}${p}`, { signal: AbortSignal.timeout(ms) })
    .then((r) => r.ok).catch(() => false);
  const alive = await asks('/api/ping', 4000) || await asks('/api/overview', 15000);

  if (alive) {
    console.log(`\n  Jarvis Jobs is already running → ${url}`);
    console.log('  Opening it in your browser.\n');
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  }
  // SAY WHY, IN THE LOG. `process.on('exit')` records only "exiting with code
  // 1", so this diagnosis was not recoverable from the log afterwards — which
  // is how two of these sat unexplained for a day.
  trace(`port ${PORT} busy and no Jarvis answered /api/ping or /api/overview — exiting`);
  console.error(`\n  Port ${PORT} is taken by something that is not Jarvis.`);
  console.error(`  Close it, or run with a different port:  set JARVIS_PORT=4301 && npm run jarvis:serve\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  Jarvis Jobs dashboard → http://localhost:${PORT}\n`);
  console.log('  (Ctrl-C to stop. Actions save to data/jarvis/jobs.db.)\n');
});
