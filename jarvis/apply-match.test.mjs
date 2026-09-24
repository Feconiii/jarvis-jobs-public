/**
 * Which application does a given tab belong to?
 *
 * This exists because of a live near-miss. He pressed Apply on an Applied
 * Materials posting and then, while it was still building, on a GlobalFoundries
 * one. Both tabs were open and both resumes were built. The server answered
 * "whichever finished last", so clicking the extension on the Applied Materials
 * form would have attached the GlobalFoundries resume — not a blank field, a
 * confident wrong answer carrying another employer's name.
 *
 * The matcher is duplicated here rather than imported because serve.mjs starts
 * an HTTP server and background workers on import. The test that keeps the two
 * honest is at the bottom: it reads the real source and checks the logic has not
 * moved out from under this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The whole body of one route handler, not a guessed number of bytes.
 *
 * These tests used to slice a fixed 1200 or 2600 characters from the handler's
 * first line, which made them fail the moment a comment was added above the
 * code they check — a passing test turning red for a reason that has nothing to
 * do with the property it guards. Slice to where the NEXT route begins instead.
 */
function handlerFor(src, pathname) {
  // Anchored on `&& req.method`, because the route GATE near the top names
  // every one of these paths in a single `if` and would otherwise be found
  // first — returning the gate instead of the handler, which is how the first
  // version of this helper broke three tests that were about something else.
  const at = src.indexOf(`if (url.pathname === '${pathname}' && req.method`);
  if (at < 0) throw new Error(`no handler for ${pathname} in serve.mjs`);
  const next = src.indexOf("if (url.pathname === '", at + 20);
  return src.slice(at, next > at ? next : src.length);
}

function siteOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase().split('.').slice(-2).join('.'); }
  catch { return ''; }
}

function contextForPage(pageUrl, contexts, lastApply) {
  const site = siteOf(pageUrl);
  const host = (() => { try { return new URL(String(pageUrl)).hostname.toLowerCase(); } catch { return ''; } })();
  let best = null;
  for (const [id, ctx] of contexts) {
    let score = 0;
    if (pageUrl && ctx.jobUrl === pageUrl) score = 100;
    else if (site && siteOf(ctx.jobUrl) === site) score = 60;
    else if (host && ctx.company) {
      const slug = String(ctx.company).toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (slug.length > 3 && host.replace(/[^a-z0-9]+/g, '').includes(slug)) score = 40;
    }
    if (score && (!best || score > best.score || (score === best.score && ctx.at > best.ctx.at))) {
      best = { id, ctx, score };
    }
  }
  if (best) return { id: best.id, ctx: best.ctx, matched: 'page' };
  const ctx = lastApply ? contexts.get(lastApply) : null;
  return ctx ? { id: lastApply, ctx, matched: 'fallback' } : { id: null, ctx: null, matched: 'none' };
}

const AMAT = ['amat1', { company: 'Applied Materials', jobUrl: 'https://jobs.appliedmaterials.com/job/austin/manufacturing-engineer/1', at: '2026-08-31T10:00:00Z' }];
const GF = ['gf1', { company: 'GlobalFoundries', jobUrl: 'https://globalfoundries.wd1.myworkdayjobs.com/External/job/Fab-Automation', at: '2026-08-31T10:02:00Z' }];
const both = () => new Map([AMAT, GF]);

test('THE NEAR-MISS: the Applied Materials form gets the Applied Materials resume', () => {
  // GlobalFoundries was applied to second, so "most recent" would pick it.
  const r = contextForPage('https://jobs.appliedmaterials.com/job/austin/manufacturing-engineer/1', both(), 'gf1');
  assert.equal(r.id, 'amat1');
  assert.equal(r.matched, 'page');
});

test('a redirect to the ATS host still matches its own application', () => {
  // jobs.appliedmaterials.com → careers.appliedmaterials.com is the real hop.
  const r = contextForPage('https://careers.appliedmaterials.com/apply/12345', both(), 'gf1');
  assert.equal(r.id, 'amat1');
});

test('a Workday tenant named after the employer matches it', () => {
  const r = contextForPage('https://globalfoundries.wd1.myworkdayjobs.com/External/job/x/apply', both(), 'amat1');
  assert.equal(r.id, 'gf1');
});

