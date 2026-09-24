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
  const got = r.kind === 'answer' ? r.value : r.kind;
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
is('Where did you hear about Hadrian?', 'Job Board', 'Ashby says "Where", not "How"');
is('How did you find out about this opportunity?', 'Job Board');
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
is("Do you have the unrestricted right to work in the United States?", "Yes");
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
  'Job Board', 'an adverb between "you" and "hear" must not break the match');


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
// dropdown — came back **"State University"**, because the school-NAME rule
// matches any label with "school" in it and sits above the campus rules. Same
// shape as the `opt` and bare `/major/` bugs already recorded in this file.
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
is('Profile Link Type', 'Portfolio', 'the type dropdown gets a type, not a URL');
is('Type of profile', 'Portfolio');
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
is('GitHub', 'https://example-portfolio.test');
is('GitHub URL', 'https://example-portfolio.test');
is('Link to your repository', 'https://example-portfolio.test');

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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);