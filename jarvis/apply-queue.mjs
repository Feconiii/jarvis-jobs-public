// jarvis/apply-queue.mjs — the next N postings an unattended apply run can actually complete.
//
// "it should have kept finding new postings instead of giving up" (his words,
// 2026-11-04). The apply run took the 74-pick inbox, found 12 forms it could
// fill without an account, and stopped at 10 submitted of the 15 he asked for,
// with 1,091 screened survivors never read. This hands the run N postings and
// does not stop short: inbox picks first, then the library's survivors read by
// the same reader (KEEP/MAYBE) until it has N — or it proves, with numbers,
// that fewer exist.
//
// A posting is queued only when all of these hold, checked cheap first:
//   · on a platform we fill without a sign-in, account, email code or bot
//     check (jarvis/ats-registry.json: automation "works", no walls) —
//     Workday, iCIMS, SuccessFactors, Taleo, Oracle, Phenom, Apple, Amazon,
//     Tesla and SmartRecruiters (bot check; Intuitive's fill stalled twice)
//     are not, and Eightfold only on an employer site the registry records
//     as clear (careers.micron.com, two filled and submitted 2026-11-04);
//   · not at a company he hid, and not past the Tesla cap;
//   · not work he said he does not want (thermal, 2026-11-05: "for thermal
//     jobs I think it's a waste of time, not my interest plus no expertise");
//   · never applied to, under this or another copy of the same role;
//   · live, by the platform's own API, checked right before it is queued;
//   · no required essay, where the platform shows its form (Greenhouse, Lever,
//     Ashby); elsewhere "form not pre-checked" is said, never assumed;
//   · a reader verdict of KEEP or MAYBE (inbox picks already have one).
// Every skip is said with its reason. No daily top-up cap: this is his
// explicit apply request.
//
//   node jarvis/apply-queue.mjs --want N [--json] [--no-library]

import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Platforms an unattended run completes: the registry's "works" with no walls. */
export function accountFreeVendors(registry = JSON.parse(readFileSync(path.join(HERE, 'ats-registry.json'), 'utf8'))) {
  return new Set(registry.vendors.filter((v) => v.automation === 'works' && !(v.walls || []).length && v.key !== 'tesla').map((v) => v.key));
}

/** Employer sites recorded as clear on a platform walled elsewhere (the registry's `clearHosts`): hostnames. */
export function clearHosts(registry = JSON.parse(readFileSync(path.join(HERE, 'ats-registry.json'), 'utf8'))) {
  return new Set(registry.vendors.flatMap((v) => (v.clearHosts || []).map((h) => String(h?.host || h).toLowerCase())));
}

/**
 * One role, however its copies are worded (review, 2026-11-04): the company
 * and the title's core, with its level dropped — "Mechanical Engineer II" and
 * "Mechanical Engineer" at one employer are one role to have applied to.
 */
const LEVEL_WORDS = /\b(i{1,3}|iv|[1-4]|jr|junior|sr|senior|entry level|entry|new grad(uate)?|early career|associate)\b/g;
export const titleCoreOf = (t) => String(t || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b[a-z]{0,3}-?\d{4,}\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').replace(LEVEL_WORDS, ' ').replace(/\s+/g, ' ').trim();
const companyKey = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|corp|corporation|co|company|ltd|technologies|technology)\b/g, '').replace(/\s+/g, ' ').trim();
export const roleKey = (job) => `${companyKey(job.company)}|${titleCoreOf(job.title)}`;

/** His hidden companies from the store's meta row. FAILS CLOSED (review): an unreadable list stops the queue. */
export function hiddenFrom(row) {
  if (!row) return new Set();   // he has hidden nothing yet
  let list;
  try { list = JSON.parse(row.v); } catch (e) { throw new Error(`his hidden-companies list could not be read (${e.message}) — nothing queued`); }
  if (!Array.isArray(list)) throw new Error('his hidden-companies list is not a list — nothing queued');
  return new Set(list.map((c) => String(c).toLowerCase().trim()));
}

/** Queued postings to look at by hand before Submit: form not pre-checked, or not confirmed open (review). */
export function checkByHand(queued = []) {
  return queued.filter((q) => q.form !== 'form checked: no required essay' || q.live !== 'live').map((q) => ({
    id: q.id, company: q.company, title: q.title,
    why: [q.form !== 'form checked: no required essay' ? 'its form was not pre-checked for a required essay' : '', q.live !== 'live' ? 'the platform did not confirm it is open' : ''].filter(Boolean).join('; '),
  }));
}

