// jarvis/resume-plan.test.mjs — the model may choose; it may not invent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpec, loadPool } from './resume-variants.mjs';
import { applyPlan, reserveFor, withBullet, withoutOneBullet, isOwnCompany, ownCompanyTitle, MIN_AMAT, MIN_AMAT_JUSTIFIED, MAX_BULLETS, shortenOneBullet, shortenOneProject, shortenBulletEnding, dropsProtected, protectedPhrases } from './resume-plan.mjs';

const pool = loadPool();
const base = () => buildSpec('manufacturing', pool);
const keysOf = (spec, org) => spec.experience.find((e) => e.orgKey === org).bullets.map((b) => b.provenanceKey.split('.')[1]);
const OTHER = { company: 'Lam Research', title: 'Mechanical Engineer 2' };

test('a good proposal is applied in full — titles, order, projects, coursework, skills', () => {
  const { spec, notes, changed } = applyPlan(base(), {
    titles: { amat: 'Robotics Engineer Intern', acme: 'Process Improvement Intern' },
    experience: { amat: ['robodk', 'cobot-rack', 'vision-fixture', 'neuro-t', 'amr'], acme: ['robotic-line', 'docs'], makerspace: ['supervise'], sae: ['coach'] },
    projects: ['robotic-arm'],
    coursework: ['System Dynamics and Control', 'Mechanical Design', 'Circuit Analysis', 'Python Programming', 'Machine Design'],
    skills: [{ key: 'automation', items: ['RoboDK', 'Universal Robots', 'Python'] }, { key: 'cad', items: ['SolidWorks', 'GD&T'] }, 'process'],
  }, { pool, job: OTHER });
  assert.deepEqual(notes, []);
  assert.equal(spec.experience[0].title, 'Robotics Engineer Intern');
  assert.equal(spec.experience[0].group, 'Automation Technology Group', 'the group survives a title change');
  assert.equal(spec.experience[1].title, 'Process Improvement Intern');
  assert.deepEqual(keysOf(spec, 'amat'), ['robodk', 'cobot-rack', 'vision-fixture', 'neuro-t', 'amr']);
  assert.deepEqual(keysOf(spec, 'acme'), ['robotic-line', 'docs']);
  assert.deepEqual(keysOf(spec, 'makerspace'), ['supervise']);
  assert.equal(spec.projects.length, 1);
  assert.equal(spec.projects[0].key, 'robotic-arm');
  const course = spec.education[0].bullets.find((b) => b.lead === 'Relevant Coursework');
  assert.match(course.text, /^System Dynamics and Control, Mechanical Design/);
  assert.equal(spec.skills.length, 3);
  assert.equal(spec.skills[0].text, 'RoboDK, Universal Robots, Python');
  assert.equal(spec.skills[2].text, pool.skills.process.items.join(', '), 'a bare key prints the whole category');
  assert.ok(changed.includes('title:amat') && changed.includes('projects') && changed.includes('skills'));
  assert.equal(spec.order[0], 'education', 'education first, always');
});

