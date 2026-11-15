#!/usr/bin/env node
// jarvis/outreach.test.mjs — the target spec, the message rules, and the
// ledger that says no.
//
// Shaped like visa.test.mjs: the message checks are a CORPUS, because the
// failures that matter are sentences. Three of them cost more than a wasted
// draft — they cost the contact, and in an industry where AMAT, KLA, Lam and
// ASML people rotate between the four, a burnt contact is expensive for years:
//
//   · asking for a referral in a first message  (the backdoor application)
//   · naming a visa                              (invites a filter that does not apply)
//   · inventing rapport                          (the thing that cannot be walked back)
//
// Every one of those is asserted in BOTH directions, because a check that
// refuses everything is as useless as one that refuses nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  targetSpec, linkedinSearch, emailPattern, domainFrom, candidateEmail,
  checkOutreach, writeOutreach, buildOutreachPrompt, CHANNELS, PERSONAS, stripSelfTalk, experienceGap, portfolioUrl, displayTitle, postingLink,
} from './outreach.mjs';
import {
  contactId, addBusinessDays, canContact, saveContact, getContact, markSent,
  markReplied, markDoNotContact, dueFollowUps, outreachStats, forJob, removeUnsent, markInvited, markConnected, acceptedUnsent,
  retireContact, unretireContact, isOpen, outreachConnectQueue,
} from './contacts.mjs';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (name, cond, msg = '') => check(name, !!cond, true) || (cond ? null : console.error(`    ${msg}`));

// ── 1. the search spec ──────────────────────────────────────────────
console.log('🧪 outreach: the spec names a team and a title, never a person');

const JOB = {
  id: 'j1', company: 'Applied Materials', title: 'Manufacturing Engineer I',
  team: 'Fab Automation', location: 'Austin, TX',
};
const DESC = 'You will join the Equipment Engineering team in Austin. This role reports to the Manufacturing Engineering Manager, and works alongside process engineers.';

const spec = targetSpec(JOB, { description: DESC, domain: 'amat.com' });
check('the row\'s team wins over the body\'s', spec.team, 'Fab Automation');
check('the reporting line is read as a TITLE', spec.managerTitle, 'Manufacturing Engineering Manager');
check('alumni is offered first', spec.personas[0].key, 'alumni');
ok('a recruiter is NOT offered when there is a team to aim at',
  !spec.personas.some((p) => p.key === 'recruiter'));

// The body supplies the team when the row does not.
const spec2 = targetSpec({ company: 'KLA', title: 'Test Engineer' }, { description: DESC });
check('the body\'s team is used when the row has none', spec2.team, 'Equipment Engineering');

// Nothing to aim at: a recruiter becomes the last resort, and is labelled one.
const spec3 = targetSpec({ company: 'Nowhere Inc', title: 'Engineer' }, { description: 'A great opportunity.' });
ok('with no team and no reporting line, a recruiter is the last resort',
  spec3.personas.some((p) => p.key === 'recruiter'));
check('…and the recruiter is ranked last', spec3.personas.at(-1).key, 'recruiter');

// A NAME IN A JD IS A RECRUITER'S, and a name is not a title.
const spec4 = targetSpec({ company: 'X' }, { description: 'This position reports to Jane Smith, who leads the group.' });
check('a person\'s name is not accepted as a reporting title', spec4.managerTitle, '');

console.log('🧪 outreach: the search is a link he clicks, not a robot');
const url = linkedinSearch('Applied Materials', 'alumni');
ok('the alumni search names his school', url.includes(encodeURIComponent('Lakeside University')));
ok('…and it is an ordinary search URL', url.startsWith('https://www.linkedin.com/search/results/people/?keywords='));

// ── 2. email, at the scale of one ───────────────────────────────────
console.log('🧪 outreach: one address, or none, and it says which');

// Measured across his whole deck: 84 distinct addresses, 83 of them role
// accounts. The pattern is only inferable when a PERSON-shaped one appears.
check('role accounts teach nothing about the pattern',
  emailPattern(['accommodations_program@amat.com', 'talent.acquisition@kla.com', 'hrsupport_na@micron.com', 'jobs.accommodations@sandisk.com']),
  null);
check('a person-shaped address does',
  emailPattern(['careers@sunrun.com', 'robin.hale@sunrun.com']),
  { pattern: 'first.last', domain: 'sunrun.com', from: 'robin.hale@sunrun.com' });
check('a role account still proves the domain', domainFrom(['accommodations_program@amat.com']), 'amat.com');

