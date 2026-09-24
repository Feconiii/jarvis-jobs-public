// jarvis/resume-variants.mjs — the content plan behind each of the four resumes.
//
// Alex, 2026-08-02: "default to always tailored resume for all roles i apply to
// … automation focused, mechanical focused, manufacturing focused, plus total
// experience — that covers all bases for all the jobs i want."
//
// So the family plan is the BASE a posting's resume starts from. Since
// 2026-09-03 (Alex: "the point is to more aggressively tailor to the jd") the
// per-posting pass in jarvis/resume-for-job.mjs may reorder, reselect and
// regroup on top of it — titles, bullets, projects, coursework, skills — inside
// jarvis/resume-plan.mjs, which refuses anything the pool does not hold. A plan
// says three things and nothing else:
//   1. WHICH internship title to present (from cv.md's approved list — one
//      clean title per internship matched to the role; at Applied Materials
//      itself only the two official ones — see jarvis/resume-plan.mjs).
//   2. WHICH bullets appear, in WHAT order — the lane's work leads, the rest
//      falls away. A mech-design reader sees the fixture and the FEA first; an
//      automation reader sees RoboDK and the AMRs first.
//   3. WHICH skills lead the skills lines, and which coursework is worth the
//      space.
//
// What a plan CANNOT do is write a sentence. Every bullet is a key into
// jarvis/resume-pool.json, whose text is verbatim cv.md. That is the whole
// fabrication guard: tailoring can only ever reorder and select what is already
// true.
//
// BULLET STYLE (Alex, 2026-08-09): plain bullets, no bold lead-in labels.
// Labels like "Inspection Fixture Design:" were measured at 11-13 lines per
// resume — about a quarter of the page — and read as a consulting convention
// rather than a mechanical-engineering one. His own one-pager uses none.
// Do not reintroduce `lead`.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { ALL_FAMILIES, familyByKey } from './resume-family.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POOL_PATH = path.join(HERE, 'resume-pool.json');

export const PROFILE_PATH = path.join(HERE, '..', 'config', 'profile.yml');

/** The placeholder that stands in for his contact block in the tracked pool. */
const CONTACT_PLACEHOLDER = 'from config/profile.yml';

/**
 * His real contact details, from the gitignored profile.
 *
 * `jarvis/resume-pool.json` is TRACKED — it has to be, the bullet pool is
 * checked against cv.md on every build — and it used to carry his phone number
 * and email address in plain text at the top. Everything else personal in this
 * project is gitignored precisely so that does not happen.
 *
 * The pool keeps the placeholder; the real values are overlaid here from
 * `config/profile.yml`, which is gitignored and already held the identical four
 * fields.
 */
export function contactFromProfile(file = PROFILE_PATH) {
  if (!existsSync(file)) return null;
  const doc = yaml.load(readFileSync(file, 'utf-8')) || {};
  const id = doc.candidate || doc.identity || {};
  const out = {};
  for (const k of ['location', 'phone', 'email', 'linkedin']) if (id[k]) out[k] = String(id[k]);
  // His portfolio, 2026-09-19. The key has been in profile.yml since the file
  // was written and was empty until the site went live; `portfolio` is accepted
  // as well so the block reads naturally either way.
  const site = id.portfolio_url || id.portfolio || id.website;
  if (site) out.portfolio = String(site);
  return Object.keys(out).length ? out : null;
}

export function loadPool(file = POOL_PATH) {
  const pool = JSON.parse(readFileSync(file, 'utf-8'));
  const real = contactFromProfile();
  if (real) pool.contact = { ...pool.contact, ...real };
  return pool;
}

/**
 * Would this contact block put a placeholder on a real resume?
 *
 * A resume that reaches an employer carrying "from config/profile.yml" where
 * the phone number goes is worse than no resume at all, so the build refuses
 * rather than rendering one.
 */
export function contactIsUnresolved(contact = {}) {
  return Object.entries(contact)
    .filter(([, v]) => String(v).includes(CONTACT_PLACEHOLDER))
    .map(([k]) => k);
}

