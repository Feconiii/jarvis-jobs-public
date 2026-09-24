#!/usr/bin/env node
// jarvis/disable-board.mjs — turn off a tracked company that turned out to be
// the wrong one, and take back the rows it brought in.
//
// The last step of every discovery pass. discover-ats resolves a NAME to a
// board, 3–5% of the time to a different company of the same name or to an
// agency (F-505, F-508, F-527), and audit-new-boards.mjs finds those by reading
// their titles. This is what happens next.
//
// DISABLED, NEVER DELETED (F-527). On 2026-09-19 ICON plc — clinical research,
// tracked as the 3D-printing company — was fixed by deleting its entry. The next
// day a discovery pass met the name "ICON", found nothing in portals.yml by that
// name, resolved the same board again and wrote it back with 843 rows. The
// entry was the only record that the name was taken. So the entry stays, with
// `enabled: false` and the reason written on it, and discover-ats — which counts
// disabled entries by name and by board URL — leaves it alone forever.
//
// Rows are removed only if he has never touched them (status 'new'). Anything
// he hearted, hid, applied to or decided on is his decision and stays.
//
// Usage:
//   node jarvis/disable-board.mjs "Tapestry" --why "Coach retail, not engineering"
//   node jarvis/disable-board.mjs "Tapestry" --why "…" --dry-run

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { guardArgs } from './cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
  node jarvis/disable-board.mjs "<company name>" --why "<reason>" [--dry-run]

  Set a tracked company to enabled: false with the reason in its notes, and
  remove the untouched rows it brought in. The entry is kept so the name stays
  taken and no discovery pass can add it again.
`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Disable one entry in portals.yml text. Pure, so the tests need no file.
 *
 * Line endings are matched as \r?\n on purpose: discover-ats appends its block
 * with \n into a file that is otherwise \r\n, and a patch that assumed the
 * file's own ending matched nothing — it removed 967 rows, disabled zero
 * entries, and the next scan would have brought every row back.
 *
 * @returns {{text:string, changed:boolean, reason:'ok'|'not-found'|'already-disabled'}}
 */
export function disableEntry(text, name, why) {
  const head = new RegExp(`  - name: "?${esc(name)}"?[ \\t]*\\r?\\n`);
  const at = text.search(head);
  if (at === -1) return { text, changed: false, reason: 'not-found' };
  // The entry runs until the next "  - name:" or the end of the list.
  const rest = text.slice(at + 1);
  const next = rest.search(/\r?\n  - name: /);
  const end = next === -1 ? text.length : at + 1 + next;
  const block = text.slice(at, end);
  if (!/^    enabled: true[ \t]*$/m.test(block)) return { text, changed: false, reason: 'already-disabled' };

  const stamp = `${String(why).replace(/"/g, "'").replace(/\s+/g, ' ').trim()} — disabled ${new Date().toISOString().slice(0, 10)}.`;
  const nl = /\r\n/.test(block) ? '\r\n' : '\n';
  let out = /^    notes: "/m.test(block)
    ? block.replace(/^(    notes: ")/m, `$1${stamp} `)
    : block.replace(/^(    enabled: true)/m, `    notes: "${stamp}"${nl}$1`);
  out = out.replace(/^    enabled: true([ \t]*)$/m, '    enabled: false$1');
  return { text: text.slice(0, at) + out + text.slice(end), changed: true, reason: 'ok' };
}

async function main(argv) {
  const args = guardArgs({ usage: USAGE, flags: ['--why', '--dry-run'], valued: ['--why'], argv });
  const i = args.indexOf('--why');
  const why = i === -1 ? '' : args[i + 1];
  const name = args.find((a, k) => !a.startsWith('--') && k !== i + 1);
  if (!name || !why) { console.error(USAGE); return 1; }
  const dry = args.includes('--dry-run');

  const file = path.join(ROOT, 'portals.yml');
  const res = disableEntry(readFileSync(file, 'utf8'), name, why);
  if (res.reason === 'not-found') { console.error(`  No tracked company named exactly "${name}".`); return 1; }

  const { db } = await import('./store.mjs');
  const d = db();
  const total = d.prepare('SELECT COUNT(*) c FROM jobs WHERE company = ?').get(name).c;
  const ids = d.prepare("SELECT id FROM jobs WHERE company = ? AND status = 'new'").all(name).map(r => r.id);

  console.log(`\n  ${name}: ${res.reason === 'ok' ? 'will be disabled' : 'already disabled'}; ${ids.length} untouched row(s) to remove, ${total - ids.length} he has acted on are kept.`);
  if (dry) { console.log('  (dry run — nothing written)\n'); return 0; }

  // The entry first. If the rows went first and this failed, the next scan
  // would bring every one of them back.
  if (res.changed) writeFileSync(file, res.text);
  d.exec('BEGIN');
  for (const id of ids) {
    d.prepare('DELETE FROM descriptions WHERE id = ?').run(id);
    d.prepare('DELETE FROM details WHERE id = ?').run(id);
    d.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
  d.exec('COMMIT');
  console.log('  Done.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  process.exit(await main(process.argv.slice(2)));
}
