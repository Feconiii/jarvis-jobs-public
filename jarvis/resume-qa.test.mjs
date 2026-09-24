/**
 * Layout QA: the judge on measured pages, the Skills orders, and the sheet
 * check on a real render.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { judgeLayout, acceptance, measureLayout, rasterize, RULES } from './resume-qa.mjs';
import { skillOrders, polish } from './resume-polish.mjs';
import { renderHtml, PAGE_H, contactLinks, linkCheck, pdfLinks } from './resume.mjs';

const clean = () => ({
  pageH: 1056, bodyHeight: 1040, contentTop: 34, contentBottom: 1022, fontPt: 10.5, lead: 1.2, gap: 6,
  sections: [{ title: 'Education', gapAbove: null }, { title: 'Experience', gapAbove: 8 }, { title: 'Skills', gapAbove: 8 }],
  bullets: [{ section: 'Experience', lines: 3, chars: 300, tailFraction: 0.6, lastLineWords: 7, lastLineText: 'and released it through Teamcenter.', ends: 'Teamcenter.' }],
  skills: [{ section: 'Skills', lead: 'CAD/CAE', lines: 1, tailFraction: 1, lastLineWords: 0, secondLineItems: 0, lastLineText: '' }],
});

test('A CLEAN PAGE HAS NO PROBLEMS', () => {
  const j = judgeLayout(clean());
  assert.deepEqual(j.problems, []);
  assert.deepEqual(j.warnings, []);
  assert.equal(j.fill, 0.985);
});

test('THE DEFECTS HE NAMED ARE EACH A PROBLEM: 4-line bullet, one-word line, stub, isolated skill, short page', () => {
  const m = clean();
  m.bullets.push({ section: 'Experience', lines: 4, chars: 420, tailFraction: 0.5, lastLineWords: 6, lastLineText: 'x', ends: 'four lines.' });
  m.bullets.push({ section: 'Projects', lines: 2, chars: 140, tailFraction: 0.08, lastLineWords: 1, lastLineText: 'positioning.', ends: 'positioning.' });
  m.bullets.push({ section: 'Experience', lines: 2, chars: 150, tailFraction: 0.2, lastLineWords: 3, lastLineText: 'jams by 70%.', ends: 'jams by 70%.' });
  m.skills.push({ section: 'Skills', lead: 'CAD/CAE', lines: 2, tailFraction: 0.06, lastLineWords: 1, secondLineItems: 1, lastLineText: 'AutoCAD' });
  m.bodyHeight = 900;
  const j = judgeLayout(m);
  const kinds = j.problems.map((p) => p.kind);
  assert.ok(kinds.includes('long-bullet'), 'four lines');
  assert.ok(kinds.includes('one-word-line'), '"AutoCAD"-style orphan word');
  assert.ok(kinds.includes('stub'), 'a tiny final fragment');
  assert.ok(kinds.includes('skills-stub'), 'one skill alone on a second line');
  assert.ok(kinds.includes('underfull'), 'a short page');
  const a = acceptance({ layout: m, judge: j, raster: null, text: { lost: [], pages: 1 } });
  assert.equal(a.ok, false);
  assert.ok(a.items.find((i) => i.item === 'No isolated skill on a second line').ok === false);
  assert.ok(a.items.find((i) => i.item === 'No unnecessary 4-line bullets').ok === false);
  assert.ok(a.items.find((i) => i.item === 'Strong page utilization').ok === false);
});

test('WHITESPACE AND SECTION SPACING ARE WARNINGS, said not hidden', () => {
  const m = clean();
  m.contentTop = 20; m.contentBottom = 1000; // 20 above, 56 below
  m.sections[2].gapAbove = 16;
  const j = judgeLayout(m);
  assert.ok(j.warnings.some((w) => w.kind === 'unbalanced'));
  assert.ok(j.warnings.some((w) => w.kind === 'uneven-sections'));
  assert.deepEqual(j.problems, []);
});

test('SKILL ORDERS put the long items where a second line is worth having, never the same order twice', () => {
  const items = ['SolidWorks', 'Inventor', 'Siemens NX', 'GD&T', 'FEA', 'AutoCAD'];
  const orders = skillOrders(items);
  assert.ok(orders.length >= 3);
  const seen = new Set(orders.map((o) => o.join('|')));
  assert.equal(seen.size, orders.length, 'no duplicates');
  assert.ok(!seen.has(items.join('|')), 'never the order that failed');
  for (const o of orders) assert.deepEqual([...o].sort(), [...items].sort(), 'the same items, reordered');
  assert.ok(orders.some((o) => o.slice(-2).includes('Siemens NX') && o.slice(-2).includes('SolidWorks')), 'the two longest at the end is tried');
});

test('THE POLISH LOOP MEASURES A REAL PAGE and the sheet check reads the PDF back', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-qa-'));
  try {
    const long = 'Designed, prototyped, and validated a machine-vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor, incorporating self-locking camera positioning, controlled lighting, 120-degree indexing using ball plungers, dovetail interfaces, and tolerance analysis; created the engineering drawings and BOM, ordered components from suppliers, and released the design through Teamcenter with its release documentation.';
    const short = 'Designed and validated an Autodesk Inventor machine vision fixture for three Metal Deposition chamber variants, integrating controlled lighting, 120-degree indexing with ball plungers, dovetail interfaces and tolerance analysis; created drawings/BOMs and released the design through Teamcenter.';
    const bullets = (n, text) => Array.from({ length: n }, (_, i) => ({ text, short, source: [text, short], provenanceKey: `amat.b${i}` }));
    const spec = {
      name: 'Alex Rivera', contact: { location: 'Springfield, WA', phone: '+1 (555) 000-0000', email: 'v@example.test' },
      order: ['education', 'experience', 'projects', 'skills'],
      education: [{ school: 'State University', degree: 'Bachelor of Science: Mechanical Engineering', location: 'Springfield, Washington', date: 'May 2027', bullets: [{ lead: 'GPA 3.85', text: 'an engineering honor society' }] }],
      experience: [{ org: 'Applied Materials', orgKey: 'amat', title: 'Mechanical Engineer Intern', location: 'Austin, Texas', date: 'May 2026 – August 2026', bullets: bullets(6, long) },
        { org: 'Acme Steel Stud Company', orgKey: 'acme', title: 'Mechanical Engineer Intern', location: 'Springfield, Washington', date: 'May 2025 – August 2025', bullets: bullets(3, long).map((b, i) => ({ ...b, provenanceKey: `acme.b${i}` })) }],
      projects: [{ key: 'arm', lead: 'Robotic Arm', text: 'Designed and built a 4 DOF robotic arm using MG90S servo motors and 3D-printed casing, implementing inverse kinematics and Arduino based control for precise end effector positioning.' }],
      skills: [{ key: 'cad', lead: 'CAD/CAE', text: 'SolidWorks, Siemens NX, Autodesk Inventor, Fusion 360, AutoCAD, GD&T, Tolerance Analysis, FEA, DFM/DFA, Ansys' }],
    };
    const pdfPath = path.join(dir, 'Alex Rivera Resume.pdf');
    const r = await polish(spec, { pdfPath, pool: { skills: { cad: { items: ['SolidWorks', 'Siemens NX', 'Autodesk Inventor', 'Fusion 360', 'AutoCAD', 'GD&T', 'Tolerance Analysis', 'FEA', 'DFM/DFA', 'Ansys', 'Creo'] } } }, dpi: 100 });
    assert.ok(existsSync(pdfPath), 'a PDF');
    assert.ok(r.layout && Array.isArray(r.layout.bullets) && r.layout.bullets.length > 0, 'the page was measured');
    assert.ok(!r.judge.problems.some((p) => p.kind === 'long-bullet'), `four-line bullets are answered with the short form: ${JSON.stringify(r.judge.problems)}`);
    assert.ok(!r.judge.problems.some((p) => p.kind === 'overflow'), 'one page');
    assert.ok(r.notes.some((n) => /short form/.test(n)), `the notes say what was done: ${JSON.stringify(r.notes)}`);
    assert.ok(r.raster?.ok, `the sheet was rasterised: ${r.raster?.why || ''}`);
    assert.equal(r.raster.pages, 1);
    assert.ok(existsSync(r.raster.png), 'the PNG is kept beside the PDF');
    assert.ok(r.raster.topGapIn > 0.2 && r.raster.bottomGapIn > 0.1, `ink sits inside the margins: ${r.raster.topGapIn} / ${r.raster.bottomGapIn}`);
    assert.equal(r.raster.clipped, false);
    assert.ok(r.checklist.items.find((i) => i.item === 'Rendered PDF visually inspected').ok);
    assert.ok(r.checklist.items.find((i) => i.item === 'Exactly one page').ok);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A HYPHENATED COMPOUND NEVER BREAKS AT ITS HYPHEN on the page', async () => {
  const b = await chromium.launch();
  try {
    const page = await b.newPage({ viewport: { width: 816, height: PAGE_H + 400 } });
    const spec = { name: 'V', contact: {}, order: ['experience'], experience: [{ org: 'X', title: 'Y', bullets: [{ text: `${'word '.repeat(19)}pin-alignment verification` }] }] };
    await page.setContent(renderHtml(spec));
    const html = await page.content();
    assert.match(html, /<span style="white-space:nowrap">pin-alignment<\/span>/);
    const m = await measureLayout(page, PAGE_H);
    assert.equal(m.bullets.length, 1);
    assert.ok(!/^alignment/.test(m.bullets[0].lastLineText), `a line never starts with the second half of a compound: "${m.bullets[0].lastLineText}"`);
  } finally { await b.close(); }
});

/**
 * THE HEADER LINKS ARE MEASURED ON THE FILE, NOT ASSUMED (2026-09-19).
 *
 * They were styled to look like body text then, so a lost annotation was
 * invisible; since 2026-09-23 they are blue, and a blue word with no link
 * behind it would look clickable and go nowhere. Twenty
 * builds sat in data/jarvis/builds/ before this check existed and only the
 * last one carried links — the rest predated the feature and no run ever said
 * so. That silence is what this closes.
 */
