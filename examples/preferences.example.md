# Your job preferences

Copy to `jarvis/preferences.md`. This file is **yours**: write in plain English,
one rule per line, and the fit scorer reads it every time it runs. No code
change and no re-scan — edit, then run `npm run jarvis:rescore`.

## How to write a rule

Start a line with one of these words. Everything after it is matched against
the job's title, description, team and location.

| Word | Effect |
|------|--------|
| `never` / `no` | Hard rule — the job is flagged and pushed to the bottom |
| `avoid` | Strong penalty |
| `prefer` | Bonus |
| `want` / `love` | Strong bonus |

Two optional qualifiers make a rule sharper:

- `in title` — only match the job title (`avoid "senior" in title`)
- `in location` — only match the location (`prefer in location Austin, Seattle`)

Quote a phrase to match it exactly. Separate alternatives with commas — any one
of them matches. Lines starting with `#` are comments and are ignored.

Rules flag and rank; they never delete. A hidden posting is always one filter
away, because a false exclusion is the expensive mistake: it costs you a job
you never find out about.

---

## Rules

# What the job has to be
want mechanical engineer, manufacturing engineer, process engineer in title
prefer new grad, entry level, early career in title

# What it must not be
never night shift, graveyard, 3rd shift
never "security clearance"
avoid senior, staff, principal, manager in title
avoid travel 75%, extensive travel

# Where
prefer in location Austin, Seattle, San Jose
