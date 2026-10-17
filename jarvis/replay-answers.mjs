#!/usr/bin/env node
// jarvis/replay-answers.mjs — every answer he actually sent, asked again of
// today's planner.
//
// WHY (2026-09-24). "How can we make it so it doesn't leave stuff empty or get
// basic questions wrong — something more robust." Fixing the mistake in front
// of us is one rule at a time, and a rule added for one form can quietly break
// another. His own submissions are the ground truth nothing else is: the
// answer-log's `final` rows hold every field as it went out, beside what the
// engine planned. This replays each of them through the planner as it stands
// NOW and says, per question, whether it would send what he sent.
//
// It is a ratchet. The number only means something if it never goes down: run
// it before and after a planner change. A KEPT answer that now differs is a
// regression; a CHANGED one that now matches is a fix that held.
//
// What is left out, on purpose: uploads, written answers (the writer's job,
// not a rule's), and anything longer than a sentence.
//
// Usage:
//   node jarvis/replay-answers.mjs              summary + every question that does not match
//   node jarvis/replay-answers.mjs --json       the same, as JSON
//   node jarvis/replay-answers.mjs --all        also list the ones that match

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { planForm, loadApplyProfile } from './apply-plan.mjs';
import { chooseOption } from './apply/_form.mjs';
import { ANSWER_LOG } from './answer-log.mjs';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The rows worth replaying: what he sent, once per question and answer. */
export function corpus(file = ANSWER_LOG) {
  const lines = [];
  for (const f of [file.replace(/\.jsonl$/, '.1.jsonl'), file]) {
    if (existsSync(f)) lines.push(...readFileSync(f, 'utf-8').split('\n').filter(Boolean));
  }
  const seen = new Map();
  // TWO FIELDS, ONE LABEL, ONE SNAPSHOT (F-609): Workday's Legal Name and
  // Preferred Name both read "First Name". Only the Workday key tells them
  // apart; a row without one cannot be replayed as either, so it is marked.
  const parsed = [];
  const perSnap = new Map();
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.kind !== 'final' || !r.label) continue;
    const s = `${r.at}|${r.host}|${norm(r.label)}`;
    r._nth = perSnap.get(s) || 0;
    perSnap.set(s, r._nth + 1);
    parsed.push(r);
  }
  // HIS OWN EARLIER ANSWER, BORROWED. A plan with no rule behind it that
  // equals what he typed himself before is the dashboard reusing his answer
  // (reuse.mjs); the rules alone cannot reproduce it, and that is not a
  // regression (Intel's "If hired, do you intend to…", 2026-09-26).
  const his = new Map();
  for (const r of parsed) {
    r._shared = !r.key && perSnap.get(`${r.at}|${r.host}|${norm(r.label)}`) > 1;
    const own = his.get(norm(r.label));
    // …and a site that saves answers puts his own pick back on the next
    // application there: Micron's "When would you be available" was his on
    // 2026-09-25 and "already there" on 09-27, a rule or not.
    // Judged first; borrowed only where today's rules would not send it.
    r._borrowed = r.status === 'kept' && !r.rule && !!own && own.has(norm(r.answer));
    r._hisBefore = r.status === 'already there' && !!own && own.has(norm(r.answer));
    if (['you answered', 'changed'].includes(r.status) && String(r.answer ?? '').trim()) {
      (own || his.set(norm(r.label), new Set()).get(norm(r.label))).add(norm(r.answer));
    }
    if (!['kept', 'changed', 'cleared', 'you answered', 'already there'].includes(r.status)) continue;
    const sent = String(r.answer ?? '').trim();
    if (/file\(s\) attached/i.test(sent) || sent.length > 150 || r.engineAction === 'essay') continue;
    if (/^(upload|file)$/i.test(String(r.type || ''))) continue;
    // Not judgeable from one row: a split date's parts (the log has no part
    // name), and the rows of an employment or education entry (planned as an
    // entry, not as a question).
    if (/^\d{1,4}$/.test(sent) && /date/i.test(String(r.label))) continue;
    if (!sent && /^date$/i.test(String(r.label).trim())) continue;
    if (/^(title|company|from|to|description|office location|i currently (work|attend)[a-z ]*|school|school location|degree|field of study|major|city|country code|date completed|gpa)$/i.test(String(r.label).trim())) continue;
    // A menu whose options the log cut short cannot be replayed faithfully.
    if (Array.isArray(r.options) && r.options.length >= 25) continue;
    // HIS LAST WORD on each question at each employer: an answer he changed
    // two minutes later (Peak Energy's sponsorship, No then Yes) is not his.
    const key = `${norm(r.label)}|${norm(r.company || r.host)}|${norm(r.options?.[0] || '')}|${r.key || (r._shared ? `#${r._nth}` : '')}`;
    seen.delete(key);
    seen.set(key, r);
  }
  return [...seen.values()];
}

