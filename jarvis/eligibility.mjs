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
const BACHELOR = /\b(bachelor[’']?s?|b\.?\s?sc?\.?|b\.?a\.?|b\.?eng|undergraduate|4[- ]year degree)\b/i;
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
const OPTIONAL_ADVANCED = /(master[’']?s?|ms\b|m\.s|phd|advanced degree|graduate degree)[^.]{0,30}\b(preferred|a plus|desirable|desired|nice to have|bonus|optional|not required|advantageous|an advantage|ideally|beneficial|welcome|valued)|(preferred|desired|ideally)[^.]{0,24}\b(master|ms\b|advanced)/i;

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
  // The title is the most reliable place this appears and the cheapest to read:
  // "…New College Grad - Masters Degree" is unambiguous. "Master Scheduler" is
  // not a degree, and neither is the state of Mississippi.
  if (ADVANCED_TITLE.test(String(title)) && !/bachelor|\bbs\b/i.test(String(title))) return 'advanced-only';

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

  let demanded = false;
  for (const l of ls) {
    if (!ADVANCED.test(l)) continue;
    if (!/\b(require|must|minimum|qualif|pursu|enrolled|working toward|candidate|seeking|degree|education)\b/i.test(l)) continue;
    if (OPTIONAL_ADVANCED.test(l) || BACHELOR.test(l)) return 'bachelors-ok';
    demanded = true;
  }
  // BOTH, AND THAT IS AN ANSWER OF ITS OWN. Real postings say "Master's degree
  // in X" in the qualifications and carry a bare "Bachelor's degree" line from
  // a structured field elsewhere. Calling that eligible hides a Master's-only
  // role in his inbox; calling it ineligible hides a job he could get. It is a
  // question, so it goes to him as one.
  if (demanded) return bachelorOk ? 'mixed' : 'advanced-only';
  return bachelorOk || BACHELOR.test(String(text)) ? 'bachelors-ok' : 'unknown';
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
const HIS_FIELD = /\b(mechanical|mechatronic|manufactur\w*|industrial engineer\w*|any engineering|all engineering|engineering discipline|\bstem\b|engineering (technology|science))\b/i;
// Fields that are somebody else's degree. Only used to detect a list that
// EXCLUDES him — never on its own.
const OTHER_FIELD = /\b(electrical|electronic|computer (science|engineering)|software|comp sci|cs\b|data science|information (systems|technology)|chemical engineer|chemistry|biology|biomedical|civil engineer|finance|accounting|business administration|marketing|human resources|supply chain|nursing|physics)\b/i;

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
const GENERIC_ENG = /(?<!\b(?:electrical|electronic|computer|software|chemical|civil|biomedical|biological|nuclear|petroleum|environmental|agricultural|architectural|marine|mining|data|financial|sales)\s{1,3})\bengineering\b/i;

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
  const ls = lines(text);
  let sawList = false, related = false;
  for (const l of [String(title), ...ls]) {
    // "Bachelor's IN Chemical, Mechanical, Electrical Engineering" names the
    // subjects without ever using the word "degree", and this gate skipped it —
    // so the most common phrasing on a new-grad req was never inspected at all.
    if (!/\bdegree\b|\bmajor(ing)?\b|\bpursuing\b|\benrolled\b|\bstudying\b|\bbachelor|\bb\.?s\.?\b|\bgraduating\b/i.test(l)) continue;
    if (HIS_FIELD.test(l)) return 'his-field';
    if (GENERIC_ENG.test(l)) return 'his-field';
    if (!OTHER_FIELD.test(l)) continue;
    sawList = true;
    // "…or a related technical discipline" is a door left open. Given the cost
    // of a false exclusion it is a question for him, not a refusal.
    if (/\bor\s+(a\s+)?(related|similar|other)\b|related (field|discipline|technical|major|area)/i.test(l)) related = true;
  }
  if (!sawList) return 'unknown';
  return related ? 'maybe-related' : 'excluded';
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
const OTHER_TITLE = /\b(asic|rtl|verilog|vhdl|firmware|design for test|\bdft\b|physical design|analog|circuit design|\bsoc\b|tapeout|mask operations|wafer test|software (development )?engineer|\bsde\b|full[- ]stack|web developer|web front[- ]end|data (scientist|analyst|engineer)|business (analyst|intelligence)|machine learning (engineer|scientist)|cybersecurity|security analyst|network engineer|cloud (hardware|infrastructure|engineer)|devops|\bsre\b|marketing|sales|recruit|human resources|finance|accountant|legal|paralegal|nurse|supply chain|\bbuyer\b|procurement|logistics|account manager|data science|\banalyst,|,\s*analyst|manufacturing it\b|\bit\s+analyst)/i;
// THESE ONLY COUNT WHEN THE TITLE DOES NOT ALSO NAME HIS WORK.
//
// "Customer Support Engineer - Equipment Engineer" at KLA was refused on
// "customer support" while the title literally says Equipment Engineer, which
// is on HIS_TITLE. Same for "Customer Support Engineer (Field Service)",
// "Mechanical Engineer, Annapurna Labs, Machine Learning Hardware" and
// "Manufacturing Workflow Automation Engineer": thirty-four live rows whose
// title names his field, flagged by a softer word beside it. Left as hard, and
// with the reconcile path unable to touch them, the flag was permanent.
const SOFT_OTHER_TITLE = /\b(verification|machine learning|product support|customer (success|support)|workflow automation)\b/i;

/** Is the title unambiguously another discipline's work? */
export function titleIsElsewhere(title) {
  const t = String(title || '');
  if (OTHER_TITLE.test(t)) return true;
  return SOFT_OTHER_TITLE.test(t) && !HIS_TITLE.test(t);
}

/** The line the verdict came from — quoted, never paraphrased. */
function findEvidence(text, title, deg, subj) {
  const ls = lines(text);
  if (deg === 'advanced-only') {
    const hit = ls.find((l) => ADVANCED.test(l)
      && /\b(require|must|minimum|qualif|pursu|enrolled|degree|education)\b/i.test(l));
    if (hit) return hit.slice(0, 300);
  }
  if (subj === 'excluded') {
    const hit = ls.find((l) => OTHER_FIELD.test(l) && /\bdegree\b|\bmajor/i.test(l));
    if (hit) return hit.slice(0, 300);
  }
  return '';
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
const HIS_TITLE = /\b(mechanical|mechatronic|manufactur\w+|industrial engineer|process engineer|equipment engineer|fab automation|factory automation|robotics and automation|tooling|machining|fixture|thermal|hvac|quality engineer|reliability engineer|field service)\b/i;

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
export function eligibility(job, description) {
  const reasons = [];
  const deg = degreeBar(description, job?.title);
  const subj = subjectFit(description, job?.title);
  if (deg === 'advanced-only') reasons.push('wants a Master’s or PhD');
  if (subj === 'excluded') reasons.push('names degree subjects and mechanical is not one');
  if (titleIsElsewhere(job?.title)) reasons.push('the title is another discipline’s work');
  // The sentence that decided it, so the card can quote the posting back at him
  // instead of asserting a verdict he has no way to check. Computed AFTER the
  // title reason: it used to run before, so a title-only refusal carried an
  // empty quote and the card fell back to text about degree disciplines —
  // the wrong explanation on 2,878 rows.
  const evidence = reasons.length ? (findEvidence(description, job?.title, deg, subj) || String(job?.title || '')) : '';
  // 'maybe-related' never refuses — it asks.
  if (reasons.length) return { verdict: 'not-eligible', reasons, deg, subj, evidence };

  const soft = [];
  if (deg === 'unknown') soft.push('degree level not stated');
  if (deg === 'mixed') soft.push('says Master’s in one place and Bachelor’s in another — read it');
  if (subj === 'unknown') soft.push('degree subject not stated');
  if (subj === 'maybe-related') soft.push('lists other majors but opens it to related fields — worth a look');
  const unsure = subj === 'maybe-related' || deg === 'mixed' || soft.length === 2;
  return { verdict: unsure ? 'check' : 'apply', reasons: soft, deg, subj };
}
