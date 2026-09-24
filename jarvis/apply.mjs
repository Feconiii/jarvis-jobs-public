#!/usr/bin/env node
// jarvis/apply.mjs — the batch application engine.
//
// Takes the jobs YOU queued (or explicit --url args), opens each in a real,
// visible browser, fills everything it can from data/jarvis/apply-profile.yml
// via structured DOM interaction (no coordinate clicking), and then STOPS:
// every application is left open at its form for you to review, complete the
// flagged fields, and click Submit yourself.
//
// Hard boundaries (non-negotiable, enforced in adapters):
//   - NEVER clicks Submit/Apply-final — you do that.
//   - NEVER invents an answer — unknown questions are flagged, not guessed.
//
// DOES fill (Alex's standing instruction, 2026-07-16 and again 2026-08-09):
//   - certification / consent / acknowledgement / AI-screening checkboxes → Yes
//   - voluntary self-identification (EEO: gender, race, veteran, disability)
//     from the `eeo:` block in apply-profile.yml
// An earlier version of this header claimed the opposite for both. It was
// wrong, it contradicted apply-profile.yml — which says in as many words that
// the engine fills these — and reading it as policy is what left Alex's EEO
// sections blank on application after application. Leaving a settled question
// "for review" wastes his time; the per-application report IS his review.
//   - One application failing does not stop the batch.
//
// Usage:
//   node jarvis/apply.mjs                        # everything with status=queued
//   node jarvis/apply.mjs --url <posting-url>    # explicit URL(s), repeatable
//   node jarvis/apply.mjs --company rocketlab
//   node jarvis/apply.mjs --limit 5
//   node jarvis/apply.mjs --login                # sign in once, in THE profile runs use
//   node jarvis/apply.mjs --test --url <url>     # placeholder data, closes at end,
//                                                #  saves a screenshot (engine check)
//
// Browser, and this matters more than it looks:
//
//   --real-chrome   YOUR Chrome, the profile you are signed in with. Chrome only
//                   allows one process per profile, so it must be closed first;
//                   add --close-chrome and this does it for you (gracefully -
//                   your tabs are saved and restored). This is the mode that
//                   reaches forms behind a Google sign-in or an employer account
//                   you already have.
//   (default)       a dedicated profile at LOCALAPPDATA/jarvis-chrome, signed
//                   into nothing. Fine for --test engine checks; it will meet a
//                   sign-in wall on anything real.
//   --own-browser   a throwaway profile, no logins, no persistence.
//   --connect <port>  attach to a Chrome you started yourself.
//   --chrome-profile <name>  which profile inside the user-data-dir (default Default).

import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

import { getJob, putJob, updateJob, setStatus, query, findByUrl, jobId } from './store.mjs';
import * as greenhouse from './apply/greenhouse.mjs';
import * as lever from './apply/lever.mjs';
import * as ashby from './apply/ashby.mjs';
import * as workday from './apply/workday.mjs';
import * as eightfold from './apply/eightfold.mjs';
import * as generic from './apply/generic.mjs';
import { APPLY_PATH_RE, APPLY_TEXT_RE, bouncedToRoot, pageBlocker } from './apply/_form.mjs';
import { resumePathFor, familyFor } from './resume-family.mjs';
// The recruiter-facing filename: his name, the employer, the role (F-409).
import { personFile } from './resume-for-job.mjs';
// Reads a posting's title from its ATS API when the store has never seen it,
// so a --url application still gets the resume family the role deserves.
import { fetchPostingMeta } from '../liveness-api.mjs';
import { titlesForFamily, companyKey } from './resume-variants.mjs';
import { time, takePhases, mergePhases, formatPhases, fmtMs } from './apply/_timing.mjs';
import { guardArgs } from './cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROFILE_PATH = path.join(ROOT, 'data', 'jarvis', 'apply-profile.yml');
const BROWSER_DIR = path.join(ROOT, 'data', 'jarvis', 'browser-profile');

// Order matters: `generic` matches everything, so it must stay last.
const ADAPTERS = [greenhouse, lever, ashby, workday, eightfold, generic];

// Placeholder profile for --test runs: exercises the engine without putting
// real personal data into any form.
const TEST_PROFILE = {
  identity: {
    first_name: 'Test', last_name: 'Placeholder', full_name: 'Test Placeholder',
    email: 'test@example.com', phone: '+1 (555) 000-0000',
    location: 'Testville, WA', city: 'Testville', state: 'Washington', country: 'United States',
    linkedin: '', website: '', github: '',
  },
  education: { school: 'Test University', degree: 'Bachelor of Science', degree_level: "Bachelor's", discipline: 'Mechanical Engineering', graduation: 'May 2027', gpa: '3.50' },
  answers: {
    authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', us_person: 'No',
    security_clearance: 'No', earliest_start: 'June 2027', willing_to_relocate: 'Yes',
    remote_or_onsite: 'Open', how_heard: 'Company website', phone_type: 'Mobile',
    salary_expectation: 'Open', over_18: 'Yes', previously_employed_here: 'No', relatives_at_company: 'No',
    citizenship_status: 'Non-U.S. citizen (test)', years_relevant_experience: '1-2 years',
    willing_onsite: 'Yes', background_check_consent: 'Yes', current_company: 'Test University',
  },
  eeo: {
    gender: 'Decline to self-identify', hispanic: 'Decline to self-identify',
    race: 'Decline to self-identify', veteran: 'I decline to self-identify',
    disability: 'I do not want to answer',
  },
  policy: { auto_check_certifications: true },
  documents: {},
  never_fill: [],
};

export const USAGE = `
  npm run jarvis:apply -- [options]

  Opens queued applications in a real browser, fills what it can, flags the
  rest, and NEVER submits. Pressing Submit is yours, every time.

    --url <url>              apply to this posting (repeatable)
    --company <name>         only postings at this company
    --limit <n>              how many to open (default 15)
    --test                   use the built-in test profile, not your real one
    --login                  sign in once, in the profile these runs use
    --help, -h               print this

  Which browser, and it matters:
    --real-chrome            YOUR Chrome, the profile you are signed into
    --close-chrome           close it for you first (tabs are saved and restored)
    --own-browser            a throwaway profile, no logins
    --connect <port>         attach to a Chrome you started yourself
    --chrome-profile <name>  which profile inside the user-data-dir

  For the one-click browser flow instead, run npm run jarvis:serve, press
  Apply on the dashboard, and click the Jarvis button on the form.
`;

