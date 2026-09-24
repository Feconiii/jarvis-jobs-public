# Jarvis Jobs

A private job platform for one person: high-volume discovery across company
ATS APIs, triage that flags instead of dropping, fit scoring against the
user's own rules, a dashboard, tailored resumes, and a browser apply engine
that fills forms but never presses Submit. See README.md and SETUP.md.

## First run — set the user up before anything else

At the start of a session on this repo, run `node jarvis/setup-check.mjs`
(built-ins only; works before `npm install`). If it reports anything missing
or still holding the examples' values, tell the user in one line and offer to
set it up now, following **`.claude/skills/jarvis-setup/SKILL.md`** (the user
can also type `/jarvis-setup`). That skill is the interview: what to ask, in
what order, which file each answer goes into, and the rule that nothing is
written they did not say. Do not scan, build resumes or fill forms for a user
whose `cv.md` and `data/jarvis/apply-profile.yml` are not theirs yet.

## Layout

| Path | What it is |
|------|------------|
| `jarvis/` | The whole system: scanner, triage, fit scoring, store, dashboard, apply engine, writers. |
| `jarvis/apply/` | Per-ATS form drivers (workday, greenhouse, lever, ashby, eightfold, generic) and the answer rules. |
| `jarvis/extension/` | The Chromium extension (Manifest V3): worker, page script, side panel. |
| `providers/` | ATS API adapters, loaded by the scanner. |
| `data/jarvis/jobs.db` | The job store (SQLite/WAL). Gitignored — the user's data, never commit it. |
| `portals.yml` | Tracked companies and filters. Gitignored, user-edited. |
| `cv.md`, `data/jarvis/apply-profile.yml`, `jarvis/preferences.md`, `jarvis/resume-pool.json` | The user's own files (see `examples/`). |

## Commands

```
npm run jarvis:scan          # discover across tracked companies
npm run jarvis:discover -- --names "A,B" --write   # resolve company names to verified boards
npm run jarvis:enrich        # full descriptions for scored jobs
npm run jarvis:serve         # dashboard at localhost:4300
npm run jarvis:curate        # below 50 open picks, read new postings in full and file them
npm run jarvis:resumes       # build the resume family PDFs (with the layout check)
npm run jarvis:test          # full suite — run this before claiming anything works
```

## Source-of-truth boundary (critical)

Anything a human at a company will read — resumes, form answers, letters,
outreach — is generated **only** from the user's own files (`cv.md`,
`cv-short.md`, `data/jarvis/apply-profile.yml`, `jarvis/resume-pool.json`,
`interview-prep/`) plus what the user says directly. Keywords are reworded,
never fabricated. Never claim the user built or authored something their CV
does not say they did. If a claim is not backed, ask; if they cannot back it,
it ships without it.

## Applying — the hard rule

**Fill everything. Submit nothing.** The engine answers every question it can,
ticks the consents the user said yes to, uploads the resume, and stops at the
Submit button. Pressing it is the user's call, every time.

## Conventions

- Node 24+ (`node:sqlite`), ESM `.mjs` throughout.
- Tests live next to the code as `*.test.mjs` and are wired into `npm run jarvis:test`.
- The store is the source of truth for job state; the dashboard is a view over it.
- Triage **flags**, it never drops. Anything that silently hides a posting is a bug.
- Liveness is decided by the ATS API (`node check-liveness.mjs <url>`), never by a search snippet.
- The dashboard runs resume builds in-process: do not restart it mid-build.
