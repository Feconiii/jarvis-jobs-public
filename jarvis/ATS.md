# Application platforms — what Jarvis meets and how well it drives them

Generated 2026-09-25 06:25 UTC by `npm run jarvis:ats -- --md`. **Do not edit by hand** — facts live in `jarvis/ats-registry.json`, numbers are counted from the store, `data/jarvis/answer-log.jsonl` and `jarvis/FAULTS.md`.

Answer-log window: 2026-09-23T22:17 → 2026-09-25T06:23. Engine metrics are only as wide as that window; a small `runs` number is an anecdote, not a rate.

**His answers, replayed** (`npm run jarvis:replay`): 256 of 266 answers he sent are what today's planner would send (96.2%); 7 differ, 3 would be left empty, 2 regress an answer he kept.

## Overview

| Platform | Difficulty | Automation | Live postings | Companies | Applied | Runs | Median filled | Upload | Clean run | Wall | Unknown | Corrected | Open faults |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Workday | hard | works | 206637 | 368 | 12 | 18 | 2.5 | 83% | 17% | 28% | 13% | 29% | F-06, F-124, F-128, F-267, F-325 |
| Greenhouse | easy | works | 34772 | 466 | 6 | 5 | 13 | 100% | 0% | 0% | 11% | 19% | – |
| SmartRecruiters | hard | works | 30616 | 124 | 4 | 23 | 57 | 26% | 4% | 0% | 17% | 15% | F-113 |
| Eightfold | hard | partial | 27307 | 11 | 15 | 0 | – | – | – | – | 0% | – | F-152, F-428, F-465 |
| Amazon (custom) | wall | wall | 25273 | 1 | 10 | 0 | – | – | – | – | – | – | – |
| Ashby | easy | works | 14660 | 453 | 12 | 14 | 3.5 | 79% | 43% | 0% | 3% | 18% | F-191 |
| iCIMS | wall | wall | 8671 | 41 | 0 | 7 | 0 | 0% | 0% | 71% | – | – | – |
| Lever | easy | works | 8152 | 130 | 3 | 1 | 12 | 0% | 0% | 0% | 7% | 25% | – |
| Oracle Recruiting Cloud | wall | wall | 7432 | 6 | 0 | 1 | 1 | 0% | 0% | 100% | 0% | – | – |
| Apple (custom) | wall | untested | 4887 | 1 | 0 | 0 | – | – | – | – | – | – | – |
| LinkedIn | wall | listing-only | 4174 | 2242 | 1 | 0 | – | – | – | – | – | – | – |
| Google (custom) | wall | untested | 4122 | 1 | 0 | 0 | – | – | – | – | – | – | – |
| Radancy (listing only) | medium | listing-only | 4019 | 1 | 11 | 0 | – | – | – | – | – | – | – |
| Tesla (custom) | medium | works | 3124 | 2 | 10 | 10 | 7 | 80% | 60% | 0% | 0% | 9% | – |
| SAP SuccessFactors | hard | works | 2162 | 6 | 5 | 9 | 16 | 33% | 33% | 11% | 7% | – | F-78, F-89 |
| Jibe (Google-hosted career sites) | wall | wall | 2090 | 2 | 0 | 0 | – | – | – | – | – | – | – |
| Rippling | medium | works | 1705 | 59 | 0 | 7 | 14 | 86% | 0% | 0% | 5% | – | – |
| Company-site sitemaps (Teradyne, Qorvo, Veeco …) | medium | listing-only | 1505 | 3 | 0 | 0 | – | – | – | – | – | – | – |
| BambooHR | easy | works | 997 | 97 | 0 | 3 | 15 | 100% | 0% | 0% | 20% | – | – |
| Breezy HR | easy | works | 589 | 30 | 0 | 6 | 27 | 100% | 0% | 0% | 16% | – | – |
| Recruitee | easy | works | 321 | 22 | 0 | 1 | 4 | 100% | 100% | 0% | 0% | – | – |
| CareerPuck (wraps Greenhouse) | medium | works | 227 | 1 | 0 | 3 | 0 | 0% | 0% | 0% | – | – | – |
| firststage (OpenDigital) | medium | partial | 211 | 1 | 0 | 6 | 0 | 100% | 0% | 0% | 0% | 0% | – |
| Workable | medium | works | 85 | 4 | 0 | 8 | 0 | 13% | 0% | 0% | 27% | – | – |
| Phenom (listing layer) | medium | listing-only | 7 | 1 | 0 | 0 | – | – | – | – | – | – | – |
| Other / unclassified | – | – | 3 | 2 | 0 | 1 | 0 | 100% | 0% | 0% | 67% | – | – |
| Dover | easy | works | 1 | 1 | 0 | 4 | 5 | 100% | 0% | 0% | 5% | – | – |
| Kula | easy | works | 1 | 1 | 0 | 2 | 11 | 100% | 0% | 0% | 9% | – | – |
| Oracle Taleo | hard | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Handshake | wall | listing-only | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Teamtailor | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Pinpoint | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Comeet | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Personio | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Jobvite | medium | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| UKG / UltiPro | medium | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| ADP | medium | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Avature | medium | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| BrassRing (Kenexa) | hard | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |

