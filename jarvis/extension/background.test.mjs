/**
 * The service worker, which until now had no tests at all.
 *
 * It is the only piece that talks to the dashboard, and it carries the resume
 * bytes. A bug in here reads exactly like every bug this project has already
 * had: "no resume attached". It has no DOM, so it is exercised the way it
 * actually runs — as a script, with `chrome` and `fetch` stubbed.
 */
import test, { after } from 'node:test';

// THE WORKER'S OWN TIMERS OUTLIVE THE TESTS (2026-09-25): every assertion
// passed and the process never exited, which stalled `npm run jarvis:test` at
// this file. Two seconds after the last test, whatever the worker left running
// is let go; the exit code node:test set (1 on any failure) is kept.
after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref(); });
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, 'background.js'), 'utf-8');

/**
 * Load background.js into a sandbox with a fake browser and a fake network.
 * `routes` maps a path to a handler; anything unrouted 404s.
 */
function load({ routes = {}, reachable = ['http://localhost:4300'], manifestVersion = '1.1.0', sidePanel = null, injectFails = false, timeLimits = false } = {}) {
  const calls = [];
  const listeners = {};
  const badges = [];
  const titles = [];
  const created = [];   // tabs the worker opened
  const windows = [];   // windows it opened — the last rung of the panel fallback
  const panelOpens = [];
  const injected = [];  // what it put into a page — the docked panel, and the fill
  // Tab events, so a test can navigate, open and close tabs the way Chrome
  // reports them. Each is a list because tabSettled-style helpers may add
  // listeners of their own.
  const events = { updated: [], created: [], removed: [], history: [], completed: [], committed: [], target: [] };
  const fire = {
    updated: (tabId, info, url = '') => Promise.all(events.updated.map((fn) => fn(tabId, info, { id: tabId, url }))),
    created: (tab) => Promise.all(events.created.map((fn) => fn(tab))),
    removed: (tabId) => Promise.all(events.removed.map((fn) => fn(tabId, {}))),
    history: (d) => Promise.all(events.history.map((fn) => fn(d))),
    completed: (d) => Promise.all(events.completed.map((fn) => fn(d))),
    committed: (d) => Promise.all(events.committed.map((fn) => fn(d))),
    target: (d) => Promise.all(events.target.map((fn) => fn(d))),
  };

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    btoa: (x) => Buffer.from(x, 'binary').toString('base64'), URLSearchParams, URL,
    setTimeout,
    clearTimeout,
    Uint8Array,
    Array,
    JSON,
    Promise,
    Error,
    URL,
    // The worker loads ats.js with importScripts, as a real service worker does.
    importScripts: (file) => vm.runInContext(readFileSync(path.join(HERE, file), 'utf-8'), sandbox),
    chrome: {
      runtime: {
        getURL: (rel) => `chrome-extension://jarvis/${rel}`,
        onMessage: { addListener: (fn) => { listeners.message = fn; } },
        // The dashboard page is the one outside origin the worker listens to.
        onMessageExternal: { addListener: (fn) => { listeners.external = fn; } },
        getManifest: () => ({ version: manifestVersion }),
      },
      action: {
        onClicked: { addListener: (fn) => { listeners.clicked = fn; } },
        setBadgeText: (o) => { badges.push(o.text); },
        setBadgeBackgroundColor() {},
        setTitle: (o) => { titles.push(o.title); },
      },
      scripting: {
        executeScript: async (o2) => {
          injected.push(o2);
          if (injectFails) throw new Error('cannot access this page');
          return [{ result: { ok: true, filled: 1, checked: 0, uploaded: true } }];
        },
      },
      // Chrome has a side panel; Opera GX does not (F-411). `sidePanel: null`
      // is a browser without one, which is what the fallback exists for.
      ...(sidePanel ? { sidePanel: { open: (o2) => { panelOpens.push(o2); return sidePanel === 'refuses' ? Promise.reject(new Error('not a user gesture')) : Promise.resolve(); } } } : {}),
      windows: {
        async create(o2) { const w = { id: 90 + windows.length, ...o2 }; windows.push(w); return w; },
        async get(id) { return windows.find((w) => w.id === id) || { id, left: 0, top: 0, width: 1280, height: 900 }; },
        async update(id, o2) { const w = windows.find((x) => x.id === id); if (w) Object.assign(w, o2); return w; },
      },
      tabs: {
        get: async () => ({ status: 'complete' }),
        query: async () => [],
        update: async (id, o2) => ({ id, ...o2 }),
        create: async (o) => { created.push(o); return { id: 21, url: o.url }; },
        onUpdated: { addListener(fn) { events.updated.push(fn); }, removeListener(fn) { events.updated = events.updated.filter((f) => f !== fn); } },
        onCreated: { addListener(fn) { events.created.push(fn); } },
        onRemoved: { addListener(fn) { events.removed.push(fn); } },
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener(fn) { events.history.push(fn); } },
        onReferenceFragmentUpdated: { addListener() {} },
        onCompleted: { addListener(fn) { events.completed.push(fn); } },
        onCommitted: { addListener(fn) { events.committed.push(fn); } },
        onCreatedNavigationTarget: { addListener(fn) { events.target.push(fn); } },
      },
      // The version alarm (F-245): the extension asks whether it is stale on a
      // timer, because the click path can only refresh someone already clicking.
      alarms: {
        created: [],
        create(name, opts) { this.created.push({ name, opts }); },
        onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
      },
      storage: {
        // The armed-tab list lives here too: Chrome's disk, not the worker's
        // memory, so it survives the worker being evicted mid-application AND
        // the extension reloading itself for a new version.
        local: { store: {},
          async get(k) { return k in this.store ? { [k]: JSON.parse(JSON.stringify(this.store[k])) } : {}; },
          async set(o) { Object.assign(this.store, JSON.parse(JSON.stringify(o))); },
          async remove(k) { delete this.store[k]; } },
      },
    },
    async fetch(url, opts = {}) {
      calls.push({ url, headers: opts.headers || {}, method: opts.method || 'GET', body: opts.body });
      const base = reachable.find((b) => url.startsWith(b));
      if (!base) throw new Error('connection refused');
      const pathname = url.slice(base.length).split('?')[0];
      const route = routes[pathname];
      if (!route) return { ok: false, status: 404, json: async () => ({ error: 'no such route' }) };
      // A request given a time limit is let go when it runs out, as Chrome's fetch does.
      const answer = Promise.resolve(route(opts, calls, url));
      if (!opts.signal) return answer;
      return Promise.race([answer, new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }))]);
    },
    ...(timeLimits ? { AbortSignal } : {}),
  };
  // A service worker's global IS `self`. background.js hangs runOnTab there so a
  // Playwright harness that has loaded the real extension can drive it.
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { listeners, calls, badges, titles, sandbox, fire, created, windows, panelOpens, injected };
}

/** A message as Chrome delivers it from a content script in tab `tabId`. */
function askFrom(listeners, tabId, msg) {
  return new Promise((resolve) => { listeners.message(msg, { tab: { id: tabId } }, resolve); });
}

/** The follow debounce is 900ms; wait it out. */
const settleFollow = () => new Promise((r) => setTimeout(r, 1100));

const okJson = (body) => () => ({ ok: true, status: 200, json: async () => body });

const TOKEN = 'abc123';
const okToken = () => ({ ok: true, status: 200, json: async () => ({ token: TOKEN, port: 4300 }) });

/** Call the message listener the way chrome does, and await the reply. */
function ask(listeners, msg) {
  return new Promise((resolve) => { listeners.message(msg, {}, resolve); });
}

// S3 (2026-11-06): time limits on the dashboard. Times are scaled down 100x in these tests.
const hang = () => new Promise(() => {});
test('S3: finding the dashboard asks both addresses at once — one that hangs does not hold up the other', async () => {
  const { sandbox } = load({ timeLimits: true, reachable: ['http://localhost:4300', 'http://127.0.0.1:4300'], routes: {
    '/api/apply-token': (o, c, url) => (url.startsWith('http://localhost') ? hang() : okToken()),
    '/api/resume-name': okJson({ name: 'x' }),
  } });
  sandbox.__jarvisTimeScale = 0.01;
  const t = Date.now();
  const r = await sandbox.api('/api/resume-name');
  assert.equal(r.name, 'x');
  assert.ok(Date.now() - t < 1000, `answered by the address that answers, at once (${Date.now() - t} ms)`);
});

test('S3: a dashboard that never answers is "not answering (busy, or stuck)", not "not running", and is given up on quickly', async () => {
  const { sandbox } = load({ timeLimits: true, reachable: ['http://localhost:4300', 'http://127.0.0.1:4300'], routes: { '/api/apply-token': hang } });
  sandbox.__jarvisTimeScale = 0.01;   // 2.5 s → 25 ms
  sandbox.__jarvisReconnectMs = 5;
  const t = Date.now();
  await assert.rejects(sandbox.api('/api/resume-name'), /not answering \(busy, or stuck\)/);
  assert.ok(Date.now() - t < 2000, `gave up in ${Date.now() - t} ms`);
});

test('S3: a dashboard that refuses the connection is still "not running"', async () => {
  const { sandbox } = load({ timeLimits: true, reachable: [] });
  sandbox.__jarvisReconnectMs = 5;
  await assert.rejects(sandbox.api('/api/resume-name'), /the Jarvis dashboard is not running/);
});

test('S3: a quick route the dashboard sits on is given up on at its limit, asked once, with words he can act on', async () => {
  const { sandbox, calls } = load({ timeLimits: true, routes: { '/api/apply-token': okToken, '/api/plan': hang } });
  sandbox.__jarvisTimeScale = 0.01;   // 60 s → 600 ms
  const t = Date.now();
  await assert.rejects(sandbox.api('/api/plan', { method: 'POST', body: {} }), /did not answer \/api\/plan within 60 s — it is busy/);
  const took = Date.now() - t;
  assert.ok(took >= 500 && took < 3000, `about the scaled limit: ${took} ms`);
  assert.equal(calls.filter((c) => c.url.includes('/api/plan')).length, 1, 'a busy dashboard is not asked twice');
});

test('S3: a route that is slow on purpose (writing an answer) is never cut off', async () => {
  const { sandbox } = load({ timeLimits: true, routes: {
    '/api/apply-token': okToken,
    '/api/answer': () => new Promise((r) => setTimeout(() => r({ ok: true, status: 200, json: async () => ({ text: 'written' }) }), 900)),
  } });
  sandbox.__jarvisTimeScale = 0.01;   // a quick route would be given up on at 600 ms
  const r = await sandbox.api('/api/answer', { method: 'POST', body: {} });
  assert.equal(r.text, 'written');
});

test('S3: one address refusing at once while the other answers slowly still connects', async () => {
  const { sandbox } = load({ timeLimits: true, reachable: ['http://127.0.0.1:4300'], routes: {   // localhost refuses
    // Slow, but well inside its 25 ms (scaled) limit: 5 ms, so a busy test machine never flakes it (review).
    '/api/apply-token': () => new Promise((r) => setTimeout(() => r(okToken()), 5)),
    '/api/resume-name': okJson({ name: 'y' }),
  } });
  sandbox.__jarvisTimeScale = 0.01;   // 25 ms each
  assert.equal((await sandbox.api('/api/resume-name')).name, 'y');
});

test('S3: one address refusing while the other hangs is "not answering", not "not running"', async () => {
  const { sandbox } = load({ timeLimits: true, reachable: ['http://127.0.0.1:4300'], routes: { '/api/apply-token': hang } });
  sandbox.__jarvisTimeScale = 0.01;
  sandbox.__jarvisReconnectMs = 5;
  await assert.rejects(sandbox.api('/api/resume-name'), /not answering \(busy, or stuck\)/);
});

test('S3: a quick route given up on says the last step may already be recorded', async () => {
  const { sandbox } = load({ timeLimits: true, routes: { '/api/apply-token': okToken, '/api/filled': hang } });
  sandbox.__jarvisTimeScale = 0.01;
  await assert.rejects(sandbox.api('/api/filled', { method: 'POST', body: {} }), /may already have recorded the last step/);
});

test('S3: past 3 s a tab\'s own waiting call is named on its progress line, never another tab\'s or one with no tab, and the note goes once it answers', async () => {
  const release = {};
  const { sandbox } = load({ timeLimits: true, routes: {
    '/api/apply-token': okToken,
    '/api/answer-snapshot': () => new Promise((r) => { release.mine = () => r({ ok: true, status: 200, json: async () => ({}) }); }),
    '/api/answer': () => new Promise((r) => { release.other = () => r({ ok: true, status: 200, json: async () => ({}) }); }),
    '/api/page-errors': () => new Promise((r) => { release.untabbed = () => r({ ok: true, status: 200, json: async () => ({}) }); }),
  } });
  const t0 = Date.now();
  const mine = sandbox.api('/api/answer-snapshot', { tabId: 7, method: 'POST', body: {} });
  const other = sandbox.api('/api/answer', { tabId: 9, method: 'POST', body: {} });
  const untabbed = sandbox.api('/api/page-errors', { method: 'POST', body: {} });
  await new Promise((r) => setTimeout(r, 20));   // the token is fetched and every call is in flight
  // The clock is passed in, so nothing here races a timer.
  assert.equal(sandbox.slowNote(7, t0 + 1000), '', 'not yet at 1 s');
  assert.match(sandbox.slowNote(7, t0 + 5000), /^Dashboard slow to answer \(5 s on answer-snapshot\), still waiting$/);
  assert.match(sandbox.slowNote(9, t0 + 5000), /on answer\)/, 'the other tab hears only its own');
  assert.equal(sandbox.slowNote(8, t0 + 60_000), '', 'a tab with nothing waiting hears nothing — the untabbed call is never counted');
  release.mine(); await mine;
  assert.equal(sandbox.slowNote(7, t0 + 60_000), '', 'quiet again once it answered');
  release.other(); release.untabbed(); await Promise.all([other, untabbed]);
});

test('it finds the dashboard and carries the token on every call', async () => {
  const { listeners, calls } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': () => ({ ok: true, status: 200, json: async () => ({ summary: { fill: 1 }, actions: [] }) }),
    },
  });
  const r = await ask(listeners, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  assert.equal(r.ok, true);
  const planCall = calls.find((c) => c.url.includes('/api/plan'));
  assert.equal(planCall.headers['x-jarvis-token'], TOKEN, 'without this the server answers 403');
});

test('THE PAGE URL REACHES THE SERVER — it is what picks the right resume', async () => {
  // With two applications open, the server matches the tab to its own
  // application by URL. If the worker dropped it, it would fall back to
  // "whichever finished last" and attach another employer's resume.
  const { listeners, calls } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': (opts) => ({ ok: true, status: 200, json: async () => JSON.parse(opts.body) }),
    },
  });
  await ask(listeners, {
    type: 'plan',
    fields: [{ label: 'First Name', type: 'text' }],
    pageUrl: 'https://careers.appliedmaterials.com/apply/1',
  });
  const sent = JSON.parse(calls.find((c) => c.url.includes('/api/plan')).body);
  assert.equal(sent.pageUrl, 'https://careers.appliedmaterials.com/apply/1',
    'drop this and the server falls back to "whichever finished last"');
  assert.deepEqual(sent.fields, [{ label: 'First Name', type: 'text' }], 'and the fields must arrive intact');
});

test('the resume comes back as plain bytes a File can be built from', async () => {
  const pdf = Buffer.from('%PDF-1.4 hello');
  const { listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-resume': () => ({ ok: true, status: 200, arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length) }),
    },
  });
  const r = await ask(listeners, { type: 'resume', pageUrl: 'https://x.test/apply' });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.bytes), 'an ArrayBuffer cannot cross sendMessage in every Chrome version');
  assert.equal(Buffer.from(r.bytes).toString(), '%PDF-1.4 hello', 'the bytes must survive the trip intact');
});

test('the page URL is on the resume request too', async () => {
  const { listeners, calls } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-resume': () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) }),
    },
  });
  await ask(listeners, { type: 'resume', pageUrl: 'https://globalfoundries.wd1.myworkdayjobs.com/x/apply' });
  const call = calls.find((c) => c.url.includes('/api/apply-resume'));
  assert.match(decodeURIComponent(call.url), /globalfoundries/, 'the server needs it to pick the right PDF');
});

test('a dashboard that is not running is reported in words he can act on', async () => {
  const { listeners } = load({ reachable: [] });
  const r = await ask(listeners, { type: 'plan', fields: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /npm run jarvis:serve/, 'the message has to say what to do');
});

test('it tries 127.0.0.1 when localhost does not answer', async () => {
  const { listeners, calls } = load({
    reachable: ['http://127.0.0.1:4300'],
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': () => ({ ok: true, status: 200, json: async () => ({ actions: [] }) }),
    },
  });
  const r = await ask(listeners, { type: 'plan', fields: [] });
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.url.startsWith('http://127.0.0.1:4300')));
});

test('a stale token is forgotten so the NEXT click reconnects', async () => {
  // The server rerolls nothing, but it does restart, and a worker that cached a
  // dead base would fail the same way forever.
  let serverToken = TOKEN;
  let rejectOnce = true;
  const { listeners } = load({
    routes: {
      '/api/apply-token': () => ({ ok: true, status: 200, json: async () => ({ token: serverToken }) }),
      '/api/plan': (opts) => {
        if (rejectOnce) { rejectOnce = false; return { ok: false, status: 403, json: async () => ({ error: 'bad token' }) }; }
        return { ok: true, status: 200, json: async () => ({ actions: [] }) };
      },
    },
  });
  const first = await ask(listeners, { type: 'plan', fields: [] });
  assert.equal(first.ok, false);
  const second = await ask(listeners, { type: 'plan', fields: [] });
  assert.equal(second.ok, true, 'the second attempt must reconnect rather than repeat the failure');
});

test('the server error text is passed through, not swallowed', async () => {
  const { listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-resume': () => ({ ok: false, status: 409, json: async () => ({ error: 'this page does not match the application for GlobalFoundries' }) }),
    },
  });
  const r = await ask(listeners, { type: 'resume', pageUrl: 'https://elsewhere.test/apply' });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not match the application/, 'the wrong-resume refusal must reach him');
});

test('an unknown message is refused rather than guessed at', async () => {
  const { listeners } = load({ routes: { '/api/apply-token': okToken } });
  const r = await ask(listeners, { type: 'delete-everything' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown message/);
});

test('FOLLOWING APPLY IS THE ARMED TAB BEING FOLLOWED — a navigation re-injects, once', async () => {
  // A navigation destroys the content script. The old worker re-injected once
  // after an Apply link, and only then; now every page an ARMED tab lands on
  // is picked up, which covers Apply links, sign-in round trips and iCIMS'
  // five-page forms alike. One navigation is several Chrome events; one run.
  let runs = 0;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (o.files?.includes('content.js')) runs += 1;
    return [{ result: { filled: 4, checked: 1, uploaded: true } }];
  };
  await sandbox.arm(7);
  await sandbox.runOnTab(7);
  assert.equal(runs, 1, 'the press itself');

  // The burst Chrome produces for one page load.
  await fire.updated(7, { status: 'loading' });
  await fire.updated(7, { status: 'complete' });
  await fire.completed({ tabId: 7, frameId: 0 });
  await fire.completed({ tabId: 7, frameId: 3 });
  await settleFollow();
  assert.equal(runs, 2, 'one page load, one run — not one per event');
});

test('A TAB HE NEVER PRESSED THE BUTTON ON IS NEVER TOUCHED', async () => {
  // The manifest can now reach every site, which is what makes following
  // possible. The boundary moved from the manifest to this list: nothing is
  // injected into a tab that is not on it, whatever Chrome permits.
  let runs = 0;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  sandbox.chrome.scripting.executeScript = async () => { runs += 1; return [{ result: { filled: 1 } }]; };
  await fire.updated(9, { status: 'complete' });
  await fire.history({ tabId: 9, frameId: 0 });
  await fire.completed({ tabId: 9, frameId: 2 });
  await settleFollow();
  assert.equal(runs, 0, 'an unarmed tab loading a page is none of our business');
});

