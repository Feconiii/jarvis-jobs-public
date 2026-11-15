#!/usr/bin/env node
/**
 * THE WHOLE LIBRARY, SCREENED WITHOUT A MODEL (2026-11-03, F-958).
 *
 * "The library literally never runs dry." On 2026-11-02 the daily search and a
 * session both stopped at "read out" after reading ~880 of ~1.0M open rows: the
 * READ WINDOW was dry (fit 70+, 45 days, four per company, the taste gate,
 * bodyless rows leading every batch), not the store. This screens every open
 * row against his hard rules, using only the rules the ranker and the reader
 * already apply — nothing new is invented here:
 *
 *   stored flags   f_hard_block (visa classifier), fit_blocked (preferences.md),
 *                  f_senior, f_intern, f_grad_mismatch, location bucket, Easy Apply
 *   employer       hidden companies, capped employers, employers he ruled out
 *   title          the curator's title list, another discipline's title
 *   body           prescreen.mjs (years with no way in, discipline), exportBar
 *                  (ITAR / U.S. person), eligibility.mjs (degree level and
 *                  subject), preferences applied to the body (shifts…), the pay
 *                  floor, his employer taste (employerVerdict)
 *
 * A row with no body to read is NOT a survivor and NOT a drop: it is counted as
 * "waiting on a body", the number that says what the enricher owes.
 *
 * Verdicts go to data/jarvis/screen.db, one per row, keyed by what the verdict
 * depends on (title, company, body length and read time, fit, the rules
 * version), so a rerun only touches new or changed rows. Rows are streamed in
 * chunks by rowid: the store is ~1.0M rows and the machine has under 1 GB free.
 *
 * Usage:
 *   node jarvis/library-screen.mjs                 screen what changed, print the removal table
 *   node jarvis/library-screen.mjs --all           screen every open row again
 *   node jarvis/library-screen.mjs --survivors 40  list the best survivors
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDb, readDescription, getDictionary } from './db.mjs';
import { exportBar, isThinBody, disciplineMiss, whereIsIt, learnedWhere, learnPlaces } from './picks.mjs';
import { eligibility } from './eligibility.mjs';
import { loadPrefs, applyPrefs } from './prefs.mjs';
import { prescreen } from './prescreen.mjs';
import { titleOut, employerClass, employerVerdict, CAPPED } from './employer-taste.mjs';
import { htmlToText } from './text.mjs';
import { classifyExperience } from './triage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const DB_PATH = process.env.JARVIS_DB_PATH || path.join(process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data', 'jarvis'), 'jobs.db');
export const SCREEN_PATH = path.join(path.dirname(DB_PATH), 'screen.db');

/** Bump when a rule in this file changes, so every row is screened again. */
export const SCREEN_VERSION = 13;
/** The shortest body the reader is given (curate refuses under 400). */
export const SHORT_FLOOR = 400;
/** His pay floor (profile: $80K). A posted top under it fails everywhere. */
export const PAY_FLOOR = 80000;

/** The removal reasons, in the order the table prints them. */
export const STAGES = ['read-before', 'not-us', 'visa', 'his-rules', 'level', 'easy-apply', 'employer', 'title', 'years', 'clearance', 'degree', 'field', 'shift-or-rule', 'pay', 'waiting-body', 'short-at-source', 'survivor'];

/**
 * One row's verdict. Pure: the caller supplies the body text (or null) and the
 * context, so tests need no store.
 *
 * @returns { verdict: 'out'|'waiting'|'survivor', stage, reason }
 */
