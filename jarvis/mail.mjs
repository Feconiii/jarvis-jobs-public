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
import { randomBytes } from 'crypto';
import { openDb } from './db.mjs';
import { dbPath as storeDbPath, STORE_DIR } from './store.mjs';
import { LINKEDIN_SEARCH, applyLinkedInEmails, isLinkedInMailSeen, linkedInMailSince, setLinkedInMailSince } from './linkedin-activity.mjs';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Mail that could be about a job application. Gmail search syntax. */
export const SEARCH = '(application OR applying OR applied OR interview OR candidacy OR candidate OR position OR assessment OR recruiter OR "next steps" OR offer) -category:promotions -category:social';

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
  ['received', /\bthank(s| you) for (applying|your application|submitting your application)\b|\b(we('ve| have)?|has been) received your (job )?application\b|\byour recent job application for\b|\bapplication (has been )?(received|submitted)\b|\bapplication confirmation\b|\bsuccessfully (submitted|applied)\b|\bthank you for your interest in\b/],
];

const APPLICATION_CONTEXT = /\b(?:your (?:job )?application|(?:for|of) applying|you applied|applied (?:for|to)|application (?:for|to|update|status|received|confirmation)|your candidacy|your interest in (?:the|our|joining|working|a)\b|requisition|job id|hiring team|talent acquisition|recruiting team|recruitment team)\b/;
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
const TRAILING_GENERIC = /\s(robotics|ai|labs?|aviation|systems|energy|surgical|automation|motors|space|aerospace|bio|health|industries|solutions|international|global|usa|america)$/;
export function companyNames(name) {
  const core = companyCore(name);
  const out = core ? [core] : [];
  let short = core;
  while (TRAILING_GENERIC.test(short)) short = short.replace(TRAILING_GENERIC, '');
  if (short && short !== core && short.replace(/ /g, '').length >= 4) out.push(short);
  return out;
}

/** How long a name of this company matched in the sender or subject (0 = no match). */
function companyAppears(company, { fromName, fromDomain, subject }) {
  let best = 0;
  for (const name of companyNames(company)) {
    const re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[^a-z0-9]*')}([^a-z0-9]|$)`, 'i');
    // The sender's own domain: micron.com, sunday.ai — the name with its spaces
    // removed, as a whole label.
    const slug = name.replace(/ /g, '');
    const inDomain = slug.length >= 3 && String(fromDomain || '').toLowerCase().split('.').includes(slug);
    if (re.test(fromName) || re.test(subject) || inDomain) best = Math.max(best, name.length);
  }
  return best;
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
    [b, /\binterest in the ([^.!?]{3,140}?) (?:position|role)\b/i],
    [b, /\binterest in ([^.!?]{3,140}?) \(ID/i],
    [b, /\bfor the ([^.!?]{3,140}?) (?:position|role)\b/i],
    [s, /\|\s*([^|]{3,120}?)(?:\s+R\d{6,}\b.*|\s+at\s+.*)?$/i],
  ];
  for (const [text, re] of tries) {
    const m = text.match(re);
    if (m && m[1] && !/\b(?:your|our|this|a|an)\s*$/i.test(m[1])) return m[1].trim().replace(/\s*[-,(]+\s*$/, '');
  }
  return null;
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
  for (const m of t.matchAll(/\b(?:job\s*id|req(?:uisition)?(?:\s*(?:id|number|no\.?))?|id)\s*[:#]?\s*(?:[A-Z]{1,3}-?)?(\d{5,})\b/gi)) out.add(m[1]);
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
  const fromDomain = String(msg.fromEmail || '').split('@')[1] || '';
  const at = { fromName: String(msg.fromName || ''), fromDomain, subject: String(msg.subject || '') };
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
  // The longest name that matched wins: "Applied Intuition" is not "Applied Materials".
  const best = Math.max(...scoredCo.map((x) => x.len));
  const found = scoredCo.filter((x) => x.len === best).map((x) => x.j)
    // …and one company at a time: two employers cannot share one email.
    .filter((j, _, arr) => companyCore(j.company) === companyCore(arr[0].company));
  // LinkedIn's copy of a board card is that card, not another application.
  const copies = linkedInCopies(found);
  const atCompany = found.filter((j) => !copies.has(j.id));
  const company = atCompany[0].company;
  const named = roleNamed(msg);
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
      if (sameTitle.length && sameTitle.every((j) => urlIds(j).size)) {
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
  const fix = h.prepare('UPDATE mail_events SET job_id = ?, from_status = ?, to_status = ?, unsure = ?, why = ? WHERE msg_id = ?');
  const moved = [];
  for (const e of rows) {
    const pick = pickByFill(e.unsure.split(','), jobs, e.sent_at, store.getStatus);
    if (!pick) continue;
    const from = store.getStatus(pick.job.id);
    const to = nextStatus(from, 'received');
    if (to) store.setStatus(pick.job.id, to);
    fix.run(String(pick.job.id), from || '', to || '', '', pick.why, e.msg_id);
    if (to) moved.push({ jobId: pick.job.id, company: e.company, kind: 'received', from, to, subject: e.subject });
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

/** …and each one pointed at its board card, off his list. Nothing is deleted. */
export function foldAppliedCopies(store, { dbPath } = {}) {
  const pairs = appliedCopies(store.jobs(), store.getStatus);
  if (!pairs.length) return [];
  let mark;
  try { mark = db(dbPath).prepare('UPDATE jobs SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL'); } catch { return []; }
  return pairs.filter((p) => mark.run(String(p.keep.id), String(p.copy.id)).changes)
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
  undone_at   TEXT
);
CREATE INDEX IF NOT EXISTS mail_events_job ON mail_events(job_id, sent_at);
`;
const SCHEMA_DONE = new Set();
function db(dbPath = storeDbPath()) {
  const h = openDb(dbPath);
  if (!SCHEMA_DONE.has(dbPath)) { h.exec(DDL); SCHEMA_DONE.add(dbPath); }
  return h;
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
export function applyMessages(messages, store, { dbPath, now = new Date() } = {}) {
  const h = db(dbPath);
  const seen = h.prepare('SELECT 1 FROM mail_events WHERE msg_id = ?');
  const put = h.prepare(`INSERT OR IGNORE INTO mail_events
    (msg_id, job_id, company, kind, subject, sender, sent_at, snippet, from_status, to_status, unsure, why, seen_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const jobs = store.jobs();
  const moved = []; const unsure = []; let read = 0;
  // Oldest first, so the newest email is the one that decides.
  const ordered = [...messages].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const m of ordered) {
    if (seen.get(m.id)) continue;
    read += 1;
    const kind = classifyMessage(m);
    let match = kind ? matchMessage(m, jobs) : null;
    const sender = `${m.fromName || ''} <${m.fromEmail || ''}>`.trim();
    const snippet = String(m.snippet || m.body || '').replace(/\s+/g, ' ').slice(0, 280);
    if (!kind || !match) {
      // Remembered so it is not read again, but it is nobody's event.
      put.run(m.id, '', '', '', '', '', m.date || null, '', '', '', '', kind ? 'no application matched' : 'not about an application', now.toISOString());
      continue;
    }
    if (match.unsure && 'named' in match && typeof store.jobsAtCompany === 'function') {
      const found = matchOffBoard(m, match.named, store.jobsAtCompany(match.company));
      if (found) match = found;
    }
    if (match.unsure && kind === 'received') {
      const byFill = pickByFill(match.unsure, jobs, m.date, store.getStatus);
      if (byFill) match = { jobId: byFill.job.id, company: match.company, why: byFill.why };
    }
    if (match.unsure) {
      put.run(m.id, '', match.company, kind, m.subject || '', sender, m.date || null, snippet, '', '', match.unsure.join(','), match.why, now.toISOString());
      unsure.push({ company: match.company, kind, subject: m.subject });
      continue;
    }
    const from = store.getStatus(match.jobId);
    const to = nextStatus(from, kind);
    if (to) store.setStatus(match.jobId, to);
    put.run(m.id, match.jobId, match.company, kind, m.subject || '', sender, m.date || null, snippet, from || '', to || '', '', match.why, now.toISOString());
    if (to) moved.push({ jobId: match.jobId, company: match.company, kind, from, to, subject: m.subject });
  }
  return { read, moved, unsure };
}

/** Put a card back where it was before an email moved it. */
export function undoEvent(msgId, store, { dbPath } = {}) {
  const h = db(dbPath);
  const e = h.prepare('SELECT * FROM mail_events WHERE msg_id = ?').get(String(msgId));
  if (!e || !e.to_status || e.undone_at) return null;
  if (e.from_status) store.setStatus(e.job_id, e.from_status);
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
export async function syncMail(store, { dir, dbPath, days = 60, fetchImpl: rawFetch = fetch, maxMessages = 400, retry = {} } = {}) {
  const f = files(dir);
  const state = readJson(f.state) || {};
  const started = new Date();
  const fetchImpl = withNetRetry(rawFetch, retry);
  try {
    const token = await accessToken({ dir, fetchImpl });
    const auth = { headers: { authorization: `Bearer ${token}` } };
    // A day of overlap: Gmail's after: is by date, and the ledger drops repeats.
    const since = state.lastSyncAt ? Math.floor(new Date(state.lastSyncAt).getTime() / 1000) - 86400 : Math.floor(Date.now() / 1000) - days * 86400;
    const ids = []; let pageToken = '';
    do {
      const q = new URLSearchParams({ q: `${SEARCH} after:${since}`, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
      const r = await fetchImpl(`${API}/messages?${q}`, auth);
      const j = await r.json();
      if (!r.ok) throw new Error(`Gmail search failed (${j.error?.message || r.status})`);
      for (const m of j.messages || []) ids.push(m.id);
      pageToken = j.nextPageToken || '';
    } while (pageToken && ids.length < maxMessages);

    const h = db(dbPath);
    const known = h.prepare('SELECT 1 FROM mail_events WHERE msg_id = ?');
    const messages = [];
    for (const id of ids.slice(0, maxMessages)) {
      if (known.get(id)) continue;
      const r = await fetchImpl(`${API}/messages/${id}?format=full`, auth);
      if (!r.ok) continue;
      messages.push(parseGmailMessage(await r.json()));
    }
    const result = applyMessages(messages, store, { dbPath });
    result.moved.push(...resolveUnsure(store, { dbPath }));
    result.folded = foldAppliedCopies(store, { dbPath });

    // LINKEDIN'S EMAILS, a separate search: they sit in Gmail's Social tab,
    // which the application search above leaves out on purpose. Accepted
    // invitations and InMail replies tie to the Outreach tab's people
    // (linkedin-activity.mjs). A failure here never costs the application sync.
    let linkedin = null;
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
      for (const id of liIds.slice(0, maxMessages)) {
        if (isLinkedInMailSeen(id)) continue;
        const r = await fetchImpl(`${API}/messages/${id}?format=full`, auth);
        if (r.ok) liMessages.push(parseGmailMessage(await r.json()));
      }
      linkedin = applyLinkedInEmails(liMessages);
      setLinkedInMailSince(started.toISOString());
    } catch (e) {
      linkedin = { error: String(e?.message || e) };
    }

    writeJson(f.state, { lastSyncAt: started.toISOString(), lastResult: { read: result.read, moved: result.moved.length, unsure: result.unsure.length, linkedin: linkedin?.error ? 0 : (linkedin?.tied || 0) }, lastError: linkedin?.error ? `LinkedIn emails: ${linkedin.error}` : '' });
    return { ok: true, ...result, linkedin };
  } catch (e) {
    const error = netErrorText(e);
    const network = isNetworkError(e);
    writeJson(f.state, { ...state, lastError: error, lastErrorAt: started.toISOString() });
    return { ok: false, error, network, read: 0, moved: [], unsure: [] };
  }
}