/**
 * One plan per family. The page is the budget: roughly eleven or twelve
 * experience bullets, measured not guessed, is what fills one page at the pinned
 * font size (see jarvis/resume.mjs). Add a bullet and something else has to go.
 *
 * WHERE THE BUDGET GOES (Alex, 2026-08-02, after seeing the first cut — "i think
 * you are over specializing… mechanical design is a damn staple"):
 *
 *   - The Applied Materials internship is the strongest thing on the page.
 *     Preserve as much of it as fits: FIVE or SIX of its six bullets on every
 *     resume, not four.
 *   - `vision-fixture` (the Inventor inspection fixture) and `neuro-t` (the
 *     machine-vision model) appear on EVERY resume, whatever the lane. Mechanical
 *     design is a staple, not a specialisation — dropping the fixture from an
 *     automation or manufacturing resume was over-specialising. Pinned in
 *     jarvis/resume-variants.test.mjs.
 *   - What pays for that: Acme Steel `surplus` (never used), Makerspace trimmed to ONE
 *     line, SAE trimmed to ONE line. Since 2026-09-15 the Mars Rover Team holds
 *     SAE's place on every base (his call: it reads better than Baja for
 *     robotics), and one Acme Steel line per family paid for its longer bullets. His call: "you can truncate acme surplus
 *     and makerspace machine shop".
 *   - `amr` is the single allowed omission, and only on the mechanical resume —
 *     his words, "not very technical" for a design reader.
 */