/** A required long-text question in a form schema is an essay; the resume, cover letter and "anything else" boxes are not. */
const NOT_AN_ESSAY = /resume|cv\b|cover\s*letter|covering\s+letter|letter\s+of\s+interest|additional\s+(information|comments)|anything\s+else|linkedin|website|portfolio|github/i;
// …only when the box IS that box (F-1013 #24, review 2026-11-05): unanchored,
// "Tell us about a project beyond your resume" read as the resume box and a
// required essay went into an unattended queue. A short label naming one of
// those, or one that starts with it.
const notAnEssay = (label) => NOT_AN_ESSAY.test(label)
  && (label.length <= 60 || /^\s*(?:resume|cv|cover|covering|letter|additional|anything|linkedin|website|portfolio|github)\b/i.test(label));
export function requiredEssays(questions = []) {
  return questions.filter((q) => q.required && q.long && !notAnEssay(String(q.label || ''))).map((q) => String(q.label || '').slice(0, 80));
}

/**
 * The queue itself, with every source and check passed in (the CLI wires the
 * real ones; tests pass fakes). Returns { queued, skipped, read, exhausted, proof }.
 */
export async function buildQueue({ want, inbox, library, vendorOf, allowed, clear = new Set(), hidden = new Set(), capped = null, interest = () => null,
  appliedBefore = () => false, liveness, formCheck, needsHim = null, read, batch = 10, log = () => {} }) {
  const queued = [];
  const needsYou = [];
  const skipped = [];
  const counts = {};
  const seen = new Set();
  const skip = (job, reason, where) => {
    skipped.push({ id: job.id, company: job.company, title: job.title, where, reason });
    const k = reason.replace(/\s*\(.*$/, '').replace(/:.*$/, '');
    counts[k] = (counts[k] || 0) + 1;
    log(`  skip  ${String(job.company).slice(0, 26).padEnd(26)} ${String(job.title).slice(0, 50).padEnd(50)} ${reason}`);
  };
  // The cheap checks, in order; the first that fails is the reason.
  const cheap = (job) => {
    const vendor = vendorOf(job.url, job.source);
    let host = '';
    try { host = new URL(job.url).hostname.toLowerCase(); } catch { /* not a URL */ }
    if (!allowed.has(vendor) && !clear.has(host)) return `${vendor === 'other' ? 'unknown platform' : vendor}: not fillable without a sign-in or account`;
    if (hidden.has(String(job.company || '').toLowerCase().trim())) return 'a company he hid';
    if (capped && capped.test(String(job.company || ''))) return 'past the Tesla cap';
    { const out = interest(job); if (out) return out.why; }
    if (appliedBefore(job)) return 'already applied (this or another copy of the role)';
    // Two copies of one role in one run (review): the second is not queued.
    if (queuedRoles.has(roleKey(job))) return 'a copy of a role already queued in this run';
    return '';
  };
  const queuedRoles = new Set();
  // Live and no required essay, right before queueing.
  const ready = async (job) => {
    const live = await liveness(job.url).catch(() => null);
    if (live?.result === 'expired') return { why: `closed: ${live.reason || 'the platform says the posting is gone'}` };
    const form = await formCheck(job).catch(() => ({ checked: false }));
    if (form?.essays?.length) return { why: `required essay: "${form.essays[0]}"` };
    // QUESTIONS ONLY HE CAN ANSWER (2026-11-04, Kairos): the planner left them
    // for him, so an unattended run cannot finish this form. Not queued; listed.
    const his = form?.fields?.length && needsHim ? await Promise.resolve().then(() => needsHim(job, form.fields)).catch((e) => [`(the planner could not read this form: ${String(e?.message || e).slice(0, 80)})`]) : [];
    if (his.length) {
      needsYou.push({ id: job.id, company: job.company, title: job.title, url: job.url, questions: his });
      return { why: `needs his answers: ${his.slice(0, 3).map((q) => `"${String(q).slice(0, 60)}"`).join(', ')}${his.length > 3 ? ` and ${his.length - 3} more` : ''}` };
    }
    // A form read only in part (Lever: its textareas, not its other required
    // questions) is not "checked" (F-1013 #24): checkByHand lists it for him.
    const formSaid = !form?.checked ? 'form not pre-checked'
      : form.partial ? 'form checked for essays only (its other required questions were not read)'
        : 'form checked: no required essay';
    return { live: live?.result === 'active' ? 'live' : 'liveness not confirmed by API', form: formSaid };
  };
  const take = (job, where, r) => {
    queuedRoles.add(roleKey(job));
    queued.push({ id: job.id, company: job.company, title: job.title, url: job.url, vendor: vendorOf(job.url, job.source), where, verdict: job.verdict || null, live: r.live, form: r.form });
    log(`  QUEUE ${String(job.company).slice(0, 26).padEnd(26)} ${String(job.title).slice(0, 50).padEnd(50)} ${where}; ${r.live}; ${r.form}`);
  };

  // 1. His inbox picks.
  for (const job of inbox) {
    if (queued.length >= want) break;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const no = cheap(job);
    if (no) { skip(job, no, 'inbox'); continue; }
    const r = await ready(job);
    if (r.why) { skip(job, r.why, 'inbox'); continue; }
    take(job, 'inbox', r);
  }

  // 2. The library, read by the same reader, until N or none left.
  let read_ = 0;
  let exhausted = queued.length >= want ? false : null;
  if (queued.length < want && library) {
    const pool = (await library()).filter((j) => !seen.has(j.id));
    let i = 0;
    while (queued.length < want && i < pool.length) {
      const ready_ = [];
      // Fill a batch with candidates that pass every check but the reader.
      while (ready_.length < batch && i < pool.length) {
        const job = pool[i++];
        seen.add(job.id);
        const no = cheap(job);
        if (no) { skip(job, no, 'library'); continue; }
        const r = await ready(job);
        if (r.why) { skip(job, r.why, 'library'); continue; }
        ready_.push({ job, r });
      }
      if (!ready_.length) break;
      const verdicts = await read(ready_.map((x) => x.job), want - queued.length);
      read_ += ready_.length;
      for (const { job, r } of ready_) {
        const v = verdicts.get(job.id);
        if (v === 'KEEP' || v === 'MAYBE') {
          if (queued.length < want) take({ ...job, verdict: v }, 'library (read now)', r);
        } else skip(job, v ? `the reader said ${v}` : 'the reader did not reach it', 'library');
      }
    }
    exhausted = queued.length < want && i >= pool.length;
  }
  const proof = queued.length >= want ? null : {
    asked: want, found: queued.length,
    inboxConsidered: inbox.length,
    libraryConsidered: [...seen].length - inbox.length,
    readByTheReader: read_,
    skippedBy: counts,
    libraryExhausted: !!exhausted,
  };
  return { queued, skipped, read: read_, exhausted: !!exhausted, proof, needsYou };
}

// ── the command ──────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) main().catch((e) => { console.error(e?.stack || e); process.exit(1); });

async function main() {
  const { guardArgs } = await import('./cli.mjs');
  guardArgs({
    usage: `  node jarvis/apply-queue.mjs --want N [--json] [--no-library]
  The next N postings an unattended apply run can complete: his inbox picks,
  then the library read by the same reader, until N or a proof that fewer exist.`,
    flags: ['--want', '--json', '--no-library'],
    valued: ['--want'],
  });
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  const want = Math.max(1, Math.min(100, Number(arg('want', 5)) || 5));
  const json = process.argv.includes('--json');
  const log = json ? () => {} : (m) => console.log(m);

  const { DatabaseSync } = await import('node:sqlite');
  const store = await import('./store.mjs');
  const dbPath = store.dbPath();
  const { vendorOf } = await import('./ats-report.mjs');
  const { CAPPED, libraryPool, curate, interestOut } = await import('./curate.mjs');
  const { checkLivenessViaApi } = await import('../liveness-api.mjs');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  // HIDDEN COMPANIES FAIL CLOSED (review): a list that cannot be read stops the
  // queue; it never quietly becomes "nothing hidden".
  const hidden = hiddenFrom(db.prepare("SELECT v FROM meta WHERE k = 'hiddenCompanies'").get());
  // ALREADY APPLIED, under any copy of the role (review): every applied row at
  // this employer — the statuses filtered in SQL, not cut at 25 — compared by
  // role key, so "Mechanical Engineer II" meets "Mechanical Engineer".
  // His STATUS says he sent it; `applied_at` is only when the engine filled a
  // form (serve.mjs), and a filled form he held back — Micron's SPC role,
  // 2026-11-04, kept for a resume rebuild — is not an application.
  // …at the employer under any spelling (F-1013 #6): "Figure" is "Figure AI".
  const { APPLIED_STATUSES, appliedRowsAt } = await import('./same-posting.mjs');
  const APPLIED = new Set(APPLIED_STATUSES);
  const appliedBefore = (job) => {
    if (APPLIED.has(String(job.status || ''))) return true;
    const key = roleKey(job);
    return appliedRowsAt(db, String(job.company || ''), String(job.id || '')).some((r) => roleKey({ company: job.company, title: r.title }) === key);
  };
  // WHICH FORMS NEED HIM: the form's own required questions, as the platform
  // publishes them, through the planner the fill uses. Any it leaves for him
  // (an export authorization, a salary range, days unavailable) keeps the
  // posting out of an unattended run. His profile must be readable for this.
  const { planForm, loadApplyProfile } = await import('./apply-plan.mjs');
  let profile;
  try { profile = loadApplyProfile(path.join(path.dirname(dbPath), 'apply-profile.yml')); }
  catch (e) { throw new Error(`his apply profile could not be read (${e.message}) — the queue cannot tell which forms need him`); }
  const needsHim = (job, fields) => {
    const asked = fields.filter((f) => f.required && f.type !== 'file');
    if (!asked.length) return [];
    const plan = planForm(asked, { ...profile, applyingTo: job.company }, { company: job.company });
    // A required one-line "Why X?" is planned as a written answer (F-1013 #24):
    // an essay all the same, and the queue takes none.
    return (plan.actions || []).filter((a) => (a.action === 'unknown' || a.action === 'essay') && !a.optional)
      .map((a) => (a.action === 'essay' ? `${a.label} (a written answer)` : a.label));
  };
  // His picks: reach cards after the plain fits, best fit first.
  const inbox = db.prepare(`SELECT id, url, source, company, title, location, status, applied_at, fit_score, pick_note FROM jobs
    WHERE status IN ('inbox','queued') AND gone_at IS NULL AND superseded_by IS NULL`).all()
    .sort((a, b) => (/^\s*Reach:/i.test(a.pick_note || '') ? 1 : 0) - (/^\s*Reach:/i.test(b.pick_note || '') ? 1 : 0) || (b.fit_score ?? 0) - (a.fit_score ?? 0));

  const library = process.argv.includes('--no-library') ? null : async () => libraryPool(dbPath, { limit: 5000, rescreen: false });
  // THE READER'S LOCK, ONE BATCH AT A TIME (review): taken only when the
  // library is actually read, released after every batch of ten — so a
  // scheduled 6:30 or 4:10 search that comes along waits minutes, not the
  // whole apply run, and is never skipped for it.
  let lockNote = '';
  const { dailyLockPath, takeDailyLock } = await import('./daily-lock.mjs');
  const lockFile = dailyLockPath(path.dirname(dbPath));
  let haveLock = false;
  const release = () => { try { if (haveLock && Number(readFileSync(lockFile, 'utf8')) === process.pid) unlinkSync(lockFile); } catch { /* gone */ } haveLock = false; };
  process.on('exit', release);
  // The same reader as the daily search; its picks are filed to his inbox as always.
  const read = async (jobs, need) => {
    const lock = await takeDailyLock(lockFile, {});
    if (!lock.ok) { lockNote = `the library was not read further: a daily search (pid ${lock.held}) held the reader for 20 minutes`; return new Map(); }
    haveLock = true;
    let r;
    try { r = await curate({ dbPath, candidates: jobs, taste: () => null, force: true, limit: jobs.length, stopAfter: need }); }
    finally { release(); }
    const out = new Map();
    for (const k of r.kept || []) out.set(k.id, 'KEEP');
    for (const m of r.maybe || []) out.set(m.id, 'MAYBE');
    for (const d of r.dropped || []) if (!out.has(d.id)) out.set(d.id, 'DROP');
    return out;
  };

  log(`apply queue: ${want} wanted — ${inbox.length} inbox picks first${library ? ', then the library' : ''}`);
  const result = await buildQueue({
    want, inbox, library, vendorOf, allowed: accountFreeVendors(), clear: clearHosts(), hidden, capped: CAPPED, interest: interestOut, appliedBefore,
    liveness: checkLivenessViaApi, formCheck: formSchema, needsHim, read, log,
  });
  db.close();
  release();
  if (lockNote) result.libraryNote = lockNote;
  result.checkByHand = checkByHand(result.queued);
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`\nqueued ${result.queued.length} of ${want}:`);
  for (const q of result.queued) console.log(`  ${q.company} — ${q.title}\n    ${q.url}\n    ${q.vendor}; ${q.where}; ${q.live}; ${q.form}`);
  // WHAT TO CHECK BY HAND BEFORE SUBMITTING (review): a form whose questions
  // could not be read ahead, or a posting its platform's API did not confirm live.
  const byHand = checkByHand(result.queued);
  if (byHand.length) {
    console.log('\ncheck by hand before you submit:');
    for (const b of byHand) console.log(`  ${b.company} — ${b.title}: ${b.why}`);
  }
  // NEEDS HIM (Kairos, 2026-11-04): required questions the planner leaves for
  // him. Not queued — an unattended run cannot finish them — but named, with
  // the questions, so he can answer them himself.
  if (result.needsYou?.length) {
    console.log('\nneeds your answers (not queued: an unattended run cannot finish these):');
    for (const n of result.needsYou) console.log(`  ${n.company} — ${n.title}\n    ${n.url}\n    ${n.questions.map((q) => String(q).slice(0, 90)).join('\n    ')}`);
  }
  if (lockNote) console.log(`\n${lockNote}`);
  if (result.proof) {
    const p = result.proof;
    console.log(`\nFEWER EXIST: ${p.found} of ${p.asked}. Considered ${p.inboxConsidered} inbox picks and ${p.libraryConsidered} library survivors${p.libraryExhausted ? ' (the whole pool)' : ''}; the reader read ${p.readByTheReader}.`);
    for (const [k, n] of Object.entries(p.skippedBy).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
}

// ── form schemas, where the platform shows them ──────────────────────

async function getJson(url, init = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12_000);
  try {
    const r = await fetch(url, { ...init, signal: c.signal, headers: { 'user-agent': 'career-ops-apply-queue/1.0', accept: 'application/json', ...(init.headers || {}) } });
    return r.ok ? (init.text ? r.text() : r.json()) : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** { checked, essays[] } from the platform's own form schema, or { checked: false }. */
export async function formSchema(job) {
  const url = String(job.url || '');
  let m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/i);
  if (m) {
    const j = await getJson(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}?questions=true`);
    if (!j?.questions) return { checked: false };
    // Every question as a form field the planner can answer (2026-11-04: Kairos
    // asked for a Part 810 export authorization, a salary range and days
    // unavailable — his to answer, so not a form an unattended run completes).
    const fields = j.questions.map((q) => {
      const f = (q.fields || [])[0] || {};
      const type = (q.fields || []).some((x) => x.type === 'input_file') ? 'file'
        : /multi_value_single_select/.test(f.type) ? 'select' : /multi_value_multi_select/.test(f.type) ? 'checkbox-group'
          : f.type === 'textarea' ? 'textarea' : 'text';
      return { label: q.label, required: !!q.required, type, name: f.name || '', options: (f.values || []).map((v) => String(v.label ?? v.value ?? '')) };
    });
    return { checked: true, essays: requiredEssays(j.questions.map((q) => ({ label: q.label, required: !!q.required, long: (q.fields || []).some((f) => f.type === 'textarea') && !(q.fields || []).some((f) => f.type === 'input_file') }))), fields };
  }
  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (m) {
    const body = { operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: m[1], jobPostingId: m[2] },
      query: 'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { applicationForm { sections { fieldEntries { field isRequired } } } } }' };
    const j = await getJson('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const sections = j?.data?.jobPosting?.applicationForm?.sections;
    if (!Array.isArray(sections)) return { checked: false };
    const entries = sections.flatMap((s) => s.fieldEntries || []);
    const qs = entries.map((e) => ({ label: e.field?.title, required: !!e.isRequired, long: /long\s*text/i.test(String(e.field?.type || '')) }));
    const fields = entries.map((e) => {
      const t = String(e.field?.type || '');
      const type = /file/i.test(t) ? 'file' : /valueselect|multivalue/i.test(t) ? 'select' : /boolean/i.test(t) ? 'select' : /long\s*text/i.test(t) ? 'textarea' : 'text';
      const opts = (e.field?.selectableValues || []).map((v) => String(v.label ?? v.value ?? ''));
      return { label: e.field?.title, required: !!e.isRequired, type, name: e.field?.path || '', options: /boolean/i.test(t) && !opts.length ? ['Yes', 'No'] : opts };
    });
    return { checked: true, essays: requiredEssays(qs), fields };
  }
  m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (m) {
    const html = await getJson(`https://jobs.lever.co/${m[1]}/${m[2]}/apply`, { text: true, headers: { accept: 'text/html' } });
    if (!html) return { checked: false };
    // Lever's custom questions: a required textarea with its question text before it.
    const qs = [...String(html).matchAll(/<div class="application-label[^"]*">([\s\S]*?)<\/div>[\s\S]{0,600}?<textarea[^>]*?(required)?[^>]*>/gi)]
      .map((x) => ({ label: x[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), required: !!x[2] || /✱|\*\s*$/.test(x[1]), long: true }));
    return { checked: true, partial: true, essays: requiredEssays(qs) };
  }
  return { checked: false };
}
