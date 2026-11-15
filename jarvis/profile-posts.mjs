/**
 * A PERSON'S RECENT POSTS, FROM THEIR PUBLIC PROFILE PAGE (F-783, 2026-10-21).
 *
 * Web search finds almost no LinkedIn posts: measured against seven known
 * hiring posts, server-side search found none of them, while the logged-out
 * profile page of the person showed the exact post for four of five. So every
 * named lead gets this check before anyone is ranked.
 *
 * One page per person, logged out (no account is used), paced. The page lists
 * the person's recent and engaged posts as /posts/ links; each link's activity
 * id carries its date, and the ones inside the window are read in full by
 * post-leads.mjs (real author, reshare → writer, exact date).
 *
 * LinkedIn refuses about a third of profile requests with a 999. A refusal is
 * UNKNOWN, never "no posts": it is retried once, then reported as such.
 *
 *   node jarvis/profile-posts.mjs <profile url | slug> [… more] [--company <Co>]
 *        [--days 75] [--job <jobId> --save] [--json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardArgs } from './cli.mjs';
import { idDate, parsePostHtml, leadsFromPosts, toLeadPerson, readWords } from './post-leads.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' };
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** "samortiza", "linkedin.com/in/samortiza/", a full URL → the profile URL. */
export function profileUrl(arg) {
  const s = String(arg || '').trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const slug = m ? m[1] : /^[A-Za-z0-9%_-]{2,100}$/.test(s) ? s : '';
  return slug ? `https://www.linkedin.com/in/${slug}` : '';
}

/** Name, headline, current employer and the dated post links on one profile page. */
export function parseProfileHtml(html, { now = new Date(), days = 75, slug = '' } = {}) {
  const t = String(html || '');
  // A post link starts with its writer's slug (/posts/samortiza_…): the rest
  // are posts the person liked or commented on.
  const mine = (url) => !!slug && url.toLowerCase().startsWith(`https://www.linkedin.com/posts/${slug.toLowerCase()}_`);
  const title = decode((t.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
  const desc = decode((t.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/) || t.match(/<meta[^>]+content="([^"]*)"[^>]+name="description"/) || [])[1] || '');
  // "Sam Ortiza - Tutor Intelligence | LinkedIn"
  const [name, headline = ''] = title.replace(/\s*\|\s*LinkedIn\s*$/, '').split(/\s+-\s+/, 2);
  const experience = ((desc.match(/Experience:\s*([^·]+)/) || [])[1] || '').trim();
  const links = [...new Set((t.match(/https:\/\/www\.linkedin\.com\/posts\/[A-Za-z0-9_%-]+/g) || []))];
  const posts = links
    .map((url) => ({ url, date: idDate((url.match(/activity-(\d{15,20})/) || [])[1]) }))
    .filter((p) => p.date)
    .map((p) => ({ url: p.url, date: p.date.toISOString(), ageDays: Math.floor((now - p.date) / 864e5), own: mine(p.url) }))
    .sort((a, b) => a.ageDays - b.ageDays);
  if (!slug) for (const p of posts) p.own = null;
  return { name: (name || '').trim(), headline: headline.trim(), experience, posts, recent: posts.filter((p) => p.ageDays <= days) };
}

/** Does the employer on the page match the company asked about? */
export function worksAt(profile, company) {
  if (!company) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // "Sunday" on the page is "Sunday Robotics" in the store: the name without
  // its generic words is what has to match (2026-10-24).
  const core = (s) => norm(String(s || '').replace(/\b(?:inc|corp(?:oration)?|llc|ltd|co|company|technologies|technology|robotics|labs?|ai|motors|solutions|group|systems|industries)\b\.?/gi, ' '));
  const c = norm(company);
  const k = core(company);
  const on = (field) => { const f = norm(field); const fk = core(field); return f.includes(c) || (k.length >= 3 && (fk.includes(k) || (fk.length >= 3 && fk === k))); };
  return !!c && (on(profile.experience) || on(profile.headline));
}

async function fetchText(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) }).catch(() => null);
  return { status: r?.status ?? 0, html: r?.ok ? await r.text() : '' };
}

/**
 * One person: their profile page, then each post inside the window read in
 * full. status: ok | refused (999/429 after one retry) | missing (404) | error.
 */
