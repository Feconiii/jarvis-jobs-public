# Application platforms — what Jarvis meets and how well it drives them

Generated 2026-10-19 04:34 UTC by `npm run jarvis:ats -- --md`. **Do not edit by hand** — facts live in `jarvis/ats-registry.json`, numbers are counted from the store, `data/jarvis/answer-log.jsonl` and `jarvis/FAULTS.md`.

Answer-log window: 2026-09-23T22:17 → 2026-10-19T04:33. Engine metrics are only as wide as that window; a small `runs` number is an anecdote, not a rate.

**His answers, replayed** (`npm run jarvis:replay`): 1821 of 2222 answers he sent are what today's planner would send (82%); 99 differ, 163 would be left empty, 39 regress an answer he kept.

## Overview

| Platform | Difficulty | Automation | Live postings | Companies | Applied | Runs | Median filled | Upload | Clean run | Wall | Unknown | Corrected | Open faults |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Workday | hard | works | 359237 | 640 | 29 | 215 | 6 | 67% | 34% | 13% | 8% | 11% | F-267 |
| SAP SuccessFactors | hard | works | 87383 | 224 | 5 | 36 | 13 | 22% | 8% | 47% | 15% | – | – |
| Greenhouse | easy | works | 50717 | 579 | 14 | 106 | 13 | 86% | 30% | 0% | 6% | 11% | – |
| SmartRecruiters | hard | works | 49549 | 187 | 4 | 31 | 53 | 35% | 13% | 0% | 15% | 15% | – |
| iCIMS | wall | wall | 46546 | 155 | 0 | 26 | 0 | 0% | 0% | 65% | 28% | 11% | – |
| Oracle Recruiting Cloud | wall | wall | 39043 | 81 | 3 | 38 | 14 | 55% | 0% | 32% | 27% | 18% | – |
| Eightfold | hard | partial | 34692 | 10 | 25 | 56 | 18 | 95% | 34% | 2% | 2% | 11% | – |
| Amazon (custom) | wall | wall | 30128 | 1 | 3 | 16 | 0 | 31% | 0% | 63% | 24% | 38% | – |
| Lever | easy | works | 19680 | 173 | 8 | 40 | 12 | 93% | 30% | 0% | 6% | 14% | – |
| Ashby | easy | works | 17265 | 428 | 23 | 114 | 5.5 | 84% | 28% | 0% | 9% | 13% | – |
| Phenom (listing layer) | medium | listing-only | 10046 | 19 | 0 | 4 | 3.5 | 25% | 0% | 25% | 33% | 0% | – |
| UKG / UltiPro | medium | untested | 9360 | 107 | 0 | 5 | 6 | 0% | 0% | 20% | 100% | – | – |
| Tesla (custom) | medium | works | 8816 | 2 | 5 | 66 | 8 | 70% | 71% | 3% | 0% | 6% | – |
| Google (custom) | wall | untested | 6911 | 1 | 0 | 0 | – | – | – | – | – | – | – |
| LinkedIn | wall | listing-only | 6286 | 3026 | 4 | 15 | 2 | 53% | 0% | 7% | 14% | 9% | – |
| ADP | medium | untested | 6119 | 164 | 0 | 33 | 0 | 73% | 12% | 45% | 6% | 9% | – |
| Apple (custom) | wall | untested | 6011 | 1 | 0 | 4 | 25.5 | 100% | 0% | 0% | 53% | 24% | – |
| Radancy (listing only) | medium | listing-only | 4876 | 1 | 8 | 0 | – | – | – | – | – | – | – |
| Jibe (Google-hosted career sites) | wall | wall | 2786 | 3 | 0 | 0 | – | – | – | – | – | – | – |
| Pinpoint | easy | untested | 2278 | 13 | 0 | 0 | – | – | – | – | – | – | – |
| Other / unclassified | – | – | 2277 | 112 | 3 | 71 | 10 | 51% | 0% | 18% | 27% | 22% | – |
| Rippling | medium | works | 2176 | 87 | 1 | 26 | 14 | 69% | 4% | 0% | 13% | – | – |
| Company-site sitemaps (Teradyne, Qorvo, Veeco …) | medium | listing-only | 1907 | 4 | 0 | 0 | – | – | – | – | – | – | – |
| Workable | medium | works | 1902 | 48 | 1 | 22 | 3.5 | 45% | 0% | 0% | 25% | 17% | – |
| BambooHR | easy | works | 1802 | 163 | 0 | 13 | 15 | 100% | 8% | 0% | 15% | – | – |
| Breezy HR | easy | works | 1183 | 57 | 0 | 11 | 8 | 73% | 0% | 0% | 14% | – | – |
| Recruitee | easy | works | 443 | 29 | 0 | 2 | 2 | 50% | 50% | 0% | 0% | – | – |
| Oracle Taleo | hard | untested | 413 | 2 | 0 | 0 | – | – | – | – | – | – | – |
| CareerPuck (wraps Greenhouse) | medium | works | 285 | 1 | 0 | 3 | 0 | 0% | 0% | 0% | – | – | – |
| firststage (OpenDigital) | medium | partial | 209 | 1 | 0 | 6 | 0 | 100% | 0% | 0% | 0% | 0% | – |
| Dover | easy | works | 2 | 2 | 0 | 9 | 5 | 100% | 11% | 0% | 9% | – | – |
| Kula | easy | works | 2 | 1 | 0 | 2 | 11 | 100% | 0% | 0% | 9% | – | – |
| Handshake | wall | listing-only | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Teamtailor | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Comeet | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Personio | easy | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
| Jobvite | medium | untested | 0 | 0 | 0 | 0 | – | – | – | – | – | – | – |
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

