---
name: jarvis-setup
description: >
  Set up Jarvis Jobs for a new user by interviewing them, one topic at a time:
  their AI tool and plan, their background, their job goals and how they want
  to work. Writes their answers into their own gitignored files with
  `jarvis/setup.mjs` after they confirm a summary, then builds cv.md and the
  resume pool from their resume, fills the application profile with them,
  finds companies, and ends with the first scan, the dashboard and the browser
  extension. Use on a fresh clone (no config/profile.yml: start it yourself,
  without being asked), when `node jarvis/setup-check.mjs` reports anything
  missing, or when the user says "set me up" or wants to change their answers.
---

# /jarvis-setup: the new-user interview

You are setting up a job-search engine for the person in front of you. Every
fact you write goes onto real job applications, so the one rule above all
others: **write only what they tell you.** Never invent, estimate, round up or
"fill in something reasonable". A blank is fine; the engine leaves a blank for
them with the reason. A made-up answer is not fine.

## How to run it

1. **Check first.** `node jarvis/setup-check.mjs --json`. With no
   `config/profile.yml`, start at section 1. Otherwise skip what is set up and
   pick up where they left off; to change earlier answers see "Changing
   answers later" at the end.
2. **Open with two sentences** on what Jarvis does (it finds postings at the
   companies they track, sorts them against their rules, tailors a resume per
   posting from their CV, and fills application forms in their browser, but
   never presses Submit or sends anything for them), then start.
3. **One topic per turn, in the order below.** Ask a short batch (3–6
   questions). Use AskUserQuestion (Claude Code) when the answers are choices,
   plain questions when they are free text. Offer "skip for now" on everything
   setup does not require. Explain a choice when they ask; never pick for them.
4. **Keep their files out of git.** Every file below is already gitignored;
   never `git add` one, never move personal data into a tracked file.
5. **Never press Submit** on anything, never send a message for them, and
   never tell them the engine will.

Collect sections 1–4 into `data/jarvis/setup-answers.json`, keys exactly as
in `QUESTIONS` in `jarvis/setup.mjs` (read it: each `ask` is the question,
`choices` the allowed values, `required` what setup refuses to run without).

## 1. Their AI and plan

- **Which assistant** (`llm`): `claude` if they use Claude Code, `codex` if
  Codex. This is what writes their resumes, answers and letters and reads new
  postings every day.
- **Which plan** (`ai_plan`): `claude-pro`, `claude-max`, `claude-api` (an
  API key, billed per use), `chatgpt-plus`, `chatgpt-pro`,
  `chatgpt-business`, or `other`. Tell them what it changes
  (`AI_PLANS` and `USAGE` in `jarvis/targeting.mjs`): on a smaller plan or a
  pay-per-use key the daily search reads fewer postings (up to 10 picks a
  run, 25 kept open, instead of 20 and 50) so it does not eat their usage
  limit; on an API key the writers try the cheaper model first. If they
  share the plan with other heavy use, suggest the smaller setting.
- Ask if they have used Claude Code or Codex before. If not, tell them they
  can just talk to you; every command below is yours to run.

## 2. Their background

- **Contact**: name as they go by it, legal first and last name, email,
  phone, city, state, ZIP, LinkedIn, portfolio or website.
- **Education**: school, degree, level (`bachelor`, `master`, `phd`),
  major(s), graduation month and year, GPA (optional).
- **Work authorization** (`work_authorization`): `citizen`,
  `permanent_resident`, `f1`, `visa` (another work visa),
  `no_sponsorship_needed`, and country of citizenship. This decides the visa
  screen: someone who needs sponsorship does not see postings that rule it
  out. If they are unsure, explain the choices and let them pick.
- **Experience, projects and skills**: ask for their current resume now (a
  file path, or paste it), and ask what is NOT on it: other jobs, projects,
  tools, numbers. Keep notes; section 6 turns them into `cv.md`.

## 3. Their job goals

- **Field** (`preset`): `hardware-engineering` (mechanical, manufacturing,
  robotics, semiconductor) or `finance-data` (FP&A, financial, data,
  business, BI analyst). If neither fits, say so: a new preset is a copy of
  one of these (SETUP.md, "Adding a field").
- **Target job titles** (`target_roles`), and the **level**
  (`seniority`: `internship`, `new_grad`, `entry`, `experienced`).
- **Where**: preferred cities (`preferred_cities`), `work_mode` (`onsite`,
  `hybrid`, `remote`, `any`), willing to relocate.
- **Pay**: the lowest salary they would take (`salary_minimum`, the hard
  floor) and what they are aiming for (`salary_target`).
- **When**: `start_date`, in their words.
- **Companies**: ones they most want (`target_companies`: tracked first and
  ranked up) and ones to stay away from (`avoid_companies`: ranked down, never
  hidden).