export const PLANS = {
  // The all-rounder, and the closest thing to the resume he wrote himself
  // (AlexRiveraResumeTotalExperience.docx). Alex, 2026-09-15, on the previous cut:
  // "so thin and missing so much stuff … a mix of robotics and automation and
  // mechanical design … but skew it towards robotics a lil bit, so if there is
  // space do the robot club."
  //
  // So: breadth, but not neutral breadth. The fixture still opens — it is the
  // strongest single thing he has done and a design reader needs it first — and
  // the three robot bullets follow it before the vision and logging work. The
  // titles this base already carried are the ones he asked for by name
  // (Applied Materials → Mechanical Engineer Intern, Acme Steel → Manufacturing
  // Engineer Intern); they are in the pool, not here.
  'total-experience': {
    // Controls and instrumentation in place of the thermal-fluids run: this
    // page argues robots and machines, and those three courses argue neither.
    coursework: ['Mechanical Design', 'Machine Design', 'System Dynamics and Control', 'Instrumentation Systems', 'Manufacturing Processes', 'Finite Element Analysis'],
    // What fills a half-used coursework line when no posting says otherwise (2026-09-23).
    courseworkFill: ['Mechanics of Materials', 'Circuit Analysis', 'Python Programming', 'Vibration Engineering', 'Thermodynamics', 'Heat Transfer', 'Fluid Mechanics'],
    experience: [
      { org: 'amat', bullets: ['vision-fixture', 'robodk', 'cobot-rack', 'neuro-t', 'amr', 'iiot'] },
      // `plant-layout` bought the rover's second line (2026-09-15). The AutoCAD
      // plant map is a real manufacturing win, but it is the one bullet here
      // that argues neither robotics nor mechanical design, and the robotic
      // assembly line and the $57,000 macro keep Acme Steel's case on the page.
      { org: 'acme', bullets: ['robotic-line', 'coil-savings'] },
      { org: 'makerspace', bullets: ['fabrication'] },
      // Both rover bullets — the skew he asked for. The gripper is manipulator
      // design and the suspension plates are CAD through plasma-cut parts, so
      // the club carries robotics AND fabrication evidence in two lines.
      { org: 'rover', bullets: ['gripper', 'suspension'] },
    ],
    projects: ['robotic-arm', 'piston-fea'],
    // WHAT FILLS THE PAGE WHEN THE SKILLS LIST NO LONGER DOES (2026-09-22).
    //
    // Capping SKILLS at two printed lines took roughly four lines off every
    // base, and the sheet came back 0.65-0.75in short at the bottom against a
    // 0.6in limit — his own fill rule failing because of his own skills rule.
    // Base builds passed `reserve: []`, so the polish loop had nothing to put
    // there and simply reported the gap.
    //
    // These are real bullets already in the pool and already used on other
    // lanes — never SAE, which has never printed on any resume and is not
    // going to make its debut as filler. A skills LIST earns less of the page
    // than a bullet carrying evidence, which is the whole of his instruction.
    // Added one at a time, only while the page is short, and only if it does
    // not spill.
    reserve: ['acme.plant-layout', 'acme.docs', 'makerspace.production'],
    // Skills are the pool's categories (cv.md § Skills, Alex 2026-09-03), in
    // the order this lane reads them. A category left out here is still
    // available to the per-posting plan. Automation leads for the same skew;
    // CAD is immediately behind it, because mechanical design is a staple here.
    skills: ['automation', 'cad', 'manufacturing', 'process'],
  },

  // Robots, cells, vision, controls. Leads with the work that moved a machine —
  // and still carries the fixture design, because the cell it inspects is a
  // mechanical object and an automation reader knows it.
  automation: {
    coursework: ['Mechanical Design', 'Machine Design', 'System Dynamics and Control', 'Circuit Analysis', 'Python Programming', 'Instrumentation Systems'],
    // What fills a half-used coursework line when no posting says otherwise (2026-09-23).
    courseworkFill: ['Manufacturing Processes', 'Finite Element Analysis', 'Mechanics of Materials', 'Vibration Engineering', 'Thermodynamics', 'Heat Transfer', 'Fluid Mechanics'],
    experience: [
      // FIVE OF SIX, NOT FOUR, AND NEVER WITHOUT THE VISION MODEL.
      //
      // The first cut here went to 3-4 and dropped `neuro-t`. That contradicted
      // two things he said on 2026-08-02 and the guards that quote him:
      //   "i would like to preserve as much of the applied materials
      //    experience as possible"            -> five of six is the floor
      //   "mechanical design is a damn staple … i like the vision thing too"
      //                                       -> fixture AND vision model, every lane
      //
      // His 2026-09-22 instruction is about excess, not about deleting Applied
      // Materials, so the older specific rule wins over my reading of the newer
      // general one. Five is a real cut — every lane printed all six, which is
      // why 68% of every page was identical — while staying inside his floor.
      // Dropped here: `cobot-rack`, a storage rack for end effectors — the
      // least of the six for a reader hiring someone to make machines run.
      { org: 'amat', bullets: ['robodk', 'neuro-t', 'amr', 'vision-fixture', 'iiot'] },
      {
        org: 'acme',
        // `docs` went to make room for BOTH rover lines (2026-09-15): on the
        // robotics resume the rover gripper and the suspension plates are worth
        // more than the roll-forming troubleshooting guides.
        bullets: [
          'robotic-line',
          'coil-savings',
        ],
      },
      { org: 'makerspace', bullets: ['fabrication'] },
      { org: 'rover', bullets: ['gripper', 'suspension'] },
    ],
    projects: ['robotic-arm', 'piston-fea'],
    // WHAT FILLS THE PAGE WHEN THE SKILLS LIST NO LONGER DOES (2026-09-22).
    //
    // Capping SKILLS at two printed lines took roughly four lines off every
    // base, and the sheet came back 0.65-0.75in short at the bottom against a
    // 0.6in limit — his own fill rule failing because of his own skills rule.
    // Base builds passed `reserve: []`, so the polish loop had nothing to put
    // there and simply reported the gap.
    //
    // These are real bullets already in the pool and already used on other
    // lanes — never SAE, which has never printed on any resume and is not
    // going to make its debut as filler. A skills LIST earns less of the page
    // than a bullet carrying evidence, which is the whole of his instruction.
    // Added one at a time, only while the page is short, and only if it does
    // not spill.
    // `amat.cobot-install` is NOT here, though it reads as the obvious
    // automation reserve: this lane already prints `amat.robodk`, and the two
    // are the same UR leak-test cell. It was here, the page came up short after
    // the SKILLS cap, and the built base described that cell twice — caught by
    // a cold read on 2026-09-22, and exactly what he objected to on 2026-08-09.
    reserve: ['acme.plant-layout', 'acme.docs', 'makerspace.production'],
    skills: ['automation', 'cad', 'process', 'manufacturing'],
  },

  // Process, production, NPI — and the test / quality / metrology postings that
  // used to have their own family. Leads with money saved and records replaced.
  manufacturing: {
    coursework: ['Manufacturing Processes', 'Machine Design', 'Mechanical Design', 'Mechanics of Materials', 'Thermodynamics', 'Finite Element Analysis'],
    // What fills a half-used coursework line when no posting says otherwise (2026-09-23).
    courseworkFill: ['Instrumentation Systems', 'Python Programming', 'Heat Transfer', 'Fluid Mechanics', 'System Dynamics and Control', 'Circuit Analysis', 'Vibration Engineering'],
    experience: [
      {
        org: 'amat',
        // FIVE OF SIX (2026-09-22) — see the note in the automation lane.
        // Dropped: `cobot-rack`. `neuro-t` stays: he called the vision work a
        // staple by name, and an inspection story without its model is half a
        // story to a manufacturing reader too.
        bullets: [
          'iiot',
          'vision-fixture',
          'amr',
          'neuro-t',
          'robodk',
        ],
      },
      // AND THE PACKAGING BULLET COMES BACK (2026-09-22).
      //
      // The note that stood here said it "gives way to keep all six AMAT
      // bullets". Dropping the sixth AMAT bullet is exactly what freed its line
      // again, so it returns to the lane it was always right for: cutting
      // packaging lumber inventory 36% is a manufacturing result, and it is a
      // SECOND employer saying he improves a process — which a reader weighs
      // more than a sixth sentence about the first.
      //
      // `plant-layout` gave its line to the rover suspension plates (2026-09-15),
      // designed in CAD and plasma-cut in-house — fabrication evidence this lane reads.
      { org: 'acme', bullets: ['coil-savings', 'robotic-line', 'packaging'] },
      { org: 'makerspace', bullets: ['production'] },
      { org: 'rover', bullets: ['suspension'] },
    ],
    projects: ['cnc-cardholder', 'robotic-arm'],
    // WHAT FILLS THE PAGE WHEN THE SKILLS LIST NO LONGER DOES (2026-09-22).
    //
    // Capping SKILLS at two printed lines took roughly four lines off every
    // base, and the sheet came back 0.65-0.75in short at the bottom against a
    // 0.6in limit — his own fill rule failing because of his own skills rule.
    // Base builds passed `reserve: []`, so the polish loop had nothing to put
    // there and simply reported the gap.
    //
    // These are real bullets already in the pool and already used on other
    // lanes — never SAE, which has never printed on any resume and is not
    // going to make its debut as filler. A skills LIST earns less of the page
    // than a bullet carrying evidence, which is the whole of his instruction.
    // Added one at a time, only while the page is short, and only if it does
    // not spill.
    reserve: ['acme.docs', 'acme.plant-layout', 'makerspace.fabrication'],
    skills: ['process', 'manufacturing', 'cad', 'automation'],
  },

  // CAD, tolerance, structures. Leads with things he drew and analysed.
  //
  // `amr` is back (Alex, 2026-08-09). It was dropped here as "not very
  // technical" for a design reader, and `cobot-install` took the slot — but
  // cobot-install and robodk describe the SAME UR leak-test cell, so the page
  // said it twice: "translating RoboDK simulations into physical hardware" and
  // "validated a Universal Robots collaborative robot in RoboDK". His words:
  // "in reality its only one thing, the din rail stuff is just fluff for
  // installation". His own one-pager carries robodk and not cobot-install.
  mechanical: {
    coursework: ['Mechanical Design', 'Machine Design', 'Mechanics of Materials', 'Finite Element Analysis', 'Vibration Engineering', 'Heat Transfer'],
    // What fills a half-used coursework line when no posting says otherwise (2026-09-23).
    courseworkFill: ['Thermodynamics', 'Fluid Mechanics', 'Manufacturing Processes', 'System Dynamics and Control', 'Instrumentation Systems', 'Python Programming', 'Circuit Analysis'],
    experience: [
      {
        org: 'amat',
        // FIVE OF SIX (2026-09-22) — see the note in the automation lane.
        // Dropped: `iiot`, instrument integration and data logging — real work,
        // and the least of the six for a reader whose question is what he drew
        // and analysed. The fixture, the rack and the vision model all stay.
        bullets: [
          'vision-fixture',
          'cobot-rack',
          'amr',
          'robodk',
          'neuro-t',
        ],
      },
      {
        org: 'acme',
        bullets: [
          'plant-layout',
          'coil-savings',
          'robotic-line',
          // `docs` gave its line to the rover gripper (2026-09-15).
        ],
      },
      // `production` over `prototypes` for this lane. Both are true and both
      // are one line, but mechanical-design JDs routinely ask for procurement
      // and sourcing of critical parts — Applied's own new-grad ME posting
      // does — and `production` is the only bullet in the pool that covers it
      // ("material procurement, CNC program prove-outs, and final
      // inspections"). `prototypes` says SolidWorks-to-part, which the AMAT
      // fixture bullet and the Makerspace fabrication work already establish twice
      // over. Same line count, one more requirement answered.
      { org: 'makerspace', bullets: ['production'] },
      { org: 'rover', bullets: ['gripper'] },
    ],
    projects: ['piston-fea', 'robotic-arm'],
    // WHAT FILLS THE PAGE WHEN THE SKILLS LIST NO LONGER DOES (2026-09-22).
    //
    // Capping SKILLS at two printed lines took roughly four lines off every
    // base, and the sheet came back 0.65-0.75in short at the bottom against a
    // 0.6in limit — his own fill rule failing because of his own skills rule.
    // Base builds passed `reserve: []`, so the polish loop had nothing to put
    // there and simply reported the gap.
    //
    // These are real bullets already in the pool and already used on other
    // lanes — never SAE, which has never printed on any resume and is not
    // going to make its debut as filler. A skills LIST earns less of the page
    // than a bullet carrying evidence, which is the whole of his instruction.
    // Added one at a time, only while the page is short, and only if it does
    // not spill.
    reserve: ['acme.docs', 'makerspace.fabrication', 'rover.suspension'],
    skills: ['cad', 'manufacturing', 'automation', 'process'],
  },
};

