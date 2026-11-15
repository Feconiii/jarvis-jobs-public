/**
 * LEADS FROM PUBLIC LINKEDIN POSTS, READ FROM THE PAGE ITSELF (F-708, 2026-10-04).
 *
 * A post URL found by search is the POSTER's activity, and a reshare is not
 * the resharer's post. A summarising fetch named the wrong people and dated a
 * third-party page's reshare as the manager's post. So nothing here is taken
 * from a summary: each public post page is fetched (no login; /posts/ pages
 * are served to anyone, unlike /in/ profiles) and its JSON-LD is read —
 * author, datePublished, the author's own words, and `sharedContent`: whose
 * post it reshares and what that post said. The reshared post's own id sits
 * in the page as a second `urn:li:activity:…`, and an activity id's top 41
 * bits are its epoch-ms timestamp, so the ORIGINAL is dated exactly too.
 *
 * His point (2026-10-04): a repost is not a dead lead, it is a pointer. A
 * resharer leads to the original author, usually the hiring manager; a
 * resharer who adds "my team is hiring, reach out" is a lead in their own
 * right. Both come out of one page.
 *
 *   node jarvis/post-leads.mjs <post-url> [<post-url> …]
 *   node jarvis/post-leads.mjs --file urls.txt
 *   …  --job <jobId> --save     add the people to that job's leads (Outreach tab)
 *   …  --json                   machine output
 *
 * The URLs come from a search run in his own browser (Google,
 * `site:linkedin.com/posts <team> hiring`, past year, about one search a
 * minute — Google shows a CAPTCHA after six fast ones). The fetches here are
 * one page a second.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { guardArgs } from './cli.mjs';
import { fileURLToPath } from 'node:url';
import { FRESH_DAYS, RECENT_DAYS, STALE_DAYS, mergePostLeads } from './leads.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/** An activity/share id's top 41 bits are epoch milliseconds. */
export function idDate(id) {
  try {
    const ms = Number(BigInt(String(id)) >> 22n);
    return ms > Date.UTC(2010, 0, 1) && ms < Date.UTC(2100, 0, 1) ? new Date(ms) : null;
  } catch { return null; }
}

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const squash = (s) => decode(s).replace(/\s+/g, ' ').trim();

/** A company page or a person. */
export function kindOf(url) {
  return /linkedin\.com\/company\//i.test(String(url || '')) ? 'company' : /linkedin\.com\/in\//i.test(String(url || '')) ? 'person' : 'unknown';
}

/**
 * The language that matters, read from ONE person's own words.
 *   owns    — they speak for the team: "my team", "I'm hiring", "join my team"
 *   invites — they ask to be contacted: "reach out", "DM me", "message me"
 *   hiring  — the post is about an opening at all
 *   broadcast — "<Company> is hiring a …" in the third person: a job-board
 *               account or a stranger, not someone on the team
 */
export function readWords(text) {
  const t = squash(text);
  return {
    owns: /\b(my|our) (team|group|org)\b[^.!?]{0,40}\b(is |are )?(hiring|growing|looking)|\b(I'm|I am|we're|we are) hiring\b|\bjoin(ing)? (my|our) team\b|\bgrowing (my|our) team\b/i.test(t),
    invites: /\breach out\b|\b(DM|dm|message|ping|email) me\b|\bsend me (your|a)\b|\bfeel free to (contact|message|reach)|\b(happy|glad) to (chat|connect|refer)|\bI'?d love to connect\b|\bconnect with me\b/i.test(t),
    hiring: /\bhiring\b|\bjoin (my|our|the) team\b|\bopen (role|position)s?\b|\bwe'?re looking for\b|\bopportunit(y|ies)\b/i.test(t),
    broadcast: /^[^.!?]{0,60}\b(is|are) hiring (a|an|for)\b/i.test(t) && !/\b(my|our)\b/i.test(t),
  };
}

/**
 * A posting on an application platform, any employer (2026-10-24: only
 * amazon.jobs was ever lifted off a post). LinkedIn's own /jobs/ links are left
 * out: a logged-out post page lists unrelated jobs beside the post.
 */
