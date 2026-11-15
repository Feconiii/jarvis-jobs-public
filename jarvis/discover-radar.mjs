#!/usr/bin/env node
// jarvis/discover-radar.mjs — curated "(HIRING LIST)" posts and in-house hiring
// posts, read from LinkedIn every week without him asking (2026-10-31).
//
// WHY THIS SOURCE
// ───────────────
// He reads LinkedIn lists like Grace Gong's weekly "On My Radar" (35 companies
// a week per field, ranked by 90-day headcount growth, sourced from Harmonic, a
// paid startup database with no public API). Checked by hand on 2026-10-31:
// of 603 companies on 52 such lists, Jarvis tracked 268; the physical-AI and
// robotics lists were 82-100% covered, robotic surgery, chip design and the YC
// hard-tech batches 4-29%. The lists exist only behind LinkedIn's login: her
// logged-out profile page shows nine recent posts and none of the lists.
//
// HOW IT READS THEM
// ─────────────────
// The signed-in, read-only LinkedIn MCP (OUTREACH.md §2a) is the only reader,
// and only a Claude session can call it. So this runs the local `claude` CLI
// headless with ONE tool allowed (search_posts) and reads the posts out of the
// tool results in its stream-json output — the model only runs the searches,
// it never retypes a company name. The project's PreToolUse guard
// (linkedin-mcp-guard.mjs) spaces every call 20-30 s, as for any session.
//
// WHAT IT DOES WITH THEM
// ──────────────────────
//   lists  → every US company on a hardware list (radarListRe on the title),
//            and hardware-sounding ones on mixed lists (ycRoleHintRe on its
//            description), go into the employer ledger (source 'radar') and
//            through the board resolver. Postings come from the boards, never
//            from LinkedIn.
//   leads  → "<company> hiring" for the companies he applied to in the last 30
//            days with nobody saved: a post by someone whose headline names that
//            company and who says they are hiring is saved to the Outreach tab,
//            tied to his application, with the post quoted. No message drafted.
//
// Usage:
//   node jarvis/discover-radar.mjs                 # lists + leads, report only
//   node jarvis/discover-radar.mjs --write         # …ledger + resolver + Outreach tab
//   node jarvis/discover-radar.mjs --lists-only | --leads-only [--max 6]
//   node jarvis/discover-radar.mjs --from <dump.txt|.json> [--write]   # parse saved search text

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { guardArgs } from './cli.mjs';
import { discovery } from './targeting.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const STORE = path.join(ROOT, 'data', 'jarvis');
const SEEN_FILE = path.join(STORE, 'radar-seen.json');
const LOG_FILE = path.join(STORE, 'coverage-log.jsonl');

const RADAR_QUERIES = [...(discovery.radarQueries || [])];
const LIST_RE = discovery.radarListRe || null;
const HINT_RE = discovery.ycRoleHintRe || null;
const FIELD_RE = discovery.auditStrongFieldRe || discovery.auditFieldRe || null;
const OFF_FIELD_RE = discovery.auditOffFieldRe || null;

// ── parsing ─────────────────────────────────────────────────────────

/** One search's text → its posts, each { author, headline, age, body }. */
export function splitPosts(text) {
  const out = [];
  for (const chunk of String(text || '').split(/\n?Feed post\n/).slice(1)) {
    const lines = chunk.split('\n').map((l) => l.trim());
    const head = lines.filter(Boolean);
    const author = (head[0] || '').replace(/\s+reposted this$/, '');
    // After the name: an optional "• 3rd+" degree line, then the headline.
    const rest = head.slice(1).filter((l) => !/^[•·]/.test(l) && !/^(View my services|Book an appointment|Visit my website|View my portfolio|Following|She\/Her|He\/Him)$/i.test(l));
    const headline = rest[0] || '';
    const follow = lines.findIndex((l) => /^(Follow|Connect)$/.test(l));
    const ageLine = head.find((l) => /^(?:with .+ • )?\d+[hdwmoy]+\b/.test(l)) || '';
    const bodyStart = follow >= 0 ? follow + 1 : lines.indexOf(ageLine) + 1;
    const body = lines.slice(bodyStart).join('\n').split(/\n… more\n?/)[0].trim();
    out.push({ author, headline, age: ageLine, body });
  }
  return out;
}

