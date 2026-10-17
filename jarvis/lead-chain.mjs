/**
 * ONE LEAD LEADS TO THE NEXT (2026-10-05, his rule: "from one lead read the
 * posts and identify more leads ... that way you dont have to scrape every
 * soul on the planet ... its more of a quirk that we can use").
 *
 *   node jarvis/lead-chain.mjs --from <profile url,…> --job <id> [--save]
 *
 * For each lead already found, opens THAT person's recent activity in his
 * Opera (one page, a background tab, closed after), lifts the posts on it —
 * their own and the ones they reposted — and hands them to post-leads.mjs,
 * which reads each post at the source: the writer behind every repost becomes
 * a lead, every post is dated, company pages and broadcasts are set aside.
 * Riley's activity is how Devin Shah and Kai Ortiz surface.
 *
 * Bounds (OUTREACH.md §2a as he amended it, 2026-10-05): only the activity
 * page of a person already a lead, named on the command line, run from a
 * session on his word; one page per lead, nothing scrolled, no search on
 * LinkedIn, nothing typed or pressed, never on a schedule.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { guardArgs } from './cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The activity page of a profile URL. */
export function activityUrl(profile) {
  const m = String(profile).match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? `https://www.linkedin.com/in/${m[1]}/recent-activity/all/` : '';
}

/**
 * Run on the activity page: every post on it, the person's and the ones they
 * reposted, as "kind:id". LinkedIn's 2026 layout names posts urn:li:share and
 * urn:li:ugcPost (Riley's page, 2026-10-05: 5 share, 2 ugcPost, no activity).
 */
export const ACTIVITY_IDS = `(() => {
  const ids = new Set();
  for (const m of document.documentElement.outerHTML.matchAll(/urn:li:(activity|share|ugcPost):(\\d{15,})/g)) ids.add(m[1] + ':' + m[2]);
  return [...ids].slice(0, 25).join(',');
})()`;

export async function postsOf(cdp, profile) {
  const url = activityUrl(profile);
  if (!url) return [];
  const { targetId } = await cdp.send('Target.createTarget', { url, background: true });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    let ids = '';
    for (let i = 0; i < 24 && !ids; i++) {
      await sleep(750);
      const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `document.readyState === 'complete' ? ${ACTIVITY_IDS} : ''` }, sessionId).catch(() => null);
      ids = r?.result?.value || '';
    }
    return ids ? ids.split(',').map((id) => `https://www.linkedin.com/feed/update/urn:li:${id}/`) : [];
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function main() {
  guardArgs({ usage: 'usage: node jarvis/lead-chain.mjs --from <profile url,…> --job <id> [--save]', flags: ['--from', '--job', '--save'], valued: ['--from', '--job'] });
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  const from = opt('--from').split(',').map((s) => s.trim()).filter((u) => /linkedin\.com\/in\//.test(u));
  if (!from.length || !opt('--job')) { console.log('usage: node jarvis/lead-chain.mjs --from <profile url,…> --job <id> [--save]'); process.exitCode = 1; return; }
  const { connect } = await import('./opera-fill.mjs');
  const cdp = await connect().catch((e) => { console.log(e.message); return null; });
  if (!cdp) { process.exitCode = 1; return; }
  const posts = [];
  for (const p of from) {
    const found = await postsOf(cdp, p).catch((e) => { console.log(`${p}: ERROR ${e.message}`); return []; });
    console.log(`${p.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '')}: ${found.length} post${found.length === 1 ? '' : 's'} on the activity page`);
    posts.push(...found.filter((u) => !posts.includes(u)));
  }
  cdp.close();
  if (!posts.length) return;
  // post-leads reads each at the source and credits the WRITER of every repost.
  const r = spawnSync(process.execPath, ['jarvis/post-leads.mjs', ...posts, '--job', opt('--job'), ...(args.includes('--save') ? ['--save'] : [])], { cwd: ROOT, encoding: 'utf8' });
  console.log((r.stdout || '') + (r.stderr || '').split('\n').filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
