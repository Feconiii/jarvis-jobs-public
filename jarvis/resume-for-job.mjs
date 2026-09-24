/**
 * One posting in, one tailored PDF out.
 *
 * This is the seam between the four standing resumes and a specific job. The
 * family still decides the BASE — the lane, and the fallback for everything
 * the model does not improve on. What the model may change (Alex, 2026-09-03:
 * "the point is to more aggressively tailor to the jd") is the shape of the
 * page for this one posting: which internship titles, which bullets in which
 * order, which projects, courses and skills, and the wording of each bullet.
 * Every one of those changes is checked — the shape by jarvis/resume-plan.mjs
 * against the pool, the wording by jarvis/resume-tailor.mjs against cv.md —
 * and anything that fails falls back to the family default and is reported.
 *
 * Order of operations, and each step exists because skipping it would be worse:
 *
 *   1. Verify the pool against cv.md. Unchanged, still fatal — a drifted pool
 *      must never be the thing a tailored resume is built on top of.
 *   2. Build the family spec, provenance and all.
 *   3. Ask the model for a plan and rewrites. Optional; failure here is not failure.
 *   4. Reduce the plan to the pool; check every rewrite; keep what passes.
 *   5. Render, and FIT: a page that spills loses its least-protected line, a
 *      page with room gains one from the model's reserve, and a bullet whose
 *      last line is a stub is reworded once — never by shrinking the font.
 *   6. Write the generic filename plus an audit copy that DOES say which
 *      family and which posting — that copy is for him, so he can see what went
 *      out before he presses Submit.
 */
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { familyFor, familyByKey } from './resume-family.mjs';
import { buildSpec, loadPool, verifyPoolAgainstCv } from './resume-variants.mjs';
import { buildVocabulary, applyRewrites } from './resume-tailor.mjs';
import { applyPlan, reserveFor, protectedPhrases } from './resume-plan.mjs';
import { tailorWithClaude } from './tailor-llm.mjs';
import { polish } from './resume-polish.mjs';
import { qaReport } from './resume-qa.mjs';
import { coverageLine } from './jd-terms.mjs';
import { keepReport } from './earns-its-keep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
/**
 * Where resumes are written. Overridable by JARVIS_RESUME_DIR for the same
 * reason the store is overridable by JARVIS_DATA_DIR: a test that builds a
 * resume must not leave "Acme Robotics" and "Full Co" in his real archive.
 * Measured, 2026-09-03 — four test fixtures were listed on the Resumes tab
 * beside Neuralink and KLA.
 */
export const OUT_DIR = process.env.JARVIS_RESUME_DIR || path.join(ROOT, 'output', 'jarvis-resumes');
const CV_PATH = path.join(ROOT, 'cv.md');

/** How many times the page may be re-rendered to fit before we stop trying. */
// Twelve, not four: a spill now costs short forms before it costs bullets,
// one per pass, and a plan that starts on every full wording can need
// several of each before it sits on one page. A pass is one render.

/**
 * The filename a recruiter sees: his name, the employer, the role.
 *
 * IT WAS "Alex Rivera Resume.pdf" FOR EVERY POSTING, deliberately — one ordinary
 * resume, nothing advertising that a machine had made it. He asked for the
 * change on 2026-09-08 and gave the reason: "i want to have a signal thats
 * what you actually attached". A form that swallows the file and shows nothing
 * back, or a panel that says "attached" when it is not, is a thing he has been
 * bitten by; a filename carrying the company and the role is the receipt.
 *
 * A build with no posting behind it — the four family bases — keeps the plain
 * name, because there is no employer to put in it.
 */
export const personFile = (name, job = null) => {
  const person = String(name || '').replace(/\s+/g, ' ').trim() || 'Resume';
  const bit = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const company = bit(job?.company);
  const title = bit(job?.title);
  if (!company && !title) return `${person} Resume.pdf`;
  // Windows caps a path at 260 characters and some ATSes cap the field, so a
  // very long req title is trimmed rather than allowed to break the upload.
  return `${[person, company, title.slice(0, 70)].filter(Boolean).join(' - ')}.pdf`;
};

