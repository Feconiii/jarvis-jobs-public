/**
 * The dashboard's LAYOUT BUDGET, and the parts of it that are load-bearing.
 *
 * The header is `position: sticky`, so every pixel in it is spent on every
 * screen of every scroll. It had grown to **263px on a 761px viewport** — a
 * third of the window, permanently, before a single posting — which is why a
 * card never fitted and every session began by scrolling.
 *
 * Measurement is the only honest way to test this. "Looks tidier" is not a
 * regression guard; a number is. These run the real page in a real browser
 * against the real store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 4391;

/** The whole point. Exceeding this means a card stops fitting again. */
const HEADER_BUDGET = 170;

let server;
let browser;
let page;

async function up(capMs = 25000) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

test.before(async () => {
  server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)],
    // READ-ONLY, ENFORCED. These run against the REAL store on purpose: the
    // header budget below is only meaningful with real postings behind it, and
    // a seeded temp store would measure a page with no cards on it. But a test
    // that can write to his job store is one click away from editing his data
    // — so the server refuses every non-GET request while these run, and a
    // test that starts needing one fails loudly instead.
    { cwd: ROOT, env: { ...process.env, JARVIS_AUTO: '0', JARVIS_READONLY: '1' }, stdio: 'ignore' });
  assert.ok(await up(), 'the dashboard must start');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1523, height: 761 } });
  await page.goto(`http://127.0.0.1:${PORT}/#cards`);
  await page.waitForTimeout(3500);
  await page.evaluate(() => document.querySelector('[data-view="cards"]')?.click());
  await page.waitForTimeout(2000);
});

test.after(async () => { await browser?.close(); server?.kill(); });

const headerHeight = () => page.evaluate(() =>
  Math.round(document.querySelector('header').getBoundingClientRect().height));

test('THE STICKY HEADER STAYS INSIDE ITS BUDGET', async () => {
  const h = await headerHeight();
  assert.ok(h <= HEADER_BUDGET,
    `header is ${h}px, budget ${HEADER_BUDGET}px. It was 263px once and a card never fitted.`);
});

test('the header is three rows, not five', async () => {
  // titlebar / nav / controls. The brand line, the deep-read progress and the
  // "354 of 3,152" line were three separate rows saying small things.
  const rows = await page.evaluate(() => [...document.querySelector('header').children]
    .map((c) => ({ cls: (c.className || '').toString().split(' ')[0], h: Math.round(c.getBoundingClientRect().height) }))
    .filter((r) => r.h > 0));
  assert.ok(rows.length <= 3, `header has ${rows.length} visible rows: ${rows.map((r) => r.cls).join(', ')}`);
  const titlebar = rows.find((r) => r.cls === 'titlebar');
  assert.ok(titlebar.h < 40, `the titlebar wrapped to ${titlebar.h}px — it must stay one line`);
});

test('NAVIGATION DOES NOT MOVE between views', async () => {
  // A recorded past bug: the tab bar shared a row with controls that are hidden
  // on some views, so it slid ~390px sideways and you would click "Inbox" and
  // find the bar had moved under your cursor. Nothing in the header may push it.
  const at = async (view) => {
    await page.evaluate((v) => document.querySelector(`[data-view="${v}"]`)?.click(), view);
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const r = document.querySelector('.navrow').getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left) };
    });
  };
  const cards = await at('cards');
  const interested = await at('interested');   // filters do not apply here
  const home = await at('home');
  assert.deepEqual(interested, cards, 'nav moved between Cards and Interested');
  assert.deepEqual(home, cards, 'nav moved between Cards and Home');
  await page.evaluate(() => document.querySelector('[data-view="cards"]')?.click());
  await page.waitForTimeout(700);
});

test('the filter row collapses, reopens, and remembers across views', async () => {
  const state = () => page.evaluate(() => ({
    open: document.getElementById('filters').style.display !== 'none',
    header: Math.round(document.querySelector('header').getBoundingClientRect().height),
    label: document.getElementById('filtoggle').textContent,
  }));

  const closed = await state();
  assert.equal(closed.open, false, 'it starts collapsed — it is the least-touched part of the page');

  await page.evaluate(() => toggleFilters());
  await page.waitForTimeout(300);
  const open = await state();
  assert.equal(open.open, true);
  assert.ok(open.header > closed.header, 'opening it must actually show the controls');
  assert.match(open.label, /▲/);

  // Switching views rewrites this element's display; the choice must survive.
  await page.evaluate(() => document.querySelector('[data-view="home"]')?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-view="cards"]')?.click());
  await page.waitForTimeout(800);
  assert.equal((await state()).open, true, 'the open/closed choice must survive a view switch');

  await page.evaluate(() => toggleFilters());
  await page.waitForTimeout(300);
  assert.equal((await state()).open, false);
});

test('A HIDDEN FILTER SAYS SO — it may never silently shape the deck', async () => {
  // The one real risk of collapsing them: "354 of 3,152 undecided" has to stay
  // explainable. The button reports how many filters are still narrowing it.
  const label = await page.evaluate(() => document.getElementById('filtoggle').textContent);
  const active = await page.evaluate(() => {
    const box = document.getElementById('filters');
    let n = 0;
    for (const el of box.querySelectorAll('select')) if (el.selectedIndex > 0) n++;
    for (const el of box.querySelectorAll('input[type=checkbox]')) if (el.checked) n++;
    return n + box.querySelectorAll('.chip.on, .seg button.on').length;
  });
  if (active > 0) assert.match(label, new RegExp(`Filters\\s*·\\s*${active}`), `${active} filters are active and the button says "${label}"`);
  else assert.equal(label.trim(), 'Filters');
});

