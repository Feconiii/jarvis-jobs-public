// Tests for disabling a wrongly tracked company. The cases are the ways it
// actually went wrong by hand on 2026-09-20.

import { disableEntry } from './disable-board.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

const entry = (name, nl, extra = '') => [`  - name: "${name}"`, `    careers_url: https://x/${name.toLowerCase()}`, `    notes: "Auto-discovered."`, ...(extra ? [extra] : []), '    enabled: true', ''].join(nl);

console.log('\n🧪 disable-board: the entry is kept, turned off, and says why');
{
  const src = `tracked_companies:\n${entry('Tapestry', '\n')}\n${entry('Matic Robots', '\n')}`;
  const r = disableEntry(src, 'Tapestry', 'Coach retail, not engineering');
  check('changed', r.changed, true);
  check('the entry is still there — that is what keeps the name taken', /name: "Tapestry"/.test(r.text), true);
  check('it is off', /name: "Tapestry"[\s\S]*?enabled: false/.test(r.text), true);
  check('the reason is on it', /notes: "Coach retail, not engineering — disabled \d{4}-\d\d-\d\d\. Auto-discovered\."/.test(r.text), true);
  check('the NEXT company is untouched', /name: "Matic Robots"[\s\S]*?enabled: true/.test(r.text), true);
  check('exactly one entry was turned off', (r.text.match(/enabled: false/g) || []).length, 1);
}

console.log('\n🧪 disable-board: mixed line endings (the failure that disabled nothing)');
{
  // The file is CRLF; discover-ats appended this block with LF.
  const src = `tracked_companies:\r\n${entry('Old Co', '\r\n')}\r\n${entry('ICON', '\n')}`;
  const r = disableEntry(src, 'ICON', 'ICON plc, clinical research');
  check('an LF block inside a CRLF file is still found', r.changed, true);
  check('and turned off', /name: "ICON"[\s\S]*?enabled: false/.test(r.text), true);
  check('the CRLF entry beside it keeps its endings', /name: "Old Co"\r\n/.test(r.text), true);
  const crlf = disableEntry(`tracked_companies:\r\n${entry('Sodexo', '\r\n')}`, 'Sodexo', 'catering');
  check('a CRLF entry works too', /enabled: false\r\n/.test(crlf.text), true);
}

console.log('\n🧪 disable-board: it refuses to guess');
{
  const src = `tracked_companies:\n${entry('Figure AI', '\n')}`;
  check('a name that is only a PREFIX of a tracked one is not a match', disableEntry(src, 'Figure', 'x').reason, 'not-found');
  check('an unknown name', disableEntry(src, 'Nope', 'x').reason, 'not-found');
  const once = disableEntry(src, 'Figure AI', 'test');
  check('disabling twice changes nothing the second time', disableEntry(once.text, 'Figure AI', 'again').reason, 'already-disabled');
  const bare = `tracked_companies:\n  - name: "Bare"\n    careers_url: https://x\n    enabled: true\n`;
  const b = disableEntry(bare, 'Bare', 'no notes line here');
  check('an entry with no notes line gets one', /notes: "no notes line here — disabled [\d-]+\."\n    enabled: false/.test(b.text), true);
  check('a quote in the reason cannot break the YAML', /notes: "it's 'wrong' —/.test(disableEntry(bare, 'Bare', 'it\'s "wrong"').text), true);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
