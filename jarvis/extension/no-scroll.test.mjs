/**
 * P4: A FILL NEVER MOVES THE PAGE (Simplify research 2026-11-06). No browser:
 * the scripts that fill a form are read as text, and every call that scrolls
 * the window on its own is refused. A bare focus() scrolls its box into view;
 * focus({ preventScroll: true }) does not. Scrolling INSIDE a list (a grid's
 * scrollTop, to reach a virtualised row) stays: it never moves the window.
 * The browser fixtures in fill.test.mjs ("P4:") measure the window itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILL_SCRIPTS = ['content.js', 'discover.js', 'oracle-select.js'];

/** Code lines only: a comment may name what it no longer does. */
function codeLines(file) {
  return readFileSync(path.join(here, file), 'utf8').split(/\r?\n/)
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text))
    .map(({ text, line }) => ({ text: text.replace(/\/\/.*$/, ''), line }));
}

const MOVERS = [
  { re: /\.focus\(\s*\)/, why: 'a bare focus() scrolls the box into view: focus({ preventScroll: true })' },
  { re: /\.scrollIntoView(IfNeeded)?\s*\(/, why: 'scrollIntoView moves the page he is reading' },
  { re: /\b(window|document\.scrollingElement|document\.documentElement|document\.body)\.(scrollTo|scrollBy|scroll)\s*\(/, why: 'the window is his' },
  { re: /\bwindow\.scrollY\s*=|\bdocument\.(documentElement|body|scrollingElement)\.scrollTop\s*=/, why: 'the window is his' },
];

for (const file of FILL_SCRIPTS) {
  test(`P4: ${file} never scrolls the window`, () => {
    const hits = [];
    for (const { text, line } of codeLines(file)) {
      for (const { re, why } of MOVERS) if (re.test(text)) hits.push(`${file}:${line} ${text.trim().slice(0, 90)} (${why})`);
    }
    assert.deepEqual(hits, []);
  });
}

test('P4: the check can fail', () => {
  const caught = MOVERS.filter(({ re }) => re.test('box.focus();') || re.test('next.scrollIntoView({ block: "center" });') || re.test('window.scrollTo(0, 0)'));
  assert.equal(caught.length, 3);
});
