/**
 * EVERY RESUME ON HIS PHONE (2026-09-27). "put all the resumes into my schools
 * one drive so i can search it and attach on mobile? Name it sth noticeable".
 *
 * Copies the per-application archive (output/jarvis-resumes/sent) into his
 * synced Lakeside OneDrive, one folder per posting, named for the company and
 * the role so a search on the phone finds it. The file inside is always
 * "Alex Rivera Resume.pdf": that is the name a recruiter sees when he attaches it.
 *
 * Run it again any time: a copy is only rewritten when the source changed, and
 * nothing it did not put there is touched.
 *
 *   node jarvis/onedrive-resumes.mjs            # copy
 *   node jarvis/onedrive-resumes.mjs --dry-run  # list what it would do
 */
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { displayTitle } from './outreach.mjs';
import yaml from 'js-yaml';
import { person, DEFAULT_PERSON } from './targeting.mjs';
import { resumeFileName } from './resume-family.mjs';

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// HIS archive, and only his: JARVIS_RESUME_DIR is how a test points a server
// at a temporary folder, so it is deliberately NOT read here. A temp archive
// synced to his OneDrive would prune every real folder not in it.
const SENT = path.join(ROOT, 'output', 'jarvis-resumes', 'sent');
/** More than this many folders gone in one run is a broken archive read, not cleanup. */
const MAX_PRUNE = 10;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
/**
 * WHOSE ONEDRIVE. His is found by name (his school's OneDrive in his user
 * folder) and the folder is "00 JARVIS RESUMES", as it always was. Anyone else
 * says where, or nothing is written: guessing a synced folder on someone
 * else's machine would put their resumes somewhere they never chose.
 *
 *   JARVIS_ONEDRIVE_DIR / JARVIS_ONEDRIVE_FOLDER, or in config/profile.yml:
 *     resumes:
 *       onedrive_dir: "C:/Users/you/OneDrive"
 *       onedrive_folder: "Job Resumes"        # optional
 */
const IS_HIM = person.fullName === DEFAULT_PERSON.fullName;
function profileSetting(key) {
  if (IS_HIM) return '';
  try {
    const file = process.env.JARVIS_PROFILE || path.join(ROOT, 'config', 'profile.yml');
    const doc = yaml.load(readFileSync(file, 'utf8')) || {};
    return String(doc.resumes?.[key] || '').trim();
  } catch { return ''; }
}
export const TOP = process.env.JARVIS_ONEDRIVE_FOLDER || profileSetting('onedrive_folder') || '00 JARVIS RESUMES';
export const ATTACH = resumeFileName();

/** His school OneDrive, or null. */
export function schoolOneDrive(home = HOME) {
  if (process.env.JARVIS_ONEDRIVE_DIR) return process.env.JARVIS_ONEDRIVE_DIR;
  if (!IS_HIM) return profileSetting('onedrive_dir') || null;
  const hit = existsSync(home) ? readdirSync(home).find((n) => /^OneDrive - .*(Lakeside|University)/i.test(n)) : null;
  return hit ? path.join(home, hit) : null;
}

/** A folder name OneDrive accepts on every device: no \ / : * ? " < > |, no trailing dot or space. */
export function folderName(s, max = 90) {
  const t = String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '');
  return cut.replace(/[. ]+$/, '') || 'Untitled';
}

/** The older archive name shape: "Alex-Rivera_<family>_<Company>_<Position>.pdf". */
const LEGACY_PREFIX = `${person.fullName.replace(/\s+/g, '-')}_`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

/** Every archived resume with its company, role, posting and build date. */
export function archive(dir = SENT) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.pdf')) continue;
    const pdf = path.join(dir, f);
    let meta = {};
    try { meta = JSON.parse(readFileSync(`${pdf}.json`, 'utf8')); } catch { /* older builds have no sidecar */ }
    // "Alex Rivera Resume - <family> - <Company> - <Position>.pdf", or the older
    // "Alex-Rivera_<family>_<Company>_<Position-In-Dashes>.pdf".
    const stem = f.replace(/\.pdf$/i, '');
    const old = stem.startsWith(LEGACY_PREFIX) ? stem.split('_') : null;
    const parts = old ? [] : stem.split(' - ');
    const fromName = old
      ? { company: (old[2] || '').replace(/-/g, ' '), title: old.slice(3).join(' ').replace(/-/g, ' ') }
      : { company: parts[2] || '', title: parts.slice(3).join(' - ') };
    // A Workday legal-entity prefix ("0001 Applied Materials, Inc") and a
    // legal suffix are not the name a search is typed with.
    let company = decode(meta.company || fromName.company || (parts[1] ? `General resume (${parts[1]})` : ''))
      .replace(/^\d{2,}\s+/, '').replace(/,?\s+(?:Inc\.?|LLC|Corp\.?|Corporation|Ltd\.?)$/i, '').trim();
    // A title cut short in the filename still carries "Boise Idaho United States Of Amer".
    const title = displayTitle(decode(meta.title || fromName.title || ''))
      .replace(/\s+\S+\s+(?:Idaho|New York|Virginia|Texas|California|Arizona|Utah|Oregon|Washington)\s+United States\b.*$/i, '') || '';
    // A board that filed the title as the company leaves no company to show.
    if (company.toLowerCase() === title.toLowerCase()) company = '';
    const at = meta.at ? new Date(meta.at) : statSync(pdf).mtime;
    out.push({ pdf, company, title, url: meta.url || '', at });
  }
  return out.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title) || a.at - b.at);
}

