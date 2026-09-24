// jarvis/visa.mjs — work-authorization classification.
//
// WHY THIS IS ITS OWN MODULE, AND WHY IT IS NOT A LIST OF PHRASES
// ───────────────────────────────────────────────────────────────
// This is the only part of triage that can HIDE a job, so it is the only part
// that can cost Alex an opportunity by being wrong. It has been wrong twice, in
// both directions, and both times for the same structural reason.
//
// The old design was a flat set of mega-regexes, each tested against the whole
// document, each trying to encode (topic × polarity × one employer's phrasing)
// in a single pattern. Negation scope was approximated by a character window:
//   /\b(will not|does not|…)[^.\n]{0,N}\bsponsor(ship)?\b/
// That window is one global knob serving two goals that pull against each
// other. Eaton writes "will not consider applicants for employment immigration
// sponsorship" — 47 characters, so N=40 missed it and the posting was labelled
// OPT-FRIENDLY. Widening to N=90 caught Eaton and immediately broke the other
// direction: "We do not discriminate on any protected basis, and we proudly
// sponsor H-1B and green card applications" became a HARD BLOCK, because 90
// characters is long enough to jump from one clause into the next. There is no
// value of N that is both wide enough and narrow enough. The knob was never the
// bug; measuring negation in characters was.
//
// So the model here is structural instead of lexical:
//
//   1. SEGMENT   text → sentences → clauses. Negation is scoped to a clause,
//                which is what a clause IS. No character windows anywhere.
//   2. ANCHOR    does this clause TALK ABOUT work authorization? A small,
//                closed set of nouns (sponsorship, visa, H-1B, work permit…).
//   3. POLARITY  does it say yes or no? Read from English NEGATION CUES —
//                not, no, never, cannot, unable, without, ineligible, …
//   4. ARBITRATE collect every claim, then decide, with an explicit rule for
//                what happens when two claims disagree.
//
// The sustainability argument, which is the whole point: employers invent new
// ways to phrase things forever — "will not consider", "is not eligible for",
// "does not provide immigration-related", "must not need". Enumerating those is
// a treadmill. But the words that carry NEGATION in English are a closed class
// of roughly twenty-five, and they have not changed in centuries. So we model
// negation generally and topics narrowly. A new employer phrasing lands on the
// existing machinery instead of needing a new alternative bolted onto a regex.
//
// The other half of sustainability is that ambiguity has somewhere safe to go.
// Every clause resolves to one of THREE states, never two:
//     negative → block        positive → good        mention → warn and show
// Anything the parser cannot pin down degrades to a visible warning carrying
// the exact sentence. Jarvis is far more afraid of hiding a job than of showing
// a mediocre one, and that preference is now a property of the type system
// rather than a hope about regex behaviour.
//
// Zero AI, zero network. Pure string work.

// ── layer 1: segmentation ───────────────────────────────────────────

/**
 * Split into sentences, safely around abbreviations.
 *
 * "U.S." must not end a sentence — a naive splitter cuts the quote mid-clause
 * and a block then cites half a sentence as its evidence. A period belongs to
 * an abbreviation when the character before it is a lone letter (no letter two
 * back): the dot in "U.S." qualifies, the dot in "citizen." does not.
 */
