/**
 * Fit, then polish, then prove — the one loop both resume builders use.
 *
 * Content and layout are decided together (his rule, 2026-09-06): a bullet
 * that wraps badly is reworded, a Skills line that wraps badly is reordered
 * or trimmed, a short page gets its content back, a long page loses its
 * weakest line — and the font never moves. Each pass renders the page,
 * measures it (resume-qa.mjs), and answers the worst thing it found:
 *
 *   overflow        a bullet's short form first, then the weakest bullet out
 *   4-line bullet   the model compresses it inside the guard (same facts,
 *                   fewer words); a base with no model takes the short form
 *   stub last line  the model rewords it (existing orphan pass); a base
 *                   takes the short form
 *   skills stub     the category's items are reordered (measured, not
 *                   guessed); if no order clears it, the last — weakest —
 *                   item is dropped, never below three
 *   underfull       the next bullet from the reserve, in plan order
 *
 * A fix that spills the page is reverted. When nothing is left to try, what
 * remains is said, not hidden. The finished PDF is rasterised and the
 * checklist run on the sheet itself; the report and the PNG sit beside it.
 */
import { chromium } from 'playwright';
import { renderHtml, renderPdf, linkCheck } from './resume.mjs';
import { applyRewrites } from './resume-tailor.mjs';
import { shortenOneBullet, shortenBulletEnding, shortenOneProject, withoutOneBullet, withBullet, ONE_OF } from './resume-plan.mjs';
import { judgeLayout, rasterize, acceptance, RULES } from './resume-qa.mjs';
import { proofreadSpec } from './proofread.mjs';
import { termsIn } from './jd-terms.mjs';

export const MAX_PASSES = 14;
/**
 * How many goes ONE bullet gets at losing a stub last line.
 *
 * Two was not always enough: measured on a Zoox build (2026-09-07) the loop
 * spent eight passes on a last line at 33% of the width — a hair under the
 * one-third rule — and delivered the sheet with it, because the bullet had
 * used up its attempts and its short form did not change the wrap. A third go
 * costs one model call on a page that is otherwise finished.
 */
const ORPHAN_TRIES = 3;

/** The orders a wrapped Skills line is tried in: last item first, then by length. */
export function skillOrders(items) {
  const out = [];
  const push = (arr) => { const key = arr.join('|'); if (!out.some((o) => o.join('|') === key) && key !== items.join('|')) out.push(arr); };
  const byLen = [...items].sort((a, b) => b.length - a.length);
  if (items.length > 2) push([items[items.length - 1], ...items.slice(0, -1)]);
  // The two longest at the end: a second line that holds them is a real line.
  if (items.length > 3) push([...items.filter((i) => !byLen.slice(0, 2).includes(i)), ...byLen.slice(0, 2)]);
  push(byLen);
  push([...byLen].reverse());
  if (items.length > 3) push([items[items.length - 2], items[items.length - 1], ...items.slice(0, -2)]);
  return out;
}

/** Pool items of this category that are not on the page yet, in pool order. */
function spareSkills(pool, key, items) {
  const have = new Set(items);
  return (pool?.skills?.[key]?.items || []).filter((i) => !have.has(i));
}

function withSkills(spec, key, items) {
  return { ...spec, skills: (spec.skills || []).map((s) => (s.key === key ? { ...s, text: items.join(', ') } : s)) };
}
/** A line counts as full at this share of the column's width (his rule, 2026-09-23). */
const FILL_TO = 0.88;
/** Skills that fill a line only when the posting itself uses them. */
const ONLY_IF_ASKED = new Set([
  'Object Detection', 'Image Classification', 'Part Inspection', 'Qualification Testing', 'Dimensional Analysis',
  'Time Studies', 'Process Improvement', 'Continuous Improvement', 'Bottleneck Analysis', 'Cleanroom', 'Material Selection',
  'Agentic AI', 'AI Agents', 'AI Workflow Automation', 'Prompt Engineering', 'Large Language Models (LLMs)', 'AI-Assisted Engineering',
]);
const courseLine = (spec) => (spec.education?.[0]?.bullets || []).find((b) => b && typeof b === 'object' && /coursework/i.test(b.lead || ''));
const courseItems = (spec) => String(courseLine(spec)?.text || '').split(/,\s*/).filter(Boolean);
const withCourses = (spec, items) => ({
  ...spec,
  education: (spec.education || []).map((e, i) => (i !== 0 ? e : {
    ...e, bullets: (e.bullets || []).map((b) => (b && typeof b === 'object' && /coursework/i.test(b.lead || '') ? { ...b, text: items.join(', ') } : b)),
  })),
});
const skillItems = (spec, key) => String((spec.skills || []).find((s) => s.key === key)?.text || '').split(/,\s*/).filter(Boolean);
const skillKeyByLead = (spec, lead) => (spec.skills || []).find((s) => s.lead === lead)?.key || null;

