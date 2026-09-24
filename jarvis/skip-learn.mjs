// jarvis/skip-learn.mjs — turn his skips into rules he can accept or reject.
//
// THE FAULT THIS CLOSES
// ─────────────────────
// `skip-reasons.jsonl` had one writer and zero readers. `skipFeedback` was read
// only by the backup script. Skipping a posting changed nothing about what he
// was shown next, and he said so plainly: "it geuninely feels like this skip
// thing is useless."
//
// The endpoint's own comment always said the log's value was that "reading a
// few hundred skip reasons together tells you which rule to add to
// preferences.md". That is a real design — it is just a design that requires
// somebody to do the reading, and in five weeks nobody did. So this does the
// reading.
//
// WHAT IT WILL NOT DO
// ───────────────────
// It does not re-rank anything, and it does not write a rule. Every output is
// a PROPOSAL with its evidence and its blast radius attached, for him to accept
// or reject. A scorer that quietly learns preferences he never stated is a
// scorer he cannot audit, and the whole product is built the other way round —
// every rule is a line he can read in `preferences.md` and delete.
//
// HOW A PROPOSAL EARNS ITS PLACE
// ──────────────────────────────
// A word that appears in his skips is not evidence; "engineer" appears in all
// of them. What matters is a word appearing in skips MORE than it appears in
// the deck he is choosing from. That ratio is the whole method, and it is why
// the deck has to be passed in — without a baseline this would propose
// blocking "manufacturing".

/** Words that carry no signal about whether he wants a job. */
const STOP = new Set([
  'the', 'and', 'or', 'of', 'for', 'to', 'in', 'at', 'on', 'with', 'a', 'an',
  'engineer', 'engineering', 'senior', 'sr', 'jr', 'junior', 'staff', 'lead',
  'i', 'ii', 'iii', 'iv', 'v', '1', '2', '3', 'new', 'grad', 'graduate',
  'college', 'entry', 'level', 'united', 'states', 'america', 'usa', 'us',
  'inc', 'llc', 'corp', 'ltd', 'co', 'group', 'team', 'department',
]);

const words = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9+#/ ]+/g, ' ')
  .split(/\s+/)
  // Pure numbers are years and req ids. "2027" is his GRADUATION YEAR, and the
  // learner proposed blocking it because five reqs he skipped carried it.
  .filter(w => w.length >= 3 && !STOP.has(w) && !/^[0-9]+$/.test(w));

/**
 * Read a set of skips against the deck they came from.
 *
 * @param {Array} skips  {title, company, reasons[], note, fit}
 * @param {Array} deck   {title, company} — what he is choosing FROM
 * @param {{minSkips?:number, lift?:number}} opts
 * @returns {{proposals:Array, notes:Array, reasons:Array, totals:object}}
 */