/**
 * One folder per resume: "<Company> - <Role>". When one role has more than
 * one, the OLDEST keeps the plain name and each later one adds its build date,
 * so a folder on his phone is never renamed by a newer build.
 */
export function plan(items) {
  const used = new Set();
  return [...items].sort((a, b) => a.at - b.at).map((it) => {
    const base = folderName(it.company && it.title ? `${it.company} - ${it.title}` : it.company || it.title || path.basename(it.pdf, '.pdf'));
    let name = used.has(base.toLowerCase()) ? folderName(`${base} (${dayLabel(it.at)})`, 110) : base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    return { ...it, folder: name };
  }).sort((a, b) => a.folder.localeCompare(b.folder));
}

export function copyAll({ dest = schoolOneDrive(), dryRun = false, items = archive() } = {}) {
  if (!dest) throw new Error(IS_HIM ? 'no school OneDrive folder found in your user folder' : 'OneDrive is not configured (set resumes.onedrive_dir in config/profile.yml, or JARVIS_ONEDRIVE_DIR)');
  const top = path.join(dest, TOP);
  let copied = 0; let same = 0;
  const rows = plan(items);
  for (const r of rows) {
    const to = path.join(top, r.folder, ATTACH);
    const fresh = existsSync(to) && statSync(to).size === statSync(r.pdf).size && statSync(to).mtimeMs >= statSync(r.pdf).mtimeMs;
    if (fresh) { same += 1; continue; }
    if (!dryRun) { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(r.pdf, to); }
    copied += 1;
  }
  // A folder this made that no resume maps to any more (the archive file was
  // renamed or removed) goes, so the phone never offers a stale resume. Only
  // a folder holding exactly "Alex Rivera Resume.pdf" and nothing else: anything
  // he put there himself is left alone.
  let removed = 0; let pruneHeld = '';
  const wanted = new Set(rows.map((r) => r.folder.toLowerCase()));
  const stale = !existsSync(top) || !rows.length ? [] : readdirSync(top, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !wanted.has(d.name.toLowerCase()))
    .map((d) => d.name)
    .filter((n) => { const inside = readdirSync(path.join(top, n)); return inside.length === 1 && inside[0] === ATTACH; });
  if (stale.length > MAX_PRUNE) pruneHeld = `${stale.length} folders no longer match the archive; none removed (over ${MAX_PRUNE} at once looks like a bad read)`;
  else {
    for (const n of stale) { if (!dryRun) rmSync(path.join(top, n), { recursive: true }); removed += 1; }
  }
  // A list to search when the phone's search is not enough: company, role, posting.
  if (!dryRun) {
    writeFileSync(path.join(top, 'INDEX.txt'), [
      `Every resume Jarvis built for an application. Each folder holds "${ATTACH}",`,
      'the exact file that went with that application. Search the company name.',
      '',
      ...rows.map((r) => `${r.folder}\n    built ${r.at.toISOString().slice(0, 10)}${r.url ? `  ·  ${r.url}` : ''}`),
      '',
    ].join('\n'));
  }
  return { top, total: rows.length, copied, same, removed, pruneHeld, rows };
}

/**
 * AUTOMATIC (2026-09-27): "have all generated resumes automatically synced to
 * one drive to their respective folder". Called after every resume lands in the
 * archive, and by the dashboard when it starts. Never throws: a missing or
 * locked OneDrive must not fail a resume build.
 */
export function syncToOneDrive({ from = SENT, ...opts } = {}) {
  try {
    if (process.env.JARVIS_ONEDRIVE === 'off') return { skipped: 'switched off' };
    // Only HIS archive: a test's temporary build folder never reaches his OneDrive.
    if (path.resolve(from).toLowerCase() !== path.resolve(SENT).toLowerCase()) return { skipped: 'not his resume archive' };
    if (!opts.dest && !schoolOneDrive()) return { skipped: IS_HIM ? 'no school OneDrive folder' : 'OneDrive not configured' };
    const { rows, ...r } = copyAll(opts);
    return r;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  if (!schoolOneDrive()) {
    console.log(IS_HIM ? 'no school OneDrive folder found in your user folder — nothing copied'
      : 'OneDrive not configured — set resumes.onedrive_dir in config/profile.yml (or JARVIS_ONEDRIVE_DIR). Nothing copied.');
    process.exit(0);
  }
  const r = copyAll({ dryRun });
  console.log(`${dryRun ? "[dry run] " : ""}${r.total} resumes → ${r.top}: ${r.copied} copied, ${r.same} already there, ${r.removed} stale folders removed${r.pruneHeld ? ` (${r.pruneHeld})` : ""}`);
  if (dryRun) for (const x of r.rows.slice(0, 15)) console.log(`  ${x.folder}`);
}
