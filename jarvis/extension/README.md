# Jarvis Apply — the Chrome extension

The hands. Everything it knows, it asks the dashboard for.

## Install it (once)

1. Start the dashboard: `npm run jarvis:serve`
2. Open `chrome://extensions` in the Chrome you are signed into
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → pick this folder (`jarvis/extension`)
5. Pin the Jarvis icon to the toolbar

There is nothing to configure. It finds the dashboard on `localhost:4300` and
takes a token from it automatically. After that it keeps itself up to date:
when the repo moves ahead, the extension reloads itself from disk within a few
minutes (never mid-application).

## Use it

Open a posting — any posting, in the store or not — and press the Jarvis
button once (or **Alt+Shift+J**). That press does three things:

1. **Reads the posting** off the page and tells the dashboard which job this
   is. If the store has never seen it, it is recorded now, and the tailored
   resume starts building in the background straight away — so it is ready by
   the time the form reaches its upload step.
2. **Follows Apply** and fills whatever form appears. A Workday application is
   six screens with the resume upload on screen two; it fills a screen, presses
   Save and Continue, fills the next, and **stops at the last screen before
   Submit.**
3. **Arms the tab.** From now on the tab is followed: every page it lands on
   and every step that appears is filled by itself, with no second press.

That third part is what makes the human steps cost nothing:

- **Sign-in, account creation, verification codes, human checks are yours.**
  The panel says so and waits. Do them; the moment the form appears, it fills.
  Identity-provider pages (Google, Microsoft, LinkedIn sign-in) are never even
  read.
- **A step it could not finish** — a question the profile cannot answer — is
  listed in the panel, and every line on that list has an **ask Claude** link
  beside it. One click writes the answer from `cv.md` and this posting, and
  offers **copy**, **put it in the box** and **write it again**. Under the list
  there is a box for anything else on the form: paste the question, get an
  answer. Nothing in that strip types by itself — every one of them is a click.

## The written questions

"Tell us about a project you are proud of." "Why Applied Intuition?" "What is
your favourite thing you have built and why." No answer table will ever hold
these, because the answer is prose about his own work — so they are
**written**, the same way the resume and the cover letter are, and typed into
the box.

**The rule is the box, not the wording.** Any open writing box the answer table
could not answer gets an answer; it does not have to match a phrasing anyone
thought of in advance. The question patterns decide what SHAPE the answer takes
— a project answer is told to read like an engineer telling it, a "why us"
answer is built only from what the posting says they do — and an unrecognised
question simply gets "a direct answer to exactly what was asked", which the
model can read far better than a regex can guess at.

A single-line input is still never one, however its label reads: those are
"Website" and "LinkedIn URL", and a paragraph in a one-line box is worse than
a blank. A box with nothing asked in it is a box, not a question.

They start on the step that plans them, in parallel with the fill, so three of
them on one form do not become three waits in a row at the end of the walk.

What keeps them honest (`jarvis/apply/essay.mjs`):

- Every fact comes from `cv.md`, `config/profile.yml`'s narrative and the
  posting. Every **figure** and every **named thing** in the answer must trace
  to one of those or it fails and is written again.
- Unlike the cover letter, **his own figures are welcome** — a question about a
  project he is proud of is better with the 70% and the $57,000 in it.
- It never volunteers what he has not done. No "I have not", no "while I have
  limited experience in" (F-408).
- **It never touches** self-identification, demographics, pay, notice period,
  start date, references, background checks or credentials — whatever shape the
  question is in. Those are his.
- A draft that fails is asked for once more with the problems named. A second
  failure still comes back, **with its problems listed in the panel**, because
  he reads every one of these before Submit.

The panel lists what was written, how long each answer ran, and anything its
check could not clear. Submit is still his.
- **Real page loads** (iCIMS, Taleo, SuccessFactors, Oracle move between pages
  with a full navigation) are picked up on the new page.
- **An Apply link that opens a new tab** is followed into that tab.

A run you did not press for never writes over a value already on the form —
after the first pass, whatever is there is either ours or your correction, and
the panel lists anything it left as you had it. It also never *starts* an
application you did not: if you navigate the armed tab to a different posting,
that posting is read (its title goes to the dashboard) and the panel says
"click Jarvis to apply to it". Your press means "apply to this".

**Stopping.** The panel has a *Stop following* link, and the toolbar icon's
right-click menu has *Stop following this tab*. It also stands down by itself
when the page says the application was sent, when the tab closes, and after
45 minutes with nothing to do. Pressing the button on an armed tab fills
again; it does not stop.

**It never presses Submit.** That is yours, every time.

The badge is the tab's running total of fields filled (green), `on` while it
waits (blue), `you` when it is your turn to sign in (amber), `✓` once the
application is sent, `!` when something is worth reading — the panel has the
detail, including every question it could not answer.

You can also open the dashboard, hit **⚡ Apply now** on a posting, and press
the button on the tab it opens. Same thing; the resume was already building.

