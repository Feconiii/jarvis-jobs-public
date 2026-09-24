#!/usr/bin/env node
// jarvis/resume.test.mjs — the PDF text layer must survive extraction.
//
// WHY THIS EXISTS: resume.mjs used to render with Arial at px sizes and carried
// a comment asserting that font-kerning:none + text-rendering:optimizeSpeed
// stopped Chromium injecting spurious spaces into the PDF text layer. It did
// not. Real resumes went out reading "SUM M ARY", "M anufacturing", "hardw are"
// and "w ith" to any ATS that parsed them — invisible on screen, and a silent
// loss of exactly the keywords the resume exists to match. One such file was
// uploaded to a live NVIDIA application before this was caught.
//
// So the property under test is end-to-end, not cosmetic: render the real spec
// to PDF, pull the text back out, and assert every word of the spec survives as
// an intact token. Font and size are pinned in resume.mjs because they are the
// variables that actually control this (measured: Arial lost words at every
// size tried; Verdana at 8.5pt lost none).
//
// All FOUR family resumes are checked, not just one — they carry different
// bullets and different job titles, and text-layer corruption is a function of
// the glyphs on the page, so a clean automation resume proves nothing about the
// mechanical one.
//
// Run: npm run jarvis:test:resume

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ALL_FAMILIES } from './resume-family.mjs';
import { buildSpec, loadPool } from './resume-variants.mjs';

function have(cmd) {
  try { execFileSync(cmd, ['-v'], { stdio: 'pipe' }); return true; }
  catch (e) {
    // A missing binary throws ENOENT with status === null, and `null !==
    // undefined` is true — so the old check reported "installed" and the suite
    // died on the first real call instead of skipping. Only a numeric exit code
    // proves the binary ran (pdftotext -v exits non-zero but does exist).
    if (e.code === 'ENOENT' || typeof e.status !== 'number') return false;
    return true;
  }
}

if (!have('pdftotext')) {
  // Skip rather than fail: pdftotext (poppler) is the measuring instrument, not
  // the thing under test. A machine without it should not report a red suite.
  console.log('SKIP: pdftotext not installed — cannot verify the PDF text layer.');
  console.log('  Install poppler-utils to run this check.');
  process.exit(0);
}

/** Every word >= 4 chars the spec will actually render. */
function specWords(node, acc = new Set()) {
  if (typeof node === 'string') for (const w of node.match(/[A-Za-z]{4,}/g) || []) acc.add(w);
  else if (Array.isArray(node)) node.forEach((v) => specWords(v, acc));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => specWords(v, acc));
  return acc;
}

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-resume-'));
let passed = 0;
const failures = [];

