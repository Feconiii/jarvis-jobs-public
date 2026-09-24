/**
 * A cover letter for one posting, in his voice, from his files.
 *
 * SOURCE OF TRUTH, the same as the resume: every fact comes from cv.md and
 * config/profile.yml's narrative; voice-dna.md governs how it reads and never
 * adds a claim; modes/_profile.md says what to emphasise per role. The job
 * description is the other input. Nothing else — and what he types beside
 * the form (his note) steers, never adds.
 *
 * THE GUARD. Prose cannot be held to the resume's word-for-word vocabulary
 * test (a letter says "I'd like" and "your team"), so it is held to the two
 * checks that catch a fabricated fact: every FIGURE in the letter must be in
 * cv.md or the posting, and every NAMED THING (a tool, a company, a product,
 * a standard) must be in cv.md, the posting, or the salutation. On top of
 * that, voice-dna's banned list — the words and constructions that mark text
 * as machine-written — fails the letter outright. A letter that fails is
 * asked for once more with the problems named; a second failure ships with
 * its problems listed, because he reads every letter before it goes anywhere
 * and the panel shows him exactly what to check.
 *
 * It never sends anything. The panel shows the text; copying or filling a
 * cover-letter box is his click.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { condenseJd, run, describeFailure } from './tailor-llm.mjs';
import { numbersIn, entitiesIn } from './resume-tailor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
export const CV_PATH = path.join(ROOT, 'cv.md');
export const PROFILE_PATH = path.join(ROOT, 'config', 'profile.yml');
export const VOICE_PATH = path.join(ROOT, 'voice-dna.md');
export const MODE_PATH = path.join(ROOT, 'modes', '_profile.md');
/** The style read out of his own letters, and the letters themselves. */
export const STYLE_PATH = path.join(ROOT, 'cover-letters', 'STYLE.md');
export const HIS_LETTERS_DIR = path.join(ROOT, 'cover-letters', 'his');
/**
 * His stories, in his words (interview-prep/*.md): the failure, the work ethic,
 * what he believes. None of it is in cv.md, so the writer could never answer a
 * question about HIM with anything but a project (2026-09-23).
 */
export const STORIES_DIR = path.join(ROOT, 'interview-prep');

/**
 * HOW MUCH OF THE CV A PROMPT CARRIES (F-539). It was 14,000 characters in all
 * three prompts while cv.md is 36,000, so the approved details, scope limits,
 * skills and characterizations — everything past line 193 — never reached the
 * writer or its reviewer. The ceiling is a guard against a runaway file, not a
 * budget to trim to.
 */
export const CV_BUDGET = 80000;

/**
 * Words and phrases that fail the letter.
 *
 * HIS OWN LETTERS ARE THE SPECIFICATION (F-408). The list used to carry "I am
 * excited", "I am eager" and "I would be thrilled" from the general anti-slop
 * vocabulary — and every one of those appears in the eleven letters he wrote
 * himself. A rule that fails his own writing is the wrong rule, so the phrases
 * he actually uses came out and only the machine tells are left.
 */
export const BANNED = [
  'delve', 'realm', 'harness', 'unlock', 'tapestry', 'paradigm', 'cutting-edge', 'revolutionize', 'revolutionise',
  'intricate', 'intricacies', 'showcasing', 'showcase', 'crucial', 'pivotal', 'leverage', 'leveraging', 'synergy',
  'game-changer', 'game changer', 'supercharge', 'future-proof', 'seamless', 'seamlessly', 'passionate about',
  'dream job', "in today's", 'it is worth noting', "it's worth noting", 'it is important to note',
  'furthermore', 'moreover', 'that said', 'that being said', 'moving forward', 'at the end of the day',
  'let that sink in', 'dive in', 'dive into', 'unpack', 'with that in mind', 'on top of that',
  'i believe i would be a great fit', 'perfect fit', 'ideal candidate', 'to whom it may concern',
  'hit the ground running', 'proven track record',
];

/**
 * A LETTER NEVER SAYS WHAT HE HAS NOT DONE (F-408).
 *
 * His words, on reading a draft that opened its third paragraph with "I have
 * not designed an actuator or a gearbox" on an actuator design role: "who the
 * actual fuck say on cover letter i have not designed a gearbox". Nothing on
 * that form asked him. A letter that volunteers a disqualification hands the
 * reader a reason to stop reading, and it goes out under his name.
 *
 * This is not a style rule and it is not negotiable, so it is matched
 * mechanically rather than left to the prompt. If a requirement is not
 * something he has, the letter is silent about it and says what he does have.
 */