**hard · works** — 359237 live postings at 640 companies; 29 applied by him; 215 runs in the window, last 2026-10-17 00:42.

- **Who uses it:** Accenture (20968), Thermo Fisher Scientific (6589), Abbott (5750), JLL (5324), GE Vernova (4727), Medtronic (4533)
- **Recognised by:** `\.myworkday(jobs|site)\.com$`
- **Discovery:** providers/workday.mjs — POST /wday/cxs/<tenant>/<site>/jobs
- **Applying:** extension + own Playwright driver (jarvis/apply/workday.mjs)
- **How it is built:** six-step wizard; Next and Submit are the same footer button, told apart by text; prompt widgets: menus of menus, options rendered three times, virtualised lists (F-390); My Experience sections added by Add buttons (entries); sign-in per tenant; some want a Talent Profile account; page CSP blocks calls to localhost
- **Walls (his to pass):** sign-in (Google SSO pressed for him); account creation (his)
- **Engine:** median 6 filled, upload 67%, clean 34%, wall 13%, 1.2 left per run, unknown 8%, he corrected 125 (11%), he answered 137 Jarvis left
- **Faults:**
  - F-06 — Enrichment "failures" are mostly postings that are genuinely dead (closed 2026-10-18 (the rest became F-74 and F-08, both fixed))
  - F-124 — The account wall is far bigger than this ledger has been saying (closed 2026-10-18 (settled by F-127, dissolved by F-129))
  - F-128 — What the account wall actually is, and why I stopped short of automating it (closed 2026-10-18 (dissolved by F-129; he makes employer accounts as he browses))
  - **open** F-267 — The skills box: eight in one engine, none in the other (fixed 2026-10-18 (unverified live))
  - F-325 — Workday's My Experience was the driver's alone; the extension left it to him (fixed, verified live 2026-10-18)
  - F-390 — A required Workday prompt that is a MENU OF MENUS, painted a few rows at a time, blocked the whole application (fixed 2026-09-07)
  - F-555 — Four Workday forms in one night, read back from what he submitted (fixed 2026-09-24)
  - F-553 — The portfolio link is not put in the additional website field (fixed 2026-09-24)
- **Notes:** Biggest pool by far. Fills well once he is signed in; the wall, not the form, is the cost.

### SAP SuccessFactors

**hard · works** — 87383 live postings at 224 companies; 5 applied by him; 36 runs in the window, last 2026-10-16 09:34.

