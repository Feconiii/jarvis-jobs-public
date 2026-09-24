#!/usr/bin/env node
// jarvis/triage.test.mjs — golden tests for the triage classifier.
//
// Every case here is a REAL pattern from live postings that either worked or
// (more often) was a bug found via dashboard screenshots. Filter fixes must
// keep this green: `node jarvis/triage.test.mjs` (exit 1 on any failure).

import { classifyVisa, classifyExperience, classifyLocation, classifyRoleKind, scoreRelevance, triage, classifyProgram, graduationWindow } from './triage.mjs';
import { optionMatches } from './apply/_form.mjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

// ── visa: hard blocks ───────────────────────────────────────────────
const block = (t, d) => { const v = classifyVisa(t, d); return v.block ? v.block.key : null; };

eq('citizen-only requirement', block('', 'Applicants must be a U.S. citizen. No exceptions.'), 'us_citizen');
// Export control stopped hiding jobs on 2026-09-19 — he has held an
// export-controlled role before, so an ITAR clause is a recruiter question and
// the posting stays in the deck carrying its sentence. See jarvis/visa.mjs.
eq('ITAR us-person (Rocket Lab wording) no longer blocks', block('', 'To conform to U.S. Government space technology export regulations, including the International Traffic in Arms Regulations (ITAR), employees must be a U.S. citizen, lawful permanent resident of the U.S., or protected individual.'), null);
eq('explicit US person no longer blocks', block('', 'Must be a U.S. Person as defined by ITAR.'), null);
eq('TS/SCI clearance', block('', 'Must hold an active TS/SCI clearance with polygraph.'), 'clearance');
eq('no sponsor — unable to provide', block('', 'We are unable to provide visa sponsorship for this role.'), 'no_sponsorship');
eq('no sponsor — Intel wording', block('', 'This position is not eligible for Intel immigration sponsorship.'), 'no_sponsorship');
eq('no sponsor — Entegris wording', block('', 'Entegris does not provide immigration-related sponsorship for this role.'), 'no_sponsorship');
eq('no sponsor — BD wording', block('', 'However, we are not able to sponsor visas for this position.'), 'no_sponsorship');
eq('no sponsor — "No visa sponsorship is provided"', block('', 'No visa sponsorship is provided.'), 'no_sponsorship');
eq('perm authorization', block('', 'Applicants must be authorized to work in the US on a permanent basis without sponsorship.'), 'perm_authorization');

// ── visa: must NOT block ────────────────────────────────────────────
eq('benefits "no delayed vesting" trap', block('', 'Generous 401(K) plan with no delayed vesting. We proudly sponsor community events.'), null);
eq('sponsorship available', block('', 'Visa sponsorship is available for this position.'), null);
eq('export-control screening only', block('', 'This role may be subject to export control screening but we welcome all applicants.'), null);
eq('mechanical clearance term', block('Design Engineer', 'Ensure proper tip clearance and clearance fit on rotating assemblies.'), null);

// ── visa: warnings ──────────────────────────────────────────────────
const warns = (t, d) => classifyVisa(t, d).warnings.map(w => w.key).sort();
eq('silent posting → unmentioned warning', warns('Manufacturing Engineer', 'Build fixtures for the line.'), ['sponsorship_unmentioned']);
eq('opt-in/out privacy text is NOT OPT-friendly', warns('', 'You may opt out of marketing emails at any time. Also opt-in available.'), ['sponsorship_unmentioned']);
eq('real OPT reference IS friendly', warns('', 'Candidates on STEM OPT are welcome to apply.').includes('opt_ok'), true);
eq('EEO citizenship boilerplate does not suppress warning', warns('Engineer', 'All qualified applicants receive consideration without regard to race, religion, or citizenship status.'), ['sponsorship_unmentioned']);
eq('sponsor-positive not raised on negated sentence', classifyVisa('', 'We are not able to sponsor visas.').warnings.some(w => w.key === 'sponsorship_positive'), false);

// ── visa: block always carries a quote (with abbreviation-safe bounds) ──
{
  const v = classifyVisa('', 'This position requires the candidate to be a U.S. citizen. Other duties apply.');
  eq('block quote is verbatim and not truncated at "U.S."', v.block.quote, 'This position requires the candidate to be a U.S. citizen.');
}

