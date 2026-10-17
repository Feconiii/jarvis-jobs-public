/**
 * THE BASIC QUESTIONS, CHECKED A SECOND WAY (2026-09-24).
 *
 * Every wrong answer to a basic question this engine has sent had one shape:
 * a rule matched a phrase while the question asked something else, or the
 * matcher chose an option whose words meant the opposite of the answer.
 * Peak Energy's "Will you now or in the future require employer sponsorship"
 * went out "No" (F-572). KLA's Hispanic question got his race (F-555).
 *
 * Adding a rule per mistake fixes the mistake that was seen. This is the other
 * half: a short table of facts he has stated, and an independent reading of
 * the question and of the answer ACTUALLY chosen — its words, not the rule
 * that produced it. When the two disagree, the field is left for him with the
 * reason, never sent. A basic question can end up blank-with-a-flag; it cannot
 * end up silently wrong.
 *
 * Deliberately narrow. A topic is checked only when the question is short and
 * plainly that question, and only when the answer's polarity can be read. An
 * answer this cannot read is left alone — the checker only ever removes an
 * answer, it never writes one.
 */

import { PLACEHOLDER_OPTION_RE } from './_form.mjs';

const yes = (v) => /^\s*y(es)?\b/i.test(String(v ?? ''));
const no = (v) => /^\s*no?\b/i.test(String(v ?? ''));
const truthOf = (v) => (yes(v) ? true : no(v) ? false : null);

/**
 * Does this answer say yes or no? Reads statements as well as Yes/No:
 * "I will require sponsorship" is yes, "I do not require" is no.
 * null when it cannot tell ("Prefer not to say", "Decline", a paragraph).
 */
export function polarity(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 220) return null;
  if (/\b(decline|prefer\s+not|do\s+not\s+wish|don'?t\s+wish|choose\s+not|not\s+applicable|n\/a)\b/i.test(t)) return null;
  if (PLACEHOLDER_OPTION_RE.test(t)) return null;
  if (/^(yes|y|true)\b/i.test(t)) return true;
  if (/^(no|n|false)\b/i.test(t)) return false;
  // A statement with two clauses ("I am authorized to work … and will not
  // require sponsorship") answers two questions at once; it is not read.
  if (/\s(and|but)\s|;/i.test(t)) return null;
  if (/\b(not|n't|never|no\s+longer|without)\b/i.test(t)) return false;
  if (/^(i\s+(am|will|do|have|can|would|require|need|identify)|i'm|i've|i'll)\b/i.test(t)) return true;
  return null;
}

/**
 * The topics, each with the question it is and the truth from his profile.
 * `truth` is what a YES answer means for him: true → the answer must say yes.
 * Order matters: the first topic whose question matches decides.
 */
const TOPICS = [
  {
    key: 'authorized-without-sponsorship',
    // "Are you authorized to work in the US WITHOUT sponsorship?" — for him
    // that is No, whatever the plain authorization answer is.
    re: /\b(authori[sz]ed|eligible|able|legally\s+permitted)\b[^?]{0,80}\bwithout\b[^?]{0,40}\bsponsor/i,
    truth: (p) => {
      const auth = truthOf(p?.answers?.authorized_to_work_us);
      const needs = truthOf(p?.answers?.require_sponsorship);
      return auth == null || needs == null ? null : auth && !needs;
    },
  },
  {
    // AUTHORIZATION WITH A CONDITION A SPONSORED WORKER DOES NOT MEET:
    // "…without restrictions?", "unrestricted right to work", "…This does not
    // include practical training." On F-1 his only authorization is practical
    // training, so for him these are No — the answer rule says so, and the
    // plain `authorized` topic below read the No as a contradiction and left
    // Viavi's question for him (2026-09-26; he had sent Yes on 2026-09-24).
    key: 'authorized-unrestricted',
    re: /\bauthori[sz]ed\b[^?]{0,120}\bwithout\s+(any\s+)?restrictions?\b|\bunrestricted\s+(right|authori[sz]ation)\b|\bauthori[sz]ed\b[^.]{0,120}[.?]\s*(this|it)\s+does\s+not\s+include\s+(practical\s+training|opt|cpt)\b|\b(authori[sz]ed|eligible|able|permitted)\s+to\s+work\b[^?]{0,60}\bfor\s+any\s+(employer|company)\b/i,
    not: /\bsponsor/i,
    truth: (p) => {
      const auth = truthOf(p?.answers?.authorized_to_work_us);
      const needs = truthOf(p?.answers?.require_sponsorship);
      return auth == null || needs == null ? null : auth && !needs;
    },
  },
  {
    key: 'sponsorship',
    re: /\b(require|need|requiring)\b[^?]{0,60}\bsponsor|\bsponsorship\b[^?]{0,40}\b(require|need)|\bvisa\s+sponsorship\b/i,
    not: /\bwithout\b[^?]{0,40}\bsponsor|\bnot\s+(require|need)\b/i,
    truth: (p) => truthOf(p?.answers?.require_sponsorship),
  },
  {
    key: 'authorized',
    re: /\b(legally\s+)?(authori[sz]ed|eligible|permitted)\s+to\s+work\b/i,
    not: /sponsor|citizen|permanent|green\s+card|clearance/i,
    truth: (p) => truthOf(p?.answers?.authorized_to_work_us),
  },
  {
    key: 'age18',
    re: /\b(at\s+least|over|older\s+than|of)\s+(the\s+age\s+of\s+)?(18|eighteen)\b|\b(18|eighteen)\s+(years|yrs)(\s+of\s+age|\s+old|\s+or\s+older)/i,
    not: /under\s+(the\s+age\s+of\s+)?18|work\s+permit/i,
    truth: (p) => truthOf(p?.answers?.over_18),
  },
  {
    key: 'hispanic',
    re: /\b(are\s+you|do\s+you\s+identify\s+as)\b[^?]{0,20}\b(hispanic|latin[oax])/i,
    truth: (p) => truthOf(p?.eeo?.hispanic),
  },
  {
    key: 'protected-veteran',
    re: /\bare\s+you\s+a\s+(protected\s+)?veteran\b|\bprotected\s+veteran\b[^?]{0,40}\?/i,
    truth: (p) => (/\bnot\b|\bno\b/i.test(String(p?.eeo?.veteran ?? '')) ? false : null),
  },
];

/** Which basic question is this, and what must the answer say? null if none. */
export function basicTopic(label, profile) {
  const q = String(label ?? '').replace(/\s+/g, ' ').trim();
  // A legal paragraph that mentions sponsorship is not the sponsorship question.
  if (!q || q.length > 260) return null;
  for (const t of TOPICS) {
    if (!t.re.test(q)) continue;
    if (t.not && t.not.test(q)) continue;
    const truth = t.truth(profile);
    return truth == null ? null : { key: t.key, truth };
  }
  return null;
}

/**
 * Check one answer. `chosen` is the text that will actually go on the form —
 * the option's own words when there are options. Returns null when all is
 * well (or nothing can be told), else the reason it contradicts him.
 */
export function contradicts(label, chosen, profile) {
  const topic = basicTopic(label, profile);
  if (!topic) return null;
  const said = polarity(chosen);
  if (said == null || said === topic.truth) return null;
  return { topic: topic.key, said: String(chosen), want: topic.truth ? 'Yes' : 'No' };
}