/**
 * Every flag this script reads, and which of them take a value.
 *
 * Read off the source rather than the header comment: the header documented
 * --login, --connect and --chrome-profile, and a first pass at the guard listed
 * only the four in the usage text — which would have rejected the browser flags
 * this engine has always accepted. Documentation is not an inventory.
 */
const FLAGS = ['--url', '--company', '--limit', '--test', '--login',
  '--real-chrome', '--close-chrome', '--own-browser', '--connect', '--chrome-profile'];
const VALUED = ['--url', '--company', '--limit', '--connect', '--chrome-profile'];

function parseArgs() {
  // AN UNKNOWN FLAG STOPS THE RUN. `--help` used to fall through this parser and
  // start applying to fifteen real postings in a real browser — asking the
  // script what it does made it do it (F-162). The guard is the SHARED one in
  // jarvis/cli.mjs rather than a copy here, because a second implementation of
  // "which flags are real" is the drift this project has already paid for twice.
  const a = guardArgs({
    usage: USAGE,
    flags: FLAGS,
    valued: VALUED,
  });

  const urls = [];
  for (let i = 0; i < a.length; i++) if (a[i] === '--url' && a[i + 1]) urls.push(a[++i]);
  const get = f => { const i = a.indexOf(f); return i !== -1 ? a[i + 1] : undefined; };
  return {
    urls,
    company: get('--company')?.toLowerCase(),
    limit: get('--limit') != null ? Number(get('--limit')) : 15,
    test: a.includes('--test'),
  };
}

function loadProfile(test) {
  if (test) return TEST_PROFILE;
  if (!existsSync(PROFILE_PATH)) {
    console.error(`apply-profile not found at ${PROFILE_PATH} — create it first.`);
    process.exit(1);
  }
  return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
}

function adapterFor(url) {
  return ADAPTERS.find(ad => ad.matches(url)) || null;
}

/**
 * Follow a job-BOARD listing through to the real application form.
 *
 * Postings discovered by sitemap-jobs are marketing pages, not forms. Applied
 * Materials is the clear case: the stored URL is jobs.appliedmaterials.com/job/…,
 * whose only form is the site's own job-search box, while Apply links out to
 * careers.appliedmaterials.com — an Eightfold form this engine already has an
 * adapter for. Without this hop the run picked `generic`, found the search bar,
 * and reported "no recognisable form fields" on a posting it was fully equipped
 * to fill.
 *
 * Two rules were wrong here, and each cost a different set of postings.
 *
 * 1. It only looked at `a[href]`. Real Apply controls are frequently BUTTONS —
 *    careers.agcocorp.com renders `<button href="/talentcommunity/apply/…">`,
 *    and careers.ti.com renders a button with no href at all (that one is a
 *    click, handled downstream in generic.mjs, not here).
 *
 * 2. It required the destination hostname to DIFFER from the current one. That
 *    is right for Applied Materials, whose Eightfold form is on another domain,
 *    and it makes every same-host application form invisible. Measured live:
 *    amazon.jobs links `Apply now` → /applicant/jobs/<id>/apply on its own
 *    host, careers.ti.com → /apply/email, SuccessFactors tenants →
 *    /talentcommunity/apply/<id>/. Those are ~700 deck postings between them.
 *
 * A same-host link is followed only when the destination PATH looks like an
 * application and the current path does not, so a board page cannot bounce to
 * itself.
 *
 * Returns the resolved URL, or null if the page has no Apply link worth taking.
 */