- **Who uses it:** EssilorLuxottica (5720), TE Connectivity (2834), Cargill (2615), Alstom (2605), CNH (2478), CRH plc (2125)
- **Recognised by:** `\.(successfactors|sapsf)\.(com|eu)$`, `\.ns2cloud\.com$`
- **Discovery:** providers/successfactors.mjs — <host>/sitemap.xml
- **Applying:** extension (generic reader)
- **How it is built:** account required before the form; the form is collapsed sections (F-577); menus are text inputs with a 'No Selection' placeholder (F-578); radios with the question outside the group (F-561); career sites (RMK/jobs2web) send Apply to an email or sign-in step
- **Walls (his to pass):** account sign-in (his)
- **Engine:** median 13 filled, upload 22%, clean 8%, wall 47%, 3.8 left per run, unknown 15%
- **Faults:**
  - F-78 — The real apply gap is SuccessFactors, and `resolveApplyUrl` cannot see it (closed 2026-10-18 (corrected by F-89, dissolved by F-129))
  - F-89 — SuccessFactors is account-gated, not adapter-missing (closed 2026-10-18 (dissolved by F-129: he applies in his own browser))
  - F-561 — SuccessFactors radios were read with no options and no question (fixed 2026-09-24, verified in his Chrome (TSMC: GPA, graduation year and semester, essential functions all selected))
  - F-577 — TSMC's questions sat inside closed sections (fixed 2026-09-24, verified in his Chrome)
  - F-578 — "No" chose "No Selection", and a placeholder read as an answer (fixed 2026-09-24, verified in his Chrome)
- **Notes:** TSMC fills completely once he is signed in (2026-09-24). Teradyne, Veeco, Skyworks and Qorvo career sites stop at their email/sign-in step.

### Greenhouse

**easy · works** — 50717 live postings at 579 companies; 14 applied by him; 106 runs in the window, last 2026-10-16 19:51.

- **Who uses it:** Coupang Inc. (1653), Lucid Motors (1594), Databricks (1161), Rocket Lab (1151), Stripe (1032), Anthropic (1026)
- **Recognised by:** `(^|\.)greenhouse\.io$`
- **Discovery:** providers/greenhouse.mjs — boards-api.greenhouse.io/v1/boards/<slug>/jobs
- **Applying:** extension + thin Playwright driver (jarvis/apply/greenhouse.mjs)
- **How it is built:** plain HTML form or react-select comboboxes; on company sites the form is an iframe embed (job_app) that loads late; custom questions per employer; statements instead of Yes/No (F-572); question API: boards-api …/jobs/<id>?questions=true lists every question and option
- **Engine:** median 13 filled, upload 86%, clean 30%, wall 0%, 1 left per run, unknown 6%, he corrected 18 (11%), he answered 20 Jarvis left
- **Faults:**
  - F-571 — A frame that never loaded froze the whole press (fixed 2026-09-24)
  - F-572 — Lyft's Greenhouse form: five wrong or missing answers (fixed 2026-09-24)
  - F-575 — Waymo: a Job Alerts form read as the application, hex codes in every label (fixed 2026-09-24)
  - F-576 — AST SpaceMobile and ASM (Greenhouse embeds): five unanswered, three answerable (fixed 2026-09-24)
- **Notes:** The easiest large pool. Company-site wrappers (Waymo, Formlabs, AST, ASM, Lucid) are Greenhouse underneath.

### SmartRecruiters

**hard · works** — 49549 live postings at 187 companies; 4 applied by him; 31 runs in the window, last 2026-10-04 01:24.

- **Who uses it:** Bosch (9666), AbbVie (6490), SGS (5249), Eurofins (4399), ServiceNow (2215), New York City Housing Authority (NYCHA) (2210)
- **Recognised by:** `smartrecruiters\.com$`
- **Discovery:** providers/smartrecruiters.mjs — api.smartrecruiters.com/v1/companies/<slug>/postings
- **Applying:** extension in HIS browser only (DataDome blocks automated browsers)
- **How it is built:** spl-*/oc-* web components inside shadow roots (F-327); two dropzones: Easy Apply parser and the real resume slot (F-352); multi-step; each step a new document; Back redraws entries; experience/education entries via Add buttons; location search lists 'City, ST, US'
- **Walls (his to pass):** DataDome bot check (his to clear)
- **Engine:** median 53 filled, upload 35%, clean 13%, wall 0%, 8.1 left per run, unknown 15%, he corrected 27 (15%), he answered 67 Jarvis left
- **Faults:**
  - F-113 — SmartRecruiters postings in the deck are mostly dead (closed 2026-10-18 (dead SmartRecruiters rows retire through the public API))
  - F-119 — Every source checked for the SmartRecruiters defect (CHECKED, one real, one cleared)
  - F-562 — SmartRecruiters re-fills a page he goes back to review (fixed 2026-09-24, verified in his Chrome)
  - F-563 — SmartRecruiters' dropzone never keeps the resume (fixed 2026-09-24, verified in his Chrome)
  - F-567 — The live Western Digital run, end to end: seven more faults (fixed 2026-09-24)
