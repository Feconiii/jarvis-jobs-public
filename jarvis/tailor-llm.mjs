/**
 * The part Simplify cannot have: a model with his actual CV in front of it,
 * deciding what goes on the page for ONE posting and how to say it in that
 * posting's language.
 *
 * This file only ASKS. Everything it gets back goes through
 * jarvis/resume-plan.mjs (what is on the page) and jarvis/resume-tailor.mjs
 * (how each bullet is worded) before it can reach a PDF, and anything that
 * fails is replaced by the family default. So the worst case here is a less
 * tailored resume, never a false one — which is why this module is allowed to
 * fail quietly and the guards are not.
 *
 * The rules in the prompt are Alex's resume-tailoring skill (2026-09-03),
 * absorbed: relevance per line, truthful stretching inside the approved
 * vocabulary, one clean title per internship, Applied Materials' own title
 * rule, strong verbs, role-specific emphasis, and the list of things that
 * are never claimed. jarvis/RESUME-RULES.md is the readable copy.
 *
 * It shells the local `claude` CLI rather than calling an API: no key to store,
 * no network client to maintain, and it runs under the same account and the same
 * source-of-truth rules as the rest of the project.
 */
import { coverage as termCoverage } from './jd-terms.mjs';
import { requirementLines } from './jd-checklist.mjs';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { person, writing, PRESETS, WORK_AUTH } from './targeting.mjs';

// ── who the writers are writing for ─────────────────────────────────
//
// Every writer (resume tailor, cover letter, application answers, outreach,
// lead research) imports from here, so the identity helpers live here too.
// The rule they serve: one person's facts never reach another person's prompt.

/**
 * True when the installed person is the one whose sent answers, letters and
 * stories the prompts quote as worked examples (`writing.examplesOwner`). Only
 * then do those examples appear; for anyone else the prompt is built from the
 * field wording in their preset and their own files.
 */
export function ownsExamples(p = person) {
  const w = PRESETS[p?.preset]?.writing || writing;
  return !!(w?.examplesOwner && p?.fullName === w.examplesOwner);
}

/** The writing preset for a person (their own preset, not the installed one). */
export const writingFor = (p = person) => PRESETS[p?.preset]?.writing || writing;

/**
 * Graduation, said truthfully on any date: "graduating May 2027" while it is
 * ahead, "graduated May 2026" once that month has passed.
 */
export function graduation(p = person, now = new Date()) {
  const g = p?.gradDate || {};
  const done = (Number(g.year) * 12 + Number(g.month)) < (now.getFullYear() * 12 + now.getMonth() + 1);
  const label = p?.gradLabel || '';
  return { done, label, says: label ? `${done ? 'graduated' : 'graduating'} ${label}` : '' };
}

/** "Lakeside University" → "Lakeside". */
export function schoolShort(p = person) {
  const s = String(p?.school || '').trim();
  return s.replace(/\s+(university|college)$/i, '').replace(/^(the\s+)?university\s+of\s+/i, '').trim() || s;
}

/**
 * One sentence of who the person is, from their profile alone:
 * "Test Analyst is a Finance student at Example State University, graduated May 2026."
 */
export function personLine(p = person, now = new Date()) {
  const g = graduation(p, now);
  const study = p?.major ? `${p.major} ${g.done ? 'graduate' : 'student'}` : (g.done ? 'recent graduate' : 'student');
  const school = p?.school ? ` ${g.done ? 'of' : 'at'} ${p.school}` : '';
  const when = !g.label ? '' : g.done ? ` (${g.label})` : `, ${g.says}`;
  return `${p?.fullName || 'The applicant'} is a ${study}${school}${when}.`;
}

/** Work authorization in plain words, for a prompt that needs it. */
export const authLine = (p = person) => WORK_AUTH[p?.workAuth]?.label || '';

/** Long enough to be a real posting, short enough not to blow the prompt. */
export const MAX_JD_CHARS = 7000;

/**
 * Squeeze a posting to fit, dropping only what nobody writes towards: EEO and
 * accommodation statements, pay and benefits packages, privacy and legal text.
 *
 * AUDITED 2026-09-17 on the 87 postings on his board. The first version
 * dropped any line containing "benefits", "about us" or "our culture" — which
 * took OpenAI's mission ("…intelligence benefits all of humanity"), Applied
 * Materials' "Who We Are" and Amazon's team description — and then cut the
 * text off at the limit, which on 9 of the 17 long postings removed the
 * requirements or the team paragraph at the end (Amazon Robotics Systems
 * Engineer lost up to 3,885 characters). Company, team, culture and
 * requirements are exactly what an application answer is written towards.
 *
 * Now: boilerplate LINES go first (matched on legal and package phrasing, not
 * on single words); if it is still too long, the middle is thinned, keeping the
 * opening (company, team, role) and the end (requirements), never a blind cut
 * off the tail.
 */
