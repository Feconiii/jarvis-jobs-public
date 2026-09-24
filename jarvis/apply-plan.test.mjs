/**
 * The plan is what the extension executes without thinking, so a wrong decision
 * here reaches a real employer's form with nothing between it and Submit except
 * him noticing. These pin the decisions that cost the most when they go wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planField, planForm, RESUME_FIELD_RE, MAX_MULTI, EXPECTED_EXTENSION, extensionIsStale, chooseBand, chooseDelay, chooseResidence, formatForType,
} from './apply-plan.mjs';
import { chooseOption } from './apply/_form.mjs';

const PROFILE = {
  identity: {
    first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera',
    email: 'v@example.test', phone: '+1 (555) 000-0000',
    location: 'Springfield, Washington', country: 'United States', state: 'Washington',
  },
  education: { school: 'State University', discipline: 'Mechanical Engineering' },
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
  }), PROFILE);
  assert.equal(a.action, 'select');
  assert.equal(a.value, 'Yes');
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
  assert.equal(a.value, 'Job Board', 'the first alternative the form actually offers');
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
const GRAD_PROFILE = { education: { school: 'State University', graduation: 'May 2027' }, identity: {}, answers: {} };

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
  const profile = { education: { school: 'State University', graduation: 'May 2027' },
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

test('A ONE-LINE BOX IS NOT AN ESSAY, however its label reads', () => {
  const profile = { name: 'Test Person', email: 't@example.com' };
  // Writing two hundred words into a single-line input is worse than leaving
  // it blank, so the question shape alone is never enough.
  const a = planForm([{ label: 'Why do you want to work here?', type: 'text', required: false }], profile).actions[0];
  assert.notEqual(a.action, 'essay');

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
    education: { school: 'State University', discipline: 'Mechanical Engineering' },
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

  // "…CPT authorization FROM YOUR SCHOOL…" was answered **"State University
  // University"**: the school rule's guard enumerated leading auxiliaries and
  // was one verb short of "would". The school questions it protects still work.
  assert.equal(ask('If you selected F-1, would you require Curricular Practice Training (CPT) authorization from your school to begin full time employment at Amazon? — Yes').value, 'No');
  assert.equal(planForm([{ label: 'What school did you attend?', type: 'text', options: [] }], P, {}).actions[0].value,
    'State University', 'asking WHICH school still answers with the school');
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
  assert.equal(third.find((a) => a.label === 'End Date').action, 'unknown',
    'never a made-up end date for a current role');
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
