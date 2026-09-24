#!/usr/bin/env node
// jarvis/resume-variants.test.mjs — the four resumes must stay honest.
//
// Two failure modes this exists to catch, both of which cost credibility rather
// than crashing anything:
//
//   1. DRIFT FROM cv.md. A resume line is the one artefact a company reads. If a
//      bullet, a number, a tool or a job title in resume-pool.json is not in
//      cv.md, something invented it — so every string is re-checked against
//      cv.md here, punctuation-insensitive but word-exact.
//   2. TITLE/FORM MISMATCH. The four resumes present each internship under the
//      approved title matching the lane (cv.md § Approved internship title
//      variants). The application FORM has to say the same thing, on the same
//      ATS screen — so the title sync is pinned too, including against the real
//      apply-profile.yml company names, which is what silently breaks it.
//
// Run: npm run jarvis:test:resume-variants   (or node jarvis/resume-variants.test.mjs)

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { ALL_FAMILIES, familyFor } from './resume-family.mjs';
import { buildSpec, loadPool, verifyPoolAgainstCv, applyFamilyTitles, titlesForFamily, companyKey, POOL_PATH, contactFromProfile, contactIsUnresolved } from './resume-variants.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++; else failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
};
const ok = (name, cond, detail = '') => {
  if (cond) passed++; else failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
};

const pool = loadPool();
const KEYS = ALL_FAMILIES.map(f => f.key);

// ── 1. nothing on a resume that is not in cv.md ─────────────────────
const problems = verifyPoolAgainstCv(pool);
ok('every pool line traces to cv.md', problems.length === 0, problems.join('\n    '));

// ── 1b. the short-form variants trace to cv-short.md ────────────────
// cv-short.md is Alex's own one-page resume (AlexRiveraResume.docx, transcribed).
// A `short` bullet says the same work in fewer words, so it cannot appear in
// cv.md — it must appear THERE, verbatim. Without this check the short form
// would be the one place a resume could print a sentence no human wrote.
const shortBullets = Object.values(pool.orgs || {})
  .flatMap(o => Object.values(o.bullets || {}))
  .filter(b => b.short);
// Eight, not eleven: for robodk / neuro-t / makerspace.supervise Alex's one-pager
// reuses the master sentence word for word, so there is no shorter form to
// offer and carrying a duplicate would just double the surface that can drift.
ok('short variants exist', shortBullets.length >= 8, `only ${shortBullets.length} short bullets`);
ok('every short variant traces to cv-short.md',
  !problems.some(p => p.includes('cv-short.md')),
  problems.filter(p => p.includes('cv-short.md')).join('\n    '));

// A "short" line that is not shorter is just a second way to say the same
// thing, which defeats the point and doubles the surface that can drift.
const notShorter = Object.entries(pool.orgs || {}).flatMap(([orgK, o]) =>
  Object.entries(o.bullets || {})
    .filter(([, b]) => b.short && b.short.length >= b.text.length)
    .map(([bk]) => `${orgK}.${bk}`));
ok('short variants are shorter than the master line', notShorter.length === 0, notShorter.join(', '));

// ── 2. the four exist, and only the four ────────────────────────────
check('the four families', KEYS, ['total-experience', 'automation', 'manufacturing', 'mechanical']);