## What the columns mean

- **Difficulty** — how hard the platform is to drive at all: *easy* (one page, plain controls), *medium* (custom widgets, iframes, multi-step), *hard* (shadow DOM, prompts, sign-in, bot checks), *wall* (nothing to fill until he passes a sign-in, email code or account step). Judgement, in the registry.
- **Automation** — *works* (fills end to end, verified live), *partial* (fills, with known gaps), *wall* (stops correctly at a step that is his), *listing-only* (we read postings there; applying happens elsewhere), *untested* (never driven).
- **Live postings / Companies** — open rows in the store whose apply page is on this platform.
- **Applied** — rows HE marked applied. Nothing else counts as an application.
- **Runs** — fill reports in the answer-log window.
- **Median filled** — fields filled per run (one run is one page or one walk).
- **Upload** — runs that attached the resume.
- **Clean run** — runs that filled something, left nothing for him and did not stop at a wall. The closest thing to "reliability".
- **Wall** — runs that stopped at a sign-in, email or verification step.
- **Unknown** — planned fields the engine could not answer (skips excluded).
- **Corrected** — of the answers Jarvis gave that were read back at Next/Submit, the share he changed, cleared or edited. Only runs since read-back existed count.
- **Open faults** — faults listed for the platform whose heading in FAULTS.md is not closed.

## Platform by platform

### Workday

**hard · works** — 206637 live postings at 368 companies; 12 applied by him; 18 runs in the window, last 2026-09-25 05:41.

- **Who uses it:** Accenture (13060), Thermo Fisher Scientific (5311), Abbott (4330), Medtronic (3791), GE Vernova (3684), NVIDIA (3376)
- **Recognised by:** `\.myworkday(jobs|site)\.com$`
- **Discovery:** providers/workday.mjs — POST /wday/cxs/<tenant>/<site>/jobs
- **Applying:** extension + own Playwright driver (jarvis/apply/workday.mjs)
- **How it is built:** six-step wizard; Next and Submit are the same footer button, told apart by text; prompt widgets: menus of menus, options rendered three times, virtualised lists (F-390); My Experience sections added by Add buttons (entries); sign-in per tenant; some want a Talent Profile account; page CSP blocks calls to localhost
- **Walls (his to pass):** sign-in (Google SSO pressed for him); account creation (his)
- **Engine:** median 2.5 filled, upload 83%, clean 17%, wall 28%, 2.6 left per run, unknown 13%, he corrected 48 (29%), he answered 46 Jarvis left
- **Faults:**
  - **open** F-06 — Enrichment "failures" are mostly postings that are genuinely dead (DIAGNOSED)
  - **open** F-124 — The account wall is far bigger than this ledger has been saying (MEASURED, and it corrects my own reporting)
  - **open** F-128 — What the account wall actually is, and why I stopped short of automating it (USER)
  - **open** F-267 — The skills box: eight in one engine, none in the other (recorded, not changed)
  - **open** F-325 — Workday's My Experience was the driver's alone; the extension left it to him (fixed (unverified live))
  - F-390 — A required Workday prompt that is a MENU OF MENUS, painted a few rows at a time, blocked the whole application (fixed 2026-09-07)
  - F-555 — Four Workday forms in one night, read back from what he submitted (fixed 2026-09-24)
  - F-553 — The portfolio link is not put in the additional website field (fixed 2026-09-24)
