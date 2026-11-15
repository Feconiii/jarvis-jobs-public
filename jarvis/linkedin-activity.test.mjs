/**
 * LinkedIn activity: his emails and his data export, tied to the people on his
 * Outreach tab. The email shapes are copied from his own inbox (2026-09-25);
 * the store is a temp one, never his.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import zlib from 'zlib';

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-li-'));
process.env.JARVIS_DATA_DIR = dir;
const A = await import('./linkedin-activity.mjs');
const L = await import('./leads.mjs');
const C = await import('./contacts.mjs');
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } });

const PAD = ' ͏ ͏ ͏';

test('personKey: credentials, accents, middle names and case do not decide a match', () => {
  assert.equal(A.personKey('Lauren Traster, PMP®'), 'lauren traster');
  assert.equal(A.personKey('José  María García'), 'jose garcia');
  assert.equal(A.personKey('Malik Al Hasani, MBA'), 'malik hasani');
  assert.equal(A.profileSlug('https://www.linkedin.com/in/luis-romero-12ab/?trk=x'), 'luis-romero-12ab');
});

test('an accepted invitation gives the full name from the preview', () => {
  const e = A.parseLinkedInEmail({ fromEmail: 'invitations@linkedin.com', subject: 'Luis accepted your invitation, explore their network',
    snippet: `See Luis Romero&#39;s connections, experience, and more${PAD}`, body: '---------------- This email was intended for Alex Rivera', date: '2026-09-15T17:00:00Z' });
  assert.deepEqual(e, { kind: 'invite_accepted', name: 'Luis Romero', at: '2026-09-15T17:00:00Z', text: '' });
});

test('an InMail reply gives the person and what they said', () => {
  const e = A.parseLinkedInEmail({ fromEmail: 'hit-reply@linkedin.com', subject: 'Message replied: Exciting opportunity for service technicians',
    body: 'Message replied: Exciting opportunity for service technicians InMail: You have a new message Ben Carter Reply https://www.linkedin.com/messaging/thread/2-NDU4==/ Thanks Alex, when do you expect to graduate? ---------------------------------------- This email was intended for Alex Rivera',
    date: '2026-08-23T10:00:00Z' });
  assert.equal(e.kind, 'message_received');
  assert.equal(e.name, 'Ben Carter');
  assert.equal(e.text, 'Thanks Alex, when do you expect to graduate?');
});

test('the digests that name nobody, and everything else LinkedIn sends, are not events', () => {
  assert.equal(A.parseLinkedInEmail({ fromEmail: 'notifications-noreply@linkedin.com', subject: 'You have 1 new message', body: 'You have 1 new message View messages' }), null);
  assert.equal(A.parseLinkedInEmail({ fromEmail: 'invitations@linkedin.com', subject: 'I want to connect', snippet: 'Wenyi, AI algorithm intern from Applied Materials is waiting for your response' }), null);
  assert.equal(A.parseLinkedInEmail({ fromEmail: 'messages-noreply@linkedin.com', subject: '38 profile views' }), null);
});

const MESSAGES_CSV = `CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER
c1,,Alex Rivera,https://www.linkedin.com/in/youa,Luis Romero,https://www.linkedin.com/in/luis-romero-12ab,2026-09-16 18:22:11 UTC,,"Hi Luis, I applied to the Associate Mechanical Engineer role on the actuation team,
and wanted to ask one question.",INBOX
c1,,Luis Romero,https://www.linkedin.com/in/luis-romero-12ab,Alex Rivera,https://www.linkedin.com/in/youa,2026-09-18 02:05:00 UTC,,"Happy to chat, send me a time.",INBOX
c2,,Alex Rivera,https://www.linkedin.com/in/youa,Pat Friend,https://www.linkedin.com/in/patfriend,2026-09-20 12:00:00 UTC,,"Congrats on the new job!",INBOX
c3,,Old Classmate,https://www.linkedin.com/in/old,Alex Rivera,https://www.linkedin.com/in/youa,2026-09-21 12:00:00 UTC,,"hey want to grab lunch",INBOX
c4,,Alex Rivera,https://www.linkedin.com/in/youa,Morgan Hayes,https://www.linkedin.com/in/morgans,2026-09-19 15:00:00 UTC,,"Hi Morgan, I applied to Automation Engineer I.",INBOX
c5,,Alex Rivera,https://www.linkedin.com/in/youa,Ancient Contact,https://www.linkedin.com/in/ancient,2024-01-02 12:00:00 UTC,,"hello",INBOX
`;
const INVITES_CSV = `From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl
Alex Rivera,Jamie Cole,"9/15/26, 6:22 PM","Hi Jamie, I applied to Rhoda's associate ME role.",OUTGOING,https://www.linkedin.com/in/youa,https://www.linkedin.com/in/jamie-cole
Someone Else,Alex Rivera,"9/14/26, 9:00 AM",,INCOMING,https://www.linkedin.com/in/else,https://www.linkedin.com/in/youa
`;

test('parseExport: his messages are sent, theirs received, his outgoing invitations kept with the note', () => {
  const ev = A.parseExport({ messages: MESSAGES_CSV, invitations: INVITES_CSV });
  const find = (kind, name) => ev.find((e) => e.kind === kind && e.name === name);
  assert.ok(find('message_sent', 'Luis Romero'), 'his message to Luis');
  assert.match(find('message_sent', 'Luis Romero').text, /actuation team, and wanted/, 'a message spanning lines stays one message');
  assert.equal(find('message_received', 'Luis Romero').at, '2026-09-18T02:05:00.000Z');
  assert.ok(find('invite_sent', 'Jamie Cole'));
  assert.match(find('invite_sent', 'Jamie Cole').text, /associate ME role/);
  assert.equal(ev.filter((e) => e.kind === 'invite_sent').length, 1, 'an incoming invitation is not his outreach');
  assert.equal(ev.some((e) => e.name === 'Alex Rivera'), false, 'he is never his own contact');
});

test('the zip LinkedIn sends is read without a dependency', () => {
  const zipPath = path.join(dir, 'Basic_LinkedInDataExport_09-25-2026.zip');
  writeFileSync(zipPath, makeZip({ 'messages.csv': MESSAGES_CSV, 'Invitations.csv': INVITES_CSV, 'Connections.csv': 'x' }));
  const f = A.readExport(zipPath);
  assert.equal(f.messages, MESSAGES_CSV);
  assert.equal(f.invitations, INVITES_CSV);
});

test('THE EXPORT TIES TO HIS OUTREACH JOBS AND MOVES THE LEDGER FORWARD', async () => {
  // Rhoda: the Outreach button found Luis Romero and Jamie Cole.
  L.startLeadRun({ id: 'rhoda', company: 'Rhoda AI', title: 'Associate Mechanical Engineer' },
    { ask: async () => JSON.stringify({ people: [{ name: 'Luis Romero', profile_url: 'https://www.linkedin.com/in/luis-romero-12ab' }, { name: 'Jamie Cole' }] }) });
  await L.idle();
  // Jabil: he saved Morgan Hayes to the ledger and never pressed "I sent it".
  C.saveContact({ job_id: 'jabil', company: 'Jabil', name: 'Morgan Hayes', persona: 'recruiter' });

  const zipPath = path.join(dir, 'Basic_LinkedInDataExport_09-25-2026.zip');
  const r = A.importExport(zipPath, { now: new Date('2026-09-25T12:00:00Z') });
  assert.equal(r.sent, 1, 'Morgan marked sent from the export');
  const morgan = C.getContact(C.contactId('Jabil', 'Morgan Hayes'));
  assert.equal(morgan.status, 'sent');
  assert.equal(morgan.sent_at, '2026-09-19T15:00:00.000Z', 'on the day he actually sent it');

  const rhoda = A.eventsForJob('rhoda').map((e) => `${e.kind}:${e.name}`).sort();
  assert.deepEqual(rhoda, ['invite_sent:Jamie Cole', 'message_received:Luis Romero', 'message_sent:Luis Romero']);
  const s = A.linkedInSummary().rhoda;
  assert.equal(s.replied, '2026-09-18T02:05:00.000Z');

  const untied = A.untiedOutreach().map((u) => u.name);
  assert.deepEqual(untied, ['Pat Friend'], 'his own untied outreach is listed; a stranger writing to him, and 2024, are not');

  // Importing the same export again changes nothing.
  const again = A.importExport(zipPath, { now: new Date('2026-09-25T13:00:00Z') });
  assert.equal(again.added, 0);
});

test('Gmail: an accepted invitation from a lead ties to the job; a reply the export already had is not doubled', () => {
  const r = A.applyLinkedInEmails([
    { id: 'g-acc', fromEmail: 'invitations@linkedin.com', subject: 'Jamie accepted your invitation, explore their network', snippet: 'See Jamie Cole&#39;s connections, experience, and more', body: '', date: '2026-09-16T20:00:00Z' },
    { id: 'g-dup', fromEmail: 'hit-reply@linkedin.com', subject: 'Message replied: hi', body: 'You have a new message Luis Romero Reply https://www.linkedin.com/messaging/thread/x/ Happy to chat, send me a time. -----------', date: '2026-09-18T02:07:00Z' },
  ], { now: new Date('2026-09-25T14:00:00Z') });
  assert.equal(r.tied, 1);
  assert.ok(A.eventsForJob('rhoda').some((e) => e.kind === 'invite_accepted' && e.name === 'Jamie Cole'));
  assert.equal(A.eventsForJob('rhoda').filter((e) => e.kind === 'message_received').length, 1);
  assert.equal(A.isLinkedInMailSeen('g-acc'), true, 'read once, never fetched again');
});

test('he ties an untied person to a job, and their events come with them', () => {
  assert.equal(A.tiePerson('Pat Friend', 'jabil'), 1);
  assert.deepEqual(A.untiedOutreach(), []);
  assert.equal(A.eventsForJob('jabil').some((e) => e.name === 'Pat Friend'), true);
});

// A stored-entry zip is enough to test the reader's layout; one deflated entry
// covers the inflate path.
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text); const deflate = i % 2 === 0;
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('CONNECT FIRST: an accept marks a person connected only after his invitation with a note went out', () => {
  const id = C.contactId('OpenAI', 'Mia Chen');
  C.saveContact({ id, job_id: 'oa-1', company: 'OpenAI', name: 'Mia Chen', linkedin_url: 'https://www.linkedin.com/in/mia-chen', draft: 'Hi Mia,\n\nI recently applied for the role.', connect_note: 'Hi Mia, I saw your post. I applied, so I would love to connect.' });
  const accept = (gid, at) => ({ id: gid, fromEmail: 'invitations@linkedin.com', subject: 'Mia accepted your invitation, explore their network', snippet: 'See Mia Chen&#39;s connections, experience, and more', body: '', date: at });
  const before = A.applyLinkedInEmails([accept('g-mia-0', '2026-10-20T17:00:00Z')], { now: new Date('2026-10-26T14:00:00Z') });
  assert.deepEqual(before.connected, [], 'never invited by the connect pass: nothing scheduled');
  assert.equal(C.getContact(id).connected_at, null);
  assert.equal(C.outreachConnectQueue([], { contacts: [C.getContact(id)] }).people.length, 1, 'waiting for its invitation');
  C.markInvited(id, { at: '2026-10-26T18:00:00Z' });
  assert.equal(C.outreachConnectQueue([], { contacts: [C.getContact(id)] }).people.length, 0, 'invited once, never twice');
  const after = A.applyLinkedInEmails([accept('g-mia-1', '2026-10-27T17:00:00Z')], { now: new Date('2026-10-27T18:00:00Z') });
  assert.deepEqual(after.connected, [{ id, name: 'Mia Chen', at: '2026-10-27T17:00:00Z' }], 'with the accept time, so the message waits 30-40 min from it');
  assert.equal(C.getContact(id).connected_at, '2026-10-27T17:00:00Z');
});

test('the saved message after an accept opens "Thanks for connecting!" after the greeting, once', () => {
  assert.equal(C.thanksForConnecting('Hi Chris,\n\nI saw your post about the roles.'), 'Hi Chris,\n\nThanks for connecting! I saw your post about the roles.');
  assert.equal(C.thanksForConnecting('Hi Chris,\n\nThanks for connecting! I saw it.'), 'Hi Chris,\n\nThanks for connecting! I saw it.');
  assert.equal(C.thanksForConnecting('I saw your post.'), 'Thanks for connecting!\n\nI saw your post.');
});