function splitSentences(src) {
  const isAbbrevDot = (i) =>
    src[i] === '.' && /[A-Za-z]/.test(src[i - 1] || '') && !/[A-Za-z]/.test(src[i - 2] || ' ');
  const spans = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') { spans.push([start, i]); start = i + 1; continue; }
    if (!/[.!?]/.test(src[i]) || isAbbrevDot(i)) continue;
    const rest = src.slice(i + 1);
    // A real boundary is followed by whitespace and something that starts a new
    // sentence — a capital, a digit, a quote, or a bullet.
    if (/^\s*$/.test(rest) || /^\s+["'(\[]?[A-Z0-9•·\-*]/.test(rest)) {
      spans.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < src.length) spans.push([start, src.length]);
  return spans
    .map(([a, b]) => ({ text: src.slice(a, b).trim() }))
    .filter(s => s.text);
}

/**
 * Split one sentence into clauses.
 *
 * Only boundaries that genuinely start a new predication count, because a false
 * split is as damaging as a missing one: cutting "We do not provide relocation
 * and sponsorship" at "and" would strand "sponsorship" without its negation and
 * turn a real no-sponsorship statement into a harmless mention.
 *
 * So a coordinator splits only when it is punctuated (", and") or followed by an
 * explicit subject ("and we are happy to…"). Coordinated NOUNS — "H-1B and
 * green card", "relocation and sponsorship" — are left intact, which is exactly
 * the distinction between the two cases.
 */
const CLAUSE_BOUNDARY = new RegExp([
  ';',
  // ", however …" — these words only ever open a clause, so a comma is enough.
  // The plain coordinators (and/but/or/nor) are deliberately NOT here: a comma
  // in front of one means nothing on its own, because that is also how English
  // punctuates a LIST. "We will not support any CPT, OPT, or H-1B candidates"
  // would split at ", or", strand "H-1B candidates" away from "will not", and
  // report an explicit refusal as a neutral mention. Those coordinators go
  // through the subject/verb tests below, comma or no comma.
  ',\\s+(?=(?:however|although|though|while|whereas|because|since|unless|if|when|provided)\\b)',
  // "and we …" — unpunctuated, but a subject pronoun follows, so it is a clause.
  '\\s+(?=(?:and|but|or|yet|so|while|whereas|however)\\s+(?:we|they|it|you|i|this|these|those|our)\\b)',
  // "and visa sponsorship IS available …" — a noun subject followed by a finite
  // verb is also a new predication. The verb is what does the work: "we do not
  // provide relocation and sponsorship" has a coordinated OBJECT with no verb
  // after "and", so it stays one clause and the negation keeps reaching
  // "sponsorship" — splitting there would turn a real refusal into a harmless
  // mention, which is the same class of error in the opposite direction.
  '\\s+(?=(?:and|but|or|yet|so|while|whereas|however)\\s+(?:[\\w-]+\\s+){0,3}?(?:is|are|was|were|will|would|can|cannot|can\\s?not|could|may|might|shall|do|does|did|must|has|have|had)\\b)',
  // Subordinators always open a new clause of their own.
  '\\s+(?=(?:who|whom|whose|which|because|since|although|though|unless|if|when|whereas|provided\\s+that|as\\s+long\\s+as)\\b)',
  // "that" only when it heads a complement clause, not a relative "the visa that…".
  '\\s+(?=that\\s+(?:we|they|it|you|this|the|candidates?|applicants?|sponsorship|employment)\\b)',
].join('|'), 'gi');

function splitClauses(sentence) {
  const out = [];
  let last = 0;
  CLAUSE_BOUNDARY.lastIndex = 0;
  let m;
  while ((m = CLAUSE_BOUNDARY.exec(sentence)) !== null) {
    out.push(sentence.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].length === 0) CLAUSE_BOUNDARY.lastIndex++;   // zero-width guard
  }
  out.push(sentence.slice(last));
  return out.map(s => s.trim()).filter(Boolean);
}

/** Sentences, each carrying its own clauses. One pass, reused by every rule. */
function segment(text) {
  const src = String(text || '').replace(/\r/g, '');
  return splitSentences(src).map(s => ({ text: s.text, clauses: splitClauses(s.text) }));
}

// ── layer 2: anchors (what a clause is ABOUT) ───────────────────────
//
// Narrow on purpose. These are nouns employers cannot avoid using when they
// talk about work authorization, and they are stable across every posting.

/** The work-authorization nouns. Case-insensitive: these are never ambiguous. */
// "RIGHT TO WORK" HAS A SECOND SENSE, and it is in every EEO paragraph:
// "Each individual has the right to work in a professional atmosphere that
// promotes equal employment opportunities" (Agility Robotics, read 2026-09-08).
// Only the employment-eligibility sense counts, and it is the one that names a
// place — in the US, in this country, in the United States — or is qualified
// legally/unrestricted. Everything else is somebody's right to a decent
// workplace, and reading it as a refusal to sponsor cost him a real job.
const RIGHT_TO_WORK = /\b(?:legal(?:ly)?|unrestricted|permanent)\s+right\s+to\s+work\b|\bright\s+to\s+work\s+(?:in|for)\s+(?:the\s+)?(?:u\.?\s?s\.?|usa|united\s+states|this\s+country|any\s+employer)\b/i;
const AUTH_NOUN = /\b(sponsorship|visas?|immigration|h-?1-?b|h1b|green\s?cards?|work\s+permits?|(?:employment|work)\s+authoriz\w*|tn\s+(?:visa|status))\b|(?:legal(?:ly)?|unrestricted|permanent)\s+right\s+to\s+work\b|\bright\s+to\s+work\s+(?:in|for)\s+(?:the\s+)?(?:u\.?\s?s\.?|usa|united\s+states|this\s+country|any\s+employer)\b/i;

/**
 * The VERB "sponsor" only counts when its object is a person or a visa.
 *
 * "We proudly sponsor community events" is a charitable-giving sentence, and
 * the old classifier reported it as evidence the employer sponsors visas. The
 * word is identical; only the object separates the two senses, so the object is
 * what we test.
 */
const SPONSOR_VERB_OBJ = /\bsponsor(s|ing|ed)?\b[^.;]{0,40}?\b(visas?|immigration|candidates?|applicants?|employees?|individuals?|workers?|foreign\s+nationals?|employment|h-?1-?b|green\s?card)\b/i;

