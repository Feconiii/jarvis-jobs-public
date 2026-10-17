/**
 * THE WRITERS, THE VISA GATE AND THE LLM PROVIDER, FOR SOMEONE WHO IS NOT HIM.
 *
 * Every other suite runs as the default person (Alex: F-1, hardware, claude).
 * This one starts child processes as the made-up second user in
 * presets/finance-data/test-profile.yml — a U.S. citizen, finance / data,
 * graduated May 2026, on Codex — and checks the three things that must change
 * for her and the one that must never happen:
 *
 *   - a citizen is not hidden from "must be a U.S. citizen" or "we do not
 *     sponsor", and a clearance is a caution with its sentence, not a block;
 *   - the default person still gets every block exactly as before;
 *   - none of his facts reach her prompts (his name, school, employers,
 *     graduation date, visa status);
 *   - her writers' calls go to Codex, read-only, with no claude model names.
 *
 * Run: node --test jarvis/targeting-writers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(HERE, 'presets', 'finance-data', 'test-profile.yml');
const url = (p) => JSON.stringify(pathToFileURL(path.join(HERE, p)).href);
const DIR = mkdtempSync(path.join(tmpdir(), 'jarvis-writers-'));

/** Run a module body as the finance user (or as nobody in particular) and parse its JSON. */
function asPerson(body, { profile = PROFILE, env = {} } = {}) {
  const file = path.join(DIR, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body);
  const childEnv = { ...process.env, ...env };
  // The child is a plain script, not a test: only JARVIS_PROFILE decides who it is.
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.JARVIS_LLM;
  if (profile) childEnv.JARVIS_PROFILE = profile; else delete childEnv.JARVIS_PROFILE;
  const r = spawnSync(process.execPath, [file], { env: childEnv, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const VISA = `
import { classifyVisa } from ${url('visa.mjs')};
import { person } from ${url('targeting.mjs')};
const S = {
  citizen: 'Applicants must be a U.S. citizen.',
  sponsor: 'We do not sponsor visas for this position.',
  clearance: 'An active TS/SCI clearance is required for this role.',
  perm: 'Candidates must be permanently authorized to work in the U.S. without sponsorship.',
  itar: 'Applicants must be U.S. persons as defined by 22 C.F.R. 120.62 under ITAR.',
  silent: 'We build dashboards for finance teams.',
};
const out = { who: person.fullName, workAuth: person.workAuth };
for (const [k, s] of Object.entries(S)) out[k] = classifyVisa('Financial Analyst', s);
process.stdout.write(JSON.stringify(out));
`;

test('the finance test profile is who the children run as', () => {
  const v = asPerson(VISA);
  assert.equal(v.who, 'Test Analyst');
  assert.equal(v.workAuth, 'citizen');
});

test('A CITIZEN IS NOT HIDDEN by citizenship, sponsorship or permanent-authorization wording', () => {
  const v = asPerson(VISA);
  assert.equal(v.citizen.block, null, '"must be a U.S. citizen" does not block a citizen');
  assert.equal(v.sponsor.block, null, '"we do not sponsor" does not block someone who needs no sponsorship');
  assert.equal(v.perm.block, null);
  assert.equal(v.itar.block, null);
  // …and they are not shouted about either: none of these is a hurdle for her.
  for (const k of ['citizen', 'sponsor', 'perm', 'itar']) {
    assert.deepEqual(v[k].warnings.filter((w) => w.level === 'caution').map((w) => w.key), [], `${k}: no caution for a citizen`);
  }
  // Silence about sponsorship is not worth a note to someone who needs none.
  assert.deepEqual(v.silent.warnings, []);
});

test('A CLEARANCE IS A CAUTION FOR A CITIZEN, carrying the exact sentence', () => {
  const v = asPerson(VISA);
  assert.equal(v.clearance.block, null);
  const w = v.clearance.warnings.find((x) => x.key === 'clearance');
  assert.ok(w, 'warned');
  assert.equal(w.level, 'caution');
  assert.match(w.quote, /TS\/SCI clearance is required/);
});

test('the shape the consumers read is unchanged (triage: flags.hardBlock = !!visa.block)', () => {
  const v = asPerson(VISA);
  for (const r of Object.values(v).filter((x) => x && typeof x === 'object')) {
    assert.deepEqual(Object.keys(r).sort(), ['block', 'warnings']);
    for (const w of r.warnings) assert.deepEqual(Object.keys(w).sort(), ['key', 'level', 'note', 'quote']);
  }
});

test('THE DEFAULT PERSON IS UNCHANGED — every block still hides the job from him', async () => {
  const { classifyVisa } = await import('./visa.mjs');
  assert.equal(classifyVisa('', 'Applicants must be a U.S. citizen.').block?.key, 'us_citizen');
  assert.equal(classifyVisa('', 'We do not sponsor visas for this position.').block?.key, 'no_sponsorship');
  assert.equal(classifyVisa('', 'An active TS/SCI clearance is required for this role.').block?.key, 'clearance');
  // His export-control note still names his own history…
  const itar = classifyVisa('', 'Applicants must be U.S. persons as defined by 22 C.F.R. 120.62 under ITAR.');
  assert.match(itar.warnings.find((w) => w.key === 'us_person').note, /export-controlled role before/);
});

test('…and another person passed explicitly gets the generic note, never his history', async () => {
  const { classifyVisa } = await import('./visa.mjs');
  const other = { fullName: 'Someone Else', preset: 'hardware-engineering', workAuth: 'visa', needsSponsorship: true, usPerson: false };
  const v = classifyVisa('', 'Final offers will be contingent on ability to obtain authorization for access to U.S. export-controlled information from the U.S. Government.', { person: other });
  const note = v.warnings.find((w) => w.key === 'export_authorization')?.note || '';
  assert.ok(note, 'still warned');
  assert.doesNotMatch(note, /Applied Materials|summer/);
  // A permanent resident: citizenship still hides it, export control does not.
  const pr = { fullName: 'P R', preset: 'finance-data', workAuth: 'permanent_resident', needsSponsorship: false, usPerson: true };
  assert.equal(classifyVisa('', 'Applicants must be a U.S. citizen.', { person: pr }).block?.key, 'us_citizen');
  assert.equal(classifyVisa('', 'We do not sponsor visas.', { person: pr }).block, null);
});

// His facts, which must never reach her prompts.
const HIS = ['Alex', 'Lakeside', 'Applied Materials', 'Acme Steel', 'May 2027', 'F-1', 'Makerspace', 'Springfield'];

const PROMPTS = `
import { buildAnswerPrompt } from ${url('apply/essay.mjs')};
import { buildCoverLetterPrompt } from ${url('cover-letter.mjs')};
import { buildLeadsPrompt } from ${url('leads.mjs')};
import { buildOutreachPrompt } from ${url('outreach.mjs')};
import { buildTailorPrompt, buildRetryPrompt, buildCompressPrompt } from ${url('tailor-llm.mjs')};
import { buildReviewPrompt } from ${url('apply/answer-review.mjs')};
const job = { company: 'Example Bank', title: 'Financial Analyst', team: 'FP&A', location: 'Seattle, WA', url: 'https://example.test/job/1', status: 'applied' };
const jd = 'Build forecasts and variance analysis in Excel and SQL. Partner with FP&A leadership.';
const cvText = '# Test Analyst\\nExample State University, BBA Finance\\nAnalyst intern, Example Credit Union: built a variance model in Excel.';
const out = {};
for (const kind of ['other', 'why-company', 'why-role', 'excellence', 'experience', 'why-looking', 'anything-else', 'company-knowledge', 'cover-letter']) {
  out['essay-' + kind] = buildAnswerPrompt({ question: 'Why do you want to work here?', kind, job, jd, cvText, target: { min: 90, max: 160 } });
}
out.letter = buildCoverLetterPrompt({ job, jd, cvText, request: 'mention SQL' });
out.leads = buildLeadsPrompt(job, { description: jd, hardBlock: true, today: new Date('2026-10-16T00:00:00Z') });
out.outreach = buildOutreachPrompt({ job, jd, channel: 'message', contact: { name: 'Ann Lee' }, cvText, portfolio: 'https://example.test' });
out.connection = buildOutreachPrompt({ job, jd, channel: 'connection', contact: { name: 'Ann Lee' }, cvText });
const spec = { familyLabel: 'analyst', experience: [{ orgKey: 'ecu', org: 'Example Credit Union', title: 'Analyst Intern', bullets: [{ provenanceKey: 'ecu.variance', text: 'Built a variance model in Excel.' }] }], projects: [], skills: [] };
out.tailor = buildTailorPrompt({ spec, job, jd, request: 'lead with SQL' });
out.retry = buildRetryPrompt({ refusals: [{ key: 'ecu.variance', text: 'x', problems: ['y'] }], job });
out.compress = buildCompressPrompt({ compress: [{ key: 'ecu.variance', text: 'x', lines: 4, targetChars: 200 }], job });
out.review = buildReviewPrompt({ question: 'q', answer: 'a', job, jd, cvText });
process.stdout.write(JSON.stringify(out));
`;

test('NONE OF HIS FACTS REACH HER PROMPTS — essay, letter, leads, outreach, resume, review', () => {
  const prompts = asPerson(PROMPTS);
  for (const [name, text] of Object.entries(prompts)) {
    for (const word of HIS) assert.ok(!text.includes(word), `${name} prompt contains "${word}"`);
  }
  // …and her own identity is what they are written from.
  assert.match(prompts['essay-other'], /Test Analyst/);
  assert.match(prompts['essay-other'], /Example State University/);
  assert.match(prompts.leads, /U\.S\. citizen/);
  assert.match(prompts.outreach, /\nTest$|\nTest\n/m, 'signs with her first name');
  assert.match(prompts.tailor, /fpa|financial-analyst/, 'the finance role emphasis');
  // Graduation already passed: nothing may say she is still graduating.
  assert.match(prompts.letter, /graduated in May 2026/);
  assert.doesNotMatch(prompts.letter, /graduates in May 2026/);
});

test('HIS PROMPTS STILL CARRY HIS EXAMPLES (the default person, in this process)', async () => {
  const { buildAnswerPrompt } = await import('./apply/essay.mjs');
  const p = buildAnswerPrompt({ question: 'Why us?', kind: 'why-company', job: { company: 'Acme', title: 'ME' }, jd: '', cvText: '' });
  assert.match(p, /Write Alex Rivera's answer/);
  assert.match(p, /Madrone/, 'his sent answer is still the worked example for him');
});

// ── the provider ──────────────────────────────────────────────────────
const STUB = path.join(DIR, 'codex-stub.mjs');
writeFileSync(STUB, [
  "import { writeFileSync } from 'fs';",
  "const argv = process.argv.slice(2);",
  "let stdin = '';",
  "process.stdin.on('data', (d) => { stdin += d; });",
  "process.stdin.on('end', () => { writeFileSync(argv[argv.indexOf('-o') + 1], JSON.stringify({ argv, stdin })); });",
].join('\n'));

const RUN = `
import { run, llmProvider } from ${url('tailor-llm.mjs')};
const out = await run('claude', ['-p'], { input: 'Reply with the single word OK', timeout: 20000, models: ['haiku'] });
process.stdout.write(JSON.stringify({ provider: llmProvider(), model: out.model, seen: JSON.parse(out.stdout) }));
`;

test('HER PROFILE SAYS CODEX: run(claude) becomes a read-only codex exec (stubbed, never the real one)', () => {
  const r = asPerson(RUN, { env: { JARVIS_CODEX_BIN: STUB } });
  assert.equal(r.provider, 'codex', 'from targeting.llm in her profile, no env needed');
  assert.equal(r.model, 'codex');
  assert.equal(r.seen.stdin, 'Reply with the single word OK');
  assert.deepEqual(r.seen.argv.slice(0, 7), ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--color', 'never']);
  assert.equal(r.seen.argv.at(-1), '-');
  assert.ok(!r.seen.argv.includes('haiku'), 'claude model names are dropped');
});
