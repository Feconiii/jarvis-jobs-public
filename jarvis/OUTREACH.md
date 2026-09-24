# Outreach — research findings and design constraints

Research for the planned networking/cold-outreach feature (referrals, recruiter
and hiring-manager contact, LinkedIn networking after applying). Written
2026-07-28, before any code, because outreach done badly is worse than none:
a bad message burns that contact permanently, and in a small industry it burns
the company.

**Read this before building or changing anything in the outreach path.**

---

## 1. The premise is sound — referrals really are the highest-leverage channel

This is the best-evidenced claim in the whole area:

- **Burks, Cowgill, Hoffman & Housman, "The Value of Hiring through Employee
  Referrals", *Quarterly Journal of Economics* 130(2), 2015** — personnel data
  from nine large firms across three industries. Referred applicants are more
  likely to be hired *and* more likely to accept offers despite having similar
  measured skill to non-referrals, and are 10–30% less likely to quit. This is
  peer-reviewed and the causal story is credible: firms rationally prefer
  referrals, so the channel genuinely converts better.
- Industry figures commonly cited: referrals are ~7% of applicants but ~40% of
  hires; ~28.5% hire rate for referred candidates vs ~2.7% for non-referred.
  **Treat these as directional only** — they come from recruiting-vendor
  content marketing, not audited research. The direction agrees with the QJE
  paper; the precise multiples do not deserve confidence.

**Conclusion:** effort spent converting an application into a referral is worth
far more than effort spent submitting more applications. This feature is aimed
at the right thing.

## 2. Two hard constraints that dictate the architecture

### 2a. LinkedIn automation is off the table

- LinkedIn's User Agreement **forbids** using software, scripts, bots, browser
  plugins or extensions to automate activity on the service. Accounts doing so
  get feature-restricted or suspended.
- Free accounts are capped at roughly **5 personalized connection notes per
  month** (LinkedIn tightened this in 2024) and ~100 connection requests/week.

So the volume this feature could add on LinkedIn is ~5 personalized touches a
month regardless of what we build, and building an auto-sender risks the account
Alex's entire professional presence and recruiter inbound depends on. For a job
seeker, losing the LinkedIn account is a catastrophic, non-recoverable failure.

**Design rule: Jarvis drafts LinkedIn messages. Alex sends them by hand.**
No automation, no scraping, no browser driving on linkedin.com. This is the same
rule as Product Law 4 (Jarvis never submits or sends) and it is not negotiable
for a marginal convenience gain.

### 2b. Volume destroys the channel it is trying to use

Every credible finding points the same way: reply rate is a function of
*evident personal effort*, and mass-sending inverts the thing that makes
referrals work. Reported figures (vendor-sourced, directional):

| Signal | Reported effect |
|---|---|
| Personalized body vs generic | ~17–18% reply vs ~7% |
| Email length 75–150 words | Highest reply band (Boomerang / Lavender data) |
| At least one follow-up | +65.8% responses (Backlinko, 12M emails) |
| Cold email to hiring manager vs online application | ~15–25% vs ~2–5% reply |

The semiconductor/robotics ME world is small — Applied Materials, KLA, Lam and
ASML people move between those companies and talk. A detectable mass-mail
pattern doesn't just fail, it damages his name at exactly his target tier.

**Design rule: this is a precision tool, not a cannon.** Cap it, scope it to
roles he has actually queued or applied to, and make each message require his
review.

## 3. What the evidence says actually works

1. **Don't ask a stranger for a referral in the first message.** The strongest
   and most consistent finding in the networking literature: professionals
   detect a "backdoor application" within about two minutes, and the goodwill
   that got the reply disappears. Ask for *information* — how the team works,
   what the group actually builds, what they look for. The referral is offered
   later, or asked for after a real exchange.
2. **Earn the context.** A note that references something concrete and true (the
   specific team, a product line, a shared school) reads as earned. A generic
   one triggers "ignore" — and on LinkedIn, a note only helps *after* the
   accept: acceptance rates are effectively identical with and without a note
   (26.42% vs 26.37% across 20M+ requests), but a personalized note roughly
   **doubles the post-accept reply rate** (9.36% vs 5.44%). So the note's job is
   to earn a *conversation*, not the connection.
3. **Short.** 75–150 words for email; LinkedIn caps notes at 200 characters
   anyway. Say who you are, the specific thing you're asking about, and an easy
   out.