- **Notes:** Biggest pool by far. Fills well once he is signed in; the wall, not the form, is the cost.

### Greenhouse

**easy · works** — 34772 live postings at 466 companies; 6 applied by him; 5 runs in the window, last 2026-09-25 05:44.

- **Who uses it:** Lucid Motors (1467), Databricks (990), Coupang Inc. (981), Rocket Lab (954), Anthropic (864), Stripe (823)
- **Recognised by:** `(^|\.)greenhouse\.io$`
- **Discovery:** providers/greenhouse.mjs — boards-api.greenhouse.io/v1/boards/<slug>/jobs
- **Applying:** extension + thin Playwright driver (jarvis/apply/greenhouse.mjs)
- **How it is built:** plain HTML form or react-select comboboxes; on company sites the form is an iframe embed (job_app) that loads late; custom questions per employer; statements instead of Yes/No (F-572); question API: boards-api …/jobs/<id>?questions=true lists every question and option
- **Engine:** median 13 filled, upload 100%, clean 0%, wall 0%, 2.4 left per run, unknown 11%, he corrected 10 (19%), he answered 13 Jarvis left
- **Faults:**
  - F-571 — A frame that never loaded froze the whole press (fixed 2026-09-24)
  - F-572 — Lyft's Greenhouse form: five wrong or missing answers (fixed 2026-09-24)
  - F-575 — Waymo: a Job Alerts form read as the application, hex codes in every label (fixed 2026-09-24)
  - F-576 — AST SpaceMobile and ASM (Greenhouse embeds): five unanswered, three answerable (fixed 2026-09-24)
- **Notes:** The easiest large pool. Company-site wrappers (Waymo, Formlabs, AST, ASM, Lucid) are Greenhouse underneath.

### SmartRecruiters

**hard · works** — 30616 live postings at 124 companies; 4 applied by him; 23 runs in the window, last 2026-09-25 04:45.

- **Who uses it:** Bosch (7681), AbbVie (4907), Eurofins (2894), Intuitive Surgical (1722), Wabtec (1657), ServiceNow (1641)
- **Recognised by:** `smartrecruiters\.com$`
- **Discovery:** providers/smartrecruiters.mjs — api.smartrecruiters.com/v1/companies/<slug>/postings
- **Applying:** extension in HIS browser only (DataDome blocks automated browsers)
- **How it is built:** spl-*/oc-* web components inside shadow roots (F-327); two dropzones: Easy Apply parser and the real resume slot (F-352); multi-step; each step a new document; Back redraws entries; experience/education entries via Add buttons; location search lists 'City, ST, US'
- **Walls (his to pass):** DataDome bot check (his to clear)
- **Engine:** median 57 filled, upload 26%, clean 4%, wall 0%, 10.5 left per run, unknown 17%, he corrected 19 (15%), he answered 63 Jarvis left
- **Faults:**
  - **open** F-113 — SmartRecruiters postings in the deck are mostly dead (measured)
  - F-119 — Every source checked for the SmartRecruiters defect (CHECKED, one real, one cleared)
  - F-562 — SmartRecruiters re-fills a page he goes back to review (fixed 2026-09-24, verified in his Chrome)
  - F-563 — SmartRecruiters' dropzone never keeps the resume (fixed 2026-09-24, verified in his Chrome)
  - F-567 — The live Western Digital run, end to end: seven more faults (fixed 2026-09-24)
- **Notes:** Western Digital's form fills end to end in his Chrome (2026-09-24).

### Eightfold

**hard · partial** — 27307 live postings at 11 companies; 15 applied by him; 0 runs in the window.

