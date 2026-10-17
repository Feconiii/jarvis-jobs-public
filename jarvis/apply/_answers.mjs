import { HOW_HEARD_LADDER } from './_workday-keys.mjs';

/**
 * The profile says, in so many words, that this person is a U.S. citizen or a
 * permanent resident. Read from `citizenship_status` alone and only when it is
 * not negated ("Not a U.S. citizen" is the opposite answer).
 */
function statusIsCitizenOrResident(p) {
  const s = String(p?.answers?.citizenship_status || '');
  if (!s.trim() || /\b(not|non|no)\b/i.test(s)) return false;
  return /\b(u\.?\s?s\.?|united\s+states|american)\s+citizen\b|\bpermanent\s+resident\b|\bgreen\s*card\b/i.test(s);
}

/** "Lakeside University" → "Lakeside": the short name a fixed school list may use. */
function schoolShortName(school) {
  const s = String(school || '').trim();
  return s.replace(/\s+(university|college)$/i, '').replace(/^(the\s+)?university\s+of\s+/i, '').trim() || '';
}

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
    .replace(/^\s*(?:question|q)\s*\d{1,3}\s*[:.)\-]\s*/i, '')   // "Question 4: Company Name" (F-623)
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
/**
 * HIS COUNTRY, AS A LIST MAY SPELL IT (ASM, 2026-09-25). Its citizenship
 * picker lists "Viet Nam", the ISO name; "Vietnam" typed into its filter found
 * nothing and the question was left for him. The other spellings are tried
 * after his own.
 */
const COUNTRY_SPELLINGS = {
  vietnam: ['Viet Nam', 'Vietnam, Socialist Republic of', 'Vietnamese'],
};
function citizenshipCountry(p) {
  const c = String(p.answers?.citizenship_country || '').trim();
  if (!c) return undefined;
  const alts = COUNTRY_SPELLINGS[c.toLowerCase().replace(/\s+/g, '')];
  return alts ? [c, ...alts] : c;
}

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

/**
 * More spellings of a bachelor's degree, tried after his own words. HP's menu
 * reads "Bachelors (±16 years of education)", and neither "Bachelor of Science"
 * nor "Bachelor's" matched it (2026-09-26, left for him twice). Only when his
 * degree IS a bachelor's; a free-text box still gets the first, his own.
 */