test('THE PRESS ARMS AND FILLS; PRESSING AGAIN FILLS AGAIN, AND NEVER STOPS', async () => {
  // "Click it again" is what he reaches for when something looks stuck. A
  // press that silently turned the following OFF would leave him on the one
  // page he most wanted filled. Stopping is a separate, visible act.
  let runs = 0;
  const ctxs = [];
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (o.args) ctxs.push(o.args[0]);
    if (o.files?.includes('content.js')) runs += 1;
    return [{ result: { filled: 2, checked: 0 } }];
  };

  await sandbox.press({ id: 4 });
  const st = await sandbox.armedState(4);
  assert.ok(st, 'the press arms the tab');
  assert.equal(st.started, true, 'and records that HE began this application');
  assert.equal(runs, 1, 'and fills it now');
  assert.equal(ctxs.at(-1).started, true, 'the page is told so');

  await sandbox.press({ id: 4 });
  assert.ok(await sandbox.armedState(4), 'the second press does not stop following');
  assert.equal(runs, 2, 'it fills again');
  assert.equal(ctxs.at(-1).reset, true, 'and lets the page start its counters over');
});

test('stopping is the page\'s stop link or the icon\'s menu, and both forget the tab', async () => {
  let runs = 0;
  const { sandbox, listeners, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.files?.includes('content.js')) runs += 1; return [{ result: { filled: 1 } }]; };
  await sandbox.press({ id: 4 });
  await askFrom(listeners, 4, { type: 'stop', pageUrl: 'https://x.test/apply' });
  assert.equal(await sandbox.armedState(4), null, 'the page said stop');
  await fire.updated(4, { status: 'complete' });
  await settleFollow();
  assert.equal(runs, 1, 'a navigation after that fills nothing');
});

test('closing the tab forgets it', async () => {
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  await sandbox.arm(5);
  await fire.removed(5);
  assert.equal(await sandbox.armedState(5), null);
});

test('THE ARMED LIST SURVIVES THE WORKER BEING EVICTED — and the extension reloading', async () => {
  // A service worker is torn down after seconds of idle — less time than a
  // sign-in takes. If the list lived in worker memory, every armed tab would
  // be forgotten the moment he paused to type a verification code. And it
  // lives in storage.local, not storage.session: session storage is cleared
  // when the extension reloads, which this one does by itself whenever the
  // dashboard ships a newer version — every deploy would have dropped a tab
  // mid-application.
  const first = load({ routes: { '/api/apply-token': okToken } });
  await first.sandbox.arm(8, { id: 'job-8', company: 'Jabil' });

  // A fresh worker, same Chrome storage.
  const second = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  second.sandbox.chrome.storage.local.store = first.sandbox.chrome.storage.local.store;
  let injected = null;
  second.sandbox.chrome.scripting.executeScript = async (o) => { if (o.args) injected = o.args[0]; return [{ result: { filled: 1 } }]; };
  await second.fire.updated(8, { status: 'complete' });
  await settleFollow();
  assert.ok(injected, 'the new worker follows the tab the old one armed');
  assert.equal(injected.armed, true);
  assert.equal(injected.id, 'job-8', 'with the application it was armed for');
});

test('a run nobody clicked for is told so, and the press is told it was a press', async () => {
  // The page uses this to decide whether it may write over a value already on
  // the form: never on a run he did not start.
  const ctxs = [];
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.args) ctxs.push(o.args[0]); return [{ result: { filled: 1 } }]; };
  await sandbox.press({ id: 6 });
  await fire.updated(6, { status: 'complete' });
  await settleFollow();
  assert.equal(ctxs.length, 2);
  assert.equal(ctxs[0].auto, false, 'the press');
  assert.equal(ctxs[1].auto, true, 'the navigation');
  assert.ok(ctxs.every((c) => c.armed === true));
});

test('THE TAB CARRIES ITS APPLICATION: the id goes on every request', async () => {
  // A Workday form lives on <tenant>.wd5.myworkdayjobs.com, which says nothing
  // about which posting he armed on. URL matching is a guess there; the id
  // the tab carries is not.
  const posted = { plan: null, resume: null, filled: null };
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': (opts) => { posted.plan = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ actions: [] }) }; },
      '/api/apply-resume': () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(2) }),
      '/api/filled': (opts) => { posted.filled = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await sandbox.arm(3, { id: 'job-3', company: 'Jabil' });
  await askFrom(listeners, 3, { type: 'plan', fields: [], pageUrl: 'https://jabil.wd1.myworkdayjobs.com/x/apply' });
  assert.equal(posted.plan.id, 'job-3');
  await askFrom(listeners, 3, { type: 'resume', pageUrl: 'https://jabil.wd1.myworkdayjobs.com/x/apply' });
  await askFrom(listeners, 3, { type: 'filled', result: { filled: 5, pageUrl: 'https://jabil.wd1.myworkdayjobs.com/x/apply' } });
  assert.equal(posted.filled.id, 'job-3', 'the record lands on the right posting');
  assert.equal(posted.filled.filled, 5, 'a run the page started is recorded like one the worker started');
});

test('the resume request names the id first and the page second', async () => {
  const { sandbox, listeners, calls } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-resume': () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(2) }),
    },
  });
  await sandbox.arm(3, { id: 'job-3' });
  await askFrom(listeners, 3, { type: 'resume', pageUrl: 'https://x.test/apply' });
  const call = calls.find((c) => c.url.includes('/api/apply-resume'));
  assert.match(call.url, /[?&]id=job-3/, 'the server builds for the id when it has one');
  assert.match(call.url, /pageUrl=https/, 'and still sees the page');
});

test('A TAB WITHOUT AN ID HAS NONE ON ITS REQUESTS — no guessing', async () => {
  const { sandbox, listeners, calls } = load({
    routes: { '/api/apply-token': okToken, '/api/plan': okJson({ actions: [] }) },
  });
  await sandbox.arm(3);
  await askFrom(listeners, 3, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  const sent = JSON.parse(calls.find((c) => c.url.includes('/api/plan')).body);
  assert.equal(sent.id, undefined);
});

test('THE PAGE SAYS WHAT JOB IT IS, and the tab remembers the answer', async () => {
  // The posting read off the page goes to /api/apply-page, which records it if
  // the store has never seen it and starts the resume. The id it answers with
  // is the tab's application from then on.
  let received = null;
  const { sandbox, listeners, calls } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-page': (opts) => { received = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: 'new-1', status: 'tailoring', company: 'Acme', title: 'ME I' }) }; },
      '/api/plan': (opts) => ({ ok: true, status: 200, json: async () => JSON.parse(opts.body) }),
    },
  });
  await sandbox.arm(2);
  const r = await askFrom(listeners, 2, {
    type: 'posting', pageUrl: 'https://acme.test/jobs/1',
    posting: { title: 'ME I', company: 'Acme', description: 'x'.repeat(300), url: 'https://acme.test/jobs/1', source: 'jsonld' },
  });
  assert.equal(r.ok, true);
  assert.equal(received.posting.title, 'ME I');
  assert.equal(received.pageUrl, 'https://acme.test/jobs/1');
  const st = await sandbox.armedState(2);
  assert.equal(st.id, 'new-1');
  assert.equal(st.company, 'Acme');
  // And the next plan from the same tab, on a page that says nothing, carries it.
  await askFrom(listeners, 2, { type: 'plan', fields: [], pageUrl: 'https://acme.wd5.myworkdayjobs.com/x/apply' });
  const sent = JSON.parse(calls.find((c) => c.url.includes('/api/plan')).body);
  assert.equal(sent.id, 'new-1');
});

test('a NEW posting seen on the tab replaces the old one', async () => {
  // He armed on job A, changed his mind, and opened job B in the same tab.
  // Following B with A's resume would be the wrong-employer attachment this
  // project exists to prevent.
  let n = 0;
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-page': () => { n += 1; return { ok: true, status: 200, json: async () => ({ id: `job-${n}`, status: 'tailoring', company: `Co${n}` }) }; },
    },
  });
  await sandbox.arm(2);
  await askFrom(listeners, 2, { type: 'posting', pageUrl: 'https://a.test/1', posting: { title: 'A' } });
  await askFrom(listeners, 2, { type: 'posting', pageUrl: 'https://b.test/2', posting: { title: 'B' } });
  assert.equal((await sandbox.armedState(2)).id, 'job-2');
});

test('the id the server worked out from the PAGE sticks to the tab — a fallback guess never does', async () => {
  const { sandbox, listeners } = load({
    routes: { '/api/apply-token': okToken, '/api/plan': okJson({ id: 'from-plan', matched: 'page', actions: [] }) },
  });
  await sandbox.arm(2);
  await askFrom(listeners, 2, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  assert.equal((await sandbox.armedState(2)).id, 'from-plan');

  // The server answers with whatever was applied to LAST when nothing matches
  // the page. Stamping that on the tab would turn a guess into a trusted id,
  // and the next resume request would fetch another employer's PDF.
  const guess = load({
    routes: { '/api/apply-token': okToken, '/api/plan': okJson({ id: 'last-applied', matched: 'fallback', actions: [] }) },
  });
  await guess.sandbox.arm(3);
  await askFrom(guess.listeners, 3, { type: 'plan', fields: [], pageUrl: 'https://elsewhere.test/apply' });
  assert.equal((await guess.sandbox.armedState(3)).id, null, 'a fallback is a guess, and a guess is not the tab’s application');
});

test('A STALE TAB ID THE SERVER CORRECTED FROM THE PAGE IS REPLACED, TOTALS AND NAME WITH IT (F-568)', async () => {
  // Measured 2026-09-24: one tab went from Western Digital to Cintal's Rippling
  // form. The plan was Cintal's, but the tab kept WD's id, so the run was
  // recorded as WD with WD's unanswered questions on Cintal's list.
  let plan = { id: 'wd', matched: 'page', company: 'Western Digital', title: 'Hardware Engineer', actions: [] };
  const { sandbox, listeners } = load({
    routes: { '/api/apply-token': okToken, '/api/plan': () => ({ ok: true, status: 200, json: async () => plan }) },
  });
  await sandbox.arm(2);
  await askFrom(listeners, 2, { type: 'plan', fields: [], pageUrl: 'https://jobs.smartrecruiters.com/wd' });
  const st = await sandbox.armedState(2);
  st.acc.unanswered.push('step 2: Do you have a Family or Close Friend relationship with anyone employed by WD?');
  st.acc.filled = 60;

  plan = { id: 'cintal', matched: 'page', company: 'Cintal Inc.', title: 'Embedded Software Engineer', actions: [] };
  await askFrom(listeners, 2, { type: 'plan', fields: [], pageUrl: 'https://ats.rippling.com/cintal/jobs/x/apply' });
  const after = await sandbox.armedState(2);
  assert.equal(after.id, 'cintal');
  assert.equal(after.company, 'Cintal Inc.');
  assert.equal(after.acc.filled, 0, 'WD\'s totals are not Cintal\'s');
  assert.deepEqual([...after.acc.unanswered], [], 'WD\'s questions leave the list');

  // The same id, matched by id, changes nothing.
  plan = { id: 'cintal', matched: 'id', company: 'Cintal Inc.', actions: [] };
  after.acc.filled = 12;
  await askFrom(listeners, 2, { type: 'plan', fields: [], pageUrl: 'https://ats.rippling.com/cintal/jobs/x/apply' });
  assert.equal((await sandbox.armedState(2)).acc.filled, 12);
});

test('an Apply link that opens a NEW tab hands the arming and the id to it', async () => {
  // Only when the page's own Apply press opened it: the page says `following`
  // just before it clicks. A link he opened himself from an armed tab is his
  // browsing, not the application.
  const { sandbox, listeners, fire } = load({ routes: { '/api/apply-token': okToken } });
  await sandbox.arm(10, { id: 'job-10', company: 'Bosch' });

  await fire.created({ id: 13, openerTabId: 10 });
  assert.equal(await sandbox.armedState(13), null, 'a tab he opened himself is not followed');

  await askFrom(listeners, 10, { type: 'following', pageUrl: 'https://bosch.test/job/1' });
  await fire.created({ id: 11, openerTabId: 10 });
  const st = await sandbox.armedState(11);
  assert.ok(st, 'the tab Apply opened is followed');
  assert.equal(st.id, 'job-10', 'with the same application');
  assert.equal(st.started, true, 'and it counts as one he started, so its Apply may be followed too');
  await fire.target({ tabId: 11, sourceTabId: 10 });
  assert.equal((await sandbox.armedState(11)).id, 'job-10', 'the second event for the same tab changes nothing');
  await fire.created({ id: 12, openerTabId: 99 });
  assert.equal(await sandbox.armedState(12), null, 'a tab opened from an unarmed tab is not');
});

test('A TAB REMEMBERS THE POSTING IT CAME FROM, armed or not, and its form is shown as that job (F-791)', async () => {
  // Veeco: the posting names itself, its SuccessFactors portal names nothing.
  const POSTING = 'https://careers.veeco.com/job/San-Jose-Manufacturing-Equipment-Engineer-CA-95101/1439543300/';
  const FORM = 'https://career8.successfactors.com/portalcareer?_s.crb=VVtlgnsAOsx';
  const asked = [];
  const urls = new Map([[30, POSTING]]);
  const { sandbox, listeners, fire } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/panel': (opts, calls) => {
        const u = new URL(calls.at(-1).url);
        asked.push(u.searchParams);
        // The server's rule: the page first, the remembered id only when the page names nothing.
        if (u.searchParams.get('pageUrl') === POSTING || u.searchParams.get('id') === 'job-veeco') {
          return { ok: true, status: 200, json: async () => ({ job: { id: 'job-veeco', title: 'Manufacturing Equipment Engineer', company: 'Veeco' }, fit: {}, application: null }) };
        }
        return { ok: false, status: 404, json: async () => ({ error: 'this page is not a posting in your store' }) };
      },
    },
  });
  sandbox.chrome.tabs.get = async (id) => ({ id, url: urls.get(id) || '', title: '', status: 'complete', windowId: 1 });
  sandbox.chrome.scripting.executeScript = async () => [{ result: '' }];
  const fromPanel = (msg) => new Promise((resolve) => { listeners.message(msg, {}, resolve); });

  assert.equal((await fromPanel({ type: 'panel', tabId: 30 })).data.job.id, 'job-veeco', 'the posting is found by its own address');
  assert.equal(await sandbox.armedState(30), null, 'nothing armed the tab');

  // Apply → the portal, in the same tab.
  urls.set(30, FORM);
  await fire.committed({ tabId: 30, frameId: 0, url: FORM });
  const onForm = await fromPanel({ type: 'panel', tabId: 30 });
  assert.equal(onForm.ok, true, JSON.stringify(onForm));
  assert.equal(asked.at(-1).get('id'), 'job-veeco', 'the form is asked about as the posting he came from');
  assert.equal(onForm.data.job.company, 'Veeco');

  // …or in a tab the page opened.
  urls.set(31, FORM);
  await fire.target({ tabId: 31, sourceTabId: 30 });
  await fire.committed({ tabId: 31, frameId: 0, url: FORM });
  assert.equal((await fromPanel({ type: 'panel', tabId: 31 })).data?.job?.id, 'job-veeco', 'the child tab carries it too');

  // A press on the form starts THAT application.
  await sandbox.press({ id: 31, url: FORM });
  assert.equal((await sandbox.armedState(31))?.id, 'job-veeco', 'the press arms the tab with the job it came from');
});

test('…AND FORGETS IT once the tab is on another posting, another site, or two hours later (F-791)', async () => {
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  const seed = async (tabId, url) => { await sandbox.seeJob(tabId, { id: `job-${tabId}`, company: 'Texas Instruments' }, url); };

  await seed(40, 'https://careers.ti.com/en/sites/CX_1/job/25017157');
  await fire.committed({ tabId: 40, frameId: 0, url: 'https://careers.ti.com/en/sites/CX/job/25017157/apply/section/1' });
  assert.equal((await sandbox.seenJob(40))?.id, 'job-40', 'its own form keeps it');
  await fire.committed({ tabId: 40, frameId: 0, url: 'https://careers.ti.com/en/sites/CX/job/25099999/apply/section/1' });
  assert.equal(await sandbox.seenJob(40), null, 'another requisition of the same kind drops it');

  await seed(41, 'https://www.linkedin.com/jobs/view/robotics-engineer-at-convergix-automation-solutions-4467626400');
  await fire.committed({ tabId: 41, frameId: 0, url: 'https://convergix.rec.pro.ukg.net/CON1096CVAU/JobBoard/52250257-f25d-4ad3-b69e-53bc735d981a/OpportunityApply?opportunityId=6f41c0f1-f013-445a-a361-db72efd4e989' });
  assert.equal((await sandbox.seenJob(41))?.id, 'job-41', 'LinkedIn to the employer\'s application system keeps it');
  await fire.committed({ tabId: 41, frameId: 0, url: 'https://accounts.google.com/signin/v2' });
  assert.equal((await sandbox.seenJob(41))?.id, 'job-41', 'a sign-in page on the way keeps it');
  await fire.committed({ tabId: 41, frameId: 0, url: 'https://news.example.com/today' });
  assert.equal(await sandbox.seenJob(41), null, 'browsing to another site drops it');

  await seed(42, 'https://www.linkedin.com/jobs/view/4467626400');
  await fire.committed({ tabId: 42, frameId: 0, url: 'https://www.linkedin.com/jobs/view/4461501227' });
  assert.equal(await sandbox.seenJob(42), null, 'another LinkedIn job drops it');

  await seed(43, 'https://careers.veeco.com/job/x/1439543300/');
  vm.runInContext('globalThis.__realNow = Date.now; Date.now = () => globalThis.__realNow() + 2 * 60 * 60 * 1000 + 1000;', sandbox);
  try {
    assert.equal(await sandbox.seenJob(43), null, 'two hours on, it is gone');
  } finally { vm.runInContext('Date.now = globalThis.__realNow;', sandbox); }

  await seed(44, 'https://careers.veeco.com/job/x/1439543300/');
  await fire.removed(44);
  assert.equal(await sandbox.seenJob(44), null, 'a closed tab forgets it');
});

test('a navigation DURING a run is not lost — it runs once more after', async () => {
  let runs = 0;
  let release = null;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (!o.files?.includes('content.js')) return [];
    runs += 1;
    if (runs === 1) await new Promise((r) => { release = r; });
    return [{ result: { filled: 1 } }];
  };
  await sandbox.arm(7);
  const first = sandbox.runOnTab(7);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sandbox.runOnTab(7), null, 'a second call while one runs does not inject on top of it');
  release();
  await first;
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(runs, 2, 'but the page that moved under the first run is filled once it is done');
});

test('"THANK YOU FOR APPLYING" STANDS THE TAB DOWN', async () => {
  // He pressed Submit. A tab that stayed armed on the confirmation page would
  // fill the next posting he opens in it, with this employer's resume in hand.
  const { sandbox, listeners, badges } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  await sandbox.arm(7, { id: 'job-7' });
  await askFrom(listeners, 7, { type: 'filled', result: { filled: 0, submitted: 'Thank you for applying', auto: true } });
  assert.equal(await sandbox.armedState(7), null);
  assert.equal(badges.at(-1), '✓');
});

test('a tab armed hours ago and left alone stands down instead of filling', async () => {
  let runs = 0;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  sandbox.chrome.scripting.executeScript = async () => { runs += 1; return [{ result: { filled: 1 } }]; };
  // Six hours is the expiry now: he filled five applications, walked away,
  // and came back eight hours later expecting them to still be his.
  const ago = Date.now() - 8 * 3600 * 1000;
  await sandbox.arm(7, { at: ago, lastRunAt: ago, lastUsefulAt: ago });
  await fire.updated(7, { status: 'complete' });
  await settleFollow();
  assert.equal(runs, 0);
  assert.equal(await sandbox.armedState(7), null);
});

