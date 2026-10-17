/**
 * The plan is what the extension executes without thinking, so a wrong decision
 * here reaches a real employer's form with nothing between it and Submit except
 * him noticing. These pin the decisions that cost the most when they go wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planField, planForm, decide, RESUME_FIELD_RE, MAX_MULTI, EXPECTED_EXTENSION, extensionIsStale, chooseBand, chooseDelay, chooseResidence, formatForType, planEntries,
} from './apply-plan.mjs';
import { chooseOption } from './apply/_form.mjs';

const PROFILE = {
  identity: {
    first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera',
    email: 'v@example.test', phone: '+1 (555) 000-0000',
    location: 'Springfield, Washington', country: 'United States', state: 'Washington',
  },
  education: { school: 'Lakeside University', discipline: 'Mechanical Engineering' },
  answers: { authorized_to_work_us: 'Yes', requires_sponsorship: 'Yes' },
  work_experience: [{ company: 'Applied Materials', title: 'Engineering Intern' }],
};

const field = (o) => ({ type: 'text', options: [], ...o });

// A profile carrying the two facts the conditional follow-ups below ask for.
// Built here rather than loaded from disk: his real apply-profile.yml is
// gitignored and may change, and a test that depends on it is a test that
// breaks for reasons that have nothing to do with the code.
const COND_PROFILE = {
  ...PROFILE,
  education: { ...PROFILE.education, gpa: '3.85' },
  answers: { ...PROFILE.answers, earliest_start: 'June 2027 (graduating May 2027)' },
};


test('a plain question is filled from the profile', () => {
  const a = planField(field({ label: 'First Name' }), PROFILE);
  assert.equal(a.action, 'fill');
  assert.equal(a.value, 'Alex');
});

test('an unknown question is left blank and reported, never guessed', () => {
  const a = planField(field({ label: 'What is your favourite alloy?' }), PROFILE);
  assert.equal(a.action, 'unknown');
  assert.equal(a.value, undefined, 'an unknown question must carry no value at all');
});

test('a consent box is ticked — his standing instruction', () => {
  for (const label of [
    'I certify that the information provided is accurate',
    'I agree to the Terms and Conditions',
    'I consent to the use of artificial intelligence in screening',
    'I acknowledge the Privacy Policy',
  ]) {
    const a = planField(field({ label, type: 'checkbox' }), PROFILE);
    assert.equal(a.action, 'check', `"${label}" must be ticked`);
  }
});

test('a consent box is decided BEFORE the answer table sees it', () => {
  // "I certify…" is not a question the profile can answer. If the consent test
  // ran second it would fall through to unknown and be left blank, which voids
  // the application more quietly than a wrong answer would.
  const a = planField(field({ label: 'I certify the accuracy of this application', type: 'checkbox' }), PROFILE);
  assert.notEqual(a.action, 'unknown');
});

test('a select picks a real option, not the intended string', () => {
  const a = planField(field({
    label: 'Are you legally authorized to work in the United States?',
    type: 'select',
    options: ['Select one', 'Yes', 'No'],
  }), PROFILE);
  assert.equal(a.action, 'select');
  assert.equal(a.optionIndex, 1);
  assert.equal(a.value, 'Yes');
  assert.equal(a.review, true, 'work authorisation is always review-flagged');
});

test('a select with no matching option says so instead of picking something', () => {
  const a = planField(field({
    label: 'Are you legally authorized to work in the United States?',
    type: 'select',
    options: ['Maybe', 'Ask me later'],
  }), PROFILE);
  assert.equal(a.action, 'unknown');
  assert.match(a.why, /no option matches/);
});

test('the resume file input is recognised; another upload is not', () => {
  assert.equal(planField(field({ label: 'Resume/CV', type: 'file' }), PROFILE).action, 'upload');
  assert.equal(planField(field({ label: 'Attach your resume', type: 'file' }), PROFILE).action, 'upload');
  const other = planField(field({ label: 'Portfolio (PDF)', type: 'file' }), PROFILE);
  assert.equal(other.action, 'unknown', 'the engine must not put his resume in a portfolio slot');
  // The parse slot is a decision, not a question left for him (F-359).
  const parse = planField(field({ label: 'Easy Apply — Choose a file or drop it here', type: 'file' }), PROFILE);
  assert.equal(parse.action, 'skip', 'the Easy Apply parse slot is skipped on purpose');
  assert.match(parse.why, /parse-a-resume slot/);
  assert.equal(planField(field({ label: 'Autofill with Resume', type: 'file' }), PROFILE).action, 'skip');
  assert.ok(RESUME_FIELD_RE.test('Resume'));
});

test('an unlabelled file input is treated as the resume', () => {
  // Workday and several Eightfold tenants render the resume input with no
  // associated label at all; refusing it there would mean never attaching.
  assert.equal(planField(field({ label: '', type: 'file' }), PROFILE).action, 'upload');
});

test('the never-fill list is skipped by policy, not left as unknown', () => {
  for (const label of ['Date of Birth', 'Social Security Number', 'Signature', 'Pronouns']) {
    const a = planField(field({ label }), PROFILE);
    assert.equal(a.action, 'skip', `"${label}" must be skipped by policy`);
    assert.match(a.why, /policy/);
  }
});

test('EEO questions are answered from the eeo block and review-flagged', () => {
  const withEeo = { ...PROFILE, eeo: { gender: 'Male', race: 'Asian', veteran: 'I am not a protected veteran', disability: 'No' } };
  const a = planField(field({
    label: 'Please select your racial/ethnic background',
    type: 'select',
    options: ['Select', 'Asian', 'White', 'Decline to answer'],
  }), withEeo);
  assert.equal(a.action, 'select');
  assert.equal(a.value, 'Asian');
  assert.equal(a.review, true, 'EEO answers are always shown back to him');
});

test('an EEO question with no answer in the profile is left blank, not guessed', () => {
  const a = planField(field({ label: 'Please select your gender', type: 'select', options: ['Male', 'Female'] }), PROFILE);
  assert.equal(a.action, 'unknown', 'the engine has no business inventing this one');
});

test('NO plan may contain a submit action', () => {
  const plan = planForm([
    field({ label: 'First Name' }),
    field({ label: 'Submit Application', type: 'checkbox' }),
    field({ label: 'I agree to the Terms and Conditions', type: 'checkbox' }),
  ], PROFILE);
  assert.equal(plan.submit, false);
  for (const a of plan.actions) {
    assert.ok(!/submit/i.test(a.action), 'no action may be a submit');
  }
  assert.match(plan.submitNote, /Submit nothing/);
});

test('the plan counts what it did and lists what it could not answer', () => {
  const plan = planForm([
    field({ label: 'First Name' }),
    field({ label: 'Last Name' }),
    field({ label: 'Resume', type: 'file' }),
    field({ label: 'I agree to the Terms', type: 'checkbox' }),
    field({ label: 'Describe your ideal Tuesday' }),
  ], PROFILE);
  assert.equal(plan.summary.fill, 2);
  assert.equal(plan.summary.upload, 1);
  assert.equal(plan.summary.check, 1);
  assert.equal(plan.summary.unknown, 1);
  assert.deepEqual(plan.unanswered.map((u) => u.label), ['Describe your ideal Tuesday']);
});

test('the form title matches the resume that is about to be attached', () => {
  const plan = planForm([field({ label: 'First Name' })], PROFILE, { familyKey: 'automation' });
  assert.ok(Array.isArray(plan.titleChanges));
  if (plan.titleChanges.length) {
    assert.equal(plan.titleChanges[0].company, 'Applied Materials');
    assert.notEqual(plan.titleChanges[0].to, plan.titleChanges[0].from);
  }
});

test('an empty form plans to nothing rather than throwing', () => {
  const plan = planForm([], PROFILE);
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.summary.fill, 0);
  assert.equal(planForm(null, PROFILE).actions.length, 0);
});

test('Lever\'s wording for work authorisation is answered', () => {
  // Measured on a live Veeva form: the sponsorship question beside this one was
  // answered and this was not, leaving an application that declares it needs
  // sponsorship and says nothing about being allowed to work.
  const a = planField(field({
    label: 'Do you have the unrestricted right to work in the United States? — Yes',
    type: 'radio',
    options: ['Yes', 'No'],
  }), { ...PROFILE, answers: { ...PROFILE.answers, require_sponsorship: 'Yes' } });
  assert.equal(a.action, 'select');
  // UNRESTRICTED is a condition he does not meet on F-1 (2026-09-24): answered,
  // and answered No.
  assert.equal(a.value, 'No');
});

test('a checkbox GROUP is a multiple choice, not a yes/no', () => {
  // Two checkboxes for one question. Read as binary, his answer was not "yes"
  // and the question was left blank.
  const p = { ...PROFILE, answers: { ...PROFILE.answers, work_arrangement: 'Remote only' } };
  const a = planField(field({
    label: 'Are you willing to work in office or a remote only role?',
    type: 'checkbox',
    options: ['Remote only', 'Office-based position'],
  }), { ...p, never_fill: [] });
  assert.notEqual(a.action, 'skip', 'a multi-option question must not be decided as a yes/no');
});

test('a lone consent checkbox is still ticked, not option-matched', () => {
  const a = planField(field({ label: 'I agree to the Terms and Conditions', type: 'checkbox', options: ['I agree to the Terms and Conditions'] }), PROFILE);
  assert.equal(a.action, 'check');
});

// --- what a live Workday application taught, the hard way ------------------

const WD = { ...PROFILE, identity: { ...PROFILE.identity, address_line1: '1 Test Street', city: 'Testville', postal_code: '00000' } };
const wd = (key, o = {}) => ({ type: 'text', options: [], key, label: '', ...o });

test('Workday is answered by its stable key, not by a label it does not have', () => {
  // Measured live: every Workday input came back with no usable label, name or
  // automation-id of its own. Only the wrapping formField-* id identifies it.
  assert.equal(planField(wd('formField-legalName--firstName'), WD).value, 'Alex');
  assert.equal(planField(wd('formField-addressLine1'), WD).value, '1 Test Street');
  assert.equal(planField(wd('formField-postalCode'), WD).value, '00000');
});

test('the three phone fields get three DIFFERENT answers', () => {
  // The label matcher gave all three the phone NUMBER, because "Country Phone
  // Code" and "Phone Device Type" both contain the word "phone".
  const number = planField(wd('formField-phoneNumber', { label: 'Phone Number' }), WD);
  const code = planField(wd('formField-countryPhoneCode', { label: 'Country Phone Code' }), WD);
  const kind = planField(wd('formField-phoneType', { label: 'Phone Device Type' }), WD);
  assert.equal(number.value, '5550000000', 'the number goes in digits-only, leading 1 stripped');
  assert.match(code.value, /\+1/);
  assert.equal(kind.value, 'Mobile');
  assert.equal(new Set([number.value, code.value, kind.value]).size, 3, 'three questions, three answers');
});

test('WORKDAY MY EXPERIENCE: the page reports sections, the plan answers with entries from the profile', () => {
  const profile = {
    ...PROFILE,
    work_experience: [
      { title: 'Manufacturing Engineer Intern', company: 'Acme Fab', location: 'Austin, TX', start: 'May 2026', end: 'August 2026', description: 'Built fixtures.' },
      { title: 'Manufacturing Lead', company: 'Test University', location: 'Springfield, WA', start: 'August 2024', description: 'Ran the shop.' },
    ],
    education_entries: [{ school: 'Test University', degree: 'Bachelor of Science', field_of_study: 'Mechanical Engineering', gpa: '3.9', last_year: '2027' }],
  };
  const sections = [{ kind: 'work', label: 'Work Experience', count: 1, filled: false, blank: true, hasAdd: true }, { kind: 'education', label: 'Education', count: 0, filled: false, blank: false, hasAdd: true }];
  const plan = planForm([], profile, { sections });
  assert.equal(plan.entries.length, 2);
  const work = plan.entries.find((g) => g.kind === 'work');
  assert.equal(work.entries.length, 2);
  assert.equal(work.entries[0].company, 'Acme Fab');
  assert.deepEqual(work.entries[0].start, { month: 5, year: 2026 });
  assert.equal(work.entries[0].current, false, 'an ended internship is not current');
  assert.equal(work.entries[1].current, true, 'no end date means ongoing');
  assert.equal(work.entries[1].end, null, 'Workday hides the end date once "currently work here" is ticked');
  const edu = plan.entries.find((g) => g.kind === 'education');
  assert.equal(edu.entries[0].fieldOfStudy, 'Mechanical Engineering');
  assert.equal(edu.entries[0].lastYear, 2027);
  assert.equal(plan.actions.length, 0, 'no fields, no field actions');
  assert.equal(plan.submit, false);

  // A section that already holds a filled entry gets nothing — second pass,
  // resumed draft, or a tenant that parsed the resume.
  const again = planForm([], profile, { sections: [{ ...sections[0], filled: true }, sections[1]] });
  assert.deepEqual(again.entries.map((g) => g.kind), ['education']);
  // No sections reported (every other ATS) → no entries, and nothing else changes.
  assert.deepEqual(planForm([], profile).entries, []);
  // The resume's titles reach the entries too: the form says what the PDF says.
  const titled = planForm([], profile, { sections, titles: { 'Acme Fab': 'Robotics Engineer Intern' } });
  const t = titled.entries.find((g) => g.kind === 'work').entries[0].title;
  assert.ok(t === 'Robotics Engineer Intern' || t === 'Manufacturing Engineer Intern', 'titles apply when the company key matches the resume pool');
});

test('a Workday PROMPT that is already correct is left alone', () => {
  // Country/State/Phone-type render a button over an input holding an opaque id
  // like "bc33aa3152ec42d4995f4791a1". Typing prose over that id is what broke
  // the step with "Enter a valid format for Phone Number".
  const a = planField({ type: 'prompt', key: 'formField-phoneType', label: 'Phone Device Type', current: 'Mobile', options: [] }, WD);
  assert.equal(a.action, 'skip');
  assert.match(a.why, /already set/);
});

test('a bare yes/no already on the form is the answer when the profile value is a sentence', () => {
  // Lam (Eightfold), second press: Veteran held "No", chosen on pass 1 from
  // "I am not a Veteran."; pass 2 re-drove it and typed the sentence in.
  const profile = { identity: {}, answers: {}, eeo: { veteran: 'I am not a Veteran.', disability: 'No, I do not have a disability' } };
  const vet = planForm([{ label: 'Veteran', type: 'prompt', promptKind: 'combo', options: [], current: 'No' }], profile).actions[0];
  assert.equal(vet.action, 'skip');
  assert.match(vet.why, /already set/);
  const dis = planForm([{ label: 'Disability', type: 'prompt', promptKind: 'combo', options: [], current: 'No' }], profile).actions[0];
  assert.equal(dis.action, 'skip');
  // …but the OPPOSITE polarity is still corrected.
  const wrong = planForm([{ label: 'Veteran', type: 'prompt', promptKind: 'combo', options: [], current: 'Yes' }], profile).actions[0];
  assert.equal(wrong.action, 'prompt');
});

test('a prompt with the WRONG value is clicked, never typed into', () => {
  const a = planField({ type: 'prompt', key: 'formField-phoneType', label: 'Phone Device Type', current: 'Landline', options: [] }, WD);
  assert.equal(a.action, 'prompt', 'a prompt must never be filled as text');
  assert.equal(a.value, 'Mobile');
  assert.notEqual(a.action, 'fill');
});

test('an empty prompt we have no answer for is reported, not typed into', () => {
  const a = planField({ type: 'prompt', key: 'formField-somethingOdd', label: 'Preferred pronoun list', current: '', options: [] }, WD);
  assert.equal(a.action, 'unknown');
});

test('EVERY action carries the identity of its field', () => {
  // Position is not identity. On a live form an action list one item longer
  // than the field list shifted everything after it and typed "Washington" into
  // the phone-code prompt.
  const plan = planForm([
    wd('formField-legalName--firstName', { name: 'legalName--firstName', id: 'a' }),
    wd('formField-city', { name: 'city', id: 'b' }),
  ], WD);
  plan.actions.forEach((a, i) => {
    assert.equal(a.at, i, 'the original position is kept as a last resort');
    assert.ok(a.key, 'and the key is what should actually be matched on');
  });
  assert.equal(plan.actions[0].key, 'formField-legalName--firstName');
  assert.equal(plan.actions[1].key, 'formField-city');
});

test('"How Did You Hear About Us?" offers alternatives, and one the form HAS', () => {
  // Every tenant words this list differently, so the resolver returns several
  // truthful answers in order of preference.
  const a = planField(wd('formField-source', { label: 'How Did You Hear About Us?', options: ['Select One', 'Job Board', 'Referral'] }), { ...WD, answers: {} });
  assert.equal(a.action, 'fill');
  // LinkedIn first (his rule, 2026-09-24); on a list without it, the matcher
  // knows LinkedIn is a job board, so the row chosen is "Job Board".
  assert.equal(a.value, 'LinkedIn');
  assert.equal(chooseOption(a.value, ['Select One', 'Job Board', 'Referral']), 1, 'the row the form actually offers');
});

test('"How Did You Hear About Us?" — LinkedIn, then the company site, then social media (his rule, 2026-09-24)', () => {
  const on = (options) => { const a = planField(wd('formField-source', { label: 'How Did You Hear About Us?', options }), { ...WD, answers: {} }); return options[chooseOption(a.value, options)]; };
  assert.equal(on(['Select One', 'Corporate Website', 'LinkedIn', 'Referral']), 'LinkedIn');
  assert.equal(on(['Select One', 'Company Career Site', 'Employee Referral', 'Career Fair']), 'Company Career Site');
  assert.equal(on(['Select One', 'Instagram', 'Employee Referral', 'Career Fair']), 'Instagram');
  const prompt = planField(wd('formField-source', { label: 'How Did You Hear About Us?', type: 'prompt' }), { ...WD, answers: {} });
  assert.equal((prompt.values || [prompt.value])[0], 'LinkedIn', 'a Workday prompt tries LinkedIn first');
});

test('the phone TYPE trap stays closed', () => {
  // A live Tesla form fed the phone NUMBER into a Mobile/Landline dropdown.
  const a = planField(field({ label: 'Contact Phone Type', type: 'select', options: ['Mobile', 'Landline'] }), PROFILE);
  assert.notEqual(a.value, PROFILE.identity.phone);
});

test('a resume is NOT attached on top of one already there', () => {
  // Resuming a Workday draft once stacked three copies of the same PDF on a
  // live application. A recruiter opening three identical resumes draws one
  // conclusion, and it is not a good one.
  const already = planField({ type: 'file', label: 'Resume/CV', attached: 1, options: [] }, PROFILE);
  assert.equal(already.action, 'skip');
  assert.match(already.why, /already attached/);
  const empty = planField({ type: 'file', label: 'Resume/CV', attached: 0, options: [] }, PROFILE);
  assert.equal(empty.action, 'upload');
});

test('a field the table deliberately leaves empty is a skip, not an unanswered question', () => {
  // Phone Extension resolves to null on purpose. Reporting it as unanswered put
  // noise in the one list he actually reads.
  const a = planField({ type: 'text', key: 'formField-extension', label: 'Phone Extension', options: [] }, PROFILE);
  assert.equal(a.action, 'skip');
  assert.match(a.why, /deliberately/);
});

test('a multi-select prompt gets ONE item at a time, not the whole list', () => {
  // Workday's "Type to Add Skills" was handed all thirty of his skills as a
  // single comma-separated search term. Nothing matches that, so none were
  // added — on the field that is pure ATS keyword value.
  const p = { ...PROFILE, answers: { ...PROFILE.answers, skills: 'SolidWorks, Autodesk Inventor, GD&T, CNC machining' } };
  const a = planField({ type: 'prompt', key: 'formField-skills', label: 'Type to Add Skills', promptKind: 'multi', current: '', options: [] }, p);
  assert.equal(a.action, 'prompt');
  assert.deepEqual(a.values, ['SolidWorks', 'Autodesk Inventor', 'GD&T', 'CNC machining']);
  assert.ok(!String(a.value).includes(','), 'no single search term may contain the whole list');
});

test('a multi-select is capped so the box does not read as machine-filled', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Skill ${i}`).join(', ');
  const p = { ...PROFILE, answers: { ...PROFILE.answers, skills: many } };
  const a = planField({ type: 'prompt', key: 'formField-skills', label: 'Type to Add Skills', promptKind: 'multi', current: '', options: [] }, p);
  assert.ok(a.values.length <= MAX_MULTI, `capped at ${MAX_MULTI}, got ${a.values.length}`);
});

test('a SINGLE prompt is never split, even if its value has a comma', () => {
  const a = planField({ type: 'prompt', key: 'formField-country', label: 'Country', promptKind: 'single', current: 'Canada', options: [] },
    { ...PROFILE, identity: { ...PROFILE.identity, country: 'Korea, Republic of' } });
  assert.equal(a.action, 'prompt');
  assert.equal(a.values, undefined, 'a country is one answer that happens to contain a comma');
  assert.equal(a.value, 'Korea, Republic of');
});

test('A CREDENTIAL FORM IS REFUSED ENTIRELY — not filled, not partially filled', () => {
  // Choosing "Apply Manually" on Workday while signed out lands on a Create
  // Account page carrying the same formField-* wrappers a real step does:
  // email, password, verifyPassword. The email rule would happily have filled
  // his address into an account signup.
  const plan = planForm([
    { label: 'Email', type: 'text', key: 'formField-email', options: [] },
    { label: 'Password', type: 'password', key: 'formField-password', options: [] },
    { label: 'Verify New Password', type: 'password', key: 'formField-verifyPassword', options: [] },
  ], PROFILE);
  assert.equal(plan.credentialForm, true);
  assert.deepEqual(plan.actions, [], 'not one field on a credential form may be touched');
  assert.equal(plan.summary.fill, 0);
  assert.match(plan.submitNote, /yours, not mine/);
});

test('a password field poisons the whole form, even beside real questions', () => {
  const plan = planForm([
    { label: 'First Name', type: 'text', options: [] },
    { label: 'Password', type: 'password', options: [] },
  ], PROFILE);
  assert.deepEqual(plan.actions, [], 'a real question next to a password field is still not filled');
});

test('a form with no password is planned normally', () => {
  const plan = planForm([{ label: 'First Name', type: 'text', options: [] }], PROFILE);
  assert.equal(plan.credentialForm, undefined);
  assert.equal(plan.summary.fill, 1);
});

/**
 * F-484. A ONE-TIME CODE IS A CREDENTIAL, AND IT IS IN HIS EMAIL.
 *
 * Read off his own Micron run, 2026-09-18: the record came back holding six
 * fields called "Please enter OTP character 1" … "6". They are typed `text`,
 * so the password guard walked past them, and a verification wall was reported
 * as six questions the engine could not answer. Nothing can answer them.
 */
