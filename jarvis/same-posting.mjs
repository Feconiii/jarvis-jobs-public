// jarvis/same-posting.mjs — could two rows be one posting? The cheap guard
// (2026-11-04) that dedupe's copy links and copy-bodies' borrowed bodies both
// pass: the same employer, and the same title.
//
// THE TITLE RULE IS STRICT (first mate's review, 2026-11-04). "Mechanical
// Engineer" is not "Senior Mechanical Engineer", "Software Engineer I" is not
// "II", "Mechanical Design Engineer" is not "Mechanical Engineer", and a
// one-word "Engineer" matches nothing. Two titles are the same when their level
// words agree and their CORE titles (before " - ", ",", "(", "|", "–") carry the
// same meaningful words, at least two of them. A qualifier tail ("- Austin",
// "(New Grad 2027)", ", Pilot Manufacturing") is not compared. A board row
// retitled after a link was made passes only through its requisition id or its
// own URL still naming the copy's title (dedupe.linkable), never through here.
//
// What it forgives, each seen in the store's own copy links on 2026-11-04:
// a LinkedIn page's regional name ("Legrand, North & Central America"), a
// trailing generic word ("Luma" / "Luma AI"), and a misspelt word sharing a
// long stem ("Principle" / "Principal").

const LEGAL = /\b(?:inc|llc|ltd|corp|corporation|co|company|plc|gmbh|the|ai|labs|technologies|technology|usa|us|america)\b/g;

// Short names an employer goes by, to its key. He named this one (2026-11-07,
// F-1036): "AMAT = Applied Materials".
const KEY_ALIASES = { amat: 'appliedmaterials' };

/** The employer, before a LinkedIn regional comma, legal and generic tail words dropped. */
export function employerKey(x) {
  const s = String(x || '').replace(/,\s*(?=(?:inc|llc|ltd|corp|co|plc|gmbh)\b\.?\s*$)/i, ' ').split(',')[0];
  const k = s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, '');
  return KEY_ALIASES[k] || k;
}

export const sameEmployer = (a, b) => !!employerKey(a) && employerKey(a) === employerKey(b);

// Level words, normalised: "Sr." is senior, "Principle" (a common misspelling) is principal, "2" is ii.
const LEVEL = { senior: 'senior', sr: 'senior', staff: 'staff', principal: 'principal', principle: 'principal', lead: 'lead',
  associate: 'associate', junior: 'junior', jr: 'junior', i: 'i', ii: 'ii', iii: 'iii', iv: 'iv', '1': 'i', '2': 'ii', '3': 'iii', '4': 'iv' };
const STOP = new Set(['and', 'of', 'for', 'the', 'a', 'an', 'in', 'at', 'to', 'with', 'on', '&']);

const tokens = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
const levels = (t) => [...new Set(tokens(t).map((w) => LEVEL[w]).filter(Boolean))].sort().join(',');
const meaningful = (t) => [...new Set(tokens(t).filter((w) => !LEVEL[w] && !STOP.has(w) && w.length > 1))];
// "principle" and "principal" share "princip": a long common stem is one word.
const sameWord = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6) && Math.abs(a.length - b.length) <= 2);
const covers = (have, want) => want.every((w) => have.some((v) => sameWord(w, v)));

/** The title before its qualifier tail: "Manufacturing Engineer I - Austin" → "Manufacturing Engineer I". */
export const coreTitle = (t) => String(t || '').split(/\s[-–—|]\s|[,(|]/)[0].trim();

/** The same title: the same level words, and the same meaningful core words (two or more). */
export const similarTitle = (a, b) => {
  // The same words in the same order are the same title, however short or
  // comma-led ("Engineer, Manufacturing Automation", "R&D Engineer").
  const ta = tokens(a), tb = tokens(b);
  if (ta.length >= 2 && ta.join(' ') === tb.join(' ')) return true;
  if (levels(a) !== levels(b)) return false;
  let A = meaningful(coreTitle(a)), B = meaningful(coreTitle(b));
  // A title that leads with its level noun ("Engineer, Mechanical Design") has
  // a one-word core: then the whole titles are compared.
  if (A.length < 2 || B.length < 2) { A = meaningful(a); B = meaningful(b); }
  if (A.length < 2 || B.length < 2) return false;
  return covers(B, A) && covers(A, B);
};

// A path segment that is a page, not a title.
const GENERIC_SLUG = /^(?:apply(?:-now)?|job-?search|job-?details?|jobdetail|search|careers?|jobs?|view|details|external|en[-_]us)$/i;

/** The title a posting URL spells out (Workday, iCIMS, LinkedIn slugs), or ''. */
export function titleFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  const seg = u.pathname.split('/').filter(Boolean);
  const slug = [...seg].reverse().find((s) => /[a-z]{2,}-[a-z]{2,}/i.test(s) && !GENERIC_SLUG.test(s) && (s.match(/[a-z]{3,}/gi) || []).length >= 2) || '';
  return decodeURIComponent(slug).replace(/_[A-Z]*-?\d[\w-]*$/, '').replace(/-at-[\w-]+-\d+$/, '').replace(/[-_]+/g, ' ').trim();
}