test('a tab that keeps reloading stops being followed after the cap', async () => {
  let runs = 0;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  sandbox.chrome.scripting.executeScript = async () => { runs += 1; return [{ result: { filled: 0 } }]; };
  await sandbox.arm(7, { runs: 40 });
  await fire.updated(7, { status: 'complete' });
  await settleFollow();
  assert.equal(runs, 0);
  assert.equal(await sandbox.armedState(7), null, 'forty runs on one tab is a page that will not stop changing');
});

test("the page's own runaway guard disarms the tab here too", async () => {
  const { sandbox, listeners } = load({ routes: { '/api/apply-token': okToken } });
  await sandbox.arm(7);
  await askFrom(listeners, 7, { type: 'runaway', pageUrl: 'https://x.test' });
  assert.equal(await sandbox.armedState(7), null);
});

test('a sign-in wall is shown as HIS to clear, not as a failure', async () => {
  const { sandbox, listeners, badges, titles } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  await sandbox.arm(7);
  await askFrom(listeners, 7, { type: 'filled', result: { filled: 0, checked: 0, signInRequired: true } });
  assert.equal(badges.at(-1), 'you');
  assert.ok(titles.some((t) => /sign in/i.test(t) && /continues/i.test(t)));
  assert.ok(await sandbox.armedState(7), 'and the tab stays armed through it');
});

test('THE CONFIRMATION IS TOLD TO THE SERVER, NOT JUST TO THE TAB', async () => {
  // The worker already stood the tab down on a confirmation, painted the ✓ and
  // retitled the tab — and then dropped the fact, so the store went on saying
  // he had applied to five jobs while 96 forms had been filled (F-446). The
  // sentence the page showed travels with it, so the tracker's claim can be
  // checked against what was on screen.
  const posted = [];
  const { sandbox, listeners, badges, titles } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true, submitted: true }) }; },
    },
  });
  await sandbox.arm(7);
  await askFrom(listeners, 7, { type: 'filled', result: { filled: 0, checked: 0, submitted: 'Thank you for applying to Acme!' } });

  assert.equal(posted.at(-1).submitted, 'Thank you for applying to Acme!', 'the server hears it');
  assert.equal(await sandbox.armedState(7), null, 'and the tab still stands down');
  assert.equal(badges.at(-1), '✓');
  assert.ok(titles.some((t) => /application sent/i.test(t)));
});

test('a run that sent nothing claims nothing', async () => {
  // The other direction, and the one that matters more: a false "submitted"
  // marks a job applied that never was, and he stops applying to it.
  const posted = [];
  const { listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await askFrom(listeners, 7, { type: 'filled', result: { filled: 4, checked: 1 } });
  assert.equal(posted.at(-1).submitted, '', 'an empty string, never a stale one');
});

test('a run that fills nothing does not claim it did', async () => {
  // The page reports its run; the worker shows it. A press that found nothing
  // reads "0", never a stale count.
  const { listeners, badges } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  await askFrom(listeners, 7, { type: 'filled', result: { filled: 0, checked: 0, uploaded: false } });
  assert.equal(badges.at(-1), '0');
});

test('it tells the server which version of itself is loaded', () => {
  // Chrome does not auto-update an unpacked extension. Without this the server
  // cannot warn him that the fixes are not in the copy Chrome has, and a stale
  // build is indistinguishable from a bug that was never fixed.
  const { listeners, calls } = load({
    manifestVersion: '1.0.0',
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': () => ({ ok: true, status: 200, json: async () => ({ actions: [] }) }),
    },
  });
  return ask(listeners, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' }).then(() => {
    const sent = JSON.parse(calls.find((c) => c.url.includes('/api/plan')).body);
    assert.equal(sent.extensionVersion, '1.0.0');
  });
});

test('the manifest version matches what the dashboard expects', async () => {
  // If these drift, every real run warns him to reload an extension that is
  // already current — and a warning he learns to ignore is worse than none.
  const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf-8'));
  const { EXPECTED_EXTENSION } = await import('../apply-plan.mjs');
  assert.equal(manifest.version, EXPECTED_EXTENSION,
    'bump manifest.json and EXPECTED_EXTENSION together');
});

test('the toolbar listener DELEGATES rather than duplicating', () => {
  // If the listener grew a body of its own, every test would exercise a
  // different code path from the one a click actually takes — worse than no
  // test. It is allowed to guard (it now checks for a stale build first); it is
  // not allowed to reimplement the run.
  const src = readFileSync(path.join(HERE, 'background.js'), 'utf-8');
  assert.match(src, /chrome\.action\.onClicked\.addListener\(\(tab\) => \{ openPanel\(tab\); return press\(tab\); \}\);/,
    'the click goes straight to press — the same function a harness drives');
  const pressSrc = src.slice(src.indexOf('async function press('));
  const body = pressSrc.slice(0, pressSrc.indexOf('\n}') + 2);
  assert.match(body, /runOnTab\(tab\.id/, 'and press must end in the same runOnTab a harness drives');
  assert.ok(!/executeScript/.test(body), 'it must not inject on its own');
  assert.ok(!/followedApply/.test(body), 'nor re-implement the Apply-follow');
  assert.match(src, /self\.runOnTab = runOnTab;/, 'and runOnTab must stay reachable from a harness');
  assert.match(src, /self\.press = press;/, 'as must press');
});

test('A RUN TELLS THE DASHBOARD WHAT IT DID', async () => {
  // Until this existed the extension could ask for a plan, a resume and an
  // option, and had no way to say what it did with them. The flow he actually
  // uses — click Jarvis on a form — therefore left NO record: nothing in
  // Review & Send, no list of what was filled, no list of what it could not
  // answer. All of it lived in an on-page panel and died with the tab.
  //
  // The PAGE reports, at the end of every run, because a run can outlast the
  // five minutes Chrome gives this worker for one event. The worker records.
  const posted = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  sandbox.chrome.tabs.get = async () => ({ status: 'complete', url: 'https://boards.greenhouse.io/x/jobs/1' });
  sandbox.chrome.scripting.executeScript = async () => [{ result: { started: true } }];

  await sandbox.runOnTab(11);
  assert.equal(posted.length, 0, 'the injection itself records nothing — the page has not finished');
  await askFrom(listeners, 11, { type: 'filled', result: {
    filled: 7, checked: 1, uploaded: true,
    unanswered: ['step 1: Website / Portfolio'],
  } });

  assert.equal(posted.length, 1, 'exactly one report per run');
  assert.equal(posted[0].filled, 7);
  assert.equal(posted[0].uploaded, true);
  assert.deepEqual(posted[0].unanswered, ['step 1: Website / Portfolio'],
    'what it could not answer has to travel too — that is the list he reads');
  assert.match(posted[0].pageUrl, /greenhouse/, 'and the page, so the server can match the posting');
});

test('a dashboard that is down never turns a filled form into an error', async () => {
  // Best-effort by design: the fill already happened. Failing the run because
  // the record could not be written would throw away the work to report it.
  const { sandbox } = load({ reachable: [] });
  sandbox.chrome.tabs.get = async () => ({ status: 'complete', url: 'https://x.test/apply' });
  sandbox.chrome.scripting.executeScript = async () => [{ result: { filled: 3, checked: 0, uploaded: false } }];

  const out = await sandbox.runOnTab(12);
  assert.ok(Array.isArray(out), 'the run still returns its summaries');
  assert.equal(out[0].filled, 3, 'and still reports what it filled');
});

test('IT CHECKS FOR A NEW VERSION WITHOUT BEING CLICKED', async () => {
  // F-245. reloadIfStale only ever ran from the toolbar handler, so the copy
  // Chrome runs could only be refreshed by someone already clicking — and his
  // was 1.0.0 for two days while the repo reached 1.25.0, because the button he
  // was pressing belonged to a different extension.
  const { sandbox, listeners } = load({
    manifestVersion: '1.0.0',
    routes: {
      '/api/apply-token': okToken,
      '/api/extension': () => ({ ok: true, status: 200, json: async () => ({ expected: '1.26.0' }) }),
    },
  });
  const alarm = sandbox.chrome.alarms.created.find((a) => /version/i.test(a.name));
  assert.ok(alarm, 'a recurring version check must be scheduled at startup');
  assert.ok(alarm.opts.periodInMinutes > 0, 'and it must repeat');

  let reloaded = 0;
  sandbox.chrome.runtime.reload = () => { reloaded += 1; };
  await listeners.alarm({ name: alarm.name });
  assert.equal(reloaded, 1, 'a stale copy reloads itself from disk, no click involved');
});

test('it does NOT reload in a loop when the files on disk are behind', async () => {
  // The failure mode a timer introduces: if EXPECTED_EXTENSION was bumped
  // without saving the manifest, reloading changes nothing and on a five-minute
  // alarm the extension restarts itself forever.
  const { sandbox, listeners } = load({
    manifestVersion: '1.0.0',
    routes: {
      '/api/apply-token': okToken,
      '/api/extension': () => ({ ok: true, status: 200, json: async () => ({ expected: '9.9.9' }) }),
    },
  });
  let reloaded = 0;
  sandbox.chrome.runtime.reload = () => { reloaded += 1; };
  const alarm = sandbox.chrome.alarms.created[0].name;
  await listeners.alarm({ name: alarm });
  await listeners.alarm({ name: alarm });
  await listeners.alarm({ name: alarm });
  assert.equal(reloaded, 1, 'it tries once for a given expected version and then stops');
});

test('a version check never interrupts a fill in progress', async () => {
  // Reloading tears down this worker and the content scripts it is talking to.
  // Doing that mid-form would abandon a half-filled application.
  const { sandbox, listeners } = load({
    manifestVersion: '1.0.0',
    routes: {
      '/api/apply-token': okToken,
      '/api/extension': () => ({ ok: true, status: 200, json: async () => ({ expected: '1.26.0' }) }),
      '/api/plan': () => ({ ok: true, status: 200, json: async () => ({ actions: [] }) }),
      '/api/filled': () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    },
  });
  let reloaded = 0;
  sandbox.chrome.runtime.reload = () => { reloaded += 1; };

  // Hold the run open, fire the alarm while it is inside runOnTab.
  //
  // inject() calls executeScript TWICE — netwatch into the page world, then the
  // filler — so only the FIRST call is held open; holding both means the run
  // never finishes and the whole test file times out, which is what the first
  // version of this did.
  let release = () => {};
  let calls = 0;
  const done = [{ result: { filled: 1, checked: 0, uploaded: true } }];
  sandbox.chrome.scripting.executeScript = () => {
    calls += 1;
    if (calls > 1) return Promise.resolve(done);
    return new Promise((r) => { release = () => r(done); });
  };
  const running = sandbox.self.runOnTab(7);
  await new Promise((r) => setTimeout(r, 10));
  await listeners.alarm({ name: sandbox.chrome.alarms.created[0].name });
  assert.equal(reloaded, 0, 'no reload while a form is being filled');

  release();
  await running;
  await listeners.alarm({ name: sandbox.chrome.alarms.created[0].name });
  assert.equal(reloaded, 1, 'and it catches up as soon as the run is done');
});

test('A DIFFERENT POSTING PASTED INTO THE ARMED TAB DROPS THE APPLICATION', async () => {
  // The tab carries its application across pages that say nothing about which
  // job they are. Right for a Workday form; wrong for a Workday POSTING he
  // navigated to — its form would get the previous employer's resume. Two
  // URLs with different requisition ids are two jobs.
  const { sandbox, listeners, fire } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-page': okJson({ id: 'jabil-1', status: 'tailoring', company: 'Jabil' }),
    },
  });
  await sandbox.arm(2, { started: true });
  await askFrom(listeners, 2, { type: 'posting',
    pageUrl: 'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/job/FL/Manufacturing-Engineer_R123456',
    posting: { title: 'Manufacturing Engineer', company: 'Jabil' } });
  let st = await sandbox.armedState(2);
  assert.equal(st.id, 'jabil-1');
  assert.equal(st.token, 'workday:Manufacturing-Engineer_R123456', 'the posting id of the page that set it');

  // The form for the SAME posting: same id, still his.
  await fire.committed({ tabId: 2, frameId: 0, url: 'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/job/FL/Manufacturing-Engineer_R123456/apply/applyManually' });
  st = await sandbox.armedState(2);
  assert.equal(st.id, 'jabil-1', 'the apply page of the same posting keeps the application');

  // A page with NO id says nothing.
  await fire.committed({ tabId: 2, frameId: 0, url: 'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/login' });
  assert.equal((await sandbox.armedState(2)).id, 'jabil-1', 'a sign-in page proves nothing and drops nothing');

  // A DIFFERENT posting.
  await fire.committed({ tabId: 2, frameId: 0, url: 'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/job/TX/Test-Engineer_R999999' });
  st = await sandbox.armedState(2);
  assert.ok(st, 'the tab stays armed');
  assert.equal(st.id, null, 'but the application is forgotten');
  assert.equal(st.started, false, 'and it is not one he started — its Apply is not followed');
});

test('AN IDENTITY PROVIDER IS NEVER INJECTED', async () => {
  // Signing in is his; the page has nothing to fill; and a filler that so
  // much as reads a Google sign-in page is one that should not exist.
  let runs = 0;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.files?.includes('content.js')) runs += 1; return [{ result: { filled: 0 } }]; };
  await sandbox.arm(7);
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'https://login.microsoftonline.com/common/oauth2', 'https://www.linkedin.com/uas/login']) {
    // eslint-disable-next-line no-await-in-loop
    await fire.updated(7, { status: 'complete' }, url);
  }
  await settleFollow();
  assert.equal(runs, 0);
  assert.ok(await sandbox.armedState(7), 'and the tab stays armed for the page he comes back to');

  await fire.updated(7, { status: 'complete' }, 'https://jabil.wd1.myworkdayjobs.com/x/apply');
  await settleFollow();
  assert.equal(runs, 1, 'which is followed');

  // A FRAME LOAD carries no URL. Google's sign-in page loads iframes; "a
  // frame loaded" must not be the way in.
  sandbox.chrome.tabs.get = async () => ({ status: 'complete', url: 'https://accounts.google.com/v3/signin/identifier' });
  await fire.completed({ tabId: 7, frameId: 4 });
  await settleFollow();
  assert.equal(runs, 1, 'a frame of an identity provider page is not injected either');
});

test('THE RECORD IS THE TAB\'S TOTAL, not the last run\'s', async () => {
  // An application is many runs now, and the last of them is nearly always a
  // no-op on the Review or thank-you page. Reporting each run on its own made
  // Review & Send say "filled 0" about an application with fourteen answers.
  const posted = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await sandbox.arm(5, { id: 'job-5' });
  await askFrom(listeners, 5, { type: 'filled', result: { filled: 9, checked: 2, unanswered: ['step 1: GPA'], pageUrl: 'https://x.wd5.myworkdayjobs.com/a/apply', stoppedBecause: 'sign in here' } });
  await askFrom(listeners, 5, { type: 'filled', result: { filled: 5, checked: 0, uploaded: true, unanswered: ['step 1: GPA', 'step 2: Portfolio'], pageUrl: 'https://x.wd5.myworkdayjobs.com/a/apply', stoppedBecause: 'reached the last step before Submit', auto: true } });
  const last = posted.at(-1);
  assert.equal(last.filled, 14, 'summed');
  assert.equal(last.checked, 2);
  assert.equal(last.uploaded, true, 'once attached, always attached');
  assert.deepEqual(last.unanswered, ['step 1: GPA', 'step 2: Portfolio'], 'a union, not the last list');
  assert.equal(last.reachedReview, true);
  assert.equal(last.id, 'job-5');

  // The no-op on the thank-you page records nothing new…
  const before = posted.length;
  await askFrom(listeners, 5, { type: 'filled', result: { filled: 0, checked: 0, auto: true, pageUrl: 'https://x.wd5.myworkdayjobs.com/a/review' } });
  assert.equal(posted.length, before, 'a run that did nothing is not a record');
  // …and the total on the badge is the total.
  assert.equal((await sandbox.armedState(5)).acc.filled, 14);
});

test('THE SIDE PANEL IS ANSWERED: the posting by the armed tab\'s id, the PDF by id, and a press for its tab', async () => {
  const asked = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/panel': (opts, calls) => { asked.push(calls.at(-1).url); return { ok: true, status: 200, json: async () => ({ job: { id: 'job-9', title: 'ME I', company: 'Acme' }, fit: { score: 70 }, application: null, submit: false }) }; },
      '/api/apply-resume': () => ({
        ok: true, status: 200,
        arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
        json: async () => ({}),
        // The name the panel saves it under comes from this header, not from
        // the blob (F-373).
        headers: { get: (h) => (/content-disposition/i.test(h) ? 'attachment; filename="Alex Rivera Resume.pdf"' : null) },
      }),
    },
  });
  sandbox.chrome.tabs.get = async (id) => ({ id, url: 'https://x.wd5.myworkdayjobs.com/a/apply', title: 'Apply — Acme', windowId: 1 });
  sandbox.chrome.scripting.executeScript = async () => [{ result: 'Manufacturing Engineer I' }];
  await sandbox.arm(9, { id: 'job-9', company: 'Acme' });

  // From the panel page: no sender.tab.
  const fromPanel = (msg) => new Promise((resolve) => { listeners.message(msg, {}, resolve); });
  const r = await fromPanel({ type: 'panel', tabId: 9 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.job.id, 'job-9');
  assert.equal(r.armed.id, 'job-9', 'the tab\'s own application travels with it');
  assert.match(String(asked[0]), /id=job-9/, 'asked by the armed tab\'s id, whatever the page');
  assert.match(String(asked[0]), /heading=Manufacturing\+Engineer\+I/, 'with the page\'s heading, for a page that must be matched by title');

  const pdf = await fromPanel({ type: 'panel-resume', id: 'job-9' });
  assert.equal(pdf.ok, true);
  assert.equal(Buffer.from(pdf.pdf, 'base64').toString(), '%PDF', 'the bytes, base64, as a message can carry them');
  assert.equal(pdf.filename, 'Alex Rivera Resume.pdf',
    'and the name it saves under — a blob URL has none, so the panel showed a random id (F-373)');

  const st = await fromPanel({ type: 'panel-state', tabId: 9 });
  assert.equal(st.ok, true);
  assert.equal(st.armed.id, 'job-9');
  assert.equal(st.running, false);

  const note = await new Promise((resolve) => {
    sandbox.fetch = ((orig) => async (url, opts) => (url.endsWith('/api/panel-retailor') ? { ok: true, status: 202, json: async () => ({ ok: true, id: 'job-9', status: 'tailoring', body: JSON.parse(opts.body) }) } : orig(url, opts)))(sandbox.fetch);
    listeners.message({ type: 'panel-retailor', id: 'job-9', request: 'lead with the fixture' }, {}, resolve);
  });
  assert.equal(note.ok, true, JSON.stringify(note));
  assert.equal(note.body.request, 'lead with the fixture', 'his note is posted as given');

  sandbox.fetch = ((orig) => async (url, opts) => {
    if (url.includes('/api/cover-letter')) return { ok: true, status: opts?.method === 'POST' ? 202 : 200, json: async () => (opts?.method === 'POST' ? { ok: true, id: 'job-9', status: 'writing', body: JSON.parse(opts.body) } : { status: 'ready', text: 'Dear Hiring Manager,\n\nAlex Rivera', problems: [] }) };
    return orig(url, opts);
  })(sandbox.fetch);
  const letter = await fromPanel({ type: 'cover-letter', id: 'job-9', request: 'mention the cobot' });
  assert.equal(letter.ok, true, JSON.stringify(letter));
  assert.equal(letter.body.request, 'mention the cobot', 'his note travels with the ask');
  const read = await fromPanel({ type: 'cover-letter-get', id: 'job-9' });
  assert.equal(read.status, 'ready');
  assert.match(read.text, /Alex Rivera/);
  sandbox.chrome.scripting.executeScript = async ({ args }) => [{ result: { found: true, got: args[0] } }];
  const put = await fromPanel({ type: 'fill-text', tabId: 9, text: 'Dear Hiring Manager' });
  assert.equal(put.found, true, 'the letter goes into the page through a script, never a fetch');
  sandbox.chrome.scripting.executeScript = async () => [{ result: 'Manufacturing Engineer I' }];

  const pressed = await fromPanel({ type: 'press', tabId: 9 });
  assert.equal(pressed.ok, true);
  assert.equal(pressed.tabId, 9, 'the panel\'s Fill is the toolbar press for its tab');

  // The same message from a PAGE is not the panel's: a content script cannot press for a tab.
  const notPanel = await new Promise((resolve) => { listeners.message({ type: 'press', tabId: 9 }, { tab: { id: 3 } }, resolve); });
  assert.notEqual(notPanel?.tabId, 9);
});

