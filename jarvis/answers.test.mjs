// jarvis/answers.test.mjs — golden tests for resolveLabel (jarvis/apply/_answers.mjs).
//
// This file exists because label→answer routing produced the most dangerous bugs
// in the apply engine: a regex matching a word OUT OF CONTEXT, feeding a
// completely unrelated answer into a question, and reporting it as filled.
// Every "must not" case below happened on a live application form:
//
//   \bopt\b   matched "you can choose to opt out" in the AI-screening notice, so
//             that question took the OPT-status answer ("No") and the form was
//             set to "No, I opt-out" — the opposite of the user's instruction.
//   /major/   matched "your major life activities" in the disability question and
//             resolved it to "Mechanical Engineering".
//   hispanic  matched the Race question, because Lever's <select> label contains
//             every option's text, and answered race "Decline to self-identify".
//
// A wrong answer that reports as correct is worse than a blank field. These cases
// are the guard.

import { resolveLabel as resolveLabelRaw } from './apply/_answers.mjs';

// HIS SPONSORSHIP ROW, NAMED FIRST (F-995, his answer 2026-11-04): every
// sponsorship "Yes" now leads with "Yes, but not until the future" so a list
// offering that row gets it word for word. The checks below were written for
// the plain answer; they read past that first row, and SPONSOR_ROW_SEEN
// counts that it was there each time (checked at the end).
const SPONSOR_ROW = 'Yes, but not until the future';
let SPONSOR_ROW_SEEN = 0;
const resolveLabel = (...a) => {
  const r = resolveLabelRaw(...a);
  // …and his Yes is "Yes, not now" (re-review): a Yes that never takes a now-only row. Read as the plain Yes.
  if (r?.kind === 'answer' && Array.isArray(r.value) && r.value[0] === SPONSOR_ROW && r.value[1] === 'Yes, not now') {
    SPONSOR_ROW_SEEN += 1;
    return { ...r, value: ['Yes', ...r.value.slice(2)] };
  }
  return r;
};

// Fixture, NOT the user's real profile — keeps the test deterministic and keeps
// personal data out of the repo.
const P = {
  identity: { first_name: 'Augusta Ada', last_name: 'Byron', full_name: 'Augusta Ada Byron', preferred_full_name: 'Ada Byron', phone_country_code: '+1', email: 'a@b.c', phone: '+1 555', location: 'Springfield, Washington', city: 'Springfield', country: 'United States of America', state: 'Washington', linkedin: 'https://linkedin.com/in/test', website: 'https://example-portfolio.test', portfolio: 'https://example-portfolio.test', salutation: 'Mr.' },
  education: { school: 'Test University', degree: 'Bachelor of Science', discipline: 'Mechanical Engineering', gpa: '3.9', graduation: 'May 2027', degree_level: "Bachelor's" },
  answers: {
    authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', us_person: 'No',
    protected_individual: 'None of the above', security_clearance: 'No',
    restricted_country_citizen: 'No',
    employer_agreement: 'No', employee_referral: 'No',
    currently_on_opt: 'No', stem_opt_extension_eligible: 'Yes',
    ai_screening_consent: 'Yes', data_processing_consent: 'Yes',
    talent_community_optin: 'Yes', worked_via_agency: 'No',
    meets_basic_requirements: 'Yes', years_relevant_experience: '2 years',
    previously_employed_here: 'No', how_heard: 'Job Board',
    background_check_consent: 'Yes', current_company: 'Test Co',
    earliest_start: 'June 2027', previously_applied_here: 'No', terminated_for_cause: 'No',
    board_membership: 'No', government_employee: 'No', restricted_country_citizen: 'No',
    can_verify_right_to_work: 'Yes', self_id_language: 'English',
    willing_to_relocate: 'Yes',
    citizenship_country: 'Ruritania',
    // campus-recruiting keys, as his own profile carries them
    currently_in_school: 'Yes', year_in_school: "I'm in my final year of school",
    highest_education: "Bachelor's degree", graduation_season: 'Spring (April - June)',
    opportunity_type: 'New College Graduate',
    // answered by him directly 2026-09-20 (F-530..F-535)
    current_title: 'Test Lead', reason_for_leaving: 'Internship ended',
    current_employer_reason: 'Currently employed',
    permanent_resident_elsewhere: 'No',
  },
  eeo: { gender: 'Male', hispanic: 'No', race: 'Asian', veteran: 'I am not a Veteran.', disability: 'No, I do not have a disability' },
};

let pass = 0, fail = 0;
const is = (label, expected, note = '') => {
  const r = resolveLabel(label, P);
  // A rule may offer alternatives for a menu; its FIRST is what a free-text box
  // gets, so that is what is compared here (2026-09-24: country, discipline,
  // graduation date gained menu spellings after their first).
  const got = r.kind === 'answer' ? (Array.isArray(r.value) && typeof expected === 'string' ? r.value[0] : r.value) : r.kind;
  if (got === expected) { pass++; return; }
  fail++;
  console.log(`✗ ${note || label.slice(0, 60)}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`);
};

// ── the out-of-context regression cases ─────────────────────────────
is('As part of the recruiting process, KLA Corporation may use artificial intelligence to match your candidate information to the requirements of the role. As a candidate, you can choose to opt out of the use of artificial intelligence.',
  'Yes', 'AI notice containing "opt out" must NOT take the OPT answer');
is('Are you currently in a period of Optional Practical Training (OPT)?', 'No', 'real OPT question');

// ── Greenhouse job board, Anthropic (harness 2026-09-05, F-348) ──
{
  const withOnsite = { ...P, answers: { ...P.answers, willing_onsite: 'Yes' } };
  const r = resolveLabel('Are you open to working in-person in one of our offices 25% of the time?', withOnsite);
  if (r.kind === 'answer' && r.value === 'Yes') pass++; else { fail++; console.log(`✗ in-person 25% is the on-site question; got ${JSON.stringify(r)}`); }
}
is('Have you ever interviewed at Anthropic before?', 'No', 'never applied means never interviewed');
is('AI Policy for Application', 'Yes', 'the AI policy acknowledgement is the standing AI consent');
is('Agreement to Arbitrate', 'Yes', 'an arbitration agreement is a consent box');
is('Please read the arbitration agreement below', 'Yes');
is('Do you agree for Metaview to join and take notes in your interviews?', 'Yes', 'an interview note-taker is a consent (Focused Energy, 2026-10-16)');
is('What is the address from which you plan on working? If you would need to relocate, please type "relocating".', 'Springfield, Washington', 'his location is the address he works from');

// ── SmartRecruiters screening step, Becton Dickinson (live 2026-09-04) ──
is('Have you ever been employed by Becton Dickinson?', 'No', '"employed BY" is the previously-employed question');
is('Are you legally authorized to work in the USA without sponsorship?', 'No',
  'without-sponsorship is derived: he requires sponsorship, so No — never his plain authorization answer');
{
  const noKey = { ...P, answers: { ...P.answers, require_sponsorship: 'No', authorized_to_work_us: 'Yes' } };
  const r = resolveLabel('Are you legally authorized to work in the United States without sponsorship?', noKey);
  if (r.kind === 'answer' && r.value === 'Yes') pass++; else { fail++; console.log(`✗ needs no sponsorship → his authorization answer; got ${JSON.stringify(r)}`); }
  const unknown = { ...P, answers: { ...P.answers, require_sponsorship: undefined, authorized_without_sponsorship: undefined } };
  const u = resolveLabel('Are you legally authorized to work in the United States without sponsorship?', unknown);
  if (u.kind !== 'answer') pass++; else { fail++; console.log(`✗ neither answer known → blank, never guessed; got ${JSON.stringify(u)}`); }
}
{
  // TI, live 2026-10-24 (F-909): required, and left blank.
  const f1 = { ...P, answers: { ...P.answers, visa_status_note: 'F-1 student; OPT after graduation, then H-1B' } };
  const ti = 'U.S. Immigration Form: Do you currently hold an H, L, E, J, or F nonimmigrant visa (examples: H-1B, H-2B, H-4, L-1, L-2, E-1, E-2, J-1, J-2, F-1, etc.)?';
  const r = resolveLabel(ti, f1);
  if (r.kind === 'answer' && r.value === 'Yes') pass++; else { fail++; console.log(`✗ an F-1 holder holds an F nonimmigrant visa; got ${JSON.stringify(r)}`); }
  const none = resolveLabel(ti, { ...P, answers: { ...P.answers, visa_status_note: '' } });
  if (none.kind !== 'answer' || none.value !== 'Yes') pass++; else { fail++; console.log('✗ no F-1 in the profile → never Yes'); }
}
{
  // onsemi, 2026-10-24 (F-913): "Previous Last Name" was typed "Rivera".
  const r = resolveLabel('Previous Last Name', P);
  if (!(r.kind === 'answer' && r.value === 'Byron')) pass++; else { fail++; console.log('✗ a previous last name is never his current one'); }
}
is('Are you eligible for a 24-month OPT extension based upon a US degree in STEM?', 'Yes', 'STEM extension beats the generic OPT rule');
is('Do you have a disability or chronic condition that substantially limits one or more of your major life activities, including mobility and learning?',
  'No, I do not have a disability', '"major life activities" must NOT take the discipline answer');
is('What was your major?', 'Mechanical Engineering', 'a real "major" question still resolves');
is('Field of Study', 'Mechanical Engineering');

// ── wording variants seen across vendors ────────────────────────────
is('Where did you hear about Hadrian?', 'Company Website', 'Ashby says "Where", not "How"');
is('How did you find out about this opportunity?', 'Company Website'); // his choice, 2026-10-23: the company's own site first
is('Are you a former ASML employee or contractor?', 'No', 'company name sits between the words');
is('How many years of relevant professional experience do you have related to this position?', '2 years');
is('Please select your sex:', 'Male', 'Workday asks sex, not gender');
is('How would you describe your racial/ethnic background?', 'Asian', 'neither \\brace\\b nor /ethnicit/ matched');
is('Are you Hispanic or Latino?', 'No', 'the real hispanic question still wins');
is('Race', 'Asian', 'a clean Race label must not hit the hispanic rule');
is('Are you any of the following "protected individuals" as defined in 8 USC 1324b(a)(3)?',
  'None of the above', 'export-control question has a None-of-the-above answer set');
is('Do you want to join the ASML Global Talent Community?', 'Yes');
is('Are you currently or have you within the last 12 months worked at KLA through a third-party company or agency?', 'No');
is('Do you have at least the basic job requirements listed for this position?', 'Yes');

// ── address labels must not match mid-sentence ──────────────────────
is('Country', 'United States of America');
is('Country of Residence', 'United States of America');
is('State', 'Washington');
is('State/Province', 'Washington');
is('In the last 5 years, have you been an employee of a U.S. federal, state, or local government?',
  'No', '"state" mid-sentence must NOT answer with a US state');
is('If employment is offered, can you submit verification of your legal right to work at a Micron affiliated company in the country to which you have applied?',
  'Yes', '"country" mid-sentence must NOT answer with a country');
is('All Micron sites must observe U.S. export control rules that control information that may be provided to persons from Cuba, Iran, North Korea, and Syria. Are you a citizen of, or do you hold dual citizenship with any of these countries?',
  'No', 'export-control country citizenship');