/** Student resume: education first. Same for every family — he is a 2027 grad. */
const SECTION_ORDER = ['education', 'experience', 'projects', 'skills'];

const fail = (msg) => { throw new Error(msg); };

/**
 * Turn a family key + the pool into a render-ready spec for jarvis/resume.mjs.
 * Throws on any key the pool does not define, so a typo can never silently drop
 * a bullet (or, worse, a whole job) off a resume that then goes out.
 */
export function buildSpec(familyKey, pool = loadPool()) {
  const family = familyByKey(familyKey) || fail(`unknown resume family "${familyKey}" — known: ${ALL_FAMILIES.map(f => f.key).join(', ')}`);
  const plan = PLANS[family.key] || fail(`no content plan for family "${family.key}" — add one to PLANS`);

  const edu = pool.education;
  const known = new Set(edu.coursework);
  for (const c of [...plan.coursework, ...(plan.courseworkFill || [])]) if (!known.has(c)) fail(`${family.key}: coursework "${c}" is not in the pool (and therefore not in cv.md)`);

  const experience = plan.experience.map(({ org: orgKey, bullets }) => {
    const org = pool.orgs[orgKey] || fail(`${family.key}: unknown org "${orgKey}"`);
    const title = org.titles[family.key] || fail(`${family.key}: org "${orgKey}" has no approved title for this family`);
    return {
      orgKey,
      org: org.org,
      location: org.location,
      title,
      // The team, printed after the title on the same line ("Manufacturing
      // Engineer Intern | Automation Technology Group" — Alex, 2026-09-03).
      // Kept apart from the title so the application form's job-title field
      // gets the title alone.
      ...(org.group ? { group: org.group } : {}),
      date: org.date,
      bullets: bullets.map((b) => {
        const key = typeof b === 'string' ? b : b.key;
        const src = org.bullets[key] || fail(`${family.key}: unknown bullet "${orgKey}.${key}"`);
        // EXPERIENCE bullets are plain — the pool still carries a `lead` label
        // per bullet, but it is deliberately not rendered (Alex, 2026-08-09).
        // Measured, those labels cost 11-13 lines per resume, roughly a
        // quarter of the page, and read as a consulting convention rather than
        // a mechanical-engineering one. Section labels ("Technical:",
        // "Relevant Coursework:") and PROJECT names keep theirs — his own
        // one-pager has those and not these.
        // Prefer the SHORT form when the pool has one. That is what it is for:
        // all four resumes sit at ~99% page fill, and the tighter sentence is
        // the same claim in fewer words (traced to cv-short.md by the build
        // guard). Shorter lines are also the main cure for orphan tails.
        // PROVENANCE travels with the bullet. jarvis/resume-tailor.mjs keys every
        // rewrite by this string, so a tailored sentence can only ever land on
        // the bullet it was written for, and it carries both approved forms of
        // the sentence as the source a rewrite is checked against.
        // THE FULL WORDING BY DEFAULT (2026-09-05, ChatGPT's review of the 1X
        // resume): the short form dropped "SolidWorks CAD drawings", "TIG" and
        // "rapid prototyping" from the Makerspace line to save a few words, and a
        // resume that simplifies its own evidence reads as generic. The short
        // form is now what the FIT LOOP falls back to when the page spills —
        // one bullet at a time, before any bullet is dropped — never the start.
        // A `long` form (the fixture bullet with its drawings, BOM, supplier
        // and Teamcenter facts inside it) is a further approved wording the
        // tailor may choose when the posting asks for that work.
        return {
          text: src.text,
          provenanceKey: `${orgKey}.${key}`,
          source: [src.text, src.short, src.long].filter(Boolean),
          short: src.short || null,
        };
      }),
    };
  });

  const projects = plan.projects.map((k) => {
    const p = pool.projects[k] || fail(`${family.key}: unknown project "${k}"`);
    // Same rule as experience bullets: prefer the short form when the pool has
    // one. The robotic-arm project wrapped to a third line holding the single
    // word "positioning." — Alex's own one-pager says it 29 characters shorter
    // and titles it "Robotic Arm", which fits.
    return { key: k, lead: p.lead, text: p.text, short: p.short || null, shortLead: p.shortLead || null };
  });

  const skills = skillLines(plan.skills, pool, family.key);

  return {
    _comment: `GENERATED by jarvis/build-resumes.mjs — edit jarvis/resume-variants.mjs (plan) or jarvis/resume-pool.json (text), never this file.`,
    name: pool.name,
    variant: family.variant,
    family: family.key,
    familyLabel: family.label,
    order: plan.order || SECTION_ORDER,
    courseworkFill: plan.courseworkFill || [],
    contact: pool.contact,
    // NO AVAILABILITY OR RELOCATION LINE. It was added 2026-09-22 and he took it
    // off the next day: "unecessary those are asked in posting already, too
    // much clutter". The graduation date in EDUCATION carries the start date.
    education: [{
      school: edu.school,
      location: edu.location,
      degree: edu.degree,
      date: edu.date,
      bullets: [
        edu.gpa,
        edu.honors,
        { lead: 'Relevant Coursework', text: plan.coursework.join(', ') },
      ],
    }],
    experience,
    projects,
    skills,
  };
}

