/**
 * OUTREACH — who to talk to about a job he has queued, and what to say.
 *
 * `jarvis/OUTREACH.md` is the research this obeys and should be read before
 * changing anything here. The three findings that shape the code:
 *
 *   1. **It never sends.** Drafts only, he sends from his own client and his
 *      own LinkedIn. Same law as the apply engine, and here it is also self-
 *      preservation: LinkedIn's UA forbids automation, and losing that account
 *      is the one unrecoverable failure in a job search.
 *   2. **Volume destroys the channel.** Personalised messages reply at roughly
 *      17-18% against 7% for generic ones, and the semiconductor ME world is
 *      small enough that a detectable pattern costs him his name at exactly his
 *      target tier. So this is scoped to jobs he has queued or applied to, one
 *      person per company per role, one follow-up, then silence.
 *   3. **The first message asks for information, not a referral.** People spot
 *      a backdoor application in about two minutes and the goodwill that got
 *      the reply disappears with it.
 *
 * WHY THERE IS NO "FIND ME A PERSON" FUNCTION. Measured 2026-09-10 across all
 * 3,700 readable deck postings: 1.4% name someone to contact and every one of
 * those is "Talent Acquisition" or "<Company> Recruiting"; 84 distinct email
 * addresses appear in the entire deck and exactly ONE belongs to a human. A
 * posting cannot tell you who to talk to. Simplify solves this by renting
 * Village (village.ai), a warm-intro graph built from the user's OWN connected
 * accounts — a data purchase, and one that returns little for a student whose
 * network is three years old.
 *
 * So this module produces a SEARCH SPEC rather than a person: the team, the
 * title to look for, the reporting line the posting states, and the order to
 * try them in. He finds the human; this writes and tracks.
 *
 * SOURCE OF TRUTH for anything a stranger will read: cv.md, profile.yml's
 * narrative, and the posting. voice-dna.md governs how it reads and never adds
 * a claim. `checkOutreach()` enforces it mechanically, because an invented
 * shared history is the single biggest embarrassment risk in an AI-drafted
 * message.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { numbersIn, entitiesIn, forbiddenClaims } from './resume-tailor.mjs';
import { sourcesFor, askText, BANNED, SELF_NEGATION } from './cover-letter.mjs';
import { condenseJd, ownsExamples, schoolShort, graduation } from './tailor-llm.mjs';
import { person, writing } from './targeting.mjs';

/** The channels, and what each one physically allows. */
export const CHANNELS = {
  // A FREE ACCOUNT GETS THREE PERSONALISED NOTES A MONTH, 200 CHARACTERS EACH
  // (LinkedIn Help a563153, read 2026-09-26; the 300 / ~5 this used to say is
  // out of date). Premium notes are unlimited. The note's job is to earn a
  // CONVERSATION, not the connection: acceptance rates are the same with and
  // without one (26.42% vs 26.37% over 20M requests), but a personal note
  // roughly doubles the post-accept reply rate (9.36% vs 5.44%).
  note: { label: 'LinkedIn note', maxChars: 200, minWords: 18, maxWords: 40 },
  // A LinkedIn message once they accept, or an InMail. HIS FORMULA (2026-09-27)
  // is 3-5 short paragraphs plus the job link, portfolio and resume line.
  // LinkedIn's own data favours under 400 characters (+22%) and punishes over
  // 1,200 (-11%); the formula cannot fit in 400. The word band counts the
  // prose only (links and footer excluded).
  // HIS TEMPLATE (2026-10-04) is 156 words and 1,178 characters, and Chris at
  // Tesla answered it the same evening and passed it to the hiring manager. A
  // message that got the reply sets the cap, not the vendor average: 1,150 /
  // 140 refused it. Room above it for a long job link (Amazon's run 130+).
  message: { label: 'LinkedIn message', maxChars: 1300, minWords: 55, maxWords: 170 },
  // Same content by email.
  email: { label: 'Email', maxChars: 1400, minWords: 55, maxWords: 170 },
  // Same length as an email; the shared school is the one piece of earned
  // context a student reliably has, and it is a fact, not manufactured rapport.
  alumni: { label: 'Alumni email or message', maxChars: 1400, minWords: 55, maxWords: 170 },
};

/**
 * WHO TO LOOK FOR, in the order the research ranks them.
 *
 * "Target choice matters more than message quality." A recruiter is the
 * most-spammed persona and the least able to vouch for anyone, so it is last
 * and it is not offered at all when the posting names a team he could reach
 * directly.
 */
export const PERSONAS = [
  { key: 'alumni', rank: 1, label: `${schoolShort() || 'Your school\'s'} alumni at the company`, why: 'the shared school is real earned context, and alumni reply to students' },
  { key: 'team', rank: 2, label: 'an engineer on the actual team', why: 'they know what the work is and their word carries with the hiring manager' },
  { key: 'manager', rank: 3, label: 'the hiring manager', why: 'decides, but is busy and hears from everyone' },
  { key: 'recruiter', rank: 4, label: 'a recruiter', why: 'most spammed, least able to vouch — last resort' },
];

/** The team named in the posting's own body, when the row does not carry one. */
const TEAM_RE = /\b(?:join(?:ing)?|part of|within|member of|sits? (?:in|within))\s+(?:the|our)\s+([A-Z][A-Za-z0-9 &/-]{3,40}?)\s+(?:team|group|org|organization|organisation|department)\b/;

