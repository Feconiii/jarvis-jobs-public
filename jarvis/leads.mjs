/**
 * LEADS — press Outreach on an application, and Jarvis goes and finds the
 * people.
 *
 * Alex, 2026-09-15: "i go to my applications, i press outreach button and you
 * go find me lead and display it right in the terminal for that job and i will
 * figure out the rest."
 *
 * `outreach.mjs` deliberately stopped at a SEARCH SPEC, because a posting
 * almost never names a human (1.4% of 3,700 measured). The people are findable
 * anyway — the same day, three research agents found credible contacts for 22
 * of his 25 applications from company sites, press and public search results.
 * This module is that research, one job at a time, on a button.
 *
 * It runs the local `claude` CLI with web search and web fetch as its ONLY
 * tools: no file access, no shell, no browser, nothing that can send. The
 * answer is JSON, and it is SANITISED before it reaches the page:
 *
 *   · a link that is not http(s) is dropped;
 *   · an email survives only with the public page it was published on — no
 *     guessed addresses, ever (OUTREACH.md §5: a wrong-guess bounce is itself
 *     a spam signal);
 *   · anything shaped like a phone number is cut out of the prose;
 *   · at most five people, because a list of twenty is a volume play.
 *
 * NOTHING HERE SENDS OR SAVES A CONTACT. The leads are shown; he chooses. A
 * lead becomes a ledger row only when he presses "Save to tracker", and then it
 * goes through the same one-person-per-role gate as everything else.
 */
import { openDb } from './db.mjs';
import { dbPath as storeDbPath } from './store.mjs';
import { run, describeFailure } from './tailor-llm.mjs';

const dbFile = () => storeDbPath();

const DDL = `
CREATE TABLE IF NOT EXISTS lead_runs (
  job_id      TEXT PRIMARY KEY,
  -- 'running' | 'done' | 'failed'
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT,
  error       TEXT NOT NULL DEFAULT ''
);
`;

const SCHEMA_DONE = new Set();
function db(dbPath = dbFile()) {
  const handle = openDb(dbPath);
  if (!SCHEMA_DONE.has(dbPath)) { handle.exec(DDL); SCHEMA_DONE.add(dbPath); }
  return handle;
}

/** A run is minutes of web research; past this it is not coming back. */
export const RESEARCH_TIMEOUT_MS = 12 * 60 * 1000;
/** Two at once. A third press waits its turn rather than starting a third CLI. */
export const MAX_CONCURRENT = 2;
export const MAX_PEOPLE = 5;

