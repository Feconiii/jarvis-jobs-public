#!/usr/bin/env node
// jarvis/import-descriptions.mjs — carry DESCRIPTIONS through the assisted channel.
//
// WHY THIS EXISTS (F-443). The assisted channel was built for exactly one
// problem — a careers site that refuses a server but serves the user's own
// browser — and it stopped one step short. `import-assist.mjs` and
// `/api/import` carry titles, locations and teams, then hardcode
// `description: ''` into `triage()`. So a browser session that CAN read
// Tesla's detail JSON had nowhere to put what it read.
//
// The cost was not "some rows are unread". `enrich.mjs` selects on
// `source IN (Object.keys(DETAIL))`, and `browser-assist` is not a key, so
// those rows were never attempted: 4,743 live Tesla postings, 1,059 of them
// relevant, all sitting at `enrich_fails = 0`. Never failed, never counted,
// never mentioned in a backlog number. Under F-1/OPT that is the dangerous
// direction of unread — `f_hard_block = 0` is the default for a row nobody
// has examined, so an unreadable posting looks exactly like a clear one.
//
// This writes through the SAME path enrich.mjs uses — `updateJob(id, {...},
// { rederive: true })` — so triage, the visa gate, the salary parse and the
// fit rescore all happen identically. There is no second scoring path to
// drift out of sync with the first, which is the whole point.
//
// Row format (JSON array), one per posting:
//   { url, description }                        — url is matched to the store
//   { id, description }                         — store id, when you have it
//   { url, description, title, location, team } — corrections travel too
//
// Usage:
//   node jarvis/import-descriptions.mjs <file.json>
//   node jarvis/import-descriptions.mjs <file.json> --dry-run
//   node jarvis/import-descriptions.mjs <file.json> --company Tesla

import { readFileSync } from 'fs';
import { getJob, jobId, updateJob, withStoreLock, db } from './store.mjs';
import { htmlToText } from './text.mjs';
import { urlHasReqId } from './req-id.mjs';

// The same floor enrich.mjs uses. A body shorter than this is a cookie banner
// or an error page, and writing it would set has_desc on a row that is still,
// in every sense that matters, unread — which is the fault this file exists to
// stop, re-committed in a new place.
export const MIN_DESCRIPTION = 40;

/**
 * Normalise one harvested row into { id, description, title?, location?, team? }.
 * Returns { error } rather than throwing: a bad row in a 1,000-row harvest
 * should cost that row, not the run.
 */
export function normalizeRow(row) {
  if (!row || typeof row !== 'object') return { error: 'not an object' };
  const rawDesc = row.description ?? row.body ?? row.text ?? '';
  // HTML in, text out — the detail JSON of most careers sites ships markup.
  const description = htmlToText(String(rawDesc)).trim();
  if (!description) return { error: 'no description' };
  if (description.length < MIN_DESCRIPTION) return { error: 'description too short to use' };

  let id = row.id ? String(row.id).trim() : '';
  const url = row.url ? String(row.url).trim() : '';
  // A raw URL is the portable key: the browser knows the page it just read,
  // it does not know our hash. jobId() is the same derivation upsertJobs uses,
  // so a harvest lines up with the rows the scanner already wrote.
  if (!id && url.startsWith('http')) id = jobId(url);

  // A REQUISITION ID IS ALSO A KEY. A harvest that reads an employer's detail
  // API knows the req number it asked for and often nothing else — the API
  // answers by id, not by the marketing URL the store holds. Tesla is the case
  // in hand (`/cua-api/careers/job/273084`), but the shape is common: most
  // boards end the posting URL with the same number. So a row may arrive as
  // `{ reqId }` and be resolved against the store below, where the lookup can
  // be scoped to one employer and actually tested.
  const reqId = row.reqId != null ? String(row.reqId).trim() : '';
  if (!id && !/^\d{2,}$/.test(reqId)) return { error: 'no id and no usable url' };

  const out = id ? { id, description } : { reqId, description };
  if (row.title) out.title = String(row.title).trim();
  if (row.location) out.location = String(row.location).trim();
  if (row.team) out.team = String(row.team).trim();
  if (row.postedAt) {
    const ts = Date.parse(row.postedAt);
    if (!Number.isNaN(ts)) out.postedAt = ts;
  }
  return out;
}