/** "Fremont" / "Santa Clara" / "Cambridge, MA" / "US" — a place we treat as the US unless it says otherwise. */
const NON_US_RE = /\b(?:china|shenzhen|beijing|shanghai|hangzhou|suzhou|tianjin|japan|tokyo|yokohama|korea|seoul|seongnam|singapore|uk\b|united kingdom|london|oxford|bristol|glasgow|manchester|belfast|yarnton|england|scotland|ireland|dublin|germany|munich|berlin|stuttgart|metzingen|freiburg|darmstadt|tübingen|tubingen|france|paris|netherlands|amsterdam|eindhoven|nijmegen|israel|tel aviv|rehovot|canada|toronto|markham|burnaby|montreal|vancouver|india|bangalore|bengaluru|switzerland|zurich|zürich|bern|epalinges|geneva|sweden|stockholm|finland|helsinki|norway|spain|barcelona|madrid|italy|milan|genoa|hong kong|taipei|taiwan|australia|sydney|melbourne|poland|warsaw|croatia|hungary|bratislava|slovakia|belgium|denmark|copenhagen|austria|vienna|brazil|são paulo|sao paulo|new zealand|tauranga|milton|lisbon|portugal|canberra|abu dhabi|dubai|uae|noida|hyderabad|toulouse|espoo|gilching|harwell|daejeon|christchurch|renens|wiener neustadt)\b/i;
const US_MARK_RE = /,\s*(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b|\b(?:US|USA|United States)\b/;

/** Every city the store has seen on a US posting ("fremont", "oxnard"…), read once. */
let US_CITIES = null;
export function usCities(jobsDb = path.join(STORE, 'jobs.db')) {
  if (US_CITIES) return US_CITIES;
  US_CITIES = new Set();
  try {
    const db = new DatabaseSync(jobsDb, { readOnly: true });
    for (const r of db.prepare("SELECT DISTINCT location FROM jobs WHERE location_bucket = 'us' AND location LIKE '%,%'").iterate()) {
      for (const seg of String(r.location).split(/[;|·]/)) {
        const m = seg.trim().match(/^([A-Za-z .'-]{3,40}),\s*(?:[A-Z]{2}\b|[A-Za-z ]+)/);
        if (m) US_CITIES.add(m[1].trim().toLowerCase());
      }
    }
    db.close();
  } catch { /* no store: only the state and country marks answer */ }
  return US_CITIES;
}

/**
 * Is a list's "(City)" in the US? Yes when it carries a state or "US", or the
 * store has seen that city on a US posting; no for a known foreign place and
 * for anything else (the 2026-10-31 space list put Gilching, Toulouse, Espoo
 * and Noida through a foreign-names-only check). No city at all: kept.
 */
export function isUs(hq, cities = usCities()) {
  const s = String(hq || '').trim();
  if (!s || /undisclosed/i.test(s)) return true;
  if (US_MARK_RE.test(s)) return true;
  if (NON_US_RE.test(s)) return false;
  return cities.has(s.split(',')[0].trim().toLowerCase());
}

/** The "(HIRING LIST)" posts in one search's text → [{ title, week, companies: [{ name, what, hq }] }]. */
export function parseLists(text) {
  const lists = [];
  for (const post of splitPosts(text)) {
    const m = post.body.match(/^([A-Z0-9][A-Z0-9 &/,'’+.-]{3,80}?)\s*\((?:HIRING|HIRING GRADUATES) LIST\)/m);
    if (!m) continue;
    const week = (post.body.match(/\b(?:Week|Ep)\s+(\d+)\b/) || [])[1] || '';
    const companies = [];
    for (const line of post.body.split('\n')) {
      // "Name - what it does (City)"   or   "Name - what it does"
      const c = line.match(/^(?:\d+[.)]\s*)?([^\n–-]{2,70}?)\s*[-–]\s+(.{3,120}?)(?:\s*\(([^()]{2,40})\))?\s*$/);
      if (!c || /career page|follow me|special thanks|for more on|full credit/i.test(line)) continue;
      companies.push({ name: c[1].trim(), what: c[2].trim(), hq: (c[3] || '').trim() });
    }
    if (companies.length >= 5) lists.push({ title: m[1].trim(), week, author: post.author, companies });
  }
  return lists;
}

/** Which companies on these lists are worth a board search: US, and hardware by list or by description. */
export function radarCompanies(lists, { listRe = LIST_RE, hintRe = HINT_RE, cities } = {}) {
  const byName = new Map();
  for (const l of lists) {
    const wholeList = !!(listRe && listRe.test(l.title));
    for (const c of l.companies) {
      if (!isUs(c.hq, cities)) continue;
      if (!wholeList && !(hintRe && hintRe.test(c.what))) continue;
      const k = c.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, { ...c, lists: [] });
      byName.get(k).lists.push(`${l.title}${l.week ? ` (week ${l.week})` : ''}`);
    }
  }
  return [...byName.values()];
}

const HIRING_RE = /\b(?:i'?m hiring|we'?re hiring|we are hiring|(?:my|our) team(?: at [^.\n]{2,40})? is hiring|is hiring (?:a|an|for)|join (?:my|our) team|come work with (?:me|us)|send me a (?:dm|message)|dm me|apply or send|reach out to me|shoot (?:me|over) your resume)\b/i;
const AGENCY_RE = /\b(?:recruit\w* (?:agency|firm|partner)|staffing|talent solutions|headhunt\w*|executive search|placement|consultancy|my client|confidential client|on behalf of)\b/i;

/**
 * In-house hiring posts at one company: the writer's headline names the
 * company, the post says they are hiring, and it is not an agency's.
 */
export function hiringPosts(text, company, { fieldRe = FIELD_RE, offFieldRe = OFF_FIELD_RE } = {}) {
  const words = String(company).toLowerCase().replace(/\b(inc|corp(oration)?|llc|ltd|technologies|technology|group|motor company)\b\.?/g, '').replace(/[,.]+$/g, '').trim();
  if (words.length < 3) return [];
  const re = new RegExp(`\\b${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i');
  return splitPosts(text).filter((p) => re.test(p.headline) && HIRING_RE.test(p.body) && !AGENCY_RE.test(`${p.headline} ${p.body}`)
    // HIS FIELD, NOT JUST HIS EMPLOYER (2026-10-31): the first live run saved
    // four NVIDIA people from data engineering and DevOps to his hardware
    // application. The writer or the post has to be about the field, and a
    // writer whose headline is software work is not.
    && (!fieldRe || fieldRe.test(`${p.headline} ${p.body}`)) && !(offFieldRe && offFieldRe.test(p.headline)));
}

/** Person and post links from a search's references, by the writer's name. */
export function linksFor(refs, name) {
  const person = (refs || []).find((r) => r.kind === 'person' && String(r.text || '').trim() === name);
  const slug = person ? String(person.url).replace(/^\/in\//, '').replace(/\/$/, '') : '';
  const post = slug ? (refs || []).find((r) => r.kind === 'feed_post' && String(r.url).startsWith(`/posts/${slug}_`)) : null;
  return {
    profile: slug ? `https://www.linkedin.com/in/${slug}/` : '',
    post: post ? `https://www.linkedin.com${post.url}` : '',
  };
}

// ── reading LinkedIn through the CLI ────────────────────────────────

/** Every search_posts result in a stream-json transcript → [{ text, refs }]. */
export function searchResults(streamJson) {
  const out = [];
  for (const line of String(streamJson || '').split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const content = ev?.message?.content;
    if (ev?.type !== 'user' || !Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      const raw = Array.isArray(c.content) ? c.content.map((x) => x?.text || '').join('') : String(c.content || '');
      let j; try { j = JSON.parse(raw); } catch { continue; }
      const text = j?.sections?.search_results;
      if (text) out.push({ text, refs: j?.references?.search_results || [], url: j.url || '' });
    }
  }
  return out;
}

/** Run the searches in a headless Claude session that may call search_posts and nothing else. */
export function runSearches(queries, { bin = 'claude', datePosted = 'past-month', pages = 3, timeoutMs = 40 * 60 * 1000 } = {}) {
  const prompt = [
    'Call the tool mcp__linkedin__search_posts once for each search below, in order, one call at a time,',
    `with date_posted "${datePosted}" and max_pages ${pages}. Do not summarise, do not call any other tool,`,
    'and when the last search has returned, call mcp__linkedin__close_session and reply DONE.',
    '', ...queries.map((q, i) => `${i + 1}. keywords: ${q}`),
  ].join('\n');
  // The prompt goes in on stdin, as leads.mjs does: on Windows `claude` is a
  // .cmd shim that needs the shell, and the shell does not quote arguments, so
  // every argument here is a single word.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
    '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__linkedin__search_posts', 'mcp__linkedin__close_session'];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: ROOT, windowsHide: true, shell: process.platform === 'win32' });
    child.stdin.end(prompt);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ results: [], error: String(e.message || e) }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const results = searchResults(out);
      resolve({ results, error: results.length ? '' : (err.trim().slice(0, 300) || `claude exited ${code} with no search results`) });
    });
  });
}

