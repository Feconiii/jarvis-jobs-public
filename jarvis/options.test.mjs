// jarvis/options.test.mjs — golden tests for chooseOption (jarvis/apply/_form.mjs).
//
// chooseOption is the single place that knows how differently each ATS words the
// same choice. Every case below is a REAL option list observed on a live
// application form, and every one of them was a bug first:
//
//   - KLA words a bachelor's as "Bachelors of Arts or Science (Bachelors)";
//     Greenhouse says "Bachelor's Degree". Neither matches "Bachelor of Science".
//   - Greenhouse's country list is "United States +1" (a phone-code list).
//   - Workday wants "I am not a Veteran."; Greenhouse wants "I am not a
//     protected veteran". A profile value can only match one of them.
//   - The AI-screening consent is worded as an opt-OUT. A loose text match on
//     "Yes" once selected "No, I opt-out" on a live form — the exact opposite of
//     the user's instruction, reported as filled. The polarity cases below are
//     the regression guard for that, and are the most important ones here:
//     a wrong answer that reports as correct is worse than a blank field.

import { chooseOption, polarityOf, moneyRangeIndex } from './apply/_form.mjs';

let pass = 0, fail = 0;
const t = (name, want, options, expect) => {
  const got = chooseOption(want, options);
  if (got === expect) { pass++; return; }
  fail++;
  console.log(`✗ ${name}\n    want=${JSON.stringify(want)} expected ${expect} got ${got} (${JSON.stringify(options[got])})`);
};

// ── a first-person acknowledgement is a yes (Anthropic, F-349) ─────
t('the one option is "I will read the agreement"', 'Yes', ['I will read the arbitration agreement below.'], 0);
t('"I understand and agree to the terms"', 'Yes', ['I understand and agree to the terms of the Agreement to Arbitrate set forth above.'], 0);
t('"I acknowledge" beside a decline', 'Yes', ['I do not agree', 'I acknowledge and accept'], 1);
t('"I disagree" is not a yes', 'Yes', ['I disagree with the terms'], -1);
t('a No answer never takes the acknowledgement', 'No', ['I will read the arbitration agreement below.'], -1);

// ── degree wording, across vendors ──────────────────────────────────
t('greenhouse bachelor', 'Bachelor of Science', ["Bachelor's Degree", "Master's Degree"], 0);
t('kla bachelor', 'Bachelor of Science',
  ['Select One', 'High School', 'Associates of Arts or Science (Associates)',
    'Bachelors of Arts or Science (Bachelors)', 'Masters of Arts or Science'], 3);
// Never cross degree levels: "Masters of Arts or Science" also contains "science".
t('master does not match bachelor', 'Master of Science',
  ['Bachelors of Arts or Science', 'Masters of Technology (Masters)'], 1);
t('bachelor does not take masters', 'Bachelor of Science',
  ['Masters of Arts or Science or Business Administration'], -1);

// ── country / phone-code lists ──────────────────────────────────────
t('country with dial code', 'United States of America',
  ['United States +1', 'United Arab Emirates +971', 'United Kingdom +44'], 0);
t('dial code only', 'United States of America (+1)', ['+44', '+1'], 1);

// ── veteran status ──────────────────────────────────────────────────
t('not a veteran, greenhouse wording', 'I am not a Veteran.',
  ['I am not a protected veteran',
    'I identify as one or more of the classifications of a protected veteran',
    "I don't wish to answer"], 0);

