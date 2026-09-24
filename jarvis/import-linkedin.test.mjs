// jarvis/import-linkedin.test.mjs — the fallback importer.
//
// The risk this file guards is not "does it fetch". It is that a LinkedIn row
// is a WORSE record than a board row — no applyable link, a copied
// description — so it must only ever appear where no board row can. Two ways
// that goes wrong: importing a company we can already read (a second, worse
// duplicate of a job he already has) and importing a posting with no body (a
// row that sails through triage unflagged and looks like a clean fit).

import {
  parsePosting, selectImportable, toStoreRow, titleOverlap, fetchPosting, postingUrl,
} from './import-linkedin.mjs';
import { companyKey as companyKeyOf } from './discover-linkedin.mjs';

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  console.error(`  ✗ ${what}\n      got  ${a}\n      want ${b}`);
};
const ok = (what, cond) => check(what, !!cond, true);

const POSTING = `<html><body>
<section class="core-section-container my-3 description">
  <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5">
    <p>Radiant is building a portable nuclear microreactor.</p>
    <strong>Requirements</strong>
    <ul><li>Graduating in December 2026 or Spring 2027</li><li>B.S. in Mechanical Engineering</li></ul>
    <p>Pay range $105,000 &amp; $130,000.</p>
  </div>
</section>
<ul class="description__job-criteria-list">
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader">Seniority level</h3>
    <span class="description__job-criteria-text">Entry level</span>
  </li>
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader">Employment type</h3>
    <span class="description__job-criteria-text">Full-time</span>
  </li>
</ul></body></html>`;

console.log('🧪 import-linkedin: reading one posting');
{
  const { description, criteria } = parsePosting(POSTING);
  ok('the body is found', description.includes('portable nuclear microreactor'));
  ok('the requirements list survives', description.includes('B.S. in Mechanical Engineering'));
  ok('the graduation window survives', description.includes('Spring 2027'));
  ok('entities are decoded', description.includes('$105,000 & $130,000'));
  ok('no markup reaches the store', !/<[a-z]/i.test(description));
  check('the criteria block is read', criteria, ['Seniority level: Entry level', 'Employment type: Full-time']);
}
{
  // LinkedIn serves a login wall or an empty shell often enough that this is
  // the normal failure, not an exotic one.
  const { description, criteria } = parsePosting('<html><body>Sign in to view</body></html>');
  check('a page with no description yields none', description, '');
  check('and no criteria', criteria, []);
}

console.log('🧪 import-linkedin: a posting with no body is skipped, never invented');
{
  const none = await fetchPosting('1', { fetchImpl: async () => ({ ok: true, text: async () => '<html></html>' }) });
  check('an empty body returns null', none, null);
  const gone = await fetchPosting('1', { fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) });
  check('a 404 returns null', gone, null);
  const broke = await fetchPosting('1', { fetchImpl: async () => { throw new Error('socket hang up'); } });
  check('a thrown fetch returns null rather than propagating', broke, null);
  const good = await fetchPosting('1', { fetchImpl: async () => ({ ok: true, text: async () => POSTING }) });
  ok('a real body comes back', good && good.description.includes('microreactor'));
  check('the detail endpoint is the public one', postingUrl('4467824399'),
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4467824399');
}

console.log('🧪 import-linkedin: a company whose board we read is never imported');
{
  const postings = [
    { id: '1', company: 'Applied Materials', title: 'Manufacturing Engineer I', loc: 'Austin, TX' },
    { id: '2', company: 'Radiant', title: '2027 New Graduate - Mechanical Engineer', loc: 'El Segundo, CA' },
    { id: '3', company: 'CyberCoders', title: 'Mechanical Engineer', loc: 'Remote' },
  ];
  const { take, skipped } = selectImportable(postings, {
    trackedKeys: new Set(['appliedmaterials']),
    storeRows: [],
  });
  check('only the unreachable company is imported', take.map(p => p.company), ['Radiant']);
  check('the tracked one is counted as tracked', skipped.tracked, 1);
  check('the agency is counted as filtered', skipped.filtered, 1);
}