/** "reporting to the Manufacturing Engineering Manager" — a title, never a name. */
const REPORTS_RE = /\b(?:report(?:s|ing)? to|you(?:'ll| will) report to|this (?:role|position) reports to)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 ,&/-]{3,60}?)(?=[.,;\n]|\s+(?:and|who|in|at|based)\b)/i;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The search spec for one job: everything known about WHERE the person is,
 * so he can go find one. Pure — the description is passed in.
 *
 * @param {{company?:string,title?:string,team?:string,location?:string,url?:string}} job
 * @param {{description?:string, domain?:string}} [opts]
 */
export function targetSpec(job, { description = '', domain = '' } = {}) {
  const company = clean(job?.company);
  const title = clean(job?.title);
  const desc = String(description || '');
  // The row's team first: it is 56.9% populated across the deck and it came
  // from the ATS rather than from a regex over prose.
  const team = clean(job?.team) || clean((desc.match(TEAM_RE) || [])[1]);
  const reportsTo = clean((desc.match(REPORTS_RE) || [])[1]);
  // A reporting line that is really a person's name is not usable as a title,
  // and a name in a JD is nearly always a recruiter's.
  const managerTitle = /\b(?:manager|director|lead|head|supervisor|principal|vp)\b/i.test(reportsTo) ? reportsTo : '';

  const personas = PERSONAS.filter((p) => {
    if (p.key === 'team') return !!team;
    if (p.key === 'manager') return !!managerTitle;
    // A recruiter is only worth it when there is nobody better to aim at.
    if (p.key === 'recruiter') return !team && !managerTitle;
    return true;
  });

  return {
    jobId: job?.id || '',
    company,
    title,
    team,
    managerTitle,
    location: clean(job?.location),
    domain: clean(domain),
    personas,
    // What he actually types into LinkedIn, per persona.
    searches: personas.map((p) => ({ persona: p.key, label: p.label, url: linkedinSearch(company, p.key, { team, managerTitle }) })),
  };
}

/**
 * A LinkedIn SEARCH URL — a link he clicks, which is not automation and not
 * scraping. Nothing in this project ever drives linkedin.com.
 */
export function linkedinSearch(company, persona, { team = '', managerTitle = '', school = person.school } = {}) {
  const terms = [];
  if (company) terms.push(`"${company}"`);
  if (persona === 'alumni' && school) terms.push(`"${school}"`);
  if (persona === 'team' && team) terms.push(`"${team}"`);
  if (persona === 'manager' && managerTitle) terms.push(`"${managerTitle}"`);
  if (persona === 'recruiter') terms.push('recruiter');
  if (persona === 'team' && !team) terms.push(writing.searchRole || 'engineer');
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(terms.join(' '))}`;
}

// ── email, at the scale of one ───────────────────────────────────────
//
// OUTREACH.md: "No scraped-list buying, no guessed-email spraying at scale. A
// wrong-guess bounce rate is itself a spam signal." One inferred address for
// one named person at a company whose pattern is KNOWN is ordinary practice;
// a dozen permutations sprayed is the thing that gets a personal domain
// blacklisted. So this returns ONE candidate or nothing, and it says which.

/** Address shapes, named so a draft can say which one it used. */
export const PATTERNS = {
  'first.last': (f, l) => `${f}.${l}`,
  'flast': (f, l) => `${f[0]}${l}`,
  'firstl': (f, l) => `${f}${l[0]}`,
  'first_last': (f, l) => `${f}_${l}`,
  'firstlast': (f, l) => `${f}${l}`,
  'first': (f) => f,
};

/** A role account — proves the domain, says nothing about the pattern. */
export const ROLE_ACCOUNT_RE = /^(?:careers?|jobs?|recruit\w*|talent\w*|hr\w*|help|support|info|contact|apply|applications?|accommodations?|accessibility|disability|hiring|people|team|admin|noreply|no-reply|external|ta[-_.]?\w*)\b|accommodat|accessib|disabilit|_loa\b|posting/i;

/**
 * Infer a company's address pattern from addresses seen in its own postings.
 * Returns null unless a PERSON-shaped address is among them — which, measured
 * across his store, is true for about one company in eighty.
 */
export function emailPattern(samples = []) {
  for (const raw of samples) {
    const s = String(raw || '').toLowerCase().trim();
    const [localPart, dom] = s.split('@');
    if (!localPart || !dom) continue;
    if (ROLE_ACCOUNT_RE.test(localPart)) continue;
    const m = localPart.match(/^([a-z]+)([._-])([a-z]+)$/);
    if (m) {
      const sep = m[2];
      return { pattern: sep === '.' ? 'first.last' : sep === '_' ? 'first_last' : 'first-last', domain: dom, from: s };
    }
  }
  return null;
}

/** The domain a company uses, from any address seen in its postings. */
export function domainFrom(samples = []) {
  for (const raw of samples) {
    const dom = String(raw || '').toLowerCase().split('@')[1];
    if (dom && /\.[a-z]{2,}$/.test(dom)) return dom;
  }
  return '';
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

/**
 * ONE candidate address for ONE named person, with how much to trust it.
 *
 * `confidence` is the whole point: `inferred` means a person-shaped address at
 * this company was actually seen, `guess` means the shape is the commonest one
 * and nothing confirms it. A guess is shown as a guess and never pre-filled
 * into a draft.
 */
export function candidateEmail(fullName, { domain = '', pattern = '' } = {}) {
  const parts = clean(fullName).split(' ').filter(Boolean);
  const first = slug(parts[0]);
  const last = slug(parts[parts.length - 1]);
  if (!first || !last || parts.length < 2 || !domain) return null;
  const key = pattern && PATTERNS[pattern.replace('first-last', 'first_last')] ? pattern.replace('first-last', 'first_last') : 'first.last';
  const build = PATTERNS[key] || PATTERNS['first.last'];
  return {
    address: `${build(first, last)}@${domain}`,
    pattern: key,
    confidence: pattern ? 'inferred' : 'guess',
    note: pattern
      ? `${domain} uses ${key}, seen in one of its own postings`
      : `nothing confirms ${domain}'s format — ${key} is the commonest shape, so check it before sending`,
  };
}

// ── the message ─────────────────────────────────────────────────────

/** Openers that are a referral ask wearing a question's clothes. */
const BACKDOOR_RE = /\b(?:refer(?:ral|ring)?\s+me|refer\s+me|would you (?:be able to |be willing to )?refer|put in a (?:good )?word|pass (?:my|along my) (?:resume|cv|name)|forward my (?:resume|cv|application)|get my (?:resume|cv|application) (?:to|in front of)|hiring me|consider me for)\b/i;

/** Leading with the visa is self-sabotage in a first message (OUTREACH.md §4). */
const VISA_RE = /\b(?:visa|sponsorship|sponsor|h-?1-?b|opt\b|f-?1\b|green\s?card|work authorization|work authorisation|international student)\b/i;