const CONTACT = { email: 'a@b.c', linkedin: 'linkedin.com/in/someone', portfolio: 'example-portfolio.test' };

test('THE LINK TEXT STAYS BARE AND THE HREF CARRIES THE SCHEME', () => {
  const [email, li, site] = contactLinks(CONTACT);
  assert.equal(email.href, 'mailto:a@b.c');
  // www on the href only — Workday rejects LinkedIn without it.
  assert.equal(li.href, 'https://www.linkedin.com/in/someone');
  assert.equal(li.text, 'linkedin.com/in/someone');
  // His site is served bare and printing a scheme in front of it is wrong.
  assert.equal(site.text, 'example-portfolio.test');
  assert.equal(site.href, 'https://example-portfolio.test');
});

test('A MISSING LINK FAILS THE CHECKLIST, AND NAMES THE ONE THAT IS GONE', () => {
  const found = ['mailto:a@b.c', 'https://www.linkedin.com/in/someone'];
  const links = linkCheck(CONTACT, found);
  assert.equal(links.ok, false);
  assert.deepEqual(links.missing.map((l) => l.kind), ['portfolio']);
  const item = acceptance({ layout: clean(), judge: judgeLayout(clean()), raster: null, links })
    .items.find((i) => i.item === 'Contact links clickable');
  assert.equal(item.ok, false);
  assert.match(item.note, /example-portfolio\.test/);
});