/**
 * The audit copy's name. Matches the shape already in output/jarvis-resumes/sent
 * ("Alex Rivera Resume - automation - Applied Materials - Manufacturing Engineer")
 * rather than inventing a second convention beside it — this folder is something
 * he reads down, and two naming schemes in one listing is friction for no gain.
 */
export function auditName({ family, job, name = 'Alex Rivera' }) {
  const bit = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${[`${bit(name)} Resume`, bit(family), bit(job?.company), bit(job?.title)].filter(Boolean).join(' - ')}.pdf`;
}

/** The approved framing vocabulary, as written in cv.md, for the prompt. */
export function framingFrom(cvText) {
  const m = String(cvText || '').match(/##\s*Approved framing vocabulary[\s\S]*?-->\s*([\s\S]*?)(?:\n##|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 1400) : '';
}

/**
 * Build the tailored resume for one posting.
 *
 * `tailor` is injected so tests can drive the whole pipeline with a fixed set of
 * rewrites — including deliberately dishonest ones — without spending a model
 * call or depending on one being available.
 */
export async function resumeForJob(job, {
  outDir = OUT_DIR,
  jd = null,
  familyKey = null,
  tailor = tailorWithClaude,
  render = true,
  cvPath = CV_PATH,
  retries = 1,
  fixOrphans = true,
  // The sheet check's resolution; 0 skips rasterising (tests that only need a PDF).
  rasterDpi = 200,
  // His note for this resume, typed beside the form (the side panel). It
  // steers selection and wording inside the same rules; it adds nothing.
  request = '',
  // WHERE THE BUILD HAS GOT TO, for anything watching. A tailored resume takes
  // a minute or two — the model chooses the shape, the guard checks every claim
  // against cv.md, then the page is laid out and measured — and a single
  // "still writing" over all of that reads as a hang.
  onPhase = () => {},
} = {}) {
  const phase = (text) => { try { onPhase(String(text)); } catch { /* a progress line never fails a build */ } };
  phase('reading the posting');
  const pool = loadPool();
  const problems = verifyPoolAgainstCv(pool);
  if (problems.length) {
    const err = new Error(`resume pool does not match cv.md (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }

  const family = (familyKey && familyByKey(familyKey)) || familyFor(job);
  const base = buildSpec(family.key, pool);
  const cvText = readFileSync(cvPath, 'utf-8');

  let rewrites = {};
  let plan = null;
  let why = 'tailoring not attempted';
  if (jd) {
    phase('choosing what goes on the page');
    const asked = await tailor({ spec: base, job, jd, familyLabel: family.label, pool, framing: framingFrom(cvText), request: String(request || '') });
    rewrites = asked?.rewrites || {};
    plan = asked?.plan || null;
    why = asked?.why || why;
  } else {
    why = 'no description on this posting — resume ships in his own words';
  }

  // THE SHAPE, reduced to the pool. A plan the model did not give keeps the
  // family base; a part it got wrong is restored and said so.
  const planned = applyPlan(base, plan, { pool, job });
  const planNotes = [...(planned.notes || []), ...((plan?.notes || []).map((n) => `your note: ${n}`))];
  const changed = planned.changed;

  // His short-form resume counts too: every `short` bullet in the pool traces
  // to it, so a rewrite that borrows its wording ("found", "cut") is using his
  // words. Without it, the writer copying the short form was refused and the
  // long sentence shipped with a stub last line (Atomic Semi, 2026-09-23).
  let shortText = '';
  try { shortText = readFileSync(path.join(path.dirname(cvPath), 'cv-short.md'), 'utf-8'); } catch { /* optional */ }
  const vocab = buildVocabulary(`${cvText}\n${shortText}`);
  phase('checking every claim against your CV');
  let { spec, applied, refused, unmatched, notices } = applyRewrites(planned.spec, rewrites, { vocab });

  // ONE retry, and only for what the guard threw out. Measured on a live
  // GlobalFoundries posting, the first pass lost both Applied Materials rewrites
  // to words like "Deployed" and "repeatable" that are perfectly ordinary and
  // simply are not in his CV. Handing the model the actual reasons recovers the
  // bullets that matter most; a second failure means the standing sentence wins,
  // which is the right default and the reason this does not loop.
  if (refused.length && retries > 0) {
    phase(`rewording ${refused.length} line${refused.length === 1 ? '' : 's'} the guard threw out`);
    const sources = new Map();
    for (const e of spec.experience) for (const b of e.bullets) sources.set(b.provenanceKey, b.source);
    const again = await tailor({
      spec, job, jd, familyLabel: family.label,
      refusals: refused.map((r) => ({ ...r, source: sources.get(r.key) || [] })),
    });
    const second = applyRewrites(spec, again?.rewrites || {}, { vocab });
    if (second.applied.length) {
      spec = second.spec;
      applied = [...applied, ...second.applied];
      notices = [...notices, ...second.notices];
      // Only the ones that failed a SECOND time are still refusals.
      const rescued = new Set(second.applied.map((a) => a.key));
      refused = refused.filter((r) => !rescued.has(r.key));
      why = `${why}; ${second.applied.length} recovered on retry`;
    }
    unmatched = [...unmatched, ...second.unmatched];
  }

  const dir = path.join(outDir, family.variant);
  let pdfPath = null;
  let auditPath = null;
  let fit = null;
  let qa = null;
  const fitNotes = [];
  if (render) {
    mkdirSync(dir, { recursive: true });
    pdfPath = path.join(dir, personFile(spec.name, job));

    // FIT, POLISH, PROVE — one loop, shared with the family builds
    // (resume-polish.mjs): the page is measured after every change and the
    // worst thing found is answered with content before spacing; the
    // finished sheet is rasterised and his checklist run on it.
    const reserve = reserveFor(spec, pool, plan?.reserve || []);
    // WHAT THE POSTING ASKED FOR BY NAME, and therefore what the layout may
    // not spend. Reduced to phrases his own approved wordings actually carry —
    // the model can list anything, and only what is really on the page counts.
    const keep = protectedPhrases(spec, plan?.mustKeep || []);
    phase('laying out the page');
    const polished = await polish(spec, {
      pdfPath, pool, reserve, tailor: fixOrphans ? tailor : null, job, jd, vocab, keep, dpi: rasterDpi,
      tailored: !!jd, log: phase,
    });
    phase('checking the finished sheet');
    spec = polished.spec;
    fit = polished.fit;
    fitNotes.push(...polished.notes);
    applied = [...applied, ...polished.applied];
    refused = [...refused, ...polished.refused];
    qa = { judge: polished.judge, raster: polished.raster, checklist: polished.checklist, layout: polished.layout };
    if (!polished.checklist.ok) fitNotes.push(`QA: ${polished.checklist.items.filter((i) => !i.ok).map((i) => i.item).join('; ')}`);

    writeFileSync(path.join(dir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf-8');

    // The audit copy. He asked for this explicitly so he can check which resume
    // went out before hitting Submit, and it is the only place a descriptive
    // filename is allowed to exist.
    const sent = path.join(outDir, 'sent');
    mkdirSync(sent, { recursive: true });
    auditPath = path.join(sent, auditName({ family: family.variant, job, name: spec.name }));
    copyFileSync(pdfPath, auditPath);

    // WHAT WAS DECIDED, kept beside the PDF that resulted from it: the plan
    // (what the model changed about the shape, what was refused), every
    // rewrite as was/now, the fit as measured. The PDF shows the result; this
    // is the reasoning, and the difference between "I can read what went out"
    // and "I can check it."
    try {
      writeFileSync(`${auditPath}.json`, `${JSON.stringify({
        at: new Date().toISOString(),
        family: { key: family.key, label: family.label, variant: family.variant },
        company: job?.company || '',
        title: job?.title || '',
        url: job?.url || '',
        why,
        roleType: plan?.roleType || null,
        // WHAT THE POSTING ASKED FOR, AND WHAT ON THE PAGE ANSWERS IT — the
        // model's own list, kept so a requirement it left at "none" can be
        // read after the fact instead of discovered in a rejection.
        coverage: Array.isArray(plan?.coverage) ? plan.coverage : null,
        uncovered: Array.isArray(plan?.coverage)
          ? plan.coverage.filter((c) => c && /^none$/i.test(String(c.proof || '').trim())).map((c) => `${c.need === 'must' ? 'MUST' : 'nice'}: ${c.req}`)
          : null,
        mustKeep: keep,
        emphasise: Array.isArray(plan?.emphasise) ? plan.emphasise : null,
        whyFewerAmat: plan?.whyFewerAmat || null,
        titles: Object.fromEntries(spec.experience.filter((e) => e.orgKey).map((e) => [e.orgKey, e.title])),
        changed,
        planNotes,
        fit: fit ? { fill: fit.fill, topGap: fit.topGap, bottomGap: fit.bottomGap, pages: fit.pages ?? null, lostWords: fit.lostWords ?? null, orphans: fit.orphans, notes: fitNotes } : null,
        qa: qa ? { checklist: qa.checklist, problems: qa.judge?.problems || [], warnings: qa.judge?.warnings || [], sheet: qa.raster || null } : null,
        applied,
        refused,
        unmatched,
        notices,
      }, null, 2)}\n`, 'utf-8');
    } catch {
      // A missing sidecar must never cost him the resume itself.
    }
  }

  // `jd` travels with the result so the report can measure coverage against the
  // posting's own words rather than only against the writer's paraphrase of it.
  return { family, spec, pdfPath, auditPath, fit, qa, applied, refused, unmatched, notices, why, plan, changed, planNotes, fitNotes, jd, request: String(request || '') };
}

/** A short, readable account of what tailoring did — printed and logged, never guessed at. */
/** Everything the finished page actually says, for the term check. */
function resumeText(spec) {
  if (!spec) return '';
  return [
    ...(spec.experience || []).flatMap((e) => [e.title, ...(e.bullets || []).map((b) => b.text)]),
    ...(spec.projects || []).map((p) => `${p.name || ''} ${p.text || ''}`),
    ...(spec.skills || []).map((x) => `${x.lead}: ${x.text || (x.items || []).join(', ')}`),
    ...(spec.coursework || []),
  ].filter(Boolean).join(' | ');
}

export function tailorReport(result) {
  const lines = [`resume: ${result.family.label} (${result.family.key}) — ${result.why}`];
  // A TAILORING FAILURE SHIPS THE FAMILY BASE, AND IT USED TO DO THAT QUIETLY.
  //
  // Measured over the 50 most recently SENT resumes (2026-09-22): SEVEN of them
  // — 14% — went to an employer as the untailored base. Three tailoring calls
  // timed out at 240s, three exited 1, one hit the weekly model limit. Five of
  // the seven share a byte-identical body. The failure was recorded in the
  // sidecar, which nobody opens, and the run otherwise looked like every other
  // run.
  //
  // It stays a WARNING rather than a refusal: an untailored resume is a real
  // resume and still beats not applying. But it says so first, above the
  // coverage line, because "this page was not written for this job" changes how
  // everything under it should be read.
  const fell = (result.notices || []).filter((n) => /tailoring (timed out|call failed)|weekly limit|usage limit/i.test(String(n)));
  if (fell.length || (!result.applied?.length && !result.changed?.length && result.plan?.attempted)) {
    lines.push('  ⚠ NOT TAILORED — this is the family base, unchanged for this posting'
      + `${fell.length ? `: ${fell.join('; ')}` : ''}`);
  }
  if (result.changed?.length) lines.push(`  plan changed for this posting: ${result.changed.join(', ')}`);
  // COVERAGE FIRST, because it is the thing worth reading. A page that misses
  // a stated requirement should say so at the top of its own report, not be
  // discovered later.
  // A SECOND OPINION ON COVERAGE, because the first one marks its own homework.
  //
  // The line below is the writer's: the model lists the posting's requirements
  // in its own paraphrase and then says which it proved. Over the 50 most
  // recently SENT resumes that self-report claimed 83.7% (714 of 853). Measured
  // against the concrete nouns the postings actually use, the same 50 covered
  // 49% (217 of 442).
  //
  // Both are real. The model's list catches requirements written only as prose,
  // which no keyword sees; the term count cannot be talked up. They are printed
  // together on purpose — two measurements that disagree say more than one that
  // cannot.
  if (result.jd) {
    const line = coverageLine(result.jd, resumeText(result.spec));
    if (line) lines.push(line);
    // THE BAR, stated so it can be hit. "Objectively perfect" cannot mean the
    // best resume that could exist for this job — that needs experience he does
    // not have. It CAN mean: covers everything this posting names AND he can
    // prove, and carries little it never asked for. Both halves are measured,
    // neither is a judgement call, and a requirement he cannot evidence is
    // reported as HIS gap rather than counted against the page.
    const keep = keepReport(result.jd, resumeText(result.spec));
    if (keep) lines.push(keep);
  }
  const coverage = Array.isArray(result.plan?.coverage) ? result.plan.coverage : [];
  if (coverage.length) {
    const none = coverage.filter((c) => c && /^none$/i.test(String(c.proof || '').trim()));
    const musts = none.filter((c) => String(c.need).toLowerCase() === 'must');
    lines.push(`  covers ${coverage.length - none.length} of ${coverage.length} stated requirement(s) — by the writer's own reckoning`);
    for (const c of musts) lines.push(`  NOT PROVEN (must-have): ${c.req}`);
    for (const c of none.filter((c) => !musts.includes(c))) lines.push(`  not proven (nice-to-have): ${c.req}`);
  }
  if (result.plan?.whyFewerAmat) lines.push(`  amat trimmed: ${result.plan.whyFewerAmat}`);
  for (const n of result.planNotes || []) lines.push(`  plan: ${n}`);
  const t = (result.spec?.experience || []).filter((e) => e.orgKey && /intern/i.test(e.title)).map((e) => `${e.org.split(' ')[0]}: ${e.title}`);
  if (t.length) lines.push(`  titles: ${t.join(' · ')}`);
  for (const a of result.applied) lines.push(`  reworded ${a.key}\n    was: ${a.from}\n    now: ${a.to}`);
  for (const r of result.refused) lines.push(`  REFUSED ${r.key} — ${r.problems.join('; ')}`);
  for (const u of result.unmatched) lines.push(`  ignored a rewrite for "${u}" — no such bullet on this resume`);
  for (const n of result.notices) lines.push(`  note: ${n}`);
  for (const n of result.fitNotes || []) lines.push(`  fit: ${n}`);
  if (result.qa?.checklist) lines.push(qaReport({ judge: result.qa.judge, raster: result.qa.raster, checklist: result.qa.checklist }));
  if (result.fit) {
    const f = result.fit;
    lines.push(`  page: ${Math.round((f.fill || 0) * 100)}% full · margins ${f.topGap}px top / ${f.bottomGap}px bottom${f.pages ? ` · ${f.pages} page(s)` : ''}${f.lostWords?.length ? ` · TEXT LAYER LOST: ${f.lostWords.join(', ')}` : ''}${(f.orphans || []).length ? ` · ${f.orphans.length} orphan tail(s) remain` : ''}`);
  }
  if (result.applied.length === 0 && result.refused.length === 0) lines.push('  no rewrites — the standing wording already fits');
  return lines.join('\n');
}
