/**
 * PEOPLE HE ALREADY FOUND, RE-READ EVERY WEEK (2026-10-24).
 *
 * The cheapest new lead is a known one posting again. Riley Morgan, who had
 * already answered him, wrote "My team is hiring!" on 2026-10-22 and named his
 * manager Kai Ortiz; nothing noticed until a hand check two days later. So
 * once a week the dashboard server reads the public profile page of every
 * person on his outreach list (saved contacts, people the Outreach button
 * found, verdicts strong or possible), logged out, paced, a few pages each
 * (profile-posts.mjs). A NEW post of their own with hiring words, under three
 * weeks old, is read at the source (post-leads.mjs: a reshare credits its
 * writer, every post dated) and its people join that job's leads on the
 * Outreach tab. A page that no longer names the company is reported.
 *
 * Nothing is sent, nothing signed in, no LinkedIn account used. A refused page
 * (999) is unknown: it is first in line next week.
 *
 *   node jarvis/lead-watch.mjs [--dry-run] [--max 40]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outreachDb, outreachDbPath } from './outreach-db.mjs';
import { readProfile, profileUrl, worksAt } from './profile-posts.mjs';
import { leadsFromPosts, toLeadPerson, readWords } from './post-leads.mjs';

// 40 people every three days: each of his ~80 is read about once a week.
export const WATCH_EVERY_DAYS = 3;
export const NEW_POST_DAYS = 21;
export const MAX_PER_RUN = 40;
export const BLOCKED_AFTER = 3;
export const BLOCK_RETRY_MS = 12 * 3600e3;

const DDL = `
CREATE TABLE IF NOT EXISTS lead_watch (
  slug        TEXT PRIMARY KEY,
  checked_at  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  newest_post TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS li_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;
const db = (dbPath = outreachDbPath()) => outreachDb(dbPath, { ddl: DDL });
const slugOf = (u) => (profileUrl(u).split('/in/')[1] || '').toLowerCase();

/**
 * Everyone worth re-reading, one row per profile, with every job they belong
 * to. Jobs he took off the Outreach tab and people marked do-not-contact or
 * rejected are left out.
 */
export function watchList({ dbPath = outreachDbPath() } = {}) {
  const h = db(dbPath);
  // A table another module has not made yet (a fresh store) is empty, not an error.
  const rows = (sql) => { try { return h.prepare(sql).all(); } catch { return []; } };
  const removed = new Set(rows('SELECT job_id FROM outreach_removed').map((r) => r.job_id));
  const rejected = new Set(rows("SELECT profile_url FROM lead_verdicts WHERE status = 'rejected'").map((r) => slugOf(r.profile_url)).filter(Boolean));
  const out = new Map();
  const add = (name, url, jobId, company, why) => {
    const slug = slugOf(url);
    if (!slug || !jobId || removed.has(jobId)) return;
    const cur = out.get(slug) || { slug, name, url: profileUrl(url), company, jobs: new Set(), why };
    cur.jobs.add(jobId);
    out.set(slug, cur);
  };
  // SELECT *: a column this reader names that a table lacks fails the query, and
  // rows() turns that into nobody to watch.
  for (const c of rows('SELECT * FROM contacts')) {
    if (!c.do_not_contact && c.status !== 'retired') add(c.name, c.linkedin_url, c.job_id, c.company, 'saved contact');
  }
  for (const v of rows("SELECT name, profile_url, job_id, company FROM lead_verdicts WHERE status IN ('strong','possible')")) {
    add(v.name, v.profile_url, v.job_id, v.company, 'verdict');
  }
  for (const r of rows('SELECT job_id, result FROM lead_runs WHERE result IS NOT NULL')) {
    let res = null; try { res = JSON.parse(r.result); } catch { continue; }
    for (const p of res?.people || []) add(p.name, p.profile_url, r.job_id, res.company || '', 'found by the Outreach button');
  }
  for (const s of rejected) out.delete(s);
  return [...out.values()].map((p) => ({ ...p, jobs: [...p.jobs] }));
}

/** The oldest-checked first; a refused or never-read page before everything else. */
export function dueOrder(list, { dbPath = outreachDbPath() } = {}) {
  const h = db(dbPath);
  const get = h.prepare('SELECT checked_at, status, newest_post FROM lead_watch WHERE slug = ?');
  return list.map((p) => ({ ...p, state: get.get(p.slug) || null }))
    .sort((a, b) => String(a.state?.status === 'ok' ? a.state.checked_at : '').localeCompare(String(b.state?.status === 'ok' ? b.state.checked_at : '')));
}

/**
 * One pass. `read` and `merge` are injectable for tests. Returns
 * { at, checked, refused, found: [...], moved: [...] }.
 */
