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
  ['rejection', /\brequisition has (?:now )?been (?:closed|cancell?ed)\b|\bposition (?:has been|is now|was) (?:closed|cancell?ed)\b|\bunfortunately\b|\bnot (to )?(be )?mov(e|ing) forward\b|\bdecided (not to|to not) (move|proceed)|\b(pursue|move forward with|proceed with) other candidates\b|\bother candidates\b.{0,80}\b(closely|better) (match|align)|\bno longer (being )?considered\b|\bposition (has been|was|is now) filled\b|\bnot been selected\b|\bwere not selected\b|\bregret to inform\b|\bdifferent direction\b|\bwill not be (moving|proceeding)\b|\bunable to proceed with your application\b|\bdo(?:es)? not (?:currently )?meet the (?:minimum )?(?:criteria|qualifications|requirements)\b/],
  ['interview', /\b(schedule|book|set up|arrange|find a time for)\b.{0,50}\b(interview|call|chat|conversation|phone screen|video call)\b|\binterview (invitation|request)\b|\binvite you to (an? )?(interview|call|phone screen)\b|\bavailability for (an? )?(interview|call|chat)\b|\bphone screen\b|\bnext (step|round) (is|will be) (an? )?(interview|call)\b/],
  ['assessment', /\b(online|technical|skills?) assessment\b|\bhackerrank\b|\bcodesignal\b|\bcodility\b|\bhirevue\b|\btake[- ]home\b|\bcomplete (the|a|this|your) (assessment|test|challenge|questionnaire)\b/],
  ['received', /\bthank(s| you) for (applying|your application|submitting your application)\b|\b(we('ve| have)|has been) received your application\b|\bapplication (has been )?(received|submitted)\b|\bapplication confirmation\b|\bsuccessfully (submitted|applied)\b|\bthank you for your interest in\b/],
];

const APPLICATION_CONTEXT = /\b(?:your (?:job )?application|(?:for|of) applying|you applied|applied (?:for|to)|application (?:for|to|update|status|received|confirmation)|your candidacy|your interest in (?:the|our|joining|working|a)\b|requisition|job id|hiring team|talent acquisition|recruiting team|recruitment team)\b/;
const STANDS_ALONE = {
  rejection: /\bnot (?:to )?(?:be )?mov(?:e|ing) forward\b|\b(?:pursue|move forward with|proceed with) other candidates\b|\bno longer (?:being )?considered\b|\bnot been selected\b|\bwere not selected\b|\brequisition has (?:now )?been (?:closed|cancell?ed)\b/,
  offer: /\boffer letter\b|\bformal offer\b|\bverbal offer\b|\boffer of employment\b|\bextend (?:you )?(?:an? )?(?:formal |verbal )?offer\b/,
};
const INVITES_HIM =/\b(?:we|i)(?:'d| would) (?:like|love) to (?:schedule|set up|book|arrange|invite|speak|chat|talk|meet)\b|\binvite you\b|\byour availability\b/;

/** @returns {'offer'|'rejection'|'interview'|'assessment'|'received'|null} */
export function classifyMessage({ subject = '', body = '' } = {}) {
  // NOTICES ABOUT THE CAREERS SITE ARE NOT ABOUT AN APPLICATION. Jabil's "Careers
  // Site Update" (sign-in options turned off) said "thank you for your interest"
  // and read as a receipt.
  if (/\b(?:site update|newsletter|webinar|sign[- ]?in option|reset your password|verify your email|talent community|job alert|jobs? (?:for you|you may like)|recommended jobs)\b/i.test(subject)) return null;
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
 * One card out of several equally good ones, or null. The same job saved twice
 * (Lam's Mechanical Engineer 2 under one req number; Sunday's board page and its
 * application page) is ONE application: the copy furthest along wins, then the
 * most specific link. Different titles are different jobs, and stay unsure.
 */
const STAGE = { new: 0, hidden: 0, inbox: 1, interested: 2, queued: 3, applied: 4, responded: 5, interview: 6, offer: 7, rejected: 4 };
function pickOne(jobs) {
  if (!jobs.length) return null;
  if (jobs.length === 1) return jobs[0];
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
  if (!scoredCo.length) return null;
  // The longest name that matched wins: "Applied Intuition" is not "Applied Materials".
  const best = Math.max(...scoredCo.map((x) => x.len));
  const atCompany = scoredCo.filter((x) => x.len === best).map((x) => x.j)
    // …and one company at a time: two employers cannot share one email.
    .filter((j, _, arr) => companyCore(j.company) === companyCore(arr[0].company));
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
  if (!r.ok || !j.access_token) throw new Error(`Gmail refused the saved connection (${j.error || r.status}) — connect it again`);
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
 * Fetch what is new since the last sync (or the last `days`), apply it, and
 * record the result. Never throws: the failure is the result.
 */
export async function syncMail(store, { dir, dbPath, days = 60, fetchImpl = fetch, maxMessages = 400 } = {}) {
  const f = files(dir);
  const state = readJson(f.state) || {};
  const started = new Date();
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
    writeJson(f.state, { lastSyncAt: started.toISOString(), lastResult: { read: result.read, moved: result.moved.length, unsure: result.unsure.length }, lastError: '' });
    return { ok: true, ...result };
  } catch (e) {
    writeJson(f.state, { ...state, lastError: String(e?.message || e), lastErrorAt: started.toISOString() });
    return { ok: false, error: String(e?.message || e), read: 0, moved: [], unsure: [] };
  }
}
