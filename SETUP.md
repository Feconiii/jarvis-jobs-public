# Setting up your own Jarvis Jobs

> **Faster with an assistant:** open the folder in Claude Code or Codex and say
> *"set me up"* (or type `/jarvis-setup` in Claude Code). It runs the steps
> below as an interview and writes each file with you. `npm run
> jarvis:setup-check` shows what is left at any point.

About 20 minutes to a working dashboard. The files you write about yourself
(steps 3–5) are what make it good; give them the time.

Everything personal lives in files git ignores — `cv.md`, `portals.yml`,
`config/`, `data/`, `jarvis/preferences.md`. Nothing you write about yourself
is committed unless you change `.gitignore`.

## 1. Requirements

- **Node.js 24 or newer** (the store uses the built-in `node:sqlite`).
- **A Chromium browser** — Chrome, Edge, Brave or Opera — for the extension.
- **Claude Code** (`claude` on your PATH, signed in) **or Codex** (`codex` on
  your PATH, `codex login` done once) for the writers: tailored resumes,
  application answers, cover letters and the daily curation. Setup asks which
  one you have. Without either, discovery, triage, scoring, the dashboard and
  form filling all still work; the writing features say they are unavailable.
- Windows, macOS or Linux. The desktop shortcut helper is Windows-only.

## 2. Install

```bash
git clone <this repo> jarvis-jobs
cd jarvis-jobs
npm install
npx playwright install chromium     # used for liveness fallbacks and resume rendering
cp .env.example .env                # optional settings, all commented out
```

## 3. Run setup

```bash
npm run jarvis:setup -- --find-boards
```

It asks who you are and what you want: name, contact details, school, degree,
major, graduation, **field** (`hardware-engineering` or `finance-data`), target
titles, **work authorization** (`citizen`, `permanent_resident`, `f1`, `visa`,
`no_sponsorship_needed`), pay floor, cities, your level, on-site or remote,
start date, companies to aim at or avoid, dealbreakers, which assistant you
have (`claude` or `codex`) and **its plan**, and how you want to work (how
often you check, applications a week, whether it drafts open-ended answers).
It prints a summary, then writes:

| File | What it holds |
|------|---------------|
| `config/profile.yml` | who you are, your field (`targeting.preset`), your assistant and plan (`targeting.llm`, `targeting.plan`, `targeting.usage`), target roles, pay floor, `goals`, `working_style` |

The plan sets `targeting.usage`. On `light` (Claude Pro, an API key, ChatGPT
Plus, or "other") the daily search files up to 10 picks a run and keeps 25
open; on `standard` (Claude Max, ChatGPT Pro or Business) it files up to 20
and keeps 50. On an API key the writers try Haiku before Sonnet. You can
change any of these in `config/profile.yml` by hand.
| `data/jarvis/apply-profile.yml` | the answers forms are filled with: identity, education, work authorization |
| `jarvis/preferences.md` | starter rules for your field, in plain English |
| `portals.yml` | the companies you track (empty, then filled by `--find-boards`) |

`--find-boards` looks up the job boards of your field's starter companies and
tracks the ones it can verify. `--force` rewrites existing files (each is kept
as a `.bak-<date>` first). An assistant runs the same thing non-interactively:
`node jarvis/setup.mjs --answers <answers.json> --find-boards`. Your answers are
kept in `data/jarvis/setup-answers.json`; to change one later, edit it and run
`node jarvis/setup.mjs --answers data/jarvis/setup-answers.json --update`,
which keeps what you added since. `--dry-run` prints the summary and writes
nothing.

Work authorization decides the visa screen: a citizen is never hidden from a
"U.S. citizens only" or "no sponsorship" posting; someone who needs
sponsorship sees those flagged and hidden from the shortlist.

## 4. Your CV — the source of truth

```bash
cp examples/cv.example.md cv.md
```

Write **everything** you are willing to be asked about in an interview:
every role, project, tool and number. Everything Jarvis writes for you —
resumes, answers, letters — is taken from this file and checked against it.
It selects and rewords; it never invents. A skill missing from `cv.md` never
appears in anything it writes, which is the point.

