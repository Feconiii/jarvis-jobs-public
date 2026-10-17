#!/usr/bin/env node
// jarvis/fit.mjs — how well does THIS job fit THIS candidate?
//
// The old `relevance` score (triage.mjs) is a flat keyword bag: one shared list
// of ~50 industry words, +8 if the word is in the title, +3 if anywhere else.
// It answers "is this vaguely a mechanical-engineering job", which is why the
// dashboard surfaced the same handful of employers over and over: a posting
// titled "Mechanical Design Engineer" scores high whether it wants a new grad
// or fifteen years of experience, whether it pays $70k or $200k, and whether
// the description matches a single thing the candidate can actually do.
//
// This module scores the JOB AGAINST THE PERSON, reading the full description:
//
//   role        28  does the title/JD match a target role or archetype?
//   skills      26  which of HIS tools/methods does the JD actually ask for?
//   seniority   20  is it reachable for a May-2027 grad, or a staff-level ask?
//   industry    10  a target industry, or an explicitly excluded one?
//   compensation 10 versus his stated target and floor
//   location     6  a preferred hub, US, remote, or somewhere he cannot work?
//
// Two numbers come out: `score` 0–100, and a `band` (strong/good/fair/low)
// that says what to DO about it. Everything is derived from the user-layer
// files — config/profile.yml and cv.md — never hardcoded here, so editing the
// profile re-tunes the ranking with no code change.
//
// Honesty rules this follows:
//   · A dimension that cannot be judged is DROPPED from the denominator rather
//     than scored zero. Most ATSs never publish pay; scoring that as 0/10 would
//     punish a job for its employer's disclosure policy.
//   · `confidence` reports whether a real description was read. A title-only
//     job cannot have its skills judged, and the card view says so instead of
//     implying the number means as much as a fully-read one.
//   · Work-authorisation hard blocks set `blockers` and force band 'blocked' —
//     they are never silently folded into the score.
//
// Usage:
//   import { loadProfile, scoreFit } from './fit.mjs';
//   node jarvis/fit.mjs --explain <job-url>     # why did this job score that?

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import yaml from 'js-yaml';
import { loadPrefs, applyPrefs } from './prefs.mjs';
import { parseSalaryFromText } from './salary-text.mjs';
import { classifyField } from './field.mjs';
import { person, screen, DEFAULT_PERSON } from './targeting.mjs';

// Prose written about one person keys on his name: his own profile is not
// `isDefault` (that is the no-profile fallback).
const IS_HIM = person.fullName === DEFAULT_PERSON.fullName;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── skill taxonomy ──────────────────────────────────────────────────
//
// Canonical skills with their aliases. A skill counts as "his" when any alias
// appears in cv.md, and as "wanted" when any alias appears in the posting.
// Aliases matter more than the canonical name: a JD says "CMM", "coordinate
// measuring", or "dimensional inspection" for the same capability, and missing
// two of those three makes the match look far worse than it is.
//
// `weight` is how much a match is worth. Deep, differentiating skills (cobot
// programming, machine vision, GD&T) outweigh table stakes (Excel).

// The vocabulary moved to the preset so a second user can run Jarvis
// (presets/<preset>/screen.mjs); the hardware list is the one described above.
const SKILLS = screen.skills;

// ── alias matching ──────────────────────────────────────────────────
//
// Aliases must match as WORDS, not substrings. Plain `includes()` credited
// "ROS" against "ac**ros**s", "CAM" against "**cam**era", and "FAB" against
// "**fab**ricate" — so a posting could appear to demand robotics middleware
// because it used the word "across". Every alias is compiled once into a
// boundary-anchored regex; boundaries are only applied on the sides that
// actually begin/end with a word character, so "gd&t", "node-red" and "ur5"
// still match correctly.

const reCache = new Map();

// Common inflections are accepted on the right so one alias covers a word and
// its normal forms: "fixture/fixtures", "prototyp(e/ing)", "manufactur(ing/ed)",
// "robot/robots". Without this, boundary-anchoring alone silently lost most
// real mentions — a JD saying "rapid prototyping" failed an alias written as
// "rapid prototyp". The suffix set is deliberately closed, so "cam" still
// refuses to match "camera" and "fab" still refuses "fabricate".
const INFLECT = '(?:s|es|ed|ing|er|ers|or|ors|ion|ions|al|ics|ic|e)?';

