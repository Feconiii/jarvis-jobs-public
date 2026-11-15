// jarvis/refusals.mjs — a site that refuses us is asked again later, not now.
//
// A 403 is a refusal, never a strike against the posting (F-429): the row is
// retried. But nothing remembered WHICH site refused, so every enrich run asked
// a refusing Workday tenant again (Caterpillar, HPE, Abbott, 2026-11-03),
// spending the shared Workday allowance (1,500 a day across every tenant) on
// answers that were always 403 while tenants that answer waited behind them.
//
// Per site (the hostname, so one Workday tenant never costs the others):
//   - REFUSALS_TO_COOL refusals in one run and no answer → a cooldown,
//     6 hours, doubling each time it happens again, at most 7 days.
//   - While cooling, the site's rows are skipped like rows paced out for the
//     day: untouched, no strike, never labelled "no body".
//   - Every night (00:00-05:59 on this machine) a cooling site gets
//     NIGHT_PROBES requests anyway, so a site that reopens is found without
//     waiting out the whole cooldown.
//   - One real answer clears the record.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

export const REFUSALS_TO_COOL = 3;
export const BASE_COOL_MS = 6 * 3_600_000;
export const MAX_COOL_MS = 7 * 86_400_000;
export const NIGHT_PROBES = 10;

/** Statuses that are the site refusing us by policy (not a rate limit, not an outage). */
export const isPolicyRefusal = (status) => status === 403 || status === 405;

// One host serving many employers' boards (review, 2026-11-03): one board
// refusing must not cool every other board on it, so the board token is part
// of the key. A Workday tenant, an iCIMS subdomain or an employer's own site
// already is its own host.
const SHARED_HOSTS = [
  [/^boards-api\.greenhouse\.io$/, /^\/v1\/boards\/([^/]+)/],
  [/^(?:job-boards|boards)\.greenhouse\.io$/, /^\/([^/]+)/],
  [/^api\.lever\.co$/, /^\/v0\/postings\/([^/]+)/],
  [/^jobs\.lever\.co$/, /^\/([^/]+)/],
  [/^api\.ashbyhq\.com$/, /^\/posting-api\/job-board\/([^/]+)/],
  [/^jobs\.ashbyhq\.com$/, /^\/([^/]+)/],
  [/^api\.smartrecruiters\.com$/, /^\/v1\/companies\/([^/]+)/],
  [/^jobs\.smartrecruiters\.com$/, /^\/([^/]+)/],
  [/^apply\.workable\.com$/, /^\/(?:api\/v\d+\/accounts\/)?([^/]+)/],
  [/^[\w-]+\.myworkdaysite\.com$/, /^\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:recruiting|wday\/cxs)\/([^/]+)/],
];
export function hostKey(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  for (const [h, p] of SHARED_HOSTS) {
    if (!h.test(host)) continue;
    const m = p.exec(u.pathname);
    return m ? `${host}/${m[1].toLowerCase()}` : host;
  }
  return host;
}

export const refusalsPath = (storeDir) => path.join(storeDir, 'enrich-refusals.json');

export function loadRefusals(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
export function saveRefusals(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

const nightOf = (t) => {
  const d = new Date(t);
  return d.getHours() < 6 ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : null;
};

/**
 * One run's gate over a saved state. `now` is injectable for tests.
 * allow(url) before a request; answered(url) / refused(url) after it;
 * finish() returns the state to save and what changed.
 */
export function makeRefusalGate(state = {}, { now = () => Date.now() } = {}) {
  const s = structuredClone(state);
  const run = new Map();   // host -> { refused, answered, probing }
  const seen = (h) => { if (!run.has(h)) run.set(h, { refused: 0, answered: 0, probing: false }); return run.get(h); };
  return {
    allow(url) {
      const h = hostKey(url);
      const e = h && s[h];
      if (!e || !e.until || now() >= Date.parse(e.until)) return true;
      const night = nightOf(now());
      if (!night) return false;
      if (e.probeNight !== night) { e.probeNight = night; e.probes = 0; }
      if ((e.probes || 0) >= NIGHT_PROBES) return false;
      e.probes = (e.probes || 0) + 1;
      seen(h).probing = true;
      return true;
    },
    cooling(url) {
      const e = s[hostKey(url)];
      return !!(e?.until && now() < Date.parse(e.until));
    },
    answered(url) { const h = hostKey(url); if (h) seen(h).answered++; },
    refused(url) { const h = hostKey(url); if (h) seen(h).refused++; },
    finish() {
      const cooled = [], cleared = [];
      for (const [h, r] of run) {
        if (r.answered > 0) { if (s[h]) { delete s[h]; cleared.push(h); } continue; }
        // A night probe that is refused leaves the cooldown as it was: only a
        // site asked in the ordinary way escalates (review, 2026-11-03).
        if (r.probing) continue;
        if (r.refused < REFUSALS_TO_COOL) continue;
        const times = (s[h]?.times || 0) + 1;
        const ms = Math.min(BASE_COOL_MS * 2 ** (times - 1), MAX_COOL_MS);
        s[h] = { ...(s[h] || {}), times, refusedLastRun: r.refused, since: s[h]?.since || new Date(now()).toISOString(), until: new Date(now() + ms).toISOString() };
        cooled.push({ host: h, times, until: s[h].until });
      }
      return { state: s, cooled, cleared };
    },
  };
}