export const JOB_LINK = /https?:\/\/(?:[a-z0-9-]+\.)*(?:amazon\.jobs|greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|smartrecruiters\.com|icims\.com|eightfold\.ai|jobvite\.com|workable\.com|rippling-ats\.com|ats\.rippling\.com|bamboohr\.com|oraclecloud\.com|successfactors\.com|teamtailor\.com|pinpointhq\.com|jobs\.personio\.(?:de|com)|tesla\.com\/careers)\/?[^\s"'<>\\]*/gi;

/** Read one public post page. Returns null when it is not a post page. */
export function parsePostHtml(html, url = '') {
  let ld = null;
  for (const m of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      // A video post is a VideoObject (F-783: Sam Ortiza's and Josh
      // Whitfield's Tutor posts read as "not a post"): its poster is in
      // `creator`, its words in `description`.
      for (const it of Array.isArray(j) ? j : [j]) if (/SocialMediaPosting|VideoObject/.test(it?.['@type'] || '')) ld = it;
    } catch { /* not JSON */ }
  }
  if (!ld) return null;
  const video = /VideoObject/.test(ld['@type']);
  if (video && !ld.author) ld = { ...ld, author: ld.creator };
  const ids = [...new Set([...String(html).matchAll(/urn:li:activity:(\d{15,20})/g)].map((m) => m[1]))];
  const own = (String(url).match(/activity-(\d{15,20})/) || [])[1] || ids[0] || '';
  const otherId = ids.find((x) => x !== own) || '';
  // articleBody is the author's own words; text is often just the attached
  // card's title ("Robotics Systems Engineer II, Tech Deployment").
  // A plain reshare has no words of its own: its text field may carry the
  // ORIGINAL's words, which must never be credited to the resharer.
  // A video's description is the poster's own words even on a reshare: the
  // original's words sit in sharedContent.headline.
  const text = squash(ld.articleBody || (video ? ld.description || ld.headline : '') || (ld.sharedContent ? '' : ld.text) || '');
  const shared = ld.sharedContent?.author ? {
    author: { name: squash(ld.sharedContent.author.name), url: String(ld.sharedContent.author.url || ''), kind: kindOf(ld.sharedContent.author.url) },
    text: squash(ld.sharedContent.headline || ''),
    id: otherId,
    date: idDate(otherId)?.toISOString() || '',
    url: otherId ? `https://www.linkedin.com/feed/update/urn:li:activity:${otherId}/` : '',
  } : null;
  const shortLinks = [...new Set([...String(html).matchAll(/https:\/\/lnkd\.in\/[A-Za-z0-9_-]+/g)].map((m) => m[0]))];
  const jobLinks = [...new Set([...decode(html).matchAll(JOB_LINK)].map((m) => m[0]))];
  return {
    url: String(url).split('?')[0],
    id: own,
    date: String(ld.datePublished || idDate(own)?.toISOString() || ''),
    author: { name: squash(ld.author?.name), url: String(ld.author?.url || ''), kind: kindOf(ld.author?.url) },
    text,
    shared,
    shortLinks,
    jobLinks,
  };
}

const ageDays = (iso, now) => (iso ? Math.max(0, Math.floor((now - new Date(iso)) / 86400e3)) : null);
export function standingOf(days) {
  return days == null ? 'undated' : days <= FRESH_DAYS ? 'fresh' : days <= RECENT_DAYS ? 'recent' : days <= STALE_DAYS ? 'weak' : 'stale';
}

/**
 * Everyone a set of posts points at, one row per person, best evidence kept.
 * A resharer with no words of their own is NOT a lead from that post; the
 * original author is, found via them.
 */
