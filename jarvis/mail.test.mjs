/**
 * His inbox moves his application cards — classified, matched, moved forward
 * only, and undoable. Real-shaped recruiting emails; a fake Gmail; a temp store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-mail-'));
process.env.JARVIS_DATA_DIR = dir;
const M = await import('./mail.mjs');
const dbPath = path.join(dir, 'jobs.db');
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

test('classifyMessage reads the outcome, strongest first', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('Thank you for applying to Micron', 'We have received your application for New College Grad RDA Engineer and will review it.'), 'received');
  assert.equal(c('Your application to Tesla', 'Thank you for applying. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches.'), 'rejection', 'the thank-you opener does not hide the rejection');
  assert.equal(c('Update on your candidacy', 'After careful review we will not be moving forward with your application at this time.'), 'rejection');
  assert.equal(c('Next steps with Applied Materials', 'We would like to schedule a 30 minute phone interview. Please share your availability.'), 'interview');
  assert.equal(c('Rhoda AI — Online Assessment', 'Please complete the technical assessment on HackerRank within 5 days.'), 'assessment');
  assert.equal(c('Offer of employment', 'We are pleased to extend an offer for the Associate Mechanical Engineer role.'), 'offer');
  assert.equal(c('New jobs for you this week', 'Mechanical Engineer roles near Springfield'), null, 'a job alert is not an answer from a company');
});

const JOBS = [
  { id: 'amat1', company: 'Applied Materials', title: 'Mechanical Engineer New College Grad Bachelor Degree Santa Clara', status: 'applied', url: 'https://jobs.appliedmaterials.com/job/santa-clara/x/95/97644696144' },
  { id: 'amat2', company: 'Applied Materials', title: 'Mechanical Systems Engineer Ncg', status: 'applied', url: 'https://jobs.appliedmaterials.com/job/santa-clara/y/95/98504198576' },
  { id: 'ai1', company: 'Applied Intuition', title: 'Mechanical Engineer - New Grad', status: 'applied', url: 'https://jobs.ashbyhq.com/applied/1' },
  { id: 'mu1', company: 'Micron Technology', title: 'New College Grad Rda Engineer Aptd Boise Idaho', status: 'applied', url: 'https://careers.micron.com/careers/job/43721395-x' },
  { id: 'sun1', company: 'Sunday Robotics', title: 'Mechanical Engineer', status: 'interested', url: 'https://jobs.ashbyhq.com/sunday/1' },
];

test('F-739: an unfinished application is not a receipt, and "progress with other candidates" is a no', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('Continue to apply for the job Design Engineer 1', 'Thank you for your interest in Denso. Finish your application to be considered.'), null, 'Denso / Cummins / Dell reminder');
  assert.equal(c('Complete your application with Hewlett Packard Enterprise', 'This is a request to provide additional information we require to complete your application.'), null);
  assert.equal(c('Your Amazon job application is incomplete!', 'We noticed that your application for the position is incomplete.'), null);
  assert.equal(c('Keep track of your application', 'Thank you for your interest in Automation Engineer (ID: 10482034). If you have completed the application: Great!'), null, 'Amazon sends this when he STARTS one');
  assert.equal(c('Thank you for Applying to Amazon!', "We've received your application for the Automation Engineer (ID: 10482034) position."), 'received', 'the real receipt still counts');
  assert.equal(c('Amazon application: Status update', 'Thank you for your application for the position of Cloud Hardware Development Engineer (ID: 10530353). After careful consideration and review of your application, we have decided to progress with other candidates for this role.'), 'rejection');
  assert.equal(c('Your recent job application for Mechanical Design Engineer - 40738', 'Dear Anna Maria Alex, We received your job application for Mechanical Design Engineer - 40738. We will review your application and get back to you soon.'), 'received', 'Nokia / Ralliant on Oracle');
  // Apple's receipt, 2026-10-16 (F-926): no "application" anywhere in it.
  assert.equal(c('Thanks for your interest in Apple.', "We just received your resume for the following role: Tools and Automation Mechatronics Engineer 200687527. If your skills and experience are a match, you'll hear from one of our recruiters. Apple Worldwide Recruiting"), 'received', 'Apple');
  assert.match(M.SEARCH, /\bresume\b/, 'and the Gmail search reaches it');
  assert.equal(c('Zimmer Biomet Careers Account Created', 'Hello, Your Zimmer Biomet Career account has been successfully created. Thank you for your interest in Zimmer Biomet.'), null, 'a new account is not an application');
  assert.equal(c('Welcome! Thanks for creating an account!', 'Thanks for your interest in an exciting and rewarding career with Veeco! Your account has been created.'), null, 'Veeco');
  // Tesla's interview email, 2026-10-13: the card never reached Interview.
  assert.equal(c('[TESLA] 1st Interview Confirmation (Please Confirm)', 'Hi Alex, Congratulations on making it to the next round! Confirming your interview below for the Manufacturing Engineer, Manufacturing Development role.'), 'interview');
});

test('A RECEIPT THAT PROMISES A CALL IS NOT AN INTERVIEW — the Applied Intuition email, 2026-09-17', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('Thank you for applying to Applied Intuition | Mechanical Engineer - New Grad',
    "Hi Anna, Thanks for applying to Applied Intuition! Our recruiting team will review your profile as soon as possible. If your application seems like a good fit for the role, we'll reach out directly to set up an initial call to learn more about your experience."), 'received');
  assert.equal(c('Next steps', 'Once you pass the review we will schedule an interview.'), null);
  // A real invitation still reads as one.
  assert.equal(c('Applied Intuition next steps', "We'd like to schedule a call with you next week. Please share your availability."), 'interview');
  // And a rejection is still read from the whole message, conditionals included.
  assert.equal(c('Update', 'If you have questions, reply here. Unfortunately we will not be moving forward.'), 'rejection');
});

test('matchMessage finds the application by sender, domain or subject — never the body alone', () => {
  const m = (msg) => M.matchMessage({ fromName: '', fromEmail: '', subject: '', body: '', ...msg }, JOBS);
  assert.equal(m({ fromName: 'Micron Talent Acquisition', fromEmail: 'no-reply@myworkday.com', subject: 'Thank you for applying' }).jobId, 'mu1', '"Micron Technology" is found as "Micron"');
  assert.equal(m({ fromEmail: 'recruiting@sunday.ai', subject: 'Your application' }).jobId, 'sun1', 'the sender\'s own domain names the company');
  assert.equal(m({ fromName: 'Applied Intuition', subject: 'Thanks for applying' }).jobId, 'ai1', '"Applied Intuition" is not "Applied Materials"');
  assert.equal(m({ fromName: 'Weekly Digest', subject: 'Robotics news', body: 'Micron and Applied Materials announced…' }), null, 'a newsletter that mentions companies moves nothing');
});

test('several applications at one company are told apart by the role, or left unsure', () => {
  const which = M.matchMessage({ fromName: 'Applied Materials', fromEmail: 'amat@myworkday.com', subject: 'Your application: Mechanical Systems Engineer NCG', body: '' }, JOBS);
  assert.equal(which.jobId, 'amat2');
  const byReq = M.matchMessage({ fromName: 'Applied Materials', subject: 'Application update', body: 'Regarding requisition 97644696144' }, JOBS);
  assert.equal(byReq.jobId, 'amat1', 'the req number from the posting link decides');
  const unsure = M.matchMessage({ fromName: 'Applied Materials', subject: 'Thank you for your application', body: 'We received your application.' }, JOBS);
  assert.deepEqual(unsure.unsure.sort(), ['amat1', 'amat2']);
});

test('THE ROLE THE EMAIL NAMES decides between applications — his first real sync, 2026-09-17', () => {
  const jobs = [
    { id: 'gas', company: 'Micron Technology', status: 'applied', location: '', title: 'Gas Systems Engineer O M Boise Idaho United States Of America' },
    { id: 'aptd', company: 'Micron Technology', status: 'applied', location: '', title: 'New College Grad Rda Engineer Aptd Boise Idaho United States Of America' },
    { id: 'ram', company: 'Micron Technology', status: 'inbox', location: '', title: 'New College Grad Ram Rda Process Engineer Boise Idaho United States Of America' },
    { id: 'metro', company: 'Micron Technology', status: 'applied', location: 'Manassas, VA,US, US', title: 'New College Grad Equipment Engineer Rda Metrology Manassas Virginia United States Of America' },
    { id: 'tech', company: 'Micron Technology', status: 'new', location: '', title: 'Equipment Technician Manassas Virginia United States Of America' },
    { id: 'lam-a', company: 'Lam Research', status: 'applied', location: '', title: 'Mechanical Engineer 2', url: 'https://careers.lamresearch.com/careers/job/1099555830739-mechanical-engineer-2-us-or-tualatin-1034-' },
    { id: 'lam-b', company: 'Lam Research', status: 'applied', location: '', title: 'Mechanical Engineer 2', url: 'https://careers.lamresearch.com/careers/job/1099555830739-mechanical-engineer-2-' },
    { id: 'lam-m', company: 'Lam Research', status: 'applied', location: '', title: 'Manufacturing Engineer 2' },
    { id: 'e1', company: 'Applied Materials', status: 'applied', location: 'Austin', title: 'Manufacturing Engineer I E1' },
    { id: 'e1dup', company: 'Applied Materials', status: 'new', location: '', title: 'Manufacturing Engineer I - (E1)' },
    { id: 'ncg', company: 'Applied Materials', status: 'applied', location: 'Austin,TX, United States of America', title: "Manufacturing Engineer I, New College Grad- Bachelor's (Austin, TX)" },
    { id: 'mech-sys', company: 'Applied Materials', status: 'applied', location: '', title: 'Mechanical Systems Engineer Ncg' },
  ];
  const from = (company) => ({ fromName: '', fromEmail: `talent@${company}.com` });
  const m = (msg) => M.matchMessage({ fromName: '', subject: '', body: '', ...msg }, jobs);
  const micron = (role) => m({ ...from('micron'), subject: 'Thank you for applying to Micron', body: `Dear Alex, We have received your application for the position of ${role} and are thrilled that you'd like to join Micron!` });
  assert.equal(micron('Gas Systems Engineer - O&M').jobId, 'gas', 'Boise, Idaho and America no longer count against the title');
  assert.equal(micron('New College Grad - RDA Engineer, APTD').jobId, 'aptd', 'the role runs past its comma');
  assert.equal(micron('New College Grad - Equipment Engineer (RDA & Metrology)').jobId, 'metro', '"(RDA & Metrology)" is the role, not a place');
  assert.equal(m({ ...from('lamresearch'), subject: 'we have received your application', body: 'Thank you for applying for the Mechanical Engineer 2 position.' }).jobId.startsWith('lam-'), true, 'the same job saved twice is one application');
  assert.equal(m({ fromName: 'Applied Materials Careers', subject: 'Application Received', body: 'We are writing to confirm the receipt of your application for the Manufacturing Engineer I - (E1) at Applied Materials.' }).jobId, 'e1', 'the copy he applied to wins over a duplicate he never touched');
  const notOnBoard = m({ fromName: 'Applied Materials Human Resources', subject: 'Your application | Systems Engineer R2626795 at Applied Materials', body: 'Thank you for your interest in the Systems Engineer position. This requisition has now been closed.' });
  assert.ok(notOnBoard.unsure, 'a role he has no card for is never forced onto the nearest title');
  assert.match(notOnBoard.why, /names "Systems Engineer", which is not one of your applications/);
  assert.equal(M.roleNamed({ subject: 'Thank you – we’ve received your Tesla application', body: 'We have received your application for the position of Manufacturing Engineer, Optimus Factory, Gears, 276665 and are reviewing it.' }), 'Manufacturing Engineer, Optimus Factory, Gears, 276665');
  assert.deepEqual(M.roleWords('Manufacturing Engineer, Optimus Factory, Gears, 276665'), ['manufacturing', 'optimus', 'factory', 'gears'], 'a req number is not a role word');
  // A long program name is still read, and a one-word title does not claim it.
  const rotation = m({ fromName: 'Applied Materials Careers', subject: 'Application Received: Thank you, Alex, for your interest in Applied Materials.',
    body: 'Hello Alex, We are writing to confirm the receipt of your application for the 2027 Engineer Development Rotation Program - Mechanical Engineer I New College Grad (Santa Clara, CA) at Applied Materials.' });
  assert.ok(rotation.unsure, `the rotation program is not "Mechanical Systems Engineer": ${JSON.stringify(rotation)}`);
  assert.match(rotation.why, /Rotation Program/);
});

test('A RECEIPT FOR A ROLE NOT ON THE BOARD finds its posting — only by id or an exact role', () => {
  const pool = [
    { id: 'ct-new', company: 'Amazon', status: 'new', title: 'Mechanical Engineer, Robotics Technical Services Custom Tools', url: 'https://www.amazon.jobs/en/jobs/10486471/mechanical-engineer-robotics-technical-services-custom-tools', location: '' },
    { id: 'ct-hidden', company: 'Amazon', status: 'hidden', title: 'Mechanical Engineer, Robotics Technical Services Custom Tools', url: 'https://www.amazon.jobs/en/jobs/10473123/mechanical-engineer-robotics-technical-services-custom-tools', location: '' },
    { id: 'lam-a', company: 'Lam Research', status: 'new', title: 'Mechatronics Engineer 2', url: 'https://careers.lamresearch.com/careers/job/1099553808346-mechatronics-engineer-2-us-or', location: '' },
    { id: 'lam-b', company: 'Lam Research', status: 'new', title: 'Mechatronics Engineer 2', url: 'https://careers.lamresearch.com/careers/job/1099551634899-mechatronics-engineer-2-us-ca', location: '' },
    { id: 'ncg', company: 'Applied Materials', status: 'new', title: 'Build Manufacturing Engineer', url: 'https://jobs.appliedmaterials.com/job/austin/build-manufacturing-engineer/95/99573672336', location: 'Austin' },
    { id: 'ncg-sg', company: 'Applied Materials', status: 'new', title: 'Build Manufacturing Engineer 4pm 1 30am', url: 'https://jobs.appliedmaterials.com/job/singapore/build/95/1', location: 'Singapore' },
  ];
  const byId = M.matchOffBoard({ subject: 'Amazon application: Status update', body: 'thank you for applying for the Mechanical Engineer, Robotics Technical Services Custom Tools (ID: 10473123) position' }, 'Mechanical Engineer, Robotics Technical Services Custom Tools', pool);
  assert.equal(byId.jobId, 'ct-hidden', 'the id in the email picks the posting, even over a newer one with the same title');
  assert.equal(M.matchOffBoard({ subject: 'Keep track', body: 'Mechanical Engineer, Robotics Technical Services Custom Tools' }, 'Mechanical Engineer, Robotics Technical Services Custom Tools', pool), null, 'two postings with that title and no id: unsure');
  assert.equal(M.matchOffBoard({ subject: 'received', body: 'Mechatronics Engineer 2' }, 'Mechatronics Engineer 2', pool), null, 'the same title in two locations stays unsure');
  assert.equal(M.matchOffBoard({ subject: 'received', body: '' }, 'Build Manufacturing Engineer', pool).jobId, 'ncg', 'one posting whose role words are exactly the named role');
  assert.equal(M.classifyMessage({ subject: 'Amazon application: Status update', body: 'After careful review, we have determined that you currently do not meet the criteria. Although we are unable to proceed with your application for this job, we encourage you to explore our student opportunities.' }), 'rejection');
});

test('A CLOSED REQUISITION IS A NO, and a careers-site notice is nothing', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('Your application | Systems Engineer R2626795 at Applied Materials', 'Thank you for your interest in the Systems Engineer position. This requisition has now been closed.'), 'rejection');
  assert.equal(c('Jabil Careers Site Update', "We've temporarily turned off the option to sign in. Any previous applications you've submitted are still there. Thank you for your interest in Jabil."), null);
});

test('"MOVING FORWARD WITH ANOTHER APPLICANT" IS A NO — Applied Materials, 2026-10-12 (F-718)', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('Your application | New Product Manufacturing Engineer R2625558 at Applied Materials',
    'Thank you for your interest in the New Product Manufacturing Engineer position. We appreciate the time and effort you put into your application. At this time, we are moving forward with another applicant for this role.'), 'rejection');
  assert.equal(c('Update', 'We have decided to proceed with other applicants.'), 'rejection');
  assert.equal(c('Thank you for applying', 'Thank you for applying. We will be moving forward with interviews soon.'), 'received');
});

test('MAIL THAT IS NOT ABOUT AN APPLICATION IS NOT A VERDICT ON ONE — his inbox, 2026-08-25 to 2026-09-19 (F-541)', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('You have been banned from FACEIT', 'We regret to inform you that you have been banned from FACEIT for smurfing. This ban is permanent.'), null);
  assert.equal(c('Reservation Cancelled on Economy Suites Indianapolis', 'The reservation has been canceled. We are sold out unfortunately.'), null);
  assert.equal(c('Utility Billing Frequently Asked Questions', 'What should I do if I have questions about my lease? Unfortunately, Conservice cannot help with any questions about your lease.'), null);
  assert.equal(c('Correction: New Payment Option', "Good news – we're excited to offer ACH Bank Transfers. Effective 10/01/2026, a 1.5% processing fee will apply."), null);
  assert.equal(c('The Evening: Justices block Missouri map', 'The candidate said in an interview that the position of the court was unfortunate. Officials will set up a call with state leaders.'), null, 'the news uses candidate, position and interview');
  // …and the real ones from the same weeks still read.
  assert.equal(c('Gradient Robotics Application Update', "Thank you for applying for the Mechanical Design Engineer role(s) at Gradient Robotics. After reviewing your application we've determined that there isn't an ideal fit at this time, and we will not be moving forward with your candidacy."), 'rejection');
  assert.equal(c('Update on your application to Rhoda AI', "The position has been filled, so we won't be able to move forward with your candidacy at this time."), 'rejection');
});

test('nextStatus only moves a card forward, and a rejection closes anything short of an offer', () => {
  assert.equal(M.nextStatus('interested', 'received'), 'applied', 'a confirmation email proves he applied');
  assert.equal(M.nextStatus('applied', 'received'), null);
  assert.equal(M.nextStatus('interview', 'received'), null, 'an older confirmation never moves a card back');
  assert.equal(M.nextStatus('applied', 'assessment'), 'responded');
  assert.equal(M.nextStatus('responded', 'interview'), 'interview');
  assert.equal(M.nextStatus('interview', 'rejection'), 'rejected');
  assert.equal(M.nextStatus('offer', 'rejection'), null);
  assert.equal(M.nextStatus('rejected', 'interview'), null);
});

function fakeStore(jobs) {
  const status = new Map(jobs.map((j) => [j.id, j.status]));
  return {
    status,
    jobs: () => jobs.map((j) => ({ ...j, status: status.get(j.id) })),
    getStatus: (id) => status.get(id),
    setStatus: (id, s) => { status.set(id, s); },
  };
}

test('applyMessages moves the cards, oldest email first, remembers every email, and undo puts a card back', () => {
  const store = fakeStore(JOBS);
  const msgs = [
    { id: 'm3', date: '2026-09-12T10:00:00Z', fromName: 'Micron Talent Acquisition', fromEmail: 'no-reply@myworkday.com', subject: 'Update on your application', body: 'Unfortunately we will not be moving forward.' },
    { id: 'm1', date: '2026-09-05T10:00:00Z', fromName: 'Sunday', fromEmail: 'hiring@sunday.ai', subject: 'Thank you for applying to Sunday', body: 'We have received your application.' },
    { id: 'm2', date: '2026-09-08T10:00:00Z', fromName: 'Micron Talent Acquisition', fromEmail: 'no-reply@myworkday.com', subject: 'Micron: schedule your interview', body: 'We would like to schedule an interview.' },
    { id: 'm4', date: '2026-09-09T10:00:00Z', fromName: 'Applied Materials', fromEmail: 'amat@myworkday.com', subject: 'Thank you for your application', body: 'Received.' },
    { id: 'm5', date: '2026-09-10T10:00:00Z', fromName: 'LinkedIn Jobs', fromEmail: 'jobs@linkedin.com', subject: 'Jobs you may like', body: 'Mechanical Engineer' },
  ];
  const r = M.applyMessages(msgs, store, { dbPath });
  assert.equal(r.read, 5);
  assert.equal(store.status.get('sun1'), 'applied');
  assert.equal(store.status.get('mu1'), 'rejected', 'the interview email, then the later rejection');
  assert.deepEqual(r.moved.map((x) => `${x.jobId}:${x.to}`), ['sun1:applied', 'mu1:interview', 'mu1:rejected']);
  assert.equal(r.unsure.length, 1, 'the Applied Materials email could be either application');
  assert.equal(store.status.get('amat1'), 'applied');

  const again = M.applyMessages(msgs, store, { dbPath });
  assert.equal(again.read, 0, 'an email is read once');

  const latest = M.latestByJob({ dbPath });
  assert.equal(latest.mu1.kind, 'rejection');
  assert.equal(latest.mu1.subject, 'Update on your application');

  const undone = M.undoEvent('m3', store, { dbPath });
  assert.equal(undone.from_status, 'interview');
  assert.equal(store.status.get('mu1'), 'interview', 'undo puts the card back where the email found it');
  assert.equal(M.undoEvent('m3', store, { dbPath }), null, 'and only once');
});

test('week review F2: undo puts a card back only while it still holds what the email set, with its earlier date', () => {
  const db3 = path.join(dir, 'undo.db');
  const jobs = [{ id: 'u1', company: 'Sunday', title: 'Mechanical Engineer', status: 'interested' }, { id: 'u2', company: 'Micron', title: 'Process Engineer', status: 'applied' }];
  const status = new Map(jobs.map((j) => [j.id, j.status]));
  const at = new Map([['u1', '2026-09-01T09:00:00.000Z'], ['u2', '2026-09-02T09:00:00.000Z']]);
  const store = {
    jobs: () => jobs.map((j) => ({ ...j, status: status.get(j.id) })),
    getStatus: (id) => status.get(id),
    statusAt: (id) => at.get(id),
    setStatus: (id, s, { changedAt } = {}) => { status.set(id, s); at.set(id, changedAt || 'NOW'); },
  };
  M.applyMessages([
    { id: 'f2a', date: '2026-09-05T10:00:00Z', fromName: 'Sunday', fromEmail: 'hiring@sunday.ai', subject: 'Thank you for applying to Sunday', body: 'We have received your application.' },
    { id: 'f2b', date: '2026-09-06T10:00:00Z', fromName: 'Micron Talent Acquisition', fromEmail: 'no-reply@myworkday.com', subject: 'Micron: schedule your interview', body: 'We would like to schedule an interview.' },
  ], store, { dbPath: db3 });
  assert.equal(status.get('u1'), 'applied');
  assert.equal(status.get('u2'), 'interview');
  // He moved the Sunday card on by hand after the email: undo must not drag it back.
  status.set('u1', 'interview'); at.set('u1', '2026-09-10T09:00:00.000Z');
  const stale = M.undoEvent('f2a', store, { dbPath: db3 });
  assert.equal(status.get('u1'), 'interview', 'a card that moved on since the email stays where he put it');
  assert.equal(at.get('u1'), '2026-09-10T09:00:00.000Z', 'and keeps its date');
  assert.ok(stale?.stale, `the answer says why nothing changed: ${JSON.stringify(stale)}`);
  // The Micron card still holds what its email set: undo puts it back, with the date it had before.
  const done = M.undoEvent('f2b', store, { dbPath: db3 });
  assert.ok(done && !done.stale);
  assert.equal(status.get('u2'), 'applied');
  assert.equal(at.get('u2'), '2026-09-02T09:00:00.000Z', 'the earlier status date, not today');
});

test('A RECEIPT THAT NAMES NO ROLE goes to the application he filled just before it — Peak Energy and OpenAI, 2026-09-24', () => {
  const db2 = path.join(dir, 'fill.db');
  const jobs = [
    { id: 'peakTest', company: 'Peak Energy', title: 'Test Engineer', status: 'applied', appliedAt: '2026-09-24T17:00:00Z' },
    { id: 'peakCtl', company: 'Peak Energy', title: 'Controls & Automation Engineer', status: 'interested', appliedAt: '2026-09-25T02:10:00Z' },
    { id: 'oaMotor', company: 'OpenAI', title: 'Mechanical Design Engineer, Motor Design & Prototyping', status: 'interested', appliedAt: '2026-09-24T18:00:00Z' },
    { id: 'oaDyno', company: 'OpenAI', title: 'Mechanical Engineer, Dynamometer and Actuator Testing Infrastructure', status: 'interested', appliedAt: '2026-09-24T18:40:00Z' },
    { id: 'oaMfg', company: 'OpenAI', title: 'Manufacturing Engineer, Motors & Actuators', status: 'interested', appliedAt: '2026-09-16T20:00:00Z' },
  ];
  const store = fakeStore(jobs);
  const receipt = (id, date, co, from) => ({ id, date, fromName: co, fromEmail: from, subject: `Thank you for applying to ${co}`, body: 'We have received your application.' });
  const r = M.applyMessages([
    receipt('p1', '2026-09-24T17:03:00Z', 'Peak Energy', 'no-reply@greenhouse.io'),
    receipt('p2', '2026-09-25T02:14:00Z', 'Peak Energy', 'no-reply@greenhouse.io'),
    receipt('o1', '2026-09-24T18:05:00Z', 'OpenAI', 'no-reply@ashbyhq.com'),
    receipt('o2', '2026-09-24T18:44:00Z', 'OpenAI', 'no-reply@ashbyhq.com'),
  ], store, { dbPath: db2 });
  assert.equal(store.status.get('peakCtl'), 'applied', 'the Controls form was filled four minutes before the second receipt');
  assert.equal(store.status.get('oaMotor'), 'applied');
  assert.equal(store.status.get('oaDyno'), 'applied', 'the second same-day receipt takes the other card');
  assert.equal(store.status.get('oaMfg'), 'interested', 'a form filled eight days earlier is not what a receipt today confirms');
  assert.equal(r.unsure.length, 0, 'the first Peak receipt is for the card already applied: nothing moves, but it is tied to that card (2026-10-01)');
  assert.match(M.eventsFor('peakTest', { dbPath: db2 })[0].why, /sent 3 min before this email/);
  assert.equal(M.eventsFor('peakTest', { dbPath: db2 })[0].to_status, '');
  assert.match(M.eventsFor('peakCtl', { dbPath: db2 })[0].why, /filled 4 min before this email/);

  // Nothing filled near the email: it stays unsure, exactly as before.
  assert.equal(M.pickByFill(['oaMfg'], jobs, '2026-09-24T18:05:00Z', () => 'interested'), null);
  // A card filled AFTER the email cannot be what it confirms.
  assert.equal(M.pickByFill(['peakCtl'], jobs, '2026-09-24T17:03:00Z', () => 'interested'), null);
  // A rejected card is not waiting for a receipt.
  assert.equal(M.pickByFill(['oaMotor'], jobs, '2026-09-24T18:05:00Z', () => 'rejected'), null);
});

test('receipts an older matcher left unsure are decided again on the next sync', () => {
  const db3 = path.join(dir, 'resolve.db');
  const jobs = [
    { id: 'a', company: 'Nudge', title: 'Mechanical Engineer', status: 'inbox', appliedAt: '2026-09-24T20:00:00Z' },
    { id: 'b', company: 'Nudge', title: 'Mechanical Engineer, Robotics', status: 'inbox', appliedAt: null },
  ];
  const noFill = fakeStore(jobs.map((j) => ({ ...j, appliedAt: null })));
  M.applyMessages([{ id: 'n1', date: '2026-09-24T20:06:00Z', fromName: 'Nudge', fromEmail: 'no-reply@ashbyhq.com', subject: 'We received your application - Nudge', body: 'Thank you for applying.' }], noFill, { dbPath: db3 });
  assert.equal(noFill.status.get('a'), 'inbox', 'without fill times it stays unsure');
  const store = fakeStore(jobs);
  const moved = M.resolveUnsure(store, { dbPath: db3 });
  assert.deepEqual(moved.map((x) => `${x.jobId}:${x.to}`), ['a:applied']);
  assert.equal(M.eventsFor('a', { dbPath: db3 })[0].unsure, '');
  assert.deepEqual(M.resolveUnsure(store, { dbPath: db3 }), [], 'decided once');
});

test('the Gmail client is validated, and a sign-in without read-only access is refused', async () => {
  assert.throws(() => M.saveClient({ client_id: 'nope', client_secret: 'x' }, { dir }), /does not look like/);
  M.saveClient({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-value' }, { dir });
  assert.equal(M.mailStatus({ dir }).configured, true);
  assert.equal(M.mailStatus({ dir }).connected, false);

  const url = new URL(M.authUrl('http://localhost:4300/oauth/gmail/callback', { dir }));
  assert.equal(url.searchParams.get('scope'), M.SCOPE, 'read-only Gmail and nothing else is asked for');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const state = url.searchParams.get('state');

  const noScope = async (u) => ({ ok: true, json: async () => ({ access_token: 'a', refresh_token: 'r', scope: 'openid' }) });
  await assert.rejects(M.finishAuth({ code: 'c', state }, { dir, fetchImpl: noScope }), /read-only Gmail access was not granted/);
  await assert.rejects(M.finishAuth({ code: 'c', state: 'forged' }, { dir }), /stale/);
});

test('syncMail: token refresh, search, fetch, apply — against a fake Gmail', async () => {
  const url2 = new URL(M.authUrl('http://localhost:4300/oauth/gmail/callback', { dir }));
  const ok = (body) => ({ ok: true, json: async () => body });
  const enc = (s) => Buffer.from(s).toString('base64url');
  let searched = '';
  const fakeGmail = async (u, opts) => {
    const s = String(u);
    if (s.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'AT', refresh_token: 'RT', scope: M.SCOPE });
    if (s.endsWith('/profile')) return ok({ emailAddress: 'alex@example.test' });
    if (s.includes('/messages?')) { searched = decodeURIComponent(s); return ok({ messages: [{ id: 'g1' }] }); }
    if (s.includes('/messages/g1')) {
      return ok({
        id: 'g1', internalDate: String(Date.parse('2026-09-14T09:00:00Z')), snippet: 'We would like to schedule',
        payload: { headers: [{ name: 'From', value: '"Sunday Recruiting" <talent@sunday.ai>' }, { name: 'Subject', value: 'Interview with Sunday' }],
          mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: enc('Hi Alex, we would like to schedule a phone interview this week.') } }] },
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await M.finishAuth({ code: 'c', state: url2.searchParams.get('state') }, { dir, fetchImpl: fakeGmail });
  assert.equal(M.mailStatus({ dir }).connected, true);
  assert.equal(M.mailStatus({ dir }).account, 'alex@example.test');

  const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
  const r = await M.syncMail(store, { dir, dbPath, fetchImpl: fakeGmail });
  assert.equal(r.ok, true, r.error);
  assert.match(searched, /after:\d+/, 'only recent mail is searched');
  assert.equal(store.status.get('sun1'), 'interview');
  assert.equal(M.mailStatus({ dir }).lastResult.moved, 1);

  M.disconnect({ dir });
  assert.equal(M.mailStatus({ dir }).connected, false);
  assert.equal(existsSync(path.join(dir, 'gmail-token.json')), false, 'disconnect deletes the saved access');
  const failed = await M.syncMail(store, { dir, dbPath, fetchImpl: fakeGmail });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /not connected/);
});

test('MICRON AND J&J REJECTIONS FIND THEIR CARDS (F-785, 2026-10-21)', () => {
  const micron = (id, title, loc, n) => ({ id, company: 'Micron Technology', title, status: 'applied', location: loc, url: `https://careers.micron.com/careers/job/${n}-x?domain=micron.com` });
  const jobs = [
    micron('pcvd', 'New College Grad Pcvd Process Engineer Boise Idaho United States Of America', 'Boise, ID,US, US', '44611111'),
    micron('proc', 'Process Engineer Boise Idaho United States Of America', 'Boise, ID,US, US', '44622222'),
    micron('etchM', 'New College Grad Dry Etch Process Engineer Manassas Virginia United States Of America', 'Manassas, VA,US, US', '44543481'),
    micron('etchB', 'New College Grad Dry Etch Process Engineer Boise Idaho United States Of America', 'Boise, ID,US, US', '44543999'),
    { id: 'jj', company: 'Johnson & Johnson', title: 'Operations Process Engineer (Capital System)', status: 'interested', location: 'Raritan, NJ', url: 'https://jj.wd5.myworkdayjobs.com/x/job/R-098612' },
    { id: 'jci', company: 'Johnson Controls', title: 'Mechanical Engineer', status: 'applied', location: '', url: '' },
  ];
  // Micron's own Workday mailbox, no "Micron" in sender name or subject; a JR
  // number that is not the careers-site id on the card.
  const rej = (role, jr) => ({ fromName: '', fromEmail: 'micron@myworkday.com', subject: `Application Status Update for ${role}-JR${jr} -`,
    body: `Dear Alex, Thank you very much for applying for ${role} role at Micron. At this time, we regret to inform you that we've decided not to move forward with your application.` });
  assert.equal(M.matchMessage(rej('New College Grad - PCVD Process Engineer', '112000'), jobs).jobId, 'pcvd');
  assert.equal(M.matchMessage(rej('Process Engineer', '106732'), jobs).jobId, 'proc');
  assert.ok(M.matchMessage(rej('New College Grad - Dry Etch Process Engineer', '107194'), jobs).unsure, 'two locations, the email names neither: unsure');
  // A tenant mailbox that is no tracked company names nobody.
  assert.equal(M.matchMessage({ ...rej('Process Engineer', '1'), fromEmail: 'send-only.sec@myworkday.com', body: '' }, jobs), null);

  const jj = M.matchMessage({ fromName: 'Workday Notification', fromEmail: 'jj@myworkday.com',
    subject: 'You were not selected for Operations Process Engineer (Capital System) at Johnson & Johnson',
    body: 'Hello Alex, We are writing to let you know that you were not selected for the role of Operations Process Engineer (Capital System) R-098612.' }, jobs);
  assert.equal(jj.jobId, 'jj', '"&" in the subject is the "and" in the name');
});

test('AN EMAIL SKIPPED ONCE IS READ ON THE NEXT CHECK (F-784, 2026-10-21)', async () => {
  // J&J's "not selected" was never read: each check searched only since the
  // last one, so a message whose fetch failed once was gone for good.
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-window-'));
  writeFileSync(path.join(dir, 'gmail-client.json'), JSON.stringify({ client_id: 'id', client_secret: 's' }));
  writeFileSync(path.join(dir, 'gmail-token.json'), JSON.stringify({ refresh_token: 'RT' }));
  const enc = (s) => Buffer.from(s).toString('base64url');
  const ok = (body) => ({ ok: true, json: async () => body });
  let flaky = true; const searches = []; let fetched = 0;
  const gmail = async (u) => {
    const s = String(u);
    if (s.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'AT' });
    if (s.includes('/messages?')) { searches.push(decodeURIComponent(s)); return ok({ messages: s.includes('linkedin') ? [] : [{ id: 'old1' }] }); }
    if (s.includes('/messages/old1')) {
      fetched++;
      if (flaky) return { ok: false, status: 500, json: async () => ({}) };
      return ok({
        id: 'old1', internalDate: String(Date.parse('2026-09-14T09:00:00Z')), snippet: '',
        payload: { headers: [{ name: 'From', value: '"Sunday Recruiting" <talent@sunday.ai>' }, { name: 'Subject', value: 'Interview with Sunday' }],
          mimeType: 'text/plain', body: { data: enc('Hi Alex, we would like to schedule a phone interview this week.') } },
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
  const dbFile = path.join(dir, 'x.db');
  assert.equal((await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } })).ok, true);
  assert.equal(store.status.get('sun1'), 'applied', 'the fetch failed, nothing moved');
  flaky = false;
  await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.equal(store.status.get('sun1'), 'interview', 'the second check read what the first one missed');
  const days = (q) => (Date.now() / 1000 - Number(q.match(/after:(\d+)/)[1])) / 86400;
  assert.ok(days(searches.at(-2)) > 100, 'the second check searched the whole window, not since the first');
  const before = fetched;
  await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.equal(fetched, before, 'a message already read is not fetched again');
});

test('THE F-784/F-785 CHANGES DO NOT MISREAD OTHER MAIL (review, 2026-10-22)', () => {
  // Without "the", the company is not the role.
  assert.equal(M.roleNamed({ body: 'Thank you for applying to Acme Robotics for the Mechanical Engineer position.' }), 'Mechanical Engineer');
  assert.equal(M.roleNamed({ body: 'Thanks for applying for New College Grad - PCVD Process Engineer role at Micron.' }), 'New College Grad - PCVD Process Engineer');
  const acme = [{ id: 'a', company: 'Acme Robotics', title: 'Mechanical Engineer', status: 'applied', location: '', url: '' }];
  assert.equal(M.matchMessage({ fromName: 'Acme Robotics', fromEmail: 'jobs@acme.com', subject: 'Your application',
    body: 'Thank you for applying to Acme Robotics for the Mechanical Engineer position.' }, acme).jobId, 'a');

  // A bare id of another length is still another requisition (Amazon runs 7 and 8 digits).
  const amazon = [
    { id: 'a', company: 'Amazon', title: 'Mechanical Engineer I', status: 'applied', location: '', url: 'https://www.amazon.jobs/en/jobs/10418150/x' },
    { id: 'b', company: 'Amazon', title: 'Controls Engineer', status: 'applied', location: '', url: 'https://www.amazon.jobs/en/jobs/10418151/y' },
  ];
  const r = M.matchMessage({ fromName: 'Amazon', fromEmail: 'no-reply@amazon.com', subject: 'Update on your application',
    body: 'Thank you for your interest in the Mechanical Engineer I (ID: 2934567) position. We have decided not to move forward.' }, amazon);
  assert.ok(r.unsure, 'another requisition with the same title stays unsure');
  // …and a prefixed id still counts against a Workday card whose link uses it.
  const wd = [
    { id: 'w1', company: 'Acme', title: 'Process Engineer', status: 'applied', location: '', url: 'https://acme.wd5.myworkdayjobs.com/x/job/Process-Engineer_R2627688' },
    { id: 'w2', company: 'Acme', title: 'Test Engineer', status: 'applied', location: '', url: 'https://acme.wd5.myworkdayjobs.com/x/job/Test-Engineer_R2627699' },
  ];
  assert.ok(M.matchMessage({ fromName: 'Acme', fromEmail: 'acme@myworkday.com', subject: 'Process Engineer - R2999999',
    body: 'Thank you for applying for the Process Engineer position.' }, wd).unsure);
});

test('AN EMAIL OLDER THAN THE POSTING NEVER MOVES IT, AND AN UNPLACED ONE IS PLACED LATER (review, 2026-10-22)', async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'mail-pend-')), 'x.db');
  const card = { id: 'c1', company: 'Sunday', title: 'Mechanical Engineer', status: 'applied', location: '', url: '', firstSeen: '2026-10-10T00:00:00Z' };
  const store = fakeStore([card]);
  const old = { id: 'o1', date: '2026-07-01T10:00:00Z', fromName: 'Sunday', fromEmail: 'hiring@sunday.ai', subject: 'Your application to Sunday', body: 'Unfortunately we will not be moving forward with your application.' };
  M.applyMessages([old], store, { dbPath });
  assert.equal(store.status.get('c1'), 'applied', 'a July rejection is about an earlier application');

  // A receipt that came before he put the card on his board: placed once it is there.
  const later = fakeStore([]);
  const rcpt = { id: 'r1', date: '2026-10-12T10:00:00Z', fromName: 'Sunday', fromEmail: 'hiring@sunday.ai', subject: 'Interview with Sunday', body: 'Hi Alex, we would like to schedule a phone interview this week.' };
  M.applyMessages([rcpt], later, { dbPath });
  assert.equal((await M.rematchPending(later, { dbPath })).length, 0, 'still no card');
  const now = fakeStore([card]);
  const moved = await M.rematchPending(now, { dbPath });
  assert.equal(now.status.get('c1'), 'interview');
  assert.equal(moved.length, 1);
  assert.equal((await M.rematchPending(now, { dbPath })).length, 0, 'placed once, not again');
  assert.equal(M.eventsFor('c1', { dbPath }).length, 1);
});

test('UNPLACED EMAILS ARE ASKED AGAIN ONLY WHEN THE CARDS CHANGED, AND RETIRE PAST THE WINDOW (F-951)', async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'mail-fp-')), 'x.db');
  const now = new Date('2026-11-02T12:00:00Z');
  let reads = 0;
  const card = (id, company) => ({ id, company, title: 'Mechanical Engineer', status: 'applied', location: '', firstSeen: '2026-10-01T00:00:00Z', get url() { reads += 1; return ''; } });
  const mail = { id: 'p1', date: '2026-10-20T10:00:00Z', fromName: 'Lumen', fromEmail: 'jobs@lumen.example', subject: 'Interview with Lumen', body: 'Hi Alex, we would like to schedule a phone interview this week.' };
  // The cards themselves, not copies: a copy would read the counted field.
  const live = (cards) => ({ jobs: () => cards, getStatus: (id) => cards.find((c) => c.id === id)?.status, setStatus: (id, st) => { const c = cards.find((x) => x.id === id); if (c) c.status = st; } });
  const other = live([card('x1', 'Orbit')]);
  M.applyMessages([mail], other, { dbPath, now });
  await M.rematchPending(other, { dbPath, now });
  const before = reads;
  assert.equal((await M.rematchPending(other, { dbPath, now })).length, 0);
  assert.equal(reads, before, 'same cards, same matcher: the matcher is not run again');
  const placed = fakeStore([card('x1', 'Orbit'), card('l1', 'Lumen')]);
  assert.equal((await M.rematchPending(placed, { dbPath, now })).length, 1, 'a new card: asked again, and placed');
  // An unplaced email older than the window is retired, card or no card.
  const old = { id: 'p2', date: '2026-06-01T10:00:00Z', fromName: 'Vesta', fromEmail: 'jobs@vesta.example', subject: 'Interview with Vesta', body: 'Hi Alex, we would like to schedule a phone interview this week.' };
  M.applyMessages([old], other, { dbPath, now });
  assert.equal((await M.rematchPending(fakeStore([card('v1', 'Vesta')]), { dbPath, now, days: 120 })).length, 0, 'past the 120-day window: retired');
  assert.equal(M.eventsFor('v1', { dbPath }).length, 0);
});

test('GMAIL REFUSING A MESSAGE IS NEVER A QUIET SUCCESS (review, 2026-10-22)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-403-'));
  writeFileSync(path.join(dir, 'gmail-client.json'), JSON.stringify({ client_id: 'id', client_secret: 's' }));
  writeFileSync(path.join(dir, 'gmail-token.json'), JSON.stringify({ refresh_token: 'RT' }));
  const ok = (body) => ({ ok: true, json: async () => body });
  const gmail = (refusal) => async (u) => {
    const s = String(u);
    if (s.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'AT' });
    if (s.includes('/messages?')) return ok({ messages: s.includes('linkedin') ? [] : [{ id: 'm1' }, { id: 'm2' }] });
    return refusal;
  };
  const store = fakeStore([]);
  const scope = await M.syncMail(store, { dir, dbPath: path.join(dir, 'a.db'), fetchImpl: gmail({ ok: false, status: 403, json: async () => ({ error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }) }), retry: { sleep: async () => {} } });
  assert.equal(scope.ok, false);
  assert.match(scope.error, /insufficient authentication scopes/);
  const quota = await M.syncMail(store, { dir, dbPath: path.join(dir, 'b.db'), fetchImpl: gmail({ ok: false, status: 429, json: async () => ({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }) }), retry: { sleep: async () => {} } });
  assert.equal(quota.ok, true);
  assert.equal(quota.waiting, 2);
  assert.match(M.mailStatus({ dir }).lastError, /2 email\(s\) wait/);
});

test('A DROPPED CONNECTION IS RETRIED, AND ITS CAUSE IS NAMED (F-717, 2026-10-09)', async () => {
  // Five hours of "fetch failed" while Google itself was up: a request that
  // never got an answer is tried again; an HTTP refusal is an answer and is not.
  const drop = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw drop(); return { ok: true, status: 200 }; };
  const r = await M.withNetRetry(flaky, { sleep: async () => {} })('https://x.test');
  assert.equal(r.status, 200);
  assert.equal(calls, 3, 'two drops, then the answer');

  let refused = 0;
  const no = async () => { refused++; return { ok: false, status: 401 }; };
  assert.equal((await M.withNetRetry(no, { sleep: async () => {} })('https://x.test')).status, 401);
  assert.equal(refused, 1, "Google's own refusal is not retried");

  let dead = 0;
  const down = async () => { dead++; throw drop(); };
  await assert.rejects(M.withNetRetry(down, { sleep: async () => {} })('https://x.test'), /fetch failed/);
  assert.equal(dead, 3, 'gives up after three tries');
  assert.match(M.netErrorText(drop()), /could not reach Google \(ENOTFOUND\)/);
  assert.equal(M.netErrorText(new Error('Gmail is not connected')), 'Gmail is not connected');

  // The whole sync: the failure says what happened and is marked as a network drop.
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-net-'));
  writeFileSync(path.join(dir, 'gmail-client.json'), JSON.stringify({ client_id: 'id', client_secret: 's' }));
  writeFileSync(path.join(dir, 'gmail-token.json'), JSON.stringify({ refresh_token: 'RT' }));
  const out = await M.syncMail(fakeStore([]), { dir, dbPath: path.join(dir, 'x.db'), fetchImpl: down, retry: { sleep: async () => {} } });
  assert.equal(out.ok, false);
  assert.equal(out.network, true);
  assert.match(out.error, /could not reach Google \(ENOTFOUND\)/);
  assert.match(M.mailStatus({ dir }).lastError, /network dropped/);
});

test('A CONNECTION CUT WHILE THE ANSWER IS READ IS RETRIED TOO (F-725, 2026-10-13)', async () => {
  // Wi-Fi drops after the headers: fetch() resolved, then r.json() fails with
  // "terminated". Retrying only fetch() let this through to the 30-minute wait.
  const cut = () => Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  let calls = 0;
  const midBody = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => { if (calls < 2) throw cut(); return '{"access_token":"A"}'; } };
  };
  const r = await M.withNetRetry(midBody, { sleep: async () => {} })('https://x.test');
  assert.deepEqual(await r.json(), { access_token: 'A' });
  assert.equal(calls, 2, 'the cut body was asked for again');
  assert.equal(M.isNetworkError(cut()), true);
  assert.equal(M.isNetworkError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), true);
  assert.equal(M.isNetworkError(new SyntaxError('Unexpected token < in JSON')), false, 'a reply that is not JSON is an answer');
  assert.equal(M.isNetworkError(new Error('Gmail is not connected')), false);

  // A body that is not JSON is not retried: Google answered.
  let html = 0;
  const page = async () => { html++; return { ok: false, status: 502, text: async () => '<html>Bad Gateway</html>' }; };
  const got = await M.withNetRetry(page, { sleep: async () => {} })('https://x.test');
  assert.equal(got.status, 502);
  assert.equal(html, 1);

  // The whole sync marks it a network drop, so the dashboard checks again in 5 minutes.
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-cut-'));
  writeFileSync(path.join(dir, 'gmail-client.json'), JSON.stringify({ client_id: 'id', client_secret: 's' }));
  writeFileSync(path.join(dir, 'gmail-token.json'), JSON.stringify({ refresh_token: 'RT' }));
  const alwaysCut = async () => ({ ok: true, status: 200, text: async () => { throw cut(); } });
  const out = await M.syncMail(fakeStore([]), { dir, dbPath: path.join(dir, 'x.db'), fetchImpl: alwaysCut, retry: { sleep: async () => {} } });
  assert.equal(out.ok, false);
  assert.equal(out.network, true);
  assert.match(out.error, /could not reach Google \(UND_ERR_SOCKET\)/);
});

test('parseGmailMessage reads the sender, subject and an HTML-only body', () => {
  const m = M.parseGmailMessage({
    id: 'x', internalDate: '1757840000000', snippet: 's',
    payload: { headers: [{ name: 'From', value: 'Jabil Careers <careers@jabil.com>' }, { name: 'Subject', value: 'Hello' }], mimeType: 'text/html', body: { data: Buffer.from('<p>Thank&nbsp;you <b>for applying</b></p><style>p{}</style>').toString('base64url') } },
  });
  assert.equal(m.fromName, 'Jabil Careers');
  assert.equal(m.fromEmail, 'careers@jabil.com');
  assert.equal(m.body, 'Thank you for applying');
});

test('THE REQUISITION IN THE EMAIL BEATS THE TITLE — five Amazon Tech Deployment cards, 2026-09-26', () => {
  const td = (id, req, where) => ({ id, company: 'Amazon', title: 'Robotics Systems Engineer I, Tech Deployment', status: 'applied', location: where, url: `https://www.amazon.jobs/en/jobs/${req}/robotics-systems-engineer-i-tech-deployment` });
  const jobs = [td('bos1', '10503216', 'Boston, Massachusetts, USA'), td('aus1', '10486586', 'Austin, Texas, USA'),
    td('bos2', '10473878', 'Boston, Massachusetts, USA'), td('aus2', '10418150', 'Austin, Texas, USA'), td('nr', '10516443', 'North Reading, Massachusetts, USA')];
  const receipt = (id) => ({ fromName: 'Amazon', fromEmail: 'no-reply@amazon.jobs', subject: 'Thank you for Applying to Amazon!',
    body: `Thank you for your interest in Robotics Systems Engineer I, Tech Deployment (ID: ${id}). We received your application.` });
  assert.equal(M.matchMessage(receipt('10418150'), jobs).jobId, 'aus2');
  assert.equal(M.matchMessage(receipt('10516443'), jobs).jobId, 'nr');
  // An id none of his cards carry: not pinned on a same-titled card.
  const other = M.matchMessage(receipt('10999999'), jobs);
  assert.equal(other.jobId, undefined);
  assert.ok(other.unsure?.length);
  // No id at all, five requisitions: nothing to tell them apart.
  const bare = M.matchMessage({ fromName: 'Amazon', subject: 'Keep track of your application', body: 'your interest in Robotics Systems Engineer I, Tech Deployment. Thanks' }, jobs);
  assert.equal(bare.jobId, undefined, 'different requisitions are different applications, not copies');
});

test('emailReqIds reads ids stated as ids, not zip codes or phone numbers', () => {
  assert.deepEqual([...M.emailReqIds('Mechanical Engineer II (ID: 10503749)')], ['10503749']);
  assert.deepEqual([...M.emailReqIds('Your application | Systems Engineer R2626795 at Applied Materials')], ['2626795']);
  assert.deepEqual([...M.emailReqIds('Sunnyvale, CA 94086. Call 4085551234.')], []);
});

test('sameRoleKey: one role in three cities is one key; a different level or team is not', () => {
  const k = (title, location, company = 'Amazon') => M.sameRoleKey({ id: title + location, company, title, location });
  assert.equal(k('Robotics Systems Engineer I, Tech Deployment', 'Boston, Massachusetts, USA'), k('Robotics Systems Engineer I, Tech Deployment', 'Austin, Texas, USA'));
  assert.notEqual(k('Robotics Systems Engineer I, Tech Deployment', 'Boston'), k('Robotics Systems Engineer II, Tech Deployment', 'Boston'));
  assert.notEqual(k('Robotics Manufacturing Engineer, Stator, Optimus', 'Austin', 'Tesla'), k('Robotics Manufacturing Engineer, Stator Molding, Optimus', 'Austin', 'Tesla'));
  assert.equal(k('New College Grad Dry Etch Process Engineer Manassas Virginia United States Of America', 'Manassas, VA,US, US', 'Micron Technology'),
    k('New College Grad Dry Etch Process Engineer Boise Idaho United States Of America', 'Boise, ID,US, US', 'Micron Technology'));
});

test("LINKEDIN'S COPY IS THE SAME JOB — WeRide's Application Engineer, 2026-10-01", async () => {
  const lever = { id: 'lever', company: 'WeRide', title: 'Application Engineer', status: 'applied', location: 'San Jose, CA',
    url: 'https://jobs.lever.co/weride/82955de9-485d-4db0-8fd9-1c018489fc8d', appliedAt: '2026-10-01T07:29:51.932Z' };
  const li = { id: 'li', company: 'WeRide', title: 'Application Engineer', status: 'interested', location: 'San Jose, CA',
    url: 'https://www.linkedin.com/jobs/view/application-engineer-at-weride-4467264328', appliedAt: null };
  const from = { fromName: 'WeRide.ai', fromEmail: 'no-reply@hire.lever.co' };
  // The receipt that names the role: one application, not two requisitions.
  const named = M.matchMessage({ ...from, subject: 'Thank you for your application to WeRide.ai',
    body: 'We wanted to let you know we received your application for Application Engineer, and we are delighted.' }, [lever, li]);
  assert.equal(named.jobId, 'lever');
  // The one that names nothing: the copy is not a second candidate either.
  const bare = M.matchMessage({ ...from, subject: 'Thank you for applying to WeRide.ai', body: 'Your application has been received.' }, [lever, li]);
  assert.equal(bare.jobId, 'lever');

  // A copy in another city, or a second board card it could equally copy, is not folded.
  assert.equal(M.linkedInCopies([lever, { ...li, location: 'Austin, TX' }]).size, 0);
  assert.equal(M.linkedInCopies([lever, { ...lever, id: 'lever2', url: 'https://jobs.lever.co/weride/11111111-2222-3333-4444-555555555555' }, li]).size, 0);
  // Two Lever postings are two postings, whatever digits their UUIDs hold.
  const two = M.matchMessage({ ...from, subject: 'Thank you', body: 'your application for Application Engineer at WeRide.' },
    [{ ...lever, status: 'interested' }, { ...lever, id: 'lever2', status: 'interested', url: 'https://jobs.lever.co/weride/11111111-2222-3333-4444-555555555555' }]);
  assert.equal(two.jobId, undefined);

  // Once the board card is applied, the copy leaves his list.
  assert.deepEqual(M.appliedCopies([lever, li]).map((p) => `${p.copy.id}→${p.keep.id}`), ['li→lever']);
  assert.deepEqual(M.appliedCopies([{ ...lever, status: 'interested' }, li]), [], 'not before he has applied');
  const dbF = path.join(dir, 'fold.db');
  const { openDb } = await import('./db.mjs');
  const h = openDb(dbF);
  h.exec("INSERT INTO jobs (id, url, company, title) VALUES ('lever', 'u1', 'WeRide', 'Application Engineer'), ('li', 'u2', 'WeRide', 'Application Engineer')");
  // F-968: a file that is not the store gets no write of mail's own; the adapter's writer does it.
  assert.deepEqual(M.foldAppliedCopies(fakeStore([lever, li]), { dbPath: dbF }), [], 'not the store, no adapter writer: nothing written');
  assert.equal(h.prepare("SELECT superseded_by FROM jobs WHERE id = 'li'").get().superseded_by, null);
  const withWriter = () => ({ ...fakeStore([lever, li]), pointAt: (copy, keep) => h.prepare('UPDATE jobs SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(keep, copy).changes > 0 });
  const folded = M.foldAppliedCopies(withWriter(), { dbPath: dbF });
  assert.deepEqual(folded.map((f) => f.copyId), ['li']);
  assert.equal(h.prepare("SELECT superseded_by FROM jobs WHERE id = 'li'").get().superseded_by, 'lever');
  assert.deepEqual(M.foldAppliedCopies(withWriter(), { dbPath: dbF }), [], 'once');
});

test('A RECEIPT FOR A CARD ALREADY MARKED APPLIED is tied to it, not left unsure — Neuralink, Gotion, Lab37, 2026-10-01', () => {
  const jobs = [
    { id: 'robo', company: 'Neuralink', title: 'Robotics Engineer', status: 'applied', appliedAt: '2026-09-30T08:46:10Z' },
    { id: 'mech', company: 'Neuralink', title: 'Mechanical Engineer, Surgery & Robotics', status: 'applied', appliedAt: '2026-09-21T07:54:00Z' },
    { id: 'mfg', company: 'Neuralink', title: 'Manufacturing Engineer', status: 'hidden', appliedAt: '2026-09-30T08:40:00Z' },
  ];
  const st = (id) => jobs.find((j) => j.id === id).status;
  assert.equal(M.pickByFill(['robo', 'mech', 'mfg'], jobs, '2026-09-30T08:47:00Z', st)?.job.id, 'robo', 'a hidden card is not an application');
  // Two applied cards filled minutes apart: the receipt could be either.
  const near = [...jobs, { id: 'robo2', company: 'Neuralink', title: 'Robotics Engineer II', status: 'applied', appliedAt: '2026-09-30T08:30:00Z' }];
  assert.equal(M.pickByFill(['robo', 'robo2'], near, '2026-09-30T08:47:00Z', (id) => near.find((j) => j.id === id).status), null);
  // Filled the day before: a receipt today is not evidence for it.
  assert.equal(M.pickByFill(['mech'], jobs, '2026-09-22T09:00:00Z', st), null);
});

test('SIGN-IN CODES: the code is read from the email, never a year, phone or requisition number (his consent, 2026-10-23)', () => {
  const x = (subject, body) => M.extractCode({ subject, body });
  assert.equal(x('Your verification code', 'Your one-time passcode for Texas Instruments is 482913. It expires in 10 minutes.'), '482913');
  assert.equal(x('Verify your email', 'Enter the code 731044 to continue. Questions? Call 1-800-555-0199'), '731044');
  assert.equal(x('Oracle', 'Your code is: 5521'), '5521');
  assert.equal(x('Sign in', '482913 is your verification code'), '482913');
  assert.equal(x('Application received', 'Thanks for applying to requisition 25001234 in 2026'), null, 'no code phrase, no code');
  assert.equal(x('Your verification code', 'Valid until 2026.'), null, 'a year is not a code');
  assert.equal(x('Code', 'Your code for job 12345 is 482913'), '482913', 'the number after "is", not the job number');
  assert.equal(x('Code', 'Your verification code for job 2026-12345 is 482913'), '482913');
  assert.equal(x('Code', 'Your one-time code is 4829-13'), null, 'part of a longer number is never taken');
  // Ford, live 2026-10-24 (F-908): no "verification" anywhere, so the Gmail search must name its words too.
  assert.equal(x('Confirm your identity', 'We need you to confirm your identity for your job application for using this code: 482913. This code expires in 10 minutes.'), '482913');
  assert.match(M.CODE_SEARCH, /"confirm your identity"/);
  assert.match(M.CODE_SEARCH, /"this code"/);
  const ford = { date: new Date().toISOString(), fromEmail: 'RecruitingNoReply@ford.com', fromName: '', subject: 'Confirm your identity', body: 'using this code: 482913. Sincerely, The Ford Talent Acquisition Team' };
  assert.equal(M.codeFor([ford], { company: 'Ford Motor', since: Date.now() - 60e3 })?.code, '482913', 'ford.com is Ford Motor');
  assert.equal(M.codeFor([ford], { company: 'Fordham Labs', since: Date.now() - 60e3 }), null, 'a longer first word is someone else');
});

test('F-920: two forms at one employer — a code handed to the first is never handed to the second', () => {
  const now = Date.now();
  const coh = (code, s) => ({ fromName: 'Coherent Corp', fromEmail: 'x@hcwp.fa.oraclecloud.com', subject: 'Confirm your identity', body: `Your one-time pass code : ${code}`, date: new Date(now - s * 1000).toISOString() });
  const older = coh('111111', 300);
  assert.equal(M.codeFor([older], { company: 'Coherent Corp', since: now - 600_000 })?.code, '111111', 'the first form takes it');
  assert.equal(M.codeFor([older], { company: 'Coherent Corp', since: now - 600_000, taken: new Set(['111111']) }), null, 'the second form waits instead of typing the spent code');
  assert.equal(M.codeFor([coh('222222', 5), older], { company: 'Coherent Corp', since: now - 600_000, taken: new Set(['111111']) })?.code, '222222', 'and takes its own once it arrives');
});

test('SIGN-IN CODES: three sign-ins at once never swap codes', () => {
  const now = Date.parse('2026-10-23T10:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const msgs = [
    { fromName: 'Texas Instruments', fromEmail: 'no-reply@careers.ti.com', subject: 'Your code', body: 'Your verification code is 111111', date: at(5) },
    { fromName: 'Oceaneering Careers', fromEmail: 'x@ebfr.fa.oraclecloud.com', subject: 'Your code', body: 'Your verification code is 222222', date: at(10) },
    { fromName: 'Old', fromEmail: 'o@x.com', subject: 'Your code', body: 'Your verification code is 333333', date: at(3600) },
  ];
  assert.equal(M.codeFor(msgs, { company: 'Oceaneering', since: now - 60_000 })?.code, '222222');
  assert.equal(M.codeFor(msgs, { company: 'Texas Instruments', since: now - 60_000 })?.code, '111111');
  assert.equal(M.codeFor(msgs, { company: 'Ford Motor', since: now - 60_000 }), null, 'two unnamed codes: neither is guessed');
  assert.equal(M.codeFor(msgs.slice(0, 1), { company: 'Ford Motor', since: now - 60_000 }), null, 'a known employer never gets another employer\'s code');
  assert.equal(M.codeFor(msgs.slice(0, 1), { since: now - 60_000 })?.code, '111111', 'no employer named: the only code in the window');
  const jj = [{ fromName: 'Johnson & Johnson Careers', fromEmail: 'x@jnj.com', subject: 'Your code', body: 'Your verification code is 123456', date: at(5) }];
  assert.equal(M.codeFor(jj, { company: 'Johnson & Johnson', since: now - 60_000 })?.code, '123456', '"&" reads as "and" (F-785)');
  const oracle = [{ fromName: 'Careers', fromEmail: 'no-reply@oracle.com', subject: 'Confirm your identity', body: 'Your verification code is 777777. https://ebfr.fa.us2.oraclecloud.com/hcmUI/CandidateExperience', date: at(5) }];
  assert.equal(M.codeFor(oracle, { company: 'Oceaneering', since: now - 60_000, pageHost: 'ebfr.fa.us2.oraclecloud.com' })?.code, '777777', 'the email links the site he is signing in to');
  assert.equal(M.codeFor(msgs.slice(2), { company: 'Old', since: now - 60_000 }), null, 'older than the request');
});

// ── F-1043: his applications the inbox check never placed (2026-11-12) ──

test('F-1043 NAMES: Samsung Electronics America signs "Samsung", Matic Robots "Matic", a board slug reads across the email\'s spaces', () => {
  assert.ok(M.companyNames('Samsung Electronics America').includes('samsung'));
  assert.ok(M.companyNames('Matic Robots').includes('matic'));
  assert.deepEqual(M.companyNames('Applied Electronics'), ['applied electronics'], 'a plain word is never a company on its own');
  const jobs = [
    { id: 'sam', company: 'Samsung Electronics America', title: 'Metals Equipment Engineer', status: 'interested', url: 'https://x.wd1.myworkdayjobs.com/a/job/Metals_R1' },
    { id: 'mar', company: 'Marianaminerals', title: 'Mechanical Engineer', status: 'hidden', url: 'https://jobs.ashbyhq.com/marianaminerals/1' },
  ];
  const m = (msg) => M.matchMessage({ body: '', ...msg }, jobs);
  assert.equal(m({ fromName: 'Samsung', fromEmail: 'samsung@myworkday.com', subject: 'Thank you for applying to Samsung' })?.jobId, 'sam');
  assert.equal(m({ fromName: 'Mariana Minerals Hiring Team', fromEmail: 'no-reply@ashbyhq.com', subject: 'Mariana Minerals Application Update' })?.jobId, 'mar');
  assert.equal(m({ fromName: 'Mariana', fromEmail: 'x@y.com', subject: 'Mariana is hiring' }), null, 'part of the slug is not the slug');
});

test('F-1043 THE ROLE, NOT THE NEXT SENTENCE OR THE REQUISITION: HP, Lam and Flex', () => {
  assert.equal(M.roleNamed({ subject: 'Regarding Requisition Interactive Design Engineer -  HPIQ', body: 'Dear Anna Maria Alex, Thank you for your interest in the HP Inc position of Interactive Design Engineer - HPIQ We will not be moving forward with your application for this role.' }), 'Interactive Design Engineer - HPIQ');
  assert.equal(M.roleNamed({ subject: 'Lam Research Application Status', body: 'We appreciate the submission of your application for the position of Mechatronics Engineer 2, Req. 199770 at Lam Research.' }), 'Mechatronics Engineer 2');
  assert.ok(M.emailReqIds('the position of Mechatronics Engineer 2, Req. 199770 at Lam Research').has('199770'), '"Req." with its stop');
  assert.equal(M.roleNamed({ subject: 'Thank you for applying to Axiom', body: 'We are currently reviewing your application for the position of Mechanical engineer WD233476. If your qualifications match' }), 'Mechanical engineer');
  assert.equal(M.roleNamed({ subject: 'Symbotic Application', body: 'we have made the decision not to move forward with your candidacy for the R8402 New Grad- Manufacturing Engineer position.' }), 'New Grad- Manufacturing Engineer', 'a requisition in front of the role');
  assert.equal(M.roleNamed({ subject: 'Update on your application: Manufacturing Engineer 2 at Lam Research', body: 'Thanks for your interest in the Manufacturing Engineer 2 opening at Lam Research, we appreciate your interest.' }), 'Manufacturing Engineer 2');
});

test('F-1043 A SHORTER NAME THAT HOLDS THE ROLE: "- HPIQ" in the subject is HP Inc.\'s application, from HP\'s own Workday mailbox', () => {
  const jobs = [
    { id: 'iq', company: 'HP IQ', title: 'Product Design Engineer', status: 'inbox', url: 'https://job-boards.greenhouse.io/hpiq/jobs/6144518004' },
    { id: 'ide', company: 'HP Inc.', title: 'Interactive Design Engineer -  HPIQ', status: 'interested', url: 'https://hp.wd5.myworkdayjobs.com/ExternalCareerSite/job/SF/Interactive-Design-Engineer----HPIQ_UNI4821-1' },
    { id: 'pde', company: 'HP Inc.', title: 'Product Design Engineer - HPIQ', status: 'applied', url: 'https://hp.wd5.myworkdayjobs.com/ExternalCareerSite/job/SF/Product-Design-Engineer---HPIQ_UNI4814-1' },
  ];
  const hp = (role) => M.matchMessage({ fromName: 'Workday HRHPI', fromEmail: 'hp@myworkday.com', subject: `Regarding Requisition ${role}`,
    body: `Dear Anna Maria Alex, Thank you for your interest in the HP Inc position of ${role} We will not be moving forward with your application for this role.` }, jobs);
  assert.equal(hp('Interactive Design Engineer - HPIQ')?.jobId, 'ide');
  assert.equal(hp('Product Design Engineer - HPIQ')?.jobId, 'pde', 'HP IQ\'s own "Product Design Engineer" lacks the HPIQ word his application carries');
  const iqOnly = M.matchMessage({ fromName: 'HP IQ', fromEmail: 'no-reply@greenhouse.io', subject: 'Thank you for applying to HP IQ', body: 'Thank you for applying for the Product Design Engineer role.' }, jobs);
  assert.equal(iqOnly?.jobId, 'iq', 'the longest name still wins when it holds the role');
});

test('F-1043 OFF THE BOARD: a receipt from a company with no card is looked up strictly; a rejection\'s requisition is found in a posting\'s own text; the card takes the email\'s date', () => {
  const db3 = path.join(dir, 'f1043.db');
  const board = [
    { id: 'dry-b', company: 'Micron Technology', title: 'New College Grad Dry Etch Process Engineer Boise Idaho United States Of America', status: 'applied', url: 'https://careers.micron.com/careers/job/43538351-new-college-grad-dry-etch' },
    { id: 'dry-m', company: 'Micron Technology', title: 'New College Grad Dry Etch Process Engineer Manassas Virginia United States Of America', status: 'applied', url: 'https://careers.micron.com/careers/job/44543481-new-college-grad-dry-etch' },
  ];
  const offBoard = [
    { id: 'cob-ai', company: 'Cobot', title: 'Mechanical Engineer, AI Data Collection', status: 'new', url: 'https://www.linkedin.com/jobs/view/1' },
    { id: 'cob-pd', company: 'Cobot', title: 'Mechanical Engineer, Product Design', status: 'new', url: 'https://www.linkedin.com/jobs/view/2' },
  ];
  const status = new Map([...board, ...offBoard].map((j) => [j.id, j.status]));
  const dated = new Map();
  const store = {
    jobs: () => board.map((j) => ({ ...j, status: status.get(j.id) })),
    getStatus: (id) => status.get(id),
    setStatus: (id, s, opts) => { status.set(id, s); dated.set(id, opts?.changedAt); },
    jobsAtCompany: (co) => offBoard.filter((j) => /cobot/i.test(co) && j.company === 'Cobot'),
    descriptionOf: (id) => (id === 'dry-m' ? 'Req ID: JR100001. Dry etch process engineer in Manassas.' : 'Dry etch process engineer in Boise.'),
  };
  const r = M.applyMessages([
    { id: 'cob1', date: '2026-09-30T14:00:00Z', fromName: 'Cobot', fromEmail: 'no-reply@ashbyhq.com', subject: 'Thank You For Applying - Cobot', body: 'Thank you for applying for the Mechanical Engineer, AI Data Collection role at Cobot.' },
    { id: 'cob2', date: '2026-10-01T14:00:00Z', fromName: 'Cobot', fromEmail: 'no-reply@ashbyhq.com', subject: 'Thank you for your interest in Cobot', body: 'Thank you for applying. We have received your application.' },
    { id: 'mu1', date: '2026-10-22T16:00:00Z', fromName: '', fromEmail: 'micron@myworkday.com', subject: 'Application Status Update for New College Grad - Dry Etch Process Engineer-JR100001 - ', body: 'Dear Alex, Thank you very much for applying for New College Grad - Dry Etch Process Engineer role at Micron. At this time, we regret to inform you that we’ve decided not to move forward with your application.' },
  ], store, { dbPath: db3 });
  assert.equal(status.get('cob-ai'), 'applied', 'the one Cobot posting the receipt names, still new in the store');
  assert.equal(status.get('cob-pd'), 'new', 'a receipt naming no role places nothing off the board');
  assert.equal(dated.get('cob-ai'), '2026-09-30T14:00:00Z', 'applied on the day of the email, not the day it was read');
  assert.equal(status.get('dry-m'), 'rejected', 'JR100001 is in the Manassas posting\'s own text');
  assert.equal(status.get('dry-b'), 'applied');
  assert.deepEqual(r.moved.map((x) => x.jobId).sort(), ['cob-ai', 'dry-m']);
});

test('F-1043 LINKEDIN EASY APPLY: "your application was sent to" is a receipt and names the company', () => {
  const subject = 'Alex , your application was sent to Chism Automation';
  assert.equal(M.classifyMessage({ subject, body: 'Your application was sent to Chism Automation. Mechanical Engineer · Chism Automation' }), 'received');
  assert.equal(M.emailCompany({ subject: 'Alex , your application was sent to LMK Recruiting Solutions' }), 'LMK Recruiting Solutions');
  assert.equal(M.emailCompany({ subject: 'Thank You For Applying - Cobot' }), 'Cobot');
  assert.equal(M.emailCompany({ subject: 'Thank you for applying to Samsung' }), 'Samsung');
  assert.equal(M.emailCompany({ subject: 'Thank you for your interest in the Mechanical Engineer position' }), '', 'a role is not a company');
  const card = { id: 'chism', company: 'Chism Automation', title: 'Mechanical Engineer', status: 'interested', url: 'https://chismautomation.com/careers/me' };
  assert.equal(M.matchMessage({ fromName: 'LinkedIn', fromEmail: 'jobs-noreply@linkedin.com', subject, body: '' }, [card])?.jobId, 'chism');
});

test('F-1043 syncMail reads the old Easy Apply receipts once more: their "not about an application" rows are dropped before the search', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-easy-'));
  writeFileSync(path.join(dir, 'gmail-client.json'), JSON.stringify({ client_id: 'id', client_secret: 's' }));
  writeFileSync(path.join(dir, 'gmail-token.json'), JSON.stringify({ refresh_token: 'RT' }));
  const db4 = path.join(dir, 'easy.db');
  const store = fakeStore([]);
  M.applyMessages([{ id: 'li1', date: '2026-10-02T08:43:56Z', fromName: 'Nobody', fromEmail: 'n@n.com', subject: 'Hello', body: 'hi' }], store, { dbPath: db4 });
  const asked = [];
  const ok = (body) => ({ ok: true, json: async () => body });
  const gmail = async (u) => {
    const s = decodeURIComponent(String(u).replace(/\+/g, ' '));
    if (s.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'AT', scope: M.SCOPE });
    if (s.includes('/messages?')) { asked.push(s); return ok({ messages: s.includes('application was sent') ? [{ id: 'li1' }] : [] }); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await M.syncMail(store, { dir, dbPath: db4, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(asked.some((q) => q.includes('from:jobs-noreply@linkedin.com')), 'the receipts are asked for by name');
  assert.equal(M.eventsFor('', { dbPath: db4 }).filter((e) => e.msg_id === 'li1').length, 0, 'the old verdict is gone, so the receipt is read as new mail');
  asked.length = 0;
  await M.syncMail(store, { dir, dbPath: db4, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.ok(!asked.some((q) => q.includes('from:jobs-noreply@linkedin.com')), 'once: the next check does not ask again');
});

test('F-1043 review: a company named only in the subject is looked up by whole words — Matic is never Automatic, Apple never Pineapple', () => {
  assert.equal(M.sameCompany('Matic Robots', 'matic'), true);
  assert.equal(M.sameCompany('Automatic Systems Inc', 'matic'), false);
  assert.equal(M.sameCompany('Pineapple Energy', 'apple'), false);
  assert.equal(M.sameCompany('Apple', 'apple'), true);
  assert.equal(M.sameCompany('Samsung Electronics America', 'samsung'), true);
  const db5 = path.join(dir, 'f1043-words.db');
  const offBoard = [{ id: 'auto', company: 'Automatic Systems Inc', title: 'Mechanical Engineer', status: 'new', url: 'https://x.com/1' }];
  const status = new Map([['auto', 'new']]);
  const store = {
    jobs: () => [],
    getStatus: (id) => status.get(id),
    setStatus: (id, s) => status.set(id, s),
    jobsAtCompany: () => offBoard,   // a substring lookup, as serve.mjs's once was
  };
  M.applyMessages([{ id: 'mat1', date: '2026-10-01T14:00:00Z', fromName: 'Matic', fromEmail: 'no-reply@ashbyhq.com', subject: 'Thank you for applying to Matic', body: 'Thank you for applying for the Mechanical Engineer role at Matic.' }], store, { dbPath: db5 });
  assert.equal(status.get('auto'), 'new', 'a posting at another company is never moved');
});

test('his card behind its repost is read as the repost: Zipline Avionics, rejected 10-30, was left unplaced', () => {
  const avionics = 'Mechanical Test Engineer, Avionics';
  const rows = new Map([
    ['old', { id: 'old', company: 'Zipline', title: avionics, status: 'inbox', url: 'https://www.zipline.com/open-roles?gh_jid=7868241003', supersededBy: 'new1' }],
    ['new1', { id: 'new1', company: 'Zipline', title: avionics, status: 'new', url: 'https://www.zipline.com/open-roles/7868241003?gh_jid=7868241003', supersededBy: null }],
    ['b730', { id: 'b730', company: 'Zipline', title: 'Test Equipment Design Engineer, Battery and Power Electronics', status: 'applied', url: 'https://www.zipline.com/open-roles/1', supersededBy: null }],
    ['8389', { id: '8389', company: 'Zipline', title: 'Mechanical Test Equipment Design Engineer, Crash Safety', status: 'applied', url: 'https://www.zipline.com/open-roles/2', supersededBy: null }],
  ]);
  const endOf = (id) => { let r = rows.get(id); while (r?.supersededBy) r = rows.get(r.supersededBy); return r || null; };
  const cards = M.throughReposts([rows.get('old'), rows.get('b730'), rows.get('8389')], endOf);
  const card = cards.find((c) => c.hiddenCard === 'old');
  assert.deepEqual([card.id, card.status, card.title, card.url], ['new1', 'inbox', avionics, rows.get('new1').url], "the repost's id and link; his card's title and the further status");
  assert.equal(cards.length, 3, 'one card per posting');
  // A rejected card stays rejected behind a "new" repost, so no later email revives it.
  const rejected = M.throughReposts([{ ...rows.get('old'), status: 'rejected' }], endOf)[0];
  assert.equal(rejected.status, 'rejected');
  assert.equal(M.nextStatus(rejected.status, 'interview'), null, 'an interview email cannot revive it');
  assert.equal(M.throughReposts([{ ...rows.get('old'), status: 'interview' }], endOf)[0].status, 'interview', 'an interview card is not read back as new');
  // A pointer to another company's row is never followed.
  const elsewhere = (id) => (id === 'old' ? { ...rows.get('new1'), company: 'Skydio' } : null);
  assert.equal(M.throughReposts([rows.get('old')], elsewhere).length, 0, 'a repost at another company is not his card');
  assert.equal(M.throughReposts([rows.get('old')], (id) => (id === 'old' ? { ...rows.get('new1'), company: 'Zipline International Inc.' } : null)).length, 1, 'the same company under its longer name is');
  // A row already among his cards is not doubled, and a pointer to nowhere is dropped.
  assert.equal(M.throughReposts([rows.get('old'), { ...rows.get('new1'), status: 'applied' }], endOf).length, 1);
  assert.equal(M.throughReposts([{ ...rows.get('old'), supersededBy: 'gone' }], () => null).length, 0);

  const status = new Map([...rows].map(([id, r]) => [id, r.status]));
  const store = { jobs: () => cards.map((c) => ({ ...c, status: status.get(c.id) })), getStatus: (id) => status.get(id), setStatus: (id, s) => status.set(id, s), jobsAtCompany: () => [] };
  const r = M.applyMessages([{ id: 'zip1', date: '2026-10-30T16:04:43Z', fromName: 'Zipline Recruiting', fromEmail: 'no-reply@appreview.gem.com', subject: 'Update on your Zipline application',
    body: `Hi Anna Maria Alex, Thank you so much for your interest in the ${avionics} position at Zipline . We have made the decision not to move forward with your candidacy for the ${avionics} position at this time.` }], store, { dbPath: path.join(dir, 'zipline-repost.db') });
  assert.deepEqual(r.moved.map((x) => [x.jobId, x.from, x.to]), [['new1', 'new', 'rejected']], 'the row he can see is moved');
  assert.deepEqual([status.get('old'), status.get('b730'), status.get('8389')], ['inbox', 'applied', 'applied'], 'nothing else moves');

  // Through applyMessages, as the dashboard runs it: his card was rejected
  // BEFORE it closed, its repost is "new", and the store reads the repost's own
  // status. A later interview email naming that role must not revive it.
  const st2 = new Map([['old', 'rejected'], ['new1', 'new'], ['b730', 'applied'], ['8389', 'applied']]);
  const cards2 = () => M.throughReposts([{ ...rows.get('old'), status: st2.get('old') }, rows.get('b730'), rows.get('8389')], endOf);
  const store2 = { jobs: cards2, getStatus: (id) => st2.get(id), setStatus: (id, s) => st2.set(id, s), jobsAtCompany: () => [] };
  const invite = { id: 'zip2', date: '2026-11-05T16:00:00Z', fromName: 'Zipline Recruiting', fromEmail: 'no-reply@appreview.gem.com', subject: `Interview invitation: ${avionics} at Zipline`,
    body: `Hi Alex, we would like to schedule an interview with you for the ${avionics} position at Zipline. Please pick a time for your interview.` };
  assert.equal(M.classifyMessage(invite), 'interview', 'the email is an interview invitation');
  const r2 = M.applyMessages([invite], store2, { dbPath: path.join(dir, 'zipline-revive.db') });
  assert.deepEqual(r2.moved, [], 'a rejected card is not revived through its repost');
  assert.equal(st2.get('new1'), 'new', 'the repost row is not moved to interview');
});

test('week review F4: a check that meets a locked store fails whole, says so, and the next check finishes it', async () => {
  M.saveClient({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-value' }, { dir });
  const url2 = new URL(M.authUrl('http://localhost:4300/oauth/gmail/callback', { dir }));
  const ok = (body) => ({ ok: true, json: async () => body });
  const enc = (s) => Buffer.from(s).toString('base64url');
  const gmail = async (u) => {
    const s = String(u);
    if (s.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'AT', refresh_token: 'RT', scope: M.SCOPE });
    if (s.endsWith('/profile')) return ok({ emailAddress: 'alex@example.test' });
    if (s.includes('/messages?')) return ok({ messages: [{ id: 'lk1' }] });
    if (s.includes('/messages/lk1')) {
      return ok({ id: 'lk1', internalDate: String(Date.parse('2026-09-14T09:00:00Z')), snippet: 'We would like to schedule',
        payload: { headers: [{ name: 'From', value: '"Sunday Recruiting" <talent@sunday.ai>' }, { name: 'Subject', value: 'Interview with Sunday' }],
          mimeType: 'text/plain', body: { data: enc('Hi Alex, we would like to schedule a phone interview this week.') } } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await M.finishAuth({ code: 'c', state: url2.searchParams.get('state') }, { dir, fetchImpl: gmail });
  const dbFile = path.join(dir, 'locked.db');
  const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
  const realSet = store.setStatus;
  store.setStatus = () => { throw new Error('database is locked'); };   // a scan holding the write lock past busy_timeout
  const first = await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.equal(first.ok, false);
  assert.equal(first.busy, true, `a lock is named, so the server checks again in minutes: ${JSON.stringify(first)}`);
  assert.equal(store.status.get('sun1'), 'applied', 'nothing half-moved');
  store.setStatus = realSet;
  const second = await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.equal(second.ok, true, second.error);
  assert.equal(store.status.get('sun1'), 'interview', 'the email the locked check could not record is read again');
  const serve = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  assert.match(serve, /if \(!r\.ok && \(r\.network \|\| r\.busy\) && !mailRetry\)/, 'the server retries a locked check like a dropped network');
  M.disconnect({ dir });
});

test('week-fixes J5: a card moved just before a lock stopped the check keeps its from/to and its undo', async () => {
  // The move (the store) and its row (mail_events) are two writes. A lock
  // between them used to leave the card moved and no row: the next check read
  // the email again, found the card already there, and recorded "no move", so
  // Undo had nothing to put back.
  const msg = (id) => ({ id, date: '2026-09-14T09:00:00Z', fromName: 'Sunday Recruiting', fromEmail: 'talent@sunday.ai', subject: 'Interview with Sunday', body: 'Hi Alex, we would like to schedule a phone interview this week.' });
  {
    const dbPath = path.join(dir, 'j5-landed.db');
    const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
    const realSet = store.setStatus;
    store.setStatus = (id, s, o) => { realSet(id, s, o); throw new Error('database is locked'); };   // the move lands, then the lock
    assert.throws(() => M.applyMessages([msg('j5a')], store, { dbPath }), /locked/);
    assert.equal(store.status.get('sun1'), 'interview');
    store.setStatus = realSet;
    const again = M.applyMessages([msg('j5a')], store, { dbPath });
    assert.deepEqual(again.moved.map((m) => [m.jobId, m.from, m.to]), [['sun1', 'applied', 'interview']], 'the move is reported once it is known');
    assert.equal(M.undoEvent('j5a', store, { dbPath })?.from_status, 'applied', 'the row keeps where the card came from');
    assert.equal(store.status.get('sun1'), 'applied', 'and Undo puts it back');
  }
  {
    const dbPath = path.join(dir, 'j5-not-landed.db');
    const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
    const realSet = store.setStatus;
    store.setStatus = () => { throw new Error('database is locked'); };   // the lock comes first
    assert.throws(() => M.applyMessages([msg('j5b')], store, { dbPath }), /locked/);
    assert.equal(store.status.get('sun1'), 'applied', 'nothing half-moved');
    store.setStatus = realSet;
    assert.deepEqual(M.applyMessages([msg('j5b')], store, { dbPath }).moved.map((m) => m.to), ['interview'], 'the next check finishes the move');
    assert.equal(store.status.get('sun1'), 'interview');
    assert.equal(M.undoEvent('j5b', store, { dbPath })?.from_status, 'applied');
  }
  {
    const dbPath = path.join(dir, 'j5-his.db');
    const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
    const realSet = store.setStatus;
    store.setStatus = () => { throw new Error('database is locked'); };
    assert.throws(() => M.applyMessages([msg('j5c')], store, { dbPath }), /locked/);
    store.setStatus = realSet;
    store.status.set('sun1', 'rejected');   // he moved it himself in between
    assert.deepEqual(M.applyMessages([msg('j5c')], store, { dbPath }).moved, [], 'his move stands');
    assert.equal(store.status.get('sun1'), 'rejected');
  }
  {
    // The card moved, the lock hit the clearing of the mark, and he pressed
    // Undo before the next check: his undo stands.
    const dbPath = path.join(dir, 'j5-undone.db');
    const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
    M.applyMessages([msg('j5d')], store, { dbPath });
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE mail_events SET pending = 'moving' WHERE msg_id = 'j5d'").run();
    raw.close();
    assert.equal(M.undoEvent('j5d', store, { dbPath })?.from_status, 'applied');
    assert.deepEqual(M.applyMessages([], store, { dbPath }).moved, [], 'an undone row is not moved again');
    assert.equal(store.status.get('sun1'), 'applied');
  }
  {
    // The same order in rematchPending: an email placed on a later check.
    const dbPath = path.join(dir, 'j5-rematch.db');
    M.applyMessages([msg('j5e')], fakeStore([]), { dbPath });   // no card yet: kept for later
    const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
    const realSet = store.setStatus;
    store.setStatus = (id, s, o) => { realSet(id, s, o); throw new Error('database is locked'); };
    await assert.rejects(() => M.rematchPending(store, { dbPath, force: true }), /locked/);
    store.setStatus = realSet;
    const moved = [...M.applyMessages([], store, { dbPath }).moved, ...M.resolveUnsure(store, { dbPath }), ...await M.rematchPending(store, { dbPath, force: true })];
    assert.deepEqual(moved.map((m) => [m.from, m.to]), [['applied', 'interview']]);
    assert.equal(M.undoEvent('j5e', store, { dbPath })?.from_status, 'applied', 'Undo still knows where it came from');
  }
});

test('week review F3: the mail matcher reads every card, not the first 2000 of a filter', () => {
  const serve = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  const at = serve.indexOf('const mailStore = {');
  const jobs = serve.slice(at, serve.indexOf('const endOf', at));
  assert.ok(at > 0 && jobs.length > 0, 'mailStore.jobs is where it was');
  assert.doesNotMatch(jobs, /query\(f, \{ limit: 2000 \}\)\.rows/, 'one capped page silently drops the cards past it');
  assert.match(jobs, /offset \+= PAGE/, 'paged to the end');
  assert.match(jobs, /if \(rows\.length < PAGE\) break;/, 'stops on the short page, not at a cap');
  assert.match(jobs, /stable: true/, 'ties broken on id, so no card falls between two pages (week-fixes J4)');
});

// ── F-1052: the mail check never waits on the server's thread for another process's lock ──
// A second process (a scan, the enricher) holding the store's write lock, for
// real: BEGIN IMMEDIATE on the same file. When it lets go it first leaves a
// marker file, then commits, so "the marker is not there yet" means "the lock
// was still held" at that moment, with no timing threshold in the test.
import { spawn } from 'node:child_process';
async function holdLock(file, { ms = 0 } = {}) {
  const marker = `${file}.released-${randomTag()}`;
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const { writeFileSync } = require('node:fs');
    const d = new DatabaseSync(${JSON.stringify(file)});
    d.exec('PRAGMA busy_timeout = 5000');
    d.exec('BEGIN IMMEDIATE');
    process.stdout.write('held\\n');
    const let_go = () => { writeFileSync(${JSON.stringify(marker)}, ''); d.exec('COMMIT'); d.close(); process.exit(0); };
    if (${ms} > 0) setTimeout(let_go, ${ms});
    process.stdin.on('data', let_go);
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
  let gone = false;
  const exited = new Promise((r) => child.once('exit', () => { gone = true; r(); }));
  child.stdin.on('error', () => { /* it let go by itself first */ });
  return { released: () => existsSync(marker), release: async () => { if (!gone) child.stdin.write('go\n'); await exited; } };
}
let tagN = 0;
const randomTag = () => `${process.pid}-${tagN += 1}`;

