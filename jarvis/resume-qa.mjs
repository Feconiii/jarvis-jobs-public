/**
 * Layout QA for the one-page resume — measured on the page, then on the sheet.
 *
 * His rule (2026-09-06): "HTML exported successfully" is not success. The
 * rendered PDF must pass a visual check, and a defect that survives into the
 * file is a failure that costs another pass, never a note. What is measured:
 *
 *   ON THE DOM, after the page is fitted (line breaks are only known then):
 *     - every prose bullet: how many lines, how wide its last line is, and
 *       how many words that last line holds;
 *     - every Skills line: how many lines and what its second line carries;
 *     - the sections: where each starts and the gap above it;
 *     - the whole: content top and bottom, fill, overflow.
 *
 *   ON THE PDF, rasterised at 200 dpi through pdf.js in a real Chromium:
 *     - page count, the ink's bounding box (so clipping and the top/bottom
 *       whitespace are read off the printed sheet, not the HTML), and a PNG
 *       kept beside the PDF for a human to look at.
 *
 * `judgeLayout` turns measurements into problems (fail: another pass) and
 * warnings (said in the report). `acceptance` is his checklist, item by item.
 * Nothing here changes a word: the fixes live in resume-polish.mjs, which
 * decides what to reword, reorder, shorten, add or drop.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/** The rules, in one place, with his words. */
export const RULES = {
  maxBulletLines: 3,          // "1-3 lines per bullet"; four is a warning until nothing can compress it
  minTailFraction: 1 / 3,     // a wrapped bullet's last line is at least a third of the width
  minSkillsSecondLine: 0.3,   // a Skills line that wraps carries a meaningful second line
  minSkillsItemsOnLine2: 2,   // never one skill alone on the second line
  // At most two printed lines PER CATEGORY; the section has no total. Read as
  // a section total on 2026-09-22 and corrected by him on 2026-09-23 — "i
  // used to see like 3 lines of skills for one category". Enforced by
  // trimming items the posting did not ask for, never by shrinking type.
  maxSkillsLinesPerCategory: 2,
  minFill: 0.93,              // "roughly 95-100% useful page utilization"
  maxGapDiffPx: 14,           // top and bottom whitespace "reasonably balanced"
  sectionGapTolerancePx: 3,   // consistent section spacing
  maxBottomGapIn: 0.6,        // no large blank band at the bottom of the sheet
  minEdgeIn: 0.2,             // ink closer than this to an edge is clipping
};

/**
 * Measure the fitted page. Runs in the page; every number is from the layout
 * Chromium will print, not from the markup.
 */