// ── 3. every family builds, and is the right size for one page ──────
const specs = new Map();
for (const key of KEYS) {
  let spec = null;
  try { spec = buildSpec(key, pool); passed++; }
  catch (e) { failures.push(`${key}: buildSpec threw — ${e.message}`); continue; }
  specs.set(key, spec);

  const bullets = spec.experience.reduce((n, e) => n + e.bullets.length, 0);
  // Measured, not guessed: 11–12 experience bullets plus 2 projects is what
  // fills one page at the pinned font size. Outside that it under- or overflows.
  ok(`${key}: ${bullets} experience bullets fits one page`, bullets >= 10 && bullets <= 13, `got ${bullets}, want 10–13`);

  // INCLUDE AS MUCH AS FITS, and spend the page on Applied Materials first —
  // Alex, 2026-08-02: "i would like to preserve as much of the applied materials
  // experience as possible". Five of its six bullets is the floor; the page
  // budget is bought back from Makerspace and SAE, which are one line each.
  const amatBullets = spec.experience.find(e => e.org === 'Applied Materials').bullets.length;
  ok(`${key}: keeps ${amatBullets}/6 Applied Materials bullets`, amatBullets >= 5, `only ${amatBullets} — cut elsewhere before cutting AMAT`);
  {
    const org = 'State University – Makerspace Manufacturing Technology Center';
    const n = spec.experience.find(e => e.org === org).bullets.length;
    ok(`${key}: ${org.split('–').pop().trim()} trimmed to ${n} line(s)`, n === 1, `got ${n} — that space belongs to Applied Materials`);
  }
  // The Mars Rover Team took Baja's place on every base (Alex, 2026-09-15: for
  // robotics roles it reads better than Baja). One line, or two on the two
  // bases that argue robotics — automation, and total-experience since he asked
  // for the all-rounder to lean that way ("skew it towards robotics a lil bit,
  // so if there is space do the robot club"). Baja stays in the pool for
  // postings that ask for it.
  {
    const rover = spec.experience.find(e => e.orgKey === 'rover');
    ok(`${key}: carries the Mars Rover Team`, !!rover, 'the rover team is on every family base');
    const cap = key === 'automation' || key === 'total-experience' ? 2 : 1;
    ok(`${key}: rover team at ${rover?.bullets.length} line(s)`, rover && rover.bullets.length >= 1 && rover.bullets.length <= cap, `want 1–${cap}`);
    ok(`${key}: Baja is not on the base`, !spec.experience.some(e => e.orgKey === 'sae'));
  }
  ok(`${key}: has both projects`, spec.projects.length === 2);
  // Skills are cv.md's categories now (Alex, 2026-09-03): a lane prints
  // three to five of them, in its own order, every item of each.
  ok(`${key}: prints 3-5 skills categories`, spec.skills.length >= 3 && spec.skills.length <= 5, `got ${spec.skills.length}`);
  // The team on the SAME line as the title, after a bar — never parentheses.
  const amatEntry = spec.experience.find(e => e.org === 'Applied Materials');
  check(`${key}: Applied Materials carries its group`, amatEntry.group, 'Automation Technology Group');
  ok(`${key}: titles are clean — no parentheses, no ampersand, no hybrid`,
    spec.experience.filter(e => /intern/i.test(e.title)).every(e => !/[()&]/.test(e.title) && !/Mechanical Automation/.test(e.title)),
    spec.experience.map(e => e.title).join(' / '));
  ok(`${key}: education leads the page`, spec.order[0] === 'education');

  // A bullet listed twice would print twice — invisible in a plan, obvious on
  // the page.
  for (const e of spec.experience) {
    const texts = e.bullets.map(b => b.text);
    ok(`${key}: no duplicate bullet at ${e.org}`, new Set(texts).size === texts.length);
  }
  // Every job he has held appears on every resume. A lane reorders and
  // reweights; it never quietly drops a role, which would read as a gap.
  check(`${key}: all four roles present`, spec.experience.map(e => e.org).length, 4);
}

// ── 4. titles: approved, present, and lane-appropriate ──────────────
for (const [key, spec] of specs) {
  const amat = spec.experience.find(e => e.org === 'Applied Materials');
  const acme = spec.experience.find(e => /Acme Steel/.test(e.org));
  ok(`${key}: Applied Materials title is an approved variant`, !!pool.orgs.amat.titles[key] && amat.title === pool.orgs.amat.titles[key]);
  ok(`${key}: Acme Steel title is an approved variant`, !!pool.orgs.acme.titles[key] && acme.title === pool.orgs.acme.titles[key]);
  ok(`${key}: both internships are titled "Intern"`, /intern/i.test(amat.title) && /intern/i.test(acme.title),
    `${amat.title} / ${acme.title}`);
  // The non-internship roles are real titles and never vary.
  const makerspace = spec.experience.find(e => /Makerspace/.test(e.org));
  check(`${key}: Makerspace title unchanged`, makerspace.title, 'Manufacturing Lead');
}
ok('automation resume says Automation Engineer at Applied Materials', /^Automation Engineer Intern/.test(specs.get('automation').experience[0].title));
ok('mechanical resume says Mechanical at both internships',
  /^Mechanical Engineer Intern$/.test(specs.get('mechanical').experience[0].title)
  && /^Mechanical Engineer Intern$/.test(specs.get('mechanical').experience[1].title));
