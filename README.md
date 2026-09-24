# Jarvis Jobs

A private, local job-search engine for one person. It finds postings straight
from company applicant-tracking systems, flags what does not fit instead of
silently dropping it, scores fit against your own rules, tailors a resume per
posting from your CV, and fills application forms in your browser — **and it
never presses Submit.** That press is always yours.

It runs on your machine: a Node server with a SQLite store, a dashboard at
`localhost:4300`, and a Chromium extension that works on the application pages
you open.

> Built on [career-ops](https://github.com/santifer/career-ops) (MIT) and since
> rewritten almost entirely. Nothing here talks to a hosted service; your data
> stays in your folder.

## What it does

- **Discovery from the source.** Reads Greenhouse, Lever, Ashby, SmartRecruiters,
  Workday and a dozen other ATS APIs directly for every company you track, plus
  tools that widen the list: resolve company names to verified boards, pull
  company names from public indexes (LinkedIn guest search, Built In, HN "Who is
  hiring", YC, The Muse, Climatebase) and check each board with a live call.
- **Triage that flags, never drops.** Seniority, visa and sponsorship language,
  security-clearance and citizenship requirements, degree mismatches,
  graduation windows, shifts, pay parsed out of the text — all recorded on the
  posting, all visible, all reversible.
- **Fit scoring from your own words.** A plain-English preferences file
  (`never night shift`, `prefer in location Austin`) the scorer reads every run.
- **A curated shortlist that refills itself.** Every 6 hours, when you have
  fewer than 50 open picks, new postings are read in full by Claude against
  your rules; the keepers go to your Inbox with the reason, and the rest are
  marked so they are never read again.
- **Liveness.** Postings are re-checked against the ATS API and retired only on
  a definitive 404/410 — a false "expired" costs you a real job.
- **Resumes.** A tailored PDF per posting, selected and reworded from a bullet
  pool that is checked word for word against your `cv.md`; a layout check on
  the rendered page; nothing claimed that your CV does not say.
- **The browser extension.** Fills every field it can from your profile —
  Workday included (prompts, multi-selects, date spinners, My Experience
  entries, language ladders) — attaches the resume, writes open-ended answers
  from your CV, ticks the consents you said yes to, logs every answer and the
  form as you sent it, and stops at Submit.
- **Tracking.** An Applications board, and optional read-only Gmail reading
  that moves a card forward when a confirmation, interview or rejection arrives.

## Getting started

See **[SETUP.md](SETUP.md)** — about 20 minutes to a working dashboard, longer
to write your CV and preferences well (which is the part that matters).

```bash
npm install
npx playwright install chromium
cp examples/portals.example.yml portals.yml        # then edit
npm run jarvis:scan
npm run jarvis:serve                               # http://localhost:4300
```

## The rule that does not change

**Fill everything. Submit nothing.** The engine answers what it can, leaves
what it cannot for you with the reason, and stops at the Submit button on
every form, every time.

## A note on this copy

This is a public, de-identified copy of one person's working system. Code
comments explain design decisions and quote the bugs that drove them, with the
owner renamed to a sample persona ("Alex Rivera", a mechanical-engineering new
grad on an F-1 visa). Some defaults reflect that persona: the resume builder's
layouts and ordering (`jarvis/resume-variants.mjs`, `jarvis/resume-plan.mjs`)
name the persona's employers, and the fit engine is tuned for hardware
engineering. SETUP.md says what to change for your own search.

## License

MIT — see [LICENSE](LICENSE).
