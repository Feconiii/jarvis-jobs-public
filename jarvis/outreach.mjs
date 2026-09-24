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
import { numbersIn, entitiesIn } from './resume-tailor.mjs';
import { sourcesFor, askText, BANNED, SELF_NEGATION } from './cover-letter.mjs';
import { condenseJd } from './tailor-llm.mjs';

/** The channels, and what each one physically allows. */
export const CHANNELS = {
  // LinkedIn caps a connection note at 300 characters and a free account at
  // roughly 5 personalised notes a month. The note's job is to earn a
  // CONVERSATION, not the connection: acceptance rates are the same with and
  // without one (26.42% vs 26.37% over 20M requests), but a personal note
  // roughly doubles the post-accept reply rate (9.36% vs 5.44%).
  note: { label: 'LinkedIn note', maxChars: 280, minWords: 25, maxWords: 55 },
  // 75-150 words is the highest-reply band in every dataset in OUTREACH.md.
  email: { label: 'Email', maxChars: 1400, minWords: 70, maxWords: 155 },
  // Same length as an email; the shared school is the one piece of earned
  // context a student reliably has, and it is a fact, not manufactured rapport.
  alumni: { label: 'Alumni email or message', maxChars: 1400, minWords: 70, maxWords: 155 },
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
  { key: 'alumni', rank: 1, label: 'State University alumni at the company', why: 'the shared school is real earned context, and alumni reply to students' },
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
export function linkedinSearch(company, persona, { team = '', managerTitle = '', school = 'State University' } = {}) {
  const terms = [];
  if (company) terms.push(`"${company}"`);
  if (persona === 'alumni') terms.push(`"${school}"`);
  if (persona === 'team' && team) terms.push(`"${team}"`);
  if (persona === 'manager' && managerTitle) terms.push(`"${managerTitle}"`);
  if (persona === 'recruiter') terms.push('recruiter');
  if (persona === 'team' && !team) terms.push('engineer');
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

/** Rapport nobody earned. */
const FAKE_RAPPORT_RE = /\b(?:i (?:really )?(?:loved|enjoyed|read) your (?:post|article|talk|paper|interview)|your (?:recent )?(?:post|talk|article) (?:on|about)|we (?:met|spoke|connected) at|i (?:saw|caught) your talk|big fan of your)\b/i;

export function buildOutreachPrompt({
  job, jd = '', channel = 'email', persona = 'team', contact = {}, cvText = '', narrative = {}, voiceRules = '', spec = null, request = '',
}) {
  const ch = CHANNELS[channel] || CHANNELS.email;
  const who = PERSONAS.find((p) => p.key === persona) || PERSONAS[1];
  const name = clean(contact.name) || 'the person';
  const theirTitle = clean(contact.title);
  const team = clean(spec?.team || job?.team);
  return `Write a FIRST outreach message from Alex Rivera, a mechanical engineering student at State University graduating May 2027.

WHO IT GOES TO
  ${name}${theirTitle ? `, ${theirTitle}` : ''} at ${job?.company || 'the company'}
  You are writing to ${who.label} — ${who.why}.
${team ? `  The role sits in: ${team}\n` : ''}
THE POSTING HE IS INTERESTED IN
  ${job?.title || ''} at ${job?.company || ''}${job?.location ? ` (${job.location})` : ''}
${jd ? `\n--- the posting, condensed ---\n${jd.slice(0, 2500)}\n` : ''}
HIS BACKGROUND — the ONLY source of facts about him
${cvText.slice(0, 6000)}
${narrative.headline ? `\nHow he describes himself: ${narrative.headline}\n` : ''}
HOW HE WRITES
${voiceRules.slice(0, 3000)}

THE RULES, AND THEY ARE NOT STYLE PREFERENCES
1. ASK FOR INFORMATION, NOT A REFERRAL. Not "can you refer me", not "can you
   pass my resume along", not a hint of either. Ask about the work: how the
   team is set up, what they actually build, what they look for in someone
   starting out. A reader spots a backdoor application in about two minutes and
   the goodwill goes with it. The referral gets offered later, by them.
2. ONLY WHAT IS TRUE AND SOURCED. Every fact about him comes from the CV above;
   everything about the company comes from the posting. Never invent a shared
   history, a talk, an article you read, a mutual acquaintance, or a meeting.
   If there is no earned connection, there is no earned connection — say why
   you are writing plainly instead.
3. NEVER MENTION VISA, SPONSORSHIP, OPT OR WORK AUTHORISATION. It is irrelevant
   in a first message and it invites a filter that does not apply to him: OPT
   needs nothing from an employer.
4. ${ch.label.toUpperCase()}: ${channel === 'note'
    ? `at most ${ch.maxChars} characters, so roughly ${ch.minWords}-${ch.maxWords} words. One specific thing, one easy out. No greeting line, no sign-off — it is a connection note.`
    : `${ch.minWords}-${ch.maxWords} words. Open with who he is in one line, the specific thing he is asking about, and an easy out ("no worries if you are heads-down"). Sign off with his first name only.`}
5. No em dashes. No markdown. No bullet lists. No adjectives about himself that
   the CV does not evidence. Plain sentences.
6. One ask. Not three questions stacked up.
${request ? `\nHE ASKED FOR: ${request}\n` : ''}
Answer with the message text and nothing else.`;
}

/**
 * Check the draft against the rules that cost something when broken.
 * `problems` fail the draft and trigger a rewrite; `notices` are for him.
 */
export function checkOutreach(text, { channel = 'email', cvText = '', jd = '', job = null, contact = {} } = {}) {
  const problems = [];
  const notices = [];
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, problems: ['the message is empty'], notices };
  const ch = CHANNELS[channel] || CHANNELS.email;
  const wordCount = msg.split(/\s+/).filter(Boolean).length;

  if (channel === 'note' && msg.length > ch.maxChars) {
    problems.push(`${msg.length} characters; a LinkedIn note is capped at ${ch.maxChars}`);
  }
  if (wordCount > ch.maxWords) problems.push(`too long: ${wordCount} words (${ch.minWords}-${ch.maxWords} is the reply band)`);
  if (wordCount < ch.minWords) problems.push(`too short: ${wordCount} words (${ch.minWords}-${ch.maxWords} is the reply band)`);

  // THE THREE THAT COST THE CONTACT, not just the reply.
  if (BACKDOOR_RE.test(msg)) problems.push('asks for a referral in a first message — that is the backdoor application the research says kills it');
  if (VISA_RE.test(msg)) problems.push('mentions visa or sponsorship; a first message never does (OUTREACH.md §4)');
  if (FAKE_RAPPORT_RE.test(msg)) problems.push('claims a shared history, a talk or an article — nothing here can verify that, so it cannot be said');

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
  const allowedNums = new Set([...numbersIn(cvText), ...numbersIn(jd), ...numbersIn(String(job?.title || ''))]);
  for (const n of numbersIn(msg)) {
    if (allowedNums.has(n) || /^(?:19|20)\d{2}$/.test(n)) continue;
    problems.push(`figure "${n}" is not in cv.md or the posting`);
  }
  const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowed = new Set([
    ...entitiesIn(cvText), ...entitiesIn(jd),
    ...entitiesIn(String(job?.company || '')), ...entitiesIn(String(job?.title || '')),
    ...entitiesIn(String(job?.team || '')), ...entitiesIn(String(contact.title || '')),
    // THE PERSON'S OWN NAME, word by word. `entitiesIn` drops a token in first
    // position — every sentence starts capitalised, so a leading capital says
    // nothing — which means "Dana Lee" contributes only "lee", and a message
    // opening "Hi Dana," was failing for naming the person it is addressed to.
    ...String(contact.name || '').split(/\s+/).map(fold).filter(Boolean),
    ...String(job?.company || '').split(/\s+/).map(fold).filter(Boolean),
  ]);
  const cvFolded = fold(cvText);
  const jdFolded = fold(jd);
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
  'linkedin', 'state university', 'university', 'springfield', 'illinois',
]);