export function learnFromSkips(skips = [], deck = [], opts = {}) {
  const minSkips = opts.minSkips ?? 3;
  const lift = opts.lift ?? 3;

  // WORDS AND EMPLOYERS THIS MUST NEVER PROPOSE BLOCKING.
  //
  // Run against his real skips, the first version proposed — in order —
  // "block manufacturing", "hide Applied Materials", "block mechanical",
  // "block design" and "block semiconductor". His target role, the company he
  // interned at and has applied to, his degree, and his industry.
  //
  // The statistics were not wrong: he really does skip manufacturing postings
  // at three times the deck rate, because he is picky WITHIN his own field.
  // That is what being picky looks like, and reading it as "does not want
  // manufacturing" inverts it. Frequency cannot tell those apart, so the
  // protected set comes from the user-layer files instead — target roles,
  // skills, industries — and from his own positive decisions.
  const protectedWords = new Set([...(opts.protect || [])].flatMap(t => words(t)));
  const protectedCos = new Set((opts.protectCompanies || []).map(c => String(c).toLowerCase()));

  // SOME REASONS ARE NOT PREFERENCES.
  //
  // "Dead posting / no longer live" and "Already applied" were added to the
  // reason list on 2026-09-19 because they are the true reason he removes a lot
  // of rows. Neither says anything about the kind of work he wants: a posting
  // being gone is a fact about the world, and having already applied is the
  // opposite of a rejection. Counting them here would teach the learner to
  // block the employers he applies to most and the roles that fill fastest.
  const NOT_A_PREFERENCE = /^(dead posting|already applied)/i;
  const informative = skips.filter(Boolean).filter(s => {
    const rs = Array.isArray(s?.reasons) ? s.reasons : [];
    return !(rs.length && rs.every(r => NOT_A_PREFERENCE.test(String(r))));
  });

  // One opening, one vote. Hiding a group of six duplicate reqs is one
  // decision, and counting it six times would manufacture a preference.
  const seenReq = new Set();
  const S = informative.filter(s => {
    const k = `${s.company}|${String(s.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    if (seenReq.has(k)) return false;
    seenReq.add(k);
    return true;
  });
  const D = deck.filter(Boolean);

  // Words that are LOCATIONS, not descriptions of the work. Micron and Applied
  // Materials append the site to the title — "New College Grad Diffusion
  // Process Engineer Manassas Virginia United States Of America" — so the
  // learner proposed blocking "santa" and "clara". Santa Clara is one of his
  // preferred hubs. Any word appearing in some posting's own location field is
  // disqualified from being read as a preference about the job.
  const placeWords = new Set();
  for (const r of [...S, ...D]) for (const w of words(r.location)) placeWords.add(w);

  const proposals = [];

  // ── companies ────────────────────────────────────────────────────
  // The cheapest, most reliable signal: he skipped several postings from one
  // employer. One Hermeus skip left 41 more queued behind it.
  const byCo = new Map();
  for (const s of S) {
    const c = String(s.company || '').trim();
    if (!c) continue;
    if (!byCo.has(c)) byCo.set(c, []);
    byCo.get(c).push(s);
  }
  for (const [company, hits] of byCo) {
    if (hits.length < minSkips) continue;
    // An employer he has applied to, queued or hearted is not a preference
    // against that employer, however many of their reqs he has passed on.
    if (protectedCos.has(company.toLowerCase())) continue;
    const inDeck = D.filter(j => j.company === company).length;
    if (!inDeck) continue;
    proposals.push({
      kind: 'company',
      action: 'hide-company',
      target: company,
      headline: `Hide ${company}`,
      why: `You skipped ${hits.length} of their postings.`,
      evidence: hits.slice(0, 4).map(h => h.title),
      wouldRemove: inDeck,
      examples: D.filter(j => j.company === company).slice(0, 3).map(j => j.title),
    });
  }

  // ── companies, from what he WROTE rather than how often ──────────
  //
  // The rule above needs `minSkips` repeats before it will name an employer.
  // He skipped ONE Hermeus posting and wrote "defense company cant work", so
  // it proposed nothing — and 31 Hermeus reqs stayed in his deck, five of them
  // at fit 88.
  //
  // Worse, the note themes below reported that complaint as already handled,
  // because "defense titles are blocked outright". True, and irrelevant:
  // Hermeus posts "Structures Manufacturing Engineer" and "Avionics
  // Manufacturing Engineer". No title rule can see that the employer builds
  // hypersonic aircraft, and he is on F-1/OPT.
  //
  // When his own sentence names an EMPLOYER-level disqualifier, one skip is
  // enough to propose. Frequency is a proxy for a reason; here he gave the
  // reason. It still only ever proposes — same contract as everything else in
  // this panel.
  const EMPLOYER_LEVEL = [
    { re: /\b(defen[cs]e|itar|clearance|military|classified)\b/i,
      why: 'you wrote that this is a defense employer' },
    { re: /\b(no|not|does\s?n'?t|do\s?n'?t|wo\s?n'?t|cannot|can\s?n?'?t)\b[^.]{0,20}\bsponsor/i,
      why: 'you wrote that they do not sponsor' },
  ];
  const alreadyProposed = new Set(proposals.map(p => String(p.target).toLowerCase()));
  for (const s of S) {
    const note = String(s.note || '').trim();
    const company = String(s.company || '').trim();
    if (!note || !company) continue;
    if (protectedCos.has(company.toLowerCase())) continue;
    if (alreadyProposed.has(company.toLowerCase())) continue;
    const rule = EMPLOYER_LEVEL.find(r => r.re.test(note));
    if (!rule) continue;
    const inDeck = D.filter(j => j.company === company).length;
    if (!inDeck) continue;
    alreadyProposed.add(company.toLowerCase());
    proposals.push({
      kind: 'company-note',
      action: 'hide-company',
      target: company,
      headline: `Hide ${company} — ${rule.why}`,
      why: `Your note on "${s.title}" said so. A title rule cannot see this: none of their postings say it.`,
      evidence: [note],
      wouldRemove: inDeck,
      examples: D.filter(j => j.company === company).slice(0, 3).map(j => j.title),
    });
  }

  // ── launch and spaceflight employers ─────────────────────────────
  //
  // F-25 is his own decision, in his own words: "if space jobs is itar then it
  // can fuck off completely." It was implemented as text rules over the space
  // VOCABULARY, plus a one-time manual hide of Boeing, Astro Mechanica, Ursa
  // Major and Relativity Space — hidden by hand precisely because their
  // postings carry no description for a text rule to match.
  //
  // Nothing generalised that. A launch company whose postings arrive later, or
  // arrive title-only, walks straight back into the deck: Rocket Lab's
  // "Manufacturing Engineer I" sat at fit 81 with no description, and the
  // field classifier reads it as `industrial` because the title says nothing
  // about space. Varda Space's "Space Mission Operations Engineer" is in on
  // the same route.
  //
  // The employer IS the signal here, and no rule was reading the employer. So
  // this proposes — never acts — when a company whose entire business is
  // launch or spaceflight has postings in his deck. Deliberately a short list
  // of primary-business launch/space firms: a large manufacturer with a space
  // division is NOT on it, because that would take real jobs with it.
  const LAUNCH_EMPLOYERS = [
    'spacex', 'rocket lab', 'blue origin', 'firefly aerospace', 'astra space',
    'sierra space', 'stoke space', 'abl space systems', 'relativity space',
    'astro mechanica', 'ursa major', 'varda space', 'impulse space',
    'axiom space', 'vast space', 'phantom space', 'launcher',
  ];
  const seenSpace = new Set(proposals.map(p => String(p.target).toLowerCase()));
  const deckByCo = new Map();
  for (const j of D) {
    const c = String(j.company || '').trim();
    if (!c) continue;
    if (!deckByCo.has(c)) deckByCo.set(c, []);
    deckByCo.get(c).push(j);
  }
  for (const [company, jobs] of deckByCo) {
    const lc = company.toLowerCase();
    if (!LAUNCH_EMPLOYERS.some(e => lc === e || lc.startsWith(e + ' ') || lc.includes(e))) continue;
    if (protectedCos.has(lc) || seenSpace.has(lc)) continue;
    seenSpace.add(lc);
    proposals.push({
      kind: 'space-employer',
      action: 'hide-company',
      target: company,
      headline: `Hide ${company} — launch and spaceflight`,
      why: 'You decided space was out entirely: "if space jobs is itar then it can fuck off completely." '
         + 'The text rules for that only catch postings that SAY they are space work, and these do not.',
      evidence: jobs.slice(0, 3).map(j => j.title),
      wouldRemove: jobs.length,
      examples: jobs.slice(0, 3).map(j => j.title),
    });
  }

  // ── title words ──────────────────────────────────────────────────
  // A word is only evidence if it is over-represented in the skips relative to
  // the deck. Without the baseline this proposes blocking "manufacturing".
  const skipFreq = new Map();
  for (const s of S) {
    for (const w of new Set(words(s.title))) skipFreq.set(w, (skipFreq.get(w) || 0) + 1);
  }
  const deckFreq = new Map();
  for (const j of D) {
    for (const w of new Set(words(j.title))) deckFreq.set(w, (deckFreq.get(w) || 0) + 1);
  }

  for (const [w, n] of skipFreq) {
    if (n < minSkips) continue;
    // Never his own field. See the note above the protected set.
    if (protectedWords.has(w)) continue;
    if (placeWords.has(w)) continue;
    const skipRate = n / Math.max(1, S.length);
    const deckRate = (deckFreq.get(w) || 0) / Math.max(1, D.length);
    // A word he skips at 3x the rate it appears in the deck is a preference.
    if (deckRate > 0 && skipRate / deckRate < lift) continue;
    const hits = D.filter(j => words(j.title).includes(w));
    if (!hits.length) continue;
    proposals.push({
      kind: 'title',
      action: 'add-rule',
      target: w,
      rule: `no ${w} in title`,
      headline: `Block "${w}" in the title`,
      why: `It is in ${n} of your ${S.length} skips (${Math.round(skipRate * 100)}%) but only ${Math.round(deckRate * 100)}% of the deck.`,
      evidence: S.filter(s => words(s.title).includes(w)).slice(0, 4).map(s => s.title),
      wouldRemove: hits.length,
      examples: hits.slice(0, 3).map(j => j.title),
    });
  }

  // Strongest evidence first, then by how much work it saves.
  proposals.sort((a, b) => (b.evidence.length - a.evidence.length) || (b.wouldRemove - a.wouldRemove));

  // ── the reasons and notes themselves ─────────────────────────────
  // Not every skip becomes a rule, and the free text is the richest signal
  // there is — "it needs electrical engineering degree i am mechanical bruh"
  // was one line and became a whole module. Surfaced verbatim rather than
  // parsed, because guessing at what he meant is how a scorer starts lying.
  const reasonCount = new Map();
  for (const s of S) for (const r of (s.reasons || [])) reasonCount.set(r, (reasonCount.get(r) || 0) + 1);
  const reasons = [...reasonCount.entries()]
    .map(([reason, n]) => ({ reason, n }))
    .sort((a, b) => b.n - a.n);

  const notes = S.filter(s => String(s.note || '').trim())
    .map(s => ({ note: String(s.note).trim(), title: s.title, company: s.company, at: s.at }))
    .reverse();

  // WHAT HIS NOTES WERE ABOUT, AND WHETHER ANYTHING WAS DONE.
  //
  // Zero rule proposals is often the honest answer — on 29 skips every
  // statistical pattern was his own field, a place name or a year. The notes
  // are where the signal actually is, and the thing worth telling him is not
  // "here are your notes" but "four of these were the same complaint, and it
  // is handled now". A feedback loop he cannot see the far end of is one he
  // will stop feeding.
  const THEMES = [
    { key: 'degree-level', label: 'Wanted a Master\'s or PhD', re: /\b(phd|ph\.d|doctora(te|l)|master'?s?|grad(uate)? degree|degree level)\b/i, handledBy: 'Masters- and PhD-only postings are blocked now, read from the title or the body' },
    { key: 'degree-field', label: 'Wanted a different degree', re: /\b(electrical|ee\b|computer science|chemical|wrong degree)\b/i, handledBy: 'postings that require a degree you do not have are blocked, with the sentence quoted' },
    { key: 'location', label: 'Not in the US', re: /\b(not in (the )?us|outside the us|abroad|overseas|wrong country|foreign)\b/i, handledBy: 'foreign postings are filtered out, including ones whose location does not parse' },
    { key: 'defense', label: 'Defense or clearance', re: /\b(defen[cs]e|itar|clearance|military|classified)\b/i, handledBy: 'defense titles are blocked outright' },
    { key: 'pay', label: 'Pay too low', re: /\b(pay|salary|comp|underpaid|low\b)/i, handledBy: 'a new-grad posting is judged on the bottom of its pay band, not the top' },
    { key: 'shift', label: 'Shift or schedule', re: /\b(shift|night|graveyard|weekend|rotating)\b/i, handledBy: 'night, rotating and letter shifts are blocked; day shifts are kept' },
    { key: 'visa', label: 'No sponsorship', re: /\b(sponsor|visa|h1b|opt\b|citizen)\b/i, handledBy: 'work-authorisation blocks quote the sentence that caused them' },
  ];
  const themes = THEMES.map(t => {
    const hits = notes.filter(n => t.re.test(n.note));
    return hits.length ? { key: t.key, label: t.label, n: hits.length, handledBy: t.handledBy, examples: hits.slice(0, 3).map(h => h.note) } : null;
  }).filter(Boolean).sort((a, b) => b.n - a.n);

  const unthemed = notes.filter(n => !THEMES.some(t => t.re.test(n.note)));

  return {
    proposals,
    reasons,
    notes,
    themes,
    unthemed,
    totals: { skips: S.length, deck: D.length, proposals: proposals.length },
  };
}

/**
 * What the APPLICATION FORMS gave away that the job descriptions did not.
 *
 * Triage can only read what a posting says, and an ITAR employer routinely
 * says nothing — the question only appears once you are inside the form. The
 * apply engine has been walking those forms for a month and recording every
 * field it could not answer, so the evidence was already in the store; nothing
 * was reading it. The roadmap called this out and it sat unbuilt:
 *
 *   "the apply engine found US-person/ITAR questions on Machina Labs and
 *    Hadrian forms that the JD text never mentioned, so triage did not flag
 *    them. Feeding that back into the store would catch ITAR employers the JD
 *    hides."
 *
 * Deliberately narrow. A general export-control disclosure is boilerplate at
 * any large manufacturer — Micron asks one, and Micron is a top target. What
 * counts is the form asking him to ASSERT he is a US Person, or naming ITAR:
 * that is a gate, not a notice.
 *
 * @param {Array} prepared  {company, title, apply:{needsInput,review}}
 * @returns {Array} proposals, same shape and same contract as the skip ones
 */
export function learnFromApplyForms(prepared = []) {
  const GATE = /\bu\.?\s?s\.?\s*person\b|\bitar\b/i;
  const byCo = new Map();

  for (const j of prepared.filter(Boolean)) {
    const a = j.apply || {};
    const fields = [...(a.needsInput || []), ...(a.review || [])];
    for (const f of fields) {
      const label = String(f.label || f.l || '');
      if (!GATE.test(label)) continue;
      const co = String(j.company || '').trim();
      if (!co) continue;
      if (!byCo.has(co)) byCo.set(co, { titles: new Set(), quotes: new Set() });
      byCo.get(co).titles.add(String(j.title || ''));
      byCo.get(co).quotes.add(label.replace(/\s+/g, ' ').slice(0, 160));
      break;
    }
  }

  return [...byCo.entries()].map(([company, v]) => ({
    kind: 'form-gate',
    action: 'hide-company',
    target: company,
    headline: `Hide ${company} — their form asks if you are a U.S. Person`,
    why: `The job description never said so. The application form did, on ${v.titles.size} of their postings you had prepared.`,
    evidence: [...v.quotes].slice(0, 2),
    wouldRemove: v.titles.size,
    examples: [...v.titles].slice(0, 3),
  }));
}

export const _internals = { words, STOP };
