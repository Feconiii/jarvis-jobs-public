/**
 * WHAT WE ALREADY DECIDED ABOUT A PERSON (2026-10-05).
 *
 * Every person looked at for outreach gets a verdict, kept, so the next run at
 * that company does not research them again from scratch — and the reason a
 * person was set aside is not lost. From the pipeline he settled on with
 * ChatGPT's notes: live job → org → names from a broad web search → pivot on
 * each name → verify at the source → classify → rank → stop at about three.
 *
 *   status  strong | possible | rejected
 *   label   role-specific  posted or recruits for this exact role or req
 *           org-specific   runs or recruits for the exact team, with evidence
 *                          of hiring involvement, not necessarily this req
 *           adjacent       same broader org, no hiring involvement found
 *                          (usually not contacted)
 *   reason  free text; the usual ones are REASONS below (a default, not a list
 *           to pick from — judgment over rules, his words 2026-10-05)
 *
 *   node jarvis/lead-verdicts.mjs set  --company <co> --name "<p>" --status rejected --reason "stale hiring evidence" [--label adjacent] [--profile <url>] [--job <id>] [--note "…"]
 *   node jarvis/lead-verdicts.mjs list --company <co>
 *   node jarvis/lead-verdicts.mjs check --company <co> --name "<p>"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardArgs } from './cli.mjs';
import { outreachDb, outreachDbPath } from './outreach-db.mjs';

export const STATUSES = ['strong', 'possible', 'rejected'];
export const LABELS = ['role-specific', 'org-specific', 'adjacent'];
export const REASONS = ['peer IC', 'stale hiring evidence', 'wrong team', 'senior-only roles', 'role expired', 'no outreach invitation', 'graduation mismatch', 'sponsorship mismatch', 'duplicate coverage', 'executive', 'no Message access'];

const DDL = `
CREATE TABLE IF NOT EXISTS lead_verdicts (
  company     TEXT NOT NULL,
  person_key  TEXT NOT NULL,
  name        TEXT NOT NULL,
  profile_url TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  job_id      TEXT NOT NULL DEFAULT '',
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (company, person_key)
);
`;
const db = (dbPath = outreachDbPath()) => outreachDb(dbPath, { ddl: DDL });

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** A company and a person, as keys: the profile slug when known, else the folded name. */
export const companyKey = (c) => fold(String(c).replace(/\b(?:inc|corp(?:oration)?|llc|ltd|solutions)\b\.?/gi, ''));
export function personKey({ name = '', profile = '' }) {
  const slug = String(profile).match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  return slug ? `in:${slug.toLowerCase()}` : `name:${fold(name)}`;
}

export function setVerdict({ company, name, profile = '', status, label = '', reason = '', note = '', jobId = '' }, { dbPath, now = new Date() } = {}) {
  if (!company || !name) throw new Error('a verdict needs the company and the person');
  if (!STATUSES.includes(status)) throw new Error(`status is one of ${STATUSES.join(', ')}`);
  if (label && !LABELS.includes(label)) throw new Error(`label is one of ${LABELS.join(', ')}`);
  if (status === 'rejected' && !reason) throw new Error('a rejection keeps its reason: that is the point of keeping it');
  const d = db(dbPath);
  const ck = companyKey(company);
  const pk = personKey({ name, profile });
  // The same person found by name earlier and by profile now is one row.
  const byName = `name:${fold(name)}`;
  if (pk !== byName) d.prepare('DELETE FROM lead_verdicts WHERE company = ? AND person_key = ?').run(ck, byName);
  d.prepare(`INSERT INTO lead_verdicts (company, person_key, name, profile_url, status, label, reason, note, job_id, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(company, person_key) DO UPDATE SET name = excluded.name, profile_url = CASE WHEN excluded.profile_url <> '' THEN excluded.profile_url ELSE profile_url END,
      status = excluded.status, label = excluded.label, reason = excluded.reason, note = excluded.note, job_id = excluded.job_id, decided_at = excluded.decided_at`)
    .run(ck, pk, name, profile, status, label, reason, note, jobId, now.toISOString());
  return getVerdict({ company, name, profile }, { dbPath });
}

/** The verdict on this person at this company, by profile or by name; null when never judged. */
export function getVerdict({ company, name = '', profile = '' }, { dbPath } = {}) {
  const d = db(dbPath);
  const ck = companyKey(company);
  for (const key of [personKey({ name, profile }), `name:${fold(name)}`]) {
    const r = d.prepare('SELECT * FROM lead_verdicts WHERE company = ? AND person_key = ?').get(ck, key);
    if (r) return r;
  }
  if (name) {
    const r = d.prepare('SELECT * FROM lead_verdicts WHERE company = ?').all(ck).find((x) => fold(x.name) === fold(name));
    if (r) return r;
  }
  return null;
}

export function listVerdicts(company, { dbPath } = {}) {
  return db(dbPath).prepare('SELECT * FROM lead_verdicts WHERE company = ? ORDER BY CASE status WHEN \'strong\' THEN 0 WHEN \'possible\' THEN 1 ELSE 2 END, decided_at DESC').all(companyKey(company));
}

const line = (v) => `${v.status.padEnd(8)} ${v.name}${v.label ? ` · ${v.label}` : ''}${v.reason ? ` · ${v.reason}` : ''}${v.note ? ` · ${v.note}` : ''} (${v.decided_at.slice(0, 10)})`;

function main() {
  guardArgs({
    usage: 'usage: node jarvis/lead-verdicts.mjs set|list|check --company <co> [--name <p>] [--status s] [--label l] [--reason r] [--profile url] [--job id] [--note n]',
    flags: ['--company', '--name', '--status', '--label', '--reason', '--profile', '--job', '--note'],
    valued: ['--company', '--name', '--status', '--label', '--reason', '--profile', '--job', '--note'],
  });
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
  const [cmd, company] = [args[0], opt('--company')];
  if (!['set', 'list', 'check'].includes(cmd) || !company) { console.log('usage: node jarvis/lead-verdicts.mjs set|list|check --company <co> …'); process.exitCode = 1; return; }
  if (cmd === 'list') { const all = listVerdicts(company); console.log(all.length ? all.map(line).join('\n') : `no verdicts at ${company} yet`); return; }
  if (cmd === 'check') { const v = getVerdict({ company, name: opt('--name'), profile: opt('--profile') }); console.log(v ? line(v) : 'never judged'); return; }
  try {
    const v = setVerdict({ company, name: opt('--name'), profile: opt('--profile'), status: opt('--status'), label: opt('--label'), reason: opt('--reason'), note: opt('--note'), jobId: opt('--job') });
    if (v.reason && !REASONS.includes(v.reason)) console.log(`(new reason "${v.reason}": fine — the usual ones are ${REASONS.join(', ')})`);
    console.log(`saved: ${line(v)}`);
  } catch (e) { console.log(e.message); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