async function connectedGmail(messages) {
  M.saveClient({ client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-value' }, { dir });
  const url2 = new URL(M.authUrl('http://localhost:4300/oauth/gmail/callback', { dir }));
  const ok = (body) => ({ ok: true, json: async () => body });
  const enc = (s) => Buffer.from(s).toString('base64url');
  const gmail = async (u) => {
    const s = String(u);
    if (s.includes('oauth2.googleapis.com/token')) return ok({ access_token: 'AT', refresh_token: 'RT', scope: M.SCOPE });
    if (s.endsWith('/profile')) return ok({ emailAddress: 'alex@example.test' });
    if (s.includes('/messages?')) return ok({ messages: s.includes('linkedin') ? [] : messages.map((m) => ({ id: m.id })) });
    const m = messages.find((x) => s.includes(`/messages/${x.id}`));
    if (m) {
      return ok({ id: m.id, internalDate: String(Date.parse(m.date)), snippet: m.body.slice(0, 40),
        payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], mimeType: 'text/plain', body: { data: enc(m.body) } } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await M.finishAuth({ code: 'c', state: url2.searchParams.get('state') }, { dir, fetchImpl: gmail });
  return gmail;
}
const SUNDAY_INVITE = { id: 'lock1', date: '2026-09-14T09:00:00Z', from: '"Sunday Recruiting" <talent@sunday.ai>', subject: 'Interview with Sunday', body: 'Hi Alex, we would like to schedule a phone interview this week.' };

test('F-1052: a check that meets another process\'s write lock waits for it without stopping the server, then moves the card', async () => {
  const gmail = await connectedGmail([SUNDAY_INVITE]);
  const dbFile = path.join(dir, 'f1052-wait.db');
  M.recentEvents({ dbPath: dbFile });   // the ledger exists, as on his store
  const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
  // The card moves run inside the store's short-wait section, as the dashboard's adapter gives it.
  let inside = false; const movedInside = [];
  store.shortWaits = (fn) => { inside = true; try { return fn(); } finally { inside = false; } };
  const realSet = store.setStatus;
  store.setStatus = (id, s, o) => { movedInside.push(inside); realSet(id, s, o); };
  const lock = await holdLock(dbFile, { ms: 1500 });
  // A timer the server would run: it must get its turn while the lock is still held.
  let heldWhenTimerRan = null;
  const timer = new Promise((r) => setTimeout(() => { heldWhenTimerRan = !lock.released(); r(); }, 300));
  const r = await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } });
  await timer; await lock.release();
  assert.equal(heldWhenTimerRan, true, 'the event loop ran while the other process held the lock (the old code sat inside SQLite until it let go)');
  assert.equal(r.ok, true, r.error);
  assert.equal(store.status.get('sun1'), 'interview', 'once the lock was free, the email moved its card');
  assert.deepEqual(movedInside, [true], 'the move ran inside the short-wait section');
  const serve = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  assert.match(serve, /shortWaits: \(fn\) => withBusyTimeout\(MAIL_WAIT_MS, fn\)/, "the dashboard's store gives the check its short wait");
  M.disconnect({ dir });
});

// The old code sat inside SQLite for its 30 s busy timeout, twice; 20 s is far past what the fix takes.
test('F-1052: a lock held past the wait ends the check as busy, quickly, with nothing half-moved', { timeout: 20000 }, async () => {
  const gmail = await connectedGmail([{ ...SUNDAY_INVITE, id: 'lock2' }]);
  const dbFile = path.join(dir, 'f1052-busy.db');
  M.recentEvents({ dbPath: dbFile });
  const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
  const lock = await holdLock(dbFile);
  try {
    const r = await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} }, lockWait: [20, 20] });
    assert.equal(lock.released(), false, 'it returned while the lock was still held: it did not wait the lock out');
    assert.equal(r.ok, false);
    assert.equal(r.busy, true, 'named as a lock, so the server checks again in 5 minutes');
    assert.match(r.error, /busy|locked/i);
    assert.equal(store.status.get('sun1'), 'applied', 'nothing moved');
  } finally { await lock.release(); }
  const again = await M.syncMail(store, { dir, dbPath: dbFile, fetchImpl: gmail, retry: { sleep: async () => {} } });
  assert.equal(again.ok, true, again.error);
  assert.equal(store.status.get('sun1'), 'interview', 'the next check reads the email and moves the card');
  M.disconnect({ dir });
});

