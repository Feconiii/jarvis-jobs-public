/**
 * The cover letter: held to his files and his voice, never to a model's word.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverLetterPrompt, checkCoverLetter, writeCoverLetter, BANNED, letterWordsFrom, letterWordsRequest, withLetterWords, hisLetters, registerProblems } from './cover-letter.mjs';

const CV = `# Alex Rivera
## Education
**Lakeside University** — Springfield, Washington
Bachelor of Science: Mechanical Engineering | May 2027
- GPA: 3.85 | an engineering honor society
## Experience
**Applied Materials** — Austin, Texas
- Designed, prototyped, and validated a machine-vision inspection fixture for 3 Metal Deposition chamber variants in Autodesk Inventor.
- Supported deployment and validation of Autonomous Mobile Robots (AMRs) for cleanroom material handling (10+ test runs).
- Installed and programmed a Universal Robots UR10e cobot with RoboDK.
**Acme Steel Stud Company** — Springfield, Washington
- Cut jams 70% on a stud line; saved $57,000 in material.
## Skills
SolidWorks, Autodesk Inventor, GD&T, FEA, Haas CNC, welding, Python`;

const JD = 'Manufacturing Engineer I at Becton Dickinson, Warwick RI. Design fixtures, run DOE, work with SolidWorks and Minitab, support new product introduction on catheter lines.';
const JOB = { company: 'Becton Dickinson', title: 'Manufacturing Engineer I' };

/**
 * A letter in HIS shape (F-408), which is what the checks are now written
 * against: an introduction first, two roles told as stories, what draws him to
 * the posting, and a close. No contractions, no figures, no sign-off — the
 * page adds "Sincerely, Alex Rivera" under the body.
 */
const GOOD = `I am writing to apply for the Manufacturing Engineer I position at Becton Dickinson. I am currently pursuing a Bachelor of Science in Mechanical Engineering at Lakeside University and will graduate in May 2027, and I am seeking a role where I can design the tooling and fixtures that a production line depends on. What interests me about this posting is that it puts new product introduction and design of experiments work on catheter lines together, so a fixture there is judged by whether the line stays repeatable once it is running.

During my internship at Applied Materials I designed, prototyped and validated a machine vision inspection fixture for Metal Deposition chamber variants in Autodesk Inventor. I carried the tolerance analysis through the design and took it from the first model to validated hardware on the floor. That work taught me how much of a reliable fixture is settled in its tolerances and its interfaces, which is the same question a catheter line asks of the tooling around it.

At Acme Steel Stud Company I ran time studies on a stud line and traced a recurring stoppage to its cause, then worked with the operators on the change that fixed it. Sitting with the people who run the line taught me to design for the way work is actually done rather than the way a drawing assumes it will be, and it is where I learned to read production data before proposing anything.

What draws me to this role in particular is supporting new product introduction, running design of experiments in Minitab, and building the fixtures that make a new line repeatable. I am eager to learn how a medical device line is qualified and to build depth in process capability work.

I would welcome the opportunity to discuss how my design and manufacturing experience could support the team. Thank you for your time and consideration.`;

test('A CLEAN LETTER PASSES: his shape, his names, his voice', () => {
  const r = checkCoverLetter(GOOD, { cvText: CV, jd: JD, job: JOB });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.notices, [], 'and nothing worth a second look');
});

test('A LETTER NEVER SAYS WHAT HE HAS NOT DONE (F-408)', () => {
  // A draft opened its third paragraph with "I have not designed an actuator
  // or a gearbox" on an actuator design role. His reply: "who the actual fuck
  // say on cover letter i have nto designed a gearbox". Nothing asked him, and
  // it goes out under his name.
  const said = [
    'I have not designed an actuator or a gearbox.',
    'I haven\'t worked on a production line of that size.',
    'I do not have direct experience with injection moulding.',
    'I lack formal training in controls.',
    'I am new to medical devices.',
    'While I have not led a team, I have supported one.',
    'I have limited experience with Minitab.',
    'I have never run a design of experiments.',
  ];
  for (const line of said) {
    const r = checkCoverLetter(`${GOOD}\n\n${line}`, { cvText: CV, jd: JD, job: JOB });
    assert.ok(r.problems.some((x) => /never volunteers what he cannot do/.test(x)),
      `"${line}" must fail: ${JSON.stringify(r.problems)}`);
  }
  // And a sentence that merely contains "not" is not one of these.
  const fine = checkCoverLetter(`${GOOD}\n\nThe fixture did not need a second revision.`, { cvText: CV, jd: JD, job: JOB });
  assert.deepEqual(fine.problems, [], 'an ordinary negation is not a confession');
});

