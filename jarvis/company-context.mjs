/**
 * WHAT JARVIS ALREADY KNOWS ABOUT THE COMPANY, handed to the answer writer.
 *
 * Alex, 2026-09-16: "If relevant context already exists in Jarvis, retrieve it
 * automatically before drafting. The user should not have to manually remind
 * you of the job, company, or their own experience every time."
 *
 * The posting was the only thing the writer knew about the employer. The store
 * knows more: the team on the row, the field the posting was classified into,
 * his own notes on the company in portals.yml, and every other role the company
 * has open — which says what they are building and how big they are better
 * than any one posting does.
 *
 * All of it is CONTEXT FOR CHOOSING, never a source of claims. His notes are
 * his job-search notes (sponsorship, sites, which entity to avoid) and none of
 * that belongs in a box a recruiter reads.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { db } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTALS = path.join(HERE, '..', 'portals.yml');

let portalsCache = null;
function trackedCompanies() {
  if (portalsCache) return portalsCache;
  try { portalsCache = yaml.load(readFileSync(PORTALS, 'utf-8'))?.tracked_companies || []; } catch { portalsCache = []; }
  return portalsCache;
}

const core = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The brief, as plain lines. Pure: everything it reads is passed in, so the
 * shape can be tested without a store.
 */
export function companyBrief({ job = null, tracked = null, others = [] } = {}) {
  if (!job?.company) return '';
  const lines = [];
  const entry = (tracked || []).find((c) => core(c?.name) === core(job.company));
  if (job.team) lines.push(`Team on the posting: ${job.team}`);
  const field = job.fit?.field || job.field;
  if (field && field !== 'other') lines.push(`Field Jarvis filed this posting under: ${field}`);
  if (entry?.notes) lines.push(`His own notes on this company (context only, never content for the box): ${String(entry.notes).slice(0, 500)}`);
  const titles = [...new Set(others.map((o) => String(o.title || '').trim()).filter(Boolean))];
  if (titles.length) {
    lines.push(`Open roles Jarvis has seen at ${job.company}: ${others.length}${others.length >= 200 ? '+' : ''}. A sample, which shows what they are building and hiring for:`);
    lines.push(...titles.slice(0, 12).map((t) => `  - ${t}`));
  }
  const teams = [...new Set(others.map((o) => String(o.team || '').trim()).filter(Boolean))];
  if (teams.length > 1) lines.push(`Teams hiring there: ${teams.slice(0, 10).join(', ')}`);
  return lines.join('\n');
}

/** The brief for one posting, read from the store and portals.yml. Never throws. */
export function loadCompanyBrief(job) {
  if (!job?.company) return '';
  let others = [];
  try {
    others = db().prepare(`SELECT title, team FROM jobs
      WHERE company = ? AND id != ? AND gone_at IS NULL AND COALESCE(f_intern, 0) = 0
      ORDER BY fit_score DESC LIMIT 200`).all(String(job.company), String(job.id || ''));
  } catch { others = []; }
  try { return companyBrief({ job, tracked: trackedCompanies(), others }); } catch { return ''; }
}