/**
 * Every store row that names this requisition at this employer.
 *
 * TWO KINDS OF "MORE THAN ONE MATCH", and only one of them is dangerous.
 *
 * The dangerous kind is a matcher generous enough to hit a DIFFERENT
 * requisition — `%273084` also matching req 1273084 — which writes one
 * posting's description onto another posting's row and reports success.
 * `urlHasReqId` excludes that, and the employer scope excludes the same number
 * reused at another company.
 *
 * What is left is not ambiguity, it is duplication: Joby carries both
 * `/jobs/3726/job` (from the assisted import) and
 * `/jobs/3726/systems-test-engineer/job` (from the sitemap scan), live and
 * un-superseded, for one job. This first returned null on those — correct by
 * its own rule and useless in practice, since it refused roughly half of the
 * board. Two rows naming one requisition at one employer ARE one posting, so
 * the body belongs on both.
 *
 * Returns [] when nothing matches, and refuses entirely when unscoped and the
 * number appears at more than one employer.
 */
export function resolveReqIds(reqId, company, handle = db()) {
  const req = String(reqId || '');
  if (!/^\d{2,}$/.test(req)) return null;

  // TWO STEPS ON PURPOSE. The database narrows with a plain suffix LIKE, and
  // the separator is checked here, in a regex, where it means what it looks
  // like it means.
  //
  // The single-step version was `url LIKE '%_880002'`, which reads as
  // "underscore then the number" and is not: `_` is a single-character
  // wildcard in LIKE, so it matched `.../other-role-1880002` — one posting's
  // description onto another posting's row, silently, and reported as a
  // successful import. Escaping it is possible and easy to get wrong twice;
  // not relying on LIKE's metacharacters at all is neither.
  // CONTAINS, not ends-with. The narrowing clause used to be `LIKE '%<req>'`,
  // which quietly re-committed the very assumption F-449 had just removed from
  // the regex: it matches Tesla (`...-273084`) and never matches iCIMS
  // (`.../3726/job`). Shared rule, stale query — so every Joby row came back
  // unresolved while the unit tests, written on Tesla-shaped URLs, all passed.
  // The exactness lives in urlHasReqId below; this clause only has to be cheap
  // and not exclude the right row.
  const where = ['url LIKE ?', 'gone_at IS NULL', 'superseded_by IS NULL'];
  const args = [`%${req}%`];
  if (company) { where.push('company = ?'); args.push(company); }
  const rows = handle.prepare(`SELECT id, url, company FROM jobs WHERE ${where.join(' AND ')} LIMIT 50`).all(...args);

  // ONE RULE, SHARED (F-449). This used to anchor the number at the very end of
  // the URL, which is true for Tesla and Greenhouse and false for iCIMS, where
  // the posting is `/jobs/3726/job`. The liveness sweep already knew that and
  // this did not, so a Joby harvest would have matched nothing and reported it
  // as an empty board.
  const hits = rows.filter(r => urlHasReqId(r.url, req));
  if (!hits.length) return [];
  // Unscoped, two employers can legitimately both have a req 770007 and there
  // is no way to tell whose body this is. Refuse rather than pick.
  if (!company) {
    const owners = new Set(hits.map(r => r.company));
    if (owners.size > 1) return [];
  }
  return hits.map(r => r.id);
}

