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
import { outreachDb, outreachDbPath } from './outreach-db.mjs';
import { run, describeFailure, ownsExamples, personLine, graduation, schoolShort, authLine, writingFor } from './tailor-llm.mjs';
import { person } from './targeting.mjs';

/**
 * Who the research is for, said from the profile. For him the sentences are
 * exactly what they always were; for anyone else nothing of his — school,
 * visa, past employer — can reach the prompt.
 */
function whoFor(p = person) {
  if (ownsExamples(p)) {
    return {
      intro: 'Alex Rivera is a senior mechanical engineering student at Lakeside University (Springfield, WA), graduating May 2027, on an F-1 visa (OPT after graduation).',
      hookTies: 'Lakeside, a shared past employer such as Applied Materials',
      alum: 'a Lakeside alum',
      alumFirst: 'a Lakeside alum who is on the team',
      personalTies: 'a shared school (Lakeside) or shared past employer (Applied Materials)',
      degreeTie: 'unless it is from Lakeside',
      field: 'engineering',
      eligibility: 'Check whether the posting is closed; whether it requires US citizenship, a security clearance, ITAR/export-control access, or says it will not sponsor visas; whether the company\'s work is defense or military; and whether the posting\'s graduation window or years of experience rule out a May 2027 graduate.',
      blocked: ' Jarvis has already flagged this posting as blocked for his visa status; confirm or correct that.',
    };
  }
  const school = schoolShort(p);
  const g = graduation(p);
  const auth = authLine(p);
  const w = writingFor(p);
  const status = p.needsSponsorship
    ? 'whether it requires US citizenship, a security clearance, ITAR/export-control access, or says it will not sponsor visas'
    : p.workAuth === 'citizen'
      ? 'whether it requires an active security clearance already held'
      : 'whether it requires US citizenship or a security clearance';
  return {
    intro: `${personLine(p)}${auth ? ` Work authorization: ${auth}.` : ''}`,
    hookTies: `${school ? `${school}, ` : ''}a shared past employer from their CV`,
    alum: school ? `a ${school} alum` : 'an alum of their school',
    alumFirst: school ? `a ${school} alum who is on the team` : 'an alum who is on the team',
    personalTies: `a shared school${school ? ` (${school})` : ''} or a shared past employer`,
    degreeTie: school ? `unless it is from ${school}` : 'unless it is a shared school',
    field: w.field || 'the field',
    eligibility: `Check whether the posting is closed; ${status}; and whether the posting's graduation window or years of experience rule out ${g.done ? `someone who graduated ${g.label}` : `a ${g.label} graduate`}.`,
    blocked: ' Jarvis has already flagged this posting as blocked for their work authorization; confirm or correct that.',
  };
}

// Its own file, not jobs.db: a scan must never make this button wait (F-597).
const dbFile = () => outreachDbPath();

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
-- Jobs he took OFF the Outreach tab. The research is kept, so pressing
-- Outreach on the card again brings the job back without searching twice.
CREATE TABLE IF NOT EXISTS outreach_removed (
  job_id      TEXT PRIMARY KEY,
  removed_at  TEXT NOT NULL
);
`;

const db = (dbPath = dbFile()) => outreachDb(dbPath, { ddl: DDL, legacy: ['lead_runs'] });

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
export function buildLeadsPrompt(job, { description = '', hardBlock = false, known = [], today = new Date() } = {}) {
  const jd = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  const day = today.toISOString().slice(0, 10);
  const saved = (known || []).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 5);
  const W = whoFor();
  return `Research task. You may only search and read public web pages. Do not log in anywhere, do not send anything.

Today is ${day}.

${W.intro} He has applied, or is about to apply, to the job below and wants to message the people who could give him an honest opinion on whether he fits the team. He can send very few messages, so each one has to count.