4. **One follow-up, then stop.** 5–7 business days later, adding something new.
   A second follow-up is where "persistent" turns into "pushy".
5. **Timing.** Tue–Thu mornings in the recipient's timezone. Reaching out early
   in a posting's life matters — most interviews come from applications made in
   the first week a req is open.
6. **Target choice matters more than message quality.** In rough order of value
   for a new grad: alumni at the company > an engineer on the actual team >
   the hiring manager > a generic recruiter. Recruiters are the most-spammed
   and least able to vouch for you.

## 4. Alex-specific: the F-1/OPT angle (important, and counter-intuitive)

**OPT does not require employer sponsorship.** Work authorization on OPT is
granted by USCIS, not the employer — there is no petition, no fee, and no legal
obligation on the company. Alex has 12 months OPT plus the 24-month STEM
extension: **36 months of work authorization requiring nothing from an
employer.**

Implication for outreach: **do not lead with visa status, and never phrase it as
"I need sponsorship."** In an early networking message it is both irrelevant and
self-sabotaging — it invites a filter that doesn't apply yet. When the topic
comes up (screening, application forms, or a direct question), the accurate and
much stronger framing is the positive one: *authorized to work for 36 months
without sponsorship; would need H-1B support after that.*

This is not spin — it is the correct description of his status, and it is
already how `data/jarvis/apply-profile.yml` answers the question. Outreach
drafts must stay consistent with that file.

Company targeting should still prefer known H-1B sponsors (already flagged in
the store via `sponsors_h1b`), because the long-run question is real.

## 5. Legal / deliverability

1:1 personal job-seeking email is not the commercial advertising CAN-SPAM was
written for, but the safe posture costs nothing and is simply good manners:
- Send from his real named address; never obscure identity.
- Never mass-send from a personal domain; it torches deliverability and reads as
  bulk.
- Honor any "don't contact me" instantly and permanently.
- No scraped-list buying, no guessed-email spraying at scale. A wrong-guess
  bounce rate is itself a spam signal.

## 6. Design constraints for the feature (derived from the above)

Non-negotiable:
1. **Never sends anything.** Drafts only; Alex sends from his own client / his
   own LinkedIn. Same law as the apply engine.
2. **No LinkedIn automation or scraping.** Draft text he copies.
3. **Never fabricates rapport.** A drafted message may reference only facts
   drawn from the enriched job description, the company record in the store, or
   `cv.md` / `modes/_profile.md`. It must never invent a shared history, a
   conference talk he didn't attend, or an article he didn't read. This is the
   single biggest embarrassment risk in an AI-drafted message.
4. **Scoped, not broad.** Only for jobs he has queued or applied to. One person
   per company per role by default.
5. **Suppression + dedup.** Track who was contacted and when; never contact the
   same person twice without a reply; one follow-up maximum.
6. **First message asks for information, not a referral** (see §3.1) unless the
   contact is a genuine warm tie (alumnus, prior colleague).
7. **Visa framing follows §4.**

Worth building because it feeds the learning loop: outreach status per contact
gives response-rate-by-company/persona data, which is roadmap item 10.

## Sources

- Burks, Cowgill, Hoffman & Housman, *The Value of Hiring through Employee
  Referrals*, QJE 130(2), 2015 — https://academic.oup.com/qje/article-abstract/130/2/805/2331590
- Employee referral statistics (vendor-sourced, directional) — https://www.zippia.com/advice/employee-referral-statistics/
- LinkedIn connection-request limits and note caps — https://phantombuster.com/blog/social-selling/linkedin-connection-request-limit/
- LinkedIn note effect on acceptance vs post-accept reply — https://www.reactin.io/blog/linkedin-connection-request-with-or-without-note
- Informational-interview framing / the "backdoor application" failure —
  https://www.macslist.org/networking/10-killer-mistakes-avoid-informational-interview
- Cold-email length, timing, follow-up effects — https://jobply.ai/guides/cold-email-hiring-managers
- OPT does not require employer sponsorship — https://www.boundless.com/blog/how-to-hire-international-students-opt

**Source-quality note:** apart from the QJE paper and the OPT rule, most numeric
claims above come from recruiting/sales-tool content marketing, which has an
obvious interest in high reported response rates. They agree with each other on
*direction* and that is all they are used for here. Nothing in the design
depends on a specific percentage being accurate.