test('anything outside the pool is dropped and said so', () => {
  const { spec, notes } = applyPlan(base(), {
    titles: { amat: 'Senior Process Engineer', acme: 'Robotics Engineer Intern' },
    experience: { amat: ['vision-fixture', 'neuro-t', 'robodk', 'amr', 'iiot', 'plc-programming'], acme: ['robotic-line'], makerspace: ['production'], sae: ['baja'] },
    projects: ['drone-swarm', 'piston-fea'],
    coursework: ['Plasma Physics', 'Mechanical Design', 'Machine Design', 'Heat Transfer', 'Thermodynamics'],
    skills: [{ key: 'cad', items: ['SolidWorks', 'CATIA'] }, { key: 'devops', items: ['Linux'] }, { key: 'process', items: ['Root Cause Analysis'] }],
  }, { pool, job: OTHER });
  assert.equal(spec.experience[0].title, 'Manufacturing Engineer Intern', 'an unapproved title keeps the family default');
  assert.equal(spec.experience[1].title, 'Robotics Engineer Intern');
  assert.ok(!keysOf(spec, 'amat').includes('plc-programming'));
  assert.deepEqual(spec.projects.map((p) => p.key), ['piston-fea']);
  assert.ok(!/Plasma/.test(spec.education[0].bullets.find((b) => b.lead === 'Relevant Coursework').text));
  assert.equal(spec.skills.length, 2);
  assert.equal(spec.skills[0].text, 'SolidWorks');
  for (const bad of ['Senior Process Engineer', 'plc-programming', 'drone-swarm', 'Plasma Physics', 'CATIA', 'devops']) {
    assert.ok(notes.some((n) => n.includes(bad)), `must report "${bad}"`);
  }
});

test('the staples, the Applied Materials floor and the one-cell rule hold whatever is proposed', () => {
  const { spec, notes } = applyPlan(base(), {
    experience: { amat: ['robodk', 'cobot-install', 'iiot'], acme: ['coil-savings'], makerspace: ['production', 'fabrication', 'supervise'], rover: [], sae: [] },
  }, { pool, job: OTHER });
  const amat = keysOf(spec, 'amat');
  // ONE staple since 2026-09-09: the mechanical-design fixture. Neuro-T is a
  // strong default the tailorer may spend when the posting pays better
  // elsewhere, not a fixture (F-437).
  assert.ok(amat.includes('vision-fixture'), 'the mechanical-design staple is restored');
  assert.ok(amat.length >= MIN_AMAT, `at least ${MIN_AMAT} Applied Materials bullets`);
  assert.ok(!(amat.includes('robodk') && amat.includes('cobot-install')), 'the cell is described once');
  assert.equal(keysOf(spec, 'makerspace').length, 2, 'a minor org is capped');
  // SAE is optional (2026-09-05): a plan that leaves it off leaves it off.
  assert.ok(!spec.experience.some((e) => e.orgKey === 'sae'), 'sae is optional — left off when the plan omits it');
  // So is the Mars Rover Team (2026-09-15), which every base carries.
  assert.ok(!spec.experience.some((e) => e.orgKey === 'rover'), 'rover is optional — left off when the plan empties it');
  assert.ok(notes.some((n) => /rover: left off/.test(n)));
  assert.ok(notes.some((n) => /staple|every resume/.test(n)));
  // …but Makerspace is not: an empty makerspace list is restored to one line.
  const kept = applyPlan(base(), { experience: { makerspace: [] } }, { pool, job: OTHER });
  assert.equal(keysOf(kept.spec, 'makerspace').length, 1, 'makerspace stays on the page');
});

test('over the page budget, the least-protected lines go first', () => {
  const { spec, notes } = applyPlan(base(), {
    experience: {
      amat: ['vision-fixture', 'robodk', 'neuro-t', 'amr', 'iiot', 'cobot-rack'],
      acme: ['robotic-line', 'coil-savings', 'plant-layout', 'packaging', 'docs'],
      makerspace: ['production', 'fabrication'], sae: ['baja', 'coach'],
    },
  }, { pool, job: OTHER });
  const total = spec.experience.reduce((n, e) => n + e.bullets.length, 0);
  assert.ok(total <= MAX_BULLETS, `${total} bullets`);
  assert.ok(!spec.experience.some((e) => e.orgKey === 'sae'), 'SAE gives way first, and may go entirely');
  assert.equal(keysOf(spec, 'amat').length, 6, 'Applied Materials is untouched');
  assert.ok(notes.some((n) => /page budget/.test(n)));
});

