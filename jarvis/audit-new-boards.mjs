#!/usr/bin/env node
// jarvis/audit-new-boards.mjs — read the titles on boards that were just added.
//
// WHY THIS EXISTS
// ───────────────
// discover-ats resolves a company NAME to a board by guessing slugs, and a name
// is not an identity (F-505, F-508, F-509): "Figure" was a crypto lender,
// "Headway" a mental-health company, "Raydar" a recruiting agency with 186 live
// postings. Every one of those boards answered, was live, and passed the probe.
// What gave each of them away was the same thing every time — somebody read the
// titles. At twenty companies a person can do that. At a thousand, nobody does,
// so this does: for every company added to portals.yml since a saved copy, it
// reads what the scanner captured and reports the boards where nothing looks
// like engineering work.
//
// It changes nothing. Disabling an entry is a decision about a company, and the
// output is the list to make it from.
//
// Usage:
//   node jarvis/audit-new-boards.mjs --since data/jarvis/harvests/portals.before.yml
//   node jarvis/audit-new-boards.mjs --since <file> --json

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { guardArgs } from './cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
  node jarvis/audit-new-boards.mjs --since <older portals.yml> [--json]

  For every company tracked now and not in the older file, read the titles the
  scanner captured and flag boards with no engineering work on them.
`;

/** Titles that mean a company makes or runs physical things. Deliberately wide. */
export const ENGINEERING_RE = /\b(?:engineer(?:ing)?|technician|machinist|mechanic(?:al)?|robotic|mechatronic|manufactur|hardware|firmware|embedded|electrical|controls?|automation|cad\b|designer|r&d|scientist|metrology|welder|assembler|fabricat|tooling|npi\b|quality|test\b|reliability|process|avionics|propulsion|thermal|optic|semiconductor|wafer)/i;

/** Titles that mean the board belongs to an agency or a sales floor. */
export const AGENCY_RE = /\((?:confidential)\)|\bconfidential\b|\bour client\b|\baccount executive\b|\brecruit(?:er|ing|ment)\b|\bstaffing\b/i;

/**
 * Judge one board from its titles. Pure, so the tests need no store.
 * @param {string[]} titles
 * @returns {{verdict:'ok'|'suspect'|'unscanned', engineering:number, agency:number, total:number, why:string}}
 */
export function judgeBoard(titles) {
  const total = titles.length;
  if (!total) return { verdict: 'unscanned', engineering: 0, agency: 0, total, why: 'no postings captured yet' };
  const engineering = titles.filter(t => ENGINEERING_RE.test(t)).length;
  const agency = titles.filter(t => AGENCY_RE.test(t)).length;
  const share = engineering / total;
  // At least three: every company hires a recruiter, and one "Recruiting
  // Coordinator" on a three-posting board is not an agency.
  // …and more of them than engineers. Orchard Robotics was flagged on its first
  // real run for having a sales team beside its robotics engineers.
  if (agency >= 3 && agency / total >= 0.25 && agency > engineering) return { verdict: 'suspect', engineering, agency, total, why: `${agency} of ${total} titles read like an agency or a sales floor` };
  // Three postings with no engineer among them is a small company hiring an
  // office manager. Thirty is a different kind of company.
  if (total >= 8 && share < 0.1) return { verdict: 'suspect', engineering, agency, total, why: `${engineering} of ${total} titles are engineering or technical work` };
  return { verdict: 'ok', engineering, agency, total, why: '' };
}

function trackedNames(file) {
  const cfg = yaml.load(readFileSync(file, 'utf8')) || {};
  return (cfg.tracked_companies || []).filter(c => c && c.enabled !== false).map(c => c.name).filter(Boolean);
}

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: ['--since', '--json'], valued: ['--since'], argv });
  const i = args.indexOf('--since');
  if (i === -1 || !args[i + 1]) { console.error(USAGE); return 1; }
  const before = new Set(trackedNames(path.resolve(args[i + 1])));
  const added = trackedNames(path.join(ROOT, 'portals.yml')).filter(n => !before.has(n));

  const { db } = await import('./store.mjs');
  const q = db().prepare('SELECT title FROM jobs WHERE company = ? AND gone_at IS NULL');
  const rows = added.map(name => {
    const titles = q.all(name).map(r => r.title);
    return { name, ...judgeBoard(titles), sample: titles.slice(0, 4) };
  });

  if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return 0; }
  const suspect = rows.filter(r => r.verdict === 'suspect');
  const unscanned = rows.filter(r => r.verdict === 'unscanned');
  console.log(`\n  ${added.length} companies added. ${rows.length - suspect.length - unscanned.length} read as real engineering employers, ${suspect.length} suspect, ${unscanned.length} not scanned yet.\n`);
  for (const r of suspect) {
    console.log(`  ⚠ ${r.name} — ${r.why}`);
    console.log(`      ${r.sample.join(' · ')}`);
  }
  if (unscanned.length) console.log(`\n  Not scanned yet: ${unscanned.slice(0, 30).map(r => r.name).join(', ')}${unscanned.length > 30 ? ` … +${unscanned.length - 30}` : ''}`);
  console.log('');
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
