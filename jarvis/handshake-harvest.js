/* jarvis/handshake-harvest.js — run this in his logged-in Handshake tab.
 *
 * WHY IT SCRAPES THE PAGE INSTEAD OF CALLING AN API
 * ─────────────────────────────────────────────────
 * Handshake has a JSON endpoint, /stu/postings.json, and it is a trap. It
 * answers, it looks right, and it is a STALE ARCHIVE: harvested 2026-09-19 it
 * returned 792 postings dated 2015-2023, and not one of the jobs the live UI
 * was showing at that moment — Intuitive, TSMC, Affiliated Engineers —
 * appeared in it. Expiry cannot catch them either: those dead rows carry
 * closing dates years out, one of them 2028. Importing it would have put 774
 * corpses in the store, every one looking open.
 *
 * The live feed is far bigger — 5,223 results for "mechanical engineer" alone —
 * and reaches the browser over GraphQL at /hs/graphql, which cannot be called
 * blind: introspection is disabled and the search operation is in no initial
 * bundle. So the rendered search page is the source.
 *
 * WHY AN IFRAME, AND NOT CLICKING
 * ───────────────────────────────
 * Clicking a result card is a FULL PAGE LOAD, not a client-side route change.
 * That wipes this script on the first job, which is why the obvious version of
 * it harvests one posting and dies. Loading each posting into a same-origin
 * iframe keeps the runner alive on a page that never navigates.
 *
 * Three further things were each worth a wasted pass:
 *
 *   • `document.body.innerText` on a posting page contains the nav, the whole
 *     results list AND the detail. The list is near-identical everywhere, so
 *     anything that reads a window around the detail captures mostly list and
 *     every posting looks like a duplicate. The detail starts at "At a glance"
 *     and nothing before that belongs to it.
 *   • `document.title` is "Jobs | Handshake" on every posting, so it cannot
 *     tell one from another.
 *   • The description is clamped behind a "More" button, and the clamped text
 *     stops mid-sentence.
 *
 * HOW TO RUN
 *   1. Go to https://app.joinhandshake.com/job-search and search what you want,
 *      with whatever filters you want. Note the search text.
 *   2. Put that text in QUERY below.
 *   3. F12 → Console, paste this whole file, Enter.
 *   4. It logs progress and downloads handshake-harvest.json when done.
 *   5. node jarvis/import-handshake.mjs <that file> --dry-run
 *
 * Roughly six seconds a posting, because each one is a real page load.
 */
(async () => {
  const QUERY = 'mechanical engineer';
  const LIMIT = 150;
  const PAGES = 8;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-9999px;width:1200px;height:2400px';
  document.body.appendChild(frame);

  const load = url => new Promise(res => {
    let settled = false;
    frame.onload = () => { if (!settled) { settled = true; res(true); } };
    frame.src = url;
    setTimeout(() => { if (!settled) { settled = true; res(false); } }, 20000);
  });
  const doc = () => { try { return frame.contentDocument; } catch { return null; } };
  const at = () => { try { return frame.contentWindow.location.pathname; } catch { return ''; } };
  const detailOf = full => {
    const g = full.indexOf('At a glance');
    if (g !== -1) return full.slice(g);
    const j = full.indexOf('Job description');
    return j === -1 ? '' : full.slice(j);
  };

  const state = { cards: {}, ids: [], rows: [], missed: 0, errors: 0 };
  window.__HS = state;

  // 1. Ids and card text from the result pages. The card carries employer,
  //    title, pay and location; the detail page does not carry them anywhere
  //    that can be isolated, so both halves are needed.
  for (let page = 1; page <= PAGES && state.ids.length < LIMIT; page++) {
    await load(`/job-search?page=${page}&per_page=25&query=${encodeURIComponent(QUERY)}`);
    let els = [];
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      const d = doc();
      if (!d) break;
      els = [...d.querySelectorAll('[data-hook^="job-result-card"]')];
      if (els.length) break;
    }
    if (!els.length) { console.warn(`[handshake] no cards on page ${page} — stopping`); break; }
    for (const el of els) {
      const id = (el.getAttribute('data-hook').match(/(\d{5,})/) || [])[1];
      if (!id || state.cards[id]) continue;
      state.cards[id] = (el.innerText || '').trim();
      state.ids.push(id);
    }
    console.log(`[handshake] page ${page}: ${state.ids.length} postings listed`);
  }

  // 2. Each posting, in the same frame.
  for (const id of state.ids.slice(0, LIMIT)) {
    try {
      await load(`/job-search/${id}`);
      let pane = '';
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        const d = doc();
        if (!d) continue;
        // The frame must actually be at this posting before its text counts.
        if (!at().includes(`/job-search/${id}`)) continue;
        pane = detailOf(d.body.innerText || '');
        if (pane.length > 200) break;
        pane = '';
      }
      if (!pane) { state.missed++; continue; }
      const d = doc();
      for (const b of d.querySelectorAll('button, a')) {
        const s = (b.innerText || '').trim();
        if (s === 'More' || s === 'Show more' || s === 'See more') { b.click(); break; }
      }
      await sleep(600);
      state.rows.push({ posting_id: id, card: state.cards[id] || '', pane: detailOf(d.body.innerText || '') || pane });
    } catch {
      state.errors++;
    }
    if (state.rows.length % 10 === 0) console.log(`[handshake] ${state.rows.length}/${Math.min(LIMIT, state.ids.length)}`);
  }

  const payload = JSON.stringify({ takenAt: new Date().toISOString(), query: QUERY, rows: state.rows });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  a.download = 'handshake-harvest.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  frame.remove();
  console.log(`[handshake] done — ${state.rows.length} postings, ${state.missed} never rendered, ${state.errors} errors.`);
})();
