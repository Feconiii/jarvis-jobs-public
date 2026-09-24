/**
 * His inbox moves his application cards — classified, matched, moved forward
 * only, and undoable. Real-shaped recruiting emails; a fake Gmail; a temp store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
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

test('A RECEIPT THAT PROMISES A CALL IS NOT AN INTERVIEW — the Applied Intuition email, 2026-09-17', () => {
  const c = (subject, body) => M.classifyMessage({ subject, body });
  assert.equal(c('Thank you for applying to Applied Intuition | Mechanical Engineer - New Grad',
    "Hi Le, Thanks for applying to Applied Intuition! Our recruiting team will review your profile as soon as possible. If your application seems like a good fit for the role, we'll reach out directly to set up an initial call to learn more about your experience."), 'received');
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

test('parseGmailMessage reads the sender, subject and an HTML-only body', () => {
  const m = M.parseGmailMessage({
    id: 'x', internalDate: '1757840000000', snippet: 's',
    payload: { headers: [{ name: 'From', value: 'Jabil Careers <careers@jabil.com>' }, { name: 'Subject', value: 'Hello' }], mimeType: 'text/html', body: { data: Buffer.from('<p>Thank&nbsp;you <b>for applying</b></p><style>p{}</style>').toString('base64url') } },
  });
  assert.equal(m.fromName, 'Jabil Careers');
  assert.equal(m.fromEmail, 'careers@jabil.com');
  assert.equal(m.body, 'Thank you for applying');
});
