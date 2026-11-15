// jarvis/eligibility.mjs — can he actually apply to this, at all.
//
// Written because the first shortlist this system ever produced put
// **"Mechanical Engineer New College Grad - Masters Degree"** at number one,
// next to an MBA internship and an entry-level data scientist role. His words:
// "still a bunch of master roles or want degree thats not mine... just basic
// screening stuff like that its failing."
//
// He is right, and the reason is worth naming: the fit engine scores RELEVANCE —
// how much a posting looks like his world — and relevance is not eligibility.
// "Mechanical Engineer, semiconductor, new college grad" is a perfect relevance
// match and a role he cannot hold, because it wants a degree he will not have.
// Nothing in the store asked the eligibility question, so nothing caught it.
//
// Two facts settle almost all of it, and both are stated in the posting:
//   DEGREE LEVEL      he will hold a Bachelor of Science in May 2027.
//   DEGREE SUBJECT    it is in Mechanical Engineering.
//
// Everything here reads the posting. Nothing infers anything about him beyond
// those two facts, which come from cv.md.
//
// Both facts are the user's now (targeting.mjs): the level is
// person.degreeLevel, and the subject's field and title patterns live in the
// preset, moved there so a second user can run Jarvis.

import { person, screen } from './targeting.mjs';
import { underPreferredHeading } from './requirements.mjs';

/** Degree lines are bullets far more often than sentences, so split on both.
 *
 * The sentence split must not fire inside an abbreviation. "B.S. Degree in
 * Engineering Discipline" was cut into "B.S." and "Degree in Engineering…", so
 * the bachelor token and the word "degree" landed on different lines and
 * neither half satisfied the check that needs both — a real GE Vernova posting
 * read as Master's-only. A period is a sentence end only when the character
 * before it is not a capital letter. */
const lines = (text) => String(text || '')
  .replace(/\r/g, '')
  .split(/\n+|(?<=[^A-Z][.;])\s+(?=[A-Z*•\-])/)
  .map((l) => l.replace(/^[\s*•\-–—]+/, '').trim())
  .filter(Boolean);