test('F-1052: with nothing to place, rematchPending writes nothing, so a held lock costs it nothing', async () => {
  const dbFile = path.join(dir, 'f1052-idle.db');
  M.recentEvents({ dbPath: dbFile });
  const lock = await holdLock(dbFile, { ms: 1500 });
  try {
    assert.deepEqual(await M.rematchPending(fakeStore([]), { dbPath: dbFile }), []);
    assert.equal(lock.released(), false, 'it returned while the lock was held (the old code ran a write every check and sat on the lock)');
  } finally { await lock.release(); }
});

test('F-1052: inside a mail write section a store write waits only briefly for a lock, and the usual wait comes back after', async () => {
  const S = await import('./store.mjs');
  const file = S.dbPath();
  S.db();
  const lock = await holdLock(file);
  try {
    assert.equal(typeof S.withBusyTimeout, 'function');
    assert.throws(() => S.withBusyTimeout(0, () => S.db().prepare("UPDATE meta SET v = v WHERE k = 'schema_version'").run()), (e) => e.errcode === 5 || /database is locked/.test(e.message));
    assert.equal(lock.released(), false, 'it gave up while the lock was held');
  } finally { await lock.release(); }
  assert.equal(Number(S.db().prepare('PRAGMA busy_timeout').get().timeout), 30000, 'the connection keeps its usual patience for everything else');
  assert.throws(() => S.withBusyTimeout(0, async () => {}), /synchronous/, 'an async section is refused');
  assert.equal(Number(S.db().prepare('PRAGMA busy_timeout').get().timeout), 30000);
});