export async function readProfile(arg, { fetchImpl = fetch, now = new Date(), days = 75, maxPosts = 6, maxEngaged = 2, pauseMs = 1500, retryMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const url = profileUrl(arg);
  if (!url) return { url: String(arg), status: 'error', why: 'not a LinkedIn profile' };
  let { status, html } = await fetchText(url, fetchImpl);
  if (!html && (status === 999 || status === 429)) {
    await sleep(retryMs);
    ({ status, html } = await fetchText(url, fetchImpl));
  }
  if (!html) {
    return { url, status: status === 404 ? 'missing' : status === 999 || status === 429 ? 'refused' : 'error', http: status };
  }
  const profile = parseProfileHtml(html, { now, days, slug: url.split('/in/')[1] });
  // Their own posts first; a couple of the posts they engaged with after.
  const pick = [...profile.recent.filter((p) => p.own !== false).slice(0, maxPosts), ...profile.recent.filter((p) => p.own === false).slice(0, maxEngaged)];
  const posts = [];
  for (const p of pick) {
    if (pauseMs) await sleep(pauseMs);
    const page = await fetchText(p.url, fetchImpl);
    const post = parsePostHtml(page.html, p.url);
    posts.push(post ? { ...post, ageDays: p.ageDays, own: p.own } : { url: p.url, date: p.date, ageDays: p.ageDays, own: p.own, unreadable: true, http: page.status });
  }
  return { url, status: 'ok', ...profile, posts };
}

/**
 * THE OUTREACH BUTTON'S PROFILE PASS. Each researched person with a profile
 * link (up to `max`) gets their page read: `profile_check` records whether
 * the page still names the company, and a person the research found with no
 * post gets their own freshest hiring post as evidence, so verifyLeadPosts
 * reads it at the source next. A refused page changes nothing.
 */
export async function profileCheck(people, company, { fetchImpl = fetch, now = new Date(), max = 4, days = 75, sleep, pauseMs = 1500 } = {}) {
  const out = [];
  let n = 0;
  for (const person of people || []) {
    if (n >= max || !profileUrl(person.profile_url)) { out.push(person); continue; }
    if (n++ && pauseMs) await (sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(pauseMs);
    const r = await readProfile(person.profile_url, { fetchImpl, now, days, maxPosts: 3, maxEngaged: 0, pauseMs, ...(sleep ? { sleep } : {}) }).catch(() => null);
    if (!r || r.status !== 'ok') { out.push({ ...person, profile_check: r?.status || 'error' }); continue; }
    const at = worksAt(r, company);
    const next = { ...person, profile_check: at === false ? `page does not name ${company}${r.experience ? ` (shows ${r.experience})` : ''}` : 'still there' };
    const hasPost = /linkedin\.com\/(posts|feed\/update)\//i.test(String(person.signal?.url || person.evidence_url || ''));
    const hiring = r.posts.find((p) => !p.unreadable && p.own !== false && (() => { const w = readWords(p.text || p.shared?.text); return w.owns || w.invites || w.hiring; })());
    if (!hasPost && hiring) next.signal = { ...(person.signal || {}), kind: 'hiring_post', url: hiring.url, date: hiring.date.slice(0, 10) };
    out.push(next);
  }
  return out;
}

function report(r, company, days, log = console.log) {
  if (r.status !== 'ok') {
    const why = r.status === 'refused' ? `LinkedIn refused the page (${r.http}) twice: UNKNOWN, not "no posts" — try again later`
      : r.status === 'missing' ? 'no such profile (404)' : r.why || `could not read it (${r.http || 'no answer'})`;
    log(`\n### ${r.url}\n  ${why}`);
    return;
  }
  const at = worksAt(r, company);
  log(`\n### ${r.name}${r.headline ? ` — ${r.headline}` : ''}`);
  log(`  ${r.url}`);
  log(`  works at: ${r.experience || '(not shown)'}${at === false ? `  ⚠ not ${company} on the page` : ''}`);
  const own = r.recent.filter((p) => p.own !== false).length;
  const engaged = r.recent.length - own;
  log(`  last ${days} days: ${own} of their own post${own === 1 ? '' : 's'}, ${engaged} they engaged with${r.posts.length < r.recent.length ? ` (${r.posts.length} read)` : ''}`);
  for (const p of r.posts) {
    if (p.unreadable) { log(`  ${p.date.slice(0, 10)} (${p.ageDays}d) not readable (${p.http})\n    ${p.url}`); continue; }
    const mine = p.own !== false;
    const words = p.shared && !p.text ? p.shared.text : p.text;
    const w = readWords(words);
    const flags = [w.owns && 'speaks for the team', w.invites && 'invites contact', w.hiring && 'hiring'].filter(Boolean).join(' · ');
    const whose = !mine ? `${p.author.name}'s post (they engaged with it)` : p.shared ? `reshare of ${p.shared.author.name}${p.text ? ', with their own words' : ''}` : 'their post';
    log(`  ${p.date.slice(0, 10)} (${p.ageDays}d) ${whose}${flags ? ` — ${flags}` : ''}\n    "${String(words || '').slice(0, 200)}"\n    ${p.url}`);
  }
}

async function main() {
  guardArgs({ usage: 'usage: node jarvis/profile-posts.mjs <profile url|slug…> [--company <Co>] [--days 75] [--job <jobId> --save] [--json]', flags: ['--company', '--days', '--job', '--save', '--json'], valued: ['--company', '--days', '--job'] });
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  const valued = new Set(['--company', '--days', '--job'].map(opt).filter(Boolean));
  const people = args.filter((a) => !a.startsWith('--') && !valued.has(a));
  if (!people.length) { console.log('usage: node jarvis/profile-posts.mjs <profile url|slug…> [--company <Co>] [--days 75] [--job <jobId> --save] [--json]'); return; }
  const company = opt('--company');
  const days = Number(opt('--days') || 75);
  const results = [];
  for (const [i, p] of people.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 2500));
    const r = await readProfile(p, { days });
    results.push(r);
    if (!args.includes('--json')) report(r, company, days);
  }
  // Leads only from their own posts (a reshare still credits its writer): a
  // post they merely liked says nothing about who is hiring.
  const posts = results.flatMap((r) => (r.posts || []).filter((p) => !p.unreadable && p.own !== false));
  const leads = leadsFromPosts(posts);
  if (args.includes('--json')) { console.log(JSON.stringify({ results, leads }, null, 1)); }
  else {
    const refused = results.filter((r) => r.status === 'refused').length;
    console.log(`\n${results.filter((r) => r.status === 'ok').length} of ${results.length} profiles read${refused ? `, ${refused} refused (unknown, rerun later)` : ''}; hiring leads from their posts: ${leads.length ? leads.map((l) => `${l.name} (${l.standing})`).join(', ') : 'none'}`);
  }
  if (args.includes('--save') && opt('--job') && leads.length) {
    const { mergePostLeads } = await import('./leads.mjs');
    const n = mergePostLeads(opt('--job'), leads.map(toLeadPerson));
    console.log(`saved: the job's leads now hold ${n} people`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
