// jarvis/field.mjs — what industry a posting actually belongs to.
//
// `profile.yml` lists target industries, and fit.mjs used to score them as a
// yes/no: any target industry matched → 10/10, otherwise 5/10. That is fine for
// deciding whether a job is *relevant* and useless for deciding what to show
// first, because it makes a wafer-fab equipment role and a humanoid-robotics
// role score identically.
//
// It does not matter in a store that is evenly spread across industries. This
// one is not: 383 tracked companies are overwhelmingly semiconductor, so the
// top of the deck was 31 GlobalFoundries reqs out of 100 and browsing it meant
// reading the same fab job over and over.
//
// So a posting gets classified into a field, and the fields he is actively
// hunting outrank the ones he merely qualifies for. The signal is deliberately
// weak — two points out of a hundred — because the ordering fix for employer
// monotony belongs in the deck, not in a thumb on the score. This exists so a
// robotics role can *break a tie* against a fab role, not so it can leapfrog a
// better-matched one.
//
// Matching is literal, word-boundary keywords. No model, no tokens, no network.
//
// The field lists moved to the preset so a second user can run Jarvis
// (presets/<preset>/screen.mjs); the notes below are about the hardware ones.

import { screen } from './targeting.mjs';

/**
 * Fields he is actively hunting — these score full marks.
 *
 * Space was here until 2026-08-22 and is deliberately gone. It is the most
 * export-controlled sector there is, and the postings never say so: all 35
 * space reqs in the deck stated nothing about ITAR or US-person status and
 * none were work-auth blocked. Boosting a field he legally cannot work in was
 * surfacing dead ends at the top of the deck. `preferences.md` now blocks the
 * space vocabulary outright; the classifier keeps the label so a space posting
 * is still recognisable when he goes looking under "All incl. blocked".
 */
export const PRIORITY_FIELDS = screen.priorityFields;

/**
 * Field definitions, most specific first. `weight` breaks ties when a posting
 * mentions several: a robot company that also says "semiconductor" once is
 * still a robotics job.
 */
const FIELDS = screen.fields;

const reCache = new Map();
/** Word-boundary match, so "fab" does not fire on "fabricate". */
function termRe(term) {
  let re = reCache.get(term);
  if (re) return re;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '\\b' : '';
  re = new RegExp(`${left}${esc}${right}`, 'i');
  reCache.set(term, re);
  return re;
}

/**
 * Classify one posting.
 *
 * @returns {{key:string, label:string, priority:boolean, matched:string[]}}
 *   key 'other' when nothing matches — an honest "not classified", not a guess.
 */
export function classifyField(job) {
  // The title is weighted by being counted twice: a posting titled "Robotics
  // Engineer" that mentions semiconductors in a company boilerplate paragraph
  // is a robotics job, and body-only frequency would call it a fab job.
  const title = String(job?.title || '');
  const hay = `${title} ${title} ${job?.team || ''} ${job?.company || ''} ${job?.description || ''}`;

  // What the ROLE is, separate from what the employer sells. NXP's "Entry Level
  // Field Applications Engineer – Emerging Markets" was badged 🤖 robotics
  // because a paragraph about NXP's end markets name-drops "next-generation
  // robotics" — the role is customer-facing semiconductor applications work.
  // A boost is a claim about the job, so it has to be earned by the title or by
  // the description meaning it more than once in passing.
  const role = `${title} ${job?.team || ''}`;

  let best = null;
  for (const f of FIELDS) {
    const matched = f.terms.filter(t => termRe(t).test(hay));
    if (!matched.length) continue;

    const isPriority = PRIORITY_FIELDS.includes(f.key);
    const inRole = f.terms.some(t => termRe(t).test(role));
    if (isPriority) {
      // One passing mention in the body, and nothing in the title, is a
      // company describing its markets — not evidence about this job.
      if (!inRole && matched.length < 2) continue;
    }

    // A priority field also forfeits its weight bonus when the title says
    // nothing. NXP's "Entry Level Field Applications Engineer" mentions both
    // robotics AND mechatronics — in the paragraph listing the markets NXP's
    // silicon serves — which cleared the two-mention bar and then beat
    // semiconductor on the tie-break. Without the bonus it has to win on
    // evidence alone, and a semiconductor applications role does.
    const weight = (isPriority && !inRole) ? f.weight - 2 : f.weight;
    // Score = how many distinct terms hit, tie-broken by the field's own
    // weight, so one passing mention loses to a field the posting is about.
    // `maxEvidence` saturates a field that is deliberately vague, so breadth
    // of weak matches cannot beat a specific recognition.
    const strength = Math.min(matched.length, f.maxEvidence ?? Infinity) + weight;
    if (!best || strength > best.strength) {
      // The LABEL and the BOOST are different claims, and conflating them is
      // what put a semiconductor applications role at the top of the deck
      // wearing a 🤖. "This posting talks about robotics" can be true while
      // "this is a robotics engineering job" is false. The label describes the
      // posting; the boost only applies when the ROLE itself is the field.
      const earned = isPriority && (inRole || matched.length >= 3);
      best = { key: f.key, label: f.label, matched: matched.slice(0, 4), strength, earned };
    }
  }

  if (!best) return { key: 'other', label: 'Other', priority: false, matched: [] };
  return {
    key: best.key,
    label: best.label,
    priority: !!best.earned,
    matched: best.matched,
  };
}

export const _internals = { FIELDS, termRe };