// ── visaGood flag never coexists with a hard block ──────────────────
{
  const t = triage({ title: 'Engineer', description: 'You must not need sponsorship (e.g., H1B, TN, STEM OPT) now or in the future.', location: 'Chaska, MN' });
  eq('OPT inside no-sponsor boilerplate → blocked, not sponsor-friendly', [t.flags.hardBlock, t.flags.visaGood], [true, false]);
}

// ── experience ──────────────────────────────────────────────────────
const exp = (t, d) => { const e = classifyExperience(t, d); return [e.level, e.years]; };
eq('senior title', exp('Senior Manufacturing Engineer', '5+ years of experience required.'), ['exclude', 5]);
eq('entry years', exp('Manufacturing Engineer I', 'Requires 2 years of experience in a fab.'), ['entry', 2]);
eq('stretch years', exp('Process Engineer', '4 years of experience with CVD.'), ['stretch', 4]);
eq('too senior years', exp('Process Engineer', 'Minimum 7 years of experience.'), ['exclude', 7]);
eq('company-history boilerplate ignored (KLA 40y)', exp('Mechanical Engineer', 'With over 40 years of semiconductor experience, KLA leads the market. Requires 3 years of experience in design.'), ['stretch', 3]);
eq('new-grad title signal', exp('New Grad Robotics Reliability Engineer', ''), ['entry', null]);
eq('level-neutral unknown', exp('Mechanical Engineer', 'Design cool machines.'), ['unknown', null]);

// The captured number is the FLOOR of the ask. "3+ years" was banded as entry
// because the old rule was `<= 3`, which put 779 postings he cannot apply for
// at the top of his deck wearing an entry label — Amazon Mechanical Engineer
// II at fit 98, Neuralink at 93. He has no industry years until May 2027.
eq('"3+ years" is a stretch, not entry', exp('Mechanical Engineer', 'Requires 3+ years of experience.'), ['stretch', 3]);
eq('"3-5 years" is read at its floor', exp('Manufacturing Engineer', '3-5 years of working experience.'), ['stretch', 3]);
eq('2 years stays entry', exp('Manufacturing Engineer', 'Requires 2+ years of experience.'), ['entry', 2]);
eq('0-2 years stays entry', exp('Process Engineer', '0 to 2 years of engineering experience, including internships.'), ['entry', 0]);

// A years figure under "Preferred Qualifications" is a wish, not a gate.
// Blocking on it would hide a job he could get — the expensive error.
eq('preferred-only years on a new-grad title stays entry',
  exp('Mechanical Engineer - New Grad', 'Basic Qualifications: BS in Mechanical Engineering. Preferred Qualifications: 5+ years of experience with CAD.'),
  ['entry', 5]);
eq('required years still win over a preferred figure',
  exp('Mechanical Engineer', 'Basic Qualifications: 4 years of experience. Preferred Qualifications: 8 years of experience.'),
  ['stretch', 4]);

// F-466. A years bar written without the word "experience" after the figure.
// Every string here is quoted from a req that reached the top of his own list
// on 2026-09-17 wearing no years label at all; 139 of 2,770 read that way.
eq('"5+ years with a Bachelor\'s" (1X, fit 100)',
  exp('Manufacturing Engineer, Hands', "5+ years with a Bachelor's or 3+ years with a Master's in manufacturing engineering."),
  ['stretch', 5]);
eq('"4+ years in <field>" (Standard Bots, fit 97)',
  exp('Electronics Manufacturing Engineer', '4+ years in electronics/PCBA manufacturing engineering, with hands-on ownership of an SMT line.'),
  ['stretch', 4]);
eq('"Experience: 3–7 years" reversed (Applied Materials, fit 95)',
  exp('Automation Engineer', 'Experience: 3–7 years Qualification: BE / B. Tech in Mechatronics.'),
  ['stretch', 3]);
eq('"Experience - 5 to 8 Yrs" reversed (Applied Materials, fit 93)',
  exp('Manufacturing Engineer Mechanical', 'Education – B.E/B.Tech (Mechanical) Experience - 5 to 8 Yrs'),
  ['stretch', 5]);
eq('"5+ years building <thing>" (Gecko, fit 94)',
  exp('Forward Deployed Robotics Engineer', '- 5+ years building production software. - Strong Python.'),
  ['stretch', 5]);
