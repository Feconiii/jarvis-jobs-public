/**
 * THE BOARD'S OWN SPELLING OF HIS SCHOOL (P3, Simplify research 2026-11-06).
 *
 * A Greenhouse School box is a remote search over the board's own list of
 * schools, and that list has one spelling per school. A profile that says
 * "Univ. of Washington" types a search the list never answers the way he
 * means, while the list says "University of Washington". Greenhouse serves
 * the same list it searches as public JSON:
 *
 *   GET https://boards.greenhouse.io/v1/boards/<board>/education/schools?term=<t>&page=1
 *   → { items: [{ id, text }], meta: { total_count, per_page } }
 *
 * Checked by hand 2026-11-12: three live boards answered term=Stanford with
 * one item, "Stanford University"; an unknown board answers 404 with an error
 * body. /education/degrees answers the degree list, which is already on the
 * page as a static menu, so it is not asked.
 *
 * The board's spelling is used only when it is THE SAME SCHOOL by one of three
 * strict tests, each of which must pick out exactly one item. Shared words are
 * never enough: "University of Washington" and "Washington State University"
 * share every word that matters and are different schools. Nor is his name with
 * its tail cut off: "University of California, Berkeley" without ", Berkeley"
 * is the whole UC system, so a shorter board name is never the pick (review
 * 2026-11-12); the shorter name is only searched for (schoolTerms).
 *
 * The lookup runs on the server while a plan is made, capped at 1.5 s in all,
 * cached per board and school, and silent on any failure: without it the
 * plan is exactly what it was before.
 */

const CAP_MS = 1500;
const HIT_TTL_MS = 24 * 3600 * 1000;
const MISS_TTL_MS = 3600 * 1000;
const CACHE = new Map();

/** The board token a Greenhouse application page belongs to, or null. */
export function greenhouseBoardToken(pageUrl) {
  let u;
  try { u = new URL(String(pageUrl || '')); } catch { return null; }
  if (!/(^|\.)greenhouse\.io$/i.test(u.hostname)) return null;
  // An embed names its board in the query (serve.mjs boardPrefix, 2026-09-08).
  const forBoard = (u.searchParams.get('for') || '').trim();
  if (/^\/embed\//i.test(u.pathname)) return /^[a-z0-9][\w-]{0,79}$/i.test(forBoard) ? forBoard.toLowerCase() : null;
  const seg = u.pathname.split('/').filter(Boolean)[0] || '';
  if (!seg || /^(embed|v1|jobs|job_app)$/i.test(seg)) return null;
  return /^[a-z0-9][\w-]{0,79}$/i.test(seg) ? seg.toLowerCase() : null;
}

const GENERIC = new Set(['the', 'of', 'university', 'college', 'institute', 'school', 'state', 'and', 'at', 'in', 'for', 'technology']);

/** "Univ. of Washington" → "university of washington": punctuation, case, "&", a leading "the". */
export function schoolKey(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/\buniv\b\.?/g, 'university')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

/**
 * At most three search terms, most specific first: the name as he writes it,
 * its first distinctive word ("University of Washington" → "Washington";
 * a search for "University" answers every university), and the name without
 * a trailing campus or place ("Lakeside University, Springfield" → "Lakeside University").
 */
export function schoolTerms(school) {
  const full = String(school || '').replace(/\s+/g, ' ').trim();
  if (!full) return [];
  const out = [full];
  const bare = full.split(/\s+[-–(]|,/)[0].trim();
  if (bare && bare !== full) out.push(bare);
  const word = schoolKey(full).split(' ').find((w) => w.length >= 3 && !GENERIC.has(w));
  if (word && !out.some((t) => schoolKey(t) === word)) out.push(word);
  return out.slice(0, 3);
}

/**
 * The one item that is his school, by the first test that picks out exactly one:
 *   1. the same text, case and spacing aside;
 *   2. the same name once punctuation, "&", "Univ." and a leading "The" are set aside;
 *   3. the board's name is his followed by a campus ("Lakeside University - Springfield"),
 *      and only when `items` is the board's whole answer: a lone campus row on
 *      page 1 says nothing about an exact row on page 2 (`complete: false`).
 * Anything else is null: a near miss is a different school, and so is a board
 * name that is his with its campus or place cut off.
 */
export function matchSchool(school, items, { complete = true } = {}) {
  const texts = [...new Set((Array.isArray(items) ? items : []).map((i) => String(i?.text ?? i ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const want = String(school || '').replace(/\s+/g, ' ').trim();
  if (!want || !texts.length) return null;
  const k = schoolKey(want);
  if (!k) return null;
  // A campus follows a separator: " - ", ", ", " (", " at ".
  const campusAfter = (longer, shorter) => {
    const L = longer.toLowerCase();
    const s = shorter.toLowerCase();
    if (!L.startsWith(s) || L.length === s.length) return false;
    return /^(\s*[-–,(]|\s+at\s)/.test(L.slice(s.length));
  };
  const tiers = [
    (t) => t.toLowerCase() === want.toLowerCase(),
    (t) => schoolKey(t) === k,
    ...(complete ? [(t) => campusAfter(t, want)] : []),
  ];
  for (const test of tiers) {
    const hits = texts.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;   // two schools fit equally: not ours to choose
  }
  return null;
}

/**
 * The board's spelling of `school`, or null. `fetchImpl` is injected by tests;
 * nothing here throws.
 */
export async function boardSchoolSpelling(token, school, { fetchImpl = globalThis.fetch, capMs = CAP_MS, cache = CACHE, now = Date.now } = {}) {
  const t = String(token || '').toLowerCase();
  const want = String(school || '').trim();
  if (!t || !want || typeof fetchImpl !== 'function') return null;
  const key = `${t}|${want.toLowerCase()}`;
  const had = cache.get(key);
  if (had && now() - had.at < (had.value ? HIT_TTL_MS : MISS_TTL_MS)) return had.value;
  const until = now() + capMs;
  let value = null;
  let answered = false;
  for (const term of schoolTerms(want)) {
    const left = until - now();
    if (left <= 50) break;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), left) : null;
    try {
      const url = `https://boards.greenhouse.io/v1/boards/${encodeURIComponent(t)}/education/schools?term=${encodeURIComponent(term)}&page=1`;
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchImpl(url, { signal: ctl?.signal, headers: { accept: 'application/json' } });
      if (!res?.ok) { if (res?.status === 404) { answered = true; break; } continue; }
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json();
      answered = true;
      const items = Array.isArray(body?.items) ? body.items : [];
      const total = Number(body?.meta?.total_count);
      value = matchSchool(want, items, { complete: !(total > items.length) });
      if (value) break;
    } catch { /* timed out or unreachable: the plan stands without it */ } finally {
      if (timer) clearTimeout(timer);
    }
  }
  // Only an answer is remembered; a network failure is asked again next time.
  if (answered) cache.set(key, { value, at: now() });
  return value;
}

/** Does this form ask which school? Only then is the board asked. */
export function asksSchoolName(fields) {
  return (Array.isArray(fields) ? fields : []).some((f) => /^school--\d+$/.test(String(f?.id || ''))
    || /^\s*(school|university|institution)(\s*name)?\s*\*?\s*$/i.test(String(f?.label || '')));
}
