/**
 * THE READER'S REVIEW — a second look at every written answer, by someone who
 * did not write it.
 *
 * Alex, 2026-09-16, as a permanent quality check:
 *
 *   Before returning any application answer, ask:
 *   1. Could this answer have been written for 50 other applicants?
 *   2. Could this answer be sent to a different company with only the company
 *      name changed?
 *   3. Am I merely restating resume bullets?
 *   4. Did I explain why the evidence matters?
 *   5. Does the reader understand what Alex personally did?
 *   6. Is there a clear reason this evidence is relevant to this exact role?
 *   7. Did I use any unsupported detail?
 *   If the answer fails 1-6, rewrite it. If it fails 7, remove the unsupported
 *   claim.
 *
 * Those questions were already in the writer's prompt, and the Tesla
 * "Evidence of Excellence" answer passed them — because the writer was grading
 * its own work in the same breath it wrote it. A check the author runs on
 * itself is a check that passes. So the questions are asked again here, in a
 * separate call, of a reader who sees only the finished answer, his CV and the
 * posting, and whose verdict decides whether the answer is rewritten.
 *
 * Question 7 is also checked mechanically (essay.mjs `checkAnswer`); this adds
 * the kind of unsupported detail a regex cannot see — an implementation step,
 * a result or a responsibility that sounds plausible and is not in cv.md.
 */
import { CV_BUDGET } from '../cover-letter.mjs';

export const REVIEW_QUESTIONS = [
  [1, 'Could this answer have been written for fifty other applicants?', 'yes'],
  [2, 'Could it be sent to a different company with only the company name changed?', 'yes'],
  [3, 'Is it merely his resume bullets restated as sentences?', 'yes'],
  [4, 'Does it fail to explain why the evidence matters?', 'yes'],
  [5, 'Would a reader finish it unsure what Alex personally did?', 'yes'],
  [6, 'Is there no clear reason this evidence is relevant to this exact role?', 'yes'],
  [7, 'Does it use any detail cv.md does not support?', 'yes'],
];

export function buildReviewPrompt({ question, answer, job = null, jd = '', cvText = '', companyBrief = '' }) {
  return `You are the person at ${job?.company || 'the company'} reading applications for "${job?.title || 'this role'}". You did not write the answer below and you owe it nothing. Judge it hard: most answers you read are forgettable, and your job here is to say whether this one is.

THE QUESTION ON THE FORM:
"${String(question || '').replace(/"/g, "'").slice(0, 600)}"

THE ANSWER:
--- answer ---
${String(answer || '').trim()}
--- end of answer ---

THE POSTING
${String(jd || '(no description available)').slice(0, 9000)}
${companyBrief ? `\nWHAT IS KNOWN ABOUT THE COMPANY\n${companyBrief}\n` : ''}
THE APPLICANT'S CV — the only record of what he has done. Anything in the answer that is not here, or not a fair plain reading of it, is unsupported.
--- cv.md ---
${String(cvText || '').slice(0, CV_BUDGET)}
--- end of cv.md ---

Answer each question YES or NO. YES means the answer has the problem.
${REVIEW_QUESTIONS.map(([n, q]) => `${n}. ${q}`).join('\n')}

For question 7, an unsupported detail is not only a tool, number or result. It is also an ORDER of work ("before I cut a drawing"), a MOTIVE or a causal link ("so that…", "because I wanted…") that cv.md does not record. List each exact phrase.

Separately, list any sentence that reads written-for-effect rather than how an engineer states facts: a contrast knocking down something nobody claimed ("not X", "rather than a bench prototype"), a pointer back at the role glued onto the end ("…the work this role lists"), or a summing-up. These go in "voice".

Then say what would fix it, as instructions a writer can act on: which claim this reader needs to believe, which of his work proves it best, what to cut. Never suggest adding anything that is not in cv.md.

Reply with JSON only, no prose around it:
{"checks":[{"n":1,"fails":false,"why":"one line"},...all seven...],"unsupported":["exact phrase from the answer that cv.md does not support"],"voice":["exact phrase written for effect"],"fix":"instructions, or empty when nothing fails"}`;
}

/**
 * Read the reviewer's JSON. FAIL-OPEN: a reply that cannot be read is no
 * verdict, never a failed one — a broken review must not rewrite a good answer.
 */
export function parseReview(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j;
  try { j = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(j?.checks)) return null;
  const checks = j.checks
    .map((c) => ({ n: Number(c?.n), fails: c?.fails === true || /^(yes|true)$/i.test(String(c?.fails)), why: String(c?.why || '').slice(0, 300) }))
    .filter((c) => c.n >= 1 && c.n <= 7);
  const unsupported = (Array.isArray(j.unsupported) ? j.unsupported : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8);
  const failed = checks.filter((c) => c.fails && c.n <= 6);
  const voice = (Array.isArray(j.voice) ? j.voice : []).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8);
  return {
    checks,
    failed,
    unsupported,
    voice,
    fix: String(j.fix || '').slice(0, 1500),
    // 1-6 mean rewrite; 7 means remove. Either way the answer goes back.
    passes: failed.length === 0 && unsupported.length === 0 && voice.length === 0,
  };
}

/** What the writer is told when the review sends an answer back. */
export function reviewFeedback(review) {
  if (!review || review.passes) return '';
  const lines = ['A READER WHO DID NOT WRITE THIS ANSWER REVIEWED IT AND SENT IT BACK.'];
  if (review.failed.length) {
    lines.push('It failed these, so rewrite it — do not patch sentences:');
    for (const c of review.failed) {
      const q = (REVIEW_QUESTIONS.find(([n]) => n === c.n) || [])[1] || '';
      lines.push(`- ${c.n}. ${q} YES — ${c.why}`);
    }
  }
  if (review.unsupported.length) {
    lines.push('These are not supported by cv.md. Remove them; do not replace them with something else unsupported:');
    lines.push(...review.unsupported.map((u) => `- "${u.replace(/"/g, "'")}"`));
  }
  if (review.voice?.length) {
    lines.push('These read as written for effect. State the fact plainly or cut them:');
    lines.push(...review.voice.map((v) => `- "${v.replace(/"/g, "'")}"`));
  }
  if (review.fix) lines.push(`What the reader says would fix it: ${review.fix}`);
  return lines.join('\n');
}

/** Run the review. Never throws; null means no verdict. */
export async function reviewAnswer(input, { ask, timeoutMs = 120_000, bin = 'claude' } = {}) {
  try {
    return parseReview(await ask(buildReviewPrompt(input), { timeoutMs, bin }));
  } catch {
    return null;
  }
}
