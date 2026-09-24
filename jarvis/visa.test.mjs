#!/usr/bin/env node
// jarvis/visa.test.mjs — the work-authorization corpus.
//
// This file is deliberately shaped as a CORPUS rather than as unit tests,
// because that is what keeps visa.mjs sustainable. When an employer words a
// refusal in some way nobody anticipated, the fix is to paste the sentence in
// here as one row and run it. If the clause/negation model already handles it —
// which is the whole bet — the row goes green with no code change at all. Only
// when a row stays red does anything in visa.mjs get touched, and then it gets
// touched at the LAYER that failed, not by bolting another alternative onto a
// regex.
//
// Half of the sentences below were never enumerated anywhere in the source.
// They pass because negation in English is a closed class and the classifier
// models that instead of memorising phrasings. That property is the thing under
// test here; individual verdicts are just how it is measured.
//
// The two directions are NOT symmetric, and the file is organised around that:
//   · blocking a job that would sponsor    → he never sees it. Unacceptable.
//   · showing a job that will not sponsor  → he reads a sentence and moves on.
// So every ambiguous case is asserted to SHOW.
//
// Run: `node jarvis/visa.test.mjs` (exit 1 on any failure).

import { classifyVisa, _internals } from './visa.mjs';

let pass = 0, fail = 0;
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}
const blockKey = (d, t = '') => { const v = classifyVisa(t, d); return v.block ? v.block.key : null; };
const keys = (d, t = '') => classifyVisa(t, d).warnings.map(w => w.key).sort();

// ── 1. must NOT block ───────────────────────────────────────────────
//
// The first row is the regression that prompted the rewrite: widening a
// character window from 40 to 90 let "do not" reach across a comma into the
// next clause, and a posting advertising H-1B sponsorship became a hard block.
console.log('🧪 visa: sponsor-friendly postings stay in the deck');
const FRIENDLY = [
  'We do not discriminate on any protected basis, and we proudly sponsor H-1B and green card applications.',
  'We do not offer relocation assistance for this role, but we are happy to sponsor visas for qualified candidates.',
  'Visa sponsorship is available for this position.',
  'Sponsorship is offered for exceptional candidates.',
  'We sponsor qualified candidates for H-1B and green card.',
  'We are willing to sponsor work visas for this role.',
  'There is no cost to relocate and no requirement to travel. Sponsorship is available.',
  'Relocation is not provided. Visa sponsorship is provided.',
  'Candidates on STEM OPT are welcome to apply.',
  'This role is eligible for visa sponsorship.',
];
for (const d of FRIENDLY) check(`no block: ${d.slice(0, 58)}…`, blockKey(d), null);

console.log('🧪 visa: the non-visa senses of the same words');
// "Sponsor" is one word with two unrelated meanings, separated only by what it
// takes as an object. The old classifier read the charitable one as a promise
// to sponsor visas.
check('charitable sponsorship is not visa sponsorship', blockKey('Generous 401(K) plan with no delayed vesting. We proudly sponsor community events.'), null);
check('…and does not earn the green badge either', keys('We proudly sponsor community events and local robotics teams.'), ['sponsorship_unmentioned']);
check('a proud sponsor OF something is the charitable sense', blockKey('We are a proud sponsor of the FIRST Robotics League.'), null);
check('both senses in one sentence, resolved separately', blockKey('Acme does not sponsor sports teams, but visa sponsorship is available.'), null);
// The mirror of the above: an object-LESS refusal is still the visa sense,
// because no job posting says "we are unable to sponsor" about a charity.
check('object-less refusal still blocks', blockKey('We cannot sponsor at this time, however we welcome referrals.'), 'no_sponsorship');
check('object-less refusal, shortest form', blockKey('We are not able to sponsor.'), 'no_sponsorship');
check('mechanical "clearance" is not a security clearance', blockKey('Ensure proper tip clearance and clearance fit on rotating assemblies.', 'Design Engineer'), null);
check('"opt out" is not OPT', keys('You may opt out of marketing emails at any time. Also opt-in available.'), ['sponsorship_unmentioned']);
check('export-control screening alone does not block', blockKey('This role may be subject to export control screening but we welcome all applicants.'), null);

console.log('🧪 visa: EEO boilerplate states no policy');
// EEO text is a legally-mandated genre that names citizenship and visa terms
// while requiring nothing. It also contains "not" by construction, which is
// exactly what a negation-driven classifier trips over.
check('EEO citizenship clause', keys('All qualified applicants receive consideration without regard to race, religion, or citizenship status.', 'Engineer'), ['sponsorship_unmentioned']);
check('EEO does not suppress a real refusal in the same posting',
  blockKey('Acme is an equal opportunity employer and does not discriminate on the basis of citizenship status. Acme is not able to provide immigration sponsorship for this position.'),
  'no_sponsorship');

