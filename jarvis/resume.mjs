#!/usr/bin/env node
// jarvis/resume.mjs — render a per-job tailored resume to PDF.
//
// THE MODEL: cv.md holds every detail of his experience. Content is selected
// from it into a spec (JSON) — reordered and re-emphasised for a lane, NEVER
// invented — and this script is the deterministic renderer: spec → clean
// ATS-safe HTML → PDF → optionally sets the job's resume_path in the store so
// the apply engine uploads that resume automatically.
//
// Normally you do not call this directly: `node jarvis/build-resumes.mjs` builds
// all four family resumes (total-experience / automation / manufacturing /
// mechanical) from jarvis/resume-pool.json + jarvis/resume-variants.mjs and
// renders them through here. Use this script directly only for a genuine
// one-off resume authored for a single posting.
//
// ATS-safety (borrowed from templates/cv-template.html's hard-won fixes):
// standard system sans, ligatures disabled — otherwise PDF text extractors
// corrupt keywords ("veriﬁcation", "SUM M ARY") and ATS parsing misses them.
//
// Usage:
//   node jarvis/resume.mjs --spec <spec.json> [--job <id> | --url <postingUrl>] [--out <path>]

import { readFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { measureLayout } from './resume-qa.mjs';
import { updateJob, jobId } from './store.mjs';

const OUT_DIR = path.join('output', 'jarvis-resumes');

// ── PDF text-layer safety (measured, not assumed) ────────────────────
//
// An earlier version of this file claimed font-kerning:none +
// text-rendering:optimizeSpeed prevented Chromium from injecting spurious
// spaces into the PDF text layer ("hardw are", "SUM M ARY", "M anufacturing").
// They do not: sweeping those properties changes nothing — every variant
// produced identical breakage. The corruption is a function of FONT + SIZE.
//
// Typography matches the resume Alex authored himself (AlexRiveraResume.docx):
// Times New Roman, 10.5pt body. Traditional serif, and the setting he already
// trusts — don't swap it for something "cleaner" without asking; he rejected
// Tahoma as looking wonky. Margins are 0.35in since 2026-09-03 (his tailoring
// skill §3: "approximately 0.35-inch margins", "approximately 11 pt") — the
// body stays at 10.5 because 11 loses words in the text layer, measured below,
// and 10.5 is what "approximately 11" can honestly mean.
//
// The size/leading were still chosen by measurement, not taste: every candidate
// is rendered, round-tripped through pdftotext, and scored on words lost + page
// count + vertical fill (jarvis/resume.test.mjs). At 338 words:
//   Times New Roman 10.5pt / leading 1.20   1 page, 96% fill, 0 lost  ← chosen
//   Times New Roman 10.5pt / leading 1.28   spills to 2 pages
//   Times New Roman 11pt                    13 words lost
//   Georgia (any size)                      3-47 words lost
//   Cambria / Garamond / Book Antiqua 10pt  clean, but 10.5pt+ runs 2 pages
// Text-layer integrity is NOT predictable from the font or the size — Times is
// clean at 10.5 and loses words at 11 — so re-run the sweep after ANY change to
// the font, size, or content volume. A split word is invisible on screen and
// silently costs the ATS keyword match the resume exists to win.
const FONT_STACK = process.env.JARVIS_RESUME_FONT
  || `'Times New Roman',Times,'Liberation Serif',serif`;
const BASE_PT = Number(process.env.JARVIS_RESUME_PT || 10.5);
const pt = (scale) => `${(BASE_PT * scale).toFixed(2)}pt`;
// Narrow margins + tight leading: the goal is a FULL page, not a sparse one.
// Overridable so the fit sweep can search the layout space without edits.
const PAGE_PAD = process.env.JARVIS_RESUME_PAD || '0.35in';
const LEADING = Number(process.env.JARVIS_RESUME_LEADING || 1.2);
const GAP = Number(process.env.JARVIS_RESUME_GAP || 6);

function esc(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
/**
 * Prose with its hyphenated compounds held together. A line that breaks at
 * "pin-" / "alignment" is dehyphenated by pdftotext (and by ATS parsers built
 * the same way) into "pinalignment", and the keyword is gone — measured on
 * a build whose leading moved the break onto the hyphen (2026-09-06). A
 * nowrap span costs nothing visible and keeps the word whole in the layer.
 */
function prose(s) {
  return esc(s).replace(/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)/g, (m) => `<span style="white-space:nowrap">${m}</span>`);
}

/** spec → self-contained ATS-safe HTML. */
/**
 * The clickable part of the header: what a human reads, and where the click
 * goes. One definition, used both to RENDER the page and to CHECK the finished
 * PDF, so the two cannot drift apart and report a link that was never drawn.
 *
 * THE TEXT STAYS BARE AND THE HREF CARRIES THE SCHEME. His site is served at
 * the bare domain and he was explicit that printing "https://" in front of it
 * is wrong, but an href without a scheme resolves against the PDF's own
 * location and goes nowhere. So they are separated.
 */
export function contactLinks(c = {}) {
  const withScheme = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(String(u)) ? String(u) : `https://${String(u).replace(/^\/+/, '')}`);
  const bare = (u) => String(u).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const out = [];
  // mailto: opens his mail client with the address already in it.
  if (c.email) out.push({ kind: 'email', text: String(c.email), href: `mailto:${c.email}` });
  // www on the href only: the codebase already settled that www is the
  // canonical LinkedIn form (KLA's Workday rejects it without), while the
  // text keeps the short spelling his own one-pager uses.
  if (c.linkedin) out.push({ kind: 'linkedin', text: bare(c.linkedin), href: withScheme(bare(c.linkedin).replace(/^linkedin\.com/i, 'www.linkedin.com')) });
  if (c.portfolio) out.push({ kind: 'portfolio', text: bare(c.portfolio), href: withScheme(c.portfolio) });
  return out;
}