function bulletFor(spec, ends) {
  const tail = String(ends || '').trim();
  for (const e of spec.experience || []) for (const b of e.bullets || []) if (b.text.trim().endsWith(tail)) return { e, b };
  return null;
}

/** Undo a set of rewrites by key. */
function revert(spec, applied) {
  return { ...spec, experience: spec.experience.map((e) => ({ ...e, bullets: e.bullets.map((b) => { const a = applied.find((x) => x.key === b.provenanceKey); return a ? { ...b, text: a.from } : b; }) })) };
}

/**
 * @param spec      the resume as planned (bullets carry provenanceKey/source/short)
 * @param pdfPath   where the PDF goes
 * @param pool      the bullet pool (for the reserve)
 * @param reserve   bullet keys to add when the page is short, in order
 * @param tailor    the model (tailorWithClaude or a stub); null for a base
 * @param job/jd    what the model is told; the orphan/compress passes need jd
 * @param vocab     cv.md's vocabulary for the guard
 * @param keep      phrases this posting asked for by name; never shortened away
 * @param rasterizeDpi 200; 0 skips the sheet check (tests)
 */
export async function polish(spec, {
  pdfPath, pool = null, reserve = [], tailor = null, job = null, jd = null, vocab = null,
  keep = [], maxPasses = MAX_PASSES, dpi = 200, log = () => {}, tailored = null,
} = {}) {
  const notes = [];
  const applied = [];
  const refused = [];
  const triedCompress = new Set();
  const triedOrphan = new Map();   // key -> attempts; the model gets two goes, then the short form
  const triedSkills = new Map();   // key -> orders tried
  const modelOn = !!tailor && !!jd && !/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''));
  // WHAT THE POSTING NAMED STAYS. Rebuilding eight postings he had applied to
  // (2026-09-23) found the skills trim throwing out exactly what was asked
  // for: Atomic Semi named FMEA, 8D and control plans, his skills prove all
  // three, and the page went from covering 13 of 13 to 10. An item the posting
  // names is never trimmed, and a category goes by how little was asked of it.
  const askedFor = jd ? termsIn(jd) : new Set();
  const named = (item) => [...termsIn(String(item))].some((t) => askedFor.has(t));
  const namedIn = (s, cat) => skillItems(s, cat.key).filter(named).length;
  // Activity phrases and AI buzzwords print only when the posting uses them —
  // the blind read of 2026-09-23 called "Object Detection" padding, and the
  // writer's own rules already say so. A family base has no posting, so they go.
  const jdText = String(jd || '').toLowerCase();
  spec = {
    ...spec,
    skills: (spec.skills || []).map((s) => {
      const items = skillItems(spec, s.key);
      const kept = items.filter((x) => !ONLY_IF_ASKED.has(x) || named(x) || jdText.includes(String(x).toLowerCase()));
      return kept.length === items.length || !kept.length ? s : { ...s, text: kept.join(', ') };
    }),
  };
  const browser = await chromium.launch();
  let fit = null, judge = null, layout = null;
  const render = async (s) => {
    const r = await renderPdf(renderHtml(s), pdfPath, { browser });
    return { fit: r, layout: r.layout, judge: judgeLayout(r.layout) };
  };
  try {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      ({ fit, layout, judge } = await render(spec));
      const spilled = fit.overflow || (fit.pages || 1) > 1;
      const kinds = new Set(judge.problems.map((p) => p.kind));
      // WHAT IT IS DOING, WHILE IT DOES IT. A build takes a minute or two and
      // the panel said only "still writing the resume", which reads as dead
      // (his words, 2026-09-06). Each pass names the worst thing on the sheet.
      log(judge.problems.length
        ? `laying out the page — pass ${pass + 1}: ${judge.problems[0].detail || judge.problems[0].kind}`
        : `laying out the page — pass ${pass + 1}: measuring the sheet`);

      // 0. A SKILLS CATEGORY OVER TWO LINES (his limit — per category, 2026-09-23).
      //
      // RUNS FIRST, ahead of the spill repair: trimming an over-long skills
      // line is a rule violation AND page pressure at once, and when it sat
      // after the bullet fixes the loop spent every pass shortening bullets
      // and never reached it.
      //
      // Until 2026-09-23 this enforced a two-line cap on the WHOLE section,
      // read from his "skills section should never be more than 2 lines". He
      // meant one category: "i used to see like 3 lines of skills for one
      // category … there is no cap on totla lines of skills". The section cap
      // had every page going out with two thin skills lines, and a blind
      // reader preferred the older, longer skills on all eight skims.
      //
      // Only the over-long category is trimmed, only items the posting did not
      // name, never its first three (the headline tools a recruiter scans for),
      // and the ones a bullet already proves go before the ones only this line
      // carries. Never by shrinking type.
      if (kinds.has('skills-category-long')) {
        let fixed = false;
        for (let attempt = 0; attempt < 8 && !fixed; attempt += 1) {
          const long = (layout.skills || []).find((x) => (x.lines || 1) > RULES.maxSkillsLinesPerCategory);
          if (!long) { fixed = true; break; }
          const key = skillKeyByLead(spec, long.lead);
          const items = key ? skillItems(spec, key) : [];
          const LEAD = 3;
          const droppable = items.slice(LEAD).filter((i) => !named(i));
          if (!droppable.length) break;   // nothing left that the posting did not ask for
          const onPage = (spec.experience || []).flatMap((e) => e.bullets.map((b) => b.text)).join(' ').toLowerCase();
          const ordered = [
            ...[...droppable].reverse().filter((i) => onPage.includes(String(i).toLowerCase())),
            ...[...droppable].reverse().filter((i) => !onPage.includes(String(i).toLowerCase())),
          ];
          // Enough characters to lose the lines over the limit, estimated from
          // the measured line and proved by the next render — one render per
          // attempt, because a render per item blew a build's timeout once.
          const perLine = long.chars / Math.max(0.5, long.lines - 1 + (long.lastLineFill ?? 1));
          let need = (long.lastLineFill ?? 1) * perLine + (long.lines - 1 - RULES.maxSkillsLinesPerCategory) * perLine;
          const goes = new Set();
          for (const i of ordered) { if (need <= 0) break; goes.add(i); need -= String(i).length + 2; }
          const candidate = withSkills(spec, key, items.filter((i) => !goes.has(i)));
          const again = await render(candidate);
          spec = candidate;
          ({ layout, fit } = again);
          notes.push(`Skills "${long.lead}" ran ${long.lines} lines — dropped ${[...goes].join(', ')}`);
          if (!again.judge.problems.some((p) => p.kind === 'skills-category-long')) fixed = true;
        }
        if (!fixed) notes.push('a Skills category is still over two lines — everything left on it was asked for or leads it');
        if (fixed) continue;
      }


      // 1. TOO LONG: fewer words before fewer claims.
      if (spilled) {
        const tight = shortenOneBullet(spec, keep);
        if (tight.shortened) { spec = tight.spec; notes.push(`spilled past one page — ${tight.shortened} in its short form`); continue; }
        // A PROJECT SAYS ITSELF IN FEWER WORDS BEFORE A CLAIM LEAVES THE PAGE.
        // Projects print in full now (F-436), so this is the line the fit loop
        // spends next — and never one carrying a phrase the posting named.
        const tighter = shortenOneProject(spec, keep);
        if (tighter.shortened) { spec = tighter.spec; notes.push(`spilled past one page — the ${tighter.shortened} project in its short form`); continue; }
        // A SKILLS CATEGORY GOES BEFORE A BULLET — his answer, 2026-09-23 (a
        // bullet carrying evidence beats a longer skills list). The one the
        // posting asked least of; two categories stay, because one subtitle is
        // a list, not a grouping.
        const cats = spec.skills || [];
        if (cats.length > 2) {
          const least = cats.reduce((lo, c) => (namedIn(spec, c) <= namedIn(spec, lo) ? c : lo), cats[cats.length - 1]);
          spec = { ...spec, skills: cats.filter((c) => c !== least) };
          notes.push(`spilled past one page — dropped the "${least.lead}" skills category`);
          continue;
        }
        const cut = withoutOneBullet(spec);
        if (!cut.dropped) { notes.push('spills past one page and nothing is left to cut'); break; }
        spec = cut.spec; notes.push(`spilled past one page — dropped ${cut.dropped}`); continue;
      }

      // 2. A FOUR-LINE BULLET: compressed, same facts, fewer words.
      const long = judge.problems.filter((p) => p.kind === 'long-bullet').map((p) => ({ p, hit: bulletFor(spec, p.bullet.ends) })).filter((x) => x.hit && !triedCompress.has(x.hit.b.provenanceKey));
      if (long.length) {
        for (const x of long) triedCompress.add(x.hit.b.provenanceKey);
        let changed = false;
        if (modelOn) {
          const cases = long.map(({ p, hit }) => ({
            key: hit.b.provenanceKey, text: hit.b.text, source: hit.b.source || [hit.b.text], lines: p.bullet.lines,
            targetChars: Math.floor((p.bullet.chars * RULES.maxBulletLines) / p.bullet.lines) - 6,
          }));
          const asked = await tailor({ spec, job, jd, compress: cases });
          const out = applyRewrites(spec, asked?.rewrites || {}, { vocab });
          if (out.refused.length) refused.push(...out.refused);
          if (out.applied.length) {
            const before = spec;
            spec = out.spec;
            const again = await render(spec);
            if (again.fit.overflow || (again.fit.pages || 1) > 1) { spec = before; notes.push('a compressed bullet spilled the page — reverted'); } else { applied.push(...out.applied); notes.push(`compressed ${out.applied.length} bullet(s) to three lines or fewer`); changed = true; }
          }
        }
        if (!changed) {
          for (const { p } of long) {
            const tight = shortenBulletEnding(spec, p.bullet.ends, keep);
            if (tight.shortened) { spec = tight.spec; notes.push(`${tight.shortened} in its short form (was ${p.bullet.lines} lines)`); changed = true; }
          }
        }
        if (changed) continue;
        notes.push(`${long.length} bullet(s) stay at four lines — nothing shorter is approved`);
      }

      // 3. A STUB LAST LINE: reworded by the model, else the short form.
      const stubs = judge.problems.filter((p) => p.kind === 'stub' || p.kind === 'one-word-line').map((p) => ({ p, hit: bulletFor(spec, p.bullet.ends) })).filter((x) => x.hit && (triedOrphan.get(x.hit.b.provenanceKey) || 0) < ORPHAN_TRIES);
      if (stubs.length) {
        for (const x of stubs) triedOrphan.set(x.hit.b.provenanceKey, (triedOrphan.get(x.hit.b.provenanceKey) || 0) + 1);
        let changed = false;
        // The model first, twice at most (its first fix can land on a new stub
        // — measured on 1X: "…jams by 70%." with "70%." alone); a bullet with
        // an unused short form takes it on the second go.
        const secondGo = stubs.filter((x) => triedOrphan.get(x.hit.b.provenanceKey) >= 2);
        for (const { p, hit } of secondGo) {
          if (hit.b.short && hit.b.text !== hit.b.short) {
            const tight = shortenBulletEnding(spec, p.bullet.ends, keep);
            if (tight.shortened) { spec = tight.spec; notes.push(`${tight.shortened} in its short form (stub last line, second go)`); changed = true; }
          }
        }
        if (changed) continue;
        if (modelOn) {
          const cases = stubs.map(({ p, hit }) => {
            const perLine = Math.ceil(hit.b.text.length / p.bullet.lines);
            return { key: hit.b.provenanceKey, text: hit.b.text, source: hit.b.source || [hit.b.text], fraction: p.bullet.tailFraction, lines: p.bullet.lines,
              cutChars: Math.ceil(p.bullet.tailFraction * perLine) + 3, addChars: Math.max(4, Math.ceil((1 / 3 - p.bullet.tailFraction) * perLine) + 3) };
          });
          const asked = await tailor({ spec, job, jd, orphans: cases });
          const out = applyRewrites(spec, asked?.rewrites || {}, { vocab });
          if (out.refused.length) refused.push(...out.refused);
          if (out.applied.length) {
            const before = spec;
            spec = out.spec;
            const again = await render(spec);
            if (again.fit.overflow || (again.fit.pages || 1) > 1) { spec = before; notes.push('the orphan fix spilled the page — reverted'); } else { applied.push(...out.applied); notes.push(`reworded ${out.applied.length} bullet(s) to lose a stub last line`); changed = true; }
          }
        }
        if (!changed) {
          for (const { p } of stubs) {
            const tight = shortenBulletEnding(spec, p.bullet.ends, keep);
            if (tight.shortened) { spec = tight.spec; notes.push(`${tight.shortened} in its short form (stub last line)`); changed = true; }
          }
        }
        if (changed) continue;
      }

      // 3b. A PROJECT THAT ENDS ON A STUB: its short form, when it has one.
      // The model's orphan pass only sees experience bullets, so without this a
      // project stub was left on the page for every base (2026-09-15).
      const projectStubs = judge.problems.filter((p) => (p.kind === 'stub' || p.kind === 'one-word-line') && p.bullet && !bulletFor(spec, p.bullet.ends));
      if (projectStubs.length) {
        let changed = false;
        for (const { bullet } of projectStubs) {
          const tight = shortenBulletEnding(spec, bullet.ends, keep);
          if (tight.shortened) { spec = tight.spec; notes.push(`the ${tight.shortened} project in its short form (stub last line)`); changed = true; }
        }
        if (changed) continue;
      }

      // 4. A SKILLS LINE THAT WRAPS TO A STUB: reorder, measured; then trim.
      const skillStubs = judge.problems.filter((p) => p.kind === 'skills-stub');
      if (skillStubs.length) {
        const s = skillStubs[0].skill;
        const key = skillKeyByLead(spec, s.lead);
        const items = key ? skillItems(spec, key) : [];
        if (key && items.length) {
          const tried = triedSkills.get(key) || new Set();
          triedSkills.set(key, tried);
          let fixed = false;
          for (const order of skillOrders(items)) {
            const sig = order.join('|');
            if (tried.has(sig)) continue;
            tried.add(sig);
            const candidate = withSkills(spec, key, order);
            const again = await render(candidate);
            const still = again.judge.problems.some((p) => p.kind === 'skills-stub' && p.skill.lead === s.lead);
            const spilledNow = again.fit.overflow || (again.fit.pages || 1) > 1;
            if (!still && !spilledNow) { spec = candidate; notes.push(`reordered Skills "${s.lead}" so its second line holds ${again.layout.skills.find((x) => x.lead === s.lead)?.secondLineItems ?? 'more'} items`); fixed = true; break; }
          }
          // CONTENT BEFORE CUTS: a second line that is a stub because the
          // line is a few words over is given more of the category — items he
          // has in the pool that the plan left off — until it is worth having.
          if (!fixed && pool) {
            const spare = spareSkills(pool, key, items);
            let grown = items;
            for (const extra of spare.slice(0, 4)) {
              grown = [...grown, extra];
              if (tried.has(`+${grown.join('|')}`)) continue;
              tried.add(`+${grown.join('|')}`);
              const candidate = withSkills(spec, key, grown);
              const again = await render(candidate);
              const spilledNow = again.fit.overflow || (again.fit.pages || 1) > 1;
              if (spilledNow) break;
              const still = again.judge.problems.some((p) => p.kind === 'skills-stub' && p.skill.lead === s.lead);
              if (!still) { spec = candidate; notes.push(`Skills "${s.lead}" wrapped to a stub — added ${grown.slice(items.length).map((x) => `"${x}"`).join(', ')} from the pool so its second line is worth having`); fixed = true; break; }
            }
          }
          // THE PAGE IS FULL AND THE LINE IS A FEW WORDS OVER: one item goes.
          // The one whose evidence is already on the page — named in a bullet
          // ("Excel VBA macro", "tolerance analysis") — before the last.
          if (!fixed && items.length > 3) {
            const onPage = (spec.experience || []).flatMap((e) => e.bullets.map((b) => b.text)).join(' ').toLowerCase();
            const redundant = [...items].reverse().find((i) => onPage.includes(String(i).toLowerCase()));
            const dropped = redundant || items[items.length - 1];
            spec = withSkills(spec, key, items.filter((i) => i !== dropped));
            notes.push(`dropped "${dropped}" from Skills "${s.lead}" — no order cleared its second line${redundant ? ' (it is named in a bullet already)' : ''}`);
            fixed = true;
          }
          if (fixed) continue;
          notes.push(`Skills "${s.lead}" still wraps to a stub and is down to ${items.length} items`);
        }
      }

      // 5. TOO SHORT: content back before spacing.
      if (kinds.has('underfull') || fit.underfull) {
        if (reserve.length && pool) {
          // THE RESERVE MUST RESPECT ONE_OF TOO.
          //
          // `amat.robodk` and `amat.cobot-install` are the SAME UR leak-test
          // cell — his words, 2026-08-09: "in reality its only one thing, the
          // din rail stuff is just fluff for installation". `resume-plan.mjs`
          // enforces that for the model's plan; this path did not, so when the
          // two-line SKILLS cap left the page short the reserve happily added
          // the second half of a project the page already described.
          //
          // Found by a cold read of the built automation base, 2026-09-22:
          // "the UR cobot leak-test cell is described twice … on a fast read it
          // looks like two projects until you notice 'leak' in both, at which
          // point it reads as inflation." It was on the page as shipped.
          const onPage = new Set((spec.experience || []).flatMap((e) => (e.bullets || []).map((b) => b.provenanceKey)));
          while (reserve.length) {
            const next = reserve[0];
            const clash = ONE_OF.find((pair) => pair.includes(next) && pair.some((x) => x !== next && onPage.has(x)));
            if (!clash) break;
            reserve.shift();
            notes.push(`${next} left out — it is the same work as ${clash.find((x) => x !== next)}, already on the page`);
          }
          if (!reserve.length) { notes.push('the reserve is spent'); break; }
          const key = reserve.shift();
          const before = spec;
          spec = withBullet(spec, key, pool);
          const again = await render(spec);
          if (again.fit.overflow || (again.fit.pages || 1) > 1) { spec = before; notes.push(`${key} would spill the page — left out`); }
          else { notes.push(`page had room — added ${key}`); continue; }
        }
        if (kinds.has('underfull')) notes.push(`page is ${Math.round(judge.fill * 100)}% full and the reserve is spent`);
      }
      break;
    }

    // 5b. BULLETS FIRST, THEN SKILLS. His answer, 2026-09-23, once skills had no
    // section cap: with four full categories the automation base printed eight
    // skills lines and Acme Steel fell from four bullets to two. Experience fills
    // the page by his order (the reserve is Acme Steel first); skills get what is
    // left. So while a reserve bullet is waiting and more than two categories
    // print, the category the posting asked least of gives its room to the
    // bullet — kept only if the page still fits and nothing new is wrong.
    ({ fit, layout, judge } = await render(spec));
    if (pool && !(fit.overflow || (fit.pages || 1) > 1)) {
      const onPageNow = () => new Set((spec.experience || []).flatMap((e) => (e.bullets || []).map((b) => b.provenanceKey)));
      while (reserve.length && (spec.skills || []).length > 2) {
        const key = reserve.shift();
        const here = onPageNow();
        if (here.has(key) || ONE_OF.some((pair) => pair.includes(key) && pair.some((x) => x !== key && here.has(x)))) continue;
        const cats = spec.skills || [];
        const least = cats.reduce((lo, c) => (namedIn(spec, c) <= namedIn(spec, lo) ? c : lo), cats[cats.length - 1]);
        const candidate = withBullet({ ...spec, skills: cats.filter((c) => c !== least) }, key, pool);
        const again = await render(candidate);
        const spilledNow = again.fit.overflow || (again.fit.pages || 1) > 1;
        if (spilledNow || again.judge.problems.length > judge.problems.length) { notes.push(`${key} would not fit even in place of the "${least.lead}" skills — left out`); continue; }
        spec = candidate; ({ fit, layout, judge } = again);
        notes.push(`added ${key} in place of the "${least.lead}" skills category — bullets before skills`);
      }
    }

    // 6. A LINE THAT IS ONLY PARTLY USED IS FILLED. His rule, 2026-09-23: "for
    // relevant course work if you gonna use two lines you might as well use all
    // of the two lines, not half of the 2nd line, apply same rule for skills,
    // if two lines use fully, it helps with keywords hit and also looks
    // fuller". The same day, a blind reader preferred the older, longer skills
    // sections on every 30-second skim of eight postings.
    //
    // Only items already in the pool (so already in cv.md), what the posting
    // names first, and only while the line count stays exactly where it was —
    // a filled line never costs the page a line. Skills lines are filled
    // whether they run one line or two; coursework once it runs two.
    ({ fit, layout, judge } = await render(spec));
    if (pool && !(fit.overflow || (fit.pages || 1) > 1)) {
      const asked = jd ? termsIn(jd) : new Set();
      const isAsked = (x) => [...termsIn(String(x))].some((t) => asked.has(t));
      const jdLow = String(jd || '').toLowerCase();
      const courseScore = (c) => String(c).toLowerCase().split(/\W+/).filter((w) => w.length > 3 && jdLow.includes(w)).length;
      // The family's own order when the posting does not decide: the
      // automation page argues robots and machines, and a thermal-fluids run
      // argues neither (resume-variants.mjs), so those come last there.
      const fillRank = (c) => { const i = (spec.courseworkFill || []).indexOf(c); return i === -1 ? 99 : i; };
      const targets = [];
      for (const s of layout.skills || []) {
        const key = skillKeyByLead(spec, s.lead);
        if (key) targets.push({ kind: 'skills', lead: s.lead, key });
      }
      const cw = (layout.education || []).find((e) => /coursework/i.test(e.lead || ''));
      if (cw && cw.lines >= 2) targets.push({ kind: 'coursework', lead: cw.lead });
      const measureOf = (lay, t) => (t.kind === 'skills'
        ? (lay.skills || []).find((x) => x.lead === t.lead)
        : (lay.education || []).find((e) => /coursework/i.test(e.lead || '')));
      // Three rounds per line: an estimate is conservative, so the measured
      // line after one batch often still has room for another item.
      for (const t of [...targets, ...targets, ...targets]) {
        const m = measureOf(layout, t);
        if (!m || m.lastLineFill == null || m.lastLineFill >= FILL_TO) continue;
        const have = t.kind === 'skills' ? skillItems(spec, t.key) : courseItems(spec);
        let spare = t.kind === 'skills'
          ? spareSkills(pool, t.key, have)
          : (pool.education?.coursework || []).filter((c) => !have.includes(c));
        spare = t.kind === 'skills'
          ? [...spare.filter(isAsked), ...spare.filter((x) => !isAsked(x))]
          : spare.map((c, i) => ({ c, i, s: courseScore(c), f: fillRank(c) })).sort((a, b) => b.s - a.s || a.f - b.f || a.i - b.i).map((x) => x.c);
        // A tool-less activity phrase or an AI buzzword is filler when isolated
        // (the blind read called "Object Detection" padding); it fills a line
        // only when this posting uses it.
        if (t.kind === 'skills') spare = spare.filter((x) => !ONLY_IF_ASKED.has(x) || isAsked(x) || jdLow.includes(String(x).toLowerCase()));
        if (!spare.length) continue;
        // An estimate from the measured line, then proved by a render; an
        // estimate that wraps gives back its last item and is measured again.
        const perLine = m.chars / Math.max(0.5, m.lines - 1 + m.lastLineFill);
        let room = Math.floor((1 - m.lastLineFill) * perLine) - 2;
        const add = [];
        for (const x of spare) if (String(x).length + 2 <= room) { add.push(x); room -= String(x).length + 2; }
        while (add.length) {
          const candidate = t.kind === 'skills' ? withSkills(spec, t.key, [...have, ...add]) : withCourses(spec, [...have, ...add]);
          const again = await render(candidate);
          const m2 = measureOf(again.layout, t);
          const spilledNow = again.fit.overflow || (again.fit.pages || 1) > 1;
          if (m2 && m2.lines === m.lines && !spilledNow && again.judge.problems.length <= judge.problems.length) {
            spec = candidate; ({ fit, layout, judge } = again);
            notes.push(`${t.lead} line was ${Math.round(m.lastLineFill * 100)}% used — added ${add.join(', ')}`);
            break;
          }
          add.pop();
        }
      }
    }
    ({ fit, layout, judge } = await render(spec));

    // THE SHEET ITSELF.
    let raster = null;
    if (dpi > 0) {
      try { raster = await rasterize(pdfPath, { dpi, browser }); } catch (e) { raster = { ok: false, why: String(e?.message || e) }; }
    }
    // On the LAST render's file, which is the one that goes out.
    const links = linkCheck(spec.contact || {}, fit.links);
    const checklist = acceptance({ layout, judge, raster, text: fit.lostWords ? { lost: fit.lostWords, pages: fit.pages } : null, fontPt: layout?.fontPt, content: { tailored }, links, proof: proofreadSpec(spec) });
    return { spec, fit: { ...fit, orphans: fit.orphans || [] }, layout, judge, raster, checklist, links, notes, applied, refused };
  } finally { await browser.close(); }
}