// ── 2. must block ───────────────────────────────────────────────────
//
// Rows marked ✱ use verbs that appear NOWHERE in visa.mjs. They are the point:
// the classifier finds them through negation + topic, not through recognition.
console.log('🧪 visa: refusals, including phrasings the source never enumerates');
const REFUSALS = [
  ['Eaton will not consider applicants for employment immigration sponsorship or support for this position.', 'no_sponsorship'],
  ['We are unable to provide visa sponsorship for this role.', 'no_sponsorship'],
  ['This position is not eligible for Intel immigration sponsorship.', 'no_sponsorship'],
  ['Entegris does not provide immigration-related sponsorship for this role.', 'no_sponsorship'],
  ['However, we are not able to sponsor visas for this position.', 'no_sponsorship'],
  ['No visa sponsorship is provided.', 'no_sponsorship'],
  ['Visa sponsorship is not available at this time.', 'no_sponsorship'],
  ['Please note that we cannot offer H-1B sponsorship.', 'no_sponsorship'],
  ['You must not need sponsorship (e.g., H1B, TN, STEM OPT) now or in the future.', 'no_sponsorship'],
  ['The company declines to support work visas of any kind.', 'no_sponsorship'],                    // ✱ "declines"
  ['Our organization is precluded from offering immigration sponsorship.', 'no_sponsorship'],       // ✱ "precluded"
  ['Sponsorship is neither offered nor available for this requisition.', 'no_sponsorship'],         // ✱ "neither/nor"
  ['Candidates who require visa sponsorship will not be considered.', 'no_sponsorship'],            // ✱ relative clause
  ['If you require sponsorship now or in the future, we are unable to move forward.', 'no_sponsorship'], // ✱ conditional
  ['Applicants must be authorized to work in the US on a permanent basis without sponsorship.', 'perm_authorization'],
  ['Applicants must be authorized to work for any employer in the U.S. without sponsorship.', 'perm_authorization'],
  ['Applicants must be a U.S. citizen. No exceptions.', 'us_citizen'],
  ['Must hold an active TS/SCI clearance with polygraph.', 'clearance'],
];
for (const [d, want] of REFUSALS) check(`block: ${d.slice(0, 58)}…`, blockKey(d), want);

console.log('🧪 visa: citizen-only and U.S.-person are labelled apart');
// A bare citizenship demand still hides the job — nothing he or an employer can
// file changes it. A U.S.-PERSON list does not, because that is export-control
// paperwork and he has been through it once already. The two must stay
// distinguishable, which is why the coordinated list is read at sentence scope
// and never clause-split: reading only its first fragment would report an ITAR
// clause as a citizenship demand and hide a job it should merely flag.
check('bare citizenship demand → us_citizen', blockKey('This position requires the candidate to be a U.S. citizen.'), 'us_citizen');

// THE ABBREVIATION THAT DECIDES IT. Since export control stopped blocking, the
// two labels have opposite consequences, so a shortened "Perm Resident" that
// fails to register as an alternative turns a screening question into a
// citizenship demand and hides the posting. This is Greenhouse's real form
// label, typo included.
check('"Perm Resident" is an alternative, so this does not block',
  blockKey('Are you either a US Citizen or a Perm Resident)?'), null);
check('…and it is flagged as the export-control question it is',
  keys('Are you either a US Citizen or a Perm Resident)?').includes('us_person'), true);
check('the 8 U.S.C. 1324b question does not block either',
  blockKey('Are you a U.S. citizen, a U.S. lawful permanent resident (i.e. green card holder), or a protected individual under 8 U.S.C. Sec. 1324b?'), null);

// ── export control never hides a job (2026-09-19) ───────────────────
//
// It used to, in two tiers, until it cost him nine real postings in an
// afternoon — Radiant's four 2027 new-grad reqs and five Vast reqs with 0–2
// year bars. He has held an export-controlled role before; employers file the
// paperwork. So every tier below reports the sentence and leaves the job in.
console.log('🧪 visa: export control is a caution carrying the sentence, never a block');

