#!/usr/bin/env node
/**
 * THE APPLICATION PLATFORMS, AND HOW WELL JARVIS DRIVES EACH ONE.
 *
 *   node jarvis/ats-report.mjs            table in the terminal
 *   node jarvis/ats-report.mjs --md       also rewrite jarvis/ATS.md
 *   node jarvis/ats-report.mjs --json     the whole thing as JSON
 *
 * His ask, 2026-09-24: "a list of job application sites and vendors we have
 * met … which companies have them, status overall on how good we are at
 * automating those, known issues, architectures, easy versus difficult,
 * reliability, all the relevant metrics to track it."
 *
 * Two halves. What a vendor IS — its hosts, how it is built, where it walls
 * him off, which faults belong to it — is written by hand in
 * jarvis/ats-registry.json, because it is judgement read off live pages. What
 * a vendor is DOING — postings, companies, runs, fill and upload rates, how
 * often he corrected an answer, whether its faults are open — is counted here
 * from the store, data/jarvis/answer-log.jsonl and jarvis/FAULTS.md, so it is
 * never stale. Read-only: nothing here writes to the store.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REGISTRY = JSON.parse(readFileSync(path.join(HERE, 'ats-registry.json'), 'utf8'));

const compiled = REGISTRY.vendors.map((v) => ({
  ...v,
  hostRes: (v.hosts || []).map((h) => new RegExp(h, 'i')),
  urlRe: v.urlMatch ? new RegExp(v.urlMatch, 'i') : null,
}));

/** Which vendor owns this posting: its host first, then the provider that found it. */
export function vendorOf(url, source = '') {
  let u = null;
  try { u = new URL(url); } catch { /* not a URL: fall through to the source */ }
  if (u) {
    const h = u.hostname.toLowerCase();
    for (const v of compiled) if (v.hostRes.some((re) => re.test(h))) return v.key;
    for (const v of compiled) if (v.urlRe && v.urlRe.test(u.search)) return v.key;
  }
  if (source) for (const v of compiled) if ((v.sources || []).includes(source)) return v.key;
  return 'other';
}

/** The status a fault's own heading gives it, the LAST heading with that id winning (ids are reused). */
export function faultStatuses(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^##\s+(F-\d+)\s+·\s+(.*)$/);
    if (!m) continue;
    const parts = m[2].split(' · ').map((s) => s.trim());
    const status = parts.slice(2).join(' · ').replace(/`/g, '') || parts.slice(1).join(' · ').replace(/`/g, '');
    const open = /\b(open|unverified|diagnosed|measured|recorded|user|partly|not fixed|raised)\b/i.test(status)
      && !/\bverified in his\b/i.test(status);
    out.set(m[1], { title: parts[0], status: status || '(no status in heading)', open });
  }
  return out;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);

