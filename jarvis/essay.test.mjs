// jarvis/essay.test.mjs — the written questions.
//
// His ask, 2026-09-09: forms that say "tell us about a project you are proud
// of" or "why should we hire you" need an answer written for them, the same
// way the resume and the cover letter are. Everything here is about the two
// things that can go wrong with that: writing about work he has not done, and
// writing an answer to a question that was never the model's to answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import {
  answerKind, offLimits, isWrittenQuestion, targetWords, checkAnswer,
  buildAnswerPrompt, writeAnswer, KINDS, OFF_LIMITS, SLOP_SHAPES, BURIED_OPENINGS, CLOSER_SHAPES, splitReading,
  seriesIndex, groupSeries, needsJudgment,
} from './apply/essay.mjs';
import { sourcesFor } from './cover-letter.mjs';
import { JUDGMENT_MODELS } from './tailor-llm.mjs';
import { parseReview, reviewFeedback, buildReviewPrompt, REVIEW_QUESTIONS } from './apply/answer-review.mjs';
import { companyBrief } from './company-context.mjs';
import * as LIMITS from './apply/essay.mjs';

const CV = `# Alex Rivera
Mechanical Engineer Intern at Applied Materials, Austin, Texas.
Designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor.
Acme Steel Stud Company, Mechanical Engineer Intern, Springfield.
Identified a magazine feeding issue that reduced jams by 70%.
An Excel VBA macro to automate tolerance parsing, worth roughly $57,000 in annual material savings.
Programmed a Universal Robots collaborative robot in RoboDK.
State University, Bachelor of Science: Mechanical Engineering, May 2027.`;
const JOB = { company: 'Applied Intuition', title: 'Mechanical Engineer - New Grad' };
const JD = 'You will design custom test fixtures and perform structural and thermal analysis. SolidWorks preferred. Baja SAE experience welcome.';

// ── WHAT IS A WRITTEN QUESTION ─────────────────────────────────────────

test('the question kinds are told apart, and the specific ones win', () => {
  const of = (q) => answerKind(q)?.kind ?? null;
  assert.equal(of('Tell us about a project you are proud of'), 'project');
  assert.equal(of('Why do you want to work at Applied Intuition?'), 'why-company');
  assert.equal(of('What interests you most about this role?'), 'why-role');
  assert.equal(of('Why should we hire you?'), 'why-you');
  assert.equal(of('Describe a time when you disagreed with a teammate'), 'challenge');
  assert.equal(of('What are your career goals?'), 'goals');
  assert.equal(of('Anything else you would like us to know?'), 'other');
  // Not questions at all.
  assert.equal(of('First name'), null);
  assert.equal(of('LinkedIn URL'), null);
  assert.equal(of('City'), null);
});

// TSMC asked "What motivates you to explore career opportunities at TSMC?" and
// this list matched NOTHING, so it got the generic brief and came back as a JD
// summary with an internship bullet after it. Alex: *"Motivation questions are
// about desire and direction first, evidence second. Fit questions are about
// evidence first. Do not confuse the two."*
test('a motivation question is not a fit question', () => {
  const of = (q) => answerKind(q)?.kind ?? null;
  assert.equal(of('What motivates you to explore career opportunities at TSMC?'), 'motivation');
  assert.equal(of('What drives you to apply here?'), 'motivation');
  assert.equal(of('What is your motivation for applying?'), 'motivation');
  // The questions that ask for EVIDENCE keep their own kinds — a first draft of
  // the pattern above took both of these.
  assert.equal(of('What interests you most about this role?'), 'why-role');
  assert.equal(of('What makes you a strong candidate?'), 'why-you');
  assert.equal(of('Why do you want to work at Applied Intuition?'), 'why-company');
  // Found by the regression run: a fit question with a modal verb the list did
  // not have. It fell to `other`, which meant it also fell to the cheaper
  // model — the classification and the routing fail together.
  assert.equal(of('We are a small team and everyone wears several hats. Why would you be a good fit here?'), 'why-you');
  assert.equal(of('Why would you be a good fit?'), 'why-you');
  assert.equal(of('Why are you a good fit for this role?'), 'why-you');
});

// His instruction, 2026-09-19: *"Use Opus as the PRIMARY model… Use Sonnet only
// as the fallback… NO HAIKU FALLBACK"* for open-ended answers, decided by what
// the task requires rather than by a list of question strings.
test('an answer that needs judgement is routed to Opus, never Haiku', () => {
  assert.equal(JUDGMENT_MODELS[0], 'opus', 'Opus is primary');
  assert.equal(JUDGMENT_MODELS[1], 'sonnet', 'Sonnet is the fallback');
  assert.ok(!JUDGMENT_MODELS.includes('haiku'), 'Haiku is never on this ladder');

  // Every kind where the writer has to build an argument and choose what to
  // leave out.
  for (const kind of ['cover-letter', 'why-company', 'why-role', 'why-you', 'motivation', 'project', 'challenge', 'excellence', 'contribution', 'strength', 'goals']) {
    assert.equal(needsJudgment(kind, { target: 80 }), true, `${kind} needs judgement`);
  }
  // A long open box is a selection problem even when its kind is "other" —
  // TSMC's 500-character experience question is the case he named where the
  // facts were right and the selection was poor.
  assert.equal(needsJudgment('other', { target: 80, question: 'Please share your experience in the semiconductor industry' }), true);
  assert.equal(needsJudgment('other', { target: 0, question: 'Describe your coursework' }), true, 'asked to describe');
  // …and short factual extraction stays on the cheaper, faster ladder.
  assert.equal(needsJudgment('other', { target: 6, question: 'Expected graduation date' }), false);
  assert.equal(needsJudgment('other', { target: 0, question: 'Highest degree' }), false);
  assert.equal(needsJudgment(null, { target: 0, question: 'Availability' }), false);
});

test('the model that actually wrote the answer is reported', async () => {
  const seen = [];
  const ask = async (_prompt, opts) => {
    seen.push(opts?.models || null);
    if (opts?.meta) { opts.meta.requested = 'opus'; opts.meta.model = 'sonnet'; opts.meta.fellBack = true; opts.meta.fallbacks = [{ model: 'opus', why: 'out of credit' }]; }
    return 'READING\nnothing\n\nPLAN\nnothing\n\nANSWER\nI designed a fixture, which is why this team would not have to.';
  };
  const r = await writeAnswer('Why do you want to work at Acme?', { ask, retries: 0, review: null, job: { company: 'Acme' } });
  assert.deepEqual(seen[0], JUDGMENT_MODELS, 'a why-company box asks for the judgement ladder');
  assert.equal(r.model.judgment, true);
  assert.equal(r.model.requested, 'opus');
  assert.equal(r.model.used, 'sonnet');
  assert.equal(r.model.fellBack, true, 'he can see that a weaker model wrote it');
  assert.equal(r.model.fallbacks[0].why, 'out of credit');
});

// GRADIENT ROBOTICS, 2026-09-19: "Tell us a technical project you built and the
// hardest problem you hit building it." The answer described the project in full
// and never said what was hard. His reading: *"still too much of a project
// inventory… it barely answers the part Gradient is probably using to judge
// you: what went wrong, what constraint made the project hard, and how you
// engineered around it."*
test('a question that asks what was hard must be answered with an obstacle', () => {
  const q = 'Tell us a technical project you built and the hardest problem you hit building it';
  assert.equal(answerKind(q)?.kind, 'project', 'and "tell us" without "about" is still a project question');

  // The inventory answer: every feature, no obstacle.
  const inventory = 'I took a machine vision inspection fixture from design through release. '
    + 'It checks lift pin alignment on 3 Metal Deposition chamber variants at Applied Materials. '
    + 'I designed the fixture in Autodesk Inventor with self-locking camera positioning, controlled lighting, '
    + '120-degree indexing using ball plungers, dovetail interfaces and error-proofing features, and I ran a '
    + 'tolerance analysis. I then prototyped and validated it, created the engineering drawings and BOM, '
    + 'ordered the components from suppliers, and released the design through Teamcenter.';
  const flagged = checkAnswer(inventory, { kind: 'project', question: q, cvText: CV })
    .problems.filter((p) => /asks what was hard/.test(p));
  assert.equal(flagged.length, 1, 'a project inventory does not answer "what was hardest"');

  // The same project WITH the constraint that forced each choice.
  const withObstacle = 'At Applied Materials I built a machine-vision inspection fixture for three Metal '
    + 'Deposition chamber variants. The hardest problem was making the camera position repeatable: the fixture '
    + 'had to work across three variants and index between three positions, but the available 3D printer was '
    + 'too small to manufacture it as one piece. I redesigned it as four mechanically joined components using '
    + 'dovetail interfaces, avoiding adhesives because it runs in a cleanroom, and used tolerance analysis to '
    + 'control the interfaces that affected camera placement.';
  assert.deepEqual(
    checkAnswer(withObstacle, { kind: 'project', question: q, cvText: CV }).problems.filter((p) => /asks what was hard/.test(p)),
    [], 'an answer that names the obstacle passes');

  // It fires on the ways a form asks this, and never on a question that is not
  // asking it — a redo costs 40 to 180 seconds and must be earned.
  for (const asks of ['Describe a challenge you faced', 'What was the most difficult part?', 'Tell us about a problem you solved']) {
    assert.ok(checkAnswer(inventory, { kind: 'project', question: asks, cvText: CV })
      .problems.some((p) => /asks what was hard/.test(p)), `"${asks}" asks what was hard`);
  }
  assert.deepEqual(
    checkAnswer(inventory, { kind: 'project', question: 'Tell us about a project you are proud of', cvText: CV })
      .problems.filter((p) => /asks what was hard/.test(p)),
    [], 'a plain project question is not asking for an obstacle');
});