/** The questions engineers read as fake (2026-09-26: "fake ass fluff bs questions"). */
const FLUFF_Q_RE = /\b(?:curious (?:how|what|whether|about|if)|i(?:'d| would) love to (?:learn|hear|understand|know) (?:how|what|more)|how (?:does|do|is|are) (?:the|your|that) (?:team|group|role|org)\b[^?]{0,60}(?:split|divid|structur|set up|organi[sz]|handl|own)|what (?:do|does) (?:you|the team|your team) look for|what(?:'s| is) (?:a )?typical day|day[- ]to[- ]day look like|could you share how|how (?:early|much) does)/i;

/** Praise a stranger can see through. */
const FLATTERY_RE = /\b(?:impressive|inspiring|inspired by your|amazing (?:work|team)|(?:huge|big) fan|i admire|love what (?:you|your team)|really excited by your)\b/i;

/**
 * A reaction he never had, or a profile read back to its owner (2026-09-26
 * drafts: "your post … stuck with me", "your LinkedIn shows you've recruited",
 * "I saw you post about recruiting at Cornell" over a year-old post).
 */
// "I saw your post …", "I came across your work …" and "I noticed you're also a
// Lakeside alum" are HIS good examples (2026-09-27) — allowed when the research
// sourced them (REFERENCES_THEM_RE below). What stays banned is the reaction
// and the profile read back to its owner.
const REACTION_RE = /\b(?:stuck with me|resonated|really enjoyed|loved (?:reading|seeing|your)|your (?:linkedin|profile) (?:shows|says|mentions)|i (?:saw|see|noticed) (?:that )?your (?:recruiting|background|experience|profile|focus|career|resume))\b/i;

/**
 * The tells the 2026-09-27 drafts leaned on: "genuinely interested" in 7 of 11,
 * and "… is the kind of work I want to learn from" as a career-recital opener.
 */