test('APPLY THAT LANDS ON THE SAME JOB UNDER ANOTHER STORE ROW IS STILL HIS APPLICATION (F-366)', async () => {
  // jobs.appliedmaterials.com -> careers.appliedmaterials.com (Eightfold):
  // the page says "following" before its Apply click; the next page resolves
  // to a second row for the same job. "He started this" must survive.
  const { sandbox, listeners } = load({
    routes: { '/api/apply-token': okToken, '/api/apply-page': okJson({ id: 'job-B', company: 'Applied Materials', title: 'Manufacturing Engineer', recorded: false, status: 'ready' }) },
  });
  await sandbox.arm(4, { id: 'job-A', company: 'Applied Materials', started: true });
  await askFrom(listeners, 4, { type: 'following', pageUrl: 'https://jobs.appliedmaterials.com/job/x/1' });
  const r = await askFrom(listeners, 4, { type: 'posting', pageUrl: 'https://careers.appliedmaterials.com/careers/job/790318282542?domain=appliedmaterials.com', posting: { title: 'Manufacturing Engineer', company: 'Applied Materials' } });
  assert.equal(r.started, true, 'the application he began continues on the ATS');
  assert.equal((await sandbox.armedState(4)).id, 'job-B', 'under the row the ATS page resolves to');

  // Without "following" — he browsed to another posting — it is a different job.
  await sandbox.arm(5, { id: 'job-A', company: 'Applied Materials', started: true });
  const r2 = await askFrom(listeners, 5, { type: 'posting', pageUrl: 'https://careers.appliedmaterials.com/careers/job/790318282542?domain=appliedmaterials.com', posting: { title: 'Manufacturing Engineer', company: 'Applied Materials' } });
  assert.equal(r2.started, false, 'a posting he navigated to is read, never applied to');
});

test('A WALK STARTED OVER REPLACES THE TOTAL — it does not add to it (F-361)', async () => {
  // Three presses on Becton Dickinson's 34-field form recorded "102 filled".
  const posted = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await sandbox.arm(6, { id: 'job-6' });
  const apply = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Co/publication/abc-123?dcr_ci=Co';
  const screening = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Co/publication/abc-123/screening?dcr_ci=Co';
  // His press: step 1 on the apply page, then the walk's own step 2.
  await askFrom(listeners, 6, { type: 'filled', result: { filled: 29, checked: 1, uploaded: true, unanswered: ['step 1: Website'], startedOn: apply, pageUrl: screening, stoppedBecause: 'reached the last step before Submit' } });
  // A navigation the watcher followed carries on: it adds.
  await askFrom(listeners, 6, { type: 'filled', result: { filled: 4, checked: 1, auto: true, startedOn: screening, pageUrl: screening } });
  assert.equal(posted.at(-1).filled, 33, 'a follow-on run adds to the walk');
  // He presses again on the page the walk began on: a new walk of the same form.
  await askFrom(listeners, 6, { type: 'filled', result: { filled: 34, checked: 2, uploaded: true, unanswered: ['step 1: Website'], startedOn: apply, pageUrl: screening, stoppedBecause: 'reached the last step before Submit' } });
  const last = posted.at(-1);
  assert.equal(last.filled, 34, 'the record is the latest walk, not three walks summed');
  assert.equal(last.checked, 2);
  assert.deepEqual(last.unanswered, ['step 1: Website']);
  assert.equal((await sandbox.armedState(6)).acc.filled, 34);
});

test('…AND THE RESUME STAYS ATTACHED ACROSS THAT RESTART (F-407)', async () => {
  // Read off a live Physical Intelligence application: the first press logged
  // "resume ATTACHED", the second press reset the total, the second pass had
  // nothing to upload because the file was already on the form, and the tab's
  // record then read `uploaded: false` over a form holding his resume. The
  // counts are of what THIS walk did; "the resume is attached" is a fact about
  // the page, and walking the form again does not un-attach it.
  const posted = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await sandbox.arm(11, { id: 'job-11' });
  const form = 'https://jobs.ashbyhq.com/physicalintelligence/567d620f/application';
  await askFrom(listeners, 11, { type: 'filled', result: { filled: 3, uploaded: true, startedOn: form, pageUrl: form, stoppedBecause: 'a single-page application' } });
  assert.equal(posted.at(-1).uploaded, true, 'the first walk attached it');
  // He presses again on the same form; nothing is left to upload.
  await askFrom(listeners, 11, { type: 'filled', result: { filled: 3, uploaded: false, startedOn: form, pageUrl: form, stoppedBecause: 'a single-page application' } });
  assert.equal(posted.at(-1).filled, 3, 'the counts are this walk, not two walks summed');
  assert.equal(posted.at(-1).uploaded, true, 'and the form still holds his resume');
  assert.equal((await sandbox.armedState(11)).acc.uploaded, true);

  // A DIFFERENT form starts clean — nothing is carried between applications.
  const other = 'https://jobs.ashbyhq.com/someone-else/999/application';
  await askFrom(listeners, 11, { type: 'filled', result: { filled: 1, uploaded: false, startedOn: other, pageUrl: other, stoppedBecause: 'a single-page application' } });
  assert.equal(posted.at(-1).uploaded, true, 'the walk carried on rather than restarting');
});

test('A BROWSER WITH NO SIDE PANEL GETS THE PANEL DOCKED INTO THE PAGE (F-411, F-415)', async () => {
  // Opera GX is Chromium and runs this extension, but has no `chrome.sidePanel`
  // at all. The call was undefined, the failure was swallowed as "no panel in
  // this Chrome", and pressing Jarvis there filled the form while nothing
  // appeared. His words: "why is there no extension panel popping out of the
  // side on opera gx".
  // The first fix opened a separate window and he rejected it: "i still want
  // it to be a part of the same window not separate ones, similar to the one
  // in chrome or simplify". So it docks into the page instead.
  const { sandbox, windows, injected } = load({ routes: { '/api/apply-token': okToken } });
  await sandbox.openPanel({ id: 7, windowId: 3 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(windows.length, 0, 'no separate window');
  const dock = injected.find((i) => String(i.args?.[0] || '').includes('panel.html'));
  assert.ok(dock, `the panel was injected into the page: ${JSON.stringify(injected)}`);
  assert.equal(dock.target.tabId, 7, 'into the tab that was pressed');
  assert.match(String(dock.args[0]), /panel\.html\?tab=7$/, 'pinned to that tab, so it follows that application');
});

test('…and a page that will not host a frame still gets a window (F-415)', async () => {
  // chrome:// pages, the Web Store, a site whose CSP refuses the frame. The
  // window is the last rung, never the first.
  const { sandbox, windows } = load({ routes: { '/api/apply-token': okToken }, injectFails: true });
  await sandbox.openPanel({ id: 7, windowId: 3 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(windows.length, 1, 'it falls all the way through rather than saying nothing');
  assert.match(windows[0].url, /panel\.html\?tab=7$/);
});

test('…and a browser WITH a side panel still uses it', async () => {
  const { sandbox, windows, panelOpens, injected } = load({ routes: { '/api/apply-token': okToken }, sidePanel: true });
  await sandbox.openPanel({ id: 7, windowId: 3 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(panelOpens.length, 1, "Chrome's own side panel is what opens");
  assert.equal(injected.filter((i) => String(i.args?.[0] || '').includes('panel.html')).length, 0, 'and nothing is put into the page');
  // From the worker's own realm, so compared by value rather than prototype.
  assert.equal(JSON.stringify(panelOpens[0]), JSON.stringify({ windowId: 3 }));
  assert.equal(windows.length, 0, 'and no window is opened beside it');
});

test('…and a side panel that REFUSES falls back to the dock', async () => {
  // Chrome rejects sidePanel.open outside a user gesture. The panel is the
  // point of the press, so a refusal opens the window rather than saying
  // nothing at all.
  const { sandbox, injected } = load({ routes: { '/api/apply-token': okToken }, sidePanel: 'refuses' });
  await sandbox.openPanel({ id: 7, windowId: 3 });
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(injected.some((i) => String(i.args?.[0] || '').includes('panel.html')), 'the refusal is not swallowed');
});

test('the page an application is recorded on is never an identity provider\'s', async () => {
  const posted = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await sandbox.arm(5, { id: 'job-5' });
  await askFrom(listeners, 5, { type: 'filled', result: { filled: 3, pageUrl: 'https://acme.wd5.myworkdayjobs.com/a/apply' } });
  await askFrom(listeners, 5, { type: 'filled', result: { filled: 0, signInRequired: true, pageUrl: 'https://accounts.google.com/signin', unanswered: [] } });
  assert.match(posted.at(-1).pageUrl, /myworkdayjobs/, 'the application lives on the ATS, whatever page the last run saw');
});

test('A WIDGET FRAME NEVER SPEAKS FOR THE TAB', async () => {
  // Every Eightfold page carries an invisible reCAPTCHA iframe. It is injected
  // like any frame, finds no fields, answers first, and on Lam and Micron its
  // report set the tab's page URL to a recaptcha.net anchor and its stop
  // reason to "not a multi-step application" before the real page had even
  // pressed Apply.
  const posted = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': (opts) => { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
    },
  });
  await sandbox.arm(9, { id: 'job-9' });
  const fromFrame = (msg, frameId) => new Promise((resolve) => { listeners.message(msg, { tab: { id: 9 }, frameId }, resolve); });
  const widget = await fromFrame({ type: 'filled', result: { filled: 0, checked: 0, stoppedBecause: 'this page is not a multi-step application',
    pageUrl: 'https://www.recaptcha.net/recaptcha/api2/anchor?ar=1&k=abc', frame: 'https://www.recaptcha.net/recaptcha/api2/anchor?ar=1' } }, 4);
  assert.equal(widget.recorded, false, 'a captcha frame is furniture');
  const idle = await fromFrame({ type: 'filled', result: { filled: 0, checked: 0, stoppedBecause: 'no form controls here', pageUrl: 'https://careers.x.test/embed', frame: 'https://careers.x.test/embed' } }, 5);
  assert.equal(idle.recorded, false, 'a subframe that did nothing says nothing');
  assert.equal(posted.length, 0, 'and neither reaches the server');
  const st0 = await sandbox.armedState(9);
  assert.equal(st0.acc.pageUrl, '', 'the tab has no page URL yet — the widget did not get to set one');

  // The top frame, having pressed Apply and filled the form, is the record.
  await fromFrame({ type: 'filled', result: { filled: 12, checked: 2, pageUrl: 'https://careers.x.test/careers/apply?pid=1', frame: 'https://careers.x.test/careers/apply?pid=1', stoppedBecause: 'reached the last step before Submit' } }, 0);
  const st = await sandbox.armedState(9);
  assert.equal(st.acc.pageUrl, 'https://careers.x.test/careers/apply?pid=1');
  assert.equal(st.acc.filled, 12);
  assert.match(st.acc.stoppedBecause, /last step/);
  // A subframe that DID work (Greenhouse's embedded form) still counts.
  const embedded = await fromFrame({ type: 'filled', result: { filled: 3, checked: 0, pageUrl: 'https://boards.greenhouse.io/embed/job_app?token=1', frame: 'https://boards.greenhouse.io/embed/job_app?token=1' } }, 6);
  assert.equal(embedded.recorded, true);
  assert.equal((await sandbox.armedState(9)).acc.filled, 15);
  // …and a subframe that saw something decisive is heard even with no work.
  const dead = await fromFrame({ type: 'filled', result: { filled: 0, checked: 0, postingGone: 'Page not found', pageUrl: 'https://careers.x.test/embed', frame: 'https://careers.x.test/embed' } }, 7);
  assert.equal(dead.recorded, true);
});

test('the tab\'s current job travels with the posting, so the same job is not recorded twice', async () => {
  let received = null;
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-page': (opts) => { received = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: 'job-a' }) }; },
    },
  });
  await sandbox.arm(2, { id: 'job-a', company: 'Acme' });
  await askFrom(listeners, 2, { type: 'posting', pageUrl: 'https://jobs.lever.co/acme/1', posting: { title: 'ME' } });
  assert.equal(received.currentId, 'job-a');
});

test('a subframe\'s plan waits for the page\'s posting to resolve, so it carries the id', async () => {
  // A Greenhouse form in an iframe asks for its plan the moment it loads; the
  // page around it is still telling the server which job this is. Without
  // the wait, the frame's plan — and its resume request — go out with no id.
  let release = null;
  const seen = [];
  const { sandbox, listeners } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-page': () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ id: 'slow-1' }) }); }),
      '/api/plan': (opts) => { seen.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ actions: [] }) }; },
    },
  });
  await sandbox.arm(2);
  const top = new Promise((resolve) => { listeners.message({ type: 'posting', pageUrl: 'https://acme.test/jobs/1', posting: { title: 'ME' } }, { tab: { id: 2 }, frameId: 0 }, resolve); });
  await new Promise((r) => setTimeout(r, 20));
  const frame = new Promise((resolve) => { listeners.message({ type: 'plan', fields: [], pageUrl: 'https://boards.greenhouse.io/embed/job_app?for=acme' }, { tab: { id: 2 }, frameId: 7 }, resolve); });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, 0, 'the frame\'s plan has not gone out yet');
  release();
  await top; await frame;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'slow-1', 'and when it does, it carries the id the page resolved');
});

test('THE DASHBOARD CAN OPEN A TAB THAT IS ALREADY ARMED — and nothing else can', async () => {
  // "Apply now" on the dashboard used to open the posting and leave the press
  // to him. The dashboard page is the one origin the extension listens to.
  const { sandbox, listeners, fire, created } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  assert.ok(listeners.external, 'the worker listens for the dashboard');

  const ask = (msg, sender) => new Promise((resolve) => { listeners.external(msg, sender, resolve); });
  const stranger = await ask({ type: 'open', url: 'https://evil.test/x' }, { origin: 'https://evil.test' });
  assert.equal(stranger.ok, false, 'a page that is not the dashboard is refused, manifest or no manifest');
  assert.equal(created.length, 0);

  const ping = await ask({ type: 'ping' }, { origin: 'http://localhost:4300' });
  assert.equal(ping.ok, true);

  const url = 'https://jabil.wd1.myworkdayjobs.com/en-US/Jabil_Careers/job/FL/Manufacturing-Engineer_R123456';
  const opened = await ask({ type: 'open', url, id: 'job-21', company: 'Jabil', title: 'Manufacturing Engineer' }, { origin: 'http://127.0.0.1:4300/' });
  assert.equal(opened.ok, true);
  assert.equal(created[0].url, url, 'the tab is opened on the posting');
  const st = await sandbox.armedState(21);
  assert.ok(st, 'and armed before it has loaded');
  assert.equal(st.id, 'job-21', 'with the job the dashboard already knows');
  assert.equal(st.started, true, 'as an application he started');
  assert.equal(st.token, 'workday:Manufacturing-Engineer_R123456');

  // Its first page load is HIS PRESS, not a follow-along run: it fills the
  // form the way a press does and follows Apply.
  let ctx = null;
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.args) ctx = o.args[0]; return [{ result: { filled: 1 } }]; };
  await fire.updated(21, { status: 'complete' }, url);
  await settleFollow();
  assert.ok(ctx, 'the page was run');
  assert.equal(ctx.auto, false, 'as a press');
  assert.equal(ctx.started, true);

  // The next page is followed as usual.
  ctx = null;
  await fire.updated(21, { status: 'complete' }, `${url}/apply/applyManually`);
  await settleFollow();
  assert.equal(ctx.auto, true, 'a follow-along run from then on');
});

test('THE PRESS ASKS CHROME FOR EVERY SITE, because Chrome withheld it', async () => {
  // F-309. The extension was installed with activeTab and later asked for
  // <all_urls>. Chrome does not hand that over: it keeps site access at "On
  // click", so his clicks work and every injection with no click behind it —
  // the whole of following — is HELD forever, not refused. Measured in his
  // Chrome: executeScript of `() => 1` hung on every tab. permissions.request
  // needs a gesture, and the press is one.
  let asked = null;
  const { sandbox } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.permissions = {
    contains: async () => false,
    request: async (o) => { asked = o; return true; },
  };
  sandbox.chrome.scripting.executeScript = async () => [{ result: { filled: 1 } }];
  await sandbox.press({ id: 4 });
  // JSON, not deepEqual: the object was made in the sandbox's realm.
  assert.equal(JSON.stringify(asked), JSON.stringify({ origins: ['<all_urls>'] }), 'the press asks for every site');

  // Already granted: nothing to ask.
  asked = null;
  sandbox.chrome.permissions.contains = async () => true;
  await sandbox.press({ id: 4 });
  assert.equal(asked, null, 'and does not nag once it has it');
});

test('the dashboard can read whether Chrome withholds it, and can arm or disarm a tab', async () => {
  const { sandbox, listeners } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.chrome.permissions = { contains: async () => false };
  const ask = (msg) => new Promise((resolve) => { listeners.external(msg, { origin: 'http://localhost:4300' }, resolve); });
  const st = await ask({ type: 'status' });
  assert.equal(st.ok, true);
  assert.equal(st.allSites, false, 'the one fact the server cannot know');

  let ran = false;
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.files?.includes('content.js')) ran = true; return [{ result: { filled: 1 } }]; };
  const armed = await ask({ type: 'arm', tabId: 8, id: 'job-8', company: 'Acme' });
  assert.equal(armed.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(await sandbox.armedState(8), 'armed');
  assert.equal(ran, true, 'and filled now, as a press');
  await ask({ type: 'disarm', tabId: 8 });
  assert.equal(await sandbox.armedState(8), null);

  const stranger = await new Promise((resolve) => { listeners.external({ type: 'arm', tabId: 9 }, { origin: 'https://evil.test' }, resolve); });
  assert.equal(stranger.ok, false);
  assert.equal(await sandbox.armedState(9), null, 'no one but the dashboard arms a tab');
});

/**
 * A PAGE THAT KEEPS MOVING AND KEEPS ANSWERING NOTHING IS DONE WITH US.
 *
 * Measured on the finished Applied Materials form (2026-09-06): its autosave
 * mutates the DOM, every mutation during a run sets `pending`, the worker
 * follows again, and each fresh injection resets the PAGE's own runaway
 * counter — so the loop only ended at the 40-run per-tab cap, costing a plan
 * request every turn on a form that was complete. Three quiet follow-along
 * runs on one URL and the tab holds; a real navigation releases it, and so
 * does his press.
 */
test('F-379: a tab stops re-reading one page after three follow-along runs that answered nothing', async () => {
  const FORM = 'https://careers.example.test/careers/apply?pid=1';
  let runs = 0;
  const { sandbox, listeners, fire } = load({
    routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) },
  });
  sandbox.chrome.tabs.get = async () => ({ id: 9, url: FORM, status: 'complete' });
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.files?.includes('content.js')) runs += 1; return [{ result: { filled: 0, sawForm: true, auto: true } }]; };
  await sandbox.arm(9, { id: 'job-9', company: 'Applied Materials', started: true });

  // Three quiet runs, each reported the way the page reports one.
  const quiet = () => askFrom(listeners, 9, { type: 'filled', result: { filled: 0, checked: 0, uploaded: false, unanswered: [], sawForm: true, auto: true, pageUrl: FORM, stoppedBecause: 'a single-page application — everything that could be filled is; Submit is yours' } });
  for (let i = 0; i < 3; i += 1) { await fire.updated(9, { status: 'complete' }, FORM); await settleFollow(); await quiet(); }
  const before = runs;
  await fire.updated(9, { status: 'complete' }, FORM);
  await settleFollow();
  assert.equal(runs, before, 'the fourth twitch of the same page is not followed');
  assert.ok(await sandbox.armedState(9), 'and the tab is still armed — it is holding, not stopped');

  // A REAL NAVIGATION RELEASES IT. The hold is on the url, not the tab.
  const NEXT = 'https://careers.example.test/careers/apply?pid=1&step=2';
  sandbox.chrome.tabs.get = async () => ({ id: 9, url: NEXT, status: 'complete' });
  await fire.updated(9, { status: 'complete' }, NEXT);
  await settleFollow();
  assert.equal(runs, before + 1, 'the next page is read');
});

