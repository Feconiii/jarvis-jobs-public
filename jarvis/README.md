# Jarvis Jobs

A fast, private job-search platform for Alex. Discover broadly, browse quickly,
queue on instinct, decide for yourself. It flags problems; it does not gatekeep.

## Opening it

Double-click **Jarvis Jobs** on the Desktop. It starts the server and opens the
dashboard; if one is already running it just opens the tab. Close the window (or
Ctrl-C) to stop it.

To create or re-create that shortcut: `npm run jarvis:shortcut`
(`... -Remove` to delete it). The launcher itself is `jarvis/launch-jarvis.cmd`.

## The commands you need

```bash
node jarvis/discover-ats.mjs --sp500     # widen: find new companies' ATS endpoints
node jarvis/scan.mjs                    # discover: pull every posting from your companies' ATS APIs
node jarvis/scan.mjs --provider ashby    # rescan only one ATS (after a provider fix)
node jarvis/enrich.mjs --relevance 12   # deepen: fetch full JDs so visa hard-blocks are detected
node jarvis/serve.mjs                    # browse: open http://localhost:4300
```

(or `npm run jarvis:scan` / `npm run jarvis:serve`)

## Adding companies (`discover-ats.mjs`)

`scan.mjs` can only scan what's in `portals.yml`, and every entry needs a real
ATS endpoint — for Workday that's a `tenant` / `instance` / `site` triple like
`airproducts.wd5.myworkdayjobs.com/AP0001`, which is not guessable. This script
resolves company **names** into verified entries:

```bash
node jarvis/discover-ats.mjs --names "Zoox,Waymo"          # ad-hoc
node jarvis/discover-ats.mjs --sp500                       # the whole index
node jarvis/discover-ats.mjs --sp500 --sectors "Industrials,Health Care"
node jarvis/discover-ats.mjs --seeds yc                    # YC portfolio startups
node jarvis/discover-ats.mjs --seeds yc --all-startups     # skip the hardware filter
node jarvis/discover-ats.mjs --sp500 --write               # append to portals.yml
```

`--seeds` pulls VC portfolios via `seeds/vc-portfolios.mjs` and keeps only
companies whose YC tags say they build physical things — ~900 of ~3000, since
the rest is B2B SaaS with no mechanical surface. Seeded startups skip the
Workday probe entirely (no VC-portfolio company runs a Workday tenant) and are
exempt from the "thin board" warning, because a startup with four openings is
just a startup, not a mis-resolved board.

It probes Greenhouse → Ashby → Lever → SmartRecruiters → Workday and **verifies
every hit with a live API call** before writing — nothing lands in `portals.yml`
that didn't just return postings. Two details do the heavy lifting:

- **Workday sites come from `robots.txt`, not guesswork.** Every tenant lists its
  live career sites there. That's how `Ext` (Autodesk), `ATTGeneral` (AT&T) and
  `AP0001` (Air Products) get found — no candidate list would contain them.
- **Fragment slugs must corroborate.** A slug built from the full name is
  trusted; one built from a fragment or ticker is not, because a Greenhouse board
  named `delta` belongs to whoever registered it first. Fragment matches are only
  accepted when the board's own text names the company. Without that check a
  500-company sweep quietly grafts other employers' postings onto yours.

Defaults to a dry run. `--write` is the only thing that edits `portals.yml`.

## Fit scoring (`fit.mjs`)

The old `relevance` number was a flat keyword bag — one shared list of ~50
industry words, +8 in the title, +3 anywhere else. It answers "is this vaguely
a mechanical job", which is why the same few employers kept surfacing: a
posting titled *Mechanical Design Engineer* scored the same whether it wanted a
new grad or fifteen years, paid $70k or $200k, and matched nothing you can
actually do.

`fit.mjs` scores the job **against you**, reading the whole description:

| Dimension | Max | What it asks |
|---|---|---|
| role | 28 | Does the title/JD hit a target role from `profile.yml`? |
| skills | 26 | Which of *your* tools does the JD actually name? |
| seniority | 20 | Reachable for a May-2027 grad, or a staff-level ask? |
| industry | 10 | A target industry — or an excluded one? |
| compensation | 10 | Against your $100k target and $80k floor |
| location | 6 | A preferred hub, US, remote, or somewhere you can't work? |