/**
 * Skills lines from a plan. A plan names categories from cv.md § Skills, as
 * keys (`['cad', 'process']`, every item in the category's pool order) or as
 * `{ key, items }` (a per-posting plan reordering or trimming a category to the
 * job). Items must be the category's own — a skill the pool does not hold
 * fails here, whoever proposed it.
 */
export function skillLines(planSkills, pool, familyKey = 'plan') {
  const list = Array.isArray(planSkills)
    ? planSkills
    : Object.entries(planSkills || {}).map(([key, items]) => ({ key, items }));
  return list.map((entry) => {
    const key = typeof entry === 'string' ? entry : entry.key;
    const line = pool.skills[key] || fail(`${familyKey}: unknown skills category "${key}"`);
    const items = (typeof entry === 'string' || !entry.items) ? line.items : entry.items;
    const pooled = new Set(line.items);
    for (const item of items) if (!pooled.has(item)) fail(`${familyKey}: skill "${item}" is not in the pool category "${key}"`);
    if (!items.length) fail(`${familyKey}: skills category "${key}" has no items`);
    return { key, lead: line.lead, text: items.join(', ') };
  });
}

/**
 * THE FABRICATION GUARD. Every sentence, title, course and skill in the pool
 * must be findable in cv.md. Punctuation and casing are ignored (the renderer
 * and cv.md differ on dashes and lead-in colons); words are not — a number, a
 * tool name or a job title that cv.md does not contain fails the build.
 *
 * Returns a list of human-readable problems; empty means clean.
 */