const inferred = candidateEmail('Dana Lee', { domain: 'sunrun.com', pattern: 'first.last' });
check('an inferred address is built from the confirmed pattern', inferred.address, 'dana.lee@sunrun.com');
check('…and says it is inferred', inferred.confidence, 'inferred');
const guessed = candidateEmail('Dana Lee', { domain: 'amat.com' });
check('an unconfirmed one is labelled a guess', guessed.confidence, 'guess');
ok('…and says to check it before sending', /check it before sending/.test(guessed.note));
check('one name is not enough to build an address', candidateEmail('Dana', { domain: 'x.com' }), null);
check('no domain, no address', candidateEmail('Dana Lee', {}), null);

// ── 3. the message rules ────────────────────────────────────────────
console.log('🧪 outreach: the three failures that cost the contact');

const CV = 'Alex Rivera. Lakeside University, BS Mechanical Engineering May 2027. Applied Materials internship. CNC, SolidWorks, GD&T. Universal Robots UR10e cobot.';
const JD = 'Manufacturing Engineer I at Applied Materials, Austin TX. Equipment Engineering team. Process tooling and fixture design.';
const POSTING_URL = 'https://jobs.example.com/amat/12345';
const PORTFOLIO = 'https://alexrivera.example';
const APPLIED_JOB = { ...JOB, status: 'applied', url: POSTING_URL };
const opts = { channel: 'email', cvText: CV, jd: JD, job: APPLIED_JOB, contact: { name: 'Dana Lee', title: 'Equipment Engineer' }, portfolio: PORTFOLIO };
const problems = (t, o = opts) => checkOutreach(t, o).problems;
const has = (t, re = /./, o = opts) => problems(t, o).some((p) => re.test(p));

// HIS FORMULA (2026-09-27): PERSON → ROLE → JOB LINK → MINI PITCH → WHY I CARE
// → ASK (their opinion on his fit) → Portfolio / Resume: Attached.
const BODY = `Hi Dana, I applied for the Manufacturing Engineer I role on the Equipment Engineering team in Austin, and I'm very interested in it.
${POSTING_URL}
I'm a senior mechanical engineering student at Lakeside graduating in May 2027. At Applied Materials I worked on process tooling and set up a Universal Robots UR10e cobot cell, which is close to the fixture design in the posting.
That mix of tooling and automation is the direction I want to build toward. Do you think my background could be relevant to the team?`;
const SIGN = `\n\nAlex\nPortfolio: ${PORTFOLIO}\nResume: Attached`;
const mk = (body) => body + SIGN;
const GOOD = mk(BODY);
check('a good message passes clean', problems(GOOD), []);

console.log('🧪 outreach: direct, as he asked — one ask, their opinion on his fit (2026-09-27)');
ok('"how is the team split" is a filler question and fails', has(mk(BODY.replace('Do you think', 'How is the team split between sustaining and bring-up? Do you think')), /filler question/));
ok('"curious how" fails', has(mk(BODY.replace('That mix', 'Curious how the group is set up. That mix')), /filler question/));
ok('"what do you look for" fails', has(mk(BODY.replace('Do you think', 'What do you look for in someone starting out? Do you think')), /filler question/));
ok('two questions fail: one ask', has(mk(`${BODY} Is the role still open?`), /questions; one ask/));
ok('a message without the fit ask fails', has(mk(BODY.replace(/Do you think[^?]*\?/, 'Hope to hear from you.')), /does not ask/));
ok('his ask as a statement passes: "letting me know if you think my background could be relevant"', !has(mk(BODY.replace(/Do you think[^?]*\?/, "If you have a chance, I'd really appreciate you taking a quick look at my resume and portfolio and letting me know if you think my background could be relevant to the team.")), /does not ask/));

