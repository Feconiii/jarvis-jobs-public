// jarvis/request-gate.test.mjs — who may call the dashboard.
// Run: node jarvis/request-gate.test.mjs
import { requestGate, makeFileTickets } from './request-gate.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const req = (url, headers = {}) => ({ url, headers: { host: 'localhost:4300', ...headers } });
const PIN = { port: 4300, extensionIds: new Set(['abcdefghijklmnopabcdefghijklmnop']) };
const ok = (r) => requestGate(r, PIN) === null;

console.log('🧪 request-gate');
eq('the dashboard page calling its own API passes', ok(req('/api/settings', { origin: 'http://localhost:4300', 'sec-fetch-site': 'same-origin' })), true);
eq('the extension\'s background worker passes', ok(req('/api/jobs', { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })), true);
eq('a node script (no Origin) passes', ok(req('/api/search-status')), true);
eq('127.0.0.1 and ::1 are this machine', [ok({ url: '/api/jobs', headers: { host: '127.0.0.1:4300' } }), ok({ url: '/api/jobs', headers: { host: '[::1]:4300' } })], [true, true]);
eq('a foreign site writing settings is refused', ok(req('/api/settings', { origin: 'https://evil.example' })), false);
eq('a foreign site\'s image GET (no Origin, cross-site) is refused', ok(req('/api/outreach/send-queue', { 'sec-fetch-site': 'cross-site' })), false);
eq('a DNS-rebinding page (its own Host) is refused, any path', ok({ url: '/', headers: { host: 'evil.example:4300' } }), false);
eq('an opaque origin (sandboxed frame) is refused', ok(req('/api/settings', { origin: 'null' })), false);
eq('the routes the extension calls from an employer page still answer', ok(req('/api/person', { origin: 'https://nxp.wd3.myworkdayjobs.com' })), true);
eq('a careers page navigating to the assist bridge passes', ok(req('/assist-bridge', { 'sec-fetch-site': 'cross-site' })), true);
// Pinned (review, 2026-11-03).
eq('another extension is refused', ok(req('/api/jobs', { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' })), false);
eq('no extension id known: every extension is refused (fail closed)', requestGate(req('/api/jobs', { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }), { port: 4300 }) === null, false);
eq('another local server\'s page is refused', ok(req('/api/settings', { origin: 'http://localhost:4310' })), false);
eq('a request with no Host is refused', ok({ url: '/api/jobs', headers: {} }), false);
{
  const { extensionIds } = await import('./chrome-extension-state.mjs');
  // Chromium's rule for an unpacked extension: sha256 of the folder path (UTF-16), first 32 hex as a-p.
  // Checked once against the id Chrome registered for this repo's folder (2026-11-03).
  const ids = [...extensionIds('C:\\Users\\someone\\repo\\jarvis\\extension')];
  eq('ids are Chromium extension ids, one per drive-letter spelling', [ids.length >= 2, ids.every((x) => /^[a-p]{32}$/.test(x))], [true, true]);
}
// F-1031: the side panel's PDF frame (a page load an extension page started).
{
  const live = new Set(['goodticket']);
  const T = { ...PIN, ticketOk: (t) => live.has(t) };
  const frame = (url) => requestGate(req(url, { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' }), T) === null;
  eq('the panel\'s resume frame without a ticket is refused (what he saw)', frame('/api/apply-resume?id=abc&inline=1'), false);
  eq('…with a live ticket it passes', frame('/api/apply-resume?id=abc&inline=1&ticket=goodticket'), true);
  eq('…and the letter too', frame('/api/cover-letter-pdf?id=abc&inline=1&ticket=goodticket'), true);
  eq('a made-up ticket is refused', frame('/api/apply-resume?id=abc&ticket=guess'), false);
  eq('a ticket opens only the two file routes', frame('/api/settings?ticket=goodticket'), false);
  eq('a POST with a ticket is still refused', requestGate({ url: '/api/apply-resume?ticket=goodticket', method: 'POST', headers: { host: 'localhost:4300', 'sec-fetch-site': 'cross-site' } }, T) === null, false);
  eq('a foreign page with a ticket in its URL is still refused by its Origin', requestGate(req('/api/apply-resume?ticket=goodticket', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), T) === null, false);
}
// F-1031 review: the real ticket store behind the real gate.
{
  let clock = 1_000_000;
  const store = makeFileTickets({ ttlMs: 30 * 60_000 });
  const T = { ...PIN, ticketOk: (t, where) => store.ok(t, where, clock) };
  const t = store.mint({ id: 'job-1' }, clock);
  const tl = store.mint({ id: 'job-1', what: 'letter' }, clock);
  const load = (url, extra = {}, method = 'GET') => requestGate({ url, method, headers: { host: 'localhost:4300', 'sec-fetch-site': 'cross-site', ...extra } }, T) === null;
  eq('a minted ticket opens its own file', load(`/api/apply-resume?id=job-1&inline=1&ticket=${t}`), true);
  eq('…not another job\'s', load(`/api/apply-resume?id=job-2&inline=1&ticket=${t}`), false);
  eq('…not the letter (one route per ticket)', load(`/api/cover-letter-pdf?id=job-1&ticket=${t}`), false);
  eq('the letter\'s own ticket opens the letter', load(`/api/cover-letter-pdf?id=job-1&ticket=${tl}`), true);
  eq('with pageUrl (a server fetch) it is refused', load(`/api/apply-resume?id=job-1&pageUrl=https%3A%2F%2Fx.test&ticket=${t}`), false);
  eq('with write=1 (a letter written, model spend) it is refused', load(`/api/cover-letter-pdf?id=job-1&write=1&ask=1&ticket=${tl}`), false);
  eq('with again=1 (a resume built again) it is refused', load(`/api/apply-resume?id=job-1&again=1&ticket=${t}`), false);
  eq('Origin "null" with a ticket is refused', load(`/api/apply-resume?id=job-1&ticket=${t}`, { origin: 'null' }), false);
  eq('HEAD with a ticket is refused', load(`/api/apply-resume?id=job-1&ticket=${t}`, {}, 'HEAD'), false);
  eq('no ticket without an id', store.mint({}, clock), null);
  clock += 30 * 60_000;
  eq('after 30 minutes the ticket is dead', load(`/api/apply-resume?id=job-1&inline=1&ticket=${t}`), false);
}
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