is('Micron is required to comply with federal reporting regulations. A U.S. worker is defined by the U.S. Department of Labor as a 1) U.S. citizen, 2) U.S. national, 3) U.S. legal permanent resident, 4) refugee, or 5) person granted asylum. Are you in one of the above five groups?',
  'No', 'U.S. worker definition question');
is('City', 'Springfield');
is('Are you legally authorized to work in the country where this position is located?',
  'Yes', '"where…located" must NOT answer with the candidate location');
is('Where are you located?', 'Springfield, Washington', 'the real location question still resolves');
is('Current location', 'Springfield, Washington');
is('Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)',
  'Yes', 'NVIDIA words sponsorship as "employer support"');

// ── never-fill still holds ──────────────────────────────────────────
is('Signature', 'never');
is('Date of Birth', 'never');
is('Social Security Number', 'never');
is('What is your sexual orientation?', 'never');
is('Do you identify as transgender?', 'never');

// ── unknown stays unknown (never guessed) ───────────────────────────
is('Describe a complex robotic failure you diagnosed in the field.', 'unknown');
is('Do you have a valid driver’s license?', 'unknown');

// == "have you ever worked here", as employers actually word it ==
//
// Applied Materials asks "Have you ever worked at Applied Materials as a regular
// employee, contingent worker, intern, etc.?" - no "previously", no "former",
// and nothing after "worked at" saying "before", so all three original spellings
// missed it and a question with a configured answer was handed back to him.
is('Have you ever worked at Applied Materials as a regular employee, contingent worker, intern, etc.?', 'No');
is('Have you ever been employed with Micron?', 'No');
is('Are you a former Intel employee?', 'No');
is('Have you previously worked for this company?', 'No');
// Must not swallow a question about OTHER employers or about applying.
is('Which companies have you worked at that use robotics?', 'unknown');

// == phone TYPE is not phone NUMBER ==
// /phone/ matched "Contact Phone Type" on the live Tesla form and answered it
// with the number, so a Mobile/Landline dropdown was asked to match
// "+1 (555) 000-0000". The type is not in the profile, so it must come back
// unknown - naming the missing key - rather than taking the number.
is('Contact Phone Type', 'unknown');
is('Phone Type', 'unknown');
// ...while the number itself still routes.
is('Mobile Phone Number', '+1 555');
is('Phone', '+1 555');


// == QUESTION TYPES THIS TABLE HAD NO ANSWER FOR ==
// Found by auditing it against the ~55 field types a mature autofill extension
// names in its own config. Twelve had no rule; these are the ones his profile
// can honestly answer.

// "Have you served in the armed forces?" is veteran status, worded so that
// neither /veteran/ nor any EEO rule matched it.
is("Have you served in the armed forces?", "I am not a Veteran.");
is("Have you served in the U.S. Armed Forces?", "I am not a Veteran.");
is("Veteran status", "I am not a Veteran.");

// "When can you start?" is how half of them word availability, and it matched
// neither /start date/ nor /available to start/.
is("When can you start?", "June 2027");
is("Earliest date you can begin", "June 2027");
is("Start Date", "June 2027");

// Account credentials belong to signing up, not applying. The extension refuses
// a whole form containing a password; this covers a form that mixes them in.
is("Username", "never");
is("Create a password", "never");
is("Confirm Password", "never");
// ...without swallowing an ordinary question that merely contains the word.
is("Do you have a portfolio password we should know?", "unknown");


// == FALSE CLAIMS. The worst class of bug this table can produce. ==
// Found by auditing against a mature autofill extension taxonomy, then verified
// against his real profile. Each of these put an untrue statement about his
// status on a real application, and the first two did it WITHOUT review-flagging,
// so he could not have caught them.

// "Country of Citizenship" is 24 characters, so the address rule matched it and
// answered "United States of America". He is a Canadian citizen on an F-1.
// Since 2026-09-04 the profile carries `citizenship_country`, so these are
// ANSWERED with it — never with the address country.
is("Country of Citizenship", "Ruritania");
is("Country of Birth", "unknown", 'birth is not assumed to equal citizenship');
is("Country of Nationality", "Ruritania");
is("Country/Region of Citizenship", "Ruritania");
is("Citizenship", "Ruritania");
// Lam / Micron / Applied Materials (Eightfold), verbatim. Went unanswered on
// every Lam application before the profile had the value.
is('For the sole purpose of determining export licensing requirements, please provide your most recent country/region of citizenship or legal permanent residence. If your country/region is not listed please choose "Other".',
  'Ruritania', 'export-control country of citizenship');
is('Citizenship Status', 'unknown', 'a STATUS question is not answered with a country (fixture has no status)');
// ...and RESIDENCE is not citizenship. He does live in the US; these stay.
is("Country", "United States of America");
is("Country of Residence", "United States of America");
is("Country or Region", "United States of America");
is("State", "Washington");

// "...WITHOUT sponsorship" is the opposite question, and it contains
// "authorized to work", so the general rule answered it "Yes".
is("Are you legally authorized to work in the United States without sponsorship?", "No");  // F-335: derived — he requires sponsorship
is("Are you able to work in the US without sponsorship now or in the future?", "No");  // F-335: derived — he requires sponsorship
is("Can you work without requiring sponsorship?", "No");  // F-335: derived — he requires sponsorship
// ...while every unnegated form still answers.
is("Are you legally authorized to work in the United States?", "Yes");
// UNRESTRICTED is a condition he does not meet (2026-09-24): on F-1 his right
// to work runs through OPT and then H-1B, and CLAUDE.md names "unrestricted
// authorization demanded up front" as the one thing he lacks. Derived from his
// sponsorship answer, like the "without sponsorship" forms above.
is("Do you have the unrestricted right to work in the United States?", "No");
is("Will you now or in the future require sponsorship for employment visa status?", "Yes");
is("Will you require employer support to obtain or maintain authorization to work?", "Yes");

// A work-authorisation question about ANOTHER country is not about the US.
is("Are you legally authorized to work in Canada?", "unknown");
is("Are you legally authorized to work in the United Kingdom?", "unknown");
is("Are you eligible to work in Australia?", "unknown");
// ...and "the country" (meaning the posting country) still routes to the US rule.
is("Are you authorized to work in the country where this position is located?", "Yes");


// -- a country code is not a phone number ---------------------------
//
// Measured against his real profile: "Country Phone Code" was answered with his
// entire number, "+1 (555) 000-0000", because the rule below it matches on the
// bare word "phone". On a dropdown the search finds nothing; on a text field it
// simply writes the number into a field asking which country he dials from.
is('Country Phone Code', 'United States of America', 'country code, not the number');
is('Phone Country Code', 'United States of America');
is('International Dialing Code', 'United States of America');
is('Phone Number', '+1 555', 'a real phone field still gets the number');
is('Mobile', '+1 555');

// Workday writes it "Phone Device Type" -- a word between "phone" and "type",
// which the type rule missed, so a Mobile/Home/Work dropdown was offered the
// phone number.
is('Phone Device Type', 'unknown', 'no phone_type in this fixture, so blank and reported');

// -- preferred name is what he GOES BY ------------------------------
//
// His profile carries `preferred_full_name` beside the legal `full_name`, and
// the rule handed back the legal name for both -- so a form that deliberately
// asks each question got the same answer twice.
is('Preferred Name', 'Ada Byron', 'the preferred name, not the legal one');
is('Preferred First Name', 'Ada', 'first word of what he goes by');
is('Legal Name', 'Augusta Ada Byron', 'and the legal fields are untouched');
is('Full Name', 'Augusta Ada Byron');
is('First Name', 'Ada'); is('Legal First Name', 'Augusta Ada'); // 2026-10-23: the name he goes by, legal only where it says legal
is('Last Name', 'Byron');

// -- a graduation date split across two controls --------------------
//
// The profile holds one string, "May 2027". A form with separate Month and Year
// dropdowns was handed the whole string for each, matched neither, and left both
// blank -- on a required field where, for a new grad, the date is the single
// most load-bearing fact on the application.
is('Graduation Month', 'May');
is('Graduation Year', '2027');
is('Expected Graduation Year', '2027');
is('Anticipated Graduation Month', 'May');
is('Expected Graduation Date', 'May 2027', 'the single-field form still gets the whole string');


// -- an embargoed-country question is not the US-person question ----
//
// Torc Robotics writes it "U.S. Export Control Requirements - Are you a
// citizen, national, or resident of any of the following countries/regions?"
// with [Cuba, Iran, North Korea, Syria, Crimea...]. It contains "export
// control", so the generic rule claimed it and answered from `us_person`.
//
// Both are "No" for him, so the answer came out right by coincidence. That is
// the reason to fix it, not a reason to leave it: he is not a U.S. person AND
// not a citizen of any of those countries, and the day the first of those
// changes this would have ticked "Cuba".
is('U.S. Export Control Requirements - Are you a citizen, national, or resident of any of the following countries/regions? Check each that apply: * - Cuba',
  'No', 'the country question routes to restricted_country_citizen');
is('Are you a U.S. person as defined by ITAR?', 'No', 'and a real US-person question still routes there');
is('Are you a citizen of Cuba, Iran, North Korea or Syria?', 'No');
is('How did you first hear about this job? Please list the site, event, or person that referred you.',
  'Company Website', 'an adverb between "you" and "hear" must not break the match');


// -- a question that asks him to EXPLAIN is not asking for a number --
//
// Measured on a live Veeva form: "If you are a candidate with under 2 years of
// experience, please briefly explain your training and relevant coursework"
// contains "years of experience", so the rule answered it "2 years" -- nonsense
// in a box asking for prose, and the kind of answer a human reader notices.
//
// It only became reachable once the label fix started reading Lever's custom
// questions correctly. A field we could not read could not be answered wrongly
// either.
is('If you are a candidate with under 2 years of experience, please briefly explain your training and relevant coursework',
  'unknown', 'an explain-question must not be answered with a duration');
is('Please describe your years of experience in manufacturing', 'unknown');
is('Tell us about your years of experience', 'unknown');
is('How many years of experience do you have?', '2 years', 'a real quantity question still answers');
is('Years of relevant experience', '2 years');


// -- a time zone is a fact about where he lives ---------------------
//
// Measured on a live Veeva form: a REQUIRED radio group
// [AST, EST, CST, MST, PST, Other] went unanswered although his state settles
// it. Split states are deliberately absent from the table -- guessing which
// half of Oregon he means would be inventing a fact.
is('Which timezone are you currently located in?', 'PST');
is('Time Zone', 'PST');


// -- "WHICH locations..." is asking for places, not yes/no ----------
//
// Measured on a live Veeva form: the label contains "relocat", so the rule
// answered it "Yes" -- offered to a checkbox list of [Pleasanton CA, Kansas
// City MO, Boston MA, ...], matching nothing and reporting the useless
// `no option matches "Yes"`.
is('If you are willing to work in office, which locations are you open to relocating to? Please select all that apply: - Pleasanton, CA',
  'unknown', 'a list of cities must not be answered "Yes"');
is('What cities would you relocate to?', 'unknown');
is('Are you willing to relocate?', 'Yes', 'and the real yes/no question still answers');
is('Are you open to relocation for this role?', 'Yes');