- **Who uses it:** Microsoft (5509), Micron Technology (5349), Eaton (4904), Qualcomm (3493), Lam Research (3186), Infineon (2346)
- **Recognised by:** `\.eightfold\.ai$`, `^(careers\.micron\.com|careers\.lamresearch\.com|careers\.qualcomm\.com|jobs\.infineon\.com|careers\.gf\.com|careers\.deere\.com|apply\.careers\.microsoft\.com|jobs\.careers\.microsoft\.com|careers\.appliedmaterials\.com)$`
- **Discovery:** sitemap (eightfold style); the PCSX API answers 'Not authorized' (F-428)
- **Applying:** extension + Playwright driver (jarvis/apply/eightfold.mjs)
- **How it is built:** entry point is a resume upload that parses into the form (F-152); reCAPTCHA helper frame on every page (F-318); sign-in with Google/Microsoft/LinkedIn on GF, Micron, Microsoft, Lam
- **Walls (his to pass):** SSO sign-in (his)
- **Faults:**
  - **open** F-152 — Eightfold's entry point is an upload, not a form (MEASURED)
  - F-318 — A reCAPTCHA iframe spoke for the tab on every Eightfold page (fixed)
  - **open** F-428 — His most important employers are the ones we cannot read (open 2026-09-09)
  - **open** F-465 — Micron (Eightfold) is the hardest form the extension meets (OPEN)
- **Notes:** His most important employers (Applied Materials, Lam, Micron, Qualcomm). Micron is the hardest form met (F-465).

### Amazon (custom)

**wall · wall** — 25273 live postings at 1 companies; 10 applied by him; 0 runs in the window.

- **Who uses it:** Amazon (25273)
- **Recognised by:** `(^|\.)amazon\.jobs$`
- **Discovery:** providers/amazon-jobs.mjs — /en/search.json
- **Applying:** extension (generic reader)
- **How it is built:** sign-in at passport.amazon.jobs before the form (F-233)
- **Walls (his to pass):** Amazon sign-in (his)
- **Faults:**
  - F-233 — It would have typed his email into Amazon's login form and called it filled (fixed)
  - F-380 — An injection that never came back stranded the tab, and Amazon's "you have already applied" went unrecorded (fixed 2026-09-06)

### Ashby

**easy · works** — 14660 live postings at 453 companies; 12 applied by him; 14 runs in the window, last 2026-09-25 06:23.

- **Who uses it:** OpenAI (1176), Crusoe (444), Legora (410), Applied Intuition (398), Finni Health (280), Form Energy (262)
- **Recognised by:** `^jobs\.ashbyhq\.com$`
- **Discovery:** providers/ashby.mjs — api.ashbyhq.com/posting-api/job-board/<slug>
- **Applying:** extension + Playwright driver (jarvis/apply/ashby.mjs)
- **How it is built:** single-page React form; an 'Autofill from resume' parser beside the real resume slot
- **Engine:** median 3.5 filled, upload 79%, clean 43%, wall 0%, 0.1 left per run, unknown 3%, he corrected 11 (18%), he answered 12 Jarvis left
- **Faults:**
  - **open** F-191 — A dead posting reported "0 filled", and liveness called it active (partly fixed)

### iCIMS

**wall · wall** — 8671 live postings at 41 companies; 0 applied by him; 7 runs in the window, last 2026-09-25 06:14.