const JD_BOILERPLATE = /equal (?:employment )?opportunity|\beeo\b|affirmative action|reasonable accommodation|without regard to (?:race|sex|age)|veteran status|disability status|protected (?:veteran|class|characteristic)|e-?verify|pay transparency|(?:base )?(?:salary|pay|compensation) range|\b401\(?k\)?|medical, dental|dental(?:,| and) vision|paid time off|benefits (?:include|package|may include)|sign-?on (?:bonus|payments?)|restricted stock units|privacy (?:notice|policy)|recruitment fraud|export control(?:led)? regulations? require|background check/i;
export function condenseJd(description, limit = MAX_JD_CHARS) {
  const text = String(description || '').replace(/\r/g, '');
  if (text.length <= limit) return text.trim();
  const kept = text.split('\n').filter((l) => !JD_BOILERPLATE.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (kept.length <= limit) return kept;
  const head = Math.floor(limit * 0.55);
  const tail = limit - head - 20;
  return `${kept.slice(0, head).trim()}\n[…]\n${kept.slice(-tail).trim()}`;
}

/**
 * Role-specific emphasis, from his skill (§19). Handed to the model whole so it
 * can decide which applies; the plan checker does not care which it picked.
 * Per field: `writing.roleEmphasis` in the preset.
 */
export const ROLE_EMPHASIS = writing.roleEmphasis || {};

/** The menu: everything the resume may contain, keyed the way the answer must be keyed. */
export function menuFor(pool) {
  const orgs = {};
  for (const [k, org] of Object.entries(pool.orgs || {})) {
    const bullets = {};
    for (const [bk, b] of Object.entries(org.bullets || {})) {
      if (bk === 'surplus') continue;   // never used — his call, 2026-08-02
      bullets[bk] = b.short ? { text: b.text, short: b.short } : { text: b.text };
    }
    orgs[k] = {
      org: org.org,
      ...(org.group ? { group: org.group } : {}),
      titles: org.approvedTitles || [...new Set(Object.values(org.titles || {}))],
      ...(org.atOwnCompany ? { whenApplyingToThisCompany: org.atOwnCompany } : {}),
      bullets,
    };
  }
  const projects = {};
  // BOTH WORDINGS, like every experience bullet. The menu used to carry only
  // the short form, so a phrase that lives in the full text — "with a soldered
  // wire harness" — could not be chosen, protected or even seen (F-436).
  for (const [k, p] of Object.entries(pool.projects || {})) {
    projects[k] = p.short && p.short !== p.text
      ? { name: p.lead, text: p.text, short: p.short }
      : { name: p.lead, text: p.text };
  }
  const skills = {};
  for (const [k, line] of Object.entries(pool.skills || {})) skills[k] = { category: line.lead, items: line.items };
  return { orgs, projects, coursework: pool.education?.coursework || [], skills };
}

/** The family's plan, in the shape the answer takes — the model improves on this. */
export function defaultPlanOf(spec) {
  const titles = {};
  const experience = {};
  for (const e of spec.experience || []) {
    if (e.orgKey) {
      titles[e.orgKey] = e.title;
      experience[e.orgKey] = (e.bullets || []).map((b) => b.provenanceKey.split('.').pop());
    }
  }
  const course = (spec.education?.[0]?.bullets || []).find((b) => b && b.lead === 'Relevant Coursework');
  return {
    titles,
    experience,
    projects: (spec.projects || []).map((p) => p.key).filter(Boolean),
    coursework: course ? String(course.text).split(/,\s*/) : [],
    skills: (spec.skills || []).map((s) => ({ key: s.key, items: String(s.text).split(/,\s*/) })),
  };
}

/**
 * THE PROMPT. Pure and exported so its rules can be asserted in tests — the
 * instructions here are a safety control, not a formatting preference, and a
 * silent edit to them is exactly the kind of change that should fail a build.
 */
export function buildTailorPrompt({ spec, job, jd, familyLabel = null, pool = null, framing = '', request = '' }) {
  const bullets = [];
  for (const entry of spec.experience || []) {
    for (const b of entry.bullets || []) {
      if (!b.provenanceKey) continue;
      bullets.push({ key: b.provenanceKey, org: entry.org, current: b.text, approved: b.source || [b.text] });
    }
  }
  const menu = pool ? menuFor(pool) : null;
  const base = defaultPlanOf(spec);
  const ownCompany = Object.values(pool?.orgs || {}).find((o) => o.atOwnCompany);
  const applyingToOwn = ownCompany && new RegExp(`^${String(ownCompany.org).replace(/[^a-z0-9]+/gi, '.*')}`, 'i').test(String(job?.company || ''));

  // WHAT THIS POSTING NAMES, AND WHAT THE DRAFT CARRIES UNASKED.
  //
  // Computed here rather than left to the model, because the model's own
  // coverage list is a paraphrase and reliably flatters itself — 83.7% claimed
  // against 49% measured, over his last fifty sent resumes. These are the
  // posting's own nouns, matched mechanically, so they cannot be talked up.
  //
  // It is a BRIEF, not an instruction to keyword-stuff: a term is only worth
  // putting on the page when something in the menu genuinely proves it, and the
  // rule against bridging to evidence he does not have is unchanged above.
  const draftText = [
    ...bullets.map((b) => b.current),
    ...(spec.projects || []).map((p) => `${p.name || ''} ${p.text || ''}`),
    ...(spec.skills || []).map((x) => `${x.lead}: ${x.text || (x.items || []).join(', ')}`),
    ...(spec.coursework || []),
  ].join(' | ');
  const cov = jd ? termCoverage(jd, draftText) : null;
  const termBrief = cov && cov.named
    ? `Measured on this posting: it names ${cov.named} concrete terms and the family draft covers `
      + `${cov.covered.length}.\n`
      + `   - NAMED BY THE POSTING, NOT ON THE DRAFT: ${cov.missing.slice(0, 14).join(', ') || '(none)'}\n`
      + `   - ON THE DRAFT, NOT ASKED FOR: ${cov.unmatched.slice(0, 18).join(', ') || '(none)'}`
    : '(This posting names no concrete tools or methods, so there is nothing to measure — '
      + 'choose on the work it describes instead.)';
  // EVERY REQUIREMENT SENTENCE, NUMBERED (2026-10-27, his ask: "check against
  // every sentence in jd and make checklist"). Split mechanically so the
  // coverage list cannot quietly skip a line the planner found inconvenient.
  const reqs = jd ? requirementLines(jd) : [];
  const reqBrief = reqs.length
    ? reqs.map((r) => `   ${r.id} [${r.need}] ${r.text}`).join('\n')
    : '   (no requirement lines could be read from this posting — list them yourself, ids R1, R2, …)';

  // Everything below names HIS organisations, bullets and history. Anyone else
  // gets the same method with none of it (see buildFieldTailorPrompt).
  if (!ownsExamples()) {
    return buildFieldTailorPrompt({ job, jd, request, framing, menu, bullets, base, termBrief, reqBrief, familyLabel: familyLabel || spec?.familyLabel || 'standing' });
  }

  return `You are tailoring Alex Rivera's one-page engineering resume to ONE job posting: what goes on
the page, in what order, under which titles, and how each bullet is worded.

He is a mechanical engineering student graduating May 2027 (new grad). The family base is his
${familyLabel || spec?.familyLabel || 'standing'} variant; the DEFAULT PLAN below is that base. Improve on it.

THE STANDARD. Tailoring is engineering-evidence selection, not keyword substitution. Do not ask
"how can he look like this posting?" — ask "what are the most impressive TRUE pieces of his
engineering work, and how are they selected and phrased so they naturally prove this posting?"
The page must pass two tests at once: (1) JD FIT — it proves the core requirements of the job;
(2) TECHNICAL IMPRESSION — read for twenty seconds by someone who never saw the posting, it says
"this person has designed, built, tested, debugged and deployed real hardware". A page that
matches every requirement and still reads as generic, as filler, or as a resume rewritten around
the posting has FAILED. Optimise in this order: truthfulness, technical impressiveness, JD
relevance, quantified impact, distinctiveness, ATS terminology, space. Technical substance beats
process language every time.

EVERY LINE MUST ADD one of: new technical evidence, a meaningful quantified result, a highly
relevant tool or skill, evidence of engineering ownership, or evidence of hands-on capability.
A line that adds none of those does not belong, however "relevant" its topic.

A TRADITIONAL PAGE (his words, 2026-10-26: "dont make it too non traditional, too many niche
details or unimpressive work hurts a lot"). The page reads like a strong conventional
engineering resume, not a keyword map:
- Fewer, stronger lines beat covering every minor requirement. A nice-to-have is never worth a
  weak line; leave it uncovered and say so in "notes".
- Niche names a recruiter will not know (Neuro-T, Tulip, Node-RED, part numbers, internal team
  names) appear only where the posting names them or the line is already one of the strongest
  on the page; in a rewrite, say what the thing IS ("a machine-vision model") rather than its
  product name, where the approved wording allows.
- Work that reads small — documentation, translation, packaging, coordination, a spreadsheet
  macro on its own — goes on only when the posting asks for exactly that, and never above a
  line that shows design, build, test or a measured result.
- Mirror the posting's own words for the same work (SOP, yield, cycle time, bring-up,
  equipment qualification, reverse engineering, DOE) wherever the approved wording supports
  them. That is how both a recruiter and a screening model see the match. The eye should
land on: Applied Materials, semiconductor equipment, designed physical hardware, tolerance
analysis, robotic end effectors, Universal Robots, RoboDK, AMRs, machine vision, cleanroom, Haas
CNC, welding, 70%, $57,000, the robotic arm, FEA.

THE JOB
Company: ${job?.company || 'unknown'}
Title: ${job?.title || 'unknown'}
${String(request || '').trim() ? `
ALEX'S NOTE FOR THIS RESUME — his own words, typed beside the form:
"${String(request).trim().replace(/"/g, "'").slice(0, 600)}"
Honour it wherever the rules below allow: which bullets lead, what is emphasised, how a bullet
is worded, what is left off, which title is chosen. It can never add a fact, a tool, a number,
a claim or a word that is not in the menu and the approved wordings — if it asks for one, leave
that part out and say so in "notes". A note that asks to weaken or invent is declined the same way.
` : ''}
${jd || '(no description available — return the default plan with an empty rewrites object)'}

THE MENU — everything the resume may contain. Keys are what you return. Nothing outside it exists.
${menu ? JSON.stringify(menu, null, 1) : '(pool not supplied — reword only)'}

THE BULLETS AS THEY STAND — each with its key and every approved wording (both forms are his own).
${JSON.stringify(bullets, null, 1)}

DEFAULT PLAN (the family base)
${JSON.stringify(base, null, 1)}

YOUR JOB
1. Read the whole posting. Extract its core responsibilities, required and preferred tools, the
   industry's terminology, and the main engineering function. Decide the role type:
   mechanical | manufacturing | process | automation | equipment | npi | quality | other.
1b. COVERAGE — do this BEFORE you choose a single bullet, and return it. Below is EVERY requirement
   sentence of the posting, numbered — its duties [duty], must-haves [must] and nice-to-haves [nice].
   Answer EVERY id, in order, with the ONE thing on your page that proves it — a bullet key,
   "coursework: <course>", "skills: <item>", "project: <key>", or "none". Prefer a bullet or a
   project over a skills item whenever one proves it: a bullet shows the work, a skill only names
   it. Whatever you cite as proof of a [duty] or [must] line WILL be kept on the page, so cite the
   strongest real evidence and put it on your page. Rate each answer's "strength" honestly:
   "direct" only when the cited line shows that very work, tool or domain (a pressure-decay tester
   integration directly proves "integrate test equipment"); "partial" when it is adjacent evidence
   (Fluid Mechanics coursework for "pumps, chillers and abatement systems"; a lumber-savings figure
   for "automation projects requiring coding"); "none" when nothing proves it. A recruiter will
   read the page, not your rating, so a generous rating helps nothing. This is the step that stops
   a page from quietly ignoring a stated requirement while looking well tailored:
${reqBrief}
   - A requirement the posting NAMES and he genuinely has EVIDENCE for must be covered. If your
     draft leaves it at "none" and something in the menu could prove it, change the draft.
   - A requirement he has no evidence for stays "none". Never bridge to it, never imply it, and
     do not mention it anywhere on the page. Say so in "notes" instead — an honest gap he can
     read is worth more than a sentence that will not survive an interview.
   - Where the evidence exists but only inside a bullet's FULL wording — a tool, a figure, a
     method the short form drops — put that exact phrase in "mustKeep" (see 9).
   Getting this list right is most of the job. A page that covers eight of nine requirements
   and knows which one it missed beats a page that covers six and does not know.
1c. COVERAGE FIRST, THEN THE NEXT MOST RELEVANT THING. Measured across his last fifty sent
   resumes, each page covered only 49% of the terms its posting actually named.
   ${termBrief}
   - The terms above that the posting NAMES and the page does not: if anything in the menu
     proves one, that is the first thing to put on. This is where a line is bought.
   - Once the posting is covered, the room that is left goes to the next most relevant
     evidence for this kind of role, whether or not the posting named it. A line the posting
     never mentioned is NOT a fault — his words: "even after all bullets hit the jd great if we
     still have some space we should put the next relevant thing on there". What gives way when
     room is short is the weakest line: a second bullet about a system already described, a
     tool with no connection to this kind of work.
   - A line earns its place when a stranger, reading only this page against only this
     posting, is more likely to call him because of it.
1d. THE LEAD FOLLOWS THE JOB (2026-10-26). Graded against their postings, his last 30 resumes
   averaged 58/100 for one reason above all: every page opened with the same Applied Materials
   block in nearly the same order, while the proof the job wanted sat mid-page — Acme Steel's 70%
   and $57,000 for process and manufacturing roles, Makerspace's CNC, welding and training for
   prototype and fabrication roles, the robotic arm for robotics hardware roles. So:
   - Write down the posting's THREE main day-to-day responsibilities (what the person DOES,
     not the nice-to-haves). The first bullet under EACH employer is that employer's strongest
     proof of one of them. amat.vision-fixture stays on the page, but it leads Applied
     Materials only when the job is mechanical design, fixtures or tooling; a robotics or
     integration job leads with the cobot cell, an equipment job with the deployment and
     qualification work.
   - An Applied Materials line that proves none of the three and is not one of its two
     strongest technical lines gives its place to a Acme Steel or Makerspace line that proves one.
   - The section order never changes (Education, Experience newest first, Projects, Skills):
     the page stays a conventional resume. Only what leads INSIDE each section moves.
2. TITLES. For each internship (amat, acme) pick ONE clean recruiter-facing title from that
   org's "titles" list — the one that best matches the job, no hybrids, no ampersands.
   ${applyingToOwn ? `THIS POSTING IS AT ${ownCompany.org.toUpperCase()} ITSELF: the amat title must be exactly the
   "whenApplyingToThisCompany" entry for the role type (mechanical roles → mechanical, everything
   else → manufacturing). An internal recruiter can see the discrepancy.` : 'The team (group) prints after the title automatically; do not put it in the title.'}
3. EXPERIENCE. For each org choose WHICH bullet keys appear and in WHAT ORDER, by INCREMENTAL
   VALUE: a bullet earns its line by proving something the page does not already prove. Lead each
   org with the bullet closest to the job. Rules: amat.vision-fixture is on every resume (the
   mechanical-design staple); the UR cobot cell is amat.robodk and amat.cobot-rack as two
   bullets, or amat.cobot-cell (the same two said as one, for a tight page), never cobot-cell
   beside either; amat,
   acme and makerspace each keep at least one line; makerspace, rover and sae at most two, or three for an org
   you name in "emphasise"; 10 to 13 lines in total.
   - PRECEDENCE, his order: amat, then acme, then makerspace, then rover, sae and the projects,
     which are the first to give way. acme NEVER has fewer lines than makerspace — it is a full
     engineering internship and makerspace is the campus shop. Spare room goes to acme first.
   - AMAT'S SIZE IS YOURS TO ARGUE. It keeps 5 or 6 bullets by default — it is the strongest
     block on the page and usually deserves them. But it is not a quota. If this posting's
     MUST-HAVES are proven better by Makerspace, by Baja, by a project or by a acme line, you may
     take amat down to as few as 3 — say so in "whyFewerAmat", naming what the freed lines prove
     that amat cannot. Without that sentence the floor stays at 5 and your plan is restored.
     amat.neuro-t is a strong default, not a fixture: it proves machine vision, which most
     postings do not ask for. Spend its line when the posting pays better elsewhere.
     The FIFTH and SIXTH Applied Materials lines must each prove a responsibility or requirement
     of this posting. amat.neuro-t, amat.iiot and amat.amr are the usual passengers: where the
     posting asks for none of machine vision, data logging / test integration, or mobile robots,
     argue amat down to four in "whyFewerAmat" and give the lines to Acme Steel and Makerspace.
   - Never choose a bullet that describes an ASSUMED part of engineering work — collaborated,
     coordinated, presented, participated, attended reviews, supported, completed documentation —
     over one that shows mechanism design, tolerance decisions, fixture architecture, testing,
     fabrication, robotics, automation, validation, or a quantified improvement. Nobody is hired
     for attending a design review.
   - sae is OPTIONAL, and the posting decides — not a standing preference. Where the posting
     is SILENT about build teams, Makerspace proves machining and fabrication far more strongly and
     the Baja lines add almost nothing: return "sae": []. Where the posting NAMES one — Formula
     SAE, Baja, solar car, rocketry, a student competition team, automotive, vehicle systems,
     motorsports, a vehicle garage — Baja is not redundant, it is the named evidence, and a
     single line saying he "applied machining and fabrication skills" does not answer a stated
     requirement. Give it two, put "sae" in "emphasise", and consider moving it above makerspace.
     Redundant evidence is not relevance; neither is under-answering a requirement the posting
     put in its own list.
   - rover (Lakeside Robotics Club – Mars Rover Team): a pneumatic gripper for the rover
     manipulator (gripping geometry, actuator integration, mounting interface) and suspension
     plates designed in CAD and plasma-cut in-house. HIS RULE (2026-11-04): it goes on ONLY when
     it is relevant to the role or the posting asks for it — otherwise leave it off, "rover": [].
     Relevant: the work is what these lines prove — robot manipulators, grippers or end-effectors,
     pneumatics, mobile or field robots, rovers or space robotics, suspension or chassis. Asked
     for: the posting names student build teams, club or competition projects, or hands-on
     project work outside jobs. When it goes on, gripper first, and it is answered before sae.
     A general mechanical design, process, quality, test or data role is NOT a reason by itself.
     Leaving "rover" out of "experience" also leaves it off. Where the posting names a build team
     AND vehicles or automotive specifically, sae may join it.
   - makerspace is serious manufacturing experience, not a student job: he is the Manufacturing Lead
     who manages end-to-end production, proves out CNC programs, inspects, runs Haas mills,
     lathes, MIG/TIG welders, plasma cutters and 3D printers, and trains 50+ people. For any
     hands-on, mechanical, manufacturing or robotics-hardware role give it two lines
     (production + fabrication) before spending a line on anything weaker.
   - acme: the 70% jam reduction and the 100+ samples / Excel VBA / $57,000 bullets are the
     strongest; the 110,000 sq ft layout next; packaging and documentation only when the posting
     values inventory, waste or equipment troubleshooting.
   - The robotics content at Applied Materials (Universal Robots, RoboDK, reachability and
     collision-free paths, the 8-end-effector rack, AMR deployment, Neuro-T machine vision,
     pressure-decay test integration, cleanroom work) is what separates him from a generic
     mechanical new grad. Never trade it away to make room for a keyword.
4. PROJECTS. One or two keys, by INCREMENTAL VALUE. robotic-arm adds evidence nothing else on
   the page has — a 6-DOF manipulator, serial-bus servo actuation, a parallel-jaw gripper,
   inverse kinematics, joint torque sizing, ROS 2/MoveIt motion planning, embedded control, a
   65 cm working reach — so it is the choice for any robotics, mechatronics, hardware,
   automation or controls company. piston-fea adds reverse engineering from measurements and FEA
   under thermal and shear loading — the choice for mechanical design and analysis roles.
   cnc-cardholder mostly repeats what Makerspace already proves; choose it only when the posting is
   specifically about CAD/CAM, CNC programming or toolpaths.
5. COURSEWORK. Five to seven courses from the menu, most relevant to the role first.
6. SKILLS. Three to five categories from the menu, ordered by relevance to the job, each
   category's items reordered so the ones this posting names come first; drop items that do not
   help. Each category prints in at most TWO lines (his rule — per category, not for the whole
   section); the layout trims the items the posting did not name, and fills any line left short. Never add a skill the menu does not hold, and never add a keyword just because the JD has it.
   A skill is a recognised tool, method, process, language or platform (SolidWorks, Inventor,
   Siemens NX, Ansys, GD&T, DFM/DFA, Tolerance Analysis, FEA, RoboDK, Universal Robots, Python,
   Node-RED, Arduino, CNC Machining, MIG/TIG Welding, 3D Printing, Soldering). Activity phrases —
   Object Detection, Image Classification, Part Inspection, Qualification Testing, Dimensional
   Analysis, Time Studies, Process Improvement — read as filler when isolated; print one only
   when the posting itself uses the phrase, and let the bullets carry them otherwise. Keep
   Soldering, welding, CNC and 3D printing for any hardware or robotics role: they say he can
   physically build the thing.
   WHICH CATEGORIES, per posting, not per family (2026-10-26):
   - "process" (Process/Quality) only for manufacturing, process, quality, NPI or equipment
     roles, and then only the methods the posting names plus Root Cause Analysis, PFMEA/DFMEA
     and Six Sigma. A design, robotics, R&D or integration page does not print a list of
     improvement methods (Kaizen, 5S and Pareto were on the Figure hands resume).
   - "ai" (AI Tools) only when the posting asks for AI tools, AI-assisted or agentic work.
   - "data" only when the posting names one of its items (SAP, MES, Tableau, data analysis).
   - Programming languages the menu holds (Python, C++, MATLAB) print on any page whose posting
     names coding, scripting, automation or data — three of the graded Micron and Field AI
     pages asked and had none.
   - A tool the posting names and the menu holds goes FIRST in its category, every time:
     SAP for Schindler, DOE wherever a posting asks for designed experiments.
7. REWRITES. For bullets you keep, reword toward the posting's vocabulary where it genuinely
   describes the same work. Shape: action + technical method + engineering context + outcome.
   Strong verbs (designed, developed, validated, deployed, qualified, integrated, programmed,
   analyzed, improved, reduced, built, tested, troubleshot, implemented, optimized, coordinated).
   Go through EVERY bullet you keep and ask whether this posting has its own word for what it
   already describes; where it does, use the posting's word. Where a bullet already speaks the
   posting's language, leave it exactly as it is — rewriting to no effect is churn.
   TECHNICAL DEPTH: never simplify a bullet below its approved wording. Where the approved
   wording or the CV's approved details carry engineering specifics — 3 chamber variants,
   self-locking camera positioning, controlled lighting, error-proofing, tolerance analysis,
   lift-pin alignment, reachability and collision-free paths, 8 end effectors, resin-printed
   hardware, MIG/TIG, plasma cutters, CNC program prove-outs — keep them; they are what makes the
   page memorable. A rewrite that drops a tool, a process or a figure to save words is a loss,
   not a tailoring. Documentation, drawings and release work belong INSIDE the technical bullet
   they came from, never as a bullet of their own.
   GRAMMAR, which he checks and a recruiter notices: full grammar, not clipped resume-speak.
   Keep a/an/the where English needs them ("on a robotic assembly line", "into an animated
   assembly"). No dangling modifiers — an issue does not reduce jams, its fix does. Every item
   in a list must still fit the verb that governs it: cutting "route setup" and "safety
   controls" out of "validated through qualification testing, route setup, …" leaves
   "validated through … coordination", which is nonsense. Hyphenate compound modifiers
   (6-DOF, collision-free, root-cause, end-to-end). Use the serial comma in every list of three
   or more ("designed, plasma-cut, and integrated"), as the rest of his page does. End every
   bullet with a period. Keep technical terms capitalised as the approved wording has them (Autonomous Mobile Robots,
   Finite Element Analysis) — that is his choice.
   LOCKED: "amat.vision-fixture" ships in his own words. Keep it, order it, drop it
   for room — but never put it in "rewrites". A rewrite for it is discarded. He read
   one that reached across all three approved wordings at once and said it mumbled;
   the sentence he wrote says the same work and reads better.
8. RESERVE. Two to four unused bullet keys in the order to add them if the page has room.
9. MUSTKEEP. The exact phrases, copied character-for-character out of the approved wordings above,
   that this posting asked for BY NAME — a tool, a process, a material, a figure, a piece of
   hardware. The page is laid out after you answer, and when it runs a line long the layout picks
   a shorter approved wording; anything you list here it will not spend, and will shorten
   something else or drop a line instead. Only phrases that actually appear in the wordings
   above — an invented one protects nothing and is discarded. Three to eight is right; listing
   half the resume protects nothing either, because then the layout has nothing left to give.
10. EMPHASISE. Zero to two org keys this posting leans on hard enough to be worth a third line
   ("makerspace", "rover", "sae"). Use it when the posting states a requirement that org is the evidence for.

REWRITE RULES — enforced by a checker after you answer; a rewrite that breaks one is thrown
away and the standing sentence stays, so breaking one only costs Alex a tailored bullet.

1. Reword only. Never add a fact. Every number, tool, software package, material, standard,
   company and job title in your rewrite must already appear in that bullet's approved wording.
   If the posting asks for something the bullet does not contain, LEAVE IT OUT — say nothing
   rather than bridge.
2. Truthful stretching is allowed: use the strongest reasonable interpretation of work he
   actually performed — testing that validated equipment before deployment is qualification
   testing; troubleshooting that found the cause is root cause analysis; inspection work may
   emphasise characterization, repeatability, validation or dimensional analysis; deployment
   work may emphasise commissioning, integration, qualification, launch support or field
   testing — but NEVER commissioning for the UR cobot cell, the end-effector rack or the AMR
   rollout at Applied Materials (his call, 2026-09-23): that work was integration and
   deployment. But never introduce a word that does not appear somewhere in his CV, and the
   approved framing vocabulary is this: ${framing || 'see cv.md § Approved framing vocabulary'}.
3. Keep it near the same length or shorter — at most a third longer. The page is one sheet.
4. Keep the figures. Dropping a bullet's number usually costs it its point.
5. Do not change what he did. "Assembled" and "designed" are different claims. Match the
   posting's vocabulary only where it genuinely describes the same work.
6. NEVER claim: PLC or ladder-logic experience, Linux, electrical engineering expertise, any
   certification, software or languages not in the menu, semiconductor processes he did not
   work around (recipe, plasma chemistry, film properties), fabrication methods not in his
   background, responsibilities he did not perform, ownership he did not have, fake projects.
7. Never weaker than his own words: a bullet whose approved wording says "Deployed and
   validated" may not come back as "Supported deployment of". No "helped with", "assisted",
   "responsible for", "worked on", "participated in".

ROLE-SPECIFIC EMPHASIS (what to lead with, per role type)
${Object.entries(ROLE_EMPHASIS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

WHAT MATTERS MOST. The Applied Materials bullets are the strongest thing on this resume and the
reader's eye goes there first. Spend the most care matching those to the posting. Never weaken
one to fit a keyword. An automated match score is not the goal: a missing JD word is added only
when he genuinely has that experience, the word is recognised and useful, it fits inside a real
bullet, and adding it does not weaken the technical impression. Decide everything yourself — do
not ask which bullet, title, skill or project to use.

BEFORE YOU ANSWER, run the two tests on your plan. JD FIT: does the page prove the core
requirements? TECHNICAL IMPRESSION: read cold for twenty seconds, does it say hands-on engineer
with robotics, automation, manufacturing and real industrial experience? If the first passes and
the second fails, change the plan.

ANSWER
Return ONLY a JSON object, no prose, no code fence, of this exact shape:
{"roleType":"...","coverage":[{"id":"R1","req":"the posting's words","need":"duty|must|nice","strength":"direct|partial|none","proof":"amat.vision-fixture|coursework: Heat Transfer|skills: SolidWorks|project: piston-fea|none"}],"titles":{"amat":"...","acme":"..."},"experience":{"amat":["key",...],"acme":[...],"makerspace":[...],"rover":[...],"sae":[...]},"whyFewerAmat":"only if amat keeps fewer than 5 — what the freed lines prove instead","emphasise":["sae"],"projects":["key"],"coursework":["..."],"skills":[{"key":"cad","items":["..."]}],"rewrites":{"amat.vision-fixture":"sentence"},"mustKeep":["parallel-jaw gripper"],"reserve":["acme.docs"],"notes":["an uncovered requirement, or what of his note could not be honoured"]}
Every key must come from the menu. An empty rewrites object is a valid answer.

LAST CHECK, against your own coverage list: is there a requirement marked "none" that something
in the menu could have proven? If so your plan is not finished. Change it and answer with the
plan you would defend.`;
}