Out comes `score` 0–100 and a **band** — Strong / Good / Fair / Low, or
**Blocked** when work authorisation rules it out. Nothing about you is
hardcoded: skills are read from `cv.md`, everything else from
`config/profile.yml`. Edit those and re-run `npm run jarvis:rescore` — no code
change, no re-scan.

```bash
node jarvis/fit.mjs --explain "Manufacturing Engineer I"   # full breakdown
npm run jarvis:rescore -- --top 20                          # rescore + leaderboard
```

Three rules keep the number honest:

- **A dimension that can't be judged leaves the denominator.** Most ATSs never
  publish pay; scoring that 0/10 would punish a job for its employer's
  disclosure policy, not for being a bad match.
- **`confidence` reports whether a description was actually read.** A
  title-only posting can't have its skills judged and is scaled down, so
  unread jobs can't outrank read ones just by having fewer chances to lose points.
- **Work-auth blocks are stated, not folded in.** They set `blockers` and the
  Blocked band, with the source quote.

Skill aliases match as **words**, not substrings — an earlier version credited
"ROS" against "ac*ros*s", "CAM" against "*cam*era" and "FAB" against
"*fab*ricate", while missing "prototyping" because the alias was "prototyp".
Both directions are covered by `jarvis/fit.test.mjs`.

## Your preferences (`preferences.md`)

`profile.yml` holds structured facts. It cannot say *no second shift*, *no pure
software*, *prefer a big city* — the opinions that actually decide whether a
posting is worth opening. Those live in **`jarvis/preferences.md`**, written in
sentences, read by the scorer on every run:

```
never 2nd shift, night shift, graveyard
no software engineer, web developer, full-stack in title
avoid technician, operator, assembler in title
want mechanical design, manufacturing engineer, automation, robotics
prefer in location Austin, Seattle, San Jose, Phoenix
```

`never`/`no` are hard — the job is **Blocked**, surfaced exactly like a work-auth
block, with the rule quoted back. `avoid`/`prefer`/`want` nudge the score.
`in title` / `in location` narrow the field, which matters more than it sounds:
matched against the whole description, "avoid sales" fires on nearly every
engineering posting, because they all mention partnering with a sales team.

Preference influence is **capped** (+12 / −30). Uncapped, six `want` lines pinned
every KLA posting to 100/100 — a Supply Chain Analyst and an Engineering Manager
tied with the best mechanical-design role in the store. The six weighted
dimensions decide the order; preferences break ties.

Edit the file, run `npm run jarvis:rescore`. Zero tokens, zero network.

## Pay is read out of the description

Only Ashby publishes structured comp. Everyone else writes it into the text, and
the scorer used to ignore all of it — 4,372 postings said
`Base Pay Range: $105,900.00 - $180,000.00 Annually` while the card reported
"compensation — not judged". `salary-text.mjs` parses the prose form: ranges,
`to`/en-dash/HTML-span separators, `$120K`, hourly rates annualised at 2080h,
CAD/EUR/GBP. **11,160 postings gained a price.**

The hard part is refusal, not extraction. `"$1.37B Series D at a $7.87B
valuation"` must not become a salary — a funding round parsed as pay silently
ranks the job as if it paid millions. Funding, revenue, savings and 401(k) match
figures are all rejected, and every case is pinned in `salary-text.test.mjs`.

But refusal was *too* eager, and that turned out to be the bigger leak. The
parser rejected any range with "401(k)" or "bonus" anywhere in the surrounding
280 characters — which is exactly where every American posting puts its benefits
sentence, right after the pay line. It also could not read a unit sitting
between the bounds (`$33/hour - $36/hour`), did not accept `and` as a separator
(`between $78,800 and $131,200`), and ignored a single stated rate entirely
(`The position pays $20/hr`). Disqualifiers are now split by how bad they are —
corporate-finance words are fatal anywhere nearby, benefits words only when they
lead into the number — and **4,899 more postings gained a price**.