function aliasRe(alias) {
  let re = reCache.get(alias);
  if (re) return re;
  const a = alias.trim();
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(a) ? '\\b' : '';
  const right = /\w$/.test(a) ? `${INFLECT}\\b` : '';
  re = new RegExp(`${left}${esc}${right}`, 'i');
  reCache.set(alias, re);
  return re;
}

/** Does any alias of `skill` appear as a word in `text`? */
/** A skill id as a person reads it: its first alias, capitalised ("rootcause" -> "Root cause"). */
export function skillLabel(id) {
  const def = SKILLS.find((s) => s.id === id);
  const raw = def?.a?.[0] || String(id || '');
  return raw.length <= 4 ? raw.toUpperCase() : raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function skillMentioned(skill, text) {
  return skill.a.some(alias => aliasRe(alias).test(text));
}

// ── profile loading ─────────────────────────────────────────────────

function readIf(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf-8') : ''; } catch { return ''; }
}

/** Parse "$100,000" / "100k" / "USD 95000" into a number. */
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).toLowerCase().replace(/[, $]/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)(k?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'k' ? n * 1000 : n;
}

/**
 * Build the scoring profile from the USER-LAYER files only
 * (config/profile.yml + cv.md). Nothing about the candidate is hardcoded in
 * this module, so editing those files re-tunes the ranking.
 */
export function loadProfile({ root = ROOT } = {}) {
  const cfgRaw = readIf(path.join(root, 'config', 'profile.yml'));
  const cfg = cfgRaw ? (yaml.load(cfgRaw) || {}) : {};
  const cv = readIf(path.join(root, 'cv.md')).toLowerCase();

  const tr = cfg.target_roles || {};
  const norm = (a) => (Array.isArray(a) ? a : []).map(s => String(s).toLowerCase().trim()).filter(Boolean);

  // Which canonical skills does he actually have? Determined by reading cv.md,
  // never asserted here — a skill he cannot evidence must not earn him points.
  const has = new Set();
  if (cv) {
    for (const s of SKILLS) {
      if (skillMentioned(s, cv)) has.add(s.id);
    }
  }

  return {
    primaryRoles: norm(tr.primary),
    secondaryRoles: norm(tr.secondary),
    archetypes: (tr.archetypes || []).map(a => ({
      name: String(a?.name || '').toLowerCase(),
      fit: String(a?.fit || 'secondary').toLowerCase(),
    })).filter(a => a.name),
    industries: norm(tr.industries),
    excludedIndustries: norm(tr.excluded_industries),
    skills: has,
    compTarget: parseMoney(cfg.compensation?.target_range),
    compFloor: parseMoney(cfg.compensation?.minimum),
    hubs: norm(cfg.location?.preferred_hubs),
    sponsorshipNeeded: cfg.location?.sponsorship_needed !== false,
  };
}

/**
 * The headline fields only — what gets PERSISTED per job.
 *
 * The full result carries a six-dimension breakdown with prose for each, about
 * 1.5 KB per posting. Stored on every job that is ~150 MB of text that only
 * ever gets displayed one job at a time, and it pushed jobs.json past V8's
 * ~512 MB string limit, at which point the store could not be read at all.
 * scoreFit is a pure function over data already in the record, so the card
 * view recomputes the breakdown on demand instead (see serve.mjs /api/job).
 */
export function slimFit(fit) {
  return {
    score: fit.score,
    band: fit.band,
    bandLabel: fit.bandLabel,
    confidence: fit.confidence,
    blockers: fit.blockers,
    field: fit.field,
  };
}

// Profile loading touches the filesystem and parses YAML, so the hot paths
// (scanning tens of thousands of postings) must not repeat it per job.
let _cached = null;
/** Memoised loadProfile for per-job scoring. Pass force to re-read. */
export function getProfile({ force = false } = {}) {
  if (force || !_cached) _cached = loadProfile();
  return _cached;
}

// ── dimension scorers ───────────────────────────────────────────────
// Each returns { pts, max, why[] } or null when it cannot be judged.
// Returning null is meaningful: the dimension leaves the denominator.

// Title words, discipline words and the fallback vocabulary are the preset's
// (moved so a second user can run Jarvis): "staff" is senior for an engineer
// and entry level for an accountant.
const SENIOR_RE = screen.fitSeniorTitle;
const ENTRY_RE = screen.fitEntryTitle;

