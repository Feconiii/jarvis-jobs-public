/**
 * Is a title read off a page a job title at all?
 *
 * The title decides the resume family and is typed onto the form as his
 * work-history title, so a wrong one is not cosmetic. Two kinds of text are
 * never a job: a form step's or a careers page's own heading ("My
 * Information", "Careers at Acme"), and a site's furniture.
 *
 * THE FURNITURE (F-1012, 2026-11-05). Tesla's first <h1> holds its logo link,
 * "Careers" and the skip link, so the panel recorded "Tesla homepageCareersSkip
 * to main content", scored it 76, and blocked it as "not one of the roles you
 * asked for", on a posting he had applied to on 09-19. Navigation words never
 * name a job.
 */
export const NOT_A_TITLE_RE = /^(?:my information|my experience|application questions|voluntary disclosures|self[- ]identify|review|sign in|log in|create account|candidate (?:profile|home)|apply(?: now)?|careers?|jobs?|search(?: jobs)?|job search|open (?:roles|positions|jobs)|current openings|welcome|home|thank you.*|error|page not found|(?:careers?|jobs?|open (?:roles|positions)|join us|work) (?:at|with) .{1,40})$/i;

// "skip" has no \b before it: Tesla's header text runs together ("…CareersSkip to main content").
// "Main menu" / "Site navigation" / "Toggle menu" only as the WHOLE heading: "Main Navigation
// Systems Engineer" is a job (review, 2026-11-05).
export const SITE_CHROME_RE = /skip (?:to|navigation)\b|^(?:main|site|primary) (?:menu|navigation)$|^toggle (?:navigation|menu)$|\b(?:accept|reject) (?:all )?cookies\b|\bcookie (?:settings|preferences)\b/i;

/**
 * Tesla's req number from any of its posting links: the form
 * /careers/search/job/apply/<n>, and the LinkedIn link /careers/search/job/<n>
 * ?source=LinkedIn, which has no slug (F-1012). The slug link
 * /job/<title-slug>-<n> is what the store holds and is matched by URL. '' otherwise.
 */
export function teslaBareReq(url) {
  const m = String(url || '').match(/tesla\.com\/(?:[a-z]{2}_[a-z]{2}\/)?careers\/search\/job\/(?:apply\/)?(\d{4,})\/?(?:[?#]|$)/i);
  return m ? m[1] : '';
}

/** True when the text cannot be recorded, scored or judged as a job title. */
export function unreadableTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  return !t || NOT_A_TITLE_RE.test(t) || SITE_CHROME_RE.test(t);
}