test('a motivation answer that is mostly past work is caught', () => {
  const kind = 'motivation';
  const job = { company: 'TSMC' };
  const cvText = 'Applied Materials. Pressure decay logging fixture. Qualification. Arizona. United States. Semiconductor.';
  // His own example of the pattern he wants stopped: company context, then a
  // resume paragraph, then a sentence of JD keywords.
  const bad = 'TSMC Arizona is building advanced fabs. '
    + 'At Applied Materials I designed a pressure decay logging fixture and I built the automation around it to capture leak rates across tools. '
    + 'I ran that fixture through qualification and I reduced the manual logging time on every run. '
    + 'I want to contribute to expanding capacity with speed and quality.';
  const flagged = checkAnswer(bad, { kind, job, cvText }).problems.filter((p) => /description of his past work/.test(p));
  assert.equal(flagged.length, 1, 'the resume-heavy motivation answer is reported');

  // And his better reasoning, which leads with direction and uses the
  // experience only to explain why the interest is real, is left alone.
  const good = 'My time at Applied Materials made me realise I enjoy semiconductor manufacturing because the work sits at the intersection of equipment, automation, process control, troubleshooting and high precision production. '
    + 'TSMC is attractive because it would let me go deeper into that environment at much greater scale and learn how advanced fabs actually operate. '
    + 'I want to spend the early part of my career somewhere the process window is tight enough that the details matter.';
  const clean = checkAnswer(good, { kind, job, cvText }).problems.filter((p) => /description of his past work/.test(p));
  assert.equal(clean.length, 0, 'experience that explains the motivation is not the same fault');

  // A SENTENCE THAT PIVOTS FROM THE WORK TO WHAT HE WANTS IS MOTIVATION.
  // Counting it whole as past work pushed a good 72-word answer to 39% and
  // bought a redo it did not need (measured on the live TSMC box, 2026-09-19).
  const pivot = 'I want to build my career in semiconductor manufacturing, where equipment and automation meet production. '
    + 'At Applied Materials I helped deploy AMRs in a cleanroom and installed a UR cobot, and I want to go deeper into that work inside a production fab. '
    + 'TSMC Arizona is bringing up new fabs, and I am eager to help install and qualify tools as the site ramps.';
  assert.deepEqual(
    checkAnswer(pivot, { kind, job, cvText }).problems.filter((p) => /description of his past work/.test(p)),
    [], 'a sentence that turns from what he did to what he wants is not a resume line');
});

test('"WHY <COMPANY>?" IS THE COMMONEST FORM OF THE QUESTION, and it was missed', () => {
  // Read off his own Applied Intuition form on 2026-09-09: "Why Applied
  // Intuition?" sat in the panel's "5 left for you" list. The first version of
  // this classifier only caught "why do you want to work here/us/at X" — a
  // bare "Why <something>?" has no verb in it for that pattern to hook on.
  const of = (q, co) => answerKind(q, co ? { company: co } : undefined)?.kind ?? null;

  assert.equal(of('Why Applied Intuition?'), 'why-company');
  assert.equal(of('Why Applied Intuition'), 'why-company');
  assert.equal(of('Why Tesla?'), 'why-company');
  assert.equal(of('Why us?'), 'why-company');

  // The bare pattern sits after why-you, so the more specific one still wins.
  assert.equal(of('Why should we hire you?'), 'why-you');
  assert.equal(of('Why this role?'), 'why-role');

  // And it does not swallow questions that merely start with "why".
  assert.equal(of('Why are you leaving your current role?'), null);
  assert.equal(of('Why did you choose that approach?'), null);
});

test('THE EMPLOYER TRAVELS WITH THE QUESTION, so a form that asks by name is caught', () => {
  const co = 'Applied Intuition, Inc.';
  const of = (q) => answerKind(q, { company: co })?.kind ?? null;

  // No general pattern can tell a company name from any other noun.
  assert.equal(of('What excites you about Applied Intuition?'), 'why-company');
  // …but NOT "how did you hear about us" — that is a fact only he has, and the
  // model would have had to invent it. Refused outright (see OFF_LIMITS).
  assert.equal(of('Tell us how you heard about Applied Intuition'), null);
  assert.equal(of('How did you hear about us?'), null);
  assert.equal(of('Where did you find this posting?'), null);

  // A CLOSED question naming the same company is a yes or a no, and belongs to
  // the answer table, not here (F-376).
  assert.equal(of('Have you ever worked at Applied Intuition?'), null);
  assert.equal(of('Are you currently employed by Applied Intuition?'), null);

  // Without the company, the same open question is not about the company.
  assert.equal(answerKind('What excites you about Applied Intuition?'), null);

  // The refusal still comes first, company or no company.
  assert.equal(answerKind('Please describe your disability status', { company: co }), null);
});

test('EVERY KIND CARRIES A BRIEF — the prompt is told what shape of answer it is', () => {
  for (const [kind, , brief] of KINDS) {
    assert.ok(brief && brief.length > 15, `${kind} needs a brief the prompt can use`);
  }
});

test('a one-line input is never an essay, however its label reads', () => {
  // Two hundred words into a single-line box is worse than leaving it blank.
  assert.equal(isWrittenQuestion({ type: 'text', label: 'Why should we hire you?' }), false);
  assert.equal(isWrittenQuestion({ type: 'text', multiline: true, label: 'Why should we hire you?' }), true);
  assert.equal(isWrittenQuestion({ type: 'textarea', label: 'Why should we hire you?' }), true);
  // …unless the form itself sized it for prose.
  assert.equal(isWrittenQuestion({ type: 'text', maxLength: 1000, label: 'Why should we hire you?' }), true);
  // A prose box asking something factual stays the answer table's.
  assert.equal(isWrittenQuestion({ type: 'textarea', label: 'Street address' }), false);
});

test('ANY OPEN WRITING BOX GETS AN ANSWER — the patterns shape it, they do not gate it', () => {
  // His rule, 2026-09-09: "it doesn't have to be a question, it should simply
  // be anything that is an open form for writing… if it doesn't match the
  // common questions that script usually handles."
  //
  // The first version had this backwards and only wrote for labels matching a
  // known pattern, which is how "Why Applied Intuition?" reached his panel as
  // a thing he had to type himself (F-441).
  const box = (label) => ({ type: 'text', multiline: true, label });
  const co = { company: 'Applied Intuition' };

  // No known kind between them, and every one is a box he was asked to write in.
  for (const label of [
    'What is your favourite thing you have built and why',
    'Your thoughts on our product',
    'Tell us something a resume would not show',
    'Additional comments',
    'Which part of the stack interests you most?',
  ]) {
    assert.equal(isWrittenQuestion(box(label), co), true, `"${label}" is a writing box`);
  }

  // The refusal still wins over the box, which is the whole reason this is not
  // simply "is it a textarea".
  for (const label of [
    'Please describe your disability status',
    'How did you hear about us?',
    'Tell us about your salary expectations',
    'Describe your notice period',
  ]) {
    assert.equal(isWrittenQuestion(box(label), co), false, `"${label}" is never written`);
  }

  // A box with nothing asked in it is a box, not a question. Writing two
  // hundred words into one is how this would start producing noise.
  assert.equal(isWrittenQuestion(box('')), false);
  assert.equal(isWrittenQuestion(box('Notes')), false);

  // And an unrecognised question still gets a kind the prompt can use.
  const { kind } = { kind: answerKind('Your thoughts on our product', co)?.kind ?? 'other' };
  assert.equal(kind, 'other');
});

// ── WHAT IT MUST NEVER ANSWER ──────────────────────────────────────────

test('SELF-IDENTIFICATION, PAY, REFERENCES AND BACKGROUND ARE NEVER WRITTEN', () => {
  // Caught by this test before it ever ran: the answer table refuses these by
  // tightly anchored rule ("^disability status$"), so a prose box asking the
  // same thing in a sentence matched nothing and fell through to the writer.
  const never = [
    'Please describe your disability status',
    'Tell us about your veteran status',
    'Describe your racial or ethnic background',
    'What are your gender pronouns?',
    'Tell us about your salary expectations',
    'What is your expected compensation?',
    'Describe your notice period',
    'When can you start?',
    'Tell us about your references',
    'Who referred you to this role?',
    'Please describe any criminal convictions',
    'Describe your visa status and sponsorship needs',
    'How did you hear about us?',
    'Tell us how you heard about this role',
  ];
  for (const q of never) {
    assert.equal(offLimits(q), true, `"${q}" must be off limits`);
    assert.equal(answerKind(q), null, `"${q}" must not be classified`);
    assert.equal(isWrittenQuestion({ type: 'textarea', label: q }), false, `"${q}" must not be planned`);
  }
});

