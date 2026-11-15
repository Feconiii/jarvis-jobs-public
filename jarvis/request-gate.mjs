// jarvis/request-gate.mjs — who may call the dashboard (review, 2026-11-03).
//
// The dashboard listened on every interface and answered any page, so anyone
// on his network, or a web page he visited, could call its write routes
// (settings, outreach, applications). Three rules now, checked before any route:
//
//   1. The Host must be this machine (localhost, 127.0.0.1, [::1]). A page
//      that rebinds its own domain to 127.0.0.1 sends its own Host and is refused.
//   2. An /api request that carries a foreign Origin, or that the browser
//      marks as started by another site (Sec-Fetch-Site: cross-site), is
//      refused. Allowed origins: the dashboard itself and browser extensions.
//      No Origin at all (curl, node scripts) is this machine's own tooling.
//   3. Except the routes built to be called from an employer's page by the
//      extension's page scripts and the harvests (CROSS_ORIGIN_OK). They keep
//      answering any origin, as before; moving their callers into the
//      extension's background worker is what would close them.
//
// Not /api (the dashboard page, /assist-bridge, a resume PDF): page loads,
// which a careers page navigates to on purpose (the assist bridge).

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CROSS_ORIGIN_OK = new Set([
  '/api/apply-token', '/api/person', '/api/verification-code',
  '/api/import', '/api/import-descriptions', '/api/assist-liveness', '/api/assist-targets',
]);

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i;
const EXT_ORIGIN = /^(?:chrome-extension|moz-extension|extension):\/\/([\w-]+)$/i;

/**
 * Why a request is refused, or null to let it through (review, 2026-11-03:
 * pinned). `port`: the server's own port, the only localhost origin allowed.
 * `extensionIds`: the extension ids allowed; none known means no extension
 * origin passes (fail closed). `ticketOk`: whether a file ticket is live
 * (F-1031, below).
 */
/**
 * THE PANEL'S OWN PDF (F-1031, 2026-11-07). The side panel shows his resume and
 * letter in an iframe pointed at the dashboard, so the PDF viewer saves it
 * under its real name (F-412). A frame an extension page loads is a page load
 * started by another site: no Origin, `Sec-Fetch-Site: cross-site`. Rule 2
 * refused it from 2026-11-03, and the Resume tab read "refused: a request
 * another site started may not call /api/apply-resume". These two routes pass
 * such a load when it carries a live ticket, which only the extension can get
 * (POST /api/file-ticket asks for its token). A ticket opens one route for one
 * job, for 30 minutes, and a load with a ticket may carry nothing but id and
 * inline (review): `ticketOk(ticket, { pathname, params })` decides. A web
 * page has no ticket.
 */
export const TICKET_ROUTES = new Set(['/api/apply-resume', '/api/cover-letter-pdf']);
export function requestGate(req, { port = null, extensionIds = new Set(), ticketOk = () => false } = {}) {
  const h = req?.headers || {};
  const host = String(h.host || '');
  if (!host) return 'refused: a request with no Host';
  const hm = LOCAL_HOST.exec(host);
  if (!hm) return `refused: host ${host} is not this machine`;
  let pathname = '';
  try { pathname = new URL(String(req.url || '/'), 'http://localhost').pathname; } catch { pathname = String(req.url || ''); }
  if (!pathname.startsWith('/api/') || CROSS_ORIGIN_OK.has(pathname)) return null;
  const origin = String(h.origin || '');
  if (origin === 'null') return `refused: an opaque origin may not call ${pathname}`;
  if (origin) {
    const lm = LOCAL_ORIGIN.exec(origin);
    if (lm) return port == null || Number(lm[1] || (origin.startsWith('https') ? 443 : 80)) === Number(port) ? null : `refused: ${origin} is another local server`;
    const em = EXT_ORIGIN.exec(origin);
    if (em) return extensionIds.has(em[1]) ? null : `refused: extension ${em[1]} is not the Jarvis extension`;
    return `refused: ${origin} may not call ${pathname}`;
  }
  if (String(h['sec-fetch-site'] || '') === 'cross-site') {
    if (TICKET_ROUTES.has(pathname) && String(req.method || 'GET') === 'GET') {
      let params = new URLSearchParams();
      try { params = new URL(String(req.url || '/'), 'http://localhost').searchParams; } catch { /* none */ }
      const ticket = params.get('ticket') || '';
      if (ticket && ticketOk(ticket, { pathname, params })) return null;
    }
    return `refused: a request another site started may not call ${pathname}`;
  }
  return null;
}

/**
 * FILE TICKETS (F-1031 review). Random, in memory only (a restart ends them
 * all). Each opens ONE file: one route, one job, for `ttlMs` (30 minutes; the
 * extension mints another as it runs out); at most 200 kept. A load carrying
 * a ticket may ask for nothing else: no pageUrl (no fetch from this server),
 * no write/ask/again (no letter or resume written, so no model spend) — only
 * id, inline and the ticket. Compared in constant time.
 */
export const FILE_ROUTES = { resume: '/api/apply-resume', letter: '/api/cover-letter-pdf' };
const TICKET_PARAMS = new Set(['id', 'inline', 'ticket']);
export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function makeFileTickets({ ttlMs = 30 * 60_000, max = 200, random = () => randomBytes(16).toString('hex') } = {}) {
  const tickets = new Map();   // ticket → { route, id, exp }
  function mint({ id, what = 'resume' } = {}, now = Date.now()) {
    const route = FILE_ROUTES[what];
    if (!route || !id) return null;
    for (const [t, e] of tickets) if (e.exp <= now) tickets.delete(t);
    while (tickets.size >= max) tickets.delete(tickets.keys().next().value);
    const t = random();
    tickets.set(t, { route, id: String(id), exp: now + ttlMs });
    return t;
  }
  function ok(t, { pathname = '', params = new URLSearchParams() } = {}, now = Date.now()) {
    let hit = null;
    for (const [k, e] of tickets) if (sameSecret(k, t)) hit = e;
    if (!hit || hit.exp <= now || hit.route !== pathname) return false;
    if ([...params.keys()].some((k) => !TICKET_PARAMS.has(k))) return false;
    return params.get('id') === hit.id;
  }
  return { mint, ok, ttlMs };
}