test('F-1052 review: his Undo press waits out a lock as before, so the card and its row stay together', async () => {
  const dbFile = path.join(dir, 'f1052-undo.db');
  const store = fakeStore([{ ...JOBS[4], status: 'applied' }]);
  M.applyMessages([{ id: 'undo1', date: '2026-09-14T09:00:00Z', fromName: 'Sunday Recruiting', fromEmail: 'talent@sunday.ai', subject: 'Interview with Sunday', body: 'Hi Alex, we would like to schedule a phone interview this week.' }], store, { dbPath: dbFile });
  assert.equal(store.status.get('sun1'), 'interview');
  const lock = await holdLock(dbFile, { ms: 800 });   // longer than the check's quarter second
  let done;
  try { done = M.undoEvent('undo1', store, { dbPath: dbFile }); } finally { await lock.release(); }
  assert.ok(done?.undone_at, 'the row is marked undone (a quarter-second wait threw here, after the card had moved)');
  assert.equal(store.status.get('sun1'), 'applied');
  assert.equal(M.undoEvent('undo1', store, { dbPath: dbFile }), null, 'and a second press has nothing to undo');
});

// ── F-1052, the boot block (2026-11-14) ──────────────────────────────
// The first check after every boot re-decides each unplaced email, and an
// email no card matches reads every posting at its company. On his store that
// was 55 reads for 73 emails (Amazon's 35,414 rows 16 times) in one
// synchronous run: 14.2 s with every request waiting, 2 s into the check.
const bootReceipt = (id, co, extra = '') => ({ id, date: '2026-11-01T10:00:00Z', fromName: `${co} Recruiting`, fromEmail: `jobs@${co.toLowerCase()}.example`, subject: `Thank you for applying to ${co}`, body: `We have received your application and will review it.${extra}` });
const turns = () => {
  const t = { n: 0, on: true };
  const spin = () => { if (t.on) { t.n += 1; setImmediate(spin); } };
  setImmediate(spin);
  return t;
};

