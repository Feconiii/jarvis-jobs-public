/**
 * WHERE TO LOOK FOR HIRING POSTS, PER TEAM HE APPLIED TO (2026-10-04).
 *
 * The first half of an outreach run (.claude/skills/outreach). It groups his
 * applications at one company by team — five "Tech Deployment" reqs are one
 * team and get one message — and writes, per team, the searches that found
 * real hiring managers' posts on 2026-10-04, plus the one snippet that lifts
 * post links off a results page. The session runs the searches in HIS Chrome
 * (Claude in Chrome), about one a minute, and hands the links to
 * post-leads.mjs, which reads each post at the source.
 *
 * Why a browser: every free engine refuses server requests — Google, Bing,
 * Startpage and DuckDuckGo answer with a challenge, Brave answers but ignores
 * quoted phrases (measured 2026-10-04). In his browser Google is the best;
 * after a burst it shows a CAPTCHA, which is never solved — Brave in the
 * browser is the fallback.
 *
 * The team is read from the TITLE, after the comma ("Robotics Systems
 * Engineer I, Tech Deployment"): the row's `team` is the employer's job
 * category ("Systems, Quality, & Security Engineering"), useless to search.
 *
 *   node jarvis/post-search.mjs --company Amazon
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardArgs } from './cli.mjs';

const LEVEL = /\b(?:I{1,3}|IV|[1-4]|Sr\.?|Senior|Jr\.?|Junior|Staff|Principal|Lead|Entry[- ]Level|New Grad(?:uate)?|Early Career)\b/gi;
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+([,)])/g, '$1').replace(/^[\s,–—-]+|[\s,–—-]+$/g, '').trim();

// Words about the OPENING, not the work (2026-10-24): GlobalFoundries' "Fab
// Automation Engineer 2027 New College Graduate Essex Junction Vermont United
// States Of America" was searched as one quoted phrase, which no post holds.
const NOISE = /\b(?:20\d\d|New (?:College )?Grad(?:uate)?s?|NCG|College Graduate|Graduate|Early Careers?|Bachelor'?s?(?: S)?|Bachelors|Masters?|Bs Or Ms|Ms Or Bs|BS\/MS|United States(?: Of America)?|USA|Remote|Hybrid|Onsite|On-site)\b/gi;
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The posting's location words (city, state) taken out of its title. */
function dropPlace(t, location) {
  let out = t;
  for (const part of String(location || '').split(/[,;/]|\s+-\s+/).map((s) => s.trim()).filter((s) => s.length >= 3 && !/^united states/i.test(s))) {
    out = out.replace(new RegExp(`\\b${esc(part)}\\b`, 'gi'), ' ');
  }
  // A trailing state code ("… Engineer NY", "… Austin Tx").
  return out.replace(/\s([A-Za-z]{2})\s*$/, (m, st) => (STATES.has(st.toUpperCase()) ? ' ' : m));
}

/** "Robotics Systems Engineer I, Tech Deployment" → { role, team, acronyms }. */
export function titleParts(title, location = '') {
  let t = String(title || '').replace(/\(\s*20\d\d\s*\)/g, ' ');
  // Parentheses: an acronym stays ("(RDPI)"), anything else is a place or a
  // note ("(Miami, FL)", "(Wayne (EPCO), NJ, US)") and goes, innermost first.
  for (let i = 0; i < 4 && /\([^()]*\)/.test(t); i++) t = t.replace(/\(([^()]*)\)/g, (m, inner) => (/^[A-Z][A-Z0-9&]{1,7}$/.test(inner.trim()) ? `⟨${inner.trim()}⟩` : ' '));
  t = t.replace(/⟨/g, '(').replace(/⟩/g, ')');
  t = dropPlace(t.replace(NOISE, ' '), location);
  // The team follows the first comma, or the first spaced dash or bar
  // ("Mechanical Engineer - Optical Systems").
  const seps = [t.indexOf(','), t.search(/\s[-–—|]\s/)].filter((i) => i >= 0);
  const at = seps.length ? Math.min(...seps) : -1;
  const role = tidy((at >= 0 ? t.slice(0, at) : t).replace(LEVEL, ' '));
  let team = at >= 0 ? t.slice(at + 1).replace(/^\s*[-–—|]\s*/, '') : '';
  const acronyms = [...team.matchAll(/\(([A-Z][A-Z0-9&]{1,7})\)/g)].map((m) => m[1]);
  team = tidy(team.replace(/\([^)]*\)/g, ' ').replace(LEVEL, ' ').replace(/^[A-Z]{2,5}\s*[-–—]\s*/, ''));
  // A bare division ("AWS") is the employer, not a team: search the role.
  if (/^[A-Z]{2,5}$/.test(team)) team = '';
  // A long name is never quoted whole in a post; its last two words are
  // ("Robotics Delivery & Packaging Innovations Technology Deployment" →
  // "Technology Deployment").
  // "Robotics, Real-World Test Lab": the last part names the team.
  const named = team.includes(',') ? tidy(team.split(',').pop()) : team;
  const words = named.split(' ');
  const short = words.length > 4 ? words.slice(-2).join(' ') : named;
  return { role, team, short, acronyms };
}