/**
 * The tailoring prompt for anyone who is not `writing.examplesOwner`: the same
 * method and the same answer shape, worded from the person's profile and the
 * field's preset, with no organisation, bullet, figure or rule of his in it.
 */
function buildFieldTailorPrompt({ job, jd, request, framing, menu, bullets, base, termBrief, reqBrief = '', familyLabel }) {
  const w = writing;
  const name = person.fullName;
  const first = person.firstName;
  const orgKeys = Object.keys(menu?.orgs || base.experience || {});
  const emphasis = Object.entries(w.roleEmphasis || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `You are tailoring ${name}'s one-page ${w.resumeKind || 'professional'} resume to ONE job posting: what goes on
the page, in what order, under which titles, and how each bullet is worded.

${personLine()} The family base is the
${familyLabel} variant; the DEFAULT PLAN below is that base. Improve on it.

THE STANDARD. Tailoring is evidence selection, not keyword substitution. Ask "what are the most
impressive TRUE pieces of this person's work, and how are they selected and phrased so they
naturally prove this posting?" The page must pass two tests at once: (1) JD FIT — it proves the
core requirements of the job; (2) IMPRESSION — read for twenty seconds by someone who never saw
the posting, it says "${w.impression || 'this person has done real, measurable work'}". Optimise in this order:
truthfulness, substance, JD relevance, quantified impact, distinctiveness, ATS terminology, space.
${w.substance || ''}

EVERY LINE MUST ADD one of: new evidence, a meaningful quantified result, a highly relevant tool or
skill, evidence of ownership, or evidence of hands-on capability. A line that adds none of those
does not belong, however "relevant" its topic.

THE JOB
Company: ${job?.company || 'unknown'}
Title: ${job?.title || 'unknown'}
${String(request || '').trim() ? `
${first.toUpperCase()}'S NOTE FOR THIS RESUME — their own words, typed beside the form:
"${String(request).trim().replace(/"/g, "'").slice(0, 600)}"
Honour it wherever the rules below allow. It can never add a fact, a tool, a number, a claim or a
word that is not in the menu and the approved wordings — if it asks for one, leave that part out
and say so in "notes".
` : ''}
${jd || '(no description available — return the default plan with an empty rewrites object)'}

THE MENU — everything the resume may contain. Keys are what you return. Nothing outside it exists.
${menu ? JSON.stringify(menu, null, 1) : '(pool not supplied — reword only)'}

THE BULLETS AS THEY STAND — each with its key and every approved wording.
${JSON.stringify(bullets, null, 1)}

DEFAULT PLAN (the family base)
${JSON.stringify(base, null, 1)}

YOUR JOB
1. Read the whole posting. Extract its core responsibilities, required and preferred tools, the
   industry's terminology, and the main function. Decide the role type:
   ${w.roleTypes || 'other'}.
1b. COVERAGE — before choosing a single bullet. Below is EVERY requirement sentence of the posting,
   numbered. Answer EVERY id with the ONE thing on your page that proves it — a bullet key,
   "coursework: <course>", "skills: <item>", "project: <key>", or "none". Prefer a bullet or project
   over a skills item. Whatever you cite for a [duty] or [must] line WILL be kept on the page.
   Rate each "strength": "direct" only when the line shows that very work, tool or domain;
   "partial" for adjacent evidence; "none" when nothing proves it. Never round up.
${reqBrief}
   - A requirement the posting names and the menu has evidence for must be covered.
   - A requirement with no evidence stays "none". Never bridge to it or imply it; say so in "notes".
   - Where the evidence is only in a bullet's FULL wording, put that exact phrase in "mustKeep".
1c. COVERAGE FIRST, THEN THE NEXT MOST RELEVANT THING.
   ${termBrief}
   Once the posting is covered, spare room goes to the next most relevant evidence for this kind of
   role. What gives way when room is short is the weakest line.
2. TITLES. For each experience entry pick ONE clean title from that org's "titles" list — the one
   that best matches the job, no hybrids.
3. EXPERIENCE. For each org (${orgKeys.join(', ') || 'see the menu'}) choose WHICH bullet keys appear and
   in WHAT ORDER, by incremental value: a bullet earns its line by proving something the page does
   not already prove. Lead each org with the bullet closest to the job. Every org in the default
   plan keeps at least one line; 10 to 13 lines in total. Never choose a bullet about assumed
   parts of the work (attended, participated, supported) over one with a concrete result.
4. PROJECTS. One or two keys, by incremental value.
5. COURSEWORK. Five to seven courses from the menu, most relevant to the role first.
6. SKILLS. Three to five categories from the menu, ordered by relevance, each category's items
   reordered so the ones this posting names come first; drop items that do not help. Never add a
   skill the menu does not hold. A skill is a recognised tool, method, language or platform
   (${w.skillExamples || 'as the menu lists them'}).
7. REWRITES. For bullets you keep, reword toward the posting's vocabulary where it genuinely
   describes the same work. Shape: action + method + context + outcome. Strong verbs. Where a
   bullet already speaks the posting's language, leave it as it is. Never simplify a bullet below
   its approved wording, never drop a tool, a method or a figure to save words. Full grammar, the
   serial comma, every bullet ends with a period.
8. RESERVE. Two to four unused bullet keys in the order to add them if the page has room.
9. MUSTKEEP. Exact phrases, copied character-for-character from the approved wordings, that this
   posting asked for BY NAME. Three to eight.
10. EMPHASISE. Zero to two org keys this posting leans on hard enough to be worth a third line.

REWRITE RULES — enforced by a checker after you answer; a rewrite that breaks one is thrown away.
1. Reword only. Never add a fact. Every number, tool, software package, standard, company and job
   title in a rewrite must already appear in that bullet's approved wording.
2. Truthful stretching is allowed — the strongest reasonable reading of work actually performed —
   but never introduce a word that does not appear somewhere in the CV. Approved framing
   vocabulary: ${framing || 'see cv.md § Approved framing vocabulary'}.
3. Keep it near the same length or shorter — at most a third longer.
4. Keep the figures.
5. Do not change what was done. Match the posting's vocabulary only where it describes the same work.
6. NEVER claim a certification, a license, software or languages not in the menu, responsibilities
   not performed, ownership not held, or projects that do not exist.
7. Never weaker than the approved wording. No "helped with", "assisted", "responsible for",
   "worked on", "participated in".

ROLE-SPECIFIC EMPHASIS (what to lead with, per role type)
${emphasis}

BEFORE YOU ANSWER, run the two tests on your plan. If JD FIT passes and IMPRESSION fails, change it.

ANSWER
Return ONLY a JSON object, no prose, no code fence, of this exact shape:
{"roleType":"...","coverage":[{"id":"R1","req":"the posting's words","need":"duty|must|nice","strength":"direct|partial|none","proof":"<bullet key>|coursework: <course>|skills: <item>|project: <key>|none"}],"titles":{"<org key>":"..."},"experience":{"<org key>":["key",...]},"emphasise":["<org key>"],"projects":["key"],"coursework":["..."],"skills":[{"key":"<skill key>","items":["..."]}],"rewrites":{"<bullet key>":"sentence"},"mustKeep":["..."],"reserve":["<bullet key>"],"notes":["an uncovered requirement, or what of the note could not be honoured"]}
Every key must come from the menu. An empty rewrites object is a valid answer.`;
}