test('the refusal does not swallow the questions it should answer', () => {
  for (const q of [
    'Tell us about a project you are proud of',
    'Why do you want to work here?',
    'Describe a technical challenge you solved',
    'What would you bring to the team?',
  ]) {
    assert.equal(offLimits(q), false, `"${q}" is answerable`);
    assert.ok(answerKind(q), `"${q}" must be classified`);
  }
});

test('OFF_LIMITS is a list of real patterns, not an empty gesture', () => {
  assert.ok(OFF_LIMITS.length >= 5);
  for (const re of OFF_LIMITS) assert.ok(re instanceof RegExp);
});

// ── HOW LONG ───────────────────────────────────────────────────────────

test('the length comes from the form when the form says, and from the question when it does not', () => {
  // The box's own limit wins, with room to spare so nothing is clipped.
  const boxed = targetWords({ maxLength: 500 }, 'project');
  assert.ok(boxed.max * 6.5 < 500, 'the answer fits inside the box it goes in');

  // A stated limit in the label wins over everything.
  const said = targetWords({ label: 'In 150 words, why us?' }, 'why-company');
  assert.equal(said.max, 150);

  // No limit at all: a project answer earns more room than "why us".
  assert.ok(targetWords({}, 'project').max > targetWords({}, 'why-company').max);
});

// ── THE GUARD ──────────────────────────────────────────────────────────