eq('"work experience of 5 years" (KLA, fit 89)',
  exp('Mechanical Engineer', "Minimum Qualifications Bachelor's Level Degree and related work experience of 5 years"),
  ['stretch', 5]);
eq('"Experience (3-5 years) as <role>" (Bosch, fit 88)',
  exp('Mechanical Process and Automation Engineer', 'SKILLS: GD&T certification. Experience (3-5 years) as mechanical process or maintenance Engineer.'),
  ['stretch', 3]);
eq('"A minimum of 2 years in <field>" is still entry (AST, fit 91)',
  exp('Manufacturing Engineer Major Assembly', 'Experience A minimum of 2 years in lean manufacturing, preferably in aerospace.'),
  ['entry', 2]);

// …and the four shapes that must NOT be read as a bar. Each of these was a
// false positive in the same measurement, and each would have taken a job he
// can actually get off his list — the expensive direction.
// Its own title carries it to entry, which is right; the point is that no
// years figure is invented from the phrase "2 year program".
eq('a rotation programme is not a two-year bar (Viavi, fit 91)',
  exp('Early Careers R&D Rotational Program', 'During this 2 year program you will be able to develop your skills at the forefront of leading edge technology.'),
  ['entry', null]);
eq('a roadmap horizon is not a bar (Micron, fit 89)',
  exp('Equipment Engineering', 'Establish hardware strategic roadmaps for 5+ years in post probe wafer and die processing.'),
  ['unknown', null]);
eq('"graduated within the last 2 years" is an invitation, not a bar (Medtronic, fit 94)',
  exp('Manufacturing Engineering Graduate', 'We seek a motivated person with a degree in Engineering who has graduated within the last 2 years.'),
  ['unknown', null]);
eq('a pay band lends no digits to a years match (KLA)',
  exp('Mechanical Engineer', 'Base Pay Range: $117,800.00 - $200,300.00 Annually Primary Location: USA-CA-Milpitas'),
  ['unknown', null]);

// One phrase matched by two patterns is one requirement, read at its floor.
eq('"a minimum of 2-15+ years" is a two-year floor, not fifteen (Zipline, fit 82)',
  exp('Supplier Industrialization Engineer', 'You have worked for a minimum of 2-15+ years in a fast paced and high growth environment.'),
  ['entry', 2]);
// "over N years" IS a bar — the horizon guard must not swallow it.
eq('"over 5 years of experience" is still a bar',
  exp('Mechanical Engineer', 'You have over 5 years of experience in precision assembly.'),
  ['stretch', 5]);

// ── location ────────────────────────────────────────────────────────
eq('city, state', classifyLocation('Milpitas, CA'), 'us');
eq('spelled-out state', classifyLocation('Boise Idaho United States of America'), 'us');
eq('ISO country code (Taiwan)', classifyLocation('Taoyuan City,TW, TW'), 'non-us');
eq('ISO code lists never match CA-as-Canada', classifyLocation('Fremont, CA,US, US'), 'us');
eq('country word', classifyLocation('Veldhoven, Netherlands'), 'non-us');
eq('fab city in title fallback', classifyLocation('', 'Manufacturing Assembly Engineer Linkou'), 'non-us');
eq('concatenated multi-site slug', classifyLocation('', 'Security Risk Manager Linkouhsinchutaichungtainan'), 'non-us');
eq('US state name in title fallback', classifyLocation('', 'Industrial Engineer Boise Idaho United States Of America'), 'us');
eq('remote', classifyLocation('Remote - USA'), 'remote');
eq('empty and titleless → unknown', classifyLocation('', ''), 'unknown');
eq('remote but foreign', classifyLocation('Remote, Germany'), 'non-us');

// ── relevance (informational; word-boundary sanity) ─────────────────
eq('mechanical role scores', scoreRelevance('Mechanical Design Engineer', 'SolidWorks, GD&T, vacuum systems').score > 20, true);
eq('unrelated role scores low', scoreRelevance('Corporate Paralegal', 'Draft legal documents.').score < 10, true);

