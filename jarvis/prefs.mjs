// jarvis/prefs.mjs — plain-English preferences, compiled into scoring rules.
//
// `profile.yml` captures the structured facts (target roles, comp, hubs). It
// cannot express the things that actually decide whether a posting is worth
// opening: no second shift, no pure-software roles, prefer a big city. Those
// are opinions, they change often, and they should not require editing code or
// YAML schemas to state.
//
// So jarvis/preferences.md is written in sentences and compiled here. Every
// rule is literal keyword matching — no model, no tokens, no network.
//
// Grammar (one rule per line):
//   never|no    <terms>     hard rule: flagged, pushed to the bottom
//   require     <terms>     the job must match ONE of these, or it is blocked
//   avoid       <terms>     strong penalty
//   prefer      <terms>     bonus
//   want|love   <terms>     strong bonus
//
// Qualifiers: `in title` / `in location` / `in company` narrow the field.
// Terms are comma-separated alternatives; "quoted phrases" match exactly.
// A trailing `except <terms>` switches the rule off wherever one of those terms
// is in the same field: `no cloud in title except hardware`.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { SEGMENT_SPLIT_RE } from './geo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = path.join(HERE, 'preferences.md');

const WEIGHTS = { never: -100, no: -100, require: -100, avoid: -10, prefer: 3, want: 6, love: 6 };

// Preferences NUDGE the ranking; they must not become the ranking.
//
// Uncapped, they did: with six `want`/`prefer` lines each worth double digits,
// every KLA posting collected +48 and pinned to 100/100 — a Supply Chain
// Analyst and an Engineering *Manager* tied with the best mechanical-design
// role in the store, because KLA writes "semiconductor" and "automation" into
// every description they publish. A cap keeps the six weighted dimensions in
// charge of the ordering and leaves preferences as the tie-breaker they should
// be. Hard `never`/`no` rules bypass this entirely — they become blockers.
const MAX_POSITIVE = 12;
const MAX_SOFT_PENALTY = -30;
const VERB = /^(never|no|require|avoid|prefer|want|love)\b/i;

// Reused from the same reasoning as fit.mjs: match words, not substrings, or
// "no sales" would fire on "wholesaler" and "avoid operator" on "cooperative".
const reCache = new Map();
function termRe(term) {
  let re = reCache.get(term);
  if (re) return re;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '(?:s|es|ed|ing)?\\b' : '';
  re = new RegExp(`${left}${esc}${right}`, 'i');
  reCache.set(term, re);
  return re;
}

