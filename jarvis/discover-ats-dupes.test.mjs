// F-754: the discovery writer refuses an entry portals.yml already tracks.
//
// portals.yml once held eight exact duplicates (same name, same careers_url)
// from one discovery batch written twice, and every scan read each of those
// boards twice. The run's own checks used portals.yml as it was when the run
// started, so the writer now reads the file again at the moment of writing.

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'discover-dupes-'));
const file = path.join(dir, 'portals.yml');
writeFileSync(file, 'title_filter:\n  positive: []\n\ntracked_companies:\n'
  + '  - name: "Westinghouse Electric"\n    careers_url: https://westinghouse.wd5.myworkdayjobs.com/External/\n    enabled: true\n'
  + '  - name: "Vicor"\n    careers_url: https://vicorpower.wd1.myworkdayjobs.com/vicor\n    enabled: true\n');
process.env.CAREER_OPS_PORTALS = file;
const { appendToPortals } = await import('./discover-ats.mjs');
const { default: yaml } = await import('js-yaml');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const entry = (n, url) => `  - name: ${JSON.stringify(n)}\n    careers_url: ${url}\n    enabled: true`;
const names = () => yaml.load(readFileSync(file, 'utf8')).tracked_companies.map(c => c.name);

console.log('\n🧪 discover-ats: an entry already tracked is never written twice (F-754)');

const before = readFileSync(file, 'utf8');
let r = appendToPortals(entry('Westinghouse Electric', 'https://westinghouse.wd5.myworkdayjobs.com/External'));
check('same name and careers_url (trailing slash aside): refused', r, { written: [], refused: ['Westinghouse Electric'] });
check('…and the file is untouched, not even a run header', readFileSync(file, 'utf8'), before);

r = appendToPortals(entry('Vicor Corporation', 'https://VICORPOWER.wd1.myworkdayjobs.com/vicor/'));
check('the same board under another name: refused', r.refused, ['Vicor Corporation']);

r = appendToPortals(entry('vicor', 'https://boards.greenhouse.io/vicor'));
check('a name already tracked, on another board: refused', r.refused, ['vicor']);

r = appendToPortals(entry('Sidus Space', 'https://boards.greenhouse.io/sidusspace'));
check('a new board is written', r, { written: ['Sidus Space'], refused: [] });
check('…and is in the file', names().includes('Sidus Space'), true);

r = appendToPortals(entry('Sidus Space', 'https://boards.greenhouse.io/sidusspace'));
check('the same batch replayed: refused the second time', r.refused, ['Sidus Space']);
check('…so it is tracked once', names().filter(n => n === 'Sidus Space').length, 1);

r = appendToPortals([entry('Stryten Energy', 'https://stryten.wd1.myworkdayjobs.com/x'), entry('Vicor', 'https://vicorpower.wd1.myworkdayjobs.com/vicor'),
  entry('Stryten Energy', 'https://stryten.wd1.myworkdayjobs.com/x')].join('\n\n'));
check('a block of several: only the new one, once', r, { written: ['Stryten Energy'], refused: ['Vicor', 'Stryten Energy'] });
const all = names();
check('every name in the file is there once', all.length, new Set(all.map(n => n.toLowerCase())).size);
check('one run header', (readFileSync(file, 'utf8').match(/Auto-discovered by jarvis\/discover-ats\.mjs/g) || []).length, 1);

console.log('\n🧪 discover-ats: the first boards written into a fresh portals.yml (setup\'s `tracked_companies: []`)');
writeFileSync(file, '# Companies Jarvis scans.\ntracked_companies: []\nwatchlist: []\n');
r = appendToPortals(entry('Brex', 'https://boards.greenhouse.io/brex'));
check('written', r, { written: ['Brex'], refused: [] });
let parsed = null;
try { parsed = yaml.load(readFileSync(file, 'utf8')); } catch (e) { parsed = String(e.message).split('\n')[0]; }
check('the file still parses, as a list of one', parsed?.tracked_companies?.map?.(c => c.name), ['Brex']);
check('…and the key after it survives', parsed?.watchlist, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
