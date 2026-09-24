/**
 * The written questions — "tell us about a project you are proud of", "why do
 * you want to work here", "why should we hire you" — answered in his voice,
 * from his files.
 *
 * These used to fall straight through to `unknown`: the engine filled thirty
 * fields, hit a textarea asking for two hundred words, and left it blank with
 * "no answer for this question, and it is required". Every one of those is an
 * application he has to finish by hand, which is exactly the work this thing
 * exists to take off him.
 *
 * SOURCE OF TRUTH, the same as the resume and the letter: cv.md,
 * config/profile.yml's narrative, and the posting. voice-dna.md governs how it
 * reads and never adds a claim. Nothing else. An answer that names a tool, a
 * company or a figure not in one of those fails its check and is rewritten —
 * this text goes out under his name to a human who will ask him about it in an
 * interview, so a sentence he cannot defend is worse than a shorter answer.
 *
 * IT NEVER PRESSES SUBMIT. It writes into the box; the button stays his.
 */
import { condenseJd, describeFailure, JUDGMENT_MODELS } from '../tailor-llm.mjs';
import { numbersIn, entitiesIn } from '../resume-tailor.mjs';
import { reviewAnswer, reviewFeedback } from './answer-review.mjs';
import { mkdirSync as mkdirDebug, writeFileSync as writeDebug } from 'fs';
import pathForDebug from 'path';
import { fileURLToPath as urlToPath } from 'url';

export const DEBUG_PROMPT_FILE = process.env.JARVIS_PROMPT_DEBUG_FILE
  || pathForDebug.join(pathForDebug.dirname(urlToPath(import.meta.url)), '..', '..', 'logs', 'last-answer-prompt.txt');

/** The last assembled answer prompt, overwritten each time (never throws). */
export function savePromptForDebug(prompt, { question = '', job = null, kind = '', target = null, limits = null } = {}) {
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_PROMPT_DEBUG || ''))) return;
  try {
    mkdirDebug(pathForDebug.dirname(DEBUG_PROMPT_FILE), { recursive: true });
    const head = `# ${new Date().toISOString()} · ${job?.company || 'no company'} · ${job?.title || 'no title'} · job ${job?.id || 'none'}
# question: ${question} · kind: ${kind} · length ${target?.min}-${target?.max} words${limits?.words ? ` · form limit ${limits.words} words` : ''}${limits?.chars ? ` · form limit ${limits.chars} chars` : ''}
# ${String(prompt).length} characters

`;
    writeDebug(DEBUG_PROMPT_FILE, head + prompt);
  } catch { /* debugging must never cost him an answer */ }
}
import {
  sourcesFor, askText, BANNED, SELF_NEGATION, CV_BUDGET,
} from '../cover-letter.mjs';
import { LINKS_BOX_RE } from './_answers.mjs';
import { corpusBlock, loadObservations } from './corpus.mjs';

/**
 * WHAT KIND OF QUESTION THIS IS, from its label alone.
 *
 * Ordered: the first hit wins, and the specific patterns come before the
 * general ones so "why do you want to work at X" does not land in "other".
 * `null` means it is not a written question at all — a name, a city, a date —
 * and nothing here should touch it.
 */
