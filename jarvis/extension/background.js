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
try { importScripts('oracle-select.js'); } catch { /* a harness that loads this file bare */ }
const ATS = globalThis.__jarvisAts || null;

const BASES = ['http://localhost:4300', 'http://127.0.0.1:4300'];

let cached = { base: null, token: null };

/**
 * WHOSE FILES THESE ARE. The dashboard says who it is running for on the
 * token answer; the name goes on every fallback filename and is kept in
 * chrome.storage.local (`jarvisPerson`) for the page and the panel. Until the
 * dashboard has answered once, the name is the original user's.
 */
let PERSON = { fullName: 'Alex Rivera' };
function rememberPerson(p) {
  if (!p || typeof p.fullName !== 'string' || !p.fullName.trim()) return;
  PERSON = { ...PERSON, ...p };
  try { chrome.storage?.local?.set?.({ jarvisPerson: PERSON })?.catch?.(() => {}); } catch { /* memory still has it */ }
}
try {
  chrome.storage?.local?.get?.('jarvisPerson')?.then?.((s) => { if (s?.jarvisPerson) rememberPerson(s.jarvisPerson); })?.catch?.(() => {});
} catch { /* no storage: the default name stands */ }
const resumeFallbackName = () => `${PERSON.fullName} Resume.pdf`;

/**
 * TIME LIMITS ON THE DASHBOARD (S3, 2026-11-06). Nothing here had one: a
 * dashboard frozen on a long read held a press for as long as it stayed
 * frozen, with nothing on screen. Two rules, chosen so a BUSY dashboard still
 * finishes the fill (a plan took 26 s right after a restart and was right):
 *   - finding it is quick: both addresses at once, 2.5 s each;
 *   - a call that is merely slow keeps waiting, and the panel says so after
 *     3 s; only the routes that should always be quick are given up on, at
 *     60 s. Writing an answer, a letter, an outreach message, fetching the
 *     portfolio or waiting for a verification code take as long as they take.
 */
const CONNECT_MS = 2500;
const SLOW_NOTE_MS = 3000;
const QUICK_LIMIT_MS = 60_000;
const QUICK_ROUTES = new Set(['/api/plan', '/api/choose', '/api/filled', '/api/answer-snapshot', '/api/form-capture', '/api/page-errors', '/api/resume-name', '/api/apply-page', '/api/apply-current']);
const timeLimit = (ms) => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(self.__jarvisTimeScale ? Math.max(1, Math.round(ms * self.__jarvisTimeScale)) : ms) : undefined);
const timedOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
/**
 * The calls a TAB's run is waiting on: id → { tab, path, since }. Only calls
 * made for a tab are counted, and each tab hears only its own (review): the
 * panel's own requests, an answer being written for another tab and the
 * outreach polls carry no tab and are never counted.
 */
const PENDING = new Map();
let pendingSeq = 0;
/** "Dashboard slow to answer", while one of this tab's calls has waited longer than it should. */
function slowNote(tabId, now = Date.now()) {
  let oldest = null;
  for (const p of PENDING.values()) if (p.tab === tabId && (!oldest || p.since < oldest.since)) oldest = p;
  if (!oldest) return '';
  const waited = now - oldest.since;
  if (waited < (self.__jarvisSlowNoteMs ?? SLOW_NOTE_MS)) return '';
  return `Dashboard slow to answer (${Math.round(waited / 1000)} s on ${oldest.path.replace(/^\/api\//, '')}), still waiting`;
}

/**
 * A ticket for the panel's PDF frame (F-1031): one per file (job and resume or
 * letter), kept while the dashboard's token is the same (a restart issues a new
 * token and ends every ticket) and until five minutes before its 30 run out.
 * Empty when the dashboard will not give one: the link is then the plain one.
 */
const FILE_TICKETS = new Map();   // `${what}|${id}` → { token, ticket, until }
async function fileTicket(id, what = 'resume', now = Date.now()) {
  if (!id) return '';
  try {
    const conn = await connect();
    const key = `${what}|${id}`;
    const had = FILE_TICKETS.get(key);
    if (had && had.token === conn.token && had.until > now) return had.ticket;
    const got = await api('/api/file-ticket', { method: 'POST', body: { id: String(id), what } });
    if (!got?.ticket) return '';
    if (FILE_TICKETS.size > 50) FILE_TICKETS.clear();
    FILE_TICKETS.set(key, { token: cached.token || conn.token, ticket: String(got.ticket), until: now + Math.max(0, Number(got.ttlMs || 0) - 5 * 60_000) });
    return String(got.ticket);
  } catch { return ''; }
}

