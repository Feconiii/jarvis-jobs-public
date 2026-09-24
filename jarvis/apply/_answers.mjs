/**
 * The same question with the form's decoration taken off.
 *
 * Every audit before this one fed the rules a CLEAN label, and real forms do
 * not emit clean labels. Measured mechanically — thirteen decorations applied
 * to thirty-one labels the engine answers — twenty-seven combinations lost the
 * answer entirely:
 *
 *     "City"              -> Springfield
 *     "City (required)"   -> no idea
 *     "* Address"         -> no idea
 *     "Degree *"          -> no idea
 *
 * These are the tightly anchored rules, and the anchors are there for good
 * reasons: `^city$` exists so "Emergency contact city" cannot reach it. So the
 * anchors are left exactly as they are and this runs as a SECOND pass, only
 * when the raw label matched no rule at all. It can add an answer; it can never
 * change one that already worked.
 *
 * Only decoration is removed — the required marker, a leading number, a
 * trailing colon, and a "(required)"/"(optional)" clause. Wording is never
 * touched, because a word inside the question is part of the question.
 */
export function tidyLabel(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\s(*\u2013\u2014-]*\b(?:this\s+field\s+is\s+)?(?:required|optional|mandatory)\b[\s).:*]*$/i, '')
    .replace(/^\s*\d+\s*[.)]\s*/, '')
    .replace(/^[\s*\u2020:]+/, '')
    .replace(/[\s*\u2020:?]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// jarvis/apply/_answers.mjs — the question→answer matching table.
//
// Shared by every ATS adapter. Given a form field's LABEL TEXT, decide:
//   - never  : policy says leave it alone (EEO/self-ID, certifications, SSN…)
//   - answer : we have a value from the user's apply-profile (maybe review-flagged)
//   - null   : unknown question → leave blank, report "needs your input"
//
// The engine never invents an answer: everything here reads straight from
// data/jarvis/apply-profile.yml, which the user owns and edits.

/** Rules checked in order; first label match wins. `review: true` means the
 *  filled value is additionally listed under "review these answers" per app. */
const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

/**
 * One half of a graduation date, when the form splits it into two controls.
 *
 * His profile writes it as a single string ("May 2027"), which is the natural
 * way to hold it and the wrong shape for a form with separate Month and Year
 * dropdowns. Returns undefined rather than guessing when the part is not
 * actually there — a year alone yields no month, and inventing "January" would
 * put a date on the form that he never gave.
 */
export function gradPart(profile, part) {
  const raw = String(profile?.education?.graduation || '').trim();
  if (!raw) return undefined;

  if (part === 'year') {
    const y = raw.match(/\b(?:19|20)\d{2}\b/);
    return y ? y[0] : undefined;
  }

  // Month by name or three-letter prefix, matched on WORD STARTS.
  //
  // Deliberately no regex escape here. Two earlier attempts wrote a lone `\b`
  // into a string and a template literal, where it is a BACKSPACE character
  // rather than a word boundary — both matched nothing at all, silently, and
  // "May 2027" came back with no month. Splitting into words needs no escape
  // and cannot fail that way, while still refusing a mid-word hit.
  const words = raw.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const named = MONTHS.find((m) => words.some((w) => w.startsWith(m.slice(0, 3).toLowerCase())));
  if (named) return named;

  // Numeric forms: 05/2027 and 2027-05.
  let n = null;
  let m = raw.match(/\b(\d{1,2})\s*[/-]\s*(?:19|20)\d{2}\b/);
  if (m) n = Number(m[1]);
  if (n === null) {
    m = raw.match(/\b(?:19|20)\d{2}\s*[/-]\s*(\d{1,2})\b/);
    if (m) n = Number(m[1]);
  }
  return n !== null && n >= 1 && n <= 12 ? MONTHS[n - 1] : undefined;
}

/**
 * Which US time zone a state sits in.
 *
 * Only the states that sit wholly in ONE zone. Idaho, Oregon, Kansas,
 * Nebraska, North Dakota, South Dakota, Texas, Tennessee, Kentucky, Florida
 * and Michigan are split across two, and guessing which half he means would be
 * inventing a fact — so they are deliberately absent and the question stays his.
 */
const STATE_TIMEZONE = {
  washington: 'PST', california: 'PST', nevada: 'PST',
  arizona: 'MST', utah: 'MST', montana: 'MST', wyoming: 'MST', colorado: 'MST', 'new mexico': 'MST',
  illinois: 'CST', wisconsin: 'CST', minnesota: 'CST', iowa: 'CST', missouri: 'CST',
  arkansas: 'CST', louisiana: 'CST', mississippi: 'CST', alabama: 'CST', oklahoma: 'CST',
  'new york': 'EST', 'new jersey': 'EST', pennsylvania: 'EST', massachusetts: 'EST',
  connecticut: 'EST', 'rhode island': 'EST', vermont: 'EST', 'new hampshire': 'EST',
  maine: 'EST', maryland: 'EST', delaware: 'EST', virginia: 'EST', 'west virginia': 'EST',
  'north carolina': 'EST', 'south carolina': 'EST', georgia: 'EST', ohio: 'EST',
  'district of columbia': 'EST',
};

/** His time zone, derived from the state in his profile, or undefined. */
export function timezoneFor(profile) {
  const st = String(profile?.identity?.state || '').trim().toLowerCase();
  return STATE_TIMEZONE[st];
}

/**
 * HAS HE WORKED FOR THE COMPANY HE IS APPLYING TO?
 *
 * His profile answers "No" as a default, with a note beside it that says the
 * Applied Materials internship is the exception. Measured on the live Applied
 * Materials form (2026-09-06), the engine took the default and planned "No" for
 * "Have you ever worked at Applied Materials as a regular employee, contingent
 * worker, intern, etc.?" — a false answer about his own most important
 * employer, on their own application, over a field the page already held "Yes"
 * in. Only the combobox failing to match saved it.
 *
 * The answer is in his profile already: `work_experience[].company`. So the
 * question is answered from his own history when the employer matches, and
 * falls back to the standing answer otherwise. Nothing is invented — an
 * employer that is not in his history still answers exactly as before.
 */
function nameKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|plc|gmbh|holdings|group|technologies|technology)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
export function employedAtApplyingTo(profile) {
  const who = nameKey(profile?.applyingTo);
  if (!who) return null;
  const mine = (Array.isArray(profile?.work_experience) ? profile.work_experience : [])
    .map((e) => nameKey(e?.company)).filter(Boolean);
  if (!mine.length) return null;
  // Either name containing the other: "Applied Materials" answers a posting at
  // "Applied Materials Inc", and a tenant that writes "Amat" does not.
  const hit = mine.some((m) => m === who
    || (m.length >= 5 && who.startsWith(`${m} `))
    || (who.length >= 5 && m.startsWith(`${who} `)));
  return hit ? 'Yes' : null;
}

/** The top of every language ladder met so far, most specific first. */
export const HIGHEST_PROFICIENCY = ['Native or Bilingual', 'Native', 'Fluent', 'Full Professional', 'Advanced', 'Expert', 'Proficient'];

/**
 * "Share links to your GitHub, portfolio or publications" — a request for URLs,
 * however large the box is, and so NOT a written question.
 *
 * Anchored on the ask: an imperative verb reaching a link noun, or "links to"
 * reaching a link kind. Both halves need the word link or URL to be present,
 * because the thing that makes this a links field is that it asked for links —
 * not that it mentioned GitHub.
 *
 * Lives in this file rather than essay.mjs because this is the leaf module
 * every ATS adapter already imports, and essay.mjs pulls in the whole
 * model stack behind it. essay.mjs imports it from here.
 */
export const LINKS_BOX_RE = new RegExp(
  // "Please share links to…" — an imperative reaching the PLURAL.
  '(share|provide|list|include|paste|enter|add|attach|drop)[^?.;]{0,40}\\b(links|urls)\\b'
  // "Links to your portfolio or personal website" — the plural, reaching a kind.
  + '|\\b(links|urls)\\s+to\\s+[^?.;]{0,70}\\b(github|portfolio|website|site|project|publication|profile|work|repo)'
  // Singular, but offering a LIST of kinds: "a link to your GitHub, portfolio,
  // or publications". Two kinds separated by a comma or "or" is what makes it
  // a box for several links rather than a field for one.
  + '|\\b(link|url)s?\\b[^?.;]{0,50}\\b(github|portfolio|website|publication|project|repo)\\b[^?.;]{0,30}(,|\\bor\\b)[^?.;]{0,40}'
  + '\\b(github|portfolio|website|publication|project|repo|hardware|personal)\\b',
  'i');