async function resolveApplyUrl(page) {
  // Collect every Apply-looking control that carries a destination.
  const collect = () => page.evaluate(() => {
    // Anything with an href, not just anchors: careers.agcocorp.com renders
    // `<button href="/talentcommunity/apply/…">`.
    const els = [...document.querySelectorAll('a[href], [href]')];
    const isApply = (el) =>
      /^\s*(apply|apply now|apply here|apply for this job|apply to this job|submit application|start (your )?application)\s*$/i
        .test((el.textContent || '').trim()) ||
      /job-apply|apply-btn/i.test(typeof el.className === 'string' ? el.className : '');
    const out = [];
    for (const el of els) {
      if (!isApply(el)) continue;
      const raw = el.getAttribute('href') || '';
      if (!raw || /^#|^javascript:/i.test(raw)) continue;
      try {
        const u = new URL(raw, location.href);
        out.push({ href: u.href, sameHost: u.hostname === location.hostname, path: u.pathname });
      } catch { /* unparseable href */ }
    }
    // Was there an Apply control at all, href or not? A hrefless one is a real
    // control that this function cannot use — careers.ti.com renders a plain
    // <button> whose handler navigates — and generic.mjs will click it. Knowing
    // the difference is what lets the retry below stop early instead of waiting
    // out its full budget for an href that is never coming.
    const anyControl = [...document.querySelectorAll('a, button, [role=button]')].some(isApply);
    return { cands: out, herePath: location.pathname, anyControl };
  }).catch(() => null);

  // Pick the best destination, or null if none of them is worth the hop.
  const choose = (found) => {
    if (!found?.cands?.length) return null;
    // 1. Cross-host into an ATS we have a proven driver for. This is how
    //    Applied Materials reaches its Eightfold form, and it is the strongest
    //    signal available.
    for (const c of found.cands) {
      if (c.sameHost) continue;
      const ad = adapterFor(c.href);
      if (ad && ad.id !== 'generic') return c.href;
    }
    // 2. Same-host into something shaped like an application. amazon.jobs,
    //    careers.ti.com and every SuccessFactors tenant live here, and the old
    //    hostname-must-differ rule made all of them invisible.
    if (!APPLY_PATH_RE.test(found.herePath)) {
      for (const c of found.cands) {
        if (c.sameHost && APPLY_PATH_RE.test(c.path)) return c.href;
      }
      // 3. Cross-host into an application-shaped path on an ATS we have no
      //    driver for. The generic filler on a real form still beats the
      //    generic filler on a job board.
      for (const c of found.cands) {
        if (!c.sameHost && APPLY_PATH_RE.test(c.path)) return c.href;
      }
    }
    return null;
  };

  // RETRY, deciding fresh each time. These pages wire their Apply button up
  // after they render it: on careers.agcocorp.com the button is visible within
  // ~600ms and its href arrives later, so a single read — or a wait that
  // stopped at the first candidate of any kind — kept picking up a decorative
  // `class="job-apply"` wrapper and concluding there was nothing to follow.
  // The same posting hopped on one run and not the next. Deciding on every
  // poll, and only accepting a destination that survives `choose`, removes the
  // race; it returns as soon as the real button is wired, and costs nothing on
  // a page that has one already.
  try {
    const deadline = Date.now() + 8000;
    let hrefless = 0;
    for (;;) {
      const found = await collect();
      const pick = choose(found);
      if (pick) return pick;
      // An Apply control that is present but carries no usable href is not
      // going to grow one — careers.ti.com's is a bare <button>. Hand it to
      // generic.mjs, which clicks it, instead of waiting out the full budget:
      // that wait was 8s of every Texas Instruments application, and TI is 247
      // deck postings.
      if (found?.anyControl && !found.cands?.length && ++hrefless >= 2) return null;
      if (Date.now() >= deadline) return null;
      await page.waitForTimeout(300);
    }
  } catch {
    return null;
  }
}

/**
 * The titles the resume that is about to be uploaded actually prints, keyed by
 * normalised company name.
 *
 * Every resume Jarvis builds saves the spec that produced it as spec.json in the
 * same folder, so this reads the truth off the artefact rather than re-deriving
 * it — a per-posting one-off is covered as well as the four family resumes. The
 * family's own title map is the fallback.
 */
function titlesForResume(resumePath, family) {
  try {
    const specPath = path.join(path.dirname(resumePath), 'spec.json');
    if (existsSync(specPath)) {
      const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
      const m = new Map();
      for (const e of spec.experience || []) if (e.org && e.title) m.set(companyKey(e.org), e.title);
      if (m.size) return { titles: m, source: 'spec' };
    }
  } catch { /* fall through to the family map */ }
  if (!family) return { titles: new Map(), source: 'none' };
  return { titles: new Map([...titlesForFamily(family.key)].map(([c, t]) => [companyKey(c), t])), source: 'family' };
}

/**
 * Make the FORM say what the RESUME says.
 *
 * The four resumes present each internship under the approved title that matches
 * the lane (cv.md § Approved internship title variants — his manager signed off
 * on this). The work-history fields are rendered on the same ATS screen as the
 * attached PDF, so a form still saying "Manufacturing Engineer Intern" beside a
 * resume saying "Automation Engineer Intern" is the one inconsistency a
 * recruiter cannot miss. Titles only — dates, companies and descriptions are
 * untouched.
 */
function syncWorkTitles(profile, titles) {
  if (!titles.size || !Array.isArray(profile?.work_experience)) return { profile, changed: [] };
  const changed = [];
  const work_experience = profile.work_experience.map((e) => {
    const title = titles.get(companyKey(e?.company));
    if (!title || title === e.title) return e;
    changed.push(`${e.company}: "${e.title}" → "${title}"`);
    return { ...e, title };
  });
  return { profile: { ...profile, work_experience }, changed };
}

/**
 * Keep an audit copy of exactly what was sent, named so it is obvious at a glance
 * WHICH of the four resumes went out — "Alex Rivera Resume - automation - KLA
 * Corporation - Robotics Engineer.pdf" — and return a path whose FILENAME is
 * generic, because setInputFiles uploads the basename and that is what the
 * recruiter sees in the ATS.
 */
function stageResumeForUpload(resumePath, job, profile, familyKey) {
  try {
    if (!existsSync(resumePath)) return resumePath;
    const person = profile.identity?.preferred_full_name || 'Alex Rivera';
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const label = [safe(familyKey), safe(job.company), safe(job.title)].filter(Boolean).join(' - ');

    // 1. Audit copy, descriptively named, kept and shown in the dashboard.
    const sentDir = path.join(ROOT, 'output', 'jarvis-resumes', 'sent');
    mkdirSync(sentDir, { recursive: true });
    const auditPath = path.join(sentDir, `${person} Resume${label ? ' - ' + label : ''}.pdf`);
    copyFileSync(resumePath, auditPath);
    if (job.id) job.resume_sent = path.relative(ROOT, auditPath).replace(/\\/g, '/');

    // 2. Upload copy — named for the posting, so the ATS records "Alex Rivera -
    //    <Company> - <Role>.pdf" and he can see from the form's own chip which
    //    resume went on (F-409, his words: "i want to have a signal thats what
    //    you actually attached").
    const upDir = path.join(ROOT, 'output', 'jarvis-resumes', '.upload');
    mkdirSync(upDir, { recursive: true });
    const upPath = path.join(upDir, personFile(person, job));
    copyFileSync(resumePath, upPath);
    return upPath;
  } catch { return resumePath; }
}

/**
 * Pick the resume this application will send, stage it, and return the profile
 * the adapter should fill from.
 *
 * EVERY application gets a tailored resume, and the tailoring is the FAMILY —
 * one of the four (total-experience / automation / manufacturing / mechanical),
 * picked from the posting's title. That is what keeps "always tailored" and
 * "never a fresh resume per posting" the same rule. Order of preference:
 *   1. one authored for THIS posting (job.resume_path, set by queue prep —
 *      only when Alex asks for that specific job)
 *   2. the family resume for its lane
 *   3. the profile default
 */
function prepareResume(job, profile) {
  const family = familyFor(job);
  let resumePath = job.resume_path;
  let resumeNote = resumePath ? 'per-job' : '';
  if (!resumePath) {
    const pick = resumePathFor(job, profile.identity?.preferred_full_name || 'Alex Rivera');
    if (existsSync(pick.path)) { resumePath = pick.path; resumeNote = `${pick.family.key} — ${pick.family.label}`; }
  }
  // The family PDF has not been built yet (`node jarvis/build-resumes.mjs`)
  // — fall back to the profile's own file, but run it through the same
  // staging so the audit copy and the form titles still line up.
  if (!resumePath && existsSync(path.join(ROOT, profile.documents?.resume_path || ''))) {
    resumePath = path.join(ROOT, profile.documents.resume_path);
    resumeNote = 'profile default (family resume not built)';
  }
  // ONE NAME NOW, AND IT NAMES THE POSTING (F-409).
  //
  // This used to be two names on purpose. He wanted to SEE which resume went
  // out, so the copy on disk carried the family, company and role — while the
  // ATS was handed a generic "Alex Rivera Resume.pdf", because a per-posting
  // filename "makes it seem not truthful" (his words, and they were the rule
  // here for weeks).
  //
  // He reversed that himself on 2026-09-08, and his reason is the better one:
  // "i want to have a signal thats what you actuallly attached". After a run
  // of the panel saying one thing and the form doing another, the filename in
  // the form's own chip is the receipt that the right file went on. Both
  // copies are now named for the posting.
  // WHO HE IS APPLYING TO, so a question about his history with THEM is
  // answered from his history rather than from the standing default (F-376).
  // The extension's planner has had this since it was found on a live Applied
  // Materials form; both engines read the same rule table, so both need the
  // same fact in front of it — one engine fixed and the other quietly not is
  // the drift this project keeps paying for.
  let jobProfile = job?.company ? { ...profile, applyingTo: String(job.company) } : profile;
  if (resumePath) {
    const { titles, source } = titlesForResume(resumePath, family);
    // Only sync when the titles came from the spec that actually produced
    // this PDF, or from the family whose PDF this is. A one-off resume
    // with no spec beside it is left alone — guessing there would make the
    // form assert a title the attached file might not carry, which is the
    // exact mismatch this is meant to prevent.
    const trust = source === 'spec' || resumeNote !== 'per-job';
    const synced = trust ? syncWorkTitles(profile, titles) : { profile, changed: [] };
    jobProfile = synced.profile;
    resumePath = stageResumeForUpload(resumePath, job, profile, family?.key);
    jobProfile = { ...jobProfile, documents: { ...jobProfile.documents, resume_path: resumePath } };
    console.log(`   resume: ${resumeNote || 'profile default'} → ${resumePath}`);
    for (const c of synced.changed) console.log(`   title synced to resume — ${c}`);
    if (!trust) console.log(`   ⚠ one-off resume with no spec.json beside it — check the work-history titles match the PDF`);
  }
  return jobProfile;
}

/** Find the stored job for a URL, tolerating the variants the same posting has.
 *  Workday serves the identical requisition at /Search/job/... and
 *  /en-US/Search/job/..., so an exact-id lookup missed it and the run recorded
 *  nothing — the application never showed up in the Review tab. */
function findStoreJob(url) {
  return findByUrl(url, (u) => String(u).toLowerCase()
    .replace(/\/en-[a-z]{2}\//i, '/')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, ''));
}

// ── debug-Chrome recovery ───────────────────────────────────────────
//
// A debug Chrome left running for hours reliably wedges: the CDP websocket
// handshake succeeds, then Playwright's target enumeration never returns and
// connectOverCDP times out. A freshly launched Chrome of the same version
// attaches in under a second, so it is accumulated browser state, not a version
// mismatch. Closing it gracefully and relaunching clears it — and because the
// user-data-dir persists, the Google session survives, so no re-login.

const CHROME_EXE = process.env.JARVIS_CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
//
// WHICH Chrome. This defaulted to a DEDICATED profile, and that was the wrong
// default: it is a browser he has never signed into anything with, so every run
// met a sign-in wall and he did not even recognise the window - 'you are opening
// up like a non user tab where im not signed in'.
//
// --real-chrome uses his ACTUAL Chrome profile instead, the one already signed
// in to Google and to whatever employer accounts he has. On this machine that is
// LOCALAPPDATA/Google/Chrome/User Data, profile 'Default' - 'Profile 1' exists
// but was last written in 2023 and holds 20 KB of cookies against Default's 1 MB.
//
// The catch, and why this cannot simply BE the default: Chrome allows one
// process per user-data-dir. If his Chrome is already open, launching another
// with --remote-debugging-port silently hands the URL to the running instance
// and exits, leaving no debug port and no error. So the mode checks first and
// tells him to close Chrome, rather than quietly opening the wrong browser.
const REAL_CHROME = process.argv.includes('--real-chrome');
const CLOSE_CHROME = process.argv.includes('--close-chrome');
const REAL_CHROME_DIR = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE = process.env.JARVIS_CHROME_PROFILE
  || (REAL_CHROME ? REAL_CHROME_DIR : path.join(process.env.LOCALAPPDATA || '', 'jarvis-chrome'));
const CHROME_PROFILE_DIR = (() => {
  const k = process.argv.indexOf('--chrome-profile');
  return k !== -1 ? process.argv[k + 1] : 'Default';
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cdpAlive(port) {
  try {
    const r = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Ask the wedged browser to close itself over CDP (Playwright cannot attach,
 *  but the raw websocket still answers). */
async function closeBrowserOverCdp(port) {
  const info = await cdpAlive(port);
  const url = info?.webSocketDebuggerUrl;
  if (!url) return false;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.onclose = () => finish(true);
      ws.onerror = () => finish(false);
      setTimeout(() => finish(false), 8000);
    } catch { finish(false); }
  });
}

/**
 * Is a Chrome already running that owns the profile we are about to launch?
 *
 * Chrome permits ONE process per user-data-dir. A second launch against a dir
 * that is already open does not fail - it hands its URL to the running instance
 * and exits 0, so --remote-debugging-port never opens and the only symptom is a
 * connect timeout twenty seconds later. In --real-chrome that is guaranteed,
 * because the profile in question is the browser he is reading this in.
 */
/**
 * Close his Chrome so the profile can be reopened with automation attached.
 *
 * OPT-IN (--close-chrome). Never automatic: this is the browser he is using,
 * and a tool that closes it uninvited is worse than one that asks.
 *
 * taskkill WITHOUT /F posts WM_CLOSE, which is the same thing clicking the X
 * does - Chrome saves its session and restores every tab on next start. /F
 * would be a kill, and would lose them.
 */
async function closeUserChrome() {
  console.log('  Closing Chrome (your tabs are saved and will come back)...');
  await new Promise((resolve) => {
    const ps = spawn('taskkill.exe', ['/IM', 'chrome.exe'], { stdio: 'ignore' });
    ps.on('close', resolve);
    ps.on('error', resolve);
  });
  // Wait for the processes to actually go: the profile stays locked until the
  // last one exits, and relaunching into a locked dir is the silent hand-off
  // this whole path exists to avoid.
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!(await chromeRunning())) return true;
  }
  return false;
}

/** How many chrome.exe processes are alive. */
async function chromeRunning() {
  return await new Promise((resolve) => {
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process chrome -ErrorAction SilentlyContinue).Count'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('close', () => resolve(Number(out.trim()) > 0));
    ps.on('error', () => resolve(false));
  });
}

async function realChromeBlocked(port) {
  if (!REAL_CHROME) return false;
  if (await cdpAlive(port)) return false;   // already debuggable, nothing to do
  return await chromeRunning();
}

/**
 * START CHROME OUTSIDE THIS RUN'S PROCESS TREE (F-171).
 *
 * `detached: true` plus `.unref()` is the documented way for a child to
 * outlive its parent, and it is not enough here. It protects against the
 * PARENT EXITING; it does not take the child out of the tree, and the
 * supervising harness on Windows kills the whole tree. Two complete fills were
 * lost that way on 2026-09-01/02 — the terminal reported success and the form
 * was gone before he reached it. The window between "filled" and "he presses
 * Submit" is minutes to hours, and for all of it the work sat in a process
 * that looked idle and therefore looked safe to stop.
 *
 * `cmd /c start` hands the launch to a shell that exits immediately, so Chrome
 * is left owned by the session rather than by this run. That is what the
 * manual `Start-Process` workaround in F-171 was doing by hand, and this makes
 * it the default rather than a flag he has to know about.
 *
 * The direct spawn stays as a fallback: if the shell route does not come up,
 * a Chrome inside the tree is still far better than no Chrome.
 */
function spawnOutsideTree(exe, args) {
  if (process.platform !== 'win32') {
    return spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
  }
  // `start` takes a window TITLE first, and eats the first quoted argument as
  // one if it is not given — which is why the empty string is not optional.
  return spawn('cmd', ['/c', 'start', '', '/b', exe, ...args],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function launchDebugChrome(port) {
  if (!existsSync(CHROME_EXE)) return false;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    ...(REAL_CHROME ? [`--profile-directory=${CHROME_PROFILE_DIR}`] : []),
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ];
  spawnOutsideTree(CHROME_EXE, args);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await cdpAlive(port)) return true;
  }
  // The shell route did not produce a debuggable Chrome. Fall back to the
  // direct spawn rather than failing the run outright.
  spawn(CHROME_EXE, args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (await cdpAlive(port)) return true;
  }
  return false;
}