test('the view tabs are never counted as filters', async () => {
  // #view is also a .seg — counting its "on" button would make the badge lie.
  const inside = await page.evaluate(() =>
    document.getElementById('filters').contains(document.querySelector('#view')));
  assert.equal(inside, false, 'the view selector must stay outside the filter box');
});

test('the filter button disappears on views where filters do nothing', async () => {
  // A toggle for controls that would not apply is the same trap as a control
  // that does nothing — the existing code already hides the row on these views.
  //
  // This used to click [data-view="interested"], which stopped existing when the
  // twelve tabs became five. `?.click()` on a missing element is a silent no-op,
  // so the test went on measuring whatever view it happened to be on — it failed
  // loudly here, but the shape (an assertion quietly aimed at nothing) is the
  // one that passes forever while testing nothing.
  const go = async (view, sub) => {
    await page.evaluate(([v, s]) => {
      document.querySelector(`#view button[data-view="${v}"]`).click();
      if (s) document.querySelector(`#subview button[data-sub="${s}"]`)?.click();
    }, [view, sub]);
    await page.waitForTimeout(800);
    return page.evaluate(() => getComputedStyle(document.getElementById('filtoggle')).display !== 'none');
  };
  assert.equal(await go('inbox'), false, 'filters do not apply to the curated inbox, so neither should the button');
  // …and the mirror, so this cannot pass by hiding the button everywhere.
  assert.equal(await go('library', 'library'), true, 'the Library is the pile filters are FOR');
  await go('library', 'cards');
});

/**
 * THE AGE FILTER HAS TO WORK ON THE INBOX, which is the reason it exists:
 * "strong fit AND posted recently" is a question about the curated shortlist.
 *
 * The collapsible filter row is hidden on the Inbox — the discovery filters do
 * not apply to a pile he has already decided — and the query builder drops
 * everything inside its `!DECIDED` block there. A date control built into
 * either of those would have been on screen doing nothing, or worse, off screen
 * doing something. It sits beside search, on both counts.
 */