- **Notes:** Western Digital's form fills end to end in his Chrome (2026-09-24).

### iCIMS

**wall · wall** — 46546 live postings at 155 companies; 0 applied by him; 26 runs in the window, last 2026-10-03 07:37.

- **Who uses it:** Enterprise Mobility (3464), Sargent & Lundy (2822), Schneider Electric (2621), Costco Wholesale (2047), Ohmstede (1888), MasTec Civil (1875)
- **Recognised by:** `\.icims\.com$`
- **Discovery:** providers/icims.mjs (sitemap, blocked for servers since F-448) + icims-careers (<origin>/api/jobs, F-454)
- **Applying:** extension (generic reader)
- **How it is built:** form in an iframe (#icims_content_iframe); the flow can also load top-level; Apply lands on a /login "Enter Your Information" screen: email, a residency box (CA or EU/UK), a privacy "I accept" hidden until the residency box is ticked, and hCaptcha; human-verification pages are refused on purpose (F-114)
- **Walls (his to pass):** hCaptcha on the email screen (his); Next on the email screen, then any emailed code or password (his); human check pages (his)
- **Engine:** median 0 filled, upload 0%, clean 0%, wall 65%, 0.9 left per run, unknown 28%, he corrected 3 (11%), he answered 19 Jarvis left
- **Faults:**
  - F-114 — CLOSED — the bot check is refused on purpose, and now it says so ((no status in heading))
  - F-448 — The iCIMS sitemap is gated now, and the provider still says it is not (fixed 2026-09-17)
  - F-454 — The gated board had an ungated front door the whole time (fixed 2026-09-10)
  - F-583 — iCIMS' email screen was named and never filled (fixed 2026-09-24 (1.50.0), not yet driven past the captcha)
- **Notes:** Rivian, Quanta, Joby, AMD, Marvell, Werfen. Since F-583 the email screen is filled (email, residency box by job location, privacy consent) and he does the captcha and Next. The pages after it have never been driven — the next step is one live pass past the captcha.

### Oracle Recruiting Cloud

**wall · wall** — 39043 live postings at 81 companies; 3 applied by him; 38 runs in the window, last 2026-10-16 10:25.

- **Who uses it:** Honeywell (3425), Quest Diagnostics (3025), Vertiv (2899), Emerson (2509), Clean Harbors (1745), Cummins Inc. (1595)
- **Recognised by:** `\.oraclecloud\.com$`, `^careers\.ti\.com$`
- **Discovery:** providers/oracle-orc.mjs — /hcmRestApi/resources/latest/recruitingCEJobRequisitions
- **Applying:** extension (generic reader)
- **How it is built:** email, then an emailed code, before any form (F-345); Apply button without a link (F-112)
- **Walls (his to pass):** email + one-time code (his)
- **Engine:** median 14 filled, upload 55%, clean 0%, wall 32%, 7.3 left per run, unknown 27%, he corrected 25 (18%), he answered 12 Jarvis left
- **Faults:**
  - F-345 — TI's terms box was invisible to the reader, and its email step read as a submit (fixed 2026-09-05)
  - F-112 — Oracle Recruiting reached no form on any tenant but TI (fixed)
- **Notes:** Honeywell, Emerson, TI, onsemi.

### Eightfold

**hard · partial** — 34692 live postings at 10 companies; 25 applied by him; 56 runs in the window, last 2026-10-19 04:33.

- **Who uses it:** Microsoft (7629), Eaton (6183), Micron Technology (6164), Qualcomm (4256), Lam Research (3914), Infineon (3061)
- **Recognised by:** `\.eightfold\.ai$`, `^(careers\.micron\.com|careers\.lamresearch\.com|careers\.qualcomm\.com|jobs\.infineon\.com|careers\.gf\.com|careers\.deere\.com|apply\.careers\.microsoft\.com|jobs\.careers\.microsoft\.com|careers\.appliedmaterials\.com)$`
- **Discovery:** sitemap (eightfold style); the PCSX API answers 'Not authorized' (F-428)
- **Applying:** extension + Playwright driver (jarvis/apply/eightfold.mjs)
- **How it is built:** entry point is a resume upload that parses into the form (F-152); reCAPTCHA helper frame on every page (F-318); sign-in with Google/Microsoft/LinkedIn on GF, Micron, Microsoft, Lam
- **Walls (his to pass):** SSO sign-in (his)
- **Engine:** median 18 filled, upload 95%, clean 34%, wall 2%, 1.3 left per run, unknown 2%, he corrected 22 (11%), he answered 12 Jarvis left
- **Faults:**
  - F-152 — Eightfold's entry point is an upload, not a form (closed 2026-10-18 (correct behaviour, recorded as a note))
  - F-318 — A reCAPTCHA iframe spoke for the tab on every Eightfold page (fixed)
  - F-428 — His most important employers are the ones we cannot read (fixed 2026-10-18)
  - F-465 — Micron (Eightfold) is the hardest form the extension meets (fixed 2026-10-18 (measured live))
- **Notes:** His most important employers (Applied Materials, Lam, Micron, Qualcomm). Micron is the hardest form met (F-465).

### Amazon (custom)

**wall · wall** — 30128 live postings at 1 companies; 3 applied by him; 16 runs in the window, last 2026-10-16 06:43.

- **Who uses it:** Amazon (30128)
- **Recognised by:** `(^|\.)amazon\.jobs$`
- **Discovery:** providers/amazon-jobs.mjs — /en/search.json
- **Applying:** extension (generic reader)
- **How it is built:** sign-in at passport.amazon.jobs before the form (F-233)
- **Walls (his to pass):** Amazon sign-in (his)
- **Engine:** median 0 filled, upload 31%, clean 0%, wall 63%, 1.4 left per run, unknown 24%, he corrected 3 (38%), he answered 9 Jarvis left
- **Faults:**
  - F-233 — It would have typed his email into Amazon's login form and called it filled (fixed)
  - F-380 — An injection that never came back stranded the tab, and Amazon's "you have already applied" went unrecorded (fixed 2026-09-06)

### Lever

**easy · works** — 19680 live postings at 173 companies; 8 applied by him; 40 runs in the window, last 2026-10-16 08:37.

- **Who uses it:** Jobgether (10506), Veeva Systems (1205), Distro (700), Welocalize (524), CesiumAstro (419), Zoox (389)
- **Recognised by:** `^jobs(\.eu)?\.lever\.co$`
- **Discovery:** providers/lever.mjs — api.lever.co/v0/postings/<slug>
- **Applying:** extension + Playwright driver (jarvis/apply/lever.mjs)
- **How it is built:** single page; custom questions named cards[<uuid>][fieldN] with the question in .application-label
- **Engine:** median 12 filled, upload 93%, clean 30%, wall 0%, 1 left per run, unknown 6%, he corrected 9 (14%), he answered 12 Jarvis left
- **Notes:** No runs in the current answer-log window.

### Ashby

**easy · works** — 17265 live postings at 428 companies; 23 applied by him; 114 runs in the window, last 2026-10-17 01:09.

- **Who uses it:** OpenAI (1336), Crusoe (525), Legora (472), Applied Intuition (454), Snowflake (367), Finni Health (360)
- **Recognised by:** `^jobs\.ashbyhq\.com$`
- **Discovery:** providers/ashby.mjs — api.ashbyhq.com/posting-api/job-board/<slug>
- **Applying:** extension + Playwright driver (jarvis/apply/ashby.mjs)
- **How it is built:** single-page React form; an 'Autofill from resume' parser beside the real resume slot
- **Engine:** median 5.5 filled, upload 84%, clean 28%, wall 0%, 0.9 left per run, unknown 9%, he corrected 31 (13%), he answered 62 Jarvis left
- **Faults:**
  - F-191 — A dead posting reported "0 filled", and liveness called it active (fixed 2026-10-18)

### Phenom (listing layer)

**medium · listing-only** — 10046 live postings at 19 companies; 0 applied by him; 4 runs in the window, last 2026-10-03 07:29.

- **Who uses it:** Frontline Consulting Services (FCS) (3201), Quest Global (2097), Merck KGaA Darmstadt Germany (1171), Exyte (641), Xoriant (583), Sonova Group (491)
- **Discovery:** providers/phenom.mjs — POST /widgets
- **Applying:** the underlying ATS (mostly Workday or SuccessFactors)
- **How it is built:** company-branded search over another ATS
- **Engine:** median 3.5 filled, upload 25%, clean 0%, wall 25%, 7.3 left per run, unknown 33%, he answered 4 Jarvis left
- **Notes:** Thermo Fisher, GE HealthCare, Zimmer Biomet.

### UKG / UltiPro

**medium · untested** — 9360 live postings at 107 companies; 0 applied by him; 5 runs in the window, last 2026-10-16 09:46.

- **Who uses it:** Salas O'Brien (515), Ultra Clean Technology (499), Simmons Foods (418), Arcosa (338), Pretium Packaging (254), Dodge Industrial (239)
- **Recognised by:** `\.(ultipro\.(com|ca)|rec\.pro\.ukg\.net)$`
- **Discovery:** none
- **Applying:** generic reader (never driven)
- **Engine:** median 6 filled, upload 0%, clean 0%, wall 20%, 14 left per run, unknown 100%

### Tesla (custom)

**medium · works** — 8816 live postings at 2 companies; 5 applied by him; 66 runs in the window, last 2026-10-01 08:07.

- **Who uses it:** Tesla (8660), Symbotic (156)
- **Recognised by:** `(^|\.)tesla\.com$`
- **Discovery:** browser-assist only (servers get 403)
- **Applying:** extension (generic reader)
- **How it is built:** 403 to anything but a real browser; its 'Next' can submit — guarded
- **Engine:** median 8 filled, upload 70%, clean 71%, wall 3%, 0 left per run, unknown 0%, he corrected 14 (6%), he answered 13 Jarvis left
- **Faults:**
  - F-88 — Tesla is applyable after all (CORRECTS F-07 and F-10)

### Google (custom)

**wall · untested** — 6911 live postings at 1 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Alphabet (Google) (6911)
- **Recognised by:** `^careers\.google\.com$`
- **Discovery:** sitemap
- **Applying:** generic reader (never driven)
- **How it is built:** Google sign-in
- **Walls (his to pass):** Google account

### LinkedIn

**wall · listing-only** — 6286 live postings at 3026 companies; 4 applied by him; 15 runs in the window, last 2026-10-04 09:23.

- **Who uses it:** Ford Motor Company (46), Molex (27), BioSpace (25), Honeywell Aerospace (25), Siemens (24), Amphenol Communications Solutions (23)
- **Recognised by:** `(^|\.)linkedin\.com$`
- **Discovery:** discover-linkedin (company names) + import-linkedin (postings with no readable board)
- **Applying:** none — the apply link is behind a login
- **Walls (his to pass):** LinkedIn login
- **Engine:** median 2 filled, upload 53%, clean 0%, wall 7%, 6.2 left per run, unknown 14%, he corrected 29 (9%), he answered 59 Jarvis left
- **Notes:** Used to find companies, not to apply.

### ADP

**medium · untested** — 6119 live postings at 164 companies; 0 applied by him; 33 runs in the window, last 2026-10-18 01:19.

- **Who uses it:** Pursuit Aerospace (294), Hazen and Sawyer (232), Fuyao Glass America (209), ESP Associates (185), Olgoonik (174), MP Materials (171)
- **Recognised by:** `\.adp\.com$`
- **Discovery:** none
- **Applying:** generic reader (never driven)
- **Engine:** median 0 filled, upload 73%, clean 12%, wall 45%, 0.4 left per run, unknown 6%, he corrected 10 (9%), he answered 3 Jarvis left

### Apple (custom)

**wall · untested** — 6011 live postings at 1 companies; 0 applied by him; 4 runs in the window, last 2026-10-16 18:43.

- **Who uses it:** Apple (6011)
- **Recognised by:** `^jobs\.apple\.com$`
- **Discovery:** sitemap
- **Applying:** generic reader (never driven)
- **How it is built:** Apple ID sign-in
- **Walls (his to pass):** Apple ID
- **Engine:** median 25.5 filled, upload 100%, clean 0%, wall 0%, 42.5 left per run, unknown 53%, he corrected 10 (24%), he answered 77 Jarvis left

### Radancy (listing only)

**medium · listing-only** — 4876 live postings at 1 companies; 8 applied by him; 0 runs in the window.

- **Who uses it:** Applied Materials (4876)
- **Recognised by:** `^jobs\.appliedmaterials\.com$`
- **Discovery:** sitemap (radancy)
- **Applying:** Apply goes to Eightfold (careers.appliedmaterials.com)
- **How it is built:** posting pages only
- **Faults:**
  - F-366 — Apply that led to the same job on its ATS was read as "a different job", and the follow-on refused to apply (fixed 2026-09-06)
- **Notes:** Applied Materials.

### Jibe (Google-hosted career sites)

**wall · wall** — 2786 live postings at 3 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** AMD (2516), Applied Medical (225), Applied Medical Europe B.V. (45)
- **Recognised by:** `\.jibeapply\.com$`, `^careers\.amd\.com$`
- **Discovery:** providers/jibeapply.mjs — /api/jobs
- **Applying:** hands off to the employer's ATS (AMD: iCIMS login)
- **How it is built:** listing layer only
- **Walls (his to pass):** the underlying ATS's login
- **Notes:** AMD.

### Pinpoint

**easy · untested** — 2278 live postings at 13 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Wilson Engineers (1012), HOLT Manufacturing (342), Align Technology (256), Impulse Space (226), Franklin Electric (109), Foxconn WI (108)
- **Recognised by:** `\.pinpointhq\.com$`
- **Discovery:** provider exists
- **Applying:** generic reader (never driven)

### Rippling

**medium · works** — 2176 live postings at 87 companies; 1 applied by him; 26 runs in the window, last 2026-10-16 08:21.

- **Who uses it:** Rippling (559), VulcanForms (144), Aalo Atomics (100), TYLsemi (81), Riot Platforms (80), Albers Aerospace (61)
- **Recognised by:** `(^|\.)(ats\.rippling\.com|rippling-ats\.com)$`
- **Discovery:** providers/rippling.mjs — api.rippling.com …/board/<slug>/jobs
- **Applying:** extension (generic reader)
- **How it is built:** hidden native inputs behind styled Yes/No boxes; random field names per load (F-569); knockout questions handled outside the page; location field suggests as you type
- **Engine:** median 14 filled, upload 69%, clean 4%, wall 0%, 2.5 left per run, unknown 13%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)
  - F-569 — Rippling's salary question reported as "o8tr6xgz5N" (fixed 2026-09-24)

