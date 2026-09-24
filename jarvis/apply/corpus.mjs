// jarvis/apply/corpus.mjs — his own answers, accepted and rejected, as the
// specification for the open-ended writer.
//
// HIS UPLOAD, 2026-09-22: `Alex_Open_Ended_Application_Answer_Corpus.md`, 21
// questions with the answer he kept, 10 of them beside the exact Claude answer
// he threw away, and his commentary on why.
//
// WHY THIS FILE EXISTS. The writer's only sample of his voice was ONE cover
// letter — `sourcesFor()` picks the shortest of the eleven, for length rather
// than for fit — and it had no negative examples at all. So the prompt could
// say "write like this" about a letter while the question on screen was "what
// historical empire inspires you?", and nothing in it said what a bad answer
// looks like. His corpus is the missing half: the same writer, the same facts,
// one version he kept and one he rejected.
//
// Showing the REJECTED answer matters more than showing another good one. The
// failures he catalogued are not errors of fact — every rejected answer here is
// true, relevant and well-formed. They fail on judgment: the job description
// speaking through him, a personality question answered with a resume bullet,
// the hardest problem buried under an inventory of parts. A model cannot infer
// "don't do that" from good examples alone, because the bad answers look like
// the good ones from the inside.
//
// Nothing here is a template and nothing is copied. It is evidence of how he
// decides what to leave out.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = path.join(HERE, '..', '..', 'Alex_Open_Ended_Application_Answer_Corpus.md');

/**
 * Which kind of question each corpus entry is, by its own heading.
 *
 * Mapped to the writer's own `KINDS` vocabulary (essay.mjs) so an exemplar can
 * be chosen for the question actually on screen. Ordered: first match wins, and
 * the specific patterns come before the general ones.
 */
const ENTRY_KINDS = [
  ['cover-letter', /cover letter/i],
  ['excellence', /evidence of excellence/i],
  // The questions about HIM rather than about a project — matched before
  // `challenge`, which the word "hardest" would otherwise claim. These three
  // entries are the corpus's clearest teaching: his kept answers carry almost
  // no technical inventory and the rejected ones are project summaries.
  ['character', /hardest you worked|biggest professional failure|empire|inspires you/i],
  ['challenge', /hardest problem|debugg|reliable outside simulation/i],
  ['project', /technical project|most complex|something you.{0,3}ve built|proud of/i],
  ['why-company', /^why |why [a-z0-9]|motivates you|like to join/i],
  ['motivation', /motivat/i],
  ['strength', /experience|industry experience/i],
  ['other', /empire|inspires you/i],
];

function kindOf(title) {
  for (const [kind, re] of ENTRY_KINDS) if (re.test(title)) return kind;
  return 'other';
}

/**
 * Parse the corpus into entries.
 *
 * Deliberately tolerant: this is a file he edits by hand, and a heading he
 * words differently must never crash a build that is otherwise fine. An entry
 * with no accepted answer is dropped rather than half-used.
 */
