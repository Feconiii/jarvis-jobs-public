// jarvis/resume-family.mjs — which of the four resumes a posting should get.
//
// THE PROBLEM THIS SOLVES (Alex, 2026-08-01):
// A distinct resume per posting is a tell. Apply to ten roles at one company and
// send ten differently-worded resumes and the recruiter — who sees them side by
// side in one ATS — reasonably concludes a machine wrote each one. That is worse
// than sending the same solid resume ten times.
//
// So resumes are grouped into a SMALL, FIXED set of families, one per genuine
// specialisation. Every posting maps to exactly one family and reuses that
// family's file. Ten postings at KLA across two specialisations produce two
// resumes, not ten — which is exactly what a real candidate with two interests
// would have. Adding a family is a deliberate act, not something a run does on
// its own.
//
// THE FOUR (Alex, 2026-08-02 — "that covers all bases for all the jobs i want"):
//   total-experience · automation · manufacturing · mechanical
// Every posting he applies to gets one of these — the tailoring IS the family,
// so "always send a tailored resume" and "never one resume per posting" are the
// same rule here. total-experience is the fallback, not a lesser option: it is
// the broad all-rounder for postings that do not sit clearly in one lane.
//
// (Superseded: the earlier five-family set — mechanical-design,
// manufacturing-process, automation-controls, test-quality, default. Test /
// quality / metrology titles now route to `manufacturing`, whose plan leads with
// inspection, validation and quality-traceability work.)
//
// Every family draws from the same cv.md facts via jarvis/resume-pool.json. A
// family reorders and reweights what it leads with, and uses the internship
// title from cv.md's approved list that matches the lane; it never invents, and
// never contradicts another family.

/**
 * Families in priority order — the first whose pattern matches wins, so put the
 * more specific ones first. `variant` is the output folder; the file inside is
 * always "Alex Rivera Resume.pdf".
 */
export const FAMILIES = [
  {
    key: 'automation',
    variant: 'automation',
    label: 'Automation, robotics & controls',
    // Automation sits first on purpose: "Manufacturing Automation Engineer" and
    // "Robotics Mechanical Engineer" are automation roles wearing another lane's
    // noun, and the automation resume is the stronger answer to both.
    re: /\b(automation|automated|robotic|robotics|controls|control system|plc|mechatronic|mechatronics|amhs|material handling|cobot|motion control|machine vision|vision system|integration engineer)\b/i,
  },
  {
    key: 'manufacturing',
    variant: 'manufacturing',
    label: 'Manufacturing, process & quality',
    // Test / quality / metrology / reliability live here — that work was the
    // inspection, validation and traceability side of his manufacturing roles.
    re: /\b(manufacturing|process engineer|production|industrial engineer|npi|new product introduction|fabrication|assembly|equipment engineer|sustaining|supplier|tooling|test|validation|verification|quality|reliability|metrology|inspection|failure analysis|calibration)\b/i,
  },
  {
    key: 'mechanical',
    variant: 'mechanical',
    label: 'Mechanical design',
    re: /\b(mechanical|design engineer|product design|cad|solidworks|creo|gd&t|tolerance|thermal|structural|packaging design|r&d engineer)\b/i,
  },
];

/** The all-rounder. Not a lesser resume — the one for postings without a lane. */
export const DEFAULT_FAMILY = {
  key: 'total-experience',
  variant: 'total-experience',
  label: 'Total experience (all-round)',
  re: null,
};

/** All four, fallback last — the order the builder renders and reports them in. */
export const ALL_FAMILIES = [DEFAULT_FAMILY, ...FAMILIES];

/** Look one up by key, for CLI flags and plan validation. */
export function familyByKey(key) {
  return ALL_FAMILIES.find(f => f.key === String(key || '').toLowerCase()) || null;
}

/**
 * Pick the family for a posting. Title carries far more signal than the body —
 * a description mentions every adjacent skill, so matching on it would send most
 * postings to whichever family sits first.
 */
export function familyFor(job) {
  const title = String(job?.title || '');
  for (const f of FAMILIES) if (f.re.test(title)) return f;
  // Only if the title is uninformative, allow the description to decide.
  const body = String(job?.description || '').slice(0, 1500);
  if (body) {
    for (const f of FAMILIES) if (f.re.test(body)) return f;
  }
  return DEFAULT_FAMILY;
}

/** Where that family's resume lives. One file per family, generic filename. */
export function resumePathFor(job, personName = 'Alex Rivera') {
  const fam = familyFor(job);
  return {
    family: fam,
    path: `output/jarvis-resumes/${fam.variant}/${personName} Resume.pdf`,
  };
}

/** Group jobs by family — used to report how many distinct resumes a batch needs. */
export function groupByFamily(jobs) {
  const out = new Map();
  for (const j of jobs || []) {
    const f = familyFor(j);
    if (!out.has(f.key)) out.set(f.key, { family: f, jobs: [] });
    out.get(f.key).jobs.push(j);
  }
  return [...out.values()];
}