test('A ONE-TIME CODE SCREEN IS REFUSED, and named as his to type', () => {
  const otp = Array.from({ length: 6 }, (_, i) => ({
    label: `Please enter OTP character ${i + 1}`, type: 'text', maxLength: 1, options: [],
  }));
  const plan = planForm(otp, PROFILE);
  assert.equal(plan.credentialForm, true);
  assert.deepEqual(plan.actions, [], 'not one box of a verification code is guessed at');
  assert.deepEqual(plan.unanswered, [], 'and it is not reported as six unanswered questions');
  assert.match(plan.submitNote, /one-time verification code/i);
});

test('the code is caught by its SHAPE too, however the tenant labels it', () => {
  // Several one-character boxes together is an OTP widget whatever the words
  // around it say — tenants label these every way there is.
  const boxes = Array.from({ length: 6 }, (_, i) => ({
    label: `Digit ${i + 1}`, type: 'tel', maxLength: 1, options: [],
  }));
  assert.equal(planForm(boxes, PROFILE).credentialForm, true);
  // …and by its words even when there is only one box.
  assert.equal(planForm([{ label: 'Verification code', type: 'text', options: [] }], PROFILE).credentialForm, true);
  assert.equal(planForm([{ label: 'Enter the 6-digit security code', type: 'text', options: [] }], PROFILE).credentialForm, true);
});

test('a single one-character box is NOT a verification code', () => {
  // "Middle Initial" is one character and is an ordinary question. Refusing a
  // whole application over it would be the expensive error.
  const plan = planForm([
    { label: 'Middle Initial', type: 'text', maxLength: 1, options: [] },
    { label: 'First Name', type: 'text', options: [] },
  ], PROFILE);
  assert.equal(plan.credentialForm, undefined, 'an ordinary short field does not poison the form');
  assert.ok(plan.summary.fill >= 1, 'and the form is still planned');
});

test('Greenhouse labels resume AND cover letter "Attach" — the id decides', () => {
  // Both inputs carry the same label. Matching on the label left both
  // unanswered; loosening it to accept "Attach" would have put his resume in
  // the cover-letter slot, which is worse than leaving it out.
  const resume = planField({ type: 'file', label: 'Attach', id: 'resume', options: [] }, PROFILE);
  const cover = planField({ type: 'file', label: 'Attach', id: 'cover_letter', options: [] }, PROFILE);
  assert.equal(resume.action, 'upload');
  // The cover-letter slot now gets the LETTER as a PDF (F-410) — it used to be
  // left for him. What has not changed, and is the point of the test, is that
  // the resume never goes into it: they are told apart by the identifier, and
  // the two actions are different actions.
  assert.equal(cover.action, 'upload-letter', 'the cover-letter slot gets the cover letter');
  assert.notEqual(cover.action, 'upload', 'his resume must never go in the cover-letter slot');
});

test('an identifier that says "not the resume" beats a label that says it is', () => {
  const a = planField({ type: 'file', label: 'Resume', id: 'cover_letter_upload', options: [] }, PROFILE);
  assert.equal(a.action, 'upload-letter', 'the identifier says cover letter, so the letter goes there');
  assert.notEqual(a.action, 'upload', 'and the resume does not');
  for (const id of ['portfolio', 'transcript', 'writing_sample', 'references']) {
    assert.equal(planField({ type: 'file', label: '', id, options: [] }, PROFILE).action, 'unknown', `${id} is not the resume`);
  }
});

test('a name attribute works as well as an id', () => {
  assert.equal(planField({ type: 'file', label: 'Attach', name: 'resume_file', options: [] }, PROFILE).action, 'upload');
  assert.equal(planField({ type: 'file', label: 'Attach', name: 'cover_letter', options: [] }, PROFILE).action, 'upload-letter');
});

test('ASHBY: two resume slots, only the real one gets the file', () => {
  // Ashby ships an optional "Autofill from resume" parser AND the required
  // attachment. Uploading to the parser makes Ashby read the PDF and write its
  // own guesses over the answers we are about to give — the same hazard as
  // Workday's autofill, which this engine declines on purpose.
  const plan = planForm([
    { type: 'file', label: 'Resume/CV', id: '', name: '', required: false,
      near: 'Autofill from resume Upload your resume here to autofill key fields', options: [] },
    { type: 'file', label: 'Resume', id: '_systemfield_resume', name: '', required: true,
      near: 'Resume Upload File or drag and drop here', options: [] },
  ], PROFILE);
  const uploads = plan.actions.filter((a) => a.action === 'upload');
  assert.equal(uploads.length, 1, 'exactly one slot gets the resume');
  assert.equal(uploads[0].id, '_systemfield_resume', 'the required attachment, not the parser');
  assert.match(plan.actions[0].why, /only one gets the file/);
});

test('required wins when neither slot says autofill', () => {
  const plan = planForm([
    { type: 'file', label: 'Resume', id: 'a', required: false, options: [] },
    { type: 'file', label: 'Resume', id: 'b', required: true, options: [] },
  ], PROFILE);
  const uploads = plan.actions.filter((a) => a.action === 'upload');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].id, 'b');
});

test('a single resume slot is untouched by the tie-break', () => {
  const plan = planForm([{ type: 'file', label: 'Resume', id: 'resume', options: [] }], PROFILE);
  assert.equal(plan.summary.upload, 1);
});

test('a STALE EXTENSION is called out, because it looks exactly like a bug', () => {
  // Chrome does not auto-update an unpacked extension. Every fix in this project
  // lands in the repo and stays invisible until he presses reload, so a stale
  // copy reproduces bugs that were fixed hours ago with nothing on screen to say
  // so. That was his exact position after every fix in this session.
  const stale = planForm([{ label: 'First Name', type: 'text', options: [] }], PROFILE, { extensionVersion: '1.0.0' });
  assert.match(stale.staleExtension, /Reload it at chrome:\/\/extensions/);
  assert.match(stale.staleExtension, /1\.0\.0/, 'it names the version he is actually running');

  const current = planForm([{ label: 'First Name', type: 'text', options: [] }], PROFILE, { extensionVersion: EXPECTED_EXTENSION });
  assert.equal(current.staleExtension, null);

  // Newer than expected (he pulled ahead) is not a warning.
  assert.equal(planForm([], PROFILE, { extensionVersion: '9.0.0' }).staleExtension, null);
  // No version at all — an old build that predates the check — says nothing
  // rather than crying wolf on every request.
  assert.equal(planForm([], PROFILE).staleExtension, null);
});

test('version comparison handles the shapes it will actually see', () => {
  assert.equal(extensionIsStale('1.0.0', '1.1.0'), true);
  assert.equal(extensionIsStale('1.1.0', '1.1.0'), false);
  assert.equal(extensionIsStale('1.2.0', '1.1.0'), false);
  assert.equal(extensionIsStale('1.10.0', '1.9.0'), false, '10 is not less than 9');
  assert.equal(extensionIsStale('1.1', '1.1.0'), false);
  assert.equal(extensionIsStale('nonsense', '1.1.0'), true, 'unparseable counts as older');
});

test('a GPA finds its BAND — no text match ever could', () => {
  // Measured on Veeva: 3.85 against ["3.7 - 4.0", ...] went unanswered because
  // chooseOption matches text and no band contains that string.
  const p = { ...PROFILE, education: { ...PROFILE.education, gpa: '3.85' } };
  const a = planField({
    label: 'Please provide your GPA', type: 'select',
    options: ['Select', '3.7 - 4.0', '3.3 - 3.69', '3.0 - 3.29', '2.7 - 2.99'],
  }, p);
  assert.equal(a.action, 'select');
  assert.equal(a.value, '3.7 - 4.0');
});

test('AMBIGUITY IS REFUSED — a boundary value is not ours to decide', () => {
  // "2 years" sits on the edge of both "0-2" and "2-5". Picking one would be
  // inventing a fact about his experience.
  assert.equal(chooseBand('2 years', ['0-2', '2-5', '5-7']), -1);
  assert.equal(chooseBand('3.85', ['3.7 - 4.0', '3.3 - 3.69']), 0, 'unambiguous is answered');
  assert.equal(chooseBand('1 year', ['0-2', '2-5']), 0, 'inside one band only');
});

test('open-ended bands are read the way they are written', () => {
  assert.equal(chooseBand('12', ['0-5', '6-9', '10+']), 2);
  assert.equal(chooseBand('12', ['0-5', '6-9', '10 or more']), 2);
  assert.equal(chooseBand('1', ['under 2 years', '2-5 years']), 0);
});

test('band matching never fires on things that are not bands', () => {
  assert.equal(chooseBand('Yes', ['Yes', 'No']), -1, 'no number, no band');
  assert.equal(chooseBand('3.85', ['Select one', 'Prefer not to say']), -1);
  assert.equal(chooseBand('3.85', ['Asian', 'White']), -1);
});

test('a text match still wins over a band match', () => {
  // "Yes"/"No" must never be decided numerically just because an option has a
  // digit in it somewhere.
  const a = planField({
    label: 'Are you legally authorized to work in the United States?',
    type: 'select', options: ['Select', 'Yes', 'No'],
  }, PROFILE);
  assert.equal(a.value, 'Yes');
});

test('a range hyphen is not a minus sign', () => {
  // The bug this pins: a leading `-?` swallowed the hyphen in "0-2", read the
  // band as 0 to -2, and put "1 year" in "2-5" instead — the opposite of true.
  assert.equal(chooseBand('1', ['0-2', '2-5']), 0);
  assert.equal(chooseBand('4', ['0-2', '2-5']), 1);
  assert.equal(chooseBand('7', ['0-2', '2-5']), -1, 'outside every band is not an answer');
  // A genuine negative still reads as one.
  assert.equal(chooseBand('-5', ['-10 to 0', '1 to 10']), 0);
});

// TSMC's SuccessFactors form (live 2026-09-19) asks for GPA as a REQUIRED radio
// group of three bands. Two things went wrong at once: the label resolved to
// nothing (`\bgpa\b` does not match the plural "GPAs"), and the bottom tier is
// written "<3.299" — a symbol this function did not know, so that option was
// skipped rather than read as a band.
// His portfolio is served at the BARE DOMAIN. 2026-09-19: "its only
// alexrivera.example no http or anything adding it will fuck it up and not
// bring up my portfolio". LinkedIn is the one URL that gets rewritten, because
// Workday rejects it without the www; nothing else may be touched.
test('a bare domain is written exactly as he gave it', () => {
  for (const type of ['url', 'text', undefined]) {
    assert.equal(formatForType('alexrivera.example', type).value, 'alexrivera.example');
  }
  // …and the LinkedIn rewrite still happens, or KLA rejects the field.
  assert.equal(formatForType('linkedin.com/in/someone', 'url').value, 'https://www.linkedin.com/in/someone');
});

test('a GPA band menu is answered from the GPA he already gave', () => {
  const TSMC = [
    'The GPAs of all my degree are between 3.3- 4.0',
    'The GPAs of all my degree are between 3.0- 3.299',
    'One of my degrees is <3.299',
  ];
  assert.equal(chooseBand('3.85', TSMC), 0, 'his GPA is in the top band');
  assert.equal(chooseBand('2.4', TSMC), 2, 'the bottom tier is reachable through "<"');
  // Tiered menus overlap on purpose: 3.1 is truthfully inside "3.0- 3.299" AND
  // inside "<3.299". The form means the tightest true statement.
  assert.equal(chooseBand('3.1', TSMC), 1, 'nested bands mean the tightest one');
});

// THE GUARD THAT MATTERS MOST HERE. `chooseBand` takes the leading figure out
// of whatever answer it is handed, and an open top band accepts anything above
// its floor — so a graduation date read as 2027, cleared "6+", and claimed six
// years of experience for a new grad, reported as filled.
test('a number off the menu\'s scale is not an answer to it', () => {
  const YEARS = ['0-2 years', '3-5 years', '6+ years'];
  assert.equal(chooseBand('June 2027 (graduating May 2027)', YEARS), -1,
    'a graduation date must never become an experience claim');
  assert.equal(chooseBand('May 2027', ['Less than 1 year', '1-3 years', '4+ years']), -1);
  assert.equal(chooseBand('2027', ['0-2', '3-5', '6 or more']), -1);
  assert.equal(chooseBand('$95,000', YEARS), -1, 'nor does a salary');
  // And the real quantities are untouched: an answer well inside the scale the
  // menu prints, or a little past its top band, still lands.
  assert.equal(chooseBand('12', ['0-5', '6-9', '10+']), 2);
  assert.equal(chooseBand('30', ['0-5', '6-9', '10+']), 2, 'a long career is still on this scale');
  assert.equal(chooseBand('3.85', ['3.7 - 4.0', '3.3 - 3.69']), 0);
});

// "When would you be available if an offer was accepted?" offers DELAYS, not
// dates. His profile holds "June 2027". The right answer used to come out of
// chooseBand by accident — 2027 cleared the floor of "More than 2 months" — and
// the scale guard above correctly stops that, so the conversion has to be real.
test('an availability menu is answered by counting the months', () => {
  const OPTS = ['Immediately', 'Less than 1 month after offer', '1-2 months after offer', 'More than 2 months after offer'];
  const now = new Date('2026-09-19T00:00:00Z');
  assert.equal(chooseDelay('June 2027 (graduating May 2027)', OPTS, now), 3, 'nine months out');
  assert.equal(chooseDelay('October 2026', OPTS, now), 2, 'one month out is inside "1-2 months"');
  assert.equal(chooseDelay('December 2026', OPTS, now), 3);
  assert.equal(chooseDelay('08/2026', OPTS, now), 0, 'a date already past means immediately');
  assert.equal(chooseDelay('September 2026', OPTS, now), 0, 'and so does this month');
  // Exactly two months sits on the boundary of "1-2" and "more than 2". The
  // existing refusal to guess applies here too, and the question stays his.
  assert.equal(chooseDelay('2026-11', OPTS, now), -1, 'a boundary is not an answer');
  // It must not fire on a menu that is not offer-relative — that is how a
  // graduation date would become an experience claim by another route.
  assert.equal(chooseDelay('June 2027', ['0-2 years', '3-5 years', '6+ years'], now), -1);
  assert.equal(chooseDelay('June 2027', ['Yes', 'No'], now), -1);
  assert.equal(chooseDelay('Open', OPTS, now), -1, 'no date, nothing to count');
});

test('the comparison symbols are read as bands', () => {
  assert.equal(chooseBand('2.5', ['<3.0', '3.0-4.0']), 0);
  assert.equal(chooseBand('12', ['0-5', '6-9', '>10']), 2);
  assert.equal(chooseBand('12', ['0-5', '6-9', 'at least 10']), 2);
  assert.equal(chooseBand('1', ['up to 2 years', '3-5 years']), 0);
  // And the guard the nesting rule must not weaken: bands that merely straddle
  // name no tightest answer, so the question stays his.
  assert.equal(chooseBand('2', ['1-3 years', '2-5 years']), -1);
});

test('"US" is recognised as where he lives', () => {
  // His country reads "United States of America"; the form offers "US". No text
  // match, and the answer is not in doubt.
  const a = planField({
    label: 'Are you currently living in the US or Canada?',
    type: 'radio', options: ['US', 'Canada', 'Other'],
  }, { ...PROFILE, identity: { ...PROFILE.identity, country: 'United States of America', location: 'Springfield, Washington' } });
  assert.equal(a.action, 'select');
  assert.equal(a.value, 'US');
});

test('residence matching stays narrow — it refuses what it cannot know', () => {
  const p = { ...PROFILE, identity: { ...PROFILE.identity, country: 'United States of America', state: 'Washington', city: 'Testville' } };
  // A yes/no about a city is NOT answered: wrong in either direction is worse
  // than leaving one field, and "reside" questions carry weight.
  assert.equal(chooseResidence('Do you currently reside in the Austin Metro Area?', ['Yes', 'No'], p), -1);
  // A question that is not about residence at all is never touched.
  assert.equal(chooseResidence('Which timezone are you currently located in?', ['EST', 'CST'], p), -1);
  // No country on the profile, no answer.
  assert.equal(chooseResidence('Where are you currently located?', ['US', 'Canada'], { identity: {} }), -1);
  // A country he does not live in is not chosen.
  assert.equal(chooseResidence('Are you currently living in Canada or Mexico?', ['Canada', 'Mexico'], p), -1);
});

test('his state is matched as well as his country', () => {
  const p = { ...PROFILE, identity: { ...PROFILE.identity, state: 'Washington', country: 'United States of America' } };
  assert.equal(chooseResidence('Where do you currently reside?', ['Oregon', 'Washington', 'Idaho'], p), 1);
});

test('the extension heartbeat distinguishes the three states that matter', () => {
  // "Never contacted", "connected and current", and "connected but stale" look
  // identical from the page — and every fix in this project is invisible until
  // Chrome reloads an unpacked extension, so telling them apart is the single
  // most useful thing the dashboard can say.
  assert.equal(extensionIsStale('1.0.0', '1.1.0'), true, 'stale');
  assert.equal(extensionIsStale('1.1.0', '1.1.0'), false, 'current');
  // "never contacted" is the absence of a version, which the server reports as
  // stale:null rather than true or false — a third state, not a default.
  assert.equal(planForm([], PROFILE).staleExtension, null,
    'no version reported means say nothing, not "you are stale"');
});

/**
 * "You have not filled this in" is not "this engine is lost".
 *
 * Measured on a live Gradient Robotics form: "Portfolio Link" was reported as
 * "no answer for this question", which reads like a bug in the engine. His
 * profile says `website: ""  # portfolio URL — none yet`. The question was
 * understood perfectly; the answer is genuinely nothing.
 *
 * That distinction matters because the unanswered list is the thing he actually
 * reads after a run, and padding it with questions the engine handled correctly
 * is what makes it look broken.
 */
test('a deliberately empty profile value is reported as HIS blank, not a gap', () => {
  const profile = { identity: { website: '', first_name: 'Alex' }, answers: {} };
  const [portfolio] = planForm([{ label: 'Portfolio Link', type: 'text' }], profile).actions;

  assert.equal(portfolio.action, 'unknown', 'it must still be left blank');
  assert.match(portfolio.why, /profile leaves this blank/,
    'and he must be told it is his to fill, not the engine failing to understand');
});

test('a question the engine genuinely cannot answer still says so', () => {
  // The other half. If everything became "your profile leaves this blank", the
  // real gaps would be the ones hidden instead.
  const profile = { identity: { website: '' }, answers: {} };
  // Required, so it is a real gap and must say so. F-240 split the wording:
  // an OPTIONAL blank now reads as optional, and only a required question the
  // engine cannot answer keeps the language of a gap.
  const [essay] = planForm([{ label: 'Tell us about a technical project you built', type: 'text', required: true }], profile).actions;
  assert.equal(essay.action, 'unknown');
  assert.match(essay.why, /no answer for this question/);
  assert.ok(!essay.optional, 'a required question is not an optional blank');
});

test('a MISSING profile key is not mistaken for a deliberate blank', () => {
  // `undefined` means the key is not there; `''` means he set it empty. Only
  // the second is a decision, and YAML is what tells them apart.
  const [portfolio] = planForm([{ label: 'Portfolio Link', type: 'text', required: true }], { identity: {}, answers: {} }).actions;
  assert.match(portfolio.why, /no answer for this question/);
});

test('an empty consent answer is NOT quietly marked handled', () => {
  // One of the four empty values in his profile is a background-check consent.
  // Wording it as a deliberate blank is fine; hiding it from the list is not.
  const profile = { identity: {}, answers: { agree_to_background_check: '' } };
  const [c] = planForm([{ label: 'Do you agree to a background check?', type: 'text' }], profile).actions;
  assert.notEqual(c.action, 'skip', 'it must stay on the list he reads');
});

/**
 * "No" on a checkbox GROUP means "none of these".
 *
 * Measured on the live Torc Robotics form. The U.S. Export Control question
 * lists [Cuba, Iran, North Korea, Syria, Crimea…, None/Not applicable]. His
 * answer is "No", which matches none of the countries, so a REQUIRED question
 * was left blank — and a blank there is what stops him submitting.
 *
 * The Playwright driver has done this since the security-clearance question
 * needed it. The planner the extension uses never learned it, so the two paths
 * had drifted — which is the failure this project keeps having.
 */
test('a NO answer picks the "None/Not applicable" box on a checkbox group', () => {
  const profile = { answers: { restricted_country_citizen: 'No' }, identity: {} };
  const label = 'U.S. Export Control Requirements - Are you a citizen, national, or resident of any of the following countries/regions? Check each that apply: * — Cuba';
  const options = ['Cuba', 'Iran', 'North Korea', 'Syria', 'None/Not applicable'];

  const [a] = planForm([{ label, type: 'checkbox', options }], profile).actions;
  assert.equal(a.action, 'select');
  assert.equal(a.value, 'None/Not applicable');
  assert.equal(a.review, true, 'an export-control answer is always worth his eye');
});