test('ALL THREE PRESENT PASSES, AND A TRAILING SLASH IS THE SAME LINK', () => {
  const links = linkCheck(CONTACT, ['mailto:a@b.c', 'https://www.linkedin.com/in/someone', 'https://example-portfolio.test/']);
  assert.equal(links.ok, true);
  assert.deepEqual(links.missing, []);
});

test('A FILE THAT CANNOT BE READ FOR LINKS IS UNKNOWN, NEVER "MISSING"', () => {
  // A false alarm on a good resume is the expensive error: it sends him
  // rebuilding a sheet that was already right.
  const links = linkCheck(CONTACT, null);
  assert.equal(links.ok, true);
  assert.equal(links.known, false);
});

test('pdfLinks READS NESTED PARENS AND ESCAPES, AND SHRUGS AT A MISSING FILE', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'links-'));
  const f = path.join(dir, 'x.pdf');
  // String.raw so the FILE really holds a backslash: '\)' in an ordinary JS
  // string is just ')', which is a different fixture than the one meant here.
  writeFileSync(f, String.raw`/URI (https://e.test/a\)b) /URI (https://e.test/(nested)) /URI (https://e.test/a\)b)`, 'latin1');
  // Deduplicated, and neither escaped nor nested parens end the string early.
  assert.deepEqual(pdfLinks(f), ['https://e.test/a)b', 'https://e.test/(nested)']);
  assert.equal(pdfLinks(path.join(dir, 'nope.pdf')), null);
  rmSync(dir, { recursive: true, force: true });
});

// HIS RULE, CORRECTED 2026-09-23: "when i mean 2 lines of skills i meant in
// one caterogy, not for everythinh … there is no cap on totla lines of skills".
test('TWO LINES PER SKILLS CATEGORY, AND NO CAP ON THE SECTION', () => {
  const five = clean();
  for (const lead of ['CAD/CAE', 'Automation/Software', 'Manufacturing', 'Process/Quality', 'AI Tools']) {
    five.skills.push({ section: 'Skills', lead, lines: 1, tailFraction: 1, lastLineWords: 0, secondLineItems: 0, lastLineText: '' });
  }
  five.skills.push({ section: 'Skills', lead: 'Two-liner', lines: 2, tailFraction: 0.9, lastLineWords: 6, secondLineItems: 5, lastLineText: 'a, b, c, d, e' });
  const ok = judgeLayout(five);
  assert.ok(!ok.problems.some((p) => /skills/.test(p.kind)), JSON.stringify(ok.problems));

  const three = clean();
  three.skills.push({ section: 'Skills', lead: 'Process/Quality', lines: 3, tailFraction: 0.8, lastLineWords: 6, secondLineItems: 5, lastLineText: 'a, b, c, d, e' });
  const bad = judgeLayout(three);
  assert.ok(bad.problems.some((p) => p.kind === 'skills-category-long' && /Process\/Quality/.test(p.detail)), JSON.stringify(bad.problems));
});