test('the posted-date filter is live on the curated Inbox', async () => {
  await page.evaluate(() => {
    document.querySelector('#view button[data-view="inbox"]').click();
    SUB.inbox = 'inbox';
    document.querySelector('#subview button[data-sub="inbox"]')?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('#view button.on')?.dataset.view === 'inbox' && !S.inflight.size,
    null,
    { timeout: 30000 },
  ).catch(() => {});

  const visible = await page.evaluate(() => ({
    posted: getComputedStyle(document.getElementById('posted')).display !== 'none',
    filterRow: getComputedStyle(document.getElementById('filters')).display !== 'none',
    inFilterRow: document.getElementById('filters').contains(document.getElementById('posted')),
  }));
  assert.equal(visible.posted, true, 'the control he is asked to combine with fit must be reachable here');
  assert.equal(visible.filterRow, false, 'the Inbox still hides the discovery filters');
  assert.equal(visible.inFilterRow, false, 'inside that row it would be hidden on the Inbox and inert everywhere else');

  await page.evaluate(() => {
    window.__seen = [];
    window.__realFetch = window.fetch;
    window.fetch = (u, ...a) => { window.__seen.push(String(u)); return window.__realFetch(u, ...a); };
    const s = document.getElementById('posted');
    s.value = '14';
    s.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(2000);
  const asked = await page.evaluate(() => {
    window.fetch = window.__realFetch;
    return window.__seen.filter((u) => u.includes('/api/jobs'));
  });
  const listCall = asked.find((u) => /status=/.test(u));
  assert.ok(listCall, `changing the control must refetch the list; it fetched: ${asked.join(' | ') || '(nothing)'}`);
  assert.match(listCall, /postedWithin=14/, `the Inbox query dropped the age filter: ${listCall}`);
  assert.match(decodeURIComponent(listCall), /status=inbox/, `this was not the Inbox query: ${listCall}`);

  // "Any age" sends nothing at all, rather than a window wide enough to look
  // like nothing — and the rest of this file runs on an unfiltered page.
  await page.evaluate(() => {
    window.__seen = [];
    window.__realFetch = window.fetch;
    window.fetch = (u, ...a) => { window.__seen.push(String(u)); return window.__realFetch(u, ...a); };
    const s = document.getElementById('posted');
    s.value = 'all';
    s.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(2000);
  const cleared = await page.evaluate(() => {
    window.fetch = window.__realFetch;
    return window.__seen.filter((u) => u.includes('/api/jobs') && /status=/.test(u));
  });
  assert.ok(cleared.length && !/postedWithin/.test(cleared[0]), `"Any age" must not send a window: ${cleared[0] || '(no refetch)'}`);

  // Hand the next test a settled page. Leaving a fetch of this test's in
  // flight makes the NEXT one read a list mid-repaint — the failure its own
  // comment warns about, imported from here.
  await page.evaluate(() => {
    document.querySelector('#view button[data-view="library"]').click();
    document.querySelector('#subview button[data-sub="cards"]')?.click();
  });
  await page.waitForFunction(
    () => document.querySelector('#view button.on')?.dataset.view === 'library' && !S.inflight.size,
    null,
    { timeout: 30000 },
  ).catch(() => {});
});

test('the age filter is not counted as one of the collapsed filters', async () => {
  // The Filters badge exists so a hidden filter can never silently shape the
  // deck. #posted is never hidden, so counting it would make the badge report
  // a filter he can already see — the same lie in the other direction.
  const label = await page.evaluate(() => {
    document.getElementById('posted').value = '30';
    syncFilterToggle();
    const t = document.getElementById('filtoggle').textContent;
    document.getElementById('posted').value = 'all';
    syncFilterToggle();
    return t;
  });
  const base = await page.evaluate(() => document.getElementById('filtoggle').textContent);
  assert.equal(label, base, 'the badge must not move when an always-visible control changes');
});

test('a tile that resets the filters resets the age filter too', async () => {
  // resetFilters() exists because a tile has to describe its own destination:
  // the New-grad tile promised 115 and showed 752 on filters the previous click
  // had left set. An age filter survives onto the DECIDED views, so it can
  // outlive a tile the same way.
  const after = await page.evaluate(() => {
    document.getElementById('posted').value = '7';
    resetFilters();
    return document.getElementById('posted').value;
  });
  assert.equal(after, 'all', 'resetFilters() left the age filter narrowing the tile it landed on');
});

/**
 * THE DECK'S KEYS ACT ON THE CARD ON SCREEN.
 *
 * After the five-tab refactor the key handler read the TOP tab, which can never
 * be 'cards', so every deck key fell through to the table handler keyed on
 * S.cursor. The deck advances S.cardIdx and never touches S.cursor, so on card
 * 21 the letter q queued card 1 — a silent write to the wrong job on the one
 * screen where each keystroke is a decision. Found by an audit, fixed blind
 * because the browser extension kept timing out on the deck; this is the check.
 *
 * Runs against his real store, so no key that writes is allowed to reach the
 * server: singleAct is stubbed to record the id it was handed.
 */
test('deck keys act on the card on screen, never on the table cursor', async () => {
  await page.evaluate(() => document.querySelector('#view button[data-view="library"]').click());
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#subview button[data-sub="cards"]')?.click());
  // WAITED FOR, NOT SLEPT THROUGH. A cold deck query over his real store took
  // between 1.2 and 7.5 seconds when measured, and a fixed four passed alone
  // and failed inside the full suite, where every other test is on the same
  // database. Until renderCards() has run, #cardwrap is still hidden — which
  // is the deck loading, not the deck broken.
  await page.waitForFunction(
    () => currentView() === 'cards' && !S.inflight.size
      && (getComputedStyle(document.querySelector('#cardwrap')).display !== 'none' || !S.filtered.length),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const r = await page.evaluate(() => {
    const out = { view: currentView(), deckVisible: getComputedStyle(document.querySelector('#cardwrap')).display !== 'none' };
    if (!S.filtered.length) return { ...out, empty: true };
    const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    document.activeElement?.blur();
    const before = S.cardIdx;
    press('ArrowRight'); press('ArrowRight');
    out.movedBy = S.cardIdx - before;
    out.cursorStill = S.cursor;
    // Capture, do not write. The deck path is cardAct -> persist; stubbing the
    // one function every write goes through keeps this off his real store.
    const seen = [];
    window.persist = (body) => { seen.push(body); };
    press('q');
    out.queued = seen[0] ? { id: seen[0].ids?.[0], status: seen[0].status } : null;
    out.onScreen = S.filtered[S.cardIdx]?.id || null;
    out.tableCursorJob = S.filtered[S.cursor]?.id || null;
    return out;
  });
  if (r.empty) { console.log('  (deck empty for the current filters — navigation assertions skipped)'); return; }
  assert.equal(r.view, 'cards', 'the deck sub-view is what is showing');
  assert.equal(r.deckVisible, true, 'the deck is on screen');
  assert.equal(r.movedBy, 2, 'two right-arrows advance the deck by two');
  assert.equal(r.cursorStill, 0, 'the table cursor is untouched by deck navigation');
  assert.ok(r.queued, 'q reached the action path');
  assert.equal(r.queued.id, r.onScreen, 'q acted on the card on screen');
  assert.notEqual(r.queued.id, r.tableCursorJob, '…and not on the job under the table cursor');
});

/**
 * THE TABLE'S KEYS ACT ON THE ROW UNDER THE CURSOR.
 *
 * The mirror of the deck test. j/k move the cursor; i/q/h decide the job the
 * cursor is on and no other. persist is stubbed, so his real store is not
 * touched by a test that presses q.
 */
test('table keys act on the row under the cursor', async () => {
  // WAITED FOR, NOT SLEPT THROUGH. `S.filtered` holds whatever view rendered
  // last, so reading it a fixed 3s after a click read the PREVIOUS view's rows
  // whenever the Library's own fetch had not landed yet — a test failing for a
  // reason that has nothing to do with the screens it is checking.
  await page.evaluate(() => { SUB.library = 'library'; document.querySelector('#view button[data-view="library"]').click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#subview button[data-sub="library"]')?.click());
  await page.waitForFunction(
    () => document.querySelector('#view button.on')?.dataset.view === 'library'
      && !S.inflight.size && Array.isArray(S.filtered) && S.filtered.length > 0,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const r = await page.evaluate(() => {
    if (S.filtered.length < 3) return { empty: true };
    const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    document.activeElement?.blur();
    S.cursor = 0;
    press('j'); press('j');
    const cursorAfter = S.cursor;
    // READ BEFORE THE PRESS. A decision now leaves the pile it was decided out
    // of straight away (F-463), so the row under the cursor after the keypress
    // is the NEXT job, not the one that was decided.
    const expected = S.filtered[2]?.id;
    const highlightedBefore = document.querySelector('tr.job.cursor')?.dataset?.id || null;
    const seen = [];
    window.persist = (body) => { seen.push(body); };
    press('q');
    return {
      view: currentView(),
      cursorAfter,
      expected,
      highlightedBefore,
      decided: seen[0]?.ids?.[0] || null,
      status: seen[0]?.status || null,
      gone: !S.filtered.some((x) => x.id === expected),
      highlightedAfter: document.querySelector('tr.job.cursor')?.dataset?.id || null,
    };
  });
  if (r.empty) { console.log('  (library empty for the current filters — skipped)'); return; }
  assert.equal(r.view, 'library');
  assert.equal(r.cursorAfter, 2, 'two j presses move the cursor two rows');
  assert.equal(r.highlightedBefore, r.expected, 'the highlighted row is the cursor row');
  assert.equal(r.decided, r.expected, 'q decides the row under the cursor');
  assert.equal(r.status, 'queued');
  assert.equal(r.gone, true, 'and the queued row leaves the Library on the press, not on the next fetch');
  assert.notEqual(r.highlightedAfter, r.expected, 'the cursor does not sit on a row that has left');
});

/**
 * EVERY APPLICATIONS SUB-VIEW SHOWS SOMETHING REAL.
 *
 * Three views were folded into one tab. A sub-view that renders an empty
 * surface with no message is indistinguishable from a broken one.
 */
test('Applications is one page: the tracker board, then Review & Send', async () => {
  await page.evaluate(() => document.querySelector('#view button[data-view="applications"]').click());
  // WAIT FOR THE BOARD, do not sleep at it. It fetches the whole pipeline, and
  // on a loaded machine that took longer than the two and a half seconds this
  // used to allow — a green suite failing here means the timer, not the board.
  await page.waitForFunction(() => {
    const b = document.querySelector('#board');
    return !!b && b.textContent.trim().length > 0;
  }, null, { timeout: 30000 });
  const r = await page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none' && e.textContent.trim().length > 0; };
    const board = document.querySelector('#board'), hub = document.querySelector('#hub');
    return {
      view: currentView(),
      subBar: getComputedStyle(document.querySelector('#subview')).display !== 'none',
      board: !!board && board.textContent.trim().length > 0,
      hub: vis('#hub'),
      boardAboveHub: !!board && !!hub && (board.compareDocumentPosition(hub) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      table: getComputedStyle(document.querySelector('#tbl')).display !== 'none',
    };
  });
  assert.equal(r.view, 'applications');
  assert.equal(r.subBar, false, 'no sub bar — it is one page');
  assert.ok(r.board, 'the tracker board renders');
  assert.ok(r.hub, 'Review & Send renders beneath it');
  assert.ok(r.boardAboveHub, 'board first, then review');
  assert.equal(r.table, false, 'the job table is not shown here');
});

/**
 * A HEART MEANS TRACK, AND TRACKED JOBS LIVE ON THE APPLICATIONS BOARD.
 *
 * Hearting a curated row used to keep it in the Inbox but sort it under the
 * curated block, so in a long inbox the row vanished from where it was and
 * turned up nowhere he looked. Now the Inbox never fetches hearted rows, the
 * board's first column is Tracking, and it advances to Applied. Checked
 * against the real page: the query the Inbox sends, the column the board
 * draws, and the status the heart persists.
 */
test('a heart moves the row from the Inbox to Tracking on the Applications board', async () => {
  await page.evaluate(() => { document.querySelector('#view button[data-view="inbox"]').click(); SUB.inbox = 'inbox'; document.querySelector('#subview button[data-sub="inbox"]')?.click(); });
  // Waited for, not slept through — the same reason as the two below.
  await page.waitForFunction(
    () => document.querySelector('#view button.on')?.dataset.view === 'inbox' && !S.inflight.size,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const r = await page.evaluate(() => {
    const seen = [];
    const realFetch = window.fetch;
    window.fetch = (u, ...a) => { seen.push(String(u)); return realFetch(u, ...a); };
    window.persist = (body) => { seen.push(body); };
    const heart = document.querySelector('tr.job .rowacts button');
    const row = heart?.closest('tr.job');
    const id = row?.dataset.id || null;
    heart?.click();
    window.fetch = realFetch;
    return {
      id,
      title: heart?.title || '',
      persisted: seen.find((x) => typeof x === 'object'),
      inboxQuery: seen.find((x) => typeof x === 'string' && /status=/.test(x)) || '',
    };
  });
  const inboxStatuses = decodeURIComponent((r.inboxQuery.match(/status=([^&]+)/) || [])[1] || '');
  assert.ok(!/interested/.test(inboxStatuses), `the Inbox must not fetch hearted rows, it asked for: ${inboxStatuses || '(no inbox query — was the page on the inbox?)'}`);
  if (!r.id) { console.log('  (inbox empty — the query check above is the whole test here)'); }
  else {
    assert.match(r.title, /Track/, 'the heart says where the job goes');
    assert.equal(r.persisted?.status, 'interested');
    // persist() is stubbed — this is his real store — so the row's departure
    // is proven by the query above: the Inbox never asks for 'interested'.
  }
  // …and the board has somewhere for it to land.
  //
  // WAITED FOR, NOT SLEPT THROUGH. The board is one fetch over his real store,
  // and a fixed 2.5s passed for weeks and then began failing whenever anything
  // else was touching the database — a sweep on the live dashboard is enough.
  // A sleep that is usually long enough is a test that fails for reasons that
  // have nothing to do with the thing it is testing.
  await page.evaluate(() => document.querySelector('#view button[data-view="applications"]').click());
  await page.waitForFunction(
    () => document.querySelectorAll('#board .col h3').length > 0 || document.getElementById('boardempty')?.style.display === '',
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const cols = await page.evaluate(() => [...document.querySelectorAll('#board .col h3')].map((h) => h.textContent.replace(/^\d+\s*/, '').trim()));
  assert.match(cols[0] || '', /Tracking/, `the first column is Tracking, got: ${cols.join(' | ')}`);
  assert.match(cols[1] || '', /Applied/, 'and it advances to Applied');
});

/**
 * F-463: THE HEART WRITES BEFORE IT RE-READS.
 *
 * His report, 2026-09-14: *"when i press the heart icon on a job it does not
 * move to applications instantly, sth weird happens where it stays there or
 * another job from same company pop up."*
 *
 * `singleAct` fired `apply(true)` — a fresh GET over the store — and only
 * afterwards POSTed the status. The read beat the write, the server answered
 * with the row still in the inbox, and that answer painted over the optimistic
 * change. The next click's fetch was the one that finally saw the previous
 * click's write, which is why a different posting from the same company looked
 * like it jumped into the row: the list had moved by one decision he had
 * already made.
 *
 * Two things are proven here, and the first is the one that was broken:
 * the write is requested before the re-read, and the row is out of the list on
 * the click rather than on whatever the network says a second later.
 */
test('a heart writes before it re-reads, and the row leaves the Inbox on the click', async () => {
  await page.evaluate(() => { document.querySelector('#view button[data-view="inbox"]').click(); SUB.inbox = 'inbox'; document.querySelector('#subview button[data-sub="inbox"]')?.click(); });
  await page.waitForFunction(
    () => document.querySelector('#view button.on')?.dataset.view === 'inbox' && !S.inflight.size,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const r = await page.evaluate(async () => {
    const order = [];
    const realFetch = window.fetch;
    const realPersist = window.persist;
    window.fetch = (u, ...a) => { if (/\/api\/jobs\?/.test(String(u))) order.push('read'); return realFetch(u, ...a); };
    // Stubbed, so his real store is never written by a test. What matters is
    // WHEN it is called, not what it does.
    window.persist = () => { order.push('write'); return Promise.resolve(); };
    const heart = document.querySelector('tr.job .rowacts button');
    const id = heart?.closest('tr.job')?.dataset.id || null;
    const before = S.filtered.length;
    heart?.click();
    // Read on the same tick as the click. The table repaints synchronously, so
    // this is the state of the screen before any answer can come back — which
    // is the whole claim. (persist is stubbed, so nothing was written and the
    // re-read below legitimately brings the row back; that is the stub, not
    // the bug.)
    const inListRightAfter = S.filtered.some((x) => x.id === id);
    const onScreen = !!document.querySelector(`tr.job[data-id="${id}"]`);
    await new Promise((res) => setTimeout(res, 1500));
    window.fetch = realFetch;
    window.persist = realPersist;
    return { id, order, before, inListRightAfter, onScreen };
  });
  if (!r.id) { console.log('  (inbox empty — nothing to heart)'); return; }
  assert.equal(r.inListRightAfter, false, 'the hearted job leaves the list on the click, not on the next fetch');
  assert.equal(r.onScreen, false, 'and its row is off the screen');
  assert.equal(r.order[0], 'write', `the write is requested first, got: ${r.order.join(' then ') || '(nothing)'}`);
  assert.ok(r.order.includes('read'), 'and the list re-reads the store afterwards');
});

/**
 * HIDING FROM THE LIST ASKS WHY, THE SAME AS THE DECK.
 *
 * The Deck's Skip asked and still does; the table's ✕ and its `h` key hid on
 * the spot — and since the Inbox became a list, that is where he hides most
 * things, so the skip reasons that train the ranker stopped being collected.
 * "also it doesnt ask me why i hide a job anymore" (2026-09-06).
 */
test('the list asks why before it hides, and a second press hides anyway', async () => {
  await page.evaluate(() => { S.filtered = []; document.querySelector('#view button[data-view="library"]').click(); SUB.library = 'library'; });
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#subview button[data-sub="library"]')?.click());
  // Waited for, not slept through: clicking a row that has not rendered yet
  // fails this test for a reason that has nothing to do with hiding.
  await page.waitForFunction(
    // `S.filtered` was emptied above, so this can only be true once THIS
    // view's own fetch has landed and rendered — the DOM alone still holds
    // the previous view's rows and would satisfy it immediately.
    () => document.querySelector('#view button.on')?.dataset.view === 'library'
      && !S.inflight.size && S.filtered.length > 0 && document.querySelectorAll('tr.job').length > 0,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const opened = await page.evaluate(() => {
    const row = document.querySelector('tr.job');
    if (!row) return { empty: true };
    row.querySelectorAll('.rowacts button')[1].click();       // the ✕
    const box = document.querySelector('tr.hiderow .skipbox');
    return {
      opened: !!box,
      heading: box?.querySelector('h4')?.textContent || '',
      reasons: (box?.querySelectorAll('.skipopts input') || []).length,
      hasNote: !!box?.querySelector('#hidenote'),
      hasCompany: !!box?.querySelector('#hidecompany'),
      hidden: row.dataset.id,
    };
  });
  if (opened.empty) { console.log('  (library empty for the current filters — skipped)'); return; }
  assert.ok(opened.opened, 'the ✕ opens the box rather than hiding on the spot');
  assert.match(opened.heading, /Why are you hiding this\?/);
  assert.ok(opened.reasons >= 4, `the deck's reasons are offered, got ${opened.reasons}`);
  assert.ok(opened.hasNote, 'and a box for his own words');
  assert.ok(opened.hasCompany, 'and the option to hide the employer entirely');

  // A SECOND PRESS HIDES, with whatever was said. persist() is stubbed — this
  // is his real store — so what is checked is the call, not a write.
  const acted = await page.evaluate(() => {
    const seen = [];
    window.persist = (body, path) => { seen.push({ body, path }); };
    document.querySelector('tr.job .rowacts button:nth-child(2)').click();
    return { seen, boxGone: !document.querySelector('tr.hiderow') };
  });
  assert.ok(acted.boxGone, 'the box closes');
  assert.ok(acted.seen.some((c) => c.body.status === 'hidden'), 'and the job is hidden');
});

/**
 * THE LIBRARY'S FIRST PAGE IS CLEAN.
 *
 * Everything the screens exclude must already be excluded from what he browses:
 * no hard-blocked row, no degree-mismatched row, nothing marked gone. This is
 * the deck's contract, checked against the rows actually on screen.
 */
test('the first page of the Library carries nothing the screens exclude', async () => {
  // WAITED FOR, NOT SLEPT THROUGH. `S.filtered` holds whatever view rendered
  // last, so reading it a fixed 3s after a click read the PREVIOUS view's rows
  // whenever the Library's own fetch had not landed yet — a test failing for a
  // reason that has nothing to do with the screens it is checking.
  await page.evaluate(() => { S.filtered = []; SUB.library = 'library'; document.querySelector('#view button[data-view="library"]').click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#subview button[data-sub="library"]')?.click());
  await page.waitForFunction(
    () => document.querySelector('#view button.on')?.dataset.view === 'library'
      && !S.inflight.size && Array.isArray(S.filtered) && S.filtered.length > 0,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const r = await page.evaluate(() => {
    const rows = S.filtered;
    const bad = rows.filter((j) => j.triage?.flags?.hardBlock || j.triage?.flags?.degreeMismatch || j.goneAt || (j.fit?.blockers || []).length);
    return { n: rows.length, bad: bad.length, sample: bad.slice(0, 3).map((j) => (j.title || '').slice(0, 50)) };
  });
  assert.ok(r.n > 0, 'the Library is not empty');
  assert.equal(r.bad, 0, `rows the screens should have excluded: ${JSON.stringify(r.sample)}`);
});

/**
 * THE APPLY POLL MUST BE ABLE TO STOP.
 *
 * `pollApply` was `for(;;)` with no exit but success or failure: a network
 * error did `continue`, forever, every 2.5 seconds. The dashboard server keeps
 * its apply contexts in memory, so restarting it leaves every polling tab
 * asking about an application the server has never heard of.
 *
 * Observed today on a tab left open across roughly fifteen restarts: it
 * accumulated one immortal loop per Apply ever pressed and stopped responding
 * to script at all — which reads as the whole dashboard being broken rather
 * than one loop being unbounded.
 *
 * Source-level, deliberately. The failure takes ten minutes of wall clock to
 * reproduce honestly, and what matters is that the three exits exist at all.
 */
test('the apply poll is bounded three ways', () => {
  const src = readFileSync(path.join(HERE, 'dashboard.html'), 'utf-8');
  const fn = src.slice(src.indexOf('async function pollApply'));
  const body = fn.slice(0, fn.indexOf('\nasync function '));

  assert.match(body, /Date\.now\(\) > until/, 'a total deadline');
  assert.match(body, /errors >= POLL_MAX_ERRORS/, 'a cap on consecutive errors');
  assert.match(body, /r\.status === 404/, 'and an immediate stop when the server forgets the id');

  // Each exit must SAY which one it was. A spinner that stops silently is the
  // same experience as one that never stops.
  for (const phrase of [/gave up waiting/, /no longer has this application/, /lost contact with the dashboard/]) {
    assert.match(body, phrase, `missing the wording for one of the exits: ${phrase}`);
  }
});

test('and it still returns on the happy path', () => {
  const src = readFileSync(path.join(HERE, 'dashboard.html'), 'utf-8');
  const fn = src.slice(src.indexOf('async function pollApply'));
  const body = fn.slice(0, fn.indexOf('\nasync function '));
  assert.match(body, /d\.status === 'ready'[\s\S]{0,200}?return;/, 'ready must still end the loop');
  assert.match(body, /d\.status === 'failed'[\s\S]{0,200}?return;/, 'and so must failed');
});

/**
 * EVERY TAILORED RESUME IS REACHABLE.
 *
 * Alex, 2026-09-02: "sometimes you generate resume but i cant view it since the
 * job site doesnt let me so idk what you wrote or how it looks like… i think we
 * need to make a resume viewer, i think we already have that but like a storage
 * for all tailored resume".
 *
 * He was right on both counts. The viewer existed and showed four files — the
 * family templates — because `sent/` is excluded from that walk as an audit
 * trail rather than a library. Fifty tailored PDFs sat on disk with nothing
 * listing them, so the only one he could reach was whichever the last
 * application uploaded — and the job site would not show him that one back.
 */
test('the resume list carries the sent archive, not just the templates', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/resumes`);
  const body = await res.json();

  assert.ok(Array.isArray(body.resumes), 'the family builds are still listed');
  assert.ok(Array.isArray(body.archive), 'and the archive is a separate list');
  assert.ok(body.archive.length > body.resumes.length,
    'there are far more sent resumes than templates; if this flips, the walk broke');

  const one = body.archive[0];
  for (const key of ['file', 'company', 'title', 'family', 'at', 'url']) {
    assert.ok(key in one, `an archive row must carry ${key} — the filename is the record`);
  }
  assert.match(one.url, /^\/resume\?dir=sent&file=/, 'and a link that goes through the guarded route');
});

test('an archived resume actually opens as a PDF', async () => {
  const { archive } = await (await fetch(`http://127.0.0.1:${PORT}/api/resumes`)).json();
  const res = await fetch(`http://127.0.0.1:${PORT}` + archive[0].url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition') || '', /^inline/,
    'inline, so it opens in the browser rather than landing in Downloads');
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString();
  assert.equal(head, '%PDF', 'and it is a real PDF, not an error page with a PDF content-type');
});

test('a resume link is only offered when the file is really there', () => {
  // 23 of his 30 prepared applications pointed at a sent/ file that no longer
  // exists, and the button was rendered anyway — it opened a 404, which reads
  // as a broken viewer rather than a missing file.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  assert.match(src, /function resumeLink/, 'the link is built in one place');
  assert.match(src, /existsSync\(path\.join\(RESUME_DIR, 'sent', name\)\)/,
    'and only when the PDF is on disk');

  const ui = readFileSync(path.join(HERE, 'dashboard.html'), 'utf-8');
  assert.match(ui, /if \(r\.resumeUrl\)\{/, 'the UI uses the checked link');
  assert.match(ui, /resume file no longer on disk/, 'and says so when there is none');
});

test('a prepared application says WHY it stopped', () => {
  // The most diagnostic thing a run produces: the form's own error text, plus
  // any background request that failed. Without it Review & Send says
  // "filled 21" and gives no way to tell "ready for your press" apart from
  // "the page refused to advance and you must finish it by hand".
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  assert.match(src, /stoppedBecause: String\((?:goneNote \|\| )?body\.stoppedBecause/, 'the server records it');
  assert.match(src, /stoppedBecause: j\.apply\.stoppedBecause/, 'and hands it to the page');

  const ui = readFileSync(path.join(HERE, 'dashboard.html'), 'utf-8');
  assert.match(ui, /if \(r\.stoppedBecause\)\{/, 'the page renders it');
  assert.match(ui, /'stopped: ' \+ r\.stoppedBecause/, 'labelled, so it reads as a reason rather than an error');

  // It has to hang off the row being built. Appending to the wrong variable
  // threw "card is not defined" and blanked the ENTIRE view — a one-word slip
  // that turned a new line of detail into a broken page.
  const block = ui.slice(ui.indexOf('if (r.stoppedBecause){'));
  assert.match(block.slice(0, 260), /p\.appendChild\(why\)/,
    'appended to the row container, not a name from another scope');
});

/**
 * EVERY NUMBER ON THE HEADER COUNTS WHAT ITS OWN TAB SHOWS.
 *
 * Screenshotted 2026-09-07: "47 inbox" over a list of 21, and a tracker board
 * drawing 25 cards while the header said 16. This file has fixed the same
 * habit three times before on the tiles; this asserts it for the header and
 * the board together, against the real store.
 */
test('the header agrees with the list it opens, and with the board', async () => {
  await page.evaluate(() => { document.querySelector('#view button[data-view="inbox"]').click(); SUB.inbox = 'inbox'; document.querySelector('#subview button[data-sub="inbox"]')?.click(); });
  await page.waitForTimeout(3000);
  const inbox = await page.evaluate(() => ({
    counted: Number((document.getElementById('counts').innerText.match(/([\d,]+)\s+inbox/) || [])[1]?.replace(/,/g, '') ?? -1),
    rows: document.querySelectorAll('tr.job').length,
    total: S.total,
  }));
  assert.equal(inbox.counted, inbox.total, `the header says ${inbox.counted}, the inbox holds ${inbox.total}`);

  await page.evaluate(() => document.querySelector('#view button[data-view="applications"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#board .col h3 b').length > 0, null, { timeout: 30000 });
  const board = await page.evaluate(() => ({
    tracking: Number((document.getElementById('counts').innerText.match(/([\d,]+)\s+tracking/) || [])[1]?.replace(/,/g, '') ?? -1),
    applied: Number((document.getElementById('counts').innerText.match(/([\d,]+)\s+applied/) || [])[1]?.replace(/,/g, '') ?? -1),
    cols: [...document.querySelectorAll('#board .col h3 b')].map((b) => Number(b.textContent)),
  }));
  assert.equal(board.cols[0], board.tracking, `the board draws ${board.cols[0]} tracked, the header says ${board.tracking}`);
  assert.equal(board.cols[1], board.applied, `the board draws ${board.cols[1]} applied, the header says ${board.applied}`);
});

test('a hidden employer is excluded by the API when its name contains a comma', async () => {
  // `excludeCompany` used to be read as ONE comma-joined value, so an employer
  // whose own name has a comma could never be excluded — 651 postings in his
  // store carry one. A repeated parameter says exactly what was meant.
  const r = await page.evaluate(async () => {
    const all = await (await fetch('/api/jobs?status=new&limit=1')).json();
    const co = all.jobs[0]?.company;
    if (!co) return { empty: true };
    const one = await (await fetch(`/api/jobs?status=new&limit=200&excludeCompany=${encodeURIComponent(co)}`)).json();
    const two = await (await fetch(`/api/jobs?status=new&limit=200&excludeCompany=${encodeURIComponent(co)}&excludeCompany=${encodeURIComponent('Nowhere, Inc')}`)).json();
    return { co, one: one.jobs.some((j) => j.company === co), two: two.jobs.some((j) => j.company === co) };
  });
  if (r.empty) { console.log('  (no rows to exclude — skipped)'); return; }
  assert.equal(r.one, false, `one parameter excludes ${r.co}`);
  assert.equal(r.two, false, 'and so does one of several, which is the shape the board sends');
});

/**
 * A work-authorisation block that lands AFTER he committed to the posting has
 * to show up on the card (F-468).
 *
 * Three General Matter reqs sat in his inbox for five days carrying
 * f_hard_block — the forms ask for a Q clearance and the posting requires US
 * citizenship — and the extension filled one of them. The screen reads that
 * flag when SELECTING and never again, so the card is the only place left
 * where he can be told.
 */
test('a card whose posting is now work-auth blocked says so, with the reason', async () => {
  const drawn = await page.evaluate(() => {
    const row = (key) => lateBlockLine({
      id: 'x', url: 'https://example.test/x', title: 'Mechanical Engineer (New Grad)',
      company: 'General Matter', fit: { blockers: [] },
      triage: { blockKey: key, flags: { hardBlock: true } },
    });
    const clean = lateBlockLine({
      id: 'y', url: 'https://example.test/y', title: 'Mechanical Engineer',
      company: 'WHOOP', fit: { blockers: [] }, triage: { flags: { hardBlock: false } },
    });
    return {
      clearance: row('clearance')?.textContent || '',
      citizen: row('us_citizen')?.textContent || '',
      unknownKey: row('something_new')?.textContent || '',
      clean: clean === null,
    };
  });
  assert.match(drawn.clearance, /needs a security clearance/, 'the card names the requirement');
  assert.match(drawn.citizen, /citizens only/, 'and does so for each verdict visa.mjs can reach');
  assert.match(drawn.clearance, /flagged after you tracked it/, 'and says when it arrived');
  // A verdict this file has not been taught about must still warn, not vanish.
  assert.match(drawn.unknownKey, /work authorisation/, 'an unknown key still warns');
  assert.equal(drawn.clean, true, 'a posting with no block draws nothing');
});

/**
 * A BACKGROUND BATCH NEVER PULLS THE LIST OUT FROM UNDER HIM (2026-09-24).
 * "hiding jobs and removing them still bugging out … nothing happens, or it
 * just drags my view to the top and nothing happens" — on the Inbox list. A
 * finishing batch reloaded the table, erasing the hide box he had just opened.
 */
test('a finished reading batch does not reload the list while a hide box is open', async () => {
  const kept = await page.evaluate(async () => {
    let loads = 0;
    const realLoad = window.load;
    window.load = () => { loads += 1; };
    // Pretend a hide box is open, then let a batch "finish".
    HIDE_ASK.id = 'x';
    lastBatchDone = 'earlier';
    const realFetch = window.fetch;
    window.fetch = async (u, o) => (String(u).includes('/api/progress')
      ? new Response(JSON.stringify({ coverage: { readable: 1, read: 1 }, batch: { completedAt: 'now' } }))
      : realFetch(u, o));
    await pollProgress();
    const withBox = loads;
    // No box, no recent touch, not the Inbox: the reload still happens.
    HIDE_ASK.id = null; LAST_TOUCH = 0; lastBatchDone = 'earlier';
    const onInbox = currentView() === 'inbox';
    await pollProgress();
    window.fetch = realFetch; window.load = realLoad;
    return { withBox, after: loads, onInbox };
  });
  assert.equal(kept.withBox, 0, 'not while the hide box is open');
  if (!kept.onInbox) assert.equal(kept.after, 1, 'and it still refreshes other views when he is not in the middle of something');
});