### Company-site sitemaps (Teradyne, Qorvo, Veeco …)

**medium · listing-only** — 1907 live postings at 4 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** Teradyne / Universal Robots (1127), Qorvo (442), Veeco (213), Enpro (125)
- **Discovery:** sitemap-jobs (plain)
- **Applying:** whatever the Apply button leads to (often SuccessFactors)

### Workable

**medium · works** — 1902 live postings at 48 companies; 1 applied by him; 22 runs in the window, last 2026-10-16 06:37.

- **Who uses it:** LaBella Associates (211), SOGECLAIR (122), Thorlabs (105), New Flyer (91), TP-Link Systems (86), Rimkus (82)
- **Recognised by:** `^(apply|jobs)\.workable\.com$`
- **Discovery:** providers/workable.mjs — /<slug>/jobs.md
- **Applying:** extension (generic reader)
- **How it is built:** the scanner's link is a text page; the form lives at /j/<id>/apply/; entries saved with a Save button
- **Engine:** median 3.5 filled, upload 45%, clean 0%, wall 0%, 2.4 left per run, unknown 25%, he corrected 1 (17%), he answered 2 Jarvis left
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)

### BambooHR

**easy · works** — 1802 live postings at 163 companies; 0 applied by him; 13 runs in the window, last 2026-09-26 09:06.

