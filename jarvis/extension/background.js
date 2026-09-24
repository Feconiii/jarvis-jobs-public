/**
 * Jarvis Apply — the service worker.
 *
 * It does three things the page cannot: talk to the local server, inject the
 * filler, and remember which tabs he has asked it to follow. Every DECISION is
 * the server's; this file carries bytes and keeps a list.
 *
 * WHY THE FETCHES LIVE HERE AND NOT IN THE CONTENT SCRIPT. An employer's page
 * sets its own Content-Security-Policy, and a request made from the page's world
 * answers to it. Workday and Eightfold both ship a connect-src that does not
 * include localhost, so a content script asking the server for a plan would be
 * blocked on exactly the sites this exists for. The service worker has its own
 * origin and its own host permissions, so it is not.
 *
 * ARMED TABS. One press on the toolbar used to mean one injection into one
 * page. Every application is more than one page — an Apply link that
 * navigates, a sign-in he does himself, a verification code, an iCIMS form
 * that is five real page loads — and each of those cost him another press,
 * which is the one thing the button was meant to spare him. So a press now
 * ARMS the tab: this worker re-injects the filler on every page that tab lands
 * on until he stops it, the tab closes, or the page says the application was
 * sent. It follows THAT tab and nothing else. A tab he never pressed the
 * button on is never read, whatever the manifest permits — that is the
 * boundary now, and loaded.test.mjs holds it.
 *
 * The extension is deliberately dumb. It holds no profile, no answers, no
 * resume, and no rules about what to say — all of that is in the repo next to
 * cv.md where it can be tested. If this file needed to know something about
 * Alex, that would be a sign the split is wrong.
 */

// What is known about each ATS: hosts, requisition ids, identity providers.
// Shared with the page, which is the point — see ats.js.
try { importScripts('ats.js'); } catch { /* a harness that loads this file bare */ }
const ATS = globalThis.__jarvisAts || null;

const BASES = ['http://localhost:4300', 'http://127.0.0.1:4300'];

let cached = { base: null, token: null };

/** Find the dashboard and get a token from it. Cached until it stops answering. */
async function connect() {
  if (cached.base && cached.token) return cached;
  for (const base of BASES) {
    try {
      const r = await fetch(`${base}/api/apply-token`, { method: 'GET' });
      if (!r.ok) continue;
      const { token } = await r.json();
      if (!token) continue;
      cached = { base, token };
      return cached;
    } catch { /* try the next one */ }
  }
  cached = { base: null, token: null };
  throw new Error('the Jarvis dashboard is not running — start it with npm run jarvis:serve');
}

/**
 * WHAT WENT WRONG, IN WORDS HE CAN ACT ON.
 *
 * The dashboard's catch-all for a path it does not have is `{error: "not
 * found"}`, and that is exactly what a dashboard running an older build
 * answers when the extension asks for `/api/answer`. He clicked "ask Claude",
 * the panel said **not found**, and there was nothing in those two words to
 * tell him the fix was to restart the server (screenshotted 2026-09-09).
 *
 * A 404 on this route has one likely cause and one fix, so it says both.
 */
function answerError(e) {
  const said = String(e?.body?.error || e?.message || e || '').trim();
  if (e?.status === 404 && /^not found$/i.test(said)) {
    return 'this dashboard has no /api/answer route — it is running an older build. Restart it (npm run jarvis:serve) and click again.';
  }
  return said || `server said ${e?.status || '?'}`;
}

async function api(pathname, { method = 'GET', body = null, raw = false, withName = false } = {}) {
  // A DASHBOARD THAT MOVED IS NOT A DASHBOARD THAT IS GONE (F-391).
  //
  // The base is cached until something refuses it, and a plain network failure
  // did not count: restart the server and the panel said "Jarvis cannot see
  // this page. Failed to fetch" and kept saying it, because every later call
  // reused the address that had just stopped answering. Measured while the
  // server was restarting under a run. One retry, through a fresh probe.
  let conn = await connect();
  let res;
  try {
    res = await fetch(`${conn.base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-jarvis-token': conn.token },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    cached = { base: null, token: null };
    conn = await connect();          // throws its own clear message if it is really gone
    res = await fetch(`${conn.base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-jarvis-token': conn.token },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  if (!res.ok) {
    // A stale cached base is the common case after a restart; forget it so the
    // next click reconnects instead of failing the same way forever.
    if (res.status === 403) cached = { base: null, token: null };
    let detail = '';
    let payload = null;
    try { payload = await res.json(); detail = payload?.error || ''; } catch { /* not json */ }
    // The CODE travels, not just the sentence. 425 means "the resume is still
    // being written" and is worth waiting on; 404 means there is nothing to
    // wait for. Telling those apart by matching the prose would break the first
    // time someone reworded it.
    const err = new Error(detail || `server said ${res.status}`);
    err.status = res.status;
    // The whole answer, not just its sentence: a 425 also says which stage the
    // resume build is at, and the panel shows that instead of one unchanging
    // line he read as a hang (2026-09-06).
    err.body = payload;
    throw err;
  }
  if (!raw) return await res.json();
  const buf = await res.arrayBuffer();
  // THE NAME THE SERVER GAVE IT. A blob URL has no name, so saving from the
  // panel produced "a bunch of random letters and numbers" (his words) instead
  // of "Alex Rivera Resume.pdf" — the one filename convention this project has.
  const named = /filename="?([^";]+)"?/i.exec(res.headers?.get?.('content-disposition') || '');
  return withName ? { buf, filename: named ? named[1].trim() : 'Alex Rivera Resume.pdf' } : buf;
}

/** Badge text is the whole UI. Green = filled, red = something to read. */
function badge(tabId, text, color) {
  // A tab that has just closed has no badge to set; that is not an error.
  try { chrome.action.setBadgeText({ tabId, text })?.catch?.(() => {}); } catch { /* gone */ }
  try { chrome.action.setBadgeBackgroundColor({ tabId, color })?.catch?.(() => {}); } catch { /* gone */ }
}

/** The tooltip says the state in words, since the badge has three characters. */
function title(tabId, text) {
  try { chrome.action.setTitle?.({ tabId, title: text })?.catch?.(() => {}); } catch { /* gone */ }
}

// ── armed tabs ───────────────────────────────────────────────────────
//
// WHERE THE LIST LIVES. A service worker is evicted after seconds of idle and
// starts again from nothing, so a plain Map here forgets every armed tab the
// moment he spends a minute on a sign-in page. `chrome.storage.session` would
// survive that — but it is cleared when the extension reloads, and this
// extension reloads ITSELF the moment the dashboard ships a newer version
// (reloadIfStale). Every deploy would have silently stopped following a tab
// mid-application. `chrome.storage.local` survives both; tab ids do not
// survive a browser restart, so the list is emptied on startup and each entry
// is checked against a live tab when the worker wakes.
//
// A mirror in worker memory saves a storage round trip on every navigation
// event, and is rebuilt from storage whenever the worker wakes.

const ARMED = new Map();          // tabId -> state, see arm()
let armedLoaded = null;           // promise: the mirror is in step with storage

/**
 * WHICH LOAD OF THE EXTENSION THIS IS.
 *
 * An extension reload does not clear the content scripts already living in
 * open pages: their isolated world stays, with `globalThis.__jarvisContent`
 * from the OLD code in it and a `chrome.runtime` that now throws "context
 * invalidated". The next injection found that object and handed the run to
 * it — measured live as "ran, 0 frame(s) answered". So every injection now
 * carries the id of the load it came from, and a page whose resident copy is
 * from another load replaces it. Session storage is right for this: it
 * survives the worker being evicted and is cleared by exactly the event that
 * should change it, a reload.
 */
let LOAD_ID = null;
async function loadId() {
  if (LOAD_ID) return LOAD_ID;
  try {
    const { loadId: had } = await chrome.storage?.session?.get('loadId') || {};
    if (had) { LOAD_ID = had; return had; }
  } catch { /* fall through */ }
  LOAD_ID = `${chrome.runtime.getManifest().version}-${Math.random().toString(36).slice(2, 10)}`;
  try { await chrome.storage?.session?.set({ loadId: LOAD_ID }); } catch { /* memory only */ }
  return LOAD_ID;
}

// The last few things that went wrong, for the dashboard to show. A service
// worker's console is the one place he never looks.
const RECENT = [];
function note(line) {
  RECENT.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (RECENT.length > 30) RECENT.shift();
  console.log(`[jarvis] ${line}`);
}

const store = () => chrome.storage?.local;

const emptyAcc = () => ({ filled: 0, checked: 0, skipped: 0, uploaded: false, reachedReview: false, unanswered: [], stoppedBecause: '', pageUrl: '', startedOn: '' });

/**
 * The same application page, as a key: the ATS's own id for the job when
 * the URL carries one (a posting and its apply page share it), otherwise
 * the page without its query and hash.
 */
function walkKey(url) {
  if (!url) return '';
  const t = ATS?.reqToken?.(url);
  if (t) return t;
  try { const u = new URL(String(url)); return `${u.origin}${u.pathname}`.toLowerCase(); } catch { return String(url); }
}

async function loadArmed() {
  if (!armedLoaded) {
    armedLoaded = (async () => {
      try {
        const { armed } = await store()?.get('armed') || {};
        for (const [k, v] of Object.entries(armed || {})) {
          const tabId = Number(k);
          // Still a tab? Chrome reuses nothing across a restart, and a tab
          // that closed while the worker slept is simply gone.
          const alive = await chrome.tabs?.get?.(tabId).then(() => true).catch(() => false);
          if (alive === false) continue;
          ARMED.set(tabId, v);
        }
      } catch { /* start empty */ }
    })();
  }
  return armedLoaded;
}

async function saveArmed() {
  try { await store()?.set({ armed: Object.fromEntries(ARMED) }); } catch { /* memory still holds it */ }
}

/**
 * How long a tab stays armed with nothing USEFUL happening on it.
 *
 * Hours, not minutes: he filled five applications, walked away, and came
 * back eight hours later to finish them. A tab that is still holding an
 * unsent application is still his application.
 */
const ARMED_IDLE_MS = 6 * 60 * 60 * 1000;

/** Follow-along runs allowed on one tab before it stands down. Runaway guard. */
const MAX_AUTO_RUNS_PER_TAB = 40;
/**
 * How long the worker waits on one injection before letting the tab go
 * (F-380). Long enough for a real walk that pauses on a resume build, short
 * enough that a page which navigated mid-injection does not strand the tab.
 */
const INJECT_CAP_MS = 180000;
/** Quiet follow-along runs on ONE url before the tab stops re-reading it. */
const QUIET_RUNS_BEFORE_HOLD = 3;

/** An Apply pressed by the page counts as ours for this long when a new tab appears. */
const FOLLOWING_WINDOW_MS = 15000;

/**
 * Arm a tab. `seed` carries what an opener passes to the tab it opened.
 *
 *   id/company/title  the application, once the server has said
 *   token             the posting id of the URL that set the application, so a
 *                     different posting pasted into this tab is noticed
 *   started           he began this application himself — his press, or a tab
 *                     his press opened. Only then may a run nobody pressed for
 *                     follow an Apply control.
 *   acc               what every run on this tab has done, added up, which is
 *                     what the dashboard is told — the LAST run on a tab is
 *                     almost always a no-op on a Review or thank-you page
 */
