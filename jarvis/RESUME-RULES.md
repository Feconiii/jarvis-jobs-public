# How a resume is tailored — the rules, readable

This is the human copy of the rules that `jarvis/tailor-llm.mjs` puts in
front of the model and that `jarvis/resume-plan.mjs`, `jarvis/resume-tailor.mjs`
and `jarvis/resume.mjs` enforce mechanically. It absorbs Alex's resume-tailoring
skill of 2026-09-03 on top of the family system of 2026-08-02. When the two
disagree, the code is what ships; fix the code and this file together.

Contact details are deliberately absent from this file. They live in `cv.md`
and `config/profile.yml`, which are gitignored.

## 0. The standard (2026-09-05)

Tailoring is **engineering-evidence selection**, not keyword substitution.
The question is never "how can he look like this posting?" but "what are
the most impressive TRUE pieces of his engineering work, and how are they
selected and phrased so they naturally prove this posting?" Every page must
pass two tests at once:

1. **JD fit** — the page proves the core requirements of the job.
2. **Technical impression** — read cold for twenty seconds by someone who
   never saw the posting, it says "this person has designed, built, tested,
   debugged and deployed real hardware".

A page that matches every requirement and still reads as generic, as filler,
or as rewritten around the posting has failed. Optimise in this order:
truthfulness, technical impressiveness, JD relevance, quantified impact,
distinctiveness, ATS terminology, space. Every line must add new technical
evidence, a quantified result, a highly relevant tool, engineering ownership
or hands-on capability — a line that adds none of those does not belong.

What follows from it:

- **No assumed-activity bullets.** Collaborated, coordinated, presented,
  participated, attended reviews, completed documentation: never chosen over
  mechanism design, tolerance decisions, fixtures, testing, fabrication,
  robotics, automation, validation or a quantified improvement.
- **Documentation lives inside the technical bullet.** He did create the
  fixture's drawings and BOM, order its components from suppliers and
  release it through Teamcenter (stated 2026-09-05); those facts ride inside
  the fixture bullet's long form and are never a bullet of their own.
- **Incremental value decides.** SAE/Baja is optional **where the posting is
  silent about build teams** — Makerspace proves machining and fabrication far more
  strongly. Where a posting NAMES one (Formula SAE, Baja, solar car, rocketry,
  a student competition team, a vehicle garage), Baja is the named evidence and
  takes two lines, not one. The robotic arm beats the CNC cardholder for any
  robotics, mechatronics or hardware company. Makerspace is serious manufacturing
  experience and gets two lines for hands-on roles.
- **Coverage before selection (2026-09-09).** Before it picks a bullet the
  model lists every requirement the posting states and names the one thing on
  the page that proves each — a bullet key, a course, a skill, a project, or
  "none". A requirement he has evidence for and the draft leaves at "none" is
  a draft that is not finished. A requirement he has no evidence for stays
  "none", is never bridged to, and is reported instead. The list is printed at
  the top of the tailoring report and kept in the audit sidecar.
- **Technical depth over simplification.** The full wording is the default —
  for PROJECTS as well as bullets (fixed 2026-09-09; a project could never
  print in full, so "with a soldered wire harness" was invisible to a posting
  that asked for harness work, F-436). The short form is only what the fit loop
  falls back to when the page spills, one line at a time, before any bullet is
  dropped, and never on a line carrying a `mustKeep` phrase. A rewrite
  never drops a tool, a process or a figure to save words.
- **Skills are real skills** — tools, methods, processes, languages,
  platforms. Activity phrases (Object Detection, Qualification Testing, Time
  Studies …) print only when the posting uses them. Soldering, welding, CNC
  and 3D printing stay on hardware roles: they say he can build the thing.
  A DOMAIN IS NOT A SKILL: "Semiconductor exposure" was a category until
  2026-09-22 and he was right to cut it — where he worked belongs in a bullet,
  where it is evidence, not in a list of what he can do. Each category
  prints in two lines at most; see §7.
- **An ATS match score is not the goal.** A missing posting word is added
  only when he has that experience, the word is recognised, it fits inside a
  real bullet, and it does not weaken the technical impression.

## 1. The shape of a run

1. **Family first.** The posting title routes to one of four families
   (`total-experience`, `automation`, `manufacturing`, `mechanical`) via
   `resume-family.mjs`. The family's plan in `resume-variants.mjs` is the base
   page: which bullets, which title per internship, which projects, which
   coursework, which skills categories.
2. **The model reshapes the page for THIS posting.** It is handed the whole
   pool as a menu (every approved bullet, title, project, coursework item and
   skill, keyed) plus the condensed job description, and it returns a plan:
   role type, one title per internship, bullets per organisation in order,
   projects, coursework, skills categories with items, sentence rewrites, and
   a reserve list of bullets to add if the page runs short.