Pay is stored annualised so one scale sorts the store, but the period is stored
with it and the card shows what the posting actually said: an hourly req reads
`$34/hr`, not a computed `$71k` he cannot find anywhere in the text.

## Card view

`Cards` in the dashboard is a second way to work the same undecided pile: one
posting at a time, full screen — score, per-dimension bars with the reason for
each, badges, pay, and the real description — decided with one key.

```
←  skip (asks why)   →  interested      ↑  queue to apply
↓ / space  next      backspace  back    o  open the posting    esc  cancel
```

Laid out in two columns — the posting reads on the left, the verdict sits on the
right — because stacked, the description pushed the score and the buttons
off-screen and every decision needed a scroll first.

The next **4 postings are prefetched** while you read the current one. Each skip
used to wait on a fresh round-trip for the description, which made a fast
keyboard pass unusable.

**Skip asks why.** Eight one-click reasons plus a free-text box; press `←` again
to skip without answering. Answers are written to the job and appended to
`data/jarvis/skip-reasons.jsonl`. That log is the point — reading a few hundred
skips together tells you which rule to add to `preferences.md`, which no single
job ever shows.

The list view answers *what is out there*; deciding from a table row means
judging a job by its title, which is how a pile of 4,000 "relevant" rows never
gets worked through. Sorting and filtering are shared with the list view
(`Sort: fit`, and a fit-band floor), so the deck is whatever the filter bar says.

### Pay data

Ashby publishes pay ranges through its posting API, and `parseCompensation`
annualises them into `{min, max, currency}` on each job. That number reached
the dashboard through none of the three layers it had to cross — the provider
read the wrong schema (the live API nests salary under
`compensationTiers[].components[]`, not flat on `compensation`), `scan.mjs`
rebuilt each job from a field list that omitted `salary`, and `store.mjs`
never persisted it. All three are fixed; ~940 postings now carry a pay range.
Other ATSs mostly don't publish comp, so coverage is Ashby-heavy.

### What's currently enabled

