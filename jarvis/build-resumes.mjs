#!/usr/bin/env node
// jarvis/build-resumes.mjs — build THE FOUR resumes.
//
//   total-experience  the all-rounder (and the fallback for unlaned postings)
//   automation        robots, cells, vision, controls
//   manufacturing     process, production, NPI, test & quality
//   mechanical        CAD, tolerance, structures, analysis
//
// Alex's rule, in one line: every application gets a tailored resume, and the
// tailoring is the family — never a fresh resume per posting (ten subtly
// different resumes in one ATS reads as machine-written; four honest
// specialisations read as a candidate with range).
//
// Each PDF is written to output/jarvis-resumes/<family>/Alex Rivera Resume.pdf. The
// FILENAME is identical in all four on purpose — that is what a recruiter sees
// in the ATS — so the folder is what tells them apart, and this script prints
// exactly which file it wrote for which lane. The spec that produced it is saved
// next to it as spec.json, so any line on a PDF can be traced back to a pool key
// and from there to cv.md.
//
// Usage:
//   node jarvis/build-resumes.mjs                    # all four
//   node jarvis/build-resumes.mjs --family automation,mechanical
//   node jarvis/build-resumes.mjs --check            # validate only, render nothing
//   node jarvis/build-resumes.mjs --specs-only       # write spec.json, skip PDFs

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ALL_FAMILIES, familyByKey } from './resume-family.mjs';
import { buildSpec, buildVariantSpec, VARIANTS, loadPool, verifyPoolAgainstCv, contactIsUnresolved, PLANS } from './resume-variants.mjs';
import { polish } from './resume-polish.mjs';
import { qaReport } from './resume-qa.mjs';

import { guardArgs } from './cli.mjs';

const USAGE = `
  node jarvis/build-resumes.mjs [options]

  Build the four family resumes as PDFs.

    --check               
    --families <value>    
    --family <value>      
    --specs-only          
    --help, -h
`;

// F-163: not one command in this project handled --help, so --help RAN them.
guardArgs({ usage: USAGE, flags: ["--check","--families","--family","--specs-only"], valued: ["--families","--family"] });


const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.JARVIS_RESUME_DIR || path.join(ROOT, 'output', 'jarvis-resumes');
const PERSON_FILE = (name) => `${String(name).replace(/\s+/g, ' ').trim()} Resume.pdf`;

