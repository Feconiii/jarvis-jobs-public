// jarvis/apply/_experience.mjs — pure data shaping for Workday's "My Experience"
// step. No Playwright, no DOM: everything here is a plain function over the
// apply-profile, so it can be unit-tested without a browser (the DOM driving
// lives in workday.mjs, which is only verifiable against a live tenant).
//
// Workday will not let an application past My Experience without at least one
// Work Experience OR Education entry, and it does NOT populate them from the
// uploaded resume. These builders turn the profile lists into flat
// {field: value} maps the adapter can pour into the nested "Add" sub-forms.

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Parse a human date from the profile into {month, year} (month is 1-12, or
 * null when only a year is given). Accepts "May 2026", "may 2026", "05/2026",
 * "2026-05", "2026". Returns null when nothing usable is present — the caller
 * flags the field for the user rather than guessing.
 */
export function parseMonthYear(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  // "2026-05" / "2026/5"
  let m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) return { month: clampMonth(+m[2]), year: +m[1] };

  // "05/2026" / "5-2026"
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) return { month: clampMonth(+m[1]), year: +m[2] };

  // "May 2026" / "Sept 2026"
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{4})$/);
  if (m) {
    const name = m[1].toLowerCase();
    const idx = MONTHS.findIndex((mo) => mo.startsWith(name.slice(0, 3)));
    if (idx !== -1) return { month: idx + 1, year: +m[2] };
    return null;
  }

  // Bare year
  m = s.match(/^(\d{4})$/);
  if (m) return { month: null, year: +m[1] };

  return null;
}

function clampMonth(n) {
  return n >= 1 && n <= 12 ? n : null;
}

/**
 * Is this role ongoing as of `now`?
 *
 * True when the entry says so explicitly, when it has no end date, or when the
 * recorded end date has not happened yet. The last case matters: Alex's Applied
 * Materials internship is recorded as ending August 2026, so while it is still
 * July 2026 the honest answer to "I currently work here" is yes — and it flips
 * to no on its own once that date passes, with no profile edit needed.
 */
export function isCurrent(entry, now = new Date()) {
  if (entry?.current === true) return true;
  if (entry?.current === false) return false;
  const end = parseMonthYear(entry?.end);
  if (!end) return true; // no end date recorded → ongoing
  // Compare at month granularity; a role ending "August 2026" is still current
  // throughout August 2026.
  const endKey = end.year * 12 + ((end.month ?? 12) - 1);
  const nowKey = now.getFullYear() * 12 + now.getMonth();
  return endKey >= nowKey;
}

/** Collapse the YAML folded-block whitespace into one clean paragraph. */
export function tidyDescription(raw, max = 2000) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Build the work-experience entries to enter, newest first.
 * Returns [] when the profile has no `work_experience` list — the adapter then
 * falls back to education alone, which also satisfies Workday.
 */
export function workEntries(profile, { now = new Date(), limit = 4 } = {}) {
  const list = Array.isArray(profile?.work_experience) ? profile.work_experience : [];
  return list
    .filter((e) => e && (e.title || e.company))
    .slice(0, limit)
    .map((e) => {
      const current = isCurrent(e, now);
      return {
        title: str(e.title),
        company: str(e.company),
        location: str(e.location),
        current,
        start: parseMonthYear(e.start),
        // Workday hides / ignores the end date once "I currently work here" is
        // checked, so don't carry one through for an ongoing role.
        end: current ? null : parseMonthYear(e.end),
        description: tidyDescription(e.description),
      };
    });
}

/** Build the education entries to enter. */
export function educationEntries(profile, { limit = 3 } = {}) {
  const list = Array.isArray(profile?.education_entries) ? profile.education_entries : [];
  if (list.length > 0) {
    return list
      .filter((e) => e && e.school)
      .slice(0, limit)
      .map((e) => ({
        school: str(e.school),
        degree: str(e.degree),
        fieldOfStudy: str(e.field_of_study),
        gpa: str(e.gpa),
        firstYear: yearOf(e.first_year),
        lastYear: yearOf(e.last_year),
        // The month too, when the profile states one ("Aug 2023", "May
        // 2027"): SmartRecruiters' education dates are month pickers
        // (F-358). A bare year stays a bare year — never a guessed month.
        firstMonth: monthOf(e.first_year),
        lastMonth: monthOf(e.last_year),
      }));
  }

  // Fall back to the flat `education:` block every profile already has, so a
  // profile written before education_entries existed still clears the step.
  const ed = profile?.education;
  if (!ed?.school) return [];
  return [{
    school: str(ed.school),
    degree: str(ed.degree),
    fieldOfStudy: str(ed.discipline),
    gpa: str(ed.gpa),
    firstYear: null,
    lastYear: yearOf(ed.graduation_year) ?? yearOf(ed.graduation),
    firstMonth: null,
    lastMonth: monthOf(ed.graduation_year) ?? monthOf(ed.graduation),
  }];
}

function str(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

function yearOf(v) {
  const parsed = parseMonthYear(v);
  return parsed ? parsed.year : null;
}

function monthOf(v) {
  const parsed = parseMonthYear(v);
  return parsed && parsed.month ? parsed.month : null;
}

/**
 * Does this profile carry enough to satisfy Workday's "at least one entry"
 * rule? Used to decide whether to flag the step for manual completion up front
 * instead of clicking Add into an empty sub-form the user then has to clean up.
 */
export function hasAnyExperience(profile, opts = {}) {
  return workEntries(profile, opts).length > 0 || educationEntries(profile).length > 0;
}

/**
 * THE SKILLS TO ENTER IN A FORM'S SKILLS TABLE, ranked for this posting.
 *
 * His answer when asked, 2026-09-20: "Top ~10, picked per posting" — the same
 * principle the resume already runs on. A fixed list ignores the job; all ~45
 * is padding a human can see through and forty table rows to click.
 *
 * NOTHING IS INVENTED. The pool is `answers.skills`, which his profile states
 * was drawn from cv.md, and this only reorders it. A skill the posting asks for
 * that he does not have never appears, because it was never in the pool.
 *
 * Ranking is plain text overlap, no model call: a skill named in the job
 * description outranks one that is not, longer and more specific names outrank
 * shorter ones ("Tolerance Analysis" over "Python" when both are mentioned),
 * and the profile's own order breaks the remaining ties. A word-boundary match
 * on both sides keeps "CAD" out of "cadence" and "3D printing" matching
 * "3-D printing".
 */
export function rankedSkills(profile, { jd = '', limit = 10 } = {}) {
  const raw = profile?.answers?.skills;
  const pool = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\n;]+/))
    .map((s) => String(s ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!pool.length) return [];

  const hay = String(jd || '').toLowerCase().replace(/[\u2010-\u2015]/g, '-');
  const mentions = (skill) => {
    if (!hay) return false;
    // "3-axis milling" should match "3 axis milling"; "GD&T" is literal.
    const pattern = skill.toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[\s-]+/g, '[\\s-]+');
    try { return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i').test(hay); } catch { return false; }
  };

  const seen = new Set();
  return pool
    .map((skill, i) => ({ skill, i, hit: mentions(skill) }))
    .filter(({ skill }) => {
      const k = skill.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (Number(b.hit) - Number(a.hit))
      || (b.hit && a.hit ? b.skill.length - a.skill.length : 0)
      || (a.i - b.i))
    .slice(0, Math.max(0, limit))
    .map(({ skill }) => skill);
}