/**
 * Draft it: ask, check, ask once more with the problems named, and return what
 * there is WITH its problems — never silently, and never sent.
 */
export async function writeOutreach(job, {
  jd = null, channel = 'email', persona = 'team', contact = {}, spec = null,
  request = '', ask = askText, retries = 1, sources = null, timeoutMs = 150_000, bin = 'claude',
} = {}) {
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    return { ok: false, text: '', problems: [], notices: [], why: 'writing switched off (JARVIS_TAILOR=off)', channel, persona };
  }
  const src = sources || sourcesFor();
  const condensed = jd ? condenseJd(jd) : '';
  const prompt = buildOutreachPrompt({
    job, jd: condensed, channel, persona, contact, spec,
    cvText: src.cvText, narrative: src.narrative, voiceRules: src.voiceRules, request,
  });
  let text = '';
  let check = null;
  let why = '';
  try {
    text = await ask(prompt, { timeoutMs, bin });
    check = checkOutreach(text, { channel, cvText: src.cvText, jd: condensed, job, contact });
    for (let i = 0; i < retries && !check.ok; i += 1) {
      const again = `${prompt}\n\nYOUR LAST DRAFT FAILED THESE CHECKS — fix each one and answer with the whole message again:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\n--- your last draft ---\n${text}`;
      text = await ask(again, { timeoutMs, bin });
      check = checkOutreach(text, { channel, cvText: src.cvText, jd: condensed, job, contact });
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

export const _internals = { TEAM_RE, REPORTS_RE, BACKDOOR_RE, VISA_RE, FAKE_RAPPORT_RE, MESSAGE_WORDS };
