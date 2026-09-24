/**
 * The end-to-end path: a posting goes in, a resume comes out, and a dishonest
 * rewrite never reaches the PDF.
 *
 * The tailor is injected here, so these run without a model call and can feed
 * the pipeline rewrites no real model would be trusted to produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { resumeForJob, auditName, personFile, tailorReport } from './resume-for-job.mjs';
import { buildTailorPrompt, parseRewrites, condenseJd } from './tailor-llm.mjs';

const JOB = { company: 'Applied Materials', title: 'Automation Engineer', url: 'https://example.test/1' };
const JD = 'Seeking an automation engineer with vision systems and fixture design experience.';

const dir = () => mkdtempSync(path.join(tmpdir(), 'jarvis-tailored-'));

test('a posting with no description still produces a resume', async () => {
  const r = await resumeForJob(JOB, { outDir: dir(), jd: null, render: false });
  assert.ok(r.family.key, 'a family must always be chosen');
  assert.deepEqual(r.applied, []);
  assert.match(r.why, /no description/);
});

test('the family still decides the resume — the model does not', async () => {
  const mech = await resumeForJob(
    { company: 'X', title: 'Mechanical Design Engineer' },
    { outDir: dir(), jd: JD, render: false, tailor: async () => ({ rewrites: {}, why: 'stub' }) },
  );
  assert.equal(mech.family.key, 'mechanical');
});

test('an honest rewrite reaches the spec', async () => {
  let seen = null;
  const tailor = async ({ spec }) => {
    // Trim the first bullet at its first comma: same words, fewer of them.
    const b = spec.experience[0].bullets[0];
    seen = b.provenanceKey;
    const trimmed = b.text.split(/,\s*/)[0];
    return { rewrites: trimmed === b.text ? {} : { [b.provenanceKey]: trimmed }, why: 'stub' };
  };
  const r = await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor });
  assert.ok(seen, 'the prompt must be given bullets with provenance keys');
  if (r.applied.length) {
    assert.equal(r.refused.length, 0);
    assert.equal(r.spec.experience[0].bullets[0].text, r.applied[0].to);
  }
});

test('HIS NOTE REACHES THE TAILOR, and what it could not honour is said back', async () => {
  let seen = null;
  const tailor = async (args) => { seen = args; return { rewrites: {}, plan: { notes: ['it asked for PLC work, which is not in the pool'] }, why: 'stub' }; };
  const r = await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor, request: 'lead with the fixture; add PLC' });
  assert.equal(seen.request, 'lead with the fixture; add PLC', 'the note travels to the model with the posting');
  assert.equal(r.request, 'lead with the fixture; add PLC');
  assert.ok(r.planNotes.some((n) => /your note: it asked for PLC work/.test(n)), `the model's answer about the note is kept: ${JSON.stringify(r.planNotes)}`);

  const prompt = buildTailorPrompt({ spec: r.spec, job: JOB, jd: JD, request: 'lead with the "fixture" work' });
  assert.match(prompt, /ALEX'S NOTE FOR THIS RESUME/);
  assert.match(prompt, /lead with the 'fixture' work/, 'his words, quotes tamed');
  assert.match(prompt, /can never add a fact, a tool, a number/, 'and the note cannot add anything');
  assert.ok(!/ALEX'S NOTE/.test(buildTailorPrompt({ spec: r.spec, job: JOB, jd: JD })), 'no note, no section');
});

test('a FABRICATED rewrite is refused and the original survives', async () => {
  const tailor = async ({ spec }) => ({
    rewrites: {
      [spec.experience[0].bullets[0].provenanceKey]:
        'Led a team of 45 engineers deploying SolidWorks PDM across 12 fabs',
    },
    why: 'stub',
  });
  const before = (await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor: async () => ({ rewrites: {} }) }))
    .spec.experience[0].bullets[0].text;
  const r = await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor });
  assert.equal(r.applied.length, 0, 'nothing invented may be applied');
  assert.equal(r.refused.length, 1);
  assert.equal(r.spec.experience[0].bullets[0].text, before, 'the honest sentence must survive a refused rewrite');
});