/** Would today's planner send what he sent? */
export function judge(row, profile) {
  const sent = String(row.answer ?? '').trim();
  const options = Array.isArray(row.options) ? row.options.map(String) : [];
  const type = String(row.type || 'text');
  const field = { label: row.label, type, options, required: true, ...(row.key ? { key: row.key } : {}) };
  let a;
  try { a = planForm([field], profile, { company: row.company || null }).actions?.[0]; } catch (e) { return { verdict: 'error', now: String(e.message) }; }
  const act = a?.action || 'none';
  // A prompt's ALTERNATIVES are tried in order on the page, as a list's
  // values are (F-618 moved his past answer there from an array value).
  const alts = Array.isArray(a?.values) && a.values.length ? a.values : Array.isArray(a?.alternatives) && a.alternatives.length ? a.alternatives : [a?.value];
  const cands = alts.filter((v) => v != null && String(v).trim() !== '').map(String);
  const nowText = act === 'check' ? 'checked' : cands[0] || '';

  // He cleared it or left it: the engine should leave it too.
  if (!sent || sent === 'unchecked') {
    return { verdict: ['skip', 'unknown'].includes(act) || !nowText ? 'match' : 'differs', now: `${act} ${nowText}`.trim() };
  }
  // A single box is checked or not; a GROUP of boxes answers with its options.
  if (sent === 'checked' || (type === 'checkbox' && options.length <= 1)) {
    return { verdict: act === 'check' ? 'match' : ['skip', 'unknown'].includes(act) ? 'empty' : 'differs', now: act };
  }
  // A box group he ticked, and a plan that ticks it.
  if (act === 'check') return { verdict: 'match', now: 'checked' };
  if (['skip', 'unknown', 'none'].includes(act) || !cands.length) return { verdict: 'empty', now: act };
  // THE MATCHER IS THE JUDGE, as the log's own "kept" is: "No" chosen as
  // "Not Hispanic or Latino" is the same answer in the form's words.
  const same = (c) => {
    if (norm(c) === norm(sent)) return true;
    // A CHOICE whose option carries the answer plus a gloss — "Bachelor's" as
    // "Bachelors (+16 years of education)" (HP) — the log's own "kept" test.
    const bare = (s) => norm(s).replace(/\s+/g, '');
    if (/^(select|radio|prompt|checkbox|combobox)$/i.test(type) && bare(c).length > 2 && bare(sent).includes(bare(c))) return true;
    // A phone number is the same number however it is punctuated.
    if (/^[\d\s().+-]{7,}$/.test(c) && c.replace(/\D/g, '') === sent.replace(/\D/g, '')) return true;
    try {
      if (chooseOption(c, [sent]) === 0) return true;
      if (options.length) { const i = chooseOption(c, options); if (i >= 0 && norm(options[i]) === norm(sent)) return true; }
    } catch { /* unreadable — not a match */ }
    return false;
  };
  // A single choice's alternatives are tried in order on the page; the first
  // the list accepts is what goes out. With the list known, only that one counts.
  if (options.length && cands.length > 1) {
    const first = cands.find((c) => { try { return chooseOption(c, options) >= 0; } catch { return false; } });
    return { verdict: first && same(first) ? 'match' : 'differs', now: first || cands[0] };
  }
  return { verdict: cands.some(same) ? 'match' : 'differs', now: cands.slice(0, 3).join(' › ') };
}

/**
 * ANSWERS THAT WENT OUT WRONG, and a rule has since corrected on purpose. The
 * replay's ground truth is what he sent, so without this a deliberate fix
 * reads as a regression forever, and the ratchet pushes back toward the error.
 * Each entry names the question, what went out, and why that was wrong. Only
 * for an answer that is wrong by his own files, never for a matter of taste.
 */
