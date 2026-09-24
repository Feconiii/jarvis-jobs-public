/**
 * THE SHIPPED EXTENSION, LOADED INTO A REAL CHROME.
 *
 * Everything else in this suite tests a piece with the others stubbed. This
 * loads `jarvis/extension` with `--load-extension` and asserts on the real
 * manifest, the real service worker, and the real boundary.
 *
 * WHERE THE BOUNDARY IS NOW. The extension used to ask for `activeTab` and
 * nothing else, so it could touch nothing until he pressed the button — and
 * nothing after the page navigated, which is why every sign-in, every Apply
 * link and every iCIMS page turn cost him another press. It now holds host
 * permission for every site, and the boundary moved from the manifest to a
 * list: the worker injects ONLY into a tab he has pressed the button on, and
 * stops when he says so, the tab closes, or the application is sent. The
 * tests below hold that line with real tabs, a real worker and a real socket
 * — an unarmed tab loading a form, side by side with an armed one.
 *
 * A test that passed here by accident would be worse than no test: an earlier
 * draft "proved" the filler never presses Submit on a page it had never been
 * able to reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXT = HERE;

// The extension host-permissions ONLY localhost:4300, so anything talking to it
// must use that port — Chrome refuses another, correctly. A dashboard already
// running there is reused rather than disturbed.
const PORT = 4300;

let server;
let ctx;
let worker;
let profileDir;

async function serverUp(capMs = 25000) {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    try {
      // LIVENESS, NOT AUTHORISATION. This used to send a made-up extension
      // origin and wait for a 200 — which worked only while the token gate
      // accepted any `chrome-extension://` caller. Now that it is pinned to the
      // installed extension (F-271), a made-up id is correctly REFUSED, and a
      // probe that reads 403 as "not up yet" hangs for 25s and then fails every
      // test in the file with "the dashboard must come up".
      //
      // Any HTTP answer proves the server is listening, which is all this asks.
      // Whether the gate lets a caller through is a different question, tested
      // by "a WEB PAGE still cannot take the token" below.
      const r = await fetch(`http://127.0.0.1:${PORT}/api/apply-token`, { headers: { Origin: 'chrome-extension://probe' } });
      if (r.status > 0) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

test.before(async () => {
  if (!(await serverUp(1500))) {
    server = spawn(process.execPath, [path.join(ROOT, 'jarvis', 'serve.mjs'), '--port', String(PORT)],
      { cwd: ROOT, env: { ...process.env, JARVIS_AUTO: '0' }, stdio: 'ignore' });
    assert.ok(await serverUp(), 'the dashboard must come up for this test to mean anything');
  }
  profileDir = mkdtempSync(path.join(tmpdir(), 'jarvis-ext-'));
  ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,   // an MV3 service worker does not register headless
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 30000 });
});

test.after(async () => {
  await ctx?.close().catch(() => {});
  server?.kill();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

test('THE SHIPPED EXTENSION LOADS AND ITS WORKER RUNS', async () => {
  // Manifest errors, a bad service_worker path or a syntax error in
  // background.js all show up here and nowhere else in the suite.
  assert.match(worker.url(), /^chrome-extension:\/\/[a-z]+\/background\.js$/);
  const m = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(m.manifest_version, 3);
  assert.equal(m.name, 'Jarvis Apply');
  assert.ok(m.host_permissions.some((h) => h.includes('4300')), 'it must be allowed to reach the dashboard');
});

test('the manifest version and the file on disk agree', async () => {
  const onDisk = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf-8')).version;
  const loaded = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(loaded, onDisk);
});

// A fixture served under the dashboard's origin, so the worker's injection
// meets a real URL, a real navigation and a real page load — not a data: URL,
// which Chrome treats differently for extensions. The route is fulfilled by
// Playwright before it reaches the server.
const FORM = `<h2>My Information</h2>
  <label for="first_name">First Name</label><input id="first_name">
  <label for="last_name">Last Name</label><input id="last_name">
  <label for="email">Email</label><input id="email">
  <label for="phone">Phone</label><input id="phone">`;

async function fixturePage(pathname, html = FORM) {
  const page = await ctx.newPage();
  await page.route(`**${pathname}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`http://localhost:${PORT}${pathname}`);
  await page.waitForTimeout(300);
  return page;
}

const tabIdOf = (page) => worker.evaluate(async (url) => (await chrome.tabs.query({ url })).at(-1)?.id, page.url());

/** Wait for a value to appear in the page, up to `capMs`. */
async function valueOf(page, id, capMs = 8000) {
  const until = Date.now() + capMs;
  let v = '';
  while (Date.now() < until) {
    v = await page.evaluate((i) => document.getElementById(i)?.value || '', id);
    if (v) return v;
    await page.waitForTimeout(250);
  }
  return v;
}

