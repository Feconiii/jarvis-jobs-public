// jarvis/apply-queue.test.mjs — the apply queue never runs dry, and says why for every skip (2026-11-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueue, accountFreeVendors, requiredEssays, formSchema } from './apply-queue.mjs';
import { vendorOf } from './ats-report.mjs';

const ALLOWED = accountFreeVendors();
const job = (id, extra = {}) => ({ id, company: `Co ${id}`, title: 'Mechanical Engineer', url: `https://boards.greenhouse.io/co${id}/jobs/${id.replace(/\D/g, '') || 1}`, source: 'greenhouse', ...extra });
const deps = (over = {}) => ({
  vendorOf, allowed: ALLOWED, hidden: new Set(['hidden co']), capped: /^tesla\b/i,
  appliedBefore: (j) => j.status === 'applied',
  liveness: async (url) => (/closed/.test(url) ? { result: 'expired', reason: 'gone' } : { result: 'active' }),
  formCheck: async (j) => (j.essay ? { checked: true, essays: ['Why do you want to work here?'] } : { checked: true, essays: [] }),
  read: async (jobs) => new Map(jobs.map((j) => [j.id, j.readAs || 'KEEP'])),
  ...over,
});

test('the platforms an unattended run completes come from the registry: no sign-in, account, code or bot check', () => {
  for (const k of ['greenhouse', 'lever', 'ashby', 'workable']) assert.ok(ALLOWED.has(k), k);
  for (const k of ['workday', 'icims', 'successfactors', 'oracle', 'amazon', 'apple', 'tesla', 'smartrecruiters', 'eightfold', 'phenom', 'taleo']) assert.ok(!ALLOWED.has(k), k);
});

test('Eightfold only on an employer site recorded as clear (careers.micron.com, 2026-11-04); SmartRecruiters stays out', async () => {
  const { clearHosts } = await import('./apply-queue.mjs');
  const clear = clearHosts();
  assert.ok(clear.has('careers.micron.com'));
  const inbox = [
    job('m1', { company: 'Micron Technology', url: 'https://careers.micron.com/careers/job/45316376-new-college-grad', source: 'eightfold' }),
    job('e2', { company: 'Lam Research', url: 'https://careers.lamresearch.com/careers/job/1-x', source: 'eightfold' }),
    job('s3', { company: 'Intuitive', url: 'https://jobs.smartrecruiters.com/Intuitive/1-x', source: 'smartrecruiters' }),
  ];
  const r = await buildQueue({ want: 3, inbox, library: null, ...deps({ clear }) });
  assert.deepEqual(r.queued.map((q) => q.id), ['m1'], 'Micron\'s Eightfold site is in');
  assert.match(r.skipped.find((s) => s.id === 'e2').reason, /eightfold: not fillable/, 'another Eightfold tenant is not, until it is recorded clear');
  assert.match(r.skipped.find((s) => s.id === 's3').reason, /smartrecruiters: not fillable/);
});

test('inbox picks first; every skip has its reason; it stops at N', async () => {
  const inbox = [
    job('i1'),
    job('i2', { url: 'https://acme.wd5.myworkdayjobs.com/x/job/1', source: 'workday' }),
    job('i3', { company: 'Hidden Co' }),
    job('i4', { company: 'Tesla' }),
    job('i5', { status: 'applied' }),
    job('i6', { url: 'https://boards.greenhouse.io/closed/jobs/6' }),
    job('i7', { essay: true }),
    job('i8'),
    job('i9'),
  ];
  const lines = [];
  const r = await buildQueue({ want: 2, inbox, library: async () => [job('l1')], ...deps(), log: (m) => lines.push(m) });
  assert.deepEqual(r.queued.map((q) => q.id), ['i1', 'i8'], 'the first two that pass, from the inbox');
  assert.equal(r.read, 0, 'the library is not read when the inbox suffices');
  const why = Object.fromEntries(r.skipped.map((s) => [s.id, s.reason]));
  assert.match(why.i2, /workday: not fillable without a sign-in/);
  assert.equal(why.i3, 'a company he hid');
  assert.equal(why.i4, 'past the Tesla cap');
  assert.match(why.i5, /already applied/);
  assert.match(why.i6, /^closed/);
  assert.match(why.i7, /^required essay/);
  assert.ok(lines.some((l) => /skip .*a company he hid/.test(l)) && lines.some((l) => /QUEUE/.test(l)), 'said, line by line');
  assert.equal(r.proof, null);
});