export function screenRow(row, text, ctx = {}) {
  const hidden = ctx.hidden || new Set();
  const rules = ctx.rules || null;
  const out = (stage, reason) => ({ verdict: 'out', stage, reason: String(reason || stage).slice(0, 300) });
  if (/^Not curated/.test(String(row.pick_note || ''))) return out('read-before', String(row.pick_note).slice(0, 200));
  // WHERE IT IS (audit, 2026-11-03): only a posting the bucketer placed abroad,
  // or whose own place says so, is "not-us". Remote rows are US unless the place
  // names another country; an unknown bucket is read again from the place
  // (states, then the cities the store has learned); a blank or unreadable place
  // is NOT a drop — it survives as "location unknown" and the reader reads the
  // body. Before, 98,506 unknown and 24,863 remote rows were dropped as abroad.
  const place = placeOf(row, ctx.places);
  if (place === 'elsewhere') return out('not-us', `${row.location_bucket || 'unknown'}: ${String(row.location || '').slice(0, 80)}`);
  if (row.f_hard_block) return out('visa', row.block_key || 'work-authorization block');
  if (row.fit_blocked) {
    // The rule that blocked it, re-read from his preferences for a title in his field.
    let why = 'blocked by his preferences';
    // The stored reasons first (fit_blockers, 2026-11-03); rows written before
    // the column re-read his preferences, as before.
    let stored = null;
    try { stored = row.fit_blockers ? JSON.parse(row.fit_blockers) : null; } catch { stored = null; }
    if (Array.isArray(stored) && stored.length) why = stored.join('; ');
    else if (rules && FIELD_TITLE.test(String(row.title || ''))) {
      try { const h = applyPrefs({ title: row.title, company: row.company, location: row.location }, rules)?.hard || []; if (h.length) why = h.join('; '); } catch { /* generic */ }
    }
    return out('his-rules', why);
  }
  if (row.f_senior) return out('level', 'senior title');
  if (row.f_intern) return out('level', 'internship / co-op');
  if (row.f_grad_mismatch) return out('level', 'graduation window excludes him');
  if (row.apply_route === 'easy-apply') return out('easy-apply', 'LinkedIn Easy Apply only');
  const co = String(row.company || '').toLowerCase().trim();
  if (hidden.has(co)) return out('employer', 'he hid this company');
  if (CAPPED && CAPPED.test(String(row.company || ''))) return out('employer', 'capped employer');
  if (employerClass(row.company) === 'out') return out('employer', 'an employer he ruled out');
  if (titleOut(row.title)) return out('title', 'title on the curator\'s out list');
  if (disciplineMiss(row.title)) return out('field', 'title names another discipline');
  // YEARS ARE READ FROM THE TEXT, never from the stored column alone (review,
  // 2026-11-03): "2+ years preferred" or "0-2 years" can store a 2. prescreen
  // reads the body below; a row without one waits for it.
  // Pay: a posted annual top under the floor (an hourly or missing figure is not judged here).
  if (row.salary_max && row.salary_max >= 20000 && row.salary_max < PAY_FLOOR) return out('pay', `posted top $${Math.round(row.salary_max / 1000)}K under the $80K floor`);
  const body = text == null ? '' : String(text);
  // A SHORT BODY THAT WILL NOT GET LONGER (F-979). The enricher reads a row
  // again only while its body is under 500 characters and it has never been
  // read in full; a body read in full, or already 500+ with no requirements
  // section, is all the posting says. Those used to wait forever (1,874 on
  // 11-04). From 400 characters (what the reader needs) they go on, marked low
  // confidence; under that they are counted as short at the source.
  let lowConfidence = '';
  if (body.length < 500 || isThinBody(body)) {
    const final = !!row.enriched_at || (row.desc_len || 0) >= 500;
    const stored = body.length || row.desc_len || 0;
    if (!body.length && (row.desc_len || 0) >= SHORT_FLOOR) return { verdict: 'waiting', stage: 'waiting-body', reason: `${row.desc_len} characters stored, not read yet` };
    if (!final) return { verdict: 'waiting', stage: 'waiting-body', reason: `${stored} characters stored` };
    if (stored < SHORT_FLOOR) return { verdict: 'waiting', stage: 'short-at-source', reason: `the posting itself says ${stored} characters` };
    lowConfidence = `low confidence: short at the source (${body.length} characters${isThinBody(body) ? ', no requirements section' : ''})`;
  }
  const pre = prescreen({ title: row.title, text: body, company: row.company });
  // prescreen's years line is held to the same ambiguity test (a level label the
  // title does not carry, "or equivalent", internships counting).
  if (pre && !(/years?/i.test(pre.why) && yearsAmbiguous({ evidence: [pre.why] }, body, row.title))) {
    return out(/years?/i.test(pre.why) ? 'years' : 'field', pre.why);
  }
  // The triage parser's own reading of the years (2026-11-03): a 'stretch'
  // level with 3+ years and no way in for a new graduate. prescreen.mjs misses
  // ladders and bare lines — "Bachelor's degree and at least 5 years",
  // "5 years of related experience with a Bachelor's", "4+ years of industry
  // experience" — that classifyExperience already reads (the first drain batch
  // of six were all these). A 2-year floor stays prescreen's call.
  // HIS LADDER RULE: a degree ladder is judged at the Bachelor's rung (his
  // brief, from KLA's "literally says bachelor with 5 years", 2026-11-02). A
  // zero-year PhD or MS rung is no way in for him.
  const rung = bachelorRungYears(body);
  if (rung != null && rung >= 3) return out('years', `the Bachelor's rung asks ${rung}+ years`);
  let exp = null;
  try { exp = classifyExperience(row.title, body); } catch { exp = null; }
  if (exp && exp.level === 'stretch' && Number(exp.years) >= 3 && !yearsAmbiguous(exp, body, row.title)) return out('years', `${exp.years}+ years with no way in: ${String(exp.evidence?.[0] || exp.note || '').slice(0, 200)}`);
  const bar = exportBar(row.title, body);
  if (bar) return out('clearance', `ITAR / U.S. person: ${bar}`);
  let el = null;
  try { el = eligibility(row, body); } catch { el = null; }
  if (el && el.verdict === 'not-eligible') {
    const why = (el.reasons || []).join('; ');
    return out(/master|ph\.?d|degree|subject/i.test(why) ? 'degree' : /itar|u\.?s\.?[\s-]person|citizen/i.test(why) ? 'clearance' : 'field', why);
  }
  if (rules) {
    let hard = [];
    try { hard = applyPrefs({ title: row.title, company: row.company, location: row.location, description: body }, rules)?.hard || []; } catch { hard = []; }
    if (hard.length) return out('shift-or-rule', hard.join('; '));
  }
  // HIS EMPLOYER TASTE RANKS, IT DOES NOT REMOVE (2026-11-03). Run as a gate it
  // took six of the night's seventeen hand-read picks (Ginkgo, Symbotic,
  // Peterbilt — a PACCAR company — Riverpoint, Allison, Geek+): the employer
  // lists are incomplete, and the reader judges "his kind of employer" with the
  // nuance his brief gives it. The verdict rides along as the reason.
  // HIS FIELD, BY THE CURATOR'S OWN FLOORS (2026-11-03). With a full body read,
  // fit under 55 (50 for new-grad wording) is the bar the daily search's widest
  // window already uses; without it the survivors were roadway, MEP, IT and
  // telecom postings at fit 60-69.
  const floor = row.f_newgrad ? 50 : 55;
  if (row.fit_score != null && row.fit_score < floor) return out('field', `fit ${row.fit_score} under the curator's floor of ${floor}`);
  const taste = ctx.taste === false ? null : employerVerdict(row, body);
  const notes = [place === 'unclear' ? 'location unknown — read the body for it' : '', taste ? `taste: ${taste}` : '', lowConfidence].filter(Boolean);
  return { verdict: 'survivor', stage: 'survivor', reason: notes.join(' · ') };
}