try {
  const pool = loadPool();
  for (const family of ALL_FAMILIES) {
    // MEASURE THE PAGE THAT SHIPS, NOT THE PLAN BEHIND IT.
    //
    // `buildSpec` deliberately OVER-PROVISIONS the skills section since
    // 2026-09-22: the pool offers four categories and up to 24 items each, and
    // the build trims them to his two-line limit while fitting the page
    // (`resume-polish.mjs` step 0). Nothing with four full categories is ever
    // sent to anyone.
    //
    // Measured, all four families: raw, `total-experience` and `manufacturing`
    // render to two pages; with skills at two categories every one of them is
    // one page at 99% fill — which is exactly what `build-resumes.mjs` produces
    // and what this guard is for. Rendering the untrimmed plan was testing an
    // artefact that does not exist.
    //
    // The rest of the guard is untouched: this still fails if a family's
    // BULLETS overflow a page, which is the regression it was written to catch.
    const planned = buildSpec(family.key, pool);
    const spec = { ...planned, skills: (planned.skills || []).slice(0, 2) };
    const specPath = path.join(dir, `${family.key}.json`);
    writeFileSync(specPath, JSON.stringify(spec), 'utf-8');
    const pdf = path.join(dir, `${family.key}.pdf`);
    const tag = `[${family.key}]`;

    // Config/provenance, not content — none of it is rendered as text.
    // Bullets also carry `provenanceKey` and `source` (jarvis/resume-tailor.mjs
    // keys rewrites off them). `source` holds the OTHER approved wording of the
    // same sentence, so leaving it in would demand the PDF contain both the long
    // and the short form of every bullet - a guaranteed and meaningless failure.
    // `orgKey` and a skills line's `key` address the pool (jarvis/resume-plan.mjs);
    // `linkedin`/`website` are carried but not printed — the header is
    // location | phone | email since 2026-09-03, matching his own one-pager.
    // `short`, `shortLead` and `long` are alternate approved wordings a
    // bullet carries for the fit loop and the tailor; only `text` prints.
    const NOT_PRINTED = new Set(['provenanceKey', 'source', 'orgKey', 'key', 'linkedin', 'website', 'short', 'shortLead', 'long']);
    const strip = (n) => {
      if (Array.isArray(n)) return n.map(strip);
      if (!n || typeof n !== "object") return n;
      const out = {};
      for (const [k, v] of Object.entries(n)) {
        if (NOT_PRINTED.has(k)) continue;
        out[k] = strip(v);
      }
      return out;
    };
    const rendered = strip(spec);
    // `courseworkFill` is the order the layout tops up a half-used coursework
    // line from (2026-09-23); none of it prints unless the line takes it.
    for (const k of ['_comment', 'order', 'variant', 'family', 'familyLabel', 'courseworkFill']) delete rendered[k];
    const words = [...specWords(rendered)];

    const renderLog = execFileSync('node', ['jarvis/resume.mjs', '--spec', specPath, '--out', pdf], { encoding: 'utf-8' });
    const text = execFileSync('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { encoding: 'utf-8' });
    const tokens = new Set(text.match(/[A-Za-z]+/g) || []);

    // 1. Text layer integrity — the regression that motivated this file.
    const lost = words.filter((w) => !tokens.has(w));
    if (lost.length === 0) passed++;
    else failures.push(
      `${tag} ${lost.length} of ${words.length} words did not survive PDF text extraction.\n` +
      `    A word "split" by the renderer (e.g. "hardw are") is invisible on screen but\n` +
      `    unreadable to an ATS. Check FONT_STACK / BASE_PT in jarvis/resume.mjs.\n` +
      `    Lost: ${JSON.stringify(lost.slice(0, 12))}${lost.length > 12 ? ' …' : ''}`);

    // 2. Ligature suppression — "verification" must not extract as "veriﬁcation".
    if (!/ﬀ|ﬁ|ﬂ|ﬃ|ﬄ/.test(text)) passed++;
    else failures.push(`${tag} PDF text layer contains ligature codepoints (ﬁ/ﬂ/ﬀ) — ATS parsers mis-read them.`);

    // 3. One page. A new-grad resume that spills onto page 2 is a content bug,
    //    and page 2 is where a reviewer stops reading.
    const pages = (readFileSync(pdf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages === 1) passed++;
    else failures.push(`${tag} rendered to ${pages} pages — cut a bullet from this family's plan in jarvis/resume-variants.mjs.`);

    // 4. The page must be FULL. Alex's standing rule: dead space at the bottom is
    //    wasted space that should be carrying more detail. renderPdf auto-fits the
    //    spacing to the content, so a shortfall here means the content is too
    //    short for one page even at the loosest spacing — add a bullet to the
    //    family's plan (from cv.md, via jarvis/resume-pool.json).
    const MIN_FILL = 96;
    const filled = Number((renderLog.match(/page (\d+)% full/) || [])[1] || 0);
    if (filled >= MIN_FILL) passed++;
    else failures.push(
      `${tag} page is only ${filled}% full (want >= ${MIN_FILL}%) — that is roughly ` +
      `${((100 - filled) / 100 * 11).toFixed(1)}in of dead space at the bottom.\n` +
      `    Auto-fit already maxed the spacing, so add content to this family's plan.`);

    // 5. The contact line must be intact — a split email or phone is unreachable.
    const c = spec.contact || {};
    for (const [field, value] of Object.entries({ email: c.email, phone: c.phone })) {
      if (!value) continue;
      const compact = (s) => s.replace(/[^A-Za-z0-9@.]/g, '');
      if (compact(text).includes(compact(value))) passed++;
      else failures.push(`${tag} contact ${field} "${value}" did not survive extraction intact — it would be unreachable.`);
    }

    // 5b. THE HEADER LINKS ARE REAL AND THE TEXT STAYS BARE (2026-09-19).
    //
    //     His ask: *"hyperlink my linked in and put in alexrivera.example make
    //     that clickable as well, same with email where it pulls up gmail"*. A
    //     recruiter reads this on a screen, and a link they can press is the
    //     difference between getting an email and being retyped into one.
    //
    //     Two halves, and both matter. The ANNOTATION carries the scheme, or
    //     the click resolves against the PDF's own location and goes nowhere.
    //     The TEXT LAYER stays the bare spelling — his site is served at the
    //     bare domain and he was explicit that printing "https://" is wrong —
    //     and an ATS reads the text layer, never the annotations.
    //     Read straight out of the PDF bytes: a link annotation writes its
    //     destination as `/URI (…)`, and that needs no extra dependency in a
    //     test that already shells out to pdftotext.
    const linkUrls = [...readFileSync(pdf, 'latin1').matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => m[1]);
    const wantLinks = [
      c.email ? `mailto:${c.email}` : null,
      c.linkedin ? 'linkedin.com/in/' : null,
      c.portfolio ? String(c.portfolio).replace(/^[a-z]+:\/\//i, '') : null,
    ].filter(Boolean);
    for (const want of wantLinks) {
      if (linkUrls.some((u) => u.includes(want))) passed++;
      else failures.push(`${tag} the header has no clickable link for "${want}" — found ${JSON.stringify(linkUrls)}`);
    }
    if (!/https?:\/\//.test(text)) passed++;
    else failures.push(`${tag} the visible text prints a URL scheme — the header must read bare, the href carries the scheme.`);

    // 6. The lane's job titles must be ON the page — the whole point of the
    //    variant, and the thing a recruiter cross-checks against the form.
    for (const e of spec.experience) {
      const titleWords = (e.title.match(/[A-Za-z]{4,}/g) || []);
      if (titleWords.every(w => tokens.has(w))) passed++;
      else failures.push(`${tag} job title "${e.title}" did not survive extraction intact.`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.error(`  FAIL: ${f}\n`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