const PERSONAS = new Set(['manager', 'team', 'recruiter', 'alumni']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * THE PROMPT. Pure and exported so its rules are asserted in a test: the
 * privacy rules here are a control, not a style choice.
 */
export function buildLeadsPrompt(job, { description = '', hardBlock = false } = {}) {
  const jd = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  return `Research task. You may only search and read public web pages. Do not log in anywhere, do not send anything.

Alex Rivera is a mechanical engineering student at State University (Springfield, WA), graduating May 2027, on an F-1 visa (OPT after graduation). He has applied, or is about to apply, to the job below and wants to reach out personally to the people most likely involved in hiring for it. Find the best 2 to 4 real people who work at the company NOW, in this priority order:

1. The hiring manager, or the lead of the team this role sits in (at a small company this is often a founder, CTO, or head of hardware / manufacturing / mechanical engineering).
2. A recruiter or talent partner who hires engineers there (technical, university or early-career recruiting).
3. An engineer on that team who has publicly posted about hiring for this kind of role.
4. A State University alum at the company in a related engineering group.

THE JOB
Company: ${job.company || ''}
Title: ${job.title || ''}
Team: ${job.team || 'not stated'}
Location: ${job.location || 'not stated'}
Posting: ${job.url || 'no link'}
Posting text (may be truncated): ${jd || 'not available; open the posting link'}

HOW TO RESEARCH
Read the posting (it may name a team or reporting line), the company's team/about/leadership pages, press releases, founder interviews, conference talks, company blog authors, and public search-engine results for LinkedIn or X profiles. Use search results for LinkedIn; do not try to log in or scrape it. Confirm each person is at the company now, with evidence from 2025 or 2026, and plausibly connected to this role. Prefer one strong, relevant person over several weak ones. Do not pad the list.

CONTACT INFORMATION RULES (strict)
- Public professional information only: name, current title, a public profile URL (LinkedIn, X, personal or company page).
- An email address only if the person or the company published it publicly, and give the URL where it is published. Never guess or construct an individual email address.
- Never include phone numbers, home addresses, personal emails, or anything from data-broker or people-search sites (ZoomInfo, RocketReach, ContactOut, Apollo, Spokeo and similar).
- A published general careers or recruiting inbox for the company is fine.

ELIGIBILITY CHECK
"warnings" is ONLY for real problems that could stop him — leave it an empty list when you find none, and put "nothing rules him out" or "no recruiter found" in "notes", not in warnings. Check whether the posting is closed; whether it requires US citizenship, a security clearance, ITAR/export-control access, or says it will not sponsor visas; whether the company's work is defense or military; and whether the posting's graduation window or years of experience rule out a May 2027 graduate.${hardBlock ? ' Jarvis has already flagged this posting as blocked for his visa status; confirm or correct that.' : ''}

Also give one short, verifiable hook for a personalised message (a recent launch, funding, a talk the hiring manager gave, something from the posting), with its source URL.

Answer with ONLY one JSON object, no prose before or after it:
{"people":[{"name":"","title":"","persona":"manager|team|recruiter|alumni","why":"one line: why this person for this role","profile_url":"","public_email":"","email_source_url":"","evidence_url":"","confidence":"high|medium|low"}],"hook":"","hook_source":"","careers_email":"","warnings":[""],"notes":"what you could not find, and the best next step"}`;
}

const isHttp = (u) => /^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim());
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;
// US-style and international phone numbers written in prose. Deliberately
// broad: a false cut of a figure in a hook costs a few characters; a phone
// number on the page is exactly what this module promises never to show.
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/** Trimmed at a word, never mid-word, so a cut line still reads as a sentence. */
const clean = (s, max = 400) => {
  const t = String(s ?? '').replace(PHONE, '[number removed]').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
};

/** The first balanced JSON object in the CLI's output. */
function firstJsonObject(text) {
  const s = String(text || '');
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return null;
}

/**
 * Parse and SANITISE the research answer. Returns null when there is no JSON to
 * be had; otherwise a clean object, whatever the model put in it.
 */
export function parseLeads(stdout) {
  const raw = firstJsonObject(stdout);
  if (!raw || typeof raw !== 'object') return null;
  const people = [];
  for (const p of Array.isArray(raw.people) ? raw.people : []) {
    const name = clean(p?.name, 120);
    if (!name) continue;
    const emailOk = EMAIL.test(String(p?.public_email || '').trim()) && isHttp(p?.email_source_url);
    people.push({
      name,
      title: clean(p?.title, 200),
      persona: PERSONAS.has(p?.persona) ? p.persona : 'team',
      why: clean(p?.why, 460),
      profile_url: isHttp(p?.profile_url) ? String(p.profile_url).trim() : '',
      public_email: emailOk ? String(p.public_email).trim() : '',
      email_source_url: emailOk ? String(p.email_source_url).trim() : '',
      evidence_url: isHttp(p?.evidence_url) ? String(p.evidence_url).trim() : '',
      confidence: CONFIDENCE.has(p?.confidence) ? p.confidence : 'low',
    });
    if (people.length >= MAX_PEOPLE) break;
  }
  const careers = clean(raw.careers_email, 200);
  return {
    people,
    hook: clean(raw.hook, 500),
    hook_source: isHttp(raw.hook_source) ? String(raw.hook_source).trim() : '',
    // A careers inbox is a company address, so it may be shown — but only if
    // it actually contains an address, not a sentence about one.
    careers_email: /@/.test(careers) ? careers : '',
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map((w) => clean(w, 300)).filter(Boolean).slice(0, 6),
    notes: clean(raw.notes, 900),
  };
}

/** The CLI, with the web and nothing else. */
export async function askResearch(prompt, { bin = 'claude', timeoutMs = RESEARCH_TIMEOUT_MS } = {}) {
  const args = ['-p', '--permission-mode', 'dontAsk', '--allowedTools', 'WebSearch', 'WebFetch'];
  const { stdout } = await run(bin, args, { input: prompt, timeout: timeoutMs });
  return String(stdout || '');
}

// ── the run ledger ───────────────────────────────────────────────────

/** In this process. A 'running' row with no entry here was cut off by a restart. */
const ACTIVE = new Map();
const QUEUE = [];