Optional companions, used when present:

- `cv-short.md` — your one-page resume in your own words; resume bullets may
  use a shorter sentence only if it appears here.
- `interview-prep/stories.md` — longer first-person stories the answer writer
  may draw on.

## 5. Your application profile

Setup wrote `data/jarvis/apply-profile.yml` with your identity, education and
work-authorization answers. Open it and fill the rest with your own values:
work history (from `cv.md`), languages, standard answers, consents and
voluntary self-identification (`examples/apply-profile.example.yml` shows every
key). This is what the extension types into forms. **Leave a key empty rather
than guess**: an empty key leaves that field for you, with the reason. The
self-identification answers start blank and are yours alone to fill.

## 6. What you want

- **`config/profile.yml`**: your target roles and compensation floor, which
  the fit scorer weighs. Setup wrote it; edit it any time.

- **`portals.yml`**: the companies you track. `--find-boards` started it with
  your field's starter companies. Add more without typing boards by hand:

  ```bash
  npm run jarvis:discover -- --names "Company A,Company B" --write   # resolve names to verified boards
  npm run jarvis:discover -- --seeds hardware --write               # a curated hardware seed list
  npm run jarvis:discover-linkedin -- --write                       # companies hiring in your field
  npm run jarvis:discover-sources                                   # Built In, HN, YC, The Muse, Climatebase
  ```

  A board found by name is a claim: the finder lists "thin boards" (under 10
  postings) at the end, which are usually a different company with the same
  name. Turn those off with `npm run jarvis:disable-board -- "<name>" --why
  "<reason>"`.

  Read the titles on any board you just added (`npm run jarvis:audit-boards --
  --since <an older copy of portals.yml>`): a name can resolve to a different
  company with the same name, or to a recruiting agency.

- **`jarvis/preferences.md`**: plain-English rules the fit scorer reads every
  run (`never night shift`, `prefer in location Austin`). Setup started it
  with your field's rules; `examples/preferences.example.md` explains the
  syntax. Edit it any time and run `npm run jarvis:rescore`.

## 7. First scan

```bash
npm run jarvis:scan          # every tracked company's board
npm run jarvis:enrich        # full descriptions, so visa and degree language is read
npm run jarvis:serve         # the dashboard at http://localhost:4300
```

Leave the dashboard running. While it is up it rescans every 6 hours, reads
new descriptions in the background, retires postings that return 404/410, and
— when you have fewer than 50 open picks — reads new postings in full and
files the ones that fit into your Inbox with a reason (`npm run jarvis:curate`
does the same by hand; `-- --dry-run` shows what it would do).

On Windows, `npm run jarvis:shortcut` puts a **Jarvis Jobs** launcher on the
desktop.

## 8. The browser extension

1. Open `chrome://extensions` (or your browser's equivalent) and turn on
   **Developer mode**.
2. **Load unpacked** → choose the `jarvis/extension` folder.
3. Keep the dashboard running — the extension talks to `localhost:4300`.

On an application page, press the **Jarvis Apply** toolbar button. It fills the
form, attaches the resume tailored for that posting, writes the open-ended
answers from your CV, and stops at Submit. The side panel (a docked panel in
browsers without one, such as Opera) shows what was filled, what was written,
what is left for you, and lets you ask Claude about any question.

After you pull an update, reload the extension on the extensions page; the
dashboard tells you when the loaded extension is out of date.

## 9. Resumes

The resume builder selects bullets from `jarvis/resume-pool.json`, a pool
whose every sentence must appear verbatim in your `cv.md`, or the build
refuses to run. `jarvis/RESUME-POOL.md` says how to build it from your CV (an
assistant can do it for you), and `examples/resume-pool.example.json` shows
the shape:

```bash
cp examples/resume-pool.example.json jarvis/resume-pool.json
```

It holds your name and education, each employer (with one title per resume
family: total-experience, automation, manufacturing, mechanical), each bullet
as `{ "lead", "text" }` copied exactly from `cv.md`, projects, and skill
groups. A bullet may add `"short"` (a sentence from `cv-short.md`) or
`"long"` (a longer sentence from `cv.md`) for tight or roomy layouts.

The layouts (which bullets lead, how many per employer, what is trimmed first)
are in `jarvis/resume-variants.mjs` and `jarvis/resume-plan.mjs`. In this copy
they name the sample persona's employers (`amat`, `acme`, `makerspace`,
`rover`, `sae`) — replace those keys with your own. `npm run jarvis:resumes`
builds the family resumes and runs the layout check; look at the PNG it writes
beside each PDF before trusting a layout.

