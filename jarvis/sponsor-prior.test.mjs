// jarvis/sponsor-prior.test.mjs — the employer's H-1B record as a prior (F-982).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sponsorPrior, priorWeight, byFitThenPrior } from './sponsor-prior.mjs';
import { h1bPetitions } from './curate.mjs';

const ledger = { Micron: 1561, 'Acme Robotics': 0 };
const petitions = (c) => (c in ledger ? ledger[c] : 0);

test('the record comes from the ledger', () => {
  assert.deepEqual(sponsorPrior({ company: 'Micron' }, petitions), { petitions: 1561 });
  assert.deepEqual(sponsorPrior({ company: 'Acme Robotics' }, petitions), { petitions: 0 });
});

test('no ledger, no prior', () => {
  assert.equal(sponsorPrior({ company: 'Micron' }, () => null), null);
});

test('the posting\'s own words overrule the employer\'s history', () => {
  const blocked = sponsorPrior({ company: 'Micron', triage: { flags: { hardBlock: true } } }, petitions);
  assert.ok(blocked.overruled && priorWeight(blocked) === 0);
  const caution = sponsorPrior({ company: 'Micron', triage: { flags: { visaWarning: true } } }, petitions);
  assert.ok(caution.overruled && priorWeight(caution) === 0);
});

test('a tie-breaker only: fit first, then the record among equal fits, then the store\'s order', () => {
  const rows = [
    { id: 'a', fit: { score: 90 }, sponsorPrior: { petitions: 0 } },
    { id: 'b', fit: { score: 90 }, sponsorPrior: { petitions: 500 } },
    { id: 'c', fit: { score: 95 }, sponsorPrior: { petitions: 0 } },
    { id: 'd', fit: { score: 90 }, sponsorPrior: { petitions: 900, overruled: 'block' } },
    { id: 'e', fit: { score: 90 }, sponsorPrior: null },
  ];
  assert.deepEqual(byFitThenPrior(rows).map((r) => r.id), ['c', 'b', 'a', 'd', 'e']);
});

test('the card\'s count is the Department\'s engineering petitions over the employer\'s own filers', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { dolPetitions } = await import('./sponsor-prior.mjs');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-dol-')), 'jobs.db');
  const h = new DatabaseSync(file);
  h.exec('CREATE TABLE lca_employers (key TEXT, name TEXT, eng_certified INTEGER)');
  const put = h.prepare('INSERT INTO lca_employers VALUES (?,?,?)');
  for (const [n, c] of [['Cisco Systems, Inc.', 126], ['Amazon.com Services LLC', 280], ['Amazon Data Services, Inc', 363], ['Apple Inc.', 1417], ['Apple Hospitality REIT', 3], ['Micron Technology, Inc.', 232]]) put.run(n.toLowerCase(), n, c);
  h.close();
  const f = dolPetitions(file);
  assert.deepEqual(['Cisco', 'Amazon', 'Apple', 'Micron Technology', 'NASA Jet Propulsion Laboratory'].map(f), [126, 280, 1417, 232, 0]);
  assert.equal(dolPetitions('C:/no/such/file.db')('Apple'), null, 'no disclosure file: no prior');
});

test('the ledger lookup takes the employer\'s own legal name, not a name that contains it (review, 2026-11-04)', () => {
  const rows = [{ name: 'Micron Technology Inc', evidence: 1500 }, { name: 'Micron Technology Utah LLC', evidence: 61 }, { name: 'Other Co', evidence: 9 },
    { name: 'Apple', evidence: 5159 }, { name: 'Apple Hospitality REIT', evidence: 3 }, { name: 'Green Apple Capital', evidence: 2 },
    { name: 'Block, Inc.', evidence: 40 }, { name: 'Blockchain Co', evidence: 5 }, { name: 'Meta Platforms', evidence: 900 }, { name: 'Metamaterial Inc', evidence: 4 },
    { name: 'AMERICAN HONDA MOTOR', evidence: 304 }, { name: 'Supermicro', evidence: 50 }, { name: 'California Institute of Technology', evidence: 80 }];
  assert.equal(h1bPetitions('Micron Technology', rows), 1500, 'a site subsidiary is not the employer');
  assert.equal(h1bPetitions('Apple', rows), 5159, 'not Apple Hospitality, not Green Apple Capital');
  assert.equal(h1bPetitions('Block', rows), 40, 'not Blockchain Co');
  assert.equal(h1bPetitions('Meta', rows), 0, 'a four-letter name takes only itself, not Metamaterial');
  assert.equal(h1bPetitions('American Honda Motor Company, Inc.', rows), 304, 'legal words dropped');
  assert.equal(h1bPetitions('Super Micro', rows), 50, 'the same letters with spaces dropped');
  assert.equal(h1bPetitions('NASA Jet Propulsion Laboratory', rows), 0, 'a parent filing for its lab is not guessed');
  assert.equal(h1bPetitions('Nobody Corp', rows), 0);
});

test('the links that set sponsors_h1b use the card\'s own rule, the largest filer first (review, 2026-11-04)', async () => {
  const { filerLinks } = await import('./sponsor-prior.mjs');
  const loaded = [{ key: 'cisco systems', name: 'Cisco Systems, Inc.', certified: 300 }, { key: 'apple', name: 'Apple Inc.', certified: 5000 },
    { key: 'apple hospitality', name: 'Apple Hospitality REIT', certified: 9 }, { key: 'amazon com services', name: 'Amazon.com Services LLC', certified: 900 },
    { key: 'amazon', name: 'Amazon', certified: 10 }, { key: 'supermicro', name: 'Supermicro', certified: 40 }];
  const m = filerLinks(['Cisco', 'Apple', 'Amazon', 'Super Micro', 'NASA Jet Propulsion Laboratory'], loaded);
  assert.deepEqual(['Cisco', 'Apple', 'Amazon', 'Super Micro', 'NASA Jet Propulsion Laboratory'].map((c) => m.get(c).key),
    ['cisco systems', 'apple', 'amazon com services', 'supermicro', '']);
});
