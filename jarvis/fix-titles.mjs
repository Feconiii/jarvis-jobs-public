#!/usr/bin/env node
// jarvis/fix-titles.mjs — repair titles that were title-cased out of a URL slug.
//
// Sitemap-discovered postings have no title field; the title is derived from the
// slug and blind-cased word by word. That turns every acronym and roman numeral
// into a proper noun: real Applied Materials reqs read "Manufacturing Engineer
// Ii E2", "Fep Build Manufacturing Engineer Ii 2nd Shift", "Cnc Machinist Iii".
// One of them is on his shortlist.
//
// providers/sitemap-jobs.mjs now cases these correctly, but that only helps
// postings scanned from here on. The titles already in the store are derived
// data — the same repair applies to them directly, with no refetching.
//
// Usage:
//   node jarvis/fix-titles.mjs             # repair in place
//   node jarvis/fix-titles.mjs --dry-run   # show what would change

import { ids, getJob, putJob } from './store.mjs';
import { triage } from './triage.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/fix-titles.mjs [options]

  Repair mangled posting titles in the store.

    --dry-run             
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--dry-run"], valued: [] });


const DRY = process.argv.includes('--dry-run');

// Same two rules as the provider, kept deliberately conservative: only tokens
// that are unambiguously acronyms or numerals in a job title.
// Case-INSENSITIVE: the stored titles are already word-cased, so the numeral
// arrives as "Ii" / "Iii", not "II". Without the flag this matched nothing and
// the exact title that started this — "Manufacturing Engineer Ii E2" — survived
// the repair. Word boundaries keep "In", "Or" and "It" out: "I" followed by a
// letter is not a whole token.
const ROMAN = /\b(I{1,3}|IV|VI{0,3}|IX)\b/gi;
const ACRONYM = /\b(cnc|npi|cad|cam|fea|ic|rf|ai|ml|it|hr|qa|qc|ehs|sap|plc|hvac|pcb|smt|ate|mems|asic|fpga|usa|emea|apac|nvh|bms|adas|hmi|erp|mes|sqe|dfm|dfa|spc|msa|ppap|fmea|oee|tpm|wip|bom|eol|sop|kpi|fep|cmp|cvd|pvd|ald|oem|esd|uv|led|dram|nand|euv)\b/gi;
// Trailing state code, as the slug leaves it: "… Santa Clara Ca" → "… CA".
const TRAILING_STATE = /\b(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)$/;