// -- a question about a legal tie, not a request for a name --------
//
// "Are you bonded by your current company/scholarship?" contains "current
// company", so the employer-name rule claimed it and answered a live Micron
// form with **the employer's name** -- nonsense in a yes/no about whether he is
// contractually tied to someone.
is('Are you bonded by your current company/scholarship?', 'No');
is('Do you have an agreement between you and your current or former employer that may restrict your ability to accept this offer?', 'No');
is('Are you subject to a non-compete?', 'No');
is('Current Employer', 'Test Co', 'and a real employer question still answers');
is('What is your present employer?', 'Test Co');
is('Are you referred to this job by a Micron employee?', 'No');


// -- a years question qualified by an industry is not his years ----
//
// Found by resolving every label from five live forms at once. Veeva asks "How
// many years of experience in the SOFTWARE INDUSTRY do you have?" and the rule
// answered "2 years" -- a false claim about a domain he has never worked in, on
// the form of a software company, which is the audience most able to check it.
//
// Refusing costs one flagged field even when the qualifier IS his own field.
// The rule cannot tell the difference, and pretending it can is how the wrong
// version of this ships.
is('How many years of experience in the software industry do you have?', 'unknown');
is('How many years of experience with Java do you have?', 'unknown');
is('How many years of experience in the manufacturing industry do you have?', 'unknown');
is('How many years of experience do you have?', '2 years', 'an unqualified question still answers');
is('Years of relevant experience', '2 years');


console.log('\n🧪 a conditional follow-up reaches BOTH engines');
// F-254. F-248 and F-249 put this guard in `planField`, which only the browser
// extension goes through. `_form.mjs` and `workday.mjs` — the Playwright driver
// — call resolveLabel directly at eight sites, so the guard never ran there and
// the driver would still type "No, I do not have a disability" into a box
// asking what accommodations he needs. F-223's shape, on the most sensitive
// question class on any form.
is('If you have a disability, please describe any accommodations you need',
  'unknown', 'the EEO answer must never land in an accommodations box');
is('If your disability requires accommodation, please describe what you need',
  'unknown', 'nor when the condition is worded "if your"');
is('If your veteran status applies, please provide details',
  'unknown', 'nor does veteran status become an explanation');

// And the answers that ARE correct must survive, or the guard is only a way of
// losing information.
is('If you are authorized to work in the US, what is your start date?',
  'June 2027', 'a start date behind a work-auth condition is still answered');
is('If you are a candidate with under 2 years of experience, please share your GPA',
  '3.9', 'a GPA behind an experience condition is still answered');
is('Are you authorized to work in the United States?',
  'Yes', 'an ordinary question is untouched');

// ── the campus form, measured on Applied Materials (2026-09-07) ──────
//
// Seven questions, four of them wrong or blank on a live Workday form he was
// looking at. The worst was not a blank: "Are you in school?" — a Yes/No
// dropdown — came back **"Lakeside University"**, because the school-NAME rule
// matches any label with "school" in it and sits above the campus rules. Same
// shape as the `\bopt\b` and bare `/major/` bugs already recorded in this file.
is('Are you in school?', 'Yes', 'a question ABOUT school is not the name of his school');
is('Are you currently a student?', 'Yes');
is('Which best describes your status?', "I'm in my final year of school",
  'a campus form asking what he is had no rule at all');
is('What term did you (or will you) graduate in?', 'Spring (April - June)',
  '"term" was only recognised directly after "graduation"');
is('What is your expected graduation term?', 'Spring (April - June)');
is('What is the name of the school or institution you currently attend or most recently attended?',
  'Test University', 'and the question that IS asking which school still answers');
is('School or University', 'Test University');
is('Where did you study?', 'Test University');
is('What is the highest level of education you are pursuing or have completed?', "Bachelor's");

// ── a link field that says "profile" rather than "portfolio" (Tesla) ──
//
// "Profile Link" and "Profile Link Type" were the two most frequent entries on
// the untackled list, twice each, because neither word is website, portfolio or
// personal site. Alex, 2026-09-19: *"if page asks for portfolio or profile, put
// in alexrivera.example"*.
// The value is written EXACTLY as his profile holds it. His site is served at
// the bare domain; 2026-09-19: "its only alexrivera.example no http or
// anything adding it will fuck it up and not bring up my portfolio".
is('Profile Link', 'https://example-portfolio.test', 'a profile link is his portfolio');
is('Portfolio Link', 'https://example-portfolio.test');
is('Personal Website', 'https://example-portfolio.test');
is('Link to your portfolio', 'https://example-portfolio.test');
// The TYPE dropdown asks what KIND of link it is, not for the address — and it
// contains "profile link", so the rule above would have claimed it.
// A type, never a URL — and "Other" ahead of "Portfolio", which is what he
// picked on Tesla's [Portfolio, LinkedIn, Indeed, Other] (2026-09-24).
is('Profile Link Type', 'Personal Website', 'the type dropdown gets a type, not a URL');
is('Type of profile', 'Personal Website');
{
  const r = resolveLabel('Profile Link Type', P);
  if (Array.isArray(r.value) && r.value.indexOf('Other') >= 0 && r.value.indexOf('Other') < r.value.indexOf('Portfolio')) pass++;
  else { fail++; console.log('✗ Other must come before Portfolio: ' + JSON.stringify(r.value)); }
}
// LinkedIn keeps its own field: it is more specific and sits above.
is('LinkedIn Profile', 'https://linkedin.com/in/test');
is('LinkedIn Profile URL', 'https://linkedin.com/in/test');
// A question ABOUT the link is not a request for it. This rule was safe only
// because `website` was empty; filling it in made the leak real.
is('Do you have a portfolio password we should know?', 'unknown');
is('Is your portfolio password protected?', 'unknown');
is('Portfolio login', 'unknown');

// ── the GPA question that names where the GPA is from (TSMC, live 2026-09-19) ──
//
// "What is your exact GPA of your highest degree?" was filled **"Bachelor's"**
// on the live SuccessFactors form. `highest.*(level|degree)` sits above the GPA
// rule and this table is first-match-wins, so the qualifier beat the question.
// Three more of the same shape were latent; all four are below. A GPA question
// almost always says WHOSE GPA, and that phrase is never the answer.
is('What is your exact GPA of your highest degree?', '3.9',
  'the degree named in a GPA question is not the GPA');
is('GPA of highest degree earned', '3.9');
is('What was your GPA in your major?', '3.9',
  '…nor is the major');
is('What is your cumulative GPA at your university?', '3.9',
  '…nor is the university');
// And the questions those phrases DO own must survive, or the fix is a trade.
is('Please indicate your highest level of education.', "Bachelor's");
is('What is your field of study?', 'Mechanical Engineering');
is('What is the name of the school you attend?', 'Test University');
is('What type of opportunity are you looking for?', 'New College Graduate');

// ── a GPA floor is a Yes/No about his number (F-943, Cummins on Oracle) ──
is('Do you possess a cumulative GPA that is 2.5 or higher?', 'Yes', 'the Cummins question');
is('Do you possess a cumulative GPA that is 2.5 or higher on a 4.0 scale in your academic program?', 'Yes', 'the Cummins question, word for word (answer log 2026-10-30)');
is('Do you have a minimum GPA of 3.0?', 'Yes', '"minimum GPA of N"');
is('Do you have a 3.0+ GPA?', 'Yes', '"N+"');
is('Is your GPA at least 3.95?', 'No', 'a floor above his GPA is answered No, truthfully');
is('Is your cumulative GPA 3.5/4.0 or above?', 'Yes', 'a floor written on the 4-point scale');
is('Is your GPA below 2.0?', 'unknown', 'a ceiling is not a floor: left for him');
is('Do you have a GPA?', 'unknown', 'no number, nothing to compare');
is('What is your cumulative GPA?', '3.9', 'the number question still gets the number');
// The number has to be the GPA's (review 2026-11-06).
is('Do you have a 3.0 GPA and 2+ years of experience?', 'unknown', '"2+ years" is not a GPA floor');
is('Is your GPA 84 or higher?', 'unknown', 'a 100-point scale is not read as 4.0');
is('Is your GPA between 3.3-4.0?', 'unknown', 'a range is his to answer');

// ── the two EEO questions that look alike (Ashby, measured 2026-09-07) ──
//
// A race question whose FIRST OPTION is "Hispanic or Latino" is labelled
// "Race — Hispanic or Latino" by the discoverer, and the hispanic rule claimed
// it — answering "No", which is none of the seven races offered, so the
// question was left blank on a form his profile answers.
is('Race — Hispanic or Latino', 'Asian', 'a label that names race is the race question');
is('Race/Ethnicity', 'Asian');
is('Are you Hispanic or Latino?', 'No', 'and the hispanic question is still its own');
is('Hispanic or Latino?', 'No');

// ── found by auditing his own queue, not by a form failing (2026-09-07) ──
//
// "I have a preferred name" is a CHECKBOX on Applied Materials' Eightfold
// form, and the rule that returns the name itself claimed it — handing back
// "Alex Rivera", which is not "yes", so the box stayed unticked and the fields it
// reveals never appeared. And a bare "Language" dropdown on the same form came
// back "a dropdown we have no answer for" while the profile answered it.
is('I have a preferred name', 'Yes', 'he has one, so the box is ticked');
is('Do you have a preferred name?', 'Yes');
is('Preferred Name', 'Ada Byron', 'and the question that wants the NAME still gets it');
is('Language', 'English', 'a bare Language dropdown is which language to write to him in');
is('Language Preference', 'English');
is('Self Identification Language', 'English');


// ── the questions he answered himself on 2026-09-20 (F-530 … F-535) ──
//
// Six of these are DELIBERATE BLANKS: he was asked, and the answer is nothing on
// every form, forever. `blank` is not `unknown` — unknown puts the question in
// the ledger he reads, and a question whose answer will never change is noise
// there. The distinction is the whole point of these cases.
is('Legal Middle Name', 'blank', 'he has no middle name — that is an answer, not a gap');
is('Middle Name', 'blank');
is('Middle Initial', 'blank');
is('Facebook', 'blank', 'he does not put personal social media on applications');
is('X (fka Twitter)', 'blank');
is('Twitter', 'blank');
is('Name of Referrer', 'blank', 'nobody referred him, so there is no name to give');
is('Employee ID(if applicable)', 'blank', 'he has never worked there');
is('Certification Name', 'blank', 'he fills the Skills table, not Certifications');
is('Date Acquired', 'blank');
is('Expiration Date', 'blank');

// …and the ones that now have a real answer.
is('Salutation', 'Mr.');
is('Name Prefix', 'Mr.');
is('Current Title', 'Test Lead', 'his title, not his employer');
is('Present Job Title', 'Test Lead');
is('Since obtaining your most recent citizenship, did you afterwards become a permanent resident in any other country?',
  'No', 'the one visa question no file answered until he did');
is('Hear more about career opportunities', 'Yes',
  'TSMC words the talent-community opt-in without the word "talent" (F-535)');
is('Be notified about future openings', 'Yes');

// HE HAS NO GITHUB, so the box that asks for one gets the portfolio: the question
// is "where can we see your work". `github: ""` alone read as "your profile
// leaves this blank" and sent an answerable field to the ledger.
// …SUPERSEDED 2026-09-24: on Exowatt he cleared alexrivera.example out of
// "GitHub URL" by hand. The box stays empty, as a deliberate blank.
is('GitHub', 'blank');
is('GitHub URL', 'blank');
is('Link to your repository', 'blank');