test('AN HONEST ANSWER PASSES, and its figures come with it', () => {
  // This fixture used to end "Both taught me that a fixture is only as good as
  // the measurement it makes possible" — a moral, which is the exact thing he
  // objected to, and SLOP_SHAPES now fails it. The rule caught the test, which
  // is the rule working. Ends the way HE ends instead: naming the work.
  const good = 'At Applied Materials I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor. '
    + 'The work required me to hold camera positioning repeatable across variants that did not share a mounting interface. '
    + 'At Acme Steel I found a magazine feeding issue on a robotic assembly line that reduced jams by 70% once it was fixed. '
    + 'Both sit close to the design and validation responsibilities this role describes.';
  const r = checkAnswer(good, { cvText: CV, jd: JD, job: JOB, target: { min: 40, max: 120 }, question: 'Tell us about a project you are proud of' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('REFUSES A TOOL HE NEVER USED — the JD-keyword trap, in prose', () => {
  const bad = 'I have calibrated lidar and radar units on autonomous vehicles using Velodyne test rigs, and I built the harness myself.';
  const r = checkAnswer(bad, { cvText: CV, jd: JD, job: JOB, question: 'Tell us about a project' });
  assert.ok(r.problems.some((p) => /Velodyne/i.test(p)), r.problems.join(' | '));
  assert.equal(r.ok, false);
});

test('REFUSES AN INVENTED FIGURE', () => {
  const bad = 'I reduced cycle time by 42% on the assembly line at Applied Materials and saved the team considerable effort.';
  const r = checkAnswer(bad, { cvText: CV, jd: JD, job: JOB });
  assert.ok(r.problems.some((p) => /42/.test(p)), r.problems.join(' | '));
});

test('HIS OWN FIGURES ARE WELCOME — unlike the cover letter', () => {
  // The letter carries no numbers because none of his eleven do. A question
  // about a project he is proud of is answered better with them.
  const r = checkAnswer('I found a magazine feeding issue that reduced jams by 70% once it was fixed.', { cvText: CV, jd: JD, job: JOB });
  assert.ok(!r.problems.some((p) => /70/.test(p)), r.problems.join(' | '));
});

test('NEVER APOLOGISES FOR A GAP (F-408), BUT MAY ANSWER ONE (F-460)', () => {
  // F-408 banned self-negation outright. Alex then wrote the answer he says
  // would get him the job, 2026-09-13, and it names a gap on purpose:
  // "I do not yet have direct high-volume molding experience, but I have
  // repeatedly been placed in unfamiliar manufacturing systems, learned them
  // quickly, and improved both the equipment and the process around it."
  //
  // So the rule is no longer "never"; it is "once, answered in the same
  // sentence, and never last". The apology and the pivot are the same words up
  // to the comma, and every case below turns on what comes after it.
  const apologies = [
    'I am new to automotive work. I designed a fixture for three chamber variants.',
    'I lack formal training in thermal analysis. I designed a fixture for three chamber variants.',
    'While I have limited experience in vehicle systems, I learn quickly. I designed a fixture.',
  ];
  for (const bad of apologies) {
    const r = checkAnswer(bad, { cvText: CV, jd: JD, job: JOB });
    assert.equal(r.ok, false, `"${bad}" must fail`);
    assert.ok(r.problems.some((x) => /without turning it|more than once|last thing the reader sees/.test(x)),
      r.problems.join(' | '));
  }

  // A gap as the LAST thing in the box sells against him however it opened.
  const endsOnIt = 'I designed a fixture for three chamber variants. I have not worked with lidar, but I have designed fixtures.';
  assert.ok(checkAnswer(endsOnIt, { cvText: CV, jd: JD, job: JOB }).problems
    .some((x) => /last thing the reader sees/.test(x)));

  // Twice is an apology however each one is phrased.
  const twice = 'I have not worked with lidar, but I have designed fixtures. I do not yet have thermal experience, but I have run tolerance analysis. I designed a fixture.';
  assert.ok(checkAnswer(twice, { cvText: CV, jd: JD, job: JOB }).problems
    .some((x) => /more than once/.test(x)));

  // HIS OWN SHAPE PASSES. This is the sentence he wrote.
  const his = 'I designed a machine vision inspection fixture for three chamber variants. '
    + 'I do not yet have direct high-volume molding experience, but I have repeatedly been placed in '
    + 'unfamiliar manufacturing systems, learned them quickly, and improved both the equipment and the '
    + 'process around it. At Acme Steel I traced recurring jams to a magazine feeding issue.';
  const ok = checkAnswer(his, { cvText: `${CV} molding unfamiliar systems Acme Steel magazine feeding jams`, jd: JD, job: JOB });
  assert.deepEqual(ok.problems.filter((x) => /turning it|more than once|last thing/.test(x)), [],
    'the pivot he wrote himself must pass');
});

test('the machine tells fail it: banned words, markdown, an em dash, talking to the form', () => {
  const cases = [
    ['I would leverage my experience at Applied Materials.', /leverage/],
    ['**Applied Materials** taught me to design fixtures.', /markdown/],
    ['At Applied Materials — a great place — I designed fixtures.', /em dash/],
    ['Here is my answer: at Applied Materials I designed fixtures.', /talking to the form/],
  ];
  for (const [text, expect] of cases) {
    const r = checkAnswer(text, { cvText: CV, jd: JD, job: JOB });
    assert.ok(r.problems.some((p) => expect.test(p)), `${text} → ${r.problems.join(' | ')}`);
  }
});

test('an empty answer is a failure, not a pass', () => {
  assert.equal(checkAnswer('', { cvText: CV }).ok, false);
  assert.equal(checkAnswer('   ', { cvText: CV }).ok, false);
});

test('length is judged against the box, not against a hunch', () => {
  const short = checkAnswer('I designed a fixture.', { cvText: CV, target: { min: 90, max: 160 } });
  assert.ok(short.problems.some((p) => /too short/.test(p)));
  const long = checkAnswer(new Array(400).fill('fixture').join(' '), { cvText: CV, target: { min: 90, max: 160 } });
  assert.ok(long.problems.some((p) => /too long/.test(p)));
});

// ── THE PROMPT ─────────────────────────────────────────────────────────

test('HIS NOTE STEERS AND CANNOT ADD A FACT', () => {
  const p = buildAnswerPrompt({
    question: 'Why should we hire you?', job: JOB, cvText: CV,
    request: 'lead with the Baja car work',
  });
  assert.match(p, /lead with the Baja car work/);
  assert.match(p, /only source of facts about him: never add a tool, number, result/);
});

// ── HIS PIPELINE AND HIS SEVEN QUESTIONS, 2026-09-16 ─────────────────────

test('ONE BRIEF, NOT A PROCEDURE — his CV, the job, the company, his rules, the question', () => {
  // 2026-09-17: the four-call pipeline took 220s; he asked for one call with
  // the context in front of it. These are the things that brief must carry.
  const p = buildAnswerPrompt({
    question: 'Evidence of Excellence', job: { company: 'Tesla', title: 'Manufacturing Engineer' },
    cvText: CV, jd: JD, companyBrief: 'Team on the posting: Manufacturing',
    target: { min: 150, max: 260 },
  });
  assert.match(p, /CURRENT FIELD\nQuestion: Evidence of Excellence/);
  assert.match(p, /machine vision inspection fixture/, 'his CV');
  assert.match(p, /custom test fixtures/, 'the posting');
  assert.match(p, /WHAT JARVIS KNOWS ABOUT TESLA[\s\S]*Team on the posting: Manufacturing/);
  assert.match(p, /only source of facts about him: never add a tool, number, result, sequence of events or motive/);
  assert.match(p, /Tesla or SpaceX style roles/, 'register by company');
  // The prompt teaches the CONSTRUCTION now, not just what to avoid: a claim
  // first, the facts subordinated under it, and a long box may close on what
  // the evidence has in common (2026-09-19).
  assert.match(p, /THE FIRST SENTENCE IS A CLAIM ABOUT WHAT KIND OF ENGINEER HE IS/);
  assert.match(p, /COMPRESSION IS PRIORITISATION/);
  assert.match(p, /may close on what the evidence has in common/);
  assert.match(p, /What is still banned is the EMPTY close/);
  assert.match(p, /150 to 260 words/);
  assert.match(p, /fifty other applicants/, 'his check list, asked in the same call');
  assert.match(p, /REPLY IN EXACTLY TWO PARTS:\n\nPLAN\n/);
  assert.match(p, /believe: The reader should finish this answer believing that Alex \.\.\./);
  assert.match(p, /evidence: the cv\.md lines this answer rests on, each copied exactly from cv\.md/);
  assert.match(p, /parts: every separate thing the question and its instructions ask for/);
  assert.match(p, /===ANSWER===\nthe text for the box, and nothing else\./);
  assert.ok(p.length < 30000, `the brief stays compact: ${p.length} chars`);
});

test('HIS REASONING RULES ARE IN EVERY PROMPT, verbatim — 2026-09-17', () => {
  for (const question of ['Evidence of Excellence', 'Why Tesla?', 'Tell us about a project you are proud of', 'Anything else?']) {
    const p = buildAnswerPrompt({ question, job: { company: 'Tesla', title: 'ME' }, cvText: CV, jd: JD });
    assert.match(p, /BEFORE WRITING - DO THIS INTERNALLY/);
    assert.match(p, /"The reader should finish this answer believing that Alex __________\."/);
    assert.match(p, /Then select the smallest number of confirmed experiences necessary to prove that claim\./);
    assert.match(p, /Do not put this reasoning in the answer\. Write it only in the PLAN below, which is stripped before anyone sees the answer\./);
    assert.match(p, /APPLICATION STRATEGY\n\nApplication answers are persuasive arguments, not resume summaries\./);
    assert.match(p, /\* which 1-3 confirmed experiences best prove it/);
    assert.match(p, /Never invent technical details\. Relevance may be inferred; facts may not\./);
    assert.match(p, /Choose the opening based on the persuasive argument, not just question type\./);
    assert.match(p, /Do not mechanically begin with "At Applied Materials\.\.\." because the question is experience-related\./);
    assert.doesNotMatch(p, /Open on what he did and what came of it/, 'the old opening rule is gone');
  }
});

test('THE CURRENT FIELD carries the form instructions, its limits and HIS request — the Charge Robotics box', () => {
  const field = { label: 'Brief Cover Letter', near: 'Brief Cover Letter Tell us why you want to build robots that build solar farms. No more than 200 words.', placeholder: 'Type here', maxLength: 0, value: '' };
  const p = buildAnswerPrompt({
    question: 'Brief Cover Letter', kind: 'cover-letter', brief: 'a short cover letter', job: { company: 'Charge Robotics', title: 'Mechanical Engineer' },
    cvText: CV, jd: JD, field, context: field.near, request: 'bro answer all of this', target: targetWords(field, 'cover-letter'),
  });
  assert.match(p, /Question: Brief Cover Letter\nInstructions: Tell us why you want to build robots that build solar farms\. No more than 200 words\./, 'the question is not repeated inside its instructions');
  assert.match(p, /Placeholder: Type here/);
  assert.match(p, /Word limit: 200/);
  assert.match(p, /Length to write: 120 to 200 words \(the form limit is a hard ceiling\)/, 'the form limit beats the cover-letter default of 150-250');
  assert.match(p, /User request: "bro answer all of this"/);
  assert.match(p, /This box is a cover letter/);
});

test('THE PRIVATE PLAN never reaches the box, and must rest on lines really in cv.md', async () => {
  const plan = 'PLAN\nasking: whether he can own a piece of hardware end to end, so this is mostly evidence\nreader: a hiring manager\nbelieve: The reader should finish this answer believing that Alex can take a fixture from design to release\nparts: why the role, best evidence\nevidence:\n- "Designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor."\nwhy these: the posting is design-heavy\nomit: the Acme Steel jam analysis — it proves diagnosis, which this box is not asking about\nopening: the claim\n===ANSWER===\n';
  const answer = 'I can take a design from CAD to released hardware. I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor, and it is the closest work I have to the custom test fixtures this team builds.';
  assert.deepEqual(LIMITS.splitReading(plan + answer).text, answer, 'only the answer goes in the box');
  assert.deepEqual(LIMITS.planProblems(LIMITS.splitReading(plan + answer).reading, CV), []);
  const invented = plan.replace('Designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor.', 'Led a 12 person team qualifying a new etch chamber for high volume production at Intel.');
  assert.match(LIMITS.planProblems(LIMITS.splitReading(invented + answer).reading, CV).join(' '), /not in cv\.md/);
  assert.deepEqual(LIMITS.planProblems('', CV), [], 'no plan at all is let through');

  // THE TWO DECISIONS THE WRITER KEPT SKIPPING. Alex, 2026-09-19: *"it
  // retrieves relevant facts and writes them down without making the
  // higher-level editorial decision."* The prompt had asked for both in prose
  // and kept getting concatenated bullets, because nothing checked.
  const without = (line) => LIMITS.planProblems(
    LIMITS.splitReading(plan.split('\n').filter((l) => !l.startsWith(line)).join('\n') + answer).reading, CV).join(' ');
  assert.match(without('asking:'), /what this question is evaluating/,
    'a plan that never decided what the question is asking for is sent back');
  assert.match(without('omit:'), /what was left out/,
    'and so is one that chose nothing');
  // "NONE" is a real answer for a box too short to have held anything else.
  const omitNone = LIMITS.planProblems(
    LIMITS.splitReading(plan.replace(/^omit:.*$/m, 'omit: NONE') + answer).reading, CV);
  assert.deepEqual(omitNone, [], 'a genuinely short box may leave nothing out');

  // THE ONE THING ROUND 2 STILL GOT WRONG: an invented REASON, in his own
  // vocabulary, about his own project. Lam's answer explained that a fixture
  // had to do something "which a single fixed mount could not do once I
  // accounted for the tolerance stack-up" — nothing in cv.md says that.
  //
  // A word-level test cannot separate that from the truth, and it was measured
  // rather than assumed: the invented clause has ONE word absent from cv.md
  // ("single"), a true sentence about the Acme Steel jam has three ("repeated",
  // "corner", "panel"). So the writer declares what it could not source, and a
  // declaration is a redo.
  const withRisk = (said) => LIMITS.planProblems(
    LIMITS.splitReading(plan.replace('opening: the claim', `opening: the claim\nunsupported: ${said}`) + answer).reading, CV);
  assert.deepEqual(withRisk('NONE'), [], 'NONE passes');
  assert.deepEqual(withRisk('none.'), [], 'and so does none with a full stop');
  assert.deepEqual(withRisk('(none)'), [], 'and parenthesised');
  assert.deepEqual(withRisk('N/A'), [], 'and N/A');
  assert.deepEqual(withRisk(''), [], 'an empty declaration is not an accusation');
  const flagged = withRisk('"which a single fixed mount could not do once I accounted for the tolerance stack-up"');
  assert.match(flagged.join(' '), /could not source this from cv\.md/, 'a quoted claim is sent back');
  assert.match(flagged.join(' '), /single fixed mount/, 'and its own words are the feedback');

  // AND IT MUST SURVIVE A LONG PLAN. `reading` is clipped to 1,200 characters
  // for the "why this answer" panel, and `unsupported:` is the plan's LAST
  // field — on a real Gradient Robotics plan the evidence section alone ran
  // past 1,000 characters, so the declaration was clipped off before the check
  // could read it and the check silently could not fire.
  const padded = plan.replace('why these: the posting is design-heavy',
    `why these: ${'the posting is design-heavy and the fixture is the closest match to it. '.repeat(20)}`)
    .replace('opening: the claim', 'opening: the claim\nunsupported: "which a single fixed mount could not do"');
  const split = LIMITS.splitReading(padded + answer);
  assert.ok(split.reading.length <= 1200, 'the displayed plan is still clipped');
  assert.ok(split.plan.length > 1200, 'the whole plan is kept for the checks');
  assert.deepEqual(LIMITS.planProblems(split.reading, CV), [], 'the clipped copy cannot see the declaration');
  assert.match(LIMITS.planProblems(split.plan, CV).join(' '), /could not source this/, 'the whole plan can');
  const r = await writeAnswer('Why are you a good fit?', { job: JOB, jd: JD, retries: 0, sources: { cvText: CV, narrative: {} }, ask: async () => plan + answer });
  assert.equal(r.text, answer);
  assert.match(r.reading, /believe: The reader should finish/, 'the plan is kept for "why this answer"');
});

test('A FIT OR MOTIVATION ANSWER MAY NOT OPEN ON A RESUME LINE; a story may', () => {
  const body = 'At Applied Materials I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor.';
  assert.ok(checkAnswer(body, { cvText: body, kind: 'why-you', job: JOB }).problems.some((x) => /opens on a resume line/.test(x)));
  assert.ok(checkAnswer(body, { cvText: body, kind: 'excellence', job: JOB }).problems.some((x) => /opens on a resume line/.test(x)));
  assert.ok(!checkAnswer(body, { cvText: body, kind: 'project', job: JOB }).problems.some((x) => /opens on a resume line/.test(x)));
  const own = 'At Applied Intuition the team builds simulation for autonomy, and I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants.';
  assert.ok(!checkAnswer(own, { cvText: own, kind: 'why-company', job: JOB }).problems.some((x) => /opens on a resume line/.test(x)), 'opening on the employer he is applying to is not a resume line');

  // …AND THE SAME BULLET WITH THE EMPLOYER MOVED TO THE END OF THE SENTENCE.
  // Measured on the live Agility "why are you a good fit" box, 2026-09-17: the
  // check above wants a sentence that STARTS on the employer, so this walked
  // through it, and the answer then listed two more projects without ever
  // saying what the reader should conclude.
  const opened = (text, kind) => checkAnswer(text, { cvText: CV, kind, job: JOB })
    .problems.some((x) => /opens on what he did/.test(x));
  const agility = 'I designed and released a machine vision inspection fixture end to end at Applied Materials, covering three chamber variants in Autodesk Inventor. I also translated RoboDK simulations into a physical UR collaborative robot installation.';
  assert.ok(opened(agility, 'why-you'), 'a bare accomplishment opening a why-you answer is still a bullet');
  assert.ok(opened(agility, 'excellence'), 'and an excellence answer');
  assert.ok(opened(agility, 'cover-letter'), 'and a cover letter');
  assert.ok(!opened(agility, 'project'), 'a story may open on the work');
  // A box that is not asking him to make a case may open on a plain fact;
  // forcing an argument there would buy a 40-180s redo for nothing.
  assert.ok(!opened(agility, 'other'), 'a plain "tell us anything else" box is left alone');
  assert.ok(!opened(agility, 'goals'), 'and so is "where do you see yourself"');
  // The same fact IS an argument when the sentence says what it means here.
  assert.ok(!opened('I designed and released a machine vision inspection fixture end to end, which is exactly the loop this role runs on. Then the rest.', 'why-you'),
    'a claim in the same sentence is not a bullet');
  assert.ok(!opened('I can take a fixture from CAD to released hardware on my own. At Applied Materials I did exactly that.', 'why-you'),
    'and an answer that opens on the claim is untouched');
});

test('AN ANSWER THAT KEEPS ADDING PROJECTS reads as a list and goes back', () => {
  const list = 'I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants. I also programmed a Universal Robots collaborative robot in RoboDK. I also identified a magazine feeding issue that reduced jams by 70%.';
  assert.ok(checkAnswer(list, { cvText: CV }).problems.some((x) => /reads as a list of work/.test(x)));
  const one = 'I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants. I also ran the tolerance analysis for it.';
  assert.ok(!checkAnswer(one, { cvText: `${CV} ran the tolerance analysis` }).problems.some((x) => /reads as a list of work/.test(x)), 'one add-on is ordinary prose');
});

test('fieldLimits reads the form, and the check holds the answer to it', () => {
  const { fieldLimits } = LIMITS;
  assert.deepEqual(fieldLimits({ near: 'Please keep it under 1,000 characters' }), { words: 0, chars: 1000 });
  assert.deepEqual(fieldLimits({ near: '(200-word limit)' }), { words: 200, chars: 0 });
  assert.deepEqual(fieldLimits({ maxLength: 500, near: '' }), { words: 0, chars: 500 });
  assert.deepEqual(fieldLimits({ wordLimit: 150 }), { words: 150, chars: 0 });
  const long = Array.from({ length: 210 }, () => 'fixture').join(' ');
  assert.ok(checkAnswer(long, { cvText: long, limits: { words: 200, chars: 0 } }).problems.some((x) => /over the form's 200-word limit/.test(x)));
});

test('TRAVEL AND RELOCATION ARE ALLOWED WHEN THE POSTING ASKS FOR THEM', () => {
  const text = 'At Applied Materials I designed a machine vision inspection fixture. I am open to travel to the field sites.';
  const asked = checkAnswer(text, { cvText: text, jd: 'Are open to 10-15% travel to field sites. Based in or can relocate to the SF Bay Area.' });
  assert.ok(!asked.problems.some((x) => /travel, where he is based/.test(x)));
  const notAsked = checkAnswer(text, { cvText: text, jd: 'Design fixtures in SolidWorks.' });
  assert.ok(notAsked.problems.some((x) => /travel, where he is based/.test(x)));
});

// THE CLOSER RULE WAS REVERSED ON 2026-09-19, and this test is the record.
//
// It used to refuse any last sentence that pointed back at the role or said
// what he would bring, because on 2026-09-16 he called exactly that sentence
// filler. On 2026-09-19 he set the opposite instruction — *"emulate the writing
// style… overwrite all the rules necessary, we dont want to be bound by rules
// we want max effectiveness"* — and the answer he rates highest ends on the
// banned shape. An argument may close an answer; an empty flourish may not.
test('an answer may close on what it argues, but never on a flourish', () => {
  const body = 'At Applied Materials I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor. ';
  const ends = (closer) => checkAnswer(body + closer, { cvText: CV, job: { company: 'Tesla' } })
    .problems.some((x) => /ends on /.test(x));

  // ALLOWED now: saying what the work amounts to, and what he would do here.
  assert.equal(ends('That is the experience I would bring to designing, commissioning and improving manufacturing equipment here.'), false);
  assert.equal(ends('Across these roles I have learned unfamiliar equipment quickly and turned diagnosis into measured production changes.'), false);

  // STILL REFUSED: the closers that could end any answer at any company.
  for (const slop of [
    'Both results came from the same approach to engineering problems.',
    'Overall, these projects show what I can do.',
    'What I learned is that attention to detail matters.',
  ]) {
    assert.ok(ends(slop), `still refused: ${slop}`);
  }
  // A tie-back INSIDE an evidence sentence remains the strongest form.
  assert.equal(ends('The fixture automated the same pin alignment check this posting lists.'), false);
});

test('THE REVIEW is read fail-open, and names what sends an answer back', () => {
  assert.equal(parseReview('not json at all'), null);
  const r = parseReview('```json\n{"checks":[{"n":1,"fails":false,"why":"specific"},{"n":3,"fails":true,"why":"three bullets in a row"},{"n":7,"fails":true,"why":"x"}],"unsupported":["reduced cycle time by 40%"],"fix":"argue one claim"}\n```');
  assert.equal(r.passes, false);
  assert.deepEqual(r.failed.map((c) => c.n), [3], 'question 7 is carried by unsupported, not by a rewrite');
  const told = reviewFeedback(r);
  assert.match(told, /SENT IT BACK/);
  assert.match(told, /resume bullets restated[\s\S]*three bullets in a row/);
  assert.match(told, /Remove them[\s\S]*reduced cycle time by 40%/);
  assert.equal(parseReview('{"checks":[{"n":1,"fails":false}],"unsupported":[]}').passes, true);
  const prompt = buildReviewPrompt({ question: 'Evidence of Excellence', answer: 'A', job: { company: 'Tesla', title: 'ME' }, cvText: CV });
  for (const [n] of REVIEW_QUESTIONS) assert.match(prompt, new RegExp(`\\n${n}\\. `));
});

test('writeAnswer REWRITES an answer the reader sends back, and flags a claim it kept', async () => {
  const first = 'At Applied Materials I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor.';
  const second = 'At Acme Steel I identified a magazine feeding issue that reduced jams by 70% on a line built around custom test fixtures.';
  const prompts = [];
  const ask = async (p) => { prompts.push(p); return prompts.length === 1 ? first : second; };
  const r = await writeAnswer('Evidence of Excellence', {
    job: JOB, jd: JD, retries: 0, ask,
    sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' },
    review: async ({ answer }) => ({
      passes: false, failed: [{ n: 2, fails: true, why: 'could go to any company' }],
      unsupported: ['reduced jams by 70%'], fix: 'tie it to the posting',
    }),
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /SENT IT BACK[\s\S]*could go to any company/);
  assert.ok(prompts[1].includes(first), 'the rewrite sees what was sent back');
  assert.equal(r.text, second);
  assert.ok(r.problems.some((x) => /reduced jams by 70%.*no support/.test(x)), 'a flagged claim still in the box is a problem');
  assert.deepEqual(r.review.failed, [2]);
  // No reviewer given with a stubbed model: no review call at all.
  let calls = 0;
  await writeAnswer('Evidence of Excellence', { job: JOB, jd: JD, retries: 0, sources: { cvText: CV, narrative: {} }, ask: async () => { calls += 1; return first; } });
  assert.equal(calls, 1);
});

test('THE COMPANY BRIEF is context from the store, never a claim', () => {
  const b = companyBrief({
    job: { id: 'x', company: 'Tesla Inc', team: 'Manufacturing', field: 'industrial' },
    tracked: [{ name: 'Tesla, Inc.', notes: 'Target: Optimus' }],
    others: [{ title: 'Robotics Manufacturing Engineer, Optimus', team: 'Manufacturing' }, { title: 'Manufacturing Engineer, Stator', team: 'Tesla AI' }],
  });
  assert.match(b, /Team on the posting: Manufacturing/);
  assert.match(b, /never content for the box\): Target: Optimus/);
  assert.match(b, /Open roles Jarvis has seen at Tesla Inc: 2/);
  assert.match(b, /Teams hiring there: Manufacturing, Tesla AI/);
  assert.equal(companyBrief({ job: null }), '');
});

test('A REVISION PUTS THE REJECTED ANSWER AND EVERY NOTE IN FRONT OF THE WRITER', async () => {
  const rejected = 'Both pieces of work took automation equipment from concept to deployment.';
  const p = buildAnswerPrompt({
    question: 'Evidence of Excellence', job: JOB, cvText: CV,
    previous: rejected, feedback: ['too generic', 'cut the last sentence'],
  });
  assert.match(p, /DID NOT LIKE IT/);
  assert.ok(p.includes(rejected), 'the text he rejected is shown');
  assert.match(p, /"too generic"[\s\S]*"cut the last sentence"/, 'notes oldest first');
  assert.match(p, /can never add a fact that\s+is not in cv\.md/);
  assert.doesNotMatch(p, /ALEX'S NOTE FOR THIS ANSWER/, 'the note is not said twice');
  // No notes, no revision block — a first answer is not told it was rejected.
  assert.doesNotMatch(buildAnswerPrompt({ question: 'Why?', job: JOB, cvText: CV, previous: rejected }), /DID NOT LIKE IT/);
  // And writeAnswer carries both through to the model.
  let seen = '';
  await writeAnswer('Evidence of Excellence', {
    job: JOB, jd: JD, previous: rejected, feedback: ['too generic'], retries: 0,
    sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' },
    ask: async (prompt) => { seen = prompt; return 'At Applied Materials I designed a machine vision inspection fixture.'; },
  });
  assert.ok(seen.includes(rejected) && seen.includes('"too generic"'));
});

// ── END TO END, with the model stubbed ─────────────────────────────────

test('writeAnswer asks, checks, and hands back the problems it could not clear', async () => {
  const drafts = [
    'I have calibrated Velodyne lidar units on test vehicles, which is exactly what this role asks for.',
    'At Applied Materials I designed a machine vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor, holding camera positioning repeatable across variants that did not share a mounting interface. '
    + 'The fixture had to survive being handled by people who were not the ones who designed it, so the positioning is self locking rather than adjustable. '
    + 'At Acme Steel I found a magazine feeding issue on a robotic assembly line that reduced jams by 70% once it was fixed, which came out of time studies rather than out of anyone reporting it. '
    + 'I also programmed a Universal Robots collaborative robot in RoboDK, which is where I learned how much of robot work is reachability rather than control. '
    // Ended "That is the work I want more of, and it is what this role asks
    // for." until 2026-09-16, when that stand-alone closer was banned.
    + 'The fixture is the closest thing I have built to the custom test fixtures in this posting.',
  ];
  let asked = 0;
  const ask = async (prompt) => {
    asked += 1;
    // The second ask must be told what was wrong with the first.
    if (asked === 2) assert.match(prompt, /FAILED THESE CHECKS/);
    return drafts[asked - 1];
  };
  const r = await writeAnswer('Tell us about a project you are proud of', {
    job: JOB, jd: JD, ask, sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' },
    // One call by default since 2026-09-17; the retry on a failed check is opt-in.
    field: { multiline: true }, retries: 1,
  });
  assert.equal(asked, 2, 'a failed draft is asked for once more, not looped on');
  assert.equal(r.kind, 'project');
  assert.match(r.text, /machine vision inspection fixture/);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('A DRAFT THAT NEVER PASSES STILL COMES BACK — with what is wrong with it', async () => {
  // He reads every one of these before Submit. A silent failure would leave a
  // required box blank on a form he thought was finished; a flawed answer he
  // can see is strictly better, and the panel shows him the problems.
  const ask = async () => 'I have calibrated Velodyne lidar units, which I would leverage here.';
  const r = await writeAnswer('Tell us about a project you are proud of', {
    job: JOB, jd: JD, ask, sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.text, 'the text still comes back');
  assert.ok(r.problems.length >= 2, r.problems.join(' | '));
  assert.match(r.why, /problem/);
});

test('A MODEL THAT THROWS COSTS HIM A BOX, NEVER THE APPLICATION', async () => {
  const ask = async () => { throw new Error('claude is not on PATH'); };
  const r = await writeAnswer('Why should we hire you?', {
    job: JOB, ask, sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
  assert.ok(r.why, 'and it says why');
});

test('no question is not an error worth throwing over', async () => {
  const r = await writeAnswer('', { job: JOB, ask: async () => 'x' });
  assert.equal(r.ok, false);
  assert.match(r.why, /no question/);
});


// -- HIS VOICE, 2026-09-09 ----------------------------------------------
// His words on a draft this file produced: "why you gotta include stupid corny
// shit like the last sentence… i hate the phrase 'that is exactly the kind of'
// and all the other typical ai phrasing you use". The sentence was an aphorism
// about fixtures followed by a tie-back to the posting. Not one banned WORD in
// it — the shape is the tell.

const HIS_SENTENCE = 'A fixture is finished only when someone else can build it, run it, and trust '
  + 'what it reports, and that is the standard the detailed design and error proofing in this role calls for.';

test('THE SENTENCE HE COMPLAINED ABOUT FAILS, and fails for its shape', () => {
  const hits = SLOP_SHAPES.filter(([re]) => re.test(HIS_SENTENCE));
  assert.ok(hits.length >= 2, `only ${hits.length} rule(s) caught it`);
  const r = checkAnswer(`Last summer I designed a fixture at Applied Materials. ${HIS_SENTENCE}`, { cvText: 'Applied Materials fixture' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /aphorism/.test(x)), r.problems.join(' | '));
});

test('NO RULE MAY FAIL HIS OWN WRITING — his eleven letters are the specification', () => {
  // The F-408 lesson, applied to shapes instead of words: a rule that fails
  // something he actually wrote is the wrong rule. Checked against the real
  // files, not a fixture, so a rule added later cannot quietly break this.
  const dir = 'cover-letters/his';
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  assert.ok(files.length >= 8, `expected his letters in ${dir}, found ${files.length}`);
  for (const f of files) {
    const text = readFileSync(`${dir}/${f}`, 'utf-8');
    for (const [re, said] of SLOP_SHAPES) {
      assert.equal(re.test(text), false, `${said} fires on his own letter ${f}`);
    }
  }
});

test('the tie-back HE writes passes', () => {
  // Straight out of his ASML letter: plain, specific, names what the role does.
  const good = 'At Applied Materials I designed a machine vision inspection fixture for three Metal '
    + 'Deposition chamber variants. This strengthened my understanding of how design decisions affect '
    + 'assembly, tolerances, and serviceability in real systems, directly supporting the design and '
    + 'integration responsibilities of this role.';
  const r = checkAnswer(good, { cvText: 'Applied Materials machine vision inspection fixture Metal Deposition chamber variants' });
  assert.deepEqual(r.problems.filter((x) => /aphorism|exactly|maxim|standard|moral/.test(x)), []);
});

test('seriesIndex reads the ordinal, and only where there is one', () => {
  assert.equal(seriesIndex('Second example:'), 2);
  assert.equal(seriesIndex('Third example:'), 3);
  assert.equal(seriesIndex('Example 2'), 2);
  assert.equal(seriesIndex('3.'), 3);
  assert.equal(seriesIndex('Why Neuralink?'), 0);
  assert.equal(seriesIndex('Tell us about a project'), 0);
});

test('A SERIES ANSWERS THE STEM, AND DIFFERS FROM ITS SIBLINGS', () => {
  const stem = 'Please provide three examples of accomplishments that highlight your exceptional ability. First example:';
  const grouped = groupSeries([
    { label: stem }, { label: 'Second example:' }, { label: 'Third example:' }, { label: 'Why Neuralink?' },
  ]);
  assert.equal(grouped[0].seriesIndex, 1);
  assert.equal(grouped[0].seriesOf, 3, 'it counted the three the form asked for');
  assert.equal(grouped[1].seriesIndex, 2);
  assert.equal(grouped[1].stem, stem, 'box two answers the question box one was told');
  assert.equal(grouped[2].seriesIndex, 3);
  // A field outside a series carries no series keys at all, rather than empty
  // ones — the server branches on `stem` being present.
  assert.equal(grouped[3].stem, undefined, 'an unrelated question is not swept into the group');
  assert.equal(grouped[3].after, undefined);
  assert.equal(grouped[3].seriesIndex, undefined);
});

test('the prompt for box two carries the stem AND what box one used', () => {
  const stem = 'Please provide three examples of accomplishments that highlight your exceptional ability.';
  const p = buildAnswerPrompt({
    question: 'Second example:', stem, seriesIndex: 2, seriesOf: 3,
    avoid: ['At Applied Materials I designed a machine vision inspection fixture.'],
    job: { company: 'Neuralink' }, cvText: 'cv',
  });
  assert.match(p, /three examples of accomplishments/, 'the stem is the question, not "Second example:"');
  assert.match(p, /box 2 of 3/);
  assert.match(p, /using DIFFERENT work from the earlier boxes/);
  assert.match(p, /machine vision inspection fixture/, 'it is told what box one already used');
  assert.match(p, /a separate, complete answer/);
});

test('writeAnswer classifies a series box on its stem, not its ordinal', async () => {
  let seen = '';
  const ask = async (prompt) => {
    seen = prompt;
    return 'At Acme Steel I found a magazine feeding issue on a robotic assembly line that reduced jams by 70% once it was fixed, '
      + 'which came out of time studies rather than from anyone reporting it. The work required reading the line for a fortnight '
      + 'before changing anything on it, and the change itself was small.';
  };
  const r = await writeAnswer('Second example:', {
    stem: 'Tell us about a project you are proud of', seriesIndex: 2, seriesOf: 3,
    avoid: ['the fixture'], job: { company: 'Neuralink' },
    ask, sources: { cvText: 'Acme Steel magazine feeding 70% robotic assembly line time studies', narrative: {}, voiceRules: '', framing: '' },
  });
  assert.equal(r.kind, 'project', '"Second example:" alone would classify as other');
  assert.match(seen, /box 2 of 3/);
});

// ── F-459: the pitch questions, and how an answer opens ─────────────

test('"EVIDENCE OF EXCELLENCE" IS A QUESTION, and it is a pitch', () => {
  // A two-word noun phrase with no verb in it matched nothing, fell through to
  // "a direct answer to exactly what was asked", and got an answer that opened
  // mid-thought on a design constraint. His words: "straight off the bat its
  // mumbling gibberish, no one gets what you are saying."
  for (const q of [
    'Evidence of Excellence',
    'step 1: Evidence of Excellence',
    'Please provide three examples of accomplishments that highlight your exceptional ability. First example:',
    'What makes you exceptional?',
    'Tell us about your proudest accomplishment',
  ]) {
    assert.equal(answerKind(q)?.kind, 'excellence', `"${q}" must read as a pitch question`);
  }
  // And it gets room to be one: he asked for "a cover letter ish where i flex
  // my work comprehensively", which does not fit in 150 words.
  const t = targetWords(null, 'excellence');
  assert.ok(t.min >= 150 && t.max >= 250, `excellence needs room, got ${JSON.stringify(t)}`);
  // A limit the form states still wins over that.
  assert.equal(targetWords({ label: 'Evidence of Excellence (100 words max)' }, 'excellence').max, 100);
});

test('the questions that already worked still classify as they did', () => {
  // `excellence` sits late in KINDS on purpose. If it started stealing these,
  // every one of them would get the wrong shape and the wrong length.
  assert.equal(answerKind('Tell us about a project you are proud of')?.kind, 'project');
  assert.equal(answerKind('Why should we hire you?')?.kind, 'why-you');
  assert.equal(answerKind('Why Amazon?')?.kind, 'why-company');
  assert.equal(answerKind('Describe a time when you disagreed with a teammate')?.kind, 'challenge');
});

test('THE OPENING HE CALLED GIBBERISH IS REFUSED', () => {
  // Verbatim from his Amazon form, 2026-09-13. Every fact in it is sourced;
  // the failure is that forty words in, the reader still does not know what he
  // built.
  const buried = 'Designing the machine vision inspection fixture for three Metal Deposition chamber variants at '
    + 'Applied Materials required identifying a lift pin misalignment that could contact and damage downstream '
    + 'hardware, so the classification logic behind it had to stay conservative about passing questionable cases.';
  const r = checkAnswer(buried, { cvText: buried });
  assert.ok(r.problems.some((p) => /know what he built/.test(p)), `not caught: ${JSON.stringify(r.problems)}`);

  // The same facts, opened on the claim. This must pass.
  const plain = 'I designed and prototyped a machine vision inspection fixture for three Metal Deposition chamber '
    + 'variants at Applied Materials, and it automated a lift pin alignment check that had previously been done by eye. '
    + 'Because a misaligned pin could contact and damage the heater, I built the classification logic to be conservative.';
  assert.deepEqual(checkAnswer(plain, { cvText: plain }).problems, []);

  // A prepositional opening is how he opens his own letters, and is fine.
  const prep = 'At Applied Materials I designed a machine vision inspection fixture for three chamber variants.';
  assert.deepEqual(checkAnswer(prep, { cvText: prep }).problems.filter((p) => /know what he built/.test(p)), []);
});

test('AND THE CLOSER A LONGER ANSWER INVITES IS REFUSED TOO', () => {
  // Written by the first excellence answer this file produced. Not an
  // aphorism, no banned word in it, and still the sentence he told me to stop
  // writing: it says what the work MEANS instead of ending on what it WAS.
  const closed = 'I designed a fixture for three chamber variants and it automated a check done by eye. '
    + 'At Acme Steel I ran time studies on a robotic assembly line. '
    + 'Both results came from the same approach: measure the process directly and fix the root cause rather than the symptom.';
  const r = checkAnswer(closed, { cvText: closed });
  assert.ok(r.problems.some((p) => /stops after the last fact/.test(p)), `not caught: ${JSON.stringify(r.problems)}`);

  // "both" and "the same" mid-answer are ordinary prose and must not fire.
  const mid = 'Both chamber variants used the same camera mount, and I designed the fixture so one setup covered them. '
    + 'I then ran tolerance analysis across the range of parts.';
  assert.deepEqual(checkAnswer(mid, { cvText: mid }).problems.filter((p) => /stops after the last fact/.test(p)), []);
});

test('NEITHER NEW RULE FAILS HIS OWN WRITING — the eleven letters again', () => {
  // The same guarantee SLOP_SHAPES carries. A rule that fails something he
  // actually wrote is the wrong rule, and the real files are read so a pattern
  // added later cannot quietly break it.
  const dir = 'cover-letters/his';
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  assert.ok(files.length >= 8, `expected his letters in ${dir}, found ${files.length}`);
  for (const f of files) {
    const text = readFileSync(`${dir}/${f}`, 'utf-8');
    for (const para of text.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p || /^(?:dear\b|sincerely|best regards|alex\b)/i.test(p)) continue;
      for (const [re, said] of BURIED_OPENINGS) {
        assert.equal(re.test(p), false, `"${said}" fires on a paragraph of his own letter ${f}`);
      }
    }
    const body = text.replace(/\s*(?:sincerely|best regards)[\s\S]*$/i, '');
    const last = (body.match(/[^.!?\n]+[.!?]*\s*$/) || [''])[0].trim();
    for (const [re, said] of CLOSER_SHAPES) {
      assert.equal(re.test(last), false, `"${said}" fires on the last line of his own letter ${f}`);
    }
  }
});

// ── F-460: the packet, not the pattern ─────────────────────────────

test('THE SAME QUESTION AT TWO COMPANIES IS TWO DIFFERENT PROMPTS', () => {
  // Same man, same question, different evidence — the difference has to come
  // from the packet, because nothing else changes.
  const ask = (job, jd) => buildAnswerPrompt({
    question: 'Evidence of Excellence', kind: 'excellence', brief: 'his case',
    cvText: 'fixture', job, jd,
  });
  const tesla = ask({ company: 'Tesla', title: 'Stator Molding, Optimus' }, 'high volume molding automation');
  const kla = ask({ company: 'KLA', title: 'Mechanical Design Engineer' }, 'precision subsystems, tolerance stack ups, release documentation');
  assert.notEqual(tesla, kla);
  assert.match(tesla, /high volume molding automation/);
  assert.match(kla, /tolerance stack ups/);
  assert.doesNotMatch(tesla, /tolerance stack ups/);
});

test('THE REST OF THE FORM IS PART OF THE SITUATION', () => {
  // A reader sees five boxes at once. A writer that sees one box at a time
  // tells the fixture story in all five.
  const p = buildAnswerPrompt({
    question: 'What would you bring to this team?', cvText: 'cv', job: { company: 'Tesla' },
    alsoWritten: [{ question: 'Evidence of Excellence', text: 'I designed a machine vision inspection fixture.' }],
  });
  assert.match(p, /Already answered on this application/);
  assert.match(p, /I designed a machine vision inspection fixture\./);
  assert.match(p, /do not repeat the same story/);
  // And with nothing else written, the block is absent rather than empty.
  assert.doesNotMatch(buildAnswerPrompt({ question: 'q', cvText: 'cv' }), /Already answered on this application/);
});

test('splitReading keeps the box clean, and never loses an answer', () => {
  const both = splitReading('READING\ntesting: whether he can build\nreader: a hiring manager\n===ANSWER===\nI designed a fixture.');
  assert.equal(both.text, 'I designed a fixture.', 'only the answer goes in the box');
  assert.match(both.reading, /testing: whether he can build/);
  assert.doesNotMatch(both.text, /READING|testing:/);

  // FAIL-OPEN. A model that ignores the format must not cost him the box.
  const bare = splitReading('I designed a fixture.');
  assert.equal(bare.text, 'I designed a fixture.');
  assert.equal(bare.reading, '');

  // And a fenced answer still unwraps.
  assert.equal(splitReading('\u0060\u0060\u0060\nI designed a fixture.\n\u0060\u0060\u0060').text, 'I designed a fixture.');
});

test('writeAnswer hands back the reading beside the answer', async () => {
  const ask = async () => 'READING\ntesting: whether he builds real things\nshape: the case, broadly\n===ANSWER===\nI designed a machine vision inspection fixture for three chamber variants.';
  const r = await writeAnswer('Convince us.', {
    job: { company: 'Tesla' },
    ask,
    sources: { cvText: 'machine vision inspection fixture three chamber variants', narrative: {}, voiceRules: '', framing: '' },
  });
  assert.equal(r.text, 'I designed a machine vision inspection fixture for three chamber variants.');
  assert.match(r.reading, /testing: whether he builds real things/);
});

// ── F-462: the answer is an argument, not a summary ─────────────────

test('AN ANSWER THAT NAMES NOTHING FROM THE POSTING IS REFUSED', () => {
  // The one item on his check list a machine can see. A floor, not a grade.
  const jd = 'We are hiring for stator molding automation on the Optimus line. You will own '
    + 'injection tooling, robotic handling cells, vision guided placement, precision gaging and '
    + 'the ramp from prototype tooling to high volume production. Cycle time, scrap rate and '
    + 'first pass yield are the numbers this team lives on, and you will run the trials that move '
    + 'them. You will work beside tooling suppliers and the maintenance crew on the floor.';
  const cv = 'At Applied Materials I designed a machine vision inspection fixture for three Metal '
    + 'Deposition chamber variants. At Acme Steel I traced a jam and cut the rate by 70 percent. '
    + 'I ran injection tooling trials and cut scrap rate on the line.';
  const generic = 'I am a mechanical engineering student who enjoys hard problems and learns quickly. '
    + 'I have worked on several engineering projects, taken ownership of my work, and delivered results '
    + 'for the teams I joined. I would bring that same energy here and I am eager to contribute.';
  const r = checkAnswer(generic, { cvText: cv, jd, job: { company: 'Tesla' } });
  assert.ok(r.problems.some((p) => /could be sent to another company/.test(p)), r.problems.join(' | '));

  // The same answer, anchored in one thing the posting actually asks for.
  const anchored = 'At Acme Steel I traced a jam on the line and cut the rate by 70 percent by measuring the '
    + 'process directly. At Applied Materials I ran injection tooling trials and cut the scrap rate. '
    + 'That is the work I would bring to stator molding on this team.';
  const r2 = checkAnswer(anchored, { cvText: cv, jd, job: { company: 'Tesla' } });
  assert.deepEqual(r2.problems.filter((p) => /could be sent to another company/.test(p)), []);
});

test('THE ANCHOR CHECK NEEDS A REAL POSTING TO READ — a title alone proves nothing', () => {
  // Half the store has no description. Refusing every answer written against a
  // title would fail him for the scanner's blind spot, not for his writing.
  const r = checkAnswer('I designed a machine vision inspection fixture for three chamber variants.', {
    cvText: 'machine vision inspection fixture three chamber variants',
    jd: 'Mechanical Engineer', job: { company: 'Tesla' },
  });
  assert.deepEqual(r.problems.filter((p) => /could be sent to another company/.test(p)), []);
});

/**
 * F-521 · A `maxlength` IS THE MOST THE BOX HOLDS, NOT HOW MUCH TO WRITE.
 *
 * `targetWords` computed the box's capacity BEFORE the kind's own band, so a
 * generous box raised a ceiling the kind had already set. Tesla's "Evidence of
 * Excellence" reports maxLength 2500 → 326 words, and three answers went out at
 * 317, 325 and 329 against his 150-260 — each logged as "passed the checks",
 * because checkAnswer only complains above 375. The same question on forms with
 * no maxlength produced 159-216.
 */
test('a generous maxlength cannot raise the kind\'s ceiling', () => {
  assert.deepEqual(targetWords({ maxLength: 2500 }, 'excellence'), { min: 150, max: 260 },
    'Tesla\'s box must not turn a 260-word answer into a 326-word one');
  assert.deepEqual(targetWords({}, 'excellence'), { min: 150, max: 260 },
    'and the band is the same with no box limit at all');
  assert.deepEqual(targetWords({ maxLength: 2500 }, 'cover-letter'), { min: 150, max: 250 });
  assert.deepEqual(targetWords({ maxLength: 2500 }, 'project'), { min: 110, max: 200 });
});

test('a TIGHTER maxlength still narrows it', () => {
  const tight = targetWords({ maxLength: 900 }, 'excellence');
  assert.ok(tight.max < 260, `a 900-char box must narrow the ceiling, got ${tight.max}`);
  // The floor comes down WITH the ceiling and lands below it. Clamping the
  // floor to the ceiling produced {min:117, max:117} — a band of exactly one
  // length, which no draft can hit.
  assert.ok(tight.min < tight.max, `the band must not collapse: ${JSON.stringify(tight)}`);

  const tiny = targetWords({ maxLength: 300 }, 'excellence');
  assert.ok(tiny.min < tiny.max, `and not on a very small box either: ${JSON.stringify(tiny)}`);
});

test('a limit the form STATES still beats both', () => {
  assert.deepEqual(targetWords({ label: 'Please keep it under 250 words' }, 'excellence'),
    { min: 150, max: 250 }, 'a stated word limit wins, wherever the form states it');
});

// F-539 (2026-09-23): all three prompts cut cv.md at 14,000 characters while
// the file is 36,000, so the approved details, scope limits and the
// characterizations the writer is told to open on never reached it — and the
// reviewer called true claims from that part unsupported. The END of a long CV
// has to arrive, in the writer, the reviewer and the letter.
test('the whole CV reaches the writer, the reviewer and the letter (F-539)', async () => {
  const { buildCoverLetterPrompt } = await import('./cover-letter.mjs');
  const long = `${CV}\n${'Filler line of an earlier section.\n'.repeat(1200)}## What the work adds up to\nTAIL-MARKER-7731`;
  assert.ok(long.length > 36000, 'the fixture is as long as his real CV');
  const answer = buildAnswerPrompt({ question: 'Why this role?', job: JOB, cvText: long });
  const review = buildReviewPrompt({ question: 'Why this role?', answer: 'x', job: JOB, cvText: long });
  const letter = buildCoverLetterPrompt({ job: JOB, jd: 'x', cvText: long });
  for (const [name, p] of [['answer', answer], ['review', review], ['letter', letter]]) {
    assert.ok(p.includes('TAIL-MARKER-7731'), `the ${name} prompt lost the end of the CV`);
  }
});

// His stories (interview-prep/*.md) travel with the CV, so the writer can
// answer a question about HIM, and the fact checks accept what he said.
test('his stories file travels with the CV', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('fs');
  const { tmpdir } = await import('os');
  const path = (await import('path')).default;
  const dir = mkdtempSync(path.join(tmpdir(), 'stories-'));
  const cv = path.join(dir, 'cv.md');
  writeFileSync(cv, CV);
  const stories = path.join(dir, 'interview-prep');
  mkdirSync(path.join(stories, 'sessions'), { recursive: true });
  writeFileSync(path.join(stories, 'stories.md'), 'The RS232 parameter was wrong.');
  writeFileSync(path.join(stories, 'sessions', 'prep.md'), 'SESSION NOTE');
  const src = sourcesFor({ cvPath: cv, storiesDir: stories });
  assert.ok(src.cvText.startsWith(CV), 'the CV comes first, unchanged');
  assert.ok(src.cvText.includes('The RS232 parameter was wrong.'), 'his story is in');
  assert.ok(!src.cvText.includes('SESSION NOTE'), 'prep notes are not statements of fact');
  const bare = sourcesFor({ cvPath: cv, storiesDir: path.join(dir, 'missing') });
  assert.equal(bare.cvText, CV, 'no stories folder, no change');
  assert.deepEqual(checkAnswer('The RS232 parameter was wrong, and I found it.', { cvText: src.cvText, jd: '', job: JOB, target: { min: 1, max: 50 }, question: 'Biggest failure?', limits: {}, kind: 'character' })
    .problems.filter((p) => /232/.test(p)), [], 'a named thing from his story is not flagged as unsupported');
});