- **Dealbreakers** in their words (`dealbreakers`). After setup runs, turn
  each into a rule in `jarvis/preferences.md` with them (one rule per line:
  `never`, `avoid`, `prefer`, `want`, with `in title` / `in location` /
  `in company`; `never` only for what they cannot or will not accept,
  `avoid` for taste).

## 4. How they want to work

- **How often** they will look at new picks (`check_in`: `daily`,
  `few_times_a_week`, `weekly`) and **how many applications a week** they are
  aiming for (`applications_per_week`, or none).
- **How much it writes for them** (`help_level`): `fill_only` (it fills the
  fields and attaches the resume; they write every open-ended answer) or
  `fill_and_write` (it also drafts those answers from their CV, for them to
  read and change). With `fill_only` the dashboard refuses to write an answer
  and says why. Cover letters are only ever made when they ask for one.
  Either way they review every form and press Submit themselves.
- On a smaller plan, also suggest lowering "New fits added each scheduled
  search" in the dashboard's settings (default 10): those extra reads use the
  AI too.
- On Windows, ask whether to add the scheduled search
  (`powershell -File jarvis/register-daily-search.ps1`, 7:30 AM and 5:10 PM).
  Elsewhere the dashboard's own search runs every 6 hours while it is open.

Read `working_style` in `config/profile.yml` at the start of later sessions
and work the way it says: how often to bring up new picks, the weekly goal
(`node jarvis/application-pace.mjs` shows their applications a day), and whether to draft answers.

## 5. Confirm, then write

Write the answers file, then show them the summary without writing anything:

```bash
node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --dry-run
```

Read it back in plain words and fix what they correct. When they say it is
right:

```bash
node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --find-boards
```

It writes `config/profile.yml` (who they are, goals, plan, working style),
`data/jarvis/apply-profile.yml`, `jarvis/preferences.md` and `portals.yml`,
then tracks the job boards of the companies they named and the field's
starter companies it can verify. If it refuses an answer, ask again for that
one. Read the rules in `jarvis/preferences.md` back in plain words, turn
their dealbreakers into rules, and change what they disagree with.

## 6. Their CV → `cv.md` (the source of truth)

- Convert their resume faithfully to Markdown (`examples/cv.example.md` shows
  the shape): every role, date, bullet, number and skill exactly as they
  wrote it, plus what they told you in section 2.
- Then go role by role and project by project and ask for **more**: what they
  did, the tools, the numbers, what went wrong and what they did about it.
  `cv.md` should hold everything they would defend in an interview; it is
  longer than a resume on purpose, because the resume builder selects from it.
- Ask for evidence for every number. If they cannot back a figure, leave it
  out. If they "used" a tool, do not write that they "built" it.
- Optional, ask once: a one-page resume in their own words → `cv-short.md`;
  stories they would tell in an interview → `interview-prep/stories.md`.

## 7. Resumes → `jarvis/resume-pool.json`

Build the pool from `cv.md` by following `jarvis/RESUME-POOL.md`. Every
bullet's `text` is copied **verbatim** from `cv.md`; `npm run jarvis:resumes`
refuses a pool that has drifted. Ask which experience should lead and which is
least important. Then `npm run jarvis:resumes`, show them the PNG beside each
PDF, and ask what to change.

## 8. Application profile → `data/jarvis/apply-profile.yml`

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

## 9. More companies → `portals.yml`

- Ask for more companies they want (any number):
  `npm run jarvis:discover -- --names "A,B,C" --write`.
- Offer the wider passes and run the ones they want:
  `npm run jarvis:discover-linkedin -- --write` (companies hiring in their
  field), `npm run jarvis:discover-sources` (Built In, HN, YC, The Muse,
  Climatebase), and for hardware `npm run jarvis:discover -- --seeds hardware --write`.
  On a smaller plan, say these cost no AI usage; the daily reading does.
- A board found by NAME is a claim. The finder lists "thin boards" (under 10
  postings) at the end; those are usually a different company with the same
  name. Turn them off with
  `npm run jarvis:disable-board -- "<name>" --why "<reason>"`, and read the
  titles on new boards with
  `npm run jarvis:audit-boards -- --since <copy of portals.yml before>`.

## 10. First run

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

## Changing answers later

When they want to change something (a new plan, a new city, a company to
avoid), read `data/jarvis/setup-answers.json`, change only what they said,
show the `--dry-run` summary, and on their yes run:

```bash
node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --update
```

`--update` keeps what was added since (work history, narrative, every rule in
`preferences.md`), adds only the new answers' rules, and keeps a
`.bak-<date>` copy of each file it changes. A blank answer never clears a
value already there; to remove one, edit the file with them. Then
`npm run jarvis:rescore`.