// HIS TEMPLATE, LOCKED (2026-10-04). Sent to Chris Bell at Tesla; he replied
// the same evening and passed it to the MADE team's hiring manager. Every check
// in this file must keep passing it, word for word.
{
  const TESLA_URL = 'https://www.tesla.com/careers/search/job/mechanical-design-engineer-automation-261105';
  const CHRIS = `Hi Chris,

I saw your post about the team at Gigafactory Nevada looking for engineers with mechanical design and automation equipment experience, and since you mentioned candidates could reach out directly, I wanted to introduce myself.

I recently applied for the Mechanical Design Engineer, Automation role in your most recent posting:
${TESLA_URL}

I'm a senior Mechanical Engineering student at Lakeside graduating in May 2027. This past summer I worked with Applied Materials' Automation Technology Group on mechanical design, robotic automation, machine vision hardware, equipment testing, fabrication, and bringing designs from CAD into physical systems.

The role stood out because the mix of custom automation equipment, mechanisms, robotics, fabrication, commissioning, and production troubleshooting is really close to the work I've enjoyed most. If you have a chance, I'd really appreciate you taking a quick look at my resume and portfolio and letting me know if you think my background could be relevant to the team.

Portfolio: https://alexrivera.example
Resume: Attached

Thank you!
Alex`;
  const chrisOpts = {
    channel: 'message',
    cvText: 'Alex Rivera. Lakeside University, BS Mechanical Engineering, May 2027. Applied Materials, Automation Technology Group: mechanical design, robotic automation, machine vision hardware, equipment testing, fabrication, CAD.',
    jd: 'Mechanical Design Engineer, Automation. Design custom automation equipment and mechanisms; robotics; fabrication; commissioning; production troubleshooting.',
    job: { company: 'Tesla', title: 'Mechanical Design Engineer, Automation', status: 'applied', url: TESLA_URL },
    contact: { name: 'Chris Bell' },
    lead: { signal: { kind: 'invited', standing: 'fresh', ageDays: 5, quote: 'The team at Gigafactory Nevada is looking for engineers with mechanical design and automation equipment experience. Candidates can reach out directly.', url: 'https://x.test/chris', author: 'Chris Bell' } },
    portfolio: PORTFOLIO,
  };
  check('his Tesla message, the one Chris answered, passes every check', checkOutreach(CHRIS, chrisOpts).problems, []);
  // The role's title opens on a word `entitiesIn` drops (first position), and
  // the posting body never repeats it: "innovation" failed (2026-10-04, Shreyash).
  const titled = CHRIS.replace(/applied for the [^\n]+ role:/, 'applied for the Innovation and Design Engineer role:');
  const titledOpts = { ...chrisOpts, job: { ...chrisOpts.job, title: 'Innovation and Design Engineer, Worldwide Design Engineering' } };
  check('a word from the role\'s own title is not an invented name', checkOutreach(titled, titledOpts).problems.filter((p) => /innovation/i.test(p)), []);
}

// HIS REWRITE, LOCKED (2026-10-05). He rewrote the Devin draft because it
// "read pretty bad": one piece of work told start to finish, the "why" as what
// he enjoys, the ask about his application, "Resume attached." as a sentence.
{
  const AMZ_URL = 'https://www.amazon.jobs/en/jobs/10503216/robotics-systems-engineer-i-tech-deployment';
  const DEVIN = `Hi Devin,

I saw your post that you're hiring Systems Engineers for Technology Deployment within Amazon Robotics, and since you mentioned you'd love to connect, I wanted to introduce myself.

I recently applied for the Robotics Systems Engineer I, Tech Deployment role:
${AMZ_URL}

I'm a senior Mechanical Engineering student at Lakeside graduating in May 2027. This past summer I worked with Applied Materials' Automation Technology Group, where I supported the deployment and validation of Autonomous Mobile Robots for cleanroom material handling, and developed and validated UR cobot motion in RoboDK while helping lay out and install the cell.

The role stood out because seeing automation come to life at scale on a live floor is really close to the work I've enjoyed most. I'd really appreciate it if you could take a look at my application and see if I might be a good fit for the team.

Portfolio: https://alexrivera.example
Resume attached.

Thank you!
Alex`;
  const devinOpts = {
    channel: 'message',
    cvText: 'Alex Rivera. Lakeside University, BS Mechanical Engineering, May 2027. Applied Materials, Automation Technology Group: supported deployment and validation of Autonomous Mobile Robots for cleanroom material handling; programmed and validated a UR collaborative robot in RoboDK and helped lay out and install it in the cell.',
    jd: 'Robotics Systems Engineer I, Tech Deployment. Amazon Robotics Technology Deployment: deploy robotic systems at scale on live fulfillment floors.',
    job: { company: 'Amazon', title: 'Robotics Systems Engineer I, Tech Deployment', status: 'applied', url: AMZ_URL },
    contact: { name: 'Devin Shah' },
    lead: { signal: { kind: 'invited', standing: 'fresh', ageDays: 10, quote: "We're hiring Systems Engineers for Technology Deployment within Amazon Robotics. I'd love to connect!", url: 'https://x.test/devin', author: 'Devin Shah' } },
    portfolio: PORTFOLIO,
  };
  check('his rewrite to Devin passes every check', checkOutreach(DEVIN, devinOpts).problems, []);
  const prompt = buildOutreachPrompt({ job: devinOpts.job, contact: { name: 'Dana Lee' }, channel: 'message', portfolio: PORTFOLIO });
  ok('the prompt carries his rewrites as the style', /Hi Devin,/.test(prompt) && /Hi Priya,/.test(prompt) && /Resume attached\./.test(prompt) && !/taking a quick look at my resume and portfolio/.test(prompt));
}
ok('"pick your brain" is a phrase he bans', has(mk(BODY.replace('Do you think', 'I would love to pick your brain. Do you think')), /networking phrase/));
ok('"15 minutes to chat" too', has(mk(BODY.replace('Do you think', 'Would you have 15 minutes to chat, and do you think')), /networking phrase/));
ok('"stuck with me" is a reaction he never had, and fails', has(mk(BODY.replace('I applied', 'Your post on fixture design stuck with me. I applied')), /reaction he never had/, { ...opts, lead: { personal: { text: 'Wrote a post on fixture design', source_url: 'https://x.test/p' } } }));
ok('"your LinkedIn shows" reads their profile back to them, and fails', has(mk(BODY.replace('I applied', 'Your LinkedIn shows you recruit engineers. I applied')), /profile back/));
ok('flattery fails', has(mk(BODY.replace('I applied', 'Your team is impressive. I applied')), /flatter/));
ok('"I applied" is refused when he has not', has(GOOD, /has not applied/, { ...opts, job: { ...APPLIED_JOB, status: 'queued' } }));
ok('…and allowed when he has', !has(GOOD, /has not applied/));