export function loadCorpus({ corpusPath = CORPUS_PATH } = {}) {
  if (!existsSync(corpusPath)) return [];
  let text = '';
  try { text = readFileSync(corpusPath, 'utf-8'); } catch { return []; }

  const entries = [];
  // Numbered top-level sections: "# 8. Gradient Robotics - Tell us a technical…"
  const blocks = text.split(/\n(?=#\s+\d+\.\s)/).slice(1);
  for (const block of blocks) {
    const head = /^#\s+(\d+)\.\s+(.+)$/m.exec(block);
    if (!head) continue;
    const title = head[2].trim();
    // "Company - the question"
    const dash = title.indexOf(' - ');
    const company = dash > 0 ? title.slice(0, dash).trim() : '';
    const question = dash > 0 ? title.slice(dash + 3).trim() : title;

    const part = (re) => {
      const m = re.exec(block);
      return m ? m[1].replace(/\n{3,}/g, '\n\n').trim() : '';
    };
    const accepted = part(/##\s*Strong exemplar[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/);
    const rejectedOnly = part(/##\s*Rejected output[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/);
    // A SECTION THAT IS ONLY A REJECTED ANSWER. Two of his Tesla entries are
    // written that way — "Rejected Drive Unit Assembly Evidence of Excellence"
    // has no accepted half of its own, because the accepted half is the
    // separate entry two sections above it.
    //
    // Dropping them cost the most valuable examples in the file: `excellence`
    // is the kind he rejected most often, and without these it was the one kind
    // with no negative example at all. They are kept and attached below.
    if (!accepted) {
      if (rejectedOnly) {
        entries.push({
          n: Number(head[1]), company, question, kind: kindOf(title),
          fullQuestion: question, accepted: '', rejected: rejectedOnly,
          commentary: part(/##\s*Commentary[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/),
          words: 0, rejectedOnly: true,
        });
      }
      continue;
    }
    entries.push({
      n: Number(head[1]),
      company,
      question,
      kind: kindOf(title),
      // The full question when the file states one, else the heading.
      fullQuestion: part(/##\s*(?:Full question|Question(?:\s*\/\s*context)?)[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/) || question,
      accepted,
      rejected: rejectedOnly,
      commentary: part(/##\s*Commentary[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/),
      words: accepted.split(/\s+/).filter(Boolean).length,
    });
  }

  // ATTACH EACH ORPHAN REJECTION TO THE ANSWER IT IS THE FAILED VERSION OF.
  //
  // Matched on the same company plus the distinctive words of its own title
  // ("Drive Unit Assembly"), so the pair he actually wrote stays a pair. An
  // orphan matching nothing is KEPT as a standalone negative rather than
  // discarded: a rejected answer with no accepted twin still shows the writer
  // what he throws away, and `excellence` had no negative example without it.
  const orphans = entries.filter((e) => e.rejectedOnly);
  for (const o of orphans) {
    const words = o.question.toLowerCase().replace(/^rejected\s+/, '')
      .replace(/evidence of excellence/g, ' ')
      .split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const host = entries.find((e) => !e.rejectedOnly && !e.rejected
      && e.company === o.company
      && words.length && words.every((w) => e.question.toLowerCase().includes(w)));
    if (host) {
      host.rejected = o.rejected;
      if (!host.commentary) host.commentary = o.commentary;
      o.attached = true;
    }
  }
  return entries.filter((e) => !e.attached);
}

/** His own prose about what the rejected answers get wrong — section 22. */
export function loadObservations({ corpusPath = CORPUS_PATH } = {}) {
  if (!existsSync(corpusPath)) return '';
  let text = '';
  try { text = readFileSync(corpusPath, 'utf-8'); } catch { return ''; }
  const m = /#\s+\d+\.\s+Global observations[^\n]*\n([\s\S]*?)(?=\n#\s+\d+\.\s|\s*$)/.exec(text);
  if (!m) return '';
  // The headings are the lesson; his paragraphs under them are the argument.
  return m[1].replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Choose what to show the writer for THIS question.
 *
 * One accepted answer of the same kind, and — when the corpus has one — the
 * rejected answer for that same question, with his commentary. A matched pair
 * teaches more than two good answers: the reader can see the same facts
 * arranged two ways and only one of them kept.
 *
 * A pair is preferred over a lone accepted answer of the same kind, and an
 * answer of the same kind over a longer one of a different kind. When the kind
 * has nothing, the shortest pair in the corpus is used rather than nothing at
 * all — the failure modes are not kind-specific.
 */
export function pickExemplars(kind, { corpus = null, limit = 2, exclude = null } = {}) {
  // `exclude` is an entry number held out of the prompt — the measurement's
  // own question, whose kept answer would otherwise be handed to the writer.
  const all = (corpus || loadCorpus()).filter((e) => exclude == null || e.n !== exclude);
  if (!all.length) return [];
  const sameKind = all.filter((e) => e.kind === kind);
  const ranked = [
    ...sameKind.filter((e) => e.rejected),
    ...sameKind.filter((e) => !e.rejected),
    ...all.filter((e) => e.kind !== kind && e.rejected).sort((a, b) => a.words - b.words),
  ];
  const out = [];
  const seen = new Set();
  for (const e of ranked) {
    if (seen.has(e.n)) continue;
    seen.add(e.n);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The corpus section of the prompt.
 *
 * Budgeted, because the posting must stay the biggest thing in the prompt: an
 * exemplar that crowds out the job description produces a beautifully written
 * answer to the wrong question — which is the exact failure his commentary
 * describes.
 */
export function corpusBlock(kind, { corpus = null, limit = 2, maxChars = 6000, exclude = null } = {}) {
  const picks = pickExemplars(kind, { corpus, limit, exclude });
  if (!picks.length) return '';
  const lines = ['--- how he answers, in his own hand ---'];
  for (const e of picks) {
    lines.push(`\nQUESTION (${e.company || 'a company'}): ${e.fullQuestion.slice(0, 400)}`);
    lines.push(`\nHE KEPT THIS:\n${e.accepted}`);
    if (e.rejected) {
      lines.push(`\nHE REJECTED THIS — same facts, and he threw it away:\n${e.rejected}`);
      if (e.commentary) lines.push(`\nWHY HE REJECTED IT: ${e.commentary}`);
    }
  }
  lines.push('\n--- end ---');
  let block = lines.join('\n');
  if (block.length > maxChars) {
    // Drop whole trailing entries rather than truncating mid-answer: half an
    // exemplar teaches the wrong lesson about length.
    const single = corpusBlock(kind, { corpus, limit: 1, maxChars: Number.MAX_SAFE_INTEGER, exclude });
    block = single.length <= maxChars ? single : `${single.slice(0, maxChars)}\n--- end ---`;
  }
  return block;
}
