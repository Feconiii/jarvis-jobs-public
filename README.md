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

- **Your field, not one built in.** Who it searches for (name, school, degree,
  graduation, work authorization, pay floor) comes from your setup answers,
  and a **preset** sets the field: the words that mark a relevant title, the
  degree check, the discovery searches and the brief the curator reads by.
  Two ship: `hardware-engineering` (mechanical, manufacturing, robotics,
  semiconductor) and `finance-data` (FP&A, financial, data, business and BI
  analyst roles at banks, asset managers, fintechs and the Big Four).
- **Claude or Codex.** The writers and the curator run on the `claude` CLI
  (Claude Code) or the `codex` CLI, whichever you have; setup asks.
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
  fewer than 50 open picks, new postings are read in full against your rules; the keepers go to your Inbox with the reason, and the rest are
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

**The easy way:** run `npm install`, then open this folder in
[Claude Code](https://claude.com/claude-code) or Codex and say *"set me up"*
(in Claude Code, `/jarvis-setup` does the same). The assistant interviews you:
your field, work authorization, school and graduation, pay floor, cities, your
resume. It writes your files with `npm run jarvis:setup`, finds the job boards
of your field's starter companies, turns your resume into `cv.md`, and ends
with the first scan and the browser extension. `AGENTS.md` holds the steps.

**By hand:** see **[SETUP.md](SETUP.md)**. About 20 minutes to a working
dashboard, longer to write your CV and preferences well (which is the part
that matters). `npm run jarvis:setup-check` shows what is left.

```bash
npm install
npx playwright install chromium
npm run jarvis:setup -- --find-boards              # asks the questions, writes your files
npm run jarvis:scan
npm run jarvis:serve                               # http://localhost:4300
```

## The rule that does not change

**Fill everything. Submit nothing.** The engine answers what it can, leaves
what it cannot for you with the reason, and stops at the Submit button on
every form, every time.

## A note on this copy

This copy comes from one person's working system. Code comments explain design
decisions and quote the bugs that drove them; "he" and "his" in them mean that
original user (in the public copy, renamed to a sample persona, "Alex Rivera",
a mechanical-engineering new grad on an F-1 visa). With no setup done, the
code runs as that persona with the `hardware-engineering` preset, which is
also what the tests pin. Your setup answers replace the persona everywhere
the code reads a person, and the resume builder's default layouts
(`jarvis/resume-variants.mjs`, `jarvis/resume-plan.mjs`) are the one place
still written around the persona's employers. SETUP.md says what to change.

## License

MIT — see [LICENSE](LICENSE).
