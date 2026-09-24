/**
 * A per-posting PLAN, checked — what the model may change about the shape of
 * a resume, and what it may not.
 *
 * Alex, 2026-09-03: "the point is to more aggressively tailor to the jd".
 * Before this file, tailoring could reword a bullet and nothing else: the
 * family plan fixed which bullets, in which order, under which title, with
 * which projects, courses and skills. Now the model proposes all of those for
 * ONE posting, and this file is the reason that is safe: every proposal is
 * reduced to the pool — keys into jarvis/resume-pool.json, which traces to
 * cv.md — and anything outside it is replaced by the family's default and
 * reported. The model can choose; it cannot invent.
 *
 * What stays fixed whatever the model says, because these are his rules and
 * not matters of fit:
 *
 *   - Every role he has held is on the page (a missing role reads as a gap).
 *   - The Inventor inspection fixture and the Neuro-T vision model are on
 *     every resume ("mechanical design is a damn staple", 2026-08-02).
 *   - Applied Materials keeps at least five bullets.
 *   - The UR leak-test cell is described once (robodk or cobot-install, never
 *     both — "in reality its only one thing", 2026-08-09).
 *   - Titles come from cv.md's approved list; at Applied Materials itself only
 *     the two official ones, chosen by the role type, whatever was proposed.
 *   - Education first, then Experience, Projects, Skills.
 */
import { familyFor } from './resume-family.mjs';
import { skillLines } from './resume-variants.mjs';

/**
 * On every resume, whatever the lane.
 *
 * The Inventor inspection fixture, and only that (2026-09-09). It was two:
 * Neuro-T was restored onto every page as well, and on a vehicle-hardware
 * posting that named Baja SAE in its second requirement it held a line the
 * Baja block needed (F-437). His rule was "mechanical design is a damn staple"
 * (2026-08-02) — the fixture is the mechanical-design bullet; Neuro-T is
 * machine vision, which is a different claim and one most postings do not ask
 * for. It is now a strong default the tailorer may spend, not a fixture.
 */
export const STAPLES = ['amat.vision-fixture'];
/**
 * Organisations that may be left off entirely (2026-09-05). Baja SAE proves
 * machining and fabrication that Makerspace proves far more strongly, and its other
 * lines are assumed engineering activity ("collaborated to troubleshoot"); a
 * one-page resume carries the strongest evidence, not every relevant line.
 *
 * That reasoning holds only where the posting is silent about build teams.
 * Where it names one, Baja is the evidence and the prompt says so.
 */
export const OPTIONAL_ORGS = ['sae', 'rover'];
/**
 * The least-protected organisation first, when the page is over budget.
 *
 * The Mars Rover Team (added 2026-09-15) replaced Baja on every family base —
 * his call: for robotics roles it is stronger evidence than Baja. It is still
 * optional per posting, like SAE, but it outranks SAE and outlasts Makerspace's
 * second line: Makerspace drops to its one-line floor first, then the rover block
 * goes whole.
 */
export const TRIM_ORDER = ['sae', 'makerspace', 'rover', 'acme', 'amat'];
/** Where spare room goes when the plan names nothing more: Acme Steel first (his call, 2026-09-23). */
export const RESERVE_ORDER = ['acme', 'amat', 'makerspace', 'rover', 'sae'];
/** The same cell described twice. */
export const ONE_OF = [['amat.robodk', 'amat.cobot-install']];
/**
 * What Applied Materials keeps.
 *
 * `MIN_AMAT` is the standing floor: it is the strongest block on the page and
 * five lines is what it is worth on almost every posting. `MIN_AMAT_JUSTIFIED`
 * is how far the tailorer may go when it has ARGUED for the room — when the
 * plan carries `whyFewerAmat` naming what the freed lines prove instead. A
 * plan that just returns three bullets and says nothing is restored to five;
 * the floor moves for a reason or it does not move (his call, 2026-09-09).
 */
export const MIN_AMAT = 5;
export const MIN_AMAT_JUSTIFIED = 3;
export const MAX_BULLETS = 13;
export const MIN_BULLETS = 9;
export const MAX_PER_MINOR_ORG = 2;
/** …and what an org the posting genuinely leans on may keep, when the plan asks. */
export const MAX_PER_EMPHASISED_ORG = 3;