export function leadsFromPosts(posts, { now = new Date() } = {}) {
  const people = new Map();
  const add = (who, ev) => {
    if (!who?.name || who.kind !== 'person') return;
    const key = (who.url || who.name).toLowerCase().replace(/\/+$/, '');
    const cur = people.get(key) || { name: who.name, profile_url: who.url, evidence: [] };
    cur.evidence.push(ev);
    people.set(key, cur);
  };
  for (const p of posts.filter(Boolean)) {
    const words = readWords(p.text);
    const ownWords = !!p.text;
    if (ownWords && (words.hiring || words.owns || words.invites) && !words.broadcast) {
      add(p.author, {
        role: p.shared ? 'reshared with their own words' : 'wrote it', ...words,
        quote: p.text.slice(0, 240), date: p.date, ageDays: ageDays(p.date, now), url: p.url,
        jobLinks: p.jobLinks, shortLinks: p.shortLinks,
        reshares: p.shared ? p.shared.author.name : '',
      });
    }
    if (p.shared) {
      const sw = readWords(p.shared.text);
      if (sw.hiring || sw.owns || sw.invites) {
        add(p.shared.author, {
          role: 'wrote the original', ...sw,
          quote: p.shared.text.slice(0, 240), date: p.shared.date, ageDays: ageDays(p.shared.date, now), url: p.shared.url,
          jobLinks: p.jobLinks, shortLinks: p.shortLinks,
          via: `${p.author.name}${p.author.kind === 'company' ? ' (a company page)' : ''} reshared it`,
        });
      }
    }
  }
  const score = (e) => (e.owns ? 4 : 0) + (e.invites ? 4 : 0) + (e.hiring ? 1 : 0)
    + ({ fresh: 6, recent: 4, weak: 1, stale: 0, undated: 0 }[standingOf(e.ageDays)]);
  return [...people.values()].map((p) => {
    const best = [...p.evidence].sort((a, b) => score(b) - score(a) || (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9))[0];
    return { ...p, best, standing: standingOf(best.ageDays), score: score(best) };
  }).sort((a, b) => b.score - a.score);
}

/** The Outreach tab's lead shape (leads.mjs readSignal / parseLeads). */
export function toLeadPerson(l) {
  const e = l.best;
  const kind = e.invites ? 'invited' : (e.owns || e.hiring) ? 'hiring_post' : 'relevant_post';
  return {
    name: l.name,
    title: '',
    persona: e.owns ? 'manager' : 'team',
    lead_type: e.owns ? 'decision' : 'alternate',
    profile_url: l.profile_url,
    evidence_url: e.url,
    confidence: e.role === 'wrote it' || e.role === 'wrote the original' ? 'high' : 'medium',
    why: `${e.role === 'wrote the original' ? `Wrote the original post${e.via ? ` (${e.via})` : ''}` : e.role === 'wrote it' ? 'Wrote the post' : `Reshared ${e.reshares}'s post with their own words`}, ${e.date ? e.date.slice(0, 10) : 'undated'}${e.owns ? '; speaks for the team' : ''}${e.invites ? '; asks people to reach out' : ''}.`,
    signal: { kind, author: l.name, date: e.date ? e.date.slice(0, 10) : '', quote: e.quote, url: e.url },
  };
}

async function get(url, fetchImpl = fetch) {
  const r = await fetchImpl(url, { headers: { 'user-agent': UA }, redirect: 'follow' }).catch(() => null);
  return r?.ok ? r.text() : '';
}

const POST_URL = /^https?:\/\/(?:www\.)?linkedin\.com\/(?:posts|feed\/update)\//i;

/**
 * THE RESEARCH'S POSTS, CHECKED AT THE SOURCE (F-711/F-708). The Outreach
 * button's research cites posts from search snippets; each cited post is
 * read here and the person's signal takes the PAGE's author, words and date.
 * A post someone only reshared becomes a reshare (`author` = the writer, so
 * readSignal calls it `reposted`), and the writer joins the leads, found via
 * them. Returns the people to merge; changes nothing when no post is cited.
 */