const RULES = [
  // identity
  // A preferred FIRST name is the first word of what he goes by, not of his
  // legal name — "Alex", not "Anna Maria Alex". Must sit above the plain first-name
  // rule, which would otherwise claim it.
  { re: /preferred\s*(first|given)\s*name|(first|given)\s*name\s*\(preferred\)|goes\s+by/i,
    get: p => (p.identity?.preferred_full_name || '').trim().split(/\s+/)[0] || p.identity?.first_name },
  // HE HAS NO MIDDLE NAME, and that is an answer rather than a gap.
  //
  // Seen twice in the ledger as "Legal Middle Name" (Workday) and "Middle Name"
  // (TSMC), both counted as questions nobody could answer. His passport reads
  // "Anna Maria Alex Rivera" — "Anna Maria Alex" is the given name and "Rivera" the surname,
  // which is exactly how `first_name` / `last_name` are split in his profile.
  // Splitting "Gia" out as a middle name would make the form disagree with his
  // documents, and an I-9 mismatch is a real problem. Confirmed with him
  // 2026-09-20.
  //
  // Above the first-name rule on purpose: "Middle Name" contains neither
  // "first" nor "last", but "Legal Middle Name" is one tenant rewording away
  // from something that does.
  { re: /middle\s*(name|initial)|\bm\.?i\.?\s*$/i, blank: true,
    why: 'he has no middle name — his legal name is "Anna Maria Alex Rivera", given name "Anna Maria Alex", surname "Rivera"' },
  { re: /first\s*name|^\s*given\s*name\s*\*?\s*$/i, get: p => p.identity?.first_name },
  { re: /last\s*name|family\s*name|surname/i, get: p => p.identity?.last_name },
  // "Salutation" as a name prefix. `Mr.` agrees with the male selection already
  // in his EEO block, so a form cannot contradict itself.
  //
  // A BARE "TITLE" IS DELIBERATELY NOT MATCHED HERE. It was in the first draft
  // of this rule and is a trap: the ledger shows `* Title` arriving beside
  // `* Company Name`, `From Date` and `* Reason for Leaving` — a Workday
  // employment-history row, where "Title" means his JOB title. Answering that
  // "Mr." would put a courtesy title in an employment record. A salutation
  // dropdown announces itself with the word Salutation or Prefix; when it
  // really is only called "Title", the option list (Mr./Ms./Dr.) is what gives
  // it away, and `chooseOption` handles that in the select branch.
  { re: /\bsalutation\b|name\s*prefix|^\s*prefix\b|courtesy\s*title/i,
    not: /job|position|current|previous|prior|most\s*recent|employer|company|degree|thesis|publication|manager|supervisor|reference|phone|country|dial/i,
    get: p => p.identity?.salutation },
  // "Preferred name" is asking what he GOES BY, and his profile answers it
  // directly — `preferred_full_name: "Alex Rivera"` next to `full_name: "Anna Maria
  // Alex Rivera"`. This rule used to hand back the legal name for both, so a form
  // that deliberately asks both questions got the same answer twice and the
  // one field where "Alex Rivera" belongs never saw it.
  // "I HAVE A PREFERRED NAME" IS A YES/NO, not a place to put the name.
  //
  // Applied Materials' Eightfold form asks it as a checkbox, and the rule
  // below handed back "Alex Rivera" — which is not "yes", so the box was left
  // unticked and the preferred-name fields it reveals never appeared (audit,
  // 2026-09-07). He does have one: `preferred_full_name` differs from
  // `full_name`. Must sit above the rule that returns the name itself.
  { re: /^\s*i\s+have\s+a\s+preferred\s+name|do\s+you\s+(have|go\s+by)\s+a\s+preferred\s+name/i,
    get: (p) => {
      const pref = String(p.identity?.preferred_full_name || '').trim();
      const legal = String(p.identity?.full_name || '').trim();
      return pref && pref !== legal ? 'Yes' : 'No';
    } },
  { re: /preferred\s*(full\s*)?name/i, get: p => p.identity?.preferred_full_name || p.identity?.full_name },
  { re: /full\s*name|legal\s*name|^name$/i, get: p => p.identity?.full_name },
  // "Are you BONDED BY your current company/scholarship?" is a yes/no about a
  // legal obligation, not a request for the employer's name — but it contains
  // "current company", so this rule answered it **"State University —
  // Manufacturing Lead (student)"** on a live Micron form. A nonsense answer to
  // a question about whether he is contractually tied to someone.
  // HIS CURRENT JOB TITLE. Above the current-company rule, which would
  // otherwise claim "Current Title" through the word "current" and answer it
  // "State University — Manufacturing Lead (student)" — an employer where a
  // title belongs. His answer, 2026-09-20: the title alone.
  { re: /current\s+(job\s*)?title|present\s+(job\s*)?title|current\s+position\s*(title)?|your\s+title\s+(at|with)\b/i,
    not: /\bbonded\b|restrict|non-?compete|\bobligat/i,
    get: p => p.answers?.current_title },
  // "HOW MANY EMPLOYEES DOES YOUR CURRENT COMPANY HAVE?" is a number, and this
  // rule answered it **"State University — Manufacturing Lead (student)"**
  // (found 2026-09-20 while probing the new rules, F-531). Same shape as the
  // bonded-by guard below it: the phrase "current company" appears inside a
  // question about something else entirely. His profile does not record
  // headcounts, so the honest answer is nothing.
  { re: /current\s+(company|employer)|present\s+employer/i,
    get: p => p.answers?.current_company,
    not: /\bbonded\b|\bagreement\b|restrict|non-?compete|\bobligat|\bhow\s+(many|large|big)\b|number\s+of\s+(employees|people|staff)|headcount|\bsize\s+of\b|revenue|industry|\bwhy\b|how\s+long/i },
  // A COMMUNICATION-PREFERENCE QUESTION IS NOT A REQUEST FOR HIS ADDRESS.
  //
  // Xaira's Greenhouse form (live 2026-09-20, three separate plans of the same
  // page) asked "Would you like to receive communications via SMS to the number
  // provided above? If you select no, we will only communicate with you via
  // email and/or telephone calls." The rule below is a bare /e-?mail/, the word
  // "email" is in the second sentence, and his EMAIL ADDRESS was planned into a
  // Yes/No dropdown — twice over an answer already committed as "Yes".
  //
  // Answered before it, not merely blocked: his standing instruction is yes to
  // consent, and being reachable by an employer he has applied to is in his
  // favour. Review-flagged without exception, like every other consent.
  { re: /would\s+you\s+like\s+to\s+receive|receive\s+(communications?|updates?|notifications?|texts?|text\s+messages?)|\bsms\b|text\s+message\s+(updates?|alerts?|communications?)/i,
    get: p => p.answers?.communication_optin ?? 'Yes', review: true },
  // …and the address rule now says what it is not. The guard is the question
  // forms, not the word: "Email", "Email Address" and "Confirm Email" are
  // untouched.
  { re: /e-?mail/i,
    not: /would\s+you\s+like|receive\s+(communications?|updates?|notifications?|texts?)|\bsms\b|text\s+messages?|opt[\s-]?in|unsubscribe|marketing/i,
    get: p => p.identity?.email },
  // Phone TYPE before phone NUMBER — /phone/ matched "Contact Phone Type" on
  // the live Tesla form and fed it the number, so a dropdown offering
  // Mobile/Landline was asked to match "+1 (555) 000-0000". Routed here it is
  // reported as a missing profile key instead, which names the one line he
  // would add. The engine never guesses which kind of phone he owns.
  // Workday's field is literally "Phone Device Type", which /phone\s*type/
  // never matched because of the word between them — so it fell through to the
  // number rule and offered "+1 (555) 000-0000" to a Mobile/Home/Work dropdown.
  { re: /phone\s*(device\s*)?(type|kind)|device\s*type|type\s+of\s+phone|contact\s+(phone\s+)?type/i,
    get: p => p.answers?.phone_type },
  // COUNTRY PHONE CODE IS NOT A PHONE NUMBER, and the rule below matches on the
  // bare word "phone". Measured against his real profile: "Country Phone Code"
  // was answered **"+1 (555) 000-0000"** — his whole number typed into a field
  // asking which country he dials from. On Workday that is a prompt and the
  // search finds nothing; on a plain text field it simply writes the number.
  //
  // The answer is his country, because these are almost always dropdowns
  // reading "United States of America (+1)" and matching on the country name is
  // what selects one. It is not a derivation either — his own number begins
  // "+1", so the country code is a fact already in the profile twice over.
  // …but an INSTRUCTION to include the country code is still the number field.
  // "Phone Number (include country code)" matched the rule above and answered
  // **"United States of America"** — a country name typed into a phone box. A
  // wrong value, not a blank, on a field a recruiter dials.
  //
  // The discriminator is grammatical, not lexical: "country code" as the NOUN
  // of the field is a country-code field, while "…include country code" or
  // "Number (country code)" is a phone field telling him how to format it.
  { re: /(country|dial(l?ing)?|calling|international)\s*(phone\s*)?code|phone\s*(country|dial(l?ing)?|calling)\s*code/i,
    not: /\b(includ\w*|with|enter|provide|add|prefix\w* by)\s+(the\s+|your\s+)?(country|dial|calling|international)|numb\w*\s*[-–(]\s*[^)]*\bcode/i,
    get: p => p.identity?.country },
  // `contact number` is a phone by another name. Guarded against
  // "emergency contact number", which is somebody else's (F-285).
  { re: /phone|mobile|contact\s*number/i, get: p => p.identity?.phone,
    not: /emergency|next\s+of\kin|guardian/i },
  // A time zone is a fact about where he lives, not a preference. Measured on
  // a live Veeva form: a REQUIRED radio group [AST, EST, CST, MST, PST, Other]
  // went unanswered although his state settles it.
  { re: /time\s*zone/i, get: p => timezoneFor(p) },
  // "Are you referred to this job by a Micron employee?" — measured on a live
  // Eightfold form. No rule matched, so it reported as a dropdown we have no
  // answer for. The rule is here pointing at a key his profile does not have
  // yet: the moment he adds `employee_referral: "No"` it answers itself, and
  // until then it is honestly reported as needing him. Inventing "No" would be
  // stating a fact about how he found the job that he never told us.
  { re: /referred\s+(to\s+this\s+job\s+)?by\s+(a|an)\s+[\w.\- ]{0,24}employee|employee\s+referral|were\s+you\s+referred/i,
    get: p => p.answers?.employee_referral },
  // NOBODY REFERRED HIM, AND HE HAS NO EMPLOYEE ID. Two questions the ledger
  // carried as unanswerable, which they are — but permanently, so they are
  // noise there rather than work. His answer, 2026-09-20: blank forever, stop
  // asking.
  //
  // An employee ID only exists for a CURRENT employee of the company reading
  // the form; every one that asks says "if applicable" for exactly that reason.
  // A referrer name only exists if a person referred him, and the follow-up
  // above already answers whether one did.
  //
  // These stay blanks rather than answers because writing "N/A" into a referral
  // field reads as a claim that something was considered; nothing is truer than
  // an empty box here.
  { re: /name\s+of\s+referr(er|al)|referr(er|ing)\s+(employee\s+)?(name|person)|who\s+referred\s+you/i,
    blank: true, why: 'no referral for this posting — nobody referred him, so there is no name to give' },
  // THE CERTIFICATION TABLE STAYS EMPTY, by his decision 2026-09-20: "Fill the
  // Skills table but not Certifications." Certifications are optional on nearly
  // every form that has one, and the table wants an issuing body, a number and
  // three dates per row that his profile does not carry.
  //
  // This is a blank rather than an unknown so the five date boxes beside it
  // stop arriving in his ledger every time a profile-builder form is planned.
  // The SKILLS table is filled — planForm owns that, and it is a different
  // block on the same page.
  { re: /^(certification|licen[cs]e)s?\b|\b(certification|licen[cs]e)\s*(name|title|number|body|authority|issuer)\b|date\s*acquired|(effective|expiration|expiry)\s*date|issuing\s*(body|authority|organi[sz]ation)/i,
    not: /work\s*authoriz|visa|security\s*clearance|driver'?s?\s*licen[cs]e\s*(number|state)/i,
    blank: true,
    why: 'he does not list certifications on applications — the Skills table is filled instead' },
  { re: /employee\s*(id|number|#)|\bassociate\s*(id|number)\b|badge\s*(id|number)|worker\s*id/i,
    not: /\bhow\s+many\b|number\s+of\s+employees|headcount/i,
    blank: true, why: 'he has never worked for this company, so he has no employee ID there' },

  // "Do you have an agreement with a current or former employer that may
  // restrict your ability to accept this offer?" — a non-compete or a
  // scholarship bond. Measured unanswered on live Torc Robotics and Micron
  // forms; both ask it, and one makes it required.
  //
  // Like the referral rule above, this points at a key his profile does not
  // have yet, so it answers itself the moment he adds one line. It is a
  // question about a legal obligation, and inventing "No" on his behalf is
  // exactly the kind of claim that must come from him.
  { re: /agreement\s+between\s+you\s+and\s+(your\s+)?(any\s+)?(current|former|previous|other)|non-?compete|restrictive\s+covenant|\bbonded\s+by\b|signed\s+an?\s+agreement\s+with\s+any\s+(current\s+|former\s+)?employer|engage\s+in\s+competition|patent\s+obligations/i,
    get: p => p.answers?.employer_agreement, review: true },
  // ABB's Workday questionnaire, 2026-09-24 — all left for him that night, and
  // answered by him on the form; those answers are now in his profile.
  { re: /perform\s+the\s+essential\s+functions/i, get: p => p.answers?.essential_functions },
  { re: /(contacted|contact\s+you|hear\s+from\s+us)\b.{0,40}\bfuture\s+(job\s+)?(opportunit|openings|roles|positions)|future\s+(job\s+)?opportunit.{0,40}\b(contact|reach)/i,
    get: p => p.answers?.future_contact },
  { re: /\bnotice\s+period\b/i, get: p => p.answers?.notice_period },
  // The conditional opening ("If you are under 18 years of age, …") is trimmed
  // before rules run, so the bare "do you have a work permit" must match too.
  { re: /\bunder\s+(the\s+age\s+of\s+)?18\b.{0,80}\b(work\s+permit|working\s+papers|permit)|\bdo\s+you\s+have\s+a\s+work\s+permit\b|\bworking\s+papers\b/i,
    not: /\bvisa\b|immigration|sponsor|\bead\b|employment\s+authori[sz]ation\s+document/i,
    get: p => (p.answers?.under_18_permit ? [p.answers.under_18_permit, 'Yes / Not Applicable', 'N/A', 'Not applicable'] : undefined) },
  // "SHARE LINKS TO GITHUB, PORTFOLIO, PUBLICATIONS OR HARDWARE PROJECTS" — a
  // request for URLs, plural, and it gets URLs. Seen on live 1X Technologies
  // and Atomic Semi forms, where it is a <textarea> and used to be handed to
  // the long-form writer because it contains the word "share" (F-532).
  //
  // Above the single-link rules, which would each answer with only one of the
  // two and quietly drop the other. `\n` rather than a comma: these boxes are
  // multi-line, and a recruiter clicks a link on its own line.
  { re: LINKS_BOX_RE,
    get: (p) => {
      const links = [p.identity?.portfolio || p.identity?.website, p.identity?.linkedin]
        .map((v) => String(v ?? '').trim()).filter(Boolean);
      return links.length ? [...new Set(links)].join('\n') : undefined;
    },
    ask: 'identity.portfolio' },
  { re: /linkedin/i, get: p => p.identity?.linkedin },
  // HE HAS NO GITHUB, so a GitHub box gets the portfolio. His answer,
  // 2026-09-20: "No GitHub — use the portfolio for every link field." The
  // question a GitHub field is really asking is "where can we see your work",
  // and alexrivera.example is the answer to it. Leaving it empty answered a
  // question nobody asked; `github: ""` alone made this read "your profile
  // leaves this blank", which sent an answerable field to the ledger.
  { re: /github|\bgit\s*hub\b|source\s*(code)?\s*(repo|repository)|\brepo(sitory)?\s*(link|url)\b|(link|url)\s*to\s*(your\s*)?\brepo(sitory)?\b/i,
    get: p => p.identity?.github || p.identity?.portfolio || p.identity?.website },
  // SOCIAL MEDIA HE DOES NOT USE FOR WORK. Intuitive Surgical asks for both by
  // name; they are optional on every form that has ever asked. His answer,
  // 2026-09-20: leave them permanently blank and stop flagging them. LinkedIn
  // and the portfolio are handled above and are the two that matter.
  //
  // `\bx\b` would be reckless on its own — it appears inside ordinary prose —
  // so the X rule is anchored to the whole label or to the form's own
  // disambiguation, "(fka Twitter)".
  { re: /\bfacebook\b|\binstagram\b|\btiktok\b|\bsnapchat\b|\bthreads\b|\bmastodon\b|\btwitter\b|^\s*x\s*(\(\s*fka[^)]*\))?\s*$/i,
    not: /why|describe|tell\s+us|how\s+did\s+you\s+(hear|learn|find)/i,
    blank: true,
    why: 'he does not put personal social media on applications — LinkedIn and alexrivera.example are the links he wants read' },
  // A LINK FIELD THAT SAYS "PROFILE" RATHER THAN "PORTFOLIO".
  //
  // Tesla's form asks "Profile Link" and "Profile Link Type", and neither word
  // is website, portfolio or personal site — so both went unanswered, twice
  // each, and sat at the top of the untackled list. Alex, 2026-09-19: *"if page
  // asks for portfolio or profile, put in alexrivera.example"*.
  //
  // The TYPE rule sits first: "Profile Link Type" contains "profile link", so
  // the URL rule would otherwise claim it and put an address in a dropdown of
  // [Portfolio, LinkedIn, Indeed, Other].
  { re: /(profile|portfolio|website|personal\s*site)\s*(link|url)?\s*type\b|type\s*of\s*(profile|link)\b/i,
    get: () => 'Portfolio' },
  // …and the ADDRESS rule never answers a question about the link rather than
  // for it. His `website` key was empty until 2026-09-19, so "Do you have a
  // portfolio password we should know?" returned unknown by luck; the moment
  // the key was filled in, it returned the URL. A credential question is never
  // answered here under any circumstances.
  // "HOW DID YOU HEAR ABOUT US" IS NOT A REQUEST FOR HIS WEBSITE.
  //
  // Field AI's Lever form (live 2026-09-20) came through as "How did you learn
  // about this opportunity?✱ — FieldAI Website" — the first OPTION's text
  // riding along on the label — and the word "Website" brought it here, 370
  // lines above the rule that owns this question. It came back
  // `no option matches "alexrivera.example"` on a REQUIRED field, with
  // `how_heard: "LinkedIn"` in his profile and "LinkedIn" on the menu.
  //
  // Guarded on the question rather than on the stray word: the option text can
  // say anything, and the thing that makes this not-his-website is that it asks
  // how he heard.
  { re: /website|portfolio|personal\s*site|profile\s*(link|url)|\b(link|url)\s*to\s*(your\s*)?(profile|portfolio|site|website)\b/i,
    not: /\bpassword|\bpasscode|\bcredential|\blogin\b|\busername\b|\bprotected\b|^\s*(do|does|is|are|have|has|can|will)\s+you(r)?\b|(how|where)\s+did\s+you\s+(\w+\s+)?(hear|learn|find)|referral\s+source/i,
    get: p => p.identity?.website },
  // AN EXTRA LINK BOX THAT NEVER SAYS "WEBSITE" (F-553, 2026-09-24): "does not
  // input portfolio link in additional website section". "Additional URL",
  // "Other Link", "Personal URL", "Web Address", and a bare "URL" (Workday's
  // Websites panel) are all a place for a link, and his rule since 2026-09-20
  // is the portfolio for every link field that is not LinkedIn.
  // "If your portfolio is a website, please share a link below." (Lexington,
  // 2026-09-24) went to the essay writer; the conditional is dropped before
  // rules run, and "please share a link below" is a request for his link.
  { re: /^\s*(please\s+)?(share|provide|include|paste|enter|add)\s+(a\s+|the\s+|your\s+)?(link|url)\b/i,
    not: /linked\s*in|twitter|facebook|instagram|github\s+only|reference|video|recording/i,
    get: p => p.identity?.portfolio || p.identity?.website },
  { re: /^\s*(additional|other|personal|another)\s+(urls?|links?)\b|\bweb\s*address\b|^\s*urls?\s*\*?\s*$/i,
    not: /linked\s*in|twitter|facebook|instagram|\bx\.com\b/i,
    get: p => p.identity?.portfolio || p.identity?.website },
  // "where…located" must be about the CANDIDATE. The old /where.*(located|based)/
  // matched "…work in the country where this position is located?" and answered a
  // work-authorization question with "Springfield, Washington".
  { re: /current\s*(location|city)|^location\b.{0,20}$|city\s*&?\s*state|where\s+(are|do)\s+you\s+(currently\s+)?(located|based|live|reside)/i,
    get: p => p.identity?.location },
  // "What is the address from which you plan on working? If you would need to
  // relocate, please type 'relocating'" (Anthropic, F-348): his location is
  // the honest answer; whether he would relocate is a separate stated answer
  // and is not folded in here.
  { re: /address\s+from\s+which\s+you\s+(?:plan|intend|expect)\s+(?:on|to)\s+work|(?:where|what\s+address)\s+.{0,30}(?:plan|intend)\s+(?:on|to)\s+work(?:ing)?\s+from/i,
    get: p => p.identity?.location },
  // Address fields carry SHORT labels ("Country", "Country of Residence",
  // "State/Province"). Anchoring to a short label keeps them from matching the
  // word mid-sentence: "...in the country to which you have applied" and
  // "...an employee of a U.S. federal, state, or local government?" both did,
  // and answered those questions with a country and a US state.
  // COUNTRY OF CITIZENSHIP IS NOT COUNTRY OF RESIDENCE, and answering the first
  // with the second is the worst thing this table has ever done.
  //
  // "Country of Citizenship" is 24 characters, so `^country\b.{0,26}$` matched it
  // and filled "United States of America" — silently, because the address rule
  // is not review-flagged. He is a Canadian citizen on an F-1 visa. The form
  // then carried a false claim of US citizenship on the same page as our own
  // `citizenship_status` answer saying "Non-U.S. citizen", and he would never
  // have seen it to catch it.
  //
  // This guard has no `get`, so it resolves to unknown — left blank and
  // REPORTED, which is this engine's default for a question it cannot answer.
  // Residence is deliberately absent from the list: he does live in the US, and
  // "Country of Residence" is answered correctly today.
  //
  // 2026-09-04: the answer now EXISTS. `answers.citizenship_country` is his
  // country of citizenship (from config/profile.yml), so the export-control
  // prompt every Eightfold tenant asks — "please provide your most recent
  // country/region of citizenship or legal permanent residence" on Lam,
  // Micron and Applied Materials — is answered with it, review-flagged.
  // Birth and origin are still not assumed to be the same thing.
  { re: /country\s*(\/|-|\s+or\s+)?\s*(region\s+)?(of\s+)?(citizenship|citizen|nationalit|passport)(?!\s*status)/i,
    get: p => p.answers?.citizenship_country, review: true },
  { re: /^country\s*(\/|-|\s+or\s+)?\s*(of\s+|region\s+of\s+)?(birth|origin)/i,
    get: () => undefined },
  { re: /(citizenship|nationality)\s*(country)?$/i, get: p => p.answers?.citizenship_country, review: true },
  { re: /^country\b.{0,26}$/i, get: p => p.identity?.country },
  { re: /^(state|province)\b.{0,24}$|^state\s*\/\s*province\b/i, get: p => p.identity?.state },

  // education
  //
  // A GPA QUESTION NAMES WHERE THE GPA CAME FROM, AND THAT PHRASE USED TO WIN.
  //
  // Measured on the live TSMC SuccessFactors form (2026-09-19): "What is your
  // exact GPA of your highest degree?" was filled **"Bachelor's"**, because
  // `highest.*(level|degree)` sits above the GPA rule and this table is
  // first-match-wins. The same shape three more times over, all latent until a
  // form words it that way: "GPA in your major" → "Mechanical Engineering",
  // "GPA at your university" → "Test University", "GPA of highest degree
  // earned" → "Bachelor's". Every one of them reports as filled.
  //
  // `\bgpa\b` and "grade point" are as specific as this table gets — no other
  // question contains either word — so the rule belongs ABOVE the qualifiers it
  // keeps losing to, not below them. The `not:` keeps the questions that ask
  // WHETHER rather than WHAT ("may we verify your GPA?") off the number.
  // `gpas?` — TSMC's radio group is labelled "The GPAs of all my degree are
  // between 3.3- 4.0", and `\bgpa\b` does not match the plural, so a required
  // field resolved to nothing.
  { re: /\bgpas?\b|grade\s*point/i,
    not: /^\s*(are|do|did|does|will|would|have|has|is|was|may|can|would)\s+(you|we|your)\b|\b(verify|verification|consent|transcript\s+(upload|attach))\b/i,
    get: p => p.education?.gpa },
  // THE NAME OF HIS SCHOOL, NOT EVERY QUESTION WITH "SCHOOL" IN IT.
  //
  // Measured on the live Applied Materials Workday form (2026-09-07): "Are you
  // in school?" — a Yes/No dropdown — was answered **"State University"**,
  // because this rule sits above the campus-recruiting rules and matches first.
  // The same shape as the `\bopt\b` and bare `/major/` bugs already recorded
  // here: a broad word, a question it does not belong to, a false answer on a
  // real form. Anything that ASKS ABOUT school rather than asking WHICH school
  // is left to the rules written for it.
  { re: /school|university|college|institution|where\s+(did|do)\s+you\s+study/i,
    // `would` was the missing auxiliary, and it cost a real answer on Amazon's
    // form: "…would you require CPT authorization FROM YOUR SCHOOL…" was
    // answered **"State University"** — the exact failure this guard was
    // written to stop, one verb short. `from your school` is named outright
    // too, because there the school is the SOURCE of an authorization, never
    // the thing being asked for.
    not: /^\s*are\s+you\b|^\s*(do|did|will|would|should|could|can|have|is|was)\s+you|^\s*which\b|\bfrom\s+(your|the)\s+school\b|\bstill\s+(in|attending)\b|\bcurrently\s+(enrolled|attending|a\s+student)\b|\b(status|term|semester|quarter|year)\b|\bgraduat/i,
    get: p => p.education?.school },
  { re: /highest.*(level|degree)|education\s+(level|completed)|level\s+of\s+education|what\s+degree\s+(are\s+you\s+)?(pursu|seek|work)/i, get: p => p.education?.degree_level },
  { re: /degree\s*(type|level)?$/i, get: p => p.education?.degree },
  // "major" must be about study. The disability question asks about "your major
  // life activities", and a bare /major/ fed "Mechanical Engineering" into it —
  // same class of bug as \bopt\b matching "opt out". Keep the negative lookahead.
  { re: /discipline|field\s*of\s*study|area\s*of\s*study|course\s*of\s*study|\bmajors?\b(?!\s*life)/i,
    get: p => p.education?.discipline },
  // A GRADUATION DATE SPLIT ACROSS TWO CONTROLS.
  //
  // His profile holds one string, "May 2027". A form offering separate Month
  // and Year dropdowns was handed that whole string for each, matched neither
  // option list, and left both blank — on a required field, for a new grad,
  // where the date is the single most load-bearing fact on the application.
  //
  // These must sit above the general rule below, which matches "Graduation
  // Year" on `.*(date|year)` and would claim it first.
  { re: /graduat\w*\s*(month)|month\s*(of\s*)?graduat/i, get: p => gradPart(p, 'month') },
  // `what year do you graduate` is spelled out rather than folded into the
  // pattern before it: loosening `year\s*(of\s*)?graduat` to span words
  // would also catch "how many years since graduation", which wants a
  // NUMBER OF YEARS and would get "2027" (F-284).
  { re: /graduat\w*\s*(year)|year\s*(of\s*)?graduat|class\s*(of|year)|what\s+year\s+(do|will)\s+you\s+graduat/i, get: p => gradPart(p, 'year') },
  // A DATE, unless the form asked for a TERM — "Spring 2027" and "May 2027"
  // are different answers to differently worded questions, and the campus rule
  // further down owns the second one.
  { re: /graduat(e|ion).*(date|year)|expected.*graduat|when.*graduat/i,
    not: /\b(term|semester|quarter|season)\b/i,
    get: p => p.education?.graduation },

  // ── IMMIGRATION HISTORY, not immigration status ──────────────────
  //
  // Amazon's form asked nine of these in one screen (2026-09-20) and every one
  // was left for him. The profile knew what he IS — F-1, needs sponsorship —
  // and nothing about what he HAS BEEN, so there was no key to match against
  // and no rule looking for one. They are facts with fixed answers, which is
  // exactly what this table is for.
  //
  // ABOVE the general work-authorization rules deliberately. This table is
  // first-match-wins and several of these carry the words "authorization" and
  // "work" in a sentence that is not asking about his right to work at all.
  // NAMING A VISA IS NOT ASKING ABOUT IT.
  //
  // The first version of these matched a bare "H-1B" anywhere in the label,
  // and Jabil's sponsorship question lists the visas as examples — "…require
  // visa sponsorship … (for example H-1B, TN, L-1, etc.)". That is his single
  // most important screening question and it stopped being answered at all.
  // The same trap as the `\bopt\b` and bare `/major/` bugs recorded further
  // down this file.
  //
  // So the question has to be about HOLDING one: a verb of possession in front
  // of it, or a status/petition noun behind it. A visa named in a list of
  // examples matches neither.
  //
  // AND A SPONSORSHIP QUESTION IS NEVER A VISA-HISTORY QUESTION (F-549). The
  // most common wording on any form — "Will you now or in the future require
  // sponsorship for employment visa status (e.g. H-1B visa status)?" — carries
  // "H-1B visa status" as its EXAMPLE, which the status clause below matched.
  // Intuitive Surgical, 2026-09-24: answered with `held_h1b` → "No", i.e. "I
  // will not require sponsorship". He is on F-1 and will. `not` sends any
  // question about REQUIRING or NEEDING sponsorship to the sponsorship rule.
  { re: /\b(held|hold|holding|have\s+you\s+ever\s+had|had)\b[^?.;]{0,40}\bh-?1b\b|\bh-?1b\b[^?.;]{0,30}\b(status|petition|visa\s+holder|cap[\s-]*exempt)\b/i,
    not: /\bsponsor/i,
    get: p => p.answers?.held_h1b, review: true },
  { re: /\b(held|hold|holding|have\s+you\s+ever\s+had|had)\b[^?.;]{0,40}\bj-?1\b|\bj-?1\b[^?.;]{0,30}\bstatus\b|\bexchange\s+visitor\b/i,
    not: /\bsponsor/i,
    get: p => p.answers?.held_j1, review: true },
  // "Curricular Practical Training" — the school-authorised route an F-1 uses
  // BEFORE graduating. He is pursuing post-graduation roles only, so the
  // answer is No and OPT is the route. Matched ahead of the work-auth block
  // because the question says "authorization … to be able to work".
  { re: /curricular\s+practic\w*\s+training|\bcpt\b/i, get: p => p.answers?.requires_cpt, review: true },
  // Physical presence abroad. Asked for background-check scoping, not status.
  { re: /(lived|resided|physically\s+located)[^?.;]{0,60}outside[^?.;]{0,40}(us|u\.s\.|united\s+states)|outside\s+of\s+the\s+(us|u\.s\.|united\s+states)[^?.;]{0,40}consecutive\s+months/i,
    get: p => p.answers?.outside_us_12_months, review: true },
  // "Since obtaining your most recent citizenship, did you afterwards become a
  // permanent resident in any other country?" — Amazon, and the one question
  // from the 2026-09-20 audit that could not be answered from any file. He
  // answered it himself: No. Canadian citizen, never granted permanent
  // residency anywhere; F-1 is a temporary student status, not permanent
  // residence.
  //
  // Review-flagged like every other visa-history answer. Guarded against the
  // far more common "are you a permanent resident of the US?", which is a
  // status question the work-authorization rules below own.
  { re: /(became?|become|obtain\w*|grant\w*|acquir\w*|hold|held)[^?.;]{0,50}permanent\s+resident\w*[^?.;]{0,40}(any\s+other|another|other)\s+countr|permanent\s+resident\w*\s+(in|of)\s+(any\s+other|another)\s+countr/i,
    get: p => p.answers?.permanent_resident_elsewhere, review: true },
  // A STEM degree is a fact about his major, and the profile already states it
  // twice over (field_of_study, stem_opt_extension_eligible).
  // Review-flagged like every other work-authorization answer: the commonest
  // form of this question attaches the STEM fact to a claim about the 24-month
  // OPT extension, and that is his status, not just his major.
  // STANDS ASIDE for the OPT-extension rule further down, which is the more
  // specific question and reads a different key. This table is first-match-wins
  // and the bare STEM pattern was swallowing "Are you eligible for a 24-month
  // OPT extension based upon a US degree in STEM?" on its way past.
  { re: /\bstem\b[^?.;]{0,30}(field|degree|major|discipline)|degree[^?.;]{0,20}\bstem\b/i,
    not: /\bextension\b|\bopt\b|24[\s-]*month/i,
    get: p => p.answers?.stem_degree, review: true },
  // Non-compete. CERT_NOT_RE already vetoes this phrasing as a consent box so
  // it is never ticked blind; this gives it the real answer.
  { re: /non-?compet(e|ition)|restrictive\s+covenant/i, get: p => p.answers?.non_compete, review: true },
  // "Would you be legally eligible to BEGIN EMPLOYMENT IMMEDIATELY?" is not
  // "are you authorized to work" — it asks whether he could start the day the
  // offer lands, and on F-1 he could not: OPT/EAD takes about 90 days. His
  // call, 2026-09-20, to answer it literally.
  { re: /eligible\s+to\s+begin\s+(employment|work)|begin\s+employment\s+immediately|start\s+work\s+immediately/i,
    get: p => p.answers?.eligible_to_begin_immediately, review: true },

  // work authorization — always review-flagged

  // "…WITHOUT SPONSORSHIP" IS THE OPPOSITE QUESTION, and we were answering "Yes".
  //
  // "Are you legally authorized to work in the United States without
  // sponsorship?" contains "authorized to work", so the rule below matched it and
  // returned his `authorized_to_work_us` — "Yes". He needs sponsorship. The
  // truthful answer is No, and this is the single most common screening question
  // on Greenhouse, Lever and Workday, and the one recruiters filter the pile on.
  //
  // It must sit ABOVE the general rule: this table is first-match-wins, and the
  // general rule swallows the negation otherwise. No `get` yet, so it resolves to
  // unknown — blank and reported, which is honest — until he adds the key.
  //
  // DERIVED FROM WHAT HE HAS ALREADY SAID when the key is absent (F-335):
  // "authorized without sponsorship" is the conjunction of his two stated
  // answers. Requires sponsorship → No, whatever his authorization today;
  // needs none → his authorization answer. Nothing here is a new claim about
  // him, and it stays review-flagged. Left blank only when neither is known.
  { re: /\b(without|not\s+(?:require|requiring|need|needing))\b[^?.;]{0,50}?\bsponsor/i,
    get: p => p.answers?.authorized_without_sponsorship
      ?? (/^yes$/i.test(String(p.answers?.require_sponsorship || '')) ? 'No'
        : (/^no$/i.test(String(p.answers?.require_sponsorship || '')) ? p.answers?.authorized_to_work_us : undefined)),
    review: true },

  // A work-authorisation question about ANOTHER COUNTRY is not about the US.
  // "Are you legally authorized to work in Canada?" was answered "Yes" from his
  // US answer. He is not authorised to work in Canada, the UK, or anywhere else
  // this could name, and saying so on a form is a false claim about his status.
  //
  // THE EMPLOYER'S NAME SITS BETWEEN "work" AND "in", and that defeated the
  // guard entirely. Workday tenants name themselves in the question — Jabil's
  // live step asks "Are you currently authorized to work for Jabil in the
  // United States?" — so the same tenant asking about Canada would read
  // "authorized to work for Jabil in Canada", the literal "to work in" never
  // matched, and the rule below it answered **"Yes"**: a false claim of
  // Canadian work authorisation on a real application.
  //
  // `for <name>` is matched explicitly rather than "any few words", because a
  // loose window would also span "to work in the country where this position is
  // located" and turn his single most important screening question into a
  // blank. The two lookaheads still guard everything after "in".
  { re: /(authorized|eligible|legally\s+able|right)\s+to\s+work\s+(?:for\s+[\w.,&'’ -]{1,40}?\s+)?in\s+(?!the\s+(us|u\.s\.|united\s+states))(?!the\s+country)(canada|the\s+uk|the\s+united\s+kingdom|australia|india|germany|france|ireland|singapore|mexico|the\s+eu|the\s+european\s+union|japan|china)\b/i,
    get: () => undefined },

  // "unrestricted right to work" is Lever's house wording and contains none of
  // the words the rest of this rule looks for. Measured on a live Veeva form:
  // the sponsorship question beside it was answered and this one was not, which
  // is the worst possible half — an application that declares it needs
  // sponsorship and says nothing about being allowed to work at all.
  { re: /authorized\s+to\s+work|legally\s+(able|authorized)|work\s+authorization|eligible\s+to\s+work|(unrestricted|legal)\s+right\s+to\s+work|right\s+to\s+work\s+in/i,
    get: p => p.answers?.authorized_to_work_us, review: true },
  // NVIDIA asks this without the word "sponsorship": "Will you require employer
  // support to obtain or maintain authorization to work in that country?"
  { re: /sponsor(ship)?|require\s+employer\s+support|employer\s+support\s+to\s+(obtain|maintain)/i,
    get: p => p.answers?.require_sponsorship, review: true },
  // "Protected individual" (8 USC 1324b(a)(3)) is the export-control question in
  // Greenhouse's wording, and its answer set is "None of the above" rather than
  // Yes/No. He is an F-1 student, so none of the classifications apply.
  { re: /protected\s+individual/i, get: p => p.answers?.protected_individual, review: true },
  // A LABEL THAT NAMES AN EMBARGOED COUNTRY IS THE COUNTRY QUESTION, not the
  // generic "are you a U.S. person?" one, and it must be matched first.
  //
  // Torc Robotics writes it "U.S. Export Control Requirements - Are you a
  // citizen, national, or resident of any of the following countries/regions?"
  // with [Cuba, Iran, North Korea, Syria, Crimea…]. That contains "export
  // control", so the rule below claimed it and answered from `us_person`.
  //
  // Both are "No" for him today, so the answer came out right by coincidence —
  // which is exactly why it is worth fixing. He is not a U.S. person and not a
  // citizen of any of those countries; the day the first of those changes, this
  // would have ticked "Cuba".
  { re: /\b(cuba|iran|north\s*korea|syria|crimea|donetsk|luhansk)\b/i,
    get: p => p.answers?.restricted_country_citizen, review: true },
  // "export REGULATIONS", not just "export control" — Astranis writes it
  // "Astranis complies with U.S. Government space technology export
  // regulations, therefore will you state which of the following applies to
  // you:", a REQUIRED field that went unanswered over one word.
  { re: /u\.?s\.?\s+person|export\s+(control|regulation)|itar/i, get: p => p.answers?.us_person, review: true },
  { re: /security\s+clearance/i, get: p => p.answers?.security_clearance, review: true },
  { re: /visa\s+status|immigration\s+status/i, get: p => p.answers?.visa_status_note, review: true },
  // OPT specifics. These are separate questions with opposite answers for him —
  // not currently ON OPT (still pre-graduation), but IS eligible for the STEM
  // extension — so the STEM rule must be tested first or the generic OPT rule
  // would answer both with "No".
  { re: /stem\b.*\b(extension|opt)|24[\s-]*month/i, get: p => p.answers?.stem_opt_extension_eligible, review: true },
  // NEVER match a bare "opt": the AI-screening notice says "you can choose to opt
  // out", and \bopt\b matched it, so that question resolved to the OPT-status
  // answer ("No") and the form got "No, I opt-out" — the opposite of his consent.
  { re: /optional\s+practical\s+training|\bcpt\b|(?:period\s+of|currently\s+on|are\s+you\s+on|status\s+of)\s+opt\b/i,
    get: p => p.answers?.currently_on_opt, review: true },

  // screening
  { re: /citizenship\s+status/i, get: p => p.answers?.citizenship_status, review: true },
  // Allow any adjectives between: "years of relevant professional experience",
  // "years of hands-on engineering experience". The old fixed (relevant)?(work)?
  // pair missed anything worded differently.
  // A QUESTION THAT ASKS HIM TO EXPLAIN IS NOT ASKING FOR A NUMBER.
  //
  // Measured on a live Veeva form: "If you are a candidate with under 2 years
  // of experience, please briefly explain your training and relevant
  // coursework" contains "years of experience", so this rule answered it
  // **"2 years"** — which is nonsense in a box asking for prose, and the kind
  // of answer a human reader notices immediately.
  //
  // Surfaced only after the label fix above started reading these questions
  // correctly. A field we could not read could not be answered wrongly either;
  // reading it properly is what made the wrong answer reachable.
  { re: /years\s+of\s+(?:[\w-]+\s+){0,3}experience/i,
    get: p => p.answers?.years_relevant_experience, review: true,
    // AND NOT WHEN THE QUESTION NAMES AN INDUSTRY OR A TECHNOLOGY.
    //
    // Found by resolving every label from five live forms at once rather than
    // waiting to trip over them: Veeva asks "How many years of experience in
    // the SOFTWARE INDUSTRY do you have?" and this rule answered **"2 years"**.
    // His `years_relevant_experience` is his own field; he is a mechanical
    // engineer and has not worked in software. That is a false claim about a
    // domain, on the form of a software company, which is the audience most
    // able to check it.
    //
    // Refusing costs one flagged field. Answering costs the application, so a
    // qualified question is left to him even when the qualifier happens to be
    // his own field — this rule cannot tell the difference, and pretending it
    // can is how the wrong version of this gets shipped.
    not: /\b(explain|describe|tell us|elaborate|briefly|in your own words|why)\b|\bin\s+the\s+[a-z-]+\s+industry\b|\bexperience\s+(in|with)\s+(java|python|c\+\+|javascript|sql|sales|marketing|finance|nursing|teaching)\b/i },
  { re: /background\s+check|drug\s+screen|hiring\s+requirements|reference\s+check/i, get: p => p.answers?.background_check_consent, review: true },
  // Standing consents (Alex, 2026-07-29: "consent yes to everything"). AI-screening
  // notices are worded as an opt-OUT, so the consent answer must be Yes and the
  // opt-out left alone.
  { re: /artificial\s+intelligence|\bai\b.*(screen|match|assess)|automated\s+(decision|screening)/i,
    get: p => p.answers?.ai_screening_consent, review: true },
  // Anthropic's "AI Policy for Application" — an acknowledgement of a policy on
  // using AI in the application, asked as a dropdown (F-348). Same standing
  // consent.
  { re: /\bai\s+(usage\s+)?policy\b|use\s+of\s+(?:ai|generative\s+ai)\s+(?:in|for|during)\s+(?:the\s+|your\s+|this\s+)?application/i,
    get: p => p.answers?.ai_screening_consent, review: true },
  // An arbitration agreement is a consent box like the others (Alex, 2026-07-29:
  // "consent yes to everything"); `answers.arbitration_agreement` overrides.
  { re: /arbitrat/i, get: p => p.answers?.arbitration_agreement ?? 'Yes', review: true },
  { re: /consent.*(process|personal\s+data|data)|privacy\s+(notice|policy).*(agree|consent)|process.*personal\s+(data|information)/i,
    get: p => p.answers?.data_processing_consent, review: true },
  // Third-party / agency / contractor history — standing rule: always No.
  { re: /third[\s-]*part(y|ies)|through\s+an?\s+(agency|agencies)|staffing\s+agency|contract(or|ing)\s+(company|agency)|temp\s+agency/i,
    get: p => p.answers?.worked_via_agency },
  { re: /basic\s+(job\s+)?requirements|minimum\s+(qualifications|requirements)|meet.*requirements\s+listed/i,
    get: p => p.answers?.meets_basic_requirements },
  // "Are you open to working in-person in one of our offices 25% of the time?"
  // (Anthropic, F-348) is the on-site question in other words.
  { re: /(willing|able|open|comfortable).*\b(on-?site|in[- ]person|in\s+the\s+office|from\s+(?:an?\s+|the\s+)?office)\b|\b(on-?site|in[- ]person)\b.*(willing|able|open)/i, get: p => p.answers?.willing_onsite },

  // voluntary self-identification — filled from the user-provided eeo: section.
  // A missing key falls through to 'never' (left blank), so nothing is guessed.
  // "ARE YOU HISPANIC OR LATINO?" IS A DIFFERENT QUESTION FROM "RACE".
  //
  // Measured live on Ashby (Gecko Robotics, 2026-09-07): the race question is
  // labelled "Race — Hispanic or Latino" because its FIRST OPTION is Hispanic
  // or Latino, so this rule claimed it and answered "No" — which is not one of
  // the seven races on offer, and the question was left blank on a form where
  // his profile answers it ("Asian (Not Hispanic or Latino)"). A label that
  // names race is the race question, whatever its options say.
  //
  // …but "regardless of race" is not a race question (KLA, 2026-09-24): "Are
  // you Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South
  // or Central American, or other Spanish culture or origin regardless of
  // race?" went to the race rule and was answered "Asian". The label must
  // BE about race — start with it, or ask for his race — to be refused here.
  // A label that STARTS with "Ethnicity" is either list: the race list on some
  // forms, Hispanic yes/no on others. Both of his answers go, and the options
  // on the form decide which one is being asked.
  { re: /^\s*ethnicit/i, not: /^\s*ethnicity\s*(\/|and|&)\s*race\b/i, get: p => [p.eeo?.race, p.eeo?.hispanic].filter(Boolean), review: true },
  { re: /hispanic|latino/i, not: /^\s*race\b|\byour\s+race\b|\brace\s*(\/|and|&)\s*ethnicity\b|racial/i, get: p => p.eeo?.hispanic, review: true },
  // Workday asks "Please select your sex:" — not "gender".
  { re: /gender|\bsex\b/i, get: p => p.eeo?.gender, review: true },
  // "racial/ethnic background" matched neither \brace\b nor /ethnicit/.
  { re: /\brace\b|racial|ethnic/i, get: p => p.eeo?.race, review: true },
  // "Have you served in the armed forces?" is the same question as veteran
  // status, worded so that neither /veteran/ nor any EEO rule matched it. Found
  // by auditing this table against the ~55 field types a mature autofill
  // extension names in its own shipped config.
  { re: /veteran|armed\s+forces|military\s+service|served\s+in\s+the\s+(u\.?s\.?\s+)?(armed|military)/i,
    get: p => p.eeo?.veteran, review: true },
  { re: /disabilit/i, get: p => p.eeo?.disability, review: true },

  // logistics
  // "When can you start?" is how half of them word availability, and it matched
  // neither /start date/ nor /available to start/.
  { re: /start\s*date|availab\w*.*start|earliest.*(start|available)|notice\s*period|when\s+can\s+you\s+(start|begin)|earliest\s+date/i,
    get: p => p.answers?.earliest_start },
  // "WHICH locations are you open to relocating to?" is asking for PLACES.
  //
  // Measured on a live Veeva form: it contains "relocat", so this rule answered
  // it "Yes" — offered to a checkbox list of [Pleasanton CA, Kansas City MO,
  // Boston MA, …], which matches nothing and reports the useless
  // `no option matches "Yes"`. "Are you willing to relocate?" still answers.
  //
  // Fourth instance today of one shape: a rule matching a phrase while the
  // question asks something else. The others were "years of experience …please
  // explain", "export control" vs the embargoed-country list, and "U.S. person"
  // vs the same. Worth watching for as a class.
  { re: /relocat/i, get: p => p.answers?.willing_to_relocate,
    not: /\bwhich\b|\bwhat\b[^?]{0,40}\b(location|cit(y|ies)|office|site)s?\b|select all that apply/i },
  { re: /remote|on-?site|hybrid|work\s+model/i, get: p => p.answers?.remote_or_onsite },
  // "How did you FIRST hear about this job?" — one adverb dropped between "you"
  // and "hear", and the rule missed it, so a question his profile answers went
  // unanswered on a live Greenhouse form. Same shape as the phone-device-type
  // bug: a phrase matched too rigidly to survive a word being inserted into it.
  // `learn` was missing, and it is Lever's house wording: "How did you LEARN
  // about this opportunity?" matched none of these, fell through to the
  // website rule 370 lines above, and came back with his portfolio URL on a
  // required field (F-526). `hear about` / `find out` were the only two
  // spellings anyone had met.
  { re: /(how|where)\s+did\s+you\s+(\w+\s+)?(hear|find|learn)|how\s+did\s+you\s+find\s+out|referral\s+source|source\b/i,
    // BOTH answers, because this question comes in two shapes. Free text wants
    // "LinkedIn"; a fixed list usually offers categories, and his profile has
    // "Job Board or Social Media" for exactly that. `decide` picks whichever
    // the form actually offers. A second, more specific rule further down read
    // `heard_about_us` and could never fire — this rule matched first — so that
    // value sat unused and list-shaped forms went unanswered (F-263).
    get: p => [p.answers?.how_heard, p.answers?.heard_about_us] },
  // "Desired hourly rate" is the same question as "salary expectations" and
  // matched none of these words — an intern form's most common way of asking.
  { re: /salary|compensation|pay\s+(expectation|range|rate)|(hourly|desired|expected)\s+(rate|wage|pay)|rate\s+of\s+pay/i,
    get: p => p.answers?.salary_expectation, review: true },
  { re: /18\s+years|legal\s+age|at\s+least\s+eighteen/i, get: p => p.answers?.over_18 },
  // "former ASML employee or contractor" — the company name sits between the two
  // words, so allow a couple of tokens.
  // "Have you ever worked at Applied Materials as a regular employee, contingent
  // worker, intern, etc.?" matched none of the three original spellings — no
  // "previously", no "former", and nothing after "worked at" saying "before".
  // Measured on his most important employer's live form.
  // "Have you ever been employed BY Becton Dickinson?" (SmartRecruiters, live
  // 2026-09-04) — "by" was the one preposition missing.
  // "Are you a former/current intern or contractor?" (Tesla, live 2026-09-20)
  // needed two more things: a SLASH where the pattern wanted a space, and
  // "intern" in the noun list. He interned at Applied Materials, not Tesla,
  // and `employedAtApplyingTo` is what keeps that distinction — the rule only
  // supplies the standing No when the employer is not one he has worked for.
  { re: /previously\s+(?:been\s+)?(worked|employed)|former[\s/]+(?:[\w.]+[\s/]+){0,3}(employee|contractor|intern)|worked\s+(at|for).*(before|previously)|ever\s+(worked|been\s+employed)\s+(at|for|with|by)(?!\s+(?:this|our)\b)|worked\s+(at|for)\b.*\b(employee|contractor|intern)\b/i,
    get: p => employedAtApplyingTo(p) ?? p.answers?.previously_employed_here, review: true },
  // Talent-community / talent-network opt-in. Required on some tenants (ASML),
  // and covered by his standing "yes to everything" instruction.
  //
  // TSMC WORDS IT WITHOUT THE WORD "TALENT". Its checkbox reads "Hear more
  // about career opportunities" and went to the ledger as a question nobody
  // could answer, with `talent_community_optin: "Yes"` sitting in his profile
  // the whole time. The same shape as F-526: the concept was known and one
  // house wording was not. So the rule now matches what these boxes actually
  // offer — hearing about jobs, roles, openings or opportunities — rather than
  // only the one noun most tenants happen to use.
  { re: /talent\s+(community|network|pool)|join\s+our\s+talent|candidate\s+community|(hear|learn|be\s+notified|stay\s+(informed|connected|up\s*to\s*date))[^?.;]{0,40}\b(career|job|role|position|opening|opportunit)/i,
    get: p => p.answers?.talent_community_optin, review: true },
  { re: /relative|family\s+member.*(employ|work)/i, get: p => p.answers?.relatives_at_company },
  // ── seen on Eightfold forms (Micron / Lam) ────────────────────────
  // Export-control country citizenship. NOT the same as the generic ITAR
  // "U.S. person" question, and it must be answered No for him (Canadian).
  { re: /cuba,?\s*iran|citizen\s+of,?\s+or\s+do\s+you\s+hold\s+dual\s+citizenship|north\s+korea.*syria/i,
    get: p => p.answers?.restricted_country_citizen, review: true },
  // "A U.S. worker is defined as … are you in one of the above five groups?"
  { re: /u\.?s\.?\s+worker|above\s+five\s+groups/i, get: p => p.answers?.us_person, review: true },
  { re: /legal\s+right\s+to\s+work|verification\s+of\s+your\s+legal|submit\s+verification/i,
    get: p => p.answers?.can_verify_right_to_work, review: true },
  { re: /when\s+would\s+you\s+be\s+available|available\s+to\s+start/i, get: p => p.answers?.earliest_start },
  // "Have you ever interviewed at Anthropic before?" — the same history as a
  // previous application, and never applied means never interviewed (F-348).
  { re: /applied\s+on\s+any\s+previous|previously\s+applied|applied\s+before|(?:ever|previously)\s+interviewed\s+(?:at|with|for|here)|interviewed\s+(?:at|with)\s+.{1,40}\s+before/i, get: p => p.answers?.previously_applied_here },
  { re: /terminated\s+or\s+asked\s+to\s+resign|been\s+terminated/i, get: p => p.answers?.terminated_for_cause, review: true },
  { re: /board\s+of\s+directors/i, get: p => p.answers?.board_membership },
  // The third spelling is Amazon's, and it arrives as the OPTION TEXT rather
  // than a question: the radio group's label came through as "No, I was NEVER
  // a government employee." Neither of the first two patterns contains a bare
  // "government employee", so the group was left blank on a required field.
  { re: /employee\s+of\s+a\s+u\.?s\.?\s+federal|federal,?\s+state,?\s+or\s+local\s+government|\bgovernment\s+employee\b/i,
    get: p => p.answers?.government_employee },
  // A BARE "Language" DROPDOWN on an application is which language to write to
  // him in. Applied Materials' form has one and it came back "a dropdown we
  // have no answer for" while `self_id_language: "English"` sat in his profile
  // (audit, 2026-09-07). The language ENTRIES on Workday's My Experience are
  // filled by their own path and never reach this table.
  { re: /self\s*identification\s+language|preferred\s+language|^\s*language\s*:?\s*\*?\s*$|correspondence\s+language|language\s+preference/i,
    get: p => p.answers?.self_id_language },
  // ── Languages (Workday's My Experience, F-367) ──
  // Under each language he adds sit five dropdowns — Comprehension, Overall,
  // Reading, Speaking, Writing — and the box "I am fluent in this language."
  // All six were left for him on a live form (2026-09-06). His instruction:
  // the highest level offered, for every language he lists. The
  // answer is a ladder of spellings; chooseOption ranks whatever words the
  // tenant uses and takes the top rung.
  { re: /fluent\s+in\s+this\s+language|^\s*native\s+(speaker|language)\s*\*?\s*$/i, get: p => p.answers?.fluent_in_language ?? 'Yes' },
  { re: /^\s*(comprehension|overall|reading|speaking|writing|listening)\s*(proficiency|level)?\s*\*?\s*$|^\s*(language\s+)?(proficiency|fluency)(\s+level)?\s*\*?\s*$|language\s+proficiency\s*(level)?\s*\*?\s*$/i,
    not: /\b(java|python|c\+\+|cad|solidworks|software|tool|scale of)\b/i,
    get: p => p.answers?.language_proficiency ?? HIGHEST_PROFICIENCY },
  { re: /^city$|^city\s*\*?$/i, get: p => p.identity?.city },
  // Address and postcode were in apply-profile.yml the whole time and had no
  // pattern here, so a live Applied Materials form reported "Address Line 1 —
  // no answer in apply-profile.yml" while identity.address_line1 sat right
  // there. Same for postal_code.
  { re: /^address(\s*line)?\s*(1|one)?\s*\*?$|^street\s*address\b|^address\s*:?\s*\*?$/i,
    get: p => p.identity?.address_line1 },
  { re: /^address\s*line\s*(2|two)\b/i, get: p => p.identity?.address_line2 },
  // "What is your postal code?" (SmartRecruiters, Intuitive Surgical,
  // 2026-09-24) missed the start-anchored pattern, fell through to the essay
  // writer, and the box said he did not have one. He does: 12345 (F-549).
  { re: /^(postal|zip)\s*(\/\s*(zip|postal)\s*)?code\b|^zip\b|^postcode\b|\byour\s+(postal|zip)\s*(\/\s*(zip|postal)\s*)?code\b|\byour\s+postcode\b/i,
    get: p => p.identity?.postal_code },
  { re: /^country\s*:?\s*\*?$|^country\/region\b/i, get: p => p.identity?.country },

  // ── campus-recruiting questions ──
  // Twelve radio groups on the Applied Materials new-grad form, every one
  // answerable from the profile, none of them answered — the question text was
  // not being captured, so the label was just "Yes". With that fixed these
  // patterns give the answers.
  { re: /are\s+you\s+(currently\s+)?in\s+school|are\s+you\s+(currently\s+)?(a\s+)?student|are\s+you\s+(currently\s+)?enrolled/i,
    get: p => p.answers?.currently_in_school },
  { re: /final\s+year\s+of\s+school|year\s+of\s+(school|study)|current\s+(year|academic)\s+(in\s+)?(school|study)/i,
    get: p => p.answers?.year_in_school },
  { re: /highest\s+(level\s+of\s+)?(education|degree)|degree\s+(level|type)\s*(you|attain)/i,
    get: p => p.answers?.highest_education },
  { re: /(field|area)\s+of\s+stud(y|ies)|major\b|discipline\s+of\s+study/i,
    get: p => p.answers?.field_of_study },
  // "What term did you (or will you) graduate in?" had no rule (measured on the
  // live Applied Materials form, 2026-09-07): "term" was only recognised
  // directly after "graduation"/"grad", and this asks it the other way round.
  { re: /(graduation|grad)\s+(season|term|quarter)|when\s+(do|will)\s+you\s+graduat|what\s+(term|semester|quarter|season)\b[^?]{0,40}\bgraduat|\bgraduat\w*\s+(term|semester|quarter|season|date)\b/i,
    get: p => p.answers?.graduation_season },
  // "Which best describes your status?" on a campus form is asking what he is
  // — a student in his final year — and had no rule and no key. The answer is
  // his own words from `year_in_school`; the option list on any given tenant is
  // matched against it the same way every other answer is.
  { re: /which\s+(best\s+)?describes\s+your\s+(current\s+)?(status|situation)|what\s+(best\s+)?describes\s+you\b|your\s+current\s+status\s*\??$/i,
    get: p => p.answers?.student_status ?? p.answers?.year_in_school, review: true },
  { re: /type\s+of\s+opportunity|what\s+(kind|type)\s+of\s+(role|position)\s+are\s+you\s+(looking|seeking)/i,
    get: p => p.answers?.opportunity_type },
  { re: /(region|geograph).{0,30}(prefer|interest|willing)|prefer.{0,20}(region|location)/i,
    get: p => p.answers?.preferred_region },
  // "WHICH SPECIFIC ENGINEERING MODULE ARE YOU INTERESTED IN?" — TSMC, offering
  // CMP / CVD / PVD / EPI / DIF / WET. Asked him directly 2026-09-20 and his
  // answer was "no preference, whichever has openings", so the honest thing is
  // to take whatever open option the menu offers and not to pick a process he
  // would then be asked about in an interview.
  //
  // `chooseOption` matches these alternatives against the form's real list, so
  // a tenant offering "No preference" or "Open to any" gets it; a menu of six
  // processes and nothing else matches none of them and comes back to him,
  // which is right — there is no truthful answer in that list.
  { re: /which\s+(specific\s+)?(engineering\s+)?(module|process\s+area|technology\s+area|business\s+unit|team)[^?.;]{0,40}(interest|prefer|apply|want)|module\s+(preference|of\s+interest)|which\s+(module|process)\s+(are|would)\s+you/i,
    get: p => p.answers?.module_preference
      ?? ['No preference', 'No Preference', 'Open to any', 'Any', 'No specific preference'],
    review: true },
  // A bare "Date" is the date you are signing the self-identification form —
  // today. Start dates and graduation dates match earlier, more specific rules,
  // and date of birth is never-fill.
  { re: /^date\s*:?\*?$|today.?s\s+date|date\s+of\s+(signature|completion)/i,
    get: () => new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
    review: true },

  // WORK CONDITIONS — the questions a manufacturing form asks that nothing here
  // had a concept of.
  //
  // F-285 asked which PHRASINGS the table misses for facts he has. This asked
  // the opposite question — which QUESTIONS have no rule and no key at all —
  // and nineteen came back. Eleven of them are stable facts about him that a
  // semiconductor or robotics employer asks on nearly every form: cleanroom,
  // PPE, lifting, travel, weekends, overtime, a driver's licence. They were not
  // "unanswered because his profile is thin"; the engine did not know they were
  // questions, so they came back "no idea" and he typed each one by hand, every
  // time, forever.
  //
  // These rules answer nothing on their own. Each names the ONE profile line
  // that would answer it, so the field goes from "this engine is lost" to "add
  // `answers.cleanroom_ok` and this is done for good". Inventing a value here
  // would be inventing a fact about him, which is the one thing this table may
  // never do — his willingness to work weekends is not derivable from a CV.
  { re: /cleanroom|clean\s+room|(gown|bunny\s*suit)|personal\s+protective|\bppe\b/i,
    get: p => p.answers?.cleanroom_ok, ask: 'answers.cleanroom_ok', review: true },
  { re: /(able|willing|comfortable).{0,30}(lift|carry|physical)|lift.{0,20}(\d+\s*(lb|pound|kg))|physical\s+requirements/i,
    get: p => p.answers?.can_lift, ask: 'answers.can_lift', review: true },
  { re: /(willing|able|open).{0,25}travel|travel\s*(requirement|percentage|%)|percent\w*\s+of\s+travel|how\s+much\s+travel/i,
    get: p => p.answers?.travel_ok, ask: 'answers.travel_ok', review: true },
  { re: /driver'?s?\s+licen[cs]e|valid\s+licen[cs]e|reliable\s+transport|own\s+transport/i,
    get: p => p.answers?.drivers_license, ask: 'answers.drivers_license', review: true },
  { re: /(willing|able|available).{0,25}(weekend|holiday)|weekend\s+work/i,
    get: p => p.answers?.weekends_ok, ask: 'answers.weekends_ok', review: true },
  { re: /(willing|able|available).{0,25}(overtime|extended\s+hours)|work\s+overtime|rotating\s+shift|night\s+shift|shift\s+work/i,
    get: p => p.answers?.shifts_ok, ask: 'answers.shifts_ok', review: true },
  { re: /how\s+many\s+hours.{0,25}(week|available)|hours\s+per\s+week/i,
    get: p => p.answers?.hours_per_week, ask: 'answers.hours_per_week', review: true },
  { re: /availab\w*.{0,30}interview|interview\s+availability/i,
    get: p => p.answers?.interview_availability, ask: 'answers.interview_availability', review: true },
  // "Have you ever worked here before?" is a fact only he knows, and a wrong
  // "No" on a rehire question is the kind of thing that gets an offer pulled.
  { re: /(ever\s+been\s+)?(employ|work)\w*\s+(by|at|for|with)\s+(this|our)\s+(company|organization)|previously\s+(employed|worked)\s+(by|at|here)|former\s+employee\s+of\s+(this|our)/i,
    get: p => p.answers?.worked_here_before, ask: 'answers.worked_here_before', review: true },

  // PROSE IS HIS, AND SAYING SO IS BETTER THAN SAYING NOTHING.
  //
  // "Why are you interested in this role?" came back identical to a field the
  // engine had never seen — both "no idea". They are not the same thing at all:
  // one is a gap, and this one is a boundary. Writing his motivation for him is
  // exactly the fabrication the source-of-truth rule forbids, so the engine
  // declines on purpose and now says which it is doing.
  { re: /why\s+(are\s+you|do\s+you\s+want|this\s+(role|company|position))|what\s+(interests|excites|draws)\s+you|tell\s+us\s+(why|about\s+yourself)|describe\s+your\s+(relevant\s+)?experience|why\s+(are\s+you\s+)?leav\w+/i,
    get: () => undefined, prose: true },
];

// EEO categories are NOT in this list — they resolve through the eeo: section
// of the user's apply-profile (added with the user's explicit consent). If an
// eeo key is missing, the rule returns no value and the field is flagged, not
// guessed. Typed certifications (signature boxes) stay never-fill; certification
// CHECKBOXES are handled by the policy.auto_check_certifications branch in _form.
const DEFAULT_NEVER = [
  // CRIMINAL HISTORY IS A LEGAL DECLARATION, NOT A FORM FIELD.
  //
  // It had no rule, so it came back "no idea" and sat blank next to genuine
  // gaps. Answering it would have the engine make a legal assertion on his
  // behalf; the honest outcome is a deliberate refusal that says so, which is
  // what `never` reports. Ban-the-box law also makes the question illegal at
  // this stage in much of the country, so a blank is frequently the correct
  // filing anyway.
  /convicted|criminal\s+(record|history|convict)|felon\w*|plead\w*\s+(guilty|no\s+contest)/i,
  /sexual\s+orientation/i, /transgender/i, /pronouns/i,
  /i\s+certify|i\s+acknowledge|i\s+agree|i\s+consent|certif(y|ication)\s+of\s+accuracy/i,
  /signature/i, /date\s+of\s+birth|birth\s*date/i, /\bssn\b|social\s+security/i,
  // Account credentials. A "Username" or "Create a password" field belongs to
  // signing up, not to applying, and creating accounts is his. The extension
  // refuses a whole form containing a password field (F-146); this covers the
  // same ground one field at a time, for a form that mixes them in.
  /^\s*username\s*$|create\s+(a\s+)?(user\s?name|password)|choose\s+a\s+password|confirm\s+password/i,
  // MONEY DETAILS ARE NEVER TYPED BY THIS ENGINE.
  //
  // Attacking the answer path with hostile labels (F-275) showed "Bank account
  // number for direct deposit" coming back `unknown` — left to him, which is
  // the right outcome, but reached by ACCIDENT: no rule happened to match it.
  // Safety that depends on no rule ever matching is not safety; a future rule
  // with "account" or "number" in it would quietly start filling the field.
  //
  // Named explicitly so the refusal is a decision. Deliberately narrow: bare
  // "account" is left alone because "Do you have an account with us?" is an
  // ordinary question, and the point is to refuse payment details, not to
  // refuse a word.
  /bank\s*(account|details|name)|routing\s*(number|code)|\biban\b|\bsort\s+code\b|account\s+number/i,
  /credit\s*card|card\s*number|\bcvv\b|security\s+code|billing\s+address/i,
];

function neverFillMatchers(profile) {
  const custom = Array.isArray(profile.never_fill)
    ? profile.never_fill.map(s => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    : [];
  return [...DEFAULT_NEVER, ...custom];
}

/**
 * Resolve a form label to an action.
 * @returns {{kind:'never'} | {kind:'answer', value:string, review:boolean} | {kind:'unknown'}}
 */
/**
 * "If you …, <question>" — the condition is never the question.
 *
 * Returns the part after the comma, or null when there is nothing separable.
 * See the block in resolveLabel for why this lives here and not in the planner.
 */
function conditionalBody(text) {
  if (!/^\s*if\s+(you\s+(checked|selected|answered|indicated|are|have|marked)|your)\b/i.test(text)) return null;
  const body = text.match(/^\s*if\s+your?\b[^,]{0,80},\s*(.+)$/is)?.[1]?.trim();
  if (!body || /^\s*if\s+your?\b/i.test(body)) return null;
  return body;
}

export function resolveLabel(label, profile) {
  const text = String(label || '').trim();
  if (!text) return { kind: 'unknown' };

  // A CONDITIONAL FOLLOW-UP IS ANSWERED ON ITS QUESTION, AND THIS IS THE ONLY
  // PLACE THAT REACHES BOTH ENGINES.
  //
  // F-248 and F-249 put this guard in `planField`, which the browser extension
  // goes through. The Playwright driver does not: `_form.mjs` and
  // `workday.mjs` call resolveLabel directly at eight sites, so the guard never
  // ran there and the driver would still type
  //
  //   "If you have a disability, please describe any accommodations you need"
  //        -> "No, I do not have a disability"
  //
  // into a free-text box. Exactly the F-223 shape — one engine fixed, the other
  // quietly not — on the most sensitive question class on any form.
  //
  // Resolving the BODY is what makes this safe in both directions: "please
  // describe any accommodations you need" answers to nothing, while "please
  // share your GPA" and "what is your start date?" still answer correctly.
  const body = conditionalBody(text);
  if (body) {
    const inner = resolveLabel(body, profile);
    // Conditional, so always worth his eye even when the answer is confident.
    return inner.kind === 'answer' ? { ...inner, review: true } : inner;
  }
  for (const re of neverFillMatchers(profile)) {
    if (re.test(text)) return { kind: 'never' };
  }
  const hit = matchRules(text, profile);
  if (hit) return hit;
  // SECOND PASS, DECORATION REMOVED. Only reached when nothing matched the
  // label as the form wrote it, so an answer that already worked cannot
  // change — see tidyLabel.
  const bare = tidyLabel(text);
  if (bare && bare !== text) {
    for (const re of neverFillMatchers(profile)) if (re.test(bare)) return { kind: 'never' };
    const second = matchRules(bare, profile);
    if (second) return second;
  }
  return { kind: 'unknown' };
}

/**
 * WHICH RULE answered this label — the pattern's source, for the answer log.
 * F-549 took a single question and an hour to trace: the sponsorship question
 * was answered by the visa-HISTORY rule, and nothing on record said so. Null
 * when no rule matched (the answer came from elsewhere, or nowhere).
 */
export function whichRule(label, profile) {
  const text = String(label || '').trim();
  if (!text) return null;
  const first = (t) => {
    for (const rule of RULES) {
      if (rule.not && rule.not.test(t)) continue;
      if (rule.re.test(t)) return rule.re.source.slice(0, 160);
    }
    return null;
  };
  const body = conditionalBody(text);
  if (body) return whichRule(body, profile);
  return first(text) || first(tidyLabel(text) || '') || null;
}

/** Run the rule table over one spelling of the label. Null when no rule matched at all. */
function matchRules(text, profile) {
  for (const rule of RULES) {
    // `not` is an escape hatch for a phrase that matches a rule but asks a
    // different question — "…years of experience, please briefly explain…"
    // wants prose, not "2 years". Cheaper and clearer than bending the main
    // pattern into a shape nobody can read.
    if (rule.not && rule.not.test(text)) continue;
    if (rule.re.test(text)) {
      // A DELIBERATE BLANK IS AN ANSWER. `blank: true` means he was asked and
      // the answer is "nothing, on every form, forever" — no middle name, no
      // Facebook, no employee ID at a company he has never worked for.
      //
      // The distinction matters because `kind: 'unknown'` puts the question in
      // the ledger he reads, and a question whose answer will never change is
      // noise there — it crowds out the ones a line of YAML would fix. The
      // Workday key table has had this courtesy since Phone Extension
      // (`kind: 'blank'`, apply-plan.mjs); the label rules never could.
      if (rule.blank) return { kind: 'blank', why: rule.why || 'deliberately left blank' };
      const value = rule.get(profile);
      // A RULE MATCHED AND HIS PROFILE SAYS EMPTY — that is not the same as
      // having no idea what the question is.
      //
      // Measured on a live Gradient Robotics form: "Portfolio Link" came back
      // as "no answer for this question", which reads like a bug. His profile
      // says `website: ""  # portfolio URL — none yet`. The question is
      // understood; the answer is genuinely nothing.
      //
      // It is still reported rather than hidden — one of the four empty values
      // is a background-check consent, and quietly marking that "handled" is
      // the opposite of useful. Only the WORDING changes, so the list he reads
      // separates "you have not filled this in" from "this engine is lost".
      if (value != null && String(value).trim() === '') {
        return { kind: 'unknown', why: 'your profile leaves this blank' };
      }
      // A rule that KNOWS the question but has no key yet names the key. The
      // difference between "this engine is lost" and "one line of YAML ends
      // this question forever" is the whole value of the rule.
      if (value == null) {
        if (rule.prose) return { kind: 'unknown', why: 'needs your own words — the engine will not write this for you' };
        if (rule.ask) return { kind: 'unknown', why: `add \`${rule.ask}\` to apply-profile.yml and this answers itself` };
        return { kind: 'unknown' };
      }
      // ALTERNATIVES SURVIVE AS AN ARRAY. `String(value)` on one produced
      // "LinkedIn,Job Board or Social Media" — both answers joined by a comma
      // and typed into the form as a single string, which is worse than either
      // of them alone. A rule may offer several truthful answers for a question
      // whose SHAPE differs between forms ("How did you hear about us?" is free
      // text on some and a fixed list on others); `decide` picks the one the
      // form in front of it actually accepts.
      if (Array.isArray(value)) {
        const alts = value.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim());
        if (!alts.length) return { kind: 'unknown', why: 'your profile leaves this blank' };
        // ONE alternative is just an answer. Returning `['Job Board']` where the
        // contract has always been a string would push array handling onto
        // every caller for a case that is not an alternative at all — and did,
        // breaking three tests that were right. The array shape appears only
        // when there is a genuine choice to make.
        return { kind: 'answer', value: alts.length === 1 ? alts[0] : alts, review: !!rule.review };
      }
      return { kind: 'answer', value: String(value).trim(), review: !!rule.review };
    }
  }
  return null;
}


/** For yes/no selects: does this answer mean yes / no / neither? */
export function yesNo(value) {
  if (/^\s*yes\b/i.test(value)) return 'yes';
  if (/^\s*no\b/i.test(value)) return 'no';
  return null;
}
