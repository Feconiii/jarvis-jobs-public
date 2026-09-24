#!/usr/bin/env node
/**
 * OUTREACH, from the terminal — the work list and one packet at a time.
 *
 * He works in the browser, so the dashboard is the real surface; this exists
 * because the follow-up list is the one thing that has to be checked on a day
 * he is not browsing, and because a packet printed here can be pasted straight
 * into LinkedIn.
 *
 * Usage:
 *   node jarvis/outreach-cli.mjs                       # the work list
 *   node jarvis/outreach-cli.mjs --job <id>            # the target spec for one job
 *   node jarvis/outreach-cli.mjs --job <id> --name "Dana Lee" [--title "..."]
 *                                                      # …and draft the message
 *   node jarvis/outreach-cli.mjs --job <id> --name "..." --channel note
 *   node jarvis/outreach-cli.mjs --sent <contactId> | --replied <contactId>
 *   node jarvis/outreach-cli.mjs --stop <contactId>    # do not contact, permanently
 *
 * NOTHING HERE SENDS ANYTHING. It prints a message for him to send.
 */
import { getJob, query, getDescription } from './store.mjs';
import { targetSpec, writeOutreach, emailPattern, domainFrom, candidateEmail, CHANNELS } from './outreach.mjs';
import {
  canContact, saveContact, getContact, forJob, allContacts, contactId,
  markSent, markReplied, markDoNotContact, dueFollowUps, outreachStats,
} from './contacts.mjs';
import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/outreach-cli.mjs [options]

  Draft outreach for a job you have queued or applied to. Never sends.

    --job <id>            the posting to reach out about
    --name <full name>    the person you found (you find them; this writes)
    --title <title>       their title, if you have it
    --persona <key>       alumni | team | manager | recruiter
    --channel <key>       email | note | alumni
    --request <text>      anything you want the draft to include
    --sent <contactId>    you sent it (or, the second time, followed up)
    --replied <contactId> they replied — outreach stops there
    --stop <contactId>    they asked not to be contacted. Permanent.
    --help, -h