const TELL_RE = /\bgenuinely\b|\bis (?:exactly )?the kind of [^.]{0,60}\bi (?:want|would like|'d like|hope) to learn from\b/i;

/** A reference to their post, talk or work — true only when the research sourced it. */
const REFERENCES_THEM_RE = /\b(?:your (?:recent )?(?:post|talk|article|paper|patent|comment|video|podcast|interview|work on)|you (?:posted|wrote|mentioned|shared|said|spoke)|saw that you|i (?:saw|noticed) (?:that )?you|i (?:came across|saw) your)\b/i;

/** A shared school, which must be true of THEM (the research says so), not just of him. */
// The school is the person's own (profile.yml); his keeps its nickname.
const SCHOOL_ALT = ownsExamples() ? 'lakeside|zag' : (schoolShort().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') || '(?!)');
const SCHOOL_RE = ownsExamples() ? /lakeside/i : new RegExp(SCHOOL_ALT, 'i');
const ALUM_CLAIM_RE = ownsExamples()
  ? /\b(?:fellow (?:lakeside|zag)|also (?:a |an )?(?:lakeside|zag)|(?:you|you're|you are|were)\b[^.?!]{0,30}\blakeside (?:alum\w*|grad)\b)/i
  : new RegExp(`\\b(?:fellow (?:${SCHOOL_ALT})|also (?:a |an )?(?:${SCHOOL_ALT})|(?:you|you're|you are|were)\\b[^.?!]{0,30}\\b(?:${SCHOOL_ALT}) (?:alum\\w*|grad)\\b)`, 'i');

/** The networking phrases he bans by name (2026-09-27). */
const CLICHE_RE = /\b(?:pick your brain|on your radar|your (?:career )?journey|great mentor|\d+\s*minutes? to (?:chat|talk)|quick (?:call|chat)|hop on a (?:call|chat)|coffee chat|what advice would you give|what qualities make)\b/i;

/** Rapport nobody earned. */
const FAKE_RAPPORT_RE =/\b(?:i (?:really )?(?:loved|enjoyed|read) your (?:post|article|talk|paper|interview)|your (?:recent )?(?:post|talk|article) (?:on|about)|we (?:met|spoke|connected) at|i (?:saw|caught) your talk|big fan of your)\b/i;

/** Statuses at which "I applied" is true. */
const APPLIED = new Set(['applied', 'responded', 'interview', 'offer', 'rejected']);

/**
 * What the research found about this person that a message may USE: their own
 * post while it is fresh or recent, and one sourced detail about them. A stale
 * post, an undated one and a repost are not usable — the first two are about a
 * req that is probably filled, the last is someone else's words.
 */
export function usableLead(lead) {
  const sig = lead?.signal;
  // A weak post (2-3 months, his bands 2026-09-27) is still THEIR post and may
  // be named; it may never be called recent or read as the team hiring now.
  // A stale one too, as HISTORY (2026-10-05: an old post shows they manage the
  // team and have hired entry-level engineers before; it never supports "is
  // hiring" — the "is hiring" and "recent" checks below hold that line).
  // Undated posts and plain reshares stay unusable: no date, or not their words.
  const signal = sig && ['fresh', 'recent', 'weak', 'stale'].includes(sig.standing) ? sig : null;
  const personal = lead?.personal?.text && lead.personal.source_url ? lead.personal : null;
  return { signal, personal };
}

/** His portfolio as a link, from config/profile.yml `portfolio_url`. '' when it is not set. */
export function portfolioUrl(profileText = null) {
  let text = profileText;
  if (text == null) {
    try { text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'profile.yml'), 'utf-8'); } catch { text = ''; }
  }
  const m = String(text).match(/^\s*portfolio_url:\s*["']?([^"'\s#]+)/m);
  if (!m) return '';
  return /^https?:\/\//i.test(m[1]) ? m[1] : `https://${m[1]}`;
}

/**
 * The experience the posting asks for, when it is more than a new graduate has:
 * "2-6 years", "3+ years". '' when the posting asks for less than 2 or says nothing.
 * His rule: "If there is an obvious problem such as a 2-6 year experience
 * requirement, acknowledge it once."
 */
export function experienceGap(jd = '') {
  const t = String(jd || '').replace(/\s+/g, ' ');
  const re = /\b(\d{1,2})\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?(\+)?\s*(?:years?|yrs?)\b(?=[^.]{0,60}\bexperience)/gi;
  let best = null;
  for (const m of t.matchAll(re)) {
    const lo = Number(m[1]);
    if (!Number.isFinite(lo) || lo < 2 || lo > 15) continue;
    if (!best || lo < best.lo) best = { lo, text: m[2] ? `${m[1]}-${m[2]} years` : `${m[1]}${m[3] ? '+' : ''} years` };
  }
  return best ? best.text : '';
}

/**
 * The title as the company writes it. Some stored titles were rebuilt from a
 * web address — "Mechanical Systems Engineer Ncg", "Gas Systems Engineer O M
 * Boise Idaho United States Of America" — and the writer copied "Ncg" into a
 * message to Applied Materials' own recruiter (2026-09-27).
 */
const TITLE_ACRONYMS = /\b(Ncg|Rda|Aptd|Npi|Mes|Pcb|Cnc|Rf|Hvac|Ehs|Qa|Qc|Plc|Cad|Cae|Fea|Dfm|Mfg)\b/g;
export function displayTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  // Acronyms first, so "APTD" is not mistaken for a place name and cut.
  t = t.replace(/\bO M\b/g, 'O&M').replace(TITLE_ACRONYMS, (s) => s.toUpperCase());
  t = t.replace(/(?:\s+[A-Z][a-z]+){1,2}\s+United States(?: Of America)?$/, '').replace(/\s+United States(?: Of America)?$/i, '');
  return t.trim();
}

/**
 * The posting link as he should send it: tracking parameters off. Sunday's
 * stored link ended "?utm_source=Simplify" — the browser extension he applied
 * through, shown to Sunday's hardware lead (2026-09-27).
 */
export function postingLink(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^(?:utm_|gh_src$|src$|source$|ref$|referrer$|lever-source)/i.test(k)) u.searchParams.delete(k);
    // A Workday link stored at the apply step ("…_R56671/apply/autofillWithResume",
    // Hyve 2026-10-05) is the posting plus the applicant's own flow: send the posting.
    if (/myworkdayjobs\.com$/i.test(u.hostname)) u.pathname = u.pathname.replace(/\/(?:apply|login)(?:\/[^/]*)?\/?$/i, '');
    return u.toString().replace(/\?$/, '');
  } catch { return raw; }
}

/** Channels that carry the whole formula: job link, portfolio, attached resume. */
const FULL_CHANNELS = new Set(['message', 'email', 'alumni']);

/**
 * THE MESSAGE, AS HE ASKED FOR IT (2026-09-26).
 *
 * "for outreach, incorporate sth personal or sth about them, and be direct,
 * ive applied.. i am interested in... would you have time to look at my resume
 * to see if im a fit for the team? engineers dont want fake ass fluff bs
 * questions". The old rule asked about the work ("how is the team split…")
 * and every note came out as exactly that question.
 */
/**
 * HIS FORMULA (2026-09-27), replacing the 2026-09-26 version. Goal: "get the
 * person to actually look at my resume and portfolio and reply … the ideal
 * outcome is that they form an opinion on whether I could fit the team".
 * PERSON → ROLE → JOB LINK → MINI TECHNICAL PITCH → WHY I CARE → GAP (only if
 * necessary) → ASK (their opinion on his fit) → REMOVE ALL FRICTION (portfolio,
 * resume attached). A connection note (200 characters) carries only the person,
 * the role and the ask.
 */
export function buildOutreachPrompt({
  job, jd = '', channel = 'email', persona = 'team', contact = {}, cvText = '', narrative = {}, voiceRules = '', spec = null, request = '', lead = null, portfolio = '',
}) {
  const ch = CHANNELS[channel] || CHANNELS.email;
  const who = PERSONAS.find((p) => p.key === persona) || PERSONAS[1];
  const name = clean(contact.name) || 'the person';
  const first = name.split(' ')[0];
  const theirTitle = clean(contact.title);
  const team = clean(spec?.team || job?.team);
  const applied = APPLIED.has(String(job?.status || ''));
  const { signal, personal } = usableLead(lead);
  const offersReferral = signal?.kind === 'invited' && /\brefer/i.test(signal.quote || '');
  const weeks = signal ? Math.max(1, Math.round(signal.ageDays / 7)) : 0;
  const aboutThem = [
    signal ? `  Their own post, ${signal.ageDays} days old (${signal.kind === 'invited' ? 'it invites candidates to reach out' : signal.kind === 'relevant_post' ? 'it is about their work, not about hiring' : 'it announces the opening'}): "${signal.quote}"${['weak', 'stale'].includes(signal.standing) ? `\n  That post is ${weeks} weeks old: never call it recent, and never say the team is hiring now because of it. Use it only as history (they run this team and have hired before).` : ''}` : '',
    personal ? `  Something about them, from a public source: ${personal.text}` : '',
  ].filter(Boolean).join('\n');
  const gap = experienceGap(jd);
  const roleTitle = displayTitle(job?.title) || 'open';
  const full = FULL_CHANNELS.has(channel);
  const url = postingLink(job?.url);
  const roleLine = `${applied ? 'He HAS APPLIED to it: say "I applied for …"' : 'He has NOT applied yet: say he is applying, never that he applied'}, and that he is interested in it.`;
  // HIS MESSAGES ARE HIS. The two rewrites quoted below, the sentence he opens
  // with and his sign-off reach his prompt only; anyone else gets the same
  // shape said from their own profile.
  const own = ownsExamples();
  const g = graduation();
  const whoLine = own
    ? 'I\'m a senior Mechanical Engineering student at Lakeside graduating in May 2027.'
    : `I'm ${g.done ? `a recent ${person.major || ''} graduate` : `a ${person.major || ''} student`}${person.school ? ` ${g.done ? 'from' : 'at'} ${schoolShort()}` : ''} ${g.done ? `(${g.label})` : `graduating in ${g.label}`}.`.replace(/\s+/g, ' ').replace(' .', '.');
  const intro = own
    ? 'Alex Rivera, a senior mechanical engineering student at Lakeside University graduating May 2027'
    : `${person.fullName}, ${g.done ? `a recent ${person.major || ''} graduate` : `a ${person.major || ''} student`}${person.school ? ` ${g.done ? 'of' : 'at'} ${person.school}` : ''}${g.done ? '' : ` graduating ${g.label}`}`.replace(/\s+/g, ' ');
  return `Write a FIRST LinkedIn outreach message from ${intro}, to someone more experienced.

THE GOAL
Get this person to look at his resume${full ? ' and portfolio' : ''} and reply with their honest opinion on whether he could fit the team. Not a referral, not a call: an opinion. Referrals and calls can follow on their own.

WHO IT GOES TO
  ${name}${theirTitle ? `, ${theirTitle}` : ''} at ${job?.company || 'the company'} (${who.label})
${team ? `  The role sits in: ${team}\n` : ''}
ABOUT THEM — the ONLY source for anything personal
${aboutThem || '  Nothing sourced. Say nothing personal about them; open with the role instead.'}

THE POSTING
  ${roleTitle} at ${job?.company || ''}${job?.location ? ` (${job.location})` : ''}
  ${url ? `Direct link: ${url}` : 'No link on file.'}
  ${roleLine}
${gap ? `  The posting asks for ${gap} of experience.\n` : ''}${jd ? `\n--- the posting, condensed ---\n${jd.slice(0, 2500)}\n` : ''}
HIS BACKGROUND — the ONLY source of facts about him
${cvText.slice(0, 6000)}
${narrative.headline ? `\nHow he describes himself: ${narrative.headline}\n` : ''}
HOW HE WRITES
${voiceRules.slice(0, 3000)}

BEFORE WRITING, answer for yourself (do not write these down): why this person, why this role, why him, why now, and exactly what he is asking them.

${full ? `${own ? `HIS OWN REWRITES OF TWO DRAFTS (2026-10-05) ARE THE STYLE. He rewrote both because the drafts "read pretty bad". Copy their shape, their plainness and their length. NEVER copy their facts: Amazon, Hyve, Reno and those roles are not this message.
--- (a person whose post invited contact)
Hi Devin,

I saw your post that you're hiring Systems Engineers for Technology Deployment within Amazon Robotics, and since you mentioned you'd love to connect, I wanted to introduce myself.

I recently applied for the Robotics Systems Engineer I, Tech Deployment role:
https://www.amazon.jobs/en/jobs/10503216/robotics-systems-engineer-i-tech-deployment

I'm a senior Mechanical Engineering student at Lakeside graduating in May 2027. This past summer I worked with Applied Materials' Automation Technology Group, where I supported the deployment and validation of Autonomous Mobile Robots for cleanroom material handling, and developed and validated UR cobot motion in RoboDK while helping lay out and install the cell.

The role stood out because seeing automation come to life at scale on a live floor is really close to the work I've enjoyed most. I'd really appreciate it if you could take a look at my application and see if I might be a good fit for the team.

Portfolio: https://alexrivera.example
Resume attached.

Thank you!
Alex
--- (a recruiter, no post to cite)
Hi Priya,

I recently applied for Hyve's Process Engineer, New College Grad role in Reno and wanted to reach out since you recruit for Hyve's engineering organization.

I'm a senior Mechanical Engineering student at Lakeside graduating May 2027. This past summer with Applied Materials' Automation Technology Group, I designed a machine-vision inspection fixture for semiconductor equipment and carried it through prototyping, drawings, supplier coordination, and release as it moved toward technician deployment. Previously at Acme Steel, I investigated an intermittent failure on a robotic production line that operators had largely learned to work around, isolated the root cause, and helped implement a correction that reduced jams by about 70%.

I'm interested in the Reno role because I enjoy taking manufacturing problems from the floor, understanding what is actually going wrong, and turning that into a process or hardware improvement that people can use reliably. I'd really appreciate it if you could take a look at my application to see if I am a good fit for the team.

Role: https://synnex.wd5.myworkdayjobs.com/en-US/hyvecareers/job/Reno%2C-NV/Process-Engineer--New-College-Grad-_R56671
Portfolio: https://alexrivera.example
Resume attached.

Thank you!
Alex
---
What he changed in the drafts, and why it reads better: the work is told as ONE piece of work carried from start to finish (designed it, then prototyping, drawings, suppliers, release), never a list of tool names or work categories; a second proof may follow when it has a human detail and a result (operators had learned to work around it; jams down about 70%); the "why" is what HE enjoys doing, in his own plain words, never a list of the posting's nouns; the ask is about his application, not "my background"; "Resume attached." is a sentence. Without a post, the message opens on the application and the reason for writing to THIS person in one sentence, and the link moves down beside the portfolio as "Role: <url>". (His Tesla message to Chris, 2026-10-04, got the first reply; these are the same shape, said better.)

` : `THE STYLE. Short paragraphs, plain words, one idea each: who they are to him, the role, who he is, one piece of work, why this role, the ask, then the links. The work is told as ONE piece of work carried from start to finish, never a list of tool names or categories; the "why" is what he enjoys doing, in plain words, never a list of the posting's nouns; the ask is about his application; "Resume attached." is a sentence. Without a post to cite, the message opens on the application and the reason for writing to THIS person in one sentence, and the link moves down beside the portfolio as "Role: <url>".

`}THE MESSAGE, IN THIS ORDER
1. PERSON: "Hi ${first}," then the genuine reason he chose THIS person, from "ABOUT THEM", in his words: "I saw your post that <what it said>, and since you mentioned <the invitation, in their words>, I wanted to introduce myself." Use "since you mentioned…" only when their post ${signal?.kind === 'invited' ? 'did invite it (this one does)' : 'invited candidates to reach out (this one does not)'}; otherwise "…so I wanted to introduce myself." A ${own ? 'Lakeside' : 'shared-school'} or shared-employer tie works the same way. With no post to cite, open on the application and the reason in ONE sentence${own ? ', as in Priya\'s' : ''}: "I recently applied for <Company>'s <title> role and wanted to reach out since you <what they do that makes them the right person>." Never recite their career, never force it.
2. ROLE: ${applied ? `"I recently applied for the ${roleTitle} role:"` : `"I'm applying for the ${roleTitle} role:"`} (that exact title; never rename it, never call it an internship unless it is one).${url ? `
3. JOB LINK, exactly: ${url} on its own line under step 2 when the message opened on their post; otherwise as "Role: ${url}" above the Portfolio line.` : ''}
4. WHO HE IS: "${whoLine}" Then ONE sentence on ${own ? 'Applied Materials\' Automation Technology Group (or the single background item that matches better)' : 'the single background item from his CV that matches this posting best'}: the one piece of work closest to this posting, told start to finish as he did it, never a list of tools or work categories. A second proof only when it carries a human detail and a result from his CV. Select; do not dump the resume.
5. WHY THIS ROLE, one sentence about what HE enjoys, in plain words, tied to what this job does: "The role stood out because <seeing or doing what this job does> is really close to the work I've enjoyed most." or "I'm interested in the <short role name> role because I enjoy <the work, said the way a person would>." Never a list of the posting's nouns, never praise of the company.${gap ? `
6. THE GAP, once: the posting asks for ${gap}. Acknowledge it in one plain clause ("I know I'm earlier-career than the ${gap} listed") and move on. No apology.` : ''}
7. THE ASK, in the same paragraph as step 5: "I'd really appreciate it if you could take a look at my application and see if I might be a good fit for the team." No other question.${offersReferral ? ` Their own post offered referrals, so he may add that he would be glad to be referred if it looks like a fit${applied ? ', noting he already applied so it would need attaching to his application' : ''}.` : ''}
8. Then these lines exactly (with "Role: <link>" first when step 3 put it here):
${portfolio ? `Portfolio: ${portfolio}` : ''}
Resume attached.

Thank you!
${person.firstName}` :`A CONNECTION NOTE: at most ${ch.maxChars} characters. "Hi ${first}," then, in two short sentences: the genuine reason he chose them (only from "ABOUT THEM"; skip it if there is none), that he applied (or is applying) for the ${roleTitle} role, and the ask: whether they think his background could be a fit. No link, no sign-off.`}

TONE
- ${own ? 'Student to senior engineer' : `${g.done ? 'Early-career candidate' : 'Student'} to ${writing.seniorReader || 'someone more experienced'}`}: respectful, confident but humble, enthusiastic, honest, willing to learn. Never desperate or self-deprecating.
- Direct, plain words. ${own ? 'Engineers answer' : 'People answer'} directness; polished networking language reads as a template.
- Only as much self-pitch as the steps above.

NEVER
- Filler questions: "can I pick your brain", "15 minutes to chat", "what advice would you give", "what qualities make someone successful", how the team is split, what a typical day looks like, "curious how".
- Flattery or generic compliments: "impressive", "inspiring", "your journey", "great mentor", "huge fan".
- "Put myself on your radar", corporate filler, buzzwords, unnecessary formality.
- A reaction he never had ("stuck with me", "resonated") or their profile read back to them ("your LinkedIn shows").
- Anything not sourced: facts about him come from the CV, about the company from the posting, about the person only from "ABOUT THEM". Never invent a job ID, a team, a connection, a meeting or a post.
- Visa, sponsorship, OPT or work authorisation.
- Em dashes, markdown, bullet lists.
${request ? `\nHE ASKED FOR: ${request}\n` : ''}
Answer with the message text and nothing else.`;
}

/**
 * Check the draft against the rules that cost something when broken.
 * `problems` fail the draft and trigger a rewrite; `notices` are for him.
 */
export function checkOutreach(text, { channel = 'email', cvText = '', jd = '', job = null, contact = {}, lead = null, portfolio = '' } = {}) {
  const problems = [];
  const notices = [];
  const whole = String(text || '').trim();
  if (!whole) return { ok: false, problems: ['the message is empty'], notices };
  const ch = CHANNELS[channel] || CHANNELS.email;
  // The words he wrote, without the links and the Portfolio/Resume lines: those
  // are counted and fact-checked on their own, not as prose.
  const msg = whole.split('\n').filter((l) => !/^\s*(?:(?:portfolio|role|resume|résumé)\s*:|resume\s+attached\b)/i.test(l)).join('\n')
    .replace(/https?:\/\/\S+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const wordCount = msg.split(/\s+/).filter(Boolean).length;

  if (whole.length > ch.maxChars) {
    problems.push(`${whole.length} characters; a ${ch.label} is capped at ${ch.maxChars}`);
  }
  // REMOVE ALL FRICTION (his formula): the job, the portfolio and the resume,
  // so nobody has to ask which opening or go looking.
  if (FULL_CHANNELS.has(channel)) {
    const url = postingLink(job?.url);
    if (url && !whole.includes(url)) problems.push('leaves out the direct link to the posting');
    if (portfolio && !whole.toLowerCase().includes(portfolio.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase())) problems.push(`leaves out his portfolio (${portfolio})`);
    // "Resume: Attached" (Chris, 2026-10-04) or "Resume attached." (his rewrites, 2026-10-05).
    if (!/^\s*resume\s*:?\s*attached\b/im.test(whole)) problems.push('leaves out "Resume attached."');
  }
  if (wordCount > ch.maxWords) problems.push(`too long: ${wordCount} words (${ch.minWords}-${ch.maxWords} is the reply band)`);
  if (wordCount < ch.minWords) problems.push(`too short: ${wordCount} words (${ch.minWords}-${ch.maxWords} is the reply band)`);

  // THE THREE THAT COST THE CONTACT, not just the reply.
  const { signal, personal } = usableLead(lead);
  const sourced = !!(signal || personal);
  // A referral may be mentioned only to someone who offered one in public.
  const offersReferral = signal?.kind === 'invited' && /\brefer/i.test(signal.quote || '');
  if (BACKDOOR_RE.test(msg) && !offersReferral) problems.push('asks for a referral in a first message — that is the backdoor application the research says kills it');
  if (VISA_RE.test(msg)) problems.push('mentions visa or sponsorship; a first message never does (OUTREACH.md §4)');
  if (/\bwe (?:met|spoke|connected) at\b/i.test(msg)) problems.push('claims a shared history — nothing here can verify that, so it cannot be said');
  else if ((FAKE_RAPPORT_RE.test(msg) || REFERENCES_THEM_RE.test(msg)) && !sourced) {
    problems.push(lead?.signal ? `refers to their post or work, but the only post found is ${lead.signal.standing === 'reposted' ? `a repost of ${lead.signal.author}'s` : lead.signal.standing} — it cannot be used`
      : 'claims a shared history, a talk or an article — nothing here can verify that, so it cannot be said');
  }

  // DIRECT, AS HE ASKED: the ask is their opinion on his fit (2026-09-27).
  if (FLUFF_Q_RE.test(msg)) problems.push('asks a filler question (how the team is split, what they look for, "curious how"); the only question is whether he could fit');
  if (CLICHE_RE.test(msg)) problems.push(`uses "${msg.match(CLICHE_RE)[0]}", a networking phrase he bans`);
  if (FLATTERY_RE.test(msg)) problems.push('flatters them; say the specific thing instead');
  if (TELL_RE.test(msg)) problems.push(`"${msg.match(TELL_RE)[0].slice(0, 50)}" reads as written by a machine; say it plainly`);
  // THE ROLE BY ITS OWN NAME: "Ncg" copied out of a web address, or a
  // contract role called an internship (Dexterity, 2026-09-27).
  if (/\b(?:Ncg|Rda|Aptd)\b|\bO M\b|United States Of America/.test(msg)) problems.push('copies the title as rebuilt from a web address; write it the way the company does');
  // Only the ROLE being called an internship; his own Applied Materials
  // internship is his to mention.
  if (job?.title && /\bintern(?:ship)?\s+(?:role|position|opening|posting)\b|\b(?:the|this|your)\s+(?:[\w/.-]+\s+){0,6}internship\b/i.test(msg) && !/\bintern/i.test(String(job.title))) problems.push(`calls the role an internship; it is "${displayTitle(job.title)}"`);
  if (REACTION_RE.test(msg)) problems.push('claims a reaction he never had, or reads their profile back to them; state the fact and why it matters to him, or leave it out');
  const sentences = msg.split(/(?<=[.!?])\s+/);
  const questions = sentences.filter((s) => s.trim().endsWith('?'));
  // HIS ASK IS A STATEMENT (2026-10-04): "I'd really appreciate you taking a
  // quick look at my resume and portfolio and letting me know if you think my
  // background could be relevant to the team." It got the reply; a check that
  // demanded a question mark refused it.
  const fitAsk = questions.some((q) => /\b(?:fit|relevant|match)\b/i.test(q))
    || sentences.some((s) => /\b(?:if|whether)\b[^.?!]{0,90}\b(?:fit|relevant|match)\b/i.test(s));
  if (!fitAsk) problems.push('does not ask the one thing he wants: whether they think his background could fit the team');
  if (questions.length > 1) problems.push(`asks ${questions.length} questions; one ask, their opinion on his fit`);
  if (ALUM_CLAIM_RE.test(msg) && !SCHOOL_RE.test(`${personal?.text || ''} ${signal?.quote || ''}`)) problems.push(`says they went to ${ownsExamples() ? 'Lakeside' : schoolShort() || 'the same school'}, but nothing found says so`);
  if (/\brecent(?:ly)?\b/i.test(msg) && lead?.signal && !['fresh', 'recent'].includes(lead.signal.standing) && REFERENCES_THEM_RE.test(msg)) {
    problems.push(`calls their post recent; it is ${lead.signal.ageDays == null ? 'undated' : `${lead.signal.ageDays} days old`}`);
  }
  // "Your team is hiring" is a claim about NOW. Only a post under six weeks
  // old supports it (his bands: 2-3 months weak, 4+ not current). Shreyash's
  // 4-month-old post went out as "your team is hiring" (2026-10-05).
  // A headline that says "Hiring for …" today is current evidence too (Owen).
  if (/\b(?:is|are|'s|'re)\s+(?:currently\s+|still\s+|now\s+)?hiring\b/i.test(msg) && !(lead?.signal && ['fresh', 'recent'].includes(lead.signal.standing)) && !/\bhiring\b/i.test(String(contact.title || ''))) {
    problems.push(`says the team is hiring now; ${lead?.signal ? `their post is ${lead.signal.ageDays == null ? 'undated' : `${lead.signal.ageDays} days old`}` : 'no dated post says so'} (only a post under 6 weeks old supports "is hiring")`);
  }
  if (!APPLIED.has(String(job?.status || '')) && /\bI(?:'ve| have)? (?:already )?applied\b/i.test(msg)) problems.push('says he applied; he has not applied to this one yet');

  for (const what of forbiddenClaims(msg, cvText, { prose: true })) problems.push(`claims ${what}, which he does not have`);
  if (/[—–]/.test(msg)) problems.push('has an em dash (voice-dna bans them)');
  if (/```|^#{1,3}\s|\*\*/m.test(msg)) problems.push('has markdown in it');
  if (/^\s*[-*•]\s/m.test(msg)) problems.push('has a bullet list; this is a message, not a document');
  const low = msg.toLowerCase().replace(/[’‘]/g, "'");
  for (const b of BANNED) {
    const re = new RegExp(`(?:^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i');
    if (re.test(low)) problems.push(`uses "${b}", which voice-dna bans`);
  }
  for (const [re, said] of SELF_NEGATION) {
    if (re.test(msg)) problems.push(`says ${said} — a first message never volunteers what he cannot do`);
  }
  if (channel === 'note' && /\b(?:dear|sincerely|best regards|kind regards)\b/i.test(msg)) {
    notices.push('a connection note has no greeting or sign-off; those characters are better spent on the ask');
  }

  // FABRICATION, checked the same way the cover letter checks it: a figure or
  // a named thing that is in neither cv.md nor the posting did not come from
  // anywhere, and this text goes to a human who can ask about it.
  const aboutThem = [personal?.text, signal?.quote].filter(Boolean).join(' ');
  const allowedNums = new Set([...numbersIn(cvText), ...numbersIn(jd), ...numbersIn(String(job?.title || '')), ...numbersIn(aboutThem)]);
  for (const n of numbersIn(msg)) {
    if (allowedNums.has(n) || /^(?:19|20)\d{2}$/.test(n)) continue;
    problems.push(`figure "${n}" is not in cv.md or the posting`);
  }
  const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = new Set([
    ...entitiesIn(cvText), ...entitiesIn(jd),
    ...entitiesIn(String(job?.company || '')), ...entitiesIn(String(job?.title || '')),
    ...entitiesIn(String(job?.team || '')), ...entitiesIn(String(contact.title || '')), ...entitiesIn(aboutThem),
    // THE PERSON'S OWN NAME, word by word. `entitiesIn` drops a token in first
    // position — every sentence starts capitalised, so a leading capital says
    // nothing — which means "Dana Lee" contributes only "lee", and a message
    // opening "Hi Dana," was failing for naming the person it is addressed to.
    ...String(contact.name || '').split(/\s+/).map(fold).filter(Boolean),
    ...String(job?.company || '').split(/\s+/).map(fold).filter(Boolean),
  ]);
  const cvFolded = fold(cvText);
  // The job title too: `entitiesIn` drops its first word for the same reason
  // as the name's, so "Innovation and Design Engineer" failed on "innovation".
  const jdFolded = fold(jd) + fold(aboutThem) + fold(job?.title);
  const midSentence = msg.replace(/(^|[.!?]\s+|\n\s*)([A-Z][a-z']*)(?=[\s.,;:!?]|$)/g, (m, pre, w) => pre + w.toLowerCase());
  for (const e of entitiesIn(midSentence)) {
    const f = fold(e);
    if (allowed.has(e) || MESSAGE_WORDS.has(f)) continue;
    if (f && (cvFolded.includes(f) || jdFolded.includes(f))) continue;
    const bare = f.replace(/'s?$/, '').replace(/s$/, '');
    if (bare && (cvFolded.includes(bare) || jdFolded.includes(bare))) continue;
    problems.push(`"${e}" is named in the message but not in cv.md or the posting`);
  }
  return { ok: problems.length === 0, problems, notices };
}

/** Words a message may capitalise without naming anything. */
const MESSAGE_WORDS = new Set([
  'hi', 'hello', 'thanks', 'thank', 'best', 'alex', 'rivera', 'im', 'ive', 'id', 'ill',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'linkedin', 'lakeside', 'university', 'springfield', 'illinois',
  'portfolio', 'resume', 'attached', 'senior',
]);

/**
 * Draft it: ask, check, ask once more with the problems named, and return what
 * there is WITH its problems — never silently, and never sent.
 */
export async function writeOutreach(job, {
  jd = null, channel = 'email', persona = 'team', contact = {}, spec = null,
  request = '', ask = askText, retries = 1, sources = null, timeoutMs = 150_000, bin = 'claude', lead = null, portfolio = portfolioUrl(),
} = {}) {
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    return { ok: false, text: '', problems: [], notices: [], why: 'writing switched off (JARVIS_TAILOR=off)', channel, persona };
  }
  const src = sources || sourcesFor();
  const condensed = jd ? condenseJd(jd) : '';
  const prompt = buildOutreachPrompt({
    job, jd: condensed, channel, persona, contact, spec,
    cvText: src.cvText, narrative: src.narrative, voiceRules: src.voiceRules, request, lead, portfolio,
  });
  let text = '';
  let check = null;
  let why = '';
  try {
    text = stripSelfTalk(await ask(prompt, { timeoutMs, bin }));
    check = checkOutreach(text, { channel, cvText: src.cvText, jd: condensed, job, contact, lead, portfolio });
    for (let i = 0; i < retries && !check.ok; i += 1) {
      const again = `${prompt}\n\nYOUR LAST DRAFT FAILED THESE CHECKS — fix each one and answer with the whole message again:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\nAnswer with the message ONLY: no character or word count, no note about the checks, nothing before or after it.\n\n--- your last draft ---\n${text}`;
      text = stripSelfTalk(await ask(again, { timeoutMs, bin }));
      check = checkOutreach(text, { channel, cvText: src.cvText, jd: condensed, job, contact, lead, portfolio });
    }
  } catch (err) {
    why = String(err?.message || err).slice(0, 300);
  }
  return {
    ok: !!check?.ok,
    text,
    problems: check?.problems || [],
    notices: check?.notices || [],
    why,
    channel,
    persona,
  };
}

/**
 * THE WRITER'S NOTES TO ITSELF, taken off the message (2026-09-26).
 *
 * Asked again with its failed draft quoted back, the model answered with its
 * own bookkeeping first: "40 words, 274 characters — within both bounds.
 * Checked against the rules: …" and then the note. That was saved as his
 * message to Agility's Chief Hardware Officer, and Sunday's began "277
 * characters, 43 words." Leading or trailing sentences that only count or
 * grade the message are dropped; the message itself is never touched.
 */
const SELF_TALK = /\b\d+\s*(?:characters?|chars?|words?)\b|\bchecked against\b|\bwithin (?:both |the )?(?:bounds|limits?)\b|^(?:here(?:'s| is)|revised|final|updated)\b[^.!?]*\b(?:draft|note|message|version)\b/i;
export function stripSelfTalk(text) {
  let s = String(text || '').trim();
  for (let i = 0; i < 6; i += 1) {
    const first = (s.match(/^[^\n]*?(?:[.!?](?=\s)|\n|$)/) || [''])[0];
    if (!first || !SELF_TALK.test(first)) break;
    const rest = s.slice(first.length).trim();
    if (!rest) break;
    s = rest;
  }
  const lines = s.split('\n');
  while (lines.length > 1 && SELF_TALK.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n').trim();
}

export const _internals = { TEAM_RE, REPORTS_RE, BACKDOOR_RE, VISA_RE, FAKE_RAPPORT_RE, MESSAGE_WORDS };
