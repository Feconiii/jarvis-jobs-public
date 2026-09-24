// jarvis/json-stream.mjs — read a jobs.json too big to hold as one string.
//
// V8 caps a single string at ~512 MB, so `readFileSync(path,'utf-8')` throws
// before JSON.parse ever runs on a large store. Both the compactor and the
// SQLite migration need to walk such a file, so the walker lives here rather
// than in either of them.

import { createReadStream } from 'fs';

/**
 * Walk the top-level {"jobs":{…}} map, calling `onJob(id, job)` per entry, and
 * return everything after that map (the trailing scans / hiddenCompanies).
 *
 * Brace counting has to be string-aware: a description containing `{` or an
 * escaped quote would otherwise desynchronise the scanner and corrupt every
 * job after it.
 *
 * @param {string} inPath
 * @param {(id: string, job: any) => void} onJob
 * @returns {Promise<string>} the tail of the file, after the jobs object
 */
export async function streamJobs(inPath, onJob) {
  const stream = createReadStream(inPath, { encoding: 'utf-8', highWaterMark: 1 << 20 });

  let buf = '';
  let started = false;      // have we entered the "jobs" object?
  let done = false;         // has the jobs object closed?
  let tail = '';            // everything after the jobs object
  let i = 0;                // read cursor within buf

  const compact = () => { if (i > 0) { buf = buf.slice(i); i = 0; } };

  for await (const chunk of stream) {
    buf += chunk;

    if (done) { tail += chunk; continue; }

    if (!started) {
      const at = buf.indexOf('"jobs"');
      if (at === -1) { if (buf.length > 1 << 20) buf = buf.slice(-1024); continue; }
      const brace = buf.indexOf('{', at + 6);
      if (brace === -1) continue;
      i = brace + 1;
      started = true;
    }

    // Extract as many complete "id": {…} entries as the buffer allows.
    for (;;) {
      while (i < buf.length && (buf[i] === ',' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === ' ' || buf[i] === '\t')) i++;
      if (i >= buf.length) break;

      if (buf[i] === '}') { // end of the jobs map
        done = true;
        tail = buf.slice(i + 1);
        break;
      }
      if (buf[i] !== '"') { i++; continue; }

      const keyEnd = buf.indexOf('"', i + 1);
      if (keyEnd === -1) break;              // need more data
      const id = buf.slice(i + 1, keyEnd);
      let j = keyEnd + 1;
      while (j < buf.length && (buf[j] === ':' || buf[j] === ' ')) j++;
      if (j >= buf.length) break;
      if (buf[j] !== '{') { i = j; continue; }

      // Balanced, string-aware scan of the value object.
      let depth = 0, inStr = false, esc = false, k = j, end = -1;
      for (; k < buf.length; k++) {
        const c = buf[k];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
      }
      if (end === -1) break;                 // object spans past the buffer

      onJob(id, JSON.parse(buf.slice(j, end + 1)));
      i = end + 1;
    }
    compact();
    if (done) break;
  }
  stream.destroy();
  return tail;
}

/** Parse the trailing `,"scans":[…],"hiddenCompanies":[…]}` fragment. */
export function parseTail(tail) {
  try {
    const parsed = JSON.parse('{' + String(tail).replace(/^\s*,/, '').replace(/\}\s*$/, '') + '}');
    return {
      scans: Array.isArray(parsed.scans) ? parsed.scans : [],
      hiddenCompanies: Array.isArray(parsed.hiddenCompanies) ? parsed.hiddenCompanies : [],
    };
  } catch {
    return { scans: [], hiddenCompanies: [] };
  }
}