- **Who uses it:** Sargent & Lundy (2233), Rivian (941), Quanta Services (675), Dewberry (553), Joby Aviation (538), Novolex (505)
- **Recognised by:** `\.icims\.com$`
- **Discovery:** providers/icims.mjs (sitemap, blocked for servers since F-448) + icims-careers (<origin>/api/jobs, F-454)
- **Applying:** extension (generic reader)
- **How it is built:** form in an iframe (#icims_content_iframe); the flow can also load top-level; Apply lands on a /login "Enter Your Information" screen: email, a residency box (CA or EU/UK), a privacy "I accept" hidden until the residency box is ticked, and hCaptcha; human-verification pages are refused on purpose (F-114)
- **Walls (his to pass):** hCaptcha on the email screen (his); Next on the email screen, then any emailed code or password (his); human check pages (his)
- **Engine:** median 0 filled, upload 0%, clean 0%, wall 71%, 0 left per run, unknown –
- **Faults:**
  - F-114 — CLOSED — the bot check is refused on purpose, and now it says so ((no status in heading))
  - F-448 — The iCIMS sitemap is gated now, and the provider still says it is not (fixed 2026-09-17)
  - F-454 — The gated board had an ungated front door the whole time (fixed 2026-09-10)
  - F-583 — iCIMS' email screen was named and never filled (fixed 2026-09-24 (1.50.0), not yet driven past the captcha)
- **Notes:** Rivian, Quanta, Joby, AMD, Marvell, Werfen. Since F-583 the email screen is filled (email, residency box by job location, privacy consent) and he does the captcha and Next. The pages after it have never been driven — the next step is one live pass past the captcha.

### Lever

**easy · works** — 8152 live postings at 130 companies; 3 applied by him; 1 runs in the window, last 2026-09-25 05:56.

- **Who uses it:** Lifestance Health (1954), Veeva Systems (1090), Distro (514), Zoox (340), Daniels Health (249), Extreme Networks, Inc. (155)
- **Recognised by:** `^jobs(\.eu)?\.lever\.co$`
- **Discovery:** providers/lever.mjs — api.lever.co/v0/postings/<slug>
- **Applying:** extension + Playwright driver (jarvis/apply/lever.mjs)
- **How it is built:** single page; custom questions named cards[<uuid>][fieldN] with the question in .application-label
- **Engine:** median 12 filled, upload 0%, clean 0%, wall 0%, 4 left per run, unknown 7%, he corrected 2 (25%), he answered 2 Jarvis left
- **Notes:** No runs in the current answer-log window.

### Oracle Recruiting Cloud

**wall · wall** — 7432 live postings at 6 companies; 0 applied by him; 1 runs in the window, last 2026-09-24 10:57.

- **Who uses it:** Honeywell (2792), Emerson (2024), Texas Instruments (1198), onsemi (1044), Cohu (237), Kulicke and Soffa (137)
- **Recognised by:** `\.oraclecloud\.com$`, `^careers\.ti\.com$`
- **Discovery:** providers/oracle-orc.mjs — /hcmRestApi/resources/latest/recruitingCEJobRequisitions
- **Applying:** extension (generic reader)
- **How it is built:** email, then an emailed code, before any form (F-345); Apply button without a link (F-112)
- **Walls (his to pass):** email + one-time code (his)
- **Engine:** median 1 filled, upload 0%, clean 0%, wall 100%, 0 left per run, unknown 0%
- **Faults:**
  - F-345 — TI's terms box was invisible to the reader, and its email step read as a submit (fixed 2026-09-05)
  - F-112 — Oracle Recruiting reached no form on any tenant but TI (fixed)
- **Notes:** Honeywell, Emerson, TI, onsemi.

### Apple (custom)

**wall · untested** — 4887 live postings at 1 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Apple (4887)
- **Recognised by:** `^jobs\.apple\.com$`
- **Discovery:** sitemap
- **Applying:** generic reader (never driven)
- **How it is built:** Apple ID sign-in
- **Walls (his to pass):** Apple ID

### LinkedIn

**wall · listing-only** — 4174 live postings at 2242 companies; 1 applied by him; 0 runs in the window.

- **Who uses it:** Ford Motor Company (26), Siemens (21), Molex (20), BioSpace (19), Amphenol Communications Solutions (18), Nokia (17)
- **Recognised by:** `(^|\.)linkedin\.com$`
- **Discovery:** discover-linkedin (company names) + import-linkedin (postings with no readable board)
- **Applying:** none — the apply link is behind a login
- **Walls (his to pass):** LinkedIn login
- **Notes:** Used to find companies, not to apply.

### Google (custom)

**wall · untested** — 4122 live postings at 1 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Alphabet (Google) (4122)
- **Recognised by:** `^careers\.google\.com$`
- **Discovery:** sitemap
- **Applying:** generic reader (never driven)
- **How it is built:** Google sign-in
- **Walls (his to pass):** Google account

### Radancy (listing only)

**medium · listing-only** — 4019 live postings at 1 companies; 11 applied by him; 0 runs in the window.

- **Who uses it:** Applied Materials (4019)
- **Recognised by:** `^jobs\.appliedmaterials\.com$`
- **Discovery:** sitemap (radancy)
- **Applying:** Apply goes to Eightfold (careers.appliedmaterials.com)
- **How it is built:** posting pages only
- **Faults:**
  - F-366 — Apply that led to the same job on its ATS was read as "a different job", and the follow-on refused to apply (fixed 2026-09-06)
- **Notes:** Applied Materials.

### Tesla (custom)

**medium · works** — 3124 live postings at 2 companies; 10 applied by him; 10 runs in the window, last 2026-09-24 07:58.

- **Who uses it:** Tesla (2968), Symbotic (156)
- **Recognised by:** `(^|\.)tesla\.com$`
- **Discovery:** browser-assist only (servers get 403)
- **Applying:** extension (generic reader)
- **How it is built:** 403 to anything but a real browser; its 'Next' can submit — guarded
- **Engine:** median 7 filled, upload 80%, clean 60%, wall 0%, 0 left per run, unknown 0%, he corrected 4 (9%), he answered 4 Jarvis left
- **Faults:**
  - F-88 — Tesla is applyable after all (CORRECTS F-07 and F-10)

### SAP SuccessFactors

**hard · works** — 2162 live postings at 6 companies; 5 applied by him; 9 runs in the window, last 2026-09-25 06:21.

- **Who uses it:** Zimmer Biomet (798), AGCO (443), TSMC (437), Skyworks Solutions (392), Epson America (91),  (1)
- **Recognised by:** `\.(successfactors|sapsf)\.(com|eu)$`, `\.ns2cloud\.com$`
- **Discovery:** providers/successfactors.mjs — <host>/sitemap.xml
- **Applying:** extension (generic reader)
- **How it is built:** account required before the form; the form is collapsed sections (F-577); menus are text inputs with a 'No Selection' placeholder (F-578); radios with the question outside the group (F-561); career sites (RMK/jobs2web) send Apply to an email or sign-in step
- **Walls (his to pass):** account sign-in (his)
- **Engine:** median 16 filled, upload 33%, clean 33%, wall 11%, 1.7 left per run, unknown 7%
- **Faults:**
  - **open** F-78 — The real apply gap is SuccessFactors, and `resolveApplyUrl` cannot see it (DIAGNOSED)
  - **open** F-89 — SuccessFactors is account-gated, not adapter-missing (DIAGNOSED, and it corrects F-78)
  - F-561 — SuccessFactors radios were read with no options and no question (fixed 2026-09-24, verified in his Chrome (TSMC: GPA, graduation year and semester, essential functions all selected))
  - F-577 — TSMC's questions sat inside closed sections (fixed 2026-09-24, verified in his Chrome)
  - F-578 — "No" chose "No Selection", and a placeholder read as an answer (fixed 2026-09-24, verified in his Chrome)
- **Notes:** TSMC fills completely once he is signed in (2026-09-24). Teradyne, Veeco, Skyworks and Qorvo career sites stop at their email/sign-in step.

### Jibe (Google-hosted career sites)

**wall · wall** — 2090 live postings at 2 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** AMD (2088), Advanced Micro Devices, Inc (2)
- **Recognised by:** `\.jibeapply\.com$`, `^careers\.amd\.com$`
- **Discovery:** providers/jibeapply.mjs — /api/jobs
- **Applying:** hands off to the employer's ATS (AMD: iCIMS login)
- **How it is built:** listing layer only
- **Walls (his to pass):** the underlying ATS's login
- **Notes:** AMD.

### Rippling

**medium · works** — 1705 live postings at 59 companies; 0 applied by him; 7 runs in the window, last 2026-09-24 13:11.

- **Who uses it:** Rippling (432), Carbon Health (291), VulcanForms (120), Aalo Atomics (82), TYLsemi (68), Reserv (67)
- **Recognised by:** `(^|\.)(ats\.rippling\.com|rippling-ats\.com)$`
- **Discovery:** providers/rippling.mjs — api.rippling.com …/board/<slug>/jobs
- **Applying:** extension (generic reader)
- **How it is built:** hidden native inputs behind styled Yes/No boxes; random field names per load (F-569); knockout questions handled outside the page; location field suggests as you type
- **Engine:** median 14 filled, upload 86%, clean 0%, wall 0%, 3.4 left per run, unknown 5%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)
  - F-569 — Rippling's salary question reported as "o8tr6xgz5N" (fixed 2026-09-24)

