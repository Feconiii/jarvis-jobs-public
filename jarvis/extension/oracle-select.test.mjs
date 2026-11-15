// P2 (2026-11-07; review fixes): Oracle's cx-select set through its own React
// props — only the box's OWN list, only his answer, never replacing his pick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('./oracle-select.js', import.meta.url), 'utf8');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June'].map((m, i) => ({ label: m, value: String(i + 1) }));

/**
 * A page with one box. `chain`: the props of the fibers above the box's own,
 * nearest first. `container`: the box's .cx-select-container element, and
 * which chain index's first host node it is.
 */
function page({ chain = [], fiber = true, hostOf = -1, inputs = 1 } = {}) {
  const attrs = new Set();
  const box = { id: 'month-1', value: '', hasAttribute: (a) => attrs.has(a), setAttribute: (a) => attrs.add(a) };
  const container = { nodeType: 1, tag: 'cx-select-container', querySelectorAll: (sel) => (sel === 'input' ? Array.from({ length: inputs }, () => box) : []) };
  box.closest = (sel) => (sel === '.cx-select-container' ? container : null);
  if (fiber) {
    let top = null;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const node = { memoizedProps: chain[i], return: top, child: null };
      if (i === hostOf) node.child = { stateNode: container, child: null };
      top = node;
    }
    box['__reactFiber$abc123'] = { memoizedProps: { className: 'input' }, return: top };
  }
  const ctx = { document: { activeElement: null, getElementById: (id) => (id === box.id ? box : null) } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { box, os: ctx.__jarvisOracleSelect, doc: ctx.document };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const GUARD = { before: '', wanted: ['May'] };

test('the box\'s own list, named by its id: read whole, and the chosen option set through valueObserver alone', () => {
  const set = [];
  const props = { id: 'month-1', options: MONTHS, valueObserver: (v) => set.push(['observer', v]), onValueChange: (v) => set.push(['change', v]) };
  const { os } = page({ chain: [props] });
  assert.deepEqual(plain(os.oracleSelectRead('month-1')), { ok: true, labels: ['January', 'February', 'March', 'April', 'May', 'June'] });
  assert.deepEqual(plain(os.oracleSelectSet('month-1', 4, 'May', GUARD)), { ok: true, label: 'May' });
  assert.deepEqual(set, [['observer', '5']], 'valueObserver only; onValueChange untouched');
});

test('owned through its container: the fiber whose first DOM node is the box\'s .cx-select-container — holding this one input', () => {
  const props = { options: MONTHS, onValueChange: () => {} };   // no id in the props
  assert.equal(page({ chain: [props], hostOf: 0 }).os.oracleSelectRead('month-1').ok, true);
  const two = page({ chain: [props], hostOf: 0, inputs: 2 });
  assert.equal(two.os.oracleSelectRead('month-1').ok, false, 'a container with two inputs owns neither');
  assert.equal(two.os.oracleSelectSet('month-1', 4, 'May', GUARD).ok, false);
});

test('THE LAST LOOK, in the page right before the setter: his mark, a value it was not told of, or no guard — nothing written', () => {
  let touched = 0;
  const mk = () => page({ chain: [{ id: 'month-1', options: MONTHS, valueObserver: () => { touched += 1; } }] });
  const p1 = mk(); p1.box.value = 'Ju';
  assert.match(p1.os.oracleSelectSet('month-1', 4, 'May', GUARD).why, /box changed/, 'something typed meanwhile');
  const p2 = mk(); p2.box.setAttribute('data-jarvis-his');
  assert.match(p2.os.oracleSelectSet('month-1', 4, 'May', GUARD).why, /he touched it/);
  assert.equal(mk().os.oracleSelectSet('month-1', 4, 'May').ok, false, 'no guard, no set');
  // What it held before the attempts is allowed; so is an empty box.
  const p3 = mk(); p3.box.value = 'Select';
  assert.equal(p3.os.oracleSelectSet('month-1', 4, 'May', { before: 'Select', wanted: ['May'] }).ok, true);
  assert.equal(touched, 1);
});

test('the typed answer counts as ours only while the box is NOT focused (focused, it may be his typing)', () => {
  let touched = 0;
  const p = page({ chain: [{ id: 'month-1', options: MONTHS, valueObserver: () => { touched += 1; } }] });
  p.box.value = 'May';
  p.doc.activeElement = p.box;
  assert.match(p.os.oracleSelectSet('month-1', 4, 'May', GUARD).why, /box changed/);
  assert.equal(touched, 0);
  p.doc.activeElement = null;
  assert.equal(p.os.oracleSelectSet('month-1', 4, 'May', GUARD).ok, true);
  assert.equal(touched, 1);
});

test('AN ANCESTOR\'S LIST IS REFUSED: the nearest option list belongs to another field', () => {
  let touched = 0;
  const other = { id: 'gender-7', options: [{ label: 'Male', value: 'M' }, { label: 'Female', value: 'F' }], valueObserver: () => { touched += 1; } };
  const { os } = page({ chain: [{ className: 'wrapper' }, other] });
  assert.equal(os.oracleSelectRead('month-1').ok, false);
  assert.match(os.oracleSelectRead('month-1').why, /not this box/);
  assert.equal(os.oracleSelectSet('month-1', 1, 'Female', { before: '', wanted: ['Female'] }).ok, false);
  assert.equal(touched, 0, 'another field is never set');
  // …and the walk does not go past it to find one that would fit.
  const mine = { id: 'month-1', options: MONTHS, valueObserver: () => { touched += 1; } };
  assert.equal(page({ chain: [other, mine] }).os.oracleSelectRead('month-1').ok, false, 'stops at the first option list');
});

test('the list changed between the read and the set: refused', () => {
  let touched = 0;
  const { os } = page({ chain: [{ id: 'month-1', options: MONTHS, valueObserver: () => { touched += 1; } }] });
  assert.equal(os.oracleSelectSet('month-1', 4, 'April', GUARD).ok, false);
  assert.equal(os.oracleSelectSet('month-1', 99, 'May', GUARD).ok, false);
  assert.equal(os.oracleSelectSet('month-1', 4, '', GUARD).ok, false, 'a set must name its label');
  assert.equal(touched, 0);
});

test('a list given as a function is read only as a plain Knockout observable (peek)', () => {
  const observable = Object.assign(() => { throw new Error('a dependency read'); }, { peek: () => ['Yes', 'No'] });
  assert.deepEqual([...page({ chain: [{ id: 'month-1', options: observable, onValueChange() {} }] }).os.oracleSelectRead('month-1').labels], ['Yes', 'No']);
  const unknownFn = () => ['Yes'];
  assert.equal(page({ chain: [{ id: 'month-1', options: unknownFn, onValueChange() {} }] }).os.oracleSelectRead('month-1').ok, false, 'an unknown function is never called');
});

test('no fiber, no box, no setter: nothing happens', () => {
  assert.equal(page({ fiber: false }).os.oracleSelectRead('month-1').ok, false);
  assert.equal(page({ chain: [{ id: 'month-1', options: MONTHS }] }).os.oracleSelectRead('month-1').ok, false, 'no setter');
  assert.equal(page({ chain: [{ id: 'month-1', options: MONTHS, onValueChange() {} }] }).os.oracleSelectRead('nope').ok, false);
});

// The worker's half, in a vm harness.
const BG = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
function worker({ choose = () => -1, chain = [{ id: 'month-1', options: MONTHS, valueObserver() {} }] } = {}) {
  const asked = []; const pageCalls = [];
  const box = { id: 'month-1', value: '', closest: () => null };
  let top = null;
  for (let i = chain.length - 1; i >= 0; i -= 1) top = { memoizedProps: chain[i], return: top, child: null };
  if (chain.length) box['__reactFiber$x'] = { memoizedProps: {}, return: top };
  const listeners = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, Promise, JSON, Math, Date,
    document: { getElementById: (id) => (id === box.id ? box : null) },
    importScripts: () => vm.runInContext(SRC, sandbox),
    async fetch(url, opts = {}) {
      if (url.endsWith('/api/apply-token')) return { ok: true, status: 200, json: async () => ({ token: 't', port: 4300 }) };
      if (url.endsWith('/api/choose')) { const b = JSON.parse(opts.body); asked.push(b.want); return { ok: true, status: 200, json: async () => ({ index: choose(b.want, b.options) }) }; }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    chrome: {
      runtime: { id: 'x', onMessage: { addListener: (fn) => { listeners.message = fn; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessageExternal: { addListener() {} }, onConnect: { addListener() {} }, getManifest: () => ({ version: '1' }), getURL: (p) => `chrome-extension://x/${p}` },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
      action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
      scripting: { executeScript: async (o) => { pageCalls.push(o.func?.name); return [{ result: o.func(...(o.args || [])) }]; } },
      tabs: { get: async () => ({}), query: async () => [], onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} }, onCreated: { addListener() {} } },
      webNavigation: { onCommitted: { addListener() {} }, onHistoryStateUpdated: { addListener() {} }, onReferenceFragmentUpdated: { addListener() {} }, onCompleted: { addListener() {} }, onCreatedNavigationTarget: { addListener() {} } },
      alarms: { create() {}, onAlarm: { addListener() {} }, clear() {} },
      contextMenus: { create() {}, removeAll(cb) { cb?.(); }, onClicked: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      windows: { onRemoved: { addListener() {} }, onFocusChanged: { addListener() {} } },
      sidePanel: undefined,
    },
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BG, sandbox);
  const ask = (msg, frameId = 0) => new Promise((resolve) => listeners.message(msg, { tab: { id: 7 }, frameId }, resolve));
  return { ask, asked, pageCalls, box };
}

test('the worker\'s pick reads and chooses ONLY — it never sets; the set is a separate ask that names the label', async () => {
  const w = worker({ choose: (want, options) => options.indexOf(want) });
  assert.deepEqual(plain(await w.ask({ type: 'oracle-pick', inputId: 'month-1', wants: ['May'] })), { ok: true, index: 4, label: 'May' });
  assert.deepEqual(w.pageCalls, ['oracleSelectRead'], 'nothing set by the pick');
  assert.deepEqual(plain(await w.ask({ type: 'oracle-set', inputId: 'month-1', index: 4, label: 'May', before: '', wanted: ['May'] })), { ok: true, label: 'May' });
  assert.deepEqual(w.pageCalls, ['oracleSelectRead', 'oracleSelectSet']);
  // The worker hands the page its guard: a box now holding something else is refused there.
  w.box.value = 'June';
  const late = await w.ask({ type: 'oracle-set', inputId: 'month-1', index: 4, label: 'May', before: '', wanted: ['May'] });
  assert.equal(late.ok, false);
  assert.match(late.why, /box changed/);
});

test('the worker: his answer not among the options, or no props — nothing chosen, the matcher only asked when there is a list', async () => {
  const miss = worker({ choose: () => -1 });
  const r = await miss.ask({ type: 'oracle-pick', inputId: 'month-1', wants: ['Smarch', 'Undecimber'] });
  assert.equal(r.ok, false);
  assert.match(r.why, /not among its options/);
  const none = worker({ chain: [] });
  assert.equal((await none.ask({ type: 'oracle-pick', inputId: 'month-1', wants: ['May'] })).ok, false);
  assert.deepEqual(none.asked, []);
});

test('the worker: a frame below the top is never acted in', async () => {
  const w = worker({ choose: () => 0 });
  assert.equal((await w.ask({ type: 'oracle-pick', inputId: 'month-1', wants: ['May'] }, 3)).ok, false);
  assert.equal((await w.ask({ type: 'oracle-set', inputId: 'month-1', index: 0, label: 'January' }, 3)).ok, false);
  assert.deepEqual(w.pageCalls, []);
});