`portals.yml` holds 315 companies, 258 of them enabled (110 are YC startups). The other 57 are
auto-discovered S&P 500 names in **Financials, Consumer Staples, Utilities,
Communication Services and Real Estate** — plus the non-hardware half of
Consumer Discretionary (Airbnb, Domino's, Wynn, homebuilders). They are
`enabled: false` with a reason on the line, not deleted: flip one field to get
them back.

What stays on: everything hand-curated (semis, robotics, aerospace, medtech,
big tech), plus Information Technology, Health Care, Industrials, Materials,
Energy, and the two automotive names (Aptiv, General Motors).

**Scale note:** adding companies is cheap; scanning them costs network time and
disk. The store holds full descriptions (triage recomputes visa blocks from
them) at ~1.9 KB per posting compressed, so the entire S&P 500 is on the order
of a 1–2 GB database — read a row at a time, so size is a disk question now
rather than a "can this be opened at all" question. Use `--sectors` to buy
breadth where it pays —
Industrials, Health Care, Information Technology, Energy and Materials hold
essentially all the mechanical surface; Financials and Real Estate hold volume
and almost no matching roles.

`scan` is zero-token and only sees list data (title + location). `enrich` pulls
the full description from each ATS's public per-job API and re-runs triage, so a
"we will not sponsor" or ITAR clause actually blocks. It's on-demand and scoped
(`--company`, `--status queued`, `--relevance N`, `--limit N`) so you enrich the
jobs you care about, not all 5000. Supported detail APIs today: Workday,
Greenhouse (covers most of the store); more can be added in `enrich.mjs`.

## How it thinks (different from the old career-ops)

- **It captures, it doesn't reject.** The scanner pulls *every* posting a
  company's ATS returns — no title whitelist. That's why NVIDIA now shows ~1000
  postings and 70+ mechanical-relevant roles instead of "nothing found."
- **Triage flags, never hides.** The only thing that hard-blocks a job is an
  explicit work-authorization disqualifier (citizenship / clearance / "no
  sponsorship"), and even then the job is shown with the exact source quote —
  nothing is deleted. Seniority, years-of-experience, weak relevance: all labels,
  never filters. Relevance is a sort key, not a gate.
- **A mention of OPT is not a welcome.** Eaton writes "will not consider
  applicants for employment immigration sponsorship … will not support any CPT,
  OPT, or H-1B." The negation sat 47 characters from the word "sponsorship" and
  the block only looked 40 ahead, so the posting was never blocked — and then a
  bare `\bOPT\b` in the *next* sentence badged it **"likely OPT-friendly."** A
  disqualifier inverted into an encouragement is the worst thing this file can
  do, so the good note now fires only when nothing blocks the job and the
  sentence carrying the match is not itself a negation. A negative mention gets
  its own caution instead, with the quote attached.
- **Geography comes from closed sets, not a list of cities** (`geo.mjs`). It used
  to be a hand-written lexicon of ~150 foreign city names, so every country the
  scanner reached for the first time was a new leak found by screenshot — Costa
  Rica got in four different ways at once (`CR - Alajuela`, `CRI - Alajuela - El
  Coyol`, `Cartago, Cartago`, `San José, San José Province,CR, CR`). It now
  decides from every ISO 3166 country name and code against every US state name
  and postal code, in tiers, with US signals ranked first because half the
  two-letter country codes collide with state abbreviations. **4,705 foreign
  postings left the deck and 6,280 US ones joined it.** Genuinely ambiguous
  names — Vancouver, Waterloo, Berlin, Hamburg — stay `unknown`, which means
  they stay on screen.
- **A description is text before it is stored** (`text.mjs`). Greenhouse ships
  bodies with the markup entity-encoded; the old converter stripped tags before
  decoding entities, so decoding *re-created* every tag as visible text. 15,876
  of 35,362 stored descriptions were unreadable because of it. Both the scanner
  and the enricher now run the same converter at the door.
- **Coverage is honest.** Every scan records, per company, how many postings it
  actually saw and whether it could reach a structured API at all. Companies
  without an API are reported as "needs assisted scan" — never silently counted
  as empty. See the "Scan coverage" panel at the bottom of the dashboard.

## The dashboard

- **Home** — what Jarvis has actually done for you, all derived from the one
  store so it can't drift from the lists: how many postings were captured and
  how many survived triage (with the breakdown of what was filtered and why),
  deep-read coverage, how many jobs the apply engine can drive, wasted
  applications prevented by the work-auth guard, your pipeline funnel, an
  activity log of every scan and apply run, and where the coverage came from.
  The tiles are clickable — they jump to the filtered list behind the number.
- **Resumes** — the four family resumes previewed inline, each labelled with its
  lane and the internship titles it presents. Open or download any of them.
- **Views:** Inbox → Interested → Queue → Applied → Tracker → Hidden → All.
- **Filters:** company/watchlist, experience level, location (defaults to US +
  Remote + Unknown since OPT rules out foreign roles — toggle to see all),
  visa state, relevance. The header always shows "X of Y captured" so you know
  exactly how much is filtered from view.
- **Bulk actions:** select rows → Add to queue / Mark interested / Hide.
- **Keyboard:** `j`/`k` move, `x` select, `o` open posting, `i`/`q`/`h`
  interested/queue/hide, `Enter` expand details, `/` search.
- Expanding a row shows the visa evidence quotes, experience reasoning, why it
  surfaced, and the description (when the ATS list API provided one).

## Data

`data/jarvis/jobs.db` — one SQLite file holding every job. URL is identity;
re-scans refresh postings but never reset a status you set.

It was a single JSON document until it wasn't: at 107k jobs that file was
364 MB, and a text file stops being readable at all past about half a gigabyte
— not slow, *unreadable*, because every way of opening it starts by loading the
whole thing into one string. Every save also rewrote all 364 MB, which is how
two companies' worth of freshly scanned postings went missing when two writers
overlapped.

The same 107k jobs now take **203 MB**, and nothing is ever read whole:

| | JSON file | SQLite |
|---|---|---|
| Size (107k jobs) | 364 MB | 203 MB |
| Opening the dashboard | 77 MB downloaded, filtered in the browser | 470 KB — one page, filtered by the database |
| Default list | ~1 s | 27 ms |
| Search | instant (over data already downloaded) | 38 ms |
| Home tiles | walked every job | 2 s cold, 3 ms after |
| Ceiling | ~512 MB, then unreadable | none that matters |

Three things buy that:

- **Hot and cold are separate.** Everything a list needs — score, band, flags,
  location, pay, dates — is its own indexed column. The full verdict and the
  posting text live in side tables and are read only when you open one job. A
  page of 400 touches neither.
- **Compression with a shared dictionary.** Postings are mostly boilerplate,
  but the repetition is *between* postings, and a compressor working one row at
  a time can't see it. A dictionary sampled from your own store takes
  descriptions from 2.3x to 3.7x and the verdicts from 1.7x to 11.8x, with
  byte-exact round-trips and no loss of random access.
- **A re-scan that finds nothing new writes almost nothing.** Unchanged
  postings get two timestamps updated instead of a re-score and a recompressed
  verdict. Re-scanning Hermeus's 85 postings takes 1.7 seconds.

At a million jobs this is on the order of 1–2 GB, still opened a row at a time,
and the pieces that would grow fastest — dead postings' bodies — can be dropped
without losing the job, its verdict or its quotes.

```bash
node jarvis/migrate-store.mjs          # build jobs.db from the old jobs.json
node jarvis/migrate-store.mjs --verify # re-check an existing jobs.db
node jarvis/prune.mjs                  # what dead postings are costing you
node jarvis/prune.mjs --write --vacuum # drop their bodies, shrink the file
```

**Pruning** is the answer to unbounded growth, not to today's size. A posting
the scanner has stopped finding is gone from the employer's site: you can't
apply to it, so nothing needs re-deriving from its text, and the text is most
of what it costs. `prune.mjs` drops the body and keeps the job, its score, its
verdict and every quote — it still appears in lists and counts, it just has no
description to open. Jobs you decided on are never touched, and a pruned job is
marked so the enrichment worker doesn't download it again.

It deliberately does **not** touch live postings, including the 69% of stored
text that sits on jobs you'd never browse — blocked, technician, internship,
non-US, too senior. Those verdicts are re-derived FROM the description, so
dropping the text would mean a later triage fix could never un-block a job it
had wrongly blocked. Re-derivability is worth more than the megabytes.

The migration streams the JSON (so it works on a file too big to open), never
modifies it, and verifies itself: counts, statuses, and whole sampled records
compared field by field against the source. It also checks that the browse
query still uses an index — a missing one is the difference between instant and
a visible pause. **Keep `jobs.json` until the dashboard has run clean for a
while**; nothing reads it any more, and `compact-store.mjs` exists only to
rescue that old file if you ever need to re-run the migration.

Your old career-ops data (tracker, reports, CV) is untouched and backed up
under `backups/` before this work began.

## Apply (batch engine)

```bash
node jarvis/apply.mjs                     # opens + fills everything you queued
node jarvis/apply.mjs --url <posting>     # explicit posting(s)
node jarvis/apply.mjs --test --url <url>  # engine check with placeholder data
```

Queue jobs in the dashboard, run the engine, and it opens each application in a
real visible browser, fills what it can from `data/jarvis/apply-profile.yml`
(YOUR answer bank — edit it), uploads your resume if `documents.resume_path` is
set, and prints a per-application report: what it filled, what needs your
input, and which answers to double-check. Then it stops and holds every tab
open — **you** review, complete the flagged fields, and click Submit.

Supported ATS adapters: Greenhouse, Lever, Ashby (≈1,050 jobs in the current
store). Anything else still opens in a tab for manual filling.

**Consent-configured behavior** (per Alex's standing consent, 2026-07-16, all
recorded in `apply-profile.yml`): EEO/self-identification is filled from the
`eeo:` section (gender/race/veteran/disability answers you provided);
certification/consent checkboxes are auto-checked (`policy.auto_check_
certifications`); background-check consent answered Yes. Every one of these
appears under "REVIEW these answers" in each report — nothing is silent.

## Resumes — the four

```bash
node jarvis/build-resumes.mjs            # build all four
node jarvis/build-resumes.mjs --check    # validate against cv.md, write nothing
```

| Family | Picked for postings about | Applied Materials title | Acme Steel title |
|--------|---------------------------|-------------------------|--------------|
| `total-experience` | anything without a clear lane (fallback) | Mechanical Engineer Intern (Automation) | Manufacturing Engineer Intern |
| `automation` | robotics, controls, PLC, vision, mechatronics | Automation Engineer Intern (Automation Technology Group) | Mechanical Automation Engineer Intern |
| `manufacturing` | process, production, NPI, test, quality, metrology | Manufacturing Engineer Intern (Automation Technology Group) | Manufacturing Engineer Intern |
| `mechanical` | mechanical design, CAD, GD&T, tolerance, thermal | Mechanical Engineer Intern (Automation Technology Group) | Mechanical Engineering Intern |

Every application gets a tailored resume — and the tailoring **is** the family.
The engine picks one from the posting's title (`jarvis/resume-family.mjs`), which
is why ten postings at one company produce three or four resumes rather than ten
subtly different ones a recruiter can see side by side in the same ATS.

Both internships genuinely spanned design, automation and manufacturing, and
**Alex's manager approved presenting each under the title matching the role
applied for**. The approved titles live in `cv.md` § *Approved internship title
variants*; anything outside that list fails the build. When a family resume is
attached, the engine also rewrites the application form's work-history titles to
match it and prints each change — the form and the PDF are read on the same
screen and must never disagree.

**What every one of them carries.** A lane changes what LEADS, not what is
allowed on the page — mechanical design is a staple, not a specialisation. So the
Inventor inspection-fixture design and the Neuro-T machine-vision model appear on
all four, and Applied Materials keeps 5–6 of its 6 bullets everywhere. That space
is bought from Makerspace and SAE (one line each) and Acme Steel's surplus-recovery bullet
(never used), never from Applied Materials. The one sanctioned omission is the
AMR bullet on the mechanical resume. All of it is pinned in
`jarvis/resume-variants.test.mjs`, so a later edit can't quietly drop one.

How it is put together:

- `jarvis/resume-pool.json` — every sentence a resume may print, **verbatim from
  `cv.md`**, plus the approved titles.
- `jarvis/resume-variants.mjs` — per-family plan: which title, which bullets in
  which order, which skills lead, which coursework. A plan can select, reorder
  and relabel; it cannot write a sentence.
- `jarvis/build-resumes.mjs` — validates the pool against `cv.md` (build fails on
  any drift), then renders each PDF and saves the `spec.json` that produced it
  next to it, so any line traces back to `cv.md`.
- `jarvis/resume-variants.test.mjs` + `jarvis/resume.test.mjs` — the drift guard,
  the title/routing rules, and the PDF text-layer/one-page checks for all four.

**Filenames:** every file is `Alex Rivera Resume.pdf` — the FOLDER is the variant, so
no company ever receives two differently-named resumes. The audit copy in
`output/jarvis-resumes/sent/` does carry the descriptive name
(`Alex Rivera Resume - automation - KLA - Robotics Engineer.pdf`); that copy is for
Alex, and the Review & Send tab links to the exact file that was uploaded.

Rebuild after any `cv.md` edit. A genuinely one-off resume for a single posting
(`job.resume_path`) still wins over its family — that is for when Alex asks for
one specific job, not something a run decides on its own.

Hard boundaries, enforced in code: never clicks Submit, never presses Enter in
a form field, never fills signature/DOB/SSN, never invents an answer — unknown
questions are flagged, not guessed. Work-authorization answers are always
review-flagged.

## What's next (not built yet)

- **Workday apply adapter** — needs a signed-in candidate account per tenant;
  planned pattern: you log in once in the engine's persistent browser profile,
  Jarvis fills the multi-page flow and stops before submit.
- Browser-assisted scanning for the "needs assisted scan" companies
  (Applied Materials, Lam/Micron on Eightfold, ASML).
- On-demand deep tools (tailored resume, fit analysis, interview prep) pointed
  at a single queued job rather than run on everything.