export async function buildAll({ rasterDpi = 200, families = ALL_FAMILIES.map(f => f.key), specsOnly = false, check = false, outDir = OUT_DIR } = {}) {
  const pool = loadPool();

  // Guard first, always. A drifted line is worth failing the whole build for —
  // the resume is the one artefact a company actually reads.
  const problems = verifyPoolAgainstCv(pool);
  if (problems.length) {
    const err = new Error(`resume pool does not match cv.md (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }

  // The contact block is overlaid from config/profile.yml, which is gitignored.
  // If it is missing, the pool's placeholder would go out as his phone number.
  // A resume that reaches an employer reading "from config/profile.yml" where
  // the phone belongs is worse than no resume, so refuse to render one.
  const unresolved = contactIsUnresolved(pool.contact);
  if (unresolved.length) {
    throw new Error(
      `resume contact is unresolved (${unresolved.join(', ')}) — config/profile.yml is missing or has no candidate block.\n`
      + '  These are deliberately not stored in the tracked pool. Restore the file and rebuild.',
    );
  }

  const results = [];
  for (const key of families) {
    const family = familyByKey(key);
    if (!family) throw new Error(`unknown family "${key}" — known: ${ALL_FAMILIES.map(f => f.key).join(', ')}`);
    const dir = path.join(outDir, family.variant);
    mkdirSync(dir, { recursive: true });

    // THREE PER LANE (his ask, 2026-09-22). Same facts, same pool, same guards;
    // only the SELECTION differs. `base` keeps the plain filename and is what
    // apply-time routing picks, so nothing downstream has to learn a new name.
    for (const variant of VARIANTS) {
    const spec = buildVariantSpec(family.key, variant.key, pool);
    const suffix = variant.label ? ` - ${variant.label}` : '';
    const specPath = path.join(dir, variant.label ? `spec-${variant.key}.json` : 'spec.json');
    if (!check) writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf-8');

    let pdfPath = null, fit = null, qa = null;
    let fitted = spec;
    if (!check && !specsOnly) {
      pdfPath = path.join(dir, PERSON_FILE(spec.name).replace(/\.pdf$/i, `${suffix}.pdf`));
      // FIT THE PAGE the way a tailored build does (2026-09-05): the bases
      // now start on every full wording, so a spill is answered first by a
      // bullet's short form, one per pass, and only then by dropping a line.
      // One loop with the tailored builds (resume-polish.mjs): a spill takes
      // a short form then a line; a four-line bullet or a stub takes the
      // short form (no model here); a wrapped Skills line is reordered; the
      // sheet is rasterised and his checklist run on it.
      // The lane's own reserve, so a page shortened by the two-line SKILLS cap
      // is filled with evidence rather than left with a 0.7in gap at the foot.
      // Breadth has already spent the reserve, so handing it the same list
      // again would print a bullet twice.
      const reserve = variant.key === 'breadth' ? [] : [...(PLANS[family.key]?.reserve || [])];
      const polished = await polish(spec, { pdfPath, pool, reserve, tailor: null, dpi: rasterDpi, tailored: null });
      fitted = polished.spec; fit = polished.fit; qa = polished;
      if (fitted !== spec) writeFileSync(specPath, `${JSON.stringify(fitted, null, 2)}\n`, 'utf-8');
      writeFileSync(path.join(dir, variant.label ? `qa-${variant.key}.json` : 'qa.json'), `${JSON.stringify({ at: new Date().toISOString(), checklist: polished.checklist, problems: polished.judge.problems, warnings: polished.judge.warnings, sheet: polished.raster, notes: polished.notes }, null, 2)}\n`, 'utf-8');
    }
    results.push({ family, variant, spec: fitted, specPath, pdfPath, fit, qa });
    }
  }
  return results;
}

function parseArgs(argv) {
  const get = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };
  const famArg = get('--family') || get('--families');
  return {
    families: famArg ? famArg.split(',').map(s => s.trim()).filter(Boolean) : ALL_FAMILIES.map(f => f.key),
    specsOnly: argv.includes('--specs-only'),
    check: argv.includes('--check'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let results;
  try {
    results = await buildAll(opts);
  } catch (e) {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(1);
  }

  console.log(opts.check ? '\nValidated (nothing written):\n' : '\nBuilt:\n');
  for (const r of results) {
    const titles = r.spec.experience.filter(e => /Intern/i.test(e.title)).map(e => `${e.org.split(' ')[0]}: ${e.title}`);
    console.log(`  ${r.family.key.padEnd(17)} ${r.family.label}${r.variant && r.variant.label ? ` — ${r.variant.label}: ${r.variant.what}` : ` — base: ${r.variant ? r.variant.what : ""}`}`);
    console.log(`    ${titles.join('   |   ')}`);
    if (r.pdfPath) {
      const pct = Math.round((r.fit?.fill || 0) * 100);
      console.log(`    → ${path.relative(ROOT, r.pdfPath).replace(/\\/g, '/')}`);
      console.log(r.fit?.overflow
        ? `      ⚠ spills past one page (${pct}% at the tightest spacing) — cut a bullet from this family's plan`
        : `      page ${pct}% full`);
      // HIS RULE, SAID OUT LOUD AT THE MOMENT HE COULD ACT ON IT.
      //
      // "Bullets must not wrap to a stub" was a rule nothing measured, so two
      // bullets have been wrapping to 18% and 12% tails in every build (F-278).
      // Reported, never fatal: which qualifier to drop is his call, and a build
      // that refused to write a PDF over a short line would be worse than the
      // short line.
      for (const o of (r.fit?.orphans || [])) {
        console.log(`      ⚠ orphan tail — last line is ${Math.round(o.fraction * 100)}% of the width (${o.lines} lines): …${o.ends}`);
      }
      if (r.qa) {
        for (const n of r.qa.notes) console.log(`      · ${n}`);
        console.log(qaReport({ judge: r.qa.judge, raster: r.qa.raster, checklist: r.qa.checklist }).split('\n').map((l) => `    ${l}`).join('\n'));
        console.log(r.qa.checklist.ok ? '      ✓ passes his checklist' : '      ✗ FAILS his checklist — see above');
      }
    } else if (!opts.check) {
      console.log(`    → ${path.relative(ROOT, r.specPath).replace(/\\/g, '/')} (spec only)`);
    }
  }
  console.log(`\n  Every file is named "Alex Rivera Resume.pdf" on purpose — the FOLDER is the variant.`);
  console.log(`  Apply-time routing: jarvis/resume-family.mjs · content plans: jarvis/resume-variants.mjs\n`);

  if (results.some(r => r.fit?.overflow || (r.qa && !r.qa.checklist.ok))) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