console.log('🧪 outreach: the tells the 2026-09-27 drafts leaned on');
ok('"genuinely interested" fails', has(mk(BODY.replace("I'm very interested", "I'm genuinely interested")), /machine/));
ok('"the kind of work I want to learn from" opener fails', has(mk(BODY.replace('I applied', 'Your move from HGST to manufacturing leadership is the kind of depth I want to learn from. I applied')), /machine/));
ok('"I saw your recruiting focus" reads their profile back', has(mk(BODY.replace('I applied', 'I saw your recruiting focus is manufacturing talent. I applied')), /profile back/));
ok('a title copied from a web address fails', has(mk(BODY.replace('Manufacturing Engineer I role', 'Mechanical Systems Engineer Ncg role')), /web address/));
ok('calling a contract role an internship fails', has(mk(BODY.replace('Manufacturing Engineer I role', 'Manufacturing Engineer I internship')), /internship/));
ok('…but his own Applied Materials internship is his to mention', !has(mk(BODY.replace('At Applied Materials I', 'During my internship at Applied Materials I')), /internship/));
check('tracking parameters come off the posting link', [postingLink('https://jobs.ashbyhq.com/sunday/9ce1/application?utm_source=Simplify'), postingLink('https://boards.greenhouse.io/x/jobs/1?gh_jid=1&gh_src=abc'), postingLink('')],
  ['https://jobs.ashbyhq.com/sunday/9ce1/application', 'https://boards.greenhouse.io/x/jobs/1?gh_jid=1', '']);
check('a Workday link stored at the apply step goes out as the posting (Hyve, 2026-10-05)',
  postingLink('https://synnex.wd5.myworkdayjobs.com/en-US/hyvecareers/job/Reno%2C-NV/Process-Engineer--New-College-Grad-_R56671/apply/autofillWithResume?source=LinkedIn'),
  'https://synnex.wd5.myworkdayjobs.com/en-US/hyvecareers/job/Reno%2C-NV/Process-Engineer--New-College-Grad-_R56671');
check('titles rebuilt from a web address read as the company writes them',
  ['Mechanical Systems Engineer Ncg', 'Gas Systems Engineer O M Boise Idaho United States Of America', 'New College Grad Rda Engineer Aptd Boise Idaho United States Of America', 'Robotics Systems Engineer I, Tech Deployment'].map(displayTitle),
  ['Mechanical Systems Engineer NCG', 'Gas Systems Engineer O&M', 'New College Grad RDA Engineer APTD', 'Robotics Systems Engineer I, Tech Deployment']);

console.log('🧪 outreach: no friction — the job, the portfolio, the resume');
ok('no posting link fails', has(GOOD.replace(`${POSTING_URL}\n`, ''), /direct link/));
ok('no portfolio fails', has(GOOD.replace(`\nPortfolio: ${PORTFOLIO}`, ''), /portfolio/));
ok('no "Resume attached." fails', has(GOOD.replace('\nResume: Attached', ''), /Resume attached/));
ok('"Resume attached." as a sentence passes (his rewrites, 2026-10-05)', !has(GOOD.replace('Resume: Attached', 'Resume attached.'), /Resume attached/));
ok('a connection note is exempt: it has no room', !has('Hi Dana, I applied for the Manufacturing Engineer I role. Do you think my Applied Materials background could be a fit for the team?', /direct link|portfolio|Resume attached/, { ...opts, channel: 'note' }));
ok('the link\'s own digits are not a fabricated figure', !has(GOOD, /figure "12345"/));
check('the experience gap is read from the posting', [experienceGap('Requires 2-6 years of relevant engineering experience.'), experienceGap('3+ years experience with SolidWorks'), experienceGap('0-2 years of experience'), experienceGap('')], ['2-6 years', '3+ years', '', '']);
check('the portfolio comes from profile.yml', portfolioUrl('  portfolio_url: "alexrivera.example"'), 'https://alexrivera.example');