export async function measureLayout(page, pageH = 1056) {
  return page.evaluate((PAGE_H) => {
    const y = (r) => r.top + window.scrollY;
    const lineRects = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      // Group fragments by line: rects on the same baseline belong to one line.
      const lines = [];
      for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.top - r.top) < r.height * 0.5) {
          last.left = Math.min(last.left, r.left); last.right = Math.max(last.right, r.right); last.width = last.right - last.left;
        } else lines.push({ top: r.top, height: r.height, left: r.left, right: r.right, width: r.width });
      }
      return lines;
    };
    // The text on one line, read through a caret at the line's start and the
    // next line's start. caretRangeFromPoint works in viewport coordinates.
    const textOfLine = (el, lines, i) => {
      try {
        const at = (line) => document.caretRangeFromPoint(line.left + 1, line.top + line.height / 2);
        const start = at(lines[i]);
        if (!start) return '';
        const r = document.createRange();
        r.setStart(start.startContainer, start.startOffset);
        if (i + 1 < lines.length) { const next = at(lines[i + 1]); if (next) r.setEnd(next.startContainer, next.startOffset); else r.setEndAfter(el); } else r.setEndAfter(el);
        return r.toString().replace(/\s+/g, ' ').trim();
      } catch { return ''; }
    };
    const sectionOf = (li) => { const sec = li.closest('.sec'); return sec ? (sec.querySelector('.sec-t')?.textContent || '').trim() : ''; };
    const prose = /^(experience|projects)$/i;
    const bullets = [];
    const skills = [];
    const education = [];
    for (const li of document.querySelectorAll('li')) {
      const title = sectionOf(li);
      const lines = lineRects(li);
      if (!lines.length) continue;
      const widest = Math.max(...lines.map((l) => l.width));
      const tail = lines[lines.length - 1].width;
      // How much of the line's full width the LAST line uses — measured against
      // the column, not the widest line, so a one-line skills list that stops
      // halfway reads 0.5 rather than 1.
      const box = li.getBoundingClientRect();
      const pcs = getComputedStyle(li);
      const contentLeft = box.left + (parseFloat(pcs.paddingLeft) || 0);
      const avail = box.width - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
      const lastLineFill = avail > 0 ? Math.round(((lines[lines.length - 1].right - contentLeft) / avail) * 100) / 100 : null;
      const lastText = lines.length > 1 ? textOfLine(li, lines, lines.length - 1) : '';
      const item = {
        section: title,
        lines: lines.length,
        chars: li.textContent.trim().length,
        tailFraction: lines.length > 1 ? Math.round((tail / widest) * 100) / 100 : 1,
        lastLineFill,
        lastLineWords: lines.length > 1 ? lastText.split(/\s+/).filter(Boolean).length : 0,
        lastLineText: lastText.slice(0, 80),
        ends: li.textContent.trim().slice(-52),
        top: Math.round(y(lines[0])),
      };
      if (prose.test(title)) bullets.push(item);
      else if (/^skills$/i.test(title)) {
        const secondItems = lastText ? lastText.split(/,\s*/).filter(Boolean).length : 0;
        skills.push({ ...item, lead: (li.querySelector('b')?.textContent || '').replace(/:$/, ''), secondLineItems: secondItems });
      } else if (/^education$/i.test(title)) {
        education.push({ ...item, lead: (li.querySelector('b')?.textContent || '').replace(/:$/, '') });
      }
    }
    const sections = [];
    let prevBottom = null;
    for (const sec of document.querySelectorAll('.sec')) {
      const r = sec.getBoundingClientRect();
      const title = (sec.querySelector('.sec-t')?.textContent || '').trim();
      const top = y(r); const bottom = y(r) + r.height;
      sections.push({ title, top: Math.round(top), bottom: Math.round(bottom), height: Math.round(r.height), gapAbove: prevBottom == null ? null : Math.round(top - prevBottom) });
      prevBottom = bottom;
    }
    const els = [...document.body.querySelectorAll('*')].filter((el) => el.getClientRects().length && el.textContent.trim());
    let top = Infinity, bottom = -Infinity;
    for (const el of els) { const r = el.getBoundingClientRect(); if (r.height <= 0) continue; top = Math.min(top, y(r)); bottom = Math.max(bottom, y(r) + r.height); }
    const cs = getComputedStyle(document.documentElement);
    return {
      pageH: PAGE_H,
      bodyHeight: document.body.scrollHeight,
      contentTop: isFinite(top) ? Math.round(top) : 0,
      contentBottom: isFinite(bottom) ? Math.round(bottom) : 0,
      lead: parseFloat(cs.getPropertyValue('--lead')) || null,
      gap: parseFloat(cs.getPropertyValue('--gap')) || null,
      fontPt: Math.round((parseFloat(getComputedStyle(document.body).fontSize) * 72) / 96 * 10) / 10,
      sections, bullets, skills, education,
    };
  }, pageH);
}

/** Problems fail the page (another pass); warnings are said. */
export function judgeLayout(m, rules = RULES) {
  const problems = [];
  const warnings = [];
  const fill = m.bodyHeight / m.pageH;
  if (m.bodyHeight > m.pageH) problems.push({ kind: 'overflow', detail: `content is ${Math.round(fill * 100)}% of the page — spills past one sheet` });
  else if (fill < rules.minFill) problems.push({ kind: 'underfull', detail: `page is ${Math.round(fill * 100)}% full — under ${Math.round(rules.minFill * 100)}%` });
  const topGap = m.contentTop, bottomGap = m.pageH - m.contentBottom;
  if (Math.abs(topGap - bottomGap) > rules.maxGapDiffPx) warnings.push({ kind: 'unbalanced', detail: `whitespace ${topGap}px above the header, ${bottomGap}px below the last line` });
  for (const b of m.bullets) {
    const where = `${b.section}: …${b.ends}`;
    if (b.lines > rules.maxBulletLines) problems.push({ kind: 'long-bullet', detail: `${b.lines}-line bullet (${b.chars} chars) in ${where}`, bullet: b });
    if (b.lines > 1 && b.lastLineWords === 1) problems.push({ kind: 'one-word-line', detail: `last line is one word ("${b.lastLineText}") in ${where}`, bullet: b });
    else if (b.lines > 1 && b.tailFraction < rules.minTailFraction) problems.push({ kind: 'stub', detail: `last line is ${Math.round(b.tailFraction * 100)}% of the width over ${b.lines} lines in ${where}`, bullet: b });
  }
  for (const s of m.skills) {
    if (s.lines > 1 && (s.secondLineItems < rules.minSkillsItemsOnLine2 || s.tailFraction < rules.minSkillsSecondLine)) {
      problems.push({ kind: 'skills-stub', detail: `Skills "${s.lead}" wraps to a second line of ${s.secondLineItems} item(s) ("${s.lastLineText}")`, skill: s });
    }
    // TWO LINES PER CATEGORY, NOT PER SECTION. His instruction of 2026-09-22
    // ("skills section should never be more than 2 lines") was read as a cap
    // on the whole section, and every page went out with two skills lines. He
    // corrected it 2026-09-23: "when i mean 2 lines of skills i meant in one
    // caterogy, not for everythinh, coz i used to see like 3 lines of skills
    // for one category … there is no cap on totla lines of skills".
    if (s.lines > rules.maxSkillsLinesPerCategory) {
      problems.push({
        kind: 'skills-category-long',
        detail: `Skills "${s.lead}" runs ${s.lines} lines (max ${rules.maxSkillsLinesPerCategory} per category)`,
        skill: s,
      });
    }
  }
  const gaps = m.sections.map((s) => s.gapAbove).filter((g) => g != null);
  if (gaps.length > 1 && Math.max(...gaps) - Math.min(...gaps) > rules.sectionGapTolerancePx) warnings.push({ kind: 'uneven-sections', detail: `section gaps range ${Math.min(...gaps)}–${Math.max(...gaps)}px` });
  return { problems, warnings, fill: Math.round(fill * 1000) / 1000, topGap, bottomGap };
}