- **Who uses it:** Armstrong Fluid Technology (190), Clopay Corporation (81), Nexthop AI (47), Lunar Outpost (44), ELYON International (43), Specter Aerospace (39)
- **Recognised by:** `\.bamboohr\.com$`
- **Discovery:** providers/bamboohr.mjs — /careers/list
- **Applying:** extension (generic reader)
- **How it is built:** single page; date masks (mm/dd/yyyy)
- **Engine:** median 15 filled, upload 100%, clean 8%, wall 0%, 2.9 left per run, unknown 15%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)
- **Notes:** Experience questions left for him when his files say nothing.

### Breezy HR

**easy · works** — 1183 live postings at 57 companies; 0 applied by him; 11 runs in the window, last 2026-09-26 08:29.

- **Who uses it:** Bitdeer Group (181), Embraer (103), North Wind (88), VetsEZ (75), Bear Robotics (61), Seventh Dimension LLC (58)
- **Recognised by:** `\.breezy\.hr$`
- **Discovery:** providers/breezy.mjs — /json
- **Applying:** extension (generic reader)
- **How it is built:** resume parse adds work-history rows; dates bound by ng-model; honeypot field hp_<hash>
- **Engine:** median 8 filled, upload 73%, clean 0%, wall 0%, 5.1 left per run, unknown 14%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)