console.log('🧪 outreach: something about them, only when it is theirs and current');
const LEAD_FRESH = { signal: { kind: 'invited', standing: 'fresh', ageDays: 9, quote: 'My team is hiring manufacturing engineers in Austin, send me your resume', url: 'https://x.test/p', author: 'Dana Lee' }, personal: null };
const WITH_POST = mk(BODY.replace('I applied', 'I saw your post about hiring manufacturing engineers in Austin, so I wanted to reach out. I applied'));
ok('"I saw your post" passes when the research found their post', !has(WITH_POST, /post|shared history|reaction/, { ...opts, lead: LEAD_FRESH }));
ok('…the same line with no research behind it fails', has(WITH_POST, /shared history|verify/));
// A six-month-old post is HISTORY (2026-10-05): it may be named ("your post
// about hiring…") but never as current — "is hiring" or "recent" fails.
const STALE = { ...opts, lead: { signal: { ...LEAD_FRESH.signal, standing: 'stale', ageDays: 180 } } };
ok('…a six-month-old post may be named as history', !has(WITH_POST, /post|shared history/, STALE));
ok('…but never as the team hiring now', has(mk(BODY.replace('I applied', 'I saw your post that your team is hiring in Austin. I applied')), /hiring now; their post is 180 days old/, STALE));
ok('…nor someone else\'s post they reposted', has(WITH_POST, /repost of Priya Nair/, { ...opts, lead: { signal: { ...LEAD_FRESH.signal, standing: 'reposted', author: 'Priya Nair' } } }));
ok('a ten-week-old post may be named but never called recent', has(mk(BODY.replace('I applied', 'I saw your recent post about hiring in Austin. I applied')), /calls their post recent/, { ...opts, lead: { signal: { ...LEAD_FRESH.signal, standing: 'weak', ageDays: 70 } } }));
const ALUM = mk(BODY.replace('I applied', "I noticed you're also a Lakeside alum, so I figured it was worth reaching out directly. I applied"));
ok('"you\'re also a Lakeside alum" fails when nothing found says so', has(ALUM, /Lakeside, but nothing found/, { ...opts, lead: { personal: { text: 'Leads fixture design for the etch group', source_url: 'https://x.test/p' } } }));
ok('…and passes when it is theirs', !has(ALUM, /Lakeside|shared history/, { ...opts, lead: { personal: { text: 'BS Mechanical Engineering, Lakeside University, 2016', source_url: 'https://x.test/p' } } }));
const LEAD_TALK = { personal: { text: 'Presented a talk on wafer handler calibration at SEMICON West 2026', source_url: 'https://x.test/talk' } };
ok('a sourced detail about them may be named', !has(mk(BODY.replace('I applied', 'I came across your talk on wafer handler calibration at SEMICON West and wanted to reach out. I applied')), /SEMICON|shared history/, { ...opts, lead: LEAD_TALK }));
ok('asking a stranger to refer him fails', has(mk(BODY.replace('Do you think', 'Could you refer me, and do you think')), /referral/));
ok('…but not someone whose own post offered referrals', !has(mk(BODY.replace('Do you think', 'If it looks like a fit, could you refer me, and do you think')), /referral/, { ...opts, lead: { signal: { ...LEAD_FRESH.signal, quote: 'DM me, happy to refer strong candidates' } } }));

// THE BACKDOOR APPLICATION.
ok('"pass my resume along" is a referral ask in other words', has(mk(BODY.replace('Do you think', 'Could you pass my resume along to the hiring manager, and do you think')), /referral|backdoor/i));
ok('…but asking their opinion on his fit is not', !has(GOOD, /referral|backdoor/i));

// THE VISA.
ok('naming sponsorship fails', has(mk(BODY.replace('That mix', 'I will need visa sponsorship after graduation. That mix')), /visa|sponsorship/i));
ok('naming OPT fails', has(mk(BODY.replace('That mix', 'I am on OPT. That mix')), /visa|sponsorship/i));
ok('…and a clean message says nothing about it', !has(GOOD, /visa|sponsorship/i));

// INVENTED RAPPORT — the one that cannot be walked back.
ok('claiming to have read their article fails', has(mk(BODY.replace('I applied', 'I really loved your post on tool automation. I applied')), /shared history|verify|reaction/i));
ok('claiming to have met them fails', has(mk(BODY.replace('I applied', 'We met at SEMICON last year. I applied')), /shared history|verify/i));

console.log('🧪 outreach: only what is in cv.md or the posting');
ok('a company he never worked at is caught', has(GOOD.replace('Applied Materials', 'Intel'), /intel/i));
ok('an invented figure is caught', has(mk(BODY.replace('That mix', 'I cut cycle time by 43 percent. That mix')), /43/));
ok('…but the posting\'s own words are fine', !has(GOOD, /Equipment Engineering/));

