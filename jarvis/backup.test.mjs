#!/usr/bin/env node
// jarvis/backup.test.mjs — a backup nobody has restored is not a backup.
//
// The whole premise is that 396 MB of store is disposable because a scan
// rebuilds it, and the only thing worth saving is what the user did. That is
// only true if the small file can actually put those decisions back — onto an
// EMPTY store, which is the situation it exists for.

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// On Windows a bare absolute path is not a valid ESM specifier.
const STORE_URL = JSON.stringify(pathToFileURL(path.join(HERE, 'store.mjs')).href);
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  cond ? pass++ : fail++;
};

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-backup-'));
const sourceDb = path.join(dir, 'source.db');
const targetDb = path.join(dir, 'target.db');
const run = (env, code) => execFileSync(process.execPath, ['--input-type=module', '-e', code],
  { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf-8' });
const tool = (env, ...args) => execFileSync(process.execPath, [path.join(HERE, 'backup.mjs'), ...args],
  { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf-8' });

console.log('\n🧪 a decision survives losing the entire store');

// A store with one decided job, one prepared application, one hidden company —
// and a job the user never touched, which must NOT be in the backup.
run({ JARVIS_DB_PATH: sourceDb }, `
  const S = await import(${STORE_URL});
  S.upsertJobs([
    { url: 'https://x/kept', title: 'Manufacturing Engineer', company: 'Kept Co', location: 'Austin, TX',
      description: 'Mechanical design with SolidWorks and GD&T. Base Pay Range: $95,000 - $120,000 Annually.' },
    { url: 'https://x/untouched', title: 'Other Engineer', company: 'Other Co', location: 'Austin, TX' },
  ]);
  S.setStatus(S.jobId('https://x/kept'), 'queued');
  S.updateJob(S.jobId('https://x/kept'), { apply: { at: '2026-08-15T00:00:00Z', filled: 17, needsInput: [] } });
  S.setCompanyHidden('Hidden Co', true);
`);

// --out keeps the test off the real backup file.
const file = path.join(dir, 'jarvis-backup.json');
const out = tool({ JARVIS_DB_PATH: sourceDb }, '--out', file);
ok('the backup reports what it saved', /Decisions saved : 1\b/.test(out), out.trim());
ok('it leaves the private file out by default', /Left out/.test(out));

const payload = JSON.parse(readFileSync(file, 'utf-8'));
ok('only the touched job is in it', payload.jobs.length === 1 && payload.jobs[0].company === 'Kept Co',
  JSON.stringify(payload.jobs.map(j => j.company)));
ok('the untouched job is not', !payload.jobs.some(j => j.company === 'Other Co'));
ok('the verdict rides along', !!payload.jobs[0].triage && Number.isFinite(payload.jobs[0].fit?.score));
ok('the address / EEO answers are absent',
  !Object.keys(payload.files || {}).some(f => /apply-profile/.test(f)));

// Now the real question: restore onto nothing.
const restored = tool({ JARVIS_DB_PATH: targetDb }, '--restore', file);
ok('the restore reports what it put back', /Decisions put back : 1\b/.test(restored), restored.trim());

const check = JSON.parse(run({ JARVIS_DB_PATH: targetDb }, `
  const S = await import(${STORE_URL});
  const j = S.getJob(S.jobId('https://x/kept'));
  console.log(JSON.stringify({
    total: S.count(),
    status: j?.status,
    company: j?.company,
    applyFilled: j?.apply?.filled,
    fit: j?.fit?.score,
    bucket: j?.triage?.locationBucket,
    hidden: S.hiddenCompanies(),
    prepared: S.count({ prepared: true }),
  }));
`));

ok('the job exists in the rebuilt store', check.company === 'Kept Co');
ok('its status came back', check.status === 'queued', String(check.status));
ok('its apply record came back', check.applyFilled === 17, String(check.applyFilled));
ok('the prepared-applications view finds it', check.prepared === 1);
ok('its verdict came back', check.bucket === 'us' && Number.isFinite(check.fit),
  JSON.stringify({ bucket: check.bucket, fit: check.fit }));
ok('the hidden company came back', check.hidden.includes('Hidden Co'), JSON.stringify(check.hidden));
ok('nothing else was invented', check.total === 1, String(check.total));


// ── the bundle must describe itself honestly ────────────────────────
//
// `includesPrivate` used to be a straight copy of the `--private` flag, which
// only ever governed apply-profile.yml. But cv.md and config/profile.yml are
// bundled ALWAYS and both carry his email and phone — so a default backup was
// written, and committed to git, stamped `includesPrivate: false` while
// containing exactly what the README promised was left out.
console.log('\n🧪 the bundle does not lie about what is in it');
{
  const { contactDataIn } = await import('./backup.mjs');

  const found = contactDataIn({
    'cv.md': 'Alex Rivera — someone@example.com — +1 (555) 000-0000',
    'portals.yml': 'greenhouse: torcrobotics',
  });
  ok('an email in a bundled file is found', found.has('an email address'));
  ok('a phone number in a bundled file is found', found.has('a phone number'));
  ok('and it names the file it came from', [...(found.get('a phone number') || [])].includes('cv.md'));
  ok('a file with no contact data is not named',
    ![...(found.get('an email address') || [])].includes('portals.yml'));

  ok('a clean bundle reports nothing', contactDataIn({ 'portals.yml': 'greenhouse: acme' }).size === 0);

  // A bare ten-digit id is not a phone number. Reporting one would train him to
  // ignore the warning, which is worse than not printing it.
  ok('a bare posting id is not called a phone number',
    !contactDataIn({ 'portals.yml': 'id: 8554813002' }).has('a phone number'));
  ok('a street address is found',
    contactDataIn({ 'p.md': 'Address: 1 Example Street, Springfield' }).has('a street address'));
}


// -- his contact details must not be in any TRACKED file -----------
//
// Twice in one session I quoted his real phone number as evidence while
// writing up a fault ABOUT his real phone number (F-201, F-216). Both times a
// `git grep` at the end of the round caught it. The check works; remembering to
// run it does not, so it runs here.
//
// The values live in a gitignored file, so they are read at runtime and never
// written into this file or its output. If the profile is absent — a fresh
// clone, or CI — there is nothing to check and the test says so rather than
// pretending to pass.
console.log('');
console.log('testing: no tracked file carries his contact details');
{
  const yaml = (await import('js-yaml')).default;
  const profilePath = path.join(ROOT, 'config', 'profile.yml');
  if (!existsSync(profilePath)) {
    ok('skipped — config/profile.yml is not present, nothing to compare against', true);
  } else {
    const doc = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const id = doc.candidate || doc.identity || {};
    const secrets = [['phone', id.phone], ['email', id.email]]
      .concat(Object.entries(doc.address || {}).map(([k, v]) => [`address.${k}`, v]))
      .filter(([, v]) => typeof v === 'string' && v.trim().length >= 8);

    ok('there are values to check for', secrets.length > 0);

    // F-475. One of these details is published on purpose: the portfolio is a
    // public site with a contact section, so his email belongs in it. The
    // phone and the address are published nowhere and stay banned everywhere,
    // including the portfolio. Anything allowed here is still printed, so a
    // new file that starts carrying the address is seen rather than waved
    // through by a path rule.
    const PUBLISHED_ON_PURPOSE = { email: /^portfolio\// };

    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' })
      .split(String.fromCharCode(10)).map((f) => f.trim()).filter(Boolean);

    const offenders = [];
    const published = [];
    for (const rel of tracked) {
      const full = path.join(ROOT, rel);
      let text;
      try { text = readFileSync(full, 'utf-8'); } catch { continue; }
      // Compare on digits/letters only, so a reformatted phone is still caught.
      const bare = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const [label, secret] of secrets) {
        const needle = String(secret).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (needle.length < 8 || !bare.includes(needle)) continue;
        const allowed = PUBLISHED_ON_PURPOSE[label]?.test(rel.replace(/\\/g, '/'));
        const list = allowed ? published : offenders;
        const entry = `${rel} (${label})`;
        if (!list.includes(entry)) list.push(entry);
      }
    }
    // The filenames are safe to print; the values are not, and are not.
    ok(`no tracked file carries them (${tracked.length} files checked)`,
      offenders.length === 0, offenders.join(', '));
    if (published.length) {
      console.log(`   published on purpose: ${published.join(', ')}`);
    }

    // The allow-list is the part of this check that can rot into a hole, so
    // its shape is asserted rather than reviewed.
    ok('the phone is never allowed, not even in the portfolio',
      !PUBLISHED_ON_PURPOSE.phone);
    ok('no address line is ever allowed',
      !Object.keys(PUBLISHED_ON_PURPOSE).some((k) => k.startsWith('address')));
    ok('the email is allowed only under portfolio/',
      !PUBLISHED_ON_PURPOSE.email.test('jarvis/FAULTS.md')
      && !PUBLISHED_ON_PURPOSE.email.test('notes/portfolio/scratch.md')
      && PUBLISHED_ON_PURPOSE.email.test('portfolio/build.mjs'));
  }
}

rmSync(dir, { recursive: true, force: true });

console.log('\n🧪 a "gone" verdict survives backup AND restore');
{
  // F-258. `goneAt` was already being SAVED — 9 records in his real backup
  // carried it — and then silently dropped on the way back in, because the
  // restore copied a fixed list of six keys and this was not one of them.
  //
  // It is the one field here a scan cannot rebuild. The liveness sweep can
  // re-derive an API 404 next run, but a posting retired because HE opened it
  // in his signed-in browser and the page said it was gone (F-251) is exactly
  // the evidence no headless check produces — F-250 measured that going wrong
  // in both directions on the same run. Losing it on restore sends him back to
  // a posting he has already found out is dead.
  const src = readFileSync(path.join(HERE, 'backup.mjs'), 'utf-8');
  const loop = src.slice(src.indexOf('for (const saved of payload.jobs)'), src.indexOf('hiddenCompanies || []'));
  ok('the restore copies goneAt back onto the job', /'goneAt'/.test(loop));

  // The list is positional and easy to extend wrongly, so the decisions that
  // must survive are named here rather than trusted to review.
  for (const key of ['apply', 'resume_path', 'resume_sent', 'deepRequested', 'skipFeedback', 'statusChangedAt', 'goneAt', 'closed_note']) {
    ok(`restore carries ${key}`, new RegExp(`'${key}'`).test(loop));
  }
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);