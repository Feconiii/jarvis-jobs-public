// jarvis/same-file.mjs — one file, however it is spelled (2026-11-04).
//
// A path from a module URL and one from the working folder can spell the same
// file differently on Windows (case, slashes): a strict compare made writers
// that only touch his store (curate's LinkedIn route, mail's copy folding)
// skip it silently. A leaf: it imports nothing from Jarvis.

import fs from 'node:fs';
import path from 'node:path';

/** True when `a` and `b` name one file: real paths when they exist, case folded on Windows. */
export function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(String(p || ''));
    try { r = fs.realpathSync.native(r); } catch { /* not there yet: the resolved spelling */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return !!a && !!b && norm(a) === norm(b);
}