export function buildReport({ dbPath = path.join(ROOT, 'data/jarvis/jobs.db'), logPath = path.join(ROOT, 'data/jarvis/answer-log.jsonl'), faultsPath = path.join(HERE, 'FAULTS.md') } = {}) {
  const V = new Map(compiled.map((v) => [v.key, {
    key: v.key, name: v.name, difficulty: v.difficulty, automation: v.automation,
    live: 0, companies: new Map(), applied: 0, engineRan: 0,
    reports: [], plan: {}, final: {}, lastRun: null,
  }]));
  V.set('other', { key: 'other', name: 'Other / unclassified', difficulty: '', automation: '', live: 0, companies: new Map(), applied: 0, engineRan: 0, reports: [], plan: {}, final: {}, lastRun: null });

  // THE STORE — what exists on each platform, and what he did with it.
  const jobs = new Map();
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    for (const r of db.prepare('SELECT id, company, url, source, gone_at, status, applied_at FROM jobs').all()) {
      const key = vendorOf(r.url, r.source);
      jobs.set(r.id, key);
      const v = V.get(key);
      if (r.gone_at == null) { v.live += 1; v.companies.set(r.company, (v.companies.get(r.company) || 0) + 1); }
      if (r.status === 'applied') v.applied += 1;
      if (r.applied_at) v.engineRan += 1;
    }
    db.close();
  }

  // THE ANSWER LOG — what the engine did on each platform, and what he changed.
  let range = [null, null];
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    for (const l of lines) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (/^(localhost|127\.0\.0\.1)/.test(r.host || '')) continue;   // test pages
      range = [range[0] || r.at, r.at || range[1]];
      const key = r.pageUrl ? vendorOf(r.pageUrl) : (jobs.get(r.jobId) || 'other');
      const v = V.get(key === 'other' && r.jobId && jobs.get(r.jobId) ? jobs.get(r.jobId) : key);
      if (r.kind === 'report') { v.reports.push(r); if (!v.lastRun || r.at > v.lastRun) v.lastRun = r.at; }
      else if (r.kind === 'plan') v.plan[r.action] = (v.plan[r.action] || 0) + 1;
      else if (r.kind === 'final') v.final[r.status] = (v.final[r.status] || 0) + 1;
    }
  }

  const faults = existsSync(faultsPath) ? faultStatuses(readFileSync(faultsPath, 'utf8')) : new Map();
  const WALL = /sign in|signed in|create an account|human-verification|verification check|email/i;

  const rows = [];
  for (const reg of [...compiled, { key: 'other', name: 'Other / unclassified', faults: [] }]) {
    const v = V.get(reg.key);
    const R = v.reports;
    const planned = Object.values(v.plan).reduce((a, b) => a + b, 0);
    const decided = planned - (v.plan.skip || 0);
    const answered = (v.final.kept || 0) + (v.final.changed || 0) + (v.final.cleared || 0) + (v.final.edited || 0);
    const changed = (v.final.changed || 0) + (v.final.cleared || 0) + (v.final.edited || 0);
    const walled = R.filter((r) => WALL.test(String(r.stoppedBecause || ''))).length;
    const clean = R.filter((r) => !(Array.isArray(r.left) && r.left.length) && !WALL.test(String(r.stoppedBecause || '')) && (Number(r.filled) || 0) > 0).length;
    const fl = (reg.faults || []).map((id) => ({ id, ...(faults.get(id) || { title: '(not in FAULTS.md)', status: '', open: false }) }));
    rows.push({
      key: reg.key, name: reg.name,
      difficulty: reg.difficulty || '', automation: reg.automation || '',
      hosts: reg.hosts || [], scanner: reg.scanner || '', apply: reg.apply || '',
      architecture: reg.architecture || [], walls: reg.walls || [], notes: reg.notes || '',
      livePostings: v.live,
      liveCompanies: v.companies.size,
      topCompanies: [...v.companies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} (${n})`),
      appliedByHim: v.applied,
      engineRan: v.engineRan,
      runs: R.length,
      medianFilled: median(R.map((r) => Number(r.filled) || 0)),
      uploadPct: pct(R.filter((r) => r.uploaded).length, R.length),
      cleanRunPct: pct(clean, R.length),
      wallPct: pct(walled, R.length),
      reachedEndPct: pct(R.filter((r) => r.reachedReview || /Submit is yours|last step before Submit/i.test(String(r.stoppedBecause || ''))).length, R.length),
      avgLeft: R.length ? +(R.reduce((a, r) => a + (Array.isArray(r.left) ? r.left.length : 0), 0) / R.length).toFixed(1) : null,
      unknownPct: pct(v.plan.unknown || 0, decided),
      plannedFields: planned,
      correctedPct: pct(changed, answered),
      corrected: changed,
      heFilledLeft: v.final['you answered'] || 0,
      lastRun: v.lastRun,
      faults: fl,
      openFaults: fl.filter((f) => f.open).map((f) => f.id),
    });
  }
  return { generatedAt: new Date().toISOString(), answerLogRange: range, vendors: rows, replay: null };
}

const n = (x, suffix = '') => (x == null ? '–' : `${x}${suffix}`);

function toMarkdown(rep) {
  const D = { easy: 'easy', medium: 'medium', hard: 'hard', wall: 'wall' };
  const out = [];
  out.push('# Application platforms — what Jarvis meets and how well it drives them');
  out.push('');
  out.push(`Generated ${rep.generatedAt.slice(0, 16).replace('T', ' ')} UTC by \`npm run jarvis:ats -- --md\`. **Do not edit by hand** — facts live in \`jarvis/ats-registry.json\`, numbers are counted from the store, \`data/jarvis/answer-log.jsonl\` and \`jarvis/FAULTS.md\`.`);
  out.push('');
  out.push(`Answer-log window: ${n(rep.answerLogRange[0]?.slice(0, 16))} → ${n(rep.answerLogRange[1]?.slice(0, 16))}. Engine metrics are only as wide as that window; a small \`runs\` number is an anecdote, not a rate.`);
  out.push('');
  if (rep.replay) {
    out.push(`**His answers, replayed** (\`npm run jarvis:replay\`): ${rep.replay.match} of ${rep.replay.total} answers he sent are what today's planner would send (${rep.replay.rate}%); ${rep.replay.differs} differ, ${rep.replay.empty} would be left empty, ${rep.replay.regressions} regress an answer he kept.`);
    out.push('');
  }
  out.push('## Overview');
  out.push('');
  out.push('| Platform | Difficulty | Automation | Live postings | Companies | Applied | Runs | Median filled | Upload | Clean run | Wall | Unknown | Corrected | Open faults |');
  out.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  const shown = rep.vendors.filter((v) => v.livePostings || v.runs || v.appliedByHim || v.key !== 'other');
  for (const v of shown.sort((a, b) => b.livePostings - a.livePostings)) {
    out.push(`| ${v.name} | ${D[v.difficulty] || '–'} | ${v.automation || '–'} | ${v.livePostings} | ${v.liveCompanies} | ${v.appliedByHim} | ${v.runs} | ${n(v.medianFilled)} | ${n(v.uploadPct, '%')} | ${n(v.cleanRunPct, '%')} | ${n(v.wallPct, '%')} | ${n(v.unknownPct, '%')} | ${n(v.correctedPct, '%')} | ${v.openFaults.join(', ') || '–'} |`);
  }
  out.push('');
  out.push('## What the columns mean');
  out.push('');
  out.push('- **Difficulty** — how hard the platform is to drive at all: *easy* (one page, plain controls), *medium* (custom widgets, iframes, multi-step), *hard* (shadow DOM, prompts, sign-in, bot checks), *wall* (nothing to fill until he passes a sign-in, email code or account step). Judgement, in the registry.');
  out.push('- **Automation** — *works* (fills end to end, verified live), *partial* (fills, with known gaps), *wall* (stops correctly at a step that is his), *listing-only* (we read postings there; applying happens elsewhere), *untested* (never driven).');
  out.push('- **Live postings / Companies** — open rows in the store whose apply page is on this platform.');
  out.push('- **Applied** — rows HE marked applied. Nothing else counts as an application.');
  out.push('- **Runs** — fill reports in the answer-log window.');
  out.push('- **Median filled** — fields filled per run (one run is one page or one walk).');
  out.push('- **Upload** — runs that attached the resume.');
  out.push('- **Clean run** — runs that filled something, left nothing for him and did not stop at a wall. The closest thing to "reliability".');
  out.push('- **Wall** — runs that stopped at a sign-in, email or verification step.');
  out.push('- **Unknown** — planned fields the engine could not answer (skips excluded).');
  out.push('- **Corrected** — of the answers Jarvis gave that were read back at Next/Submit, the share he changed, cleared or edited. Only runs since read-back existed count.');
  out.push('- **Open faults** — faults listed for the platform whose heading in FAULTS.md is not closed.');
  out.push('');
  out.push('## Platform by platform');
  for (const v of shown) {
    if (v.key === 'other') continue;
    out.push('');
    out.push(`### ${v.name}`);
    out.push('');
    out.push(`**${v.difficulty || '–'} · ${v.automation || '–'}** — ${v.livePostings} live postings at ${v.liveCompanies} companies; ${v.appliedByHim} applied by him; ${v.runs} runs in the window${v.lastRun ? `, last ${v.lastRun.slice(0, 16).replace('T', ' ')}` : ''}.`);
    out.push('');
    if (v.topCompanies.length) out.push(`- **Who uses it:** ${v.topCompanies.join(', ')}`);
    if (v.hosts.length) out.push(`- **Recognised by:** ${v.hosts.map((h) => `\`${h}\``).join(', ')}`);
    if (v.scanner) out.push(`- **Discovery:** ${v.scanner}`);
    if (v.apply) out.push(`- **Applying:** ${v.apply}`);
    if (v.architecture.length) out.push(`- **How it is built:** ${v.architecture.join('; ')}`);
    if (v.walls.length) out.push(`- **Walls (his to pass):** ${v.walls.join('; ')}`);
    if (v.runs) out.push(`- **Engine:** median ${n(v.medianFilled)} filled, upload ${n(v.uploadPct, '%')}, clean ${n(v.cleanRunPct, '%')}, wall ${n(v.wallPct, '%')}, ${n(v.avgLeft)} left per run, unknown ${n(v.unknownPct, '%')}${v.corrected ? `, he corrected ${v.corrected} (${n(v.correctedPct, '%')})` : ''}${v.heFilledLeft ? `, he answered ${v.heFilledLeft} Jarvis left` : ''}`);
    if (v.faults.length) {
      out.push('- **Faults:**');
      for (const f of v.faults) out.push(`  - ${f.open ? '**open** ' : ''}${f.id} — ${f.title}${f.status ? ` (${f.status})` : ''}`);
    }
    if (v.notes) out.push(`- **Notes:** ${v.notes}`);
  }
  out.push('');
  out.push('## Keeping it current');
  out.push('');
  out.push('- A new platform met: add an entry to `jarvis/ats-registry.json` (hosts, how it is built, walls, difficulty, automation), then `npm run jarvis:ats -- --md`.');
  out.push('- A fault found on a platform: add its F-id to that vendor\'s `faults`. Its open/closed state is read from its heading in FAULTS.md.');
  out.push('- Postings on the "Other" line are hosts no entry claims — the list of platforms not yet named.');
  out.push('');
  return out.join('\n');
}

function table(rep) {
  const cols = [['Platform', 30], ['Diff', 7], ['Auto', 12], ['Live', 7], ['Cos', 5], ['Appl', 5], ['Runs', 5], ['Fill', 5], ['Up', 5], ['Clean', 6], ['Wall', 5], ['Unk', 5], ['Corr', 5], ['Open faults', 20]];
  const line = (vals) => vals.map((x, i) => String(x ?? '–').slice(0, cols[i][1]).padEnd(cols[i][1])).join(' ');
  const out = [line(cols.map((c) => c[0]))];
  for (const v of rep.vendors.filter((x) => x.livePostings || x.runs || x.key !== 'other').sort((a, b) => b.livePostings - a.livePostings)) {
    out.push(line([v.name, v.difficulty, v.automation, v.livePostings, v.liveCompanies, v.appliedByHim, v.runs, n(v.medianFilled), n(v.uploadPct, '%'), n(v.cleanRunPct, '%'), n(v.wallPct, '%'), n(v.unknownPct, '%'), n(v.correctedPct, '%'), v.openFaults.join(',') || '–']));
  }
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rep = buildReport();
  // The replay loads the planner, so only the CLI pays for it (the tests do not).
  try {
    const { replay } = await import('./replay-answers.mjs');
    const r = replay();
    rep.replay = { total: r.total, match: r.match, rate: r.rate, differs: r.differs, empty: r.empty, regressions: r.regressions };
  } catch { /* no log yet — the line is left out */ }
  if (args.includes('--json')) console.log(JSON.stringify(rep, null, 1));
  else console.log(table(rep));
  if (args.includes('--md')) {
    writeFileSync(path.join(HERE, 'ATS.md'), toMarkdown(rep));
    console.log('\nwrote jarvis/ATS.md');
  }
}