// ── role kind (engineer vs technician track) ────────────────────────
eq('technician is hands-on', classifyRoleKind('Automation Maintenance Technician'), 'hands-on');
eq('cell operator is hands-on', classifyRoleKind('Cell Operator'), 'hands-on');
eq('CNC machinist is hands-on', classifyRoleKind('Sr. CNC Prototype Machinist'), 'hands-on');
eq('quality inspector is hands-on', classifyRoleKind('Quality Inspector, Composites'), 'hands-on');
eq('engineer always wins over tech words', classifyRoleKind('Manufacturing Engineering Technician Engineer'), 'professional');
eq('test engineer is professional', classifyRoleKind('Senior Robotics Test Engineer'), 'professional');
eq('operations analyst is professional', classifyRoleKind('Operations Planning Analyst'), 'professional');
eq('technical program manager is professional', classifyRoleKind('Technical Program Manager'), 'professional');

// ── location: US markers beat city-name collisions ──────────────────
// Regression: the non-US lexicon was tested BEFORE US markers, so any posting
// in Paris TX / London OH / Milan MI / Hamburg NY was classified non-us and
// hidden. Hiding a US job he could take is the one failure this system treats
// as unacceptable, so these are pinned.
eq('Paris, Texas is US', classifyLocation('Paris, Texas'), 'us');
eq('London, Ohio is US', classifyLocation('London, Ohio'), 'us');
eq('Milan, Michigan is US', classifyLocation('Milan, Michigan'), 'us');
eq('Hamburg, NY is US', classifyLocation('Hamburg, NY'), 'us');
eq('bare Paris is non-US', classifyLocation('Paris'), 'non-us');
eq('bare Milan is non-US', classifyLocation('Milan'), 'non-us');

// Bare US cities with no state — these fell to 'unknown', so "US only" hid 562
// Applied Materials jobs in Santa Clara alone.
eq('bare Santa Clara is US', classifyLocation('Santa Clara'), 'us');
eq('bare Austin is US', classifyLocation('Austin'), 'us');
eq('bare Hillsboro is US', classifyLocation('Hillsboro'), 'us');
eq('bare Essex Junction is US', classifyLocation('Essex Junction'), 'us');

// ISO-3 country prefixes used by several Workday tenants.
eq('SGP prefix is non-US', classifyLocation('SGP - Woodlands'), 'non-us');
eq('POL prefix is non-US', classifyLocation('POL - Wroclaw'), 'non-us');
eq('USA prefix is US', classifyLocation('USA - Vermont - Essex Junction'), 'us');

// Newly covered international sites that were leaking into the inbox.
eq('Kuala Lumpur is non-US', classifyLocation('Kuala Lumpur'), 'non-us');
eq('Hwaseong Si is non-US', classifyLocation('Hwaseong Si'), 'non-us');
eq('Nijmegen is non-US', classifyLocation('Nijmegen'), 'non-us');
eq('Bucharest is non-US', classifyLocation('Bucharest'), 'non-us');
eq('Bogota is non-US', classifyLocation('Bogotá, Bogota, Colombia'), 'non-us');

// Genuinely ambiguous names stay 'unknown' (shown) rather than being guessed —
// Gloucester and Cambridge are as likely to be the UK ones.
eq('multi-site placeholder stays unknown', classifyLocation('2 Locations'), 'unknown');
eq('ambiguous Gloucester stays unknown', classifyLocation('Gloucester'), 'unknown');

// ── program kind: internship vs new-grad ────────────────────────────
// Alex graduates May 2027 and is taking no more internships/co-ops, so an
// internship req is noise and a new-grad req is the highest-value target.
const prog = (t, d) => classifyProgram(t, d, { year: 2027, month: 5 });

eq('summer internship title', prog('Mechanical Engineering Intern').internship, true);
eq('co-op with hyphen', prog('Manufacturing Co-Op - Fall 2026').internship, true);
eq('coop without hyphen', prog('Engineering Coop Student').internship, true);
eq('full-time req is not an internship', prog('Manufacturing Engineer').internship, false);
// A full-time posting that merely MENTIONS the company internship programme
// must not be classified as an internship — title is authoritative.
eq('description mentioning internships does not make it one',
  prog('Process Engineer', 'Our team also hosts summer interns each year.').internship, false);