test('F-1052 boot block: the first rematch after a boot reads each company once and lets the server run between emails', async () => {
  const dbFile = path.join(dir, 'f1052-boot.db');
  const now = new Date('2026-11-14T06:00:00Z');
  const mails = [bootReceipt('b1', 'Vesta'), bootReceipt('b2', 'Vesta'), bootReceipt('b3', 'Orbit'), bootReceipt('b4', 'Vesta'), bootReceipt('b5', 'Orbit'), bootReceipt('b6', 'Vesta')];
  M.applyMessages(mails, fakeStore([]), { dbPath: dbFile, now });   // no card and no lookup: each kept for later
  const reads = new Map();
  const store = { ...fakeStore([]), jobsAtCompany: (co) => { reads.set(co, (reads.get(co) || 0) + 1); return []; } };
  const t = turns();
  const stats = {};
  const moved = await M.rematchPending(store, { dbPath: dbFile, now, stats });
  t.on = false;
  assert.deepEqual(moved, []);
  assert.deepEqual(Object.fromEntries(reads), { Vesta: 1, Orbit: 1 }, 'one read per company per check (the old rematch read Vesta 4 times and Orbit twice)');
  assert.ok(t.n >= mails.length, `the server ran between the emails (${t.n} turns; the old rematch ran all six in one turn)`);
  assert.equal(stats.ran, true);
  assert.equal(stats.rows, 6);
  assert.equal(stats.companies, 2);
});