/** The discipline word of a primary role ("automation" of "automation engineer"), when an engineer's title carries it. */
function primaryDiscipline(title, p) {
  if (!screen.disciplineTitle.test(title)) return null;
  const words = new Set(p.primaryRoles.map((r) => r.split(/\s+/)[0]).filter((w) => w.length > 4));
  // Mechatronics is robotics work by another name (the preset's aliases).
  for (const [w, also] of Object.entries(screen.disciplineAliases || {})) {
    if (words.has(w)) for (const a of also) words.add(a);
  }
  for (const w of words) if (new RegExp(`\\b${w}`).test(title)) return w;
  return null;
}

function scoreRole(job, p) {
  const title = (job.title || '').toLowerCase();
  const body = (job.description || '').toLowerCase();
  const why = [];
  let pts = 0;

  const hitPrimary = p.primaryRoles.filter(r => title.includes(r));
  const hitSecondary = p.secondaryRoles.filter(r => title.includes(r));

  if (hitPrimary.length) {
    pts = 28;
    why.push(`Title is a primary target role (${hitPrimary[0]})`);
  } else if (primaryDiscipline(title, p)) {
    // "Tools and Automation Mechatronics Engineer" (Apple, 2026-10-16) — the
    // work he calls a perfect fit — is not the literal string "automation
    // engineer", so it scored as a generic discipline title, 16 of 28. A
    // primary discipline word in an engineer's title is that role.
    pts = 25;
    why.push(`Title names a primary target discipline (${primaryDiscipline(title, p)})`);
  } else if (hitSecondary.length) {
    pts = 21;
    why.push(`Title is a secondary target role (${hitSecondary[0]})`);
  } else {
    // No title match — fall back to the archetype vocabulary appearing in the
    // body. Titles are branded ("Product Realization Engineer") far more often
    // than they are descriptive, so the JD is the fairer test.
    const words = screen.roleFallbackWords;
    const say = screen.roleFallbackWhy;
    const inTitle = words.filter(w => title.includes(w));
    const inBody = words.filter(w => body.includes(w));
    if (inTitle.length) { pts = 16; why.push(`${say.title} (${inTitle.join(', ')})`); }
    else if (inBody.length >= 3) { pts = 9; why.push(say.body); }
    else if (inBody.length) { pts = 4; why.push(say.weak); }
    else { pts = 0; why.push('No match to any target role'); }
  }
  return { pts, max: 28, why };
}

function scoreSkills(job, p) {
  const body = (job.description || '');
  // Title-only postings cannot support a skills judgement. Scoring 0 would be
  // a lie about the job; the dimension is dropped and confidence reports it.
  if (!body || body.length < 200) return null;
  const wants = SKILLS.filter(s => skillMentioned(s, body));
  if (!wants.length) return null;

  const totalW = wants.reduce((a, s) => a + s.w, 0);
  const matched = wants.filter(s => p.skills.has(s.id));
  const gotW = matched.reduce((a, s) => a + s.w, 0);

  // Coverage of what the JD asks for, softened: a posting listing 20 skills is
  // not "80% mismatched" because he has 4 of the deepest ones. sqrt keeps
  // partial overlap meaningful without letting a laundry list dominate.
  const coverage = totalW ? Math.sqrt(gotW / totalW) : 0;
  const pts = Math.round(coverage * 26);

  const why = [];
  if (matched.length) why.push(`Asks for ${matched.length} of his skills: ${matched.slice(0, 6).map(s => s.id).join(', ')}`);
  const missing = wants.filter(s => !p.skills.has(s.id)).sort((a, b) => b.w - a.w).slice(0, 4);
  if (missing.length) why.push(`Also wants: ${missing.map(s => s.id).join(', ')}`);
  return { pts, max: 26, why, matched: matched.map(s => s.id), missing: missing.map(s => s.id) };
}