test('HIS OWN LENGTH, AND HIS OWN VOCABULARY (F-408)', () => {
  // His eleven letters run 255 to 430 words. The old check demanded under 260,
  // which is shorter than anything he has ever sent.
  const short = checkCoverLetter('I am writing to apply. Thank you for your time and consideration.', { cvText: CV, jd: JD, job: JOB });
  assert.ok(short.problems.some((p) => /too short/.test(p)));
  const long = checkCoverLetter(`${GOOD} ${GOOD}`, { cvText: CV, jd: JD, job: JOB });
  assert.ok(long.problems.some((p) => /too long/.test(p)));
  // These are HIS words, in his own letters, and no longer fail him.
  for (const phrase of ['I am excited', 'I am eager', 'I would be thrilled']) {
    assert.ok(!BANNED.includes(phrase.toLowerCase()), `"${phrase}" is his own phrasing`);
  }
  const keen = checkCoverLetter(GOOD.replace('I am eager to learn', 'I am excited to learn'), { cvText: CV, jd: JD, job: JOB });
  assert.deepEqual(keen.problems, [], JSON.stringify(keen.problems));
});

test('A FIGURE IN THE BODY IS WORTH A SECOND LOOK (F-408)', () => {
  // Measured: not one of his eleven letters quotes a number. The resume
  // carries the figures. It is a notice rather than a failure, because a
  // posting's own req number can legitimately appear.
  const r = checkCoverLetter(GOOD.replace('I ran time studies on a stud line', 'I ran time studies and cut jams 70%'), { cvText: CV, jd: JD, job: JOB });
  assert.deepEqual(r.problems, [], 'a figure from his CV is not a fabrication');
  assert.ok(r.notices.some((n) => /his own letters carry none/.test(n)), JSON.stringify(r.notices));
});

test('A FABRICATED FIGURE OR NAME FAILS IT', () => {
  const nums = checkCoverLetter(GOOD.replace('a recurring stoppage', 'a recurring stoppage that cost 85%'), { cvText: CV, jd: JD, job: JOB });
  assert.ok(nums.problems.some((p) => /figure "85%"/.test(p)), JSON.stringify(nums.problems));
  const tool = checkCoverLetter(GOOD.replace('in Autodesk Inventor', 'in Autodesk Inventor and Siemens NX'), { cvText: CV, jd: JD, job: JOB });
  assert.ok(tool.problems.some((p) => /"siemens"|"nx"/i.test(p)), `a tool he never used is caught: ${JSON.stringify(tool.problems)}`);
  const ok = checkCoverLetter(GOOD.replace('design of experiments in Minitab', 'design of experiments in Minitab on catheter lines'), { cvText: CV, jd: JD, job: JOB });
  assert.equal(ok.problems.length, 0, `a tool the POSTING names may be named back to it: ${JSON.stringify(ok.problems)}`);
});

test("THE VOICE IS HELD: an em dash, a banned phrase, a reframe each fail it", () => {
  const dash = checkCoverLetter(GOOD.replace(', which is the same question', ' — which is the same question'), { cvText: CV, jd: JD, job: JOB });
  assert.ok(dash.problems.some((p) => /em dash/.test(p)), JSON.stringify(dash.problems));
  const banned = checkCoverLetter(GOOD.replace('I am eager to learn', 'I am eager to leverage and delve into'), { cvText: CV, jd: JD, job: JOB });
  assert.ok(banned.problems.some((p) => /"leverage"/.test(p)), JSON.stringify(banned.problems));
  assert.ok(banned.problems.some((p) => /"delve"/.test(p)));
  const reframe = checkCoverLetter(`${GOOD}\n\nThis is not just process work. This is the whole line.`, { cvText: CV, jd: JD, job: JOB });
  assert.ok(reframe.problems.some((p) => /reframe/.test(p)), JSON.stringify(reframe.problems));
  assert.ok(BANNED.includes('delve') && BANNED.includes('perfect fit'));
});