`;
guardArgs({
  usage: USAGE,
  flags: ['--job', '--name', '--title', '--persona', '--channel', '--request', '--sent', '--replied', '--stop'],
  valued: ['--job', '--name', '--title', '--persona', '--channel', '--request', '--sent', '--replied', '--stop'],
});

const ARGV = process.argv.slice(2);
const arg = (n) => { const i = ARGV.indexOf(`--${n}`); return i === -1 ? '' : (ARGV[i + 1] || ''); };

const hr = (s) => `\n${s}\n${'─'.repeat(Math.min(72, s.length + 2))}`;

/** The address format a company uses, from its own postings. */
function emailHints(company) {
  const samples = [];
  const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  for (const j of query({ company: [company], hasDesc: true }, { limit: 20 }).rows || []) {
    for (const e of (getDescription(j.id) || '').match(EMAIL) || []) {
      if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(e) && !samples.includes(e)) samples.push(e);
    }
    if (samples.length >= 8) break;
  }
  const pat = emailPattern(samples);
  return { domain: pat?.domain || domainFrom(samples), pattern: pat?.pattern || '' };
}

// ── marks ───────────────────────────────────────────────────────────
for (const [flag, fn, said] of [['sent', markSent, 'sent'], ['replied', markReplied, 'replied'], ['stop', (id) => markDoNotContact(id, { why: 'asked not to be contacted' }), 'closed permanently']]) {
  const id = arg(flag);
  if (!id) continue;
  const done = fn(id);
  if (!done) { console.error(`No contact ${id}. Run with no arguments to see the list.`); process.exit(1); }
  console.log(`${done.name} at ${done.company}: ${said}${done.status === 'followed_up' ? ' (that was the follow-up — this one is finished now)' : ''}`);
  process.exit(0);
}

// ── the work list ───────────────────────────────────────────────────
const jobIdArg = arg('job');
if (!jobIdArg) {
  const due = dueFollowUps();
  const stats = outreachStats();
  console.log(hr('Outreach'));
  console.log(`  drafted ${stats.drafted} · sent ${stats.sent} · replied ${stats.rate}`);

  if (due.length) {
    console.log(hr(`${due.length} follow-up${due.length === 1 ? '' : 's'} due — one each, and it has to add something new`));
    for (const c of due) console.log(`  ${c.name.padEnd(22)} ${c.company.padEnd(24)} sent ${c.sent_at.slice(0, 10)}   ${c.id}`);
  }

  const withContact = new Set(allContacts({ limit: 5000 }).map((c) => c.job_id));
  const open = (query({ status: ['inbox', 'interested', 'queued', 'applied'] }, { limit: 200 }).rows || [])
    .filter((j) => !withContact.has(j.id));
  console.log(hr(`${open.length} job${open.length === 1 ? '' : 's'} you have committed to with nobody on them yet`));
  for (const j of open.slice(0, 25)) {
    console.log(`  ${String(j.fit?.score ?? '').padStart(3)}  ${String(j.title).slice(0, 44).padEnd(46)} ${String(j.company).slice(0, 22).padEnd(24)} ${j.id}`);
  }
  if (open.length > 25) console.log(`  …and ${open.length - 25} more`);
  console.log(`\n  Next:  node jarvis/outreach-cli.mjs --job <id>\n`);
  process.exit(0);
}

// ── one job ─────────────────────────────────────────────────────────
const job = getJob(jobIdArg);
if (!job) { console.error(`No job ${jobIdArg}.`); process.exit(1); }
const hints = emailHints(job.company);
const spec = targetSpec(job, { description: getDescription(job.id) || '', domain: hints.domain });
const existing = forJob(job.id);

console.log(hr(`${job.title} — ${job.company}${job.location ? ` (${job.location})` : ''}`));
if (spec.team) console.log(`  team          : ${spec.team}`);
if (spec.managerTitle) console.log(`  reports to    : ${spec.managerTitle}`);
console.log(`  email domain  : ${hints.domain || 'unknown — nothing in their postings names one'}${hints.pattern ? ` (${hints.pattern}, confirmed)` : ''}`);

console.log(hr('Who to look for, best first'));
for (const s of spec.searches) {
  const p = spec.personas.find((x) => x.key === s.persona);
  console.log(`  ${s.label}\n      ${p?.why || ''}\n      ${s.url}`);
}

if (existing.length) {
  console.log(hr('Already on this role'));
  for (const c of existing) {
    console.log(`  ${c.name} (${c.status})${c.sent_at ? ` sent ${c.sent_at.slice(0, 10)}` : ''}  ${c.id}`);
  }
}

const name = arg('name');
if (!name) {
  const gate = canContact(null, existing, { jobId: job.id });
  console.log(`\n  ${gate.ok ? 'Find one person, then:' : `Blocked: ${gate.why}`}`);
  if (gate.ok) console.log(`  node jarvis/outreach-cli.mjs --job ${job.id} --name "Their Name" --title "Their Title"\n`);
  process.exit(0);
}

const cid = contactId(job.company, name);
const gate = canContact(getContact(cid), existing, { jobId: job.id });
if (!gate.ok) {
  console.error(`\n  Not writing to ${name}: ${gate.why}\n`);
  process.exit(1);
}

const channel = CHANNELS[arg('channel')] ? arg('channel') : 'email';
const persona = arg('persona') || (spec.personas[0]?.key ?? 'team');
const contact = { name, title: arg('title') };
const mail = candidateEmail(name, hints);

console.log(hr(`Drafting a ${CHANNELS[channel].label.toLowerCase()} to ${name}${contact.title ? `, ${contact.title}` : ''}`));
if (mail) console.log(`  ${mail.address}   — ${mail.note}`);

const draft = await writeOutreach(job, {
  jd: getDescription(job.id) || '', channel, persona, contact, spec, request: arg('request'),
});

if (!draft.text) {
  console.error(`\n  Nothing written: ${draft.why || 'the writer returned nothing'}\n`);
  process.exit(1);
}
console.log(hr(draft.ok ? 'The draft — read it, then send it yourself' : 'The draft — IT FAILED ITS CHECKS, read them first'));
console.log(`\n${draft.text}\n`);
for (const p of draft.problems) console.log(`  ✗ ${p}`);
for (const n of draft.notices) console.log(`  · ${n}`);

saveContact({
  job_id: job.id, company: job.company, name, title: contact.title,
  persona, channel, email: mail?.address || '', email_conf: mail?.confidence || '',
  draft: draft.text,
});
console.log(`\n  Recorded as ${cid}. Nothing has been sent.`);
console.log(`  When you send it:  node jarvis/outreach-cli.mjs --sent ${cid}\n`);