### Company-site sitemaps (Teradyne, Qorvo, Veeco …)

**medium · listing-only** — 1505 live postings at 3 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Teradyne / Universal Robots (947), Qorvo (376), Veeco (182)
- **Discovery:** sitemap-jobs (plain)
- **Applying:** whatever the Apply button leads to (often SuccessFactors)

### BambooHR

**easy · works** — 997 live postings at 97 companies; 0 applied by him; 3 runs in the window, last 2026-09-24 13:13.

- **Who uses it:** Armstrong Fluid Technology (159), Lunar Outpost (44), Nexthop AI (42), Specter Aerospace (37), Saluda Medical (36), ATI Inc. (25)
- **Recognised by:** `\.bamboohr\.com$`
- **Discovery:** providers/bamboohr.mjs — /careers/list
- **Applying:** extension (generic reader)
- **How it is built:** single page; date masks (mm/dd/yyyy)
- **Engine:** median 15 filled, upload 100%, clean 0%, wall 0%, 5 left per run, unknown 20%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)
- **Notes:** Experience questions left for him when his files say nothing.

### Breezy HR

**easy · works** — 589 live postings at 30 companies; 0 applied by him; 6 runs in the window, last 2026-09-24 13:07.

- **Who uses it:** Bitdeer Group (146), Embraer (71), Bear Robotics (59), VetsEZ (54), Seventh Dimension LLC (54), KBR, Inc. (22)
- **Recognised by:** `\.breezy\.hr$`
- **Discovery:** providers/breezy.mjs — /json
- **Applying:** extension (generic reader)
- **How it is built:** resume parse adds work-history rows; dates bound by ng-model; honeypot field hp_<hash>
- **Engine:** median 27 filled, upload 100%, clean 0%, wall 0%, 8 left per run, unknown 16%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)

