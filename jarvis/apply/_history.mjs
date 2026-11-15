/**
 * HIS HISTORY WITH THE EMPLOYER A FORM BELONGS TO (F-1036, 2026-11-07).
 *
 * Two questions every form asks are facts about him, not policy: "Have you
 * ever worked at <company>?" and "Have you applied to <company> before?".
 * The first is answered from his own work history (apply-profile's
 * work_experience, itself from cv.md), the second from the store's
 * applications, which the dashboard hands the planner as
 * `appliedHereBefore` / `appliedHereDates`. Nothing here is guessed.
 *
 * Its own file because both the label rules (_answers.mjs) and Workday's
 * key table (_workday-keys.mjs) need it, and _answers.mjs already imports
 * from the key table.
 */

// Short names an employer is written by on a form or in the store, to the
// name in his work history. He named this one (2026-11-07): "AMAT".
const ALIASES = { amat: 'applied materials' };

export function nameKey(s) {
  const k = String(s || '').toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|plc|gmbh|holdings|group|technologies|technology)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return ALIASES[k] || k;
}

/** 'Yes' when the employer of this form is one he has worked for, else null. */
export function employedAtApplyingTo(profile) {
  const who = nameKey(profile?.applyingTo);
  if (!who) return null;
  const mine = (Array.isArray(profile?.work_experience) ? profile.work_experience : [])
    .map((e) => nameKey(e?.company)).filter(Boolean);
  if (!mine.length) return null;
  // Either name containing the other: "Applied Materials" answers a posting at
  // "Applied Materials Inc". A short form name is matched only by ALIASES.
  const hit = mine.some((m) => m === who
    || (m.length >= 5 && who.startsWith(`${m} `))
    || (who.length >= 5 && m.startsWith(`${who} `)));
  return hit ? 'Yes' : null;
}

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20, 'twenty-four': 24, thirty: 30 };
const DAYS = { day: 1, week: 7, month: 30.44, year: 365.25 };

/**
 * The time window a question asks about, in days: "within the past 6 months",
 * "in the last year", "during the last two years". null when it names none.
 */
export function windowDays(text) {
  const m = String(text || '').match(/\b(?:within|in|during|over)\s+the\s+(?:past|last|previous|prior)\s+(?:(\d{1,3}|[a-z-]+)\s+)?(day|week|month|year)s?\b/i);
  if (!m) return null;
  const n = m[1] == null ? 1 : (/^\d+$/.test(m[1]) ? Number(m[1]) : NUM[m[1].toLowerCase()]);
  if (!n) return null;
  return n * DAYS[m[2].toLowerCase()];
}

/**
 * "Have you applied here before?" from the store.
 *   'Yes'      — he has applied to this employer (any posting), inside the
 *                question's window when it names one
 *   'No'       — the store holds none, or every one is dated before the window
 *   undefined  — a window was asked, and an application with no date might
 *                fall inside it: the box is his
 * `p.appliedHereBefore` is true/false from the store, null when the employer
 * is unknown (then the standing answer in his profile stands).
 */
export function appliedHere(p, text) {
  const standing = p?.answers?.previously_applied_here;
  if (p?.appliedHereBefore === false) return standing || 'No';
  if (p?.appliedHereBefore !== true) return standing;
  const days = windowDays(text);
  if (days == null) return 'Yes';
  const dates = Array.isArray(p.appliedHereDates) ? p.appliedHereDates : [];
  const now = Number.isFinite(p.now) ? p.now : Date.now();
  const cutoff = now - days * 86400e3;
  const times = dates.map((d) => (d ? Date.parse(d) : NaN));
  if (times.some((t) => Number.isFinite(t) && t >= cutoff)) return 'Yes';
  if (times.length && times.every((t) => Number.isFinite(t))) return 'No';
  return undefined;
}