export function verifyPoolAgainstCv(
  pool = loadPool(),
  cvPath = path.join(HERE, '..', 'cv.md'),
  shortPath = path.join(HERE, '..', 'cv-short.md'),
) {
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const cv = flat(readFileSync(cvPath, 'utf-8'));
  // The short-form master (Alex's own one-page resume). A `short` bullet is a
  // DIFFERENT sentence about the same work, so it cannot trace to cv.md — it
  // traces here instead. Both files are written by him; neither is generated.
  let cvShort = '';
  try { cvShort = flat(readFileSync(shortPath, 'utf-8')); } catch { /* optional */ }
  const problems = [];
  const check = (what, value) => { if (value && !cv.includes(flat(value))) problems.push(`${what} is not in cv.md: "${String(value).slice(0, 90)}"`); };
  const checkShort = (what, value) => {
    if (!value) return;
    if (!cvShort) { problems.push(`${what} has a short variant but cv-short.md is missing`); return; }
    if (!cvShort.includes(flat(value))) problems.push(`${what} short form is not in cv-short.md: "${String(value).slice(0, 90)}"`);
  };

  const edu = pool.education || {};
  check('education.gpa', `${edu.gpa?.lead} ${edu.gpa?.text}`);
  check('education.honors', `${edu.honors?.lead} ${edu.honors?.text}`);
  for (const c of edu.coursework || []) check('coursework', c);

  for (const [orgKey, org] of Object.entries(pool.orgs || {})) {
    check(`${orgKey}.org`, org.org);
    check(`${orgKey}.date`, org.date);
    check(`${orgKey}.group`, org.group);
    // The approved-title list in cv.md is the ONLY place a title may come from.
    for (const [fam, title] of Object.entries(org.titles || {})) check(`${orgKey}.titles.${fam}`, title);
    for (const title of org.approvedTitles || []) check(`${orgKey}.approvedTitles`, title);
    for (const [role, title] of Object.entries(org.atOwnCompany || {})) check(`${orgKey}.atOwnCompany.${role}`, title);
    for (const [k, b] of Object.entries(org.bullets || {})) {
      check(`${orgKey}.${k}`, b.text);
      checkShort(`${orgKey}.${k}`, b.short);
      check(`${orgKey}.${k} long form`, b.long);
    }
  }
  for (const [k, p] of Object.entries(pool.projects || {})) {
    check(`project.${k}`, `${p.lead} ${p.text}`);
    checkShort(`project.${k}`, p.short);
    checkShort(`project.${k}.lead`, p.shortLead);
  }
  for (const [k, line] of Object.entries(pool.skills || {})) {
    check(`skills.${k}.lead`, line.lead);
    for (const item of line.items || []) check(`skills.${k}`, item);
  }

  return problems;
}