/**
 * DROP ONLY WHEN THE YEARS ARE UNAMBIGUOUS (review of 46021fe6, 2026-11-03).
 * Anything with "or equivalent", internships or co-ops counting toward the
 * years, an alternative degree path, or a level label the posting's own title
 * does not carry goes to the reader. Three or more years PREFERRED is not
 * ambiguous: his rule counts it as required ("if it says 3 yoe preferred 100%
 * it means mandatory").
 */
export function yearsAmbiguous(exp, body, title = '') {
  const ev = (exp?.evidence || []).join(' ');
  // A wish, not a requirement ("is a plus", "nice to have", "bonus", "desired",
  // "ideally"). "Preferred" with 3+ is NOT a wish: his rule counts it as required.
  // Not "3 plus years" (a number), and "ideally" only when it qualifies the
  // years themselves ("ideally 3+ years"), not the domain ("5+ years, ideally
  // on robotic systems").
  if (/\b(?:is|are|would\s+be|be)\s+(?:a\s+)?(?:big\s+|huge\s+|strong\s+)?plus\b|\ba\s+(?:big\s+|huge\s+|strong\s+)?plus\b|nice[\s-]to[\s-]have|\bbonus\b|\bdesired\b|\bdesirable\b|\bideally\b[^.;\n]{0,15}\d/i.test(ev)) return true;
  // His own rung is the Bachelor's: when it asks 3+ years, the other rungs
  // ("PhD, or MS with 2+, or BS with 4+") are no way in for him.
  if (/\b(?:bachelor'?s?|b\.?\s?s\.?|b\.?\s?sc)(?![a-z])[^;\n]{0,140}?\b(?:[3-9]|1\d)\s*\+?\s*(?:years?|yrs)\b|\b(?:[3-9]|1\d)\s*\+?\s*(?:years?|yrs)\b[^.;\n]{0,60}?\bwith\s+(?:a\s+)?(?:bachelor'?s?|b\.?\s?s\.?)\b/i.test(ev)) return false;
  // "Equivalent" is ambiguous only when it lets education stand in for the
  // years ("or an equivalent combination of education and experience"). Amazon's
  // "4+ years of working in mechanical engineering or equivalent experience"
  // names the kind of experience; the four years stand (nine wasted reads on
  // that template, 2026-11-03).
  if (/\bequivalent\b[^.;\n]{0,40}\b(?:education|degree|combination|training|schooling)\b|\b(?:education|degree)\b[^.;\n]{0,30}\bequivalent\b/i.test(ev)) return true;
  // "non-internship professional experience" is the opposite of internships counting.
  if (/(?<!non-)\b(?:internships?|co-?ops?)\b/i.test(ev.replace(/\bnon-(?:internship|intern|co-?op)\b/gi, ''))) return true;
  if (/(?<!non-)\b(?:internships?|co-?ops?)\b[^.\n]{0,80}\b(?:count|counts|considered|qualif\w*|accepted|toward)\b/i.test(String(body).replace(/\bnon-(?:internship|intern|co-?op)\b/gi, ''))) return true;
  // An alternative path on the same line: "BS with 3 years, or MS with 1 year".
  if (/\bor\b[^.\n;]{0,80}\b(?:master'?s|m\.?\s?s\.?|ph\.?\s?d|doctor\w*|associate'?s)\b/i.test(ev)) return true;
  // A level label in the evidence that the posting's own title does not carry.
  const label = ev.match(/\b(?:engineer|level)\s+(I{2,3}|[2-4])\b|\b(senior|sr\.?|staff|principal)\b/i);
  // Only a VARIANT label is ambiguous: the page must also offer a lower level
  // (an Engineer I line, entry level, new grad). Micron's "FAB Engineer 2" with
  // nothing beside it is the posting's own level.
  // …or the label is the subject of a level-specific requirement ("Engineer II
  // requires 3+ years"), which says the posting hires at more than one level.
  const lower = /\b(?:engineer|level)\s+(?:I|1)\b(?!\s*[-–/]?\s*(?:I|2))|\bentry[- ]level\b|\bnew (?:college )?grad/i.test(String(body))
    || /\b(?:engineer|level)\s+(?:II|III|[2-4])\s*(?::|\s(?:requires?|needs?|must))/i.test(ev);
  if (label && lower && !new RegExp(`\\b${(label[1] || label[2] || '').replace('.', '\\.')}\\b`, 'i').test(String(title))) return true;
  return false;
}