export async function watchLeads({ dbPath = outreachDbPath(), now = new Date(), max = MAX_PER_RUN, dryRun = false, companyOf = null,
  read = (url) => readProfile(url, { days: NEW_POST_DAYS, maxPosts: 3, maxEngaged: 0 }),
  merge = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 8000 + Math.floor(Math.random() * 4000), log = () => {} } = {}) {
  const h = db(dbPath);
  const put = h.prepare(`INSERT INTO lead_watch (slug, checked_at, status, newest_post) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, newest_post = excluded.newest_post`);
  const doMerge = merge || (await import('./leads.mjs')).mergePostLeads;
  if (!companyOf) {
    const { getJob } = await import('./store.mjs');
    companyOf = (p) => p.company || p.jobs.map((id) => { try { return getJob(id)?.company; } catch { return ''; } }).find(Boolean) || '';
  }
  const people = dueOrder(watchList({ dbPath }), { dbPath }).slice(0, max);
  const summary = { at: now.toISOString(), checked: 0, refused: 0, found: [], moved: [] };
  let streak = 0;
  for (const [i, p] of people.entries()) {
    if (i && pauseMs) await sleep(pauseMs);
    const r = await read(p.url).catch(() => null);
    if (!r || r.status !== 'ok') {
      const refused = r?.status !== 'missing';
      summary.refused += refused ? 1 : 0;
      if (!dryRun) put.run(p.slug, now.toISOString(), r?.status || 'error', p.state?.newest_post || '');
      log(`${p.name}: ${r?.status || 'error'}`);
      // Three refusals in a row is LinkedIn turning this address away, not
      // three people (2026-10-24: all 23 of a pass refused after a burst of
      // reads). Stop, and try again in half a day.
      streak = refused ? streak + 1 : 0;
      if (streak >= BLOCKED_AFTER) { summary.blocked = true; break; }
      continue;
    }
    streak = 0;
    summary.checked += 1;
    const company = companyOf(p);
    if (company && worksAt(r, company) === false) summary.moved.push({ name: p.name, company, shows: r.experience || r.headline || '' });
    // Their own posts newer than the newest one seen last time (on a first
    // read: the last three weeks), with hiring words.
    const since = p.state?.newest_post || new Date(+now - NEW_POST_DAYS * 864e5).toISOString();
    const fresh = (r.posts || []).filter((x) => !x.unreadable && x.own !== false && x.date > since)
      .filter((x) => { const w = readWords(x.text || x.shared?.text); return w.owns || w.invites || w.hiring; });
    const newest = (r.posts || []).filter((x) => x.own !== false).map((x) => x.date).sort().pop() || p.state?.newest_post || '';
    if (!dryRun) put.run(p.slug, now.toISOString(), 'ok', newest > (p.state?.newest_post || '') ? newest : (p.state?.newest_post || ''));
    if (!fresh.length) continue;
    const leads = leadsFromPosts(fresh, { now }).filter((l) => ['fresh', 'recent'].includes(l.standing));
    if (!leads.length) continue;
    for (const jobId of p.jobs) if (!dryRun) doMerge(jobId, leads.map(toLeadPerson), { dbPath, now });
    for (const l of leads) {
      summary.found.push({ name: l.name, via: p.name, jobs: p.jobs, date: l.best.date.slice(0, 10), url: l.best.url, quote: l.best.quote.slice(0, 160), isNew: l.name !== p.name });
    }
    log(`${p.name}: ${leads.map((l) => l.name).join(', ')}`);
  }
  const meta = h.prepare('INSERT INTO li_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (!dryRun && summary.blocked) meta.run('lead_watch_blocked', now.toISOString());
  // A pass turned away before reading anyone keeps the last real result on the tab.
  if (!dryRun && (!summary.blocked || summary.checked)) meta.run('lead_watch_last', JSON.stringify(summary));
  return summary;
}

export function lastWatch({ dbPath = outreachDbPath() } = {}) {
  try { return JSON.parse(db(dbPath).prepare("SELECT value FROM li_meta WHERE key = 'lead_watch_last'").get()?.value || 'null'); } catch { return null; }
}

/**
 * Due when the last pass is WATCH_EVERY_DAYS old (the server asks every few
 * hours); a pass LinkedIn turned away is tried again after BLOCK_RETRY_MS.
 */
export function watchDue({ dbPath = outreachDbPath(), now = new Date() } = {}) {
  const last = lastWatch({ dbPath });
  let blocked = '';
  try { blocked = db(dbPath).prepare("SELECT value FROM li_meta WHERE key = 'lead_watch_blocked'").get()?.value || ''; } catch { /* never blocked */ }
  if (blocked && (!last || Date.parse(blocked) >= Date.parse(last.at))) return +now - Date.parse(blocked) >= BLOCK_RETRY_MS;
  return !last || +now - Date.parse(last.at) >= WATCH_EVERY_DAYS * 864e5;
}

async function main() {
  const args = process.argv.slice(2);
  const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : MAX_PER_RUN;
  const s = await watchLeads({ dryRun: args.includes('--dry-run'), max, log: (l) => console.log(`  ${l}`) });
  console.log(`\n${s.checked} profiles read${s.refused ? `, ${s.refused} refused (first in line next time)` : ''}.`);
  for (const f of s.found) console.log(`NEW: ${f.name}${f.isNew ? ` (via ${f.via})` : ''}, ${f.date}: "${f.quote}"\n  ${f.url}`);
  for (const m of s.moved) console.log(`MOVED? ${m.name}: page no longer names ${m.company}${m.shows ? ` (shows ${m.shows})` : ''}`);
  if (!s.found.length) console.log('No new hiring posts.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