// ── the two jobs ────────────────────────────────────────────────────

/** The pid holding the ledger's lock when it is a live process other than our parent, else 0. */
function ledgerBusy() {
  try {
    const held = JSON.parse(readFileSync(path.join(STORE, 'universe.lock'), 'utf8'));
    if (!held?.pid || held.pid === process.ppid || held.pid === process.pid) return 0;
    process.kill(held.pid, 0);
    return held.pid;
  } catch { return 0; }
}

function readSeen() { try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')); } catch { return { lists: {} }; } }

/** Companies he applied to in the last `days` with nobody saved there yet, newest application first. */
export function leadTargets({ days = 30, max = 6, jobsDb = path.join(STORE, 'jobs.db'), saved = () => 0 } = {}) {
  const db = new DatabaseSync(jobsDb, { readOnly: true });
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = db.prepare(`SELECT company, id, title, applied_at FROM jobs
    WHERE status IN ('applied','responded','interview') AND applied_at >= ? ORDER BY applied_at DESC`).all(since);
  db.close();
  const seen = new Set(), out = [];
  for (const r of rows) {
    const k = String(r.company).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (saved(r.company) > 0) continue;
    out.push({ company: r.company, jobId: r.id, title: r.title });
    if (out.length >= max) break;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
  const write = args.includes('--write');
  const doLists = !args.includes('--leads-only');
  const doLeads = !args.includes('--lists-only') && !args.includes('--from');
  const max = Number(flag('max', 6));
  const at = new Date().toISOString();

  if (!RADAR_QUERIES.length && !args.includes('--from')) {
    console.log('discover-radar: this field has no list searches (radarQueries) — nothing to do.');
    return;
  }

  // ── lists ──
  if (doLists) {
    let texts = [];
    const from = flag('from', '');
    if (from) {
      const raw = readFileSync(from, 'utf8');
      texts = from.endsWith('.json') ? searchResults(raw).map((r) => r.text) : [raw];
      if (!texts.length) try { texts = [JSON.parse(raw)?.sections?.search_results || raw]; } catch { texts = [raw]; }
    } else {
      console.log(`discover-radar: ${RADAR_QUERIES.length} list searches on LinkedIn (20-30 s apart)…`);
      const r = await runSearches(RADAR_QUERIES, { pages: 3 });
      if (r.error) console.log(`  ⚠ ${r.error}`);
      texts = r.results.map((x) => x.text);
    }
    const lists = texts.flatMap(parseLists);
    const seen = readSeen();
    const fresh = lists.filter((l) => !seen.lists[`${l.title}|${l.week}`]);
    const companies = radarCompanies(lists);
    console.log(`  ${lists.length} hiring lists read (${fresh.length} not seen before), ${companies.length} US hardware companies on them`);
    if (write && companies.length) {
      const u = await import('./universe.mjs');
      const db = u.openUniverse();
      const known = new Set(db.prepare("SELECT key FROM employers WHERE state IN ('tracked','disabled','gated')").all().map((r) => r.key));
      const ing = u.ingest(db, companies.map((c) => ({ name: c.name, titles: [c.what], hardware: 1 })), 'radar');
      const due = companies.filter((c) => !known.has(u.keyOf(u.plainName(c.name))));
      console.log(`  ledger: ${ing.added} new, ${ing.seen} known; ${due.length} without a board → resolver`);
      // One resolve run at a time (two trip the shared ATS rate limits). Inside
      // the daily pass the lock is our parent's; held by anyone else, the names
      // stay pending in the ledger and the next resolve run takes them first
      // (hardware rows are due before the rest).
      const busy = ledgerBusy();
      if (busy && due.length) console.log(`  the ledger is busy (pid ${busy}) — ${due.length} left pending for the next resolve run`);
      const settled = due.length && !busy ? await u.resolveNames(db, due.map((c) => ({ name: c.name.replace(/,/g, ' ') })), { write: true }) : {};
      for (const l of lists) seen.lists[`${l.title}|${l.week}`] = at;
      writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 1));
      appendFileSync(LOG_FILE, `${JSON.stringify({ at, cmd: 'radar', lists: lists.length, fresh: fresh.length, companies: companies.length, added: ing.added, resolved: settled })}\n`);
    } else {
      for (const c of companies.slice(0, 60)) console.log(`    ${c.name} — ${c.what}${c.hq ? ` (${c.hq})` : ''}`);
    }
  }

  // ── leads ──
  if (doLeads) {
    const contacts = await import('./contacts.mjs');
    const targets = leadTargets({ max, saved: (co) => contacts.atCompany(co).length });
    if (!targets.length) { console.log('  leads: every company he applied to this month already has someone saved'); return; }
    console.log(`  leads: "<company> hiring" for ${targets.map((t) => t.company).join(', ')}`);
    const r = await runSearches(targets.map((t) => `${t.company} hiring`), { pages: 1 });
    if (r.error) console.log(`  ⚠ ${r.error}`);
    let saved = 0;
    targets.forEach((t, i) => {
      const res = r.results[i];
      if (!res) return;
      for (const p of hiringPosts(res.text, t.company)) {
        const links = linksFor(res.refs, p.author);
        const id = contacts.contactId(t.company, p.author);
        if (contacts.getContact(id)) continue;
        const quote = p.body.replace(/\s+/g, ' ').slice(0, 320);
        console.log(`    ${t.company}: ${p.author} — ${p.headline.slice(0, 80)}`);
        if (!write) continue;
        contacts.saveContact({
          job_id: t.jobId, company: t.company, name: p.author, title: p.headline.slice(0, 200),
          persona: /recruit|talent|people|hr\b/i.test(p.headline) ? 'recruiter' : 'hiring-manager',
          channel: 'linkedin', linkedin_url: links.profile, status: 'drafted', draft: '',
          note: `Found ${at.slice(0, 10)} by the weekly LinkedIn post search (discover-radar), post ${p.age.split('•').pop().trim()} old: "${quote}"${links.post ? ` ${links.post}` : ''}. Tied to his application: ${t.title}.`,
        });
        saved++;
      }
    });
    console.log(`  leads: ${saved} in-house hiring post${saved === 1 ? '' : 's'} ${write ? 'saved to the Outreach tab' : 'found (dry run)'}`);
    if (write) appendFileSync(LOG_FILE, `${JSON.stringify({ at, cmd: 'radar-leads', companies: targets.length, saved })}\n`);
  }
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  guardArgs({ usage: 'node jarvis/discover-radar.mjs [--write] [--lists-only|--leads-only] [--max N] [--from <file>]',
    flags: ['--write', '--lists-only', '--leads-only', '--max', '--from'], valued: ['--max', '--from'] });
  mkdirSync(STORE, { recursive: true });
  await main();
}