console.log('🧪 import-linkedin: a posting we already hold is not duplicated');
{
  const postings = [
    { id: '1', company: 'Freeform', title: 'Mechanical Engineer (New Grad December 2026)', loc: 'Los Angeles, CA' },
    { id: '2', company: 'Freeform', title: 'Process Development Engineer', loc: 'Los Angeles, CA' },
  ];
  // The store already has the first one under a slightly different spelling —
  // which is the normal case, because a board title and a LinkedIn title are
  // rarely byte-identical.
  const { take, skipped } = selectImportable(postings, {
    trackedKeys: new Set(),
    storeRows: [{ company: 'Freeform', title: 'Mechanical Engineer, New Grad (December 2026)' }],
  });
  check('only the genuinely new posting is imported', take.map(p => p.title), ['Process Development Engineer']);
  check('the duplicate is counted', skipped.alreadyHave, 1);
  ok('near-identical titles match', titleOverlap('Mechanical Engineer (New Grad December 2026)', 'Mechanical Engineer, New Grad (December 2026)') >= 0.6);
  // …and the opposite error: two genuinely different roles at one company must
  // not collapse into one, or he silently loses a job.
  ok('different roles do not match', titleOverlap('Mechanical Engineer', 'Staff Software Engineer') < 0.6);
  ok('a shared first word is not a match', titleOverlap('Tooling Engineer', 'Thermal Engineer') < 0.6);
}

console.log('🧪 import-linkedin: two companies sharing one name');
{
  // The real case. portals.yml tracks "Radiant", a UK cloud company. Radiant
  // Industries of El Segundo builds nuclear microreactors and posted four reqs
  // naming his graduation window. Without an override the tracked check skips
  // the nuclear one as already covered, and its own site answers 403, so it is
  // reachable from nowhere.
  const postings = [
    { id: '1', company: 'Radiant', title: '2027 New Graduate - Mechanical Engineer', loc: 'El Segundo, CA' },
    { id: '2', company: 'Someone Else', title: 'Mechanical Engineer', loc: 'Austin, TX' },
  ];
  const tracked = new Set([companyKeyOf('Radiant')]);

  const plain = selectImportable(postings, { trackedKeys: tracked, storeRows: [] });
  check('without the override the collision hides it', plain.take.map(p => p.company), ['Someone Else']);
  check('and it is counted as tracked', plain.skipped.tracked, 1);

  const forced = selectImportable(postings, {
    trackedKeys: tracked, storeRows: [], only: 'Radiant', as: 'Radiant Nuclear',
  });
  check('--only takes just that company', forced.take.length, 1);
  check('--as renames it past the collision', forced.take[0].company, 'Radiant Nuclear');
  check('the title is untouched', forced.take[0].title, '2027 New Graduate - Mechanical Engineer');
  check('everything else is counted as not selected', forced.skipped.notSelected, 1);

  // --as must not become a way to import a company we can already read
  // properly. It applies to the selected company only.
  const scoped = selectImportable(
    [{ id: '3', company: 'Applied Materials', title: 'Manufacturing Engineer', loc: 'Austin, TX' }],
    { trackedKeys: new Set([companyKeyOf('Applied Materials')]), storeRows: [], only: 'Radiant', as: 'Radiant Nuclear' },
  );
  check('a different tracked company is still not imported', scoped.take.length, 0);
}

console.log('🧪 import-linkedin: the row it builds');
{
  const posting = {
    id: '4467824399',
    company: 'Radiant',
    title: '2027 New Graduate - Mechanical Engineer',
    loc: 'El Segundo, CA',
    posted: '2026-09-18',
    url: 'https://www.linkedin.com/jobs/view/2027-new-graduate-mechanical-engineer-at-radiant-4467824399',
  };
  const row = toStoreRow(posting, parsePosting(POSTING));
  check('url is the posting page', row.url, posting.url);
  check('title', row.title, posting.title);
  check('company', row.company, 'Radiant');
  check('location', row.location, 'El Segundo, CA');
  check('source says where it came from', row.source, 'linkedin');
  check('posted date becomes a timestamp', row.postedAt, Date.parse('2026-09-18T00:00:00Z'));
  ok('the criteria are appended to the body', row.description.includes('Seniority level: Entry level'));
  ok('the body is still there too', row.description.includes('microreactor'));
  // The card has to say the engine cannot drive this one, or he will queue it
  // for an apply run that silently does nothing.
  ok('the row says it is not applyable', /engine cannot fill/i.test(row.company_meta.notes));
  ok('triage ran on it', row.triage && row.triage.flags);
  // The whole reason this importer is allowed to exist: this posting is a real
  // 2027 new-grad req that export control used to hide.
  check('export control does not hard-block it', row.triage.flags.hardBlock, false);

  // A posting with no date must not become a row dated today — it would sort to
  // the top of a freshness-ordered deck it has not earned.
  const undated = toStoreRow({ ...posting, posted: '' }, parsePosting(POSTING));
  check('no date means no date', undated.postedAt, null);
}