3. **`applyPlan` reduces the plan to the pool.** Anything not in the menu is
   dropped and reported. The staples, the Applied Materials floor, the
   one-cell rule, the minor-organisation cap, the page budget and the
   own-company title rule are re-imposed whatever the model said.
4. **`applyRewrites` guards every sentence.** A rewrite is refused unless
   every number and every named thing in it appears in that bullet's own
   source wording, every remaining word appears somewhere in `cv.md`, it is
   at most a third longer than the source, it does not open with a weak
   verb, and it does not touch a forbidden claim. A refused rewrite costs
   the rewrite, never the resume. One retry with the refusal reasons.
5. **Render, then fit.** Overflow drops the least-protected bullet; a short
   page adds the next reserve bullet. Up to four passes. Then the orphan
   pass (§6), twice at most. Then the text layer is checked with `pdftotext`.
6. **Audit.** The sent copy carries a JSON sidecar: family, role type,
   titles, what the plan changed, every rewrite applied and refused, and the
   measured fit. The dashboard shows it on the Resumes tab.

## 2. What is fixed on every resume

- Exactly one page. Never a second page, never a font shrink to get there.
- Times New Roman, 10.5pt body. Measured: 11pt loses bold words from the
  PDF text layer, which costs the ATS the keyword the resume exists to win.
- 0.35in margins. Whitespace above the first line and below the last must
  be about equal; a resume never goes out with a blank band at the bottom.
- Centered header: name at about 17.5pt, then location, phone and email on
  one line with vertical bars. No LinkedIn line, matching the one-pager he
  wrote himself.
- Section order: EDUCATION, EXPERIENCE, PROJECTS, SKILLS. Education first,
  always, until he graduates.
- The inspection-fixture bullet from Applied Materials is on every resume —
  the mechanical-design staple. **Neuro-T is not** (changed 2026-09-09): it
  proves machine vision, which most postings do not ask for, so it is a strong
  default the tailorer may spend when the posting pays better elsewhere.
- Applied Materials keeps at least five bullets **by default**. A plan may take
  it to three, but only having said in `whyFewerAmat` what the freed lines
  prove that Applied Materials cannot; the argument goes in the audit. No
  argument, no room — the floor returns to five.
- Makerspace keeps at least one line and takes two on hands-on roles. SAE is
  optional and is the first thing to go when the page is tight — **unless the
  plan named it in `emphasise`**, in which case it may hold three lines and is
  the last to lose one.
- **A phrase the posting asked for by name is not the layout's to spend.** The
  plan returns `mustKeep` — exact phrases out of his own approved wordings that
  the posting names — and no shortening path will swap to a wording that drops
  one. It shortens something else, or drops a line, and says which.
- The RoboDK cell and the cobot install describe the same cell; only one of
  the two is on a page.
- The uploaded file is always `Alex Rivera Resume.pdf`. The audit copy in
  `output/jarvis-resumes/sent/` carries family, company and title in its
  name because that copy is for him, not for the company.

## 3. Titles

- One clean title per internship, chosen for the posting from the approved
  list in `cv.md` (Mechanical Engineer Intern, Manufacturing Engineer
  Intern, Automation Engineer Intern, Process Improvement Intern, Robotics
  Engineer Intern). No hybrids, no ampersands, no parentheses.
- The team goes after the title on the same line with a vertical bar, never
  on its own line.
- **At Applied Materials itself** only the official title is allowed:
  Manufacturing Engineer Intern for process, manufacturing, NPI, operations
  and quality roles; Mechanical Engineer Intern for mechanical roles. The
  model's proposal is overridden and the override is noted. Acme Steel's title
  is still free to match the posting.
- Non-internship roles (Manufacturing Lead, SAE) keep their real titles.

## 4. Wording

- Every bullet: action, method, context, outcome. Strong verb first.
  Openers such as "helped", "assisted", "supported", "responsible for" and
  "worked on" are refused.
- No bold lead-in labels on experience bullets. Project bullets keep their
  bold name because that is the project's title.
- Reword only. Never add a fact. A rewrite may reorder, reframe and speak
  the posting's language using the approved framing vocabulary in `cv.md`
  (qualification testing, root cause analysis, characterization,
  commissioning, and the rest of that section). It may not introduce a
  tool, a number, a material, a process, a company or a title that the
  source bullet does not carry.
- "Assembled" and "designed" are different claims. Ownership is never
  upgraded.
- Never weaker than his own words. Metrics are preserved exactly.
- A posting that asks for something the CV does not have is answered by
  silence, not by bridging.