/** One group per team; a title with no team is its own group. */
export function clusters(jobs) {
  const out = new Map();
  for (const j of jobs) {
    const p = titleParts(j.title, j.location);
    const key = (p.team || p.role).toLowerCase();
    const c = out.get(key) || { key, team: p.team, short: p.short, role: p.role, acronyms: new Set(), jobs: [] };
    p.acronyms.forEach((a) => c.acronyms.add(a));
    c.jobs.push(j);
    out.set(key, c);
  }
  return [...out.values()].map((c) => ({ ...c, acronyms: [...c.acronyms] }));
}

/** At most three searches a team: they are run by hand, a minute apart. */
export function searches(company, c) {
  const q = [];
  for (const a of c.acronyms) q.push(`site:linkedin.com/posts "${company}" "${a}" hiring`);
  const team = c.short || c.team;
  if (team) {
    q.push(`site:linkedin.com/posts "${company}" "${team}" hiring`);
    // A one-word team ("Robot") is no name without the company beside it.
    q.push(team.includes(' ') ? `site:linkedin.com/posts "${team}" "my team"` : `site:linkedin.com/posts "${company}" "${team}" "my team"`);
  }
  q.push(`site:linkedin.com/posts "${company}" "${c.role}" hiring`);
  // Never "<role>" "my team" alone: every company has a Mechanical Engineer.
  q.push(`site:linkedin.com/posts "${company}" "${c.role}" ("my team" OR "join us")`);
  return [...new Set(q)].slice(0, 3);
}

/**
 * Once per company, not per team: a new hire announcing the team they just
 * joined. Chris Moreno's OpenAI post ("I recently joined OpenAI Robotics …
 * we should talk. Open roles below.") named seven of the roles he applied to
 * and no team search found it (F-783).
 */
export function companySearches(company) {
  return [
    `site:linkedin.com/posts "joined ${company}" "open roles"`,
    `site:linkedin.com/posts "joined ${company}" hiring`,
  ];
}