test('when the inbox runs out, it reads the library with the same reader until N', async () => {
  const lib = [job('l1', { readAs: 'DROP' }), job('l2'), job('l3', { url: 'https://acme.icims.com/jobs/3', source: 'icims' }), job('l4', { readAs: 'MAYBE' }), job('l5'), job('l6')];
  const batches = [];
  const r = await buildQueue({ want: 3, inbox: [job('i1')], library: async () => lib, ...deps({ read: async (jobs, need) => { batches.push([jobs.map((j) => j.id), need]); return new Map(jobs.map((j) => [j.id, j.readAs || 'KEEP'])); } }), batch: 2 });
  assert.deepEqual(r.queued.map((q) => [q.id, q.where]), [['i1', 'inbox'], ['l2', 'library (read now)'], ['l4', 'library (read now)']]);
  assert.deepEqual(batches[0], [['l1', 'l2'], 2], 'only postings that passed every other check reach the reader, with how many are still needed');
  assert.ok(!batches.flat(2).includes('l3'), 'an account platform is never read');
  assert.match(r.skipped.find((s) => s.id === 'l1').reason, /the reader said DROP/);
  assert.equal(r.queued.length, 3, 'never more than N');
});

test('fewer exist: it says so with the numbers, after the whole pool', async () => {
  const lib = [job('l1', { readAs: 'DROP' }), job('l2', { essay: true }), job('l3', { url: 'https://x.myworkdayjobs.com/y', source: 'workday' })];
  const r = await buildQueue({ want: 4, inbox: [job('i1'), job('i2', { status: 'applied' })], library: async () => lib, ...deps() });
  assert.equal(r.queued.length, 1);
  assert.deepEqual(r.proof && { asked: r.proof.asked, found: r.proof.found, inbox: r.proof.inboxConsidered, lib: r.proof.libraryConsidered, read: r.proof.readByTheReader, done: r.proof.libraryExhausted },
    { asked: 4, found: 1, inbox: 2, lib: 3, read: 1, done: true });
  assert.ok(Object.keys(r.proof.skippedBy).length >= 3, JSON.stringify(r.proof.skippedBy));
});

test('a required essay is a required long-text question; the resume, letter and "anything else" boxes are not', () => {
  assert.deepEqual(requiredEssays([
    { label: 'Why do you want to work at Acme?', required: true, long: true },
    { label: 'Cover Letter', required: true, long: true },
    { label: 'Additional Information', required: true, long: true },
    { label: 'Describe a project', required: false, long: true },
    { label: 'LinkedIn Profile', required: true, long: false },
  ]), ['Why do you want to work at Acme?']);
});

test('F-1013 #24: an essay that MENTIONS a resume is still an essay; a Lever form read only in part is listed for him', async () => {
  const essays = requiredEssays([
    { label: 'Tell us about a project you built beyond what is on your resume, and what you learned from it', required: true, long: true },
    { label: 'Resume (paste text)', required: true, long: true },
  ]);
  assert.equal(essays.length, 1, JSON.stringify(essays));
  assert.match(essays[0], /^Tell us about a project/);
  const r = await buildQueue({ want: 1, inbox: [job('L1', { url: 'https://jobs.lever.co/acme/0b6f2a2e-1111-2222-3333-444455556666', source: 'lever' })], library: null,
    ...deps({ formCheck: async () => ({ checked: true, partial: true, essays: [] }) }) });
  assert.equal(r.queued.length, 1);
  assert.match(r.queued[0].form, /essays only/, 'not stamped "form checked"');
});

test('form schemas: Greenhouse, Ashby and Lever are read from their own endpoints; anything else is "not pre-checked"', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const ok = (body, text = false) => ({ ok: true, json: async () => body, text: async () => (text ? body : JSON.stringify(body)) });
      if (u.includes('boards-api.greenhouse.io')) return ok({ questions: [{ label: 'Resume/CV', required: true, fields: [{ type: 'input_file' }, { type: 'textarea' }] }, { label: 'Why us?', required: true, fields: [{ type: 'textarea' }] }] });
      if (u.includes('non-user-graphql')) return ok({ data: { jobPosting: { applicationForm: { sections: [{ fieldEntries: [{ field: { title: 'What excites you?', type: 'LongText' }, isRequired: true }, { field: { title: 'Name', type: 'String' }, isRequired: true }] }] } } } });
      if (u.includes('jobs.lever.co')) return ok('<div class="application-label">Tell us about a hard problem ✱</div><div><textarea name="cards[x]" required></textarea></div>', true);
      return { ok: false };
    };
    const gh = await formSchema({ url: 'https://boards.greenhouse.io/acme/jobs/123' });
    assert.deepEqual([gh.checked, gh.essays], [true, ['Why us?']], 'the resume box is not an essay');
    assert.deepEqual(gh.fields.map((f) => [f.label, f.type, f.required]), [['Resume/CV', 'file', true], ['Why us?', 'textarea', true]], 'every question, typed for the planner');
    const ab = await formSchema({ url: 'https://jobs.ashbyhq.com/acme/0b6f2a2e-1111-2222-3333-444455556666' });
    assert.deepEqual([ab.checked, ab.essays], [true, ['What excites you?']]);
    assert.deepEqual(ab.fields.map((f) => [f.label, f.type]), [['What excites you?', 'textarea'], ['Name', 'text']]);
    const lever = await formSchema({ url: 'https://jobs.lever.co/acme/0b6f2a2e-1111-2222-3333-444455556666' });
    assert.equal(lever.checked, true);
    assert.equal(lever.partial, true, 'Lever: its other required questions are not read (F-1013 #24)');
    assert.equal(lever.essays.length, 1);
    assert.deepEqual(await formSchema({ url: 'https://acme.bamboohr.com/careers/12' }), { checked: false });
  } finally { globalThis.fetch = real; }
});

