// fillStop: which postings the extension's fill stops on (his "1. ye", 2026-11-12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillStop } from './fill-stop.mjs';
import { classifyVisa } from './visa.mjs';

// A job as the store hands it back: the triage's visa reading, and the body.
const job = (title, description) => {
  const v = classifyVisa(title, description);
  return { id: 'j1', title, description, triage: { flags: { hardBlock: !!v.block }, visa: { block: v.block || null } } };
};

test('citizens only: stopped, with the posting\'s own sentence', () => {
  const s = fillStop(job('Mechanical Engineer', 'Design fixtures. Must be a U.S. citizen. No exceptions.'));
  assert.equal(s.reasons.length, 1, JSON.stringify(s));
  assert.match(s.reasons[0], /U\.S\. citizen/);
});

test('an employer that will not sponsor: stopped', () => {
  const s = fillStop(job('Manufacturing Engineer', 'Build lines. Texas Instruments will not sponsor job applicants for visas or work authorization for this position.'));
  assert.equal(s.reasons.length, 1, JSON.stringify(s));
  assert.match(s.reasons[0], /will not sponsor/);
});

test('a U.S. person with no licence route (Bulwark Dynamics): stopped as an export bar', () => {
  const s = fillStop(job('Mechanical Engineer', 'Design brackets. Required: Must be a U.S. Citizen or U.S. Permanent Resident (Green Card holder) eligible to work in an ITAR/EAR-regulated environment.'));
  assert.ok(s.reasons.length >= 1, JSON.stringify(s));
  assert.ok(s.reasons.some((r) => /Green Card holder/.test(r)), JSON.stringify(s));
  // Said once, not as both the block and the export bar.
  assert.equal(new Set(s.reasons.map((r) => r.replace(/^[^"]*/, ''))).size, s.reasons.length);
});

test('a sentence that WELCOMES citizens and green card holders is not a bar (First Mate\'s review)', () => {
  assert.deepEqual(fillStop(job('Mechanical Engineer', 'Design fixtures for wafer handling robots. Sponsorship available. U.S. citizens and green card holders welcome to apply.')).reasons, []);
});

test('the bar is labelled by what it says: an ITAR line is export control, a citizens-or-residents line is not', () => {
  const itar = fillStop(job('Manufacturing Engineer', 'Build fixtures. This position requires access to ITAR-controlled technical data; applicants must be U.S. persons.'));
  assert.equal(itar.reasons.length, 1, JSON.stringify(itar));
  assert.match(itar.reasons[0], /^Export control with no licence route — ".*ITAR/);
  const astranis = fillStop(job('Manufacturing Engineer', 'Build fixtures. U.S. Citizenship, Lawful Permanent Residency, or Refugee/Asylee Status Required.'));
  assert.ok(astranis.reasons.length >= 1, JSON.stringify(astranis));
  assert.ok(!astranis.reasons.some((r) => /^Export control/.test(r)), JSON.stringify(astranis));
});

test('a U.S. person OR a licence the employer obtains (Samsung Austin): NOT stopped', () => {
  const samsung = 'This position may include access to controlled information or technology under U.S. export control laws. Employment may be contingent on either the applicant verifying that the applicant falls under the “U.S. Person” definition (including U.S. citizens, U.S. lawful permanent residents, and those granted U.S. asylum or refugee status) or the employer timely obtaining any necessary export license or other approval.';
  assert.deepEqual(fillStop(job('CVD Equipment Engineer', samsung)).reasons, []);
});

test('a sentence that only defines "U.S. person" (TSMC Arizona): NOT stopped', () => {
  const tsmc = 'This position requires access to export-controlled technology. Non-U.S. Persons may require an export license. U.S. Persons include United States citizens, lawful permanent residents, and persons admitted to the United States as a refugee or granted asylum.';
  assert.deepEqual(fillStop(job('Engineering Full-Time Opportunities', tsmc)).reasons, []);
});

test('the routine export-licence review (Analog Devices): NOT stopped', () => {
  const adi = 'Applicants for this position – except US Citizens, US Permanent Residents, and protected individuals as defined by 8 U.S.C. 1324b(a)(3) – may have to go through an export licensing review process.';
  assert.deepEqual(fillStop(job('Associate Manufacturing Engineer', adi)).reasons, []);
});

test('an ordinary posting: NOT stopped, and read', () => {
  assert.deepEqual(fillStop(job('Mechanical Engineer', 'Design fixtures for wafer handling robots. BS in Mechanical Engineering.')), { reasons: [], read: true });
});

test('his own "never/no" rules are not a fill stop (F-773\'s panel ask covers them)', () => {
  const j = job('Quality Engineer', 'Own the CAPA process. BS in engineering.');
  j.fit = { blockers: ['Breaks your rule "no quality engineer"'] };
  assert.deepEqual(fillStop(j).reasons, []);
});

test('no description: no export reading, said so — a triage block still stops', () => {
  assert.deepEqual(fillStop({ id: 'x', title: 'Mechanical Engineer', description: '' }), { reasons: [], read: false });
  const s = fillStop({ id: 'x', title: 'ME', description: '', triage: { flags: { hardBlock: true }, visa: { block: { reason: 'Requires U.S. citizenship', quote: 'Must be a U.S. citizen.' } } } });
  assert.deepEqual(s, { reasons: ['Requires U.S. citizenship — "Must be a U.S. citizen."'], read: false });
  assert.deepEqual(fillStop(null), { reasons: [], read: false });
});