test('IT TOUCHES ONLY A TAB HE PRESSED THE BUTTON ON — the boundary', async () => {
  // Two identical forms. One tab is armed and filled through the SHIPPED
  // worker, content scripts and server; the other is never armed and, whatever
  // the manifest permits, is never read.
  const armed = await fixturePage('/__jarvis_fixture_a');
  const bystander = await fixturePage('/__jarvis_fixture_b');
  const aId = await tabIdOf(armed);
  const bId = await tabIdOf(bystander);
  assert.ok(aId && bId && aId !== bId, 'two real tabs');

  await worker.evaluate((id) => self.arm(id, { started: true }), aId);
  await worker.evaluate((id) => self.runOnTab(id), aId);
  const first = await valueOf(armed, 'first_name');
  assert.ok(first, 'the armed tab is filled — through the real worker, the real scripts and the real server');
  assert.ok(await valueOf(armed, 'email', 2000), 'and not just one field');

  await bystander.waitForTimeout(1500);
  assert.equal(await bystander.evaluate(() => document.getElementById('first_name').value), '',
    'the tab he never pressed on is untouched, permission or no permission');
  await armed.close();
  await bystander.close();
});

test('IT FOLLOWS AN ARMED TAB THROUGH A REAL NAVIGATION, with no second press', async () => {
  // The whole point of arming: the next page fills by itself.
  const page = await fixturePage('/__jarvis_fixture_1');
  const id = await tabIdOf(page);
  await worker.evaluate((t) => self.arm(t, { started: true }), id);
  await worker.evaluate((t) => self.runOnTab(t), id);
  assert.ok(await valueOf(page, 'first_name'), 'the press fills the first page');

  await page.route('**/__jarvis_fixture_2', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FORM }));
  await page.goto(`http://localhost:${PORT}/__jarvis_fixture_2`);
  assert.ok(await valueOf(page, 'first_name', 10000), 'the page it navigated to fills without a press');
  assert.ok(await worker.evaluate((t) => self.armedState(t), id), 'and the tab is still followed');
  await page.close();
});

test('it stops following when told, and a navigation after that fills nothing', async () => {
  const page = await fixturePage('/__jarvis_fixture_3');
  const id = await tabIdOf(page);
  await worker.evaluate((t) => self.arm(t, { started: true }), id);
  await worker.evaluate((t) => self.disarm(t, 'test'), id);
  await page.route('**/__jarvis_fixture_4', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FORM }));
  await page.goto(`http://localhost:${PORT}/__jarvis_fixture_4`);
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => document.getElementById('first_name').value), '');
  await page.close();
});

test('AN IDENTITY PROVIDER IS NEVER INJECTED, in a real Chrome', async () => {
  // Signing in is his. The armed tab lands on Google's sign-in; nothing is
  // read, nothing is typed, and the tab stays armed for the page he comes
  // back to.
  const page = await fixturePage('/__jarvis_fixture_5');
  const id = await tabIdOf(page);
  await worker.evaluate((t) => self.arm(t, { started: true }), id);
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({
    status: 200, contentType: 'text/html',
    body: '<h1>Sign in</h1><label for="identifierId">Email or phone</label><input id="identifierId"><input id="first_name"><input id="email"><input id="phone">',
  }));
  await page.goto('https://accounts.google.com/v3/signin/identifier');
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => document.getElementById('identifierId').value), '');
  assert.equal(await page.evaluate(() => document.getElementById('email').value), '');
  assert.ok(await worker.evaluate((t) => self.armedState(t), id), 'still armed');
  await page.close();
});

test('the manifest asks for what following needs, and no content script runs on its own', async () => {
  const m = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.ok(m.host_permissions.includes('<all_urls>'), 'following a tab across sites needs every site');
  assert.ok(m.host_permissions.some((h) => h.includes('localhost:4300')), 'and the dashboard stays listed explicitly');
  for (const p of ['scripting', 'storage', 'tabs', 'webNavigation', 'alarms']) {
    assert.ok(m.permissions.includes(p), `${p} is required`);
  }
  assert.deepEqual(m.content_scripts, undefined,
    'nothing runs on page load by declaration — the worker injects, and only into armed tabs');
  assert.ok(m.commands?.fill?.suggested_key?.default, 'the keyboard shortcut is declared');
});