test('AT APPLIED MATERIALS ITSELF only the official title is allowed, chosen by role type', () => {
  const amatOrg = pool.orgs.amat;
  assert.ok(isOwnCompany(amatOrg, { company: 'Applied Materials' }));
  assert.ok(isOwnCompany(amatOrg, { company: 'Applied Materials, Inc.' }));
  assert.ok(!isOwnCompany(amatOrg, { company: 'Lam Research' }));
  assert.equal(ownCompanyTitle(amatOrg, { title: 'Mechanical Design Engineer' }), 'Mechanical Engineer Intern');
  assert.equal(ownCompanyTitle(amatOrg, { title: 'Process Engineer' }), 'Manufacturing Engineer Intern');
  assert.equal(ownCompanyTitle(amatOrg, { title: 'NPI Engineer' }), 'Manufacturing Engineer Intern');

  const mech = applyPlan(buildSpec('mechanical', pool), { titles: { amat: 'Robotics Engineer Intern' } }, { pool, job: { company: 'Applied Materials', title: 'Mechanical Engineer NCG' } });
  assert.equal(mech.spec.experience[0].title, 'Mechanical Engineer Intern');
  assert.ok(mech.notes.some((n) => /official title/.test(n)));
  const proc = applyPlan(buildSpec('automation', pool), { titles: { amat: 'Automation Engineer Intern' } }, { pool, job: { company: 'Applied Materials', title: 'Manufacturing Automation Engineer' } });
  assert.equal(proc.spec.experience[0].title, 'Manufacturing Engineer Intern', 'an automation role at Applied is still the official manufacturing title');
  // …and Acme Steel's title is still free to match the job there.
  const sc = applyPlan(buildSpec('automation', pool), { titles: { acme: 'Robotics Engineer Intern' } }, { pool, job: { company: 'Applied Materials', title: 'Robotics Engineer' } });
  assert.equal(sc.spec.experience[1].title, 'Robotics Engineer Intern');
});

test('no proposal, a null proposal and junk all keep the family base', () => {
  const b = base();
  for (const p of [null, undefined, {}, 'nonsense', { experience: 'x', projects: 'y', skills: 3, titles: null }]) {
    const { spec, changed } = applyPlan(b, p, { pool, job: OTHER });
    assert.deepEqual(keysOf(spec, 'amat'), keysOf(b, 'amat'));
    assert.deepEqual(spec.skills.map((s) => s.text), b.skills.map((s) => s.text));
    assert.deepEqual(changed, []);
  }
});

test('A SPILL COSTS WORDS BEFORE IT COSTS CLAIMS: the longest full-form bullet takes its short form first (2026-09-05)', () => {
  const b = base();
  const full = b.experience.flatMap((e) => e.bullets).filter((x) => x.short);
  assert.ok(full.length >= 3, 'the base carries full wordings with short forms behind them');
  assert.ok(full.every((x) => x.text === x.source[0]), 'the page starts on the FULL wording, never the short one');
  const one = shortenOneBullet(b);
  assert.ok(one.shortened, 'something could be said in fewer words');
  const longest = full.slice().sort((p, q) => q.text.length - p.text.length)[0];
  assert.equal(one.shortened, longest.provenanceKey, 'the longest one first');
  const now = one.spec.experience.flatMap((e) => e.bullets).find((x) => x.provenanceKey === one.shortened);
  assert.equal(now.text, now.short);
  // A tailored rewrite is never overwritten by its short form.
  const tailored = { ...b, experience: b.experience.map((e) => ({ ...e, bullets: e.bullets.map((x) => (x.short ? { ...x, text: `${x.text} (reworded)` } : x)) })) };
  assert.equal(shortenOneBullet(tailored).shortened, null, 'a reworded bullet is left as written');
  // Exhaustion is clean.
  let cur = b; let n = 0;
  for (;;) { const out = shortenOneBullet(cur); if (!out.shortened) break; cur = out.spec; if (++n > 40) throw new Error('loop'); }
  assert.equal(n, full.length);
});

