---
name: jarvis-setup
description: >
  Set up Jarvis Jobs for a new user by interviewing them. Runs the setup check,
  then asks — section by section — for what the engine needs (goals, work
  authorization, CV, application profile, companies, preferences), writes each
  file as it goes, and ends with the first scan, the dashboard and the browser
  extension. Use on a fresh clone, when `node jarvis/setup-check.mjs` reports
  anything missing, or when the user says "set this up".
---

# /jarvis-setup — the new-user interview

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
3. **Write the file at the end of each section**, show them what you wrote in
   a few lines, and fix what they correct before moving on.
4. **Keep their files out of git.** Every file below is already gitignored;
   never `git add` one, never move personal data into a tracked file.
5. **Never press Submit** on anything, and never tell them the engine will.

## 1. What they are looking for → `config/profile.yml`, `jarvis/preferences.md`

Ask:
- Which roles? (titles, 2–6) Which level — internship, new grad, early career, experienced?
- Which industries or kinds of company do they want, and which do they refuse?
- Where — cities, states, remote, willing to relocate?
- Pay floor (annual), and currency.
- Deal-breakers: night or rotating shifts, heavy travel, on-call, security clearance, specific employers?
- Anything they especially want (a technology, a mission, a company size)?

Write `config/profile.yml` from `config/profile.example.yml` (target roles, pay
floor) and `jarvis/preferences.md` from `examples/preferences.example.md` —
one rule per line in its syntax (`never`, `avoid`, `prefer`, `want`, with
`in title` / `in location`). Prefer `avoid` over `never` for taste; `never` is
for facts they cannot or will not accept. Read the rules back in plain words.

## 2. Work authorization → the `answers:` visa block of the profile

This decides what gets flagged, so get it exactly right. Ask:
- Country of citizenship. Are they authorized to work in the target country now?
- Will they need visa sponsorship now or in the future? Current status
  (citizen, permanent resident, F-1/OPT/STEM OPT, H-1B, other)?
- Have they held H-1B or J-1 status? Could they obtain a security clearance?
- Are they a "U.S. person" under export-control rules (citizen, permanent
  resident, protected individual)?

If they are unsure, say what the question means and let them answer or skip —
do not decide for them.

## 3. Their CV → `cv.md` (the source of truth)

- Ask for their current resume: a file path, or paste it. Turn it into
  `cv.md` using `examples/cv.example.md` as the shape.
- Then go role by role and project by project and ask for **more**: what they
  built, the tools, the numbers, what went wrong and what they did about it.
  `cv.md` should hold everything they would defend in an interview — it is
  longer than a resume on purpose; the resume builder selects from it.
- Ask for evidence for every number. If they cannot back a figure, leave it
  out. If they "used" a tool, do not write that they "built" it.
- Optional, ask once: a one-page resume in their own words → `cv-short.md`;
  stories they would tell in an interview → `interview-prep/stories.md`.

## 4. Application profile → `data/jarvis/apply-profile.yml`

Copy `examples/apply-profile.example.yml` and fill it with them:
- Identity: legal first/last name, the name they go by, email, phone, address,
  city/state/zip/country, LinkedIn, portfolio or website (typed exactly as
  they want it — some want the bare domain), GitHub.
- Education and each education entry (school, degree, field, GPA if they want
  it shown, years); graduation month and year.
- Work history entries (title, company, location, start/end month and year,
  one-line description taken from `cv.md`).
- Languages and proficiency.
- Standard answers: earliest start date, relocation, on-site/remote, how they
  usually hear about jobs, salary expectation wording, notice period, over 18,
  previously employed at / applied to a company (default No), non-compete.
- Skills: a comma-separated list taken from `cv.md` only.
- **Consents — ask explicitly, do not assume:** should the engine tick "I
  agree / I certify" boxes and AI-screening, SMS and talent-community opt-ins
  for them? They still review every form and press Submit themselves.
- **Voluntary self-identification (gender, race, Hispanic/Latino, veteran,
  disability):** entirely optional. Offer to leave every one blank; write only
  what they choose to give, in their words.

## 5. Companies → `portals.yml`

- Copy `examples/portals.example.yml`; set the title, location and salary
  filters from section 1.
- Ask for companies they already want (any number). Resolve them to verified
  boards: `npm run jarvis:discover -- --names "A,B,C" --write`.
- Offer the wider passes and run the ones they want:
  `npm run jarvis:discover -- --seeds hardware --write` (hardware start-ups),
  `npm run jarvis:discover-linkedin -- --write` (companies hiring for their
  titles), `npm run jarvis:discover-sources` (Built In, HN, YC, The Muse,
  Climatebase).
- After adding boards, read their titles:
  `npm run jarvis:audit-boards -- --since <copy of portals.yml before>` — a
  name can resolve to a different company or a recruiting agency.

## 6. Resumes → `jarvis/resume-pool.json`

- Generate the pool from `cv.md` using `examples/resume-pool.example.json` as
  the shape. Every bullet's `text` must be copied **verbatim** from `cv.md`.
- The layouts in `jarvis/resume-variants.mjs` and `jarvis/resume-plan.mjs`
  name the sample persona's employers (`amat`, `acme`, `makerspace`, `rover`,
  `sae`). Replace those keys with the user's org and bullet keys, and ask
  which experience should lead and which is least important.
- `npm run jarvis:resumes` builds the family resumes and runs the layout check.
  Show them the PNG beside each PDF and ask what to change.

## 7. First run

```bash
npm install && npx playwright install chromium   # if setup-check said so
npm run jarvis:scan
npm run jarvis:enrich
npm run jarvis:serve        # http://localhost:4300 — leave it running
```

Then walk them through the extension: open their browser's extensions page,
turn on Developer mode, **Load unpacked** → `jarvis/extension`. On an
application page they press **Jarvis Apply**; it fills the form, attaches the
tailored resume, and stops at Submit.

Optional, ask once: connect Gmail (read-only) from the dashboard so the
Applications board moves by itself; Adzuna keys in `.env`; Windows desktop
shortcut (`npm run jarvis:shortcut`).

## Finish

Run `node jarvis/setup-check.mjs` and show the result. Tell them in plain words
what is set up, what they skipped (and that they can run /jarvis-setup again
any time), and the one thing to do next: open the dashboard's Inbox.
