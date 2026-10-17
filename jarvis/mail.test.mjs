/**
 * His inbox moves his application cards — classified, matched, moved forward
 * only, and undoable. Real-shaped recruiting emails; a fake Gmail; a temp store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

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
  const folded = M.foldAppliedCopies(fakeStore([lever, li]), { dbPath: dbF });
  assert.deepEqual(folded.map((f) => f.copyId), ['li']);
  assert.equal(h.prepare("SELECT superseded_by FROM jobs WHERE id = 'li'").get().superseded_by, 'lever');
  assert.deepEqual(M.foldAppliedCopies(fakeStore([lever, li]), { dbPath: dbF }), [], 'once');
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