export const SELF_NEGATION = [
  [/\bI (?:have|had) not\b/i, '"I have not …" — the letter never says what he has not done'],
  [/\bI (?:haven't|hadn't)\b/i, '"I have not …" in its short form'],
  // "yet", "currently" and "directly" are the adverbs that walk a gap past a
  // literal match. "I do not yet have direct high-volume molding experience"
  // is the commonest shape of all, and until 2026-09-13 it matched nothing
  // here — so the one sentence in an answer that most needed checking was the
  // one sentence nothing looked at.
  [/\bI (?:do|did) not (?:yet |currently |directly |really )?have\b/i, '"I do not have …"'],
  [/\bI (?:don't|didn't) have\b/i, '"I do not have …" in its short form'],
  [/\bI (?:lack|am lacking|am missing)\b/i, '"I lack …"'],
  [/\bI (?:am|'m) (?:new to|unfamiliar with|still learning)\b/i, '"I am new to …" — say what he has done instead'],
  [/\b(?:limited|little|no) (?:direct |hands on |hands-on |formal |professional )?experience\b/i, '"limited/no experience"'],
  [/\bI have never\b/i, '"I have never …"'],
  [/\b(?:while|although|though) I have not\b/i, 'a "while I have not …" concession'],
  [/\byet to (?:design|build|work|use|do)\b/i, '"yet to …"'],
  [/\bI (?:cannot|can't) claim\b/i, '"I cannot claim …"'],
];

/** "This isn't X. This is Y." and its family — voice-dna's fatal tell. */
const REFRAME_RE = /\b(?:this\s+(?:isn't|is\s+not)|it\s+(?:isn't|is\s+not)|not\s+(?:just|only|merely))\b[^.!?\n]{2,80}[.!?;]\s*(?:this\s+is|it's|it\s+is|but)\b/i;

/** Words a letter uses that look like names but are not claims. */
const LETTER_WORDS = new Set([
  'dear', 'hiring', 'manager', 'team', 'committee', 'recruiter', 'recruiting', 'sincerely', 'regards', 'best', 'thanks',
  'thank', 'alex', 'rivera', 'i', "i'd", "i'm", "i've", "i'll", 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'engineer', 'engineering', 'intern', 'internship', 'university', 'bachelor', 'science', 'mechanical', 'gpa', 'us', 'usa',
  'opt', 'f-1', 'f1', 'h-1b', 'h1b', 'stem', 'cad', 'fea', 'cnc', 'iot',
]);

const fold = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9&$%./'+-]+/g, ' ').trim();
const words = (s) => fold(s).split(/\s+/).filter(Boolean);

/** What the letter is written from. Read fresh each time: he edits these files. */
export function sourcesFor({ cvPath = CV_PATH, profilePath = PROFILE_PATH, voicePath = VOICE_PATH, modePath = MODE_PATH, stylePath = STYLE_PATH, storiesDir = STORIES_DIR } = {}) {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
  let profile = {};
  try { profile = yaml.load(read(profilePath)) || {}; } catch { profile = {}; }
  const voice = read(voicePath);
  // The voice file's rules and banned lists; its later sections are examples.
  const voiceRules = voice.split(/\n## 4\./)[0].slice(0, 9000);
  const mode = read(modePath);
  const framing = mode.split(/\n## Your Adaptive Framing/)[1]?.split(/\n## /)[0] || '';
  // HIS OWN LETTERS ARE THE SPECIFICATION (F-408). One of them goes into the
  // prompt whole: describing a voice is weaker than showing it, and the
  // eleven he wrote are the only description of his voice that cannot drift.
  // WHICH of the eleven is chosen used to be "the shortest", so the example
  // could not crowd out the posting. Length is a budget, not a reason: the
  // shortest letter is the one with the least of his voice in it, and it was
  // the ONLY sample the open-ended answer writer ever saw (2026-09-22).
  //
  // Now the fullest letter that still fits the budget — the most of his writing
  // the prompt can afford. Ties and unreadable directories fall back exactly as
  // before, so a machine without the letters behaves identically.
  const BUDGET = 4500;
  let exemplar = '';
  try {
    const files = readdirSync(HIS_LETTERS_DIR).filter((f) => f.endsWith('.txt'));
    const bodies = files.map((f) => readFileSync(path.join(HIS_LETTERS_DIR, f), 'utf-8').trim())
      .filter((t) => /\bDear\b/.test(t));
    const fits = bodies.filter((t) => t.length <= BUDGET).sort((a, b) => b.length - a.length);
    // Nothing inside the budget: take the shortest and truncate, as before.
    const chosen = fits[0] || bodies.sort((a, b) => a.length - b.length)[0] || '';
    exemplar = chosen.slice(0, BUDGET);
  } catch { exemplar = ''; }
  // HIS STORIES TRAVEL AS PART OF THE CV, so every fact check that accepts a
  // cv.md line accepts his own story too, and nothing downstream needs a
  // second source threaded through it. Top-level .md files only; sessions/
  // holds prep notes, not statements of fact.
  let stories = '';
  try {
    stories = readdirSync(storiesDir).filter((f) => f.endsWith('.md')).sort()
      .map((f) => `\n\n--- his stories: interview-prep/${f} ---\n${readFileSync(path.join(storiesDir, f), 'utf-8').trim()}`)
      .join('');
  } catch { stories = ''; }
  return {
    style: read(stylePath).slice(0, 6000),
    exemplar,
    cvText: read(cvPath) + stories,
    narrative: profile.narrative || {},
    coverLetter: profile.cover_letter || {},
    candidate: profile.candidate || {},
    voiceRules,
    framing: framing.slice(0, 5000),
  };
}

export function buildCoverLetterPrompt({ job, jd, cvText, narrative = {}, voiceRules = '', framing = '', resumeLines = [], request = '', style = '', exemplar = '' }) {
  const company = job?.company || 'the company';
  const title = job?.title || 'the role';
  return `Write the BODY of Alex Rivera's cover letter for one job posting.

Plain text only: no markdown, no code fence, no bullet points, no headings, no
subject line. Do NOT write the date, his address, the company address, the
"Dear …" line or the sign-off — the page around your text already has all of
those. Start at the first word of the first paragraph and stop at the last word
of the last one. Five paragraphs. 300 to 420 words.

HOW HE WRITES THESE. This is not a general style note: it is read out of the
eleven cover letters he wrote himself, and they are the specification.
${style || '(style file missing — follow the example below exactly)'}

ONE OF HIS OWN LETTERS, as the model to write like:
--- his letter ---
${exemplar || '(no exemplar available)'}
--- end of his letter ---

WHO HE IS (the only source of facts about him — his CV in full, and his own narrative)
${narrative.headline ? `Headline: ${narrative.headline}\n` : ''}${narrative.exit_story ? `In his words: ${String(narrative.exit_story).trim()}\n` : ''}${Array.isArray(narrative.superpowers) && narrative.superpowers.length ? `What he is best at: ${narrative.superpowers.join(' · ')}\n` : ''}
--- cv.md ---
${String(cvText || '').slice(0, CV_BUDGET)}
--- end of cv.md ---
${resumeLines.length ? `\nTHE RESUME GOING WITH THIS LETTER leads with these lines. Do not repeat them and do not quote their numbers; the resume carries the figures, the letter carries the reasoning:\n${resumeLines.map((l) => `- ${l}`).join('\n')}\n` : ''}
THE JOB
Company: ${company}
Title: ${title}
${jd || '(no description available — write to the title, and keep it short)'}
${framing ? `\nWHAT TO EMPHASISE, by role (from his own notes):\n${framing}\n` : ''}${String(request || '').trim() ? `\nALEX'S NOTE FOR THIS LETTER (his own words): "${String(request).trim().replace(/"/g, "'").slice(0, 600)}"\nHonour it wherever the rules allow; it can never add a fact that is not in his CV.\n` : ''}
${voiceRules ? `HIS VOICE RULES, which the style above sits inside:
${voiceRules.slice(0, 6000)}

` : ''}THE SHAPE, paragraph by paragraph — his, from those eleven letters:

1. AN INTRODUCTION, NOT EVIDENCE. "I am writing to apply for the ${title}
   position at ${company}." Then what he is studying and what kind of work he
   is looking for. Then one sentence on why this company and this work interest
   him, built only from what the posting itself says they do. NEVER open with a
   project or an achievement: a letter that starts "At Applied Materials I
   designed…" reads as abrupt and rude, and he has said so.
2. One role from his CV, told as a story: what he worked on, what it required,
   what it taught him, and the sentence tying it to what this posting asks for.
3. A second role, the same shape, different evidence.
4. What draws him to THIS role in particular, named from the posting's own
   responsibilities, and what he wants to learn by doing them.
5. The close: looking forward to discussing it, and thanks for their time and
   consideration.

THE RULES
1. Every fact comes from cv.md or his narrative above. Every tool, company,
   product, standard and job title you write must appear there or in the
   posting. If you are not sure a thing is in his CV, leave it out. Never claim
   a certification, a language, a tool or an ownership that is not in cv.md.
2. NO FIGURES. Not one of his own eleven letters quotes a number, a percentage
   or a dollar amount, and this one does not either. Say what the work was and
   what it required. The resume carries the numbers.
3. NEVER WRITE WHAT HE HAS NOT DONE. No "I have not", no "I lack", no "while I
   have limited experience in", no "I am new to". A draft once opened its third
   paragraph with "I have not designed an actuator or a gearbox" on an actuator
   design role, which hands the reader a reason to stop reading. If the posting
   asks for something he does not have, say nothing about it and write about
   what he does have instead.
4. Do not flatter the company beyond what the posting says. Do not invent a
   mission, a product, a culture or a news item about them.
5. He graduates in May 2027. Say that once, in the first paragraph, as part of
   what he is studying. Do not discuss visas unless the posting asks.
6. Formal and even. No contractions, no em dashes, no clipped fragments, no
   adjectives about himself. Full sentences that flow. Compound modifiers stay
   open: "hands on", "data driven", "fast paced", "root cause".

ANSWER: the five paragraphs only, separated by blank lines.`;
}

/**
 * Hold a letter to the facts and the voice. Problems fail it; notices are
 * worth a glance. The salutation, sign-off and calendar words are not claims.
 */
export function checkCoverLetter(text, { cvText = '', jd = '', job = null } = {}) {
  const problems = [];
  const notices = [];
  const letter = String(text || '').trim();
  if (!letter) return { ok: false, problems: ['the letter is empty'], notices };
  const wordCount = words(letter).length;
  // HIS OWN LETTERS RUN 255 TO 430 WORDS, 350 on average, measured across all
  // eleven. The old bound (under 260) was a quarter of a letter shorter than
  // anything he has ever sent, which is most of why the drafts read clipped.
  if (wordCount > 460) problems.push(`too long: ${wordCount} words (his run 255 to 430)`);
  if (wordCount < 220) problems.push(`too short: ${wordCount} words (his run 255 to 430)`);
  if (/[—–]/.test(letter)) problems.push('has an em dash (voice-dna bans them)');
  if (/```|^#{1,3}\s|\*\*/m.test(letter)) problems.push('has markdown in it');
  const low = letter.toLowerCase().replace(/[’‘]/g, "'");
  for (const b of BANNED) {
    const re = new RegExp(`(?:^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i');
    if (re.test(low)) problems.push(`uses "${b}", which voice-dna bans`);
  }
  if (REFRAME_RE.test(letter)) problems.push('has a "this isn\'t X, it\'s Y" reframe (voice-dna\'s fatal tell)');
  // NEVER WHAT HE HAS NOT DONE (F-408). Checked mechanically because the cost
  // of one of these reaching a hiring manager is the application.
  for (const [re, said] of SELF_NEGATION) {
    if (re.test(letter)) problems.push(`says ${said} — a letter never volunteers what he cannot do`);
  }
  // NO FIGURES IN THE BODY. Not one appears in any of his eleven; the resume
  // carries the numbers and the letter carries the reasoning behind them.
  const bodyFigures = [...String(letter).matchAll(/\b\d[\d.,]*%?\b/g)].map((m) => m[0])
    .filter((n2) => !/^(?:19|20)\d\d$/.test(n2));
  if (bodyFigures.length) notices.push(`quotes ${bodyFigures.length === 1 ? 'a figure' : 'figures'} (${bodyFigures.slice(0, 4).join(', ')}); his own letters carry none`);
  // The BODY is what is checked; "Sincerely, Alex Rivera" is drawn by the page
  // around it (cover-letter-page.mjs), so a body that ends without his name is
  // right rather than worth a notice. A body that signs itself is the fault.
  if (/sincerely,?\s*(?:alex rivera)?\s*$/i.test(letter)) notices.push('signs itself; the page already adds "Sincerely, Alex Rivera" under it');

  // FIGURES: his, the posting's, or a year in the calendar.
  const allowedNums = new Set([...numbersIn(cvText), ...numbersIn(jd), ...numbersIn(String(job?.title || ''))]);
  for (const n of numbersIn(letter)) {
    if (allowedNums.has(n)) continue;
    if (/^(?:19|20)\d{2}$/.test(n)) continue;
    problems.push(`figure "${n}" is not in cv.md or the posting`);
  }

  // NAMED THINGS: his, the posting's, the company's, or a letter's own furniture.
  const allowedEnts = new Set([
    ...entitiesIn(cvText), ...entitiesIn(jd), ...entitiesIn(String(job?.company || '')), ...entitiesIn(String(job?.title || '')),
  ]);
  const jdFolded = fold(jd);
  const cvFolded = fold(cvText);
  const companyWords = new Set(words(String(job?.company || '')));
  // A sentence's first word is capitalised because it is first, not because
  // it is a name ("That's the part…", "Designed a fixture…"); it is read in
  // lower case unless it carries an inner capital or a digit (NX, UR10e).
  const midSentence = letter.replace(/(^|[.!?]\s+|\n\s*)([A-Z][a-z']*)(?=[\s.,;:!?]|$)/g, (m, pre, w) => pre + w.toLowerCase());
  for (const e of entitiesIn(midSentence)) {
    const f = fold(e);
    if (allowedEnts.has(e) || LETTER_WORDS.has(f) || companyWords.has(f)) continue;
    if (f && (cvFolded.includes(f) || jdFolded.includes(f))) continue;
    // A possessive or plural of something he has ("Applied Materials'", "AMRs").
    const bare = f.replace(/'s?$/, '').replace(/s$/, '');
    if (bare && (cvFolded.includes(bare) || jdFolded.includes(bare) || companyWords.has(bare))) continue;
    problems.push(`"${e}" is named in the letter but not in cv.md or the posting`);
  }
  return { ok: problems.length === 0, problems, notices };
}

/** The CLI, prompt on stdin, letter on stdout. */
export async function askText(prompt, { timeoutMs = 150_000, bin = 'claude', models = null, meta = null } = {}) {
  const out = await run(bin, ['-p'], { input: prompt, timeout: timeoutMs, models });
  // `meta` is how the caller learns WHICH model wrote this without askText
  // having to stop returning a string — writeCoverLetter, the tests and the
  // series writers all hand its result straight on.
  if (meta) {
    meta.requested = out.requested || (models && models[0]) || '';
    meta.model = out.model || '';
    meta.fellBack = Boolean(out.fellBack);
    meta.fallbacks = out.fallbacks || [];
  }
  return String(out.stdout || '').replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
}

/**
 * Write the letter: ask, check, ask once more with the problems named, and
 * return what there is — with its problems, never silently.
 */
export async function writeCoverLetter(job, {
  jd = null, request = '', ask = askText, retries = 1, sources = null, resumeLines = [], timeoutMs = 150_000, bin = 'claude',
} = {}) {
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    return { ok: false, text: '', problems: [], notices: [], why: 'writing switched off (JARVIS_TAILOR=off)', request: String(request || '') };
  }
  const src = sources || sourcesFor();
  const condensed = jd ? condenseJd(jd) : '';
  const prompt = buildCoverLetterPrompt({ job, jd: condensed, cvText: src.cvText, narrative: src.narrative, voiceRules: src.voiceRules, framing: src.framing, resumeLines, request, style: src.style, exemplar: src.exemplar });
  let text = '';
  let check = null;
  let why = '';
  try {
    text = await ask(prompt, { timeoutMs, bin });
    check = checkCoverLetter(text, { cvText: src.cvText, jd: condensed, job });
    for (let i = 0; i < retries && !check.ok; i += 1) {
      const again = `${prompt}\n\nYOUR LAST DRAFT FAILED THESE CHECKS — fix each one and answer with the whole letter again:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\n--- your last draft ---\n${text}`;
      const second = await ask(again, { timeoutMs, bin });
      const c2 = checkCoverLetter(second, { cvText: src.cvText, jd: condensed, job });
      if (c2.problems.length <= check.problems.length) { text = second; check = c2; }
      why = check.ok ? 'written; the second draft passed the checks' : `written; ${check.problems.length} problem(s) remain after a second draft`;
    }
    if (!why) why = check.ok ? 'written; passed the checks' : `written; ${check.problems.length} problem(s) — read it before you use it`;
  } catch (e) {
    return { ok: false, text: '', problems: [], notices: [], why: describeFailure(e, bin, 'cover letter', timeoutMs), request: String(request || '') };
  }
  return { ok: check.ok, text, problems: check.problems, notices: check.notices, why, request: String(request || '') };
}