### Recruitee

**easy · works** — 443 live postings at 29 companies; 0 applied by him; 2 runs in the window, last 2026-09-25 22:54.

- **Who uses it:** Voortman Steel Machinery (90), Next Ventures (78), Tetra Tech (53), ScioTeq (41), Benchmark Electronics, Inc. (30), Aramark (26)
- **Recognised by:** `\.recruitee\.com$`
- **Discovery:** providers/recruitee.mjs — /api/offers/
- **Applying:** extension (generic reader)
- **How it is built:** single page
- **Engine:** median 2 filled, upload 50%, clean 50%, wall 0%, 0 left per run, unknown 0%
- **Faults:**
  - F-565 — Platforms Jarvis had never been driven on (fixed 2026-09-24)

### Oracle Taleo

**hard · untested** — 413 live postings at 2 companies; 0 applied by him; 0 runs in the window.

- **Who uses it:** United Airlines Holdings (229), Vontier (184)
- **Recognised by:** `\.taleo\.net$`
- **Discovery:** none
- **Applying:** generic reader (never driven)
- **Walls (his to pass):** account

### CareerPuck (wraps Greenhouse)

**medium · works** — 285 live postings at 1 companies; 0 applied by him; 3 runs in the window, last 2026-09-24 15:27.

- **Who uses it:** Lyft, Inc. (285)
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

