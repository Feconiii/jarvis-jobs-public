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
  Jobvite career sites are read too.
- **A coverage ledger that keeps going.** Every employer any source names goes
  into one table with what happened when its board was looked up; the
  dashboard resolves 1,500 a day. Weekly passes replace a big employer's thin
  board with the one it really uses, look for employers' separate
  early-career boards, and measure how many live postings from outside the
  scanner (Simplify's new-grad list, public ATS feeds) the store holds. Every
  day, Simplify's new-grad listings in your field's categories come in through
  the same import path, and Runway's postings name boards for employers not
  yet tracked.
- **H-1B record.** For anyone who needs sponsorship, each employer's count of
  H-1B petitions (from the Department of Labor's public LCA file, which you
  download into Downloads in your browser) shows on its cards and breaks ties.
- **Triage that flags, never drops.** Seniority, visa and sponsorship language,
  security-clearance and citizenship requirements, degree mismatches,
  graduation windows, shifts, pay parsed out of the text — all recorded on the
  posting, all visible, all reversible.
- **Fit scoring from your own words.** A plain-English preferences file
  (`never night shift`, `prefer in location Austin`) the scorer reads every run.
- **A curated shortlist that refills itself.** Every 6 hours, when you have
  fewer than 50 open picks, new postings are read in full against your rules; the keepers go to your Inbox with the reason, and the rest are
  marked so they are never read again. Before any model reads, the whole
  library is screened against your hard rules in code (`npm run jarvis:screen`),
  so the reader never runs dry while open postings remain. Each pick carries a
  "why here" line built from the fit score's parts and your rules; a stretch
  role is labelled "Reach" and sorted after the fits instead of dropped. The
  Inbox strip shows the search's state and says when something is wrong. On
  Windows, `jarvis/register-daily-search.ps1` adds a scheduled search at
  7:30 AM and 5:10 PM.
- **Liveness.** Postings are re-checked against the ATS API and retired only on
  a definitive 404/410 — a false "expired" costs you a real job.
- **Resumes.** A tailored PDF per posting, selected and reworded from a bullet
  pool that is checked word for word against your `cv.md`; a layout check on
  the rendered page; nothing claimed that your CV does not say.
- **The browser extension.** Fills every field it can from your profile —
  Workday included (prompts, multi-selects, date spinners, My Experience
  entries, language ladders) — attaches the resume, writes open-ended answers
  from your CV, ticks the consents you said yes to, logs every answer and the
  form as you sent it, and stops at Submit. It handles Oracle's list boxes,
  school lists that need their own spelling, and address autocomplete; it
  never scrolls the page under you, and leaves alone a field you have touched.
  On a posting your work authorization rules out (citizens only, will not
  sponsor, a clearance), it fills nothing and shows the posting's own sentence
  with a **Fill anyway** button. Each run reports where its time went.
- **Sites that block servers.** Some careers sites refuse every non-browser
  request. For those, a harvest script run on the careers page in your own
  browser hands the descriptions to the dashboard
  (`localhost:4300/assist-bridge`); nothing is created from them, only
  existing postings filled in.
- **Tracking.** An Applications board (a heart moves a posting to Tracking),
  and optional read-only Gmail reading that moves a card forward when a
  confirmation, interview or rejection arrives, matching the email to the
  posting by its requisition number when it has one.
- **Outreach (optional).** The Outreach tab finds people at a company from its
  own hiring posts and their public profiles, keeps a list, re-reads those
  people's public profiles every few days for new "my team is hiring" posts, and drafts
  messages from your CV. The extension fills the LinkedIn message box for you;
  **nothing is sent unless you press Send all or schedule a send yourself**
  (`node jarvis/send-outreach.mjs --at "tue 11am-1pm"`). A signed-in LinkedIn
  tool for Claude Code ships in `.mcp.json` with a read-only, paced guard
  (`jarvis/linkedin-mcp-guard.mjs`, attached in `.claude/settings.json`) that
  refuses sending, connecting and bulk reads.

## Getting started

**The easy way:** run `npm install`, then open this folder in
[Claude Code](https://claude.com/claude-code) or Codex and say hello. With no
profile yet, the assistant starts the setup interview by itself (in Claude
Code, `/jarvis-setup` starts it any time). It asks one topic at a time:
which AI and plan you use (a smaller plan makes the daily search read less,
so it stays inside your usage limit), your background and resume, your job
goals (field, titles, level, cities or remote, pay, start date, companies to
aim at or avoid, dealbreakers) and how you want to work (how often, how many
applications, how much it writes for you). It shows you a summary to
confirm, writes your own files (never committed), finds the job boards of
the companies you named and your field's starters, turns your resume into
`cv.md`, and ends with the first scan and the browser extension. Run it
again any time to change an answer.

The assistant's instructions are in [AGENTS.md](AGENTS.md) (Codex and most
other assistants read it) and [CLAUDE.md](CLAUDE.md) (the same text, for
Claude Code): what each part does, a normal day, the commands and the rules
it keeps.

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
(`jarvis/resume-variants.mjs`, `jarvis/resume-plan.mjs`) are still written
around the persona's employers. SETUP.md says what to change.

Some newer discovery passes are still tuned to engineering roles whatever
your preset: the weekly coverage meter measures with engineering title words,
and the LinkedIn hiring-list reader has searches only for
`hardware-engineering`. For another field they find less, but they never hide
a posting.

## License

MIT — see [LICENSE](LICENSE).