// Lam (Eightfold), measured 2026-09-04: "Veteran" offers a bare list, and the
// consent is a choice of SCOPE with no yes in it. Both came back "nothing
// matched" on a real application.
t('lam veteran: a negated first-person claim is No', 'I am not a Veteran.', ['Choose not to disclose', 'No', 'Yes'], 1);
t('lam veteran: an un-negated claim is Yes', 'I am a veteran', ['Choose not to disclose', 'No', 'Yes'], 2);
// HP (Workday), F-618: an option that says he IS a veteran is never "not a veteran".
const HP_VETS = ['I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN', 'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE', 'I DO NOT WISH TO SELF-IDENTIFY'];
t('hp veteran: no honest option is no match, not a veteran claim', 'I am not a Veteran.', HP_VETS, -1);
t('hp veteran: the honest option is taken when it is there', 'I am not a Veteran.', [...HP_VETS, 'I am not a Veteran.'], 3);
t('hp veteran: a bare No claims nothing', 'No', HP_VETS, -1);
t('a first-person claim still prefers the option that says it', 'I am not a Veteran.',
  ['I am not a protected veteran', 'I am a disabled veteran', 'Yes', 'No'], 0);
t('lam consent: Yes is the widest scope', 'Yes',
  ['Recruiters can contact me for ANY open position at Lam research. I can opt-out any time.', 'Recruiters can contact me for ONLY the roles I apply to.'], 0);
t('lam consent: No is the narrowest scope', 'No',
  ['Recruiters can contact me for ANY open position at Lam research. I can opt-out any time.', 'Recruiters can contact me for ONLY the roles I apply to.'], 1);
t('a scope rule never decides a menu of other things', 'Yes', ['Contact me by any phone', 'Onsite only', 'Remote'], -1);

// polarityOf — what an answer expresses, for the planner's already-set check.
for (const [want, expect] of [['Yes', 'yes'], ['No, I opt-out', 'no'], ['I am not a Veteran.', 'no'], ['I am a veteran', 'yes'],
  ['I do not have a disability', 'no'], ['Mechanical Engineering', null], ['Open', null], ['I identify as a protected veteran', 'yes']]) {
  const got = polarityOf(want);
  if (got === expect) pass++; else { fail++; console.log(`✗ polarityOf(${JSON.stringify(want)}) expected ${expect} got ${got}`); }
}

// ── POLARITY: the consent regression ────────────────────────────────
t('yes picks the consent option', 'Yes',
  ['Select One', 'Yes, I consent to the use of artificial intelligence.', 'No, I opt-out'], 1);
t('yes REFUSES an opt-out-only list', 'Yes', ['No, I opt-out'], -1);
t('no picks the opt-out', 'No', ['Select One', 'Yes, I consent', 'No, I opt-out'], 2);
t('yes refuses decline', 'Yes', ['I decline to answer', 'Do not contact me'], -1);

// ── misc real lists ─────────────────────────────────────────────────
t('mobile means cellular', 'Mobile', ['Home', 'Cellular', 'Work'], 1);
t('none of the above', 'None of the above', ['None of the above', 'Yes'], 0);
t('exact match still wins', 'Male', ['Male', 'Female', 'Decline to self identify'], 0);
t('no match stays -1', 'Mechanical Engineering', ['Accounting', 'Anthropology'], -1);
t('gender identity says Man', 'Male', ['Man', 'Non-binary', 'Woman', "I don't wish to answer"], 0);
t('gender identity says Woman', 'Female', ['Man', 'Non-binary', 'Woman'], 2);
t('city with full state name', 'Springfield, Washington',
  ['Springfield, Washington, United States', 'Springfield Valley, Washington, United States',
    'Springfield, Missouri, United States'], 0);
t('disability answer maps to No', 'No, I do not have a disability and have not had one in the past',
  ['Yes', 'No', 'I prefer to self-describe', "I don't wish to answer"], 1);

// "City, XX" against a dropdown that spells the state out. Found in a prepared
// Formic application: "Springfield, WA" missed a list whose only entry was
// "Springfield, Washington, United States", so an answerable field became manual
// work. Austin, TX is one of his own preferred hubs and missed the same way.
t('city + state code matches the spelled-out option', 'Springfield, WA',
  ['Springfield, Washington, United States', 'Seattle, Washington, United States'], 0);
t('his own hub matches', 'Austin, TX',
  ['Dallas, Texas, United States', 'Austin, Texas, United States'], 1);