/** Back-compat single answer: the id when exactly one row names this req. */
export function resolveReqId(reqId, company, handle = db()) {
  const ids = resolveReqIds(reqId, company, handle);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Write harvested descriptions onto existing store rows.
 *
 * Never creates a row. A description with no posting behind it is a harvest
 * that drifted from the listing import, and inventing a job from it would put
 * a posting in his deck that no scan ever saw.
 */
export async function importDescriptions(rows, opts = {}) {
  const { dryRun = false, company = null, force = false } = opts;
  const stats = {
    total: rows.length, written: 0, unmatched: 0, skipped: 0,
    alreadyRead: 0, wrongCompany: 0, newBlocks: 0,
    reasons: new Map(), blocks: [],
  };
  const bump = (why) => stats.reasons.set(why, (stats.reasons.get(why) || 0) + 1);

  const writes = [];
  for (const row of rows) {
    const n = normalizeRow(row);
    if (n.error) { stats.skipped++; bump(n.error); continue; }
    // One requisition can name several rows — the same posting under two URL
    // spellings. The body goes on all of them, because they are one job.
    const ids = n.id ? [n.id] : resolveReqIds(n.reqId, company);
    if (!ids.length) { stats.unmatched++; bump('no posting in the store for req ' + n.reqId); continue; }
    for (const id of ids) { queueOne(id, n); }
    continue;
  }

  function queueOne(id, n) {
    const job = getJob(id, { description: false });
    if (!job) { stats.unmatched++; bump('no posting in the store for this url'); return; }
    // A --company guard, because a harvest run against the wrong tab is silent
    // otherwise: the ids simply would not match, and "0 written" reads like an
    // empty board rather than a mistake.
    if (company && String(job.company || '').toLowerCase() !== company.toLowerCase()) {
      stats.wrongCompany++; bump('row belongs to ' + job.company + ', not ' + company); return;
    }
    if (job.hasDesc && !force) { stats.alreadyRead++; return; }
    writes.push({ job, patch: { ...n, id } });
  }

  if (dryRun) {
    stats.written = writes.length;
    return stats;
  }

  await withStoreLock(async () => {
    for (const { job, patch } of writes) {
      const before = job.triage?.flags?.hardBlock;
      // rederive re-runs triage, the visa gate, the salary parse and the fit
      // rescore — identical to enrich.mjs's write-back. A posting read for the
      // first time must not keep the score it got from its title alone.
      updateJob(patch.id, {
        description: patch.description,
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.location ? { location: patch.location } : {}),
        ...(patch.team ? { team: patch.team } : {}),
        ...(patch.postedAt ? { postedAt: patch.postedAt } : {}),
        enrichedAt: new Date().toISOString(),
      }, { rederive: true });
      stats.written++;
      // The reason this whole path matters, said out loud. Reading a posting
      // for the first time is the only moment a work-authorisation wall can be
      // found, and finding one is the point — not a regrettable side effect.
      const after = getJob(patch.id);
      if (!before && after?.triage?.flags?.hardBlock) {
        stats.newBlocks++;
        stats.blocks.push({
          title: after.title,
          company: after.company,
          reason: after.triage?.visa?.block?.reason,
        });
      }
    }
  });
  return stats;
}

const isMain = process.argv[1] && process.argv[1].endsWith('import-descriptions.mjs');
if (isMain) {
  // F-163: not one command in this project handled --help, so --help RAN them.
  const { guardArgs } = await import('./cli.mjs');
  guardArgs({
    usage: `
  node jarvis/import-descriptions.mjs <file.json> [options]

  Write descriptions harvested in his browser onto postings already in the
  store. Never creates a row; never overwrites a body unless asked.

    --company <name>  refuse rows belonging to any other employer
    --dry-run         report what would be written, write nothing
    --force           overwrite a description that is already there
    --help, -h
`,
    flags: ['--company', '--dry-run', '--force'],
    valued: ['--company'],
  });
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  if (!file) {
    console.error('Usage: node jarvis/import-descriptions.mjs <file.json> [--company <Name>] [--dry-run] [--force]');
    process.exit(1);
  }
  const rows = JSON.parse(readFileSync(file, 'utf-8'));
  if (!Array.isArray(rows)) { console.error('Expected a JSON array of rows.'); process.exit(1); }
  const stats = await importDescriptions(rows, {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    company: get('--company') || null,
  });
  const tag = args.includes('--dry-run') ? '(dry run) ' : '';
  console.log('\n' + tag + stats.total + ' rows in -> ' + stats.written + ' descriptions written.');
  if (stats.alreadyRead) console.log('  ' + stats.alreadyRead + ' already had a description (use --force to overwrite)');
  if (stats.unmatched) console.log('  ' + stats.unmatched + ' matched no posting in the store');
  if (stats.wrongCompany) console.log('  ' + stats.wrongCompany + ' belonged to a different employer');
  if (stats.skipped) console.log('  ' + stats.skipped + ' unusable');
  for (const [why, n] of [...stats.reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log('     ' + String(n).padStart(5) + '  ' + why);
  }
  if (stats.newBlocks) {
    console.log('\n  BLOCKED: ' + stats.newBlocks + ' of these hard-block on work authorisation — found only because they were read:');
    for (const b of stats.blocks.slice(0, 10)) console.log('     ' + b.title + ' (' + b.company + ') — ' + b.reason);
  }
  console.log('');
}
