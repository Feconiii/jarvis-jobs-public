#!/usr/bin/env node
/**
 * jarvis/share-export.mjs: publish the code, and only the code, to a second
 * person's copy of Jarvis.
 *
 * This repo's history carries the original user's own material: his bullet
 * pool, house rules, voice notes, faults log, portfolio site, coursework files,
 * and (in commits pushed before 2026-10-16) his phone number. Giving someone
 * this repo gives them all of it, history included. So a second person does
 * not clone it. They clone a SEPARATE repo, and this script fills it: one
 * snapshot commit per run, built from HEAD minus everything personal, so that
 * repo's history has never contained any of it.
 *
 *   node jarvis/share-export.mjs <dir>            # dir = a clone of the share repo (or empty: git init)
 *   node jarvis/share-export.mjs <dir> --public   # the same, de-identified, for a repo anyone can read
 *   node jarvis/share-export.mjs <dir> --dry-run  # list what would be left out, change nothing
 *
 * Before committing it reads every exported file for the original user's
 * contact details (taken from his own gitignored config/profile.yml and
 * data/jarvis/apply-profile.yml, so nothing personal is written here) and
 * refuses if any is found. Pushing the result is left to the person running it.
 *
 * --public also renames him, his school, his employers and the people he wrote
 * to, by the rules in data/jarvis/public-scrub.json (gitignored: the rules name
 * what they remove), and refuses if anything on its `forbid` list survives.
 * The public repo is your-github-user/jarvis-jobs-public; its first copy (2026-09-24)
 * was scrubbed by hand with the same rules.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/**
 * Left out of every export: personal material, his own process notes, and
 * files that only make sense on his machine. EXCLUDE names exact paths;
 * EXCLUDE_PREFIX matches any path that starts with the entry.
 */
export const EXCLUDE = [
  // his writing, rules and resume content
  'voice-dna.md', 'jarvis/preferences.md', 'jarvis/resume-pool.json', 'jarvis/PENDING-CLAIMS.md',
  'jarvis/FAULTS.md', 'jarvis/PROGRESS.md', 'jarvis/ROADMAP.md', 'jarvis/TODO.md', 'jarvis/OUTREACH.md',
  // his scheduled task and the skill it runs (the skill lives in his own ~/.claude)
  'jarvis/daily-picks.prompt.md', 'jarvis/daily-picks.ps1', 'jarvis/register-daily-picks.ps1',
  // replaced below with the shared instructions
  'CLAUDE.md', 'AGENTS.md',
  // sections moved out of CLAUDE.md word for word (2026-11-12): they name him, his school and his people
  'jarvis/COMMANDS.md', 'jarvis/COVERAGE.md',
];
export const EXCLUDE_PREFIX = [
  'jarvis/RESUME-AUDIT-', '.claude/', 'portfolio/', 'graphify-out/', 'share/',
  // his working sessions' notes: the jobs he filed, applied to and pulled
  'jarvis/notes/',
  // coursework files at the root
  'ConnectingRod', 'Piston.', 'FEAProject', 'FEA_Project',
];

export function excluded(file) {
  return EXCLUDE.includes(file) || EXCLUDE_PREFIX.some((p) => file.startsWith(p));
}

/**
 * Test files that check HIS files (his cv.md, bullet pool, faults log, answer
 * corpus, sent resumes). In a copy without them they can only fail, so the
 * exported `jarvis:test` leaves them out. Found by running every test in a
 * fresh export (2026-10-16): these 20 failed, the other 96 passed.
 */
export const PERSONAL_TESTS = [
  'resume-variants', 'dashboard', 'panel-api', 'cover-letter', 'apply-plan', 'resume-tailor',
  'tailor-llm', 'resume-for-job', 'resume', 'fit', 'backup', 'apply-page', 'resume-plan', 'essay',
  'reuse-api', 'earns-its-keep', 'proofread', 'corpus', 'unanswered', 'ats-report',
].map((n) => `jarvis/${n}.test.mjs`);

/** The suite as the exported copy runs it. */
export function sharedTestScript(script) {
  return script.split('&&').map((s) => s.trim())
    .filter((cmd) => !PERSONAL_TESTS.some((t) => cmd.endsWith(` ${t}`)))
    .join(' && ');
}

/**
 * Files kept in share/ and written to the export under another path. The
 * export's own instructions, README and setup guide replace his.
 */