test('THE TOKEN HANDSHAKE SUCCEEDS — the bug that broke everything', async () => {
  // THE most important assertion in this suite.
  //
  // `/api/apply-token` used to require `Origin: chrome-extension://…`. Measured
  // against a genuinely loaded extension, Chrome sends NO Origin at all for a
  // host the extension holds permission for — the request is privileged, not
  // cross-origin. So the gate refused the real extension, `connect()` threw,
  // and every single click reported "the Jarvis dashboard is not running" while
  // the dashboard was running perfectly.
  //
  // Nothing else in the suite could see it: the sandbox in background.test.mjs
  // supplies its own fetch, and every other test stubs the channel. It needed a
  // real Chrome, a real extension and a real socket.
  const got = await worker.evaluate(async () => {
    try {
      const r = await fetch('http://localhost:4300/api/apply-token');
      return { status: r.status, body: await r.json() };
    } catch (e) { return { err: String(e.message || e) }; }
  });
  assert.equal(got.status, 200, `the worker was refused: ${JSON.stringify(got).slice(0, 120)}`);
  assert.ok(got.body?.token, 'and it must come back with a token — without one, nothing else runs');
});

test('the worker gets through to a real endpoint, not just the handshake', async () => {
  // Host permissions, the private-network header and the token gate on the
  // other routes all have to line up too.
  const got = await worker.evaluate(async () => {
    const t = await (await fetch('http://localhost:4300/api/apply-token')).json();
    const r = await fetch('http://localhost:4300/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-token': t.token },
      body: JSON.stringify({
        pageUrl: 'https://boards.greenhouse.io/x/jobs/1',
        extensionVersion: chrome.runtime.getManifest().version,
        fields: [{ label: 'First Name', type: 'text', options: [] }],
      }),
    });
    return { status: r.status, plan: await r.json() };
  });
  assert.equal(got.status, 200);
  assert.equal(got.plan.actions[0].action, 'fill', 'and the plan must actually decide the field');
  assert.equal(got.plan.staleExtension, null, 'a freshly loaded extension is not stale');
  assert.equal(got.plan.submit, false, 'no plan may ever say submit');
});

test('a WEB PAGE still cannot take the token', async () => {
  // The gate was loosened to accept a MISSING Origin, which is what a permitted
  // extension sends. That must not open it to a page — whose fetch always sends
  // one, so the gate can still tell them apart.
  //
  // A data: URL rather than a real site: this must not depend on the network,
  // and an earlier version that fetched example.com hung the whole file for five
  // minutes. A data: page's origin is the string "null", which is present and is
  // not chrome-extension:// — exactly the case the gate must refuse.
  const page = await ctx.newPage();
  await page.goto('data:text/html,<p>pretending to be an employer site</p>');
  const got = await page.evaluate(async () => {
    try {
      const r = await fetch('http://localhost:4300/api/apply-token');
      return { status: r.status, body: (await r.text()).slice(0, 60) };
    } catch (e) { return { blocked: String(e.message || e) }; }
  });
  assert.ok(got.blocked || got.status === 403,
    `a web page must not read the token, got ${JSON.stringify(got).slice(0, 140)}`);
  await page.close();
});

test('the dashboard records that an extension called it', async () => {
  const seen = await (await fetch(`http://127.0.0.1:${PORT}/api/extension`)).json();
  assert.ok(seen.seenAt, 'the heartbeat must fire — it is how he knows a reload took');
});

test('NETWATCH SEES A FAILED REQUEST THE FORM MADE', async () => {
  // A live Workday step refused to advance and offered only
  // "Page Error VPS|dc492c63…". The real reason was a background request that
  // failed, which nothing in this extension could see. netwatch.js runs in the
  // PAGE world — a content script has its own fetch, so patching ours would
  // watch nothing.
  // SAME-ORIGIN fixture. A data: page is cross-origin to the server, so CORS
  // rejects every request before it has a status and the watcher can only ever
  // say "network error" — true, but it tests nothing about status handling.
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(readFileSync(path.join(HERE, 'netwatch.js'), 'utf-8'));

  await page.evaluate(async () => {
    await fetch('/api/definitely-not-a-route').catch(() => {});
    await new Promise((r) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/also-not-a-route');
      x.addEventListener('loadend', r);
      x.send('{}');
    });
    // A request that SUCCEEDS must not be reported — this is a diagnostic for
    // failures, not a log of everything the page does.
    await fetch('/api/extension').catch(() => {});
  });
  await page.waitForTimeout(400);

  const lines = JSON.parse(await page.evaluate(() => document.documentElement.dataset.jarvisNet || '[]'));
  assert.ok(lines.some((l) => /GET .*definitely-not-a-route -> 404/.test(l)), `fetch failure missing: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => /POST .*also-not-a-route -> 404/.test(l)), `XHR failure missing: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /api\/extension/.test(l)), 'a request that worked is not a diagnostic');
  await page.close();
});