export const googleUrl = (q) => `https://www.google.com/search?hl=en&num=20&tbs=qdr:y&q=${encodeURIComponent(q)}`;
export const braveUrl = (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&tf=py`;

/**
 * Run on a Google or Brave results page. Returns post SLUGS only: a tool
 * output holding full links with query strings is withheld by the browser
 * extension, and post-leads.mjs takes slugs.
 */
export const EXTRACT = `(() => {
  if (/sorry|captcha|challenge/i.test(location.pathname + document.title)) return 'CHALLENGE: this engine wants a CAPTCHA; switch engines or wait';
  const slugs = [...document.querySelectorAll('a[href*="linkedin.com/posts/"]')]
    .map((a) => (a.href.match(/linkedin\\.com\\/posts\\/([^?#&"]+)/) || [])[1]).filter(Boolean);
  const uniq = [...new Set(slugs.map((s) => decodeURIComponent(s)))];
  return uniq.length ? uniq.join('\\n') : 'NONE';
})()`;

/**
 * Run the searches in HIS Opera (2026-10-05, his setup item 2): a background
 * Google tab per search, the EXTRACT snippet, the tab closed, a pause between
 * searches (Google CAPTCHAs a burst for hours). A CHALLENGE stops every
 * remaining search — it is never solved. Google only: nothing here opens
 * LinkedIn. Returns { slugs per cluster key, stopped }.
 */
export async function runSearches(cdp, plan, { pauseMs = 60000, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const found = {};
  let first = true;
  for (const { key, queries } of plan) {
    found[key] = [];
    for (const q of queries) {
      if (!first) await sleep(pauseMs);
      first = false;
      const { targetId } = await cdp.send('Target.createTarget', { url: googleUrl(q), background: true });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      let out = '';
      for (let i = 0; i < 20 && !out; i++) {
        await sleep(1000);
        const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `document.readyState === 'complete' ? ${EXTRACT} : ''` }, sessionId).catch(() => null);
        out = r?.result?.value || '';
      }
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      if (/^CHALLENGE/.test(out)) { log(`  ${q}\n    Google wants a CAPTCHA: stopping every search (never solved; it clears in hours)`); return { found, stopped: true }; }
      const slugs = out && out !== 'NONE' ? out.split('\n') : [];
      log(`  ${q}\n    ${slugs.length ? `${slugs.length} post${slugs.length > 1 ? 's' : ''}` : 'none'}`);
      found[key].push(...slugs.filter((s) => !found[key].includes(s)));
    }
  }
  return { found, stopped: false };
}

async function main() {
  guardArgs({ usage: 'usage: node jarvis/post-search.mjs --company <name> [--run [--save] [--pause <seconds>]]', flags: ['--company', '--run', '--save', '--pause'], valued: ['--company', '--pause'] });
  const args = process.argv.slice(2);
  const company = args[args.indexOf('--company') + 1] || '';
  if (!company || company.startsWith('--')) { console.log('usage: node jarvis/post-search.mjs --company <name>'); return; }
  if (args.includes('--run')) {
    const { query } = await import('./store.mjs');
    const rows = ['applied', 'interested', 'queued', 'responded', 'interview']
      .flatMap((status) => query({ companyLike: company, status }, { limit: 200 }).rows).filter((j) => !j.goneAt);
    if (!rows.length) { console.log(`No open applications at ${company}.`); return; }
    const cs = clusters(rows);
    const plan = [{ key: '_joined', queries: companySearches(company) }, ...cs.map((c) => ({ key: c.key, queries: searches(company, c) }))];
    const { connect } = await import('./opera-fill.mjs');
    const cdp = await connect().catch((e) => { console.log(e.message); return null; });
    if (!cdp) { process.exitCode = 1; return; }
    const pause = Number(args.includes('--pause') ? args[args.indexOf('--pause') + 1] : 60) * 1000;
    console.log(`${plan.reduce((n, p) => n + p.queries.length, 0)} Google searches in Opera, ${pause / 1000}s apart`);
    const { found, stopped } = await runSearches(cdp, plan, { pauseMs: pause });
    cdp.close();
    const { spawnSync } = await import('node:child_process');
    for (const c of [{ key: '_joined', role: `new hires announcing ${company} teams`, jobs: [rows[0]] }, ...cs]) {
      const slugs = found[c.key] || [];
      console.log(`\n## ${c.team || c.role}: ${slugs.length} post${slugs.length === 1 ? '' : 's'}`);
      if (!slugs.length) continue;
      const cmd = ['jarvis/post-leads.mjs', ...slugs, '--job', c.jobs[0].id, ...(args.includes('--save') ? ['--save'] : [])];
      // post-leads reads every post at the source: the writer behind a
      // reshare becomes the lead, every post is dated, broadcasts are set aside.
      const r = spawnSync(process.execPath, cmd, { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8' });
      console.log((r.stdout || '') + (r.stderr || '').split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n'));
    }
    if (stopped) console.log('Stopped early at a CAPTCHA: rerun later for the searches that did not run.');
    return;
  }
  const { query } = await import('./store.mjs');
  const rows = ['applied', 'interested', 'queued', 'responded', 'interview']
    .flatMap((status) => query({ companyLike: company, status }, { limit: 200 }).rows)
    .filter((j) => !j.goneAt);
  if (!rows.length) { console.log(`No open applications at ${company}.`); return; }
  console.log(`\n## Anyone who just joined ${company} and is hiring (once for the company)`);
  for (const q of companySearches(company)) console.log(`   search: ${q}\n     google: ${googleUrl(q)}`);
  for (const c of clusters(rows)) {
    console.log(`\n## ${c.team || c.role}  (${c.jobs.length} application${c.jobs.length > 1 ? 's' : ''})`);
    for (const j of c.jobs) console.log(`   ${j.id}  ${j.title} | ${j.location || ''}`);
    for (const q of searches(company, c)) console.log(`   search: ${q}\n     google: ${googleUrl(q)}\n     brave:  ${braveUrl(q)}`);
  }
  console.log(`\nOn each results page run:\n${EXTRACT}\nthen: node jarvis/post-leads.mjs <slug…> --job <one job id of that team> --save`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