function bachelorSpellings(p) {
  // "BACH" is JPL's Workday code for it (2026-10-02: Degree required, he picked BACH).
  return /bachelor/i.test(`${p?.education?.degree_level || ''} ${p?.education?.degree || ''}`) ? ['Bachelors', "Bachelor's Degree", 'Bachelor', 'BACH'] : [];
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
  // "Do you hold Citizenship or Permanent Residency status from any of the
  // following countries or administrative regions? Please select one."
  // (SmartRecruiters, 2026-09-26: left, and he picked Vietnam.) His
  // citizenship; a list without it matches nothing and stays his.
  // A list without his country: "None of the above" is true only because his
  // profile also says he is a permanent resident nowhere else.
  { re: /\b(citizenship|permanent\s+residen\w*)\b[^?]{0,80}\bfrom\s+any\s+of\s+the\s+following\s+(countries|nations)\b/i,
    get: (p) => {
      const home = citizenshipCountry(p);
      const list = Array.isArray(home) ? home : [home].filter(Boolean);
      if (!list.length) return undefined;
      return /^no$/i.test(String(p.answers?.permanent_resident_elsewhere || '')) ? [...list, 'None of the above', 'None of these', 'None'] : list;
    }, review: true },
  // "If you answered yes above, please DETAIL your current or future
  // sponsorship needs." — a box for the explanation, which the sponsorship
  // rule filled with a bare "Yes" (Yes-audit, 2026-09-26). His visa note.
  { re: /\b(detail|describe|explain|elaborate\s+on|specify|outline)\b[^?]{0,50}\bsponsorship\s+(needs?|requirements?|situation)\b|\bwhat\s+(type\s+of\s+|kind\s+of\s+)?sponsorship\s+(will\s+you\s+|do\s+you\s+)?(need|require)\b/i,
    get: (p) => String(p.answers?.visa_status_note || '').replace(/\s+/g, ' ').trim() || undefined, review: true },
  // "If you require sponsorship, please explain your situation." — the
  // whole conditional sentence is the question (its condition is his).
  { re: /^\s*if\s+you\s+(will\s+)?(now\s+or\s+in\s+the\s+future\s+)?(require|need)\s+(visa\s+|immigration\s+|employment\s+)?sponsorship\b[^]*\b(explain|describe|detail|provide|tell)\b/i,
    get: (p) => String(p.answers?.visa_status_note || '').replace(/\s+/g, ' ').trim() || undefined, review: true },
  // JOHN DEERE'S EIGHTFOLD QUESTIONS (F-697, 2026-10-03), each left for him:
  // "…require assistance in obtaining work status or maintaining your current
  // work authorization … please explain your situation" got "No" — he wrote
  // his F-1 → OPT → H-1B path; the visa note says the same.
  { re: /\b(require|need)\s+(assistance|help|support)\s+(in\s+|with\s+)?(obtaining|maintaining)\b[^]{0,200}\bwork\s+(status|authori[sz]ation)\b[^]*\b(explain|describe|detail)\b/i,
    get: (p) => String(p.answers?.visa_status_note || '').replace(/\s+/g, ' ').trim() || undefined, review: true },
  // "Are you currently in F-1 Visa status?" is a yes/no, not a request for
  // the note (it went out as the note and matched neither option).
  { re: /^\s*(are|is)\s+you\s+(currently\s+|presently\s+)?(in|on|holding|under)\s+(an?\s+)?f-?1\b/i,
    get: (p) => (/\bf-?1\b/i.test(`${p.answers?.visa_status_note || ''} ${p.answers?.citizenship_status || ''}`) ? 'Yes' : undefined) },
  // DACA: he is on F-1, not deferred action. A citizen or a permanent resident
  // is not either; anyone else's status is theirs to state.
  { re: /\bdeferred\s+action\s+for\s+childhood\s+arrivals\b|\bdaca\b/i,
    get: (p) => (/\bf-?1\b/i.test(String(p.answers?.visa_status_note || '')) || statusIsCitizenOrResident(p) ? 'No' : undefined) },
  // "…worked for a company that has supplied contingent workers to John
  // Deere?" — he has not; he wrote "N/A" (third-party / staffing → no).
  { re: /\bworked\s+for\s+a\s+(company|firm|agency|supplier)\s+that\s+(has\s+)?(supplied|provided|placed)\s+(contingent|contract|temporary|agency)\s+(workers?|labor|staff)/i,
    get: () => ['N/A', 'No'] },
  // "In which capacity, if any, are you currently, or were you most recently
  // employed at John Deere?" — never, from his history; the list says so in
  // a sentence ("I have never been/nor am I currently employed…").
  { re: /\bin\s+which\s+capacity\b[^?]{0,100}\b(employed|worked)\s+(at|by|for)\b/i,
    get: (p) => (/^no$/i.test(String(employedAtApplyingTo(p) ?? p.answers?.previously_employed_here ?? '')) ? ['I have never', 'Never', 'None', 'Not applicable', 'N/A'] : undefined) },
  // "What is your preferred method of communication?" (Plug Power, 2026-10-03:
  // he chose Email) — the method, never his address.
  { re: /\bpreferred\s+(method|mode|way|means|channel)\s+of\s+(communication|contact|contacting\s+you)\b|\bhow\s+(would|do)\s+you\s+(prefer|like)\s+(to\s+)?be\s+contacted\b/i,
    get: () => ['Email', 'E-mail', 'Email address'] },
  // QUESTIONS EVERY EMPLOYER ASKS IN ITS OWN WORDS, from the replay's "left
  // empty" list (2026-10-03, step 3): each was answered by him by hand.
  // (Debarment from federal programs stays his — a legal declaration, kept
  // out of the rules on 2026-10-02; his own earlier answer is reused instead.)
  // "Are you or have you ever been a Healthcare Provider?" (Vertex): No.
  { re: /\b(are|have)\s+you\b[^?]{0,30}\b(an?\s+)?(licensed\s+)?health\s*care\s+(provider|professional|practitioner)\b/i, get: () => 'No' },
  // "Do you currently reside within the continental United States?" (Lila): he lives in Springfield.
  { re: /\b(currently\s+)?(reside|live|located|living)\s+(with)?in\s+(the\s+)?(continental\s+|contiguous\s+|mainland\s+)?(united\s+states|u\.?\s?s\.?(a\.?)?)\b/i,
    get: (p) => (/^united\s+states|^usa?$/i.test(String(p.identity?.country || 'United States')) && p.identity?.state ? 'Yes' : undefined) },
  // "Do you prefer to work On-Site, Remote or Hybrid?" (Brooks): he chose On-Site.
  { re: /\bprefer\s+to\s+work\b[^?]{0,40}\b(on-?\s?site|remote|hybrid)\b|\bwork\s+(model|arrangement|setting)\s+(do\s+you\s+)?prefer\b/i,
    get: () => ['On-Site', 'Onsite', 'On site', 'In office', 'In-person'] },
  // "Will you graduate on or before Jun 2027?" (XPeng): his date against theirs.
  { re: /\bwill\s+you\s+(have\s+)?graduate[d]?\s+(on\s+or\s+)?(before|by)\s+[a-z]+\.?\s+\d{4}\b/i,
    get: (p, text) => {
      const m = String(text || '').match(/\b(before|by)\s+([a-z]+)\.?\s+(\d{4})\b/i);
      const by = m ? Date.parse(`1 ${m[2].slice(0, 3)} ${m[3]}`) : NaN;
      const mine = Date.parse(`1 ${String(p.education?.graduation || '').trim()}`);
      if (!Number.isFinite(by) || !Number.isFinite(mine)) return undefined;
      return mine <= by + 31 * 86400e3 ? 'Yes' : 'No';
    } },
  // "Are you willing to start immediately?" (Droyd): No while graduation is
  // still ahead. Once it has passed, only an earliest start that says so is a Yes.
  { re: /\b(willing|able|available)\s+to\s+start\s+immediately\b|\bstart\s+immediately\s*\?/i,
    get: (p) => {
      const grad = Date.parse(`1 ${String(p.education?.graduation || '').trim()}`);
      if (grad > Date.now()) return 'No';
      return Number.isFinite(grad) && /\b(immediate(ly)?|asap|now|any\s*time)\b/i.test(String(p.answers?.earliest_start || '')) ? 'Yes' : undefined;
    } },
  // "Do you currently work for another Samsung Subsidiary…?" (Samsung): his history.
  { re: /\b(currently\s+)?work\s+for\s+(another|any)\s+[\w&.' -]{2,40}?\s+(subsidiary|affiliate)\b/i,
    get: (p) => (employedAtApplyingTo(p) === 'Yes' ? undefined : 'No') },
  // "Do you plan on returning to the United States prior to starting full-time
  // employment?" (Amazon): he lives here; yes.
  { re: /\breturn(ing)?\s+to\s+the\s+(united\s+states|u\.?s\.?)\b[^?]{0,60}\b(prior\s+to|before)\s+(starting|start)\b/i, get: () => 'Yes' },
  // "A recruiter may contact me regarding opportunities." — a consent; yes.
  { re: /^\s*(a\s+)?recruiters?\s+(may|can)\s+contact\s+me\b/i, get: () => 'Yes' },
  // "If you answered "Yes" to the question above, please provide us information
  // on your current immigration status, including type of visa and the amount
  // of remaining work authorization. (e.g. F1 visa; 12 months optional practical
  // training remaining)." (Cummins on Oracle, 2026-10-02) — the words "work
  // authorization" sent it to the Yes/No rule, and "Yes" was typed into it.
  { re: /\b(provide|give|share|tell\s+us|describe|list|include)\b[^?]{0,60}\b(current\s+)?(immigration|visa)\s+(status|type|category)|\btype\s+of\s+visa\b[^?]{0,80}\b(remaining|left|expir)/i,
    get: (p) => String(p.answers?.visa_status_note || '').replace(/\s+/g, ' ').trim() || undefined, review: true },
  // "If you have an Employment Authorization Document (EAD) under the F-1
  // student OPT program, are you eligible for a 24-month OPT extension…?"
  // (Honda, 2026-10-02: Yes / No / I do not have OPT). The question is
  // conditional on holding OPT now; he does not yet (`currently_on_opt`).
  { re: /\bif\s+you\s+(have|hold)\s+an?\s+(employment\s+authori[sz]ation\s+document|EAD)\b[^?]{0,160}\bOPT\b/i,
    get: (p) => (/^no$/i.test(String(p.answers?.currently_on_opt || ''))
      ? ['I do not have OPT', "I don't have OPT", 'Do not have OPT', 'Not applicable', 'N/A']
      : p.answers?.stem_opt_extension_eligible), review: true },
  // JPL, 2026-10-02: "If the position you are applying for requires driving …
  // do you have a current and valid California Driver's License? If the
  // position does not require this, select 'N/A'." The question says which.
  { re: /\bif\s+the\s+position\b[^?]{0,80}\brequires?\s+driving\b[^]*\bselect\s*['‘’"“]?\s*N\s*\/\s*A\b/i,
    get: () => ['N/A', 'NA', 'Not applicable'], review: true },
  // "JPL conducts employment verifications upon receipt of an offer
  // acceptance. May we contact your present and previous employer(s) after
  // receiving acknowledgement of your offer acceptance?" — he sent Yes.
  { re: /\bmay\s+we\s+contact\s+your\s+(present|current|previous|prior|former)\b[^?]{0,60}\bemployers?\b[^?]{0,80}\bafter\b[^?]{0,60}\boffer/i,
    get: () => 'Yes', review: true },
  // "Are you a current/former contractor/contingent or intern/co-op at Honda?"
  // offers Currently… / Formerly… / "NA – have not worked for Honda in either
  // capacity"; the employment-history rule's "No" matched none of them.
  { re: /\bcurrent\s*\/\s*former\s+(contractor|contingent|intern|co-?op)/i,
    get: () => ['NA – have not worked', 'NA', 'N/A', 'Not applicable', 'No', 'Never'] },
  // The follow-up to "How did you hear about this position?" — Honda's
  // "Details" list holds "Job Posting: LinkedIn" beside "LinkedIn Inmail".
  { re: /^\s*(source\s+)?details?\s*$/i,
    get: (p) => (/linkedin/i.test(String(p.answers?.how_heard || '')) ? ['Job Posting: LinkedIn', 'LinkedIn Job Posting', 'Job Board: LinkedIn', 'LinkedIn'] : undefined) },
  // "Are you interested in a Full-time or Part-time position?" (JPL) — he
  // needs a full-time new-grad role (preferences.md); he ticked Full-time.
  // Only a question asking WHICH he wants: Lyft's "employed by Lyft … (whether
  // on a full-time or part-time basis)?" is a history question.
  { re: /\b(interested\s+in|looking\s+for|seeking|prefer\w*|desired?|want)\b[^?]{0,20}\b(a\s+)?(full[\s-]?time\s+or\s+part[\s-]?time|part[\s-]?time\s+or\s+full[\s-]?time)\b/i,
    get: () => ['Full-time', 'Full Time', 'Full-Time', 'Fulltime'] },
  // "Preference will be given to qualified candidates who do not reside, or
  // plan to reside, in Alabama, Arkansas, … or Tennessee. If you live in one
  // of these states, would you consider relocation?" He lives in Washington;
  // where it is not listed the question does not apply, and on one form he
  // changed Jarvis's "Yes" to "N/A, I do not live in one of these states".
  // A Yes/No list still gets Yes — he would relocate either way.
  { re: /\bif\s+you\s+(live|reside)\s+in\s+one\s+of\s+these\s+states\b|\bwho\s+do\s+not\s+reside,?\s+or\s+plan\s+to\s+reside,?\s+in\b/i,
    get: (p, text) => {
      const state = String(p.identity?.state || '').trim();
      const listed = state && new RegExp(`\\b${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(text || ''));
      if (listed) return p.answers?.willing_to_relocate;
      return ['N/A, I do not live in one of these states', 'N/A', 'Not applicable', /^yes$/i.test(String(p.answers?.willing_to_relocate || '')) ? 'Yes' : null].filter(Boolean);
    }, review: true },
  // "What is your work authorization status for the country where this role is
  // based?" (Humanoid's Ashby form, 2026-09-26) offers STATEMENTS: authorized
  // without sponsorship / authorized now but will require sponsorship later /
  // not authorized. The plain authorization rule said "Yes", which is none of
  // them. Authorized and needing sponsorship is the middle one — F-1 then OPT
  // then H-1B, exactly what it describes.
  { re: /\bwork\s+authori[sz]ation\s+status\b|\bauthori[sz]ation\s+status\b[^?]{0,60}\bwork\b|\bstatus\s+of\s+your\s+work\s+authori[sz]ation\b/i,
    get: (p) => {
      const auth = /^yes$/i.test(String(p.answers?.authorized_to_work_us || ''));
      const needs = /^yes$/i.test(String(p.answers?.require_sponsorship || ''));
      if (auth && needs) return ['Authorized to work now, but will require employer sponsorship in the future', 'Authorized to work now, but will require sponsorship', 'will require employer sponsorship in the future', 'will require sponsorship in the future'];
      if (auth && !needs) return ['Authorized to work without employer sponsorship', 'Authorized to work without sponsorship'];
      return undefined;
    }, review: true },
  // "How many months of work authorization time do you have remaining? If you
  // hold F-1 OPT and are eligible for a STEM extension, list full OPT plus
  // STEM OPT time" (Intel 11c, 2026-09-26) — he sent "24+ months"; the H-1B
  // rule had claimed it on the word "H-1B" in the note and said "No".
  { re: /\bhow\s+many\s+months\s+of\s+(work\s+)?authori[sz]ation\b|\bmonths\s+of\s+(work\s+)?authori[sz]ation\s+(time\s+)?(do\s+you\s+have\s+)?remaining/i,
    get: (p) => (/^yes$/i.test(String(p.answers?.stem_opt_extension_eligible || '')) ? ['24+ months', 'More than 24 months', '24 months or more', '36 months'] : undefined), review: true },
  // "…indicate all locations or countries for which you now, or in the future,
  // require sponsorship" (HPE) asks for a PLACE: he sent "United States".
  // Only when it asks to NAME them: "…in the country … will you require
  // sponsorship?" is the Yes/No question, and must stay the rule below's.
  { re: /\b(indicate|list|name|specify|which|what)\b[^?]{0,40}\b(locations?|countr(y|ies))\b[^?]{0,80}\b(require|need)\s+sponsorship\b/i,
    get: (p) => (/^yes$/i.test(String(p.answers?.require_sponsorship || '')) ? 'United States' : undefined), review: true },
  // A QUESTION THAT ASKS WHETHER HE WILL REQUIRE SPONSORSHIP IS ANSWERED AS
  // ONE, FIRST, whatever visas it names on the way. F-549 guarded the H-1B and
  // J-1 rules and not the CPT rule, and on 2026-09-24 the CPT rule answered
  // "No" — "I will not require sponsorship" — twice:
  //   Peak Energy     "…require employer sponsorship … (including OPT, CPT,
  //                    H-1B, TN…)"            sent "No" by Jarvis; he fixed it
  //   Western Digital "…require support or sponsorship…? …means … F-1 CPT…"
  //                    planned "No" on three passes
  // "…WITHOUT requiring sponsorship" is the opposite question and goes on to
  // its own rule further down.
  { re: /\b(will|would|do|does|are|now\s+or\s+in\s+the\s+future)\b[^?]{0,80}\b(requir|need)\w*\b[^?]{0,80}\bsponsor|\b(requir|need)\w*\s+(?:\w+\s+){0,5}sponsor(ship)?\b/i,
    // …nor "indicate all locations or countries for which you … require
    // sponsorship" (HPE), which asks for a place — its own rule answers it.
    not: /\bwithout\b|\bnot\s+(requir|need)|\bno\s+longer\b|\bpreviously\b|\bever\s+(been\s+)?sponsor|\b(indicate|list|name|specify)\b[^?]{0,30}\b(locations?|countr(y|ies))\b[^?]{0,80}\bsponsor/i,
    get: p => p.answers?.require_sponsorship, review: true },
  // …and "HAVE YOU EVER BEEN SPONSORED?" is history, not need: the general
  // sponsorship rule below answered it with his future need, "Yes".
  { re: /\b(ever|previously)\s+(been\s+)?sponsored\b|\bhave\s+you\s+been\s+sponsored\b|\bsponsored\s+(you\s+)?(before|previously|in\s+the\s+past)\b/i,
    get: p => p.answers?.held_h1b, review: true },
  // …AT THE TOP OF THE TABLE, because an earlier rule can take a sponsorship
  // question on a stray word: Intel numbers its questions, and "11)* Do you
  // now, or in the future, require Intel to sponsor you…" slipped past the
  // school rule's "Do you" guard and was answered "Lakeside University".
  //
  // AUTHORIZATION WITH A CONDITION HE DOES NOT MEET is a No. On F-1 his right
  // to work is restricted (OPT, then H-1B), so "…without restrictions?" is No,
  // and "authorized to work … This does not include practical training" is
  // No — practical training is the only authorization he will have. CLAUDE.md:
  // unrestricted authorization demanded up front is exactly what he lacks.
  // "…eligible to work in the US for ANY employer?" is the same question: he
  // changed Hyve's Yes to No (2026-09-27, F-621).
  { re: /\bauthori[sz]ed\b[^?]{0,120}\bwithout\s+(any\s+)?restrictions?\b|\bunrestricted\s+(right|authori[sz]ation)\b|\bauthori[sz]ed\b[^.]{0,120}[.?]\s*(this|it)\s+does\s+not\s+include\s+(practical\s+training|opt|cpt)|\b(authori[sz]ed|eligible|able|permitted)\s+to\s+work\b[^?]{0,60}\bfor\s+any\s+(employer|company)\b/i,
    not: /\bsponsor/i,
    get: p => (/^yes$/i.test(String(p.answers?.require_sponsorship || '')) ? 'No' : p.answers?.authorized_to_work_us), review: true },
  // identity
  // A preferred FIRST name is the first word of what he goes by, not of his
  // legal name — the name he uses, not his legal given names. Must sit above the plain first-name
  // rule, which would otherwise claim it.
  { re: /preferred\s*(first|given)\s*name|(first|given)\s*name\s*\(preferred\)|goes\s+by/i,
    get: p => (p.identity?.preferred_full_name || '').trim().split(/\s+/)[0] || p.identity?.first_name },
  // HE HAS NO MIDDLE NAME, and that is an answer rather than a gap.
  //
  // Seen twice in the ledger as "Legal Middle Name" (Workday) and "Middle Name"
  // (TSMC), both counted as questions nobody could answer. His legal name has
  // three given names and one surname, and his passport puts all three in the
  // given name — which is exactly how `first_name` / `last_name` are split in
  // his profile. Splitting one out as a middle name would make the form
  // disagree with his documents, and an I-9 mismatch is a real problem.
  // Confirmed with him 2026-09-20.
  //
  // Someone whose profile carries `identity.middle_name` gets it typed in; the
  // blank and its reason are only for a profile without one.
  //
  // Above the first-name rule on purpose: "Middle Name" contains neither
  // "first" nor "last", but "Legal Middle Name" is one tenant rewording away
  // from something that does.
  // PROFESSIONAL EXPERIENCE THAT EXCLUDES INTERNSHIPS. HP: "Do you have more
  // than 12 months of professional experience related to the job requirements
  // of this role? (not including internships, teaching assistance, research,
  // or military experience)." He sent No — his engineering work is
  // internships, and he is a new college graduate. The No used to arrive by
  // accident (the ITAR rule matched "mil-itar-y"); this is the real reason.
  { re: /\b(more\s+than|at\s+least|over|minimum\s+of)\s+\d+\s*(\+\s*)?(months?|years?)\s+of\s+(professional|full[-\s]time|industry|work|relevant)\b[^?]{0,120}\??[^]*\b(not\s+including|excluding|exclusive\s+of|other\s+than)\b[^.]{0,40}\binternships?\b/i,
    get: (p) => (/new\s+college\s+grad/i.test(String(p.answers?.opportunity_type || '')) ? 'No' : undefined), review: true },
  // "Have you added your full legal name and surname (including any middle
  // names)?" (Graphcore) is a CONFIRMATION, not the middle-name box: the
  // engine enters his legal name, and he sent Yes. Above the middle-name rule,
  // which took it on "middle names" and left it blank.
  { re: /\bhave\s+you\s+(added|entered|provided|used|included)\s+your\s+(full\s+)?legal\s+name\b/i,
    get: p => (p.identity?.first_name && p.identity?.last_name ? 'Yes' : undefined), review: true },
  { re: /middle\s*(name|initial)|\bm\.?i\.?\s*$/i,
    get: p => String(p.identity?.middle_name || '').trim(), blankWhenEmpty: true,
    why: (p) => {
      const i = p.identity || {};
      const legal = String(i.full_name || '').trim();
      return legal && i.first_name && i.last_name
        ? `no middle name — the legal name is "${legal}", given name "${String(i.first_name).trim()}", surname "${String(i.last_name).trim()}"`
        : 'no middle name in the profile';
    } },
  // BOTH NAMES IN ONE BOX (Celestica, 2026-09-27): "* First Name Last Name"
  // under the terms took his given names from the first-name rule, and "First
  // and Last Name" took "Rivera" from the last-name one (F-623).
  { re: /^\s*(first|given)\s*(name)?\s*(and|&|\/|,|\+)?\s*(last|family|sur)\s*name\s*:?\s*$|^\s*name\s*\(\s*first\s*(and\s+|&\s*|\/\s*)?last\s*\)\s*:?\s*$/i,
    get: p => p.identity?.full_name },
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
  // directly — `preferred_full_name` (what he goes by) next to `full_name`
  // (his legal name). This rule used to hand back the legal name for both, so a form
  // that deliberately asks both questions got the same answer twice and the
  // one field where "Alex Rivera" belongs never saw it.
  // "I HAVE A PREFERRED NAME" IS A YES/NO, not a place to put the name.
  //
  // Applied Materials' Eightfold form asks it as a checkbox, and the rule
  // below handed back "Alex Rivera" — which is not "yes", so the box was left
  // unticked and the preferred-name fields it reveals never appeared (audit,
  // 2026-09-07). He does have one: `preferred_full_name` differs from
  // `full_name`. Must sit above the rule that returns the name itself.
  // Workday's copy arrives as "Legal Name — I have a preferred name" (the
  // section rides in front), which the `^` anchor refused, so KLA and Wolfspeed
  // (2026-09-24) left it unticked and he ticked it and typed "Alex" by hand.
  { re: /(^|[—–:-]\s*)\s*i\s+have\s+a\s+preferred\s+name|do\s+you\s+(have|go\s+by)\s+a\s+preferred\s+name/i,
    get: (p) => {
      const pref = String(p.identity?.preferred_full_name || '').trim();
      const legal = String(p.identity?.full_name || '').trim();
      return pref && pref !== legal ? 'Yes' : 'No';
    } },
  { re: /preferred\s*(full\s*)?name/i, get: p => p.identity?.preferred_full_name || p.identity?.full_name },
  // A BARE "Name" IS WHAT HE GOES BY. Radiant (Ashby), 2026-09-24: "Name" was
  // filled with his legal name and he changed it to the one he goes by. A box that says
  // LEGAL, or "full legal", still gets the legal name.
  { re: /^\s*(your\s+)?name\s*\*?:?\s*$/i, get: p => p.identity?.preferred_full_name || p.identity?.full_name },
  { re: /full\s*name|legal\s*name/i, get: p => p.identity?.full_name },
  // "Are you BONDED BY your current company/scholarship?" is a yes/no about a
  // legal obligation, not a request for the employer's name — but it contains
  // "current company", so this rule answered it **"Lakeside University —
  // Manufacturing Lead (student)"** on a live Micron form. A nonsense answer to
  // a question about whether he is contractually tied to someone.
  // HIS CURRENT JOB TITLE. Above the current-company rule, which would
  // otherwise claim "Current Title" through the word "current" and answer it
  // "Lakeside University — Manufacturing Lead (student)" — an employer where a
  // title belongs. His answer, 2026-09-20: the title alone.
  // …and "Current / Most Recent Title" (Flexport, 2026-09-26).
  { re: /current\s+(job\s*)?title|present\s+(job\s*)?title|current\s+position\s*(title)?|your\s+title\s+(at|with)\b|(current\s*(\/|or)\s*)?most\s+recent\s+(job\s+|position\s+)?title/i,
    not: /\bbonded\b|restrict|non-?compete|\bobligat/i,
    get: p => p.answers?.current_title },
  // "HOW MANY EMPLOYEES DOES YOUR CURRENT COMPANY HAVE?" is a number, and this
  // rule answered it **"Lakeside University — Manufacturing Lead (student)"**
  // (found 2026-09-20 while probing the new rules, F-531). Same shape as the
  // bonded-by guard below it: the phrase "current company" appears inside a
  // question about something else entirely. His profile does not record
  // headcounts, so the honest answer is nothing.
  // …and "Current / Most Recent Company", "Most recent employer" (Flexport).
  { re: /current\s+(company|employer)|present\s+employer|(current\s*(\/|or)\s*)?most\s+recent\s+(company|employer)/i,
    get: p => p.answers?.current_company,
    // "May we contact your current employer?" is a permission, not a name —
    // Lyft's got his employer's name in a Yes/No menu (2026-09-24). His
    // profile does not say, so it is his.
    // …nor is Novanta's "required NOTICE PERIOD with your current employer"
    // (2026-09-24), which got his employer's name; the notice rule owns it.
    not: /\bbonded\b|\bagreement\b|\bnotice\s+period\b|restrict|non-?compete|\bobligat|\bhow\s+(many|large|big)\b|number\s+of\s+(employees|people|staff)|headcount|\bsize\s+of\b|revenue|industry|\bwhy\b|how\s+long|\b(may|can|could)\s+we\s+(contact|reach|call)|\bcontact(ing)?\s+(your|the)\s+(current|present)/i },
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
  // SOMEBODY ELSE'S EMAIL IS NOT HIS. TSMC, live 2026-09-24: "Email of
  // Referrer" was typed **his own email address**, and "Are you referred by a
  // current or new employee…? If yes, please provide the name and email
  // address of the employee who referred you" was planned the same address
  // for a Yes/No dropdown. Both fall through to the referral rules below.
  // A YES/NO THAT ASKS FOR AN EMAIL "IF YES" IS NOT ASKING FOR HIS. J&J,
  // 2026-09-30: "Have you ever been employed with any of the Johnson & Johnson
  // Family of Companies…? If yes, please provide Email and WWID" was planned his
  // address — and the same sentence about Applied Materials, where he WAS
  // employed, would have gone the same way. The previous-employer rules own it.
  { re: /e-?mail/i,
    // …nor a question about being an employee that mentions "…their Spirit
    // Email address" (Spirit AeroSystems, 2026-10-02: his address offered to
    // a Current/Former/Never-employee list).
    not: /would\s+you\s+like|receive\s+(communications?|updates?|notifications?|texts?)|\bsms\b|text\s+messages?|opt[\s-]?in|unsubscribe|marketing|\breferr|\brecruiter|\bmanager|\bsupervisor|\breference|\bemergency|\brelative|\bif\s+(yes|so)\b|\b(ever|previously|formerly)\s+(been\s+)?(employed|worked)\b|\bare\s+you\s+(an?\s+)?(current|existing|former)\b[^?]{0,60}\bemployee/i,
    get: p => p.identity?.email },
  // Phone TYPE before phone NUMBER — /phone/ matched "Contact Phone Type" on
  // the live Tesla form and fed it the number, so a dropdown offering
  // Mobile/Landline was asked to match "+1 (555) 000-0000". Routed here it is
  // reported as a missing profile key instead, which names the one line he
  // would add. The engine never guesses which kind of phone he owns.
  // Workday's field is literally "Phone Device Type", which /phone\s*type/
  // never matched because of the word between them — so it fell through to the
  // number rule and offered "+1 (555) 000-0000" to a Mobile/Home/Work dropdown.
  // His mobile is his own: Honda lists "Work (Mobile)" beside "Personal
  // (Mobile)", and a bare "Mobile" took the work one (2026-10-02).
  { re: /phone\s*(device\s*)?(type|kind)|device\s*type|type\s+of\s+phone|contact\s+(phone\s+)?type/i,
    get: p => (/^\s*mobile\s*$/i.test(String(p.answers?.phone_type || ''))
      ? ['Personal (Mobile)', 'Mobile (Personal)', 'Personal Mobile', 'Mobile', 'Cell', 'Cell Phone', 'Mobile Phone']
      : p.answers?.phone_type) },
  // A SECOND NUMBER HE DOES NOT HAVE. Honda's "Alternate Phone Number" got his
  // one number twice (2026-10-02); it is optional and stays empty.
  { re: /(alternate|alternative|secondary|other|additional|second)\s+(phone|mobile|contact\s*number|telephone)/i,
    blank: true, why: 'he has one phone number; the second box is optional' },
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
  // ADP's "Phone number country" (a US/CA/… menu beside the number) is the
  // same question; it was answered with the phone number (2026-10-16).
  { re: /(country|dial(l?ing)?|calling|international)\s*(phone\s*)?code|phone\s*(country|dial(l?ing)?|calling)\s*code|^\s*(phone|mobile|telephone)\s*(number\s*)?country\s*\*?\s*$/i,
    not: /\b(includ\w*|with|enter|provide|add|prefix\w* by)\s+(the\s+|your\s+)?(country|dial|calling|international)|numb\w*\s*[-–(]\s*[^)]*\bcode/i,
    // "+1" too: Workable's "Telephone country code" holds "+1" and nothing
    // else, and was reported as left for him beside the right answer.
    get: (p) => {
      const c = String(p.identity?.country || '').trim();
      return /^united states/i.test(c) ? [c, 'United States', '+1', 'US +1', 'US'] : p.identity?.country;
    } },
  // `contact number` is a phone by another name. Guarded against
  // "emergency contact number", which is somebody else's (F-285).
  // …and "Phonetic pronunciation of your name", which got his phone number on
  // the word "Phone" (audit of logged questions, 2026-09-26).
  { re: /phone|mobile|contact\s*number/i, get: p => p.identity?.phone,
    not: /emergency|next\s+of\s+kin|guardian|\breferr|\brelative|\breference|\bsupervisor|phonetic|pronunci/i },
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
  { re: /(name|e-?mail(\s+address)?|phone|contact)\s+of\s+(the\s+)?referr(er|al|ing)|referr(er|ing)('?s)?\s+(employee\s+)?(name|person|e-?mail|phone|contact)|who\s+referred\s+you/i,
    blank: true, why: 'no referral for this posting — nobody referred him, so there is no name to give' },
  // …UNLESS THE FORM SAYS WHAT TO WRITE. "If you were referred by a Cornelis
  // Network's employee, input the employee's name here. If not, put N/A."
  // (BambooHR, 2026-09-24) — a blank there is the wrong answer; the form asked
  // for "N/A". Only for the two follow-ups whose condition is known false.
  { re: /referr[^?]{0,200}\bif\s+not\b[^.?]{0,20}\b(put|enter|write|type|input|say)\s*[:"'“]?\s*n\s*\/?\s*a\b/i,
    get: (p) => (/^\s*no\b/i.test(String(p.answers?.employee_referral || '')) ? 'N/A' : undefined) },
  { re: /relative[^?]{0,200}\bif\s+not\b[^.?]{0,20}\b(put|enter|write|type|input|say)\s*[:"'“]?\s*n\s*\/?\s*a\b/i,
    get: (p) => (/^\s*no\b/i.test(String(p.answers?.relatives_at_company || '')) ? 'N/A' : undefined) },
  // THE FOLLOW-UPS TO "DO YOU HAVE RELATIVES HERE?" — he has none, so they are
  // blank. TSMC, live 2026-09-24: "Name of Relatives" and "Relationship of
  // Relatives" were both typed **"No"** by the relatives rule further down.
  // If `relatives_at_company` ever becomes Yes, these are his to write.
  // …and "If you have direct relatives working at Honda, please provide their
  // name(s) and location(s)" (2026-10-02).
  { re: /(name|relationship|department|position|title)s?\s+(of|to)\s+(the\s+|your\s+)?relatives?\b|relatives?('?s)?\s+(name|relationship|department|position)|\bif\s+you\s+have\b[^?]{0,40}\brelatives?\b[^?]{0,80}\bprovide\s+their\b/i,
    blank: true, why: 'no relatives at the company, so there is no name or relationship to give' },
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
  // + Western Digital's "Are you currently party to any employment, consulting
  // or personal services agreement that (i) restricts…" (2026-09-24).
  // SAMSUNG'S QUESTIONNAIRE, 2026-09-25 — each left for him, each answered by
  // him on the form (answer log): the patent question No, its "Type NA if you
  // answered No" follow-up NA, "a full-time employee at another Samsung
  // subsidiary" No, and the confidentiality statement to INITIAL, LGVH.
  { re: /\b(seeking|plan(ning)?\s+to\s+seek|applied\s+for|filed|file|pending)\b.{0,30}\bpatents?\b/i,
    not: /\bexplain\b|\bdescribe\b|\blist\b/i, get: () => 'No' },
  { re: /\btype\s+n\/?a\s+if\s+you\s+answered\s+no\b/i, get: () => 'NA' },
  { re: /\b(currently\s+)?(a\s+)?(full[- ]time\s+|part[- ]time\s+)?employee\s+(at|of|with)\s+(another|any\s+other|an?\s+other)\b.{0,50}\b(subsidiar|affiliat)/i, get: () => 'No' },
  { re: /\bplease\s+initial\b|\benter\s+your\s+initials\b|\byour\s+initials\b|\binitial\s+(here|below|to\s+acknowledge)\b/i,
    get: p => p.identity?.initials || p.answers?.initials },
  // A RADIO GROUP LABELLED BY ITS OWN FIRST OPTION (Standard Bots, 2026-09-25):
  // "Yes, I currently live within daily commuting distance of Glen Cove, NY."
  // He lives in Springfield; he answered the "do not … but I am willing to
  // relocate" option.
  { re: /\blive\s+within\s+(a\s+)?(daily\s+|reasonable\s+)?commut(ing|able)\s+distance\b/i,
    not: /\bspringfield\b/i, get: () => ['I do not currently live within daily commuting distance', 'willing to relocate', 'No'] },
  // "ABLE TO COMMUTE … WITHOUT HAVING TO RELOCATE?" (Capstan Medical, Santa
  // Cruz, 2026-09-26) was answered YES by the relocation rule — "relocate" was
  // in the sentence, and he IS willing to relocate — which told them he lives
  // within reach of Santa Cruz. He lives in Springfield: a commute anywhere else
  // is No, and the form's own "No - I would need to relocate" is the one that
  // says it. A place that is his own city or state is his to answer.
  // Not "willing to relocate AND commute" (General Matter): that asks whether
  // he will move, and he will — the relocation rule answers it.
  { re: /\b(able|willing)\s+to\s+commute\b|\bcommute\s+(daily\s+)?(to|into)\s+(our|the|this)\b|\bwithout\s+(having\s+to\s+)?relocat/i,
    not: /\bwilling\s+to\s+(relocate|move)\b|\brelocate\s+(and|or|&)\s+commute\b|\bcommute\s+or\s+relocate\b/i,
    get: (p, text) => {
      const home = [p.identity?.city, p.identity?.state].filter(Boolean).map((s) => String(s).toLowerCase());
      // "…commute to this location?" names no place: the job's own location
      // decides, when the planner has it.
      const t = `${String(text || '')} ${/\bthis\s+(location|office|site)\b/i.test(String(text || '')) ? String(p.jobLocation || '') : ''}`.toLowerCase();
      if (/\bthis\s+(location|office|site)\b/.test(t) && !String(p.jobLocation || '').trim()) return undefined;
      if (!home.length || home.some((h) => t.includes(h)) || /\bremote\b/.test(t)) return undefined;
      return ['No - I would need to relocate', 'No, I would need to relocate', 'I would need to relocate', 'No'];
    },
    review: true },
  // "Please indicate your current status." with citizenship categories for
  // options (ASML, 2026-09-25): he answered "All others, including: Visa
  // Holder; …". Only when the label says STATUS and nothing about employment.
  { re: /\b(indicate|select|what\s+is)\s+your\s+current\s+(immigration\s+|citizenship\s+|residency\s+|legal\s+)?status\b/i,
    // …and on Intel's list he chose "F-1", and in Viavi's text box he wrote
    // his F-1 / OPT / STEM note (2026-09-24, 26). The text first — a box
    // takes it — then F-1, then ASML's categories as the last resort.
    // A citizen or permanent resident gets their own status, never his F-1 list.
    not: /\bemploy|\bstudent\b|\bmarital\b|\bapplication\b/i,
    get: (p) => (statusIsCitizenOrResident(p)
      ? [String(p.answers.citizenship_status).trim(), ...(/\b(permanent\s+resident|green\s*card)\b/i.test(p.answers.citizenship_status)
        ? ['Permanent Resident', 'Lawful Permanent Resident', 'Green Card Holder']
        : ['U.S. Citizen', 'US Citizen', 'Citizen'])]
      : [String(p.answers?.visa_status_note || '').replace(/\s+/g, ' ').trim(), 'F-1', 'F-1 Student', 'F-1 Student Visa', 'Student Visa', 'All others', 'Visa Holder', 'Non-immigrant visa', 'Other'].filter(Boolean)), review: true },
  // "Country of citizenship and/or permanent residency and the year granted":
  // his answer on ASML's form, 2026-09-25.
  { re: /\bcitizenship\b.{0,60}\byear\b|\byear\b.{0,40}\b(granted|obtained)\b.{0,40}\bcitizenship\b/i, get: p => p.answers?.citizenship_with_year },
  { re: /^\s*county\s*\*?\s*$/i, get: p => p.identity?.county || p.answers?.county },
  { re: /agreement\s+between\s+you\s+and\s+(your\s+)?(any\s+)?(current|former|previous|other)|non-?compete|restrictive\s+covenant|\bbonded\s+by\b|signed\s+an?\s+agreement\s+with\s+any\s+(current\s+|former\s+)?employer|engage\s+in\s+competition|patent\s+obligations|party\s+to\s+any\s+(employment|consulting|personal\s+services|non-?solicit)[^?]{0,80}\bagreement/i,
    get: p => p.answers?.employer_agreement, review: true },
  // ABB's Workday questionnaire, 2026-09-24 — all left for him that night, and
  // answered by him on the form; those answers are now in his profile.
  // …and TSMC's "perform the essential JOB functions and job duties without
  // any special requests or accommodations" (2026-09-24).
  { re: /perform\s+(all\s+)?(of\s+)?the\s+essential\s+(job\s+)?functions/i, get: p => p.answers?.essential_functions },
  { re: /(contacted|contact\s+you|hear\s+from\s+us)\b.{0,40}\bfuture\s+(job\s+)?(opportunit|openings|roles|positions)|future\s+(job\s+)?opportunit.{0,40}\b(contact|reach)/i,
    get: p => p.answers?.future_contact },
  { re: /\bnotice\s+period\b/i, get: p => p.answers?.notice_period },
  // The conditional opening ("If you are under 18 years of age, …") is trimmed
  // before rules run, so the bare "do you have a work permit" must match too.
  // "Do you possess a valid work permit / residency permit in the country for
  // which the position resides?" (HPE, Workday, 2026-09-26): he typed Yes to
  // both himself. Ahead of the under-18 working-papers rule below (F-623).
  { re: /\b(possess|hold|have)\s+(a\s+)?valid\s+work\s+permit\b[^?]{0,80}\bcountry\b/i,
    get: p => p.answers?.work_permit ?? p.answers?.authorized_to_work_us, review: true },
  { re: /\b(possess|hold|have)\s+(a\s+)?valid\s+residen(ce|cy)\s+permit\b/i,
    get: p => p.answers?.residency_permit, ask: 'answers.residency_permit', review: true },
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
  // "Where did you hear about us? (e.g., LinkedIn, job board, referral)" is not
  // a request for his LinkedIn URL — Nudge, 2026-09-24, got the URL and he typed
  // "LinkedIn" over it. The how-heard rule further down owns it.
  { re: /linkedin/i, get: p => p.identity?.linkedin,
    not: /(how|where)\s+did\s+you\s+(\w+\s+)?(hear|find|learn)|how\s+did\s+you\s+find\s+out|referral\s+source|\be\.?g\.?,?\s+linkedin/i },
  // HE HAS NO GITHUB, and a GitHub box stays EMPTY. It used to get the
  // portfolio (2026-09-20: "use the portfolio for every link field"); on
  // Exowatt's Lever form, 2026-09-24, he cleared alexrivera.example out of
  // "GitHub URL" and put it in the portfolio box instead. His hand wins: a
  // portfolio address in a GitHub field reads as a mistake.
  // "WHERE CAN WE FIND MORE INFORMATION ABOUT YOU? (e.g., personal website,
  // GitHub, x.com)" — Nudge, 2026-09-24: the GitHub rule below saw "GitHub"
  // in the examples and left it blank; he typed his portfolio. A request for
  // somewhere to read about him gets the portfolio.
  { re: /\b(more\s+(information|info)|learn\s+more|read\s+more)\s+about\s+you\b|\bwhere\s+can\s+we\s+(find|see|learn|read)\b/i,
    get: p => p.identity?.portfolio || p.identity?.website },
  // An education entry's "Graduated" tick (Oracle, Cummins 2026-10-02): not
  // until his graduation month has passed.
  { re: /(^|—\s*)(graduated|degree\s+(completed|conferred))\s*\??\s*$/i,
    get: (p) => {
      const when = Date.parse(`1 ${String(p.education?.graduation || p.answers?.graduation || '').trim()}`);
      if (!when) return undefined;
      return Date.now() > when + 31 * 86400e3 ? 'Yes' : 'No';
    } },
  // Oracle's numbered "Links" block — "Link 1", "Link 2", nothing else said
  // (Cummins, 2026-10-02, left blank). What he typed into them by hand on that
  // form: LinkedIn first, then "https://alexrivera.example" — the scheme
  // written out there, by him.
  { re: /^\s*link\s*1\s*$/i, get: p => p.identity?.linkedin },
  { re: /^\s*link\s*2\s*$/i,
    get: (p) => { const u = String(p.identity?.portfolio || p.identity?.website || '').trim(); return u ? (/^https?:\/\//i.test(u) ? u : `https://${u}`) : undefined; } },
  // …unless the same box also takes a portfolio or website: Luma AI's
  // "Portfolio/GitHub/Website" (2026-09-29) went out blank, and he typed his
  // portfolio into it. The website rule below answers it.
  { re: /github|\bgit\s*hub\b|source\s*(code)?\s*(repo|repository)|\brepo(sitory)?\s*(link|url)\b|(link|url)\s*to\s*(your\s*)?\brepo(sitory)?\b/i,
    not: /portfolio|website|personal\s*site/i,
    blank: true, why: 'he has no GitHub — the portfolio goes in the portfolio box, not here' },
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
  // WHICH KIND: a website when the list says so, else "Other". Tesla offers
  // [Portfolio, LinkedIn, Indeed, Other]; the engine chose Portfolio and he
  // changed it to Other (2026-09-24). "Portfolio" stays last, for a list that
  // offers nothing else that fits.
  { re: /(profile|portfolio|website|personal\s*site)\s*(link|url)?\s*type\b|type\s*of\s*(profile|link)\b/i,
    get: () => ['Personal Website', 'Website', 'Other', 'Portfolio'] },
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
  // WHERE HE WANTS TO WORK IS NOT WHERE HE LIVES. TSMC, live 2026-09-24:
  // "Location Desired" on a Phoenix posting was typed **"Springfield,
  // Washington"** by the rule below (`^location\b.{0,20}$`). He is applying
  // to this job, so its own location is the one he wants; with no posting in
  // hand, his stated region.
  { re: /(desired|preferred)\s+(work\s+|job\s+)?location|location\s+(desired|preferred|of\s+interest)|where\s+would\s+you\s+(like|prefer)\s+to\s+work/i,
    // The CITY too: Western Digital's menu reads "California - San
    // Jose/Milpitas/…", which the city matches and "San Jose, CA, United
    // States" does not — and never the state alone, which picks Irvine.
    get: (p) => {
      const loc = String(p.jobLocation || '').trim();
      const city = loc.split(',')[0].trim();
      // Full place first (a text box takes it); a menu falls through to the city.
      return [loc, city && city !== loc ? city : '', p.answers?.preferred_region].filter(Boolean);
    },
    review: true },
  // "City and State" / "City, State" (BETA Technologies' Greenhouse form,
  // 2026-10-04, left for him) — only "City & State" was known.
  { re: /current\s*(location|city)|^location\b.{0,20}$|city\s*(&|and|,|\/)?\s*state|where\s+(are|do)\s+you\s+(currently\s+)?(located|based|live|reside)/i,
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
  // …and ASM's "Please select the country where you hold citizenship /
  // permanent residency" (2026-09-24): he holds no permanent residency
  // anywhere (permanent_resident_elsewhere: No), so it is his citizenship.
  { re: /country\s*(\/|-|\s+or\s+)?\s*(region\s+)?(of\s+)?(citizenship|citizen|nationalit|passport)(?!\s*status)|country\s+(where|in\s+which)\s+you\s+(hold|have)\s+(your\s+)?(citizenship|nationality)/i,
    get: citizenshipCountry, review: true },
  { re: /^country\s*(\/|-|\s+or\s+)?\s*(of\s+|region\s+of\s+)?(birth|origin)/i,
    get: () => undefined },
  { re: /(citizenship|nationality)\s*(country)?$/i, get: citizenshipCountry, review: true },
  // Greenhouse's new boards put a "Country" picker in front of the phone
  // number whose options are dial codes; Lexington and Divergent (2026-09-24)
  // both went out with "+1", chosen by hand, after "United States of America"
  // found nothing. A real country list takes the first spelling that it has.
  { re: /^country\b.{0,26}$/i,
    get: (p) => {
      const c = String(p.identity?.country || '').trim();
      return /^united states/i.test(c) ? [c, 'United States', 'USA', '+1'] : p.identity?.country;
    } },
  // WHERE HE IS NOW, asked as a sentence (Amazon, 2026-09-26, both answered by
  // hand): "What country/region are you currently located?" is his country;
  // "Are you currently located outside of the United States?" is No while his
  // address is American. Not "where are you willing to work" — that is a place
  // he would go, and the relocation rules own it.
  { re: /\bwhat\s+(country|country\s*\/\s*region|region)\b[^?]{0,30}\b(are\s+you|do\s+you)\s+(currently\s+)?(located|based|live|living|reside|residing)\b/i,
    get: (p) => {
      const c = String(p.identity?.country || '').trim();
      return /^united states/i.test(c) ? [c, 'United States', 'USA'] : (c || undefined);
    } },
  { re: /\bare\s+you\s+(currently\s+)?(located|based|living|residing)\s+outside\s+(of\s+)?the\s+(united\s+states|u\.?s\.?a?\.?)\b/i,
    get: (p) => (/^united states|^usa?$/i.test(String(p.identity?.country || '').trim()) ? 'No' : undefined) },
  // Workday's address block calls the state "Region" on some tenants (Viavi,
  // 2026-09-24: left for him, he picked Washington). Only the bare word — a
  // "region you prefer" question is somewhere else entirely.
  // "What is your State or Province?" (a live form, left for him; Haiku named
  // it, 2026-09-24) — the question form of the same field.
  { re: /^(state|province)\b.{0,24}$|^state\s*\/\s*province\b|^\s*region\s*\*?:?\s*$|^\s*what\s+is\s+your\s+(state|province)(\s+or\s+(state|province))?\s*\??\s*\*?$/i, get: p => p.identity?.state },

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
  // in school?" — a Yes/No dropdown — was answered **"Lakeside University"**,
  // because this rule sits above the campus-recruiting rules and matches first.
  // The same shape as the `\bopt\b` and bare `/major/` bugs already recorded
  // here: a broad word, a question it does not belong to, a false answer on a
  // real form. Anything that ASKS ABOUT school rather than asking WHICH school
  // is left to the rules written for it.
  // WHERE THE SCHOOL IS, not which one. SmartRecruiters' education block has
  // "School location" (Western Digital, 2026-09-24), and the rule below typed
  // "Lakeside University" into a place search. cv.md: Lakeside University —
  // Springfield, Washington.
  { re: /(school|university|college|institution|campus)\s*(location|city|address|state)|location\s+of\s+(your\s+)?(school|university|college)/i,
    get: p => p.education?.location },
  // Honda's "School/College/University" is a fixed list of US schools; where
  // his is not on it, "Other" is the true pick (2026-10-02: left unanswered).
  { re: /^\s*school\s*\/\s*college\s*\/\s*university\s*$/i,
    get: p => [...new Set([p.education?.school, schoolShortName(p.education?.school), 'Other'].filter(Boolean))], review: true },
  // THE KIND OF SCHOOL, not its name (Paylocity, Optomec F-691): "School
  // Type" offered High School … College / University, and got "Lakeside University".
  { re: /^\s*(school|institution|education)\s+type\s*\*?$|^\s*type\s+of\s+(school|institution)\s*\*?$/i,
    get: () => ['College / University', 'University', 'College', '4 Year College', 'Four Year College'] },
  { re: /school|university|college|institution|where\s+(did|do)\s+you\s+study/i,
    // `would` was the missing auxiliary, and it cost a real answer on Amazon's
    // form: "…would you require CPT authorization FROM YOUR SCHOOL…" was
    // answered **"Lakeside University"** — the exact failure this guard was
    // written to stop, one verb short. `from your school` is named outright
    // too, because there the school is the SOURCE of an authorization, never
    // the thing being asked for.
    // …and a request for PROSE that mentions school is not asking which one.
    // TSMC, live 2026-09-24: "Share with us your experience in process
    // improvements… from work, school courses or internship." — a required
    // 500-character essay box — was filled **"Lakeside University"**.
    // …and a STATEMENT to agree to that names institutions: ASM's "I hereby
    // authorize ASM to contact … all previous employers, educational
    // institutions and references" (2026-09-25) was planned "Lakeside
    // University" on a Yes-only list.
    not: /^\s*i\s+(hereby|understand|agree|acknowledge|certify|consent|authori[sz]e)\b|\bauthori[sz]e\b|\brelease\s+from\s+liability\b|\bgovernment\b|\bpublic\s+institution\b|\bemployment\s+experience\b|^\s*i\s+have\b|^\s*are\s+you\b|^\s*(do|did|will|would|should|could|can|have|is|was)\s+you|^\s*which\b|\bfrom\s+(your|the)\s+school\b|\bstill\s+(in|attending)\b|\bcurrently\s+(enrolled|attending|a\s+student)\b|\b(status|term|semester|quarter|year)\b|\bgraduat|\b(share|describe|explain|discuss|tell\s+us)\b|\byour\s+experience\s+(in|with|of)\b/i,
    get: p => p.education?.school },
  // …and the degree itself after the level, for a menu that lists degrees:
  // Western Digital offers "Bachelors of Science" and no "Bachelor's"
  // (2026-09-24). A free-text box still gets the level.
  // "Expected graduation YEAR for your highest planned degree" is a year, not
  // a level: it got "Bachelor's" (2026-09-24/25). Asked before the level rule.
  { re: /\bgraduation\s+year\b|\byear\s+of\s+graduation\b|\bgraduat\w*\s+in\s+what\s+year\b/i,
    not: /\bmonth\b|\bdate\b/i,
    get: p => p.education?.graduation_year || String(p.education?.graduation || '').match(/\d{4}/)?.[0] },
  // "Are you a new grad?" — his profile says New College Graduate.
  { re: /^\s*are\s+you\s+(a\s+)?(recent|new)\s+(college\s+)?grad(uate)?\b/i,
    get: p => (/new\s+college\s+grad/i.test(String(p.answers?.opportunity_type || '')) ? 'Yes' : undefined) },
  // "Have you received your last degree within the past 12 months or will you
  // be receiving your degree within the next 12 months?" (HP, 2026-09-26): his
  // graduation month against today, either side.
  { re: /\b(received|receiving|complete[ds]?|earn(ed)?)\s+(your\s+)?(last\s+|most\s+recent\s+)?degree\b[^?]{0,40}\b(past|last|next)\s+(12|twelve)\s+months\b/i,
    get: p => {
      const m = String(p.education?.graduation || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(20\d{2})\b/i);
      if (!m) return undefined;
      const grad = new Date(`${m[1]} 1, ${m[2]}`);
      const months = Math.abs((grad.getFullYear() - new Date().getFullYear()) * 12 + grad.getMonth() - new Date().getMonth());
      return months <= 12 ? 'Yes' : 'No';
    }, review: true },
  // "Do you have a high school diploma or GED?" — a bachelor's student has
  // one; admission to his degree required it.
  { re: /^\s*(do\s+you\s+(have|hold|possess)|have\s+you\s+(completed|earned|obtained|received))\s+(a\s+|your\s+)?(high\s+school(\s+(diploma|degree|education))?|ged)\b[^?]{0,40}\??\s*\*?$/i,
    get: p => (/bachelor/i.test(`${p.education?.degree_level || ''} ${p.education?.degree || ''}`) ? 'Yes' : undefined) },
  // "Are you located in US?" (HP, 2026-09-26) — where he lives now.
  { re: /^\s*are\s+you\s+(currently\s+)?(located|based|living|residing)\s+in\s+(the\s+)?(us|u\.\s?s\.?|usa|united\s+states(\s+of\s+america)?)\s*\??\s*\*?$/i,
    get: p => (/united\s+states|^usa?$/i.test(String(p.identity?.country || '')) ? 'Yes' : undefined) },
  { re: /highest.*(level|degree)|education\s+(level|completed)|level\s+of\s+education|what\s+degree\s+(are\s+you\s+)?(pursu|seek|work)/i,
    get: p => [p.education?.degree_level, p.education?.degree, ...bachelorSpellings(p)].filter(Boolean) },
  { re: /degree\s*(type|level)?$|^(diploma\s+or\s+)?degree\s+(obtained|earned|received|pursued)$/i, get: p => [p.education?.degree, p.education?.degree_level, ...bachelorSpellings(p)].filter(Boolean) },
  // SUCCESSFACTORS' OWN NAMES (Celestica, 2026-09-27, F-623): "Candidate
  // State", "Candidate City", "Education Country", "Education City",
  // "Address/Street/Apt/Unit#", "Currency" — each in his profile, each left
  // for him on the first press.
  { re: /^(candidate|current|home|residence|residential)\s+(state|province)(\s*\/\s*(state|province))?$/i, get: p => p.identity?.state },
  { re: /^(candidate|current|home|residence|residential)\s+city$/i, get: p => p.identity?.city },
  { re: /^(candidate|current|home|residence|residential)\s+country(\s+of\s+residence)?$/i, get: p => p.identity?.country },
  { re: /^(education|school|institution|university|college)\s+country$/i,
    // His one school is Lakeside, in Springfield, Washington (education.location).
    get: p => (String(p.education?.location || '').trim() ? 'United States' : undefined) },
  { re: /^(education|school|institution|university|college)\s+city$/i, get: p => String(p.education?.location || '').split(',')[0].trim() || undefined },
  { re: /^(education|school|institution|university|college)\s+(state|province)$/i, get: p => String(p.education?.location || '').split(',')[1]?.trim() || undefined },
  // One box for the street, the apartment and the unit: the whole street line.
  { re: /^address\s*\/\s*street|^street\s*\/\s*(apt|apartment|unit)|^(street\s+)?address[^?]{0,20}\b(apt|apartment|unit|suite)\b/i,
    not: /\baddress\s+line\s*(2|two)\b/i,
    get: p => [p.identity?.address_line1, p.identity?.address_line2].map((s) => String(s || '').trim()).filter(Boolean).join(' ') || undefined },
  // A currency list beside a salary: his target is in US dollars.
  // HOW THE AMOUNT IS PAID, not the amount (Paylocity's "Desired Salary Type":
  // -- | Hourly | Yearly, given "$90000/year", Optomec F-691). His figure is a year's.
  { re: /^\s*(desired\s+|expected\s+)?(salary|pay|compensation|wage)\s+(type|basis|frequency|period|unit)\s*\*?$/i,
    get: () => ['Yearly', 'Annual', 'Annually', 'Per Year', 'Salary', 'Salaried'] },
  { re: /^(salary\s+|pay\s+|compensation\s+)?currency(\s+type)?$/i,
    get: () => ['USD', 'US Dollar', 'USD - US Dollar', 'U.S. Dollar', 'United States Dollar', 'USD ($)'], review: true },
  // "major" must be about study. The disability question asks about "your major
  // life activities", and a bare /major/ fed "Mechanical Engineering" into it —
  // same class of bug as \bopt\b matching "opt out". Keep the negative lookahead.
  // The broader family, after the exact name, for a menu that has no
  // Mechanical Engineering: Divergent's Greenhouse list, 2026-09-24, where he
  // picked "Engineering" by hand. Never a DIFFERENT discipline.
  // "DO YOU HAVE a Bachelor's degree in engineering (Mechanical, Electrical, …
  // or a related discipline)?" (Re:Build, 2026-09-26) is a yes/no about
  // holding the degree, and the discipline rule below took it on the word
  // "discipline" and offered majors. He graduates May 2027: whether he says
  // Yes before then is his call, asked once.
  { re: /^\s*do\s+you\s+(currently\s+)?(have|hold|possess)\s+(a|an)\s+(bachelor'?s?|b\.?\s?s\.?|undergraduate|4[-\s]year)\b[^?]{0,20}\bdegree\b/i,
    get: (p) => p.answers?.has_bachelors_degree, ask: 'answers.has_bachelors_degree', review: true },
  // …and "Mechanical Engineering Technology" was offered here as a fallback
  // (2026-09-25) against this rule's own words: it is a different accredited
  // degree, and a list holding it with no Mechanical Engineering would have
  // put it on his application. Removed 2026-09-26, and "Engineering" with it:
  // the matcher reads a bare "Engineering" into "Engineering - Civil" or
  // "Electrical Engineering" on a list with no Mechanical — a wrong major is
  // worse than a blank. Such a list is his (Divergent's plain "Engineering",
  // which he picked by hand, included).
  { re: /discipline|field\s*of\s*study|area\s*of\s*study|course\s*of\s*study|\bmajors?\b(?!\s*life)/i,
    get: (p) => {
      const d = String(p.education?.discipline || '').trim();
      return /^mechanical engineering$/i.test(d) ? [d, 'Engineering, Mechanical'] : p.education?.discipline;
    } },
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
  // …and a menu that pairs months: Lexington offered "May/June 2027" and the
  // prompt had only "May 2027" to search with (2026-09-24, he picked it by
  // hand). A free-text box still takes the first spelling.
  { re: /graduat(e|ion).*(date|year)|expected.*graduat|when.*graduat/i,
    not: /\b(term|semester|quarter|season)\b/i,
    get: (p) => {
      const g = String(p.education?.graduation || '').trim();
      const m = g.match(/^(May|June)\s+((?:19|20)\d{2})$/i);
      return m ? [g, `May/June ${m[2]}`, `Spring ${m[2]}`] : p.education?.graduation;
    } },

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
    // …nor "how many months of work authorization do you have remaining",
    // which names H-1B only in its note (Intel 11c, 2026-09-26).
    not: /\bsponsor|\bhow\s+many\s+months\b|\bmonths\s+of\s+(work\s+)?authori/i,
    get: p => p.answers?.held_h1b, review: true },
  // "Have you ever relinquished, abandoned, or lost citizenship, nationality or
  // permanent residence in the country identified in the previous question?"
  // (ASM, 2026-09-25) — his answer, given directly: No.
  { re: /\b(relinquish\w*|renounc\w*|abandon\w*|lost|revoked)\b[^?]{0,40}\b(citizenship|nationality|permanent\s+residen\w*)/i,
    get: p => p.answers?.relinquished_citizenship, ask: 'answers.relinquished_citizenship', review: true },
  // "Are there any circumstances that would prevent you from being granted
  // entry to another country?" (Celestica, 2026-09-27). Read as "willing to
  // travel?" by the leftover pass it went out YES — "something prevents me" —
  // on an application (F-623). A question about his record and his passport:
  // his answer, never a guess.
  { re: /\bcircumstances?\b[^?]{0,60}\bprevent\s+you\b[^?]{0,40}\b(entry|entering|admission|admitted|visa)\b|\bprevent(ed)?\s+you\s+from\s+(being\s+)?(granted\s+)?(entry|entering|admission)\b|\b(denied|refused)\s+(entry|a\s+visa|admission)\b/i,
    get: p => p.answers?.entry_barrier, ask: 'answers.entry_barrier', review: true },
  // "Do you currently have an active immigration case (ex H-1B extension,
  // green card)?" (Applied Intuition, 2026-09-25). A PENDING petition is not
  // what held_h1b / permanent_resident_elsewhere say, so it is not inferred
  // from them; the key that answers it is named instead.
  { re: /\b(active|pending|open)\s+(immigration\s+)?(case|petition|application)\b[^?]{0,80}\b(h-?1b|green\s*card|immigra|visa|uscis)|\bimmigration\s+(case|petition)\b/i,
    not: /\bsponsor/i,
    get: p => p.answers?.active_immigration_case, ask: 'answers.active_immigration_case', review: true },
  { re: /\b(held|hold|holding|have\s+you\s+ever\s+had|had)\b[^?.;]{0,40}\bj-?1\b|\bj-?1\b[^?.;]{0,30}\bstatus\b|\bexchange\s+visitor\b/i,
    not: /\bsponsor/i,
    get: p => p.answers?.held_j1, review: true },
  // "Curricular Practical Training" — the school-authorised route an F-1 uses
  // BEFORE graduating. He is pursuing post-graduation roles only, so the
  // answer is No and OPT is the route. Matched ahead of the work-auth block
  // because the question says "authorization … to be able to work".
  { re: /curricular\s+practic\w*\s+training|\bcpt\b/i, not: /\bsponsor/i, get: p => p.answers?.requires_cpt, review: true },
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
  // "no-compete" (Prysmian) and "commitments to another entity … that would
  // restrict your work" (Brooks) — the same question, 2026-10-03.
  { re: /\bno(n)?-?\s?compet(e|ition)|restrictive\s+covenant|\bcommitments?\s+to\s+(another|any\s+other)\s+(entity|business|person|employer|company)\b/i, get: p => p.answers?.non_compete, review: true },
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
  // "Do you have legal RIGHTS to work in the USA?" — the plural (Graphcore,
  // 2026-09-25) was left for him.
  // PROOF, NOT STATUS. "If hired, can you provide proof of eligibility?" (Onto
  // Innovation, 2026-09-29) asks whether he can show the documents — the I-9
  // step — and he can: his OPT EAD is that proof. He answered Yes by hand.
  { re: /\b(provide|submit|furnish|produce|show)\s+(proof|documentation|documents|verification|evidence)\s+of\s+(your\s+)?(employment\s+)?(eligibility|identity\s+and\s+(employment\s+)?eligibility|work\s+authori[sz]ation)\b/i,
    get: p => p.answers?.can_provide_work_proof ?? 'Yes' },
  // "legally permitted" (Onto Innovation, 2026-09-29) is the same question; he
  // answered Yes by hand.
  { re: /authorized\s+to\s+work|legally\s+(able|authorized|permitted)|work\s+authorization|eligible\s+to\s+work|(legally\s+)?eligible\s+for\s+employment|(unrestricted|legal)\s+rights?\s+to\s+work|rights?\s+to\s+work\s+in/i,
    // A QUANTITY is not a yes/no: Intel's "How many months of work
    // authorization time do you have remaining?" got "Yes" (2026-09-24).
    not: /\bhow\s+(many|much|long)\b|\bmonths?\s+(of|remaining|left)\b/i,
    // A list of STATEMENTS instead of Yes/No (Lyft: "I am authorized to work
    // for any employer…" / "I require/will require Lyft's sponsorship…",
    // 2026-09-24) matches no "Yes"; the second alternative is the statement
    // his sponsorship answer makes true. A text box still gets the first.
    get: p => (/^yes$/i.test(String(p.answers?.require_sponsorship || '')) && p.answers?.authorized_to_work_us
      ? [p.answers.authorized_to_work_us, 'I require sponsorship']
      : p.answers?.authorized_to_work_us),
    review: true },
  // NVIDIA asks this without the word "sponsorship": "Will you require employer
  // support to obtain or maintain authorization to work in that country?"
  { re: /sponsor(ship)?|require\s+employer\s+support|employer\s+support\s+to\s+(obtain|maintain)/i,
    get: p => p.answers?.require_sponsorship, review: true },
  // "Protected individual" (8 USC 1324b(a)(3)) is the export-control question in
  // Greenhouse's wording, and its answer set is "None of the above" rather than
  // Yes/No. He is an F-1 student, so none of the classifications apply.
  // …and as a Yes / No confirmation ("Please confirm that you are either: (a)
  // a U.S. citizen; (b) … or (3) protected individual", Apptronik, 2026-09-26):
  // "None of the above" matched nothing, and the answer is No.
  { re: /protected\s+individual/i,
    get: (p) => { const v = p.answers?.protected_individual; return /^none of the above$/i.test(String(v || '')) ? [v, 'No'] : v; },
    review: true },
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
  // WHERE HE LIVES, ASKED AS A YES/NO. "Do you currently reside in the
  // Sacramento Area?" (Peak Energy, 2026-09-24) sat in the ledger as his; his
  // city and state settle it. A place his profile does not name is a No only
  // when the question names a place at all.
  { re: /^\s*(do|are)\s+you\s+(currently\s+)?(reside|live|located|based)\s+(in|within|near)\s+(the\s+)?(.{3,60}?)(\s+(area|region|metro(politan)?(\s+area)?))?\s*\??\s*$/i,
    not: /\bwilling\b|\brelocat|\bcommute\b|\bunited\s+states\b|\bu\.?s\.?\b|\busa\b|\bcountry\b/i,
    get: () => undefined, residence: true },
  // CITIZENSHIP OF THE COUNTRY HE WOULD WORK IN. Western Digital,
  // 2026-09-24: "Are you a citizen of the country you'll be employed in?" — he
  // is a citizen of Vietnam applying to U.S. roles.
  // "Are you a citizen of the United States?" (ReLogic's BambooHR form,
  // 2026-09-26) had no rule at all. His citizenship decides it — Vietnam, so
  // No — always for review. The full U.S.-person list (citizen OR permanent
  // resident OR asylee) is the rule below this one, not this.
  { re: /\bare\s+you\s+an?\s+(u\.?\s?s\.?|united\s+states|american)\s+citizen\b|\bare\s+you\s+a\s+citizen\s+of\s+the\s+(u\.?\s?s\.?|united\s+states)(\s+of\s+america)?\s*\??\s*$/i,
    not: /permanent\s+resident|green\s*card|asyl|refugee|or\s+a\s+/i,
    get: (p) => {
      const c = String(p.answers?.citizenship_country || '').trim();
      if (!c) return undefined;
      return /^(united states|usa|us|u\.s\.)/i.test(c) ? 'Yes' : 'No';
    },
    review: true },
  { re: /are\s+you\s+a\s+citizen\s+of\s+the\s+country\s+(you['’]?ll|you\s+will|you\s+would|where\s+you)/i,
    get: (p) => {
      const c = String(p.answers?.citizenship_country || '').trim();
      if (!c) return undefined;
      return /^(united states|usa|us|u\.s\.)/i.test(c) ? 'Yes' : 'No';
    },
    review: true },
  // THE U.S.-PERSON DEFINITION, ASKED IN FULL: "Are you a citizen of the U.S.,
  // a lawful permanent resident of the U.S., or a non-U.S. citizen who has been
  // granted asylum or refugee status…?" (Western Digital) is exactly the
  // U.S.-person question, spelled out.
  // …and as a list to affirm: "I am one of the following: (a) a citizen of
  // the United States; (b) a lawful permanent resident of the United States;
  // or (c) a person admitted … as an asylee or refugee" (Atomic Semi,
  // 2026-09-25). The rules left it; the leftover-recogniser then called it
  // the work-authorization question and answered YES — a false claim that he
  // is a U.S. person. Named here so it never reaches the recogniser.
  { re: /citizen\s+of\s+the\s+(u\.?\s?s\.?|united\s+states)\b[^?]{0,60}?(lawful\s+)?permanent\s+resident/i,
    get: p => p.answers?.us_person, review: true },
  // A NOTICE ABOUT EXPORT DOCUMENTATION IS NOT "ARE YOU A U.S. PERSON?".
  // Wolfspeed, 2026-09-24: "This position requires the lawful ability to
  // access technical data … controlled by United States export control laws …
  // you will need to provide documentation confirming your nationality if an
  // offer … is extended" — the rule below answered it with his U.S.-person
  // answer, "No", and he sent "Yes". It asks whether he accepts that step, and
  // export control is not a disqualifier for him (CLAUDE.md; he has held an
  // export-controlled role). A question that asks his STATUS still goes below.
  { re: /(provide|submit)\s+(documentation|documents|proof)\s+(confirming|of|verifying)\s+(your\s+)?(nationality|citizenship|export)|requires?\s+the\s+lawful\s+ability\s+to\s+access/i,
    not: /\bare\s+you\s+a\s+u\.?s\.?\s+person\b|which\s+of\s+the\s+following\s+(applies|describes)|\bselect\s+(the\s+)?(one|option)\b/i,
    get: p => p.answers?.export_documentation_ok ?? 'Yes', review: true },
  // …and a bare "EXPORT COMPLIANCE" heading whose options are "I am currently
  // a U.S. Person" / "I am not a U.S. Person" (Relativity, 2026-09-26). The
  // answer stays a plain "No": spelled out as "I am not a U.S. Person" it
  // matched Machina's "…not a U.S. Person, but I am eligible for licensing",
  // a claim his files do not make.
  // The heading alone, anchored: ASM's consent statement mentions "the
  // company's export compliance obligations" and must stay a consent.
  // `\bitar\b`, a WORD: bare `itar` matched "mil-ITAR-y", so Micron's
  // protected-veteran notice ("…military service…") was answered from his
  // U.S.-person status and matched none of its four statements (stress round
  // 19, 2026-09-26). Self-identification notices are never this question.
  { re: /u\.?s\.?\s+person|export\s+(control|regulation)|\bitar\b|^\s*export\s+compliance\s*[:*]?\s*$/i,
    not: /\bprotected\s+veteran|\bveteran(s)?['’]?\s+(status|self-identification|readjustment)|\bself-identification\b[^?]{0,40}\bdisabilit/i,
    get: p => p.answers?.us_person, review: true },
  { re: /security\s+clearance/i, get: p => p.answers?.security_clearance, review: true },
  { re: /visa\s+status|immigration\s+status/i, get: p => p.answers?.visa_status_note, review: true },
  // OPT specifics. These are separate questions with opposite answers for him —
  // not currently ON OPT (still pre-graduation), but IS eligible for the STEM
  // extension — so the STEM rule must be tested first or the generic OPT rule
  // would answer both with "No".
  { re: /stem\b.*\b(extension|opt)|24[\s-]*month/i, not: /\bsponsor/i, get: p => p.answers?.stem_opt_extension_eligible, review: true },
  // NEVER match a bare "opt": the AI-screening notice says "you can choose to opt
  // out", and \bopt\b matched it, so that question resolved to the OPT-status
  // answer ("No") and the form got "No, I opt-out" — the opposite of his consent.
  { re: /optional\s+practical\s+training|\bcpt\b|(?:period\s+of|currently\s+on|are\s+you\s+on|status\s+of)\s+opt\b/i,
    // "How many months of work authorization time do you have remaining? If you
    // hold F-1 OPT…" (Intel) is a quantity, and was answered "No".
    not: /\bsponsor|\bhow\s+(many|much|long)\b|\bmonths?\s+(of|remaining)\b/i,
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
    // …and not the yes/no "Do you have the MINIMUM number of years of
    // experience for the job?" (Flowserve, 2026-10-03: got "2 years").
    not: /\b(explain|describe|tell us|elaborate|briefly|in your own words|why)\b|\bin\s+the\s+[a-z-]+\s+industry\b|\bexperience\s+(in|with)\s+(java|python|c\+\+|javascript|sql|sales|marketing|finance|nursing|teaching)\b|^\s*do\s+you\s+(have|meet)\s+(the\s+)?minimum\b/i },
  { re: /background\s+check|drug\s+screen|hiring\s+requirements|reference\s+check/i, get: p => p.answers?.background_check_consent, review: true },
  // Standing consents (Alex, 2026-07-29: "consent yes to everything"). AI-screening
  // notices are worded as an opt-OUT, so the consent answer must be Yes and the
  // opt-out left alone.
  // "Cummins would like to use tools, such as automated evaluation support
  // technologies, to help us…" (Oracle, 2026-10-02, required, left blank).
  { re: /artificial\s+intelligence|\bai\b.*(screen|match|assess)|automated\s+(decision|screening|evaluation|assessment)|evaluation\s+support\s+technolog/i,
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
  // A BARE "I accept" / "I agree" box — iCIMS' privacy acceptance on its email
  // screen (Werfen, 2026-09-24), the policy named only in a link beside it.
  // "Consent yes to everything" (2026-07-29). Short on purpose: a sentence
  // that goes on to state a FACT ("I agree that I am a U.S. citizen") is not this.
  // …and the box's own words after the sentence the reader found above it
  // ("Click here if you are an employee of Werfen … — I accept"): the box
  // says "I accept", whatever line of the notice sits over it.
  { re: /(^|—\s*)i\s+(accept|agree)(\s+(to\s+)?(the\s+)?(terms|terms\s+and\s+conditions|privacy\s+(policy|notice)|conditions))?\s*[.*]?\s*$/i,
    get: p => p.answers?.data_processing_consent ?? 'Yes', review: true },
  // "By continuing, you agree that you have read our Privacy Statement" (Enpro
  // on PageUp, 2026-10-02, left blank): agreement BEFORE the policy, and the
  // policy called a statement. Only the read-the-policy sentence, so a box that
  // agrees to a fact about him is not this.
  { re: /\b(agree|acknowledge|confirm)\b[^.?]{0,40}\bhave\s+read\b[^.?]{0,40}\bprivacy\s+(statement|notice|policy)\b/i,
    get: p => p.answers?.data_processing_consent ?? 'Yes', review: true },
  // "By submitting, you declare that you have read, understood, and accepted
  // the terms in this policy" (GlobalFoundries' Workday self-identify step,
  // 2026-10-16, left blank and the step refused to move — F-732). Read AND
  // accepted, of terms or a policy: a box that declares a fact is not this.
  { re: /\b(declare|confirm|acknowledge|agree|certify)\b[^.?]{0,40}\bhave\s+read\b[^.?]{0,60}\b(accept(ed)?|agree(d)?)\b[^.?]{0,40}\b(terms|policy|notice|statement|conditions)\b/i,
    get: p => p.answers?.data_processing_consent ?? 'Yes', review: true },
  // "Please review the linked document:" whose only option is "I acknowledge
  // that I have read and understood the terms of the Lyft Candidate Privacy
  // Notice" (Lyft, 2026-09-24): the policy is named only in the option, so the
  // label says nothing of consent. Same standing yes.
  // WORKING THERE NOW, IN ANY CAPACITY. Western Digital: "Are you currently
  // working for WD as a non-employee?" (2026-09-24). He works for none of the
  // employers he applies to; where his history names the employer, it is his.
  { re: /\bcurrently\s+(working|work|employed|engaged)\s+(for|at|with)\b[^?]{0,60}\b(non-?employee|contractor|consultant|contingent|temporary|temp|vendor|agency)/i,
    get: (p) => (employedAtApplyingTo(p) ? undefined : 'No'), review: true },
  // "…are you an existing HP employee?" (HP, 2026-09-26, left blank) and "Are
  // you a current <company> employee?" — the same standing No, the same guard.
  // "Are you a current Boeing (Spirit) Employee in Wichita, Tulsa, Or Dallas?"
  // (Spirit AeroSystems, 2026-10-02) — a bracketed name is a word too.
  { re: /\bare\s+you\s+(an?\s+)?(existing|current)\s+(?:[\w.&'()-]+\s+){0,4}(employee|team\s+member|worker)\b|\bare\s+you\s+(currently\s+)?(an?\s+)?(existing|current)\s+employee\s+of\b/i,
    not: /\bformer\b|\bever\b|\bpreviously\b|\bgovernment\b|\bdepartment\s+of\s+defen/i,
    get: (p) => (employedAtApplyingTo(p) ? undefined : 'No'), review: true },
  // "Are you currently working as an intern at Amazon?" (2026-09-26, answered
  // No by hand) — the same question in the shape of a role at the employer.
  { re: /\bare\s+you\s+currently\s+(working|employed|interning)\s+(as\s+an?\s+(intern|co-?op|contractor|employee)\s+)?(at|for|with)\b/i,
    not: /\bformer\b|\bever\b|\bpreviously\b|\bgovernment\b|\bany\b|\banother\b|\bother\b/i,
    get: (p) => (employedAtApplyingTo(p) ? undefined : 'No'), review: true },
  // "Please include the word "purple" in the cover letter submitted." — a
  // Yes/No list beside the letter slot (PsiQuantum, 2026-09-25). The server
  // puts every such word into the letter it attaches (withLetterWords), so
  // the letter he sends does include it. Flagged: a letter of his own may not.
  { re: /\b(include|use|mention|add|put)\s+the\s+(word|phrase|term|keyword)s?\s+\S.{0,40}\s+(in|within|into)\s+(your|the)\s+cover\s+letter/i,
    get: () => ['Yes', 'I have', 'Included', 'Done'], review: true },
  // "I hereby authorize ASM to contact, obtain and verify the accuracy of
  // information…" (2026-09-24): a verification consent, his standing yes.
  { re: /^\s*i\s+(hereby\s+)?authori[sz]e\b[^.?]{0,80}\b(to\s+)?(contact|obtain|verify|verification|background|references?)\b/i,
    get: p => (/^no$/i.test(String(p.answers?.data_processing_consent || '')) ? undefined : ['Yes', 'I agree', 'I authorize', 'I acknowledge']), review: true, consent: true },
  { re: /^\s*please\s+(review|read)\s+the\s+(linked|attached|following|above)\s+(document|policy|notice|disclosure)s?\b/i,
    get: p => (/^no$/i.test(String(p.answers?.data_processing_consent || '')) ? undefined : ['I acknowledge', 'Yes', 'I agree']), review: true, consent: true },
  // A STATE-SPECIFIC BACKGROUND-CHECK NOTICE. ABB's "California Applicants
  // only: I understand the Company may obtain, without using the services of a
  // third party investigative consumer reporting agency, public records…" was
  // answered "No" by the agency rule below. He lives in Washington, and the
  // first thing he sent was "Not applicable" (2026-09-24).
  { re: /^\s*(for\s+)?california\s+(applicants?|residents?)\s+only/i,
    get: (p) => {
      const st = String(p.identity?.state || '').toLowerCase();
      return /california/.test(st) ? undefined : ['Not applicable', 'N/A', 'Not Applicable'];
    },
    review: true },
  // Third-party / agency / contractor history — standing rule: always No.
  { re: /(third|3rd)[\s-]*part(y|ies)|through\s+an?\s+(agency|agencies)|temporary\s+employee\s+of\b|staffing\s+agency|contract(or|ing)\s+(company|agency)|temp\s+agency/i,
    not: /consumer\s+report|background\s+(check|screen)|public\s+record/i,
    get: p => p.answers?.worked_via_agency },
  // "This position requires a degree from an ABET accredited program. Do you
  // have a degree from an ABET accredited program?" (Spirit, 2026-10-02).
  { re: /\bABET\b/i, get: p => p.answers?.abet_accredited },
  // "Do you meet the minimum requirements of the position as listed?" offered
  // as "Meet some / Meet all / Exceeds all qualifications" (Spirit, 2026-10-02):
  // his Yes is "Meet all" there.
  { re: /basic\s+(job\s+)?requirements|minimum\s+(qualifications|requirements)|meet.*requirements\s+listed/i,
    get: (p) => { const v = p.answers?.meets_basic_requirements; return /^yes$/i.test(String(v || '').trim()) ? [v, 'Meet all', 'Meets all'] : v; } },
  // "Are you open to working in-person in one of our offices 25% of the time?"
  // (Anthropic, F-348) is the on-site question in other words.
  { re: /(willing|able|open|comfortable).*\b(on-?site|in[- ]person|in\s+the\s+office|from\s+(?:an?\s+|the\s+)?office)\b|\b(on-?site|in[- ]person)\b.*(willing|able|open)/i, get: p => p.answers?.willing_onsite },
  // "Can you work from our San Francisco office 5 days a week?" (Nudge,
  // 2026-09-24) — a city between "our" and "office" and no willing/able word,
  // so it was left for him; he answered yes.
  { re: /\b(can|could|will|would|are)\s+you\s+(be\s+able\s+to\s+)?(work|be|commute)\b[^?]{0,20}\b(from|in|at|to|into)\b[^?]{0,50}\b(office|site|facility|campus|lab)\b|\b\d\s+days\s+(a|per)\s+week\b[^?]{0,40}\b(office|on-?site|in[- ]person)|\b(office|on-?site|in[- ]person)\b[^?]{0,60}\b\d\s+days\s+(a|per)\s+week/i,
    not: /\bremote(ly)?\b[^?]{0,20}\bonly\b|relocat/i,
    get: p => p.answers?.willing_onsite },
  // "DO YOU HAVE A PORTFOLIO…?" is a yes/no, and he does (Lexington,
  // 2026-09-24: left for him, he picked Yes). The address goes in the box that
  // asks for it.
  { re: /^\s*(do|does|can)\s+you\s+(have|provide|share)\s+(a|an|your)\s+(online\s+)?(portfolio|personal\s+website|work\s+samples?)\b/i,
    not: /\bpassword|\bpasscode|\bprotected\b|\blogin\b|\bcredential/i,
    get: p => ((p.identity?.portfolio || p.identity?.website) ? 'Yes' : undefined) },

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
  // "races" too: Oracle's "Select the races you identify with." (Denso, F-695).
  { re: /\braces?\b|racial|ethnic/i, get: p => p.eeo?.race, review: true },
  // …and Oracle's other race boxes carry only the category as their label
  // ("Black or African American"): answered with his race, so his own box is
  // ticked and every other one stays unticked.
  { re: /^\s*(american\s+indian(\s+or\s+alaska(n)?\s+native)?|asian|black(\s+or\s+african\s+american)?|native\s+hawaiian(\s+or\s+other\s+pacific\s+islander)?|white|two\s+or\s+more\s+races)\s*\*?\s*$/i,
    get: p => p.eeo?.race, review: true },
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
  // "Date Available" is BambooHR's house wording (Cornelis Networks, driven
  // 2026-09-24) and matched none of these.
  { re: /start\s*date|availab\w*.*start|earliest.*(start|available)|notice\s*period|when\s+can\s+you\s+(start|begin)|earliest\s+date|^\s*date\s+available|available\s+(start\s+)?date|date\s+(you\s+are\s+|you're\s+)?available/i,
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
  // "…please tell us the city, state, and zip code you'd be moving from" asks
  // for his ADDRESS, not a yes (AMAT, 2026-10-03: "Yes" went in, he typed
  // his city, state and ZIP code, F-694).
  { re: /relocat[^]*\b(city|zip|postal|where)\b[^]*\b(moving|relocating|coming)\s+from\b|\b(moving|relocating)\s+from\b[^]*\b(city|state|zip)\b/i,
    get: (p) => [p.identity?.city, [p.identity?.state, p.identity?.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ') || undefined },
  { re: /relocat/i, get: p => p.answers?.willing_to_relocate,
    not: /\bwhich\b|\bwhat\b[^?]{0,40}\b(location|cit(y|ies)|office|site)s?\b|select all that apply|\b(moving|relocating)\s+from\b/i },
  // "Are you open to hybrid?" is a YES/NO about a work model, and the line below
  // answers with his sentence "Open to on-site, hybrid, or remote" — which
  // matches no Yes/No option (BambooHR, Cornelis Networks, 2026-09-24). He is
  // open to all three, so the yes/no is yes.
  { re: /^\s*(this\s+(role|position)\s+is\s+[^.?]{0,80}[.?]\s*)?(are|would|will)\s+you\s+(be\s+)?(open|willing|able|comfortable)\s+(to|with)\s+(a\s+|working\s+)?(hybrid|on-?site|in[- ]office|in[- ]person)\b/i,
    get: p => p.answers?.willing_onsite },
  // "Please confirm that you understand this is an onsite position." (ReLogic,
  // 2026-09-26) is a Yes/No acknowledgement, not "what work model do you
  // want" — the rule below answered it with a sentence no list offers.
  { re: /\b(confirm|understand|acknowledge|aware)\b[^?]{0,60}\b(on-?site|in[- ]office|in[- ]person)\b/i,
    get: (p) => (/^yes$/i.test(String(p.answers?.willing_onsite || '')) ? ['Yes', 'I understand', 'Confirmed', 'Understood'] : undefined), review: true },
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
  // …and "Which of the following best describes how you found out about this
  // opportunity?" (Boom Supersonic, 2026-09-25): no "did".
  { re: /(how|where)\s+did\s+you\s+(\w+\s+)?(hear|find|learn|discover)|how\s+did\s+you\s+find\s+out|how\s+you\s+(first\s+)?(heard|found\s+out|learned|came\s+across)\s+about\b|referral\s+source|source\b/i,
    // BOTH answers, because this question comes in two shapes. Free text wants
    // "LinkedIn"; a fixed list usually offers categories, and his profile has
    // "Job Board or Social Media" for exactly that. `decide` picks whichever
    // the form actually offers. A second, more specific rule further down read
    // `heard_about_us` and could never fire — this rule matched first — so that
    // value sat unused and list-shaped forms went unanswered (F-263).
    // Then the rest of his ladder (2026-09-24): "always just answer LinkedIn …
    // or company site or social media, Instagram, Facebook… whatever pops up
    // first and works." Free text takes the first; a list takes the first it has.
    get: p => ['LinkedIn', p.answers?.how_heard, ...HOW_HEARD_LADDER, p.answers?.heard_about_us].filter((v, i, all) => v && all.indexOf(v) === i) },
  // "Desired hourly rate" is the same question as "salary expectations" and
  // matched none of these words — an intern form's most common way of asking.
  // CONFLICT OF INTEREST (HP, 2026-09-26). Question 1 lists "outside
  // employment with or receiving COMPENSATION from a customer…" and the salary
  // rule below took the word: it was planned "$90000/year". It also asks
  // about his family's financial interests, which no file of his states, so
  // it is his to answer once. Question 3 asks whether a family member or
  // someone close to him is a government official over HP: the same.
  // Question 2 ("Whether you have served… in a government or public body")
  // is his own history and the officials rule further down answers it.
  { re: /\b(family\s+member|close\s+personal\s+relationship)\b[^?]{0,160}\bgovernment\s+officials?\b/i,
    get: p => p.answers?.family_government_official, ask: 'answers.family_government_official', review: true },
  { re: /\bconflicts?\s*(\(s\))?\s+of\s+interest\b[^]*\b(outside\s+employment|financial\s+interest|conducting\s+business|compensation\s+from)\b/i,
    not: /\bgovernment\s+(officials?|or\s+public\s+body)\b/i,
    get: p => p.answers?.conflict_of_interest, ask: 'answers.conflict_of_interest', review: true },
  { re: /salary|compensation|pay\s+(expectation|range|rate)|(hourly|desired|expected)\s+(rate|wage|pay)|rate\s+of\s+pay/i,
    // …and never where the question is not his EXPECTATION (audit of every
    // logged question, 2026-09-26): "Are you willing to accept this salary
    // range?" is a yes/no, and "Current Salary" asks what he is paid now — he
    // is a student; his target stated as his pay would be false. Both are his.
    not: /\bconflicts?\s*(\(s\))?\s+of\s+interest\b|\b(receiving|receive|received)\s+compensation\s+from\b|\b(willing|able|ok|okay|comfortable|agree)\b[^?]{0,20}\b(to\s+)?(accept|with)\b[^?]{0,40}\b(salary|compensation|pay)\s+(range|band)\b|\b(current|present|last|previous|most\s+recent)\s+(base\s+)?(salary|compensation|pay|wage)\b/i,
    get: p => p.answers?.salary_expectation, review: true },
  // "Are you of eligible age in the country to which you are applying?"
  // (Flowserve, 2026-10-03, left for him) is the same question.
  { re: /18\s+years|legal\s+age|at\s+least\s+eighteen|\b(of\s+)?(eligible|legal|minimum|working)\s+age\b/i, get: p => p.answers?.over_18 },
  // "Do you have the minimum number of years of experience / the minimum
  // educational requirement for the job to which you are applying?" — he
  // answered Yes to both (Flowserve, 2026-10-03). Only the curated new-grad
  // postings reach the engine; review, so a senior one is caught.
  { re: /^\s*do\s+you\s+(have|meet)\s+(the\s+)?minimum\s+(number\s+of\s+years\s+of\s+experience|years\s+of\s+experience|educational|education|qualifications?|requirements?)\b/i,
    get: () => 'Yes', review: true },
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
  // …and Lyft's "Have you been employed by Lyft, or any subsidiary, affiliate,
  // or business unit of Lyft, in the past" (2026-09-24), which has neither
  // "ever" nor "previously" — the time is at the far end of the sentence.
  // …and "Are you now or have you ever been a Penumbra employee?" (Lever,
  // 2026-09-25): "ever been a <company> employee", no preposition at all.
  // …and Oracle-hosted DENSO's "Are you currently or have you been employed by
  // DENSO at any of its locations?" / "…previously been assigned to DENSO … as
  // a temporary or contract worker?" (F-695).
  { re: /\bare\s+you\s+currently\s+or\s+have\s+you\s+(ever\s+|previously\s+)?been\s+(employed\s+by|assigned\s+to|working\s+(at|for))\s+(?!(?:this|our)\b)|\bhave\s+you\s+ever\s+been\s+an?\s+(?!(?:temporary|contract|agency)\b)(?:[\w.&'-]+\s+){1,4}(employee|contractor|intern)\b|previously\s+(?:been\s+)?(?:directly\s+)?(worked|employed)|former[\s/]+(?:[\w.]+[\s/]+){0,3}(employee|contractor|intern)|worked\s+(at|for).*(before|previously)|worked\s+with\s+us\b.*\b(before|previously)|ever\s+(worked|been\s+employed)\s+(at|for|with|by)(?!\s+(?:this|our)\b)|worked\s+(at|for)\b.*\b(employee|contractor|intern)\b|been\s+(employed|worked)\s+(by|at|for)\s+(?!(?:this|our)\b)[^?]{0,160}\b(in\s+the\s+past|before|previously)\b/i,
    // A "no" that the form spells as a statement — Waymo's "Are you a current
    // or former Alphabet employee…" offers "Never worked at Alphabet"
    // (2026-09-24) — is tried after the plain No.
    get: (p) => {
      const v = employedAtApplyingTo(p) ?? p.answers?.previously_employed_here;
      return /^no$/i.test(String(v || '')) ? [v, 'Never worked at', 'Never been employed', 'I have never worked'] : v;
    },
    review: true },
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
  { re: /talent\s+(community|network|pool)|join\s+our\s+talent|candidate\s+community|(hear|learn|be\s+notified|stay\s+(informed|connected|up\s*to\s*date))[^?.;]{0,40}\b(career|job|role|position|opening|opportunit)|\buse\s+your\s+(information|data|profile|application|resume|cv)\s+for\s+(other|future)\s+(job\s+)?(openings?|positions?|roles?|jobs?|opportunit)/i,
    get: p => p.answers?.talent_community_optin, review: true },
  // "Do you accept that we use your information for other job openings?"
  // (NXP, 2026-09-27) is the same offer, worded as a use of his data.
  // …and "Are you an immediate family member (parent, child, sibling,
  // spouse/partner) of a partner at Ernst & Young…?" (Intel, 2026-09-26) —
  // his own answer there was No; the recogniser had to supply it.
  // …and "Are you related to anyone in a Management position at SYNNEX or a
  // subsidiary?" (Hyve, 2026-09-27) — he typed No himself (F-623).
  { re: /relative|\b(are\s+you|is\s+anyone)\s+related\s+to\s+(anyone|someone|any\s*(one|person|employee|member|manager))\b|\bare\s+you\s+related\s+to\s+an?\s+[\w&.' -]{2,40}?\s+employee\b|family\s+member.*(employ|work)|family\s+or\s+(a\s+)?close\s+friend\b.{0,60}\b(employ|work)|\bimmediate\s+family\s+member\b[^?]{0,120}\bof\s+(an?|any)\s+(partner|employee|officer|director|executive)/i,
    not: /^\s*if\s+yes\b|provide\s+their\s+name/i, get: p => p.answers?.relatives_at_company },
  // "Please select your area of interest(s)" (Western Digital, 2026-09-24):
  // his degree names it.
  { re: /\bareas?\s+of\s+interest(\(s\))?\b/i, get: () => ['Engineering'] },
  // ── seen on Eightfold forms (Micron / Lam) ────────────────────────
  // Export-control country citizenship. NOT the same as the generic ITAR
  // "U.S. person" question, and it must be answered No for him (Canadian).
  { re: /cuba,?\s*iran|citizen\s+of,?\s+or\s+do\s+you\s+hold\s+dual\s+citizenship|north\s+korea.*syria/i,
    get: p => p.answers?.restricted_country_citizen, review: true },
  // "A U.S. worker is defined as … are you in one of the above five groups?"
  { re: /u\.?s\.?\s+worker|above\s+five\s+groups/i, get: p => p.answers?.us_person, review: true },
  // …and "present documents showing that you have a right to lawfully work in
  // the country…" (Harris Group, 2026-09-26).
  // …and "If offered a position, will you be able to provide proof of your
  // authorization to work in the United States?" (Brooks, 2026-10-03).
  { re: /legal\s+right\s+to\s+work|verification\s+of\s+your\s+legal|submit\s+verification|right\s+to\s+lawfully\s+work|(present|provide|produce|show)\s+documents?\b[^?]{0,60}\b(right|eligib\w*|authori[sz]\w*)\s+to\s+(lawfully\s+|legally\s+)?work|\bprovide\s+(proof|documentation|evidence)\s+of\s+(your\s+)?(identity\s+and\s+)?(authori[sz]ation|eligibility|right)\s+to\s+work\b/i,
    get: p => p.answers?.can_verify_right_to_work, review: true },
  // …and "able to begin a new opportunity" (Field AI, 2026-09-26), whose list
  // stops at "three to six months" — his June 2027 fits none of it, and the
  // reason now says so instead of "no answer".
  { re: /when\s+would\s+you\s+be\s+available|available\s+to\s+(start|begin)|\btimeline\s+for\s+(starting|joining|beginning)\b|when\s+(could|can|would)\s+you\s+(realistically\s+|be\s+able\s+to\s+)?(start|begin)|able\s+to\s+(start|begin)\b|start\s+full[- ]?time/i, get: p => p.answers?.earliest_start },
  // "If you were referred to Base, please share the name of your referrer."
  // (2026-09-25) — he was not referred, so there is no name to give.
  { re: /\bif\s+you\s+were\s+referred\b.{0,80}\b(name|who)\b|\bname\s+of\s+(your\s+)?referr(er|al)\b/i,
    blank: true, why: 'you were not referred, so there is no referrer to name' },
  // "Are you currently a Freshman or Sophomore in an undergraduate program?"
  // (Base Power, 2026-09-25). He started August 2023 and graduates May 2027:
  // 2026-27 is his senior year.
  { re: /\bare\s+you\s+(currently\s+)?(a\s+)?(freshman|sophomore)\b/i,
    get: p => (Number(p.education?.graduation_year || String(p.education?.graduation || '').match(/\d{4}/)?.[0] || 0) <= new Date().getFullYear() + 1 ? 'No' : undefined) },
  // "Do you understand that this is an in-person role based in Colorado?"
  // (Lunar Outpost, 2026-09-25) — he is open to on-site work and to relocating.
  { re: /\bdo\s+you\s+understand\b.{0,60}\b(in[- ]person|on[- ]?site|onsite|based\s+in|relocat)/i, get: p => p.answers?.willing_onsite || p.answers?.willing_to_relocate },
  // "Will you be a rising Senior or Senior in January 2027?" (Lexington
  // Medical, 2026-09-25). His graduation month decides it: senior from the
  // August before it until it, rising senior the summer before that.
  { re: /\b(rising\s+senior|senior)\b[^?]{0,40}\b(in|by|during|as\s+of)\s+(?:the\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|spring|summer|fall|autumn|winter)[a-z]*\s+(?:of\s+)?(\d{4})/i,
    get: (p, text) => {
      const g = String(p.education?.graduation || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/i);
      const q = String(text || '').match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|spring|summer|fall|autumn|winter)[a-z]*\s+(?:of\s+)?(\d{4})/i);
      if (!g || !q) return undefined;
      const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const SEASON = { spring: 2, summer: 6, fall: 9, autumn: 9, winter: 1 };
      const at = (y, m) => Number(y) * 12 + m;
      const grad = at(g[2], MON.indexOf(g[1].toLowerCase().slice(0, 3)) + 1);
      const k = q[1].toLowerCase();
      const asked = at(q[2], SEASON[k] || MON.indexOf(k.slice(0, 3)) + 1);
      return asked >= grad - 12 && asked <= grad ? 'Yes' : 'No';
    },
    review: true },
  // "Do you have previous internship or Co-Op experience?" (Lexington
  // Medical, 2026-09-25): his work history has two internships.
  { re: /\b(previous|prior|past|any)\s+(internship|co-?op)s?\b(\s+or\s+(internship|co-?op)s?)?(\s+experience)?|\bhave\s+you\s+(completed|had|done)\s+(an?\s+)?(internship|co-?op)/i,
    get: (p) => ((p.work_experience || []).some((w) => /\bintern|\bco-?op\b/i.test(String(w?.title || ''))) ? 'Yes' : undefined), review: true },
  // "Are you a first generation college student?" (Zipline, 2026-09-25): a
  // family fact only he can state; the key that answers it is named.
  { re: /\bfirst[- ]generation\s+(college\s+)?(student|graduate)/i,
    get: p => p.answers?.first_generation, ask: 'answers.first_generation', review: true },
  // "Are you available to work January 2027 – June 2027 (6-month Co-Op)?"
  // (Lexington), "When are you available for an internship?" (Vast): his
  // answer, 2026-09-25 — full-time roles only.
  { re: /\bavailab\w*\b[^?]{0,80}\b(internship|co-?op)\b|\b(internship|co-?op)\b[^?]{0,60}\bavailab/i,
    get: p => p.answers?.internship_availability, ask: 'answers.internship_availability', review: true },
  // "Do you plan to go to graduate school?" (Vast, 2026-09-25): a plan only he
  // can state; the key that answers it is named.
  { re: /\b(plan|intend|planning)\s+(to\s+)?(go\s+to|attend|pursue)\s+(a\s+)?(graduate\s+school|grad\s+school|a?\s*master'?s|ph\.?d)/i,
    get: p => p.answers?.graduate_school_plans, ask: 'answers.graduate_school_plans', review: true },
  // "Are you able to pass a pre-employment drug test?" (Specter Aerospace,
  // 2026-09-26): his to state; the key that answers it is named.
  { re: /\b(pass|take|submit\s+to|complete)\s+(a\s+)?(pre-?\s?employ\w*\s+)?(drug|substance)\s+(test|screen)/i,
    get: p => p.answers?.drug_test, ask: 'answers.drug_test', review: true },
  // "Certain legal and ethical restrictions may apply with respect to
  // relationships with government officials … Whether you have …" (HPE): no
  // government employer anywhere in his history; he sent No.
  { re: /\brelationships?\s+with\s+government\s+officials?\b[^]*\bwhether\s+you\b/i,
    get: (p) => ((p.work_experience || []).some((w) => /government|federal|state\s+of|city\s+of|county\s+of/i.test(String(w?.company || ''))) ? undefined : 'No'), review: true },
  // INTEL'S NUMBERED QUESTIONNAIRE (his Phoenix application, 2026-09-26) —
  // answered live by his past answers and the recogniser; as rules, from his
  // files, so they hold without either.
  // "If your response to question 9 is 'No', please specify the country or
  // countries where you hold citizenship" → his citizenship.
  { re: /\bspecify\s+the\s+countr(y|ies)\b[^?]{0,40}\b(hold|have)\s+(your\s+)?citizenship\b|\bcountr(y|ies)\s+(where|in\s+which)\s+you\s+hold\s+citizenship\b/i,
    get: citizenshipCountry, review: true },
  // "Do you own, control, or have an economic interest in any intellectual
  // property rights (patents, …)?" — none in his files; the patent rule's
  // standing No.
  { re: /\b(own|control|economic\s+interest)\b[^?]{0,60}\bintellectual\s+property\b|\bintellectual\s+property\s+rights\b[^?]{0,40}\b(own|hold)/i,
    get: (p) => p.answers?.patents || 'No', review: true },
  // "Are you a current employee of the US Department of Defense (DOD) or were
  // you an employee of …?" — no government employer in his work history.
  // …and "I have United States government or public institution employment
  // experience (federal, state, or local)" (HPE) — the school rule had
  // answered it "Lakeside University" on the word "institution".
  // …and HP's "Within the past 5 years, have you been employed by the federal
  // or any state or local government or public institution within Australia,
  // …, United States and/or Vietnam?" (2026-09-26): "employed" comes FIRST.
  // His employers are Applied Materials, Acme Steel and Lakeside (private), so No;
  // a public employer ever added to his history silences the rule.
  { re: /\b(department\s+of\s+defen[cs]e|\bdod\b|federal\s+government|(u\.?s\.?|united\s+states)\s+government|public\s+institution)\b[^?]{0,80}\b(employee|employed|employment)|\b(employee|employed)\b[^?]{0,60}\b(department\s+of\s+defen[cs]e|\bdod\b)|\b(employed|worked)\s+(by|for|at)\s+(the\s+|a\s+|any\s+)?(federal|state|local|national|municipal)\b[^?]{0,60}\bgovernment\b/i,
    get: (p) => ((p.work_experience || []).some((w) => /department\s+of\s+defen|\bdod\b|government|federal|\b(state|public|city|county)\b/i.test(String(w?.company || ''))) ? undefined : 'No'), review: true },
  // "Was your I-140 approved more than 180 days ago?" — no petition was ever
  // filed for him (held_h1b No, no active case): the form's own "I do not
  // have an I-140".
  { re: /\bi-?\s?140\b/i,
    get: (p) => (/^no$/i.test(String(p.answers?.held_h1b || '')) && !/^yes$/i.test(String(p.answers?.active_immigration_case || '')) ? ['I do not have an I-140', 'Not applicable', 'N/A', 'No'] : undefined), review: true },
  // THE EDUCATION ENTRY'S STATUS FIELDS (2026-09-26 gap audit): "Graduated
  // Status" and "Is Highest Diploma?" on an Oracle / SuccessFactors-style
  // education row. He graduates May 2027 — not yet graduated — and the
  // bachelor's is his highest degree.
  // AMAT's "If you are currently enrolled in a degree program, please indicate
  // which program here?" (Eightfold, F-694): he is, a bachelor's, until May 2027.
  { re: /^\s*if\s+you\s+are\s+(currently\s+)?enrolled\s+in\s+a\s+degree\s+program\b[^?]{0,80}\b(which|what)\s+(degree\s+)?(program|degree)\b/i,
    get: (p) => { const y = Number(String(p.education?.graduation || '').match(/\b(20\d{2})\b/)?.[1]); return y && y >= new Date().getFullYear() ? ["Bachelor's Degree", "Bachelor's", 'Bachelors', 'Undergraduate'] : undefined; } },
  // …and Paylocity's "Did you Graduate?" (Optomec, F-691).
  { re: /\bgraduat\w*\s+status\b|^\s*(have|did)\s+you\s+graduate[d]?\b|^\s*(already\s+)?graduated\s*\??\s*$/i,
    get: (p) => { const y = Number(String(p.education?.graduation || '').match(/\b(20\d{2})\b/)?.[1]); return y && y >= new Date().getFullYear() ? ['Expected', 'Expected to graduate', 'In progress', 'Not yet graduated', 'Currently enrolled', 'No'] : undefined; },
    review: true },
  { re: /\bis\s+(this\s+)?(your\s+)?highest\s+(diploma|degree|level\s+of\s+education)\b|^\s*highest\s+(diploma|degree)\s*\??\s*$/i,
    get: (p) => (/bachelor/i.test(String(p.education?.degree_level || p.education?.degree || '')) ? 'Yes' : undefined), review: true },
  // "Transcripts (if applying for Co-op/Internship) URL" (Waabi, 2026-09-26):
  // he applies for full-time roles only, so it does not apply to him.
  { re: /\(\s*(only\s+)?if\s+(you\s+are\s+)?applying\s+(for|to)\s+(an?\s+|the\s+)?(co-?op|intern)/i,
    blank: true, why: 'only for co-op / internship applicants — you apply for full-time roles' },
  // A REQUIRED BOX UNDER AN INSTRUCTION, not a question: "Please answer all of
  // the questions so we can process your applications" (Extreme Networks'
  // Lever card, 2026-09-26). Nothing factual is asked; an acknowledgement
  // lets the form go, and he sees it.
  { re: /^\s*please\s+(answer|complete|fill\s+(out|in))\s+(all\s+)?(of\s+)?the\s+(following\s+|below\s+)?(questions|fields|form)\b[^?]*$/i,
    get: () => 'Understood.', review: true },
  // "This position is not open for any type of Contracting." with YES / NO
  // (Sabanto's Breezy form, 2026-09-25): an acknowledgement. He is applying as
  // an employee, never through a contracting arrangement.
  { re: /^\s*this\s+(?:position|role|job|opening)\s+is\s+not\s+(?:open|available)\s+(?:to|for)\s+(?:any\s+(?:type|kind)\s+of\s+)?(?:contract\w*|c2c|corp[- ]to[- ]corp|third[- ]party|1099)\b/i,
    get: () => ['Yes', 'I understand', 'Understood', 'Acknowledged'], review: true },
  // A required box under a bare statement: "This is an in-office position."
  // (Atomic Semi, 2026-09-25) — the answer it wants is whether he accepts it.
  { re: /^\s*this\s+(?:is\s+an?|position\s+is|role\s+is)\s+(?:an?\s+)?(?:fully\s+)?(in[- ]office|on[- ]?site|onsite|in[- ]person)\b[^?]{0,80}\.?\s*$/i,
    get: (p) => (/^yes$/i.test(String(p.answers?.willing_onsite || '')) ? ['Yes', 'I understand', 'Understood', 'Acknowledged'] : undefined), review: true },
  // "Have you ever interviewed at Anthropic before?" — the same history as a
  // previous application, and never applied means never interviewed (F-348).
  // An APPLICATION is on record in the store (the dashboard sets
  // appliedHereBefore): he has applied to Micron sixteen times, and the
  // standing No went out there on 2026-09-25 (F-621). An interview is not.
  { re: /applied\s+on\s+any\s+previous|previously\s+applied|applied\s+before|(?:ever|previously)\s+interviewed\s+(?:at|with|for|here)|interviewed\s+(?:at|with)\s+.{1,40}\s+before/i,
    get: (p, text) => (p.appliedHereBefore === true && /\bappl(y|ied|ication)/i.test(text) ? 'Yes' : p.answers?.previously_applied_here) },
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
  // …and "Language of Application" (Infineon, stress round 19, 2026-09-26).
  { re: /self\s*identification\s+language|preferred\s+language|^\s*language\s*:?\s*\*?\s*$|correspondence\s+language|language\s+preference|language\s+of\s+(the\s+|your\s+)?application|application\s+language/i,
    get: p => p.answers?.self_id_language },
  // ── Languages (Workday's My Experience, F-367) ──
  // Under each language he adds sit five dropdowns — Comprehension, Overall,
  // Reading, Speaking, Writing — and the box "I am fluent in this language."
  // All six were left for him on a live form (2026-09-06). His instruction:
  // the highest level offered, for every language he lists. The
  // answer is a ladder of spellings; chooseOption ranks whatever words the
  // tenant uses and takes the top rung.
  { re: /fluent\s+in\s+this\s+language|^\s*native\s+(speaker|language)\s*\*?\s*$/i, get: p => p.answers?.fluent_in_language ?? 'Yes' },
  // ENGLISH, ASKED AS A REQUIREMENT. AST SpaceMobile: "Do you meet the
  // language requirements for this position (fluent in written and verbal
  // English)?" (2026-09-24). His `languages` list says English, Fluent.
  { re: /language\s+requirements?[^?]{0,80}\benglish\b|fluent\s+in\s+(written\s+and\s+(verbal|spoken)|(verbal|spoken)\s+and\s+written)\s+english|\b(read|write|speak)\b[^?]{0,30}\benglish\b[^?]{0,10}\bfluently\b/i,
    get: (p) => ((Array.isArray(p.languages) ? p.languages : []).some((l) => /^english$/i.test(String(l?.name || '').trim()) && /fluent|native|full|bilingual/i.test(String(l?.proficiency || ''))) ? 'Yes' : undefined),
    review: true },
  // ENGLISH, ASKED AS A LEVEL. J&J: "Indicate your proficiency of the English
  // language:" (2026-09-30), left blank; he chose "Fluent / Native Speaker".
  // His `languages` list says English, Fluent, and his instruction for a level
  // is the highest one offered.
  { re: /\b(proficiency|fluency|level)\s+(of|in|with)\s+(the\s+)?english(\s+language)?\b|\benglish(\s+language)?\s+(proficiency|fluency|level)\b/i,
    get: (p) => ((Array.isArray(p.languages) ? p.languages : []).some((l) => /^english$/i.test(String(l?.name || '').trim()) && /fluent|native|full|bilingual/i.test(String(l?.proficiency || ''))) ? HIGHEST_PROFICIENCY : undefined) },
  // NOT A PHYSICIAN. J&J asks every external candidate, under the CMS Open
  // Payments rule, "Are you a physician (which may include doctors of medicine
  // and osteopathy, dentists, …)?" — he answered No (2026-09-30); his degree
  // is mechanical engineering and no file of his names a medical licence.
  { re: /\bare\s+you\s+a\s+(licensed\s+)?(physician|medical\s+doctor|doctor\s+of\s+medicine)\b/i, get: () => 'No' },
  // READING DRAWINGS, ASKED AS AN ABILITY. AST: "Are you able to read and
  // interpret technical drawings, blueprints, or work instructions?"
  // (2026-09-24). Yes only when his own skills or job descriptions name
  // drawings or GD&T — cv.md has him creating the engineering drawings for
  // the AMAT fixture and machining from SolidWorks drawings at Makerspace.
  { re: /\b(able\s+to|can\s+you)\s+read\s+(and\s+(interpret|understand)\s+)?(technical\s+|engineering\s+|mechanical\s+)?(drawings|blueprints|prints|schematics)\b/i,
    get: (p) => {
      const hay = [p.answers?.skills, ...(Array.isArray(p.work_experience) ? p.work_experience.map((j) => `${j?.title || ''} ${j?.description || ''}`) : [])].join(' ');
      return /\bdrawings?\b|\bgd&t\b|\bblueprints?\b/i.test(hay) ? 'Yes' : undefined;
    },
    review: true },
  // J&J'S LANGUAGE ROW asks each level as its own Yes/No — "Fluent" and
  // "Foundational" (Auris Health, 2026-09-30, left blank; he answered Yes to
  // both). Highest level for every language he lists.
  { re: /^\s*(fluent|foundational)\s*\*?\s*$/i, get: () => 'Yes' },
  { re: /^\s*(comprehension|understanding|overall|reading|speaking|writing|listening|spoken|written)\s*(proficiency|level)?\s*\*?\s*$|^\s*(language\s+)?(proficiency|fluency)(\s+level)?\s*\*?\s*$|language\s+proficiency\s*(level)?\s*\*?\s*$/i,
    not: /\b(java|python|c\+\+|cad|solidworks|software|tool|scale of)\b/i,
    get: p => p.answers?.language_proficiency ?? HIGHEST_PROFICIENCY },
  // "City/Town" (Apple) and "Town/City" are the same box.
  { re: /^city$|^city\s*\*?$|^(city\s*\/\s*town|town\s*\/\s*city)\s*\*?$/i, get: p => p.identity?.city },
  // Address and postcode were in apply-profile.yml the whole time and had no
  // pattern here, so a live Applied Materials form reported "Address Line 1 —
  // no answer in apply-profile.yml" while identity.address_line1 sat right
  // there. Same for postal_code.
  // "Street Address 2 (optional)" is the apartment line, not the street again
  // (Apple, 2026-10-16: both boxes held the street line).
  { re: /^address(\s*line)?\s*(1|one)?\s*\*?$|^street\s*address\b(?!\s*(line\s*)?(2|two|ii)\b)|^address\s*:?\s*\*?$/i,
    get: p => p.identity?.address_line1 },
  // THE WHOLE ADDRESS IN ONE BOX: "We require the current physical/mailing
  // address for all candidates. Please enter your address here (incomplete
  // addresses may result in your disqualification)." (Re:Build, 2026-09-26,
  // left for him). Every part is in his profile; written out whole.
  { re: /\b(enter|provide|list|give)\s+(us\s+)?your\s+(full\s+|complete\s+|current\s+|home\s+|mailing\s+|physical\s+)*address\b|\b(what\s+is\s+)?your\s+(current\s+|home\s+|mailing\s+|physical\s+|full\s+|complete\s+|permanent\s+)+address\b|^\s*(current|home|mailing|physical|full|complete|permanent)\s+(\w+\s+)?address\s*\??\s*\*?$/i,
    not: /\b(e-?mail|web|ip|url|website)\s+address\b|\baddress\s+line\s*(2|two)\b|\bcity\b[^?]{0,20}\bonly\b/i,
    get: (p) => {
      const i = p.identity || {};
      const cityLine = [i.city, [i.state, i.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const whole = [i.address_line1, i.address_line2, cityLine, i.country].map((s) => String(s || '').trim()).filter(Boolean).join(', ');
      return i.address_line1 && i.city ? whole : undefined;
    } },
  // His address has no second line; KLA, Wolfspeed and Novanta each put it in
  // the ledger as a question for him (2026-09-24). A deliberate blank, unless
  // the profile ever gains one.
  { re: /^address\s*line\s*(2|two)\b/i, get: p => (String(p.identity?.address_line2 || '').trim() || undefined), blankWhenEmpty: true },
  // "What is your postal code?" (SmartRecruiters, Intuitive Surgical,
  // 2026-09-24) missed the start-anchored pattern, fell through to the essay
  // writer, and the box said he did not have one. He does, in his profile (F-549).
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
  // …and "This role may involve a few days of travel each month … Is this
  // something you are comfortable with?" (Orchard Robotics, 2026-09-26).
  { re: /(willing|able|open).{0,25}travel|travel\s*(requirement|percentage|%)|percent\w*\s+of\s+travel|how\s+much\s+travel|\btravel\b[^?]{0,200}\b(comfortable|okay|ok|fine|willing|able)\b[^?]{0,20}\?/i,
    get: p => p.answers?.travel_ok, ask: 'answers.travel_ok', review: true },
  // Novanta's follow-up to travel, and its two work-document questions
  // (2026-09-24) — each answered by him on the form, kept in his profile.
  { re: /^\s*to\s+which\s+countr(y|ies)\b/i, get: p => p.answers?.travel_countries, ask: 'answers.travel_countries', review: true },
  { re: /\brequired\s+authori[sz]ation\s+to\s+work\s+in\s+the\s+country\b/i,
    get: p => p.answers?.authorized_to_work_us, review: true },
  { re: /\brequired\s+documentation\s+to\s+reside\s+in\s+the\s+country\b/i,
    get: p => p.answers?.reside_documentation, ask: 'answers.reside_documentation', review: true },
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

  // "DO YOU HAVE EXPERIENCE WITH X?" — YES ONLY WHEN HIS OWN FILES SAY SO.
  //
  // BambooHR (Cornelis Networks, 2026-09-24) asked three: PCB design, EM
  // simulation tools, lab equipment. His skills and job descriptions are the
  // evidence; a term found there is a Yes. A term NOT found stays his — a gap
  // in his files is not a No (his rule, 2026-09-23), and a No here can cost
  // him the job as surely as a false Yes can.
  { re: /^\s*(do|have)\s+you\s+(have\s+)?(any\s+)?(prior\s+|previous\s+|hands[- ]on\s+|professional\s+|direct\s+)?(experience|worked|used)\s+(with|in|using|on)?\s*/i,
    // "Have you worked with US before?" (NXP, 2026-09-27) is the employer
    // asking about itself — the previous-employment rules own it.
    not: /\byears?\b|\bhow\s+(many|much|long)\b|\bdescribe\b|\bexplain\b|\bplease\s+(list|share|provide)\b|\b(worked|been)\s+(with|for|at)\s+(us|our\s+company|this\s+company)\b/i,
    get: () => undefined,
    // The real work is in `experienceWith`, which needs the label.
    experience: true },
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
  // Any "If you…" — "If you do not currently reside near …" missed the verb
  // list (Harbinger, 2026-09-25).
  if (!/^\s*if\s+(you|your)\b/i.test(text)) return null;
  // A label that answers its own "no" ("… If not, put N/A.") is a whole
  // question, and the rules read it whole (Cornelis Networks).
  if (/\bif\s+(not|no)\b|\botherwise\b/i.test(text)) return null;
  // A RULE WRITTEN FOR THE WHOLE SENTENCE weighed its condition when it was
  // written, so it reads the whole: AMAT's "If you are currently enrolled in a
  // degree program, please indicate which program here?" (F-694) was cut to
  // "please indicate which program here?", which nothing answers.
  if (RULES.some((r) => /^\^?(\\s\*)?if\\s/.test(r.re.source) && !(r.not && r.not.test(text)) && r.re.test(text))) return null;
  const body = text.match(/^\s*if\s+your?\b[^,]{0,80},\s*(.+)$/is)?.[1]?.trim();
  if (!body || /^\s*if\s+your?\b/i.test(body)) return null;
  return body;
}

export function resolveLabel(label, profile) {
  // A REQUIRED MARK IN FRONT (SuccessFactors, Celestica 2026-09-27): "* Candidate
  // State", "* Ethnicity", "* Education City". Every rule anchored on the
  // question's first word missed them, and "State" answered while "* Candidate
  // State" did not (F-623).
  const text = String(label || '').replace(/^\s*[*＊]+\s*/, '').trim();
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
    // A deliberate blank read off the whole label is still a blank: "If you
    // were referred, please provide the name of the employee." (Archer,
    // 2026-09-25) — never an ANSWER matched off the condition.
    if (inner.kind === 'unknown') {
      const whole = matchRules(text, profile);
      if (whole?.kind === 'blank') return whole;
    }
    // Conditional, so always worth his eye even when the answer is confident.
    return inner.kind === 'answer' ? { ...inner, review: true } : inner;
  }
  // A CONSENT OUTRANKS THE "I AGREE" GUARD (ASM, 2026-09-25). The guard keeps
  // the engine from typing a declaration; ASM's verification consent is a
  // Yes-only list whose long statement says "I agree that it may inquire
  // further", and it was refused. Only a rule marked `consent` passes, and
  // every such rule is flagged for his review.
  const hit = matchRules(text, profile);
  if (hit?.consent) return hit;
  for (const re of neverFillMatchers(profile)) {
    if (re.test(text)) return { kind: 'never' };
  }
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
  const text = String(label || '').replace(/^\s*[*＊]+\s*/, '').trim();
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

/**
 * Does his own record name the thing an "experience with X?" question asks
 * about? X is what follows the question's stem, split on commas / "and" / "or";
 * EVERY part must appear, as whole words, in his skills or a job description.
 */
export function experienceWith(text, stem, profile) {
  const hay = ` ${[
    profile?.answers?.skills,
    ...(Array.isArray(profile?.work_experience) ? profile.work_experience.map((j) => `${j?.title || ''} ${j?.description || ''}`) : []),
    // His projects are in cv.md, not here (the robotic arm, 2026-09-26).
    profile?.cvText,
  ].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9&+#]+/g, ' ')} `;
  // EXAMPLES IN BRACKETS ARE ALTERNATIVES. "Do you have experience with CAD
  // software (e.g., SolidWorks, Creo, AutoCAD)?" (Lexington Medical,
  // 2026-09-25) — one of them is experience with CAD; and the "e.g." cut the
  // question short at its first full stop, so nothing matched at all.
  const EX = /\((?:e\.?\s?g\.?|i\.?\s?e\.?|such\s+as|including|like)\s*,?\s*([^)]+)\)/i;
  const ex = String(text).match(EX);
  if (ex) {
    const items = ex[1].split(/\s*(?:,|\/|\bor\b|\band\b|\betc\.?)\s*/i).map((s) => s.toLowerCase().replace(/[^a-z0-9&+#]+/g, ' ').trim()).filter((s) => s.length >= 2);
    if (items.some((it) => hay.includes(` ${it} `))) return true;
    text = String(text).replace(EX, ' ');
  }
  const m = String(text).match(stem);
  if (!m) return false;
  let x = String(text).slice(m.index + m[0].length).split(/[?.;:]/)[0]
    .replace(/[*✱]/g, ' ')
    .replace(/\b(before|previously|any|the|a|an|such\s+as|like|tools?|software|equipment\s+like)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!x || x.length < 2) return false;
  const parts = x.split(/\s*(?:,|\/|\band\b|\bor\b|&(?!t))\s*/i).map((s) => s.toLowerCase().replace(/[^a-z0-9&+#]+/g, ' ').trim()).filter((s) => s.length >= 2);
  if (!parts.length || parts.length > 4) return false;
  const named = (part) => hay.includes(` ${part} `) || (part.endsWith('s') && hay.includes(` ${part.slice(0, -1)} `));
  return parts.every((part) => named(part) || (EXPERIENCE_KINDS.find(([kind]) => kind.test(part))?.[1] || []).some(named));
}

// A CATEGORY IS ITS TOOLS (F-633). Amazon asked "Do you have experience with
// simulation and 3D modeling software?" (2026-09-26); he kept Jarvis's Yes then,
// and today it went unanswered — his files say "SolidWorks", "Fusion 360" and
// "FEA", never the words "3D modeling" or "simulation". Only categories whose
// members are the concrete tools themselves: SolidWorks IS 3D modeling software.
const EXPERIENCE_KINDS = [
  [/^(3d\s+)?(cad|modell?ing|solid\s+modell?ing|3d\s+modell?ing|3d\s+design|mechanical\s+design|cad\s+modell?ing)$/,
    ['solidworks', 'fusion 360', 'siemens nx', 'catia', 'creo', 'autodesk inventor', 'inventor', 'onshape', 'solid edge', 'autocad']],
  [/^(simulation|simulations|structural\s+simulation|finite\s+element(\s+analysis)?|fea|structural\s+analysis)$/,
    ['fea', 'finite element', 'ansys', 'abaqus', 'simulink', 'solidworks simulation']],
  [/^(2d\s+drafting|drafting|technical\s+drawings?|engineering\s+drawings?)$/,
    ['autocad', 'gd&t', 'solidworks', 'engineering drawings', 'drawings']],
];

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
      if (rule.blank) return { kind: 'blank', why: (typeof rule.why === 'function' ? rule.why(profile) : rule.why) || 'deliberately left blank' };
      if (rule.residence) {
        const place = (String(text).match(rule.re)?.[6] || '').replace(/[?.!]+$/, '').trim();
        const city = String(profile?.identity?.city || '').trim().toLowerCase();
        const state = String(profile?.identity?.state || '').trim().toLowerCase();
        const low = place.toLowerCase();
        if (!place) return { kind: 'unknown' };
        if ((city && low.includes(city)) || (state && (low === state || low.startsWith(`${state} `) || low.includes(`${state} state`)))) {
          return { kind: 'answer', value: 'Yes', review: true };
        }
        // A broad region ("the Pacific Northwest", "the West Coast") is not
        // decidable from a city and a state here — his to answer.
        if (/\b(north|south|east|west|coast|midwest|mountain|pacific|region|state|country|continental|lower\s+48)\b/i.test(place)) {
          return { kind: 'unknown', why: 'a region, not a city — yours to answer' };
        }
        return { kind: 'answer', value: 'No', review: true };
      }
      if (rule.experience) {
        const yes = experienceWith(text, rule.re, profile);
        return yes
          ? { kind: 'answer', value: 'Yes', review: true }
          : { kind: 'unknown', why: 'not in your skills or job descriptions — yours to answer (a gap in your files is not a No)' };
      }
      const value = rule.get(profile, text);
      if (rule.blankWhenEmpty && (value == null || String(value).trim() === '')) {
        const why = typeof rule.why === 'function' ? rule.why(profile) : rule.why;
        return { kind: 'blank', why: why || 'nothing in your profile goes here — left empty on purpose' };
      }
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
        return { kind: 'answer', value: alts.length === 1 ? alts[0] : alts, review: !!rule.review, ...(rule.consent ? { consent: true } : {}) };
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