test('F-1052 boot block: a store with a paged reader is read through it, never in one statement, and the email is still placed', async () => {
  const dbFile = path.join(dir, 'f1052-paged.db');
  const now = new Date('2026-11-14T06:00:00Z');
  M.applyMessages([bootReceipt('p1', 'Lumen', ' Requisition 4815162.'), bootReceipt('p2', 'Lumen')], fakeStore([]), { dbPath: dbFile, now });
  const loads = [];
  const posting = { id: 'lumen-4815162', company: 'Lumen', title: 'Mechanical Engineer', status: 'new', url: 'https://lumen.example/jobs/4815162', location: '' };
  const base = fakeStore([]);
  const store = {
    ...base,
    jobsAtCompany: () => { throw new Error('read in one statement'); },
    loadCompany: async (co) => { loads.push(co); await new Promise((r) => setImmediate(r)); return [posting]; },
  };
  const moved = await M.rematchPending(store, { dbPath: dbFile, now });
  assert.deepEqual(loads, ['Lumen'], 'read once, through the paged reader');
  assert.deepEqual(moved.map((m) => [m.jobId, m.to]), [['lumen-4815162', 'applied']], 'the receipt naming the posting id moves it, as before');
  assert.equal(base.status.get('lumen-4815162'), 'applied');
});