console.log('🧪 outreach: length is the channel\'s, not a preference');
const NOTE = 'Hi Dana, I applied for the Manufacturing Engineer I role. Do you think my Applied Materials background could be a fit for the team?';
check('a note that fits passes', checkOutreach(NOTE, { ...opts, channel: 'note' }).problems, []);
ok('a note over the character cap fails', checkOutreach(GOOD + GOOD, { ...opts, channel: 'note' }).problems.some((p) => /capped at/.test(p)));
ok('an email under the reply band fails', has(mk(`Hi Dana, I applied.\n${POSTING_URL}\nDo you think I could fit?`), /too short/));
ok('a bullet list fails', has(mk(`${BODY}\n- one\n- two`)));
ok('an em dash fails', has(GOOD.replace(', which is close', ' — which is close'), /em dash/));

console.log('🧪 outreach: the draft never leaves, even when writing is off');
const off = process.env.JARVIS_TAILOR;
process.env.JARVIS_TAILOR = 'off';
const noWrite = await writeOutreach(JOB, { channel: 'email' });
check('writing off returns a refusal, not a message', [noWrite.ok, noWrite.text], [false, '']);
process.env.JARVIS_TAILOR = off === undefined ? '' : off;
if (off === undefined) delete process.env.JARVIS_TAILOR;

// A draft that fails its checks comes back WITH its problems, never silently.
const bad = await writeOutreach(JOB, {
  channel: 'email', jd: JD,
  sources: { cvText: CV, narrative: {}, voiceRules: '' },
  ask: async () => 'Hi Dana, can you refer me? I am on OPT and we met at SEMICON.',
  retries: 0,
});
check('a failing draft is returned, not hidden', bad.ok, false);
ok('…and it names every rule it broke', bad.problems.length >= 3, JSON.stringify(bad.problems));

// ── 4. the ledger that says no ──────────────────────────────────────
console.log('🧪 outreach: the ledger exists to refuse');

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-contacts-'));
const dbPath = path.join(dir, 'test.db');
const D = { dbPath };

check('one person at one company is one id', contactId('Applied Materials', 'Dana Lee'), 'appliedmaterials:danalee');
check('spelling does not fork the row', contactId('Applied Materials, Inc.', 'dana  lee'), 'appliedmaterialsinc:danalee');

// Business days, because "5-7 days" means working days.
check('a Friday plus 6 business days is the following Monday',
  addBusinessDays(new Date('2026-09-11T12:00:00Z'), 6).toISOString().slice(0, 10), '2026-09-21');

check('nobody known, nothing sent: go ahead', canContact(null, [], { jobId: 'j1' }).ok, true);

const c1 = saveContact({ job_id: 'j1', company: 'Applied Materials', name: 'Dana Lee', persona: 'team', channel: 'email', draft: GOOD }, D);
check('a draft is recorded as drafted', c1.status, 'drafted');
check('…and is found for its job', forJob('j1', D).length, 1);

// NO CAP PER ROLE since 2026-10-26 ("remove all the damn caps"): a third,
// fourth… person for the same role is allowed. A cap passed in still works.
check('a second person for the same role is allowed', canContact(null, forJob('j1', D), { jobId: 'j1' }).ok, true);
saveContact({ job_id: 'j1', company: 'Applied Materials', name: 'Sam Roe', persona: 'team', channel: 'email', draft: GOOD }, D);
check('a third person for the same role is allowed too', canContact(null, forJob('j1', D), { jobId: 'j1' }).ok, true);
const capped = canContact(null, forJob('j1', D), { jobId: 'j1', perCompanyPerRole: 2 });
check('a cap passed in still refuses', capped.ok, false);
ok('…and the refusal names who is already in flight', /Dana Lee/.test(capped.why), capped.why);

// A DIFFERENT role at the same company is fine — it is a different conversation.
check('a different role at the same company is allowed', canContact(null, forJob('j1', D), { jobId: 'j2' }).ok, true);

markSent('appliedmaterials:danalee', { ...D, at: '2026-09-11T12:00:00Z' });
const sent = getContact('appliedmaterials:danalee', D);
check('he says he sent it, and the ledger believes him', [sent.status, sent.sent_at.slice(0, 10)], ['sent', '2026-09-11']);

const tooSoon = canContact(sent, [], { now: new Date('2026-09-14T12:00:00Z') });
check('a follow-up before the window is refused', tooSoon.ok, false);
ok('…and says the date it becomes due', /2026-09-21/.test(tooSoon.why), tooSoon.why);

const due = canContact(sent, [], { now: new Date('2026-09-22T12:00:00Z') });
check('after the window, one follow-up is allowed', [due.ok, due.followUp], [true, true]);
ok('…and it must add something new', /something new/.test(due.why));