/**
 * The second ask, when the guard threw rewrites out.
 *
 * This exists because of what the first pass actually does wrong. Measured on a
 * live GlobalFoundries posting, the refusals were "Deployed", "setup",
 * "coordination", "repeatable" — ordinary engineering words that simply are not
 * in his CV. The model was not trying to inflate anything; it was writing in its
 * own vocabulary rather than his. Told exactly which words were the problem, it
 * has everything it needs to say the same thing in words he uses.
 *
 * One retry, not a loop. If the second attempt still cannot stay inside his
 * vocabulary, the standing sentence was the better one anyway — and the bullets
 * this rescues are the Applied Materials ones, which are the bullets that matter
 * most and the ones a first pass is most likely to overreach on.
 */
export function buildRetryPrompt({ refusals, job }) {
  const cases = refusals.map((r) => ({
    key: r.key,
    yourRewrite: r.text,
    rejectedBecause: r.problems,
    approvedWording: r.source || [],
  }));

  return `Your rewrites for ${job?.company || 'this posting'} were checked and these were REJECTED.

${JSON.stringify(cases, null, 2)}

Read each "rejectedBecause" literally. Almost always it names a word you used
that does not appear anywhere in ${person.firstName}'s CV, or an opener weaker than his own
wording. The checker has no opinion about whether the word is reasonable — only
about whether it is HIS.

Try each one again, saying the same thing using only words that already appear in
that bullet's approvedWording or in his CV. If a rejected word was carrying the
point of your rewrite and there is no way to say it in his vocabulary, drop that
key entirely rather than forcing it — the original sentence is honest and already
on the page.

Rules from before still hold: no new figures, no tools or names the approved
wording does not have, at most a third longer, strong verbs, and never change
what he did.

Return ONLY a JSON object mapping key to rewritten sentence. Omit any key you are
giving up on. {} is a valid answer.`;
}

