# Jarvis Jobs

A private job-search platform. It finds postings across company job boards,
sorts them without hiding anything silently, scores fit against your own CV,
and fills application forms in your browser while stopping at the Submit button.

This copy is set up for **one person: whoever ran setup on this machine.**
Everything about them lives in files git never sees (listed below). The code
is shared and updated with `git pull`. A pull never touches those files.
The person you are talking to may never have used a coding assistant: talk
plainly, run the commands yourself, and explain what you did in a sentence.

## First run: setup (do this before anything else)

At the start of every session run `node jarvis/setup-check.mjs` (built-ins
only; works before `npm install`). In Claude Code a SessionStart hook in
`.claude/settings.json` runs it for you and puts the result in front of you.

**If `config/profile.yml` does not exist, this person has not been set up.
Start the setup interview yourself, before anything else and without waiting
to be asked:** greet them, say in two sentences what Jarvis does, and begin.
If the check lists anything else missing, offer to finish it. Do not scan,
build resumes or fill forms for someone whose `cv.md` and
`data/jarvis/apply-profile.yml` are not theirs yet.

The interview is `.claude/skills/jarvis-setup/SKILL.md` (`/jarvis-setup` in
Claude Code; in any other assistant, read that file and follow it). It asks
**one topic at a time**, in this order:

1. **Their AI and plan**: Claude Code or Codex, and which subscription or
   plan (Claude Pro, Max, an API key; ChatGPT Plus, Pro, Business). The plan
   sets how much the daily search reads (`USAGE` in `jarvis/targeting.mjs`)
   and, for Claude, which model the writers try first.
2. **Their background**: contact details, education, work authorization,
   location, and their resume with the experience, projects and skills it
   leaves out.
3. **Their job goals**: field, target titles, level, cities or remote, pay
   floor and target, start date, companies to aim at or avoid, dealbreakers.
4. **How they want to work**: how often they check, applications a week, and
   whether it drafts open-ended answers or only fills fields.

Then, in order:

0. If `node_modules` is missing, `npm install`.
1. **Write their answers** to `data/jarvis/setup-answers.json` (keys exactly
   as in `QUESTIONS` in `jarvis/setup.mjs`), show them the summary
   (`node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --dry-run`),
   and when they confirm it run:
   `node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --find-boards`
   (`npm run jarvis:setup` asks the same questions in the terminal instead.)
2. **Turn their dealbreakers into rules** in `jarvis/preferences.md` with
   them (setup leaves them there as a comment in their words).
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

**Changing answers later** (a new plan, city, goal): edit
`data/jarvis/setup-answers.json` with them, show the `--dry-run` summary, then
run setup with `--update` instead of `--find-boards`. It keeps everything
added since and backs up each file it changes.

## How the pieces fit

- **Scanner** (`jarvis/scan.mjs`, `providers/`): reads the job boards of every
  company in `portals.yml` straight from their applicant-tracking systems
  into the store, `data/jarvis/jobs.db`.
- **Triage and fit** (`jarvis/triage.mjs`, `jarvis/visa.mjs`, `jarvis/fit.mjs`):
  flags seniority, visa, clearance, degree, pay and location on every posting
  and scores it against `jarvis/preferences.md`. It flags; it never drops.
- **Curator** (`jarvis/curate.mjs`): the daily search. The AI reads new
  postings in full against their rules and files the keepers to the Inbox
  with a reason. How much it reads is their plan's usage level.
- **Dashboard** (`npm run jarvis:serve`, http://localhost:4300): Inbox,
  library, Applications board, Outreach. While it is open it scans and runs
  the daily search every 6 hours.
- **Resumes** (`jarvis/build-resumes.mjs`, `jarvis/resume-pool.json`): one
  tailored PDF per posting, built only from bullets copied from `cv.md`.
- **Browser extension** (`jarvis/extension`): on an application page it fills
  every field from `data/jarvis/apply-profile.yml`, attaches the resume,
  drafts open-ended answers from `cv.md` (when their working style says to),
  and stops at Submit.

## A normal day

1. The dashboard (or the scheduled search on Windows) has scanned and filed
   new picks to the Inbox.
2. They read the picks; a heart moves one to the Applications board's
   Tracking column; hiding one asks why, and that reason trains the ranking.
3. They open a pick's application page and press **Jarvis Apply** in the
   extension. It fills the form; they read it, fix what they want, and press
   Submit themselves.
4. Replies (with Gmail connected) move the card along the board.

Read `working_style` in `config/profile.yml` at the start of a session and
work that way: bring up new picks as often as `check_in` says, keep
`applications_per_week` in view (`node jarvis/application-pace.mjs`), and
draft open-ended answers only when `help_level` is `fill_and_write`.

## Their files (never commit, never print in full, never copy elsewhere)

| File | What it is |
|------|------------|
| `config/profile.yml` | who they are, their goals, AI plan and working style (setup writes it) |
| `data/jarvis/setup-answers.json` | their interview answers, for re-running setup with `--update` |
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