async function arm(tabId, seed = {}) {
  await loadArmed();
  const now = Date.now();
  ARMED.set(tabId, {
    at: now, id: null, company: null, title: null, token: null, started: false,
    runs: 0, lastRunAt: now, lastUsefulAt: now, followingAt: 0,
    // F-379: consecutive follow-along runs that answered nothing, the url they
    // happened on, and the url the tab is holding at.
    quiet: 0, quietAt: '', holdAt: null, holdUrl: null,
    acc: emptyAcc(),
    ...seed,
  });
  await saveArmed();
  // NEVER LET CHROME THROW A FILLED APPLICATION AWAY. Memory Saver discards
  // background tabs and reloads them from scratch on the next click, and a
  // single-page form loses every answer on it when that happens. Measured
  // live: four filled applications sat in background tabs while another was
  // being tested; he clicked through and found every one of them blank. An
  // armed tab is exactly the tab that must stay in memory.
  await chrome.tabs?.update?.(tabId, { autoDiscardable: false }).catch(() => {});
  paint(tabId);
}

async function disarm(tabId, why = '') {
  await loadArmed();
  if (!ARMED.has(tabId)) return;
  const st = ARMED.get(tabId);
  ARMED.delete(tabId);
  await saveArmed();
  if (why) console.log(`[jarvis] tab ${tabId}: stopped following — ${why}`);
  // Chrome may manage the tab's memory again — but NOT while it still holds
  // a filled, unsent application. Only a sent or empty one is handed back.
  const acc = st?.acc || {};
  if (!(acc.filled > 0 || acc.uploaded)) await chrome.tabs?.update?.(tabId, { autoDiscardable: true }).catch(() => {});
  badge(tabId, '', '#888888');
  title(tabId, 'Fill this application from Jarvis (Alt+Shift+J)');
}

async function armedState(tabId) {
  await loadArmed();
  return ARMED.get(tabId) || null;
}

/**
 * Put the tab's state on the toolbar.
 *
 * Chrome clears a tab's badge and title on every cross-document navigation —
 * the exact event this worker follows — so the state is painted again after
 * each one, from the list, not from the last run. The count is the tab's
 * total, so an application reads "14" at the Review page rather than the "0"
 * the last, empty run produced.
 */
function paint(tabId) {
  const st = ARMED.get(tabId);
  if (!st) return;
  const n = (st.acc?.filled || 0) + (st.acc?.checked || 0);
  badge(tabId, n ? String(n) : 'on', n ? '#1a7f37' : '#1f6feb');
  title(tabId, `Jarvis is following this tab${st.company ? ` — ${st.company}` : ''}. Click to fill now; stop from the panel or the icon's menu.`);
}

/** Remember what the server said this tab's application is. */
async function rememberApplication(tabId, { id, company, title: jobTitle }, fromUrl = '') {
  const st = await armedState(tabId);
  if (!st || !id) return;
  if (st.id && st.id !== String(id)) {
    // THE SAME APPLICATION, ON ITS ATS. Applied Materials' posting on
    // jobs.appliedmaterials.com sends Apply to careers.appliedmaterials.com
    // (Eightfold), where the store holds the job as a second row; the page
    // said "following" just before that click, so the new id is where the
    // application he started continues, not a job he browsed to (F-366).
    const ourApply = Date.now() - (st.followingAt || 0) <= FOLLOWING_WINDOW_MS;
    if (ourApply) {
      console.log(`[jarvis] tab ${tabId}: Apply led to ${company || id} on its ATS (was ${st.company || st.id}) — the same application`);
    } else {
      // A DIFFERENT JOB. He navigated the tab to another posting, so the old
      // application's "he started this" no longer applies to what is on screen:
      // the new one is read, and applied to only when he presses.
      console.log(`[jarvis] tab ${tabId}: now on ${company || id} (was ${st.company || st.id})`);
      st.started = false;
      st.acc = emptyAcc();
      dropReport(tabId);
    }
  }
  Object.assign(st, {
    id: String(id),
    company: company || st.company,
    title: jobTitle || st.title,
    token: (fromUrl && ATS?.reqToken(fromUrl)) || st.token || null,
  });
  await saveArmed();
  paint(tabId);
}

/**
 * THE SIDE PANEL IS WHERE THE REPORT LIVES (2026-09-23).
 *
 * "stuff is still climbing on top of each other" — the page used to draw its
 * fill report as a box over the form, beside a side panel holding the resume
 * and the letter. The page now hands its report here; the panel reads it on
 * its Answers tab. The panel says it is open by holding a port, so the page
 * can be told to draw nothing while it is, and one line when it is not.
 *
 * In memory only, like the rest of a run's live state: a restarted worker
 * loses a report, and the next run or step writes a fresh one.
 */
const PANELS = new Map();   // port -> { windowId, tabId (a pinned dock or harness) }
const REPORTS = new Map();  // tabId -> { report, reportAt, live, liveAt }
/**
 * THE REPORT OUTLIVES THE WORKER (2026-09-24). "why tf the telling claude to
 * answer again is so awful i still cant do it it legit just doesnt let me or
 * show it." A Manifest V3 worker is stopped after about thirty idle seconds,
 * and this Map went with it — the panel's Answers tab then had nothing to
 * show, and every "ask Claude" link lived inside that report. Kept in
 * session storage too (cleared when the browser closes), read back on a miss.
 */
const reportKey = (tabId) => `report:${tabId}`;
function saveReport(tabId) {
  try { chrome.storage?.session?.set?.({ [reportKey(tabId)]: { report: REPORTS.get(tabId)?.report || null, reportAt: REPORTS.get(tabId)?.reportAt || 0 } })?.catch?.(() => {}); } catch { /* memory still has it */ }
}
function dropReport(tabId) {
  REPORTS.delete(tabId);
  try { chrome.storage?.session?.remove?.(reportKey(tabId))?.catch?.(() => {}); } catch { /* nothing kept */ }
}
async function loadReport(tabId) {
  if (REPORTS.has(tabId)) return REPORTS.get(tabId);
  try {
    const got = await chrome.storage?.session?.get?.(reportKey(tabId));
    const kept = got?.[reportKey(tabId)];
    if (kept?.report) { REPORTS.set(tabId, { ...kept }); return REPORTS.get(tabId); }
  } catch { /* not kept */ }
  return {};
}

chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'jarvis-panel') return;
  PANELS.set(port, { windowId: null, tabId: null });
  port.onMessage.addListener((m) => {
    if (m?.type === 'hello') PANELS.set(port, { windowId: Number.isInteger(m.windowId) ? m.windowId : null, tabId: Number.isInteger(m.tabId) ? m.tabId : null });
  });
  port.onDisconnect.addListener(() => PANELS.delete(port));
});

/** Is a panel open beside this tab — Chrome's side panel in its window, or a dock pinned to it? */
function panelOpenFor(tab) {
  if (!tab) return false;
  for (const p of PANELS.values()) {
    if (p.tabId != null ? p.tabId === tab.id : p.windowId == null || p.windowId === tab.windowId) return true;
  }
  return false;
}

/** Tell every open panel that a tab's report or progress changed. */
function tellPanels(tabId, what) {
  for (const port of PANELS.keys()) { try { port.postMessage({ type: what, tabId }); } catch { /* it closed */ } }
}

/** Something that did work, or that he has to act on. */
const hasSubstance = (r) => !!r && ((r.filled || 0) + (r.checked || 0) > 0 || (r.written || []).length > 0 || (r.unanswered || []).length > 0);

// A top-frame posting resolution in flight, per tab. An embedded form's frame
// can ask for a plan before the page around it has said which job this is;
// that plan waits, briefly, so it carries the id.
const RESOLVING = new Map();

