# Setting up your own Jarvis Jobs

> **Faster with Claude Code:** open the folder in Claude Code and say *"set this
> up"* or type `/jarvis-setup`. It runs the steps below as an interview and
> writes each file with you. `npm run jarvis:setup-check` shows what is left at
> any point.

About 20 minutes to a working dashboard. The files you write about yourself
(steps 3–5) are what make it good; give them the time.

Everything personal lives in files git ignores — `cv.md`, `portals.yml`,
`config/`, `data/`, `jarvis/preferences.md`. Nothing you write about yourself
is committed unless you change `.gitignore`.

## 1. Requirements

- **Node.js 24 or newer** (the store uses the built-in `node:sqlite`).
- **A Chromium browser** — Chrome, Edge, Brave or Opera — for the extension.
- **Claude Code** (`claude` on your PATH, signed in) for the writers: tailored
  resumes, application answers, cover letters and the daily curation. Without
  it, discovery, triage, scoring, the dashboard and form filling all still
  work; the writing features say they are unavailable.
- Windows, macOS or Linux. The desktop shortcut helper is Windows-only.

## 2. Install

```bash
git clone <this repo> jarvis-jobs
cd jarvis-jobs
npm install
npx playwright install chromium     # used for liveness fallbacks and resume rendering
cp .env.example .env                # optional settings, all commented out
```

## 3. Your CV — the source of truth

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

## 4. Your application profile

```bash
mkdir -p data/jarvis
cp examples/apply-profile.example.yml data/jarvis/apply-profile.yml
```

Fill in every value with your own. This is what the extension types into
forms: identity, education, work history, work-authorization answers,
consents and voluntary self-identification. **Leave a key empty rather than
guess** — an empty key leaves that field for you, with the reason.

The work-authorization answers drive the visa screen. The defaults assume a
student on F-1 who will need sponsorship later; set yours honestly, and the
triage adjusts what it flags.

## 5. What you want

```bash
cp examples/portals.example.yml portals.yml
cp examples/preferences.example.md jarvis/preferences.md
cp config/profile.example.yml config/profile.yml
```

- **`config/profile.yml`** — your target roles and compensation floor, which
  the fit scorer weighs. Replace the example's roles with yours.

- **`portals.yml`** — the companies you track and your title, location and
  salary filters. You do not need to type boards by hand:

  ```bash
  npm run jarvis:discover -- --names "Company A,Company B" --write   # resolve names to verified boards
  npm run jarvis:discover -- --seeds hardware --write               # a curated hardware seed list
  npm run jarvis:discover-linkedin -- --write                       # companies hiring for your titles
  npm run jarvis:discover-sources                                   # Built In, HN, YC, The Muse, Climatebase
  ```

  Read the titles on any board you just added (`npm run jarvis:audit-boards --
  --since <an older copy of portals.yml>`): a name can resolve to a different
  company with the same name, or to a recruiting agency.

- **`jarvis/preferences.md`** — plain-English rules the fit scorer reads every
  run (`never night shift`, `prefer in location Austin`). Edit it any time and
  run `npm run jarvis:rescore`.

## 6. First scan

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

## 7. The browser extension

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

## 8. Resumes

The resume builder selects bullets from `jarvis/resume-pool.json` — a pool
whose every sentence must appear verbatim in your `cv.md`, or the build
refuses to run. Build yours from your CV, starting from the example:

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

## 9. Optional

- **Gmail** — Applications → Connect Gmail, with your own Google OAuth client.
  Read-only; it moves a card forward on a confirmation, interview or
  rejection email and never sends anything.
- **Adzuna** — set `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` in `.env` for one more
  discovery source.
- **Backups** — `npm run jarvis:backup` copies your decisions and hand-written
  files to `jarvis-backup/`.

## 10. Tests

```bash
npm run jarvis:test            # everything that runs on a fresh clone (fixtures only)
npm run jarvis:test:personal   # suites that read YOUR files: cv.md, config/profile.yml,
                               # data/jarvis/apply-profile.yml, jarvis/resume-pool.json
npm run jarvis:test:e2e        # the end-to-end extension test
```

`jarvis:test:personal` fails until your files exist, and a few of its suites
assert the sample persona's resume layouts — adjust them when you rewrite
`resume-variants.mjs` for your own history.

## Rules the engine keeps

- **Submit is always yours.** No path in the code presses it.
- **Flags, never drops.** Anything that hides a posting says why, and every
  hide can be undone.
- **Nothing invented.** Every claim written for you traces to `cv.md` (and the
  optional files above); a gap is left as a gap.
- **Liveness is decided by the ATS API**, never by a search snippet.