/** Find the dashboard and get a token from it. Cached until it stops answering. */
async function connect() {
  if (cached.base && cached.token) return cached;
  // Both addresses at once: one that hangs no longer holds up the other.
  let slow = false;
  const probe = async (base) => {
    let r;
    try { r = await fetch(`${base}/api/apply-token`, { method: 'GET', signal: timeLimit(CONNECT_MS) }); }
    catch (e) { if (timedOut(e)) slow = true; throw e; }
    if (!r.ok) throw new Error(`status ${r.status}`);
    const { token, person } = await r.json();
    if (!token) throw new Error('no token');
    return { base, token, person };
  };
  try {
    const got = await Promise.any(BASES.map(probe));
    cached = { base: got.base, token: got.token };
    rememberPerson(got.person);
    return cached;
  } catch { /* none answered */ }
  cached = { base: null, token: null };
  // A refused connection is a stopped dashboard; one that never answered is busy (or stuck).
  if (slow) throw new Error('the Jarvis dashboard is not answering (busy, or stuck) — give it a moment and press Jarvis again; if it stays this way, restart it with npm run jarvis:serve');
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

/** A tab's call to the dashboard, counted while it waits (S3): the panel's "slow to answer" reads PENDING. */
async function api(pathname, opts = {}) {
  if (!Number.isInteger(opts.tabId)) return apiCall(pathname, opts);
  const id = ++pendingSeq;
  PENDING.set(id, { tab: opts.tabId, path: String(pathname).split('?')[0], since: Date.now() });
  try { return await apiCall(pathname, opts); } finally { PENDING.delete(id); }
}

async function apiCall(pathname, { method = 'GET', body = null, raw = false, withName = false } = {}) {
  const route = String(pathname).split('?')[0];
  const quick = QUICK_ROUTES.has(route);
  // The dashboard may still finish what it was asked (a client giving up does
  // not stop the server). Every quick route is safe to send again: apply-current
  // only reads; filled overwrites the tab's running totals and marks applied
  // only once; apply-page finds the posting it recorded by its address;
  // form-capture adds one more diagnostic row (review, 2026-11-06).
  const gaveUp = () => Object.assign(new Error(`the Jarvis dashboard did not answer ${route} within ${Math.round(QUICK_LIMIT_MS / 1000)} s — it is busy (or stuck), and may already have recorded the last step; press Jarvis again in a moment`), { status: 0, slow: true });
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
      signal: quick ? timeLimit(QUICK_LIMIT_MS) : undefined,
    });
  } catch (e) {
    // A quick route the dashboard sat on is a busy dashboard, not a gone one:
    // asking it again would only double the wait.
    if (timedOut(e)) throw gaveUp();
    cached = { base: null, token: null };
    // A RESTART IS SECONDS, NOT GONE (F-826). Zipline's resume fetch met the
    // dashboard mid-restart (01:12:08) and the run reported "the Jarvis
    // dashboard is not running" and left the resume out. A call that was
    // refused mid-flight waits up to ~9 s for the dashboard to come back.
    for (let tries = 0; ; tries += 1) {
      try { conn = await connect(); break; } catch (err) {
        if (tries >= 5) throw err;     // its own clear message: it is really gone
        await new Promise((r) => setTimeout(r, self.__jarvisReconnectMs ?? 1500));
      }
    }
    try {
      res = await fetch(`${conn.base}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-jarvis-token': conn.token },
        body: body ? JSON.stringify(body) : undefined,
        signal: quick ? timeLimit(QUICK_LIMIT_MS) : undefined,
      });
    } catch (e2) {
      if (timedOut(e2)) throw gaveUp();
      throw e2;
    }
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
  return withName ? { buf, filename: named ? named[1].trim() : resumeFallbackName() } : buf;
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
 * THE JOB A TAB IS ON, EVEN WHEN NOTHING IS FOLLOWING IT (F-791).
 *
 * "why cant we fix this damn not readable posting thing by recognizing linked
 * in post or knowing the link so when i move to new ui it knows its the same
 * thing even if it only sees the form" (2026-10-22). Veeco's posting is
 * careers.veeco.com/job/…/1439543300/; its form is career8.successfactors.com/
 * portalcareer?_s.crb=<session token>, headed "Manufacturing Equipment Engineer
 * (20277)", and five stored Veeco rows carry that title. The form alone names
 * nothing. The posting page he was on a minute earlier did: the panel looked it
 * up and the server knew it. Only an ARMED tab kept that answer.
 *
 * So every tab keeps the last job the server named for it — from the panel's
 * lookup, a run, or the dashboard — and hands it on: to the next page in the
 * same tab and to a tab the page opens. The server still prefers the page: the
 * remembered id is used only when the page itself names nothing (jobForRequest).
 *
 * Dropped when it can no longer be the same application:
 *   - two hours after it was last confirmed;
 *   - a navigation to another posting of the same kind (requisition tokens, and
 *     LinkedIn's job ids, that differ — the armed tab's rule);
 *   - a navigation to another site that is not an application system or a
 *     sign-in page (he browsed away; an Apply that leaves the employer's site
 *     lands on an ATS host or the employer's own domain).
 */
const SEEN = new Map();   // tabId -> { id, company, title, token, url, host, at }
const SEEN_TTL_MS = 2 * 60 * 60 * 1000;
let seenLoaded = null;
const seenStore = () => chrome.storage?.session || store();
const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; } };
/** The posting a URL names: its ATS requisition, or a LinkedIn job id. */
function postingToken(url) {
  const t = ATS?.reqToken?.(url);
  if (t) return t;
  const s = String(url || '');
  if (!/^https?:\/\/(?:[a-z]+\.)?linkedin\.com\//i.test(s)) return null;
  const m = s.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i) || s.match(/[?&]currentJobId=(\d{6,})/i);
  return m ? `linkedin:${m[1]}` : null;
}
async function loadSeen() {
  if (!seenLoaded) {
    seenLoaded = (async () => {
      try {
        const { seenJobs } = await seenStore()?.get('seenJobs') || {};
        for (const [k, v] of Object.entries(seenJobs || {})) SEEN.set(Number(k), v);
      } catch { /* start empty */ }
    })();
  }
  return seenLoaded;
}
async function saveSeen() {
  try { await seenStore()?.set({ seenJobs: Object.fromEntries(SEEN) }); } catch { /* memory still holds it */ }
}
/** The server named this tab's job (from `url`, the page it was named on). */
async function seeJob(tabId, job, url = '') {
  if (!Number.isInteger(tabId) || !job?.id) return;
  await loadSeen();
  const had = SEEN.get(tabId);
  const same = had && String(had.id) === String(job.id);
  SEEN.set(tabId, {
    id: String(job.id),
    company: job.company || (same ? had.company : null) || null,
    title: job.title || (same ? had.title : null) || null,
    // The posting's own token, from where it was first named: the form that
    // follows may carry another kind, or none.
    token: (same && had.token) || job.token || postingToken(url) || null,
    url: (same && had.url) || url || '',
    host: hostOf(url) || had?.host || '',
    at: Date.now(),
  });
  await saveSeen();
}
/** The job remembered for this tab, if it is still fresh. */
async function seenJob(tabId) {
  if (!Number.isInteger(tabId)) return null;
  await loadSeen();
  const s = SEEN.get(tabId);
  if (!s) return null;
  if (Date.now() - (s.at || 0) > SEEN_TTL_MS) { SEEN.delete(tabId); await saveSeen(); return null; }
  return s;
}
async function forgetSeen(tabId, why = '') {
  await loadSeen();
  if (!SEEN.has(tabId)) return;
  const s = SEEN.get(tabId);
  SEEN.delete(tabId);
  await saveSeen();
  if (why) note(`tab ${tabId}: no longer ${s.company || s.id} — ${why}`);
}
/** The top frame of a tab went somewhere: does the remembered job still hold? */
async function seenNavigation(tabId, url) {
  await loadSeen();
  const s = SEEN.get(tabId);
  if (!s || !url || !/^https?:/i.test(url)) return;
  const now = postingToken(url);
  const kind = (t) => String(t).split(':')[0];
  if (now && s.token && kind(now) === kind(s.token) && now !== s.token) { await forgetSeen(tabId, `a different posting (${now})`); return; }
  const host = hostOf(url);
  if (!s.host || host === s.host || ATS?.isAtsHost?.(url) || ATS?.isIdp?.(url)) {
    if (host && !ATS?.isIdp?.(url)) { s.host = host; await saveSeen(); }
    return;
  }
  await forgetSeen(tabId, `browsed to ${host}`);
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
// The two set-up injections before it are one-liners; a frame that has not
// loaded in this long is not waited for (F-571).
const SETUP_CAP_MS = 5000;
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
  if (seed.id) await seeJob(tabId, seed);
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
  if (tabId && id) await seeJob(tabId, { id, company, title: jobTitle }, fromUrl);
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
      // The old job's name goes with it; a caller that knows only the new id
      // must not leave the tab labelled with the previous employer (F-568).
      st.company = null;
      st.title = null;
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

/**
 * Runs IN a frame of the page: find the empty slot for the resume or the
 * letter, and (unless `dry`) put the file in it. A dry run carries no file
 * and only says whether this frame has a slot, and whether it is named for
 * the file (F-825).
 */
function slotPicker(b64, name, kind, dry) {
  const RESUME = /resume|cv\b|curriculum\s*vitae/i;
  const LETTER = /cover\s*letter|covering\s*letter|letter\s*of\s*(?:interest|motivation)/i;
  const NOT_RESUME = /cover.?letter|portfolio|transcript|writing.?sample|easy apply|auto-?fill|prefill/i;
  const PORTFOLIO = /portfolio|work.?samples?|samples?.of.(?:your.)?work/i;
  // His button press for the portfolio may land in a plain "Attachments" or
  // "Additional documents" slot when the form has no portfolio one — never in
  // the resume's, the letter's or a parser's.
  const NOT_PORTFOLIO = /resume|cv\b|curriculum|cover.?letter|easy apply|auto-?fill|prefill|parse/i;
  const want = kind === 'letter' ? LETTER : kind === 'portfolio' ? PORTFOLIO : RESUME;
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
    || (kind === 'portfolio' ? empty.find((el) => !NOT_PORTFOLIO.test(labelOf(el))) : null)
    || (empty.length === 1 && kind !== 'portfolio' ? empty[0] : null);
  if (!pick) return { ok: false, why: `no empty ${kind === 'letter' ? 'cover-letter' : kind === 'portfolio' ? 'portfolio (or extra documents)' : 'resume'} slot on this page — drag the file onto the box you want instead` };
  if (dry) return { ok: true, named: named.includes(pick), label: labelOf(pick).split(' | ')[0] || 'the file slot' };
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
  pick.files = dt.files;
  pick.dispatchEvent(new Event('input', { bubbles: true }));
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, name, label: labelOf(pick).split(' | ')[0] || 'the file slot' };
}

/**
 * The file a slot gets: the resume or the letter for this posting, or his
 * portfolio PDF (the same file for every posting, built by
 * `npm run portfolio:pdf`).
 */
async function fileFor(what, tabId, id, pageUrl) {
  if (what === 'portfolio') return api('/api/portfolio-pdf', { raw: true, withName: true });
  const st0 = Number.isInteger(tabId) ? await armedState(tabId) : null;
  const jid = id || st0?.id || '';
  const q = `${jid ? `id=${encodeURIComponent(jid)}&` : ''}pageUrl=${encodeURIComponent(pageUrl || '')}`;
  // The panel's chip or a drag is HIS ask (ask=1): the letter is written even where the form named none.
  const route = what === 'letter' ? `/api/cover-letter-pdf?${q}&write=1&ask=1` : `/api/apply-resume?${q}`;
  return api(route, { raw: true, withName: true });
}

// What the panel is dragging, per tab: { what, id, pageUrl }.
const DRAGS = new Map();

/**
 * DRAG A FILE FROM THE PANEL ONTO AN UPLOAD BOX (2026-10-22).
 *
 * Runs IN every frame of the page. Chrome carries only text from an extension
 * page into a web page, never a File, so the drag itself holds a marker and
 * this listener does the attaching: armed when the panel starts a drag, it
 * takes the drop before the page sees it, finds the file input under (or
 * nearest to) the drop point, asks the worker for the file and puts it in.
 * Only trusted drops while armed, and never a drag of real files from the
 * desktop. `what` empty disarms.
 */
function dropCatcher(what, label) {
  const g = window.__jarvisDrop || (window.__jarvisDrop = {});
  g.what = what || '';
  g.label = label || 'the file';
  g.until = what ? Date.now() + 120000 : 0;
  if (g.installed) return true;
  g.installed = true;
  const live = (e) => e.isTrusted && g.until > Date.now()
    && !Array.from(e.dataTransfer?.types || []).includes('Files');
  const isFile = (n) => n && n.tagName === 'INPUT' && n.type === 'file';
  const shown = (n) => { while (n && n.nodeType === 1 && !n.getClientRects().length) n = n.parentElement; return n && n.nodeType === 1 ? n : null; };
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() !== n && n.getRootNode().host) || null;
  const slotAt = (target, x, y) => {
    if (isFile(target)) return target;
    if (target?.tagName === 'LABEL' && isFile(target.control)) return target.control;
    for (let n = target, i = 0; n && i < 12; n = up(n), i += 1) {
      const ins = n.querySelectorAll ? Array.from(n.querySelectorAll('input[type="file"]')) : [];
      if (ins.length === 1) return ins[0];
      if (ins.length > 1) {
        const dist = (el) => {
          const r = (shown(el) || el).getBoundingClientRect();
          return Math.hypot(Math.max(r.left, Math.min(x, r.right)) - x, Math.max(r.top, Math.min(y, r.bottom)) - y);
        };
        return ins.sort((a, b) => dist(a) - dist(b))[0];
      }
    }
    return null;
  };
  const zoneOf = (input) => {
    const z = input.closest('label, [class*="drop" i], [class*="upload" i]');
    return shown(z || input) || input;
  };
  let marked = null;
  const mark = (el) => {
    if (marked === el) return;
    if (marked) { marked.style.outline = marked.__jvOutline || ''; marked.style.outlineOffset = marked.__jvOffset || ''; }
    marked = el;
    if (el) { el.__jvOutline = el.style.outline; el.__jvOffset = el.style.outlineOffset; el.style.outline = '3px dashed #5aa2ff'; el.style.outlineOffset = '2px'; }
  };
  const say = (text) => { try { chrome.runtime.sendMessage({ type: 'drag-note', text }); } catch { /* the panel is gone */ } };
  const over = (e) => {
    if (!live(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch { /* read-only here */ }
    const input = slotAt(e.composedPath()[0], e.clientX, e.clientY);
    mark(input ? zoneOf(input) : null);
  };
  window.addEventListener('dragenter', over, true);
  window.addEventListener('dragover', over, true);
  window.addEventListener('dragleave', (e) => { if (live(e) && !e.relatedTarget) mark(null); }, true);
  window.addEventListener('drop', async (e) => {
    if (!live(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    mark(null);
    const input = slotAt(e.composedPath()[0], e.clientX, e.clientY);
    const kind = g.what;
    g.until = 0;
    if (!input) { say('No upload box there. Drop it on the box that asks for the file.'); return; }
    say(`Attaching ${g.label}…`);
    let got;
    try { got = await chrome.runtime.sendMessage({ type: 'drag-file', what: kind }); } catch (err) { got = { ok: false, error: String(err?.message || err) }; }
    if (!got?.ok) { say(got?.error || got?.why || 'could not get the file'); return; }
    const bin = atob(got.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], got.filename, { type: 'application/pdf' });
    const dt = new DataTransfer();
    // A slot that takes several files keeps what it has; one that takes one is replaced.
    if (input.multiple && input.files) for (const f of input.files) dt.items.add(f);
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // An uploader drawn over a hidden input listens on its zone: give it the
    // drop it was waiting for (untrusted, so this listener lets it through) —
    // only if the page has not printed the file's name by then, or a page
    // that took the change would get the file twice.
    if (!input.getClientRects().length) await new Promise((r) => setTimeout(r, 1200));
    if (!input.getClientRects().length && !String(document.body?.innerText || '').includes(file.name.replace(/\.pdf$/i, '').slice(0, 24))) {
      const one = new DataTransfer();
      one.items.add(file);
      const zone = zoneOf(input);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        try { zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: one })); } catch { /* no DragEvent */ }
      }
    }
    say(`Attached "${file.name}". Check the form shows it.`);
  }, true);
  return true;
}

/** Bytes to base64, in chunks — a PDF is a few hundred KB and btoa wants a string. */
function base64Of(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * IS THIS TAB SHOWING THAT POSTING? (F-1013 #1, review 2026-11-05.) The
 * dashboard's "Apply now" reuses a tab already on the posting. It took any tab
 * whose address merely STARTED with the posting's: …/jobs/1234 picked an open
 * …/jobs/12345, and …/job/mechanical-engineer picked …/mechanical-engineer-ii,
 * then armed and filled that other posting with this one's resume and answers.
 * The same address, or the same address continued by "/" (its /apply page) or
 * "?" (tracking parameters) — and never when the two carry different
 * requisitions of the same kind.
 */
function tabShowsPosting(tabUrl, want) {
  const strip = (u) => String(u || '').replace(/#.*$/, '');
  const a = strip(tabUrl);
  const w = strip(want).replace(/\/+$/, '');
  if (!a || !w) return false;
  const same = a === w || a === `${w}/` || (a.startsWith(w) && (a[w.length] === '/' || a[w.length] === '?'));
  if (!same) return false;
  try {
    const x = ATS?.reqToken(a), y = ATS?.reqToken(w);
    const kind = (t) => String(t).split(':')[0];
    if (x && y && kind(x) === kind(y) && x !== y) return false;
  } catch { /* no table: the address alone decides */ }
  return true;
}
self.tabShowsPosting = tabShowsPosting;

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
    // The first <h1> NOT in the site's banner or navigation (F-1012: Tesla's
    // first one is its logo, "Careers" and the skip link). Self-contained: it
    // runs in the page.
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const say = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
      const furniture = (el) => !!el.closest('nav, [role="navigation"], [role="banner"]') || (!!el.closest('header') && !el.closest('main, article, [role="main"]'));
      const h = [...document.querySelectorAll('h1')].find((el) => say(el) && !furniture(el) && !/skip (?:to|navigation)\b|^(?:main|site|primary) (?:menu|navigation)$|^toggle (?:navigation|menu)$/i.test(say(el)));
      return say(h).slice(0, 200);
    } });
    heading = r?.result || '';
  } catch { /* a page it may not read; the URL and title still say plenty */ }
  const q = new URLSearchParams({ pageUrl: tab.url, heading, pageTitle: tab.title || '' });
  // The armed tab's job, else the one this tab was last on (F-791): the form
  // that names nothing is shown as the posting he came from.
  const remembered = st?.id || (await seenJob(tabId))?.id || null;
  if (remembered) q.set('id', remembered);
  try {
    const data = await api(`/api/panel?${q}`);
    if (data?.job?.id) await seeJob(tabId, data.job, tab.url);
    return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title || '' }, armed, running: RUNNING.has(tabId), data, stopped: STOPPED.get(tabId) || null };
  } catch (e) {
    return { ok: false, status: e.status || 0, error: String(e?.message || e), tab: { id: tab.id, url: tab.url, title: tab.title || '' }, armed, running: RUNNING.has(tabId) };
  }
}

/**
 * A CLOCK FOR A HIDDEN TAB (2026-09-25: "why is jarvis fill speed now painfully
 * slow"). He fills in Opera GX while working in another tab. A hidden page's
 * timers never fire sooner than once a second — F-464 stopped the one-a-minute
 * case, not this one — and the fill waits in 120 ms steps, so hidden every step
 * cost eight times its length: a skills search that gives up in under a second
 * on screen took seven, and Samsung's My Experience step took 3.5 minutes. This
 * worker's timers are not a page's and are not held back, so a hidden page asks
 * here and is woken on time. Its own listener, answering nothing else.
 */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'sleep') return undefined;
  setTimeout(() => { try { reply({ ok: true }); } catch { /* the tab went away */ } }, Math.max(0, Math.min(Number(msg.ms) || 0, 10000)));
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // The clock above answers these; an "unknown message" here would wake the
  // sleeper at once.
  if (msg?.type === 'sleep') return undefined;
  // A drop's note to the panel; the panel answers it, not the worker.
  if (msg?.type === 'drag-note') return undefined;
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
          // The posting this tab did not fill because it is barred, until he presses Fill anyway.
          stopped: STOPPED.get(msg.tabId) || null,
          // What the page's last run reported, and the progress line right now.
          report: rep.report || null,
          // A dashboard call that has waited past 3 s says so on the progress line (S3).
          live: [RUNNING.has(msg.tabId) || Date.now() - (rep.liveAt || 0) < 15_000 ? (rep.live || '') : '', RUNNING.has(msg.tabId) ? slowNote(msg.tabId) : ''].filter(Boolean).join(' · '),
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
      // A RUN SAYS IT IS ALIVE (F-994 review): every status and step, from any
      // frame, at most every ten seconds — a slow run is never taken for a stalled one.
      if (msg?.type === 'run-alive' && tabId) {
        const run = RUNNING.get(tabId);
        if (run) run.lastStep = Date.now();
        reply({ ok: true });
        return;
      }
      // IS THIS TAB STILL ARMED? (F-990) A run that began armed asks before each
      // step; one he disarmed mid-run stops instead of putting back what he removed.
      if (msg?.type === 'still-armed' && tabId) {
        // From disk first (F-1013 #20): a worker woken mid-walk has an empty
        // map until it loads, and "not armed" stopped the run at its next step.
        await loadArmed();
        reply({ ok: true, armed: ARMED.has(tabId) });
        return;
      }
      if (msg?.type === 'page-live' && tabId) {
        // The page is working: its run is alive (F-994).
        const run = RUNNING.get(tabId);
        if (run) run.lastStep = Date.now();
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
          // A frame this panel loads is a page load another site started; the
          // dashboard lets it through with a ticket only the worker can get (F-1031).
          const ticket = await fileTicket(msg.id, msg.what === 'letter' ? 'letter' : 'resume');
          if (ticket) q.set('ticket', ticket);
          const which = msg.what === 'letter' ? '/api/cover-letter-pdf' : '/api/apply-resume';
          reply({ ok: true, url: `${base}${which}?${q}` });
        } catch (e) { reply({ ok: false, error: String(e?.message || e) }); }
        return;
      }
      if (msg?.type === 'resume-name' && msg.id && fromPanel) {
        // His name for this posting's resume file; every attach uses it.
        try {
          const got = await api('/api/resume-name', { method: 'POST', body: { id: String(msg.id), name: String(msg.name ?? '') } });
          reply({ ok: true, name: got?.name || '' });
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
          const what = ['letter', 'portfolio'].includes(msg.what) ? msg.what : 'resume';
          const { buf, filename } = await fileFor(what, msg.tabId, msg.id, msg.pageUrl);
          // EVERY FRAME, THEN ONE (F-825). Zipline's form is Greenhouse's embed
          // in an iframe on zipline.com; looking only at the top page said
          // "this page has no file slot" beside a form with two. Each frame is
          // asked first without the file; the file goes only to the frame with
          // the best slot, so a second form or a widget's input never gets one.
          const probes = await chrome.scripting.executeScript({
            target: { tabId: msg.tabId, allFrames: true }, func: slotPicker, args: ['', '', what, true],
          }).catch(() => []);
          const rank = (p) => (p?.result?.ok ? (p.result.named ? 3 : 2) : /already holds/.test(p?.result?.why || '') ? 1 : 0);
          const best = [...(probes || [])].sort((a, b) => rank(b) - rank(a))[0];
          if (!best?.result?.ok) { reply(best?.result || { ok: false, why: 'this page has no file slot' }); return; }
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: msg.tabId, frameIds: [best.frameId ?? 0] },
            func: slotPicker,
            args: [base64Of(buf), filename || (what === 'letter' ? 'Cover Letter.pdf' : what === 'portfolio' ? 'Portfolio.pdf' : 'Resume.pdf'), what, false],
          });
          reply(r?.result || { ok: false, why: 'the page did not answer' });
        } catch (e) {
          reply({ ok: false, why: String(e?.message || e), status: e?.status || 0 });
        }
        return;
      }
      // A DRAG FROM THE PANEL STARTED (or ended): arm (or disarm) the drop
      // catcher in every frame of the page beside it.
      if ((msg?.type === 'drag-arm' || msg?.type === 'drag-end') && Number.isInteger(msg.tabId) && fromPanel) {
        const arming = msg.type === 'drag-arm';
        const what = ['letter', 'portfolio'].includes(msg.what) ? msg.what : 'resume';
        if (arming) DRAGS.set(msg.tabId, { what, id: msg.id || '', pageUrl: msg.pageUrl || '' });
        const label = what === 'portfolio' ? 'the portfolio' : what === 'letter' ? 'the cover letter' : 'the resume';
        // Disarm only: the drop itself already disarmed the frame it landed in,
        // and a drag that ended over nothing must not stay armed.
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId, allFrames: true }, func: dropCatcher, args: [arming ? what : '', label],
        }).catch(() => []);
        reply({ ok: true });
        return;
      }
      // …and the page asks for the file it was dropped on.
      if (msg?.type === 'drag-file' && Number.isInteger(tabId) && !fromPanel) {
        try {
          const d = DRAGS.get(tabId) || {};
          const what = ['letter', 'portfolio'].includes(msg.what) ? msg.what : 'resume';
          const { buf, filename } = await fileFor(what, tabId, d.id, d.pageUrl || sender?.tab?.url || '');
          reply({ ok: true, b64: base64Of(buf), filename: filename || (what === 'portfolio' ? 'Portfolio.pdf' : what === 'letter' ? 'Cover Letter.pdf' : 'Resume.pdf') });
        } catch (e) {
          reply({ ok: false, error: String(e?.message || e), status: e?.status || 0 });
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
        // FILL ANYWAY IS HIS, AND ONLY FROM HERE: the panel's button names the
        // posting, and the fill stop lets that posting through on every page.
        const anyway = msg.blockedAnyway?.id ? String(msg.blockedAnyway.id) : null;
        press(tab, { anyway }).catch((e) => console.warn(`[jarvis] press on tab ${tab.id} failed: ${String(e?.message || e)}`));
        // He pressed Fill anyway on a blocked posting (F-773): a record, never a gate.
        if (msg.blockedAnyway?.id) {
          api('/api/fill-anyway', { method: 'POST', body: { id: String(msg.blockedAnyway.id), reasons: (msg.blockedAnyway.reasons || []).slice(0, 3).map(String), pageUrl: tab.url || '' } }).catch(() => null);
        }
        reply({ ok: true, tabId: tab.id });
        return;
      }
      if (msg?.type === 'posting') {
        // THE PAGE SAID WHAT JOB IT IS. Hand that to the server, which records
        // the posting if the store has never seen it and starts the resume.
        // The id it answers with is this tab's application from now on.
        const st = tabId ? await armedState(tabId) : null;
        const p = api('/api/apply-page', { tabId, method: 'POST', body: {
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
      // A page that names ANOTHER posting than the tab's is matched by the
      // server from the page, never filled for the tab's job (F-921).
      const pageToken = msg?.pageUrl ? (ATS?.reqToken(msg.pageUrl) || null) : null;
      const seenNow = tabId ? await seenJob(tabId) : null;
      const stale = (t) => !!(t && pageToken && t !== pageToken);
      const id = (!stale(st?.token) && st?.id) || (!stale(seenNow?.token) && seenNow?.id) || undefined;

      if (msg?.type === 'plan') {
        // The page URL decides WHICH application this is. Without it the
        // server falls back to the most recent one, and with two tabs open that
        // attaches the wrong employer's resume.
        const plan = await api('/api/plan', { tabId, method: 'POST', body: {
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
        // …and when the tab's id is STALE: the server replaced it because the
        // page is another posting (F-492), and the tab's report must follow, or
        // the run is recorded under the job the tab was on before (F-568).
        if (tabId && plan?.id && plan.matched === 'page' && String(plan.id) !== String(id || '')) {
          await rememberApplication(tabId, { id: plan.id, company: plan.company, title: plan.title }, msg.pageUrl);
        }
        reply({ ok: true, plan });
      } else if (msg?.type === 'snapshot') {
        // The form as it stood when Next or Submit was pressed, compared with
        // the plan on the dashboard (answer-log.mjs). A record; never blocks.
        const r = await api('/api/answer-snapshot', { tabId, method: 'POST', body: {
          id, pageUrl: msg.pageUrl, heading: msg.heading || '', pageTitle: msg.pageTitle || '',
          stage: msg.stage, button: msg.button, by: msg.by, fields: msg.fields,
        } }).catch(() => null);
        reply({ ok: true, logged: r?.logged ?? 0 });
      } else if (msg?.type === 'capture') {
        // The markup around a control that did not take (an upload that never
        // showed, F-655), values stripped on the page. A record; never blocks.
        const r = await api('/api/form-capture', { tabId, method: 'POST', body: {
          id, pageUrl: msg.pageUrl, why: msg.why || '', label: msg.label || '', html: msg.html || '',
        } }).catch(() => null);
        reply({ ok: !!r?.ok });
      } else if (msg?.type === 'page-errors') {
        // What the form said back in red, in a banner, or beside a box marked
        // invalid (2026-10-02). A record for troubleshooting; never blocks.
        const r = await api('/api/page-errors', { tabId, method: 'POST', body: {
          id, pageUrl: msg.pageUrl, heading: msg.heading || '', pageTitle: msg.pageTitle || '',
          trigger: msg.trigger || '', errors: msg.errors || [],
        } }).catch(() => null);
        reply({ ok: !!r?.ok });
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
      } else if (msg?.type === 'code') {
        // The sign-in code from his email (his consent, 2026-10-23).
        try {
          reply(await api('/api/verification-code', { method: 'POST', body: {
            id, pageUrl: String(msg.pageUrl || ''), since: Number(msg.since) || 0,
          } }));
        } catch (e) {
          reply({ code: null, why: String(e?.message || e) });
        }
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
        const got = await api('/api/choose', { tabId, method: 'POST', body: { want: msg.want, options: msg.options } });
        reply({ ok: true, index: got?.index ?? -1, value: got?.value ?? null });
      } else if (msg?.type === 'oracle-pick') {
        // ORACLE'S LIST BOX THE MENU COULD NOT ANSWER (P2): its own option list
        // read in the page's world, his answer picked from it by the server's
        // matcher. NOTHING IS SET HERE (review): the page checks once more that
        // the box is still untouched and asks for the set itself. Top frame
        // only (runInPage).
        const OS = globalThis.__jarvisOracleSelect;
        if (!OS || !tabId || (sender?.frameId ?? 0) !== 0) { reply({ ok: false, why: 'not available in this frame' }); return; }
        const read = await runInPage(tabId, OS.oracleSelectRead, [String(msg.inputId || '')]).catch(() => null);
        if (!read?.ok || !Array.isArray(read.labels) || !read.labels.length) { reply({ ok: false, why: read?.why || 'no option list' }); return; }
        let picked = null;
        for (const want of (Array.isArray(msg.wants) ? msg.wants : []).slice(0, 3)) {
          // eslint-disable-next-line no-await-in-loop
          const got = await api('/api/choose', { tabId, method: 'POST', body: { want: String(want), options: read.labels } }).catch(() => null);
          if (Number.isInteger(got?.index) && got.index >= 0) { picked = got.index; break; }
        }
        if (picked == null) { reply({ ok: false, why: 'his answer is not among its options' }); return; }
        reply({ ok: true, index: picked, label: read.labels[picked] });
      } else if (msg?.type === 'oracle-set') {
        // …and the set, asked for by the page after its last look (P2 review):
        // the option at that index must still carry that label, and the box
        // must still hold what the page said it may (checked again in the page,
        // right before the setter — second review).
        const OS = globalThis.__jarvisOracleSelect;
        if (!OS || !tabId || (sender?.frameId ?? 0) !== 0) { reply({ ok: false, why: 'not available in this frame' }); return; }
        const guard = { before: String(msg.before ?? ''), wanted: (Array.isArray(msg.wanted) ? msg.wanted : []).slice(0, 3).map((w) => String(w ?? '')) };
        const set = await runInPage(tabId, OS.oracleSelectSet, [String(msg.inputId || ''), Number(msg.index), String(msg.label || ''), guard]).catch(() => null);
        reply(set?.ok ? { ok: true, label: set.label } : { ok: false, why: set?.why || 'not set' });
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
      } else if (msg?.type === 'portfolio') {
        // HIS PORTFOLIO PDF, for a form's portfolio slot (2026-10-22). One file
        // for every posting; base64, because a few MB as an array of numbers
        // is a slow message.
        const { buf, filename } = await api('/api/portfolio-pdf', { raw: true, withName: true });
        reply({ ok: true, b64: base64Of(buf), filename });
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
// Order matters: ats.js and discover.js define globals content.js uses.
const INJECTED_FILES = ['ats.js', 'report.js', 'discover.js', 'content.js'];
/**
 * FRAMES THAT KEEP THEIR SCRIPTS ARE NOT SENT THEM AGAIN (S2, 2026-11-07).
 * Every press and every follow-along step injected ~595 KB (ats, report,
 * discover, content) into EVERY frame of the tab, to be parsed again in each,
 * though a soft navigation keeps the document and content.js only handed the
 * request to the copy already there. Now the context call reports, per frame,
 * whether that frame holds this load's copy:
 *   resume   frames that do: a one-line call starts it (content.js's own
 *            re-injection path, without the parse);
 *   files    frames that do not: the four files, as before;
 *   skipped  captcha, video and tracking frames: nothing (no form lives there,
 *            and a human check is never touched). Chat and cookie-consent
 *            frames still get the scripts.
 * Null — inject everywhere, as before — whenever the answer is not a full one:
 * a capped call (a frame not loaded), a failed one, or a reply without its
 * frame id.
 */
const SKIP_FRAME_RE = /(?:^|\.)(?:recaptcha\.net|google\.com\/recaptcha|gstatic\.com|hcaptcha\.com|challenges\.cloudflare\.com|youtube(?:-nocookie)?\.com|vimeo\.com|doubleclick\.net|googletagmanager\.com|google-analytics\.com|facebook\.com\/(?:plugins|tr)|linkedin\.com\/px|bing\.com\/(?:bat|ms)|hotjar\.com|fullstory\.com)(?:\/|$)/i;
function skipFrame(url) {
  try { const u = new URL(String(url)); return SKIP_FRAME_RE.test(`${u.hostname}${u.pathname}`); } catch { return false; }
}
function framePlan(probe, loadId) {
  if (!loadId || !Array.isArray(probe) || !probe.length) return null;
  if (!probe.every((r) => Number.isInteger(r?.frameId) && r?.result?.jarvisProbe === 1)) return null;
  const plan = { resume: [], files: [], skipped: [] };
  for (const r of probe) {
    if (r.frameId !== 0 && skipFrame(r.result.url)) plan.skipped.push(r.frameId);
    else if (r.result.resident) plan.resume.push(r.frameId);
    else plan.files.push(r.frameId);
  }
  return plan;
}
/**
 * The injections a plan makes, together (S2; review 2026-11-07):
 *   - the resume group gets one call carrying this run's context as an
 *     argument (so it can never pick up another run's), and a frame that
 *     answers 'no-resume' (it navigated: a new document, no resident) or
 *     errs, or the whole call failing (one of its frames is gone), sends the
 *     files to those frames instead, one frame per call;
 *   - frames that appeared after the probe (an iframe added in between) are
 *     found again and sent the files, as allFrames would have.
 * A frame that went away costs only its own answer.
 */
const RESUME = (c) => (typeof globalThis.__jarvisResumeRun === 'function' ? globalThis.__jarvisResumeRun(c) : 'no-resume');
const LATE_FRAME_OK = /^https?:/i;
async function filesEach(tabId, frameIds) {
  const got = await Promise.allSettled(frameIds.map((id) => chrome.scripting.executeScript({ target: { tabId, frameIds: [id] }, files: INJECTED_FILES })));
  return got.filter((g) => g.status === 'fulfilled').flatMap((g) => g.value || []);
}
async function injectByPlan(tabId, plan, ctx = {}) {
  const calls = [];
  if (plan.resume.length) {
    calls.push(chrome.scripting.executeScript({ target: { tabId, frameIds: plan.resume }, func: RESUME, args: [ctx] }).then(
      (rs) => {
        const good = (rs || []).filter((r) => r && r.result !== 'no-resume' && !r.error);
        const redo = plan.resume.filter((id) => !good.some((r) => r.frameId === id));
        if (redo.length) note(`tab ${tabId}: ${redo.length} frame(s) no longer held the scripts — sending them the files`);
        return redo.length ? filesEach(tabId, redo).then((more) => [...good, ...more]) : good;
      },
      () => { note(`tab ${tabId}: the resume call failed — sending the files to those frames one by one`); return filesEach(tabId, plan.resume); },
    ));
  }
  if (plan.files.length) calls.push(chrome.scripting.executeScript({ target: { tabId, frameIds: plan.files }, files: INJECTED_FILES }));
  // Frames that came after the probe.
  if (chrome.webNavigation?.getAllFrames) {
    const known = new Set([...plan.resume, ...plan.files, ...plan.skipped]);
    calls.push(Promise.resolve(chrome.webNavigation.getAllFrames({ tabId })).then((frames) => {
      const late = (frames || []).filter((f) => Number.isInteger(f?.frameId) && !known.has(f.frameId) && LATE_FRAME_OK.test(String(f.url || '')) && !skipFrame(f.url)).map((f) => f.frameId);
      if (late.length) note(`tab ${tabId}: ${late.length} frame(s) appeared after the probe — sending them the files`);
      return late.length ? filesEach(tabId, late) : [];
    }, () => []));
  }
  const got = await Promise.allSettled(calls);
  const ok = got.filter((g) => g.status === 'fulfilled').flatMap((g) => g.value || []);
  if (!ok.length && got.some((g) => g.status === 'rejected')) throw got.find((g) => g.status === 'rejected').reason;
  return ok;
}

// The worker's own part of a run (S6): from the press to the scripts going in, per tab.
const INJECT_MS = new Map();
const TIMING_PHASES = ['total', 'inject', 'discover', 'plan', 'answers', 'resume', 'dropdowns', 'entries', 'waits'];
/** A run's timings as sent on: known phase names, whole non-negative ms, the slowest named phase; nothing else. */
function runTimingsFor(t, injectMs) {
  if (!t || typeof t !== 'object') return null;
  const out = {};
  for (const k of TIMING_PHASES) { const v = k === 'inject' ? injectMs : t[k]; if (Number.isFinite(v) && v >= 0) out[k] = Math.round(v); }
  if (TIMING_PHASES.includes(t.slowest)) out.slowest = t.slowest;
  if (t.hidden === true) out.hidden = true;
  // S5: [line, ms spent, ms asked, times, ms spent hidden] for the longest waits; numbers only.
  if (Array.isArray(t.waitSites)) {
    const sites = t.waitSites.filter((s) => Array.isArray(s) && s.length === 5 && s.every((x) => Number.isFinite(x) && x >= 0)).slice(0, 12).map((s) => s.map((x) => Math.round(x)));
    if (sites.length) out.waitSites = sites;
  }
  if (typeof t.v === 'string' && /^\d+(\.\d+){1,3}$/.test(t.v)) out.v = t.v;
  return Object.keys(out).length ? out : null;
}
async function inject(tabId, ctx = {}) {
  const injectBegan = Date.now();
  note(`tab ${tabId}: injecting (${ctx.auto ? 'follow-along' : 'press'})`);
  // A FRAME THAT NEVER LOADS HOLDS AN allFrames INJECTION FOREVER (F-571).
  // Measured 2026-09-24 on Lyft's careerpuck board: the Greenhouse form sits in
  // an iframe that had not loaded, `executeScript` waited on it, and these two
  // set-up calls — the only ones with no cap — never returned, so the fill
  // never started and the press hung. Chrome still injects each frame as it
  // becomes ready; only the waiting is capped.
  const setupCap = (p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('capped'), self.__jarvisSetupCap || SETUP_CAP_MS))]);
  // The same call says which frames already hold this load's scripts (S2).
  const ctxDone = await setupCap(chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (c) => {
      globalThis.__jarvisRun = c;
      const p = globalThis.__jarvisContent;
      return { jarvisProbe: 1, resident: !!(p && c && c.loadId && p.loadId === c.loadId && typeof globalThis.__jarvisResumeRun === 'function'), url: String(location.href) };
    },
    args: [ctx],
  }).catch((e) => note(`tab ${tabId}: context injection failed — ${String(e?.message || e).slice(0, 160)}`)));
  if (ctxDone === 'capped') note(`tab ${tabId}: a frame has not loaded — going on with the frames that have`);

  // netwatch.js goes into the PAGE's world, not ours. A content script has its
  // own fetch and its own XMLHttpRequest, so patching those here would watch
  // nothing — the application uses the page's. Extension-privileged injection
  // also gets past the page's own CSP, which Workday and Ashby both use to
  // forbid inline script. It is best-effort: a page that refuses it still fills.
  await setupCap(chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['netwatch.js'],
    world: 'MAIN',
  }).catch(() => {}));

  const plan = framePlan(ctxDone, ctx.loadId);
  if (INJECT_MS.size > 200) INJECT_MS.clear();
  INJECT_MS.set(tabId, Date.now() - injectBegan);
  note(plan ? `tab ${tabId}: scripts going in — ${plan.resume.length} frame(s) already hold them, ${plan.files.length} new, ${plan.skipped.length} widget frame(s) left alone` : `tab ${tabId}: scripts going in`);
  // A NAVIGATION UNDER THE INJECTION CAN LEAVE THIS PROMISE UNSETTLED FOREVER
  // (F-380). Measured on Amazon: the press followed Apply, the page became
  // /applicant/jobs/…/summary, and executeScript neither resolved nor
  // rejected — so the run stayed in RUNNING, every follow-along after it was
  // swallowed as `pending`, and the tab did nothing at all. The page reports
  // its own result by message, so the worker never actually needs this promise
  // to be correct; it only needs to stop waiting. The cap is generous, because
  // a real run legitimately takes minutes while a resume is written.
  const results = await Promise.race([
    plan ? injectByPlan(tabId, plan, ctx) : chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // Order matters: ats.js and discover.js define globals content.js uses.
      files: INJECTED_FILES,
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
    // THE SAME QUESTION, not one whose words contain it (F-909): TI's required
    // "U.S. Immigration Form: Do you currently hold an H, L, E, J, or F
    // nonimmigrant visa…" left the list though nobody answered it. An entry
    // is "[step N: ]label" or "…label (why)" / "…label — why".
    for (const label of done.answered || []) {
      if (!label) continue;
      const l = String(label);
      acc.unanswered = acc.unanswered.filter((u) => {
        const s = String(u).replace(/^step\s+\d+:\s*/i, '');
        return !(s === l || s.startsWith(`${l} (`) || s.startsWith(`${l} —`));
      });
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
    // A TEST DRIVE IS NOT HIS WORK (2026-09-25). The drive harness marks its
    // own throwaway profile; a fill it reports is not recorded as "prepared"
    // on his row — its fill times had started to match his receipts.
    const harness = await chrome.storage.local.get('jarvisHarness').then((s) => s?.jarvisHarness === true).catch(() => false);
    return await api('/api/filled', { tabId, method: 'POST', body: {
      id,
      harness,
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
      // What the resume opener saw when nothing was attached (F-896).
      resumeNote: body.resumeNote || done.resumeNote || '',
      reachedReview: body.reachedReview,
      // WHERE THIS RUN'S TIME WENT (S6): phase names and whole ms only, plus the
      // worker's own setup. Nothing of the page or his answers.
      timings: runTimingsFor(done.timings, INJECT_MS.get(tabId)),
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
const RUNNING = new Map();   // tabId -> { since, pending, token, lastStep }
const RUN_EXPIRY_MS = 6 * 60 * 1000;

/**
 * THE FILL STOPS ON A POSTING THE VISA GATE BARS (his "1. ye", 2026-11-12):
 * citizens or green card only, a U.S. person with no licence route, an
 * employer that will not sponsor. The server names the reasons
 * (/api/panel's `stop`, jarvis/fill-stop.mjs); this is the one place every
 * fill passes through — the toolbar press, the panel's button, the
 * dashboard's open and press, the next page of an armed tab — so nothing is
 * written to the page, no Apply is pressed, no file is attached.
 *
 * "Fill anyway" is his: only the panel's button sets it (`st.anyway`, the job
 * id), never a message from the dashboard. It holds for that posting through
 * all its pages; a different posting in the same tab asks again.
 *
 * Silence is not a bar: a page the store does not know, a dashboard that does
 * not answer in time, or no reason at all, and the fill goes on as before.
 */
const STOPPED = new Map();   // tabId -> { id, reasons, at }: the posting this tab did not fill
const FILL_STOP_LIMIT_MS = 8000;
async function fillStopFor(tabId, st) {
  let t;
  const r = await Promise.race([
    panelFor(tabId).catch(() => null),
    new Promise((res) => { t = setTimeout(() => res(null), FILL_STOP_LIMIT_MS * (self.__jarvisTimeScale || 1)); }),
  ]).finally(() => clearTimeout(t));
  if (!r?.ok) return null;
  const id = r.data?.job?.id != null ? String(r.data.job.id) : '';
  const reasons = (Array.isArray(r.data?.stop?.reasons) ? r.data.stop.reasons : []).map(String).filter(Boolean).slice(0, 3);
  // A DIFFERENT POSTING ENDS HIS FILL ANYWAY (First Mate's review): the tab
  // that went A, B, A asks again on A. A page the store does not know (no id)
  // leaves it, so a sign-in page in the middle of A's application does not.
  if (id && st?.anyway && String(st.anyway) !== id) { st.anyway = null; await saveArmed(); }
  if (!id || !reasons.length) return null;
  if (st?.anyway && String(st.anyway) === id) return null;
  return { id, reasons };
}
self.fillStopFor = fillStopFor;
// A RUN THAT SHOWS NOTHING DOES NOT HOLD THE TAB (F-994, Maven 2026-11-04): the
// worker said "scripts going in", the route changed, frames loaded, and no step
// came from the page for four minutes; every later press was swallowed as
// "already running". A run is alive while its page reports (`page-live`); one
// quiet this long gives way to the next press or navigation.
const RUN_STALL_MS = 2 * 60 * 1000;

/** What a new run on a tab does about the one already there: 'start', 'wait' (mark pending) or 'takeover'. */
function runGate(running, now = Date.now()) {
  if (!running) return 'start';
  // ITS PAGE IS GONE (F-1010, Micron's Eightfold 2026-11-05): a new document
  // committed in the tab after the run began, so its script went with the old
  // one. Nothing will come from it; the page that replaced it is the next run's.
  if (running.pageGoneAt && running.pageGoneAt >= running.since) return 'takeover';
  if (now - running.since >= RUN_EXPIRY_MS) return 'takeover';
  if (now - (running.lastStep || running.since) >= RUN_STALL_MS) return 'takeover';
  return 'wait';
}

/**
 * A FOLLOW PARKED BEHIND A RUN THAT NEVER ANSWERS IS LOOKED AT AGAIN (F-1010).
 * Micron's Eightfold, 2026-11-05: the first press on the posting stalled at 0
 * filled, twice. A follow that met a live run was marked `pending` and only
 * that run's end could start it — and a run whose page went away under it may
 * never end, so the tab sat until he reloaded and pressed again. Each parked
 * follow sets one alarm per tab, a little past the stall time: if a run is
 * still parked then (or the worker restarted and forgot it), the tab is
 * followed again through the same gate, which by then lets a silent run go.
 * An alarm, not a timer: a worker that sleeps forgets its timers.
 */
const WAKE_ALARM = 'jarvis-wake:';
function wakeLater(tabId) {
  try { chrome.alarms?.create?.(`${WAKE_ALARM}${tabId}`, { when: Date.now() + RUN_STALL_MS + 5000 }); } catch { /* the run's own end still follows */ }
}
async function wakeParked(tabId) {
  const r = RUNNING.get(tabId);
  if (r && !r.pending) return false;          // the run is going, and nothing waits on it
  if (!(await armedState(tabId))) return false;
  follow(tabId, 'a follow waited on a run that never answered');
  return true;
}
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (!String(alarm?.name || '').startsWith(WAKE_ALARM)) return false;
  return wakeParked(Number(alarm.name.slice(WAKE_ALARM.length)));
});

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
async function runOnTab(tabId, { auto = false, reset = false, checkOnly = false } = {}) {
  if (!tabId) return null;
  const running = RUNNING.get(tabId);
  const gate = runGate(running);
  if (gate === 'wait') { running.pending = true; wakeLater(tabId); return null; }
  if (gate === 'takeover') {
    note(running.pageGoneAt >= running.since
      ? `tab ${tabId}: the last run's page was replaced by a new one — starting on it`
      : `tab ${tabId}: the last run showed nothing for ${Math.round((Date.now() - (running.lastStep || running.since)) / 1000)} s — starting again`);
  }
  // A token, so a stalled run that ends late cannot clear the run that replaced
  // it — and the page claims itself with it, so the old script stops at its
  // next step instead of typing beside the new one (F-994 review).
  const token = `${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  RUNNING.set(tabId, { since: Date.now(), pending: false, token, lastStep: 0 });

  const st = await armedState(tabId);
  badge(tabId, '…', '#888888');
  // Held for the whole run so the version alarm cannot reload the worker out
  // from under a half-filled form.
  BUSY += 1;
  try {
    // A BARRED POSTING IS NOT FILLED until he presses Fill anyway (above).
    const stop = checkOnly ? null : await fillStopFor(tabId, st);
    if (stop) {
      STOPPED.set(tabId, { ...stop, at: Date.now() });
      badge(tabId, '!', '#b42318');
      title(tabId, `Not filled: this posting is blocked — ${stop.reasons[0]}`.slice(0, 500) + '. Open the Jarvis panel and press Fill anyway to fill it.');
      note(`tab ${tabId}: not filled — posting ${stop.id} is blocked: ${stop.reasons[0].slice(0, 160)}`);
      return [];
    }
    STOPPED.delete(tabId);
    if (!checkOnly) FILLED_AT.set(tabId, Date.now());
    const summaries = await inject(tabId, {
      armed: !!st, auto, reset, started: !!st?.started, checkOnly, runToken: token,
      id: st?.id || null, company: st?.company || null, title: st?.title || null,
      gone: GONE_TABS.get(tabId) || null,
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
    const mine = RUNNING.get(tabId);
    const again = mine?.token === token ? mine.pending : false;
    if (mine?.token === token) RUNNING.delete(tabId);
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
    Object.assign(st, { id: null, company: null, title: null, token: null, started: false, anyway: null, acc: emptyAcc() });
    await saveArmed();
  }
  paint(tabId);
}

// A full page load in an armed tab.
chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  follow(tabId, 'the page loaded', tab?.url || '');
});

/**
 * NEVER LET THE BROWSER THROW AN UNSENT LINKEDIN MESSAGE AWAY (2026-10-05).
 *
 * opera-fill.mjs leaves each message filled in a background tab for him to
 * send. At 0.5 GB free, Opera discarded two of them (Benjamin, Riley); a
 * click reloaded the compose page empty. The same fix as an armed application
 * tab: a LinkedIn compose tab is kept in memory. LinkedIn's own pages are
 * never armed, so nothing else ever hands these tabs back — closing one, or
 * sending (the page leaves /compose), ends it.
 */
const LINKEDIN_COMPOSE = /^https:\/\/www\.linkedin\.com\/messaging\/(?:compose|thread\/new)\b/;
function keepLinkedInCompose(tabId, url) {
  if (LINKEDIN_COMPOSE.test(String(url || ''))) chrome.tabs?.update?.(tabId, { autoDiscardable: false })?.catch?.(() => {});
}
chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => keepLinkedInCompose(tabId, info.url || tab?.url));
// Tabs filled before the extension (re)loaded are protected the moment it does.
async function keepOpenLinkedInComposes() {
  const tabs = await chrome.tabs?.query?.({ url: 'https://www.linkedin.com/messaging/*' })?.catch?.(() => []) || [];
  for (const t of tabs) keepLinkedInCompose(t.id, t.url);
}
chrome.runtime?.onInstalled?.addListener(keepOpenLinkedInComposes);
chrome.runtime?.onStartup?.addListener(keepOpenLinkedInComposes);
self.keepOpenLinkedInComposes = keepOpenLinkedInComposes;

/**
 * THE OUTREACH SEND SESSION, IN CHROME (2026-10-24).
 *
 * He moved off Opera ("can we just use chrome"), and Chrome ignores the
 * debugging port on its main profile, so the fill that opera-fill.mjs did over
 * that port runs here instead. The dashboard's "Send all" asks for it: every
 * saved, unsent message (the server's send queue, 21 days, with the resume)
 * opens in one Outreach window, a tab each, filled in the page's own world by
 * linkedin-page.js — subject, message, resume. His workflow: "see all tabs are
 * up take quicklook then send". Each tab is then watched; once its text is in
 * the thread and gone from the box, it is marked sent and closes itself.
 *
 * An ordinary session never presses Send. A SCHEDULED one (2026-10-24, "can
 * we schedule send it"; outreach-schedule.mjs) does, but only when the server
 * says the schedule is due (autoSend on the send queue), and only per tab
 * whose checks all pass (linkedin-page.js send). A LinkedIn sign-in or
 * security check stops the whole session: those are his, never solved here.
 */
try { importScripts('linkedin-page.js'); } catch { /* a harness that loads this file bare */ }
const OUTREACH_KEY = 'jarvisOutreachSession';
const OUTREACH_ALARM = 'jarvis-outreach-watch';
const OUTREACH_WATCH_MS = 3 * 3600e3;   // tabs watched this long, then left open and unmarked
let OUTREACH = null;
let OUTREACH_WATCHING = false;
const outreachWait = (ms) => new Promise((r) => setTimeout(r, ms * (self.__jarvisOutreachScale ?? 1)));
const linkedInPage = () => globalThis.JarvisLinkedIn || null;

async function saveOutreach() {
  try { await chrome.storage?.local?.set?.({ [OUTREACH_KEY]: OUTREACH }); } catch { /* memory still has it */ }
}
async function loadOutreach() {
  if (OUTREACH) return OUTREACH;
  try { OUTREACH = (await chrome.storage?.local?.get?.(OUTREACH_KEY))?.[OUTREACH_KEY] || null; } catch { OUTREACH = null; }
  return OUTREACH;
}
const outreachLive = () => !!OUTREACH && OUTREACH.phase !== 'done';

/** What the dashboard shows: one line per person, nothing it does not need. */
function outreachSummary() {
  if (!OUTREACH) return null;
  const { phase, note, startedAt, stale = [], noResume = [], kind = 'message' } = OUTREACH;
  return { phase, note, startedAt, stale, noResume, kind, entries: OUTREACH.entries.map(({ id, name, status, note: n, credit, connect }) => ({ id, name, status, note: n || '', credit: credit || '', connect: connect || '' })) };
}

/** One function from linkedin-page.js, run in the page's own world; its return value. */
async function runInPage(tabId, func, args = []) {
  let timer;
  try {
    const r = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('the page did not answer within 90 s')), 90000 * (self.__jarvisOutreachScale ?? 1)); }),
    ]);
    return r?.[0]?.result;
  } finally { clearTimeout(timer); }
}

const LINKEDIN_GATE = /linkedin\.com\/(?:checkpoint|login|uas\/|authwall|signup)/i;
async function tabLoaded(tabId) {
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === 'complete') return t;
    await outreachWait(400);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

/** Fill one tab: { ok, note, credit, gate }. The tab stays open either way; the caller decides. */
async function fillOutreachTab(tabId, p) {
  const LI = linkedInPage();
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  let out = '';
  for (let tries = 0; tries < 6; tries++) {
    const t = await tabLoaded(tabId);
    if (!t) return { ok: false, note: 'the tab was closed' };
    if (LINKEDIN_GATE.test(t.url || '')) return { ok: false, gate: true, note: 'LinkedIn asked you to sign in or pass a security check' };
    // The profile's Message link goes to the full-page compose ("RETRY"), and
    // a page mid-navigation refuses the script: both mean "again, once loaded".
    out = String(await runInPage(tabId, LI.fill, [{ name: p.name, first: p.first || String(p.name).split(/\s+/)[0], subject: p.subject, message: p.message, connectNote: p.connectNote || '' }])
      .catch((e) => `RETRY: ${e?.message || e}`) ?? 'RETRY: nothing came back');
    if (!/^RETRY/.test(out)) break;
    await outreachWait(2000);
  }
  if (!/^FILLED/.test(out)) return { ok: false, note: out.replace(/^(STOP|RETRY): /, '') };
  const attached = String(await runInPage(tabId, LI.attach, [{ as: p.as, pdf: p.pdf }]).catch((e) => `CHECK: ${e?.message || e}`));
  const credit = String(await runInPage(tabId, LI.creditLine).catch(() => '') || '');
  if (!/^ATTACHED/.test(attached)) return { ok: true, credit, note: 'the resume did not attach: add it by hand before sending' };
  // Would a scheduled send pass every check here? Checked, never pressed.
  const dry = String(await runInPage(tabId, LI.send, [{ ...sendArgs(p), dry: true }]).catch((e) => `STOP: ${e?.message || e}`) ?? '');
  return { ok: true, credit, note: '', sendable: /^SENDABLE/.test(dry), sendNote: dry.replace(/^(STOP|SENDABLE): /, '') };
}

/** What send() checks against: never the message itself or the resume bytes. */
function sendArgs(p) {
  const LI = linkedInPage();
  return { name: p.name, first: p.first || String(p.name).split(/\s+/)[0], subject: p.subject, marks: LI.draftMarks(p.message), as: p.as, ...(p.connectNote ? { connectNote: p.connectNote } : {}) };
}

async function startOutreach({ names = [], schedule = '' } = {}) {
  await loadOutreach();
  // A due schedule takes over a session that is only WATCHING old tabs (F-938:
  // a leftover watch turned the 11:54 send away as "already running").
  // Its unsent tabs are CLOSED: the new session opens its own, and a filled
  // leftover invited a second send (Taylor's, 12:30, after hers went at 12:02).
  // THE SAME SCHEDULE OPENED AGAIN (F-951) is its own session, finished: the
  // server re-opened it because the result never reached it. Its tabs are the
  // ones left for him; they are kept, and the result is sent again.
  if (schedule && OUTREACH?.phase === 'watching' && OUTREACH.schedule === schedule) {
    OUTREACH.reported = false;
    await reportScheduled();
    return { ok: true, already: true, session: outreachSummary() };
  }
  if (schedule && OUTREACH?.phase === 'watching') {
    for (const e of OUTREACH.entries || []) {
      if ((e.status === 'ready' || e.status === 'careful') && e.tabId != null) {
        await chrome.tabs.remove(e.tabId).catch(() => {});
        e.status = 'closed'; e.note = 'closed: a scheduled send took over';
      }
    }
    OUTREACH.phase = 'done'; await saveOutreach();
  }
  if (outreachLive()) return { ok: true, already: true, session: outreachSummary() };
  const LI = linkedInPage();
  if (!LI) return { ok: false, error: 'the LinkedIn page code did not load: reload the extension at chrome://extensions' };
  OUTREACH = { startedAt: Date.now(), phase: 'loading', note: '', entries: [] };
  await saveOutreach();
  runOutreach(names, schedule).catch(async (e) => { OUTREACH.phase = 'done'; OUTREACH.note = String(e?.message || e); await saveOutreach(); });
  return { ok: true, started: true };
}

async function runOutreach(names, schedule = '') {
  const LI = linkedInPage();
  const queuePath = schedule
    ? `/api/outreach/send-queue?schedule=${encodeURIComponent(schedule)}`
    : `/api/outreach/send-queue${names.length ? `?name=${encodeURIComponent(names.join(','))}` : ''}`;
  // THE QUEUE IS ASKED FOR UP TO THREE TIMES, AND A FAILURE SAYS SO (F-938).
  // 2026-10-26 the 11:10 schedule's queue answered so slowly (Chrome cold, ~1
  // GB free) that the session ended "done" with no entries and no note, and
  // nothing told him. Each try is bounded; three misses end the session with
  // the reason written down, and an unreported schedule is opened again by the
  // dashboard after its quiet time.
  let q = null;
  let why = '';
  for (let i = 0; i < 3 && !q; i += 1) {
    if (i) await outreachWait(5000 * i);
    let timer = null;
    q = await Promise.race([
      api(queuePath),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error('no answer in 45 s')), 45000 * (self.__jarvisOutreachScale ?? 1)); }),
    ]).catch((e) => { why = String(e?.message || e); return null; }).finally(() => clearTimeout(timer));
    if (q && !Array.isArray(q.people)) { why = q.error || 'the answer had no queue in it'; q = null; }
  }
  if (!q) {
    OUTREACH.phase = 'done';
    OUTREACH.note = `Could not read the send queue from the dashboard after 3 tries (${why}). Nothing was sent.`;
    await saveOutreach();
    return;
  }
  const people = q.people;
  // The server alone decides a session may press Send: a due schedule.
  OUTREACH.auto = !!(schedule && q?.autoSend && q?.schedule === schedule);
  OUTREACH.schedule = OUTREACH.auto ? schedule : '';
  if (schedule && !OUTREACH.auto && q?.note) OUTREACH.note = q.note;
  OUTREACH.stale = q?.stale || [];
  OUTREACH.noResume = q?.noResume || [];
  if (!people.length) {
    OUTREACH.phase = 'done'; OUTREACH.note = OUTREACH.note || 'Nothing waiting to send.'; await saveOutreach();
    if (OUTREACH.auto) await reportScheduled();
    return;
  }
  if (q?.kind === 'connect') return runConnects(people);
  OUTREACH.entries = people.map((p) => ({ id: p.id, name: p.name, profile: p.profile || '', status: 'queued', note: '', credit: '', connect: '', marks: LI.draftMarks(p.message), args: sendArgs(p), tabId: null, cleared: 0 }));
  OUTREACH.phase = 'filling';
  await saveOutreach();
  BUSY += 1;
  const failedTabs = [];
  try {
    // Its own window, every tab filled while it is the one on screen: the
    // editor and the paste want a focused page (what the DevTools route
    // emulated). Closing the window ends nothing he has not sent.
    const win = await chrome.windows.create({ url: people[0].profile, focused: true, state: 'maximized' });
    OUTREACH.windowId = win.id;
    for (const [i, p] of people.entries()) {
      const e = OUTREACH.entries[i];
      e.tabId = i === 0
        ? (win.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId: win.id }).catch(() => []))?.[0]?.id)
        : (await chrome.tabs.create({ windowId: win.id, url: p.profile, active: true }))?.id;
      e.status = 'filling';
      await saveOutreach();
      const r = e.tabId == null ? { ok: false, note: 'no tab opened' } : await fillOutreachTab(e.tabId, p);
      e.note = r.note || '';
      e.credit = r.credit || '';
      // Every fill reads LinkedIn's free/InMail line too: keep it with the Check InMail answers.
      if (r.credit) api('/api/outreach/credit', { method: 'POST', body: { contactId: p.id, credit: r.credit } }).catch(() => {});
      e.status = r.ok ? 'ready' : 'failed';
      e.sendable = !!r.sendable;
      e.sendNote = r.sendNote || '';
      if (!r.ok && e.tabId != null) failedTabs.push(e.tabId);
      await saveOutreach();
      scheduleAlive();
      if (r.gate) {
        // His to do; then he presses Send all again. Nothing below is opened.
        for (const rest of OUTREACH.entries.slice(i + 1)) { rest.status = 'failed'; rest.note = 'not opened: LinkedIn stopped the session'; }
        OUTREACH.note = 'LinkedIn asked you to sign in or pass a security check. Do that in the open tab, then press Send all again.';
        failedTabs.pop();
        break;
      }
    }
  } finally { BUSY -= 1; }
  const ready = OUTREACH.entries.filter((e) => e.status === 'ready');
  if (ready.length) {
    for (const id of failedTabs) await chrome.tabs.remove(id).catch(() => {});
    await chrome.tabs.update(ready[0].tabId, { active: true }).catch(() => {});
    if (OUTREACH.windowId != null) await chrome.windows.update(OUTREACH.windowId, { focused: true }).catch(() => {});
  }
  if (OUTREACH.auto && ready.length && !OUTREACH.entries.some((e) => /LinkedIn stopped/.test(e.note))) {
    BUSY += 1;                                       // resumeOutreach leaves a live pass alone
    try { await autoSendOutreach(); } finally { BUSY -= 1; }
  }
  const left = OUTREACH.entries.filter((e) => e.status === 'ready' || e.status === 'careful');
  OUTREACH.phase = left.length ? 'watching' : 'done';
  OUTREACH.watchFrom = Date.now();
  await saveOutreach();
  if (OUTREACH.auto) await reportScheduled();
  if (left.length) watchOutreach();
}

/** A wait the worker survives: Chrome ends an idle worker after 30 s. */
async function awakeWait(ms) {
  const end = Date.now() + ms * (self.__jarvisOutreachScale ?? 1);
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(15000, Math.max(0, end - Date.now()))));
    try { await chrome.storage?.local?.get?.(OUTREACH_KEY); } catch { /* only a heartbeat */ }
  }
}
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SEND_GAP_MS = () => 15000 + Math.floor(Math.random() * 5000);   // 15-20 s between sends (his call 2026-10-26: "a normal human only takes that much")

/**
 * The scheduled pass: one tab at a time, 15-20 s apart. A tab whose
 * checks fail stays filled for him. One press that does not show up in the
 * thread stops the pass: something is off, and the rest wait for him.
 */
async function autoSendOutreach() {
  const LI = linkedInPage();
  OUTREACH.phase = 'sending';
  await saveOutreach();
  let first = true;
  for (const e of OUTREACH.entries) {
    if (OUTREACH.phase !== 'sending') break;          // stopped from the dashboard
    if (e.status !== 'ready') continue;
    if (e.note || !e.sendable) { e.note = e.note || `not sent automatically: ${e.sendNote || 'the checks did not pass'}`; continue; }
    if (!first) await awakeWait(SEND_GAP_MS());
    first = false;
    if (OUTREACH.phase !== 'sending') break;
    if (!(await chrome.tabs.get(e.tabId).catch(() => null))) { e.status = 'closed'; e.note = 'its tab was closed before the scheduled send; still saved'; continue; }
    await chrome.tabs.update(e.tabId, { active: true }).catch(() => {});
    if (OUTREACH.windowId != null) await chrome.windows.update(OUTREACH.windowId, { focused: true }).catch(() => {});
    const pre = await runInPage(e.tabId, LI.sentCheck, [e.marks]).catch(() => null);
    if (pre && LI.sentState(pre) === 'already') { e.status = 'careful'; e.note = 'this text is already in your conversation with them: NOT sent again'; await saveOutreach(); continue; }
    scheduleAlive();
    const r = String(await runInPage(e.tabId, LI.send, [e.args]).catch((err) => `STOP: ${err?.message || err}`) ?? 'STOP: nothing came back');
    if (!/^PRESSED/.test(r)) { e.note = `not sent automatically: ${r.replace(/^STOP: /, '')}`; await saveOutreach(); continue; }
    for (let i = 0; i < 12 && e.status === 'ready'; i++) { await outreachWait(2000); await checkOutreachTab(e); }
    await saveOutreach();
    if (e.status !== 'sent') {
      if (e.status === 'ready') {
        // No credits left: LinkedIn refuses the InMail with a line in the compose window (Chris, 2026-10-26).
        const c = String((await runInPage(e.tabId, LI.creditLine, []).catch(() => '')) || '');
        e.note = /none left/.test(c)
          ? 'not sent: LinkedIn says you have no InMail credits left'
          : 'Send was pressed but the message did not show in the thread: look at this tab';
      }
      OUTREACH.note = 'Stopped after one message did not show as sent; the rest are filled and wait for you.';
      break;
    }
  }
}

/** Tell the server (the schedule's record) and him (a Chrome notification) how it went. */
/** A scheduled session's sign of life (F-951). Never waited on, never fatal. */
function scheduleAlive() {
  if (!OUTREACH?.schedule) return;
  api('/api/outreach/schedule/alive', { method: 'POST', body: { id: OUTREACH.schedule } }).catch(() => {});
}

async function reportScheduled() {
  if (!OUTREACH?.schedule || OUTREACH.reported) return;
  const sent = OUTREACH.entries.filter((e) => e.status === 'sent').map((e) => e.name);
  const left = OUTREACH.entries.filter((e) => e.status !== 'sent').map((e) => ({ name: e.name, note: e.note || e.status }));
  // Tried three times (F-951): a result that never arrived left the schedule
  // "launched", and the server opened the finished session again.
  for (let i = 0; i < 3 && !OUTREACH.reported; i++) {
    if (i) await outreachWait(5000);
    const r = await api('/api/outreach/schedule/result', { method: 'POST', body: { id: OUTREACH.schedule, sent, left, note: OUTREACH.note || '' } }).catch(() => null);
    if (r && r.ok) OUTREACH.reported = true;
  }
  try {
    chrome.notifications?.create?.(`jarvis-outreach-${OUTREACH.schedule}`, {
      type: 'basic', iconUrl: ICON, title: 'Jarvis scheduled send',
      message: `Sent ${sent.length} of ${OUTREACH.entries.length}.${left.length ? ` Waiting for you: ${left.map((l) => l.name).join(', ')}.` : ''}`,
    });
  } catch { /* the dashboard still shows it */ }
  await saveOutreach();
}

/**
 * After a message went out: their profile in the same tab, then Connect with no
 * note (linkedin-page.js connect). Returns LinkedIn's answer as one line for the
 * Outreach tab: CONNECTED, ALREADY, or STOP with the reason. A sign-in or
 * security page stops it, as everywhere else.
 */
/**
 * A scheduled CONNECT pass (2026-10-26, out of InMail): each profile in one
 * window, Connect → "Add a note" → his note → Send, 15-20 s apart. No message
 * is typed. Only when the server called the schedule due; each invitation
 * that shows Pending is marked invited. Their accept (Gmail) schedules the
 * saved message itself.
 */
async function runConnects(people) {
  OUTREACH.kind = 'connect';
  OUTREACH.entries = people.map((p) => ({ id: p.id, name: p.name, profile: p.profile || '', status: 'queued', note: '', credit: '', connect: '', marks: [], args: { first: p.first }, tabId: null, cleared: 0 }));
  if (!OUTREACH.auto) {
    for (const e of OUTREACH.entries) { e.status = 'failed'; e.note = 'not due: connection requests go only in a scheduled window'; }
    OUTREACH.phase = 'done'; await saveOutreach();
    return;
  }
  OUTREACH.phase = 'sending';
  await saveOutreach();
  BUSY += 1;
  try {
    const win = await chrome.windows.create({ url: people[0].profile, focused: true, state: 'maximized' });
    OUTREACH.windowId = win.id;
    const tabId = win.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId: win.id }).catch(() => []))?.[0]?.id;
    for (const [i, p] of people.entries()) {
      const e = OUTREACH.entries[i];
      if (OUTREACH.phase !== 'sending') break;
      if (i) await awakeWait(SEND_GAP_MS());
      e.status = 'filling';
      await saveOutreach();
      const r = tabId == null ? 'STOP: no tab opened' : await connectAfterSend(tabId, e, p.note);
      e.connect = r;
      if (/^CONNECTED/.test(r)) {
        e.status = 'sent';
        await api('/api/outreach/mark', { method: 'POST', body: { contactId: p.id, what: 'invited' } }).catch(() => {});
      } else { e.status = 'failed'; e.note = r.replace(/^(STOP|CHECK|ALREADY): /, ''); }
      await saveOutreach();
      if (/sign in or pass a security check/.test(r)) {
        for (const rest of OUTREACH.entries.slice(i + 1)) { rest.status = 'failed'; rest.note = 'not opened: LinkedIn stopped the session'; }
        OUTREACH.note = 'LinkedIn asked you to sign in or pass a security check; the rest were not sent.';
        break;
      }
    }
    // A second try for anyone whose page never loaded or whose menu never
    // showed Connect (2026-10-27: 14 of 16 lost to a slow machine).
    const again = OUTREACH.phase === 'sending' && !OUTREACH.note && tabId != null
      ? OUTREACH.entries.map((e, i) => [e, people[i]]).filter(([e]) => e.status === 'failed' && /never loaded|Follow only|did not answer|nothing came back/i.test(e.note)) : [];
    for (const [e, p] of again) {
      if (OUTREACH.phase !== 'sending') break;
      await awakeWait(SEND_GAP_MS());
      e.status = 'filling'; e.note = '';
      await saveOutreach();
      const r = await connectAfterSend(tabId, e, p.note);
      e.connect = r;
      if (/^CONNECTED/.test(r)) {
        e.status = 'sent';
        await api('/api/outreach/mark', { method: 'POST', body: { contactId: p.id, what: 'invited' } }).catch(() => {});
      } else { e.status = 'failed'; e.note = r.replace(/^(STOP|CHECK|ALREADY): /, '') + ' (tried twice)'; }
      await saveOutreach();
      if (/sign in or pass a security check/.test(r)) { OUTREACH.note = 'LinkedIn asked you to sign in or pass a security check; the rest were not sent.'; break; }
    }
    if (win?.id != null && !OUTREACH.note) await chrome.windows.remove(win.id).catch(() => {});
  } finally { BUSY -= 1; }
  OUTREACH.phase = 'done';
  await saveOutreach();
  await reportScheduled();
}

async function connectAfterSend(tabId, e, note = '') {
  const LI = linkedInPage();
  if (!LI?.connect) return 'STOP: the extension has no connect step (reload it)';
  if (!/linkedin\.com\/in\//.test(e.profile || '')) return 'STOP: no profile link saved for them';
  // Visible, so Chrome does not slow the page (F-941: a run window behind
  // other apps had every profile time out).
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true, state: 'maximized' }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true, autoDiscardable: false }).catch(() => {});
  await chrome.tabs.update(tabId, { url: e.profile }).catch(() => {});
  await outreachWait(1200);
  let out = '';
  for (let tries = 0; tries < 3; tries++) {
    const t = await tabLoaded(tabId);
    if (!t) return 'STOP: the tab was closed';
    if (LINKEDIN_GATE.test(t.url || '')) return 'STOP: LinkedIn asked you to sign in or pass a security check';
    out = String(await runInPage(tabId, LI.connect, [{ name: e.name, first: e.args?.first || String(e.name).split(/\s+/)[0], ...(note ? { note } : {}) }])
      .catch((err) => `RETRY: ${err?.message || err}`) ?? 'RETRY: nothing came back');
    if (!/^RETRY/.test(out)) break;
    await outreachWait(2000);
  }
  return out.replace(/^RETRY: /, 'STOP: ');
}

/**
 * THE INMAIL CHECK (2026-10-26, his words: "build a inmail checker maybe sth
 * that clicks on message and see what it says"). For every saved, unsent
 * message: its profile in a background window, Message pressed (fill with
 * `peek`: the compose opens, nothing is typed), LinkedIn's own line read
 * ("Free message" / "Use 1 of N InMail credits"), the tab closed. Each answer
 * goes to the server (/api/outreach/credit) and shows on the Outreach tab.
 * Paced a few seconds apart; a sign-in or security page stops it.
 */
let CREDIT_CHECK = null;
async function checkCredits(names = []) {
  if (CREDIT_CHECK?.phase === 'checking') return { ok: true, already: true, check: CREDIT_CHECK };
  const LI = linkedInPage();
  if (!LI) return { ok: false, error: 'the LinkedIn page code did not load: reload the extension at chrome://extensions' };
  const q = await api(`/api/outreach/send-queue?pdf=0${names.length ? `&name=${encodeURIComponent(names.join(','))}` : ''}`).catch(() => null);
  const people = q?.people || [];
  CREDIT_CHECK = { phase: people.length ? 'checking' : 'done', startedAt: Date.now(), note: people.length ? '' : 'Nothing waiting to check.', entries: people.map((p) => ({ id: p.id, name: p.name, credit: '', note: '' })) };
  if (people.length) runCreditCheck(people).catch((e) => { CREDIT_CHECK.phase = 'done'; CREDIT_CHECK.note = String(e?.message || e); });
  return { ok: true, started: !!people.length, check: CREDIT_CHECK };
}

async function runCreditCheck(people) {
  const LI = linkedInPage();
  BUSY += 1;
  let win = null;
  try {
    // The blank first tab stays until the end: closing a window's last tab
    // closes the window, and the next person had nowhere to open (2026-10-26).
    win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal', width: 900, height: 700 });
    for (const [i, p] of people.entries()) {
      const e = CREDIT_CHECK.entries[i];
      if (i) await outreachWait(3000 + Math.floor(Math.random() * 4000));
      const tab = await chrome.tabs.create({ windowId: win.id, url: p.profile, active: true }).catch(() => null);
      if (!tab) { e.note = 'no tab opened'; continue; }
      let out = '';
      for (let tries = 0; tries < 6; tries++) {
        const t = await tabLoaded(tab.id);
        if (!t) { out = 'STOP: the tab was closed'; break; }
        if (LINKEDIN_GATE.test(t.url || '')) { out = 'GATE'; break; }
        out = String(await runInPage(tab.id, LI.fill, [{ name: p.name, first: p.first || String(p.name).split(/\s+/)[0], subject: '', message: '', peek: true }])
          .catch((err) => `RETRY: ${err?.message || err}`) ?? 'RETRY: nothing came back');
        if (!/^RETRY/.test(out)) break;
        await outreachWait(2000);
      }
      if (out === 'GATE') {
        e.note = 'LinkedIn asked you to sign in or pass a security check';
        CREDIT_CHECK.note = 'Stopped: LinkedIn asked you to sign in or pass a security check. Do that, then check again.';
        break;
      }
      // Give the line above the box a moment to draw.
      let credit = '';
      for (let k = 0; k < 8 && !credit; k++) { credit = String(await runInPage(tab.id, LI.creditLine).catch(() => '') || ''); if (!credit) await outreachWait(500); }
      e.credit = credit;
      if (!/^OPEN/.test(out)) e.note = out.replace(/^(STOP|RETRY): /, '');
      else if (!credit) e.note = 'the message window opened but LinkedIn showed neither "Free message" nor an InMail count';
      await api('/api/outreach/credit', { method: 'POST', body: { contactId: p.id, credit, note: e.note } }).catch(() => {});
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  } finally {
    BUSY -= 1;
    if (win?.id != null) chrome.windows.remove(win.id).catch(() => {});
    CREDIT_CHECK.phase = 'done';
  }
}
self.checkCredits = checkCredits;

/** One look at one tab: sent, still waiting, or something he should know. */
async function checkOutreachTab(e) {
  const LI = linkedInPage();
  const tab = await chrome.tabs.get(e.tabId).catch(() => null);
  if (!tab) { e.status = 'closed'; e.note = 'closed without sending; still saved for next time'; return; }
  const r = await runInPage(e.tabId, LI.sentCheck, [e.marks]).catch(() => null);
  if (!r) return;
  const state = LI.sentState(r);
  if (state === 'sent') {
    e.status = 'sent';
    e.note = '';
    try { await api('/api/outreach/mark', { method: 'POST', body: { contactId: e.id, what: 'sent' } }); } catch { e.note = 'sent, but the dashboard did not take the mark: mark it on the Outreach tab'; }
    const tabId = e.tabId;
    await outreachWait(1500);
    // CONNECT TOO (his call, 2026-10-26): the same tab goes to their profile.
    e.connect = await connectAfterSend(tabId, e).catch((err) => `STOP: ${err?.message || err}`);
    await saveOutreach();
    chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  if (state === 'already') {
    e.status = 'careful';
    e.note = 'this text is already in your conversation with them: if it went out before, do not send it again';
    return;
  }
  // Box emptied but the text is not in the thread: give LinkedIn a few looks
  // to draw it, then call it unclear rather than guess.
  if (state === 'cleared') {
    e.cleared = (e.cleared || 0) + 1;
    if (e.cleared >= 8) { e.status = 'unclear'; e.note = 'the box emptied but the message is not in the thread; NOT marked (mark it on the Outreach tab if you sent it)'; }
    return;
  }
  e.cleared = 0;
}

async function watchOutreach() {
  if (OUTREACH_WATCHING) return;
  OUTREACH_WATCHING = true;
  // The alarm wakes a worker Chrome put to sleep; the loop keeps it awake.
  try { chrome.alarms?.create?.(OUTREACH_ALARM, { periodInMinutes: 0.5 }); } catch { /* the loop alone */ }
  try {
    while (OUTREACH?.phase === 'watching') {
      const waiting = OUTREACH.entries.filter((e) => e.status === 'ready' || e.status === 'careful');
      if (!waiting.length) { OUTREACH.phase = 'done'; break; }
      if (Date.now() - (OUTREACH.watchFrom || 0) > OUTREACH_WATCH_MS) {
        for (const e of waiting) { e.status = 'timeout'; e.note = 'not sent in 3 hours: tab left open, still saved as unsent'; }
        OUTREACH.phase = 'done';
        break;
      }
      for (const e of waiting) await checkOutreachTab(e);
      await saveOutreach();
      await outreachWait(3000);
    }
  } finally {
    OUTREACH_WATCHING = false;
    await saveOutreach();
    if (!outreachLive()) { try { chrome.alarms?.clear?.(OUTREACH_ALARM); } catch { /* none */ } }
  }
}

/** After the worker slept or the extension reloaded: carry on watching. */
async function resumeOutreach() {
  await loadOutreach();
  if (!OUTREACH) return;
  // A scheduled pass cut off mid-way never picks up pressing Send again: what is left waits for him.
  if (OUTREACH.phase === 'sending') {
    if (BUSY > 0) return;
    OUTREACH.phase = 'watching';
    OUTREACH.note = 'The scheduled send was interrupted; what is left is filled and waits for you.';
    await saveOutreach();
  }
  if (OUTREACH.phase === 'loading' || OUTREACH.phase === 'filling') {
    if (BUSY > 0) return;
    for (const e of OUTREACH.entries) if (e.status === 'queued' || e.status === 'filling') { e.status = 'failed'; e.note = 'interrupted before it was filled; still saved'; }
    OUTREACH.phase = OUTREACH.entries.some((e) => e.status === 'ready') ? 'watching' : 'done';
    await saveOutreach();
  }
  if (OUTREACH.phase === 'watching') watchOutreach();
}
chrome.alarms?.onAlarm?.addListener((alarm) => (alarm.name === OUTREACH_ALARM ? resumeOutreach() : false));
try { resumeOutreach().catch(() => {}); } catch { /* no storage in a bare harness */ }
Object.assign(self, { startOutreach, outreachSummary, resumeOutreach, checkOutreachTab });

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

// A POSTING THE SITE REDIRECTED AS NOT FOUND (Rippling, Aalo Atomics,
// 2026-09-25): the landing address carries ?rr_message=job_not_found, and the
// board's router rewrites it away before the filler runs. Remembered per tab
// until the tab commits another address, and handed to the next run.
const GONE_TABS = new Map();
// A CONFIRMATION IN A TAB JARVIS FILLED, ARMED OR NOT (F-1002, 2026-11-04).
// Re:Build's Greenhouse form went to its /confirmation page in a tab he had
// disarmed, so nothing read it and the card stayed un-applied. A tab Jarvis
// ran in during the last two hours that lands on a confirmation-shaped URL
// gets a look — a check-only run that reports the thank-you and fills nothing.
const FILLED_AT = new Map();   // tabId -> when Jarvis last ran in it
const LOOK_WINDOW_MS = 2 * 60 * 60 * 1000;
function lookForConfirmation(tabId, url) {
  if (!tabId || ARMED.has(tabId)) return false;    // an armed tab follows on its own
  const at = FILLED_AT.get(tabId);
  if (!at || Date.now() - at > LOOK_WINDOW_MS) return false;
  let p = '';
  try { p = new URL(url).pathname; } catch { return false; }
  const re = self.__jarvisAts?.CONFIRMATION_URL_RE;
  if (!re || !re.test(p)) return false;
  note(`tab ${tabId}: a confirmation page in a tab Jarvis filled — looking for the thank-you`);
  setTimeout(() => { runOnTab(tabId, { auto: true, checkOnly: true }).catch?.(() => {}); }, 2500);
  return true;
}

/**
 * HE TOOK THE TAB SOMEWHERE ELSE (F-1013 #5, review 2026-11-05). An armed tab
 * stayed armed for six hours whatever he did with it, so typing another site
 * into it got that site's "Sign in with Google" pressed and its cookie and
 * consent boxes clicked. An application moves between hosts on its own (the
 * company site, its ATS, Google's sign-in and back) by links and redirects;
 * he leaves it by the address bar, a bookmark, a search or the start page. A
 * new SITE reached that way stands the tab down. A reload, or the same site
 * typed again, does not.
 */
const LEFT_BY_HAND = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'start_page']);
const LAST_TOP_URL = new Map();
const siteOf = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
function leftByHand(d) {
  const prev = LAST_TOP_URL.get(d.tabId);
  if (LAST_TOP_URL.size > 500) LAST_TOP_URL.clear();
  LAST_TOP_URL.set(d.tabId, d.url);
  return LEFT_BY_HAND.has(String(d.transitionType || '')) && !!siteOf(prev) && siteOf(prev) !== siteOf(d.url);
}

chrome.webNavigation?.onCommitted?.addListener((d) => {
  if (d.frameId !== 0) return;
  if (leftByHand(d)) disarm(d.tabId, `he took the tab to ${siteOf(d.url)} himself`);
  // A new document in the tab: a run on the old one is gone with it (F-1010).
  const run = RUNNING.get(d.tabId);
  if (run) run.pageGoneAt = Date.now();
  if (/[?&](rr_message|message|error)=job[_-]?not[_-]?found/i.test(d.url || '')) GONE_TABS.set(d.tabId, 'job not found');
  else GONE_TABS.delete(d.tabId);
  lookForConfirmation(d.tabId, d.url);
  noticeNavigation(d.tabId, d.url);
  return seenNavigation(d.tabId, d.url);   // returned for the tests; Chrome ignores it
});

// A frame load, a pushState route change, a hash-router change in an armed
// tab. Workday moves between "Apply Manually" and step one with pushState;
// Greenhouse's embedded form lives in an iframe that loads after the page
// does; some boards route on the hash. `tabs.onUpdated` sees none of them.
// The tab's own route only (F-1013, review 12a): an embedded board's iframe
// routing to another posting's id wiped the tab's application.
chrome.webNavigation?.onHistoryStateUpdated?.addListener((d) => { if (d.frameId === 0 || d.frameId == null) { noticeNavigation(d.tabId, d.url); seenNavigation(d.tabId, d.url); } nudgePanel(d.tabId); follow(d.tabId, 'the page changed route', d.url); });
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
  // THE JOB GOES WITH THE TAB IT OPENED, armed or not (F-791): LinkedIn's
  // Apply and most "Apply on company site" buttons open the form in a new tab.
  // The child's first page may be any host; from there the usual rule holds.
  const seen = await seenJob(openerTabId);
  if (seen && !(await seenJob(newTabId))) {
    SEEN.set(newTabId, { ...seen, host: '', at: Date.now() });
    await saveSeen();
    note(`tab ${newTabId} opened from tab ${openerTabId} — still ${seen.company || seen.id}`);
  }
  const parent = await armedState(openerTabId);
  if (!parent) return;
  if (Date.now() - (parent.followingAt || 0) > FOLLOWING_WINDOW_MS) return;
  if (ARMED.has(newTabId)) return;
  // His Fill anyway goes with it (F-1051): the form Apply opened is the same
  // posting, and the override only ever matches that posting's id.
  await arm(newTabId, { id: parent.id, company: parent.company, title: parent.title, token: parent.token, started: true, ...(parent.anyway ? { anyway: parent.anyway } : {}) });
  console.log(`[jarvis] tab ${newTabId} opened by Apply from tab ${openerTabId} — following it too`);
}

chrome.tabs?.onCreated?.addListener((tab) => inherit(tab?.id, tab?.openerTabId));
chrome.webNavigation?.onCreatedNavigationTarget?.addListener((d) => inherit(d.tabId, d.sourceTabId));

chrome.tabs?.onRemoved?.addListener((tabId) => { disarm(tabId); forgetSeen(tabId); followTimers.delete(tabId); RUNNING.delete(tabId); STOPPED.delete(tabId); });

/**
 * THE TAB CHANGED ID UNDER US. Chrome swaps a prerendered page in as a NEW
 * tab id (`tabs.onReplaced`); measured live on KLA, "Apply Manually" took the
 * armed tab 818296341 to 818296352 and the arming stayed on a tab that no
 * longer existed. The state moves with the page; nothing else changes.
 */
chrome.tabs?.onReplaced?.addListener(async (addedTabId, removedTabId) => {
  await loadSeen();
  if (SEEN.has(removedTabId)) { SEEN.set(addedTabId, SEEN.get(removedTabId)); SEEN.delete(removedTabId); await saveSeen(); }
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
  // Nor while outreach tabs are being watched for his Send.
  if (outreachLive()) return false;
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
    // The Outreach tab's "Send all", and the lines under it.
    if (msg?.type === 'outreach-send') {
      reply(await startOutreach({ names: Array.isArray(msg.names) ? msg.names.map(String) : [], schedule: String(msg.schedule || '') }));
      return;
    }
    // "Check InMail" on the Outreach tab: free message or InMail, per person.
    if (msg?.type === 'outreach-credits') {
      reply(await checkCredits(Array.isArray(msg.names) ? msg.names.map(String) : []));
      return;
    }
    if (msg?.type === 'outreach-credits-status') {
      reply({ ok: true, check: CREDIT_CHECK });
      return;
    }
    if (msg?.type === 'outreach-status') {
      await loadOutreach();
      reply({ ok: true, session: outreachSummary() });
      return;
    }
    if (msg?.type === 'outreach-stop') {
      // Stops watching; the tabs stay open and nothing is marked.
      await loadOutreach();
      if (OUTREACH) { OUTREACH.phase = 'done'; await saveOutreach(); }
      reply({ ok: true, session: outreachSummary() });
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
        || (tabs || []).find((t) => tabShowsPosting(t.url, want)) || null;
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
async function press(tab, { anyway = null } = {}) {
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
  // A press on a form that names nothing starts the application he was
  // looking at a moment ago (F-791).
  let seen = await seenJob(tab.id);
  // THE PAGE'S OWN JOB ID BEATS THE TAB'S MEMORY (F-921). A new tab opened
  // from the R&D Engineer form (Oracle job 2011694) remembered that job, and
  // the press on R&D Prototype Engineer (job 2014549) armed it as R&D
  // Engineer — that posting's resume and answers. Two ids that differ are two
  // jobs; the server then matches the page itself.
  const urlToken = ATS?.reqToken(tab.url || '') || null;
  if (seen && seen.token && urlToken && seen.token !== urlToken) {
    await forgetSeen(tab.id, `the page is another posting (${urlToken})`);
    seen = null;
  }
  if (st && st.id && st.token && urlToken && st.token !== urlToken) {
    console.log(`[jarvis] tab ${tab.id}: armed for ${st.company || st.id}, but the page is ${urlToken} — matching the page instead`);
    Object.assign(st, { id: null, company: null, title: null, token: urlToken, anyway: null, acc: emptyAcc() });
    dropReport(tab.id);
  }
  const known = seen ? { id: seen.id, company: seen.company, title: seen.title } : {};
  if (!st) await arm(tab.id, { started: true, token: ATS?.reqToken(tab.url || '') || null, ...known });
  else { if (!st.id && seen) Object.assign(st, known); st.started = true; st.runs = 0; st.lastUsefulAt = Date.now(); st.quiet = 0; st.holdAt = null; st.holdUrl = null; if (!st.token) st.token = ATS?.reqToken(tab.url || '') || null; await saveArmed(); }
  // His Fill anyway, from the panel only: this posting fills on every page from now.
  if (anyway) {
    const now = await armedState(tab.id);
    if (now) { now.anyway = String(anyway); await saveArmed(); }
  }
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
self.runGate = runGate;
self.wakeParked = wakeParked;
self.lookForConfirmation = lookForConfirmation;
self.filledAt = FILLED_AT;
// The run a tab holds, for the harnesses (a test back-dates it to simulate a stall).
self.runState = (tabId) => RUNNING.get(tabId) || null;
self.reloadIfStale = reloadIfStale;
self.arm = arm;
self.disarm = disarm;
self.armedState = armedState;
self.press = press;
// A browser without a side panel opens the panel as a window instead (F-411).
self.openPanel = openPanel;
self.dockPanel = dockPanel;
self.report = report;
