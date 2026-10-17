// F-636: discover-ats writes each admitted board the moment it resolves, under
// ONE header per run, so a crash or a memory kill keeps what was found.

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'discover-write-'));
const file = path.join(dir, 'portals.yml');
writeFileSync(file, 'title_filter:\n  positive: []\n\ntracked_companies:\n  - name: "Existing Co"\n    careers_url: https://example.com/jobs\n    enabled: true\n');
process.env.CAREER_OPS_PORTALS = file;
const { appendToPortals } = await import('./discover-ats.mjs');
const { default: yaml } = await import('js-yaml');

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('\n🧪 discover-ats: boards are written as they resolve (F-636)');

const entry = (n) => `  - name: "${n}"\n    careers_url: https://boards.example.com/${n.toLowerCase()}\n    enabled: true`;
appendToPortals(entry('First'));
const afterOne = readFileSync(file, 'utf8');
check('the first board is on disk before the run ends', yaml.load(afterOne).tracked_companies.map(c => c.name), ['First', 'Existing Co']);

appendToPortals(entry('Second'));
appendToPortals(entry('Third'));
const src = readFileSync(file, 'utf8');
const names = yaml.load(src).tracked_companies.map(c => c.name);
check('every later board is kept and the file still parses', names.length, 4);
check('the existing entry is untouched', names.includes('Existing Co'), true);
check('one header for the whole run, not one per board', (src.match(/Auto-discovered by jarvis\/discover-ats\.mjs/g) || []).length, 1);
check('later boards sit under the run header, above older entries',
  src.indexOf('Auto-discovered') < src.indexOf('"Second"') && src.indexOf('"First"') < src.indexOf('"Existing Co"'), true);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