function scoreSeniority(job) {
  const title = job.title || '';
  const exp = job.triage?.experience;
  const why = [];

  if (SENIOR_RE.test(title)) {
    why.push('Title is senior/staff/lead level — out of reach for a new grad');
    return { pts: 0, max: 20, why };
  }
  if (ENTRY_RE.test(title)) {
    why.push('Title is explicitly intern / new-grad / entry level');
    return { pts: 20, max: 20, why };
  }
  // The number is the FLOOR of the ask — "3+ years" and "3-5 years" both
  // require three. Scoring 3 as "reachable" at 15/20 put 779 postings he
  // cannot apply for at the top of his deck (see triage.mjs). He has zero
  // industry years until May 2027, so the bands are judged from that.
  const years = exp?.years;
  if (typeof years === 'number') {
    if (years <= 1) { why.push(`Asks ~${years}y experience`); return { pts: 20, max: 20, why }; }
    if (years <= 2) { why.push(`Asks ~${years}y experience — reachable with internships`); return { pts: 15, max: 20, why }; }
    if (years <= 5) { why.push(`Asks ${years}+ years — ${IS_HIM ? `he has none until ${person.gradLabel}` : `a new grad (${person.gradLabel}) has none`}`); return { pts: 5, max: 20, why }; }
    why.push(`Asks ${years}+ years — well beyond a new grad`);
    return { pts: 0, max: 20, why };
  }
  // A MINIMUM THAT IS ONLY A DEGREE (2026-10-16). Apple's Touch team lists
  // its minimum qualifications — CAD, prototyping, analog basics, "Minimum
  // requirement of a bachelors degree" — and no years anywhere; that is a
  // posting a graduate can meet, not an unknown.
  const body = String(job.description || '');
  if (body.length > 400 && /\b(minimum|basic|required)\b[^.]{0,60}\b(bachelor'?s?|b\.?s\.?|degree)\b|\b(bachelor'?s?|degree)\b[^.]{0,40}\b(minimum|required)\b/i.test(body)
    && !/\b\d+\s*\+?\s*(years?|yrs?)\b/i.test(body)) {
    why.push('Asks for a degree and no years of experience');
    return { pts: 17, max: 20, why };
  }
  why.push('No stated experience requirement and a level-neutral title');
  return { pts: 11, max: 20, why };
}

function scoreIndustry(job, p) {
  const hay = `${job.company || ''} ${job.team || ''} ${job.title || ''} ${job.description || ''}`.toLowerCase();
  const why = [];

  // Excluded industries are a stated preference, so they subtract rather than
  // simply failing to add — a pure-software role at a great company should not
  // rank alongside a manufacturing one.
  //
  // But this is a question about what the ROLE IS, not about what the employer
  // sells, and it used to be a bare substring test against the whole
  // description. Every chip company writes "serving automotive, industrial and
  // consumer markets" and every modern engineering JD says "software"
  // somewhere, so 37% of the top 400 deck postings — Fab Automation Engineer,
  // Manufacturing Engineer, Automation Engineer — were scored 0/10 on industry
  // for boilerplate in a paragraph about the company's end markets.
  //
  // Judged on the role identity instead, with word boundaries. A genuinely
  // excluded ROLE still says so in its title, and preferences.md already hard-
  // blocks the software titles outright, so nothing is lost by not scanning the
  // body for them.
  // Title, team and employer — the role's identity. An employer literally
  // named "… Automotive" is an automotive company; a semiconductor firm whose
  // description lists automotive among its end markets is not.
  const role = `${job.title || ''} ${job.team || ''} ${job.company || ''}`;
  for (const ex of p.excludedIndustries) {
    const key = ex.split('/')[0].replace(/\(.*?\)/g, '').trim();
    if (key.length > 3 && new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(role)) {
      why.push(`Matches an excluded industry (${ex})`);
      return { pts: 0, max: 10, why, field: classifyField(job) };
    }
  }
  // A field he is actively hunting outranks one he merely qualifies for. This
  // used to be a flat yes/no, which made a wafer-fab role and a humanoid-
  // robotics role score identically — fine for relevance, useless for ordering
  // a store whose tracked companies are overwhelmingly semiconductor.
  const field = classifyField(job);
  if (field.priority) {
    why.push(`${field.label} — a field he is actively hunting (${field.matched.slice(0, 2).join(', ')})`);
    return { pts: 10, max: 10, why, field };
  }

  const hits = p.industries.filter(i => {
    const key = i.split('/')[0].trim().toLowerCase();
    return key.length > 3 && hay.includes(key);
  });
  if (hits.length) { why.push(`Target industry: ${hits[0]}`); return { pts: 8, max: 10, why, field }; }
  why.push('Industry not clearly one of his targets');
  return { pts: 5, max: 10, why, field };
}

