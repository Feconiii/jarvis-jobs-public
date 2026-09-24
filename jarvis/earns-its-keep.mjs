#!/usr/bin/env node
// jarvis/earns-its-keep.mjs — the objective bar for one tailored resume.
//
// His instruction, 2026-09-22: *"proceed until you find fixes that make a
// resume objectively perfect … everything on resume should earn its keep"*.
//
// "Perfect" cannot mean "the best resume that could exist for this job" — that
// would require experience he does not have, and a page that claimed it would
// be the fabrication this whole system exists to prevent. But it CAN mean
// something objective, checkable, and achievable, and this is the definition:
//
//   A resume is PERFECT for a posting when it covers everything the posting
//   names AND he can actually evidence.
//
// What else the page carries is REPORTED, not failed. The first version also
// failed a page for carrying "too much the posting never asked for"; he
// corrected that on 2026-09-23: "even after all bullets hit the jd great if we
// still have some space we should put the next relevant thing on there, so
// unrequested terms are not necessarily a bad thing".
// What it deliberately does NOT count against the page is a requirement he
// cannot prove — that is a gap in his experience, not a defect in the resume,
// and reporting it as a failure would push the writer toward bridging to it.
//
// Usage:
//   node jarvis/earns-its-keep.mjs --jd <file> --resume <file>
import { termsIn } from './jd-terms.mjs';
import { loadPool } from './resume-variants.mjs';

/**
 * Everything he could put on a page — the whole pool, in one string.
 *
 * This is what makes "evidenceable" a fact rather than an opinion: a posting
 * term is his to cover only when something in the pool already proves it.
 */
export function poolTerms(pool = loadPool()) {
  const parts = [];
  for (const org of Object.values(pool.orgs || {})) {
    for (const b of Object.values(org.bullets || {})) parts.push(b.text, b.short || '');
    parts.push(...(org.approvedTitles || []));
  }
  for (const p of Object.values(pool.projects || {})) parts.push(p.lead || '', p.text || '', p.short || '');
  for (const line of Object.values(pool.skills || {})) parts.push(line.lead || '', ...(line.items || []));
  parts.push(...(pool.education?.coursework || []));
  return termsIn(parts.filter(Boolean).join(' | '));
}

/**
 * Judge one finished page against one posting.
 *
 * `evidenceable` — named by the posting AND provable from the pool. Covering
 *   every one of these is the first half of the bar, and it is entirely within
 *   the engine's control: the material exists, it only has to be chosen.
 * `unprovable` — named by the posting and nowhere in the pool. Reported so he
 *   can see the real gap, never counted against the page.
 * `unasked` — on the page and nowhere in the posting. Reported for reading,
 *   never failed: once the posting is covered, the next most relevant thing is
 *   exactly what should fill the room (his call, 2026-09-23).
 */
export function judge(jdText, resumeText, { pool = null } = {}) {
  const jd = termsIn(jdText);
  const page = termsIn(resumeText);
  const have = poolTerms(pool || loadPool());

  const evidenceable = [...jd].filter((t) => have.has(t));
  const covered = evidenceable.filter((t) => page.has(t));
  const missed = evidenceable.filter((t) => !page.has(t));
  const unprovable = [...jd].filter((t) => !have.has(t));
  const unasked = [...page].filter((t) => !jd.has(t));

  const ratio = covered.length ? unasked.length / covered.length : Infinity;
  const checks = [
    {
      name: 'Covers everything this posting names that he can prove',
      ok: missed.length === 0,
      detail: missed.length ? `missed: ${missed.join(', ')}` : `${covered.length}/${evidenceable.length}`,
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    evidenceable: evidenceable.length,
    covered,
    missed,
    unprovable,
    unasked,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
  };
}

/** The lines for the tailoring report. Empty when the posting names nothing. */
export function keepReport(jdText, resumeText, opts = {}) {
  const r = judge(jdText, resumeText, opts);
  if (!r.evidenceable && !r.unprovable.length) return '';
  const out = [`  EARNS ITS KEEP: ${r.ok ? 'yes' : 'NO'}`];
  for (const c of r.checks) out.push(`    ${c.ok ? '[x]' : '[ ]'} ${c.name} — ${c.detail}`);
  if (r.unasked.length) out.push(`    also on the page, not named by the posting: ${r.unasked.length} terms (fine when they are the next most relevant thing)`);
  if (r.unprovable.length) {
    out.push(`    (not his to cover: ${r.unprovable.join(', ')} — nothing in cv.md proves these,`);
    out.push('     so they are a gap in his experience, not a defect in the page)');
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const { readFileSync } = await import('fs');
  const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
  const jd = arg('--jd'); const cv = arg('--resume');
  if (!jd || !cv) { console.log('usage: node jarvis/earns-its-keep.mjs --jd <file> --resume <file>'); process.exit(1); }
  const r = judge(readFileSync(jd, 'utf-8'), readFileSync(cv, 'utf-8'));
  console.log(`\n${keepReport(readFileSync(jd, 'utf-8'), readFileSync(cv, 'utf-8'))}\n`);
  process.exit(r.ok ? 0 : 1);
}
