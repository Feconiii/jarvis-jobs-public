/**
 * TAILORING — reshape a bullet's WORDING to a job description, never its claims.
 *
 * The rule this file enforces (Alex, 2026-08-30): "i want you to tailor the
 * wording and shi to match the jd as best as it can ... while staying true to my
 * resume." Before today the pool was verbatim-locked to cv.md and
 * resume-variants.test.mjs failed the build on any drift. That guard was the
 * right instinct and the wrong shape: it made rewording impossible, so it had to
 * be replaced rather than deleted. Deleting it would leave nothing between a
 * language model and a resume.
 *
 * WHAT IS MECHANICALLY GUARANTEED HERE:
 *
 *   1. Numbers. Any figure in a rewrite must appear in its source bullet.
 *      "reduced scrap 12%" cannot become "reduced scrap 30%", and a rewrite
 *      cannot introduce a metric the source never had.
 *   2. Named things. Tools, software, materials, standards, companies, job
 *      titles — anything that reads as a proper noun or an acronym — must appear
 *      in the source bullet. A JD asking for SolidWorks cannot make an Inventor
 *      bullet say SolidWorks.
 *   3. Vocabulary. Every remaining content word must appear SOMEWHERE in cv.md.
 *      This is the net that catches lowercase inventions — "lean", "welded",
 *      "six sigma" — that slip past the first two because they are neither
 *      numbers nor capitalised.
 *
 * WHAT IS NOT, AND WHY IT IS SAID OUT LOUD: swapping one word cv.md already
 * contains for another — "assembled" to "designed" — is inside the vocabulary
 * and no string check can see the difference. That is the part the model is
 * trusted with, so every rewrite is recorded with its source for a side-by-side
 * diff. Mechanical where a machine can decide; visible where it cannot.
 */
import { proofread } from './proofread.mjs';

/**
 * Ordinary English that carries no claim. Deliberately FUNCTION WORDS ONLY.
 *
 * Action verbs are NOT in here, and that is the whole point: "assembled" and
 * "designed" are different claims about what he did, so they have to face the
 * vocabulary check rather than being waved through as filler.
 */
export const STOPWORDS = new Set(`
a an the and or but nor so yet of to in on at by for with from into onto over under
above below between among across through during before after while since until about
as if then than that which who whom whose this these those it its their his her our
your my we they he she you i is are was were be been being am do does did doing have
has had having will would shall should can could may might must not no nor all any
each both few more most other some such only own same too very just also well up out
off down there here when where why how what because though although however whether
per via within without toward towards upon against along around behind beside besides
`.trim().split(/\s+/));

/**
 * Split text into comparable tokens.
 *
 * Keeps internal punctuation that is part of a name — GD&T, Node-RED, MIG/TIG,
 * Fusion 360, 5-axis — because splitting those produces tokens ("T", "RED")
 * that match nothing and would fail every honest rewrite.
 */
export function tokens(text) {
  return String(text || '')
    .split(/[\s,;:()[\]"'‘’“”]+/)
    .map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9%+]+$/g, ''))
    .filter(Boolean);
}

/** Fold a token for comparison: casing and stray punctuation are not claims. */
export const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%+&/.-]+/g, '');

/**
 * Every figure in the text, normalised so "3,689" and "3689" are one claim and
 * a trailing percent stays attached ("40%" is a different claim from "40").
 */
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?\s*%?/g)) {
    out.add(m[0].replace(/[,\s]/g, ''));
  }
  return out;
}

/**
 * Tokens that read as NAMED things rather than ordinary words.
 *
 * A token qualifies if it is all-caps (CNC, GD&T), carries an internal capital
 * (SolidWorks, RoboDK), mixes letters with digits (5-axis), or is simply
 * capitalised somewhere other than the first word. The first word is exempt from
 * the plain-capital test because every sentence starts capitalised — "Designed"
 * leading a bullet says nothing about whether Designed is a name.
 */