## 5. Never claimed, mechanically refused

PLC or ladder logic. Linux. Any certification. Electrical engineering
expertise. Semiconductor process work he did not do: recipes, recipe
optimisation, plasma chemistry, film properties. Fabrication methods the CV
does not support. Projects that do not exist. The list is `FORBIDDEN` in
`resume-tailor.mjs`; add to it there, with a test.

## 6. Orphan tails

A prose bullet whose last line is under a third of the width is an orphan.
The fix is rewording, never a font change: cut a qualifier so it ends a line
earlier, or add substance drawn only from the approved wording. The model is
asked once; if that changes the layout and a different bullet is now
orphaned, once more. Skills and coursework are lists and wrap where they
wrap. A fix that spills the page is reverted. The four family bases have no
model to ask, so an orphaned bullet there takes its own short form instead
(the same claim in fewer words), twice at most, with the same revert rule.

## 7. Skills

**At most TWO printed lines PER CATEGORY; no cap on the section.** His
instruction of 2026-09-22 ("skills section should never be more than 2 lines")
was read as a cap on the whole section, and for a day every page went out with
two thin skills lines. He corrected it 2026-09-23: *"when i mean 2 lines of
skills i meant in one caterogy, not for everythinh, coz i used to see like 3
lines of skills for one category … there is no cap on totla lines of skills"*.
The same day a blind reader preferred the older, longer skills sections on all
eight 30-second skims. `resume-qa.mjs` fails a page on `skills-category-long`;
`resume-polish.mjs` trims only that category, only items the posting did not
name, never its first three. When the page spills, a whole category (the one
the posting asked least of) goes before a bullet does — a bullet beats a longer
list (his answer, 2026-09-23) — and two categories always stay.

**Every line is used to the edge** (2026-09-23): "if two lines use fully, it
helps with keywords hit and also looks fuller". After the page fits, each skills
line and a two-line coursework line are topped up from the pool — what the
posting names first — while the line count stays the same. Activity phrases and
AI buzzwords fill a line only when the posting uses them.

Four categories, printed as the posting needs them: **CAD/CAE**,
**Automation/Software**, **Manufacturing**, **Process/Quality** — plus
**AI Tools**, which is in the pool but on no family's default list and prints
only when a posting asks for that work.

What changed on 2026-09-22, in his words — *"problem solving and process
engineering is kinda same thing and skills overlap, also semiconductor exposure
is not a damn real skill, too much fluff and bullshit, it should be hard skills
and techniques and methodologies not buzzwords"*:

- **Problem Solving merged into Process/Quality.** One subject under two
  subtitles, and both printed, so the section read as padding.
- **Semiconductor exposure deleted.** Semiconductor Manufacturing, Metal
  Deposition, Etch and Dielectric Deposition are where he worked, not things he
  can do. They stay in the AMAT bullets, so a semiconductor posting still
  matches on them. Cleanroom moved to Manufacturing, where it is a real
  qualification.
- **Items moved to the subtitle that owns them:** Tolerance Stack-Up and Design
  Review to CAD/CAE, Excel to Automation/Software.

**Hard skills, techniques and methodologies only** — a tool, a process, a
method, a language, a platform. Not a domain he has been near, not a quality he
claims to have. Selection is the point: the pool is long so that a posting can
be answered specifically, and the two-lines-per-category limit is what forces the choice.

## 8. Decide, don't ask

The model is told to decide everything itself: which bullet, which title,
which skill, which project. A run never stops to ask which wording he
prefers. What it decided is written to the sidecar and shown to him on the
Resumes tab and in the Review & Send panel before he presses anything.

## 9. Where the rules are enforced

| Rule | Where |
|---|---|
| Pool text matches `cv.md` word for word | `resume-variants.mjs` `verifyPoolAgainstCv`, fails the build |
| Plan reduced to the pool, staples, floors, own-company title | `resume-plan.mjs` `applyPlan` |
| Sentence guard: numbers, entities, vocabulary, length, weak verbs, forbidden claims | `resume-tailor.mjs` `checkRewrite` |
| One page, balanced margins, orphan tails, text layer | `resume.mjs` `fitToPage`, `balance`, `orphanTails`, `textLayer` |
| Fit loop, orphan pass, sidecar | `resume-for-job.mjs` |
| Form titles match the PDF | `apply-plan.mjs` `planForm` with `titles` from the built spec |

## 10. The page is measured, then the sheet — nothing ships on "it exported"

Since 2026-09-06 (his instruction, after a side-by-side with a resume built
elsewhere), content and layout are decided together and every build ends in
a visual check of the PDF itself:

- **Measured on the DOM** after the page is fitted (`jarvis/resume-qa.mjs`):
  lines per bullet, the width and word count of each last line, each Skills
  line's second line, section gaps, content top and bottom, fill.
- **Fixed in this order** (`jarvis/resume-polish.mjs`): a spill → a short
  form, then the weakest line; a four-line bullet → the model compresses it
  (same facts, fewer words) inside the fabrication guard, a base takes the
  short form; a stub last line → reworded, else the short form; a Skills
  line whose second line is a stub → reordered (measured), then given more
  of its category from the pool, then one item dropped (the one already
  named in a bullet first); a short page → the next reserve bullet. Never
  the font. The spread of the leading is capped at 1.30 so a short page is
  filled with content, not air.
- **Proven on the sheet**: the PDF is rasterised at 200 dpi through pdf.js
  (`Alex Rivera Resume.png` beside the PDF), the ink's box read off it, and the
  checklist run: one page, ~11 pt, text layer intact, no clipping, no
  overflow, no orphan words, no isolated skill, no unnecessary 4-line
  bullets, no tiny fragments, balanced whitespace, ≥93% utilization, clean
  Skills, consistent spacing, PDF inspected. `qa.json` / the audit sidecar
  carry it; `build-resumes` exits non-zero when a base fails it; the side
  panel shows what failed beside the PDF.
- Hyphenated compounds ("pin-alignment") never break at the hyphen, so the
  text layer keeps the keyword whole.

## 11. What to take from cv.md, and what to leave

His instruction, 2026-09-22: *"both in content format and what to include and
what not to from cv md, everything on resume should earn its keep"*. Written
from the audit of the 50 most recently sent resumes and a cold read of the built
page by a reader with no prior context.

**A line earns its keep when a stranger, reading only this page against this
posting, is more likely to call him because of it.** Not "is it true" — every
line is true. Not "is it impressive" — the fixture is impressive on every page
and on most of them it is not the argument.

### Take

- **The thing the posting is about, first.** The cold read found the strongest
  line on an automation page — *"Installed a UR collaborative robot into an
  automated leak-testing cell"* — sitting sixth of six. *"If I had spent twenty
  seconds instead of three minutes, I'd have binned it."* Order is not
  decoration; the first two bullets are what most readers see.
- **Work with a number attached to it**, where the number is his: the 70% jam
  reduction, the 36% packaging cut. Not the $57,000 unless the causal chain is
  on the page — a cold reader called that one *"the line most likely to fall
  apart"* on a call, because a parsing macro does not save material.
- **Evidence from a SECOND employer.** Two employers saying he improves a
  process is worth more than a sixth sentence about the first.
- **The gate answers**: when he can start, that he will move. One line, from his
  own answer bank, and it clears three requirements on a typical posting.
- **Hands-on fabrication on any hardware role.** Haas mills, MIG/TIG, press
  brake. The cold read: *"this person can actually work on a machine, which most
  new-grad resumes cannot claim."*

### Leave

- **The second half of a project already on the page.** `amat.robodk` and
  `amat.cobot-install` are one UR leak-test cell; printing both reads as
  inflation, not as two projects. `ONE_OF` in `resume-plan.mjs` holds the list.
- **The tool nobody asked for.** Neuro-T is a real thing he built and it is
  unexplained jargon to a reader hiring for deployment. A named tool earns its
  place when the posting names it or when the sentence explains it.
- **A second bullet about the same system.** The fixture and the vision model
  are one inspection system. Both may appear — he asked for that — but a lane
  that prints both must have room for them.
- **Coursework projects on a role with real experience to show.** The piston FEA
  animation is a course exercise beside two internships.
- **A skills row that is a recitation.** At most two printed lines per category; a keyword
  list earns less of the page than a sentence carrying evidence. See §7.
- **A domain as a skill.** "Semiconductor exposure" was a category until
  2026-09-22. Where he worked belongs in a bullet, where it is evidence.
- **Anything the posting never asks for, once the page is full.** Measured: the
  sent resumes carry 23-33 terms per page with no counterpart in their JD, while
  covering 49% of what the JD actually names. The excess is not neutral — it is
  occupying the lines the coverage needs.

### How to tell, mechanically

`node jarvis/jd-terms.mjs --jd <file> --resume <file>` names both directions: what
the posting asked for and the page does not say, and what the page carries that
was never asked for. It prints beside the writer's own coverage number, which is
a paraphrase of the requirements and reliably higher.

**A posting that names nothing concrete scores `null`, not 0%** — 13 of the 50
audited postings are marketing prose, and scoring those zero would condemn a
resume that fits.