test('it never ticks a COUNTRY box when the answer is No', () => {
  // The whole point. Getting this wrong claims he is a national of Cuba.
  const profile = { answers: { restricted_country_citizen: 'No' }, identity: {} };
  const options = ['Cuba', 'Iran', 'North Korea'];
  const [a] = planForm([{
    label: 'Export Control - are you a citizen of any of the following? — Cuba',
    type: 'checkbox', options,
  }], profile).actions;
  assert.equal(a.action, 'unknown', 'with no "none" option there is nothing honest to tick');
  assert.ok(!options.includes(a.value), 'and certainly not a country');
});

test('a YES answer is not swept into "none of the above"', () => {
  const profile = { answers: { restricted_country_citizen: 'Iran' }, identity: {} };
  const [a] = planForm([{
    label: 'Export Control - citizen of any of the following? — Cuba',
    type: 'checkbox', options: ['Cuba', 'Iran', 'None/Not applicable'],
  }], profile).actions;
  assert.equal(a.value, 'Iran');
});

/**
 * Whose end date is this?
 *
 * Greenhouse's education block renders school--0, degree--0, end-month--0,
 * end-year--0. On the live Astranis form both date halves came back unanswered,
 * and they are his GRADUATION date — the most load-bearing fact on a new-grad
 * application.
 *
 * The reason it cannot just match on "End date": an EMPLOYMENT row asks the
 * same question about a job he left, and answering that with May 2027 is a
 * false claim about his work history. The shared index is what makes it safe.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const GRAD_PROFILE = { education: { school: 'Lakeside University', graduation: 'May 2027' }, identity: {}, answers: {} };

test('an education end date is his graduation date', () => {
  const { actions } = planForm([
    { label: 'School', type: 'text', id: 'school--0' },
    { label: 'End date month', type: 'select', id: 'end-month--0', options: MONTHS },
    { label: 'End date year', type: 'select', id: 'end-year--0', options: ['2026', '2027', '2028'] },
  ], GRAD_PROFILE);

  assert.equal(actions[1].value, 'May');
  assert.equal(actions[2].value, '2027');
});

test('AN EMPLOYMENT END DATE IS NOT', () => {
  // No school--1 beside it, so there is no evidence this row is education.
  // Answering it would put his graduation date on a job he never left.
  const { actions } = planForm([
    { label: 'Company', type: 'text', id: 'company--1' },
    { label: 'End date month', type: 'select', id: 'end-month--1', options: MONTHS },
  ], GRAD_PROFILE);

  assert.equal(actions[1].action, 'unknown', 'a job end date is not his graduation');
  assert.ok(!MONTHS.includes(actions[1].value ?? ''), 'and no month may be chosen for it');
});

test('a bare "End date month" with no index is left alone', () => {
  const { actions } = planForm([{ label: 'End date month', type: 'select', options: MONTHS }], GRAD_PROFILE);
  assert.equal(actions[0].action, 'unknown');
});

test('the education rows are matched by INDEX, not merely by presence', () => {
  // school--0 exists, but the date belongs to row 1. Sharing a form is not
  // sharing a row.
  const { actions } = planForm([
    { label: 'School', type: 'text', id: 'school--0' },
    { label: 'End date month', type: 'select', id: 'end-month--1', options: MONTHS },
  ], GRAD_PROFILE);
  assert.equal(actions[1].action, 'unknown');
});

/**
 * A consent question is a consent question in any clothing.
 *
 * His standing instruction is yes to every consent and AI-screening question.
 * That was implemented for CHECKBOXES only, so the identical question was
 * ticked as a checkbox and SKIPPED as a dropdown — because consent phrasing
 * also sits in the never-fill list (which exists to stop it being TEXT-filled)
 * and that check ran first.
 *
 * Measured on the live Astranis form: "By selecting YES, I consent to receive
 * recruiting SMS messages…" is a REQUIRED react-select. Unanswered, it blocks
 * the application.
 */
test('the same consent question answers the same in every rendering', () => {
  const profile = { identity: {}, answers: {} };
  const label = 'I agree to the Terms and Privacy Policy';

  const box = planForm([{ label, type: 'checkbox', options: [] }], COND_PROFILE).actions[0];
  assert.equal(box.action, 'check');

  const drop = planForm([{ label, type: 'select', options: ['Yes', 'No'] }], COND_PROFILE).actions[0];
  assert.equal(drop.action, 'select');
  assert.equal(drop.value, 'Yes');
  assert.equal(drop.review, true, 'a consent answered on his behalf must reach the review list');

  const combo = planForm([{ label, type: 'prompt', promptKind: 'combo', options: [] }], COND_PROFILE).actions[0];
  assert.equal(combo.value, 'Yes');
  assert.equal(combo.review, true);
});

test('SIGNATURE, DATE OF BIRTH AND SSN ARE STILL NEVER FILLED', () => {
  // The guard on the change above. Consent phrasing had to be lifted over the
  // never-fill check; nothing else may come with it.
  const profile = { identity: {}, answers: {} };
  for (const label of ['Signature', 'Date of Birth', 'Social Security Number']) {
    const [a] = planForm([{ label, type: 'text', options: [] }], profile).actions;
    assert.equal(a.action, 'skip', `${label} must never be filled`);
    assert.match(a.why, /never auto-filled/);
  }
});

test('a non-consent dropdown is not answered Yes just because it is a dropdown', () => {
  const [a] = planForm([{ label: 'What is your favourite colour?', type: 'select', options: ['Yes', 'No'] }],
    { identity: {}, answers: {} }).actions;
  assert.notEqual(a.action, 'select');
});

/**
 * "No" against a list of things that are not "No".
 *
 * Export-control and clearance questions offer statuses — [U.S. Citizen,
 * Permanent Resident, Protected Individual, None of the above] — and his answer
 * is "No". Nothing matched, so a REQUIRED field stayed blank.
 */
test('a NO answer finds "None of the above"', () => {
  const statuses = ['U.S. Citizen', 'U.S. Permanent Resident', 'Protected Individual', 'None of the above'];
  assert.equal(statuses[chooseOption('No', statuses)], 'None of the above');
});

test('and a real Yes/No list still picks the real No', () => {
  assert.equal(chooseOption('No', ['Yes', 'No']), 1);
  assert.equal(chooseOption('Yes', ['Yes', 'No']), 0);
});

test('a YES answer is never swept into "None of the above"', () => {
  const statuses = ['U.S. Citizen', 'None of the above'];
  assert.equal(chooseOption('Yes', statuses), -1);
});

/**
 * A conditional follow-up is not a gap in the engine.
 *
 * On the live Torc Robotics form, beneath the export-control question:
 * "If you checked any of the boxes above other than…" and "If you checked
 * either 'I am a Citizen or Legal…'". He ticked "None/Not applicable", so
 * neither applies and both are correctly blank — yet both were reported as
 * "no answer for this question", which reads as two more engine failures on a
 * list he is trying to work through.
 */
test('a conditional follow-up says it is conditional, not that we are lost', () => {
  const profile = { identity: {}, answers: {} };
  const [a] = planForm([{
    label: "If you checked any of the boxes above other than 'I am not a protected veteran', please specify",
    type: 'text', options: [],
  }], profile).actions;

  assert.equal(a.action, 'unknown', 'it must still be left blank');
  assert.match(a.why, /only applies if/, 'and be named as conditional rather than unanswered');
});

test('it is still LISTED, never hidden', () => {
  // Whether the condition was met is his to confirm, and a follow-up quietly
  // dropped is how a required field goes missing.
  const { unanswered } = planForm([{
    label: 'If you selected yes above, please explain', type: 'text', options: [],
  }], { identity: {}, answers: {} });
  assert.equal(unanswered.length, 1);
});

test('an ordinary question beginning with "if" is not mistaken for one', () => {
  const [a] = planForm([{ label: 'If offered the role, when could you start?', type: 'text', options: [] }],
    { identity: {}, answers: { earliest_start: 'June 2027' } }).actions;
  assert.notEqual(a.why, 'only applies if the question above it applies to you');
});

/**
 * A field that is already answered must not be answered again.
 *
 * The hardest bug of the session, and the fix is one comparison. Traced on a
 * live Micron form:
 *
 *   pass 1  Country current=""              -> prompt "United States of America"
 *           the list offers "United States", it is chosen, the field commits
 *   pass 2  Country current="United States" -> prompts THE SAME FIELD AGAIN,
 *           and the needless retry destroyed the answer
 *
 * The test was a raw string compare, so it only recognised the answer we would
 * TYPE, never the option the form actually offers. It looked like a matching
 * failure for five rounds; it was matching being asked the wrong question one
 * step later.
 */
test('AN ALREADY-ANSWERED FIELD IS SKIPPED, EVEN WORDED DIFFERENTLY', () => {
  const profile = { identity: { country: 'United States of America' }, answers: {} };
  const field = (current) => ({ label: 'Country', type: 'prompt', promptKind: 'combo', options: [], current });

  assert.equal(planForm([field('')], profile).actions[0].action, 'prompt',
    'an empty field is still answered');

  const already = planForm([field('United States')], profile).actions[0];
  assert.equal(already.action, 'skip', 'the option the form offers IS the answer');
  assert.match(already.why, /already set/);

  assert.equal(planForm([field('United States of America')], profile).actions[0].action, 'skip');
});

test('but a field holding something ELSE is still corrected', () => {
  // The guard on that change: "already answered" must not become "never touch
  // a field that has anything in it".
  const profile = { identity: { country: 'United States of America' }, answers: {} };
  const wrong = planForm([{ label: 'Country', type: 'prompt', promptKind: 'combo', options: [], current: 'Canada' }], COND_PROFILE).actions[0];
  assert.equal(wrong.action, 'prompt');
});

/**
 * The education row's START date is not his availability.
 *
 * Measured on a live Astranis form: "Start date month" and "Start date year"
 * sit in the education block, matched the start-date rule, and were answered
 * "June 2027 (graduating May 2027)" — his job availability written into when he
 * began his degree, and into a number field at that.
 */
test('THE EDUCATION START DATE IS NEVER HIS JOB AVAILABILITY', () => {
  const profile = { education: { school: 'Lakeside University', graduation: 'May 2027' },
    answers: { earliest_start: 'June 2027' }, identity: {} };
  const { actions } = planForm([
    { label: 'School', type: 'text', id: 'school--0' },
    { label: 'Start date month', type: 'text', id: 'start-month--0' },
    { label: 'Start date year', type: 'number', id: 'start-year--0' },
  ], profile);

  for (const a of actions.slice(1)) {
    assert.equal(a.action, 'unknown', 'when he started studying is not in his profile');
    assert.match(a.why, /when you started studying/);
    assert.ok(a.label, 'and it must still be named in the report');
  }
});

test('a real "when can you start" question still answers', () => {
  const profile = { answers: { earliest_start: 'June 2027' }, identity: {}, education: {} };
  const [a] = planForm([{ label: 'When can you start?', type: 'text', id: 'avail' }], profile).actions;
  assert.equal(a.value, 'June 2027');
});

test('an optional field left blank is not reported like a failure', () => {
  // F-240. "Please specify" and "Additional Link" on the live Neuralink form
  // are both required:false, and both were reported with the same seven words
  // used for a required question the engine could not handle: "no answer for
  // this question". Reading down a column of those is what makes a working run
  // look like a list of errors, and it hides the ones that genuinely need him.
  const profile = { name: 'Test Person', email: 't@example.com' };
  const optional = planForm([
    { label: 'Additional Link', type: 'text', required: false },
  ], profile).actions[0];
  assert.equal(optional.action, 'unknown', 'still listed — triage flags, it never drops');
  assert.equal(optional.optional, true, 'and marked so the count can separate it');
  assert.match(optional.why, /optional/i);

  // NOT a written question: "Describe a project you are proud of" used to be
  // the example here and is now answered by the essay writer (2026-09-09),
  // which is the whole point of that change. A required field the engine
  // genuinely cannot answer still has to read as one.
  const needed = planForm([
    { label: 'Employee referral badge number', type: 'text', required: true },
  ], profile).actions[0];
  assert.equal(needed.action, 'unknown');
  assert.ok(!needed.optional, 'a required question must never be counted as optional');
  assert.match(needed.why, /required/i, 'and must say that it is required');
});

// -- THE WRITTEN QUESTIONS, 2026-09-09 ---------------------------------
// His words: forms that ask "tell us about a project you are proud of" need
// an answer written for them, the same way the resume and the letter are.

test('A WRITTEN QUESTION IS PLANNED, NOT ABANDONED', () => {
  const profile = { name: 'Test Person', email: 't@example.com' };
  const plan = planForm([
    { label: 'Tell us about a project you are proud of', type: 'text', multiline: true, required: true },
    { label: 'Why do you want to work here?', type: 'text', multiline: true, maxLength: 600, required: true },
  ], profile);

  const [project, why] = plan.actions;
  assert.equal(project.action, 'essay');
  assert.equal(project.kind, 'project');
  assert.ok(project.review, 'he reads every word that goes out under his name');
  assert.ok(project.target.max >= 100, 'a project answer gets room');

  assert.equal(why.action, 'essay');
  assert.equal(why.kind, 'why-company');
  assert.ok(why.target.max <= 90, 'a 600-character box gets an answer that fits it');

  assert.equal(plan.summary.essay, 2);
  assert.equal(plan.summary.unknown, 0, 'a written question is no longer a gap');
  assert.deepEqual(plan.unanswered, [], 'and it is not on the list he has to finish by hand');
  assert.equal(plan.essays.length, 2, 'the page is told about them up front so it can start them early');
});

test('A ONE-LINE BOX IS NEVER A LONG ESSAY, however its label reads', () => {
  const profile = { name: 'Test Person', email: 't@example.com' };
  // Writing two hundred words into a single-line input is worse than leaving
  // it blank. Since 2026-09-25 (Mariana Minerals' Ashby "Why are you
  // interested in working for …?" is a one-line input he then wrote himself)
  // a WHY-US one-liner is answered — and at HIS length: he sent 128 words into
  // that very one-line Mariana box (2026-09-25), so the why-company band holds
  // there too (2026-09-27, TODO.md §H). Never past it.
  const a = planForm([{ label: 'Why do you want to work here?', type: 'text', required: false }], profile).actions[0];
  if (a.action === 'essay') assert.ok(a.target.max <= 150, `a one-line box stays within his why-company length, not ${a.target.max} words`);
  // Anything else in a one-line box is still not written into.
  const other = planForm([{ label: 'Tell us about an interesting engineering problem you\'ve solved', type: 'text', required: false }], profile).actions[0];
  assert.notEqual(other.action, 'essay');
  // A one-line box with a small limit is never written into.
  const tiny = planForm([{ label: 'Why do you want to work here?', type: 'text', maxLength: 80 }], profile).actions[0];
  assert.notEqual(tiny.action, 'essay');

  // …and a prose box that asks something factual is still the answer table's.
  const b = planForm([{ label: 'City', type: 'text', multiline: true }], { name: 'T', email: 't@e.com', location: { city: 'Springfield' } }).actions[0];
  assert.notEqual(b.action, 'essay');
});

test('THE ESSAY NEVER TOUCHES A QUESTION POLICY SAYS TO LEAVE ALONE', () => {
  const profile = { name: 'Test Person', email: 't@example.com' };
  // Self-identification is never auto-filled, and a box asking for it in prose
  // must not become a written answer.
  for (const label of ['Please describe your disability status', 'Tell us about your veteran status']) {
    const a = planForm([{ label, type: 'text', multiline: true, required: true }], profile).actions[0];
    assert.notEqual(a.action, 'essay', `"${label}" stays out of the writer`);
  }
});

test('a required unanswered question is never hidden by the optional split', () => {
  // The failure mode this must not become: quietly reclassifying gaps as
  // optional so the report looks clean. Anything without required:true is
  // optional, but nothing marked required may be.
  const profile = { name: 'Test Person', email: 't@example.com' };
  for (const required of [true, false]) {
    const a = planForm([{ label: 'Something nobody can answer', type: 'text', required }], COND_PROFILE).actions[0];
    assert.equal(a.action, 'unknown', 'it stays on the list either way');
    assert.equal(!!a.optional, !required, 'the flag must follow the field, not the wording');
  }
});

test('A CONDITIONAL FOLLOW-UP IS ANSWERED ON ITS QUESTION, NEVER ITS CONDITION', () => {
  // F-248, found by auditing the live Veeva and May Mobility forms.
  //
  // The condition of an "If you …, <question>" label is the half that names a
  // protected characteristic, and the answer rules were reaching it first:
  //
  //   "If you have a disability, please describe any accommodations you need"
  //        was answered  "No, I do not have a disability"
  //   "If you are authorized to work in the US, what is your start date?"
  //        was answered  "Yes"
  //
  // Both put the EEO or work-auth answer into a box asking something else — a
  // wrong answer on the most sensitive questions on the form.
  const accommodations = planForm([{
    label: 'If you have a disability, please describe any accommodations you need', type: 'text',
  }], COND_PROFILE).actions[0];
  assert.equal(accommodations.action, 'unknown',
    'a request to DESCRIBE accommodations must never be answered with a disability status');
  assert.ok(!/disability/i.test(String(accommodations.value ?? '')),
    'and the EEO answer must not leak into it');

  const startDate = planForm([{
    label: 'If you are authorized to work in the US, what is your start date?', type: 'text',
  }], COND_PROFILE).actions[0];
  assert.notEqual(startDate.value, 'Yes', 'a start-date question must not be answered "Yes"');
  assert.match(String(startDate.value ?? ''), /2027/, 'it must answer with the start date');
});

test('a follow-up whose condition IS true of him gets answered', () => {
  // The other half: skipping every conditional was too blunt. He is a candidate
  // with under two years of experience, and his GPA is not a secret.
  const gpa = planForm([{
    label: 'If you are a candidate with under 2 years of experience, please share your GPA', type: 'text',
  }], COND_PROFILE).actions[0];
  assert.equal(gpa.action, 'fill');
  assert.ok(gpa.review, 'whether the condition holds is his to confirm, so it is flagged');
  assert.match(String(gpa.why || ''), /condition/i, 'and the reason says so');
});

test('a follow-up with no separable question stays his', () => {
  // "If you selected yes above, please explain" has nothing this engine can
  // answer, and inventing an explanation is the worst outcome available.
  for (const label of [
    'If you checked any of the boxes above other than "None", please explain',
    'If you selected yes above, please provide details',
    'If you selected yes above',
  ]) {
    const a = planForm([{ label, type: 'text' }], COND_PROFILE).actions[0];
    assert.equal(a.action, 'unknown', `${label} must be left to him`);
    assert.match(a.why, /only applies if/i);
  }
});

test('"If YOUR …" is guarded exactly like "If you …"', () => {
  // F-249. The F-248 guard matched `if you <verb>` and nothing else, so a
  // follow-up worded "If your disability requires accommodation, please
  // describe what you need" walked straight past it into the answer rules and
  // came back "No, I do not have a disability" — the same fault, one letter
  // outside the pattern that catches it.
  const eeo = { ...COND_PROFILE, eeo: { disability: 'No, I do not have a disability', veteran: 'I am not a Veteran.' } };

  for (const label of [
    'If your disability requires accommodation, please describe what you need',
    'If your veteran status applies, please provide details',
  ]) {
    const a = planForm([{ label, type: 'text' }], eeo).actions[0];
    assert.equal(a.action, 'unknown', `${label} must be left to him`);
    assert.ok(!/disability|veteran/i.test(String(a.value ?? '')),
      'the EEO answer must never land in a free-text box asking something else');
  }
});

test('…without losing the conditional answers that are correct', () => {
  // Measured on the live Relativity Space form: "If your location differs from
  // the location posted…, are you willing to commute and/or relocate for this
  // role?" is a question this engine CAN answer, and the answer is yes.
  const relocating = { ...COND_PROFILE, answers: { ...COND_PROFILE.answers, willing_to_relocate: 'Yes' } };
  const a = planForm([{
    label: 'If your location differs from the location posted, are you willing to relocate for this role?',
    type: 'text',
  }], relocating).actions[0];
  assert.equal(a.value, 'Yes', 'a conditional question with a real answer still gets one');
  assert.ok(a.review, 'and it is flagged, because the condition is his to confirm');
});

// ── the placeholder that read as an answer (F-297) ────────────────────

test('A DROPDOWN SHOWING "Select One" IS UNANSWERED, NOT ALREADY SET', () => {
  // The silent half of the Jabil failure. "Select One" is what an UNTOUCHED
  // Workday dropdown shows, and every read of `current` in this branch treats a
  // non-empty value as already answered — so the field planned as `skip`,
  // which content.js counts and never lists. Four required questions, one
  // reported, and Save and Continue refusing to move.
  //
  // discover.js strips it at source now. This asserts the SERVER does not
  // depend on that, because Chrome serves an unpacked extension from its own
  // cache until it reloads and a stale copy keeps sending the placeholder.
  for (const placeholder of ['Select One', 'select one', 'Select a Value']) {
    const a = planField({
      type: 'prompt', key: 'formField-priorExp',
      label: 'What is your experience working at Jabil?',
      current: placeholder, options: [],
    }, WD);
    assert.equal(a.action, 'unknown',
      `"${placeholder}" is a placeholder — the field must reach his list`);
    assert.doesNotMatch(a.why || '', /already set/);
  }
});

test('a placeholder does not stop a prompt we DO have an answer for', () => {
  const a = planField({
    type: 'prompt', key: 'formField-phoneType', label: 'Phone Device Type',
    current: 'Select One', options: [],
  }, WD);
  assert.equal(a.action, 'prompt');
  assert.equal(a.value, 'Mobile');
});