export function entitiesIn(text) {
  const out = new Set();
  const list = tokens(text);
  list.forEach((raw, i) => {
    const bare = raw.replace(/[^A-Za-z0-9&/.+-]/g, '');
    if (!bare) return;
    const hasDigit = /\d/.test(bare);
    const hasLetter = /[A-Za-z]/.test(bare);
    const internalCap = /[A-Za-z][A-Z]/.test(bare);
    const allCaps = hasLetter && bare === bare.toUpperCase() && /[A-Z]{2,}/.test(bare);
    const leadingCap = /^[A-Z]/.test(bare);
    const named = allCaps || internalCap || (hasDigit && hasLetter) || (leadingCap && i > 0);
    if (named) out.add(fold(bare));
  });
  return out;
}

/**
 * Crude stem, applied to BOTH sides of the vocabulary check.
 *
 * It only has to be consistent, not linguistically right: cv.md saying
 * "Designed" has to cover a rewrite saying "Designing", and it does because
 * both land on "design". Stemming only one side was the bug this replaced.
 */
export function stem(word) {
  let w = fold(word);
  if (w.length < 4) return w;
  // Order matters and so does the double-s guard: a naive (es|s)$ strips
  // "times" to "tim" but "time" to "time", and "processes" to "process" but
  // "process" to "proces" - two words that should match landing apart. Peel one
  // suffix, then drop a trailing silent e so "time"/"times" and
  // "fixture"/"fixtures" meet in the middle.
  if (/ies$/.test(w)) w = `${w.slice(0, -3)}y`;
  // "identified" and "identifying" must meet: -ied → y, so both land on
  // "identify" (measured: "identifying" was refused against a cv.md that
  // says "identified", 2026-09-03).
  else if (/ied$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/ing$/.test(w) && w.length > 5) w = w.slice(0, -3);
  else if (/ed$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (/es$/.test(w) && w.length > 4 && !/ses$/.test(w)) w = w.slice(0, -2);
  else if (/[^s]s$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

/**
 * Every distinct word in a document, for the vocabulary net. Hyphenated and
 * slashed compounds are indexed whole AND in pieces, so cv.md saying
 * "machine-vision" covers a rewrite that says "machine vision". Stems are
 * indexed alongside the words themselves.
 */
export function buildVocabulary(text) {
  const vocab = new Set();
  const add = (w) => { if (w) { vocab.add(w); vocab.add(stem(w)); } };
  for (const t of tokens(text)) {
    const f = fold(t);
    if (!f) continue;
    add(f);
    for (const piece of f.split(/[/&.-]+/)) add(piece);
  }
  return vocab;
}
/**
 * A rewrite may not run away with the page. The plans are budgeted in lines and
 * all four resumes already sit near full, so a bullet that grows by half is a
 * layout bug even when every claim in it is honest.
 */
export const MAX_GROWTH = 1.35;

/**
 * Claims he cannot make, whatever the posting asks for (Alex, 2026-09-03).
 *
 * These are phrases rather than words because the words themselves are in
 * cv.md for honest reasons: "plasma cutters" is Makerspace, "deposition" is the
 * product group he supported. What is forbidden is the CLAIM — that he tuned
 * a process, programmed a PLC, or did electrical engineering. cv.md
 * deliberately does not list these, because every word in cv.md is allowed
 * vocabulary; the refusal has to live here.
 *
 * Two entries came out on 2026-09-17, both of them mine and both wrong about
 * him: he has worked with Linux, and he holds the Six Sigma Yellow Belt.
 * Linux is in cv.md's skills and the belt has its own Certifications section,
 * so a bullet naming either one is sourced. A certification he does NOT hold
 * is still refused, by the word rather than by a list of names.
 */
/** The Applied Materials robot work that must never be called commissioning (2026-09-23). */
export const NOT_COMMISSIONED = /^amat\.(?:robodk|cobot-install|cobot-rack|amr)\b/;

export const FORBIDDEN = [
  [/\bPLCs?\b/, 'PLC experience'],
  [/\bladder logic\b/i, 'PLC experience'],
  [/\bcertif(?:ied|ication|icate)s?\b/i, 'a certification'],
  [/\belectrical engineer/i, 'electrical engineering expertise'],
  [/\b(?:deposition|etch|wafer|process) recipes?\b/i, 'recipe optimisation'],
  [/\bplasma chemistr/i, 'plasma chemistry'],
  [/\bfilm (?:propert|thickness|stress|uniformity)/i, 'film properties'],
  [/\brecipe (?:optimi[sz]|tun|develop)/i, 'recipe optimisation'],
  // THE FRAMEWORKS THAT ARE A STUDY, NOT A WAY OF THINKING (Alex, 2026-09-13).
  //
  // He opened the door to method names: "make note of all the problem solving
  // frameworks in the postings and add that to my cv md, coz legit i probably
  // used it without knowing before." That is true of 5 Whys, a fishbone, a
  // Pareto, PDCA, poka-yoke — you can run one without being told its name, and
  // cv.md now names the work each one describes.
  //
  // It is not true of these. A DOE has a factor table, an SPC chart has limits,
  // a Cpk has a number, a Gage R&R has an operator-by-part matrix. One
  // interview question goes straight through a claim to any of them, and the
  // interviewer asking it is the engineer who ran one. They stay out of cv.md
  // entirely — that file is the whole allowed vocabulary, so listing them there
  // to forbid them would allow them — and the refusal lives here instead.
  // He can promote any of them by saying he has done it; that is one line in
  // cv.md and one line deleted from this list.
  [/\bdesign of experiments\b|\bDOE\b/i, 'a design of experiments'],
  [/\bstatistical process control\b|\bSPC\b|\bcontrol charts?\b/i, 'SPC'],
  [/\bC?pk\b|\bPpk\b|\bprocess capabilit/i, 'a process capability study'],
  [/\bgau?ge r\s*&?\s*r\b|\bMSA\b|\bmeasurement system analysis\b/i, 'a Gage R&R'],
  [/\bcontrol plans?\b/i, 'a control plan'],
  [/\bIQ\s*\/?\s*OQ\s*\/?\s*PQ\b/i, 'IQ/OQ/PQ validation'],
  [/\bOEE\b|\boverall equipment effectiveness\b/i, 'OEE'],
  // The Yellow Belt is his (cv.md, Certifications). The two above it are not.
  [/\b(?:green|black) belt\b/i, 'a Six Sigma Green or Black Belt'],
];

/**
 * Filler that gives ownership away. A rewrite may not START with one of these
 * when the approved wording does not — "Deployed and validated" must never
 * come back as "Supported deployment of". Measured on a live Neuralink pass,
 * 2026-09-03: the model swapped the short form's strong verb for the long
 * form's weak one and the resume got worse, honestly.
 */
export const WEAK_OPENERS = /^(?:helped|assisted|supported|responsible for|worked on|participated|contributed|involved in|aided)\b/i;

/**
 * Bullets that ship in his own words, whatever the posting says.
 *
 * Alex, 2026-09-13, on the Amazon Process Engineer page: *"ngl that machine
 * vision fixture reads so bad… it mumbles then it adds in the for pin
 * inspection at the end… from now on we should just use the default sentence
 * i had in my resume for that bullet, dont clutter it too much."*
 *
 * The rewrite was legal — every word of it traced to an approved wording —
 * and it was still worse than the sentence he wrote. It had reached for the
 * long form's drawings/BOM/Teamcenter facts, kept the short form's opening,
 * and hung the purpose off the end as a trailing phrase. Three approved
 * sources in one sentence is how a bullet ends up saying everything and
 * landing nothing.
 *
 * The checker cannot catch this: it tests truth, length and vocabulary, not
 * whether a sentence reads well. So this bullet is simply not the tailor's to
 * rewrite. It still gets chosen, ordered and dropped like any other — only
 * its WORDS are fixed.
 */
/*
 * `amat.amr` JOINS IT, 2026-09-22. He rewrote both bullets himself, to two
 * printed lines each, and said to keep them that way. What he cut he meant to
 * cut — "10+ test runs" is gone from the AMR bullet and "quality-control
 * traceability" from the fixture — so a tailor that re-expands either one to
 * three lines is undoing his edit, not improving it. Locking is the only
 * mechanism that holds: the checker tests truth and vocabulary, and a longer
 * version of his sentence passes both.
 */
export const LOCKED = new Set(['amat.vision-fixture', 'amat.amr']);

/**
 * Check ONE rewritten bullet against the source sentence(s) it may draw on.
 * `source` may be a string or an array — a pool bullet has both a long and a
 * short form, and both trace to a file Alex wrote himself.
 *
 * Returns { ok, problems, notices }. `problems` refuse the rewrite; `notices` are
 * for him to read — chiefly a figure the rewrite dropped, which is legal but
 * worth seeing, because losing a number usually means losing the bullet's point.
 */
export function checkRewrite({ text, source, vocab, label = 'bullet' }) {
  const problems = [];
  const notices = [];
  const rewritten = String(text || '').trim();
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean).map(String);
  const srcJoined = sources.join(' • ');

  if (!rewritten) return { ok: false, problems: [`${label}: rewrite is empty`], notices };
  if (!sources.length) return { ok: false, problems: [`${label}: no source bullet to check against`], notices };

  // 1 — figures
  const srcNums = numbersIn(srcJoined);
  const outNums = numbersIn(rewritten);
  for (const n of outNums) {
    if (!srcNums.has(n)) problems.push(`${label}: figure "${n}" is not in the source bullet`);
  }
  for (const n of srcNums) {
    if (!outNums.has(n)) notices.push(`${label}: dropped the figure "${n}"`);
  }

  // 2 — named things
  const srcEnts = entitiesIn(srcJoined);
  const srcFolded = fold(srcJoined);
  for (const e of entitiesIn(rewritten)) {
    if (srcEnts.has(e)) continue;
    // A name may also be assembled from pieces the source has, so fall back to a
    // containment test against the folded source before calling it invented.
    if (srcFolded.includes(e)) continue;
    // A compound joined from things the source has ("drawings/BOM" from
    // "drawings and BOM", "MIG/TIG") names nothing new: every piece is his.
    const pieces = e.split(/[/&-]+/).filter(Boolean);
    const srcWords = new Set(tokens(srcJoined).map((t) => fold(t).replace(/s$/, '')));
    if (pieces.length > 1 && pieces.every((pc) => srcWords.has(pc.replace(/s$/, '')))) continue;
    problems.push(`${label}: "${e}" is named in the rewrite but not in the source bullet`);
  }

  // 3 — vocabulary
  if (vocab && vocab.size) {
    for (const t of tokens(rewritten)) {
      const f = fold(t);
      if (!f || STOPWORDS.has(f) || /^\d/.test(f)) continue;
      if (vocab.has(f)) continue;
      // Plurals and tenses are wording, not claims: cv.md saying "fixtures"
      // covers a rewrite saying "fixture", and "Designed" covers "Designing".
      if (vocab.has(stem(f))) continue;
      if (f.split(/[/&.-]+/).filter(Boolean).every((p) => vocab.has(p) || vocab.has(stem(p)))) continue;
      problems.push(`${label}: "${t}" appears nowhere in cv.md`);
    }
  }

  // 4 — page budget
  const longest = Math.max(...sources.map((s) => s.length), 1);
  if (rewritten.length > longest * MAX_GROWTH) {
    problems.push(`${label}: rewrite is ${rewritten.length} chars against a ${longest}-char source — over the ${MAX_GROWTH}x page budget`);
  }

  // 5 — claims he cannot make, in any wording
  for (const [re, what] of FORBIDDEN) {
    if (re.test(rewritten) && !sources.some((src) => re.test(src))) problems.push(`${label}: claims ${what}, which he does not have`);
  }

  // 6 — never weaker than his own words
  if (WEAK_OPENERS.test(rewritten) && !sources.every((src) => WEAK_OPENERS.test(src))) {
    problems.push(`${label}: opens with "${rewritten.match(WEAK_OPENERS)[0]}" — weaker than the approved wording, which owns the work`);
  }

  // 6b — "commissioning" is his word for some work and not for this. His
  // call, 2026-09-23: "drop for cobot and amr work, relevant for everything
  // else". The cobot cell was installed and integrated, not commissioned.
  if (NOT_COMMISSIONED.test(label) && /\bcommission/i.test(rewritten) && !sources.some((src) => /\bcommission/i.test(src))) {
    problems.push(`${label}: says commissioning — the cobot and AMR work was integration and deployment, not commissioning`);
  }

  // 7 — a literal mistake. His pool is proofread clean, so a rewrite that
  // brings one in is worse than the wording it replaces (his concern,
  // 2026-09-23: "literal mistakes and grammar in the resume").
  for (const p of proofread(withPeriod(rewritten))) problems.push(`${label}: ${p}`);

  return { ok: problems.length === 0, problems, notices };
}

/** Every bullet on his page ends with a period; a rewrite missing one gets it. */
const withPeriod = (s) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);

/**
 * Apply a map of rewrites to a built spec.
 *
 * `rewrites` is keyed "<orgKey>.<bulletKey>" — the same provenance key buildSpec
 * stamps onto every bullet — so a rewrite can never land on a bullet other than
 * the one it was written for, and a key matching nothing is REPORTED rather than
 * silently ignored. That was the failure mode worth designing out: a tailored
 * resume that quietly shipped untailored reads like a success.
 *
 * A rewrite that fails its check is refused and the original sentence stays.
 * Refusing one bullet must never cost the whole resume.
 */
export function applyRewrites(spec, rewrites = {}, { vocab, strict = false } = {}) {
  const applied = [];
  const refused = [];
  const notices = [];
  const seen = new Set();

  const experience = (spec.experience || []).map((entry) => ({
    ...entry,
    bullets: (entry.bullets || []).map((b) => {
      const key = b.provenanceKey;
      if (!key || !(key in rewrites)) return b;
      seen.add(key);
      // A missing final period is not worth refusing a rewrite over; it is added.
      const text = withPeriod(String(rewrites[key] || '').trim());
      if (!text || text === b.text) return b;
      // His sentence, kept. Reported as refused so the audit shows what was
      // proposed and why it did not ship, rather than swallowing it.
      if (LOCKED.has(key)) { refused.push({ key, text, problems: [`${key}: ships in his own words — not the tailor's to reword`] }); return b; }
      const res = checkRewrite({ text, source: b.source ?? b.text, vocab, label: key });
      // Notices describe what the rewrite that SHIPPED did. Reporting them for a
      // refused one is a lie in his favour's opposite direction: the run above
      // said "dropped the figure 3" about a sentence that was thrown away, while
      // the sentence actually on the resume still carried the 3.
      if (!res.ok) { refused.push({ key, text, problems: res.problems }); return b; }
      notices.push(...res.notices);
      applied.push({ key, from: b.text, to: text });
      return { ...b, text };
    }),
  }));

  const unmatched = Object.keys(rewrites).filter((k) => !seen.has(k));
  // A locked bullet is a decision, not a failure — it never stops a build,
  // even under strict.
  const failures = refused.filter((r) => !LOCKED.has(r.key));
  if (strict && failures.length) {
    throw new Error(`tailoring refused ${failures.length} rewrite(s):\n${failures.flatMap((r) => r.problems).join('\n')}`);
  }
  return { spec: { ...spec, experience }, applied, refused, unmatched, notices };
}
