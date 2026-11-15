/**
 * MAIL — read his inbox, and move the application cards the companies have
 * answered.
 *
 * Alex, 2026-09-15: "you can read my email and mark what jobs have responded
 * to me and status."
 *
 * HOW IT READS. Gmail's own API with the read-only scope
 * (`gmail.readonly`): it can list and read messages and can do nothing else —
 * not send, not delete, not label. He connects it once on Google's own consent
 * page in his own browser; Jarvis never sees his password. The refresh token
 * lives in the store folder, which is gitignored, and "Disconnect" deletes it.
 *
 * WHAT IT DOES WITH A MESSAGE. Three steps, each a pure function below so each
 * can be tested without an inbox:
 *
 *   1. `classifyMessage` — is this an application received, an assessment, an
 *      interview request, a rejection, an offer, or none of those? Plain
 *      phrase rules, strongest outcome first (a rejection usually opens with
 *      "thank you for applying", so "received" is checked last).
 *   2. `matchMessage` — which of HIS applications is it about? The company has
 *      to appear in the sender's name, the sender's domain or the subject — never
 *      only somewhere in the body, where a newsletter can mention anyone. Several
 *      applications at one company are told apart by the role's words; when
 *      they cannot be, the message is recorded as UNSURE and no card moves.
 *   3. `nextStatus` — cards only move FORWARD (received → applied, assessment
 *      → responded, interview → interview, offer → offer), and a rejection
 *      closes anything short of an offer. An older email never undoes a newer
 *      decision.
 *
 * Every move is written down with the email's subject, sender and date, shown on
 * the card, and one click puts the card back where it was.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { openDb, writeLockFree, LOCK_FREE_BACKOFF_MS } from './db.mjs';
import { dbPath as storeDbPath, STORE_DIR, isStoreFile, pointAt as storePointAt } from './store.mjs';
import { LINKEDIN_SEARCH, applyLinkedInEmails, isLinkedInMailSeen, linkedInMailSince, setLinkedInMailSince } from './linkedin-activity.mjs';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Mail that could be about a job application. Gmail search syntax. */
// "resume" and "your interest": Apple's receipt ("Thanks for your interest in
// Apple. We just received your resume for the following role", 2026-10-16)
// used none of the other words and never reached the reader (F-926).
export const EASY_APPLY_SEARCH = 'from:jobs-noreply@linkedin.com subject:("application was sent")';
// The re-read runs once per ledger: mail_meta holds this key once it has.
const EASY_APPLY_REREAD = 'easy-apply-reread';
export const SEARCH = '(application OR applying OR applied OR interview OR candidacy OR candidate OR position OR assessment OR recruiter OR "next steps" OR offer OR resume OR "your interest") -category:promotions -category:social';

const files = (dir = STORE_DIR) => ({
  client: path.join(dir, 'gmail-client.json'),
  token: path.join(dir, 'gmail-token.json'),
  state: path.join(dir, 'gmail-state.json'),
});
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf-8')); } catch { return null; } };
const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); };

// ── 1. what kind of message ──────────────────────────────────────────