test('a REAL current value is still left alone', () => {
  // The placeholder strip must not weaken the guard that stops a second pass
  // destroying a value Workday filled correctly from his candidate profile.
  const a = planField({
    type: 'prompt', key: 'formField-phoneType', label: 'Phone Device Type',
    current: 'Mobile', options: [],
  }, WD);
  assert.equal(a.action, 'skip');
  assert.match(a.why, /already set/);
});

/**
 * THE LANGUAGE BLOCK IS ANSWERED AT THE TOP OF ITS LADDER (F-367).
 *
 * Under each language on Workday's My Experience sit Comprehension, Overall,
 * Reading, Speaking, Writing and "I am fluent in this language." All six were
 * left for him on a live form. His instruction: the highest level offered,
 * for every language he lists — whatever the tenant calls it.
 */
test('the five proficiency dropdowns take the highest rung the tenant offers', () => {
  const pick = (w, o) => { const i = chooseOption(w, o); return i === -1 ? null : o[i]; };
  assert.equal(pick('Native or Bilingual', ['Select One', 'Basic', 'Intermediate', 'Advanced', 'Fluent']), 'Fluent');
  assert.equal(pick('Fluent', ['Elementary', 'Limited Working', 'Professional Working', 'Full Professional', 'Native or Bilingual']), 'Native or Bilingual');
  assert.equal(pick('Native or Bilingual', ['1 - Beginner', '2', '3', '4', '5 - Native']), '5 - Native');
  // A lower answer keeps its own rung — the ladder decides only for the top.
  assert.equal(pick('Intermediate', ['Basic', 'Intermediate', 'Advanced', 'Fluent']), 'Intermediate');
  // And a list that is not a ladder is not decided this way.
  assert.equal(pick('Fluent', ['English', 'Spanish', 'Vietnamese']), null);
  for (const label of ['Comprehension', 'Overall *', 'Reading', 'Speaking', 'Writing']) {
    const a = planField({ label, type: 'select', options: ['Select One', 'Basic', 'Intermediate', 'Advanced', 'Fluent'] }, { answers: {} });
    assert.equal(a.action, 'select', label);
    assert.equal(a.value, 'Fluent', label);
  }
  // A Workday prompt has no options until it opens: the answer names the top
  // rung, and the open list is ranked by the same rule (the worker's `choose`).
  const wd = planField({ label: 'Speaking', type: 'prompt', current: 'Select One', promptKind: 'single' }, { answers: {} });
  assert.equal(wd.action, 'prompt');
  assert.equal(wd.value, 'Native or Bilingual');
  // Once it holds "Fluent" the second pass leaves it alone — the value the
  // ladder chose is the answer, not a mismatch to re-drive.
  const again = planField({ label: 'Speaking', type: 'prompt', current: 'Fluent', promptKind: 'single' }, { answers: {} });
  assert.equal(again.action, 'skip');
  const box = planField({ label: 'I am fluent in this language.', type: 'checkbox' }, { answers: {} });
  assert.equal(box.action, 'check');
  // J&J's row asks each level as a Yes/No prompt (Auris Health, F-670).
  for (const label of ['Fluent', 'Foundational *']) {
    const jj = planField({ label, type: 'prompt', current: 'Select One', promptKind: 'single' }, { answers: {} });
    assert.equal(jj.action, 'prompt', label);
    assert.equal(jj.value, 'Yes', label);
  }
});

test('F-618: a reused answer is an alternative, never joined onto the rule\'s by a comma', () => {
  // HP, 2026-09-27: "I am not a Veteran.,I IDENTIFY AS A VETERAN, JUST NOT A
  // PROTECTED VETERAN" went to the page as one answer. (The veteran question
  // is no longer reused at all — answer-log's PAST_NEVER — so a plain
  // question stands in for it here.)
  const label = 'I am fluent in this language.';
  const profile = { answers: {}, pastAnswer: () => ({ answer: 'Fluent speaker', company: 'HP Inc.', at: '2026-09-26' }), applyingTo: 'HP Inc.' };
  const d = decide({ label, type: 'prompt', promptKind: 'single' }, label, profile);
  assert.equal(d.value, 'Yes', JSON.stringify(d));
  assert.deepEqual(d.alternatives, ['Yes', 'Fluent speaker']);
  const a = planField({ label, type: 'prompt', promptKind: 'single' }, profile);
  assert.deepEqual([a.value, a.values], ['Yes', ['Yes', 'Fluent speaker']]);
  const vet = planField({ label: 'Are you a protected U.S. Military Veteran?', type: 'prompt', promptKind: 'single' },
    { answers: {}, eeo: { veteran: 'I am not a Veteran.' }, pastAnswer: () => ({ answer: 'I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN', company: 'HP Inc.', at: '2026-09-26' }), applyingTo: 'HP Inc.' });
  assert.ok(!/,/.test(String(vet.value ?? '')), `the veteran plan is one answer: ${JSON.stringify(vet)}`);
});

test('F-621: Micron\'s three first names, told apart by page order', () => {
  const profile = { answers: {}, identity: { first_name: 'Anh Minh Alex', last_name: 'Rivera', preferred_full_name: 'Alex Rivera' } };
  const F = [['First name', 'text'], ['Last name', 'text'], ['First Name', 'text'], ['Last Name', 'text'], ['I have a preferred name', 'checkbox'], ['First Name', 'text']]
    .map(([label, type]) => ({ label, type, options: type === 'checkbox' ? ['Yes'] : [] }));
  const firsts = planForm(F, profile, {}).actions.filter((a) => /^first name$/i.test(a.label)).map((a) => a.value);
  assert.deepEqual(firsts, ['Alex', 'Anh Minh Alex', 'Alex'], 'contact, legal, preferred — as he sent them twice');
  const plain = planForm(F.slice(0, 2), profile, {}).actions.map((a) => a.value);
  assert.deepEqual(plain, ['Anh Minh Alex', 'Rivera'], 'no preferred-name section: the legal name, as before');
});

test('F-631: Micron\'s contact first name stays "Alex" on the pass after the form rebuilds', () => {
  const profile = { answers: {}, identity: { first_name: 'Anh Minh Alex', last_name: 'Rivera', preferred_full_name: 'Alex Rivera', email: 'v@example.com' } };
  // The second pass, 2026-10-01: the legal and preferred blocks were not back yet.
  const F = [['Upload your resume', 'file'], ['Email', 'text'], ['First name', 'text'], ['Last name', 'text'], ['Phone Number', 'text'], ['City', 'text']]
    .map(([label, type]) => ({ label, type, options: [] }));
  const first = planForm(F, profile, {}).actions.find((a) => /^first name$/i.test(a.label));
  assert.equal(first.value, 'Alex');
  // Greenhouse and the rest ask First, Last, Email: the legal name, unchanged.
  const gh = [['First Name', 'text'], ['Last Name', 'text'], ['Email', 'text']].map(([label, type]) => ({ label, type, options: [] }));
  assert.equal(planForm(gh, profile, {}).actions.find((a) => /^first name$/i.test(a.label)).value, 'Anh Minh Alex');
});

test('F-621: Hyve\'s pay ranges — his target takes its band, outside the range "Other"; money in shorthand is read', () => {
  const profile = { answers: { salary_expectation: '$90000/year' }, salary: { target: 90000 } };
  const low = ['$20 - $30k', '$80 - $90k', '$90 - $100k', 'Other'];
  const high = ['$100 - $110k', '$110 - $120k', '$160 - $170k', 'Other'];
  const L1 = 'If your total cash compensation expectation (base salary plus bonus/ other incentive amounts) is between $20k and $100k, please select the applicable range below. If your expectation is higher, please select Other and answer the following question.';
  const L2 = 'If your total cash compensation expectation (base salary plus bonus/ other incentive amounts) is between $100k and $170k, please select the applicable range below. If your expectation is lower, please select Other and answer the prior question.';
  assert.equal(chooseBand('$90000/year', low), 2, 'a band starts at its first figure');
  assert.equal(chooseBand('$95,000', low), 2);
  assert.equal(chooseBand('$90000/year', ['$80,000 - $89,999', '$90,000 - $99,999', '$100,000+']), 1);
  assert.equal(chooseBand('2 years', ['0-2', '2-5']), -1, 'a count of years on an edge is still refused');
  const a = planField({ label: L1, type: 'select', options: low }, profile);
  const b = planField({ label: L2, type: 'select', options: high }, profile);
  assert.equal(a.value, '$90 - $100k', JSON.stringify(a));
  assert.equal(b.value, 'Other', JSON.stringify(b));
});

test('F-621: Workday\'s disability boxes, read one by one or as one group, tick his statement', () => {
  const opts = ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'];
  const profile = { answers: {}, eeo: { disability: 'No, I do not have a disability' } };
  const label = 'Please check one of the boxes below:';
  // As one group (Intel, 2026-09-26): judged by its first statement it was skipped.
  const group = planForm([{ label, type: 'checkbox', options: opts }], profile, {}).actions[0];
  assert.deepEqual([group.action, group.optionIndex], ['select', 1], JSON.stringify(group));
  // As three boxes, each with its own statement.
  const boxes = planForm(opts.map((o) => ({ label, type: 'checkbox', options: [o] })), profile, {}).actions.map((a) => a.action);
  assert.deepEqual(boxes.slice(0, 2), ['skip', 'check']);
  assert.notEqual(boxes[2], 'check', 'a decline is never chosen for him');
});

test('F-618: his earlier tick of the copied fluent boxes, reused, is a tick', () => {
  // HP's second application (2026-09-26 10:39): the three copies of "I am
  // fluent in this language." were handed his answer from the first one —
  // the boxes' own words — and the plan read it as "not yes" and left them.
  const label = 'Languages 1 — I am fluent in this language.';
  const options = Array(3).fill('I am fluent in this language.');
  const pastAnswer = (q) => (q === label ? { answer: options.join(' | '), company: 'HP Inc.', at: '2026-09-26T10:33:11Z' } : null);
  const a = planField({ label, type: 'checkbox', options }, { answers: {}, pastAnswer, applyingTo: 'HP Inc.' });
  assert.equal(a.action, 'check', a.why);
  const logged = planField({ label: 'I have read the policy', type: 'checkbox', options: ['I have read the policy'] },
    { answers: {}, pastAnswer: () => ({ answer: 'checked', company: 'HP Inc.', at: '2026-09-26' }), applyingTo: 'HP Inc.' });
  assert.notEqual(logged.why, 'answer is "checked" — leaving it unticked');
});

/**
 * "EVERYTHING SHOULD BE FLUENT" (F-551, 2026-09-24). Intel's Workday language
 * prompts were sent the one string "Native or Bilingual" and nothing else to
 * try. The prompt now carries the whole ladder, and the rating scales that are
 * not named for languages (Low…High, Poor…Excellent) have a top rung too.
 */
