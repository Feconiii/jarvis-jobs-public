import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setVerdict, getVerdict, listVerdicts, personKey, companyKey } from './lead-verdicts.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'verdicts-'));
const dbPath = path.join(dir, 'outreach.db');
test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handle on Windows */ } });

test('a rejection keeps its reason, and is found again by name or by profile', () => {
  setVerdict({ company: 'Amazon', name: 'Owen Price', status: 'rejected', reason: 'stale hiring evidence', label: 'org-specific', note: 'post 2026-04-27' }, { dbPath });
  const byName = getVerdict({ company: 'amazon', name: 'Owen Price' }, { dbPath });
  assert.equal(byName.reason, 'stale hiring evidence');
  setVerdict({ company: 'Amazon', name: 'Owen Price', profile: 'https://www.linkedin.com/in/owen-price-0000/', status: 'possible', label: 'org-specific', reason: 'headline says Hiring for RDPI' }, { dbPath });
  assert.equal(listVerdicts('Amazon', { dbPath }).length, 1, 'name row and profile row are one person');
  assert.equal(getVerdict({ company: 'Amazon', profile: 'https://www.linkedin.com/in/owen-price-0000' }, { dbPath }).status, 'possible');
});

test('a rejection without a reason is refused; unknown labels too', () => {
  assert.throws(() => setVerdict({ company: 'Hyve', name: 'Drew Mason', status: 'rejected' }, { dbPath }), /reason/);
  assert.throws(() => setVerdict({ company: 'Hyve', name: 'X', status: 'strong', label: 'friend' }, { dbPath }), /label/);
});

test('companies and people are matched loosely: "Hyve Solutions" is "Hyve"', () => {
  assert.equal(companyKey('Hyve Solutions'), companyKey('HYVE'));
  assert.equal(personKey({ name: 'Priya N', profile: 'https://www.linkedin.com/in/PriyaNair1/' }), 'in:priyanair1');
  setVerdict({ company: 'Hyve Solutions', name: 'Drew Mason', status: 'rejected', reason: 'executive' }, { dbPath });
  assert.equal(getVerdict({ company: 'Hyve', name: 'drew mason' }, { dbPath }).reason, 'executive');
  assert.equal(getVerdict({ company: 'Hyve', name: 'Nobody' }, { dbPath }), null);
});