/**
 * The third ask, only when the rendered page has orphan tails — bullets whose
 * last line is a stub. His rule: reword to fit, never shrink the font. The
 * model is told how much the sentence has to move: shorter by enough to lose
 * the last line, or longer by enough that the last line is worth having.
 */
export function buildOrphanPrompt({ orphans, job }) {
  const cases = orphans.map((o) => ({
    key: o.key,
    current: o.text,
    approvedWording: o.source || [],
    lastLineHolds: `${Math.round(o.fraction * 100)}% of a line over ${o.lines} lines`,
    fix: `either cut at least ${o.cutChars} characters so it ends a line earlier, or add at least ${o.addChars} characters of substance drawn ONLY from the approved wording`,
  }));
  return `On the rendered resume for ${job?.company || 'this posting'} these bullets end with a stub last line.

${JSON.stringify(cases, null, 2)}

Reword each so the last line is either gone or at least a third of the width. The usual rules
hold: only words from his CV, no new figures or tools, never weaker than his own wording, keep
what he did. Prefer cutting a qualifier over adding one.

Return ONLY a JSON object mapping key to the rewritten sentence. Omit any key you cannot fix
honestly. {} is a valid answer.`;
}

/**
 * The fourth ask, when a bullet prints on four lines. His rule: compress the
 * writing, never the depth — the fixture bullet carries its lighting, its
 * indexing, its dovetails, its drawings and its release in three lines when
 * the sentence is built well. The model is told the size to hit.
 */