async function connectWithRecovery(port) {
  try {
    return await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 25000 });
  } catch (err) {
    console.log('  Chrome on this port is not responding to CDP — restarting it (your session persists)...');
    await closeBrowserOverCdp(port);
    await sleep(2500);
    const up = await launchDebugChrome(port);
    if (!up) throw err;
    await sleep(1500);
    return await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 30000 });
  }
}

// Inject the per-application review panel into the page the user will review —
// the terminal report, but where the eyes already are. Pure DOM, dismissible,
// touches nothing else on the page.
async function injectReviewOverlay(page, job, res) {
  const data = {
    title: job.title || 'Application',
    filled: res.filled.length,
    resume: res.resumeUploaded,
    review: res.review.map(r => ({ l: r.label.slice(0, 70), v: String(r.value).slice(0, 60) })),
    needs: res.needsInput.map(n => ({ l: n.label.slice(0, 70), w: n.why.slice(0, 80) })),
    skipped: res.skipped.length,
  };
  await page.evaluate((d) => {
    const old = document.getElementById('jarvis-review'); if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'jarvis-review';
    el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;max-height:70vh;overflow:auto;background:#0e1116;color:#e6edf3;border:1px solid #39424f;border-radius:10px;font:12px/1.45 system-ui,sans-serif;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    let h = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <b style="color:#5aa2ff">Jarvis</b><span>filled ${d.filled} field(s)${d.resume ? ' + resume' : ''}</span>
      <button id="jarvis-review-x" style="margin-left:auto;background:none;border:1px solid #39424f;color:#9aa7b4;border-radius:5px;cursor:pointer;padding:0 7px">✕</button></div>`;
    if (d.needs.length) {
      h += `<div style="color:#e3b341;font-weight:600;margin:6px 0 3px">✍ Needs you (${d.needs.length})</div>`;
      for (const n of d.needs) h += `<div style="margin:2px 0;border-left:3px solid #d29922;padding-left:7px"><b>${esc(n.l)}</b><br><span style="color:#9aa7b4">${esc(n.w)}</span></div>`;
    }
    if (d.review.length) {
      h += `<div style="color:#56d364;font-weight:600;margin:8px 0 3px">⚠ Review these answers (${d.review.length})</div>`;
      for (const r of d.review) h += `<div style="margin:2px 0;border-left:3px solid #3fb950;padding-left:7px">${esc(r.l)} → <b>${esc(r.v)}</b></div>`;
    }
    h += `<div style="color:#6e7b8a;margin-top:8px">${d.skipped} field(s) left by policy · Jarvis never submits — that's you.</div>`;
    el.innerHTML = h;
    document.body.appendChild(el);
    document.getElementById('jarvis-review-x').onclick = () => el.remove();
  }, data).catch(() => { /* page navigated — overlay is best-effort */ });
}

