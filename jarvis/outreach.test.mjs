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
  checkOutreach, writeOutreach, CHANNELS, PERSONAS,
} from './outreach.mjs';
import {
  contactId, addBusinessDays, canContact, saveContact, getContact, markSent,
  markReplied, markDoNotContact, dueFollowUps, outreachStats, forJob,
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
ok('the alumni search names his school', url.includes(encodeURIComponent('State University')));
ok('…and it is an ordinary search URL', url.startsWith('https://www.linkedin.com/search/results/people/?keywords='));

// ── 2. email, at the scale of one ───────────────────────────────────
console.log('🧪 outreach: one address, or none, and it says which');

// Measured across his whole deck: 84 distinct addresses, 83 of them role
// accounts. The pattern is only inferable when a PERSON-shaped one appears.
check('role accounts teach nothing about the pattern',
  emailPattern(['accommodations_program@amat.com', 'talent.acquisition@kla.com', 'hrsupport_na@micron.com', 'jobs.accommodations@sandisk.com']),
  null);
check('a person-shaped address does',
  emailPattern(['careers@sunrun.com', 'danielle.levitan@sunrun.com']),
  { pattern: 'first.last', domain: 'sunrun.com', from: 'danielle.levitan@sunrun.com' });
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

const CV = 'Alex Rivera. State University, BS Mechanical Engineering May 2027. Applied Materials internship. CNC, SolidWorks, GD&T. Universal Robots UR10e cobot.';
const JD = 'Manufacturing Engineer I at Applied Materials, Austin TX. Equipment Engineering team. Process tooling and fixture design.';
const opts = { channel: 'email', cvText: CV, jd: JD, job: JOB, contact: { name: 'Dana Lee', title: 'Equipment Engineer' } };
const problems = (t, o = opts) => checkOutreach(t, o).problems;
const has = (t, re = /./, o = opts) => problems(t, o).some((p) => re.test(p));

const GOOD = `Hi Dana, I am a mechanical engineering student at State University finishing in May 2027, and I spent last summer at Applied Materials working on process tooling. I saw the Manufacturing Engineer I opening on the Equipment Engineering team in Austin and wanted to ask someone who actually does the work rather than guess from the posting. How is the team split between sustaining work and new tool bring-up, and what do you look for in someone starting out? Happy to be pointed at anything public instead if that is easier. No worries if you are heads-down. Thanks, Alex`;
check('a good message passes clean', problems(GOOD), []);

// THE BACKDOOR APPLICATION.
ok('asking for a referral fails', has('Hi Dana, could you refer me for the Manufacturing Engineer role? ' + GOOD, /referral|backdoor/i));
ok('"pass my resume along" is the same ask in other words', has(GOOD + ' Could you pass my resume along to the hiring manager?', /referral|backdoor/i));
ok('…but asking how the team works does not', !has(GOOD, /referral|backdoor/i));

// THE VISA.
ok('naming sponsorship fails', has(GOOD + ' I will need visa sponsorship after graduation.', /visa|sponsorship/i));
ok('naming OPT fails', has(GOOD + ' I am on OPT.', /visa|sponsorship/i));
ok('…and a clean message says nothing about it', !has(GOOD, /visa|sponsorship/i));

// INVENTED RAPPORT — the one that cannot be walked back.
ok('claiming to have read their article fails', has('Hi Dana, I really loved your post on tool automation. ' + GOOD, /shared history|verify/i));
ok('claiming to have met them fails', has('Hi Dana, we met at SEMICON last year. ' + GOOD, /shared history|verify/i));

console.log('🧪 outreach: only what is in cv.md or the posting');
ok('a company he never worked at is caught', has(GOOD.replace('Applied Materials', 'Intel'), /intel/i));
ok('an invented figure is caught', has(GOOD + ' I cut cycle time by 43 percent.', /43/));
ok('…but the posting\'s own words are fine', !has(GOOD, /Equipment Engineering/));

console.log('🧪 outreach: length is the channel\'s, not a preference');
const NOTE = 'Hi Dana, mechanical engineering student at State University, graduating May 2027, interned at Applied Materials on process tooling. Saw the Manufacturing Engineer opening on your team and would love to ask how the group is set up. No worries either way.';
check('a note that fits passes', checkOutreach(NOTE, { ...opts, channel: 'note' }).problems, []);
ok('a note over the character cap fails', checkOutreach(GOOD + GOOD, { ...opts, channel: 'note' }).problems.some((p) => /capped at/.test(p)));
ok('an email under the reply band fails', has('Hi Dana, saw the role, would love to chat. Thanks, Alex'));
ok('a bullet list fails', has(GOOD + '\n- one\n- two'));
ok('an em dash fails', has(GOOD.replace('and wanted', '— wanted'), /em dash/));

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

// ONE PERSON PER COMPANY PER ROLE.
const second = canContact(null, forJob('j1', D), { jobId: 'j1' });
check('a second person for the same role is refused', second.ok, false);
ok('…and the refusal names who is already in flight', /Dana Lee/.test(second.why), second.why);

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

const stats = outreachStats(D);
check('the reply rate is a fraction, not a percentage', stats.rate, '1/1');
check('…counted per persona for the learning loop', stats.byPersona.team, { sent: 1, replied: 1 });

// Windows holds the SQLite file until the process exits, so the directory may
// refuse to go. It is a temp directory; it can wait (store-db.test.mjs does the
// same).
try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