/** Bytes to base64, in chunks — a PDF is a few hundred KB and btoa wants a string. */
function base64Of(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * What the side panel shows for a tab: the posting the page is (by the id
 * the armed tab carries, else by the page), its fit, and the application the
 * server holds for it — plus the tab's own walk state.
 */
async function panelFor(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !/^https?:/i.test(tab.url)) return { ok: false, status: 0, error: 'not a web page' };
  const st = await armedState(tabId);
  const armed = st ? { id: st.id, company: st.company, title: st.title, started: !!st.started, acc: st.acc } : null;
  let heading = '';
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
    heading = r?.result || '';
  } catch { /* a page it may not read; the URL and title still say plenty */ }
  const q = new URLSearchParams({ pageUrl: tab.url, heading, pageTitle: tab.title || '' });
  if (st?.id) q.set('id', st.id);
  try {
    const data = await api(`/api/panel?${q}`);
    return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title || '' }, armed, running: RUNNING.has(tabId), data };
  } catch (e) {
    return { ok: false, status: e.status || 0, error: String(e?.message || e), tab: { id: tab.id, url: tab.url, title: tab.title || '' }, armed, running: RUNNING.has(tabId) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    // WHICH TAB IS ASKING. An armed tab carries its application id, and every
    // request from it is made on that application's behalf — the page URL is
    // still sent, but the id is what the server trusts first. This is what
    // lets a Workday form on `<tenant>.wd5.myworkdayjobs.com` get the resume
    // built from the posting he armed on, when nothing in that hostname says
    // which employer it is.
    const tabId = sender?.tab?.id;
    const topFrame = !sender?.frameId;
    // The panel is an extension page: beside a tab it has no sender.tab; opened
    // in a tab (a harness) it has one, but its URL is this extension's own.
    const fromPanel = !sender?.tab || /^chrome-extension:/i.test(String(sender?.url || sender?.origin || ''));
    try {
      // THE SIDE PANEL ASKS. It is an extension page, not a tab, so it names
      // the tab it is beside; everything it shows comes through here.
      if (msg?.type === 'panel' && Number.isInteger(msg.tabId) && fromPanel) {
        reply(await panelFor(msg.tabId));
        return;
      }
      if (msg?.type === 'panel-state' && Number.isInteger(msg.tabId) && fromPanel) {
        const st = await armedState(msg.tabId);
        const rep = await loadReport(msg.tabId);
        reply({
          ok: true, armed: st ? { id: st.id, company: st.company, title: st.title, started: !!st.started, acc: st.acc } : null, running: RUNNING.has(msg.tabId),
          // What the page's last run reported, and the progress line right now.
          report: rep.report || null, live: RUNNING.has(msg.tabId) || Date.now() - (rep.liveAt || 0) < 15_000 ? (rep.live || '') : '',
        });
        return;
      }
      // "ASK CLAUDE", FROM THE PANEL. The page knows which box the question
      // is about and what surrounds it; the panel does not, so the page is
      // asked first and the answer is then requested exactly as the page's own
      // link requested it — same route, same writer, same checks.
      if (msg?.type === 'panel-ask' && Number.isInteger(msg.tabId) && fromPanel) {
        const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
        if (!tab) { reply({ ok: false, error: 'that tab is gone' }); return; }
        const st = await armedState(msg.tabId);
        const ctx = await chrome.tabs.sendMessage(msg.tabId, { type: 'jarvis-field', question: String(msg.question || ''), free: !!msg.free, request: String(msg.request || '') }).catch(() => null);
        const asking = ctx?.asking ?? String(msg.request || '');
        const q = String(ctx?.q || msg.question || '').trim();
        try {
          const got = await api('/api/answer', { method: 'POST', body: {
            id: st?.id || undefined, question: q, kind: null,
            context: String(ctx?.context || ''), request: asking, again: !!msg.again || !!asking, field: ctx?.field || null,
            pageUrl: String(ctx?.pageUrl || tab.url || ''), pageTitle: String(ctx?.pageTitle || tab.title || ''),
            heading: String(ctx?.heading || ''), pageText: String(ctx?.pageText || '').slice(0, 3000),
          } });
          reply({ ok: true, q, ...got });
        } catch (e) {
          reply({ ok: false, q, status: e.status || 0, writing: e.status === 425, error: answerError(e) });
        }
        return;
      }
      if (msg?.type === 'panel-answer-get' && Number.isInteger(msg.tabId) && fromPanel) {
        const st = await armedState(msg.tabId);
        try {
          const q = new URLSearchParams();
          if (msg.key) q.set('key', String(msg.key));
          else { if (st?.id) q.set('id', String(st.id)); q.set('question', String(msg.question || '')); }
          reply({ ok: true, ...(await api(`/api/answer?${q}`)) });
        } catch (e) {
          reply({ ok: false, status: e.status || 0, writing: e.status === 425, error: answerError(e) });
        }
        return;
      }
      if (msg?.type === 'panel-put' && Number.isInteger(msg.tabId) && fromPanel) {
        const r = await chrome.tabs.sendMessage(msg.tabId, { type: 'jarvis-put', question: String(msg.question || ''), text: String(msg.text || '') }).catch(() => null);
        reply(r ? { ok: true, ...r } : { ok: false, said: 'the page did not answer — press Fill this page once, then try again' });
        return;
      }
      if (msg?.type === 'panel-stop' && Number.isInteger(msg.tabId) && fromPanel) {
        await disarm(msg.tabId, 'he pressed stop in the panel');
        reply({ ok: true });
        return;
      }
      // THE PAGE'S REPORT (2026-09-23). Kept for the panel, and the page told
      // whether to draw anything. A frame that did nothing never replaces a
      // report that did something moments ago: an embedded form reports from
      // its iframe, and the page around it reports "no form was read here".
      if (msg?.type === 'page-report' && tabId) {
        const tab = sender.tab;
        const now = Date.now();
        const had = await loadReport(tabId);
        const incoming = msg.report || {};
        const keep = !hasSubstance(incoming) && hasSubstance(had.report) && now - (had.reportAt || 0) < 30_000;
        if (!keep) { REPORTS.set(tabId, { ...had, report: incoming, reportAt: now }); saveReport(tabId); }
        const open = panelOpenFor(tab);
        tellPanels(tabId, 'report');
        // A subframe cannot draw in the corner; the top frame draws its line.
        if (!open && !topFrame && !keep) {
          const line = `Jarvis · ${incoming.filled || 0} filled${(incoming.written || []).length ? ` · ${incoming.written.length} written` : ''}${(incoming.unanswered || []).length ? ` · ${incoming.unanswered.length} left for you` : ''}`;
          chrome.tabs.sendMessage(tabId, { type: 'jarvis-line', text: line, panelOpen: false }, { frameId: 0 }).catch(() => {});
        }
        reply({ ok: true, panelOpen: open });
        return;
      }
      if (msg?.type === 'page-live' && tabId) {
        const had = REPORTS.get(tabId) || {};
        REPORTS.set(tabId, { ...had, live: String(msg.text || ''), liveAt: Date.now() });
        tellPanels(tabId, 'live');
        reply({ ok: true, panelOpen: panelOpenFor(sender.tab) });
        return;
      }
      // "Open the panel", clicked on the page's one-line status. Not a user
      // gesture by the time it arrives here, so Chrome's own panel may refuse;
      // the dock beside the page is the rung that always works (F-411).
      if (msg?.type === 'open-panel' && sender.tab) {
        openPanel(sender.tab);
        reply({ ok: true });
        return;
      }
      // THE DASHBOARD'S OWN ADDRESS FOR A FILE (F-412).
      //
      // A blob: URL has no name. Chrome's PDF viewer takes the Save name from
      // the last segment of the URL it is showing, so previewing or opening a
      // blob offered "5afac5be-24f2-45f6-83c5-faffb0a69279.pdf" however the
      // download link beside it was labelled — which is what he kept seeing
      // after F-386 supposedly fixed this: that fix named the panel's own
      // button and left the viewer alone. An http URL from the dashboard
      // carries a content-disposition, and every route into the file — the
      // preview, "open in a tab", the Save button inside the viewer, the
      // downloads API — takes the name from it.
      if (msg?.type === 'file-url' && fromPanel) {
        try {
          const { base } = await connect();
          const q = new URLSearchParams();
          if (msg.id) q.set('id', String(msg.id));
          if (msg.inline) q.set('inline', '1');
          const which = msg.what === 'letter' ? '/api/cover-letter-pdf' : '/api/apply-resume';
          reply({ ok: true, url: `${base}${which}?${q}` });
        } catch (e) { reply({ ok: false, error: String(e?.message || e) }); }
        return;
      }
      if (msg?.type === 'panel-resume' && msg.id && fromPanel) {
        // The PDF for the panel to show — the same one the form gets, by the
        // application's id; a build starts if none exists (or he asked again).
        try {
          const q = `id=${encodeURIComponent(String(msg.id))}${msg.again ? '&again=1' : ''}`;
          const { buf, filename } = await api(`/api/apply-resume?${q}`, { raw: true, withName: true });
          reply({ ok: true, pdf: base64Of(buf), filename });
        } catch (e) {
          reply({ ok: false, status: e.status || 0, error: String(e?.message || e), phase: e.body?.phase || '', seconds: e.body?.seconds || 0 });
        }
        return;
      }
      if (msg?.type === 'panel-retailor' && msg.id && fromPanel) {
        // His note from the panel: the resume for that posting, written again.
        try {
          const got = await api('/api/panel-retailor', { method: 'POST', body: { id: String(msg.id), request: String(msg.request || '') } });
          reply({ ok: true, ...got });
        } catch (e) {
          reply({ ok: false, status: e.status || 0, error: String(e?.message || e) });
        }
        return;
      }
      if (msg?.type === 'cover-letter' && msg.id && fromPanel) {
        try {
          const got = await api('/api/cover-letter', { method: 'POST', body: { id: String(msg.id), request: String(msg.request || '') } });
          reply({ ok: true, ...got });
        } catch (e) { reply({ ok: false, status: e.status || 0, error: String(e?.message || e) }); }
        return;
      }
      if (msg?.type === 'cover-letter-get' && msg.id && fromPanel) {
        try {
          const got = await api(`/api/cover-letter?id=${encodeURIComponent(String(msg.id))}`);
          reply({ ok: true, ...got });
        } catch (e) { reply({ ok: false, status: e.status || 0, error: String(e?.message || e) }); }
        return;
      }
      // PUT THE FILE IN THE SLOT ON THIS PAGE, from the panel (F-413).
      //
      // He asked to be able to drag the resume out of the panel and into a
      // form's drop zone. Chrome does not carry a file across from an
      // extension page to a web page — a drag between them is a URL, never a
      // File — so this does the same thing in one click instead, and the
      // filename he now sees in the form's own chip is the receipt. The saved
      // copy is correctly named too, so dragging one in from the downloads bar
      // works as well.
      //
      // ONLY INTO AN EMPTY SLOT. A slot already holding a file is his.
      if (msg?.type === 'attach-file' && Number.isInteger(msg.tabId) && fromPanel) {
        try {
          const what = msg.what === 'letter' ? 'letter' : 'resume';
          const st0 = await armedState(msg.tabId);
          const id = msg.id || st0?.id || '';
          const q = `${id ? `id=${encodeURIComponent(id)}&` : ''}pageUrl=${encodeURIComponent(msg.pageUrl || '')}`;
          const route = what === 'letter' ? `/api/cover-letter-pdf?${q}&write=1` : `/api/apply-resume?${q}`;
          const { buf, filename } = await api(route, { raw: true, withName: true });
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: msg.tabId },
            func: (b64, name, kind) => {
              const RESUME = /resume|cv\b|curriculum\s*vitae/i;
              const LETTER = /cover\s*letter|covering\s*letter|letter\s*of\s*(?:interest|motivation)/i;
              const NOT_RESUME = /cover.?letter|portfolio|transcript|writing.?sample|easy apply|auto-?fill|prefill/i;
              const want = kind === 'letter' ? LETTER : RESUME;
              const labelOf = (el) => {
                const bits = [el.getAttribute('aria-label'), el.name, el.id];
                if (el.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) bits.push(l.textContent);
                let up = el.parentElement;
                for (let i = 0; up && i < 4; i += 1, up = up.parentElement) {
                  const l = up.querySelector('label, legend, h2, h3, h4');
                  if (l) bits.push(l.textContent);
                }
                return bits.filter(Boolean).join(' | ');
              };
              const inputs = [...document.querySelectorAll('input[type="file"]')];
              const empty = inputs.filter((el) => !(el.files && el.files.length));
              if (!inputs.length) return { ok: false, why: 'this page has no file slot' };
              if (!empty.length) return { ok: false, why: 'the slot on this page already holds a file — that one is yours to change' };
              const named = empty.filter((el) => want.test(labelOf(el)));
              const pick = named[0]
                || (kind === 'resume' ? empty.find((el) => !NOT_RESUME.test(labelOf(el))) : null)
                || (empty.length === 1 ? empty[0] : null);
              if (!pick) return { ok: false, why: `no empty ${kind === 'letter' ? 'cover-letter' : 'resume'} slot on this page` };
              const bin = atob(b64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
              const dt = new DataTransfer();
              dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
              pick.files = dt.files;
              pick.dispatchEvent(new Event('input', { bubbles: true }));
              pick.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, name, label: labelOf(pick).split(' | ')[0] || 'the file slot' };
            },
            args: [base64Of(buf), filename || (what === 'letter' ? 'Cover Letter.pdf' : 'Resume.pdf'), what],
          });
          reply(r?.result || { ok: false, why: 'the page did not answer' });
        } catch (e) {
          reply({ ok: false, why: String(e?.message || e), status: e?.status || 0 });
        }
        return;
      }
      if (msg?.type === 'fill-text' && Number.isInteger(msg.tabId) && fromPanel) {
        // PUT THE LETTER IN THE FORM'S BOX, if the page has one. A cover-letter
        // box is found by its label, aria-label, placeholder, name or id; the
        // text is set the way a keystroke would be. A file slot is not a box:
        // the panel says so and he attaches it himself. Never a submit.
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: msg.tabId },
            func: (text) => {
              const RE = /cover\s*letter|covering\s*letter|letter\s*of\s*(?:interest|motivation)|motivation\s*letter/i;
              const labelOf = (el) => {
                const bits = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.name, el.id, el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : ''];
                if (el.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) bits.push(l.textContent);
                const wrap = el.closest('label'); if (wrap) bits.push(wrap.textContent);
                let up = el.parentElement; for (let i = 0; up && i < 4; i += 1, up = up.parentElement) { const l = up.querySelector('label, legend, h3, h4'); if (l) bits.push(l.textContent); }
                return bits.filter(Boolean).join(' | ');
              };
              const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')].filter((el) => el.getClientRects().length > 0 && RE.test(labelOf(el)));
              const box = boxes.find((el) => el.tagName === 'TEXTAREA' || el.isContentEditable) || boxes[0];
              if (!box) {
                const file = [...document.querySelectorAll('input[type="file"]')].find((el) => RE.test(labelOf(el)));
                return { found: false, file: !!file };
              }
              if (box.isContentEditable) { box.focus(); box.textContent = text; box.dispatchEvent(new InputEvent('input', { bubbles: true })); return { found: true }; }
              const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              box.focus();
              if (setter) setter.call(box, text); else box.value = text;
              box.dispatchEvent(new Event('input', { bubbles: true }));
              box.dispatchEvent(new Event('change', { bubbles: true }));
              box.blur();
              return { found: true };
            },
            args: [String(msg.text || '')],
          });
          reply({ ok: true, ...(r?.result || { found: false }) });
        } catch (e) { reply({ ok: false, error: String(e?.message || e) }); }
        return;
      }
      if (msg?.type === 'press' && Number.isInteger(msg.tabId) && fromPanel) {
        // The panel's Fill button is the toolbar press for its tab.
        const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
        if (!tab) { reply({ ok: false, error: 'that tab is gone' }); return; }
        press(tab).catch((e) => console.warn(`[jarvis] press on tab ${tab.id} failed: ${String(e?.message || e)}`));
        reply({ ok: true, tabId: tab.id });
        return;
      }
      if (msg?.type === 'posting') {
        // THE PAGE SAID WHAT JOB IT IS. Hand that to the server, which records
        // the posting if the store has never seen it and starts the resume.
        // The id it answers with is this tab's application from now on.
        const st = tabId ? await armedState(tabId) : null;
        const p = api('/api/apply-page', { method: 'POST', body: {
          pageUrl: msg.pageUrl,
          posting: msg.posting,
          // The job this tab is already on, so the same posting seen again on
          // its ATS's own page (company site → Lever) is not recorded twice.
          currentId: st?.id || null,
          extensionVersion: chrome.runtime.getManifest().version,
        } });
        if (tabId) RESOLVING.set(tabId, p.catch(() => null).finally(() => RESOLVING.delete(tabId)));
        const got = await p;
        if (tabId && got?.id) await rememberApplication(tabId, got, msg.pageUrl);
        // Whether HE started the application this page turned out to be. A
        // page read at injection time as "his" can resolve to a different job
        // than the tab was armed for; the page must learn that before it
        // decides whether to press Apply.
        const after = tabId ? ARMED.get(tabId) : null;
        reply({ ok: true, ...got, started: after ? !!after.started : undefined });
        return;
      }

      // Anything else from a subframe waits for the top frame's answer, briefly.
      if (tabId && !topFrame && RESOLVING.has(tabId)) {
        await Promise.race([RESOLVING.get(tabId), new Promise((r) => setTimeout(r, 3000))]);
      }
      const st = tabId ? await armedState(tabId) : null;
      const id = st?.id || undefined;

      if (msg?.type === 'plan') {
        // The page URL decides WHICH application this is. Without it the
        // server falls back to the most recent one, and with two tabs open that
        // attaches the wrong employer's resume.
        const plan = await api('/api/plan', { method: 'POST', body: {
          id,
          fields: msg.fields,
          // Workday's My Experience sections, when the page has them.
          sections: Array.isArray(msg.sections) ? msg.sections : [],
          pageUrl: msg.pageUrl,
          // What the page calls the job, for a form whose URL does not say (F-330).
          heading: msg.heading || '',
          pageTitle: msg.pageTitle || '',
          // The dashboard compares this against what it expects. Loading an
          // unpacked extension does NOT auto-update it, so a stale copy behaves
          // like an old bug and there is no way to tell from the page — which is
          // exactly the position he was in after every fix in this session.
          extensionVersion: chrome.runtime.getManifest().version,
        } });
        // The server may have worked out the job from the PAGE. Keep it on the
        // tab, so the steps that follow — on pages that say nothing — still
        // know. Only a page match: the server also answers with whatever was
        // applied to last when nothing matches (`matched: 'fallback'`), and
        // stamping THAT on the tab would make a guess into a trusted id — the
        // wrong-employer resume by another road.
        if (tabId && plan?.id && !id && plan.matched === 'page') await rememberApplication(tabId, { id: plan.id }, msg.pageUrl);
        reply({ ok: true, plan });
      } else if (msg?.type === 'snapshot') {
        // The form as it stood when Next or Submit was pressed, compared with
        // the plan on the dashboard (answer-log.mjs). A record; never blocks.
        const r = await api('/api/answer-snapshot', { method: 'POST', body: {
          id, pageUrl: msg.pageUrl, heading: msg.heading || '', pageTitle: msg.pageTitle || '',
          stage: msg.stage, button: msg.button, by: msg.by, fields: msg.fields,
        } }).catch(() => null);
        reply({ ok: true, logged: r?.logged ?? 0 });
      } else if (msg?.type === 'filled') {
        // What a run did — every run, whoever started it. The worker cannot
        // wait for a run to end (one can outlast the five minutes Chrome gives
        // a service worker for one event), so the page reports, and this is
        // the one place a run is recorded and shown.
        reply({ ok: true, ...(await report(tabId, msg.result || {}, { id, topFrame })) });
      } else if (msg?.type === 'following') {
        // The page is about to press Apply. A tab that appears in the next
        // few seconds is that Apply's doing, and is followed too.
        if (st) { st.followingAt = Date.now(); await saveArmed(); }
        reply({ ok: true });
      } else if (msg?.type === 'stop') {
        if (tabId) await disarm(tabId, 'he pressed stop on the page');
        reply({ ok: true });
      } else if (msg?.type === 'answer') {
        // A WRITTEN QUESTION, ANSWERED — from the filler when it reaches the
        // box, and from the panel when he clicks one himself.
        //
        // It returns whatever the server has right now: the text if it is
        // written, `writing` if a build started (here or alongside the plan),
        // or the reason it cannot be. The caller decides whether to wait —
        // the filler does, the panel shows a spinner, and neither blocks.
        try {
          const got = await api('/api/answer', { method: 'POST', body: {
            id,
            question: String(msg.question || ''),
            kind: msg.kind || null,
            context: String(msg.context || ''),
            // His note, when he typed one beside the question in the panel.
            request: String(msg.request || ''),
            // "Write it again, differently" — his click, never automatic.
            again: !!msg.again,
            field: msg.field || null,
            // The page actually open, so the server can resolve a tab with no
            // job id and refuse one whose id points at a different posting.
            pageUrl: String(msg.pageUrl || ''),
            pageTitle: String(msg.pageTitle || ''),
            heading: String(msg.heading || ''),
            pageText: String(msg.pageText || '').slice(0, 3000),
          } });
          reply({ ok: true, ...got });
        } catch (e) {
          // 425 is "still writing", which is a state and not a failure; the
          // caller polls. 403 is the refusal, and it carries its own words.
          reply({ ok: false, status: e.status || 0, writing: e.status === 425, error: answerError(e) });
        }
      } else if (msg?.type === 'answer-get') {
        try {
          const q = new URLSearchParams();
          if (msg.key) q.set('key', String(msg.key));
          else { if (id) q.set('id', String(id)); q.set('question', String(msg.question || '')); }
          reply({ ok: true, ...(await api(`/api/answer?${q}`)) });
        } catch (e) {
          reply({ ok: false, status: e.status || 0, writing: e.status === 425, error: answerError(e) });
        }
      } else if (msg?.type === 'choose') {
        // A combobox hides its options until it is opened, so the plan could
        // not consider them. The page reports what it can now see and the
        // server picks with the same matcher that made the plan — which knows
        // that "not a veteran" means "not a PROTECTED veteran", and knows
        // degree levels, dial codes and state abbreviations besides.
        const got = await api('/api/choose', { method: 'POST', body: { want: msg.want, options: msg.options } });
        reply({ ok: true, index: got?.index ?? -1, value: got?.value ?? null });
      } else if (msg?.type === 'current') {
        reply({ ok: true, current: await api('/api/apply-current') });
      } else if (msg?.type === 'resume') {
        // The tab's id first, the page second: the server builds for the id
        // when it has one and only then falls back to matching the page.
        const q = `${id ? `id=${encodeURIComponent(id)}&` : ''}pageUrl=${encodeURIComponent(msg.pageUrl || '')}`
          + `&heading=${encodeURIComponent(msg.heading || '')}&pageTitle=${encodeURIComponent(msg.pageTitle || '')}`;
        // THE NAME COMES WITH THE FILE (F-409). The server names the PDF for
        // the posting it was written for — "Alex Rivera - Agility Robotics -
        // Mechanical Engineer.pdf" — and that name is his receipt for what
        // actually went onto the form, so it travels with the bytes instead of
        // being invented again on the page.
        const { buf, filename } = await api(`/api/apply-resume?${q}`, { raw: true, withName: true });
        // A structured clone cannot carry an ArrayBuffer through sendMessage in
        // every Chrome version, so it goes across as a plain array of bytes and
        // is rebuilt into a File on the other side.
        reply({ ok: true, bytes: Array.from(new Uint8Array(buf)), filename });
      } else if (msg?.type === 'letter') {
        // THE COVER LETTER AS A FILE, for a form with a slot for one (F-410).
        // `write=1` says the page has asked, so the server writes one if none
        // exists and answers 425 while it does — the same shape as the resume,
        // and the filler waits the same way.
        const q = `${id ? `id=${encodeURIComponent(id)}&` : ''}pageUrl=${encodeURIComponent(msg.pageUrl || '')}`
          + `&heading=${encodeURIComponent(msg.heading || '')}&pageTitle=${encodeURIComponent(msg.pageTitle || '')}&write=1`;
        const { buf, filename } = await api(`/api/cover-letter-pdf?${q}`, { raw: true, withName: true });
        reply({ ok: true, bytes: Array.from(new Uint8Array(buf)), filename });
      } else if (msg?.type === 'runaway') {
        // The page's own watcher hit its ceiling. Stand the tab down here too,
        // so a navigation does not quietly start it over.
        if (tabId) await disarm(tabId, 'the page kept changing — too many follow-along runs');
        badge(tabId, '!', '#b42318');
        title(tabId, 'Jarvis stopped: this page kept changing. Click to start again.');
        reply({ ok: true });
      } else {
        reply({ ok: false, error: `unknown message "${msg?.type}"` });
      }
    } catch (e) {
      reply({ ok: false, error: String(e?.message || e), status: e?.status || 0 });
    }
  })();
  return true;  // keep the channel open for the async reply
});