const ITAR_LIST = 'To conform to U.S. Government space technology export regulations, including the International Traffic in Arms Regulations (ITAR), employees must be a U.S. citizen, lawful permanent resident of the U.S., or protected individual.';
check('ITAR U.S.-person list no longer blocks', blockKey(ITAR_LIST), null);
check('…it warns instead, and says which wording it saw', keys(ITAR_LIST).includes('us_person'), true);
check('…and the warning carries the sentence he has to read',
  classifyVisa('', ITAR_LIST).warnings.find(w => w.key === 'us_person')?.quote, ITAR_LIST);

const CONTINGENT = 'This role requires access to U.S. export-controlled information. If applicable, final offers will be contingent on ability to obtain authorization for access to U.S. export-controlled information from the U.S. Government.';
check('an offer contingent on export authorization no longer blocks', blockKey(CONTINGENT), null);
check('…it warns as export_authorization', keys(CONTINGENT).includes('export_authorization'), true);
check('…and the generic EAR badge is not stacked on top of it', keys(CONTINGENT).includes('export_control'), false);

check('"must be able to obtain an export license" warns, does not block',
  blockKey('Candidates must be able to obtain an export license where required.'), null);
check('ASML: controlled technology under the EAR → no block',
  blockKey('This position requires access to controlled technology, as defined in the United States Export Administration Regulations (15 C.F.R. § 730, et seq.). Qualified candidates must be legally authorized to access such controlled technology prior to beginning work.'),
  null);
check('…but it is badged', keys('This position requires access to controlled technology, as defined in the United States Export Administration Regulations (15 C.F.R. § 730, et seq.).').includes('export_control'), true);
check('a screening mention is still only a badge', blockKey('This position may be subject to export control screening.'), null);

// ── the U.S.-person DEFINITION is not a sponsorship policy (2026-09-19) ──
//
// Export-control paragraphs close by spelling out who qualifies. That sentence
// contains "green card" (a work-authorization noun) and "not pending" (a
// negation cue), so it read as an outright refusal to sponsor. Vast's whole
// board — 202 postings, including 0-2 year reqs at $86-122K — was hard-blocked
// as `no_sponsorship` on a sentence stating no policy whatsoever.
const VAST = 'EXPORT CONTROL COMPLIANCE STATUS. The person hired will have access to information and items subject to U.S. export controls, and therefore, must either be a "U.S. person" as defined by 22 C.F.R. 120.62. This status includes U.S. citizens, U.S. nationals, lawful permanent residents (green card holders), and asylees and refugees with such status granted, not pending.';
check('the definition does not block', blockKey(VAST), null);
check('…it is reported as the export-control clause it is', keys(VAST).includes('us_person'), true);
check('…and not as a sponsorship refusal', keys(VAST).includes('no_sponsorship'), false);
// The over-correction to guard against: a real refusal standing next to the
// same boilerplate must still block.
check('a real refusal beside the definition still blocks',
  blockKey('This status includes U.S. citizens and lawful permanent residents. We do not provide visa sponsorship for this role.'),
  'no_sponsorship');
check('a refusal that names H-1B beside it still blocks',
  blockKey('U.S. person as defined by 22 C.F.R. 120.62. We will not sponsor H-1B candidates.'),
  'no_sponsorship');

// The one that must NOT slip through the widening: a clearance is not paperwork
// an employer can file for an F-1, so an ITAR sentence sitting next to one still
// leaves the job hidden.
check('export control beside a clearance still blocks on the clearance',
  blockKey('Due to ITAR requirements the applicant must be a U.S. person, and this position requires an active Secret clearance.'),
  'clearance');

// ── 3. contradictions show, never hide ──────────────────────────────
console.log('🧪 visa: a posting that says both things is shown, not hidden');
{
  const v = classifyVisa('', 'We are not able to sponsor employment visas for this role. Sponsorship is available for candidates with exceptional experience.');
  check('no hard block on conflicting evidence', v.block, null);
  check('flagged as a conflict instead', v.warnings.map(w => w.key), ['visa_conflict']);
  check('conflict is a caution, so the row badges "verify"', v.warnings[0].level, 'caution');
  check('and carries BOTH sentences', v.warnings[0].quote.includes('not able') && v.warnings[0].quote.includes('is available'), true);
  check('never advertised as sponsor-friendly', v.warnings.some(w => w.key === 'sponsorship_positive'), false);
}

