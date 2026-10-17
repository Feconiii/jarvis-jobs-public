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
import { condenseJd, run, describeFailure, ownsExamples, graduation } from './tailor-llm.mjs';
import { person } from './targeting.mjs';
import { numbersIn, entitiesIn, forbiddenClaims } from './resume-tailor.mjs';

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

/**
 * WHERE THE DRAFTS STOP SOUNDING LIKE HIM (2026-09-26). His words: "it read
 * well initially but then dives into unnecessary details, or add fluffy
 * bullshit deviating from my examples". Both are measurable against the
 * eleven letters, and none of the eleven trips either check.
 *
 * DETAIL arrives as paragraph length: every one of his paragraphs is two to
 * five sentences, three in almost all of them, while the role paragraphs that
 * walked through a fixture's dovetails ran six.
 *
 * FLUFF arrives as a lesson stated as a general truth, or a sentence that
 * points at the posting instead of saying anything: "the experience taught me
 * that the visible failure is not always the root cause", "which is the
 * discipline that enclosures … depend on", "is the work I want to build my
 * career on". He says what the work taught him as a capability ("taught me how
 * to move from analysis to execution") and never writes a maxim.
 */
export const MAX_SENTENCES = 5;
export const FILLER = [
  [/\b(?:taught|showed|reminded|convinced) me that\b/i, '"taught me that …": a lesson stated as a general truth; say what it taught him to DO'],
  [/\b(?:that|this|which|it) is (?:exactly |precisely |also )?the (?:kind|sort|standard|habit|discipline|mindset|instinct|lesson|approach|work|same (?:habit|standard|discipline|instinct)) (?:of |that |I |this |a |the |he |these |your )/i, '"that is the habit/standard/discipline …": a sentence pointing at the posting instead of saying something'],
  // His named tell ("that is exactly the kind of"), with any subject. Not
  // "type of": his own Parker Hannifin letter says "exactly the type of".
  [/\bis (?:exactly |precisely )?the (?:kind|sort) of\b/i, '"is exactly the kind of …": a tell he has named'],
  [/\b(?:finished|done|complete|successful) only when\b/i, 'a maxim ("… only when …")'],
  [/\bbuild (?:my|a) career (?:on|around)\b/i, '"build my career on": filler his letters never use'],
  [/\bI would be proud to\b/i, '"I would be proud to": filler his letters never use'],
];