function scoreComp(job, p) {
  // job.salary is filled from the ATS field when there is one, and otherwise
  // parsed out of the description text — most postings state pay in prose.
  const s = job.salary || parseSalaryFromText(job.description || '');
  // Most ATSs never publish pay. Dropping the dimension is fairer than scoring
  // a job zero for its employer's disclosure policy.
  if (!s || !Number.isFinite(s.max) || !p.compTarget) return null;
  const why = [];
  const top = s.max;
  const floor = p.compFloor ?? 0;
  // Compared on the annual figure, but REPORTED the way the posting stated it.
  // A reason line reading "pays up to $71k" for a req that says $34/hour is a
  // number he cannot find in the posting or repeat back to a recruiter.
  const stated = s.interval === 'hour' && s.rate?.max
    ? `$${Math.round(s.rate.max * 100) / 100}/hr (~$${Math.round(top / 1000)}k/yr)`
    : `$${Math.round(top / 1000)}k`;

  // SCORE WHAT HE WOULD ACTUALLY BE OFFERED, NOT THE TOP OF THE BAND.
  //
  // A GlobalFoundries new-grad req posting "$58,000 - $101,000" scored 9/10,
  // "at or above target", because only s.max was read. Those bands cover the
  // whole ladder — Engineer I through III — and a May-2027 graduate lands at
  // the bottom of it, which here is $22k under his floor. Reporting the
  // ceiling as the offer is the same class of error as reading a funding round
  // as a salary: technically a number in the posting, not a number about him.
  const bottom = Number.isFinite(s.min) && s.min > 0 ? s.min : top;
  const isEntry = job.triage?.experience?.level === 'entry'
    || job.triage?.flags?.newGrad
    || /\b(new (college )?grad|entry[- ]level|university grad|campus)\b/i.test(job.title || '');
  // A new grad sits near the floor of the band; anyone else, assume mid.
  const expected = bottom === top ? top
    : isEntry ? bottom + (top - bottom) * 0.25
    : (bottom + top) / 2;

  const range = bottom === top ? stated
    : (s.interval === 'hour' && s.rate?.min && s.rate?.max
        ? `$${Math.round(s.rate.min * 100) / 100}–$${Math.round(s.rate.max * 100) / 100}/hr`
        : `$${Math.round(bottom / 1000)}k–$${Math.round(top / 1000)}k`);
  const note = bottom === top ? '' : isEntry ? ' (a new grad starts near the bottom of that band)' : '';

  let pts;
  if (expected >= p.compTarget * 1.25) { pts = 10; why.push(`Pays ${range} — well above his $${Math.round(p.compTarget / 1000)}k target${note}`); }
  else if (expected >= p.compTarget) { pts = 9; why.push(`Pays ${range} — at or above target${note}`); }
  else if (expected >= floor) { pts = 5; why.push(`Pays ${range} — above his $${Math.round(floor / 1000)}k floor, below target${note}`); }
  else {
    pts = 0;
    const who = isEntry ? 'a new grad lands' : 'the realistic offer lands';
    why.push(`Pays ${range} — ${who} under his $${Math.round(floor / 1000)}k floor${bottom === top ? '' : ` (band starts at $${Math.round(bottom / 1000)}k)`}`);
  }
  return { pts, max: 10, why };
}

const METRO_CITIES = {
  'bay area': ['san francisco', 'san jose', 'santa clara', 'sunnyvale', 'cupertino', 'mountain view', 'palo alto', 'fremont', 'milpitas', 'menlo park', 'redwood city', 'hayward', 'livermore', 'pleasanton', 'oakland', 'berkeley', 'newark, ca', 'union city', 'san mateo', 'south san francisco', 'foster city', 'los gatos', 'campbell', 'san carlos', 'emeryville', 'alameda', 'richmond, ca', 'san leandro', 'dublin, ca', 'morgan hill', 'gilroy'],
  'austin': ['round rock', 'taylor, tx', 'cedar park', 'pflugerville', 'georgetown, tx', 'san marcos'],
  'seattle': ['redmond', 'bellevue', 'kirkland', 'everett', 'kent, wa', 'renton', 'bothell', 'tukwila', 'auburn, wa', 'woodinville', 'issaquah', 'mukilteo', 'tacoma'],
  'boston': ['cambridge, ma', 'waltham', 'burlington, ma', 'bedford, ma', 'woburn', 'lexington, ma', 'billerica', 'andover', 'wilmington, ma', 'marlborough', 'somerville', 'watertown', 'needham', 'chelmsford', 'lowell', 'framingham', 'natick', 'medford'],
  'san diego': ['carlsbad', 'la jolla', 'poway', 'sorrento', 'oceanside', 'escondido', 'chula vista', 'san marcos, ca', 'vista, ca'],
  'phoenix': ['chandler', 'tempe', 'mesa', 'scottsdale', 'gilbert', 'glendale, az', 'goodyear', 'peoria, az'],
  'portland': ['hillsboro', 'beaverton', 'tigard', 'wilsonville', 'tualatin', 'gresham', 'vancouver, wa'],
};