/**
 * Inject the scripts into every frame of a tab.
 *
 * `ctx` is what the page needs to know about THIS run and cannot find out for
 * itself: whether the tab is armed (install the watcher), whether anyone
 * clicked (a run nobody clicked for never writes over what is on the form),
 * whether he started this application, and which one it is. Files cannot take
 * arguments, so a one-line function goes in first and sets it on the page.
 */
async function inject(tabId, ctx = {}) {
  note(`tab ${tabId}: injecting (${ctx.auto ? 'follow-along' : 'press'})`);
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (c) => { globalThis.__jarvisRun = c; },
    args: [ctx],
  }).catch((e) => note(`tab ${tabId}: context injection failed — ${String(e?.message || e).slice(0, 160)}`));

  // netwatch.js goes into the PAGE's world, not ours. A content script has its
  // own fetch and its own XMLHttpRequest, so patching those here would watch
  // nothing — the application uses the page's. Extension-privileged injection
  // also gets past the page's own CSP, which Workday and Ashby both use to
  // forbid inline script. It is best-effort: a page that refuses it still fills.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['netwatch.js'],
    world: 'MAIN',
  }).catch(() => {});

  note(`tab ${tabId}: scripts going in`);
  // A NAVIGATION UNDER THE INJECTION CAN LEAVE THIS PROMISE UNSETTLED FOREVER
  // (F-380). Measured on Amazon: the press followed Apply, the page became
  // /applicant/jobs/…/summary, and executeScript neither resolved nor
  // rejected — so the run stayed in RUNNING, every follow-along after it was
  // swallowed as `pending`, and the tab did nothing at all. The page reports
  // its own result by message, so the worker never actually needs this promise
  // to be correct; it only needs to stop waiting. The cap is generous, because
  // a real run legitimately takes minutes while a resume is written.
  const results = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // Order matters: ats.js and discover.js define globals content.js uses.
      files: ['ats.js', 'report.js', 'discover.js', 'content.js'],
    }),
    // `self.__jarvisInjectCap` lets a test prove this without waiting minutes.
    new Promise((resolve) => setTimeout(() => resolve(null), self.__jarvisInjectCap || INJECT_CAP_MS)),
  ]);
  if (!results) {
    note(`tab ${tabId}: the injection never came back after ${Math.round((self.__jarvisInjectCap || INJECT_CAP_MS) / 1000)}s — the page moved under it; letting go so the tab can be followed again`);
    return [];
  }
  note(`tab ${tabId}: scripts returned from ${results.length} frame(s)`);
  return results.map((r) => r.result).filter(Boolean);
}