test('…and a run still waiting for a late form keeps following', async () => {
  // F-360's case must survive F-379: a press before the form paints reports
  // nothing filled and NO form seen, and that tab has to keep watching.
  const PAGE = 'https://boards.example.test/apply';
  let runs = 0;
  const { sandbox, listeners, fire } = load({
    routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) },
  });
  sandbox.chrome.tabs.get = async () => ({ id: 11, url: PAGE, status: 'complete' });
  sandbox.chrome.scripting.executeScript = async (o) => { if (o.files?.includes('content.js')) runs += 1; return [{ result: { filled: 0 } }]; };
  await sandbox.arm(11, { id: 'job-11', company: 'Lam Research', started: true });
  const waiting = () => askFrom(listeners, 11, { type: 'filled', result: { filled: 0, checked: 0, uploaded: false, unanswered: [], auto: true, pageUrl: PAGE, stoppedBecause: 'no form here yet — this tab is followed, and the form fills by itself when it appears' } });
  for (let i = 0; i < 4; i += 1) { await fire.updated(11, { status: 'complete' }, PAGE); await settleFollow(); await waiting(); }
  assert.ok(runs >= 4, `a tab waiting for a form keeps watching it, ran ${runs} time(s)`);
});

/**
 * AN INJECTION THAT NEVER COMES BACK MUST NOT STRAND THE TAB.
 *
 * Measured on Amazon (2026-09-06): the press followed Apply, the page became
 * /applicant/jobs/…/summary, and `chrome.scripting.executeScript` neither
 * resolved nor rejected. The run stayed in the worker's RUNNING map, every
 * follow-along after it was swallowed as `pending`, and the tab — sitting on a
 * page that said "You have already applied for this position" — did nothing at
 * all. The page reports its own result by message, so the worker only has to
 * stop waiting.
 */
test('F-380: a hung injection is let go, and the tab is followed again', async () => {
  const PAGE = 'https://www.amazon.jobs/en/jobs/1/x';
  let runs = 0;
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.__jarvisInjectCap = 60;                       // 60ms instead of three minutes
  sandbox.chrome.tabs.get = async () => ({ id: 14, url: PAGE, status: 'complete' });
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (!o.files?.includes('content.js')) return [{ result: 1 }];
    runs += 1;
    if (runs === 1) return new Promise(() => {});        // the hang, exactly as measured
    return [{ result: { filled: 2 } }];
  };
  await sandbox.arm(14, { id: 'job-14', company: 'Amazon', started: true });
  const first = sandbox.runOnTab(14, { auto: false, reset: true });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(runs, 1, 'the first run went in');
  await first;                                           // it lets go rather than hanging for ever
  await fire.updated(14, { status: 'complete' }, PAGE);
  await settleFollow();
  assert.equal(runs, 2, 'the next navigation is followed instead of being swallowed');
});

test('…and a wizard whose steps share one URL counts each step on its own', async () => {
  // F-379's counter is keyed on the page AND the step signature, so three quiet
  // runs on step 1 of an Eightfold-style SPA do not hold step 2 — which arrives
  // at the same URL. The gate in follow() can only see the URL, so what this
  // proves is the counter: a new step resets it rather than adding to it.
  const URL_ = 'https://careers.example.test/careers/apply?pid=9';
  const { sandbox, listeners } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  await sandbox.arm(31, { id: 'job-31', company: 'Micron Technology', started: true });
  const quiet = (step) => askFrom(listeners, 31, { type: 'filled', result: { filled: 0, checked: 0, uploaded: false, unanswered: [], sawForm: true, auto: true, pageUrl: URL_, where: `${URL_}##${step}`, stoppedBecause: 'nothing to do here' } });
  await quiet('Your Information::12');
  await quiet('Your Information::12');
  let st = await sandbox.armedState(31);
  assert.equal(st.quiet, 2, 'two quiet runs on the same step');
  await quiet('Voluntary Disclosures::7');
  st = await sandbox.armedState(31);
  assert.equal(st.quiet, 1, 'a new step starts the count again');
  assert.equal(st.holdUrl || null, null, 'and nothing is held');
});

test('F-391: a dashboard that restarted is found again, not reported as gone', async () => {
  // The base is cached until something refuses it, and a plain network failure
  // did not count: restart the server and the panel said "Jarvis cannot see
  // this page. Failed to fetch" and kept saying it, because every later call
  // reused the address that had just stopped answering.
  let down = false;
  const { listeners, sandbox } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': () => ({ ok: true, status: 200, json: async () => ({ summary: { fill: 1 }, actions: [] }) }),
    },
  });
  const realFetch = sandbox.fetch;
  sandbox.fetch = async (url, opts) => {
    if (down && !/apply-token/.test(url)) { down = false; throw new TypeError('Failed to fetch'); }
    return realFetch(url, opts);
  };
  const first = await ask(listeners, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  assert.equal(first.ok, true, 'the first call connects');
  down = true;                                   // the server restarts under it
  const after = await ask(listeners, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  assert.equal(after.ok, true, 'the next call finds it again instead of reporting a dead dashboard');
});

test('F-399: what a later run answers leaves the "left for you" list', async () => {
  // The tab's total carried "left for you" across every run of a walk and
  // never took anything off it. Measured on Agility Robotics: a second press
  // answered Degree and Veteran Status — the planner's own reply said "already
  // set to Bachelor's Degree" — and the panel went on listing both as
  // `nothing matched`, over a form that plainly held them.
  const PAGE = 'https://job-boards.greenhouse.io/embed/job_app?for=x';
  const { listeners, sandbox } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  await sandbox.arm(41, { id: 'job-41', company: 'Agility Robotics', started: true });
  await askFrom(listeners, 41, { type: 'filled', result: { filled: 6, checked: 0, uploaded: false, sawForm: true, pageUrl: PAGE,
    unanswered: ['step 1: Degree (nothing matched "Bachelor of Science")', 'step 1: Website', 'step 1: Veteran Status (nothing matched "I am not a Veteran.")'] } });
  let st = await sandbox.armedState(41);
  assert.equal(st.acc.unanswered.length, 3, 'the first run leaves three');

  await askFrom(listeners, 41, { type: 'filled', result: { filled: 2, checked: 0, uploaded: false, sawForm: true, pageUrl: PAGE,
    answered: ['Degree', 'Veteran Status'], unanswered: [] } });
  st = await sandbox.armedState(41);
  // Compared as text: the array comes from the worker's own realm.
  assert.equal(JSON.stringify([...st.acc.unanswered]), JSON.stringify(['step 1: Website']),
    `only what is still his stays; got ${JSON.stringify([...st.acc.unanswered])}`);

  // F-909: a label that merely appears INSIDE a longer question does not
  // answer it (TI's required visa question vanished from the list).
  const VISA = 'U.S. Immigration Form: Do you currently hold an H, L, E, J, or F nonimmigrant visa?';
  await askFrom(listeners, 41, { type: 'filled', result: { filled: 0, checked: 0, uploaded: false, sawForm: true, pageUrl: PAGE, unanswered: [VISA] } });
  await askFrom(listeners, 41, { type: 'filled', result: { filled: 1, checked: 0, uploaded: false, sawForm: true, pageUrl: PAGE, answered: ['visa', 'Form'], unanswered: [] } });
  st = await sandbox.armedState(41);
  assert.ok([...st.acc.unanswered].includes(VISA), `the unanswered visa question stays; got ${JSON.stringify([...st.acc.unanswered])}`);
});

test('F-571: a frame that never loads does not hold the set-up injections — the fill still goes in', async () => {
  // Lyft's careerpuck board, 2026-09-24: the Greenhouse iframe had not loaded,
  // the context and netwatch injections (allFrames, no cap) never returned,
  // and content.js was never injected at all.
  const PAGE = 'https://app.careerpuck.com/job-board/lyft/job/1';
  let filler = 0;
  const { sandbox } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  sandbox.__jarvisSetupCap = 40;
  sandbox.chrome.tabs.get = async () => ({ id: 21, url: PAGE, status: 'complete' });
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (!o.files?.includes('content.js')) return new Promise(() => {});   // waits on the frame for ever
    filler += 1;
    return [{ result: { filled: 30 } }];
  };
  await sandbox.arm(21, { id: 'job-21', company: 'Lyft', started: true });
  const out = await sandbox.runOnTab(21, { auto: false, reset: true });
  assert.equal(filler, 1, 'the fill went in despite the frame');
  assert.equal(out[0].filled, 30);
});

test('a filled LinkedIn message tab is kept in memory; other LinkedIn pages are left to the browser', async () => {
  // Opera discarded Benjamin's and Riley's filled messages at 0.5 GB free
  // (2026-10-05); a click reloaded each compose page empty.
  const { sandbox, fire } = load();
  const kept = [];
  sandbox.chrome.tabs.update = async (id, o) => { kept.push([id, o.autoDiscardable]); return { id }; };
  await fire.updated(7, { url: 'https://www.linkedin.com/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AX&recipient=X' });
  await fire.updated(8, { url: 'https://www.linkedin.com/messaging/thread/new/?recipient=Y' });
  await fire.updated(9, { url: 'https://www.linkedin.com/in/someone/' });
  await fire.updated(10, { url: 'https://www.linkedin.com/messaging/thread/2-abc/' });
  assert.deepEqual(kept, [[7, false], [8, false]]);
  // Tabs filled before the extension loaded are protected when it does.
  sandbox.chrome.tabs.query = async () => [{ id: 11, url: 'https://www.linkedin.com/messaging/compose/?recipient=Z' }, { id: 12, url: 'https://www.linkedin.com/messaging/' }];
  await sandbox.keepOpenLinkedInComposes();
  assert.deepEqual(kept.at(-1), [11, false]);
  assert.equal(kept.length, 3);
});

test('F-825: the panel puts the resume in an EMBEDDED form\'s slot, never "no file slot" (Zipline\'s Greenhouse iframe, 2026-10-22)', async () => {
  const { listeners, sandbox } = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/apply-resume': () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) }),
    },
  });
  const targets = [];
  sandbox.chrome.scripting.executeScript = async (o) => {
    targets.push(o.target);
    if (o.target.allFrames) {
      assert.equal(o.args[3], true, 'the probe of every frame carries no file');
      return [
        { frameId: 0, result: { ok: false, why: 'this page has no file slot' } },
        { frameId: 7, result: { ok: true, named: true, label: 'Resume/CV' } },
        { frameId: 9, result: { ok: true, named: false, label: 'Attach' } },
      ];
    }
    return [{ frameId: o.target.frameIds?.[0], result: { ok: true, name: 'Alex Rivera Resume.pdf', label: 'Resume/CV' } }];
  };
  const r = await new Promise((resolve) => { listeners.message({ type: 'attach-file', tabId: 4, what: 'resume', id: 'job-1', pageUrl: 'https://www.zipline.com/open-roles/1' }, {}, resolve); });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.stringify(targets.at(-1).frameIds), '[7]', 'the file goes only to the frame whose slot is named for it');
  assert.equal(targets.filter((t) => !t.allFrames).length, 1, 'and to one frame only');
});

test('F-826: a call refused mid-restart waits for the dashboard to come back', async () => {
  const reachable = [];
  const { listeners, sandbox } = load({
    reachable,
    routes: {
      '/api/apply-token': okToken,
      '/api/plan': () => ({ ok: true, status: 200, json: async () => ({ summary: {}, actions: [] }) }),
    },
  });
  sandbox.__jarvisReconnectMs = 50;
  reachable.push('http://localhost:4300');
  const first = await ask(listeners, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  assert.equal(first.ok, true);
  reachable.length = 0;                                       // the dashboard restarts…
  setTimeout(() => reachable.push('http://localhost:4300'), 120);   // …and is back 120 ms later
  const second = await ask(listeners, { type: 'plan', fields: [], pageUrl: 'https://x.test/apply' });
  assert.equal(second.ok, true, `the call waited for it: ${JSON.stringify(second)}`);
});

// ── THE OUTREACH SEND SESSION IN CHROME (2026-10-24) ─────────────────
// "can we just use chrome": Chrome ignores the debugging port on its main
// profile, so the Opera fill runs in the extension. One window, a tab each,
// filled in the page's world; each tab marked sent and closed once its text
// is in the thread. Nothing presses Send.
function outreachLoad({ people, gateUrl = null, due = false, sendable = () => true, already = () => false, connectAnswer = () => 'CONNECTED: invitation sent, shows Pending', creditFor = () => 'free message', kind = '', queueFails = 0 } = {}) {
  const marks = [];
  const results = [];
  const notes = [];
  const credits = [];
  const h = load({
    routes: {
      '/api/apply-token': okToken,
      // The server says autoSend only for a due schedule ("s1" here, when `due`).
      '/api/outreach/send-queue': (opts, calls) => {
        // The queue's first reads fail (F-938): a slow or erroring dashboard.
        if (calls.filter((c) => /send-queue/.test(c.url)).length <= queueFails) return { ok: false, status: 500, json: async () => ({ error: 'the dashboard was busy' }) };
        const sid = (calls.at(-1).url.match(/[?&]schedule=(s\d+)/) || [])[1];
        const asked = !!sid;
        return { ok: true, status: 200, json: async () => ({ people, stale: [], noResume: [], ...(asked && due ? { autoSend: true, schedule: sid } : {}), ...(asked && kind ? { kind } : {}) }) };
      },
      '/api/outreach/mark': (opts) => { marks.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ contact: {} }) }; },
      '/api/outreach/schedule/result': (opts) => { results.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
      '/api/outreach/credit': (opts) => { credits.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    },
  });
  const { sandbox } = h;
  sandbox.chrome.notifications = { create: (...a) => notes.push(a) };
  sandbox.__jarvisOutreachScale = 0.002;
  const tabs = new Map();   // tabId -> { url, open, sent, fills }
  const runs = [];
  let nextTab = 300;
  const open = (url) => { const id = nextTab++; tabs.set(id, { url: gateUrl && tabs.size === 0 ? gateUrl : url, open: true, sent: false, fills: 0 }); return id; };
  sandbox.chrome.windows.create = async (o) => { h.windows.push(o); return { id: 77, tabs: [{ id: open(o.url) }] }; };
  sandbox.chrome.windows.update = async () => ({});
  sandbox.chrome.windows.remove = async () => {};
  sandbox.chrome.tabs.create = async (o) => ({ id: open(o.url), windowId: o.windowId });
  sandbox.chrome.tabs.get = async (id) => { const t = tabs.get(id); if (!t?.open) throw new Error('No tab with id'); return { id, url: t.url, status: 'complete' }; };
  sandbox.chrome.tabs.remove = async (id) => { const t = tabs.get(id); if (t) t.open = false; };
  sandbox.chrome.tabs.update = async (id, o) => { const t = tabs.get(id); if (t && o.url) t.url = o.url; return { id }; };
  sandbox.chrome.tabs.query = async () => [];
  sandbox.chrome.scripting.executeScript = async (o) => {
    runs.push({ tabId: o.target.tabId, world: o.world, fn: o.func?.name, args: o.args });
    const t = tabs.get(o.target.tabId);
    if (o.func.name === 'fill' && o.args[0].peek) { t.fills += 1; return [{ result: t.fills === 1 ? 'RETRY: opening the full-page compose; run step 1 again' : `OPEN: the compose form is open for ${o.args[0].name}` }]; }
    if (o.func.name === 'fill') { t.fills += 1; return [{ result: t.fills === 1 ? 'RETRY: opening the full-page compose; run step 1 again' : 'FILLED: subject set, 120 words in the box' }]; }
    if (o.func.name === 'attach') return [{ result: `ATTACHED: ${o.args[0].as}. Ready for him to press Send` }];
    if (o.func.name === 'creditLine') return [{ result: creditFor(o.target.tabId, t) }];
    if (o.func.name === 'connect') { t.connected = (t.connected || 0) + 1; return [{ result: connectAnswer(o.target.tabId) }]; }
    if (o.func.name === 'sentCheck') return [{ result: t.sent ? { inBox: false, onPage: 2 } : already(o.target.tabId) ? { inBox: true, onPage: 2 } : { inBox: true, onPage: 0 } }];
    if (o.func.name === 'send') {
      if (!sendable(o.target.tabId)) return [{ result: 'STOP: the resume does not show as attached' }];
      if (o.args[0].dry) return [{ result: 'SENDABLE: addressed, subject, text and resume all check out' }];
      t.sent = true;
      return [{ result: 'PRESSED: Send' }];
    }
    return [{ result: null }];
  };
  const until = async (ok, what) => { for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`timed out waiting for ${what}: ${JSON.stringify(sandbox.outreachSummary())}`); };
  return { ...h, marks, results, notes, credits, tabs, runs, until };
}
const pressed = (runs) => runs.filter((x) => x.fn === 'send' && !x.args[0].dry);

const PEOPLE = [
  { id: 'c1', name: 'Dana Lee', first: 'Dana', profile: 'https://www.linkedin.com/in/dana', subject: 'S1', message: 'Hi Dana,\nI applied for the Mechanical Engineer role on your team last week and wanted to reach out.', as: 'Alex Rivera Resume - A - B.pdf', pdf: 'JVBERi0=' },
  { id: 'c2', name: 'Sam Roe', first: 'Sam', profile: 'https://www.linkedin.com/in/sam', subject: 'S2', message: 'Hi Sam,\nI applied for the Robotics Engineer role on your team and would value your opinion on my fit.', as: 'Alex Rivera Resume - C - D.pdf', pdf: 'JVBERi0=' },
];