export function buildCompressPrompt({ compress, job }) {
  const cases = compress.map((c) => ({
    key: c.key,
    current: c.text,
    approvedWording: c.source || [],
    printsOn: `${c.lines} lines (${c.text.length} characters)`,
    fix: `say the same things in at most ${c.targetChars} characters so it prints on three lines or fewer`,
  }));
  return `On the rendered resume for ${job?.company || 'this posting'} these bullets run to four lines.

${JSON.stringify(cases, null, 2)}

Compress the WRITING, not the content: keep every technical fact, tool, figure and mechanism
that is in the approved wording; cut filler, connectives, restatement and process language.
${ownsExamples() ? `Example of the standard — one sentence, three lines, every detail kept:
"Designed and validated an Autodesk Inventor machine vision fixture for three Metal Deposition
chamber variants, integrating controlled lighting, repeatable camera positioning, 120-degree
indexing with ball plungers, dovetail interfaces, and tolerance analysis; created drawings/BOMs
and released the design through Teamcenter."
` : ''}The usual rules hold: only words from his CV, no new figures or tools, never weaker than his own
wording, keep what he did. A detail may be dropped only if it is the least technical one.

Return ONLY a JSON object mapping key to the rewritten sentence. Omit any key you cannot fit
honestly. {} is a valid answer.`;
}

/** Pull the JSON object out of a model answer that may be fenced or chatty. */
function parseObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/** A key → sentence map, and nothing else, out of a model answer. */
export function parseRewrites(raw) {
  const parsed = parseObject(raw);
  if (!parsed) return {};
  // A full plan answer carries its rewrites under "rewrites"; a retry answer IS the map.
  const src = parsed.rewrites && typeof parsed.rewrites === 'object' && !Array.isArray(parsed.rewrites) ? parsed.rewrites : parsed;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * The whole answer: the plan parts (checked later by resume-plan.mjs) plus the
 * rewrites. Anything that is not the right shape is simply absent — the checker
 * treats an absent part as "keep the family default".
 */
export function parsePlan(raw) {
  const parsed = parseObject(raw);
  if (!parsed) return { plan: null, rewrites: {} };
  const plan = {};
  if (typeof parsed.roleType === 'string') plan.roleType = parsed.roleType;
  if (parsed.titles && typeof parsed.titles === 'object') plan.titles = parsed.titles;
  if (parsed.experience && typeof parsed.experience === 'object' && !Array.isArray(parsed.experience)) plan.experience = parsed.experience;
  if (Array.isArray(parsed.projects)) plan.projects = parsed.projects;
  if (Array.isArray(parsed.coursework)) plan.coursework = parsed.coursework;
  if (Array.isArray(parsed.skills)) plan.skills = parsed.skills;
  // What the model could not honour of his note — said back to him, never silently dropped.
  if (Array.isArray(parsed.notes)) plan.notes = parsed.notes.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 300)).slice(0, 6);
  if (Array.isArray(parsed.reserve)) plan.reserve = parsed.reserve;
  // WHAT THE POSTING ASKED FOR, AND WHAT ANSWERS IT. The model's own coverage
  // list, kept whole: it drives nothing on the page, but an uncovered
  // must-have is the single most useful thing a tailoring run can tell him,
  // and before this it had nowhere to say it (F-437).
  if (Array.isArray(parsed.coverage)) {
    plan.coverage = parsed.coverage
      .filter((c) => c && typeof c === 'object' && ((typeof c.req === 'string' && c.req.trim()) || c.id))
      .map((c) => ({
        ...(c.id ? { id: String(c.id).trim().toUpperCase().slice(0, 6) } : {}),
        req: String(c.req || '').trim().slice(0, 300),
        need: /^must/i.test(String(c.need || '')) ? 'must' : /^duty/i.test(String(c.need || '')) ? 'duty' : 'nice',
        proof: String(c.proof || 'none').trim().slice(0, 120),
        strength: /^none$/i.test(String(c.proof || 'none').trim()) ? 'none'
          : /^direct/i.test(String(c.strength || '')) ? 'direct' : 'partial',
      }))
      .slice(0, 45);
  }
  // The phrases the layout may not spend. Reduced against his own wordings by
  // resume-plan.mjs; anything invented here protects nothing.
  if (Array.isArray(parsed.mustKeep)) {
    plan.mustKeep = parsed.mustKeep.filter((x) => typeof x === 'string' && x.trim().length >= 3).map((x) => x.trim().slice(0, 80)).slice(0, 12);
  }
  if (Array.isArray(parsed.emphasise)) plan.emphasise = parsed.emphasise.filter((x) => typeof x === 'string').map((x) => x.trim()).slice(0, 2);
  // The argument for a thin Applied Materials block. No argument, no room.
  if (typeof parsed.whyFewerAmat === 'string' && parsed.whyFewerAmat.trim()) plan.whyFewerAmat = parsed.whyFewerAmat.trim().slice(0, 400);
  return { plan: Object.keys(plan).length ? plan : null, rewrites: parseRewrites(raw) };
}

/**
 * Ask the local CLI. Returns `{ plan, rewrites, ok, why }` and NEVER throws: a
 * resume that ships as the family base because the tailor was unavailable is a
 * fine outcome, and an application blocked on it is not.
 */