WHAT HE WANTS: THREE EXCELLENT LEADS
An excellent lead has PUBLIC EVIDENCE that they read and answer messages. In order of strength:
1. INVITED: they wrote a post asking candidates to message them, send a resume, or ask for a referral ("DM me", "send me your resume", "happy to refer", "my team is hiring, reach out") for this team, this role, or this kind of role.
2. ACTIVE: they post or comment on LinkedIn regularly, with two or more posts or comments of their OWN in the last 6 weeks, so they are on the platform and see their messages.
3. RELEVANT POST: they wrote a post about this team's work, its product, or the engineering this role does (a build, a launch, a test result, a problem they solved).
Look for these FIRST, before looking anyone up by title. Search engines index LinkedIn posts; queries like these work:
  site:linkedin.com/posts "${job.company || ''}" (hiring OR "DM me" OR "send me your resume" OR "reach out" OR referral)
  site:linkedin.com/posts "${job.company || ''}" ${[job.team, job.title].filter(Boolean).join(' ') || W.field}
  site:linkedin.com/posts "<a person's name>"   (to see how often someone posts, and when)
A LinkedIn post URL names its AUTHOR: linkedin.com/posts/<author-profile-slug>_... Use it to tell the author from someone who reposted it.
Build the list from the people these searches turn up. Fill a slot with someone who has none of this evidence only when no excellent lead exists for this job, and say so in "why".

CHOOSE BY EXPECTED REPLY VALUE, NOT BY TITLE
Find 8 to 12 plausible people who work at the company NOW, then narrow them to the BEST 3. Score each finalist 1 to 5 on:
- proximity: how close they are to this role's work (the team's manager, an engineer on the same team, the recruiter for that org, an adjacent technical lead). An unrelated team scores 1.
- hook: whether there is a REAL reason to write to this person specifically (their work, a recent post of theirs, ${W.hookTies}, technical overlap with his work). "Impressive background" is not a hook and scores 1.
- reply: how likely they are to answer (posts like a normal person, engages with students or comments, is not a public figure). No posts at all is NOT a bad sign: score it 3, not 1.
- help: whether they could realistically judge his fit, forward his resume, tell the hiring manager, or point him to the right person.
- competition: how buried they are in messages. A founder, a celebrity executive, a VP with a huge following, or a generic recruiter with no tie to this role scores 1; an engineer with a few hundred connections scores 5.
Penalise heavily: founders and celebrity executives, people with huge followings, generic recruiters with no connection to this role, people on unrelated teams, and anyone whose only possible personalisation is their impressive background.

Make the three DIFFERENT KINDS of lead where you can, so he has three paths in:
- "decision": closest to the hiring decision (hiring manager, team manager, technical lead)
- "technical": the most approachable engineer doing this work or closely related work
- "alternate": the strongest other connection (the recruiter for this org, ${W.alum}, a former intern turned engineer, another real tie)
These are not rigid: ${W.alumFirst} can be the first pick, a hiring manager with no public activity still counts when they clearly own the team, and a recruiter who posted this exact job yesterday can beat an engineer with no tie to it.

PUBLIC INVITATIONS ARE THE BEST EVIDENCE
Someone at this company who RECENTLY and PUBLICLY invited candidates ("we're hiring, DM me", "send me your resume", "happy to refer", "my team is growing, message me") has already said yes to this message. Search for those posts (LinkedIn through search-engine results, X, company or personal pages) for this team, this role, or this kind of role. Search by the TEAM's own name as the posting writes it, with hiring words ("<team> hiring", "<team>" "my team is hiring", "join my team" "<team>"); the search tool ignores site: operators, so put "linkedin" in the words instead. When the evidence is a LinkedIn post, give the post's own linkedin.com/posts/… URL as signal.url and evidence_url: the server reads every cited post at the source and corrects its author and date, and a reshared post leads it to the original writer.

DATES DECIDE WHETHER A POST COUNTS
Recency matters when the activity itself is the evidence: a hiring post 0-2 weeks old is a strong signal, 2-6 weeks still useful, 2-3 months weak, 4 months or more is NOT current hiring evidence. Give the date of every post you cite (YYYY-MM-DD, or YYYY-MM if that is all the page shows). Work out a LinkedIn date from the page itself, or from a relative age ("3w", "2mo") against today's date. Report an old post with its real date and do not present it as current. If you cannot find a post's date, leave the date empty. Never guess a date.