test('the reserve is what is left, in order, never the surplus line and never the other half of a pair', () => {
  const b = base();
  const r = reserveFor(b, pool, ['acme.docs', 'amat.cobot-install', 'nope.x', 'acme.surplus']);
  assert.equal(r[0], 'acme.docs', 'the model\'s order is honoured');
  assert.ok(!r.includes('amat.cobot-install'), 'robodk is on the page, so its twin is not offered');
  assert.ok(!r.includes('acme.surplus'));
  assert.ok(!r.includes('nope.x'));
  const used = new Set(b.experience.flatMap((e) => e.bullets.map((x) => x.provenanceKey)));
  assert.ok(r.every((k) => !used.has(k)));

  const more = withBullet(b, 'acme.docs', pool);
  assert.ok(keysOf(more, 'acme').includes('docs'));
  assert.equal(withBullet(b, 'nope.x', pool), b, 'an unknown key changes nothing');

  const { spec: less, dropped } = withoutOneBullet(more);
  assert.equal(dropped, 'rover.suspension', 'the rover team is optional, so its last line goes — whole — once Makerspace is at its floor, before Acme Steel loses evidence');
  assert.ok(!less.experience.some((e) => e.orgKey === 'rover'), 'an optional org with no line left is not a heading on the page');
  assert.equal(withoutOneBullet(less).dropped, 'acme.docs', 'then Acme Steel\'s last line');
  const two = withBullet(more, 'rover.gripper', pool);
  assert.equal(withoutOneBullet(two).dropped, 'rover.gripper', 'with two rover lines, the rover team gives one up first');
  // Drop until nothing is left to cut: Applied Materials never goes under its floor and never loses a staple.
  let cur = less; let n = 0;
  for (;;) { const out = withoutOneBullet(cur); if (!out.dropped) break; cur = out.spec; if (++n > 20) throw new Error('loop'); }
  assert.equal(keysOf(cur, 'amat').length, MIN_AMAT);
  assert.ok(keysOf(cur, 'amat').includes('vision-fixture'));
});


// -- AGGRESSION, 2026-09-09 ---------------------------------------------
// His words: "the skill keeps not tailoring aggressively enough". Three rules
// were arguing with the posting rather than reading it. These are the rules
// that replaced them.

test('NEURO-T IS NO LONGER A FIXTURE: a plan may spend its line', () => {
  const { spec } = applyPlan(base(), {
    experience: { amat: ['vision-fixture', 'robodk', 'cobot-rack', 'amr', 'iiot'], acme: ['robotic-line'], makerspace: ['production'], sae: [] },
  }, { pool, job: OTHER });
  const amat = keysOf(spec, 'amat');
  assert.ok(amat.includes('vision-fixture'), 'the mechanical-design staple still holds');
  assert.ok(!amat.includes('neuro-t'), 'machine vision is not forced onto a posting that never asked for it');
});

test('THE AMAT FLOOR MOVES FOR AN ARGUMENT, AND ONLY FOR AN ARGUMENT', () => {
  const thin = { amat: ['vision-fixture', 'cobot-rack', 'robodk'], acme: ['robotic-line', 'coil-savings'], makerspace: ['production', 'fabrication'], sae: ['baja', 'troubleshoot'] };

  // No argument: restored to five, and said so.
  const silent = applyPlan(base(), { experience: thin }, { pool, job: OTHER });
  assert.equal(keysOf(silent.spec, 'amat').length, MIN_AMAT, 'an unargued thin block is restored');
  assert.ok(silent.notes.some((n) => /fewer than 5 bullets proposed/.test(n)));

  // Argued: three is allowed, and the argument is on the record.
  const argued = applyPlan(base(), {
    experience: thin,
    whyFewerAmat: 'the posting is a vehicle garage role: Makerspace and Baja prove the hands-on build and fabrication it asks for, which no Applied Materials line does',
  }, { pool, job: OTHER });
  assert.equal(keysOf(argued.spec, 'amat').length, MIN_AMAT_JUSTIFIED, 'an argued plan keeps its three');
  assert.ok(argued.notes.some((n) => /amat: 3 lines instead of 5 . the posting is a vehicle garage/.test(n)), 'the argument is recorded');

  // A one-word excuse is not an argument.
  const hollow = applyPlan(base(), { experience: thin, whyFewerAmat: 'better fit' }, { pool, job: OTHER });
  assert.equal(keysOf(hollow.spec, 'amat').length, MIN_AMAT);
});