test('a page belonging to NEITHER application is a fallback, and says so', () => {
  const r = contextForPage('https://boards.greenhouse.io/someoneelse/jobs/9', both(), 'gf1');
  assert.equal(r.matched, 'fallback', 'a guess must be labelled a guess');
  assert.equal(r.id, 'gf1');
});

test('with nothing applied to, there is no match at all', () => {
  const r = contextForPage('https://jobs.lever.co/x/y/apply', new Map(), null);
  assert.equal(r.matched, 'none');
  assert.equal(r.ctx, null);
});

test('a junk or missing page URL never matches an application', () => {
  for (const bad of ['', null, 'not a url', undefined]) {
    assert.notEqual(contextForPage(bad, both(), 'gf1').matched, 'page', `"${bad}" must not match a posting`);
  }
});

test('the most recent wins only between EQUALLY good matches', () => {
  const two = new Map([
    ['old', { company: 'Applied Materials', jobUrl: 'https://jobs.appliedmaterials.com/job/a', at: '2026-08-31T09:00:00Z' }],
    ['new', { company: 'Applied Materials', jobUrl: 'https://jobs.appliedmaterials.com/job/b', at: '2026-08-31T11:00:00Z' }],
  ]);
  // Same employer, two postings, neither an exact URL match: take the newer.
  assert.equal(contextForPage('https://careers.appliedmaterials.com/apply/9', two, 'old').id, 'new');
  // But an EXACT match beats recency.
  assert.equal(contextForPage('https://jobs.appliedmaterials.com/job/a', two, 'new').id, 'old');
});

test('a fallback match is refused a resume by BOTH endpoints', () => {
  // The rule that makes the near-miss impossible rather than merely unlikely.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const resume = handlerFor(src, '/api/apply-resume');
  // The decision itself now lives in apply-resume-target.mjs and is tested for
  // real in apply-resume-target.test.mjs — a source-string test could not tell
  // a working guard from a broken one, and did not (see that file's header).
  assert.match(resume, /resumeTarget\(/, 'apply-resume must ask the shared decision');
  assert.match(resume, /want === 'refuse'/, 'and must handle the refusal it can return');
  assert.match(resume, /409/, 'and say why rather than serve the wrong PDF');
  const plan = handlerFor(src, '/api/plan');
  assert.match(plan, /picked\.matched !== 'fallback'/, 'plan must not offer a resume URL on a guess');
});

test('the matcher here is the same one serve.mjs uses', () => {
  // These are separate copies because importing serve.mjs starts a server. If
  // the real one changes shape, this test should be the thing that notices.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  for (const marker of [
    'function siteOf(',
    'function contextForPage(',
    "matched: 'page'",
    "matched: 'fallback'",
    'slug.length > 3',
  ]) {
    assert.ok(src.includes(marker), `serve.mjs no longer contains "${marker}" — this test file is now stale`);
  }
});


test('every apply endpoint is inside the route gate', () => {
  // /api/apply-status was written, tested by hand, and returned a bare 404 for
  // ten minutes because its path was missing from the one `if` that lets these
  // routes run at all. A handler nothing can reach looks exactly like a handler
  // that is broken.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const gate = src.slice(src.indexOf("if (url.pathname === '/api/apply'"), src.indexOf("if (url.pathname === '/api/apply'") + 420);
  for (const p of ['/api/apply', '/api/plan', '/api/apply-resume', '/api/apply-current', '/api/apply-status', '/api/apply-page']) {
    assert.ok(gate.includes(`'${p}'`), `${p} has a handler but the route gate does not let it through`);
  }
});

/**
 * F-230 — clicking the extension on a form built no resume at all.
 *
 * A resume existed only if he had pressed Apply on the DASHBOARD for that exact
 * posting first. The flow he actually uses — open a form, click the Jarvis
 * button — never created a context, so /api/apply-resume answered 404 and the
 * run filled every field and attached nothing. He reported it as "i havent seen
 * it put in a custom resume at all", and he was right.
 */