test('a rewrite aimed at a bullet this family does not carry is reported, not silently dropped', async () => {
  const tailor = async () => ({ rewrites: { 'ghost.bullet': 'anything at all' }, why: 'stub' });
  const r = await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor });
  assert.deepEqual(r.unmatched, ['ghost.bullet']);
});

test('a tailor that throws does not cost him the application', async () => {
  const tailor = async () => { throw new Error('model unavailable'); };
  await assert.rejects(() => resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor }));
  // ...and the real caller is the one that must not throw:
  const { tailorWithClaude } = await import('./tailor-llm.mjs');
  const out = await tailorWithClaude({ spec: { experience: [] }, job: JOB, jd: JD, bin: 'definitely-not-a-real-binary' });
  assert.deepEqual(out.rewrites, {});
  assert.equal(out.ok, false);
  assert.match(out.why, /not on PATH/);
});

test('the audit copy names the posting, and so does the sent file now (F-409)', () => {
  const name = auditName({ family: 'automation', job: JOB });
  assert.match(name, /Applied Materials/);
  assert.match(name, /Automation Engineer/);
  assert.match(name, /^Alex Rivera Resume - automation - /, 'must match the naming already used in sent/');
  assert.ok(!/[\\/:*?"<>|]/.test(name), 'must still be a legal Windows filename');
  // IT WAS "Alex Rivera Resume.pdf" FOR EVERY POSTING, deliberately. He asked for
  // the change on 2026-09-08 and gave the reason: "i want to have a signal
  // thats what you actually attached" — the filename in the form's own chip is
  // his receipt for which resume went on.
  assert.equal(personFile('Alex Rivera', JOB), 'Alex Rivera - Applied Materials - Automation Engineer.pdf');
  assert.ok(!/[\\/:*?"<>|]/.test(personFile('Alex Rivera', { company: 'A/B: Co?', title: 'Eng<>|' })),
    'a company or title with path characters in it still makes a legal filename');
  // A build with no posting behind it — the four family bases — has no
  // employer to name, and keeps the plain one.
  assert.equal(personFile('Alex Rivera'), 'Alex Rivera Resume.pdf');
  assert.equal(personFile('Alex Rivera', {}), 'Alex Rivera Resume.pdf');
  // A req title long enough to break a Windows path is trimmed, not dropped.
  const long = personFile('Alex Rivera', { company: 'Acme', title: 'Manufacturing Engineer '.repeat(12) });
  assert.ok(long.length < 130, `trimmed, got ${long.length}`);
  assert.match(long, /^Alex Rivera - Acme - Manufacturing Engineer/);
});

test('renders a real PDF named for the posting, plus an audit copy', async () => {
  const out = dir();
  const r = await resumeForJob(JOB, { outDir: out, jd: null, render: true });
  assert.ok(existsSync(r.pdfPath), 'the PDF must exist');
  assert.equal(path.basename(r.pdfPath), 'Alex Rivera - Applied Materials - Automation Engineer.pdf');
  assert.ok(existsSync(r.auditPath), 'the audit copy must exist');
  assert.match(path.basename(r.auditPath), /Applied Materials/);
  const spec = JSON.parse(readFileSync(path.join(path.dirname(r.pdfPath), 'spec.json'), 'utf-8'));
  assert.ok(spec.experience[0].bullets[0].provenanceKey, 'the saved spec must stay traceable to the pool');
});

// --- the prompt is a safety control, so its rules are pinned ----------------

test('the prompt hands the model every approved wording and forbids adding facts', async () => {
  const r = await resumeForJob(JOB, { outDir: dir(), jd: null, render: false });
  const prompt = buildTailorPrompt({ spec: r.spec, job: JOB, jd: JD });
  assert.match(prompt, /Reword only\. Never add a fact\./);
  assert.match(prompt, /LEAVE IT OUT/);
  assert.match(prompt, /does not appear somewhere in his CV/);
  assert.match(prompt, /same length or shorter/);
  assert.match(prompt, /"Assembled" and "designed" are different claims/);
  assert.match(prompt, /Return ONLY a JSON object/);
  assert.match(prompt, /Applied Materials/, 'the posting must reach the prompt');
  const first = r.spec.experience[0].bullets[0];
  assert.ok(prompt.includes(first.provenanceKey), 'every bullet goes in keyed by provenance');
  assert.ok(prompt.includes(first.source[0]), 'the approved wording goes in so the model can stay inside it');
});

test('parseRewrites survives fences, prose and junk', () => {
  assert.deepEqual(parseRewrites('```json\n{"a.b":"hello"}\n```'), { 'a.b': 'hello' });
  assert.deepEqual(parseRewrites('Sure! Here you go:\n{"a.b":"hello"}\nHope that helps.'), { 'a.b': 'hello' });
  assert.deepEqual(parseRewrites('{}'), {});
  assert.deepEqual(parseRewrites('not json at all'), {});
  assert.deepEqual(parseRewrites(''), {});
  assert.deepEqual(parseRewrites('["a","b"]'), {}, 'an array is not a rewrite map');
  assert.deepEqual(parseRewrites('{"a.b": 42, "c.d": "ok"}'), { 'c.d': 'ok' }, 'non-strings are dropped');
});

test('condenseJd drops boilerplate before it drops requirements', () => {
  const jd = [
    'Requirements: SolidWorks, GD&T, fixture design.',
    'We are an Equal Opportunity Employer.',
    'Benefits include a 401(k) match.',
  ].join('\n');
  const out = condenseJd(jd, 40);
  assert.match(out, /Requirements/);
  assert.ok(!/Equal Opportunity/.test(out), 'EEO boilerplate is the first thing to go');
});

test('tailorReport says plainly what happened', async () => {
  const tailor = async ({ spec }) => ({
    rewrites: { [spec.experience[0].bullets[0].provenanceKey]: 'Achieved 900% yield with Kubernetes' },
    why: 'stub',
  });
  const r = await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor });
  const report = tailorReport(r);
  assert.match(report, /REFUSED/);
  assert.match(report, /900%/);
});

// --- the per-posting plan (Alex, 2026-09-03: "more aggressively tailor to the jd") ---

test('THE MODEL MAY RESHAPE THE PAGE for one posting — inside the pool, under his rules', async () => {
  const tailor = async ({ spec }) => ({
    plan: {
      roleType: 'automation',
      // Applied Materials is the employer here, so this title must be overruled.
      titles: { amat: 'Robotics Engineer Intern', acme: 'Robotics Engineer Intern' },
      experience: { amat: ['robodk', 'cobot-rack', 'amr', 'neuro-t', 'vision-fixture'], acme: ['robotic-line', 'docs'], makerspace: ['fabrication'], sae: ['coach'] },
      projects: ['robotic-arm'],
      coursework: ['System Dynamics and Control', 'Circuit Analysis', 'Python Programming', 'Machine Design', 'Mechanical Design'],
      skills: [{ key: 'automation', items: ['RoboDK', 'Universal Robots', 'Node-RED'] }, 'cad', 'manufacturing'],
      reserve: ['acme.coil-savings'],
    },
    rewrites: {},
    why: 'stub plan',
  });
  const r = await resumeForJob(JOB, { outDir: dir(), jd: JD, render: false, tailor });
  const amat = r.spec.experience.find((e) => e.orgKey === 'amat');
  assert.equal(amat.title, 'Manufacturing Engineer Intern', 'at Applied Materials itself only the official title, whatever was proposed');
  assert.equal(amat.group, 'Automation Technology Group');
  assert.equal(r.spec.experience.find((e) => e.orgKey === 'acme').title, 'Robotics Engineer Intern', 'Acme Steel may match the job');
  assert.deepEqual(amat.bullets.map((b) => b.provenanceKey), ['amat.robodk', 'amat.cobot-rack', 'amat.amr', 'amat.neuro-t', 'amat.vision-fixture']);
  assert.equal(r.spec.projects.length, 1);
  assert.equal(r.spec.skills[0].text, 'RoboDK, Universal Robots, Node-RED');
  assert.ok(r.changed.includes('experience:amat') && r.changed.includes('skills'));
  assert.ok(r.planNotes.some((n) => /official title/.test(n)));
  assert.match(tailorReport(r), /plan changed for this posting/);
});

test('the prompt carries the menu, the default plan, the title rules and the never-list', async () => {
  const r = await resumeForJob(JOB, { outDir: dir(), jd: null, render: false });
  const { loadPool } = await import('./resume-variants.mjs');
  const prompt = buildTailorPrompt({ spec: r.spec, job: JOB, jd: JD, pool: loadPool(), framing: 'qualification testing, root cause analysis' });
  assert.match(prompt, /THE MENU/);
  assert.match(prompt, /"cobot-rack"/, 'every pool bullet is on the menu');
  assert.match(prompt, /"whenApplyingToThisCompany"/);
  assert.match(prompt, /THIS POSTING IS AT APPLIED MATERIALS ITSELF/);
  assert.match(prompt, /DEFAULT PLAN/);
  assert.match(prompt, /NEVER claim: PLC/);
  assert.match(prompt, /Never weaker than his own words/);
  assert.match(prompt, /root cause analysis/, 'the approved framing vocabulary reaches the model');
  assert.match(prompt, /"roleType"/);
  assert.match(prompt, /"reserve"/);
  const other = buildTailorPrompt({ spec: r.spec, job: { company: 'Lam Research', title: 'Mechanical Engineer 2' }, jd: JD, pool: loadPool() });
  assert.ok(!/ITSELF/.test(other), 'the own-company rule is only stated when it applies');
});

test('parsePlan takes the whole answer apart; parseRewrites still finds the rewrites inside it', async () => {
  const { parsePlan } = await import('./tailor-llm.mjs');
  const raw = '```json\n{"roleType":"npi","titles":{"amat":"X"},"experience":{"amat":["robodk"]},"projects":["cnc-cardholder"],"coursework":["Machine Design"],"skills":["cad"],"rewrites":{"amat.robodk":"Programmed a robot."},"reserve":["acme.docs"]}\n```';
  const { plan, rewrites } = parsePlan(raw);
  assert.equal(plan.roleType, 'npi');
  assert.deepEqual(plan.experience, { amat: ['robodk'] });
  assert.deepEqual(plan.reserve, ['acme.docs']);
  assert.deepEqual(rewrites, { 'amat.robodk': 'Programmed a robot.' });
  assert.deepEqual(parseRewrites(raw), { 'amat.robodk': 'Programmed a robot.' });
  assert.deepEqual(parsePlan('{"rewrites":{}}'), { plan: null, rewrites: {} });
  assert.deepEqual(parsePlan('nope'), { plan: null, rewrites: {} });
});

test('THE AGGRESSIVE FIELDS SURVIVE THE PARSE — and junk in them does not', async () => {
  // Added 2026-09-09 with the coverage pass. These four fields are the whole
  // difference between a page that answers the posting and one that looks like
  // it does, so a silent parse regression has to fail a build.
  const { parsePlan } = await import('./tailor-llm.mjs');
  const raw = JSON.stringify({
    roleType: 'mechanical',
    coverage: [
      { req: 'Baja SAE or similar build team', need: 'must', proof: 'sae.baja' },
      { req: 'Firmware flashing', need: 'MUST-HAVE', proof: 'none' },
      { req: 'Python scripting', need: 'nice', proof: 'skills: Python' },
      { req: '', need: 'must', proof: 'nothing' },        // no requirement — dropped
      'not an object',                                     // junk — dropped
    ],
    mustKeep: ['soldered wire harness', 'MIG/TIG welders', 'no', 42],
    emphasise: ['sae', 'makerspace', 'amat'],
    whyFewerAmat: '  Makerspace and Baja prove the hands-on build this posting asks for.  ',
    experience: { amat: ['vision-fixture'] },
  });
  const { plan } = parsePlan(raw);

  assert.equal(plan.coverage.length, 3, 'a coverage row with no requirement, and junk, are dropped');
  assert.equal(plan.coverage[1].need, 'must', '"MUST-HAVE" is a must');
  assert.equal(plan.coverage[2].need, 'nice');
  assert.equal(plan.coverage[1].proof, 'none', 'an uncovered requirement keeps saying so');

  assert.deepEqual(plan.mustKeep, ['soldered wire harness', 'MIG/TIG welders'],
    'phrases under three characters and non-strings protect nothing');
  assert.deepEqual(plan.emphasise, ['sae', 'makerspace'], 'at most two orgs');
  assert.equal(plan.whyFewerAmat, 'Makerspace and Baja prove the hands-on build this posting asks for.');

  // And a plan that says none of it is still a plan.
  const plain = parsePlan('{"experience":{"amat":["vision-fixture"]}}').plan;
  assert.equal(plain.coverage, undefined);
  assert.equal(plain.mustKeep, undefined);
  assert.equal(plain.whyFewerAmat, undefined);
});

test('THE PROMPT ASKS FOR COVERAGE, AND SAYS WHAT AN UNCOVERED REQUIREMENT MEANS', async () => {
  const { buildTailorPrompt, loadPoolForPrompt } = await import('./tailor-llm.mjs')
    .then(async (m) => ({ ...m, loadPoolForPrompt: (await import('./resume-variants.mjs')).loadPool }));
  const pool = loadPoolForPrompt();
  const { buildSpec } = await import('./resume-variants.mjs');
  const p = buildTailorPrompt({
    spec: buildSpec('mechanical', pool),
    job: { company: 'Applied Intuition', title: 'Mechanical Engineer - New Grad' },
    jd: 'Formula SAE, Baja, solar car, rocketry, robotics, or similar hands-on build team experience.',
    pool,
  });
  // The coverage pass itself.
  assert.match(p, /COVERAGE/);
  assert.match(p, /must be covered/);
  assert.match(p, /Never bridge to it/);
  // The three rules that were arguing with the posting, in their new form.
  assert.match(p, /amat\.vision-fixture is on every resume/);
  assert.ok(!/amat\.neuro-t are on every resume/.test(p), 'Neuro-T is no longer a staple');
  assert.match(p, /whyFewerAmat/);
  assert.match(p, /Where the posting NAMES one/, 'Baja turns on what the posting says');
  // And the phrases the layout may not spend.
  assert.match(p, /MUSTKEEP/);
  assert.match(p, /anything you list here it will not spend/);
});

test('an over-full plan is CUT TO ONE PAGE at render time, never shrunk', async () => {
  const tailor = async () => ({
    plan: {
      experience: {
        amat: ['vision-fixture', 'robodk', 'neuro-t', 'amr', 'iiot', 'cobot-rack'],
        acme: ['robotic-line', 'coil-savings', 'plant-layout', 'packaging', 'docs'],
        makerspace: ['production', 'fabrication'], sae: ['baja', 'coach'],
      },
      skills: ['cad', 'automation', 'manufacturing', 'process', 'semiconductor'],
      coursework: ['Mechanical Design', 'Machine Design', 'Manufacturing Processes', 'Fluid Mechanics', 'Thermodynamics', 'Heat Transfer', 'Finite Element Analysis', 'Vibration Engineering'],
    },
    rewrites: {},
    why: 'stub',
  });
  const r = await resumeForJob({ company: 'Lam Research', title: 'Manufacturing Engineer' }, { outDir: dir(), jd: JD, render: true, tailor });
  assert.ok(existsSync(r.pdfPath));
  assert.equal(r.fit.overflow, false, 'one page');
  assert.equal(r.fit.pages ?? 1, 1);
  assert.ok(Math.abs(r.fit.topGap - r.fit.bottomGap) <= 4, `margins balanced: ${r.fit.topGap} vs ${r.fit.bottomGap}`);
  assert.deepEqual(r.fit.lostWords ?? [], [], 'the text layer is intact');
  const amat = r.spec.experience.find((e) => e.orgKey === 'amat');
  assert.ok(amat.bullets.length >= 5, 'Applied Materials keeps its floor when the page is cut');
  const sidecar = JSON.parse(readFileSync(`${r.auditPath}.json`, 'utf-8'));
  assert.ok(sidecar.fit && typeof sidecar.fit.topGap === 'number', 'the audit record carries the measured fit');
  assert.ok(Array.isArray(sidecar.planNotes));
});