## 10. Optional

- **Gmail** — Applications → Connect Gmail, with your own Google OAuth client.
  Read-only; it moves a card forward on a confirmation, interview or
  rejection email and never sends anything.
- **Adzuna** — set `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` in `.env` for one more
  discovery source.
- **Backups** — `npm run jarvis:backup` copies your decisions and hand-written
  files to `jarvis-backup/`.
- **Scheduled search (Windows)** — `powershell -ExecutionPolicy Bypass -File
  jarvis/register-daily-search.ps1` adds the task "Jarvis Daily Job Search"
  (7:30 AM and 5:10 PM, or as soon as the machine wakes). It runs at
  below-normal priority and logs to `data/jarvis/daily-search.log`. The
  dashboard also runs the same search every 6 hours while it is up.
- **H-1B record** — if you need sponsorship, download the newest "LCA
  Disclosure Data" file from dol.gov's foreign-labor performance page in your
  browser (the site refuses scripts) into Downloads. The daily pass imports it
  (`npm run jarvis:lca -- <file.xlsx>` does it by hand), and the cards show
  each employer's petition count.
- **Outreach and the LinkedIn tool** — the Outreach tab works without any
  sign-in (public pages only). For Claude Code's signed-in LinkedIn tool,
  install `uv` (`uvx` on your PATH); `.mcp.json` starts it and Claude Code asks
  before enabling it. Every call goes through `jarvis/linkedin-mcp-guard.mjs`
  (attached in `.claude/settings.json`): read-only, 20–30 s apart, logged to
  `data/jarvis/linkedin-mcp-usage.jsonl`. Messages are sent only by you, from
  the Outreach tab's Send all or a send you schedule with
  `node jarvis/send-outreach.mjs --at "<day> <time window>"`.
- **OneDrive copy** — off. `resumes.onedrive: on` (or a folder in
  `resumes.onedrive_dir`) in `config/profile.yml`, or `JARVIS_ONEDRIVE=on` in
  the environment the dashboard starts in, copies each built resume to your
  OneDrive folder; `npm run jarvis:onedrive` copies once by hand.

## 11. Tests

```bash
npm run jarvis:test            # everything that runs on a fresh clone (fixtures only)
npm run jarvis:test:personal   # suites written against the original user's files
npm run jarvis:test:e2e        # the end-to-end extension test
```

Tests never read your setup: they run as the sample persona with the
`hardware-engineering` preset, so they pass the same on every machine.
`JARVIS_PROFILE=jarvis/presets/finance-data/test-profile.yml` runs a command
as a made-up finance user instead. `jarvis:test:personal` checks the original
user's own CV, bullet pool and sent answers, so it fails on any other copy;
it is there to show what those suites check.

## Adding a field

A preset is four files in `jarvis/presets/<name>/`: `screen.mjs` (title and
degree words, the curator brief), `discovery.mjs` (searches, metros, which
employers to skip), `writing.mjs` (how resumes and answers describe the work)
and `index.mjs` (label, default titles, starter companies, starter rules).
Copy `finance-data`, change the words, and keep the same keys:
`node --test jarvis/targeting.test.mjs` checks that every preset has the same
shape.

## Rules the engine keeps

- **Submit is always yours.** No path in the code presses it.
- **Flags, never drops.** Anything that hides a posting says why, and every
  hide can be undone.
- **Nothing invented.** Every claim written for you traces to `cv.md` (and the
  optional files above); a gap is left as a gap.
- **Liveness is decided by the ATS API**, never by a search snippet.