// Lam Research and a few other sitemap tenants end the slug with the site:
//   "Manufacturing Engineer 3 Us Ca Fremont 1003"
//   "Field Service Engineer Cn Xian 03 3829"
// — country, state, town, site number. 488 of 1,722 browsable sitemap titles
// carry one, and their `location` column is EMPTY, so this tail is the only
// place the location exists. Stripping it would throw that away; the Xian job
// would go on being classified US and sitting in a US-only deck. So it is
// moved, not deleted.
// Case-insensitive, matching providers/sitemap-jobs.mjs exactly — humanize()
// uppercases "Us" to "US" before either regex sees the title, so a
// case-sensitive rule misses the country-code form. These two must stay
// identical; site-tail.test.mjs runs every case through both.
const SITE_TAIL = /\s+((?:Us|Cn|De|Kr|Tw|Jp|In|Il|My|Sg|Ie|Fr|It|Nl|Be|At|Ch|Es|Pt|Se|Dk|No|Fi|Pl|Cz|Hu|Ro|Tr|Mx|Br|Ca|Au|Nz|Za|Ph|Th|Vn|Id)(?:\s+[A-Za-z][A-Za-z.'-]*){1,4})(?:\s+\d{2,})+\s*$/i;

// The mirror shape — country LAST, and a ZIP where the site number goes:
// "Hazardous Waste Technician Minden Louisiana USA 71055". 1,213 Eaton reqs
// arrive that way with an EMPTY location column, so the town is readable
// nowhere else, and SITE_TAIL cannot see it because that rule keys off a
// LEADING country code.
//
// The STATE is the anchor, and the city is taken by walking backwards from it.
// "1-3 capitalised words then a state" does not work: alternation is
// leftmost-first, so "Hazardous Waste Technician Minden Louisiana USA 71055"
// starts at the earliest position that satisfies the count and hands "Waste
// Technician Minden" to the location.
const US_STATE_WORDS = /alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming|district\s+of\s+columbia|puerto\s+rico/.source;
const US_ZIP_TAIL = new RegExp(
  String.raw`\s+(${US_STATE_WORDS})\s+(USA|US)\s+\d{4,6}\s*$`, 'i');

// One word of city, unless the word before it starts a two-word American city.
// Erring toward one word leaves a stray word in the TITLE, which is harmless;
// erring toward two takes a word OFF the title, which is not.
const CITY_PREFIX = /^(new|san|santa|st\.?|saint|grand|port|fort|ft\.?|lake|mount|mt\.?|west|east|north|south|cape|el|la|las|los|palm|big|little|round|cedar|oak|pine|red|white|green|long|des|colorado|kansas|oklahoma|salt|sioux|baton|corpus|coral|boca|winter|bowling|iowa|idaho|jefferson|university)$/i;

/**
 * Pull the site tail out of a slug-derived title.
 * @returns {{title:string, location:string}|null} null when there is no tail.
 */
export function splitSiteTail(title) {
  const src = String(title || '');
  const m = SITE_TAIL.exec(src);
  if (m) {
    const head = src.slice(0, m.index).trim();
    // A title that is ONLY a location is not a title — leave the row alone.
    if (head.length < 4) return null;
    const parts = m[1].trim().split(/\s+/);
    // Country and state codes go uppercase; town names keep their casing.
    const loc = parts.map((p, i) => (i < 2 && p.length === 2 ? p.toUpperCase() : p)).join(' ');
    return { title: head, location: loc };
  }
  const z = US_ZIP_TAIL.exec(src);
  if (z) {
    const words = src.slice(0, z.index).trim().split(/\s+/);
    const take = (words.length >= 2 && CITY_PREFIX.test(words[words.length - 2])) ? 2 : 1;
    const head = words.slice(0, words.length - take).join(' ').trim();
    if (head.length < 4) return null;
    const city = words.slice(words.length - take).join(' ');
    return { title: head, location: `${city} ${z[1]} ${z[2].toUpperCase()}` };
  }
  return null;
}

export function repairTitle(title) {
  let t = String(title || '');
  if (!t) return t;
  t = t.replace(ROMAN, (m) => m.toUpperCase());
  t = t.replace(ACRONYM, (m) => m.toUpperCase());
  // Only the LAST token, and only when it is already capitalised like a word
  // ("Ca"), never mid-sentence — "In" and "Or" are English words everywhere else.
  const parts = t.split(' ');
  const last = parts[parts.length - 1];
  if (last && /^[A-Z][a-z]$/.test(last) && TRAILING_STATE.test(last.toLowerCase())) {
    parts[parts.length - 1] = last.toUpperCase();
    t = parts.join(' ');
  }
  return t;
}

if (process.argv[1] && import.meta.url === (await import('url')).pathToFileURL(process.argv[1]).href) {
  const jobIds = ids({ source: ['sitemap-jobs'] });
  console.log(`Checking ${jobIds.length.toLocaleString()} sitemap-derived titles${DRY ? ' (dry run)' : ''}…`);
  let changed = 0, shown = 0, movedLoc = 0, movedOut = 0;
  for (const id of jobIds) {
    // WITH the body. putJob re-derives has_desc/desc_len from job.description
    // on every write, so reading a job without its body and writing it back
    // silently records "this posting has no description" for a posting that
    // has one — the derived-data-goes-stale failure this store is built to
    // avoid. retriage and rescore both read the body for exactly this reason.
    const job = getJob(id, { description: true });
    if (!job) continue;

    // The site tail comes off FIRST, and only lands in `location` when that
    // column is empty — a location the ATS actually gave us always wins over
    // one reverse-engineered from a URL slug.
    const before = job.title;
    const split = splitSiteTail(job.title);
    let movedLocation = null;
    if (split) {
      job.title = split.title;
      if (!job.location) { job.location = split.location; movedLocation = split.location; movedLoc++; }
    }

    const next = repairTitle(job.title);
    if (next === before && !split) continue;
    job.title = next;
    changed++;

    // RE-TRIAGE when a location moved. putJob copies location_bucket out of
    // job.triage, not out of job.location — so recovering "IN Bangalore" into
    // the location column and writing it back would leave the bucket saying
    // `unknown`, and the posting would sit in the US deck exactly as before.
    // Recovering the location is only useful if the verdict is recomputed from
    // it, which is the whole point of the exercise.
    if (movedLocation) {
      job.triage = triage({ title: job.title, description: job.description, location: job.location, url: job.url });
      if (job.triage.locationBucket === 'non-us') movedOut++;
    }

    if (shown < 12) {
      console.log(`  ${before}\n  → ${next}${movedLocation ? `   @ ${movedLocation}  [${job.triage.locationBucket}]` : ''}\n`);
      shown++;
    }
    if (!DRY) putJob(job, { description: false });
  }
  console.log(`\n${changed.toLocaleString()} titles ${DRY ? 'would be' : ''} repaired.`);
  console.log(`${movedLoc.toLocaleString()} had a site location recovered from the title; ${movedOut.toLocaleString()} of those turned out to be outside the US.`);
}