REPOSTS: THE AUTHOR IS THE PERSON WHO WROTE IT
On LinkedIn a repost shows the reposter's name above the original post, and search snippets often run the two together. The words in a post belong ONLY to its original author. If Person A reposted Person B's "we're hiring, send me your resume", then B is the one inviting resumes; A only shared it. Always put the ORIGINAL author's name in "author". If the original author works at this company, they are usually the better lead: list them. Never credit a reposter with the author's words, title, team or offer.

SOMETHING PERSONAL, FROM THEM
For each person give one specific, verifiable thing about THEM: something they built or shipped, a talk, a paper, a patent, a post THEY wrote (not a repost), ${W.personalTies}, with the source URL. Their current job title, headline or employer is NOT a personal detail; neither is a degree on its own ${W.degreeTie}. Leave it empty when there is nothing you can source. Never use "I saw your profile" material, and never anything personal outside their work.
${saved.length ? `\nHE HAS ALREADY SAVED THESE PEOPLE for this job. Include each of them in "people" (still at the company or not), with the same signal, date and personal checks: ${saved.join('; ')}.\n` : ''}

THE JOB
Company: ${job.company || ''}
Title: ${job.title || ''}
Team: ${job.team || 'not stated'}
Location: ${job.location || 'not stated'}
Posting: ${job.url || 'no link'}
Posting text (may be truncated): ${jd || 'not available; open the posting link'}

HOW TO RESEARCH
Read the posting (it may name a team or reporting line), the company's team/about pages, press releases, conference talks, company blog authors, patents, and public search-engine results for LinkedIn or X profiles and posts. Use search results for LinkedIn; do not try to log in or scrape it. Confirm each person is at the company now, with evidence from 2025 or 2026, and plausibly connected to this role. Return at most 3 people (plus anyone he already saved). Fewer strong people beat a padded list.

CONTACT INFORMATION RULES (strict)
- Public professional information only: name, current title, a public profile URL (LinkedIn, X, personal or company page).
- An email address only if the person or the company published it publicly, and give the URL where it is published. Never guess or construct an individual email address.
- Never include phone numbers, home addresses, personal emails, or anything from data-broker or people-search sites (ZoomInfo, RocketReach, ContactOut, Apollo, Spokeo and similar).
- A published general careers or recruiting inbox for the company is fine.

ELIGIBILITY CHECK
"warnings" is ONLY for real problems that could stop him — leave it an empty list when you find none, and put "nothing rules him out" or "no recruiter found" in "notes", not in warnings. ${W.eligibility}${hardBlock ? W.blocked : ''}

Also give one short, verifiable hook for a personalised message (a recent launch, funding, a talk the hiring manager gave, something from the posting), with its source URL.

Answer with ONLY one JSON object, no prose before or after it:
{"considered":0,"people":[{"name":"","title":"","persona":"manager|team|recruiter|alumni","lead_type":"decision|technical|alternate","why":"why this person made the top 3","usefulness":"what they could realistically do for him","scores":{"proximity":0,"hook":0,"reply":0,"help":0,"competition":0},"profile_url":"","public_email":"","email_source_url":"","evidence_url":"","confidence":"high|medium|low","signal":{"kind":"invited|hiring_post|relevant_post|none","quote":"the post's own words, at most 200 characters","url":"","date":"YYYY-MM-DD","author":"full name of whoever WROTE the post"},"activity":{"recent_posts":0,"latest":"YYYY-MM-DD","url":""},"personal":{"text":"one specific thing about them","source_url":"","date":""}}],"hook":"","hook_source":"","careers_email":"","warnings":[""],"notes":"what you could not find, and the best next step"}

