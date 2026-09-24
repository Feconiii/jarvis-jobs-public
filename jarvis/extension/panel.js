/**
 * Jarvis side panel — the tab's application, beside the tab.
 *
 * What the dashboard knows about the posting he is looking at, on the page he
 * is looking at: the job, how well it fits him (the same score the deck
 * uses, with the skills it asks for that he has and the ones it also wants),
 * the resume written for THIS posting to read before it goes, what was
 * tailored in it, and one button that fills the page — with the walk's
 * progress underneath as it goes.
 *
 * It decides nothing and holds nothing: every fact comes from the worker,
 * which asks the local dashboard. It never presses Submit and offers no way
 * to.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError?.message || 'no answer from the worker' }));
    } catch (e) { resolve({ ok: false, error: String(e?.message || e) }); }
  });

  const state = { tabId: null, jobId: null, pdfUrl: null, fileUrl: '', fileName: '', pollUntil: 0, pollTimer: null, resumeTimer: null, lastKey: '', letter: null, letterTimer: null, letterFor: '', letterMiss: { id: '', at: 0 }, tab: 'resume', tabChosen: false, report: null, reportAt: 0, retryTimer: null };

  /**
   * "NONE YET" IS NOT AN ANSWER TO KEEP (F-538).
   *
   * The filler asks for the cover letter itself when the form has a slot for
   * one, so the panel's first read — taken when the page opened, before the
   * fill — is stale the moment that PDF lands in the form. It was remembered
   * anyway, and the card went on saying "None written for this posting yet."
   * beside a form holding that very letter.
   *
   * Only a letter that EXISTS is remembered. A miss is asked again — on the
   * next read of the page, on every poll while the walk runs, and at once when
   * he opens the tab — with a two-second floor so a 1.5s poll cannot turn into
   * a request per poll.
   */
  const letterDue = () => !!state.jobId && state.letterFor !== state.jobId
    && !(state.letterMiss.id === state.jobId && Date.now() - state.letterMiss.at < 2000);

  /**
   * ONE CARD AT A TIME, CHOSEN BY THE STRIP (2026-09-23: Answers · Resume ·
   * Cover letter). Answers is what the fill did and every "ask Claude" — the
   * report that used to float over the form. The letter needs a job to act
   * on, so its tab waits for one; "Change it" is a fold inside Resume.
   */
  function showTab(name) {
    if (name) state.tab = name;
    const has = !!state.jobId;
    if (!has && state.tab === 'letter') state.tab = 'resume';
    for (const b of document.querySelectorAll('#tabs button')) {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.disabled = b.dataset.tab === 'letter' && !has;
    }
    $('#answers').hidden = state.tab !== 'answers';
    $('#resume').hidden = state.tab !== 'resume';
    $('#letter').hidden = !(has && state.tab === 'letter');
  }
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => {
    state.tabChosen = true;
    showTab(b.dataset.tab);
    // Opening the card is him asking what is true NOW, so a "none yet" from
    // earlier is re-read without waiting out the floor (F-538).
    if (b.dataset.tab === 'letter' && state.jobId && state.letterFor !== state.jobId) loadLetter(state.jobId);
  });

  async function activeTab() {
    // A harness (or a check in a tab) can point the panel at one tab:
    // panel.html?tab=<id>. Otherwise it is the tab beside it.
    const pinned = Number(new URLSearchParams(location.search).get('tab'));
    if (Number.isInteger(pinned) && pinned > 0) return await chrome.tabs.get(pinned).catch(() => null);
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    return tabs[0] || null;
  }

  function showEmpty(html, { quiet = false } = {}) {
    $('#main').hidden = true;
    const e = $('#empty');
    e.hidden = false;
    e.className = quiet ? 'muted' : '';
    e.innerHTML = html;
  }

  function money(job) {
    const min = Number(job.salary_min), max = Number(job.salary_max);
    if (!min && !max) return '';
    const cur = job.salary_currency || 'USD';
    const fmt = (n) => (cur === 'USD' ? '$' : `${cur} `) + Math.round(n).toLocaleString('en-US');
    const range = min && max ? `${fmt(min)} – ${fmt(max)}` : fmt(min || max);
    const per = /hour/i.test(job.salary_interval || '') ? ' / hour' : ' / year';
    return `${range}${per}`;
  }

  function renderJob(job) {
    $('#title').textContent = job.title || '';
    $('#sub').textContent = [job.company, job.location].filter(Boolean).join(' · ');
    $('#pay').textContent = money(job);
    const logo = $('#logo');
    const initials = String(job.company || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
    logo.textContent = initials;
    if (job.logo) {
      const img = document.createElement('img');
      img.alt = '';
      img.onerror = () => { logo.textContent = initials; };
      img.onload = () => { logo.textContent = ''; logo.appendChild(img); };
      img.src = job.logo;
    }
  }

  /**
   * ALREADY APPLIED, SAID OUT LOUD (F-414).
   *
   * "rn i have to guess" — and guessing costs either a second application to
   * the same requisition or a real one he skips because he thinks he already
   * sent it. The two cases are drawn differently on purpose: this exact
   * posting is certain, the same role under another requisition is worth a
   * look before he decides.
   */
  function renderApplied(applied) {
    const el = $('#applied');
    if (!applied) { el.hidden = true; el.textContent = ''; el.className = ''; return; }
    const when = applied.at ? new Date(applied.at) : null;
    const day = when && !Number.isNaN(when.getTime())
      ? when.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
      : '';
    el.hidden = false;
    el.className = applied.where === 'this' ? 'this' : 'role';
    el.innerHTML = applied.where === 'this'
      ? `<b>You already applied to this job.</b>${day ? ` Marked applied on ${esc(day)}.` : ''}`
      : `<b>You already applied to this role at ${esc(applied.company || 'this company')}</b>${day ? ` on ${esc(day)}` : ''} — under a different posting. Worth checking it is not the same requisition.`;
  }

  function renderFit(fit) {
    const score = Number.isFinite(Number(fit?.score)) ? Number(fit.score) : null;
    const ring = $('#ring');
    const colour = score == null ? 'var(--chip)' : score >= 70 ? 'var(--good)' : score >= 45 ? 'var(--warn)' : 'var(--bad)';
    ring.style.setProperty('--p', String(score ?? 0));
    ring.style.setProperty('--ring', colour);
    $('#score').textContent = score == null ? '–' : String(score);
    $('#band').textContent = fit?.blockers?.length ? 'Blocked' : (fit?.bandLabel || fit?.band || '');
    $('#why').textContent = (fit?.blockers?.length ? fit.blockers : (fit?.reasons || [])).slice(0, 2).join(' · ');
    const sk = $('#skills');
    const has = fit?.skills?.matched || [];
    const wants = fit?.skills?.missing || [];
    if (!has.length && !wants.length) { sk.innerHTML = ''; return; }
    const chips = (list, cls) => `<div class="chips">${list.map((s) => `<span class="chip ${cls}">${esc(s)}</span>`).join('')}</div>`;
    sk.innerHTML = `${has.length ? `<div>Asks for <b>${has.length}</b> of his skills${chips(has, '')}</div>` : ''}`
      + `${wants.length ? `<div style="margin-top:6px">Also wants${chips(wants, 'miss')}</div>` : ''}`;
  }

  /**
   * ONE LINE UNDER FILL, THE WHOLE REPORT ON ITS TAB (2026-09-23).
   *
   * The line is the tab's running total (the worker's tally across the steps
   * of one application). The Answers tab is the page's own last report —
   * what was written for him and what is left, each with "ask Claude" — which
   * used to be a box drawn over the form.
   */
  function renderState(armed, running, report = null, live = '') {
    const s = $('#status');
    const acc = armed?.acc;
    const fill = $('#fill');
    fill.disabled = !!running;
    fill.textContent = running ? 'Filling…' : (acc && (acc.filled || acc.checked) ? 'Fill this page again' : 'Fill this page');
    const liveEl = $('#live');
    liveEl.hidden = !live;
    liveEl.textContent = live || '';
    renderAnswers(report);
    if (!acc || (!acc.filled && !acc.checked && !acc.uploaded && !(acc.unanswered || []).length && !acc.stoppedBecause)) {
      s.innerHTML = running ? '' : (armed ? 'Following this tab.' : '');
      return;
    }
    const left = acc.unanswered || [];
    const written = report?.written || [];
    s.innerHTML = `<div><span class="n">${acc.filled || 0}</span> filled · <span class="n">${acc.checked || 0}</span> ticked${acc.uploaded ? ' · resume attached' : ''}`
      + `${written.length ? ` · ${written.length} written for you` : ''}`
      + `${left.length ? ` · <span class="left">${left.length} left for you</span>` : ''}${armed ? ' · following this tab' : ''}</div>`
      + (acc.stoppedBecause ? `<div class="muted">${esc(acc.stoppedBecause)}</div>` : '')
      + '<div class="submit">Submit is yours. Nothing here presses it.</div>';
  }

  /**
   * THE ANSWERS TAB. Drawn again only when the page sends a NEW report, so an
   * answer he is reading is not wiped by the next poll. The first report with
   * something for him to read or do opens the tab, unless he has picked one.
   */
  function renderAnswers(report) {
    const at = report?.at || 0;
    const count = $('#answers-count');
    const todo = (report?.unanswered || []).length + (report?.written || []).length;
    count.hidden = !todo;
    count.textContent = String(todo);
    // NO REPORT IS NOT NO WAY TO ASK (2026-09-24). Before a run, after the
    // worker restarted, or on a tab he filled by hand, the Answers tab was
    // empty and there was nowhere to ask Claude anything.
    if (!report) {
      // Only on a tab that has shown nothing yet: a report already on screen
      // (and an answer he is reading under it) is never wiped by a poll that
      // came back empty.
      if (state.reportAt !== 0) return;
      state.report = null;
      state.reportAt = 'none';
      const body = $('#answers-body');
      body.className = '';
      body.innerHTML = '<div style="color:#8b949e">No fill report on this tab yet — press Jarvis to fill the form, or ask about any question here.</div>'
        + (globalThis.JarvisReport?.askBox ? JarvisReport.askBox() : '');
      wireAnswers(body);
      return;
    }
    if (at === state.reportAt) return;
    state.report = report;
    state.reportAt = at;
    const body = $('#answers-body');
    body.className = '';
    body.innerHTML = globalThis.JarvisReport ? JarvisReport.render(report) : '';
    wireAnswers(body);
    if (todo && !state.tabChosen) showTab('answers');
  }

  /** Ask for one answer from the panel, and show it where he clicked. */
  async function askFrom(question, out, say, { again = false, request = '', free = false } = {}) {
    const typed = String(question || '').trim();
    if (!typed) { say('type the question first'); return; }
    if (!state.tabId) { say('no page beside the panel'); return; }
    say(request ? 'writing with your request…' : again ? 'writing another…' : 'asking Claude…');
    out.innerHTML = '';
    let got = await ask({ type: 'panel-ask', tabId: state.tabId, question: typed, again, request, free });
    const q = got?.q || typed;
    if (q !== typed) say(`for "${q.slice(0, 40)}"…`);
    let key = got?.key || '';
    const deadline = Date.now() + 420000;   // write, check, review, rewrite
    const pending = (r) => !String(r?.text || '').trim() && (r?.writing || r?.status === 'writing');
    while (pending(got) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      say('writing…');
      got = await ask({ type: 'panel-answer-get', tabId: state.tabId, key: got?.key || key, question: q });
      key = got?.key || key;
    }
    say('');
    if (!got?.ok || !String(got.text || '').trim()) {
      out.innerHTML = `<div style="color:#d29922;margin-top:5px">${esc(String(got?.error || got?.why || 'no answer').slice(0, 200))}</div>`;
      return;
    }
    const text = String(got.text).trim();
    out.innerHTML = JarvisReport.answer(got);
    const said = out.querySelector('.jarvis-said');
    out.querySelector('.jarvis-revise').onclick = () => {
      const note = String(out.querySelector('.jarvis-note').value || '').trim();
      if (!note) { said.textContent = 'say what to change first'; return; }
      askFrom(q, out, say, { again: true, request: note.slice(0, 600) });
    };
    out.querySelector('.jarvis-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(text); said.textContent = 'copied'; } catch { said.textContent = 'could not copy — select it instead'; }
    };
    out.querySelector('.jarvis-put').onclick = async () => {
      const r = await ask({ type: 'panel-put', tabId: state.tabId, question: q, text });
      said.textContent = r?.said || (r?.found ? 'in the box' : 'could not reach the page');
    };
    out.querySelector('.jarvis-again').onclick = () => askFrom(q, out, say, { again: true });
  }

  function wireAnswers(el) {
    for (const link of el.querySelectorAll('.jarvis-ask')) {
      link.addEventListener('click', () => {
        const out = el.querySelector(`.jarvis-ask-out[data-i="${link.dataset.i}"]`);
        const was = link.textContent;
        askFrom(link.dataset.q, out, (m) => { link.textContent = m || was; });
      });
    }
    el.querySelector('#jarvis-ask-go')?.addEventListener('click', () => askFrom(
      el.querySelector('#jarvis-ask-q').value,
      el.querySelector('#jarvis-ask-free-out'),
      (m) => { el.querySelector('#jarvis-ask-note').textContent = m; },
      { free: true },
    ));
    el.querySelector('#jarvis-stop')?.addEventListener('click', async () => {
      await ask({ type: 'panel-stop', tabId: state.tabId });
      pollState();
    });
  }

  /**
   * How far along a named stage is. The stages are in order and each is worth
   * roughly what it costs in wall-clock, so the bar moves at a believable rate
   * rather than jumping. An unrecognised stage keeps the bar where it was.
   */
  const PHASES = [
    [/starting|reading the posting/i, 8],
    [/choosing what goes/i, 25],
    [/checking every claim/i, 45],
    [/rewording/i, 55],
    [/laying out the page/i, 70],
    [/checking the finished sheet/i, 92],
  ];
  let lastPercent = 8;
  function phasePercent(text) {
    for (const [re, pc] of PHASES) if (re.test(String(text || ''))) { lastPercent = Math.max(lastPercent, pc); return lastPercent; }
    return lastPercent;
  }

  function renderApplication(app) {
    const fam = $('#family');
    fam.textContent = app?.family?.label ? `· ${app.family.label}` : '';
    // The note this build was written with, shown back above the box.
    const shown = $('#request-shown');
    if (app?.request) { shown.hidden = false; shown.textContent = `Written with your note: "${app.request}"`; } else { shown.hidden = true; shown.textContent = ''; }
    showTab();
    // THE LAYOUT CHECK, on the sheet: passed, or what failed and why.
    const qa = $('#qa');
    if (app?.qa) {
      qa.hidden = false;
      qa.style.color = app.qa.ok ? 'var(--good)' : 'var(--warn)';
      qa.innerHTML = app.qa.ok
        ? 'Layout checked on the rendered sheet: one page, no orphans, no stubs, clean Skills.'
        : `Layout check: ${app.qa.failed.map(esc).join(' · ')}`;
    } else { qa.hidden = true; qa.textContent = ''; }
    const audit = $('#audit');
    const body = $('#audit-body');
    const t = app?.tailoring;
    if (!t) { audit.hidden = true; body.innerHTML = ''; return; }
    const rows = [];
    if (t.why) rows.push(`<div class="muted">${esc(t.why)}</div>`);
    for (const n of t.planNotes || []) rows.push(`<div class="row muted">${esc(n)}</div>`);
    for (const n of t.fitNotes || []) rows.push(`<div class="row muted">layout: ${esc(n)}</div>`);
    if (app.titles?.length) rows.push(`<div class="row">Titles on the page: ${app.titles.map(esc).join(' · ')}</div>`);
    for (const a of t.applied || []) rows.push(`<div class="row"><div class="was">${esc(a.from)}</div><div class="now">${esc(a.to)}</div></div>`);
    for (const r of t.refused || []) rows.push(`<div class="row err">refused a rewrite of ${esc(r.key)} — ${esc((r.problems || []).join('; '))}</div>`);
    for (const n of t.notices || []) rows.push(`<div class="row muted">${esc(n)}</div>`);
    if (!(t.applied || []).length && !(t.refused || []).length) rows.push('<div class="row muted">no rewrites — the standing wording already fits</div>');
    body.innerHTML = rows.join('');
    audit.hidden = false;
  }

  async function loadResume(jobId, { again = false, fresh = false } = {}) {
    clearTimeout(state.resumeTimer);
    const body = $('#resume-body');
    const frame = $('#pdf');
    const openBtn = $('#open-pdf');
    const rebuild = $('#rebuild');
    if (!again && !fresh && state.pdfUrl && state.lastKey === jobId) return;
    body.hidden = false;
    body.className = 'muted';
    body.textContent = again || fresh ? 'Writing the resume for this posting again…' : 'Looking for the resume written for this posting…';
    const r = await ask({ type: 'panel-resume', id: jobId, again });
    if (state.jobId !== jobId) return;   // he moved on
    if (r.ok && r.pdf) {
      const bytes = Uint8Array.from(atob(r.pdf), (c) => c.charCodeAt(0));
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      // THE FILE IS SHOWN FROM THE DASHBOARD, NOT FROM A BLOB (F-412).
      //
      // A blob: URL has no name, and Chrome's PDF viewer takes its Save name
      // from the last segment of whatever URL it is showing — so the viewer's
      // own save button, and "open in a tab", both offered a UUID however
      // carefully the Download link beside them was labelled. That is what he
      // kept seeing: "pressing download resume in the extension saves it as
      // name with random letters and numbers". The dashboard's URL carries a
      // content-disposition, so every route into the file takes its name from
      // there. The blob stays only as the fallback for a dashboard that has
      // stopped answering.
      const served = await ask({ type: 'file-url', id: jobId, inline: true });
      state.fileUrl = served.ok ? served.url : '';
      const name = r.filename || 'Alex Rivera Resume.pdf';
      state.fileName = name;
      const dl = $('#download-pdf');
      dl.href = state.fileUrl || state.pdfUrl;
      dl.download = name;
      dl.setAttribute('download', name);
      dl.hidden = false;
      $('#attach-pdf').hidden = false;
      $('#save-note').textContent = '';
      state.lastKey = jobId;
      frame.src = state.fileUrl || state.pdfUrl;
      frame.hidden = false;
      body.hidden = true;
      openBtn.hidden = false;
      rebuild.hidden = false;
      // The audit arrives with the build; refresh it once the PDF is here.
      const p = await ask({ type: 'panel', tabId: state.tabId });
      if (p.ok && p.data?.application) renderApplication(p.data.application);
      return;
    }
    frame.hidden = true;
    openBtn.hidden = true;
    $('#download-pdf').hidden = true;
    $('#attach-pdf').hidden = true;
    if (r.status === 425) {
      // WHICH STAGE, NOT JUST "STILL". One unchanging sentence over a two-minute
      // build reads as a hang, and he waited on one (2026-09-06).
      body.className = 'muted';
      // The server's own sentence names the employer; the bar and the stage go
      // under it. "try again in a moment" is advice for a caller, not for him.
      const said = String(r.error || 'still writing the resume').replace(/\s*—\s*try again.*$/i, '');
      body.innerHTML = `${esc(said)}<div class="phase">`
        + `<div class="bar"><i style="width:${phasePercent(r.phase)}%"></i></div>`
        + `<div class="what">${esc(r.phase || 'starting')}${r.seconds ? ` · ${r.seconds}s` : ''}</div></div>`;
      state.resumeTimer = setTimeout(() => loadResume(jobId, { again: false }), 4000);
      state.lastKey = '';
      return;
    }
    body.className = r.status === 404 ? 'muted' : 'err';
    body.textContent = r.error || 'No resume for this posting yet.';
    rebuild.hidden = false;
    rebuild.textContent = r.status === 404 ? 'Write the resume' : 'Try again';
    state.lastKey = '';
  }

  function renderLetter(r) {
    const status = $('#letter-status');
    const text = $('#letter-text');
    const problems = $('#letter-problems');
    const copy = $('#letter-copy');
    const fill = $('#letter-fill');
    const attach = $('#letter-attach');
    const download = $('#letter-download');
    const when = $('#letter-when');
    if (!r || !r.ok || r.status === 'failed' && !r.text) {
      text.hidden = true; problems.hidden = true; copy.hidden = true; fill.hidden = true; when.textContent = '';
      attach.hidden = true; download.hidden = true;
      status.hidden = false;
      status.className = r?.status === 'failed' ? 'err' : 'muted';
      status.textContent = r?.status === 'failed' ? (r.error || r.why || 'could not write it') : (r?.status === 'writing' || r?.status === 425 ? 'Writing it…' : 'None written for this posting yet.');
      return;
    }
    state.letter = r.text || '';
    // The letter is a page as well as a text: the PDF is what a form's file
    // slot takes, and what he saves (F-410).
    attach.hidden = !r.text;
    if (r.text) {
      ask({ type: 'file-url', what: 'letter', id: state.jobId }).then((u) => {
        if (!u.ok) { download.hidden = true; return; }
        download.href = u.url;
        download.textContent = 'Download';
        download.hidden = false;
      });
    } else download.hidden = true;
    status.hidden = !!r.text;
    text.hidden = !r.text;
    text.textContent = r.text || '';
    copy.hidden = !r.text; fill.hidden = !r.text;
    when.textContent = r.at ? `· ${new Date(r.at).toLocaleString()}` : '';
    const list = [...(r.problems || [])];
    problems.hidden = !list.length;
    problems.innerHTML = list.length ? `Check before you use it:<ul>${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
    if (r.request) status.textContent = `Written with your note: "${r.request}"`;
    if (r.request) status.hidden = false;
  }

  async function loadLetter(jobId, { wait = false } = {}) {
    clearTimeout(state.letterTimer);
    const r = await ask({ type: 'cover-letter-get', id: jobId });
    if (state.jobId !== jobId) return;
    state.letterFor = jobId;
    if (!r.ok && r.status === 425) {
      renderLetter({ ok: false, status: 'writing' });
      state.letterTimer = setTimeout(() => loadLetter(jobId, { wait: true }), 5000);
      return;
    }
    // No letter yet is a fact about this moment, not about this posting: the
    // filler may write one a minute from now (F-538). Not remembered.
    if (!r.ok && r.status === 404) {
      renderLetter(null);
      state.letterFor = '';
      state.letterMiss = { id: jobId, at: Date.now() };
      $('#letter-write').textContent = 'Write one';
      return;
    }
    if (!r.ok) { renderLetter({ ok: false, status: 'failed', error: r.error }); return; }
    renderLetter(r);
    $('#letter-write').textContent = r.text ? 'Write it again' : 'Write one';
  }

  $('#letter-write').addEventListener('click', async () => {
    if (!state.jobId) return;
    const note = $('#letter-note');
    $('#letter-write').disabled = true;
    note.textContent = 'Asking…';
    const r = await ask({ type: 'cover-letter', id: state.jobId, request: $('#letter-request').value.trim() });
    $('#letter-write').disabled = false;
    if (!r.ok) { note.textContent = r.error || 'could not ask'; return; }
    note.textContent = '';
    $('#letter-request').value = '';
    renderLetter({ ok: false, status: 'writing' });
    state.letterTimer = setTimeout(() => loadLetter(state.jobId, { wait: true }), 5000);
  });
  $('#letter-copy').addEventListener('click', async () => {
    const note = $('#letter-note');
    try { await navigator.clipboard.writeText(state.letter || ''); note.textContent = 'Copied.'; } catch { note.textContent = 'Could not copy — select the text instead.'; }
  });
  $('#letter-fill').addEventListener('click', async () => {
    const note = $('#letter-note');
    if (!state.tabId || !state.letter) return;
    const r = await ask({ type: 'fill-text', tabId: state.tabId, text: state.letter });
    note.textContent = !r.ok ? (r.error || 'could not reach the page')
      : r.found ? 'In the form. Read it there before you go on.'
        : r.file ? 'This form takes a cover letter as a FILE — save the text and attach it yourself.'
          : 'No cover-letter box on this page. Copy it instead.';
  });

  async function pollState() {
    clearTimeout(state.pollTimer);
    if (!state.tabId) return;
    const r = await ask({ type: 'panel-state', tabId: state.tabId });
    if (r.ok) renderState(r.armed, r.running, r.report || null, r.live || '');
    // THE WALK IS WHEN A LETTER APPEARS. The filler writes one for a form
    // with a cover-letter slot, and nothing tells the panel — so the card
    // read "None written" beside a form holding it (F-538). This poll already
    // runs through the fill and for minutes after; the letter is re-read here
    // rather than waiting for a tab event that may never come.
    if (r.ok && letterDue()) loadLetter(state.jobId);
    if (r.ok && (r.running || Date.now() < state.pollUntil)) state.pollTimer = setTimeout(pollState, 1500);
  }

  /**
   * KEEP ASKING WHILE THE PAGE IS STILL BECOMING ITSELF (F-385).
   *
   * A tab switch fires `onActivated` at once, before the new page has rendered
   * anything the server can match on — so the first answer is a 404 and the
   * panel used to settle on "Not a posting in your store" until some later
   * event happened to wake it. His words: "it takes like a good 30s… it likes
   * to say its not a posting but eventually it does recognize". A posting that
   * has not painted yet is not the same as a page that is not a posting, so a
   * 404 is retried on a short ramp and only becomes a verdict at the end of it.
   */
  const RETRY_MS = [250, 600, 1000, 1600, 2200];

  async function refresh({ attempt = 0 } = {}) {
    clearTimeout(state.retryTimer);
    const tab = await activeTab();
    if (!tab) return;
    const switched = state.tabId !== tab.id;
    state.tabId = tab.id;
    // NOT `state.tab` — that is the panel's OWN tab strip (resume / cover
    // letter / change it), and overwriting it with a Chrome tab hid the whole
    // resume pane.
    state.pageTab = tab;
    if (switched) { state.jobId = null; state.lastKey = ''; state.report = null; state.reportAt = 0; state.tabChosen = false; $('#answers-body').className = 'muted'; }
    if (!/^https?:/i.test(tab.url || '')) { showEmpty('Open a job posting or its application form.'); return; }
    // Say what it is doing rather than showing the last tab's job or a blank.
    if (switched || (attempt === 0 && !state.jobId)) showEmpty('Reading this page…', { quiet: true });
    const r = await ask({ type: 'panel', tabId: tab.id });
    if (state.tabId !== tab.id) return;
    if (!r.ok) {
      // Still loading, or an ATS that paints its posting after the load event:
      // ask again shortly rather than calling it.
      // …but a page that has finished loading and still does not match is not
      // going to start matching, so the verdict comes as soon as it is honest.
      // Two tries after `complete` is the whole grace an already-rendered page
      // gets; a page still loading keeps the full ramp.
      const settled = tab.status === 'complete' && attempt >= 2;
      if (r.status === 404 && attempt < RETRY_MS.length && !settled) {
        showEmpty('Reading this page…', { quiet: true });
        state.retryTimer = setTimeout(() => refresh({ attempt: attempt + 1 }), RETRY_MS[attempt]);
        return;
      }
      const why = r.status === 404
        ? `<b>Not a posting in your store.</b><br>${esc(r.error || '')}<br><br>Open it from the dashboard, or press Jarvis on the posting first.`
        : `<b>Jarvis cannot see this page.</b><br>${esc(r.error || '')}`;
      showEmpty(why);
      state.jobId = null;
      return;
    }
    $('#empty').hidden = true;
    $('#main').hidden = false;
    const { job, fit, application } = r.data;
    state.jobId = String(job.id);
    renderJob(job);
    renderApplied(r.data.applied);
    renderFit(fit);
    renderApplication(application);
    renderState(r.armed, r.running);
    const changed = state.lastKey !== String(job.id);
    if (changed) { state.lastKey = ''; $('#pdf').hidden = true; $('#audit').hidden = true; }
    loadResume(state.jobId);
    if (letterDue()) loadLetter(state.jobId);
    if (r.running) state.pollUntil = Date.now() + 5 * 60_000;
    // The page's last report and the progress line come with the state read.
    pollState();
  }

  $('#fill').addEventListener('click', async () => {
    if (!state.tabId) return;
    $('#fill').disabled = true;
    $('#fill').textContent = 'Filling…';
    const r = await ask({ type: 'press', tabId: state.tabId });
    if (!r.ok) { $('#status').innerHTML = `<span class="err">${esc(r.error || 'could not press')}</span>`; $('#fill').disabled = false; $('#fill').textContent = 'Fill this page'; return; }
    state.pollUntil = Date.now() + 6 * 60_000;
    pollState();
  });
  /**
   * SAVING IT KEEPS ITS NAME (F-386).
   *
   * A blob URL has no filename, so Chrome's PDF viewer offered
   * "5afac5be-24f2-45f6-83c5-faffb0a69279.pdf" in the Save dialog — his
   * screenshot, and his words: "its named a bunch of random letters and
   * numbers, FIX THAT". `chrome.downloads` is the only thing that names a
   * download authoritatively, so both the button and the preview tab's save
   * path go through it; the <a download> link stays as the fallback for a
   * Chrome that withholds the permission.
   */
  async function saveIt(saveAs) {
    const note = $('#save-note');
    const name = $('#download-pdf').getAttribute('download') || 'Alex Rivera Resume.pdf';
    if (!state.pdfUrl && !state.fileUrl) return;
    try {
      // The dashboard's URL first: it names the file in the header, so the
      // name survives even where `filename` is ignored (F-412).
      await chrome.downloads.download({ url: state.fileUrl || state.pdfUrl, filename: name, saveAs });
      note.textContent = `Saved as "${name}".`;
    } catch (e) {
      // No downloads permission in this Chrome: the link below names it too.
      note.textContent = 'Use the Download link — this Chrome would not let the panel save it.';
      $('#download-pdf').click();
    }
  }
  $('#download-pdf').addEventListener('click', (e) => {
    // Prefer the API, because it is the one thing that names the file in the
    // Save dialog. The link's own default is the fallback if it throws.
    if (chrome.downloads?.download) { e.preventDefault(); saveIt(true); }
  });
  /**
   * PUT THE FILE IN THE SLOT ON THIS PAGE (F-413).
   *
   * He asked to drag the resume out of the panel into a form's drop zone.
   * Chrome will not carry a File from an extension page to a web page — a drag
   * between them is a URL — so this is the same thing in one click. Only ever
   * into an EMPTY slot: a slot that already holds a file is his.
   */
  async function attachHere(what, noteEl) {
    const note = $(noteEl);
    if (!state.tabId) { note.textContent = 'No page beside the panel.'; return; }
    note.textContent = what === 'letter' ? 'Attaching the letter…' : 'Attaching the resume…';
    const r = await ask({ type: 'attach-file', tabId: state.tabId, what, id: state.jobId, pageUrl: state.pageTab?.url || '' });
    note.textContent = r.ok
      ? `Attached "${r.name}" to ${r.label}.`
      : (r.why || r.error || 'could not attach it');
  }
  $('#attach-pdf').addEventListener('click', () => attachHere('resume', '#save-note'));
  $('#letter-attach').addEventListener('click', () => attachHere('letter', '#letter-note'));

  // Opened from the dashboard's URL, so the viewer's own Save button offers
  // the real filename rather than the blob's UUID (F-412).
  $('#open-pdf').addEventListener('click', () => {
    const url = state.fileUrl || state.pdfUrl;
    if (url) chrome.tabs.create({ url });
  });
  $('#retailor').addEventListener('click', async () => {
    const request = $('#request').value.trim();
    const note = $('#retailor-note');
    if (!state.jobId) return;
    if (!request) { note.textContent = 'Say what to change.'; return; }
    $('#retailor').disabled = true;
    note.textContent = 'Asking…';
    const r = await ask({ type: 'panel-retailor', id: state.jobId, request });
    $('#retailor').disabled = false;
    if (!r.ok) { note.textContent = r.error || 'could not ask'; return; }
    note.textContent = 'Writing it again — the new PDF shows here when ready.';
    $('#request').value = '';
    state.lastKey = '';
    loadResume(state.jobId, { again: false, fresh: true });
  });
  $('#rebuild').addEventListener('click', () => { if (state.jobId) loadResume(state.jobId, { again: true }); });

  chrome.tabs?.onActivated?.addListener(() => refresh());
  // `loading` too, not only `complete`: a tab that has STARTED going somewhere
  // is already not showing what the panel is showing, and waiting for the load
  // event is most of the delay he reported.
  chrome.tabs?.onUpdated?.addListener((tabId, info) => {
    if (tabId !== state.tabId) return;
    if (info.status === 'complete' || info.url) refresh();
  });
  chrome.runtime?.onMessage?.addListener((msg) => { if (msg?.type === 'panel-refresh') { refresh(); } });

  /**
   * THE PANEL SAYS IT IS OPEN BY HOLDING A PORT (2026-09-23). While it is,
   * the page draws nothing over the form; the worker pushes "a report
   * changed" and "the progress line changed" down it, and the panel re-reads.
   * A worker that restarts drops the port, so it is opened again.
   */
  function connectPort() {
    let port;
    try { port = chrome.runtime.connect({ name: 'jarvis-panel' }); } catch { return; }
    const pinned = Number(new URLSearchParams(location.search).get('tab'));
    const hello = (windowId) => { try { port.postMessage({ type: 'hello', windowId, tabId: Number.isInteger(pinned) && pinned > 0 ? pinned : null }); } catch { /* gone */ } };
    if (chrome.windows?.getCurrent) chrome.windows.getCurrent().then((w) => hello(w?.id ?? null)).catch(() => hello(null)); else hello(null);
    port.onMessage.addListener((m) => { if ((m?.type === 'report' || m?.type === 'live') && m.tabId === state.tabId) pollState(); });
    port.onDisconnect.addListener(() => setTimeout(connectPort, 1000));
  }
  if (chrome.runtime?.connect) connectPort();

  try { $('#ver').textContent = chrome.runtime.getManifest().version; } catch { /* a harness */ }
  refresh();
  globalThis.__jarvisPanel = { refresh, state };
})();