function scoreLocation(job, p) {
  const loc = (job.location || '').toLowerCase();
  if (!loc) return null;
  const why = [];
  const bucket = job.triage?.locationBucket;

  // Outside the US scores 0 for everyone; only an F-1 student is told it is the visa.
  if (bucket === 'non-us') { why.push(person.workAuth === 'f1' ? 'Outside the US — he cannot work there on F-1/OPT' : 'Outside the US — not a location in scope'); return { pts: 0, max: 6, why }; }
  // A HUB IS A METRO, NOT ITS NAME (2026-10-16): "San Francisco Bay Area"
  // matched no posting at all — they say Cupertino, Santa Clara, San Jose — so
  // Apple, Applied Materials, Lam and KLA all scored "not one of his hubs".
  const hub = p.hubs.find(h => {
    const city = h.split('(')[0].trim().split(',')[0].toLowerCase();
    if (city.length > 3 && loc.includes(city)) return true;
    const metro = Object.entries(METRO_CITIES).find(([k]) => city.includes(k));
    return !!metro && metro[1].some((c) => loc.includes(c));
  });
  if (hub) { why.push(`In a preferred hub (${hub.split('(')[0].trim()})`); return { pts: 6, max: 6, why }; }
  if (/remote/.test(loc)) { why.push('Remote'); return { pts: 5, max: 6, why }; }
  why.push('US location, not one of his named hubs');
  return { pts: 4, max: 6, why };
}

// ── the score ───────────────────────────────────────────────────────

export const BANDS = [
  { key: 'strong', label: 'Strong fit', min: 75 },
  { key: 'good', label: 'Good fit', min: 58 },
  { key: 'fair', label: 'Fair fit', min: 40 },
  { key: 'low', label: 'Low fit', min: 0 },
];

export function bandFor(score) {
  return BANDS.find(b => score >= b.min) || BANDS[BANDS.length - 1];
}

/**
 * Score one job against the loaded profile.
 * @returns {{score:number, band:string, bandLabel:string, confidence:string,
 *            breakdown:Array, reasons:string[], blockers:string[]}}
 */