/**
 * TELL THE DASHBOARD WHAT HAPPENED, and put the outcome on the badge.
 *
 * Until this existed the extension could ask for a plan, a resume and an
 * option, and had no way to say what it did with them. So the flow he actually
 * uses — click Jarvis on a form — left NO record anywhere: nothing in Review &
 * Send, no list of what was filled, no list of what it could not answer. All of
 * it existed in an on-page panel and died with the tab.
 *
 * ADDED UP ACROSS THE TAB. An application is many runs now — one per page,
 * one per step he finished by hand — and the last of them is nearly always a
 * no-op on the Review or thank-you page. Reporting each run on its own made
 * Review & Send say "filled 0" about an application with fourteen answers on
 * it. So the tab keeps a running total and that is what is sent, every time.
 *
 * Best-effort on purpose: a dashboard that is not running must never turn a
 * filled form into an error; the fill already happened either way.
 */
async function report(tabId, done, { id = undefined, topFrame = true } = {}) {
  if (!done) return { recorded: false };
  // A FRAME THAT DID NOTHING SAYS NOTHING FOR THE TAB. Every Eightfold page
  // carries an invisible reCAPTCHA iframe; it is injected like any frame,
  // finds no fields, and answers first because it is tiny. Its report used
  // to claim the tab's page URL (a recaptcha.net anchor) and its stop reason
  // ("this page is not a multi-step application") before the real page had
  // pressed Apply — measured on Lam and Micron. A subframe's report counts
  // only when it did work or saw something decisive; a widget's never does.
  const widget = !!ATS?.isWidget?.(done.pageUrl || done.frame || '');
  const decisive = done.error || done.postingGone || done.submitted || done.signInRequired || done.alreadyApplied;
  const didWork = done.filled > 0 || done.checked > 0 || done.uploaded;
  if (widget) return { recorded: false, why: 'a widget frame' };
  if (!topFrame && !didWork && !decisive) return { recorded: false, why: 'a frame that did nothing' };
  const st = tabId ? await armedState(tabId) : null;

  // THE APPLICATION WAS SENT — by him. Stand down before anything else, so
  // the "thank you" page is the last thing this tab fills nothing on.
  if (done.submitted && tabId) {
    await disarm(tabId, `the page says "${done.submitted}"`);
    badge(tabId, '✓', '#1a7f37');
    title(tabId, 'Application sent — Jarvis has stopped following this tab');
  }

  const worked = done.filled > 0 || done.checked > 0 || done.uploaded;
  const acc = st?.acc || emptyAcc();
  if (st) {
    // A WALK STARTED OVER REPLACES THE LAST ONE (F-361). The total is the
    // tab's, across the runs one application takes — but his press on the
    // page an earlier walk began on is a new walk of the same form, and
    // summing it made Becton Dickinson's record read "102 filled, 6 ticked"
    // after three walks of a 34-field form. A run nobody pressed for still
    // adds: it is the same walk carrying on after a navigation.
    if (!done.auto && acc.startedOn && done.startedOn && walkKey(done.startedOn) === walkKey(acc.startedOn)) {
      // …BUT THE RESUME IS STILL ON THE FORM (F-407). Walking the same form
      // again does not un-attach the file: the counts are of what THIS walk
      // did and start at zero, while "the resume is attached" is a fact about
      // the page. Measured on a Physical Intelligence application: the first
      // press logged "resume ATTACHED", the second press reset the total, the
      // second pass had nothing to upload because the file was already there,
      // and the tab's record then read `uploaded: false` over a form holding
      // his resume — the panel telling him the opposite of what the page shows.
      const attached = acc.uploaded;
      Object.assign(acc, emptyAcc());
      acc.uploaded = attached;
    }
    if (!acc.startedOn && done.startedOn) acc.startedOn = done.startedOn;
    acc.filled += done.filled || 0;
    acc.checked += done.checked || 0;
    acc.skipped += done.skipped || 0;
    acc.uploaded = acc.uploaded || !!done.uploaded;
    acc.reachedReview = acc.reachedReview || !!done.reachedReview || /last step before Submit/i.test(done.stoppedBecause || '');
    // WHAT HAS SINCE BEEN ANSWERED LEAVES THE LIST (F-399).
    //
    // The tab's total carries "left for you" across every run of a walk and
    // never took anything off it. Measured on Agility Robotics: a second press
    // filled Degree and Veteran Status — the planner's own reply said "already
    // set to Bachelor's Degree" — and the panel went on listing both as
    // `nothing matched`, over a form that plainly held them. A list of things
    // to do that keeps finished work on it is not a list he can use.
    for (const label of done.answered || []) {
      if (!label) continue;
      acc.unanswered = acc.unanswered.filter((u) => !String(u).includes(label));
    }
    for (const u of done.unanswered || []) if (!acc.unanswered.includes(u) && acc.unanswered.length < 60) acc.unanswered.push(u);
    // A wall is a verdict too: "sign in here" replaces "followed Apply" on
    // the record, so the dashboard says where the application stands (F-365).
    if (worked || done.error || done.postingGone || done.signInRequired || done.blocked || !acc.stoppedBecause) acc.stoppedBecause = done.stoppedBecause || acc.stoppedBecause;
    // The page the application lives on, never an identity provider's.
    if (done.pageUrl && !ATS?.isIdp?.(done.pageUrl) && !ATS?.isWidget?.(done.pageUrl) && (worked || !acc.pageUrl)) acc.pageUrl = done.pageUrl;
    if (worked) st.lastUsefulAt = Date.now();
    // A PAGE THAT KEEPS MOVING AND KEEPS ANSWERING NOTHING IS DONE WITH US
    // (F-379). Measured on the finished Applied Materials form: its autosave
    // ("Changes saved a minute ago") mutates the DOM, every mutation during a
    // run sets `pending`, the worker follows again, the fresh injection resets
    // the page's own runaway counter, and the loop only ends at the 40-run
    // per-tab cap — each turn costing a plan request on a form that is
    // complete. Three quiet follow-along runs on one URL and the tab holds:
    // still armed, still watching, but nothing more until the page actually
    // goes somewhere.
    // The page AND the step on it (F-379): an SPA whose steps share one URL
    // must not be held after three quiet runs on its first step.
    const here = done.where || done.pageUrl || '';
    // Only a run that actually WALKED A FORM counts as quiet. A run still
    // waiting for a late form to paint (F-360) must keep following, which is
    // the whole point of an armed tab.
    if (done.auto && !worked && done.sawForm) {
      st.quiet = (st.quietAt === here ? (st.quiet || 0) : 0) + 1;
      st.quietAt = here;
      // The gate in follow() can only see the tab's URL, so the URL is what it
      // compares; the step is what the COUNTER is keyed on, so a wizard whose
      // steps share one URL counts each step separately.
      if (st.quiet >= QUIET_RUNS_BEFORE_HOLD) { st.holdAt = here; st.holdUrl = done.pageUrl || ''; }
    } else if (worked) {
      st.quiet = 0; st.quietAt = here; st.holdAt = null; st.holdUrl = null;
    }
    st.acc = acc;
    await saveArmed();
  }

  if (tabId && !done.submitted) {
    if (st) paint(tabId);
    else if (worked) badge(tabId, String((done.filled || 0) + (done.checked || 0)), '#1a7f37');
    else if (!done.auto) badge(tabId, '0', '#888888');
    if (done.error) badge(tabId, '!', '#b42318');
    if (done.signInRequired) {
      badge(tabId, 'you', '#d29922');
      title(tabId, 'Sign in — Jarvis continues by itself once you are in. Stop from the panel or the icon\'s menu.');
    }
  }

  // A run that found nothing and changed nothing has nothing to record —
  // unless it saw something worth keeping: an error, a dead posting, a sent
  // application.
  if (done.auto && !worked && !done.error && !done.postingGone && !done.submitted && !(done.unanswered || []).length) {
    return { recorded: false, why: 'nothing to record' };
  }

  let page = null;
  if (tabId) page = await chrome.tabs.get(tabId).catch(() => null);
  const body = st ? acc : {
    filled: done.filled || 0, checked: done.checked || 0, skipped: done.skipped || 0,
    uploaded: !!done.uploaded, reachedReview: !!done.reachedReview, unanswered: done.unanswered || [],
    stoppedBecause: done.stoppedBecause || '', pageUrl: '',
  };
  try {
    return await api('/api/filled', { method: 'POST', body: {
      id,
      pageUrl: body.pageUrl || done.pageUrl || page?.url || done.frame || '',
      // The page THIS run was on, apart from the tab's total: the server
      // only retires a posting on a verdict from the posting's own page.
      seenOn: done.pageUrl || page?.url || done.frame || '',
      filled: body.filled,
      checked: body.checked,
      // Fields the planner deliberately left alone, told apart from ones it
      // could not answer. The server has stored this count all along.
      skipped: body.skipped,
      uploaded: body.uploaded,
      reachedReview: body.reachedReview,
      unanswered: body.unanswered,
      review: done.review || [],
      // WHY IT STOPPED, which is the most diagnostic thing a run produces:
      // the form's own error text and any background request that failed.
      // Without it Review & Send says "filled 12" and gives no hint that the
      // page refused to advance — the difference between a record and a
      // usable one.
      stoppedBecause: body.stoppedBecause,
      // The page said it was gone, as seen in HIS browser — the only place
      // that verdict is trustworthy (F-250).
      postingGone: done.postingGone || '',
      // The page said he has already applied — worth the same trust.
      alreadyApplied: !!done.alreadyApplied,
      // HE PRESSED SUBMIT AND THE PAGE CONFIRMED IT.
      //
      // This tab already knows: `report()` disarms on it, paints the green ✓
      // and retitles the tab "Application sent". It then dropped the fact on
      // the floor, and the store went on saying he had applied to five jobs
      // while 96 forms had been filled (F-446). His words: "i press submit but
      // jarvis doesnt know … it doesnt require me to mark, coz i almost never
      // press submit in the terminal."
      //
      // The page's own sentence travels with it, so the tracker's claim can be
      // checked against what was actually on screen.
      submitted: String(done.submitted || ''),
    } });
  } catch { return { recorded: false }; }
}

