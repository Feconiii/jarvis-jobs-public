// jarvis/hiring-signals.mjs — which employers are worth tracking, read from
// their names and the titles they post. Shared by discover-linkedin.mjs,
// discover-sources.mjs and the coverage ledger (universe.mjs). Kept apart from
// discover-linkedin.mjs because that script imports the ledger while it runs,
// and the ledger importing it back was a cycle that hung the run (2026-10-03).
//
// What counts as "his kind of work" comes from the active preset
// (jarvis/targeting.mjs → presets/<preset>/discovery.mjs). The staffing-agency
// list below is the same for everyone and stays here.

import { discovery } from './targeting.mjs';

/**
 * Employers that are never worth tracking, whatever they post.
 *
 * Staffing agencies and job-board reposters are most of the noise in any
 * keyword search: they relist other companies' roles under their own name, so
 * tracking them adds duplicates with a worse apply path and no employer behind
 * them. Those are listed here, for every preset. The field-specific exclusions
 * — for the hardware preset: banks, insurers, the Big Four, building design and
 * construction, defense primes (an F-1 cannot hold a clearance; NOT because of
 * export control, which stopped being a disqualifier on 2026-09-19, see
 * jarvis/visa.mjs) — live in the preset's `neverTrack`.
 *
 * This filter only decides what to TRACK. It never hides a posting; triage does
 * that, visibly, with the sentence it read.
 */
export const GENERIC_NEVER_TRACK = [
  // staffing, recruiting and reposting
  'cybercoders', 'jobot', '\\balten\\b', 'aerotek', 'insight global', 'actalent', 'randstad',
  'kelly services', 'robert half', 'teksystems', 'motion recruitment', 'apex systems',
  'collabera', 'kforce', 'adecco', 'manpower', 'belcan', 'system one', 'staffing',
  'recruit', 'talent solutions', 'diverse lynx', 'mindlance', 'tata consultancy',
  'infosys', 'wipro', 'cognizant', 'lensa', 'ziprecruiter',
  'careerbuilder', 'get\\.it', 'dice\\b', 'jobs?\\.', '\\bvetjobs\\b', 'executive search',
  'rex\\.zone', 'lofton', 'zobility', 'eteam\\b', 'jobs? (?:in|at|near)\\b',
  // Named one by one because no pattern catches them: these are IT- and
  // engineering-staffing shops that relist other companies' roles under their
  // own name. Every one was read and confirmed from its own postings on
  // 2026-09-19 rather than guessed at from the name.
  'bright vision', 'zenovo', 'cindavi', 'haveron james', 'newnovation', 'auxo talent',
  'ttn talent', 'green key', 'edison smart', 'lumicity', 'strativ', 'evona',
  'acceler8', 'pentangle', 'steneral', 'silverspace', 'info way', 'ls solutions',
  'dsm-h', 'mount kemble', 'brightpath', 'michael page', '\\blhh\\b', 'vaco',
  'aegis worldwide', 'sterling engineering', 'kcm technical', '\\bhti\\b', 'prosum',
  'quest global', 'hcltech', 'l&t technology', 'tata technologies', 'spectrum killian',
  'searchmasters', 'paradigm nat', '\\bcps, inc', 'ina solution', 'atem corp',
  'bn associates', 'westmag', 'omega technical', 'global connect technologies',
  'innorev', 'tiltedge', 'jbs technologies', 'pacific international',
  'val\\x27s services', 'roshay', 'teleperformance',
  // From the page he pasted on 2026-09-20. Raydar resolved to a live Workable
  // board with 186 postings and was tracked for four minutes before its titles
  // were read: "(Confidential) Director of Marketing", account executives in
  // every city. A name ending in "Search" is a search firm.
  'raydar', '\\bd24\\b', 'spectra360', 'programmers\\.io', '\\bsearch$', 'professional search',
  // From the per-metro harvest the same day: agencies.
  'judge group', 'acro service', 'akkodis', 'personnel services', '\\bpersonnel\\b', 'talent\\b',
  'cypress hcm', 'htc global',
];

export const NEVER_TRACK = new RegExp([...GENERIC_NEVER_TRACK, ...(discovery.neverTrack || [])].join('|'), 'i');

/**
 * Is this posting the kind of work that makes its EMPLOYER worth tracking?
 *
 * A keyword search is a hint, not a filter: a company is only worth resolving
 * when something it posted is in the person's field (the preset's
 * `trackTitleRe`) and is not the near-miss the preset rules out
 * (`offFieldTitleRe` — for hardware, building services). See the preset for
 * the history of each.
 *
 * The names are the original ones; under another preset they hold that
 * preset's patterns.
 */
export const HARDWARE_TITLE_RE = discovery.trackTitleRe;
export const BUILDING_SERVICES_RE = discovery.offFieldTitleRe;
export const worthTracking = (title) => HARDWARE_TITLE_RE.test(title || '') && !BUILDING_SERVICES_RE.test(title || '');