/** The verb itself, for the object-less case below. */
const SPONSOR_VERB = /\b(?:to\s+)?sponsor(?:s|ing)?\b/i;

/** …and the objects that mark the OTHER sense of it beyond doubt. */
const CHARITY_OBJ = /\bsponsor(?:s|ing|ed)?\s+(?:the\s+)?(?:[\w-]+\s+){0,2}?(?:events?|teams?|marathons?|races?|conferences?|meetups?|hackathons?|charit\w+|scholarships?|fundraisers?|communit\w+|clubs?|leagues?|tournaments?)\b/i;

/**
 * THE BENEFITS SENSE OF "SPONSOR" — the third one, and the most expensive so
 * far. ERISA plan documents call the employer the plan "Sponsor", and the
 * paragraph is boilerplate that ends up pasted into job postings:
 *
 *   "No individual has a vested right to any benefit under a Sponsor's
 *    welfare benefit plan or program."
 *
 * `SPONSOR_VERB` matches "Sponsor", `NEG_CUE` matches "No", and the clause is
 * read as a refusal to sponsor a visa. Measured 2026-09-10 against the store:
 * **73 postings hard-blocked on this sentence, 68 of them GE Aerospace** — an
 * employer removed from his deck by its own benefits boilerplate.
 *
 * Like the charity sense, it is identified by its neighbours, not by the word.
 */
const BENEFIT_PLAN_SPONSOR = /\b(?:vested\s+right|welfare\s+benefit\s+plan|benefit\s+plan\s+or\s+program|plan\s+sponsor|summary\s+plan\s+description|\bERISA\b)\b/i;

/**
 * THE TRAVEL SENSE OF "VISA". A posting that says travel is required often adds
 * who arranges the travel visa:
 *
 *   "The ability to travel domestically and abroad is required
 *    (VISA not being handled by Veeva)."
 *
 * That is a business-travel document, not work authorization, and it fired the
 * no-sponsorship block on 6 postings. It only counts as the travel sense when
 * the clause is ABOUT travel and names none of the employment-authorization
 * nouns — "we cannot sponsor a work visa for a role that requires travel" must
 * still block.
 */
const TRAVEL_CONTEXT = /\b(?:travel(?:s|ling|ing|led|ed)?|passports?|business\s+trips?|abroad|overseas)\b/i;
const WORK_AUTH_NOUN_STRICT = /\b(sponsorship|immigration|h-?1-?b|h1b|green\s?cards?|work\s+permits?|(?:employment|work)\s+authoriz\w*|work\s+visas?|tn\s+(?:visa|status))\b/i;

/**
 * A HEDGE IS NOT A REFUSAL. "Sponsorship for this role is not guaranteed" says
 * the employer might sponsor and will not promise it — which is true of every
 * employer alive, and is the ordinary way a large company words a maybe.
 *
 * `NEG_CUE` sees "not" and the clause reads as an outright refusal. Measured
 * 2026-09-10: **140 postings hard-blocked on a hedge**, most of them Amgen.
 *
 * These become a caution instead, carrying the sentence — the same treatment
 * the contradiction rule gives conflicting evidence, and for the same reason:
 * "read this one" is the honest verdict, and hiding it is the expensive error.
 */
const HEDGE = /\b(?:not|never|cannot|can\s?not|un-?\s?able\s+to\s+be)\s+(?:be\s+)?guarantee\w*\b|\bno\s+guarantee\b|\bguarantee\w*\s+(?:is|are)\s+not\b/i;

/**
 * The export-control definition of "U.S. person" — a definition, not a policy.
 * Identified by its authority citation or by the enumerating phrase itself.
 */
const US_PERSON_DEF = /\bthis\s+status\s+includes\b|\bas\s+defined\s+(?:by|in|under)\b[^.]{0,80}?(?:22\s*c\.?\s?f\.?\s?r|8\s*u\.?\s?s\.?\s?c|\bitar\b|\bear\b|export)|\bu\.?\s?s\.?\s+persons?\s+as\s+defined\b/i;

/**
 * Nouns that make a clause a statement about SPONSORSHIP.
 *
 * Deliberately excludes "green card", which is the word that made the
 * definition sentence above look like a policy. A green card appears in any
 * list of immigration statuses; sponsorship, a visa or a work permit do not
 * turn up except when the employer is talking about sponsoring.
 */
const SPONSORSHIP_NOUN = /\b(sponsorship|immigration|h-?1-?b|h1b|visas?|work\s+permits?|(?:employment|work)\s+authoriz\w*)\b/i;

