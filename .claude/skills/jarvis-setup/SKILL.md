---
name: jarvis-setup
description: >
  Set up Jarvis Jobs for a new user by interviewing them. Runs the setup check,
  asks for what `jarvis/setup.mjs` needs (field, work authorization, school,
  graduation, pay floor, cities, assistant), runs it, then builds cv.md and the
  resume pool from their resume, fills the application profile with them, finds
  companies, and ends with the first scan, the dashboard and the browser
  extension. Use on a fresh clone, when `node jarvis/setup-check.mjs` reports
  anything missing, or when the user says "set me up".
---

# /jarvis-setup: the new-user interview

You are setting up a job-search engine for the person in front of you. Every
fact you write goes onto real job applications, so the one rule above all
others: **write only what they tell you.** Never invent, estimate, round up or
"fill in something reasonable". A blank is fine; the engine leaves a blank for
them with the reason. A made-up answer is not fine.

## How to run it

1. **Check first.** `node jarvis/setup-check.mjs --json`. Skip every section
   whose file is already set up; resume where they left off.
2. **One section at a time, in the order below.** Ask a short batch (3–6
   questions) per turn with AskUserQuestion when the answers are choices, plain
   questions when they are free text. Offer "skip for now" on everything that
   is not required.
3. **Show what you wrote** at the end of each section in a few lines, and fix
   what they correct before moving on.
4. **Keep their files out of git.** Every file below is already gitignored;
   never `git add` one, never move personal data into a tracked file.
5. **Never press Submit** on anything, and never tell them the engine will.

## 1. Who they are and what they want → `jarvis/setup.mjs`

Ask for every field in `QUESTIONS` in `jarvis/setup.mjs` (read it; each `ask`
is the question, and `required` marks the ones setup refuses to run without). The ones that change what they see:

- **Field** (`preset`): `hardware-engineering` (mechanical, manufacturing,
  robotics, semiconductor) or `finance-data` (FP&A, financial, data, business,
  BI analyst). If neither fits, say so: a new preset is a copy of one of these
  (SETUP.md, "Adding a field").
- **Work authorization**: `citizen`, `permanent_resident`, `f1`, `visa`
  (another work visa), `no_sponsorship_needed`. This decides the visa screen.
  If they are unsure, explain the choices and let them pick; do not decide for
  them.
- **Graduation** (month and year), degree level, major: the degree and
  graduation-window checks read these.
- **Pay floor**, preferred cities, relocation.
- **Assistant** (`llm`): `claude` if they use Claude Code, `codex` if Codex.

Write the answers to `data/jarvis/setup-answers.json`, keys exactly as in
`QUESTIONS`, and run:

```bash
node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --find-boards
```

It writes `config/profile.yml`, `data/jarvis/apply-profile.yml`,
`jarvis/preferences.md` and `portals.yml`, then tracks the job boards of the
field's starter companies it can verify. If it refuses an answer, ask again
for that one. Read the starter rules in `jarvis/preferences.md` back in plain
words and change what they disagree with (one rule per line: `never`, `avoid`,
`prefer`, `want`, with `in title` / `in location`; `avoid` for taste, `never`
for facts they cannot or will not accept).

## 2. Their CV → `cv.md` (the source of truth)

- Ask for their current resume: a file path, or paste it. Convert it
  faithfully to Markdown (`examples/cv.example.md` shows the shape): every
  role, date, bullet, number and skill exactly as they wrote it.
- Then go role by role and project by project and ask for **more**: what they
  did, the tools, the numbers, what went wrong and what they did about it.
  `cv.md` should hold everything they would defend in an interview; it is
  longer than a resume on purpose, because the resume builder selects from it.
- Ask for evidence for every number. If they cannot back a figure, leave it
  out. If they "used" a tool, do not write that they "built" it.
- Optional, ask once: a one-page resume in their own words → `cv-short.md`;
  stories they would tell in an interview → `interview-prep/stories.md`.

## 3. Resumes → `jarvis/resume-pool.json`

Build the pool from `cv.md` by following `jarvis/RESUME-POOL.md`. Every
bullet's `text` is copied **verbatim** from `cv.md`; `npm run jarvis:resumes`
refuses a pool that has drifted. Ask which experience should lead and which is
least important. Then `npm run jarvis:resumes`, show them the PNG beside each
PDF, and ask what to change.

## 4. Application profile → `data/jarvis/apply-profile.yml`

Setup already wrote identity, education and work authorization. Go through
the rest with them (`examples/apply-profile.example.yml` shows every key):

- Work history entries (title, company, location, start/end month and year,
  one-line description taken from `cv.md`).
- Languages and proficiency.
- Standard answers: earliest start date, relocation, on-site/remote, how they
  usually hear about jobs, salary expectation wording, notice period, over 18,
  previously employed at / applied to a company (default No), non-compete.
- Skills: a comma-separated list taken from `cv.md` only.
- **Consents (ask explicitly, do not assume):** should the engine tick "I
  agree / I certify" boxes and AI-screening, SMS and talent-community opt-ins
  for them? They still review every form and press Submit themselves.
- **Voluntary self-identification (gender, race, Hispanic/Latino, veteran,
  disability):** setup leaves these blank. Entirely optional; write only what
  they choose to give, in their words.

## 5. More companies → `portals.yml`

- Ask for companies they already want (any number):
  `npm run jarvis:discover -- --names "A,B,C" --write`.
- Offer the wider passes and run the ones they want:
  `npm run jarvis:discover-linkedin -- --write` (companies hiring in their
  field), `npm run jarvis:discover-sources` (Built In, HN, YC, The Muse,
  Climatebase), and for hardware `npm run jarvis:discover -- --seeds hardware --write`.
- A board found by NAME is a claim. The finder lists "thin boards" (under 10
  postings) at the end; those are usually a different company with the same
  name. Turn them off with
  `npm run jarvis:disable-board -- "<name>" --why "<reason>"`, and read the
  titles on new boards with
  `npm run jarvis:audit-boards -- --since <copy of portals.yml before>`.

## 6. First run

```bash
npx playwright install chromium   # if setup-check said so
npm run jarvis:scan
npm run jarvis:enrich
npm run jarvis:serve              # http://localhost:4300, leave it running
```

If their assistant is Codex, `codex login` once; until then every resume,
answer and letter fails with "Codex is not logged in".

Then walk them through the extension: open their browser's extensions page,
turn on Developer mode, **Load unpacked** → `jarvis/extension`. On an
application page they press **Jarvis Apply**; it fills the form, attaches the
tailored resume, and stops at Submit.

Optional, ask once: connect Gmail (read-only, with their own Google OAuth
client) from the dashboard so the Applications board moves by itself; Adzuna
keys in `.env`; Windows desktop shortcut (`npm run jarvis:shortcut`).

## Finish

Run `node jarvis/setup-check.mjs` and show the result. Tell them in plain words
what is set up, what they skipped (and that they can run /jarvis-setup again
any time), and the one thing to do next: open the dashboard's Inbox.