ok('manufacturing resume says Manufacturing at both internships',
  /^Manufacturing Engineer Intern/.test(specs.get('manufacturing').experience[0].title)
  && /^Manufacturing Engineer Intern/.test(specs.get('manufacturing').experience[1].title));

// ── 4b. the staples that appear on EVERY resume ─────────────────────
// Alex, 2026-08-02: "i dont want to omit any mechanical design experience,
// especially the fixture design one, keep that for all resumes … i think you are
// over specializing, coz mechanical design is a damn staple". The machine-vision
// model is in the same category ("i like the vision thing too").
// Match on the bullet's IDENTITY, not one phrasing of it: a bullet may print
// either its cv.md long form or its cv-short.md short form, and both are the
// same claim. Pinning the long string made these fail the moment short forms
// were preferred, even though every staple was still on the page.
const formsOf = (b) => [b.text, b.short].filter(Boolean);
const STAPLES = [
  ['the Inventor inspection-fixture design', formsOf(pool.orgs.amat.bullets['vision-fixture'])],
  ['the Neuro-T machine-vision model', formsOf(pool.orgs.amat.bullets['neuro-t'])],
];
for (const [what, forms] of STAPLES) {
  for (const [key, spec] of specs) {
    const printed = spec.experience.flatMap(e => e.bullets).map(b => b.text);
    ok(`${key}: keeps ${what}`, forms.some(f => printed.includes(f)), 'this one is a staple on every resume, whatever the lane');
  }
}
// AMR is on EVERY resume again (Alex, 2026-08-09). It was dropped from the
// mechanical lane as "not very technical", and `cobot-install` took its slot —
// but cobot-install and robodk are the same UR leak-test cell described twice
// ("in reality its only one thing, the din rail stuff is just fluff"). With
// the duplicate gone, AMR is the better use of the line.
const amrForms = formsOf(pool.orgs.amat.bullets.amr);
const hasAmr = (key) => specs.get(key).experience.flatMap(e => e.bullets).some(b => amrForms.includes(b.text));
for (const key of KEYS) ok(`${key}: keeps the AMR deployment bullet`, hasAmr(key));

// The UR cobot cell must be described ONCE. cobot-install and robodk are the
// same work; printing both read as padding and is the thing Alex caught.
const cobotForms = formsOf(pool.orgs.amat.bullets['cobot-install']);
for (const [key, spec] of specs) {
  const printed = spec.experience.flatMap(e => e.bullets).map(b => b.text);
  const both = printed.some(t => cobotForms.includes(t)) && printed.some(t => formsOf(pool.orgs.amat.bullets.robodk).includes(t));
  ok(`${key}: does not describe the UR leak-test cell twice`, !both);
}

// ── 5. the lanes actually differ ────────────────────────────────────
// Four resumes that lead with the same bullet in the same order are one resume
// in four folders — which is the thing this whole design is for.
const leadBullet = (key) => specs.get(key).experience[0].bullets[0].text;
ok('each lane leads with different work', new Set(KEYS.map(leadBullet)).size >= 3,
  KEYS.map(k => `${k}: ${leadBullet(k).slice(0, 40)}`).join(' | '));
ok('automation leads with RoboDK', /RoboDK/.test(leadBullet('automation')));
ok('mechanical leads with the design work', /Designed and (rapidly )?prototyped/.test(leadBullet('mechanical')));
ok('manufacturing leads with the IIoT/quality work', /IIoT|Tulip Edge Device/.test(leadBullet('manufacturing')));
ok('automation and mechanical skills lines differ',
  specs.get('automation').skills[0].text !== specs.get('mechanical').skills[0].text);