t('Puerto Rico is US soil and matches', 'Juncos, PR', ['Juncos, Puerto Rico'], 0);
// BOTH halves must match. City alone would put Portland, Oregon on Portland,
// Maine — a wrong answer that reports as filled is worse than a blank field.
t('same city, wrong state does not match', 'Portland, ME',
  ['Portland, Oregon, United States'], -1);
t('right state, wrong city does not match', 'Portland, OR',
  ['Portland, Maine, United States', 'Salem, Oregon, United States'], -1);

// == a longer option is not the same answer (Applied Materials, live) ==
//
// "United States" appears inside "United States Minor Outlying Islands", which
// sorts first in Applied Materials' country-code list. Taking the first
// containment hit put a wrong country on a real application and reported it as
// filled - the worst outcome the engine can produce, because a blank field at
// least announces itself. Exact wins; among loose matches, shortest wins.
t('exact country beats the longer one that contains it', 'United States',
  ['United States Minor Outlying Islands', 'United States'], 1);
t('AMAT country-code list, as observed', 'United States',
  ["🇺🇲 (+1) United States Minor Outlying Islands",
   "🇺🇸 (+1) United States of America"], 1);
t('shortest loose match wins when there is no exact one', 'Korea',
  ["Korea, Democratic People's Republic of", "Korea, Republic of", "Korea"], 2);

// == declining to answer, however the form words it ==
// Both observed on the same live Applied Materials form, both reported as
// unanswerable while the right option sat in the list.
t('decline vs "do not wish to self-identify"', 'I decline to self-identify',
  ['I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERANS LISTED ABOVE',
   'I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN', 'I AM NOT A VETERAN',
   'I DO NOT WISH TO SELF-IDENTIFY'], 3);
t('do-not-want vs curly-apostrophe "Don’t Wish To Answer"', 'I do not want to answer',
  ['Yes, I Have A Disability, Or Have A History/Record Of Having A Disability',
   "No, I Don't Have A Disability, Or A History/Record Of Having A Disability",
   'I Don’t Wish To Answer'], 2);
t('prefer not to say', 'Prefer not to say', ['Male', 'Female', 'I prefer not to disclose'], 2);
// A decline answer must never land on a substantive option.
t('decline does not pick an affirmative', 'I decline to self-identify',
  ['I IDENTIFY AS A PROTECTED VETERAN', 'I AM NOT A VETERAN'], -1);

// == "Company website" vs the employer's own name for it ==
t('company website matches the employer wording', 'Company website',
  ['Applied Materials Corporate Website', 'I currently work at/for Applied Materials',
   'Job Board or Social Media', 'Job Fair or Recruiting Event', 'Staffing Agency'], 0);
t('website answer never lands on a job board', 'Company website',
  ['Job Board or Social Media', 'Staffing Agency'], -1);

// == "Open" and "No preference" are the same answer ==
// His profile says remote_or_onsite: Open. Neuralink asks which onsite location
// he wants and offers Austin | South San Francisco | No preference - a question
// his answer covers exactly, reported as unanswerable.
t('open matches no-preference', 'Open',
  ['Austin', 'South San Francisco', 'No preference'], 2);
t('any matches no-preference', 'Any', ['Austin', 'No preference'], 1);
// Narrow on BOTH sides: only a whole-word answer, only onto an option that says
// the same thing. A location list with no such option must stay unanswered
// rather than pick a city for him.
t('open does not invent a city', 'Open', ['Austin', 'South San Francisco'], -1);
t('a longer answer does not reach the rule', 'Open to relocation',
  ['Austin', 'No preference'], -1);
// The realistic negative: a work-model list with no "no preference" option must
// stay unanswered rather than have a mode picked for him.
t('open does not pick a work model for him', 'Open', ['Onsite', 'Remote', 'Hybrid'], -1);
// An exact option still beats the synonym.
t('an exact "Open" option wins', 'Open', ['Open', 'No preference'], 0);