// One run per tab at a time, in worker memory. A navigation event that arrives
// mid-run is not lost: it sets `pending`, and the run goes once more when it
// ends. Entries expire, because a page that navigated away mid-run never
// resolves the injection that started it.
const RUNNING = new Map();   // tabId -> { since, pending }
const RUN_EXPIRY_MS = 6 * 60 * 1000;

/**
 * Inject and run on one tab.
 *
 * Named, and hung on `self`, so it can be driven from outside — a Playwright
 * context can load this extension for real and call `self.runOnTab(id)` to
 * exercise the SHIPPED worker, content scripts and messaging together. A
 * listener body cannot be called that way, and "the whole extension, as
 * published" was the one thing nothing could test.
 *
 * `auto` is true for a run nobody clicked for — a navigation of an armed tab.
 * The page is told, and never writes over a value already on the form. The
 * run's RESULT reaches this worker through a `filled` message from the page,
 * not through the injection's return value: a run can outlast the five
 * minutes Chrome allows one event here. The return value is kept for the
 * harnesses.
 */
async function runOnTab(tabId, { auto = false, reset = false } = {}) {
  if (!tabId) return null;
  const running = RUNNING.get(tabId);
  if (running && Date.now() - running.since < RUN_EXPIRY_MS) { running.pending = true; return null; }
  RUNNING.set(tabId, { since: Date.now(), pending: false });

  const st = await armedState(tabId);
  badge(tabId, '…', '#888888');
  // Held for the whole run so the version alarm cannot reload the worker out
  // from under a half-filled form.
  BUSY += 1;
  try {
    const summaries = await inject(tabId, {
      armed: !!st, auto, reset, started: !!st?.started,
      id: st?.id || null, company: st?.company || null, title: st?.title || null,
      loadId: await loadId(),
    });
    note(`tab ${tabId}: ran, ${summaries.length} frame(s) answered${summaries[0]?.error ? ` — ${summaries[0].error}` : ''}`);
    if (st) {
      st.runs += 1;
      st.lastRunAt = Date.now();
      await saveArmed();
    }
    return summaries;
  } catch (e) {
    note(`tab ${tabId}: inject failed — ${String(e?.message || e).slice(0, 200)}`);
    // A page that navigated away under the injection is not an error; it is
    // the next page, and the next event follows it.
    if (/frame was removed|navigated|context invalidated|No tab with id/i.test(String(e?.message || e))) {
      return [];
    }
    badge(tabId, '!', '#b42318');
    console.error('[jarvis] could not inject the filler:', e);
    return [{ error: String(e?.message || e) }];
  } finally {
    BUSY -= 1;
    const again = RUNNING.get(tabId)?.pending;
    RUNNING.delete(tabId);
    if (again && ARMED.has(tabId)) {
      // The page moved while this run was on it. Once more, through the same
      // gate every navigation goes through.
      follow(tabId, 'the page moved during the run');
    }
  }
}

/**
 * A page of an armed tab finished loading. Follow it.
 *
 * Debounced per tab, because one navigation is several events — `onUpdated`
 * with status complete for the top frame, `webNavigation.onCompleted` for it
 * and for each iframe, `onHistoryStateUpdated` for a pushState — and each of
 * them would otherwise start a run. One run, once the burst is over.
 */
const FOLLOW_DEBOUNCE_MS = 900;
const followTimers = new Map();

async function follow(tabId, why, url = '') {
  const st = await armedState(tabId);
  if (!st) return;
  // A frame load or a pending re-run arrives without a URL. Ask, so the
  // identity-provider rule below holds for those too — a Google sign-in page
  // loads iframes, and "a frame loaded" must not be the way in.
  if (!url) url = (await chrome.tabs?.get?.(tabId).catch(() => null))?.url || '';
  if (Date.now() - (st.lastUsefulAt || st.at) > ARMED_IDLE_MS) {
    // He armed it and walked away. Whatever this tab is showing now is not
    // the application he armed it for.
    await disarm(tabId, 'nothing happened on this tab for a long while');
    return;
  }
  // HELD AT A PAGE THAT HAD NOTHING LEFT TO SAY (F-379). A real navigation
  // clears it, because the URL is part of the hold.
  if (st.holdUrl && url && st.holdUrl === url) {
    note(`tab ${tabId}: ${why} — this page answered nothing three times running; waiting for it to go somewhere`);
    return;
  }
  if (st.runs >= MAX_AUTO_RUNS_PER_TAB) {
    await disarm(tabId, `${MAX_AUTO_RUNS_PER_TAB} runs on this tab — click again to start over`);
    badge(tabId, '!', '#b42318');
    title(tabId, 'Jarvis stopped: this tab kept changing. Click to start again.');
    return;
  }
  // AN IDENTITY PROVIDER IS NEVER READ. Signing in is his; the page has
  // nothing to fill; and a filler that so much as looks at a Google sign-in
  // page is one that should not exist. The tab stays armed, and the page he
  // comes back to is followed.
  if (url && ATS?.isIdp?.(url)) {
    note(`tab ${tabId}: ${why} — an identity provider, waiting for him`);
    paint(tabId);
    title(tabId, 'Waiting for you to sign in — Jarvis continues on the page you come back to');
    return;
  }
  // Said in the log at the moment the event arrives, so a follow that never
  // fires can be told from one that fired and found nothing (F-365).
  note(`tab ${tabId}: ${why} — will follow in ${FOLLOW_DEBOUNCE_MS}ms`);
  clearTimeout(followTimers.get(tabId));
  followTimers.set(tabId, setTimeout(async () => {
    followTimers.delete(tabId);
    const now = ARMED.get(tabId);
    if (!now) return;
    if (await reloadIfStale()) return;   // the worker is about to restart; the next event finds the new copy
    // A tab the dashboard opened: its first page is filled as if he had
    // pressed the button on it, because he did — on the dashboard.
    const press = !!now.pressNext;
    if (press) { now.pressNext = false; await saveArmed(); }
    note(`tab ${tabId}: ${why} — ${press ? 'his press, from the dashboard' : 'following'}`);
    runOnTab(tabId, { auto: !press, reset: press });
  }, FOLLOW_DEBOUNCE_MS));
}

/**
 * A DIFFERENT POSTING PASTED INTO THE ARMED TAB.
 *
 * The tab carries its application across pages that say nothing about which
 * job they belong to. That is right for a Workday form and wrong for a
 * Workday posting HE navigated to: with the old id still on the tab, its form
 * would get the previous employer's resume. Two URLs with different
 * requisition ids are two jobs, so the application is dropped — the tab stays
 * armed and the new page is read afresh. A URL with no id proves nothing and
 * drops nothing.
 */
async function noticeNavigation(tabId, url) {
  const st = await armedState(tabId);
  if (!st || !url || !ATS) return;
  const now = ATS.reqToken(url);
  // Only tokens of the same KIND can disagree: SmartRecruiters' posting id
  // and its apply form's publication uuid name one job two ways (F-338).
  const kind = (t) => String(t).split(':')[0];
  if (now && st.token && kind(now) === kind(st.token) && now !== st.token) {
    console.log(`[jarvis] tab ${tabId}: a different posting (${now}) — forgetting ${st.company || st.id}`);
    Object.assign(st, { id: null, company: null, title: null, token: null, started: false, acc: emptyAcc() });
    await saveArmed();
  }
  paint(tabId);
}

// A full page load in an armed tab.
chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  follow(tabId, 'the page loaded', tab?.url || '');
});

// The moment a new document is committed in the top frame: Chrome has just
// cleared the badge, and the URL is known. Paint, and check the posting id.
/**
 * TELL THE PANEL SOMETHING MOVED (F-385).
 *
 * The panel refreshed on `tabs.onActivated` and on `onUpdated{status:complete}`
 * and nothing else, so on an ATS that routes in the page — most of them — it
 * asked once, before the posting had rendered, showed "Not a posting in your
 * store", and then sat there until something else happened to wake it. His
 * words: "it likes to say its not a posting but eventually it does recognize".
 * A route change is the earliest honest signal that the page is now something
 * different, so it is passed straight through.
 */
function nudgePanel(tabId) {
  try {
    const p = chrome.runtime.sendMessage({ type: 'panel-refresh', tabId });
    if (p?.catch) p.catch(() => { /* no panel open */ });
  } catch { /* no panel open */ }
}

chrome.webNavigation?.onCommitted?.addListener((d) => {
  if (d.frameId !== 0) return;
  noticeNavigation(d.tabId, d.url);
});

// A frame load, a pushState route change, a hash-router change in an armed
// tab. Workday moves between "Apply Manually" and step one with pushState;
// Greenhouse's embedded form lives in an iframe that loads after the page
// does; some boards route on the hash. `tabs.onUpdated` sees none of them.
chrome.webNavigation?.onHistoryStateUpdated?.addListener((d) => { noticeNavigation(d.tabId, d.url); nudgePanel(d.tabId); follow(d.tabId, 'the page changed route', d.url); });
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener((d) => follow(d.tabId, 'the page changed its hash', d.url));
chrome.webNavigation?.onCompleted?.addListener((d) => { if (d.frameId !== 0) follow(d.tabId, 'a frame loaded', ''); });

/**
 * Apply links that open a NEW tab.
 *
 * The new tab is the application; the armed one is left behind on the
 * posting. It inherits the arming, the application and "he started this", so
 * the form it opens on is filled with the right resume and no second press.
 * Only when the page's own Apply press opened it — the page says `following`
 * just before clicking — because a link he opened himself from an armed tab
 * is his browsing, not the application.
 */
async function inherit(newTabId, openerTabId) {
  if (!newTabId || !openerTabId || newTabId === openerTabId) return;
  const parent = await armedState(openerTabId);
  if (!parent) return;
  if (Date.now() - (parent.followingAt || 0) > FOLLOWING_WINDOW_MS) return;
  if (ARMED.has(newTabId)) return;
  await arm(newTabId, { id: parent.id, company: parent.company, title: parent.title, token: parent.token, started: true });
  console.log(`[jarvis] tab ${newTabId} opened by Apply from tab ${openerTabId} — following it too`);
}