test('a closed Workday proficiency prompt carries every rung, and plain rating scales have a top', () => {
  const wd = planField({ label: 'Comprehension', type: 'prompt', current: '', promptKind: 'single' }, { answers: {} });
  assert.equal(wd.action, 'prompt');
  assert.ok(Array.isArray(wd.values) && wd.values.length > 3, 'the ladder travels to the page');
  assert.ok(wd.values.includes('Fluent') && wd.values.includes('Advanced'));
  // A multi prompt is untouched: values there are items, not alternatives.
  const pick = (w, o) => { const i = chooseOption(w, o); return i === -1 ? null : o[i]; };
  assert.equal(pick('Native or Bilingual', ['Low', 'Medium', 'High']), 'High');
  assert.equal(pick('Native or Bilingual', ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent']), 'Excellent');
  assert.equal(pick('Fluent', ['None', 'Some', 'Good', 'Excellent']), 'Excellent');
  // Anchored: a degree list is not a ladder because one option says "High".
  assert.equal(pick('Native or Bilingual', ['High School', "Bachelor's", "Master's"]), null);
});

/**
 * A QUESTION ABOUT HIS HISTORY WITH THIS EMPLOYER IS ANSWERED FROM HIS HISTORY.
 *
 * Measured on the live Applied Materials form (2026-09-06): "Have you ever
 * worked at Applied Materials as a regular employee, contingent worker, intern,
 * etc.?" planned as **No** — a false answer about his own most important
 * employer, on their own application, over a field the page already held "Yes"
 * in. His profile carried the default and a note beside it saying the Applied
 * Materials internship is the exception; nothing read the note. The employer he
 * is applying to is now compared against his own work history.
 */
test('F-376: "have you ever worked here" answers Yes at an employer in his work history', () => {
  const P = {
    work_experience: [{ company: 'Applied Materials' }, { company: 'Acme Steel Stud Company' }],
    answers: { previously_employed_here: 'No' },
  };
  const ask = (company, label = 'Have you ever worked at Applied Materials as a regular employee, contingent worker, intern, etc.?') =>
    planForm([{ label, type: 'prompt', promptKind: 'combo', current: '', options: [] }], P, { company }).actions[0];

  assert.equal(ask('Applied Materials').value, 'Yes', 'he interned there — cv.md and his profile both say so');
  assert.equal(ask('Applied Materials, Inc.').value, 'Yes', 'a legal suffix is not a different employer');
  assert.equal(ask('Applied Materials').review, true, 'and it stays on the list he reads before pressing Submit');
  // …AND NOWHERE ELSE. An employer he has not worked for keeps the standing No.
  assert.equal(ask('Micron Technology', 'Have you ever worked at Micron as an employee, contractor or intern?').value, 'No');
  assert.equal(ask(null, 'Have you ever worked at Micron as an employee, contractor or intern?').value, 'No',
    'and a form whose employer is unknown answers exactly as it did before');
  // A near-name is not a match: "Applied Signal" is a different company.
  assert.equal(planForm([{ label: 'Have you ever worked at Applied Signal Technology as an intern?', type: 'prompt', promptKind: 'combo', current: '', options: [] }],
    P, { company: 'Applied Signal Technology' }).actions[0].value, 'No');
  // The other half of his history counts too.
  assert.equal(ask('Acme Steel Stud Company', 'Have you previously been employed at Acme Steel?').value, 'Yes');
});

/**
 * NINE VISA QUESTIONS IN ONE SCREEN, ALL LEFT FOR HIM.
 *
 * Amazon's form (live, 2026-09-20) asked his immigration HISTORY and the
 * profile held only his current status, so there was no key to match and no
 * rule looking for one. Every one of these is a fact he stated directly, and
 * the answers below are his, not a derivation — the one exception is the STEM
 * question, which his degree already settles twice over in the profile.
 */
test('the immigration-history block answers from his stated facts', () => {
  const P = {
    education: { school: 'Lakeside University', discipline: 'Mechanical Engineering' },
    answers: {
      held_h1b: 'No', held_j1: 'No', outside_us_12_months: 'Yes', non_compete: 'No',
      stem_degree: 'Yes', eligible_to_begin_immediately: 'No', requires_cpt: 'No',
      government_employee: 'No',
      authorized_to_work_us: 'Yes', require_sponsorship: 'Yes',
    },
  };
  const ask = (label, options = ['Yes', 'No']) =>
    planForm([{ label, type: 'radio', options, required: true }], P, {}).actions[0];

  assert.equal(ask('Have you held H-1B status, or had an H-1B petition approved on your behalf, within the preceding 6 years?').value, 'No');
  assert.equal(ask('Have you ever held J-1 status? — Yes').value, 'No');
  assert.equal(ask('In the past 7 years, have you lived or were physically located outside of the US for 12 consecutive months or more?').value, 'Yes');
  assert.equal(ask('Are you subject to a non-competition agreement or other agreement which would preclude or restrict your employment?').value, 'No');
  assert.equal(ask('Is your degree in a STEM field? (Science, Technology, Engineering, Mathematics) — Yes').value, 'Yes');
  assert.equal(ask('If offered employment by Amazon, would you be legally eligible to begin employment immediately? — Yes').value, 'No',
    'read literally: OPT/EAD takes about 90 days, so he cannot start the day an offer lands');

  // The government-employee group arrives as its own FIRST OPTION rather than
  // as a question, and neither existing spelling contained a bare "government
  // employee" — so a required field was left blank.
  assert.equal(ask('No, I was NEVER a government employee.', [
    'No, I was NEVER a government employee.',
    'Yes, I am a FORMER government employee.',
    'Yes, I am a CURRENT government employee.',
  ]).value, 'No, I was NEVER a government employee.');

  // "…CPT authorization FROM YOUR SCHOOL…" was answered **"Lakeside
  // University"**: the school rule's guard enumerated leading auxiliaries and
  // was one verb short of "would". The school questions it protects still work.
  assert.equal(ask('If you selected F-1, would you require Curricular Practice Training (CPT) authorization from your school to begin full time employment at Amazon? — Yes').value, 'No');
  assert.equal(planForm([{ label: 'What school did you attend?', type: 'text', options: [] }], P, {}).actions[0].value,
    'Lakeside University', 'asking WHICH school still answers with the school');
});

/**
 * TWO CONSENT SPELLINGS TESLA USES, both left blank on a live form.
 * One of them was a REQUIRED checkbox — the quietest way to void an
 * application there is.
 */
test('consent covers the ordinary English spellings', () => {
  const P = { answers: {} };
  const tick = planForm([{
    label: 'I have read, understand, and agree to the statements above.',
    type: 'checkbox', options: [], required: true,
  }], P, {}).actions[0];
  assert.equal(tick.action, 'check', 'the verb sat behind "have read," and the pattern wanted it next to "I"');

  const auth = planForm([{
    label: 'I authorize Tesla to consider me for other job opportunities for the next 36 months.',
    type: 'radio', options: ['Yes', 'No'], required: false,
  }], P, {}).actions[0];
  assert.equal(auth.value, 'Yes', 'it widens where his application is read, which is the direction he wants');

  // THE VETO STILL RUNS FIRST. This is what stops the widened pattern asserting
  // something untrue about his status on a form a human reads.
  const citizen = planForm([{
    label: 'I certify that I am a U.S. citizen or permanent resident.',
    type: 'checkbox', options: [], required: true,
  }], P, {}).actions[0];
  assert.notEqual(citizen.action, 'check', 'a box that CLAIMS A STATUS is never ticked for him');
});

/**
 * A JOB BOARD'S OWN FILTERS ARE NOT AN APPLICATION FORM. Gradient Robotics'
 * Ashby board put four of them in the leftover list in one sighting, on a page
 * that had no application on it at all.
 */
test('a board filter is not a question', () => {
  const P = { answers: {} };
  const plan = (label, options) => planForm([{ label, type: 'select', options }], P, {}).actions[0];

  assert.equal(plan('departmentId', ['Department', 'All Departments', 'Engineering (8)', 'Internship (1)']).action, 'skip');
  assert.equal(plan('locationId', ['Location', 'All Locations', 'San Francisco (10)']).action, 'skip');
  assert.equal(plan('workplaceType', ['Location Type', 'All Location Types', 'On-site (10)']).action, 'skip');

  // BOTH SIGNALS, NEVER ONE. A lone "All …" is a legitimate answer on a real
  // question, and requiring the result count beside it is what keeps this from
  // eating one.
  assert.notEqual(plan('Are you willing to relocate?', ['All Locations', 'Yes', 'No']).action, 'skip',
    'an "All …" option on its own is not a filter');
  assert.notEqual(plan('Which shift do you prefer?', ['Day (1)', 'Night (2)']).action, 'skip',
    'a count on its own is not a filter either');
});

/**
 * F-519 · A QUESTION ABOUT HOW TO CONTACT HIM IS NOT A REQUEST FOR HIS ADDRESS.
 *
 * Xaira's Greenhouse form asked "Would you like to receive communications via
 * SMS…? If you select no, we will only communicate with you via email…" — and
 * a bare /e-?mail/ put HIS EMAIL ADDRESS into a Yes/No dropdown, three times,
 * twice over an answer already committed as "Yes".
 */
test('a communication-preference question is answered, not addressed', () => {
  const P = { identity: { email: 'v@example.test' }, answers: { communication_optin: 'Yes' } };
  const ask = (label, type = 'select', options = ['Yes', 'No']) =>
    planForm([{ id: 'x', label, type, options }], P, {}).actions[0];

  const sms = ask('Would you like to receive communications via SMS to the number provided above? '
    + 'If you select no, we will only communicate with you via email and/or telephone calls.');
  assert.equal(sms.value, 'Yes', 'his standing yes-to-consent; being reachable is in his favour');
  assert.equal(sms.review, true, 'and review-flagged without exception, like every consent');
  assert.notEqual(sms.value, 'v@example.test');

  // THE ADDRESS FIELDS ARE UNTOUCHED. The guard is on the question, not the word.
  for (const l of ['Email', 'Email Address', 'Confirm Email', 'Preferred Email Address']) {
    assert.equal(ask(l, 'text', []).value, 'v@example.test', `${l} still answers with his address`);
  }
});

/**
 * F-526 · "How did you LEARN about this opportunity?" — Lever's house wording.
 *
 * Two faults in one field. The label arrived carrying the first option's text
 * ("— FieldAI Website"), which dragged it into the website rule 370 lines
 * above; and the how-heard rule knew `hear about` and `find out` but not
 * `learn`, so even with the website rule out of the way it still failed.
 * Required field, `how_heard: "LinkedIn"` in his profile, "LinkedIn" on the
 * menu, and it came back `no option matches "alexrivera.example"`.
 */
test('how he heard is answered, in every shape the question takes', () => {
  const P = {
    identity: { website: 'alexrivera.example' },
    answers: { how_heard: 'LinkedIn', heard_about_us: 'Job Board or Social Media' },
  };
  const ask = (label, options = []) =>
    planForm([{ id: 'x', label, type: options.length ? 'select' : 'text', options, required: true }], P, {}).actions[0];

  assert.equal(ask('How did you learn about this opportunity?✱ — FieldAI Website',
    ['FieldAI Website', 'LinkedIn', 'Referral', 'Job Board', 'Other']).value, 'LinkedIn',
  'the option text riding on the label must not decide the answer');
  assert.equal(ask('How did you learn about this opportunity?').value, 'LinkedIn');
  assert.equal(ask('How did you hear about us?').value, 'LinkedIn');
  // A LIST OF CATEGORIES takes the category answer — `decide` picks whichever
  // shape the form actually offers (F-263).
  assert.equal(ask('How did you hear about this role?',
    ['Job Board or Social Media', 'Employee Referral', 'Career Fair']).value, 'Job Board or Social Media');

  // …and his real website questions still answer with his website.
  for (const l of ['Website', 'Portfolio URL', 'Link to your personal site']) {
    assert.equal(ask(l).value, 'alexrivera.example', `${l} still answers with his site`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// A FLAT EMPLOYMENT-HISTORY BLOCK (F-533).
//
// Six required fields arriving as bare labels with no id, no index and no
// section, all reported as unanswerable while the profile answered five of
// them. The row index is the OCCURRENCE ORDER, and that is what makes it safe:
// filling every row from his most recent job would be false employment history
// on a live application.
// ─────────────────────────────────────────────────────────────────────
const HISTORY_PROFILE = {
  ...PROFILE,
  answers: {
    ...PROFILE.answers,
    reason_for_leaving: 'Internship ended',
    current_employer_reason: 'Currently employed',
    skills: 'SolidWorks, CNC machining, RoboDK, machine vision, Python, GD&T, MIG welding',
  },
  work_experience: [
    { title: 'Manufacturing Engineer Intern', company: 'Applied Materials', location: 'Austin, Texas', start: 'May 2026', end: 'August 2026' },
    { title: 'Mechanical Engineering Intern', company: 'Acme Steel', location: 'Springfield, Washington', start: 'May 2025', end: 'August 2025' },
    { title: 'Manufacturing Lead', company: 'Makerspace MTC', location: 'Springfield, Washington', start: 'August 2024', end: '', current: true },
  ],
};
const hist = (labels, profile = HISTORY_PROFILE, opts = {}) =>
  planForm(labels.map((label) => field({ label, required: true })), profile, opts).actions;
const ROW = ['* Company Name', '* Title', 'From Date', 'End Date', '* Work location (City)', '* Reason for Leaving'];

test('one employment row is filled from his most recent job', () => {
  const got = hist(ROW).map((a) => [a.action, a.value]);
  assert.deepEqual(got, [
    ['fill', 'Applied Materials'],
    ['fill', 'Manufacturing Engineer Intern'],
    ['fill', 'May 2026'],
    ['fill', 'August 2026'],
    ['fill', 'Austin, Texas'],
    ['fill', 'Internship ended'],
  ]);
  // Employment history on a live application is always worth his eye.
  assert.ok(hist(ROW).every((a) => a.review === true), 'every row is review-flagged');
});

test('three employment rows get three DIFFERENT jobs, in order', () => {
  const got = hist([...ROW, ...ROW, ...ROW]).filter((a) => a.label === '* Company Name').map((a) => a.value);
  assert.deepEqual(got, ['Applied Materials', 'Acme Steel', 'Makerspace MTC']);
});

test('a job he still holds takes no end date and says he is still there', () => {
  const rows = hist([...ROW, ...ROW, ...ROW]);
  const third = rows.slice(12);
  // A deliberate blank since 2026-09-24 (TSMC): it used to be `unknown`,
  // which put a settled field in the list of things left for him.
  const end = third.find((a) => a.label === 'End Date');
  assert.equal(end.action, 'skip', 'never a made-up end date for a current role');
  assert.ok(!end.value, 'and no value at all');
  assert.equal(third.find((a) => a.label === '* Reason for Leaving').value, 'Currently employed');
});

test('more rows than jobs leaves the extra rows empty rather than inventing one', () => {
  const got = hist(Array.from({ length: 5 }, () => '* Company Name')).map((a) => a.value ?? '');
  assert.deepEqual(got, ['Applied Materials', 'Acme Steel', 'Makerspace MTC', '', '']);
});

test('without a company field, a bare Title or End Date is NOT employment history', () => {
  // Same corroboration rule as the graduation-date fix: no context, no answer.
  // "Title" would otherwise take a job title on a form asking for a salutation,
  // a publication or a degree name.
  const got = hist(['* Title', 'End Date', 'From Date']);
  assert.ok(got.every((a) => a.action !== 'fill'), got.map((a) => `${a.label}=${a.value}`).join(', '));
});

test('the month is not off by one', () => {
  // parseMonthYear counts months from 1; monthYear in apply-plan.mjs counts from
  // 0. Getting that backwards would put every employment date one month out on
  // a real application, and nobody would catch it by eye.
  assert.equal(hist(['* Company Name', 'From Date'])[1].value, 'May 2026');
  const jan = { ...HISTORY_PROFILE, work_experience: [{ company: 'X', title: 'Y', start: 'January 2025', end: 'December 2025' }] };
  assert.deepEqual(hist(['* Company Name', 'From Date', 'End Date'], jan).slice(1).map((a) => a.value),
    ['January 2025', 'December 2025']);
});

// ─────────────────────────────────────────────────────────────────────
// THE SKILLS TABLE, RANKED FOR THE POSTING (F-534).
// ─────────────────────────────────────────────────────────────────────
test('a skills table is filled one skill per row, best match first', () => {
  const got = hist(Array.from({ length: 4 }, () => '* Skill'), HISTORY_PROFILE,
    { jd: 'We need RoboDK, machine vision and Python for robot cell integration.' })
    .map((a) => a.value);
  assert.deepEqual(got.slice(0, 3).sort(), ['Python', 'RoboDK', 'machine vision'],
    'the three the posting names come first');
  assert.equal(got.length, 4);
});

test('the same table ranks differently for a machining posting', () => {
  const got = hist(['* Skill', '* Skill'], HISTORY_PROFILE,
    { jd: 'CNC machining and MIG welding on precision weldments.' }).map((a) => a.value);
  assert.deepEqual(got.sort(), ['CNC machining', 'MIG welding']);
});

test('with no job description it falls back to his own order, never to nothing', () => {
  const got = hist(['* Skill', '* Skill'], HISTORY_PROFILE).map((a) => a.value);
  assert.deepEqual(got, ['SolidWorks', 'CNC machining']);
});

test('a skill the posting wants and he does not have is never invented', () => {
  const got = hist(Array.from({ length: 7 }, () => '* Skill'), HISTORY_PROFILE,
    { jd: 'Verilog, ASIC layout and SPICE simulation required.' }).map((a) => a.value);
  assert.ok(!got.some((v) => /verilog|asic|spice/i.test(String(v))),
    `nothing outside his pool: ${got.join(', ')}`);
  assert.equal(got.length, 7, 'his seven skills still fill the seven rows');
});

test('a Skills TEXTAREA is an essay box, not a table row', () => {
  const [a] = planForm([field({ label: 'Skills', type: 'textarea', multiline: true, maxLength: 2000 })],
    HISTORY_PROFILE, {}).actions;
  assert.notEqual(a.value, 'SolidWorks');
});

/**
 * A SKILLS SEARCH BOX IS RANKED FOR THE POSTING (F-552, 2026-09-24). Intel's
 * box got SolidWorks and Inventor first and stopped with nothing in it.
 */
test('a Workday skills box leads with what the posting asks for, and carries taxonomy spellings', () => {
  const profile = { answers: { skills: 'SolidWorks, Autodesk Inventor, GD&T, FEA, Python, PLC' } };
  const { actions } = planForm([{ label: 'Type to Add Skills', type: 'prompt', promptKind: 'multi', key: 'formField-skills' }],
    profile, { jd: 'You will write PLC logic and Python scripts for our tools.' });
  const a = actions[0];
  assert.equal(a.action, 'prompt');
  assert.deepEqual(a.values.slice(0, 2).sort(), ['PLC', 'Python'], `the posting's skills first: ${a.values.join(', ')}`);
  assert.equal(a.searchAlts['GD&T'], 'Geometric Dimensioning');
  assert.equal(a.searchAlts.FEA, 'Finite Element');
  assert.equal(a.searchAlts.SolidWorks, undefined, 'no alias where the name is already the taxonomy name');
  assert.equal(a.skills, true);
});

/** WORKDAY'S WEBSITES SECTION GETS THE PORTFOLIO (F-553, 2026-09-24). */
test('a reported Websites section is planned with his portfolio, and only when he has one', () => {
  const sections = [{ kind: 'website', filled: false, hasAdd: true, count: 0 }];
  const withIt = planForm([], { identity: { portfolio: 'alexrivera.example' } }, { sections }).entries;
  assert.deepEqual(withIt, [{ kind: 'website', entries: [{ url: 'alexrivera.example' }] }]);
  assert.deepEqual(planForm([], { identity: {} }, { sections }).entries, [], 'nothing to add, nothing touched');
  assert.deepEqual(planForm([], { identity: { portfolio: 'x.com' } }, { sections: [{ kind: 'website', filled: true }] }).entries, [], 'a filled section is left alone');
});

/**
 * TONIGHT'S FOUR WORKDAY FORMS, REPLAYED (2026-09-24). KLA, ABB, Viavi and TD
 * Synnex, read back from the answer log: every field he had to fix by hand.
 */
test('the Workday fields he fixed by hand on 2026-09-24 are answered', () => {
  const P = {
    eeo: { hispanic: 'No', race: 'Asian', disability: 'No, I do not have a disability', veteran: 'I am not a Veteran.' },
    answers: { employer_agreement: 'No', essential_functions: 'Yes', future_contact: 'Yes',
      notice_period: 'May 2027 (My graduation term)', under_18_permit: 'Not Applicable' },
  };
  // KLA: "regardless of race" sent it to the race rule, which said "Asian".
  const kla = planField({ label: 'Are you Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race?', type: 'select', options: ['Yes', 'No'] }, P);
  assert.equal(kla.value, 'No');
  const wd = planField({ label: 'Are you Hispanic or Latino?', type: 'select', options: ['Hispanic or Latino', 'Not Hispanic or Latino'] }, P);
  assert.equal(wd.value, 'Not Hispanic or Latino', '"No" is the Not-X option');
  // All four: "Please check one of the boxes below:" — the topic is in the boxes.
  const dis = planField({ label: 'Please check one of the boxes below:', type: 'checkbox', required: true,
    options: ['Yes, I have a disability, or have had one in the past', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'] }, P);
  assert.equal(dis.action, 'select');
  assert.match(dis.value, /^No, I do not have a disability/);
  // ABB's questionnaire, answered with his own answers from that form.
  const ask = (label) => planField({ label, type: 'text' }, P).value;
  assert.equal(ask('Do you have any confidentiality, restrictive covenants or patent obligations that would in any way restrict your efforts for our company?'), 'No');
  assert.equal(ask('Have you signed an agreement with any employer(s) that you will not, (a) engage in competition with that former employer, or (b) contact customers of that employer?'), 'No');
  assert.equal(ask('Can you perform the essential functions of the position(s) for which you are applying with or without reasonable accommodation?'), 'Yes');
  assert.equal(ask('Are you willing to be contacted for future job opportunities as well as to receive talent community communications?'), 'Yes');
  assert.equal(ask('If you are successful in this role what would be your notice period?'), 'May 2027 (My graduation term)');
});

test('a split Workday date gets its month, day and year, not the whole date three times', () => {
  const fields = ['month', 'day', 'year'].map((datePart) => ({ label: 'Date', type: 'text', datePart }));
  const { actions } = planForm(fields, { answers: {} });
  const vals = actions.filter((a) => a.action === 'fill').map((a) => a.value);
  if (vals.length) {
    assert.equal(vals.length, 3);
    assert.match(vals[0], /^\d{2}$/, `month: ${vals[0]}`);
    assert.match(vals[1], /^\d{2}$/, `day: ${vals[1]}`);
    assert.match(vals[2], /^\d{4}$/, `year: ${vals[2]}`);
  }
});

// ─────────────────────────────────────────────────────────────────────
// TSMC's SuccessFactors profile form, live 2026-09-24. Every case below was
// answered wrong on his screen.
// ─────────────────────────────────────────────────────────────────────
test('TSMC: a certification row called "Name" / "Institution" stays blank', () => {
  const got = hist(['* Skill', '* Name', 'Description', 'Institution', 'Effective Date', 'Expiration Date']);
  for (const a of got.slice(1)) assert.equal(a.action, 'skip', `${a.label} -> ${a.action} ${a.value}`);
  // A bare "Name" with no certificate dates beside it is still his name.
  const plain = planForm([field({ label: 'Name', required: true })], { ...HISTORY_PROFILE, identity: { ...HISTORY_PROFILE.identity, full_name: 'Test Person' } }).actions[0];
  assert.equal(plain.value, 'Test Person');
});

test('TSMC: "Date Last Used" under a skill is today; with no skill row it is not', () => {
  const got = hist(['* Skill', '* Years of Experience', '* Experience Level', 'Date Last Used']);
  assert.equal(got[3].action, 'fill');
  assert.match(got[3].value, /^\d{2}\/\d{2}\/\d{4}$/);
  const lone = hist(['Date Last Used'])[0];
  assert.notEqual(lone.action, 'fill');
});

test('TSMC: the End Date of a job he still holds is a deliberate blank', () => {
  const rows = [...ROW, ...ROW, ...ROW];
  const got = hist(rows);
  assert.equal(got[15].label, 'End Date');
  assert.equal(got[15].action, 'skip');
  assert.match(got[15].why, /still hold/);
  assert.equal(got[3].value, 'August 2026', 'a finished job keeps its end date');
});

test('TSMC: "Location Desired" is the posting\'s location, not his home', () => {
  const a = planForm([field({ label: 'Location Desired' })], HISTORY_PROFILE, { location: 'Phoenix, AZ, US, 85083' }).actions[0];
  assert.equal(a.value, 'Phoenix, AZ');
  const home = planForm([field({ label: 'Location' })], HISTORY_PROFILE, { location: 'Phoenix, AZ, US' }).actions[0];
  assert.equal(home.value, 'Springfield, Washington', 'a bare Location is still where he lives');
});

test('TSMC: a prose box that mentions school courses is written, not answered with the school', () => {
  const a = planField(field({ label: '* Share with us your experience in process improvements, capacity planning or process optimization from work, school courses or internship.', multiline: true, maxLength: 500, required: true }), HISTORY_PROFILE);
  assert.equal(a.action, 'essay');
});

// ─────────────────────────────────────────────────────────────────────
// Read back from every field he fixed by hand, 2026-09-24.
// ─────────────────────────────────────────────────────────────────────
test('an arbitration agreement checkbox is ticked (Tesla, OpenAI) and review-flagged', () => {
  const a = planField(field({ type: 'checkbox', label: 'I acknowledge and agree to be bound by Tesla’s Arbitration Agreement.', options: ['x'] }), PROFILE);
  assert.equal(a.action, 'check');
  assert.equal(a.review, true);
  const off = planField(field({ type: 'checkbox', label: 'I acknowledge and agree to be bound by the Arbitration Agreement.', options: ['x'] }), { ...PROFILE, answers: { ...PROFILE.answers, arbitration_agreement: 'No' } });
  assert.notEqual(off.action, 'check', 'his "No" turns it off');
  // The consent guard still stands for the rest.
  const sue = planField(field({ type: 'checkbox', label: 'I agree to waive my right to sue this employer', options: ['x'] }), PROFILE);
  assert.notEqual(sue.action, 'check');
});

test('one slot for resume AND cover letter gets the resume (Viavi)', () => {
  const a = planField(field({ type: 'file', label: 'Resume/CV/Cover Letter — Upload a file (5MB max)' }), PROFILE);
  assert.equal(a.action, 'upload');
  const letter = planField(field({ type: 'file', label: 'Cover Letter — Upload a file' }), PROFILE);
  assert.equal(letter.action, 'upload-letter');
});

// SmartRecruiters' experience block, as it stood on Western Digital at 09:32:
// his entries in HIS order, Title and Company already holding values.
const SR_ROW = (title, company, withTo = true) => [
  field({ type: 'prompt', label: 'Title', current: title, required: true }),
  field({ type: 'prompt', label: 'Company', current: company }),
  field({ type: 'prompt', label: 'Office location' }),
  field({ label: 'Description' }),
  field({ label: 'From', required: true }),
  ...(withTo ? [field({ label: 'To', required: true })] : []),
  field({ type: 'checkbox', label: 'I currently work here', options: ['on'] }),
];
const SR_EDU = [
  field({ type: 'prompt', label: 'Institution', current: 'Lakeside University', required: true }),
  field({ label: 'Major' }),
  field({ label: 'From' }), field({ label: 'To' }),
  field({ type: 'checkbox', label: 'I currently attend', options: ['on'] }),
];
const SR_PROFILE = {
  ...HISTORY_PROFILE,
  education_entries: [{ school: 'Lakeside University', degree: 'Bachelor of Science', field_of_study: 'Mechanical Engineering', first_year: 'Aug 2023', last_year: 'May 2099' }],
  work_experience: HISTORY_PROFILE.work_experience.map((j, n) => ({ ...j, description: `description of job ${n + 1}` })),
};

test('SmartRecruiters rows get the job they already name, not the job at their position', () => {
  const fields = [...SR_ROW('Manufacturing Lead', 'Makerspace MTC', false), ...SR_ROW('Mechanical Engineering Intern', 'Acme Steel'), ...SR_ROW('Manufacturing Engineer Intern', 'Applied Materials'), ...SR_EDU];
  const acts = planForm(fields, SR_PROFILE, { sections: [{ kind: 'work', generic: true, filled: false, count: 0 }] });
  const at = (i) => acts.actions[i];
  // Row 1 is Makerspace: its own description, its own start, and "currently work here" ticked.
  assert.equal(at(3).value, 'description of job 3');
  assert.equal(at(4).value, '08/2024');
  assert.equal(at(5).action, 'check');
  // Row 2 is Acme Steel.
  assert.equal(at(9).value, 'description of job 2');
  assert.equal(at(10).value, '05/2025');
  assert.equal(at(11).value, '08/2025');
  assert.equal(at(12).action, 'skip', 'an ended job is not "currently work here"');
  // Row 3 is Applied Materials.
  assert.equal(at(16).value, 'description of job 1');
  // Title and Company that hold something are never typed over.
  assert.equal(at(0).action, 'skip');
  assert.equal(at(1).action, 'skip');
  // The education block's own From/To are the degree, never a job's.
  assert.equal(at(22).value, '08/2023');
  assert.equal(at(23).value, '05/2099');
  assert.equal(at(24).action, 'check');
  // And the section is NOT empty, so nothing is added again (F-562).
  assert.deepEqual(acts.entries, [], 'entries already on the page are not entered a second time');
});

test('an empty SmartRecruiters section still gets his entries', () => {
  const acts = planForm([field({ label: 'First name' })], SR_PROFILE, { sections: [{ kind: 'work', generic: true, filled: false, count: 0 }] });
  assert.equal(acts.entries.length, 1);
  assert.equal(acts.entries[0].kind, 'work');
});

test('the employer and the job location survive a built resume\'s titles', () => {
  // Every real application carries titles from its resume; rebuilding the
  // profile for them used to drop applyingTo and jobLocation (2026-09-24).
  const acts = planForm([
    field({ type: 'prompt', label: 'Select your desired work locations in the U.S.:', options: [] }),
    field({ label: 'Have you ever worked at Applied Materials as an employee or intern?', type: 'select', options: ['Yes', 'No'] }),
  ], HISTORY_PROFILE, { company: 'Applied Materials', location: 'San Jose, CA, United States', titles: [['Applied Materials', 'Automation Engineer Intern']] }).actions;
  assert.deepEqual(acts[0].values.slice(0, 2), ['San Jose, CA', 'San Jose']);
  assert.equal(acts[1].value, 'Yes', 'his own employer, known with titles applied');
});

test('Breezy rows: date inputs get ISO dates, and an education row\'s Start date is the degree\'s', () => {
  // 2026-09-24: "May 2026" into <input type="date"> was refused, and the
  // education row's "Start date" was answered with his availability.
  const acts = planForm([
    field({ label: 'Company' }), field({ label: 'Title' }),
    field({ label: 'Start date', type: 'date' }), field({ label: 'End date', type: 'date' }),
    field({ label: 'School' }), field({ label: 'Field of Study' }),
    field({ label: 'Start date', type: 'date' }), field({ label: 'End date', type: 'date' }),
  ], SR_PROFILE).actions;
  assert.equal(acts[2].value, '2026-05-01');
  assert.equal(acts[3].value, '2026-08-01');
  assert.equal(acts[6].value, '2023-08-01', 'the degree started in August 2023');
  assert.equal(acts[7].value, '2099-05-01');
});

test('AN ANSWER LONGER THAN ITS BOX is cut to its leading clause for review, or left with the reason (F-569)', () => {
  // Rippling's salary box takes 50 characters; his salary line is 54, and the
  // page would have cut it mid-word (Cintal, 2026-09-24).
  const P = { ...PROFILE, answers: { ...PROFILE.answers, salary_expectation: 'Open — targeting market rate for the role and location' } };
  const cut = planField(field({ label: 'What is your salary expectation?', maxLength: 50, required: true }), P);
  assert.equal(cut.action, 'fill');
  assert.equal(cut.value, 'Open');
  assert.equal(cut.review, true, 'a shortened answer is his to check');
  const whole = planField(field({ label: 'What is your salary expectation?', required: true }), P);
  assert.equal(whole.value, 'Open — targeting market rate for the role and location', 'no limit, no cut');
  const none = planField(field({ label: 'First Name', maxLength: 2 }), PROFILE);
  assert.equal(none.action, 'unknown', 'nothing short enough: his, with the reason');
  assert.match(none.why, /takes 2/);
  assert.equal(planField(field({ label: 'Phone', type: 'tel', maxLength: 10 }), PROFILE).value, '5550000000', 'a phone still takes its digits');
});

test('GREENHOUSE SPLIT DATES: month menus and year boxes, for the job and for the degree (Lyft, F-572)', () => {
  // Measured 2026-09-24 on Lyft's Greenhouse form: "Start date month" and
  // "Start date year" were answered with his availability, "June 2027
  // (graduating May 2027)", in the job row and the education row alike.
  const P = { ...SR_PROFILE, answers: { ...SR_PROFILE.answers, earliest_start: 'June 2027 (graduating May 2027)' } };
  const f = (label, type = 'text') => field({ label, type });
  const acts = planForm([
    f('Company name'), f('Title'), f('Start date month', 'prompt'), f('Start date year'), f('End date month', 'prompt'), f('End date year'),
    f('School', 'prompt'), f('Degree', 'prompt'), f('Start date month', 'prompt'), f('Start date year'), f('End date month', 'prompt'), f('End date year'),
  ], P).actions.map((a) => [a.action, a.value]);
  assert.deepEqual(acts.slice(2, 6), [['prompt', 'May'], ['fill', '2026'], ['prompt', 'August'], ['fill', '2026']], 'the job\'s own dates');
  assert.deepEqual(acts.slice(8), [['prompt', 'August'], ['fill', '2023'], ['prompt', 'May'], ['fill', '2099']], 'the degree\'s own dates');
  assert.ok(!acts.some(([, v]) => /June 2027/.test(String(v))), 'his availability goes nowhere near a date row');
});

test('WORK AUTHORIZATION AS STATEMENTS takes the sponsorship one; "may we contact" is not a name (F-572)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, authorized_to_work_us: 'Yes', require_sponsorship: 'Yes', current_company: 'Makerspace MTC' } };
  const opts = ['I am authorized to work for any employer in the country in which this position is based.', "I require/will require Lyft's sponsorship to obtain work authorization."];
  assert.equal(planField(field({ label: 'Work Authorization', type: 'select', options: opts }), P).value, opts[1]);
  assert.equal(planField(field({ label: 'Are you legally authorized to work in the United States?', type: 'select', options: ['Yes', 'No'] }), P).value, 'Yes', 'a Yes/No list still says Yes');
  assert.equal(chooseOption('I require sponsorship', ['I do not require sponsorship', 'I am authorized']), -1, 'a negated statement is never it');
  const contact = planField(field({ label: 'May we contact your current employer?', type: 'select', options: ['Yes', 'No'] }), P);
  assert.notEqual(contact.value, 'Makerspace MTC');
  assert.equal(contact.action, 'unknown', 'a permission his profile does not give is his');
});

test('LYFT: the linked-document acknowledgement is taken, and "employed by Lyft in the past" is No (F-572)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, data_processing_consent: 'Yes', previously_employed_here: 'No' }, work_experience: [{ company: 'Applied Materials', title: 'Intern' }] };
  const ack = ['I acknowledge that I have read and understood the terms of the Lyft Candidate Privacy Notice.'];
  assert.equal(planField(field({ label: 'Please review the linked document:', type: 'select', options: ack, required: true }), P).value, ack[0]);
  const past = (co) => planForm([field({ label: `Have you been employed by ${co}, or any subsidiary, affiliate, or business unit of ${co}, in the past (whether on a full-time or part-time basis)?`, type: 'select', options: ['Yes', 'No'], required: true })], P, { company: co }).actions[0].value;
  assert.equal(past('Lyft'), 'No');
  assert.equal(past('Applied Materials'), 'Yes', 'he interned there');
});

test('WAYMO: "Never worked at Alphabet" is his No, and "Another State in the US" is his state (F-575)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, previously_employed_here: 'No' } };
  const al = ['', 'Current Alphabet Employee or Intern', 'Former Alphabet Employee or Intern', 'Current or Former member of Alphabet extended workforce', 'Never worked at Alphabet'];
  assert.equal(planForm([field({ label: 'Are you a current or former Alphabet employee, intern, vendor, contractor, or TVC?', type: 'select', options: al, required: true })], P, { company: 'Waymo' }).actions[0].value, 'Never worked at Alphabet');
  const st = (options) => planForm([field({ label: 'Please provide the state/region in which you currently reside.', type: 'select', options, required: true })], P).actions[0];
  assert.equal(st(['', 'New York', 'Illinois', 'Another State in the US', 'APAC', 'EMEA', 'Other']).value, 'Another State in the US');
  assert.equal(st(['', 'California', 'Washington', 'Other US state']).value, 'Washington', 'his own state first');
  assert.equal(st(['', 'New York', 'Illinois', 'APAC', 'EMEA', 'Other']).action, 'unknown', 'never a bare "Other"');
});

test('AST / ASM: English, drawings, citizenship country and a verification consent; duration claims stay his (F-576)', () => {
  const P = {
    ...PROFILE,
    languages: [{ name: 'English', proficiency: 'Fluent' }],
    answers: { ...PROFILE.answers, citizenship_country: 'Vietnam', skills: 'SolidWorks, GD&T' },
    work_experience: [{ company: 'Applied Materials', title: 'Intern', description: 'created the engineering drawings and BOM' }],
  };
  const v = (label) => { const a = planField(field({ label, type: 'select', options: ['Yes', 'No'], required: true }), P); return a.action === 'unknown' ? 'unknown' : a.value; };
  assert.equal(v('Do you meet the language requirements for this position (fluent in written and verbal English)?'), 'Yes');
  assert.equal(v('Are you able to read and interpret technical drawings, blueprints, or work instructions?'), 'Yes');
  assert.equal(planField(field({ label: 'Are you able to read and interpret technical drawings?', type: 'select', options: ['Yes', 'No'] }), { ...P, answers: { ...P.answers, skills: 'Python' }, work_experience: [] }).action, 'unknown', 'no drawing evidence in his files, no Yes');
  assert.equal(v('Do you have at least 1 year of hands-on experience assembling or disassembling mechanical components in a manufacturing, automotive, or industrial environment?'), 'unknown');
  assert.equal(planField(field({ label: 'Please select the country where you hold citizenship / permanent residency', type: 'select', options: ['Canada', 'Vietnam'] }), P).value, 'Vietnam');
  assert.equal(planField(field({ label: 'I hereby authorize ASM to contact, obtain and verify the accuracy of information contained in this application', type: 'select', options: ['Yes', 'No'], required: true }), P).value, 'Yes');
});

test('iCIMS RESIDENCY BOX: ticked for a job in that state, never for a place he does not live (Werfen, 2026-09-24)', () => {
  const CA = 'If you are a California (CA) resident, or applying for a position in CA, please check this box.';
  const box = (label, location) => planForm([field({ label, type: 'checkbox', options: ['on'] })], PROFILE, { location }).actions[0];
  assert.equal(box(CA, 'San Diego, CA').action, 'check', 'Werfen\'s job is in San Diego');
  assert.equal(box(CA, 'Springfield, WA').action, 'skip');
  assert.equal(box(CA, null).action, 'skip');
  const EU = 'If you are a European Union (EU) or United Kingdom (UK) resident, please check this box.';
  assert.equal(box(EU, 'London, United Kingdom').action, 'skip', 'the job\'s place does not count when the box asks only where he lives');
  assert.equal(planForm([field({ label: EU, type: 'checkbox', options: ['on'] })], { ...PROFILE, identity: { ...PROFILE.identity, location: 'Springfield, Washington, United States' } }).actions[0].action, 'skip', '"United" of United Kingdom never matches his United States');
});

test('iCIMS PRIVACY: a box whose own words are "I accept" is ticked, whatever sentence sits over it', () => {
  const a = planForm([field({ label: 'Click here if you are an employee of Werfen applying to a position in California. — I accept', type: 'checkbox', options: ['on'] })], PROFILE).actions[0];
  assert.equal(a.action, 'check');
  const b = planForm([field({ label: 'I agree that I am a U.S. citizen', type: 'checkbox', options: ['on'] })], PROFILE).actions[0];
  assert.notEqual(b.action, 'check', 'a sentence that goes on to state a fact is not a bare acceptance');
});

test('AN "IF YES" UNDER A QUESTION ANSWERED NO does not apply — Western Digital, 2026-09-25', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, relatives_at_company: 'No' } };
  const fields = [
    { label: 'Do you have a Family or Close Friend relationship with anyone employed by WD?', type: 'radio', options: ['Yes', 'No'], required: true },
    { label: 'If yes, please provide their name(s), their relationship to you and department(s) they work in (if known):', type: 'text', options: [], required: true },
    { label: 'Do you have, or expect to have, any outside business activities that may give the appearance of a conflict of interest with WD?', type: 'radio', options: ['Yes', 'No'], required: true },
    { label: 'If yes, please provide a list/details of the potential conflict of interest:', type: 'text', options: [], required: true },
  ];
  const plan = planForm(fields, P);
  const acts = plan.actions || plan;
  assert.equal(acts[0].value, 'No');
  assert.equal(acts[1].action, 'skip', 'the follow-up under a No is not a gap');
  assert.match(acts[1].why, /does not apply/);
  assert.equal(acts[3].action, 'unknown', 'under a question with no answer, it is still his');
});

test('HIS OWN PAST ANSWER fills a question no rule knows — Intel questionnaire, 2026-09-25', () => {
  const past = (label, company) => (/ernst & young/i.test(label) && /intel/i.test(company) ? { answer: 'No', company: 'Intel', at: '2026-09-25T09:00:00Z' } : null);
  const P = { ...PROFILE, pastAnswer: past };
  const f = [{ label: '3)* Are you an immediate family member of a partner at Ernst & Young who is based out of the San Jose office?', type: 'radio', options: ['Yes', 'No'], required: true }];
  const a = planForm(f, P, { company: 'Intel' }).actions[0];
  assert.equal(a.action, 'select'); assert.equal(a.value, 'No');
  assert.ok(a.review, 'always for his review');
  const other = planForm(f, P, { company: 'KLA' }).actions[0];
  assert.equal(other.action, 'unknown', 'another employer does not get Intel\'s answer');
  const noPast = planForm(f, PROFILE, { company: 'Intel' }).actions[0];
  assert.equal(noPast.action, 'unknown', 'without his answers, exactly as before');
});

test('TWO LOOK-ALIKE FILE SLOTS are told apart by the words above them — Boom Supersonic (Rippling), 2026-09-25', () => {
  const fields = [
    { label: 'Drop or select (.doc / .docx / .pdf)', type: 'file', required: true, near: 'Résumé*Total 0 file selectedDrop or select (.doc / .docx / .pdf)' },
    { label: 'Drop or select (.doc / .docx / .pdf)', type: 'file', required: false, near: 'Cover letterTotal 0 file selectedDrop or select (.doc / .docx / .pdf)' },
  ];
  const [cv, letter] = planForm(fields, PROFILE).actions;
  assert.equal(cv.action, 'upload');
  assert.equal(letter.action, 'upload-letter');
});

test('Rippling start, BambooHR in-person, and option CODES — 2026-09-25', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, earliest_start: 'June 2027 (graduating May 2027)', willing_onsite: 'Yes' } };
  const acts = planForm([
    { label: 'When could you realistically start full time?', type: 'radio', options: ['Right Now', 'January 2027', 'June 2027'] },
    { label: 'Do you understand that this is an in-person role based in Colorado? * — Yes', type: 'radio', options: ['Yes', 'No'] },
  ], P).actions;
  assert.equal(acts[0].value, 'June 2027');
  assert.equal(acts[1].value, 'Yes');
  assert.equal(chooseOption('I am not a Veteran.', ['declineToAnswer', 'notVeteran', 'veteran']), 1, 'a camelCase code reads as its words');
  assert.equal(chooseOption('Mechanical Engineering', ['McKinsey', 'Mechanical Engineering']), 1, 'real text is untouched');
});