// ── 4. evidence ─────────────────────────────────────────────────────
console.log('🧪 visa: every verdict carries its exact source sentence');
{
  const v = classifyVisa('', 'This position requires the candidate to be a U.S. citizen. Other duties apply.');
  check('quote is verbatim and not cut at the "U.S." abbreviation', v.block.quote, 'This position requires the candidate to be a U.S. citizen.');
}
{
  const v = classifyVisa('', 'We build robots. Acme cannot sponsor work visas for this req. Apply today.');
  check('quote is the refusing sentence, not the paragraph', v.block.quote, 'Acme cannot sponsor work visas for this req.');
}

// ── 5. OPT / CPT / F-1 ──────────────────────────────────────────────
console.log('🧪 visa: naming OPT is not welcoming OPT');
check('positive OPT mention', keys('Candidates on STEM OPT are welcome to apply.').includes('opt_ok'), true);
check('negative OPT mention is never reported as friendly', keys('We will not support any CPT, OPT, or H-1B candidates.').includes('opt_ok'), false);
check('…it is reported as a caution', keys('We will not support any CPT, OPT, or H-1B candidates.').includes('opt_negative'), true);

// ── 6. silence ──────────────────────────────────────────────────────
console.log('🧪 visa: silence is reported as silence');
check('posting says nothing either way', keys('Build fixtures for the line.', 'Manufacturing Engineer'), ['sponsorship_unmentioned']);
check('silence never blocks', blockKey('Build fixtures for the line.', 'Manufacturing Engineer'), null);

// ── 7. the mechanism itself ─────────────────────────────────────────
//
// Asserted directly so that when a corpus row above goes red, the failure
// points at the layer that mishandled it rather than at the verdict.
console.log('🧪 visa: segmentation and polarity, tested at the layer');
const { splitSentences, splitClauses, sponsorshipPolarity } = _internals;
check('"U.S." does not end a sentence', splitSentences('Must be a U.S. citizen. Apply now.').length, 2);
check('punctuated coordinator opens a clause',
  splitClauses('We do not discriminate on any basis, and we proudly sponsor H-1B applications.').length, 2);
check('coordinated NOUNS are left intact — the negation must keep reaching "sponsorship"',
  splitClauses('We do not provide relocation and sponsorship.').length, 1);
check('…so that clause is still a refusal', sponsorshipPolarity('We do not provide relocation and sponsorship.'), 'negative');
check('a comma before "or" is a LIST, not a clause break — the negation must still reach "H-1B"',
  splitClauses('We will not support any CPT, OPT, or H-1B candidates.').length, 1);
check('…but a noun subject with a finite verb after "and" IS a clause',
  splitClauses('Relocation is not provided and visa sponsorship is available.').length, 2);
check('relative pronoun opens a clause', splitClauses('Candidates who require sponsorship will not be considered.').length, 2);
check('negation beats an affirmative-looking verb in the same clause',
  sponsorshipPolarity('we are not able to sponsor visas'), 'negative');
check('a bare mention is neither yes nor no', sponsorshipPolarity('This req has a sponsorship code of 42'), 'mention');
check('no work-authorization topic at all', sponsorshipPolarity('We sponsor the local marathon'), null);

console.log('🧪 visa: hyphenated negation ("un-able")');
// Found by running this classifier over the live store: Baxter writes "un-able",
// and the hyphen makes a word boundary, so the affirmative pattern "able to
// sponsor" matched INSIDE the negation and reported a refusal as sponsor-
// friendly. That is the inversion this module exists to prevent, so both halves
// are defended — the cue now tolerates the hyphen, and the affirmative pattern
// can no longer start mid-word.
check('un-able to sponsor is a refusal, not an offer',
  blockKey('Applicants must be authorized to work for any employer in the U.S. We are un-able to sponsor or take over sponsorship of an employment visa at this time.'),
  'perm_authorization');
check('…and does not surface as a conflict either',
  keys('Applicants must be authorized to work for any employer in the U.S. We are un-able to sponsor an employment visa.').includes('visa_conflict'), false);
check('spaced form', blockKey('We are un able to sponsor an employment visa.'), 'no_sponsorship');
check('un-willing', blockKey('Acme is un-willing to sponsor visas.'), 'no_sponsorship');
check('the genuine affirmative still reads positive',
  keys('We are able to sponsor an employment visa.'), ['sponsorship_positive']);

console.log('🧪 visa: phrasings found by replaying the live store');
// Both of these were verdict CHANGES when the new classifier was run over
// 125,000 stored postings, and both are correct.
check('Intel: "not open to ... sponsorship" — the old character window missed it',
  blockKey('This position is not open to an Intel immigration sponsorship.'), 'no_sponsorship');