/**
 * A board URL still names this title: every meaningful word of the title, at
 * least two, and its level words, are in the URL's slug (Hyve's retitled row:
 * "System-Thermal-Engineer---AI-and-Compute-Server-Development_R54176").
 */
export function urlNamesTitle(title, url) {
  const slug = titleFromUrl(url);
  if (!slug) return false;
  const want = meaningful(coreTitle(title));
  if (want.length < 2) return false;
  return levels(title) === levels(slug) && covers(tokens(slug), want);
}

// ── "Has he applied there?" (F-1013 #3, #6, #9, review 2026-11-05) ─────────
//
// Three checks asked it three ways, each by the EXACT company string, so
// "Micron" never met "Micron Technology": the warning on the panel
// (serve.mjs appliedBefore), the queue's skip (apply-queue.mjs) and the form
// answer "Have you applied here before?" (store.mjs appliedElsewhereAt, which
// also counted the engine's FILL times instead of applications). One rule now.

/** The statuses that mean he sent the application (mail moves cards forward from applied). */
export const APPLIED_STATUSES = ['applied', 'responded', 'interview', 'offer', 'rejected'];

/**
 * Every row at this employer he has applied to, by employerKey (legal and
 * generic words dropped), never by the exact string. `handle` is any
 * node:sqlite database with the jobs table. His applications number in the
 * hundreds, so they are read whole and compared here.
 */
export function appliedRowsAt(handle, company, exceptId = '') {
  if (!employerKey(company)) return [];
  const marks = APPLIED_STATUSES.map(() => '?').join(',');
  return handle.prepare(`SELECT id, company, title, url, status, applied_at, status_changed_at FROM jobs WHERE status IN (${marks}) AND id <> ?`)
    .all(...APPLIED_STATUSES, String(exceptId ?? ''))
    .filter((r) => sameEmployer(r.company, company));
}

// A tail that only says WHERE or WHEN: "- Boise, ID", "(Remote)", ", New Grad 2027".
const PLACE_TAIL = /^(?:remote|hybrid|on-?site|in[- ]office|usa?|united states|(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b.*|(?:new grad|university grad|early career|entry level)\b.*|(?:19|20)\d{2}\b.*|[a-z .'-]+,\s*[a-z]{2}\b.*|[a-z .'-]+,\s*(?:usa?|united states)\b.*|[a-z .'-]+\s+(?:ca|tx|wa|or|ny|ma|az|co|id|ut|nv|ct|nj|pa|il|mi|oh|ga|nc|va|fl|mn)\b)$/i;
const tailOf = (t) => String(t || '').slice(coreTitle(t).length).replace(/^[\s,(|–—-]+|[\s)]+$/g, '').trim();
const tailWords = (t) => tokens(t).join(' ');

/**
 * The same ROLE, stricter than similarTitle: the core titles are similar AND
 * any tail that is not just a place or a cohort is the same. "Mechanical
 * Engineer - Thermal" is not "Mechanical Engineer - Structures" (similarTitle
 * drops both tails); "Manufacturing Engineer I - Boise, ID" is
 * "Manufacturing Engineer I".
 */
export function sameRole(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (ta.length >= 1 && ta.join(' ') === tb.join(' ')) return true;
  if (!similarTitle(a, b)) return false;
  const ra = tailOf(a), rb = tailOf(b);
  const keepA = ra && !PLACE_TAIL.test(ra) ? tailWords(ra) : '';
  const keepB = rb && !PLACE_TAIL.test(rb) ? tailWords(rb) : '';
  return keepA === keepB;
}

/** Same employer, and the same title (or the other row's URL still names it). */
export const couldBeOnePosting = (a, b) => sameEmployer(a?.company, b?.company)
  && (similarTitle(a?.title, b?.title) || urlNamesTitle(a?.title, b?.url) || urlNamesTitle(b?.title, a?.url));