**medium · partial** — 209 live postings at 1 companies; 0 applied by him; 6 runs in the window, last 2026-09-24 15:36.

- **Who uses it:** Wayve (209)
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

### Dover

**easy · works** — 2 live postings at 2 companies; 0 applied by him; 9 runs in the window, last 2026-10-16 19:45.

- **Who uses it:** Loombotic (1), Weave Robotics (1)
- **Recognised by:** `^app\.dover\.com$`
- **Discovery:** none
- **Applying:** extension (generic reader)
- **How it is built:** labels are plain <div> lines; Autofill-from-resume parser beside the real slot
- **Engine:** median 5 filled, upload 100%, clean 11%, wall 0%, 0.9 left per run, unknown 9%
- **Faults:**
  - F-570 — Dover: every box named by its code, resume put in the autofill parser (fixed 2026-09-24)

### Kula

**easy · works** — 2 live postings at 1 companies; 0 applied by him; 2 runs in the window, last 2026-09-24 10:01.

- **Who uses it:** Shinkei (2)
- **Recognised by:** `(^|\.)kula\.ai$`
- **Discovery:** none
- **Applying:** extension (generic reader)
- **Engine:** median 11 filled, upload 100%, clean 0%, wall 0%, 2.5 left per run, unknown 9%

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