check('ASML: "without the need for" carries the negation',
  blockKey('You must be work authorized in the United States without the need for employer sponsorship.'), 'no_sponsorship');
check('E-Verify names USCIS — an agency name is not a citizenship requirement',
  blockKey("E-Verify Program Participant: Copart participates in the Department of Homeland Security U.S. Citizenship and Immigration Services' E-Verify program (For U.S. applicants and employees only)."),
  null);

console.log('🧪 visa: "the right to work" has a second sense (F-405)');
// Read off the Agility Robotics posting he had already filled in, 2026-09-08.
// The whole description was one sentence away from hard-blocking a job that
// scores 100 for him: the EEO paragraph says every individual "has the right
// to work in a professional atmosphere", the classifier read "right to work"
// as work authorization, found "prohibits" nearby, and called it a refusal to
// sponsor. Blocking a job he wants is the unacceptable direction.
check('EEO boilerplate is not a refusal to sponsor',
  blockKey('Each individual has the right to work in a professional atmosphere that promotes equal employment opportunities and prohibits unlawful discriminatory practices, including harassment.'),
  null);
check('…nor is the same sentence about an environment',
  blockKey('Every employee has the right to work in an environment free from discrimination and harassment.'), null);
check('…and "equal employment opportunities" is the same boilerplate as the singular',
  blockKey('We provide equal employment opportunities to all employees and applicants without regard to citizenship status.'), null);
// The employment sense still blocks, which is the whole point of keeping it.
check('the employment sense still reads as a refusal',
  blockKey('Applicants must have the legal right to work in the United States without sponsorship now or in the future.'), 'perm_authorization');
// "Unrestricted right to work" is itself the disqualifier, so that is the
// block that is named; the refusal after it says the same thing again.
check('…and so does the plainest form of it',
  blockKey('Candidates must have the unrestricted right to work in the US; we do not sponsor visas.'), 'perm_authorization');
check('a bare refusal on its own is still named as one',
  blockKey('We do not sponsor visas for this role.'), 'no_sponsorship');

// ── the three senses that were costing him postings (F-451) ─────────
//
// Found 2026-09-10 by auditing what sentence actually fired each of the 6,879
// readable `no_sponsorship` blocks in the store. 219 of them — 3.2% — were
// fired by a sentence that does not say the employer will not sponsor.
console.log('🧪 visa: a hedge, a benefits plan and a travel document are not refusals');

// 140 postings, most of them Amgen. "Not guaranteed" negates the PROMISE.
check('"not guaranteed" is a maybe, not a refusal',
  blockKey('Sponsorship for this role is not guaranteed.'), null);
check('…and it says so out loud rather than going quiet',
  keys('Sponsorship for this role is not guaranteed.').includes('sponsorship_hedged'), true);
check('…the future-conversion wording too',
  blockKey('Sponsorship for future FTE roles is not guaranteed.'), null);
check('…and "no guarantee" said the other way round',
  blockKey('There is no guarantee of visa sponsorship for this position.'), null);
// A hedge must never upgrade into the green badge either.
check('a hedge is not a promise',
  keys('Sponsorship for this role is not guaranteed.').includes('sponsorship_positive'), false);
// …and a hedge sitting beside a real refusal loses to the refusal.
check('a refusal in the same posting still wins',
  blockKey('Sponsorship is not guaranteed. This role is not eligible for visa sponsorship.'), 'no_sponsorship');

// 73 postings, 68 of them GE Aerospace, on ERISA benefits boilerplate.
check('the benefits-plan "Sponsor" is not an immigration sponsor',
  blockKey("No individual has a vested right to any benefit under a Sponsor's welfare benefit plan or program."), null);
check('…and stays silent rather than warning about nothing',
  keys("No individual has a vested right to any benefit under a Sponsor's welfare benefit plan or program."), ['sponsorship_unmentioned']);
check('…but a real refusal in a benefits paragraph still blocks',
  blockKey('Benefits are governed by the plan sponsor. We will not sponsor an employment visa for this role.'), 'no_sponsorship');

// 6 postings, Veeva and GE Vernova: the travel sense of "visa".
check('a travel visa is not work authorization',
  blockKey('The ability to travel domestically and abroad is required (VISA not being handled by Veeva).'), null);
check('…and a refusal to sponsor survives a travel requirement',
  blockKey('This role requires travel abroad. We are unable to sponsor work visas.'), 'no_sponsorship');
check('…as does one naming immigration in the travel sentence',
  blockKey('Frequent travel is required and we do not provide immigration sponsorship.'), 'no_sponsorship');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
