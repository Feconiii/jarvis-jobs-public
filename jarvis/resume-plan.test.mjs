// jarvis/resume-plan.test.mjs — the model may choose; it may not invent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpec, loadPool } from './resume-variants.mjs';
import { applyPlan, reserveFor, withBullet, withoutOneBullet, ensureProofs, mergeInsteadOf, isOwnCompany, ownCompanyTitle, MIN_AMAT, MIN_AMAT_JUSTIFIED, MAX_BULLETS, shortenOneBullet, shortenOneProject, shortenBulletEnding, dropsProtected, protectedPhrases } from './resume-plan.mjs';

const pool = loadPool();
const base = () => buildSpec('manufacturing', pool);
const keysOf = (spec, org) => spec.experience.find((e) => e.orgKey === org).bullets.map((b) => b.provenanceKey.split('.')[1]);
const OTHER = { company: 'Lam Research', title: 'Mechanical Engineer 2' };

test('a good proposal is applied in full — titles, order, projects, coursework, skills', () => {
  const { spec, notes, changed } = applyPlan(base(), {
    titles: { amat: 'Robotics Automation Engineer Intern', acme: 'Process Improvement Intern' },
    experience: { amat: ['robodk', 'cobot-rack', 'vision-fixture', 'neuro-t', 'amr'], acme: ['robotic-line', 'docs'], makerspace: ['supervise'], sae: ['coach'] },
    projects: ['robotic-arm'],
    coursework: ['System Dynamics and Control', 'Mechanical Design', 'Circuit Analysis', 'Python Programming', 'Machine Design'],
    skills: [{ key: 'automation', items: ['RoboDK', 'Universal Robots', 'Python'] }, { key: 'cad', items: ['SolidWorks', 'GD&T'] }, 'process'],
  }, { pool, job: OTHER });
  // The plan does not name the rover, so it is left off (his rule, 2026-11-04) — the only note.
  assert.deepEqual(notes.filter((n) => !/^rover: left off/.test(n)), []);
  assert.ok(!spec.experience.some((e) => e.orgKey === 'rover'));
  assert.equal(spec.experience[0].title, 'Robotics Automation Engineer Intern');
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

test('Acme Steel carries no automation or robotics title; Applied Materials says robotics AUTOMATION (his words, 2026-09-27)', () => {
  // "i didnt design any robots, i integrated them"
  for (const t of ['Automation Engineer Intern', 'Robotics Engineer Intern', 'Robotics Automation Engineer Intern']) {
    const { spec } = applyPlan(buildSpec('automation', pool), { titles: { acme: t } }, { pool, job: OTHER });
    assert.equal(spec.experience[1].title, 'Manufacturing Engineer Intern', `Acme Steel refuses "${t}"`);
  }
  const amat = applyPlan(buildSpec('automation', pool), { titles: { amat: 'Robotics Engineer Intern' } }, { pool, job: OTHER });
  assert.notEqual(amat.spec.experience[0].title, 'Robotics Engineer Intern', 'the old robot-designer title is gone');
  const ok = applyPlan(buildSpec('automation', pool), { titles: { amat: 'Robotics Automation Engineer Intern' } }, { pool, job: OTHER });
  assert.equal(ok.spec.experience[0].title, 'Robotics Automation Engineer Intern');
});

test('anything outside the pool is dropped and said so', () => {
  const { spec, notes } = applyPlan(base(), {
    titles: { amat: 'Senior Process Engineer', acme: 'Process Improvement Intern' },
    experience: { amat: ['vision-fixture', 'neuro-t', 'robodk', 'amr', 'iiot', 'plc-programming'], acme: ['robotic-line'], makerspace: ['production'], sae: ['baja'] },
    projects: ['drone-swarm', 'piston-fea'],
    coursework: ['Plasma Physics', 'Mechanical Design', 'Machine Design', 'Heat Transfer', 'Thermodynamics'],
    skills: [{ key: 'cad', items: ['SolidWorks', 'KeyShot'] }, { key: 'devops', items: ['Linux'] }, { key: 'process', items: ['Root Cause Analysis'] }],
  }, { pool, job: OTHER });
  assert.equal(spec.experience[0].title, 'Manufacturing Engineer Intern', 'an unapproved title keeps the family default');
  assert.equal(spec.experience[1].title, 'Process Improvement Intern');
  assert.ok(!keysOf(spec, 'amat').includes('plc-programming'));
  assert.deepEqual(spec.projects.map((p) => p.key), ['piston-fea']);
  assert.ok(!/Plasma/.test(spec.education[0].bullets.find((b) => b.lead === 'Relevant Coursework').text));
  assert.equal(spec.skills.length, 2);
  assert.equal(spec.skills[0].text, 'SolidWorks');
  for (const bad of ['Senior Process Engineer', 'plc-programming', 'drone-swarm', 'Plasma Physics', 'KeyShot', 'devops']) {
    assert.ok(notes.some((n) => n.includes(bad)), `must report "${bad}"`);
  }
});

test('the staples, the Applied Materials floor and the one-cell rule hold whatever is proposed', () => {
  const { spec, notes } = applyPlan(base(), {
    experience: { amat: ['robodk', 'cobot-cell', 'iiot'], acme: ['coil-savings'], makerspace: ['production', 'fabrication', 'supervise'], rover: [], sae: [] },
  }, { pool, job: OTHER });
  const amat = keysOf(spec, 'amat');
  // ONE staple since 2026-09-09: the mechanical-design fixture. Neuro-T is a
  // strong default the tailorer may spend when the posting pays better
  // elsewhere, not a fixture (F-437).
  assert.ok(amat.includes('vision-fixture'), 'the mechanical-design staple is restored');
  assert.ok(amat.length >= MIN_AMAT, `at least ${MIN_AMAT} Applied Materials bullets`);
  assert.ok(!(amat.includes('robodk') && amat.includes('cobot-cell')), 'the cell is described once');
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

  const mech = applyPlan(buildSpec('mechanical', pool), { titles: { amat: 'Robotics Automation Engineer Intern' } }, { pool, job: { company: 'Applied Materials', title: 'Mechanical Engineer NCG' } });
  assert.equal(mech.spec.experience[0].title, 'Mechanical Engineer Intern');
  assert.ok(mech.notes.some((n) => /official title/.test(n)));
  const proc = applyPlan(buildSpec('automation', pool), { titles: { amat: 'Automation Engineer Intern' } }, { pool, job: { company: 'Applied Materials', title: 'Manufacturing Automation Engineer' } });
  assert.equal(proc.spec.experience[0].title, 'Manufacturing Engineer Intern', 'an automation role at Applied is still the official manufacturing title');
  // …and Acme Steel's title is still free to match the job there.
  const sc = applyPlan(buildSpec('automation', pool), { titles: { acme: 'Process Improvement Intern' } }, { pool, job: { company: 'Applied Materials', title: 'Robotics Engineer' } });
  assert.equal(sc.spec.experience[1].title, 'Process Improvement Intern');
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

test('a tailored page keeps its argument: no small-work filler, no Applied Materials line it argued off (2026-10-26)', () => {
  const b = base();
  const r = reserveFor(b, pool, ['makerspace.supervise'], { tailored: true, amatCapped: true });
  assert.ok(r.includes('makerspace.supervise'), 'the plan\'s own reserve is offered (after any Acme Steel line still waiting — his order)');
  assert.ok(!r.some((k) => k.startsWith('amat.')), 'amat was argued down; the filler does not put it back');
  assert.ok(!r.includes('acme.packaging') && !r.includes('acme.docs'), 'small work is not reached for');
  const reserved = reserveFor(b, pool, ['acme.docs', 'amat.neuro-t'], { tailored: true, amatCapped: true });
  assert.ok(!reserved.includes('acme.docs') && !reserved.includes('amat.neuro-t'), 'not even from the model\'s own reserve');
  const family = reserveFor(b, pool, []);
  assert.ok(family.includes('acme.packaging') || b.experience.some((e) => e.bullets.some((x) => x.provenanceKey === 'acme.packaging')), 'a family base fills as before');
});

test('the reserve is what is left, in order, never the surplus line and never the other half of a pair', () => {
  const b = base();
  const r = reserveFor(b, pool, ['acme.docs', 'amat.cobot-cell', 'nope.x', 'acme.surplus']);
  assert.equal(r[0], 'acme.docs', 'the model\'s order is honoured');
  assert.ok(!r.includes('amat.cobot-cell'), 'robodk is on the page, so the combined cell bullet is not offered');
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

// The 6 DOF arm (2026-09-15): "for coordinated motion across a 65 cm working
// reach" is in the full wording; the short form says "over a 65 cm reach".
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
  const tight = shortenBulletEnding(spec, 'fused 12 V power distribution.', []);
  assert.equal(tight.shortened, 'robotic-arm');
  assert.equal(tight.spec.projects[0].text, pool.projects['robotic-arm'].short);
  assert.equal(shortenBulletEnding(spec, 'fused 12 V power distribution.', ['coordinated motion']).shortened, null, 'never at the cost of a protected phrase');
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

// Alex, 2026-09-29: the RoboDK bullet and the rack bullet print separately,
// and "combine them when space is tight and you still want to hit cobot work".
test('a tight page says the RoboDK and rack bullets as one instead of dropping either', () => {
  const b = applyPlan(base(), {
    experience: { amat: ['vision-fixture', 'robodk', 'neuro-t', 'cobot-rack', 'iiot', 'amr'], acme: ['robotic-line'], makerspace: ['fabrication'], rover: [], sae: [] },
  }, { pool, job: OTHER }).spec;
  const out = mergeInsteadOf(b, 'amat.amr', pool);
  assert.ok(out, 'a cut from Applied Materials merges when both halves are on the page');
  assert.deepEqual(keysOf(out.spec, 'amat'), ['vision-fixture', 'cobot-cell', 'neuro-t', 'iiot', 'amr'], 'the merged bullet takes the first half\'s place; nothing else moves');
  assert.equal(mergeInsteadOf(b, 'acme.robotic-line', pool), null, 'a cut from another organisation is left alone');
  // Next the fixture and the vision model are said as one (2026-10-27), then nothing is left.
  const out2 = mergeInsteadOf(out.spec, 'amat.amr', pool);
  assert.deepEqual(keysOf(out2.spec, 'amat'), ['vision-system', 'cobot-cell', 'iiot', 'amr'], 'the fixture and the vision model become one bullet');
  assert.equal(mergeInsteadOf(out2.spec, 'amat.amr', pool), null, 'nothing left to merge');
  const oneHalf = { ...b, experience: b.experience.map((e) => (e.orgKey === 'amat' ? { ...e, bullets: e.bullets.filter((x) => x.provenanceKey !== 'amat.cobot-rack' && x.provenanceKey !== 'amat.neuro-t') } : e)) };
  assert.equal(mergeInsteadOf(oneHalf, 'amat.amr', pool), null, 'both halves must be on the page');
});

test('the combined cobot bullet never sits beside either half', () => {
  for (const pair of [['robodk', 'cobot-cell'], ['cobot-rack', 'cobot-cell']]) {
    const { spec } = applyPlan(base(), {
      experience: { amat: ['vision-fixture', ...pair, 'neuro-t', 'iiot', 'amr'], acme: ['robotic-line'], makerspace: ['fabrication'], rover: [], sae: [] },
    }, { pool, job: OTHER });
    const amat = keysOf(spec, 'amat');
    assert.ok(amat.includes(pair[0]) && !amat.includes('cobot-cell'), `${pair[0]} is kept, cobot-cell is not printed beside it`);
  }
});

test('a line cited as proof of a duty or must-have is put on the page, and cut last (2026-10-27)', () => {
  const b = base();
  const cov = [
    { id: 'R1', need: 'duty', proof: 'acme.docs' },
    { id: 'R2', need: 'must', proof: 'project: piston-fea' },
    { id: 'R3', need: 'nice', proof: 'acme.packaging' },
    { id: 'R4', need: 'must', proof: 'skills: Python' },
  ];
  const { spec, added, protect } = ensureProofs(b, cov, pool);
  assert.ok(keysOf(spec, 'acme').includes('docs'), 'the cited bullet is on the page');
  assert.ok(!added.includes('acme.packaging'), 'a nice-to-have does not force a line on');
  assert.ok(spec.projects.some((p) => p.key === 'piston-fea') && spec.projects.length === 2, 'the cited project takes an uncited one\'s place');
  assert.ok(added.includes('acme.docs') && added.includes('project:piston-fea'));
  assert.deepEqual([...protect], ['acme.docs']);
  // Cutting: everything else in Acme Steel goes before the cited line.
  let cur = spec; const gone = [];
  for (let i = 0; i < 6; i++) { const out = withoutOneBullet(cur, protect); if (!out.dropped) break; gone.push(out.dropped); cur = out.spec; if (out.dropped === 'acme.docs') break; }
  const acmeGone = gone.filter((k) => k.startsWith('acme.'));
  assert.ok(!acmeGone.length || acmeGone[acmeGone.length - 1] === 'acme.docs' || !acmeGone.includes('acme.docs'), 'acme.docs is never cut while another Acme Steel line could be');
});

test('a project whose pool entry names what the posting asks for is put on the page (Coherent CAM)', () => {
  const b = { ...base(), projects: [] };
  const { spec, added } = ensureProofs(b, [], pool, 'CAM (MasterCam, SurfCam, GibbsCam) and CMM experience');
  assert.ok(spec.projects.some((p) => p.key === 'cnc-cardholder'));
  assert.ok(added.includes('project:cnc-cardholder'));
  const none = ensureProofs({ ...base(), projects: [] }, [], pool, 'Design camera mounts in SolidWorks');
  assert.ok(!none.added.includes('project:cnc-cardholder'), '"camera" is not CAM');
});

test('the Mars Rover Team goes on only when the plan asks for it (his rule, 2026-11-04)', () => {
  for (const family of ['manufacturing', 'robotics', 'design', 'process']) {
    let b;
    try { b = buildSpec(family, pool); } catch { continue; }   // a family this pool does not have
    if (!b.experience.some((e) => e.orgKey === 'rover')) continue;
    const silent = applyPlan(b, { experience: { amat: keysOf(b, 'amat') } }, { pool, job: OTHER }).spec;
    assert.ok(!silent.experience.some((e) => e.orgKey === 'rover'), `${family}: a plan that says nothing about the rover leaves it off`);
    const asked = applyPlan(buildSpec(family, pool), { experience: { amat: keysOf(b, 'amat'), rover: ['gripper'] } }, { pool, job: OTHER }).spec;
    assert.deepEqual(keysOf(asked, 'rover'), ['gripper'], `${family}: a plan that names it keeps it`);
  }
});

test('an untailored build (no plan) leaves the rover off too, and still reads as the family base (first mate, 2026-11-04)', () => {
  for (const family of ['manufacturing', 'robotics', 'design', 'process']) {
    let b;
    try { b = buildSpec(family, pool); } catch { continue; }
    if (!b.experience.some((e) => e.orgKey === 'rover')) continue;
    for (const plan of [null, undefined, {}, { titles: {} }]) {
      const { spec, notes, changed } = applyPlan(buildSpec(family, pool), plan, { pool, job: OTHER });
      assert.ok(!spec.experience.some((e) => e.orgKey === 'rover'), `${family}: no plan, no rover`);
      assert.ok(notes.some((n) => /^rover: left off/.test(n)), 'said so in the notes');
      assert.ok(!changed.includes('experience:rover'), 'not counted as tailoring: the NOT TAILORED warning still shows');
      for (const e of spec.experience) if (e.orgKey !== 'rover') assert.deepEqual(keysOf(spec, e.orgKey), keysOf(b, e.orgKey), `${family}: ${e.orgKey} unchanged`);
    }
  }
});