eq('new college graduate (NVIDIA wording)', prog('Mechanical Engineer - New College Graduate').newGrad, true);
eq('university graduate (Intel wording)', prog('Manufacturing Engineer, University Graduate').newGrad, true);
eq('early career', prog('Early Career Design Engineer').newGrad, true);
eq('rotational program', prog('Rotational Engineering Program 2027').newGrad, true);
eq('bare rotational program', prog('Rotational Program - Manufacturing').newGrad, true);
// Mechanical false-friends: these are ordinary ME terms, not new-grad signals.
eq('rotational molding is not a new-grad signal', prog('Rotational Molding Process Engineer').newGrad, false);
eq('rotating equipment is not a new-grad signal', prog('Rotating Equipment Engineer').newGrad, false);
eq('new grad found in description', prog('Mechanical Engineer', 'This is a new graduate position for our 2027 class.').newGrad, true);
eq('internship is never also newGrad', prog('New Grad Intern Program').newGrad, false);
eq('plain senior role is not new-grad', prog('Staff Mechanical Engineer').newGrad, false);

// Applied Materials writes this in the body of a req wanting 5+ years. The
// phrase matcher read the words, ignored the "NOT", and promoted a posting
// that explicitly rejects him to the top of the Today slate.
eq('"New College Graduate Applicants will NOT be considered" is not a new-grad req',
  prog('System Engineer Wet Equipment', 'Experience with wet processing systems. New College Graduate Applicants will NOT be considered. Preferred: advanced packaging.').newGrad, false);
eq('"New Graduate Applicants will NOT be considered" (AMAT variant)',
  prog('Electrical Engineer II', 'Requirements (New Graduate Applicants will NOT be considered) Fundamental knowledge of industrial controls.').newGrad, false);
eq('"not an entry level position"',
  prog('Photolithography Process Engineer', 'This is not an entry level position. Proficiency in photolithography tools required.').newGrad, false);
// The title still wins — a req TITLED for new grads is one, whatever a
// boilerplate paragraph further down says.
eq('a new-grad TITLE survives a negation in the body',
  prog('Mechanical Engineer - New College Graduate', 'Some boilerplate: this is not an entry level position for our other teams.').newGrad, true);
// "Relocation Eligible: No" and "no prior experience required" sit beside
// these phrases constantly and must not read as an exclusion.
eq('AMAT metadata block is still a new-grad signal',
  prog('Dfx Mechanical Engineer II', 'Additional Information Time Type: Full time Employee Type: New College Grad Travel: Yes, 10% of the Time Relocation Eligible: No').newGrad, true);

// ── graduation window ───────────────────────────────────────────────
// Silence is NOT a restriction — the overwhelming majority of postings say
// nothing, and those must never be flagged.
eq('no graduation mention → no window', graduationWindow('Design fixtures for the line.'), null);
eq('silent posting is not a mismatch', prog('Mechanical Engineer', 'Build things.').gradEligible, null);

const winKeys = (d) => { const w = graduationWindow(d); return w && [w.from && `${w.from.month}/${w.from.year}`, w.to && `${w.to.month}/${w.to.year}`]; };
eq('ranged window with months', winKeys('Graduating between December 2026 and June 2027.'), ['12/2026', '6/2027']);
eq('ranged window with dash', winKeys('Graduation date between Dec 2026 - Jun 2027'), ['12/2026', '6/2027']);
eq('bounded by a deadline', winKeys('Must graduate by May 2027.'), [null, '5/2027']);
eq('bare year expands to the whole year', winKeys('Graduating in 2027.'), ['1/2027', '12/2027']);
eq('class of', winKeys('Open to the Class of 2027.'), ['1/2027', '12/2027']);

// May 2027 against real stated windows.
eq('inside a stated window → eligible',
  prog('MechE New Grad', 'Graduating between December 2026 and June 2027.').gradEligible, true);
eq('window ending before he graduates → NOT eligible',
  prog('MechE New Grad', 'Candidates must graduate between May 2025 and December 2026.').gradEligible, false);
eq('window starting after he graduates → NOT eligible',
  prog('MechE New Grad', 'For students graduating between December 2027 and June 2028.').gradEligible, false);
eq('graduate-by deadline he meets', prog('MechE New Grad', 'Must graduate by December 2027.').gradEligible, true);
eq('graduate-by deadline he misses', prog('MechE New Grad', 'Must graduate by December 2026.').gradEligible, false);
eq('class of 2027 matches him', prog('New Grad Engineer', 'Class of 2027 only.').gradEligible, true);
eq('class of 2026 does not', prog('New Grad Engineer', 'Class of 2026 only.').gradEligible, false);
// Boundary: his own graduation month at each edge of the window.
eq('his grad month as the window start is inside',
  prog('X', 'Graduating between May 2027 and December 2027.').gradEligible, true);
