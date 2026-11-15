/**
 * Workday field-id -> apply-profile resolver.
 *
 * Lifted out of jarvis/apply/workday.mjs so the BROWSER EXTENSION answers a
 * Workday form the same way the Playwright driver does. Measured on a live
 * GlobalFoundries application: Workday puts no usable label, name or id on the
 * input itself - the question lives on a wrapping
 * [data-automation-id="formField-*"] wrapper - so a label matcher alone leaves
 * most of My Information blank while these keys answer it exactly.
 *
 * The comment that has always sat on this table still holds: Workday automation
 * ids are 100% stable and far more reliable than its visible labels. There is
 * one copy of this table, and this is the file.
 */
// Standard Workday field-id → apply-profile resolver. Each returns the string
// to type/select, or null to leave for the user. Kept explicit (not the
// generic label matcher) because Workday's automation-ids are 100% stable and
// far more reliable than its visible labels.
import { employedAtApplyingTo } from './_history.mjs';

function wdValue(fieldId, p) {
  const A = p.answers || {}, I = p.identity || {}, E = p.education || {};
  switch (fieldId) {
    case 'formField-legalName--firstName': return I.first_name;
    case 'formField-legalName--lastName': return I.last_name;
    // Preferred name — the box is ticked separately (see tickPreferredName).
    case 'formField-preferredName--firstName': return I.preferred_first_name || I.first_name;
    case 'formField-preferredName--lastName': return I.preferred_last_name || I.last_name;
    // Skills: high-value for ATS keyword matching and almost always left blank.
    case 'formField-skills': return A.skills;
    case 'formField-country': return I.country || 'United States of America';
    case 'formField-addressLine1': return I.address_line1;
    case 'formField-city': return I.city;
    case 'formField-countryRegion': return I.state;         // prompt
    case 'formField-postalCode': return I.postal_code;
    case 'formField-phoneType': return 'Mobile';            // prompt
    case 'formField-countryPhoneCode': return 'United States of America (+1)';
    case 'formField-phoneNumber': return (I.phone || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '');
    case 'formField-extension': return null;                // leave blank — not a phone extension
    // HIS WORK HISTORY FIRST (F-1036). The standing No went out on Applied
    // Materials' own form on 2026-10-20 and 2026-11-07, where he interned, and
    // he changed it to Yes by hand both times. The follow-up email and worker ID
    // stay his to type.
    case 'formField-candidateIsPreviousWorker': return employedAtApplyingTo(p) || A.previously_employed_here || 'No';
    // "How Did You Hear About Us?" is required, and every tenant words its list
    // differently (KLA has no "Job Board" at all). Offer truthful alternatives in
    // order of preference — Jarvis finds these postings by reading the company's
    // own careers site, so Corporate Website is accurate wherever it exists.
    //
    // 2026-09-24: on KLA and ABB "LinkedIn" missed, and HE chose the company's
    // own site both times ("Company Career Site", "ABB Careers Website"). The
    // career-site spellings follow LinkedIn, and a closed prompt now tries
    // every alternative in turn (F-551), so a tenant without LinkedIn lands on
    // its career site.
    //
    // THE CAREER SITE NOW COMES FIRST. Wolfspeed, 2026-09-24, after that fix:
    // "LinkedIn" landed and he changed it to "Corporate Website" by hand — his
    // third Workday tenant in one night choosing the company's own site. On
    // Applied Materials the career site is a CATEGORY (F-390); the menu walk
    // opens it and chooses again at the level beneath, and LinkedIn is still
    // next in line if nothing there commits.
    //
    // LINKEDIN FIRST AGAIN — HIS RULE, 2026-09-24: "always just answer
    // LinkedIn, thing is I never see it filled, it always fails — or company
    // site or social media, Instagram, Facebook… whatever pops up first and
    // works." He chose the career site on KLA/ABB/Wolfspeed because LinkedIn
    // never landed, not because it was wrong. LinkedIn usually sits one level
    // down, inside a Social Media / Job Board / Career Websites category, so
    // those categories come next: the menu walk opens one and chooses LinkedIn
    // at the level beneath. Then the company's site, then any social network.
    case 'formField-source': return [...HOW_HEARD_LADDER].filter(Boolean);
    default: return undefined; // unknown → handled by label matcher / flagged
  }
}

/** "How did you hear about us?", in his order of preference (2026-09-24). */
export const HOW_HEARD_LADDER = [
  'LinkedIn',
  'Social Media', 'Job Board or Social Media', 'Social Networking', 'Career Websites', 'Online Job Board', 'Job Board', 'Job Boards',
  'Company Career Site', 'Career Site', 'Careers Website', 'Corporate Website', 'Company Website', 'Company Careers Page',
  'Instagram', 'Facebook', 'Twitter', 'X (Twitter)',
  'Other',
];

export { wdValue };
