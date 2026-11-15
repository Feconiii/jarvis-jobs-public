# Jarvis Jobs

A private job-search platform. It finds postings across company job boards,
sorts them without hiding anything silently, scores fit against your own CV,
and fills application forms in your browser while stopping at the Submit button.

This copy is set up for **one person: whoever ran setup on this machine.**
Everything about them lives in files git never sees (listed below). The code
is shared and updated with `git pull`. A pull never touches those files.

## First run: setup (do this before anything else)

At the start of a session run `node jarvis/setup-check.mjs` (built-ins only;
works before `npm install`). If `config/profile.yml` does not exist, the person
has not been set up yet; if the check lists anything else missing, offer to
finish it. Do not scan, build resumes or fill forms for someone whose `cv.md`
and `data/jarvis/apply-profile.yml` are not theirs yet. Do this, in order
(Claude Code also has the same interview as `/jarvis-setup`,
`.claude/skills/jarvis-setup/SKILL.md`, with more detail per section):

0. If `node_modules` is missing, `npm install`.
1. **Interview them.** Ask, in plain conversation, for every field listed in
   `QUESTIONS` in `jarvis/setup.mjs`: name, legal name, email, phone, city,
   state, ZIP, LinkedIn, portfolio, school, degree, degree level, major,
   graduation, GPA, field (`finance-data` or `hardware-engineering`), target
   job titles, work authorization (`citizen`, `permanent_resident`, `f1`,
   `visa`, `no_sponsorship_needed`), citizenship country, salary floor and
   target, preferred cities, relocation, which AI this machine has (`codex`
   or `claude`). Ask where their resume file is.
2. **Write their answers** to `data/jarvis/setup-answers.json` (keys exactly as
   in `QUESTIONS`) and run:
   `node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --find-boards`
   (`npm run jarvis:setup` asks the same questions in the terminal instead.)
3. **Write `cv.md`** from their resume. Convert it faithfully to Markdown:
   every role, date, bullet, number and skill exactly as they wrote it.
   Invent nothing, add nothing, improve nothing. If something is unclear, ask.
4. **Build `jarvis/resume-pool.json`** from `cv.md` by following
   `jarvis/RESUME-POOL.md`. Every bullet is copied verbatim from `cv.md`;
   `npm run jarvis:resumes` refuses to render a pool that has drifted.
5. **Fill `data/jarvis/apply-profile.yml`**: `work_experience` from `cv.md`,
   and go through every answer with them. Leave `eeo` to them: blank means the
   form question is left for them to answer.
6. **Find more companies:** `npm run jarvis:discover -- --names "A,B,C" --write`
   for companies they name; `npm run jarvis:discover-linkedin -- --write`
   finds hiring companies in their field. A board found by NAME is a claim:
   the finder lists "thin boards" (under 10 postings) at the end, which are
   usually a different company with the same name. Turn those off with
   `npm run jarvis:disable-board -- "<name>" --why "<reason>"`, and read the
   titles on new boards with `npm run jarvis:audit-boards`.
7. **Codex:** if `targeting.llm` is `codex`, they run `codex login` once.
   Until then every resume, answer and letter fails with "Codex is not
   logged in".
8. `npx playwright install chromium`, `npm run jarvis:scan`, then
   `npm run jarvis:serve` and open http://localhost:4300.
9. **The extension:** their browser's extensions page → Developer mode →
   **Load unpacked** → `jarvis/extension`. On an application page **Jarvis
   Apply** fills the form, attaches the tailored resume and stops at Submit.

## Their files (never commit, never print in full, never copy elsewhere)

| File | What it is |
|------|------------|
| `config/profile.yml` | who they are and what they want (setup writes it) |
| `data/jarvis/apply-profile.yml` | form answers |
| `data/jarvis/` | the job store and everything the dashboard saves |
| `cv.md`, `cv-short.md` | their resume, the source of every claim |
| `jarvis/resume-pool.json` | resume bullets, verbatim from `cv.md` |
| `jarvis/preferences.md` | their plain-English job rules (`npm run jarvis:rescore` after editing) |
| `voice-dna.md` | how their writing should sound (optional) |
| `portals.yml` | the companies they track |
| `interview-prep/`, `writing-samples/` | their stories and samples |

## Hard rules

**Fill everything, submit nothing.** The apply engine answers every question,
ticks consent boxes, uploads the resume and stops at Submit. Pressing it is
always the person's call.

**Their files are the only source.** Resumes, form answers, cover letters and
messages are written only from the files above plus what they say in the
current conversation. Reword, reorder and emphasise; never invent a skill,
number, title, tool or project. Never claim they built something their `cv.md`
does not say they built. If a claim isn't in their files, ask; if they can't
back it, leave it out.

**Sorting flags, it never hides silently.** A filter that drops a posting
without saying why is a bug.

**A posting is dead only when the checker says so:** `npm run liveness -- <url>`.
Never decide from a search snippet.

**Nothing is sent to a person without their OK.** Outreach drafts are theirs to
read and change. Never start a send session, schedule a send
(`jarvis/send-outreach.mjs`) or press Send for them unless they said to send
those exact messages. The LinkedIn MCP is for reading; its guard
(`jarvis/linkedin-mcp-guard.mjs`, attached in `.claude/settings.json`) refuses
anything that writes, and you never remove or work around it.

## What each part reads

- `config/profile.yml` → `jarvis/targeting.mjs` → `person` (name, school,
  degree, graduation, work authorization, pay floor, AI) and the **preset**
  (`jarvis/presets/<preset>/`): the field words, degree check, discovery
  searches and curator brief for their field.
- Work authorization decides the visa gate: a citizen is never hidden from a
  "U.S. citizens only" or "no sponsorship" posting; someone who needs
  sponsorship is.
- `targeting.llm: codex` runs the writers through `codex exec` (read-only
  sandbox; research calls add `--search`). Run `codex login` once.
  `JARVIS_LLM=claude` switches back for one run.

## Commands

```
npm install                  # once
npm run jarvis:setup         # first run (or the assistant-led setup above)
npm run jarvis:setup-check   # what is set up and what is left
npm run jarvis:scan          # read every tracked company's board
npm run jarvis:serve         # dashboard at localhost:4300
npm run jarvis:discover -- --names "A,B" --write    # track companies by name
npm run jarvis:discover-linkedin -- --write         # find hiring companies in their field
npm run jarvis:enrich        # pull full descriptions
npm run jarvis:rescore       # after editing preferences.md
npm run jarvis:curate        # read new postings and file the best to their inbox
npm run jarvis:screen        # screen the whole library against their hard rules, no model
npm run jarvis:universe -- daily   # the coverage ledger's daily pass (the dashboard runs it)
npm run jarvis:import-simplify     # Simplify's new-grad listings in their field
npm run jarvis:lca -- <file.xlsx>  # import a DOL LCA file they downloaded (H-1B record)
npm run jarvis:outreach      # outreach leads and drafts (sending is theirs)
npm run jarvis:resumes       # build resume PDFs
npm run jarvis:apply         # fill an application in the browser (never submits)
npm run liveness -- <url>    # is this posting still open
npm run jarvis:test          # the test suite (runs as the sample persona, never as them)
```

README.md and SETUP.md describe the system and the manual setup.

## Updating

`git pull`, then `npm install`. Their files are gitignored, so a pull never
overwrites them. If a pull reports a conflict in one of them, something is
wrong: stop and ask.

## Conventions

Node 24+ (`node:sqlite`), ESM `.mjs`, tests beside the code as `*.test.mjs`.
Run the tests before saying something works.
