#!/usr/bin/env node
// jarvis/import-assist.mjs — import a browser-assisted harvest into the store.
//
// SUSTAINABILITY CONTRACT: some careers sites (Tesla) refuse non-browser HTTP
// but serve their listings JSON happily to the user's own browser session.
// The standing routine — runnable on demand or by an improvement-loop session
// with browser access — is:
//
//   1. Jarvis (agent) opens the careers site in the user's Chrome.
//   2. In-page JS reads the site's own listings JSON (the exact request the
//      page itself makes) and triggers a download of normalized rows.
//   3. This script imports the file: triage + upsert + scan-coverage record.
//
// Row format (JSON array of arrays or objects):
//   [title, id_or_url, location, team?]   or   {title, url, location, team}
//
// Usage:
//   node jarvis/import-assist.mjs <file.json> --company Tesla \
//     --url-template "https://www.tesla.com/careers/search/job/{slug}-{id}" \
//     [--sponsors] [--tier watchlist]

import { readFileSync } from 'fs';
import { upsertJobs, recordScan, count } from './store.mjs';
import { triage } from './triage.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const get = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
const company = get('--company');
const urlTemplate = get('--url-template') || '';
const sponsors = args.includes('--sponsors');
const tier = get('--tier') || 'tracked';

if (!file || !company) {
  console.error('Usage: node jarvis/import-assist.mjs <file.json> --company <Name> [--url-template ...] [--sponsors] [--tier watchlist]');
  process.exit(1);
}

const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const rows = JSON.parse(readFileSync(file, 'utf-8'));

const jobs = rows.map(r => {
  const o = Array.isArray(r)
    ? { title: r[0], idOrUrl: String(r[1] ?? ''), location: r[2] || '', team: r[3] || '' }
    : { title: r.title, idOrUrl: String(r.url || r.id || ''), location: r.location || '', team: r.team || '' };
  if (!o.title) return null;
  const url = o.idOrUrl.startsWith('http')
    ? o.idOrUrl
    : urlTemplate.replace('{slug}', slug(o.title)).replace('{id}', o.idOrUrl);
  if (!url.startsWith('http')) return null;
  return {
    url,
    title: o.title,
    company,
    team: o.team,
    location: o.location,
    source: 'browser-assist',
    company_meta: { tier, careers_url: '', sponsors_h1b: sponsors },
    triage: triage({ title: o.title, description: '', location: o.location, url: o.url }),
  };
}).filter(Boolean);

const { added, updated } = upsertJobs(jobs);
recordScan({
  at: new Date().toISOString(),
  companiesScanned: 1, companiesNeedingAssist: 0,
  postingsCaptured: jobs.length, added, updated,
  perCompany: [{ company, tier, provider: 'browser-assist', status: 'ok', found: jobs.length, note: 'Assisted scan via user browser session.' }],
});
console.log(`${company}: imported ${jobs.length} rows → +${added} new, ${updated} refreshed (store: ${count()})`);