/**
 * The job titles this family presents, keyed by company — so the application
 * FORM says exactly what the attached resume says. A resume claiming
 * "Automation Engineer Intern" next to a work-history field saying
 * "Manufacturing Engineer Intern" is the one inconsistency a recruiter is
 * guaranteed to notice, because the ATS shows them on the same screen.
 */
export function titlesForFamily(familyKey, pool = loadPool()) {
  const family = familyByKey(familyKey);
  if (!family) return new Map();
  const out = new Map();
  for (const org of Object.values(pool.orgs)) {
    const title = org.titles?.[family.key];
    if (title) out.set(org.org, title);
  }
  return out;
}

/**
 * The titles a BUILT spec presents, keyed by company — the per-posting plan may
 * have chosen differently from the family default, and the form must say what
 * that PDF says.
 */
export function titlesFromSpec(spec) {
  const out = new Map();
  for (const e of spec?.experience || []) if (e.org && e.title) out.set(e.org, e.title);
  return out;
}

/** Normalise a company name for matching across "–"/"-" and casing drift. */
export function companyKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Rewrite a profile's work_experience titles to the family's titles. Returns the
 * profile unchanged when nothing matches, so a company not in the pool (or a
 * profile without work history) is never mangled.
 */
export function applyFamilyTitles(profile, familyKey, pool = loadPool()) {
  return applyTitles(profile, titlesForFamily(familyKey, pool));
}