function rowToRun(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { /* a torn write reads as no result */ }
  return { jobId: row.job_id, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, result, error: row.error || '' };
}

export function getLeadRun(jobId, { dbPath = dbFile() } = {}) {
  const run0 = rowToRun(db(dbPath).prepare('SELECT * FROM lead_runs WHERE job_id = ?').get(String(jobId)));
  // A RUN THE SERVER NO LONGER OWNS IS NOT RUNNING. The dashboard restarts;
  // without this a card would say "finding leads…" forever.
  if (run0?.status === 'running' && !ACTIVE.has(run0.jobId) && !QUEUE.some((q) => q.jobId === run0.jobId)) {
    return { ...run0, status: 'failed', error: 'interrupted — the dashboard restarted while this was running. Press it again.' };
  }
  return run0;
}

/** One line per job for the board: is anything running, and how many leads. */
export function leadSummary({ dbPath = dbFile() } = {}) {
  const out = {};
  for (const row of db(dbPath).prepare('SELECT job_id, status, result FROM lead_runs').all()) {
    const r = getLeadRun(row.job_id, { dbPath });
    out[row.job_id] = { status: r.status, count: r.result?.people?.length || 0, warnings: r.result?.warnings?.length || 0 };
  }
  return out;
}

function write(jobId, fields, dbPath) {
  const now = new Date().toISOString();
  db(dbPath).prepare(`INSERT INTO lead_runs (job_id, status, started_at, finished_at, result, error)
      VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, started_at = COALESCE(excluded.started_at, lead_runs.started_at),
      finished_at = excluded.finished_at, result = COALESCE(excluded.result, lead_runs.result), error = excluded.error`)
    .run(String(jobId), fields.status, fields.startedAt || now, fields.finishedAt || null,
      fields.result === undefined ? null : JSON.stringify(fields.result), fields.error || '');
}

function pump(dbPath) {
  while (ACTIVE.size < MAX_CONCURRENT && QUEUE.length) {
    const next = QUEUE.shift();
    ACTIVE.set(next.jobId, next);
    next.work().finally(() => { ACTIVE.delete(next.jobId); pump(dbPath); });
  }
}

/**
 * Start (or queue) the research for one job. Returns immediately with the run
 * as it now stands; the page polls `getLeadRun`.
 *
 * @param job          the job row (company, title, team, location, url)
 * @param description  the stored posting text
 * @param ask          (prompt) => stdout — injectable for tests
 */
export function startLeadRun(job, { description = '', hardBlock = false, ask = askResearch, refresh = false, dbPath = dbFile(), bin = 'claude' } = {}) {
  const jobId = String(job?.id || '');
  if (!jobId) throw new Error('a lead run needs a job');
  const current = getLeadRun(jobId, { dbPath });
  if (ACTIVE.has(jobId) || QUEUE.some((q) => q.jobId === jobId)) return current;
  if (current?.status === 'done' && !refresh) return current;

  const startedAt = new Date().toISOString();
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    write(jobId, { status: 'failed', startedAt, finishedAt: startedAt, error: 'research switched off (JARVIS_TAILOR=off)' }, dbPath);
    return getLeadRun(jobId, { dbPath });
  }
  write(jobId, { status: 'running', startedAt, result: current?.result ?? undefined }, dbPath);
  const prompt = buildLeadsPrompt(job, { description, hardBlock });
  QUEUE.push({
    jobId,
    work: async () => {
      try {
        const stdout = await ask(prompt, { bin, timeoutMs: RESEARCH_TIMEOUT_MS });
        const result = parseLeads(stdout);
        if (!result) {
          write(jobId, { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: 'the research came back without a readable answer — press it again' }, dbPath);
          return;
        }
        write(jobId, { status: 'done', startedAt, finishedAt: new Date().toISOString(), result }, dbPath);
      } catch (e) {
        write(jobId, { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: describeFailure(e, bin, 'lead research', RESEARCH_TIMEOUT_MS).replace(/ — resume ships.*$/, '') }, dbPath);
      }
    },
  });
  pump(dbPath);
  return getLeadRun(jobId, { dbPath });
}

/** For tests: wait until nothing is running or queued. */
export async function idle() {
  while (ACTIVE.size || QUEUE.length) await new Promise((r) => setTimeout(r, 20));
}