// A REQUEST FOR LINKS, PLURAL, GETS BOTH — and a single-link field still gets
// exactly one. The first version of this rule failed the second half, matching
// "Link to your portfolio" and returning two addresses where one belongs (F-532).
is('Please share links to GitHub, portfolio, publications, or hardware projects (if applicable).',
  'https://example-portfolio.test\nhttps://linkedin.com/in/test',
  'the links box gets the links, not an essay');
is('Links to your portfolio or personal website',
  'https://example-portfolio.test\nhttps://linkedin.com/in/test');
is('Link to your portfolio', 'https://example-portfolio.test',
  'SINGULAR — one field, one link');
is('Portfolio Link', 'https://example-portfolio.test');
is('Personal Website', 'https://example-portfolio.test');
is('LinkedIn Profile', 'https://linkedin.com/in/test');

// "How many employees does your current company have?" was answered "Test Co" —
// the phrase "current company" inside a question about headcount (F-531).
is('How many employees does your current company have?', 'unknown',
  'a headcount is not his employer name');
is('What is the size of your current company?', 'unknown');
is('Current Company', 'Test Co', 'and the question that really asks it is unchanged');
is('Current Employer', 'Test Co');

// A JOB title must never take the salutation. The first draft of the salutation
// rule matched a bare "Title", which arrives in employment-history rows.
is('Job Title', 'unknown', 'a job title is not a courtesy title');
is('Previous Title', 'unknown');

// F-549 — Intuitive Surgical (SmartRecruiters), 2026-09-24. The most common
// sponsorship wording carries "H-1B visa status" as its EXAMPLE, and the
// visa-history rule answered it with held_h1b → "No": "I will not require
// sponsorship", for a candidate on F-1 who will. And "What is your postal
// code?" missed a start-anchored pattern and went to the essay writer.
{
  const H = { ...P, identity: { ...P.identity, postal_code: '12345' }, answers: { ...P.answers, held_h1b: 'No', held_j1: 'No' } };
  const check = (label, expected) => {
    const r = resolveLabel(label, H);
    // A ladder's first rung is its Yes/No answer (F-850: sponsorship also
    // carries the statement it makes true, for lists of sentences).
    const got = r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind;
    if (got === expected) pass++;
    else { fail++; console.log(`✗ ${label.slice(0, 70)}\n    expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`); }
  };
  check('Will you now or in the future require sponsorship for employment visa status (e.g./ H-1B visa status)?', 'Yes');
  check('Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?', 'Yes');
  check('Will you need sponsorship for an H-1B visa status now or in the future?', 'Yes');
  check('Have you ever held H-1B status?', 'No');
  check('Do you currently hold H-1B status?', 'No');
  check('Are you currently in J-1 status?', 'No');
  check('What is your postal code?', '12345');
  check('Postal/Zip Code', '12345');
  check('Zip Code', '12345');
}

