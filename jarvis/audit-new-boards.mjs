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
import { discovery } from './targeting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
  node jarvis/audit-new-boards.mjs --since <older portals.yml> [--json]
  node jarvis/audit-new-boards.mjs --all [--json]     every enabled board, not only new ones

  For every company tracked now and not in the older file, read the titles the
  scanner captured and flag boards with no engineering work on them, agency
  wording (W2, C2C), software/IT-only engineering, a one-word name whose board
  is all abroad, and BambooHR's placeholder demo board.
`;

/**
 * Titles that mean the company employs the person's role family at all
 * (hardware preset: makes or runs physical things). Deliberately wide. From
 * the preset, as is the narrower field test below it.
 */
export const ENGINEERING_RE = discovery.auditFamilyRe;

/** Titles that are the person's field specifically: a same-name board of another kind has none. */
export const HARDWARE_TITLE_RE = discovery.auditFieldRe;
/** Titles that mean the board belongs to an agency or a sales floor. */
export const AGENCY_RE =/\((?:confidential)\)|\bconfidential\b|\bour client\b|\baccount executive\b|\brecruit(?:er|ing|ment)\b|\bstaffing\b/i;

/**
 * Words only a staffing agency puts in a TITLE (F-635). PDDN INC. titled every
 * posting "… W2 Hiring", "Remote W2 Hiring", "Genuine Candidates Only"; no
 * employer advertises its own tax-form arrangement. Field-neutral.
 */
export const STAFFING_MARK_RE = /\bw-?2\b|\bc2c\b|\bcorp[- ]to[- ]corp\b|\bc2h\b|\bimmediate (?:hiring|joiners?|start)\b|\bgenuine (?:candidates?|profiles?|applicants?)\b|\bh-?1b transfer\b|\b(?:usc|gc)\s*(?:\/|&|and)\s*(?:gc|usc|ead)\b/i;

/** Software/IT titles, and the field words that outrank them (from the preset; unset = no such test). */
export const OFF_FIELD_RE = discovery.auditOffFieldRe || null;
export const STRONG_FIELD_RE = discovery.auditStrongFieldRe || null;

/** Is this title the person's field — and not an IT title that happens to share a word with it? */
export function isFieldTitle(t) {
  if (!HARDWARE_TITLE_RE.test(t)) return false;
  if (OFF_FIELD_RE && OFF_FIELD_RE.test(t) && !(STRONG_FIELD_RE && STRONG_FIELD_RE.test(t))) return false;
  return true;
}

/**
 * The demo board BambooHR serves under unclaimed-looking subdomains (F-637):
 * posting #15 "IT Security Engineer" in Mayfair, London. Read from the store's
 * rows, so a tracked board already serving it is caught by the audit.
 */
export function isBambooPlaceholderRow(r) {
  return /\.bamboohr\.com\/careers\/15(?:\b|$)/i.test(String(r?.url || ''))
    && /^IT Security Engineer$/i.test(String(r?.title || '').trim())
    && /mayfair/i.test(String(r?.location || ''));
}

/** "Deploy", "Swish", "Lark": a single word, which many companies share. */
export function isOneWordName(name) {
  const words = String(name || '').replace(/[,.]/g, ' ').trim().split(/\s+/)
    .filter(w => w && !/^(?:inc|llc|ltd|co|corp|corporation|company|gmbh|plc|ai|labs?|hq)$/i.test(w));
  return words.length === 1;
}

/**
 * Judge one board from its titles. Pure, so the tests need no store.
 * @param {Array<string|{title:string, location?:string, bucket?:string, url?:string}>} postings
 *   titles, or store rows (title, location, location_bucket as `bucket`, url)
 * @param {{name?: string}} [opts]  the company name it is tracked under
 * @returns {{verdict:'ok'|'suspect'|'unscanned', engineering:number, agency:number, total:number, why:string}}
 */
export function judgeBoard(postings, { name = '' } = {}) {
  const rows = (postings || []).map(p => (typeof p === 'string' ? { title: p } : { ...p, title: String(p?.title || '') }));
  const titles = rows.map(r => r.title);
  const total = titles.length;
  if (!total) return { verdict: 'unscanned', engineering: 0, agency: 0, total, why: 'no postings captured yet' };
  const engineering = titles.filter(t => ENGINEERING_RE.test(t)).length;
  const agency = titles.filter(t => AGENCY_RE.test(t)).length;
  const share = engineering / total;
  const oneWord = isOneWordName(name);
  // BambooHR's placeholder board is nobody's careers site (F-637).
  if (rows.some(isBambooPlaceholderRow)) return { verdict: 'suspect', engineering, agency, total, why: 'BambooHR\'s placeholder demo board (#15 "IT Security Engineer", Mayfair) — not this company\'s careers site' };
  // Staffing-agency wording in the titles themselves (F-635). Two are enough:
  // no employer writes "W2" or "Genuine Candidates Only" into its own title.
  const marks = titles.filter(t => STAFFING_MARK_RE.test(t)).length;
  // A share as well as a count: Bosch (9,666 postings) and Stripe carry a few
  // "Immediate Start" lines among thousands of their own.
  if ((marks >= 2 && marks / total >= 0.2) || (marks >= 1 && total <= 2)) return { verdict: 'suspect', engineering, agency: Math.max(agency, marks), total, why: `${marks} of ${total} titles carry staffing-agency wording (W2, C2C, "Immediate Hiring", "Genuine Candidates")` };
  // At least three: every company hires a recruiter, and one "Recruiting
  // Coordinator" on a three-posting board is not an agency.
  // …and more of them than engineers. Orchard Robotics was flagged on its first
  // real run for having a sales team beside its robotics engineers.
  if (agency >= 3 && agency / total >= 0.25 && agency > engineering) return { verdict: 'suspect', engineering, agency, total, why: `${agency} of ${total} titles read like an agency or a sales floor` };
  // Three postings with no engineer among them is a small company hiring an
  // office manager. Thirty is a different kind of company.
  // A one-word name is a coin flip (Swish → Orlando event sales), so its board
  // is held to the lower bar: three postings with no engineer among them.
  if ((total >= 8 || (oneWord && total >= 3)) && share < 0.1) return { verdict: 'suspect', engineering, agency, total, why: discovery.auditNoFamilyWhy(engineering, total) };
  // ENGINEERS, BUT NOT ONE IN HARDWARE (2026-10-02, F-657b). The checks
  // above pass a same-name SOFTWARE company — "engineer" is half of every
  // startup's board — and discovery only ever went looking for hardware
  // employers. 256 of 1,772 discovered boards had six or more postings and no
  // mechanical, manufacturing, robotics, test or equipment title at all.
  // An IT title sharing a word with the field ("Software Test Engineer",
  // "Production Support") no longer counts as the field (F-635, TestingXperts).
  const hardware = titles.filter(isFieldTitle).length;
  if (total >= 6 && hardware === 0) return { verdict: 'suspect', engineering, agency, total, why: discovery.auditNoFieldWhy(total, engineering) };
  // A SMALL board whose every engineering title is software or IT (F-635:
  // Termius, Lark, &AI, Nowadays — "Software Engineer" and "Product Engineer"
  // read as engineering). Two such titles and none of the field is enough;
  // an ambiguous "Founding Engineer" keeps the board out of this test.
  if (OFF_FIELD_RE && hardware === 0 && engineering >= 2
    && titles.filter(t => ENGINEERING_RE.test(t)).every(t => OFF_FIELD_RE.test(t))) {
    return { verdict: 'suspect', engineering, agency, total, why: discovery.auditOnlyOffFieldWhy ? discovery.auditOnlyOffFieldWhy(engineering, total) : discovery.auditNoFieldWhy(total, engineering) };
  }
  // A ONE-WORD NAME ON A BOARD WITH NOTHING IN THE US (F-635). "Deploy", a YC
  // hardware seed, resolved to a Belgrade web agency on deploy.bamboohr.com.
  // A namesake abroad is the likeliest reading; a person decides.
  if (oneWord) {
    const placed = rows.filter(r => r.bucket === 'us' || r.bucket === 'remote' || r.bucket === 'non-us');
    // Most of the board has to be placed: an iCIMS board with no locations and
    // three foreign ones (Walbridge, EaglePicher) says nothing about the rest.
    if (placed.length >= 2 && placed.length >= total / 2 && placed.every(r => r.bucket === 'non-us')) {
      const where = [...new Set(placed.map(r => String(r.location || '').split(',')[0].trim()).filter(Boolean))].slice(0, 3).join(', ');
      return { verdict: 'suspect', engineering, agency, total, why: `every posting is outside the US (${where || 'abroad'}) — a one-word name may have resolved to a namesake` };
    }
  }
  return { verdict: 'ok', engineering, agency, total, why: '' };
}

function trackedNames(file) {
  const cfg = yaml.load(readFileSync(file, 'utf8')) || {};
  return (cfg.tracked_companies || []).filter(c => c && c.enabled !== false).map(c => c.name).filter(Boolean);
}

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: ['--since', '--json', '--all'], valued: ['--since'], argv });
  const i = args.indexOf('--since');
  const all = args.includes('--all');
  if (!all && (i === -1 || !args[i + 1])) { console.error(USAGE); return 1; }
  const before = all ? new Set() : new Set(trackedNames(path.resolve(args[i + 1])));
  const added = trackedNames(path.join(ROOT, 'portals.yml')).filter(n => !before.has(n));

  const { db } = await import('./store.mjs');
  const q = db().prepare('SELECT title, location, location_bucket AS bucket, url FROM jobs WHERE company = ? AND gone_at IS NULL');
  const rows = added.map(name => {
    const postings = q.all(name);
    return { name, ...judgeBoard(postings, { name }), sample: postings.slice(0, 4).map(p => p.title) };
  });

  if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return 0; }
  const suspect = rows.filter(r => r.verdict === 'suspect');
  const unscanned = rows.filter(r => r.verdict === 'unscanned');
  console.log(`\n  ${added.length} ${all ? 'enabled boards' : 'companies added'}.${rows.length - suspect.length - unscanned.length} read as real ${discovery.auditOkNoun}, ${suspect.length} suspect, ${unscanned.length} not scanned yet.\n`);
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