check('nothing is due before the window', dueFollowUps({ ...D, now: new Date('2026-09-14T12:00:00Z') }).length, 0);
check('it is due after', dueFollowUps({ ...D, now: new Date('2026-09-22T12:00:00Z') }).length, 1);

markSent('appliedmaterials:danalee', { ...D, at: '2026-09-22T12:00:00Z' });
const followed = getContact('appliedmaterials:danalee', D);
check('the second send is the follow-up, not another first', followed.status, 'followed_up');
check('A SECOND FOLLOW-UP IS REFUSED', canContact(followed, [], { now: new Date('2026-10-30T12:00:00Z') }).ok, false);
check('…and nothing is left due', dueFollowUps({ ...D, now: new Date('2026-10-30T12:00:00Z') }).length, 0);

// A REPLY ENDS OUTREACH AND BEGINS A CONVERSATION.
markReplied('appliedmaterials:danalee', { ...D, at: '2026-09-23T12:00:00Z' });
const replied = getContact('appliedmaterials:danalee', D);
check('a reply is recorded', replied.status, 'replied');
check('…and stops any further outreach', canContact(replied, []).ok, false);

// DO NOT CONTACT IS PERMANENT.
saveContact({ job_id: 'j3', company: 'Zeta', name: 'Sam Rivers' }, D);
markDoNotContact('zeta:samrivers', { ...D, why: 'asked not to be contacted' });
const dnc = getContact('zeta:samrivers', D);
check('do-not-contact is set', dnc.do_not_contact, 1);
check('…and it refuses before every other rule', canContact(dnc, []).ok, false);
saveContact({ id: 'zeta:samrivers', status: 'drafted', do_not_contact: 0 }, D);
check('…AND A LATER WRITE CANNOT CLEAR IT', getContact('zeta:samrivers', D).do_not_contact, 1);
check('…nor can a switch take them off the ledger', removeUnsent('zeta:samrivers', D), null);

// THE SUBJECT TRAVELS WITH THE DRAFT (2026-10-23): a message waits here, not in a tab.
saveContact({ job_id: 'j4', company: 'Queue', name: 'Ada Park', draft: GOOD, subject: 'Mechanical Engineer application' }, D);
check('a saved subject is kept', getContact('queue:adapark', D).subject, 'Mechanical Engineer application');
saveContact({ id: 'queue:adapark', note: 'later edit' }, D);
check('…and survives a later write that does not name it', getContact('queue:adapark', D).subject, 'Mechanical Engineer application');
removeUnsent('queue:adapark', D);

const stats = outreachStats(D);
check('the reply rate is a fraction, not a percentage', stats.rate, '1/1');
check('…counted per persona for the learning loop', stats.byPersona.team, { sent: 1, replied: 1 });

// A BETTER LEAD TAKES THE SLOT only from someone he has not written to (2026-09-27).
saveContact({ job_id: 'j4', company: 'Eta', name: 'Old Pick' }, D);
check('an unsent person can be switched out', removeUnsent('eta:oldpick', D)?.name, 'Old Pick');
check('…and is gone from the role', forJob('j4', D).length, 0);
saveContact({ job_id: 'j4', company: 'Eta', name: 'Wrote To' }, D);
markSent('eta:wroteto', D);
check('someone he has written to stays', removeUnsent('eta:wroteto', D), null);

// Windows holds the SQLite file until the process exits, so the directory may
// refuse to go. It is a temp directory; it can wait (store-db.test.mjs does the
// same).
try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }

// THE WRITER'S BOOKKEEPING IS NOT HIS MESSAGE (2026-09-26): the retry answered
// with its own counts and rule check before the note, and that was saved.
check('a word/character count and a rule check before the note are dropped',
  stripSelfTalk('40 words, 274 characters — within both bounds. Checked against the rules: no referral ask, no visa mention, one plain ask. Mechanical engineering student at Lakeside. How does the team split subassembly ownership?'),
  'Mechanical engineering student at Lakeside. How does the team split subassembly ownership?');
check('a count on its own trailing line is dropped', stripSelfTalk('Hi Sam, I built a cobot cell. How is the role split?\n(212 characters)'), 'Hi Sam, I built a cobot cell. How is the role split?');
check('a clean note is left exactly as written', stripSelfTalk('Hi Morgan, I\'m Alex. I built a UR cobot cell. How is the role split?'), 'Hi Morgan, I\'m Alex. I built a UR cobot cell. How is the role split?');