## What lives where

| Where | What it does |
|---|---|
| `ats.js` | What is known about each ATS: hosts, requisition ids, sign-in providers, "application sent" wording. Loaded by the worker and the page |
| `discover.js` | Reads the page: fields, labels, options, radio groups, the posting itself, walls, Apply and Next |
| `content.js` | Executes the plan: types, ticks, attaches. Watches the page for the next step. Decides nothing |
| `background.js` | Talks to `localhost:4300`. Remembers which tabs are armed. Injects the others on press and on every page an armed tab lands on |
| the repo | Every actual decision — which resume, what wording, what answer |

The extension holds no profile, no answers, and no resume. If it ever needed to
know something about Alex, the split would be wrong: those rules took twelve
rounds against live forms to get right, they are tested in `jarvis/`, and a
second copy in a content script would drift within a week.

It holds host permission for every site because following a tab across a
sign-in round trip needs it — but it reads **only** tabs you pressed the button
on. That boundary is held by `loaded.test.mjs` in a real Chrome: an armed tab
and a bystander tab load the same form; only one is filled.

## When something does not work

**"nothing filled — the Jarvis dashboard is not running"** — start it with
`npm run jarvis:serve`. The extension retries the connection on the next press.
(Before 1.34.20 this read "this page is not a multi-step application", which
blamed the form.)

**"Ashby's hosted page says Page not found"** — some companies run their Ashby
board on their own site (Form Energy does), and every `jobs.ashbyhq.com` URL for
them is dead while the job is live. The dashboard checks the board API before
retiring anything; the record says where to look.

**A cookie banner** is declined on its own — the most private choice, never
Accept — before Apply is pressed.

**Badge shows `0`** — no form controls in that frame. Some ATSes put the form in
an iframe that loads late; it is followed when it does.

**Badge shows `!`** — the panel or the page console has the reason.

**"this page does not look like an application"** — a run you did not press for
found a form it could not vouch for (three fields on an unfamiliar site). If it
is the application, press the button.

**"no resume slot on this screen"** — not a failure. A Workday application puts
its upload on screen two, so the earlier screens have nowhere to put one. "No
resume attached" is the message that means something went wrong.

**"the only way on is Next, which submits the form"** — iCIMS and Avature move
between pages with a control that submits. That press is yours; the next page
fills by itself.

**A field was left blank** — that is deliberate. Anything the profile cannot
answer is reported rather than guessed at. Add the answer to
`data/jarvis/apply-profile.yml` and it will be filled next time.

**It stopped following** — the panel says why. Forty runs on one tab, or 25
follow-along runs on one page, means the page would not stop changing; press
the button to start again.

## Workday's dropdowns, which are not what they look like

Measured by hand on Applied Materials' form (2026-09-07) after a REQUIRED
"How Did You Hear About Us?" blocked a whole application. Five things about
this widget, none of them visible from the markup:

- Each option is rendered **three times** — a `menuItem` (role=option), a
  `promptLeafNode`, and a `promptOption`. Clicking the `menuItem`, which comes
  first in the DOM, does **nothing**. Only the leaf node responds, so
  `bestSameRow` picks it wherever several nodes carry the same words.
- The lists are **react-virtualized**: `aria-setsize` says five while the DOM
  holds two. `revealTexts` scrolls until every row has been seen, and
  `clickRowByText` scrolls the chosen row back into the DOM before clicking it,
  because the node you scrolled past has been thrown away.
- **Typing does not always filter.** On this widget every search term returned
  the same rows. The skills box is the opposite — remote, and empty until typed
  — so the driver looks briefly for an already-open list and falls through to
  typing when there is none.
- Some prompts are **menus of menus**: the first level is categories, clicking
  one commits nothing and opens a second level where the answer is. The driver
  chooses again at each level, up to three deep.
- The committed value is a **chip list** (`selectedItemList`), not the input's
  value — the input keeps the search term. A pick counts only when the field
  says something it did not say before.

## Experience and Education on forms that are not Workday