test('A GRADUATE DEGREE HE DOES NOT HAVE stays empty — Eight Sleep, 2026-09-25', () => {
  const acts = planForm([
    { label: 'Major (Undergraduate)', type: 'text' },
    { label: 'Major (Graduate)', type: 'text' },
    { label: 'GPA (Graduate)', type: 'number' },
    { label: 'Graduation Date (Graduate)', type: 'text' },
    { label: 'Expected graduation year for your highest planned degree', type: 'radio', options: ['2026', '2027', '2028'] },
  ], { ...PROFILE, education: { ...PROFILE.education, graduation_year: '2027' } }).actions;
  assert.equal(acts[0].action, 'fill', 'his own degree still fills');
  for (const a of acts.slice(1, 4)) assert.equal(a.action, 'skip', `${a.label} claims a graduate degree`);
  assert.equal(acts[4].value, '2027', 'a graduation YEAR is a year, not "Bachelor\'s"');
});

test('Penumbra (Lever), 2026-09-25: a race list labelled by its first option; "ever been a <company> employee"; agency temp', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, previously_employed_here: 'No', worked_via_agency: 'No' }, eeo: { ...(PROFILE.eeo || {}), race: 'Asian' } };
  const acts = planForm([
    { label: 'Are you now or have you ever been a Penumbra employee?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Are you now or have you ever been a temporary employee of Penumbra (employed at Penumbra by a 3rd party agency or vendor)?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Hispanic or LatinoA person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race.', type: 'radio',
      options: ['Hispanic or Latino', 'White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', 'Decline to self-identify'] },
  ], P, { company: 'Penumbra, Inc.' }).actions;
  assert.equal(acts[0].value, 'No');
  assert.equal(acts[1].value, 'No');
  assert.match(String(acts[2].label), /^Race/, 'read as the race question');
});

test('his past answer is used where the rule answer fits no option — Lexington Medical GPA ranges, 2026-09-25', () => {
  const past = (label, company) => (/gpa/i.test(label) && /lexington/i.test(company) ? { answer: '3.6-3.8', company: 'Lexington Medical', at: '2026-09-24' } : null);
  const f = [{ label: 'What was the range of your undergraduate GPA, based on 4.0 scale?', type: 'radio', options: ['3.9 or above', '3.6-3.8', 'Below 3.6'] }];
  const P = { ...PROFILE, education: { ...PROFILE.education, gpa: '3.85' }, pastAnswer: past };
  assert.equal(planForm(f, P, { company: 'Lexington Medical' }).actions[0].value, '3.6-3.8');
  // Elsewhere the rounding-gap rule decides (2026-09-25, round nine): 3.85
  // sits between "3.6-3.8" and an open-ended "3.9 or above", and the lower
  // band never overstates — the one he picked himself. Always for review.
  const other = planForm(f, P, { company: 'Other Co' }).actions[0];
  assert.equal(other.value, '3.6-3.8');
  assert.equal(other.review, true, 'a band his files do not state is his to look at');
});

test('Intel (Workday), 2026-09-25: "previously been DIRECTLY employed" is the prior-employment question', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, previously_employed_here: 'No' } };
  const acts = planForm([
    { label: 'Are you currently or have you previously been directly employed, accepted an offer, or contracted with Intel or an Intel subsidiary?', type: 'radio', options: ['Yes', 'No'] },
  ], P, { company: 'Intel' }).actions;
  assert.equal(acts[0].value, 'No');
});

test('Formlabs, 2026-09-25: an optional portfolio FILE is skipped when his portfolio is online; a required one is his', () => {
  const P = { ...PROFILE, identity: { ...PROFILE.identity, portfolio: 'alexrivera.example' } };
  const label = 'If your portfolio is not available online, please attach it here — Attach';
  const [opt] = planForm([{ label, type: 'file' }], P, { company: 'Formlabs' }).actions;
  assert.equal(opt.action, 'skip');
  const [req] = planForm([{ label, type: 'file', required: true }], P, { company: 'Formlabs' }).actions;
  assert.equal(req.action, 'unknown');
});

test('ASM (Greenhouse embed), 2026-09-25: an authorization statement is not a school; "Viet Nam"; his study start from his profile', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, citizenship_country: 'Vietnam' },
    education_entries: [{ school: 'Lakeside University', degree: 'Bachelor of Science', field_of_study: 'Mechanical Engineering', first_year: 'Aug 2023', last_year: 'May 2027' }] };
  const acts = planForm([
    { label: 'I hereby authorize ASM to contact, obtain and verify the accuracy of information contained in this application from all previous employers, educational institutions and references.', type: 'prompt' },
    { label: 'Please select the country where you hold citizenship / permanent residence.', type: 'prompt' },
    { label: 'School', type: 'prompt', id: 'school--0' },
    { label: 'Start date month', type: 'prompt', id: 'start-month--0' },
    { label: 'Start date year', type: 'number', id: 'start-year--0' },
  ], P, { company: 'ASM' }).actions;
  assert.equal(acts[0].value, 'Yes', 'a consent, never "Lakeside University"');
  assert.ok(acts[1].values.includes('Viet Nam'), 'the ISO spelling is tried after his own');
  assert.equal(acts[3].value, 'August');
  assert.equal(acts[4].value, '2023');
});


test('ASM, 2026-09-25: a verification consent whose statement says "I agree" is still his standing yes; Harbinger’s "If you do not …" relocation', () => {
  const acts = planForm([
    { label: "I hereby authorize ASM to contact, obtain and verify the accuracy of information contained in this application from all previous employers, educational institutions and references. I also release from liability ASM and its representatives for seeking, gathering and using such information to make employment decision and all other persons or organization for providing such information. I understand that ASM reserves the right to and I agree that it may inquire further on any matter bearing on the company’s export compliance obligations. In order to verify the information provided, I understand that ASM will require me to present an original document issued by a government agency confirming my citizenship / residency status as indicated above. I declare that the information provided in the employment application is true and complete. I understand that any misrepresentation and omission made by me on this application will be sufficient cause of cancellation of this application or immediate termination of employment if I am employed, whenever it may be discovered.", type: 'prompt' },
    { label: 'If you do not currently reside near the location in which this role is located, are you willing to relocate?', type: 'prompt' },
    { label: 'If you were referred by a Cornelis Network’s employee, input the employee’s name here. If not, put N/A.', type: 'text' },
  ], { ...PROFILE, answers: { ...PROFILE.answers, willing_to_relocate: 'Yes' } }, { company: 'ASM' }).actions;
  assert.equal(acts[0].value, 'Yes');
  assert.equal(acts[0].review, true, 'a consent is always his to look at');
  assert.equal(acts[1].value, 'Yes');
  assert.notEqual(acts[2].why, 'only applies if the question above it applies to you', 'a label that answers its own no is read whole');
});

test('Boom (Rippling), 2026-09-25: a split date with no day in his files is one item for him, not two boxes the page clears', () => {
  const L = 'Please share your anticipated graduation date. If you have already graduated, please indicate when.';
  const P = { ...PROFILE, education: { ...(PROFILE.education || {}), graduation: 'May 2027' } };
  const acts = planForm([
    { label: L, type: 'text', datePart: 'month', maxLength: 2 },
    { label: L, type: 'text', datePart: 'day', maxLength: 2 },
    { label: L, type: 'text', datePart: 'year', maxLength: 4 },
  ], P, { company: 'Boom Supersonic' }).actions;
  assert.deepEqual(acts.map((a) => a.action), ['skip', 'unknown', 'skip']);
  assert.match(acts[1].why, /no day/);
});

test('HP (Workday), 2026-09-26: a split START date takes the month\'s first day, never the whole sentence in each box', () => {
  const L = 'When are you available to start?';
  const P = { ...PROFILE, answers: { ...PROFILE.answers, earliest_start: 'June 2027 (graduating May 2027)' } };
  const acts = planForm(['month', 'day', 'year'].map((datePart) => ({ label: L, type: 'text', datePart })), P, { company: 'HP Inc.' }).actions;
  assert.deepEqual(acts.map((a) => `${a.action}:${a.value}`), ['fill:06', 'fill:01', 'fill:2027'], 'he typed 06 / 01 / 2027 himself');
  assert.equal(acts[1].review, true);
  // …while a plain box still gets his sentence whole.
  assert.equal(planForm([{ label: L, type: 'text' }], P, {}).actions[0].value, 'June 2027 (graduating May 2027)');
});

test('Ashby education history, 2026-09-25: month and year LISTS are chosen from, "Still Student?" is ticked; a follow-up to an answer he did not give does not apply', () => {
  const P = { ...PROFILE, education_entries: [{ school: 'Lakeside University', degree: 'Bachelor of Science', field_of_study: 'Mechanical Engineering', first_year: 'Aug 2023', last_year: 'May 2027' }] };
  const M = ['Month', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const Y = ['Year', ...Array.from({ length: 40 }, (_, i) => String(2032 - i))];
  const acts = planForm([
    { label: 'School', type: 'prompt' },
    { label: 'Start Date month', type: 'select', options: M }, { label: 'Start Date year', type: 'select', options: Y },
    { label: 'End Date month', type: 'select', options: M }, { label: 'End Date year', type: 'select', options: Y },
    { label: 'Degree — Still Student?', type: 'checkbox', options: ['Still Student?'] },
    { label: 'How did you hear about us?', type: 'select', options: ['LinkedIn', 'Search engine', 'Other'] },
    { label: 'If you chose "search engine", "conference", or "other", please specify here.', type: 'text' },
  ], P, { company: 'Applied Intuition' }).actions;
  assert.deepEqual(acts.slice(1, 5).map((a) => [a.action, a.value]), [['select', 'August'], ['select', '2023'], ['select', 'May'], ['select', '2027']]);
  assert.equal(acts[5].action, 'check');
  assert.equal(acts[7].action, 'skip', 'he answered LinkedIn');
});

test('Atomic Semi, 2026-09-25: "I am one of the following: (a) a citizen … (b) a lawful permanent resident … (c) … asylee or refugee" is the U.S.-person question — never work authorization', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, us_person: 'No', work_authorized_us: 'Yes' } };
  const [a] = planForm([{ label: 'I am one of the following: (a) a citizen of the United States; (b) a lawful permanent resident of the United States; or (c) a person admitted into the United States as an asylee or refugee:', type: 'radio', options: ['Yes', 'No'] }], P, { company: 'Atomic Semi' }).actions;
  assert.equal(a.value, 'No');
  assert.equal(a.review, true);
});