test('Send all: one focused window, a tab each, filled in the page world with the resume bytes', async () => {
  const { listeners, sandbox, windows, runs, until } = outreachLoad({ people: PEOPLE });
  const r = await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
  assert.equal(r.ok, true);
  await until(() => sandbox.outreachSummary()?.phase === 'watching', 'all tabs filled');
  assert.equal(windows.at(-1).focused, true, 'its own focused window: the editor wants a focused page');
  const s = sandbox.outreachSummary();
  assert.deepEqual(s.entries.map((e) => [e.name, e.status, e.credit]), [['Dana Lee', 'ready', 'free message'], ['Sam Roe', 'ready', 'free message']]);
  assert.ok(runs.every((x) => x.world === 'MAIN'), 'the page world, as the DevTools route ran it');
  assert.equal(runs.filter((x) => x.fn === 'fill').length, 4, 'a RETRY (the full-page compose) is run again once loaded');
  const att = runs.find((x) => x.fn === 'attach');
  assert.equal(att.args[0].pdf, 'JVBERi0=');
  assert.equal(att.args[0].as, 'Alex Rivera Resume - A - B.pdf');
  sandbox.chrome.runtime.sendMessage = undefined;
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

test('F-938: a send queue that fails twice is asked again and the session runs; three misses end it with the reason written down', async () => {
  {
    const { listeners, sandbox, until } = outreachLoad({ people: PEOPLE, queueFails: 2 });
    await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
    await until(() => sandbox.outreachSummary()?.phase === 'watching', 'the third read to fill the tabs');
    assert.equal(sandbox.outreachSummary().entries.length, 2);
    sandbox.chrome.runtime.sendMessage = undefined;
    await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
  }
  {
    const { listeners, sandbox, until } = outreachLoad({ people: PEOPLE, queueFails: 3 });
    await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
    await until(() => sandbox.outreachSummary()?.phase === 'done', 'the session to end');
    const s = sandbox.outreachSummary();
    assert.match(String(s.note || ''), /Could not read the send queue from the dashboard after 3 tries .*Nothing was sent/, JSON.stringify(s));
    assert.equal((s.entries || []).length, 0);
  }
});

test('a sent message is marked sent and its tab closes; a closed tab is left unmarked', async () => {
  const { listeners, sandbox, tabs, marks, until } = outreachLoad({ people: PEOPLE });
  await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'watching', 'watching');
  const [a, b] = [...tabs.keys()];
  tabs.get(a).sent = true;     // he pressed Send on Dana's
  tabs.get(b).open = false;    // and closed Sam's
  await until(() => sandbox.outreachSummary()?.phase === 'done', 'the session to end');
  assert.deepEqual(marks, [{ contactId: 'c1', what: 'sent' }], 'only the one he sent is marked');
  assert.deepEqual(sandbox.outreachSummary().entries.map((e) => e.status), ['sent', 'closed']);
  await until(() => tabs.get(a).open === false, 'the sent tab to close');
});

test('CONNECT AFTER SEND (2026-10-26): the sent tab goes to their profile, presses Connect, then closes', async () => {
  const { listeners, sandbox, tabs, runs, until } = outreachLoad({ people: PEOPLE });
  await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'watching', 'watching');
  const [a, b] = [...tabs.keys()];
  tabs.get(a).sent = true;
  await until(() => tabs.get(a).open === false, 'the sent tab to close after connecting');
  const c = runs.filter((x) => x.fn === 'connect');
  assert.equal(c.length, 1, 'one connect, only for the one sent');
  assert.equal(c[0].tabId, a);
  assert.equal(c[0].args[0].name, 'Dana Lee');
  assert.equal(tabs.get(a).url, 'https://www.linkedin.com/in/dana', 'on their profile, not the message page');
  assert.match(sandbox.outreachSummary().entries[0].connect, /^CONNECTED/);
  assert.equal(tabs.get(b).connected, undefined, 'nobody unsent gets an invitation');
  tabs.get(b).open = false;
  await until(() => sandbox.outreachSummary()?.phase === 'done', 'done');
});

test('a connect that cannot go (their email asked) is reported, and the send still counts', async () => {
  const { listeners, sandbox, tabs, marks, until } = outreachLoad({ people: PEOPLE.slice(0, 1), connectAnswer: () => 'STOP: LinkedIn wants their email address to connect; not sent' });
  await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'watching', 'watching');
  tabs.get([...tabs.keys()][0]).sent = true;
  await until(() => sandbox.outreachSummary()?.phase === 'done', 'done');
  const e = sandbox.outreachSummary().entries[0];
  assert.equal(e.status, 'sent');
  assert.match(e.connect, /email/);
  assert.deepEqual(marks, [{ contactId: 'c1', what: 'sent' }]);
});

test('connect(): a dry run presses nothing, a note is typed only when one is given, and it never touches the message box', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const src = ctx.JarvisLinkedIn.connect.toString();
  assert.ok(src.indexOf('if (P.dry) return') > 0 && src.indexOf('if (P.dry) return') < src.indexOf('btn.click()'), 'dry returns before Connect is pressed');
  // Connect first (2026-10-26): the note path runs only with P.note; without
  // one, "Send without a note" as before.
  const noteAt = src.indexOf('if (P.note) return await withNote()');
  assert.ok(noteAt > src.indexOf('btn.click()'), 'the note path starts after Connect, only with a note');
  const plain = src.slice(0, src.indexOf('async function withNote')).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(plain.replace('if (P.note) return await withNote();', ''), /add a note|textarea/i, 'no note typed on the plain path');
  assert.doesNotMatch(src, /contenteditable|msg-form/i, 'never the message box');
  assert.match(src, /send without a note/i);
});

test('CHECK INMAIL (2026-10-26): each message window opened in the background, its line read and stored, nothing typed or sent', async () => {
  const { listeners, sandbox, tabs, runs, credits, windows, until } = outreachLoad({ people: PEOPLE, creditFor: (id, t) => (t.url.includes('dana') ? 'free message' : 'InMail: Use 1 of 6 InMail credits') });
  const r = await new Promise((res) => listeners.external({ type: 'outreach-credits' }, { origin: 'http://localhost:4300' }, res));
  assert.equal(r.ok, true);
  const done = async () => (await new Promise((res) => listeners.external({ type: 'outreach-credits-status' }, { origin: 'http://localhost:4300' }, res)))?.check?.phase === 'done';
  for (let i = 0; i < 400 && !(await done()); i++) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(credits.map((c) => [c.contactId, c.credit]), [['c1', 'free message'], ['c2', 'InMail: Use 1 of 6 InMail credits']]);
  assert.equal(windows.at(-1).focused, false, 'a background window: his screen is left alone');
  assert.ok(runs.filter((x) => x.fn === 'fill').every((x) => x.args[0].peek === true && x.args[0].message === ''), 'peek only: nothing typed');
  assert.equal(runs.filter((x) => /^(send|attach|connect)$/.test(x.fn)).length, 0, 'no send, no attachment, no connect');
  assert.ok([...tabs.values()].filter((t) => /linkedin\.com\/in\//.test(t.url)).every((t) => !t.open), 'every tab closed');
});

test('fill(peek) returns before the message box is touched', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const src = ctx.JarvisLinkedIn.fill.toString();
  const peek = src.indexOf('if (P.peek) return');
  assert.ok(peek > 0 && peek < src.indexOf('set.call(subj') && peek < src.indexOf("dispatchEvent(new W.ClipboardEvent"), 'peek leaves before the subject or text is set');
});

test('a LinkedIn sign-in or security check stops the session; nothing past it is opened', async () => {
  const { listeners, sandbox, runs, until } = outreachLoad({ people: PEOPLE, gateUrl: 'https://www.linkedin.com/checkpoint/challenge/x' });
  await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'done', 'the stop');
  const s = sandbox.outreachSummary();
  assert.match(s.note, /sign in or pass a security check/);
  assert.equal(runs.length, 0, 'no page code runs on a checkpoint');
  assert.deepEqual(s.entries.map((e) => e.status), ['failed', 'failed']);
});

test('only the dashboard can start a send session', async () => {
  const { listeners } = outreachLoad({ people: PEOPLE });
  const r = await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'https://evil.example' }, res));
  assert.equal(r.ok, false);
});

test('only send() can press Send, and only past its dry-run return', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const LI = ctx.JarvisLinkedIn;
  for (const fn of ['fill', 'attach', 'sentCheck', 'creditLine']) {
    assert.doesNotMatch(LI[fn].toString(), /send-btn|msg-form__send|['"]Send['"]|type="submit"|requestSubmit|\.submit\(/i, fn);
  }
  const src = LI.send.toString();
  assert.ok(src.indexOf('if (P.dry) return') > 0 && src.indexOf('if (P.dry) return') < src.indexOf('btn.click()'), 'a dry run returns before the press');
});

test('a conversation that already holds a message is never written into (Jordan, 2026-10-27)', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const LI = ctx.JarvisLinkedIn;
  const root = (texts) => ({ querySelectorAll: () => texts.map((t) => ({ innerText: t })) });
  const note = "Hi Sam, I saw you recruit mechanical and manufacturing engineers for Tesla's powertrain teams.";
  assert.equal(LI.priorMessages([root([])]), 0, 'a new conversation');
  assert.equal(LI.priorMessages([root(['Hey Jordan, saw your post about Drive Systems'])]), 1, 'he wrote to them by hand');
  assert.equal(LI.priorMessages([root([note])], note), 0, 'only his own accepted connection note');
  assert.equal(LI.priorMessages([root([note, 'Thanks Alex, happy to connect!'])], note), 1, 'they wrote back after accepting');
  const fill = LI.fill.toString();
  assert.ok(fill.indexOf('const prior =') > 0 && fill.indexOf('const prior =') < fill.indexOf("'paste'"), 'checked before anything is typed');
});

// A FAKE COMPOSE PAGE, and each page function run from ITS SOURCE ALONE in a
// context holding nothing but the page (F-951). That is how chrome.scripting
// and the DevTools route run them; a test that only reads the source let fill()
// call a helper the page never had, and every message failed on it.
function composePage({ header, box = '', thread = [], sidebar = [] }) {
  const doc = { hidden: false };
  const parse = (sel) => sel.split(',').map((s) => s.trim()).map((s) => {
    const m = s.match(/^([a-z]+)?(#[\w-]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)(\*=|\^=|=)"([^"]*)"\])?$/i);
    if (!m) throw new Error(`fake DOM: unsupported selector ${s}`);
    return { tag: m[1], id: m[2]?.slice(1), cls: (m[3] || '').split('.').filter(Boolean), attr: m[4], op: m[5], val: m[6] };
  });
  const matches = (e, sel) => parse(sel).some((q) => {
    if (q.tag && e.tagName !== q.tag.toUpperCase()) return false;
    if (q.id && e.attrs.id !== q.id) return false;
    if (q.cls.some((c) => !e.cls.includes(c))) return false;
    if (q.attr) {
      const v = q.attr === 'class' ? e.cls.join(' ') : e.attrs[q.attr];
      if (v == null) return false;
      if (q.op === '=' && v !== q.val) return false;
      if (q.op === '^=' && !String(v).startsWith(q.val)) return false;
      if (q.op === '*=' && !String(v).includes(q.val)) return false;
    }
    return true;
  });
  const els = (n) => n.kids.filter((k) => k.tagName).flatMap((k) => [k, ...els(k)]);
  const texts = (n) => n.kids.flatMap((k) => (k.tagName ? texts(k) : [k]));
  class El {
    constructor(tag, { cls = [], ...attrs } = {}, kids = []) {
      Object.assign(this, { tagName: tag.toUpperCase(), cls, attrs, kids: [], ownerDocument: doc, offsetParent: {}, disabled: false, value: '' });
      for (const k of kids) this.add(k);
    }
    add(k) { const n = typeof k === 'string' ? { nodeValue: k } : k; n.parentElement = this; this.kids.push(n); return this; }
    get innerText() { return texts(this).map((t) => t.nodeValue).join(' '); }
    get textContent() { return this.innerText; }
    get classList() { return { contains: (c) => this.cls.includes(c) }; }
    get type() { return this.attrs.type || ''; }
    getAttribute(a) { return this.attrs[a] ?? null; }
    querySelectorAll(s) { return els(this).filter((e) => matches(e, s)); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    closest(s) { for (let e = this; e && e.tagName; e = e.parentElement) if (matches(e, s)) return e; return null; }
    focus() {}
    click() { this.clicked = true; }
    dispatchEvent(ev) { if (ev.type === 'paste') { this.kids = []; this.add(ev.clipboardData.getData('text/plain')); } return true; }
  }
  const subject = new El('input', { name: 'subject' });
  const body = new El('div', { contenteditable: 'true' }, box ? [box] : []);
  const btn = new El('button', { cls: ['msg-form__send-btn'], type: 'submit' }, ['Send']);
  const html = new El('html', {}, [new El('body', {}, [new El('main', {}, [
    // LinkedIn's conversation list, beside the compose pane: other people's names.
    ...(sidebar.length ? [new El('div', { cls: ['msg-conversations-container'] }, sidebar.map((n) => new El('div', { cls: ['msg-conversation-listitem'] }, [n])))] : []),
    new El('h2', {}, [header]),
    new El('ul', {}, thread.map((t) => new El('div', { cls: ['msg-s-event-listitem__body'] }, [t]))),
    new El('form', { cls: ['msg-form'] }, [subject, body, btn]),
  ])])]);
  Object.assign(doc, {
    body: html.kids[0],
    querySelectorAll: (s) => html.querySelectorAll(s),
    querySelector: (s) => html.querySelector(s),
    createTreeWalker: (rootEl, _show, filter) => {
      const list = texts(rootEl).filter((t) => filter.acceptNode(t) === 1);
      let i = -1;
      return { nextNode() { i++; this.currentNode = list[i]; return i < list.length ? list[i] : null; }, currentNode: null };
    },
    defaultView: {
      HTMLInputElement: { prototype: Object.defineProperty({}, 'value', { set(v) { this.value = v; } }) },
      Event: class { constructor(type) { this.type = type; } },
      ClipboardEvent: class { constructor(type, o) { this.type = type; this.clipboardData = o.clipboardData; } },
      DataTransfer: class { constructor() { this.d = {}; } setData(k, v) { this.d[k] = v; } getData(k) { return this.d[k]; } },
    },
  });
  const ctx = vm.createContext({ document: doc, location: { pathname: '/messaging/compose/' }, setTimeout, performance, MessageChannel });
  const run = (fn, P) => vm.runInContext(`(${fn.toString()})`, ctx)(P);
  return { run, subject, body, btn };
}

test('fill() and send() work from their own source alone, in a page holding nothing else (F-951)', async () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const LI = ctx.JarvisLinkedIn;
  const P = { name: 'Dana Reyes', first: 'Dana', subject: 'Applied: Mechanical Engineer', message: 'Hi Dana,\n\nI recently applied for the Mechanical Engineer role on your team and wanted to reach out directly.' };
  const page = composePage({ header: 'Dana Reyes' });
  const out = await page.run(LI.fill, P);
  assert.match(out, /^FILLED/, `fill ran in the bare page: ${out}`);
  assert.equal(page.subject.value, P.subject);
  assert.match(page.body.innerText, /I recently applied/);
  const marks = LI.draftMarks(P.message);
  assert.match(await page.run(LI.send, { name: P.name, first: P.first, subject: P.subject, marks, dry: true }), /^SENDABLE/);
  assert.equal(page.btn.clicked, undefined, 'a dry run presses nothing');
});

test('the addressing check never counts the message box itself (the pasted "Hi Dana" named anyone)', async () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const LI = ctx.JarvisLinkedIn;
  const msg = 'Hi Dana,\n\nI recently applied for the Mechanical Engineer role on your team and wanted to reach out directly.';
  const wrong = composePage({ header: 'Sam Okafor', box: msg });
  wrong.subject.value = 'Applied';
  const out = await wrong.run(LI.send, { name: 'Dana Reyes', first: 'Dana', subject: 'Applied', marks: LI.draftMarks(msg) });
  assert.match(out, /not addressed to Dana Reyes/, out);
  assert.equal(wrong.btn.clicked, undefined, 'Send never pressed for someone else');
  assert.match(await composePage({ header: 'Sam Okafor', box: msg }).run(LI.fill, { name: 'Dana Reyes', first: 'Dana', subject: 'x', message: msg }), /not addressed/);
});

test('the addressing check wants the whole name, as whole words, outside conversation lists (review of F-951)', async () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const LI = ctx.JarvisLinkedIn;
  const msg = 'Hi Dana,\n\nI recently applied for the Mechanical Engineer role on your team and wanted to reach out directly.';
  const P = (name) => ({ name, first: name.split(' ')[0], subject: 's', message: msg });
  const sendP = (name) => ({ name, first: name.split(' ')[0], subject: 's', marks: LI.draftMarks(msg) });
  const both = async (opts, name) => {
    const fill = await composePage(opts).run(LI.fill, P(name));
    const page = composePage({ ...opts, box: msg });
    page.subject.value = 's';
    const send = await page.run(LI.send, sendP(name));
    return { fill, send, pressed: page.btn.clicked };
  };
  // Another person with the same first name: refused, Send never pressed.
  let r = await both({ header: 'Dana Lee' }, 'Dana Reyes');
  assert.match(r.fill, /not addressed/, r.fill);
  assert.match(r.send, /not addressed/, r.send);
  assert.equal(r.pressed, undefined);
  // A short first name inside a longer one ("Al" in "Alex") is not a match.
  r = await both({ header: 'Alex Chen' }, 'Al Chen');
  assert.match(r.fill, /not addressed/, r.fill);
  assert.match(r.send, /not addressed/, r.send);
  assert.match((await both({ header: 'Al Chen' }, 'Al Chen')).fill, /^FILLED/);
  // Their name in the conversation list beside a form addressed to someone else.
  r = await both({ header: 'Sam Okafor', sidebar: ['Dana Reyes', 'Priya Shah'] }, 'Dana Reyes');
  assert.match(r.fill, /not addressed/, r.fill);
  assert.match(r.send, /not addressed/, r.send);
  assert.equal(r.pressed, undefined);
  // The real recipient still passes when LinkedIn shows more of the name than
  // was saved: a middle initial, a nickname in brackets, an accent, a suffix.
  for (const [header, name] of [['Dana M. Reyes', 'Dana Reyes'], ['Wen (Wendy) Zhao', 'Wen Zhao'], ['José Serrano', 'Jose Serrano'], ['Dana Reyes, P.E.', 'Dana Reyes'], ['Riley Morgan', 'Riley T Morgan']]) {
    r = await both({ header, sidebar: ['Sam Okafor'] }, name);
    assert.match(r.fill, /^FILLED/, `${name} under "${header}": ${r.fill}`);
    assert.match(r.send, /^PRESSED/, `${name} under "${header}": ${r.send}`);
  }
});

test('his own accepted connection note is not "a conversation"; their reply is (F-951)', async () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(path.join(HERE, 'linkedin-page.js'), 'utf-8'), ctx);
  const LI = ctx.JarvisLinkedIn;
  const note = 'Hi Dana, I saw your post about the robotics team. I applied, so I would love to connect.';
  const P = { name: 'Dana Reyes', first: 'Dana', subject: 's', message: 'Thanks for connecting! I recently applied for the Mechanical Engineer role on your team.' };
  assert.match(await composePage({ header: 'Dana Reyes', thread: [note] }).run(LI.fill, { ...P, connectNote: note }), /^FILLED/);
  assert.match(await composePage({ header: 'Dana Reyes', thread: [note] }).run(LI.fill, P), /already have a conversation/, 'without the note it counts');
  assert.match(await composePage({ header: 'Dana Reyes', thread: [note, 'Thanks Alex!'] }).run(LI.fill, { ...P, connectNote: note }), /already have a conversation/);
});