// ── Arts vs Science is a factual claim, not a tie-break ─────────────
//
// Measured: his answer "Bachelor's" against a list of exactly
// [Bachelor of Arts, Bachelor of Science] took the FIRST level match and put
// **Bachelor of Arts** on the form. cv.md says "Bachelor of Science: Mechanical
// Engineering". A wrong degree is a lie a recruiter reads; a blank is not.
t('generic answer never guesses Arts', "Bachelor's", ['Bachelor of Arts', 'Bachelor of Science'], -1);
t('generic answer never guesses when only Arts is offered', "Bachelor's", ['Bachelor of Arts', 'Master of Arts'], -1);
t('a generic option is preferred over any specialisation', "Bachelor's",
  ['Bachelor of Arts', 'Bachelor of Science', "Bachelor's Degree"], 2);
t('the full degree picks its own specialisation', 'Bachelor of Science',
  ['Bachelor of Arts', 'Bachelor of Science'], 1);
t('and never the other one', 'Bachelor of Science', ['Bachelor of Arts', 'Master of Arts'], -1);

// "Arts or Science" names both, so it commits to neither — a generic option
// with a long name. Reading it as "Arts" refused a question it answers exactly.
t('an option naming BOTH is generic', "Bachelor's",
  ['Select One', 'High School', 'Associates of Arts or Science (Associates)',
    'Bachelors of Arts or Science (Bachelors)', 'Masters of Arts or Science'], 3);

// Normalisation turns "B.S." into "b s", which matched no level at all, so a
// list written in abbreviations came back entirely unanswerable.
t('abbreviated degrees match their level', 'Bachelor of Science', ['B.A.', 'B.S.', 'M.S.'], 1);
t('and abbreviations do not cross specialisation', 'Bachelor of Science', ['B.A.', 'M.A.'], -1);
t('abbreviations do not cross LEVEL either', 'Bachelor of Science', ['M.S.', 'M.A.'], -1);


// -- US states, in whichever direction the form writes them ---------
//
// Measured against his real profile: `state: "Washington"` against a dropdown
// offering [AL, AK, AZ, CA, WA, WY] matched nothing, so a required address
// field was left blank on every form that abbreviates.
t('full name finds the abbreviation', 'Washington', ['AL', 'AK', 'AZ', 'CA', 'WA', 'WY'], 4);
t('abbreviation finds the full name', 'WA', ['Alabama', 'Alaska', 'Washington', 'Wyoming'], 2);
t('an exact match still wins', 'Washington', ['Alabama', 'Washington', 'Wyoming'], 1);
t('two-word states work', 'New York', ['NY', 'NJ', 'CA'], 0);
t('and back', 'NJ', ['New York', 'New Jersey'], 1);

// The trap. IN, OR, ME, OK, HI and DE are ordinary English words, so a state
// code may only ever be matched EXACTLY -- never by containment, or a sentence
// mentioning a state would post an address in Indiana.
t('a sentence containing a state name matches no code', 'I work in Oregon', ['IN', 'OR', 'ME'], -1);
t('Maine is still Maine', 'Maine', ['ME', 'MA'], 0);
t('Delaware is not DC', 'Delaware', ['DE', 'DC'], 0);
t('Indiana is not Iowa', 'Indiana', ['IA', 'IN'], 1);

// -- a dial code in parentheses ------------------------------------
//
// Every phone-code dropdown in this deck writes "(+1)", and the suffix stripper
// required the code to be the last characters on the line -- so the
// parenthesised form was never stripped and his country matched nothing.
t('a parenthesised dial code is stripped', 'United States of America',
  ['Anguilla (+1)', 'United States of America (+1)', 'Vietnam (+84)'], 1);
t('a bare trailing dial code still works', 'United States', ['Canada +1', 'United States +1'], 1);