chrome.tabs?.onCreated?.addListener((tab) => inherit(tab?.id, tab?.openerTabId));
chrome.webNavigation?.onCreatedNavigationTarget?.addListener((d) => inherit(d.tabId, d.sourceTabId));

chrome.tabs?.onRemoved?.addListener((tabId) => { disarm(tabId); followTimers.delete(tabId); RUNNING.delete(tabId); });

/**
 * THE TAB CHANGED ID UNDER US. Chrome swaps a prerendered page in as a NEW
 * tab id (`tabs.onReplaced`); measured live on KLA, "Apply Manually" took the
 * armed tab 818296341 to 818296352 and the arming stayed on a tab that no
 * longer existed. The state moves with the page; nothing else changes.
 */
chrome.tabs?.onReplaced?.addListener(async (addedTabId, removedTabId) => {
  await loadArmed();
  const st = ARMED.get(removedTabId);
  if (!st) return;
  ARMED.delete(removedTabId);
  ARMED.set(addedTabId, st);
  followTimers.delete(removedTabId);
  RUNNING.delete(removedTabId);
  await saveArmed();
  await chrome.tabs?.update?.(addedTabId, { autoDiscardable: false }).catch(() => {});
  note(`tab ${removedTabId} became tab ${addedTabId} — still following`);
  paint(addedTabId);
});

// Tab ids do not survive a browser restart; nothing in the list can be a tab.
chrome.runtime?.onStartup?.addListener(async () => {
  ARMED.clear();
  armedLoaded = Promise.resolve();
  await saveArmed();
});

/**
 * Is Chrome running an older copy of this extension than the dashboard expects?
 *
 * Chrome does not auto-update an unpacked extension, so every fix in the repo
 * stays invisible until someone opens chrome://extensions and presses reload.
 * That is how a session's worth of fixes sat undeployed while the browser
 * reproduced bugs that had been fixed hours earlier.
 *
 * `chrome.runtime.reload()` re-reads an unpacked extension from disk, so it can
 * do that itself. It cannot be done mid-run — reloading tears down this worker —
 * so it happens BEFORE injecting anything, and the click that triggered it is
 * spent on the reload. One click lost, once, instead of a manual reload forever.
 *
 * Never throws and never blocks: if the dashboard is unreachable or says nothing
 * about versions, the run proceeds on whatever is loaded.
 */
/**
 * How many fills are running, so a version check never tears down mid-form.
 *
 * In memory on purpose: if the worker has been evicted there is no run to
 * protect, and a count that survived eviction would block reloads forever.
 * A count rather than a flag, because armed tabs can run concurrently.
 */
let BUSY = 0;

async function reloadIfStale() {
  try {
    if (BUSY > 0) return false;
    const { base, token } = await connect();
    const r = await fetch(`${base}/api/extension`, { headers: { 'x-jarvis-token': token } });
    if (!r.ok) return false;
    const { expected } = await r.json();
    const mine = chrome.runtime.getManifest().version;
    if (!expected || expected === mine) return false;

    const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const [a, b] = [parts(mine), parts(expected)];
    let older = false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if ((a[i] || 0) < (b[i] || 0)) { older = true; break; }
      if ((a[i] || 0) > (b[i] || 0)) break;
    }
    if (!older) {
      // Caught up. Forget any earlier failed attempt so a future gap is retried.
      await chrome.storage.local.remove('reloadedFor').catch(() => {});
      return false;
    }

    // DO NOT RELOAD IN A LOOP.
    //
    // `chrome.runtime.reload()` re-reads the directory. If the files on disk are
    // themselves behind what the dashboard expects — someone bumped
    // EXPECTED_EXTENSION without saving the manifest — reloading changes
    // nothing, and on a timer that becomes an extension that restarts itself
    // every few minutes forever. Remember what we already tried.
    const { reloadedFor } = await chrome.storage.local.get('reloadedFor').catch(() => ({}));
    if (reloadedFor === expected) {
      console.warn(`[jarvis] still ${mine} after reloading for ${expected} — the files on disk are behind the dashboard. Not reloading again.`);
      return false;
    }
    await chrome.storage.local.set({ reloadedFor: expected }).catch(() => {});

    console.log(`[jarvis] loaded ${mine}, dashboard expects ${expected} — reloading from disk`);
    // The armed list is in local storage and survives the reload; the new
    // worker's first event on any of those tabs picks the walk back up.
    chrome.runtime.reload();
    return true;
  } catch { return false; }
}

/**
 * CHECK FOR A NEW VERSION WITHOUT WAITING TO BE CLICKED.
 *
 * `reloadIfStale` was only ever called from the toolbar handler, so the copy
 * Chrome runs could only be refreshed by someone who was already clicking. That
 * is precisely the wrong condition: measured on his own profile, the extension
 * sat at 1.0.0 for two days while the repo reached 1.25.0, because the button
 * he was pressing belonged to a different extension entirely.
 *
 * An alarm asks the same question on a timer. Five minutes is far more often
 * than the answer changes, and the check is one cheap request to localhost that
 * does nothing at all when the versions agree.
 *
 * This cannot fix the CURRENT stale copy — 1.0.0 has no alarm in it. It takes
 * one manual reload to land this code, and after that never again.
 */
const VERSION_ALARM = 'jarvis-version-check';

function scheduleVersionCheck() {
  try {
    chrome.alarms.create(VERSION_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
  } catch { /* no alarms permission — the click path still works */ }
}

// Optional-chained throughout: this file is imported directly by
// background.test.mjs against a hand-built `chrome` stub, and a top-level
// listener that assumes an API exists takes the whole test file down with it
// rather than failing the one test that cares.
chrome.runtime?.onInstalled?.addListener(scheduleVersionCheck);
chrome.runtime?.onStartup?.addListener(scheduleVersionCheck);
scheduleVersionCheck();

// `async` and RETURNING the promise, so a test can await one tick of the timer
// instead of racing it. Chrome ignores the return value.
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== VERSION_ALARM) return false;
  // Never mid-fill: reloading tears down this worker and the content scripts
  // it is talking to, which would abandon a half-filled application.
  if (BUSY > 0) return false;
  return reloadIfStale();
});

// The icon's right-click menu: the one way to stop that works on any page,
// including one where the panel cannot be drawn.
const STOP_MENU = 'jarvis-stop-following';
const PANEL_MENU = 'jarvis-open-panel';
try {
  chrome.contextMenus?.create?.({ id: STOP_MENU, title: 'Stop following this tab', contexts: ['action'] }, () => { void chrome.runtime?.lastError; });
  chrome.contextMenus?.create?.({ id: PANEL_MENU, title: 'Open the Jarvis panel', contexts: ['action'] }, () => { void chrome.runtime?.lastError; });
} catch { /* no contextMenus permission — the panel's stop still works */ }
chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === STOP_MENU && tab?.id) disarm(tab.id, 'he chose Stop from the menu');
  if (info.menuItemId === PANEL_MENU && tab?.id) openPanel(tab);
});

/**
 * THE DASHBOARD CAN OPEN A TAB THAT IS ALREADY ARMED.
 *
 * "⚡ Apply now" used to open the posting through chrome.exe and leave the
 * press to him. The dashboard page is the one origin allowed to message this
 * extension (manifest `externally_connectable`), so it asks the worker to
 * open the tab instead — armed, marked as his press, and carrying the job id
 * it already knows. Nothing else can send this: Chrome refuses the message
 * from any origin the manifest does not list, and the origin is checked
 * again here because a manifest is a file someone can edit.
 */
const DASHBOARD_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1):4300(?:\/|$)/;

