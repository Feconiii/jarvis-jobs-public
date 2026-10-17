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

import { resolveLabel } from './apply/_answers.mjs';

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
is('Are you eligible for a 24-month OPT extension based upon a US degree in STEM?', 'Yes', 'STEM extension beats the generic OPT rule');
is('Do you have a disability or chronic condition that substantially limits one or more of your major life activities, including mobility and learning?',
  'No, I do not have a disability', '"major life activities" must NOT take the discipline answer');
is('What was your major?', 'Mechanical Engineering', 'a real "major" question still resolves');
is('Field of Study', 'Mechanical Engineering');

// ── wording variants seen across vendors ────────────────────────────
is('Where did you hear about Hadrian?', 'LinkedIn', 'Ashby says "Where", not "How"');
is('How did you find out about this opportunity?', 'LinkedIn');
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
is('First Name', 'Augusta Ada');
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
  'LinkedIn', 'an adverb between "you" and "hear" must not break the match');


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
    const got = r.kind === 'answer' ? r.value : r.kind;
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
    ['Where did you hear about us? (e.g., LinkedIn, job board, referral)', 'LinkedIn'], // Nudge: the how-heard answer, not his URL
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
    const got = r.kind === 'answer' ? r.value : r.kind;
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
    ['(Optional) Where can we find more information about you? (e.g., personal website, GitHub, x.com)', (r) => r.kind === 'answer' && r.value === 'alexrivera.example'],
    ['GitHub URL', (r) => r.kind === 'blank'],
    ['Understanding', (r) => r.kind === 'answer'],
    ['How did you hear about us?', (r) => r.kind === 'answer' && [].concat(r.value)[0] === 'LinkedIn'],
  ];
  for (const [label, ok] of cases) {
    const r = resolveLabel(label, W);
    if (ok(r)) pass++; else { fail++; console.log('✗ ' + label + ' got ' + JSON.stringify(r)); }
  }
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
  eqq('Luma: "How did you discover us?" is how he heard', at('How did you discover us?'), 'LinkedIn');
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
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);