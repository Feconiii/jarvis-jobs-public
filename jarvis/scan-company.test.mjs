// jarvis/scan-company.test.mjs — which employer a scanned posting is filed under.
// Run: node jarvis/scan-company.test.mjs
import { companyOf } from './scan.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ✅ ${name}`); return; }
  fail++; console.log(`  ❌ ${name}\n    expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
};
const sib = { name: 'Astera Labs (Early Career - North America 2027)', company: 'Astera Labs' };
eq('a sibling board files under its employer when the provider echoes the entry name', companyOf(sib, { company: sib.name }), 'Astera Labs');
eq('…or reports nothing', companyOf(sib, {}), 'Astera Labs');
eq('a provider that names the posting\'s own employer is believed (aggregator)', companyOf({ name: 'Some Board', company: 'Some Board' }, { company: 'Client Co' }), 'Client Co');
eq('an ordinary entry is its own name', companyOf({ name: 'Acme' }, { company: 'Acme' }), 'Acme');
console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