test('round nine, 2026-09-25: senior in January 2027 from his graduation date; internships from his history; CAD by its examples; an in-office statement', () => {
  const P = { ...PROFILE, education: { ...(PROFILE.education || {}), graduation: 'May 2027' },
    work_experience: [{ title: 'Manufacturing Engineer Intern (Automation)', company: 'Applied Materials' }],
    answers: { ...PROFILE.answers, skills: 'SolidWorks, GD&T, Python', willing_onsite: 'Yes' } };
  const acts = planForm([
    { label: 'Will you be a rising Senior or Senior in January 2027?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Will you be a rising Senior or Senior in January 2029?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Do you have previous internship or Co-Op experience?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Do you have experience with CAD software (e.g., SolidWorks, Creo, AutoCAD)?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'This is an in-office position.', type: 'text', required: true },
  ], P, { company: 'Lexington Medical' }).actions;
  assert.deepEqual(acts.map((a) => a.value), ['Yes', 'No', 'Yes', 'Yes', 'Yes']);
});

test('a date picker\'s "Pick date..." takes his availability as a date (Atomic Semi, 2026-09-25)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, earliest_start: 'June 2027 (graduating May 2027)' } };
  const [a] = planForm([{ label: 'Ideal start date in office', type: 'text', required: true, placeholder: 'Pick date...' }], P, { company: 'Atomic Semi' }).actions;
  assert.equal(a.value, '06/01/2027');
  assert.equal(a.review, true);
});

test('"is your home country listed below?" is answered from his citizenship and the list the form prints (Atomic Semi, 2026-09-25)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, citizenship_country: 'Vietnam' } };
  const L = 'If no, is your home country listed below?';
  const plan = (near) => planForm([{ label: L, type: 'radio', options: ['Yes', 'No'], near }], P, { company: 'Atomic Semi' }).actions[0];
  const on = plan(`${L} Armenia, Belarus, China, Cuba, Vietnam, Yemen Yes No`);
  assert.equal(on.value, 'Yes'); assert.equal(on.review, true);
  assert.equal(plan(`${L} Armenia, Belarus, China, Cuba Yes No`).value, 'No');
  assert.notEqual(plan(`${L} Yes No`).action, 'select', 'no printed list, no answer');
});

test('Sabanto (Breezy), 2026-09-25: a salary with a currency list beside it — the list gets US Dollar, the box the number; the no-contracting statement is acknowledged', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, salary_expectation: '$90000/year' } };
  const acts = planForm([
    { label: 'Desired Salary', type: 'text' },
    { label: 'Desired Salary', type: 'select', options: ['', 'US Dollar ($)', 'Canadian Dollar ($)', 'Euro (€)'] },
    { label: 'This position is not open for any type of Contracting.', type: 'select', options: ['', 'YES', 'NO'], required: true },
    { label: 'What are your salary expectations?', type: 'text' },
  ], P, { company: 'Sabanto' }).actions;
  assert.deepEqual(acts.map((a) => a.value), ['90000', 'US Dollar ($)', 'YES', '$90000/year']);
  assert.ok(acts.slice(0, 3).every((a) => a.review));
});

test('a salary\'s pay-period list takes Yearly for a per-year figure (Sabanto, 2026-09-25)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, salary_expectation: '$90000/year' } };
  const [a] = planForm([{ label: 'Desired Salary — period', type: 'select', options: ['Hourly', 'Weekly', 'Monthly', 'Yearly'] }], P, { company: 'Sabanto' }).actions;
  assert.equal(a.value, 'Yearly');
});

test('his answers of 2026-09-25: relinquished citizenship, active immigration case, first generation, graduate school — each in the shape the form asks', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, relinquished_citizenship: 'No', active_immigration_case: 'No', first_generation: 'No',
    graduate_school_plans: ['I plan to go into industry first and may consider graduate school later.', 'No, I plan to go directly to industry after my undergraduate degree', 'No'] } };
  const G = ["Yes, I'm currently in a graduate program", 'No, I plan to go directly to industry after my undergraduate degree', 'Yes, I plan to pursue a PhD', "I'm uncertain"];
  const acts = planForm([
    { label: 'Have you ever relinquished, abandoned, or lost citizenship, nationality or permanent residence in the country identified in the previous question?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Do you currently have an active immigration case (ex H-1B extension, green card)?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Are you a first generation college student?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Do you plan to go to graduate school?', type: 'select', options: G },
    { label: 'Do you plan to go to graduate school?', type: 'text' },
  ], P, { company: 'Vast' }).actions;
  assert.deepEqual(acts.map((a) => a.value), ['No', 'No', 'No', 'No, I plan to go directly to industry after my undergraduate degree', 'I plan to go into industry first and may consider graduate school later.']);
  assert.ok(acts.every((a) => a.review));
});

test('his own skill ratings answer a self-rating list; an unrated skill stays his; co-op availability from his answer (2026-09-25)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, skill_levels: { cad: 'Intermediate', gdt: 'Intermediate' }, internship_availability: 'No' } };
  const lv = (s) => [`${s} - Expert`, `${s} - Intermediate`, `${s} - Beginner`, `${s} - No experience`];
  const acts = planForm([
    { label: 'Please describe your experience with CAD Software:', type: 'select', options: lv('CAD Software') },
    { label: 'Please describe your experience with GD&T:', type: 'select', options: lv('GD&T') },
    { label: 'Please describe your experience with ANSYS FEA/FEM:', type: 'select', options: lv('ANSYS FEA/FEM') },
    { label: 'Are you available to work January 2027 – June 2027 (6-month Co-Op)?', type: 'radio', options: ['Yes', 'No'] },
  ], P, { company: 'Vast' }).actions;
  assert.equal(acts[0].value, 'CAD Software - Intermediate');
  assert.equal(acts[1].value, 'GD&T - Intermediate');
  assert.notEqual(acts[2].action, 'select', 'ANSYS is not rated in this profile');
  assert.equal(acts[3].value, 'No');
});

test('Capstan Medical (Lever), 2026-09-26: commuting to an office he does not live near is No — never "Yes" from his willingness to relocate; "willing to relocate and commute" is still Yes; location over a country list; Lever\'s Other link', () => {
  const P = { ...PROFILE, identity: { ...PROFILE.identity, city: 'Springfield', state: 'Washington', country: 'United States of America' }, answers: { ...PROFILE.answers, willing_to_relocate: 'Yes' } };
  const C = ['Select...', ...'Afghanistan Albania Algeria Andorra Angola Argentina Armenia Australia Austria Belgium Brazil Canada Chile China France Germany India Japan Mexico'.split(' '), 'United States', 'Vietnam'];
  const acts = planForm([
    { label: 'Are you able to commute to our Santa Cruz office without having to relocate?', type: 'radio', options: ['Yes', 'No - I would need to relocate in order to work in Santa Cruz office'] },
    { label: 'Are you willing to relocate and commute to our facilities on a daily basis?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Are you able to commute to our Springfield office?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'What is your location?', type: 'select', options: C },
    { label: 'Capstan Medical, Inc.', type: 'text', name: 'urls[Other]' },
  ], P, { company: 'Capstan Medical' }).actions;
  assert.match(acts[0].value, /^No - I would need to relocate/);
  assert.equal(acts[0].review, true);
  assert.equal(acts[1].value, 'Yes');
  assert.notEqual(acts[2].value, 'No', 'his own city is his to answer');
  assert.equal(acts[3].value, 'United States');
  assert.equal(acts[4].action, 'skip');
});

test('round eleven, 2026-09-26: a clearance list ticks only "Never held a clearance"; "EXPORT COMPLIANCE" is the U.S.-person question, answered plainly', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, us_person: 'No' } };
  const acts = planForm([
    { label: 'While a security clearance is not required, please let us know if you currently hold one or would be open to obtaining one:', type: 'checkbox', options: ['Top Secret SCI with Polygraph', 'Secret', 'Expired Clearance', 'Open to obtaining', 'Never held a clearance', 'Do not wish to disclose'] },
    { label: 'Clearance Eligibility', type: 'select', options: ['Top Secret', 'Secret', 'DOE Level Q', 'Expired Clearance'] },
    { label: 'EXPORT COMPLIANCE', type: 'select', options: ['I am currently a “U.S. Person”', 'I am not a “U.S. Person"'] },
    { label: 'Which applies to you?', type: 'radio', options: ['I am currently a "U.S. Person"', 'I will soon become a "U.S. Person" (requires explanation if selected)', 'I am not a "U.S. Person," but I am eligible for licensing (requires explanation if selected)'] },
  ], P, { company: 'Astranis' }).actions;
  assert.equal(acts[0].value, 'Never held a clearance');
  assert.notEqual(acts[1].action, 'select', 'no "none" option: his');
  assert.match(acts[2].value, /^I am not a/);
  assert.notEqual(acts[3].action, 'select', 'never claims licensing eligibility');
});

test('round twelve, 2026-09-26: "U.S. citizen?" from his citizenship; on-site confirmation; a race list whose label swallowed Gender; the posting\'s own location; an instruction box', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, citizenship_country: 'Vietnam', willing_onsite: 'Yes' } };
  const YN = ['Yes', 'No'];
  const R = ['Hispanic or Latino', 'White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', 'Two or More Races (Not Hispanic or Latino)'];
  const acts = planForm([
    { label: 'Are you a citizen of the United States? * — Yes', type: 'radio', options: YN },
    { label: 'Please confirm that you understand this is an onsite position. * — Yes', type: 'radio', options: YN },
    { label: 'Race — GenderSelect ...MaleFemaleDecline to self-identify — Hispanic or Latino', type: 'radio', options: R },
    { label: 'Which location are you applying for?', type: 'select', options: ['Select...', 'Duluth, Minnesota', 'Bloomington, Minnesota'], required: true },
    { label: 'Please answer all of the questions so we can process your applications', type: 'text', multiline: true, required: true },
  ], { ...P, eeo: { ...(PROFILE.eeo || {}), race: 'Asian' } }, { company: 'TKDA', location: 'Duluth, Minnesota' }).actions;
  assert.equal(acts[0].value, 'No');
  assert.equal(acts[0].review, true);
  assert.equal(acts[1].value, 'Yes');
  assert.equal(acts[2].value, 'Asian (Not Hispanic or Latino)');
  assert.equal(acts[3].value, 'Duluth, Minnesota');
  assert.equal(acts[4].value, 'Understood.');
});

test('round thirteen, 2026-09-26: "at least 5 years?" over Yes/No is the comparison, not the figure; right to work shown by documents after an offer', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, years_experience: '2 years', can_verify_right_to_work: 'Yes' } };
  const YN = ['Yes', 'No'];
  const acts = planForm([
    { label: 'Do you have at least 5 years of practical career experience in this field?', type: 'radio', options: YN },
    { label: 'Can you, after receipt of an employment offer, present documents showing that you have a right to lawfully work in the country where the job is located?', type: 'radio', options: YN },
  ], P, { company: 'Pronto' }).actions;
  assert.equal(acts[1].value, 'Yes');
  assert.notEqual(acts[0].value, 'Yes', 'never claims five years');
});

test('"at least 5 years?" as a dropdown whose options only the page sees is still the comparison (Pronto, 2026-09-26)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, years_experience: '2 years' } };
  const [a] = planForm([{ label: 'Do you have at least 5 years of practical career experience in this field?', type: 'prompt' }], P, {}).actions;
  assert.notEqual(a.value, 'Yes');
});

test('round fourteen, 2026-09-26: "Current / Most Recent" company and title; a co-op-only box; protected individual as Yes/No; "If other or referred please specify"', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, current_company: 'Lakeside University', current_title: 'Manufacturing Lead', protected_individual: 'None of the above' } };
  const acts = planForm([
    { label: 'Transcripts (if applying for Co-op/Internship) URL', type: 'text' },
    { label: '1. Please confirm that you are either: (a) a U.S. citizen; (b) lawful permanent resident of the U.S. (green card holder); or (3) protected individual as defined by 8 U.S.C. 1324b(a)(3).', type: 'select', options: ['Yes', 'No'] },
    { label: 'How did you hear about us?', type: 'select', options: ['LinkedIn', 'Other'] },
    { label: 'If other or referred please specify', type: 'text' },
  ], P, {}).actions;
  assert.equal(acts[0].action, 'skip');
  assert.equal(acts[1].value, 'No');
  assert.equal(acts[3].action, 'skip');
});

test('round fifteen, 2026-09-26: travel "comfortable with?" from his travel answer; "timeline for starting a new job"; "able to begin" is availability', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, travel_ok: 'Yes', earliest_start: 'June 2027' } };
  const acts = planForm([
    { label: 'This role may involve a few days of travel each month (1-2 hour drives) to our customer farms. Is this something you are comfortable with?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'What is your timeline for starting a new job?', type: 'text' },
    { label: 'Please let us know you would be able to begin a new opportunity.', type: 'checkbox', options: ['I can start immediately.', 'I can start in a month.', 'I can start in three to six months.'], required: true },
  ], P, {}).actions;
  assert.equal(acts[0].value, 'Yes');
  assert.equal(acts[1].value, 'June 2027');
  assert.match(acts[2].why, /June 2027/, 'none of the list is true, and the reason names his start');
});

test('gap audit, 2026-09-26: residence and education country lists; graduated status; highest diploma; Intel\'s citizenship-country, IP, DoD and I-140 questions', () => {
  const P = { ...PROFILE, identity: { ...PROFILE.identity, country: 'United States of America' }, education: { ...(PROFILE.education || {}), graduation: 'May 2027', degree_level: "Bachelor's" },
    answers: { ...PROFILE.answers, citizenship_country: 'Vietnam', held_h1b: 'No', active_immigration_case: 'No' } };
  const C = ['Select...', ...'Afghanistan Albania Algeria Andorra Angola Argentina Armenia Australia Austria Belgium Brazil Canada Chile China France Germany India Japan Mexico'.split(' '), 'United States', 'Vietnam'];
  const acts = planForm([
    { label: 'Country/Region of Residence', type: 'select', options: C },
    { label: 'Education Country/Region', type: 'select', options: C },
    { label: '* Graduated Status', type: 'select', options: ['Graduated', 'Expected', 'Did not graduate'] },
    { label: '* Is Highest Diploma?', type: 'select', options: ['Yes', 'No'] },
    { label: '9a)*If your response to question 9 is “No”, please specify the country or countries where you hold citizenship', type: 'text' },
    { label: '7)* Are you a current employee of the US Department of Defense (DOD) or were you an employee of the DOD in the last two years?', type: 'select', options: ['Yes', 'No'] },
    { label: '11b)* Was your I-140 approved more than 180 days ago?', type: 'select', options: ['Yes', 'No', 'I do not have an I-140'] },
  ], P, { company: 'Intel' }).actions;
  assert.deepEqual(acts.map((a) => a.value), ['United States', 'United States', 'Expected', 'Yes', 'Vietnam', 'No', 'I do not have an I-140']);
});

test('his own corrections, 2026-09-26: immigration status, months of authorization, sponsorship locations, government employment — as he answered them', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, visa_status_note: 'F-1 student graduating May 2027; eligible for 12 months OPT plus 24-month STEM extension.', stem_opt_extension_eligible: 'Yes', require_sponsorship: 'Yes' }, work_experience: [{ company: 'Applied Materials', title: 'Intern' }] };
  const acts = planForm([
    { label: '11d)* Please indicate your current immigration status (select one):', type: 'select', options: ['U.S. Citizen', 'Permanent Resident', 'F-1', 'H-1B', 'Other'] },
    { label: '11c)* How many months of work authorization time do you have remaining? If you hold F-1 Optional Practical Training (OPT) and are eligible for a STEM extension list full OPT plus STEM OPT time remaining (H-1B holders…)', type: 'select', options: ['0-6 months', '7-12 months', '13-24 months', '24+ months'] },
    { label: 'For those locations or countries in which you are seeking employment, indicate all locations or countries for which you now, or in the future, require sponsorship for employment with HPE.', type: 'text' },
    { label: 'I have United States government or public institution employment experience (federal, state, or local) either as an employee or contractor/consultant.', type: 'select', options: ['Yes', 'No'] },
    { label: 'Will you now or in the future require sponsorship to work in this country?', type: 'select', options: ['Yes', 'No'] },
  ], P, { company: 'Intel' }).actions;
  assert.deepEqual(acts.map((a) => a.value), ['F-1', '24+ months', 'United States', 'No', 'Yes']);
});

test('HP (Workday), 2026-09-26: an added language row gets the top rung, for every language he lists', () => {
  const P = { ...PROFILE, languages: [{ name: 'English', proficiency: 'Fluent' }, { name: 'Vietnamese', proficiency: 'Native' }] };
  const [g] = planEntries([{ kind: 'language', filled: false }], P);
  assert.deepEqual(g.entries.map((e) => [e.name, e.proficiency]), [['English', 'Native or Bilingual'], ['Vietnamese', 'Native or Bilingual']]);
  assert.ok(g.entries[0].proficiencyAlts.includes('Fluent'), 'a ladder that tops out at Fluent still gets its top');
  // …and the row's own Overall, planned by label, is the same ladder.
  const a = planForm([{ label: 'Overall', type: 'prompt' }], P, {}).actions[0];
  assert.equal((a.values || [a.value])[0], 'Native or Bilingual');
});

test('Re:Build, 2026-09-26: a ladder of minimums takes the largest step he meets, and a list of points is never read that way', () => {
  const o = ['5+ years', '3+ years', '1 year', 'No experience'];
  assert.equal(chooseBand('2 years', o), 2, '2 years meets "1 year" and no higher step');
  assert.equal(chooseBand('4 years', o), 1);
  assert.equal(chooseBand('0.5 years', o), -1, 'a step he does not meet is never taken');
  assert.equal(chooseBand('2 years', ['1 year', '3 years', '5 years']), -1, 'exact points stay his');
  assert.equal(chooseBand('3.85', ['3.9 or above', '3.6-3.8', 'Below 3.6']), 1, 'the GPA gap rule is unchanged');
});

test('audit, 2026-09-26: a start later than every timed option takes "Other"; a degree ladder labelled by its first rung is his level', () => {
  const now = new Date('2026-09-26');
  const O = ['Immediately', 'Within 2 weeks of an offer', 'Within 1 month of an offer', 'Other (will discuss on call)'];
  assert.equal(chooseDelay('June 2027 (graduating May 2027)', O, now), 3, 'Orchard: Other');
  assert.equal(chooseDelay('October 2026', O, now), -1, 'one month out never loses to Other');
  assert.equal(chooseDelay('June 2027', ['I can start immediately.', 'I can start in a month.', 'I can start in three to six months.'], now), -1, 'no Other row: every option understates him, so it is his');
  const P = { ...PROFILE, education: { ...(PROFILE.education || {}), degree_level: "Bachelor's", degree: 'Bachelor of Science' } };
  const o = ['High school diploma or GED', "Associate's degree", "Bachelor's degree", "Master's degree", 'Doctorate'];
  const a = planForm([{ label: 'High school diploma or GED', type: 'radio', options: o }], P, {}).actions[0];
  assert.equal(a.value, "Bachelor's degree");
  assert.equal(a.review, true);
});

test('Celestica (SuccessFactors), 2026-09-27: a leading "*" no longer hides a rule; candidate, education and employer place boxes; If-no under a Yes; the entry question stays his (F-623)', () => {
  const P = { ...PROFILE,
    identity: { ...PROFILE.identity, city: 'Springfield', address_line1: '100 Example Street', address_line2: 'Unit 101' },
    education: { ...PROFILE.education, location: 'Springfield, Washington' },
    answers: { ...PROFILE.answers, authorized_to_work_us: 'Yes' },
    work_experience: [{ company: 'Applied Materials', title: 'Manufacturing Engineer Intern', location: 'Austin, Texas', start: 'May 2026', end: 'August 2026' }] };
  const acts = planForm([
    { label: '* Candidate State', type: 'text' },
    { label: '* Candidate City', type: 'text' },
    { label: '* Address/Street/Apt/Unit#', type: 'text' },
    { label: '* Education Country', type: 'text' },
    { label: '* Education City', type: 'text' },
    { label: 'Currency', type: 'select', options: ['EUR', 'USD', 'CAD'] },
    { label: 'Are there any circumstances that would prevent you from being granted entry to another country?', type: 'select', options: ['Yes', 'No'] },
  ], P, { company: 'Celestica' }).actions;
  assert.deepEqual(acts.slice(0, 6).map((a) => a.value), ['Washington', 'Springfield', '100 Example Street Unit 101', 'United States', 'Springfield', 'USD']);
  assert.notEqual(acts[6].value, 'Yes', 'never "something prevents me" by guess');
  assert.match(acts[6].why || '', /entry_barrier/);

  const emp = planForm([
    { label: 'Company Name', type: 'text' },
    { label: 'Position', type: 'text' },
    { label: 'Company City', type: 'text' },
    { label: 'Company Country', type: 'text' },
    { label: 'Employer Type', type: 'select', options: ['Current', 'Previous'] },
  ], P, { company: 'Celestica' }).actions;
  assert.deepEqual(emp.map((a) => a.value), ['Applied Materials', 'Manufacturing Engineer Intern', 'Austin', 'United States', 'Previous']);
});

test('Celestica, 2026-09-27: an "If no, …" box under a question answered Yes is skipped, not answered (F-623)', () => {
  const acts = planForm([
    { label: 'Are you legally authorized to work in the United States?', type: 'select', options: ['Yes', 'No'] },
    { label: 'If no, have you applied for work authorization in the Country where the position is located?', type: 'select', options: ['Yes', 'No'] },
  ], PROFILE, { company: 'Celestica' }).actions;
  assert.equal(acts[0].value, 'Yes');
  assert.equal(acts[1].action, 'skip');
});