export function scoreFit(job, p) {
  const dims = [
    ['role', scoreRole(job, p)],
    ['skills', scoreSkills(job, p)],
    ['seniority', scoreSeniority(job)],
    ['industry', scoreIndustry(job, p)],
    ['compensation', scoreComp(job, p)],
    ['location', scoreLocation(job, p)],
  ];

  // Your written preferences (jarvis/preferences.md) adjust the result rather
  // than forming a weighted dimension of their own: "no second shift" is not
  // worth N points out of M, it is a statement that the job is wrong. They are
  // applied after normalisation so a single rule cannot be diluted by however
  // many other dimensions happened to be judgeable.
  const prefs = applyPrefs(job, loadPrefs());

  let got = 0, possible = 0;
  const breakdown = [];
  for (const [name, r] of dims) {
    if (!r) { breakdown.push({ dimension: name, judged: false }); continue; }
    got += r.pts; possible += r.max;
    breakdown.push({ dimension: name, judged: true, points: r.pts, max: r.max, why: r.why, ...(r.matched ? { matched: r.matched, missing: r.missing } : {}) });
  }

  // Normalise over what could actually be judged.
  let score = possible ? Math.round((got / possible) * 100) : 0;

  if (prefs.delta) score = Math.max(0, Math.min(100, score + prefs.delta));
  if (prefs.hard.length || prefs.hits.length) {
    breakdown.push({
      dimension: 'your rules',
      judged: true,
      points: prefs.delta,
      max: 0, // an adjustment, not a weighted slice — the card renders it as ±
      adjustment: true,
      why: [...prefs.hard, ...prefs.hits],
    });
  }

  const blockers = [];
  const hb = job.triage?.flags?.hardBlock;
  if (hb) {
    const reason = job.triage?.visa?.block?.reason || 'Work-authorisation restriction';
    blockers.push(reason);
  }
  // A `never`/`no` rule is your decision, so it is surfaced exactly like a
  // work-auth block instead of quietly subtracting points.
  for (const h of prefs.hard) blockers.push(h);
  // A GRADUATION WINDOW HE FALLS OUTSIDE OF IS A BAR, AND THE SCORE HAS TO SAY
  // SO (F-438).
  //
  // Applied Intuition "Mechanical Engineer - New Grad (December 2026)" —
  // "open to candidates who graduated in summer 2026 or will graduate by the
  // end of 2026", and he graduates May 2027 — carried `f_grad_mismatch = 1`
  // and `fit_score = 99, strong, fit_blocked = 0` at the same time. The tailor
  // had already refused it ("hard eligibility mismatch no page arrangement can
  // fix") while the number went on calling it the best thing in the store.
  // Either the band carries the mismatch or the score does; neither did.
  //
  // It is a bar of the same kind as a work-auth restriction: he cannot be
  // considered, however well the role fits. It is shown, never hidden — the
  // card reads "Blocked" with this reason, exactly as a visa block does.
  if (job.triage?.flags?.gradMismatch) {
    blockers.push(job.triage?.program?.gradNote
      || 'The posting states a graduation window you fall outside of');
  }

  const desc = job.description || '';
  const confidence = desc.length >= 200 ? 'full' : (desc.length ? 'partial' : 'title-only');
  // A title-only job has no skills evidence either way. Leaving its score at
  // face value would let unread postings outrank fully-read ones purely by
  // having fewer chances to lose points.
  if (confidence !== 'full') score = Math.round(score * 0.85);

  const band = blockers.length ? { key: 'blocked', label: 'Blocked' } : bandFor(score);

  const reasons = breakdown
    .filter(b => b.judged && b.why?.length)
    .sort((a, b) => (b.points / b.max) - (a.points / a.max))
    .flatMap(b => b.why)
    .slice(0, 5);

  // The field is promoted out of the industry dimension because the deck needs
  // it to interleave employers and fields, and digging it back out of the
  // breakdown blob for every row is exactly the cost the promoted columns exist
  // to avoid.
  const fieldOf = dims.find(([name]) => name === 'industry')?.[1]?.field;

  return {
    score, band: band.key, bandLabel: band.label, confidence, breakdown, reasons, blockers,
    field: fieldOf?.key ?? 'other',
    fieldLabel: fieldOf?.label ?? 'Other',
  };
}

// ── CLI: explain one job ────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--explain');
  const needle = i !== -1 ? args[i + 1] : args[0];
  if (!needle) {
    console.error('Usage: node jarvis/fit.mjs --explain <job url or title substring>');
    process.exit(1);
  }
  const { findByUrl, query, getJob } = await import('./store.mjs');
  // A URL is an exact lookup; anything else is a title search, which the
  // full-text index answers without reading the store.
  const hit = /^https?:\/\//i.test(needle)
    ? findByUrl(needle)
    : query({ search: needle }, { limit: 1 }).rows[0];
  if (!hit) { console.error('No job matched that URL or title.'); process.exit(1); }
  // Explaining a score means re-running it, which reads the description.
  const job = getJob(hit.id, { description: true });

  const p = loadProfile();
  const fit = scoreFit(job, p);
  console.log(`\n${job.title}\n${job.company} — ${job.location || 'location unknown'}`);
  console.log(`${job.url}\n`);
  console.log(`FIT ${fit.score}/100 — ${fit.bandLabel}  (evidence: ${fit.confidence})`);
  if (fit.blockers.length) console.log(`BLOCKED: ${fit.blockers.join('; ')}`);
  console.log('');
  for (const b of fit.breakdown) {
    if (!b.judged) { console.log(`  ${b.dimension.padEnd(13)} —      not judged (no data)`); continue; }
    console.log(`  ${b.dimension.padEnd(13)} ${String(b.points).padStart(2)}/${String(b.max).padEnd(3)} ${b.why.join(' · ')}`);
  }
  console.log('');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1); });
}
