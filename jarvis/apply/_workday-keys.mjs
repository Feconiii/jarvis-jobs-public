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
    case 'formField-candidateIsPreviousWorker': return A.previously_employed_here || 'No';
    // "How Did You Hear About Us?" is required, and every tenant words its list
    // differently (KLA has no "Job Board" at all). Offer truthful alternatives in
    // order of preference — Jarvis finds these postings by reading the company's
    // own careers site, so Corporate Website is accurate wherever it exists.
    //
    // 2026-09-24: on KLA and ABB "LinkedIn" missed, and HE chose the company's
    // own site both times ("Company Career Site", "ABB Careers Website"). The
    // career-site spellings follow LinkedIn, and a closed prompt now tries
    // every alternative in turn (F-551), so a tenant without LinkedIn lands on
    // its career site. LinkedIn stays first: on Applied Materials the career
    // site is a CATEGORY that commits nothing, and LinkedIn is the leaf (F-390).
    case 'formField-source': return [A.how_heard, 'Career Site', 'Careers Website', 'Corporate Website', 'Company Website', 'Job Board', 'Job Boards', 'Other'].filter(Boolean);
    default: return undefined; // unknown → handled by label matcher / flagged
  }
}

export { wdValue };