test('Celestica, 2026-09-27: both names in one box; Employer Type above Company Name; unquoted "Agency or Other" and "If other, enter …" skipped under another answer (F-623)', () => {
  const P = { ...PROFILE, identity: { ...PROFILE.identity, first_name: 'Anh Minh Alex', full_name: 'Anh Minh Alex Rivera' },
    work_experience: [{ company: 'Applied Materials', title: 'Manufacturing Engineer Intern', location: 'Austin, Texas', start: 'May 2026', end: 'August 2026' }],
    answers: { ...PROFILE.answers, how_did_you_hear: 'LinkedIn' } };
  const names = planForm([{ label: '* First Name Last Name', type: 'text' }, { label: 'First and Last Name', type: 'text' }], P, {}).actions;
  assert.deepEqual(names.map((a) => a.value), ['Anh Minh Alex Rivera', 'Anh Minh Alex Rivera']);

  const emp = planForm([
    { label: '* Employer Type', type: 'prompt' },
    { label: 'Company Name', type: 'text' },
    { label: 'Position', type: 'text' },
  ], P, {}).actions;
  assert.equal(emp[0].value, 'Previous');

  const acts = planForm([
    { label: 'How did you hear about this role?', type: 'select', options: ['LinkedIn', 'Agency', 'Other'] },
    { label: 'If you selected Agency or Other please specify:', type: 'text' },
    { label: 'Major', type: 'select', options: ['Mechanical Engineering', 'Other'] },
    { label: 'If other, enter Area of Study', type: 'text' },
    { label: 'Education City', type: 'text' },
    { label: 'If other, enter School/Institution Name', type: 'text' },
  ], { ...P, education: { ...P.education, location: 'Springfield, Washington' } }, {}).actions;
  assert.equal(acts[1].action, 'skip');
  assert.equal(acts[3].action, 'skip');
  assert.notEqual(acts[5].action, 'skip', 'under a typed box, not a list: no Other row to reason from');
});

test('Embraer, 2026-09-26: a location list of ONE option that names the posting\'s city is answered', () => {
  const a = planForm([{ label: 'Which location are you applying for', type: 'select', options: ['Melbourne, FL'] }], PROFILE, { company: 'Embraer', location: 'Melbourne, FL' }).actions[0];
  assert.equal(a.value, 'Melbourne, FL');
  const b = planForm([{ label: 'Which location are you applying for', type: 'select', options: ['Jacksonville, FL'] }], PROFILE, { company: 'Embraer', location: 'Melbourne, FL' }).actions[0];
  assert.notEqual(b.value, 'Jacksonville, FL', 'a single option naming another city is never taken');
});

test('Celestica / Flexport, 2026-09-27: the company box beside a title box takes the employer alone; asked alone it keeps his words (F-623)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, current_company: 'Lakeside University — Manufacturing Lead (student)', current_title: 'Manufacturing Lead' } };
  const both = planForm([{ label: 'Current / Most Recent Company', type: 'text' }, { label: 'Current / Most Recent Title', type: 'text' }], P, {}).actions;
  assert.deepEqual(both.map((a) => a.value), ['Lakeside University', 'Manufacturing Lead']);
  const alone = planForm([{ label: 'Current company', type: 'text' }], P, {}).actions[0];
  assert.equal(alone.value, 'Lakeside University — Manufacturing Lead (student)', 'Exowatt: he kept it this way');
});

test('HPE / Hyve, 2026-09-26/27: valid work and residency permits, and "related to anyone in management", as he answered them (F-623)', () => {
  const P = { ...PROFILE, answers: { ...PROFILE.answers, work_permit: 'Yes', residency_permit: 'Yes', relatives_at_company: 'No' } };
  const acts = planForm([
    { label: 'Do you possess a valid work permit in the country for which the position resides?', type: 'select', options: ['Yes', 'No'] },
    { label: 'Do you possess a valid residency permit in the country for which the position resides?', type: 'select', options: ['Yes', 'No'] },
    { label: 'Are you related to anyone in a Management position at SYNNEX or a subsidiary?', type: 'select', options: ['Yes', 'No'] },
  ], P, {}).actions;
  assert.deepEqual(acts.map((a) => a.value), ['Yes', 'Yes', 'No']);
  const none = planForm([{ label: 'Do you possess a valid residency permit in the country for which the position resides?', type: 'select', options: ['Yes', 'No'] }], PROFILE, {}).actions[0];
  assert.notEqual(none.value, 'Yes', 'no answer on file: never guessed');
});

test('KLA, 2026-09-24: the long Hispanic-or-Latino wording gets his Hispanic answer, never his race (F-623)', () => {
  const P = { ...PROFILE, eeo: { gender: 'Male', hispanic: 'No', race: 'Asian' } };
  const a = planForm([{ label: 'Are you Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race.', type: 'prompt' }], P, {}).actions[0];
  assert.equal([].concat(a.values || a.value)[0], 'No');
});

test('stress, 2026-09-27: the answer does not change with the page\'s decoration — "* ", "3) ", "Question 4: ", "(required)", ":" and non-breaking spaces (F-623)', () => {
  const P = { ...PROFILE, applyingTo: 'Relativity', answers: { ...PROFILE.answers, first_generation: 'No', willing_to_relocate: 'Yes' } };
  const qs = [
    { label: 'Why Relativity?', type: 'textarea' },
    { label: 'Are you a first generation college student?', type: 'select', options: ['Yes', 'No'] },
    { label: 'City', type: 'text' },
  ];
  const dress = [(l) => `* ${l}`, (l) => `3) ${l}`, (l) => `Question 4: ${l}`, (l) => `${l} (required)`, (l) => `${l}:`, (l) => l.replace(/ /g, ' ')];
  const plain = planForm(qs, P, { company: 'Relativity' }).actions.map((a) => `${a.action}:${a.value ?? ''}`);
  for (const d of dress) {
    const got = planForm(qs.map((q) => ({ ...q, label: d(q.label) })), P, { company: 'Relativity' }).actions;
    assert.deepEqual(got.map((a) => `${a.action}:${a.value ?? ''}`), plain, d('x'));
    assert.deepEqual(got.map((a) => a.label), qs.map((q) => d(q.label).replace(/\s*[*✱]\s*$/, '').trim()), 'the action keeps the page\'s own label');
  }
});

test('stress, 2026-09-27: options read bare — a non-breaking space or a bullet mark does not hide the right row, and the index is the page\'s own (F-623)', () => {
  const now = planForm([{ label: 'What is your availability or notice period?', type: 'select', options: ['Immediately', '2 weeks', '4 weeks', 'More than 12 weeks'] }], { ...PROFILE, answers: { ...PROFILE.answers, available_start: 'June 2027 (graduating May 2027)' } }, {}).actions[0];
  const plain = planForm([{ label: 'What is your availability or notice period?', type: 'select', options: ['Immediately', '2 weeks', '4 weeks', 'More than 12 weeks'] }], { ...PROFILE, answers: { ...PROFILE.answers, available_start: 'June 2027 (graduating May 2027)' } }, {}).actions[0];
  assert.equal(now.optionIndex, plain.optionIndex);
  const c = planForm([{ label: 'While a security clearance is not required, please let us know if you currently hold one or would be open to obtaining one', type: 'radio', options: ['○ Top Secret', '○ Secret', '○ Never held a clearance'] }], PROFILE, {}).actions[0];
  assert.equal(c.optionIndex, 2);
});

test('Oracle, Cummins 2026-10-02: the courtesy-title radios, the visa follow-up, the AI notice, Graduated and the numbered links (F-643)', () => {
  const P = { ...PROFILE,
    identity: { ...PROFILE.identity, salutation: 'Mr.', portfolio: 'alexrivera.example', linkedin: 'https://linkedin.com/in/x' },
    education: { ...(PROFILE.education || {}), graduation: 'May 2099' },
    answers: { ...PROFILE.answers, visa_status_note: 'F-1 student; 12 months OPT.', ai_screening_consent: 'Yes' } };
  const one = (label, type, options = []) => planForm([{ label, type, options }], P, {}).actions[0];
  const title = one('Title', 'radio', ['Capt.', 'Doctor', 'Miss', 'Mr.', 'Mrs.', 'Ms.', 'Rev.']);
  assert.equal(title.optionIndex, 3, 'Mr.');
  assert.notEqual(one('Title', 'text').action, 'fill', 'a bare Title text box is his job title, never "Mr."');
  const visa = one('If you answered "Yes" to the question above, please provide us information on your current immigration status, including type of visa and the amount of remaining work authorization. (e.g. F1 visa; 12 months optional practical training remaining).', 'text');
  assert.equal(visa.value, 'F-1 student; 12 months OPT.', 'his visa note, not "Yes"');
  const ai = one('Cummins would like to use tools, such as automated evaluation support technologies, to help us to more effectively identify and manage qualified candidates. You — Yes', 'radio', ['Yes', 'No']);
  assert.equal(ai.optionIndex, 0);
  assert.equal(one('Add Education — Graduated', 'checkbox', ['Graduated']).action, 'skip', 'not graduated yet: unticked, on purpose');
  // His own hand on that form: LinkedIn in Link 1, the portfolio with its scheme in Link 2.
  assert.match(one('Link 1', 'url').value, /linkedin\.com\/in\/x$/);
  assert.equal(one('Link 2', 'url').value, 'https://alexrivera.example');
});

test('Spirit AeroSystems on iCIMS, 2026-10-02: phone Type, the never-worked option, Meet all, and no email in an employee question (F-649)', () => {
  const P = { ...PROFILE, applyingTo: 'Spirit AeroSystems', answers: { ...PROFILE.answers, phone_type: 'Mobile', meets_basic_requirements: 'Yes' } };
  const one = (label, type, options = []) => planForm([{ label, type, options }], P, {}).actions[0];
  assert.equal(one('Type', 'select', ['', 'Home', 'Mobile']).optionIndex, 2);
  assert.notEqual(one('Type', 'select', ['Full-time', 'Part-time']).action, 'select', 'a Type that is not a phone is left');
  const emp = ['— Make a Selection —', 'Yes, Current Employee', 'Yes, Current Contractor', 'No, Former Employee', 'No, Former Contractor', 'No, Never worked at Boeing (Spirit)'];
  const cur = one('Are you a current Boeing (Spirit) Employee in Wichita, Tulsa, Or Dallas? (Please note, current Spirit employees should apply via the internal employee portal with their Spirit Email address.)', 'select', emp);
  assert.equal(cur.optionIndex, 5, `never worked there — not "Former Employee", not his email: ${JSON.stringify(cur)}`);
  assert.equal(one('Do you meet the minimum requirements of the position as listed?', 'select', ['— Make a Selection —', 'Meet some', 'Meet all', 'Exceeds all qualifications']).optionIndex, 2);
  // A bare Yes against two qualified Yeses is a guess between facts: left.
  assert.equal(chooseOption('Yes', ['Yes, Current Employee', 'Yes, Current Contractor', 'No']), -1);
  assert.equal(chooseOption('No', ['Yes', 'No']), 1, 'a plain No still wins');
});

test('HONDA AND JPL, 2026-10-02: the questions both forms left for him', () => {
  const P = { ...PROFILE, education: { ...PROFILE.education, degree: 'Bachelor of Science', degree_level: "Bachelor's" },
    answers: { ...PROFILE.answers, phone_type: 'Mobile', currently_on_opt: 'No', stem_opt_extension_eligible: 'Yes', how_heard: 'LinkedIn', relatives_at_company: 'No' } };
  const sel = (label, options) => planField(field({ label, type: 'select', options: ['Please Select', ...options] }), P);
  assert.equal(sel('Primary Phone Type', ['Home', 'Work (Desk)', 'Personal (Mobile)', 'Work (Mobile)']).value, 'Personal (Mobile)', 'his mobile is his own, not a work one');
  assert.equal(planField(field({ label: 'Alternate Phone Number' }), P).action, 'skip', 'he has one number');
  assert.equal(sel('If you have an Employment Authorization Document (EAD) under the F-1 student Optional Practical Training (OPT) program, are you eligible for a 24-month OPT extension based upon a degree from a qualifying U.S. institution in Science, Technology, Engineering, or Mathematics (STEM)?',
    ['Yes', 'No', 'I do not have OPT']).value, 'I do not have OPT', 'he is not on OPT yet');
  assert.equal(sel('Are you a current/former contractor/contingent or intern/co-op at Honda?',
    ['Currently working as a co-op, student, contingent, or contractor', 'Formerly worked as a co-op, student, contingent or contractor', 'NA – have not worked for Honda in either capacity']).value,
  'NA – have not worked for Honda in either capacity');
  assert.equal(sel('Details', ['Agency', 'Recruiter', 'LinkedIn Inmail', 'Job Posting: Dice', 'Job Posting: LinkedIn', 'Other']).value, 'Job Posting: LinkedIn');
  assert.equal(planField(field({ label: 'If you have direct relatives working at Honda, please provide their name(s) and location(s)' }), P).action, 'skip');
  // JPL (Workday prompts and boxes)
  const jpl = (label, type = 'prompt', options = []) => planField(field({ label, type, options }), P);
  assert.deepEqual(jpl("If the position you are applying for requires driving (e.g., driver, transporter), do you have a current and valid California Driver's License? If the position does not require this, select 'N/A'.").values?.[0] ?? jpl("If the position you are applying for requires driving (e.g., driver, transporter), do you have a current and valid California Driver's License? If the position does not require this, select 'N/A'.").value, 'N/A');
  assert.equal(jpl('JPL conducts employment verifications upon receipt of an offer acceptance. May we contact your present and previous employer(s) after receiving acknowledgement of your offer acceptance?').value, 'Yes');
  assert.equal(jpl('Are you interested in a Full-time or Part-time position?', 'checkbox', ['Full-time', 'Part-time']).value, 'Full-time');
  assert.equal(jpl('Check the box below to finalize your submission of interest.', 'checkbox').action, 'check');
  assert.ok((jpl("I understand any future employment offer would be contingent upon JPL's receipt of satisfactory information verifying my current employment.I certify that the information contained in this application is true").values || []).includes('I accept'));
  // …and the legal declarations stay his.
  assert.equal(jpl('Have you ever been excluded, suspended or debarred (or proposed for suspension or debarment) or declared otherwise ineligible from participating in any government contract or program by any Federal agency?').action, 'unknown');
});

test('HONDA STEP 2 (Phenom, 2026-10-03): each job entry is his Nth job — Current/Prior and Type of Business picked, dates as MM/DD/YYYY', () => {
  const P = {
    ...PROFILE,
    education: { ...PROFILE.education, degree: 'Bachelor of Science', degree_level: "Bachelor's", graduation: 'May 2027' },
    education_entries: [{ school: 'Lakeside University', degree: 'Bachelor of Science', field_of_study: 'Mechanical Engineering', first_year: 'Aug 2023', last_year: 'May 2027' }],
    work_experience: [
      { company: 'Applied Materials', title: 'Manufacturing Engineer Intern', location: 'Austin, Texas', start: 'May 2026', end: 'August 2026' },
      { company: 'Acme Steel Stud Company', title: 'Mechanical Engineering Intern', location: 'Springfield, Washington', start: 'May 2025', end: 'August 2025' },
      { company: 'Lakeside University - Makerspace Manufacturing Technology Center', title: 'Manufacturing Lead', location: 'Springfield, Washington', start: 'August 2024', end: '', current: true },
    ],
  };
  const BUSINESS = ['Please Select', 'Building Materials', 'Educational Services', 'Engineering', 'Manufacturing', 'Other'];
  const entry = (n) => [
    { label: 'Company Name', type: 'text', key: `experienceData[${n}].companyName` },
    { label: 'Job Title', type: 'text', key: `experienceData[${n}].title` },
    { label: 'Employer', type: 'select', key: `experienceData[${n}].presentEmployer`, options: ['Please Select', 'Current', 'Prior'] },
    { label: 'From Date', type: 'text', key: `experienceData[${n}].fromTo.startDate`, picker: 'mdy' },
    { label: 'End Date', type: 'text', key: `experienceData[${n}].fromTo.endDate`, picker: 'mdy' },
    { label: 'Type of Business', type: 'select', key: `experienceData[${n}].typeOfBusiness`, options: BUSINESS },
    { label: 'Country', type: 'select', key: `experienceData[${n}].country`, options: ['Please Select', 'Canada', 'United States'] },
  ];
  const fields = [...entry(0), ...entry(1), ...entry(2),
    { label: 'School/College/University', type: 'select', options: ['Please Select', 'Alabama A&M University', 'Other'] },
    { label: 'Degree', type: 'select', options: ['Please Select', "Bachelor's Degree", "Master's Degree"] },
    { label: 'Major', type: 'select', options: ['Please Select', 'Accounting', 'Mechanical Engineering'] },
    { label: 'Education From Date', type: 'text', picker: 'mdy' },
    { label: 'Education End Date', type: 'text', picker: 'mdy' },
  ].map((f) => field(f));
  const a = planForm(fields, P).actions;
  const by = (i) => [a[i].action, a[i].value];
  // Job 1: Applied Materials
  assert.deepEqual(by(0), ['fill', 'Applied Materials']);
  assert.deepEqual(by(1), ['fill', 'Manufacturing Engineer Intern'], 'the title is in the same entry, not a new one');
  assert.deepEqual(by(2), ['select', 'Prior'], 'Current / Prior is picked, never "Acme Steel" typed into it');
  assert.deepEqual(by(3), ['fill', '05/01/2026']);
  assert.deepEqual(by(4), ['fill', '08/31/2026'], 'an end is the last day of the month he left');
  assert.deepEqual(by(5), ['select', 'Manufacturing']);
  assert.deepEqual(by(6), ['select', 'United States']);
  // Job 2: Acme Steel
  assert.deepEqual(by(7), ['fill', 'Acme Steel Stud Company']);
  assert.deepEqual(by(10), ['fill', '05/01/2025']);
  // Job 3: Makerspace, which he still holds
  assert.deepEqual(by(16), ['select', 'Current']);
  assert.equal(a[18].action, 'skip', 'no end date for a job he still holds');
  assert.deepEqual(by(19), ['select', 'Educational Services']);
  // Education
  assert.deepEqual(by(21), ['select', 'Other'], 'Lakeside is not on Honda\'s list');
  assert.deepEqual(by(22), ['select', "Bachelor's Degree"]);
  assert.deepEqual(by(23), ['select', 'Mechanical Engineering']);
  assert.deepEqual(by(24), ['fill', '08/01/2023']);
  assert.deepEqual(by(25), ['fill', '05/31/2027']);
});

test('ROBUSTNESS 2/3 (2026-10-03): a bare Yes/No never goes into a box that asks for words; the new question families answer', () => {
  const P = {
    identity: { city: 'Springfield', state: 'Washington', postal_code: '12345', email: 'jane.doe@example.com', phone: '555-010-0199' },
    answers: { willing_to_relocate: 'Yes', visa_status_note: 'F-1 student graduating May 2027; OPT then H-1B.', over_18: 'Yes', require_sponsorship: 'Yes', target_salary: '$90000/year' },
  };
  // A rule that matched "relocat" and answered "Yes" where the box wants a city.
  const reloc = planField({ label: 'Relocation assistance may be available. Please tell us the city, state, and zip code you’d be moving from', type: 'text' }, P);
  assert.notEqual(reloc.value, 'Yes');
  // …but a yes/no question that merely contains "which" still takes its Yes,
  // and an "If you…" box may say No.
  assert.equal(planField({ label: 'Can you perform the essential functions of the position(s) for which you are applying with or without reasonable accommodation?', type: 'text' }, { ...P, answers: { ...P.answers, essential_functions: 'Yes' } }).value, 'Yes');
  // The families from Flowserve and Plug Power.
  const yn = ['Yes', 'No'];
  const sel = (label, options) => { const a = planField({ label, type: 'select', options }, P); return a.optionIndex != null ? options[a.optionIndex] : a.value; };
  assert.equal(sel('Are you of eligible age in the country to which you are applying to?', yn), 'Yes');
  assert.equal(sel('Do you have the minimum number of years of experience for the job to which you are applying?', yn), 'Yes');
  assert.equal(sel('Do you have the minimum educational requirement for the job to which you are applying?', yn), 'Yes');
  const sponsor = planField({ label: 'If you require sponsorship, please explain your situation.', type: 'text' }, P);
  assert.match(String(sponsor.value), /F-1/);
});

test('a second empty education or language row is matched to his entries, never his first one again (Apple, 2026-10-16)', () => {
  const P2 = { ...PROFILE,
    education_entries: [{ school: 'Lakeside University', degree: 'Bachelor of Science', field_of_study: 'Mechanical Engineering' }],
    languages: [{ name: 'English', proficiency: 'Fluent' }, { name: 'Vietnamese', proficiency: 'Native' }] };
  const plan = planForm([
    field({ label: 'School', current: 'Lakeside University' }),
    field({ label: 'Field of Study', current: 'Mechanical Engineering' }),
    field({ label: 'School' }),
    field({ label: 'Field of Study' }),
    field({ label: 'Language' }),
    field({ label: 'Language' }),
  ], P2);
  const a = plan.actions;
  assert.equal(a[2].action, 'skip', 'the empty second School stays empty');
  assert.equal(a[3].action, 'skip', '…and so does its Field of Study');
  assert.equal(a[4].value, 'English');
  assert.equal(a[5].value, 'Vietnamese', 'the second Language is his second language');
});

test('a job row with no job left for it stays empty, never his availability (Apple, 2026-10-16)', () => {
  const plan = planForm([
    field({ label: 'Employer', current: 'Applied Materials' }),
    field({ label: 'Job Title' }),
    field({ label: 'Employer' }),
    field({ label: 'Job Title' }),
    field({ label: 'Start Date' }),
  ], PROFILE);
  assert.equal(plan.actions[1].value, 'Engineering Intern');
  for (const k of [2, 3, 4]) assert.equal(plan.actions[k].action, 'skip', `box ${k} of the spare row`);
});
