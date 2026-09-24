/**
 * THE FILL REPORT, ONE RENDERER FOR BOTH PLACES IT CAN APPEAR (2026-09-23).
 *
 * His words: "extension ui is still not consolodiated, stuff is still climbing
 * on top of each other". The report — what was filled, what was written for
 * him, what is left, and an "ask Claude" beside each — was drawn as a 330px
 * box floating over the application form's top-right corner, beside a side
 * panel that held the resume and the letter. Two panels, one of them sitting
 * on the form he was filling.
 *
 * It lives in the side panel now, on its Answers tab. The page draws the full
 * box only when it cannot reach the extension at all (a harness, or a page
 * opened before the extension was reloaded) — and it draws it from this same
 * function, so the two can never say different things.
 *
 * Loaded by content.js's injection (as a file before it) and by panel.html.
 * Pure: a report in, markup out. Every click is wired by whoever hosts it.
 */
(() => {
  if (globalThis.JarvisReport) return;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** The question a leftover line is about: its label, minus the engine's note to him. */
  const questionOf = (u) => String(u).replace(/^step \d+: /, '').replace(/\s*\([^()]*\)\s*$/, '').trim();

  /**
   * The body of the report. `report` is what a run hands the page's panel:
   * filled, checked, holdsResume, sawUpload, unanswered, kept, written,
   * readForm, steps, stoppedBecause, resumeNote, staleExtension,
   * appliedBefore, armed, waiting.
   */
  function render(report = {}) {
    const {
      filled = 0, checked = 0, holdsResume = false, sawUpload = false, unanswered = [], kept = [], written = [],
      readForm = null, steps = 0, stoppedBecause = '', resumeNote = '', staleExtension = '', appliedBefore = null,
      armed = false, waiting = false,
    } = report;
    const rows = [];
    if (staleExtension) {
      rows.push(`<div style="background:#3d1d1d;border:1px solid #b42318;border-radius:6px;padding:7px 9px;margin-bottom:9px;color:#ff9d95">${esc(staleExtension)}</div>`);
    }
    // ALREADY APPLIED, ON THE PAGE ITSELF (F-414). Above the counts, because
    // it changes whether the rest of the report matters at all.
    if (appliedBefore) {
      const same = appliedBefore.where === 'this';
      rows.push(`<div style="margin:0 0 8px;padding:7px 9px;border-radius:7px;`
        + `background:${same ? '#14301c' : '#2b2411'};border:1px solid ${same ? '#2ea043' : '#9e6a03'};color:${same ? '#7ee787' : '#e3b341'}">`
        + (same
          ? `<b>You already applied to this job.</b>${appliedBefore.at ? ` Marked applied on ${esc(String(appliedBefore.at).slice(0, 10))}.` : ''}`
          : `<b>You already applied to this role at ${esc(appliedBefore.company || 'this company')}</b> under a different posting.`)
        + '</div>');
    }
    // ONE STATUS LINE, NOT THREE STACKED ONES (F-502). Three resume states,
    // not two: "no resume attached" on a screen with no upload slot is not a
    // fault (F-407), and a dead posting has no slot to speak of.
    const status = [`<span style="color:#7ee787">${filled} filled · ${checked} ticked${steps > 1 ? ` · ${steps} steps` : ''}</span>`];
    if (!/posting is gone/i.test(String(stoppedBecause || ''))) status.push(holdsResume
      ? '<span style="color:#7ee787">resume attached</span>'
      : !sawUpload
        ? `<span style="color:#8b949e">no resume slot on this screen${resumeNote ? ` — ${esc(resumeNote)}` : ''}</span>`
        : `<span style="color:#d29922">no resume attached${resumeNote ? ` — ${esc(resumeNote)}` : ''}</span>`);
    rows.push(`<div style="display:flex;flex-wrap:wrap;gap:0 7px">${status.join('<span style="color:#484f58">·</span>')}</div>`);

    // WHAT WAS WRITTEN FOR HIM — the only fields he has to READ, so they come
    // above the leftovers, each one click from being written again
    // (2026-09-16: "rn if its autofilled i cant even call claude"), with the
    // model that wrote it beside it (2026-09-19).
    if (written.length) {
      rows.push(`<div style="margin-top:9px;color:#79c0ff">${written.length} written for you — read ${written.length === 1 ? 'it' : 'them'} before Submit:</div>`);
      rows.push(`<ul style="margin:4px 0 0 16px;padding:0;color:#adbac7">${written.map((w, i) => {
        const bad = (w.problems || []).length;
        const m = w.model || null;
        const by = m?.used ? ` <span style="opacity:.55">· ${esc(String(m.used))}${m.fellBack ? ' (fallback)' : ''}</span>` : '';
        return `<li style="margin:3px 0">${esc(String(w.label)).slice(0, 90)} <span style="opacity:.65">(${w.words} words)</span>${by}`
          + ` <span class="jarvis-ask" data-q="${esc(String(w.label))}" data-i="w${i}" style="cursor:pointer;color:#79c0ff;text-decoration:underline;white-space:nowrap">see it · rewrite it</span>`
          + (bad ? `<div style="color:#d29922;margin-left:2px">${esc((w.problems || []).slice(0, 2).join('; ')).slice(0, 160)}</div>` : '')
          + `<div class="jarvis-ask-out" data-i="w${i}"></div></li>`;
      }).join('')}</ul>`);
    }

    // EVERY LEFTOVER IS ONE CLICK FROM AN ANSWER (2026-09-09).
    if (unanswered.length) {
      rows.push(`<div style="margin-top:9px;color:#d29922">${unanswered.length} left for you:</div>`);
      rows.push(`<ul style="margin:4px 0 0 16px;padding:0;color:#adbac7">${
        unanswered.slice(0, 12).map((u, i) => `<li style="margin:3px 0">${esc(u).slice(0, 120)}`
          + ` <span class="jarvis-ask" data-q="${esc(questionOf(u))}" data-i="${i}" style="cursor:pointer;color:#79c0ff;text-decoration:underline;white-space:nowrap">ask Claude</span>`
          + `<div class="jarvis-ask-out" data-i="${i}"></div></li>`).join('')
      }${unanswered.length > 12 ? `<li style="opacity:.7">…and ${unanswered.length - 12} more</li>` : ''}</ul>`);
    } else {
      // THE GREEN LINE IS EARNED BY READING THE FORM, AND BY NOTHING ELSE
      // (F-339, F-443).
      const sawAnything = readForm === null ? (filled || 0) + (checked || 0) > 0 : readForm;
      rows.push(!sawAnything
        ? '<div style="margin-top:9px;color:#8b949e">no form was read on this page — see why below</div>'
        : (filled || 0) + (checked || 0) === 0
          ? '<div style="margin-top:9px;color:#8b949e">the form here was already answered — nothing to add</div>'
          : '<div style="margin-top:9px;color:#7ee787">nothing left unanswered</div>');
    }
    if (kept.length) {
      rows.push(`<div style="margin-top:9px;color:#8b949e">${kept.length} left as you had ${kept.length === 1 ? 'it' : 'them'}:</div>`);
      rows.push(`<ul style="margin:4px 0 0 16px;padding:0;color:#8b949e">${
        kept.slice(0, 8).map((u) => `<li style="margin:2px 0">${esc(u).slice(0, 120)}</li>`).join('')
      }${kept.length > 8 ? `<li style="opacity:.7">…and ${kept.length - 8} more</li>` : ''}</ul>`);
    }

    if (stoppedBecause) rows.push(`<div style="margin-top:10px;padding-top:9px;border-top:1px solid #30363d;color:#8b949e">${esc(stoppedBecause)}</div>`);
    if (armed) {
      rows.push(`<div style="margin-top:7px;color:#79c0ff">${waiting
        ? 'Waiting. Jarvis continues by itself when the form appears.'
        : 'Following this tab: the next page or step fills by itself.'} <span id="jarvis-stop" style="cursor:pointer;text-decoration:underline">Stop following</span></div>`);
    }
    // ASK ABOUT ANYTHING ON THIS FORM (F-502). OPEN, since 2026-09-24: folded
    // away, it was one more thing he could not find.
    rows.push(askBox());
    rows.push('<div style="margin-top:8px;padding-top:7px;border-top:1px solid #21262d;color:#6e7681;font-size:12px">'
      + '<b style="color:#8b949e;font-weight:600">Submit is yours.</b> Nothing here pressed it.</div>');
    return rows.join('');
  }

  /**
   * One written answer, with what he can do with it: copy it, put it in its
   * box, have it written again, or say what he does not like and have it
   * revised with that note (the notes pile up, so a second rewrite still
   * honours the first). "Why this answer" is folded away: the text is what he
   * came for.
   */
  function answer(got = {}) {
    const text = String(got.text || '').trim();
    const problems = got.problems || [];
    const reading = String(got.reading || '').trim();
    return `<div style="margin-top:6px;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:7px 8px;color:#e6edf3;white-space:pre-wrap">${esc(text)}</div>`
      + (problems.length ? `<div style="color:#d29922;margin-top:4px">${esc(problems.slice(0, 3).join('; ')).slice(0, 240)}</div>` : '')
      + (reading ? '<details style="margin-top:5px"><summary style="cursor:pointer;color:#8b949e">why this answer</summary>'
        + `<div style="margin-top:4px;color:#8b949e;white-space:pre-wrap;font-size:12px">${esc(reading).slice(0, 1400)}</div></details>` : '')
      + '<div style="margin-top:5px;display:flex;gap:9px;flex-wrap:wrap">'
      + '<span class="jarvis-copy" style="cursor:pointer;color:#79c0ff;text-decoration:underline">copy</span>'
      + '<span class="jarvis-put" style="cursor:pointer;color:#79c0ff;text-decoration:underline">put it in the box</span>'
      + '<span class="jarvis-again" style="cursor:pointer;color:#8b949e;text-decoration:underline">write it again</span>'
      + '<span class="jarvis-said" style="color:#8b949e"></span>'
      + (got.model?.used
        ? `<span style="margin-left:auto;color:#8b949e;font-size:12px">written by ${esc(String(got.model.used))}${got.model.fellBack ? ` (${esc(String(got.model.requested || ''))} was unavailable)` : ''}</span>`
        : '')
      + '</div>'
      + (Array.isArray(got.feedback) && got.feedback.length
        ? `<div style="margin-top:5px;color:#8b949e;font-size:12px">your notes so far: ${esc(got.feedback.map((n) => `"${n}"`).join(' · ')).slice(0, 400)}</div>` : '')
      + '<textarea class="jarvis-note" rows="2" placeholder="what don\'t you like about it? e.g. too generic, use a different project, cut the last sentence" '
      + 'style="width:100%;box-sizing:border-box;margin-top:6px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;'
      + 'border-radius:6px;padding:6px 7px;font:12.5px/1.45 inherit;resize:vertical"></textarea>'
      + '<div style="margin-top:4px"><span class="jarvis-revise" style="cursor:pointer;color:#79c0ff;text-decoration:underline">rewrite it with my note</span></div>';
  }

  /** The one line the page shows when the side panel is closed. */
  function line(report = {}) {
    const bits = [`${report.filled || 0} filled`];
    if ((report.written || []).length) bits.push(`${report.written.length} written`);
    if ((report.unanswered || []).length) bits.push(`${report.unanswered.length} left for you`);
    return `Jarvis · ${bits.join(' · ')}`;
  }

  /**
   * ASK ABOUT ANY QUESTION, ALWAYS THERE (2026-09-24). It lived only inside a
   * fill report and folded shut, so with no report on screen there was no
   * way to ask Claude anything. The panel shows it on its own too.
   */
  function askBox() {
    return '<div style="margin-top:10px;padding-top:9px;border-top:1px solid #30363d">'
      + '<div style="color:#adbac7;margin-bottom:5px">Ask Claude about any question on this form</div>'
      + '<textarea id="jarvis-ask-q" rows="3" placeholder="paste the question here" '
      + 'style="width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;'
      + 'border-radius:6px;padding:6px 7px;font:12.5px/1.45 inherit;resize:vertical"></textarea>'
      + '<div style="display:flex;gap:7px;align-items:center;margin-top:5px">'
      + '<span id="jarvis-ask-go" style="cursor:pointer;color:#79c0ff;text-decoration:underline">answer it</span>'
      + '<span id="jarvis-ask-note" style="color:#8b949e"></span></div>'
      + '<div id="jarvis-ask-free-out"></div></div>';
  }

  globalThis.JarvisReport = { render, answer, line, esc, questionOf, askBox };
})();