Any section with an Add control named for it ("Add experience entry",
"Add education") is reported to the server, which answers with his entries
from the apply profile. The sub-form that Add opens is filled by its labels
(Title, Company, Office location, Description, From, To, "I currently work
here"; School, Degree, Field of study), its dates are set through the
calendar when typing is ignored (SmartRecruiters' month picker: the year
arrows, then the month cell), and the sub-form's own Save is pressed — that
is never the application's Submit. Education dates take the same calendar
path when the profile states the month ("Aug 2023", "May 2027"); a year-only
education date on a month picker is left for him and named, rather than
given a month he never stated. SmartRecruiters' Title and Company are
autocompletes that accept a custom value: it is committed to the component
(its `value` attribute plus its change event), not just typed. A Save the
form refuses for named characters ("cannot contain following characters:
;") is pressed again with those characters taken out of the text; any other
refusal cancels the panel and names the entry as his. An entry already
saved on the page — its title and company standing together as a card — is
never added a second time, so a second press or a page the run revisits adds
nothing twice. The waits here stay short in a background tab: a chained
timer would fall to once a minute after five minutes hidden, so each pause
hands over through a message port instead.

## The side panel

The toolbar click also opens Chrome's side panel beside the tab (also from
the icon's menu, "Open the Jarvis panel"). Under the Fill button a strip names
the three things it holds — **Resume · Cover letter · Change it** — and shows
one at a time: the cover letter sat below a 520px PDF viewer and read as
missing entirely (F-368). It shows, for the page he is on:

- the posting the page is (matched the way the resume is: the armed tab's
  application first, else the page's URL and heading) with its logo,
  location and pay;
- the deck's fit score and band, the skills the posting asks for that he has
  and the ones it also wants, and the reasons;
- **Fill this page** — the toolbar press for that tab — with the walk's
  state underneath as it runs: filled, ticked, resume attached, what is left
  for him, why it stopped. Nothing on the panel submits;
- the resume written for THIS posting, as the PDF the form gets, with what
  was tailored in it (the family, the titles on the page, each reworded
  bullet, anything refused) and buttons to download it (under the name every
  application of his carries, "Alex Rivera Resume.pdf" — a blob URL has none, so
  saving used to produce a random id), open it in a tab, or build it again.
  While a build runs the card names the stage it is at — reading the posting,
  choosing what goes on the page, checking every claim against the CV, laying
  out the page (with the worst thing that pass found on the sheet), checking
  the finished sheet — against a bar, because one unchanging "still writing"
  over a two-minute build reads as a hang (F-373);
- **Change the resume** — a note in his words ("lead with the fixture work,
  shorter Acme Steel, drop SAE") writes the resume for this posting again with
  the note in the tailor's prompt. The note steers which bullets lead, what
  is emphasised, wording and length, inside the same rules as every build:
  the guard that refuses a fact not in his approved wording is unchanged, so
  a note can never add a tool, a number or a claim; what the model could not
  honour is said back under "What was tailored". The panel shows which note
  the current PDF was written with;
- **Cover letter** — written for this posting from cv.md, the profile's
  narrative and modes/_profile.md, in the voice voice-dna.md describes, against
  the posting (and the lines the tailored resume leads with), with an optional
  note. Every figure and named thing in it is checked against cv.md and the
  posting, and voice-dna's banned words and reframes fail it; a draft that
  fails is asked for once more with the problems named, and whatever remains
  is shown in red as "Check before you use it". Copy puts it on the clipboard;
  "Put it in the form" types it into the page's cover-letter box when there
  is one (a file slot is named as his to attach). Nothing sends it. Letters
  are kept in `data/jarvis/cover-letters/<job id>.md`.

The panel decides nothing: it asks the worker (`panel`, `panel-state`,
`panel-resume`, `press` messages), which asks the dashboard's `/api/panel`
and `/api/apply-resume`. A harness can point it at one tab with
`panel.html?tab=<id>`. Tests: `panel.test.mjs` (the page, worker stubbed),
`background.test.mjs` (the worker's answers), `jarvis/panel-api.test.mjs`
(the endpoint against a temp store).

## Press it from the dashboard's page

The dashboard is the one page the extension accepts messages from. Besides
`open` (open the posting in a new tab, armed — and, since 1.34.22, reuse the
tab already showing it instead of opening a second), it answers `press`:

    await extensionAsk({ type: 'press', url: '<the page's URL>' })

which presses Jarvis on the tab already showing that URL, exactly as the
toolbar button would, and replies at once with the tab id. This is how the
extension is exercised in his own Chrome when the harness cannot be used —
SmartRecruiters serves an automation Chromium a DataDome wall (F-329).

## Drive it against a real posting, without his Chrome

```
npm run jarvis:drive -- <posting url> [--minutes 6] [--twice]
```

Loads this folder into a throwaway Chromium, opens the posting, presses the
button through the worker, and prints what the tab accumulated, the panel's
text and the page's `[jarvis]` lines. `--twice` presses again and lists every
field the second pass changed. It talks to the running dashboard, so it
records the job and builds the resume like a real press — nothing it does can
press Submit. This is how F-317 to F-325 were found in one evening.

## Tests

`discover.test.mjs` runs `discover.js` in a real browser against fixtures
reduced from forms that actually broke. `fill.test.mjs` runs the shipped
`content.js` against the real planner: the follow-along rules, the watcher, the
sign-in wait, the posting read. `background.test.mjs` drives the worker with a
stubbed Chrome: arming, following, the tab-carried id, inheritance into a new
tab, the runaway guards. `loaded.test.mjs` loads the extension into a real
Chrome and proves the boundary with real tabs. `../apply-page.test.mjs` runs
the dashboard against an empty store and proves a posting read off a page
becomes a job with a real resume. All of it runs under `npm run jarvis:test`.