test('Send all (no schedule) only dry-checks Send, never presses it', async () => {
  const { listeners, sandbox, runs, until } = outreachLoad({ people: PEOPLE });
  await new Promise((res) => listeners.external({ type: 'outreach-send' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'watching', 'watching');
  assert.equal(runs.filter((x) => x.fn === 'send').length, 2, 'every tab is checked');
  assert.equal(pressed(runs).length, 0);
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

test('a schedule the server does not call due presses nothing', async () => {
  const { listeners, sandbox, runs, results, until } = outreachLoad({ people: PEOPLE, due: false });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'watching', 'watching');
  assert.equal(pressed(runs).length, 0);
  assert.equal(results.length, 0);
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

test('a due schedule sends each tab that checks out, leaves the rest filled, and reports', async () => {
  let first = null;
  const { listeners, sandbox, runs, marks, results, notes, until } = outreachLoad({
    people: PEOPLE, due: true, sendable: (id) => { first ??= id; return id === first; },
  });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the report');
  assert.equal(pressed(runs).length, 1, 'only the one whose checks passed');
  assert.deepEqual(marks, [{ contactId: 'c1', what: 'sent' }]);
  assert.deepEqual(results[0].sent, ['Dana Lee']);
  assert.equal(results[0].left[0].name, 'Sam Roe');
  assert.match(results[0].left[0].note, /not sent automatically: the resume does not show as attached/);
  assert.equal(notes.length, 1);
  const s = sandbox.outreachSummary();
  assert.equal(s.phase, 'watching', 'Sam is still filled and waits for him');
  assert.deepEqual(s.entries.map((e) => e.status), ['sent', 'ready']);
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

const NOTED = [
  { id: 'c1', name: 'Dana Lee', first: 'Dana', profile: 'https://www.linkedin.com/in/dana', note: 'Hi Dana, I saw your post about the team. I applied, so I would love to connect.' },
  { id: 'c2', name: 'Sam Roe', first: 'Sam', profile: 'https://www.linkedin.com/in/sam', note: 'Hi Sam, I saw the roles you posted. I applied, so I would love to connect.' },
];

test('a due CONNECT schedule sends each invitation with its note, types no message, marks invited, reports', async () => {
  const { listeners, sandbox, runs, marks, results, until } = outreachLoad({ people: NOTED, due: true, kind: 'connect' });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the report');
  const connects = runs.filter((x) => x.fn === 'connect');
  assert.deepEqual(connects.map((x) => x.args[0].note), NOTED.map((p) => p.note), 'each with his own note');
  assert.equal(runs.filter((x) => ['fill', 'attach', 'send'].includes(x.fn)).length, 0, 'no message is filled or sent');
  assert.deepEqual(marks, [{ contactId: 'c1', what: 'invited' }, { contactId: 'c2', what: 'invited' }]);
  assert.deepEqual(results[0].sent, ['Dana Lee', 'Sam Roe']);
  assert.equal(sandbox.outreachSummary().kind, 'connect');
});

test('a CONNECT run tries a page that never loaded once more at the end (2026-10-27, 14 of 16 lost)', async () => {
  let n = 0;
  const { listeners, marks, results, until } = outreachLoad({ people: NOTED, due: true, kind: 'connect', connectAnswer: () => (n++ === 0 ? 'STOP: the profile never loaded' : 'CONNECTED: invitation with note sent, shows Pending') });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the report');
  assert.equal(n, 3, 'two people, one of them twice');
  assert.deepEqual(marks.map((m) => m.contactId).sort(), ['c1', 'c2']);
  assert.deepEqual([...results[0].sent].sort(), ['Dana Lee', 'Sam Roe']);
});

test('a CONNECT list the server did not call due presses nothing', async () => {
  const { listeners, sandbox, runs, marks, until } = outreachLoad({ people: NOTED, due: false, kind: 'connect' });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => sandbox.outreachSummary()?.phase === 'done', 'the end');
  assert.equal(runs.filter((x) => x.fn === 'connect').length, 0);
  assert.equal(marks.length, 0);
});

test('a CONNECT pass stops at a refused invitation box without marking it invited', async () => {
  const { listeners, marks, results, until } = outreachLoad({ people: NOTED, due: true, kind: 'connect', connectAnswer: (tab) => 'STOP: the invitation box did not offer "Add a note"; nothing sent' });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the report');
  assert.equal(marks.length, 0);
  assert.match(results[0].left[0].note, /Add a note/);
});

test('linkedin-page connect(): the note path and its stops are in the page code', () => {
  const src = readFileSync(new URL('./linkedin-page.js', import.meta.url), 'utf8');
  assert.match(src, /if \(P\.note\) return await withNote\(\)/);
  assert.match(src, /add a \(free \)\?note/);
  assert.match(src, /the note did not go in as written; nothing sent/);
  assert.match(src, /note\.length > 300/);
});

test('a due schedule takes over a session only watching old tabs, and closes its unsent tabs (F-938)', async () => {
  let first = null;
  const { listeners, sandbox, tabs, results, until } = outreachLoad({
    people: PEOPLE, due: true, sendable: (id) => { first ??= id; return id === first; },
  });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the first report');
  assert.equal(sandbox.outreachSummary().phase, 'watching');
  const samTab = [...tabs.entries()].find(([, t]) => t.url.endsWith('/sam') && t.open)?.[0];
  assert.ok(samTab != null, 'Sam is left filled in his tab');
  const r = await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's2' }, { origin: 'http://localhost:4300' }, res));
  assert.ok(!r.already, 'not turned away as already running');
  assert.equal(tabs.get(samTab).open, false, 'the leftover filled tab is closed, so it cannot be sent twice');
  await until(() => results.length === 2, 'the second report');
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

test('the SAME schedule opened again keeps the tabs left for him and only reports again (F-951)', async () => {
  let first = null;
  const { listeners, sandbox, tabs, results, runs, until } = outreachLoad({
    people: PEOPLE, due: true, sendable: (id) => { first ??= id; return id === first; },
  });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the first report');
  const samTab = [...tabs.entries()].find(([, t]) => t.url.endsWith('/sam') && t.open)?.[0];
  const pressedBefore = pressed(runs).length;
  const r = await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  assert.ok(r.already, 'its own finished session: nothing started again');
  assert.equal(tabs.get(samTab).open, true, 'the tab left for him stays open');
  assert.equal(sandbox.outreachSummary().phase, 'watching');
  await until(() => results.length === 2, 'the result sent again');
  assert.equal(pressed(runs).length, pressedBefore, 'nothing pressed a second time');
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

test('a due schedule never sends a message that is already in the thread', async () => {
  let first = null;
  const { listeners, sandbox, runs, results, until } = outreachLoad({
    people: PEOPLE, due: true, already: (id) => { first ??= id; return id === first; },
  });
  await new Promise((res) => listeners.external({ type: 'outreach-send', schedule: 's1' }, { origin: 'http://localhost:4300' }, res));
  await until(() => results.length === 1, 'the report');
  assert.equal(pressed(runs).length, 1, 'Sam only');
  assert.deepEqual(sandbox.outreachSummary().entries.map((e) => e.status), ['careful', 'sent']);
  await new Promise((res) => listeners.external({ type: 'outreach-stop' }, { origin: 'http://localhost:4300' }, res));
});

test('F-994: a run that shows nothing for two minutes gives way to the next press; a working one does not', async () => {
  const { sandbox, listeners } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  // The gate itself.
  const now = 10_000_000;
  assert.equal(sandbox.runGate(null, now), 'start');
  assert.equal(sandbox.runGate({ since: now - 30_000, lastStep: 0 }, now), 'wait', 'thirty seconds in: still its turn');
  assert.equal(sandbox.runGate({ since: now - 150_000, lastStep: 0 }, now), 'takeover', 'two and a half minutes and not one step from the page');
  assert.equal(sandbox.runGate({ since: now - 200_000, lastStep: now - 10_000 }, now), 'wait', 'a run whose page reported ten seconds ago is working');
  assert.equal(sandbox.runGate({ since: now - 7 * 60_000, lastStep: now - 1000 }, now), 'takeover', 'six minutes is the hard limit, as before');
  // On a tab: a stalled injection, then a press.
  let runs = 0;
  let releaseFirst = null;
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (!o.files?.includes('content.js')) return [];
    runs += 1;
    if (runs === 1) await new Promise((r) => { releaseFirst = r; });
    return [{ result: { filled: 1 } }];
  };
  await sandbox.arm(7);
  const first = sandbox.runOnTab(7);
  await new Promise((r) => setTimeout(r, 20));
  // The page reports: the run is alive, a press waits.
  await askFrom(listeners, 7, { type: 'page-live', text: 'filling: First name' });
  assert.ok(sandbox.runState(7).lastStep > 0, 'the page\'s report marks the run alive');
  assert.equal(await sandbox.runOnTab(7), null, 'a working run is not disturbed');
  // Three minutes of silence: the next press takes over.
  const st = sandbox.runState(7);
  st.since -= 3 * 60_000; st.lastStep -= 3 * 60_000;
  const second = sandbox.runOnTab(7);
  await second;
  assert.equal(runs, 2, 'the press after a stall injects again');
  // The stalled run ends late: it must not clear, or re-trigger, anything.
  releaseFirst();
  await first;
  assert.equal(sandbox.runState(7), null, 'the tab is free once the run that replaced it is done');
});

test('F-1010: a run whose page was replaced gives way at once, and a follow parked behind a silent run is woken (Micron, Eightfold)', async () => {
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  const now = 10_000_000;
  assert.equal(sandbox.runGate({ since: now - 5_000, lastStep: now - 1000, pageGoneAt: now - 1000 }, now), 'takeover', 'a new document after the run began: its script is gone');
  assert.equal(sandbox.runGate({ since: now - 5_000, lastStep: now - 1000, pageGoneAt: now - 9000 }, now), 'wait', 'a document from before the run is the run\'s own page');
  // On a tab: the first run's injection never comes back; a follow is parked.
  let runs = 0;
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (!o.files?.includes('content.js')) return [];
    runs += 1;
    if (runs === 1) await new Promise(() => {});   // the page went away under it
    return [{ result: { filled: 1 } }];
  };
  await sandbox.arm(7);
  sandbox.runOnTab(7);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sandbox.runOnTab(7, { auto: true }), null, 'parked behind the live run');
  assert.ok(sandbox.chrome.alarms.created.some((a) => a.name === 'jarvis-wake:7' && a.opts.when > Date.now() + 2 * 60_000), 'one alarm, past the stall time');
  // The page that replaced the run's commits: the next run takes over at once.
  await fire.committed({ tabId: 7, frameId: 0, url: 'https://careers.micron.com/careers/apply?pid=1' });
  assert.ok(sandbox.runState(7).pageGoneAt >= sandbox.runState(7).since);
  await sandbox.runOnTab(7, { auto: true });
  assert.equal(runs, 2, 'the run on the new page went in without waiting two minutes');
  // The alarm: a tab with no run left is followed again; a tab not armed never is.
  assert.equal(await sandbox.wakeParked(7), true);
  assert.equal(await sandbox.wakeParked(8), false, 'a tab that is not armed is never followed');
});

test('F-990: the worker answers whether a tab is still armed, so a run stops once he disarms it', async () => {
  const { sandbox, listeners } = load({ routes: { '/api/apply-token': okToken } });
  await sandbox.arm(7, { id: 'job-7' });
  const r1 = await askFrom(listeners, 7, { type: 'still-armed' });
  assert.equal(r1.armed, true);
  await sandbox.disarm(7);
  const r2 = await askFrom(listeners, 7, { type: 'still-armed' });
  assert.equal(r2.armed, false, 'disarmed: the run stops at its next step');
});

test('F-1002: a confirmation page in a tab Jarvis filled, armed or not, gets a look that fills nothing', async () => {
  const { sandbox } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  // Never filled here: no look.
  assert.equal(sandbox.lookForConfirmation(9, 'https://job-boards.greenhouse.io/rebuild/jobs/1/confirmation'), false);
  // Filled here an hour ago, disarmed since: a confirmation URL gets a look; any other page does not.
  sandbox.filledAt.set(9, Date.now() - 60 * 60_000);
  assert.equal(sandbox.lookForConfirmation(9, 'https://job-boards.greenhouse.io/rebuild/jobs/1'), false, 'not a confirmation page');
  assert.equal(sandbox.lookForConfirmation(9, 'https://job-boards.greenhouse.io/rebuild/jobs/1/confirmation'), true);
  // Too long ago: no look.
  sandbox.filledAt.set(9, Date.now() - 3 * 60 * 60_000);
  assert.equal(sandbox.lookForConfirmation(9, 'https://job-boards.greenhouse.io/rebuild/jobs/1/confirmation'), false);
  // An armed tab follows by itself: no second look.
  await sandbox.arm(10);
  sandbox.filledAt.set(10, Date.now());
  assert.equal(sandbox.lookForConfirmation(10, 'https://job-boards.greenhouse.io/x/jobs/2/confirmation'), false);
});

test('F-994 review: a slow run that only says it is alive is left alone, and each run hands the page its token', async () => {
  const { sandbox, listeners } = load({ routes: { '/api/apply-token': okToken, '/api/filled': okJson({ recorded: true }) } });
  let runs = 0; let release = null; const ctxs = [];
  sandbox.chrome.scripting.executeScript = async (o) => {
    if (o.func && o.args) ctxs.push(o.args[0]);
    if (!o.files?.includes('content.js')) return [];
    runs += 1;
    if (runs === 1) await new Promise((r) => { release = r; });
    return [{ result: { filled: 1 } }];
  };
  await sandbox.arm(7);
  const first = sandbox.runOnTab(7);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(String(ctxs.find((c) => c && 'runToken' in c)?.runToken || ''), /^7-\d+-/, 'the page gets the run\'s token');
  // Three minutes in, a resume build: nothing typed, but the run keeps saying it is alive.
  const st = sandbox.runState(7);
  st.since -= 3 * 60_000;
  await askFrom(listeners, 7, { type: 'run-alive' });
  assert.equal(await sandbox.runOnTab(7), null, 'a slow but living run is not taken over');
  assert.equal(runs, 1);
  release(); await first;
});

test('F-1013 #1: "APPLY NOW" REUSES A TAB ONLY WHEN IT SHOWS THAT POSTING, never one whose address merely starts the same', async () => {
  const { sandbox, listeners, created } = load({ routes: { '/api/apply-token': okToken } });
  const has = sandbox.tabShowsPosting;
  assert.equal(has('https://x.test/jobs/12345', 'https://x.test/jobs/1234'), false, 'another number');
  assert.equal(has('https://x.test/job/mechanical-engineer-ii', 'https://x.test/job/mechanical-engineer'), false, 'another slug');
  assert.equal(has('https://x.test/jobs/1234/apply', 'https://x.test/jobs/1234'), true, 'its own apply page');
  assert.equal(has('https://x.test/jobs/1234?gh_src=abc', 'https://x.test/jobs/1234'), true, 'with tracking parameters');
  assert.equal(has('https://x.test/jobs/1234/', 'https://x.test/jobs/1234'), true);
  assert.equal(has('https://boards.greenhouse.io/acme/jobs/111?gh_jid=111', 'https://boards.greenhouse.io/acme/jobs/111?gh_jid=222'), false, 'two requisitions of one kind');

  // The dashboard's open: a sibling tab is NOT armed; a new tab is opened instead.
  sandbox.chrome.tabs.query = async () => [{ id: 5, url: 'https://x.test/jobs/12345' }];
  sandbox.chrome.scripting.executeScript = async () => [{ result: { filled: 0 } }];
  const opened = await new Promise((resolve) => { listeners.external({ type: 'open', url: 'https://x.test/jobs/1234', id: 'job-1234' }, { origin: 'http://localhost:4300' }, resolve); });
  assert.equal(opened.ok, true);
  assert.notEqual(opened.reused, true, 'the other posting\'s tab is left alone');
  assert.equal(created.at(-1)?.url, 'https://x.test/jobs/1234');
  assert.equal(await sandbox.armedState(5), null, 'and never armed with this job');
});

test('F-1013 #5: AN ARMED TAB HE TAKES TO ANOTHER SITE HIMSELF STANDS DOWN; links and sign-in on the way do not', async () => {
  const { sandbox, fire } = load({ routes: { '/api/apply-token': okToken } });
  const POST = 'https://www.tesla.com/careers/search/job/apply/271234';
  await sandbox.arm(8, { id: 'job-8' });
  await fire.committed({ tabId: 8, frameId: 0, url: POST, transitionType: 'link' });
  await fire.committed({ tabId: 8, frameId: 0, url: 'https://accounts.google.com/signin/v2', transitionType: 'link' });
  await fire.committed({ tabId: 8, frameId: 0, url: POST, transitionType: 'link' });
  assert.ok(await sandbox.armedState(8), 'an application moving between hosts by links stays armed');
  await fire.committed({ tabId: 8, frameId: 0, url: POST, transitionType: 'reload' });
  await fire.committed({ tabId: 8, frameId: 0, url: POST, transitionType: 'typed' });
  assert.ok(await sandbox.armedState(8), 'a reload, or the same site typed again, too');
  await fire.committed({ tabId: 8, frameId: 0, url: 'https://news.example.com/', transitionType: 'typed' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sandbox.armedState(8), null, 'another site typed into the tab: no longer his application');

  await sandbox.arm(9, { id: 'job-9' });
  await fire.committed({ tabId: 9, frameId: 0, url: POST, transitionType: 'link' });
  await fire.committed({ tabId: 9, frameId: 0, url: 'https://mail.example.com/', transitionType: 'auto_bookmark' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sandbox.armedState(9), null, 'a bookmark, too');
});

// S2 (2026-11-07): a frame that keeps this load's scripts is not sent them again.
const probeReply = (frames) => frames.map(([frameId, url, resident]) => ({ frameId, result: { jarvisProbe: 1, resident, url } }));

test('S2: which frames get the files, which only a resume, which nothing', () => {
  const { sandbox } = load();
  const plan = sandbox.framePlan(probeReply([
    [0, 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x/apply', true],
    [4, 'https://boards.greenhouse.io/embed/job_app?for=acme', false],
    [6, 'https://www.google.com/recaptcha/api2/anchor?k=1', false],
    [7, 'https://widget.intercom.io/widget/abc', false],
    [8, 'https://consent.cookiebot.com/xyz', true],
  ]), 'L1');
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), { resume: [0, 8], files: [4, 7], skipped: [6] }, 'chat and cookie frames still get the scripts; a captcha never');
  assert.equal(sandbox.framePlan('capped', 'L1'), null, 'a capped probe: everything, as before');
  assert.equal(sandbox.framePlan([{ result: { filled: 1 } }], 'L1'), null, 'a reply that is not a probe');
  assert.equal(sandbox.framePlan([{ frameId: 0, result: { jarvisProbe: 1, resident: true, url: 'https://x.test/' } }], null), null, 'no load id: nothing to match a resident against');
  assert.equal(sandbox.framePlan(probeReply([[0, 'https://www.google.com/recaptcha/api2/anchor', false]]), 'L1').files[0], 0, 'the top frame is never skipped');
});

// The calls inject() makes, told apart by target: the probe goes to every frame,
// a resume and the files go to named frames.
const isProbe = (o) => !!o.func && !!o.target.allFrames;
const isResume = (o) => !!o.func && !!o.target.frameIds;
const isFiles = (o) => !!o.files?.includes('content.js');
const framesOf = (o) => [...(o.target.frameIds || [])];

test('S2: a press re-sends no files to a frame that holds them, and the new frame still gets all four', async () => {
  const { sandbox } = load({ routes: { '/api/apply-token': okToken } });
  const calls = [];
  sandbox.chrome.scripting.executeScript = async (o) => {
    calls.push(o);
    if (isProbe(o)) return probeReply([[0, 'https://jobs.ashbyhq.com/acme/1/application', true], [3, 'https://jobs.ashbyhq.com/embed', false], [5, 'https://www.youtube.com/embed/v', false]]);
    if (o.world === 'MAIN') return [];
    if (isResume(o)) return [{ frameId: 0, result: { filled: 2, via: 'resume' } }];
    return [{ frameId: 3, result: { filled: 1, via: 'files' } }];
  };
  const out = await sandbox.inject(7, { loadId: 'L1', runToken: 'tok-1' });
  const files = calls.filter(isFiles);
  assert.equal(files.length, 1);
  assert.deepEqual(framesOf(files[0]), [3], 'only the frame without them');
  const resumes = calls.filter(isResume);
  assert.equal(resumes.length, 1);
  assert.deepEqual(framesOf(resumes[0]), [0]);
  assert.equal(resumes[0].args[0].runToken, 'tok-1', 'the resume carries this run\'s own context');
  assert.ok(!calls.some((c) => framesOf(c).includes(5) && (isFiles(c) || isResume(c))), 'the video frame gets nothing');
  assert.deepEqual(out.map((r) => r.via).sort(), ['files', 'resume']);
});

test('S2: a probe without frame ids still injects everywhere', async () => {
  const { sandbox } = load({ routes: { '/api/apply-token': okToken } });
  const calls = [];
  sandbox.chrome.scripting.executeScript = async (o) => { calls.push(o); return [{ result: { filled: 1 } }]; };
  await sandbox.inject(7, { loadId: 'L1' });
  assert.equal(calls.find(isFiles).target.allFrames, true, 'not a full answer: every frame, as before');
});

test('S2 review: a resume group with a frame gone gets the files, frame by frame, instead of nothing', async () => {
  const { sandbox } = load({ routes: { '/api/apply-token': okToken } });
  const calls = [];
  sandbox.chrome.scripting.executeScript = async (o) => {
    calls.push(o);
    if (isProbe(o)) return probeReply([[0, 'https://a.test/apply', true], [4, 'https://a.test/embed', true], [2, 'https://a.test/frame', false]]);
    if (o.world === 'MAIN') return [];
    if (isResume(o)) throw new Error('Frame with ID 4 was removed.');   // Chrome rejects the whole call
    if (framesOf(o).includes(4)) throw new Error('Frame with ID 4 was removed.');
    return framesOf(o).map((frameId) => ({ frameId, result: { filled: 1, frameId } }));
  };
  const out = await sandbox.inject(7, { loadId: 'L1' });
  const sent = calls.filter(isFiles).map(framesOf);
  assert.ok(sent.some((f) => f.length === 1 && f[0] === 0), 'frame 0, still there, got the files on its own');
  assert.ok(sent.some((f) => f.length === 1 && f[0] === 4), 'the gone frame was tried alone');
  assert.deepEqual(out.map((r) => r.frameId).sort(), [0, 2], 'every frame still there answered');
});

test('S2 review: a frame that navigated (no resident copy now) answers no-resume and gets the files', async () => {
  const { sandbox } = load({ routes: { '/api/apply-token': okToken } });
  const calls = [];
  sandbox.chrome.scripting.executeScript = async (o) => {
    calls.push(o);
    if (isProbe(o)) return probeReply([[0, 'https://a.test/apply', true], [6, 'https://a.test/step', true]]);
    if (o.world === 'MAIN') return [];
    // What RESUME returns in each frame: frame 6 moved to a new document after the probe.
    if (isResume(o)) return [{ frameId: 0, result: { filled: 2, frameId: 0 } }, { frameId: 6, result: 'no-resume' }];
    return framesOf(o).map((frameId) => ({ frameId, result: { filled: 5, frameId } }));
  };
  const out = await sandbox.inject(7, { loadId: 'L1' });
  assert.deepEqual(calls.filter(isFiles).map(framesOf), [[6]]);
  assert.deepEqual(out.map((r) => r.frameId).sort(), [0, 6]);
  assert.ok(!out.some((r) => r.result === 'no-resume'), 'a no-resume is never reported as the frame\'s answer');
  // RESUME itself, as Chrome runs it in a frame: no resident → 'no-resume'; a resident → its answer, given this run's context.
  assert.equal(vm.runInContext('RESUME({ runToken: "t" })', sandbox), 'no-resume');
  let gotCtx = null;
  sandbox.__jarvisResumeRun = (c) => { gotCtx = c; return { filled: 1 }; };
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('RESUME({ runToken: "t2" })', sandbox))), { filled: 1 });
  assert.equal(gotCtx.runToken, 't2');
  delete sandbox.__jarvisResumeRun;
});

test('S2 review: an iframe added between the probe and the inject still gets the files', async () => {
  const { sandbox } = load({ routes: { '/api/apply-token': okToken } });
  const calls = [];
  sandbox.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, url: 'https://a.test/apply' }, { frameId: 3, url: 'https://a.test/x' },
    { frameId: 9, url: 'https://boards.greenhouse.io/embed/job_app?for=a' },   // new
    { frameId: 11, url: 'https://www.google.com/recaptcha/api2/anchor' },      // new, but a captcha
    { frameId: 12, url: 'about:blank' },                                       // new, nothing to fill
  ];
  sandbox.chrome.scripting.executeScript = async (o) => {
    calls.push(o);
    if (isProbe(o)) return probeReply([[0, 'https://a.test/apply', true], [3, 'https://a.test/x', false]]);
    if (o.world === 'MAIN') return [];
    return framesOf(o).map((frameId) => ({ frameId, result: { filled: 1, frameId } }));
  };
  const out = await sandbox.inject(7, { loadId: 'L1' });
  assert.deepEqual(calls.filter(isFiles).map(framesOf).sort(), [[3], [9]]);
  assert.deepEqual(out.map((r) => r.frameId).sort((a, b) => a - b), [0, 3, 9]);
});