const RULES = [
  ['offer', /\b(pleased|delighted|happy|excited) to (extend|offer)\b|\boffer letter\b|\bformal offer\b|\bverbal offer\b/],
  // "This requisition has now been closed" (Applied Materials, 2026-08-29 and
  // 2026-09-09) is a no to that application, however warmly it is worded.
  // "We are moving forward with another applicant for this role" (Applied
  // Materials, 2026-10-12) read as a receipt (F-718).
  ['rejection', /\brequisition has (?:now )?been (?:closed|cancell?ed)\b|\bposition (?:has been|is now|was) (?:closed|cancell?ed)\b|\bunfortunately\b|\bnot (to )?(be )?mov(e|ing) forward\b|\bdecided (not to|to not) (move|proceed)|\b(pursue|mov(e|ing) forward with|proceed(ing)? with|progress(ing)? with|go(ing)? (ahead )?with|continu(e|ing) with) (other|another) (candidates?|applicants?)\b|\bother candidates\b.{0,80}\b(closely|better) (match|align)|\bno longer (being )?considered\b|\bposition (has been|was|is now) filled\b|\bnot been selected\b|\bwere not selected\b|\bregret to inform\b|\bdifferent direction\b|\bwill not be (moving|proceeding)\b|\bunable to proceed with your application\b|\bdo(?:es)? not (?:currently )?meet the (?:minimum )?(?:criteria|qualifications|requirements)\b/],
  ['interview', /\b(schedule|book|set up|arrange|find a time for)\b.{0,50}\b(interview|call|chat|conversation|phone screen|video call)\b|\binterview (invitation|request)\b|\binvite you to (an? )?(interview|call|phone screen)\b|\bavailability for (an? )?(interview|call|chat)\b|\bphone screen\b|\bnext (step|round) (is|will be) (an? )?(interview|call)\b|\binterview confirmation\b|\bconfirm(ing|ed)? (your|the) interview\b|\b(1st|2nd|3rd|first|second|final|onsite|on-site|panel) (round )?interview\b|\bmaking it to the next round\b/],
  ['assessment', /\b(online|technical|skills?) assessment\b|\bhackerrank\b|\bcodesignal\b|\bcodility\b|\bhirevue\b|\btake[- ]home\b|\bcomplete (the|a|this|your) (assessment|test|challenge|questionnaire)\b/],
  // "We received your job application for Mechanical Design Engineer - 40738"
  // (Nokia and Ralliant on Oracle, 2026-10-16) matched nothing: no "have", and
  // "job" between "your" and "application". Both cards stayed in Tracking.
  // LinkedIn Easy Apply: "Alex, your application was sent to Chism Automation" (F-1043).
  ['received', /\byour application was sent to\b|\bthank(s| you) for (applying|your application|submitting your application)\b|\b(we('ve| have)?|has been) received your (job )?application\b|\byour recent job application for\b|\bapplication (has been )?(received|submitted)\b|\bapplication confirmation\b|\bsuccessfully (submitted|applied)\b|\bthank(s| you) for your interest in\b|\breceived your (resume|cv)\b/],
];

const APPLICATION_CONTEXT = /\b(?:your (?:job )?application|(?:for|of) applying|you applied|applied (?:for|to)|application (?:for|to|update|status|received|confirmation)|your candidacy|your interest in (?:the|our|joining|working|a)\b|requisition|job id|hiring team|talent acquisition|recruiting team|recruitment team|received your (?:resume|cv)|for the following (?:role|position)|worldwide recruiting)\b/;
const STANDS_ALONE = {
  rejection: /\bnot (?:to )?(?:be )?mov(?:e|ing) forward\b|\b(?:pursue|mov(?:e|ing) forward with|proceed(?:ing)? with|progress(?:ing)? with|go(?:ing)? (?:ahead )?with|continu(?:e|ing) with) (?:other|another) (?:candidates?|applicants?)\b|\bno longer (?:being )?considered\b|\bnot been selected\b|\bwere not selected\b|\brequisition has (?:now )?been (?:closed|cancell?ed)\b/,
  offer: /\boffer letter\b|\bformal offer\b|\bverbal offer\b|\boffer of employment\b|\bextend (?:you )?(?:an? )?(?:formal |verbal )?offer\b/,
};
const INVITES_HIM =/\b(?:we|i)(?:'d| would) (?:like|love) to (?:schedule|set up|book|arrange|invite|speak|chat|talk|meet)\b|\binvite you\b|\byour availability\b|\binterview confirmation\b|\bconfirm(?:ing|ed)? your interview\b|\bmaking it to the next round\b/;

/** @returns {'offer'|'rejection'|'interview'|'assessment'|'received'|null} */
export function classifyMessage({ subject = '', body = '' } = {}) {
  // NOTICES ABOUT THE CAREERS SITE ARE NOT ABOUT AN APPLICATION. Jabil's "Careers
  // Site Update" (sign-in options turned off) said "thank you for your interest"
  // and read as a receipt.
  if (/\b(?:site update|newsletter|webinar|sign[- ]?in option|reset your password|verify your email|talent community|job alert|jobs? (?:for you|you may like)|recommended jobs)\b/i.test(subject)) return null;
  // A NEW CAREERS ACCOUNT IS NOT AN APPLICATION (F-926). "Zimmer Biomet Careers
  // Account Created" moved a Queued card to Applied once the search widened;
  // Veeco's "Thanks for creating an account!" read as a receipt too.
  if (/\baccount (?:created|activation|has been created)\b|\bcreat(?:ed|ing) (?:an|your) (?:candidate |careers? )?account\b|\bactivate your account\b/i.test(subject)) return null;
  // AN APPLICATION NOT FINISHED IS NOT A RECEIPT (F-739). "Continue to apply for
  // the job Design Engineer 1" (Denso, Cummins, Dell), "Complete your
  // application" (HPE), "Your Amazon job application is incomplete!" and
  // Amazon's "Keep track of your application" — sent when he STARTS one —
  // were read as "received" and could move a card to Applied. His rule,
  // 2026-10-16: no confirmation email means he did not apply.
  if (/\b(?:continue to apply|complete your (?:job )?application|finish your application|application (?:is|was) incomplete|incomplete (?:job )?application|keep track of your application|verify your candidate account|complete setup for your candidate account)\b/i.test(subject)) return null;
  const text = `${subject}\n${body}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 8000);
  // NOT ABOUT AN APPLICATION, NOT A VERDICT ON ONE (F-541). A month of his inbox
  // read as five "rejections", an "offer" and an "interview" that were a storage
  // unit, a utility bill, a FACEIT ban, a sold-out hotel and the NYT:
  // "unfortunately" and "regret to inform" are everyday words. Every real ATS
  // verdict names the application itself. "position", "role" and "candidate"
  // are left out on purpose — the news uses all three.
  //
  // Some real ones do not name it either, and pass on their own wording:
  //   interview   — "We would like to schedule a 30 minute phone interview":
  //                 it speaks to him directly, which a newsletter does not
  //   assessment  — it names the platform or the kind of test
  //   rejection, offer — only hiring's own phrases ("not moving forward",
  //                 "extend an offer"); never "unfortunately", "regret to
  //                 inform" or "excited to offer", which is what misfired
  const aboutApplication = APPLICATION_CONTEXT.test(text);
  const passes = (kind) => aboutApplication
    || (kind === 'interview' && INVITES_HIM.test(text))
    || kind === 'assessment'
    || STANDS_ALONE[kind]?.test(text);
  // A PROMISE IS NOT AN INVITATION (first real sync, 2026-09-17). Ashby's
  // receipt for Applied Intuition says "If your application seems like a good
  // fit for the role, we'll reach out directly to set up an initial call" —
  // and moved the card to Interview. Sentences that describe what MIGHT happen
  // ("if…", "once…", "should you be selected…") are left out of the interview
  // and assessment rules; everything else still reads the whole message.
  const firm = text.split(/(?<=[.!?])\s+/)
    .filter((s) => !/(^|\s)(if|once|should|in the event|when we|may|might)\b/.test(s)).join(' ');
  for (const [kind, re] of RULES) {
    if (!passes(kind)) continue;
    const against = kind === 'interview' || kind === 'assessment' ? firm : text;
    if (re.test(against)) return kind;
  }
  return null;
}

// ── 2. which application ─────────────────────────────────────────────

const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|gmbh|technologies|technology|holdings|group|the)\b/g;
/** "0001 Applied Materials, Inc" → "applied materials"; "Micron Technology" → "micron". */
export function companyCore(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/^\s*\d+\s+/, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
const wordsIn = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
const STOP = new Set(['engineer', 'engineering', 'the', 'and', 'for', 'with', 'new', 'grad', 'college', 'united', 'states', 'america']);

/**
 * The names a company goes by in its own email. The store says "Sunday
 * Robotics"; the email says "Sunday" from sunday.ai. A trailing word that only
 * says what industry it is in is dropped for a second, shorter name — never a
 * word that is part of the name ("Applied Materials" stays whole, so it is
 * never just "Applied").
 */
// "Samsung Electronics America" signs "Samsung", "Matic Robots" signs "Matic"
// (F-1043: both receipts matched nothing). The shorter name is never a plain
// word on its own — "Applied Electronics" stays whole, like Applied Materials.
const TRAILING_GENERIC = /\s(robotics|robots|electronics|ai|labs?|aviation|systems|energy|surgical|automation|motors|space|aerospace|bio|health|industries|solutions|international|global|usa|america)$/;
const PLAIN_WORD = new Set(['applied', 'general', 'advanced', 'american', 'united', 'national', 'international', 'digital', 'first', 'global', 'precision', 'universal', 'standard', 'modern', 'future', 'superior', 'pacific', 'atlantic', 'western', 'eastern', 'northern', 'southern', 'central']);
export function companyNames(name) {
  const core = companyCore(name);
  const out = core ? [core] : [];
  let short = core;
  while (TRAILING_GENERIC.test(short)) short = short.replace(TRAILING_GENERIC, '');
  if (short && short !== core && short.replace(/ /g, '').length >= 4 && !PLAIN_WORD.has(short)) out.push(short);
  return out;
}

/**
 * Is a stored company name this company? `core` is a companyNames() name. It
 * has to stand as whole words in the stored name: "Matic" is Matic Robots and
 * never Automatic Systems; "Apple" is never Pineapple (F-1043 review). A wrong
 * match here could mark a live application rejected.
 */
export function sameCompany(stored, core) {
  const want = String(core || '').toLowerCase().trim();
  if (!want) return false;
  if (companyNames(stored).includes(want)) return true;
  const re = new RegExp(`(^|[^a-z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^a-z0-9]+')}([^a-z0-9]|$)`);
  return re.test(companyCore(stored) || '');
}

/** How long a name of this company matched in the sender or subject (0 = no match). */
function companyAppears(company, { fromName, fromDomain, fromLocal = '', subject }) {
  let best = 0;
  // companyCore spells "&" as "and"; the email has to be read the same way, or
  // "at Johnson & Johnson" never names Johnson & Johnson (F-785).
  const amp = (s) => String(s || '').replace(/&/g, ' and ');
  fromName = amp(fromName); subject = amp(subject);
  // A Workday tenant's own mailbox names the company: micron@myworkday.com.
  // Micron's rejections say "Micron" nowhere else but the body (F-785).
  const tenant = /(^|\.)myworkday\.com$/i.test(String(fromDomain || '')) ? String(fromLocal || '').toLowerCase() : '';
  for (const name of companyNames(company)) {
    const re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^a-z0-9]*')}([^a-z0-9]|$)`, 'i');
    // The sender's own domain: micron.com, sunday.ai — the name with its spaces
    // removed, as a whole label.
    const slug = name.replace(/ /g, '');
    const inDomain = slug.length >= 3 && String(fromDomain || '').toLowerCase().split('.').includes(slug);
    // The whole mailbox name, so two letters are enough: hp@myworkday.com is
    // HP's tenant, and HP's rejections name it nowhere else (F-1043).
    const inTenant = slug.length >= 2 && tenant === slug;
    // A board slug kept as the store's name ("Marianaminerals") against the
    // email's "Mariana Minerals": two or three whole words in a row that spell
    // it once their spaces go (F-1043). Long names only, so no short slug is
    // ever found inside an ordinary phrase.
    const spelled = !name.includes(' ') && slug.length >= 8 && [fromName, subject].some((s) => spellsAcross(s, slug));
    if (re.test(fromName) || re.test(subject) || inDomain || inTenant || spelled) best = Math.max(best, name.length);
  }
  return best;
}
function spellsAcross(text, slug) {
  const w = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < w.length; i += 1) {
    for (let k = 2; k <= 3 && i + k <= w.length; k += 1) if (w.slice(i, i + k).join('') === slug) return true;
  }
  return false;
}

/**
 * The role an email names, in the phrasings recruiting systems actually use:
 * "the position of Gas Systems Engineer - O&M", "your application for the
 * Manufacturing Engineer I - (E1) at Applied Materials", "applying for the
 * Mechanical Engineer role", "your interest in Mechanical Engineer II, Amazon
 * Industrial Robotics (ID: 3168805)", or a subject "Your application | Systems
 * Engineer R2626795 at Applied Materials". Null when it names none.
 */
export function roleNamed({ subject = '', body = '' } = {}) {
  const b = String(body || '').replace(/\s+/g, ' ').slice(0, 2500);
  const s = String(subject || '');
  const tries = [
    // Up to the verb that follows it, not the first comma: "New College Grad -
    // RDA Engineer, APTD and are thrilled".
    [b, /\bposition of ([^.!?]{3,140}?)(?= and (?:are|we|is)\b| at |[.!?]| is | has )/i],
    [b, /\bapplication for the (?:position of )?([^.!?]{3,140}?)(?= (?:position|role)\b| at |[.!?])/i],
    [b, /\bapplying (?:for|to) the ([^.!?]{3,140}?) (?:position|role)\b/i],
    // Micron's rejection drops the "the": "for applying for New College Grad -
    // PCVD Process Engineer role at Micron" (F-785). Without a "the" the words
    // may be the company ("applying to Acme Robotics for the … position"), so
    // the role may not run across " for ", " to " or " and ".
    [b, /\bapplying (?:for|to) (?!the )((?:(?! (?:for|to|and|at|with) )[^.!?]){3,140}?) (?:position|role)\b/i],
    // Johnson & Johnson: "not selected for the role of Operations Process
    // Engineer (Capital System) R-098612."
    [b, /\bfor the role of ([^.!?]{3,140}?)(?= R-?\d| at |[.!?])/i],
    // Lam: "your interest in the Manufacturing Engineer 2 opening at Lam Research" (F-1043).
    [b, /\binterest in the ([^.!?]{3,140}?) (?:position|role|opening)\b/i],
    [b, /\binterest in ([^.!?]{3,140}?) \(ID/i],
    [b, /\bfor the ([^.!?]{3,140}?) (?:position|role)\b/i],
    [s, /\|\s*([^|]{3,120}?)(?:\s+R\d{6,}\b.*|\s+at\s+.*)?$/i],
  ];
  for (const [text, re] of tries) {
    const m = text.match(re);
    if (m && m[1] && !/\b(?:your|our|this|a|an)\s*$/i.test(m[1])) return cleanRole(m[1]) || null;
  }
  return null;
}
// THE ROLE, NOT THE SENTENCE AFTER IT OR THE REQUISITION (F-1043). HP's body
// has no stop after the role ("…Interactive Design Engineer - HPIQ We will not
// be moving forward"), Lam's ends "Mechatronics Engineer 2, Req. 199770", and
// Flex's "Mechanical engineer WD233476": each named role then matched no card.
// A capitalised sentence opener is cut (case-sensitive: no title holds " We "),
// then a trailing requisition ("Req. N" or a lettered id — a bare number stays,
// roleWords already drops it), then dangling punctuation.
function cleanRole(s) {
  return String(s).trim()
    // Symbotic leads with it: "the R8402 New Grad- Manufacturing Engineer position".
    .replace(/^[A-Z]{1,3}-?\d{4,}[\s:–-]+/, '')
    .replace(/\s+(?:We|Unfortunately|However|At this time|After careful|Thank you)\b.*$/, '')
    .replace(/[\s,;–-]+(?:req(?:uisition)?\.?\s*(?:id|no\.?|number|#)?\s*[:#]?\s*[A-Z]{0,3}-?\d{4,}|[A-Z]{1,3}-?\d{5,}(?:-\d+)?)\s*$/i, '')
    // The capture stops at "Req." itself (no stops inside a role), leaving ", Req".
    .replace(/[\s,;]+req(?:uisition)?(?:\s*(?:id|no|number|#))?\s*$/i, '')
    .replace(/\s*[-,(]+\s*$/, '')
    .trim();
}

/** A title reduced to the words that name the role: no location, no filler, no level noise. */
const ROLE_FILLER = new Set(['engineer', 'engineering', 'the', 'and', 'for', 'with', 'new', 'grad', 'graduate', 'college', 'ncg',
  'united', 'states', 'america', 'usa', 'us', 'remote', 'onsite', 'hybrid', 'of', 'at', 'or', 's',
  'ca', 'tx', 'az', 'or', 'id', 'va', 'nc', 'nh', 'wa', 'ny', 'ma', 'co', 'mi', 'oh', 'pa', 'nj', 'fl', 'ga', 'il', 'mn', 'ut', 'nv', 'mt']);
const US_STATES = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';
export function roleWords(title, location = '') {
  const where = new Set(String(location || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean));
  const cut = String(title || '')
    // "(Santa Clara, CA)" — a location in brackets is never the role. "(E1)" and
    // "(RDA & Metrology)" are, so only a bracket that reads as a place goes.
    .replace(/\((?:[^()]*,\s*[A-Z]{2}|[^()]*\b(?:remote|hybrid|onsite|united states|usa)\b[^()]*|ID:?\s*\d+)\)/gi, ' ')
    // Req and posting numbers: "…Gears, 276665", "R2626795", "J2454512".
    .replace(/,?\s*\b(?:[RJ]-?)?\d{5,}\b/g, ' ')
    // A slug-built title with the location stuck on its end and no location
    // field to strip it by: "… Boise Idaho United States Of America".
    // Anchored on the STATE, so the role word before the city survives:
    // "Equipment Technician Manassas Virginia United States Of America".
    .replace(new RegExp(`(?:\\s+[A-Z][a-z]+)?\\s+(?:${US_STATES})(?:\\s+United States(?: Of America)?|\\s+USA)?\\s*$`), '')
    .replace(/\s+United States(?: Of America)?\s*$/i, '');
  const keep = (w) => {
    if (ROLE_FILLER.has(w) || where.has(w)) return false;
    // Levels are part of the role: I, II, III, E1, 2.
    if (/^(?:i{1,3}|e\d|\d)$/.test(w)) return true;
    return w.length >= 2;
  };
  return [...new Set(cut.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).filter(keep))];
}

/**
 * ONE ROLE, WHEREVER AND HOWEVER OFTEN IT IS POSTED (2026-09-26).
 *
 * "theres some duplicate roles in the applications tab". Measured that day:
 * Amazon's "Robotics Systems Engineer I, Tech Deployment" was five rows —
 * five requisitions in Boston, Austin and North Reading, with a receipt for
 * three of them — and Intuitive's "Manufacturing Engineer" two requisitions in
 * Sunnyvale, both applied. None is a copy of another; each is its own
 * application. What was wrong was drawing them as five identical lines. The
 * sheet folds rows with this key into one line that expands to the postings.
 *
 * Company and the role's own words, with location and filler out: the same
 * test the receipt matcher uses, so the sheet and the mail agree on what "the
 * same role" means. A title with no role words left keys on its id, alone.
 */
/**
 * The posting numbers in a card's link: 10418150, R2627688 → 2627688, 744000144811119.
 *
 * Not a LinkedIn link's (2026-10-01): its number is LinkedIn's listing, not the
 * employer's requisition, so WeRide's Lever posting and LinkedIn's copy of it
 * read as two requisitions and both receipts stayed unsure. A Lever or Ashby
 * posting id is a UUID, one id — the digit runs inside it ("82955" in
 * 82955de9-…) are not numbers.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const isLinkedIn = (j) => /(?:^|\/\/|\.)linkedin\.com\//i.test(String(j?.url || ''));
function urlIds(job) {
  if (isLinkedIn(job)) return new Set();
  const url = String(job?.url || '');
  const uuids = (url.match(UUID_RE) || []).map((u) => u.toLowerCase());
  return new Set([...uuids, ...(url.replace(UUID_RE, ' ').match(/\d{5,}/g) || [])]);
}

/**
 * LINKEDIN'S COPY OF A POSTING HE HAS ON THE BOARD (2026-10-01).
 *
 * "the same job i applied to is still on my list": WeRide's Application
 * Engineer was a Lever card he applied to and the LinkedIn import of the same
 * posting, still in Tracking. The copy is the same job, so it is not a second
 * application for a receipt to choose between, and once the board card is
 * applied it leaves his list (pointed at the board card, the way dedupe.mjs
 * points a second spelling at its survivor — nothing deleted).
 *
 * Strict, because "Manufacturing Engineer" is one role word: the same company
 * and role words, the LinkedIn card's city in the board card's location, and
 * exactly one board card that fits.
 *
 * @returns Map(copyId → the board card it copies)
 */
const cityOf = (loc) => String(loc || '').split(/[,;(]/)[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const spaced = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
// The company and the role's own words, location and filler out.
const copyKey = (j) => {
  const words = roleWords(j?.title, j?.location);
  return words.length ? `${companyCore(j?.company)}|${[...words].sort().join(' ')}` : '';
};
export function linkedInCopies(jobs) {
  const out = new Map();
  const boards = (jobs || []).filter((j) => !isLinkedIn(j));
  for (const li of (jobs || []).filter(isLinkedIn)) {
    const key = copyKey(li);
    const city = cityOf(li.location);
    if (!key || !city) continue;
    const hits = boards.filter((b) => copyKey(b) === key && spaced(b.location).includes(` ${city} `));
    if (hits.length === 1) out.set(li.id, hits[0]);
  }
  return out;
}

/**
 * The requisition numbers an email states AS an id — "(ID: 10418150)",
 * "R2627688", "Job ID 3168805", "Req #44141434" — and not every long number in
 * it, which would include zip codes and phone numbers.
 */
export function emailReqIds(text) {
  const t = String(text || '');
  const out = new Set();
  // "Req. 199770" (Lam, F-1043) as well as "Req ID: …" and "Job ID 2934567".
  for (const m of t.matchAll(/\b(?:job\s*id|req(?:uisition)?\.?(?:\s*(?:id|number|no\.?))?|id)\s*[:#]?\s*(?:[A-Z]{1,3}-?)?(\d{5,})\b/gi)) out.add(m[1]);
  for (const m of t.matchAll(/\b(?:R|JR|REQ)-?(\d{6,})\b/g)) out.add(m[1]);
  return out;
}

export function sameRoleKey(job) {
  const words = roleWords(job?.title, job?.location);
  if (!words.length) return `id:${job?.id || ''}`;
  return `${companyCore(job?.company)}|${[...words].sort().join(' ')}`;
}

/**
 * One card out of several equally good ones, or null. The same job saved twice
 * (Lam's Mechanical Engineer 2 under one req number; Sunday's board page and its
 * application page) is ONE application: the copy furthest along wins, then the
 * most specific link. Different titles are different jobs, and stay unsure.
 */
const STAGE = { new: 0, hidden: 0, inbox: 1, interested: 2, queued: 3, applied: 4, responded: 5, interview: 6, offer: 7, rejected: 4 };
function pickOne(jobs) {
  if (!jobs.length) return null;
  if (jobs.length === 1) return jobs[0];
  // TWO REQUISITIONS ARE TWO APPLICATIONS, however alike the titles (2026-09-26).
  // Amazon's Tech Deployment role is five requisitions he applied to in three
  // cities; "the copy furthest along" sent every receipt to one of them.
  const reqs = jobs.map(urlIds).filter((s) => s.size);
  for (let i = 0; i < reqs.length; i += 1) {
    for (let k = i + 1; k < reqs.length; k += 1) {
      if (![...reqs[i]].some((n) => reqs[k].has(n))) return null;
    }
  }
  const same = new Set(jobs.map((j) => roleWords(j.title, j.location).sort().join(' ')));
  const advanced = jobs.filter((j) => (STAGE[j.status] ?? 0) >= 4);
  if (same.size !== 1 && advanced.length !== 1) return null;
  const pool = same.size === 1 ? jobs : advanced;
  return [...pool].sort((a, b) => (STAGE[b.status] ?? 0) - (STAGE[a.status] ?? 0)
    || String(b.url || '').length - String(a.url || '').length)[0];
}

/**
 * AN APPLICATION NOT ON THE BOARD (2026-09-17). Ten receipts named roles he had
 * applied to that were still `new` or `hidden` in the store — Amazon Mechanical
 * Engineer II (Industrial Robotics), the AMAT rotation programs. A receipt is
 * proof he applied, so the posting belongs on the board; but the whole store
 * holds many near-identical postings, so the bar is strict: the posting's own
 * id in the email, or exactly one posting whose role words match the named role
 * word for word. Anything else stays unsure.
 *
 * @param jobs  every posting at that company, any status
 */
export function matchOffBoard(msg, named, jobs) {
  if (!jobs?.length) return null;
  const text = `${msg.subject || ''}\n${String(msg.body || '').slice(0, 2500)}`.toLowerCase();
  const byId = jobs.filter((j) => (String(j.url || '').match(/\d{5,}/g) || []).some((n) => text.includes(n)));
  if (byId.length === 1) return { jobId: byId[0].id, company: byId[0].company, why: 'the posting id in the email, found among postings not yet on your board' };
  if (!named) return null;
  // Exact: the same role words both ways. A stored title cut short by the
  // scanner ("… Bs Or Ms Gloucest") may end on a truncated word, which counts
  // when the email spells the whole word.
  const spelled = String(named).toLowerCase();
  const exact = jobs.filter((j) => {
    const want = roleWords(named, j.location);
    const have = roleWords(j.title, j.location);
    if (!want.length || !want.every((w) => have.includes(w))) return false;
    return have.filter((w) => !want.includes(w)).every((w) => w.length >= 5 && new RegExp(`\\b${w}[a-z]+`).test(spelled));
  });
  if (exact.length === 1) return { jobId: exact[0].id, company: exact[0].company, why: `the role named in the email: "${named}", found among postings not yet on your board` };
  return null;
}

/**
 * @param msg   { fromName, fromEmail, subject, body }
 * @param jobs  his applications: { id, company, title, status, url }
 * @returns { jobId, company, why } | { unsure: [ids], company, why } | null
 */
export function matchMessage(msg, jobs) {
  const [fromLocal = '', fromDomain = ''] = String(msg.fromEmail || '').split('@');
  const at = { fromName: String(msg.fromName || ''), fromDomain, fromLocal, subject: String(msg.subject || '') };
  const scoredCo = jobs.map((j) => ({ j, len: companyAppears(j.company, at) })).filter((x) => x.len > 0);
  if (!scoredCo.length) {
    // NO COMPANY NAMED, ONLY THE REQUISITION (2026-10-16). Oracle tenants send
    // "Your recent job application for Associate Mechanical Engineer I - 10698"
    // from ibwujb.fa.sender@workflow…oraclecloud.com — Ralliant appears
    // nowhere. The requisition in the email, on exactly one of his cards, is
    // that application.
    const stated = emailReqIds(`${msg.subject || ''}\n${String(msg.body || '').slice(0, 2500)}`);
    // …and Oracle's "<role> - 10698": a bare number in the SUBJECT, not a year.
    for (const n of String(msg.subject || '').match(/\b\d{5,8}\b/g) || []) if (!/^(19|20)\d\d$/.test(n)) stated.add(n);
    if (stated.size) {
      const byReq = jobs.filter((j) => [...urlIds(j)].some((n) => stated.has(n)));
      if (byReq.length === 1) return { jobId: byReq[0].id, company: byReq[0].company, why: `the requisition in the email (${[...stated][0]}), no company named` };
    }
    return null;
  }
  // The longest name that matched wins: "Applied Intuition" is not "Applied
  // Materials" — and one company at a time: two employers cannot share one email.
  const named = roleNamed(msg);
  const groups = new Map();
  for (const x of [...scoredCo].sort((a, b) => b.len - a.len)) {
    const k = companyCore(x.j.company);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x.j);
  }
  const byLength = [...groups.values()];
  // …UNLESS ONLY A SHORTER NAME HOLDS THE ROLE THE EMAIL NAMES (F-1043). HP's
  // rejections put "- HPIQ" in the subject, so "HP IQ" outranked "HP Inc.",
  // whose cards hold the two roles they name; HP IQ's one card is neither.
  const holdsRole = (list) => list.some((j) => {
    const want = roleWords(named, j.location);
    const have = roleWords(j.title, j.location);
    return want.length > 0 && want.every((w) => have.includes(w));
  });
  const found = (named && !holdsRole(byLength[0]) && byLength.slice(1).find(holdsRole)) || byLength[0];
  // LinkedIn's copy of a board card is that card, not another application.
  const copies = linkedInCopies(found);
  const atCompany = found.filter((j) => !copies.has(j.id));
  const company = atCompany[0].company;
  if (atCompany.length === 1) {
    // The only card at this company is not the application an email names when
    // the email names a different role (Tesla sends one receipt per role).
    const want = named ? roleWords(named, atCompany[0].location) : [];
    const have = roleWords(atCompany[0].title, atCompany[0].location);
    if (!want.length || want.every((w) => have.includes(w))) return { jobId: atCompany[0].id, company, why: 'the only application at this company' };
    return { unsure: [atCompany[0].id], company, named, why: `the email names "${named}", which is not one of your applications at ${company}` };
  }

  // Several applications at one company: the role's own words in the subject
  // and the opening of the body, or its req number.
  const text = `${msg.subject}\n${String(msg.body || '').slice(0, 2500)}`.toLowerCase();

  // THE REQUISITION THE EMAIL STATES outranks the title it names (2026-09-26).
  // Amazon's "Tech Deployment (ID: 10418150)" receipt went to the 10503216 card
  // because five cards share that title and the title was read first.
  const stated = emailReqIds(`${msg.subject}\n${String(msg.body || '').slice(0, 2500)}`);
  if (stated.size) {
    const byReq = atCompany.filter((j) => [...urlIds(j)].some((n) => stated.has(n)));
    if (byReq.length === 1) return { jobId: byReq[0].id, company, why: `the requisition in the email (${[...stated][0]})` };
    // An id that is none of his cards': the title may match a card, but that
    // card is a different requisition. Left unsure, so the off-board lookup can
    // find the posting the email is really about.
    if (!byReq.length && named) {
      const sameTitle = atCompany.filter((j) => {
        const want = roleWords(named, j.location);
        const have = roleWords(j.title, j.location);
        return want.length && want.every((w) => have.includes(w));
      });
      // Only when the cards could carry the email's id at all: Micron's
      // JR107194 is a Workday requisition and its cards hold careers-site
      // numbers (44543481), so no card ever matches it (F-785). An id with a
      // letter prefix counts only against cards whose link uses that prefix;
      // a bare number ("ID: 2934567") is the same kind as the card's, whatever
      // its length — Amazon's run 7 and 8 digits.
      const raw = `${msg.subject || ''}\n${String(msg.body || '').slice(0, 2500)}`;
      const prefixOf = new Map();
      for (const m of raw.matchAll(/\b([A-Z]{1,3})-?(\d{5,})\b/g)) if (stated.has(m[2])) prefixOf.set(m[2], m[1]);
      const sameKind = (j) => [...stated].some((s) => !prefixOf.has(s)
        || new RegExp(`(?:^|[^a-z])${prefixOf.get(s)}-?\\d{5,}`, 'i').test(String(j.url || '')));
      if (sameTitle.length && sameTitle.every((j) => urlIds(j).size && sameKind(j))) {
        return { unsure: sameTitle.map((j) => j.id), company, named, why: `the email names requisition ${[...stated][0]}, which is none of your ${company} cards` };
      }
    }
  }

  // THE ROLE THE EMAIL NAMES, compared with each card's title once the location
  // and filler are taken out of both (first real sync, 2026-09-17). "Gas Systems
  // Engineer - O&M" against "Gas Systems Engineer O M Boise Idaho United States
  // Of America" scored under half, because Boise, Idaho and America counted
  // against it.
  if (named) {
    if (roleWords(named).length) {
      const ranked = atCompany.map((j) => {
        const have = roleWords(j.title, j.location);
        const want = roleWords(named, j.location);
        const hit = want.filter((w) => have.includes(w)).length;
        return { j, recall: want.length ? hit / want.length : 0, precision: have.length ? hit / have.length : 0 };
      }).filter((x) => x.recall === 1 && x.precision >= 0.6)
        .sort((a, b) => b.precision - a.precision);
      const top = ranked.filter((x) => x.precision === ranked[0]?.precision).map((x) => x.j);
      const pick = pickOne(top);
      if (pick) return { jobId: pick.id, company, why: `the role named in the email: "${named}"` };
      if (!ranked.length) {
        return { unsure: atCompany.map((j) => j.id), company, named, why: `the email names "${named}", which is not one of your applications at ${company}` };
      }
    }
  }
  const said = wordsIn(text);
  const scored = atCompany.map((j) => {
    const title = [...wordsIn(j.title)].filter((w) => !STOP.has(w));
    // One shared word is not a match: "Mechanical Engineer II E2" is one word
    // ("mechanical") once the filler is gone, and it claimed a rotation-program
    // receipt on 2026-09-17. Word overlap counts only for titles with two or more.
    let score = title.length >= 2 ? title.filter((w) => said.has(w)).length / title.length : 0;
    // A req number from the posting's link (R2628090, J-00351774, 44122410).
    if ((String(j.url || '').match(/\d{5,}/g) || []).some((n) => text.includes(n))) score += 2;
    if (String(j.title || '').length > 6 && text.includes(String(j.title).toLowerCase())) score += 1;
    return { j, score };
  }).sort((a, b) => b.score - a.score);
  if (scored[0].score > 0.5 && scored[0].score > (scored[1]?.score ?? 0)) {
    return { jobId: scored[0].j.id, company, why: 'the role named in the email' };
  }
  if (scored[0].score > 0.5) {
    const pick = pickOne(scored.filter((x) => x.score === scored[0].score).map((x) => x.j));
    if (pick) return { jobId: pick.id, company, why: 'the role named in the email' };
  }
  return { unsure: atCompany.map((j) => j.id), company, named: named || null, why: `${atCompany.length} applications at ${company} and the email does not say which` };
}

// ── 3. where the card goes ───────────────────────────────────────────

const RANK = { new: 0, inbox: 1, interested: 2, queued: 3, hidden: 0, applied: 4, responded: 5, interview: 6, offer: 7 };
const TARGET = { received: 'applied', assessment: 'responded', interview: 'interview', offer: 'offer', rejection: 'rejected' };

/** The status a message moves a card to, or null to leave it. */
export function nextStatus(current, kind) {
  const target = TARGET[kind];
  if (!target) return null;
  if (target === 'rejected') return current === 'rejected' || current === 'offer' ? null : 'rejected';
  if (current === 'rejected') return null;
  return (RANK[target] ?? -1) > (RANK[current] ?? -1) ? target : null;
}

/**
 * THE APPLICATION HE FILLED JUST BEFORE THE RECEIPT (2026-09-24).
 *
 * "Thank you for applying to Peak Energy" names no role, and he had two cards
 * there; OpenAI sent two such receipts against three cards. Each stayed unsure,
 * and the cards he had really applied to sat in Interested. But the engine
 * records when it filled each form (applied_at), he presses Submit minutes
 * later, and the receipt follows seconds after. So among the cards the email
 * could be about, the one filled most recently before it — within three days,
 * and not already marked applied or later — is the application it confirms.
 * Receipts only: a rejection or an interview says nothing about when he
 * applied.
 *
 * @param ids        the card ids the email could be about
 * @param jobs       the store's cards ({ id, appliedAt | apply.at })
 * @param date       the email's date (ISO)
 * @param getStatus  (id) => current status
 */
const FILL_WINDOW_MS = 3 * 86400e3;
const BEFORE_APPLIED = new Set(['', 'new', 'inbox', 'interested', 'queued']);
export function pickByFill(ids, jobs, date, getStatus) {
  const t = Date.parse(date || '');
  if (!t) return null;
  const want = new Set((ids || []).map(String));
  const filled = jobs.filter((j) => want.has(String(j.id)))
    .map((j) => ({ j, at: Date.parse(j.appliedAt || j.apply?.at || j.applied_at || ''), status: String(getStatus(j.id) || '') }))
    // A minute of clock skew between his machine and the mail server.
    .filter((x) => x.at && x.at <= t + 60e3 && t - x.at <= FILL_WINDOW_MS)
    .sort((a, b) => b.at - a.at);
  const ago = (x) => { const mins = Math.max(0, Math.round((t - x.at) / 60e3)); return mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`; };
  const cands = filled.filter((x) => BEFORE_APPLIED.has(x.status));
  if (cands.length) return { job: cands[0].j, why: `the application you filled ${ago(cands[0])} before this email` };
  // ALREADY MARKED APPLIED (2026-10-01). The page he submitted on often marks
  // the card itself, so by the time the receipt is read the card it confirms is
  // no longer "before applied" — WeRide's was marked the second the email came,
  // Neuralink's, Gotion's and Lab37's a minute before. Such a receipt moves
  // nothing; it is tied to that card so it stops reading as unsure. Tighter
  // than the three days above, because nothing is being decided: filled
  // within two hours of the email, and no other card filled within half an
  // hour of it.
  const done = filled.filter((x) => x.status !== 'rejected' && (STAGE[x.status] ?? 0) >= 4 && t - x.at <= SUBMIT_WINDOW_MS);
  if (done.length && (done.length === 1 || done[0].at - done[1].at > 30 * 60e3)) {
    return { job: done[0].j, why: `the application you sent ${ago(done[0])} before this email` };
  }
  return null;
}
const SUBMIT_WINDOW_MS = 2 * 3600e3;

/**
 * Receipts left unsure by an older matcher, decided again with pickByFill.
 * Oldest first, so the second of two same-day receipts finds the first card
 * already applied and takes the other one.
 */
export function resolveUnsure(store, { dbPath } = {}) {
  const h = db(dbPath);
  const rows = h.prepare("SELECT * FROM mail_events WHERE kind = 'received' AND job_id = '' AND unsure != '' ORDER BY sent_at ASC").all();
  if (!rows.length) return [];
  const jobs = store.jobs();
  store = carryStatus(store, jobs);
  const fix = h.prepare('UPDATE mail_events SET job_id = ?, from_status = ?, to_status = ?, unsure = ?, why = ?, pending = ? WHERE msg_id = ?');
  const moved = [];
  for (const e of rows) {
    const pick = pickByFill(e.unsure.split(','), jobs, e.sent_at, store.getStatus);
    if (!pick) continue;
    const from = store.getStatus(pick.job.id);
    const to = nextStatus(from, 'received');
    if (!to) { fix.run(String(pick.job.id), from || '', '', '', pick.why, e.pending, e.msg_id); continue; }
    // The row first, then the card (J5, see intendMove).
    intendMove(h, () => fix.run(String(pick.job.id), from || '', to, '', pick.why, MOVING, e.msg_id), e.msg_id, statusAtOf(store, pick.job.id));
    store.setStatus(pick.job.id, to, { changedAt: e.sent_at });
    moveDone(h, e.msg_id);
    moved.push({ jobId: pick.job.id, company: e.company, kind: 'received', from, to, subject: e.subject });
  }
  return moved;
}

/**
 * LinkedIn copies still on his list whose board card he has applied to (see
 * linkedInCopies). Pure: the pairs, nothing written.
 */
export function appliedCopies(jobs, getStatus = (id) => jobs.find((j) => j.id === id)?.status) {
  const out = [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const [copyId, keep] of linkedInCopies(jobs)) {
    const copyStatus = String(getStatus(copyId) || '');
    const keepStatus = String(getStatus(keep.id) || '');
    if (keepStatus === 'hidden' || (STAGE[keepStatus] ?? 0) < 4 || !BEFORE_APPLIED.has(copyStatus)) continue;
    out.push({ copy: byId.get(copyId), keep });
  }
  return out;
}

/**
 * …and each one pointed at its board card, off his list. Nothing is deleted.
 * THROUGH THE STORE'S WRITER (F-968, 2026-11-04): it opened its own handle and
 * wrote the pointer itself. The adapter's `pointAt` when it has one; else the
 * store's own, and only when `dbPath` is the store's file (never another).
 *
 * UNLOCKED ON PURPOSE (F-968 review follow-up, 2026-11-04). The store's
 * pointAt is a synchronous writer meant to run inside a caller's
 * withStoreLock; this one runs outside it, like every write the mail sync
 * makes (the dashboard's adapter sets statuses through setStatuses the same
 * way). Each pointer is one UPDATE — atomic on its own, waited out by
 * SQLite's busy timeout if a scan holds the write lock, and `onlyIfUnset`
 * never moves a pointer something else set. Nothing here spans two
 * statements, so there is no half-written state for a lock to prevent.
 */
export function foldAppliedCopies(store, { dbPath } = {}) {
  const pairs = appliedCopies(store.jobs(), store.getStatus);
  if (!pairs.length) return [];
  const point = store.pointAt || (isStoreFile(dbPath || storeDbPath()) ? (copy, keep) => storePointAt(copy, keep, { onlyIfUnset: true }) : null);
  if (!point) return [];
  return pairs.filter((p) => { try { return point(String(p.copy.id), String(p.keep.id)); } catch { return false; } })
    .map((p) => ({ copyId: p.copy.id, keepId: p.keep.id, company: p.keep.company, title: p.keep.title }));
}

// ── the event ledger ─────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS mail_events (
  msg_id      TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  sender      TEXT NOT NULL DEFAULT '',
  sent_at     TEXT,
  snippet     TEXT NOT NULL DEFAULT '',
  from_status TEXT NOT NULL DEFAULT '',
  to_status   TEXT NOT NULL DEFAULT '',
  unsure      TEXT NOT NULL DEFAULT '',
  why         TEXT NOT NULL DEFAULT '',
  seen_at     TEXT NOT NULL,
  undone_at   TEXT,
  pending     TEXT NOT NULL DEFAULT '',
  from_changed_at TEXT
);
CREATE INDEX IF NOT EXISTS mail_events_job ON mail_events(job_id, sent_at);
CREATE TABLE IF NOT EXISTS mail_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
`;
const SCHEMA_DONE = new Set();
// THE MAIL LEDGER WAITS A QUARTER SECOND FOR A LOCK, NOT THIRTY (F-1052).
// mail_events lives in the store's file, and the dashboard writes it on its
// only thread. With openDb's 30 s busy_timeout, a scan or the enricher holding
// the write lock froze every request for as long as it held it (17.1 s after
// the 2026-11-13 restart). syncMail waits for the lock with awaits first
// (writeLockFree); a statement that still meets one throws in 250 ms, the
// check ends as busy and the server tries again in 5 minutes. That is safe:
// a row is written, marked `moving`, before its card moves (J5).
export const MAIL_WAIT_MS = 250;
function db(dbPath = storeDbPath()) {
  const h = openDb(dbPath);
  h.exec(`PRAGMA busy_timeout = ${MAIL_WAIT_MS}`);
  if (!SCHEMA_DONE.has(dbPath)) {
    h.exec(DDL);
    // A ledger made before 2026-10-22 has no pending column (rematchPending).
    const cols = h.prepare('PRAGMA table_info(mail_events)').all().map((c) => c.name);
    if (!cols.includes('pending')) h.exec("ALTER TABLE mail_events ADD COLUMN pending TEXT NOT NULL DEFAULT ''");
    // …and none before 2026-11-13 holds the card's earlier status date (undoEvent).
    if (!cols.includes('from_changed_at')) h.exec('ALTER TABLE mail_events ADD COLUMN from_changed_at TEXT');
    SCHEMA_DONE.add(dbPath);
  }
  return h;
}

// THE CARD'S STATUS DATE BEFORE AN EMAIL MOVED IT (week review F2, 2026-11-13),
// read before the move and kept on the email's row, so an undo puts that date
// back instead of stamping the old status with today.
const statusAtOf = (store, id) => (typeof store?.statusAt === 'function' ? store.statusAt(String(id)) || null : null);
const noteFromAt = (h, msgId, at) => { if (at) h.prepare('UPDATE mail_events SET from_changed_at = ? WHERE msg_id = ?').run(String(at), String(msgId)); };

/*
 * THE ROW BEFORE THE MOVE (week-fixes J5, 2026-11-13). A card's move (the
 * store) and its email's row (mail_events) are two writes on two connections.
 * The card moved first, so a lock between the two left the card moved and no
 * row: the next check read the email again, found the card already there and
 * recorded "no move", and Undo had nothing to put back. Now the row goes in
 * first, with its from/to and `pending = 'moving'`, then the card, then the
 * mark comes off. A row still marked is settled by finishMoves at the start
 * of the next check.
 */
const MOVING = 'moving';
function intendMove(h, writeRow, msgId, fromAt) {
  h.exec('BEGIN IMMEDIATE');
  try { writeRow(); noteFromAt(h, msgId, fromAt); h.exec('COMMIT'); } catch (e) { try { h.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
}
const moveDone = (h, msgId) => h.prepare('UPDATE mail_events SET pending = \'\' WHERE msg_id = ? AND pending = ?').run(String(msgId), MOVING);

/**
 * Rows a stopped check left marked `moving`: the card already there is
 * reported as moved; one the email would still move there is moved now; one
 * he moved elsewhere himself stays, and the row is cleared to "moved nothing".
 * One he already undid (the move landed, the mark stayed, he pressed Undo)
 * only loses its mark: moving it again would take back his undo.
 */
export function finishMoves(store, { dbPath } = {}) {
  const h = db(dbPath);
  const rows = h.prepare("SELECT * FROM mail_events WHERE pending = ? AND job_id != '' ORDER BY sent_at ASC").all(MOVING);
  const moved = [];
  for (const e of rows) {
    if (e.undone_at) { moveDone(h, e.msg_id); continue; }
    const live = store.getStatus(e.job_id) || '';
    let landed = live === e.to_status;
    if (!landed && nextStatus(live, e.kind) === e.to_status) { store.setStatus(e.job_id, e.to_status, { changedAt: e.sent_at }); landed = true; }
    if (landed) moveDone(h, e.msg_id);
    else h.prepare("UPDATE mail_events SET pending = '', to_status = '' WHERE msg_id = ?").run(e.msg_id);
    if (landed) moved.push({ jobId: e.job_id, company: e.company, kind: e.kind, from: e.from_status, to: e.to_status, subject: e.subject });
  }
  return moved;
}

export function eventsFor(jobId, { dbPath } = {}) {
  return db(dbPath).prepare('SELECT * FROM mail_events WHERE job_id = ? ORDER BY sent_at DESC').all(String(jobId));
}
export function recentEvents({ dbPath, limit = 200 } = {}) {
  return db(dbPath).prepare("SELECT * FROM mail_events WHERE kind != '' ORDER BY sent_at DESC LIMIT ?").all(limit);
}
/** The newest classified email per job, for the board's cards. */
export function latestByJob({ dbPath } = {}) {
  const out = {};
  for (const e of db(dbPath).prepare("SELECT * FROM mail_events WHERE job_id != '' AND kind != '' ORDER BY sent_at ASC").all()) out[e.job_id] = e;
  return out;
}

/**
 * Take a batch of already-fetched messages and apply them. Pure of the network:
 * the Gmail fetch is `syncMail` below; this is the part the tests drive.
 *
 * @param messages  [{ id, fromName, fromEmail, subject, body, snippet, date }]
 * @param store     { jobs(): [...], setStatus(id, status), getStatus(id) }
 */
/**
 * AN EMAIL OLDER THAN THE POSTING IS ABOUT AN EARLIER APPLICATION (2026-10-22).
 * Every check reads the whole 120-day window (F-784), so a rejection from an
 * application he made months ago, at a company where he has one card today,
 * would be "the only application at this company" and reject it. That match
 * rests on the company alone, so it is refused when the scanner first saw the
 * card more than 30 days after the email was sent. Only that match: an email
 * that names the role or the requisition is about that posting even when the
 * card is newer — a board replaced by reboard.mjs re-creates its rows, and 5
 * of 293 placed emails (Tesla, Intuitive, J&J, AMAT) predate their card by
 * 1 to 35 days. The 30 days keep J&J's, whose card came 2 days after it.
 */
const ONLY_CARD_SLACK_MS = 30 * 86400e3;
function newerThan(job, date) {
  const t = Date.parse(date || ''); const s = Date.parse(job?.firstSeen || job?.first_seen || '');
  return Boolean(t && s && s > t + ONLY_CARD_SLACK_MS);
}

/**
 * ONE READ PER COMPANY PER CHECK, TAKEN WITH AWAITS (F-1052, the boot block).
 * The first check after every restart re-decides each unplaced email (the
 * rematch fingerprint lives in memory), and an email no card matches looks up
 * every posting at its company: 55 lookups for 73 emails on 2026-11-14, 16 of
 * them Amazon's 35,414 rows, all in one synchronous run. Measured on a copy of
 * his store, the rematch held the thread 14.7 s cold (the server's 14.2 s block
 * 2 s into its first check) and 4.7 s warm. Through this view a company is read
 * once per check, through the adapter's paged `loadCompany` when it has one,
 * and the server runs between the pages.
 */
const LOOKUPS = Symbol('company lookups');
class NeedCompany extends Error {
  constructor(company) { super(`not read yet: ${company}`); this.company = company; }
}
const coreOf = (co) => companyNames(co)[0] || '';
const pause = () => new Promise((resolve) => setImmediate(resolve));
export function companyLookups(store) {
  if (!store || typeof store.jobsAtCompany !== 'function' || store[LOOKUPS]) return store;
  const lk = { memo: new Map(), base: store };
  const view = Object.create(store);
  view[LOOKUPS] = lk;
  view.jobsAtCompany = (co) => {
    const k = coreOf(co);
    if (!k) return [];
    if (!lk.memo.has(k)) lk.memo.set(k, store.jobsAtCompany(co) || []);
    return lk.memo.get(k);
  };
  return view;
}
async function loadInto(lk, co) {
  const k = coreOf(co);
  if (!k || lk.memo.has(k)) return;
  if (typeof lk.base.loadCompany === 'function') lk.memo.set(k, (await lk.base.loadCompany(co)) || []);
  else { lk.memo.set(k, lk.base.jobsAtCompany(co) || []); await pause(); }
}
/** The number of companies this check has read (for the trace line). */
export const companiesRead = (store) => store?.[LOOKUPS]?.memo.size || 0;
/**
 * decide() with its company reads taken first, with awaits. decide only reads,
 * so a run stopped for a company not read yet is run again once it is. `step`
 * (optional) is told how long each synchronous run took.
 */
async function decideLoaded(m, kind, jobs, store, step = () => {}) {
  const lk = store?.[LOOKUPS];
  const timed = (s) => { const t = performance.now(); try { return decide(m, kind, jobs, s); } finally { step(performance.now() - t); } };
  if (!lk) return timed(store);
  const strict = Object.create(store);
  strict.jobsAtCompany = (co) => {
    const k = coreOf(co);
    if (!k) return [];
    if (!lk.memo.has(k)) throw new NeedCompany(co);
    return lk.memo.get(k);
  };
  for (let tries = 0; tries < 4; tries += 1) {
    try { return timed(strict); } catch (e) {
      if (!(e instanceof NeedCompany)) throw e;
      await loadInto(lk, e.company);
    }
  }
  return timed(store);
}
/** New emails' company reads, taken before the write section (see companyLookups). */
export async function readCompaniesFor(messages, store) {
  if (!messages?.length || !store?.[LOOKUPS]) return;
  const jobs = store.jobs();
  const view = carryStatus(store, jobs);
  for (const m of messages) {
    const kind = classifyMessage(m);
    if (kind) await decideLoaded(m, kind, jobs, view);
    await pause();
  }
}

/** What one classified email is about: { jobId, … } | { unsure, … } | null. */
function decide(m, kind, jobs, store) {
  let match = matchMessage(m, jobs);
  // A RECEIPT FROM A COMPANY WITH NO CARD ON HIS BOARD (F-1043). Cobot's
  // "Thank You For Applying" named "Mechanical Engineer, AI Data Collection",
  // a posting still `new` in the store, and matched nothing: the off-board
  // lookup only ran for an email already tied to a company. The company the
  // subject names is looked up the same strict way — the posting's id in the
  // email, or exactly one posting with the named role word for word.
  if (!match) {
    const co = emailCompany(m);
    if (!co || typeof store.jobsAtCompany !== 'function') return null;
    const core = companyNames(co)[0];
    return matchOffBoard(m, roleNamed(m), (store.jobsAtCompany(co) || []).filter((j) => sameCompany(j.company, core)));
  }
  if (match.jobId && match.why === 'the only application at this company' && newerThan(jobs.find((j) => j.id === match.jobId), m.date)) return null;
  if (match.unsure && 'named' in match && typeof store.jobsAtCompany === 'function') {
    const core = companyNames(match.company)[0];
    const found = matchOffBoard(m, match.named, (store.jobsAtCompany(match.company) || []).filter((j) => sameCompany(j.company, core)));
    if (found) match = found;
  }
  if (match.unsure) {
    const byText = reqInDescription(m, match.unsure, store);
    if (byText) match = { jobId: byText.id, company: match.company, why: `the requisition in the email (${byText.req}), stated in that posting's description` };
  }
  if (match.unsure && kind === 'received') {
    const byFill = pickByFill(match.unsure, jobs, m.date, store.getStatus);
    if (byFill) match = { jobId: byFill.job.id, company: match.company, why: byFill.why };
  }
  return match;
}

/**
 * THE REQUISITION IN THE POSTING'S OWN TEXT (F-1043). Micron's rejection names
 * JR100001; its two Dry Etch cards carry careers-site numbers in their links,
 * so the id matched neither — but the Manassas posting's description states
 * "JR100001". Exactly one of the cards the email could be about must hold it.
 */
function reqInDescription(m, ids, store) {
  if (typeof store.descriptionOf !== 'function' || !ids?.length || ids.length > 40) return null;
  const raw = `${m.subject || ''}\n${String(m.body || '').slice(0, 2500)}`;
  const stated = emailReqIds(raw);
  for (const n of String(m.subject || '').match(/\b\d{5,8}\b/g) || []) if (!/^(19|20)\d\d$/.test(n)) stated.add(n);
  if (!stated.size) return null;
  const hits = [];
  for (const id of ids) {
    const d = String(store.descriptionOf(id) || '');
    const req = [...stated].find((n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(d));
    if (req) hits.push({ id, req });
  }
  return hits.length === 1 ? hits[0] : null;
}

/** The employer a subject line names: "Thank you for applying to Samsung", "Thank You For Applying - Cobot". */
export function emailCompany(m) {
  const s = String(m?.subject || '').replace(/\s+/g, ' ').trim();
  const hit = s.match(/\b(?:(?:applying|application|applied|interest)\s+(?:to|with|at|in)|application was sent to)\s+(?!the\b|our\b|your\b|a\b|an\b)([A-Z][\w&.'’ -]{1,48}?)\s*(?:[!.,|:]|\s[-–]\s|$)/i)
    || s.match(/\bapplying\s*[-–:]\s*([A-Z][\w&.'’ -]{1,48}?)\s*$/i);
  const name = hit ? hit[1].trim() : '';
  if (!name || name.split(' ').length > 5 || !companyNames(name).length) return '';
  return name;
}

/**
 * HIS CARD BEHIND ITS REPOST (2026-11-12). Zipline's "Mechanical Test
 * Engineer, Avionics" was in his inbox; the posting closed on 10-03 and its
 * repost became the row that shows, so his card points at it (store.mjs
 * mayHide: a closed list card behind its repost stays hidden). The repost is
 * status new, and the mail reader asks only for his statuses and never for a
 * hidden row, so neither row was one of his applications and the 10-30
 * rejection naming that role was left unplaced. A card of his that points
 * elsewhere is read as the row it points at (that row's id, status and link;
 * his card's title and dates), so an email moves the row he can see, and
 * nothing that reads a link (linkedInCopies) meets the hidden row's.
 * `endOf(id)` is the visible end of the pointer, or null. A row already
 * among his cards is not doubled.
 *
 * The card keeps the further of the two statuses (first mate's review): a
 * rejected card stays rejected, so no later email can revive it through the
 * repost's "new", and a card at interview is not read back as "new". A pointer
 * to another company's row is never followed — a wrong one could mark the
 * wrong application.
 */
const furtherStatus = (a, b) => {
  if (a === 'rejected' || b === 'rejected') return 'rejected';
  return (RANK[b] ?? -1) > (RANK[a] ?? -1) ? b : a;
};
export function throughReposts(cards, endOf) {
  const out = new Map();
  for (const c of cards || []) if (!c.supersededBy) out.set(String(c.id), c);
  for (const c of cards || []) {
    if (!c.supersededBy) continue;
    const end = endOf(String(c.id));
    if (!end || String(end.id) === String(c.id) || out.has(String(end.id))) continue;
    if (!companyNames(c.company).some((n) => sameCompany(end.company, n))) continue;
    const { supersededBy, ...card } = c;
    out.set(String(end.id), { ...card, id: String(end.id), status: furtherStatus(card.status || 'new', end.status || 'new'), url: end.url || card.url, appliedAt: card.appliedAt || end.appliedAt || null, hiddenCard: String(c.id) });
  }
  return [...out.values()];
}

/**
 * The status an email moves FROM. For a card read through its repost
 * (throughReposts) that is the further of the repost row's live status and his
 * card's, so a rejected card behind a "new" repost is still rejected when a
 * later email asks (first mate's review, 2026-11-12). Every other id reads the
 * store as before.
 */
export function carryStatus(store, jobs) {
  const carried = new Map((jobs || []).filter((j) => j.hiddenCard).map((j) => [String(j.id), j.status || 'new']));
  if (!carried.size) return store;
  const out = Object.create(store);
  out.getStatus = (id) => {
    const live = store.getStatus(id);
    return carried.has(String(id)) ? furtherStatus(live || 'new', carried.get(String(id))) : live;
  };
  return out;
}

// What the matcher needs of an email it could not place, kept so a later
// check can place it without asking Gmail again (see rematchPending).
const pendingOf = (m, kind) => JSON.stringify({ kind, id: m.id, date: m.date || null, fromName: m.fromName || '', fromEmail: m.fromEmail || '', subject: m.subject || '', body: String(m.body || '').slice(0, 2500) });

/** An email that was never placed: no card, no pending copy, so it is read again. */
const UNPLACED = "job_id = '' AND pending = '' AND (why = 'no application matched' OR unsure != '')";

export function applyMessages(messages, store, { dbPath, now = new Date() } = {}) {
  const h = db(dbPath);
  // Read before and never placed: read again, and its row replaced (F-784).
  const seen = h.prepare(`SELECT 1 FROM mail_events WHERE msg_id = ? AND NOT (${UNPLACED})`);
  const put = h.prepare(`INSERT OR REPLACE INTO mail_events
    (msg_id, job_id, company, kind, subject, sender, sent_at, snippet, from_status, to_status, unsure, why, seen_at, pending)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // A check a lock stopped between a card and its row is settled first (J5).
  const moved = finishMoves(store, { dbPath }); const unsure = []; let read = 0;
  const jobs = store.jobs();
  store = carryStatus(store, jobs);
  // Oldest first, so the newest email is the one that decides.
  const ordered = [...messages].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const m of ordered) {
    if (seen.get(m.id)) continue;
    read += 1;
    const kind = classifyMessage(m);
    const match = kind ? decide(m, kind, jobs, store) : null;
    const sender = `${m.fromName || ''} <${m.fromEmail || ''}>`.trim();
    const snippet = String(m.snippet || m.body || '').replace(/\s+/g, ' ').slice(0, 280);
    if (!kind || !match) {
      // Remembered so it is not read again, but it is nobody's event. A job
      // email keeps what the matcher needs, so it can be placed later.
      put.run(m.id, '', '', '', '', '', m.date || null, '', '', '', '', kind ? 'no application matched' : 'not about an application', now.toISOString(), kind ? pendingOf(m, kind) : '');
      continue;
    }
    if (match.unsure) {
      put.run(m.id, '', match.company, kind, m.subject || '', sender, m.date || null, snippet, '', '', match.unsure.join(','), match.why, now.toISOString(), pendingOf(m, kind));
      unsure.push({ company: match.company, kind, subject: m.subject });
      continue;
    }
    const from = store.getStatus(match.jobId);
    const to = nextStatus(from, kind);
    const row = (pending) => put.run(m.id, match.jobId, match.company, kind, m.subject || '', sender, m.date || null, snippet, from || '', to || '', '', match.why, now.toISOString(), pending);
    if (!to) { row(''); continue; }
    // The row first, then the card (J5, see intendMove). The email's own
    // date, so the card shows when he applied or heard (F-1043).
    intendMove(h, () => row(MOVING), m.id, statusAtOf(store, match.jobId));
    store.setStatus(match.jobId, to, { changedAt: m.date });
    moveDone(h, m.id);
    moved.push({ jobId: match.jobId, company: match.company, kind, from, to, subject: m.subject });
  }
  return { read, moved, unsure };
}

/**
 * EMAILS NOT PLACED YET, ASKED AGAIN ON EVERY CHECK (2026-10-22).
 * An email recorded as "no application matched" or unsure used to stay that
 * way for good, so a card hearted after its receipt came, or a matcher fix
 * (F-785's "&" and Workday mailboxes), never reached it: F-785 needed 45 rows
 * re-matched by hand. Each such row keeps the matcher's inputs; this runs
 * them through the same decision as a new email, oldest first, with no Gmail
 * call. A row that is placed moves its card forward like any email.
 */
// ONLY WHEN SOMETHING CHANGED, ONLY INSIDE THE WINDOW (F-951). Every 30-minute
// check ran every unplaced email through the whole matcher against ~2,000
// cards on the server's only thread, and the list only grew: the F-860 freeze
// again, slowly. The same emails against the same cards and the same matcher
// give the same answer, so nothing runs unless the cards (id, company, title,
// status) or the matcher's own code changed. An email older than the window
// Gmail is asked for is retired from the list: its copy is dropped.
const REMATCHED = new Map();   // dbPath → fingerprint of the last pass
const MATCHER_SRC = () => [decide, matchMessage, matchOffBoard, pickByFill, nextStatus].map(String).join('\n');
function fingerprint(jobs) {
  const h = createHash('sha1');
  h.update(MATCHER_SRC());
  for (const j of [...jobs].sort((a, b) => String(a.id).localeCompare(String(b.id)))) h.update(`\n${j.id}|${j.company}|${j.title}|${j.status}`);
  return h.digest('hex');
}

// ASYNC SINCE 2026-11-14 (F-1052, the boot block): one email at a time, with
// an await between emails and between company reads (companyLookups), so the
// server answers requests while the first check after a boot re-decides every
// unplaced email. Each email's writes run as one synchronous step, through the
// adapter's `shortWaits` when it has one (a lock throws within 250 ms and the
// check ends busy, as in the write section). `stats` (optional) is filled with
// rows, companies read and the longest synchronous step, for the trace line.
export async function rematchPending(store, { dbPath, days = 120, now = new Date(), force = false, stats = {} } = {}) {
  const h = db(dbPath);
  const cutoff = new Date(+now - days * 86400e3).toISOString();
  // Read first: on most checks nothing has aged out, and a write that is not
  // needed is one more chance to wait on another process's lock (F-1052).
  const OLD = "job_id = '' AND pending != '' AND sent_at IS NOT NULL AND sent_at < ?";
  if (h.prepare(`SELECT 1 FROM mail_events WHERE ${OLD} LIMIT 1`).get(cutoff)) h.prepare(`UPDATE mail_events SET pending = '' WHERE ${OLD}`).run(cutoff);
  const rows = h.prepare("SELECT msg_id, pending FROM mail_events WHERE job_id = '' AND pending != '' ORDER BY sent_at ASC").all();
  stats.rows = rows.length; stats.ran = false; stats.longestMs = 0;
  if (!rows.length) return [];
  const jobs = store.jobs();
  store = carryStatus(companyLookups(store), jobs);
  const key = String(dbPath || storeDbPath());
  const fp = `${rows.length}:${fingerprint(jobs)}`;
  if (!force && REMATCHED.get(key) === fp) return [];
  stats.ran = true;
  const step = (ms) => { if (ms > stats.longestMs) stats.longestMs = ms; };
  const waits = typeof store.shortWaits === 'function' ? (fn) => store.shortWaits(fn) : (fn) => fn();
  const fix = h.prepare('UPDATE mail_events SET job_id = ?, company = ?, kind = ?, subject = ?, sender = ?, snippet = ?, from_status = ?, to_status = ?, unsure = ?, why = ?, pending = ? WHERE msg_id = ?');
  const moved = [];
  for (const r of rows) {
    await pause();
    let m; try { m = JSON.parse(r.pending); } catch { continue; }
    // An email whose decision throws is skipped, not the whole pass (review):
    // the fingerprint is set only after a pass finishes, so one bad email
    // would otherwise fail every check. A lock still ends the check busy.
    let match = null;
    try { match = m?.kind ? await decideLoaded(m, m.kind, jobs, store, step) : null; } catch (e) {
      if ([5, 6].includes((e?.errcode ?? 0) & 0xff) || /database is locked|SQLITE_BUSY/i.test(String(e?.message || e || ''))) throw e;
      stats.skipped = (stats.skipped || 0) + 1;
      continue;
    }
    if (!match || match.unsure) continue;
    const t = performance.now();
    waits(() => {
      const from = store.getStatus(match.jobId);
      const to = nextStatus(from, m.kind);
      const sender = `${m.fromName || ''} <${m.fromEmail || ''}>`.trim();
      const snippet = String(m.body || '').replace(/\s+/g, ' ').slice(0, 280);
      const row = (pending) => fix.run(String(match.jobId), match.company, m.kind, m.subject || '', sender, snippet, from || '', to || '', '', match.why, pending, r.msg_id);
      if (!to) { row(''); return; }
      // The row first, then the card (J5, see intendMove).
      intendMove(h, () => row(MOVING), r.msg_id, statusAtOf(store, match.jobId));
      store.setStatus(match.jobId, to, { changedAt: m.date });
      moveDone(h, r.msg_id);
      moved.push({ jobId: match.jobId, company: match.company, kind: m.kind, from, to, subject: m.subject });
    });
    step(performance.now() - t);
  }
  stats.companies = companiesRead(store);
  // Remembered once the pass has finished: a pass a lock stopped half-way is
  // run again whole on the next check, not skipped as already done.
  REMATCHED.set(key, fp);
  return moved;
}

/**
 * Put a card back where it was before an email moved it.
 *
 * ONLY WHILE THE CARD STILL HOLDS WHAT THE EMAIL SET (week review F2,
 * 2026-11-13). It restored from_status whatever the card said now, so an old
 * email's undo dragged a card he had since moved on by hand back to where the
 * email found it. A card that moved on is left alone, and the answer says so
 * (`stale`). And the earlier status date comes back with the status: the
 * date read before the move, or, on a row from before that was kept, the
 * date of the email that set the earlier status; today only when neither is known.
 */
export function undoEvent(msgId, store, { dbPath } = {}) {
  const h = db(dbPath);
  // HIS PRESS KEEPS THE USUAL WAIT (F-1052 review). The card goes back through
  // the store's 30 s wait; with the ledger's quarter second, a lock could let
  // the card move and stop the row's undone mark, and the next press would
  // call it stale with nothing left to settle it.
  h.exec('PRAGMA busy_timeout = 30000');
  const e = h.prepare('SELECT * FROM mail_events WHERE msg_id = ?').get(String(msgId));
  if (!e || !e.to_status || e.undone_at) return null;
  const now = store.getStatus(e.job_id) || '';
  if (now !== e.to_status) return { ...e, stale: true, now, why: `the card has moved on to "${now || 'no status'}" since this email, so it stays where it is` };
  if (e.from_status) {
    const before = e.from_changed_at || h.prepare(`SELECT sent_at FROM mail_events WHERE job_id = ? AND to_status = ? AND undone_at IS NULL
      AND msg_id != ? AND sent_at IS NOT NULL AND sent_at <= COALESCE(?, sent_at) ORDER BY sent_at DESC LIMIT 1`)
      .get(String(e.job_id), e.from_status, e.msg_id, e.sent_at)?.sent_at;
    store.setStatus(e.job_id, e.from_status, before ? { changedAt: before } : undefined);
  }
  h.prepare('UPDATE mail_events SET undone_at = ? WHERE msg_id = ?').run(new Date().toISOString(), e.msg_id);
  return { ...e, undone_at: new Date().toISOString() };
}

// ── Gmail: connection ────────────────────────────────────────────────

export function mailStatus({ dir } = {}) {
  const f = files(dir);
  const client = readJson(f.client);
  const token = readJson(f.token);
  const state = readJson(f.state) || {};
  return {
    configured: !!(client?.client_id && client?.client_secret),
    connected: !!token?.refresh_token,
    account: token?.account || '',
    lastSyncAt: state.lastSyncAt || null,
    lastResult: state.lastResult || null,
    lastError: state.lastError || '',
  };
}

export function saveClient({ client_id, client_secret }, { dir } = {}) {
  const id = String(client_id || '').trim(); const secret = String(client_secret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id) || secret.length < 10) throw new Error('that does not look like a Google OAuth client id and secret');
  writeJson(files(dir).client, { client_id: id, client_secret: secret });
}

const PENDING = new Map();   // state → redirect uri, for one sign-in at a time
export function authUrl(redirectUri, { dir } = {}) {
  const client = readJson(files(dir).client);
  if (!client?.client_id) throw new Error('add the Google client id and secret first');
  const state = randomBytes(16).toString('hex');
  PENDING.set(state, redirectUri);
  const q = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${AUTH_URL}?${q}`;
}

export async function finishAuth({ code, state }, { dir, fetchImpl = fetch } = {}) {
  const redirectUri = PENDING.get(String(state || ''));
  if (!redirectUri) throw new Error('that sign-in link is stale — press Connect Gmail again');
  PENDING.delete(state);
  const client = readJson(files(dir).client);
  const r = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const tok = await r.json();
  if (!r.ok || !tok.refresh_token) throw new Error(tok.error_description || tok.error || 'Google did not return a refresh token');
  if (!String(tok.scope || '').split(' ').includes(SCOPE)) throw new Error('read-only Gmail access was not granted');
  const profile = await (await fetchImpl(`${API}/profile`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json().catch(() => ({}));
  writeJson(files(dir).token, { refresh_token: tok.refresh_token, account: profile.emailAddress || '', at: new Date().toISOString() });
  return { account: profile.emailAddress || '' };
}

export function disconnect({ dir } = {}) {
  const f = files(dir);
  for (const p of [f.token, f.state]) { try { if (existsSync(p)) unlinkSync(p); } catch { /* already gone */ } }
}

async function accessToken({ dir, fetchImpl = fetch }) {
  const f = files(dir);
  const client = readJson(f.client); const token = readJson(f.token);
  if (!client || !token?.refresh_token) throw new Error('Gmail is not connected');
  const r = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  // invalid_grant SEVEN DAYS AFTER CONNECTING IS GOOGLE'S RULE, NOT A BUG
  // (2026-09-24: connected 09-17, refused 09-24). An OAuth app left in
  // "Testing" gets refresh tokens that expire after 7 days. Say so, and say
  // the one setting that stops it, instead of a bare "connect it again".
  if (!r.ok || !j.access_token) {
    if (j.error === 'invalid_grant') {
      throw new Error('Gmail refused the saved connection (invalid_grant). Google expires the connection every 7 days while your Google Cloud app is in "Testing" — '
        + 'connect it again, and to stop it recurring set Google Cloud → APIs & Services → OAuth consent screen → Publishing status to "In production".');
    }
    throw new Error(`Gmail refused the saved connection (${j.error || r.status}) — connect it again`);
  }
  return j.access_token;
}

// ── Gmail: reading ───────────────────────────────────────────────────

const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
function bodyOf(payload) {
  let plain = ''; let html = '';
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) plain += b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64(p.body.data);
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  const text = plain || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return text.replace(/\s+/g, ' ').trim().slice(0, 10000);
}
export function parseGmailMessage(m) {
  const header = (n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n)?.value || '';
  const from = header('from');
  const fm = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return {
    id: m.id,
    fromName: fm ? fm[1].trim() : '',
    fromEmail: (fm ? fm[2] : from).trim().toLowerCase(),
    subject: header('subject'),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(header('date') || Date.now()).toISOString(),
    snippet: m.snippet || '',
    body: bodyOf(m.payload),
  };
}

/**
 * A DROPPED CONNECTION IS RETRIED, NOT RECORDED AS THE DAY'S RESULT (F-717,
 * 2026-10-09). Node reports any network failure as a bare "fetch failed"; one
 * Wi-Fi blip or a machine waking from sleep cost every half-hourly sync from
 * 6 AM to 11 AM while Google itself was fine. A request that never got an
 * answer is tried twice more, a few seconds apart. Google's own refusals
 * (an HTTP status) are answers and are never retried here.
 *
 * The answer includes its BODY (F-725). A connection that drops after the
 * headers fails in `r.json()` with "terminated", not in fetch(); retrying
 * only the fetch let that one through to the half-hour wait. So the body is
 * read here, inside the retry, and handed back already read.
 */
export function withNetRetry(fetchImpl, { tries = 3, delays = [2000, 6000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return async (...args) => {
    for (let i = 0; ; i++) {
      try {
        const r = await fetchImpl(...args);
        const body = typeof r.text === 'function' ? await r.text() : typeof r.json === 'function' ? JSON.stringify(await r.json()) : '';
        return { ok: r.ok, status: r.status, headers: r.headers, text: async () => body, json: async () => JSON.parse(body) };
      } catch (e) {
        if (i >= tries - 1 || !isNetworkError(e)) throw e;
        await sleep(delays[Math.min(i, delays.length - 1)]);
      }
    }
  };
}

/**
 * A request that never got a whole answer: no connection ("fetch failed"),
 * one cut mid-body ("terminated"), a socket reset or a timeout. An HTTP
 * status, or a reply that is not JSON, is an answer and is not one of these.
 */
const NET_CODES = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_\w+)$/;
export function isNetworkError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (NET_CODES.test(String(e.code || e.cause?.code || ''))) return true;
  return e.name === 'TypeError' && /fetch failed|terminated|network|socket/i.test(String(e.message || ''));
}

/** "fetch failed" says nothing; its cause (ENOTFOUND, ECONNRESET, ETIMEDOUT…) does. */
export function netErrorText(e) {
  const msg = String(e?.message || e);
  const cause = e?.cause?.code || e?.cause?.message || '';
  if (isNetworkError(e)) return `could not reach Google${cause ? ` (${cause})` : msg && !/fetch failed/i.test(msg) ? ` (${msg})` : ''}: the network dropped; the next check retries`;
  return msg;
}

/**
 * Fetch what is new since the last sync (or the last `days`), apply it, and
 * record the result. Never throws: the failure is the result.
 */
const LOCKED_TEXT = 'the job store was busy with another Jarvis job (a scan or the enricher) past the wait; nothing was moved, and the check runs again in a few minutes';
export async function syncMail(store, { dir, dbPath, days = 120, fetchImpl: rawFetch = fetch, maxMessages = 400, retry = {}, lockWait = LOCK_FREE_BACKOFF_MS } = {}) {
  const f = files(dir);
  const state = readJson(f.state) || {};
  const started = new Date();
  const fetchImpl = withNetRetry(rawFetch, retry);
  // Each step's time, for the server's trace line (mailStepsLine).
  const steps = {}; const began = performance.now(); const since0 = () => performance.now() - began;
  try {
    const token = await accessToken({ dir, fetchImpl });
    const auth = { headers: { authorization: `Bearer ${token}` } };
    // The WHOLE window, every time (F-784). Searching only since the last sync
    // lost any email skipped once — a failed fetch, the 400 cap, mail Google
    // indexed late — for good: J&J's "not selected" and three Micron updates
    // sat unread for weeks. Listing ids is cheap; the ledger skips what was read.
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const h = db(dbPath);
    // LINKEDIN'S EASY APPLY RECEIPTS, READ AGAIN ONCE (F-1043). Until 2026-11-12
    // "your application was sent to Chism Automation" read as not about an
    // application, and such a row is never read again. Their ids are asked for
    // by name and those rows dropped, so this check reads them as new mail
    // (SEARCH finds them: their subject says "application"). mail_meta then
    // records that it ran, so no later check asks again.
    if (!h.prepare('SELECT 1 FROM mail_meta WHERE key = ?').get(EASY_APPLY_REREAD)) {
      try {
        const q = new URLSearchParams({ q: `${EASY_APPLY_SEARCH} after:${since}`, maxResults: '200' });
        const r = await fetchImpl(`${API}/messages?${q}`, auth);
        const j = await r.json();
        if (r.ok) {
          const drop = h.prepare("DELETE FROM mail_events WHERE msg_id = ? AND job_id = '' AND why = 'not about an application'");
          for (const m of j.messages || []) drop.run(String(m.id));
          h.prepare('INSERT OR REPLACE INTO mail_meta (key, value) VALUES (?, ?)').run(EASY_APPLY_REREAD, new Date().toISOString());
        }
      } catch { /* asked again on the next check */ }
    }
    const ids = []; let pageToken = '';
    do {
      const q = new URLSearchParams({ q: `${SEARCH} after:${since}`, maxResults: '500', ...(pageToken ? { pageToken } : {}) });
      const r = await fetchImpl(`${API}/messages?${q}`, auth);
      const j = await r.json();
      if (!r.ok) throw new Error(`Gmail search failed (${j.error?.message || r.status})`);
      for (const m of j.messages || []) ids.push(m.id);
      pageToken = j.nextPageToken || '';
    } while (pageToken && ids.length < 10000);

    // Known = read and placed, or kept for rematchPending. One read before the
    // pending copy existed, and never placed, is fetched once more.
    const known = h.prepare(`SELECT 1 FROM mail_events WHERE msg_id = ? AND NOT (${UNPLACED})`);
    // The cap is on NEW messages fetched; the rest wait for the next check.
    const unreadAll = ids.filter((id) => !known.get(id));
    const unread = unreadAll.slice(0, maxMessages);
    const messages = [];
    let quotaStop = false;
    for (const id of unread) {
      const r = await fetchImpl(`${API}/messages/${id}?format=full`, auth);
      if (r.status === 429 || r.status === 403) {
        let reason = ''; let text = '';
        try { const j = await r.json(); reason = String(j?.error?.errors?.[0]?.reason || j?.error?.status || ''); text = String(j?.error?.message || ''); } catch { /* no body */ }
        // Google's per-minute quota: every later fetch would be refused too.
        // Stop here; what is left is read on the next check (F-784).
        if (r.status === 429 || /rate|quota|limit/i.test(reason)) { quotaStop = true; break; }
        // Any other refusal (a lost scope, a policy block) is a failed check,
        // not a quiet one that reads nothing and reports success.
        throw new Error(`Gmail refused to open a message (${text || reason || r.status})`);
      }
      if (!r.ok) continue;
      messages.push(parseGmailMessage(await r.json()));
    }
    // THE WRITES, ONLY ONCE THE LOCK IS FREE (F-1052). Everything from here to
    // the folded copies is synchronous on the server's only thread. The wait
    // for another process's lock happens first, with awaits, so the server
    // keeps serving; inside, each write waits at most MAIL_WAIT_MS (the
    // ledger's connection, and the store's through `shortWaits`), and a lock
    // that comes back mid-way ends the check as busy, to be run again.
    steps.gmailMs = since0(); steps.fetched = messages.length;
    // The companies the new emails name, read with awaits before the writes
    // (companyLookups, F-1052 boot block). Only reads: nothing is decided here.
    const view = companyLookups(store);
    let t = performance.now();
    await readCompaniesFor(messages, view);
    steps.readMs = performance.now() - t;
    t = performance.now();
    if (!(await writeLockFree(h, lockWait))) throw Object.assign(new Error(LOCKED_TEXT), { errcode: 5 });
    steps.lockMs = performance.now() - t;
    const waits = typeof store.shortWaits === 'function' ? (fn) => store.shortWaits(fn) : (fn) => fn();
    t = performance.now();
    const result = waits(() => {
      const r = applyMessages(messages, view, { dbPath });
      r.moved.push(...resolveUnsure(view, { dbPath }));
      return r;
    });
    steps.writeMs = performance.now() - t;
    // The rematch runs one email at a time with awaits between (F-1052 boot
    // block); each email's writes still wait at most MAIL_WAIT_MS.
    t = performance.now();
    steps.rematch = {};
    result.moved.push(...await rematchPending(view, { dbPath, days, stats: steps.rematch }));
    steps.rematch.ms = performance.now() - t;
    t = performance.now();
    result.folded = waits(() => foldAppliedCopies(view, { dbPath }));
    steps.foldMs = performance.now() - t;
    // What is still to read: past the cap, or after a quota stop.
    result.waiting = unreadAll.length - messages.length;
    result.quotaStop = quotaStop;

    // LINKEDIN'S EMAILS, a separate search: they sit in Gmail's Social tab,
    // which the application search above leaves out on purpose. Accepted
    // invitations and InMail replies tie to the Outreach tab's people
    // (linkedin-activity.mjs). A failure here never costs the application sync.
    let linkedin = null;
    t = performance.now();
    try {
      const liSince = linkedInMailSince();
      const after = liSince ? Math.floor(Date.parse(liSince) / 1000) - 86400 : Math.floor(Date.now() / 1000) - 90 * 86400;
      const liIds = []; let lpt = '';
      do {
        const q = new URLSearchParams({ q: `${LINKEDIN_SEARCH} after:${after}`, maxResults: '100', ...(lpt ? { pageToken: lpt } : {}) });
        const r = await fetchImpl(`${API}/messages?${q}`, auth);
        const j = await r.json();
        if (!r.ok) throw new Error(`Gmail search failed (${j.error?.message || r.status})`);
        for (const m of j.messages || []) liIds.push(m.id);
        lpt = j.nextPageToken || '';
      } while (lpt && liIds.length < maxMessages);
      const liMessages = [];
      let seenMs = 0;
      for (const id of liIds.slice(0, maxMessages)) {
        const s = performance.now();
        const seen = isLinkedInMailSeen(id);
        seenMs += performance.now() - s;
        if (seen) continue;
        const r = await fetchImpl(`${API}/messages/${id}?format=full`, auth);
        if (r.ok) liMessages.push(parseGmailMessage(await r.json()));
      }
      const s = performance.now();
      linkedin = applyLinkedInEmails(liMessages);
      setLinkedInMailSince(started.toISOString());
      steps.linkedin = { emails: liIds.length, seenMs, applyMs: performance.now() - s };
    } catch (e) {
      linkedin = { error: String(e?.message || e) };
    }
    steps.linkedinMs = performance.now() - t;
    steps.totalMs = since0();

    const note = quotaStop ? `Gmail's rate limit stopped this check; ${result.waiting} email(s) wait for the next one` : '';
    writeJson(f.state, { lastSyncAt: started.toISOString(), lastResult: { read: result.read, moved: result.moved.length, unsure: result.unsure.length, waiting: result.waiting, linkedin: linkedin?.error ? 0 : (linkedin?.tied || 0) }, lastError: [note, linkedin?.error ? `LinkedIn emails: ${linkedin.error}` : ''].filter(Boolean).join('; ') });
    return { ok: true, ...result, linkedin, steps };
  } catch (e) {
    steps.totalMs = since0();
    const error = netErrorText(e);
    const network = isNetworkError(e);
    // A LOCKED STORE (week review F4, 2026-11-13): the card moves write outside
    // withStoreLock (mail_events is a second connection, so one transaction
    // around both would wait on itself), and a scan holding the write lock
    // past busy_timeout throws mid-loop. That is safe to run again: an email's
    // row is written, marked `moving`, before its card moves (J5, intendMove),
    // so a row that failed leaves the email to be read again, and a card whose
    // mark never came off is settled by finishMoves with its from/to intact.
    // So it is retried in minutes, like a network drop.
    const busy = [5, 6].includes((e?.errcode ?? 0) & 0xff) || /database is locked|SQLITE_BUSY/i.test(String(e?.message || e || ''));
    const said = busy ? LOCKED_TEXT : error;
    writeJson(f.state, { ...state, lastError: said, lastErrorAt: started.toISOString() });
    return { ok: false, error: said, network, busy, read: 0, moved: [], unsure: [], steps };
  }
}

/**
 * One line per check for the server's trace (F-1052 boot block): each step's
 * time, the rematch's rows and companies, and its longest synchronous step,
 * which is what can hold the server. The Gmail calls are awaits and hold nothing.
 */
export function mailStepsLine(r = {}) {
  const st = r.steps || {};
  const s = (ms) => `${((Number(ms) || 0) / 1000).toFixed(1)}s`;
  const rm = st.rematch || {};
  const parts = [`mail check ${r.ok ? 'ok' : `failed (${r.busy ? 'busy' : r.network ? 'network' : 'error'})`} in ${s(st.totalMs)}`];
  if ('gmailMs' in st) parts.push(`gmail ${s(st.gmailMs)} (${st.fetched || 0} new)`);
  if ('readMs' in st) parts.push(`company reads ${s(st.readMs)}`);
  if ('lockMs' in st) parts.push(`lock wait ${s(st.lockMs)}`);
  if ('writeMs' in st) parts.push(`write section ${s(st.writeMs)}`);
  if ('ms' in rm) {
    if (rm.ran) parts.push(`rematch ${rm.rows} emails, ${rm.companies || 0} companies read, ${s(rm.ms)} (longest step ${s(rm.longestMs)})${rm.skipped ? `, ${rm.skipped} skipped on an error` : ''}`);
    else parts.push(rm.rows ? `rematch skipped (${rm.rows} emails, nothing changed)` : 'rematch: nothing pending');
  }
  if ('foldMs' in st) parts.push(`fold ${s(st.foldMs)}`);
  if (st.linkedin) parts.push(`linkedin ${st.linkedin.emails} emails, ${s(st.linkedinMs)} (seen-check ${s(st.linkedin.seenMs)}, apply ${s(st.linkedin.applyMs)})`);
  else if ('linkedinMs' in st) parts.push(`linkedin ${s(st.linkedinMs)}`);
  return parts.join('; ');
}

// ── Verification codes (his consent, 2026-10-23) ─────────────────────
//
// "ENABLE VERIFICATION CODE EXTRACTION FROM EMAIL … I CONSENT, IT'S NOT THE
// SAME THING AS A PASSWORD." Oracle's email-only sign-in (TI, Oceaneering,
// onsemi, Ford) sends a six-digit code, the session dies after ~20 minutes,
// and the round trip through a person cost him four forms in one morning.
// The same read-only Gmail connection finds the code; the extension types it.

/** Mail that carries a sign-in code. Gmail search syntax. */
export const CODE_SEARCH = '("verification code" OR "one-time" OR "one time" OR passcode OR "security code" OR "your code" OR "access code" OR "confirmation code" OR "sign-in code" OR "login code" OR verify OR "confirm your identity" OR "this code" OR "the code") newer_than:1d';   // Ford: "Confirm your identity … using this code: …" (F-908)

const CODE_WORD_RE = /\b(?:verification|one[\s-]?time|security|access|confirmation|sign[\s-]?in|log[\s-]?in|authentication|pass)\s*(?:code|pin|passcode)\b|\bpasscode\b|\b(?:your|the|enter(?:\s+the)?)\s+code\b|\bcode\s*(?:is|:)/i;

/**
 * The code in one email, or null. A run of 4-8 digits close AFTER a phrase
 * that names a code, or just before "is your code". Years, phone numbers,
 * ZIP codes and requisition numbers away from such a phrase are never taken.
 */
export function extractCode({ subject = '', body = '' } = {}) {
  const text = `${subject} \n ${body}`.replace(/\s+/g, ' ');
  if (!CODE_WORD_RE.test(text)) return null;
  const isYear = (s) => /^(19|20)\d\d$/.test(s);
  // A number that is part of something longer (2026-12345, 4829-13, 1-800-…)
  // or names a job (job 12345, Req #4521) is never the code.
  const RUN_RE = /(?<![\w#-])(\d{4,8})(?![\w-]|[.,]\d)/g;
  const labelled = (w, i) => /\b(job|req|requisition|id|no|number|ref|reference|order|case|ticket)\W{0,3}$/i.test(w.slice(Math.max(0, i - 16), i));
  const phrase = new RegExp(`(?:${CODE_WORD_RE.source})[\\s\\S]{0,80}`, 'gi');
  for (const m of text.matchAll(phrase)) {
    const w = m[0];
    // "…code for job 12345 is 482913": the number right after "is" / ":" wins.
    const after = w.match(/(?:\bis\b|:)\s*(\d{4,8})(?![\w-]|[.,]\d)/i);
    if (after && !isYear(after[1])) return after[1];
    for (const d of w.matchAll(RUN_RE)) {
      if (isYear(d[1]) || labelled(w, d.index)) continue;
      return d[1];
    }
  }
  // "482913 is your code" / a code on its own line before the phrase.
  const before = text.match(/(?<![\w#-])(\d{4,8})(?![\w-]|[.,]\d)[^0-9]{0,40}?\b(?:is\s+your|is\s+the)\b[^.]{0,30}\bcode\b/i);
  if (before && !isYear(before[1])) return before[1];
  return null;
}

/** Which of these emails is from this employer's sign-in (by sender, subject or body). */
export function codeFor(messages, { company = '', since = 0, pageHost = '', taken = null } = {}) {
  const fresh = (Array.isArray(messages) ? messages : [])
    .filter((m) => Date.parse(m.date || 0) >= since - 30_000)
    .map((m) => ({ ...m, code: extractCode(m) }))
    // A code already given to ANOTHER form is never given again (F-920):
    // two Coherent forms in a row each asked within the look-back, and the
    // second typed the first one's spent code.
    .filter((m) => m.code && !(taken && taken.has(m.code)))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!fresh.length) return null;
  const host = String(pageHost || '').toLowerCase().replace(/^www\./, '');
  const theirs = (m) => {
    const fromEmail = String(m.fromEmail || '').toLowerCase();
    const [fromLocal, fromDomain] = fromEmail.split('@');
    // The same reading the inbox matcher uses ("&" as "and", the sender's
    // domain, a Workday tenant's mailbox — F-785)…
    if (company && companyAppears(company, { fromName: m.fromName, fromDomain, fromLocal, subject: m.subject })) return true;
    // …the sender's domain naming the company's first word: "Ford Motor" ←
    // RecruitingNoReply@ford.com (F-908). Four letters or more, so "GE" or
    // "The" never claims a code.
    const first = String(company || '').toLowerCase().match(/^[a-z0-9]+/)?.[0] || '';
    const label = String(fromDomain || '').split('.').slice(-2, -1)[0] || '';
    if (first.length >= 4 && label === first) return true;
    const body = String(m.body || '').slice(0, 4000).replace(/&/g, ' and ').toLowerCase();
    // …the company named in the body…
    const esc = (n) => String(n).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^a-z0-9]*');
    if (company && companyNames(company).some((n) => n.length >= 3
      && new RegExp(`(^|[^a-z0-9])${esc(n)}([^a-z0-9]|$)`).test(body))) return true;
    // …or the site he is signing in to, linked from the email (Oracle's
    // tenant host: ebfr.fa.us2.oraclecloud.com).
    return !!host && (body.includes(host) || fromDomain === host);
  };
  const mine = fresh.filter(theirs);
  if (mine.length) return mine[0];
  // Nothing ties a code to this employer: taken only when no employer was
  // named at all and it is the one code in the window. A known employer never
  // gets another employer's code.
  return !company && !host && fresh.length === 1 ? fresh[0] : null;
}

/** The newest sign-in code for this employer since `since` (ms), or null. */
export async function latestCode({ company = '', pageHost = '', since = Date.now() - 10 * 60_000, taken = null, dir, fetchImpl: rawFetch = fetch } = {}) {
  const fetchImpl = withNetRetry(rawFetch, { tries: 2, delays: [1000] });
  const token = await accessToken({ dir, fetchImpl });
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const q = new URLSearchParams({ q: CODE_SEARCH, maxResults: '10' });
  const r = await fetchImpl(`${API}/messages?${q}`, auth);
  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail search failed (${j.error?.message || r.status})`);
  const messages = [];
  for (const { id } of j.messages || []) {
    const m = await fetchImpl(`${API}/messages/${id}?format=full`, auth);
    if (!m.ok) continue;
    const parsed = parseGmailMessage(await m.json());
    if (Date.parse(parsed.date) < since - 30_000) break;   // newest first; the rest are older
    messages.push(parsed);
  }
  const hit = codeFor(messages, { company, since, pageHost, taken });
  return hit ? { code: hit.code, from: hit.fromName || hit.fromEmail, subject: hit.subject, at: hit.date } : null;
}