### Recruitee

**easy · works** — 321 live postings at 22 companies; 0 applied by him; 1 runs in the window, last 2026-09-24 10:37.

- **Who uses it:** Next Ventures (65), ScioTeq (37), Tetra Tech (35), Basalt (30), Aramark (26), Mantel (26)
- **Recognised by:** `\.recruitee\.com$`
- **Discovery:** providers/recruitee.mjs — /api/offers/
- **Applying:** extension (generic reader)
- **How it is built:** single page
- **Engine:** median 4 filled, upload 100%, clean 100%, wall 0%, 0 left per run, unknown 0%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)

### CareerPuck (wraps Greenhouse)

**medium · works** — 227 live postings at 1 companies; 0 applied by him; 3 runs in the window, last 2026-09-24 15:27.

- **Who uses it:** Lyft, Inc. (227)
- **Recognised by:** `^app\.careerpuck\.com$`
- **Discovery:** via the Greenhouse adapter
- **Applying:** extension — the Greenhouse form in an iframe
- **How it is built:** posting page with an Apply button; the form is Greenhouse's embed in an iframe that can load late
- **Engine:** median 0 filled, upload 0%, clean 0%, wall 0%, 0 left per run, unknown –
- **Faults:**
  - F-571 — A frame that never loaded froze the whole press (fixed 2026-09-24)
  - F-572 — Lyft's Greenhouse form: five wrong or missing answers (fixed 2026-09-24)
- **Notes:** Lyft. A frame that never loaded froze the press until F-571.

### firststage (OpenDigital)

**medium · partial** — 211 live postings at 1 companies; 0 applied by him; 6 runs in the window, last 2026-09-24 15:36.

- **Who uses it:** Wayve (211)
- **Recognised by:** `\.firststage\.co$`
- **Discovery:** none (Greenhouse ids in the URL)
- **Applying:** extension (generic reader)
- **How it is built:** Upload CV → Enter details → Review, on one path under one heading; the CV upload creates a draft under the email in the CV
- **Walls (his to pass):** 'application in progress' page once a draft exists (his)
- **Engine:** median 0 filled, upload 100%, clean 0%, wall 0%, 0 left per run, unknown 0%
- **Faults:**
  - F-573 — A second step under the same heading read as "already filled" (fixed 2026-09-24)
  - F-574 — "An application in progress" read as "something required is empty" (fixed 2026-09-24)
- **Notes:** Wayve. A draft under his email exists from testing.

### Workable

**medium · works** — 85 live postings at 4 companies; 0 applied by him; 8 runs in the window, last 2026-09-24 13:08.