test('F-1052 boot block: the check runs the rematch with awaits, and says what each step took', async () => {
  const src = readFileSync(new URL('./mail.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('export async function syncMail');
  const body = src.slice(at, src.indexOf('\nexport function mailStepsLine', at));
  assert.match(body, /await rematchPending\(view/, 'the rematch is awaited, outside the synchronous write section');
  assert.match(body, /await readCompaniesFor\(messages, view\)/, "new emails' companies are read before the writes");
  const serve = readFileSync(new URL('./serve.mjs', import.meta.url), 'utf8');
  assert.match(serve, /async loadCompany\(company\)[\s\S]{0,200}jobsUnderCompanies\(hit\)/, "the dashboard's adapter reads a company a page at a time");
  assert.match(serve, /try \{ trace\(mailStepsLine\(r\)\); \} catch/, 'every check writes its step line to the trace, and a log line never fails the check');
  assert.equal(M.mailStepsLine({ ok: true, steps: { totalMs: 1000, rematch: { rows: 0, ran: false, ms: 0 } } }), 'mail check ok in 1.0s; rematch: nothing pending');
  const line = M.mailStepsLine({ ok: true, steps: { totalMs: 3200, gmailMs: 1900, fetched: 0, readMs: 0, lockMs: 2, writeMs: 310, rematch: { ran: true, rows: 73, companies: 22, ms: 1800, longestMs: 120 }, foldMs: 450, linkedinMs: 600, linkedin: { emails: 12, seenMs: 3, applyMs: 40 } } });
  assert.equal(line, 'mail check ok in 3.2s; gmail 1.9s (0 new); company reads 0.0s; lock wait 0.0s; write section 0.3s; rematch 73 emails, 22 companies read, 1.8s (longest step 0.1s); fold 0.5s; linkedin 12 emails, 0.6s (seen-check 0.0s, apply 0.0s)');
  assert.match(M.mailStepsLine({ ok: false, busy: true, steps: { totalMs: 30000, rematch: { rows: 73, ran: false, ms: 1 } } }), /^mail check failed \(busy\) in 30\.0s; rematch skipped \(73 emails, nothing changed\)$/);
});

test('F-1052 boot block: jobsUnderCompanies returns the rows of the one-statement read, a page at a time', async () => {
  const S = await import('./store.mjs');
  const d = S.db();
  const ins = d.prepare('INSERT OR REPLACE INTO jobs (id, url, title, company, location, status, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 7; i++) ins.run(`juc-a${i}`, `https://a.example/${i}`, `Role ${i}`, 'Paged Co', i % 2 ? 'Austin, TX' : '', 'new', '2026-11-01T00:00:00Z');
  ins.run('juc-b0', 'https://b.example/0', 'Other role', 'Paged Co Inc', '', 'applied', null);
  ins.run('juc-c0', 'https://c.example/0', 'Not this one', 'Unpaged', '', 'new', null);
  const names = ['Paged Co', 'Paged Co Inc'];
  const one = d.prepare(`SELECT id, company, title, status, url, location, first_seen AS firstSeen FROM jobs WHERE company IN (${names.map(() => '?').join(',')})`).all(...names);
  let pauses = 0;
  const paged = await S.jobsUnderCompanies(names, { page: 3, pause: async () => { pauses += 1; } });
  const key = (r) => JSON.stringify([r.id, r.company, r.title, r.status, r.url, r.location, r.firstSeen]);
  assert.deepEqual(paged.map(key).sort(), one.map(key).sort(), 'the same rows and fields');
  assert.equal(paged.length, 8);
  assert.ok(!('rid' in paged[0]), 'the paging key is not part of a row');
  assert.ok(pauses >= 3, `awaits between pages and names (${pauses})`);
  d.prepare("DELETE FROM jobs WHERE id LIKE 'juc-%'").run();
});

test('F-1052 boot block review: an email whose decision throws is skipped, the rest of the pass still runs, and a lock still ends it', async () => {
  const dbFile = path.join(dir, 'f1052-skip.db');
  const now = new Date('2026-11-14T06:00:00Z');
  M.applyMessages([bootReceipt('s1', 'Vesta'), bootReceipt('s2', 'Lumen', ' Requisition 4815162.')], fakeStore([]), { dbPath: dbFile, now });
  const posting = { id: 'lumen-s-4815162', company: 'Lumen', title: 'Mechanical Engineer', status: 'new', url: 'https://lumen.example/jobs/4815162', location: '' };
  const rows = (co) => { if (/vesta/i.test(co)) throw new Error('boom'); return [posting]; };
  const base = fakeStore([]);
  const store = { ...base, jobsAtCompany: rows, loadCompany: async (co) => rows(co) };
  const stats = {};
  const moved = await M.rematchPending(store, { dbPath: dbFile, now, stats });
  assert.deepEqual(moved.map((m) => m.jobId), ['lumen-s-4815162'], 'the Lumen receipt is placed although Vesta threw');
  assert.equal(stats.skipped, 1);
  const locked = { ...fakeStore([]), jobsAtCompany: () => { throw new Error('database is locked'); }, loadCompany: async () => { throw new Error('database is locked'); } };
  await assert.rejects(() => M.rematchPending(locked, { dbPath: dbFile, now, force: true }), /locked/, 'a lock is not skipped: the check ends busy');
});
