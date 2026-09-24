/**
 * Who gets a resume, and who is refused one.
 *
 * WHY THIS FILE IS NOT A SOURCE-STRING TEST. The rule it covers was broken and
 * shipped in this session while the test guarding it passed. That test read
 * serve.mjs as text and asserted the string `matched === 'fallback'` appeared
 * in the handler. It did appear. The condition in front of it was `!ctx &&`,
 * and `ctx` is non-null in exactly the fallback case, so the refusal could
 * never fire — a request for an unrelated page was served the last posting's
 * resume. Caught by curling the endpoint, not by the suite.
 *
 * So the decision moved into a pure module and this tests the decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeTarget } from './apply-resume-target.mjs';

test('THE NEAR-MISS: an unrelated page is refused, never given the last resume', () => {
  // He applied to Amazon; he is now standing on some other company's form that
  // is not in his store. Serving the Amazon PDF would put another employer's
  // name on this application.
  assert.equal(resumeTarget({ matched: 'fallback', haveCtx: true, jobFound: false }), 'refuse');
});

test('a page that IS a posting in the store gets a resume built for it', () => {
  // The flow he actually uses: open a form, click the extension, never touch
  // the dashboard. This used to answer 404 and attach nothing.
  assert.equal(resumeTarget({ matched: 'none', haveCtx: false, jobFound: true }), 'build');
});

test('knowing the posting beats falling back to the last application', () => {
  // Both true: something else is in flight AND this page is a known posting.
  // The honest answer is this page's posting, not the one in flight.
  assert.equal(resumeTarget({ matched: 'fallback', haveCtx: true, jobFound: true }), 'build');
});

test("a prepared application for this very page is used as-is", () => {
  assert.equal(resumeTarget({ matched: 'page', haveCtx: true, jobFound: false }), 'use-ctx');
  // Building would throw away a resume that is already correct for this page.
  assert.equal(resumeTarget({ matched: 'page', haveCtx: true, jobFound: true }), 'use-ctx');
});

test('an explicit job id never guesses', () => {
  // This is the dashboard linking to its own prepared application.
  assert.equal(resumeTarget({ asked: true, haveCtx: true }), 'use-ctx');
  assert.equal(resumeTarget({ asked: true, haveCtx: false }), 'none');
  // Even with a fallback sitting there, an id that has no context is not
  // quietly upgraded to someone else's resume — and `jobFound` is about the
  // PAGE, which may be a different posting than the id names, so it must not
  // trigger a build either.
  assert.equal(resumeTarget({ asked: true, haveCtx: false, matched: 'fallback', jobFound: true }), 'none');
});

test('an explicit id that names a stored posting builds for THAT posting', () => {
  // An armed tab carries its application id across every page of the walk. A
  // dashboard restart empties the in-memory contexts while the tab is still on
  // screen three; the id still names a real posting and the honest answer is
  // to build its resume, not to say "none" and attach nothing.
  assert.equal(resumeTarget({ asked: true, askedFound: true, haveCtx: false }), 'build');
  // With a context already there, the context wins — building would discard
  // a resume that is already right.
  assert.equal(resumeTarget({ asked: true, askedFound: true, haveCtx: true }), 'use-ctx');
  // And a fallback sitting there changes nothing: the id is not a guess.
  assert.equal(resumeTarget({ asked: true, askedFound: true, haveCtx: false, matched: 'fallback' }), 'build');
});

test('nothing applied to and nothing recognised is simply nothing', () => {
  assert.equal(resumeTarget({ matched: 'none', haveCtx: false, jobFound: false }), 'none');
  assert.equal(resumeTarget(), 'none');
});

test('a page match with no context does not serve an empty context', () => {
  // Defensive: 'page' is only trustworthy when it actually carried a context.
  assert.notEqual(resumeTarget({ matched: 'page', haveCtx: false, jobFound: false }), 'use-ctx');
});

test('every outcome is one of the four the server handles', () => {
  const ok = new Set(['use-ctx', 'build', 'refuse', 'none']);
  for (const asked of [true, false]) {
    for (const askedFound of [true, false]) {
    for (const matched of ['page', 'fallback', 'none']) {
      for (const haveCtx of [true, false]) {
        for (const jobFound of [true, false]) {
          const got = resumeTarget({ asked, askedFound, matched, haveCtx, jobFound });
          assert.ok(ok.has(got), `resumeTarget returned "${got}" for ${JSON.stringify({ asked, askedFound, matched, haveCtx, jobFound })}`);
          // The invariant that matters: never serve a context we did not get.
          if (got === 'use-ctx') assert.ok(haveCtx, 'use-ctx without a context');
          // And never claim to build without a posting to build from — the
          // page's posting, or the one the explicit id names.
          if (got === 'build') assert.ok(asked ? askedFound : jobFound, 'build without a posting');
        }
      }
    }
    }
  }
});