export const SHARE_FILES = {
  'share/AGENTS.md': ['AGENTS.md', 'CLAUDE.md'],
  'share/README.md': ['README.md'],
  'share/SETUP.md': ['SETUP.md'],
  'share/jarvis-setup.SKILL.md': ['.claude/skills/jarvis-setup/SKILL.md'],
  // The LinkedIn MCP in .mcp.json is signed in and has no read-only mode; this
  // attaches the same read-only, paced guard his own machine-local settings do.
  'share/claude-settings.json': ['.claude/settings.json'],
};

export const SCRUB_FILE = 'data/jarvis/public-scrub.json';

/** The --public rules: { replace: [[from, to]], regex: [[source, flags, to]], forbid: [source] }. */
export function loadScrub(root = ROOT) {
  const file = path.join(root, SCRUB_FILE);
  if (!existsSync(file)) throw new Error(`--public needs ${SCRUB_FILE} (the de-identification rules); it is not on this machine.`);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  return {
    replace: s.replace || [],
    regex: (s.regex || []).map(([src, flags, to]) => [new RegExp(src, flags.includes('g') ? flags : `${flags}g`), to]),
    forbid: (s.forbid || []).map((src) => new RegExp(src, 'i')),
  };
}

/** One file's text with every rule applied: literals in order, then patterns. */
export function scrubText(text, scrub) {
  let t = text;
  for (const [from, to] of scrub.replace) t = t.split(from).join(to);
  for (const [re, to] of scrub.regex) t = t.replace(re, to);
  return t;
}

/** The forbidden patterns still in a text, each with a little context. */
export function forbiddenIn(text, scrub) {
  const out = [];
  for (const re of scrub.forbid) {
    const m = re.exec(text);
    if (m) out.push(`${re.source}: …${text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25).replace(/\s+/g, ' ')}…`);
  }
  return out;
}

/** Lines appended to the exported .gitignore: the second person's own files. */
const IGNORE_TOO = [
  '',
  '# This copy\'s own person (written by setup, never shared)',
  'voice-dna.md',
  'jarvis/preferences.md',
  'jarvis/resume-pool.json',
  'jarvis/PENDING-CLAIMS.md',
  'config/profile.yml.bak-*',
];

/** The original user's contact details, read from his own gitignored files. */
export function secrets(root = ROOT) {
  const out = new Set();
  const read = (f) => { try { return yaml.load(readFileSync(path.join(root, f), 'utf8')) || {}; } catch { return {}; } };
  const prof = read('config/profile.yml').candidate || {};
  const id = read('data/jarvis/apply-profile.yml').identity || {};
  for (const v of [prof.email, id.email, id.address_line1, id.legal_name, id.full_name, prof.linkedin, id.linkedin]) {
    const s = String(v || '').trim();
    if (s.length >= 6) out.add(s.replace(/^https?:\/\/(www\.)?/i, ''));
  }
  for (const v of [prof.phone, id.phone]) {
    const d = String(v || '').replace(/\D/g, '').slice(-10);
    if (d.length === 10 && !d.startsWith('555')) out.add(`phone:${d}`);
  }
  return [...out];
}