test('F-1031: the panel\'s PDF link carries a ticket for that one file, asked once and reused until it nears its end', async () => {
  let tickets = 0;
  const { listeners, calls } = load({ routes: {
    '/api/apply-token': okToken,
    '/api/file-ticket': () => { tickets += 1; return { ok: true, status: 200, json: async () => ({ ticket: `T${tickets}`, ttlMs: 30 * 60_000 }) }; },
  } });
  const a = await ask(listeners, { type: 'file-url', id: 'job-1', inline: true });
  assert.equal(a.ok, true);
  const u = new URL(a.url);
  assert.equal(u.pathname, '/api/apply-resume');
  assert.deepEqual([u.searchParams.get('id'), u.searchParams.get('inline'), u.searchParams.get('ticket')], ['job-1', '1', 'T1']);
  const post = calls.find((c) => c.url.endsWith('/api/file-ticket'));
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['x-jarvis-token'], TOKEN, 'asked with the extension\'s token');
  assert.deepEqual(JSON.parse(post.body), { id: 'job-1', what: 'resume' }, 'for this job\'s resume only');
  const again = await ask(listeners, { type: 'file-url', id: 'job-1', inline: true });
  assert.equal(new URL(again.url).searchParams.get('ticket'), 'T1', 'the same file reuses its ticket');
  const b = await ask(listeners, { type: 'file-url', id: 'job-1', what: 'letter', inline: true });
  assert.equal(new URL(b.url).pathname, '/api/cover-letter-pdf');
  assert.equal(new URL(b.url).searchParams.get('ticket'), 'T2', 'the letter has its own');
  assert.equal(tickets, 2);
});

test('F-1031: a dashboard that gives no ticket still gets the plain link', async () => {
  const { listeners } = load({ routes: { '/api/apply-token': okToken } });
  const a = await ask(listeners, { type: 'file-url', id: 'job-2', inline: true });
  assert.equal(a.ok, true);
  assert.equal(new URL(a.url).searchParams.get('ticket'), null);
});

test('S6: a run\'s timings reach the dashboard as phase names and ms only, with the worker\'s own setup', async () => {
  let filled = null;
  const { sandbox, listeners } = load({ routes: {
    '/api/apply-token': okToken,
    '/api/filled': (opts) => { filled = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ recorded: true }) }; },
  } });
  await sandbox.arm(3, { id: 'job-3', company: 'Jabil' });
  await askFrom(listeners, 3, { type: 'filled', result: { filled: 5, pageUrl: 'https://jabil.wd1.myworkdayjobs.com/x/apply',
    timings: { total: 7912, discover: 640.4, plan: 1210, dropdowns: 3204, waits: 2100, slowest: 'dropdowns', company: 'Jabil', answer: 'Yes', pageUrl: 'https://x' } } });
  assert.ok(filled?.timings, 'the timings travel with the report');
  assert.equal(filled.timings.discover, 640, 'whole ms');
  assert.equal(filled.timings.slowest, 'dropdowns');
  assert.ok(!('company' in filled.timings) && !('answer' in filled.timings) && !('pageUrl' in filled.timings), JSON.stringify(filled.timings));
  // The whitelist itself.
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.runTimingsFor({ total: 1000, plan: 900, slowest: 'plan', label: 'Sponsorship?' }, 250))), { total: 1000, inject: 250, plan: 900, slowest: 'plan' });
  assert.equal(sandbox.runTimingsFor(null, 5), null);
  assert.equal(sandbox.runTimingsFor({ slowest: 'nope' }, undefined), null);
  // S5: the waits by line travel too, numbers only; the version as digits and dots.
  const w = JSON.parse(JSON.stringify(sandbox.runTimingsFor({ total: 1000, waits: 800, waitSites: [[2941, 700, 300, 2, 0], [12, 'Acme', 1, 1, 0], [3, 1]], v: '1.150.14' }, 0)));
  assert.deepEqual(w.waitSites, [[2941, 700, 300, 2, 0]]);
  assert.equal(w.v, '1.150.14');
  assert.equal(sandbox.runTimingsFor({ total: 5, v: 'https://x' }, 0).v, undefined);
});

// THE FILL STOPS ON A POSTING THE VISA GATE BARS (his "1. ye", 2026-11-12).
// Every way into a fill — the toolbar, the dashboard, the next page of an
// armed tab — goes through runOnTab, and only the panel's Fill anyway lets
// that one posting through.
function barredWorld({ stopFor = { 'job-us': ['Requires U.S. citizenship — "Must be a U.S. citizen."'] }, panel = null } = {}) {
  const urls = new Map();
  const jobAt = new Map();   // url -> job id
  const fills = [];
  const world = load({
    routes: {
      '/api/apply-token': okToken,
      '/api/filled': okJson({ recorded: true }),
      '/api/fill-anyway': okJson({ recorded: true }),
      '/api/panel': panel || ((opts, calls) => {
        const u = new URL(calls.at(-1).url);
        const id = jobAt.get(u.searchParams.get('pageUrl'));
        if (!id) return { ok: false, status: 404, json: async () => ({ error: 'this page is not a posting in your store' }) };
        return { ok: true, status: 200, json: async () => ({ job: { id, title: 'Engineer', company: 'Co' }, fit: {}, application: null, stop: { reasons: stopFor[id] || [], read: true } }) };
      }),
    },
  });
  world.sandbox.chrome.tabs.get = async (id) => ({ id, url: urls.get(id) || '', title: '', status: 'complete', windowId: 1 });
  world.sandbox.chrome.scripting.executeScript = async (o) => {
    if (o.files?.includes('content.js')) fills.push(o.target.tabId);
    return [{ result: o.files ? { filled: 1 } : '' }];
  };
  return { ...world, urls, jobAt, fills };
}

test('FILL STOP: the toolbar press on a citizens-only posting writes nothing, and says why on the icon', async () => {
  const { sandbox, listeners, urls, jobAt, fills, badges, titles } = barredWorld();
  urls.set(40, 'https://jobs.example.com/us-only'); jobAt.set('https://jobs.example.com/us-only', 'job-us');
  await sandbox.press({ id: 40, url: urls.get(40) });
  assert.equal(fills.length, 0, 'content.js was never put into the page');
  assert.equal(badges.at(-1), '!');
  assert.match(titles.at(-1), /Not filled: this posting is blocked — Requires U\.S\. citizenship/);
  const state = await new Promise((resolve) => { listeners.message({ type: 'panel-state', tabId: 40 }, {}, resolve); });
  assert.equal(state.stopped?.id, 'job-us', 'the panel is told this tab stopped, and on which posting');
  assert.match(state.stopped.reasons[0], /Must be a U\.S\. citizen/);
});

test('FILL STOP: the panel\'s Fill anyway fills it, and keeps filling its next pages; a different posting in the tab stops again', async () => {
  const { sandbox, listeners, fire, urls, jobAt, fills, calls } = barredWorld({ stopFor: { 'job-us': ['Requires U.S. citizenship'], 'job-us2': ['Will not sponsor'] } });
  const A = 'https://jobs.example.com/us-only';
  urls.set(41, A); jobAt.set(A, 'job-us');
  await sandbox.press({ id: 41, url: A });
  assert.equal(fills.length, 0);
  const pressed = await new Promise((resolve) => { listeners.message({ type: 'press', tabId: 41, blockedAnyway: { id: 'job-us', reasons: ['Requires U.S. citizenship'] } }, {}, resolve); });
  assert.equal(pressed.ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fills.length, 1, 'his Fill anyway fills the page');
  assert.ok(calls.some((c) => c.url.includes('/api/fill-anyway')), 'and the choice is recorded');
  const st = await sandbox.armedState(41);
  assert.equal(st.anyway, 'job-us');
  // The application's next page is the same posting: it fills without asking again.
  const A2 = 'https://jobs.example.com/us-only/apply';
  urls.set(41, A2); jobAt.set(A2, 'job-us');
  await fire.updated(41, { status: 'complete' }, A2);
  await settleFollow();
  assert.equal(fills.length, 2, 'the next page of the same posting fills');
  // A different barred posting pasted into the tab is a new question.
  const B = 'https://jobs.example.com/no-sponsor';
  urls.set(41, B); jobAt.set(B, 'job-us2');
  await fire.updated(41, { status: 'complete' }, B);
  await settleFollow();
  assert.equal(fills.length, 2, 'another barred posting is not filled on the first one\'s Fill anyway');
});

test('FILL STOP: the dashboard cannot say "fill anyway" — its press and open go through the stop', async () => {
  const { sandbox, listeners, fire, urls, jobAt, fills } = barredWorld();
  const url = 'https://jobs.example.com/us-only';
  jobAt.set(url, 'job-us');
  const ext = (msg) => new Promise((resolve) => { listeners.external(msg, { origin: 'http://localhost:4300' }, resolve); });
  const opened = await ext({ type: 'open', url, id: 'job-us', company: 'Co', title: 'Engineer', blockedAnyway: { id: 'job-us' }, anyway: 'job-us' });
  assert.equal(opened.ok, true);
  urls.set(21, url);
  await fire.updated(21, { status: 'complete' }, url);
  await settleFollow();
  assert.equal(fills.length, 0, 'the posting the dashboard opened is not filled');
  assert.ok(!(await sandbox.armedState(21))?.anyway, 'and nothing the dashboard sent let it through');
  urls.set(42, url);
  await ext({ type: 'arm', tabId: 42, id: 'job-us' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fills.length, 0, 'nor the tab it armed');
});

test('FILL STOP: silence is not a bar — an ordinary posting, a page the store does not know, and a dashboard that is down all fill', async () => {
  const ok = barredWorld();
  ok.urls.set(43, 'https://jobs.example.com/fine'); ok.jobAt.set('https://jobs.example.com/fine', 'job-fine');
  await ok.sandbox.press({ id: 43, url: ok.urls.get(43) });
  assert.equal(ok.fills.length, 1, 'no reasons: filled');
  ok.urls.set(44, 'https://jobs.example.com/unknown');
  await ok.sandbox.press({ id: 44, url: ok.urls.get(44) });
  assert.equal(ok.fills.length, 2, 'a page the store does not know (404): filled');
  const down = barredWorld({ panel: () => { throw new Error('connection refused'); } });
  down.urls.set(45, 'https://jobs.example.com/us-only');
  await down.sandbox.press({ id: 45, url: down.urls.get(45) });
  assert.equal(down.fills.length, 1, 'a dashboard that does not answer: filled as before');
});

test('FILL STOP: the check-only pass is not a fill and is never stopped', async () => {
  const { sandbox, urls, jobAt, fills, calls } = barredWorld();
  urls.set(46, 'https://jobs.example.com/us-only'); jobAt.set('https://jobs.example.com/us-only', 'job-us');
  await sandbox.runOnTab(46, { checkOnly: true });
  assert.equal(fills.length, 1);
  assert.ok(!calls.some((c) => c.url.includes('/api/panel')), 'it does not even ask');
});

test('FILL STOP: in a browser with no side panel (Opera GX) the icon still docks the panel on a barred posting — only the fill is held', async () => {
  const { sandbox, listeners, urls, jobAt, fills, injected } = barredWorld();
  const url = 'https://jobs.example.com/us-only';
  urls.set(47, url); jobAt.set(url, 'job-us');
  const docked = [];
  const run = sandbox.chrome.scripting.executeScript;
  sandbox.chrome.scripting.executeScript = async (o) => { if (String(o.args?.[0] || '').includes('panel.html')) docked.push(o.target.tabId); return run(o); };
  await listeners.clicked({ id: 47, url, windowId: 3 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(docked, [47], `the panel, with its Fill anyway, is docked into the page: ${JSON.stringify(injected)}`);
  assert.equal(fills.length, 0, 'and the form is not filled');
});

test('FILL STOP: Apply opening the form in a new tab carries his Fill anyway for that posting, and only that posting', async () => {
  const { sandbox, listeners, fire, urls, jobAt, fills } = barredWorld({ stopFor: { 'job-us': ['Requires U.S. citizenship'], 'job-us2': ['Will not sponsor'] } });
  const A = 'https://jobs.example.com/us-only';
  urls.set(48, A); jobAt.set(A, 'job-us');
  await new Promise((resolve) => { listeners.message({ type: 'press', tabId: 48, blockedAnyway: { id: 'job-us', reasons: ['Requires U.S. citizenship'] } }, {}, resolve); });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fills.length, 1);
  (await sandbox.armedState(48)).followingAt = Date.now();
  // Apply opens the form in tab 49.
  const FORM = 'https://forms.example.com/apply/us-only';
  urls.set(49, FORM); jobAt.set(FORM, 'job-us');
  await fire.target({ tabId: 49, sourceTabId: 48 });
  assert.equal((await sandbox.armedState(49))?.anyway, 'job-us', 'the child tab holds his choice');
  await fire.updated(49, { status: 'complete' }, FORM);
  await settleFollow();
  assert.equal(fills.length, 2, 'the form in the new tab fills');
  // A different barred posting in that tab is still a new question.
  const B = 'https://jobs.example.com/no-sponsor';
  urls.set(49, B); jobAt.set(B, 'job-us2');
  await fire.updated(49, { status: 'complete' }, B);
  await settleFollow();
  assert.equal(fills.length, 2);
});

for (const [kind, A, B] of [
  ['Workday requisitions', 'https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/TX/Mechanical-Engineer_R100001', 'https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/TX/Mechanical-Engineer_R100002'],
  ['URLs with no requisition id', 'https://jobs.example.com/a', 'https://jobs.example.com/b'],
]) {
  test(`FILL STOP: Fill anyway on A, then B, then back to A in the same tab — A asks again (${kind})`, async () => {
    const { listeners, fire, urls, jobAt, fills, sandbox } = barredWorld({ stopFor: { 'job-a': ['Requires U.S. citizenship'], 'job-b': ['Will not sponsor'] } });
    urls.set(50, A); jobAt.set(A, 'job-a'); jobAt.set(B, 'job-b');
    await new Promise((resolve) => { listeners.message({ type: 'press', tabId: 50, blockedAnyway: { id: 'job-a', reasons: ['Requires U.S. citizenship'] } }, {}, resolve); });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fills.length, 1, 'his Fill anyway fills A');
    urls.set(50, B);
    await fire.updated(50, { status: 'complete' }, B);
    await settleFollow();
    assert.equal(fills.length, 1, 'B is stopped');
    assert.ok(!(await sandbox.armedState(50)).anyway, 'and A\'s Fill anyway is gone');
    urls.set(50, A);
    await fire.updated(50, { status: 'complete' }, A);
    await settleFollow();
    assert.equal(fills.length, 1, 'back on A, it asks again');
  });
}

test('FILL STOP: a page the store does not know in the middle of the application keeps his Fill anyway', async () => {
  const { listeners, fire, urls, jobAt, fills } = barredWorld({ stopFor: { 'job-a': ['Requires U.S. citizenship'] } });
  const A = 'https://jobs.example.com/a';
  const SIGNIN = 'https://jobs.example.com/login';
  urls.set(51, A); jobAt.set(A, 'job-a');
  await new Promise((resolve) => { listeners.message({ type: 'press', tabId: 51, blockedAnyway: { id: 'job-a', reasons: ['x'] } }, {}, resolve); });
  await new Promise((r) => setTimeout(r, 50));
  urls.set(51, SIGNIN);
  await fire.updated(51, { status: 'complete' }, SIGNIN);
  await settleFollow();
  assert.equal(fills.length, 2, 'the unknown page fills as before');
  urls.set(51, A);
  await fire.updated(51, { status: 'complete' }, A);
  await settleFollow();
  assert.equal(fills.length, 3, 'and A still fills on his choice');
});

test('FILL STOP: a different requisition committed in the tab forgets his Fill anyway at once, before any fill', async () => {
  const { listeners, fire, urls, jobAt, sandbox } = barredWorld({ stopFor: { 'job-a': ['Requires U.S. citizenship'] } });
  const A = 'https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/TX/Mechanical-Engineer_R100001';
  const B = 'https://acme.wd1.myworkdayjobs.com/en-US/Acme/job/TX/Mechanical-Engineer_R100002';
  urls.set(52, A); jobAt.set(A, 'job-a');
  await new Promise((resolve) => { listeners.message({ type: 'press', tabId: 52, blockedAnyway: { id: 'job-a', reasons: ['x'] } }, {}, resolve); });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await sandbox.armedState(52)).anyway, 'job-a');
  await fire.committed({ tabId: 52, frameId: 0, url: B });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await sandbox.armedState(52)).anyway, null, 'the reset that drops the old posting drops his choice with it');
});