test('review: hidden companies fail closed, a role is one role however worded, and two copies are never queued in one run', async () => {
  const { hiddenFrom, roleKey, checkByHand } = await import('./apply-queue.mjs');
  assert.deepEqual([...hiddenFrom({ v: '["Tesla","Acme Corp"]' })], ['tesla', 'acme corp']);
  assert.equal(hiddenFrom(null).size, 0, 'no list yet: nothing hidden');
  assert.throws(() => hiddenFrom({ v: '{not json' }), /could not be read/, 'an unreadable list stops the queue');
  assert.throws(() => hiddenFrom({ v: '{"a":1}' }), /not a list/);
  // One role, near-same wording.
  assert.equal(roleKey({ company: 'Acme Inc.', title: 'Mechanical Engineer II' }), roleKey({ company: 'Acme', title: 'Mechanical Engineer' }));
  assert.equal(roleKey({ company: 'Acme', title: 'Entry Level Mechanical Engineer (Boise)' }), roleKey({ company: 'Acme', title: 'Mechanical Engineer' }));
  assert.notEqual(roleKey({ company: 'Acme', title: 'Mechanical Engineer' }), roleKey({ company: 'Acme', title: 'Electrical Engineer' }));
  // Two copies in one run: the second is skipped with its reason.
  const r = await buildQueue({ want: 3, inbox: [job('c1', { company: 'Acme', title: 'Mechanical Engineer' }), job('c2', { company: 'Acme Inc', title: 'Mechanical Engineer II' }), job('c3', { company: 'Acme', title: 'Test Engineer' })], library: null, ...deps() });
  assert.deepEqual(r.queued.map((q) => q.id), ['c1', 'c3']);
  assert.match(r.skipped.find((s) => s.id === 'c2').reason, /a copy of a role already queued/);
  // What to check by hand: a form not pre-checked, a posting not confirmed open.
  assert.deepEqual(checkByHand([
    { id: 'a', company: 'A', title: 'T', form: 'form checked: no required essay', live: 'live' },
    { id: 'b', company: 'B', title: 'T', form: 'form not pre-checked', live: 'live' },
    { id: 'c', company: 'C', title: 'T', form: 'form checked: no required essay', live: 'liveness not confirmed by API' },
  ]).map((x) => [x.id, x.why]), [['b', 'its form was not pre-checked for a required essay'], ['c', 'the platform did not confirm it is open']]);
});

test('thermal (2026-11-05): a thermal-focused role is skipped as "not his interest: thermal"; a passing mention is not', async () => {
  const { interestOut } = await import('./curate.mjs');
  const inbox = [job('h1', { title: 'Thermal Systems Engineer' }), job('h2', { title: 'Mechanical Engineer' }), job('h3', { title: 'Manufacturing Engineer 3 (Thermal)' })];
  const r = await buildQueue({ want: 3, inbox, library: null, ...deps({ interest: interestOut }) });
  assert.deepEqual(r.queued.map((q) => q.id), ['h2', 'h3']);
  assert.equal(r.skipped.find((s) => s.id === 'h1').reason, 'not his interest: thermal');
});

test('Kairos (2026-11-04): a form with required questions the planner leaves for him is not queued, and is named with them', async () => {
  const withFields = (j) => ({ checked: true, essays: [], fields: j.asks ? [{ label: j.asks, required: true, type: 'text' }, { label: 'Resume', required: true, type: 'file' }] : [] });
  const seen = [];
  const needsHim = (j, fields) => { seen.push(fields.map((f) => f.label)); if (j.id === 'k3') throw new Error('boom'); return fields.filter((f) => f.required && f.type !== 'file' && /Part 810/.test(f.label)).map((f) => f.label); };
  const inbox = [
    job('k1', { company: 'Kairos Power', asks: 'Have you ever been the subject to a specific authorization under Part 810?' }),
    job('k2', { company: 'Plain Co' }),
    job('k3', { company: 'Odd Co', asks: 'Anything' }),
    job('k4', { company: 'Other Co', asks: 'Preferred first name' }),
  ];
  const r = await buildQueue({ want: 4, inbox, library: null, ...deps({ formCheck: async (j) => withFields(j), needsHim }) });
  assert.deepEqual(r.queued.map((q) => q.id), ['k2', 'k4'], 'only the forms an unattended run can finish');
  assert.match(r.skipped.find((s) => s.id === 'k1').reason, /^needs his answers: "Have you ever been the subject/);
  assert.deepEqual(r.needsYou.map((n) => [n.id, n.questions.length]), [['k1', 1], ['k3', 1]]);
  assert.match(r.needsYou[1].questions[0], /planner could not read this form: boom/, 'a planner failure keeps the form out, it never counts as fillable');
  assert.ok(seen.length === 3, 'a form with no fields read is not planned');
});
