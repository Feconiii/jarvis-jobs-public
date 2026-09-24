/**
 * The service worker, which until now had no tests at all.
 *
 * It is the only piece that talks to the dashboard, and it carries the resume
 * bytes. A bug in here reads exactly like every bug this project has already
 * had: "no resume attached". It has no DOM, so it is exercised the way it
 * actually runs — as a script, with `chrome` and `fetch` stubbed.
 */
import test from 'node:test';
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
function load({ routes = {}, reachable = ['http://localhost:4300'], manifestVersion = '1.1.0', sidePanel = null, injectFails = false } = {}) {
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
      return route(opts, calls);
    },
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
});