function hits(text, list) {
  const digits = text.replace(/\D/g, '');
  return list.filter((s) => (s.startsWith('phone:') ? digits.includes(s.slice(6)) : text.includes(s)));
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const isPublic = argv.includes('--public');
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node jarvis/share-export.mjs <dir> [--public] [--dry-run]'); process.exit(2); }
  const scrub = isPublic ? loadScrub() : null;

  const files = git(['ls-files', '-z'], ROOT).split('\0').filter(Boolean);
  const keep = files.filter((f) => !excluded(f));
  const left = files.filter((f) => excluded(f));
  const sha = git(['rev-parse', '--short', 'HEAD'], ROOT).trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], ROOT).trim();
  console.log(`From ${sha}${dirty ? ' (uncommitted changes are NOT exported; commit first)' : ''}: ${keep.length} files exported, ${left.length} left out.`);
  if (dry) { console.log(left.map((f) => `  - ${f}`).join('\n')); return; }

  const dir = path.resolve(target);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, '.git'))) git(['init', '-q', '-b', 'main'], dir);

  // Clear what the last export wrote, then write HEAD's version of each kept
  // file. HEAD, not the working tree: only committed code. Only files the
  // share repo TRACKS are removed: a person's own files there (profile, store,
  // cv.md) are gitignored and must survive an export into a working copy.
  for (const f of git(['ls-files', '-z'], dir).split('\0').filter(Boolean)) rmSync(path.join(dir, f), { force: true });
  const show = (f) => execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, maxBuffer: 1 << 28 });
  const put = (f, body) => {
    const out = path.join(dir, f);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, body);
  };
  const written = new Set();
  for (const f of keep) { put(f, show(f)); written.add(f); }
  for (const [from, tos] of Object.entries(SHARE_FILES)) for (const to of tos) { put(to, show(from)); written.add(to); }
  writeFileSync(path.join(dir, '.gitignore'), `${readFileSync(path.join(dir, '.gitignore'), 'utf8').trimEnd()}\n${IGNORE_TOO.join('\n')}\n`);
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.name = 'jarvis-jobs';
  pkg.description = 'A private job-search engine: discovery across company ATS boards, triage, fit scoring, a dashboard, and a browser extension that fills applications but never presses Submit.';
  pkg.scripts['jarvis:test:personal'] = pkg.scripts['jarvis:test'].split('&&').map((s) => s.trim())
    .filter((cmd) => PERSONAL_TESTS.some((t) => cmd.endsWith(` ${t}`))).join(' && ');
  pkg.scripts['jarvis:test'] = sharedTestScript(pkg.scripts['jarvis:test']);
  delete pkg.scripts['jarvis:share'];
  for (const k of Object.keys(pkg.scripts)) if (k.startsWith('portfolio:')) delete pkg.scripts[k];
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);

  // Only what this export wrote is read: a working copy's own files (their
  // cv.md, their store) are theirs and are never touched or reported.
  const texts = [];
  for (const f of written) {
    const buf = readFileSync(path.join(dir, f));
    if (!buf.includes(0)) texts.push(f); // binary files are copied as they are
  }
  if (scrub) {
    let changed = 0;
    for (const f of texts) {
      const t = readFileSync(path.join(dir, f), 'utf8');
      const s = scrubText(t, scrub);
      if (s !== t) { writeFileSync(path.join(dir, f), s); changed += 1; }
    }
    console.log(`De-identified: ${changed} files rewritten by ${scrub.replace.length + scrub.regex.length} rules.`);
  }

  const list = secrets();
  // Run from a tree without his gitignored files (a worktree, a fresh clone)
  // the list is empty and the check below would pass on nothing.
  if (!list.length) {
    console.error(`Refusing to commit: no contact details to check against were found in ${path.join(ROOT, 'config/profile.yml')} or data/jarvis/apply-profile.yml. Run the export from the checkout that holds them.`);
    process.exit(1);
  }
  const bad = [];
  for (const f of texts) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    const h = hits(text, list).map((s) => (s.startsWith('phone:') ? 'phone' : s));
    if (scrub) h.push(...forbiddenIn(text, scrub));
    if (h.length) bad.push(`${f} (${h.join('; ')})`);
  }
  if (bad.length) {
    console.error(`Refusing to commit: these exported files still identify the original user or someone he wrote to:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }

  git(['add', '-A'], dir);
  const changed = git(['status', '--porcelain'], dir).trim();
  if (!changed) { console.log('Nothing changed since the last export.'); return; }
  // The snapshot is authored by the share repo's own identity when it has one
  // (the public repo commits as a neutral "Jarvis Jobs" so his address is not
  // in its history), else by whoever commits here: a fresh repo has none.
  const who = (k, cwd, local) => { try { return git(['config', ...(local ? ['--local'] : []), k], cwd).trim(); } catch { return ''; } };
  const ident = ['user.name', 'user.email'].flatMap((k) => {
    const v = who(k, dir, true) || (scrub ? '' : who(k, ROOT, false));
    return v ? ['-c', `${k}=${v}`] : [];
  });
  if (scrub && ident.length < 4) {
    console.error('Refusing to commit: a public repo needs its own user.name and user.email (git -C <dir> config user.name "…"), so his are not in its history.');
    process.exit(1);
  }
  git([...ident, 'commit', '-q', '-m', `Jarvis update from ${sha} (${new Date().toISOString().slice(0, 10)})`], dir);
  console.log(`Committed in ${dir}. Push it when ready: git -C "${dir}" push`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
