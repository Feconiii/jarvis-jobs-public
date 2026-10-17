# The resume bullet pool

Every resume Jarvis renders is built from one JSON file: the **pool**. It
holds every sentence, title, course and skill a resume is allowed to print.
A resume is made by choosing from the pool, ordering it and (per posting)
rewording within checked limits. Nothing outside the pool reaches a page.

- Default location: `jarvis/resume-pool.json`.
- A different file: set `JARVIS_RESUME_POOL=<path>` (for example a pool kept
  in `config/`, outside the tracked one).
- The source the pool is checked against: `cv.md` in the project root, and
  optionally `cv-short.md` for short wordings. Both are written by the person,
  never generated.

## How it is checked against cv.md (the drift check)

`verifyPoolAgainstCv` in `jarvis/resume-variants.mjs` runs before every build
(`npm run jarvis:resumes`, every tailored resume, the test suite). It refuses
to render if any of these is not found in `cv.md`:

- every bullet `text` and `long`, every org's `org`, `date`, `group`,
  `title` / `titles` / `approvedTitles` / `atOwnCompany` values;
- every project as `"<lead> <text>"`;
- every skills `lead` and every skills item;
- every course, and the GPA / honors lines as `"<lead> <text>"`.

Every `short` bullet and project `short` / `shortLead` must be found in
`cv-short.md` instead.

The comparison ignores case, spaces and punctuation (it keeps only `a-z0-9`),
so dashes, colons and bullet markers do not matter. Words and numbers do: a
tool, a figure or a job title that `cv.md` does not contain fails the build.
Do not weaken or bypass this check; fix the pool or `cv.md`.

## Format

```json
{
  "_comment": "Every line here is copied verbatim from cv.md.",
  "name": "Test Analyst",
  "contact": {
    "location": "from config/profile.yml",
    "phone": "from config/profile.yml",
    "email": "from config/profile.yml",
    "linkedin": "from config/profile.yml"
  },
  "education": {
    "school": "Example State University",
    "location": "Seattle, WA",
    "degree": "Bachelor of Business Administration, Finance",
    "date": "May 2026",
    "gpa": { "lead": "GPA", "text": "3.70" },
    "honors": { "lead": "Honors", "text": "Dean's List" },
    "coursework": ["Corporate Finance", "Financial Modeling", "Business Statistics"]
  },
  "orgs": {
    "bank": {
      "org": "Example Bank",
      "location": "Seattle, WA",
      "date": "June 2025 – August 2025",
      "title": "Financial Analyst Intern",
      "primary": true,
      "bullets": {
        "forecast": { "text": "Built a monthly cash forecast model in Excel covering 12 branches." },
        "variance": { "text": "Wrote variance commentary for the regional budget review.", "short": "Wrote budget variance commentary." }
      }
    }
  },
  "projects": {
    "dcf": { "lead": "DCF Valuation", "text": "Valued a public retailer with a three-statement model and a DCF." }
  },
  "skills": {
    "tools": { "lead": "Tools", "items": ["Excel", "SQL", "Tableau"] },
    "methods": { "lead": "Methods", "items": ["Financial Modeling", "Variance Analysis"] }
  }
}
```

Field notes:

| Key | Required | Meaning |
|-----|----------|---------|
| `name` | yes | Printed on the resume and used in every file name (`<name> Resume.pdf`). Match `candidate.full_name` in `config/profile.yml`. |
| `contact` | yes | Keep the literal `from config/profile.yml` in each field. The real values are overlaid at build time from the gitignored profile (`candidate.location/phone/email/linkedin`, `portfolio_url`). A build whose contact still reads the placeholder refuses to render. Never put a real phone number in a tracked file. |
| `education` | yes | `gpa`, `honors` and `coursework` are optional. |
| `orgs` | yes | One entry per role, **strongest first**: the order is the order on the page, and the last-listed org is trimmed first when the page is full. The key (`bank`) is how plans and the per-posting writer refer to it. |
| `orgs.*.title` | one of these | The title printed for the role. |
| `orgs.*.titles` | one of these | `{ "<family>": "<title>" }`, one title per resume family (the hardware preset's lanes). |
| `orgs.*.approvedTitles` | no | Other titles the per-posting writer may choose from. Each must be in `cv.md`. |
| `orgs.*.primary` | no | `true` lets the per-posting writer keep more than two lines for this role. Without any `primary`, the first two orgs count as primary. |
| `orgs.*.bullets` | yes | `{ "<key>": { "text", "short"?, "long"? } }`. `text` is the default wording; `short` is what the fit loop uses when the page is a line long. |
| `projects` | no | `{ "<key>": { "lead", "text", "short"?, "shortLead"? } }`. |
| `skills` | yes | `{ "<key>": { "lead", "items": [...] } }`. One line per category on the page. |
| `plans` | no | `{ "total-experience": { "coursework", "experience": [{ "org", "bullets": [...] }], "projects", "skills", "reserve" } }` to fix the base's selection and order. Without it the base is the whole pool in pool order. |

## Families: which base a posting starts from

- **hardware-engineering preset** (the original user): four bases,
  `total-experience`, `automation`, `manufacturing`, `mechanical`, chosen per
  posting by title (`jarvis/resume-family.mjs`), each with a hand-written
  plan in `jarvis/resume-variants.mjs` (`PLANS`).
- **Any other preset**: one base, `total-experience`. It is built from the
  pool's `plans["total-experience"]` if present, otherwise from every org,
  bullet, project, skills category and course in pool order. Every posting
  starts from it, and the per-posting writer (`jarvis/resume-for-job.mjs`)
  reorders, selects and rewords for that job. The fit loop trims the
  last-listed orgs first when the page is full.

Files: the base is `output/jarvis-resumes/total-experience/<name> Resume.pdf`;
a resume built for a posting is `<name> - <Company> - <Role>.pdf`.

## Creating a pool from your own cv.md (for an assistant during setup)

1. Read `cv.md` in full. Every value you write must be a sentence, title,
   course or skill that appears in it word for word. If `cv.md` says it in a
   paragraph, copy the sentence; do not paraphrase. If a bullet you want is not
   in `cv.md`, add it to `cv.md` first with the person's agreement, never to
   the pool alone.
2. Write `name`, the placeholder `contact` block and `education` (school,
   location, degree, date exactly as `cv.md` prints them).
3. For each role, newest or strongest first: an `orgs` entry with a short key,
   `org`, `location`, `date`, one `title`, and its bullets keyed by a short
   name. Copy the bullet text verbatim.
4. Projects and skills the same way. Skill categories become the skills
   lines; keep each item exactly as `cv.md` spells it.
5. Optional: `cv-short.md` with shorter wordings, and matching `short` fields.
6. Check it: `node jarvis/build-resumes.mjs --check` prints every line that
   does not trace to `cv.md`. Fix each one, then `npm run jarvis:resumes` to
   render and run the layout check.