"signal" is the ONE strongest post of theirs: "invited" asks candidates to message them, send a resume, or offers a referral; "hiring_post" only announces an opening; "relevant_post" is about the team's work, product or this role's engineering; "none" means you found no such post, and the other signal fields stay empty.
"activity" is how often they post: "recent_posts" counts the posts or comments WRITTEN BY THEM that you actually saw dated within the last 6 weeks (reposts do not count), "latest" is the date of their newest one, "url" is where you saw it. Leave it all empty (0, "", "") when you could not see their activity. Never estimate a count you did not see.`;
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

// ── what they said in public, and when (2026-09-26) ──────────────────
//
// Alex: "it should try to lean on people publicly expressing interest in
// responding or telling people to send over resume or message or referral, it
// should also take into account posting age, if sb says we hiring but its 6
// months ago its useless, also a lot of ppl repost stuff from their company,
// DO NOT MIX UP OG POSTER VERSUS PERSON BEING REPOSTED".
//
// The model reports the post, its date and its author; THIS CODE decides what
// it is worth. A date is never guessed here: an undated post is weak, not
// fresh. A post whose author is not the person is a repost, and the invitation
// in it is the author's, never theirs.

/**
 * HIS BANDS (2026-09-27): "a hiring post from 0-2 weeks ago = strong signal,
 * 2-6 weeks = still useful, 2-3 months = weak signal, 4+ months = do not treat
 * as current hiring evidence". No study measures it (2026-09-26 research); the
 * proxies agree on weeks, not months: interview loops run about 18 days
 * (Ashby), recruiters stop reading after 250-500 applicants.
 */
export const FRESH_DAYS = 14;
export const RECENT_DAYS = 42;
/** Past this, "we're hiring" is not current hiring evidence at all. */
export const STALE_DAYS = 120;
const SIGNAL_KINDS = new Set(['invited', 'hiring_post', 'relevant_post', 'none']);

const HONORIFIC = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'phd', 'pe', 'mba', 'jr', 'sr', 'ii', 'iii']);
const foldName = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
/**
 * Every name one person goes by. "Casey Hart (formerly Casey Lane)" is
 * two, and her own post signed "Casey Hart" was marked a repost until this
 * read the bracket (2026-09-26). Titles and suffixes are not names.
 */
function aliases(name) {
  const s = String(name || '');
  const inBrackets = [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].replace(/^\s*(?:formerly|née|nee|born|aka|also)\s+/i, ''));
  return [s.replace(/\([^)]*\)/g, ' '), ...inBrackets]
    .map((n) => foldName(n).split(' ').filter((w) => w.length > 1 && !HONORIFIC.has(w)))
    .filter((w) => w.length);
}
/** "Jane Q. Doe", "Dr. Jane Doe" and "Jane Doe" are one person; "Jane Doe" and "John Doe" are not. */
export function samePerson(a, b) {
  for (const x of aliases(a)) {
    for (const y of aliases(b)) {
      if (x[0] === y[0] && x[x.length - 1] === y[y.length - 1]) return true;
    }
  }
  return false;
}

/** "2026-09-14" or "2026-09" → a Date; anything else → null. Never a guess. */
function postDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 15));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The signal as the page should read it:
 *   fresh     — invited or announced, ≤ FRESH_DAYS old, written by this person
 *   recent    — the same, ≤ RECENT_DAYS old
 *   weak      — ≤ STALE_DAYS old: a real post, but never "recent"
 *   stale     — older than STALE_DAYS: shown with its date, not hiring evidence
 *   undated   — no date could be found: weak
 *   reposted  — the words are someone else's; `author` says whose
 */
export function readSignal(sig, personName, now = new Date()) {
  if (!sig || typeof sig !== 'object') return null;
  const kind = SIGNAL_KINDS.has(sig.kind) ? sig.kind : 'none';
  if (kind === 'none') return null;
  const author = clean(sig.author, 120);
  const date = postDate(sig.date);
  const ageDays = date ? Math.max(0, Math.floor((now - date) / 86400e3)) : null;
  const reposted = !!author && !samePerson(author, personName);
  const standing = reposted ? 'reposted'
    : ageDays == null ? 'undated'
      : ageDays <= FRESH_DAYS ? 'fresh'
        : ageDays <= RECENT_DAYS ? 'recent'
          : ageDays <= STALE_DAYS ? 'weak' : 'stale';
  return {
    kind, standing,
    quote: clean(sig.quote, 240),
    url: isHttp(sig.url) ? String(sig.url).trim() : '',
    date: date ? String(sig.date).trim() : '',
    ageDays,
    author: author || clean(personName, 120),
  };
}

/** One sourced, specific thing about them — or nothing. */
function readPersonal(p) {
  const text = clean(p?.text, 300);
  if (!text || !isHttp(p?.source_url)) return null;
  return { text, source_url: String(p.source_url).trim(), date: postDate(p?.date) ? String(p.date).trim() : '' };
}

/**
 * EXPECTED REPLY VALUE (2026-09-27): "close to the work + real reason to
 * contact + likely to reply + capable of helping + not buried in outreach".
 * Five 1-5 scores from the research, plus what a dated post of theirs is worth
 * TODAY — a post adds evidence, and no post at all takes nothing away.
 */
const SCORE_KEYS = ['proximity', 'hook', 'reply', 'help', 'competition'];
// "3 excellent leads like people who is telling people to inbox them or really
// active on linkedin, or relevant posts" (2026-09-27): an invitation is worth
// most, an announcement or a post about the work less. By its standing today.
const SIGNAL_BONUS = {
  invited: { fresh: 6, recent: 4, weak: 1 },
  hiring_post: { fresh: 3, recent: 2, weak: 0.5 },
  relevant_post: { fresh: 2.5, recent: 2, weak: 0.5 },
};
const ACTIVITY_BONUS = { active: 3, occasional: 1 };

/**
 * How often they post, from what the research SAW: their own posts or
 * comments in the last 6 weeks and the newest one's date, with where it was
 * seen. The level is decided here from the date, and re-decided on every read:
 *   active     — 2+ of their own in 6 weeks, the newest within 6 weeks
 *   occasional — something of theirs within 4 months
 *   quiet      — nothing newer than 4 months
 * No date, or nowhere it was seen: null — unknown, never guessed.
 */
export function readActivity(a, now = new Date()) {
  if (!a || typeof a !== 'object' || !isHttp(a.url)) return null;
  const latest = postDate(a.latest);
  if (!latest) return null;
  const ageDays = Math.max(0, Math.floor((now - latest) / 86400e3));
  const recent = Math.max(0, Math.min(99, Math.round(Number(a.recent_posts) || 0)));
  const level = recent >= 2 && ageDays <= RECENT_DAYS ? 'active' : ageDays <= STALE_DAYS ? 'occasional' : 'quiet';
  return { level, recent_posts: recent, latest: String(a.latest).trim(), ageDays, url: String(a.url).trim() };
}

/**
 * AN EXCELLENT LEAD has public evidence they answer: their own invitation,
 * hiring post or post about the work that is fresh or recent, or a record of
 * posting actively. Everyone else fills a slot only when nobody better exists.
 */
export function excellence(p) {
  const s = p.signal;
  if (s && (s.standing === 'fresh' || s.standing === 'recent')) {
    return s.kind === 'invited' ? 'invites messages' : s.kind === 'hiring_post' ? 'posted this hiring' : 'posts about the work';
  }
  if (p.activity?.level === 'active') return 'active on LinkedIn';
  return '';
}
function readScores(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of SCORE_KEYS) {
    const n = Math.round(Number(s[k]));
    if (!Number.isFinite(n)) return null;
    out[k] = Math.min(5, Math.max(1, n));
  }
  return out;
}
/** Higher is better. Runs without scores (older runs) fall back to 15, a middling total. */
export function replyValue(p) {
  const base = p.scores ? SCORE_KEYS.reduce((t, k) => t + p.scores[k], 0) : 15;
  const s = p.signal;
  const bonus = s ? (SIGNAL_BONUS[s.kind]?.[s.standing] || 0) : 0;
  return base + bonus + (ACTIVITY_BONUS[p.activity?.level] || 0);
}
/** Excellent leads first, whatever their title; reply value orders each group. */
function leadRank(p) {
  return (excellence(p) ? 0 : 10000) - replyValue(p) * 10 + ({ high: 0, medium: 1, low: 2 }[p.confidence] ?? 3);
}
const LEAD_TYPES = new Set(['decision', 'technical', 'alternate']);

/** Stable sort by leadRank: the model's order breaks ties. */
function rankLeads(people) {
  return people.map((p, i) => ({ p, i })).sort((a, b) => leadRank(a.p) - leadRank(b.p) || a.i - b.i).map((x) => x.p);
}

/**
 * Parse and SANITISE the research answer. Returns null when there is no JSON to
 * be had; otherwise a clean object, whatever the model put in it.
 */
export function parseLeads(stdout, { now = new Date() } = {}) {
  const raw = firstJsonObject(stdout);
  if (!raw || typeof raw !== 'object') return null;
  const people = [];
  for (const p of Array.isArray(raw.people) ? raw.people : []) {
    const name = clean(p?.name, 120);
    if (!name) continue;
    const emailOk = EMAIL.test(String(p?.public_email || '').trim()) && isHttp(p?.email_source_url);
    people.push({
      signal: readSignal(p?.signal, name, now),
      activity: readActivity(p?.activity, now),
      personal: readPersonal(p?.personal),
      name,
      title: clean(p?.title, 200),
      persona: PERSONAS.has(p?.persona) ? p.persona : 'team',
      lead_type: LEAD_TYPES.has(p?.lead_type) ? p.lead_type : '',
      scores: readScores(p?.scores),
      why: clean(p?.why, 460),
      usefulness: clean(p?.usefulness, 300),
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
    people: rankLeads(people.map((p) => ({ ...p, excellent: excellence(p) }))),
    // How many plausible people the research weighed before picking these.
    considered: Math.max(0, Math.min(50, Math.round(Number(raw.considered) || 0))),
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

/**
 * A signal's standing is re-read on every read: a post that was fresh when it
 * was found goes stale while it sits in the store.
 */
export function restand(result, now = new Date()) {
  if (!Array.isArray(result?.people)) return result;
  const people = result.people.map((p) => {
    const q = { ...p, signal: p.signal ? readSignal(p.signal, p.name, now) : null, activity: p.activity ? readActivity(p.activity, now) : null };
    return { ...q, excellent: excellence(q) };
  });
  return { ...result, people: rankLeads(people) };
}

function rowToRun(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { /* a torn write reads as no result */ }
  if (result) result = restand(result);
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

/**
 * One line per job for the board: is anything running, and how many leads.
 * A job he took off the Outreach tab is left out, so its button reads
 * "Outreach" again.
 */
export function leadSummary({ dbPath = dbFile() } = {}) {
  const out = {};
  const removed = removedFromOutreach({ dbPath });
  for (const row of db(dbPath).prepare('SELECT job_id FROM lead_runs').all()) {
    if (removed.has(row.job_id)) continue;
    const r = getLeadRun(row.job_id, { dbPath });
    out[row.job_id] = { status: r.status, count: r.result?.people?.length || 0, warnings: r.result?.warnings?.length || 0, startedAt: r.startedAt };
  }
  return out;
}

/** Every person the research found, per chosen job — what LinkedIn activity is matched against. */
export function leadPeople({ dbPath = dbFile() } = {}) {
  const removed = removedFromOutreach({ dbPath });
  const out = [];
  for (const row of db(dbPath).prepare("SELECT job_id, result FROM lead_runs WHERE result IS NOT NULL").all()) {
    if (removed.has(row.job_id)) continue;
    let r = null; try { r = JSON.parse(row.result); } catch { continue; }
    for (const p of r?.people || []) out.push({ jobId: row.job_id, name: p.name, profile_url: p.profile_url || '' });
  }
  return out;
}

// ── the Outreach tab's list ──────────────────────────────────────────
// Alex, 2026-09-25: "i should be able to choose outreach in application list
// then it appears in the outreach tab". Pressing Outreach on an application IS
// the choice; the tab lists those jobs and nothing else. Taking one off keeps
// its research.

export function removedFromOutreach({ dbPath = dbFile() } = {}) {
  return new Set(db(dbPath).prepare('SELECT job_id FROM outreach_removed').all().map((r) => r.job_id));
}

export function removeFromOutreach(jobId, { dbPath = dbFile() } = {}) {
  db(dbPath).prepare('INSERT OR REPLACE INTO outreach_removed (job_id, removed_at) VALUES (?, ?)')
    .run(String(jobId), new Date().toISOString());
}

function restoreToOutreach(jobId, dbPath) {
  db(dbPath).prepare('DELETE FROM outreach_removed WHERE job_id = ?').run(String(jobId));
}

/**
 * PEOPLE FOUND FROM THEIR OWN POSTS (post-leads.mjs, F-708) join the job's
 * leads beside what the research found. Same person (by profile, else by
 * name): the post evidence replaces a weaker signal, the research's words
 * stay. Returns how many people the job's leads now hold.
 */
export function mergePostLeads(jobId, incoming, { dbPath = dbFile(), now = new Date() } = {}) {
  const row = db(dbPath).prepare('SELECT * FROM lead_runs WHERE job_id = ?').get(String(jobId));
  const prev = row?.result ? JSON.parse(row.result) : { people: [], considered: 0, hook: '', hook_source: '', careers_email: '', warnings: [], notes: '' };
  const people = [...(prev.people || [])];
  const norm = (u) => String(u || '').toLowerCase().replace(/\/+$/, '');
  for (const raw of incoming) {
    const p = { ...raw, signal: readSignal(raw.signal, raw.name, now) };
    const at = people.findIndex((q) => (norm(q.profile_url) && norm(q.profile_url) === norm(p.profile_url)) || samePerson(q.name, p.name));
    if (at < 0) { people.push(p); continue; }
    const q = people[at];
    const better = !q.signal || ['stale', 'undated', 'reposted'].includes(q.signal.standing) || (p.signal && ['fresh', 'recent'].includes(p.signal.standing));
    people[at] = { ...q, profile_url: q.profile_url || p.profile_url, evidence_url: better ? p.evidence_url : q.evidence_url, signal: better ? p.signal : q.signal, why: q.why || p.why, confidence: q.confidence === 'high' ? 'high' : p.confidence };
  }
  const result = { ...prev, people: rankLeads(people.map((p) => ({ ...p, excellent: excellence(p) }))) };
  write(jobId, { status: 'done', startedAt: row?.started_at, finishedAt: new Date().toISOString(), result }, dbPath);
  return result.people.length;
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
export function startLeadRun(job, { description = '', hardBlock = false, known = [], ask = askResearch, refresh = false, dbPath = dbFile(), bin = 'claude', postFetch = ask === askResearch ? fetch : null } = {}) {
  const jobId = String(job?.id || '');
  if (!jobId) throw new Error('a lead run needs a job');
  // A press is a choice: a job he took off the Outreach tab goes back on it.
  restoreToOutreach(jobId, dbPath);
  const current = getLeadRun(jobId, { dbPath });
  if (ACTIVE.has(jobId) || QUEUE.some((q) => q.jobId === jobId)) return current;
  if (current?.status === 'done' && !refresh) return current;

  const startedAt = new Date().toISOString();
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    write(jobId, { status: 'failed', startedAt, finishedAt: startedAt, error: 'research switched off (JARVIS_TAILOR=off)' }, dbPath);
    return getLeadRun(jobId, { dbPath });
  }
  write(jobId, { status: 'running', startedAt, result: current?.result ?? undefined }, dbPath);
  const prompt = buildLeadsPrompt(job, { description, hardBlock, known });
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
        // Every LinkedIn post the research cites is read at the source: the
        // page's author, words and date replace the snippet's, and the writer
        // of a reshared post joins the leads (F-711/F-708). A failure here
        // keeps the research as it came back.
        if (postFetch) {
          try {
            const { verifyLeadPosts } = await import('./post-leads.mjs');
            const v = await verifyLeadPosts(result.people, { fetchImpl: postFetch });
            const fixedUp = [...v.people, ...v.added].map((p) => (p.verified_post || v.added.includes(p)
              ? { ...p, signal: readSignal(p.signal, p.name), confidence: CONFIDENCE.has(p.confidence) ? p.confidence : 'medium' } : p));
            result.people = rankLeads(fixedUp.map((p) => ({ ...p, excellent: excellence(p) }))).slice(0, MAX_PEOPLE + 3);
          } catch { /* the research stands */ }
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