/**
 * The years a Bachelor's rung asks, or null: "BS with 4+ years", "Bachelor's
 * degree and at least 5 years", "5 years … with a Bachelor's". null when a
 * Bachelor's route with 0-2 years is also written, or "or equivalent" sits on it.
 */
export function bachelorRungYears(text) {
  const t = String(text || '');
  const BACH = String.raw`(?:bachelor'?s?|b\.?\s?s\.?|b\.?\s?sc\.?)`;
  // (?![a-z]) rather than \b after the degree: "B.S." ends on a period, and \b
  // there never matched (Helion's "B.S. with 4+ years" slipped through).
  // The gap stays inside one sentence (review, 2026-11-03): a period ends it
  // unless it sits inside an abbreviation ("B.S. with", "M.S.") — a period
  // followed by nothing, or by a lower-case word. "Bachelor's degree in ME. 3+
  // years of experience is a plus." is two sentences.
  const GAP = String.raw`(?:[^.;\n]|\.(?!\s)|\.(?=\s+[a-z]))`;
  if (new RegExp(String.raw`\b${BACH}(?![a-z])${GAP}{0,60}?\b0\s*(?:-|–|to)?\s*\d?\s*\+?\s*(?:years?|yrs)\b`, 'i').test(t)) return null;
  const m = t.match(new RegExp(String.raw`\b${BACH}(?![a-z])${GAP}{0,140}?\b(?:at\s+least\s+|minimum\s+(?:of\s+)?)?((?:[3-9]|1\d))\s*\+?\s*(?:years?|yrs)\b([^.;\n]{0,60})`, 'i'))
    || t.match(new RegExp(String.raw`\b((?:[3-9]|1\d))\s*\+?\s*(?:years?|yrs)\b[^.;\n]{0,60}?\bwith\s+(?:a\s+)?${BACH}(?![a-z])([^.;\n]{0,60})`, 'i'));
  if (!m) return null;
  // Years of SCHOOLING: Abbott writes "Bachelors Degree (± 16 years)" (and
  // "Associates (± 14 years)") beside its education line.
  if (/[±~]\s*$|\+\/-\s*$|\(\s*$/.test(t.slice(Math.max(0, m.index + m[0].indexOf(m[1]) - 4), m.index + m[0].indexOf(m[1])))) return null;
  // A wish, not a requirement: "a plus", "nice to have", "bonus", "desired", "ideally".
  if (/\b(?:a\s+plus|plus\b|nice[\s-]to[\s-]have|bonus|desired|desirable|ideally)\b/i.test(m[0])) return null;
  if (/\bpreferred\b/i.test(m[0]) && Number(m[1]) < 3) return null;
  if (/\bequivalent\b[^.;\n]{0,40}\b(?:education|degree|combination|training|schooling)\b/i.test(m[0])) return null;
  return Number(m[1]);
}

/** A title in his field, for which a preference block is worth naming. */
export const FIELD_TITLE = /mechanical|manufactur|process|equipment|robot|mechatron|hardware|automation|design engineer|production engineer|systems engineer/i;

/**
 * 'us' | 'elsewhere' | 'unclear'. The stored bucket first; an unknown or remote
 * one is read again from the place itself, then from the city words the store
 * has learned (picks.mjs learnPlaces).
 */
export function placeOf(row, places = null) {
  const b = row.location_bucket || 'unknown';
  if (b === 'non-us') return 'elsewhere';
  if (b === 'us') return 'us';
  const w = whereIsIt(row.location);
  if (w === 'elsewhere' || whereIsIt(row.title) === 'elsewhere') return 'elsewhere';
  if (b === 'remote' || w === 'us') return 'us';
  const l = learnedWhere(row.location, places);
  if (l === 'elsewhere') return 'elsewhere';
  if (l === 'us') return 'us';
  return 'unclear';
}

/** What a verdict depends on. A change in any of it screens the row again. */
export function rowKey(row, rulesStamp = '') {
  // The body is keyed by its length and the time it was last written: the
  // enricher stamps enriched_at whenever it rewrites a body, so a changed body
  // changes the key without reading 1.0M bodies. The text's own hash is stored
  // with the verdict whenever the screen reads it (body_hash).
  return crypto.createHash('sha1').update([SCREEN_VERSION, rulesStamp, row.title, row.company, row.location, row.location_bucket,
    row.desc_len || 0, row.enriched_at || '', row.fit_score ?? '', row.f_hard_block, row.block_key || '', row.fit_blocked, row.f_senior,
    row.f_intern, row.f_grad_mismatch, row.f_newgrad, row.apply_route || '', row.level_years ?? '', row.salary_max ?? '',
    row.pick_note ? String(row.pick_note).slice(0, 40) : ''].join('|')).digest('hex').slice(0, 20);
}

/**
 * Everything outside the row a verdict depends on: his hidden companies, the
 * capped list, his preference rules, and the code of every rule module. Any
 * change screens every row again.
 */
export function contextStamp({ hidden = [], rules = null, files = RULE_FILES } = {}) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify([...hidden].sort()));
  h.update(String(CAPPED?.source || ''));
  try { h.update(JSON.stringify(rules || {})); } catch { /* none */ }
  for (const f of files) { try { h.update(fs.readFileSync(f)); } catch { h.update(`missing:${f}`); } }
  return h.digest('hex').slice(0, 12);
}
const RULE_FILES = ['library-screen.mjs', 'curate.mjs', 'text.mjs', 'prescreen.mjs', 'requirements.mjs', 'eligibility.mjs', 'degree.mjs', 'picks.mjs', 'prefs.mjs', 'visa.mjs', 'triage.mjs', 'salary-text.mjs', 'geo.mjs',
  path.join('presets', 'hardware-engineering', 'screen.mjs')].map((f) => path.join(HERE, f));