/**
 * OPT / CPT / F-1 are matched CASE-SENSITIVELY.
 *
 * Lowercase "opt" is privacy boilerplate — "opt out of marketing emails" was
 * being read as an OPT reference and postings were labelled OPT-friendly on the
 * strength of an unsubscribe link.
 */
const STUDENT_CS = /\bOPT\b|\bCPT\b|\bF-?1\b/;

/** Authorization-to-work phrasing, and the qualifier that makes it a disqualifier. */
const AUTH_TO_WORK = /\b(?:authoriz\w*|eligible|eligibility|legally\s+(?:authoriz\w*|able))\s+to\s+work\b|\b(?:work|employment)\s+authoriz\w*\b|(?:legal(?:ly)?|unrestricted|permanent)\s+right\s+to\s+work\b|\bright\s+to\s+work\s+(?:in|for)\s+(?:the\s+)?(?:u\.?\s?s\.?|usa|united\s+states|this\s+country|any\s+employer)\b/i;
const PERMANENCE = /\b(permanent(?:ly)?|indefinite(?:ly)?|unrestricted|without\s+(?:\w+\s+){0,3}sponsorship|without\s+restriction|for\s+any\s+employer|now\s+(?:and|or)\s+in\s+the\s+future)\b/i;
const REQUIREMENT = /\b(must|required?|requires|requiring|need\s+to\s+be|should\s+be|only|shall)\b/i;

/** Sentence-scope topics: read whole, never clause-split (see classifySentence). */
const CLEARANCE = /\b(?:active\s+)?(?:security\s+clearance|secret\s+clearance|top\s+secret|ts\/sci|sci\s+clearance|dod\s+(?:secret|clearance)|q\s+clearance|polygraph)\b/i;
const CITIZEN = /\b(?:must\s+be\s+(?:an?\s+)?)?(?:u\.?\s?s\.?|united\s+states)\s+cit(?:i|iz)[a-z]*\b|\bcit(?:i|iz)enship\s+(?:is\s+)?(?:required|mandatory)\b/i;
const US_PERSON = /\bu\.?\s?s\.?\s+persons?\b|\b(?:export[- ]control|itar|ear)\b[^.]{0,80}\b(?:u\.?\s?s\.?\s+persons?|citizen|permanent\s+resident)\b/i;
/**
 * The alternatives listed beside "citizen" — what separates an export-control
 * screening question from a demand for citizenship.
 *
 * "Perm Resident" must match as surely as "lawful permanent resident". Since
 * 2026-09-19 the two verdicts have opposite consequences — a citizenship-only
 * demand still hides the job, a U.S.-person list only flags it — so an
 * abbreviation that slips past here is the difference between a posting he sees
 * and one he never does. Greenhouse's own form question reads "Are you either a
 * US Citizen or a Perm Resident)?", typo and all.
 */
const PERSON_ALT = /\b(?:lawful(?:ly)?\s+)?perm(?:anent)?\.?\s+resident|green[- ]card|u\.?\s?s\.?\s+persons?|protected\s+individual|asylee|refugee\b|\b8\s*u\.?\s?s\.?\s?c\.?\s*(?:sec\.?|§)?\s*1324b/i;
const EXPORT_CONTROL = /\b(?:itar|ear|export[- ]control(?:led)?|export\s+administration\s+regulations)\b/i;
/**
 * The export-control sentence that is a BLOCK, as opposed to a badge (F-312).
 * "Final offers will be contingent on ability to obtain authorization for
 * access to U.S. export-controlled information from the U.S. Government" is a
 * licence application for a non-U.S. person, not a formality. "Requires
 * access to controlled technology as defined in the EAR" on its own is the
 * caution below — a single hard block there would cost him ASML.
 */
const EXPORT_AUTH = /\b(?:contingent\s+(?:up)?on|subject\s+to|conditioned\s+(?:up)?on|dependent\s+(?:up)?on)\b[^\n]{0,80}?\b(?:ability\s+to\s+obtain|obtaining|obtain|receipt\s+of|securing|approval\s+of)\b[^\n]{0,60}?\b(?:export\s+)?(?:licen[cs]e|authori[sz]ation)\b[^\n]{0,120}?\b(?:export[- ]controlled|export[- ]control|u\.?\s?s\.?\s+government|\bEAR\b|\bITAR\b)|\b(?:must|required\s+to|need\s+to|will\s+need\s+to)\s+(?:be\s+able\s+to\s+)?obtain\b[^\n]{0,50}?\bexport\s+(?:licen[cs]e|authori[sz]ation)\b/i;

/**
 * Equal-opportunity boilerplate.
 *
 * EEO text is a legally-mandated fixed genre that NAMES visa and citizenship
 * terms while stating no policy about them whatsoever — "without regard to …
 * citizenship status" is a promise not to discriminate, not a requirement. It
 * also contains the word "not" almost by definition, which is precisely what a
 * negation-driven classifier will trip over. Recognising the genre once, here,
 * is far more durable than trying to keep every other rule from touching it.
 */