/** Parse the file's text into rules. Pure — no I/O, so it is directly testable. */
export function parseRules(text) {
  const rules = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('|') || line.startsWith('>')) continue;
    // Skip markdown structure — headings, bullets of prose, tables.
    if (/^[-*]\s|^\d+\.\s|^#{1,6}\s|^---/.test(line)) continue;
    const m = line.match(VERB);
    if (!m) continue;

    const verb = m[1].toLowerCase();
    let rest = line.slice(m[0].length).trim();

    // ONE WORD CAN NAME TWO PROFESSIONS (F-540). "no cloud in title" was written
    // for cloud software, and it also hid AWS's whole Cloud Hardware Development
    // Engineer family — mechanical, thermal and server-hardware design. Listing
    // every software form of "cloud" instead freed ~200 software reqs, so the
    // rule keeps its word and names what it does not mean.
    let except = [];
    const ex = rest.match(/\s+except\s+(.+)$/i);
    if (ex) {
      except = ex[1].split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(t => t.length >= 2);
      rest = rest.slice(0, ex.index).trim();
    }

    let field = 'all';
    const fieldMatch = rest.match(/^in\s+(title|location|company)\b/i);
    if (fieldMatch) { field = fieldMatch[1].toLowerCase(); rest = rest.slice(fieldMatch[0].length).trim(); }
    // Also allow the qualifier trailing a single term: `avoid "senior" in title`
    const trailing = rest.match(/\bin\s+(title|location|company)\s*$/i);
    if (trailing) { field = trailing[1].toLowerCase(); rest = rest.slice(0, trailing.index).trim(); }

    const terms = rest.split(',')
      .map(t => t.trim().replace(/^["']|["']$/g, ''))
      .map(t => t.replace(/\bin\s+(title|location|company)\s*$/i, '').trim())
      .filter(t => t.length >= 2);
    if (!terms.length) continue;

    rules.push({ verb, weight: WEIGHTS[verb], field, terms, except, source: line });
  }
  return rules;
}

let _cache = null;
/** Load and compile preferences.md (memoised). */
export function loadPrefs({ force = false, file = PREFS_PATH } = {}) {
  if (!force && _cache) return _cache;
  let text = '';
  try { if (existsSync(file)) text = readFileSync(file, 'utf-8'); } catch { /* optional file */ }
  _cache = parseRules(text);
  return _cache;
}

/**
 * Apply the rules to a job.
 * @returns {{delta:number, hard:string[], hits:string[]}}
 *   delta — points to add to the fit score (clamped by the caller)
 *   hard  — human-readable violations of `never`/`no` rules
 *   hits  — human-readable matches worth showing
 */
// ── THE F-1 FLOOR. Not a preference; a constraint. ──────────────────
//
// An audit of all 184,222 live rows against his rules found two structural
// holes that no amount of rule-writing could close:
//
//   1. This function never read `company`. "Mechanical Engineer" at "Lockheed
//      Martin Missiles and Fire Control" returned no violation at all, and the
//      standing instruction to skip SpaceX / Northrop / Raytheon / Lockheed /
//      Blue Origin had no mechanical enforcement anywhere in the system —
//      it could not even be WRITTEN as a rule in preferences.md.
//   2. `avoid clearance, ITAR, US citizen only, export control` is an `avoid`
//      — ten points off, capped at thirty — so a posting reading "Must be a
//      U.S. Person under ITAR. Active Secret clearance required." came back
//      with `hard: []`. His file provides zero hard protection against the one
//      class of role he legally cannot take.
//
// He is on an F-1 visa. These are not things he might prefer to avoid; they
// are roles that cannot be applied to, and a soft penalty on a scored list is
// exactly how one reaches a curated inbox at fit 70. So this floor is built
// in, evaluated before his rules, and does not depend on what his file says.
// The lists are deliberately short and plain so he can read them.
const DEFENSE_PRIMES = /\b(spacex|space exploration technologies|northrop|raytheon|\brtx\b|lockheed|blue origin|general dynamics|bae systems|l3harris|anduril|boeing defen[cs]e)\b/i;
const CLEARANCE_TITLE = /\b(clearance|cleared|\bitar\b|\bdod\b|skillbridge|top[- ]secret|\bts\/sci\b|us[- ]citizen(ship)?[- ](required|only)|u\.?s\.? person)\b/i;

function f1Floor(job) {
  const out = [];
  const company = String(job.company || '');
  const title = String(job.title || '');
  if (DEFENSE_PRIMES.test(company)) out.push(`Defense prime (${company.trim()}) — cannot be applied to on F-1`);
  if (CLEARANCE_TITLE.test(title)) out.push('Title names a clearance, ITAR or US-person requirement — cannot be applied to on F-1');
  return out;
}

/**
 * Which text a rule is allowed to see.
 *
 * `in company` exists because his one "never defense" rule is scoped to the
 * TITLE, and the companies it is really about do not put it there (F-469).
 * Icarus posts a plain "Manufacturing Engineer" in El Segundo while its YC
 * profile lists the industry as Defense, it holds Army SBIR contracts and its
 * CEO holds a TS/SCI clearance. The defense is in the company, not in the
 * sentence, and a rule that can only read the sentence cannot see it.
 */
const pick = (field, fields) => (field === 'title' ? fields.title
  : field === 'location' ? fields.location
  : field === 'company' ? fields.company
  : fields.all);

export function applyPrefs(job, rules) {
  const title = String(job.title || '');
  const location = String(job.location || '');
  const company = String(job.company || '');
  // Company is in the haystack now. It never was, which is why no rule about an
  // employer could ever fire — see the floor above.
  const all = `${title} ${job.company || ''} ${job.team || ''} ${location} ${job.description || ''}`;

  let positive = 0, penalty = 0;
  const hard = [...f1Floor(job)], hits = [];

  // A multi-site req lists every site in one field. Matching an exclusion
  // against the whole string blocks the posting because ONE of its sites is
  // ruled out — which is how an OpenAI role listing "Singapore · Seattle ·
  // United States · San Francisco" got hard-blocked on the Singapore rule with
  // three US sites sitting right beside it. Split first, and let any surviving
  // site save the posting: a false negative is the expensive error here.
  const sites = location.split(SEGMENT_SPLIT_RE).map(s => s.trim()).filter(Boolean);

  // `require` is the only rule that fires by NOT matching.
  //
  // Blocklisting stopped converging. Every pass through the deck turned up
  // another profession nobody had thought of — nurse practitioners billed as
  // "Advanced Practice Provider", telehealth psychiatrists, medical coders,
  // Okta engineers, yard hostlers, claims adjusters — because the tracked
  // companies include Accenture, Amazon, Humana and Labcorp, who post their
  // entire workforce. Labcorp alone had 161 postings in the deck and zero
  // containing the word "engineer".
  //
  // Naming what he DOES want is a list of four things instead of an endless
  // list of what he does not. It stays in his own file, in his own words, and
  // deleting the line turns it off.
  for (const rule of rules.filter(r => r.verb === 'require')) {
    const hay = pick(rule.field, { title, location, company, all });
    if (!rule.terms.some(t => termRe(t).test(hay))) {
      hard.push(`Not one of the roles you asked for (${rule.terms.slice(0, 3).join(', ')}…)`);
    }
  }

  for (const rule of rules) {
    if (rule.verb === 'require') continue;
    const hay = pick(rule.field, { title, location, company, all });
    const matched = rule.terms.filter(t => termRe(t).test(hay));
    if (!matched.length) continue;
    if (rule.except?.some(t => termRe(t).test(hay))) continue;

    // Only an exclusion that rules out EVERY site actually rules out the job.
    if (rule.field === 'location' && rule.weight <= WEIGHTS.never && sites.length > 1) {
      const survives = sites.some(site => !rule.terms.some(t => termRe(t).test(site)));
      if (survives) {
        hits.push(`Also listed in ${matched.slice(0, 2).join(', ')} — other sites still open`);
        continue;
      }
    }

    // One rule fires once, however many of its terms matched — otherwise a
    // rule listing ten synonyms would outweigh every other signal.
    const label = matched.slice(0, 3).join(', ');
    if (rule.weight <= WEIGHTS.never) {
      // A `never` RULE NAMES A KIND OF JOB, SO IT HAS TO MATCH THE JOB.
      //
      // These rules search the whole posting when no field is given, and that
      // silently hid the single best replacement for the six GlobalFoundries
      // roles he had shortlisted: "Advanced Manufacturing Process Engineer
      // (2027 New College Graduate)", Malta NY, scoring 80. His rule "never
      // shift technician" fired on one sentence in the description —
      //
      //     "Create training materials and provide training for shift technicians."
      //
      // — which describes an ENGINEER who trains shift technicians. The exact
      // opposite of being one.
      //
      // Every `never` line he has written is about shift work or a role type:
      // what the job IS. A title match is proof of that; a body mention is not,
      // and "2nd Shift Process Engineer" still blocks on its title.
      //
      // Location rules are exempt: they were already resolved against the site
      // list above, where the whole point is that the title never carries it.
      //
      // Company rules are exempt for the same reason (F-469). "never Icarus in
      // company" names an EMPLOYER, and an employer is never in the job title —
      // requiring one there would make the qualifier he just wrote do nothing.
      // The scope is the proof: the rule asked to be matched against the
      // company and it was.
      const inTitle = rule.field === 'title' || rule.field === 'location' || rule.field === 'company'
        || matched.some((t) => termRe(t).test(title));
      if (inTitle) {
        hard.push(`Breaks your rule "${rule.verb} ${label}"`);
      } else {
        // Not dropped and not silent: it counts against the posting and says
        // exactly why, so he can still see it and judge for himself.
        penalty += WEIGHTS.avoid;
        hits.push(`Mentions "${label}" in the description but not the title — your "${rule.verb}" rule, not applied as a block`);
      }
    } else if (rule.weight < 0) {
      penalty += rule.weight;
      hits.push(`Against your preference: ${label}`);
    } else {
      positive += rule.weight;
      hits.push(`Matches what you want: ${label}`);
    }
  }
  const delta = Math.min(positive, MAX_POSITIVE) + Math.max(penalty, MAX_SOFT_PENALTY);
  return { delta, hard, hits };
}