eq('his grad month as the window end is inside',
  prog('X', 'Graduating between May 2026 and May 2027.').gradEligible, true);

// ── seasons and "or" (found on a live Radiant posting, 2026-09-19) ──
//
// "Graduating in December 2026 or Spring 2027" was read as December 2026
// alone: "or" was not a range connector and seasons were not a vocabulary at
// all. The posting is titled "2027 New Graduate - Mechanical Engineer" and it
// was being hidden from a May 2027 graduate on the strength of its own text.
eq('December 2026 OR Spring 2027 includes him',
  prog('2027 New Graduate - Mechanical Engineer', 'Graduating in December 2026 or Spring 2027.').gradEligible, true);
eq('…and the window really does span to the end of spring',
  winKeys('Graduating in December 2026 or Spring 2027.'), ['12/2026', '6/2027']);
eq('a season on its own is understood',
  prog('X', 'Spring 2027 graduation required.').gradEligible, true);
eq('a term written before the word is understood',
  prog('X', 'May 2027 graduates welcome.').gradEligible, true);
eq('Fall 2026 still excludes him',
  prog('X', 'Fall 2026 grads only.').gradEligible, false);
eq('Spring 2026 or Fall 2026 still excludes him',
  prog('X', 'Graduating in Spring 2026 or Fall 2026.').gradEligible, false);
// Seasons round OUTWARD on purpose: too wide shows him a job he then judges,
// too narrow hides one he qualifies for and he never learns it existed.
eq('spring reaches June', winKeys('Graduating Spring 2027.'), ['3/2027', '6/2027']);
eq('fall reaches December', winKeys('Graduating Fall 2027.'), ['9/2027', '12/2027']);
eq('winter opens in the previous December', winKeys('Graduating Winter 2027.'), ['12/2026', '3/2027']);
// Silence must still be silence — none of the above may invent a window.
eq('a bare year in unrelated prose is not a graduation window',
  graduationWindow('We shipped 2027 units last quarter.'), null);

// A mismatch must surface on the triage flags the dashboard reads.
eq('gradMismatch flag set on an excluding window',
  triage({ title: 'New Grad ME', description: 'Must graduate by December 2026.', location: 'Austin, TX' }).flags.gradMismatch, true);
eq('gradMismatch flag stays false when silent',
  triage({ title: 'Manufacturing Engineer', description: 'Build fixtures.', location: 'Austin, TX' }).flags.gradMismatch, false);
eq('internship flag reaches triage()',
  triage({ title: 'Mechanical Engineering Intern', description: '', location: 'Austin, TX' }).flags.internship, true);

// ── store merge: a re-scan must never downgrade an enriched verdict ─
// Regression: scanner payloads carry title-only triage (list APIs have no
// description), and upsertJobs used to accept it verbatim. The 6-hourly
// auto-scan therefore overwrote description-based work-auth blocks with
// "clean", putting 735 ineligible jobs back in the inbox. Silent, and exactly
// the failure the wasted-app guard exists to prevent.
{
  const BLOCKING_JD = 'We are unable to provide visa sponsorship for this role.';
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-triage-'));
  process.env.JARVIS_DB_PATH = path.join(dir, 'jobs.db');
  const S = await import('./store.mjs');
  const URL1 = 'https://x.com/jobs/1', URL2 = 'https://x.com/jobs/2';

  S.upsertJobs([{ url: URL1, title: 'Manufacturing Engineer', company: 'X', location: 'Austin, TX' }]);
  const id = S.jobId(URL1);

  // Enrichment arrives with the full description → correctly hard-blocked.
  S.updateJob(id, { description: BLOCKING_JD }, { rederive: true });
  eq('enriched job is hard-blocked', S.getJob(id).triage.flags.hardBlock, true);

  // The next scan re-upserts it with a title-only triage, as scanners do.
  S.upsertJobs([{
    url: URL1, title: 'Manufacturing Engineer', company: 'X', location: 'Austin, TX',
    triage: triage({ title: 'Manufacturing Engineer', description: '', location: 'Austin, TX' }),
  }]);
  eq('re-scan does NOT clear the block', S.getJob(id).triage.flags.hardBlock, true);
  eq('re-scan keeps the description', S.getDescription(id), BLOCKING_JD);
  // The promoted column has to agree with the verdict, or the list shows a
  // blocked job as clean while the detail view calls it blocked.
  eq('the blocked column agrees', S.count({ blocked: true }), 1);

  // A job with no description still takes the scanner's verdict.
  S.upsertJobs([{ url: URL2, title: 'Design Engineer', company: 'X', location: 'Austin, TX' }]);
  S.upsertJobs([{
    url: URL2, title: 'Design Engineer', company: 'X', location: 'Austin, TX',
    triage: triage({ title: 'Design Engineer', description: BLOCKING_JD, location: 'Austin, TX' }),
  }]);
  eq('description-less job accepts the incoming verdict', S.getJob(S.jobId(URL2)).triage.flags.hardBlock, true);

  // A user decision outlives every re-scan. This is the promise the whole
  // store is built on: re-scanning refreshes postings, never decisions.
  S.setStatus(id, 'queued');
  S.upsertJobs([{ url: URL1, title: 'Manufacturing Engineer', company: 'X', location: 'Austin, TX' }]);
  eq('a re-scan never resets a status the user set', S.getJob(id).status, 'queued');

  S.closeDb();
  delete process.env.JARVIS_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
}