export function registerProblems(text) {
  const problems = [];
  const paras = String(text || '').trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  paras.forEach((p, i) => {
    const n = (p.match(/[.!?](?=\s+["“]?[A-Z]|\s*$)/g) || []).length;
    if (n > MAX_SENTENCES) problems.push(`paragraph ${i + 1} runs ${n} sentences (his run two to five, three in almost every one): it is carrying detail his letters leave to the resume`);
  });
  for (const [re, said] of FILLER) {
    const m = re.exec(String(text || ''));
    if (m) problems.push(`${said}: "${m[0].trim()}"`);
  }
  return problems;
}

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

/**
 * THE BODIES OF HIS ELEVEN LETTERS, paragraphs restored (2026-09-26).
 *
 * The .txt files are PDF extractions: hard-wrapped lines, no blank line between
 * paragraphs. A paragraph ends on a line that ends a sentence and stops short
 * of the page width; measured on all eleven, that recovers his shape (two to
 * four sentences, three in almost every paragraph). The header above "Dear"
 * and the sign-off are the page's job, so they are cut.
 */
export function hisLetters(dir = HIS_LETTERS_DIR) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    const lines = readFileSync(path.join(dir, f), 'utf-8').split(/\r?\n/);
    const start = lines.findIndex((l) => /^Dear\b/.test(l));
    if (start < 0) continue;
    let end = lines.findIndex((l, i) => i > start && /^Sincerely\b/.test(l));
    if (end < 0) end = lines.length;
    const body = lines.slice(start + 1, end).map((l) => l.trim()).filter(Boolean);
    if (!body.length) continue;
    const width = Math.max(...body.map((l) => l.length));
    const paras = [];
    let cur = [];
    for (const l of body) {
      cur.push(l);
      if (/[.!?]["”’]?$/.test(l) && l.length < width * 0.93) { paras.push(cur.join(' ')); cur = []; }
    }
    if (cur.length) paras.push(cur.join(' '));
    out.push(paras.join('\n\n').replace(/[’‘]/g, "'"));
  }
  return out;
}

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
  const cv = read(cvPath);
  return {
    style: read(stylePath).slice(0, 6000),
    exemplar,
    letters: hisLetters(),
    // The letter is written from cv.md alone (2026-09-26). His stories are
    // told at interview depth by design, and a letter that had them walked
    // through how he found a jam, one step at a time.
    cv,
    cvText: cv + stories,
    narrative: profile.narrative || {},
    coverLetter: profile.cover_letter || {},
    candidate: profile.candidate || {},
    voiceRules,
    framing: framing.slice(0, 5000),
  };
}

export function buildCoverLetterPrompt({ job, jd, cvText, narrative = {}, voiceRules = '', framing = '', resumeLines = [], request = '', style = '', exemplar = '', letters = [] }) {
  const company = job?.company || 'the company';
  const title = job?.title || 'the role';
  // ALL ELEVEN OF HIS LETTERS, when they can be read (2026-09-26). With one
  // sample against a 36,000-character CV, the drafts opened in his voice and
  // then drifted into the CV's own register: part features, a printer too
  // small, how a jam was reproduced by hand. Eleven letters make the level of
  // detail impossible to miss. They sit at the END of the prompt, after the
  // facts, because what the writer read last is what it writes like.
  const shown = letters.length
    ? letters.map((l, i) => `--- his letter ${i + 1} ---\n${String(l).trim()}`).join('\n\n')
    : (exemplar ? `--- his letter ---\n${exemplar}` : '(no letters available)');
  // Whose letter, and the one sentence of his history quoted as a warning.
  const own = ownsExamples();
  const grad = graduation();
  return `Write the BODY of ${person.fullName}'s cover letter for one job posting.

Plain text only: no markdown, no code fence, no bullet points, no headings, no
subject line. Do NOT write the date, his address, the company address, the
"Dear …" line or the sign-off — the page around your text already has all of
those. Start at the first word of the first paragraph and stop at the last word
of the last one. Five or six paragraphs. 300 to 420 words.

WHO HE IS (the only source of facts about him — his CV in full, and his own narrative)
${narrative.headline ? `Headline: ${narrative.headline}\n` : ''}${narrative.exit_story ? `In his words: ${String(narrative.exit_story).trim()}\n` : ''}${Array.isArray(narrative.superpowers) && narrative.superpowers.length ? `What he is best at: ${narrative.superpowers.join(' · ')}\n` : ''}
--- cv.md ---
${String(cvText || '').slice(0, CV_BUDGET)}
--- end of cv.md ---
The CV is written at resume depth: part features, tools, figures, steps. The
letter is not. Use the CV to know WHAT he did, and say it the way his letters
below say it.
${resumeLines.length ? `\nTHE RESUME GOING WITH THIS LETTER leads with these lines. Do not repeat them and do not quote their numbers; the resume carries the detail, the letter carries the summary:\n${resumeLines.map((l) => `- ${l}`).join('\n')}\n` : ''}
THE JOB
Company: ${company}
Title: ${title}
${jd || '(no description available — write to the title, and keep it short)'}
${framing ? `\nWHAT TO EMPHASISE, by role (from his own notes):\n${framing}\n` : ''}${String(request || '').trim() ? `\n${person.firstName.toUpperCase()}'S NOTE FOR THIS LETTER (his own words): "${String(request).trim().replace(/"/g, "'").slice(0, 600)}"\nHonour it wherever the rules allow; it can never add a fact that is not in his CV.\n` : ''}
${voiceRules ? `NEVER IN A LETTER:\n${voiceRules.slice(0, 6000)}\n\n` : ''}HOW HE WRITES THESE. Read out of the ${own ? 'eleven ' : ''}cover letters he wrote himself;
the letters that follow are the specification.
${style || '(style file missing — follow his letters below exactly)'}

HIS OWN LETTERS. Their facts are old and are NOT material (his job titles have
changed; cv.md is the only source of facts). Their register, their level of
detail, their paragraph length and their sentences are what you copy.
${shown}
--- end of his letters ---

THE SHAPE, paragraph by paragraph — his, from those letters:

1. AN INTRODUCTION, NOT EVIDENCE. "I am writing to apply for the ${title}
   position at ${company}." Then what he is studying and what kind of work he
   is looking for. Then one sentence on why this company and this work interest
   him, built only from what the posting itself says they do. NEVER open with a
   project or an achievement: a letter that starts ${own ? `"At Applied Materials I
   designed…" reads as abrupt and rude, and he has said so.` : `"At my internship I
   built…" reads as abrupt.`}
2. One role from his CV: the role, the KINDS of work it involved, what that
   work required or built in him, and one sentence tying it to what this
   posting asks for.
3. Another role, the same shape, different evidence. As many roles as the
   posting gives a reason for, each in its own paragraph: two or three is
   usual, and a third company, a project or his club work is welcome when it
   is the better evidence for this posting.
4. What draws him to THIS role in particular, named from the posting's own
   responsibilities, and what he is eager to learn or develop by doing them.
   No evidence here: no project, course, club or internship is named in this
   paragraph. His letters sometimes add one sentence of how he works ("I am
   comfortable learning new tools independently").
5. The close: looking forward to discussing it, and thanks for their time and
   consideration. Two or three sentences.

LEVEL OF DETAIL. This is the rule the drafts break most, and it is where they
stop sounding like him.
- Three sentences per paragraph, four at most. His run two to four.
${own ? `- Name the work as KINDS of work, the way he does: "multiple process
  improvement and design focused projects, including tolerance analysis, layout
  optimization, and efficiency studies on automated production lines." Never
  walk through how one problem was solved.
- NO MECHANISM. No part features (dovetails, ball plungers, self locking
  mounts), no equipment limits (a printer too small), no diagnosis steps
  (feeding material by hand, one tight section), no single incident told start
  to finish. If a sentence needs the hardware explained to make sense, cut it.
  The resume and the interview carry those.` : `- Name the work as KINDS of work: the range of projects a role involved, said
  in one sentence. Never walk through how one problem was solved.
- NO MECHANISM. No step-by-step method, no tool-by-tool detail, no single
  incident told start to finish. If a sentence needs the work explained to make
  sense, cut it. The resume and the interview carry those.`}
- ONE ROLE PER PARAGRAPH. Each role gets its own paragraph at the same
  summary level; a role is never packed in beside another as extra detail.
- WHAT A ROLE TAUGHT HIM IS A CAPABILITY, in his form: "taught me how to move
  from analysis to execution", "strengthened my understanding of how design
  decisions affect assembly, tolerances, and serviceability". Never a general
  truth about engineering ("a design is finished only when…", "the visible
  failure is not always the root cause"), never "that is the habit / standard /
  discipline this role calls for", never "is the kind of work I want to build
  my career on". Those are the lines that read as filler.

THE RULES
1. Every fact comes from cv.md or his narrative above. Every tool, company,
   product, standard and job title you write must appear there or in the
   posting. If you are not sure a thing is in his CV, leave it out. Never claim
   a certification, a language, a tool or an ownership that is not in cv.md.
2. NO FIGURES. ${own ? 'Not one of his own eleven letters' : 'A cover letter'} quotes a number, a percentage
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
5. ${grad.done ? `He graduated in ${grad.label}. Say that once, in the first paragraph, as part of
   what he studied.` : `He graduates in ${grad.label}. Say that once, in the first paragraph, as part of
   what he is studying.`} Do not discuss visas unless the posting asks.
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
  problems.push(...registerProblems(letter));
  // NEVER WHAT HE HAS NOT DONE (F-408). Checked mechanically because the cost
  // of one of these reaching a hiring manager is the application.
  for (const [re, said] of SELF_NEGATION) {
    if (re.test(letter)) problems.push(`says ${said} — a letter never volunteers what he cannot do`);
  }
  for (const what of forbiddenClaims(letter, cvText, { prose: true })) problems.push(`claims ${what}, which he does not have`);
  // NO FIGURES IN THE BODY. Not one appears in any of his eleven; the resume
  // carries the numbers and the letter carries the reasoning behind them.
  const bodyFigures = [...String(letter).matchAll(/\b\d[\d.,]*%?\b/g)].map((m) => m[0])
    .filter((n2) => !/^(?:19|20)\d\d$/.test(n2));
  if (bodyFigures.length) notices.push(`quotes ${bodyFigures.length === 1 ? 'a figure' : 'figures'} (${bodyFigures.slice(0, 4).join(', ')}); his own letters carry none`);
  // The BODY is what is checked; "Sincerely, Alex Rivera" is drawn by the page
  // around it (cover-letter-page.mjs), so a body that ends without his name is
  // right rather than worth a notice. A body that signs itself is the fault.
  const signName = person.fullName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\bsincerely,?\\s*(?:${signName})?\\s*$`, 'i').test(letter)) notices.push(`signs itself; the page already adds "Sincerely, ${person.fullName}" under it`);

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
  // NOT voice-dna.md's writing rules (2026-09-26). That file is his voice for
  // posts and chat: contractions, one-to-two-sentence paragraphs, "be
  // specific: numbers, names, concrete details", end on what the evidence has
  // in common. Every one of those contradicts his eleven letters, and it sat
  // after the job in the prompt, so the letters opened in his register and
  // then drifted into part-level detail and closing maxims. What the letter
  // keeps from it is the banned vocabulary (BANNED, already cut to fit his
  // letters by F-408) and the reframe, both enforced below.
  const never = `These words: ${BANNED.join(', ')}.\nThe reframe: "this is not X, it is Y", "not just X but Y", and any sentence that rejects one framing to assert another.`;
  const prompt = buildCoverLetterPrompt({
    job, jd: condensed, cvText: src.cv ?? src.cvText, narrative: src.narrative, voiceRules: never, framing: src.framing,
    resumeLines, request, style: src.style, exemplar: src.exemplar, letters: src.letters || [],
  });
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

/**
 * A WORD THE FORM ASKS TO SEE IN THE LETTER (PsiQuantum, 2026-09-25).
 *
 * "Please include the word "purple" in the cover letter submitted." sat on the
 * form as a Yes/No list, beside a cover-letter slot the engine filled with a
 * letter that did not contain it — a screen he would have failed without
 * knowing. The words are read off the form's own questions; nothing else
 * supplies them.
 */
const LETTER_WORD_RE = /\b(?:include|use|mention|add|put)\s+the\s+(?:word|phrase|term|keyword)s?\s+["“'‘]([^"”'’]{1,40})["”'’]\s+(?:somewhere\s+)?(?:in|within|into)\s+(?:your|the)\s+cover\s+letter/i;
export function letterWordsFrom(labels = []) {
  const out = [];
  for (const l of labels) {
    const m = LETTER_WORD_RE.exec(String(l || ''));
    if (m && !out.includes(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

/** The writer's instruction for those words, added to any note of his. */
export function letterWordsRequest(words = [], request = '') {
  if (!words.length) return String(request || '');
  const ask = `The application asks that the letter include ${words.map((w) => `the word "${w}"`).join(' and ')}. Use it once, in an ordinary sentence.`;
  return [String(request || '').trim(), ask].filter(Boolean).join('\n');
}

/**
 * The letter as attached always carries them. A draft that left one out gets
 * a last line saying so plainly, rather than a Yes on the form that is untrue.
 */
export function withLetterWords(text, words = []) {
  let t = String(text || '');
  // Word by word, so "purple" is not found inside "purpleness" — and a phrase
  // as a run of those words.
  const tokens = ` ${t.toLowerCase().split(/[^\p{L}\p{N}]+/u).join(' ')} `;
  const missing = words.filter((w) => !tokens.includes(` ${String(w).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `));
  if (t && missing.length) t = `${t.replace(/\s+$/, '')}\n\nThe word your application asks for: ${missing.join(', ')}.`;
  return t;
}