export async function tailorWithClaude({ spec, job, jd, familyLabel, pool = null, framing = '', request = '', refusals = null, orphans = null, compress = null, timeoutMs = 240_000, bin = 'claude' } = {}) {
  // Switched off by environment: the resume ships in his own words, at once.
  // For a test that needs a real build without a two-minute model call, and
  // for him when he is offline. Says so, like every other reason here.
  if (/^(off|0|false|no)$/i.test(String(process.env.JARVIS_TAILOR || ''))) {
    return { plan: null, rewrites: {}, ok: false, why: 'tailoring switched off (JARVIS_TAILOR=off) — resume ships in his own words' };
  }
  // The retry and orphan passes carry their own prompt and do not need the posting again.
  if (refusals?.length) return askClaude(buildRetryPrompt({ refusals, job }), { timeoutMs, bin, what: 'retry' });
  if (orphans?.length) return askClaude(buildOrphanPrompt({ orphans, job }), { timeoutMs, bin, what: 'orphan-tail pass' });
  if (compress?.length) return askClaude(buildCompressPrompt({ compress, job }), { timeoutMs, bin, what: 'compression pass' });

  const condensed = condenseJd(jd);
  if (!condensed) return { plan: null, rewrites: {}, ok: false, why: 'no job description to tailor against' };

  return askClaude(buildTailorPrompt({ spec, job, jd: condensed, familyLabel, pool, framing, request }), { timeoutMs, bin, what: 'tailoring', wantPlan: true });
}

/**
 * Run the CLI with the prompt on STDIN. The first version passed it as an
 * argument; with the menu and the whole posting in it the prompt is 15-25k
 * characters, and Windows caps a command line at 32k — close enough that a
 * long JD would have failed with a message about nothing. stdin has no limit.
 */
/**
 * THE MODELS THE NESTED CLI MAY USE, in order.
 *
 * 2026-09-13: every "ask Claude" click on his apply panel came back
 * `answer call failed (exit 1)` with nothing after it. The cause was not in
 * this repo at all — the `claude` CLI defaults to whatever model his account
 * defaults to, that model's limit was spent, and the CLI said so:
 *
 *   You've reached your Fable limit. Switch to another model, or manage usage
 *   credits at claude.ai/settings/usage
 *
 * on STDOUT, with exit 1 and an EMPTY stderr — which is exactly the shape
 * `describeFailure` had nothing to print for. Two things were wrong: the
 * message was thrown away, and one exhausted model took the whole feature
 * down while two working ones sat behind a flag.
 *
 * So every call now names its model, and a limit on one moves to the next.
 * `JARVIS_CLI_MODEL` overrides the list (comma-separated, first wins).
 *
 * 2026-09-16, his rule: the resume, answer, letter and research writers run on
 * Sonnet or something cheaper — never Opus. A spent Sonnet falls to Haiku.
 */
export const CLI_MODELS = String(process.env.JARVIS_CLI_MODEL || 'sonnet,haiku')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The CLI's own way of saying "not this model" — it prints this and exits 1.
 * Since 2026-11 it says "You've hit your 5-hour limit · resets 2am" (and the
 * weekly one the same way), which the old "reached your … limit" missed: the
 * 11-11 seven-day limit made every daily-search read fail as a bare "exit 1",
 * 60 a run, and nothing stopped the run (F-1040).
 */
export const LIMIT_MESSAGE = /(?:reached|hit) your .{0,40}limit|usage limit|manage usage credits|switch to another model/i;

const isClaudeCli = (bin) => /^claude(\.cmd|\.exe|\.ps1)?$/i.test(String(bin).split(/[\\/]/).pop() || '');

// ── the Codex path ──────────────────────────────────────────────────
//
// A second user runs OpenAI's Codex CLI instead of Claude Code. Every writer
// calls `run('claude', ['-p', …], { input })`; on such a machine that call is
// translated here, so no writer has to know which CLI is installed.
//
//   codex [--search] exec --ephemeral --skip-git-repo-check -s read-only
//         --color never -C <tmp> [-m <model>] -o <tmp>/last.txt -
//
// The prompt goes on stdin (`-`), as it does for claude. The answer is the
// agent's LAST MESSAGE, which `-o` writes to a file — stdout also carries the
// session log, which must never be mistaken for the answer. The sandbox is
// read-only on every call: Codex may never write a file in this project (the
// claude side's `--permission-mode dontAsk` maps to the same thing). It runs
// in an empty temporary directory, so it reads no AGENTS.md or project file
// that the prompt did not hand it. `--search` is a top-level flag in Codex
// 0.155 (`codex exec --search` is refused), and it is added only when the
// claude call asked for WebSearch/WebFetch — the lead research.
//
// Claude model names (the ladder) mean nothing to Codex and are dropped;
// JARVIS_CODEX_MODEL picks a Codex model. JARVIS_CODEX_BIN overrides the
// binary (a .mjs/.js path is run with node — that is how the tests stub it).

/** Which CLI the writers use: env JARVIS_LLM wins, then the person's profile. */
export function llmProvider() {
  const env = String(process.env.JARVIS_LLM || '').trim().toLowerCase();
  if (env === 'codex' || env === 'claude') return env;
  return person.llm === 'codex' ? 'codex' : 'claude';
}

/** Codex's own words for a spent plan, and for a missing login. */
export const CODEX_LIMIT_MESSAGE = /hit your usage limit|usage[_\s]limit[_\s]reached|usage limit has been reached|insufficient_quota|exceeded your current quota|rate[_\s]limit[_\s]exceeded/i;
export const CODEX_AUTH_MESSAGE = /401 Unauthorized|Missing bearer|not logged in|please (?:log|sign) in|codex login|invalid[_\s]api[_\s]key|token (?:has )?expired/i;

/** The argv for one claude call, said to Codex. Pure; exported for the tests. */
export function codexArgs(claudeArgs = [], { outFile, cwd, model = process.env.JARVIS_CODEX_MODEL || '' } = {}) {
  const wantsWeb = claudeArgs.some((a) => /\bWeb(?:Search|Fetch)\b/.test(String(a)));
  return [
    ...(wantsWeb ? ['--search'] : []),
    'exec', '--ephemeral', '--skip-git-repo-check',
    '-s', 'read-only', '--color', 'never',
    ...(cwd ? ['-C', cwd] : []),
    ...(model ? ['-m', model] : []),
    '-o', outFile,
    '-',
  ];
}

async function runCodex(claudeArgs, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-codex-'));
  const outFile = path.join(dir, 'last-message.txt');
  const args = codexArgs(claudeArgs, { outFile, cwd: dir });
  const override = String(process.env.JARVIS_CODEX_BIN || '').trim();
  const [bin, argv] = /\.m?js$/i.test(override) ? [process.execPath, [override, ...args]] : [override || 'codex', args];
  const tag = (e) => { if (e && typeof e === 'object') e.provider = 'codex'; return e; };
  try {
    let out;
    try { out = await runOnce(bin, argv, opts); } catch (e) { throw tag(e); }
    const last = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    const stdout = last.trim() ? last : '';
    // A refusal is never the answer: an empty last message, or one that is
    // Codex saying the plan is spent, fails the call instead of reaching a box.
    if (!stdout || CODEX_LIMIT_MESSAGE.test(stdout)) {
      const e = new Error(stdout ? 'codex is out of usage' : 'codex returned no answer');
      e.code = 1; e.stdout = out.stdout; e.stderr = `${out.stderr || ''}${stdout ? `\n${stdout}` : ''}`;
      throw tag(e);
    }
    return { stdout, stderr: out.stderr, model: 'codex', requested: 'codex', fellBack: false, fallbacks: [] };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir left behind costs nothing */ }
  }
}

/**
 * Run the CLI, and when the model it used is spent, run it again on the next
 * one. Anything that is not the claude CLI (the tests drive node through this)
 * passes straight through untouched.
 */