// ── 6. routing: a posting title picks the right lane ────────────────
const routes = [
  ['Robotics Engineer', 'automation'],
  ['Automation Engineer, Semiconductor', 'automation'],
  ['Controls Engineer (PLC)', 'automation'],
  ['Manufacturing Automation Engineer', 'automation'],
  ['Manufacturing Engineer', 'manufacturing'],
  ['Process Engineer, NPI', 'manufacturing'],
  ['Test Engineer', 'manufacturing'],
  ['Quality Engineer', 'manufacturing'],
  ['Metrology Engineer', 'manufacturing'],
  ['Mechanical Engineer', 'mechanical'],
  ['Mechanical Design Engineer', 'mechanical'],
  ['Product Design Engineer', 'mechanical'],
  ['Engineer I', 'total-experience'],
  ['Associate Engineer, Rotational Program', 'total-experience'],
];
for (const [title, want] of routes) check(`route "${title}"`, familyFor({ title }).key, want);
check('routing falls back to the description', familyFor({ title: 'Engineer I', description: 'Support our robotics cell integration team' }).key, 'automation');

// ── 7. the form says what the resume says ───────────────────────────
const sample = {
  work_experience: [
    { title: 'Manufacturing Engineer Intern (Automation)', company: 'Applied Materials' },
    { title: 'Mechanical Engineering Intern', company: 'Acme Steel Stud Company' },
    { title: 'Barista', company: 'Some Coffee Shop' },
  ],
};
const synced = applyFamilyTitles(sample, 'automation', pool);
check('form title synced for Applied Materials', synced.profile.work_experience[0].title, 'Automation Engineer Intern');
check('form title synced for Acme Steel', synced.profile.work_experience[1].title, 'Automation Engineer Intern');
check('a company outside the pool is untouched', synced.profile.work_experience[2].title, 'Barista');
check('the change list is reported', synced.changed.length, 2);
ok('the original profile is not mutated', sample.work_experience[0].title === 'Manufacturing Engineer Intern (Automation)');
check('an unknown family syncs nothing', applyFamilyTitles(sample, 'nope', pool).changed.length, 0);

// The sync matches on company name, so a rename in either file silently stops
// it working — and a silent stop means a form that contradicts the PDF.
try {
  const profile = yaml.load(readFileSync(path.join(ROOT, 'data', 'jarvis', 'apply-profile.yml'), 'utf-8')) || {};
  const titles = new Set([...titlesForFamily('mechanical', pool).keys()].map(companyKey));
  for (const e of profile.work_experience || []) {
    if (/state university|society/i.test(e.company || '')) continue;   // clubs/campus roles keep real titles
    ok(`apply-profile company "${e.company}" is known to the pool`, titles.has(companyKey(e.company)));
  }
} catch (e) {
  failures.push(`could not cross-check apply-profile.yml: ${e.message}`);
}


// ── the tracked pool must never carry his contact details ───────────
//
// resume-pool.json IS tracked — it has to be, the bullet pool is checked
// against cv.md on every build — and it used to hold his phone number and
// email in plain text at the top. Every other personal file in this project is
// gitignored precisely so that cannot happen. The real values are overlaid at
// load time from config/profile.yml, which is not tracked.
{
  const raw = JSON.parse(readFileSync(POOL_PATH, 'utf-8'));
  const c = raw.contact || {};
  ok('the tracked pool carries no phone number',
    !/\d{3}[).\s-]\s*\d{3}[.\s-]?\d{4}/.test(String(c.phone || '')),
    `resume-pool.json contact.phone = ${JSON.stringify(c.phone)} — it is committed to git`);
  ok('the tracked pool carries no email address',
    !/@[\w-]+\.[a-z]{2,}/i.test(String(c.email || '')),
    `resume-pool.json contact.email = ${JSON.stringify(c.email)} — it is committed to git`);
  ok('and the placeholders are recognised as unresolved',
    contactIsUnresolved(c).length >= 2);

  // The overlay has to actually restore them, or every resume ships a
  // placeholder where the phone belongs.
  const real = contactFromProfile();
  if (real) {
    ok('loadPool overlays the real phone from config/profile.yml',
      /\d/.test(String(pool.contact.phone || '')) && contactIsUnresolved(pool.contact).length === 0,
      `overlaid contact = ${JSON.stringify(pool.contact)}`);
  }
  ok('an unresolved contact is caught before anything renders',
    contactIsUnresolved({ phone: 'from config/profile.yml' }).includes('phone'));
}

if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.error(`  FAIL: ${f}\n`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