// Read back from every answer he changed by hand, 2026-09-24.
{
  const Q = { ...P, identity: { ...P.identity, preferred_full_name: 'Ada Byron' },
    education: { ...P.education, location: 'Springfield, Washington' },
    answers: { ...P.answers, willing_onsite: 'Yes' } };
  for (const [label, want] of [
    ['Region', 'Washington'],                                                     // Viavi Workday address
    ['School location', 'Springfield, Washington'],                                   // SmartRecruiters education
    ['Can you work from our San Francisco office 5 days a week?', 'Yes'],         // Nudge
    ['Do you have a portfolio showcasing relevant projects or work that you can provide as part of your application?', 'Yes'], // Lexington
    ['Name', 'Ada Byron'],                                                        // Radiant: what he goes by
    ['Legal Name', 'Augusta Ada Byron'],
    ['Legal Name — I have a preferred name', 'Yes'],                              // KLA / Wolfspeed Workday
    ['Where did you hear about us? (e.g., LinkedIn, job board, referral)', 'Company Website'], // Nudge: the how-heard answer, not his URL
    ['This position requires the lawful ability to access technical data, information, and areas controlled by United States export control laws and regulations. In order for Wolfspeed, Inc. and its subsidiaries to comply with U.S. Department of Commerce Export Administration Regulations, you will need to provide documentation confirming your nationality if an offer of employment is extended', 'Yes'],
    ['California Applicants only:I understand the Company may obtain, without using the services of a third party investigative consumer reporting agency, public records', 'Not applicable'],
  ]) {
    const r = resolveLabel(label, Q);
    const got = r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind;
    if (got === want) pass++;
    else { fail++; console.log(`✗ ${label.slice(0, 70)}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); }
  }
  // From the ledger of questions left for him and the BambooHR drive, 2026-09-24.
  const R = { ...Q, identity: { ...Q.identity, city: 'Springfield', state: 'Washington' },
    answers: { ...Q.answers, citizenship_country: 'Vietnam', us_person: 'No', employer_agreement: 'No', employee_referral: 'No', skills: 'SolidWorks, CNC machining, GD&T' } };
  for (const [label, want] of [
    ['Do you currently reside in the Sacramento Area?', 'No'],
    ['Do you live in Springfield?', 'Yes'],
    ['Do you reside in the Pacific Northwest?', 'unknown'],
    ['Are you a citizen of the country you’ll be employed in?', 'No'],
    ['Are you a citizen of the U.S., a lawful permanent resident of the U.S., or a non-U.S. citizen who has been granted asylum', 'No'],
    ['Are you currently party to any employment, consulting or personal services agreement that (i) restricts your ability', 'No'],
    ['Address Line 2', 'blank'],
    ['If you were referred by a Cornelis Network’s employee, input the employee’s name here. If not, put N/A.', 'N/A'],
    ['This role is Hybrid, working out of our Wayne, PA office. Are you open to hybrid?', 'Yes'],
    ['Do you have experience with SolidWorks?', 'Yes'],
    ['Do you have experience with PCB Design?', 'unknown'],   // not in his files: his to answer, never a No
  ]) {
    const r = resolveLabel(label, R);
    const got = r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind;
    if (got === want) pass++;
    else { fail++; console.log(`✗ ${label.slice(0, 70)}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); }
  }
  // SPONSORSHIP QUESTIONS THAT NAME CPT OR OPT ARE STILL SPONSORSHIP QUESTIONS
  // (2026-09-24: the CPT rule answered both of these "No").
  const S = { ...R, answers: { ...R.answers, require_sponsorship: 'Yes', requires_cpt: 'No', currently_on_opt: 'No', held_h1b: 'No' } };
  for (const [label, want] of [
    ['Will you now or in the future require support or sponsorship for an immigration-related employment benefit? Y/NFor purposes of the following question, “support or sponsorship for an immigration-related employment benefit” means an H-1B visa petition, an O-1 visa petition, an E-3 visa petition, a F-1 STEM OPT, F-1 OPT, F-1 CPT, TN status', 'Yes'],
    ['Will you now or in the future require employer sponsorship to work in the United States (including OPT, CPT, H-1B, TN, or other visa types)?', 'Yes'],
    ['Will you require CPT authorization from your school to work here?', 'No'],
    ['Have you ever been sponsored for an H-1B?', 'No'],
  ]) {
    const r = resolveLabel(label, S);
    const got = r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind;   // a ladder's first rung (F-850)
    if (got === want) pass++;
    else { fail++; console.log(`✗ ${label.slice(0, 70)}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); }
  }
  // A real U.S.-person question still gets his status, not the acknowledgement.
  const status = resolveLabel('Are you a U.S. person as defined by the export control regulations?', { ...Q, answers: { ...Q.answers, us_person: 'No' } });
  if (status.value === 'No') pass++; else { fail++; console.log('✗ the U.S.-person question got ' + JSON.stringify(status)); }
  const cal = resolveLabel('California Applicants only: I understand…', { ...Q, identity: { ...Q.identity, state: 'California' } });
  if (cal.kind !== 'answer') pass++; else { fail++; console.log('✗ a California resident got N/A: ' + JSON.stringify(cal)); }
}

// TSMC's SuccessFactors form, live 2026-09-24: other people's contact boxes
// got HIS email, and the relatives follow-ups got "No".
{
  const blank = [
    'Email of Referrer', 'Name of Referrer', "Referrer's Email", 'Referrer Phone',
    'Name of Relatives', 'Relationship of Relatives', "Relative's Name",
  ];
  for (const label of blank) {
    const r = resolveLabel(label, P);
    if (r.kind === 'blank') pass++;
    else { fail++; console.log(`✗ ${label} should be a deliberate blank, got ${JSON.stringify(r)}`); }
  }
  const referred = resolveLabel('Are you referred by a current or new employee of the company? If yes, please provide the name and email address of the employee who referred you', P);
  if (referred.kind === 'answer' && referred.value === 'No') pass++;
  else { fail++; console.log('✗ the referral question got ' + JSON.stringify(referred)); }
  for (const [label, want] of [['Email', 'a@b.c'], ['Email Address', 'a@b.c'], ['Confirm Email', 'a@b.c'],
    ['Do you have any relatives working in this company?', 'No']]) {
    const r = resolveLabel(label, { ...P, answers: { ...P.answers, relatives_at_company: 'No' } });
    if (r.kind === 'answer' && r.value === want) pass++;
    else { fail++; console.log(`✗ ${label} expected ${want}, got ${JSON.stringify(r)}`); }
  }
}

// F-553 (2026-09-24): "does not input portfolio link in additional website
// section". A link box that never says "website" gets the portfolio too.
{
  const W = { ...P, identity: { ...P.identity, portfolio: 'alexrivera.example', website: 'alexrivera.example' } };
  for (const label of ['Additional URL', 'Other Link', 'Personal URL', 'Web Address', 'URL']) {
    const r = resolveLabel(label, W);
    if (r.kind === 'answer' && r.value === 'alexrivera.example') pass++;
    else { fail++; console.log('✗ ' + label + ' got ' + JSON.stringify(r)); }
  }
  const tw = resolveLabel('Other Twitter URL', W);
  if (tw.kind !== 'answer' || tw.value !== 'alexrivera.example') pass++; else { fail++; console.log('✗ Twitter got the portfolio'); }
}

// F-581 (2026-09-24): questions the replay of his own submissions found
// empty or wrong.
{
  const W = { ...P, identity: { ...P.identity, portfolio: 'alexrivera.example' }, answers: { ...P.answers, authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', notice_period: 'I will graduate in May 2027 and require no notice period.', current_company: 'Lakeside University — Manufacturing Lead (student)' } };
  const cases = [
    ['Are you legally eligible for employment in the country where the job is located?', (r) => r.kind === 'answer' && [].concat(r.value)[0] === 'Yes'],
    ['What is your required notice period with your current employer?', (r) => r.kind === 'answer' && /no notice period/.test(r.value)],
    // F-790 (Terex, 2026-10-22): got "Lakeside University — Manufacturing Lead (student)".
    ['How much notice do you need to leave your current employer?', (r) => r.kind === 'answer' && /no notice period/.test(r.value)],
    ['How many weeks of notice must you give your current employer?', (r) => r.kind === 'answer' && /no notice period/.test(r.value)],
    ['Current Employer', (r) => r.kind === 'answer' && /Lakeside/.test(r.value)],
    // F-796 (Coherent, Oracle, 2026-10-22): required, left blank.
    ['Will you require visa assistance now or in the future from our company?', (r) => r.kind === 'answer' && [].concat(r.value)[0] === 'Yes'],
    ['Do you need immigration support to work in the U.S.?', (r) => r.kind === 'answer' && [].concat(r.value)[0] === 'Yes'],
    ['Have you ever received visa assistance from us?', (r) => !(r.kind === 'answer' && [].concat(r.value)[0] === 'Yes')],
    ['(Optional) Where can we find more information about you? (e.g., personal website, GitHub, x.com)', (r) => r.kind === 'answer' && r.value === 'alexrivera.example'],
    ['GitHub URL', (r) => r.kind === 'blank'],
    ['Understanding', (r) => r.kind === 'answer'],
    ['How did you hear about us?', (r) => r.kind === 'answer' && [].concat(r.value)[0] === 'Company Website' && [].concat(r.value).includes('LinkedIn')],
  ];
  for (const [label, ok] of cases) {
    const r = resolveLabel(label, W);
    if (ok(r)) pass++; else { fail++; console.log('✗ ' + label + ' got ' + JSON.stringify(r)); }
  }
}

// SuccessFactors portals, 2026-10-07..22 (F-830..F-834): questions left blank
// or answered wrong on EnerSys, Newell and Veeco.
{
  const S = { ...P, answers: { ...P.answers, has_bachelors_degree: 'Yes', previously_employed_here: 'No', citizenship_status: 'Non-U.S. citizen (F-1 student visa, Canada)' } };
  const first = (r) => [].concat(r?.value)[0];
  const cases = [
    // F-830: the required mark and "at least" hid the degree question; years answered No.
    ['* Do you have at least a 4 year degree in a related field OR at least 10 years of work related experience?', (r) => r.kind === 'answer' && first(r) === 'Yes'],
    ['Do you have a four-year degree in engineering?', (r) => r.kind === 'answer' && first(r) === 'Yes'],
    // F-831: someone else's name is never his.
    ["If you selected EnerSys Employee Referral, please indicate who referred you by providing the individual's LEGAL FIRST and LAST NAME.", (r) => r.kind !== 'answer' || !/Byron|Ada/.test(String(first(r)))],
    ["Referrer's Last Name", (r) => r.kind !== 'answer' || !/Byron/.test(String(first(r)))],
    ['Emergency contact first name', (r) => r.kind !== 'answer' || !/Ada/.test(String(first(r)))],
    ['* Last Name', (r) => r.kind === 'answer' && first(r) === 'Byron'],
    ['Preferred First Name', (r) => r.kind === 'answer' && first(r) === 'Ada'],
    // F-898: a relative's (or anyone's) "their full name" is never his.
    ["Relative's full name", (r) => r.kind !== 'answer' || !/Byron|Ada/.test(String(first(r)))],
    ['Please provide their full name, location and your relationship to them.', (r) => r.kind !== 'answer' || !/Byron|Ada/.test(String(first(r)))],
    // F-832: employed here, with no time word.
    ['* Have you been employed by EnerSys, or any of its affiliates? NOTE: Internal Employees need to apply via LiNK >> Careers.', (r) => r.kind === 'answer' && first(r) === 'No'],
    ['* Are you, or have you been employed by Newell Brands during the last 5 years (formerly known as Newell Rubbermaid or Jarden Corporation)?', (r) => r.kind === 'answer' && first(r) === 'No'],
    // F-834: citizen or permanent resident.
    ['* Are you a U.S. Citizen or U.S. Permanent Resident (i.e. a green card holder)?', (r) => r.kind === 'answer' && first(r) === 'No'],
    ['* This facility performs work for the military. Thus, employees must be either a US Citizen or a Permanent Resident. Can you meet this requirement?', (r) => !(r.kind === 'answer' && first(r) === 'Yes')],
  ];
  for (const [label, ok] of cases) {
    const r = resolveLabel(label, S);
    if (ok(r)) pass++; else { fail++; console.log('✗ ' + label + ' got ' + JSON.stringify(r)); }
  }
}

// Coherent's Oracle "Travel Domestically" (2026-10-22): his travel_ok, given for
// travel within the United States; travel abroad is not his files' to answer.
{
  const T = { ...P, answers: { ...P.answers, travel_ok: 'Yes', travel_countries: 'Within the United States' } };
  const dom = resolveLabel('Travel Domestically', T);
  if (dom.kind === 'answer' && [].concat(dom.value)[0] === 'Yes') pass++; else { fail++; console.log('✗ Travel Domestically got ' + JSON.stringify(dom)); }
  const abroad = resolveLabel('Travel Internationally', T);
  if (!(abroad.kind === 'answer' && [].concat(abroad.value)[0] === 'Yes')) pass++; else { fail++; console.log('✗ Travel Internationally got ' + JSON.stringify(abroad)); }
}

// ── Samsung, Standard Bots, ASML, KLA — left for him 2026-09-25, his answers ──
{
  const Q = { ...P, identity: { ...P.identity, initials: 'AAB', county: 'Springfield' }, answers: { ...P.answers, citizenship_with_year: 'Vietnam (2005)' } };
  const at = (label) => { const r = resolveLabel(label, Q); return r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind; };
  const eq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`  ✗ ${name}\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`); } };
  eq('patent question', at('Inventions: Are you currently seeking or plan to seek a patent related to the semiconductor industry?'), 'No');
  eq('its "type NA" follow-up', at('If you answered Yes to the above inventions question, please explain. Type NA if you answered No to this question.'), 'NA');
  eq('another subsidiary', at('Are you currently a full-time employee at another Samsung subsidiary?'), 'No');
  eq('initial the statement', at('By submitting an application, you, the applicant, agree to not disclose to Samsung, or induce Samsung to use, any confidential or proprietary information (including trade secrets) belonging to any current or previous employer or other person or entity. Please initial that you acknowledge and understand this statement.'), 'AAB');
  eq('commuting distance, labelled by its own Yes option', at('Yes, I currently live within daily commuting distance of Glen Cove, NY.'), 'I do not currently live within daily commuting distance');
  // ASML's category list still gets "All others" — offered after his F-1
  // wording, which a text box or Intel's list takes first (2026-09-26).
  eq('current (immigration) status', [].concat(resolveLabel('Please indicate your current status.', Q).value || []).includes('All others'), true);
  eq('…never an employment status', at('Please indicate your current employment status.') === 'All others', false);
  eq('citizenship and the year granted', at('Please provide country of citizenship and/or permanent residency and the year granted.'), 'Vietnam (2005)');
  eq('county', at('County'), 'Springfield');
  eq('a patent OBLIGATION is still the employer-agreement rule', at('Do you have any non-compete or patent obligations to a current employer?'), 'No');
  // Round two of the live stress drive, 2026-09-25.
  eq('legal RIGHTS (plural) to work', at('Do you have legal rights to work in the USA?'), 'Yes');
  eq('freshman or sophomore: a 2027 graduate is neither', resolveLabel('Are you currently a Freshman or Sophomore in an undergraduate program?', { ...Q, education: { ...Q.education, graduation: 'May 2027' } }).value, 'No');
  eq('no referrer to name', resolveLabel('If you were referred to Base, please share the name of your referrer.', Q).kind, 'blank');
  eq('earliest start, "realistically"', at('When could you realistically start full time?') === Q.answers.earliest_start, true);
}

// HP (2026-09-26): two questions left blank on his live form.
{
  const W = { ...P, work_experience: [{ company: 'Applied Materials' }, { company: 'Lakeside University - Makerspace Manufacturing Technology Center' }] };
  const at = (label, p) => { const r = resolveLabel(label, p); return r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind; };
  const eqq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); } };
  const GOV = '1. Within the past 5 years, have you been employed by the federal or any state or local government or public institution within Australia, Bangladesh, Brazil, Canada, China, Ireland, Korea, Mexico, Pakistan, Philippines, Puerto Rico, Taiwan, United Kingdom, United States and/or Vietnam?';
  eqq('government employment, "employed" first', at(GOV, W), 'No');
  eqq('…silent when his history names a public employer', at(GOV, { ...W, work_experience: [{ company: 'Washington State Department of Transportation' }] }) === 'No', false);
  const HP = 'To help us understand your preferences related to personal data and uses for future recruitment processes, are you an existing HP employee?';
  eqq('an existing employee of the employer he applies to: No', at(HP, { ...W, applyingTo: 'HP Inc.' }), 'No');
  eqq('Are you a current <company> employee?', at('Are you a current HP employee?', { ...W, applyingTo: 'HP Inc.' }), 'No');
  eqq('…never No where his history names the employer', at('Are you a current Applied Materials employee?', { ...W, applyingTo: 'Applied Materials, Inc.' }) === 'No', false);
}

// Round 18 drives (2026-09-26): Humanoid, Re:Build.
{
  const at = (label, p = P) => { const r = resolveLabel(label, p); return r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind; };
  const eqq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); } };
  eqq('work authorization STATUS as statements: authorized now, sponsorship later',
    at('What is your work authorization status for the country where this role is based?'), 'Authorized to work now, but will require employer sponsorship in the future');
  eqq('…the plain question still says Yes', at('Are you legally authorized to work in the United States?'), 'Yes');
  eqq('"Do you have a Bachelor\'s degree in engineering (…discipline)?" is asked, never answered with a major',
    at("Do you have a Bachelor's degree in engineering (Mechanical, Electrical, Chemical, or a related discipline)?"), 'unknown');
  const disc = resolveLabel('Field of study', { ...P, education: { ...P.education, discipline: 'Mechanical Engineering' } }).value;
  eqq('field of study never offers a different degree', (Array.isArray(disc) ? disc : [disc]).some((d) => /technology|^engineering$/i.test(d)), false);
  const home = { ...P, identity: { ...P.identity, address_line1: '1 Main St', city: 'Springfield', state: 'Washington', postal_code: '99201', country: 'United States of America' } };
  eqq('the whole address in one box', at('We require the current physical/mailing address for all candidates. Please enter your address here (incomplete addresses may result in your disqualification).', home),
    '1 Main St, Springfield, Washington 99201, United States of America');
  eqq('…"Address" alone is still line 1', at('Address', home), '1 Main St');
  eqq('…"Street Address 1 (optional)" is line 1', at('Street Address 1 (optional)', home), '1 Main St');
  eqq('ADP\'s "Phone number country" is a country, never the number (2026-10-16)', at('Phone number country', home) === P.identity.phone, false);
  eqq('…"Street Address 2 (optional)" is never the street again (Apple, 2026-10-16)', at('Street Address 2 (optional)', home) === '1 Main St', false);
  eqq('…and an email address is still the email', at('Please provide your email address', home), 'a@b.c');
  const pay = { ...P, answers: { ...P.answers, salary_expectation: '$90000/year' } };
  eqq('"willing to accept this salary range?" is a yes/no, never his figure',
    at('The job posting listed the applicable salary range for this position. Are you willing to accept this salary range?', pay) === '$90000/year', false);
  eqq('"Current Salary" is never his target', at('Current Salary', pay) === '$90000/year', false);
  eqq('…"Desired Salary" still is', at('Desired Salary', pay), '$90000/year');
  eqq('"The posted base salary range … $90,000 – $150,000 … Is that range acceptable to you?" is Yes when it reaches his ask (Therm-X, 2026-10-17)',
    at('The posted base salary range for this role is $90,000 – $150,000 depending on level. Is that range acceptable to you?', pay), 'Yes');
  eqq('…a range that tops out below his ask is his to answer',
    at('The posted base salary range for this role is $60,000 – $75,000. Is that range acceptable to you?', pay) === 'Yes', false);
  const me = { ...P, education: { ...P.education, discipline: 'Mechanical Engineering', degree_level: "Bachelor's", degree: 'Bachelor of Science' } };
  eqq('"Have you completed, or will you complete before your start date, a BS in Mechanical Engineering…?" is Yes, never his major (Therm-X)',
    at('Have you completed, or will you complete before your start date, a BS in Mechanical Engineering or a closely related engineering discipline?', me), 'Yes');
  eqq('"How many years have you worked as a mechanical design engineer?" is a band true of internships, never his 2 years (Therm-X)',
    at('How many years have you worked as a mechanical design engineer (internships count at half)?', me), '0-2');
  eqq('…a BS in Electrical Engineering is his to answer',
    at('Have you completed, or will you complete before your start date, a BS in Electrical Engineering or a closely related engineering discipline?', me) === 'Yes', false);
}

// Stress round 19 and the logged-question audit (2026-09-26).
{
  const at = (label, p = P) => { const r = resolveLabel(label, p); return r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind; };
  const eqq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${name}
    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); } };
  eqq('"Phonetic pronunciation of your name" never gets the phone number', at('Phonetic pronunciation of your name') === P.identity.phone, false);
  eqq('…"Phone Number" still does', at('Phone Number'), P.identity.phone);
  eqq('"Language of Application" is English', at('Language of Application'), 'English');
  eqq('the full-legal-name confirmation is Yes, not the middle-name blank', at('Have you added your full legal name and surname (including any middle names)?'), 'Yes');
  eqq('…the middle-name box itself stays blank', at('Middle Name'), 'blank');
  const VET = 'U.S. – Protected Veteran Self-Identification This Employer is a Government contractor subject to the Vietnam Era Veterans’ Readjustment Assistance Act of 1974 … including those who served in the military, please indicate.';
  eqq('a veteran notice that says "military" is never the U.S.-person (ITAR) rule', at(VET) === P.answers.us_person, false);
  eqq('…an ITAR question still is', at('This position requires access to ITAR-controlled data. Are you a U.S. person?'), P.answers.us_person);
  eqq('professional experience NOT counting internships: No for a new grad (HP)',
    at('Do you have more than 12 months of professional experience related to the job requirements of this role? (not including internships, teaching assistance, research, or military experience).'), 'No');
  eqq('a high school diploma: Yes for a bachelor’s student', at('Do you have a high school diploma or GED?'), 'Yes');
  eqq('…completed high school, the same', at('Have you completed high school or GED?'), 'Yes');
  const cit = { ...P, answers: { ...P.answers, citizenship_country: 'Vietnam', permanent_resident_elsewhere: 'No' } };
  const CL = 'Do you hold Citizenship or Permanent Residency status from any of the following countries or administrative regions? Please select one.';
  eqq('citizenship from a list of countries: his country', at(CL, cit), 'Vietnam');
  const all = resolveLabel(CL, cit).value;
  eqq('…and None of the above after it, only because he is a resident nowhere else', Array.isArray(all) && all.includes('None of the above'), true);
  eqq('…never None where the profile does not say so', (resolveLabel(CL, { ...cit, answers: { ...cit.answers, permanent_resident_elsewhere: '' } }).value || []).includes('None of the above'), false);
  eqq('"without restrictions" stays No (his decision, 2026-09-26)', at('Are you legally authorized to work in the country where the job is located without restrictions?'), 'No');
  eqq('"eligible to work … for any employer" is the same question: No (Hyve, he changed Yes to No, 2026-09-27)', at('Are you eligible to work in the US for any employer?'), 'No');
  eqq('…while plain authorization is still Yes', [].concat(at('Are you legally authorized to work in the United States?'))[0], 'Yes');
  const MQ = 'Have you applied on any previous occasions for employment in any capacity with Micron?';
  eqq('applied here before, on record in the store: Yes (Micron, sixteen applications; F-621)', at(MQ, { ...P, appliedHereBefore: true }), 'Yes');
  eqq('…none on record: his standing answer', at(MQ, { ...P, appliedHereBefore: false, answers: { ...P.answers, previously_applied_here: 'No' } }), 'No');
  eqq('…and an application is not an interview', at('Have you ever interviewed at Micron before?', { ...P, appliedHereBefore: true, answers: { ...P.answers, previously_applied_here: 'No' } }), 'No');
  const visa = { ...P, answers: { ...P.answers, visa_status_note: 'F-1 student; OPT then H-1B' } };
  eqq('"please detail your sponsorship needs" gets his visa note, never a bare Yes', at('If you answered yes above, please detail your current or future sponsorship needs.', visa), 'F-1 student; OPT then H-1B');
  eqq('…the yes/no sponsorship question is still Yes', at('Will you now or in the future require sponsorship?', visa), 'Yes');
  const STATES = 'Preference will be given to qualified candidates who do not reside, or plan to reside, in Alabama, Arkansas, Florida, or Tennessee. If you live in one of these states, would you consider relocation?';
  eqq('a list of states he does not live in: N/A first', at(STATES, { ...P, identity: { ...P.identity, state: 'Washington' } }), 'N/A, I do not live in one of these states');
  eqq('…a list that names his state: his relocation answer', at(STATES.replace('Tennessee', 'Washington'), { ...P, identity: { ...P.identity, state: 'Washington' } }), 'Yes');
  eqq('…never when internships count', at('Do you have more than 12 months of professional experience (including internships)?') === 'No', false);
}

// F-633 — questions he answered by hand, from the replay of 2026-10-01.
{
  const at = (label, p = P) => { const r = resolveLabel(label, p); return r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind; };
  const eqq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); } };
  eqq('Onto: "legally permitted to work" is the authorization question', at('Are you legally permitted to work in the country where this job is located?'), 'Yes');
  eqq('Onto: "can you provide proof of eligibility?" — the I-9 documents, Yes', at('If hired, can you provide proof of eligibility?'), 'Yes');
  eqq('Luma: "How did you discover us?" is how he heard', at('How did you discover us?'), 'Company Website');
  eqq('Luma: a box for "Portfolio/GitHub/Website" gets the portfolio', at('Portfolio/GitHub/Website'), 'https://example-portfolio.test');
  eqq('…a box for GitHub alone is still left empty', at('GitHub URL'), 'blank');
  eqq('Amazon: "What country/region are you currently located?"', at('What country/region are you currently located?'), 'United States of America');
  eqq('Amazon: "Are you currently located outside of the United States?" — No', at('Are you currently located outside of the United States?'), 'No');
  eqq('Amazon: "Are you currently working as an intern at Amazon?" — No', at('Are you currently working as an intern at Amazon?', { ...P, applyingTo: 'Amazon', work_experience: [{ company: 'Test Co' }] }), 'No');
  eqq('…never No where he works now', at('Are you currently working as an intern at Test Co?', { ...P, applyingTo: 'Test Co', work_experience: [{ company: 'Test Co' }] }) === 'No', false);
  const cad = { ...P, answers: { ...P.answers, skills: 'SolidWorks, Fusion 360, FEA, GD&T' } };
  eqq('Amazon: "simulation and 3D modeling software" — his CAD and FEA tools are both', at('Do you have experience with simulation and 3D modeling software?', cad), 'Yes');
  eqq('…a category none of his tools belong to stays his', at('Do you have experience with simulation and 3D modeling software?', { ...P, answers: { ...P.answers, skills: 'GD&T' } }), 'unknown');
  const nxp = { ...P, applyingTo: 'NXP Semiconductors', work_experience: [{ company: 'Applied Materials' }] };
  eqq('NXP: "Have you worked with us before?" is the previous-employment question — No', at('Have you worked with us before?', nxp), 'No');
  eqq('…and Yes where his history names the employer', at('Have you worked with us before?', { ...nxp, applyingTo: 'Applied Materials' }), 'Yes');
  eqq('…while "worked with PLCs" is still a skills question', at('Have you worked with PLCs before?', { ...P, answers: { ...P.answers, skills: 'PLCs, SolidWorks' } }), 'Yes');
  eqq('NXP: "use your information for other job openings" is the talent-pool offer', at('Do you accept that we use your information for other job openings?'), 'Yes');
}

// F-642 — Enpro on PageUp, 2026-10-02.
{
  const at = (label, p = P) => { const r = resolveLabel(label, p); return r.kind === 'answer' ? (Array.isArray(r.value) ? r.value[0] : r.value) : r.kind; };
  const eqq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); } };
  eqq('Enpro: "By continuing, you agree that you have read our Privacy Statement" is the consent box', at('By continuing, you agree that you have read our Privacy Statement'), 'Yes');
  eqq('…a box agreeing to a fact about him is not', at('I agree that I am a U.S. citizen') === 'Yes', false);
  // F-732: GlobalFoundries' Workday self-identify step, 2026-10-16.
  eqq('GlobalFoundries: "you declare that you have read, understood, and accepted the terms in this policy" is the consent box',
    at('By submitting, you declare that you have read, understood, and accepted the terms in this policy'), 'Yes');
  eqq('…a declaration of a fact is not', at('By submitting, you declare that you have read this form and that you are a U.S. citizen') === 'Yes', false);
}

// ORACLE RECRUITING CLOUD, 2026-10-22 (F-811, F-812, F-813, F-814).
{
  const ok = (label, test, why) => { const r = resolveLabel(label, P); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const v = (r) => [].concat(r.value)[0];
  // F-811: a discharge date is no veteran status (Ralliant, Coherent).
  for (const part of ['Month', 'Day', 'Year']) ok(`Newly Separated Veteran Discharge Date ${part}`, (r) => r.kind === 'blank', 'F-811 discharge date');
  ok('Veteran Self-Identification Status', (r) => r.kind === 'answer' && v(r) === 'I am not a Veteran.', 'F-811 veteran status still answered');
  const vet = { ...P, eeo: { ...P.eeo, veteran: 'I identify as one or more of the classifications of protected veteran' } };
  { const r = resolveLabel('Newly Separated Veteran Discharge Date Month', vet); if (r.kind !== 'blank') pass++; else { fail++; console.log('✗ F-811 a veteran\'s discharge date is not blanked'); } }
  // F-812: a start date that mentions notice asks for the date (Legrand).
  ok('What is your earliest possible start date, including any notice period required?', (r) => r.kind === 'answer' && /June 2027/.test(v(r)), 'F-812 start date over notice');
  ok('How much notice do you need to leave your current employer?', (r) => !(r.kind === 'answer' && /^June/.test(String(v(r)))), 'F-812 a notice question never gets the start date');
  // F-813: "I choose not to disclose my …" is No for him (Coherent).
  ok('I choose not to disclose my sex', (r) => r.kind === 'answer' && v(r) === 'No', 'F-813 sex');
  ok('I choose not to disclose my ethnicity or race', (r) => r.kind === 'answer' && v(r) === 'No', 'F-813 race');
  ok('Sex at Birth', (r) => r.kind === 'answer' && v(r) === 'Male', 'F-813 the sex question itself');
  const declined = { ...P, eeo: { ...P.eeo, gender: 'I decline to self-identify' } };
  { const r = resolveLabel('I choose not to disclose my sex', declined); if (!(r.kind === 'answer' && v(r) === 'No')) pass++; else { fail++; console.log('✗ F-813 someone who declines is not told No'); } }
  // F-814: a state asked as its code (Nokia, Ralliant).
  ok('State/Province Code', (r) => r.kind === 'answer' && v(r) === 'WA', 'F-814 code');
  ok('State Abbreviation', (r) => r.kind === 'answer' && v(r) === 'WA', 'F-814 abbreviation');
  ok('State', (r) => r.kind === 'answer' && v(r) === 'Washington', 'F-814 the bare State keeps the name');
}

// F-823..F-828 (Greenhouse / Ashby / Lever, 2026-10-22): wordings his own sends answered.
{
  const Q = { ...P, answers: { ...P.answers, willing_onsite: 'Yes', travel_ok: 'Yes' },
    education: { ...(P.education || {}), discipline: 'Mechanical Engineering', degree: 'Bachelor of Science' } };
  let n = 0;
  const ok = (label, test, why, prof = Q) => { const r = resolveLabel(label, prof); n++; if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const v = (r) => [].concat(r.value)[0];
  ok('This role is based out of our San Francisco office 5 days/week. Are you able to commit to working from this office?', (r) => r.kind === 'answer' && v(r) === 'Yes', 'F-823 in-office commit');
  ok('Are you near a major airport hub and comfortable with the travel requirements?', (r) => !(r.kind === 'answer' && /engineering/i.test(String(v(r)))), 'F-824 "major" airport is not a field of study');
  ok('What is your major?', (r) => r.kind === 'answer' && /mechanical/i.test(String(v(r))), 'F-824 the major question itself');
  ok("How'd you discover Unlimited?", (r) => r.kind === 'answer', 'F-827 contraction');
  const long = "Have you earned a Bachelor's degree in one of the fields mentioned above, as listed in the minimum requirements?";
  ok(long, (r) => r.kind === 'answer' && v(r) === 'Yes', 'F-828 the posting names his field', { ...Q, postingText: 'Minimum requirements: BS in Mechanical Engineering, Mechatronics or Robotics.' });
  ok(long, (r) => !(r.kind === 'answer' && v(r) === 'Yes'), 'F-828 a posting that does not name it is his', { ...Q, postingText: 'Minimum requirements: BS in Electrical Engineering or Computer Science.' });
}
// ── F-802: Workday questions his profile answers that no rule read (2026-10-03..16) ──
{
  const Q = { ...P, answers: { ...P.answers, remote_or_onsite: 'Open to on-site, hybrid, or remote', employer_agreement: 'No', worked_via_agency: 'No' } };
  const ok = (label, test, why) => { const r = resolveLabel(label, Q); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const v = (r) => [].concat(r.value)[0];
  ok('Type of Employment Desired', (r) => r.kind === 'answer' && [].concat(r.value).includes('Full- Time'), 'F-802 ITW employment type');
  ok('Type of Employment', (r) => !(r.kind === 'answer' && v(r) === 'Full-time'), 'F-802 a bare history field is not what he wants next');
  ok('Do you have a confidentiality obligation with your current or former employer that could impact your ability to work at Dematic in the position for which you have applied?', (r) => r.kind === 'answer' && v(r) === 'No', 'F-802 KION confidentiality');
  ok('Do you have any other contractual obligations to current or former employers that could impact your ability to work at Dematic?', (r) => r.kind === 'answer' && v(r) === 'No', 'F-802 KION contractual');
  // He answered Flowserve's "interested in working from home?" himself with
  // "0%" (2026-10-03): his specific answer beats the general "open to remote".
  ok('Are you interested in working from home?', (r) => !(r.kind === 'answer' && v(r) === 'Yes'), 'F-802 working from home stays his');
  ok('Are you or have you in the past been a contingent work or contractor for GLOBAL FOUNDRIES?', (r) => r.kind === 'answer' && v(r) === 'No', 'F-802 GlobalFoundries contingent worker');
  ok('Have you ever been excluded, suspended or debarred (or proposed for suspension or debarment) or declared ineligible?', (r) => !(r.kind === 'answer'), 'F-802 a fact his files do not hold stays his');
}
// ── F-804 / F-805: Workday questions left on his list (Plug Power, Samsung) ──
{
  const ok = (label, test, why) => { const r = resolveLabel(label, P); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  ok('Is this rate of pay Hourly or Salary?', (r) => r.kind === 'answer' && vals(r).includes('Salary') && !vals(r).some((x) => /\$/.test(x)), 'F-804 pay TYPE, not the amount');
  { const r = resolveLabel('What is your desired annual salary?', { ...P, answers: { ...P.answers, salary_expectation: '$90000/year' } });
    if (r.kind === 'answer' && /90000/.test(String([].concat(r.value)[0]))) pass++; else { fail++; console.log(`✗ F-804 the amount question still gets the amount: got ${JSON.stringify(r)}`); } }
  ok('By submitting an application, you, the applicant, agree to not disclose to Samsung, or induce Samsung to use, any confidential or proprietary information belonging to your former employers', (r) => r.kind === 'answer' && vals(r)[0] === 'Yes', 'F-805 an undertaking about former employers\' secrets');
  ok('Do you have access to confidential or proprietary information?', (r) => !(r.kind === 'answer' && vals(r)[0] === 'Yes' && vals(r).includes('I agree')), 'F-805 a factual question about confidential information is not the undertaking');
}
// ── F-850..F-854: Rippling, Paylocity, Eightfold (2026-09-25..10-16) ──
{
  const ok = (label, test, why, prof = P) => { const r = resolveLabel(label, prof); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  // F-850: statements instead of Yes/No (VulcanForms, Rippling).
  ok('Will you now or in the future require sponsorship for employment (e.g., H-1B visa)?',
    (r) => r.kind === 'answer' && vals(r)[0] === 'Yes' && vals(r).some((x) => /in the future but am currently authorized/i.test(x)), 'F-850 sponsorship statement ladder');
  ok('Will you now or in the future require sponsorship?', (r) => r.kind === 'answer' && vals(r)[0] === 'No',
    'F-850 someone who needs none is still "No"', { ...P, answers: { ...P.answers, require_sponsorship: 'No' } });
  // F-851 / F-852: a past employer's phone and pay are not his.
  ok('Company Phone Number', (r) => !(r.kind === 'answer' && /555/.test(String(vals(r)[0]))), 'F-851 company phone is not his mobile');
  ok('Employer Phone', (r) => !(r.kind === 'answer' && /555/.test(String(vals(r)[0]))), 'F-851 employer phone');
  ok('Mobile Number (required)', (r) => r.kind === 'answer' && /555/.test(String(vals(r)[0])), 'F-851 his own number still answered');
  const paid = { ...P, answers: { ...P.answers, salary_expectation: '$90000/year' } };
  ok('Starting Salary', (r) => !(r.kind === 'answer' && /90000/.test(String(vals(r)[0]))), 'F-852 a past job\'s starting salary', paid);
  ok('Ending Salary', (r) => !(r.kind === 'answer' && /90000/.test(String(vals(r)[0]))), 'F-852 a past job\'s ending salary', paid);
  ok('Desired Salary', (r) => r.kind === 'answer' && /90000/.test(String(vals(r)[0])), 'F-852 his target is still his answer to a desired salary', paid);
  // F-856: an amount asked with its unit beside it is still the amount.
  ok('What are your compensation expectations (hourly or salary)?', (r) => r.kind === 'answer' && /90000/.test(String(vals(r)[0])), 'F-856 Samsung amount', paid);
  ok('What is your desired compensation expectation? Please provide either a salary or hourly amount.', (r) => r.kind === 'answer' && /90000/.test(String(vals(r)[0])), 'F-856 Terex amount', paid);
  ok('Is this rate of pay Hourly or Salary?', (r) => r.kind === 'answer' && vals(r).includes('Salary'), 'F-856 the choice itself is still the pay type', paid);
  // F-853: an English first name is the name he goes by.
  ok('English First Name', (r) => r.kind === 'answer' && vals(r)[0] === 'Ada', 'F-853 English first name');
  ok('First Name', (r) => r.kind === 'answer' && vals(r)[0] === 'Ada', 'the plain first name is the one he goes by (2026-10-23)');
  // F-854: relative availability choices, true only with margin before his start.
  const later = { ...P, answers: { ...P.answers, earliest_start: `June ${new Date().getFullYear() + 2}` } };
  ok('When would you be available if an offer was accepted?', (r) => r.kind === 'answer' && vals(r)[0] === later.answers.earliest_start && vals(r).includes('More than 2 months after offer acceptance') && !vals(r).some((x) => /\+/.test(x)),
    'F-854 relative choices offered for a far start', later);
  const soon = new Date(); soon.setMonth(soon.getMonth() + 1);
  const near = { ...P, answers: { ...P.answers, earliest_start: `${soon.toLocaleString('en-US', { month: 'long' })} ${soon.getFullYear()}` } };
  ok('When would you be available if an offer was accepted?', (r) => r.kind === 'answer' && !vals(r).some((x) => /more than/i.test(x)), 'F-854 none for a start a month away', near);
}

// ORACLE'S WORDS ON FORD'S FORM, 2026-10-23 (F-885, F-886).
{
  const ok = (label, test, why, prof = P) => { const r = resolveLabel(label, prof); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  const addr = { ...P, identity: { ...P.identity, address_line1: '123 Sample Street', address_line2: 'Unit 4B' } };
  ok('Street Number and Name or P.O. Box', (r) => vals(r)[0] === '123 Sample Street', 'F-885 street line', addr);
  ok('Apartment or Unit Number', (r) => vals(r)[0] === 'Unit 4B', 'F-885 unit line', addr);
  ok('Apt/Suite', (r) => vals(r)[0] === 'Unit 4B', 'F-885 apt/suite', addr);
  const grad = { ...P, education: { ...P.education, graduation: 'May 2027' } };
  ok('Projected Completion Date Month', (r) => vals(r)[0] === 'May', 'F-886 completion month', grad);
  ok('Projected Completion Date Year', (r) => vals(r)[0] === '2027', 'F-886 completion year', grad);
  ok('Highest Education Level', (r) => r.kind === 'answer' && vals(r).includes('Yes'), 'F-886 a Yes/No "highest" takes Yes after the levels', grad);
  ok('What is your expected graduation term?', (r) => !/^May 2027$/.test(String(vals(r)[0] || '')), 'F-886 a TERM is not the date rule', grad);
  ok('How did you hear about this opportunity?', (r) => vals(r).includes('Ford Careers Site'), 'F-885 the brand, not "Ford Motor"', { ...P, applyingTo: 'Ford Motor' });
}

// F-893: Lincoln Electric's SuccessFactors labels his files answer.
{
  const ok = (label, test, why, prof = P) => { const r = resolveLabel(label, prof); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  const Q = { ...P, education: { ...(P.education || {}), location: 'Springfield, Washington', degree_level: "Bachelor's" }, answers: { ...P.answers, employer_agreement: 'No' } };
  ok('Education State/Province', (r) => vals(r)[0] === 'Washington', 'F-893 education state/province', Q);
  ok('Are you under any contract or employment restriction with a current or previous employer?', (r) => vals(r)[0] === 'No', 'F-893 contract restriction', Q);
  ok('Are you subject to any ongoing contractual or other legal restrictions which may limit the scope of work you can perform?', (r) => vals(r)[0] === 'No', 'F-893 Oceaneering restrictions', Q);
  ok('Education Type', (r) => vals(r)[0] === "Bachelor's Degree Program (or equivalent)" && vals(r).includes('College / University'), 'F-893 degree level first, institution kinds after', Q);
}

// F-891: Schindler's three SuccessFactors questions his files answer.
{
  const ok = (label, test, why, prof = P) => { const r = resolveLabel(label, prof); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  const Q = { ...P, applyingTo: 'Schindler Group', answers: { ...P.answers, previously_applied_here: 'No', work_permit: 'Yes' }, eeo: { ...(P.eeo || {}), veteran: 'I am not a Veteran.' } };
  ok('Have you ever applied for employment at Schindler before?', (r) => vals(r)[0] === 'No', 'F-891 applied before, employer between', Q);
  ok('* Do you possess a work permit that legally entitles you to work in the country you are applying for?', (r) => vals(r)[0] === 'Yes', 'F-891 work permit without "valid"', Q);
  ok('Status of National Military Service', (r) => vals(r)[0] === 'NA', 'F-891 national military service', Q);
  ok('Are you a protected veteran?', (r) => /not a veteran/i.test(String(vals(r)[0])), 'F-891 the veteran question is unchanged', Q);
}

// F-895: his work-authorization answers, 2026-10-23.
{
  const ok = (label, test, why, prof = P) => { const r = resolveLabel(label, prof); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  const Q = { ...P, answers: { ...P.answers, currently_on_opt: 'No' } };
  ok('* Are you authorized to work for any employer in the U.S. or only your current employer?', (r) => vals(r)[0] === 'Any Employer', 'F-895 any employer', Q);
  ok('Do you currently have an EAD (Employment Authorization Document)?', (r) => vals(r)[0] === 'No', 'F-895 EAD now', Q);
  ok('If you have an Employment Authorization Document (EAD) under the F-1 student OPT program, are you eligible for a 24-month OPT extension?', (r) => /do not have OPT/i.test(String(vals(r)[0])), 'F-895 the OPT-extension question keeps its own rule', Q);
}

// HIS THREE ANSWERS, 2026-10-23.
{
  const ok = (label, test, why, prof = P) => { const r = resolveLabel(label, prof); if (test(r)) pass++; else { fail++; console.log(`✗ ${why}: ${label} got ${JSON.stringify(r)}`); } };
  const vals = (r) => [].concat(r.value);
  // Authorized without sponsorship NOW → Yes; anything reaching the future → No.
  ok('Are you authorized to work for Zipline in the United States without sponsorship now?', (r) => vals(r)[0] === 'Yes', 'now is his authorization today');
  ok('Are you currently authorized to work in the U.S. without sponsorship?', (r) => vals(r)[0] === 'Yes', '"currently" is now');
  ok('Are you authorized to work for Zipline in the United States without sponsorship in the future?', (r) => vals(r)[0] === 'No', 'the future stays No');
  ok('Are you legally authorized to work in the United States now or in the future without sponsorship?', (r) => vals(r)[0] === 'No', 'now-or-future stays No');
  ok('Are you legally authorized to work in the US without sponsorship?', (r) => vals(r)[0] === 'No', 'no time word: the standing No');
  // First name: the one he goes by, unless the box says legal.
  ok('First Name', (r) => vals(r)[0] === 'Ada', 'plain first name');
  ok('Legal First Name', (r) => vals(r)[0] === 'Augusta Ada', 'legal first name');
  // How he heard: the company's own site first, named for the company when the list does.
  ok('How did you hear about us?', (r) => vals(r)[0] === 'Acme Website' && vals(r).includes('Company Website') && vals(r).includes('LinkedIn'), 'company site first, LinkedIn after', { ...P, applyingTo: 'Acme' });
}

// 2026-10-26 log audit: wrong sponsorship, status and date answers.
{
  const vals = (r) => [].concat(r.value);
  const ok = (label, test, note, prof = P) => {
    const r = resolveLabel(label, prof);
    if (r.kind === 'answer' && test(r)) pass += 1; else { fail += 1; console.log(`FAIL ${note}: ${label} -> ${JSON.stringify(r)}`); }
  };
  const F1 = { ...P, answers: { ...P.answers, visa_status_note: 'F-1 student graduating May 2027; OPT then H-1B' } };
  // Honda: a sponsorship question whose help text lists DACA was answered "No" by the DACA rule.
  ok('Will you now, or at any time in the future, require visa sponsorship by Honda, such as Optional Practical Training (OPT), H-1B, O-1, TN, etc. to legally be employed in the U.S.? You can answer “No”, if you are: (a) a U.S. Citizen, (b) a Lawful Permanent Resident, (c) authorized to work based on (ii) Deferred Action for Childhood Arrivals (DACA)',
    (r) => vals(r)[0] === 'Yes', 'sponsorship question mentioning DACA is still Yes', F1);
  ok('Are you a DACA recipient?', (r) => vals(r)[0] === 'No', 'a DACA question is still No', F1);
  // Terex: "currently" alone is today; he changed Yes to No by hand.
  ok('Do you currently require sponsorship to work in the country for which you are applying?', (r) => vals(r)[0] === 'No', 'currently require sponsorship → No');
  ok('Will you in the future require sponsorship to work in the country for which you are applying?', (r) => vals(r)[0] === 'Yes', 'future sponsorship → Yes');
  ok('Will you now or in the future require visa sponsorship?', (r) => vals(r)[0] === 'Yes', 'now-or-future → Yes');
  // F-951: "currently" beside a word that reaches past today is not today.
  ok('Do you currently, or do you anticipate, requiring visa sponsorship?', (r) => vals(r)[0] === 'Yes', 'currently-or-anticipate → Yes');
  ok('Do you currently require sponsorship or expect to?', (r) => vals(r)[0] === 'Yes', 'currently-or-expect → Yes');
  ok('Do you currently require, or will you require, sponsorship for employment visa status?', (r) => vals(r)[0] === 'Yes', 'currently-or-will → Yes');
  ok('Do you presently need an employer to sponsor you, or do you plan to request sponsorship eventually?', (r) => vals(r)[0] === 'Yes', 'presently-or-eventually → Yes');
  ok('Are you currently authorized to work in the US without sponsorship and able to maintain that status?', (r) => vals(r)[0] === 'No', 'without sponsorship + maintain → No');
  ok('Are you currently authorized to work without sponsorship, and would you remain so for the duration of employment?', (r) => vals(r)[0] === 'No', 'without sponsorship + remain → No');
  // A request to describe his status gets the note, never "Yes".
  ok('If visa sponsorship is required in US: What is the immigration status you currently hold? When does that work authorization expire?',
    (r) => /F-1/.test(vals(r)[0]), 'status question gets the visa note', F1);
  ok('If you answered "Yes" to the question above, please provide us information on your current immigration status, including type of visa and the amount of remaining work authorization.',
    (r) => /F-1/.test(vals(r)[0]), 'Cummins status question gets the visa note', F1);
  // Amazon: he has no EAD yet.
  ok('Is your current EAD your STEM Extension?', (r) => vals(r)[0] === 'No', 'no EAD yet → No');
  ok('Are you eligible for a 24-month STEM OPT extension?', (r) => vals(r)[0] === 'Yes', 'STEM extension eligibility stays Yes');
  // West Pharmaceutical: an education completion date is his graduation, not today.
  ok('Anticipated / Date of Completion', (r) => vals(r)[0] === 'May 2027', 'anticipated completion → graduation');
  ok('Date', (r) => /^\d\d\/\d\d\/\d{4}$/.test(vals(r)[0]), 'a bare Date is still today');
  // F-919: a graduation Day box gets a day.
  ok('What is your anticipated graduation date? Day', (r) => vals(r)[0] === '15', 'graduation Day → 15');
  ok('What is your anticipated graduation date? Month', (r) => vals(r)[0] === 'May', 'graduation Month → May');
  // F-918: degree, major and class year in one box.
  ok('Type of degree you are currently pursuing, major and what year you will be in Fall',
    (r) => /Bachelor of Science in Mechanical Engineering, Test University; I will be a senior in Fall 2026/.test(vals(r)[0]), 'degree + major + year sentence');
  ok('Major', (r) => vals(r)[0] === 'Mechanical Engineering', 'a bare Major is still the major');
  // F-917: an Oracle entry's own date boxes are not availability.
  { const r = resolveLabel('Start Date Month Year', P); if (r.kind !== 'answer') pass += 1; else { fail += 1; console.log('FAIL entry Start Date got', r.value); } }
  ok('When can you start?', (r) => /2027/.test(vals(r)[0]), 'availability still answered');
  // F-924: a box that shows its phone format gets it.
  const ph = { ...P, identity: { ...P.identity, phone: '+1 (509) 555-0134' } };
  ok('Please enter your full 10-digit phone number, including your area code (e.g., 123-456-7890).', (r) => vals(r)[0] === '509-555-0134', '10-digit phone format', ph);
  ok('Phone', (r) => vals(r)[0] === '+1 (509) 555-0134', 'plain phone unchanged', ph);
  // Full-log audit: a country list that names his country (fixture: Ruritania).
  ok('For any of the countries listed below: • Are you a citizen or have a passport? Armenia, Cuba, Iran, North Korea, Ruritania, Syria',
    (r) => vals(r)[0] === 'Yes', 'a citizenship list naming his country → Yes');
  ok('Are you a citizen of Cuba, Iran, North Korea or Syria?', (r) => vals(r)[0] === 'No', 'the embargo list without it → No');
  ok('Do you have dual citizenship or permanent residency status from countries other than the listed restricted countries? Cuba, Iran, Ruritania',
    (r) => vals(r)[0] === 'No', '"other than the listed" is not his citizenship');
  { const r = resolveLabel('In the past five (5) years, have you resided in any of these countries: Cuba, Iran, Ruritania', P);
    if (r.kind !== 'answer') pass += 1; else { fail += 1; console.log('FAIL residence in a list naming his country was answered', r.value); } }
  ok('o Are you currently in F-1 Visa status? (An F-1 Visa is granted to foreign students attending school in the United States)',
    (r) => vals(r)[0] === 'Yes', 'a bulleted F-1 yes/no is still Yes', F1);
  ok('For the purposes of determining long-term work authorization options, what type of visa do you currently hold (if any)?',
    (r) => /F-1/.test(vals(r)[0]), 'what type of visa → the note', F1);
}
// His row came first on the sponsorship answers above, and on a direct ask too.
{
  const r = resolveLabelRaw('Do you now or will you in the future need employer sponsorship for a visa?', { ...P, answers: { ...P.answers, authorized_to_work_us: 'Yes', require_sponsorship: 'Yes' } });
  if (r.kind === 'answer' && Array.isArray(r.value) && r.value[0] === SPONSOR_ROW && r.value[1] === 'Yes, not now') pass += 1;
  else { fail += 1; console.log('FAIL his sponsorship row is not named first', JSON.stringify(r)); }
  if (SPONSOR_ROW_SEEN >= 15) pass += 1; else { fail += 1; console.log(`FAIL his sponsorship row led only ${SPONSOR_ROW_SEEN} answers`); }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);