test('AN EMPHASISED ORG MAY HOLD A THIRD LINE - a named requirement is not answered by one bullet', () => {
  const proposal = { experience: { amat: ['vision-fixture', 'robodk', 'cobot-rack', 'amr', 'neuro-t'], acme: ['robotic-line'], makerspace: ['production'], sae: ['baja', 'troubleshoot', 'coach'] } };
  const capped = applyPlan(base(), proposal, { pool, job: OTHER });
  assert.equal(keysOf(capped.spec, 'sae').length, 2, 'the standing cap is two');

  const emphasised = applyPlan(base(), { ...proposal, emphasise: ['sae'] }, { pool, job: OTHER });
  assert.equal(keysOf(emphasised.spec, 'sae').length, 3, 'a posting that names Baja gets three');
});

test('OVER BUDGET, THE EMPHASISED ORG IS THE LAST TO LOSE A LINE', () => {
  const { spec } = applyPlan(base(), {
    experience: {
      amat: ['vision-fixture', 'neuro-t', 'robodk', 'cobot-rack', 'amr', 'iiot'],
      acme: ['robotic-line', 'coil-savings', 'docs', 'plant-layout'],
      makerspace: ['production', 'fabrication'],
      sae: ['baja', 'troubleshoot', 'coach'],
    },
    emphasise: ['sae'],
  }, { pool, job: OTHER });
  const total = spec.experience.reduce((n, e) => n + e.bullets.length, 0);
  assert.ok(total <= MAX_BULLETS, `${total} lines is within the page budget`);
  assert.equal(keysOf(spec, 'sae').length, 3, 'the org the posting leans on keeps its lines');
});

// -- THE PHRASE THE POSTING ASKED FOR (F-436) ---------------------------

// The 6 DOF arm (2026-09-15): "for coordinated motion across a 420 mm working
// reach" is in the full wording; the short form says "over a 420 mm reach".
test('A PROJECT PRINTS IN FULL - the short form belongs to the fit loop, not to the default', () => {
  const { spec } = applyPlan(base(), { projects: ['robotic-arm'] }, { pool, job: OTHER });
  const arm = spec.projects[0];
  assert.equal(arm.text, pool.projects['robotic-arm'].text, 'the full wording reaches the page');
  assert.match(arm.text, /coordinated motion/, 'and with it the phrase a motion-control posting asks for');
  assert.equal(arm.short, pool.projects['robotic-arm'].short, 'the short form is kept beside it');
});

test('shortenOneProject spends the short form - unless the phrase is protected', () => {
  const { spec } = applyPlan(base(), { projects: ['robotic-arm'] }, { pool, job: OTHER });
  const spent = shortenOneProject(spec, []);
  assert.equal(spent.shortened, 'robotic-arm');
  assert.ok(!/coordinated motion/.test(spent.spec.projects[0].text));

  const held = shortenOneProject(spec, ['coordinated motion']);
  assert.equal(held.shortened, null, 'the layout may not spend a phrase the posting named');
  assert.match(held.spec.projects[0].text, /coordinated motion/);
});