console.log('🧪 import-linkedin: the same employer under another spelling (F-529)');
{
  const { isAliasDuplicate } = await import('./import-linkedin.mjs');
  const storeRows = [
    { company: 'Intuitive Surgical', title: 'Mechanical Engineer 2, Instruments' },
    { company: 'Varda Space', title: 'Space Avionics Systems Engineer II' },
    { company: 'Volta', title: 'Mechanical Engineer' },
    { company: 'Radiant Industries', title: 'Cloud Support Engineer' },
  ];
  const run = (company, title) => selectImportable([{ id: '1', company, title, loc: '' }], { trackedKeys: new Set(), storeRows });
  // LinkedIn's spelling, the board's posting: one job, already held properly.
  check('"Intuitive" with a title the Intuitive Surgical board carries is a duplicate', run('Intuitive', 'Mechanical Engineer 2, Instruments').take.length, 0);
  check('…and it is counted as one', run('Intuitive', 'Mechanical Engineer 2, Instruments').skipped.alias, 1);
  check('"Varda Space Industries" likewise', run('Varda Space Industries', 'Space Avionics Systems Engineer II').take.length, 0);
  // A job the board does not show is NOT a duplicate, whatever the names say.
  check('a title that board does not carry is imported', run('Intuitive', 'Robotics Software Engineer').take.length, 1);
  // The F-505 direction: similar names, different companies. The nuclear Radiant
  // posts a mechanical new-grad req; the cloud Radiant's board has nothing like it.
  check('the nuclear Radiant is not the cloud Radiant', run('Radiant', '2027 New Graduate - Mechanical Engineer').take.length, 1);
  // A shared title is not enough without the name relation…
  check('an unrelated company with the same title is imported', run('Matic Robots', 'Mechanical Engineer').take.length, 1);
  // …and a short shared prefix is not a name relation.
  ok('a four-letter key never aliases anything', !isAliasDuplicate('volt', 'Mechanical Engineer', new Map([['volta', ['Mechanical Engineer']]])));
  // The one case the rule accepts a loss on, stated so nobody is surprised:
  // "Voltava" leads with "Volta" AND posts the identical generic title.
  check('known limit: a led-by name with an identical title reads as a duplicate', run('Voltava', 'Mechanical Engineer').take.length, 0);
  check('--as overrides it, as it overrides the tracked check', selectImportable([{ id: '1', company: 'Voltava', title: 'Mechanical Engineer', loc: '' }], { storeRows, only: 'Voltava', as: 'Voltava (battery)' }).take.length, 1);
}

console.log('🧪 import-linkedin: a rate limit is not an empty posting (F-509)');
{
  // One 429, then the page. The first version returned null here and the caller
  // counted a throttled posting as "description came back empty".
  let n = 0; const waits = [];
  const fetchImpl = async () => (++n === 1 ? { ok: false, status: 429, text: async () => '' } : { ok: true, text: async () => POSTING });
  const got = await fetchPosting('1', { fetchImpl, pause: async (ms) => { waits.push(ms); }, backoff: 1000 });
  ok('the posting behind the rate limit is read', !!got && got.description.length > 0);
  check('after waiting the backoff', waits, [1000]);
  // LinkedIn stays shut: give up on this one posting, after the retry budget.
  let calls = 0;
  const shut = await fetchPosting('1', { fetchImpl: async () => { calls++; return { ok: false, status: 429, text: async () => '' }; }, pause: async () => {}, retries: 2 });
  check('a rate limit that never lifts ends as null', shut, null);
  check('after the retry budget, not forever', calls, 3);
}

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