/**
 * Which of the header links the finished PDF really carries. `found` is null
 * when the file could not be read for them at all — unknown, not missing.
 */
export function linkCheck(contact, found) {
  const want = contactLinks(contact);
  if (!Array.isArray(found)) return { ok: true, known: false, want, missing: [] };
  // A viewer follows the annotation, so compare on the href. Trailing slashes
  // are the writer's, not ours: "alexrivera.example/" is the same link.
  const norm = (u) => String(u).replace(/\/+$/, '').toLowerCase();
  const got = new Set(found.map(norm));
  const missing = want.filter((l) => !got.has(norm(l.href)));
  return { ok: !missing.length, known: true, want, missing };
}

export function renderHtml(spec) {
  const c = spec.contact || {};
  // The header he specified (2026-09-03, skill §5): centred, name about 17.5pt,
  // "Springfield, WA | phone | email" — location, phone, email, bars between. It
  // is also exactly the header on the one-pager he wrote himself, which has no
  // LinkedIn line either.
  //
  // CLICKABLE, 2026-09-19. His ask: *"hyperlink my linked in and put in
  // alexrivera.example make that clickable as well, same with email where it
  // pulls up gmail to make recruiter send email to me ez"*. A recruiter reads
  // this PDF on a screen; a link they can press is the difference between
  // getting an email and being retyped into one.
  //
  // Where the text and the href part company is contactLinks() above.
  //
  // Underline is deliberately off. The link still works and still copies; a row
  // of blue underlines across the top of a one-page resume reads as a web page,
  // not a document, and he has never had one.
  const linkTo = (text, href) => `<a href="${esc(href)}">${esc(text)}</a>`;
  const contactBits = [
    c.location ? esc(c.location) : '',
    c.phone ? esc(c.phone) : '',
    ...contactLinks(c).map((l) => linkTo(l.text, l.href)),
  ].filter(Boolean).join('  |  ');
  const section = (title, inner) => inner ? `<div class="sec"><div class="sec-t">${esc(title)}</div>${inner}</div>` : '';

  // A bullet is either a plain string or { lead, text }. The lead renders bold
  // and inline ("AMR Deployment: Supported deployment…") — it is what makes a
  // dense resume scannable instead of a wall of text, and it costs no extra
  // lines. Kept inside the <li> so the PDF text layer stays one continuous run.
  const li = (b) => {
    if (b && typeof b === 'object') {
      return `<li>${b.lead ? `<b>${esc(b.lead)}:</b> ` : ''}${prose(b.text || '')}</li>`;
    }
    return `<li>${prose(b)}</li>`;
  };
  const bullets = (list) => (list && list.length) ? `<ul>${list.map(li).join('')}</ul>` : '';

  // Two header rows, matching the layout Alex already uses: organisation and
  // place on the first, role and dates on the second. Falls back to the older
  // single-row `title — org` shape so specs written before this still render.
  const entry = (e, primary, secondary) => {
    const right1 = e.location || (primary === 'school' ? '' : e.date);
    // The team after the title, same line, vertical bar — never its own line,
    // never parentheses (Alex, 2026-09-03).
    const secondaryText = e[secondary] && e.group ? `${e[secondary]} | ${e.group}` : e[secondary];
    const rows = (e[primary] && secondaryText)
      ? `<div class="row"><span class="h">${esc(e[primary])}</span><span class="d">${esc(right1 || '')}</span></div>
         <div class="row"><span class="sub">${esc(secondaryText)}</span><span class="d">${esc(e.date || '')}</span></div>`
      : `<div class="row"><span class="h">${esc(e[primary] || e[secondary] || '')}</span><span class="d">${esc(e.date || '')}</span></div>
         ${e.sub ? `<div class="sub">${esc(e.sub)}</div>` : ''}`;
    return `<div class="item">${rows}${bullets(e.bullets)}</div>`;
  };

  const expItems = (spec.experience || []).map(e => entry(e, 'org', 'title')).join('');
  const eduItems = (spec.education || []).map(e => entry(e, 'school', 'degree')).join('');

  // Projects and skills are flat bulleted lists with bold lead-ins — one line
  // each instead of a heading plus a bullet, which buys back a third of a page.
  const projItems = (spec.projects || []).length
    ? `<div class="item">${bullets(spec.projects.map(p => p.lead ? p : { lead: p.title, text: (p.bullets || []).join(' ') }))}</div>`
    : '';

  const skills = Array.isArray(spec.skills)
    ? `<div class="item">${bullets(spec.skills)}</div>`
    : (spec.skills ? `<div class="skills">${esc(spec.skills)}</div>` : '');

  // Section order is the spec's call — a student leads with education, someone
  // ten years in leads with experience. `order` lets a tailored resume reorder
  // for a specific posting without touching this renderer.
  const SECTIONS = {
    summary: spec.summary ? `<div class="sec"><div class="sec-t">Summary</div><div class="summary">${esc(spec.summary)}</div></div>` : '',
    education: section('Education', eduItems),
    experience: section('Experience', expItems),
    projects: section('Projects', projItems),
    skills: section('Skills', skills),
  };
  const order = Array.isArray(spec.order) && spec.order.length
    ? spec.order
    : ['summary', 'experience', 'projects', 'education', 'skills'];

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  /* Ligatures off so "verification" never extracts as "veriﬁcation".
     Font + pt sizing (see FONT_STACK / BASE_PT above) are what actually keep
     the PDF text layer clean — that part is measured, not assumed. */
  * { margin:0; padding:0; box-sizing:border-box; font-variant-ligatures:none; font-feature-settings:"liga" 0,"clig" 0,"dlig" 0; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  /* Dense-but-readable: narrow margins and tight leading so a full-content
     one-pager fills the sheet instead of spilling. PAGE_PAD / LEADING are
     tunable via env for the fit sweep in resume.test.mjs. */
  /* --lead and --gap are driven by the auto-fit pass in renderPdf(): it grows
     the spacing until the content just fills the page. Only SPACING is tuned,
     never the font size — glyph advances (and therefore PDF text-layer
     integrity) depend on the size, and spacing does not. */
  :root { --lead:${LEADING}; --gap:${GAP}px; }
  body { font-family:${FONT_STACK}; font-size:${pt(1)}; line-height:var(--lead); color:#111; padding:${PAGE_PAD}; }
  /* The name was set at 2.05× body and ate a visible slice of the page for no
     information — a recruiter already knows whose resume they opened. Alex's
     own one-pager sets it far smaller, and the space it frees goes to bullets,
     which is what actually gets read. */
  /* No letter-spacing anywhere: at .7px the section titles extracted as
     "EDUCATI O N" (pdftotext, measured 2026-09-03), which is the section an ATS
     parser keys on. Weight and case carry the hierarchy on their own. */
  .name { font-size:${pt(1.667)}; font-weight:700; line-height:1.15; text-align:center; }
  .contact { color:#222; font-size:${pt(1)}; margin-top:2px; text-align:center; }
  /* One notch down and grey: it answers a gate, it is not a headline. */
  /* One notch down and grey: it answers a gate, it is not a headline.
     pt(0) here rendered it at 0.00pt — present in the HTML, absent from the
     PDF text layer, which the lost-words check caught. Scale, never zero. */
  /* The links are real PDF annotations, and they are BLUE so a reader knows
     they can be clicked — his call, 2026-09-23: "how they gonna know if its
     not". Same weight as the rest of the line, no underline. */
  .contact a { color:#1155cc; text-decoration:none; }
  .sec { margin-top:var(--gap); }
  .sec-t { font-size:${pt(1.02)}; font-weight:700; text-transform:uppercase; border-bottom:1.2px solid #222; padding-bottom:1px; margin-bottom:3px; }
  .item { margin-bottom:var(--gap); }
  .item:last-child { margin-bottom:0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
  .h { font-weight:700; }
  .d { color:#444; font-size:${pt(0.95)}; white-space:nowrap; }
  .sub { font-style:italic; color:#333; font-size:${pt(0.97)}; }
  ul { margin:1px 0 0 13px; padding:0; } li { margin-bottom:.5px; }
  li b { font-weight:700; }
  .summary { margin-top:4px; }
  .skills { white-space:pre-line; }
  </style></head><body>
  <div class="name">${esc(spec.name)}</div>
  <div class="contact">${contactBits}</div>
  ${order.map(k => SECTIONS[k] || '').join('\n  ')}
  </body></html>`;
}

// US Letter at CSS 96dpi. body padding supplies the printed margin, so a
// scrollHeight equal to PAGE_H means "content ends exactly at the bottom
// margin" — a full page, not an overflowing one.
export const PAGE_H = 1056;
// Stop just shy of the boundary: sub-pixel rounding in Chromium's paginator can
// push a page-height-exactly-1056 layout onto a second sheet.
const FIT_TARGET = 1050;

/**
 * Grow the spacing until the content fills the page.
 *
 * Binary-searches ONE "spread" knob (0..1) that drives line-height and the
 * section/item gaps together, and returns the largest value whose layout still
 * fits on a single sheet. This is what stops a resume from rendering with an
 * inch of dead space at the bottom, whatever its content length — a tailored
 * spec that is three bullets shorter now expands to fill rather than leaving a
 * gap, and one that is longer tightens instead of spilling to page two.
 *
 * Deliberately does NOT touch font-size: text-layer integrity varies
 * unpredictably with size (Times is clean at 10.5pt and drops words at 11pt),
 * so the verified size is fixed and only spacing moves.
 */
export async function fitToPage(page) {
  // THE SPREAD IS CAPPED (2026-09-06). It used to open the leading to 1.67 to
  // reach the bottom of a short page, which is how a resume came to look
  // "airy" and fragmented beside one with the same content set tight. A
  // short page is now answered with content (resume-polish.mjs adds the next
  // reserve bullet) and only then with spacing, and the spacing stops at a
  // leading of 1.30 and a section gap of 11px — the range a composed page
  // sits in.
  const spreadTo = (s) => ({ lead: 1.12 + s * 0.18, gap: 3 + s * 8 });
  const measure = async (s) => {
    const { lead, gap } = spreadTo(s);
    await page.evaluate(([l, g]) => {
      document.documentElement.style.setProperty('--lead', String(l));
      document.documentElement.style.setProperty('--gap', `${g}px`);
    }, [lead, gap]);
    return page.evaluate(() => document.body.scrollHeight);
  };

  const tightest = await measure(0);
  if (tightest > FIT_TARGET) return { fill: tightest / PAGE_H, overflow: true, spread: 0, underfull: false, ...spreadTo(0), ...(await balance(page)) };

  let lo = 0, hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (await measure(mid) <= FIT_TARGET) lo = mid; else hi = mid;
  }
  await measure(lo);
  // Even margins. The fit stops a few pixels shy of the sheet's end for the
  // paginator's sake, so the bottom gap runs a little larger than the top;
  // the difference is moved into the top padding so the two match (his rule,
  // 2026-09-03: "approximately equal", "a difference of only a few pixels").
  const before = await balance(page);
  const shift = Math.floor((before.bottomGap - before.topGap) / 2);
  if (shift > 0) {
    await page.evaluate((px) => {
      const cs = getComputedStyle(document.body);
      document.body.style.paddingTop = `${parseFloat(cs.paddingTop) + px}px`;
      document.body.style.paddingBottom = `${Math.max(0, parseFloat(cs.paddingBottom) - px)}px`;
    }, shift);
  }
  const height = await page.evaluate(() => document.body.scrollHeight);
  // `spread` is how far the spacing had to open to reach the bottom: near 1
  // means the page ran out of content before the spacing ran out of room —
  // the sign that a bullet could be added rather than the leading loosened.
  return { fill: height / PAGE_H, overflow: false, spread: lo, underfull: lo > 0.97, ...spreadTo(lo), ...(await balance(page)) };
}

/**
 * The whitespace above the first line and below the last, in CSS pixels, on
 * the page as it will print. His rule (2026-09-03, skill §4): the two must be
 * about equal, and a resume must never go out with a blank band at the
 * bottom. Measured off the rendered layout, not assumed from the padding.
 */
export async function balance(page) {
  return page.evaluate((pageH) => {
    const els = [...document.body.querySelectorAll('*')].filter((el) => el.getClientRects().length && el.textContent.trim());
    let top = Infinity, bottom = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0) continue;
      top = Math.min(top, r.top + window.scrollY);
      bottom = Math.max(bottom, r.bottom + window.scrollY);
    }
    if (!isFinite(top)) return { topGap: 0, bottomGap: 0 };
    return { topGap: Math.round(top), bottomGap: Math.round(pageH - bottom) };
  }, PAGE_H);
}

/**
 * Bullets whose last line is a stub — his rule, measured instead of hoped for.
 *
 * "Bullets must not wrap to a stub; reword to fit or make the wrapped line at
 * least a third of the width" (Alex, 2026-08). Nothing checked it. Preferring
 * the pool's short form is a mitigation and the comment in resume-variants.mjs
 * says as much; measured on the built resumes, two bullets still wrap to 18%
 * and 12% tails in every family that carries them (F-278).
 *
 * MEASURED AFTER fitToPage, and only there. The leading and gap are solved per
 * resume to fill the page, so line breaks are not known until that is done —
 * measuring the unfitted page would report tails the reader never sees.
 *
 * Reports, never fails. Which qualifier to drop from a sentence is his call,
 * and a build that refused to produce a PDF over a short line would be worse
 * than the short line.
 */
export async function orphanTails(page, minFraction = 1 / 3) {
  return page.evaluate((min) => {
    const out = [];
    // PROSE BULLETS ONLY. Skills and Coursework are comma-separated LISTS in
    // <li> too, and a list wraps where it wraps — flagging those made the first
    // version of this cry wolf on every build, which is worse than not checking
    // at all. Project bullets keep their bold name and ARE prose, so the test
    // is the SECTION, not the markup.
    const skip = /^(skills|education|coursework|relevant coursework)$/i;
    for (const li of document.querySelectorAll('li')) {
      const sec = li.closest('.sec');
      const title = sec ? (sec.querySelector('.sec-t')?.textContent || '').trim() : '';
      if (skip.test(title)) continue;
      const r = document.createRange();
      r.selectNodeContents(li);
      // Fragments grouped into LINES: a nowrap span splits a line into several
      // rects, and a fragment's width is not a line's (2026-09-06).
      const rects = [];
      for (const x of [...r.getClientRects()].filter((q) => q.width > 1 && q.height > 1).sort((a, b) => a.top - b.top || a.left - b.left)) {
        const last = rects[rects.length - 1];
        if (last && Math.abs(last.top - x.top) < x.height * 0.5) { last.right = Math.max(last.right, x.right); last.width = last.right - last.left; }
        else rects.push({ top: x.top, left: x.left, right: x.right, width: x.width });
      }
      if (rects.length < 2) continue;                       // one line, no tail
      const widest = Math.max(...rects.map((x) => x.width));
      const tail = rects[rects.length - 1].width;
      if (tail / widest < min) {
        out.push({
          fraction: Math.round((tail / widest) * 100) / 100,
          lines: rects.length,
          ends: li.textContent.trim().slice(-52),
        });
      }
    }
    return out;
  }, minFraction);
}

export async function renderPdf(html, outPath, { verifyText = true, browser = null } = {}) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  // A caller polishing a page over many passes hands in one browser; a
  // one-off render opens and closes its own.
  const own = !browser;
  const b = browser || await chromium.launch();
  try {
    // Taller than the sheet so an overflowing page can still be measured.
    const page = await b.newPage({ viewport: { width: 816, height: PAGE_H + 400 } });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const fit = await fitToPage(page);
    // At the FINAL leading, so the tails reported are the ones printed.
    const orphans = await orphanTails(page).catch(() => []);
    const layout = await measureLayout(page, PAGE_H).catch(() => null);
    await page.pdf({ path: outPath, format: 'Letter', printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    await page.close();
    // The text layer, checked on the file that will go out — when pdftotext
    // is installed. A split word ("M anufacturing") is invisible on screen and
    // costs the ATS keyword the resume exists to win. Reported, never fatal.
    const text = verifyText ? textLayer(outPath, html) : null;
    // Read on the file that will go out, for the same reason the text layer is.
    const links = pdfLinks(outPath);
    return { ...fit, orphans, layout, links, ...(text ? { lostWords: text.lost, pages: text.pages } : {}) };
  } finally { if (own) await b.close(); }
}

/**
 * Words of four letters or more that are on the page but not in the PDF's
 * text layer, plus the page count — by round-tripping the file through
 * pdftotext. null when the tool is not on PATH.
 */
export function textLayer(pdfPath, html) {
  let out;
  try { out = execFileSync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
  const pages = Math.max(1, out.split('\f').filter((p) => p.trim()).length);
  // Hyphenated compounds are compared in pieces: a line break at the hyphen
  // ("pin-" / "alignment") is how any PDF wraps them and costs no keyword.
  const words = (text) => new Set((String(text).replace(/-/g, ' ').match(/[A-Za-z][A-Za-z']{3,}/g) || []).map((w) => w.toLowerCase()));
  const got = words(out);
  const plain = String(html).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  const want = words(plain);
  const lost = [...want].filter((w) => !got.has(w));
  return { lost, pages };
}

/**
 * The URLs the finished PDF can actually be CLICKED through to, read off its
 * /URI link annotations. null when the file's objects are compressed into
 * streams and a plain scan cannot see inside them.
 *
 * 2026-09-19. The header links were styled to look like body text then, so a
 * lost annotation looked exactly like a working one. They are blue since
 * 2026-09-23 — which makes a lost one WORSE: a blue word that goes nowhere
 * looks clickable and is not. Twenty builds
 * sat in data/jarvis/builds/ before this was written and only the last had
 * links; the rest simply predated the feature, and no run ever said so. A
 * silent difference between "clickable" and "not" is the thing to measure.
 */
export function pdfLinks(pdfPath) {
  let buf;
  try { buf = readFileSync(pdfPath).toString('latin1'); } catch { return null; }
  const uris = [];
  // /URI (https://…) — a PDF literal string, so ( ) nest and \ escapes.
  const re = /\/URI\s*\(/g;
  let m;
  while ((m = re.exec(buf))) {
    let i = re.lastIndex, depth = 1, s = '';
    while (i < buf.length && depth > 0) {
      const ch = buf[i];
      if (ch === '\\') { s += buf[i + 1] ?? ''; i += 2; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (!depth) break; }
      s += ch; i += 1;
    }
    if (s) uris.push(s);
  }
  // Nothing found AND the file compresses its objects: the scan is blind here,
  // which is not the same as the links being absent. Say so rather than
  // reporting a clean sheet as broken — a false alarm on a good resume is the
  // expensive error.
  if (!uris.length && /\/ObjStm\b/.test(buf)) return null;
  return [...new Set(uris)];
}

async function main() {
  const args = process.argv.slice(2);
  const get = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
  const specPath = get('--spec');
  if (!specPath || !existsSync(specPath)) { console.error('need --spec <spec.json>'); process.exit(1); }
  const spec = JSON.parse(readFileSync(specPath, 'utf-8'));

  const id = get('--job') || (get('--url') ? jobId(get('--url')) : null);
  // THE FILENAME IS PART OF THE APPLICATION. This builds the four FAMILY BASES,
  // which belong to no posting, so each is "Alex Rivera Resume.pdf" and the FOLDER
  // is the variant — never "alex-rivera-kla-mech-design.pdf", which advertises a
  // machine producing one file per posting.
  //
  // A resume built FOR a posting is named for it now — "Alex Rivera - <Company> -
  // <Role>.pdf" — because he asked for that on 2026-09-08 so he can see from
  // the form's own chip which file went on (F-409, `personFile` in
  // resume-for-job.mjs). That is a different path from this one.
  const person = (spec.name || 'Resume').replace(/\s+/g, ' ').trim();
  const fileName = `${person} Resume.pdf`;
  const variant = spec.variant || spec.tag || 'default';
  const outPath = get('--out')
    || path.join(OUT_DIR, variant.toLowerCase().replace(/[^a-z0-9]+/g, '-'), fileName);
  mkdirSync(path.dirname(outPath), { recursive: true });

  const fit = await renderPdf(renderHtml(spec), outPath);

  let linked = '';
  if (id) {
    const job = updateJob(id, { resume_path: outPath });
    if (job) linked = ` → linked to ${job.company} · ${(job.title || '').slice(0, 40)}`;
  }
  const pct = Math.round(fit.fill * 100);
  console.log(`Resume rendered: ${outPath}${linked}`);
  console.log(fit.overflow
    ? `  ⚠ content overflows one page (${pct}% at the tightest spacing) — trim the spec`
    : `  page ${pct}% full (leading ${fit.lead.toFixed(2)}, gap ${fit.gap.toFixed(1)}px, auto-fitted)`);
}

// Only run the CLI when executed directly, so the test suite can import
// renderHtml() without the script demanding a --spec and exiting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