function openScreen(file = SCREEN_PATH) {
  const s = new DatabaseSync(file);
  s.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, key TEXT, verdict TEXT, stage TEXT, reason TEXT,
      company TEXT, title TEXT, fit INTEGER, desc_len INTEGER, at TEXT, body_hash TEXT);
    CREATE INDEX IF NOT EXISTS verdicts_stage ON verdicts(stage);
    CREATE INDEX IF NOT EXISTS verdicts_survivor ON verdicts(verdict, fit);
    CREATE INDEX IF NOT EXISTS verdicts_at ON verdicts(at);`);
  // Migration: body_hash arrived with the review fixes (2026-11-03).
  try { s.exec('ALTER TABLE verdicts ADD COLUMN body_hash TEXT'); } catch { /* already there */ }
  return s;
}

const COLS = `rowid AS rid, id, company, title, location, location_bucket, fit_score, level_years, f_newgrad, desc_len, enriched_at,
  salary_max, salary_interval, pick_note, apply_route, f_hard_block, block_key, fit_blocked, fit_blockers, f_senior, f_intern, f_grad_mismatch, gone_at, status, superseded_by`;

/**
 * Screen the open library. Streams `chunk` rows at a time. Rows whose key is
 * unchanged since the last run keep their verdict unless `all`.
 */
export function screenLibrary({ dbPath = DB_PATH, screenPath = SCREEN_PATH, all = false, chunk = 4000, log = () => {} } = {}) {
  // ONE SCREEN AT A TIME (audit, 2026-11-03): two runs sharing screen.db would
  // interleave their per-run stamps and delete each other's verdicts.
  const lock = `${screenPath}.lock`;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  let holder = null;
  try { holder = Number(fs.readFileSync(lock, 'utf8')) || null; } catch { /* free */ }
  if (holder && holder !== process.pid && alive(holder)) throw new Error(`another library screen is running (pid ${holder})`);
  fs.writeFileSync(lock, String(process.pid));
  try { return screenLibraryLocked({ dbPath, screenPath, all, chunk, log }); }
  finally { try { if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock); } catch { /* gone */ } }
}

function screenLibraryLocked({ dbPath, screenPath, all, chunk, log }) {
  const t0 = Date.now();
  const db = openDb(dbPath);
  const s = openScreen(screenPath);
  const rules = (() => { try { return loadPrefs(); } catch { return null; } })();
  const hiddenList = (() => {
    try { const r = db.prepare("SELECT v FROM meta WHERE k = 'hiddenCompanies'").get(); return r ? JSON.parse(r.v) : []; } catch { return []; }
  })().map((c) => String(c).toLowerCase().trim());
  const hidden = new Set(hiddenList);
  const places = learnPlaces(db);
  const stamp = contextStamp({ hidden: hiddenList, rules });
  const dict = getDictionary(db, 'description');
  const prior = s.prepare('SELECT key FROM verdicts WHERE id = ?');
  const touch = s.prepare('UPDATE verdicts SET at = ? WHERE id = ?');
  const put = s.prepare(`INSERT INTO verdicts (id, key, verdict, stage, reason, company, title, fit, desc_len, at, body_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET key = excluded.key, verdict = excluded.verdict, stage = excluded.stage, reason = excluded.reason,
      company = excluded.company, title = excluded.title, fit = excluded.fit, desc_len = excluded.desc_len, at = excluded.at, body_hash = excluded.body_hash`);
  const page = db.prepare(`SELECT ${COLS} FROM jobs WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  const counts = Object.fromEntries(STAGES.map((k) => [k, 0]));
  let screened = 0, reused = 0, bodiesRead = 0, last = 0, open = 0;
  // A PER-RUN MARK, NOT A SET OF 1.0M IDS (review, 2026-11-03): every open row
  // seen this run is stamped with the run's time, and anything left unstamped
  // afterwards is no longer an open posting.
  const now = new Date().toISOString();
  for (;;) {
    const rows = page.all(last, chunk);
    if (!rows.length) break;
    last = rows[rows.length - 1].rid;
    s.exec('BEGIN');
    for (const row of rows) {
      if (row.status !== 'new' || row.gone_at || row.superseded_by) continue;
      open += 1;
      const key = rowKey(row, stamp);
      if (!all) {
        const p = prior.get(row.id);
        if (p && p.key === key) { touch.run(now, row.id); reused += 1; continue; }
      }
      // The body is read only for a row every cheaper check has passed.
      let v = screenRow(row, '', { hidden, rules, places, taste: false });
      let bodyHash = null;
      if (v.stage === 'waiting-body' && (row.desc_len || 0) >= SHORT_FLOOR) {
        let text = '';
        try { text = htmlToText(readDescription(db, row.id, dict) || ''); } catch { text = ''; }
        bodiesRead += 1;
        bodyHash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
        v = screenRow(row, text, { hidden, rules, places });
      }
      put.run(row.id, key, v.verdict, v.stage, v.reason, row.company, row.title, row.fit_score ?? null, row.desc_len || 0, now, bodyHash);
      screened += 1;
    }
    s.exec('COMMIT');
    log(`  … rowid ${last}: ${open} open, ${screened} screened, ${reused} unchanged`);
  }
  // Rows no longer open leave the table, in batches.
  let removedStale = 0;
  for (;;) {
    const r = s.prepare('DELETE FROM verdicts WHERE rowid IN (SELECT rowid FROM verdicts WHERE at < ? LIMIT 20000)').run(now);
    removedStale += Number(r.changes || 0);
    if (!r.changes) break;
  }
  for (const r of s.prepare('SELECT stage, count(*) n FROM verdicts GROUP BY stage').all()) counts[r.stage] = r.n;
  db.close?.(); s.close();
  return { open, screened, reused, bodiesRead, removedStale, counts, ms: Date.now() - t0 };
}

