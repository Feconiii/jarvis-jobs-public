/**
 * THE LINKEDIN MESSAGE FILL, AS PAGE CODE (2026-10-24).
 *
 * One copy, two users. The extension's send session (background.js) runs
 * these with chrome.scripting in the page's own world; opera-fill.mjs and the
 * Claude in Chrome steps (linkedin-fill.mjs) read this file and send each
 * function's source over the DevTools protocol. Each function is complete in
 * itself (Chrome sends only its source), so none may use anything outside its
 * own body. Only send() presses Send, and only a scheduled session calls it
 * without `dry` (background.js autoSendOutreach).
 *
 * Where the compose form lives: `#interop-outlet`'s shadow root (a pop-up on
 * the profile) or a same-origin iframe (the full-page compose). Every
 * function looks in the page, its same-origin iframes and those shadow roots.
 */
(function (root) {
  /**
   * Step 1, P = { name, first, subject, message, bridge? }. On the profile:
   * goes to the full-page compose its Message link points to ("RETRY": run it
   * again there). On the compose page: checks it is addressed to this person,
   * sets the subject and PASTES the message (a typed newline can send it).
   * With `bridge`, adds the one-pixel file field the DevTools route uploads to.
   */
  async function fill(P) {
    const roots = () => {
      const docs = [document];
      for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
      const out = [];
      for (const d of docs) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) out.push(s); out.push(d); }
      return out;
    };
    const subjOf = () => roots().map((r) => r.querySelector('input[name="subject"], input[placeholder^="Subject"]')).find(Boolean);
    const win = (el) => el.ownerDocument.defaultView;
    // A hidden tab runs setTimeout at most once a second, then once a minute;
    // message-channel ticks are not slowed (F-941, 2026-10-27).
    const sleep = (ms) => (document.hidden ? new Promise((done) => { const end = performance.now() + ms; const c = new MessageChannel(); c.port1.onmessage = () => (performance.now() >= end ? done() : c.port2.postMessage(0)); c.port2.postMessage(0); }) : new Promise((r) => setTimeout(r, ms)));
    if (!subjOf()) {
      // Three compose layouts: the pop-up on the profile, /messaging/thread/new
      // (InMail) and /messaging/compose (Opera, 2026-10-04).
      if (/\/messaging\/(thread\/new|compose)/.test(location.pathname)) {
        for (let i = 0; i < 25 && !subjOf(); i++) await sleep(300);
      } else {
        // Waits for the profile to finish loading (up to ~10 s) instead of a fixed pause.
        const find = () => [...document.querySelectorAll('main a, main button')].find((e) => e.innerText.trim() === 'Message' && e.offsetParent);
        let link = find();
        for (let i = 0; i < 33 && !link; i++) { await sleep(300); link = find(); }
        if (!link) return 'STOP: no Message button on this profile (not messageable, or the page never loaded)';
        // The link is the full-page compose; LinkedIn turns the click into a
        // pop-up (interop=msgOverlay), and a pop-up's text was gone when he
        // opened the tab (Riley, Shreyash, 2026-10-05) while full pages kept
        // theirs. So go to the page itself; step 1 runs again there.
        const href = link.getAttribute('href') || '';
        if (/\/messaging\/compose/.test(href)) { location.href = href.replace(/([?&])interop=msgOverlay&?/, '$1').replace(/[?&]$/, ''); return 'RETRY: opening the full-page compose; run step 1 again'; }
        link.click();
        for (let i = 0; i < 40 && !subjOf(); i++) await sleep(300);
        if (!subjOf()) return 'RETRY: Message was pressed and LinkedIn is opening the compose page; run step 1 again';
      }
    }
    const subj = subjOf();
    if (!subj) return 'STOP: the compose form did not open';
    // The nearest container holding both the subject and the message box, then
    // the nearest one above it that names the recipient (the full page puts the
    // name in a header above the form). Never the whole page.
    const up = (el, ok) => { for (let e = el, i = 0; e && i < 14; e = e.parentElement, i++) { if (/^(BODY|HTML)$/.test(e.tagName)) return null; if (ok(e)) return e; } return null; };
    const box = up(subj, (e) => e.querySelector('div[contenteditable="true"]'));
    if (!box) return 'STOP: no message box beside the subject';
    // The recipient's name is looked for OUTSIDE the message box: the saved
    // message opens "Hi <first>", so a box holding it always "named" them.
    // Conversation lists and the messaging sidebar are skipped too: they name
    // other people. A match is the first AND last word of the full name, as
    // whole words, in one piece of text: a first name alone let another Dana,
    // or "Al" inside "Alex", pass (review of F-951, 2026-11-02).
    const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const toks = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const full = toks(P.name);
    const need = full.length > 1 ? [full[0], full[full.length - 1]] : full;
    const skip = '[contenteditable="true"], [class*="conversations-list"], [class*="conversation-list"], [class*="conversations-container"], [class*="msg-overlay-list"], [class*="conversation-listitem"]';
    const named = (e) => {
      const w = e.ownerDocument.createTreeWalker(e, 4, { acceptNode: (n) => (n.parentElement && n.parentElement.closest(skip) ? 2 : 1) });
      while (w.nextNode()) { const t = new Set(toks(w.currentNode.nodeValue)); if (need.length && need.every((x) => t.has(x))) return true; }
      return false;
    };
    if (!up(box, named)) return 'STOP: the compose form is not addressed to ' + P.name;
    // THE INMAIL CHECK (2026-10-26, "sth that clicks on message and see what it
    // says"): the compose is open and addressed; creditLine() reads it next.
    // Nothing is typed, nothing is sent.
    if (P.peek) return 'OPEN: the compose form is open for ' + P.name;
    // NEVER A SECOND FIRST MESSAGE (2026-10-27, Jordan Vale: he had messaged
    // him by hand, which this system cannot see). A thread that already holds
    // any message is his conversation; only his own accepted connection note
    // may be there.
    // Counted here, not by calling priorMessages(): this function's source is
    // all the page receives, so a helper outside it does not exist there.
    const prior = (() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const note = norm(P.connectNote).slice(0, 40);
      const items = roots().flatMap((r) => [...r.querySelectorAll('[class*="event-listitem__body"], .msg-s-event-listitem__body')]);
      const texts = [...new Set(items.map((e) => norm(e.innerText || e.textContent)))].filter(Boolean);
      return texts.filter((t) => !(note && t.includes(note))).length;
    })();
    if (prior) return 'STOP: you already have a conversation with ' + P.name + ' (' + prior + ' earlier message' + (prior > 1 ? 's' : '') + '); nothing typed';
    const body = [...box.querySelectorAll('div[contenteditable="true"]')].pop();
    if (body.innerText.trim()) return 'STOP: the message box already has text; left it alone';
    const W = win(subj);
    const set = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value').set;
    subj.focus(); set.call(subj, P.subject);
    for (const t of ['input', 'change']) subj.dispatchEvent(new W.Event(t, { bubbles: true, composed: true }));
    body.focus();
    const dt = new W.DataTransfer(); dt.setData('text/plain', P.message);
    body.dispatchEvent(new W.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
    await sleep(700);
    const words = body.innerText.trim().split(/\s+/).length;
    if (!P.bridge) return 'FILLED: subject set, ' + words + ' words in the box';
    document.querySelectorAll('input[aria-label="' + P.bridge + '"]').forEach((e) => e.remove());
    const bridge = document.createElement('input');
    bridge.type = 'file'; bridge.setAttribute('aria-label', P.bridge);
    bridge.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:2147483647';
    document.body.appendChild(bridge);
    return 'FILLED: subject set, ' + words + ' words in the box; upload the resume to "' + P.bridge + '"';
  }

  /**
   * Step 2, P = { as, pdf?, bridge? }: hands the resume to LinkedIn's own
   * document field as "Alex Rivera Resume - <Company> - <Role>.pdf" (his call,
   * 2026-10-04) and waits for "Attached". The file comes as base64 in `pdf`
   * (the extension) or from the temporary field (the DevTools route).
   */
  async function attach(P) {
    const roots = () => {
      const docs = [document];
      for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
      const out = [];
      for (const d of docs) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) out.push(s); out.push(d); }
      return out;
    };
    const subjOf = () => roots().map((r) => r.querySelector('input[name="subject"], input[placeholder^="Subject"]')).find(Boolean);
    const win = (el) => el.ownerDocument.defaultView;
    // A hidden tab runs setTimeout at most once a second, then once a minute;
    // message-channel ticks are not slowed (F-941, 2026-10-27).
    const sleep = (ms) => (document.hidden ? new Promise((done) => { const end = performance.now() + ms; const c = new MessageChannel(); c.port1.onmessage = () => (performance.now() >= end ? done() : c.port2.postMessage(0)); c.port2.postMessage(0); }) : new Promise((r) => setTimeout(r, ms)));
    const bridge = P.pdf ? null : document.querySelector('input[aria-label="' + P.bridge + '"]');
    if (!P.pdf && !bridge) return 'STOP: the temporary field is missing';
    if (bridge && !bridge.files.length) return 'STOP: nothing was uploaded to the temporary field';
    const subj = subjOf();
    if (!subj) return 'STOP: the compose form is gone';
    const target = [...subj.getRootNode().querySelectorAll('input[type="file"]')].find((i) => i !== bridge && /\.pdf/.test(i.accept));
    if (!target) return 'STOP: LinkedIn has no document field here';
    const W = win(target);
    // Replace, never stack: an earlier attachment in THIS form is removed first.
    for (const x of subj.getRootNode().querySelectorAll('.msg-attachment-preview__remove-attachment')) { x.click(); await sleep(300); }
    const dt = new W.DataTransfer();
    if (P.pdf) {
      const bin = W.atob(P.pdf);
      const bytes = new W.Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new W.File([bytes], P.as || 'Resume.pdf', { type: 'application/pdf' }));
    } else {
      for (const f of bridge.files) dt.items.add(new W.File([f], P.as || f.name, { type: f.type || 'application/pdf' }));
    }
    const name = dt.files[0].name;
    target.files = dt.files;
    target.dispatchEvent(new W.Event('change', { bubbles: true, composed: true }));
    if (bridge) bridge.remove();
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const box = target.closest('.msg-overlay-conversation-bubble, main') || target.ownerDocument.body;
      if (/Attached/.test(box.innerText) && box.innerText.includes(name.slice(0, 20))) return 'ATTACHED: ' + name + '. Ready for him to press Send';
    }
    return 'CHECK: the file was handed over but "Attached" never showed; look at the window';
  }

  /**
   * Step 3, ONLY for a scheduled send (2026-10-24, his call: "can we schedule
   * send it"), P = { name, first, subject, marks, as, dry? }. Presses LinkedIn's
   * Send only when everything checks out: the form is addressed to this
   * person, the subject and the text are the saved ones, the resume shows as
   * attached, and Send is enabled. Any doubt returns STOP and touches nothing.
   * With `dry` it checks and never presses ("SENDABLE"), which every ordinary
   * session runs so a broken check shows up before a schedule relies on it.
   * The button (measured 2026-10-24 on /messaging/compose):
   * form.msg-form > button.msg-form__send-btn[type=submit], disabled while empty.
   */
  async function send(P) {
    const roots = () => {
      const docs = [document];
      for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch {} }
      const out = [];
      for (const d of docs) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) out.push(s); out.push(d); }
      return out;
    };
    // A hidden tab runs setTimeout at most once a second, then once a minute;
    // message-channel ticks are not slowed (F-941, 2026-10-27).
    const sleep = (ms) => (document.hidden ? new Promise((done) => { const end = performance.now() + ms; const c = new MessageChannel(); c.port1.onmessage = () => (performance.now() >= end ? done() : c.port2.postMessage(0)); c.port2.postMessage(0); }) : new Promise((r) => setTimeout(r, ms)));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const subjs = roots().flatMap((r) => [...r.querySelectorAll('input[name="subject"], input[placeholder^="Subject"]')]);
    if (subjs.length !== 1) return subjs.length ? 'STOP: more than one compose form is open' : 'STOP: the compose form is gone';
    const subj = subjs[0];
    const up = (el, ok) => { for (let e = el, i = 0; e && i < 14; e = e.parentElement, i++) { if (/^(BODY|HTML)$/.test(e.tagName)) return null; if (ok(e)) return e; } return null; };
    const form = subj.closest('form') || up(subj, (e) => e.querySelector('div[contenteditable="true"]') && e.querySelector('button[type="submit"], button.msg-form__send-btn'));
    if (!form) return 'STOP: no compose form around the subject';
    // Outside the message box only: the pasted message opens "Hi <first>", so
    // counting the box made this pass whoever the form was addressed to. Same
    // rule as fill(): first and last word of the full name, whole words, one
    // piece of text, conversation lists skipped (review of F-951, 2026-11-02).
    const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const toks = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const full = toks(P.name);
    const need = full.length > 1 ? [full[0], full[full.length - 1]] : full;
    const skip = '[contenteditable="true"], [class*="conversations-list"], [class*="conversation-list"], [class*="conversations-container"], [class*="msg-overlay-list"], [class*="conversation-listitem"]';
    const named = (e) => {
      const w = e.ownerDocument.createTreeWalker(e, 4, { acceptNode: (n) => (n.parentElement && n.parentElement.closest(skip) ? 2 : 1) });
      while (w.nextNode()) { const t = new Set(toks(w.currentNode.nodeValue)); if (need.length && need.every((x) => t.has(x))) return true; }
      return false;
    };
    if (!up(form, named)) return 'STOP: the compose form is not addressed to ' + P.name;
    if (norm(subj.value) !== norm(P.subject)) return 'STOP: the subject is not the saved one';
    const body = [...form.querySelectorAll('div[contenteditable="true"]')].pop();
    const typed = norm(body && body.innerText);
    if (!typed || !(P.marks || []).length || !P.marks.every((m) => typed.includes(m))) return 'STOP: the text in the box is not the saved message';
    if (P.as) {
      const area = form.closest('.msg-overlay-conversation-bubble, main') || form;
      if (!(/Attached/.test(area.innerText) && area.innerText.includes(P.as.slice(0, 20)))) return 'STOP: the resume does not show as attached';
    }
    const btn = [...form.querySelectorAll('button')].find((b) => b.classList.contains('msg-form__send-btn') || (b.type === 'submit' && /^send$/i.test(norm(b.innerText))));
    if (!btn) return 'STOP: no Send button in the form';
    for (let i = 0; i < 10 && btn.disabled; i++) await sleep(300);
    if (btn.disabled) return 'STOP: Send is greyed out';
    if (P.dry) return 'SENDABLE: addressed, subject, text and resume all check out';
    btn.click();
    return 'PRESSED: Send';
  }

  /**
   * Step 4, after a message is confirmed SENT (his call, 2026-10-26: "why cant
   * u also press connect when u send"; he always forgot to connect after an
   * InMail). P = { name, first, dry? }, run on that person's PROFILE. Presses
   * Connect (the top card, else the More menu), then "Send without a note" (the
   * message already said it all), and waits for Pending. Already connected or
   * already invited: nothing pressed. A box asking for their email, or any doubt:
   * Escape, STOP, nothing sent. With `dry`, finds Connect and presses nothing.
   */
  async function connect(P) {
    // A hidden tab runs setTimeout at most once a second, then once a minute;
    // message-channel ticks are not slowed (F-941, 2026-10-27).
    const sleep = (ms) => (document.hidden ? new Promise((done) => { const end = performance.now() + ms; const c = new MessageChannel(); c.port1.onmessage = () => (performance.now() >= end ? done() : c.port2.postMessage(0)); c.port2.postMessage(0); }) : new Promise((r) => setTimeout(r, ms)));
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const roots = () => {
      const out = [document];
      const s = document.querySelector('#interop-outlet')?.shadowRoot; if (s) out.unshift(s);
      return out;
    };
    const all = (sel) => roots().flatMap((r) => [...r.querySelectorAll(sel)]);
    const shown = (e) => !!(e.offsetParent || e.getClientRects().length);
    const label = (e) => norm(e.getAttribute('aria-label') || e.innerText);
    // "Invite <name> to connect" must name THEM: first and last word of the
    // full name as whole words (a first-name substring let "People also
    // viewed" cards for another Dana pass; 2026-11-02).
    const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const toks = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const full = toks(P.name);
    const need = full.length > 1 ? [full[0], full[full.length - 1]] : full;
    const forThem = (e) => { const l = label(e); if (!/invite /i.test(l)) return true; const t = new Set(toks(l)); return need.length > 0 && need.every((x) => t.has(x)); };
    const top = () => document.querySelector('main section') || document.querySelector('main');
    let card = null;
    // Up to 30 s (2026-10-27: 10 of 16 "never loaded" at 0.8 GB free; the
    // same profiles loaded in ~8 s by hand).
    for (let i = 0; i < 100 && !card; i++) { card = top(); if (!card || !/Message|Connect|Follow|Pending/.test(card.innerText)) { card = null; await sleep(300); } }
    if (!card) return 'STOP: the profile never loaded';
    const inCard = () => [...card.querySelectorAll('button, a')].filter(shown);
    if (inCard().some((e) => /^pending\b|withdraw invitation/i.test(label(e)))) return 'ALREADY: an invitation is pending';
    if (/·\s*1st\b/.test(card.innerText)) return 'ALREADY: connected (1st degree)';
    let btn = inCard().find((e) => (/^invite .* to connect$/i.test(label(e)) || norm(e.innerText) === 'Connect') && forThem(e));
    if (!btn) {
      const more = inCard().find((e) => /^more( actions)?$/i.test(label(e)));
      if (!more) return 'STOP: no Connect button and no More menu';
      more.click();
      // The menu can take seconds to draw on a slow machine: look for up to 5 s
      // (2026-10-27: Sam, Irene, Bea, Jo "Follow only", yet Connect was in
      // that menu when read by hand).
      for (let i = 0; i < 17 && !btn; i++) {
        await sleep(300);
        btn = all('[role="menuitem"], [role="button"], div[aria-label], a').filter(shown)
          .find((e) => (/^invite .* to connect$/i.test(label(e)) || norm(e.innerText) === 'Connect') && forThem(e));
      }
      if (!btn) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'STOP: Connect is not offered for this person (Follow only)'; }
    }
    if (P.dry) return 'CONNECTABLE: Connect found';
    btn.click();
    // WITH HIS NOTE (2026-10-26, out of InMail): "Add a note", type it, read it
    // back, Send. No "Add a note", a box asking for their email, or any doubt:
    // Escape, STOP, nothing sent.
    if (P.note) return await withNote();
    let send = null, mail = false;
    for (let i = 0; i < 30 && !send; i++) {
      await sleep(300);
      const dlg = all('[role="dialog"], [role="alertdialog"]').filter(shown);
      mail = dlg.some((d) => /enter their email|email address to connect/i.test(d.innerText));
      if (mail) break;
      send = dlg.flatMap((d) => [...d.querySelectorAll('button')]).find((b) => /^send without a note$/i.test(label(b)) || /^send now$/i.test(label(b)));
      if (!send && i > 6) {
        const pend = inCard().some((e) => /^pending\b|withdraw invitation/i.test(label(e)));
        if (pend) return 'CONNECTED: invitation sent (no box asked for a note)';
      }
    }
    const esc = () => { for (const r of roots()) (r.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })); };
    if (mail) { esc(); return 'STOP: LinkedIn wants their email address to connect; not sent'; }
    if (!send) { esc(); return 'STOP: the invitation box did not offer "Send without a note"'; }
    send.click();
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      if (inCard().some((e) => /^pending\b|withdraw invitation/i.test(label(e)))) return 'CONNECTED: invitation sent, shows Pending';
    }
    return 'CHECK: Send was pressed in the invitation box but Pending never showed';

    async function withNote() {
      const note = String(P.note || '');
      if (note.length > 300) return 'STOP: the note is over 300 characters';
      const dialogs = () => all('[role="dialog"], [role="alertdialog"]').filter(shown);
      const escNow = () => { for (const r of roots()) (r.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })); };
      let add = null;
      for (let i = 0; i < 30 && !add; i++) {
        await sleep(300);
        const dlg = dialogs();
        if (dlg.some((d) => /enter their email|email address to connect/i.test(d.innerText))) { escNow(); return 'STOP: LinkedIn wants their email address to connect; not sent'; }
        add = dlg.flatMap((d) => [...d.querySelectorAll('button')]).find((b) => /^add a (free )?note$/i.test(label(b)));
      }
      if (!add) { escNow(); return 'STOP: the invitation box did not offer "Add a note"; nothing sent'; }
      add.click();
      let box = null;
      for (let i = 0; i < 30 && !box; i++) { await sleep(300); box = dialogs().flatMap((d) => [...d.querySelectorAll('textarea')]).find(shown); }
      if (!box) { escNow(); return 'STOP: the note box never opened; nothing sent'; }
      box.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, note);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      if (norm(box.value) !== norm(note)) { escNow(); return 'STOP: the note did not go in as written; nothing sent'; }
      let send = null;
      for (let i = 0; i < 20 && !send; i++) {
        await sleep(250);
        send = dialogs().flatMap((d) => [...d.querySelectorAll('button')])
          .find((b) => /^send( invitation| now)?$/i.test(label(b)) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      }
      if (!send) { escNow(); return 'STOP: Send stayed off after the note went in; nothing sent'; }
      send.click();
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        if (inCard().some((e) => /^pending\b|withdraw invitation/i.test(label(e)))) return 'CONNECTED: invitation with note sent, shows Pending';
      }
      return 'CHECK: Send was pressed with the note but Pending never showed';
    }
  }

  /**
   * How many messages the open conversation already holds, leaving out his
   * own connection note (it shows in the thread once accepted). 0 = a new
   * conversation.
   */
  function priorMessages(rootList, connectNote = '') {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const note = norm(connectNote).slice(0, 40);
    const items = rootList.flatMap((r) => [...r.querySelectorAll('[class*="event-listitem__body"], .msg-s-event-listitem__body')]);
    const texts = [...new Set(items.map((e) => norm(e.innerText || e.textContent)))].filter(Boolean);
    return texts.filter((t) => !(note && t.includes(note))).length;
  }

  /**
   * Is the draft still in the box, and how many of its lines are in the
   * thread (counted outside the box). `marks` are draftMarks(message).
   */
  function sentCheck(marks) {
    const D = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
    const R = []; for (const d of D) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) R.push(s); R.push(d); }
    const norm = (s) => String(s || '').replace(/\s+/g, ' ');
    const typed = norm(R.flatMap((r) => [...r.querySelectorAll('div[contenteditable="true"]')]).map((b) => b.innerText).join(' '));
    const page = norm(R.map((r) => (r.body ? r.body.innerText : r.textContent) || '').join(' '));
    const count = (s, m) => s.split(m).length - 1;
    // The thread's own list when LinkedIn draws one; otherwise the whole page,
    // where the box's own copy is subtracted.
    const list = R.flatMap((r) => [...r.querySelectorAll('.msg-s-message-list, [class*="event-listitem__body"]')]);
    const thread = list.length ? norm(list.map((e) => e.innerText || e.textContent).join(' ')) : '';
    const inThread = (m) => list.length ? thread.includes(m) : count(page, m) > count(typed, m);
    return { inBox: marks.some((m) => typed.includes(m)), onPage: marks.filter(inThread).length };
  }

  /** LinkedIn's own line above the box: "Free message" or "Use 1 of N InMail credits". */
  function creditLine() {
    const D = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument; } catch { return null; } }).filter(Boolean)];
    const R = [];
    for (const d of D) { const s = d.querySelector('#interop-outlet')?.shadowRoot; if (s) R.push(s.textContent || ''); R.push(d.body?.innerText || ''); }
    const t = R.join(' ');
    const m = t.match(/Use \d+ of \d+ InMail credits?/i);
    if (m) return 'InMail: ' + m[0];
    if (/Free message/i.test(t)) return 'free message';
    // No credits left: LinkedIn says so instead of offering one.
    const none = t.match(/(?:you(?:'ve| have) (?:used all|no) (?:of your )?InMail credits?|out of InMail credits?|0 InMail credits?|(?:do not|don't) have enough InMail credits?|not enough InMail credits?)[^.\n]{0,60}/i);
    return none ? 'InMail: none left (' + none[0].trim() + ')' : '';
  }

  /**
   * Up to three long lines of the message, cut to 60 characters: what is
   * looked for in the box and the thread. Links and the Portfolio / Resume /
   * Role lines are left out (LinkedIn redraws links).
   */
  function draftMarks(text) {
    return String(text || '').split('\n').map((l) => l.trim().replace(/\s+/g, ' '))
      .filter((l) => l.length >= 40 && !/https?:\/\//.test(l) && !/^(portfolio|resume|role)\s*:/i.test(l))
      .sort((a, b) => b.length - a.length).slice(0, 3).map((l) => l.slice(0, 60));
  }

  /**
   * Both at once ("already") means it went out in an earlier session that was
   * never marked: he must not send it twice.
   */
  function sentState({ inBox, onPage }) {
    if (inBox) return onPage > 0 ? 'already' : 'waiting';
    return onPage > 0 ? 'sent' : 'cleared';
  }

  root.JarvisLinkedIn = { fill, attach, send, connect, sentCheck, creditLine, draftMarks, sentState, priorMessages };
})(typeof self !== 'undefined' ? self : globalThis);
