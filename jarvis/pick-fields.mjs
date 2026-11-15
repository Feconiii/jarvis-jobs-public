// jarvis/pick-fields.mjs — the pay and the catch in a pick's note, as fields (2026-11-03).
//
// The reader writes its argument as prose: the catch sits somewhere in it
// ("…is the catch", "Catch: …", "…but the required list also asks for…") and
// so does the pay the posting states ("…Beverly MA, $80K-$85K."). On the
// dashboard pay showed on 29 of 64 cards and the catch on none, as a field.
// Read out of the note, so every past and future note gets them, with no
// change to what the reader writes. Pay goes through the store's own pay
// parser; a note that names no pay gives none.

import { parseSalaryFromText } from './salary-text.mjs';

// The curator's "Reach: <kind>." label opens a reach card's note (F-934, 2026-11-04). It is the
// label, not the catch: read it out first, then the "Worth a look:" that follows it.
const REACH_PREFIX = /^\s*Reach:\s*[^.]*\.\s*/i;
/** The reach label a note opens with, or null. */
export const reachFromNote = (note) => { const m = String(note || '').match(REACH_PREFIX); return m ? m[0].replace(/^\s*Reach:\s*/i, '').replace(/\.\s*$/, '') : null; };
/** A pick the reader filed as a reach, from a store row or a job object. */
export const isReachCard = (job) => !!reachFromNote(job?.pickNote ?? job?.pick_note ?? '');
/**
 * NO TAILORED RESUME FOR A REACH CARD UNLESS HE ASKS (his rule, 2026-11-04,
 * F-934 c). Opening its posting gets the family base; his Apply press, the
 * Fill press and any panel request tailor. The panel's line for the base:
 */
export const REACH_BASE_LINE = 'Reach card: base resume; press Build it again to tailor.';
/**
 * The resume a build should be for this request: `ask` is true for a press
 * or a panel request, false for a page that merely said which job it is.
 * An untailored base already held is replaced on any ask.
 */
export function resumeBuildFor(job, held, { ask }) {
  if (!ask) return held ? { use: held } : { start: { untailored: isReachCard(job) } };
  return held && !held.untailored ? { use: held } : { start: { untailored: false } };
}
const sentences = (t) => String(t || '').replace(REACH_PREFIX, '').replace(/^\s*Stretch:\s*[^.]*\.\s*/i, '').replace(/^\s*(?:Worth a look|Keep|Maybe)\s*:\s*/i, '')
  .split(/(?<=[.!?])\s+(?=[A-Z"“(])/).map((s) => s.trim()).filter(Boolean);

/** The sentence that states the catch, or null. */
export function catchFromNote(note) {
  const ss = sentences(note);
  const named = ss.find((s) => /\b(catch|caveat|watch out|the risk|downside)\b/i.test(s));
  if (named) return named.replace(/^catch\s*:\s*/i, '');
  const turn = ss.find((s) => /\b(but|however|although|though)\b/i.test(s) && /\b(not|no|never|requires?|asks? for|only|unclear|missing|travel|shift|years?)\b/i.test(s));
  return turn || null;
}

/** Pay the note states (the posting's, quoted by the reader), or null. */
export function payFromNote(note) {
  const p = parseSalaryFromText(String(note || ''));
  return p ? { min: p.min, max: p.max, currency: p.currency, interval: p.interval, fromNote: true } : null;
}

/** Both, for a card: pay only when the row has none of its own. */
export function pickFields(job) {
  if (!job?.pickNote) return {};
  const out = {};
  const c = catchFromNote(job.pickNote);
  if (c) out.pickCatch = c;
  if (!job.salary) { const p = payFromNote(job.pickNote); if (p) out.pickPay = p; }
  return out;
}
