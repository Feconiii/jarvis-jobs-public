// jarvis/submitted.test.mjs — golden tests for submission detection.
//
// apply.mjs watches the open tabs and marks a job Applied when it sees the ATS's
// own confirmation. A FALSE POSITIVE here silently corrupts the tracker: a job
// gets recorded as applied when nothing was ever submitted, and he stops applying
// to it. That is worse than never detecting anything, so the negative cases below
// matter more than the positive ones.
//
// The trap that motivated this file: "Thank you for your interest in <company>"
// is standard boilerplate at the bottom of thousands of job DESCRIPTIONS. An
// earlier pattern matched it, which would have marked jobs applied straight off
// the posting page.

const SUBMITTED_RE = new RegExp([
  'your application (has been|was) submitted',
  'application (has been|was) (successfully )?submitted',
  'thank you for (applying|your application)',
  'we (have )?received your application',
  'you have already applied',
  'successfully submitted',
  'application complete',
].join('|'), 'i');

let pass = 0, fail = 0;
const t = (text, expected, note) => {
  const got = SUBMITTED_RE.test(text);
  if (got === expected) { pass++; return; }
  fail++;
  console.log(`✗ ${note}\n    expected ${expected}, got ${got} — ${text.slice(0, 70)}`);
};

// ── real confirmations: must be detected ────────────────────────────
t('Your application has been submitted.', true, 'Workday confirmation');
t('Your application was submitted', true, 'past-tense variant');
t('Application successfully submitted', true, 'Greenhouse-style');
t('Thank you for applying to KLA Corporation!', true, 'thank-you-for-applying');
t('Thank you for your application. We will be in touch.', true, 'thank-you-for-your-application');
t('We have received your application', true, 'received');
t('You have already applied to this job', true, 'already applied is still applied');
t('Application Complete', true, 'terse confirmation');

// ── NOT submissions: must never match ───────────────────────────────
t('Thank you for your interest in KLA Corporation. KLA is an equal opportunity employer.',
  false, 'JD BOILERPLATE — the trap this file exists for');
t('We thank you for your interest in this position and will review your materials.',
  false, 'boilerplate, longer form');
t('Review your application before submitting', false, 'the Review page itself');
t('Submit', false, 'the button');
t('Save and Continue', false, 'mid-flow');
t('Please complete all required fields before you submit your application',
  false, 'validation message mentioning submit');
t('Start Your Application', false, 'the apply modal');
t('', false, 'empty page');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