/** The best survivors, fit first, for the reader. */
export function survivors({ screenPath = SCREEN_PATH, limit = 50, skip = null } = {}) {
  const s = new DatabaseSync(screenPath, { readOnly: true });
  const rows = s.prepare("SELECT id, company, title, fit FROM verdicts WHERE verdict = 'survivor' ORDER BY fit DESC, id").all();
  s.close();
  return rows.filter((r) => !(skip && skip.has(r.id))).slice(0, limit);
}

/** The removal table: every open row accounted for. */
export function removalTable(res) {
  const lines = [`${res.open.toLocaleString()} open rows (${res.screened.toLocaleString()} screened this run, ${res.reused.toLocaleString()} unchanged, ${res.bodiesRead.toLocaleString()} bodies read) in ${(res.ms / 1000).toFixed(1)} s`];
  let left = res.open;
  for (const k of STAGES) {
    const n = res.counts[k] || 0;
    if (k === 'survivor') { lines.push(`  = ${n.toLocaleString().padStart(9)}  survivors (readable, pass every rule)`); continue; }
    left -= n;
    lines.push(`  - ${n.toLocaleString().padStart(9)}  ${k.padEnd(14)} → ${left.toLocaleString()} left`);
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
  if (process.argv.includes('--survivors')) {
    for (const r of survivors({ limit: Number(arg('survivors', 40)) })) console.log(`${String(r.fit).padStart(3)}  ${r.id}  ${r.company} — ${r.title}`);
  } else {
    const res = screenLibrary({ all: process.argv.includes('--all'), log: process.argv.includes('--quiet') ? () => {} : (m) => console.log(m) });
    console.log(removalTable(res));
  }
}