test('content.js reads what netwatch left, across the world boundary', async () => {
  // netwatch runs in the PAGE world and discover/content in the ISOLATED one.
  // A DOM attribute is the one thing both can see, and if that hand-off breaks
  // the diagnostic silently reports nothing.
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(readFileSync(path.join(HERE, 'netwatch.js'), 'utf-8'));
  await page.evaluate(() => fetch('/api/nope-not-here').catch(() => {}));
  await page.waitForTimeout(300);

  // The exact expression content.js uses.
  const read = await page.evaluate(() => {
    try {
      const raw = document.documentElement.dataset.jarvisNet;
      return raw ? JSON.parse(raw).slice(-4) : [];
    } catch { return null; }
  });
  assert.ok(Array.isArray(read) && read.length, 'the isolated world must be able to read it');
  assert.match(read.join(' '), /nope-not-here -> 404/);
  await page.close();
});

test('netwatch records no query strings, bodies or headers', async () => {
  // His answers and the site's tokens live in those. This is a diagnostic, not
  // a wiretap.
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(readFileSync(path.join(HERE, 'netwatch.js'), 'utf-8'));
  await page.evaluate(() => fetch('/api/nope?ssn=123-45-6789&token=secret').catch(() => {}));
  await page.waitForTimeout(400);
  const raw = await page.evaluate(() => document.documentElement.dataset.jarvisNet || '[]');
  assert.ok(!/123-45-6789/.test(raw), 'a query string must never be recorded');
  assert.ok(!/secret/.test(raw), 'nor a token in one');
  assert.match(raw, /api\/nope -> 404/, 'the path and status still are');
  await page.close();
});

test('netwatch redacts a SECRET in the path, not just the query', async () => {
  // F-273. Dropping the query string was right and half the job: a path carries
  // the same class of thing, and these lines travel — stoppedBecause -> the
  // apply record -> the dashboard -> the backup. Measured before the fix, both
  // of these were recorded verbatim.
  const page = await ctx.newPage();
  await page.route('**/*', (r) => r.fulfill({ status: 422, contentType: 'text/html', body: '<html><body>x</body></html>' }));
  await page.goto('https://boards.greenhouse.io/acme/jobs/1').catch(() => {});
  await page.evaluate(readFileSync(path.join(EXT, 'netwatch.js'), 'utf-8'));
  await page.evaluate(async () => {
    for (const u of [
      '/api/candidate/someone@example.com/profile',
      '/session/eyJhbGciOiJIUzI1NiJ9.SECRETTOKEN.sig/next',
      '/api/v1/applicants/12345/documents',
    ]) { try { await fetch(u); } catch { /* the route fulfils it */ } }
    await new Promise((r) => setTimeout(r, 300));
  });
  const rec = await page.evaluate(() => document.documentElement.dataset.jarvisNet || '[]');
  await page.close();

  assert.ok(!/someone@example\.com/i.test(rec), 'an email in the path must not be recorded');
  assert.ok(!/SECRETTOKEN/i.test(rec), 'a token in the path must not be recorded');
  // …while the SHAPE survives, because that is the whole diagnostic value.
  assert.match(rec, /\/api\/candidate\/[^/]*\/profile/, 'the path shape is kept');
  assert.match(rec, /\/api\/v1\/applicants\/12345\/documents/, 'ordinary ids are not redacted');
});

test('IT RELOADS ITSELF WHEN THE DASHBOARD IS AHEAD — the last manual reload', async () => {
  // Chrome does not auto-update an unpacked extension, so every fix in the repo
  // stayed invisible until someone opened chrome://extensions and pressed
  // reload. A whole session of fixes sat undeployed while the browser kept
  // reproducing bugs that had been fixed hours earlier.
  //
  // `chrome.runtime.reload()` re-reads an unpacked extension from disk, so it
  // can do that itself. Spied rather than called for real: an actual reload
  // tears down the worker this test is talking to.
  const spied = await worker.evaluate(async () => {
    const real = chrome.runtime.reload;
    let called = false;
    chrome.runtime.reload = () => { called = true; };
    // Pretend the dashboard expects something newer than what is loaded.
    const realFetch = self.fetch;
    self.fetch = async (u, o) => {
      if (String(u).includes('/api/extension')) {
        return { ok: true, json: async () => ({ expected: '99.0.0' }) };
      }
      return realFetch(u, o);
    };
    const did = await self.reloadIfStale();
    self.fetch = realFetch;
    chrome.runtime.reload = real;
    return { did, called };
  });
  assert.equal(spied.did, true, 'it must notice the dashboard is ahead');
  assert.equal(spied.called, true, 'and actually ask Chrome to re-read it from disk');
});