export function run(bin, args, opts = {}) {
  // A machine with Codex instead of Claude Code: the same call, asked of Codex.
  if (isClaudeCli(bin) && llmProvider() === 'codex') return runCodex(args, opts);
  // A one-shot call keeps no transcript. Every reader, writer and lead search
  // used to save one, and 8,000 of them made his /resume picker crawl (F-776).
  if (isClaudeCli(bin) && args.includes('-p') && !args.includes('--no-session-persistence')) {
    args = [...args, '--no-session-persistence'];
  }
  if (!isClaudeCli(bin) || args.includes('--model')) return runOnce(bin, args, opts);
  // THE LADDER IS THE CALLER'S CHOICE, not one global setting.
  //
  // Every writer used to walk the same `sonnet,haiku` list, so a judgement-heavy
  // application answer — the ones a human at a company reads and decides on —
  // could quietly be written by the cheapest model on the list. Alex,
  // 2026-09-19: *"Use Opus as the PRIMARY model… NO HAIKU FALLBACK"* for open
  // ended answers. A caller that says nothing still gets the old ladder.
  const ladder = (opts.models && opts.models.length ? opts.models : CLI_MODELS);
  const tried = [];
  const tryModel = async (i) => {
    const model = ladder[i];
    try {
      const out = await runOnce(bin, model ? [...args, '--model', model] : args, opts);
      // A spent model is not an error to the CLI: it answers on stdout and
      // exits 1. It can also answer on stdout and exit 0, so the TEXT decides.
      if (LIMIT_MESSAGE.test(out.stdout)) {
        tried.push({ model: model || '(default)', why: 'out of credit' });
        if (i + 1 < ladder.length) return tryModel(i + 1);
        // THE REFUSAL MUST NEVER BE MISTAKEN FOR THE ANSWER. On exit 0 this
        // string is the CLI's whole stdout, and the writers above hand stdout
        // straight to a form box — so "You've reached your Fable limit" would
        // be typed into his application. Fail instead.
        const e = new Error('every model is out of credit');
        e.code = 1; e.stdout = out.stdout; e.stderr = out.stderr;
        throw e;
      }
      // WHICH MODEL ACTUALLY ANSWERED, and what it had to walk past to get
      // there. He asked to be able to tell a weaker model's work from Opus's
      // without guessing from the prose.
      out.requested = ladder[0] || '(default)';
      out.model = model || '(default)';
      out.fellBack = tried.length > 0;
      out.fallbacks = tried.slice();
      return out;
    } catch (e) {
      const said = `${e?.stdout || ''} ${e?.stderr || ''}`;
      if (LIMIT_MESSAGE.test(said) && i + 1 < ladder.length) {
        tried.push({ model: model || '(default)', why: LIMIT_MESSAGE.test(said) ? 'out of credit' : 'call failed' });
        return tryModel(i + 1);
      }
      // THE LAST MODEL ON THE LADDER IS SPENT (F-1040): said as such, with the
      // CLI's own sentence ("resets 2am"), so a caller that stops on "out of
      // credit" stops, instead of reading on through a bare "exit 1".
      if (LIMIT_MESSAGE.test(said)) {
        const line = (said.match(/[^\n]*(?:hit|reached) your[^\n]*|[^\n]*usage limit[^\n]*/i)?.[0] || '').trim().slice(0, 120);
        const spent = new Error(`every model is out of credit${line ? ` (${line})` : ''}`);
        spent.code = e.code; spent.stdout = e.stdout; spent.stderr = e.stderr;
        throw spent;
      }
      throw e;
    }
  };
  return tryModel(0);
}

/**
 * The model ladder for an application answer a human will read and judge.
 *
 * Opus first, Sonnet only if Opus cannot complete, and never Haiku — his
 * instruction, 2026-09-19, after reading answers that retrieved the right facts
 * and drew the wrong conclusion from them. Overridable for testing and for a
 * machine that has no Opus access.
 */
export const JUDGMENT_MODELS = String(process.env.JARVIS_ANSWER_MODEL || 'opus,sonnet')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function runOnce(bin, args, { input, timeout, windowsHide = true, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    // On Windows the CLI is a .cmd shim, which only a shell can start. Node
    // 24 deprecates passing an args ARRAY through a shell (DEP0190: the shell
    // re-splits it), so the shell form is one quoted command string; the
    // direct form keeps the array.
    const viaShell = process.platform === 'win32';
    const quote = (a) => (/^[\w.\-\/:]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);
    try {
      const opts = { windowsHide, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) };
      child = viaShell
        ? spawn([bin, ...args].map(quote).join(' '), { ...opts, shell: true })
        : spawn(bin, args, opts);
    } catch (e) { reject(e); return; }
    let stdout = '', stderr = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killed) { const e = new Error('timed out'); e.killed = true; e.signal = signal || 'SIGTERM'; reject(e); return; }
      // With a shell in front (needed on Windows for the .cmd shim), a missing
      // binary is exit 1 with cmd's message, not ENOENT. Say the useful thing.
      if (code !== 0 && /not recognized as an internal or external command|command not found/i.test(stderr)) { const e = new Error('not found'); e.code = 'ENOENT'; reject(e); return; }
      // STDOUT TRAVELS WITH THE ERROR. The CLI's own refusals — a spent model
      // limit above all — are printed on stdout with an empty stderr, and
      // dropping it here is what turned a one-line explanation into a bare
      // "exit 1" on his panel.
      if (code !== 0) { const e = new Error(`exit ${code}`); e.code = code; e.stderr = stderr; e.stdout = stdout; reject(e); return; }
      resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => { /* the child closed early; 'close' reports why */ });
    child.stdin.end(input || '');
  });
}

async function askClaude(prompt, { timeoutMs, bin, what, wantPlan = false }) {
  try {
    const { stdout } = await run(bin, ['-p'], { input: prompt, timeout: timeoutMs });
    if (wantPlan) {
      const { plan, rewrites } = parsePlan(stdout);
      const parts = plan ? Object.keys(plan).filter((k) => k !== 'roleType') : [];
      return { plan, rewrites, ok: true, why: `${plan ? `plan for ${parts.join(', ') || 'nothing'}; ` : 'no plan; '}${Object.keys(rewrites).length} rewrite(s) proposed` };
    }
    const rewrites = parseRewrites(stdout);
    return { plan: null, rewrites, ok: true, why: `${Object.keys(rewrites).length} rewrite(s) proposed` };
  } catch (e) {
    return { plan: null, rewrites: {}, ok: false, why: describeFailure(e, bin, what, timeoutMs) };
  }
}

/**
 * Say what actually went wrong.
 *
 * The first version of this reported `e.message.split('\n')[0]`, which on
 * Windows is "Command failed: claude -p " followed by the first line of the
 * PROMPT — the prompt is part of the command string, so the useful half of the
 * message was cut off by the prompt's own line break and every failure read
 * identically. A timeout and a crashed CLI looked the same, which is the reason
 * one live run could not be diagnosed at all.
 */
export function describeFailure(e, bin, what, timeoutMs) {
  if (e?.provider === 'codex') return describeCodexFailure(e, what, timeoutMs);
  if (e?.code === 'ENOENT') return `the "${bin}" CLI is not on PATH — resume ships untailored`;
  if (e?.killed || e?.signal === 'SIGTERM') {
    return `${what} timed out after ${Math.round((timeoutMs || 0) / 1000)}s — resume ships in his own words`;
  }
  // The CLI's own words, wherever it put them. It prints a spent model limit
  // on STDOUT and leaves stderr empty, so reading only stderr is how a
  // sentence that names the problem exactly became a bare "exit 1".
  const said = String(e?.stderr || '').trim() || String(e?.stdout || '').trim();
  const tail = said.split('\n').filter(Boolean).slice(-3).join(' / ');
  if (LIMIT_MESSAGE.test(said)) {
    return `every model Jarvis can use is out of credit — ${tail.slice(0, 200)} (set JARVIS_CLI_MODEL to one that is not)`;
  }
  const exit = e?.code != null ? ` (exit ${e.code})` : '';
  return `${what} call failed${exit}${tail ? `: ${tail.slice(0, 300)}` : ''}`;
}

/**
 * The same, for a call that went to Codex. Its stderr is the whole session log
 * (prompt included), so only the error lines are quoted, never the prompt.
 */
function describeCodexFailure(e, what, timeoutMs) {
  const login = 'is the codex CLI installed and logged in? run `codex login`';
  if (e?.code === 'ENOENT') return `the "codex" CLI is not on PATH — ${login}`;
  if (e?.killed || e?.signal === 'SIGTERM') return `${what} timed out after ${Math.round((timeoutMs || 0) / 1000)}s (Codex)`;
  const said = `${e?.stderr || ''}\n${e?.stdout || ''}`;
  const lines = said.split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /\b(error|warning|unauthori[sz]ed|limit|quota)\b/i.test(l));
  const tail = [...new Set(errs.length ? errs : lines)].slice(-2).join(' / ').slice(0, 300);
  if (CODEX_AUTH_MESSAGE.test(said)) return `Codex is not logged in — run \`codex login\`${tail ? ` (${tail.slice(0, 200)})` : ''}`;
  if (CODEX_LIMIT_MESSAGE.test(said)) return `Codex is out of usage for now${tail ? ` — ${tail.slice(0, 200)}` : ''}`;
  const exit = e?.code != null ? ` (exit ${e.code})` : '';
  return `${what} call to Codex failed${exit}${tail ? `: ${tail}` : ''} — ${login}`;
}