/** Does this posting belong to Applied Materials, where only the official titles may appear? */
export function isOwnCompany(orgEntry, job) {
  const org = String(orgEntry?.org || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const co = String(job?.company || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return !!org && !!co && (co.startsWith(org) || org.startsWith(co) || co === 'amat');
}

/**
 * Mechanical roles get the mechanical title; everything else at Applied
 * Materials (process, manufacturing, NPI, operations, quality, systems) gets
 * the official one. The family router already draws exactly this line.
 */
export function ownCompanyTitle(orgEntry, job) {
  const at = orgEntry?.atOwnCompany || {};
  const fam = familyFor(job).key;
  return (fam === 'mechanical' ? at.mechanical : at.manufacturing) || at.manufacturing || null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Apply a proposal to a family's base spec. Returns `{ spec, notes, changed }`:
 * `notes` say what was refused or restored and why, in plain words; `changed`
 * lists which parts of the plan differ from the family default.
 *
 * `proposal` may be partial or null — a missing part means "keep the base".
 */
export function applyPlan(base, proposal, { pool, job } = {}) {
  const notes = [];
  const changed = [];
  const spec = { ...base };
  const p = proposal && typeof proposal === 'object' ? proposal : {};

  // ── titles ───────────────────────────────────────────────────────
  spec.experience = base.experience.map((entry) => {
    const orgEntry = pool.orgs[entry.orgKey];
    if (!orgEntry) return entry;
    let title = entry.title;
    const approved = orgEntry.approvedTitles || Object.values(orgEntry.titles || {});
    const wanted = p.titles?.[entry.orgKey];
    if (approved.length > 1 || orgEntry.atOwnCompany) {
      if (isOwnCompany(orgEntry, job) && orgEntry.atOwnCompany) {
        const own = ownCompanyTitle(orgEntry, job);
        if (own) {
          if (wanted && norm(wanted) !== norm(own)) notes.push(`${entry.orgKey}: "${wanted}" refused — applying to ${orgEntry.org} itself, only the official title is allowed; using "${own}"`);
          title = own;
        }
      } else if (wanted) {
        const hit = approved.find((t) => norm(t) === norm(wanted));
        if (hit) title = hit;
        else notes.push(`${entry.orgKey}: title "${wanted}" is not on the approved list — kept "${entry.title}"`);
      }
    }
    if (title !== entry.title) changed.push(`title:${entry.orgKey}`);
    return { ...entry, title };
  });

  // ── experience: which bullets, in what order ─────────────────────
  if (p.experience && typeof p.experience === 'object') {
    // AN OPTIONAL ORGANISATION THE BASE DOES NOT CARRY MAY STILL BE ASKED FOR.
    // Since 2026-09-15 no family base carries Baja SAE (the Mars Rover Team took
    // its line), but a posting that names a build team still needs it — so a
    // proposal that gives an optional org bullets adds it, from the pool.
    for (const orgKey of OPTIONAL_ORGS) {
      const wanted = p.experience[orgKey];
      const orgEntry = pool.orgs[orgKey];
      if (!orgEntry || !Array.isArray(wanted) || !wanted.length) continue;
      if (spec.experience.some((e) => e.orgKey === orgKey)) continue;
      spec.experience = [...spec.experience, {
        orgKey,
        org: orgEntry.org,
        location: orgEntry.location,
        title: orgEntry.titles?.[base.family] || Object.values(orgEntry.titles || {})[0],
        ...(orgEntry.group ? { group: orgEntry.group } : {}),
        date: orgEntry.date,
        bullets: [],
      }];
      changed.push(`experience:${orgKey}`);
    }
    const next = [];
    let total = 0;
    for (const entry of spec.experience) {
      const orgKey = entry.orgKey;
      const orgEntry = pool.orgs[orgKey];
      const baseKeys = entry.bullets.map((b) => b.provenanceKey.split('.')[1]);
      let keys = Array.isArray(p.experience[orgKey]) ? p.experience[orgKey].map(String) : null;
      if (!keys) { next.push(entry); total += entry.bullets.length; continue; }
      const seen = new Set();
      keys = keys.filter((k) => {
        const key = k.includes('.') ? k.split('.').pop() : k;
        if (!orgEntry.bullets[key]) { notes.push(`${orgKey}: no bullet "${k}" in the pool — dropped`); return false; }
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map((k) => (k.includes('.') ? k.split('.').pop() : k));
      // Staples and the floor for Applied Materials.
      for (const staple of STAPLES) {
        const [o, k] = staple.split('.');
        if (o === orgKey && !keys.includes(k)) { keys.push(k); notes.push(`${staple} is on every resume — restored`); }
      }
      for (const pair of ONE_OF) {
        const here = pair.filter((pk) => pk.startsWith(`${orgKey}.`)).map((pk) => pk.split('.')[1]);
        if (here.length === 2 && keys.includes(here[0]) && keys.includes(here[1])) {
          keys = keys.filter((k) => k !== here[1]);
          notes.push(`${orgKey}: ${here.join(' and ')} describe the same cell — kept ${here[0]}`);
        }
      }
      // THE FLOOR MOVES FOR A REASON, OR IT DOES NOT MOVE.
      //
      // Five Applied Materials bullets is the standing shape. A plan may go to
      // three, but only having said in `whyFewerAmat` what the freed lines
      // prove that AMAT cannot — the argument is recorded in the audit, so a
      // thin AMAT block can always be read back and disagreed with.
      if (orgKey === 'amat') {
        const argued = typeof p.whyFewerAmat === 'string' && p.whyFewerAmat.trim().length >= 20;
        const floor = argued ? MIN_AMAT_JUSTIFIED : MIN_AMAT;
        if (keys.length < floor) {
          for (const k of baseKeys) if (keys.length < floor && !keys.includes(k)) keys.push(k);
          notes.push(`amat: fewer than ${floor} bullets proposed — restored from the family plan`);
        } else if (argued && keys.length < MIN_AMAT) {
          notes.push(`amat: ${keys.length} lines instead of ${MIN_AMAT} — ${p.whyFewerAmat.trim().slice(0, 240)}`);
        }
      }
      if (orgKey !== 'amat' && orgKey !== 'acme') {
        // An org the posting leans on may hold a third line — a build-team
        // requirement is not answered by one line about applying machining
        // skills. It still has to fit the page budget below.
        const emphasised = Array.isArray(p.emphasise) && p.emphasise.map(String).includes(orgKey);
        const cap = emphasised ? MAX_PER_EMPHASISED_ORG : MAX_PER_MINOR_ORG;
        if (keys.length > cap) {
          keys = keys.slice(0, cap);
          notes.push(`${orgKey}: at most ${cap} lines — trimmed`);
        }
      }
      if (!keys.length && OPTIONAL_ORGS.includes(orgKey)) {
        notes.push(`${orgKey}: left off — nothing it proves is not proven more strongly elsewhere`);
        changed.push(`experience:${orgKey}`);
        continue;
      }
      if (!keys.length) { keys = baseKeys.slice(0, 1); notes.push(`${orgKey}: every role stays on the page — restored one line`); }
      if (keys.join() !== baseKeys.join()) changed.push(`experience:${orgKey}`);
      next.push({ ...entry, bullets: keys.map((k) => bulletFor(orgKey, k, orgEntry)) });
      total += keys.length;
    }
    // The page budget: trim the least-protected lines first.
    if (total > MAX_BULLETS) {
      // TRIM WHAT THE POSTING DID NOT ASK FOR FIRST. An org the plan named in
      // `emphasise` is why the page is over budget in the first place; taking
      // its lines back would undo the tailoring the trim is meant to protect.
      const emph = new Set((Array.isArray(p.emphasise) ? p.emphasise : []).map(String));
      const trimOrder = [...TRIM_ORDER].sort((a, b) => (emph.has(a) ? 1 : 0) - (emph.has(b) ? 1 : 0));
      const amatFloor = (typeof p.whyFewerAmat === 'string' && p.whyFewerAmat.trim().length >= 20) ? MIN_AMAT_JUSTIFIED : MIN_AMAT;
      for (const orgKey of trimOrder) {
        const entry = next.find((e) => e.orgKey === orgKey);
        while (entry && total > MAX_BULLETS && entry.bullets.length > (orgKey === 'amat' ? amatFloor : (OPTIONAL_ORGS.includes(orgKey) ? 0 : 1))) {
          const gone = entry.bullets.pop();
          if (STAPLES.includes(gone.provenanceKey)) { entry.bullets.unshift(gone); break; }
          total--;
          notes.push(`over the page budget — dropped ${gone.provenanceKey}`);
        }
      }
    }
    // Acme Steel NEVER SHORTER THAN MAKERSPACE. His order, 2026-09-23: "amat, acme
    // then makerspace then dispensable baja and projects" — he kept seeing Makerspace
    // run longer than Acme Steel. A full engineering internship outranks the campus
    // shop job, so Acme Steel grows while the page has room, and Makerspace gives way
    // once it does not.
    const sc = next.find((e) => e.orgKey === 'acme');
    const hk = next.find((e) => e.orgKey === 'makerspace');
    if (sc && hk) {
      while (hk.bullets.length > sc.bullets.length) {
        const have = new Set(sc.bullets.map((b) => b.provenanceKey));
        const spare = Object.keys(pool.orgs.acme.bullets).find((k) => k !== 'surplus' && !have.has(`acme.${k}`));
        if (spare && total < MAX_BULLETS) {
          sc.bullets.push(bulletFor('acme', spare, pool.orgs.acme));
          total++;
          notes.push(`acme: ${spare} added — Acme Steel never runs shorter than Makerspace`);
        } else if (hk.bullets.length > 1) {
          const gone = hk.bullets.pop();
          total--;
          notes.push(`makerspace: dropped ${gone.provenanceKey} — Acme Steel never runs shorter than Makerspace`);
        } else break;
      }
    }
    spec.experience = next.filter((e) => e.bullets.length > 0);
  }

  // ── projects ─────────────────────────────────────────────────────
  if (Array.isArray(p.projects)) {
    const keys = [...new Set(p.projects.map(String))].filter((k) => {
      if (pool.projects[k]) return true;
      notes.push(`project "${k}" is not in the pool — dropped`);
      return false;
    }).slice(0, 2);
    if (keys.length) {
      spec.projects = keys.map((k) => projectFor(k, pool));
      changed.push('projects');
    } else notes.push('no usable project proposed — kept the family projects');
  }

  // ── coursework ───────────────────────────────────────────────────
  if (Array.isArray(p.coursework)) {
    const known = new Map(pool.education.coursework.map((c) => [norm(c), c]));
    const chosen = [];
    for (const c of p.coursework) {
      const hit = known.get(norm(c));
      if (!hit) { notes.push(`coursework "${c}" is not in cv.md — dropped`); continue; }
      if (!chosen.includes(hit)) chosen.push(hit);
    }
    if (chosen.length >= 4) {
      spec.education = base.education.map((e) => ({
        ...e,
        bullets: e.bullets.map((b) => (b && b.lead === 'Relevant Coursework' ? { ...b, text: chosen.slice(0, 8).join(', ') } : b)),
      }));
      changed.push('coursework');
    } else notes.push('fewer than four usable courses proposed — kept the family coursework');
  }

  // ── skills ───────────────────────────────────────────────────────
  if (Array.isArray(p.skills)) {
    const lines = [];
    for (const entry of p.skills) {
      const key = typeof entry === 'string' ? entry : entry?.key || entry?.category;
      const cat = pool.skills[key] || Object.entries(pool.skills).find(([, v]) => norm(v.lead) === norm(key))?.[1];
      const catKey = pool.skills[key] ? key : Object.entries(pool.skills).find(([, v]) => v === cat)?.[0];
      if (!cat) { notes.push(`skills category "${key}" is not in cv.md — dropped`); continue; }
      const canon = new Map(cat.items.map((i) => [norm(i), i]));
      const items = [];
      for (const it of (typeof entry === 'string' || !Array.isArray(entry.items)) ? cat.items : entry.items) {
        const hit = canon.get(norm(it));
        if (!hit) { notes.push(`skill "${it}" is not in the ${cat.lead} category — dropped`); continue; }
        if (!items.includes(hit)) items.push(hit);
      }
      if (items.length && !lines.some((l) => l.key === catKey)) lines.push({ key: catKey, items });
    }
    if (lines.length >= 2) {
      spec.skills = skillLines(lines.slice(0, 5), pool, 'plan');
      changed.push('skills');
    } else notes.push('fewer than two usable skills lines proposed — kept the family skills');
  }

  spec.order = base.order;
  return { spec, notes, changed };
}

function bulletFor(orgKey, key, orgEntry) {
  const src = orgEntry.bullets[key];
  return {
    // Full wording first; the short form is the fit loop's fallback (see
    // resume-variants.mjs for why).
    text: src.text,
    provenanceKey: `${orgKey}.${key}`,
    source: [src.text, src.short, src.long].filter(Boolean),
    short: src.short || null,
  };
}

/**
 * Before any bullet is dropped for space, one bullet is said in fewer words:
 * the longest bullet still in its full form that has a short form. The claim
 * is the same; only the words go. Returns the key it shortened, or null.
 */
export function shortenOneBullet(spec, protectedPhrases = []) {
  let best = null;
  for (const e of spec.experience) {
    for (const b of e.bullets) {
      // Only a bullet still in its full approved form: a tailored rewrite is
      // kept as written, and a bullet already in its short form has no
      // shorter one.
      if (!b.short || b.text !== (b.source && b.source[0])) continue;
      // …and never the bullet carrying a phrase this posting asked for.
      if (dropsProtected(b.text, b.short, protectedPhrases)) continue;
      if (!best || b.text.length > best.b.text.length) best = { e, b };
    }
  }
  if (!best) return { spec, shortened: null };
  const experience = spec.experience.map((e) => (e === best.e
    ? { ...e, bullets: e.bullets.map((b) => (b === best.b ? { ...b, text: b.short } : b)) }
    : e));
  return { spec: { ...spec, experience }, shortened: best.b.provenanceKey };
}

/**
 * A project line, in its FULL wording.
 *
 * It used to be `p.short || p.text`, unconditionally — so a project that had a
 * short form could never appear in full, and the fit loop had nothing left to
 * spend when the page ran long. On the Applied Intuition posting that cost the
 * one phrase the JD asked for by name: the full robotic-arm sentence ends
 * "...Arduino-based control WITH A SOLDERED WIRE HARNESS", the posting's
 * nice-to-have list reads "designing, drawing, or prototyping custom harness
 * cable", and the page carried the short form that drops the clause (F-436).
 * Nothing squeezed it out. It was never on the page to squeeze.
 *
 * Full text, full lead, with the short form kept beside it for the fit loop —
 * the same shape every experience bullet has had all along.
 */
function projectFor(key, pool) {
  const p = pool.projects[key];
  return {
    key,
    lead: p.lead,
    text: p.text,
    short: p.short || null,
    shortLead: p.shortLead || null,
  };
}

/**
 * Say ONE project in fewer words — the fit loop's cheapest move on a page that
 * runs a line long, and the reason `projectFor` may now print the full text.
 * Never touches a project whose full wording carries a protected phrase.
 */
export function shortenOneProject(spec, protectedPhrases = []) {
  const projects = spec.projects || [];
  for (let i = 0; i < projects.length; i += 1) {
    const p = projects[i];
    if (!p.short || p.text === p.short) continue;
    if (dropsProtected(p.text, p.short, protectedPhrases)) continue;
    const next = projects.map((x, j) => (j === i ? { ...x, text: x.short, lead: x.shortLead || x.lead } : x));
    return { spec: { ...spec, projects: next }, shortened: p.key };
  }
  return { spec, shortened: null };
}

/**
 * Would swapping `full` for `shorter` lose a phrase this posting asked for?
 *
 * The tailorer returns `mustKeep` — phrases out of his own approved wordings
 * that the JD names. Geometry alone used to decide every shortening, so the
 * fit loop could spend exactly the words the page was tailored around. It now
 * shortens something else instead, or drops a line, and says which.
 */
export function dropsProtected(full, shorter, phrases = []) {
  const has = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle || '').toLowerCase());
  for (const phrase of phrases) {
    const ph = String(phrase || '').trim();
    if (ph.length < 3) continue;
    if (has(full, ph) && !has(shorter, ph)) return true;
  }
  return false;
}

/** The phrases a plan asked to protect, reduced to ones his own wordings actually contain. */
export function protectedPhrases(spec, proposed = []) {
  const hay = [
    ...(spec.experience || []).flatMap((e) => (e.bullets || []).flatMap((b) => [b.text, ...(b.source || [])])),
    ...(spec.projects || []).flatMap((p) => [p.text, p.short]),
  ].filter(Boolean).join(' | ').toLowerCase();
  const out = [];
  for (const raw of Array.isArray(proposed) ? proposed : []) {
    const ph = String(raw || '').trim();
    if (ph.length < 3 || ph.length > 80) continue;
    if (!hay.includes(ph.toLowerCase())) continue;   // invented phrases protect nothing
    if (!out.some((x) => x.toLowerCase() === ph.toLowerCase())) out.push(ph);
  }
  return out;
}

/** Bullet keys the plan did not use, for filling a short page — in pool order, protected pairs respected. */
export function reserveFor(spec, pool, proposed = []) {
  const used = new Set(spec.experience.flatMap((e) => e.bullets.map((b) => b.provenanceKey)));
  const out = [];
  const consider = (k) => {
    if (used.has(k) || out.includes(k)) return;
    const [o, b] = k.split('.');
    if (!pool.orgs[o]?.bullets?.[b]) return;
    for (const pair of ONE_OF) if (pair.includes(k) && pair.some((x) => x !== k && used.has(x))) return;
    if (b === 'surplus') return;   // never used — his call, 2026-08-02
    out.push(k);
  };
  for (const k of proposed) consider(String(k));
  // Spare room goes to Acme Steel first, then Applied Materials, then Makerspace, then
  // the clubs — his order, 2026-09-23.
  for (const o of RESERVE_ORDER) for (const b of Object.keys(pool.orgs[o]?.bullets || {})) consider(`${o}.${b}`);
  for (const [o, org] of Object.entries(pool.orgs)) for (const b of Object.keys(org.bullets)) consider(`${o}.${b}`);
  // A Makerspace line never goes in ahead of a Acme Steel line still waiting: the page
  // would print Makerspace longer than Acme Steel, which is the thing he asked to stop.
  const lastAcme = out.findLastIndex((k) => k.startsWith('acme.'));
  if (lastAcme === -1) return out;
  const early = out.slice(0, lastAcme).filter((k) => k.startsWith('makerspace.'));
  const rest = out.filter((k) => !early.includes(k));
  const at = rest.findLastIndex((k) => k.startsWith('acme.')) + 1;
  return [...rest.slice(0, at), ...early, ...rest.slice(at)];
}

/** Add one reserve bullet to the spec (into its org, at the end). */
export function withBullet(spec, key, pool) {
  const [o, b] = key.split('.');
  const orgEntry = pool.orgs[o];
  if (!orgEntry?.bullets?.[b]) return spec;
  return {
    ...spec,
    experience: spec.experience.map((e) => (e.orgKey === o ? { ...e, bullets: [...e.bullets, bulletFor(o, b, orgEntry)] } : e)),
  };
}

/**
 * Say ONE named bullet in its short form — the one whose printed text ends
 * with `ends` (what the orphan check reports). For the family bases, which
 * have no model to reword an orphan tail, the short form is the honest fix:
 * the same claim, fewer words, and usually a line fewer.
 */
export function shortenBulletEnding(spec, ends, protectedPhrases = []) {
  const tail = String(ends || '').trim().slice(-30);
  if (!tail) return { spec, shortened: null };
  for (const e of spec.experience) {
    for (const b of e.bullets) {
      if (!b.short || b.text === b.short || !b.text.trim().endsWith(tail)) continue;
      if (dropsProtected(b.text, b.short, protectedPhrases)) continue;
      const experience = spec.experience.map((x) => (x === e
        ? { ...e, bullets: e.bullets.map((y) => (y === b ? { ...y, text: y.short } : y)) }
        : x));
      return { spec: { ...spec, experience }, shortened: b.provenanceKey };
    }
  }
  // A PROJECT CAN END ON A STUB TOO (2026-09-15). The 6 DOF arm sentence wraps
  // to a third line holding a third of a line; a project with an approved short
  // form takes it, exactly as a bullet does.
  const projects = spec.projects || [];
  for (let i = 0; i < projects.length; i += 1) {
    const p = projects[i];
    if (!p.short || p.text === p.short || !String(p.text).trim().endsWith(tail)) continue;
    if (dropsProtected(p.text, p.short, protectedPhrases)) continue;
    const next = projects.map((x, j) => (j === i ? { ...x, text: x.short, lead: x.shortLead || x.lead } : x));
    return { spec: { ...spec, projects: next }, shortened: p.key || `project:${p.lead}` };
  }
  return { spec, shortened: null };
}

/** Drop the last bullet of the least-protected org that still has one to spare. */
export function withoutOneBullet(spec) {
  for (const orgKey of TRIM_ORDER) {
    const e = spec.experience.find((x) => x.orgKey === orgKey);
    if (!e) continue;
    const floor = orgKey === 'amat' ? MIN_AMAT : (OPTIONAL_ORGS.includes(orgKey) ? 0 : 1);
    if (e.bullets.length <= floor) continue;
    if (e.bullets.length === 1 && floor === 0) {
      // The optional organisation goes whole: a heading with no line under it
      // is not a resume.
      return { spec: { ...spec, experience: spec.experience.filter((x) => x !== e) }, dropped: e.bullets[0].provenanceKey };
    }
    for (let i = e.bullets.length - 1; i >= 0; i--) {
      if (STAPLES.includes(e.bullets[i].provenanceKey)) continue;
      const bullets = e.bullets.filter((_, j) => j !== i);
      return { spec: { ...spec, experience: spec.experience.map((x) => (x === e ? { ...e, bullets } : x)) }, dropped: e.bullets[i].provenanceKey };
    }
  }
  return { spec, dropped: null };
}