test('it does NOT reload when versions agree, or when it is ahead', async () => {
  // A reload on every click would spend every click on a reload.
  const mine = await worker.evaluate(() => chrome.runtime.getManifest().version);
  for (const expected of [mine, '0.0.1']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await worker.evaluate(async (exp) => {
      const real = chrome.runtime.reload; let called = false;
      chrome.runtime.reload = () => { called = true; };
      const realFetch = self.fetch;
      self.fetch = async (u, o) => (String(u).includes('/api/extension')
        ? { ok: true, json: async () => ({ expected: exp }) } : realFetch(u, o));
      const did = await self.reloadIfStale();
      self.fetch = realFetch; chrome.runtime.reload = real;
      return { did, called };
    }, expected);
    assert.equal(r.called, false, `expected ${expected} vs loaded ${mine} must not trigger a reload`);
    assert.equal(r.did, false);
  }
});

test('an unreachable dashboard never blocks a run', async () => {
  const r = await worker.evaluate(async () => {
    const real = chrome.runtime.reload; let called = false;
    chrome.runtime.reload = () => { called = true; };
    const realFetch = self.fetch;
    self.fetch = async () => { throw new Error('offline'); };
    const did = await self.reloadIfStale();
    self.fetch = realFetch; chrome.runtime.reload = real;
    return { did, called };
  });
  assert.equal(r.did, false, 'a dashboard that is down must not stop him filling a form');
  assert.equal(r.called, false);
});

test('THE VERSION ALARM IS REGISTERED IN A REAL CHROME', async () => {
  // F-246. The self-update is worth nothing if the alarm never registers, and
  // that can fail for reasons no unit test sees: a missing `alarms` permission
  // in the manifest, or a top-level call that throws before it runs. Both would
  // be silent — the extension would simply never notice it was out of date
  // again, which is the exact condition that let it sit at 1.0.0 for two days.
  const got = await worker.evaluate(async () => ({
    perms: chrome.runtime.getManifest().permissions,
    alarms: (await chrome.alarms.getAll()).map((a) => ({ name: a.name, period: a.periodInMinutes })),
  }));
  assert.ok(got.perms.includes('alarms'),
    'the manifest must ask for alarms, or the timer silently does nothing');
  const check = got.alarms.find((a) => /version/i.test(a.name));
  assert.ok(check, `no version-check alarm registered — found ${JSON.stringify(got.alarms)}`);
  assert.ok(check.period > 0 && check.period <= 60,
    `the check repeats every ${check.period} min — it must recur, and not so rarely it is useless`);
});

test('THE SIDE PANEL PAGE LOADS FOR REAL and is answered through the real worker and dashboard', async () => {
  // The panel is an extension page; Chrome opens it beside a tab on the
  // toolbar click. Here it is opened pointed at a tab (panel.html?tab=<id>)
  // and asked about a page that is not a posting — the honest answer, from
  // the real dashboard through the real worker, is what proves the wiring.
  assert.equal(await worker.evaluate(() => typeof chrome.sidePanel?.open), 'function', 'the sidePanel permission is granted for real');
  const m = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(m.side_panel?.default_path, 'panel.html');

  const page = await fixturePage('/panel-fixture/apply');
  const tabId = await tabIdOf(page);
  assert.ok(tabId, 'the fixture tab exists');
  const panel = await ctx.newPage();
  await panel.goto(`${worker.url().replace(/background\.js$/, '')}panel.html?tab=${tabId}`);
  // The panel retries a 404 briefly before calling it — a posting that has not
  // painted yet is not the same as a page that is not a posting (F-385) — so
  // the verdict takes a couple of seconds rather than arriving instantly.
  try {
    await panel.waitForFunction(
      () => !document.getElementById('main').hidden || /Not a posting|cannot see/.test(document.getElementById('empty').textContent),
      null, { timeout: 30000 },
    );
  } catch (e) {
    const shown = await panel.textContent('#empty').catch(() => '(unreadable)');
    throw new Error(`the panel never settled; it shows: ${JSON.stringify(shown)}`);
  }
  assert.match(await panel.textContent('#empty'), /Not a posting in your store/, 'a fixture page is not a posting, and the panel says so in those words');
  assert.equal(await panel.textContent('#ver'), m.version, 'the version on the panel is the loaded extension\'s');
  await panel.close();
  await page.close();
});