test('THE PROMPT CARRIES HIS FILES, THE POSTING, HIS NOTE AND THE RULES', () => {
  const p = buildCoverLetterPrompt({ job: JOB, jd: JD, cvText: CV, narrative: { headline: 'ME student with semiconductor automation experience', exit_story: 'Graduating May 2027.' }, voiceRules: 'NO em dashes.', framing: '| Quality / Test | GD&T |', resumeLines: ['Designed a fixture'], request: 'mention the cobot' });
  assert.match(p, /cv\.md ---/);
  assert.match(p, /Becton Dickinson/);
  assert.match(p, /Manufacturing Engineer I/);
  assert.match(p, /ALEX'S NOTE FOR THIS LETTER.*mention the cobot/);
  assert.match(p, /NO em dashes/);
  assert.match(p, /Every fact comes from cv\.md/);
  assert.match(p, /300 to 420 words/);
  assert.match(p, /- Designed a fixture/);
  // The shape and the two rules that came out of his own letters (F-408).
  assert.match(p, /AN INTRODUCTION, NOT EVIDENCE/);
  assert.match(p, /NEVER WRITE WHAT HE HAS NOT DONE/);
  assert.match(p, /NO FIGURES/);
  const withStyle = buildCoverLetterPrompt({ job: JOB, jd: JD, cvText: CV, style: 'HIS STYLE FILE', exemplar: 'Dear Hiring Manager, one of his own letters.' });
  assert.match(withStyle, /HIS STYLE FILE/, 'the style read out of his letters is in the prompt');
  assert.match(withStyle, /one of his own letters/, 'and one of the letters themselves');
  assert.ok(!/ALEX'S NOTE/.test(buildCoverLetterPrompt({ job: JOB, jd: JD, cvText: CV })));
});

test('A BAD FIRST DRAFT IS ASKED FOR AGAIN WITH ITS PROBLEMS NAMED; the result is never silent', async () => {
  const asks = [];
  const bad = GOOD.replace('a recurring stoppage', 'a recurring stoppage that cost 85%');
  const ask = async (prompt) => { asks.push(prompt); return asks.length === 1 ? bad : GOOD; };
  const r = await writeCoverLetter(JOB, { jd: JD, ask, sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' } });
  assert.equal(asks.length, 2, 'one retry');
  assert.match(asks[1], /YOUR LAST DRAFT FAILED THESE CHECKS[\s\S]*figure "85%"/);
  assert.equal(r.ok, true);
  assert.equal(r.text, GOOD);
  assert.match(r.why, /second draft passed/);

  const stubborn = await writeCoverLetter(JOB, { jd: JD, ask: async () => bad, sources: { cvText: CV, narrative: {}, voiceRules: '', framing: '' } });
  assert.equal(stubborn.ok, false);
  assert.ok(stubborn.text.length > 100, 'the text is still returned, with its problems, for him to read');
  assert.ok(stubborn.problems.some((p) => /85%/.test(p)));
});

test('SWITCHED OFF, IT SAYS SO', async () => {
  const before = process.env.JARVIS_TAILOR;
  process.env.JARVIS_TAILOR = 'off';
  try {
    const r = await writeCoverLetter(JOB, { jd: JD, ask: async () => { throw new Error('must not be asked'); } });
    assert.equal(r.ok, false);
    assert.match(r.why, /switched off/);
  } finally {
    if (before === undefined) delete process.env.JARVIS_TAILOR; else process.env.JARVIS_TAILOR = before;
  }
});

test('a word the form asks to see in the letter is read, asked for, and guaranteed (PsiQuantum, 2026-09-25)', () => {
  const words = letterWordsFrom(['First Name', 'Please include the word "purple" in the cover letter submitted.', 'Cover Letter']);
  assert.deepEqual(words, ['purple']);
  assert.deepEqual(letterWordsFrom(['Why do you want this role?', 'Upload your cover letter']), [], 'no instruction, no words');
  assert.match(letterWordsRequest(words, 'keep it short'), /keep it short[\s\S]*"purple"/);
  assert.equal(withLetterWords('A purple anodised bracket.', words), 'A purple anodised bracket.', 'already there: untouched');
  assert.match(withLetterWords('Dear team,\nPurpleness is not it.', words), /asks for: purple\.$/, 'a longer word does not count');
});

test('DETAIL AND FILLER, measured against his eleven letters (2026-09-26)', () => {
  // His words on the drafts: "it read well initially but then dives into
  // unnecessary details, or add fluffy bullshit deviating from my examples".
  // A rule that fails his own writing is the wrong rule (F-408): all eleven
  // must pass, paragraphs recovered from the PDF text.
  const his = hisLetters();
  assert.ok(his.length >= 10, `his letters are read (${his.length})`);
  for (const l of his) {
    assert.ok(l.split(/\n\n/).length >= 3, `paragraphs recovered: ${l.slice(0, 60)}`);
    assert.deepEqual(registerProblems(l), [], l.slice(0, 80));
  }
  // The drafts that prompted this, each caught.
  const lines = [
    'The experience taught me that the visible failure is not always the root cause, and it is the habit I would bring to resolving nonconformances.',
    'That project taught me to carry a design from a constraint to a documented, released part, which is the discipline that enclosures, structures, and supplier relationships depend on.',
    'That pairing of intelligent software and carefully engineered hardware is the work I want to build my career on.',
    'A fixture is finished only when someone else can build it, run it, and trust what it reports.',
    "Redwood's work of recovering and reusing batteries is work I would be proud to contribute to.",
    "Path Robotics' work on AI driven robots is exactly the kind of engineering I want to contribute to.",
  ];
  for (const line of lines) {
    assert.ok(registerProblems(line).length, `caught: ${line}`);
  }
  // A role paragraph that walks through the mechanism runs long, and says so.
  const walk = 'At Applied Materials I designed a fixture. The printer was too small. So I split it into parts. I joined them with dovetails. I ran a tolerance analysis. I released it through Teamcenter.';
  assert.ok(registerProblems(walk).some((p) => /runs 6 sentences/.test(p)), JSON.stringify(registerProblems(walk)));
  // His own way of saying what work taught him is not filler.
  assert.deepEqual(registerProblems('These experiences taught me how to move from analysis to execution. This role has strengthened my understanding of how design decisions affect assembly.'), []);
});

test('THE PROMPT SHOWS ALL HIS LETTERS AND NOT HIS POST VOICE (2026-09-26)', async () => {
  const p = buildCoverLetterPrompt({ job: JOB, jd: JD, cvText: CV, letters: ['FIRST LETTER BODY', 'SECOND LETTER BODY'], exemplar: 'THE OLD SINGLE EXEMPLAR' });
  assert.match(p, /his letter 1 ---\nFIRST LETTER BODY/);
  assert.match(p, /his letter 2 ---\nSECOND LETTER BODY/);
  assert.ok(!/THE OLD SINGLE EXEMPLAR/.test(p), 'the letters replace the single sample');
  assert.match(p, /LEVEL OF DETAIL/);
  assert.match(p, /NO MECHANISM/);
  assert.match(p, /ONE ROLE PER PARAGRAPH/);
  assert.ok(!/ONLY TWO ROLES/.test(p), "no cap on how many companies he names (his call, 2026-09-26)");
  assert.ok(p.indexOf('--- end of cv.md ---') < p.indexOf('his letter 1 ---'), 'his letters come after the facts, so they are read last');
  // What writeCoverLetter hands the writer: cv.md alone, and no voice-dna rules.
  let seen = '';
  await writeCoverLetter(JOB, {
    jd: JD,
    ask: async (prompt) => { seen = prompt; return GOOD; },
    sources: { cv: CV, cvText: `${CV}\n--- his stories: interview-prep/stories.md ---\nI FED THE MAGAZINE BY HAND`, narrative: {}, voiceRules: 'Use contractions naturally. Be specific. Numbers, names, concrete details.', framing: '', letters: ['HIS LETTER'] },
  });
  assert.ok(!/FED THE MAGAZINE BY HAND/.test(seen), 'interview stories stay out of the letter');
  assert.ok(!/Use contractions naturally/.test(seen), "voice-dna's post rules stay out of the letter");
  assert.match(seen, /These words: delve/, 'the banned vocabulary is still named');
});