// ── apply-engine option matching (mis-selection guards) ─────────────
eq('No does not match North America', optionMatches('No', 'North America'), false);
eq('No matches "No, I do not have a disability…"', optionMatches('No, I do not have a disability', 'No, I do not have a disability and have not had one in the past'), true);
eq('Yes-flavored answer matches Yes option', optionMatches('Yes', 'Yes, I can meet these requirements'), true);
eq('years 1 does not match 10+ years', optionMatches('1-2 years', '10+ years'), false);
eq('years 1 matches bare numeric 1', optionMatches('1-2 years', '1'), true);
eq('Male never matches Female', optionMatches('Male', 'Female'), false);
eq('Asian matches full EEO option', optionMatches('Asian', 'Asian (Not Hispanic or Latino)'), true);
eq('punctuation-insensitive (Self-Identify)', optionMatches('Decline to self-identify', 'Decline To Self Identify'), true);
eq("Bachelor's matches Bachelor's Degree Or Equivalent", optionMatches("Bachelor's", "Bachelor's Degree Or Equivalent"), true);

// ── a numbered level is a stretch, never a bar ──────────────────────
//
// "Engineer II, Process Engineering" scored 82 and classified ENTRY, because
// the body stated no years and no title pattern knew what "II" meant. He
// skipped six of these giving "Too senior / wants more experience" as the
// reason, while 3,036 of them sat in the deck reading as entry-level.
{
  const lvl = (t, d = '') => classifyExperience(t, d).level;
  eq('Engineer II is a stretch', lvl('Engineer II, Process Engineering'), 'stretch');
  eq('…in its arabic form too', lvl('Mechanical Engineer 2'), 'stretch');
  eq('…and carrying a pay grade', lvl('Manufacturing Engineer II E2'), 'stretch');

  // NEVER AN EXCLUSION. He has APPLIED to six roles with this exact shape, so
  // hiding the band would have cost him every one of them. Being picky within
  // a band is not the same as being barred from it.
  eq('a stretch is still shown, never excluded', lvl('Mechanical Engineer II, Amazon Industrial Robotics'), 'stretch');

  // Level I is entry and must stay there.
  eq('Engineer I is still entry', lvl('Engineer I, Process Engineering'), 'entry');
  eq('Manufacturing Engineer I is still entry', lvl('Manufacturing Engineer I'), 'entry');

  // "E2E" IS NOT A LEVEL. NVIDIA's "E2E Performance and Goodput" is end-to-end.
  eq('E2E is not a pay grade', lvl('Network and System Verification Engineer, E2E'), 'unknown');

  // A GRADUATE PROGRAMME OUTRANKS ITS OWN GRADE CODE. Applied Materials' "2027
  // Engineer Development Rotation Program … (E2)" is his single best-fitting
  // employer's new-grad req, and the only entry signal the pattern knew was
  // the adjective "rotational".
  eq('a rotation programme is entry, grade code and all',
    lvl('2027 Engineer Development Rotation Program Systems Engineering (E2)'), 'entry');
  // …but a programme titled for seniors is not.
  eq('seniority in the title still wins', lvl('Leadership Development Program - Senior Manager'), 'exclude');
}

// ── report ──────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