/**
 * Rasterise page 1 of the PDF at `dpi` through pdf.js in a real Chromium, keep
 * the PNG beside the PDF, and read the ink's bounding box off it.
 */
export async function rasterize(pdfPath, { dpi = 200, outPath = null, browser = null } = {}) {
  const dist = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build');
  if (!existsSync(path.join(dist, 'pdf.min.mjs'))) return { ok: false, why: 'pdfjs-dist is not installed (npm install)' };
  const png = outPath || pdfPath.replace(/\.pdf$/i, '.png');
  const own = !browser;
  const b = browser || await chromium.launch();
  try {
    const page = await b.newPage();
    const serve = { '/index.html': { body: '<!doctype html><title>qa</title>', type: 'text/html' },
      '/pdf.min.mjs': { path: path.join(dist, 'pdf.min.mjs'), type: 'text/javascript' },
      '/pdf.worker.min.mjs': { path: path.join(dist, 'pdf.worker.min.mjs'), type: 'text/javascript' },
      '/doc.pdf': { path: pdfPath, type: 'application/pdf' } };
    await page.route('http://resume-qa.local/**', (route) => {
      const u = new URL(route.request().url());
      const hit = serve[u.pathname];
      if (!hit) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: hit.type, body: hit.body != null ? hit.body : readFileSync(hit.path) });
    });
    await page.goto('http://resume-qa.local/index.html');
    const out = await page.evaluate(async (scale) => {
      const pdfjs = await import('/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      const doc = await pdfjs.getDocument({ url: '/doc.pdf' }).promise;
      const p1 = await doc.getPage(1);
      const vp = p1.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p1.render({ canvasContext: ctx, viewport: vp }).promise;
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let top = -1, bottom = -1, left = width, right = -1;
      const rowInk = new Array(height).fill(0);
      for (let yy = 0; yy < height; yy += 1) {
        let inkThisRow = 0;
        for (let xx = 0; xx < width; xx += 1) {
          const i = (yy * width + xx) * 4;
          if (data[i] < 160 || data[i + 1] < 160 || data[i + 2] < 160) {
            inkThisRow += 1;
            if (xx < left) left = xx; if (xx > right) right = xx;
          }
        }
        rowInk[yy] = inkThisRow;
        if (inkThisRow > 0) { if (top < 0) top = yy; bottom = yy; }
      }
      return { dataUrl: canvas.toDataURL('image/png'), width, height, pages: doc.numPages, ink: { top, bottom, left, right } };
    }, dpi / 72);
    mkdirSync(path.dirname(png), { recursive: true });
    writeFileSync(png, Buffer.from(out.dataUrl.split(',')[1], 'base64'));
    const inches = (px) => Math.round((px / dpi) * 100) / 100;
    const ink = out.ink;
    const clipped = ink.top >= 0 && (inches(ink.top) < RULES.minEdgeIn || inches(out.height - ink.bottom) < RULES.minEdgeIn || inches(ink.left) < RULES.minEdgeIn || inches(out.width - ink.right) < RULES.minEdgeIn);
    return {
      ok: true, png, dpi, pages: out.pages, width: out.width, height: out.height,
      topGapIn: inches(ink.top), bottomGapIn: inches(out.height - 1 - ink.bottom),
      leftGapIn: inches(ink.left), rightGapIn: inches(out.width - 1 - ink.right),
      inkHeightIn: inches(ink.bottom - ink.top), utilization: Math.round(((ink.bottom - ink.top) / out.height) * 1000) / 1000,
      clipped,
    };
  } finally { if (own) await b.close(); }
}

/**
 * His acceptance checklist, item by item, on what was measured. `content`
 * carries what the tailor said about the writing (its two tests), which
 * this file cannot judge and does not pretend to.
 */