export async function verifyLeadPosts(people, { fetchImpl = fetch, now = new Date(), max = 8, pauseMs = 800 } = {}) {
  const urls = [...new Set(people.flatMap((p) => [p.signal?.url, p.evidence_url]).filter((u) => POST_URL.test(String(u || ''))).map((u) => String(u).split('?')[0]))].slice(0, max);
  if (!urls.length) return { people, added: [] };
  const posts = new Map();
  for (const u of urls) {
    const p = parsePostHtml(await get(u, fetchImpl), u);
    if (p) posts.set(u, p);
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  const same = (a, b) => String(a || '').toLowerCase().replace(/[^a-z]/g, '') === String(b || '').toLowerCase().replace(/[^a-z]/g, '');
  const fixed = people.map((person) => {
    const u = [person.signal?.url, person.evidence_url].map((x) => String(x || '').split('?')[0]).find((x) => posts.has(x));
    if (!u) return person;
    const post = posts.get(u);
    const theirs = same(post.author.name, person.name);
    const words = theirs ? post.text : '';
    const w = readWords(words);
    const signal = theirs && words
      ? { kind: w.invites ? 'invited' : (w.owns || w.hiring) ? 'hiring_post' : 'relevant_post', author: person.name, date: post.date.slice(0, 10), quote: words.slice(0, 240), url: post.url }
      // Not their words: keep it, but as someone else's post, so it reads as a reshare.
      : { ...(person.signal || { kind: 'hiring_post' }), author: post.shared?.author.name || post.author.name, date: (post.shared?.date || post.date).slice(0, 10), url: post.url };
    return { ...person, signal, verified_post: true };
  });
  const added = leadsFromPosts([...posts.values()], { now }).map(toLeadPerson)
    .filter((l) => !fixed.some((p) => same(p.name, l.name)));
  return { people: fixed, added };
}
/** lnkd.in serves a page that names its target. */
export async function resolveShort(link) {
  const html = await get(link, fetch);
  return ([...decode(html).matchAll(JOB_LINK)][0] || [])[0] || '';
}

async function main() {
  guardArgs({ usage: "usage: node jarvis/post-leads.mjs <linkedin post url…> [--file <urls.txt>] [--job <jobId> --save] [--json]", flags: ["--file", "--job", "--save", "--json"], valued: ["--file", "--job"] });
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  // A full post link, or the slug post-search.mjs lifts off a results page.
  const asUrl = (a) => (/linkedin\.com\/(posts|feed\/update)\//.test(a) ? a : /-activity-\d{15,20}/.test(a) ? `https://www.linkedin.com/posts/${a.replace(/^POST\s+/, '')}` : '');
  let urls = args.map(asUrl).filter(Boolean);
  if (opt('--file')) urls.push(...readFileSync(opt('--file'), 'utf8').split(/\s+/).filter((u) => /linkedin\.com\/(posts|feed\/update)\//.test(u)));
  urls = [...new Set(urls.map((u) => u.split('?')[0]))];
  if (!urls.length) { console.log('usage: node jarvis/post-leads.mjs <linkedin post url…> [--file f] [--job id --save] [--json]'); return; }
  const posts = [];
  for (const u of urls) {
    const p = parsePostHtml(await get(u), u);
    if (p) {
      p.jobLinks = [...new Set([...p.jobLinks, ...(await Promise.all(p.shortLinks.slice(0, 3).map(resolveShort))).filter(Boolean)])];
      posts.push(p);
    } else console.error(`not readable as a post: ${u}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const leads = leadsFromPosts(posts);
  if (args.includes('--json')) { console.log(JSON.stringify({ posts, leads }, null, 1)); }
  else {
    for (const l of leads) {
      const e = l.best;
      console.log(`${l.name} — ${l.standing}, ${e.date ? e.date.slice(0, 10) : 'undated'} — ${e.role}${e.via ? `, ${e.via}` : ''}${e.owns ? ' · speaks for the team' : ''}${e.invites ? ' · invites contact' : ''}`);
      console.log(`  ${l.profile_url}\n  "${e.quote.slice(0, 160)}"\n  ${e.url}${e.jobLinks?.length ? `\n  job: ${e.jobLinks.join(' ')}` : ''}`);
    }
    const skipped = posts.filter((p) => p.author.kind === 'company' || readWords(p.text).broadcast).map((p) => `${p.author.name}${p.author.kind === 'company' ? ' (company page)' : ' (third-person broadcast)'}`);
    if (skipped.length) console.log(`\nnot leads themselves: ${[...new Set(skipped)].join(', ')}`);
  }
  if (args.includes('--save') && opt('--job')) {
    const n = mergePostLeads(opt('--job'), leads.map(toLeadPerson));
    console.log(`\nsaved: the job's leads now hold ${n} people`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