// -- an "only" option is an exclusive claim ------------------------
//
// Measured on a live Veeva form: "Are you willing to work in office or a remote
// only role?" offers [Remote only, Office-based position]. His profile says
// "Open to on-site, hybrid, or remote", which matched neither, so a REQUIRED
// field went blank. "Remote only" is FALSE for him -- it says he will not come
// in. "Office-based position" is true, because he is willing to.
t('openness strikes out the exclusive option', 'Open to on-site, hybrid, or remote',
  ['Remote only', 'Office-based position'], 1);
t('two survivors is his choice, not ours', 'Open to on-site, hybrid, or remote',
  ['Remote only', 'Hybrid', 'On-site'], -1);
t('an exact match still wins over the rule', 'Open to on-site, hybrid, or remote',
  ['Remote only', 'Open to on-site, hybrid, or remote'], 1);
t('a non-open answer is untouched by it', 'Remote only',
  ['Remote only', 'Office-based position'], 0);

// -- a placeholder is never an answer --------------------------------
//
// TSMC's SuccessFactors menus open on "No Selection"; "No" chose it
// (2026-09-24), so the question stayed empty.
t('"No" is not "No Selection"', 'No', ['No Selection', 'No', 'Yes'], 1);
t('"Yes" still finds Yes', 'Yes', ['No Selection', 'No', 'Yes'], 2);
t('a placeholder alone matches nothing', 'No', ['Select...'], -1);

// -- a place, "City, State", against abbreviated rows ---------------
//
// Measured 2026-09-24 on SmartRecruiters (Western Digital): Office location and
// School location offered "Springfield, WA, US" and nothing matched "Springfield,
// Washington", so both were left with the right row on screen.
t('a spelled state matches its code', 'Springfield, Washington',
  ['Cannot find your city?', 'Springfield, WA, US'], 1);
t('another state, same shape', 'Austin, Texas', ['Austin, TX, US'], 0);
t('the city must agree, not just start alike', 'Springfield, Washington',
  ['Springfield Valley, WA, US'], -1);
t('the state must agree', 'Portland, Oregon',
  ['Portland, ME, US', 'Portland, OR, US'], 1);

// Numeric BANDS ("3.3- 4.0", "6+ years") are not matched here — chooseOption
// matches text, and a band list has no text to match. `chooseBand` in
// jarvis/apply-plan.mjs owns that and is tested beside it.

// AN AMOUNT AGAINST RANGES — Phoenix Tailings' Lever radio, 2026-09-25.
{
  const phx = ['$50, 000 - $100, 000', '$100, 000 - $150, 000', '$150, 000 - $200, 000'];
  t('salary range: $90000/year is in 50–100k', '$90000/year', phx, 0);
  t('salary range: a shared boundary takes the lower range', '$100,000', phx, 0);
  t('salary range: 120k', '120k', phx, 1);
  t('salary range: "Under" and "+" ends', '$55,000', ['Under $60,000', '$60,000 - $80,000', '$100,000+'], 0);
  t('salary range: open top', '$130,000', ['Under $60,000', '$60,000 - $80,000', '$100,000+'], 2);
  const guard = (name, got) => { if (got === -1) pass++; else { fail++; console.log(`✗ ${name}: took the money path (${got})`); } };
  guard('a GPA never takes the money path', moneyRangeIndex('3.85', ['3.0 - 3.5', '3.5 - 4.0']));
  guard('years never take the money path', moneyRangeIndex('2 years', ['0-1', '1-3', '3-5']));
  guard('a phone number is two amounts, never a salary', moneyRangeIndex('555-010-0000', ['$50,000 - $100,000', '$100,000 - $150,000']));
}

