/**
 * CHECK AND SAVE ONE OUTREACH MESSAGE (2026-10-04, .claude/skills/outreach §3-4).
 *
 *   node jarvis/outreach-draft.mjs check --job <id> --name "<person>" --file <draft.txt> [--post <post url>]
 *   node jarvis/outreach-draft.mjs save  --job <id> --name "<person>" --file <draft.txt> --profile <linkedin url> [--title "…"] [--persona manager]
 *
 * `check` runs the same rules the writer is held to (outreach.mjs
 * checkOutreach: his template's length, the fit ask, the link, portfolio and
 * resume lines, nothing claimed that cv.md or the posting does not hold). With
 * --post, the post is read at the source, so "I saw your post…" is checked
 * against what that person actually wrote and when.
 * `save` puts the approved text on the Outreach tab, ready for
 * linkedin-fill.mjs. Nothing is sent from here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardArgs } from './cli.mjs';
import { checkOutreach, portfolioUrl } from './outreach.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://localhost:4300';

/** The lead signal a post gives, as checkOutreach reads it. */
export function signalFromPost(post, name) {
  if (!post) return null;
  // "Lin Zhao, SHRM-CP" and "Jane Doe (she/her)" are Lin Zhao and Jane
  // Doe: credentials and pronouns after the name are not part of it (2026-10-05).
  const fold = (s) => String(s || '').split(/[,(|]/)[0].toLowerCase().replace(/[^a-z]/g, '');
  const same = (a, b) => fold(a) === fold(b);
  const theirs = same(post.author.name, name) && post.text;
  const viaShare = post.shared && same(post.shared.author.name, name);
  if (!theirs && !viaShare) return { kind: 'hiring_post', standing: 'reposted', author: post.shared?.author.name || post.author.name, quote: '', url: post.url };
  const date = theirs ? post.date : post.shared.date;
  const ageDays = date ? Math.floor((Date.now() - new Date(date)) / 86400e3) : null;
  const standing = ageDays == null ? 'undated' : ageDays <= 14 ? 'fresh' : ageDays <= 42 ? 'recent' : ageDays <= 120 ? 'weak' : 'stale';
  return { kind: /reach out|DM me|message me|connect/i.test(theirs ? post.text : post.shared.text) ? 'invited' : 'hiring_post', standing, ageDays, author: name, quote: (theirs ? post.text : post.shared.text).slice(0, 240), url: post.url };
}

export function checkDraft({ text, job, jd = '', cvText = '', name = '', title = '', post = null, portfolio = 'https://alexrivera.example' }) {
  const signal = signalFromPost(post, name);
  const r = checkOutreach(text, { channel: 'message', cvText, jd, job, contact: { name, title }, lead: signal ? { signal } : null, portfolio });
  const prose = text.split('\n').filter((l) => !/^\s*(portfolio|resume)\s*:/i.test(l)).join(' ').replace(/https?:\/\/\S+/g, ' ');
  return { ...r, chars: text.length, words: prose.split(/\s+/).filter(Boolean).length, signal };
}

async function main() {
  guardArgs({
    usage: 'usage: node jarvis/outreach-draft.mjs check|save --job <id> --name "<person>" --file <draft.txt> [--post <url>] [--profile <url>] [--title <t>] [--persona <p>]',
    flags: ['--job', '--name', '--file', '--post', '--profile', '--title', '--persona'],
    valued: ['--job', '--name', '--file', '--post', '--profile', '--title', '--persona'],
  });
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  const [jobId, name, file] = [opt('--job'), opt('--name'), opt('--file')];
  if (!['check', 'save'].includes(cmd) || !jobId || !name || !file) { console.log('usage: node jarvis/outreach-draft.mjs check|save --job <id> --name "<person>" --file <draft.txt> …'); return; }
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  const { getJob, getDescription } = await import('./store.mjs');
  const job = getJob(jobId);
  if (!job) { console.log(`no job ${jobId}`); process.exitCode = 1; return; }
  let post = null;
  if (opt('--post')) {
    const { parsePostHtml } = await import('./post-leads.mjs');
    const r = await fetch(opt('--post'), { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' } }).catch(() => null);
    post = r?.ok ? parsePostHtml(await r.text(), opt('--post')) : null;
    if (!post) console.log('(the post could not be read; checking without it)');
  }
  const res = checkDraft({ text, job, jd: getDescription(jobId) || '', cvText: readFileSync(path.join(ROOT, 'cv.md'), 'utf8'), name, title: opt('--title'), post, portfolio: portfolioUrl() || 'https://alexrivera.example' });
  console.log(`${res.words} words, ${res.chars} characters${res.signal ? ` · their post: ${res.signal.standing}${res.signal.ageDays != null ? `, ${res.signal.ageDays} days old` : ''}` : ''}`);
  console.log(res.ok ? 'PASSES every check' : `PROBLEMS:\n${res.problems.map((p) => `  - ${p}`).join('\n')}`);
  if (res.notices.length) console.log(`notices:\n${res.notices.map((p) => `  - ${p}`).join('\n')}`);
  // `save` is held to the same check (2026-10-05): Shreyash's "I saw your post
  // that your team is hiring" was saved over a failing check — the post was
  // never read, and was 4 months old. A draft that fails is not saved, so it
  // can never be filled; fix the text (or read the post with --post) instead.
  if (!res.ok) { process.exitCode = 1; if (cmd === 'save') console.log('NOT SAVED: a draft that fails the check cannot be saved or filled.'); return; }
  if (cmd === 'check') return;
  const r = await fetch(`${API}/api/outreach/contact`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: jobId, name, title: opt('--title'), persona: opt('--persona') || 'manager', channel: 'message', linkedin_url: opt('--profile'), draft: text }),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: `the dashboard is not answering (${e.message})` }) }));
  const j = await r.json();
  if (!r.ok) { console.log(`not saved: ${j.error}`); process.exitCode = 1; return; }
  console.log(`saved ${j.contact.id} (${j.contact.status}). Next: node jarvis/linkedin-fill.mjs --name "${name.split(' ')[0]}" --subject "…"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