// WHO IS OWED A MESSAGE (F-951): accepted, unsent, still contactable.
{
  const base = { job_id: 'owed-1', company: 'Owed Robotics', channel: 'linkedin', draft: 'Hi' };
  const names = ['Ana Owed', 'Ben Sent', 'Cy Pending', 'Di Blocked'];
  for (const name of names) saveContact({ ...base, name, linkedin_url: `https://www.linkedin.com/in/${name.split(' ')[0].toLowerCase()}` }, D);
  const id = (n) => contactId('Owed Robotics', n);
  for (const n of names) markInvited(id(n), { ...D, at: '2026-11-01T10:00:00Z' });
  for (const n of ['Ana Owed', 'Ben Sent', 'Di Blocked']) markConnected(id(n), { ...D, at: '2026-11-01T12:00:00Z' });
  markSent(id('Ben Sent'), { ...D, at: '2026-11-01T13:00:00Z' });
  markDoNotContact(id('Di Blocked'), D);
  check('accepted and unsent: owed; sent, pending or blocked: not', acceptedUnsent(D).map((c) => c.name), ['Ana Owed']);
  check('…with the accept time', acceptedUnsent(D)[0]?.at, '2026-11-01T12:00:00Z');
}

// RETIRED IS HIS CALL AND REVERSIBLE (F-977): off the open list with a reason,
// not do-not-contact, the note and draft untouched, and --unretire puts it back.
{
  const base = { job_id: 'ret-1', company: 'Retire Co', channel: 'linkedin', draft: 'Hi Ret', note: 'met at SHPE', connect_note: 'Hi, I applied', linkedin_url: 'https://www.linkedin.com/in/rita' };
  saveContact({ ...base, name: 'Rita Stale' }, D);
  const rid = contactId('Retire Co', 'Rita Stale');
  check('a drafted, unsent lead is open', isOpen(getContact(rid, D)), true);
  check('…and waits in the connect queue', outreachConnectQueue([], D).people.some((p) => p.id === rid), true);
  const r = retireContact(rid, { ...D, why: 'stale: exec, 09-15', at: '2026-11-03T12:00:00Z' });
  check('retired with its reason and the status it had', [r.status, r.retired_reason, r.retired_from, r.retired_at], ['retired', 'stale: exec, 09-15', 'drafted', '2026-11-03T12:00:00Z']);
  const row = getContact(rid, D);
  check('…off the open list', isOpen(row), false);
  check('…NOT do-not-contact, and the note and draft are kept', [row.do_not_contact, row.note, row.draft], [0, 'met at SHPE', 'Hi Ret']);
  check('…out of the connect queue', outreachConnectQueue([], D).people.some((p) => p.id === rid), false);
  check('…and refused with its reason, naming the undo', [canContact(row, []).ok, /stale: exec, 09-15.*--unretire/.test(canContact(row, []).why)], [false, true]);
  check('retiring twice keeps the first reason', retireContact(rid, { ...D, why: 'other' }).retired_reason, 'stale: exec, 09-15');
  saveContact({ id: rid, title: 'VP' }, D);
  check('a later write that does not name the status leaves it retired', getContact(rid, D).status, 'retired');
  const back = unretireContact(rid, D);
  check('unretire restores the status and clears the reason', [back.status, back.retired_reason, back.retired_at, back.retired_from], ['drafted', '', null, '']);
  check('…and it is open again', isOpen(getContact(rid, D)), true);
  check('unretiring an open lead is a no-op', unretireContact(rid, D), null);
  // A sent lead goes back to sent, not drafted.
  saveContact({ ...base, name: 'Sam Sent' }, D);
  const sid = contactId('Retire Co', 'Sam Sent');
  markSent(sid, { ...D, at: '2026-10-01T12:00:00Z' });
  retireContact(sid, { ...D, why: 'weak: wrong field' });
  check('a sent lead is retired and kept out of follow-ups', dueFollowUps({ ...D, now: new Date('2026-11-03T12:00:00Z') }).some((c) => c.id === sid), false);
  check('…and comes back as sent', unretireContact(sid, D).status, 'sent');
  // A do-not-contact person is already closed for good; retire leaves it alone.
  saveContact({ ...base, name: 'Dee Nope' }, D);
  const did = contactId('Retire Co', 'Dee Nope');
  markDoNotContact(did, { ...D, why: 'asked not to be contacted' });
  check('do-not-contact is not retired over', retireContact(did, { ...D, why: 'x' }), null);
  check('…and is still do-not-contact', getContact(did, D).status, 'closed');
  check('an unknown id is not retired', retireContact('nobody:here', { ...D, why: 'x' }), null);
  // Accepted-and-unsent skips a retired lead.
  saveContact({ ...base, name: 'Ann Accept' }, D);
  const aid = contactId('Retire Co', 'Ann Accept');
  markInvited(aid, { ...D, at: '2026-11-01T10:00:00Z' }); markConnected(aid, { ...D, at: '2026-11-01T12:00:00Z' });
  check('accepted and unsent is owed a message', acceptedUnsent(D).some((c) => c.id === aid), true);
  retireContact(aid, { ...D, why: 'stale' });
  check('…until it is retired', acceptedUnsent(D).some((c) => c.id === aid), false);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