/** The URL-variant walk from serve.mjs, duplicated for the same reason as above. */
function pageVariants(pageUrl) {
  const bare = String(pageUrl).replace(/[?#].*$/, '');
  return [
    pageUrl,
    bare,
    bare.replace(/\/apply(\/.*)?$/i, ''),
    bare.replace(/\/application(\/.*)?$/i, ''),
    bare.replace(/\/(apply|application)\/?$/i, ''),
  ];
}

test('a form URL resolves to the posting the store recorded', () => {
  const posting = 'https://www.amazon.jobs/en/jobs/10486586/robotics-systems-engineer-i';
  // Every ATS hangs the form off the posting, so the tab is never the URL the
  // scanner saved. Matching only the exact string is what left the extension
  // unable to find the job it was plainly looking at.
  for (const page of [
    `${posting}/apply`,
    `${posting}/apply/`,
    `${posting}/application`,
    `${posting}?utm_source=linkedin`,
    `${posting}#form`,
    posting,
  ]) {
    assert.ok(
      pageVariants(page).includes(posting),
      `standing on ${page} must resolve to the stored posting`,
    );
  }
});

test('a page for a different company never resolves to this posting', () => {
  const posting = 'https://www.amazon.jobs/en/jobs/10486586/robotics-systems-engineer-i';
  const other = 'https://boards.greenhouse.io/anduril/jobs/999/apply';
  assert.ok(!pageVariants(other).includes(posting), 'variants must not reach across postings');
});

test('the resume endpoint builds one instead of refusing', () => {
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const handler = handlerFor(src, '/api/apply-resume');
  assert.match(handler, /jobForPage\(/, 'it must try to resolve the page to a stored posting');
  assert.match(handler, /startResumeBuild\(/, 'it must start a build rather than answering 404');
  assert.match(handler, /picked\.matched !== 'page'/, 'it must only do so when nothing already matches the page');
  // The build may only run for a page that resolved to a posting. Anything
  // else is the near-miss: another employer's resume on this application.
  assert.match(handler, /want === 'build'/, 'the build must be gated on the shared decision');
  assert.match(handler, /want === 'refuse'/, 'an unresolvable page must still be refused, not guessed at');
});

test('both ways in build the resume through one function', () => {
  // F-223 was this exact shape: the extension re-made four bugs the driver had
  // already fixed, because each path had its own copy.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  assert.equal(
    (src.match(/resumeForJob\(/g) || []).length, 1,
    'resumeForJob must be called in exactly one place — a second call site is a fork waiting to drift',
  );
  assert.ok(src.includes('function startResumeBuild('), 'the shared builder is gone');
  const apply = handlerFor(src, '/api/apply');
  assert.match(apply, /startResumeBuild\(job, key, \{ chrome: opened \}\)/,
    '/api/apply must go through the shared builder too');
});

test('the extension waits for a resume that is still being written', () => {
  const content = readFileSync(path.join(HERE, 'extension', 'content.js'), 'utf-8');
  const fn = content.slice(content.indexOf('async function attachResume('), content.indexOf('async function attachResume(') + 1400);
  assert.match(fn, /status === 425/, 'it must retry while the server is still tailoring');
  assert.match(fn, /deadline/, 'the wait must be bounded');
  // Matching the prose would break the first time someone reworded the message.
  const bg = readFileSync(path.join(HERE, 'extension', 'background.js'), 'utf-8');
  assert.match(bg, /err\.status = res\.status/, 'the HTTP code must reach the content script');
  assert.match(bg, /status: e\?\.status \|\| 0/, 'the status must survive the reply back to the page');
});

test('a GONE verdict from HIS browser is the one that can retire a posting', () => {
  // F-251. liveness-sweep refuses to retire on page wording, and F-250 is why:
  // a headless browser cannot tell a dead Workday posting from one Workday
  // declined to render for a bot, and got it wrong in both directions on the
  // same run — KLA genuinely 404, Jabil fully alive, identical verdict.
  //
  // The extension has no such doubt. It reads the page as he sees it, in the
  // session he is signed into. That verdict used to be a sentence in a panel
  // that died with the tab.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const filled = handlerFor(src, '/api/filled');
  assert.match(filled, /body\.postingGone/, '/api/filled must read the verdict the page reported');
  assert.match(filled, /goneAt/, 'and record it against the job');
  assert.match(filled, /!job\.goneAt/, 'without rewriting a date already set');

  // It must travel end to end, or the server never sees it.
  const content = readFileSync(path.join(HERE, 'extension', 'content.js'), 'utf-8');
  assert.match(content, /postingGone: String\(gone\)/,
    'the filler must report it as a field, not only as prose');
  const bg = readFileSync(path.join(HERE, 'extension', 'background.js'), 'utf-8');
  assert.match(bg, /postingGone: done\.postingGone/, 'and the worker must forward it');
});

test('the sweep still refuses to retire on wording alone', () => {
  // The other half of F-250, pinned so it cannot quietly come back. The
  // headless rung may retire on an HTTP status or an API answer, never on what
  // the page says.
  const sweep = readFileSync(path.join(HERE, 'liveness-sweep.mjs'), 'utf-8');
  const fn = sweep.slice(sweep.indexOf('function isDefinitelyGone'), sweep.indexOf('export function isSuspectWholeSource'));
  assert.match(fn, /http_gone/, 'an HTTP 404/410 still counts');
  assert.match(fn, /_api_gone\$\|_api_unlisted\$/, 'and so does the ATS API');
  assert.ok(!/return true/.test(fn.slice(fn.indexOf('expired_body'))),
    'expired_body must NOT be accepted — it retired a live Jabil posting in testing');
});

// ── the click starts the resume (F-298) ───────────────────────────────

test('THE PLAN REQUEST STARTS THE RESUME, so one click is enough', () => {
  // Until now the only request that could begin tailoring was
  // /api/apply-resume, which the extension sends ONLY when the plan contains an
  // upload action — which needs a file input on the page. Workday puts the
  // upload on screen two, so on Application Questions there is no file input,
  // no request, and no build could ever start. He clicked Jarvis on that step
  // and was told to go and press Apply on the dashboard.
  //
  // /api/plan is the one request sent on every step of every form.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const handler = handlerFor(src, '/api/plan');
  assert.match(handler, /jobForPage\(/, 'it must try to resolve the page to a stored posting');
  assert.match(handler, /startResumeBuild\(/, 'and start the build itself');
  assert.match(handler, /picked\.matched === 'fallback'/,
    'it must not disturb an application that already matches this page');
});

test('a page click never takes over the application he pressed Apply for', () => {
  // LAST_APPLY is the fallback every unmatched request lands on. A build that
  // started because he happened to click the toolbar must not move it, or a
  // deliberate dashboard application gets silently retargeted — the near-miss
  // this whole file exists to prevent.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  assert.match(src, /if \(makeCurrent\) LAST_APPLY = key;/,
    'startResumeBuild must be able to build WITHOUT claiming to be the current application');
  const handler = handlerFor(src, '/api/plan');
  assert.match(handler, /makeCurrent: false/, 'and the plan path must ask for exactly that');

  const apply = handlerFor(src, '/api/apply');
  assert.doesNotMatch(apply, /makeCurrent: false/,
    'pressing Apply on the dashboard DOES say which application is current');
});

test('one posting gets one build, however many frames ask', () => {
  // The extension injects into every frame and plans every step, and each build
  // shells the tailoring CLI. Without the cache lookup first, an iframe storm
  // starts N of them for one job.
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const handler = handlerFor(src, '/api/plan');
  assert.match(handler, /APPLY_CONTEXT\.get\(id\) \|\| startResumeBuild\(/,
    'an existing build must be reused, never restarted');
});

test('a page that is not in the store is told so, not sent to the dashboard', () => {
  // "Press Apply on the dashboard first" was the answer to every case,
  // including the two the click can now handle by itself, so it read as a
  // refusal when the truth was "already working on it" or "I do not know what
  // job this is".
  const src = readFileSync(path.join(HERE, 'serve.mjs'), 'utf-8');
  const handler = handlerFor(src, '/api/plan');
  // The wording moved with F-307: a page can now be read for its posting, so
  // "not in your store" is no longer the whole truth — the page said nothing
  // AND nothing matched is.
  assert.match(handler, /does not say which job it is, and nothing in your store matches it/,
    'the honest answer names the actual problem');
  assert.match(handler, /it will attach when the form reaches the upload step/,
    'and a build in progress must say what happens next');
});