/** The same rewrite from an explicit company → title map (a built spec's titles). */
export function applyTitles(profile, titles) {
  if (!titles?.size || !Array.isArray(profile?.work_experience)) return { profile, changed: [] };
  const byKey = new Map([...titles].map(([company, title]) => [companyKey(company), title]));
  const changed = [];
  const work_experience = profile.work_experience.map((e) => {
    const title = byKey.get(companyKey(e?.company));
    if (!title || title === e.title) return e;
    changed.push({ company: e.company, from: e.title, to: title });
    return { ...e, title };
  });
  return { profile: { ...profile, work_experience }, changed };
}

// ── the three per lane ──────────────────────────────────────────────
//
// His ask, 2026-09-22: "make 3 ultra good resumes for each family and keep them
// there from now on".
//
// THE AXIS IS MEASURED, NOT INVENTED. Across the 29 builds audited that day, the
// thing that actually varied between postings was not the job — every lane sent
// nearly the same page — it was how much the POSTING already knew it wanted.
// Atomic Semi's description named 20 concrete requirements. ASML's named 3, and
// 33 of that resume's terms had no counterpart anywhere in it. One page cannot
// be right for both readers:
//
//   a requirement-dense posting is read by someone who will check specifics,
//   and rewards depth — fewer claims, each at its full wording;
//
//   a thin posting is read by someone deciding whether this person is roughly
//   the right shape, and rewards breadth — more employers, more ground covered.
//
// So each lane builds three: the balanced base that apply-time routing already
// uses, plus Depth and Breadth. Same facts, same pool, same guards — only the
// selection differs, which is the whole argument of the audit.
export const VARIANTS = [
  {
    key: 'base',
    label: '',
    what: 'balanced — the one apply-time routing picks',
    transform: (spec) => spec,
  },
  {
    key: 'depth',
    label: 'Depth',
    what: 'fewer claims, every one at full wording — for a technical reader and a requirement-dense posting',
    transform: (spec) => {
      // Drop the two lowest-priority bullets — the plan lists each org in
      // priority order, so the tail of the LONGEST org is the least load-bearing
      // thing on the page. Never below two bullets for an employer: one line
      // makes a job look like a footnote.
      const out = { ...spec, experience: spec.experience.map((e) => ({ ...e, bullets: [...e.bullets] })) };
      for (let i = 0; i < 2; i += 1) {
        const longest = [...out.experience].sort((a, b) => b.bullets.length - a.bullets.length)[0];
        if (!longest || longest.bullets.length <= 2) break;
        longest.bullets.pop();
      }
      // THE SHORT FORMS STAY AVAILABLE, even though this variant is about full
      // wording. Stripping them made all four Depth builds fail "No tiny final
      // bullet fragments": the fit loop's cure for a stub last line IS the
      // short form, and with none to reach for it had nothing to do. The pool
      // already prefers the full wording by default, so dropping two bullets is
      // what makes this variant deeper — removing the fallback only removed the
      // page's ability to tidy itself.
      return out;
    },
  },
  {
    key: 'breadth',
    label: 'Breadth',
    what: 'more employers and more ground covered — for a recruiter screen and a thin posting',
    transform: (spec, { plan, pool }) => {
      // Spend the lane's reserve up front rather than leaving it to the fit
      // loop. These are real bullets from the pool, already printed on other
      // lanes; here they buy a second and third employer more of the page.
      const out = { ...spec, experience: spec.experience.map((e) => ({ ...e, bullets: [...e.bullets] })) };
      for (const key of (plan.reserve || [])) {
        const [orgKey, bulletKey] = String(key).split('.');
        const row = out.experience.find((e) => e.orgKey === orgKey);
        const src = pool.orgs?.[orgKey]?.bullets?.[bulletKey];
        if (!row || !src) continue;
        if (row.bullets.some((b) => b.provenanceKey === key)) continue;
        row.bullets.push({ text: src.text, ...(src.short ? { short: src.short } : {}), provenanceKey: key, source: src.source });
      }
      return out;
    },
  },
];

/** One lane's spec under one variant. Everything else about the build is shared. */
export function buildVariantSpec(familyKey, variantKey, pool = loadPool()) {
  const variant = VARIANTS.find((v) => v.key === variantKey) || VARIANTS[0];
  const plan = PLANS[familyKey] || fail(`unknown family "${familyKey}"`);
  return variant.transform(buildSpec(familyKey, pool), { plan, pool });
}