// "MS" IS ALSO MISSISSIPPI, AND "MASTER" IS ALSO A JOB TITLE.
//
// `m\.?s\.?c?` matched the state in "Field Service Engineer - Jackson, MS" and
// called every Mississippi posting Master's-only — 22 live rows, all of them
// flagged and hidden before the description was ever read. `\bmaster\b`
// matched Master Scheduler, Master Planner, Master Production Control and
// Master Launch Welder: 359 live titles with no degree in them. An advanced
// degree is one that is followed by a degree word, or an unmistakable token.
const ADVANCED = /\b(master[’']?s?\s*(degree|of\s+(science|engineering|arts|business)|\/|or\s+ph|in\s+[a-z])|(?<![,\w]\s?)m\.?s\.?c?(?=\s*(degree|\/|or\b|in\s+[a-z]|,|\)|$))|ph\.?\s?d|doctora(l|te)|\bmba\b|graduate degree|advanced degree)/i;
// The same token in a TITLE, where "- Masters Degree" is the whole point and
// "Master Scheduler" must not count.
const ADVANCED_TITLE = /\b(master[’']?s?\s*(degree|of\s+science|\/)|\bmba\b|\bph\.?\s?d\b|doctora|bs\s*\/\s*ms|\bms\s*degree)/i;
// BSc and B.Sc are bachelor's degrees. ADVANCED could read "MSc"; this could
// not read "BSc", and the asymmetry inverted a Baker Hughes "BSc or MSc in
// Mechanical" into Master's-only.
//
// F-757: "Baccalaureate degree" and HP's "Four-year or Graduate Degree in …"
// are bachelor's routes too. "post-baccalaureate experience", the tail of a
// Master's-degree requirement, is not.
//
// F-771: "BSEE minimum (or equivalent experience), MSEE or PhD" (NVIDIA) named
// a bachelor's in the run-together spelling and was read as PhD-only.
const BACHELOR = /\b(bachelor[’']?s?|b\.?\s?sc?\.?|b\.?a\.?|b\.?eng|bs(?:ee|me|ce|cs|che|ie|ae|ece|mse)|undergraduate|(?<!post[- ]?)baccalaureate|(?:4|four)(?:\s*\(4\))?[- ]year\s+(?:(?:college|university|undergraduate|technical|academic|bachelor[’']?s?)\s+)?degree|(?:4|four)(?:\s*\(4\))?[- ]year\s+or\s+(?:graduate|advanced|higher)\s+degree)\b/i;
// "Bachelor's degree; Master's preferred" is not a bar. "Master's OR PhD" is.
//
// The first version matched any "or <advanced degree>", so "Pursuing a Master's
// or PhD degree in Chemical Engineering, Chemistry, Mechanical Engineering" read
// as an OPTIONAL master's and the posting came back eligible. It is two advanced
// options, not an alternative to a bachelor's — and the store's own older screen
// had it right, which is how the disagreement was noticed at all. A line that
// genuinely offers a bachelor's already says so, and is caught by BACHELOR
// before this is ever consulted, so this now only recognises PREFERENCE.
//
// "desired" is one letter from "desirable" and was missing; so were
// advantageous, ideally, beneficial, welcome and valued. Each turned a clearly
// optional degree into a demand.
//
// F-756: "Degree in Finance or related, MBA preferred" was called Master's-only
// because the list of advanced degrees a preference can name had no MBA.
const OPTIONAL_ADVANCED = /(master[’']?s?|ms\b|m\.s|mba\b|m\.b\.a|phd|advanced degree|graduate degree)[^.]{0,30}\b(preferred|a plus|desirable|desired|nice to have|bonus|optional|not required|advantageous|an advantage|ideally|beneficial|welcome|valued)|(preferred|desired|ideally)[^.]{0,24}\b(master|ms\b|mba\b|advanced)/i;

// ── F-771: WHAT A LINE THAT NAMES AN ADVANCED DEGREE CAN STILL MEAN ──────
//
// Run over the 21,000 rows of his deck, this screen refused 61 as Master's-only;
// 32 of them were not. Each of those had the advanced degree in a sentence
// that does not demand it:
//   · a preference too far from its degree for the 30-character window above —
//     TSMC "Master’s degree in Industrial Engineering or a related fields are
//     preferred", Matic "An advanced degree in … is a strong plus", Trimble
//     "Master’s or PhD in … (preferred)";
//   · a preference in brackets — Tesla "Degree in Mechanical Engineering or a
//     related field (advanced degree or relevant certifications are a plus)";
//   · an experience route beside it — Panthalassa "Master’s degree in
//     mechanical engineering or related field, or additional industry
//     experience", 1X "5+ years of relevant industry experience, or an
//     advanced degree …";
//   · a substitution — NYCHA "A masters degree … may be substituted for one
//     year of the … experience";
//   · a degree route ahead of it — TE "Engineering or master’s degree in
//     industrial engineering";
//   · a "Nice-to-have" heading above it (Atomic Semi).
// A bare demand still refuses: "Master's degree in Mechanical Engineering.",
// "Minimum Education Required: Master’s degree", "Master’s degree (Ph.D.
// preferred) in Material Science …" — a bracket that prefers a PhD says
// nothing about the Master's outside it.

// "Ph.D." and "M.S." carry periods that are not sentence ends.
const unDot = (s) => String(s || '')
  .replace(/\bph\.\s?d\b\.?/gi, 'PhD')
  .replace(/\bm\.b\.a\b\.?/gi, 'MBA')
  .replace(/\b([bm])\.\s?(sc|s|a|eng)\b\.?/gi, '$1$2');
// A preference stated in the clause itself (degree.mjs reads the same words).
// ("plus" alone is arithmetic: "…or a foreign equivalent plus 2 years".)
const INLINE_PREF = /\b(?:preferred|an?\s+(?:(?:strong|big|huge|definite|major)\s+)?plus|(?:strong|big|huge|definite)\s+plus|nice[- ]to[- ]have|bonus|desired|desirable|advantageous|an advantage|an asset|beneficial|optional|not required|not necessary)\b/i;
const INLINE_REQ = /\b(?:required|requirement|requires?|minimum|must)\b/i;
// "BS degree in Electrical Engineering preferred with a minimum of 2 years of
// experience" (TechnipFMC): that minimum is the years', not the degree's.
const saysRequired = (c) => INLINE_REQ.test(String(c)
  .replace(/\bnot\s+required\b/gi, '')
  .replace(/\b(?:a\s+)?minimum\s+(?:of\s+)?(?:\d+|one|two|three|four|five)\b/gi, ''));
const isPrefClause = (c) => INLINE_PREF.test(c) && !saysRequired(c);
// A sentence ends at a period after a word, not after "P.E." or "U.S.".
const sentences = (s) => String(s).split(/(?<=\b\w{2,}\.)\s+/);
// A bracket that states a preference is about what is inside it alone.
const dropPrefBrackets = (s, re) => String(s).replace(/\(([^()]*)\)/g, (m, inner) => (re.test(inner) && INLINE_PREF.test(inner) ? ' ' : m));
// "…, or additional industry experience", "; or equivalent experience".
const EXPERIENCE_ALT = /\bor\s+(?:an?\s+)?(?:equivalent|additional|comparable)\s+(?:[\w-]+\s+){0,2}experience\b/i;
// "…will be accepted as equivalent to one year of experience", "may be
// substituted for", "in lieu of".
const SUBSTITUTE = /\b(?:accepted as (?:an? )?equivalent|(?:may|can|will)\s+(?:also\s+)?be\s+substituted|substitut\w*\s+for|in lieu of)\b/i;
// TE Connectivity: "Engineering or master’s degree in industrial engineering".
const DEGREE_OR_MASTER = /^\W*(?:an?\s+)?engineering(?:\s+degree)?\s+or\s+(?:an?\s+)?master/i;
// "5+ years of relevant industry experience, or an advanced degree …": the
// sentence opens on years, and the degree is the other route.
const YEARS_FIRST = /^\W*\d+\s*(?:\+|\s*[-–]\s*\d+\s*\+?)?\s*(?:years?|yrs?)\b/i;
const yearsThenOr = (s, re) => {
  if (!YEARS_FIRST.test(s)) return false;
  const at = s.search(re);
  return at > 0 && /\bor\b/i.test(s.slice(0, at));
};

// The line's own "required" beats the heading: AMD's "Bachelor’s or master's
// degree in Electrical Engineering required" sits under "ACADEMIC
// CREDENTIALS", a heading the section reader does not know, so it reads as
// part of the "PREFERRED EXPERIENCE" list above it.
const preferredSection = (text, line) => {
  if (saysRequired(line)) return false;
  const at = String(text || '').indexOf(line);
  return at >= 0 && underPreferredHeading(text, at);
};

/** Does a line that names an advanced degree stop short of demanding it? */
function advancedIsOptional(text, line) {
  if (preferredSection(text, line)) return true;
  // A bracket that prefers an advanced degree is about that degree alone.
  const bare = dropPrefBrackets(unDot(line), ADVANCED);
  for (const sentence of sentences(bare)) {
    if (!ADVANCED.test(sentence)) continue;
    if (EXPERIENCE_ALT.test(sentence) || SUBSTITUTE.test(sentence) || DEGREE_OR_MASTER.test(sentence) || yearsThenOr(sentence, ADVANCED)) continue;
    if (sentence.split(';').map(dropPrefDegree).some((c) => ADVANCED.test(c) && !isPrefClause(c))) return false;
  }
  return true;
}

// "Master's degree in optical engineering or a related field, Ph.D.
// preferred" (Lumilens): the preference is the PhD's. A short "<advanced
// degree> preferred" tacked onto a clause is about that degree alone, and the
// rest of the clause is read without it.
const PREF_DEGREE = /(?:^|[,(]|\band\b|\bor\b)\s*(?:an?\s+)?(?:PhD|doctorate|master[’']?s?|MS|MBA|advanced degree|graduate degree)(?:\s+degree)?\s+(?:is\s+|are\s+)?(?:highly\s+|strongly\s+)?(?:preferred|desired|desirable|an?\s+(?:strong\s+)?plus|an advantage)\b/gi;
const dropPrefDegree = (c) => String(c).replace(PREF_DEGREE, ' ');

/**
 * Does this posting bar someone whose highest degree is a bachelor's?
 *
 * Returns 'advanced-only' only when a line demands an advanced degree AND does
 * not offer a bachelor's alternative anywhere. Deliberately conservative: an
 * unclear posting comes back 'unknown' and stays in the list, because the rule
 * in this project is that triage flags rather than hides, and "the description
 * did not say" is not evidence that he is ineligible.
 */
export function degreeBar(text, title = '') {
  return degreeRead(text, title).bar;
}

/** degreeBar, plus the line that decided it (the evidence a refusal quotes). */
function degreeRead(text, title = '') {
  // The title is the most reliable place this appears and the cheapest to read:
  // "…New College Grad - Masters Degree" is unambiguous. "Master Scheduler" is
  // not a degree, and neither is the state of Mississippi.
  // A title that also names a bachelor's route in ANY spelling keeps him: F-758,
  // Western Digital's "Summer 2027 Intern - Financial Analyst - Undergraduate &
  // MBA" was read as advanced-only because only
  // "bachelor" and "BS" were looked for.
  if (ADVANCED_TITLE.test(String(title)) && !BACHELOR.test(String(title))) return { bar: 'advanced-only', line: String(title) };

  const ls = lines(text);
  // A BACHELOR'S MENTIONED ANYWHERE IN THE QUALIFICATIONS SETTLES IT.
  //
  // "BS or higher in Engineering. Advanced MS degree preferred." was read as
  // Master's-only and would have hidden the job: the bachelor's sentence and the
  // master's sentence are separate lines, and only the second was being weighed.
  // A posting that names a bachelor's as sufficient has answered the question
  // whatever else it goes on to prefer.
  //
  // "BS / MS in Mechanical, Manufacturing, or Industrial engineering" names no
  // context word at all — not "degree", not "required" — and was not counted. A
  // bachelor token beside a discipline is a bachelor's requirement.
  const bachelorOk = ls.some((l) => BACHELOR.test(l)
    && /\b(degree|or higher|minimum|require|must|qualif|pursu|enrolled|equivalent|education|engineering|science|physics|chemistry|in\s+[a-z]+\s*(engineering|science))\b/i.test(l));

  let demanded = '';
  for (const l of ls) {
    if (!ADVANCED.test(l)) continue;
    if (!/\b(require|must|minimum|qualif|pursu|enrolled|working toward|candidate|seeking|degree|education)\b/i.test(l)) continue;
    if (OPTIONAL_ADVANCED.test(l) || BACHELOR.test(l)) return { bar: 'bachelors-ok', line: '' };
    if (advancedIsOptional(text, l)) continue;
    demanded ||= l;
  }
  // BOTH, AND THAT IS AN ANSWER OF ITS OWN. Real postings say "Master's degree
  // in X" in the qualifications and carry a bare "Bachelor's degree" line from
  // a structured field elsewhere. Calling that eligible hides a Master's-only
  // role in his inbox; calling it ineligible hides a job he could get. It is a
  // question, so it goes to him as one.
  if (demanded) return { bar: bachelorOk ? 'mixed' : 'advanced-only', line: demanded };
  return { bar: bachelorOk || BACHELOR.test(String(text)) ? 'bachelors-ok' : 'unknown', line: '' };
}

// His degree, and the neighbours a mechanical engineer is genuinely hired into.
// Manufacturing, industrial, mechatronics, aerospace and materials postings
// routinely name ME in the same breath, and a fab's "Equipment Engineer" is
// mechanical work whatever the header says.
// HIS DEGREE, AND WHAT GENUINELY INCLUDES IT — NOT WHAT SITS NEAR IT.
//
// This list used to carry materials science, aerospace, automotive, robotics,
// automation and "process engineer". None of those is a mechanical engineering
// degree, and each one let a posting through that names other disciplines and
// not his. GlobalFoundries' Advanced Manufacturing Process Engineer asks for
// "Chemical Engineering, Electrical Engineering, Materials Science, Solid State
// Physics or related field" and reached his curated inbox because the words
// "Materials Science" were on the allow-list. His verdict on the result: "why
// are there so many non mech roles, they are looking for comp eng and electrci".
//
// What remains is his degree, the three fields that are interchangeable with it
// on a job posting, and the phrasings that mean engineering GENERALLY — which
// does include him.
// "…or a related technical discipline" is deliberately NOT here. Related to
// WHAT is the whole question, and it is answered further down by sending the
// posting to him as maybe-related rather than deciding it either way.
const HIS_FIELD = screen.hisField;
// Fields that are somebody else's degree. Only used to detect a list that
// EXCLUDES him — never on its own.
const OTHER_FIELD = screen.otherField;

// "Engineering" with no discipline in front of it is HIS — a posting open to
// engineering generally is open to a mechanical engineer. With a discipline in
// front of it, it is that discipline's.
//
// This replaced a strip-then-look approach that was wrong in both directions on
// consecutive attempts, which is the useful part of the story. Removing the
// matched discipline left the NOUN behind — "Electrical Engineering, Computer
// Engineering, Computer Science" became " Engineering, Engineering, Science" —
// so every electrical role read as generically-engineering and the screen
// passed all of them. Asking the question directly, of each occurrence, is both
// simpler and the only version that survived being measured.
// (The preset's `genericField`: for the finance preset, "a quantitative or
// business field".)
const GENERIC_ENG = screen.genericField;

/**
 * Does the posting name a degree subject, and is his one of them?
 *
 * The order of operations is the whole trick. A line reading
 *
 *     "Majoring in Engineering or Computer Science/Computer Engineering"
 *
 * excluded him on the first version, because "Computer Engineering" matched a
 * foreign field and bare "Engineering" — which IS his major, generically stated
 * — was never seen. That posting was a robotics and automation internship: the
 * single most on-target role in the entire shortlist, thrown away by the screen
 * meant to protect him. A false exclusion is the expensive error here, exactly
 * as it is for liveness: it makes him miss a real job and he never finds out.
 *
 * So the other disciplines are REMOVED from the line first, and only then is
 * what remains asked whether it names engineering generally or his field
 * specifically.
 */
export function subjectFit(text, title = '') {
  return subjectRead(text, title).fit;
}

// "Bachelor's IN Chemical, Mechanical, Electrical Engineering" names the
// subjects without ever using the word "degree", and this gate skipped it —
// so the most common phrasing on a new-grad req was never inspected at all.
//
// F-771: a bare "major" was a degree word, so Nova Biomedical's "marking a
// major milestone in our journey" — about the company, not a degree — was
// read as a subject list that names biomedical and not mechanical. "Major"
// counts when it is a field of study ("majoring in", "major in", "Major:",
// "engineering major"). "BSEE", "B.S.M.E." and the like are degree words too.
const SUBJECT_GATE = /\bdegree\b|\bmajoring\b|\bmajors?\s+(?:in|of)\b|\bmajor\s*:|\b(?:engineering|science|technical|related|stem)\s+majors?\b|\bpursuing\b|\benrolled\b|\bstudying\b|\bbachelor|\bb\.?s\.?\b|\bbs(?:ee|me|ece)\b|\bm\.?s\.?(?:ee|me)\b|\bgraduating\b/i;

// "…or a related technical discipline" is a door left open. Given the cost of
// a false exclusion it is a question for him, not a refusal.
//
// F-771: the door has more than one spelling. General Robotics' "Bachelor's
// degree in Robotics, Computer Science, Computer Engineering, Electrical
// Engineering, relevant technical field, or equivalent practical experience",
// Wolfspeed's "BS in Electrical Engineering, Chemical Engineering, Materials
// Science, or Equivalent", Mitsubishi Chemical's "…or another technical
// discipline", Garmin's "…or another related degree" and Avery Dennison's
// "…or a comparable field" each leave it open, and each was refused. "Or
// relevant military training" (Executive Alliance) and "or foreign
// equivalent" do not: the first is no field of study, the second is the same
// degree from another country.
const OPEN_DOOR = new RegExp([
  String.raw`\bor\s+(?:an?\s+)?(?:related|similar|other)\b`,
  String.raw`\brelated\s+(?:field|discipline|technical|major|area|degree|subject|program)`,
  String.raw`\b(?:relevant|comparable|similar|equivalent|another|other)\s+(?:(?:related|technical|engineering|scientific|stem|quantitative|physical)\s+){0,2}(?:fields?|disciplines?|majors?|areas?|degrees?|subjects?|programs?|backgrounds?)\b`,
  String.raw`\bor\s+(?:an?\s+)?equivalent\b`,
  String.raw`\bequivalent\s+(?:(?:practical|industry|work|professional|hands-on|technical)\s+)?experience\b`,
  // Arista "BS/CS/CE Business or Technical degree required"; Luma "…by
  // degree or practical record".
  String.raw`\bor\s+(?:an?\s+|any\s+|other\s+)?technical\s+(?:degrees?|fields?|disciplines?)\b`,
  String.raw`\bor\s+practical\b`,
].join('|'), 'i');

// Lines that name a degree and ask for nothing: SageOx "No CS degree
// required."; a founder's biography ("Baiju earned his B.S. in Physics").
const NOT_AN_ASK = /\bno\s+(?:[\w-]+\s+){0,3}degree\b|\bdegree\s+(?:is\s+)?not\s+(?:required|necessary)\b|\b(?:earned|received|completed)\s+(?:his|her|their)\b/i;

/** subjectFit, plus the line that decided it. */
function subjectRead(text, title = '') {
  const ls = lines(text);
  let sawList = '', related = false, preferredOnly = false;
  for (const l of [String(title), ...ls]) {
    if (!SUBJECT_GATE.test(l)) continue;
    if (HIS_FIELD.test(l)) return { fit: 'his-field', line: '' };
    if (GENERIC_ENG.test(l)) return { fit: 'his-field', line: '' };
    if (!OTHER_FIELD.test(l)) continue;
    if (NOT_AN_ASK.test(l)) continue;
    // F-771: A PREFERRED SUBJECT IS NOT A REQUIRED ONE. CMC's "Bachelor's
    // degree in Electrical Engineering preferred", Agropur's "…Degree in
    // Electrical Engineering or Automation preferred" and Otsuka's "Bachelor’s
    // degree is required, preferably Electrical engineering" ask for a degree
    // and would LIKE it to be electrical. Nor does a list under a "Preferred
    // Qualifications" heading. A clause that says "required" stays a
    // requirement: "…Electrical Engineering required; advanced degree
    // strongly preferred" still excludes.
    // A preferred line that leaves the door open still leaves it open: "B.S.
    // in Electrical Engineering" required and "…EE or a related field"
    // preferred is a question, as it was before this pass.
    const door = OPEN_DOOR.test(l) || experienceRoute(l);
    if (door) related = true;
    if (subjectIsPreferred(text, l)) { preferredOnly = true; continue; }
    sawList ||= l;
  }
  if (!sawList) return { fit: preferredOnly ? 'other-preferred' : 'unknown', line: '' };
  return { fit: related ? 'maybe-related' : 'excluded', line: sawList };
}

/** Is the subject list on this line only a preference? */
function subjectIsPreferred(text, line) {
  if (preferredSection(text, line)) return true;
  // "Master’s degree (Ph.D. preferred) in Material Science, …": the bracket
  // prefers the PhD; the subjects outside it are still required.
  const l = dropPrefBrackets(unDot(line), ADVANCED);
  // "…degree is required, preferably Electrical engineering": the fields come
  // only after the word that softens them.
  const soft = l.search(/\b(?:preferably|ideally|preferred\s+(?:majors?|fields?|disciplines?)|preference\s+(?:for|given\s+to))\b/i);
  if (soft >= 0 && !OTHER_FIELD.test(l.slice(0, soft))) return true;
  const clauses = sentences(l).flatMap((s) => s.split(';')).filter((c) => OTHER_FIELD.test(c));
  return clauses.length > 0 && clauses.every(isPrefClause);
}

// THE DEGREE IS ONE ROUTE OF TWO.
//   Nimble Robotics: "0-5 years of experience in a production environment …,
//   or a minimum of 2 years of experience combined with a Bachelor of Science
//   degree in Computer Science, Software Engineering, or Robotics" — the
//   subjects belong to the second route only.
//   Lam Research: "Typically requires a Bachelor's degree and a minimum of 2
//   years of related experience, or a Master’s degree in Materials Science,
//   Chemical Engineering, Chemistry, Physics" — the bachelor's route with
//   experience names no subject.
// Both are a question for him. Micron's "Bachelor’s or Master’s degree in
// Chemical Engineering, …" is not: the bachelor's has no route of its own.
function experienceRoute(line) {
  const l = unDot(line);
  if (yearsThenOr(l, OTHER_FIELD)) return true;
  const adv = l.search(ADVANCED), bach = l.search(BACHELOR);
  if (bach < 0 || adv <= bach) return false;
  const before = l.slice(0, adv);
  return /\bor\s+(?:an?\s+)?$/i.test(before) && /\b(?:experience|years?)\b/i.test(before)
    && !OTHER_FIELD.test(before) && !HIS_FIELD.test(before);
}

// THE TITLE NAMES THE JOB, AND SOMETIMES IT NAMES SOMEBODY ELSE'S.
//
// Two roles survived the degree and subject screens as "apply" while being
// plainly not his: "New College Grad Business Analyst" and "Robotics - Software
// Development Engineer". Both are at companies he tracks, both say "engineering"
// in the qualifications, and neither is a job a mechanical engineer does. The
// description answers "what degree do they want"; only the title answers "what
// is the work".
//
// Kept narrow on purpose. Semiconductor makes this genuinely hard — "Equipment
// Engineer", "Process Engineer" and "Fab Automation Engineer" are mechanical
// work sitting inside an electrical industry — so this lists only titles that
// are unambiguously another discipline's, and everything else passes.
const OTHER_TITLE = screen.otherTitle;
// THESE ONLY COUNT WHEN THE TITLE DOES NOT ALSO NAME HIS WORK.
//
// "Customer Support Engineer - Equipment Engineer" at KLA was refused on
// "customer support" while the title literally says Equipment Engineer, which
// is on HIS_TITLE. Same for "Customer Support Engineer (Field Service)",
// "Mechanical Engineer, Annapurna Labs, Machine Learning Hardware" and
// "Manufacturing Workflow Automation Engineer": thirty-four live rows whose
// title names his field, flagged by a softer word beside it. Left as hard, and
// with the reconcile path unable to touch them, the flag was permanent.
const SOFT_OTHER_TITLE = screen.softOtherTitle;

/** Is the title unambiguously another discipline's work? */
export function titleIsElsewhere(title) {
  const t = String(title || '');
  if (OTHER_TITLE.test(t)) return true;
  return SOFT_OTHER_TITLE.test(t) && !HIS_TITLE.test(t);
}

/** The line the verdict came from — quoted, never paraphrased.
 *
 * F-771: it is the line that DECIDED, handed back by the reader. A second
 * search for "a line with a degree word in it" found none on "B.S. Electrical
 * Engineering" and "BS in EE/CS/ME/Controls or equivalent", so those refusals
 * quoted the job title as their only evidence. */
function findEvidence(degLine, subjLine) {
  return String(degLine || subjLine || '').slice(0, 300);
}

// UN-HIDING NEEDS A HIGHER BAR THAN KEEPING.
//
// Clearing a degree flag puts a posting back in the deck, so a wrong clear is
// how an ineligible role reappears. The first attempt cleared 389 at fit>=70 and
// the sample contained "CAD/EDA Tools Automation Engineer", "Business Automation
// Engineer" and "Intern - AI Information Technology & Network Automation" —
// all matched because the field list carries a bare "automation", which is a
// word three disciplines use.
//
// So the description passing is necessary and not sufficient: the TITLE has to
// name his work too. Narrow and auditable on purpose.
const HIS_TITLE = screen.hisTitle;

/** Does the title itself name work a mechanical engineer does? */
export function titleIsHis(title) {
  const t = String(title || '');
  return HIS_TITLE.test(t) && !titleIsElsewhere(t);
}

/**
 * One verdict per posting: 'apply' | 'check' | 'not-eligible', plus the reason
 * in words he can read. Never silently drops — 'not-eligible' still travels
 * with its reason so a wrong call is visible and arguable.
 */
// degreeBar describes the POSTING ("does it bar a bachelor's holder?"); whether
// that bars THIS user depends on the degree they will hold. A Master's holder
// is barred only by a doctorate-only ask, and a PhD by nothing.
const LEVEL = /^(phd|doctor)/i.test(person.degreeLevel) ? 'phd'
  : /^master/i.test(person.degreeLevel) ? 'master' : 'bachelor';
function levelBarred(deg, description, title) {
  if (deg !== 'advanced-only' || LEVEL === 'phd') return false;
  if (LEVEL === 'bachelor') return true;
  const t = `${title || ''}\n${description || ''}`;
  return /ph\.?\s?d|doctora/i.test(t) && !/\bmaster|\bm\.?s\.?c?\b|\bmba\b/i.test(t);
}

export function eligibility(job, description) {
  const reasons = [];
  const title = String(job?.title || '');
  const { bar: deg, line: degLine } = degreeRead(description, title);
  const { fit: subj, line: subjLine } = subjectRead(description, title);
  const barred = levelBarred(deg, description, title);
  if (barred) reasons.push('wants a Master’s or PhD');
  if (subj === 'excluded') reasons.push(screen.subjectExcludedReason);
  // A SOFT TITLE WORD GIVES WAY TO A DEGREE LINE IN HIS FIELD (F-771).
  // ASM's "Engineer, Technical Product Support" is the equipment field
  // engineer, and Nox Metals' "Associate Supply Chain Engineer" ("supply chain"
  // is a soft word now, like "verification") is supplier engineering on
  // hardware. When the posting's own degree line names his field, the title word
  // is a question for him, not a refusal. A hard title word ("ASIC", "software
  // engineer") still refuses whatever the degree line says, and so does a soft
  // word on a title that is no engineering job: "Supply Chain Planning
  // Analyst" and "Customer Success Manager" ask for "a degree in engineering
  // or business" and are still not his.
  const hardTitle = OTHER_TITLE.test(title);
  const softTitle = !hardTitle && titleIsElsewhere(title) && subj === 'his-field' && /\bengineer/i.test(title);
  if (hardTitle || (titleIsElsewhere(title) && !softTitle)) reasons.push('the title is another discipline’s work');
  // The sentence that decided it, so the card can quote the posting back at him
  // instead of asserting a verdict he has no way to check. Computed AFTER the
  // title reason: it used to run before, so a title-only refusal carried an
  // empty quote and the card fell back to text about degree disciplines —
  // the wrong explanation on 2,878 rows.
  const evidence = reasons.length
    ? (findEvidence(barred ? degLine : '', subj === 'excluded' ? subjLine : '') || title) : '';
  // 'maybe-related' never refuses — it asks.
  if (reasons.length) return { verdict: 'not-eligible', reasons, deg, subj, evidence };

  const soft = [];
  if (deg === 'unknown') soft.push('degree level not stated');
  const mixed = deg === 'mixed' && LEVEL === 'bachelor';
  if (mixed) soft.push('says Master’s in one place and Bachelor’s in another — read it');
  if (subj === 'unknown') soft.push('degree subject not stated');
  if (subj === 'maybe-related') soft.push('lists other majors but opens it to related fields — worth a look');
  if (subj === 'other-preferred') soft.push('prefers other majors but does not require them — worth a look');
  if (softTitle) soft.push('the title reads like another discipline’s work, but the degree line names the field — read it');
  const unsure = subj === 'maybe-related' || subj === 'other-preferred' || softTitle || mixed || soft.length === 2;
  return { verdict: unsure ? 'check' : 'apply', reasons: soft, deg, subj };
}
