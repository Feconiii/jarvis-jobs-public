// jarvis/serve-security.test.mjs — what a web page he visits can get from the dashboard.
// Run: node jarvis/serve-security.test.mjs
//
// A real server on its own port, read-only and with no background jobs (the
// dashboard test's own setup), asked the way a hostile page would ask.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 4393;
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const ask = (pathname, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { host: `localhost:${PORT}`, ...headers } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  if (body) r.write(body);
  r.end();
});

const server = spawn(process.execPath, [path.join(HERE, 'serve.mjs'), '--port', String(PORT)],
  { cwd: ROOT, env: { ...process.env, JARVIS_AUTO: '0', JARVIS_READONLY: '1' }, stdio: 'ignore' });
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = (await ask('/api/ping')).status === 200; if (!up) await new Promise((r) => setTimeout(r, 500)); }
  eq('the test server is up', up, true);

  console.log('🧪 serve: a web page he visits');
  const evil = { origin: 'https://evil.example' };
  const person = await ask('/api/person', { headers: evil });
  eq('cannot read his contact details (/api/person)', [person.status, /fullName|email|phone/.test(person.body)], [403, false]);
  const code = await ask('/api/verification-code', { headers: evil });
  eq('cannot read a verification code', [code.status, /code/i.test(code.body) && code.status === 200], [403, false]);
  eq('cannot get the extension token', (await ask('/api/apply-token', { headers: evil })).status, 403);
  eq('cannot change his settings', (await ask('/api/settings', { method: 'POST', headers: { ...evil, 'content-type': 'application/json' }, body: '{"dailyTopUp":30}' })).status, 403);
  eq('cannot read the job list', (await ask('/api/jobs?status=inbox', { headers: evil })).status, 403);
  eq('a no-cors request another site started is refused', (await ask('/api/jobs', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  eq('a rebinding page (its own Host) is refused', (await ask('/', { headers: { host: `evil.example:${PORT}` } })).status, 403);

  console.log('\n🧪 serve: his own tools still work');
  eq('the dashboard page loads', (await ask('/')).status, 200);
  eq('the dashboard\'s own API call passes', (await ask('/api/search-status', { headers: { origin: `http://localhost:${PORT}` } })).status, 200);
  eq('a local script (no Origin) passes', (await ask('/api/ping')).status, 200);
} finally {
  server.kill();
}
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