function printReport(entry) {
  const { job, res, error, phases } = entry;
  console.log(`\n━━ ${job.title || job.url}${job.company ? ` — ${job.company}` : ''}`);
  if (phases) { const t = formatPhases(phases); if (t) console.log(t); }
  if (error) { console.log(`   ✗ ${error}`); return; }
  if (!res) { console.log('   opened (no adapter for this ATS — fill manually in the open tab)'); return; }
  console.log(`   filled ${res.filled.length} field(s)${res.resumeUploaded ? ' + resume uploaded' : ''}`);
  for (const fl of res.filled) console.log(`     ✓ ${fl.label} = "${fl.value}"`);
  if (res.review.length) {
    console.log('   ⚠ REVIEW these answers before submitting:');
    for (const r of res.review) console.log(`     • ${r.label} → "${r.value}"`);
  }
  if (res.needsInput.length) {
    console.log('   ✍ needs your input:');
    for (const n of res.needsInput) console.log(`     • ${n.label} — ${n.why}`);
  }
  if (res.skipped.length) {
    console.log('   ◦ left for you by policy:');
    for (const s of res.skipped) console.log(`     • ${s.label} — ${s.why}`);
  }
}

// One-time login: open the engine's persistent browser to a URL and hold it
// open so the user can sign in (a single Google sign-in unlocks every Workday
// tenant via SSO). The session persists in data/jarvis/browser-profile.
async function loginMode(url) {
  // Sign in to the SAME profile the apply runs use, or the sign-in does not
  // count. This used to open the engine's throwaway profile while every real
  // run attached to the debug Chrome — so signing in here changed nothing and
  // the next application still hit the Google wall.
  const port = 9222;
  if (!(await cdpAlive(port))) {
    console.log(`  Starting your persistent Chrome (profile ${CHROME_PROFILE})...`);
    if (!(await launchDebugChrome(port))) {
      console.error('  Could not start Chrome — start it yourself with --remote-debugging-port=9222.');
      process.exit(1);
    }
  }
  const cdp = await connectWithRecovery(port);
  const context = cdp.contexts()[0] || await cdp.newContext();
  const page = await context.newPage();
  await page.goto(url || 'https://accounts.google.com', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront().catch(() => {});
  console.log('\n  Sign in in the browser window that opened.');
  console.log(`  The session is saved to ${CHROME_PROFILE} and reused by EVERY apply run,`);
  console.log('  including across reboots — you should only ever have to do this once.');
  console.log('  When you are signed in, come back here and press Ctrl+C.\n');
  await new Promise(() => {}); // hold open
}

/**
 * Watch the open tabs and mark a job Applied the moment its confirmation appears.
 *
 * Jarvis deliberately never clicks Submit — but until now it also never NOTICED
 * that the user had, so every application had to be marked by hand and the
 * tracker drifted out of date. The process is already sitting idle holding the
 * browser open for review, so that time is spent watching instead of waiting.
 *
 * Detection is by the ATS's own confirmation wording, which is the only thing
 * that actually proves a submission went through — a URL change does not.
 */
export const SUBMITTED_RE = new RegExp([
  'your application (has been|was) submitted',
  'application (has been|was) (successfully )?submitted',
  // NOT "thank you for your interest in" — job descriptions routinely say that,
  // and matching it would mark a job Applied that was never submitted.
  'thank you for (applying|your application)',
  'we (have )?received your application',
  'you have already applied',
  'successfully submitted',
  'application complete',
].join('|'), 'i');

// The `store` parameter was declared, never used, and passed as an undefined
// variable at the call site — apply.mjs imports named functions from store.mjs
// and has no namespace binding. It threw ReferenceError AFTER the batch report
// printed, so every run looked successful and then died before the watcher
// started: submissions were never auto-marked Applied.
/**
 * The closing line of a watch run, or '' while there is still something to watch.
 *
 * Pure, exported and tested, because the fault was IN THE SENTENCE. A tab the
 * process could no longer watch shared a set with a tab that had actually been
 * submitted, so the run announced "All watched applications submitted" over a
 * form nobody had touched — and repeated it every four seconds.
 *
 * The rule this encodes: the word "submitted" may only ever be produced by
 * `submitted`. Anything else has to say what really happened.
 */
export function watchSummary(submitted, lost, total) {
  if (submitted + lost < total) return '';
  if (lost === 0) {
    return `\n  All ${submitted} watched application${submitted === 1 ? '' : 's'} submitted. Ctrl+C to exit.`;
  }
  if (submitted === 0) {
    return `\n  Lost track of ${lost === total ? 'every' : lost} watched tab${lost === 1 ? '' : 's'} — nothing was marked applied. Check them yourself. Ctrl+C to exit.`;
  }
  return `\n  Nothing left to watch: ${submitted} submitted, ${lost} lost track of (not marked applied). Ctrl+C to exit.`;
}

async function watchForSubmissions(entries) {
  const watched = entries.filter(e => e.page && e.job?.id);
  // TWO SETS, NOT ONE. These used to share a `done` set, so a tab this process
  // could no longer watch was counted as a tab that had been SUBMITTED — and
  // then announced with the word "submitted". Measured on Gradient Robotics,
  // 2026-09-01: the log said "All watched applications submitted" while the tab
  // was still open at /application with the Submit button untouched and the
  // store still reading `queued`.
  //
  // "I saw it submitted" and "I lost sight of it" are different claims, and the
  // difference is the one thing this engine has to be trusted about.
  const submitted = new Set();
  const lost = new Set();
  const seen = (id) => submitted.has(id) || lost.has(id);
  let announced = '';
  if (!watched.length) { await new Promise(() => {}); return; }

  for (;;) {
    for (const e of watched) {
      if (seen(e.job.id)) continue;
      if (typeof e.page.isClosed === 'function' && e.page.isClosed()) {
        lost.add(e.job.id);
        const j = getJob(e.job.id);
        console.log(`\n  ⚠ Lost track of this tab — ${j?.company || ''} · ${(j?.title || '').slice(0, 50)}`);
        console.log('     It was NOT marked applied. Check the tab yourself.');
        continue;
      }
      const hit = await e.page.evaluate(
        (src) => new RegExp(src, 'i').test(document.body?.innerText || ''),
        SUBMITTED_RE.source,
      ).catch(() => false);
      if (!hit) continue;

      submitted.add(e.job.id);
      const job = getJob(e.job.id);
      if (job) {
        setStatus(job.id, 'applied');
        updateJob(job.id, { applied_at: new Date().toISOString() });
        console.log(`\n  ✅ Submitted — ${job.company || ''} · ${(job.title || '').slice(0, 50)}`);
        console.log('     marked Applied in your tracker.');
      }
    }
    // Once per state change, not once per poll — the old line reprinted every
    // four seconds and printed five identical claims for one event.
    const line = watchSummary(submitted.size, lost.size, watched.length);
    if (line && line !== announced) { console.log(line); announced = line; }
    await new Promise(r => setTimeout(r, 4000));
  }
}

async function main() {
  const loginFlag = process.argv.indexOf('--login');
  if (loginFlag !== -1) return loginMode(process.argv[loginFlag + 1]);

  const opts = parseArgs();
  const profile = loadProfile(opts.test);

  // Build the work list: explicit URLs win; otherwise the queue.
  let items = [];
  if (opts.urls.length) {
    // A POSTING THE SCANNER HAS NEVER SEEN STILL NEEDS ITS TITLE.
    //
    // This used to be `findStoreJob(u) || { url: u, title: '', company: '' }`.
    // For an untracked posting the fallback won and the title was EMPTY, and
    // `familyFor` decides from the title first — so a Mechanical Design Engineer
    // posting silently got the all-rounder resume. `--url` is exactly the path
    // for a link someone sent him, so the applications he cares most about were
    // the ones guaranteed to lose the family.
    items = [];
    for (const u of opts.urls) {
      const stored = findStoreJob(u);
      if (stored) { items.push(stored); continue; }
      const meta = await fetchPostingMeta(u).catch(() => null);
      if (meta) {
        console.log(`  ${meta.title} — ${meta.company} (read from the ${meta.ats} API; not in the store)`);
        items.push({ url: u, title: meta.title, company: meta.company });
      } else {
        // Say it out loud. Silently defaulting the family is the fault itself.
        console.log(`  ⚠ ${u}`);
        console.log('    Not in the store, and its title could not be read from the ATS');
        console.log('    (Workday needs a session; other boards may be down). The resume family');
        console.log('    will be the default all-rounder rather than one chosen for this role.');
        items.push({ url: u, title: '', company: '' });
      }
    }
  } else {
    items = query({ status: 'queued' }, { limit: 500, sort: 'fit', full: true }).rows;
    if (opts.company) items = items.filter(j => (j.company || '').toLowerCase().includes(opts.company));
  }
  items = items.slice(0, opts.limit);
  if (!items.length) {
    console.log('Nothing to apply to. Queue jobs in the dashboard first, or pass --url <posting>.');
    return;
  }

  console.log(`Opening ${items.length} application(s) — the browser window is REAL and stays open for your review.`);
  console.log('Jarvis fills what it can, flags the rest, and never submits.\n');

  // Browser acquisition — ONE persistent Chrome, always, and it is the one you
  // signed into.
  //
  // This used to default to the engine's own profile (data/jarvis/browser-profile)
  // and only attach to the signed-in debug Chrome when you remembered to pass
  // --connect. Two profiles meant two Google sessions, and the default one had
  // never been signed in — so a run without the flag walked into a full Google
  // password wall and handed the application back. That is the "why do I keep
  // having to sign in" loop: it was not the same browser twice.
  //
  // Now attaching IS the default, the debug Chrome is launched automatically if
  // it is not up (its user-data-dir persists, so the Google session survives
  // reboots), and Google sees a normal browser rather than an automation-launched
  // one — which is the only way that SSO click works at all.
  //   --own-browser   use the engine's throwaway profile instead (no logins)
  //   --connect [port] pick a different CDP port
  const connectFlag = process.argv.indexOf('--connect');
  const ownBrowser = process.argv.includes('--own-browser');
  let context;
  if (!ownBrowser) {
    const port = (connectFlag !== -1 && Number(process.argv[connectFlag + 1])) || 9222;
      if (await realChromeBlocked(port)) {
        if (CLOSE_CHROME) {
          if (!await closeUserChrome()) {
            console.error('  Chrome would not close - shut it down yourself and re-run.');
            process.exit(1);
          }
        } else {
          console.error('');
          console.error('  Your Chrome is already running, and Chrome allows only one process per profile.');
          console.error('  Close every Chrome window (it will restore your tabs) and re-run this,');
          console.error('  or add --close-chrome and it will do that for you.');
          console.error(`  Either way it reopens YOUR profile - ${CHROME_PROFILE_DIR} - with automation`);
          console.error('  attached, so you stay signed in to Google and to any employer account you have.');
          process.exit(1);
        }
      }
    if (!(await cdpAlive(port))) {
      console.log(`  Starting your persistent Chrome (port ${port}, profile ${CHROME_PROFILE})...`);
      await launchDebugChrome(port);
    }
    const cdp = await connectWithRecovery(port).catch(err => {
      if (REAL_CHROME) {
        console.error('');
        console.error('  --real-chrome cannot work, and it is not your setup: since Chrome 136,');
        console.error('  remote debugging is REFUSED on the default user-data-dir. It is a');
        console.error('  deliberate mitigation against cookie theft over the DevTools port.');
        console.error('  (Measured here on Chrome 151: the browser starts normally and the port');
        console.error('  simply never opens, which is the ECONNREFUSED above.)');
        console.error('');
        console.error('  A NON-default directory is still allowed, so the fix is the other way');
        console.error('  round - bring your session to the engine profile, once:');
        console.error('      node jarvis/adopt-chrome-profile.mjs --close');
        console.error('  then run normally, without --real-chrome.');
        process.exit(1);
      }
      console.error(`\n  Could not start or attach to Chrome on port ${port}. Start it yourself:\n` +
        `  & "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port} --user-data-dir="$env:LOCALAPPDATA\\jarvis-chrome"\n` +
        `  then re-run.  (${err.message})`);
      process.exit(1);
    });
    context = cdp.contexts()[0] || await cdp.newContext();
    console.log('  Attached to your persistent Chrome (your real Google session).\n');
  } else {
    context = await chromium.launchPersistentContext(BROWSER_DIR, {
      headless: false, viewport: null, args: ['--start-maximized'],
    });
  }

  // ONE default, instead of a timeout argument on ninety call sites.
  //
  // Playwright's default action timeout is THIRTY SECONDS, and this pass found
  // the same defect four separate times: a bare `.check()` cost 30s on one
  // Texas Instruments consent box; unbounded `fill`/`isChecked`/`evaluate`/
  // `scrollIntoViewIfNeeded` inside one helper cost 128s on a single Lam
  // Research checkbox. Each was fixed where it was found, and a grep then
  // turned up roughly thirty more unbounded action calls across the adapters.
  //
  // Patching them individually is how this recurs a fifth time. Eight seconds
  // is far longer than any real form control needs to respond, and an element
  // that has not responded in eight seconds is one the escalation ladders are
  // there to handle. Call sites that pass an explicit timeout keep it —
  // deliberate long waits (the 20-25s first-paint waits) are unaffected.
  //
  // NAVIGATION is deliberately left alone: page.goto legitimately takes tens of
  // seconds on these SPAs and uses a separate default.
  context.setDefaultTimeout(8000);
  context.setDefaultNavigationTimeout(45000);

  const reports = [];
  for (const job of items) {
    const page = await context.newPage();
    try {
      await time('navigate', async () => {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // A backgrounded tab (common when attaching over CDP) makes Workday's SPA
        // throttle rendering so form fields never appear — keep it foregrounded.
        await page.bringToFront().catch(() => {});
      });
      // A board listing has no form on it — hop to the ATS it links out to
      // before choosing an adapter, or we fill the site's search box instead.
      let formUrl = job.url;
      if (!adapterFor(job.url) || adapterFor(job.url).id === 'generic') {
        const hop = await time('apply-hop', () => resolveApplyUrl(page));
        if (hop) {
          await time('apply-hop', () =>
            page.goto(hop, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}));
          // Did we actually ARRIVE? See bouncedToRoot() for what this catches.
          if (bouncedToRoot(job.url, page.url())) {
            console.log(`   Apply link bounced to ${page.url()} — going back to the posting`);
            await time('apply-hop', () =>
              page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}));
          } else {
            console.log(`   followed Apply link → ${hop}`);
            formUrl = hop;
          }
        }
      }
      const adapter = adapterFor(formUrl);
      let res = null;
      if (adapter) {
        const jobProfile = await time('resume-prep', () => prepareResume(job, profile));
        res = await time('fill', () => adapter.fill(page, jobProfile));
        // A run that filled nothing and said nothing is the worst report there
        // is — it looks exactly like a form with nothing to fill. `generic`
        // already explains itself; the four proven drivers call fill() directly
        // and never did, so a DEAD Ashby posting came back as a bare
        // "filled 0 field(s)". Ask the page what stopped us.
        if (res && !res.filled?.length && !res.needsInput?.length) {
          const b = await time('fill', () => pageBlocker(page));
          res.needsInput = [{
            label: 'Application form',
            why: b?.why ?? 'nothing on this page resolved to a field — open it and check the posting is still live',
            ...(b?.kind ? { blocker: b.kind } : {}),
          }];
        }
        // The ATS said on its own page that this req is gone. That is the same
        // evidence the enricher acts on, arriving through a different door, and
        // leaving it unrecorded means the posting stays in the deck and is
        // queued again. Both SmartRecruiters postings sampled this pass were
        // dead — Becton Dickinson and Intuitive Surgical — so this is not rare.
        const goneNow = res?.needsInput?.some(n => n.blocker === 'gone');
        if (goneNow && !opts.test && job.id) {
          updateJob(job.id, { goneAt: new Date().toISOString() }, { rederive: true });
          console.log('   the ATS says this posting is gone — marked, it will leave the deck');
        }
        await time('overlay', () => injectReviewOverlay(page, job, res));
      }
      reports.push({ job, res, page, phases: takePhases() });
      if (opts.test) {
        const shot = path.join(ROOT, 'data', 'jarvis', 'apply-test.png');
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        console.log(`   (test screenshot → ${shot})`);
      }
      if (!opts.test && job.id) {
        job.apply = {
          at: new Date().toISOString(),
          // The page the application actually ended on — the apply form itself,
          // not the posting. This is what the dashboard's Review tab links to, so
          // one click lands exactly where the work was left.
          url: page.url(),
          filled: res?.filled?.length ?? 0,
          resumeUploaded: !!res?.resumeUploaded,
          reachedReview: !!res?.filled?.some(f => /reached review/i.test(f.label || '')),
          needsInput: res?.needsInput ?? [],
          review: res?.review ?? [],
          skipped: res?.skipped ?? [],
        };
      }
    } catch (err) {
      reports.push({ job, error: err.message.split('\n')[0], phases: takePhases() });
      // keep going — one failure never stops the batch
    } finally {
      // Persist THIS application before starting the next one. The whole store
      // used to be rewritten once at the end, so a batch that crashed — or was
      // Ctrl-C'd after the interesting one — lost every record of what had
      // been filled. The body is untouched, so it is not rewritten.
      if (!opts.test && job.id) putJob(job, { description: false });
    }
  }

  console.log('\n════════ BATCH REPORT ════════');
  for (const r of reports) printReport(r);
  const okCount = reports.filter(r => !r.error).length;
  console.log(`\n${okCount}/${reports.length} application(s) open in the browser.`);

  // Where the batch actually spent its minutes. The per-application lines above
  // say which ONE was slow; this says which PHASE is worth optimising next.
  const totals = reports.reduce((acc, r) => (r.phases ? mergePhases(acc, r.phases) : acc), new Map());
  const wall = [...totals].filter(([k]) => !k.includes(':')).reduce((a, [, v]) => a + v.ms, 0);
  if (wall) {
    console.log(`\n──── WHERE THE TIME WENT (${reports.length} application(s), ${fmtMs(wall)} of engine time, ` +
      `${fmtMs(wall / reports.length)} each) ────`);
    console.log(formatPhases(totals, '  '));
    console.log('  (wd:* is a breakdown OF fill, not time on top of it. JARVIS_TIMING=0 to silence.)');
  }

  if (opts.test) {
    await context.close();
    console.log('(test mode — browser closed, nothing submitted, no real data used)');
  } else {
    console.log('\n➜ Review each tab, complete flagged fields, and click Submit yourself.');
    console.log('  Watching for your submissions — each one is marked Applied automatically.');
    console.log('  Ctrl+C here when done.');
    await watchForSubmissions(reports);
  }
}

// ONLY WHEN RUN AS A COMMAND.
//
// This used to call main() at import. Importing this module — which a test
// wanting to exercise one pure helper would reasonably do — would therefore
// launch a real browser and start filling real applications. F-181 was the same
// mistake in jarvis/backup.mjs, where it overwrote his backup file; here the
// blast radius is a browser opening real postings, which is worse.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