- **Who uses it:** Slip Robotics (33), Alexander Dennis (30), Falcomm (19), Verustruct (3)
- **Recognised by:** `^(apply|jobs)\.workable\.com$`
- **Discovery:** providers/workable.mjs — /<slug>/jobs.md
- **Applying:** extension (generic reader)
- **How it is built:** the scanner's link is a text page; the form lives at /j/<id>/apply/; entries saved with a Save button
- **Engine:** median 0 filled, upload 13%, clean 0%, wall 0%, 3.5 left per run, unknown 27%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)

### Phenom (listing layer)

**medium · listing-only** — 7 live postings at 1 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Thermo Fisher Scientific (7)
- **Discovery:** providers/phenom.mjs — POST /widgets
- **Applying:** the underlying ATS (mostly Workday or SuccessFactors)
- **How it is built:** company-branded search over another ATS
- **Notes:** Thermo Fisher, GE HealthCare, Zimmer Biomet.

### Dover

**easy · works** — 1 live postings at 1 companies; 0 applied by him; 4 runs in the window, last 2026-09-24 14:37.

- **Who uses it:** Loombotic (1)
- **Recognised by:** `^app\.dover\.com$`
- **Discovery:** none
- **Applying:** extension (generic reader)
- **How it is built:** labels are plain <div> lines; Autofill-from-resume parser beside the real slot
- **Engine:** median 5 filled, upload 100%, clean 0%, wall 0%, 1 left per run, unknown 5%
- **Faults:**
  - F-570 — Dover: every box named by its code, resume put in the autofill parser (fixed 2026-09-24)

### Kula

**easy · works** — 1 live postings at 1 companies; 0 applied by him; 2 runs in the window, last 2026-09-24 10:01.

- **Who uses it:** Shinkei (1)
- **Recognised by:** `(^|\.)kula\.ai$`
- **Discovery:** none
- **Applying:** extension (generic reader)
- **Engine:** median 11 filled, upload 100%, clean 0%, wall 0%, 2.5 left per run, unknown 9%

### Oracle Taleo

**hard · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.taleo\.net$`
- **Discovery:** none
- **Applying:** generic reader (never driven)
- **Walls (his to pass):** account

### Handshake

**wall · listing-only** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `joinhandshake\.com$`
- **Discovery:** import-handshake (a harvest he runs in his browser)
- **Applying:** none
- **How it is built:** university SSO
- **Walls (his to pass):** SSO
- **Notes:** One-off by his choice.

### Teamtailor

**easy · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.teamtailor\.com$`
- **Discovery:** provider exists
- **Applying:** generic reader (never driven)

### Pinpoint

**easy · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.pinpointhq\.com$`
- **Discovery:** provider exists
- **Applying:** generic reader (never driven)

### Comeet

**easy · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `comeet\.(co|com)$`
- **Discovery:** provider exists
- **Applying:** generic reader (never driven)

### Personio

**easy · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.jobs\.personio\.(de|com)$`
- **Discovery:** provider exists
- **Applying:** generic reader (never driven)

### Jobvite

**medium · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `^jobs\.jobvite\.com$`
- **Discovery:** none
- **Applying:** generic reader (never driven)

### UKG / UltiPro

**medium · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.(ultipro\.(com|ca)|rec\.pro\.ukg\.net)$`
- **Discovery:** none
- **Applying:** generic reader (never driven)

### ADP

**medium · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.adp\.com$`
- **Discovery:** none
- **Applying:** generic reader (never driven)

### Avature

**medium · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.avature\.net$`
- **Discovery:** none
- **Applying:** generic reader (never driven)

### BrassRing (Kenexa)

**hard · untested** — 0 live postings at 0 companies; 0 applied by him; 0 runs in the window.

- **Recognised by:** `\.brassring\.com$`
- **Discovery:** none
- **Applying:** generic reader (never driven)
- **Walls (his to pass):** account

## Keeping it current

- A new platform met: add an entry to `jarvis/ats-registry.json` (hosts, how it is built, walls, difficulty, automation), then `npm run jarvis:ats -- --md`.
- A fault found on a platform: add its F-id to that vendor's `faults`. Its open/closed state is read from its heading in FAULTS.md.
- Postings on the "Other" line are hosts no entry claims — the list of platforms not yet named.