export function acceptance({ layout, judge, raster, text = null, fontPt = null, content = {}, links = null, proof = null }) {
  const has = (kind) => judge.problems.some((p) => p.kind === kind);
  const items = [];
  const add = (item, ok, note = '') => items.push({ item, ok: !!ok, note });
  add('Exactly one page', !has('overflow') && (!raster?.ok || raster.pages === 1) && (text?.pages ?? 1) === 1, raster?.ok ? `${raster.pages} page(s) in the PDF` : 'PDF not rasterised');
  add('Approximately 11 pt body text', (fontPt ?? layout?.fontPt ?? 0) >= 10.4 && (fontPt ?? layout?.fontPt ?? 0) <= 11.6, `${fontPt ?? layout?.fontPt ?? '?'} pt`);
  add('ATS-safe text layer', !text || !(text.lost || []).length, text ? (text.lost?.length ? `words lost: ${text.lost.join(', ')}` : 'every word extracts') : 'pdftotext not available');
  add('No clipping', !raster?.ok || !raster.clipped, raster?.ok ? `ink ${raster.leftGapIn}in from the left edge, ${raster.topGapIn}in from the top` : '');
  // The header links are styled to look like body text, so a lost one looks
  // identical to a working one on screen and in print preview. Only the file
  // itself can say. Unknown counts as passing — see linkCheck().
  add('Contact links clickable', !links || links.ok,
    !links ? 'not checked'
      : !links.known ? 'the PDF could not be read for links'
        : links.missing.length ? `not clickable: ${links.missing.map((l) => l.text).join(', ')}`
          : `${links.want.length} live: ${links.want.map((l) => l.kind).join(', ')}`);
  add('No overflow', !has('overflow'));
  add('No orphan words', !has('one-word-line'));
  add('No isolated skill on a second line', !has('skills-stub'));
  add('No unnecessary 4-line bullets', !has('long-bullet'), has('long-bullet') ? judge.problems.filter((p) => p.kind === 'long-bullet').map((p) => p.detail).join('; ') : '');
  add('No tiny final bullet fragments', !has('stub'));
  add('Balanced whitespace', !judge.warnings.some((w) => w.kind === 'unbalanced') && (!raster?.ok || Math.abs(raster.topGapIn - raster.bottomGapIn) <= 0.15), raster?.ok ? `${raster.topGapIn}in above, ${raster.bottomGapIn}in below on the sheet` : `${judge.topGap}px above, ${judge.bottomGap}px below`);
  add('Strong page utilization', !has('underfull') && (!raster?.ok || raster.bottomGapIn <= RULES.maxBottomGapIn), `${Math.round((judge.fill || 0) * 100)}% of the page`);
  add('Clean Skills section', !has('skills-stub'));
  add('No skills category over two lines', !has('skills-category-long'),
    has('skills-category-long')
      ? judge.problems.filter((p) => p.kind === 'skills-category-long').map((p) => p.detail).join('; ')
      : 'every category within two lines');
  // Literal mistakes: a hyphenless "6 DOF", a missing period, "an issue
  // reducing jams" (his concern, 2026-09-23). Not checked counts as passing.
  add('No literal mistakes', !proof || !proof.length,
    !proof ? 'not checked' : proof.length ? proof.map((p) => `${p.where}: ${p.problem}`).join('; ') : 'proofread clean');
  add('Consistent section spacing', !judge.warnings.some((w) => w.kind === 'uneven-sections'));
  add('Strong technical impression', content.tailored !== false, content.tailored === false ? 'no description to write towards — his own words' : 'the tailor\'s cold-read test');
  add('Strong JD fit', content.tailored !== false, content.tailored === false ? 'no description' : 'the tailor\'s fit test');
  add('No filler bullets', true, 'the pool holds no assumed-activity bullets; the tailor selects by incremental value');
  add('Rendered PDF visually inspected', !!raster?.ok, raster?.ok ? `${path.basename(raster.png)} at ${raster.dpi} dpi` : (raster?.why || 'not rasterised'));
  return { ok: items.every((i) => i.ok), items };
}

/** A short, readable report. */
export function qaReport({ judge, raster, checklist }) {
  const lines = [];
  for (const p of judge?.problems || []) lines.push(`  ✗ ${p.detail}`);
  for (const w of judge?.warnings || []) lines.push(`  ~ ${w.detail}`);
  if (raster?.ok) lines.push(`  sheet: ${raster.pages} page(s) · ink ${raster.topGapIn}in from top, ${raster.bottomGapIn}in from bottom · ${Math.round(raster.utilization * 100)}% of the height · ${path.basename(raster.png)}`);
  for (const i of checklist?.items || []) lines.push(`  [${i.ok ? 'x' : ' '}] ${i.item}${i.note ? ` — ${i.note}` : ''}`);
  return lines.join('\n');
}