// ── the same words in another order (HP's field of study, 2026-09-26) ─
t('"Engineering, Mechanical" over "Mechanical Engineering Technology"', 'Mechanical Engineering', ['Engineering, Mechanical', 'Engineering, Electrical', 'Mechanical Engineering Technology'], 0);
t('"Engineering - Mechanical" is found at all', 'Mechanical Engineering', ['Engineering - Civil', 'Engineering - Mechanical'], 1);
t('the exact option still wins first', 'Mechanical Engineering', ['Engineering, Mechanical', 'Mechanical Engineering'], 1);
t('one word takes no reordering path', 'Engineering', ['Engineering', 'Physics'], 0);

// THE KIND OF THE ANSWER, WHEN THE LIST NAMES KINDS (2026-10-03).
t('a yearly figure is "Salary" (Plug Power)', '$90000/year', ['Hourly', 'Salary'], 1);
t('a yearly figure is "Yearly" (Paylocity)', '$90000/year', ['--', 'Hourly', 'Yearly'], 2);
t('an hourly figure is "Hourly"', '$28/hour', ['Hourly', 'Salary'], 0);
t('an email address is "Email"', 'jane.doe@example.com', ['Email', 'Phone', 'Text'], 0);
t('a phone number is "Phone"', '555-010-0199', ['Email', 'Phone', 'Text'], 1);
t('a link is "Website"', 'https://alexrivera.example', ['LinkedIn', 'Website', 'Other'], 1);
t('a kind is never forced on a list that names none', '$90000/year', ['Yes', 'No'], -1);
// A STREET ADDRESS IN THE POST OFFICE'S SPELLING (Optomec, F-691).
t('North/Street read as N/St, the row without an apartment first', '123 North Main Street', ['123 N Main St, Apt (61), Springfield, WA 12345', '123 N Main St, Springfield, WA 12345', '123 W Main St, Pasco, WA 99301'], 1);
t('a different street number is not the address', '123 North Main Street', ['1 N Browne St, Springfield, WA 99201'], -1);

// F-810: Oracle Recruiting Cloud's City lookup rows are "City, County, ST"
// (First Solar, 2026-10-16). "Springfield" chose "Cheney, Springfield, WA".
const ORACLE_CITY = ['Springfield, Springfield, WA', 'Airway Heights, Springfield, WA', 'Chattaroy, Springfield, WA', 'Cheney, Springfield, WA', 'City Of Springfield Valley, Springfield, WA'];
t('F-810: a bare city is the row that starts with it, not one in its county', 'Springfield', ORACLE_CITY, 0);
t('F-810: "City, State" against "City, County, ST"', 'Springfield, Washington', ORACLE_CITY, 0);
t('F-810: another city in the same county is still its own row', 'Cheney', ORACLE_CITY, 3);
t('F-810: a yes is never read as a place', 'No', ['Yes, I will require sponsorship', 'No, I will not'], 1);
t('F-810: Oracle\'s state list is codes', 'Washington', ['WA', 'AK', 'AL', 'AR', 'AS', 'AZ', 'CA', 'CO'], 0);
// F-883: Oceaneering's City list put "Springfield Valley" above "Springfield".
t('F-883: Springfield is not Springfield Valley', 'Springfield', ['Springfield Valley, Springfield, WA', 'Springfield, Springfield, WA'], 1);
t('F-883: …and Springfield Valley is not Springfield', 'Springfield Valley', ['Springfield, Springfield, WA', 'Springfield Valley, Springfield, WA'], 1);
// F-886: a qualifier in front changes the thing (Ford's Oracle Education Level, 2026-10-23).
t('F-886: "Bachelor\'s" is not "Post Bachelor\'s", even alone', "Bachelor's", ["Post Bachelor's or equivalent"], -1);
t('F-886: …and takes the plain row when both are there', "Bachelor's", ["Post Bachelor's or equivalent", "Bachelor's or equivalent"], 1);
t('F-886: a "Non-…" answer still takes its "Non-…" row', 'Non-Hispanic or Latino', ['Hispanic or Latino', 'Non-Hispanic or Latino'], 1);
t('F-886: a pay band "Under $60,000" is not a qualifier', '$55,000', ['Under $60,000', '$60,000 - $80,000'], 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