const EEO = /\b(?:without\s+regard\s+to|regardless\s+of|equal\s+(?:employment\s+)?opportunit(?:y|ies)|affirmative\s+action|protected\s+(?:class|status|characteristic|veteran)|do(?:es)?\s+not\s+discriminate|prohibits?\s+(?:unlawful\s+)?discriminat\w*|\bEEO\b|E-?Verify)\b/i;

// ── layer 3: polarity ───────────────────────────────────────────────

/**
 * The negation cues. THIS IS THE CLOSED SET the whole design rests on.
 *
 * Employers will keep inventing verbs ("will not consider", "declines to
 * support", "is precluded from offering"). They cannot invent new ways to
 * negate — English has these and essentially no others. Adding a rare one here
 * fixes every topic at once, which is the property the old per-phrase regexes
 * did not have.
 */
const NEG_CUE = /\b(?:not|n'?t|no|never|cannot|can\s?not|un-?\s?able|un-?\s?willing|without|lacks?|lacking|ineligible|declines?|declined|refus\w+|prohibit\w*|preclud\w+|exclud\w+|disqualif\w+|denies|denied|neither|nor|forgo|waive[ds]?)\b/i;

/**
 * Affirmative sponsorship. Deliberately narrower than "absence of a negation":
 * a clause that merely MENTIONS sponsorship is not a promise to provide it, and
 * treating silence as a yes is how a posting gets a green "✓ sponsor" badge it
 * never earned.
 */
const POS_SPONSOR = new RegExp([
  '(?<![\\w-])(?:will|do|does|can|are\\s+able\\s+to|able\\s+to|happy\\s+to|glad\\s+to|pleased\\s+to|open\\s+to|willing\\s+to|proudly|prepared\\s+to|may)\\s+(?:consider\\s+)?sponsor\\w*',
  '\\bwe\\s+sponsor\\b',
  '\\b(?:visa\\s+|immigration\\s+|employment\\s+)?sponsorship\\s+(?:is\\s+|are\\s+|will\\s+be\\s+)?(?:available|offered|provided|supported|possible|considered)\\b',
  '\\b(?:offers?|provides?|supports?|sponsors?)\\s+(?:visa\\s+|immigration\\s+|employment\\s+)?sponsorship\\b',
  '\\beligible\\s+for\\s+(?:visa\\s+|immigration\\s+)?sponsorship\\b',
  '\\bsponsorship\\s*[:\\-]\\s*yes\\b',
  '\\bwelcome\\s+(?:to\\s+apply\\s+)?(?:candidates?\\s+)?(?:on|with|requiring|needing)\\s+(?:visa|sponsorship|OPT|CPT|F-?1|H-?1B)',
].join('|'), 'i');

/**
 * One clause's verdict on work authorization.
 * @returns {'negative'|'positive'|'mention'|'hedged'|null}
 */
function sponsorshipPolarity(clause) {
  // THE U.S.-PERSON DEFINITION, WHICH IS A DEFINITION AND NOT A POLICY.
  //
  // Export-control paragraphs close with a sentence spelling out who counts:
  //
  //   "This status includes U.S. citizens, U.S. nationals, lawful permanent
  //    residents (green card holders), and asylees and refugees with such
  //    status granted, not pending."
  //
  // "green card" is a work-authorization noun and "not" is a negation cue, so
  // the clause reads as a refusal to sponsor — and Vast's entire board, 202
  // postings including 0-2 year reqs at $86-122K, was hard-blocked as
  // `no_sponsorship` on a sentence that states no sponsorship policy at all.
  // Measured 2026-09-19.
  //
  // Recognised as a genre, the way EEO text is, rather than by patching the
  // phrase: the definition is boilerplate that varies in wording but always
  // cites its authority or enumerates the status. A clause that names a real
  // sponsorship noun is exempt, so "we do not sponsor H-1B for U.S.-person
  // roles" still blocks.
  if (US_PERSON_DEF.test(clause) && !SPONSORSHIP_NOUN.test(clause)) return null;
  // The charitable sense is identified by its object and is never the visa
  // sense, so it is ruled out first.
  if (CHARITY_OBJ.test(clause) && !AUTH_NOUN.test(clause)) return null;
  // Neither is the benefits sense, whatever the capital S suggests.
  if (BENEFIT_PLAN_SPONSOR.test(clause) && !WORK_AUTH_NOUN_STRICT.test(clause)) return null;
  // Nor a travel document, when travel is all the clause is about.
  if (TRAVEL_CONTEXT.test(clause) && !WORK_AUTH_NOUN_STRICT.test(clause)) return null;
  const about = AUTH_NOUN.test(clause)
    || SPONSOR_VERB_OBJ.test(clause)
    // A bare, object-less "cannot sponsor" is the visa sense too. Nobody writes
    // "we are unable to sponsor" about a charity in a job posting, and requiring
    // an object let "We cannot sponsor at this time" pass as if it said nothing.
    || (SPONSOR_VERB.test(clause) && NEG_CUE.test(clause));
  if (!about) return null;
  // A hedge outranks the negation it contains: "sponsorship is not guaranteed"
  // negates the PROMISE, not the sponsorship.
  if (HEDGE.test(clause)) return 'hedged';
  // Negation wins over affirmation inside a single clause: "we are not able to
  // sponsor visas" contains an affirmative-looking "able to sponsor", and the
  // negation is the operative half.
  if (NEG_CUE.test(clause)) return 'negative';
  if (POS_SPONSOR.test(clause)) return 'positive';
  return 'mention';
}

/** Permanent/unrestricted authorization demanded — a disqualifier stated positively. */
function requiresPermanentAuth(clause) {
  if (!AUTH_TO_WORK.test(clause) || !PERMANENCE.test(clause)) return false;
  // "authorized to work in the United States" on its own is boilerplate that an
  // F-1 on OPT satisfies. Only a demand for PERMANENT authorization excludes
  // him, so the requirement framing has to be present too.
  return REQUIREMENT.test(clause) || /without\s+(?:\w+\s+){0,3}sponsorship/i.test(clause);
}

// ── layer 4: claims ─────────────────────────────────────────────────

/**
 * Walk the text once and collect every work-authorization claim it makes.
 *
 * Sentence-scope vs clause-scope is a deliberate split:
 *   • Clause scope for anything POLARITY-sensitive (sponsorship, permanent
 *     authorization, student status), because clause boundaries are what bound
 *     negation — that is the entire fix.
 *   • Sentence scope for the rest (citizenship, U.S. person, clearance, export
 *     control), because those are read from COORDINATED LISTS that clause
 *     splitting would take apart: "must be a U.S. citizen, lawful permanent
 *     resident, or protected individual" is one ITAR U.S.-person clause, and
 *     reading its first fragment alone would report it as citizen-only —
 *     a less accurate label for the same job.
 */
function collectClaims(text) {
  const claims = [];
  for (const s of segment(text)) {
    const sentenceIsEeo = EEO.test(s.text);

    // — clause-scope, polarity-sensitive —
    for (const clause of s.clauses) {
      // EEO is checked per CLAUSE so a sentence that pairs boilerplate with a
      // real statement keeps the real half: "We do not discriminate …, and we
      // proudly sponsor H-1B" must still register as sponsor-friendly.
      if (EEO.test(clause)) continue;

      if (requiresPermanentAuth(clause)) {
        claims.push({ topic: 'permanent_auth', polarity: 'negative', quote: s.text });
      }
      const pol = sponsorshipPolarity(clause);
      if (pol) claims.push({ topic: 'sponsorship', polarity: pol, quote: s.text });
      if (STUDENT_CS.test(clause)) {
        claims.push({ topic: 'student_status', polarity: NEG_CUE.test(clause) ? 'negative' : 'positive', quote: s.text });
      }
    }

    // — sentence-scope conditional rule —
    //
    // "If you require sponsorship, we are unable to move forward." Clause
    // splitting correctly separates the condition from its consequence, which
    // leaves the anchor in one clause and the negation in the other and would
    // otherwise lose the statement entirely. A conditional whose antecedent
    // names sponsorship and whose consequent is negative IS a refusal, however
    // it is worded — a structural rule, not another phrase to memorise.
    if (!sentenceIsEeo && /\b(?:if|should\s+you|candidates?\s+(?:who|requiring)|those\s+(?:who|requiring))\b/i.test(s.text)) {
      const [head, ...tail] = s.clauses;
      const antecedent = s.clauses.find(c => AUTH_NOUN.test(c));
      const consequent = tail.join(' ');
      if (antecedent && consequent && NEG_CUE.test(consequent) && !AUTH_NOUN.test(head || '')) {
        claims.push({ topic: 'sponsorship', polarity: 'negative', quote: s.text });
      }
    }

    // — sentence-scope, list-sensitive —
    if (sentenceIsEeo) continue;
    if (CLEARANCE.test(s.text)) claims.push({ topic: 'clearance', polarity: 'negative', quote: s.text });
    if (EXPORT_AUTH.test(s.text)) claims.push({ topic: 'export_auth', polarity: 'negative', quote: s.text });
    if (EXPORT_CONTROL.test(s.text)) claims.push({ topic: 'export_control', polarity: 'mention', quote: s.text });
    if (US_PERSON.test(s.text)) {
      claims.push({ topic: 'us_person', polarity: 'negative', quote: s.text });
    } else if (CITIZEN.test(s.text)) {
      // Citizen-ONLY and U.S.-person are both disqualifying for an F-1, but they
      // are different requirements and must be LABELLED apart. The alternatives
      // listed beside "citizen" are what tell them apart.
      claims.push({ topic: PERSON_ALT.test(s.text) ? 'us_person' : 'us_citizen', polarity: 'negative', quote: s.text });
    }
  }
  return claims;
}

// ── layer 5: arbitration ────────────────────────────────────────────

/**
 * WHAT STILL HIDES A JOB, AND WHAT STOPPED HIDING ONE ON 2026-09-19.
 *
 * Export control used to sit in this list twice — `us_person` and
 * `export_auth` — on the reasoning that an F-1 cannot satisfy an ITAR
 * U.S.-person clause. Alex has since said plainly that he has held an
 * export-controlled role before: that is how his Applied Materials summer
 * happened. He does not know which paperwork his employer filed, and he does
 * not need to — the measured fact is that employers DO get it done, and a
 * clause naming ITAR or the EAR is therefore a question to ask a recruiter,
 * not a door that is closed to him.
 *
 * Weighed against the cost, this was never a close call. In one afternoon of
 * LinkedIn reading, export-control clauses alone hid Radiant's four postings
 * (which name his exact graduation window, name Mechanical Engineering, ask
 * for no prior years and pay $105–130K) plus five Vast reqs at $86–122K with
 * 0–2 year bars. That is the expensive error this whole file exists to avoid,
 * committed nine times in one day.
 *
 * What remains a block is what no paperwork fixes on his side:
 *   • clearance      — an F-1 cannot hold one, and no employer can file for it
 *   • us_citizen     — citizenship stated with no alternative listed beside it
 *   • permanent_auth — permanent/unrestricted authorization demanded up front
 *   • sponsorship    — the employer has said in writing that it will not sponsor
 *
 * Export control now leaves through the warnings channel instead, carrying the
 * exact sentence so he can judge the wording himself. The three tiers are real
 * and worth telling apart: "may require access … or eligible for government
 * authorization" (Samsung) is close to nothing, "contingent upon the
 * applicant's capacity to serve in compliance" (Radiant) is a question, and a
 * 22 C.F.R. U.S.-person list (Vast) is a genuine hurdle his employer has to
 * want to clear.
 */
const BLOCK_ORDER = ['clearance', 'us_citizen', 'permanent_auth', 'sponsorship'];

const BLOCK_SPEC = {
  clearance: { key: 'clearance', reason: 'Requires a security clearance (citizenship-dependent)' },
  us_citizen: { key: 'us_citizen', reason: 'Requires U.S. citizenship' },
  permanent_auth: { key: 'perm_authorization', reason: 'Requires permanent/unrestricted work authorization' },
  sponsorship: { key: 'no_sponsorship', reason: 'States it will not sponsor a work visa' },
};

/**
 * Classify work authorization. Returns at most one hard block plus any warnings.
 *
 * Contract is unchanged from the old implementation — same block keys, same
 * warning keys, same shape — so serve.mjs, db.mjs and the dashboard need no
 * changes. Only how the verdict is REACHED is different.
 *
 * @returns {{block: null|{key:string,reason:string,quote:string|null}, warnings: Array<{key:string,level:string,note:string,quote:string|null}>}}
 */
export function classifyVisa(title, description) {
  const text = `${title || ''}\n${description || ''}`;
  const claims = collectClaims(text);
  const warnings = [];

  const of = (topic, polarity) => claims.filter(c => c.topic === topic && c.polarity === polarity);
  const negSponsor = of('sponsorship', 'negative');
  const posSponsor = of('sponsorship', 'positive');
  const negPerm = of('permanent_auth', 'negative');

  // THE CONTRADICTION RULE.
  //
  // A posting that says both "we cannot sponsor" and "we sponsor visas" is
  // either two boilerplate blocks glued together or a genuinely conditional
  // policy. Either way the honest answer is "read this one", not "hidden". So
  // conflicting sponsorship evidence NEVER produces a hard block; it produces a
  // caution carrying both sentences and the job stays in the deck.
  //
  // It applies only to sponsorship and permanent-authorization, not to
  // clearance/citizenship/ITAR. Those are stated once, unambiguously, in
  // language that has no affirmative counterpart to conflict with — there is no
  // such thing as a posting that says "no clearance required" as policy.
  const conflicted = posSponsor.length > 0 && (negSponsor.length > 0 || negPerm.length > 0);

  let block = null;
  for (const topic of BLOCK_ORDER) {
    const hits = of(topic, 'negative');
    if (!hits.length) continue;
    if (conflicted && (topic === 'sponsorship' || topic === 'permanent_auth')) continue;
    block = { ...BLOCK_SPEC[topic], quote: hits[0].quote || null };
    break;
  }

  if (conflicted) {
    warnings.push({
      key: 'visa_conflict',
      level: 'caution',
      note: 'This posting states BOTH that it will not sponsor and that it does — usually two boilerplate blocks glued together, sometimes a conditional policy. Not hidden, because guessing wrong here costs you the job. Read both sentences.',
      quote: [(negSponsor[0] || negPerm[0])?.quote, posSponsor[0]?.quote].filter(Boolean).join('  ⟷  ') || null,
    });
  }

  // A hedge never blocks, but it is never silent either — "not guaranteed" is
  // real information about the odds, and he should read it before spending an
  // evening on the posting.
  const hedged = of('sponsorship', 'hedged');
  if (hedged.length && !block) {
    warnings.push({
      key: 'sponsorship_hedged',
      level: 'caution',
      note: 'The posting hedges: sponsorship is possible but NOT promised. That is a maybe, not a refusal, so the job stays in your deck — read the sentence and weigh it.',
      quote: hedged[0].quote || null,
    });
  }

  // EXPORT CONTROL, MOST SPECIFIC WORDING FIRST.
  //
  // All three of these are cautions, never blocks (see BLOCK_ORDER above). They
  // are reported one at a time, strongest first, because a posting that carries
  // a U.S.-person list also mentions the EAR somewhere, and stacking three
  // warnings on one job says less than naming the hardest sentence in it.
  const usPerson = of('us_person', 'negative');
  const exportAuth = of('export_auth', 'negative');
  const exportMention = of('export_control', 'mention');

  if (usPerson.length) {
    warnings.push({
      key: 'us_person',
      level: 'caution',
      note: 'Names a "U.S. person" requirement (citizen, permanent resident, asylee or refugee). This is the hardest of the export-control wordings — the employer has to want to file for you. You have held an export-controlled role before, so it is worth asking rather than skipping, but ask early.',
      quote: usPerson[0].quote || null,
    });
  } else if (exportAuth.length) {
    warnings.push({
      key: 'export_authorization',
      level: 'caution',
      note: 'The offer is contingent on obtaining U.S. Government export authorization. That is a licence application your employer files, not a formality — but it is the same class of paperwork that cleared your Applied Materials summer. Ask what they have done before.',
      quote: exportAuth[0].quote || null,
    });
  } else if (exportMention.length) {
    warnings.push({
      key: 'export_control',
      level: 'caution',
      note: 'Mentions export control (ITAR/EAR) without naming a status requirement. Not a security clearance and usually not an obstacle — semiconductor tool work is EAR-controlled by default. Read the sentence.',
      quote: exportMention[0].quote || null,
    });
  }

  // Only a clause that actually PROMISES sponsorship earns the green badge, and
  // never while something blocks or contradicts it.
  if (posSponsor.length && !block && !conflicted) {
    warnings.push({ key: 'sponsorship_positive', level: 'good', note: 'Posting indicates it DOES offer visa sponsorship.', quote: posSponsor[0].quote || null });
  }

  // "Mentions OPT" is not "welcomes OPT". Eaton's postings say "will not support
  // any CPT, OPT, or H-1B"; reporting that as OPT-friendly inverts a
  // disqualifier into an encouragement, which is the single most dangerous
  // thing this file could do.
  const negStudent = of('student_status', 'negative');
  const posStudent = of('student_status', 'positive');
  if (negStudent.length) {
    warnings.push({
      key: 'opt_negative',
      level: 'caution',
      note: 'Posting names OPT/CPT/F-1 in a NEGATIVE sentence — it is telling you it will not support that status. Read the quote.',
      quote: negStudent[0].quote || null,
    });
  } else if (posStudent.length && !block) {
    warnings.push({ key: 'opt_ok', level: 'good', note: 'Posting explicitly references OPT/CPT/F-1 — likely OPT-friendly.', quote: posStudent[0].quote || null });
  }

  // Silence. Most postings say nothing either way, and silence is not a
  // disqualifier — but it is worth knowing before he spends an evening on one.
  if (!block && !claims.length) {
    warnings.push({
      key: 'sponsorship_unmentioned',
      level: 'unknown',
      note: 'Posting does not mention visa sponsorship either way. Not a disqualifier — worth confirming before/at application.',
      quote: null,
    });
  }

  return { block, warnings };
}

// Exported for the tests, which assert on the mechanism (segmentation, polarity)
// rather than only on end-to-end verdicts — a phrasing that breaks should point
// at the layer that mishandled it.
export const _internals = { segment, splitSentences, splitClauses, sponsorshipPolarity, requiresPermanentAuth, collectClaims };