chrome.runtime?.onMessageExternal?.addListener((msg, sender, reply) => {
  (async () => {
    const from = String(sender?.origin || sender?.url || '');
    if (!DASHBOARD_ORIGIN_RE.test(from)) { reply({ ok: false, error: 'not the dashboard' }); return; }
    if (msg?.type === 'ping') { reply({ ok: true, version: chrome.runtime.getManifest().version }); return; }
    if (msg?.type === 'status') {
      await loadArmed();
      reply({
        ok: true, version: chrome.runtime.getManifest().version,
        allSites: await hasAllSites(),
        armed: Object.fromEntries(ARMED), running: [...RUNNING.keys()], recent: RECENT.slice(-15),
      });
      return;
    }
    if (msg?.type === 'arm' && Number.isInteger(msg.tabId)) {
      // "Follow the tab I am looking at" — the dashboard knows no tab ids, but
      // a harness driving a real Chrome does, and this is how it presses.
      // The token comes from the tab's URL, the same as a press: without it
      // a different posting pasted into the tab is not noticed (measured live
      // — a dead Form Energy page read no posting, so no token, so the next
      // posting in that tab inherited "he started this" and had Apply pressed).
      const tabUrl = (await chrome.tabs.get(msg.tabId).catch(() => null))?.url || '';
      await arm(msg.tabId, { started: true, id: msg.id ? String(msg.id) : null, company: msg.company || null, title: msg.title || null, token: ATS?.reqToken(tabUrl) || null });
      runOnTab(msg.tabId, { auto: false, reset: true });
      reply({ ok: true });
      return;
    }
    if (msg?.type === 'probe' && Number.isInteger(msg.tabId)) {
      // Which injection form hangs in THIS Chrome. Each is raced against a
      // clock, because the whole point is that one of them never settles.
      const race = (label, p) => Promise.race([
        p.then((r) => `${label}: ok ${Array.isArray(r) ? r.length + ' frame(s)' : ''}`).catch((e) => `${label}: threw ${String(e?.message || e).slice(0, 120)}`),
        new Promise((r) => setTimeout(() => r(`${label}: HUNG (4s)`), 4000)),
      ]);
      const t = msg.tabId;
      const out = [];
      out.push(await race('func top-frame', chrome.scripting.executeScript({ target: { tabId: t }, func: () => 1 })));
      out.push(await race('func allFrames', chrome.scripting.executeScript({ target: { tabId: t, allFrames: true }, func: () => 1 })));
      out.push(await race('func+args allFrames', chrome.scripting.executeScript({ target: { tabId: t, allFrames: true }, func: (c) => { globalThis.__jarvisProbe = c; return 1; }, args: [{ a: 1 }] })));
      out.push(await race('files ats top-frame', chrome.scripting.executeScript({ target: { tabId: t }, files: ['ats.js'] })));
      out.push(await race('netwatch MAIN allFrames', chrome.scripting.executeScript({ target: { tabId: t, allFrames: true }, files: ['netwatch.js'], world: 'MAIN' })));
      reply({ ok: true, out });
      return;
    }
    if (msg?.type === 'disarm' && Number.isInteger(msg.tabId)) {
      await disarm(msg.tabId, 'the dashboard asked');
      reply({ ok: true });
      return;
    }
    if (msg?.type === 'reload') {
      // The dashboard's "reload it at chrome://extensions" line, as a button.
      reply({ ok: true });
      setTimeout(() => chrome.runtime.reload(), 100);
      return;
    }
    // THE POSTING IS ALREADY OPEN: press on that tab, do not open a second.
    // `open` reuses a tab showing the URL (and leaves whichever tab he is on
    // alone); `press` acts only on a tab that is already showing it, and says
    // so when none is. This is also how a harness in his own Chrome drives
    // the extension without a toolbar click.
    const showing = async (url) => {
      const want = String(url || '').replace(/#.*$/, '');
      if (!/^https?:/i.test(want)) return null;
      // A sandbox without tabs.query throws synchronously; that is "no tab".
      const tabs = await Promise.resolve().then(() => chrome.tabs.query({})).catch(() => []);
      return (tabs || []).find((t) => String(t.url || '').replace(/#.*$/, '') === want)
        || tabs.find((t) => String(t.url || '').startsWith(want)) || null;
    };
    if (msg?.type === 'press') {
      const tab = await showing(msg.url);
      if (!tab) { reply({ ok: false, error: 'no tab is showing that page' }); return; }
      // The press is the whole fill; the caller wants to know it started.
      press(tab).catch((e) => console.warn(`[jarvis] press on tab ${tab.id} failed: ${String(e?.message || e)}`));
      reply({ ok: true, tabId: tab.id, reused: true });
      return;
    }
    if (msg?.type === 'open') {
      const url = String(msg.url || '');
      if (!/^https?:/i.test(url)) { reply({ ok: false, error: 'not a page' }); return; }
      const already = await showing(url);
      if (already) {
        await arm(already.id, {
          started: true,
          id: msg.id ? String(msg.id) : null, company: msg.company || null, title: msg.title || null,
          token: ATS?.reqToken(url) || null,
        });
        await runOnTab(already.id, { auto: false, reset: true });
        console.log(`[jarvis] tab ${already.id}: already showing ${msg.company || url} — pressed there instead of opening a second`);
        reply({ ok: true, tabId: already.id, reused: true });
        return;
      }
      const tab = await chrome.tabs.create({ url, active: true });
      await arm(tab.id, {
        started: true, pressNext: true,
        id: msg.id ? String(msg.id) : null, company: msg.company || null, title: msg.title || null,
        token: ATS?.reqToken(url) || null,
      });
      console.log(`[jarvis] tab ${tab.id}: opened by the dashboard for ${msg.company || url} — armed`);
      reply({ ok: true, tabId: tab.id });
      return;
    }
    reply({ ok: false, error: `unknown message "${msg?.type}"` });
  })().catch((e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

/**
 * MAY THIS EXTENSION REACH EVERY SITE, or only the one he clicked on?
 *
 * The manifest asks for `<all_urls>`, but Chrome does not hand that to an
 * extension that was first installed with `activeTab` and grew the request
 * later: it keeps site access at "On click". His own clicks then work — a
 * click grants that one site — and every injection that has NO click behind
 * it is not refused but HELD, forever, waiting for a click that never comes.
 * Measured in his Chrome: `chrome.scripting.executeScript` of `() => 1` hung
 * on every tab, including a blank localhost page, while messaging and
 * tabs.create worked. Following a tab across pages is exactly the injection
 * with no click behind it, so without this grant the whole feature is inert.
 *
 * `permissions.request` needs a user gesture; the toolbar press is one. So
 * the press asks, once, and Chrome shows him the question.
 */
async function hasAllSites() {
  try { return await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { return null; }
}

async function askForAllSites(tabId) {
  if (await hasAllSites()) return true;
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    note(`all-sites access ${granted ? 'granted' : 'declined'} on his press`);
    if (!granted) {
      badge(tabId, '!', '#b42318');
      title(tabId, 'Jarvis needs "all sites" access to follow this tab: chrome://extensions → Jarvis Apply → Site access → On all sites');
    }
    return granted;
  } catch (e) {
    note(`all-sites request failed — ${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}

/**
 * THE PRESS. Arm this tab if it is not, and fill it now.
 *
 * Pressing an already-armed tab fills again rather than stopping: "click it
 * again" is what he reaches for when something looks stuck, and a press that
 * silently turned the following OFF would leave him on the one page he most
 * wanted filled. Stopping is a separate, visible act — the panel's link or
 * the icon's menu.
 */
async function press(tab) {
  if (tab?.id != null) dropReport(tab.id);
  if (!tab?.id) return;
  if (await reloadIfStale()) {
    // The worker is about to be torn down. Say why, so a click that appears to
    // do nothing is explained rather than mysterious.
    badge(tab.id, '↻', '#d29922');
    return;
  }
  // Ask for every site while the press is still a user gesture — the one
  // moment Chrome lets an extension ask. Without the grant the press still
  // fills this page (the click grants this site), and nothing else ever runs.
  await askForAllSites(tab.id);
  const st = await armedState(tab.id);
  if (!st) await arm(tab.id, { started: true, token: ATS?.reqToken(tab.url || '') || null });
  else { st.started = true; st.runs = 0; st.lastUsefulAt = Date.now(); st.quiet = 0; st.holdAt = null; st.holdUrl = null; if (!st.token) st.token = ATS?.reqToken(tab.url || '') || null; await saveArmed(); }
  await runOnTab(tab.id, { auto: false, reset: true });
}

/**
 * THE SIDE PANEL OPENS ON THE SAME CLICK THAT PRESSES. Chrome lets a panel
 * open only inside a user gesture, so it is asked for first, synchronously;
 * the press follows as before. The panel shows the posting, its fit, the
 * resume written for it and the walk's progress (panel.js).
 */
/**
 * …AND A BROWSER WITHOUT A SIDE PANEL GETS THE PANEL DOCKED INTO THE PAGE
 * (F-411, F-415).
 *
 * `chrome.sidePanel` is Chrome's own API. Opera GX is Chromium and runs this
 * extension happily, but has no side panel at all, so the call was undefined,
 * the failure was swallowed as "no panel in this Chrome", and pressing Jarvis
 * there filled the form while nothing whatsoever appeared.
 *
 * The first fix opened it as a separate window, and he was right to reject
 * that: "i still want it to be a part of the same window not separate ones,
 * similar to the one in chrome or simplify". So it is docked to the right-hand
 * edge of the page instead — the same panel.html in an iframe inside a shadow
 * root, which is how Simplify does it and what a side panel feels like.
 *
 * Three rungs, in order, and each one only runs when the one above refuses:
 *
 *   1. Chrome's own side panel;
 *   2. the panel docked into the page (every Chromium without a side panel);
 *   3. a window, for a page whose CSP will not have a frame in it at all.
 *
 * The dock is pinned to the tab it was opened on (`panel.html?tab=<id>`, which
 * panel.js already understands), so it follows that application through its
 * steps, and pressing again toggles it rather than stacking another one up.
 */
let PANEL_WINDOW = null;

/** Rung 3: a window. Only for a page that will not host the frame. */
async function openPanelWindow(tab) {
  if (!chrome.windows?.create) return false;
  const url = chrome.runtime.getURL(`panel.html${tab?.id ? `?tab=${tab.id}` : ''}`);
  if (PANEL_WINDOW != null) {
    const open = await chrome.windows.get(PANEL_WINDOW).catch(() => null);
    if (open) {
      const [existing] = await chrome.tabs.query({ windowId: PANEL_WINDOW }).catch(() => []);
      if (existing) await chrome.tabs.update(existing.id, { url }).catch(() => {});
      await chrome.windows.update(PANEL_WINDOW, { focused: true }).catch(() => {});
      return true;
    }
    PANEL_WINDOW = null;
  }
  const host = tab?.windowId != null ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  const width = 420;
  const height = Math.max(560, Math.min(900, (host?.height || 900) - 40));
  const made = await chrome.windows.create({
    url, type: 'popup', width, height,
    left: Math.max(0, (host?.left || 0) + (host?.width || 1280) - width),
    top: Math.max(0, host?.top || 0),
  }).catch(() => null);
  PANEL_WINDOW = made?.id ?? null;
  return !!made;
}

/**
 * Rung 2: the panel docked into the page itself.
 *
 * A shadow root so the site's CSS cannot reach it, `position: fixed` down the
 * right edge, and the page's own body given room beside it so nothing is
 * covered. Returns false when the page refuses the frame, which is the only
 * case rung 3 exists for.
 */
async function dockPanel(tab) {
  if (!tab?.id || !chrome.scripting?.executeScript) return false;
  const url = chrome.runtime.getURL(`panel.html?tab=${tab.id}`);
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (src) => {
        const ID = 'jarvis-dock';
        const existing = document.getElementById(ID);
        if (existing) {
          // Pressing again puts it away, the way a side panel toggles.
          existing.remove();
          document.documentElement.style.removeProperty('margin-right');
          return { ok: true, toggled: 'closed' };
        }
        const host = document.createElement('div');
        host.id = ID;
        host.style.cssText = [
          'position:fixed', 'top:0', 'right:0', 'bottom:0', 'width:400px',
          'z-index:2147483646', 'border:0', 'margin:0', 'padding:0',
          'box-shadow:-8px 0 28px rgba(0,0,0,.35)', 'color-scheme:dark',
        ].join(';');
        const root = host.attachShadow({ mode: 'open' });
        const frame = document.createElement('iframe');
        frame.setAttribute('src', src);
        frame.setAttribute('title', 'Jarvis');
        frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#0d1117';
        const bar = document.createElement('div');
        bar.style.cssText = 'position:absolute;top:6px;left:-26px;width:24px;height:26px;border-radius:6px 0 0 6px;'
          + 'background:#161b22;color:#adbac7;font:14px/26px system-ui;text-align:center;cursor:pointer;user-select:none';
        bar.textContent = '✕';
        bar.title = 'Close the Jarvis panel';
        bar.addEventListener('click', () => {
          host.remove();
          document.documentElement.style.removeProperty('margin-right');
        });
        root.append(frame, bar);
        (document.body || document.documentElement).appendChild(host);
        // Give the page room rather than covering its right-hand column.
        try { document.documentElement.style.setProperty('margin-right', '400px'); } catch { /* the page keeps its width */ }
        return { ok: true, toggled: 'opened' };
      },
      args: [url],
    });
    return !!r?.result?.ok;
  } catch {
    return false;   // chrome:// pages, the Web Store, a page that refuses us
  }
}

function openPanel(tab) {
  // Chrome: the panel must be asked for inside the user gesture, so this is
  // synchronous and the rungs below only run once it is refused.
  if (chrome.sidePanel?.open) {
    try {
      const p = chrome.sidePanel.open(tab?.windowId != null ? { windowId: tab.windowId } : { tabId: tab.id });
      if (p?.catch) p.catch(async () => { if (!(await dockPanel(tab))) await openPanelWindow(tab); });
      return;
    } catch { /* fall through to the dock */ }
  }
  (async () => { if (!(await dockPanel(tab))) await openPanelWindow(tab); })();
}
chrome.action.onClicked.addListener((tab) => { openPanel(tab); return press(tab); });

// The keyboard shortcut does what the press does.
chrome.commands?.onCommand?.addListener(async (command, tab) => {
  if (command !== 'fill') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))?.[0];
  // The shortcut shows the panel too. It used to only press, so on a browser
  // with no side panel the keyboard route filled the form and said nothing.
  if (t) openPanel(t);
  press(t);
});

// Reachable from a test harness that has loaded this extension for real.
self.runOnTab = runOnTab;
self.reloadIfStale = reloadIfStale;
self.arm = arm;
self.disarm = disarm;
self.armedState = armedState;
self.press = press;
// A browser without a side panel opens the panel as a window instead (F-411).
self.openPanel = openPanel;
self.dockPanel = dockPanel;
self.report = report;