test('a project that ends on a stub takes its short form, like a bullet', () => {
  const { spec } = applyPlan(base(), { projects: ['robotic-arm'] }, { pool, job: OTHER });
  const tight = shortenBulletEnding(spec, '420 mm working reach.', []);
  assert.equal(tight.shortened, 'robotic-arm');
  assert.equal(tight.spec.projects[0].text, pool.projects['robotic-arm'].short);
  assert.equal(shortenBulletEnding(spec, '420 mm working reach.', ['coordinated motion']).shortened, null, 'never at the cost of a protected phrase');
});

test('protectedPhrases keeps only what his own wordings actually say', () => {
  const { spec } = applyPlan(base(), { projects: ['robotic-arm'] }, { pool, job: OTHER });
  const kept = protectedPhrases(spec, ['coordinated motion', 'lidar calibration rig', 'ab', '']);
  assert.deepEqual(kept, ['coordinated motion'], 'an invented phrase protects nothing');
});

test('BAJA STAYS REACHABLE: no base carries SAE now, but a posting that asks for it gets it', () => {
  const { spec, notes } = applyPlan(base(), {
    experience: { amat: ['vision-fixture', 'robodk', 'cobot-rack', 'amr', 'neuro-t'], acme: ['robotic-line'], makerspace: ['production'], rover: ['gripper'], sae: ['baja'] },
  }, { pool, job: OTHER });
  assert.deepEqual(keysOf(spec, 'sae'), ['baja']);
  assert.deepEqual(keysOf(spec, 'rover'), ['gripper']);
  assert.ok(!notes.some((n) => /sae/.test(n)), notes.join(' | '));
});

test('dropsProtected compares the two wordings, not the posting', () => {
  assert.equal(dropsProtected('a soldered wire harness here', 'a harness here', ['soldered wire harness']), true);
  assert.equal(dropsProtected('a soldered wire harness here', 'soldered wire harness', ['soldered wire harness']), false);
  assert.equal(dropsProtected('anything', 'anything else', []), false);
});

// HIS ORDER, 2026-09-23: "amat, acme then makerspace then dispensable baja and
// projects" — he kept seeing Makerspace run longer than Acme Steel.
test('Acme Steel never runs shorter than Makerspace — it grows while there is room', () => {
  const { spec, notes } = applyPlan(base(), {
    experience: { amat: ['vision-fixture', 'robodk', 'neuro-t', 'amr', 'iiot'], acme: ['robotic-line'], makerspace: ['production', 'fabrication'] },
  }, { pool, job: OTHER });
  assert.ok(keysOf(spec, 'acme').length >= keysOf(spec, 'makerspace').length, JSON.stringify({ acme: keysOf(spec, 'acme'), makerspace: keysOf(spec, 'makerspace') }));
  assert.ok(notes.some((n) => /Acme Steel never runs shorter than Makerspace/.test(n)));
});

test('spare room goes to Acme Steel before Applied Materials or Makerspace', () => {
  const { spec } = applyPlan(base(), {
    experience: { amat: ['vision-fixture', 'robodk', 'neuro-t', 'amr', 'iiot'], acme: ['robotic-line'], makerspace: ['production'] },
  }, { pool, job: OTHER });
  const r = reserveFor(spec, pool, []);
  assert.match(r[0], /^acme\./, r.join(', '));
  const firstMakerspace = r.findIndex((k) => k.startsWith('makerspace.'));
  const lastAcme = r.findLastIndex((k) => k.startsWith('acme.'));
  assert.ok(firstMakerspace === -1 || firstMakerspace > lastAcme, r.join(', '));
});

test('…even when the model proposes a Makerspace line first', () => {
  const { spec } = applyPlan(base(), {
    experience: { amat: ['vision-fixture', 'robodk', 'neuro-t', 'amr', 'iiot'], acme: ['robotic-line'], makerspace: ['production'] },
  }, { pool, job: OTHER });
  const r = reserveFor(spec, pool, ['makerspace.fabrication', 'acme.coil-savings']);
  assert.ok(r.indexOf('acme.coil-savings') < r.indexOf('makerspace.fabrication'), r.join(', '));
});