export const SENT_WRONG = [
  {
    re: /\bauthori[sz]ed\b[^.]{0,120}[.?]\s*this\s+does\s+not\s+include\s+practical\s+training/i,
    sent: /^yes$/i,
    why: 'excludes practical training, his only authorization on F-1 — No (Viavi, 2026-09-24)',
  },
  {
    // He sent Yes on a SmartRecruiters form (2026-09-26); asked the same day,
    // he chose No: F-1 then OPT is restricted authorization.
    re: /\bauthori[sz]ed\b[^?]{0,120}\bwithout\s+(any\s+)?restrictions?\b/i,
    sent: /^yes$/i,
    why: 'F-1 / OPT is restricted authorization — No, his decision 2026-09-26',
  },
  {
    // HP, 2026-09-26 and 09-27: a menu pick (F-618), not his. His profile:
    // "I am not a Veteran." — no military service.
    re: /\bveteran\b/i,
    sent: /^i\s+identify\s+as\s+(a\s+veteran|one\s+or\s+more\b)/i,
    why: 'he is not a veteran (apply-profile eeo.veteran) — the menu matcher picked this (F-618)',
  },
  {
    // KLA (Workday), 2026-09-24: the plan gave the Hispanic question his RACE
    // ("Asian") and that day's menu code committed "Yes". His profile:
    // eeo.hispanic "No". Found by the replay 2026-09-27 (F-623).
    re: /\bhispanic\s+or\s+latino\b/i,
    sent: /^yes$/i,
    why: 'he is not Hispanic or Latino (apply-profile eeo.hispanic) — the menu picked Yes from "Asian" (F-623)',
  },
];
const sentWrong = (r) => SENT_WRONG.find((w) => w.re.test(String(r.label || '')) && w.sent.test(String(r.answer ?? '').trim()));

export function replay({ file = ANSWER_LOG, profile = loadApplyProfile() } = {}) {
  const rows = corpus(file);
  const out = { total: rows.length, match: 0, differs: 0, empty: 0, error: 0, corrected: 0, shared: 0, borrowed: 0, regressions: 0, items: [] };
  for (const r of rows) {
    const wrong = sentWrong(r);
    const j = r._shared ? { verdict: 'shared', now: 'another field on the page has this label, and the log has no key to tell them apart' }
      : r._borrowed ? { verdict: 'borrowed', now: 'his own earlier answer, reused — not a rule' }
      : wrong ? { ...judge(r, profile), verdict: 'corrected' } : judge(r, profile);
    if (r._hisBefore && !['match', 'corrected', 'shared'].includes(j.verdict)) Object.assign(j, { verdict: 'borrowed', now: 'his own earlier answer, put back by the site — not a rule' });
    if (wrong) j.now = `${j.now} — ${wrong.why}`;
    out[j.verdict] = (out[j.verdict] || 0) + 1;
    // A field he KEPT as Jarvis had it, that Jarvis would now answer otherwise.
    // "Already there" is a regression only where a RULE knew the question: an
    // answer he typed on an earlier press is on the page the next time too
    // (Re:Build's export-control list, 2026-09-27), and no rule ever had it.
    const regression = !['match', 'corrected', 'shared', 'borrowed'].includes(j.verdict) && (r.status === 'kept' || (r.status === 'already there' && !!r.rule));
    if (regression) out.regressions += 1;
    out.items.push({ verdict: j.verdict, regression, status: r.status, host: r.host, company: r.company, label: String(r.label).slice(0, 140), sent: String(r.answer).slice(0, 80), now: String(j.now).slice(0, 80) });
  }
  out.rate = out.total ? Math.round((out.match / out.total) * 1000) / 10 : null;
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const r = replay();
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  console.log(`Replayed ${r.total} answers he sent: ${r.match} match today (${r.rate}%), ${r.differs} differ, ${r.empty} left empty${r.corrected ? `, ${r.corrected} went out wrong and are corrected now` : ''}${r.shared ? `, ${r.shared} share a label with another field and cannot be told apart` : ''}${r.borrowed ? `, ${r.borrowed} were his own earlier answer reused` : ''}.`);
  if (r.regressions) console.log(`⚠ ${r.regressions} of them he had KEPT as Jarvis answered — those are regressions.`);
  const show = args.includes('--all') ? r.items : r.items.filter((i) => i.verdict !== 'match');
  for (const i of show.sort((a, b) => Number(b.regression) - Number(a.regression) || a.verdict.localeCompare(b.verdict))) {
    console.log(`${i.regression ? '⚠ ' : '  '}${i.verdict.padEnd(7)} ${String(i.company || i.host).slice(0, 18).padEnd(18)} ${i.label.slice(0, 70).padEnd(70)} sent: ${i.sent.slice(0, 34).padEnd(34)} now: ${i.now}`);
  }
}