export const KINDS = [
  // "Brief Cover Letter" (Charge Robotics, 2026-09-17) was answered as a
  // project story with a closer, because nothing told the writer it was a
  // letter. First, so no other pattern claims it.
  ['cover-letter', /\bcover letter\b|\bletter of (?:interest|intent|motivation)\b|\bmotivation(?:al)? letter\b/i,
    'a short cover letter body in his own letter register: why this company and this role, then the one or two pieces of his work that fit it, no salutation and no sign-off'],
  // `tell us(?: about)?` — Gradient Robotics writes it without the "about":
  // "Tell us a technical project you built and the hardest problem you hit
  // building it". That fell to `other`, which cost twice: the project brief
  // never reached the writer, and `other` is not a story kind, so the guard
  // against opening on a resume line fired on an answer that had every right
  // to open where the work happened.
  ['project', /\b(?:project|something you (?:built|made|designed)|piece of work|technical (?:work|achievement|accomplishment))\b.*\b(?:proud|tell us|describe|share|walk us)|(?:proud|tell us(?: about)?|describe|share|walk us through)\b.*\b(?:project|something you built)\b/i,
    'one project of his own, told as an engineer tells it'],
  ['why-company', /\bwhy (?:do you |would you |are you )?(?:want(?: to)?|interested|excited|keen)\b.*\b(?:here|us|this company|our|work(?:ing)? (?:at|for|with))|why (?:this company|us|our company|do you want to join)\b/i,
    'why this company, built only from what the posting says they do'],
  ['why-role', /\bwhy (?:this|the) (?:role|position|job|opening|team)\b|what (?:interests|excites|draws|attracts) you (?:most )?(?:about|to) (?:this|the) (?:role|position|job|team|opportunity)/i,
    'why this role in particular, named from its own responsibilities'],
  // `why would you be a good fit` — found by the regression run, 2026-09-19.
  // "We are a small team and everyone wears several hats. Why would you be a
  // good fit here?" matched nothing, fell to `other`, and therefore ALSO fell
  // to the cheaper model: a fit question, the kind this table exists for,
  // answered by the fallback because a modal verb was missing from the list.
  ['why-you', /\bwhy should we (?:hire|consider|choose|pick)\b|what (?:makes|would make) you (?:a )?(?:good|great|strong|the right)\b|why (?:are|would) you (?:be )?(?:a |an )?(?:good|great|strong|the right)\b|\bwhy you\b.{0,20}\bfit\b/i,
    'what he brings, as evidence rather than adjectives'],
  // "WHY APPLIED INTUITION?" — the commonest form of the question, and the one
  // the first version of this list missed entirely (caught on a live Ashby
  // form, 2026-09-09). A bare "Why <something>?" with no verb in it: no
  // "want", no "interested", nothing for the pattern above to hook on. It sits
  // AFTER why-you so "Why should we hire you?" still wins, and it refuses the
  // openers that belong to other questions.
  ['why-company', /^\s*why\s+(?!should\b|are\b|did\b|have\b|were\b|is\b|was\b|does\b|would\s+you\s+be\b)[^?.!\n]{2,60}\??\s*$/i,
    'why this company, built only from what the posting says they do'],
  // "What motivates you to explore career opportunities at TSMC?" (live,
  // 2026-09-19) matched NOTHING on this list and fell through to the generic
  // brief, which is how it came back as a JD summary with an internship bullet
  // stapled on. Alex, on that answer: *"Stop writing motivation answers like a
  // JD summary followed by a resume bullet."*
  //
  // Only the words that belong to motivation alone. "What interests you about
  // this role" and "What excites you about Applied Intuition" are why-role and
  // why-company, they are already pinned as such, and a first draft of this
  // pattern took both — so it sits below them and never names their verbs.
  ['motivation', /\bwhat (?:motivates|motivated|drives|drove) you\b|\bwhat (?:is|are) your motivations?\b|\bmotivations? (?:for|to) (?:apply|join|explor|pursu|seek)/i,
    'why he genuinely wants this, in his own words — desire and direction first, evidence only where it explains why the interest is real'],
  // A QUESTION ABOUT HIM IS NOT A QUESTION ABOUT A PROJECT.
  //
  // "When was the hardest you worked in your life?" and "what was the hardest
  // problem you hit building it?" both used to land in `challenge`, so a
  // question about effort and motivation was answered with a technical project
  // summary. Measured 2026-09-22 against his corpus: on Watney's work-ethic
  // question the live answer carried three technical-inventory terms where the
  // answer he KEPT carried none — his own "technical detail can substitute for
  // meaning", on the question where it costs most.
  //
  // His commentary on the rejected version says it exactly: "The human
  // question is about effort, pressure, motivation, and how the person got
  // through it. Technical depth crowded out the personality signal."
  //
  // Sits ABOVE `challenge`, because the words overlap and the more specific
  // reading has to win.
  ['character', /\bhardest\b[^?.!\n]{0,30}\b(?:you(?:'ve| have)? ever )?work(?:ed)?\b[^?.!\n]{0,30}\b(?:life|ever)\b|\bbiggest (?:professional )?failure\b|\bhow did you get through\b|\b(?:historical|fictional) (?:empire|figure|character)\b|\bwhat (?:inspires|drives) you\b(?!.*\b(?:about|to apply)\b)|\btell us something about yourself\b/i,
    'this asks about HIM, not about a project: effort, pressure, what he actually believes, how he got through it. '
    + 'Answer it the way a person answers it. A technical project may appear as the setting, never as the subject, '
    + 'and never as a list of what the thing was made of. If the honest answer has no engineering in it, it has none'],
  ['challenge', /\b(?:describe|tell us about|share|give an example of)\b.*\b(?:challenge|difficult|hardest|failure|failed|mistake|conflict|disagree|setback|problem you)\b|\ba time (?:when|you)\b/i,
    'one real situation from his CV: what happened, what he did, what came of it'],
  ['strength', /\b(?:greatest|biggest|your) (?:strength|weakness)|what are you (?:best|worst) at\b/i,
    'answered plainly, with work he has actually done as the evidence'],
  ['contribution', /\bwhat (?:would|will|can) you (?:bring|contribute|add)\b|how (?:would|will) you contribute\b/i,
    'what he would bring, from his own experience'],
  ['goals', /\b(?:career|professional) (?:goal|aspiration|objective)|where do you see yourself|what do you (?:hope|want) to (?:learn|achieve|gain)\b/i,
    'what he wants from this work, honestly and briefly'],
  // A SIZE HINT, NOT A TEMPLATE — and read the correction below before
  // reaching for this list again.
  //
  // Alex, 2026-09-13, on the answer written for his "Evidence of Excellence"
  // box: *"its too low context and out of nowhere… straight off the bat its
  // mumbling gibberish."* My first fix was to add this pattern, and he was
  // right to push back on it: *"you cant train it for specific questions. when
  // i call it it should know about me, the job, the company, the culture, the
  // social setting… Do not solve this by creating a special rule for Evidence
  // of Excellence. That will just fail on the next unfamiliar question."*
  //
  // He is right, and the real fix is in `buildAnswerPrompt`: the writer reads
  // the situation — what the question is testing, who reads it, what the
  // posting hires for, which of his evidence sells him THERE — before it
  // writes a word, and it does that whether or not anything here matched.
  // Proven on two live postings, 2026-09-13: the same question produced
  // automation-equipment evidence for Tesla Optimus and precision-design,
  // tolerance and release evidence for KLA metrology.
  //
  // This entry survives for one honest reason: LENGTH. A question asking him
  // to make his whole case needs 150-260 words, and 70-150 would cut it off
  // mid-argument. Nothing else here depends on it, and a question that misses
  // every pattern in this list must still get a good answer.
  ['excellence', /\b(?:evidence of (?:excellence|impact|exceptional)|exceptional ability|extraordinary ability|accomplishments? that (?:highlight|demonstrate|show)|most impressive|proudest (?:accomplishment|achievement|work)|greatest (?:accomplishment|achievement)|what makes you (?:exceptional|outstanding|stand out)|why are you exceptional|highlight your (?:ability|abilities|achievements))\b|^\s*evidence of [\w\s]{2,30}$/i,
    'his case, made the way he would make it out loud: the claim first, then the work that proves it, each piece with what it produced'],
  ['other', /\b(?:tell us|describe|explain|share|elaborate|in your own words|anything else|additional (?:information|comments|context))\b/i,
    'a direct answer to exactly what was asked'],
];

/**
 * QUESTIONS THE WRITER MUST NOT ANSWER, however they are phrased.
 *
 * The answer table refuses these by rule, but its patterns are anchored tight
 * ("^disability status$") so a question already understood cannot be reached
 * by a looser one. A prose box asking the same thing in a sentence — "Please
 * describe your disability status" — matched none of them, fell through to
 * unknown, and would have been handed to the model to compose. Caught by its
 * own test before it ever ran.
 *
 * Three groups, all for the same reason: the answer is not the model's to
 * write. Self-identification and demographics are his and the law's. Salary,
 * notice period and start date are numbers out of his profile or decisions he
 * has not made. Names, referees and references are other people.
 */
export const OFF_LIMITS = [
  /\b(?:disabilit|veteran|rac(?:e|ial)\b|ethnic|gender|sexual orientation|transgender|pronoun|religio|national origin|age\b|date of birth|marital status|self[- ]?identif|eeo|equal employment|accommodation)/i,
  /\b(?:salary|compensation|pay|wage|rate)\b.*\b(?:expect|requirement|desired|range|history)|\bexpected (?:salary|compensation|pay)\b/i,
  /\b(?:notice period|when (?:can|could) you start|available to start|start date|earliest start)\b/i,
  /\b(?:references?|referees?|referrals?|who referred you|referred by)\b/i,
  /\b(?:criminal|conviction|felony|background check|drug (?:test|screen)|immigration status|visa status|sponsorship)\b/i,
  /\b(?:password|social security|ssn|government id|bank|routing)\b/i,
  // "HOW DID YOU HEAR ABOUT US" IS A FACT ONLY HE HAS.
  //
  // Caught while widening the company patterns (2026-09-09): "Tell us how you
  // heard about Applied Intuition" classified as a written question, and the
  // model would have had to make the answer up — it does not know whether he
  // found the posting on LinkedIn, through the scanner, or from a friend, and
  // there is nothing in cv.md that could tell it. An invented answer here is
  // small and completely unnecessary, which is the worst kind.
  /\b(?:how did you (?:hear|find out|learn)|where did you (?:hear|find)|how you heard|source of (?:referral|application))\b/i,
];

/** Is this label one the writer must leave alone whatever its shape? */
export function offLimits(label) {
  const text = String(label || '');
  return OFF_LIMITS.some((re) => re.test(text));
}

/**
 * A BOX THAT IS THE SECOND OF THREE.
 *
 * Read off his live Neuralink form: "Please provide three examples of
 * accomplishments that highlight your exceptional ability. First example:",
 * then "Second example:", then "Third example:". The first label carries the
 * whole question; the other two carry an ordinal and nothing else.
 *
 * Answered one at a time, blind, that produces three answers to a question
 * only the first one was told — and, worse, three answers about the same piece
 * of work, because each is written from the same CV with the same instruction.
 * Three copies of his fixture project is a worse outcome than three blanks.
 *
 * Returns the 1-based position, or 0 when the label is not one of these.
 */
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
export function seriesIndex(label) {
  const text = String(label || '').trim();
  const word = text.match(/^\s*(first|second|third|fourth|fifth)\b/i);
  if (word) return ORDINALS.indexOf(word[1].toLowerCase()) + 1;
  // "Example 2", "2.", "#3", "Accomplishment 3"
  const num = text.match(/^\s*(?:#|no\.?\s*)?(?:example|accomplishment|answer|item|reason)?\s*(?:#|no\.?)?\s*([1-5])\b/i)
    || text.match(/^\s*([1-5])\s*[.):]/);
  if (num && /^[\s#]*(?:example|accomplishment|answer|item|reason|[1-5#])/i.test(text)) return Number(num[1]);
  return 0;
}

/**
 * Group the written questions on a form into series.
 *
 * A member of a series takes the FIRST member's label as its question — that
 * is where the instruction lives — and is told which of its siblings came
 * before it, so the answers can be different pieces of work rather than three
 * tellings of one. Fields not in a series are returned as they were.
 *
 * `fields` is the plan's essay actions in page order.
 */
export function groupSeries(essays) {
  const out = [];
  let stem = null;
  let position = 0;
  for (const e of essays) {
    const idx = seriesIndex(e.label);
    // A short ordinal label with a stem already open continues that series.
    if (idx > 1 && stem) {
      position += 1;
      out.push({ ...e, stem: stem.label, seriesIndex: idx, seriesOf: stem.count || 0, after: out.filter((x) => x.stem === stem.label).map((x) => x.label) });
      continue;
    }
    // A label that both asks something AND says "three examples" opens one.
    const says = String(e.label || '').match(/\b(two|three|four|five|2|3|4|5)\s+(?:examples?|accomplishments?|answers?|items?|reasons?)\b/i);
    if (says || idx === 1) {
      const words = { two: 2, three: 3, four: 4, five: 5 };
      stem = { label: e.label, count: says ? (words[says[1].toLowerCase()] || Number(says[1]) || 0) : 0 };
      position = 1;
      out.push({ ...e, stem: e.label, seriesIndex: 1, seriesOf: stem.count, after: [] });
      continue;
    }
    stem = null;
    position = 0;
    out.push(e);
  }
  return out;
}

/** A question that asks something of him, rather than asking a yes or a no. */
const OPEN_QUESTION = /^\s*(?:why|what|how|tell us|tell me|describe|share|in your own words)\b/i;
/** …and the yes/no shapes that mention an employer without asking him to write. */
const CLOSED = /^\s*(?:have|has|are|is|were|was|do|does|did|will|would|can|could|may|should)\b/i;

/**
 * The kind of written question this label is, or null when it is not one.
 *
 * `company` is the employer this application is for. It matters because plenty
 * of forms ask the question by name — "Why Applied Intuition?", "What excites
 * you about Applied Intuition?" — where no general pattern can tell the
 * company's name from any other noun.
 */
export function answerKind(label, { company = '' } = {}) {
  const text = String(label || '').trim();
  if (!text || text.length < 6) return null;
  // The refusal comes FIRST, so no pattern below can reach a question policy
  // has already decided is not the model's to answer.
  if (offLimits(text)) return null;
  for (const [kind, re, brief] of KINDS) if (re.test(text)) return { kind, brief };

  // THE EMPLOYER'S OWN NAME, when nothing else matched. An open question that
  // names the company he is applying to is a "why us" question however it is
  // phrased. A CLOSED one is not — "Have you ever worked at Applied
  // Materials?" is a yes and the answer table already knows it (F-376).
  const co = String(company || '').trim();
  if (co.length >= 3 && OPEN_QUESTION.test(text) && !CLOSED.test(text)) {
    const bare = co.replace(/[.,]/g, '').replace(/\s+(?:inc|llc|ltd|corp|corporation|company|co|technologies|technology|labs|robotics)\.?$/i, '').trim();
    if (bare.length >= 3 && new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
      return { kind: 'why-company', brief: 'why this company, built only from what the posting says they do' };
    }
  }
  return null;
}

/**
 * Is this field a written answer at all?
 *
 * HIS RULE, 2026-09-09: "it doesn't have to be a question, it should simply be
 * anything that is an open form for writing, if it doesn't match the common
 * questions that script usually handles."
 *
 * That is the right way round, and the first version had it backwards. It only
 * wrote for labels matching a known pattern, so "Why Applied Intuition?" — and
 * every other phrasing nobody thought of — fell through to "no answer for this
 * question" (F-441). The patterns in KINDS decide what SHAPE the answer takes;
 * they were never the right thing to decide WHETHER to write one. A box built
 * for prose is an invitation to write prose, and the model can read the actual
 * question far better than a regex can guess at it.
 *
 * So: every open writing box, unless
 *   - policy says the answer is not the model's to write (`offLimits`), or
 *   - the answer table already answered it — this only ever runs on a field
 *     that came back `unknown`, so that is settled before we get here, or
 *   - there is no question in the label to answer at all.
 *
 * A single-line text input is still NOT one, however its label reads. Those are
 * "Website", "Portfolio", "LinkedIn URL", and a paragraph typed into a one-line
 * box is worse than leaving it blank. The exception is a one-line box the form
 * itself sized for prose (a maxlength in the hundreds).
 */
export function isWrittenQuestion(field, { company = '' } = {}) {
  const type = String(field?.type || '').toLowerCase();
  const max = Number(field?.maxlength || field?.maxLength || 0);
  // The page reports a <textarea> as type "text" with `multiline` set — every
  // answer-table rule that matches a text field has to keep matching one, so
  // the tag name travels beside the type rather than replacing it.
  const box = field?.multiline === true || type === 'textarea' || (type === 'text' && max >= 200);
  if (!box) return false;

  const label = String(field?.label || '').trim();
  // Nothing to answer. A box with no label at all is not a question, it is a
  // box, and writing two hundred words into one nobody asked a question in is
  // how this feature would start producing noise.
  if (label.length < 6) return false;
  // The refusal, which is the whole reason this is not simply "is it a box".
  if (offLimits(label)) return false;
  // A BIG BOX ASKING FOR LINKS IS STILL A LINKS FIELD.
  //
  // Measured 2026-09-20 on live 1X Technologies and Atomic Semi forms: "Please
  // share links to GitHub, portfolio, publications, or hardware projects (if
  // applicable)." It is a <textarea>, it contains the word "share", and that
  // was enough to route it to the long-form writer — an Opus call, per
  // application, to write prose into a field that wants two URLs. His answer
  // when asked, 2026-09-20: "Just paste the links."
  //
  // Checked on the LABEL, so a genuine question that merely mentions a link
  // ("describe a project and link it if you can") is untouched: this needs the
  // request for links to BE the question.
  if (LINKS_BOX_RE.test(label)) return false;
  // A recognised kind is a written question by definition; anything else is
  // one because the form gave him a page to write on and asked him something.
  return !!answerKind(label, { company }) || /[?:]|\b(?:describe|explain|tell|share|why|what|how|which|when you|your (?:thoughts|view|approach|experience|interest))\b/i.test(label);
}

/**
 * HOW LONG. The form's own limit first — a box with maxlength 500 gets an
 * answer that fits in 500 characters, not one truncated at the browser.
 * Otherwise a length that suits the question: a project answer earns more room
 * than "why us".
 */
/**
 * THE LIMITS THE FORM STATES, from wherever it states them (2026-09-17): an
 * explicit `wordLimit`, the words around the box ("no more than 200 words",
 * "(1,000 characters max)", "200-word limit"), or the box's maxlength.
 */
export function fieldLimits(field = null, context = '') {
  const text = `${field?.label || ''} ${field?.near || ''} ${field?.placeholder || ''} ${context || ''}`;
  const out = { words: Number(field?.wordLimit || 0) || 0, chars: 0 };
  const re = /\b(\d{1,2},\d{3}|\d{2,5})\s*-?\s*(words?|characters?|chars?)\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (/^w/i.test(m[2])) out.words = out.words ? Math.min(out.words, n) : n;
    else out.chars = out.chars ? Math.min(out.chars, n) : n;
  }
  const max = Number(field?.maxlength || field?.maxLength || 0);
  if (max > 0 && max < 524288) out.chars = out.chars ? Math.min(out.chars, max) : max;
  return out;
}

/** The instructions around a box, without its own question repeated at the front. */
export function cleanInstructions(text, question = '') {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  const qq = String(question || '').replace(/\s*\*\s*$/, '').trim();
  if (qq && t.toLowerCase().startsWith(qq.toLowerCase())) t = t.slice(qq.length).replace(/^[\s*:.\-–]+/, '');
  return t.length >= 3 ? t : '';
}

export function targetWords(field, kind) {
  const max = Number(field?.maxlength || field?.maxLength || 0);
  // A STATED LIMIT WINS, wherever the form states it. Plenty of forms put it in
  // the help text beside the box ("Please keep it under 250 words") rather than
  // in the label, and reading only the label meant that box got the 200-word
  // default — fine there, wrong on the one that said 100.
  const stated = fieldLimits(field);
  if (stated.words) return { min: Math.floor(stated.words * 0.6), max: stated.words };
  if (stated.chars && stated.chars !== max) return { min: Math.floor(stated.chars / 12), max: Math.floor(stated.chars / 6.5) };

  // THE KIND'S BAND, WORKED OUT FIRST — because it is a cap, not a fallback.
  //
  // An excellence box is the one he asked to be answered "like a cover letter
  // ish where i flex my work comprehensively" — it holds more than one piece
  // of work, so 150 words is a floor rather than a ceiling.
  const band = kind === 'excellence' ? { min: 150, max: 260 }
    : kind === 'cover-letter' ? { min: 150, max: 250 }
    : (kind === 'project' || kind === 'challenge') ? { min: 110, max: 200 }
      : { min: 70, max: 150 };

  if (max > 0) {
    // ~6.5 characters a word with spaces, and a margin so the box never clips.
    const words = Math.floor((max * 0.85) / 6.5);
    const fromBox = { min: Math.max(25, Math.floor(words * 0.5)), max: Math.max(45, words) };

    // A `maxlength` ONLY EVER NARROWS. It used to be read as the target, so a
    // GENEROUS box raised the ceiling the kind had already set: Tesla's
    // "Evidence of Excellence" reports `maxLength: 2500`, which works out at
    // 326 words, and three answers went out at 317, 325 and 329 words against
    // his 150-260 — every one logged as "passed the checks", because
    // `checkAnswer` only complains above 375. The same question on forms with
    // no maxlength produced 159-216.
    //
    // A maxlength is the most the box will HOLD, not how much to write. Only a
    // tighter one changes the plan, and then the floor comes down with the
    // ceiling so the band cannot invert on a very small box.
    // The floor comes down WITH the ceiling, and lands below it — clamping it
    // to the ceiling would ask for a band of exactly one length (a 900-char
    // excellence box came out `{min:117, max:117}`), which no draft can hit.
    if (fromBox.max < band.max) {
      return {
        min: band.min <= fromBox.max ? band.min : Math.max(25, Math.floor(fromBox.max * 0.6)),
        max: fromBox.max,
      };
    }
  }
  return band;
}

/**
 * THE CONSTRUCTIONS THAT MAKE TEXT READ AS MACHINE-WRITTEN, whatever words
 * they are built from.
 *
 * His words on a draft this file produced, 2026-09-09: "why you gotta include
 * stupid corny shit like the last sentence… i hate the phrase 'that is exactly
 * the kind of' and all the other typical ai phrasing you use". The sentence
 * was: "A fixture is finished only when someone else can build it, run it, and
 * trust what it reports, and that is the standard the detailed design and error
 * proofing in this role calls for."
 *
 * Not one word in it is banned. The SHAPE is the tell — state a general truth
 * about the craft, then tie it back to the posting — and a word list cannot
 * catch a shape. Measured against all eleven of his own letters: none of these
 * fires on anything he wrote. He ties back plainly and specifically instead
 * ("directly supporting the design and integration responsibilities of this
 * role"), which is what the prompt now asks for.
 */
/**
 * OPENINGS THAT BURY THE CLAIM.
 *
 * The sentence he read on his Amazon form, 2026-09-13: *"Designing the machine
 * vision inspection fixture for three Metal Deposition chamber variants at
 * Applied Materials required identifying a lift pin misalignment that could
 * contact and damage downstream hardware, so the classification logic behind
 * it had to stay conservative about passing questionable cases rather than
 * optimize for throughput."* His verdict: *"straight off the bat its mumbling
 * gibberish, no one gets what you are saying."*
 *
 * Every fact in it is true and sourced. The failure is structural: it opens on
 * a participle clause about a REQUIREMENT, so forty words in, the reader still
 * does not know that he built a thing and that it worked. The prompt now asks
 * for the claim first, and this checks it, for the same reason SLOP_SHAPES is
 * checked rather than asked for — the model wrote the aphorism closer while
 * the prompt already said to be plain.
 *
 * Deliberately narrow: only the FIRST sentence, and only the constructions
 * that put reasoning before the thing. A prepositional opening ("At Applied
 * Materials, I designed…") is fine and common in his own letters.
 */
export const BURIED_OPENINGS = [
  // "Designing the fixture required…", "Working on X meant…", "Building Y
  // involved…" — a gerund subject whose verb is a requirement, not an act.
  [/^\s*\w+ing\b[^.!?\n]{0,160}?\b(?:required|meant|involved|demanded|called for|presented|posed)\b/i,
    'on a participle clause about what the work required'],
  // "Because the pin could…", "While the line was…", "Since the tolerance…"
  [/^\s*(?:because|since|while|although|though|whereas|as the|when the|after the|given that|in order to|to ensure|to address)\b/i,
    'on a subordinate clause instead of on what he did'],
  // "The challenge was…", "One of the biggest problems was…" — the problem as
  // the subject of the first sentence, before any work has been named.
  [/^\s*(?:the|one|a) (?:challenge|problem|difficulty|issue|hardest part|biggest)\b[^.!?\n]{0,80}\bwas\b/i,
    'on the problem rather than on the work'],
];

/**
 * CLOSERS THAT SUMMARISE ACROSS THE EXAMPLES.
 *
 * His rule since 2026-09-09 is that the answer STOPS after the last fact, and
 * SLOP_SHAPES catches the aphorism version of breaking it ("a fixture is
 * finished only when…"). It did not catch the other version, which a longer
 * answer invites because it has more than one piece of work to tie together:
 *
 *   "Both results came from the same approach: measure the process directly,
 *   find where the numbers point, and fix the root cause rather than the
 *   symptom."
 *
 * Written on the first excellence answer this file produced, 2026-09-13. Not
 * an aphorism, no banned word in it, and still exactly the sentence he told me
 * to stop writing: it states what the work MEANS instead of ending on what the
 * work WAS. Delete it and the answer is finished and better, every time.
 *
 * Checked on the LAST sentence only — "in each case" mid-answer is ordinary
 * prose, and his own letters use "both" and "the same" freely in the middle.
 */
export const CLOSER_SHAPES = [
  // "Both results came from the same approach: …" — the examples gathered up
  // and turned into a method. What is banned is the GENERALISATION, not the
  // word "both": his own answers end "Both sit close to the design and
  // validation responsibilities this role describes", which is a plain
  // specific tie-back to the posting and is his. The difference is whether the
  // sentence talks about the ROLE or about HOW HE WORKS.
  [/^\s*(?:both|all (?:three|four|of these)|each of (?:these|them)|these (?:two|three|results|projects|examples))\b[^.!?\n]{0,140}\b(?:the same\b|approach|method|instinct|habit|discipline|mindset|way of (?:working|thinking)|taught|learned|came (?:from|out of)|reflect|demonstrate|illustrate|underscore|show(?:s)? (?:that|how|why))/i,
    'a closing sentence that turns the examples into a method'],
  [/^\s*(?:overall|ultimately|in short|in summary|in both cases|in each case|what (?:ties|connects|links|these have)|the (?:common thread|through ?line|pattern here))\b/i,
    'a closing sentence that summarises instead of ending on the work'],
  [/\bthe same (?:approach|method|way of working|instinct|habit|discipline|thinking|process)\b/i,
    'a closing sentence naming "the same approach" behind the work'],
  [/\bwhat (?:I learned|this taught me|these taught me|it taught me)\b/i,
    'a closing sentence about what he learned'],
  // THE STAND-ALONE TIE-BACK — BANNED 2026-09-16, ALLOWED AGAIN 2026-09-19.
  //
  // Two rules used to live here. They were added when the Tesla "Evidence of
  // Excellence" answer ended "That is the same design through deployment path
  // this role asks for…" and he called it filler, and they refused any last
  // sentence that pointed back at the role or said what he would bring.
  //
  // On 2026-09-19 he set the opposite instruction. The answer he rates highest
  // ends "That is the experience I would bring to designing, commissioning,
  // troubleshooting, and improving Tesla's manufacturing equipment" — the exact
  // shape those two rules refused — and his direction was *"emulate the writing
  // style… overwrite all the rules necessary, we dont want to be bound by rules
  // we want max effectiveness"*.
  //
  // So they are gone, and this comment is the record that they were HIS rules
  // first, in case the filler reading comes back.
  //
  // What is still refused below is the empty closer: a generalisation into an
  // "approach" or a "mindset", a summary opener, a line about what he learned.
  // Those are slop in any register. A last sentence that says what he would do
  // for this team is an argument, and arguments may close an answer.
];

export const SLOP_SHAPES = [
  // "…and that is exactly the kind of work this role calls for."
  [/\b(?:and |which |that )?(?:that|this|it|which) is (?:exactly|precisely|just) (?:the|what|why|how)\b/i,
    '"that is exactly the …" — the commonest tie-back tell, and he says he hates it'],
  // "…which is exactly what X asks for."
  [/\bexactly (?:what|the kind of|the sort of)\b/i, '"exactly what / exactly the kind of"'],
  // The aphorism: a general truth about the craft, stated as a definition.
  [/\bA?n? ?\w+ is (?:only )?(?:finished|complete|done|good|useful|worth\b)[^.!?\n]{0,60}\bonly when\b/i,
    'an aphorism about the craft ("a fixture is finished only when…") — he never writes one'],
  [/\b(?:the (?:best|real|hard(?:est)?|whole) (?:part|point|test|measure|thing)) (?:of|about|is)\b/i,
    'a "the real test of X is…" maxim'],
  [/\bis (?:not|n't) (?:about|just|only)\b[^.!?\n]{0,60}\b(?:it is|it's|but)\b/i,
    'a "X is not about Y, it is Z" reframe (voice-dna\'s fatal tell)'],
  // The tie-back that names the posting as a standard or a bar.
  [/\b(?:that|this) is (?:the|exactly the) (?:standard|bar|kind of|sort of|type of|level of)\b/i,
    'a "that is the standard this role calls for" closer'],
  [/\b(?:calls for|demands|asks for) (?:exactly|precisely)\b/i, '"calls for exactly …"'],
  // Self-congratulation dressed as a lesson.
  [/\b(?:taught me that|what I learned is that|the lesson (?:here )?is)\b/i,
    'a "what I learned is that…" moral; say what he did and let it stand'],
  // THE CONTRAST FOR EFFECT (live Tesla run, 2026-09-17): "made before the
  // tooling existed, not fed back after a build", "a production fixture rather
  // than a bench prototype". Knocking down a thing nobody claimed is the
  // rhetorical-contrast shape his voice rules ban.
  [/,\s*not (?:just |only |merely |simply )?(?:a |an |the )?\w+(?:ed|ing)\b/i,
    'a ", not X" contrast for effect'],
  [/\brather than (?:just |only |merely )?(?:a|an) (?:bench|simple|basic|mere|generic|typical|one[- ]off)\b/i,
    'a "rather than a <lesser thing>" contrast for effect'],
  // One Sonnet call, 2026-09-17: "carried it through … rather than stopping at a
  // CAD model", "had to be reliable rather than fast".
  [/\brather than (?:stopping|ending|leaving|just|only|merely|simply|fast|quick|cheap|easy)\b/i,
    'a "rather than" contrast for effect'],
  // "Both projects ran through the same sequence: …" — the summing-up, written
  // mid-answer instead of as the last line.
  [/(?:^|[.!?]\s+)(?:both|all (?:three|of these)) (?:projects|pieces of work|of these|roles|internships|experiences)\b[^.!?\n]{0,80}\b(?:the same|share|shared|followed|ran through)\b/i,
    'a sentence gathering his work into one pattern'],
  // "Both required moving between CAD, a physical build, and the constraints of
  // a running production line." (Charge Robotics, 2026-09-17)
  [/(?:^|[.!?]\s+)(?:both|all three|each|together they|between them)(?: of (?:them|these))? (?:required|involved|meant|demanded|took|called for|came down to|depended on)\b/i,
    'a sentence gathering his work into one pattern'],
  // Logistics nobody asked for, and not his to assert from a CV: "I am based to
  // relocate to the Bay Area and available for the field travel this role expects."
  [/\b(?:willing to travel|available for (?:the )?(?:field )?travel|open to travel|based (?:in|to)|work authori[sz]ation|sponsorship)\b/i,
    'a sentence about travel, where he is based, or work authorization, which the question did not ask (relocation is his and stays allowed)'],
  // "That combination, a physical fixture … and the inspection logic behind it,
  // is the same range your mechanical engineers cover" (Charge Robotics,
  // 2026-09-17) — the tie-back moved mid-answer to dodge the last-line check.
  [/(?:^|[.!?]\s+)(?:that|this|these|those) (?:combination|mix|range|experience|work|background|set of skills|pairing|blend)\b[^.!?\n]{0,160}\b(?:is|are) (?:the same|exactly|precisely|directly)\b/i,
    'a sentence saying his work "is the same" as what the role does'],
  [/\b(?:is|are) the same (?:range|kind of work|work|loop|path|sequence|skills?|problems?) (?:your|this|the) /i,
    'a "the same … your team does" tie-back'],
];

const fold = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9&$%./'+-]+/g, ' ').trim();
const wordsOf = (s) => fold(s).split(/\s+/).filter(Boolean);

/** Words an answer uses that look like names but are not claims about him. */
const ANSWER_WORDS = new Set([
  'i', "i'd", "i'm", "i've", "i'll", 'my', 'alex', 'rivera', 'engineer', 'engineering', 'intern', 'internship',
  'university', 'bachelor', 'science', 'mechanical', 'gpa', 'us', 'usa', 'opt', 'f-1', 'f1', 'h-1b', 'h1b', 'stem',
  'cad', 'fea', 'cnc', 'iot', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
]);

/**
 * WORDS EVERY POSTING USES, so finding one in an answer proves nothing.
 *
 * Used only by the anchor check below. Kept short on purpose: this is a FLOOR
 * — "does the box name one thing out of this posting at all" — not a measure
 * of how well the answer fits. A short list lets a weak answer through; a long
 * one starts failing good answers, and that is the expensive direction.
 */
const GENERIC_JD_WORDS = new Set([
  'engineer', 'engineers', 'engineering', 'design', 'designs', 'designing', 'designer',
  'experience', 'experienced', 'ability', 'abilities', 'skills', 'strong', 'excellent',
  'candidate', 'candidates', 'applicant', 'company', 'companies', 'position', 'positions',
  'opportunity', 'opportunities', 'requirements', 'required', 'responsibilities', 'preferred',
  'qualifications', 'degree', 'bachelor', 'bachelors', 'masters', 'university', 'student',
  'students', 'intern', 'interns', 'internship', 'mechanical', 'technical', 'quality',
  'product', 'products', 'project', 'projects', 'program', 'programs', 'systems', 'system',
  'support', 'develop', 'develops', 'developing', 'development', 'process', 'processes',
  'working', 'teams', 'other', 'their', 'which', 'while', 'these', 'those', 'there', 'where',
  'about', 'including', 'across', 'within', 'through', 'should', 'would', 'could', 'please',
  'apply', 'applying', 'application', 'benefits', 'salary', 'equal', 'employer', 'employment',
]);

/**
 * Hold an answer to the facts and the voice.
 *
 * The same two checks that catch a fabricated fact in a cover letter: every
 * FIGURE must be in cv.md or the posting, every NAMED THING must be in cv.md,
 * the posting or the company's name. Plus voice-dna's banned list, and the
 * rule that he never volunteers what he has not done.
 *
 * One deliberate difference from the letter: FIGURES ARE WELCOME here. His own
 * letters carry none because that is how he writes letters; a question asking
 * about a project he is proud of is answered better with the 70% and the
 * $57,000 than without them. They still have to be his.
 */
/**
 * Split the reading from the answer.
 *
 * FAIL-OPEN ON PURPOSE. A model that ignores the format and returns only the
 * answer must not cost him the box — an answer with no reading in front of it
 * is still an answer, and the reading exists for his benefit, not the
 * checker's. Only the marker being present changes anything.
 */
/**
 * The private plan, the answer, and — separately — the WHOLE plan.
 *
 * `reading` is clipped to 1,200 characters because it is shown under "why this
 * answer" and a plan can run long. The checks must not read that copy. The
 * plan's last field is `unsupported:`, where the writer declares what it could
 * not source from cv.md, and on a real Gradient Robotics plan the evidence
 * section alone passed 1,000 characters — so the one field the check exists to
 * read had been clipped off before it ever ran, and the check silently could
 * never fire. Display gets the short copy; checks get all of it.
 */
export function splitReading(raw) {
  const text = String(raw || '').replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  const m = text.match(/^([\s\S]*?)\n?\s*={2,}\s*ANSWER\s*={2,}\s*\n([\s\S]*)$/i);
  if (!m) return { reading: '', plan: '', text };
  const plan = m[1].replace(/^\s*READING\s*\n/i, '').trim();
  return {
    reading: plan.slice(0, 1200),
    plan,
    text: m[2].trim(),
  };
}

/**
 * THE PLAN MUST REST ON HIS CV (2026-09-17). The writer names the cv.md lines
 * its answer is built on before it writes. At least one of them has to be
 * really there — a six-word run copied from cv.md — or the answer was built on
 * something he never wrote down. A reply with no plan at all is let through:
 * the format is a reasoning aid, and losing it must never cost him the box.
 */
export function planProblems(reading = '', cvText = '') {
  const plan = String(reading || '');
  const m = plan.match(/^\s*evidence:\s*([\s\S]*?)(?=^\s*(?:why these|opening|reader|believe|parts|unsupported|asking|omit):|$(?![\s\S]))/im);
  if (!m) return [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%$]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cv = norm(cvText);
  const lines = m[1].split(/\n|(?<=")\s*[;,]\s*(?=")/).map((l) => l.replace(/^[\s\-*•\d.)]+/, '').replace(/^"|"$/g, '').trim()).filter((l) => l.length > 20);
  if (!lines.length) return [];
  const grounded = (line) => {
    const w = norm(line).split(' ');
    for (let i = 0; i + 6 <= w.length; i += 1) if (cv.includes(w.slice(i, i + 6).join(' '))) return true;
    return false;
  };
  const problems = lines.some(grounded)
    ? []
    : ['the evidence the answer rests on is not in cv.md — build it on lines copied from his CV'];
  // THE TWO DECISIONS THAT HAVE TO BE MADE, NOT JUST REQUESTED.
  //
  // Alex, 2026-09-19, on answers that had the right facts and the wrong shape:
  // *"it retrieves relevant facts and writes them down without making the
  // higher-level editorial decision."* The prompt had asked for that decision
  // in prose for weeks and kept getting resume concatenation, because nothing
  // looked at whether it had been made.
  //
  // `asking` is what the question is evaluating — the decision that separates a
  // motivation question from a qualification question. `omit` is the one that
  // forces selection: naming what was left out and why is the difference
  // between choosing evidence and listing it. Both are cheap to check and both
  // are stripped before anyone sees the answer.
  const slot = (name) => {
    const hit = new RegExp(`^\\s*${name}:\\s*([^\\n]*(?:\\n(?!\\s*[a-z][a-z ]{2,12}:)[^\\n]*)*)`, 'im').exec(plan);
    return hit ? hit[1].trim() : '';
  };
  //
  // Only on a WHOLE plan. `reading` is clipped to 1,200 characters for the
  // panel, and a clipped copy is missing its late fields through no fault of
  // the writer — accusing it of skipping a decision it actually made would
  // spend a redo on a display artefact. `opening:` is the last structural
  // field, so its presence is the test for "this plan arrived intact".
  if (/^\s*opening:/im.test(plan)) {
    const asking = slot('asking');
    if (!asking || asking.length < 12) {
      problems.push('the plan does not say what this question is evaluating — decide that first, because it sets how much of the answer is his past work');
    }
    if (!slot('omit')) {
      problems.push('the plan does not say what was left out — naming what does not earn its place is how evidence gets chosen instead of listed');
    }
  }
  return problems.concat(unsupportedClaims(reading));
}

/**
 * WHAT THE WRITER ITSELF SAYS IT COULD NOT SOURCE.
 *
 * The one thing round 2 still got wrong was an invented REASON: Lam's answer
 * explained that a fixture had to do something "which a single fixed mount
 * could not do once I accounted for the tolerance stack-up". Nothing in cv.md
 * says that. It is his vocabulary, in his register, about his own project, and
 * it is made up.
 *
 * A word-level test cannot find this, and it was measured rather than assumed:
 * that invented clause contains exactly ONE word absent from cv.md ("single"),
 * while a true sentence about the Acme Steel jam contains three ("repeated",
 * "corner", "panel"). A checker built on unfamiliar vocabulary would wave the
 * fabrication through and send the honest sentence back.
 *
 * So the writer declares it instead. The plan ends with `unsupported:`, where
 * it quotes any cause, comparison, number or detail it cannot point to in
 * cv.md. A quote there is a redo, with its own words as the feedback. It costs
 * no second model call, which is the constraint he set.
 */
function unsupportedClaims(reading = '') {
  const m = String(reading).match(/^\s*unsupported:\s*([\s\S]*?)(?=^\s*\w[\w ]{0,20}:|$(?![\s\S]))/im);
  if (!m) return [];
  const said = m[1].replace(/^[\s\-*•]+/, '').trim();
  // "NONE", "none.", "(none)" — and an empty line — all mean it found nothing.
  if (!said || /^\(?\s*none\b/i.test(said) || /^n\/?a\b/i.test(said)) return [];
  return [`it could not source this from cv.md: ${said.replace(/\s+/g, ' ').slice(0, 240)} — cut it or replace it with something he actually wrote`];
}

/** Openings that read as a resume line rather than an argument, for questions that are not a story. */
const RESUME_OPENING = /^\s*(?:at|during my (?:time|internship|co-?op) at|in my (?:internship|role|time) at|while (?:interning|working) at|as an? [a-z ]{0,30}intern at)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,2})/i;

// THE SAME BULLET, WITH THE EMPLOYER MOVED TO THE END OF THE SENTENCE.
//
// Measured 2026-09-17 on the Agility "why are you a good fit" box: "I designed
// and released a machine vision inspection fixture end to end at Applied
// Materials, covering three chamber variants in Autodesk Inventor." The check
// above looks for a sentence that STARTS on the employer, so this walked
// through it — and the answer then listed two more projects without ever
// saying what the reader should conclude.
//
// A bare past-tense accomplishment as the first sentence of a fit, motivation
// or excellence answer is a bullet, wherever the company name sits.
const DID_OPENING = /^\s*I\s+(?:designed|built|ran|led|developed|created|installed|performed|conducted|managed|engineered|fabricated|machined|assembled|implemented)\b/i;
// …unless the same sentence also says what it MEANS for this reader. These are
// the joints his own letters use to turn a fact into an argument.
const CLAIM_IN_SENTENCE = /\b(which is|which meant|that is why|the same|this role|this team|your team|you (?:are|need|build|want)|what (?:you|this)|because|so i|which is why|closest|exactly the|the loop|the kind of)\b/i;
// Only where the box is asking him to make a case. "Tell us anything else"
// and "where do you see yourself" may open on a plain fact; a story already
// may (STORY_KINDS), and forcing an argument onto a factual box would buy a
// redo — 40 to 180 seconds — for nothing.
const PITCH_KINDS = new Set(['cover-letter', 'why-company', 'why-role', 'why-you', 'strength', 'contribution', 'excellence', 'motivation']);
// A sentence that is DESCRIBING WORK HE HAS DONE, rather than saying what he
// wants. Either a first-person past-tense action, or a sentence anchored to
// where and when he did it. Used only to measure how much of a motivation
// answer has turned into a resume.
const PAST_WORK = /\bI\s+(?:\w+\s+){0,2}(?:designed|built|ran|led|developed|created|installed|performed|conducted|managed|engineered|fabricated|machined|assembled|implemented|logged|measured|tested|validated|reduced|improved|automated|wrote|analysed|analyzed)\b|^\s*(?:at|during|while)\s+(?:my\s+)?(?:\w+\s+){0,3}(?:internship|co-?op|Applied Materials|university)/i;

/** A question asking what the work pushed back with. */
const ASKS_WHAT_WAS_HARD = /\b(?:hard(?:est)?|difficult(?:y|ies)?|toughest|challeng\w*|obstacle|setback|blocker|went wrong|problem you (?:hit|faced|ran into|solved)|struggl\w*|failure|failed)\b/i;
/**
 * …and an answer that names one. The language of difficulty, not a shape: a
 * limit, a thing that could not be done the obvious way, two things that could
 * not be solved apart, or an outright failure.
 */
const NAMES_AN_OBSTACLE = /\b(?:could ?n[o']t|could not|cannot|was ?n[o']t able|unable|too (?:small|large|big|slow|tight|short|long|expensive|noisy|hot)|did ?n[o']t fit|would ?n[o']t fit|no way to|ruled out|not an option|prevented|blocked|constrain\w*|limitation|limited by|the (?:hard|difficult|tricky|awkward)\w* (?:part|problem|thing)|what made (?:it|this) (?:hard|difficult)|the problem was|the issue was|kept (?:failing|jamming|breaking)|failed|coupled|in isolation|trade-?off|had to be redesigned|redesigned\b|so it had to|which meant (?:i|we|it) (?:had|could))\b/i;
const STORY_KINDS = new Set(['project', 'challenge']);

/**
 * Does this question need JUDGEMENT rather than retrieval?
 *
 * His instruction, 2026-09-19: open-ended answers go to Opus, and *"Do not use
 * Haiku for these open-ended answers."* He also asked that this be decided by
 * what the task requires, not by a list of question strings — *"Classify based
 * on whether the task requires substantial judgment, persuasion, framing,
 * narrative construction, or evidence selection."*
 *
 * So two signals, either of which is enough:
 *
 *   - the kind is one where the writer has to build an argument and choose what
 *     to leave out (every pitch and every story), or
 *   - the box is long enough that what goes in it is a selection problem. A
 *     three-line box asking for a date is retrieval; forty words of prose about
 *     his experience is not, and TSMC's 500-character experience question is
 *     the case he named where the facts were right and the SELECTION was poor.
 *
 * Short factual extraction — a date, a degree, availability, one skill — stays
 * on the cheaper ladder, which is where the speed comes from.
 */
export function needsJudgment(kind, { target = 0, question = '' } = {}) {
  if (PITCH_KINDS.has(kind) || STORY_KINDS.has(kind) || kind === 'goals') return true;
  if (Number(target) >= 40) return true;
  return /\b(describe|explain|tell us|share with us|walk (?:us|me) through|elaborate|in your own words|why do you|how would you|what would you)\b/i.test(String(question || ''));
}

export function checkAnswer(text, { cvText = '', jd = '', job = null, target = null, question = '', limits = null, kind = null } = {}) {
  const problems = [];
  const notices = [];
  const answer = String(text || '').trim();
  if (!answer) return { ok: false, problems: ['the answer is empty'], notices };

  const count = wordsOf(answer).length;
  if (target) {
    if (count > Math.ceil(target.max * 1.15)) problems.push(`too long: ${count} words (the box wants about ${target.max})`);
    if (count < Math.floor(target.min * 0.7)) problems.push(`too short: ${count} words (aim for ${target.min} to ${target.max})`);
  }
  if (/[—–]/.test(answer)) problems.push('has an em dash (voice-dna bans them)');
  if (/```|^#{1,3}\s|\*\*/m.test(answer)) problems.push('has markdown in it');
  if (/^\s*(?:here is|here's|sure[,!]|certainly|i'd be happy to)\b/i.test(answer)) problems.push('opens by talking to the form instead of answering it');
  // A FIT, MOTIVATION OR EXCELLENCE ANSWER THAT OPENS ON A RESUME LINE. "At
  // Applied Materials I …" as the first words is the shape of a bullet turned
  // into a sentence; the reader has not been told yet what they should believe.
  // Stories (a project, a problem) may open on where it happened.
  if (kind && !STORY_KINDS.has(kind)) {
    const open = answer.match(RESUME_OPENING);
    const target = String(job?.company || '').toLowerCase();
    const opened = open ? open[1].toLowerCase() : '';
    const theirs = target && (opened.startsWith(target.replace(/[,.].*$/, '').trim()) || target.startsWith(opened.split(/\s+/).slice(0, 2).join(' ')));
    if (open && !theirs) {
      problems.push(`opens on a resume line ("${answer.split(/\s+/).slice(0, 4).join(' ')}…") instead of the point this reader should take away`);
    } else if (!open && PITCH_KINDS.has(kind)) {
      // The employer moved to the end of the sentence does not stop it being a
      // bullet. The test is whether the first sentence says anything about
      // what the reader should conclude.
      const first = (answer.match(/^[^.!?\n]+[.!?]?/) || [''])[0];
      if (DID_OPENING.test(first) && !CLAIM_IN_SENTENCE.test(first)) {
        problems.push(`opens on what he did ("${first.trim().split(/\s+/).slice(0, 6).join(' ')}…") without saying what this reader should conclude from it`);
      }
    }
  }
  // A MOTIVATION ANSWER THAT IS MOSTLY PAST WORK IS A FIT ANSWER MISLABELLED.
  //
  // Alex, 2026-09-19, on the answer written for TSMC's "What motivates you to
  // explore career opportunities at TSMC?": *"Stop writing motivation answers
  // like a JD summary followed by a resume bullet… If more than about
  // one-third of the answer is describing my past work, rewrite it."*
  //
  // Measured on words rather than sentences, because the resume paragraph is
  // always the long one. His experience is allowed in — it is what makes the
  // interest credible — but it may not take the answer over.
  // A QUESTION THAT ASKS WHAT WAS HARD MUST BE ANSWERED WITH AN OBSTACLE.
  //
  // Gradient Robotics, 2026-09-19: "Tell us a technical project you built and
  // the hardest problem you hit building it". The answer described the project
  // in full and never said what was hard — his reading of it: *"still too much
  // of a project inventory… it barely answers the part Gradient is probably
  // using to judge you: what went wrong, what constraint made the project hard,
  // and how you engineered around it."*
  //
  // The prompt had told it to answer every part of a multi-part question for
  // weeks. Nothing checked, so nothing happened — the same reason the plan's
  // other decisions had to become checks rather than requests.
  //
  // Deliberately looks for the LANGUAGE OF DIFFICULTY rather than a shape: an
  // obstacle can be a limit, a failure, a thing that could not be done the
  // obvious way, or two things that could not be solved separately.
  if (ASKS_WHAT_WAS_HARD.test(String(question || ''))) {
    if (!NAMES_AN_OBSTACLE.test(answer)) {
      problems.push('the question asks what was hard and the answer never says — name the obstacle plainly, what made it hard, and how he reasoned past it, rather than describing what he built');
    }
  }
  if (kind === 'motivation') {
    const sentences = answer.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    const words = (s) => s.trim().split(/\s+/).length;
    const total = sentences.reduce((n, s) => n + words(s), 0);
    // A SENTENCE THAT PIVOTS FROM THE WORK TO WHAT HE WANTS IS MOTIVATION, not
    // a resume line. "At Applied Materials I deployed AMRs, and I want to go
    // deeper into that work inside a production fab" was being counted whole as
    // past work, which pushed a good 72-word answer to 39% and bought a redo it
    // did not need. Only a sentence that is PURELY about what he did counts.
    const WANTS = /\bI (?:want|would like|am eager|am excited|hope|am drawn|would get|could)\b|\bwould let me\b|\bmade me (?:realise|realize|want)\b|\bgo deeper\b/i;
    const past = sentences.filter((s) => PAST_WORK.test(s) && !WANTS.test(s)).reduce((n, s) => n + words(s), 0);
    if (total > 40 && past > total / 3) {
      problems.push(`is ${Math.round((past / total) * 100)}% description of his past work — a motivation answer is about desire and direction first, and his experience belongs only where it explains why the interest is real`);
    }
  }
  for (const [re, said] of BURIED_OPENINGS) {
    if (re.test(answer)) { problems.push(`opens ${said} — the reader has to know what he built before a word about why it was hard`); break; }
  }

  const low = answer.toLowerCase().replace(/[’‘]/g, "'");
  for (const b of BANNED) {
    const re = new RegExp(`(?:^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`, 'i');
    if (re.test(low)) problems.push(`uses "${b}", which voice-dna bans`);
  }
  // A GAP MAY BE NAMED ONCE, IF IT IS ANSWERED IN THE SAME BREATH (F-460).
  //
  // F-408 banned self-negation outright, and for a letter that is right. Alex
  // then wrote the answer he says would get him the job, 2026-09-13, and it
  // contains one: *"I do not yet have direct high-volume molding experience,
  // but I have repeatedly been placed in unfamiliar manufacturing systems,
  // learned them quickly, and improved both the equipment and the process
  // around it."*
  //
  // That is not an apology, it is a pivot — it takes the one thing the reader
  // was going to hold against him and spends the rest of the sentence on the
  // evidence that answers it. The apology and the pivot are the same words up
  // to the comma; what separates them is whether the sentence turns.
  //
  // So: at most one, it must turn inside its own sentence, and it may not be
  // the last sentence in the box — a box that ends on a gap sells against him
  // however it started.
  const sentences = answer.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  // A LIST OF WORK, NOT AN ARGUMENT. Two or more sentences that open by adding
  // one more thing ("I also…", "Outside work, I…", "In addition…") is the shape
  // of resume bullets joined together — the answer is collecting evidence, not
  // using the smallest amount that proves a point.
  //
  // COUNTED WITHIN A PARAGRAPH, NOT ACROSS THE ANSWER (2026-09-19). A long
  // answer that makes a claim and then proves it in two domains — the design
  // work in one paragraph, the diagnosis work in the next — will open a
  // sentence in each with "I also", and that is parallel evidence under a
  // thesis, not accumulation. Counting across the whole box flagged the Tesla
  // answer he rates highest. Two add-ons inside ONE paragraph is still a list.
  const ADD_ON = /^(?:I also\b|Also,|In addition\b|Additionally\b|Outside (?:of )?(?:that|work|my internships?|class|school)\b|Beyond (?:that|work)\b|On top of that\b)/i;
  const addOns = answer.split(/\n\s*\n/).reduce((worst, para) => Math.max(worst,
    para.split(/(?<=[.!?])\s+/).filter((sent) => ADD_ON.test(sent.trim())).length), 0);
  if (addOns >= 2) problems.push(`reads as a list of work (${addOns} sentences in one paragraph that just add another project) — keep the evidence that proves the point and cut the rest`);
  const negated = sentences.filter((sent) => SELF_NEGATION.some(([re]) => re.test(sent)));
  const turns = (sent) => /,\s*(?:but|and)\b|;\s*(?:I|what)\b|\bbut I\b/i.test(sent)
    && /\bI (?:have|was|built|designed|ran|led|worked|learned|took|integrated|deployed|traced|measured|qualified|programmed)\b/i.test(sent);
  for (const sent of negated) {
    const said = (SELF_NEGATION.find(([re]) => re.test(sent)) || [])[1] || "what he has not done";
    if (negated.length > 1) { problems.push(`says ${said}, and does it more than once — one gap named is a pivot, two is an apology`); break; }
    if (!turns(sent)) { problems.push(`says ${said} without turning it — name a gap only if the same sentence answers it with work he HAS done`); break; }
    if (sent === sentences[sentences.length - 1]) { problems.push(`ends the box on ${said} — a gap is never the last thing the reader sees`); break; }
  }
  // AND NEVER THE SHAPES THAT READ AS MACHINE-WRITTEN. A prompt rule alone
  // does not hold this: the model wrote the aphorism closer while the prompt
  // already said to be plain, which is why it is checked rather than asked for.
  // Travel and relocation are the POSTING's subject when it asks for them
  // (Charge Robotics: "based in or can relocate to the SF Bay Area", "10-15%
  // travel"); only a line nobody asked for is refused.
  const postingAsksLogistics = /\b(?:travel|relocat\w*|based in)\b/i.test(String(jd || ''));
  for (const [re, said] of SLOP_SHAPES) {
    if (postingAsksLogistics && /travel, where he is based/.test(said)) continue;
    if (re.test(answer)) problems.push(`has ${said}`);
  }
  // THE FORM'S OWN LIMIT IS A CEILING, not a target with slack.
  if (limits?.words && count > limits.words) problems.push(`over the form's ${limits.words}-word limit (${count} words)`);
  if (limits?.chars && answer.length > limits.chars) problems.push(`over the form's ${limits.chars}-character limit (${answer.length} characters)`);
  // THE LAST SENTENCE, on its own. A longer answer has more than one piece of
  // work in it and wants to tie them together at the end; his rule is that it
  // does not.
  const last = (answer.match(/[^.!?\n]+[.!?]*\s*$/) || [''])[0].trim();
  for (const [re, said] of CLOSER_SHAPES) {
    if (re.test(last)) { problems.push(`ends on ${said} — the answer stops after the last fact`); break; }
  }
  // THE SAME CLOSER GLUED ONTO THE LAST SENTENCE (2026-09-17): banned as its
  // own sentence, the rewrite moved it behind a comma — "…release
  // documentation, the procurement and documentation work this role at Tesla
  // lists for owning equipment." The last clause may not be a pointer at the role.
  const tail = (last.split(/,\s+/).pop() || '').trim();
  if (tail !== last && /\b(?:this|the) (?:\w+ ){0,4}(?:role|position|posting|job|team)\b[^.!?]{0,80}\b(?:lists|names|describes|asks for|calls for|requires|wants|needs)\b/i.test(tail)) {
    problems.push('ends on a clause that points back at the role, glued onto the last sentence — the tie to the role belongs inside the evidence, not after it');
  }

  const allowedNums = new Set([...numbersIn(cvText), ...numbersIn(jd), ...numbersIn(String(job?.title || '')), ...numbersIn(question)]);
  for (const n of numbersIn(answer)) {
    if (allowedNums.has(n)) continue;
    if (/^(?:19|20)\d{2}$/.test(n)) continue;
    problems.push(`figure "${n}" is not in cv.md or the posting`);
  }

  const allowedEnts = new Set([
    ...entitiesIn(cvText), ...entitiesIn(jd), ...entitiesIn(String(job?.company || '')),
    ...entitiesIn(String(job?.title || '')), ...entitiesIn(question),
  ]);
  const jdFolded = fold(jd);
  const cvFolded = fold(cvText);
  const qFolded = fold(question);
  const companyWords = new Set(wordsOf(String(job?.company || '')));
  // A sentence's first word is capitalised because it is first, not because it
  // is a name; read it in lower case unless it carries an inner capital or a
  // digit (NX, UR10e, RoboDK).
  const midSentence = answer.replace(/(^|[.!?]\s+|\n\s*)([A-Z][a-z']*)(?=[\s.,;:!?]|$)/g, (m, pre, w) => pre + w.toLowerCase());
  for (const e of entitiesIn(midSentence)) {
    const f = fold(e);
    if (allowedEnts.has(e) || ANSWER_WORDS.has(f) || companyWords.has(f)) continue;
    if (f && (cvFolded.includes(f) || jdFolded.includes(f) || qFolded.includes(f))) continue;
    const bare = f.replace(/'s?$/, '').replace(/s$/, '');
    if (bare && (cvFolded.includes(bare) || jdFolded.includes(bare) || qFolded.includes(bare) || companyWords.has(bare))) continue;
    problems.push(`"${e}" is named in the answer but not in cv.md or the posting`);
  }

  // COULD THIS BE SENT TO ANOTHER COMPANY WITH THE NAME CHANGED?
  //
  // His question, 2026-09-14, and the one failure in that list a machine can
  // actually see: an answer that names NOTHING out of the posting is by
  // definition interchangeable. It says nothing about how good the fit
  // argument is — a box can pass this and still be three resume bullets in a
  // row — so it is a floor, not a grade. The rest of that check list is in the
  // prompt, where judgement lives.
  //
  // Deliberately narrow: it needs a real description to read (a title alone
  // proves nothing), and one hit anywhere clears it. A false failure here
  // costs one redraft; a false pass costs nothing that was not already lost.
  const jdWordList = wordsOf(jd);
  if (jdWordList.length >= 60) {
    const answerFolded = ` ${fold(answer)} `;
    const anchored = jdWordList.some((w) => {
      if (w.length < 5 || GENERIC_JD_WORDS.has(w) || companyWords.has(w)) return false;
      const stem = w.replace(/(?:ing|es|s)$/, '');
      return answerFolded.includes(w) || (stem.length >= 5 && answerFolded.includes(stem));
    });
    if (!anchored) {
      problems.push('names nothing from this posting — as written it could be sent to another company with the name changed');
    }
  }
  return { ok: problems.length === 0, problems, notices };
}

/**
 * HE READ IT AND SAID WHAT IS WRONG.
 *
 * Alex, 2026-09-16: "if it was an answer i didnt like, i should have way to
 * tell it what i dont like, it sends that to an agent and the agent adjusts
 * accordingly." The rejected text goes back in front of the writer with his
 * notes, so the rewrite revises THAT answer instead of rolling a fresh one.
 * Notes steer what is picked from cv.md and how it reads; they never add a fact.
 */
export function revisionBlock(previous = '', feedback = []) {
  const notes = (Array.isArray(feedback) ? feedback : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!notes.length) return '';
  const was = String(previous || '').trim();
  return `
HE READ AN EARLIER ANSWER TO THIS QUESTION AND DID NOT LIKE IT.
${was ? `--- the answer he rejected ---\n${was.slice(0, 3000)}\n--- end of the answer he rejected ---\n` : ''}What he said about it, oldest first, in his own words:
${notes.map((n) => `- "${n.replace(/"/g, "'").slice(0, 600)}"`).join('\n')}
Rewrite the answer so every note is dealt with; where two notes disagree, the
newest decides. Do not keep a sentence he objected to by rewording it. His notes
govern what you pick from cv.md and how it reads; they can never add a fact that
is not in cv.md. If a note asks for something cv.md cannot support, leave it out
and say so in the READING.
`;
}

/**
 * WHICH WRITER PRODUCED A SAVED ANSWER. Bump it whenever the prompt or the
 * checks change what a good answer is. The server throws away any saved answer
 * from another version instead of handing it back — 2026-09-17, a "Brief Cover
 * Letter" box kept getting the four-call pipeline's answer after that pipeline
 * was gone, because a saved answer was trusted forever.
 */
export const WRITER_VERSION = '2026-09-23-whole-cv';

/**
 * THE PROMPT. One call, everything in front of it, answer straight back.
 *
 * Alex, 2026-09-17, after the four-call pipeline (F-473) took 220 seconds on
 * one Tesla box: *"it should just be as simple as question is fed to sonnet,
 * sonnet has a bunch of context about the job as well as my preferences then
 * it answers … chatgpt knows me and tesla well so it just gives me a banger
 * answer in 30s."*
 *
 * So this is a brief, not a procedure: his CV, the posting, what Jarvis knows
 * about the company, his rules in a dozen lines, and the question. The model
 * already knows how to reason about a company and a reader; the old prompt's
 * three pages of steps and its READING section cost time and bought nothing a
 * good brief does not. The fact guard stays in code (`checkAnswer`), where it
 * costs nothing.
 */
export function buildAnswerPrompt({
  question, kind = 'other', brief = '', job = null, jd = '', cvText = '', narrative = {},
  target = { min: 90, max: 160 }, request = '', context = '',
  stem = '', seriesIndex = 0, seriesOf = 0, avoid = [],
  alsoWritten = [], previous = '', feedback = [], companyBrief = '',
  // THE BOX AS THE PAGE SHOWS IT (2026-09-17): placeholder, the form's own
  // limits, and whatever is already typed in it.
  field = null,
  // His role-by-role emphasis table (modes/_profile.md). Voice rules and the
  // style file are summarised in the lines below rather than pasted whole.
  framing = '', voiceRules = '', style = '', exemplar = '',
  // HIS OWN ANSWERS, ACCEPTED AND REJECTED (2026-09-22).
  //
  // Until now the only sample of his voice in this prompt was ONE cover letter
  // — `sourcesFor()` picks the shortest of the eleven, chosen for length, not
  // for fitting the question — and there were no negative examples at all. So
  // "write like this" could be showing a letter while the box on screen asked
  // what historical empire inspires him, and nothing said what a bad answer
  // looks like.
  //
  // The rejected half is the part that teaches. Every answer he threw away is
  // true, relevant and well-formed; they fail on judgment, which a model
  // cannot infer from good examples alone.
  corpus = '', observations = '',
}) {
  const company = job?.company || 'the company';
  const title = job?.title || 'the role';
  const asked = seriesIndex > 1 && stem ? String(stem) : String(question || '');
  const q = (s, n = 600) => String(s || '').trim().replace(/"/g, "'").slice(0, n);
  const who = [
    narrative.headline ? `Headline: ${narrative.headline}` : '',
    narrative.exit_story ? `In his words: ${String(narrative.exit_story).trim()}` : '',
    Array.isArray(narrative.superpowers) && narrative.superpowers.length ? `What he is best at: ${narrative.superpowers.join(' · ')}` : '',
  ].filter(Boolean).join('\n');
  const limits = fieldLimits(field, context);
  const instructions = cleanInstructions(context || field?.near || '', asked);
  const current = String(field?.value || '').trim();
  const isLetter = kind === 'cover-letter';
  return `Write Alex Rivera's answer to one question on his application to ${company} for "${title}". Write it as him, ready to paste into the box.

CURRENT FIELD
Question: ${q(asked)}
${instructions ? `Instructions: ${q(instructions, 800)}\n` : ''}${field?.placeholder ? `Placeholder: ${q(field.placeholder, 200)}\n` : ''}${limits.words ? `Word limit: ${limits.words}\n` : ''}${limits.chars ? `Character limit: ${limits.chars}\n` : ''}Length to write: ${target.min} to ${target.max} words${limits.words || limits.chars ? ' (the form limit is a hard ceiling)' : ''}
${current ? `Already in the box: "${q(current, 600)}"\n` : ''}${String(request || '').trim() && !feedback.length ? `User request: "${q(request)}"\n` : ''}${kind && kind !== 'other' && brief ? `What this box wants: ${brief}.\n` : ''}${seriesIndex > 1 ? `This is box ${seriesIndex}${seriesOf ? ` of ${seriesOf}` : ''} ("${q(question, 60)}"): a separate, complete answer to that question using DIFFERENT work from the earlier boxes.\n` : ''}${avoid.length ? `Earlier boxes already used:\n${avoid.map((t, i) => `${i + 1}. ${String(t).slice(0, 300)}`).join('\n')}\n` : ''}${alsoWritten.length ? `Already answered on this application (do not repeat the same story):\n${alsoWritten.slice(0, 4).map((a) => `- "${q(a.question, 80)}": ${String(a.text || '').slice(0, 250)}`).join('\n')}\n` : ''}${revisionBlock(previous, feedback)}
ABOUT ALEX. Mechanical engineering student at State University, graduating May 2027. His CV is the only source of facts about him: never add a tool, number, result, sequence of events or motive that is not in it.
${who ? `${who}\n` : ''}What he wants from a role: building and developing (new product introduction, process development, ramp, first builds), not sustaining or maintenance work.
--- cv.md ---
${String(cvText || '').slice(0, CV_BUDGET)}
--- end ---
${framing ? `\nWHAT HE EMPHASISES BY ROLE TYPE (his own notes; emphasis only, every fact still comes from cv.md):\n${String(framing).trim().slice(0, 3500)}\n` : ''}
THE JOB
Company: ${company}
Title: ${title}
${jd || '(no description available; answer to the title)'}
${companyBrief ? `\nWHAT JARVIS KNOWS ABOUT ${String(company).toUpperCase()}\n${companyBrief}\n` : ''}
APPLICATION STRATEGY

Application answers are persuasive arguments, not resume summaries.

Before drafting, infer:

* who is reading
* what they are evaluating
* what the role actually needs someone to do
* what they should believe about Alex afterward
* which 1-3 confirmed experiences best prove it

Use experience as evidence for an argument. Do not concatenate relevant resume bullets.

START BY DECIDING WHAT THE QUESTION IS EVALUATING. Questions that look similar are often evaluating different things, and that decision sets how much of the answer is his past work. A question about what draws him somewhere is evaluating whether he knows what he wants and has grounds for wanting it; his experience explains where the interest came from and must not take the answer over. A question about his experience in a field is evaluating the experience, so the experience dominates and the job is choosing the strongest of it. A question about a project is evaluating how he thinks and works. A question about what he would bring is evaluating judgement about their problem. Answer what is being evaluated, not the question you are used to.

EVERY DETAIL MUST EARN ITS PLACE. A fact belongs in the answer because of what it proves, not because it is true and related. Before keeping a detail, say what the reader now believes that they did not believe without it; if there is no answer, cut it, however impressive it sounds. Listing what a piece of work contained is not the same as showing what it demonstrates. A long box is not permission to include more - it is more room to explain the few things that matter.

A TECHNICAL DETAIL EARNS ITS PLACE BY THE CONSTRAINT THAT FORCED IT. An engineer reading "dovetail interfaces, ball plungers, self-locking camera positioning, tolerance analysis" learns only that the thing had features. The same facts, each carrying what it was up against - the printer could not make it in one piece, so it was split and joined; adhesives were out because it runs in a cleanroom; the indexing had to repeat to the same position three times - become engineering rather than an inventory. So when a detail goes in, say what it solved. Where nothing in his files gives the reason, leave the detail out rather than inventing one: an unexplained feature and a made-up motive are both worse than the sentence that fits.

WHEN THE QUESTION ASKS WHAT WAS HARD, THE OBSTACLE IS THE ANSWER. "The hardest problem you hit", "a challenge you faced", "what went wrong" are asking what the work pushed back with and how he reasoned through it - not for a tour of what he built. Name the actual obstacle plainly, say what made it hard, and show the reasoning that got past it. A sophisticated component is not a hard problem; being unable to build it the obvious way is. And the hard problem is usually the SYSTEM problem - things that could not be optimised separately - rather than the most advanced piece of technology in the story.

WHAT YOU LEAVE OUT IS PART OF THE ANSWER. His strongest material is often not the most detailed material. Two pieces of evidence that prove the same thing are one piece of evidence and one distraction; a third example of the same quality is worth less than one sentence explaining what the first two have in common.

THE READER MUST UNDERSTAND THE PROBLEM BEFORE THE IMPLEMENTATION. Technical detail is not automatically persuasive. Someone who does not know the system cannot tell whether a mechanism was clever, so establish in plain language what needed to happen and why it was hard, then name what he built. Jargon ahead of its context makes work harder to appreciate, not more impressive.

SOMETIMES THE ARGUMENT IS THE PATTERN, NOT THE PROJECTS. When several experiences share a quality the reader cares about - entering unfamiliar systems and becoming useful in them, staying close to the hardware, turning a diagnosis into a measured improvement - that pattern can be the point, and the projects become evidence for it. A list of tools is usually the weakest form of this. Ask what the tools are evidence OF.

Explain technical work so an intelligent engineer unfamiliar with the exact project can follow it.

The same question at different companies should often produce different framing.

Optimize for whether this specific reader would want to interview Alex, not primarily for keyword overlap.

Never invent technical details. Relevance may be inferred; facts may not. An elaboration that sounds plausible for a piece of hardware he built - how a part was positioned, what it was mounted on, what it was made of - is an invented fact unless cv.md says it.

BEFORE WRITING - DO THIS INTERNALLY

Complete this sentence:

"The reader should finish this answer believing that Alex __________."

Choose the blank based on the exact question, active job, company/team, what the role actually requires, and Alex's strongest relevant evidence.

Then select the smallest number of confirmed experiences necessary to prove that claim.

Do not put this reasoning in the answer. Write it only in the PLAN below, which is stripped before anyone sees the answer.

HOW TO BUILD IT

Write a claim, then put the facts UNDER the claim. Not facts in a row hoping the reader adds them up.

* THE FIRST SENTENCE IS A CLAIM ABOUT WHAT KIND OF ENGINEER HE IS, not the first fact in the story. "My strongest evidence is that I have repeatedly taken unfamiliar manufacturing problems and turned them into working hardware or measurable process improvements" tells the reader what to look for in everything that follows. "At Applied Materials I designed a fixture" makes them work it out alone. A characterization is allowed and wanted: the "What the work adds up to" section of cv.md holds the approved ones, each naming the bullets it rests on, and one of them is his own sentence. Open on one of those and then prove it. Never use one INSTEAD of evidence.

* COMPRESSION IS PRIORITISATION. One sentence per fact makes every fact equally important, which means none of them is. Subordinate the supporting detail into the sentence that carries the claim: "carried it from CAD and tolerance analysis through prototyping, engineering drawings, BOM creation, supplier ordering, and Teamcenter release" puts six facts inside one clause, under the point they serve. Spend the sentences on what matters and compress the rest into clauses.

* PARAGRAPHS ARE STRUCTURE. In a long box, give each paragraph one job — the claim and its strongest proof, then a different kind of proof, then what they have in common. A wall of sentences reads as a list however good the sentences are.

* A LONG ANSWER MAY END BY SAYING WHAT THE EVIDENCE HAS IN COMMON, and what that means for this team. "Across these roles, I have learned unfamiliar equipment quickly, stayed close to the physical system, and moved from design or diagnosis to improvements that worked in production" is an argument, and so is naming the work he would do here. What is still banned is the EMPTY close: a generalisation into an "approach" or a "mindset", "overall" and "in short", a line about what he learned, anything that could follow any answer. Say something, or stop.

OPENING

Choose the opening based on the persuasive argument, not just question type.

* If motivation is part of the question, establish why the company/role genuinely interests Alex.
* For evidence/excellence/fit questions, open with the strongest claim or evidence depending on what reads naturally.

MOTIVATION QUESTIONS ARE NOT FIT QUESTIONS

Motivation questions are about desire and direction first, evidence second. Fit questions are about evidence first. Do not confuse the two.

A motivation question ("what motivates you to explore opportunities at X", "why are you interested in us") is asking what Alex wants and where he is going. Before writing one, answer this internally: why would Alex genuinely want to work here, given his background and career direction? Then say that in plain language.

* Never write: the company does X, Alex did Y, therefore he wants X. That is the pattern to avoid, and it is what these answers keep collapsing into.
* His experience belongs in the answer only where it explains why the interest is real. If more than about a third of the answer is describing his past work, it is a fit answer wearing a motivation label - rewrite it.
* Do not restate what the company does back to them. Company context supports the answer; it is not the answer, and it must not read as if it came off their careers page.
* Do not reach for keyword overlap, and do not force an achievement in. Phrases like "where process engineers deliver", "expanding capacity with speed and quality" or "data-driven analytics and systematic problem solving" are careers-page language, not his.
* What this sounds like when it works: his Applied Materials time showed him he likes semiconductor manufacturing because the work sits where equipment, automation, process control, troubleshooting and high-precision production meet, and this company would let him go deeper into that at far greater scale. Direction, then the experience that makes the direction credible.
* The reader should finish thinking "he actually knows why he wants to be here", not "he found some JD keywords and attached an internship bullet".
* For project questions, establish the problem in plain language before technical details.
* Do not mechanically begin with "At Applied Materials..." because the question is experience-related.
${isLetter ? '* This box is a cover letter: his letter register, no salutation and no sign-off, and no figures (his own letters carry none).\n' : ''}
HOW IT READS
- If the question or its instructions ask for several things, answer every one of them, in the order a reader would look for them.
- Tie the work to this role inside the sentences that carry the evidence. Never a sentence whose only job is to assert that his work "is the same" as theirs or "matches" the role - that asserts the conclusion instead of earning it. A short box stops after the last fact. A long one may close on what the evidence has in common and what he would do with it here, as HOW TO BUILD IT describes.
- Match the company: Tesla or SpaceX style roles want concise, technical, ownership-heavy writing; startups want range and building things himself; semiconductor companies want structured problem solving, qualification and reliability; design roles want tolerances, analysis and validation.
- His voice: plain, even, first person, full sentences. No contractions, em dashes, exclamation marks, markdown or adjectives about himself. Compound modifiers stay open ("hands on", "root cause", "fast paced"). He may sound keen in his own words ("I am eager to", "I am excited about").
- Never: a sentence that negates one framing and asserts another ("not X but Y", "rather than"), a list of three for rhythm, an "-ing" phrase that claims significance ("highlighting its importance"), inflated significance ("a pivotal step"), "serves as" or "stands as" where "is" works, aphorisms or morals.
- Name a gap only if the posting makes it central, and only in the same sentence as the work that answers it. Never end on a gap.
${exemplar ? `- Write the way he writes. One of his own cover letters, for his voice only (its facts are not new material):\n--- his letter ---\n${String(exemplar).slice(0, 4500)}\n--- end ---\n` : ''}${observations ? `- WHAT HE THROWS ANSWERS AWAY FOR. He wrote these himself after reading a batch of answers he rejected. They are about judgment, not grammar, and every answer he rejected was true and relevant:\n--- his notes ---\n${String(observations).slice(0, 3500)}\n--- end ---\n` : ''}${corpus ? `- HIS OWN ANSWERS. Where a rejected version is shown, it contains the same facts as the one he kept and he threw it away anyway. Study what is missing from the kept one, not only what is in it. Copy no sentence from these; they are a different question.\n${String(corpus).slice(0, 7000)}\n` : ''}- Before you answer, check it: could it go to fifty other applicants, or to another company with the name changed? Is it bullets restated? Would the reader know what Alex personally did and why it matters here? Is any detail missing from his CV? Is it inside the length? Fix anything that fails.

REPLY IN EXACTLY TWO PARTS:

PLAN
asking: what this question is evaluating, and therefore roughly how much of the
  answer should be his past work rather than what he wants, how he thinks, or
  what he would do here
reader: who reads this and what they are evaluating
believe: The reader should finish this answer believing that Alex ...
parts: every separate thing the question and its instructions ask for, and for a
  box with more than one job, how much room each gets
evidence: the cv.md lines this answer rests on, each copied exactly from cv.md (1 to 3 lines)
why these: why this evidence beats his other work for THIS reader and role
omit: name at least one strong, relevant thing you are leaving out, and why it
  does not earn its place here - it proves what something else already proves,
  or the reader cannot use it, or explaining it would cost more than it returns.
  Write NONE only if the box is too short to have held anything else.
opening: what the first sentence does for this reader
unsupported: quote any phrase in your answer that states a cause, comparison,
  number or detail you cannot point to in cv.md above — the reason something
  was done, what would have happened otherwise, how a part behaved. Write NONE
  only if every such phrase is his. Anything you quote here will be sent back.
===ANSWER===
the text for the box, and nothing else. Every fact in it traces to an evidence line above or to the posting.`;
}

/**
 * Write one answer: ask, check, ask once more with the problems named, return
 * what there is — with its problems, never silently.
 *
 * Never throws. A question the model could not answer stays on his list with a
 * reason, which is exactly where it was before this file existed.
 */
export async function writeAnswer(question, {
  job = null, jd = null, field = null, kind = null, request = '', context = '',
  // A box that is the Nth of a group: the stem carries the question, and
  // `avoid` carries what the earlier boxes already used.
  stem = '', seriesIndex = 0, seriesOf = 0, avoid = [],
  // The rest of this form, already answered. The reader sees every box at
  // once, so the writer has to as well.
  alsoWritten = [],
  previous = '', feedback = [],
  // What Jarvis knows about the employer (company-context.mjs), and the
  // reviewer: undefined picks the default, null switches it off.
  companyBrief = '', review = undefined,
  // ONE CALL BY DEFAULT (2026-09-17, his call: "a banger answer in 30s").
  // The code checks cost nothing; a draft that fails one gets ONE redo with the
  // problems named (measured live: 16s clean, ~35s with the redo). The
  // separate reviewer (answer-review.mjs) is off unless JARVIS_ANSWER_REVIEW=on.
  ask = askText, retries = 1, sources = null, timeoutMs = 150_000, bin = 'claude',
  // A corpus entry the prompt must NOT show: the measurement asks the writer
  // his own corpus questions, and showing it the answer he kept is an
  // open-book test (2026-09-23).
  holdOut = null,
} = {}) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, text: '', problems: ['no question given'], notices: [], why: 'no question given', kind: null };
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    return { ok: false, text: '', problems: [], notices: [], why: 'writing switched off (JARVIS_TAILOR=off)', kind: null };
  }
  // A series box is classified on its STEM — "Second example:" says nothing
  // about what kind of question it is; the instruction above it does.
  const forKind = seriesIndex > 1 && stem ? String(stem) : q;
  const found = kind ? { kind, brief: (KINDS.find(([k]) => k === kind) || [])[2] || '' } : (answerKind(forKind) || { kind: 'other', brief: 'a direct answer to exactly what was asked' });
  // THE BOX'S OWN WORDS COUNT TOWARDS ITS LIMITS. The help text used to travel
  // as `context` and never reach `targetWords`, so "no more than 200 words"
  // lost to the 150-250 default for its kind.
  const box = { ...(field || {}), label: field?.label || q, near: [field?.near, context].filter(Boolean).join(' ').slice(0, 1600) };
  const target = targetWords(box, found.kind);
  const limits = fieldLimits(box);
  const src = sources || sourcesFor();
  // The whole posting where it fits: an answer is written towards the company,
  // the team and the requirements, which long postings keep at both ends.
  const condensed = jd ? condenseJd(jd, 12000) : '';
  const prompt = buildAnswerPrompt({
    question: q, kind: found.kind, brief: found.brief, job, jd: condensed,
    cvText: src.cvText, narrative: src.narrative, voiceRules: src.voiceRules,
    framing: src.framing, target, request, context: context || field?.near || '', field: box,
    stem, seriesIndex, seriesOf, avoid, alsoWritten, previous, feedback, companyBrief,
    // HIS OWN LETTERS ARE THE SPECIFICATION (F-408, and F-445 for missing it
    // here). `sourcesFor()` has loaded these all along — the cover-letter
    // writer feeds them in and this one did not, so every answer was written
    // in the model's voice with none of his writing in front of it.
    style: src.style || '', exemplar: src.exemplar || '',
    // AND HIS OWN ANSWERS, chosen for the KIND of question on screen — a
    // motivation question gets a motivation exemplar, with the version he
    // rejected beside it. Falls back to nothing at all if the corpus file is
    // absent, so a missing file never breaks a build.
    corpus: corpusBlock(found.kind, { exclude: holdOut }), observations: loadObservations(),
  });
  // WHAT THE WRITER RECEIVED, kept for him to read when an answer is bad.
  // Overwritten every time; it holds his CV and the posting, nothing secret.
  if (ask === askText) savePromptForDebug(prompt, { question: q, job, kind: found.kind, target, limits });

  let text = '';
  let reading = '';
  let check = null;
  let why = '';
  let verdict = null;
  let sentBack = null;
  // Opus for anything that has to build an argument; Sonnet only if Opus cannot
  // complete; never Haiku. `meta` comes back filled in with what actually ran,
  // so a weak answer can be told from a weak model.
  const judgment = needsJudgment(found.kind, { target, question: q });
  const models = judgment ? JUDGMENT_MODELS : null;
  const meta = {};
  const askOpts = { timeoutMs, bin, models, meta };
  try {
    let plan = '';
    ({ reading, plan, text } = splitReading(await ask(prompt, askOpts)));
    check = checkAnswer(text, { cvText: src.cvText, jd: condensed, job, target, question: q, limits, kind: found.kind });
    check.problems.push(...planProblems(plan, src.cvText)); check.ok = check.problems.length === 0;
    for (let i = 0; i < retries && !check.ok; i += 1) {
      const again = `${prompt}\n\nYOUR LAST ANSWER FAILED THESE CHECKS — fix each one and answer again in the same two parts, whole:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\n--- your last answer ---\n${text}`;
      const s2 = splitReading(await ask(again, askOpts));
      const c2 = checkAnswer(s2.text, { cvText: src.cvText, jd: condensed, job, target, question: q, limits, kind: found.kind });
      c2.problems.push(...planProblems(s2.plan, src.cvText)); c2.ok = c2.problems.length === 0;
      if (c2.problems.length <= check.problems.length) { text = s2.text; reading = s2.reading || reading; check = c2; }
    }
    // THE READER'S REVIEW (answer-review.mjs). His seven questions, asked by
    // a call that did not write the answer. Fails 1-6: rewritten. Fails 7:
    // the unsupported claim is removed. Only the real CLI gets a reviewer by
    // default; a stubbed `ask` in a test gets none unless it passes one.
    const reviewer = review !== undefined ? review
      : ask === askText && /^(on|1|true|yes)$/i.test(String(process.env.JARVIS_ANSWER_REVIEW || ''))
        ? (input) => reviewAnswer(input, { ask, timeoutMs, bin }) : null;
    if (reviewer && text) {
      const input = { question: forKind, job, jd: condensed, cvText: src.cvText, companyBrief };
      verdict = await reviewer({ ...input, answer: text });
      if (verdict && !verdict.passes) {
        sentBack = verdict;
        const redo = `${prompt}\n\n${reviewFeedback(verdict)}\n\n--- the answer that was sent back ---\n${text}\n\nAnswer again in the same two parts, whole.`;
        const s3 = splitReading(await ask(redo, askOpts));
        const c3 = checkAnswer(s3.text, { cvText: src.cvText, jd: condensed, job, target, question: q, limits, kind: found.kind });
        if (s3.text && c3.problems.length <= check.problems.length) {
          text = s3.text; reading = s3.reading || reading; check = c3;
          check.notices = [...(check.notices || []), `rewritten after a reader's review (failed ${[...verdict.failed.map((c) => c.n), ...(verdict.unsupported.length ? [7] : [])].join(', ')})`];
        } else {
          check.problems = [...check.problems, ...verdict.failed.map((c) => `a reader's review: ${c.why || `failed question ${c.n}`}`)];
        }
      }
    }
    // A claim the reader called unsupported must be gone, not reworded around.
    const folded = fold(text);
    for (const u of sentBack?.unsupported || []) {
      if (fold(u) && folded.includes(fold(u))) check.problems = [...check.problems, `"${u}" — a reader found no support for it in cv.md`];
    }
    check.ok = check.problems.length === 0;
    why = check.ok
      ? `written; passed the checks${verdict ? ' and a reader\'s review' : ''} (${wordsOf(text).length} words)`
      : `written; ${check.problems.length} problem(s) — read it before you submit`;
  } catch (e) {
    return { ok: false, text: '', problems: [], notices: [], why: describeFailure(e, bin, 'answer', timeoutMs), kind: found.kind };
  }
  return {
    ok: check.ok, text, reading, problems: check.problems, notices: check.notices, why, kind: found.kind, target, writer: WRITER_VERSION,
    review: sentBack ? { failed: sentBack.failed.map((c) => c.n), unsupported: sentBack.unsupported, fix: sentBack.fix } : null,
    // WHICH MODEL WROTE THIS. He asked to be able to compare output quality and
    // know when a weaker model produced an answer, rather than inferring it
    // from the prose.
    model: {
      judgment, requested: meta.requested || (models ? models[0] : '') || '',
      used: meta.model || '', fellBack: Boolean(meta.fellBack), fallbacks: meta.fallbacks || [],
    },
  };
}
